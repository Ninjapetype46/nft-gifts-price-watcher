import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAddress, toRaw, toFriendly, isAddress, sameAddress } from '../src/address.js';
import { nanoToTon, tonToNano, normalizeAttrs, looksLikeGift, mask } from '../src/models.js';
import { openStorage } from '../src/storage.js';
import { Settings } from '../src/settings.js';
import { loadConfig, requireKeys, ConfigError } from '../src/config.js';
import { parseAutobuyAdd, resolveCollection } from '../src/commands.js';

// Vectors from TonAPI /v2/address/{raw}/parse (live, 2026-10-28).
const RAW = '0:9e7eb8e1083dbfec7448af6966c2df596aa786fed76c781bc00c2ebaf37de405';
const BOUNCE = 'EQCefrjhCD2_7HRIr2lmwt9ZaqeG_tdseBvADC66833kBS3y';
const NONBOUNCE = 'UQCefrjhCD2_7HRIr2lmwt9ZaqeG_tdseBvADC66833kBXA3';

test('address conversions match TonAPI', () => {
  assert.equal(toFriendly(RAW), BOUNCE);
  assert.equal(toFriendly(RAW, { bounceable: false }), NONBOUNCE);
  assert.equal(toRaw(BOUNCE), RAW);
  assert.equal(toRaw(NONBOUNCE), RAW);
  assert.equal(toRaw('EQCefrjhCD2/7HRIr2lmwt9ZaqeG/tdseBvADC66833kBS3y'), RAW); // standard base64
  assert.equal(toFriendly('0:010f80b8a5f8c9923efdb1f500053ec91cf4757bcd081393833d74ab09f438ca'), 'EQABD4C4pfjJkj79sfUABT7JHPR1e80IE5ODPXSrCfQ4yiOe');
  assert.equal(parseAddress(NONBOUNCE).bounceable, false);
  assert.ok(sameAddress(BOUNCE, NONBOUNCE));
  assert.ok(!isAddress('EQCefrjhCD2_7HRIr2lmwt9ZaqeG_tdseBvADC66833kBS3z')); // bad crc
  assert.ok(!isAddress('hello'));
  assert.equal(toRaw('-1:' + 'AB'.repeat(32)), '-1:' + 'ab'.repeat(32));
  assert.equal(toRaw(toFriendly('-1:' + 'ab'.repeat(32))), '-1:' + 'ab'.repeat(32));
});

test('nano/TON conversions are exact', () => {
  assert.equal(tonToNano('6.5'), 6_500_000_000n);
  assert.equal(tonToNano(0.3), 300_000_000n);
  assert.equal(tonToNano('1.0000000001'), 1_000_000_000n);
  assert.equal(nanoToTon('50000000000'), 50);
  assert.equal(nanoToTon(1n), 1e-9);
  assert.throws(() => tonToNano('-1'));
});

test('attribute normalization and gift detection', () => {
  const a = normalizeAttrs([{ trait_type: 'Model', value: 'Gold' }, { traitType: 'Backdrop', value: 'Black' }, { traitType: 'Symbol', value: 'Star' }, { value: 'x' }]);
  assert.deepEqual(a, { model: 'Gold', backdrop: 'Black', symbol: 'Star' });
  assert.ok(looksLikeGift(a));
  assert.ok(!looksLikeGift({ type: 'Ape' }));
  assert.equal(mask('word1 word2 word3 secret'), 'word…(24)');
});

test('config validation and clear missing-key errors', () => {
  const cfg = loadConfig({ env: { ADMIN_IDS: '1, 2', DRY_RUN: 'false' } });
  assert.deepEqual(cfg.adminIds, [1, 2]);
  assert.deepEqual(cfg.alertChatIds, [1, 2]);
  assert.equal(cfg.dryRun, false);
  assert.equal(loadConfig({ env: {} }).dryRun, true); // safe default
  assert.throws(() => loadConfig({ env: { ADMIN_IDS: 'abc' } }), ConfigError);
  assert.throws(() => loadConfig({ env: { MAX_PRICE_TON: 'lots' } }), /MAX_PRICE_TON/);
  assert.throws(() => requireKeys(cfg, ['GETGEMS_API_KEY', 'WALLET_MNEMONIC']), /GETGEMS_API_KEY[\s\S]*WALLET_MNEMONIC/);
});

test('storage: watchlist, rules, alert dedup, sales with attributes', async () => {
  const s = await openStorage(':memory:');
  s.watch('0:a', { name: 'A' });
  s.watch('0:a', { isGift: true });
  assert.deepEqual(s.listWatch().map((w) => [w.collection, w.name, w.isGift]), [['0:a', 'A', true]]);
  assert.ok(s.unwatch('0:a'));
  assert.ok(!s.unwatch('0:a'));

  const id = s.addRule({ collection: '*', maxPriceTon: 5, minDiscountPct: 30 });
  assert.equal(s.listRules()[0].id, id);
  assert.ok(s.deleteRule(id));

  const alert = { listing: { nft: 'n1', collection: 'c', priceNano: '1000' }, reasons: [{ kind: 'below_floor', text: '' }] };
  const aid = s.saveAlert(alert);
  assert.ok(s.wasAlerted('n1', '1000', Date.now() - 1000));
  assert.ok(!s.wasAlerted('n1', '999', 0));
  assert.equal(s.getAlert(aid).listing.nft, 'n1');

  assert.equal(s.upsertSales([{ txHash: 't1', collection: 'c', nft: 'n1', priceTon: 3, timeMs: 1000 }, { txHash: 't1', collection: 'c', nft: 'n1', priceTon: 3, timeMs: 1000 }]), 1);
  assert.deepEqual(s.nftsMissingAttrs('c', 0), ['n1']);
  s.upsertAttrs([{ nft: 'n1', collection: 'c', attrs: { model: 'Gold' } }]);
  assert.deepEqual(s.getSales('c', 0)[0].attrs, { model: 'Gold' });
  assert.equal(s.latestSaleTime('c'), 1000);
  s.close();
});

test('settings: overrides, defaults and hard ceilings', async () => {
  // DRY_RUN=false in .env so the stored flag may switch modes (DRY_RUN=true is a hard lock).
  const cfg = loadConfig({ env: { MAX_PRICE_TON: '20', UNDERVALUED_DISCOUNT_PCT: '25', DRY_RUN: 'false' } });
  const st = new Settings(cfg, await openStorage(':memory:'));
  assert.equal(st.get('discount_pct'), 25);
  assert.equal(st.set('discount_pct', '40').ok, true);
  assert.equal(st.get('discount_pct'), 40);
  assert.equal(st.set('discount_pct', 'default').value, 25);
  assert.equal(st.set('max_price', '10').ok, true);
  assert.match(st.set('max_price', '50').error, /hard limit/);
  assert.equal(st.set('time_weighted', 'off').value, false);
  assert.equal(st.set('nope', '1').ok, false);
  assert.equal(st.dryRun, true);
  st.setFlag('dry_run', false);
  assert.equal(st.dryRun, false);
});

test('parseAutobuyAdd', () => {
  assert.deepEqual(parseAutobuyAdd(['EQabc', 'max=12.5', 'discount=30%']), { ok: true, collection: 'EQabc', maxPriceTon: 12.5, minDiscountPct: 30 });
  assert.deepEqual(parseAutobuyAdd(['*', 'max=5']), { ok: true, collection: '*', maxPriceTon: 5, minDiscountPct: 0 });
  assert.equal(parseAutobuyAdd(['max=5']).ok, false);
  assert.equal(parseAutobuyAdd(['x', 'max=0']).ok, false);
  assert.equal(parseAutobuyAdd(['x', 'max=1', 'discount=100']).ok, false);
});

test('resolveCollection by address or gift name', async () => {
  const client = { listGiftCollections: async () => [{ address: RAW, name: 'Homemade Cakes' }, { address: '0:' + '1'.repeat(64), name: 'Plush Pepes' }, { address: '0:' + '2'.repeat(64), name: 'Plush Pepes Deluxe' }] };
  assert.equal((await resolveCollection(BOUNCE, client)).collection, RAW);
  assert.equal((await resolveCollection('homemade cake', client)).collection, RAW);
  assert.equal((await resolveCollection('Plush Pepes', client)).collection, '0:' + '1'.repeat(64));
  assert.match((await resolveCollection('plush', client)).error, /Ambiguous/);
  assert.match((await resolveCollection('nothing', client)).error, /Unknown/);
});

test('parseAutobuyAdd: edge=, edgepct=, eta= and bid=1 options', () => {
  assert.deepEqual(parseAutobuyAdd(['*', 'max=10', 'discount=30', 'edge=1.5', 'eta=7', 'bid=1']), {
    ok: true,
    collection: '*',
    maxPriceTon: 10,
    minDiscountPct: 30,
    minEdgeTon: 1.5,
    maxEtaDays: 7,
    requireBid: true,
  });
  assert.equal(parseAutobuyAdd(['*', 'max=10', 'edgepct=12', 'cross=0']).minEdgePct, 12);
  assert.equal(parseAutobuyAdd(['*', 'max=10', 'cross=0']).crossCheck, false);
  assert.equal(parseAutobuyAdd(['*', 'max=10', 'eta=0']).ok, false);
  assert.equal(parseAutobuyAdd(['*', 'max=10', 'bid=yes']).ok, false);
  assert.equal(parseAutobuyAdd(['*', 'max=10', 'edge=lots']).ok, false);
});

test('storage: an old-schema database upgrades in place with no data loss', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { Storage } = await import('../src/storage.js');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sales (tx_hash TEXT PRIMARY KEY, collection TEXT NOT NULL, nft TEXT NOT NULL, name TEXT, price_ton REAL NOT NULL, time_ms INTEGER NOT NULL);
    CREATE TABLE autobuy_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, max_price_ton REAL NOT NULL,
      min_discount_pct REAL NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);`);
  db.prepare("INSERT INTO sales VALUES('t1', 'c', 'n1', 'Old', 7, 1000)").run();
  db.prepare("INSERT INTO autobuy_rules(collection, max_price_ton, min_discount_pct, created_at) VALUES('*', 5, 30, 1)").run();
  const s = new Storage(db);
  const cols = db.prepare('PRAGMA table_info(sales)').all().map((r) => r.name);
  assert.ok(['old_owner', 'new_owner', 'reject_top'].every((c) => cols.includes(c)));
  const [old] = s.getSales('c', 0);
  assert.equal(old.priceTon, 7);
  assert.equal(old.oldOwner, null); // unknown owners: never treated as wash
  assert.equal(old.rejectTop, false);
  assert.equal(s.listRules()[0].state, 'live'); // pre-existing rules keep buying as before
  s.upsertSales([{ txHash: 't2', collection: 'c', nft: 'n2', priceTon: 8, timeMs: 2000, oldOwner: '0:a', newOwner: '0:b', rejectTop: true }]);
  const n2 = s.getSales('c', 0).find((x) => x.nft === 'n2');
  assert.deepEqual([n2.oldOwner, n2.newOwner, n2.rejectTop], ['0:a', '0:b', true]);
  assert.deepEqual(new Storage(db).ensureColumns('sales', { old_owner: 'TEXT' }), []); // idempotent
});

test('decisions, mutes and kv round-trip', async () => {
  const s = await openStorage(':memory:');
  const id = s.addDecision({ ts: 5, kind: 'skip', mode: 'dry', eventId: 'skip:1', alertId: 3, nft: 'n', code: 'rate', text: 'Not bought', payload: { v: 1 } });
  assert.equal(s.decisionByEvent('skip:1').id, id);
  assert.equal(s.decisionsForAlert(3)[0].code, 'rate');
  s.mute('c', 100, 'Coll');
  assert.equal(s.mutedOf(['x', 'c'], 50).label, 'Coll');
  assert.equal(s.mutedOf(['c'], 150), null);
  s.kvSet('panic', '1');
  assert.equal(s.kvGet('panic'), '1');
  s.kvSet('obj', { a: 1 });
  assert.deepEqual(s.kvJson('obj'), { a: 1 });
});

test('every .env key is documented in .env.example and the README', async () => {
  const fs = await import('node:fs');
  const { CONFIG_KEYS } = await import('../src/config.js');
  const example = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const k of CONFIG_KEYS) {
    assert.match(example, new RegExp(`^${k}=`, 'm'), `.env.example lacks ${k}`);
    assert.ok(readme.includes(`\`${k}\``), `README lacks ${k}`);
  }
  assert.ok(!/[\u0400-\u04FF]/.test(example), '.env.example must be English');
});

test('nothing under src/ reads files from test/ at runtime', async () => {
  // Runtime code must not need test/.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const files = fs.readdirSync(root, { recursive: true }).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 10);
  for (const f of files) {
    const code = fs
      .readFileSync(path.join(root, f), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)) // comments may point at test fixtures
      .join('\n');
    assert.ok(!/['"`][^'"`\n]*\btest\//.test(code), `src/${f} references test/`);
  }
});
