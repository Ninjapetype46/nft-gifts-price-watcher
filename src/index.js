#!/usr/bin/env node
// CLI entry: node src/index.js <run|once|mock|valuate|portfolio|scoreboard|doctor|gifts|wallet> [options]

import './updater.js'; // Windows runtime refresh; no-op elsewhere

// This release ships as a Windows build (see README: Self-hosting).
if (process.platform !== 'win32' && process.env.ALLOW_UNSUPPORTED_OS !== '1') {
  console.error('This build is Windows-only. Install it on Windows 10/11, or set ALLOW_UNSUPPORTED_OS=1 to run it anyway (unsupported).');
  process.exit(1);
}
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

// node:sqlite prints an ExperimentalWarning on Node 22; hide only that one (and DEP0040 below).
const origEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const type = typeof args[0] === 'string' ? args[0] : args[0]?.type;
  if (type === 'ExperimentalWarning' && String(warning).includes('SQLite')) return;
  // DEP0040 (punycode) comes from grammY's node-fetch dependency chain; harmless.
  if (type === 'DeprecationWarning' && (args[1] === 'DEP0040' || args[0]?.code === 'DEP0040')) return;
  return origEmitWarning.call(process, warning, ...args);
};

const { loadConfig, requireKeys, ConfigError } = await import('./config.js');
const { setLogLevel, createLogger } = await import('./logger.js');
const { openStorage } = await import('./storage.js');
const { Settings } = await import('./settings.js');
const { createClient, createTonapi } = await import('./clients/index.js');
const { MockClient, MOCK_GIFT_COLLECTION, MOCK_PUNK_COLLECTION, MOCK_FAKE_COLLECTION, MOCK_FROG_COLLECTION, MOCK_RATES, MOCK_COLLECTION_NAMES, MOCK_PEER_FIXTURES } = await import('./clients/mock.js');
const { createNotifier, ConsoleNotifier } = await import('./notifier.js');
const { Buyer } = await import('./autobuy.js');
const { Engine, scoreboardFromStorage, buildDigest } = await import('./engine.js');
const { loadWallet } = await import('./wallet.js');
const { resolveCollection } = await import('./commands.js');
const { valuationTable } = await import('./valuation.js');
const { formatValuationTable, formatComps, htmlToText, escapeHtml } = await import('./format.js');
const { fmtTon, nanoToTon, fmtSigned, plural } = await import('./models.js');
const { toFriendly } = await import('./address.js');
const { Journal, EventLog, readEvents } = await import('./events.js');
const { RiskFacts } = await import('./riskfacts.js');
const { Shadow, formatHindsight } = await import('./shadow.js');
const { OfferBook } = await import('./offers.js');
const { Rates, FixedRates } = await import('./rates.js');
const { PortfolioService, MockGiftsSource, AddressSource, TelegramGiftsSource } = await import('./holdings.js');
const { formatScoreboard, readiness } = await import('./paper.js');
const { runDoctor, formatDoctor } = await import('./safety.js');
const { validateFloors } = await import('./peers.js');
const { whyTrail } = await import('./why.js');

const log = createLogger('main');

const HELP = `getgems-checker — Getgems NFT monitor with Telegram alerts that explain every deal:
honest sales-based price with a confidence grade, profit after all fees, and a safe-to-buy light.

Usage: node src/index.js <command> [options]

Commands:
  run                      Bot + poll loop (needs BOT_TOKEN/ADMIN_IDS for Telegram; else stdout)
  once                     Run a single scan cycle and exit
  mock [--cycles N]        Offline demo with fixture data (no credentials), default 3 cycles
  valuate <collection>     Fair-value table with confidence (Conf) and ignored sales (Ign)
                           add --mock for fixtures, --explain N for the comps receipt of row N
  portfolio                What your gifts are worth (profile of the first ADMIN_IDS user via the bot)
                           --address X for a wallet or name.ton, --mock for fixtures
  scoreboard               Paper autopilot results net of fees (--mock runs the mock first)
  doctor                   Self-check: config, Telegram, keys, API, DB, clock, limits (exit 1 on FAIL); --mock
  gifts                    List Telegram gift collections from Getgems (needs GETGEMS_API_KEY)
  wallet [--offline]       Show the buying wallet address (and balance unless --offline)

Options:
  --cycles N               Number of cycles for "mock" (default 3)
  --shadow-hours H         Shadow trial length used by "mock" for the hindsight card (default 0)
  --limit N                Rows for "valuate" (default 40)
  --explain N              Comps receipt for row N of "valuate"
  --address X              Wallet address or name.ton for "portfolio"
  --mock                   Use the fixture client (valuate, portfolio, scoreboard, doctor)
  -h, --help               Show this help

Modes: "practice" (paper buys) is the default. DRY_RUN=true in .env is a hard lock; live
needs DRY_RUN=false plus a confirmation in the bot (/dry off). MAX_PRICE_TON,
DAILY_BUDGET_TON and MAX_BUYS_PER_HOUR always apply to the all-in cost. See .env.example.`;

async function openApp(cfg, { mock = false, dbPath = cfg.dbPath, client = null } = {}) {
  client ??= createClient(cfg, { mock });
  const storage = await openStorage(dbPath);
  client.attachHistoryCache?.(storage); // TonAPI history sample survives restarts
  const settings = new Settings(cfg, storage);
  for (const c of cfg.watchCollections) {
    try {
      const r = await resolveCollection(c, client);
      if (r.ok) storage.watch(r.collection, { name: r.name });
      else log.warn(`WATCH_COLLECTIONS: ${r.error}`);
    } catch (e) {
      log.warn(`WATCH_COLLECTIONS entry "${c}" skipped: ${e.message}`);
    }
  }
  return { client, storage, settings };
}

/** Engine, buyer and the services they share. */
function buildServices(cfg, { client, storage, settings, notifier, mock = false, eventsFile = cfg.eventsFile, rates = undefined, giftsSource = null }) {
  const journal = new Journal({ storage, eventLog: eventsFile ? new EventLog({ file: eventsFile, maxMb: cfg.eventsMaxMb }) : null });
  const riskFacts = new RiskFacts({ client, cfg });
  const shadow = new Shadow({ storage, cfg, journal });
  const buyer = new Buyer({
    cfg,
    settings,
    storage,
    client,
    notifier,
    chain: mock ? null : createTonapi(cfg),
    walletFactory: () => loadWallet(cfg),
    riskFacts,
    journal,
    shadow,
  });
  const offers = new OfferBook({ client, cfg });
  const r =
    rates !== undefined
      ? rates
      : cfg.fiatCurrencies.length
        ? new Rates({ baseUrl: cfg.tonapiBase, currencies: cfg.fiatCurrencies, ttlMin: cfg.ratesTtlMin, apiKey: cfg.tonapiKey })
        : null;
  const engine = new Engine({ cfg, settings, storage, client, notifier, buyer, offers, rates: r, journal, shadow, riskFacts });
  const tonapi = mock ? null : client.name === 'tonapi' ? client : createTonapi(cfg);
  const portfolio = new PortfolioService({ cfg, settings, storage, client, engine, offers, rates: r, giftsSource, addressSource: new AddressSource({ client, tonapi }) });
  engine.portfolio = portfolio;
  return { journal, riskFacts, shadow, buyer, offers, rates: r, engine, portfolio };
}

/**
 * Startup check of the live gate. A live confirmation the bot cannot honour (no wallet words, or
 * the optional wallet packages are missing) falls back to practice
 * mode instead of exiting: an exit would only loop under `restart: unless-stopped`.
 * @returns {Promise<string|null>} a note for the startup message, or null
 */
async function preflightLive(cfg, settings) {
  if (settings.voidedLive) log.warn('DRY_RUN=true in .env: the stored live confirmation was voided. Going live again needs DRY_RUN=false, /dry off and its button.');
  if (!cfg.dryRun && settings.dryRun) log.info('DRY_RUN=false in .env, but live mode is not confirmed in the bot (/dry off): practice mode');
  if (settings.dryRun) return null;
  try {
    requireKeys(cfg, ['WALLET_MNEMONIC']);
    const w = await loadWallet(cfg, { offline: true });
    log.warn(`LIVE MODE: purchases will be sent from ${w.address} (${cfg.walletVersion})`);
    return null;
  } catch (e) {
    settings.setPractice();
    const note = `Live mode was confirmed, but the wallet cannot load (${e.message}). Switched back to practice mode; fix it, then /dry off again.`;
    log.error(note);
    return note;
  }
}

async function cmdRun(cfg, { onlyOnce = false } = {}) {
  if (cfg.botToken) requireKeys(cfg, ['ADMIN_IDS']);
  const { client, storage, settings } = await openApp(cfg);
  const liveNote = await preflightLive(cfg, settings);
  if (cfg.botToken && !onlyOnce) {
    const { createBot, BOT_COMMANDS } = await import('./bot.js');
    const { Api } = await import('grammy');
    const api = new Api(cfg.botToken);
    const notifier = createNotifier(cfg, { api });
    const svc = buildServices(cfg, { client, storage, settings, notifier, giftsSource: new TelegramGiftsSource(api) });
    const bot = createBot({ cfg, settings, storage, client, engine: svc.engine, buyer: svc.buyer, portfolio: svc.portfolio, shadow: svc.shadow });
    try {
      await bot.init(); // getMe: fails fast on a bad token
    } catch (e) {
      throw new ConfigError(`BOT_TOKEN was rejected by Telegram (${e.description || e.message}). Check BOT_TOKEN in .env`);
    }
    await bot.api.setMyCommands(BOT_COMMANDS.map(([command, description]) => ({ command, description }))).catch((e) =>
      log.warn('setMyCommands failed:', e.message),
    );
    const stop = () => {
      log.info('stopping…');
      svc.engine.stop();
      bot.stop();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    log.info(`bot + engine started (${client.name}, ${settings.dryRun ? 'PRACTICE' : 'LIVE'}, autobuy ${settings.autobuy ? 'on' : 'off'})`);
    await notifier.text(`🤖 Getgems checker started (${settings.dryRun ? 'PRACTICE' : 'LIVE'}, source ${client.name}).${liveNote ? `\n⚠️ ${escapeHtml(liveNote)}` : ''}`);
    await Promise.all([bot.start({ drop_pending_updates: true, onStart: (me) => log.info(`bot @${me.username} polling`) }), svc.engine.run()]);
    storage.close();
    return 0;
  }
  const notifier = createNotifier(cfg);
  const { engine } = buildServices(cfg, { client, storage, settings, notifier });
  if (onlyOnce) {
    const r = await engine.cycle();
    storage.close();
    return r.errors > 0 && r.errors === r.collections ? 1 : 0;
  }
  process.once('SIGINT', () => engine.stop());
  process.once('SIGTERM', () => engine.stop());
  log.info(`engine started without Telegram bot (${client.name}, ${settings.dryRun ? 'PRACTICE' : 'LIVE'})`);
  await engine.run();
  storage.close();
  return 0;
}

// ---- mock demo -------------------------------------------------------------------------------

/** Copy the peer floor fixtures with timestamps shifted to "now" (relative ages kept: one stays stale). */
function materializePeerFixtures(outDir, now) {
  let files = [];
  try {
    files = fs.readdirSync(MOCK_PEER_FIXTURES).filter((f) => f.endsWith('.json'));
  } catch {
    log.warn('peer floor fixtures not found (src/mock/fixtures/peers); /compare and CHEAPER_ELSEWHERE demo skipped');
    return [];
  }
  const docs = files.map((f) => ({ f, doc: JSON.parse(fs.readFileSync(new URL(f, MOCK_PEER_FIXTURES), 'utf8')) }));
  const newest = Math.max(...docs.map((d) => d.doc.ts));
  const shift = now - 30_000 - newest;
  fs.mkdirSync(outDir, { recursive: true });
  return docs.map(({ f, doc }) => {
    const out = { ...doc, ts: doc.ts + shift, items: doc.items.map((it) => ({ ...it, ts: it.ts + shift })) };
    const p = path.join(outDir, f);
    fs.writeFileSync(p, JSON.stringify(out, null, 1));
    return p;
  });
}

function mockConfig(cfg, { eventsFile, floorsFile, peerFloors }) {
  // Deterministic demo: fixed thresholds and limits, whatever .env tunes; nothing is ever spent.
  const base = loadConfig({ env: {} });
  // Offline: no Telegram keys, so nothing is ever sent to your chat. Mock alert buttons would
  // point at data/mock.db alert ids that mean something else in the real database.
  return {
    ...base,
    botToken: '',
    adminIds: [],
    alertChatIds: [],
    logLevel: cfg.logLevel,
    watchCollections: [],
    dryRun: true,
    autobuyEnabled: true,
    maxPriceTon: 20,
    dailyBudgetTon: 50,
    maxBuysPerHour: 2,
    confirmAboveTon: 10,
    salesRefreshMin: 0,
    paperMarkEveryMin: 0,
    digestAt: '',
    paperReportHour: -1,
    portfolioDailyHour: -1,
    shadowMinHours: 1e9, // hindsight card printed at the end instead
    shadowMaxHours: 1e9,
    anthropicApiKey: '',
    eventsFile,
    floorsFile,
    peerFloors,
    peerMaxAgeSec: 300,
  };
}

function section(title) {
  console.log(`\n========== ${title} ==========`);
}

async function runMock(cfg, cycles, { shadowHours = 0, quiet = false } = {}) {
  const dataDir = path.resolve('data');
  const dbPath = path.join(dataDir, 'mock.db');
  const eventsFile = path.join(dataDir, 'mock-events.jsonl');
  const floorsFile = path.join(dataDir, 'mock-floors.json');
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, eventsFile, `${eventsFile}.1`, floorsFile]) fs.rmSync(f, { force: true });
  const now0 = Date.now();
  const peerFloors = cfg.peerFloors.length ? cfg.peerFloors : materializePeerFixtures(path.join(dataDir, 'mock-peers'), now0);
  const mockCfg = mockConfig(cfg, { eventsFile, floorsFile, peerFloors });
  const client = new MockClient();
  const { storage, settings } = await openApp(mockCfg, { mock: true, dbPath, client });
  settings.setFlag('dry_run', true); // mock never spends, whatever .env says
  settings.setFlag('autobuy', true);
  settings.setFlag('paused', false);
  // Punks first: the Fragment-banned punk reaches the pre-buy check before the hourly cap fills.
  storage.watch(MOCK_PUNK_COLLECTION, { name: 'Mock Punks' });
  storage.watch(MOCK_FAKE_COLLECTION, { name: MOCK_COLLECTION_NAMES[MOCK_FAKE_COLLECTION], isGift: false });
  storage.watch(MOCK_GIFT_COLLECTION, { name: 'Mock Plush Pepes', isGift: true });
  storage.watch(MOCK_FROG_COLLECTION, { name: 'Mock Frogs' });
  const r1 = storage.addRule({ collection: MOCK_GIFT_COLLECTION, maxPriceTon: 20, minDiscountPct: 40, state: 'live' });
  const r2 = storage.addRule({ collection: '*', maxPriceTon: 10, minDiscountPct: 50, state: 'live' });
  const r3 = storage.addRule({ collection: MOCK_GIFT_COLLECTION, maxPriceTon: 15, minDiscountPct: 35, maxEtaDays: 20, state: 'shadow', createdAt: now0 });
  const notifier = new ConsoleNotifier({ quiet });
  const svc = buildServices(mockCfg, { client, storage, settings, notifier, mock: true, eventsFile, rates: new FixedRates(MOCK_RATES), giftsSource: new MockGiftsSource() });
  const { engine, shadow } = svc;
  if (!quiet) {
    log.info(
      `MOCK (offline, prints here, sends nothing to Telegram): ${plural(cycles, 'cycle')}, practice mode forced, autobuy rules #${r1} (Mock Plush Pepes, max 20, discount ≥ 40%), ` +
        `#${r2} (* max 10, discount ≥ 50%), shadow rule #${r3} (Mock Plush Pepes, max 15, discount ≥ 35%, sells in ≤ 20d)`,
    );
  }
  for (let i = 1; i <= cycles; i++) await engine.cycle();
  return { mockCfg, client, storage, settings, svc, engine, shadow, notifier, shadowHours, eventsFile, floorsFile, peerFloors };
}

async function cmdMock(cfg, cycles, { shadowHours = 0 } = {}) {
  const m = await runMock(cfg, cycles, { shadowHours });
  const { storage, engine, shadow, notifier, mockCfg, settings, client, svc } = m;
  const now = Date.now();

  section('Mock buys ledger');
  for (const b of storage.listBuys(100).reverse()) {
    console.log(
      `  #${b.id} ${b.mode} ${b.status.padEnd(7)} ${b.name} ${fmtTon(b.priceTon)} TON${b.allInTon ? ` (all-in ${fmtTon(b.allInTon)})` : ''}` +
        `${b.reasonCode ? ` [${b.reasonCode}]` : ''}${b.outcome === 'lost_race' ? ' — LOST RACE' : ''}${b.error && b.status === 'blocked' ? ` — ${b.error}` : ''}`,
    );
  }

  section('Shadow fills');
  for (const r of storage.listRules().filter((x) => x.state === 'shadow')) {
    for (const f of storage.listShadowFills({ ruleId: r.id })) {
      const cost = f.entryPrice + f.entryCosts;
      console.log(
        `  rule #${r.id} ${f.meta.name} entry ${fmtTon(cost)} all-in → mark ${f.markPrice === null ? '-' : fmtTon(f.markPrice)} net ` +
          `(${f.markPrice === null ? '-' : fmtSigned(f.markPrice - cost)}) · ${f.outcome}${f.meta.goneAfterSec !== undefined ? ` (listing gone after ${f.meta.goneAfterSec}s)` : ''}`,
      );
    }
  }
  const cards = shadow.dueCards(now, { minHours: m.shadowHours, maxHours: m.shadowHours, minMatches: 1 });
  for (const c of cards) {
    const text = formatHindsight(c.rule, c.summary, { collectionName: engine.names[c.rule.collection], ageH: c.ageH, snipedWindowSec: mockCfg.snipedWindowSec, envLocked: true });
    const { InlineKeyboard } = await import('grammy');
    await notifier.text(text, { reply_markup: new InlineKeyboard().text('Go live', `shlive:${c.rule.id}`).text('Keep testing 24h', `shkeep:${c.rule.id}`).text('Delete', `shdel:${c.rule.id}`) });
  }

  section('/why for skipped items');
  const blocked = storage.allBuys().filter((b) => b.status === 'blocked' && b.alertId);
  const shown = new Set();
  for (const code of ['confidence_low', 'rate', 'cheaper_elsewhere']) {
    const b = blocked.find((x) => String(x.reasonCode).startsWith(code));
    if (!b || shown.has(b.alertId)) continue;
    shown.add(b.alertId);
    console.log(`\n/why ${b.alertId}\n${htmlToText(whyTrail(storage, String(b.alertId)))}`);
  }

  section('/compare Mock Plush Pepes Gold');
  const { compareTable } = await import('./bot.js');
  console.log(compareTable({ cfg: mockCfg, engine, collection: MOCK_GIFT_COLLECTION, name: 'Mock Plush Pepes', model: 'Gold', peers: engine.peers }));

  section('Files');
  const floors = JSON.parse(fs.readFileSync(m.floorsFile, 'utf8'));
  const fv = validateFloors(floors);
  console.log(`  ${path.relative(process.cwd(), m.floorsFile)}: suite.floors.v1, ${floors.items.length} items, ${fv.ok ? 'valid' : `INVALID: ${fv.errors.join('; ')}`}`);
  const ev = readEvents(m.eventsFile);
  console.log(`  ${path.relative(process.cwd(), m.eventsFile)}: ${ev.events.length} suite.event.v1 events, ${ev.bad} invalid`);

  section('Digest preview');
  console.log(htmlToText(buildDigest({ storage, settings, cfg: mockCfg, now }).text));

  section('Scoreboard');
  const sb = scoreboardFromStorage(storage, now);
  console.log(htmlToText(formatScoreboard(sb)));
  console.log(readiness(sb, mockCfg).text);

  section('Doctor');
  const doc = formatDoctor(await runDoctor({ cfg: mockCfg, settings, storage, client }));
  console.log(doc.text);

  section('Portfolio (mock profile gifts)');
  const pf = await svc.portfolio.profile(0);
  console.log(htmlToText(pf.text));
  storage.close();
  return 0;
}

async function cmdScoreboard(cfg, { mock }) {
  let storage;
  if (mock) {
    setLogLevel('error');
    const m = await runMock(cfg, 3, { quiet: true });
    storage = m.storage;
  } else {
    storage = await openStorage(cfg.dbPath);
  }
  const sb = scoreboardFromStorage(storage);
  console.log(htmlToText(formatScoreboard(sb, { currency: cfg.currencyLabel })));
  console.log(readiness(sb, cfg).text);
  storage.close();
  return 0;
}

async function cmdValuate(cfg, target, { mock, limit, explain }) {
  const dbPath = mock ? ':memory:' : cfg.dbPath;
  const { client, storage, settings } = await openApp({ ...cfg, watchCollections: [] }, { mock, dbPath });
  if (!target && mock) target = MOCK_GIFT_COLLECTION;
  if (!target) throw new ConfigError('Usage: valuate <collection address | gift name> [--mock] [--limit N] [--explain N]');
  const r = await resolveCollection(target, client);
  if (!r.ok) throw new ConfigError(r.error);
  const now = Date.now();
  const engine = new Engine({ cfg, settings, storage, client, notifier: null, buyer: null });
  const info = await client.getCollectionInfo(r.collection).catch(() => ({ name: r.name, isGift: false }));
  const listings = await client.getListings(r.collection, { pages: cfg.listingPages });
  await engine.refreshSales(r.collection, now, { force: true });
  const source = client.salesSource?.(r.collection) ?? null;
  const params = settings.valuationParams(now, { sampled: !!source?.sampled });
  const sales = storage.getSales(r.collection, now - params.lookbackDays * 86_400_000);
  const rows = valuationTable(listings, sales, params);
  if (explain) {
    const row = rows[explain - 1];
    if (!row) throw new ConfigError(`--explain ${explain}: there are only ${rows.length} rows`);
    console.log(`${row.listing.name} — ${fmtTon(row.listing.priceTon)} TON (row ${explain})`);
    console.log(formatComps({ listing: row.listing, valuation: row.valuation }, { html: false, roundTripDays: cfg.washRoundTripDays, currency: cfg.currencyLabel }));
    storage.close();
    return 0;
  }
  console.log(`Collection: ${info.name || r.name || '?'} (${toFriendly(r.collection)})${info.isGift ? ' [gift]' : ''}`);
  console.log(
    `Listings: ${listings.length} · sales in ${params.lookbackDays}d: ${sales.length}${source ? ` (${source.label})` : ''} · last N=${params.maxComparables}, min ${params.minComparables}, ` +
      `${params.timeWeighted ? `time-weighted (half-life ${params.halfLifeDays}d)` : 'median'} · levels ${params.levels.join('→')} · wash filter ${params.washFilter ? 'on' : 'off'}\n`,
  );
  if (!rows.some((x) => x.valuation.fairValueTon !== null)) {
    console.log(
      `Not enough sales yet: ${plural(sales.length, 'sale')} in ${params.lookbackDays}d, every level is below MIN_COMPARABLES=${params.minComparables}.` +
        (source?.sampled
          ? ` The free TonAPI sample grows by up to ${cfg.tonapiHistoryItems} items per refresh; run valuate again later, or set GETGEMS_API_KEY (paid) for the full history.`
          : ''),
    );
    if (!rows.length) {
      storage.close();
      return 0;
    }
  }
  console.log(formatValuationTable(rows, { limit }));
  console.log('\nConf: A = many tight same-model sales, B = usable, C = thin or mixed. Ign: sales of the level used (Level) that were left out: wash, flagged, outliers. --explain N shows the receipt.');
  storage.close();
  return 0;
}

async function cmdPortfolio(cfg, { mock, address }) {
  if (mock) {
    setLogLevel('error');
    const m = await runMock(cfg, 0, { quiet: true });
    const r = address ? await m.svc.portfolio.address(address, 0) : await m.svc.portfolio.profile(0);
    console.log(htmlToText(r.text));
    m.storage.close();
    return 0;
  }
  const { client, storage, settings } = await openApp(cfg);
  const notifier = createNotifier(cfg, { quiet: true });
  let giftsSource = null;
  if (!address) {
    requireKeys(cfg, ['BOT_TOKEN', 'ADMIN_IDS']);
    const { Api } = await import('grammy');
    giftsSource = new TelegramGiftsSource(new Api(cfg.botToken));
  }
  const svc = buildServices(cfg, { client, storage, settings, notifier, eventsFile: null, giftsSource });
  const userId = cfg.adminIds[0] ?? 0;
  const r = address ? await svc.portfolio.address(address, userId) : await svc.portfolio.profile(userId);
  console.log(htmlToText(r.text));
  storage.close();
  return 0;
}

async function cmdDoctor(cfg, { mock }) {
  const client = mock ? new MockClient() : createClient(cfg);
  const storage = await openStorage(mock ? ':memory:' : cfg.dbPath);
  const settings = new Settings(mock ? { ...cfg, dryRun: true } : cfg, storage);
  const r = formatDoctor(await runDoctor({ cfg, settings, storage, client }));
  console.log(r.text);
  storage.close();
  return r.exitCode;
}

async function cmdGifts(cfg) {
  if (!cfg.getgemsApiKey) {
    throw new ConfigError('The gifts command needs GETGEMS_API_KEY (paid): the free TonAPI source has no list of gift collections. Get a key at https://getgems.io/public-api');
  }
  const client = createClient({ ...cfg, dataSource: 'getgems' });
  const list = await client.listGiftCollections({ maxAgeMs: 0 });
  for (const g of list) console.log(`${toFriendly(g.address)}  ${g.name}`);
  console.log(`\n${plural(list.length, 'gift collection')}`);
  return 0;
}

async function cmdWallet(cfg, { offline }) {
  requireKeys(cfg, ['WALLET_MNEMONIC']);
  const w = await loadWallet(cfg, { offline });
  console.log(`Wallet ${cfg.walletVersion}: ${w.address}`);
  if (!offline) console.log(`Balance: ${fmtTon(nanoToTon(await w.balanceNano()), 4)} TON`);
  return 0;
}

const intOpt = (v, name, def, min = 0) => {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new ConfigError(`--${name} must be ${min >= 1 ? 'a positive' : 'a non-negative'} integer`);
  return n;
};

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cycles: { type: 'string' },
      'shadow-hours': { type: 'string' },
      limit: { type: 'string' },
      explain: { type: 'string' },
      address: { type: 'string' },
      mock: { type: 'boolean' },
      offline: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command || command === 'help') {
    console.log(HELP);
    return 0;
  }
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  switch (command) {
    case 'run':
      return cmdRun(cfg);
    case 'once':
      return cmdRun(cfg, { onlyOnce: true });
    case 'mock': {
      const cycles = intOpt(values.cycles, 'cycles', 3, 1);
      return cmdMock(cfg, cycles, { shadowHours: Number(values['shadow-hours'] ?? 0) });
    }
    case 'valuate':
      return cmdValuate(cfg, rest.join(' '), { mock: !!values.mock, limit: intOpt(values.limit, 'limit', 40), explain: intOpt(values.explain, 'explain', 0) });
    case 'portfolio':
      return cmdPortfolio(cfg, { mock: !!values.mock, address: values.address || rest.join(' ') || null });
    case 'scoreboard':
      return cmdScoreboard(cfg, { mock: !!values.mock });
    case 'doctor':
      return cmdDoctor(cfg, { mock: !!values.mock });
    case 'gifts':
      return cmdGifts(cfg);
    case 'wallet':
      return cmdWallet(cfg, { offline: !!values.offline });
    default:
      console.error(`Unknown command "${command}"\n`);
      console.log(HELP);
      return 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (e instanceof ConfigError || e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    console.error(`Error: ${e.message}`);
    process.exitCode = 2;
  } else {
    console.error(`Fatal: ${e?.stack || e}`);
    process.exitCode = 1;
  }
}
// Mock/valuate/once leave no timers behind except undici keep-alive sockets; exit explicitly.
if (!['run'].includes(process.argv[2])) process.exit(process.exitCode ?? 0);
