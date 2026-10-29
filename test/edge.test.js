import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feeModel, allInCost, exitNet, breakEven, liquidity, bidCover, computeEdge, finishAtMs, offerMatchesAttrs } from '../src/edge.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig({ env: {} });
const NOW = Date.UTC(2026, 9, 28, 12);
const DAY = 86_400_000;
const nano = (ton) => String(Math.round(ton * 1e9));
const L = (priceTon, extra = {}) => ({ nft: `n${priceTon}`, collection: 'c', priceTon, priceNano: nano(priceTon), attrs: { model: 'Bronze', backdrop: 'Onyx Black', symbol: 'Star' }, contractType: 'sale-contract', ...extra });
const fees10 = { marketFeePct: 0.05, royaltyPct: 0.05, source: 'config' };

test('feeModel: median ratios from listings; out-of-range ratios fall back to config', () => {
  const ls = [L(10, { marketplaceFeeNano: nano(0.5), royaltyNano: nano(0.7) }), L(20, { marketplaceFeeNano: nano(1), royaltyNano: nano(1.4) }), L(30, { marketplaceFeeNano: nano(1.5), royaltyNano: nano(2.1) })];
  const f = feeModel(ls, cfg);
  assert.equal(f.source, 'listings');
  assert.ok(Math.abs(f.marketFeePct - 0.05) < 1e-9);
  assert.ok(Math.abs(f.royaltyPct - 0.07) < 1e-9);
  const bad = feeModel([L(10, { marketplaceFeeNano: nano(9), royaltyNano: nano(5) })], cfg); // 90% and 50%: nonsense
  assert.deepEqual(bad, { marketFeePct: 0.05, royaltyPct: 0.05, source: 'config' });
  assert.equal(feeModel([], cfg).source, 'config');
});

test('allIn, exitNet and break-even arithmetic', () => {
  assert.ok(Math.abs(allInCost(L(4), cfg) - 4.1) < 1e-9);
  assert.ok(Math.abs(exitNet(8, fees10, cfg) - 7.1) < 1e-9);
  const be = breakEven(4.1, fees10, cfg);
  assert.ok(Math.abs(exitNet(be, fees10, cfg) - 4.1) < 1e-9); // break-even inversion
  assert.equal(exitNet(10, { marketFeePct: 0, royaltyPct: 0 }, { sellCostTon: 0 }), 10); // fee 0
  assert.equal(breakEven(5, { marketFeePct: 1, royaltyPct: 0 }, cfg), Infinity); // fee 100%
});

test('liquidity: rate, depth, eta and all four badges; rate 0 is illiquid', () => {
  const sale = (daysAgo, model = 'Bronze') => ({ priceTon: 8, timeMs: NOW - daysAgo * DAY, attrs: { model } });
  const sales = [sale(1), sale(2), sale(3), sale(5), sale(10), sale(20), sale(25), sale(1, 'Gold')];
  const deep = liquidity({ sales, listings: [L(4), L(7, { nft: 'other' }), L(9, { nft: 'pricey' })], target: L(4), fairTon: 8, now: NOW, cfg });
  assert.equal(deep.sales7, 4);
  assert.equal(deep.sales30, 7);
  assert.ok(Math.abs(deep.rate - (0.5 * 4 / 7 + 0.5 * 7 / 30)) < 1e-12);
  assert.equal(deep.depth, 1); // only the 7 TON listing is at or below fair
  assert.ok(Math.abs(deep.etaDays - 2 / deep.rate) < 1e-9);
  assert.equal(deep.badge, 'normal');
  const at = (ds) => liquidity({ sales: ds.map((d) => sale(d)), listings: [], target: L(4), fairTon: 8, now: NOW, cfg });
  assert.equal(liquidity({ sales, listings: [], target: L(4), fairTon: 8, now: NOW, cfg }).badge, 'fast'); // eta ~2.5d
  assert.equal(at([1, 20]).badge, 'normal'); // eta ~9.5d
  assert.equal(at([10, 20]).badge, 'slow'); // rate 1/30 -> eta 30d
  assert.equal(at([10]).badge, 'illiquid'); // rate 1/60 -> eta 60d
  const none = liquidity({ sales: [], listings: [], target: L(4), fairTon: 8, now: NOW, cfg });
  assert.equal(none.etaDays, Infinity);
  assert.equal(none.badge, 'illiquid');
});

const base = { netTon: 6.5, currency: 'TON', isCollectionOffer: true, isOffchain: false, maxQuantity: 3, purchasedQuantity: 1, attributes: [{ trait: 'MODEL', values: ['bronze (1.2%)'] }] };

test('bidCover: finishAt in seconds or ms, expired offers ignored', () => {
  const listing = L(4);
  assert.equal(bidCover(listing, [{ ...base, finishAt: Math.floor((NOW + DAY) / 1000) }], NOW).bestNetTon, 6.5);
  assert.equal(bidCover(listing, [{ ...base, finishAt: NOW + DAY }], NOW).finishAt, NOW + DAY);
  assert.equal(bidCover(listing, [{ ...base, finishAt: Math.floor((NOW - 1000) / 1000) }], NOW), null);
  assert.equal(finishAtMs(1793200000), 1793200000000);
  assert.equal(finishAtMs(null), null);
});

test('bidCover: an exhausted offer quantity is ignored, best of the rest wins', () => {
  const listing = L(4);
  assert.equal(bidCover(listing, [{ ...base, maxQuantity: 2, purchasedQuantity: 2 }], NOW), null);
  assert.equal(bidCover(listing, [base, { ...base, netTon: 7.2 }], NOW).bestNetTon, 7.2);
  assert.equal(bidCover(listing, [{ ...base, currency: 'USDT' }], NOW), null);
});

test('bidCover: collection-offer attributes match case-insensitively with rarity suffixes stripped', () => {
  const listing = L(4);
  assert.equal(bidCover(listing, [base], NOW).bestNetTon, 6.5);
  assert.equal(bidCover(listing, [{ ...base, attributes: [{ trait: 'Model', values: ['Gold'] }] }], NOW), null);
  assert.equal(bidCover(listing, [{ ...base, attributes: [{ trait: 'Model', values: ['Bronze'] }, { trait: 'Backdrop', values: ['Ruby Red'] }] }], NOW), null);
  assert.ok(offerMatchesAttrs({ attributes: [{ trait: 'backdrop', values: ['Onyx Black (1.5%)'] }] }, { backdrop: 'onyx black' }));
});

test('bidCover: isOffchain must equal contractType == offchain', () => {
  assert.equal(bidCover(L(4), [{ ...base, isOffchain: true }], NOW), null);
  assert.equal(bidCover(L(4, { contractType: 'offchain' }), [{ ...base, isOffchain: true }], NOW).bestNetTon, 6.5);
  assert.equal(bidCover(L(4, { contractType: 'offchain' }), [base], NOW), null);
});

test('computeEdge: net numbers, floor fallback and exitBacked threshold', () => {
  const v = { fairValueTon: 8 };
  const bid = { bestNetTon: 6.5, offerAddress: 'x', finishAt: NOW + DAY, isCollectionOffer: true };
  const e = computeEdge({ listing: L(4), valuation: v, fees: fees10, bid, cfg });
  assert.ok(Math.abs(e.allInTon - 4.1) < 1e-9);
  assert.ok(Math.abs(e.edgeTon - 3.0) < 1e-9);
  assert.equal(Math.round(e.edgePct), 73);
  assert.ok(Math.abs(e.bid.edgeTon - 2.4) < 1e-9);
  assert.equal(e.exitBacked, true);
  assert.equal(computeEdge({ listing: L(4), valuation: v, fees: fees10, bid: { ...bid, bestNetTon: 4.3 }, cfg }).exitBacked, false); // +0.2 < 0.3
  const floor = computeEdge({ listing: L(2.95), valuation: null, floorRefTon: 3.6, fees: fees10, cfg });
  assert.equal(floor.refKind, 'floor');
  const none = computeEdge({ listing: L(2.95), valuation: { fairValueTon: null }, fees: fees10, cfg });
  assert.equal(none.edgeTon, null);
});

test('bidCover: an offer for one NFT only covers that NFT', () => {
  const nft = '0:' + 'ab'.repeat(32);
  const other = '0:' + 'cd'.repeat(32);
  const offer = { ...base, isCollectionOffer: false, attributes: [], netTon: 50 };
  assert.equal(bidCover({ ...L(4), nft }, [offer], NOW), null); // no target NFT: never covers
  assert.equal(bidCover({ ...L(4), nft }, [{ ...offer, nft: other }], NOW), null);
  assert.equal(bidCover({ ...L(4), nft }, [{ ...offer, nft }], NOW).bestNetTon, 50);
});
