// Pure-ish helpers for bot/CLI command parsing (kept out of bot.js so they are easy to test).

import { isAddress, toRaw } from './address.js';

export const AUTOBUY_USAGE =
  'Usage: /autobuy add <collection|*> max=<ton> discount=<pct> [edge=<ton>] [edgepct=<pct>] [eta=<days>] [bid=1] [cross=0]';

/**
 * Parse "/autobuy add <collection|*> max=<ton> discount=<pct> [edge=<ton>] [edgepct=<pct>] [eta=<days>] [bid=1] [cross=0]".
 *  edge=     minimum net edge in TON after fees and royalty (FEES_EAT_PROFIT otherwise)
 *  edgepct=  minimum net edge in % of the all-in cost
 *  eta=      maximum expected days to resell (liquidity)
 *  bid=1     only buy when an open bid already covers an instant exit
 *  cross=0   disable the cross-market check (CHEAPER_ELSEWHERE)
 * Optional keys are only present in the result when given.
 * @param {string[]} args tokens after "add"
 */
export function parseAutobuyAdd(args) {
  const usage = AUTOBUY_USAGE;
  const positional = args.filter((a) => !a.includes('='));
  const kv = Object.fromEntries(
    args
      .filter((a) => a.includes('='))
      .map((a) => {
        const [k, ...v] = a.split('=');
        return [k.trim().toLowerCase(), v.join('=').trim().replace(/%$/, '')];
      }),
  );
  if (positional.length !== 1) return { ok: false, error: usage };
  const max = Number(kv.max);
  const disc = Number(kv.discount ?? 0);
  if (!Number.isFinite(max) || max <= 0) return { ok: false, error: `max must be a positive number. ${usage}` };
  if (!Number.isFinite(disc) || disc < 0 || disc >= 100) return { ok: false, error: `discount must be 0..99. ${usage}` };
  const out = { ok: true, collection: positional[0], maxPriceTon: max, minDiscountPct: disc };
  if (kv.edge !== undefined) {
    const v = Number(kv.edge);
    if (!Number.isFinite(v)) return { ok: false, error: `edge must be a number of TON. ${usage}` };
    out.minEdgeTon = v;
  }
  if (kv.edgepct !== undefined) {
    const v = Number(kv.edgepct);
    if (!Number.isFinite(v)) return { ok: false, error: `edgepct must be a number. ${usage}` };
    out.minEdgePct = v;
  }
  if (kv.eta !== undefined) {
    const v = Number(kv.eta);
    if (!Number.isFinite(v) || v <= 0) return { ok: false, error: `eta must be a positive number of days. ${usage}` };
    out.maxEtaDays = v;
  }
  if (kv.bid !== undefined) {
    if (!['0', '1'].includes(kv.bid)) return { ok: false, error: `bid must be 0 or 1. ${usage}` };
    out.requireBid = kv.bid === '1';
  }
  if (kv.cross !== undefined) {
    if (!['0', '1'].includes(kv.cross)) return { ok: false, error: `cross must be 0 or 1. ${usage}` };
    out.crossCheck = kv.cross === '1';
  }
  return out;
}

/** "max 5 TON, discount ≥ 30%, edge ≥ 1 TON, eta ≤ 7d, bid required" */
export function describeRule(r) {
  const parts = [`max ${r.maxPriceTon} TON`, `discount ≥ ${r.minDiscountPct}%`];
  if (r.minEdgeTon !== null && r.minEdgeTon !== undefined) parts.push(`net edge ≥ ${r.minEdgeTon} TON`);
  if (r.minEdgePct !== null && r.minEdgePct !== undefined) parts.push(`net edge ≥ ${r.minEdgePct}%`);
  if (r.maxEtaDays !== null && r.maxEtaDays !== undefined) parts.push(`sells in ≤ ${r.maxEtaDays}d`);
  if (r.requireBid) parts.push('bid required');
  if (r.crossCheck === false) parts.push('no cross-market check');
  return parts.join(', ');
}

/**
 * Resolve a collection given as an address or (for gifts) by name.
 * @param {string} input
 * @param {{listGiftCollections: () => Promise<{address:string,name:string}[]>}} client
 * @returns {Promise<{ok:true, collection:string, name:string|null} | {ok:false, error:string}>}
 */
export async function resolveCollection(input, client) {
  const q = String(input || '').trim();
  if (!q) return { ok: false, error: 'Collection address or gift collection name is required' };
  if (isAddress(q)) return { ok: true, collection: toRaw(q), name: null };
  let gifts = [];
  try {
    gifts = await client.listGiftCollections();
  } catch (e) {
    return { ok: false, error: `Not an address, and gift list is unavailable: ${e.message}` };
  }
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const nq = norm(q);
  const exact = gifts.filter((g) => norm(g.name) === nq || norm(g.name) === `${nq}s`);
  const partial = exact.length ? exact : gifts.filter((g) => norm(g.name).includes(nq));
  if (partial.length === 1) return { ok: true, collection: partial[0].address, name: partial[0].name };
  if (partial.length > 1) {
    return { ok: false, error: `Ambiguous: ${partial.slice(0, 8).map((g) => g.name).join(', ')}` };
  }
  return { ok: false, error: `Unknown collection "${q}". Use the collection address (EQ… or 0:…).` };
}

/** Split a command message into tokens after the command itself. */
export function commandArgs(text) {
  return String(text || '').trim().split(/\s+/).slice(1);
}
