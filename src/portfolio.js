// Pure "What are my gifts worth?" valuation. Gifts come from the owner's Telegram profile
// (Bot API getUserGifts) or a public wallet address (holdings.js does the I/O). Each gift is
// valued with the same cleaned comps as alerts, gets a confidence grade, a liquidity badge and
// the best open bid. Also: seller guard (your own listing is too cheap / too expensive) and
// "someone pays more" offer alerts. No I/O; `now` is a parameter.

import { estimateFairValue, cleanWindow } from './valuation.js';
import { liquidity, bidCover, exitNet } from './edge.js';
import { normalizeTrait, fmtTon } from './models.js';
import { escapeHtml } from './format.js';

export { normalizeTrait };

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Map a Telegram gift base name ("Plush Pepe") to a Getgems gift collection ("Plush Pepes").
 * Case and punctuation are ignored; a plural 's' is allowed either way.
 * @param {string} baseName
 * @param {{address:string, name:string}[]} giftCollections
 * @returns {{address:string, name:string}|null}
 */
export function mapGiftToCollection(baseName, giftCollections) {
  const q = norm(baseName);
  if (!q) return null;
  return (
    (giftCollections || []).find((g) => {
      const n = norm(g.name);
      return n === q || n === `${q}s` || `${n}s` === q;
    }) || null
  );
}

/**
 * @typedef {Object} Holding
 * @property {string|null} collection   raw address (null = unmatched)
 * @property {string} title
 * @property {number|null} number
 * @property {Record<string,string>} attrs  {model, backdrop, symbol}
 * @property {string|null} [nft]
 * @property {string|null} [contractType]
 * @property {boolean} [burned]
 * @property {import('./models.js').Listing|null} [ownListing]
 */

/**
 * @param {Object} a
 * @param {Holding[]} a.items
 * @param {Record<string, import('./models.js').Sale[]>} a.salesByCollection
 * @param {Record<string, import('./models.js').Listing[]>} [a.listingsByCollection]
 * @param {Record<string, import('./edge.js').Offer[]>} [a.offersByCollection]
 * @param {Record<string, import('./edge.js').Fees>} [a.feesByCollection]
 * @param {import('./valuation.js').ValuationParams} a.params
 * @param {object} a.cfg  edge config (fees fallback, liquidity days)
 * @param {number} a.now
 */
export function valuePortfolio({ items, salesByCollection, listingsByCollection = {}, offersByCollection = {}, feesByCollection = {}, params, cfg, now }) {
  const out = [];
  const unmatched = [];
  let burned = 0;
  const cleanCache = new Map();
  const defaultFees = { marketFeePct: cfg.marketFeePctFallback / 100, royaltyPct: cfg.royaltyPctFallback / 100, source: 'config' };
  for (const it of items) {
    if (it.burned) {
      burned++;
      continue;
    }
    if (!it.collection) {
      unmatched.push(it.title);
      continue;
    }
    const sales = salesByCollection[it.collection] || [];
    if (!cleanCache.has(it.collection)) cleanCache.set(it.collection, cleanWindow(sales, params));
    const clean = cleanCache.get(it.collection);
    const v = estimateFairValue({ attrs: it.attrs }, sales, params, { clean });
    const fair = v.fairValueTon;
    const conf = v.confidence;
    const lowTon = fair === null ? null : conf === 'C' ? (v.p25Ton ?? fair) : fair;
    const highTon = fair === null ? null : conf === 'C' ? (v.p75Ton ?? fair) : fair;
    const listings = listingsByCollection[it.collection] || [];
    const liq = liquidity({ sales: clean.kept, listings, target: { nft: it.nft, attrs: it.attrs }, fairTon: fair, now, cfg });
    const bid = bidCover({ nft: it.nft, attrs: it.attrs, contractType: it.contractType ?? null }, offersByCollection[it.collection] || [], now);
    const fees = feesByCollection[it.collection] || defaultFees;
    const flags = [];
    if (conf === 'C') flags.push('rough');
    if (it.ownListing) flags.push('listed');
    out.push({
      title: it.title,
      number: it.number ?? null,
      nft: it.nft ?? null,
      collection: it.collection,
      attrs: it.attrs,
      fairTon: fair,
      confidence: conf,
      lowTon,
      highTon,
      liquidity: liq,
      bestBidNetTon: bid?.bestNetTon ?? null,
      exitNetTon: fair === null ? null : exitNet(fair, fees, cfg),
      ownListing: it.ownListing ?? null,
      note: v.note,
      flags,
    });
  }
  const valued = out.filter((i) => i.fairTon !== null);
  return {
    count: out.length + unmatched.length,
    totalTon: valued.reduce((s, i) => s + i.fairTon, 0),
    totalLowTon: valued.reduce((s, i) => s + i.lowTon, 0),
    totalHighTon: valued.reduce((s, i) => s + i.highTon, 0),
    items: out.sort((a, b) => (b.fairTon ?? -1) - (a.fairTon ?? -1)),
    unmatched,
    skipped: { burned },
  };
}

const CONF_OK = { A: true, B: true, C: false };

/**
 * Seller guard for the owner's own listings.
 * @param {{title:string, priceTon:number}[]} ownListings  holdings with ownListing
 * @param {Map<string, {fairTon:number|null, confidence:string, liquidity?:{etaDays:number}}>|Record<string, any>} valuations by title
 * @param {{underpricePct:number, liqIlliquidDays:number}} cfg
 */
export function sellerGuard(ownListings, valuations, cfg) {
  const get = (t) => (valuations instanceof Map ? valuations.get(t) : valuations[t]);
  const out = [];
  for (const l of ownListings) {
    const v = get(l.title);
    if (!v || v.fairTon === null || v.fairTon === undefined) continue;
    const pct = ((v.fairTon - l.priceTon) / v.fairTon) * 100;
    if (l.priceTon < v.fairTon * (1 - cfg.underpricePct / 100) && CONF_OK[v.confidence]) {
      out.push({
        kind: 'underpriced',
        title: l.title,
        text: `Your listing ${escapeHtml(l.title)} is ${Math.round(pct)}% under similar sales; you'd leave ~${fmtTon(v.fairTon - l.priceTon, 0)} TON on the table`,
      });
    } else if (v.liquidity && v.liquidity.etaDays > cfg.liqIlliquidDays && l.priceTon > v.fairTon) {
      const above = Math.round(((l.priceTon - v.fairTon) / v.fairTon) * 100);
      const eta = Number.isFinite(v.liquidity.etaDays) ? `~${Math.round(v.liquidity.etaDays)} days` : 'a very long time';
      out.push({ kind: 'overpriced', title: l.title, text: `${escapeHtml(l.title)} is listed ${above}% above fair; similar ones take ${eta}` });
    }
  }
  return out;
}

/**
 * "Someone pays more": an open bid nets at least OFFER_ABOVE_EXIT_PCT more than listing at fair would.
 * @param {{title:string, bestBidNetTon:number|null, exitNetTon:number|null, liquidity?:{etaDays:number}}[]} holdings
 * @param {{offerAbovePct:number}} cfg
 */
export function offerAlerts(holdings, cfg) {
  const out = [];
  for (const h of holdings) {
    if (h.bestBidNetTon === null || h.bestBidNetTon === undefined || h.exitNetTon === null || h.exitNetTon === undefined) continue;
    if (h.bestBidNetTon >= h.exitNetTon * (1 + cfg.offerAbovePct / 100)) {
      const eta = h.liquidity && Number.isFinite(h.liquidity.etaDays) ? ` and ~${Math.max(1, Math.round(h.liquidity.etaDays))} days` : '';
      out.push({
        title: h.title,
        text: `Someone bids ${h.bestBidNetTon.toFixed(2)} net for your ${escapeHtml(h.title)}. Listing at fair would net ~${h.exitNetTon.toFixed(1)} after fees${eta}.`,
      });
    }
  }
  return out;
}

/** Biggest movers versus a previous snapshot (by nft or title). */
export function movers(current, previousItems, { limit = 2, minPct = 3 } = {}) {
  if (!previousItems?.length) return [];
  const prev = new Map(previousItems.map((i) => [i.nft || i.title, i]));
  const out = [];
  for (const i of current.items) {
    const p = prev.get(i.nft || i.title);
    if (!p || !(p.fairTon > 0) || i.fairTon === null) continue;
    const pct = ((i.fairTon - p.fairTon) / p.fairTon) * 100;
    if (Math.abs(pct) >= minPct) out.push({ title: i.title, from: p.fairTon, to: i.fairTon, pct });
  }
  return out.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, limit);
}

/** Items whose fair value dropped by at least `pct` versus the previous snapshot. */
export function drops(current, previousItems, pct) {
  return movers(current, previousItems, { limit: 100, minPct: 0 }).filter((m) => m.pct <= -pct);
}

const BADGE = { fast: '⚡ fast', normal: 'normal', slow: 'slow', illiquid: 'illiquid' };

/**
 * Card text (HTML with <b> only). Titles are HTML-escaped here; guard/offer texts arrive escaped.
 * @param {ReturnType<typeof valuePortfolio>} r
 */
export function formatPortfolio(r, { fiat = null, moversList = [], guard = [], offers = [], footer = 'Only gifts visible on your profile are counted.', currency = 'TON' } = {}) {
  const lines = [];
  const range = r.totalLowTon !== r.totalHighTon ? ` · range ${Math.round(r.totalLowTon)}-${Math.round(r.totalHighTon)}` : '';
  lines.push(`<b>Your ${r.count} collectible gifts: ~${Math.round(r.totalTon)} ${currency}${fiat ? ` (${fiat})` : ''}${range}</b>`);
  const top = r.items.filter((i) => i.fairTon !== null).slice(0, 3);
  top.forEach((i, n) => {
    const est = i.confidence === 'C' ? `${fmtTon(i.lowTon)}–${fmtTon(i.highTon)}` : fmtTon(i.fairTon);
    lines.push(`${n + 1}. ${escapeHtml(i.title)} — ${est} ${currency} · conf ${i.confidence} · ${BADGE[i.liquidity.badge] || i.liquidity.badge}`);
  });
  for (const i of r.items.filter((x) => !top.includes(x) && x.confidence === 'C' && x.fairTon !== null)) {
    lines.push(`• ${escapeHtml(i.title)}: conf C, rough range ${fmtTon(i.lowTon)}–${fmtTon(i.highTon)} ${currency}`);
  }
  // Every valued gift is listed somewhere, so the headline total adds up.
  const rest = r.items.filter((x) => x.fairTon !== null && !top.includes(x) && x.confidence !== 'C');
  if (rest.length) {
    const names = rest.slice(0, 5).map((x) => escapeHtml(x.title)).join(', ');
    const sum = rest.reduce((s, x) => s + x.fairTon, 0);
    lines.push(`…and ${rest.length} more (~${fmtTon(sum)} ${currency}): ${names}${rest.length > 5 ? ', …' : ''}`);
  }
  const noFair = r.items.filter((x) => x.fairTon === null);
  if (noFair.length) lines.push(`No recent sales to value: ${noFair.map((x) => escapeHtml(x.title)).join(', ')}`);
  if (moversList.length) {
    lines.push(`Movers since last check: ${moversList.map((m) => `${escapeHtml(m.title)} ${m.pct >= 0 ? '+' : ''}${m.pct.toFixed(0)}% (${fmtTon(m.from)} → ${fmtTon(m.to)})`).join(' · ')}`);
  }
  if (r.unmatched.length) lines.push(`Not on Getgems: ${r.unmatched.map(escapeHtml).join(', ')}`);
  if (r.skipped.burned) lines.push(`${r.skipped.burned} burned gift${r.skipped.burned > 1 ? 's' : ''} skipped`);
  for (const g of guard) lines.push(`🛡 ${g.text}`);
  for (const o of offers) lines.push(`💰 ${o.text}`);
  lines.push(`<i>${footer}</i>`);
  return lines.join('\n');
}
