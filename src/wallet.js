// TON wallet (WalletV4R2 / WalletV5R1) for live buys. @ton/ton + @ton/crypto are optional
// dependencies loaded with dynamic import() only here, so mock mode works without them.

import { ConfigError } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('wallet');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIVE_PACKAGES = ['@ton/ton', '@ton/core', '@ton/crypto'];

/**
 * Are the optional wallet packages installed? Resolves them without loading them, so /dry off and
 * /doctor can refuse live mode up front (they are optional and not installed by default).
 */
export function liveLibsInstalled() {
  try {
    for (const m of LIVE_PACKAGES) import.meta.resolve(m);
    return true;
  } catch {
    return false;
  }
}

async function loadTonLibs() {
  try {
    const [ton, crypto] = await Promise.all([import('@ton/ton'), import('@ton/crypto')]);
    return { ton, crypto };
  } catch (e) {
    throw new ConfigError(
      `Live buying needs the optional packages @ton/ton, @ton/core and @ton/crypto (${e.message}). Run: npm install @ton/ton @ton/core @ton/crypto`,
    );
  }
}

export class TonWallet {
  constructor({ ton, contract, keyPair, client, version }) {
    this.ton = ton;
    this.contract = contract;
    this.keyPair = keyPair;
    this.client = client;
    this.version = version;
    this.opened = client ? client.open(contract) : null;
  }

  /** Non-bounceable user-friendly address (UQ...), as wallets show it. */
  get address() {
    return this.contract.address.toString({ bounceable: false, urlSafe: true });
  }

  async balanceNano() {
    return await this.opened.getBalance();
  }

  async seqno() {
    return await this.opened.getSeqno();
  }

  /** @param {import('./models.js').OutMessage[]} messages */
  toInternal(messages) {
    const { Address, Cell, internal, loadStateInit } = this.ton;
    return messages.map((m) => {
      let to;
      let bounce = m.bounce ?? true;
      if (Address.isFriendly(m.to)) {
        const p = Address.parseFriendly(m.to);
        to = p.address;
        if (m.bounce === undefined) bounce = p.isBounceable; // TonConnect semantics
      } else {
        to = Address.parse(m.to);
      }
      return internal({
        to,
        value: BigInt(m.amountNano),
        bounce,
        body: m.payloadB64 ? Cell.fromBase64(m.payloadB64) : undefined,
        init: m.stateInitB64 ? loadStateInit(Cell.fromBase64(m.stateInitB64).beginParse()) : undefined,
      });
    });
  }

  /** Signed transfer body without touching the network (used by tests and for logging). */
  buildTransfer(messages, seqno) {
    const { SendMode } = this.ton;
    return this.contract.createTransfer({
      seqno,
      secretKey: this.keyPair.secretKey,
      messages: this.toInternal(messages),
      sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
    });
  }

  /**
   * Sign and send; then wait (best effort) for the seqno to advance.
   * @param {import('./models.js').OutMessage[]} messages
   * @returns {Promise<{seqno:number, confirmed:boolean}>}
   */
  async send(messages, { waitMs = 60_000 } = {}) {
    const { SendMode } = this.ton;
    let seqno;
    try {
      seqno = await this.seqno();
    } catch (e) {
      // Nothing was signed or sent yet: the buyer may record this as a plain failure.
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { stage: 'before_broadcast' });
    }
    // From here on an error may come after the transfer reached the network (status unknown).
    await this.opened.sendTransfer({
      seqno,
      secretKey: this.keyPair.secretKey,
      messages: this.toInternal(messages),
      sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
    });
    log.info(`transfer sent from ${this.address} seqno=${seqno}`);
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      await sleep(3000);
      try {
        if ((await this.seqno()) > seqno) return { seqno, confirmed: true };
      } catch (e) {
        log.debug('seqno poll failed:', e.message);
      }
    }
    return { seqno, confirmed: false };
  }
}

/**
 * @param {import('./config.js').Config} cfg
 * @param {{offline?: boolean, mnemonic?: string}} [opts] offline=true skips the RPC client
 */
export async function loadWallet(cfg, { offline = false, mnemonic } = {}) {
  const words = (mnemonic ?? cfg.walletMnemonic).trim().split(/\s+/).filter(Boolean);
  if (!words.length) throw new ConfigError('Missing required .env key WALLET_MNEMONIC (needed when DRY_RUN=false)');
  if (words.length !== 24) throw new ConfigError(`WALLET_MNEMONIC must have 24 words, got ${words.length}`);
  const { ton, crypto } = await loadTonLibs();
  if (!(await crypto.mnemonicValidate(words))) throw new ConfigError('WALLET_MNEMONIC is not a valid TON mnemonic');
  const keyPair = await crypto.mnemonicToPrivateKey(words);
  const contract =
    cfg.walletVersion === 'v5r1'
      ? ton.WalletContractV5R1.create({ publicKey: keyPair.publicKey, walletId: { networkGlobalId: -239 } })
      : ton.WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
  const client = offline
    ? null
    : new ton.TonClient({ endpoint: cfg.tonRpcEndpoint, apiKey: cfg.toncenterApiKey || undefined });
  return new TonWallet({ ton, contract, keyPair, client, version: cfg.walletVersion });
}
