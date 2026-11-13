/**
 * Social Money as the app sees it: treasuries, the bounty board, claims,
 * payouts and contributor trust.
 *
 * Nothing here signs. `POST /bounties/:id/payout` returns the unsigned
 * `add_proposal` transaction and the member's wallet makes the proposal;
 * `POST /payouts/:id/tx` only stores the hash the wallet produced. Creating a
 * DAO is the same shape: the server encodes the factory `create`, the wallet
 * signs and pays for its storage.
 */

import type { FastifyPluginAsync } from 'fastify';

import { query } from '../db/pool.js';
import { requireMember } from '../lib/access.js';
import { ApiError } from '../lib/http-error.js';
import {
  claimBounty,
  createBounty,
  decideClaim,
  getBounty,
  listBounties,
  listPublicBounties,
  listTreasuries,
  listTrust,
  planBountyPayout,
  prepareBountyPayout,
  recordPayoutTx,
  registerTreasury,
  submitClaim,
  syncPayout,
  syncTreasuryPolicy,
  type SocialCapsInput,
} from '../lib/social.js';
import {
  asRecord,
  currencyCode,
  enumValue,
  optionalDate,
  optionalString,
  pathUuid,
  requiredMinor,
  requiredString,
  requiredUuid,
} from '../lib/validate.js';
import {
  daoAccountExists,
  daoAccountForName,
  daoNameFromInput,
  prepareCreateDao,
  waitForPolicy,
} from '../lib/sputnik.js';

type IdParams = { Params: { id: string } };
type GroupParams = { Params: { groupId: string } };

/** Same screen as `routes/fund.ts`: reject junk before the RPC sees it. */
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

const ASSETS = ['near', 'usdc'] as const;
const VISIBILITIES = ['group', 'public'] as const;
const DECISIONS = ['approve', 'reject'] as const;

/** Council means owner or fronter everywhere in this track. */
function requireCouncil(role: string): void {
  if (role !== 'owner' && role !== 'fronter') {
    throw ApiError.forbidden('Only the owner or the fronter can do this');
  }
}

async function treasuryGroupId(treasuryId: string): Promise<string> {
  const { rows } = await query<{ group_id: string }>(
    'select group_id from dao_treasuries where id = $1',
    [treasuryId],
  );
  const row = rows[0];
  if (!row) {
    throw new ApiError(404, 'treasury_not_found', 'That treasury is not registered');
  }
  return row.group_id;
}

async function bountyGroupId(bountyId: string): Promise<string> {
  const { rows } = await query<{ group_id: string }>(
    'select group_id from bounties where id = $1',
    [bountyId],
  );
  const row = rows[0];
  if (!row) {
    throw new ApiError(404, 'bounty_not_found', 'That bounty is not on this board');
  }
  return row.group_id;
}

async function payoutGroupId(payoutId: string): Promise<string> {
  const { rows } = await query<{ group_id: string }>(
    `select b.group_id
       from bounty_payouts p
       join bounties b on b.id = p.bounty_id
      where p.id = $1`,
    [payoutId],
  );
  const row = rows[0];
  if (!row) throw ApiError.notFound('Payout not found');
  return row.group_id;
}

async function groupCurrency(groupId: string): Promise<string> {
  const { rows } = await query<{ default_currency: string }>(
    'select default_currency from groups where id = $1',
    [groupId],
  );
  return rows[0]?.default_currency.trim() ?? 'USD';
}

/** Every write on this track is signed by the member, so the account must exist. */
async function memberNearAccount(userId: string, action: string): Promise<string> {
  const { rows } = await query<{ near_account: string | null }>(
    'select near_account from users where id = $1',
    [userId],
  );
  const account = rows[0]?.near_account;
  if (!account) {
    throw ApiError.conflict(
      'member_near_missing',
      `Link your NEAR account before ${action} — the transaction has to be signed by you`,
    );
  }
  return account;
}

/**
 * The default council: whoever can already manage the group's money. Members
 * without a linked NEAR account cannot approve on-chain, so they are skipped.
 */
async function councilNearAccounts(groupId: string): Promise<string[]> {
  const { rows } = await query<{ near_account: string }>(
    `select u.near_account
       from members m
       join users u on u.id = m.user_id
      where m.group_id = $1
        and m.status = 'active'
        and m.role in ('owner', 'fronter')
        and u.near_account is not null`,
    [groupId],
  );
  return rows.map((row) => row.near_account.toLowerCase());
}

/**
 * Caps are optional per field so a registration can override one and keep the
 * `config.social` default for the rest.
 */
function capsFrom(body: Record<string, unknown>): Partial<SocialCapsInput> | undefined {
  const raw = body.caps;
  if (raw === undefined || raw === null) return undefined;

  const caps = asRecord(raw);
  const out: Partial<SocialCapsInput> = {};

  if (caps.autoApproveCapMinor !== undefined) {
    out.autoApproveCapMinor = requiredMinor(caps, 'autoApproveCapMinor');
  }
  if (caps.midApproveCapMinor !== undefined) {
    out.midApproveCapMinor = requiredMinor(caps, 'midApproveCapMinor');
  }
  if (caps.periodCapMinor !== undefined) {
    out.periodCapMinor = requiredMinor(caps, 'periodCapMinor');
  }
  if (caps.periodDays !== undefined) {
    const days = caps.periodDays;
    if (typeof days !== 'number' || !Number.isSafeInteger(days)) {
      throw ApiError.badRequest('invalid_periodDays', 'periodDays must be a whole number');
    }
    out.periodDays = days;
  }

  return out;
}

export const socialRoutes: FastifyPluginAsync = async (app) => {
  /** The group's treasuries plus the policy snapshot stored at registration. */
  app.get<GroupParams>('/groups/:groupId/treasuries', async (request) => {
    const groupId = pathUuid(request.params.groupId, 'groupId');
    await requireMember(request, groupId);

    return { treasuries: await listTreasuries(groupId) };
  });

  /** Registering a DAO reads its policy once; owner or fronter only. */
  app.post<GroupParams>('/groups/:groupId/treasuries', async (request) => {
    const groupId = pathUuid(request.params.groupId, 'groupId');
    const member = await requireMember(request, groupId);
    requireCouncil(member.role);

    const body = asRecord(request.body);
    const label = requiredString(body, 'label', { min: 2, max: 80 });
    const daoAccount = requiredString(body, 'daoAccount', { min: 2, max: 64 });
    const network = optionalString(body, 'network', 16);

    return registerTreasury({
      groupId,
      userId: member.userId,
      label,
      daoAccount,
      network: network ?? undefined,
      caps: capsFrom(body),
    });
  });

  /** Refresh the stored `get_policy()` snapshot. */
  app.post<IdParams>('/treasuries/:id/sync', async (request) => {
    const treasuryId = pathUuid(request.params.id);
    await requireMember(request, await treasuryGroupId(treasuryId));

    return syncTreasuryPolicy(treasuryId);
  });

  /**
   * The unsigned factory `create` for a group that has no DAO yet. The member's
   * wallet signs and pays the storage deposit; the server never holds a key.
   * The council defaults to the group's owner and fronters, so the caller only
   * picks a name and a label.
   */
  app.post<GroupParams>('/groups/:groupId/treasuries/create', async (request) => {
    const groupId = pathUuid(request.params.groupId, 'groupId');
    const member = await requireMember(request, groupId);
    requireCouncil(member.role);

    const body = asRecord(request.body);
    const name = daoNameFromInput(requiredString(body, 'name', { min: 2, max: 64 }));
    const label = requiredString(body, 'label', { min: 2, max: 80 });
    const purpose = optionalString(body, 'purpose', 280);

    const signerId = await memberNearAccount(member.userId, 'creating a DAO');

    const daoAccount = daoAccountForName(name);
    if (await daoAccountExists(daoAccount)) {
      throw ApiError.conflict(
        'dao_name_taken',
        `${daoAccount} already exists — pick another name`,
      );
    }

    const councilAccounts = await councilNearAccounts(groupId);
    if (!councilAccounts.includes(signerId)) councilAccounts.unshift(signerId);

    return prepareCreateDao({
      signerId,
      name,
      label,
      purpose: purpose ?? undefined,
      councilAccounts,
    });
  });

  /**
   * Register the DAO the factory just minted. "The transaction landed" and "the
   * DAO answers `get_policy`" are different facts, so this waits for the view
   * before writing the row — a treasury that cannot be read cannot be paid from.
   */
  app.post<GroupParams>('/groups/:groupId/treasuries/create/confirm', async (request) => {
    const groupId = pathUuid(request.params.groupId, 'groupId');
    const member = await requireMember(request, groupId);
    requireCouncil(member.role);

    const body = asRecord(request.body);
    const daoAccount = requiredString(body, 'daoAccount', { min: 2, max: 64 }).toLowerCase();
    const label = requiredString(body, 'label', { min: 2, max: 80 });

    await waitForPolicy(daoAccount);

    return registerTreasury({
      groupId,
      userId: member.userId,
      label,
      daoAccount,
      caps: capsFrom(body),
    });
  });

  /** The board. The preset sweep runs inside the lib call, never from bills. */
  app.get<GroupParams>('/groups/:groupId/bounties', async (request) => {
    const groupId = pathUuid(request.params.groupId, 'groupId');
    await requireMember(request, groupId);

    return { bounties: await listBounties(groupId) };
  });

  /** Manual bounties only; presets are generated lazily on read. */
  app.post<GroupParams>('/groups/:groupId/bounties', async (request) => {
    const groupId = pathUuid(request.params.groupId, 'groupId');
    const member = await requireMember(request, groupId);
    requireCouncil(member.role);

    const body = asRecord(request.body);

    const title = requiredString(body, 'title', { min: 3, max: 160 });
    const description = optionalString(body, 'description', 2000) ?? '';
    const category = optionalString(body, 'category', 40);
    const amountMinor = requiredMinor(body, 'amountMinor');
    const currency = currencyCode(body.currency ?? (await groupCurrency(groupId)));
    const asset = enumValue(body, 'asset', ASSETS, 'near');
    const visibility = enumValue(body, 'visibility', VISIBILITIES, 'group');
    const deadline = optionalDate(body, 'deadline');
    const treasuryId =
      body.treasuryId === undefined || body.treasuryId === null
        ? null
        : requiredUuid(body, 'treasuryId');

    return createBounty({
      groupId,
      userId: member.userId,
      treasuryId,
      title,
      description,
      category: category ?? undefined,
      asset,
      amountMinor,
      currency,
      deadline: deadline ? deadline.toISOString() : null,
      visibility,
    });
  });

  /** Detail: the bounty, its claims, its payouts and its event log. */
  app.get<IdParams>('/bounties/:id', async (request) => {
    const bountyId = pathUuid(request.params.id);
    await requireMember(request, await bountyGroupId(bountyId));

    return getBounty(bountyId);
  });

  /** A member takes an open bounty. */
  app.post<IdParams>('/bounties/:id/claim', async (request) => {
    const bountyId = pathUuid(request.params.id);
    const member = await requireMember(request, await bountyGroupId(bountyId));

    return claimBounty(bountyId, member);
  });

  /** The claimer files the note and the evidence link. */
  app.post<IdParams>('/bounties/:id/submit', async (request) => {
    const bountyId = pathUuid(request.params.id);
    const member = await requireMember(request, await bountyGroupId(bountyId));

    const body = asRecord(request.body);
    const note = requiredString(body, 'note', { min: 3, max: 2000 });
    const evidenceUrl = optionalString(body, 'evidenceUrl', 500);

    return submitClaim(bountyId, member, { note, evidenceUrl });
  });

  /** Council approves or rejects. Approval moves no money. */
  app.post<IdParams>('/bounties/:id/decide', async (request) => {
    const bountyId = pathUuid(request.params.id);
    const member = await requireMember(request, await bountyGroupId(bountyId));
    requireCouncil(member.role);

    const body = asRecord(request.body);
    const claimId = requiredUuid(body, 'claimId');
    const decision = enumValue(body, 'decision', DECISIONS);
    const note = optionalString(body, 'note', 500);

    return decideClaim(claimId, member, { decision, note });
  });

  /** Tier, role, approvals and headroom — a read, no row written. */
  app.post<IdParams>('/bounties/:id/payout/preview', async (request) => {
    const bountyId = pathUuid(request.params.id);
    const member = await requireMember(request, await bountyGroupId(bountyId));

    const body = asRecord(request.body);
    const claimId = requiredUuid(body, 'claimId');

    const plan = await planBountyPayout(claimId, member.id);
    if (plan.bountyId !== bountyId) {
      throw new ApiError(404, 'claim_not_found', 'That claim belongs to another bounty');
    }

    return plan;
  });

  /**
   * Builds the unsigned `add_proposal` transaction and freezes the payout row.
   * The wallet signs; the server never sees a key.
   */
  app.post<IdParams>('/bounties/:id/payout', async (request) => {
    const bountyId = pathUuid(request.params.id);
    const member = await requireMember(request, await bountyGroupId(bountyId));

    const body = asRecord(request.body);
    const claimId = requiredUuid(body, 'claimId');

    const plan = await planBountyPayout(claimId, member.id);
    if (plan.bountyId !== bountyId) {
      throw new ApiError(404, 'claim_not_found', 'That claim belongs to another bounty');
    }

    return prepareBountyPayout(claimId, member.id);
  });

  /** Stores the hash the wallet broadcast. */
  app.post<IdParams>('/payouts/:id/tx', async (request) => {
    const payoutId = pathUuid(request.params.id);
    await requireMember(request, await payoutGroupId(payoutId));

    const body = asRecord(request.body);
    const txHash = body.txHash;
    if (typeof txHash !== 'string' || !TX_HASH.test(txHash.trim())) {
      throw ApiError.badRequest(
        'invalid_txHash',
        'txHash must be the base58 hash of the transfer',
      );
    }
    const proposalId = optionalString(body, 'proposalId', 64);

    return recordPayoutTx(payoutId, txHash.trim(), proposalId);
  });

  /** Reads `get_proposal` and settles the row; on execution, trust follows. */
  app.post<IdParams>('/payouts/:id/sync', async (request) => {
    const payoutId = pathUuid(request.params.id);
    await requireMember(request, await payoutGroupId(payoutId));

    return syncPayout(payoutId);
  });

  /** Contributor reputation for the group. */
  app.get<GroupParams>('/groups/:groupId/trust', async (request) => {
    const groupId = pathUuid(request.params.groupId, 'groupId');
    await requireMember(request, groupId);

    return { contributors: await listTrust(groupId) };
  });

  /** The one unauthenticated surface: public bounties only. */
  app.get('/public/board', async () => {
    return { bounties: await listPublicBounties() };
  });
};
