// Pure fair-value estimation from comparable sales. No I/O, no clock: `now` is a parameter.
//
// Levels are tried from fine to coarse. For Telegram gifts the default order is
//   model -> backdrop -> symbol -> collection
// A level is "applicable" when the target NFT has that trait (non-gift NFTs usually only
// get the collection level). The first applicable level with >= minComparables sales in the
// lookback window wins; if a finer applicable level had too few sales we record a fallback
// note so the alert can say so. Combined levels like "model+backdrop" are supported.
//
// "Honest price": before any level is picked, cleanComps() removes sales that are not real
// market prices (Getgems-flagged sales, round trips back to the previous owner, wallet pairs
// trading with each other). After a level is picked, robust outliers (median ± k·1.4826·MAD)
// are dropped. Every estimate carries a confidence grade (A/B/C) and a receipt of the sales
// it used and ignored.

import { looksLikeGift, plural } from './models.js';

export const DAY_MS = 86_400_000;
export const DEFAULT_LEVELS = ['model', 'backdrop', 'symbol', 'collection'];

/**
 * @typedef {Object} ValuationParams
 * @property {number} now               epoch ms
 * @property {number} lookbackDays
 * @property {number} maxComparables     use at most the N most recent comparables
 * @property {number} minComparables
 * @property {boolean} [sampled]  sales are a TonAPI sample: a fallback valuation is one grade lower
 * @property {boolean} timeWeighted      weighted median with exponential decay
 * @property {number} halfLifeDays
 * @property {string[]} [levels]
 * @property {boolean} [washFilter]      default true
 * @property {number} [roundTripDays]    default 30
 * @property {number} [pairMinRepeats]   default 2
 * @property {number} [madK]             default 3, 0 disables the outlier filter
 * @property {number} [confAMinComps]    default 8
 * @property {number} [confAMaxSpread]   default 0.25
 * @property {number} [confBMaxSpread]   default 0.5
 */

/**
 * @typedef {Object} LevelTry
 * @property {string} level
 * @property {string} label            human readable, e.g. `Model "Gold"`
 * @property {number} count
 * @property {boolean} applicable
 */

/**
 * @typedef {{nft:string, name?:string, priceTon:number, timeMs:number, attrs?:Record<string,string>}} UsedComp
 * @typedef {{nft:string, priceTon:number, timeMs:number, reason:string}} ExcludedSample
 */

/**
 * @typedef {Object} Valuation
 * @property {number|null} fairValueTon
 * @property {string|null} level
 * @property {string|null} label
 * @property {number} comparables
 * @property {boolean} fallback          a finer applicable level had too few comparables
 * @property {string} note               explanation for alerts
 * @property {LevelTry[]} tried
 * @property {number|null} minTon
 * @property {number|null} maxTon
 * @property {'A'|'B'|'C'} confidence
 * @property {number|null} spread        IQR/median (n>=4) or range/median
 * @property {number|null} p25Ton
 * @property {number|null} p75Ton
 * @property {UsedComp[]} used           up to 12 comps the price is based on
 * @property {Record<string, number>} excluded  counts per reason
 * @property {ExcludedSample[]} excludedSamples up to 6
 * @property {number} lookbackDays
 * @property {boolean} isGift
 */

export function median(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Linear-interpolated percentile (q in [0,1]) of a list of numbers. */
export function percentile(values, q) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const idx = (v.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

/** Price dispersion: IQR/median for n>=4, otherwise (max-min)/median. */
export function spread(prices) {
  if (!prices.length) return null;
  const med = median(prices);
  if (!med) return null;
  if (prices.length >= 4) return (percentile(prices, 0.75) - percentile(prices, 0.25)) / med;
  return (Math.max(...prices) - Math.min(...prices)) / med;
}

/**
 * Weighted median. With equal weights it equals `median()` (even counts average the two middles).
 * @param {number[]} values
 * @param {number[]} weights
 */
export function weightedMedian(values, weights) {
  if (!values.length) return null;
  if (values.length !== weights.length) throw new Error('values/weights length mismatch');
  const pairs = values.map((v, i) => [v, Math.max(0, weights[i])]).sort((a, b) => a[0] - b[0]);
  const total = pairs.reduce((s, p) => s + p[1], 0);
  if (total <= 0) return median(values);
  const half = total / 2;
  const eps = total * 1e-12;
  let cum = 0;
  for (let i = 0; i < pairs.length; i++) {
    cum += pairs[i][1];
    if (Math.abs(cum - half) <= eps && i + 1 < pairs.length) return (pairs[i][0] + pairs[i + 1][0]) / 2;
    if (cum > half) return pairs[i][0];
  }
  return pairs[pairs.length - 1][0];
}

/** Exponential decay weight: 1 for a sale right now, 0.5 after one half-life. */
export function decayWeight(ageMs, halfLifeDays) {
  const age = Math.max(0, ageMs) / DAY_MS;
  return Math.pow(0.5, age / halfLifeDays);
}

const TRAIT_TITLES = { model: 'Model', backdrop: 'Backdrop', symbol: 'Symbol' };
const title = (t) => TRAIT_TITLES[t] || t.charAt(0).toUpperCase() + t.slice(1);

/**
 * Resolve a level spec ("model", "model+backdrop", "collection") against the target's attributes.
 * @returns {{traits: Record<string,string>, label: string} | null} null when not applicable
 */
export function levelKey(level, attrs = {}) {
  if (level === 'collection') return { traits: {}, label: 'whole collection' };
  const traits = {};
  for (const t of level.split('+').map((s) => s.trim().toLowerCase())) {
    const v = attrs?.[t];
    if (v === undefined || v === null || v === '') return null;
    traits[t] = v;
  }
  const label = Object.entries(traits)
    .map(([t, v]) => `${title(t)} "${v}"`)
    .join(' + ');
  return { traits, label };
}

export function matchesTraits(saleAttrs, traits) {
  for (const [t, v] of Object.entries(traits)) {
    if (!saleAttrs || String(saleAttrs[t] ?? '').toLowerCase() !== String(v).toLowerCase()) return false;
  }
  return true;
}

const owner = (a) => (a ? String(a).toLowerCase() : null);

/**
 * Remove sales that are not real market prices. Runs on the whole collection window, before
 * level selection. Reasons are checked in this order and each sale gets the first that applies:
 *  - flagged_by_getgems: Getgems marked the sale rejectFromGlobalTop;
 *  - round_trip: the same NFT was later sold back to a previous seller within roundTripDays
 *    (both sales are excluded);
 *  - same_wallet_pair: the unordered {seller, buyer} pair traded >= pairMinRepeats times in the
 *    window, on any NFT (all of those sales are excluded).
 * The owner rules skip any sale with an unknown (null) owner, so old cached rows are never wash.
 * @param {import('./models.js').Sale[]} sales
 * @param {{now?:number, roundTripDays?:number, pairMinRepeats?:number, madK?:number}} [opts]
 * @returns {{kept: import('./models.js').Sale[], excluded: {sale: import('./models.js').Sale, reason: string}[]}}
 */
export function cleanComps(sales, { roundTripDays = 30, pairMinRepeats = 2 } = {}) {
  /** @type {Map<import('./models.js').Sale, string>} */
  const reason = new Map();
  const mark = (s, r) => {
    if (!reason.has(s)) reason.set(s, r);
  };
  const known = (s) => owner(s.oldOwner) && owner(s.newOwner);

  for (const s of sales) if (s.rejectTop) mark(s, 'flagged_by_getgems');

  /** @type {Map<string, import('./models.js').Sale[]>} */
  const byNft = new Map();
  for (const s of sales) {
    if (!known(s)) continue;
    if (!byNft.has(s.nft)) byNft.set(s.nft, []);
    byNft.get(s.nft).push(s);
  }
  const rtMs = roundTripDays * DAY_MS;
  const roundTrip = new Set();
  for (const list of byNft.values()) {
    list.sort((a, b) => a.timeMs - b.timeMs);
    for (let j = 1; j < list.length; j++) {
      for (let i = 0; i < j; i++) {
        if (owner(list[j].newOwner) === owner(list[i].oldOwner) && list[j].timeMs - list[i].timeMs <= rtMs) {
          roundTrip.add(list[i]);
          roundTrip.add(list[j]);
        }
      }
    }
  }
  // Keep the input order stable when assigning reasons.
  for (const s of sales) if (roundTrip.has(s)) mark(s, 'round_trip');

  const pairKey = (s) => [owner(s.oldOwner), owner(s.newOwner)].sort().join('|');
  const pairs = new Map();
  for (const s of sales) {
    if (!known(s)) continue;
    const k = pairKey(s);
    pairs.set(k, (pairs.get(k) || 0) + 1);
  }
  for (const s of sales) {
    if (known(s) && pairs.get(pairKey(s)) >= pairMinRepeats) mark(s, 'same_wallet_pair');
  }

  const kept = [];
  const excluded = [];
  for (const s of sales) {
    if (reason.has(s)) excluded.push({ sale: s, reason: reason.get(s) });
    else kept.push(s);
  }
  return { kept, excluded };
}

/**
 * Drop prices outside median ± madK·1.4826·MAD (only for n >= 5; madK = 0 disables).
 * @template {{priceTon:number}} T
 * @param {T[]} comps
 * @returns {{kept: T[], outliers: T[]}}
 */
export function dropOutliers(comps, madK) {
  if (!(madK > 0) || comps.length < 5) return { kept: comps, outliers: [] };
  const prices = comps.map((c) => c.priceTon);
  const med = median(prices);
  const mad = median(prices.map((p) => Math.abs(p - med)));
  if (!(mad > 0)) return { kept: comps, outliers: [] };
  const lim = madK * 1.4826 * mad;
  const kept = [];
  const outliers = [];
  for (const c of comps) (Math.abs(c.priceTon - med) <= lim ? kept : outliers).push(c);
  return { kept, outliers };
}

/**
 * Confidence grade of a price estimate.
 *  A: model-level comps (or a non-gift NFT valued on its whole collection), n >= confAMinComps,
 *     spread <= confAMaxSpread.
 *  B: n >= minComparables, spread <= confBMaxSpread, and not a gift valued on its whole collection.
 *  C: everything else. Backdrop-only and symbol-only fallback levels can reach B at most.
 */
export function confidenceGrade({ level, isGift, n, spread: sp, cfg = {} }) {
  const aMin = cfg.confAMinComps ?? 8;
  const aSpread = cfg.confAMaxSpread ?? 0.25;
  const bSpread = cfg.confBMaxSpread ?? 0.5;
  const minN = cfg.minComparables ?? 3;
  if (!level || sp === null || sp === undefined) return 'C';
  const modelLevel = level.split('+').includes('model') || (!isGift && level === 'collection');
  if (modelLevel && n >= aMin && sp <= aSpread) return 'A';
  if (n >= minN && sp <= bSpread && !(isGift && level === 'collection')) return 'B';
  return 'C';
}

/** One grade lower: A -> B -> C (C stays C). */
export function lowerGrade(g) {
  return g === 'A' ? 'B' : 'C';
}

/** Comparable sales window: positive price, inside [now - lookback, now]. */
export function salesWindow(sales, p) {
  const since = p.now - p.lookbackDays * DAY_MS;
  return sales.filter((s) => s.priceTon > 0 && s.timeMs >= since && s.timeMs <= p.now);
}

/** cleanComps() with the ValuationParams switches (WASH_FILTER=false keeps everything). */
export function cleanWindow(sales, p) {
  const window = salesWindow(sales, p);
  if (p.washFilter === false) return { kept: window, excluded: [] };
  return cleanComps(window, { roundTripDays: p.roundTripDays ?? 30, pairMinRepeats: p.pairMinRepeats ?? 2 });
}

const usedOf = (s) => ({ nft: s.nft, name: s.name, priceTon: s.priceTon, timeMs: s.timeMs, attrs: s.attrs ? { ...s.attrs } : undefined });

/**
 * Estimate fair value of `target` from `sales` (same collection).
 * @param {{attrs?: Record<string,string>}} target
 * @param {import('./models.js').Sale[]} sales
 * @param {ValuationParams} p
 * @param {{clean?: ReturnType<typeof cleanComps>}} [pre]  pre-computed cleanWindow() of the same sales
 * @returns {Valuation}
 */
export function estimateFairValue(target, sales, p, pre = {}) {
  const levels = p.levels?.length ? p.levels : DEFAULT_LEVELS;
  const clean = pre.clean ?? cleanWindow(sales, p);
  const isGift = looksLikeGift(target.attrs);
  const madK = p.madK ?? 3;
  const sampleOf = (s, reason) => ({ nft: s.nft, priceTon: s.priceTon, timeMs: s.timeMs, reason });
  // "Ignored" counts only the wash/flagged sales of the level the price uses (e.g. other Bronze
  // sales for a Bronze price), not the whole collection's: those are the sales left out of it.
  const excludedAt = (traits) => {
    const list = clean.excluded.filter((e) => matchesTraits(e.sale.attrs, traits));
    const counts = { round_trip: 0, same_wallet_pair: 0, flagged_by_getgems: 0, outlier: 0 };
    for (const e of list) counts[e.reason] = (counts[e.reason] || 0) + 1;
    const samples = list.sort((a, b) => b.sale.timeMs - a.sale.timeMs).map((e) => sampleOf(e.sale, e.reason));
    return { counts, samples };
  };

  /** @type {LevelTry[]} */
  const tried = [];
  for (const level of levels) {
    const key = levelKey(level, target.attrs);
    if (!key) {
      tried.push({ level, label: title(level), count: 0, applicable: false });
      continue;
    }
    const comps = clean.kept
      .filter((s) => matchesTraits(s.attrs, key.traits))
      .sort((a, b) => b.timeMs - a.timeMs)
      .slice(0, p.maxComparables);
    const { kept: used, outliers } = comps.length >= p.minComparables ? dropOutliers(comps, madK) : { kept: comps, outliers: [] };
    tried.push({ level, label: key.label, count: used.length, applicable: true });
    if (used.length < p.minComparables) continue;

    const prices = used.map((s) => s.priceTon);
    const fair = p.timeWeighted
      ? weightedMedian(prices, used.map((s) => decayWeight(p.now - s.timeMs, p.halfLifeDays)))
      : median(prices);
    const skipped = tried.filter((t) => t.applicable && t.level !== level);
    const fallback = skipped.length > 0;
    const note = fallback
      ? `${skipped.map((t) => `${t.label}: ${plural(t.count, 'sale')} < ${p.minComparables}`).join('; ')} → used ${key.label}`
      : `${key.label}: ${plural(used.length, 'sale')}`;
    const sp = spread(prices);
    const grade = confidenceGrade({ level, isGift, n: used.length, spread: sp, cfg: p });
    // Sampled history (free TonAPI source): when the item's own level had fewer than
    // MIN_COMPARABLES clean sales, the sample is too small to trust the fallback fully.
    const sampleLowered = !!p.sampled && fallback && grade !== 'C';
    const confidence = sampleLowered ? lowerGrade(grade) : grade;
    const washed = excludedAt(key.traits);
    return {
      fairValueTon: fair,
      level,
      label: key.label,
      comparables: used.length,
      fallback,
      note: sampleLowered ? `${note} · small TonAPI sample: confidence ${grade}→${confidence}` : note,
      sampleLowered,
      tried,
      minTon: Math.min(...prices),
      maxTon: Math.max(...prices),
      confidence,
      spread: sp,
      p25Ton: percentile(prices, 0.25),
      p75Ton: percentile(prices, 0.75),
      used: used.slice(0, 12).map(usedOf),
      excluded: { ...washed.counts, outlier: outliers.length },
      excludedSamples: [...outliers.map((s) => sampleOf(s, 'outlier')), ...washed.samples].slice(0, 6),
      lookbackDays: p.lookbackDays,
      isGift,
    };
  }
  const applicable = tried.filter((t) => t.applicable);
  // No price: report the wash/flagged sales of the item's own (finest) level.
  const own = levels.map((l) => levelKey(l, target.attrs)).find(Boolean);
  const washed = excludedAt(own ? own.traits : {});
  return {
    fairValueTon: null,
    level: null,
    label: null,
    comparables: 0,
    fallback: true,
    note: `not enough comparables in ${p.lookbackDays}d (${applicable.map((t) => `${t.label}: ${t.count}`).join('; ') || 'none'})`,
    tried,
    minTon: null,
    maxTon: null,
    confidence: 'C',
    spread: null,
    p25Ton: null,
    p75Ton: null,
    used: [],
    excluded: washed.counts,
    excludedSamples: washed.samples.slice(0, 6),
    lookbackDays: p.lookbackDays,
    isGift,
  };
}

/** Total ignored sales of a valuation (wash + flagged + outliers). */
export function ignoredCount(v) {
  return Object.values(v?.excluded || {}).reduce((s, n) => s + n, 0);
}

/** Discount of `priceTon` vs `fairTon` in percent (positive = cheaper than fair). */
export function discountPct(priceTon, fairTon) {
  if (!fairTon || fairTon <= 0) return null;
  return ((fairTon - priceTon) / fairTon) * 100;
}

/**
 * Rows for the `valuate` CLI command, sorted by discount (best first).
 * @param {import('./models.js').Listing[]} listings
 * @param {import('./models.js').Sale[]} sales
 * @param {ValuationParams} p
 */
export function valuationTable(listings, sales, p) {
  const clean = cleanWindow(sales, p);
  return listings
    .map((l) => {
      const v = estimateFairValue(l, sales, p, { clean });
      return { listing: l, valuation: v, discountPct: discountPct(l.priceTon, v.fairValueTon) };
    })
    .sort((a, b) => (b.discountPct ?? -Infinity) - (a.discountPct ?? -Infinity));
}
