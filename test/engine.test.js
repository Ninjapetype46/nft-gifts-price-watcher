import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockClient, MOCK_GIFT_COLLECTION, MOCK_PUNK_COLLECTION } from '../src/clients/mock.js';
import { openStorage } from '../src/storage.js';
import { Settings } from '../src/settings.js';
import { loadConfig } from '../src/config.js';
import { Buyer } from '../src/autobuy.js';
import { Engine } from '../src/engine.js';

// Engine cycles write floors.json: never the real ./data/floors.json that sibling bots read
// (fs/os/path are imported further down; imports are hoisted).
const TMP_FLOORS = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gg-engine-test-')), 'floors.json');

async function mockApp() {
  const cfg = loadConfig({ env: { FLOORS_FILE: TMP_FLOORS } });
  const storage = await openStorage(':memory:');
  const settings = new Settings(cfg, storage);
  settings.setFlag('autobuy', true);
  const client = new MockClient();
  const notes = { alerts: [], texts: [] };
  const notifier = { alert: async (a, id) => notes.alerts.push({ a, id }), text: async (t) => notes.texts.push(t) };
  const buyer = new Buyer({ cfg, settings, storage, client, notifier, walletFactory: async () => assert.fail('no wallet in dry run') });
  const engine = new Engine({ cfg, settings, storage, client, notifier, buyer });
  storage.watch(MOCK_GIFT_COLLECTION, { name: 'Mock Plush Pepes', isGift: true });
  storage.watch(MOCK_PUNK_COLLECTION, { name: 'Mock Punks' });
  storage.addRule({ collection: MOCK_GIFT_COLLECTION, maxPriceTon: 20, minDiscountPct: 40 });
  return { storage, settings, engine, notes };
}

test('mock pipeline: alerts, DRY buys, hourly limit, dedup on the next cycle', async () => {
  const { storage, engine, notes } = await mockApp();
  const c1 = await engine.cycle();
  assert.equal(c1.errors, 0);
  assert.ok(c1.alerts >= 3, `alerts: ${c1.alerts}`);
  const names = notes.alerts.map((x) => x.a.listing.name);
  assert.ok(names.includes('Mock Pepe #3')); // Gold @15 vs fair ~40
  const neon = notes.alerts.find((x) => x.a.listing.attrs.model === 'Neon');
  assert.equal(neon.a.valuation.level, 'backdrop');
  assert.equal(neon.a.valuation.fallback, true);

  const buys = storage.listBuys(50);
  assert.equal(buys.filter((b) => b.status === 'dry').length, 2);
  assert.ok(buys.some((b) => b.status === 'blocked' && /MAX_BUYS_PER_HOUR/.test(b.error)));
  assert.ok(notes.texts.some((t) => /PRACTICE · Paper buy:/.test(t)));

  const before = notes.alerts.length;
  const c2 = await engine.cycle();
  assert.equal(c2.alerts, 1); // only the listing that appears on cycle 2
  assert.equal(notes.alerts.length, before + 1);
  assert.ok(storage.getSales(MOCK_GIFT_COLLECTION, 0).every((s) => s.attrs && s.attrs.model));
});

test('paused engine does not scan', async () => {
  const { settings, engine, notes } = await mockApp();
  settings.setFlag('paused', true);
  const r = await engine.cycle();
  assert.equal(r.paused, true);
  assert.equal(notes.alerts.length, 0);
});

// ---- Honest price, profit card, lanes, offers budget, rates, paper outcomes -----------------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MOCK_FROG_COLLECTION, MOCK_FAKE_COLLECTION } from '../src/clients/mock.js';
import { TelegramNotifier } from '../src/notifier.js';
import { formatAlert, htmlToText } from '../src/format.js';
import { OfferBook } from '../src/offers.js';
import { Rates, FixedRates } from '../src/rates.js';
import { validateFloors } from '../src/peers.js';

async function app({ env = {}, watch = [MOCK_GIFT_COLLECTION], rules = [], notifier, rates = null, client = new MockClient() } = {}) {
  const cfg = loadConfig({ env: { SALES_REFRESH_MIN: '1', FLOORS_FILE: TMP_FLOORS, ...env } });
  const storage = await openStorage(':memory:');
  const settings = new Settings(cfg, storage);
  settings.setFlag('autobuy', true);
  const notes = { alerts: [], texts: [] };
  notifier ||= { alert: async (a, id, o) => notes.alerts.push({ a, id, o }), text: async (t) => notes.texts.push(t) };
  const buyer = new Buyer({ cfg, settings, storage, client, notifier, walletFactory: async () => assert.fail('no wallet') });
  const engine = new Engine({ cfg: { ...cfg, salesRefreshMin: 0 }, settings, storage, client, notifier, buyer, rates });
  const names = { [MOCK_GIFT_COLLECTION]: 'Mock Plush Pepes', [MOCK_PUNK_COLLECTION]: 'Mock Punks', [MOCK_FROG_COLLECTION]: 'Mock Frogs', [MOCK_FAKE_COLLECTION]: 'Mock Plush Pepes' };
  for (const c of watch) storage.watch(c, { name: names[c] });
  for (const r of rules) storage.addRule(r);
  return { cfg, storage, settings, engine, notes, client, buyer };
}
const byName = (notes, name) => notes.alerts.find((x) => x.a.listing.name === name);

test('honest price in the mock: Bronze conf A at 8.00 despite the wash loop; Neon conf C', async () => {
  const { engine, notes } = await app();
  await engine.cycle();
  const bronze = byName(notes, 'Mock Pepe #1').a;
  assert.equal(bronze.valuation.fairValueTon, 8);
  assert.equal(bronze.valuation.confidence, 'A');
  assert.equal(bronze.valuation.excluded.round_trip + bronze.valuation.excluded.same_wallet_pair, 7);
  const text = htmlToText(formatAlert(bronze, { collectionName: 'Mock Plush Pepes' }));
  // Only Bronze wash sales count as ignored for a Bronze price (6 round trips + 1 wallet pair).
  assert.match(text, /Fair 8\.00 TON · conf A · 8 sales of Model "Bronze" \(30d\) · 7 ignored/);
  const neon = byName(notes, 'Mock Pepe #2').a;
  assert.equal(neon.valuation.confidence, 'C');
  assert.match(htmlToText(formatAlert(neon)), /Thin or mixed data: rough estimate/);
  assert.equal(byName(notes, 'Mock Pepe #4'), undefined); // Bronze 8.5 is not a fake "undervalued"
  assert.equal(byName(notes, 'Mock Pepe #5'), undefined);
});

test('WASH_FILTER=false raises Bronze fair to >= 12 and turns 8.5/9.0 into fake alerts', async () => {
  const { engine, notes } = await app({ env: { WASH_FILTER: 'false' } });
  await engine.cycle();
  const bronze = byName(notes, 'Mock Pepe #1').a;
  assert.ok(bronze.valuation.fairValueTon >= 12, `fair ${bronze.valuation.fairValueTon}`);
  assert.ok(byName(notes, 'Mock Pepe #4')); // 8.5
  assert.ok(byName(notes, 'Mock Pepe #5')); // 9.0
});

test('profit card: all-in, net edge, instant exit and EXIT-BACKED on Bronze #1, not on Gold #3', async () => {
  const { engine, notes } = await app({ rates: new FixedRates({ usd: 1.25 }) });
  await engine.cycle();
  const bronze = htmlToText(formatAlert(byName(notes, 'Mock Pepe #1').a));
  assert.match(bronze, /Mock Pepe #1 — 4\.00 TON \(all-in 4\.10\) · ⚡ EXIT-BACKED/);
  assert.match(bronze, /you keep ~7\.10 after 5% fee \+ 5% royalty → \+3\.00 TON \(\+73%\)/);
  assert.match(bronze, /⚡ Instant exit: an open bid pays 6\.50 net now \(\+2\.40\) · expires in 2d/);
  assert.match(bronze, /Sells: fast/);
  assert.match(bronze, /≈ \$5\.13 \(rate \d\d:\d\d\)/);
  const gold = htmlToText(formatAlert(byName(notes, 'Mock Pepe #3').a));
  assert.ok(!/Instant exit|EXIT-BACKED/.test(gold));
  const neon = byName(notes, 'Mock Pepe #2');
  assert.match(htmlToText(formatAlert(neon.a)), /Sells: illiquid \(1 sale in 30d\)/);
  assert.equal(neon.o.silent, true); // illiquid undervalued alerts go to the silent lane
  for (const x of notes.alerts) assert.match(htmlToText(formatAlert(x.a)), /all-in [\d.]+\)[\s\S]*Risk: [🟢🟡🔴]/u);
});

test('a negative-edge alert is sent with disable_notification and the "Not a deal after fees" label', async () => {
  const sent = [];
  const api = { sendMessage: async (chat, text, extra) => (sent.push({ text, extra }), {}) };
  const { engine } = await app({ watch: [MOCK_FROG_COLLECTION], notifier: new TelegramNotifier(api, [1]) });
  await engine.cycle();
  const frog = sent.find((m) => /Mock Frog #200/.test(m.text));
  assert.ok(frog);
  assert.equal(frog.extra.disable_notification, true);
  assert.match(frog.text, /Not a deal after fees:<\/b> you would lose ~0\.4 TON/);
  const drop = await app({ watch: [MOCK_FROG_COLLECTION], env: { NEGATIVE_EDGE_ALERTS: 'drop' } });
  await drop.engine.cycle();
  assert.equal(drop.notes.alerts.length, 0);
  assert.ok(drop.storage.decisionsSince(0).some((d) => d.code === 'FEES_EAT_PROFIT'));
});

test('offers are fetched only for alerted listings and within OFFERS_MAX_CALLS_PER_CYCLE', async () => {
  const many = await app({ env: { OFFERS_MAX_CALLS_PER_CYCLE: '100' } });
  await many.engine.cycle();
  assert.equal(many.client.calls.nftOffers, many.notes.alerts.length); // one per alert, none for quiet listings
  assert.equal(many.client.calls.collectionOffers, 1); // cached per collection
  const capped = await app({ env: { OFFERS_MAX_CALLS_PER_CYCLE: '2' } });
  await capped.engine.cycle();
  assert.ok(capped.client.calls.nftOffers + capped.client.calls.collectionOffers <= 2);
  await capped.engine.cycle();
  assert.ok(capped.client.calls.nftOffers + capped.client.calls.collectionOffers <= 4);
});

test('rates failure omits the fiat line without throwing', async () => {
  const rates = new Rates({ baseUrl: 'https://x', currencies: ['usd'], ttlMin: 10, fetchImpl: async () => { throw new Error('offline'); } });
  const { engine, notes } = await app({ rates });
  const r = await engine.cycle();
  assert.equal(r.errors, 0);
  assert.ok(notes.alerts.length > 0);
  for (const x of notes.alerts) assert.ok(!/≈ \$/.test(htmlToText(formatAlert(x.a))));
  assert.equal(await new Rates({ baseUrl: 'https://x', currencies: [], ttlMin: 1 }).get(), null); // FIAT_CURRENCIES empty
});

test('TonAPI-like source: card says "Bids: n/a" and uses config fees', async () => {
  const client = new MockClient();
  client.supportsOffers = false;
  const orig = client.getListings.bind(client);
  client.getListings = async (c) => (await orig(c)).map((l) => ({ ...l, marketplaceFeeNano: null, royaltyNano: null }));
  const { engine, notes } = await app({ client });
  await engine.cycle();
  const a = byName(notes, 'Mock Pepe #1').a;
  assert.equal(a.edge.fees.source, 'config');
  assert.match(htmlToText(formatAlert(a)), /Bids: n\/a/);
  assert.equal(client.calls.collectionOffers + client.calls.nftOffers, 0);
});

test('paper outcomes: Bronze #1 sold 12s after it appeared is a lost race and frees the hourly slot', async () => {
  const { engine, storage } = await app({ rules: [{ collection: MOCK_GIFT_COLLECTION, maxPriceTon: 20, minDiscountPct: 40 }], env: { PAPER_MARK_EVERY_MIN: '0' } });
  await engine.cycle();
  await engine.cycle();
  const buys = storage.allBuys();
  const pepe1 = buys.find((b) => b.name === 'Mock Pepe #1');
  assert.equal(pepe1.outcome, 'lost_race');
  const silver = buys.find((b) => b.name === 'Mock Pepe #10');
  assert.match(silver.reasonCode, /^risk_warn:sale_type,seller_history/); // reached the risk check: the lost race freed the slot
  const gold = buys.find((b) => b.name === 'Mock Pepe #3');
  assert.ok(gold.markTon > gold.allInTon);
  assert.ok(buys.filter((b) => b.status === 'blocked').every((b) => b.reasonCode));
});

test('muted collections are skipped but still logged; floors.json is written and valid', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggc-eng-'));
  const floors = path.join(dir, 'floors.json');
  const { engine, notes, storage } = await app({ env: { FLOORS_FILE: floors } });
  storage.mute(MOCK_GIFT_COLLECTION, Date.now() + 3_600_000, 'Mock Plush Pepes');
  await engine.cycle();
  assert.equal(notes.alerts.length, 0);
  assert.ok(storage.decisionsSince(0).some((d) => d.code === 'MUTED' && d.kind === 'skip'));
  const doc = JSON.parse(fs.readFileSync(floors, 'utf8'));
  assert.equal(validateFloors(doc).ok, true);
  assert.equal(doc.market, 'getgems');
});

test('the lookalike collection alert is red and its autobuy is blocked by risk_red:official_collection', async () => {
  const { engine, notes, storage } = await app({ watch: [MOCK_FAKE_COLLECTION], rules: [{ collection: '*', maxPriceTon: 10, minDiscountPct: 50 }] });
  await engine.cycle();
  const fake = notes.alerts[0].a;
  assert.equal(fake.risk.level, 'red');
  assert.match(htmlToText(formatAlert(fake)), /Risk: 🔴 Not an official gift collection/);
  assert.equal(storage.allBuys()[0].reasonCode, 'risk_red:official_collection');
});
