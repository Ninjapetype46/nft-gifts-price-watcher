// Client layer: one interface, three implementations (Getgems, TonAPI, Mock).

import { GetgemsClient } from './getgems.js';
import { TonapiClient } from './tonapi.js';
import { MockClient } from './mock.js';
import { ConfigError } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('clients');

/**
 * Common interface implemented by every client.
 * @typedef {Object} MarketClient
 * @property {string} name
 * @property {(collection:string, opts?:{pages?:number}) => Promise<import('../models.js').Listing[]>} getListings
 * @property {(collection:string, opts:{sinceMs:number, windowSinceMs?:number, maxPages?:number}) => Promise<import('../models.js').Sale[]>} getSales
 * @property {(collection?:string) => {name:string, sampled:boolean, items:number|null, label:string}} [salesSource]
 *           where sales come from: "sales: Getgems API" or "sales: TonAPI sample of N items" (sampled)
 * @property {(nfts:string[]) => Promise<{nft:string, collection:string|null, name?:string, attrs:Record<string,string>}[]>} getNftAttributes
 * @property {(listing:import('../models.js').Listing) => Promise<import('../models.js').Listing|null>} refreshListing
 * @property {(listing:import('../models.js').Listing) => Promise<{uuid:string|null, messages:import('../models.js').OutMessage[]}|null>} getBuyTransaction
 *           null = not supported by this source -> direct sale-contract path
 * @property {() => Promise<{address:string, name:string}[]>} listGiftCollections
 * @property {(names:string[]) => Promise<{address:string, name:string}[]>} [findGiftCollections]
 *           gift collections by gift name, for sources without a list (TonAPI)
 * @property {(collection:string) => Promise<{name:string|null, isGift:boolean}>} getCollectionInfo
 * @property {(cycle:number) => void} [tick]
 * @property {boolean} [supportsOffers]   false -> "bids: n/a"
 * @property {(collection:string) => Promise<import('../edge.js').Offer[]>} [getCollectionOffers]
 * @property {(nft:string) => Promise<import('../edge.js').Offer[]>} [getNftOffers]
 * @property {() => Promise<{status:string}|null>} [getServerStatus]       null = unknown/skipped
 * @property {(address:string) => Promise<{tradingCount:number}|null>} [getUserTradingInfo]  null = skipped
 * @property {(owner:string) => Promise<object[]>} [getNftsByOwner]
 * @property {(owner:string) => Promise<object[]>} [getOffchainGiftsByOwner]
 * @property {(name:string) => Promise<string|null>} [resolveDns]
 */

export { GetgemsClient, TonapiClient, MockClient };

/**
 * @param {import('../config.js').Config} cfg
 * @param {{mock?: boolean}} [opts]
 * @returns {MarketClient}
 */
export function createClient(cfg, { mock = false } = {}) {
  if (mock) return new MockClient();
  let source = cfg.dataSource;
  if (source === 'auto') {
    source = cfg.getgemsApiKey ? 'getgems' : 'tonapi';
    if (source === 'tonapi') {
      log.info(
        `GETGEMS_API_KEY is empty: using the free TonAPI source (listings + sales history sampled from up to ${cfg.tonapiHistoryItems} items per collection; no bids)`,
      );
    }
  }
  if (source === 'getgems') {
    if (!cfg.getgemsApiKey) {
      throw new ConfigError('Missing required .env key GETGEMS_API_KEY (DATA_SOURCE=getgems). Get one at https://getgems.io/public-api');
    }
    return new GetgemsClient({
      apiKey: cfg.getgemsApiKey,
      baseUrl: cfg.getgemsApiBase,
      minIntervalMs: cfg.requestMinIntervalMs,
      includeOffchain: cfg.getgemsIncludeOffchain,
    });
  }
  return createTonapi(cfg);
}

/** TonAPI client is also used for on-chain checks of sale contracts (direct buy path). */
export function createTonapi(cfg) {
  return new TonapiClient({
    apiKey: cfg.tonapiKey,
    baseUrl: cfg.tonapiBase,
    scanItems: cfg.tonapiScanItems,
    minIntervalMs: cfg.requestMinIntervalMs,
    historyItems: cfg.tonapiHistoryItems,
    historyTtlMin: cfg.tonapiHistoryTtlMin,
    getgemsBase: cfg.getgemsApiBase,
  });
}
