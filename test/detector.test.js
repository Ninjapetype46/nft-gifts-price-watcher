import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, floorReferences, secondCheapest } from '../src/detector.js';
import { formatAlert, htmlToText } from '../src/format.js';

const NOW = Date.UTC(2026, 9, 28);
const DAY = 86_400_000;
const C1 = '0:' + '11'.repeat(32);
const C2 = '0:' + '22'.repeat(32);

const L = (nft, priceTon, collection = C1, attrs = {}) => ({
  nft,
  collection,
  name: nft,
  attrs,
  priceNano: String(Math.round(priceTon * 1e9)),
  priceTon,
  saleContract: null,
  saleVersion: null,
  contractType: 'sale-contract',
  seller: null,
  market: 'getgems',
  source: 'mock',
});

const params = (over = {}) => ({
  cheapMaxPriceTon: 0,
  cheapBelowFloorPct: 15,
  undervaluedDiscountPct: 25,
  valuation: { now: NOW, lookbackDays: 30, maxComparables: 20, minComparables: 3, timeWeighted: false, halfLifeDays: 7 },
  ...over,
});

test('floor reference is the cheapest *other* listing (2nd cheapest for the cheapest)', () => {
  const f = floorReferences([L('a', 5), L('b', 10), L('c', 12), L('x', 1, C2)]);
  assert.equal(f.get('a'), 10);
  assert.equal(f.get('b'), 5);
  assert.equal(f.get('x'), null); // alone in its collection
  assert.equal(secondCheapest([L('a', 5), L('b', 10), L('c', 12)]), 10);
  assert.equal(secondCheapest([L('a', 5)]), 5);
  assert.equal(secondCheapest([]), null);
});

test('below-floor alert for a bargain, none for normal listings', () => {
  const alerts = detect({ listings: [L('a', 8), L('b', 10), L('c', 10.5)], salesByCollection: {}, params: params() });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].listing.nft, 'a');
  assert.equal(alerts[0].reasons[0].kind, 'below_floor');
  assert.equal(alerts[0].floorRefTon, 10);
  assert.ok(Math.abs(alerts[0].belowFloorPct - 20) < 1e-9);
});

test('absolute price threshold', () => {
  const alerts = detect({ listings: [L('a', 3), L('b', 3.2)], salesByCollection: {}, params: params({ cheapMaxPriceTon: 3, cheapBelowFloorPct: 0 }) });
  assert.deepEqual(alerts.map((a) => a.listing.nft), ['a']);
  assert.equal(alerts[0].reasons[0].kind, 'absolute');
});

test('undervalued alert uses sales of the same collection only', () => {
  const sales = {
    [C1]: [10, 10, 10].map((p, i) => ({ nft: `s${i}`, collection: C1, priceTon: p, timeMs: NOW - DAY, txHash: `t${i}` })),
    [C2]: [100, 100, 100].map((p, i) => ({ nft: `z${i}`, collection: C2, priceTon: p, timeMs: NOW - DAY, txHash: `u${i}` })),
  };
  const listings = [L('a', 7, C1), L('b', 7.2, C1), L('x', 60, C2), L('y', 61, C2)];
  const alerts = detect({ listings, salesByCollection: sales, params: params({ cheapBelowFloorPct: 0 }) });
  const byNft = Object.fromEntries(alerts.map((a) => [a.listing.nft, a]));
  assert.ok(byNft.a && byNft.b && byNft.x && byNft.y);
  assert.ok(Math.abs(byNft.a.discountPct - 30) < 1e-9);
  assert.equal(byNft.a.valuation.fairValueTon, 10);
  assert.equal(byNft.x.valuation.fairValueTon, 100);
});

test('no undervalued alert when discount is below threshold or data is missing', () => {
  const sales = new Map([[C1, [{ nft: 's', collection: C1, priceTon: 10, timeMs: NOW - DAY, txHash: 't' }]]]);
  const alerts = detect({ listings: [L('a', 5), L('b', 5.1)], salesByCollection: sales, params: params({ cheapBelowFloorPct: 0 }) });
  assert.equal(alerts.length, 0); // one sale < minComparables -> no fair value
});

test('alert formatting mentions reasons, fallback and the Getgems link', () => {
  const listing = { ...L('0:' + 'ab'.repeat(32), 5, C1, { model: 'Neon', backdrop: 'Blue', symbol: 'Moon' }), name: 'Pepe <#1>' };
  const alert = {
    listing,
    reasons: [{ kind: 'undervalued', text: '50.0% below fair value 10 TON' }],
    floorRefTon: 6,
    belowFloorPct: 16.7,
    valuation: { fairValueTon: 10, label: 'Backdrop "Blue"', comparables: 4, minTon: 8, maxTon: 12, fallback: true, note: 'Model "Neon": 1 sale(s) < 3 → used Backdrop "Blue" (4)' },
    discountPct: 50,
  };
  const html = formatAlert(alert, { collectionName: 'Plush Pepes' });
  assert.match(html, /Pepe &lt;#1&gt;/);
  assert.match(html, /Fallback: Model "Neon"/);
  assert.match(html, /href="https:\/\/getgems\.io\/collection\/EQ/);
  assert.match(htmlToText(html), /Model: Neon · Backdrop: Blue · Symbol: Moon/);
});
