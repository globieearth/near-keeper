/**
 * `npm run verify:near` — proves the NEAR rail without a browser.
 *
 * Read-only: RPC calls only. No database, no keys, no writes, no funded account
 * required, so a judge can run it on a clean checkout.
 *
 *   npm run verify:near
 *   npm run verify:near -- <txHash> <senderAccount>
 *
 * Exit code 0 means the configured token answered and, when given, the transfer
 * was found and did not fail. Anything else is a non-zero exit with the reason.
 */

import { config } from './lib/config.js';
import {
    explorerTx,
    ftMetadata,
    getTransferStatus,
    isNearAccountId,
    isNearConfigured,
} from './lib/near.js';

const args = process.argv.slice(2);
const [txHash, sender] = args;

function line(label: string, value: string | number | null): void {
  console.log(`${label.padEnd(18)} ${value === null ? '—' : value}`);
}

function fail(message: string): never {
  console.error(`\nFAIL  ${message}`);
  process.exit(1);
}

console.log('Globie Keeper — NEAR rail check\n');

line('network', config.near.network);
line('rpc', config.near.rpcUrl);
line('token contract', config.near.usdcContract || null);
line('token decimals', config.near.usdcDecimals);
line('explorer', config.near.explorerUrl);

if (!isNearConfigured()) {
  fail('NEAR is not configured. Set NEAR_USDC_CONTRACT in .env and retry.');
}

const metadata = await ftMetadata();
if (metadata.decimals === null) {
  fail(`the token contract ${config.near.usdcContract} did not answer ft_metadata`);
}

console.log('');
line('token name', metadata.name);
line('token symbol', metadata.symbol);
line('chain decimals', metadata.decimals);

if (metadata.decimals !== config.near.usdcDecimals) {
  fail(
    `NEAR_USDC_DECIMALS is ${config.near.usdcDecimals} but the contract reports ` +
      `${metadata.decimals} — every amount would be off by 10^${Math.abs(
        metadata.decimals - config.near.usdcDecimals,
      )}`,
  );
}

if (txHash) {
  if (!sender || !isNearAccountId(sender)) {
    fail('pass the sender account after the transaction hash: <txHash> <senderAccount>');
  }

  const transfer = await getTransferStatus({
    txHash,
    senderId: sender,
  });

  console.log('');
  line('tx hash', transfer.txHash);
  line('found on chain', transfer.found ? 'yes' : 'no');
  line('succeeded', transfer.success ? 'yes' : 'no');
  line('sender', transfer.sender);
  line('token contract', transfer.tokenContract);
  line('receiver', transfer.receiver);
  line('chain amount', transfer.chainAmount);
  line('memo', transfer.memo);
  line('explorer', explorerTx(transfer.txHash));

  if (!transfer.found) fail('that transaction is not on chain yet');
  if (!transfer.success) fail('that transaction failed on chain');
  if (transfer.tokenContract !== config.near.usdcContract) {
    fail('that transaction called a different token contract');
  }
}

console.log('\nOK');
