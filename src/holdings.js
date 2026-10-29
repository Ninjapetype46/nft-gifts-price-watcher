// I/O side of "What are my gifts worth?": where the gifts come from and the daily job.
//  - TelegramGiftsSource: the owner's profile via Bot API getUserGifts (unique gifts only). Only
//    gifts visible on the profile are returned; the card says so.
//  - AddressSource: a public wallet (raw/friendly address or name.ton) via Getgems
//    /v1/nfts/owner + /v1/gifts/offchain/owner; .ton names resolve through TonAPI DNS.
//  - MockGiftsSource: Bot-API-shaped fixtures for mock mode.
// No wallet connection, no seed phrase, no business/gift-management permissions: read-only.
// Only public addresses and aggregate snapshots are stored (/forget deletes them).

import { isAddress, toRaw } from './address.js';
import { looksLikeGift } from './models.js';
import { DAY_MS } from './valuation.js';
import { feeModel } from './edge.js';
import { mapGiftToCollection, valuePortfolio, sellerGuard, offerAlerts, movers, drops, formatPortfolio } from './portfolio.js';
import { fiatAmount } from './rates.js';
import { escapeHtml } from './format.js';
import { mockProfileGifts } from './clients/mock.js';
import { createLogger } from './logger.js';

const log = createLogger('holdings');
export const PROFILE_SOURCE = 'profile';
export const PROFILE_FOOTER = 'Only gifts visible on your profile are counted.';
export const ADDRESS_FOOTER = 'Read-only view of a public wallet. Nothing is signed and no seed phrase is ever needed.';

/** Bot API OwnedGiftUnique -> holding (collection mapped later). */
export function mapOwnedGift(og) {
  const g = og.gift || {};
  const model = g.model?.name ?? null;
  return {
    baseName: g.base_name || g.name || 'Gift',
    title: `${g.base_name || 'Gift'} #${g.number ?? '?'}${model ? ` (${model})` : ''}`,
    number: g.number ?? null,
    nft: null,
    attrs: { model, backdrop: g.backdrop?.name ?? null, symbol: g.symbol?.name ?? null },
    // Held in Telegram (not a Getgems off-chain item): on-chain offers are shown for reference.
    contractType: 'telegram',
    burned: !!g.is_burned,
    fromBlockchain: !!g.is_from_blockchain,
    collection: null,
    ownListing: null,
  };
}

export class TelegramGiftsSource {
  /** @param {{getUserGifts: Function}} api grammY Api */
  constructor(api) {
    this.api = api;
  }

  /** Pages getUserGifts by offset; only unique (collectible) gifts. */
  async list(userId, { maxPages = 20 } = {}) {
    const out = [];
    let offset = '';
    for (let page = 0; page < maxPages; page++) {
      const r = await this.api.getUserGifts(userId, {
        exclude_unlimited: true,
        exclude_limited_upgradable: true,
        exclude_limited_non_upgradable: true,
        offset,
        limit: 100,
      });
      for (const g of r?.gifts || []) if (g.type === 'unique') out.push(mapOwnedGift(g));
      if (!r?.next_offset) break;
      offset = r.next_offset;
    }
    return out;
  }
}

export class MockGiftsSource {
  constructor(gifts = null) {
    this.gifts = gifts;
  }
  async list() {
    return (this.gifts || mockProfileGifts()).filter((g) => g.type === 'unique').map(mapOwnedGift);
  }
}

export class AddressSource {
  /** @param {{client: import('./clients/index.js').MarketClient, tonapi?: {resolveDns?: Function}|null}} o */
  constructor({ client, tonapi = null }) {
    this.client = client;
    this.tonapi = tonapi;
  }

  /** Raw address from an address or a name.ton. */
  async resolve(input) {
    const q = String(input || '').trim();
    if (isAddress(q)) return toRaw(q);
    if (/\.ton$/i.test(q)) {
      const r = this.tonapi?.resolveDns ? this.tonapi : this.client;
      if (typeof r.resolveDns !== 'function') throw new Error('cannot resolve .ton names with this data source');
      const a = await r.resolveDns(q.toLowerCase());
      if (!a) throw new Error(`${q} does not resolve to a wallet`);
      return a;
    }
    throw new Error(`"${q}" is not a TON address or a .ton name`);
  }

  async list(address) {
    if (typeof this.client.getNftsByOwner !== 'function') throw new Error('this data source cannot list wallet NFTs');
    let gifts = null;
    try {
      const list = await this.client.listGiftCollections();
      gifts = list?.length ? new Set(list.map((g) => g.address)) : null;
    } catch {
      gifts = null;
    }
    const onchain = (await this.client.getNftsByOwner(address)).filter((h) => (gifts ? gifts.has(h.collection) : looksLikeGift(h.attrs)));
    const offchain = typeof this.client.getOffchainGiftsByOwner === 'function' ? await this.client.getOffchainGiftsByOwner(address) : [];
    return [...onchain, ...offchain].map((h) => ({
      ...h,
      title: h.attrs?.model && !String(h.title).includes(`(${h.attrs.model})`) ? `${h.title} (${h.attrs.model})` : h.title,
      burned: false,
    }));
  }
}

export class PortfolioService {
  /**
   * @param {Object} o
   * @param {import('./config.js').Config} o.cfg
   * @param {import('./settings.js').Settings} o.settings
   * @param {import('./storage.js').Storage} o.storage
   * @param {import('./clients/index.js').MarketClient} o.client
   * @param {import('./engine.js').Engine} o.engine
   * @param {import('./offers.js').OfferBook} o.offers
   * @param {{get: Function}|null} [o.rates]
   * @param {{list: Function}|null} [o.giftsSource]
   * @param {AddressSource} [o.addressSource]
   */
  constructor({ cfg, settings, storage, client, engine, offers, rates = null, giftsSource = null, addressSource = null }) {
    Object.assign(this, { cfg, settings, storage, client, engine, offers, rates, giftsSource });
    this.addressSource = addressSource || new AddressSource({ client });
  }

  async profile(userId, { now = Date.now(), source = this.giftsSource } = {}) {
    if (!source) throw new Error('profile gifts need the Telegram bot (BOT_TOKEN)');
    const items = await source.list(userId);
    let gifts = [];
    try {
      gifts = await this.client.listGiftCollections();
    } catch (e) {
      log.warn('gift collection list unavailable:', e.message);
    }
    // The free TonAPI source has no gift collection list: it looks the names up instead.
    const missing = items.filter((it) => !it.burned && !mapGiftToCollection(it.baseName, gifts)).map((it) => it.baseName);
    if (missing.length && typeof this.client.findGiftCollections === 'function') {
      try {
        gifts = [...gifts, ...(await this.client.findGiftCollections(missing))];
      } catch (e) {
        log.warn('gift collection lookup failed:', e.message);
      }
    }
    for (const it of items) it.collection = mapGiftToCollection(it.baseName, gifts)?.address ?? null;
    return this.#run(items, { userId, source: PROFILE_SOURCE, footer: PROFILE_FOOTER, now });
  }

  async address(input, userId, { now = Date.now() } = {}) {
    const address = await this.addressSource.resolve(input);
    const items = await this.addressSource.list(address);
    const r = await this.#run(items, { userId, source: address, footer: ADDRESS_FOOTER, now });
    return { ...r, address };
  }

  async #run(items, { userId, source, footer, now }) {
    const lookback = this.settings.get('lookback_days');
    const counts = new Map();
    for (const it of items) if (it.collection && !it.burned) counts.set(it.collection, (counts.get(it.collection) || 0) + 1);
    const collections = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
    const refreshed = collections.slice(0, this.cfg.portfolioMaxCollections);
    const salesByCollection = {};
    const listingsByCollection = {};
    const offersByCollection = {};
    const feesByCollection = {};
    for (const c of collections) {
      if (refreshed.includes(c)) {
        try {
          // Respects SALES_REFRESH_MIN: the sales cache is reused across requests.
          await this.engine.refreshSales(c, now);
        } catch (e) {
          log.warn(`sales refresh for ${c} failed:`, e.message);
        }
      }
      salesByCollection[c] = this.storage.getSales(c, now - lookback * DAY_MS);
      listingsByCollection[c] = this.engine.lastListings?.[c] || [];
      offersByCollection[c] = this.offers ? await this.offers.collectionOffers(c) : [];
      if (listingsByCollection[c].length) feesByCollection[c] = feeModel(listingsByCollection[c], this.cfg);
    }
    const result = valuePortfolio({
      items,
      salesByCollection,
      listingsByCollection,
      offersByCollection,
      feesByCollection,
      params: this.settings.valuationParams(now, { sampled: !!this.client.salesSource?.()?.sampled }),
      cfg: this.cfg,
      now,
    });
    const prev = this.storage.lastSnapshot(userId, source, now);
    const moversList = movers(result, prev?.items);
    const byTitle = new Map(result.items.map((i) => [i.title, i]));
    const guard = sellerGuard(
      result.items.filter((i) => i.ownListing).map((i) => ({ title: i.title, priceTon: i.ownListing.priceTon })),
      byTitle,
      this.cfg,
    );
    const offers = offerAlerts(result.items, this.cfg);
    const dropList = drops(result, prev?.items, this.cfg.portfolioDropAlertPct);
    const compact = result.items.map((i) => ({ title: i.title, nft: i.nft, collection: i.collection, fairTon: i.fairTon, confidence: i.confidence }));
    const snapshotId = this.storage.addSnapshot(userId, source, result.totalTon, compact, now);
    const rates = this.rates ? await this.rates.get(now) : null;
    const text = formatPortfolio(result, { fiat: fiatAmount(result.totalTon, rates), moversList, guard, offers, footer, currency: this.cfg.currencyLabel });
    return { result, text, snapshotId, guard, offers, drops: dropList, collections };
  }

  /**
   * Daily job (PORTFOLIO_DAILY_HOUR): snapshot every tracked profile/address and send seller-guard,
   * offer and drop alerts, at most PORTFOLIO_MAX_ALERTS_PER_DAY per user.
   */
  async daily(now, notifier) {
    const tracked = this.storage.listPortfolioAddresses();
    let sent = 0;
    for (const t of tracked) {
      try {
        const r = t.address === PROFILE_SOURCE ? await this.profile(t.userId, { now }) : await this.address(t.address, t.userId, { now });
        const wantDrops = this.storage.kvGet(`pf_drop:${t.userId}`) === '1';
        const lines = [
          ...r.guard.map((g) => `🛡 ${g.text}`),
          ...r.offers.map((o) => `💰 ${o.text}`),
          ...(wantDrops ? r.drops.map((d) => `📉 ${escapeHtml(d.title)} dropped ${Math.abs(d.pct).toFixed(0)}% (${d.from.toFixed(2)} → ${d.to.toFixed(2)} TON)`) : []),
        ];
        const dayKey = `pf_alerts:${t.userId}:${new Date(now).toISOString().slice(0, 10)}`;
        let used = Number(this.storage.kvGet(dayKey) || 0);
        for (const line of lines) {
          if (used >= this.cfg.portfolioMaxAlertsPerDay) break;
          await notifier.text(line);
          used++;
          sent++;
        }
        this.storage.kvSet(dayKey, String(used));
      } catch (e) {
        log.warn(`daily portfolio for ${t.userId}/${t.address} failed:`, e.message);
      }
    }
    return sent;
  }
}
