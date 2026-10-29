// OfferBook: open bids (Getgems offers) for alerted listings, under a strict call budget.
// Collection offers are cached for OFFERS_TTL_MIN; the API is called lazily, only for listings
// that already produced an alert, and at most OFFERS_MAX_CALLS_PER_CYCLE times per cycle to
// protect the Getgems budget of 400 requests / 5 minutes. The bot never accepts a bid.

import { bidCover } from './edge.js';
import { createLogger } from './logger.js';

const log = createLogger('offers');

export class OfferBook {
  /**
   * @param {{client: import('./clients/index.js').MarketClient, cfg: import('./config.js').Config, now?: () => number}} o
   */
  constructor({ client, cfg, now = () => Date.now() }) {
    this.client = client;
    this.cfg = cfg;
    this.now = now;
    /** @type {Map<string, {at:number, offers:import('./edge.js').Offer[]}>} */
    this.cache = new Map();
    this.calls = 0;
    this.totalCalls = 0;
  }

  /** True when this data source can return Getgems offers at all. */
  get available() {
    return this.cfg.offersEnabled !== false && this.client.supportsOffers !== false && typeof this.client.getCollectionOffers === 'function';
  }

  beginCycle() {
    this.calls = 0;
  }

  #budget() {
    if (this.calls >= this.cfg.offersMaxCallsPerCycle) return false;
    this.calls++;
    this.totalCalls++;
    return true;
  }

  /** Cached collection offers (one API call per TTL, within the per-cycle budget). */
  async collectionOffers(collection) {
    if (!this.available) return [];
    const ttl = this.cfg.offersTtlMin * 60_000;
    const hit = this.cache.get(collection);
    if (hit && this.now() - hit.at < ttl) return hit.offers;
    if (!this.#budget()) return hit?.offers ?? [];
    try {
      const offers = await this.client.getCollectionOffers(collection);
      this.cache.set(collection, { at: this.now(), offers });
      return offers;
    } catch (e) {
      log.debug(`collection offers ${collection} failed:`, e.message);
      return hit?.offers ?? [];
    }
  }

  /**
   * Best bid covering this listing. Only called for alerted listings.
   * @returns {Promise<{available:boolean, bid: ReturnType<typeof bidCover>}>}
   */
  async bidFor(listing) {
    if (!this.available) return { available: false, bid: null };
    const offers = [...(await this.collectionOffers(listing.collection))];
    if (typeof this.client.getNftOffers === 'function' && this.#budget()) {
      try {
        offers.push(...(await this.client.getNftOffers(listing.nft)));
      } catch (e) {
        log.debug(`nft offers ${listing.nft} failed:`, e.message);
      }
    }
    return { available: true, bid: bidCover(listing, offers, this.now()) };
  }
}
