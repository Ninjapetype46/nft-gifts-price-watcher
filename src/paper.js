// Pure paper-autopilot scoreboard. In practice mode (DRY_RUN) the bot "buys on paper"; this module
// marks those positions net of fees, flags buys a faster bot would have won (lost races), and
// aggregates an honest scoreboard. No I/O; `now` is a parameter.

import { exitNet } from './edge.js';
import { fmtTon, fmtSigned, plural } from './models.js';
import { escapeHtml } from './format.js';
import { blockLabel } from './explain.js';

const DAY = 86_400_000;

/**
 * A real buy would likely have lost to a faster buyer when the item sold within LOST_RACE_SEC of
 * our (paper) buy. Sales from before the buy are ignored.
 * @param {{createdAt:number}} buy
 * @param {{timeMs:number}|null|undefined} sale  earliest cached sold event of the NFT
 * @returns {'lost_race'|'open'}
 */
export function classifyRace(buy, sale, { lostRaceSec = 30 } = {}) {
  if (!sale || sale.timeMs < buy.createdAt) return 'open';
  return sale.timeMs <= buy.createdAt + lostRaceSec * 1000 ? 'lost_race' : 'open';
}

/**
 * Mark a position: mark = exitNet(fair); conservative mark = min(mark, floorRef·(1-fees) - SELL_COST_TON).
 * @param {{priceTon:number}} buy
 * @param {{fairValueTon:number|null}|null} valuation
 * @param {import('./edge.js').Fees} fees
 * @param {number|null} floorRefSameModel cheapest other listing of the same model
 */
export function markToMarket(buy, valuation, fees, floorRefSameModel, cfg) {
  const fair = valuation?.fairValueTon ?? null;
  if (fair === null) return { markTon: null, markConsTon: null };
  const markTon = exitNet(fair, fees, cfg);
  const floorExit = floorRefSameModel ? floorRefSameModel * (1 - fees.marketFeePct - fees.royaltyPct) - cfg.sellCostTon : null;
  return { markTon, markConsTon: floorExit === null ? markTon : Math.min(markTon, floorExit) };
}

const costOf = (b) => b.allInTon ?? b.priceTon;

function side(buys) {
  const lost = buys.filter((b) => b.outcome === 'lost_race');
  const held = buys.filter((b) => b.outcome !== 'lost_race');
  const allIn = held.reduce((s, b) => s + costOf(b), 0);
  const marked = held.filter((b) => b.markTon !== null && b.markTon !== undefined);
  const mark = held.reduce((s, b) => s + (b.markTon ?? costOf(b)), 0);
  const markCons = held.reduce((s, b) => s + (b.markConsTon ?? b.markTon ?? costOf(b)), 0);
  const pnl = mark - allIn;
  let winners = 0;
  let losers = 0;
  let flat = 0;
  for (const b of held) {
    const p = (b.markTon ?? costOf(b)) - costOf(b);
    if (p > 0.05) winners++;
    else if (p < -0.05) losers++;
    else flat++;
  }
  return {
    n: held.length,
    marked: marked.length,
    allIn,
    mark,
    markCons,
    pnl,
    pnlPct: allIn > 0 ? (pnl / allIn) * 100 : 0,
    winners,
    losers,
    flat,
    lostRaces: lost.length,
    lost: lost.map((b) => ({ name: b.name, soldAfterSec: b.soldAfterSec ?? null })),
  };
}

/**
 * @param {Array<{mode:string, status:string, name:string, priceTon:number, allInTon?:number|null, markTon?:number|null,
 *   markConsTon?:number|null, outcome?:string|null, reasonCode?:string|null, createdAt:number, soldAfterSec?:number|null}>} buys
 * @param {number} now
 */
export function scoreboard(buys, now) {
  const paperBuys = buys.filter((b) => b.mode === 'dry' && b.status === 'dry');
  const liveBuys = buys.filter((b) => b.mode === 'live' && ['sent', 'pending'].includes(b.status));
  const sinceMs = paperBuys.length ? Math.min(...paperBuys.map((b) => b.createdAt)) : null;
  /** @type {Record<string, number>} */
  const skipped = {};
  for (const b of buys) {
    if (b.status !== 'blocked') continue;
    const code = String(b.reasonCode || 'unknown').split(':')[0];
    skipped[code] = (skipped[code] || 0) + 1;
  }
  let worst = null;
  for (const b of [...paperBuys, ...liveBuys]) {
    if (b.outcome === 'lost_race' || b.markTon === null || b.markTon === undefined) continue;
    const pnl = b.markTon - costOf(b);
    if (!worst || pnl < worst.pnl) worst = { name: b.name, pnl, reason: b.confidence ? `confidence ${b.confidence}` : '' };
  }
  return {
    sinceMs,
    days: sinceMs === null ? 0 : Math.floor((now - sinceMs) / DAY),
    paper: side(paperBuys),
    live: liveBuys.length ? side(liveBuys) : null,
    skipped,
    worst: worst && worst.pnl < 0 ? worst : null,
  };
}

/** Go-live readiness: enough days and paper buys? */
export function readiness(sb, { paperMinDays, paperMinBuys }) {
  const ok = sb.days >= paperMinDays && sb.paper.n >= paperMinBuys;
  const text = ok
    ? `✅ ${plural(sb.days, 'day')}, ${plural(sb.paper.n, 'paper buy')}`
    : `⚠️ Only ${plural(sb.days, 'day')} / ${plural(sb.paper.n, 'paper buy')}: recommended ${plural(paperMinDays, 'day')}, ${plural(paperMinBuys, 'buy')}`;
  return { ok, text };
}

/** Plain-text/HTML scoreboard (no tags except <b>; market-supplied names are escaped). */
export function formatScoreboard(sb, { currency = 'TON' } = {}) {
  const p = sb.paper;
  const lines = [`📒 <b>Paper autopilot · ${plural(sb.days, 'day')}</b>`];
  lines.push(`Bought on paper: ${p.n} for ${p.allIn.toFixed(1)} ${currency} all-in`);
  if (p.n) {
    lines.push(
      `Worth now: ~${p.mark.toFixed(1)} after fees (${fmtSigned(p.pnl, 1)}, ${fmtSigned(p.pnlPct, 1)}%) · conservative ~${p.markCons.toFixed(1)}`,
    );
    const worst = sb.worst ? ` (${fmtSigned(sb.worst.pnl, 1)} ${escapeHtml(sb.worst.name)})` : '';
    lines.push(`Winners ${p.winners} · losers ${p.losers}${worst} · flat ${p.flat}`);
  }
  if (p.lostRaces) {
    const first = p.lost[0];
    const detail = first ? `${escapeHtml(first.name)}${first.soldAfterSec !== null ? `, sold ${first.soldAfterSec}s after it appeared` : ''}` : '';
    lines.push(`Lost to faster buyers: ${p.lostRaces} (${detail}${p.lostRaces > 1 ? ', …' : ''}; not counted)`);
  } else {
    lines.push('Lost to faster buyers: 0');
  }
  // Blocked buy attempts, grouped by plain reason ("risk_red" -> "failed a safety check").
  const byLabel = new Map();
  for (const [code, n] of Object.entries(sb.skipped)) byLabel.set(blockLabel(code), (byLabel.get(blockLabel(code)) || 0) + n);
  const sk = [...byLabel].sort((a, b) => b[1] - a[1]);
  const total = sk.reduce((s, [, n]) => s + n, 0);
  lines.push(total ? `Blocked buys ${total}: ${sk.map(([label, n]) => `${escapeHtml(label)} ${n}`).join(', ')}` : 'Blocked buys 0');
  if (sb.live) {
    const l = sb.live;
    lines.push(`<b>Live:</b> ${l.n} buys for ${l.allIn.toFixed(1)} ${currency} all-in · worth ~${l.mark.toFixed(1)} (${fmtSigned(l.pnl, 1)}, ${fmtSigned(l.pnlPct, 1)}%) · lost races ${l.lostRaces}`);
  }
  lines.push("Paper results don't guarantee live results.");
  return lines.join('\n');
}

export { fmtTon };
