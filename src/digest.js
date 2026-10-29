// Daily digest at DIGEST_AT (DIGEST_TZ): counts, spend against budget, paper/live P&L, the top
// skip reasons, and tuning hints from shadow marks of limit-skipped items ("9 deals were skipped
// by MAX_PRICE_TON=10, and 6 of them would be +net today"). Raising a limit always asks for a
// confirmation and can never exceed the .env ceiling.
// Optional suite section: PEER_EVENT_FILES (sibling bots' events.jsonl) summed in USD.

import fs from 'node:fs';
import { readEvents, eventTsMs } from './events.js';
import { reasonLabel } from './explain.js';
import { fmtSigned, plural } from './models.js';
import { PARAMS } from './settings.js';
import { escapeHtml } from './format.js';
import { createLogger } from './logger.js';

const log = createLogger('digest');

/** Aggregate suite.event.v1 objects. */
export function aggregateEvents(events) {
  const counts = { alert: 0, buy: 0, shadow: 0, skip: 0, error: 0, sell: 0, pause: 0, resume: 0 };
  const skipCodes = {};
  const spend = { dry: 0, live: 0, shadow: 0 };
  for (const e of events) {
    // Shadow fills are would-be buys of shadow rules, not paper or live buys: counted apart.
    const kind = e.kind === 'buy' && e.mode === 'shadow' ? 'shadow' : e.kind;
    counts[kind] = (counts[kind] || 0) + 1;
    if (e.kind === 'skip') {
      const code = e.reasons?.[0]?.code || 'UNKNOWN';
      skipCodes[code] = (skipCodes[code] || 0) + 1;
    }
    if (e.kind === 'buy' && e.money?.price) spend[e.mode] = (spend[e.mode] || 0) + e.money.price;
  }
  const topSkips = Object.entries(skipCodes)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([code, n]) => ({ code, n }));
  return { counts, topSkips, spend, total: events.length };
}

const LIMIT_PARAMS = {
  max_price: { param: 'max_price', env: 'MAX_PRICE_TON' },
  budget: { param: 'daily_budget', env: 'DAILY_BUDGET_TON' },
  rate: { param: 'max_buys_per_hour', env: 'MAX_BUYS_PER_HOUR' },
};

/**
 * Tuning hints from shadow fills of limit-skipped items.
 * @param {{entryPrice:number, entryCosts:number, markPrice:number|null, meta:{skipCode:string, allInTon?:number}}[]} skipFills
 * @param {{get:(n:string)=>number, cfg:object}} settings
 */
export function tuningHints(skipFills, settings) {
  const by = new Map();
  for (const f of skipFills) {
    const code = f.meta?.skipCode;
    if (!LIMIT_PARAMS[code]) continue;
    if (!by.has(code)) by.set(code, []);
    by.get(code).push(f);
  }
  const hints = [];
  for (const [code, fills] of by) {
    const { param, env } = LIMIT_PARAMS[code];
    const current = settings.get(param);
    const marked = fills.filter((f) => f.markPrice !== null && f.markPrice !== undefined);
    const pnl = (f) => f.markPrice - (f.entryPrice + f.entryCosts);
    const pos = marked.filter((f) => pnl(f) > 0);
    const sum = pos.reduce((s, f) => s + pnl(f), 0);
    let suggest;
    if (code === 'max_price') suggest = Math.ceil(Math.max(current, ...pos.map((f) => f.meta?.allInTon ?? f.entryPrice + f.entryCosts)));
    else if (code === 'budget') suggest = Math.ceil(current + pos.reduce((s, f) => s + (f.meta?.allInTon ?? f.entryPrice), 0));
    else suggest = current + 1;
    // Never offer a raise the .env hard ceiling would refuse.
    const ceiling = settings.cfg?.[PARAMS[param]?.cfgKey];
    const capped = Number.isFinite(ceiling) && suggest > ceiling;
    if (capped) suggest = ceiling;
    const atCeiling = Number.isFinite(ceiling) && current >= ceiling;
    const text =
      `${fills.length} deal${fills.length === 1 ? ' was' : 's were'} skipped by ${env}=${current}, and ${pos.length} of them would be +net today (${fmtSigned(sum, 1)} TON).` +
      (pos.length && atCeiling ? ` ${env} is already at its .env limit.` : '');
    hints.push({ code, param, env, n: fills.length, positive: pos.length, sumTon: sum, current, suggest, ceiling: ceiling ?? null, text, canRaise: pos.length > 0 && suggest > current });
  }
  return hints.sort((a, b) => b.sumTon - a.sumTon);
}

/**
 * Read sibling bots' events. Missing, unreadable or schema-mismatched files are skipped with a
 * single warning each; nothing is imported from sibling repos.
 */
export function readPeerEvents(files, { sinceMs = 0, warned = new Set() } = {}) {
  const events = [];
  const warnings = [];
  for (const f of files || []) {
    try {
      if (!fs.existsSync(f)) throw new Error('missing');
      const r = readEvents(f, { sinceMs });
      if (!r.events.length && r.bad) throw new Error(`schema mismatch (${plural(r.bad, 'bad line')})`);
      events.push(...r.events);
    } catch (e) {
      const msg = `peer events ${f}: ${e.message}, skipped`;
      warnings.push(msg);
      if (!warned.has(f)) {
        warned.add(f);
        log.warn(msg);
      }
    }
  }
  return { events, warnings };
}

/** Suite section: per bot counts and USD volume of buys. */
export function suiteSection(peerEvents) {
  const bots = {};
  for (const e of peerEvents) {
    const b = (bots[e.bot] ||= { alerts: 0, buys: 0, skips: 0, usd: 0 });
    if (e.kind === 'alert') b.alerts++;
    if (e.kind === 'skip') b.skips++;
    if (e.kind === 'buy') {
      b.buys++;
      b.usd += Number(e.money?.usd || 0);
    }
  }
  const totalUsd = Object.values(bots).reduce((s, b) => s + b.usd, 0);
  return { bots, totalUsd };
}

/**
 * Digest text (HTML with <b> only). With `ledger` (from the buys table, see buildDigest) the
 * counts match /scoreboard: buys without lost races, and blocked buy attempts apart from deals
 * skipped before any buy attempt. Without it, the event counts are shown.
 * @param {{agg: ReturnType<typeof aggregateEvents>, mode:string, spentTon:number, budgetTon:number, sb?:any, hints?:any[], suite?:any, periodH?:number, currency?:string,
 *   ledger?: {bought:number, lost:number, blocked:number, skippedEarly:number}|null}} d
 */
export function renderDigest({ agg, mode, spentTon, budgetTon, sb = null, hints = [], suite = null, periodH = 24, currency = 'TON', ledger = null }) {
  const c = agg.counts;
  const lines = [`🗞 <b>Daily digest (${periodH}h, ${mode})</b>`];
  const buyWord = mode === 'live' ? 'buys' : 'paper buys';
  const counts = ledger
    ? [
        `${buyWord} ${ledger.bought}${ledger.lost ? ` (+${ledger.lost} lost to faster buyers, not counted)` : ''}`,
        ...(c.shadow ? [`shadow fills ${c.shadow}`] : []),
        `blocked buys ${ledger.blocked}`,
        ...(ledger.skippedEarly ? [`skipped before a buy attempt ${ledger.skippedEarly}`] : []),
      ]
    : [`${buyWord} ${c.buy}`, ...(c.shadow ? [`shadow fills ${c.shadow}`] : []), `not bought ${c.skip}`];
  lines.push(`Alerts ${c.alert} · ${counts.join(' · ')}${c.error ? ` · errors ${c.error}` : ''}`);
  lines.push(`Spend: ${spentTon.toFixed(2)}/${budgetTon.toFixed(2)} ${currency} of the daily budget`);
  if (sb) {
    // The bot never sells, so all P&L is unrealized: positions marked at fair value net of fees.
    lines.push(`P&L if sold at fair value, after fees: paper ${fmtSigned(sb.paper.pnl, 1)} ${currency}${sb.live ? ` · live ${fmtSigned(sb.live.pnl, 1)} ${currency}` : ''}`);
  }
  if (agg.topSkips.length) {
    lines.push(`Top reasons not bought: ${agg.topSkips.map((s) => `${escapeHtml(reasonLabel(s.code))} ${s.n}`).join(', ')}`);
  } else lines.push('Top reasons not bought: none');
  for (const h of hints.slice(0, 3)) lines.push(`💡 ${h.text}${h.canRaise ? ` [Raise to ${h.suggest}] [Keep]` : ''}`);
  if (suite && Object.keys(suite.bots).length) {
    lines.push(`<b>Your other bots:</b> ${Object.entries(suite.bots).map(([b, s]) => `${escapeHtml(b)} ${plural(s.buys, 'buy')} $${s.usd.toFixed(0)}`).join(' · ')} · total $${suite.totalUsd.toFixed(0)}`);
  }
  return lines.join('\n');
}

export { eventTsMs };
