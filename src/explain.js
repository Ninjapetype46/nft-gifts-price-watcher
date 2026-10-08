// Explained decisions: machine-readable reason codes and their plain-English templates.
// Codes are shared with the sibling bots (suite.event.v1); their text lives only here.
// All bot strings are English.
//
// The optional [Explain more] button sends one event JSON to the Claude Messages API when
// ANTHROPIC_API_KEY is set. Without a key nothing is sent and the button is hidden.

/** @typedef {'good'|'warn'|'bad'} Sev */

/**
 * en: the sentence used in /why, alert reasons and events; label: a short plain name for
 * summaries (scoreboard, digest). `{n|one|many}` picks a word by the number in p.n.
 * @type {Record<string, {sev: Sev, en: string, label: string}>}
 */
export const REASONS = {
  // Shared suite codes
  BELOW_FLOOR: { sev: 'good', en: '{pct}% below the next cheapest listing ({floor} TON)', label: 'below floor' },
  BELOW_FAIR: { sev: 'good', en: '{pct}% below fair value {fair} TON ({basis})', label: 'below fair value' },
  FEW_COMPS: { sev: 'warn', en: 'thin or mixed data ({n} comparable {n|sale|sales}, confidence {grade}): rough estimate', label: 'thin price data' },
  FEES_EAT_PROFIT: { sev: 'bad', en: 'after fees and royalty you would keep {edge} TON', label: 'no profit after fees' },
  PRICE_ABOVE_MAX: { sev: 'bad', en: 'all-in {cost} TON is above the max price {max} TON', label: 'above the max price' },
  DISCOUNT_TOO_SMALL: { sev: 'warn', en: 'discount {pct}% is below the rule minimum {min}%', label: 'discount below the rule minimum' },
  LIMIT_DAILY_BUDGET: { sev: 'bad', en: 'daily budget: {spent}/{budget} TON used in the last 24h (frees up as older buys age out)', label: 'daily budget used up' },
  LIMIT_HOURLY: { sev: 'bad', en: 'hourly cap: {used}/{cap} buys in the last hour', label: 'hourly buy cap reached' },
  DRY_RUN: { sev: 'good', en: 'practice mode: recorded as a paper buy, no TON spent', label: 'paper buy' },
  PAUSED: { sev: 'bad', en: 'autopilot is paused: {why}', label: 'autopilot paused' },
  SHADOW_RULE: { sev: 'good', en: 'rule #{rule} is in shadow mode: the would-be buy is recorded, never executed', label: 'shadow rule' },
  MUTED: { sev: 'warn', en: '{subject} is muted until {until}', label: 'muted' },
  CHEAPER_ELSEWHERE: { sev: 'bad', en: '{market} has it {pct}% cheaper all-in ({price} TON)', label: 'cheaper on another market' },
  // Getgems / gift codes
  WASHY_COMPS: { sev: 'good', en: '{n} wash or flagged {n|sale was|sales were} left out of the price', label: 'wash sales left out' },
  SMALL_SAMPLE: { sev: 'warn', en: 'sales come from a small TonAPI sample, so confidence was lowered to {grade}', label: 'small sales sample' },
  UNDER_PRICE_CAP: { sev: 'good', en: 'price {price} TON is at or under your cap {cap} TON', label: 'under your price cap' },
  EXIT_BACKED: { sev: 'good', en: 'an open bid pays {bid} TON net right now ({edge} TON vs all-in)', label: 'open bid covers the exit' },
  FAST_SELLER: { sev: 'good', en: 'similar items sell in about {eta} days', label: 'sells fast' },
  LOW_LIQUIDITY: { sev: 'warn', en: 'slow to resell: about {eta} days for similar items', label: 'slow to resell' },
  LOW_CONFIDENCE: { sev: 'bad', en: 'price confidence {grade} is below the autobuy minimum {min}', label: 'low price confidence' },
  RISK_RED: { sev: 'bad', en: 'safety check failed: {checks}', label: 'failed a safety check' },
  RISK_WARN: { sev: 'warn', en: 'safety warning: {checks}', label: 'safety warning' },
  NO_BID: { sev: 'warn', en: 'the rule needs an open bid that covers the exit, and there is none', label: 'no bid covers the exit' },
  NEEDS_CONFIRM: { sev: 'warn', en: 'all-in {cost} TON is above CONFIRM_ABOVE {limit} TON, so it needs your confirmation', label: 'waiting for your confirmation' },
  ALREADY_BOUGHT: { sev: 'warn', en: 'this item was already bought', label: 'already bought' },
  LISTING_GONE: { sev: 'bad', en: 'the listing is gone', label: 'listing gone' },
  PRICE_UP: { sev: 'bad', en: 'the price went up', label: 'price went up' },
  EXECUTION_ERROR: { sev: 'bad', en: 'the purchase could not be executed: {error}', label: 'buy could not be executed' },
  AUTOBUY_OFF: { sev: 'warn', en: 'autobuy is off', label: 'autobuy off' },
  PANIC: { sev: 'bad', en: '/panic is on: all buying is stopped', label: '/panic on' },
  MODE_CHANGED: { sev: 'bad', en: 'the mode changed (practice/live) while the buy was being checked, so it was cancelled', label: 'mode changed mid-check' },
  BOUGHT: { sev: 'good', en: 'bought for {price} TON ({mode})', label: 'bought' },
};

/** Buyer block codes (buys.reason_code, prefix before ":") -> suite reason codes. */
export const BLOCK_TO_REASON = {
  confidence_low: 'LOW_CONFIDENCE',
  risk_red: 'RISK_RED',
  risk_warn: 'RISK_WARN',
  edge_low: 'FEES_EAT_PROFIT',
  eta_high: 'LOW_LIQUIDITY',
  no_bid: 'NO_BID',
  cheaper_elsewhere: 'CHEAPER_ELSEWHERE',
  max_price: 'PRICE_ABOVE_MAX',
  budget: 'LIMIT_DAILY_BUDGET',
  rate: 'LIMIT_HOURLY',
  already_bought: 'ALREADY_BOUGHT',
  gone: 'LISTING_GONE',
  price_up: 'PRICE_UP',
  plan_failed: 'EXECUTION_ERROR',
  validate_failed: 'EXECUTION_ERROR',
  wallet_balance: 'EXECUTION_ERROR',
  send_failed: 'EXECUTION_ERROR',
  send_unknown: 'EXECUTION_ERROR',
  confirm_above: 'NEEDS_CONFIRM',
  panic: 'PANIC',
  mode_changed: 'MODE_CHANGED',
  auto_paused: 'PAUSED',
};

/** Suite code for a buyer block code like "risk_red:official_collection". */
export function blockReason(code) {
  const base = String(code || '').split(':')[0];
  return BLOCK_TO_REASON[base] || 'EXECUTION_ERROR';
}

/** Render a reason template. Unknown codes fall back to the code itself. */
export function reasonText(code, p = {}) {
  const r = REASONS[code];
  if (!r) return code;
  return r.en
    .replace(/\{(\w+)\|([^|}]*)\|([^}]*)\}/g, (_, k, one, many) => (Number(p[k]) === 1 ? one : many))
    .replace(/\{(\w+)\}/g, (_, k) => (p[k] === undefined || p[k] === null ? '?' : String(p[k])));
}

/** Short plain label of a suite reason code ("hourly buy cap reached"), for summaries. */
export function reasonLabel(code) {
  return REASONS[code]?.label || String(code || 'unknown').toLowerCase().replace(/_/g, ' ');
}

/** Plain label of a buyer block code ("risk_red:fragment_ban" -> "failed a safety check"). */
export function blockLabel(code) {
  return reasonLabel(blockReason(code));
}

export function reasonSev(code) {
  return REASONS[code]?.sev || 'warn';
}

/** Suite confidence label from the sample size: high >= 10, med 4-9, low <= 3. */
export function confidenceLabel(n) {
  if (n >= 10) return 'high';
  if (n >= 4) return 'med';
  return 'low';
}

/** Placeholders a template needs (used by tests to check every template renders). */
export function templateParams(code) {
  return [...(REASONS[code]?.en || '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2026-10-21';

/**
 * Optional plain-language explanation of one decision event via the Claude Messages API.
 * Returns null without any network call when apiKey is empty. The key goes only in the
 * x-api-key header, never in the payload.
 * @param {object} event  suite.event.v1 object
 * @param {{apiKey?:string, model?:string, fetchImpl?:typeof fetch}} opts
 * @returns {Promise<string|null>}
 */
export async function explainMore(event, { apiKey, model = 'claude-sonnet-5-5', fetchImpl } = {}) {
  if (!apiKey) return null;
  const doFetch = fetchImpl || globalThis.fetch;
  const body = {
    model,
    max_tokens: 2000,
    output_config: { effort: 'low' },
    // Server-side fallback if the model declines (beta header below).
    fallbacks: 'default',
    system:
      'You explain one decision of a Getgems NFT deal-alert bot to its owner. Reply in plain English, 3 short sentences, ' +
      'no markdown. Use only the numbers present in the JSON. Say why the bot alerted, bought or skipped, and what the owner could do.',
    messages: [{ role: 'user', content: JSON.stringify(event) }],
  };
  const res = await doFetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${json?.error?.message || 'request failed'}`);
  if (json?.stop_reason === 'refusal') return null;
  const text = (json?.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return text || null;
}
