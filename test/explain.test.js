// Explained decisions: reason codes, event schema + rotation, digest, optional LLM path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REASONS, BLOCK_TO_REASON, reasonText, templateParams, explainMore, blockReason, confidenceLabel } from '../src/explain.js';
import { validateEvent, EventLog, readEvents } from '../src/events.js';
import { aggregateEvents, tuningHints, readPeerEvents, suiteSection, renderDigest } from '../src/digest.js';
import { formatAlert, MAX_MESSAGE } from '../src/format.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ggc-'));
const ev = (o = {}) => ({ v: 1, ts: new Date().toISOString(), bot: 'getgems-checker', kind: 'skip', mode: 'dry', id: `x${Math.random()}`, reasons: [{ code: 'LIMIT_HOURLY', sev: 'bad', p: {} }], ...o });

test('every reason code has an English template; every code used in src exists in the table', () => {
  for (const [code, r] of Object.entries(REASONS)) {
    assert.ok(r.en && r.en.length > 5, code);
    assert.ok(['good', 'warn', 'bad'].includes(r.sev), code);
    const p = Object.fromEntries(templateParams(code).map((k) => [k, 1]));
    assert.ok(!reasonText(code, p).includes('?'), code);
  }
  for (const target of Object.values(BLOCK_TO_REASON)) assert.ok(REASONS[target], target);
  const used = new Set();
  const src = new URL('../src/', import.meta.url);
  for (const f of fs.readdirSync(src).filter((x) => x.endsWith('.js'))) {
    const text = fs.readFileSync(new URL(f, src), 'utf8');
    for (const m of text.matchAll(/(?<![\w])code:\s*'([A-Z][A-Z_]+)'/g)) used.add(m[1]);
    for (const m of text.matchAll(/reasonText\('([A-Z][A-Z_]+)'/g)) used.add(m[1]);
    for (const m of text.matchAll(/#skip\(alert, [^,]+, '([A-Z][A-Z_]+)'/g)) used.add(m[1]);
  }
  assert.ok(used.size >= 10);
  for (const c of used) assert.ok(REASONS[c], `missing template for ${c}`);
  assert.equal(blockReason('risk_red:official_collection'), 'RISK_RED');
  assert.equal(confidenceLabel(12), 'high');
  assert.equal(confidenceLabel(5), 'med');
  assert.equal(confidenceLabel(2), 'low');
});

test('event validator rejects a missing v, bot or kind', () => {
  assert.equal(validateEvent(ev()).ok, true);
  for (const k of ['v', 'bot', 'kind']) {
    const e = ev();
    delete e[k];
    assert.equal(validateEvent(e).ok, false, k);
  }
  assert.equal(validateEvent(ev({ mode: 'paper' })).ok, false);
  assert.equal(validateEvent(ev({ reasons: [{ code: 'X' }] })).ok, false);
});

test('event log rotates to .1 at EVENTS_MAX_MB', () => {
  const dir = tmp();
  const file = path.join(dir, 'events.jsonl');
  const log = new EventLog({ file, maxMb: 0.001 }); // ~1 KB
  for (let i = 0; i < 20; i++) log.append(ev({ id: `e${i}` }));
  assert.ok(fs.existsSync(`${file}.1`));
  assert.ok(fs.statSync(file).size <= 1100);
  assert.ok(readEvents(file).events.length > 0);
  assert.throws(() => log.append({ v: 1 }), /invalid event/);
});

test('the rendered alert stays under 4096 characters and HTML-escapes the title', () => {
  const listing = { nft: '0:' + 'ab'.repeat(32), collection: '0:' + 'cd'.repeat(32), name: '<b>Evil</b> & "co"', attrs: { model: '<script>' }, priceTon: 5, priceNano: '5000000000', contractType: 'sale-contract' };
  const html = formatAlert({ listing, reasons: [{ kind: 'below_floor', code: 'BELOW_FLOOR', p: { pct: '20.0', floor: '6.00' }, text: 'x' }], floorRefTon: 6, belowFloorPct: 20, valuation: null, discountPct: null });
  assert.ok(html.length < MAX_MESSAGE);
  assert.match(html, /&lt;b&gt;Evil&lt;\/b&gt; &amp; "co"/);
  assert.ok(!html.includes('<script>'));
  assert.match(html, /<blockquote expandable>/);
  const long = formatAlert({ listing: { ...listing, name: 'x'.repeat(5000) }, reasons: [], floorRefTon: null, valuation: null });
  assert.ok(long.length <= MAX_MESSAGE);
});

test('LLM path makes no network call when ANTHROPIC_API_KEY is empty; key only in the header', async () => {
  const boom = async () => assert.fail('fetch must not be called');
  assert.equal(await explainMore(ev(), { apiKey: '', fetchImpl: boom }), null);
  let seen;
  const fake = async (url, init) => {
    seen = init;
    return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'It skipped because the hourly cap was reached.' }] }), { status: 200 });
  };
  const text = await explainMore(ev(), { apiKey: 'sk-secret', model: 'claude-sonnet-5-5', fetchImpl: fake });
  assert.match(text, /hourly cap/);
  assert.equal(seen.headers['x-api-key'], 'sk-secret');
  assert.ok(!seen.body.includes('sk-secret'));
  assert.equal(JSON.parse(seen.body).model, 'claude-sonnet-5-5');
});

test('digest aggregation matches a fixture events file; tuning hint from limit-skip marks', () => {
  const dir = tmp();
  const file = path.join(dir, 'events.jsonl');
  const lines = [
    ev({ kind: 'alert', reasons: [{ code: 'BELOW_FAIR', sev: 'good' }] }),
    ev({ kind: 'alert', reasons: [{ code: 'BELOW_FLOOR', sev: 'good' }] }),
    ev({ kind: 'buy', money: { ccy: 'TON', price: 4 }, reasons: [{ code: 'DRY_RUN', sev: 'good' }] }),
    ev(),
    ev(),
    ev({ reasons: [{ code: 'RISK_RED', sev: 'bad' }] }),
    ev({ reasons: [{ code: 'LOW_CONFIDENCE', sev: 'bad' }] }),
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n');
  const { events, bad } = readEvents(file);
  assert.equal(bad, 1);
  const agg = aggregateEvents(events);
  assert.deepEqual(agg.counts.alert, 2);
  assert.equal(agg.counts.buy, 1);
  assert.equal(agg.counts.skip, 4);
  assert.equal(agg.spend.dry, 4);
  assert.deepEqual(agg.topSkips, [{ code: 'LIMIT_HOURLY', n: 2 }, { code: 'LOW_CONFIDENCE', n: 1 }, { code: 'RISK_RED', n: 1 }]);
  const settings = { get: (p) => ({ max_price: 10, daily_budget: 50, max_buys_per_hour: 2 })[p] };
  const fill = (code, entry, mark) => ({ entryPrice: entry, entryCosts: 0.1, markPrice: mark, meta: { skipCode: code, allInTon: entry + 0.1 } });
  const hints = tuningHints([fill('max_price', 11, 14), fill('max_price', 11.5, 13), fill('max_price', 12, 9)], settings);
  assert.equal(hints[0].text, '3 deals were skipped by MAX_PRICE_TON=10, and 2 of them would be +net today (+4.3 TON).');
  assert.equal(hints[0].suggest, 12);
  const text = renderDigest({ agg, mode: 'practice', spentTon: 4, budgetTon: 50, hints });
  assert.match(text, /Top reasons not bought: hourly buy cap reached 2/);
  assert.match(text, /\[Raise to 12\]/);
});

test('peer event files that are missing or malformed are skipped without a crash', () => {
  const dir = tmp();
  const good = path.join(dir, 'good.jsonl');
  const bad = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(good, JSON.stringify(ev({ bot: 'mrkt-autobuy', kind: 'buy', money: { ccy: 'TON', price: 3, usd: 3.75 } })) + '\n');
  fs.writeFileSync(bad, '{"hello":1}\n');
  const r = readPeerEvents([good, bad, path.join(dir, 'missing.jsonl')]);
  assert.equal(r.events.length, 1);
  assert.equal(r.warnings.length, 2);
  assert.equal(suiteSection(r.events).totalUsd, 3.75);
});

test('digest: shadow fills are not counted as buys; a raise never goes past the .env ceiling', () => {
  const agg = aggregateEvents([
    ev({ kind: 'buy', mode: 'dry', reasons: [{ code: 'DRY_RUN', sev: 'good' }] }),
    ev({ kind: 'buy', mode: 'shadow', reasons: [{ code: 'SHADOW_RULE', sev: 'good' }] }),
    ev({ kind: 'buy', mode: 'shadow', reasons: [{ code: 'SHADOW_RULE', sev: 'good' }] }),
  ]);
  assert.equal(agg.counts.buy, 1);
  assert.equal(agg.counts.shadow, 2);
  assert.match(renderDigest({ agg, mode: 'practice', spentTon: 0, budgetTon: 50 }), /paper buys 1 · shadow fills 2 ·/);
  const fill = (code, entry, mark) => ({ entryPrice: entry, entryCosts: 0.1, markPrice: mark, meta: { skipCode: code, allInTon: entry + 0.1 } });
  const at = { get: (p) => ({ max_price: 10, daily_budget: 50, max_buys_per_hour: 2 })[p], cfg: { maxPriceTon: 11, dailyBudgetTon: 50, maxBuysPerHour: 2 } };
  const hints = tuningHints([fill('max_price', 11.5, 14), fill('rate', 3, 5)], at);
  const price = hints.find((h) => h.code === 'max_price');
  assert.equal(price.suggest, 11); // the deal needed 12, .env allows 11
  assert.equal(price.canRaise, true);
  const rate = hints.find((h) => h.code === 'rate');
  assert.equal(rate.canRaise, false); // MAX_BUYS_PER_HOUR already at .env
  assert.match(rate.text, /already at its \.env limit/);
});

test('market-supplied names are HTML-escaped in the scoreboard, portfolio card and seller guard', async () => {
  const { formatScoreboard } = await import('../src/paper.js');
  const { formatPortfolio, sellerGuard, offerAlerts } = await import('../src/portfolio.js');
  const side = { n: 1, allIn: 5, mark: 3.9, markCons: 3.9, pnl: -1.1, pnlPct: -22, winners: 0, losers: 1, flat: 0, lostRaces: 1, lost: [{ name: 'Frog <b>', soldAfterSec: 3 }] };
  const sb = formatScoreboard({ days: 1, paper: side, live: null, skipped: {}, worst: { pnl: -1.1, name: 'Pepe <3 & Co' } });
  assert.match(sb, /-1\.1 Pepe &lt;3 &amp; Co/);
  assert.match(sb, /Frog &lt;b&gt;/);
  const item = { title: 'Gift <x> & y', fairTon: 5, confidence: 'A', lowTon: 5, highTon: 5, liquidity: { badge: 'fast' } };
  const card = formatPortfolio({ count: 1, totalTon: 5, totalLowTon: 5, totalHighTon: 5, items: [item, { title: '<i>none', fairTon: null, confidence: 'C' }], unmatched: ['Box <1>'], skipped: {} });
  assert.match(card, /1\. Gift &lt;x&gt; &amp; y — 5\.00 TON/);
  assert.match(card, /No recent sales to value: &lt;i&gt;none/);
  assert.match(card, /Not on Getgems: Box &lt;1&gt;/);
  const guard = sellerGuard([{ title: 'A<b>', priceTon: 1 }], { 'A<b>': { fairTon: 10, confidence: 'A' } }, { underpricePct: 15, liqIlliquidDays: 30 });
  assert.match(guard[0].text, /Your listing A&lt;b&gt; is 90% under/);
  const offer = offerAlerts([{ title: 'B&c', bestBidNetTon: 20, exitNetTon: 10 }], { offerAbovePct: 5 });
  assert.match(offer[0].text, /your B&amp;c\./);
});
