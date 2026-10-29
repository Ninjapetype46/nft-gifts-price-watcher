// SQLite storage on built-in node:sqlite (DatabaseSync). Loaded with dynamic import so the
// ExperimentalWarning filter in index.js is installed first.

import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS watchlist (
  collection TEXT PRIMARY KEY, name TEXT, is_gift INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS autobuy_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, max_price_ton REAL NOT NULL,
  min_discount_pct REAL NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nft TEXT NOT NULL, collection TEXT NOT NULL,
  price_nano TEXT NOT NULL, reasons TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_nft ON alerts(nft, price_nano, created_at);
CREATE TABLE IF NOT EXISTS buys (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nft TEXT NOT NULL, collection TEXT NOT NULL, name TEXT,
  price_ton REAL NOT NULL, total_ton REAL, mode TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL,
  rule_id INTEGER, alert_id INTEGER, tx_ref TEXT, error TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS buys_time ON buys(created_at);
CREATE TABLE IF NOT EXISTS sales (
  tx_hash TEXT PRIMARY KEY, collection TEXT NOT NULL, nft TEXT NOT NULL, name TEXT,
  price_ton REAL NOT NULL, time_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sales_coll_time ON sales(collection, time_ms);
CREATE TABLE IF NOT EXISTS nft_attrs (
  nft TEXT PRIMARY KEY, collection TEXT, name TEXT, attrs TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, mode TEXT, event_id TEXT,
  alert_id INTEGER, buy_id INTEGER, nft TEXT, collection TEXT, title TEXT, code TEXT, verdict TEXT,
  text TEXT, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_alert ON decisions(alert_id);
CREATE INDEX IF NOT EXISTS decisions_nft ON decisions(nft, ts);
CREATE INDEX IF NOT EXISTS decisions_event ON decisions(event_id);
CREATE TABLE IF NOT EXISTS muted (
  subject TEXT PRIMARY KEY, label TEXT, until INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shadow_fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT, rule_id INTEGER, subject_ref TEXT NOT NULL, ts INTEGER NOT NULL,
  entry_price REAL NOT NULL, entry_costs REAL NOT NULL DEFAULT 0, executable_price REAL, mark_price REAL,
  mark_ts INTEGER, mark_source TEXT, outcome TEXT NOT NULL DEFAULT 'open', meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS shadow_rule ON shadow_fills(rule_id, subject_ref);
CREATE TABLE IF NOT EXISTS portfolio_addresses (
  user_id INTEGER NOT NULL, address TEXT NOT NULL, label TEXT, added_at INTEGER NOT NULL, PRIMARY KEY(user_id, address)
);
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, source TEXT NOT NULL, taken_at INTEGER NOT NULL,
  total_ton REAL, items_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS portfolio_snap_src ON portfolio_snapshots(user_id, source, taken_at);
`;

/** Columns added after the first release; applied to old databases in place (no data loss). */
export const MIGRATIONS = {
  sales: {
    old_owner: 'TEXT',
    new_owner: 'TEXT',
    reject_top: 'INTEGER NOT NULL DEFAULT 0',
  },
  autobuy_rules: {
    min_edge_ton: 'REAL',
    min_edge_pct: 'REAL',
    max_eta_days: 'REAL',
    require_bid: 'INTEGER DEFAULT 0',
    cross_check: 'INTEGER DEFAULT 1',
    state: "TEXT NOT NULL DEFAULT 'shadow' CHECK(state IN ('shadow','live','paused'))",
    promoted_at: 'INTEGER',
  },
  buys: {
    fair_ton: 'REAL',
    confidence: 'TEXT',
    all_in_ton: 'REAL',
    edge_ton: 'REAL',
    risk_level: 'TEXT',
    reason_code: 'TEXT',
    outcome: 'TEXT',
    outcome_at: 'INTEGER',
    mark_ton: 'REAL',
    mark_cons_ton: 'REAL',
    marked_at: 'INTEGER',
  },
};

const RULE_STATES = ['shadow', 'live', 'paused'];

/** Buy statuses that count towards limits and block re-buying the same NFT. */
export const ACTIVE_BUY_STATUSES = ['dry', 'pending', 'sent'];

export class Storage {
  /** @param {import('node:sqlite').DatabaseSync} db */
  constructor(db) {
    this.db = db;
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Add missing columns with ALTER TABLE (PRAGMA table_info decides what is missing).
   * @param {string} table
   * @param {Record<string,string>} cols  column -> SQL type/default
   * @returns {string[]} added columns
   */
  ensureColumns(table, cols) {
    const have = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
    const added = [];
    for (const [col, def] of Object.entries(cols)) {
      if (have.has(col)) continue;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      added.push(col);
    }
    return added;
  }

  migrate() {
    for (const [table, cols] of Object.entries(MIGRATIONS)) {
      const added = this.ensureColumns(table, cols);
      // Rules that existed before shadow mode keep buying as before.
      if (table === 'autobuy_rules' && added.includes('state')) this.db.exec("UPDATE autobuy_rules SET state = 'live'");
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS sales_nft_time ON sales(nft, time_ms)');
  }

  // ---- kv (persisted flags such as panic)
  kvGet(key) {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return row ? row.value : null;
  }
  kvSet(key, value) {
    this.db
      .prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  kvDel(key) {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }
  kvJson(key) {
    const v = this.kvGet(key);
    if (v === null) return null;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }

  close() {
    this.db.close();
  }

  // ---- settings
  getSetting(key) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  }
  setSetting(key, value) {
    this.db
      .prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }
  deleteSetting(key) {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
  allSettings() {
    return Object.fromEntries(this.db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
  }

  // ---- watchlist
  watch(collection, { name = null, isGift = false } = {}) {
    this.db
      .prepare(
        `INSERT INTO watchlist(collection, name, is_gift, added_at) VALUES(?, ?, ?, ?)
         ON CONFLICT(collection) DO UPDATE SET name = COALESCE(excluded.name, watchlist.name),
           is_gift = MAX(watchlist.is_gift, excluded.is_gift)`,
      )
      .run(collection, name, isGift ? 1 : 0, Date.now());
  }
  unwatch(collection) {
    return this.db.prepare('DELETE FROM watchlist WHERE collection = ?').run(collection).changes > 0;
  }
  setCollectionMeta(collection, { name, isGift }) {
    this.db
      .prepare('UPDATE watchlist SET name = COALESCE(?, name), is_gift = MAX(is_gift, ?) WHERE collection = ?')
      .run(name ?? null, isGift ? 1 : 0, collection);
  }
  listWatch() {
    return this.db
      .prepare('SELECT collection, name, is_gift, added_at FROM watchlist ORDER BY added_at, rowid')
      .all()
      .map((r) => ({ collection: r.collection, name: r.name, isGift: !!r.is_gift, addedAt: r.added_at }));
  }

  // ---- autobuy rules
  /** state defaults to 'live' here; the bot passes 'shadow' for new rules when SHADOW_NEW_RULES=true. */
  addRule({ collection, maxPriceTon, minDiscountPct, minEdgeTon = null, minEdgePct = null, maxEtaDays = null, requireBid = false, crossCheck = true, state = 'live', createdAt = Date.now() }) {
    if (!RULE_STATES.includes(state)) throw new Error(`bad rule state ${state}`);
    const r = this.db
      .prepare(
        `INSERT INTO autobuy_rules(collection, max_price_ton, min_discount_pct, enabled, created_at, min_edge_ton, min_edge_pct,
           max_eta_days, require_bid, cross_check, state) VALUES(?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(collection, maxPriceTon, minDiscountPct, createdAt, minEdgeTon, minEdgePct, maxEtaDays, requireBid ? 1 : 0, crossCheck ? 1 : 0, state);
    return Number(r.lastInsertRowid);
  }
  getRule(id) {
    return this.listRules().find((r) => r.id === id) || null;
  }
  /** Only shadow.js (promote / pause) changes rule state. */
  setRuleState(id, state, now = Date.now()) {
    if (!RULE_STATES.includes(state)) throw new Error(`bad rule state ${state}`);
    return (
      this.db
        .prepare('UPDATE autobuy_rules SET state = ?, promoted_at = CASE WHEN ? = \'live\' THEN ? ELSE promoted_at END WHERE id = ?')
        .run(state, state, now, id).changes > 0
    );
  }
  deleteRule(id) {
    return this.db.prepare('DELETE FROM autobuy_rules WHERE id = ?').run(id).changes > 0;
  }
  listRules() {
    return this.db
      .prepare('SELECT * FROM autobuy_rules ORDER BY id')
      .all()
      .map((r) => ({
        id: r.id,
        collection: r.collection,
        maxPriceTon: r.max_price_ton,
        minDiscountPct: r.min_discount_pct,
        enabled: !!r.enabled,
        createdAt: r.created_at,
        minEdgeTon: r.min_edge_ton,
        minEdgePct: r.min_edge_pct,
        maxEtaDays: r.max_eta_days,
        requireBid: !!r.require_bid,
        crossCheck: r.cross_check === null || r.cross_check === undefined ? true : !!r.cross_check,
        state: r.state || 'live',
        promotedAt: r.promoted_at,
      }));
  }

  // ---- alerts
  /** True if the same NFT at the same price was alerted after `sinceMs`. */
  wasAlerted(nft, priceNano, sinceMs) {
    return !!this.db
      .prepare('SELECT 1 FROM alerts WHERE nft = ? AND price_nano = ? AND created_at >= ? LIMIT 1')
      .get(nft, priceNano, sinceMs);
  }
  saveAlert(alert) {
    const l = alert.listing;
    const r = this.db
      .prepare('INSERT INTO alerts(nft, collection, price_nano, reasons, payload, created_at) VALUES(?, ?, ?, ?, ?, ?)')
      .run(l.nft, l.collection, l.priceNano, alert.reasons.map((x) => x.kind).join(','), JSON.stringify(alert), Date.now());
    return Number(r.lastInsertRowid);
  }
  getAlert(id) {
    const row = this.db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
    return row ? { id: row.id, createdAt: row.created_at, ...JSON.parse(row.payload) } : null;
  }
  countAlertsSince(sinceMs) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE created_at >= ?').get(sinceMs).n;
  }

  // ---- buys
  recordBuy(b) {
    const r = this.db
      .prepare(
        `INSERT INTO buys(nft, collection, name, price_ton, total_ton, mode, status, source, rule_id, alert_id, tx_ref, error, created_at,
           fair_ton, confidence, all_in_ton, edge_ton, risk_level, reason_code)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        b.nft,
        b.collection,
        b.name ?? null,
        b.priceTon,
        b.totalTon ?? null,
        b.mode,
        b.status,
        b.source,
        b.ruleId ?? null,
        b.alertId ?? null,
        b.txRef ?? null,
        b.error ?? null,
        b.createdAt ?? Date.now(),
        b.fairTon ?? null,
        b.confidence ?? null,
        b.allInTon ?? null,
        b.edgeTon ?? null,
        b.riskLevel ?? null,
        b.reasonCode ?? null,
      );
    return Number(r.lastInsertRowid);
  }
  updateBuy(id, { status, txRef, error, totalTon, reasonCode }) {
    this.db
      .prepare(
        'UPDATE buys SET status = COALESCE(?, status), tx_ref = COALESCE(?, tx_ref), error = COALESCE(?, error), total_ton = COALESCE(?, total_ton), reason_code = COALESCE(?, reason_code) WHERE id = ?',
      )
      .run(status ?? null, txRef ?? null, error ?? null, totalTon ?? null, reasonCode ?? null, id);
  }
  /** Paper outcome and marks (feature: paper scoreboard). */
  updateBuyMarks(id, { outcome, outcomeAt, markTon, markConsTon, markedAt }) {
    this.db
      .prepare(
        `UPDATE buys SET outcome = COALESCE(?, outcome), outcome_at = COALESCE(?, outcome_at), mark_ton = COALESCE(?, mark_ton),
           mark_cons_ton = COALESCE(?, mark_cons_ton), marked_at = COALESCE(?, marked_at) WHERE id = ?`,
      )
      .run(outcome ?? null, outcomeAt ?? null, markTon ?? null, markConsTon ?? null, markedAt ?? null, id);
  }
  getBuy(id) {
    const r = this.db.prepare('SELECT * FROM buys WHERE id = ?').get(id);
    return r ? rowToBuy(r) : null;
  }
  /** Held positions (paper "dry" or live "sent") of a collection created after sinceMs. */
  positions(collection, sinceMs) {
    return this.db
      .prepare("SELECT * FROM buys WHERE collection = ? AND created_at >= ? AND status IN ('dry', 'sent') ORDER BY id")
      .all(collection, sinceMs)
      .map(rowToBuy);
  }
  allBuys() {
    return this.db.prepare('SELECT * FROM buys ORDER BY id').all().map(rowToBuy);
  }
  listBuys(limit = 20) {
    return this.db.prepare('SELECT * FROM buys ORDER BY id DESC LIMIT ?').all(limit).map(rowToBuy);
  }
  buysSince(sinceMs) {
    return this.db.prepare('SELECT * FROM buys WHERE created_at >= ? ORDER BY id').all(sinceMs).map(rowToBuy);
  }
  hasActiveBuy(nft, mode) {
    const marks = ACTIVE_BUY_STATUSES.map(() => '?').join(',');
    return !!this.db
      .prepare(`SELECT 1 FROM buys WHERE nft = ? AND mode = ? AND status IN (${marks}) LIMIT 1`)
      .get(nft, mode, ...ACTIVE_BUY_STATUSES);
  }

  // ---- sales + attributes cache
  upsertSales(sales) {
    const st = this.db.prepare(
      'INSERT OR IGNORE INTO sales(tx_hash, collection, nft, name, price_ton, time_ms, old_owner, new_owner, reject_top) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    let n = 0;
    this.db.exec('BEGIN');
    try {
      for (const s of sales) {
        n += st.run(s.txHash, s.collection, s.nft, s.name ?? null, s.priceTon, s.timeMs, s.oldOwner ?? null, s.newOwner ?? null, s.rejectTop ? 1 : 0).changes;
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return n;
  }
  /** Sales joined with cached attributes. */
  getSales(collection, sinceMs) {
    return this.db
      .prepare(
        `SELECT s.*, a.attrs FROM sales s LEFT JOIN nft_attrs a ON a.nft = s.nft
         WHERE s.collection = ? AND s.time_ms >= ? ORDER BY s.time_ms DESC`,
      )
      .all(collection, sinceMs)
      .map((r) => ({
        txHash: r.tx_hash,
        collection: r.collection,
        nft: r.nft,
        name: r.name,
        priceTon: r.price_ton,
        timeMs: r.time_ms,
        attrs: r.attrs ? JSON.parse(r.attrs) : undefined,
        // Old rows have no owners: they count as unknown and are never treated as wash.
        oldOwner: r.old_owner ?? null,
        newOwner: r.new_owner ?? null,
        rejectTop: !!r.reject_top,
      }));
  }
  /** Earliest cached sold event of an NFT at or after sinceMs (no API call). */
  saleOf(nft, sinceMs) {
    const r = this.db.prepare('SELECT * FROM sales WHERE nft = ? AND time_ms >= ? ORDER BY time_ms ASC LIMIT 1').get(nft, sinceMs);
    return r ? { txHash: r.tx_hash, nft: r.nft, collection: r.collection, priceTon: r.price_ton, timeMs: r.time_ms, newOwner: r.new_owner ?? null } : null;
  }
  getAttrs(nft) {
    const r = this.db.prepare('SELECT attrs FROM nft_attrs WHERE nft = ?').get(nft);
    return r ? JSON.parse(r.attrs) : null;
  }
  latestSaleTime(collection) {
    const r = this.db.prepare('SELECT MAX(time_ms) AS t FROM sales WHERE collection = ?').get(collection);
    return r?.t ?? null;
  }
  nftsMissingAttrs(collection, sinceMs, limit = 500) {
    return this.db
      .prepare(
        `SELECT DISTINCT s.nft FROM sales s LEFT JOIN nft_attrs a ON a.nft = s.nft
         WHERE s.collection = ? AND s.time_ms >= ? AND a.nft IS NULL LIMIT ?`,
      )
      .all(collection, sinceMs, limit)
      .map((r) => r.nft);
  }
  upsertAttrs(items) {
    const st = this.db.prepare(
      `INSERT INTO nft_attrs(nft, collection, name, attrs, updated_at) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(nft) DO UPDATE SET attrs = excluded.attrs, name = excluded.name, updated_at = excluded.updated_at`,
    );
    for (const it of items) st.run(it.nft, it.collection ?? null, it.name ?? null, JSON.stringify(it.attrs || {}), Date.now());
  }

  // ---- decisions (every evaluation, so /why has data)
  addDecision(d) {
    const r = this.db
      .prepare(
        `INSERT INTO decisions(ts, kind, mode, event_id, alert_id, buy_id, nft, collection, title, code, verdict, text, payload)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(d.ts, d.kind, d.mode ?? null, d.eventId ?? null, d.alertId ?? null, d.buyId ?? null, d.nft ?? null, d.collection ?? null, d.title ?? null, d.code ?? null, d.verdict ?? null, d.text ?? '', JSON.stringify(d.payload ?? {}));
    return Number(r.lastInsertRowid);
  }
  /** Decision trail for an alert: its own rows plus later rows for the same NFT. */
  decisionsForAlert(alertId, nft = null, sinceMs = 0) {
    return this.db
      .prepare('SELECT * FROM decisions WHERE alert_id = ? OR (? IS NOT NULL AND nft = ? AND ts >= ?) ORDER BY id')
      .all(alertId, nft, nft, sinceMs)
      .map(rowToDecision);
  }
  decisionsForNft(nft, limit = 50) {
    return this.db.prepare('SELECT * FROM decisions WHERE nft = ? ORDER BY id DESC LIMIT ?').all(nft, limit).map(rowToDecision).reverse();
  }
  decisionByEvent(eventId) {
    const r = this.db.prepare('SELECT * FROM decisions WHERE event_id = ? ORDER BY id DESC LIMIT 1').get(eventId);
    return r ? rowToDecision(r) : null;
  }
  decisionsForBuy(buyId) {
    return this.db.prepare('SELECT * FROM decisions WHERE buy_id = ? ORDER BY id').all(buyId).map(rowToDecision);
  }
  decisionsSince(sinceMs) {
    return this.db.prepare('SELECT * FROM decisions WHERE ts >= ? ORDER BY id').all(sinceMs).map(rowToDecision);
  }

  // ---- muted subjects (collection or NFT raw address)
  mute(subject, untilMs, label = null) {
    this.db
      .prepare('INSERT INTO muted(subject, label, until, created_at) VALUES(?, ?, ?, ?) ON CONFLICT(subject) DO UPDATE SET until = excluded.until, label = COALESCE(excluded.label, muted.label)')
      .run(subject, label, untilMs, Date.now());
  }
  unmute(subject) {
    return this.db.prepare('DELETE FROM muted WHERE subject = ?').run(subject).changes > 0;
  }
  /** First active mute among subjects, or null. */
  mutedOf(subjects, now) {
    for (const s of subjects) {
      const r = this.db.prepare('SELECT * FROM muted WHERE subject = ? AND until > ?').get(s, now);
      if (r) return { subject: r.subject, label: r.label, until: r.until };
    }
    return null;
  }
  listMuted(now) {
    return this.db.prepare('SELECT * FROM muted WHERE until > ? ORDER BY until').all(now).map((r) => ({ subject: r.subject, label: r.label, until: r.until }));
  }

  // ---- shadow fills (shadow rules and limit-skipped items, marked each cycle)
  addShadowFill(f) {
    const r = this.db
      .prepare(
        `INSERT INTO shadow_fills(rule_id, subject_ref, ts, entry_price, entry_costs, executable_price, outcome, meta)
         VALUES(?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(f.ruleId ?? null, f.subjectRef, f.ts, f.entryPrice, f.entryCosts ?? 0, f.executablePrice ?? f.entryPrice, JSON.stringify(f.meta || {}));
    return Number(r.lastInsertRowid);
  }
  hasShadowFill(ruleId, subjectRef, skipCode = null) {
    const rows = this.db
      .prepare('SELECT meta FROM shadow_fills WHERE subject_ref = ? AND (rule_id IS ? OR rule_id = ?)')
      .all(subjectRef, ruleId, ruleId);
    return rows.some((r) => (skipCode === null ? true : JSON.parse(r.meta).skipCode === skipCode));
  }
  listShadowFills({ ruleId, collection, skipsOnly = false, sinceMs = 0 } = {}) {
    let rows = this.db.prepare('SELECT * FROM shadow_fills WHERE ts >= ? ORDER BY id').all(sinceMs).map(rowToFill);
    if (ruleId !== undefined) rows = rows.filter((f) => f.ruleId === ruleId);
    if (skipsOnly) rows = rows.filter((f) => f.ruleId === null && f.meta.skipCode);
    if (collection) rows = rows.filter((f) => f.meta.collection === collection);
    return rows;
  }
  updateShadowFill(id, { markPrice, markTs, markSource, outcome, meta }) {
    this.db
      .prepare(
        'UPDATE shadow_fills SET mark_price = COALESCE(?, mark_price), mark_ts = COALESCE(?, mark_ts), mark_source = COALESCE(?, mark_source), outcome = COALESCE(?, outcome), meta = COALESCE(?, meta) WHERE id = ?',
      )
      .run(markPrice ?? null, markTs ?? null, markSource ?? null, outcome ?? null, meta ? JSON.stringify(meta) : null, id);
  }
  deleteShadowFills(ruleId) {
    this.db.prepare('DELETE FROM shadow_fills WHERE rule_id = ?').run(ruleId);
  }

  // ---- portfolio (only public addresses and aggregate snapshots are stored)
  addPortfolioAddress(userId, address, label = null) {
    this.db
      .prepare('INSERT INTO portfolio_addresses(user_id, address, label, added_at) VALUES(?, ?, ?, ?) ON CONFLICT(user_id, address) DO UPDATE SET label = COALESCE(excluded.label, label)')
      .run(userId, address, label, Date.now());
  }
  listPortfolioAddresses(userId = null) {
    const rows = userId === null ? this.db.prepare('SELECT * FROM portfolio_addresses').all() : this.db.prepare('SELECT * FROM portfolio_addresses WHERE user_id = ?').all(userId);
    return rows.map((r) => ({ userId: r.user_id, address: r.address, label: r.label, addedAt: r.added_at }));
  }
  /** /forget: delete stored addresses and snapshots of a user. */
  forgetPortfolio(userId) {
    const a = this.db.prepare('DELETE FROM portfolio_addresses WHERE user_id = ?').run(userId).changes;
    const s = this.db.prepare('DELETE FROM portfolio_snapshots WHERE user_id = ?').run(userId).changes;
    return { addresses: a, snapshots: s };
  }
  /** Store a snapshot and keep only the last `keep` per (user, source). */
  addSnapshot(userId, source, totalTon, items, takenAt = Date.now(), keep = 30) {
    const r = this.db
      .prepare('INSERT INTO portfolio_snapshots(user_id, source, taken_at, total_ton, items_json) VALUES(?, ?, ?, ?, ?)')
      .run(userId, source, takenAt, totalTon, JSON.stringify(items));
    this.db
      .prepare(
        `DELETE FROM portfolio_snapshots WHERE user_id = ? AND source = ? AND id NOT IN
           (SELECT id FROM portfolio_snapshots WHERE user_id = ? AND source = ? ORDER BY taken_at DESC, id DESC LIMIT ?)`,
      )
      .run(userId, source, userId, source, keep);
    return Number(r.lastInsertRowid);
  }
  getSnapshot(id) {
    const r = this.db.prepare('SELECT * FROM portfolio_snapshots WHERE id = ?').get(id);
    return r ? rowToSnapshot(r) : null;
  }
  /** Latest snapshot of a source taken before `beforeMs`. */
  lastSnapshot(userId, source, beforeMs = Number.MAX_SAFE_INTEGER) {
    const r = this.db
      .prepare('SELECT * FROM portfolio_snapshots WHERE user_id = ? AND source = ? AND taken_at < ? ORDER BY taken_at DESC, id DESC LIMIT 1')
      .get(userId, source, beforeMs);
    return r ? rowToSnapshot(r) : null;
  }
  countSnapshots(userId, source) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM portfolio_snapshots WHERE user_id = ? AND source = ?').get(userId, source).n;
  }
}

function rowToDecision(r) {
  return {
    id: r.id,
    ts: r.ts,
    kind: r.kind,
    mode: r.mode,
    eventId: r.event_id,
    alertId: r.alert_id,
    buyId: r.buy_id,
    nft: r.nft,
    collection: r.collection,
    title: r.title,
    code: r.code,
    verdict: r.verdict,
    text: r.text,
    payload: JSON.parse(r.payload),
  };
}

function rowToFill(r) {
  return {
    id: r.id,
    ruleId: r.rule_id,
    subjectRef: r.subject_ref,
    ts: r.ts,
    entryPrice: r.entry_price,
    entryCosts: r.entry_costs,
    executablePrice: r.executable_price,
    markPrice: r.mark_price,
    markTs: r.mark_ts,
    markSource: r.mark_source,
    outcome: r.outcome,
    meta: JSON.parse(r.meta || '{}'),
  };
}

function rowToSnapshot(r) {
  return { id: r.id, userId: r.user_id, source: r.source, takenAt: r.taken_at, totalTon: r.total_ton, items: JSON.parse(r.items_json) };
}

function rowToBuy(r) {
  return {
    id: r.id,
    nft: r.nft,
    collection: r.collection,
    name: r.name,
    priceTon: r.price_ton,
    totalTon: r.total_ton,
    mode: r.mode,
    status: r.status,
    source: r.source,
    ruleId: r.rule_id,
    alertId: r.alert_id,
    txRef: r.tx_ref,
    error: r.error,
    createdAt: r.created_at,
    fairTon: r.fair_ton ?? null,
    confidence: r.confidence ?? null,
    allInTon: r.all_in_ton ?? null,
    edgeTon: r.edge_ton ?? null,
    riskLevel: r.risk_level ?? null,
    reasonCode: r.reason_code ?? null,
    outcome: r.outcome ?? null,
    outcomeAt: r.outcome_at ?? null,
    markTon: r.mark_ton ?? null,
    markConsTon: r.mark_cons_ton ?? null,
    markedAt: r.marked_at ?? null,
  };
}

/**
 * @param {string} dbPath file path or ":memory:"
 * @returns {Promise<Storage>}
 */
export async function openStorage(dbPath) {
  const { DatabaseSync } = await import('node:sqlite');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return new Storage(new DatabaseSync(dbPath));
}
