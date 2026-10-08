// Offline wallet checks; skipped when the optional @ton/* packages are not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWallet } from '../src/wallet.js';
import { loadConfig, ConfigError } from '../src/config.js';
import { toFriendly } from '../src/address.js';

let crypto = null;
try {
  crypto = await import('@ton/crypto');
  await import('@ton/ton');
} catch {
  crypto = null;
}

test('mnemonic validation errors are clear', async () => {
  await assert.rejects(loadWallet(loadConfig({ env: {} }), { offline: true }), /WALLET_MNEMONIC/);
  await assert.rejects(loadWallet(loadConfig({ env: {} }), { offline: true, mnemonic: 'a b c' }), ConfigError);
});

for (const version of ['v4r2', 'v5r1']) {
  test(`${version}: derive address and sign a buy transfer offline`, { skip: !crypto && '@ton/ton not installed' }, async () => {
    const words = await crypto.mnemonicNew(24);
    const w = await loadWallet(loadConfig({ env: { WALLET_VERSION: version } }), { offline: true, mnemonic: words.join(' ') });
    assert.match(w.address, /^UQ[A-Za-z0-9_-]{46}$/);
    const { beginCell } = await import('@ton/core');
    const payload = beginCell().storeUint(2, 32).storeUint(0, 64).endCell().toBoc().toString('base64');
    const cell = w.buildTransfer(
      [
        { to: 'EQBXhsiBxXjnfnuOU8ztrQzw2Rl79sQAMPK30AYi8NCZ1e9l', amountNano: '6800000000' },
        { to: '0:' + 'ab'.repeat(32), amountNano: '100000000', payloadB64: payload, bounce: false },
      ],
      0,
    );
    assert.ok(cell.bits.length > 0);
    const uq = toFriendly('0:5786c881c578e77e7b8e53ccedad0cf0d9197bf6c40030f2b7d00622f0d099d5', { bounceable: false });
    const internals = w.toInternal([{ to: uq, amountNano: '1' }]);
    assert.equal(internals[0].info.bounce, false); // non-bounceable friendly address -> bounce off
  });
}
