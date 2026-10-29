// Shared data shapes (JSDoc) and unit helpers. Prices: nano as decimal strings / bigint,
// TON as Number for comparisons and display only.

import { toFriendly } from './address.js';

/**
 * A fixed-price TON listing, normalized across data sources.
 * @typedef {Object} Listing
 * @property {string} nft              raw address "0:<hex>"
 * @property {string} collection       raw address
 * @property {string} name
 * @property {Record<string,string>} attrs  lower-cased trait type -> value (e.g. {model, backdrop, symbol})
 * @property {string} priceNano        decimal string
 * @property {number} priceTon
 * @property {string|null} saleContract raw address of the sale contract (if on-chain)
 * @property {string|null} saleVersion  Getgems `sale.version` (needed by buy-fix-price)
 * @property {string|null} contractType Getgems contractType: sale-contract | telemint | offchain
 * @property {string|null} seller
 * @property {string} market            e.g. "getgems"
 * @property {string} source            getgems | tonapi | mock
 * @property {string|null} [marketplaceFeeNano]  Getgems sale.marketplaceFee (nano, TODO(verify) unit)
 * @property {string|null} [royaltyNano]         Getgems sale.royaltyAmount (nano, TODO(verify) unit)
 * @property {{type:string, reason?:string}|null} [warning]  Getgems NftItemFull.warning (e.g. NftBanFromFragment)
 */

/**
 * A completed sale used as a comparable.
 * @typedef {Object} Sale
 * @property {string} nft
 * @property {string} collection
 * @property {string} [name]
 * @property {number} priceTon
 * @property {number} timeMs
 * @property {string} txHash           unique id of the event
 * @property {Record<string,string>} [attrs]
 * @property {string|null} [oldOwner]   raw address of the seller, null when unknown
 * @property {string|null} [newOwner]   raw address of the buyer, null when unknown
 * @property {boolean} [rejectTop]      Getgems rejectFromGlobalTop (Getgems itself distrusts this sale)
 */

/**
 * One outgoing wallet message (TonConnect-like).
 * @typedef {Object} OutMessage
 * @property {string} to               address (raw or friendly)
 * @property {string} amountNano       decimal string
 * @property {string|null} [payloadB64] base64 BOC body
 * @property {string|null} [stateInitB64]
 * @property {boolean} [bounce]
 */

export const NANO = 1_000_000_000n;

/** @param {string|number|bigint} nano */
export function nanoToTon(nano) {
  const v = BigInt(nano);
  return Number(v / NANO) + Number(v % NANO) / 1e9;
}

/** Exact TON -> nano conversion from a decimal string/number. */
export function tonToNano(ton) {
  const s = typeof ton === 'number' ? ton.toFixed(9) : String(ton).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Bad TON amount: ${ton}`);
  const [int, frac = ''] = s.split('.');
  return BigInt(int) * NANO + BigInt((frac + '000000000').slice(0, 9));
}

export function fmtTon(ton, digits = 2) {
  if (ton === null || ton === undefined || Number.isNaN(ton)) return '-';
  const n = Number(ton);
  return n >= 100 ? n.toFixed(0) : n.toFixed(digits);
}

/**
 * Normalize attribute arrays from Getgems ({traitType,value}) or TonAPI/metadata ({trait_type,value}).
 * @returns {Record<string,string>}
 */
export function normalizeAttrs(list) {
  /** @type {Record<string,string>} */
  const out = {};
  if (!Array.isArray(list)) return out;
  for (const a of list) {
    const k = a?.traitType ?? a?.trait_type ?? a?.type;
    if (!k || a.value === undefined || a.value === null) continue;
    out[String(k).trim().toLowerCase()] = String(a.value).trim();
  }
  return out;
}

/**
 * Trait value without a rarity suffix: "Gold (1.2%)" -> "gold", "Onyx Black 15‰" -> "onyx black".
 * Used to compare Telegram Bot API gift traits, Getgems attributes and offer filters.
 */
export function normalizeTrait(v) {
  return String(v ?? '')
    .replace(/\s*\(\s*[\d.,]+\s*[%‰]\s*\)\s*$/u, '')
    .replace(/\s*[\d.,]+\s*‰\s*$/u, '')
    .trim()
    .toLowerCase();
}

/** "1 sale" / "3 sales" / "2 addresses": a count with the right word form. */
export function plural(n, one, many = `${one}s`) {
  return `${n} ${Number(n) === 1 ? one : many}`;
}

/** Signed number for money lines: +3.00 / -0.40 */
export function fmtSigned(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  const v = Number(n);
  return `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(digits)}`;
}

const GIFT_TRAITS = ['model', 'backdrop', 'symbol'];
export function looksLikeGift(attrs) {
  return GIFT_TRAITS.every((t) => attrs && t in attrs);
}

// TODO(verify): URL shape. getgems.io returns 403 to curl, so this was not checked live.
export function getgemsUrl(listing) {
  try {
    return `https://getgems.io/collection/${toFriendly(listing.collection)}/${toFriendly(listing.nft)}`;
  } catch {
    return 'https://getgems.io/';
  }
}

export function getgemsCollectionUrl(collection) {
  try {
    return `https://getgems.io/collection/${toFriendly(collection)}`;
  } catch {
    return 'https://getgems.io/';
  }
}

/** Mask a secret for logs: keep the first 4 chars only. */
export function mask(secret) {
  if (!secret) return '(empty)';
  const s = String(secret);
  return s.length <= 6 ? '***' : `${s.slice(0, 4)}…(${s.length})`;
}
