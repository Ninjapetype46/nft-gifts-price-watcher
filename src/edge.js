// Pure "real profit" math for an alert: all-in cost, net resale value after marketplace fee and
// royalty, break-even resale, liquidity (how fast similar items sell) and whether an existing
// bid already covers an instant exit. No I/O; `now` is a parameter.
//
// Money language: every number here is "net": fees, royalty and network costs included.
// Fee percentages default to config (MARKET_FEE_PCT_FALLBACK, ROYALTY_PCT_FALLBACK) and are
// replaced by what the listings' own sale contracts say when that data is present.
// TODO(verify): Getgems marketplaceFee / royaltyAmount units (assumed nanoTON like fullPrice).

import { median } from './valuation.js';
import { normalizeTrait } from './models.js';
import { sameAddress } from './address.js';

const DAY = 86_400_000;

/**
 * @typedef {Object} EdgeConfig
 * @property {number} networkCostTon      gas actually consumed by a buy
 * @property {number} sellCostTon         gas to list/sell later
 * @property {number} marketFeePctFallback percent
 * @property {number} royaltyPctFallback   percent
 * @property {number} bidCoverMinEdgeTon
 * @property {number} liqFastDays
 * @property {number} liqSlowDays
 * @property {number} liqIlliquidDays
 */

/**
 * @typedef {{marketFeePct:number, royaltyPct:number, source:'listings'|'config'}} Fees  fractions (0.05 = 5%)
 */

/**
 * Median fee/price and royalty/price over listings that expose them. Ratios outside [0, 0.3]
 * are ignored as bad data. Falls back to config with source 'config'.
 * @param {import('./models.js').Listing[]} listings
 * @param {EdgeConfig} cfg
 * @returns {Fees}
 */
export function feeModel(listings, cfg) {
  const fee = [];
  const roy = [];
  for (const l of listings || []) {
    const price = Number(l.priceNano);
    if (!(price > 0)) continue;
    if (l.marketplaceFeeNano !== null && l.marketplaceFeeNano !== undefined) {
      const r = Number(l.marketplaceFeeNano) / price;
      if (r >= 0 && r <= 0.3) fee.push(r);
    }
    if (l.royaltyNano !== null && l.royaltyNano !== undefined) {
      const r = Number(l.royaltyNano) / price;
      if (r >= 0 && r <= 0.3) roy.push(r);
    }
  }
  const fbFee = cfg.marketFeePctFallback / 100;
  const fbRoy = cfg.royaltyPctFallback / 100;
  if (!fee.length && !roy.length) return { marketFeePct: fbFee, royaltyPct: fbRoy, source: 'config' };
  return { marketFeePct: fee.length ? median(fee) : fbFee, royaltyPct: roy.length ? median(roy) : fbRoy, source: 'listings' };
}

/** What a buy really costs: price + the network fee actually consumed (the gas buffer comes back). */
export function allInCost(listing, cfg) {
  return listing.priceTon + cfg.networkCostTon;
}

/** What you keep if you resell at `refTon`: minus marketplace fee, royalty and selling gas. */
export function exitNet(refTon, fees, cfg) {
  return refTon * (1 - fees.marketFeePct - fees.royaltyPct) - cfg.sellCostTon;
}

/** Resale price at which exitNet() equals the all-in cost. */
export function breakEven(allInTon, fees, cfg) {
  const keep = 1 - fees.marketFeePct - fees.royaltyPct;
  return keep > 0 ? (allInTon + cfg.sellCostTon) / keep : Infinity;
}

/**
 * Liquidity of the finest applicable bucket for the target (Model for gifts), even when the
 * valuation fell back to a coarser level.
 * @param {{sales: import('./models.js').Sale[], listings: import('./models.js').Listing[], target: {nft?:string, attrs?:Record<string,string>}, fairTon: number|null, now: number, cfg: EdgeConfig}} a
 */
export function liquidity({ sales, listings, target, fairTon, now, cfg }) {
  const model = target?.attrs?.model;
  const inBucket = (attrs) => !model || String(attrs?.model ?? '').toLowerCase() === String(model).toLowerCase();
  const bucket = model ? `Model "${model}"` : 'whole collection';
  let sales7 = 0;
  let sales30 = 0;
  for (const s of sales || []) {
    if (!inBucket(s.attrs) || s.timeMs > now) continue;
    if (s.timeMs >= now - 7 * DAY) sales7++;
    if (s.timeMs >= now - 30 * DAY) sales30++;
  }
  const rate = 0.5 * (sales7 / 7) + 0.5 * (sales30 / 30);
  const depth =
    fairTon === null || fairTon === undefined
      ? 0
      : (listings || []).filter((l) => l.nft !== target?.nft && inBucket(l.attrs) && l.priceTon <= fairTon).length;
  const etaDays = rate > 0 ? (depth + 1) / rate : Infinity;
  const badge =
    etaDays <= cfg.liqFastDays ? 'fast' : etaDays <= cfg.liqSlowDays ? 'normal' : etaDays <= cfg.liqIlliquidDays ? 'slow' : 'illiquid';
  return { bucket, sales7, sales30, rate, depth, etaDays, badge };
}

/** finishAt is documented as an int64 "Timestamp": treat values > 1e12 as ms, else seconds. TODO(verify) */
export function finishAtMs(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? n : n * 1000;
}

/**
 * @typedef {Object} Offer   normalized Getgems Offer
 * @property {number} netTon            profitPrice: what the seller receives after fees and royalty
 * @property {number} [fullTon]
 * @property {string} [currency]
 * @property {string|null} [offerAddress]
 * @property {number|null} [finishAt]
 * @property {boolean} isCollectionOffer
 * @property {string} [nft]             target NFT of a non-collection offer (required to cover a listing)
 * @property {boolean} isOffchain
 * @property {number|null} [maxQuantity]
 * @property {number|null} [purchasedQuantity]
 * @property {{trait:string, values:string[]}[]} [attributes]
 */

/** True when every attribute filter of a collection offer matches the listing's traits. */
export function offerMatchesAttrs(offer, attrs) {
  for (const f of offer.attributes || []) {
    const trait = String(f.trait ?? '').trim().toLowerCase();
    const have = attrs?.[trait] ?? Object.entries(attrs || {}).find(([k]) => k.toLowerCase() === trait)?.[1];
    if (have === undefined) return false;
    const want = (f.values || []).map(normalizeTrait);
    if (want.length && !want.includes(normalizeTrait(have))) return false;
  }
  return true;
}

/**
 * Best open bid that would buy this listing's item right now (an "instant exit").
 * The bot never accepts bids: this only informs the card.
 * @param {{nft?:string, attrs?:Record<string,string>, contractType?:string|null}} listing
 * @param {Offer[]} offers
 * @param {number} now
 * @returns {{bestNetTon:number, offerAddress:string|null, finishAt:number|null, isCollectionOffer:boolean}|null}
 */
export function bidCover(listing, offers, now) {
  let best = null;
  const offchain = listing.contractType === 'offchain';
  for (const o of offers || []) {
    if (o.currency && o.currency !== 'TON') continue;
    if (!(o.netTon > 0)) continue;
    const fin = finishAtMs(o.finishAt);
    if (fin !== null && fin <= now) continue;
    const maxQ = o.maxQuantity;
    const doneQ = o.purchasedQuantity;
    if (maxQ !== null && maxQ !== undefined && doneQ !== null && doneQ !== undefined && maxQ - doneQ <= 0) continue;
    if (!!o.isOffchain !== offchain) continue;
    if (o.isCollectionOffer && !offerMatchesAttrs(o, listing.attrs)) continue;
    // An offer for one NFT covers only that NFT.
    if (!o.isCollectionOffer && !(o.nft && listing.nft && sameAddress(o.nft, listing.nft))) continue;
    if (!best || o.netTon > best.bestNetTon) {
      best = { bestNetTon: o.netTon, offerAddress: o.offerAddress ?? null, finishAt: fin, isCollectionOffer: !!o.isCollectionOffer };
    }
  }
  return best;
}

/**
 * Net numbers for the alert card.
 * @param {Object} a
 * @param {import('./models.js').Listing} a.listing
 * @param {import('./valuation.js').Valuation|null} a.valuation
 * @param {number|null} [a.floorRefTon]
 * @param {Fees} a.fees
 * @param {ReturnType<typeof liquidity>|null} [a.liquidity]
 * @param {ReturnType<typeof bidCover>} [a.bid]
 * @param {boolean} [a.bidsAvailable]
 * @param {EdgeConfig} a.cfg
 */
export function computeEdge({ listing, valuation, floorRefTon = null, fees, liquidity: liq = null, bid = null, bidsAvailable = true, cfg }) {
  const allInTon = allInCost(listing, cfg);
  const fair = valuation?.fairValueTon ?? null;
  const refTon = fair ?? floorRefTon ?? null;
  const refKind = fair !== null ? 'fair' : refTon !== null ? 'floor' : null;
  const exitNetTon = refTon !== null ? exitNet(refTon, fees, cfg) : null;
  const edgeTon = exitNetTon !== null ? exitNetTon - allInTon : null;
  const edgePct = edgeTon !== null ? (edgeTon / allInTon) * 100 : null;
  const b = bid ? { netTon: bid.bestNetTon, edgeTon: bid.bestNetTon - allInTon, expiresAt: bid.finishAt, offerAddress: bid.offerAddress, isCollectionOffer: bid.isCollectionOffer } : null;
  return {
    allInTon,
    refTon,
    refKind,
    exitNetTon,
    edgeTon,
    edgePct,
    breakEvenTon: breakEven(allInTon, fees, cfg),
    fees,
    liquidity: liq,
    bid: b,
    bidsAvailable,
    exitBacked: !!b && b.edgeTon >= cfg.bidCoverMinEdgeTon,
  };
}
