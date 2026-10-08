// Pure detection: turns listings + sales into alerts. No I/O.
//
// 1) "cheap": price <= absolute threshold, or X% below the floor reference.
//    Floor reference for a listing = cheapest *other* listing of the same collection,
//    i.e. the 2nd-cheapest for the cheapest one, so a bargain never defines its own floor.
// 2) "undervalued": price is >= N% below the fair value from comparable sales (valuation.js).

import { estimateFairValue, discountPct, cleanWindow } from './valuation.js';
import { fmtTon } from './models.js';

/**
 * @typedef {Object} DetectParams
 * @property {number} cheapMaxPriceTon         0 = off
 * @property {number} cheapBelowFloorPct       0 = off
 * @property {number} undervaluedDiscountPct   0 = off
 * @property {import('./valuation.js').ValuationParams} valuation
 */

/**
 * @typedef {Object} Alert
 * @property {import('./models.js').Listing} listing
 * @property {{kind:'absolute'|'below_floor'|'undervalued', code:string, text:string, p?:object}[]} reasons  code = suite reason code
 * @property {number|null} floorRefTon
 * @property {number|null} belowFloorPct
 * @property {import('./valuation.js').Valuation|null} valuation
 * @property {number|null} discountPct          vs fair value
 */

/**
 * Map nft -> floor reference (min price among the *other* listings of the same collection).
 * @param {import('./models.js').Listing[]} listings
 * @returns {Map<string, number|null>}
 */
export function floorReferences(listings) {
  /** @type {Map<string, import('./models.js').Listing[]>} */
  const byColl = new Map();
  for (const l of listings) {
    if (!byColl.has(l.collection)) byColl.set(l.collection, []);
    byColl.get(l.collection).push(l);
  }
  const out = new Map();
  for (const group of byColl.values()) {
    const sorted = [...group].sort((a, b) => a.priceTon - b.priceTon);
    for (const l of group) {
      const other = sorted.find((x) => x.nft !== l.nft);
      out.set(l.nft, other ? other.priceTon : null);
    }
  }
  return out;
}

/** Floor reference used for /status and stats: the 2nd-cheapest listing price. */
export function secondCheapest(listings) {
  const prices = listings.map((l) => l.priceTon).sort((a, b) => a - b);
  return prices.length >= 2 ? prices[1] : (prices[0] ?? null);
}

/**
 * @param {Object} args
 * @param {import('./models.js').Listing[]} args.listings
 * @param {Map<string, import('./models.js').Sale[]>|Record<string, import('./models.js').Sale[]>} args.salesByCollection
 * @param {DetectParams} args.params
 * @param {Record<string, ReturnType<typeof cleanWindow>>} [args.cleanByCollection] pre-computed clean comps
 * @returns {Alert[]}
 */
export function detect({ listings, salesByCollection, params, cleanByCollection = {} }) {
  const salesOf = (c) =>
    (salesByCollection instanceof Map ? salesByCollection.get(c) : salesByCollection?.[c]) || [];
  const cleanOf = (c) => (cleanByCollection[c] ||= cleanWindow(salesOf(c), params.valuation));
  const floors = floorReferences(listings);
  /** @type {Alert[]} */
  const alerts = [];

  for (const l of listings) {
    if (!(l.priceTon > 0)) continue;
    /** @type {Alert['reasons']} */
    const reasons = [];

    if (params.cheapMaxPriceTon > 0 && l.priceTon <= params.cheapMaxPriceTon) {
      reasons.push({
        kind: 'absolute',
        code: 'UNDER_PRICE_CAP',
        p: { price: fmtTon(l.priceTon), cap: fmtTon(params.cheapMaxPriceTon) },
        text: `price ${fmtTon(l.priceTon)} ≤ ${fmtTon(params.cheapMaxPriceTon)} TON`,
      });
    }

    const floorRef = floors.get(l.nft) ?? null;
    const belowFloorPct = floorRef ? ((floorRef - l.priceTon) / floorRef) * 100 : null;
    if (params.cheapBelowFloorPct > 0 && belowFloorPct !== null && belowFloorPct >= params.cheapBelowFloorPct) {
      reasons.push({
        kind: 'below_floor',
        code: 'BELOW_FLOOR',
        p: { pct: belowFloorPct.toFixed(1), floor: fmtTon(floorRef) },
        text: `${belowFloorPct.toFixed(1)}% below floor (next listing ${fmtTon(floorRef)} TON)`,
      });
    }

    let valuation = null;
    let disc = null;
    const sales = salesOf(l.collection);
    if (params.undervaluedDiscountPct > 0 && sales.length) {
      valuation = estimateFairValue(l, sales, params.valuation, { clean: cleanOf(l.collection) });
      disc = discountPct(l.priceTon, valuation.fairValueTon);
      if (disc !== null && disc >= params.undervaluedDiscountPct) {
        const basis = `${valuation.label}, ${valuation.comparables} sales, conf ${valuation.confidence}`;
        reasons.push({
          kind: 'undervalued',
          code: 'BELOW_FAIR',
          p: { pct: disc.toFixed(1), fair: fmtTon(valuation.fairValueTon), basis },
          text: `${disc.toFixed(1)}% below fair value ${fmtTon(valuation.fairValueTon)} TON (${basis})`,
        });
      }
    }

    if (reasons.length) {
      alerts.push({ listing: l, reasons, floorRefTon: floorRef, belowFloorPct, valuation, discountPct: disc });
    }
  }
  return alerts;
}
