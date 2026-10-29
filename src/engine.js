// Poll loop: scan watched collections -> refresh sales cache -> detect -> net edge, bids, safety
// light -> notify (push or silent lane) -> autobuy (live rules) / shadow fills (shadow rules).
// After each collection: paper outcomes (lost races) and marks from the sales cache (no extra
// API calls). After each cycle: floors.json, stale-data/market checks, hindsight cards and the
// daily jobs (digest, paper report, portfolio).

import { detect, secondCheapest } from './detector.js';
import { findRule, ruleGate, ruleMiss, confidenceOf, CONF_RANK } from './autobuy.js';
import { looksLikeGift } from './models.js';
import { DAY_MS, cleanWindow, estimateFairValue } from './valuation.js';
import { feeModel, liquidity, computeEdge } from './edge.js';
import { OfferBook } from './offers.js';
import { RiskFacts } from './riskfacts.js';
import { assessRisk, failingIds } from './risk.js';
import { Journal } from './events.js';
import { Shadow, formatHindsight } from './shadow.js';
import { verdictOf, whyReasons } from './format.js';
import { classifyRace, markToMarket, scoreboard, formatScoreboard, readiness } from './paper.js';
import { compareElsewhere, buildFloors, writeFloorsAtomic, readPeers, loadAliases } from './peers.js';
import { autoPauseState, setAutoPause, clearAutoPause, isStale, unexplainedDrop } from './safety.js';
import { aggregateEvents, tuningHints, renderDigest, readPeerEvents, suiteSection } from './digest.js';
import { reasonText, reasonSev } from './explain.js';
import { InlineKeyboard } from 'grammy';
import { createLogger } from './logger.js';

const log = createLogger('engine');

/** Local date and HH:MM in a time zone. */
export function tzParts(ms, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hhmm: `${parts.hour}:${parts.minute}`, hour: Number(parts.hour) };
}

/** Scoreboard over the buys ledger, with "sold Ns after it appeared" for lost races. */
export function scoreboardFromStorage(storage, now = Date.now()) {
  const buys = storage.allBuys().map((b) => {
    if (b.outcome !== 'lost_race') return b;
    const sale = storage.saleOf(b.nft, b.createdAt);
    const appeared = (b.alertId && storage.getAlert(b.alertId)?.createdAt) || b.createdAt;
    return { ...b, soldAfterSec: sale ? Math.max(0, Math.round((sale.timeMs - appeared) / 1000)) : null };
  });
  return scoreboard(buys, now);
}

/** Digest text and tuning hints from the decisions log, buys ledger and shadow marks. */
export function buildDigest({ storage, settings, cfg, now = Date.now(), periodH = 24 }) {
  const since = now - periodH * 3_600_000;
  const events = storage.decisionsSince(since).map((d) => d.payload);
  const agg = aggregateEvents(events);
  const mode = settings.dryRun ? 'dry' : 'live';
  const spentTon = storage
    .buysSince(now - DAY_MS)
    .filter((b) => b.mode === mode && ['dry', 'pending', 'sent'].includes(b.status) && b.outcome !== 'lost_race')
    .reduce((s, b) => s + (b.allInTon ?? b.priceTon), 0);
  const sb = scoreboardFromStorage(storage, now);
  const hints = tuningHints(storage.listShadowFills({ skipsOnly: true, sinceMs: since }), settings);
  const peer = cfg.peerEventFiles?.length ? readPeerEvents(cfg.peerEventFiles, { sinceMs: since }) : null;
  const suite = peer ? suiteSection(peer.events) : null;
  // Same definitions as /scoreboard: lost races are not buys; blocked attempts are buys-table rows.
  // Skips before any buy attempt (no rule matched, autobuy off, muted, paused) are counted apart.
  const periodBuys = storage.buysSince(since).filter((b) => b.mode === mode);
  const ledger = {
    bought: periodBuys.filter((b) => ['dry', 'pending', 'sent'].includes(b.status) && b.outcome !== 'lost_race').length,
    lost: periodBuys.filter((b) => b.outcome === 'lost_race').length,
    blocked: periodBuys.filter((b) => b.status === 'blocked').length,
    skippedEarly: storage.decisionsSince(since).filter((d) => d.kind === 'skip' && !d.buyId && d.mode === mode).length,
  };
  const text = renderDigest({ agg, mode: settings.mode, spentTon, budgetTon: settings.limits(now).dailyBudgetTon, sb, hints, suite, periodH, currency: cfg.currencyLabel, ledger });
  return { text, hints, agg };
}

export class Engine {
  /**
   * @param {Object} o
   * @param {import('./config.js').Config} o.cfg
   * @param {import('./settings.js').Settings} o.settings
   * @param {import('./storage.js').Storage} o.storage
   * @param {import('./clients/index.js').MarketClient} o.client
   * @param {import('./notifier.js').Notifier} o.notifier
   * @param {import('./autobuy.js').Buyer} o.buyer
   * @param {OfferBook} [o.offers]
   * @param {{get: Function}|null} [o.rates]
   * @param {Journal} [o.journal]
   * @param {Shadow} [o.shadow]
   * @param {RiskFacts} [o.riskFacts]
   * @param {() => number} [o.clock]
   */
  constructor({ cfg, settings, storage, client, notifier, buyer, offers, rates = null, journal, shadow, riskFacts, clock }) {
    Object.assign(this, { cfg, settings, storage, client, notifier, buyer });
    this.clock = clock || (() => Date.now());
    this.offers = offers || new OfferBook({ client, cfg });
    this.rates = rates;
    this.journal = journal || buyer?.journal || new Journal({ storage });
    this.riskFacts = riskFacts || buyer?.riskFacts || new RiskFacts({ client, cfg });
    this.shadow = shadow || buyer?.shadow || new Shadow({ storage, cfg, journal: this.journal });
    if (buyer && !buyer.shadow) buyer.shadow = this.shadow;
    this.aliases = loadAliases();
    this.peers = [];
    this.warnedPeers = new Set();
    this.mutedLogged = new Set();
    this.cycleRates = null;
    /** @type {Record<string, import('./models.js').Listing[]>} */
    this.lastListings = {};
    this.names = {};
    this.lastOkAt = null;
    this.portfolio = null;
    this.cycleNo = 0;
    this.lastCycle = null;
    /** @type {Record<string, {listings:number, cheapest:number|null, floorRef:number|null, sales:number}>} */
    this.stats = {};
    this.stopped = false;
  }

  async #ensureMeta(w) {
    if (w.name) return w;
    try {
      const info = await this.client.getCollectionInfo(w.collection);
      this.storage.setCollectionMeta(w.collection, info);
      return { ...w, name: info.name || w.name, isGift: w.isGift || info.isGift };
    } catch (e) {
      log.debug(`collection info failed for ${w.collection}:`, e.message);
      return w;
    }
  }

  /** Incrementally sync sold events into SQLite and fill missing attributes. */
  async refreshSales(collection, now, { force = false } = {}) {
    const since = now - this.settings.get('lookback_days') * DAY_MS;
    const key = `sales_sync:${collection}`;
    const last = Number(this.storage.getSetting(key) || 0);
    if (!force && now - last < this.cfg.salesRefreshMin * 60_000) return false;
    const latest = this.storage.latestSaleTime(collection);
    const fetchSince = latest ? Math.max(since, Math.min(latest, now) - 60_000) : since;
    const sales = await this.client.getSales(collection, { sinceMs: fetchSince, windowSinceMs: since, maxPages: this.cfg.salesMaxPages });
    const added = this.storage.upsertSales(sales);
    // Sources that carry item metadata with each sale (TonAPI) save the attribute lookups.
    const withAttrs = sales.filter((s) => s.attrs && Object.keys(s.attrs).length);
    if (withAttrs.length) this.storage.upsertAttrs(withAttrs.map((s) => ({ nft: s.nft, collection: s.collection, name: s.name, attrs: s.attrs })));
    const missing = this.storage.nftsMissingAttrs(collection, since);
    if (missing.length) {
      const got = await this.client.getNftAttributes(missing);
      const seen = new Set(got.map((g) => g.nft));
      // Remember NFTs without attributes too, so they are not re-requested every cycle.
      const empty = missing.filter((n) => !seen.has(n)).map((nft) => ({ nft, collection, attrs: {} }));
      this.storage.upsertAttrs([...got, ...empty]);
    }
    this.storage.setSetting(key, now);
    log.debug(`sales ${collection}: +${added} new, ${missing.length} attr lookups`);
    return true;
  }

  #mode() {
    return this.settings.dryRun ? 'dry' : 'live';
  }

  #skip(alert, alertId, code, p = {}, { ruleId = null, text = null } = {}) {
    this.journal.record({
      kind: 'skip',
      mode: this.#mode(),
      alertId,
      listing: alert.listing,
      alert,
      verdict: 'SKIP',
      code,
      reasons: [{ code, sev: reasonSev(code), p }],
      text: `Not bought: ${text || reasonText(code, p)}`,
      ruleId,
    });
  }

  /** Paper outcomes for this collection: lost races come from the sales cache (no API call). */
  #classifyOutcomes(collection, now) {
    for (const b of this.storage.positions(collection, now - 7 * DAY_MS)) {
      if (b.mode !== 'dry' || b.outcome === 'lost_race') continue;
      const sale = this.storage.saleOf(b.nft, b.createdAt);
      const o = classifyRace(b, sale, { lostRaceSec: this.cfg.lostRaceSec });
      if (o === 'lost_race') {
        this.storage.updateBuyMarks(b.id, { outcome: 'lost_race', outcomeAt: now });
        log.info(`paper buy #${b.id} ${b.name}: lost race (sold ${Math.round((sale.timeMs - b.createdAt) / 1000)}s after our buy)`);
      } else if (sale && b.outcome !== 'gone') this.storage.updateBuyMarks(b.id, { outcome: 'gone', outcomeAt: now });
      else if (!b.outcome) this.storage.updateBuyMarks(b.id, { outcome: 'open', outcomeAt: now });
    }
  }

  /** Mark held positions net of fees at most every PAPER_MARK_EVERY_MIN. */
  #markPositions(collection, { listings, sales, clean, vp, fees, now }) {
    const key = `paper_marked:${collection}`;
    const last = Number(this.storage.kvGet(key) || 0);
    if (now - last < this.cfg.paperMarkEveryMin * 60_000) return;
    for (const b of this.storage.positions(collection, 0)) {
      if (b.outcome === 'lost_race') continue;
      const attrs = (b.alertId && this.storage.getAlert(b.alertId)?.listing?.attrs) || this.storage.getAttrs(b.nft) || {};
      const v = estimateFairValue({ attrs }, sales, vp, { clean });
      const same = listings.filter((l) => l.nft !== b.nft && (!attrs.model || l.attrs?.model === attrs.model)).map((l) => l.priceTon);
      const floorRef = same.length ? Math.min(...same) : null;
      const m = markToMarket(b, v, fees, floorRef, this.cfg);
      if (m.markTon !== null) this.storage.updateBuyMarks(b.id, { markTon: m.markTon, markConsTon: m.markConsTon, markedAt: now });
    }
    this.storage.kvSet(key, String(now));
  }

  async #handleAlert(alert, { w, now, listings, clean, fees, counters }) {
    const l = alert.listing;
    const mode = this.#mode();
    const muted = this.storage.mutedOf([l.nft, l.collection], now);
    if (muted) {
      counters.muted++;
      // Muted subjects are still logged (kind=skip, MUTED), once per NFT and price.
      const key = `${l.nft}:${l.priceNano}`;
      if (this.mutedLogged.has(key)) return;
      this.mutedLogged.add(key);
      this.#skip(alert, null, 'MUTED', { subject: muted.label || muted.subject, until: new Date(muted.until).toISOString().slice(0, 16).replace('T', ' ') }, { text: 'muted, still logged' });
      return;
    }
    const fair = alert.valuation?.fairValueTon ?? null;
    const liq = liquidity({ sales: clean.kept, listings, target: l, fairTon: fair ?? alert.floorRefTon, now, cfg: this.cfg });
    const { available, bid } = await this.offers.bidFor(l);
    alert.edge = computeEdge({ listing: l, valuation: alert.valuation, floorRefTon: alert.floorRefTon, fees, liquidity: liq, bid, bidsAvailable: available, cfg: this.cfg });
    alert.risk = assessRisk(await this.riskFacts.alertTime(l, alert), this.cfg);
    // Cross-market comparison is by collection name, so never for a lookalike collection.
    const lookalike = alert.risk.checks.some((c) => c.id === 'official_collection' && c.status === 'bad');
    if (this.peers.length && looksLikeGift(l.attrs) && !lookalike) {
      alert.elsewhere = compareElsewhere({
        collectionName: w.name || '',
        model: l.attrs.model,
        allInTon: alert.edge.allInTon,
        exitHereTon: alert.edge.exitNetTon,
        peers: this.peers,
        aliases: this.aliases,
        crossCheaperPct: this.cfg.crossCheaperPct,
      });
    }
    alert.mode = this.settings.mode;
    alert.verdict = verdictOf(alert);
    alert.fiat = this.cycleRates;
    alert.dataAt = now;
    alert.salesSyncedAt = Number(this.storage.getSetting(`sales_sync:${l.collection}`)) || null;

    const negative = alert.edge.edgeTon !== null && alert.edge.edgeTon < 0;
    const illiquid = alert.reasons.some((r) => r.kind === 'undervalued') && alert.edge.liquidity?.badge === 'illiquid';
    let lane = negative ? this.cfg.negativeEdgeAlerts : 'push';
    if (lane === 'push' && illiquid) lane = 'silent';
    if (lane === 'drop') {
      counters.dropped++;
      this.#skip(alert, null, 'FEES_EAT_PROFIT', { edge: alert.edge.edgeTon.toFixed(2) }, { text: 'not a deal after fees, alert dropped (NEGATIVE_EDGE_ALERTS=drop)' });
      return;
    }

    const alertId = this.storage.saveAlert(alert);
    counters.alerts++;
    const reasons = alert.reasons.map((r) => ({ code: r.code, sev: 'good', p: r.p || {} }));
    if (negative) reasons.push({ code: 'FEES_EAT_PROFIT', sev: 'bad', p: { edge: alert.edge.edgeTon.toFixed(2) } });
    if (alert.valuation?.confidence === 'C' && fair !== null) reasons.push({ code: 'FEW_COMPS', sev: 'warn', p: { n: alert.valuation.comparables, grade: 'C' } });
    if (alert.valuation?.sampleLowered) reasons.push({ code: 'SMALL_SAMPLE', sev: 'warn', p: { grade: alert.valuation.confidence } });
    if (illiquid) reasons.push({ code: 'LOW_LIQUIDITY', sev: 'warn', p: { eta: Number.isFinite(liq.etaDays) ? Math.round(liq.etaDays) : '∞' } });
    if (alert.edge.exitBacked) reasons.push({ code: 'EXIT_BACKED', sev: 'good', p: { bid: alert.edge.bid.netTon.toFixed(2), edge: alert.edge.bid.edgeTon.toFixed(2) } });
    if (alert.risk.level !== 'green') {
      const ids = [...failingIds(alert.risk, 'bad'), ...failingIds(alert.risk, 'warn')];
      reasons.push({ code: alert.risk.level === 'red' ? 'RISK_RED' : 'RISK_WARN', sev: alert.risk.level === 'red' ? 'bad' : 'warn', p: { checks: ids.join(',') } });
    }
    this.journal.record({
      kind: 'alert',
      mode,
      id: `alert:${alertId}`,
      alertId,
      listing: l,
      alert,
      verdict: alert.verdict,
      code: alert.reasons[0]?.code,
      reasons,
      text: `Alerted (${alert.verdict}${lane === 'silent' ? ', silent' : ''}): ${whyReasons(alert).join('; ')}`,
      usdRate: this.cycleRates?.prices?.usd ?? null,
    });
    await this.notifier.alert(alert, alertId, {
      collectionName: w.name,
      silent: lane === 'silent',
      explainMore: !!this.cfg.anthropicApiKey,
      currency: this.cfg.currencyLabel,
      notes: { offchain: this.cfg.offchainNote, telemint: this.cfg.telemintNote },
    });
    await this.#autobuy(alert, alertId, now, counters);
  }

  async #autobuy(alert, alertId, now, counters) {
    const rules = this.storage.listRules().filter((r) => r.enabled);
    if (!rules.length) return;
    const l = alert.listing;
    // Shadow rules record would-be buys and never reach the executor, even with DRY_RUN=false.
    for (const r of rules.filter((x) => x.state === 'shadow')) {
      if (!findRule(alert, [r]) || ruleGate(alert, r, this.cfg)) continue;
      if ((CONF_RANK[confidenceOf(alert, this.cfg)] || 0) < CONF_RANK[this.cfg.autobuyMinConfidence || 'B']) continue;
      if (alert.risk?.level === 'red') continue;
      if (this.shadow.record(r, alert, alertId, now)) counters.shadow++;
    }
    const live = rules.filter((r) => r.state === 'live');
    const rule = findRule(alert, live);
    if (!this.settings.autobuy) {
      if (rule) this.#skip(alert, alertId, 'AUTOBUY_OFF', {}, { ruleId: rule.id });
      return;
    }
    if (!rule) {
      const miss = ruleMiss(alert, live);
      if (miss) this.#skip(alert, alertId, miss.code, miss.p, { ruleId: miss.ruleId });
      return;
    }
    if (this.settings.panic) {
      this.#skip(alert, alertId, 'PANIC', {}, { ruleId: rule.id });
      return;
    }
    const ap = autoPauseState(this.storage);
    if (ap) {
      this.#skip(alert, alertId, 'PAUSED', { why: ap.reason }, { ruleId: rule.id });
      return;
    }
    counters.buys++;
    await this.buyer.buy(l, { source: 'auto', ruleId: rule.id, alertId, alert, rule });
  }

  async #scan(w, now, counters) {
    w = await this.#ensureMeta(w);
    this.names[w.collection] = w.name;
    const listings = await this.client.getListings(w.collection, { pages: this.cfg.listingPages });
    if (!w.isGift && listings.some((l) => looksLikeGift(l.attrs))) {
      this.storage.setCollectionMeta(w.collection, { isGift: true });
    }
    await this.refreshSales(w.collection, now);
    const source = this.client.salesSource?.(w.collection) ?? null;
    const sampled = { sampled: !!source?.sampled };
    const vp = this.settings.valuationParams(now, sampled);
    const sales = this.storage.getSales(w.collection, now - vp.lookbackDays * DAY_MS);
    const clean = cleanWindow(sales, vp);
    this.#classifyOutcomes(w.collection, now);
    this.lastListings[w.collection] = listings;
    this.stats[w.collection] = {
      listings: listings.length,
      cheapest: listings.length ? Math.min(...listings.map((l) => l.priceTon)) : null,
      floorRef: secondCheapest(listings),
      sales: sales.length,
    };
    counters.listings += listings.length;

    const params = this.settings.detectParams(now, sampled);
    const alerts = detect({ listings, salesByCollection: { [w.collection]: sales }, params, cleanByCollection: { [w.collection]: clean } });
    const fees = feeModel(listings, this.cfg);
    const cooldownMs = this.settings.get('cooldown_min') * 60_000;
    for (const alert of alerts) {
      const l = alert.listing;
      if (this.storage.wasAlerted(l.nft, l.priceNano, now - cooldownMs)) continue;
      alert.salesSource = source?.label ?? null;
      await this.#handleAlert(alert, { w, now, listings, clean, fees, counters });
    }
    this.shadow.mark({ collection: w.collection, listings, sales, params: vp, fees, now, clean });
    this.#markPositions(w.collection, { listings, sales, clean, vp, fees, now });
  }

  async cycle() {
    this.cycleNo++;
    this.client.tick?.(this.cycleNo);
    const startedAt = this.clock();
    const counters = { collections: 0, listings: 0, alerts: 0, buys: 0, errors: 0, muted: 0, dropped: 0, shadow: 0 };
    if (this.settings.paused) {
      log.info(`cycle ${this.cycleNo}: paused`);
      this.lastCycle = { at: startedAt, paused: true, ...counters };
      return this.lastCycle;
    }
    this.offers.beginCycle();
    this.cycleRates = this.rates ? await this.rates.get(startedAt).catch(() => null) : null;
    this.peers = this.cfg.peerFloors?.length
      ? await readPeers(this.cfg.peerFloors, { now: startedAt, maxAgeSec: this.cfg.peerMaxAgeSec, warned: this.warnedPeers }).catch(() => [])
      : [];
    const watch = this.storage.listWatch();
    if (!watch.length) log.warn('watchlist is empty: add collections with /watch or WATCH_COLLECTIONS');
    for (const w of watch) {
      counters.collections++;
      try {
        await this.#scan(w, startedAt, counters);
      } catch (e) {
        counters.errors++;
        log.error(`scan ${w.name || w.collection} failed:`, e.message);
      }
    }
    if (counters.collections && counters.errors < counters.collections) this.lastOkAt = startedAt;
    this.lastCycle = { at: startedAt, ms: this.clock() - startedAt, ...counters };
    log.info(
      `cycle ${this.cycleNo}: ${counters.collections} collections, ${counters.listings} listings, ` +
        `${counters.alerts} new alerts, ${counters.buys} buy attempts, ${counters.shadow} shadow fills, ${counters.errors} errors (${this.lastCycle.ms} ms)`,
    );
    await this.#afterCycle(startedAt, counters);
    return this.lastCycle;
  }

  /** Write this bot's floors (suite.floors.v1) atomically. */
  writeFloors(now) {
    if (!this.cfg.floorsFile) return null;
    const collections = Object.entries(this.lastListings).map(([c, listings]) => ({ name: this.names[c] || c, listings }));
    if (!collections.length) return null;
    const fees = { buy_pct: 0, sell_pct: this.cfg.marketFeePctFallback + this.cfg.royaltyPctFallback, fixed_ton: this.cfg.networkCostTon };
    return writeFloorsAtomic(this.cfg.floorsFile, buildFloors({ market: 'getgems', ts: now, fees, collections }));
  }

  async #afterCycle(now, counters) {
    try {
      this.writeFloors(now);
    } catch (e) {
      log.warn('floors.json write failed:', e.message);
    }
    const ap = autoPauseState(this.storage);
    const allFailed = counters.collections > 0 && counters.errors === counters.collections;
    if (allFailed && !ap && isStale(this.lastOkAt || this.startedAt || now, now, this.cfg.staleDataSec)) {
      const reason = `market data is stale (no successful scan for more than ${this.cfg.staleDataSec}s)`;
      setAutoPause(this.storage, { code: 'stale', reason }, now);
      await this.notifier.text(`⏸ Autopilot auto-paused: ${reason}. It resumes by itself when data is fresh again.`);
    } else if (!allFailed && ap?.code === 'stale') {
      clearAutoPause(this.storage);
      await this.notifier.text('▶️ Market data is fresh again. Autopilot resumed.');
    }
    if (this.storage.kvGet('market_incident')) {
      const st = await this.riskFacts.marketStatus();
      if (st === 'up') {
        this.storage.kvDel('market_incident');
        await this.notifier.text('✅ Getgems reports "up" again. Autopilot resumed.');
      }
    }
    await this.#balanceCheck(now);
    for (const card of this.shadow.dueCards(now)) {
      const text = formatHindsight(card.rule, card.summary, {
        collectionName: this.names[card.rule.collection],
        ageH: card.ageH,
        snipedWindowSec: this.cfg.snipedWindowSec,
        envLocked: this.settings.envLocked,
        currency: this.cfg.currencyLabel,
      });
      const kb = new InlineKeyboard().text('Go live', `shlive:${card.rule.id}`).text('Keep testing 24h', `shkeep:${card.rule.id}`).text('Delete', `shdel:${card.rule.id}`);
      await this.notifier.text(text, { reply_markup: kb });
      this.shadow.markCardSent(card.rule.id, now);
    }
    await this.#daily(now);
  }

  /** Live only: auto-pause on a wallet drop not explained by our own logged buys. */
  async #balanceCheck(now) {
    if (this.settings.dryRun || !this.buyer?.wallet) return;
    try {
      const ton = Number(await this.buyer.wallet.balanceNano()) / 1e9;
      const base = this.storage.kvJson('balance_baseline');
      if (!base || now - base.at > DAY_MS) {
        this.storage.kvSet('balance_baseline', { at: now, ton });
        return;
      }
      const own = this.storage
        .buysSince(base.at)
        .filter((b) => b.mode === 'live' && ['pending', 'sent'].includes(b.status))
        .reduce((s, b) => s + (b.totalTon ?? b.allInTon ?? b.priceTon), 0);
      const r = unexplainedDrop({ baselineTon: base.ton, currentTon: ton, ownSpentTon: own, pct: this.cfg.autoPauseBalanceDropPct });
      if (r.trip && !autoPauseState(this.storage)) {
        setAutoPause(this.storage, { code: 'balance', reason: `wallet dropped ${r.unexplained.toFixed(2)} TON beyond the bot's own buys` }, now);
        await this.notifier.text(`⏸ Autopilot auto-paused: the hot wallet lost ${r.unexplained.toFixed(2)} TON that the bot did not spend. Check the wallet, then /resume.`);
      }
    } catch (e) {
      log.debug('balance check failed:', e.message);
    }
  }

  async #daily(now) {
    const local = tzParts(now, Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (this.cfg.digestAt) {
      const t = tzParts(now, this.cfg.digestTz);
      if (t.hhmm >= this.cfg.digestAt && this.storage.kvGet('digest_sent') !== t.date) {
        this.storage.kvSet('digest_sent', t.date);
        const d = buildDigest({ storage: this.storage, settings: this.settings, cfg: this.cfg, now });
        const kb = new InlineKeyboard();
        for (const h of d.hints.filter((x) => x.canRaise).slice(0, 2)) kb.text(`Raise to ${h.suggest}`, `tune:${h.param}:${h.suggest}`).text('Keep', 'cancel').row();
        await this.notifier.text(d.text, kb.inline_keyboard.length ? { reply_markup: kb } : {});
      }
    }
    if (this.cfg.paperReportHour >= 0 && this.settings.dryRun && local.hour >= this.cfg.paperReportHour && this.storage.kvGet('paper_report_sent') !== local.date) {
      this.storage.kvSet('paper_report_sent', local.date);
      const sb = scoreboardFromStorage(this.storage, now);
      await this.notifier.text(`${formatScoreboard(sb, { currency: this.cfg.currencyLabel })}\n${readiness(sb, this.cfg).text}`);
    }
    if (this.portfolio && this.cfg.portfolioDailyHour >= 0 && local.hour >= this.cfg.portfolioDailyHour && this.storage.kvGet('portfolio_daily_sent') !== local.date) {
      this.storage.kvSet('portfolio_daily_sent', local.date);
      await this.portfolio.daily(now, this.notifier);
    }
  }

  /** Loop until stop(). */
  async run() {
    this.startedAt = this.clock();
    while (!this.stopped) {
      await this.cycle();
      const waitMs = this.settings.get('poll_interval') * 1000;
      await new Promise((resolve) => {
        this.wake = resolve;
        this.timer = setTimeout(resolve, waitMs);
      });
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.wake?.();
  }
}
