// Bot wiring test: real grammY handlers, Telegram API calls captured by a transformer (no network).
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createBot } from '../src/bot.js';
import { MockClient, MOCK_GIFT_COLLECTION, MOCK_FAKE_COLLECTION, mockProfileGifts } from '../src/clients/mock.js';
import { openStorage } from '../src/storage.js';
import { Settings } from '../src/settings.js';
import { loadConfig } from '../src/config.js';
import { Buyer } from '../src/autobuy.js';
import { Engine } from '../src/engine.js';
import { toFriendly } from '../src/address.js';
import { tonToNano } from '../src/models.js';

const ADMIN = 111;
// Never write the real ./data/floors.json or ./data/events.jsonl from tests.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-bot-test-'));
const TEST_FILES = { FLOORS_FILE: path.join(TMP, 'floors.json'), EVENTS_FILE: path.join(TMP, 'events.jsonl') };
const botInfo = {
  id: 42,
  is_bot: true,
  first_name: 'Test',
  username: 'test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

async function setup({ env = {}, wallet = null, liveLibs = () => true } = {}) {
  const cfg = loadConfig({ env: { BOT_TOKEN: '1:test', ADMIN_IDS: String(ADMIN), ...TEST_FILES, ...env } });
  const storage = await openStorage(':memory:');
  const settings = new Settings(cfg, storage);
  const client = new MockClient();
  const notifier = { text: async () => {}, alert: async () => {} };
  const buyer = new Buyer({ cfg, settings, storage, client, notifier, walletFactory: async () => wallet || assert.fail('dry') });
  const engine = new Engine({ cfg, settings, storage, client, notifier, buyer });
  const bot = createBot({ cfg, settings, storage, client, engine, buyer, liveLibs }, { botInfo });
  const calls = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    let result = true;
    if (method === 'sendMessage') result = { message_id: calls.length, date: 0, chat: { id: payload.chat_id, type: 'private' }, text: payload.text };
    if (method === 'getUserGifts') result = { total_count: 7, gifts: mockProfileGifts() };
    return { ok: true, result };
  });
  let uid = 1;
  const user = (id) => ({ id, is_bot: false, first_name: 'U' });
  const nowSec = () => Math.floor(Date.now() / 1000);
  // `say`/`press` deliver one update like grammY's polling loop; by default they then wait for the
  // background work it started. `{wait: false}` returns as soon as the update handler returns.
  const say = async (text, from = ADMIN, { wait = true } = {}) => {
    const cmd = text.split(' ')[0];
    await bot.handleUpdate({
      update_id: uid++,
      message: { message_id: uid, date: nowSec(), chat: { id: from, type: 'private' }, from: user(from), text, entities: cmd.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: cmd.length }] : [] },
    });
    if (wait) await bot.idle();
    return calls.filter((c) => c.method === 'sendMessage').at(-1)?.payload.text;
  };
  const press = async (data, from = ADMIN, { date = nowSec(), wait = true } = {}) => {
    await bot.handleUpdate({
      update_id: uid++,
      callback_query: { id: String(uid), from: user(from), chat_instance: 'c', data, message: { message_id: 1, date, chat: { id: from, type: 'private' }, text: 'x' } },
    });
    if (wait) await bot.idle();
    return calls;
  };
  return { bot, calls, say, press, storage, settings, client, engine, buyer };
}

test('non-admins are rejected', async () => {
  const { say, storage } = await setup();
  assert.equal(await say('/watch EQCefrjhCD2_7HRIr2lmwt9ZaqeG_tdseBvADC66833kBS3y', 999), 'Not authorized.');
  assert.equal(storage.listWatch().length, 0);
});

test('status, watch, set, autobuy, dry commands', async () => {
  const { say, storage, settings } = await setup();
  assert.match(await say('/status'), /Mode:<\/b> 🧪 PRACTICE/);
  assert.match(await say(`/watch ${toFriendly(MOCK_GIFT_COLLECTION)}`), /Watching <b>Mock Plush Pepes<\/b> \(gift\)/);
  assert.match(await say('/watch Mock Plush'), /Watching/); // by gift name
  assert.equal(storage.listWatch().length, 1);
  assert.match(await say('/watchlist'), /Mock Plush Pepes/);
  assert.equal(await say('/set discount_pct 33'), 'discount_pct = 33');
  assert.equal(settings.get('discount_pct'), 33);
  assert.match(await say('/set max_price 999'), /hard limit/);
  assert.match(await say('/set'), /discount_pct/);
  assert.match(await say('/autobuy add * max=5 discount=30'), /Rule #1 added/);
  assert.match(await say('/autobuy list'), /#1 any: max 5 TON, discount ≥ 30%/);
  assert.match(await say('/autobuy on'), /Autobuy ON/);
  assert.equal(settings.autobuy, true);
  assert.match(await say('/autobuy del 1'), /deleted/);
  assert.match(await say('/dry off'), /WALLET_MNEMONIC/); // cannot go live without a wallet
  assert.equal(settings.dryRun, true);
  assert.equal(await say('/pause'), 'Paused.');
  assert.equal(settings.paused, true);
  assert.equal(await say('/resume'), 'Resumed.');
  assert.equal(await say('/buys'), 'No purchases yet.');
});

test('Buy button asks for confirmation, then runs the guarded buy path', async () => {
  const { press, storage, client, calls } = await setup();
  client.tick(1);
  const [listing] = await client.getListings(MOCK_GIFT_COLLECTION);
  const alertId = storage.saveAlert({ listing, reasons: [{ kind: 'below_floor', text: '' }], floorRefTon: 5, belowFloorPct: 20, valuation: null, discountPct: 50 });
  await press(`buy:${alertId}`);
  const confirm = calls.filter((c) => c.method === 'sendMessage').at(-1).payload;
  assert.match(confirm.text, /PRACTICE — paper buy <b>Mock Pepe #1<\/b>/);
  const data = confirm.reply_markup.inline_keyboard[0][0].callback_data;
  assert.match(data, new RegExp(`^buyc:${alertId}:p:\\d+$`));
  await press(data);
  assert.match(calls.filter((c) => c.method === 'sendMessage').at(-1).payload.text, /Result: dry/);
  assert.equal(storage.listBuys()[0].source, 'manual');
});

// ---- Comps receipt, pre-buy checklist, portfolio, scoreboard, go-live gate, /why, /panic ------
const lastSend = (calls) => calls.filter((c) => c.method === 'sendMessage').at(-1)?.payload;

async function alertFromCycle(t, name) {
  t.storage.watch(MOCK_GIFT_COLLECTION, { name: 'Mock Plush Pepes', isGift: true });
  await t.engine.cycle();
  const d = t.storage.decisionsSince(0).find((x) => x.kind === 'alert' && x.title === name);
  return d.alertId;
}

test('comps:<id> renders the used and ignored comps', async () => {
  const t = await setup();
  const id = await alertFromCycle(t, 'Mock Pepe #1');
  await t.press(`comps:${id}`);
  const text = lastSend(t.calls).text;
  assert.match(text, /<b>Why 8\.00 TON\?<\/b>/);
  assert.match(text, /Used \(8\):/);
  assert.match(text, /Ignored \(7\):<\/b> 6× round trip \(sold back to its previous owner within 30d\), 1× same wallet pair/);
  assert.match(text, /getgems\.io\/collection/);
});

test('buy: for a green item shows the checklist and a Confirm button; the lookalike has none', async () => {
  const t = await setup();
  const id = await alertFromCycle(t, 'Mock Pepe #1');
  await t.press(`buy:${id}`);
  const p = lastSend(t.calls);
  assert.match(p.text.split('\n')[0], /You pay <b>4\.10 TON all-in<\/b> → you receive <b>Mock Pepe #1<\/b>/);
  assert.match(p.text, /✅ Official Telegram gift collection/);
  assert.match(p.text, /✅ Price unchanged since alert/);
  assert.equal(p.reply_markup.inline_keyboard[0][0].text, 'Confirm buy');

  const f = await setup();
  f.storage.watch(MOCK_FAKE_COLLECTION, { name: 'Mock Plush Pepes' });
  await f.engine.cycle();
  const fakeId = f.storage.decisionsSince(0).find((x) => x.kind === 'alert').alertId;
  await f.press(`buy:${fakeId}`);
  const q = lastSend(f.calls);
  assert.match(q.text, /⛔ Looks like a Telegram gift, but this collection is not in Getgems' official gift list/);
  assert.ok(!q.reply_markup.inline_keyboard.flat().some((b) => b.callback_data?.startsWith('buyc:')));
});

test('/mygifts values profile gifts in one edited message; Watch adds collections; /forget clears', async () => {
  const t = await setup();
  await t.say('/mygifts');
  const ask = t.calls.find((c) => c.method === 'getUserGifts');
  assert.equal(ask.payload.user_id, ADMIN);
  assert.equal(ask.payload.exclude_unlimited, true);
  const edit = t.calls.filter((c) => c.method === 'editMessageText').at(-1).payload;
  assert.match(edit.text, /Your 6 collectible gifts: ~\d+ TON/);
  assert.match(edit.text, /Not on Getgems: Mystery Box/);
  assert.match(edit.text, /1 burned gift skipped/);
  assert.match(edit.text, /Only gifts visible on your profile are counted\./);
  const watchBtn = edit.reply_markup.inline_keyboard[0][0];
  assert.equal(watchBtn.text, 'Watch these collections');
  await t.press(watchBtn.callback_data);
  assert.deepEqual(t.storage.listWatch().map((w) => w.collection), [MOCK_GIFT_COLLECTION]);
  await t.press(edit.reply_markup.inline_keyboard[1][0].callback_data); // Alert me if any drops 20%
  await t.say('/mygifts mock-wallet.ton');
  const wallet = t.calls.filter((c) => c.method === 'editMessageText').at(-1).payload;
  assert.match(wallet.text, /33% under similar sales/);
  await t.press(wallet.reply_markup.inline_keyboard[1][0].callback_data); // Track daily
  assert.equal(t.storage.listPortfolioAddresses(ADMIN).length, 2);
  assert.match(await t.say('/forget'), /Deleted 2 stored addresses and 2 snapshots/);
  assert.equal(t.storage.listPortfolioAddresses(ADMIN).length, 0);
  assert.equal(t.storage.countSnapshots(ADMIN, 'profile'), 0);
});

test('/start offers the gifts button and the seed-phrase warning', async () => {
  const t = await setup();
  await t.say('/start');
  const p = lastSend(t.calls);
  assert.match(p.text, /never asks for your seed phrase/);
  assert.equal(p.reply_markup.inline_keyboard[0][0].callback_data, 'mygifts');
});

test('/scoreboard text and /dry off with readiness warning; GOLIVE_REQUIRE_PAPER refuses', async () => {
  const t = await setup({ env: { DRY_RUN: 'false', WALLET_MNEMONIC: 'x '.repeat(24).trim() } });
  t.storage.addRule({ collection: MOCK_GIFT_COLLECTION, maxPriceTon: 20, minDiscountPct: 40 });
  t.settings.setFlag('autobuy', true);
  await alertFromCycle(t, 'Mock Pepe #1');
  const sb = await t.say('/scoreboard');
  assert.match(sb, /📒 <b>Paper autopilot · 0 days<\/b>/);
  assert.match(sb, /Bought on paper: 2 for 19\.2 TON all-in/);
  assert.match(sb, /Blocked buys \d+: .*low price confidence 1/);
  const off = await t.say('/dry off');
  assert.match(off, /⚠️ Only 0 days \/ 2 paper buys: recommended 7 days, 3 buys/);
  const yes = lastSend(t.calls).reply_markup.inline_keyboard[0][0].callback_data;
  assert.match(yes, /^dryoff:yes:\d+$/);
  await t.press(yes);
  assert.equal(t.settings.dryRun, false);
  assert.match(lastSend(t.calls).text, /Ramp: 25% budget until \d\d:\d\d/);
  assert.match(await t.say('/status'), /Ramp:<\/b> 25% budget until/);

  const strict = await setup({ env: { DRY_RUN: 'false', WALLET_MNEMONIC: 'x', GOLIVE_REQUIRE_PAPER: 'true' } });
  assert.match(await strict.say('/dry off'), /Cannot go live:[\s\S]*GOLIVE_REQUIRE_PAPER=true/);
  assert.equal(strict.settings.dryRun, true);
});

test('/why explains a skip; /panic cancels pending confirmations and /resume needs a confirm', async () => {
  const t = await setup();
  t.storage.addRule({ collection: MOCK_GIFT_COLLECTION, maxPriceTon: 20, minDiscountPct: 40 });
  t.settings.setFlag('autobuy', true);
  const neon = await alertFromCycle(t, 'Mock Pepe #2');
  const why = await t.say(`/why ${neon}`);
  assert.match(why, /SKIP — Not bought: price confidence C is below the autobuy minimum B/);
  assert.doesNotMatch(why, /confidence_low|LOW_CONFIDENCE/); // no internal codes in the owner's text
  assert.match(why, /Result:<\/b> Not bought/);
  assert.match(await t.say('/panic'), /PANIC/);
  assert.equal(t.settings.dryRun, true);
  await t.press(`buyc:${neon}`);
  assert.match(lastSend(t.calls).text, /cancelled by \/panic/);
  await t.say('/resume');
  const resume = lastSend(t.calls).reply_markup.inline_keyboard[0][0].callback_data;
  assert.match(resume, /^resume:yes:\d+$/);
  assert.equal(t.settings.panic, true);
  await t.press(resume);
  assert.equal(t.settings.panic, false);
  assert.match(await t.say('/safety'), /Panic:<\/b> off/);
  assert.match(await t.say('/doctor'), /PASS  database/);
});

// ---- Stale confirmations and /panic while a confirmed buy runs ------------------------------
const liveWallet = (opts = {}) => {
  const w = {
    sent: [],
    address: 'UQx',
    balanceNano: async () => {
      w.atBalance?.();
      if (opts.gate) await opts.gate;
      return tonToNano(100);
    },
    send: async (m) => (w.sent.push(m), { seqno: 1, confirmed: true }),
  };
  return w;
};
const LIVE_ENV = { DRY_RUN: 'false', WALLET_MNEMONIC: 'x', CONFIRM_ABOVE: '100', LIVE_RAMP_HOURS: '0' };
async function mockAlert(t) {
  t.client.tick(1);
  const [listing] = await t.client.getListings(MOCK_GIFT_COLLECTION);
  return t.storage.saveAlert({ listing, reasons: [{ kind: 'below_floor', text: '' }], floorRefTon: 5, belowFloorPct: 20, valuation: null, discountPct: 50 });
}
const firstButton = (t) => lastSend(t.calls).reply_markup.inline_keyboard[0][0].callback_data;

test('a Confirm shown in practice mode never executes after /dry off; old and expired confirms are refused', async () => {
  const wallet = liveWallet();
  const t = await setup({ env: LIVE_ENV, wallet });
  const alertId = await mockAlert(t);
  await t.press(`buy:${alertId}`);
  assert.match(lastSend(t.calls).text, /🧪 PRACTICE — paper buy <b>Mock Pepe #1<\/b>/);
  const practiceConfirm = firstButton(t);
  await t.say('/dry off');
  await t.press(firstButton(t)); // Yes, spend real TON
  assert.equal(t.settings.mode, 'live');
  await t.press(practiceConfirm);
  assert.match(lastSend(t.calls).text, /cancelled by \/panic or a mode change \(it was shown in PRACTICE mode\)/);
  // Same epoch but a practice-mode button (e.g. after an .env change and restart): refused too.
  await t.press(`buyc:${alertId}:p:${t.settings.confirmEpoch()}`);
  assert.match(lastSend(t.calls).text, /shown in PRACTICE mode; the bot is LIVE now/);
  await t.press(`buyc:${alertId}`);
  assert.match(lastSend(t.calls).text, /older version of the bot/);
  await t.press(`buyc:${alertId}:l:${t.settings.confirmEpoch()}`, ADMIN, { date: Math.floor(Date.now() / 1000) - 3600 });
  assert.match(lastSend(t.calls).text, /older than 15 minutes/);
  assert.equal(wallet.sent.length, 0);
  assert.equal(t.storage.listBuys().length, 0);
  // A fresh live preview does go through.
  await t.press(`buy:${alertId}`);
  assert.match(lastSend(t.calls).text, /💸 LIVE — buy/);
  await t.press(firstButton(t));
  assert.match(lastSend(t.calls).text, /Result: sent/);
  assert.equal(wallet.sent.length, 1);
});

test('/panic voids an unanswered "Yes, spend real TON", even after /resume', async () => {
  const t = await setup({ env: LIVE_ENV });
  await t.say('/dry off');
  const yes = firstButton(t);
  await t.say('/panic');
  await t.say('/resume');
  const resume = firstButton(t);
  await t.press(resume);
  assert.equal(t.settings.panic, false);
  assert.equal(t.settings.mode, 'practice');
  await t.press(yes);
  assert.match(lastSend(t.calls).text, /cancelled by \/panic or a mode change\. Send \/dry off again/);
  assert.equal(t.settings.mode, 'practice');
  // The resume button cannot clear a later /panic either.
  await t.say('/panic');
  await t.press(resume);
  assert.equal(t.settings.panic, true);
  // A fresh /dry off after /resume works.
  await t.say('/resume');
  await t.press(firstButton(t));
  await t.say('/dry off');
  await t.press(firstButton(t));
  assert.equal(t.settings.mode, 'live');
});

test('/panic is handled while a confirmed live buy waits on the wallet, and nothing is sent', async () => {
  let open;
  const gate = new Promise((r) => (open = r));
  const wallet = liveWallet({ gate });
  const reached = new Promise((r) => (wallet.atBalance = r));
  const t = await setup({ env: LIVE_ENV, wallet });
  t.settings.confirmLive();
  const alertId = await mockAlert(t);
  await t.press(`buy:${alertId}`);
  const confirm = firstButton(t);
  assert.match(confirm, /^buyc:\d+:l:\d+$/);
  // Like grammY's polling loop: the Confirm update handler returns while the buy is still running.
  await t.press(confirm, ADMIN, { wait: false });
  await reached;
  assert.equal(wallet.sent.length, 0);
  await t.say('/panic', ADMIN, { wait: false });
  assert.equal(t.settings.panic, true);
  open();
  await t.bot.idle();
  assert.equal(wallet.sent.length, 0);
  const row = t.storage.listBuys()[0];
  assert.equal(row.status, 'blocked');
  assert.equal(row.reasonCode, 'panic');
  assert.match(lastSend(t.calls).text, /Result: blocked — \/panic was pressed/);
});

// ---- Release check: onboarding, expiring go-live/resume buttons, wallet packages ------------
test('/start says which mode the bot is in and names three commands to try first; /help lists them all', async () => {
  const t = await setup({ env: LIVE_ENV });
  const start = await t.say('/start');
  assert.match(start, /Mode: <b>PRACTICE<\/b>\. Buys are on paper; no TON is spent\./);
  assert.match(start, /Try these first:<\/b>\n1\. \/mygifts[^\n]*\n2\. \/watch[^\n]*\n3\. \/scoreboard/);
  assert.ok(start.split('\n').length <= 13, 'short, not a command dump');
  const help = await t.say('/help');
  assert.match(help, /\[edgepct=&lt;pct&gt;\] \[eta=&lt;days&gt;\] \[bid=1\] \[cross=0\]/);
  t.settings.confirmLive();
  assert.match(await t.say('/start'), /Mode: <b>LIVE<\/b>\. Buys spend real TON/);
  assert.match(await t.say('/status'), /Alerts:<\/b> ≥ 15% below floor; undervalued ≥ 25% \(price-cap alert off\)/); // CHEAP_MAX_PRICE_TON=0
});

test('"Yes, spend real TON" and "Yes, resume" expire after 15 minutes', async () => {
  const t = await setup({ env: LIVE_ENV });
  await t.say('/dry off');
  const old = Math.floor(Date.now() / 1000) - 16 * 60;
  await t.press(firstButton(t), ADMIN, { date: old });
  assert.match(lastSend(t.calls).text, /older than 15 minutes\. Send \/dry off again/);
  assert.equal(t.settings.mode, 'practice');
  await t.say('/panic');
  await t.say('/resume');
  await t.press(firstButton(t), ADMIN, { date: old });
  assert.match(lastSend(t.calls).text, /older than 15 minutes\. Send \/resume again/);
  assert.equal(t.settings.panic, true);
});

test('/dry off refuses live mode when the wallet packages are not installed', async () => {
  const t = await setup({ env: LIVE_ENV, liveLibs: () => false });
  assert.match(await t.say('/dry off'), /Cannot go live:[\s\S]*@ton\/ton, @ton\/core and @ton\/crypto are not installed[\s\S]*npm install @ton\/ton/);
  assert.equal(t.settings.mode, 'practice');
});
