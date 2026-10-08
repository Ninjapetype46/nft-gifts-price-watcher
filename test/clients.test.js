import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseGetgemsNft, parseGetgemsHistory, parseBuyTransaction, GetgemsClient } from '../src/clients/getgems.js';
import { parseTonapiNft, TonapiClient } from '../src/clients/tonapi.js';
import { JsonHttp } from '../src/clients/http.js';

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const CAKES = '0:9e7eb8e1083dbfec7448af6966c2df596aa786fed76c781bc00c2ebaf37de405';

test('parseGetgemsNft: fixed-price TON sale -> Listing; auctions skipped', () => {
  const items = fixture('getgems_on_sale.json').response.items;
  const l = parseGetgemsNft(items[0]);
  assert.equal(l.nft, '0:010f80b8a5f8c9923efdb1f500053ec91cf4757bcd081393833d74ab09f438ca');
  assert.equal(l.collection, CAKES);
  assert.equal(l.priceNano, '50000000000');
  assert.equal(l.priceTon, 50);
  assert.deepEqual(l.attrs, { model: 'Mistletoe', backdrop: 'French Blue', symbol: 'Celtic Cross' });
  assert.equal(l.saleContract, '0:5786c881c578e77e7b8e53ccedad0cf0d9197bf6c40030f2b7d00622f0d099d5');
  assert.equal(l.saleVersion, '1b5269ee9f53f000,s:1tla7aeps:TON,m:4ac71e2028745291');
  assert.equal(l.seller, '0:d73f499ef4af29cfd74d9aa9a7995114f0c417e90cc2d74accf361c5d575f865');
  assert.equal(parseGetgemsNft(items[1]), null);
  assert.equal(parseGetgemsNft({ ...items[0], sale: { ...items[0].sale, currency: 'USDT' } }), null);
  assert.equal(parseGetgemsNft({ ...items[0], sale: undefined }), null);
});

test('parseGetgemsHistory: sold events only', () => {
  const base = {
    address: 'EQABD4C4pfjJkj79sfUABT7JHPR1e80IE5ODPXSrCfQ4yiOe',
    name: 'Homemade Cake #20549',
    time: '2025-09-15T00:38:03.000Z',
    collectionAddress: 'EQCefrjhCD2_7HRIr2lmwt9ZaqeG_tdseBvADC66833kBS3y',
    lt: '1',
    hash: 'abc',
    isOffchain: false,
  };
  const s = parseGetgemsHistory({ ...base, typeData: { type: 'sold', oldOwner: null, newOwner: null, price: '12.5', priceNano: '12500000000', currency: 'TON', rejectFromGlobalTop: false } });
  assert.equal(s.priceTon, 12.5);
  assert.equal(s.collection, CAKES);
  assert.equal(s.timeMs, Date.parse('2025-09-15T00:38:03.000Z'));
  assert.equal(parseGetgemsHistory({ ...base, typeData: { type: 'putUpForSale', price: '1', priceNano: '1000000000' } }), null);
  assert.equal(parseGetgemsHistory({ ...base, typeData: { type: 'sold', price: '1', priceNano: '1000000000', currency: 'NOT' } }), null);
});

test('parseBuyTransaction maps TonConnect-like list', () => {
  const tx = parseBuyTransaction({ success: true, response: { uuid: 'u1', from: null, timeout: '123', list: [{ to: 'EQx', amount: '6600000000', payload: 'te6c', stateInit: null }] } });
  assert.equal(tx.uuid, 'u1');
  assert.deepEqual(tx.messages, [{ to: 'EQx', amountNano: '6600000000', payloadB64: 'te6c', stateInitB64: null }]);
});

test('parseTonapiNft on a live-captured TonAPI item', () => {
  const l = parseTonapiNft(fixture('tonapi_item_on_sale.json'));
  assert.equal(l.collection, CAKES);
  assert.equal(l.priceTon, 50);
  assert.equal(l.market, 'Getgems Sales');
  assert.equal(l.saleContract, '0:5786c881c578e77e7b8e53ccedad0cf0d9197bf6c40030f2b7d00622f0d099d5');
  assert.equal(l.attrs.model, 'Mistletoe');
  const other = fixture('tonapi_item_on_sale.json');
  other.sale.market.name = 'Some Other Market';
  assert.equal(parseTonapiNft(other), null);
  assert.equal(parseTonapiNft(other, { onlyGetgems: false }).market, 'Some Other Market');
});

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const { status = 200, body, headers = {} } = handler(new URL(url), init, calls.length);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  };
  f.calls = calls;
  return f;
}

test('GetgemsClient sends the raw key in Authorization and paginates on-sale', async () => {
  const page = fixture('getgems_on_sale.json');
  const fetchImpl = fakeFetch((url, _init, n) => ({ body: n === 1 ? page : { success: true, response: { cursor: null, items: [] } } }));
  const c = new GetgemsClient({ apiKey: 'KEY123', baseUrl: 'https://api.getgems.io/public-api', minIntervalMs: 0, fetchImpl });
  const listings = await c.getListings(CAKES, { pages: 2 });
  assert.equal(listings.length, 1);
  const [first, second] = fetchImpl.calls;
  assert.equal(first.init.headers.Authorization, 'KEY123');
  assert.equal(first.url.pathname, '/public-api/v1/nfts/on-sale/EQCefrjhCD2_7HRIr2lmwt9ZaqeG_tdseBvADC66833kBS3y');
  assert.equal(first.url.searchParams.get('limit'), '100');
  assert.equal(second.url.searchParams.get('after'), '6.9%2C6813a6976428bb255010d739');
});

test('GetgemsClient getSales requests sold history since minTime', async () => {
  const fetchImpl = fakeFetch(() => ({ body: { success: true, response: { cursor: null, items: [] } } }));
  const c = new GetgemsClient({ apiKey: 'k', baseUrl: 'https://x/public-api', minIntervalMs: 0, fetchImpl });
  await c.getSales(CAKES, { sinceMs: 1700000000000, maxPages: 3 });
  const u = fetchImpl.calls[0].url;
  assert.equal(u.pathname, '/public-api/v1/collection/history/EQCefrjhCD2_7HRIr2lmwt9ZaqeG_tdseBvADC66833kBS3y');
  assert.deepEqual(u.searchParams.getAll('types[]'), ['sold']);
  assert.equal(u.searchParams.get('minTime'), '1700000000000');
});

test('GetgemsClient buy-fix-price posts the sale version', async () => {
  const fetchImpl = fakeFetch(() => ({ body: { success: true, response: { uuid: 'u', list: [{ to: 'EQx', amount: '1' }] } } }));
  const c = new GetgemsClient({ apiKey: 'k', baseUrl: 'https://x/public-api', minIntervalMs: 0, fetchImpl });
  const l = parseGetgemsNft(fixture('getgems_on_sale.json').response.items[0]);
  const tx = await c.getBuyTransaction(l);
  assert.equal(tx.messages.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.init.method, 'POST');
  assert.equal(call.url.pathname, '/public-api/v1/nfts/buy-fix-price/EQABD4C4pfjJkj79sfUABT7JHPR1e80IE5ODPXSrCfQ4yiOe');
  assert.deepEqual(JSON.parse(call.init.body), { version: l.saleVersion });
});

test('JsonHttp retries 429 with Retry-After and surfaces API errors', async () => {
  const fetchImpl = fakeFetch((_u, _i, n) => (n === 1 ? { status: 429, body: { name: 'Logic Error', status: 429, errors: [] }, headers: { 'retry-after': '0' } } : { body: { ok: 1 } }));
  const http = new JsonHttp({ baseUrl: 'https://x', minIntervalMs: 0, fetchImpl });
  assert.deepEqual(await http.get('/a'), { ok: 1 });
  assert.equal(fetchImpl.calls.length, 2);

  const bad = new JsonHttp({
    baseUrl: 'https://x',
    fetchImpl: fakeFetch(() => ({ status: 400, body: { name: 'Logic Error', status: 400, errors: [{ message: 'Invalid authorization. You are using the wrong token' }] } })),
  });
  await assert.rejects(bad.get('/b'), /400: Invalid authorization/);
});

test('TonapiClient uses page size 100 without a key (anonymous tier limit)', async () => {
  const fetchImpl = fakeFetch(() => ({ body: { nft_items: [fixture('tonapi_item_on_sale.json')] } }));
  const c = new TonapiClient({ baseUrl: 'https://tonapi.io/v2', scanItems: 1000, minIntervalMs: 0, fetchImpl });
  c.http.minIntervalMs = 0;
  const ls = await c.getListings(CAKES);
  assert.equal(ls.length, 1);
  assert.equal(fetchImpl.calls[0].url.searchParams.get('limit'), '100');
  assert.equal(fetchImpl.calls.length, 1); // fewer items than a page -> stop
});

test('TonapiClient picks the v4 get-method for v4 sale contracts', async () => {
  const fetchImpl = fakeFetch((u) =>
    u.pathname.includes('/methods/')
      ? { body: { decoded: { is_complete: false, full_price: '6500000000', nft_address: CAKES } } }
      : { body: { interfaces: ['nft_sale_getgems_v4'], get_methods: ['get_fix_price_data_v4'] } },
  );
  const c = new TonapiClient({ baseUrl: 'https://tonapi.io/v2', fetchImpl });
  c.http.minIntervalMs = 0;
  const sc = await c.inspectSaleContract(CAKES);
  assert.ok(fetchImpl.calls[1].url.pathname.endsWith('/methods/get_fix_price_data_v4'));
  assert.deepEqual(sc, { interfaces: ['nft_sale_getgems_v4'], isComplete: false, fullPriceNano: '6500000000', nft: CAKES });
});

// ---- Owners, fees, warning, offers, server status --------------------------------------------
import { parseGetgemsOffer, parseServerStatus } from '../src/clients/getgems.js';

test('parseGetgemsHistory maps owners and rejectFromGlobalTop', () => {
  const s = parseGetgemsHistory({
    address: 'EQABD4C4pfjJkj79sfUABT7JHPR1e80IE5ODPXSrCfQ4yiOe',
    collectionAddress: 'EQCefrjhCD2_7HRIr2lmwt9ZaqeG_tdseBvADC66833kBS3y',
    time: '2025-09-15T00:38:03.000Z',
    hash: 'h',
    typeData: { type: 'sold', oldOwner: 'EQCefrjhCD2_7HRIr2lmwt9ZaqeG_tdseBvADC66833kBS3y', newOwner: null, price: '1', priceNano: '1000000000', currency: 'TON', rejectFromGlobalTop: true },
  });
  assert.equal(s.oldOwner, CAKES);
  assert.equal(s.newOwner, null);
  assert.equal(s.rejectTop, true);
});

test('parseGetgemsNft keeps fees and the Getgems warning', () => {
  const it = fixture('getgems_on_sale.json').response.items[0];
  const l = parseGetgemsNft({ ...it, warning: { type: 'NftBanFromFragment', reason: 'spam' }, sale: { ...it.sale, marketplaceFee: '2500000000', royaltyAmount: '2500000000' } });
  assert.deepEqual(l.warning, { type: 'NftBanFromFragment', reason: 'spam' });
  assert.equal(l.marketplaceFeeNano, '2500000000');
  assert.equal(l.royaltyNano, '2500000000');
  assert.equal(parseGetgemsNft(it).warning, null);
});

test('getServerStatus parses the verified live shape {ok,time,status,services}, no key needed for TonAPI source', async () => {
  // The body's `time` is CDN-cached, so it is never used as the server time (no headers: null).
  assert.deepEqual(parseServerStatus({ ok: true, time: '2026-10-28T20:01:00.496Z', status: 'up', services: [] }), { status: 'up', time: null, services: [] });
  assert.equal(parseServerStatus({ ok: true, status: 'weird' }).status, 'warn');
  const fetchImpl = fakeFetch(() => ({ body: { ok: true, time: '2026-10-28T20:01:00.496Z', status: 'warn', services: [] } }));
  const c = new TonapiClient({ baseUrl: 'https://tonapi.io/v2', fetchImpl, getgemsBase: 'https://api.getgems.io/public-api' });
  assert.equal((await c.getServerStatus()).status, 'warn');
  assert.equal(fetchImpl.calls[0].url.pathname, '/public-api/v1/server-status');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, undefined);
  assert.equal(await c.getUserTradingInfo('x'), null); // needs a Getgems key: skipped
  assert.deepEqual(await c.getCollectionOffers(), []);
});

test('server time for the clock check is the HTTP Date header plus Age, not the cached body time', async () => {
  // Live 2026-10-28: a CDN hit served `time` 23:18:00 with Date 23:18:45 and age 3 (real time 23:18:48).
  const headers = new Headers({ date: 'Wed, 28 Oct 2026 23:18:45 GMT', age: '3' });
  const st = parseServerStatus({ ok: true, time: '2026-10-28T23:18:00.458Z', status: 'up', services: [] }, headers);
  assert.equal(st.time, '2026-10-28T23:18:48.000Z');
  assert.equal(parseServerStatus({ status: 'up' }, new Headers({ date: 'Wed, 28 Oct 2026 23:18:45 GMT' })).time, '2026-10-28T23:18:45.000Z');
  const fetchImpl = fakeFetch(() => ({ body: { ok: true, time: '2026-10-28T23:18:00.458Z', status: 'up', services: [] }, headers: { date: 'Wed, 28 Oct 2026 23:18:45 GMT', age: '3' } }));
  const g = new GetgemsClient({ apiKey: 'K', baseUrl: 'https://api.getgems.io/public-api', minIntervalMs: 0, fetchImpl });
  assert.equal((await g.getServerStatus()).time, '2026-10-28T23:18:48.000Z');
  const t = new TonapiClient({ baseUrl: 'https://tonapi.io/v2', fetchImpl, getgemsBase: 'https://api.getgems.io/public-api' });
  assert.equal((await t.getServerStatus()).time, '2026-10-28T23:18:48.000Z');
});

test('Getgems offers: parse and page /v1/offers/collection/{address}', async () => {
  const o = parseGetgemsOffer({ fullPrice: '7300000000', profitPrice: '6500000000', currency: 'TON', offerAddress: null, finishAt: 1793300000, isCollectionOffer: true, isOffchain: false, maxQuantity: 3, purchasedQuantity: 1, attributes: [{ trait: 'Model', values: ['Bronze'] }] });
  assert.equal(o.netTon, 6.5);
  assert.equal(o.fullTon, 7.3);
  assert.deepEqual(o.attributes, [{ trait: 'Model', values: ['Bronze'] }]);
  assert.equal(parseGetgemsOffer({ profitPrice: '0' }), null);
  const fetchImpl = fakeFetch(() => ({ body: { success: true, response: { cursor: null, items: [{ profitPrice: '1000000000', isCollectionOffer: true }] } } }));
  const c = new GetgemsClient({ apiKey: 'k', baseUrl: 'https://x/public-api', minIntervalMs: 0, fetchImpl });
  const offers = await c.getCollectionOffers(CAKES);
  assert.equal(offers.length, 1);
  assert.equal(fetchImpl.calls[0].url.pathname, '/public-api/v1/offers/collection/EQCefrjhCD2_7HRIr2lmwt9ZaqeG_tdseBvADC66833kBS3y');
});

// ---- Free sales history from TonAPI (feature 6) ---------------------------------------------
import { parseTonapiPurchases, pickHistorySample } from '../src/clients/tonapi.js';
import { RateLimiter, sharedLimiter } from '../src/clients/http.js';

const PEPES = '0:46fa0e9a864014196a5e7d66f1f83ffdb10f2859bbf2ea9baeabbf14d9ce0d50';
const PEPE_1330 = '0:1ca16fc1d2fc5b88bc5d646a33e74d01a05aa398d8b98c0eb0da7c70baa0fca8';

test('parseTonapiPurchases maps a live NftPurchase to the Sale shape (seller -> oldOwner, buyer -> newOwner)', () => {
  const live = fixture('tonapi/account-events-plush-pepe-1330.json');
  const { sales, skipped } = parseTonapiPurchases(live, { collection: PEPES });
  assert.equal(skipped, 0);
  assert.equal(sales.length, 1); // 20 events, one of them the Getgems purchase
  assert.deepEqual(sales[0], {
    nft: PEPE_1330,
    collection: PEPES,
    name: 'Plush Pepe #1330',
    priceTon: 6200,
    timeMs: 1792048873000,
    txHash: `64d02c2eb02de95630b35a1f58127b6fdb897515c8e10129b5e784ca76202ea1:${PEPE_1330}`,
    attrs: { model: 'Barcelona', backdrop: 'Lemongrass', symbol: 'Cap' },
    oldOwner: '0:3ea580164054579b6021f6aa861aa753acdd045fd46b50bf14fde09f01eb5caf',
    newOwner: '0:6199ea9441e051fdfb001d66cf9a558c9bb6c655631c1b45a78aa232c558b169',
    rejectTop: false,
    market: 'getgems',
  });
  // Another collection, a jetton-priced purchase, an unfinished trace and a failed action are skipped.
  assert.equal(parseTonapiPurchases(live, { collection: CAKES }).sales.length, 0);
  const ev = live.events.find((e) => e.actions.some((a) => a.type === 'NftPurchase'));
  const variant = (patch) => ({ events: [patch(structuredClone(ev))] });
  const jetton = parseTonapiPurchases(variant((e) => ((e.actions[0].NftPurchase.amount.currency_type = 'jetton'), e)));
  assert.deepEqual([jetton.sales.length, jetton.skipped], [0, 1]);
  assert.equal(parseTonapiPurchases(variant((e) => ((e.in_progress = true), e))).sales.length, 0);
  assert.equal(parseTonapiPurchases(variant((e) => ((e.actions[0].status = 'failed'), e))).sales.length, 0);
  // The same purchase in /v2/nfts/{nft}/history is only an NftItemTransfer without a price.
  assert.equal(parseTonapiPurchases(fixture('tonapi/nft-history-plush-pepe-1330.json')).sales.length, 0);
});

test('pickHistorySample: listed items first, then a rotating slice; fresh items skipped', () => {
  const others = ['o1', 'o2', 'o3', 'o4', 'o5'];
  const none = () => false;
  const a = pickHistorySample({ listed: ['l1', 'l2'], others, cursor: 0, max: 4, fresh: none });
  assert.deepEqual(a, { pick: ['l1', 'l2', 'o1', 'o2'], cursor: 2 });
  const b = pickHistorySample({ listed: ['l1', 'l2'], others, cursor: a.cursor, max: 4, fresh: (n) => n.startsWith('l') });
  assert.deepEqual(b, { pick: ['o3', 'o4', 'o5', 'o1'], cursor: 1 });
  assert.deepEqual(pickHistorySample({ listed: [], others: [], cursor: 3, max: 4, fresh: none }), { pick: [], cursor: 0 });
  // An item that just left the listings is read first, even within the TTL.
  assert.deepEqual(pickHistorySample({ urgent: ['o2'], listed: ['l1'], others, cursor: 0, max: 3, fresh: () => true }).pick, ['o2']);
});

test('TonapiClient.getSales reads a sample of item histories, caches them for the TTL and labels the source', async () => {
  const items = [
    { ...fixture('tonapi_item_on_sale.json'), address: PEPE_1330, collection: { address: PEPES } },
    ...['a', 'b', 'c'].map((x) => ({ address: `0:${x.repeat(64)}`, collection: { address: PEPES }, metadata: { name: x } })),
  ];
  const live = fixture('tonapi/account-events-plush-pepe-1330.json');
  const fetchImpl = fakeFetch((u) => {
    if (u.pathname.endsWith('/items')) return { body: { nft_items: items } };
    if (u.pathname === `/v2/accounts/${PEPE_1330}/events`) return { body: live };
    if (u.pathname.startsWith('/v2/accounts/')) return { body: { events: [], next_from: 0 } };
    return { status: 404, body: { error: 'unexpected' } };
  });
  let now = 1793000000000;
  const c = new TonapiClient({ baseUrl: 'https://tonapi.io/v2', fetchImpl, historyItems: 2, historyTtlMin: 60, limiter: new RateLimiter(0), now: () => now });
  const listings = await c.getListings(PEPES);
  assert.deepEqual(listings.map((l) => l.nft), [PEPE_1330]);
  const since = 1791000000000;
  const first = await c.getSales(PEPES, { sinceMs: since + 5e8, windowSinceMs: since });
  const hist = fetchImpl.calls.filter((x) => x.url.pathname.endsWith('/events'));
  assert.deepEqual(hist.map((x) => x.url.pathname.split('/')[3]), [PEPE_1330, `0:${'a'.repeat(64)}`]); // listed item first
  assert.equal(hist[0].url.searchParams.get('start_date'), String(since / 1000)); // whole window on the first read
  assert.equal(hist[0].url.searchParams.get('limit'), '100');
  assert.deepEqual(first.map((s) => s.priceTon), [6200]);
  assert.equal(c.salesSource(PEPES).label, 'sales: TonAPI sample of 2 items');
  assert.equal(c.salesSource(PEPES).sampled, true);
  // Next refresh: the two read items are cached, the rotation moves on.
  await c.getSales(PEPES, { sinceMs: since, windowSinceMs: since });
  const hist2 = fetchImpl.calls.filter((x) => x.url.pathname.endsWith('/events')).slice(2);
  assert.deepEqual(hist2.map((x) => x.url.pathname.split('/')[3]), [`0:${'b'.repeat(64)}`, `0:${'c'.repeat(64)}`]);
  assert.equal(c.salesSource(PEPES).items, 4);
  // After the TTL an item is read again, only from shortly before its last read.
  now += 61 * 60_000;
  await c.getSales(PEPES, { sinceMs: since, windowSinceMs: since });
  const again = fetchImpl.calls.filter((x) => x.url.pathname === `/v2/accounts/${PEPE_1330}/events`);
  assert.equal(again.length, 2);
  assert.equal(again[1].url.searchParams.get('start_date'), String(Math.floor((now - 61 * 60_000 - 3_600_000) / 1000)));
  // The listing disappears (probably sold): its history is read at the next refresh despite the TTL.
  items[0] = { ...items[0], sale: undefined };
  await c.getListings(PEPES);
  now += 60_000;
  await c.getSales(PEPES, { sinceMs: since, windowSinceMs: since });
  assert.equal(fetchImpl.calls.filter((x) => x.url.pathname === `/v2/accounts/${PEPE_1330}/events`).length, 3);
  assert.deepEqual(c.items.get(PEPES).gone, []);
});

test('TonapiClient.getSales stops the sample at the first error and keeps what it read', async () => {
  const items = ['a', 'b', 'c'].map((x) => ({ address: `0:${x.repeat(64)}`, collection: { address: PEPES } }));
  const fetchImpl = fakeFetch((u) => {
    if (u.pathname.endsWith('/items')) return { body: { nft_items: items } };
    if (u.pathname.includes('b'.repeat(64))) return { status: 400, body: { error: 'bad request' } };
    return { body: { events: [] } };
  });
  const c = new TonapiClient({ baseUrl: 'https://tonapi.io/v2', fetchImpl, historyItems: 10, limiter: new RateLimiter(0) });
  await c.getListings(PEPES);
  assert.deepEqual(await c.getSales(PEPES, { sinceMs: 0 }), []);
  assert.equal(fetchImpl.calls.filter((x) => x.url.pathname.endsWith('/events')).length, 2);
  assert.equal(c.salesSource(PEPES).items, 1);
});

test('RateLimiter spaces requests; TonAPI clients share one limiter per base URL and key', async () => {
  let t = 10_000;
  const waits = [];
  const lim = new RateLimiter(1100, { now: () => t, sleep: async (ms) => (waits.push(ms), (t += ms)) });
  await Promise.all([lim.slot(), lim.slot(), lim.slot()]);
  assert.equal(lim.granted, 3);
  assert.deepEqual(waits, [1100, 1100]); // first at once, then one interval apart
  assert.equal(lim.lastAt, 12_200);
  t += 5000;
  await lim.slot();
  assert.equal(waits.length, 2); // idle long enough: no wait
  const a = new TonapiClient({ baseUrl: 'https://example.test/v2' });
  const b = new TonapiClient({ baseUrl: 'https://example.test/v2' });
  assert.equal(a.http.limiter, b.http.limiter);
  assert.equal(a.http.limiter, sharedLimiter('tonapi:https://example.test/v2:anon', 0));
  assert.ok(a.http.limiter.minIntervalMs >= 1100);
  assert.notEqual(new TonapiClient({ baseUrl: 'https://example.test/v2', apiKey: 'k' }).http.limiter, a.http.limiter);
});

test('Getgems collection offers keep only collection-wide offers; NFT offers carry their NFT', async () => {
  const fetchImpl = fakeFetch((u) => ({
    body: { success: true, response: { cursor: null, items: [{ profitPrice: '1000000000', isCollectionOffer: true }, { profitPrice: '50000000000', isCollectionOffer: false }, { profitPrice: '2000000000' }] } },
  }));
  const c = new GetgemsClient({ apiKey: 'k', baseUrl: 'https://api.getgems.io/public-api', minIntervalMs: 0, fetchImpl });
  const coll = await c.getCollectionOffers(CAKES);
  assert.deepEqual(coll.map((o) => [o.netTon, o.isCollectionOffer]), [[1, true], [2, true]]);
  const nftOffers = await c.getNftOffers(PEPE_1330);
  assert.ok(nftOffers.filter((o) => !o.isCollectionOffer).every((o) => o.nft === PEPE_1330));
});
