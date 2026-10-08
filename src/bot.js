// Telegram bot (grammY). All commands and buttons are restricted to ADMIN_IDS.

import { Bot, InlineKeyboard } from 'grammy';
import { parseAutobuyAdd, resolveCollection, commandArgs, describeRule } from './commands.js';
import { parseBool } from './settings.js';
import { escapeHtml, formatComps, formatPreview } from './format.js';
import { fmtTon, getgemsCollectionUrl, plural } from './models.js';
import { liveLibsInstalled } from './wallet.js';
import { isAddress, toRaw, shortAddr } from './address.js';
import { scoreboardFromStorage, buildDigest } from './engine.js';
import { formatScoreboard, readiness } from './paper.js';
import { safetyText, runDoctor, formatDoctor, presetDiff, applyPreset, formatPresetDiff, autoPauseState, clearAutoPause } from './safety.js';
import { Shadow } from './shadow.js';
import { whyTrail, alertIdFromText } from './why.js';
import { explainMore } from './explain.js';
import { formatCompare, readPeers, loadAliases } from './peers.js';
import { PortfolioService, TelegramGiftsSource, PROFILE_SOURCE } from './holdings.js';
import { createLogger } from './logger.js';

const log = createLogger('bot');
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** A confirm button (Confirm buy, "Yes, spend real TON", "Yes, resume") older than this is refused. */
export const CONFIRM_TTL_MS = 15 * 60_000;
const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);

export const SEED_WARNING = 'This bot never asks for your seed phrase. Nobody needs your wallet words for a migration or verification.';

const INTRO = '<b>Getgems checker</b> — deal alerts that explain themselves: honest price from real sales, profit after every fee, and a safety light before Buy.';

/** One line on the current mode, for /start and /help. */
function modeLine(settings) {
  if (settings.panic) return '🛑 <b>PANIC</b>: all buying is stopped and practice mode is forced. /resume when ready.';
  if (settings.dryRun) return '🧪 Mode: <b>PRACTICE</b>. Buys are on paper; no TON is spent.';
  return '💸 Mode: <b>LIVE</b>. Buys spend real TON from your wallet. /panic stops everything.';
}

/** /start: what the bot is, the current mode, and three commands to try first. */
function startText(settings) {
  return [
    INTRO,
    '',
    modeLine(settings),
    '',
    '<b>Try these first:</b>',
    '1. /mygifts — what the gifts on your profile are worth',
    '2. /watch &lt;collection address&gt; — deal alerts for a collection',
    '3. /scoreboard — how the paper buys are doing, net of fees',
    '',
    '/help lists every command.',
    `🔐 ${SEED_WARNING}`,
  ].join('\n');
}

const COMMANDS_HELP = [
  '/mygifts — what your profile gifts are worth · /mygifts &lt;address|name.ton&gt; — a wallet',
  '/status · /safety — mode, limits, spend, live gate',
  '/why &lt;alert #&gt; — why the bot did or did not act',
  '/scoreboard — paper results net of fees',
  '/watch &lt;collection&gt; · /unwatch · /watchlist',
  '/autobuy add &lt;collection|*&gt; max=&lt;ton&gt; discount=&lt;pct&gt; [edge=&lt;ton&gt;] [edgepct=&lt;pct&gt;] [eta=&lt;days&gt;] [bid=1] [cross=0]',
  '/autobuy list · /autobuy del &lt;id&gt; · /autobuy live &lt;id&gt; · /autobuy on|off',
  '/set — thresholds · /preset careful|normal|bold',
  '/mute &lt;collection&gt; [hours] · /unmute · /compare &lt;collection&gt; [model]',
  '/dry on|off — practice / live (live needs DRY_RUN=false in .env and a confirm)',
  '/panic — stop all buying now · /resume',
  '/digest · /doctor · /buys · /pause · /forget',
].join('\n');

/** /help: the mode and every command. */
function helpText(settings) {
  return [INTRO, '', modeLine(settings), '', COMMANDS_HELP, '', `🔐 ${SEED_WARNING}`].join('\n');
}

export const BOT_COMMANDS = [
  ['start', 'Start here'],
  ['help', 'Every command'],
  ['mygifts', 'What are my gifts worth?'],
  ['status', 'Status and limits'],
  ['safety', 'Mode, limits, spend, live gate'],
  ['why', 'Why did or didn’t the bot act'],
  ['scoreboard', 'Paper results net of fees'],
  ['watch', 'Watch a collection'],
  ['unwatch', 'Stop watching a collection'],
  ['watchlist', 'Watched collections'],
  ['autobuy', 'Autobuy rules'],
  ['set', 'Show or change thresholds'],
  ['preset', 'careful | normal | bold'],
  ['mute', 'Mute a collection'],
  ['unmute', 'Unmute'],
  ['compare', 'Compare markets net of fees'],
  ['dry', 'Practice on/off'],
  ['panic', 'Stop all buying now'],
  ['resume', 'Resume'],
  ['digest', 'Daily digest preview'],
  ['doctor', 'Self-check'],
  ['buys', 'Recent purchases'],
  ['pause', 'Pause scanning'],
  ['forget', 'Delete stored wallets and snapshots'],
];

/**
 * @param {Object} d
 * @param {import('./config.js').Config} d.cfg
 * @param {import('./settings.js').Settings} d.settings
 * @param {import('./storage.js').Storage} d.storage
 * @param {import('./clients/index.js').MarketClient} d.client
 * @param {import('./engine.js').Engine} d.engine
 * @param {import('./autobuy.js').Buyer} d.buyer
 */
export function statusText({ cfg, settings, storage, client, engine }) {
  const now = Date.now();
  const buys = storage.buysSince(now - DAY);
  const mode = settings.dryRun ? 'dry' : 'live';
  const counted = buys.filter((b) => b.mode === mode && ['dry', 'pending', 'sent'].includes(b.status) && b.outcome !== 'lost_race');
  const spent = counted.reduce((s, b) => s + (b.allInTon ?? b.priceTon), 0);
  const lim = settings.limits(now);
  const ramp = settings.ramp(now);
  const lc = engine.lastCycle;
  return [
    `<b>Mode:</b> ${settings.dryRun ? '🧪 PRACTICE' : '💸 LIVE'}${settings.panic ? ' · 🛑 PANIC' : ''} · autobuy ${settings.autobuy ? 'ON' : 'off'} · ${settings.paused ? '⏸ paused' : '▶️ running'}`,
    `<b>Source:</b> ${client.name} · poll ${settings.get('poll_interval')}s`,
    `<b>Watching:</b> ${plural(storage.listWatch().length, 'collection')} · rules: ${storage.listRules().length}`,
    `<b>Limits:</b> max ${fmtTon(lim.maxPriceTon)} TON/buy all-in · ${fmtTon(spent)}/${fmtTon(lim.dailyBudgetTon)} TON per 24h · ${counted.filter((b) => b.createdAt >= now - HOUR).length}/${lim.maxBuysPerHour} buys/h (${mode === 'dry' ? 'practice' : 'live'})`,
    ramp.active ? `<b>Ramp:</b> ${ramp.pct}% budget until ${hhmm(ramp.untilMs)}` : null,
    // CHEAP_MAX_PRICE_TON=0 means the price-cap alert is off.
    `<b>Alerts:</b> ${settings.get('cheap_max_price') > 0 ? `cheap ≤ ${fmtTon(settings.get('cheap_max_price'))} TON or ` : ''}≥ ${settings.get('cheap_floor_pct')}% below floor; undervalued ≥ ${settings.get('discount_pct')}%${settings.get('cheap_max_price') > 0 ? '' : ' (price-cap alert off)'}`,
    `<b>Valuation:</b> last ${settings.get('comparables')} sales / ${settings.get('lookback_days')}d, min ${settings.get('min_comparables')}, ${settings.get('time_weighted') ? `time-weighted (half-life ${settings.get('half_life_days')}d)` : 'plain median'}, levels ${cfg.valuationLevels.join('→')}, wash filter ${cfg.washFilter ? 'on' : 'off'}`,
    lc
      ? `<b>Last scan:</b> ${new Date(lc.at).toISOString().slice(11, 19)} UTC · ${lc.listings ?? 0} listings · ${lc.alerts ?? 0} new alerts · ${lc.errors ?? 0} errors`
      : '<b>Last scan:</b> not yet',
    `<b>Alerts 24h:</b> ${storage.countAlertsSince(now - DAY)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * /dry off blockers and the confirmation text (scoreboard + readiness).
 * @param {{liveLibs?: () => boolean}} o  liveLibs: are the optional wallet packages installed?
 */
export function goLiveCheck({ cfg, settings, storage, now = Date.now(), liveLibs = liveLibsInstalled }) {
  const blockers = [];
  if (settings.envLocked) blockers.push('DRY_RUN=true in .env is a hard lock: set DRY_RUN=false and restart the bot');
  if (!cfg.walletMnemonic) blockers.push('WALLET_MNEMONIC is not set in .env');
  else if (!liveLibs()) {
    blockers.push('the wallet packages @ton/ton, @ton/core and @ton/crypto are not installed: run npm install @ton/ton @ton/core @ton/crypto, then restart');
  }
  if (settings.panic) blockers.push('/panic is on: /resume first');
  const sb = scoreboardFromStorage(storage, now);
  const ready = readiness(sb, cfg);
  if (cfg.goliveRequirePaper && !ready.ok) blockers.push(`GOLIVE_REQUIRE_PAPER=true and paper results are not enough yet (${ready.text})`);
  const board = `${formatScoreboard(sb, { currency: cfg.currencyLabel })}\n${ready.text}`;
  return { ok: !blockers.length, blockers, board, ready };
}

/**
 * @param {Object} d  same deps as statusText (+ optional portfolio, shadow)
 * @param {import('grammy').BotConfig<any>} [botConfig]  e.g. {botInfo} in tests
 */
export function createBot(d, botConfig) {
  const { cfg, settings, storage, client, engine, buyer } = d;
  const liveLibs = d.liveLibs || liveLibsInstalled;
  const bot = new Bot(cfg.botToken, botConfig);
  const admins = new Set(cfg.adminIds);
  const html = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
  const shadow = d.shadow || engine.shadow || new Shadow({ storage, cfg });
  const journal = engine.journal;
  const portfolio =
    d.portfolio ||
    new PortfolioService({ cfg, settings, storage, client, engine, offers: engine.offers, rates: engine.rates, giftsSource: new TelegramGiftsSource(bot.api) });
  if (!engine.portfolio) engine.portfolio = portfolio;

  // grammY's bot.start() handles updates one at a time. Long work (a buy that waits for the
  // seqno, portfolio refreshes, network checks) runs in the background so the next update, for
  // example /panic, is handled at once. bot.idle() waits for it (tests, shutdown).
  const tasks = new Set();
  const background = (label, fn, ctx = null) => {
    const t = (async () => {
      try {
        await fn();
      } catch (e) {
        log.warn(`${label} failed:`, e.message);
        await ctx?.reply(`${label[0].toUpperCase()}${label.slice(1)} failed: ${e.message}`).catch(() => {});
      }
    })();
    tasks.add(t);
    t.then(() => tasks.delete(t));
  };
  bot.idle = async () => {
    while (tasks.size) await Promise.all([...tasks]);
  };
  const shownAtMs = (ctx) => (ctx.callbackQuery?.message?.date || 0) * 1000;

  bot.use(async (ctx, next) => {
    if (!ctx.from || !admins.has(ctx.from.id)) {
      log.warn(`ignored update from non-admin ${ctx.from?.id}`);
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: 'Not authorized' }).catch(() => {});
      else if (ctx.message) await ctx.reply('Not authorized.').catch(() => {});
      return;
    }
    await next();
  });

  const startKb = () => new InlineKeyboard().text('What are my gifts worth?', 'mygifts');
  bot.command('start', (ctx) => ctx.reply(startText(settings), { ...html, reply_markup: startKb() }));
  bot.command('help', (ctx) => ctx.reply(helpText(settings), { ...html, reply_markup: startKb() }));
  bot.command('status', (ctx) => ctx.reply(statusText(d), html));
  bot.command('safety', (ctx) => ctx.reply(safetyText({ cfg, settings, storage }), html));

  bot.command('doctor', (ctx) =>
    background('/doctor', async () => {
      const r = formatDoctor(await runDoctor({ cfg, settings, storage, client, wallet: buyer?.wallet ?? null, telegram: bot.api, liveLibs }));
      await ctx.reply(`<b>Doctor</b>\n<pre>${escapeHtml(r.text)}</pre>`, html);
    }, ctx),
  );

  bot.command('watch', async (ctx) => {
    const q = commandArgs(ctx.message.text).join(' ');
    const r = await resolveCollection(q, client);
    if (!r.ok) return ctx.reply(r.error);
    let name = r.name;
    let isGift = false;
    try {
      const info = await client.getCollectionInfo(r.collection);
      name = info.name || name;
      isGift = info.isGift;
    } catch (e) {
      log.debug('collection info failed:', e.message);
    }
    storage.watch(r.collection, { name, isGift });
    return ctx.reply(`Watching <b>${escapeHtml(name || shortAddr(r.collection))}</b>${isGift ? ' (gift)' : ''}\n<a href="${getgemsCollectionUrl(r.collection)}">Getgems</a>`, html);
  });

  bot.command('unwatch', async (ctx) => {
    const r = await resolveCollection(commandArgs(ctx.message.text).join(' '), client);
    if (!r.ok) return ctx.reply(r.error);
    return ctx.reply(storage.unwatch(r.collection) ? 'Removed.' : 'Not in the watchlist.');
  });

  bot.command('watchlist', (ctx) => {
    const list = storage.listWatch();
    if (!list.length) return ctx.reply('Watchlist is empty. Use /watch <collection>.');
    const lines = list.map((w, i) => {
      const s = engine.stats[w.collection];
      const extra = s ? ` — ${s.listings} listed, floor ${fmtTon(s.cheapest)} (2nd ${fmtTon(s.floorRef)}), ${s.sales} sales` : '';
      return `${i + 1}. <b>${escapeHtml(w.name || shortAddr(w.collection))}</b>${w.isGift ? ' 🎁' : ''}${extra}\n<code>${w.collection}</code>`;
    });
    return ctx.reply(lines.join('\n'), html);
  });

  bot.command('set', (ctx) => {
    const [name, value] = commandArgs(ctx.message.text);
    if (!name) {
      const rows = settings.describe().map((p) => `<code>${p.name}</code> = <b>${p.value}</b> — ${escapeHtml(p.help)}`);
      return ctx.reply(`${rows.join('\n')}\n\nUsage: /set &lt;param&gt; &lt;value|default&gt;`, html);
    }
    if (value === undefined) return ctx.reply(`Usage: /set ${name} <value|default>`);
    const r = settings.set(name.toLowerCase(), value);
    if (!r.ok) return ctx.reply(r.error);
    if (name.toLowerCase() === 'poll_interval') engine.wake?.();
    return ctx.reply(`${name} = ${r.value}`);
  });

  bot.command('preset', (ctx) => {
    const name = (commandArgs(ctx.message.text)[0] || '').toLowerCase();
    const r = presetDiff(name, settings);
    if (!r.ok) return ctx.reply(r.error);
    if (!r.changes.length) return ctx.reply(formatPresetDiff(name, r.changes));
    const kb = new InlineKeyboard().text('Apply', `preset:${name}`).text('Cancel', 'cancel');
    return ctx.reply(`${formatPresetDiff(name, r.changes)}\nLimits can never exceed your .env values.`, { reply_markup: kb });
  });

  bot.command('autobuy', async (ctx) => {
    const [sub, ...rest] = commandArgs(ctx.message.text);
    const names = () => new Map(storage.listWatch().map((w) => [w.collection, w.name]));
    switch ((sub || '').toLowerCase()) {
      case 'add': {
        const p = parseAutobuyAdd(rest);
        if (!p.ok) return ctx.reply(p.error);
        let collection = '*';
        if (p.collection !== '*') {
          const r = await resolveCollection(p.collection, client);
          if (!r.ok) return ctx.reply(r.error);
          collection = r.collection;
        }
        const cap = settings.get('max_price');
        const state = cfg.shadowNewRules ? 'shadow' : 'live';
        const { ok: _ok, collection: _c, ...opts } = p;
        const id = storage.addRule({ ...opts, collection, state });
        const capNote = p.maxPriceTon > cap ? `\n⚠️ max_price limit is ${cap} TON and still applies.` : '';
        const shadowNote =
          state === 'shadow'
            ? `\n🔭 Shadow mode: it records what it would buy, never buys. After ${cfg.shadowMinHours}h and ${cfg.shadowMinMatches} matches you get a hindsight card with [Go live].`
            : '';
        return ctx.reply(
          `Rule #${id} added: ${collection === '*' ? 'any collection' : shortAddr(collection)}, ${describeRule({ ...p })}${capNote}${shadowNote}\nAutobuy is ${settings.autobuy ? 'ON' : 'OFF (/autobuy on)'}`,
        );
      }
      case 'list':
      case '': {
        const rules = storage.listRules();
        const n = names();
        const icon = { shadow: '🔭 shadow', live: '✅ live', paused: '⏸ paused' };
        const lines = rules.map((r) => `#${r.id} ${r.collection === '*' ? 'any' : escapeHtml(n.get(r.collection) || shortAddr(r.collection))}: ${escapeHtml(describeRule(r))} · ${icon[r.state] || r.state}`);
        return ctx.reply(`Autobuy: <b>${settings.autobuy ? 'ON' : 'OFF'}</b> (${settings.dryRun ? 'practice' : 'LIVE'})\n${lines.join('\n') || 'No rules.'}`, html);
      }
      case 'del': {
        const id = Number(rest[0]);
        if (!Number.isInteger(id)) return ctx.reply('Usage: /autobuy del <id>');
        return ctx.reply(shadow.deleteRule(id) ? `Rule #${id} deleted.` : `No rule #${id}.`);
      }
      case 'live': {
        const id = Number(rest[0]);
        if (!Number.isInteger(id)) return ctx.reply('Usage: /autobuy live <id>');
        const r = shadow.promote(id);
        if (!r.ok) return ctx.reply(r.error);
        return ctx.reply(`Rule #${id} is live.${settings.dryRun ? ' Practice mode: it paper-buys; real buying also needs DRY_RUN=false in .env and /dry off.' : ''}`);
      }
      case 'on':
      case 'off':
        settings.setFlag('autobuy', sub.toLowerCase() === 'on');
        return ctx.reply(`Autobuy ${settings.autobuy ? 'ON' : 'OFF'} (${settings.dryRun ? 'practice' : 'LIVE'}).`);
      default:
        return ctx.reply('Usage: /autobuy add|list|del|live|on|off');
    }
  });

  bot.command('dry', (ctx) => {
    const v = parseBool(commandArgs(ctx.message.text)[0] ?? '');
    if (v === null) return ctx.reply(`Mode: ${settings.dryRun ? 'PRACTICE' : 'LIVE'}. Usage: /dry on (practice) or /dry off (live)`);
    if (v) {
      settings.setPractice();
      return ctx.reply('🧪 PRACTICE mode: buys are on paper, no TON is spent.');
    }
    const g = goLiveCheck({ cfg, settings, storage, liveLibs });
    if (!g.ok) return ctx.reply(`Cannot go live:\n• ${g.blockers.join('\n• ')}\n\n${g.board}`, html);
    const kb = new InlineKeyboard().text('Yes, spend real TON', `dryoff:yes:${settings.confirmEpoch()}`).text('Cancel', 'cancel');
    const lim = settings.limits();
    const ramp = cfg.liveRampHours > 0 ? `\nFirst ${cfg.liveRampHours}h: only ${cfg.liveRampBudgetPct}% of the daily budget.` : '';
    return ctx.reply(
      `Go LIVE? Real purchases will be sent. This button expires in ${CONFIRM_TTL_MS / 60_000} minutes.\n\n${g.board}\n\nLimits (all-in): max ${fmtTon(lim.maxPriceTon)} TON/buy, ${fmtTon(lim.dailyBudgetTon)} TON per 24h, ${lim.maxBuysPerHour} buys/h.${ramp}`,
      { ...html, reply_markup: kb },
    );
  });

  bot.command('buys', (ctx) => {
    const rows = storage.listBuys(15);
    if (!rows.length) return ctx.reply('No purchases yet.');
    const lines = rows.map(
      (b) =>
        `#${b.id} ${new Date(b.createdAt).toISOString().slice(5, 16).replace('T', ' ')} ${b.mode === 'dry' ? 'PRACTICE' : b.mode.toUpperCase()} <b>${b.status === 'dry' ? 'paper' : b.status}</b> ${escapeHtml(b.name || shortAddr(b.nft))} ${fmtTon(b.priceTon)} TON (${b.source}${b.ruleId ? ` #${b.ruleId}` : ''})${b.outcome === 'lost_race' ? ' · lost race' : ''}${b.error ? ` — ${escapeHtml(b.error.slice(0, 80))}` : ''}`,
    );
    return ctx.reply(lines.join('\n'), html);
  });

  bot.command('scoreboard', (ctx) => {
    const sb = scoreboardFromStorage(storage);
    return ctx.reply(`${formatScoreboard(sb, { currency: cfg.currencyLabel })}\n${readiness(sb, cfg).text}`, html);
  });

  bot.command('digest', (ctx) => {
    const r = buildDigest({ storage, settings, cfg });
    const kb = new InlineKeyboard();
    for (const h of r.hints.filter((x) => x.canRaise).slice(0, 2)) kb.text(`Raise to ${h.suggest}`, `tune:${h.param}:${h.suggest}`).text('Keep', 'cancel').row();
    return ctx.reply(r.text, { ...html, ...(kb.inline_keyboard.length ? { reply_markup: kb } : {}) });
  });

  bot.command('why', (ctx) => {
    let ref = commandArgs(ctx.message.text).join(' ');
    if (!ref) {
      const id = alertIdFromText(ctx.message.reply_to_message?.text);
      if (id) ref = String(id);
    }
    if (!ref) return ctx.reply('Usage: /why <alert #> (or reply /why to an alert)');
    return ctx.reply(whyTrail(storage, ref) || `Nothing found for "${ref}".`, html);
  });

  bot.command('panic', (ctx) => {
    settings.setPanic(true);
    journal?.record({ kind: 'pause', mode: 'dry', id: `panic:${Date.now()}`, verdict: null, code: 'PANIC', reasons: [{ code: 'PANIC', sev: 'bad' }], text: '/panic: all buying stopped' });
    return ctx.reply('🛑 PANIC: all buying is stopped, practice mode is forced and pending confirmations are cancelled. /resume when ready (needs a confirm).');
  });

  bot.command('pause', (ctx) => {
    settings.setFlag('paused', true);
    return ctx.reply('Paused.');
  });
  bot.command('resume', (ctx) => {
    if (settings.panic) {
      const kb = new InlineKeyboard().text('Yes, resume', `resume:yes:${settings.confirmEpoch()}`).text('Cancel', 'cancel');
      return ctx.reply(`Clear /panic? The bot stays in practice mode; going live again needs /dry off. This button expires in ${CONFIRM_TTL_MS / 60_000} minutes.`, { reply_markup: kb });
    }
    const hadAuto = autoPauseState(storage);
    if (hadAuto) clearAutoPause(storage);
    settings.setFlag('paused', false);
    engine.wake?.();
    return ctx.reply(hadAuto ? `Resumed. Auto-pause cleared (${hadAuto.reason}).` : 'Resumed.');
  });

  const muteTarget = async (q) => {
    if (isAddress(q)) return { ok: true, subject: toRaw(q), label: shortAddr(q) };
    const r = await resolveCollection(q, client);
    return r.ok ? { ok: true, subject: r.collection, label: r.name || shortAddr(r.collection) } : r;
  };
  bot.command('mute', async (ctx) => {
    const args = commandArgs(ctx.message.text);
    if (!args.length) {
      const list = storage.listMuted(Date.now());
      return ctx.reply(list.length ? list.map((m) => `• ${escapeHtml(m.label || m.subject)} until ${new Date(m.until).toISOString().slice(0, 16).replace('T', ' ')} UTC`).join('\n') : 'Nothing muted. Usage: /mute <collection|nft> [hours]', html);
    }
    const hours = /^\d+(\.\d+)?$/.test(args.at(-1)) && args.length > 1 ? Number(args.pop()) : 24;
    const t = await muteTarget(args.join(' '));
    if (!t.ok) return ctx.reply(t.error);
    storage.mute(t.subject, Date.now() + hours * HOUR, t.label);
    return ctx.reply(`🔕 Muted ${t.label} for ${hours}h. Matching listings are still logged (/why shows them as MUTED).`);
  });
  bot.command('unmute', async (ctx) => {
    const t = await muteTarget(commandArgs(ctx.message.text).join(' '));
    if (!t.ok) return ctx.reply(t.error);
    return ctx.reply(storage.unmute(t.subject) ? `Unmuted ${t.label}.` : 'It was not muted.');
  });

  bot.command('compare', async (ctx) => {
    const args = commandArgs(ctx.message.text);
    let model = null;
    const mi = args.findIndex((a) => a.toLowerCase().startsWith('model='));
    if (mi >= 0) model = args.splice(mi, 1)[0].slice(6);
    let r = await resolveCollection(args.join(' '), client);
    if (!r.ok && args.length > 1 && !model) {
      model = args.pop();
      r = await resolveCollection(args.join(' '), client);
    }
    if (!r.ok) return ctx.reply(`${r.error}\nUsage: /compare <collection> [model]`);
    const name = r.name || storage.listWatch().find((w) => w.collection === r.collection)?.name || r.collection;
    const peers = engine.peers?.length ? engine.peers : await readPeers(cfg.peerFloors, { now: Date.now(), maxAgeSec: cfg.peerMaxAgeSec });
    return ctx.reply(`<pre>${escapeHtml(compareTable({ cfg, engine, collection: r.collection, name, model, peers }))}</pre>`, html);
  });

  // ---- portfolio
  const pfButtons = (r, kind) => {
    const kb = new InlineKeyboard().text('Watch these collections', `pfwatch:${r.snapshotId}`);
    if (kind === 'profile') kb.row().text(`Alert me if any drops ${cfg.portfolioDropAlertPct}%`, `pfdrop:${r.snapshotId}`);
    else kb.row().text('Track daily', `pftrack:${r.snapshotId}`);
    return kb;
  };
  const runMyGifts = async (ctx, arg) => {
    const msg = await ctx.reply(arg ? 'Valuing the wallet…' : 'Counting your gifts…');
    try {
      const r = arg ? await portfolio.address(arg, ctx.from.id) : await portfolio.profile(ctx.from.id);
      await ctx.api.editMessageText(msg.chat.id, msg.message_id, r.text, { ...html, reply_markup: pfButtons(r, arg ? 'address' : 'profile') });
    } catch (e) {
      log.warn('mygifts failed:', e.message);
      await ctx.api.editMessageText(msg.chat.id, msg.message_id, `Could not value the gifts: ${escapeHtml(e.message)}`, html).catch(() => {});
    }
  };
  bot.command('mygifts', (ctx) => background('/mygifts', () => runMyGifts(ctx, commandArgs(ctx.message.text).join(' '))));
  bot.callbackQuery('mygifts', async (ctx) => {
    await ctx.answerCallbackQuery();
    background('mygifts', () => runMyGifts(ctx, ''));
  });
  bot.callbackQuery(/^pfwatch:(\d+)$/, async (ctx) => {
    const snap = storage.getSnapshot(Number(ctx.match[1]));
    if (!snap || snap.userId !== ctx.from.id) return ctx.answerCallbackQuery({ text: 'Snapshot not found' });
    const colls = [...new Set(snap.items.map((i) => i.collection).filter(Boolean))];
    const known = new Map((await client.listGiftCollections().catch(() => [])).map((g) => [g.address, g.name]));
    for (const c of colls) storage.watch(c, { name: known.get(c) || null, isGift: true });
    await ctx.answerCallbackQuery({ text: `Watching ${colls.length}` });
    return ctx.reply(`Watching ${plural(colls.length, 'collection')}: ${colls.map((c) => escapeHtml(known.get(c) || shortAddr(c))).join(', ')}`, html);
  });
  bot.callbackQuery(/^pfdrop:(\d+)$/, async (ctx) => {
    storage.kvSet(`pf_drop:${ctx.from.id}`, '1');
    storage.addPortfolioAddress(ctx.from.id, PROFILE_SOURCE, 'profile');
    await ctx.answerCallbackQuery({ text: 'Drop alerts on' });
    return ctx.reply(`OK: once a day I check your profile gifts and tell you if any drops ${cfg.portfolioDropAlertPct}% or more. /forget to stop.`);
  });
  bot.callbackQuery(/^pftrack:(\d+)$/, async (ctx) => {
    const snap = storage.getSnapshot(Number(ctx.match[1]));
    if (!snap || snap.userId !== ctx.from.id || snap.source === PROFILE_SOURCE) return ctx.answerCallbackQuery({ text: 'Snapshot not found' });
    storage.addPortfolioAddress(ctx.from.id, snap.source, null);
    await ctx.answerCallbackQuery({ text: 'Tracking daily' });
    return ctx.reply(`Tracking ${shortAddr(snap.source)} daily: seller guard and "someone pays more" alerts. Only the public address is stored; /forget deletes it.`);
  });
  bot.command('forget', (ctx) => {
    const r = storage.forgetPortfolio(ctx.from.id);
    storage.kvDel(`pf_drop:${ctx.from.id}`);
    return ctx.reply(`Deleted ${plural(r.addresses, 'stored address', 'stored addresses')} and ${plural(r.snapshots, 'snapshot')}.`);
  });

  // ---- alert buttons
  // "Buy" -> pre-buy checklist (never signs) -> [Confirm buy] -> the same guarded Buyer path as autobuy.
  // The confirm button carries the mode it was shown in and the confirmation epoch: a practice-mode
  // Confirm never executes live, and /panic or any mode change voids every older Confirm.
  bot.callbackQuery(/^buy:(\d+)$/, async (ctx) => {
    const alert = storage.getAlert(Number(ctx.match[1]));
    if (!alert) return ctx.answerCallbackQuery({ text: 'Alert not found' });
    if (settings.panic) return ctx.answerCallbackQuery({ text: 'Panic is on: buying is stopped' });
    await ctx.answerCallbackQuery({ text: 'Checking…' });
    background('buy preview', async () => {
      const mode = settings.dryRun ? 'p' : 'l';
      const epoch = settings.confirmEpoch();
      const pv = await buyer.preview(alert.listing, { source: 'manual', alert });
      const l = alert.listing;
      const kb = new InlineKeyboard();
      if (pv.canConfirm) kb.text('Confirm buy', `buyc:${alert.id}:${mode}:${epoch}`);
      kb.text('Cancel', 'cancel');
      const question = pv.canConfirm ? `\n${mode === 'p' ? '🧪 PRACTICE — paper buy' : '💸 LIVE — buy'} <b>${escapeHtml(l.name)}</b> for <b>${fmtTon(l.priceTon)} TON</b>?` : '';
      await ctx.reply(`${formatPreview(pv, { mode: mode === 'p' ? 'practice' : 'live', currency: cfg.currencyLabel })}${question}`, { ...html, reply_markup: kb });
    }, ctx);
  });

  bot.callbackQuery(/^buyc:(\d+)(?::([pl]):(\d+))?$/, async (ctx) => {
    const alert = storage.getAlert(Number(ctx.match[1]));
    if (!alert) return ctx.answerCallbackQuery({ text: 'Alert not found' });
    const refuse = async (why) => {
      await ctx.answerCallbackQuery({ text: 'Confirmation expired' });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      return ctx.reply(`${why} Press Buy on the alert again for a fresh check.`);
    };
    const [, , shownMode, shownEpoch] = ctx.match;
    const nowMode = settings.dryRun ? 'p' : 'l';
    const shownAt = shownAtMs(ctx);
    if (settings.panic) {
      await ctx.answerCallbackQuery({ text: 'Cancelled by /panic' });
      return ctx.reply('This confirmation was cancelled by /panic.');
    }
    if (!shownMode) return refuse('This confirmation is from an older version of the bot.');
    if (Number(shownEpoch) !== settings.confirmEpoch()) {
      return refuse(`This confirmation was cancelled by /panic or a mode change (it was shown in ${shownMode === 'p' ? 'PRACTICE' : 'LIVE'} mode).`);
    }
    if (shownMode !== nowMode) {
      return refuse(`This confirmation was shown in ${shownMode === 'p' ? 'PRACTICE' : 'LIVE'} mode; the bot is ${nowMode === 'p' ? 'PRACTICE' : 'LIVE'} now.`);
    }
    if (!shownAt || Date.now() - shownAt > CONFIRM_TTL_MS) return refuse(`This confirmation is older than ${CONFIRM_TTL_MS / 60_000} minutes.`);
    await ctx.answerCallbackQuery({ text: 'Processing…' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    background('confirm buy', async () => {
      const res = await buyer.buy(alert.listing, { source: 'manual', alertId: alert.id, alert });
      await ctx.reply(`Result: ${res.status}${res.reason ? ` — ${res.reason}` : ''}`);
    }, ctx);
  });

  bot.callbackQuery(/^why:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    return ctx.reply(whyTrail(storage, ctx.match[1]) || 'Nothing recorded for this alert.', html);
  });

  bot.callbackQuery(/^comps:(\d+)$/, async (ctx) => {
    const alert = storage.getAlert(Number(ctx.match[1]));
    if (!alert) return ctx.answerCallbackQuery({ text: 'Alert not found' });
    await ctx.answerCallbackQuery();
    return ctx.reply(formatComps(alert, { roundTripDays: cfg.washRoundTripDays, currency: cfg.currencyLabel }), html);
  });

  bot.callbackQuery(/^mute:(\d+)$/, async (ctx) => {
    const alert = storage.getAlert(Number(ctx.match[1]));
    if (!alert) return ctx.answerCallbackQuery({ text: 'Alert not found' });
    storage.mute(alert.listing.nft, Date.now() + DAY, alert.listing.name);
    await ctx.answerCallbackQuery({ text: 'Muted for 24h' });
    return ctx.reply(`🔕 ${escapeHtml(alert.listing.name)} muted for 24h. It is still logged; /why shows it.`, html);
  });

  bot.callbackQuery(/^explain:(\d+)$/, async (ctx) => {
    if (!cfg.anthropicApiKey) return ctx.answerCallbackQuery({ text: 'ANTHROPIC_API_KEY is not set' });
    const id = Number(ctx.match[1]);
    const ev = storage.decisionByEvent(`alert:${id}`);
    if (!ev) return ctx.answerCallbackQuery({ text: 'Alert not found' });
    await ctx.answerCallbackQuery({ text: 'Asking Claude…' });
    try {
      const text = await explainMore(ev.payload, { apiKey: cfg.anthropicApiKey, model: cfg.anthropicModel });
      return ctx.reply(text ? escapeHtml(text) : 'No explanation available.', html);
    } catch (e) {
      return ctx.reply(`Explain more failed: ${escapeHtml(e.message)}`, html);
    }
  });

  // ---- confirmations
  bot.callbackQuery(/^dryoff:yes(?::(\d+))?$/, async (ctx) => {
    // Shown before a /panic, /dry on or an earlier go-live? Then it is void: run /dry off again.
    if (ctx.match[1] === undefined || Number(ctx.match[1]) !== settings.confirmEpoch()) {
      await ctx.answerCallbackQuery({ text: 'Confirmation expired' });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      return ctx.reply('This confirmation was cancelled by /panic or a mode change. Send /dry off again to go live.');
    }
    // Like Confirm buy, the go-live button expires: the scoreboard and limits it showed are stale.
    const shownAt = shownAtMs(ctx);
    if (!shownAt || Date.now() - shownAt > CONFIRM_TTL_MS) {
      await ctx.answerCallbackQuery({ text: 'Confirmation expired' });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      return ctx.reply(`This confirmation is older than ${CONFIRM_TTL_MS / 60_000} minutes. Send /dry off again to go live.`);
    }
    const g = goLiveCheck({ cfg, settings, storage, liveLibs });
    if (!g.ok) {
      await ctx.answerCallbackQuery({ text: 'Cannot go live' });
      return ctx.reply(`Cannot go live:\n• ${g.blockers.join('\n• ')}`);
    }
    settings.confirmLive(Date.now());
    await ctx.answerCallbackQuery({ text: 'LIVE mode' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    const ramp = settings.ramp();
    return ctx.reply(`💸 LIVE mode. Purchases are real now.${ramp.active ? ` Ramp: ${ramp.pct}% budget until ${hhmm(ramp.untilMs)}.` : ''} /dry on or /panic to stop.`);
  });

  bot.callbackQuery(/^resume:yes(?::(\d+))?$/, async (ctx) => {
    // A resume button from before a newer /panic must not clear that panic.
    if (ctx.match[1] === undefined || Number(ctx.match[1]) !== settings.confirmEpoch()) {
      await ctx.answerCallbackQuery({ text: 'Confirmation expired' });
      return ctx.reply('This confirmation is out of date. Send /resume again.');
    }
    const shownAt = shownAtMs(ctx);
    if (!shownAt || Date.now() - shownAt > CONFIRM_TTL_MS) {
      await ctx.answerCallbackQuery({ text: 'Confirmation expired' });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      return ctx.reply(`This confirmation is older than ${CONFIRM_TTL_MS / 60_000} minutes. Send /resume again.`);
    }
    settings.setPanic(false);
    clearAutoPause(storage);
    settings.setFlag('paused', false);
    journal?.record({ kind: 'resume', mode: 'dry', id: `resume:${Date.now()}`, verdict: null, code: null, reasons: [], text: '/resume confirmed' });
    await ctx.answerCallbackQuery({ text: 'Resumed' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    engine.wake?.();
    return ctx.reply('Panic cleared. Still in practice mode: /dry off to go live again.');
  });

  bot.callbackQuery(/^preset:(\w+)$/, async (ctx) => {
    const r = presetDiff(ctx.match[1], settings);
    if (!r.ok) return ctx.answerCallbackQuery({ text: r.error });
    const res = applyPreset(settings, r.changes);
    await ctx.answerCallbackQuery({ text: 'Applied' });
    return ctx.reply(res.map((c) => `${c.param}: ${c.result.ok ? `${c.from} → ${c.result.value}` : c.result.error}`).join('\n') || 'Nothing to change.');
  });

  bot.callbackQuery(/^tune:(\w+):([\d.]+)$/, async (ctx) => {
    const [, param, value] = ctx.match;
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard().text('Yes, raise', `tunec:${param}:${value}`).text('Keep', 'cancel');
    return ctx.reply(`Raise ${param} from ${settings.get(param)} to ${value}? It can never exceed the .env value.`, { reply_markup: kb });
  });
  bot.callbackQuery(/^tunec:(\w+):([\d.]+)$/, async (ctx) => {
    const [, param, value] = ctx.match;
    const r = settings.set(param, value);
    await ctx.answerCallbackQuery({ text: r.ok ? 'Done' : 'Refused' });
    return ctx.reply(r.ok ? `${param} = ${r.value}` : r.error);
  });

  bot.callbackQuery(/^shlive:(\d+)$/, async (ctx) => {
    const r = shadow.promote(Number(ctx.match[1]));
    await ctx.answerCallbackQuery({ text: r.ok ? 'Live' : r.error });
    if (!r.ok) return undefined;
    return ctx.reply(
      `Rule #${ctx.match[1]} is live.${settings.envLocked ? ' Live buying also needs DRY_RUN=false in .env; until then it only paper-buys.' : settings.dryRun ? ' Practice mode: it paper-buys until /dry off.' : ''}`,
    );
  });
  bot.callbackQuery(/^shkeep:(\d+)$/, async (ctx) => {
    shadow.keepTesting(Number(ctx.match[1]));
    await ctx.answerCallbackQuery({ text: 'OK' });
    return ctx.reply(`Rule #${ctx.match[1]} keeps testing for 24h.`);
  });
  bot.callbackQuery(/^shdel:(\d+)$/, async (ctx) => {
    const ok = shadow.deleteRule(Number(ctx.match[1]));
    await ctx.answerCallbackQuery({ text: ok ? 'Deleted' : 'Not found' });
    return ctx.reply(ok ? `Rule #${ctx.match[1]} deleted.` : 'Rule not found.');
  });

  bot.callbackQuery('cancel', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  bot.catch((err) => log.error('bot error:', err.error?.message || err.message));
  return bot;
}

/** /compare text: this market (from the last scan) plus fresh peers. */
export function compareTable({ cfg, engine, collection, name, model = null, peers }) {
  const listings = (engine.lastListings?.[collection] || []).filter((l) => !model || String(l.attrs?.model || '').toLowerCase() === String(model).toLowerCase());
  const prices = listings.map((l) => l.priceTon).sort((a, b) => a - b);
  const keep = 1 - (cfg.marketFeePctFallback + cfg.royaltyPctFallback) / 100;
  const here = prices.length
    ? { floorTon: prices[0], listed: prices.length, buyAllInTon: prices[0] + cfg.networkCostTon, exitNetTon: prices[0] * keep - cfg.sellCostTon }
    : null;
  return formatCompare({ collectionName: name, model, here, peers, aliases: loadAliases() });
}
