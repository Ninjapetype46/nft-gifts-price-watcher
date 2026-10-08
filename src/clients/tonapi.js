// TonAPI (https://tonapi.io/v2) client: the free data source (no Getgems key needed).
// Smoke-tested live 2026-10-28 without a key: /nfts/collections/{addr}/items returns items with
// `sale` {address (sale contract), market {name:"Getgems Sales"}, owner (seller), price {value nano,
// currency_type:"native"}} and metadata.attributes [{trait_type:"Model"|"Backdrop"|"Symbol"}].
// Sale contract get_sale_data is decoded by /blockchain/accounts/{addr}/methods/get_sale_data and
// /accounts/{addr} lists interfaces such as "nft_sale_getgems_v3".
//
// Free sales history (feature 6): TonAPI has no collection-level sales feed, so the history is
// built incrementally from a sample of items. Each refresh reads the account events of up to
// TONAPI_HISTORY_ITEMS items (items that left the listings since the last scan first, as they most
// likely sold; then listed items; then a rotating slice of the rest; items read within
// TONAPI_HISTORY_TTL_MIN are skipped) and keeps their NftPurchase actions.
// Live check 2026-10-28 (fixtures in test/fixtures/tonapi/): GET /v2/nfts/{nft}/history only
// reports a Getgems purchase as NftItemTransfer without a price; GET /v2/accounts/{nft}/events
// returns the same trace as NftPurchase {auction_type:"getgems", amount {value nano,
// currency_type:"native"}, nft {address, collection {address}, metadata {name, attributes}},
// seller {address}, buyer {address}}. start_date (unix s) works; limit is at most 100.
//
// Limits: listing discovery scans collection items page by page and only covers the first
// TONAPI_SCAN_ITEMS items of big collections. Without TONAPI_KEY the anonymous tier rejects
// limit > 100 ("limit must not exceed 100: anonymous tier") and allows ~1 rps for the whole
// process, so every TonAPI client in the process shares one rate limiter.

import { JsonHttp, sharedLimiter } from './http.js';
import { parseServerStatus } from './getgems.js';
import { toRaw } from '../address.js';
import { nanoToTon, normalizeAttrs, plural } from '../models.js';
import { createLogger } from '../logger.js';

const log = createLogger('tonapi');

const raw = (a) => {
  try {
    return a ? toRaw(a) : null;
  } catch {
    return null;
  }
};

/**
 * TonAPI NftItem -> Listing (TON-priced sales only; by default only Getgems market).
 * @returns {import('../models.js').Listing|null}
 */
export function parseTonapiNft(item, { onlyGetgems = true } = {}) {
  const sale = item?.sale;
  if (!sale || !sale.price) return null;
  if (sale.price.currency_type && sale.price.currency_type !== 'native') return null;
  const marketName = sale.market?.name || '';
  // TODO(verify): market naming; Getgems sale contracts show market.name "Getgems Sales".
  if (onlyGetgems && !/getgems/i.test(marketName)) return null;
  const priceNano = BigInt(sale.price.value).toString();
  if (priceNano === '0') return null;
  const nft = raw(item.address);
  const collection = raw(item.collection?.address);
  if (!nft || !collection) return null;
  return {
    nft,
    collection,
    name: item.metadata?.name || nft,
    attrs: normalizeAttrs(item.metadata?.attributes),
    priceNano,
    priceTon: nanoToTon(priceNano),
    saleContract: raw(sale.address),
    saleVersion: null,
    contractType: 'sale-contract',
    seller: raw(sale.owner?.address),
    market: marketName || 'unknown',
    source: 'tonapi',
  };
}

/**
 * NftPurchase actions of TonAPI account events -> Sale objects (the Getgems history shape, so the
 * wash filters keep working: oldOwner = seller, newOwner = buyer).
 * Only finished, successful, TON-priced purchases of `collection` (when given) are kept.
 * @param {{events?: any[]}} json  GET /v2/accounts/{nft}/events response
 * @param {{collection?: string|null}} [o]
 * @returns {{sales: import('../models.js').Sale[], skipped: number}}  skipped = non-TON purchases
 */
export function parseTonapiPurchases(json, { collection = null } = {}) {
  const sales = [];
  let skipped = 0;
  const want = collection ? raw(collection) : null;
  for (const ev of json?.events || []) {
    if (ev?.in_progress) continue;
    const timeMs = Number(ev?.timestamp) * 1000;
    if (!Number.isFinite(timeMs) || timeMs <= 0) continue;
    for (const a of ev.actions || []) {
      if (a?.type !== 'NftPurchase' || (a.status && a.status !== 'ok')) continue;
      const p = a.NftPurchase;
      const amt = p?.amount;
      if (!amt) continue;
      if (amt.currency_type && amt.currency_type !== 'native') {
        skipped++;
        continue;
      }
      let nano;
      try {
        nano = BigInt(amt.value);
      } catch {
        continue;
      }
      if (nano <= 0n) continue;
      const nft = raw(p.nft?.address);
      const coll = raw(p.nft?.collection?.address);
      if (!nft || !coll || (want && coll !== want)) continue;
      sales.push({
        nft,
        collection: coll,
        name: p.nft?.metadata?.name || undefined,
        priceTon: nanoToTon(nano),
        timeMs,
        txHash: `${ev.event_id}:${nft}`,
        attrs: normalizeAttrs(p.nft?.metadata?.attributes),
        oldOwner: raw(p.seller?.address),
        newOwner: raw(p.buyer?.address),
        rejectTop: false,
        market: p.auction_type || null,
      });
    }
  }
  return { sales, skipped };
}

/**
 * Items whose history to read in this refresh, at most `max`: first `urgent` items (listed at the
 * previous scan and gone now, so most likely just sold; read even within the TTL), then listed
 * items, then a rotating slice of the rest. Items read within the TTL (`fresh`) are skipped.
 * @param {{urgent?:string[], listed:string[], others:string[], cursor:number, max:number, fresh:(nft:string)=>boolean}} o
 * @returns {{pick:string[], cursor:number}}
 */
export function pickHistorySample({ urgent = [], listed, others, cursor = 0, max, fresh }) {
  const pick = [];
  const seen = new Set();
  const add = (n, force = false) => {
    if (pick.length < max && !seen.has(n) && (force || !fresh(n))) {
      seen.add(n);
      pick.push(n);
    }
  };
  for (const n of urgent) add(n, true);
  for (const n of listed) add(n);
  let i = others.length ? cursor % others.length : 0;
  for (let scanned = 0; scanned < others.length && pick.length < max; scanned++) {
    add(others[i]);
    i = (i + 1) % others.length;
  }
  return { pick, cursor: i };
}

const HOUR = 3_600_000;
const giftKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
/** "Plush Pepe" matches "Plush Pepes" (case, punctuation and a plural "s" ignored). */
const sameGiftName = (a, b) => {
  const x = giftKey(a);
  const y = giftKey(b);
  return !!x && (x === y || `${x}s` === y || x === `${y}s`);
};
// Per-item history pages (100 events each) for one read; gift items rarely have more in 30 days.
const HISTORY_PAGES = 2;

export class TonapiClient {
  name = 'tonapi';
  // No Getgems offers through TonAPI: the alert card shows "bids: n/a".
  supportsOffers = false;

  /**
   * @param {Object} o
   * @param {string} [o.apiKey]
   * @param {string} o.baseUrl
   * @param {number} [o.scanItems]   max items scanned per collection per cycle
   * @param {number} [o.minIntervalMs]
   * @param {number} [o.historyItems]  TONAPI_HISTORY_ITEMS: items whose history is read per refresh
   * @param {number} [o.historyTtlMin] TONAPI_HISTORY_TTL_MIN: per-item history cache
   * @param {import('./http.js').RateLimiter} [o.limiter]  default: one limiter per base URL + key, shared process-wide
   * @param {typeof fetch} [o.fetchImpl]
   * @param {() => number} [o.now]
   */
  constructor({ apiKey, baseUrl, scanItems = 1000, minIntervalMs = 1100, historyItems = 60, historyTtlMin = 360, limiter, fetchImpl, now = () => Date.now(), getgemsBase = 'https://api.getgems.io/public-api' }) {
    // Free tier is ~1 rps without a key, for all TonAPI clients of this process together.
    const interval = apiKey ? Math.min(minIntervalMs, 300) : Math.max(minIntervalMs, 1100);
    this.http = new JsonHttp({
      baseUrl,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      minIntervalMs: interval,
      limiter: limiter || sharedLimiter(`tonapi:${baseUrl}:${apiKey ? 'key' : 'anon'}`, interval),
      fetchImpl,
      log,
    });
    this.scanItems = scanItems;
    this.pageSize = apiKey ? 1000 : 100;
    this.historyItems = historyItems;
    this.historyTtlMs = historyTtlMin * 60_000;
    this.now = now;
    /** @type {Map<string, {listed:string[], all:string[]}>} items seen by the last scan, per collection */
    this.items = new Map();
    /** @type {Map<string, {at: Record<string, number>, cursor: number}>} history read times, per collection */
    this.history = new Map();
    /** Optional persistent cache ({kvJson, kvSet}, e.g. Storage) so restarts keep the sample. */
    this.cache = null;
    /** @type {Map<string, {at:number, value:{address:string, name:string}|null}>} gift name lookups */
    this.giftNames = new Map();
    // Getgems /v1/server-status is public, so the market-status check works without a Getgems key.
    this.getgemsPublic = new JsonHttp({ baseUrl: getgemsBase, minIntervalMs: 0, retries: 1, fetchImpl, log });
  }

  async getCollectionOffers() {
    return [];
  }

  async getNftOffers() {
    return [];
  }

  /** Public Getgems status endpoint, called without a key. */
  async getServerStatus() {
    const { json, headers } = await this.getgemsPublic.getWithHeaders('/v1/server-status');
    return parseServerStatus(json, headers);
  }

  /** Needs a Getgems key: null means "skipped". */
  async getUserTradingInfo() {
    return null;
  }

  async getNftsByOwner(owner) {
    const json = await this.http.get(`/accounts/${toRaw(owner)}/nfts`, { limit: 1000, indirect_ownership: true });
    return (json?.nft_items || []).map((it) => ({
      nft: raw(it.address),
      collection: raw(it.collection?.address),
      title: it.metadata?.name || raw(it.address),
      number: null,
      attrs: normalizeAttrs(it.metadata?.attributes),
      contractType: null,
      ownListing: parseTonapiNft(it),
    }));
  }

  async getOffchainGiftsByOwner() {
    return [];
  }

  /** "name.ton" -> raw wallet address via /v2/dns/{domain}/resolve (verified live shape: {wallet:{address}}). */
  async resolveDns(name) {
    const json = await this.http.get(`/dns/${encodeURIComponent(name)}/resolve`);
    return raw(json?.wallet?.address);
  }

  async getListings(collection, { maxItems = this.scanItems } = {}) {
    const coll = toRaw(collection);
    const out = [];
    const all = [];
    const limit = this.pageSize;
    for (let offset = 0; offset < maxItems; offset += limit) {
      const json = await this.http.get(`/nfts/collections/${coll}/items`, { limit, offset });
      const items = json?.nft_items || [];
      for (const it of items) {
        const a = raw(it.address);
        if (a) all.push(a);
        const l = parseTonapiNft(it);
        if (l) out.push(l);
      }
      if (items.length < limit) break;
    }
    // Remembered for the history sample. Items listed at the previous scan and gone now most
    // likely sold: their history is read first at the next sales refresh.
    const prev = this.items.get(coll);
    const listed = out.map((l) => l.nft);
    const now = new Set(listed);
    const gone = new Set(prev?.gone || []);
    for (const n of prev?.listed || []) if (!now.has(n)) gone.add(n);
    this.items.set(coll, { listed, all, gone: [...gone] });
    return out;
  }

  /** Persist the per-item history read times (Storage-like {kvJson, kvSet}). */
  attachHistoryCache(store) {
    this.cache = store && typeof store.kvJson === 'function' && typeof store.kvSet === 'function' ? store : null;
  }

  #historyState(coll) {
    let st = this.history.get(coll);
    if (!st) {
      const saved = this.cache?.kvJson(`tonapi_history:${coll}`);
      st = saved && typeof saved === 'object' && saved.at ? { at: saved.at, cursor: Number(saved.cursor) || 0 } : { at: {}, cursor: 0 };
      this.history.set(coll, st);
    }
    return st;
  }

  /**
   * "sales: TonAPI sample of N items": the source label for alerts, valuate and /doctor.
   * @param {string} [collection]
   */
  salesSource(collection) {
    if (!collection) return { name: 'tonapi', sampled: true, items: null, label: `sales: TonAPI sample of up to ${this.historyItems} items per collection per refresh` };
    const n = Object.keys(this.#historyState(toRaw(collection)).at).length;
    return { name: 'tonapi', sampled: true, items: n, label: `sales: TonAPI sample of ${n} items` };
  }

  /**
   * Sold events from the on-chain NftPurchase history of a sample of items (see the header).
   * @param {string} collection
   * @param {{sinceMs:number, windowSinceMs?:number}} o  windowSinceMs = start of the lookback window
   *   (an item read for the first time is read for the whole window; later reads only what is new)
   * @returns {Promise<import('../models.js').Sale[]>}
   */
  async getSales(collection, { sinceMs, windowSinceMs = sinceMs } = {}) {
    const coll = toRaw(collection);
    if (!this.items.has(coll)) await this.getListings(coll, { maxItems: this.pageSize }); // e.g. a portfolio collection
    const items = this.items.get(coll) || { listed: [], all: [], gone: [] };
    const st = this.#historyState(coll);
    const now = this.now();
    const fresh = (n) => st.at[n] !== undefined && now - st.at[n] < this.historyTtlMs;
    const listed = new Set(items.listed);
    const { pick, cursor } = pickHistorySample({
      urgent: items.gone || [],
      listed: items.listed,
      others: items.all.filter((n) => !listed.has(n)),
      cursor: st.cursor,
      max: this.historyItems,
      fresh,
    });
    st.cursor = cursor;
    const out = [];
    let skipped = 0;
    let read = 0;
    for (const nft of pick) {
      const from = st.at[nft] ? Math.max(windowSinceMs, st.at[nft] - HOUR) : windowSinceMs;
      try {
        let beforeLt;
        for (let page = 0; page < HISTORY_PAGES; page++) {
          const json = await this.http.get(`/accounts/${nft}/events`, { limit: 100, start_date: Math.floor(from / 1000), before_lt: beforeLt });
          const r = parseTonapiPurchases(json, { collection: coll });
          out.push(...r.sales);
          skipped += r.skipped;
          const events = json?.events || [];
          if (events.length < 100 || !json?.next_from) break;
          beforeLt = json.next_from;
        }
        st.at[nft] = now;
        read++;
        if (items.gone?.length) items.gone = items.gone.filter((n) => n !== nft);
      } catch (e) {
        // Rate limited or offline: keep what this refresh got; the rest is picked up next time.
        log.warn(`history sample of ${coll} stopped after ${read}/${pick.length} items: ${e.message}`);
        break;
      }
    }
    try {
      this.cache?.kvSet(`tonapi_history:${coll}`, { at: st.at, cursor: st.cursor });
    } catch (e) {
      log.debug('history cache write failed:', e.message);
    }
    if (skipped) log.debug(`history ${coll}: ${plural(skipped, 'non-TON purchase')} skipped`);
    log.debug(`history ${coll}: read ${plural(read, 'item')}, ${plural(out.length, 'purchase')}; sample now ${plural(Object.keys(st.at).length, 'item')}`);
    return out;
  }

  async getNftAttributes(nfts) {
    const out = [];
    for (let i = 0; i < nfts.length; i += 100) {
      const json = await this.http.post('/nfts/_bulk', { account_ids: nfts.slice(i, i + 100).map((a) => toRaw(a)) });
      for (const it of json?.nft_items || []) {
        out.push({
          nft: raw(it.address),
          collection: raw(it.collection?.address),
          name: it.metadata?.name,
          attrs: normalizeAttrs(it.metadata?.attributes),
        });
      }
    }
    return out;
  }

  async refreshListing(listing) {
    const json = await this.http.get(`/nfts/${toRaw(listing.nft)}`);
    return parseTonapiNft(json);
  }

  /** TonAPI cannot build Getgems purchase transactions -> buyer uses the direct sale-contract path. */
  async getBuyTransaction() {
    return null;
  }

  /**
   * On-chain check of a Getgems sale contract before a direct buy.
   * @returns {Promise<{interfaces:string[], isComplete:boolean, fullPriceNano:string, nft:string|null}>}
   */
  async inspectSaleContract(saleContract) {
    const addr = toRaw(saleContract);
    const acc = await this.http.get(`/accounts/${addr}`);
    // Live check: v3 ("nft_sale_getgems_v3") exposes get_sale_data {nft, full_price, is_complete};
    // v4 ("nft_sale_getgems_v4") only get_fix_price_data_v4 {nft_address, full_price, is_complete}.
    const methods = acc?.get_methods || [];
    const method = methods.includes('get_fix_price_data_v4') ? 'get_fix_price_data_v4' : 'get_sale_data';
    const data = await this.http.get(`/blockchain/accounts/${addr}/methods/${method}`);
    const d = data?.decoded || {};
    return {
      interfaces: acc?.interfaces || [],
      isComplete: !!d.is_complete,
      fullPriceNano: d.full_price !== undefined ? BigInt(d.full_price).toString() : '0',
      nft: raw(d.nft ?? d.nft_address),
    };
  }

  /** TonAPI has no list of gift collections; findGiftCollections() looks them up by name instead. */
  async listGiftCollections() {
    return [];
  }

  /**
   * Telegram gift collections by gift name ("Plush Pepe"), without a Getgems key: TonAPI account
   * search, keeping only accounts TonAPI marks trust "whitelist" whose name matches (a plural "s"
   * either way), then a check that the collection metadata says "collection by Telegram".
   * Lookalike collections (trust "none") are never returned. Cached per name: hits 24h, misses 1h.
   * Live check 2026-10-28: "Plush Pepe" -> "Plush Pepes · account" 0:46fa0e9a… (whitelist), while
   * dozens of "Plush Pepes · collection" lookalikes have trust "none"; a whitelisted "PlushPepe ·
   * jetton" is skipped. Homemade Cake, Durov's Cap, Lol Pop and Signet Ring resolved the same way.
   * @param {string[]} names
   * @returns {Promise<{address:string, name:string}[]>}
   */
  async findGiftCollections(names) {
    const out = [];
    for (const name of [...new Set((names || []).filter(Boolean))]) {
      const hit = await this.#findGiftCollection(name);
      if (hit && !out.some((g) => g.address === hit.address)) out.push(hit);
    }
    return out;
  }

  async #findGiftCollection(name) {
    const key = giftKey(name);
    const cached = this.giftNames.get(key);
    if (cached && this.now() - cached.at < (cached.value ? 24 * HOUR : HOUR)) return cached.value;
    let value = null;
    try {
      // The search takes at most 15 characters (live: 400 "len 16 greater than maximum 15").
      const json = await this.http.get('/accounts/search', { name: String(name).slice(0, 15).trim() });
      const candidates = (json?.addresses || [])
        .filter((a) => a?.trust === 'whitelist')
        .map((a) => {
          const m = /^(.*?)\s+·\s+(\w+)$/u.exec(String(a.name || '')); // "Plush Pepes · account"
          return { address: raw(a.address), name: (m ? m[1] : String(a.name || '')).trim(), kind: m ? m[2] : null };
        })
        .filter((a) => a.address && a.kind !== 'jetton' && sameGiftName(name, a.name));
      for (const c of candidates) {
        let info;
        try {
          info = await this.getCollectionInfo(c.address);
        } catch (e) {
          if (e.status === 404) continue; // not an NFT collection
          throw e;
        }
        if (info.isGift) {
          value = { address: c.address, name: info.name || c.name };
          break;
        }
      }
    } catch (e) {
      log.warn(`gift collection lookup for "${name}" failed: ${e.message}`);
      return null; // not cached: tried again next time
    }
    this.giftNames.set(key, { at: this.now(), value });
    return value;
  }

  async getCollectionInfo(collection) {
    const json = await this.http.get(`/nfts/collections/${toRaw(collection)}`);
    const desc = json?.metadata?.description || '';
    return {
      name: json?.metadata?.name || null,
      // Telegram gift collections are described as "... is an exclusive NFT collection by Telegram".
      isGift: /collection by Telegram/i.test(desc) || /nft\.fragment\.com\/collection/.test(json?.metadata_status?.url || ''),
    };
  }
}
