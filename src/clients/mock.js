// Offline client with deterministic fixtures. Used by `mock`, `valuate --mock`, `portfolio --mock`
// and tests. The fixtures are built so one mock run visibly exercises every feature:
//  - honest price: a wash loop on Model "Bronze", a Getgems-flagged and an outlier Silver sale,
//    a single "Neon" sale (thin, mixed fallback -> confidence C);
//  - profit card: fees/royalty on every listing, collection offers (one covers Bronze), a fixed
//    1 TON = $1.25 rate, a non-gift "Mock Frogs" collection whose cheapest listing loses after fees;
//  - traffic light: a lookalike "Mock Plush Pepes" collection that is not in the official gift
//    list, a Fragment-banned punk, an off-chain Silver from a first-time seller;
//  - paper scoreboard: Bronze #1 is sold to someone else 12 s after it appeared (a lost race),
//    and cycle 3 brings fresh Gold sales (marks up) and a Silver price drop;
//  - portfolio: Bot-API-shaped profile gifts and a "mock-wallet.ton" address with an underpriced
//    own listing and a Gold covered by a 44 TON bid;
//  - free sales history: "Mock Frogs" sales come through the TonAPI path (live-shaped
//    /v2/accounts/{nft}/events NftPurchase events -> pickHistorySample -> parseTonapiPurchases),
//    so its alert says "sales: TonAPI sample of N items"; the other collections use the
//    Getgems history shape ("sales: Getgems API").

import { tonToNano, nanoToTon } from '../models.js';
import { toFriendly } from '../address.js';
import { parseTonapiPurchases, pickHistorySample } from './tonapi.js';

const DAY = 86_400_000;
const addr = (tag, i) => '0:' + (tag + i.toString(16)).padStart(64, '0');

export const MOCK_GIFT_COLLECTION = '0:' + 'a1'.repeat(32);
export const MOCK_PUNK_COLLECTION = '0:' + 'b2'.repeat(32);
/** Lookalike: same name as the real gift collection, but not in Getgems' official gift list. */
export const MOCK_FAKE_COLLECTION = '0:' + 'c3'.repeat(32);
export const MOCK_FROG_COLLECTION = '0:' + 'd4'.repeat(32);
export const MOCK_WALLET_NAME = 'mock-wallet.ton';
export const MOCK_WALLET = addr('ab', 1);
export const MOCK_RATES = { usd: 1.25 };
/**
 * Other markets' floors files (suite.floors.v1) for the mock's /compare and CHEAPER_ELSEWHERE demo.
 * They live under src/ because the mock reads them at runtime.
 */
export const MOCK_PEER_FIXTURES = new URL('../mock/fixtures/peers/', import.meta.url);
export const MOCK_COLLECTION_NAMES = {
  [MOCK_GIFT_COLLECTION]: 'Mock Plush Pepes',
  [MOCK_PUNK_COLLECTION]: 'Mock Punks',
  [MOCK_FAKE_COLLECTION]: 'Mock Plush Pepes',
  [MOCK_FROG_COLLECTION]: 'Mock Frogs',
};

const BACKDROPS = ['Onyx Black', 'Navy Blue', 'Ruby Red'];
const SYMBOLS = ['Star', 'Moon'];
const W1 = addr('a7', 1);
const W2 = addr('a7', 2);

/** [model, priceTon, daysAgo] — comparable sales for the gift collection. */
const GIFT_SALES = [
  ['Gold', 41, 1], ['Gold', 39, 3], ['Gold', 42, 5], ['Gold', 38, 8], ['Gold', 40, 12], ['Gold', 44, 20],
  ['Gold', 90, 45], // outside the 30d window
  ['Silver', 15, 1], ['Silver', 14, 2], ['Silver', 16, 4], ['Silver', 15, 6], ['Silver', 13, 9], ['Silver', 17, 15], ['Silver', 15, 22],
  ['Bronze', 8, 0.5], ['Bronze', 7.5, 2], ['Bronze', 8.5, 3], ['Bronze', 8, 5], ['Bronze', 9, 7], ['Bronze', 7, 10], ['Bronze', 8, 14], ['Bronze', 8.2, 25],
  ['Neon', 30, 12], // only one comparable (and no sale in 7d) -> Backdrop fallback, confidence C, illiquid
];

/**
 * Wash loop on Model "Bronze": one NFT ping-pongs between W1 and W2 six times in 3 days, and the
 * same two wallets trade one more Bronze. Without the filter Bronze "fair" would be ~14 TON.
 * [nftIndex, priceTon, daysAgo, from, to]
 */
const WASH_SALES = [
  [1, 14.0, 2.9, W1, W2],
  [1, 14.6, 2.4, W2, W1],
  [1, 14.2, 1.9, W1, W2],
  [1, 14.4, 1.4, W2, W1],
  [1, 14.1, 0.9, W1, W2],
  [1, 14.5, 0.4, W2, W1],
  [2, 14.3, 1.2, W2, W1],
];

/** [model, backdrop, symbol, priceTon, appearsOnCycle, extra] */
const GIFT_LISTINGS = [
  ['Bronze', 'Onyx Black', 'Star', 4, 1, { untilCycle: 1 }], // #1 bargain; sold to someone else 12 s after it appeared
  ['Neon', 'Navy Blue', 'Moon', 5, 1], // #2 looks cheap only vs a mixed Backdrop fallback -> confidence C
  ['Gold', 'Ruby Red', 'Moon', 15, 1], // #3 bargain (fair ~41), paper-bought, marks up in cycle 3
  ['Bronze', 'Navy Blue', 'Moon', 8.5, 1], // fake "undervalued" without the wash filter
  ['Bronze', 'Ruby Red', 'Star', 9, 1], // fake "undervalued" without the wash filter
  ['Silver', 'Onyx Black', 'Star', 16, 1],
  ['Silver', 'Navy Blue', 'Star', 18, 1],
  ['Gold', 'Onyx Black', 'Star', 45, 1],
  ['Gold', 'Navy Blue', 'Moon', 48, 1],
  ['Silver', 'Ruby Red', 'Star', 9, 2, { contractType: 'offchain', firstTimeSeller: true }], // #10 off-chain, first-time seller
  ['Gold', 'Navy Blue', 'Star', 16, 1], // #11 green bargain that hits MAX_BUYS_PER_HOUR
  ['Gold', 'Ruby Red', 'Star', 18, 1], // #12 cheaper all-in on Portals (peer fixtures) -> CHEAPER_ELSEWHERE
];

const PUNK_TYPES = ['Alien', 'Ape', 'Human'];
const PUNK_SALES = [3.1, 2.8, 3.0, 3.3, 2.9, 3.2, 3.0, 2.7, 3.4, 3.0, 3.1, 2.9];
/** [priceTon, appearsOnCycle] */
const PUNK_LISTINGS = [[1.5, 1], [2.9, 1], [3.2, 1], [3.5, 1], [4.0, 1], [1.4, 3]];
/** Mock Punk #100 is banned from Fragment (warning appears on the pre-buy refresh). */
const PUNK_BANNED_INDEX = 0;

const FROG_SALES = [[3.1, 1], [3.2, 2], [3.0, 3], [3.1, 4], [3.15, 6], [3.05, 8], [3.1, 10], [3.2, 13], [3.0, 16], [3.1, 20]];

/** One TonAPI account event with an NftPurchase action (the live shape, see test/fixtures/tonapi). */
export function mockTonapiPurchaseEvent({ eventId, nft, collection, collectionName, name, attrs, priceTon, timeMs, seller, buyer }) {
  return {
    event_id: eventId,
    account: { address: nft, is_scam: false, is_wallet: false },
    timestamp: Math.floor(timeMs / 1000),
    actions: [
      {
        type: 'NftPurchase',
        status: 'ok',
        NftPurchase: {
          auction_type: 'getgems',
          amount: { currency_type: 'native', value: tonToNano(priceTon).toString(), decimals: 9, token_name: 'TON' },
          nft: {
            address: nft,
            collection: { address: collection, name: collectionName },
            verified: true,
            metadata: { name, attributes: Object.entries(attrs).map(([k, v]) => ({ trait_type: k[0].toUpperCase() + k.slice(1), value: v })) },
          },
          seller: { address: seller, is_scam: false, is_wallet: true },
          buyer: { address: buyer, is_scam: false, is_wallet: true },
        },
      },
    ],
    is_scam: false,
    lt: 0,
    in_progress: false,
  };
}
const FROG_LISTINGS = [[2.95, 1], [3.6, 1], [3.8, 1], [4.0, 1]];

/** Bot API getUserGifts payload (OwnedGiftUnique objects) for the mock profile. */
export function mockProfileGifts(now = Date.now()) {
  const g = (base, number, model, backdrop, symbol, extra = {}) => ({
    type: 'unique',
    gift: {
      gift_id: `g-${base}-${number}`,
      base_name: base,
      name: `${base.replace(/\s/g, '')}-${number}`,
      number,
      model: { name: model, sticker: {}, rarity_per_mille: 12 },
      symbol: { name: symbol, sticker: {}, rarity_per_mille: 20 },
      backdrop: { name: backdrop, colors: {}, rarity_per_mille: 15 },
      ...extra,
    },
    send_date: Math.floor(now / 1000) - 86_400,
  });
  return [
    g('Mock Plush Pepe', 77, 'Gold', 'Onyx Black', 'Star'),
    g('Mock Plush Pepe', 12, 'Silver', 'Navy Blue', 'Moon'),
    g('Mock Plush Pepe', 3, 'Bronze', 'Onyx Black', 'Star'),
    g('Mock Plush Pepe', 4, 'Bronze', 'Ruby Red', 'Moon'),
    g('Mock Plush Pepe', 5, 'Neon', 'Navy Blue', 'Moon'),
    g('Mystery Box', 1, 'Crate', 'Gray', 'Question'),
    g('Mock Plush Pepe', 9, 'Bronze', 'Ruby Red', 'Star', { is_burned: true }),
  ];
}

export class MockClient {
  name = 'mock';
  supportsOffers = true;

  constructor({ now = Date.now() } = {}) {
    this.now = now;
    this.cycle = 1;
    /** @type {Map<string, {nft:string, collection:string, name:string, attrs:Record<string,string>}>} */
    this.nfts = new Map();
    this.sales = [];
    this.listings = [];
    /** @type {Map<string, number>} wall-clock time when getListings first returned an NFT */
    this.firstSeenAt = new Map();
    this.firstTimeSellers = new Set();
    this.serverStatus = 'up';
    this.calls = { collectionOffers: 0, nftOffers: 0, serverStatus: 0, tradingInfo: 0, refresh: 0, tonapiHistory: 0 };
    this.cycle3Added = false;
    /** @type {Map<string, {events: object[]}>} TonAPI account events per NFT (Mock Frogs) */
    this.tonapiEvents = new Map();
    /** TonAPI history sample state for Mock Frogs (same picker as TonapiClient). */
    this.tonapiSample = { at: {}, cursor: 0, max: 60 };
    this.#build();
  }

  #nft(nft, collection, name, attrs) {
    this.nfts.set(nft, { nft, collection, name, attrs });
  }

  #sale(nft, collection, name, priceTon, timeMs, txHash, oldOwner, newOwner, rejectTop = false) {
    this.sales.push({ nft, collection, name, priceTon, timeMs, txHash, oldOwner, newOwner, rejectTop });
  }

  #build() {
    const G = MOCK_GIFT_COLLECTION;
    GIFT_SALES.forEach(([model, price, daysAgo], i) => {
      const nft = addr('c1', i + 1);
      const name = `Mock Pepe #${1000 + i}`;
      this.#nft(nft, G, name, { model, backdrop: BACKDROPS[i % 3], symbol: SYMBOLS[i % 2] });
      this.#sale(nft, G, name, price, this.now - daysAgo * DAY, `mock-sale-g${i}`, addr('0a', i), addr('0b', i));
    });
    // Wash loop (Bronze), see WASH_SALES.
    this.#nft(addr('c9', 1), G, 'Mock Pepe #2001', { model: 'Bronze', backdrop: 'Ruby Red', symbol: 'Moon' });
    this.#nft(addr('c9', 2), G, 'Mock Pepe #2002', { model: 'Bronze', backdrop: 'Onyx Black', symbol: 'Star' });
    WASH_SALES.forEach(([k, price, daysAgo, from, to], i) => {
      const nft = addr('c9', k);
      this.#sale(nft, G, this.nfts.get(nft).name, price, this.now - daysAgo * DAY, `mock-wash-${i}`, from, to);
    });
    // Silver: one sale Getgems flags (rejectFromGlobalTop) and one outlier.
    this.#nft(addr('c8', 1), G, 'Mock Pepe #3001', { model: 'Silver', backdrop: 'Onyx Black', symbol: 'Moon' });
    this.#nft(addr('c8', 2), G, 'Mock Pepe #3002', { model: 'Silver', backdrop: 'Onyx Black', symbol: 'Star' });
    this.#sale(addr('c8', 1), G, 'Mock Pepe #3001', 60, this.now - 2 * DAY, 'mock-flagged-1', addr('0c', 1), addr('0d', 1), true);
    this.#sale(addr('c8', 2), G, 'Mock Pepe #3002', 31, this.now - 1 * DAY, 'mock-outlier-1', addr('0c', 2), addr('0d', 2));

    GIFT_LISTINGS.forEach(([model, backdrop, symbol, price, cycle, extra = {}], i) => {
      const nft = addr('e1', i + 1);
      const name = `Mock Pepe #${i + 1}`;
      const attrs = { model, backdrop, symbol };
      this.#nft(nft, G, name, attrs);
      const l = this.#listing(nft, G, name, attrs, price, i, extra);
      if (extra.firstTimeSeller) this.firstTimeSellers.add(l.seller);
      this.listings.push({ cycle, until: extra.untilCycle ?? Infinity, listing: l });
    });

    PUNK_SALES.forEach((price, i) => {
      const nft = addr('d2', i + 1);
      const name = `Mock Punk #${i + 1}`;
      this.#nft(nft, MOCK_PUNK_COLLECTION, name, { type: PUNK_TYPES[i % 3] });
      this.#sale(nft, MOCK_PUNK_COLLECTION, name, price, this.now - (i + 1) * 2 * DAY, `mock-sale-p${i}`, addr('1a', i), addr('1b', i));
    });
    PUNK_LISTINGS.forEach(([price, cycle], i) => {
      const nft = addr('f2', i + 1);
      const name = `Mock Punk #${100 + i}`;
      const attrs = { type: PUNK_TYPES[i % 3] };
      this.#nft(nft, MOCK_PUNK_COLLECTION, name, attrs);
      this.listings.push({ cycle, until: Infinity, listing: this.#listing(nft, MOCK_PUNK_COLLECTION, name, attrs, price, 100 + i) });
    });
    this.bannedPunk = addr('f2', PUNK_BANNED_INDEX + 1);

    // Lookalike collection: same name and gift traits, own "sales" at 40, not an official gift collection.
    [[40, 2], [40, 5], [40, 9]].forEach(([price, daysAgo], i) => {
      const nft = addr('c3', i + 1);
      const name = `Mock Plush Pepe #${9000 + i}`;
      this.#nft(nft, MOCK_FAKE_COLLECTION, name, { model: 'Gold', backdrop: 'Onyx Black', symbol: 'Star' });
      this.#sale(nft, MOCK_FAKE_COLLECTION, name, price, this.now - daysAgo * DAY, `mock-fake-${i}`, addr('2a', i), addr('2b', i));
    });
    {
      const nft = addr('c3', 0x10);
      const attrs = { model: 'Gold', backdrop: 'Onyx Black', symbol: 'Star' };
      this.#nft(nft, MOCK_FAKE_COLLECTION, 'Plush Pepe #777', attrs);
      this.listings.push({ cycle: 1, until: Infinity, listing: this.#listing(nft, MOCK_FAKE_COLLECTION, 'Plush Pepe #777', attrs, 6, 300) });
    }

    // Non-gift collection whose cheapest listing is "below floor" but loses money after fees.
    // Its sales are served as TonAPI NftPurchase events (free sales-history path), not Getgems history.
    FROG_SALES.forEach(([price, daysAgo], i) => {
      const nft = addr('d4', i + 1);
      const name = `Mock Frog #${i + 1}`;
      this.#nft(nft, MOCK_FROG_COLLECTION, name, { skin: 'Green' });
      const ev = mockTonapiPurchaseEvent({
        eventId: `mock-tonapi-frog-${i}`,
        nft,
        collection: MOCK_FROG_COLLECTION,
        collectionName: 'Mock Frogs',
        name,
        attrs: { skin: 'Green' },
        priceTon: price,
        timeMs: this.now - daysAgo * DAY,
        seller: addr('3a', i),
        buyer: addr('3b', i),
      });
      this.tonapiEvents.set(nft, { events: [ev] });
    });
    FROG_LISTINGS.forEach(([price, cycle], i) => {
      const nft = addr('f4', i + 1);
      const name = `Mock Frog #${200 + i}`;
      this.#nft(nft, MOCK_FROG_COLLECTION, name, { skin: 'Green' });
      this.listings.push({ cycle, until: Infinity, listing: this.#listing(nft, MOCK_FROG_COLLECTION, name, { skin: 'Green' }, price, 200 + i) });
    });

    // Wallet "mock-wallet.ton": an underpriced own Silver listing and an unlisted Gold/Onyx Black.
    this.#nft(addr('ac', 1), G, 'Mock Pepe #501', { model: 'Silver', backdrop: 'Navy Blue', symbol: 'Moon' });
    this.#nft(addr('ac', 2), G, 'Mock Pepe #502', { model: 'Gold', backdrop: 'Onyx Black', symbol: 'Star' });
    this.walletListing = this.#listing(addr('ac', 1), G, 'Mock Pepe #501', { model: 'Silver', backdrop: 'Navy Blue', symbol: 'Moon' }, 10, 500, { seller: MOCK_WALLET });
  }

  #listing(nft, collection, name, attrs, priceTon, i, extra = {}) {
    const priceNano = tonToNano(priceTon).toString();
    const fee = (BigInt(priceNano) * 5n) / 100n;
    return {
      nft,
      collection,
      name,
      attrs,
      priceNano,
      priceTon: nanoToTon(priceNano),
      saleContract: addr('5a', i + 1),
      saleVersion: `mock-version-${i}`,
      contractType: extra.contractType || 'sale-contract',
      seller: extra.seller || addr('77', i + 1),
      market: 'getgems',
      source: 'mock',
      marketplaceFeeNano: fee.toString(),
      royaltyNano: fee.toString(),
      warning: null,
    };
  }

  /** Called by the engine at the start of every cycle. */
  tick(cycle) {
    this.cycle = cycle;
    if (cycle >= 3 && !this.cycle3Added) {
      this.cycle3Added = true;
      const t = Date.now();
      const G = MOCK_GIFT_COLLECTION;
      // Two fresh Gold sales at 45: the Gold #3 paper position marks up.
      [1, 2].forEach((k) => {
        const nft = addr('c7', k);
        this.#nft(nft, G, `Mock Pepe #${4000 + k}`, { model: 'Gold', backdrop: 'Onyx Black', symbol: 'Moon' });
        this.#sale(nft, G, `Mock Pepe #${4000 + k}`, 45, t - k * 1000, `mock-c3-gold-${k}`, addr('4a', k), addr('4b', k));
      });
      // Silver sells at 8 five times: the shadow fill on Silver #10 loses.
      [1, 2, 3, 4, 5].forEach((k) => {
        const nft = addr('c6', k);
        this.#nft(nft, G, `Mock Pepe #${5000 + k}`, { model: 'Silver', backdrop: 'Ruby Red', symbol: 'Moon' });
        this.#sale(nft, G, `Mock Pepe #${5000 + k}`, 8, t - k * 1500, `mock-c3-silver-${k}`, addr('5c', k), addr('5d', k));
      });
    }
  }

  #active() {
    return this.listings.filter((x) => x.cycle <= this.cycle && this.cycle <= x.until).map((x) => x.listing);
  }

  async getListings(collection) {
    const out = this.#active().filter((l) => l.collection === collection);
    const now = Date.now();
    for (const l of out) if (!this.firstSeenAt.has(l.nft)) this.firstSeenAt.set(l.nft, now);
    return out.map((l) => ({ ...l, attrs: { ...l.attrs } }));
  }

  /** Sold events incl. the "lost race" sale of Mock Pepe #1 from cycle 2 on. */
  #allSales() {
    const out = [...this.sales];
    const first = this.listings[0].listing; // Mock Pepe #1
    const seen = this.firstSeenAt.get(first.nft);
    if (this.cycle >= 2 && seen) {
      out.push({
        nft: first.nft,
        collection: first.collection,
        name: first.name,
        priceTon: first.priceTon,
        timeMs: seen + 12_000,
        txHash: 'mock-race-1',
        oldOwner: first.seller,
        newOwner: addr('99', 1),
        rejectTop: false,
      });
    }
    return out;
  }

  async getSales(collection, { sinceMs, windowSinceMs = sinceMs }) {
    if (collection === MOCK_FROG_COLLECTION) return this.#tonapiSales(collection, windowSinceMs);
    return this.#allSales().filter((s) => s.collection === collection && s.timeMs >= sinceMs).map((s) => ({ ...s }));
  }

  /** TonAPI path, offline: sample items like TonapiClient, map their NftPurchase events. */
  #tonapiSales(collection, sinceMs) {
    const st = this.tonapiSample;
    const listed = this.#active().filter((l) => l.collection === collection).map((l) => l.nft);
    const all = [...this.nfts.values()].filter((n) => n.collection === collection).map((n) => n.nft);
    const { pick, cursor } = pickHistorySample({ listed, others: all.filter((n) => !listed.includes(n)), cursor: st.cursor, max: st.max, fresh: (n) => n in st.at });
    st.cursor = cursor;
    const out = [];
    for (const nft of pick) {
      this.calls.tonapiHistory++;
      st.at[nft] = Date.now();
      out.push(...parseTonapiPurchases(this.tonapiEvents.get(nft) || { events: [] }, { collection }).sales);
    }
    return out.filter((s) => s.timeMs >= sinceMs);
  }

  /** Mock Frogs: TonAPI sample; everything else: Getgems history shape. */
  salesSource(collection) {
    if (!collection) return { name: 'mock', sampled: false, items: null, label: 'sales: mock fixtures (Getgems API shape; Mock Frogs via the TonAPI history path)' };
    if (collection === MOCK_FROG_COLLECTION) {
      const n = Object.keys(this.tonapiSample.at).length;
      return { name: 'tonapi', sampled: true, items: n, label: `sales: TonAPI sample of ${n} items` };
    }
    return { name: 'getgems', sampled: false, items: null, label: 'sales: Getgems API' };
  }

  async getNftAttributes(nfts) {
    return nfts.map((n) => this.nfts.get(n)).filter(Boolean).map((x) => ({ ...x, attrs: { ...x.attrs } }));
  }

  async refreshListing(listing) {
    this.calls.refresh++;
    const l = this.#active().find((x) => x.nft === listing.nft);
    if (!l) return null;
    if (l.nft === this.bannedPunk) return { ...l, warning: { type: 'NftBanFromFragment', reason: 'test' } };
    return { ...l };
  }

  async getBuyTransaction(listing) {
    const amount = BigInt(listing.priceNano) + tonToNano('0.2');
    return {
      uuid: `mock-${listing.nft.slice(-6)}`,
      timeout: null,
      messages: [{ to: toFriendly(listing.saleContract), amountNano: amount.toString(), payloadB64: null, stateInitB64: null }],
    };
  }

  async listGiftCollections() {
    // The lookalike MOCK_FAKE_COLLECTION is deliberately missing.
    return [{ address: MOCK_GIFT_COLLECTION, name: 'Mock Plush Pepes' }];
  }

  /** Like TonapiClient.findGiftCollections: verified gift collections by gift name (no lookalikes). */
  async findGiftCollections(names) {
    const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const verified = [{ address: MOCK_GIFT_COLLECTION, name: 'Mock Plush Pepes' }];
    return verified.filter((g) => (names || []).some((n) => key(g.name) === key(n) || key(g.name) === `${key(n)}s`));
  }

  async getCollectionInfo(collection) {
    if (collection === MOCK_GIFT_COLLECTION) return { name: 'Mock Plush Pepes', isGift: true };
    if (collection === MOCK_PUNK_COLLECTION) return { name: 'Mock Punks', isGift: false };
    if (collection === MOCK_FAKE_COLLECTION) return { name: 'Mock Plush Pepes', isGift: false };
    if (collection === MOCK_FROG_COLLECTION) return { name: 'Mock Frogs', isGift: false };
    return { name: null, isGift: false };
  }

  async getCollectionOffers(collection) {
    this.calls.collectionOffers++;
    if (collection !== MOCK_GIFT_COLLECTION) return [];
    const now = Date.now();
    return [
      // Covers any Bronze (finishAt in seconds): the Bronze #1 instant exit.
      { netTon: 6.5, fullTon: 7.3, currency: 'TON', offerAddress: addr('0f', 1), finishAt: Math.floor((now + 2 * DAY) / 1000), isCollectionOffer: true, isOffchain: false, maxQuantity: 3, purchasedQuantity: 1, attributes: [{ trait: 'Model', values: ['Bronze'] }] },
      // Expired (finishAt in ms): ignored.
      { netTon: 30, fullTon: 33, currency: 'TON', offerAddress: addr('0f', 2), finishAt: now - 3_600_000, isCollectionOffer: true, isOffchain: false, maxQuantity: 5, purchasedQuantity: 0, attributes: [{ trait: 'Model', values: ['Silver (2%)'] }] },
      // Fully filled: ignored.
      { netTon: 25, fullTon: 28, currency: 'TON', offerAddress: addr('0f', 3), finishAt: Math.floor((now + 3 * DAY) / 1000), isCollectionOffer: true, isOffchain: false, maxQuantity: 2, purchasedQuantity: 2, attributes: [{ trait: 'Model', values: ['Silver'] }] },
      // Gold + Onyx Black only: does not cover Gold #3 (Ruby Red); covers the wallet's Gold.
      { netTon: 44, fullTon: 49, currency: 'TON', offerAddress: addr('0f', 4), finishAt: Math.floor((now + 5 * DAY) / 1000), isCollectionOffer: true, isOffchain: false, maxQuantity: 1, purchasedQuantity: 0, attributes: [{ trait: 'model', values: ['gold'] }, { trait: 'Backdrop', values: ['Onyx Black (1.5%)'] }] },
    ];
  }

  async getNftOffers() {
    this.calls.nftOffers++;
    return [];
  }

  async getServerStatus() {
    this.calls.serverStatus++;
    return { status: this.serverStatus, time: new Date().toISOString(), services: [] };
  }

  async getUserTradingInfo(address) {
    this.calls.tradingInfo++;
    return { tradingCount: this.firstTimeSellers.has(address) ? 0 : 12, tradingVolume: null, balance: null };
  }

  async getNftsByOwner(owner) {
    if (owner !== MOCK_WALLET) return [];
    const gold = this.nfts.get(addr('ac', 2));
    return [
      { nft: addr('ac', 1), collection: MOCK_GIFT_COLLECTION, title: 'Mock Pepe #501', number: 501, attrs: { ...this.walletListing.attrs }, contractType: 'sale-contract', ownListing: { ...this.walletListing } },
      { nft: gold.nft, collection: MOCK_GIFT_COLLECTION, title: gold.name, number: 502, attrs: { ...gold.attrs }, contractType: null, ownListing: null },
    ];
  }

  async getOffchainGiftsByOwner() {
    return [];
  }

  async resolveDns(name) {
    return name === MOCK_WALLET_NAME ? MOCK_WALLET : null;
  }
}
