import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  median,
  weightedMedian,
  decayWeight,
  levelKey,
  estimateFairValue,
  discountPct,
  valuationTable,
  DAY_MS,
} from '../src/valuation.js';

const NOW = Date.UTC(2026, 9, 28);
const P = { now: NOW, lookbackDays: 30, maxComparables: 20, minComparables: 3, timeWeighted: false, halfLifeDays: 7 };

let n = 0;
const sale = (priceTon, daysAgo, attrs = {}) => ({
  nft: `0:${String(++n).padStart(64, '0')}`,
  collection: 'c',
  priceTon,
  timeMs: NOW - daysAgo * DAY_MS,
  txHash: `h${n}`,
  attrs,
});
const gift = (model, backdrop = 'Black', symbol = 'Star') => ({ model, backdrop, symbol });

test('median handles odd, even, empty', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test('weightedMedian equals median for equal weights', () => {
  for (const v of [[1], [1, 2], [5, 1, 3], [10, 2, 8, 4], [1, 1, 2, 9, 9]]) {
    assert.equal(weightedMedian(v, v.map(() => 1)), median(v), JSON.stringify(v));
  }
});

test('weightedMedian follows the heavy side', () => {
  assert.equal(weightedMedian([10, 20, 30], [1, 1, 10]), 30);
  assert.equal(weightedMedian([10, 20, 30], [10, 1, 1]), 10);
  assert.throws(() => weightedMedian([1, 2], [1]));
});

test('decayWeight halves every half-life', () => {
  assert.equal(decayWeight(0, 7), 1);
  assert.ok(Math.abs(decayWeight(7 * DAY_MS, 7) - 0.5) < 1e-12);
  assert.ok(Math.abs(decayWeight(14 * DAY_MS, 7) - 0.25) < 1e-12);
});

test('levelKey: applicable, combined, missing trait', () => {
  assert.deepEqual(levelKey('collection', {}).traits, {});
  assert.deepEqual(levelKey('model', { model: 'Gold' }).traits, { model: 'Gold' });
  assert.equal(levelKey('model', { model: 'Gold' }).label, 'Model "Gold"');
  assert.deepEqual(levelKey('model+backdrop', { model: 'Gold', backdrop: 'Red' }).traits, { model: 'Gold', backdrop: 'Red' });
  assert.equal(levelKey('model', { type: 'Ape' }), null);
});

test('uses same-model comparables when there are enough', () => {
  const sales = [sale(40, 1, gift('Gold')), sale(42, 2, gift('Gold')), sale(38, 3, gift('Gold')), sale(8, 1, gift('Bronze'))];
  const v = estimateFairValue({ attrs: gift('Gold') }, sales, P);
  assert.equal(v.level, 'model');
  assert.equal(v.fairValueTon, 40);
  assert.equal(v.comparables, 3);
  assert.equal(v.fallback, false);
  assert.equal(v.minTon, 38);
  assert.equal(v.maxTon, 42);
});

test('falls back to backdrop when the model has too few sales and says so', () => {
  const sales = [
    sale(30, 1, gift('Neon', 'Blue')),
    sale(10, 1, gift('Bronze', 'Blue')),
    sale(12, 2, gift('Silver', 'Blue')),
    sale(14, 3, gift('Gold', 'Blue')),
    sale(99, 1, gift('Gold', 'Red')),
  ];
  const v = estimateFairValue({ attrs: gift('Neon', 'Blue') }, sales, P);
  assert.equal(v.level, 'backdrop');
  assert.equal(v.fallback, true);
  assert.equal(v.comparables, 4);
  assert.equal(v.fairValueTon, 13); // median of 30,10,12,14
  assert.match(v.note, /Model "Neon": 1 sale < 3/);
  assert.match(v.note, /used Backdrop "Blue"/);
});

test('falls through to whole collection', () => {
  const sales = [sale(5, 1, gift('A', 'X', 'S1')), sale(6, 1, gift('B', 'Y', 'S2')), sale(7, 1, gift('C', 'Z', 'S3'))];
  const v = estimateFairValue({ attrs: gift('D', 'W', 'S4') }, sales, P);
  assert.equal(v.level, 'collection');
  assert.equal(v.fallback, true);
  assert.equal(v.fairValueTon, 6);
  assert.equal(v.tried.filter((t) => t.applicable).length, 4);
});

test('non-gift NFTs go straight to collection without a fallback flag', () => {
  const sales = [sale(3, 1, { type: 'Ape' }), sale(2, 2, { type: 'Alien' }), sale(4, 3, {})];
  const v = estimateFairValue({ attrs: { type: 'Ape' } }, sales, P);
  assert.equal(v.level, 'collection');
  assert.equal(v.fallback, false);
  assert.equal(v.fairValueTon, 3);
});

test('returns null fair value when even the collection lacks comparables', () => {
  const v = estimateFairValue({ attrs: gift('Gold') }, [sale(10, 1, gift('Gold'))], P);
  assert.equal(v.fairValueTon, null);
  assert.equal(v.level, null);
  assert.match(v.note, /not enough comparables/);
});

test('lookback window excludes old and future sales', () => {
  const sales = [sale(10, 1, gift('Gold')), sale(10, 2, gift('Gold')), sale(10, 3, gift('Gold')), sale(1000, 31, gift('Gold')), sale(1000, -1, gift('Gold'))];
  const v = estimateFairValue({ attrs: gift('Gold') }, sales, P);
  assert.equal(v.comparables, 3);
  assert.equal(v.fairValueTon, 10);
});

test('uses only the N most recent comparables', () => {
  const sales = [sale(10, 1, gift('Gold')), sale(11, 2, gift('Gold')), sale(12, 3, gift('Gold')), sale(100, 10, gift('Gold')), sale(100, 11, gift('Gold'))];
  const v = estimateFairValue({ attrs: gift('Gold') }, sales, { ...P, maxComparables: 3 });
  assert.equal(v.comparables, 3);
  assert.equal(v.fairValueTon, 11);
});

test('time weighting favours recent sales', () => {
  // Old cheap sales outnumber recent expensive ones.
  const sales = [sale(50, 0.1, gift('Gold')), sale(50, 0.2, gift('Gold')), sale(10, 20, gift('Gold')), sale(10, 21, gift('Gold')), sale(10, 22, gift('Gold'))];
  const plain = estimateFairValue({ attrs: gift('Gold') }, sales, P);
  const weighted = estimateFairValue({ attrs: gift('Gold') }, sales, { ...P, timeWeighted: true, halfLifeDays: 3 });
  assert.equal(plain.fairValueTon, 10);
  assert.equal(weighted.fairValueTon, 50);
});

test('attribute matching is case-insensitive', () => {
  const sales = [sale(10, 1, gift('gold')), sale(10, 2, gift('GOLD')), sale(10, 3, gift('Gold'))];
  assert.equal(estimateFairValue({ attrs: gift('Gold') }, sales, P).level, 'model');
});

test('custom level order with combined traits', () => {
  const sales = [
    sale(20, 1, gift('Gold', 'Red')),
    sale(22, 2, gift('Gold', 'Red')),
    sale(24, 3, gift('Gold', 'Red')),
    sale(5, 1, gift('Gold', 'Blue')),
  ];
  const v = estimateFairValue({ attrs: gift('Gold', 'Red') }, sales, { ...P, levels: ['model+backdrop', 'model', 'collection'] });
  assert.equal(v.level, 'model+backdrop');
  assert.equal(v.fairValueTon, 22);
});

test('discountPct and valuationTable ordering', () => {
  assert.equal(discountPct(50, 100), 50);
  assert.equal(discountPct(120, 100), -20);
  assert.equal(discountPct(10, null), null);
  const sales = [sale(10, 1), sale(10, 2), sale(10, 3)];
  const rows = valuationTable(
    [
      { name: 'a', priceTon: 9, attrs: {} },
      { name: 'b', priceTon: 5, attrs: {} },
      { name: 'c', priceTon: 12, attrs: {} },
    ],
    sales,
    P,
  );
  assert.deepEqual(rows.map((r) => r.listing.name), ['b', 'a', 'c']);
});

// ---- Honest price: clean comps, MAD outliers, spread, confidence -------------------------------
import { cleanComps, spread, percentile, confidenceGrade, dropOutliers, ignoredCount } from '../src/valuation.js';

const A = '0:' + 'aa'.repeat(32);
const B = '0:' + 'bb'.repeat(32);
const C = '0:' + 'cc'.repeat(32);
const owned = (nft, priceTon, daysAgo, oldOwner, newOwner, extra = {}) => ({
  nft,
  collection: 'c',
  priceTon,
  timeMs: NOW - daysAgo * DAY_MS,
  txHash: `o${++n}`,
  attrs: gift('Gold'),
  oldOwner,
  newOwner,
  ...extra,
});

test('cleanComps: A→B→A within 30d is a round trip (both excluded); A→B then B→C is kept', () => {
  const rt = cleanComps([owned('x', 10, 5, A, B), owned('x', 11, 3, B, A)], { roundTripDays: 30, pairMinRepeats: 99 });
  assert.equal(rt.kept.length, 0);
  assert.deepEqual(rt.excluded.map((e) => e.reason), ['round_trip', 'round_trip']);
  const chain = cleanComps([owned('x', 10, 5, A, B), owned('x', 11, 3, B, C)], { roundTripDays: 30, pairMinRepeats: 99 });
  assert.equal(chain.kept.length, 2);
});

test('cleanComps: a round trip older than WASH_ROUNDTRIP_DAYS is kept', () => {
  const r = cleanComps([owned('x', 10, 40, A, B), owned('x', 11, 1, B, A)], { roundTripDays: 30, pairMinRepeats: 99 });
  assert.equal(r.kept.length, 2);
});

test('cleanComps: repeated wallet pair on different NFTs, rejectTop, null owners', () => {
  const pair = cleanComps([owned('x', 10, 5, A, B), owned('y', 12, 4, B, A), owned('z', 9, 2, A, C)], { roundTripDays: 30, pairMinRepeats: 2 });
  assert.deepEqual(pair.excluded.map((e) => [e.sale.nft, e.reason]), [['x', 'same_wallet_pair'], ['y', 'same_wallet_pair']]);
  assert.deepEqual(pair.kept.map((s) => s.nft), ['z']);
  const flagged = cleanComps([owned('x', 60, 1, A, B, { rejectTop: true }), owned('y', 10, 1, A, C)], {});
  assert.equal(flagged.excluded[0].reason, 'flagged_by_getgems');
  // Unknown owners (old cached rows) are never treated as wash.
  const legacy = cleanComps([owned('x', 10, 5, null, null), owned('x', 11, 3, null, null), owned('y', 10, 2, A, null), owned('z', 10, 1, A, null)], { pairMinRepeats: 2 });
  assert.equal(legacy.kept.length, 4);
});

test('MAD outlier filter only runs for n >= 5 and can be disabled', () => {
  const four = [10, 10, 11, 50].map((p) => ({ priceTon: p }));
  assert.equal(dropOutliers(four, 3).outliers.length, 0);
  const six = [10, 10, 11, 9, 10, 50].map((p) => ({ priceTon: p }));
  assert.deepEqual(dropOutliers(six, 3).outliers.map((x) => x.priceTon), [50]);
  assert.equal(dropOutliers(six, 0).outliers.length, 0);
  const sales = [10, 10, 11, 9, 10, 50].map((p, i) => sale(p, i + 1, gift('Gold')));
  const v = estimateFairValue({ attrs: gift('Gold') }, sales, { ...P, madK: 3 });
  assert.equal(v.excluded.outlier, 1);
  assert.equal(v.maxTon, 11);
  assert.equal(v.excludedSamples[0].reason, 'outlier');
});

test('spread: IQR/median for n >= 4, range/median below', () => {
  assert.ok(Math.abs(spread([10, 12]) - 2 / 11) < 1e-12);
  assert.ok(Math.abs(spread([8, 10, 12]) - 0.4) < 1e-12);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.ok(Math.abs(spread([10, 10, 10, 14]) - (percentile([10, 10, 10, 14], 0.75) - 10) / 10) < 1e-12);
  assert.equal(spread([]), null);
});

test('confidence grade table', () => {
  const cfg = { confAMinComps: 8, confAMaxSpread: 0.25, confBMaxSpread: 0.5, minComparables: 3 };
  assert.equal(confidenceGrade({ level: 'model', isGift: true, n: 8, spread: 0.1, cfg }), 'A');
  assert.equal(confidenceGrade({ level: 'model+backdrop', isGift: true, n: 9, spread: 0.2, cfg }), 'A');
  assert.equal(confidenceGrade({ level: 'model', isGift: true, n: 5, spread: 0.1, cfg }), 'B');
  assert.equal(confidenceGrade({ level: 'backdrop', isGift: true, n: 20, spread: 0.05, cfg }), 'B'); // fallback capped at B
  assert.equal(confidenceGrade({ level: 'symbol', isGift: true, n: 20, spread: 0.9, cfg }), 'C');
  assert.equal(confidenceGrade({ level: 'collection', isGift: true, n: 20, spread: 0.05, cfg }), 'C'); // gift on whole collection
  assert.equal(confidenceGrade({ level: 'collection', isGift: false, n: 12, spread: 0.1, cfg }), 'A'); // non-gift can be A
  assert.equal(confidenceGrade({ level: 'model', isGift: true, n: 2, spread: 0, cfg }), 'C');
});

test('estimateFairValue adds confidence, receipt and ignored counts; C when no level qualifies', () => {
  const sales = [
    ...[8, 8.2, 7.9, 8.1, 8, 7.8, 8.3, 8].map((p, i) => owned(`ok${i}`, p, i + 1, `0:${String(i).padStart(64, '1')}`, `0:${String(i).padStart(64, '2')}`)),
    owned('w', 14, 2, A, B),
    owned('w', 14.5, 1, B, A),
  ];
  const v = estimateFairValue({ attrs: gift('Gold') }, sales, { ...P, timeWeighted: false });
  assert.equal(v.confidence, 'A');
  assert.equal(v.fairValueTon, 8);
  assert.equal(v.excluded.round_trip, 2);
  assert.equal(ignoredCount(v), 2);
  assert.equal(v.used.length, 8);
  assert.deepEqual(Object.keys(v.used[0]).sort(), ['attrs', 'name', 'nft', 'priceTon', 'timeMs']);
  assert.ok(v.p25Ton <= v.fairValueTon && v.fairValueTon <= v.p75Ton);
  const none = estimateFairValue({ attrs: gift('Gold') }, [sale(10, 1, gift('Gold'))], P);
  assert.equal(none.confidence, 'C');
  const off = estimateFairValue({ attrs: gift('Gold') }, sales, { ...P, timeWeighted: false, washFilter: false, madK: 0 });
  assert.equal(off.comparables, 10);
  assert.equal(off.excluded.round_trip, 0);
});

test('sampled (TonAPI) history: a fallback valuation is one confidence grade lower', () => {
  // Model "Neon" has 1 clean sale (< MIN_COMPARABLES 3): the price falls back to Backdrop "Blue".
  const sales = [
    sale(13, 1, gift('Neon', 'Blue')),
    sale(12, 1, gift('Bronze', 'Blue')),
    sale(12.5, 2, gift('Silver', 'Blue')),
    sale(13, 3, gift('Gold', 'Blue')),
    sale(12.8, 4, gift('Gold', 'Blue')),
  ];
  const full = estimateFairValue({ attrs: gift('Neon', 'Blue') }, sales, P);
  assert.equal(full.confidence, 'B');
  assert.equal(full.sampleLowered, false);
  const sampled = estimateFairValue({ attrs: gift('Neon', 'Blue') }, sales, { ...P, sampled: true });
  assert.equal(sampled.fairValueTon, full.fairValueTon);
  assert.equal(sampled.confidence, 'C');
  assert.equal(sampled.sampleLowered, true);
  assert.match(sampled.note, /small TonAPI sample: confidence B→C/);
  // Enough same-model sales: no downgrade, even when sampled.
  const gold = [12, 12.2, 12.4].map((p, i) => sale(p, i + 1, gift('Gold', 'Red')));
  const v = estimateFairValue({ attrs: gift('Gold', 'Red') }, gold, { ...P, sampled: true });
  assert.equal(v.fallback, false);
  assert.equal(v.sampleLowered, false);
  assert.equal(v.confidence, 'B');
});
