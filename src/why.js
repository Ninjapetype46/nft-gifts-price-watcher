// /why: the decision trail for an alert, a buy or a skip, from the `decisions` table.
// Answers "why did / didn't the bot act": the limit, fee, low confidence, safety check or a
// better price elsewhere. Accepts an alert number ("12" or "#12"), a buy ("b5") or an event id.

import { escapeHtml } from './format.js';
import { fmtTon } from './models.js';

const hms = (ms) => new Date(ms).toTimeString().slice(0, 8);

function render(title, rows) {
  const lines = [title];
  for (const d of rows) {
    const tag = `${d.kind.toUpperCase()}${d.mode === 'shadow' ? ' (shadow)' : d.mode === 'dry' && d.kind === 'buy' ? ' (paper)' : ''}`;
    // The plain text says why; the machine code stays in the decisions table and events.jsonl.
    lines.push(`• ${hms(d.ts)} ${tag} — ${escapeHtml(d.text || '')}`);
  }
  const bought = rows.find((d) => d.kind === 'buy' && d.mode !== 'shadow');
  const skips = rows.filter((d) => d.kind === 'skip' || d.kind === 'error');
  if (bought) lines.push(bought.mode === 'dry' ? '<b>Result:</b> bought on paper (practice mode, no TON spent).' : '<b>Result:</b> bought.');
  else if (skips.length) lines.push(`<b>Result:</b> ${escapeHtml(skips[skips.length - 1].text)}`);
  else lines.push('<b>Result:</b> alert only — no live autobuy rule acted on it.');
  return lines.join('\n');
}

/**
 * @param {import('./storage.js').Storage} storage
 * @param {string} ref  "12", "#12", "b5" or an event id
 * @returns {string|null} HTML, or null when nothing matches
 */
export function whyTrail(storage, ref) {
  const q = String(ref || '').trim().replace(/^#/, '');
  if (!q) return null;
  if (/^\d+$/.test(q)) {
    const alert = storage.getAlert(Number(q));
    if (!alert) return null;
    const rows = storage.decisionsForAlert(alert.id, alert.listing.nft, alert.createdAt - 1000);
    return render(`<b>Why: ${escapeHtml(alert.listing.name)} — ${fmtTon(alert.listing.priceTon)} TON</b> (alert #${alert.id})`, rows);
  }
  const b = /^b(\d+)$/i.exec(q);
  if (b) {
    const buy = storage.getBuy(Number(b[1]));
    if (!buy) return null;
    if (buy.alertId) return whyTrail(storage, String(buy.alertId));
    return render(`<b>Why: ${escapeHtml(buy.name || buy.nft)}</b> (buy #${buy.id})`, storage.decisionsForBuy(buy.id));
  }
  const d = storage.decisionByEvent(q);
  if (!d) return null;
  if (d.alertId) return whyTrail(storage, String(d.alertId));
  if (d.buyId) return whyTrail(storage, `b${d.buyId}`);
  return render(`<b>Why: ${escapeHtml(d.title || d.nft || q)}</b>`, d.nft ? storage.decisionsForNft(d.nft) : [d]);
}

/** Alert number from a replied-to alert message ("… · alert #12"). */
export function alertIdFromText(text) {
  const m = /alert #(\d+)/.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}
