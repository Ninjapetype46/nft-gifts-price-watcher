// Getgems Public API client. Spec: https://api.getgems.io/public-api/docs.json (OpenAPI 3, checked 2026-10-28).
// Auth: raw API key in the `Authorization` header (no "Bearer"); verified: missing -> 401,
// wrong key -> 400 "Invalid authorization". Rate limit: 400 requests / 5 min per client.
// TODO(verify): every endpoint below was written from the OpenAPI spec and the official guide
// (nft-contracts/docs/how-to-use-api-en.md); none was called with a valid (paid) key.

import { JsonHttp } from './http.js';
import { toRaw, toFriendly } from '../address.js';
import { nanoToTon, tonToNano, normalizeAttrs, plural } from '../models.js';
import { createLogger } from '../logger.js';

const log = createLogger('getgems');

/** Getgems returns friendly or raw addresses; normalize, tolerate null. */
const raw = (a) => {
  try {
    return a ? toRaw(a) : null;
  } catch {
    return null;
  }
};

/** Prices are nano strings (doc example: minBid "2200000000"). Accept a decimal TON string too. */
function priceToNano(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  // TODO(verify): FixPriceSale.fullPrice is documented only as "string"; treated as nanoTON
  // like Auction.minBid in the official example. A decimal point means TON.
  return s.includes('.') ? tonToNano(s).toString() : BigInt(s).toString();
}

/**
 * NftItemFull -> Listing (only TON fixed-price sales; auctions and jetton prices are skipped).
 * @returns {import('../models.js').Listing|null}
 */
export function parseGetgemsNft(item, fallbackCollection = null) {
  const sale = item?.sale;
  if (!sale || sale.type !== 'FixPriceSale') return null;
  if (sale.currency && sale.currency !== 'TON') return null;
  const priceNano = priceToNano(sale.fullPrice);
  if (!priceNano || priceNano === '0') return null;
  const nft = raw(item.address);
  const collection = raw(item.collectionAddress) || fallbackCollection;
  if (!nft || !collection) return null;
  return {
    nft,
    collection,
    name: item.name || nft,
    attrs: normalizeAttrs(item.attributes),
    priceNano,
    priceTon: nanoToTon(priceNano),
    saleContract: raw(sale.contractAddress),
    saleVersion: sale.version || null,
    contractType: sale.contractType || null,
    seller: raw(item.actualOwnerAddress) || raw(item.ownerAddress),
    market: 'getgems',
    source: 'getgems',
    // TODO(verify): marketplaceFee and royaltyAmount are assumed to be nano amounts like fullPrice
    // (sanity-checked in edge.feeModel, which ignores ratios outside [0, 0.3]).
    marketplaceFeeNano: safeNano(sale.marketplaceFee),
    royaltyNano: safeNano(sale.royaltyAmount),
    // NftItemFull.warning: {type: 'NftBanFromFragment', reason} | null (verified in the OpenAPI spec).
    warning: item.warning ? { type: String(item.warning.type), reason: item.warning.reason ?? null } : null,
  };
}

function safeNano(v) {
  try {
    return priceToNano(v);
  } catch {
    return null;
  }
}

/**
 * Getgems Offer -> normalized offer for edge.bidCover().
 * Verified field names (OpenAPI 2026-10-28): fullPrice, profitPrice ("Price after all fees and
 * royalties"), royaltyPrice, feePrice, currency, offerAddress, finishAt, isCollectionOffer,
 * isOffchain, maxQuantity, purchasedQuantity, attributes [{trait, values[]}].
 * TODO(verify): profitPrice/fullPrice units (assumed nano like FixPriceSale.fullPrice) and finishAt
 * seconds vs ms (edge.finishAtMs treats values > 1e12 as ms).
 */
export function parseGetgemsOffer(o) {
  if (!o) return null;
  const toTon = (v) => {
    const n = safeNano(v);
    return n === null ? null : nanoToTon(n);
  };
  const netTon = toTon(o.profitPrice);
  if (!(netTon > 0)) return null;
  return {
    netTon,
    fullTon: toTon(o.fullPrice),
    currency: o.currency || 'TON',
    offerAddress: raw(o.offerAddress) || o.offerAddress || null,
    finishAt: o.finishAt ?? null,
    isCollectionOffer: !!o.isCollectionOffer,
    isOffchain: !!o.isOffchain,
    maxQuantity: o.maxQuantity ?? null,
    purchasedQuantity: o.purchasedQuantity ?? null,
    attributes: Array.isArray(o.attributes) ? o.attributes.map((a) => ({ trait: a.trait, values: a.values || [] })) : [],
  };
}

/** NftItemFull (owned, possibly unlisted) -> holding for the portfolio. */
export function parseGetgemsHolding(item, { offchain = false } = {}) {
  const nft = raw(item?.address);
  if (!nft) return null;
  return {
    nft,
    collection: raw(item.collectionAddress),
    title: item.name || nft,
    number: null,
    attrs: normalizeAttrs(item.attributes),
    contractType: offchain ? 'offchain' : item.sale?.contractType || null,
    ownListing: parseGetgemsNft(item),
  };
}

/**
 * NftItemHistoryItem (type "sold") -> Sale.
 * @returns {import('../models.js').Sale|null}
 */
export function parseGetgemsHistory(item) {
  const t = item?.typeData;
  if (!t || t.type !== 'sold') return null;
  if (t.currency && t.currency !== 'TON') {
    nonTonSkipped++;
    return null;
  }
  let priceTon = null;
  if (t.priceNano) priceTon = nanoToTon(t.priceNano);
  else if (t.price) priceTon = Number(t.price);
  if (!(priceTon > 0)) return null;
  const nft = raw(item.address);
  const collection = raw(item.collectionAddress);
  if (!nft || !collection) return null;
  const timeMs = Number(item.timestamp) || Date.parse(item.time);
  if (!Number.isFinite(timeMs)) return null;
  return {
    nft,
    collection,
    name: item.name || undefined,
    priceTon,
    timeMs,
    txHash: `${item.hash || item.lt}:${nft}`,
    // HistoryTypeSold requires oldOwner, newOwner and rejectFromGlobalTop (OpenAPI, verified).
    // TODO(verify): real values with a paid key (raw vs friendly addresses, how often rejectTop is set).
    oldOwner: raw(t.oldOwner),
    newOwner: raw(t.newOwner),
    rejectTop: !!t.rejectFromGlobalTop,
  };
}

let nonTonSkipped = 0;
/** Number of sold events skipped because they were not priced in TON (reset on read). */
export function takeNonTonSkipped() {
  const n = nonTonSkipped;
  nonTonSkipped = 0;
  return n;
}

/** {ok, time, status, services} -> normalized status (verified live shape). */
/**
 * /v1/server-status -> {status, time, services}. The body's `time` is cached by the origin and the
 * CDN (cache-control max-age=60, stale-while-revalidate=15; live check 2026-10-28: `time` lagged the
 * Date header by 45s on a CDN miss), so it cannot measure clock skew. `time` is the HTTP Date
 * header plus Age (the standard current-age rule) when the headers are given, else null.
 * @param {object} json
 * @param {{get:(name:string)=>string|null}|null} [headers]
 */
export function parseServerStatus(json, headers = null) {
  const r = json?.response ?? json ?? {};
  const status = ['up', 'warn', 'down'].includes(r.status) ? r.status : 'warn';
  const date = Date.parse(headers?.get?.('date') ?? '');
  const age = Number(headers?.get?.('age') ?? 0);
  const time = Number.isFinite(date) ? new Date(date + (Number.isFinite(age) && age > 0 ? age * 1000 : 0)).toISOString() : null;
  return { status, time, services: Array.isArray(r.services) ? r.services : [] };
}

/**
 * Transaction (TonConnect-like) from POST /v1/nfts/buy-fix-price -> OutMessage[].
 * @returns {{uuid:string|null, timeout:string|null, messages: import('../models.js').OutMessage[]}}
 */
export function parseBuyTransaction(resp) {
  const tx = resp?.response ?? resp;
  const list = Array.isArray(tx?.list) ? tx.list : [];
  return {
    uuid: tx?.uuid ?? null,
    timeout: tx?.timeout ?? null,
    messages: list.map((m) => ({
      to: m.to,
      amountNano: BigInt(m.amount).toString(),
      payloadB64: m.payload || null,
      stateInitB64: m.stateInit || null,
    })),
  };
}

export class GetgemsClient {
  name = 'getgems';
  supportsOffers = true;

  /**
   * @param {Object} o
   * @param {string} o.apiKey
   * @param {string} o.baseUrl
   * @param {number} [o.minIntervalMs]
   * @param {boolean} [o.includeOffchain]
   * @param {typeof fetch} [o.fetchImpl]
   */
  constructor({ apiKey, baseUrl, minIntervalMs = 800, includeOffchain = false, fetchImpl }) {
    this.http = new JsonHttp({
      baseUrl,
      headers: { Authorization: apiKey },
      minIntervalMs,
      fetchImpl,
      log,
    });
    this.includeOffchain = includeOffchain;
    this.giftCache = { at: 0, items: /** @type {{address:string,name:string}[]} */ ([]) };
  }

  async #paged(path, { query = {}, pages = 1 } = {}) {
    const items = [];
    let after;
    for (let i = 0; i < pages; i++) {
      const json = await this.http.get(path, { ...query, limit: 100, after });
      const r = json?.response ?? {};
      items.push(...(r.items || []));
      after = r.cursor;
      if (!after) break;
    }
    return items;
  }

  /**
   * Fixed-price TON listings of a collection.
   * TODO(verify): /v1/nfts/on-sale appears to be sorted by price ascending (the doc example cursor
   * is "5.7,<id>"); with LISTING_PAGES=1 we rely on that to see the cheapest 100 listings.
   */
  async getListings(collection, { pages = 1 } = {}) {
    const coll = toFriendly(collection);
    const items = await this.#paged(`/v1/nfts/on-sale/${coll}`, { pages });
    if (this.includeOffchain) {
      // TODO(verify): off-chain gift listings and whether buy-fix-price works for contractType "offchain".
      items.push(...(await this.#paged(`/v1/nfts/offchain/on-sale/${coll}`, { pages })));
    }
    const rawColl = toRaw(collection);
    return items.map((it) => parseGetgemsNft(it, rawColl)).filter(Boolean);
  }

  /**
   * Sold events (new -> old) since `sinceMs`.
   * Only types[]=sold: luckyBuy events carry a raffle ticket price and bundleSale events a
   * multi-item price, so neither may ever become a comparable sale.
   */
  async getSales(collection, { sinceMs, maxPages = 5 }) {
    const items = await this.#paged(`/v1/collection/history/${toFriendly(collection)}`, {
      query: { 'types[]': ['sold'], minTime: Math.floor(sinceMs) },
      pages: maxPages,
    });
    const sales = items.map(parseGetgemsHistory).filter(Boolean);
    const skipped = takeNonTonSkipped();
    if (skipped) log.debug(`history ${toFriendly(collection)}: ${plural(skipped, 'non-TON sale')} skipped`);
    return sales;
  }

  /** Full collection history from the paid API. */
  salesSource() {
    return { name: 'getgems', sampled: false, items: null, label: 'sales: Getgems API' };
  }

  /**
   * Collection offers (bids), paged. GET /v1/offers/collection/{collectionAddress}
   * Only real collection offers are kept: an entry marked isCollectionOffer=false is an offer for
   * one specific NFT and must never count as an instant exit for other items.
   * TODO(verify): whether this endpoint ever returns per-NFT offers (the field suggests it can).
   */
  async getCollectionOffers(collection, { pages = 2 } = {}) {
    const items = await this.#paged(`/v1/offers/collection/${toFriendly(collection)}`, { pages });
    return items
      .filter((o) => o?.isCollectionOffer !== false)
      .map((o) => parseGetgemsOffer({ ...o, isCollectionOffer: true }))
      .filter(Boolean);
  }

  /** Offers for one NFT, paged. GET /v1/offers/nft/{nftAddress}. Tagged with the NFT they target. */
  async getNftOffers(nft, { pages = 1 } = {}) {
    const items = await this.#paged(`/v1/offers/nft/${toFriendly(nft)}`, { pages });
    const target = raw(nft);
    return items
      .map((o) => parseGetgemsOffer({ ...o, isCollectionOffer: o.isCollectionOffer ?? false }))
      .filter(Boolean)
      .map((o) => (o.isCollectionOffer ? o : { ...o, nft: target }));
  }

  /**
   * GET /v1/server-status. Public endpoint (security [{}]); verified live without a key:
   * {"ok":true,"time":"…","status":"up","services":[]}; status is up | warn | down.
   * @returns {Promise<{status:string, time:string|null, services:any[]}>}
   */
  async getServerStatus() {
    const { json, headers } = await this.http.getWithHeaders('/v1/server-status');
    return parseServerStatus(json, headers);
  }

  /**
   * GET /v1/user-trading-info/{userAddress} -> {tradingCount, tradingVolume, balance}.
   * TODO(verify): response wrapper and units with a paid key.
   */
  async getUserTradingInfo(address) {
    const json = await this.http.get(`/v1/user-trading-info/${toFriendly(address)}`);
    const r = json?.response ?? json ?? {};
    return { tradingCount: Number(r.tradingCount ?? 0), tradingVolume: r.tradingVolume ?? null, balance: r.balance ?? null };
  }

  /** NFTs owned by an address (on-chain), paged. GET /v1/nfts/owner/{ownerAddress} */
  async getNftsByOwner(owner, { pages = 3 } = {}) {
    const items = await this.#paged(`/v1/nfts/owner/${toFriendly(owner)}`, { pages });
    return items.map((it) => parseGetgemsHolding(it)).filter(Boolean);
  }

  /** Off-chain gifts held in a Getgems account. GET /v1/gifts/offchain/owner/{ownerAddress} */
  async getOffchainGiftsByOwner(owner, { pages = 3 } = {}) {
    const items = await this.#paged(`/v1/gifts/offchain/owner/${toFriendly(owner)}`, { pages });
    return items.map((it) => parseGetgemsHolding(it, { offchain: true })).filter(Boolean);
  }

  /** Attributes for many NFTs via POST /v1/nfts/list. */
  async getNftAttributes(nfts) {
    const out = [];
    // TODO(verify): max addressList size per request is not documented; 100 assumed.
    for (let i = 0; i < nfts.length; i += 100) {
      const chunk = nfts.slice(i, i + 100).map((a) => toFriendly(a));
      const json = await this.http.post('/v1/nfts/list', { addressList: chunk });
      for (const it of json?.response?.items || []) {
        const nft = raw(it.address);
        if (!nft) continue;
        out.push({ nft, collection: raw(it.collectionAddress), name: it.name, attrs: normalizeAttrs(it.attributes) });
      }
    }
    return out;
  }

  /** Re-read one NFT right before buying. Returns null if it is no longer a TON fixed-price listing. */
  async refreshListing(listing) {
    const json = await this.http.get(`/v1/nft/${toFriendly(listing.nft)}`);
    return parseGetgemsNft(json?.response, listing.collection);
  }

  /**
   * Ask Getgems to build the purchase transaction (official bot flow, see
   * nft-contracts/docs/how-to-use-api-en.md "Getting a Transaction for an NFT Purchase").
   * We sign and send it ourselves. Body: {version} from the sale object.
   * TODO(verify): live response for a real listing (number of messages, amount vs fullPrice,
   * whether the buyer address/`from` must be supplied, `timeout` semantics). Not tested: needs a paid key.
   */
  async getBuyTransaction(listing) {
    if (!listing.saleVersion) throw new Error('listing has no sale.version (required by buy-fix-price)');
    const json = await this.http.post(`/v1/nfts/buy-fix-price/${toFriendly(listing.nft)}`, { version: listing.saleVersion });
    const tx = parseBuyTransaction(json);
    if (!tx.messages.length) throw new Error('buy-fix-price returned no messages');
    return tx;
  }

  async listGiftCollections({ maxAgeMs = 3_600_000 } = {}) {
    if (Date.now() - this.giftCache.at < maxAgeMs && this.giftCache.items.length) return this.giftCache.items;
    const items = await this.#paged('/v1/gifts/collections', { pages: 10 });
    this.giftCache = {
      at: Date.now(),
      items: items.map((c) => ({ address: raw(c.address), name: c.name || '' })).filter((c) => c.address),
    };
    return this.giftCache.items;
  }

  async getCollectionInfo(collection) {
    const json = await this.http.get(`/v1/collection/${toFriendly(collection)}`);
    const rawColl = toRaw(collection);
    let isGift = false;
    try {
      isGift = (await this.listGiftCollections()).some((g) => g.address === rawColl);
    } catch (e) {
      log.debug('gift list unavailable:', e.message);
    }
    return { name: json?.response?.name || null, isGift };
  }
}
