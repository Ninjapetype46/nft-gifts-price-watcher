// Shadow-first rules and the safety envelope (/panic, auto-pause, doctor, presets).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStorage } from '../src/storage.js';
import { Settings } from '../src/settings.js';
import { loadConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { Shadow, hindsightSummary, formatHindsight } from '../src/shadow.js';
import { presetDiff, applyPreset, unexplainedDrop, isStale, runDoctor, formatDoctor, noteExecutorResult, autoPauseState } from '../src/safety.js';
import { MockClient, MOCK_GIFT_COLLECTION } from '../src/clients/mock.js';
import { Buyer } from '../src/autobuy.js';
import { tonToNano } from '../src/models.js';

// Engine cycles write floors.json: never the real ./data/floors.json that sibling bots read.
const TMP_FLOORS = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gg-safety-test-')), 'floors.json');

async function shadowApp(env = {}) {
  const cfg = loadConfig({ env: { DRY_RUN: 'false', FLOORS_FILE: TMP_FLOORS, ...env } });
  const storage = await openStorage(':memory:');
  const settings = new Settings(cfg, storage);
  settings.confirmLive();
  settings.setFlag('autobuy', true);
  const client = new MockClient();
  const spy = { calls: 0, buy: async () => (spy.calls++, { ok: true }), journal: null, riskFacts: null, shadow: null };
  const notifier = { alert: async () => {}, text: async () => {} };
  const engine = new Engine({ cfg, settings, storage, client, notifier, buyer: spy });
  storage.watch(MOCK_GIFT_COLLECTION, { name: 'Mock Plush Pepes', isGift: true });
  return { cfg, storage, settings, engine, spy, client };
}

test('a shadow rule never calls the executor, even with DRY_RUN=false and live confirmed', async () => {
  const { storage, settings, engine, spy } = await shadowApp();
  assert.equal(settings.dryRun, false);
  const id = storage.addRule({ collection: MOCK_GIFT_COLLECTION, maxPriceTon: 20, minDiscountPct: 40, state: 'shadow' });
  await engine.cycle();
  assert.equal(spy.calls, 0);
  const fills = storage.listShadowFills({ ruleId: id });
  assert.ok(fills.length >= 2, `fills: ${fills.length}`);
  assert.ok(fills.every((f) => f.markPrice !== null)); // marked in the same cycle
  const ev = storage.decisionsSince(0).filter((d) => d.mode === 'shadow');
  assert.ok(ev.length >= 2 && ev.every((d) => d.code === 'SHADOW_RULE'));
});

test('shadow -> live only through promote(); hindsight numbers are net of fees', async () => {
  const { storage, engine, cfg } = await shadowApp();
  const id = storage.addRule({ collection: MOCK_GIFT_COLLECTION, maxPriceTon: 20, minDiscountPct: 40, state: 'shadow', createdAt: Date.now() - 30 * 3_600_000 });
  await engine.cycle();
  await engine.cycle();
  assert.equal(storage.getRule(id).state, 'shadow');
  const shadow = new Shadow({ storage, cfg });
  const s = hindsightSummary(storage.listShadowFills({ ruleId: id }));
  const bronze = storage.listShadowFills({ ruleId: id }).find((f) => f.meta.name === 'Mock Pepe #1');
  assert.ok(Math.abs(bronze.markPrice - (8 * 0.9 - 0.1)) < 1e-9); // exit net of 5% fee + 5% royalty + gas
  assert.equal(bronze.outcome, 'sniped'); // gone in cycle 2, within SNIPED_WINDOW_SEC
  assert.equal(s.sniped, 1);
  assert.match(formatHindsight(storage.getRule(id), s, { ageH: 30 }), /30h trial: would have bought \d+ for [\d.]+ TON all-in; worth [\d.]+ net now/);
  // The engine already sent the card once the trial was long enough; it is not repeated.
  assert.ok(storage.kvGet(`hindsight_sent:${id}`));
  assert.equal(shadow.dueCards(Date.now(), { minHours: 24, maxHours: 168, minMatches: 2 }).length, 0);
  shadow.keepTesting(id, Date.now() - 25 * 3_600_000);
  assert.equal(shadow.dueCards(Date.now(), { minHours: 24, maxHours: 168, minMatches: 2 }).length, 1);
  assert.equal(shadow.promote(id).ok, true);
  assert.equal(storage.getRule(id).state, 'live');
  assert.ok(storage.getRule(id).promotedAt > 0);
});

test('the panic flag persists across reopening storage and forces practice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggc-panic-'));
  const file = path.join(dir, 'p.db');
  const cfg = loadConfig({ env: { DRY_RUN: 'false' } });
  let s = await openStorage(file);
  let st = new Settings(cfg, s);
  st.confirmLive();
  assert.equal(st.dryRun, false);
  st.setPanic(true);
  s.close();
  s = await openStorage(file);
  st = new Settings(cfg, s);
  assert.equal(st.panic, true);
  assert.equal(st.dryRun, true);
  assert.throws(() => st.confirmLive(), /panic/);
  st.setPanic(false);
  assert.equal(st.dryRun, true); // still practice until /dry off again
  s.close();
});

test('DRY_RUN=true in .env is a hard lock no stored setting can override', async () => {
  const st = new Settings(loadConfig({ env: { DRY_RUN: 'true' } }), await openStorage(':memory:'));
  st.setFlag('dry_run', false);
  assert.equal(st.dryRun, true);
  assert.throws(() => st.confirmLive(), /hard lock/);
});

test('auto-pause fires after AUTO_PAUSE_ERRORS failing live buys', async () => {
  const cfg = loadConfig({ env: { DRY_RUN: 'false', AUTO_PAUSE_ERRORS: '3', MAX_BUYS_PER_HOUR: '10' } });
  const storage = await openStorage(':memory:');
  const settings = new Settings(cfg, storage);
  settings.confirmLive();
  const texts = [];
  const client = { name: 'fake', refreshListing: async (l) => l, getBuyTransaction: async (l) => ({ messages: [{ to: l.saleContract, amountNano: (BigInt(l.priceNano) + tonToNano('0.2')).toString() }] }) };
  const wallet = { address: 'UQx', balanceNano: async () => tonToNano(100), send: async () => { throw new Error('rpc down'); } };
  const buyer = new Buyer({ cfg, settings, storage, client, notifier: { text: async (t) => texts.push(t) }, walletFactory: async () => wallet });
  for (let i = 0; i < 3; i++) {
    const nft = '0:' + String(i).padStart(64, 'e');
    await buyer.buy({ nft, collection: 'c', name: `N${i}`, attrs: {}, priceNano: tonToNano(1).toString(), priceTon: 1, saleContract: '0:' + '5a'.repeat(32), contractType: 'sale-contract', seller: null }, { source: 'manual' });
  }
  assert.equal(autoPauseState(storage).code, 'errors');
  assert.ok(texts.some((t) => /auto-paused/.test(t)));
  assert.equal(noteExecutorResult(storage, true, cfg), false); // a success resets the streak
});

test('balance-drop and stale-data checks', () => {
  assert.equal(unexplainedDrop({ baselineTon: 100, currentTon: 60, ownSpentTon: 30, pct: 30 }).trip, false); // explained by own buys
  assert.equal(unexplainedDrop({ baselineTon: 100, currentTon: 60, ownSpentTon: 0, pct: 30 }).trip, true);
  assert.equal(isStale(Date.now() - 400_000, Date.now(), 300), true);
  assert.equal(isStale(Date.now() - 100_000, Date.now(), 300), false);
});

test('/preset produces the expected config diff and never exceeds .env', async () => {
  const st = new Settings(loadConfig({ env: { MAX_PRICE_TON: '20', DAILY_BUDGET_TON: '50', MAX_BUYS_PER_HOUR: '4' } }), await openStorage(':memory:'));
  const careful = presetDiff('careful', st);
  assert.deepEqual(careful.changes, [
    { param: 'max_price', from: 20, to: 5 },
    { param: 'daily_budget', from: 50, to: 10 },
    { param: 'max_buys_per_hour', from: 4, to: 1 },
    { param: 'discount_pct', from: 25, to: 35 },
  ]);
  applyPreset(st, careful.changes);
  assert.equal(st.get('max_price'), 5);
  const bold = presetDiff('bold', st);
  assert.ok(bold.changes.every((c) => c.param === 'discount_pct' || c.to <= st.cfg[{ max_price: 'maxPriceTon', daily_budget: 'dailyBudgetTon', max_buys_per_hour: 'maxBuysPerHour' }[c.param]]));
  assert.equal(presetDiff('yolo', st).ok, false);
});

test('doctor against the mock client: all PASS except practice mode WARN; FAIL sets exit code 1', async () => {
  const cfg = loadConfig({ env: {} });
  const storage = await openStorage(':memory:');
  const settings = new Settings(cfg, storage);
  const r = await runDoctor({ cfg, settings, storage, client: new MockClient() });
  assert.deepEqual(r.filter((x) => x.status !== 'PASS').map((x) => [x.item, x.status]), [['mode', 'WARN']]);
  assert.equal(formatDoctor(r).exitCode, 0);
  const down = new MockClient();
  down.serverStatus = 'down';
  const r2 = await runDoctor({ cfg: { ...cfg, maxPriceTon: 100 }, settings: new Settings({ ...cfg, maxPriceTon: 100 }, storage), client: down });
  assert.equal(formatDoctor(r2).exitCode, 1);
  assert.ok(r2.find((x) => x.item === 'api').hint);
});

test('.env ceilings hold at read time: overrides stored under an older, higher .env are clamped', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gg-ceiling-')), 'g.db');
  let storage = await openStorage(file);
  let st = new Settings(loadConfig({ env: { MAX_PRICE_TON: '20', DAILY_BUDGET_TON: '50', MAX_BUYS_PER_HOUR: '4' } }), storage);
  applyPreset(st, presetDiff('normal', st).changes); // stores max_price 10, daily_budget 25, 2/h
  assert.equal(st.get('max_price'), 10);
  storage.close();

  // The owner tightens .env and restarts.
  storage = await openStorage(file);
  const cfg = loadConfig({ env: { MAX_PRICE_TON: '5', DAILY_BUDGET_TON: '10', MAX_BUYS_PER_HOUR: '1', DRY_RUN: 'false', CONFIRM_ABOVE: '100', LIVE_RAMP_HOURS: '0' } });
  st = new Settings(cfg, storage);
  st.confirmLive();
  const lim = st.limits();
  assert.equal(lim.maxPriceTon, 5);
  assert.equal(lim.dailyBudgetTon, 10);
  assert.equal(lim.maxBuysPerHour, 1);
  assert.deepEqual(st.overridesAboveCeiling().map((o) => o.name), ['max_price', 'daily_budget', 'max_buys_per_hour']);
  const doc = await runDoctor({ cfg, settings: st, storage, client: new MockClient() });
  const limits = doc.find((x) => x.item === 'limits');
  assert.equal(limits.status, 'WARN');
  assert.match(limits.detail, /stored max_price=10.*above \.env/);

  // The spend path enforces the .env value, not the stored 10.
  const client = new MockClient();
  client.tick(1);
  const listing = (await client.getListings(MOCK_GIFT_COLLECTION)).find((l) => l.priceTon > 5 && l.priceTon <= 10);
  const sent = [];
  const wallet = { address: 'UQx', balanceNano: async () => tonToNano(100), send: async (m) => (sent.push(m), { seqno: 1, confirmed: true }) };
  const buyer = new Buyer({ cfg, settings: st, storage, client, notifier: { text: async () => {} }, walletFactory: async () => wallet });
  const r = await buyer.buy(listing, { source: 'manual' });
  assert.equal(r.code, 'max_price');
  assert.equal(sent.length, 0);
  // A lower stored value still applies, and clearing the override removes the warning.
  st.set('max_price', 'default');
  assert.equal(st.set('daily_budget', 8).ok, true);
  assert.equal(st.limits().dailyBudgetTon, 8);
  st.set('max_buys_per_hour', 'default');
  assert.deepEqual(st.overridesAboveCeiling(), []);
  storage.close();
});

test('hindsight: sniped fills are counted as sniped only, never in the money numbers', () => {
  const f = (entry, mark, outcome = 'open') => ({ entryPrice: entry, entryCosts: 0.1, markPrice: mark, outcome });
  const s = hindsightSummary([f(10, 12), f(5, 4.5), f(4, 7.1, 'sniped')]);
  assert.equal(s.n, 3);
  assert.equal(s.filled, 2);
  assert.equal(s.sniped, 1);
  assert.ok(Math.abs(s.allIn - 15.2) < 1e-9);
  assert.ok(Math.abs(s.worth - 16.5) < 1e-9);
  assert.ok(Math.abs(s.best - 1.9) < 1e-9);
  assert.ok(Math.abs(s.worst + 0.6) < 1e-9);
  const text = formatHindsight({ id: 1, collection: '*', maxPriceTon: 12, minDiscountPct: 20 }, s, { ageH: 24 });
  assert.match(text, /would have bought 2 for 15\.2 TON all-in; worth 16\.5 net now \(\+8\.6%\); 1 of 3 sold to someone else within 2 min \(not counted\)/);
});
