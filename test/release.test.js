// Regression tests for the v0.1.0 release check: live gate, auto-pause, free /mygifts, doctor,
// honest receipts, plain wording and the offline mock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStorage } from '../src/storage.js';
import { Settings } from '../src/settings.js';
import { loadConfig } from '../src/config.js';
import { Buyer, interruption } from '../src/autobuy.js';
import { Engine, buildDigest, scoreboardFromStorage } from '../src/engine.js';
import { tonToNano } from '../src/models.js';
import { setAutoPause, clearAutoPause, runDoctor, formatDoctor } from '../src/safety.js';
import { MockClient, MOCK_GIFT_COLLECTION, MOCK_PUNK_COLLECTION } from '../src/clients/mock.js';
import { TonapiClient } from '../src/clients/tonapi.js';
import { PortfolioService, MockGiftsSource } from '../src/holdings.js';
import { estimateFairValue } from '../src/valuation.js';
import { formatPortfolio } from '../src/portfolio.js';
import { formatScoreboard, readiness } from '../src/paper.js';
import { reasonText, blockLabel } from '../src/explain.js';
import { htmlToText } from '../src/format.js';

const DAY = 86_400_000;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-release-test-'));
const FILES = { FLOORS_FILE: path.join(TMP, 'floors.json'), EVENTS_FILE: '' };
const C = '0:' + '11'.repeat(32);
const SALE = '0:' + '5a'.repeat(32);
const listing = (priceTon, nft = '0:' + 'ee'.repeat(32)) => ({
  nft, collection: C, name: `NFT ${priceTon}`, attrs: {}, priceNano: tonToNano(priceTon).toString(), priceTon,
  saleContract: SALE, saleVersion: 'v1', contractType: 'sale-contract', seller: null, market: 'getgems', source: 'mock',
});

function liveBuyer(cfg, storage, settings) {
  const sends = [];
  const wallet = { address: 'UQfake', balanceNano: async () => tonToNano(1000), send: async (m) => (sends.push(m), { seqno: 1, confirmed: true }) };
  const client = {
    name: 'fake',
    refreshListing: async (l) => l,
    getBuyTransaction: async (l) => ({ uuid: 'u', messages: [{ to: l.saleContract, amountNano: (BigInt(l.priceNano) + tonToNano('0.2')).toString() }] }),
  };
  const buyer = new Buyer({ cfg, settings, storage, client, notifier: { text: async () => {}, alert: async () => {} }, walletFactory: async () => wallet });
  return { buyer, sends };
}

test('DRY_RUN=true voids a stored live confirmation: unlocking .env later needs /dry off again and restarts the ramp', async () => {
  const storage = await openStorage(':memory:');
  const live = { DRY_RUN: 'false', WALLET_MNEMONIC: 'x', DAILY_BUDGET_TON: '50', LIVE_RAMP_HOURS: '24', LIVE_RAMP_BUDGET_PCT: '25' };
  new Settings(loadConfig({ env: live }), storage).confirmLive(Date.now() - 10 * DAY);
  const locked = new Settings(loadConfig({ env: { DRY_RUN: 'true' } }), storage);
  assert.equal(locked.mode, 'practice');
  assert.equal(locked.voidedLive, true);
  const cfg = loadConfig({ env: live });
  const unlocked = new Settings(cfg, storage);
  assert.equal(unlocked.voidedLive, false);
  assert.equal(unlocked.mode, 'practice'); // no live mode without a fresh /dry off
  assert.equal(unlocked.liveSince(), null);
  const { buyer, sends } = liveBuyer(cfg, storage, unlocked);
  assert.equal((await buyer.buy(listing(5), { source: 'manual' })).status, 'dry');
  assert.equal(sends.length, 0);
  unlocked.confirmLive();
  assert.equal(unlocked.ramp().active, true); // the go-live ramp starts again
  assert.equal(unlocked.limits().dailyBudgetTon, 12.5);
});

test('auto-pause blocks the manual Confirm buy too; the pre-buy checklist shows it with no Confirm', async () => {
  const cfg = loadConfig({ env: { DRY_RUN: 'false', WALLET_MNEMONIC: 'x', LIVE_RAMP_HOURS: '0', CONFIRM_ABOVE: '100' } });
  const storage = await openStorage(':memory:');
  const settings = new Settings(cfg, storage);
  settings.confirmLive();
  const { buyer, sends } = liveBuyer(cfg, storage, settings);
  setAutoPause(storage, { code: 'balance', reason: "wallet dropped 40 TON beyond the bot's own buys" });
  const pv = await buyer.preview(listing(5), { source: 'manual' });
  assert.equal(pv.canConfirm, false);
  assert.ok(pv.checks.some((c) => c.id === 'auto_pause' && c.status === 'bad'));
  const r = await buyer.buy(listing(5), { source: 'manual', alertId: 1 });
  assert.equal(r.status, 'blocked');
  assert.equal(r.code, 'auto_paused');
  assert.equal(sends.length, 0);
  assert.equal(interruption(settings, 'live').code, 'auto_paused'); // also re-checked right before signing
  clearAutoPause(storage);
  assert.equal((await buyer.buy(listing(5, '0:' + 'ab'.repeat(32)), { source: 'manual' })).status, 'sent');
  assert.equal(sends.length, 1);
});

async function profileService(client) {
  const cfg = loadConfig({ env: FILES });
  const storage = await openStorage(':memory:');
  const settings = new Settings(cfg, storage);
  const engine = new Engine({ cfg, settings, storage, client, notifier: { text: async () => {} }, buyer: null });
  return new PortfolioService({ cfg, settings, storage, client, engine, offers: null, giftsSource: new MockGiftsSource() });
}

test('/mygifts on the free source: gift collections are looked up by name when the source has no list', async () => {
  const client = new MockClient();
  const looked = [];
  client.listGiftCollections = async () => []; // TonAPI has no gift collection list
  client.findGiftCollections = async (names) => (looked.push(...names), names.includes('Mock Plush Pepe') ? [{ address: MOCK_GIFT_COLLECTION, name: 'Mock Plush Pepes' }] : []);
  const r = await (await profileService(client)).profile(1);
  const text = htmlToText(r.text);
  assert.match(text, /Your 6 collectible gifts: ~8\d TON/);
  assert.match(text, /Not on Getgems: Mystery Box #1 \(Crate\)$/m);
  assert.doesNotMatch(text, /Not on Getgems: .*Mock Plush Pepe/);
  assert.deepEqual([...new Set(looked)].sort(), ['Mock Plush Pepe', 'Mystery Box']);
});

function fakeFetch(handler) {
  const calls = [];
  const f = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const { status = 200, body } = handler(u);
    return new Response(JSON.stringify(body), { status });
  };
  f.calls = calls;
  return f;
}

test('TonapiClient.findGiftCollections keeps only whitelisted Telegram collections, skips lookalikes, caches', async () => {
  const REAL = '0:46fa0e9a864014196a5e7d66f1f83ffdb10f2859bbf2ea9baeabbf14d9ce0d50';
  const FAKE = '0:' + '9a'.repeat(32);
  const JETTON = '0:' + '3a'.repeat(32);
  const GONE = '0:' + '4b'.repeat(32);
  const fetchImpl = fakeFetch((u) => {
    if (u.pathname.endsWith('/accounts/search')) {
      assert.ok(u.searchParams.get('name').length <= 15); // TonAPI rejects longer queries
      return {
        body: {
          addresses: [
            { address: JETTON, name: 'PlushPepe · jetton', trust: 'whitelist' }, // whitelisted, but a jetton
            { address: GONE, name: 'Plush Pepe · account', trust: 'whitelist' }, // not an NFT collection: 404
            { address: REAL, name: 'Plush Pepes · account', trust: 'whitelist' },
            { address: FAKE, name: 'Plush Pepes · collection', trust: 'none' }, // lookalike
          ],
        },
      };
    }
    if (u.pathname.endsWith(GONE)) return { status: 404, body: { error: 'entity not found' } };
    const telegram = u.pathname.endsWith(REAL);
    return { body: { metadata: { name: telegram ? 'Plush Pepes' : 'PlushPepe', description: telegram ? 'Plush Pepes is an exclusive NFT collection by Telegram.' : 'a token' } } };
  });
  const c = new TonapiClient({ baseUrl: 'https://tonapi.io/v2', fetchImpl, minIntervalMs: 0, apiKey: 'k' });
  assert.deepEqual(await c.findGiftCollections(['Plush Pepe']), [{ address: REAL, name: 'Plush Pepes' }]);
  assert.ok(!fetchImpl.calls.some((u) => u.pathname.endsWith(FAKE) || u.pathname.endsWith(JETTON)), 'lookalikes and jettons are never even checked');
  const n = fetchImpl.calls.length;
  await c.findGiftCollections(['Plush Pepe', 'plush pepe']);
  assert.equal(fetchImpl.calls.length, n); // cached
  assert.deepEqual(await c.findGiftCollections(['Jack-in-the-Box Deluxe']), []); // long name: query cut to 15 characters
});

test('doctor checks Telegram like `run` does: missing ADMIN_IDS and a rejected token FAIL', async () => {
  const storage = await openStorage(':memory:');
  const client = { name: 'tonapi', listGiftCollections: async () => [] };
  const doctor = async (env, telegram) => {
    const cfg = loadConfig({ env });
    return formatDoctor(await runDoctor({ cfg, settings: new Settings(cfg, storage), storage, client, telegram }));
  };
  const noAdmins = await doctor({ BOT_TOKEN: '123:abc' }, { getMe: async () => ({ username: 'b' }) });
  assert.equal(noAdmins.exitCode, 1);
  assert.match(noAdmins.text, /FAIL\s+telegram\s+BOT_TOKEN is set but ADMIN_IDS is empty/);
  const rejected = await doctor({ BOT_TOKEN: '123:abc', ADMIN_IDS: '1' }, { getMe: async () => { throw Object.assign(new Error('401'), { error_code: 401, description: 'Unauthorized' }); } });
  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.text, /BOT_TOKEN was rejected by Telegram \(Unauthorized\)\n\s+fix: copy the token again from @BotFather/);
  const ok = await doctor({ BOT_TOKEN: '123:abc', ADMIN_IDS: '1' }, { getMe: async () => ({ username: 'my_bot' }) });
  assert.match(ok.text, /PASS\s+telegram\s+bot @my_bot · 1 admin ID/);
  assert.doesNotMatch(ok.text, /optional keys.*BOT_TOKEN/);
});

test('doctor and /dry off need the optional wallet packages for live mode', async () => {
  const storage = await openStorage(':memory:');
  const cfg = loadConfig({ env: { DRY_RUN: 'false', WALLET_MNEMONIC: 'x' } });
  const settings = new Settings(cfg, storage);
  const client = new MockClient();
  const missing = await runDoctor({ cfg, settings, storage, client, liveLibs: () => false });
  assert.deepEqual(missing.find((x) => x.item === 'wallet').status, 'WARN'); // practice: live not confirmed yet
  assert.match(missing.find((x) => x.item === 'wallet').hint, /npm install @ton\/ton/);
  settings.confirmLive();
  const live = await runDoctor({ cfg, settings, storage, client, liveLibs: () => false });
  assert.equal(live.find((x) => x.item === 'wallet').status, 'FAIL');
  assert.equal((await runDoctor({ cfg, settings, storage, client, liveLibs: () => true })).find((x) => x.item === 'wallet').status, 'PASS');
  const { goLiveCheck } = await import('../src/bot.js');
  settings.setPractice();
  const g = goLiveCheck({ cfg, settings, storage, liveLibs: () => false });
  assert.equal(g.ok, false);
  assert.match(g.blockers.join('\n'), /@ton\/ton, @ton\/core and @ton\/crypto are not installed/);
});

test('"ignored" counts only wash sales of the level the price uses, not the whole collection', () => {
  const now = Date.UTC(2026, 9, 28);
  const P = { now, lookbackDays: 30, maxComparables: 20, minComparables: 3, timeWeighted: false, halfLifeDays: 7, levels: ['model', 'collection'] };
  const s = (nft, model, price, d, from, to, extra = {}) => ({ nft, priceTon: price, timeMs: now - d * DAY, attrs: { model, backdrop: 'B', symbol: 'S' }, oldOwner: from, newOwner: to, ...extra });
  const sales = [
    s('b1', 'Bronze', 8, 1, 'a', 'b'), s('b2', 'Bronze', 8, 2, 'c', 'd'), s('b3', 'Bronze', 8, 3, 'e', 'f'),
    // Gold wash: a round trip and a flagged sale. They never touch a Bronze price.
    s('g1', 'Gold', 14, 4, 'w1', 'w2'), s('g1', 'Gold', 14.5, 5, 'w2', 'w1'), s('g2', 'Gold', 60, 6, 'x', 'y', { rejectTop: true }),
  ];
  const bronze = estimateFairValue({ attrs: { model: 'Bronze', backdrop: 'B', symbol: 'S' } }, sales, P);
  assert.equal(bronze.fairValueTon, 8);
  assert.deepEqual(bronze.excluded, { round_trip: 0, same_wallet_pair: 0, flagged_by_getgems: 0, outlier: 0 });
  assert.equal(bronze.excludedSamples.length, 0);
  const gold = estimateFairValue({ attrs: { model: 'Gold', backdrop: 'B', symbol: 'S' } }, [...sales, s('g3', 'Gold', 40, 1, 'k', 'l'), s('g4', 'Gold', 41, 1, 'm', 'n'), s('g5', 'Gold', 42, 1, 'o', 'p')], P);
  assert.equal(gold.excluded.round_trip, 2);
});

test('the /mygifts card lists every valued gift, so the total adds up', () => {
  const item = (title, fairTon, confidence = 'B') => ({ title, fairTon, lowTon: fairTon, highTon: fairTon, confidence, liquidity: { badge: 'normal' } });
  const items = [item('A', 40), item('B', 15), item('C', 10), item('D', 8), item('E', 7)];
  const r = { count: 5, totalTon: 80, totalLowTon: 80, totalHighTon: 80, items, unmatched: [], skipped: { burned: 0 } };
  const text = htmlToText(formatPortfolio(r));
  assert.match(text, /…and 2 more \(~15\.00 TON\): D, E/);
});

test('plain wording: plural templates, block labels, scoreboard and digest agree on buys and blocks', async () => {
  assert.equal(reasonText('WASHY_COMPS', { n: 1 }), '1 wash or flagged sale was left out of the price');
  assert.equal(reasonText('WASHY_COMPS', { n: 7 }), '7 wash or flagged sales were left out of the price');
  assert.equal(blockLabel('risk_red:fragment_ban'), 'failed a safety check');
  assert.equal(blockLabel('rate'), 'hourly buy cap reached');
  assert.equal(readiness({ days: 1, paper: { n: 1 } }, { paperMinDays: 7, paperMinBuys: 3 }).text, '⚠️ Only 1 day / 1 paper buy: recommended 7 days, 3 buys');
  // Two mock cycles: one paper buy lost its race; digest and scoreboard must say the same.
  const cfg = loadConfig({ env: { ...FILES, MAX_BUYS_PER_HOUR: '2' } });
  const storage = await openStorage(':memory:');
  const settings = new Settings(cfg, storage);
  settings.setFlag('autobuy', true);
  const client = new MockClient();
  const notifier = { alert: async () => {}, text: async () => {} };
  const buyer = new Buyer({ cfg, settings, storage, client, notifier, walletFactory: async () => assert.fail('no wallet') });
  const engine = new Engine({ cfg, settings, storage, client, notifier, buyer });
  storage.watch(MOCK_PUNK_COLLECTION, { name: 'Mock Punks' });
  storage.watch(MOCK_GIFT_COLLECTION, { name: 'Mock Plush Pepes', isGift: true });
  storage.addRule({ collection: MOCK_GIFT_COLLECTION, maxPriceTon: 20, minDiscountPct: 40 });
  storage.addRule({ collection: '*', maxPriceTon: 10, minDiscountPct: 50 });
  await engine.cycle();
  await engine.cycle();
  const sb = scoreboardFromStorage(storage);
  const board = htmlToText(formatScoreboard(sb));
  const digest = htmlToText(buildDigest({ storage, settings, cfg }).text);
  const blocked = Number(/Blocked buys (\d+)/.exec(board)[1]);
  assert.match(board, new RegExp(`Bought on paper: ${sb.paper.n} `));
  assert.match(digest, new RegExp(`paper buys ${sb.paper.n}( \\(\\+${sb.paper.lostRaces} lost to faster buyers, not counted\\))?`));
  assert.match(digest, new RegExp(`blocked buys ${blocked}\\b`));
  for (const text of [board, digest]) assert.doesNotMatch(text, /risk_red|RISK_RED|confidence_low|LIMIT_HOURLY|Suite:|realized/);
});

// ---- CLI ------------------------------------------------------------------------------------
const INDEX = fileURLToPath(new URL('../src/index.js', import.meta.url));
const cli = (args, env = {}) =>
  spawnSync(process.execPath, ['--no-warnings', INDEX, ...args], { cwd: TMP, env: { PATH: process.env.PATH, HOME: TMP, ALLOW_UNSUPPORTED_OS: '1', ...env }, encoding: 'utf8', timeout: 60_000 });

test('mock stays offline even with BOT_TOKEN and ADMIN_IDS set: cards print here, nothing goes to Telegram', () => {
  const r = cli(['mock', '--cycles', '1'], { BOT_TOKEN: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', ADMIN_IDS: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PRACTICE · BUY · Mock Pepe #1/);
  assert.match(r.stdout, /sends nothing to Telegram/);
  assert.doesNotMatch(r.stdout + r.stderr, /sendMessage|\[notify\]/);
});

test('CLI messages: --cycles errors agree, gifts without a key names the real reason', () => {
  for (const v of ['abc', '0']) {
    const r = cli(['mock', '--cycles', v]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--cycles must be a positive integer/);
  }
  const g = cli(['gifts']);
  assert.equal(g.status, 2);
  assert.match(g.stderr, /gifts command needs GETGEMS_API_KEY/);
  assert.doesNotMatch(g.stderr, /DATA_SOURCE=getgems/);
});
