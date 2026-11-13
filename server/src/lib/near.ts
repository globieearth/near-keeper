/**
 * The NEAR settlement rail.
 *
 * Two jobs, deliberately kept in one file so there is exactly one definition of
 * "this transfer counts as paid":
 *
 *   1. Convert between the database's BIGINT ISO-4217 minor units and the
 *      token's own decimals (NEP-141 USDC = 6). Getting this wrong is the
 *      classic way a demo over- or under-charges by 10,000x.
 *   2. Read a transaction from RPC and prove that it is the payment we asked
 *      for: right token, right sender, right receiver, right amount.
 *
 * Nothing here signs anything. The payer signs in their own wallet; the server
 * only verifies, which is what keeps the platform non-custodial.
 */

import { config } from './config.js';
import { ApiError } from './http-error.js';

/** NEP-141 `ft_transfer` / `ft_transfer_call` receipts we accept. */
const FT_METHODS = new Set(['ft_transfer', 'ft_transfer_call']);

export type NearTransfer = {
  txHash: string;
  found: boolean;
  success: boolean;
  sender: string | null;
  /** Token contract that was called (config.near.usdcContract for USDC). */
  tokenContract: string | null;
  /** The contract method that was called, e.g. `ft_transfer` or `ft_balance_of`. */
  method: string | null;
  /** `args.receiver_id` — where the money actually went. */
  receiver: string | null;
  /** Amount in the token's decimals, as the chain reports it. */
  chainAmount: string | null;
  /** The same amount in USD cents (USDC is a USD token). */
  amountMinor: number | null;
  memo: string | null;
  /**
   * `args.account_id` — the read-only anchor's carrier. An anchor is
   * `ft_balance_of({ "account_id": "<termsHash>" })`: nothing moves, so the
   * digest is the only thing worth reading.
   */
  accountArg: string | null;
  /** `args.terms_hash` — set by the registry's `record_acceptance`. */
  termsArg: string | null;
  /** `args.agreement_id` — set by the registry's `record_acceptance`. */
  agreementArg: string | null;
  /**
   * `args.signature` — the base64 NEP-413 signature the registry recorded. The
   * anchor route compares it with the row it is about to mark, so a hash that
   * points at some other signature can never be attached to this acceptance.
   */
  signatureArg: string | null;
  explorerUrl: string;
};

type RpcAction = {
  FunctionCall?: { method_name: string; args: string; deposit: string };
  Transfer?: { deposit: string };
};

type RpcTxStatus = {
  transaction?: {
    signer_id: string;
    receiver_id: string;
    actions: RpcAction[];
  };
  status?: { SuccessValue?: string; Failure?: unknown };
  transaction_outcome?: { outcome?: { logs?: string[] } };
  receipts_outcome?: Array<{ outcome?: { logs?: string[] } }>;
};

export function isNearConfigured(): boolean {
  return Boolean(config.near.usdcContract && config.near.rpcUrl);
}

/**
 * NEAR account ids are 2–64 chars: lowercase alphanumerics and `-_.` separators,
 * or a 64-char hex implicit account. This rejects typos before they reach RPC.
 */
export function isNearAccountId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (/^[0-9a-f]{64}$/.test(value)) return true;
  return /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(value)
    && value.length >= 2
    && value.length <= 64;
}

export function explorerTx(txHash: string): string {
  return `${config.near.explorerUrl.replace(/\/+$/, '')}/txns/${txHash}`;
}

/** USDC is a USD token, so two of its decimals are the cent. */
const USD_MINOR_EXPONENT = 2;

/** USD cents -> USDC base units at the token's decimals (149 -> 1_490_000). */
export function chainFromUsdMinor(usdMinor: number): bigint {
  const delta = config.near.usdcDecimals - USD_MINOR_EXPONENT;
  if (delta >= 0) return BigInt(usdMinor) * 10n ** BigInt(delta);
  return BigInt(usdMinor) / 10n ** BigInt(-delta);
}

/** Inverse of `chainFromUsdMinor`; sub-cent dust is truncated, never rounded up. */
export function usdMinorFromChain(chainAmount: bigint): number {
  const delta = config.near.usdcDecimals - USD_MINOR_EXPONENT;
  if (delta >= 0) return Number(chainAmount / 10n ** BigInt(delta));
  return Number(chainAmount * 10n ** BigInt(-delta));
}

/**
 * The wire form of a chain amount: base units written as a decimal string
 * (`6_240_000` at 6 decimals -> `"6.24"`). Members paste this into a wallet, so
 * it must never be raw base units.
 */
export function formatTokenUnits(
  baseUnits: bigint,
  decimals = config.near.usdcDecimals,
): string {
  const raw = baseUnits.toString();
  if (decimals <= 0) return raw;
  const padded = raw.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Inverse of `formatTokenUnits`: a decimal string from the client (`"1.49"`) to
 * the integer the token moves (`1_490_000`). Extra decimals are truncated, never
 * rounded up, so a quote can never cost the payer more than it said.
 */
export function parseTokenUnits(
  value: string,
  decimals = config.near.usdcDecimals,
): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) {
    throw ApiError.badRequest('invalid_amount', 'amount must be a decimal string');
  }
  const fraction = (match[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  return BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt(fraction || '0');
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 -> bytes, for the block hash the RPC reports as text. */
export function base58Decode(value: string): Buffer {
  const bytes: number[] = [0];

  for (const character of value) {
    let carry = BASE58.indexOf(character);
    if (carry === -1) {
      throw ApiError.conflict('near_bad_block_hash', 'NEAR returned a block hash that is not base58');
    }
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index]! * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // A leading `1` encodes a leading zero byte, which the loop above drops.
  for (const character of value) {
    if (character !== '1') break;
    bytes.push(0);
  }

  return Buffer.from(bytes.reverse());
}

function borshU32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value, 0);
  return out;
}

function borshU64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value, 0);
  return out;
}

function borshU128(value: bigint): Buffer {
  const out = Buffer.alloc(16);
  out.writeBigUInt64LE(value & 0xffffffffffffffffn, 0);
  out.writeBigUInt64LE(value >> 64n, 8);
  return out;
}

function borshString(value: string): Buffer {
  return Buffer.concat([borshU32(Buffer.byteLength(value, 'utf8')), Buffer.from(value, 'utf8')]);
}

/** `Action::FunctionCall` is variant 2 of the `Action` enum. */
const ACTION_FUNCTION_CALL = 2;
/** `Action::Transfer` — native NEAR, borsh variant 3, payload is one u128 deposit. */
const ACTION_TRANSFER = 3;
const FT_TRANSFER_GAS = 30_000_000_000_000n;
const FT_TRANSFER_DEPOSIT = 1n;

/**
 * A read-only method needs no deposit and a fraction of a transfer's gas.
 *
 * The anchor used to be a one-base-unit `ft_transfer` back to the signer, with
 * the digest in the memo. The token contract refuses it outright —
 * `Smart contract panicked: Sender and receiver should be different` — so the
 * digest now travels as `args.account_id` of a read-only `ft_balance_of` call.
 * Same public, permanent argument; nothing moves and no storage is written.
 */
const ANCHOR_GAS = 10_000_000_000_000n;
export const ANCHOR_METHOD = 'ft_balance_of';

/**
 * `record_acceptance` writes one row (plus a NEP-297 log), so it needs more
 * headroom than a read-only call but nowhere near a full transfer.
 */
export const RECORD_ACCEPTANCE_METHOD = 'record_acceptance';
const RECORD_ACCEPTANCE_GAS = 30_000_000_000_000n;

/**
 * One `FunctionCall` action in a wallet-ready transaction, borsh-encoded and
 * base64'd — Meteor's `sign` action takes transactions in exactly that form.
 *
 * This is an instruction, not a payment: the placeholder ED25519 key and a zero
 * nonce are what `@meteorwallet/sdk` also sends, because the wallet replaces
 * both with the signer's real key and next nonce before it signs. Nothing here
 * is secret, and the server still verifies the resulting hash on chain.
 */
async function recentBlock(): Promise<{ bytes: Buffer; text: string }> {
  const block = await rpc<{ header?: { hash?: string } }>('block', { finality: 'optimistic' });
  const text = block.header?.hash;
  if (!text) {
    throw ApiError.conflict('near_block_unavailable', 'NEAR returned no recent block hash');
  }
  const bytes = base58Decode(text);
  if (bytes.length !== 32) {
    throw ApiError.conflict('near_block_unavailable', 'NEAR returned a malformed block hash');
  }
  return { bytes, text };
}

/**
 * One transaction with one action, in the shape a wallet signs. The block hash
 * is the chain's, the key and nonce are placeholders the wallet overwrites.
 */
function assembleTransaction(input: {
  signerId: string;
  receiverId: string;
  blockHash: Buffer;
  action: Buffer;
}): string {
  return Buffer.concat([
    borshString(input.signerId),
    // PublicKey::ED25519 with 32 zero bytes — the wallet substitutes its own.
    Buffer.from([0]),
    Buffer.alloc(32),
    borshU64(0n),
    borshString(input.receiverId),
    input.blockHash,
    borshU32(1),
    input.action,
  ]).toString('base64');
}

async function encodeFunctionCall(input: {
  signerId: string;
  receiverId: string;
  methodName: string;
  args: Buffer;
  gas: bigint;
  deposit: bigint;
}): Promise<{ transaction: string; blockHash: string }> {
  if (!isNearConfigured()) {
    throw ApiError.conflict('near_not_configured', 'NEAR settlement is not configured on this server');
  }

  const block = await recentBlock();

  const action = Buffer.concat([
    Buffer.from([ACTION_FUNCTION_CALL]),
    borshString(input.methodName),
    borshU32(input.args.length),
    input.args,
    borshU64(input.gas),
    borshU128(input.deposit),
  ]);

  // Addressed to the contract that runs the method (the token contract). A
  // payment's payee only ever appears in `args.receiver_id`: addressing the
  // transaction to the payee asks a plain account to run `ft_transfer`, which
  // the chain rejects with `CodeDoesNotExist`.
  return {
    transaction: assembleTransaction({
      signerId: input.signerId,
      receiverId: input.receiverId,
      blockHash: block.bytes,
      action,
    }),
    blockHash: block.text,
  };
}

/** The unsigned `ft_transfer` behind a one-tap payment. */
export async function prepareFtTransfer(input: {
  signerId: string;
  receiverId: string;
  amount: bigint;
  memo?: string | null;
}): Promise<{ transaction: string; blockHash: string }> {
  return encodeFunctionCall({
    signerId: input.signerId,
    receiverId: config.near.usdcContract,
    methodName: 'ft_transfer',
    args: Buffer.from(
      JSON.stringify({
        receiver_id: input.receiverId,
        amount: input.amount.toString(),
        ...(input.memo ? { memo: input.memo } : {}),
      }),
      'utf8',
    ),
    gas: FT_TRANSFER_GAS,
    deposit: FT_TRANSFER_DEPOSIT,
  });
}

/**
 * The unsigned native-NEAR transfer behind a one-tap gift.
 *
 * The inverse of `prepareFtTransfer`: the transaction is addressed *to the
 * payee* and carries `Action::Transfer`, because a plain account can hold and
 * receive NEAR without running any code. No contract, no gas attach, no memo —
 * native transfers have nowhere to put one, which is why verification matches
 * on sender, receiver and exact yocto amount only.
 */
export async function prepareNativeTransfer(input: {
  signerId: string;
  receiverId: string;
  deposit: bigint;
}): Promise<{ transaction: string; blockHash: string }> {
  if (!config.near.rpcUrl) {
    throw ApiError.conflict('near_not_configured', 'NEAR settlement is not configured on this server');
  }
  if (input.deposit <= 0n) {
    throw ApiError.conflict('near_invalid_amount', 'A native NEAR transfer must move more than zero');
  }

  const block = await recentBlock();
  const action = Buffer.concat([Buffer.from([ACTION_TRANSFER]), borshU128(input.deposit)]);

  return {
    transaction: assembleTransaction({
      signerId: input.signerId,
      receiverId: input.receiverId,
      blockHash: block.bytes,
      action,
    }),
    blockHash: block.text,
  };
}

/**
 * The unsigned anchor call: `ft_balance_of({ "account_id": "<termsHash>" })`.
 *
 * A 64-character hex digest is a valid implicit account id, so the token
 * contract accepts it as an argument and answers 0 for it. The call writes
 * nothing and moves nothing — it exists only to put the digest in a public
 * transaction the fronter signed.
 */
export async function prepareAnchorCall(input: {
  signerId: string;
  digest: string;
}): Promise<{ transaction: string; blockHash: string }> {
  return encodeFunctionCall({
    signerId: input.signerId,
    receiverId: config.near.usdcContract,
    methodName: ANCHOR_METHOD,
    args: Buffer.from(JSON.stringify({ account_id: input.digest }), 'utf8'),
    gas: ANCHOR_GAS,
    deposit: 0n,
  });
}

/**
 * The unsigned `record_acceptance` call on the shared registry contract.
 *
 * Unlike the read-only USDC anchor, this one writes storage and therefore
 * costs the registry owner ~0.002 NEAR per acceptance. What it buys is a row
 * the contract itself enforces: it asserts `predecessor_account_id() ==
 * account_id`, so no one can record an acceptance in somebody else's name. The
 * signature travels with it, which is why the caller has to be the member who
 * signed — the fronter cannot do this part for the group.
 */
export async function prepareRecordAcceptance(input: {
  signerId: string;
  agreementId: string;
  termsHash: string;
  accountId: string;
  publicKey: string;
  signature: string;
  nonce: string;
}): Promise<{ transaction: string; blockHash: string }> {
  if (!config.near.agreementsContract) {
    throw ApiError.conflict(
      'registry_not_configured',
      'The agreement registry contract is not configured on this server',
    );
  }

  return encodeFunctionCall({
    signerId: input.signerId,
    receiverId: config.near.agreementsContract,
    methodName: RECORD_ACCEPTANCE_METHOD,
    args: Buffer.from(
      JSON.stringify({
        agreement_id: input.agreementId,
        terms_hash: input.termsHash,
        account_id: input.accountId,
        public_key: input.publicKey,
        signature: input.signature,
        nonce: input.nonce,
      }),
      'utf8',
    ),
    gas: RECORD_ACCEPTANCE_GAS,
    deposit: 0n,
  });
}

/** Shared JSON-RPC transport; `lib/near-auth.ts` reuses it for access-key queries. */
export async function rpc<T>(method: string, params: unknown): Promise<T> {
  let response: Response;

  try {
    response = await fetch(config.near.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'globie-keeper', method, params }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    // `AbortSignal.timeout` rejects with a bare DOMException, which would reach
    // the error handler as an opaque 500. A slow or unreachable node is an
    // upstream outage, so it leaves here as the same code callers already know.
    const reason = error instanceof Error ? error.message : String(error);
    throw new ApiError(
      502,
      'near_rpc_unavailable',
      `NEAR RPC ${method} could not be reached: ${reason}`,
    );
  }

  // Even a 4xx arrives as a JSON-RPC body, and that body is the only thing that
  // says *why*. Read it before judging the status code — a rejected request is
  // otherwise misreported as an outage.
  let body: {
    result?: T;
    error?: {
      name?: string;
      message?: string;
      data?: string;
      cause?: { name?: string };
    };
  };

  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new ApiError(
      502,
      'near_rpc_unavailable',
      `NEAR RPC ${method} returned HTTP ${response.status} without a JSON-RPC body`,
    );
  }

  if (body.error) {
    // `UNKNOWN_TRANSACTION` is a normal answer while a tx is still in flight,
    // so it is reported as "not found" rather than as a transport failure.
    if (body.error.cause?.name === 'UNKNOWN_TRANSACTION') {
      return { __unknown: true } as unknown as T;
    }
    // 4xx means the node rejected the request itself (a hash it cannot decode,
    // a block that does not exist). That is a caller problem, not an outage.
    // fastnear reports the same class of error (notably `UNKNOWN_ACCOUNT` from
    // `view_account`) at HTTP 200, so the cause has to be judged too.
    const rejectedByCaller =
      (response.status >= 400 && response.status < 500) ||
      body.error.cause?.name === 'UNKNOWN_ACCOUNT' ||
      body.error.cause?.name === 'UNKNOWN_BLOCK' ||
      /does not exist/i.test(body.error.data ?? '');
    if (rejectedByCaller) {
      throw new ApiError(
        409,
        'near_rpc_bad_request',
        body.error.data ?? body.error.message ?? `NEAR RPC ${method} rejected the request`,
      );
    }
    throw new ApiError(
      502,
      'near_rpc_failed',
      body.error.message ?? `NEAR RPC ${method} failed`,
    );
  }

  if (!response.ok) {
    throw new ApiError(
      502,
      'near_rpc_unavailable',
      `NEAR RPC ${method} returned HTTP ${response.status}`,
    );
  }

  return body.result as T;
}

/** Current NEP-141 balance, in the token's decimals. */
export async function ftBalanceOf(accountId: string): Promise<string> {
  const result = await rpc<string>('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: config.near.usdcContract,
    method_name: 'ft_balance_of',
    args_base64: Buffer.from(JSON.stringify({ account_id: accountId }), 'utf8')
      .toString('base64'),
  });

  // `result` is the JSON-encoded return value, in bytes.
  const bytes = (result as unknown as { result?: number[] })?.result;
  if (!Array.isArray(bytes)) return '0';
  const decoded = Buffer.from(bytes).toString('utf8');
  try {
    return String(JSON.parse(decoded) ?? '0');
  } catch {
    return '0';
  }
}

export type FtMetadata = {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
};

/**
 * NEP-141 display metadata. `verify:near` compares `decimals` with the configured
 * scale, because a mismatch is the one misconfiguration that silently moves the
 * wrong amount.
 */
export async function ftMetadata(): Promise<FtMetadata> {
  const result = await rpc<{ result?: number[] }>('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: config.near.usdcContract,
    method_name: 'ft_metadata',
    args_base64: Buffer.from('{}', 'utf8').toString('base64'),
  });

  const bytes = result?.result;
  if (!Array.isArray(bytes)) return { name: null, symbol: null, decimals: null };

  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
      name?: string;
      symbol?: string;
      decimals?: number;
    };
    return {
      name: parsed.name ?? null,
      symbol: parsed.symbol ?? null,
      decimals: typeof parsed.decimals === 'number' ? parsed.decimals : null,
    };
  } catch {
    return { name: null, symbol: null, decimals: null };
  }
}

function decodeCallArgs(action: RpcAction): {
  receiverId: string | null;
  amount: string | null;
  memo: string | null;
  accountId: string | null;
  termsHash: string | null;
  agreementId: string | null;
  signature: string | null;
} {
  const call = action.FunctionCall;
  if (!call) {
    return {
      receiverId: null,
      amount: null,
      memo: null,
      accountId: null,
      termsHash: null,
      agreementId: null,
      signature: null,
    };
  }

  try {
    const args = JSON.parse(Buffer.from(call.args, 'base64').toString('utf8')) as {
      receiver_id?: string;
      amount?: string;
      memo?: string | null;
      account_id?: string;
      terms_hash?: string;
      agreement_id?: string;
      signature?: string;
    };
    return {
      receiverId: args.receiver_id ?? null,
      amount: args.amount ?? null,
      memo: args.memo ?? null,
      accountId: args.account_id ?? null,
      termsHash: args.terms_hash ?? null,
      agreementId: args.agreement_id ?? null,
      signature: args.signature ?? null,
    };
  } catch {
    return {
      receiverId: null,
      amount: null,
      memo: null,
      accountId: null,
      termsHash: null,
      agreementId: null,
      signature: null,
    };
  }
}

/**
 * Read a transaction by hash. `sender_account_id` is required by the RPC `tx`
 * method; callers always know it because the payer is the share owner.
 *
 * `wait_until: 'NONE'` is load-bearing: without it a modern node parks the call
 * until the transaction lands, so a hash that never will returns nothing at all
 * instead of "unknown transaction".
 */
export async function getTransferStatus(input: {
  txHash: string;
  senderId: string;
}): Promise<NearTransfer> {
  const txHash = input.txHash.trim();
  let result: (RpcTxStatus & { __unknown?: boolean }) | null = null;

  try {
    result = await rpc<RpcTxStatus & { __unknown?: boolean }>('tx', {
      tx_hash: txHash,
      sender_account_id: input.senderId,
      wait_until: 'NONE',
    });
  } catch (error) {
    // The node refuses hashes it cannot decode. For a settlement that is the
    // same answer as "no such transaction", and the caller already has wording
    // for it, so it is folded into `found: false` instead of surfacing a 409.
    if (error instanceof ApiError && error.code === 'near_rpc_bad_request') {
      result = null;
    } else {
      throw error;
    }
  }

  if (!result || result.__unknown) {
    return {
      txHash,
      found: false,
      success: false,
      sender: null,
      tokenContract: null,
      method: null,
      receiver: null,
      chainAmount: null,
      amountMinor: null,
      memo: null,
      accountArg: null,
      termsArg: null,
      agreementArg: null,
      signatureArg: null,
      explorerUrl: explorerTx(txHash),
    };
  }

  const actions = result.transaction?.actions ?? [];
  // Prefer an FT transfer when one is present, otherwise take the first call —
  // a read-only anchor is a `FunctionCall` too, just not an FT one.
  const action =
    actions.find(
      (candidate) => candidate.FunctionCall && FT_METHODS.has(candidate.FunctionCall.method_name),
    ) ?? actions.find((candidate) => candidate.FunctionCall);
  const decoded = action
    ? decodeCallArgs(action)
    : {
        receiverId: null,
        amount: null,
        memo: null,
        accountId: null,
        termsHash: null,
        agreementId: null,
        signature: null,
      };

  const chainAmount = decoded.amount;
  const amountMinor =
    chainAmount === null ? null : usdMinorFromChain(BigInt(chainAmount));

  return {
    txHash,
    found: true,
    success: result.status?.SuccessValue !== undefined,
    sender: result.transaction?.signer_id ?? null,
    tokenContract: result.transaction?.receiver_id ?? null,
    method: action?.FunctionCall?.method_name ?? null,
    receiver: decoded.receiverId,
    chainAmount,
    amountMinor,
    memo: decoded.memo,
    accountArg: decoded.accountId,
    termsArg: decoded.termsHash,
    agreementArg: decoded.agreementId,
    signatureArg: decoded.signature,
    explorerUrl: explorerTx(txHash),
  };
}

/**
 * The single gate between "someone pasted a tx hash" and "the share is paid".
 * Every mismatch is a 409 with a code the client can explain, never a silent
 * pass — a settlement that cannot be verified must not move the ledger.
 */
export async function verifyTransfer(input: {
  txHash: string;
  senderId: string;
  expectedReceiver: string;
  /** USDC base units from the frozen quote — exactly what the wallet was told. */
  expectedChainAmount: bigint;
}): Promise<NearTransfer> {
  if (!isNearConfigured()) {
    throw ApiError.conflict(
      'near_not_configured',
      'NEAR settlement is not configured on this server',
    );
  }

  const transfer = await getTransferStatus({
    txHash: input.txHash,
    senderId: input.senderId,
  });

  if (!transfer.found) {
    throw ApiError.conflict(
      'near_tx_not_found',
      'That transaction is not on chain yet — wait for the receipt and try again',
    );
  }
  if (!transfer.success) {
    throw ApiError.conflict(
      'near_tx_failed',
      'That transaction failed on chain, so nothing was transferred',
    );
  }
  if (transfer.sender !== input.senderId) {
    throw ApiError.conflict(
      'near_tx_wrong_sender',
      `That transaction was signed by ${transfer.sender ?? 'an unknown account'}, not the member paying this share`,
    );
  }
  if (transfer.tokenContract !== config.near.usdcContract) {
    throw ApiError.conflict(
      'near_tx_wrong_token',
      'That transaction called a different token contract',
    );
  }
  if (transfer.receiver !== input.expectedReceiver) {
    throw ApiError.conflict(
      'near_tx_wrong_receiver',
      `That transaction paid ${transfer.receiver ?? 'nobody'}, not ${input.expectedReceiver}`,
    );
  }
  const movedChainAmount =
    transfer.chainAmount === null ? null : BigInt(transfer.chainAmount);
  if (movedChainAmount !== input.expectedChainAmount) {
    throw ApiError.conflict(
      'near_tx_wrong_amount',
      `That transaction moved ${
        movedChainAmount === null
          ? 'no amount'
          : `${formatTokenUnits(movedChainAmount)} USDC`
      }, but this share was quoted ${formatTokenUnits(input.expectedChainAmount)} USDC`,
    );
  }

  return transfer;
}

/**
 * The native-NEAR sibling of `getTransferStatus`.
 *
 * A `Transfer` action addresses its payee directly, so `receiver` is the
 * transaction's `receiver_id` rather than an argument, and `chainAmount` is the
 * action's deposit in yoctoNEAR. `amountMinor` stays null: yoctoNEAR is not a
 * USD amount and is never treated as one.
 */
export async function getNativeTransferStatus(input: {
  txHash: string;
  senderId: string;
}): Promise<NearTransfer> {
  const txHash = input.txHash.trim();
  let result: RpcTxStatus | null = null;

  try {
    result = await rpc<RpcTxStatus>('tx', {
      tx_hash: txHash,
      sender_account_id: input.senderId,
      wait_until: 'NONE',
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'near_rpc_bad_request') {
      result = null;
    } else {
      throw error;
    }
  }

  if (!result) {
    return {
      txHash,
      found: false,
      success: false,
      sender: null,
      tokenContract: null,
      method: null,
      receiver: null,
      chainAmount: null,
      amountMinor: null,
      memo: null,
      accountArg: null,
      termsArg: null,
      agreementArg: null,
      signatureArg: null,
      explorerUrl: explorerTx(txHash),
    };
  }

  const actions = result.transaction?.actions ?? [];
  const transfer = actions.find((candidate) => candidate.Transfer);

  return {
    txHash,
    found: true,
    success: result.status?.SuccessValue !== undefined,
    sender: result.transaction?.signer_id ?? null,
    // Native transfers call no contract, whatever the receiver happens to be.
    tokenContract: null,
    method: transfer ? 'Transfer' : null,
    receiver: result.transaction?.receiver_id ?? null,
    chainAmount: transfer?.Transfer?.deposit ?? null,
    amountMinor: null,
    memo: null,
    accountArg: null,
    termsArg: null,
    agreementArg: null,
    signatureArg: null,
    explorerUrl: explorerTx(txHash),
  };
}

/** yoctoNEAR per NEAR — the native asset's own decimals. */
export const YOCTO_PER_NEAR = 10n ** 24n;

/**
 * Prove that a hash is a native NEAR transfer to the expected account for the
 * expected amount. Same six-gate discipline as `verifyTransfer`: any mismatch
 * is a 409, never a silent pass, and there is no token-contract gate because
 * the asset is the chain's own coin.
 */
export async function verifyNativeTransfer(input: {
  txHash: string;
  senderId: string;
  expectedReceiver: string;
  /** yoctoNEAR from the frozen quote — exactly what the wallet was told. */
  expectedYocto: bigint;
}): Promise<NearTransfer> {
  const transfer = await getNativeTransferStatus({
    txHash: input.txHash,
    senderId: input.senderId,
  });

  if (!transfer.found) {
    throw ApiError.conflict(
      'near_tx_not_found',
      'That transaction is not on chain yet — wait for the receipt and try again',
    );
  }
  if (!transfer.success) {
    throw ApiError.conflict(
      'near_tx_failed',
      'That transaction failed on chain, so nothing was transferred',
    );
  }
  if (transfer.sender !== input.senderId) {
    throw ApiError.conflict(
      'near_tx_wrong_sender',
      `That transaction was signed by ${transfer.sender ?? 'an unknown account'}, not the donor`,
    );
  }
  if (transfer.method !== 'Transfer') {
    throw ApiError.conflict(
      'near_tx_not_native_transfer',
      'That transaction is not a native NEAR transfer',
    );
  }
  if (transfer.receiver !== input.expectedReceiver) {
    throw ApiError.conflict(
      'near_tx_wrong_receiver',
      `That transaction paid ${transfer.receiver ?? 'nobody'}, not ${input.expectedReceiver}`,
    );
  }
  const movedYocto = transfer.chainAmount === null ? null : BigInt(transfer.chainAmount);
  if (movedYocto !== input.expectedYocto) {
    throw ApiError.conflict(
      'near_tx_wrong_amount',
      `That transaction moved ${
        movedYocto === null ? 'no amount' : `${formatTokenUnits(movedYocto, 24)} NEAR`
      }, but this gift was quoted ${formatTokenUnits(input.expectedYocto, 24)} NEAR`,
    );
  }

  return transfer;
}
