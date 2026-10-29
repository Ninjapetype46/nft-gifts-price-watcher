// Pure "Safe to buy?" traffic light. assessRisk() turns gathered facts (riskfacts.js does the
// I/O) into a green / yellow / red verdict with one line per check. Checks whose fact was not
// gathered (undefined) are skipped, so the same function serves alert time and buy time.
//
// Verdicts are private to the owner. The texts describe the item and the data, never the seller.

/**
 * @typedef {Object} RiskFacts
 * @property {boolean} [isGift]                 looksLikeGift(attrs)
 * @property {string} [collection]              raw address
 * @property {string[]|null} [giftCollections]  official Getgems gift list (raw), null = unavailable
 * @property {string[]} [allowlist]             GIFT_COLLECTION_ALLOWLIST (raw)
 * @property {string|null} [contractType]       sale-contract | telemint | offchain
 * @property {{type:string, reason?:string}|null} [warning]  Getgems NftItemFull.warning
 * @property {{gone:boolean, priceUp:boolean, newPriceTon?:number|null}} [priceFresh]
 * @property {'up'|'warn'|'down'|'error'} [marketStatus]
 * @property {{tradingCount:number}|null} [sellerInfo]  null = not available (no Getgems key)
 * @property {number} [priceTon]
 * @property {number|null} [fairTon]
 * @property {'A'|'B'|'C'} [confidence]
 */

/**
 * @typedef {{id:string, status:'ok'|'warn'|'bad', text:string, short:string}} RiskCheck
 * @typedef {{level:'green'|'yellow'|'red', checks: RiskCheck[]}} RiskResult
 */

/**
 * The eight checks, in order: official_collection, sale_type, fragment_ban, price_fresh,
 * market_status, seller_history, too_good, data_confidence (ids used by AUTOBUY_ALLOW_WARN).
 * @param {RiskFacts} f
 * @param {{riskTooGoodPct:number, offchainNote:string, telemintNote:string}} cfg
 * @returns {RiskResult}
 */
export function assessRisk(f, cfg) {
  /** @type {RiskCheck[]} */
  const checks = [];
  const add = (id, status, text, short = text) => checks.push({ id, status, text, short });

  if (f.isGift && f.giftCollections !== undefined) {
    const allow = new Set([...(f.giftCollections || []), ...(f.allowlist || [])]);
    if (f.giftCollections === null && !(f.allowlist || []).includes(f.collection)) {
      add('official_collection', 'warn', 'Could not verify the collection', 'Collection not verified');
    } else if (allow.has(f.collection)) {
      add('official_collection', 'ok', 'Official Telegram gift collection');
    } else {
      add(
        'official_collection',
        'bad',
        "Looks like a Telegram gift, but this collection is not in Getgems' official gift list",
        'Not an official gift collection',
      );
    }
  }

  if (f.contractType === 'sale-contract') add('sale_type', 'ok', 'Standard on-chain sale');
  else if (f.contractType === 'telemint') add('sale_type', 'warn', cfg.telemintNote, 'Telemint sale');
  else if (f.contractType === 'offchain') add('sale_type', 'warn', cfg.offchainNote, 'Off-chain gift');

  if (f.warning !== undefined) {
    if (f.warning?.type === 'NftBanFromFragment') {
      add('fragment_ban', 'bad', `Getgems warning: banned from Fragment (${f.warning.reason || 'no reason given'})`, 'Banned from Fragment');
    } else if (f.warning) {
      add('fragment_ban', 'warn', `Getgems warning: ${f.warning.type}${f.warning.reason ? ` (${f.warning.reason})` : ''}`, 'Getgems warning');
    } else {
      add('fragment_ban', 'ok', 'No Getgems warnings');
    }
  }

  if (f.priceFresh !== undefined) {
    if (f.priceFresh.gone) add('price_fresh', 'bad', 'The listing is gone', 'Listing gone');
    else if (f.priceFresh.priceUp) {
      add('price_fresh', 'bad', `The price went up${f.priceFresh.newPriceTon ? ` to ${f.priceFresh.newPriceTon.toFixed(2)} TON` : ''}`, 'Price went up');
    } else add('price_fresh', 'ok', 'Price unchanged since alert');
  }

  if (f.marketStatus !== undefined) {
    if (f.marketStatus === 'down') add('market_status', 'bad', 'Getgems reports "down"', 'Getgems is down');
    else if (f.marketStatus === 'warn') add('market_status', 'warn', 'Getgems reports "warn"', 'Getgems status: warn');
    else if (f.marketStatus === 'up') add('market_status', 'ok', 'Getgems reports "up"');
    else add('market_status', 'warn', 'Could not reach the Getgems status endpoint', 'Getgems status unknown');
  }

  if (f.sellerInfo) {
    const n = Number(f.sellerInfo.tradingCount ?? 0);
    if (n === 0) add('seller_history', 'warn', 'First-time seller on Getgems', 'First-time seller');
    else add('seller_history', 'ok', `Seller has ${n} trades`);
  }

  if (f.fairTon > 0 && f.priceTon > 0) {
    const pct = (f.priceTon / f.fairTon) * 100;
    if (pct < cfg.riskTooGoodPct) {
      add('too_good', 'warn', `Unusually cheap (${Math.round(pct)}% of fair value), double-check the item`, 'Unusually cheap');
    } else add('too_good', 'ok', `Price is ${Math.round(pct)}% of fair value`);
  }

  if (f.confidence) {
    if (f.confidence === 'C') add('data_confidence', 'warn', 'Thin or mixed price data (confidence C)', 'Thin price data');
    else add('data_confidence', 'ok', `Price confidence ${f.confidence}`);
  }

  const level = checks.some((c) => c.status === 'bad') ? 'red' : checks.some((c) => c.status === 'warn') ? 'yellow' : 'green';
  return { level, checks };
}

export const RISK_EMOJI = { green: '🟢', yellow: '🟡', red: '🔴' };

/** One-line verdict for the alert card: "🟢 Safe checks passed" / "🟡 Off-chain gift · Unusually cheap". */
export function riskLine(r) {
  if (!r) return '⚪ Safe checks not run';
  if (r.level === 'green') return '🟢 Safe checks passed';
  const bad = r.checks.filter((c) => c.status === 'bad');
  const warn = r.checks.filter((c) => c.status === 'warn');
  return `${RISK_EMOJI[r.level]} ${[...bad, ...warn].slice(0, 2).map((c) => c.short).join(' · ')}`;
}

/** ids of failing checks for block codes: risk_red:official_collection / risk_warn:sale_type,seller_history */
export function failingIds(r, status) {
  return r.checks.filter((c) => c.status === status).map((c) => c.id);
}

/** True when every warn check is listed in AUTOBUY_ALLOW_WARN. */
export function warnsAllowed(r, allow) {
  const ids = failingIds(r, 'warn');
  return ids.length > 0 && ids.every((id) => allow.includes(id));
}
