// I/O side of the "Safe to buy?" traffic light: gathers facts for risk.assessRisk().
//  - Alert time: no extra API calls (official gift list is cached by the client; sale type,
//    "too good to be true" and data confidence come from the alert itself).
//  - Buy time: adds fragment_ban and price_fresh from the pre-buy refresh, market_status from
//    GET /v1/server-status (public, cached RISK_STATUS_TTL_SEC) and seller_history from
//    GET /v1/user-trading-info (cached SELLER_INFO_TTL_MIN). A client method that is missing or
//    returns null means "unknown, skip the check".

import { looksLikeGift } from './models.js';
import { toRaw } from './address.js';
import { createLogger } from './logger.js';

const log = createLogger('riskfacts');

export class RiskFacts {
  /**
   * @param {{client: import('./clients/index.js').MarketClient, cfg: import('./config.js').Config, now?: () => number}} o
   */
  constructor({ client, cfg, now = () => Date.now() }) {
    this.client = client;
    this.cfg = cfg;
    this.now = now;
    this.status = null; // {at, value}
    /** @type {Map<string, {at:number, value:any}>} */
    this.sellers = new Map();
    this.allowlist = (cfg.giftCollectionAllowlist || []).map((a) => {
      try {
        return toRaw(a);
      } catch {
        return a;
      }
    });
  }

  /** Official gift collection list (raw addresses), or null when unavailable. */
  async giftCollections() {
    if (typeof this.client.listGiftCollections !== 'function') return null;
    try {
      const list = await this.client.listGiftCollections();
      // An empty list cannot be right (TonAPI has none): treat it as "could not verify".
      return list?.length ? list.map((g) => g.address) : null;
    } catch (e) {
      log.debug('gift list unavailable:', e.message);
      return null;
    }
  }

  /** 'up' | 'warn' | 'down' | 'error', or undefined when the source cannot tell. Cached. */
  async marketStatus() {
    if (typeof this.client.getServerStatus !== 'function') return undefined;
    const ttl = (this.cfg.riskStatusTtlSec ?? 60) * 1000;
    if (this.status && this.now() - this.status.at < ttl) return this.status.value;
    let value;
    try {
      const s = await this.client.getServerStatus();
      value = s ? s.status : undefined;
    } catch (e) {
      log.debug('server status failed:', e.message);
      value = 'error';
    }
    this.status = { at: this.now(), value };
    return value;
  }

  /** {tradingCount} | null (skipped). Cached per seller. */
  async sellerInfo(seller) {
    if (!seller || typeof this.client.getUserTradingInfo !== 'function') return null;
    const ttl = (this.cfg.sellerInfoTtlMin ?? 60) * 60_000;
    const hit = this.sellers.get(seller);
    if (hit && this.now() - hit.at < ttl) return hit.value;
    let value = null;
    try {
      value = await this.client.getUserTradingInfo(seller);
    } catch (e) {
      log.debug('seller info failed:', e.message);
      value = null;
    }
    this.sellers.set(seller, { at: this.now(), value });
    return value;
  }

  /**
   * Facts available at alert time (no extra calls beyond the cached gift list).
   * @param {import('./models.js').Listing} listing
   * @param {object|null} alert
   */
  async alertTime(listing, alert = null) {
    const isGift = looksLikeGift(listing.attrs);
    const v = alert?.valuation;
    return {
      isGift,
      collection: listing.collection,
      giftCollections: isGift ? await this.giftCollections() : undefined,
      allowlist: this.allowlist,
      contractType: listing.contractType ?? null,
      warning: listing.warning === undefined ? undefined : listing.warning,
      priceTon: listing.priceTon,
      fairTon: v?.fairValueTon ?? null,
      confidence: v ? (v.fairValueTon !== null ? v.confidence : undefined) : undefined,
    };
  }

  /**
   * Alert-time facts plus the pre-buy refresh, market status and seller history.
   * @param {import('./models.js').Listing} listing  listing as alerted
   * @param {import('./models.js').Listing|null} fresh  refreshListing() result (null = gone)
   * @param {object|null} alert
   */
  async buyTime(listing, fresh, alert = null) {
    const base = await this.alertTime(fresh ? { ...listing, ...fresh, attrs: listing.attrs } : listing, alert);
    const priceUp = !!fresh && BigInt(fresh.priceNano) > BigInt(listing.priceNano);
    return {
      ...base,
      warning: fresh ? (fresh.warning ?? null) : base.warning,
      priceFresh: { gone: !fresh, priceUp, newPriceTon: fresh?.priceTon ?? null },
      marketStatus: await this.marketStatus(),
      sellerInfo: await this.sellerInfo((fresh || listing).seller),
    };
  }
}
