// Config from .env (dotenv) validated with zod. Every key is documented in .env.example.

import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

export class ConfigError extends Error {}

const bool = (def) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      if (typeof v === 'boolean') return v;
      const s = v.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(s)) return true;
      if (['0', 'false', 'no', 'off'].includes(s)) return false;
      ctx.addIssue({ code: 'custom', message: `expected true/false, got "${v}"` });
      return z.NEVER;
    });

const num = (def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `expected a number in [${min}, ${max}], got "${v}"` });
        return z.NEVER;
      }
      return n;
    });

const str = (def = '') => z.string().optional().transform((v) => (v === undefined ? def : v.trim()));

const list = () =>
  z
    .string()
    .optional()
    .transform((v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean));

const lowerList = (def) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

const hhmm = (def) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      const s = v === undefined ? def : v.trim();
      if (!s || s === 'off') return '';
      if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(s)) {
        ctx.addIssue({ code: 'custom', message: `expected HH:MM or empty, got "${v}"` });
        return z.NEVER;
      }
      return s;
    });

const timeZone = (def) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      const s = v === undefined || v.trim() === '' ? def : v.trim();
      try {
        new Intl.DateTimeFormat('en-GB', { timeZone: s });
        return s;
      } catch {
        ctx.addIssue({ code: 'custom', message: `unknown time zone "${s}"` });
        return z.NEVER;
      }
    });

const optNum = () =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        ctx.addIssue({ code: 'custom', message: `expected a non-negative number or empty, got "${v}"` });
        return z.NEVER;
      }
      return n;
    });

const ids = () =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      const parts = (v || '').split(',').map((s) => s.trim()).filter(Boolean);
      const out = [];
      for (const p of parts) {
        if (!/^-?\d+$/.test(p)) {
          ctx.addIssue({ code: 'custom', message: `"${p}" is not an integer Telegram id` });
          return z.NEVER;
        }
        out.push(Number(p));
      }
      return out;
    });

const schema = z.object({
  BOT_TOKEN: str(),
  ADMIN_IDS: ids(),
  ALERT_CHAT_IDS: ids(),

  DATA_SOURCE: z.enum(['auto', 'getgems', 'tonapi']).optional().default('auto'),
  GETGEMS_API_KEY: str(),
  GETGEMS_API_BASE: str('https://api.getgems.io/public-api'),
  GETGEMS_INCLUDE_OFFCHAIN: bool(false),
  TONAPI_KEY: str(),
  TONAPI_BASE: str('https://tonapi.io/v2'),
  TONAPI_SCAN_ITEMS: num(1000, { min: 100, max: 100_000 }),
  TONAPI_HISTORY_ITEMS: num(60, { min: 1, max: 10_000 }),
  TONAPI_HISTORY_TTL_MIN: num(360, { min: 1, max: 100_000 }),
  REQUEST_MIN_INTERVAL_MS: num(800, { min: 0, max: 60_000 }),

  WATCH_COLLECTIONS: list(),
  LISTING_PAGES: num(1, { min: 1, max: 20 }),
  POLL_INTERVAL_SEC: num(60, { min: 5, max: 86_400 }),
  ALERT_COOLDOWN_MIN: num(360, { min: 0, max: 100_000 }),

  CHEAP_MAX_PRICE_TON: num(0),
  CHEAP_BELOW_FLOOR_PCT: num(15, { max: 100 }),

  UNDERVALUED_DISCOUNT_PCT: num(25, { max: 100 }),
  VALUATION_LEVELS: str('model,backdrop,symbol,collection'),
  COMPARABLES_N: num(20, { min: 1, max: 1000 }),
  MIN_COMPARABLES: num(3, { min: 1, max: 1000 }),
  LOOKBACK_DAYS: num(30, { min: 1, max: 3650 }),
  TIME_WEIGHTED: bool(true),
  HALF_LIFE_DAYS: num(7, { min: 0.1, max: 3650 }),
  SALES_REFRESH_MIN: num(30, { min: 1, max: 100_000 }),
  SALES_MAX_PAGES: num(5, { min: 1, max: 100 }),

  DRY_RUN: bool(true),
  AUTOBUY_ENABLED: bool(false),
  MAX_PRICE_TON: num(20),
  DAILY_BUDGET_TON: num(50),
  MAX_BUYS_PER_HOUR: num(2, { max: 1000 }),
  BUY_GAS_TON: num(0.3, { min: 0.1, max: 5 }),
  BUY_MAX_EXTRA_TON: num(1.5, { min: 0, max: 10 }),

  WALLET_MNEMONIC: str(),
  WALLET_VERSION: z.enum(['v4r2', 'v5r1']).optional().default('v4r2'),
  TON_RPC_ENDPOINT: str('https://toncenter.com/api/v2/jsonRPC'),
  TONCENTER_API_KEY: str(),

  // Honest price (clean comps, confidence)
  WASH_FILTER: bool(true),
  WASH_ROUNDTRIP_DAYS: num(30, { max: 3650 }),
  WASH_PAIR_MIN_REPEATS: num(2, { min: 2, max: 1000 }),
  OUTLIER_MAD_K: num(3, { max: 100 }),
  CONF_A_MIN_COMPS: num(8, { min: 1, max: 1000 }),
  CONF_A_MAX_SPREAD: num(0.25, { max: 100 }),
  CONF_B_MAX_SPREAD: num(0.5, { max: 100 }),
  AUTOBUY_MIN_CONFIDENCE: z.enum(['A', 'B']).optional().default('B'),
  AUTOBUY_ALLOW_FLOOR_ONLY: bool(false),

  // Real profit card
  NETWORK_COST_TON: num(0.1, { max: 5 }),
  SELL_COST_TON: num(0.1, { max: 5 }),
  MARKET_FEE_PCT_FALLBACK: num(5, { max: 50 }),
  ROYALTY_PCT_FALLBACK: num(5, { max: 50 }),
  CURRENCY_LABEL: str('TON'),
  FIAT_CURRENCIES: lowerList('usd'),
  RATES_TTL_MIN: num(10, { min: 0.1, max: 10_000 }),
  OFFERS_ENABLED: bool(true),
  OFFERS_TTL_MIN: num(5, { max: 10_000 }),
  OFFERS_MAX_CALLS_PER_CYCLE: num(10, { max: 1000 }),
  BID_COVER_MIN_EDGE_TON: num(0.3, { max: 100_000 }),
  NEGATIVE_EDGE_ALERTS: z.enum(['silent', 'drop', 'push']).optional().default('silent'),
  LIQ_FAST_DAYS: num(3, { max: 3650 }),
  LIQ_SLOW_DAYS: num(14, { max: 3650 }),
  LIQ_ILLIQUID_DAYS: num(30, { max: 3650 }),
  OFFCHAIN_NOTE: str('Off-chain gift: it stays in your Getgems account; withdrawing it to Telegram costs a fee.'),
  TELEMINT_NOTE: str('Telemint sale (Fragment-style item).'),

  // Safe-to-buy traffic light
  RISK_TOO_GOOD_PCT: num(35, { max: 100 }),
  AUTOBUY_ALLOW_WARN: lowerList(''),
  RISK_STATUS_TTL_SEC: num(60, { max: 86_400 }),
  SELLER_INFO_TTL_MIN: num(60, { max: 100_000 }),
  GIFT_COLLECTION_ALLOWLIST: list(),

  // Portfolio
  PORTFOLIO_MAX_COLLECTIONS: num(15, { min: 1, max: 500 }),
  PORTFOLIO_DAILY_HOUR: num(10, { min: -1, max: 23 }),
  PORTFOLIO_MAX_ALERTS_PER_DAY: num(3, { max: 100 }),
  UNDERPRICE_PCT: num(15, { max: 100 }),
  OFFER_ABOVE_EXIT_PCT: num(5, { max: 1000 }),
  PORTFOLIO_DROP_ALERT_PCT: num(20, { min: 1, max: 100 }),

  // Paper autopilot and go-live ramp
  LOST_RACE_SEC: num(30, { max: 86_400 }),
  PAPER_MARK_EVERY_MIN: num(60, { max: 100_000 }),
  PAPER_REPORT_HOUR: num(21, { min: -1, max: 23 }),
  PAPER_MIN_DAYS: num(7, { max: 3650 }),
  PAPER_MIN_BUYS: num(3, { max: 100_000 }),
  GOLIVE_REQUIRE_PAPER: bool(false),
  LIVE_RAMP_HOURS: num(24, { max: 10_000 }),
  LIVE_RAMP_BUDGET_PCT: num(25, { min: 1, max: 100 }),

  // Explained decisions, events, digest
  EVENTS_FILE: str('./data/events.jsonl'),
  EVENTS_MAX_MB: num(20, { min: 0.001, max: 10_000 }),
  DIGEST_AT: hhmm('21:00'),
  DIGEST_TZ: timeZone('Europe/Moscow'),
  PEER_EVENT_FILES: list(),
  ANTHROPIC_API_KEY: str(),
  ANTHROPIC_MODEL: str('claude-sonnet-5-5'),

  // Shadow rules and safety envelope
  SHADOW_NEW_RULES: bool(true),
  SHADOW_MIN_HOURS: num(24, { max: 100_000 }),
  SHADOW_MIN_MATCHES: num(5, { min: 1, max: 100_000 }),
  SHADOW_MAX_HOURS: num(168, { max: 100_000 }),
  SNIPED_WINDOW_SEC: num(120, { max: 86_400 }),
  AUTO_PAUSE_ERRORS: num(5, { min: 1, max: 1000 }),
  AUTO_PAUSE_BALANCE_DROP_PCT: num(30, { min: 1, max: 100 }),
  STALE_DATA_SEC: num(300, { min: 10, max: 864_000 }),
  HOT_WALLET_WARN_X: num(3, { min: 1, max: 1000 }),
  CONFIRM_ABOVE: optNum(),

  // Gift floor beacon
  FLOORS_FILE: str('./data/floors.json'),
  PEER_FLOORS: list(),
  PEER_MAX_AGE_SEC: num(300, { min: 1, max: 864_000 }),
  CROSS_CHEAPER_PCT: num(3, { max: 100 }),

  DB_PATH: str('./data/getgems.db'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional().default('info'),
});

/** Every .env key the bot reads (documented in .env.example and README). */
export const CONFIG_KEYS = Object.keys(schema.shape);

/** @typedef {ReturnType<typeof buildConfig>} Config */

function buildConfig(env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid .env values:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const levels = e.VALUATION_LEVELS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return {
    botToken: e.BOT_TOKEN,
    adminIds: e.ADMIN_IDS,
    alertChatIds: e.ALERT_CHAT_IDS.length ? e.ALERT_CHAT_IDS : e.ADMIN_IDS,

    dataSource: e.DATA_SOURCE,
    getgemsApiKey: e.GETGEMS_API_KEY,
    getgemsApiBase: e.GETGEMS_API_BASE.replace(/\/+$/, ''),
    getgemsIncludeOffchain: e.GETGEMS_INCLUDE_OFFCHAIN,
    tonapiKey: e.TONAPI_KEY,
    tonapiBase: e.TONAPI_BASE.replace(/\/+$/, ''),
    tonapiScanItems: e.TONAPI_SCAN_ITEMS,
    tonapiHistoryItems: e.TONAPI_HISTORY_ITEMS,
    tonapiHistoryTtlMin: e.TONAPI_HISTORY_TTL_MIN,
    requestMinIntervalMs: e.REQUEST_MIN_INTERVAL_MS,

    watchCollections: e.WATCH_COLLECTIONS,
    listingPages: e.LISTING_PAGES,
    pollIntervalSec: e.POLL_INTERVAL_SEC,
    alertCooldownMin: e.ALERT_COOLDOWN_MIN,

    cheapMaxPriceTon: e.CHEAP_MAX_PRICE_TON,
    cheapBelowFloorPct: e.CHEAP_BELOW_FLOOR_PCT,

    undervaluedDiscountPct: e.UNDERVALUED_DISCOUNT_PCT,
    valuationLevels: levels.length ? levels : ['collection'],
    comparablesN: e.COMPARABLES_N,
    minComparables: e.MIN_COMPARABLES,
    lookbackDays: e.LOOKBACK_DAYS,
    timeWeighted: e.TIME_WEIGHTED,
    halfLifeDays: e.HALF_LIFE_DAYS,
    salesRefreshMin: e.SALES_REFRESH_MIN,
    salesMaxPages: e.SALES_MAX_PAGES,

    dryRun: e.DRY_RUN,
    autobuyEnabled: e.AUTOBUY_ENABLED,
    maxPriceTon: e.MAX_PRICE_TON,
    dailyBudgetTon: e.DAILY_BUDGET_TON,
    maxBuysPerHour: e.MAX_BUYS_PER_HOUR,
    buyGasTon: e.BUY_GAS_TON,
    buyMaxExtraTon: e.BUY_MAX_EXTRA_TON,

    walletMnemonic: e.WALLET_MNEMONIC,
    walletVersion: e.WALLET_VERSION,
    tonRpcEndpoint: e.TON_RPC_ENDPOINT,
    toncenterApiKey: e.TONCENTER_API_KEY,

    washFilter: e.WASH_FILTER,
    washRoundTripDays: e.WASH_ROUNDTRIP_DAYS,
    washPairMinRepeats: e.WASH_PAIR_MIN_REPEATS,
    outlierMadK: e.OUTLIER_MAD_K,
    confAMinComps: e.CONF_A_MIN_COMPS,
    confAMaxSpread: e.CONF_A_MAX_SPREAD,
    confBMaxSpread: e.CONF_B_MAX_SPREAD,
    autobuyMinConfidence: e.AUTOBUY_MIN_CONFIDENCE,
    autobuyAllowFloorOnly: e.AUTOBUY_ALLOW_FLOOR_ONLY,

    networkCostTon: e.NETWORK_COST_TON,
    sellCostTon: e.SELL_COST_TON,
    marketFeePctFallback: e.MARKET_FEE_PCT_FALLBACK,
    royaltyPctFallback: e.ROYALTY_PCT_FALLBACK,
    currencyLabel: e.CURRENCY_LABEL || 'TON',
    fiatCurrencies: e.FIAT_CURRENCIES,
    ratesTtlMin: e.RATES_TTL_MIN,
    offersEnabled: e.OFFERS_ENABLED,
    offersTtlMin: e.OFFERS_TTL_MIN,
    offersMaxCallsPerCycle: e.OFFERS_MAX_CALLS_PER_CYCLE,
    bidCoverMinEdgeTon: e.BID_COVER_MIN_EDGE_TON,
    negativeEdgeAlerts: e.NEGATIVE_EDGE_ALERTS,
    liqFastDays: e.LIQ_FAST_DAYS,
    liqSlowDays: e.LIQ_SLOW_DAYS,
    liqIlliquidDays: e.LIQ_ILLIQUID_DAYS,
    offchainNote: e.OFFCHAIN_NOTE,
    telemintNote: e.TELEMINT_NOTE,

    riskTooGoodPct: e.RISK_TOO_GOOD_PCT,
    autobuyAllowWarn: e.AUTOBUY_ALLOW_WARN,
    riskStatusTtlSec: e.RISK_STATUS_TTL_SEC,
    sellerInfoTtlMin: e.SELLER_INFO_TTL_MIN,
    giftCollectionAllowlist: e.GIFT_COLLECTION_ALLOWLIST,

    portfolioMaxCollections: e.PORTFOLIO_MAX_COLLECTIONS,
    portfolioDailyHour: e.PORTFOLIO_DAILY_HOUR,
    portfolioMaxAlertsPerDay: e.PORTFOLIO_MAX_ALERTS_PER_DAY,
    underpricePct: e.UNDERPRICE_PCT,
    offerAbovePct: e.OFFER_ABOVE_EXIT_PCT,
    portfolioDropAlertPct: e.PORTFOLIO_DROP_ALERT_PCT,

    lostRaceSec: e.LOST_RACE_SEC,
    paperMarkEveryMin: e.PAPER_MARK_EVERY_MIN,
    paperReportHour: e.PAPER_REPORT_HOUR,
    paperMinDays: e.PAPER_MIN_DAYS,
    paperMinBuys: e.PAPER_MIN_BUYS,
    goliveRequirePaper: e.GOLIVE_REQUIRE_PAPER,
    liveRampHours: e.LIVE_RAMP_HOURS,
    liveRampBudgetPct: e.LIVE_RAMP_BUDGET_PCT,

    eventsFile: path.resolve(e.EVENTS_FILE),
    eventsMaxMb: e.EVENTS_MAX_MB,
    digestAt: e.DIGEST_AT,
    digestTz: e.DIGEST_TZ,
    peerEventFiles: e.PEER_EVENT_FILES,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    anthropicModel: e.ANTHROPIC_MODEL || 'claude-sonnet-5-5',

    shadowNewRules: e.SHADOW_NEW_RULES,
    shadowMinHours: e.SHADOW_MIN_HOURS,
    shadowMinMatches: e.SHADOW_MIN_MATCHES,
    shadowMaxHours: e.SHADOW_MAX_HOURS,
    snipedWindowSec: e.SNIPED_WINDOW_SEC,
    autoPauseErrors: e.AUTO_PAUSE_ERRORS,
    autoPauseBalanceDropPct: e.AUTO_PAUSE_BALANCE_DROP_PCT,
    staleDataSec: e.STALE_DATA_SEC,
    hotWalletWarnX: e.HOT_WALLET_WARN_X,
    // CONFIRM_ABOVE defaults to half of MAX_PRICE_TON.
    confirmAboveTon: e.CONFIRM_ABOVE ?? e.MAX_PRICE_TON * 0.5,

    floorsFile: path.resolve(e.FLOORS_FILE),
    peerFloors: e.PEER_FLOORS,
    peerMaxAgeSec: e.PEER_MAX_AGE_SEC,
    crossCheaperPct: e.CROSS_CHEAPER_PCT,

    dbPath: path.resolve(e.DB_PATH),
    logLevel: e.LOG_LEVEL,
  };
}

/**
 * Load .env (if present) and validate.
 * @param {{env?: Record<string,string|undefined>, dotenvPath?: string}} [opts]
 */
export function loadConfig({ env, dotenvPath } = {}) {
  if (!env) {
    dotenv.config({ path: dotenvPath || path.resolve('.env'), quiet: true });
    env = process.env;
  }
  return buildConfig(env);
}

const KEY_HINTS = {
  BOT_TOKEN: 'Telegram bot token from @BotFather',
  ADMIN_IDS: 'comma-separated Telegram user ids allowed to use the bot',
  GETGEMS_API_KEY: 'Getgems Public API key (https://getgems.io/public-api), or set DATA_SOURCE=tonapi',
  WALLET_MNEMONIC: '24-word mnemonic of the buying wallet (only needed when DRY_RUN=false)',
};

/** Throw one clear error naming the missing .env keys. */
export function requireKeys(cfg, keys) {
  const map = {
    BOT_TOKEN: cfg.botToken,
    ADMIN_IDS: cfg.adminIds.length ? 'x' : '',
    GETGEMS_API_KEY: cfg.getgemsApiKey,
    WALLET_MNEMONIC: cfg.walletMnemonic,
  };
  const missing = keys.filter((k) => !map[k]);
  if (missing.length) {
    const lines = missing.map((k) => `  ${k} — ${KEY_HINTS[k] || ''}`);
    throw new ConfigError(`Missing required .env ${missing.length === 1 ? 'key' : 'keys'}:\n${lines.join('\n')}`);
  }
}
