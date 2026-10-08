// Shadow-first rules with an honest hindsight report.
// A new autobuy rule starts in state 'shadow' (SHADOW_NEW_RULES=true): when the engine decides
// the rule would buy, it records a shadow fill and never calls the executor, even when
// DRY_RUN=false. Each cycle the open fills are marked net of fees (current comparable fair value
// minus marketplace fee and royalty), and a fill whose listing disappeared within
// SNIPED_WINDOW_SEC counts as sniped (evidence the deal was real and someone else took it).
// After the trial a hindsight card offers [Go live] [Keep testing 24h] [Delete].
// Items skipped by a limit (max price, budget, hourly cap) are shadow-recorded too, so the digest
// can say what the limit cost.

import { exitNet } from './edge.js';
import { estimateFairValue } from './valuation.js';
import { reasonText } from './explain.js';
import { fmtSigned } from './models.js';
import { escapeHtml } from './format.js';

const HOUR = 3_600_000;

export class Shadow {
  /**
   * @param {{storage: import('./storage.js').Storage, cfg: import('./config.js').Config, journal?: import('./events.js').Journal|null}} o
   */
  constructor({ storage, cfg, journal = null }) {
    this.storage = storage;
    this.cfg = cfg;
    this.journal = journal;
  }

  #meta(alert, alertId, extra = {}) {
    const l = alert.listing;
    return {
      name: l.name,
      collection: l.collection,
      attrs: l.attrs,
      alertId: alertId ?? null,
      fairAtEntry: alert.valuation?.fairValueTon ?? null,
      allInTon: alert.edge?.allInTon ?? l.priceTon + this.cfg.networkCostTon,
      ...extra,
    };
  }

  /** A shadow rule would buy: record a fill. Never touches the executor. */
  record(rule, alert, alertId = null, now = Date.now()) {
    const l = alert.listing;
    if (this.storage.hasShadowFill(rule.id, l.nft)) return null;
    const id = this.storage.addShadowFill({
      ruleId: rule.id,
      subjectRef: l.nft,
      ts: now,
      entryPrice: l.priceTon,
      entryCosts: this.cfg.networkCostTon,
      executablePrice: l.priceTon,
      meta: this.#meta(alert, alertId),
    });
    this.journal?.record({
      kind: 'buy',
      mode: 'shadow',
      id: `shadow:${id}`,
      alertId,
      listing: l,
      alert,
      verdict: 'BUY',
      code: 'SHADOW_RULE',
      reasons: [{ code: 'SHADOW_RULE', sev: 'good', p: { rule: rule.id } }],
      text: reasonText('SHADOW_RULE', { rule: rule.id }),
      ruleId: rule.id,
    });
    return id;
  }

  /** Remember an item a limit blocked, to measure later what the limit cost. */
  recordSkip(alert, code, now = Date.now()) {
    const l = alert.listing;
    if (this.storage.hasShadowFill(null, l.nft, code)) return null;
    return this.storage.addShadowFill({
      ruleId: null,
      subjectRef: l.nft,
      ts: now,
      entryPrice: l.priceTon,
      entryCosts: this.cfg.networkCostTon,
      executablePrice: l.priceTon,
      meta: this.#meta(alert, null, { skipCode: code }),
    });
  }

  /**
   * Revalue the fills of one collection with the current cleaned comps and fees.
   * @param {{collection:string, listings: import('./models.js').Listing[], sales: import('./models.js').Sale[],
   *   params: import('./valuation.js').ValuationParams, fees: import('./edge.js').Fees, now:number, clean?:any}} a
   */
  mark({ collection, listings, sales, params, fees, now, clean }) {
    const present = new Set(listings.map((l) => l.nft));
    let n = 0;
    for (const f of this.storage.listShadowFills({ collection })) {
      const v = estimateFairValue({ attrs: f.meta.attrs }, sales, params, clean ? { clean } : {});
      const markPrice = v.fairValueTon === null ? null : exitNet(v.fairValueTon, fees, this.cfg);
      let outcome = f.outcome;
      let meta;
      if (outcome === 'open' && !present.has(f.subjectRef)) {
        const goneAfterSec = Math.max(0, Math.round((now - f.ts) / 1000));
        outcome = goneAfterSec <= this.cfg.snipedWindowSec ? 'sniped' : 'gone';
        meta = { ...f.meta, goneAfterSec };
      }
      this.storage.updateShadowFill(f.id, {
        markPrice,
        markTs: now,
        markSource: v.fairValueTon === null ? null : `fair ${v.label} minus fees`,
        outcome: outcome !== f.outcome ? outcome : undefined,
        meta,
      });
      n++;
    }
    return n;
  }

  /** Hindsight cards that are due now. */
  dueCards(now, { minHours = this.cfg.shadowMinHours, maxHours = this.cfg.shadowMaxHours, minMatches = this.cfg.shadowMinMatches } = {}) {
    const out = [];
    for (const rule of this.storage.listRules()) {
      if (rule.state !== 'shadow' || !rule.enabled) continue;
      const next = Number(this.storage.kvGet(`hindsight_next:${rule.id}`) || 0);
      if (next && now < next) continue;
      if (!next && this.storage.kvGet(`hindsight_sent:${rule.id}`)) continue;
      const fills = this.storage.listShadowFills({ ruleId: rule.id });
      const ageH = (now - (rule.createdAt || now)) / HOUR;
      const due = (ageH >= minHours && fills.length >= minMatches) || (ageH >= maxHours && fills.length >= 1);
      if (!due) continue;
      out.push({ rule, fills, summary: hindsightSummary(fills), ageH });
    }
    return out;
  }

  markCardSent(ruleId, now = Date.now()) {
    this.storage.kvSet(`hindsight_sent:${ruleId}`, String(now));
    this.storage.kvDel(`hindsight_next:${ruleId}`);
  }

  keepTesting(ruleId, now = Date.now(), hours = 24) {
    this.storage.kvSet(`hindsight_next:${ruleId}`, String(now + hours * HOUR));
  }

  /** The only way a rule goes from shadow to live. */
  promote(ruleId, now = Date.now()) {
    const r = this.storage.getRule(ruleId);
    if (!r) return { ok: false, error: `No rule #${ruleId}` };
    if (r.state === 'live') return { ok: true, already: true, rule: r };
    this.storage.setRuleState(ruleId, 'live', now);
    this.markCardSent(ruleId, now);
    return { ok: true, rule: this.storage.getRule(ruleId) };
  }

  deleteRule(ruleId) {
    this.storage.deleteShadowFills(ruleId);
    return this.storage.deleteRule(ruleId);
  }
}

/**
 * Totals of a rule's fills, net of fees. A sniped fill (the listing went to someone else within
 * SNIPED_WINDOW_SEC) would never have filled, so like a lost race on the paper scoreboard it is
 * only counted in `sniped`, never in the money numbers.
 */
export function hindsightSummary(fills) {
  let allIn = 0;
  let worth = 0;
  let best = null;
  let worst = null;
  let sniped = 0;
  for (const f of fills) {
    if (f.outcome === 'sniped') {
      sniped++;
      continue;
    }
    const cost = f.entryPrice + f.entryCosts;
    const mark = f.markPrice ?? cost;
    allIn += cost;
    worth += mark;
    const pnl = mark - cost;
    best = best === null ? pnl : Math.max(best, pnl);
    worst = worst === null ? pnl : Math.min(worst, pnl);
  }
  const pnl = worth - allIn;
  return { n: fills.length, filled: fills.length - sniped, allIn, worth, pnl, pnlPct: allIn > 0 ? (pnl / allIn) * 100 : 0, sniped, best: best ?? 0, worst: worst ?? 0 };
}

export function ruleLabel(rule, collectionName = null) {
  const coll = rule.collection === '*' ? 'Any collection' : collectionName || rule.collection.slice(0, 10);
  return `${coll} ≤ ${rule.maxPriceTon} TON${rule.minDiscountPct ? `, ≥ ${rule.minDiscountPct}% off` : ''}`;
}

/** Card text: "Rule #3 "…", 24h trial: would have bought 7 for 80.0 TON; worth 86.2 net now (+7.8%); …" */
export function formatHindsight(rule, s, { collectionName = null, ageH = 0, snipedWindowSec = 120, envLocked = true, currency = 'TON' } = {}) {
  const mins = Math.max(1, Math.round(snipedWindowSec / 60));
  const lines = [
    `🔭 <b>Rule #${rule.id} "${escapeHtml(ruleLabel(rule, collectionName))}"</b>, ${Math.round(ageH)}h trial: would have bought ${s.filled ?? s.n} for ${s.allIn.toFixed(1)} ${currency} all-in; ` +
      `worth ${s.worth.toFixed(1)} net now (${fmtSigned(s.pnlPct, 1)}%); ${s.sniped} of ${s.n} sold to someone else within ${mins} min (not counted); ` +
      `best ${fmtSigned(s.best, 1)}, worst ${fmtSigned(s.worst, 1)}`,
  ];
  if (envLocked) lines.push('Going live makes this rule paper-buy in practice mode; real buying also needs DRY_RUN=false in .env and /dry off.');
  return lines.join('\n');
}
