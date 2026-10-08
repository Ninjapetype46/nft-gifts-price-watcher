import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { mapGiftToCollection, normalizeTrait, valuePortfolio, sellerGuard, offerAlerts, movers } from '../src/portfolio.js';
import { TelegramGiftsSource, mapOwnedGift } from '../src/holdings.js';
import { mockProfileGifts } from '../src/clients/mock.js';
import { openStorage } from '../src/storage.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig({ env: {} });
const NOW = Date.UTC(2026, 9, 28, 12);
const DAY = 86_400_000;
const COLL = '0:' + 'a1'.repeat(32);
const P = { now: NOW, lookbackDays: 30, maxComparables: 20, minComparables: 3, timeWeighted: false, halfLifeDays: 7 };
const gifts = [{ address: COLL, name: 'Plush Pepes' }, { address: '0:' + '11'.repeat(32), name: "Durov's Caps" }];

test('mapGiftToCollection handles plural, case and punctuation', () => {
  assert.equal(mapGiftToCollection('Plush Pepe', gifts)?.address, COLL);
  assert.equal(mapGiftToCollection('plush-pepes', gifts)?.address, COLL);
  assert.equal(mapGiftToCollection("Durov's Cap", gifts)?.name, "Durov's Caps");
  assert.equal(mapGiftToCollection('Mystery Box', gifts), null);
});

test('normalizeTrait strips rarity suffixes', () => {
  assert.equal(normalizeTrait('Gold (1.2%)'), 'gold');
  assert.equal(normalizeTrait('Onyx Black 15‰'), 'onyx black');
  assert.equal(normalizeTrait(' Navy Blue '), 'navy blue');
});

const sale = (model, price, d, backdrop = 'Onyx Black') => ({ nft: `s${model}${price}${d}`, collection: COLL, priceTon: price, timeMs: NOW - d * DAY, txHash: `${model}${price}${d}`, attrs: { model, backdrop, symbol: 'Star' } });
const SALES = [
  ...[41, 39, 42, 38, 40].map((p, i) => sale('Gold', p, i + 1)),
  ...[15, 14, 16].map((p, i) => sale('Silver', p, i + 1, 'Navy Blue')),
  sale('Neon', 30, 12, 'Navy Blue'),
  sale('Bronze', 8, 2, 'Navy Blue'),
  sale('Gold', 40, 3, 'Navy Blue'),
  sale('Gold', 39, 4, 'Navy Blue'),
];
const item = (title, model, extra = {}) => ({ collection: COLL, title, number: 1, attrs: { model, backdrop: model === 'Neon' ? 'Navy Blue' : 'Onyx Black', symbol: 'Star' }, ...extra });

test('valuePortfolio: totals, C range, unmatched and burned', () => {
  const r = valuePortfolio({
    items: [item('Gold #77', 'Gold'), item('Neon #5', 'Neon'), { collection: null, title: 'Mystery Box', attrs: {} }, item('Burned #9', 'Gold', { burned: true })],
    salesByCollection: { [COLL]: SALES },
    params: P,
    cfg,
    now: NOW,
  });
  assert.equal(r.count, 3);
  assert.deepEqual(r.unmatched, ['Mystery Box']);
  assert.equal(r.skipped.burned, 1);
  const neon = r.items.find((i) => i.title === 'Neon #5');
  assert.equal(neon.confidence, 'C');
  assert.ok(neon.lowTon < neon.highTon);
  assert.equal(r.items.find((i) => i.title === 'Gold #77').fairTon, 40);
  assert.equal(r.items.find((i) => i.title === 'Gold #77').confidence, 'B');
  assert.ok(Math.abs(r.totalTon - (40 + neon.fairTon)) < 1e-9);
  assert.ok(r.totalLowTon < r.totalHighTon);
});

test('sellerGuard thresholds: underpriced needs confidence >= B; illiquid overpricing', () => {
  const vals = { a: { fairTon: 15, confidence: 'B' }, b: { fairTon: 15, confidence: 'C' }, c: { fairTon: 10, confidence: 'A', liquidity: { etaDays: 40 } }, d: { fairTon: 15, confidence: 'A' } };
  const g = sellerGuard([{ title: 'a', priceTon: 10 }, { title: 'b', priceTon: 10 }, { title: 'c', priceTon: 14 }, { title: 'd', priceTon: 13.5 }], vals, cfg);
  assert.deepEqual(g.map((x) => [x.title, x.kind]), [['a', 'underpriced'], ['c', 'overpriced']]);
  assert.equal(g[0].text, "Your listing a is 33% under similar sales; you'd leave ~5 TON on the table");
  assert.equal(g[1].text, 'c is listed 40% above fair; similar ones take ~40 days');
});

test('offerAlerts compare the bid with exitNet (after fees), not with fair', () => {
  const h = (bid) => ({ title: 'Gold', bestBidNetTon: bid, exitNetTon: 36.8, fairTon: 41, liquidity: { etaDays: 5 } });
  assert.equal(offerAlerts([h(39)], cfg).length, 1); // above exit net + 5%, though below fair 41
  assert.equal(offerAlerts([h(38)], cfg).length, 0); // 38 < 36.8 * 1.05
  assert.equal(offerAlerts([h(44)], cfg)[0].text, 'Someone bids 44.00 net for your Gold. Listing at fair would net ~36.8 after fees and ~5 days.');
});

test('movers versus the previous snapshot', () => {
  const m = movers({ items: [{ title: 'a', fairTon: 12 }, { title: 'b', fairTon: 10 }] }, [{ title: 'a', fairTon: 15 }, { title: 'b', fairTon: 10 }]);
  assert.deepEqual(m.map((x) => [x.title, Math.round(x.pct)]), [['a', -20]]);
});

test('TelegramGiftsSource pages getUserGifts by offset and keeps unique gifts only', async () => {
  const all = mockProfileGifts(NOW);
  const calls = [];
  const api = {
    getUserGifts: async (userId, o) => {
      calls.push({ userId, ...o });
      if (!o.offset) return { total_count: all.length + 1, gifts: [...all.slice(0, 4), { type: 'regular', gift: {} }], next_offset: 'p2' };
      return { total_count: all.length + 1, gifts: all.slice(4) };
    },
  };
  const items = await new TelegramGiftsSource(api).list(111);
  assert.equal(items.length, all.length);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].offset, 'p2');
  assert.equal(calls[0].exclude_unlimited, true);
  assert.equal(calls[0].exclude_limited_upgradable, true);
  assert.equal(calls[0].exclude_limited_non_upgradable, true);
  assert.equal(mapOwnedGift(all[0]).title, 'Mock Plush Pepe #77 (Gold)');
  assert.equal(items.filter((i) => i.burned).length, 1);
});

test('storage: portfolio snapshots are pruned to 30 per source; /forget clears both tables', async () => {
  const s = await openStorage(':memory:');
  for (let i = 0; i < 35; i++) s.addSnapshot(7, 'profile', i, [{ title: 'x', fairTon: i }], NOW + i);
  s.addSnapshot(7, 'wallet', 1, [], NOW);
  assert.equal(s.countSnapshots(7, 'profile'), 30);
  assert.equal(s.lastSnapshot(7, 'profile').totalTon, 34);
  s.addPortfolioAddress(7, '0:' + '1'.repeat(64));
  assert.deepEqual(s.forgetPortfolio(7), { addresses: 1, snapshots: 31 });
  assert.equal(s.countSnapshots(7, 'profile'), 0);
});

// ---- PortfolioService with the mock client --------------------------------------------------
import { PortfolioService, MockGiftsSource, AddressSource } from '../src/holdings.js';
import { MockClient, MOCK_WALLET_NAME } from '../src/clients/mock.js';
import { Settings } from '../src/settings.js';
import { Engine } from '../src/engine.js';
import { OfferBook } from '../src/offers.js';

async function service(env = {}) {
  const c = loadConfig({ env: { FLOORS_FILE: path.join(os.tmpdir(), `gg-portfolio-test-${process.pid}-floors.json`), ...env } });
  const storage = await openStorage(':memory:');
  const settings = new Settings(c, storage);
  const client = new MockClient();
  const engine = new Engine({ cfg: c, settings, storage, client, notifier: { text: async () => {}, alert: async () => {} }, buyer: null });
  const offers = new OfferBook({ client, cfg: c });
  const svc = new PortfolioService({ cfg: c, settings, storage, client, engine, offers, giftsSource: new MockGiftsSource(), addressSource: new AddressSource({ client }) });
  return { svc, storage, client, engine };
}

test('wallet portfolio: exactly one seller-guard and one offer alert, nothing secret stored', async () => {
  const { svc, storage } = await service();
  const r = await svc.address(MOCK_WALLET_NAME, 5);
  assert.equal(r.guard.length, 1);
  assert.equal(r.offers.length, 1);
  assert.match(r.guard[0].text, /Your listing Mock Pepe #501 \(Silver\) is 33% under similar sales; you'd leave ~5 TON on the table/);
  assert.match(r.offers[0].text, /Someone bids 44\.00 net for your Mock Pepe #502 \(Gold\)\. Listing at fair would net ~36\.8/);
  const snap = storage.getSnapshot(r.snapshotId);
  assert.deepEqual(Object.keys(snap.items[0]).sort(), ['collection', 'confidence', 'fairTon', 'nft', 'title']);
});

test('profile portfolio reuses the sales cache and caps refreshes at PORTFOLIO_MAX_COLLECTIONS', async () => {
  const { svc, client } = await service({ SALES_REFRESH_MIN: '30' });
  let salesCalls = 0;
  const orig = client.getSales.bind(client);
  client.getSales = async (...a) => (salesCalls++, orig(...a));
  const r1 = await svc.profile(9);
  assert.match(r1.text, /Your 6 collectible gifts: ~\d+ TON/);
  await svc.profile(9);
  assert.equal(salesCalls, 1); // the second request hits the cache (SALES_REFRESH_MIN)
  const capped = await service({ PORTFOLIO_MAX_COLLECTIONS: '1' });
  assert.equal((await capped.svc.profile(9)).collections.length, 1);
});
