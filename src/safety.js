// One safety envelope, same commands and keys in every sibling bot:
//  /panic (persisted kv flag, forces practice, cancels pending confirmations, /resume + confirm),
//  auto-pause (consecutive executor errors, unexplained wallet balance drop, stale data),
//  doctor (PASS/WARN/FAIL self-check with a fix hint per item), /safety and /preset.

import { fmtTon } from './models.js';
import { ACTIVE_BUY_STATUSES } from './storage.js';
import { liveLibsInstalled } from './wallet.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---- auto-pause (kv 'auto_pause' = {code, reason, at})
export function autoPauseState(storage) {
  const v = storage.kvJson('auto_pause');
  return v && typeof v === 'object' ? v : null;
}

export function setAutoPause(storage, { code, reason }, now = Date.now()) {
  storage.kvSet('auto_pause', { code, reason, at: now });
}

export function clearAutoPause(storage) {
  storage.kvDel('auto_pause');
  storage.kvDel('exec_errors');
}

/**
 * Count consecutive live executor errors. Returns true when AUTO_PAUSE_ERRORS is reached.
 */
export function noteExecutorResult(storage, ok, cfg) {
  if (ok) {
    storage.kvDel('exec_errors');
    return false;
  }
  const n = Number(storage.kvGet('exec_errors') || 0) + 1;
  storage.kvSet('exec_errors', String(n));
  return n >= cfg.autoPauseErrors;
}

/** Wallet drop not explained by the bot's own logged buys. */
export function unexplainedDrop({ baselineTon, currentTon, ownSpentTon, pct }) {
  const drop = baselineTon - currentTon;
  const unexplained = drop - ownSpentTon;
  const trip = baselineTon > 0 && unexplained > (baselineTon * pct) / 100;
  return { drop, unexplained, trip };
}

/** Primary data older than STALE_DATA_SEC? */
export function isStale(lastOkAt, now, staleSec) {
  if (!lastOkAt) return false;
  return now - lastOkAt > staleSec * 1000;
}

// ---- presets
/** Fractions of the .env ceilings; values can never exceed .env. */
export const PRESETS = {
  careful: { max_price: 0.25, daily_budget: 0.2, max_buys_per_hour: 1, discount_pct: 35 },
  normal: { max_price: 0.5, daily_budget: 0.5, max_buys_per_hour: 2, discount_pct: 25 },
  bold: { max_price: 1, daily_budget: 1, max_buys_per_hour: null, discount_pct: 20 },
};

/**
 * Before/after diff of a preset. Spending limits are fractions of the .env ceilings.
 * @returns {{ok:true, changes:{param:string, from:number, to:number}[]} | {ok:false, error:string}}
 */
export function presetDiff(name, settings) {
  const p = PRESETS[String(name || '').toLowerCase()];
  if (!p) return { ok: false, error: `Unknown preset. Use: ${Object.keys(PRESETS).join(' | ')}` };
  const cfg = settings.cfg;
  const target = {
    max_price: Math.round(cfg.maxPriceTon * p.max_price * 100) / 100,
    daily_budget: Math.round(cfg.dailyBudgetTon * p.daily_budget * 100) / 100,
    max_buys_per_hour: p.max_buys_per_hour === null ? cfg.maxBuysPerHour : Math.min(p.max_buys_per_hour, cfg.maxBuysPerHour),
    discount_pct: p.discount_pct,
  };
  const changes = Object.entries(target)
    .map(([param, to]) => ({ param, from: settings.get(param), to }))
    .filter((c) => c.from !== c.to);
  return { ok: true, changes };
}

export function applyPreset(settings, changes) {
  return changes.map((c) => ({ ...c, result: settings.set(c.param, c.to) }));
}

export function formatPresetDiff(name, changes) {
  if (!changes.length) return `Preset "${name}" matches your current settings.`;
  return [`Preset "${name}" would change:`, ...changes.map((c) => `• ${c.param}: ${c.from} → ${c.to}`)].join('\n');
}

// ---- /safety
export function spendStats(storage, settings, now = Date.now()) {
  const mode = settings.dryRun ? 'dry' : 'live';
  const active = storage
    .buysSince(now - DAY)
    .filter((b) => b.mode === mode && ACTIVE_BUY_STATUSES.includes(b.status) && b.outcome !== 'lost_race');
  return {
    mode,
    spentDay: active.reduce((s, b) => s + (b.allInTon ?? b.priceTon), 0),
    buysHour: active.filter((b) => b.createdAt >= now - HOUR).length,
    spentHour: active.filter((b) => b.createdAt >= now - HOUR).reduce((s, b) => s + (b.allInTon ?? b.priceTon), 0),
  };
}

const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);

export function safetyText({ cfg, settings, storage, now = Date.now() }) {
  const lim = settings.limits(now);
  const ramp = settings.ramp(now);
  const s = spendStats(storage, settings, now);
  const ap = autoPauseState(storage);
  const cur = cfg.currencyLabel || 'TON';
  const lines = [
    `<b>Mode:</b> ${settings.dryRun ? 'PRACTICE' : 'LIVE'}${settings.envLocked ? ' (DRY_RUN=true in .env: hard lock)' : ''}`,
    `<b>Panic:</b> ${settings.panic ? `ON since ${hhmm(settings.panicAt() || now)} (/resume + confirm)` : 'off'}`,
    `<b>Auto-pause:</b> ${ap ? `ON: ${ap.reason}` : 'off'}`,
    `<b>Limits (all-in):</b> max ${fmtTon(lim.maxPriceTon)} ${cur}/buy · ${fmtTon(lim.dailyBudgetTon)} ${cur} per 24h${ramp.active ? ` (ramp ${ramp.pct}% until ${hhmm(ramp.untilMs)})` : ''} · ${lim.maxBuysPerHour} buys/h · live buys above ${fmtTon(lim.confirmAboveTon)} ${cur} need your confirmation`,
    `<b>Spent (${s.mode === 'dry' ? 'practice' : 'live'}):</b> ${fmtTon(s.spentDay)}/${fmtTon(lim.dailyBudgetTon)} ${cur} in 24h · ${fmtTon(s.spentHour)} ${cur} and ${s.buysHour}/${lim.maxBuysPerHour} buys this hour`,
    `<b>Live gate:</b> .env DRY_RUN=${cfg.dryRun ? 'true (locked)' : 'false'} · bot confirmation ${settings.liveSince() ? `given ${hhmm(settings.liveSince())}` : 'not given'} · ramp ${ramp.active ? `${ramp.pct}% until ${hhmm(ramp.untilMs)}` : 'off'}${cfg.goliveRequirePaper ? ' · paper results required' : ''}`,
    `<b>Autobuy filter:</b> confidence ≥ ${cfg.autobuyMinConfidence} · only 🟢${cfg.autobuyAllowWarn.length ? ` (+ allowed warnings: ${cfg.autobuyAllowWarn.join(', ')})` : ''}`,
  ];
  return lines.join('\n');
}

// ---- doctor
/**
 * The same Telegram checks `run` makes before it starts: ADMIN_IDS with BOT_TOKEN, and getMe.
 * @param {{getMe: () => Promise<{username?:string}>}|null} telegram  grammY Api (or a fake)
 */
async function telegramCheck(cfg, telegram, add) {
  if (!cfg.botToken) {
    add('telegram', 'WARN', 'BOT_TOKEN is not set: `run` prints alerts to stdout and the bot does not start', 'create a bot with @BotFather and put its token in BOT_TOKEN');
    return;
  }
  if (!cfg.adminIds?.length) {
    add('telegram', 'FAIL', 'BOT_TOKEN is set but ADMIN_IDS is empty: `run` refuses to start', 'put your numeric Telegram ID (ask @userinfobot) in ADMIN_IDS');
    return;
  }
  try {
    const api = telegram || new (await import('grammy')).Api(cfg.botToken);
    const me = await api.getMe();
    add('telegram', 'PASS', `bot @${me?.username || '?'} · ${cfg.adminIds.length} admin ID${cfg.adminIds.length === 1 ? '' : 's'}`);
  } catch (e) {
    const code = e?.error_code ?? e?.status;
    if (code === 401 || code === 404) add('telegram', 'FAIL', `BOT_TOKEN was rejected by Telegram (${e.description || e.message})`, 'copy the token again from @BotFather');
    else add('telegram', 'FAIL', `Telegram unreachable: ${e.description || e.message}`, 'check network access to api.telegram.org');
  }
}

/**
 * @param {Object} o
 * @param {{getMe: Function}|null} [o.telegram]  Bot API for the getMe check (default: a grammY Api)
 * @param {() => boolean} [o.liveLibs]  are the optional wallet packages installed?
 * @returns {Promise<{item:string, status:'PASS'|'WARN'|'FAIL', detail:string, hint?:string}[]>}
 */
export async function runDoctor({ cfg, settings, storage, client, wallet = null, telegram = null, liveLibs = liveLibsInstalled, now = Date.now() }) {
  const out = [];
  const add = (item, status, detail, hint) => out.push({ item, status, detail, hint });

  add('config', 'PASS', `valid (${Object.keys(cfg).length} settings loaded)`);
  if (client.name === 'mock') add('telegram', 'PASS', 'offline mock: no Telegram calls');
  else await telegramCheck(cfg, telegram, add);

  if (settings.panic) add('mode', 'WARN', 'PANIC is on: buying stopped, practice forced', 'review, then /resume and confirm');
  else if (settings.dryRun) {
    add('mode', 'WARN', `PRACTICE${settings.envLocked ? ' (DRY_RUN=true in .env)' : ' (live not confirmed)'}: no TON is spent`, 'go live only after /scoreboard looks good: DRY_RUN=false, then /dry off');
  } else add('mode', 'PASS', 'LIVE (confirmed in the bot)');

  const optional = { GETGEMS_API_KEY: cfg.getgemsApiKey, TONAPI_KEY: cfg.tonapiKey, ANTHROPIC_API_KEY: cfg.anthropicApiKey, PEER_FLOORS: cfg.peerFloors?.length ? 'x' : '' };
  const present = Object.entries(optional).filter(([, v]) => v).map(([k]) => k);
  add('optional keys', 'PASS', present.length ? `present: ${present.join(', ')}` : 'none set (all optional)');

  if (client.name === 'mock') add('credentials', 'PASS', 'mock data source needs no credentials');
  else if (client.name === 'getgems') add('credentials', cfg.getgemsApiKey ? 'PASS' : 'FAIL', cfg.getgemsApiKey ? 'GETGEMS_API_KEY set' : 'GETGEMS_API_KEY missing', 'get a key at https://getgems.io/public-api');
  else add('credentials', 'PASS', `no paid key needed: free TonAPI source${cfg.tonapiKey ? ' (TONAPI_KEY set)' : ' (anonymous tier, ~1 rps)'}; open bids need GETGEMS_API_KEY (optional, paid)`);
  const src = client.salesSource?.() ?? null;
  if (src) add('sales source', 'PASS', src.label);
  if (!cfg.dryRun) {
    // Live is possible: it needs the wallet words and the optional wallet packages. A FAIL in
    // live mode, a WARN while live is not confirmed yet (/dry off refuses until both are there).
    const level = settings.dryRun ? 'WARN' : 'FAIL';
    if (!cfg.walletMnemonic) add('wallet', level, 'WALLET_MNEMONIC is not set: live buys cannot be signed', 'set WALLET_MNEMONIC (a fresh hot wallet), or keep DRY_RUN=true');
    else if (!liveLibs()) {
      add('wallet', level, 'the optional wallet packages @ton/ton, @ton/core and @ton/crypto are not installed', 'npm install @ton/ton @ton/core @ton/crypto');
    } else add('wallet', 'PASS', 'WALLET_MNEMONIC set, wallet packages installed');
  }

  let serverTime = null;
  try {
    if (typeof client.getServerStatus === 'function') {
      const st = await client.getServerStatus();
      if (!st) add('api', 'WARN', `${client.name}: status unknown`);
      else {
        serverTime = st.time ? Date.parse(st.time) : null; // HTTP Date + Age, not the cached body
        add('api', st.status === 'up' ? 'PASS' : st.status === 'warn' ? 'WARN' : 'FAIL', `Getgems status "${st.status}" via ${client.name}`, st.status === 'up' ? undefined : 'autopilot holds buys until Getgems is up');
      }
    } else {
      await client.listGiftCollections();
      add('api', 'PASS', `${client.name} reachable`);
    }
  } catch (e) {
    add('api', 'FAIL', `${client.name} unreachable: ${e.message}`, 'check network, API base URL and key');
  }

  try {
    storage.kvSet('doctor_probe', String(now));
    if (storage.kvGet('doctor_probe') !== String(now)) throw new Error('read-back mismatch');
    add('database', 'PASS', 'writable');
  } catch (e) {
    add('database', 'FAIL', `not writable: ${e.message}`, 'check DB_PATH and disk space');
  }

  if (Number.isFinite(serverTime)) {
    const skew = Math.abs(now - serverTime) / 1000;
    add('clock', skew < 30 ? 'PASS' : skew < 120 ? 'WARN' : 'FAIL', `skew ${skew.toFixed(1)}s vs Getgems`, skew < 30 ? undefined : 'sync the system clock (NTP)');
  } else add('clock', 'WARN', 'skew not measured (no server time)', 'run with network access to api.getgems.io');

  const lim = settings.limits(now);
  const above = settings.overridesAboveCeiling?.() ?? [];
  if (lim.maxPriceTon > lim.dailyBudgetTon) add('limits', 'FAIL', `MAX_PRICE_TON ${lim.maxPriceTon} > daily budget ${lim.dailyBudgetTon}`, 'lower MAX_PRICE_TON or raise DAILY_BUDGET_TON');
  else if (above.length) {
    add(
      'limits',
      'WARN',
      `stored ${above.map((o) => `${o.name}=${o.stored}`).join(', ')} above .env (${above.map((o) => o.ceiling).join(', ')}); the .env value applies`,
      `/set ${above[0].name} default (or a lower value) to clear it`,
    );
  } else add('limits', 'PASS', `max ${lim.maxPriceTon} ≤ daily ${lim.dailyBudgetTon} TON, ${lim.maxBuysPerHour}/h`);

  if (!settings.dryRun) {
    if (!wallet) add('hot wallet', 'WARN', 'not loaded yet', 'it loads on the first live buy');
    else {
      try {
        const bal = Number(await wallet.balanceNano()) / 1e9;
        if (bal < lim.dailyBudgetTon) add('hot wallet', 'WARN', `balance ${bal.toFixed(2)} < daily budget ${lim.dailyBudgetTon}`, 'top up or lower DAILY_BUDGET_TON');
        else if (bal > cfg.hotWalletWarnX * cfg.dailyBudgetTon) add('hot wallet', 'WARN', `balance ${bal.toFixed(2)} > ${cfg.hotWalletWarnX}× daily budget`, 'keep only what the bot needs in the hot wallet');
        else add('hot wallet', 'PASS', `balance ${bal.toFixed(2)} TON`);
      } catch (e) {
        add('hot wallet', 'FAIL', `balance check failed: ${e.message}`, 'check TON_RPC_ENDPOINT');
      }
    }
  }
  return out;
}

export function formatDoctor(results) {
  const lines = results.map((r) => `${r.status.padEnd(4)}  ${r.item.padEnd(13)} ${r.detail}${r.hint && r.status !== 'PASS' ? `\n      fix: ${r.hint}` : ''}`);
  const exitCode = results.some((r) => r.status === 'FAIL') ? 1 : 0;
  return { text: lines.join('\n'), exitCode };
}
