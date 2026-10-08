// Tiny JSON HTTP helper over built-in fetch: request spacing, 429/5xx retries, timeouts.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Serializes callers and keeps at least `minIntervalMs` between slot grants. One instance can be
 * shared by several JsonHttp clients that hit the same rate-limited host (TonAPI's anonymous tier
 * allows about 1 request per second for the whole process, not per client).
 */
export class RateLimiter {
  /**
   * @param {number} minIntervalMs
   * @param {{now?: () => number, sleep?: (ms:number) => Promise<void>}} [o]  injectable for tests
   */
  constructor(minIntervalMs, { now = () => Date.now(), sleep: sleepFn = sleep } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.now = now;
    this.sleep = sleepFn;
    this.queue = Promise.resolve();
    this.lastAt = 0;
    this.granted = 0;
  }

  /** Resolves when the caller may send its request. */
  async slot() {
    const prev = this.queue;
    let release;
    this.queue = new Promise((r) => (release = r));
    await prev;
    try {
      const wait = this.lastAt + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastAt = this.now();
      this.granted++;
    } finally {
      release();
    }
  }
}

/** Process-wide limiters by key (e.g. one per TonAPI base URL + key). */
const SHARED = new Map();
export function sharedLimiter(key, minIntervalMs) {
  let l = SHARED.get(key);
  if (!l) SHARED.set(key, (l = new RateLimiter(minIntervalMs)));
  else l.minIntervalMs = Math.max(l.minIntervalMs, minIntervalMs);
  return l;
}

export class HttpError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class JsonHttp {
  /**
   * @param {Object} o
   * @param {string} o.baseUrl
   * @param {Record<string,string>} [o.headers]
   * @param {number} [o.minIntervalMs]  spacing between requests (rate limits)
   * @param {number} [o.timeoutMs]
   * @param {number} [o.retries]
   * @param {typeof fetch} [o.fetchImpl]
   * @param {ReturnType<import('../logger.js').createLogger>} [o.log]
   * @param {RateLimiter} [o.limiter]  shared limiter; default: a private one with minIntervalMs
   */
  constructor({ baseUrl, headers = {}, minIntervalMs = 0, timeoutMs = 20_000, retries = 3, fetchImpl, log, limiter }) {
    this.baseUrl = baseUrl;
    this.headers = headers;
    this.minIntervalMs = minIntervalMs;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.fetch = fetchImpl || globalThis.fetch;
    this.log = log;
    this.limiter = limiter || new RateLimiter(minIntervalMs);
  }

  /** Serialize requests and keep at least minIntervalMs between them (shared limiter if given). */
  #slot() {
    return this.limiter.slot();
  }

  /**
   * @param {'GET'|'POST'} method
   * @param {string} path
   * @param {{query?: Record<string, any>, body?: any, withHeaders?: boolean}} [opts]
   *   withHeaders: resolve to {json, headers} instead of the JSON alone
   */
  async request(method, path, { query, body, withHeaders = false } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
      else url.searchParams.set(k, String(v));
    }
    let attempt = 0;
    for (;;) {
      attempt++;
      await this.#slot();
      let res;
      let text;
      try {
        res = await this.fetch(url, {
          method,
          headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...this.headers },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        text = await res.text();
      } catch (e) {
        if (attempt <= this.retries) {
          this.log?.warn(`${method} ${url.pathname} network error (${e.message}), retry ${attempt}`);
          await sleep(1000 * attempt);
          continue;
        }
        throw new HttpError(`${method} ${url.pathname}: ${e.message}`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt <= this.retries) {
        const ra = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * attempt;
        this.log?.warn(`${method} ${url.pathname} -> ${res.status}, waiting ${Math.round(wait / 1000)}s`);
        await sleep(Math.min(wait, 120_000));
        continue;
      }
      let json;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        throw new HttpError(`${method} ${url.pathname} -> ${res.status} non-JSON response: ${text.slice(0, 120)}`, {
          status: res.status,
          body: text,
        });
      }
      if (!res.ok) {
        const msg = json?.errors?.map((e) => e.message).join('; ') || json?.error || json?.message || text.slice(0, 200);
        throw new HttpError(`${method} ${url.pathname} -> ${res.status}: ${msg}`, { status: res.status, body: json });
      }
      return withHeaders ? { json, headers: res.headers } : json;
    }
  }

  get(path, query) {
    return this.request('GET', path, { query });
  }

  /** GET that also returns the response headers (e.g. Date and Age for the clock check). */
  getWithHeaders(path, query) {
    return this.request('GET', path, { query, withHeaders: true });
  }
  post(path, body, query) {
    return this.request('POST', path, { body, query });
  }
}
