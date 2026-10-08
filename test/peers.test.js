// Gift floor beacon: suite.floors.v1 write/read/compare.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonical, loadAliases, buildFloors, validateFloors, writeFloorsAtomic, readPeers, compareElsewhere } from '../src/peers.js';
import { MOCK_PEER_FIXTURES } from '../src/clients/mock.js';

const NOW = Date.UTC(2026, 9, 28, 12);
const aliases = loadAliases();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ggc-peers-'));
const doc = (market, fees, items, ts = NOW - 10_000) => ({ v: 1, market, ts, fees, items: items.map((i) => ({ backdrop: null, second_ton: null, listed: 1, ts, ...i })) });

test('alias normalization: "Plush Pepes" and "plushpepe" are the same collection', () => {
  assert.equal(canonical('Plush Pepes', aliases), canonical('plushpepe', aliases));
  assert.equal(canonical('Mock Plush Pepe', aliases), canonical('Mock Plush Pepes', aliases));
  assert.notEqual(canonical('Homemade Cakes', aliases), canonical('Plush Pepes', aliases));
});

test('stale peers are ignored with one warning; our own market is skipped', async () => {
  const dir = tmp();
  const fresh = path.join(dir, 'portals.json');
  const stale = path.join(dir, 'tonnel.json');
  const self = path.join(dir, 'getgems.json');
  const fees = { buy_pct: 0, sell_pct: 5, fixed_ton: 0.1 };
  fs.writeFileSync(fresh, JSON.stringify(doc('portals', fees, [{ collection: 'Plush Pepes', model: 'Gold', floor_ton: 10 }])));
  fs.writeFileSync(stale, JSON.stringify(doc('tonnel', fees, [{ collection: 'Plush Pepes', model: 'Gold', floor_ton: 5 }], NOW - 3_600_000)));
  fs.writeFileSync(self, JSON.stringify(doc('getgems', fees, [{ collection: 'Plush Pepes', model: 'Gold', floor_ton: 9 }])));
  const warned = new Set();
  const peers = await readPeers([fresh, stale, self, path.join(dir, 'missing.json')], { now: NOW, maxAgeSec: 300, warned });
  assert.deepEqual(peers.map((p) => p.market), ['portals']);
  assert.equal(warned.size, 2); // stale + missing
  await readPeers([stale], { now: NOW, maxAgeSec: 300, warned });
  assert.equal(warned.size, 2); // single warning per peer
});

test('fee-normalized ranking: a cheaper sticker price with a higher fee loses', () => {
  const peers = [
    { market: 'mrkt', fees: { buy_pct: 8, sell_pct: 8, fixed_ton: 0.5 }, items: doc('mrkt', {}, [{ collection: 'plushpepe', model: 'Gold', floor_ton: 12.8 }]).items },
    { market: 'portals', fees: { buy_pct: 0, sell_pct: 5, fixed_ton: 0.1 }, items: doc('portals', {}, [{ collection: 'Plush Pepes', model: 'Gold (1.2%)', floor_ton: 13 }]).items },
  ];
  const c = compareElsewhere({ collectionName: 'Plush Pepes', model: 'Gold', allInTon: 14.5, exitHereTon: 12, peers, aliases, crossCheaperPct: 3 });
  assert.equal(c.cheapest.market, 'portals'); // 13.10 all-in beats 12.8*1.08+0.5 = 14.32
  assert.equal(c.cheaperElsewhere.market, 'portals');
  assert.match(c.line, /^Elsewhere \(net\): MRKT 11\.3 · Portals 12\.3 - cheapest to buy: Portals/);
  assert.equal(compareElsewhere({ collectionName: 'Plush Pepes', model: 'Gold', allInTon: 13.2, peers, aliases, crossCheaperPct: 3 }).cheaperElsewhere, null);
  assert.equal(compareElsewhere({ collectionName: 'Other', model: 'Gold', allInTon: 13, peers, aliases, crossCheaperPct: 3 }), null);
});

test('atomic write: valid document, no temp files left, readers never see a partial file', () => {
  const dir = tmp();
  const file = path.join(dir, 'floors.json');
  const listings = [4, 5, 9].map((p, i) => ({ nft: `n${i}`, priceTon: p, attrs: { model: i < 2 ? 'Bronze' : 'Gold' } }));
  const d = buildFloors({ ts: NOW, fees: { buy_pct: 0, sell_pct: 10, fixed_ton: 0.1 }, collections: [{ name: 'Plush Pepes', listings }] });
  assert.equal(validateFloors(d).ok, true);
  assert.deepEqual(d.items.map((i) => [i.model, i.floor_ton, i.second_ton, i.listed]), [[null, 4, 5, 3], ['Bronze', 4, 5, 2], ['Gold', 9, null, 1]]);
  writeFloorsAtomic(file, d);
  writeFloorsAtomic(file, { ...d, ts: NOW + 1 });
  assert.deepEqual(fs.readdirSync(dir), ['floors.json']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).ts, NOW + 1);
  assert.throws(() => writeFloorsAtomic(file, { v: 2 }), /invalid floors/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).ts, NOW + 1); // a failed write leaves the old file intact
});

test('mock peer floors ship under src/ and are valid floors files', () => {
  // The mock reads them at runtime.
  const dir = new URL('.', MOCK_PEER_FIXTURES);
  assert.ok(dir.href.startsWith(new URL('../src/', import.meta.url).href), dir.href);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(files, ['getgems.json', 'mrkt.json', 'portals.json', 'telegram.json', 'tonnel.json']);
  for (const f of files) {
    const v = validateFloors(JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8')));
    assert.equal(v.ok, true, `${f}: ${v.errors.join(', ')}`);
  }
});
