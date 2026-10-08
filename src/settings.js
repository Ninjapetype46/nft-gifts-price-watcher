// Runtime settings: .env values are defaults, `/set` overrides are stored in SQLite.
// Spending limits from .env are hard ceilings: /set may lower them, never raise them, and a stored
// override above the current .env value (e.g. after .env was tightened) is clamped when read.
//
// Modes: "practice" (paper buys, recorded with mode 'dry') and "live" (real TON).
// DRY_RUN=true in .env is a hard lock: no bot command and no stored setting can override it, and
// opening the settings under the lock voids a stored live confirmation (so does /panic).
// Live needs DRY_RUN=false in .env AND an explicit bot confirmation (/dry off + button), and
// /panic forces practice until /resume + confirm. The first LIVE_RAMP_HOURS after going live
// only allow LIVE_RAMP_BUDGET_PCT of the daily budget.

/**
 * @typedef {Object} ParamDef
 * @property {keyof import('./config.js').Config} cfgKey
 * @property {'number'|'bool'} type
 * @property {string} help
 * @property {boolean} [ceiling]  value may not exceed the .env value
 * @property {number} [min]
 */

/** @type {Record<string, ParamDef>} */
export const PARAMS = {
  cheap_max_price: { cfgKey: 'cheapMaxPriceTon', type: 'number', help: 'alert if price <= X TON (0 = off)' },
  cheap_floor_pct: { cfgKey: 'cheapBelowFloorPct', type: 'number', help: 'alert if X% below floor (2nd cheapest)' },
  discount_pct: { cfgKey: 'undervaluedDiscountPct', type: 'number', help: 'alert if X% below fair value' },
  comparables: { cfgKey: 'comparablesN', type: 'number', help: 'use last N comparable sales', min: 1 },
  min_comparables: { cfgKey: 'minComparables', type: 'number', help: 'min sales per level before fallback', min: 1 },
  lookback_days: { cfgKey: 'lookbackDays', type: 'number', help: 'sales lookback window, days', min: 1 },
  time_weighted: { cfgKey: 'timeWeighted', type: 'bool', help: 'time-weighted median (on/off)' },
  half_life_days: { cfgKey: 'halfLifeDays', type: 'number', help: 'decay half-life for weighting, days', min: 0.1 },
  poll_interval: { cfgKey: 'pollIntervalSec', type: 'number', help: 'seconds between scans', min: 5 },
  cooldown_min: { cfgKey: 'alertCooldownMin', type: 'number', help: 'do not repeat an alert for N minutes' },
  max_price: { cfgKey: 'maxPriceTon', type: 'number', help: 'hard max price per buy, TON', ceiling: true },
  daily_budget: { cfgKey: 'dailyBudgetTon', type: 'number', help: 'max TON spent per rolling 24h', ceiling: true },
  max_buys_per_hour: { cfgKey: 'maxBuysPerHour', type: 'number', help: 'max buys per rolling hour', ceiling: true },
};

// dry_run defaults to true: even with DRY_RUN=false in .env the bot starts in practice mode
// until the owner confirms live mode in the bot.
const FLAG_KEYS = { dry_run: null, autobuy: 'autobuyEnabled', paused: null };
const FLAG_DEFAULTS = { dry_run: true, paused: false };
const HOUR = 3_600_000;

export function parseBool(v) {
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(s)) return true;
  if (['0', 'false', 'off', 'no'].includes(s)) return false;
  return null;
}

export class Settings {
  /**
   * @param {import('./config.js').Config} cfg
   * @param {import('./storage.js').Storage} storage
   */
  constructor(cfg, storage) {
    this.cfg = cfg;
    this.storage = storage;
    /** True when this open found a stored live confirmation under the DRY_RUN=true lock and voided it. */
    this.voidedLive = false;
    // DRY_RUN=true in .env voids any stored live confirmation. Otherwise unlocking .env later would
    // go LIVE at once with the old confirmation (no /dry off, no button) and skip the go-live ramp.
    if (cfg.dryRun && (storage.getSetting('flag:dry_run') === 'false' || storage.getSetting('live_since') !== null)) {
      this.setPractice();
      this.voidedLive = true;
    }
  }

  get(name) {
    const def = PARAMS[name];
    if (!def) throw new Error(`Unknown setting ${name}`);
    const stored = this.storage.getSetting(`param:${name}`);
    if (stored === null) return this.cfg[def.cfgKey];
    if (def.type === 'bool') return stored === 'true';
    const n = Number(stored);
    // .env is a hard ceiling at read time too: an override stored under an older, higher .env value
    // (via /set, /preset or a digest tune button) never lifts the current limit.
    if (def.ceiling) return Number.isFinite(n) ? Math.min(n, this.cfg[def.cfgKey]) : this.cfg[def.cfgKey];
    return n;
  }

  /** Stored overrides above the current .env ceiling (they are clamped; doctor warns about them). */
  overridesAboveCeiling() {
    const out = [];
    for (const [name, def] of Object.entries(PARAMS)) {
      if (!def.ceiling) continue;
      const stored = this.storage.getSetting(`param:${name}`);
      if (stored === null) continue;
      const n = Number(stored);
      if (!Number.isFinite(n) || n > this.cfg[def.cfgKey]) out.push({ name, stored: n, ceiling: this.cfg[def.cfgKey] });
    }
    return out;
  }

  /**
   * Validate and store an override.
   * @returns {{ok:true, value:any} | {ok:false, error:string}}
   */
  set(name, raw) {
    const def = PARAMS[name];
    if (!def) return { ok: false, error: `Unknown parameter "${name}". Known: ${Object.keys(PARAMS).join(', ')}` };
    if (String(raw).toLowerCase() === 'default') {
      this.storage.deleteSetting(`param:${name}`);
      return { ok: true, value: this.cfg[def.cfgKey] };
    }
    if (def.type === 'bool') {
      const b = parseBool(raw);
      if (b === null) return { ok: false, error: 'Expected on/off' };
      this.storage.setSetting(`param:${name}`, b);
      return { ok: true, value: b };
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < (def.min ?? 0)) return { ok: false, error: `Expected a number >= ${def.min ?? 0}` };
    if (def.ceiling && n > this.cfg[def.cfgKey]) {
      return { ok: false, error: `${name} cannot exceed the .env hard limit (${this.cfg[def.cfgKey]})` };
    }
    this.storage.setSetting(`param:${name}`, n);
    return { ok: true, value: n };
  }

  flag(name) {
    const stored = this.storage.getSetting(`flag:${name}`);
    if (stored !== null) return stored === 'true';
    const cfgKey = FLAG_KEYS[name];
    return cfgKey ? !!this.cfg[cfgKey] : (FLAG_DEFAULTS[name] ?? false);
  }

  setFlag(name, value) {
    if (!(name in FLAG_KEYS)) throw new Error(`Unknown flag ${name}`);
    this.storage.setSetting(`flag:${name}`, !!value);
  }

  /** Practice mode? True when .env locks it, /panic is on, or live was never confirmed. */
  get dryRun() {
    if (this.cfg.dryRun) return true;
    if (this.panic) return true;
    return this.flag('dry_run');
  }
  /** 'practice' | 'live' */
  get mode() {
    return this.dryRun ? 'practice' : 'live';
  }
  /** DRY_RUN=true in .env (hard lock). */
  get envLocked() {
    return !!this.cfg.dryRun;
  }
  get panic() {
    return this.storage.kvGet('panic') === '1';
  }
  /**
   * Confirmation generation. Every confirm button (Confirm buy, "Yes, spend real TON") carries the
   * epoch it was shown under; /panic and every mode change bump it, so older buttons stop working.
   * A counter, not a timestamp, so clock skew between Telegram and this host cannot reopen them.
   */
  confirmEpoch() {
    return Number(this.storage.kvGet('confirm_epoch') || 0);
  }
  bumpConfirmEpoch() {
    this.storage.kvSet('confirm_epoch', String(this.confirmEpoch() + 1));
  }
  /** /panic: stop all buying and force practice mode until /resume + confirm. */
  setPanic(on, now = Date.now()) {
    if (on) {
      this.storage.kvSet('panic', '1');
      this.storage.kvSet('panic_at', String(now));
      this.setFlag('dry_run', true);
      this.storage.deleteSetting('live_since');
      this.bumpConfirmEpoch();
    } else {
      this.storage.kvDel('panic');
    }
  }
  panicAt() {
    const v = Number(this.storage.kvGet('panic_at') || 0);
    return v || null;
  }
  /** Explicit bot confirmation of live mode. Refused while .env locks practice or panic is on. */
  confirmLive(now = Date.now()) {
    if (this.envLocked) throw new Error('DRY_RUN=true in .env is a hard lock');
    if (this.panic) throw new Error('/panic is on; /resume first');
    this.setFlag('dry_run', false);
    this.storage.setSetting('live_since', now);
    this.bumpConfirmEpoch();
  }
  /** Back to practice; clears the live ramp. */
  setPractice() {
    this.setFlag('dry_run', true);
    this.storage.deleteSetting('live_since');
    this.bumpConfirmEpoch();
  }
  liveSince() {
    const v = Number(this.storage.getSetting('live_since') || 0);
    return v || null;
  }
  /** Live ramp: reduced daily budget during the first LIVE_RAMP_HOURS of live mode. */
  ramp(now = Date.now()) {
    const since = this.liveSince();
    const hours = this.cfg.liveRampHours ?? 0;
    if (this.dryRun || !since || !(hours > 0)) return { active: false, pct: 100, untilMs: null };
    const untilMs = since + hours * HOUR;
    if (now >= untilMs) return { active: false, pct: 100, untilMs };
    return { active: true, pct: this.cfg.liveRampBudgetPct ?? 100, untilMs };
  }
  get autobuy() {
    return this.flag('autobuy');
  }
  get paused() {
    return this.flag('paused');
  }

  /** Limits enforced by checkLimits (all-in cost is compared, ramp applied while live). */
  limits(now = Date.now()) {
    const ramp = this.ramp(now);
    const budget = this.get('daily_budget');
    return {
      maxPriceTon: this.get('max_price'),
      dailyBudgetTon: ramp.active ? (budget * ramp.pct) / 100 : budget,
      maxBuysPerHour: this.get('max_buys_per_hour'),
      confirmAboveTon: Math.min(this.cfg.confirmAboveTon ?? Infinity, this.get('max_price')),
    };
  }

  /**
   * @param {number} [now]
   * @param {{sampled?: boolean}} [o]  sampled = sales come from a sample (TonAPI), see valuationParams
   * @returns {import('./detector.js').DetectParams}
   */
  detectParams(now = Date.now(), o = {}) {
    return {
      cheapMaxPriceTon: this.get('cheap_max_price'),
      cheapBelowFloorPct: this.get('cheap_floor_pct'),
      undervaluedDiscountPct: this.get('discount_pct'),
      valuation: this.valuationParams(now, o),
    };
  }

  /**
   * @param {number} [now]
   * @param {{sampled?: boolean}} [o]  true when the sales are a TonAPI sample: a thin sample then
   *   lowers the confidence grade one step (valuation.estimateFairValue)
   * @returns {import('./valuation.js').ValuationParams}
   */
  valuationParams(now = Date.now(), { sampled = false } = {}) {
    return {
      now,
      sampled,
      lookbackDays: this.get('lookback_days'),
      maxComparables: this.get('comparables'),
      minComparables: this.get('min_comparables'),
      timeWeighted: this.get('time_weighted'),
      halfLifeDays: this.get('half_life_days'),
      levels: this.cfg.valuationLevels,
      washFilter: this.cfg.washFilter ?? true,
      roundTripDays: this.cfg.washRoundTripDays ?? 30,
      pairMinRepeats: this.cfg.washPairMinRepeats ?? 2,
      madK: this.cfg.outlierMadK ?? 3,
      confAMinComps: this.cfg.confAMinComps ?? 8,
      confAMaxSpread: this.cfg.confAMaxSpread ?? 0.25,
      confBMaxSpread: this.cfg.confBMaxSpread ?? 0.5,
    };
  }

  describe() {
    return Object.entries(PARAMS).map(([name, def]) => ({ name, value: this.get(name), help: def.help }));
  }
}
