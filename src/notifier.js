// Notifications: Telegram (grammY Api) when BOT_TOKEN is set, otherwise stdout.
// Alerts can go out silently (disable_notification) for the "Not a deal after fees" and
// illiquid lanes; the console marks them [silent].

import { Api, InlineKeyboard } from 'grammy';
import { formatAlert, htmlToText } from './format.js';
import { getgemsUrl } from './models.js';
import { createLogger } from './logger.js';

const log = createLogger('notify');

/**
 * @typedef {Object} AlertOpts
 * @property {string|null} [collectionName]
 * @property {boolean} [silent]          send with disable_notification
 * @property {boolean} [explainMore]     show the [Explain more] button (ANTHROPIC_API_KEY set)
 * @property {string} [currency]
 * @property {{offchain?:string, telemint?:string}} [notes]
 */

/**
 * @typedef {Object} Notifier
 * @property {(html:string, extra?:{reply_markup?:InlineKeyboard, silent?:boolean}) => Promise<void>} text
 * @property {(alert:import('./detector.js').Alert, alertId:number, opts?:AlertOpts) => Promise<void>} alert
 */

/** Alert buttons: Open, main action (Paper buy / Buy…), Why?, Comps, Mute 24h [, Explain more]. */
export function alertKeyboard(alert, alertId, { explainMore = false } = {}) {
  const kb = new InlineKeyboard()
    .url('Open on Getgems', getgemsUrl(alert.listing))
    .text(alert.mode === 'live' ? 'Buy…' : 'Paper buy', `buy:${alertId}`)
    .row()
    .text('Why?', `why:${alertId}`)
    .text('Comps', `comps:${alertId}`)
    .text('Mute 24h', `mute:${alertId}`);
  if (explainMore) kb.row().text('Explain more', `explain:${alertId}`);
  return kb;
}

export function keyboardLabels(kb) {
  return (kb?.inline_keyboard || []).flat().map((b) => b.text);
}

/** @implements {Notifier} */
export class ConsoleNotifier {
  constructor({ quiet = false } = {}) {
    this.quiet = quiet;
  }
  async text(html, extra = {}) {
    if (this.quiet) return;
    const buttons = keyboardLabels(extra.reply_markup);
    console.log(`\n${htmlToText(html)}${buttons.length ? `\n[buttons: ${buttons.join(' | ')}]` : ''}`);
  }
  async alert(alert, alertId, opts = {}) {
    if (this.quiet) return;
    const kb = alertKeyboard(alert, alertId, opts);
    console.log(
      `\n${opts.silent ? '[silent] ' : ''}${htmlToText(formatAlert(alert, { ...opts, alertId }))}\n[alert #${alertId}${opts.silent ? ', silent' : ''}; buttons: ${keyboardLabels(kb).join(' | ')}]`,
    );
  }
}

/** @implements {Notifier} */
export class TelegramNotifier {
  /** @param {Api} api @param {number[]} chatIds */
  constructor(api, chatIds) {
    this.api = api;
    this.chatIds = chatIds;
  }
  async #send(html, extra = {}) {
    for (const chatId of this.chatIds) {
      try {
        await this.api.sendMessage(chatId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
      } catch (e) {
        log.error(`sendMessage to ${chatId} failed:`, e.description || e.message);
      }
    }
  }
  async text(html, extra = {}) {
    const { silent, ...rest } = extra;
    await this.#send(html, { ...rest, ...(silent ? { disable_notification: true } : {}) });
  }
  async alert(alert, alertId, opts = {}) {
    await this.#send(formatAlert(alert, { ...opts, alertId }), {
      reply_markup: alertKeyboard(alert, alertId, opts),
      ...(opts.silent ? { disable_notification: true } : {}),
    });
  }
}

/**
 * @param {import('./config.js').Config} cfg
 * @param {{api?: Api, quiet?: boolean}} [opts]
 * @returns {Notifier}
 */
export function createNotifier(cfg, { api, quiet = false } = {}) {
  if (!cfg.botToken) {
    if (!quiet) log.info('BOT_TOKEN is empty: notifications go to stdout');
    return new ConsoleNotifier({ quiet });
  }
  if (!cfg.alertChatIds.length) {
    log.warn('BOT_TOKEN is set but ADMIN_IDS/ALERT_CHAT_IDS are empty: notifications go to stdout');
    return new ConsoleNotifier({ quiet });
  }
  return new TelegramNotifier(api || new Api(cfg.botToken), cfg.alertChatIds);
}
