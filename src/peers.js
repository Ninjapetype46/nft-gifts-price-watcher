// Gift floor beacon (file contract suite.floors.v1, no shared server).
// Every engine cycle writes data/floors.json atomically (temp file + rename). PEER_FLOORS lists
// sibling bots' floors files or http(s) URLs; fresh entries are compared net of each market's own
// fees. Spreads are informational: there is no cross-market execution.
// getgems-checker cannot call Telegram or the mini-app markets itself; it relies on PEER_FLOORS.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { normalizeTrait } from './models.js';
import { createLogger } from './logger.js';

const log = createLogger('peers');
const require = createRequire(import.meta.url);

export const MARKETS = ['portals', 'mrkt', 'tonnel', 'getgems', 'telegram'];
export const MARKET_TITLES = { portals: 'Portals', mrkt: 'MRKT', tonnel: 'Tonnel', getgems: 'Getgems', telegram: 'Telegram' };

/** Bundled alias table (normalized name -> canonical normalized name). */
export function loadAliases() {
  const raw = require('./aliases.json');
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_')));
}

export const normName = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Canonical collection key: normalized, then mapped through aliases.json. */
export function canonical(name, aliases = {}) {
  const n = normName(name);
  return aliases[n] || n;
}

const normModel = (m) => (m === null || m === undefined || m === '' ? null : normName(normalizeTrait(m)));

/**
 * Build this bot's floors document from current listings.
 * @param {{market?:string, ts:number, fees:{buy_pct:number, sell_pct:number, fixed_ton:number},
 *   collections: {name:string, listings: import('./models.js').Listing[]}[]}} a
 */
export function buildFloors({ market = 'getgems', ts, fees, collections }) {
  const items = [];
  const push = (name, model, listings) => {
    const prices = listings.map((l) => l.priceTon).filter((p) => p > 0).sort((a, b) => a - b);
    if (!prices.length) return;
    items.push({ collection: name, model, backdrop: null, floor_ton: prices[0], second_ton: prices[1] ?? null, listed: prices.length, ts });
  };
  for (const c of collections) {
    if (!c.name) continue;
    push(c.name, null, c.listings);
    const byModel = new Map();
    for (const l of c.listings) {
      const m = l.attrs?.model;
      if (!m) continue;
      if (!byModel.has(m)) byModel.set(m, []);
      byModel.get(m).push(l);
    }
    for (const [m, ls] of byModel) push(c.name, m, ls);
  }
  return { v: 1, market, ts, fees, items };
}

/** @returns {{ok:boolean, errors:string[]}} */
export function validateFloors(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['not an object'] };
  if (doc.v !== 1) errors.push('v must be 1');
  if (!MARKETS.includes(doc.market)) errors.push(`market must be one of ${MARKETS.join('|')}`);
  if (!Number.isFinite(doc.ts)) errors.push('ts must be epoch ms');
  const f = doc.fees;
  if (!f || !Number.isFinite(f.buy_pct) || !Number.isFinite(f.sell_pct) || !Number.isFinite(f.fixed_ton)) errors.push('fees {buy_pct, sell_pct, fixed_ton} required');
  if (!Array.isArray(doc.items)) errors.push('items must be an array');
  else {
    for (const it of doc.items) {
      if (typeof it.collection !== 'string' || !Number.isFinite(it.floor_ton) || !Number.isFinite(it.ts)) {
        errors.push('each item needs {collection, floor_ton, ts}');
        break;
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Atomic write: readers never see a partial file. */
export function writeFloorsAtomic(file, doc) {
  const v = validateFloors(doc);
  if (!v.ok) throw new Error(`invalid floors document: ${v.errors.join('; ')}`);
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, abs);
  return abs;
}

/**
 * Read peer floors. Missing, malformed or stale sources are skipped with a single warning each.
 * @param {string[]} sources  file paths or http(s) URLs
 * @param {{now:number, maxAgeSec:number, fetchImpl?:typeof fetch, selfMarket?:string, warned?:Set<string>}} o
 */
export async function readPeers(sources, { now, maxAgeSec, fetchImpl, selfMarket = 'getgems', warned = new Set() }) {
  const peers = [];
  const warn = (src, msg) => {
    if (warned.has(src)) return;
    warned.add(src);
    log.warn(`peer ${src}: ${msg}`);
  };
  for (const src of sources || []) {
    let doc;
    try {
      if (/^https?:\/\//i.test(src)) {
        const res = await (fetchImpl || globalThis.fetch)(src, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        doc = await res.json();
      } else {
        doc = JSON.parse(fs.readFileSync(path.resolve(src), 'utf8'));
      }
    } catch (e) {
      warn(src, `unreadable (${e.message}), skipped`);
      continue;
    }
    const v = validateFloors(doc);
    if (!v.ok) {
      warn(src, `schema mismatch (${v.errors[0]}), skipped`);
      continue;
    }
    if (doc.market === selfMarket) continue; // our own market is "here"
    const maxAge = maxAgeSec * 1000;
    if (now - doc.ts > maxAge) {
      warn(src, `stale (${Math.round((now - doc.ts) / 1000)}s old > PEER_MAX_AGE_SEC ${maxAgeSec}), ignored`);
      continue;
    }
    const items = doc.items.filter((it) => now - it.ts <= maxAge);
    peers.push({ source: src, market: doc.market, ts: doc.ts, fees: doc.fees, items });
  }
  return peers;
}

export const buyAllIn = (floor, fees) => floor * (1 + fees.buy_pct / 100) + fees.fixed_ton;
export const peerExitNet = (floor, fees) => floor * (1 - fees.sell_pct / 100) - fees.fixed_ton;

/**
 * Compare a candidate with fresh peer floors of the same collection and model.
 * @param {{collectionName:string, model?:string|null, allInTon:number, exitHereTon?:number|null,
 *   peers: Awaited<ReturnType<typeof readPeers>>, aliases?:Record<string,string>, crossCheaperPct:number}} a
 */
export function compareElsewhere({ collectionName, model = null, allInTon, exitHereTon = null, peers, aliases = {}, crossCheaperPct }) {
  const key = canonical(collectionName, aliases);
  const m = normModel(model);
  const rows = [];
  for (const p of peers || []) {
    const it = p.items.find((i) => canonical(i.collection, aliases) === key && normModel(i.model) === m);
    if (!it) continue;
    rows.push({ market: p.market, floorTon: it.floor_ton, listed: it.listed ?? null, buyAllInTon: buyAllIn(it.floor_ton, p.fees), exitNetTon: peerExitNet(it.floor_ton, p.fees) });
  }
  if (!rows.length) return null;
  const cheapestPeer = [...rows].sort((a, b) => a.buyAllInTon - b.buyAllInTon)[0];
  const cheapestHere = allInTon <= cheapestPeer.buyAllInTon;
  const exits = [...rows.map((r) => ({ market: r.market, exitNetTon: r.exitNetTon }))];
  if (exitHereTon !== null && exitHereTon !== undefined) exits.push({ market: 'here', exitNetTon: exitHereTon });
  const bestExit = exits.sort((a, b) => b.exitNetTon - a.exitNetTon)[0];
  const cheaper = cheapestPeer.buyAllInTon <= allInTon * (1 - crossCheaperPct / 100) ? cheapestPeer : null;
  const title = (mk) => (mk === 'here' ? 'here' : MARKET_TITLES[mk] || mk);
  const edge = bestExit.exitNetTon - allInTon;
  const line =
    `Elsewhere (net): ${rows.map((r) => `${title(r.market)} ${r.exitNetTon.toFixed(1)}`).join(' · ')}` +
    ` - cheapest to buy: ${cheapestHere ? 'here' : `${title(cheapestPeer.market)} (${cheapestPeer.buyAllInTon.toFixed(2)} all-in)`}` +
    `; best exit: ${title(bestExit.market)} ${edge >= 0 ? '+' : '-'}${Math.abs(edge).toFixed(1)} TON`;
  return {
    rows,
    cheapestHere,
    cheapest: cheapestPeer,
    bestExit,
    cheaperElsewhere: cheaper
      ? { market: cheaper.market, title: title(cheaper.market), allInTon: cheaper.buyAllInTon, pct: ((allInTon - cheaper.buyAllInTon) / allInTon) * 100 }
      : null,
    line,
  };
}

/** /compare table for a collection (optionally one model): one row per market. */
export function formatCompare({ collectionName, model = null, here = null, peers, aliases = {} }) {
  const key = canonical(collectionName, aliases);
  const m = normModel(model);
  const rows = [];
  if (here) rows.push({ market: 'Getgems (here)', ...here });
  for (const p of peers || []) {
    const it = p.items.find((i) => canonical(i.collection, aliases) === key && normModel(i.model) === m);
    if (!it) continue;
    rows.push({ market: MARKET_TITLES[p.market] || p.market, floorTon: it.floor_ton, listed: it.listed ?? null, buyAllInTon: buyAllIn(it.floor_ton, p.fees), exitNetTon: peerExitNet(it.floor_ton, p.fees), ageSec: null });
  }
  const head = `Compare ${collectionName}${model ? ` · Model "${model}"` : ''} (TON, net of each market's fees)`;
  if (!rows.length) return `${head}\nNo fresh data. Set PEER_FLOORS to sibling bots' floors.json files.`;
  const lines = rows.map(
    (r) => `${r.market.padEnd(15)} floor ${r.floorTon.toFixed(2).padStart(7)} · buy all-in ${r.buyAllInTon.toFixed(2).padStart(7)} · exit net ${r.exitNetTon.toFixed(2).padStart(7)}${r.listed !== null ? ` · ${r.listed} listed` : ''}`,
  );
  return [head, ...lines, 'Spreads are informational; the bot never trades across markets.'].join('\n');
}
