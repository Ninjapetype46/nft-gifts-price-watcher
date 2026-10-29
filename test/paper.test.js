import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRace, markToMarket, scoreboard, readiness, formatScoreboard } from '../src/paper.js';
import { openStorage } from '../src/storage.js';
import { Settings } from '../src/settings.js';
import { loadConfig } from '../src/config.js';
import { checkLimits } from '../src/autobuy.js';

const cfg = loadConfig({ env: {} });
const NOW = Date.UTC(2026, 9, 28, 12);
const HOUR = 3_600_000;

test('classifyRace: sold within 30s is a lost race; later, never or earlier sales are open', () => {
  const buy = { createdAt: NOW };
  assert.equal(classifyRace(buy, { timeMs: NOW + 12_000 }, { lostRaceSec: 30 }), 'lost_race');
  assert.equal(classifyRace(buy, { timeMs: NOW + 600_000 }, { lostRaceSec: 30 }), 'open');
  assert.equal(classifyRace(buy, null, { lostRaceSec: 30 }), 'open');
  assert.equal(classifyRace(buy, { timeMs: NOW - 5_000 }, { lostRaceSec: 30 }), 'open');
});

test('markToMarket uses fees, plus the conservative same-model floor', () => {
  const fees = { marketFeePct: 0.05, royaltyPct: 0.05 };
  const m = markToMarket({ priceTon: 15 }, { fairValueTon: 41 }, fees, 16, cfg);
  assert.ok(Math.abs(m.markTon - 36.8) < 1e-9);
  assert.ok(Math.abs(m.markConsTon - 14.3) < 1e-9);
  const noFloor = markToMarket({ priceTon: 15 }, { fairValueTon: 41 }, fees, null, cfg);
  assert.equal(noFloor.markConsTon, noFloor.markTon);
  assert.deepEqual(markToMarket({ priceTon: 15 }, { fairValueTon: null }, fees, 16, cfg), { markTon: null, markConsTon: null });
});

test('scoreboard: lost races excluded from P&L, skipped counts by code, live column', () => {
  const b = (o) => ({ mode: 'dry', status: 'dry', name: 'x', priceTon: 4, allInTon: 4.1, createdAt: NOW - 2 * 86_400_000, ...o });
  const buys = [
    b({ name: 'Pepe #1', markTon: 7.1, outcome: 'lost_race', soldAfterSec: 12 }),
    b({ name: 'Gold', priceTon: 15, allInTon: 15.1, markTon: 37.7, markConsTon: 14.3 }),
    b({ name: 'Neon', priceTon: 5, allInTon: 5.1, markTon: 2.1, confidence: 'C' }),
    b({ status: 'blocked', reasonCode: 'risk_red:official_collection' }),
    b({ status: 'blocked', reasonCode: 'risk_red:fragment_ban' }),
    b({ status: 'blocked', reasonCode: 'rate' }),
  ];
  const sb = scoreboard(buys, NOW);
  assert.equal(sb.days, 2);
  assert.equal(sb.paper.n, 2);
  assert.ok(Math.abs(sb.paper.allIn - 20.2) < 1e-9);
  assert.ok(Math.abs(sb.paper.pnl - (37.7 + 2.1 - 20.2)) < 1e-9);
  assert.equal(sb.paper.lostRaces, 1);
  assert.deepEqual(sb.skipped, { risk_red: 2, rate: 1 });
  assert.equal(sb.paper.winners, 1);
  assert.equal(sb.paper.losers, 1);
  assert.equal(sb.worst.name, 'Neon');
  assert.equal(sb.live, null);
  const text = formatScoreboard(sb);
  assert.match(text, /Lost to faster buyers: 1 \(Pepe #1, sold 12s after it appeared/);
  assert.match(text, /Blocked buys 3: failed a safety check 2, hourly buy cap reached 1/);
  const withLive = scoreboard([...buys, b({ mode: 'live', status: 'sent', name: 'L', markTon: 5 })], NOW);
  assert.equal(withLive.live.n, 1);
  assert.match(formatScoreboard(withLive), /Live:/);
});

test('readiness line and the go-live thresholds', () => {
  assert.equal(readiness({ days: 0, paper: { n: 2 } }, cfg).text, '⚠️ Only 0 days / 2 paper buys: recommended 7 days, 3 buys');
  assert.deepEqual(readiness({ days: 9, paper: { n: 6 } }, cfg), { ok: true, text: '✅ 9 days, 6 paper buys' });
});

test('settings ramp: live_since 1h ago -> 25% budget, 25h ago -> 100%, DRY on clears it', async () => {
  const c = loadConfig({ env: { DRY_RUN: 'false', DAILY_BUDGET_TON: '40' } });
  const st = new Settings(c, await openStorage(':memory:'));
  assert.equal(st.dryRun, true); // live needs the bot confirmation
  st.confirmLive(NOW - HOUR);
  assert.equal(st.dryRun, false);
  assert.equal(st.limits(NOW).dailyBudgetTon, 10);
  assert.equal(st.ramp(NOW).active, true);
  // The budget enforced by checkLimits is the ramped one.
  const lim = st.limits(NOW);
  assert.match(checkLimits({ priceTon: 11, nft: 'x', mode: 'live', buys: [], now: NOW, limits: lim }).reason, /DAILY_BUDGET_TON 10/);
  st.storage.setSetting('live_since', NOW - 25 * HOUR);
  assert.equal(st.limits(NOW).dailyBudgetTon, 40);
  st.setPractice();
  assert.equal(st.liveSince(), null);
  assert.equal(st.dryRun, true);
});

test('buys table migration on an old database adds the paper columns and keeps rows', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE buys (id INTEGER PRIMARY KEY AUTOINCREMENT, nft TEXT NOT NULL, collection TEXT NOT NULL, name TEXT,
    price_ton REAL NOT NULL, total_ton REAL, mode TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL,
    rule_id INTEGER, alert_id INTEGER, tx_ref TEXT, error TEXT, created_at INTEGER NOT NULL)`);
  db.prepare("INSERT INTO buys(nft, collection, name, price_ton, mode, status, source, created_at) VALUES('n','c','Old', 3, 'dry', 'dry', 'auto', 1)").run();
  const { Storage } = await import('../src/storage.js');
  const s = new Storage(db);
  const cols = db.prepare('PRAGMA table_info(buys)').all().map((r) => r.name);
  for (const c of ['fair_ton', 'confidence', 'all_in_ton', 'edge_ton', 'risk_level', 'reason_code', 'outcome', 'outcome_at', 'mark_ton', 'mark_cons_ton', 'marked_at']) assert.ok(cols.includes(c), c);
  assert.equal(s.listBuys()[0].name, 'Old');
  s.updateBuyMarks(1, { outcome: 'lost_race', markTon: 4 });
  assert.equal(s.getBuy(1).outcome, 'lost_race');
});

test('a lost-race paper buy does not count against the hourly cap or the budget', () => {
  const limits = { maxPriceTon: 20, dailyBudgetTon: 50, maxBuysPerHour: 1 };
  const lost = { nft: 'a', mode: 'dry', status: 'dry', priceTon: 4, allInTon: 4.1, createdAt: NOW - 60_000, outcome: 'lost_race' };
  assert.equal(checkLimits({ priceTon: 4, nft: 'b', mode: 'dry', buys: [lost], now: NOW, limits }).ok, true);
  assert.equal(checkLimits({ priceTon: 4, nft: 'b', mode: 'dry', buys: [{ ...lost, outcome: 'open' }], now: NOW, limits }).code, 'rate');
});

test('scoreboardFromStorage reports how fast the lost race was sold after the alert', async () => {
  const { scoreboardFromStorage } = await import('../src/engine.js');
  const s = await openStorage(':memory:');
  const alertId = s.saveAlert({ listing: { nft: 'n1', collection: 'c', priceNano: '4000000000', name: 'Pepe' }, reasons: [{ kind: 'undervalued' }] });
  const created = s.getAlert(alertId).createdAt;
  const id = s.recordBuy({ nft: 'n1', collection: 'c', name: 'Pepe', priceTon: 4, allInTon: 4.1, mode: 'dry', status: 'dry', source: 'auto', alertId, createdAt: created + 50 });
  s.upsertSales([{ txHash: 'race', collection: 'c', nft: 'n1', priceTon: 4, timeMs: created + 12_000 }]);
  s.updateBuyMarks(id, { outcome: 'lost_race' });
  const sb = scoreboardFromStorage(s, created + 60_000);
  assert.equal(sb.paper.lostRaces, 1);
  assert.equal(sb.paper.lost[0].soldAfterSec, 12);
  assert.equal(sb.paper.n, 0);
});
