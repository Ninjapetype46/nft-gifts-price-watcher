// Autobuy rules, spending limits and the single guarded buy path (used by autobuy and the
// bot "Buy" button). Pure helpers are exported for tests; Buyer does the I/O.
//
// Order of checks in Buyer.#buy (cheap, offline checks first; nothing is signed before all pass):
//   always:     /panic and auto-pause (both stop every buy, the manual Confirm buy included)
//   auto only:  confidence grade -> rule conditions (net edge, liquidity, bid, cross-market)
//               -> alert-time safety checks (red blocks)
//   always:     limits on the all-in cost (max price, rolling 24h budget, hourly cap, duplicate)
//               -> re-read the listing -> buy-time safety checks (red blocks; yellow blocks
//               autobuy unless AUTOBUY_ALLOW_WARN covers it) -> build + validate the transaction
//   practice:   record a paper buy ("PRACTICE · Paper buy")
//   live:       confirm-above gate for autobuy, wallet balance, sign and send
// /panic and mode changes are re-read after every await and right before signing: a /panic (or
// /dry on) that arrives while a buy is being checked cancels it before wallet.send.
// Once wallet.send resolves the row is 'sent' and nothing afterwards can downgrade it; a send that
// throws after the transfer may have been broadcast stays 'pending' (counted against the limits).
// Every blocked attempt is stored with a reason_code and logged as a decision for /why.

import { ACTIVE_BUY_STATUSES } from './storage.js';
import { tonToNano, nanoToTon, fmtTon, plural } from './models.js';
import { sameAddress, toFriendly } from './address.js';
import { createLogger } from './logger.js';
import { escapeHtml } from './format.js';
import { assessRisk, failingIds, warnsAllowed } from './risk.js';
import { RiskFacts } from './riskfacts.js';
import { Journal } from './events.js';
import { blockReason, reasonText } from './explain.js';
import { noteExecutorResult, setAutoPause, autoPauseState } from './safety.js';

const log = createLogger('autobuy');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const CONF_RANK = { A: 3, B: 2, C: 1 };

/**
 * Discount used by rules: vs fair value when a valuation exists, otherwise vs floor reference.
 * @param {import('./detector.js').Alert} alert
 */
export function effectiveDiscountPct(alert) {
  if (alert.discountPct !== null && alert.discountPct !== undefined) return alert.discountPct;
  return alert.belowFloorPct ?? null;
}

/**
 * First enabled rule that matches (collection or "*", price <= max, discount >= min).
 * Rule conditions on net edge / liquidity / bids are checked by ruleGate().
 * @param {import('./detector.js').Alert} alert
 * @param {{id:number, collection:string, maxPriceTon:number, minDiscountPct:number, enabled:boolean}[]} rules
 */
export function findRule(alert, rules) {
  const disc = effectiveDiscountPct(alert);
  const l = alert.listing;
  return (
    rules.find(
      (r) =>
        r.enabled &&
        (r.collection === '*' || r.collection === l.collection) &&
        l.priceTon <= r.maxPriceTon &&
        disc !== null &&
        disc >= r.minDiscountPct,
    ) || null
  );
}

/** Why no rule matched (closest rule for this collection), for the /why trail. */
export function ruleMiss(alert, rules) {
  const l = alert.listing;
  const mine = rules.filter((r) => r.enabled && (r.collection === '*' || r.collection === l.collection));
  if (!mine.length) return null;
  const disc = effectiveDiscountPct(alert);
  const cheapEnough = mine.filter((r) => l.priceTon <= r.maxPriceTon);
  if (!cheapEnough.length) {
    const r = mine[0];
    return { code: 'PRICE_ABOVE_MAX', p: { cost: fmtTon(l.priceTon), max: fmtTon(r.maxPriceTon) }, ruleId: r.id };
  }
  const r = cheapEnough[0];
  return { code: 'DISCOUNT_TOO_SMALL', p: { pct: disc === null ? '?' : disc.toFixed(1), min: r.minDiscountPct }, ruleId: r.id };
}

/**
 * Rule conditions beyond price/discount: net edge, edge %, time to sell, bid cover, cross-market.
 * @returns {null | {code:string, text:string}}
 */
export function ruleGate(alert, rule, cfg = {}) {
  const e = alert.edge;
  if (rule.minEdgeTon !== null && rule.minEdgeTon !== undefined) {
    const edge = e?.edgeTon;
    if (edge === null || edge === undefined || edge < rule.minEdgeTon) {
      return { code: 'edge_low', text: `net edge ${edge === null || edge === undefined ? 'unknown' : fmtTon(edge)} < ${rule.minEdgeTon} TON after fees` };
    }
  }
  if (rule.minEdgePct !== null && rule.minEdgePct !== undefined) {
    const pct = e?.edgePct;
    if (pct === null || pct === undefined || pct < rule.minEdgePct) {
      return { code: 'edge_low', text: `net edge ${pct === null || pct === undefined ? 'unknown' : `${pct.toFixed(1)}%`} < ${rule.minEdgePct}% after fees` };
    }
  }
  if (rule.maxEtaDays !== null && rule.maxEtaDays !== undefined) {
    const eta = e?.liquidity?.etaDays;
    if (eta === null || eta === undefined || eta > rule.maxEtaDays) {
      return { code: 'eta_high', text: `time to sell ~${Number.isFinite(eta) ? eta.toFixed(0) : '∞'} days > ${rule.maxEtaDays} days` };
    }
  }
  if (rule.requireBid && !e?.exitBacked) return { code: 'no_bid', text: 'no open bid covers an instant exit' };
  const ce = alert.elsewhere?.cheaperElsewhere;
  if (rule.crossCheck !== false && ce) {
    return { code: 'cheaper_elsewhere', text: `${ce.title} has it ${ce.pct.toFixed(1)}% cheaper all-in (${fmtTon(ce.allInTon)} TON, CROSS_CHEAPER_PCT ${cfg.crossCheaperPct ?? 3})` };
  }
  return null;
}

/** Confidence the autobuy acts on: no valuation (floor only) counts as C unless allowed. */
export function confidenceOf(alert, cfg) {
  const v = alert?.valuation;
  if (v && v.fairValueTon !== null && v.fairValueTon !== undefined) return v.confidence || 'C';
  return cfg.autobuyAllowFloorOnly ? cfg.autobuyMinConfidence : 'C';
}

/**
 * Hard limits on the all-in cost. Only buys of the same mode (dry/live) with an active status
 * count; a paper buy that lost the race to a faster buyer would never have filled, so it does not.
 * @returns {{ok:true} | {ok:false, code:string, reason:string}}
 */
export function checkLimits({ priceTon, costTon = priceTon, nft, mode, buys, now, limits }) {
  const active = buys.filter((b) => b.mode === mode && ACTIVE_BUY_STATUSES.includes(b.status) && b.outcome !== 'lost_race');
  if (active.some((b) => b.nft === nft)) return { ok: false, code: 'already_bought', reason: 'this NFT was already bought' };
  if (costTon > limits.maxPriceTon + 1e-9) {
    return { ok: false, code: 'max_price', reason: `${costTon !== priceTon ? 'all-in' : 'price'} ${fmtTon(costTon)} > MAX_PRICE_TON ${fmtTon(limits.maxPriceTon)}` };
  }
  const spent = active.filter((b) => b.createdAt >= now - DAY).reduce((s, b) => s + (b.allInTon ?? b.priceTon), 0);
  if (spent + costTon > limits.dailyBudgetTon + 1e-9) {
    return {
      ok: false,
      code: 'budget',
      reason: `daily budget: spent ${fmtTon(spent)} + ${fmtTon(costTon)} > DAILY_BUDGET_TON ${fmtTon(limits.dailyBudgetTon)}`,
    };
  }
  const lastHour = active.filter((b) => b.createdAt >= now - HOUR).length;
  if (lastHour >= limits.maxBuysPerHour) {
    return { ok: false, code: 'rate', reason: `MAX_BUYS_PER_HOUR reached (${lastHour}/${limits.maxBuysPerHour})` };
  }
  return { ok: true };
}

/**
 * Direct purchase from a Getgems fixed-price sale contract (v3r2/v3r3/v4r1 accept an empty body = op 0):
 * value must be >= full_price + 0.1 TON (contract min_gas_amount); the excess comes back to the buyer
 * via the NFT transfer response. Bounce must be on.
 * TODO(verify): gas buffer for gift NFTs (BUY_GAS_TON, default 0.3) on a real purchase.
 * @param {import('./models.js').Listing} listing
 * @param {number} gasTon
 * @returns {import('./models.js').OutMessage[]}
 */
export function buildDirectBuyMessages(listing, gasTon) {
  if (!listing.saleContract) throw new Error('listing has no sale contract address');
  const amount = BigInt(listing.priceNano) + tonToNano(gasTon);
  return [{ to: listing.saleContract, amountNano: amount.toString(), payloadB64: null, stateInitB64: null, bounce: true }];
}

/**
 * Sanity checks on messages before signing (also for messages built by Getgems).
 * @returns {{ok:true, totalNano:bigint} | {ok:false, reason:string, totalNano:bigint}}
 */
export function validateBuyMessages(messages, { priceNano, maxExtraTon, saleContract = null }) {
  const total = messages.reduce((s, m) => s + BigInt(m.amountNano), 0n);
  const price = BigInt(priceNano);
  if (!messages.length) return { ok: false, reason: 'no messages', totalNano: total };
  if (messages.length > 4) return { ok: false, reason: `too many messages (${messages.length})`, totalNano: total };
  if (total < price) return { ok: false, reason: 'total is below the listing price', totalNano: total };
  if (total > price + tonToNano(maxExtraTon)) {
    return {
      ok: false,
      reason: `total ${fmtTon(nanoToTon(total), 3)} TON exceeds price + BUY_MAX_EXTRA_TON (${maxExtraTon})`,
      totalNano: total,
    };
  }
  if (saleContract && !messages.some((m) => sameAddress(m.to, saleContract))) {
    // Getgems may route via another contract; only log it.
    log.warn(`buy messages do not target the known sale contract ${toFriendly(saleContract)}`);
  }
  return { ok: true, totalNano: total };
}

// TonAPI interface names seen live: nft_sale_getgems_v3, nft_sale_getgems_v4.
const SALE_INTERFACES = /^nft_sale_getgems_v[34]$/;
const LIMIT_CODES = new Set(['max_price', 'budget', 'rate']);

/** Auto-pause block (errors in a row, unexplained balance drop, stale data): every buy waits for /resume. */
function autoPaused(storage) {
  const ap = autoPauseState(storage);
  return ap ? { code: 'auto_paused', text: `buying is auto-paused (${ap.reason}); check /doctor, then /resume` } : null;
}

/**
 * Has /panic, an auto-pause or the mode changed since a buy started in `mode`? Read from the
 * settings store every time (the same SQLite rows /panic and the engine write), so no flag can go stale.
 * @returns {null | {code:string, text:string}}
 */
export function interruption(settings, mode) {
  if (settings.panic) return { code: 'panic', text: '/panic was pressed while this buy was being checked' };
  const paused = settings.storage ? autoPaused(settings.storage) : null;
  if (paused) return paused;
  const now = settings.dryRun ? 'dry' : 'live';
  if (now !== mode) {
    return { code: 'mode_changed', text: `mode changed to ${now === 'dry' ? 'practice' : 'live'} while this buy was being checked` };
  }
  return null;
}

export class Buyer {
  /**
   * @param {Object} o
   * @param {import('./config.js').Config} o.cfg
   * @param {import('./settings.js').Settings} o.settings
   * @param {import('./storage.js').Storage} o.storage
   * @param {import('./clients/index.js').MarketClient} o.client
   * @param {import('./notifier.js').Notifier} o.notifier
   * @param {{inspectSaleContract: Function}|null} [o.chain]  TonAPI client for direct-path checks
   * @param {() => Promise<import('./wallet.js').TonWallet>} o.walletFactory
   * @param {RiskFacts} [o.riskFacts]
   * @param {Journal} [o.journal]
   * @param {import('./shadow.js').Shadow|null} [o.shadow]  records limit-skipped items for the digest
   */
  constructor({ cfg, settings, storage, client, notifier, chain = null, walletFactory, riskFacts, journal, shadow = null }) {
    Object.assign(this, { cfg, settings, storage, client, notifier, chain, walletFactory, shadow });
    this.riskFacts = riskFacts || new RiskFacts({ client, cfg });
    this.journal = journal || new Journal({ storage });
    this.queue = Promise.resolve();
    this.wallet = null;
  }

  /** Serialize buys so limits are checked against an up-to-date ledger. */
  buy(listing, ctx) {
    const run = this.queue.then(() => this.#buy(listing, ctx));
    this.queue = run.catch(() => {});
    return run;
  }

  async #plan(listing) {
    const tx = await this.client.getBuyTransaction(listing);
    if (tx) return { via: 'getgems buy-fix-price', messages: tx.messages };
    if (!this.chain) throw new Error('no way to build a purchase: source has no buy API and no TonAPI checker');
    if (listing.contractType && listing.contractType !== 'sale-contract') {
      throw new Error(`direct buy unsupported for contractType=${listing.contractType}`);
    }
    const sc = await this.chain.inspectSaleContract(listing.saleContract);
    if (!sc.interfaces.some((i) => SALE_INTERFACES.test(i))) {
      throw new Error(`sale contract is not a known Getgems fixprice contract (${sc.interfaces.join(',') || 'none'})`);
    }
    if (sc.isComplete) throw new Error('sale contract is already complete');
    if (sc.fullPriceNano !== listing.priceNano) throw new Error('on-chain full_price differs from the listing price');
    if (sc.nft && sc.nft !== listing.nft) throw new Error('sale contract belongs to another NFT');
    return { via: 'direct sale contract', messages: buildDirectBuyMessages(listing, this.cfg.buyGasTon) };
  }

  async #notify(text, extra) {
    try {
      await this.notifier.text(text, extra);
    } catch (e) {
      log.warn('notify failed:', e.message);
    }
  }

  #allIn(listing, alert) {
    const fromAlert = alert?.edge?.allInTon;
    return fromAlert !== undefined && fromAlert !== null && alert.listing?.priceNano === listing.priceNano ? fromAlert : listing.priceTon + this.cfg.networkCostTon;
  }

  /** Market-status hold: one notice per incident, cleared automatically when Getgems is up. */
  async #marketNotice(status) {
    if (status === undefined) return;
    if (status === 'up') {
      if (this.storage.kvGet('market_incident')) {
        this.storage.kvDel('market_incident');
        await this.#notify('✅ Getgems reports "up" again. Autopilot resumed.');
      }
      return;
    }
    if (this.storage.kvGet('market_incident')) return;
    this.storage.kvSet('market_incident', status);
    await this.#notify(`⚠️ Getgems reports "${escapeHtml(status)}". Autopilot is holding buys until it is back up.`);
  }

  /**
   * Shared steps of a buy and its preview: refresh -> risk -> plan -> validate. Never signs.
   * @returns {Promise<{ok:boolean, code?:string, text?:string, fresh?:object|null, risk?:any, plan?:any, totalNano?:bigint, facts?:any}>}
   */
  async #prepare(listing, ctx) {
    let fresh;
    try {
      fresh = await this.client.refreshListing(listing);
    } catch (e) {
      return { ok: false, code: 'gone', text: `re-check failed: ${e.message}` };
    }
    const facts = await this.riskFacts.buyTime(listing, fresh, ctx.alert ?? null);
    const risk = assessRisk(facts, this.cfg);
    if (!fresh) return { ok: false, code: 'gone', text: 'no longer on sale', fresh, risk, facts };
    if (BigInt(fresh.priceNano) > BigInt(listing.priceNano)) {
      return { ok: false, code: 'price_up', text: `price changed to ${fmtTon(fresh.priceTon)} TON`, fresh, risk, facts };
    }
    fresh = { ...listing, ...fresh, attrs: listing.attrs };
    let plan;
    try {
      plan = await this.#plan(fresh);
    } catch (e) {
      return { ok: false, code: 'plan_failed', text: `cannot build purchase: ${e.message}`, fresh, risk, facts };
    }
    const v = validateBuyMessages(plan.messages, { priceNano: fresh.priceNano, maxExtraTon: this.cfg.buyMaxExtraTon, saleContract: fresh.saleContract });
    if (!v.ok) return { ok: false, code: 'validate_failed', text: v.reason, fresh, risk, facts, plan };
    return { ok: true, fresh, risk, facts, plan, totalNano: v.totalNano };
  }

  /**
   * Pre-buy checklist for the manual Buy button: refresh, plan and validate, but never sign or send.
   * @returns {Promise<{level:'green'|'yellow'|'red', canConfirm:boolean, allInTon:number, checks:{id:string,status:string,text:string}[], listing:object, blocked?:string}>}
   */
  async preview(listing, ctx = {}) {
    const now = Date.now();
    const mode = this.settings.dryRun ? 'dry' : 'live';
    const allInTon = this.#allIn(listing, ctx.alert);
    const checks = [];
    const lim = checkLimits({ priceTon: listing.priceTon, costTon: allInTon, nft: listing.nft, mode, buys: this.storage.buysSince(now - DAY), now, limits: this.settings.limits(now) });
    checks.push(lim.ok ? { id: 'limits', status: 'ok', text: 'Within your limits' } : { id: 'limits', status: 'bad', text: lim.reason });
    const ap = autoPauseState(this.storage);
    if (ap) checks.push({ id: 'auto_pause', status: 'bad', text: `Buying is auto-paused: ${ap.reason}. Check /doctor, then /resume.` });
    const p = await this.#prepare(listing, ctx);
    if (p.risk) checks.push(...p.risk.checks);
    if (!p.ok && !['gone', 'price_up'].includes(p.code)) checks.push({ id: p.code, status: 'bad', text: p.text });
    const level = checks.some((c) => c.status === 'bad') ? 'red' : checks.some((c) => c.status === 'warn') ? 'yellow' : 'green';
    return { level, canConfirm: level !== 'red', allInTon, checks, listing: p.fresh || listing, blocked: p.ok ? undefined : p.text };
  }

  /**
   * wallet/balance/send threw. Errors before the transfer could leave the wallet (no wallet, low
   * balance, wallet.send failing with stage 'before_broadcast') mark the row 'failed'. Any other
   * wallet.send error may come after a broadcast, so the row stays 'pending' (status unknown) and
   * keeps counting against the budget, hourly cap and already-bought check.
   */
  async #sendFailed(e, { id, fresh, name, alert, ctx, now, attempted }) {
    const unknown = attempted && e.stage !== 'before_broadcast';
    const code = e.code === 'wallet_balance' ? 'wallet_balance' : unknown ? 'send_unknown' : 'send_failed';
    try {
      this.storage.updateBuy(id, { status: unknown ? 'pending' : 'failed', error: e.message, reasonCode: code });
    } catch (dbErr) {
      log.error(`buy #${id}: could not record the send error:`, dbErr.message);
    }
    log.error(`buy ${unknown ? 'status unknown' : 'failed'} ${fresh.name}:`, e.message);
    try {
      this.journal.record({ kind: 'error', mode: 'live', id: `error:${id}`, alertId: ctx.alertId ?? null, buyId: id, listing: fresh, alert, verdict: 'SKIP', code, reasons: [{ code: 'EXECUTION_ERROR', sev: 'bad', p: { error: e.message } }], text: `Buy ${unknown ? 'status unknown' : 'failed'}: ${e.message}`, ruleId: ctx.ruleId ?? null });
    } catch (jErr) {
      log.error(`buy #${id}: journal failed:`, jErr.message);
    }
    await this.#notify(
      unknown
        ? `⚠️ Buy status unknown: <b>${name}</b> — ${escapeHtml(e.message)}. The transfer may have gone out; it still counts against your limits. Check the wallet.`
        : `❌ Buy failed: <b>${name}</b> — ${escapeHtml(e.message)}`,
    );
    if (noteExecutorResult(this.storage, false, this.cfg)) {
      setAutoPause(this.storage, { code: 'errors', reason: `${this.cfg.autoPauseErrors} executor errors in a row (last: ${e.message})` }, now);
      await this.#notify(`⏸ Autopilot auto-paused: ${this.cfg.autoPauseErrors} buy errors in a row. Check /doctor, then /resume.`);
    }
    return { ok: false, status: unknown ? 'unknown' : 'failed', code, reason: e.message, buyId: id };
  }

  /**
   * @param {import('./models.js').Listing} listing
   * @param {{source:'auto'|'manual', ruleId?:number, alertId?:number, alert?:object, rule?:object}} ctx
   * @returns {Promise<{ok:boolean, status:string, code?:string, reason?:string, buyId?:number}>}
   */
  async #buy(listing, ctx) {
    const mode = this.settings.dryRun ? 'dry' : 'live';
    const now = Date.now();
    const name = escapeHtml(listing.name);
    const alert = ctx.alert ?? null;
    const allInTon = this.#allIn(listing, alert);
    const base = {
      nft: listing.nft,
      collection: listing.collection,
      name: listing.name,
      mode,
      source: ctx.source,
      ruleId: ctx.ruleId,
      alertId: ctx.alertId,
      fairTon: alert?.valuation?.fairValueTon ?? null,
      confidence: alert?.valuation?.fairValueTon !== null && alert?.valuation?.fairValueTon !== undefined ? alert.valuation.confidence : null,
      allInTon,
      edgeTon: alert?.edge?.edgeTon ?? null,
      riskLevel: alert?.risk?.level ?? null,
    };
    const journalMode = mode;

    /**
     * @param {{code:string, text:string}} b
     * @param {number|null} [rowId]  an already recorded 'pending' row to turn into 'blocked'
     */
    const blocked = async ({ code, text }, rowId = null) => {
      let id = rowId;
      if (id) this.storage.updateBuy(id, { status: 'blocked', error: text, reasonCode: code });
      else id = this.storage.recordBuy({ ...base, priceTon: listing.priceTon, status: 'blocked', error: text, reasonCode: code });
      log.info(`buy blocked ${listing.name}: ${code} — ${text}`);
      const reason = blockReason(code);
      this.journal.record({
        kind: 'skip',
        mode: journalMode,
        id: `skip:${id}`,
        alertId: ctx.alertId ?? null,
        buyId: id,
        listing,
        alert,
        verdict: 'SKIP',
        code,
        reasons: [{ code: reason, sev: 'bad', p: { code, text } }],
        text: `Not bought: ${text}`,
        ruleId: ctx.ruleId ?? null,
      });
      if (this.shadow && alert && LIMIT_CODES.has(code)) this.shadow.recordSkip(alert, code, now);
      await this.#notify(`⛔ ${mode === 'dry' ? 'PRACTICE · ' : ''}Buy blocked: <b>${name}</b> ${fmtTon(listing.priceTon)} TON — ${escapeHtml(text)}`);
      return { ok: false, status: 'blocked', code, reason: text, buyId: id };
    };

    // A buy queued behind another one may start after /panic: nothing is bought, not even on paper.
    if (this.settings.panic) return blocked({ code: 'panic', text: '/panic is on: all buying is stopped' });
    // Auto-pause stops every buy, the manual Confirm buy included, until /resume.
    const paused = autoPaused(this.storage);
    if (paused) return blocked(paused);

    if (ctx.source === 'auto') {
      if (alert) {
        const conf = confidenceOf(alert, this.cfg);
        const min = this.cfg.autobuyMinConfidence || 'B';
        if ((CONF_RANK[conf] || 0) < CONF_RANK[min]) {
          const note = alert.valuation?.note || 'no fair value (floor only)';
          return blocked({ code: 'confidence_low', text: `price confidence ${conf} is below the autobuy minimum ${min} (${note})` });
        }
        if (ctx.rule) {
          const g = ruleGate(alert, ctx.rule, this.cfg);
          if (g) return blocked(g);
        }
        if (alert.risk?.level === 'red') {
          const ids = failingIds(alert.risk, 'bad');
          const plain = alert.risk.checks.filter((c) => c.status === 'bad').map((c) => c.short).join(', ');
          return blocked({ code: `risk_red:${ids.join(',')}`, text: `safety check failed: ${plain}` });
        }
      }
    }

    const limits = this.settings.limits(now);
    const pre = checkLimits({ priceTon: listing.priceTon, costTon: allInTon, nft: listing.nft, mode, buys: this.storage.buysSince(now - DAY), now, limits });
    if (!pre.ok) return blocked({ code: pre.code, text: pre.reason });

    const p = await this.#prepare(listing, ctx);
    // #prepare awaited the network several times: /panic or /dry may have been pressed meanwhile.
    const midway = interruption(this.settings, mode);
    if (midway) return blocked(midway);
    if (ctx.source === 'auto') await this.#marketNotice(p.facts?.marketStatus);
    if (p.risk) {
      if (p.risk.level === 'red' && p.code !== 'gone' && p.code !== 'price_up') {
        const ids = failingIds(p.risk, 'bad');
        const plain = p.risk.checks.filter((c) => c.status === 'bad').map((c) => c.short).join(', ');
        return blocked({ code: `risk_red:${ids.join(',')}`, text: `safety check failed: ${plain}` });
      }
    }
    if (!p.ok) return blocked({ code: p.code, text: p.text });
    if (ctx.source === 'auto' && p.risk.level === 'yellow' && !warnsAllowed(p.risk, this.cfg.autobuyAllowWarn || [])) {
      const ids = failingIds(p.risk, 'warn');
      const plain = p.risk.checks.filter((c) => c.status === 'warn').map((c) => c.short).join(', ');
      return blocked({ code: `risk_warn:${ids.join(',')}`, text: `safety warning: ${plain}` });
    }
    const fresh = p.fresh;
    const plan = p.plan;
    const freshAllIn = fresh.priceTon + this.cfg.networkCostTon;
    if (fresh.priceTon !== listing.priceTon) {
      const again = checkLimits({ priceTon: fresh.priceTon, costTon: freshAllIn, nft: fresh.nft, mode, buys: this.storage.buysSince(now - DAY), now, limits });
      if (!again.ok) return blocked({ code: again.code, text: again.reason });
    }
    const totalTon = nanoToTon(p.totalNano);
    const dest = plan.messages.map((m) => {
      try {
        return toFriendly(m.to);
      } catch {
        return m.to;
      }
    });
    const record = { ...base, priceTon: fresh.priceTon, allInTon: freshAllIn, riskLevel: p.risk.level };

    if (mode === 'dry') {
      const id = this.storage.recordBuy({ ...record, totalTon, status: 'dry', txRef: plan.via });
      log.info(`practice: paper buy ${fresh.name} for ${fresh.priceTon} TON via ${plan.via}`);
      this.journal.record({
        kind: 'buy',
        mode: 'dry',
        id: `buy:${id}`,
        alertId: ctx.alertId ?? null,
        buyId: id,
        listing: fresh,
        alert,
        verdict: 'BUY',
        code: 'DRY_RUN',
        reasons: [{ code: 'DRY_RUN', sev: 'good' }],
        text: `Paper buy: ${reasonText('DRY_RUN')}`,
        ruleId: ctx.ruleId ?? null,
      });
      await this.#notify(
        `🧪 PRACTICE · Paper buy: <b>${name}</b> for ${fmtTon(fresh.priceTon)} TON (all-in ${fmtTon(freshAllIn)}; ` +
          `live would send ${fmtTon(totalTon, 3)} TON in ${plural(plan.messages.length, 'message')} to <code>${escapeHtml(dest.join(', '))}</code> via ${plan.via}; ` +
          `${ctx.source === 'auto' ? `autobuy${ctx.ruleId ? ` rule #${ctx.ruleId}` : ''}` : 'your Buy button'})`,
      );
      return { ok: true, status: 'dry', buyId: id };
    }

    // Live spend path: limits were checked above on the all-in cost; autobuy above CONFIRM_ABOVE asks first.
    if (ctx.source === 'auto' && freshAllIn > limits.confirmAboveTon) {
      return blocked({ code: 'confirm_above', text: `all-in ${fmtTon(freshAllIn)} > CONFIRM_ABOVE ${fmtTon(limits.confirmAboveTon)}: press Buy on the alert to confirm` });
    }
    const beforeWallet = interruption(this.settings, mode);
    if (beforeWallet) return blocked(beforeWallet);
    const id = this.storage.recordBuy({ ...record, totalTon, status: 'pending', txRef: plan.via });
    const failCtx = { id, fresh, name, alert, ctx, now };
    try {
      this.wallet ??= await this.walletFactory();
      const balance = await this.wallet.balanceNano();
      if (balance < p.totalNano + tonToNano('0.05')) {
        throw Object.assign(new Error(`wallet balance ${fmtTon(nanoToTon(balance), 3)} TON is not enough for ${fmtTon(totalTon, 3)} TON + fees`), { code: 'wallet_balance' });
      }
    } catch (e) {
      return this.#sendFailed(e, { ...failCtx, attempted: false });
    }
    // Last check before signing: the wallet and balance calls above were awaits too.
    const beforeSend = interruption(this.settings, mode);
    if (beforeSend) return blocked(beforeSend, id);
    let res;
    try {
      res = await this.wallet.send(plan.messages);
    } catch (e) {
      return this.#sendFailed(e, { ...failCtx, attempted: true });
    }

    // The transfer is out: mark it sent first, so the limits count it whatever happens next.
    const ref = `seqno ${res.seqno}${res.confirmed ? '' : ' (unconfirmed)'}`;
    try {
      this.storage.updateBuy(id, { status: 'sent', txRef: `${plan.via}; ${ref}` });
    } catch (e) {
      // The row stays 'pending', which the limits count as spent too.
      log.error(`buy #${id} was sent (${ref}) but could not be marked sent:`, e.message);
    }
    try {
      noteExecutorResult(this.storage, true, this.cfg);
      this.journal.record({ kind: 'buy', mode: 'live', id: `buy:${id}`, alertId: ctx.alertId ?? null, buyId: id, listing: fresh, alert, verdict: 'BUY', code: 'BOUGHT', reasons: [{ code: 'BOUGHT', sev: 'good', p: { price: fmtTon(fresh.priceTon), mode: 'live' } }], text: `Bought: ${ref}`, ruleId: ctx.ruleId ?? null, tx: ref });
    } catch (e) {
      log.error(`buy #${id} sent (${ref}); bookkeeping failed:`, e.message);
    }
    await this.#notify(`✅ Buy sent: <b>${name}</b> for ${fmtTon(fresh.priceTon)} TON from <code>${escapeHtml(this.wallet.address)}</code> (${ref})`);
    return { ok: true, status: 'sent', buyId: id };
  }
}
