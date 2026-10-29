// Shared decision log. Every evaluation (alert, buy, skip, error, pause/resume) is written to the
// SQLite `decisions` table (so /why has data) and, when configured, appended to a JSONL file in
// the cross-bot schema suite.event.v1 (data/events.jsonl, rotated to .1 at EVENTS_MAX_MB).
// The validator is dependency-free so sibling bots' files can be checked the same way.

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';
import { getgemsUrl, looksLikeGift } from './models.js';

const log = createLogger('events');

export const EVENT_KINDS = ['alert', 'buy', 'skip', 'sell', 'error', 'pause', 'resume'];
export const EVENT_MODES = ['dry', 'live', 'shadow'];
export const SUBJECT_TYPES = ['gift', 'nft', 'token', 'market', 'wallet'];
export const CURRENCIES = ['TON', 'USDC', 'SOL', 'ETH'];
export const VERDICTS = ['BUY', 'WATCH', 'AVOID', 'SKIP', 'COPY'];
export const SEVERITIES = ['good', 'warn', 'bad'];

export function eventTsMs(e) {
  if (typeof e?.ts === 'number') return e.ts < 1e12 ? e.ts * 1000 : e.ts;
  const t = Date.parse(e?.ts);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Validate one suite.event.v1 object.
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateEvent(e) {
  const errors = [];
  if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, errors: ['event must be an object'] };
  if (e.v !== 1) errors.push('v must be 1');
  if (typeof e.bot !== 'string' || !e.bot) errors.push('bot is required');
  if (!EVENT_KINDS.includes(e.kind)) errors.push(`kind must be one of ${EVENT_KINDS.join('|')}`);
  if (!Number.isFinite(eventTsMs(e))) errors.push('ts must be an ISO time or epoch number');
  if (!EVENT_MODES.includes(e.mode)) errors.push(`mode must be one of ${EVENT_MODES.join('|')}`);
  if (typeof e.id !== 'string' || !e.id) errors.push('id is required');
  if (e.subject !== undefined && e.subject !== null) {
    if (!SUBJECT_TYPES.includes(e.subject.type)) errors.push('subject.type is invalid');
    if (typeof e.subject.ref !== 'string') errors.push('subject.ref must be a string');
  }
  if (e.money !== undefined && e.money !== null && !CURRENCIES.includes(e.money.ccy)) errors.push('money.ccy is invalid');
  if (e.verdict !== undefined && e.verdict !== null && !VERDICTS.includes(e.verdict)) errors.push('verdict is invalid');
  if (e.score !== undefined && e.score !== null && !(e.score >= 0 && e.score <= 100)) errors.push('score must be 0-100 or null');
  if (e.confidence !== undefined && e.confidence !== null && !['high', 'med', 'low'].includes(e.confidence)) errors.push('confidence is invalid');
  if (!Array.isArray(e.reasons)) errors.push('reasons must be an array');
  else {
    for (const r of e.reasons) {
      if (!r || typeof r.code !== 'string' || !SEVERITIES.includes(r.sev)) {
        errors.push('each reason needs {code, sev}');
        break;
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Append-only JSONL file with size-based rotation (file -> file.1). */
export class EventLog {
  /** @param {{file:string, maxMb?:number}} o */
  constructor({ file, maxMb = 20 }) {
    this.file = path.resolve(file);
    this.maxBytes = Math.max(1, Math.round(maxMb * 1024 * 1024));
  }

  append(event) {
    const v = validateEvent(event);
    if (!v.ok) throw new Error(`invalid event: ${v.errors.join('; ')}`);
    const line = `${JSON.stringify(event)}\n`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      size = 0;
    }
    if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) fs.renameSync(this.file, `${this.file}.1`);
    fs.appendFileSync(this.file, line);
  }
}

/**
 * Read events from a JSONL file. Malformed or schema-mismatched lines are skipped and counted.
 * @returns {{events: object[], bad: number}}
 */
export function readEvents(file, { sinceMs = 0 } = {}) {
  const text = fs.readFileSync(file, 'utf8');
  const events = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      bad++;
      continue;
    }
    if (!validateEvent(e).ok) {
      bad++;
      continue;
    }
    if (eventTsMs(e) >= sinceMs) events.push(e);
  }
  return { events, bad };
}

/** subject block for a listing. */
export function subjectOf(listing) {
  if (!listing) return null;
  return { type: looksLikeGift(listing.attrs) ? 'gift' : 'nft', ref: listing.nft, title: listing.name, url: getgemsUrl(listing) };
}

/** money block for an alert: price, reference, round-trip fees, net edge, USD. */
export function moneyOf(listing, alert, usdRate = null) {
  if (!listing) return null;
  const e = alert?.edge;
  const fees = e && e.refTon !== null ? e.allInTon - listing.priceTon + (e.refTon - e.exitNetTon) : null;
  return {
    ccy: 'TON',
    price: listing.priceTon,
    ref_price: e?.refTon ?? alert?.valuation?.fairValueTon ?? alert?.floorRefTon ?? null,
    fees: fees === null ? null : Math.round(fees * 1e4) / 1e4,
    net_edge: e?.edgeTon ?? null,
    usd: usdRate ? Math.round(listing.priceTon * usdRate * 100) / 100 : null,
  };
}

/**
 * Writes decisions to SQLite and (optionally) the JSONL event log.
 */
export class Journal {
  /**
   * @param {{storage: import('./storage.js').Storage, eventLog?: EventLog|null, bot?: string}} o
   */
  constructor({ storage, eventLog = null, bot = 'getgems-checker' }) {
    this.storage = storage;
    this.eventLog = eventLog;
    this.bot = bot;
    this.seq = 0;
  }

  /**
   * @param {Object} d
   * @param {'alert'|'buy'|'skip'|'sell'|'error'|'pause'|'resume'} d.kind
   * @param {'dry'|'live'|'shadow'} d.mode
   * @param {string} [d.id]            dedupe key
   * @param {number|null} [d.alertId]
   * @param {number|null} [d.buyId]
   * @param {import('./models.js').Listing|null} [d.listing]
   * @param {object|null} [d.alert]
   * @param {string|null} [d.verdict]
   * @param {string|null} [d.code]     main reason / block code
   * @param {{code:string, sev?:string, p?:object}[]} [d.reasons]
   * @param {string} [d.text]          plain-language line for /why
   * @param {number|null} [d.ruleId]
   * @param {string|null} [d.tx]
   * @param {number|null} [d.usdRate]
   */
  record(d) {
    const ts = Date.now();
    const id = d.id || `${d.kind}:${d.alertId ?? d.buyId ?? d.listing?.nft ?? 'x'}:${ts}:${++this.seq}`;
    const n = d.alert?.valuation?.comparables ?? 0;
    const event = {
      v: 1,
      ts: new Date(ts).toISOString(),
      bot: this.bot,
      kind: d.kind,
      mode: d.mode,
      id,
      subject: subjectOf(d.listing),
      money: moneyOf(d.listing, d.alert, d.usdRate ?? null),
      verdict: d.verdict ?? null,
      score: null,
      confidence: d.alert?.valuation ? (n >= 10 ? 'high' : n >= 4 ? 'med' : 'low') : null,
      reasons: (d.reasons || []).map((r) => ({ code: r.code, sev: r.sev || 'warn', p: r.p || {} })),
      rule_id: d.ruleId ?? null,
      tx: d.tx ?? null,
    };
    const decisionId = this.storage.addDecision({
      ts,
      kind: d.kind,
      mode: d.mode,
      eventId: id,
      alertId: d.alertId ?? null,
      buyId: d.buyId ?? null,
      nft: d.listing?.nft ?? null,
      collection: d.listing?.collection ?? null,
      title: d.listing?.name ?? null,
      code: d.code ?? null,
      verdict: d.verdict ?? null,
      text: d.text ?? '',
      payload: event,
    });
    if (this.eventLog) {
      try {
        this.eventLog.append(event);
      } catch (e) {
        log.warn('event log append failed:', e.message);
      }
    }
    return { decisionId, event };
  }
}
