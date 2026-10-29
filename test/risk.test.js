import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk, riskLine, failingIds, warnsAllowed } from '../src/risk.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig({ env: {} });
const OFFICIAL = '0:' + 'a1'.repeat(32);
const FAKE = '0:' + 'c3'.repeat(32);
const check = (r, id) => r.checks.find((c) => c.id === id);

test('official_collection: ok, lookalike bad, unverifiable warn, allowlist, skipped for non-gifts', () => {
  const base = { isGift: true, collection: OFFICIAL, giftCollections: [OFFICIAL], allowlist: [] };
  assert.equal(check(assessRisk(base, cfg), 'official_collection').status, 'ok');
  const fake = assessRisk({ ...base, collection: FAKE }, cfg);
  assert.equal(check(fake, 'official_collection').status, 'bad');
  assert.match(check(fake, 'official_collection').text, /not in Getgems' official gift list/);
  assert.equal(fake.level, 'red');
  assert.equal(check(assessRisk({ ...base, giftCollections: null }, cfg), 'official_collection').status, 'warn');
  assert.equal(check(assessRisk({ ...base, collection: FAKE, allowlist: [FAKE] }, cfg), 'official_collection').status, 'ok');
  assert.equal(check(assessRisk({ ...base, isGift: false }, cfg), 'official_collection'), undefined);
});

test('sale_type: standard ok, telemint warn, offchain warn with OFFCHAIN_NOTE', () => {
  assert.equal(check(assessRisk({ contractType: 'sale-contract' }, cfg), 'sale_type').status, 'ok');
  assert.equal(check(assessRisk({ contractType: 'telemint' }, cfg), 'sale_type').status, 'warn');
  const off = check(assessRisk({ contractType: 'offchain' }, cfg), 'sale_type');
  assert.equal(off.status, 'warn');
  assert.equal(off.text, cfg.offchainNote);
});

test('fragment_ban and price_fresh are red flags', () => {
  const ban = assessRisk({ warning: { type: 'NftBanFromFragment', reason: 'test' } }, cfg);
  assert.equal(ban.level, 'red');
  assert.match(check(ban, 'fragment_ban').text, /banned from Fragment \(test\)/);
  assert.equal(check(assessRisk({ warning: null }, cfg), 'fragment_ban').status, 'ok');
  assert.equal(check(assessRisk({ priceFresh: { gone: true, priceUp: false } }, cfg), 'price_fresh').status, 'bad');
  assert.equal(check(assessRisk({ priceFresh: { gone: false, priceUp: true, newPriceTon: 6 } }, cfg), 'price_fresh').status, 'bad');
  assert.equal(check(assessRisk({ priceFresh: { gone: false, priceUp: false } }, cfg), 'price_fresh').text, 'Price unchanged since alert');
});

test('market_status: up ok, warn warn, down bad, fetch error warn', () => {
  assert.equal(check(assessRisk({ marketStatus: 'up' }, cfg), 'market_status').status, 'ok');
  assert.equal(check(assessRisk({ marketStatus: 'warn' }, cfg), 'market_status').status, 'warn');
  assert.equal(check(assessRisk({ marketStatus: 'down' }, cfg), 'market_status').status, 'bad');
  assert.equal(check(assessRisk({ marketStatus: 'error' }, cfg), 'market_status').status, 'warn');
});

test('seller_history: first-time seller warns; a missing Getgems key skips the check', () => {
  assert.equal(check(assessRisk({ sellerInfo: { tradingCount: 0 } }, cfg), 'seller_history').text, 'First-time seller on Getgems');
  assert.equal(check(assessRisk({ sellerInfo: { tradingCount: 7 } }, cfg), 'seller_history').text, 'Seller has 7 trades');
  assert.equal(check(assessRisk({ sellerInfo: null }, cfg), 'seller_history'), undefined);
  assert.equal(check(assessRisk({}, cfg), 'seller_history'), undefined);
});

test('too_good boundary at RISK_TOO_GOOD_PCT and data_confidence', () => {
  assert.equal(check(assessRisk({ priceTon: 3.1, fairTon: 10 }, cfg), 'too_good').status, 'warn');
  assert.match(check(assessRisk({ priceTon: 3.1, fairTon: 10 }, cfg), 'too_good').text, /Unusually cheap \(31% of fair value\)/);
  assert.equal(check(assessRisk({ priceTon: 3.5, fairTon: 10 }, cfg), 'too_good').status, 'ok'); // exactly 35%
  assert.equal(check(assessRisk({ priceTon: 3.49, fairTon: 10 }, cfg), 'too_good').status, 'warn');
  assert.equal(check(assessRisk({ confidence: 'C' }, cfg), 'data_confidence').status, 'warn');
  assert.equal(check(assessRisk({ confidence: 'A' }, cfg), 'data_confidence').status, 'ok');
});

test('overall level aggregation, card line and block-code helpers', () => {
  const green = assessRisk({ contractType: 'sale-contract', confidence: 'A', marketStatus: 'up' }, cfg);
  assert.equal(green.level, 'green');
  assert.equal(riskLine(green), '🟢 Safe checks passed');
  const yellow = assessRisk({ contractType: 'offchain', priceTon: 3, fairTon: 10 }, cfg);
  assert.equal(yellow.level, 'yellow');
  assert.equal(riskLine(yellow), '🟡 Off-chain gift · Unusually cheap');
  const red = assessRisk({ isGift: true, collection: FAKE, giftCollections: [OFFICIAL], contractType: 'offchain' }, cfg);
  assert.equal(riskLine(red), '🔴 Not an official gift collection · Off-chain gift');
  assert.deepEqual(failingIds(yellow, 'warn'), ['sale_type', 'too_good']);
  assert.equal(warnsAllowed(yellow, ['sale_type']), false);
  assert.equal(warnsAllowed(yellow, ['sale_type', 'too_good']), true);
});
