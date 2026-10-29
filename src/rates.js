// TON -> fiat rates for the "≈ $5.13" line. TonAPI GET /v2/rates?tokens=ton&currencies=usd,rub
// (verified live without a key: {"rates":{"TON":{"prices":{"USD":1.249,"RUB":100.6}}}}).
// Cached for RATES_TTL_MIN. On any error get() returns null and the fiat line is omitted:
// a decision is never blocked on FX.

import { JsonHttp } from './clients/http.js';
import { createLogger } from './logger.js';

const log = createLogger('rates');
const SYMBOLS = { usd: '$', eur: '€', rub: '₽', gbp: '£' };

export class Rates {
  /** @param {{baseUrl:string, currencies:string[], ttlMin:number, apiKey?:string, fetchImpl?:typeof fetch}} o */
  constructor({ baseUrl, currencies, ttlMin, apiKey, fetchImpl }) {
    this.currencies = currencies;
    this.ttlMs = ttlMin * 60_000;
    this.http = new JsonHttp({ baseUrl, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, minIntervalMs: 0, retries: 0, timeoutMs: 8000, fetchImpl, log });
    this.cached = null;
  }

  /** @returns {Promise<{prices: Record<string, number>, at: number}|null>} */
  async get(now = Date.now()) {
    if (!this.currencies.length) return null;
    if (this.cached && now - this.cached.at < this.ttlMs) return this.cached;
    try {
      const json = await this.http.get('/rates', { tokens: 'ton', currencies: this.currencies.join(',') });
      const p = json?.rates?.TON?.prices || {};
      const prices = {};
      for (const c of this.currencies) {
        const v = Number(p[c.toUpperCase()]);
        if (Number.isFinite(v) && v > 0) prices[c] = v;
      }
      if (!Object.keys(prices).length) return null;
      this.cached = { prices, at: now };
      return this.cached;
    } catch (e) {
      log.debug('rates unavailable:', e.message);
      return null;
    }
  }
}

/** Fixed rates for mock mode and tests. */
export class FixedRates {
  constructor(prices, at = Date.now()) {
    this.value = { prices, at };
  }
  async get() {
    return this.value;
  }
}

export function fiatAmount(ton, rates) {
  if (!rates?.prices || ton === null || ton === undefined) return null;
  const [cur, rate] = Object.entries(rates.prices)[0] || [];
  if (!cur) return null;
  return `≈ ${SYMBOLS[cur] || `${cur.toUpperCase()} `}${(ton * rate).toFixed(2)}`;
}

/** "≈ $5.13 (rate 19:30)" or null when no rate. */
export function fiatLine(ton, rates) {
  const a = fiatAmount(ton, rates);
  if (!a) return null;
  const t = new Date(rates.at);
  return `${a} (rate ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')})`;
}
