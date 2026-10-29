// Pure text formatting for Telegram (HTML parse mode) and stdout.
//
// Alert card layout (shared with the sibling bots):
//   header: PRACTICE/LIVE tag, verdict, item and price (+ all-in), EXIT-BACKED tag
//   reference line: fair value with confidence, comps basis and ignored sales
//   net block: resell net of fee + royalty -> edge, instant exit from an open bid, time to sell, fiat
//   one "Risk:" line with the safe-to-buy light
//   <blockquote expandable> "Why" in plain words, raw numbers, rule, data age
//   buttons: Open, Paper buy / Buy…, Why?, Comps, Mute 24h

import { fmtTon, fmtSigned, getgemsUrl } from './models.js';
import { shortAddr } from './address.js';
import { ignoredCount } from './valuation.js';
import { riskLine } from './risk.js';
import { reasonText } from './explain.js';
import { fiatLine } from './rates.js';

export const MAX_MESSAGE = 4096;

export function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Strip tags for console output. */
export function htmlToText(s) {
  return String(s)
    .replace(/<a href="([^"]+)">([^<]*)<\/a>/g, '$2 ($1)')
    .replace(/<blockquote[^>]*>/g, '')
    .replace(/<\/blockquote>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const KIND_TITLE = { absolute: 'Cheap', below_floor: 'Below floor', undervalued: 'Undervalued' };
const BADGE_TEXT = { fast: 'fast', normal: 'normal', slow: 'slow', illiquid: 'illiquid' };
const pct = (x) => `${Math.round(x * 1000) / 10}`.replace(/\.0$/, '');

/** BUY / WATCH / AVOID from edge, risk, confidence and liquidity. */
export function verdictOf(alert) {
  const e = alert.edge;
  if (alert.risk?.level === 'red') return 'AVOID';
  if (e && e.edgeTon !== null && e.edgeTon < 0) return 'AVOID';
  const conf = alert.valuation?.fairValueTon !== null && alert.valuation?.fairValueTon !== undefined ? alert.valuation.confidence : null;
  const badge = e?.liquidity?.badge;
  if (e && e.edgeTon > 0 && alert.risk?.level === 'green' && (conf === 'A' || conf === 'B') && badge !== 'illiquid') return 'BUY';
  return 'WATCH';
}

/** Fair-value line: `Fair 8.00 TON · conf A · 8 sales of Model "Bronze" (30d) · 8 ignored`. */
export function fairLine(v, currency = 'TON') {
  if (!v) return null;
  if (v.fairValueTon === null) return `Fair value: n/a — ${escapeHtml(v.note)}`;
  const ign = ignoredCount(v);
  const conf = v.confidence ? ` · conf ${v.confidence}` : '';
  const days = v.lookbackDays ? ` (${v.lookbackDays}d)` : '';
  return `Fair ${fmtTon(v.fairValueTon)} ${currency}${conf} · ${v.comparables} sales of ${escapeHtml(v.label)}${days}${ign ? ` · ${ign} ignored` : ''}`;
}

function etaText(liq) {
  if (!Number.isFinite(liq.etaDays)) return '';
  const d = liq.etaDays < 1 ? '<1 day' : `~${Math.round(liq.etaDays)} day${Math.round(liq.etaDays) === 1 ? '' : 's'}`;
  return d;
}

/** `Sells: fast (~2 days · 0.5 sales/day · 1 listed below fair)` / `Sells: illiquid (1 sale in 30d)` */
export function liquidityLine(liq) {
  if (!liq) return null;
  if (liq.badge === 'illiquid') return `Sells: illiquid (${liq.sales30} sale${liq.sales30 === 1 ? '' : 's'} in 30d)`;
  return `Sells: ${BADGE_TEXT[liq.badge]} (${etaText(liq)} · ${liq.rate.toFixed(1)} sales/day · ${liq.depth} listed below fair)`;
}

function expiresIn(ms, now) {
  if (!ms) return '';
  const h = (ms - now) / 3_600_000;
  if (h <= 0) return '';
  return h >= 24 ? ` · expires in ${Math.round(h / 24)}d` : ` · expires in ${Math.max(1, Math.round(h))}h`;
}

/** Plain-language "why" reasons (good ones first, at most 3) for the expandable section. */
export function whyReasons(alert) {
  const out = [];
  for (const r of alert.reasons || []) out.push(r.code ? reasonText(r.code, r.p || {}) : r.text);
  const e = alert.edge;
  if (e?.exitBacked && e.bid) out.push(reasonText('EXIT_BACKED', { bid: fmtTon(e.bid.netTon), edge: fmtSigned(e.bid.edgeTon) }));
  const v = alert.valuation;
  const washed = (v?.excluded?.round_trip || 0) + (v?.excluded?.same_wallet_pair || 0) + (v?.excluded?.flagged_by_getgems || 0);
  if (washed) out.push(reasonText('WASHY_COMPS', { n: washed }));
  if (e?.liquidity && ['fast', 'normal'].includes(e.liquidity.badge) && Number.isFinite(e.liquidity.etaDays)) {
    out.push(reasonText('FAST_SELLER', { eta: Math.max(1, Math.round(e.liquidity.etaDays)) }));
  }
  return out.slice(0, 3);
}

/**
 * @param {import('./detector.js').Alert & {edge?:any, risk?:any, mode?:string, elsewhere?:any, fiat?:any, dataAt?:number, salesSyncedAt?:number|null}} alert
 * @param {{collectionName?: string|null, currency?: string, alertId?: number|null, now?: number, notes?: {offchain?:string, telemint?:string}}} [opts]
 */
export function formatAlert(alert, { collectionName = null, currency = 'TON', alertId = null, now = Date.now(), notes = {} } = {}) {
  const l = alert.listing;
  const e = alert.edge || null;
  const v = alert.valuation;
  const kinds = [...new Set(alert.reasons.map((r) => KIND_TITLE[r.kind]))].join(' + ');
  const tag = alert.mode === 'live' ? 'LIVE' : 'PRACTICE';
  const verdict = alert.verdict || verdictOf(alert);
  const lines = [];

  const allIn = e ? ` (all-in ${fmtTon(e.allInTon)})` : '';
  const backed = e?.exitBacked ? ' · ⚡ EXIT-BACKED' : '';
  lines.push(`🔥 <b>${tag}</b> · <b>${verdict}</b> · <b>${escapeHtml(l.name)} — ${fmtTon(l.priceTon)} ${currency}</b>${allIn}${backed}`);
  lines.push(`${escapeHtml(kinds)} · ${escapeHtml(collectionName || shortAddr(l.collection))}`);
  const traits = ['model', 'backdrop', 'symbol'].filter((t) => l.attrs?.[t]).map((t) => `${t[0].toUpperCase()}${t.slice(1)}: ${escapeHtml(l.attrs[t])}`);
  if (!traits.length) {
    for (const [k, val] of Object.entries(l.attrs || {}).slice(0, 4)) traits.push(`${escapeHtml(k)}: ${escapeHtml(val)}`);
  }
  if (traits.length) lines.push(traits.join(' · '));

  // Reference line: fair value with confidence and receipt summary.
  if (v) {
    lines.push(fairLine(v, currency));
    if (v.fairValueTon !== null && v.confidence === 'C') {
      lines.push(`⚠️ Thin or mixed data: rough estimate (range ${fmtTon(v.p25Ton ?? v.minTon)}-${fmtTon(v.p75Ton ?? v.maxTon)})`);
    }
    if (v.fairValueTon !== null && v.fallback) lines.push(`⚠️ Fallback: ${escapeHtml(v.note)}`);
  } else if (alert.floorRefTon !== null && alert.floorRefTon !== undefined) {
    lines.push(`Floor ref (next cheapest): ${fmtTon(alert.floorRefTon)} ${currency}`);
  }

  // Net block.
  if (e && e.exitNetTon !== null) {
    if (e.edgeTon < 0) lines.push(`❗ <b>Not a deal after fees:</b> you would lose ~${Math.abs(e.edgeTon).toFixed(1)} ${currency}`);
    const fees = e.fees;
    const feeTxt = `${pct(fees.marketFeePct)}% fee + ${pct(fees.royaltyPct)}% royalty`;
    lines.push(
      `Resell at ${e.refKind === 'fair' ? 'fair' : 'floor'} ${fmtTon(e.refTon)} → you keep ~${fmtTon(e.exitNetTon)} after ${feeTxt} → ` +
        `<b>${fmtSigned(e.edgeTon)} ${currency} (${fmtSigned(e.edgePct, 0)}%)</b>`,
    );
  }
  if (e?.bid) {
    lines.push(`⚡ Instant exit: an open bid pays ${fmtTon(e.bid.netTon)} net now (${fmtSigned(e.bid.edgeTon)})${expiresIn(e.bid.expiresAt, now)}`);
  } else if (e && !e.bidsAvailable) {
    lines.push('Bids: n/a');
  }
  const liq = liquidityLine(e?.liquidity);
  if (liq) lines.push(liq);
  if (alert.elsewhere?.line) lines.push(escapeHtml(alert.elsewhere.line));
  const fiat = e ? fiatLine(e.allInTon, alert.fiat) : null;
  if (fiat) lines.push(fiat);
  if (l.contractType === 'offchain' && notes.offchain) lines.push(`ℹ️ ${escapeHtml(notes.offchain)}`);
  if (l.contractType === 'telemint' && notes.telemint) lines.push(`ℹ️ ${escapeHtml(notes.telemint)}`);
  if (l.market && l.market !== 'getgems') lines.push(`Market: ${escapeHtml(l.market)}`);

  lines.push(`Risk: ${riskLine(alert.risk)}`);

  // Expandable "Why": plain words first, then raw numbers, rule and data age.
  const why = whyReasons(alert);
  const q = [`<b>Why</b>`];
  for (const w of why) q.push(`• ${escapeHtml(w)}`);
  if (v?.fairValueTon !== null && v?.fallback) q.push(`• Not enough sales of the exact model, so the price uses ${escapeHtml(v.label)}`);
  const nums = [`price ${fmtTon(l.priceTon)}`];
  if (e) {
    nums.push(`all-in ${fmtTon(e.allInTon)}`);
    if (e.refTon !== null) nums.push(`${e.refKind} ${fmtTon(e.refTon)}`, `exit net ${fmtTon(e.exitNetTon)}`, `edge ${fmtSigned(e.edgeTon)}`);
    if (Number.isFinite(e.breakEvenTon)) nums.push(`break-even resale ${fmtTon(e.breakEvenTon)}`);
    nums.push(`fees from ${e.fees.source}`);
  }
  if (v?.fairValueTon !== null && v?.p25Ton !== undefined && v?.p25Ton !== null) nums.push(`p25-p75 ${fmtTon(v.p25Ton)}-${fmtTon(v.p75Ton)}`);
  if (alert.floorRefTon !== null && alert.floorRefTon !== undefined) nums.push(`floor ref ${fmtTon(alert.floorRefTon)}`);
  q.push(`<b>Numbers (${currency}):</b> ${nums.join(' · ')}`);
  if (alert.rule) q.push(`<b>Rule:</b> ${escapeHtml(alert.rule)}`);
  if (alert.dataAt) {
    const age = Math.max(0, Math.round((now - alert.dataAt) / 1000));
    const sync = alert.salesSyncedAt ? `, sales synced ${Math.max(0, Math.round((now - alert.salesSyncedAt) / 60_000))} min ago` : '';
    const src = alert.salesSource ? ` · ${escapeHtml(alert.salesSource)}` : '';
    q.push(`<b>Data:</b> listings ${age}s old${sync}${src}`);
  }
  lines.push(`<blockquote expandable>${q.join('\n')}</blockquote>`);
  lines.push(`<a href="${getgemsUrl(l)}">Open on Getgems</a>${alertId ? ` · alert #${alertId}` : ''}`);

  let html = lines.join('\n');
  if (html.length > MAX_MESSAGE) {
    html = html.replace(/<blockquote expandable>[\s\S]*<\/blockquote>\n/, '');
    if (html.length > MAX_MESSAGE) html = `${html.slice(0, MAX_MESSAGE - 20)}…`;
  }
  return html;
}

const REASON_TEXT = {
  round_trip: (days) => `round trip (sold back to its previous owner within ${days}d)`,
  same_wallet_pair: () => 'same wallet pair (the same two wallets traded repeatedly)',
  flagged_by_getgems: () => 'flagged by Getgems',
  outlier: () => 'outlier (far from the median)',
};

/** "2× round trip (…), 1× flagged by Getgems, 1× outlier" */
export function ignoredSummary(v, roundTripDays = 30) {
  const parts = [];
  for (const [k, fn] of Object.entries(REASON_TEXT)) {
    const n = v?.excluded?.[k] || 0;
    if (n) parts.push(`${n}× ${fn(roundTripDays)}`);
  }
  return parts.join(', ');
}

const day = (ms) => new Date(ms).toISOString().slice(5, 10);
const traitsShort = (a) => ['model', 'backdrop', 'symbol'].map((t) => a?.[t]).filter(Boolean).join('/') || Object.values(a || {}).slice(0, 2).join('/');

/**
 * "Comps" receipt for an alert: the sales the price uses and the ones it ignored.
 * @param {{listing:object, valuation:object}} alert
 * @param {{html?:boolean, roundTripDays?:number, currency?:string}} [o]
 */
export function formatComps(alert, { html = true, roundTripDays = 30, currency = 'TON' } = {}) {
  const v = alert.valuation;
  const l = alert.listing;
  const b = (s) => (html ? `<b>${s}</b>` : s);
  const esc = html ? escapeHtml : (s) => String(s ?? '');
  if (!v) return `No sales-based price for ${esc(l.name)}: the alert used the floor only.`;
  const lines = [];
  lines.push(b(`Why ${v.fairValueTon === null ? 'no fair value' : `${fmtTon(v.fairValueTon)} ${currency}`}?`));
  lines.push(
    v.fairValueTon === null
      ? esc(v.note)
      : `${esc(v.label)} · ${v.comparables} sales in ${v.lookbackDays ?? '?'}d · conf ${v.confidence}${v.spread !== null && v.spread !== undefined ? ` · spread ${Math.round(v.spread * 100)}%` : ''}${v.fallback ? ` · ${esc(v.note)}` : ''}`,
  );
  if (alert.salesSource) lines.push(esc(alert.salesSource));
  if (v.used?.length) {
    lines.push(b(`Used (${v.comparables}${v.used.length < v.comparables ? `, newest ${v.used.length} shown` : ''}):`));
    for (const u of v.used) {
      const url = getgemsUrl({ collection: l.collection, nft: u.nft });
      const link = html ? `<a href="${url}">getgems</a>` : url;
      lines.push(`• ${day(u.timeMs)} · ${fmtTon(u.priceTon)} ${currency} · ${esc(traitsShort(u.attrs))} · ${link}`);
    }
  }
  const ign = ignoredCount(v);
  if (ign) {
    lines.push(`${b(`Ignored (${ign}):`)} ${ignoredSummary(v, roundTripDays)}`);
    for (const s of v.excludedSamples || []) lines.push(`• ${day(s.timeMs)} · ${fmtTon(s.priceTon)} ${currency} · ${s.reason.replace(/_/g, ' ')}`);
  } else {
    lines.push('Ignored: none');
  }
  return lines.join('\n');
}

/** Fixed-width table for the `valuate` CLI command. */
export function formatValuationTable(rows, { limit = 50 } = {}) {
  const head = ['#', 'NFT', 'Price', 'Fair', 'Disc%', 'Conf', 'Ign', 'Level', 'N', 'Note'];
  const data = rows.slice(0, limit).map(({ listing, valuation, discountPct }, i) => [
    String(i + 1),
    listing.name.slice(0, 28),
    fmtTon(listing.priceTon),
    valuation.fairValueTon === null ? '-' : fmtTon(valuation.fairValueTon),
    discountPct === null ? '-' : discountPct.toFixed(1),
    valuation.confidence || '-',
    String(ignoredCount(valuation)),
    (valuation.label || '-').slice(0, 30),
    String(valuation.comparables),
    valuation.fallback ? valuation.note.slice(0, 80) : '',
  ]);
  const right = new Set([0, 2, 3, 4, 6, 8]);
  const widths = head.map((h, i) => Math.max(h.length, ...data.map((r) => r[i].length)));
  const fmt = (r) => r.map((c, i) => (right.has(i) ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ').trimEnd();
  return [fmt(head), widths.map((w) => '-'.repeat(w)).join('  '), ...data.map(fmt)].join('\n');
}

const MARK = { ok: '✅', warn: '⚠️', bad: '⛔' };

/** Manual Buy pre-check: "You pay 4.10 TON all-in → you receive Mock Pepe #1" + one line per check. */
export function formatPreview(pv, { mode = 'practice', currency = 'TON' } = {}) {
  const lines = [
    `${mode === 'live' ? '💸 LIVE' : '🧪 PRACTICE (paper buy)'} — You pay <b>${fmtTon(pv.allInTon)} ${currency} all-in</b> → you receive <b>${escapeHtml(pv.listing.name)}</b>`,
  ];
  for (const c of pv.checks) lines.push(`${MARK[c.status] || '•'} ${escapeHtml(c.text)}`);
  if (pv.level === 'red') lines.push('⛔ <b>Not safe to buy.</b> No confirm button for red items.');
  else if (pv.level === 'yellow') lines.push('⚠️ Check the warnings above before you confirm.');
  else lines.push('🟢 All checks passed.');
  return lines.join('\n');
}
