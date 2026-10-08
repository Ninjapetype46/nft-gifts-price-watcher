import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findRule,
  effectiveDiscountPct,
  checkLimits,
  buildDirectBuyMessages,
  validateBuyMessages,
  Buyer,
} from '../src/autobuy.js';
import { openStorage } from '../src/storage.js';
import { Settings } from '../src/settings.js';
import { loadConfig } from '../src/config.js';
import { tonToNano } from '../src/models.js';

const C = '0:' + '11'.repeat(32);
const SALE = '0:' + '5a'.repeat(32);
const NOW = Date.UTC(2026, 9, 28, 12);
const HOUR = 3_600_000;

const listing = (priceTon, nft = '0:' + 'ee'.repeat(32)) => ({
  nft,
  collection: C,
  name: `NFT ${priceTon}`,
  attrs: {},
  priceNano: tonToNano(priceTon).toString(),
  priceTon,
  saleContract: SALE,
  saleVersion: 'v1',
  contractType: 'sale-contract',
  seller: null,
  market: 'getgems',
  source: 'mock',
});
const alert = (priceTon, { discountPct = null, belowFloorPct = null } = {}) => ({
  listing: listing(priceTon),
  reasons: [],
  floorRefTon: null,
  belowFloorPct,
  valuation: null,
  discountPct,
});
const limits = { maxPriceTon: 20, dailyBudgetTon: 50, maxBuysPerHour: 2 };
const buy = (priceTon, minutesAgo, over = {}) => ({
  nft: `n${Math.random()}`,
  priceTon,
  mode: 'dry',
  status: 'dry',
  createdAt: NOW - minutesAgo * 60_000,
  ...over,
});

test('effectiveDiscountPct prefers valuation discount, then floor discount', () => {
  assert.equal(effectiveDiscountPct(alert(1, { discountPct: 30, belowFloorPct: 10 })), 30);
  assert.equal(effectiveDiscountPct(alert(1, { belowFloorPct: 10 })), 10);
  assert.equal(effectiveDiscountPct(alert(1)), null);
});

test('findRule matches collection or *, max price and min discount', () => {
  const rules = [
    { id: 1, collection: '0:other', maxPriceTon: 100, minDiscountPct: 0, enabled: true },
    { id: 2, collection: C, maxPriceTon: 10, minDiscountPct: 30, enabled: true },
    { id: 3, collection: '*', maxPriceTon: 50, minDiscountPct: 50, enabled: true },
  ];
  assert.equal(findRule(alert(9, { discountPct: 35 }), rules)?.id, 2);
  assert.equal(findRule(alert(11, { discountPct: 35 }), rules), null);
  assert.equal(findRule(alert(11, { discountPct: 60 }), rules)?.id, 3);
  assert.equal(findRule(alert(9, { discountPct: 20 }), rules), null);
  assert.equal(findRule(alert(9), rules), null); // no discount info
  assert.equal(findRule(alert(9, { discountPct: 35 }), [{ ...rules[1], enabled: false }]), null);
});

test('checkLimits: max price, budget, hourly count, duplicates, mode separation', () => {
  const base = { nft: 'x', mode: 'dry', now: NOW, limits };
  assert.deepEqual(checkLimits({ ...base, priceTon: 10, buys: [] }), { ok: true });
  assert.match(checkLimits({ ...base, priceTon: 21, buys: [] }).reason, /MAX_PRICE_TON/);
  assert.match(checkLimits({ ...base, priceTon: 15, buys: [buy(20, 120), buy(20, 180)] }).reason, /daily budget/);
  assert.equal(checkLimits({ ...base, priceTon: 10, buys: [buy(20, 120), buy(20, 180)] }).ok, true); // exactly 50
  assert.equal(checkLimits({ ...base, priceTon: 15, buys: [buy(20, 25 * 60), buy(20, 26 * 60)] }).ok, true); // older than 24h
  assert.match(checkLimits({ ...base, priceTon: 1, buys: [buy(1, 10), buy(1, 20)] }).reason, /MAX_BUYS_PER_HOUR/);
  assert.equal(checkLimits({ ...base, priceTon: 1, buys: [buy(1, 10), buy(1, 61)] }).ok, true);
  assert.match(checkLimits({ ...base, priceTon: 1, buys: [buy(1, 300, { nft: 'x' })] }).reason, /already bought/);
  // live buys do not count against dry limits; blocked/failed never count
  assert.equal(checkLimits({ ...base, priceTon: 1, buys: [buy(1, 10, { mode: 'live', status: 'sent' }), buy(1, 5, { mode: 'live', status: 'sent' })] }).ok, true);
  assert.equal(checkLimits({ ...base, priceTon: 1, buys: [buy(1, 10, { status: 'blocked' }), buy(1, 5, { status: 'failed' })] }).ok, true);
});

test('direct buy message: full price + gas, bounce, empty body', () => {
  const [m] = buildDirectBuyMessages(listing(6.5), 0.3);
  assert.equal(m.to, SALE);
  assert.equal(m.amountNano, '6800000000');
  assert.equal(m.bounce, true);
  assert.equal(m.payloadB64, null);
  assert.throws(() => buildDirectBuyMessages({ ...listing(1), saleContract: null }, 0.3));
});

test('validateBuyMessages bounds the total', () => {
  const price = tonToNano(10).toString();
  const msg = (ton) => ({ to: SALE, amountNano: tonToNano(ton).toString() });
  assert.equal(validateBuyMessages([msg(10.3)], { priceNano: price, maxExtraTon: 1.5, saleContract: SALE }).ok, true);
  assert.equal(validateBuyMessages([msg(9.9)], { priceNano: price, maxExtraTon: 1.5 }).ok, false);
  assert.match(validateBuyMessages([msg(12)], { priceNano: price, maxExtraTon: 1.5 }).reason, /BUY_MAX_EXTRA_TON/);
  assert.equal(validateBuyMessages([], { priceNano: price, maxExtraTon: 1.5 }).ok, false);
});

async function setup({ dry = true, current = (l) => l, tx = undefined, wallet } = {}) {
  const cfg = loadConfig({ env: { MAX_PRICE_TON: '20', DAILY_BUDGET_TON: '50', MAX_BUYS_PER_HOUR: '2', DRY_RUN: String(dry) } });
  const storage = await openStorage(':memory:');
  const settings = new Settings(cfg, storage);
  // Shared contract: live mode needs DRY_RUN=false in .env AND an explicit bot confirmation.
  if (!dry) settings.confirmLive();
  const texts = [];
  const client = {
    name: 'fake',
    refreshListing: async (l) => current(l),
    getBuyTransaction: async (l) =>
      tx === undefined ? { uuid: 'u', messages: [{ to: l.saleContract, amountNano: (BigInt(l.priceNano) + tonToNano('0.2')).toString() }] } : tx,
  };
  const buyer = new Buyer({
    cfg,
    settings,
    storage,
    client,
    notifier: { text: async (t) => texts.push(t), alert: async () => {} },
    walletFactory: async () => wallet,
  });
  return { buyer, storage, texts, settings };
}

test('Buyer practice mode records a paper buy and notifies "PRACTICE · Paper buy"', async () => {
  const { buyer, storage, texts } = await setup();
  const r = await buyer.buy(listing(5), { source: 'auto', ruleId: 1 });
  assert.equal(r.status, 'dry');
  assert.equal(storage.listBuys()[0].status, 'dry');
  assert.match(texts[0], /PRACTICE · Paper buy: <b>NFT 5<\/b>/);
  // Same NFT again -> blocked as duplicate
  const again = await buyer.buy(listing(5), { source: 'manual' });
  assert.equal(again.status, 'blocked');
  assert.match(again.reason, /already bought/);
});

test('Buyer blocks when the listing is gone or the price went up', async () => {
  const gone = await setup({ current: () => null });
  assert.match((await gone.buyer.buy(listing(5), { source: 'manual' })).reason, /no longer on sale/);
  const up = await setup({ current: (l) => ({ ...l, priceNano: tonToNano(6).toString(), priceTon: 6 }) });
  assert.match((await up.buyer.buy(listing(5), { source: 'manual' })).reason, /price changed/);
});

test('Buyer blocks over-limit buys before touching the network', async () => {
  let refreshed = false;
  const { buyer } = await setup({ current: (l) => ((refreshed = true), l) });
  const r = await buyer.buy(listing(25), { source: 'manual' });
  assert.match(r.reason, /MAX_PRICE_TON/);
  assert.equal(refreshed, false);
});

test('Buyer without a buy API and without a chain checker refuses', async () => {
  const { buyer } = await setup({ tx: null });
  assert.match((await buyer.buy(listing(5), { source: 'manual' })).reason, /cannot build purchase/);
});

test('Buyer live path signs via wallet and records "sent"', async () => {
  const sent = [];
  const wallet = {
    address: 'UQfake',
    balanceNano: async () => tonToNano(100),
    send: async (msgs) => (sent.push(msgs), { seqno: 7, confirmed: true }),
  };
  const { buyer, storage, texts } = await setup({ dry: false, wallet });
  const r = await buyer.buy(listing(5), { source: 'manual' });
  assert.equal(r.status, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0].amountNano, tonToNano(5.2).toString());
  const b = storage.listBuys()[0];
  assert.equal(b.mode, 'live');
  assert.equal(b.status, 'sent');
  assert.match(b.txRef, /seqno 7/);
  assert.match(texts.at(-1), /Buy sent/);
});

test('Buyer live path fails cleanly on low balance', async () => {
  const wallet = { address: 'UQfake', balanceNano: async () => tonToNano(1), send: async () => assert.fail('must not send') };
  const { buyer, storage } = await setup({ dry: false, wallet });
  const r = await buyer.buy(listing(5), { source: 'manual' });
  assert.equal(r.status, 'failed');
  assert.match(storage.listBuys()[0].error, /balance/);
});

// ---- Confidence gate, rule conditions, all-in limits, safe-to-buy light, preview -------------
import { ruleGate, confidenceOf } from '../src/autobuy.js';
import { assessRisk } from '../src/risk.js';

const GIFT = { model: 'Bronze', backdrop: 'Onyx Black', symbol: 'Star' };
const giftListing = (priceTon, nft = '0:' + 'e7'.repeat(32), extra = {}) => ({ ...listing(priceTon, nft), attrs: { ...GIFT }, seller: '0:' + '77'.repeat(32), ...extra });
const richAlert = (l, { conf = 'A', fair = 8, edge = 3, eta = 2, exitBacked = false, risk = null } = {}) => ({
  listing: l,
  reasons: [{ kind: 'undervalued', code: 'BELOW_FAIR', text: 'x' }],
  floorRefTon: null,
  belowFloorPct: null,
  valuation: { fairValueTon: fair, confidence: conf, note: 'Model "Bronze": 8 sale(s)', comparables: 8 },
  discountPct: 50,
  edge: { allInTon: l.priceTon + 0.1, edgeTon: edge, edgePct: (edge / (l.priceTon + 0.1)) * 100, liquidity: { etaDays: eta, badge: 'fast' }, exitBacked },
  risk: risk || { level: 'green', checks: [] },
});

async function setup2({ env = {}, status = 'up', trades = 5, current = (l) => l, gifts = null } = {}) {
  const cfg = loadConfig({ env: { MAX_PRICE_TON: '20', DAILY_BUDGET_TON: '50', MAX_BUYS_PER_HOUR: '5', ...env } });
  const storage = await openStorage(':memory:');
  const settings = new Settings(cfg, storage);
  const texts = [];
  const sent = [];
  const client = {
    name: 'fake',
    status,
    refreshListing: async (l) => current(l),
    getBuyTransaction: async (l) => ({ uuid: 'u', messages: [{ to: l.saleContract, amountNano: (BigInt(l.priceNano) + tonToNano('0.2')).toString() }] }),
    getServerStatus: async () => ({ status: client.status }),
    getUserTradingInfo: async () => ({ tradingCount: trades }),
    listGiftCollections: async () => gifts || [{ address: C, name: 'Gifts' }],
  };
  const wallet = { address: 'UQx', balanceNano: async () => tonToNano(100), send: async (m) => (sent.push(m), { seqno: 1, confirmed: true }) };
  const buyer = new Buyer({ cfg, settings, storage, client, notifier: { text: async (t) => texts.push(t), alert: async () => {} }, walletFactory: async () => wallet });
  return { buyer, storage, texts, settings, client, sent, cfg };
}

test('autobuy blocks confidence C with code confidence_low and passes A', async () => {
  const { buyer, storage, texts } = await setup2();
  const c = await buyer.buy(giftListing(5), { source: 'auto', alert: richAlert(giftListing(5), { conf: 'C' }) });
  assert.equal(c.code, 'confidence_low');
  assert.match(c.reason, /^price confidence C is below the autobuy minimum B \(Model "Bronze"/);
  assert.match(texts.at(-1), /PRACTICE · Buy blocked: .* — price confidence C is below the autobuy minimum B/);
  assert.equal(storage.listBuys()[0].reasonCode, 'confidence_low');
  const a = await buyer.buy(giftListing(5, '0:' + 'e8'.repeat(32)), { source: 'auto', alert: richAlert(giftListing(5, '0:' + 'e8'.repeat(32)), { conf: 'A' }) });
  assert.equal(a.status, 'dry');
});

test('floor-only alerts count as C unless AUTOBUY_ALLOW_FLOOR_ONLY; manual C is not blocked', async () => {
  const cfg = loadConfig({ env: {} });
  assert.equal(confidenceOf({ valuation: null }, cfg), 'C');
  assert.equal(confidenceOf({ valuation: null }, { ...cfg, autobuyAllowFloorOnly: true }), 'B');
  const { buyer } = await setup2();
  const l = giftListing(5);
  const r = await buyer.buy(l, { source: 'manual', alert: richAlert(l, { conf: 'C' }) });
  assert.equal(r.status, 'dry');
});

test('rule conditions block with edge_low, eta_high and no_bid', async () => {
  const l = giftListing(5);
  assert.equal(ruleGate(richAlert(l, { edge: 0.5 }), { minEdgeTon: 1 }).code, 'edge_low');
  assert.equal(ruleGate(richAlert(l, { edge: 0.5 }), { minEdgePct: 20 }).code, 'edge_low');
  assert.equal(ruleGate(richAlert(l, { eta: 30 }), { maxEtaDays: 7 }).code, 'eta_high');
  assert.equal(ruleGate(richAlert(l), { requireBid: true }).code, 'no_bid');
  assert.equal(ruleGate(richAlert(l, { exitBacked: true, edge: 2 }), { requireBid: true, minEdgeTon: 1, maxEtaDays: 7 }), null);
  const { buyer, storage } = await setup2();
  const r = await buyer.buy(l, { source: 'auto', alert: richAlert(l, { eta: 30 }), rule: { id: 1, maxEtaDays: 7 } });
  assert.equal(r.code, 'eta_high');
  assert.equal(storage.listBuys()[0].reasonCode, 'eta_high');
});

test('all-in cost counts against MAX_PRICE_TON and the daily budget', async () => {
  const { buyer } = await setup2({ env: { DAILY_BUDGET_TON: '10', MAX_PRICE_TON: '5' } });
  const over = await buyer.buy(giftListing(4.95, '0:' + 'a1'.repeat(32)), { source: 'manual' });
  assert.equal(over.code, 'max_price'); // price 4.95 fits MAX_PRICE_TON=5, all-in 5.05 does not
  assert.match(over.reason, /all-in 5\.05 > MAX_PRICE_TON 5\.00/);
  const { buyer: b2 } = await setup2({ env: { DAILY_BUDGET_TON: '10', MAX_PRICE_TON: '6' } });
  assert.equal((await b2.buy(giftListing(4.95, '0:' + 'a2'.repeat(32)), { source: 'manual' })).status, 'dry');
  const second = await b2.buy(giftListing(4.95, '0:' + 'a3'.repeat(32)), { source: 'manual' });
  assert.equal(second.code, 'budget'); // 5.05 + 5.05 > 10 although 4.95 + 4.95 < 10
});

test('safe-to-buy: red blocks always; yellow blocks autobuy unless AUTOBUY_ALLOW_WARN covers it', async () => {
  const fake = giftListing(5);
  const lookalike = assessRisk({ isGift: true, collection: '0:other', giftCollections: [C] }, loadConfig({ env: {} }));
  const { buyer } = await setup2();
  const red = await buyer.buy(fake, { source: 'auto', alert: richAlert(fake, { risk: lookalike }) });
  assert.equal(red.code, 'risk_red:official_collection');
  const banned = await (await setup2({ current: (l) => ({ ...l, warning: { type: 'NftBanFromFragment', reason: 't' } }) })).buyer.buy(giftListing(5), { source: 'manual' });
  assert.equal(banned.code, 'risk_red:fragment_ban'); // manual cannot buy red either
  const off = (l) => ({ ...l, contractType: 'offchain' });
  const y = await (await setup2({ trades: 0, current: off })).buyer.buy(giftListing(5), { source: 'auto', alert: richAlert(giftListing(5)) });
  assert.equal(y.code, 'risk_warn:sale_type,seller_history');
  const allowed = await (await setup2({ trades: 0, current: off, env: { AUTOBUY_ALLOW_WARN: 'sale_type,seller_history' } })).buyer.buy(giftListing(5), { source: 'auto', alert: richAlert(giftListing(5)) });
  assert.equal(allowed.status, 'dry');
  const manualYellow = await (await setup2({ trades: 0, current: off })).buyer.buy(giftListing(5), { source: 'manual' });
  assert.equal(manualYellow.status, 'dry');
});

test('market "warn" holds autobuy and sends exactly one notice across two cycles', async () => {
  const { buyer, texts, client } = await setup2({ status: 'warn' });
  const a1 = await buyer.buy(giftListing(5, '0:' + 'b1'.repeat(32)), { source: 'auto', alert: richAlert(giftListing(5, '0:' + 'b1'.repeat(32))) });
  buyer.riskFacts.status = null; // next cycle: cache expired
  const a2 = await buyer.buy(giftListing(5, '0:' + 'b2'.repeat(32)), { source: 'auto', alert: richAlert(giftListing(5, '0:' + 'b2'.repeat(32))) });
  assert.equal(a1.code, 'risk_warn:market_status');
  assert.equal(a2.code, 'risk_warn:market_status');
  assert.equal(texts.filter((t) => /Getgems reports "warn". Autopilot is holding buys/.test(t)).length, 1);
  client.status = 'up';
  buyer.riskFacts.status = null;
  const a3 = await buyer.buy(giftListing(5, '0:' + 'b3'.repeat(32)), { source: 'auto', alert: richAlert(giftListing(5, '0:' + 'b3'.repeat(32))) });
  assert.equal(a3.status, 'dry');
  assert.ok(texts.some((t) => /back up|"up" again/.test(t)));
});

test('preview shows the checklist and never signs or sends', async () => {
  const { buyer, sent, settings, storage } = await setup2({ env: { DRY_RUN: 'false' } });
  settings.confirmLive();
  const l = giftListing(5);
  const pv = await buyer.preview(l, { source: 'manual', alert: richAlert(l) });
  assert.equal(pv.level, 'green');
  assert.equal(pv.canConfirm, true);
  assert.ok(Math.abs(pv.allInTon - 5.1) < 1e-9);
  assert.ok(pv.checks.some((c) => c.id === 'market_status' && c.status === 'ok'));
  assert.equal(sent.length, 0);
  assert.equal(storage.listBuys().length, 0);
  const gone = await (await setup2({ current: () => null })).buyer.preview(l, { source: 'manual' });
  assert.equal(gone.canConfirm, false);
});

// ---- /panic and mode changes during an in-flight buy; bookkeeping after a send -------------
import { interruption } from '../src/autobuy.js';

const gate = () => {
  let open;
  const p = new Promise((r) => (open = r));
  return { wait: () => p, open };
};

test('/panic while a live buy is being checked: nothing is sent, the buy is blocked as panic', async () => {
  const g = gate();
  const { buyer, storage, settings, sent } = await setup2({
    env: { DRY_RUN: 'false', CONFIRM_ABOVE: '100' },
    current: async (l) => (await g.wait(), l), // slow re-check of the listing
  });
  settings.confirmLive();
  const run = buyer.buy(giftListing(5), { source: 'manual' });
  await new Promise((r) => setTimeout(r, 10));
  settings.setPanic(true); // the owner hits /panic while refreshListing is in flight
  g.open();
  const r = await run;
  assert.equal(r.status, 'blocked');
  assert.equal(r.code, 'panic');
  assert.equal(sent.length, 0);
  assert.equal(storage.listBuys()[0].reasonCode, 'panic');
  // A buy queued after /panic is not even paper-bought.
  const next = await buyer.buy(giftListing(6, '0:' + 'e8'.repeat(32)), { source: 'manual' });
  assert.equal(next.code, 'panic');
  assert.equal(storage.listBuys().filter((b) => ['dry', 'pending', 'sent'].includes(b.status)).length, 0);
});

test('/dry on while the wallet balance is read: the pending row turns blocked, no send', async () => {
  const g = gate();
  const sent = [];
  const { storage, settings, cfg, client } = await setup2({ env: { DRY_RUN: 'false', CONFIRM_ABOVE: '100' } });
  settings.confirmLive();
  const wallet = { address: 'UQx', balanceNano: async () => (await g.wait(), tonToNano(100)), send: async (m) => (sent.push(m), { seqno: 1, confirmed: true }) };
  const b = new Buyer({ cfg, settings, storage, client, notifier: { text: async () => {} }, walletFactory: async () => wallet });
  const run = b.buy(giftListing(5), { source: 'manual' });
  for (let i = 0; i < 50 && !storage.listBuys().some((x) => x.status === 'pending'); i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(storage.listBuys()[0].status, 'pending');
  settings.setPractice();
  g.open();
  const r = await run;
  assert.equal(r.code, 'mode_changed');
  assert.equal(sent.length, 0);
  assert.equal(storage.listBuys().length, 1);
  assert.equal(storage.listBuys()[0].status, 'blocked');
  assert.equal(interruption(settings, 'dry'), null);
  assert.equal(interruption(settings, 'live').code, 'mode_changed');
});

test('a bookkeeping error after wallet.send keeps the buy "sent" and counted against the budget', async () => {
  const { buyer, storage, settings, sent } = await setup2({ env: { DRY_RUN: 'false', DAILY_BUDGET_TON: '20', CONFIRM_ABOVE: '100', LIVE_RAMP_HOURS: '0' } });
  settings.confirmLive();
  const orig = storage.addDecision.bind(storage);
  let fail = true;
  storage.addDecision = (d) => {
    if (fail && d.kind === 'buy') throw new Error('SQLITE_FULL: database or disk is full');
    return orig(d);
  };
  const r1 = await buyer.buy(giftListing(15, '0:' + 'a1'.repeat(32)), { source: 'manual' });
  assert.equal(r1.status, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(storage.listBuys()[0].status, 'sent');
  fail = false;
  const r2 = await buyer.buy(giftListing(15, '0:' + 'a2'.repeat(32)), { source: 'manual' });
  assert.equal(r2.status, 'blocked');
  assert.equal(r2.code, 'budget');
  assert.equal(sent.length, 1);
});

test('wallet.send failing after the broadcast keeps the buy pending (counted); before it, failed', async () => {
  const { storage, settings, cfg, client } = await setup2({ env: { DRY_RUN: 'false', DAILY_BUDGET_TON: '20', CONFIRM_ABOVE: '100', LIVE_RAMP_HOURS: '0' } });
  settings.confirmLive();
  let err = new Error('timeout waiting for the RPC');
  const wallet = { address: 'UQx', balanceNano: async () => tonToNano(100), send: async () => { throw err; } };
  const b = new Buyer({ cfg, settings, storage, client, notifier: { text: async () => {} }, walletFactory: async () => wallet });
  const r1 = await b.buy(giftListing(15, '0:' + 'b1'.repeat(32)), { source: 'manual' });
  assert.equal(r1.status, 'unknown');
  assert.equal(r1.code, 'send_unknown');
  assert.equal(storage.listBuys()[0].status, 'pending');
  const r2 = await b.buy(giftListing(15, '0:' + 'b2'.repeat(32)), { source: 'manual' });
  assert.equal(r2.code, 'budget'); // the unknown 15 TON still counts
  err = Object.assign(new Error('seqno read failed'), { stage: 'before_broadcast' });
  const r3 = await b.buy(giftListing(4, '0:' + 'b3'.repeat(32)), { source: 'manual' });
  assert.equal(r3.status, 'failed');
  assert.equal(r3.code, 'send_failed');
});
