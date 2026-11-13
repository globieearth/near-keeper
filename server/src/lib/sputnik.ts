/**
 * Sputnik DAO V2 — read the policy, and encode wallet-ready proposals.
 *
 * Track 12 is explicit that the multisig must not be rebuilt: a community
 * already owns a Sputnik DAO (or a Trezu vault in front of one), and this
 * module is the thin adapter that lets Globie Keeper pay a bounty out of it.
 * The server holds no key. It reads `get_policy` to learn which role is allowed
 * to approve a payout and how many approvals that role needs, then hands the
 * member's own wallet an `add_proposal` / `act_proposal` transaction. The chain
 * remains the only authority on whether money moved.
 *
 * Only the transaction envelope is borsh (`near_primitives` is a borsh wire
 * format). The *arguments* are JSON: Sputnik's `ProposalInput` is annotated
 * `#[near(serializers=[json])]`, so a borsh body is rejected by the contract
 * with "Failed to deserialize input from JSON". `add_proposal` also takes its
 * struct as a named argument, hence the `{ proposal: … }` wrapper.
 *
 * The borsh writers live here rather than in lib/near.ts on purpose: that file
 * is the settlement rail's single source of truth for transfers, and exporting
 * its private helpers for a second caller would make every future change there
 * a risk to both features. Duplicating four tiny integer writers is the cheaper
 * boundary.
 *
 * A group with no DAO yet gets one through the factory (`create`), and that is
 * still not a reimplementation: the factory deploys the canonical Sputnik code,
 * the member's wallet signs, and the wallet pays the 6 NEAR storage deposit.
 * This module only encodes the call, exactly as it encodes `add_proposal`.
 */

import { config } from './config.js';
import { ApiError } from './http-error.js';
import { base58Decode, isNearAccountId, rpc } from './near.js';

/** 0.01 NEAR in yoctoNEAR; the smallest unit the balance message shows. */
const NEAR_CENT = 10n ** 22n;

/** `Action` enum variants, `near_primitives::transaction::Action`. */
const ACTION_FUNCTION_CALL = 2;

/** `Action` variants, `sputnikdao2::proposal::Action`. */
export const PROPOSAL_VOTE_APPROVE = 'VoteApprove';
export const PROPOSAL_VOTE_REJECT = 'VoteReject';
export const PROPOSAL_VOTE_REMOVE = 'VoteRemove';
export const PROPOSAL_FINALIZE = 'Finalize';

export type SputnikProposalAction =
  | typeof PROPOSAL_VOTE_APPROVE
  | typeof PROPOSAL_VOTE_REJECT
  | typeof PROPOSAL_VOTE_REMOVE
  | typeof PROPOSAL_FINALIZE;

/** Capped well under the protocol ceiling: a proposal is not a heavy call. */
const ADD_PROPOSAL_GAS = 200_000_000_000_000n;
const ACT_PROPOSAL_GAS = 300_000_000_000_000n;
/** The factory deploys the DAO code and initialises it in one receipt. */
const CREATE_DAO_GAS = 300_000_000_000_000n;
/** One yoctoNEAR is required for a cross-contract callback receipt. */
const ONE_YOCTO = 1n;

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
  return Buffer.concat([
    borshU32(Buffer.byteLength(value, 'utf8')),
    Buffer.from(value, 'utf8'),
  ]);
}

function ensureRpc(): void {
  if (!config.near.rpcUrl) {
    throw ApiError.conflict(
      'near_not_configured',
      'NEAR is not configured on this server, so a DAO payout cannot be prepared',
    );
  }
}

/**
 * A read-only JSON view. Sputnik returns borsh-safe JSON strings, so a failed
 * decode is a configuration error, not an empty result the caller can ignore.
 */
async function viewJson<T>(
  accountId: string,
  methodName: string,
  args: Record<string, unknown> = {},
  missingMarker?: string,
): Promise<T> {
  ensureRpc();

  const result = await rpc<{ result?: number[]; error?: string }>('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: accountId,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args), 'utf8').toString('base64'),
  });

  if (typeof result?.error === 'string') {
    // Sputnik panics instead of returning `null` for an unknown proposal id, so
    // the caller that can live with "not there yet" names the panic to absorb.
    if (missingMarker && result.error.includes(missingMarker)) return null as T;
    throw ApiError.conflict(
      'dao_view_failed',
      `${accountId}.${methodName} failed: ${result.error.slice(0, 200)}`,
    );
  }

  const bytes = result?.result;
  if (!Array.isArray(bytes)) {
    throw ApiError.conflict(
      'dao_view_failed',
      `${accountId}.${methodName} returned no value`,
    );
  }

  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as T;
  } catch {
    throw ApiError.conflict(
      'dao_view_failed',
      `${accountId}.${methodName} did not return JSON`,
    );
  }
}

export type SputnikRole = {
  name: string;
  kind?: unknown;
  permissions?: string[];
  vote_policy?: unknown;
};

export type SputnikPolicy = {
  roles?: SputnikRole[];
  default_vote_policy?: {
    threshold?: unknown;
    quorum?: unknown;
    weight_kind?: string;
  };
  proposal_bond?: string;
  proposal_period?: string;
};

export async function getPolicy(daoAccount: string): Promise<SputnikPolicy> {
  if (!isNearAccountId(daoAccount)) {
    throw ApiError.badRequest('invalid_dao_account', 'That is not a NEAR account id');
  }
  return viewJson<SputnikPolicy>(daoAccount, 'get_policy');
}

/**
 * The factory call succeeds before the new account answers `get_policy` — the
 * deploy and the `new` initialisation are separate receipts. Poll briefly so a
 * registration never writes a row for a DAO the chain does not know yet.
 */
export async function waitForPolicy(
  daoAccount: string,
  attempts = 4,
  delayMs = 1_500,
): Promise<SputnikPolicy> {
  if (!isNearAccountId(daoAccount)) {
    throw ApiError.badRequest('invalid_dao_account', 'That is not a NEAR account id');
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await getPolicy(daoAccount);
    } catch (error) {
      const retriable =
        error instanceof ApiError &&
        (error.code === 'dao_view_failed' || error.code === 'near_rpc_bad_request');
      if (!retriable || attempt >= attempts - 1) {
        throw ApiError.conflict(
          'dao_not_readable',
          `${daoAccount} is not a Sputnik DAO we can read yet. If the transaction just landed, try again in a moment.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** `[1, 2]`, `"[1, 2]"` and a bare `1` all mean "numerator of a ratio". */
function readRatio(value: unknown): { numerator: number; denominator: number } {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { numerator: value, denominator: 1 };
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try {
        return readRatio(JSON.parse(trimmed) as unknown);
      } catch {
        return { numerator: 1, denominator: 1 };
      }
    }
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed)
      ? { numerator: parsed, denominator: 1 }
      : { numerator: 1, denominator: 1 };
  }
  if (Array.isArray(value) && value.length === 2) {
    const numerator = Number(value[0]);
    const denominator = Number(value[1]);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
      return { numerator, denominator };
    }
  }
  return { numerator: 1, denominator: 1 };
}

/** How many members a role's `kind` names, when the policy spells it out. */
function roleMemberCount(kind: unknown): number {
  if (kind === 'Everyone') return 1;
  if (!kind || typeof kind !== 'object') return 1;

  const group = (kind as { Group?: unknown }).Group;
  if (Array.isArray(group)) return Math.max(1, group.length);

  if ((kind as { Member?: unknown }).Member) return 1;
  return 1;
}

export type RoleRequirement = {
  name: string;
  exists: boolean;
  /** Members the role names, so the UI can say "2 of 3 council". */
  memberCount: number;
  /** Approvals the role's threshold implies for that member count. */
  requiredApprovals: number;
};

/**
 * Translate a role's vote policy into a number a person can act on. The chain
 * still decides; this only lets the API refuse a payout before a wallet is
 * opened, and lets the screen say how many signatures are needed.
 */
export function describeRole(
  policy: SputnikPolicy,
  roleName: string,
): RoleRequirement {
  const role = (policy.roles ?? []).find((entry) => entry.name === roleName);
  if (!role) {
    return { name: roleName, exists: false, memberCount: 0, requiredApprovals: 1 };
  }

  const votePolicy =
    role.vote_policy && typeof role.vote_policy === 'object'
      ? (role.vote_policy as { threshold?: unknown })
      : {};
  const ratio = readRatio(
    votePolicy.threshold ?? policy.default_vote_policy?.threshold ?? 1,
  );

  const memberCount = roleMemberCount(role.kind);
  const approvals = Math.ceil((memberCount * ratio.numerator) / ratio.denominator);

  return {
    name: roleName,
    exists: true,
    memberCount,
    requiredApprovals: Math.min(32, Math.max(1, approvals)),
  };
}

/** The bond a new proposal must carry, in yoctoNEAR, as the policy reports it. */
export function proposalBondYocto(policy: SputnikPolicy): bigint {
  const raw = policy.proposal_bond;
  if (typeof raw !== 'string') return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}

/**
 * `ProposalKind::Transfer { token_id, receiver_id, amount, msg }`. An empty
 * `token_id` is Sputnik's spelling of "native NEAR". `deny_unknown_fields` is
 * on, so the object carries exactly these four keys.
 */
export type SputnikProposalKind =
  | {
      Transfer: {
        token_id: string;
        receiver_id: string;
        amount: string;
        msg: string | null;
      };
    }
  | {
      FunctionCall: {
        receiver_id: string;
        actions: {
          method_name: string;
          args: string;
          deposit: string;
          gas: string;
        }[];
      };
    };

/** `ProposalKind::Transfer` of native NEAR — no cross-contract call needed. */
export function nativeTransferKind(receiverId: string, yocto: bigint): SputnikProposalKind {
  if (!isNearAccountId(receiverId)) {
    throw ApiError.badRequest('invalid_recipient', 'The recipient is not a NEAR account id');
  }
  if (yocto <= 0n) {
    throw ApiError.badRequest('invalid_amount', 'A payout must move a positive amount');
  }

  return {
    Transfer: {
      token_id: '',
      receiver_id: receiverId,
      amount: yocto.toString(),
      msg: null,
    },
  };
}

/**
 * `ProposalKind::FunctionCall { receiver_id: token, actions: [ft_transfer] }`.
 * The DAO is the signer, so the token contract is the call target and the
 * contributor appears only inside `args.receiver_id`.
 */
export function ftTransferKind(input: {
  tokenContract: string;
  receiverId: string;
  baseUnits: bigint;
  memo?: string | null;
}): SputnikProposalKind {
  if (!isNearAccountId(input.tokenContract)) {
    throw ApiError.conflict(
      'usdc_not_configured',
      'USDC payouts are not configured on this server',
    );
  }
  if (!isNearAccountId(input.receiverId)) {
    throw ApiError.badRequest('invalid_recipient', 'The recipient is not a NEAR account id');
  }
  if (input.baseUnits <= 0n) {
    throw ApiError.badRequest('invalid_amount', 'A payout must move a positive amount');
  }

  const args = Buffer.from(
    JSON.stringify({
      receiver_id: input.receiverId,
      amount: input.baseUnits.toString(),
      ...(input.memo ? { memo: input.memo } : {}),
    }),
    'utf8',
  ).toString('base64');

  return {
    FunctionCall: {
      receiver_id: input.tokenContract,
      actions: [
        {
          method_name: 'ft_transfer',
          args,
          // One yoctoNEAR is required for a cross-contract callback receipt.
          deposit: ONE_YOCTO.toString(),
          gas: '30000000000000',
        },
      ],
    },
  };
}

/**
 * One `FunctionCall` action addressed to the DAO (or the factory). `args` is
 * already the JSON body the contract expects; only the envelope is borsh.
 * Exported so the factory call reuses the same envelope: a transaction is a
 * transaction, whether the receiver is a DAO or the contract that mints one.
 */
export function encodeProposalAction(input: {
  signerId: string;
  receiverId: string;
  methodName: string;
  args: Buffer;
  gas: bigint;
  deposit: bigint;
  blockHashBytes: Buffer;
}): string {
  const action = Buffer.concat([
    Buffer.from([ACTION_FUNCTION_CALL]),
    borshString(input.methodName),
    borshU32(input.args.length),
    input.args,
    borshU64(input.gas),
    borshU128(input.deposit),
  ]);

  return Buffer.concat([
    borshString(input.signerId),
    // PublicKey::ED25519 with 32 zero bytes — the wallet substitutes its key.
    Buffer.from([0]),
    Buffer.alloc(32),
    borshU64(0n),
    borshString(input.receiverId),
    input.blockHashBytes,
    borshU32(1),
    action,
  ]).toString('base64');
}

/**
 * The head of the chain, as the encoder needs it: the hash a transaction must
 * carry, and the current gas price so a balance check can price the call.
 */
async function recentBlock(): Promise<{ hashBytes: Buffer; gasPriceYocto: bigint }> {
  const block = await rpc<{ header?: { hash?: string; gas_price?: string } }>('block', {
    finality: 'optimistic',
  });
  const text = block.header?.hash;
  if (!text) {
    throw ApiError.conflict('near_block_unavailable', 'NEAR returned no recent block hash');
  }
  const bytes = base58Decode(text);
  if (bytes.length !== 32) {
    throw ApiError.conflict('near_block_unavailable', 'NEAR returned a malformed block hash');
  }

  let gasPriceYocto = 0n;
  try {
    gasPriceYocto = BigInt(block.header?.gas_price ?? '0');
  } catch {
    // A missing price only makes the balance check laxer; the chain still decides.
  }

  return { hashBytes: bytes, gasPriceYocto };
}

export async function recentBlockBytes(): Promise<Buffer> {
  return (await recentBlock()).hashBytes;
}

/** The signer's liquid balance, in yoctoNEAR. */
async function accountBalanceYocto(accountId: string): Promise<bigint> {
  const account = await rpc<{ amount?: string }>('query', {
    request_type: 'view_account',
    finality: 'final',
    account_id: accountId,
  });
  try {
    return BigInt(account?.amount ?? '0');
  } catch {
    throw ApiError.conflict(
      'near_balance_unreadable',
      `NEAR returned no readable balance for ${accountId}`,
    );
  }
}

/** Rounded up to 0.01 NEAR, so a shortfall is never understated. */
function nearDisplay(yocto: bigint): string {
  const cents = (yocto + NEAR_CENT - 1n) / NEAR_CENT;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/**
 * The unsigned `add_proposal` behind a payout. `deposit` is the DAO's own
 * `proposal_bond`; Sputnik returns it when the proposal is finalized, so the
 * bond is a temporary lock rather than a fee.
 */
export async function prepareAddProposal(input: {
  signerId: string;
  daoAccount: string;
  description: string;
  kind: SputnikProposalKind;
  bondYocto: bigint;
}): Promise<{ transaction: string; blockHash: string }> {
  ensureRpc();
  if (!isNearAccountId(input.signerId) || !isNearAccountId(input.daoAccount)) {
    throw ApiError.badRequest('invalid_account', 'Both accounts must be NEAR account ids');
  }

  const args = Buffer.from(
    JSON.stringify({ proposal: { description: input.description, kind: input.kind } }),
    'utf8',
  );

  const blockHashBytes = await recentBlockBytes();

  return {
    transaction: encodeProposalAction({
      signerId: input.signerId,
      receiverId: input.daoAccount,
      methodName: 'add_proposal',
      args,
      gas: ADD_PROPOSAL_GAS,
      deposit: input.bondYocto,
      blockHashBytes,
    }),
    blockHash: blockHashBytes.toString('base64'),
  };
}

/** The unsigned `act_proposal`: vote, reject, remove or finalize. */
export async function prepareActProposal(input: {
  signerId: string;
  daoAccount: string;
  proposalId: string;
  action: SputnikProposalAction;
}): Promise<{ transaction: string; blockHash: string }> {
  ensureRpc();
  if (!isNearAccountId(input.signerId) || !isNearAccountId(input.daoAccount)) {
    throw ApiError.badRequest('invalid_account', 'Both accounts must be NEAR account ids');
  }

  let proposalId: bigint;
  try {
    proposalId = BigInt(input.proposalId);
  } catch {
    throw ApiError.badRequest('invalid_proposal_id', 'proposalId must be a whole number');
  }

  // The view takes `u64` as a JSON number; a proposal id past 2^53 is not real.
  const id = Number(proposalId);
  if (!Number.isSafeInteger(id)) {
    throw ApiError.badRequest('invalid_proposal_id', 'proposalId is out of range');
  }

  const args = Buffer.from(
    JSON.stringify({ id, action: input.action }),
    'utf8',
  );
  const blockHashBytes = await recentBlockBytes();

  return {
    transaction: encodeProposalAction({
      signerId: input.signerId,
      receiverId: input.daoAccount,
      methodName: 'act_proposal',
      args,
      gas: ACT_PROPOSAL_GAS,
      deposit: 0n,
      blockHashBytes,
    }),
    blockHash: blockHashBytes.toString('base64'),
  };
}

export type SputnikProposal = {
  id: number;
  proposer: string;
  description: string;
  status: string;
  kind?: unknown;
  vote_counts?: Record<string, unknown>;
  votes?: Record<string, string>;
};

/** `<name>.<factory>` — the account the factory will mint. */
export function daoAccountForName(name: string): string {
  return `${name}.${config.near.daoFactoryAccount}`;
}

/**
 * The factory takes a bare label, not a full account id: it appends its own
 * suffix. Lowercase letters, digits, and single `-`/`_` separators are legal.
 */
export function daoNameFromInput(raw: string): string {
  const name = raw.trim().toLowerCase();
  const maxLength = 64 - config.near.daoFactoryAccount.length - 1;

  if (!/^[a-z\d]+(?:[-_][a-z\d]+)*$/.test(name)) {
    throw ApiError.badRequest(
      'invalid_dao_name',
      'Use lowercase letters, digits, dashes or underscores — no dots',
    );
  }
  if (name.length < 2 || name.length > maxLength) {
    throw ApiError.badRequest(
      'invalid_dao_name',
      `A DAO name must be 2–${maxLength} characters on this network`,
    );
  }

  return name;
}

/**
 * Is the name already minted? A `view_account` for a missing account is a 4xx
 * with "does not exist" — everything else is a real failure and must not be
 * mistaken for "free".
 */
export async function daoAccountExists(daoAccount: string): Promise<boolean> {
  ensureRpc();
  try {
    await rpc('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: daoAccount,
    });
    return true;
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.code === 'near_rpc_bad_request' &&
      /does not exist/i.test(error.message)
    ) {
      return false;
    }
    throw error;
  }
}

export type PreparedDaoCreation = {
  transaction: string;
  blockHash: string;
  /** `<name>.<factory>` — where the DAO will live once the tx lands. */
  daoAccount: string;
  name: string;
  factoryAccount: string;
  network: string;
  depositYocto: string;
};

/**
 * The unsigned factory `create`. `policy: [accounts]` is the untagged
 * `VersionedPolicy::Default` variant: Sputnik expands it into the standard
 * `all` + `council` roles, a 1-of-2 (majority) council vote policy, a 1 NEAR
 * proposal bond and a 7 day proposal period. That is the "defaults" button;
 * a custom policy would use the `Current(Policy)` object instead.
 *
 * The signer pays `depositYocto` (6 NEAR), the factory deploys the canonical
 * Sputnik code and calls `new`, then refunds whatever storage it did not use.
 */
export async function prepareCreateDao(input: {
  signerId: string;
  name: string;
  label: string;
  purpose?: string;
  councilAccounts: string[];
}): Promise<PreparedDaoCreation> {
  ensureRpc();
  if (!isNearAccountId(input.signerId)) {
    throw ApiError.badRequest('invalid_account', 'The signer must be a NEAR account id');
  }

  const name = daoNameFromInput(input.name);

  const council: string[] = [];
  for (const raw of input.councilAccounts) {
    const account = raw.trim().toLowerCase();
    if (!isNearAccountId(account)) {
      throw ApiError.badRequest(
        'invalid_council_account',
        `${raw} is not a NEAR account id, so it cannot sit on the council`,
      );
    }
    if (!council.includes(account)) council.push(account);
  }
  if (council.length === 0) {
    throw ApiError.badRequest(
      'council_required',
      'A DAO needs at least one council account to approve its proposals',
    );
  }

  // The factory's own JSON body is `{ name, args }`, and `args` is a
  // `Base64VecU8`: the factory hands those bytes to the new DAO's `new`.
  const initArgs = Buffer.from(
    JSON.stringify({
      config: {
        name: input.label.trim() || name,
        purpose: input.purpose?.trim() || '',
        // `Base64VecU8` — an empty string is an empty blob, not `[]`.
        metadata: '',
      },
      policy: council,
    }),
    'utf8',
  ).toString('base64');

  const args = Buffer.from(JSON.stringify({ name, args: initArgs }), 'utf8');

  const block = await recentBlock();
  const daoAccount = daoAccountForName(name);
  const depositYocto = config.near.daoCreationDepositYocto;

  // The wallet would reject an underfunded transaction with a raw RPC string
  // ("Sender X does not have enough balance …"), so price the call first and
  // say which account needs how much.
  const feeYocto = block.gasPriceYocto * CREATE_DAO_GAS;
  const costYocto = depositYocto + feeYocto;
  const balanceYocto = await accountBalanceYocto(input.signerId);
  if (balanceYocto < costYocto) {
    throw ApiError.conflict(
      'insufficient_near_balance',
      `${input.signerId} holds ${nearDisplay(balanceYocto)} NEAR, but creating a DAO costs about ` +
        `${nearDisplay(costYocto)} NEAR — a ${nearDisplay(depositYocto)} NEAR storage deposit ` +
        `plus about ${nearDisplay(feeYocto)} NEAR of gas. ` +
        `Top up at least ${nearDisplay(costYocto - balanceYocto)} NEAR and try again.`,
    );
  }

  return {
    transaction: encodeProposalAction({
      signerId: input.signerId,
      receiverId: config.near.daoFactoryAccount,
      methodName: 'create',
      args,
      gas: CREATE_DAO_GAS,
      deposit: depositYocto,
      blockHashBytes: block.hashBytes,
    }),
    blockHash: block.hashBytes.toString('base64'),
    daoAccount,
    name,
    factoryAccount: config.near.daoFactoryAccount,
    network: config.near.network,
    depositYocto: depositYocto.toString(),
  };
}

/**
 * `get_proposal` returns the `Proposal` JSON object itself (`Option<Proposal>`
 * flattens to `T` or `null`), and an unknown id panics with `ERR_NO_PROPOSAL`.
 */
export async function getProposal(
  daoAccount: string,
  proposalId: string,
): Promise<SputnikProposal | null> {
  let id: bigint;
  try {
    id = BigInt(proposalId);
  } catch {
    throw ApiError.badRequest('invalid_proposal_id', 'proposalId must be a whole number');
  }

  // The RPC view takes u64 as a JSON number; anything past 2^53 is not a real
  // proposal id on any deployed DAO.
  const asNumber = Number(id);
  if (!Number.isSafeInteger(asNumber)) {
    throw ApiError.badRequest('invalid_proposal_id', 'proposalId is out of range');
  }

  const response = await viewJson<SputnikProposal | null>(
    daoAccount,
    'get_proposal',
    { id: asNumber },
    'ERR_NO_PROPOSAL',
  );
  return response ?? null;
}
