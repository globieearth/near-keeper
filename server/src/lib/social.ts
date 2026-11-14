/**
 * Social Money — treasuries, bounties, payouts and contributor trust.
 *
 * The layer is additive. The group already owns a Sputnik DAO v2 (or Trezu)
 * multisig, and this module only reads its policy and builds an unsigned
 * `add_proposal` transaction. The server holds no key, never custodies funds and
 * never signs anything.
 *
 * Money rules that shape every query below:
 *   - `bounties.amount_minor` and `bounty_payouts.amount_minor` are `bigint`, so
 *     the pool's type-20 parser already returns them as numbers.
 *   - `bounties.chain_amount` and `bounty_payouts.chain_amount` are
 *     `numeric(40,0)`; numeric (oid 1700) has no parser installed, so they are
 *     read as `::text` and converted with `BigInt()`.
 *   - nothing here writes `ledger_events`, `points_awards` or `payments`.
 */
import { isUniqueViolation, query, withTransaction, type Db } from '../db/pool.js';
import type { MemberContext } from './access.js';
import { config } from './config.js';
import { getRates } from './fx.js';
import { ApiError } from './http-error.js';
import { currencyExponent, formatAmount } from './money.js';
import { chainFromUsdMinor, explorerTx, formatTokenUnits, isNearAccountId } from './near.js';
import {
  decidePayoutTier,
  trustScoreFor,
  type PayoutTier,
  type TreasuryCaps,
} from './payout-policy.js';
import {
  describeRole,
  ftTransferKind,
  getPolicy,
  getProposal,
  nativeTransferKind,
  prepareAddProposal,
  proposalBondYocto,
  type RoleRequirement,
  type SputnikPolicy,
  type SputnikProposal,
} from './sputnik.js';

const RATE_SCALE = 1_000_000_000_000n;
const RATE_DECIMALS = 12;

/** Reads that never span a transaction go through this thin adapter. */
const poolDb: Db = { query };

/** A preset bounty pays 1% of the money it rewards, capped at the auto tier. */
const PRESET_REWARD_BPS = 100;

const NEAR_DECIMALS = 24;

function chainDecimals(asset: string): number {
  return asset === 'usdc' ? config.near.usdcDecimals : NEAR_DECIMALS;
}

function chainSymbol(asset: string): string {
  return asset === 'usdc' ? 'USDC' : 'NEAR';
}

function iso(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString();
}

function decimalString(scaled: bigint): string {
  const whole = scaled / RATE_SCALE;
  const fraction = (scaled % RATE_SCALE)
    .toString()
    .padStart(RATE_DECIMALS, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function yoctoFromUsdMinor(usdMinor: number, nearPerUsd: number): { yocto: bigint; rate: string } {
  const rateScaled = BigInt(Math.round(nearPerUsd * Number(RATE_SCALE)));
  if (rateScaled <= 0n) {
    throw new ApiError(503, 'fx_unavailable', 'NEAR has no usable price right now');
  }
  const yocto = BigInt(usdMinor) * rateScaled * 10n ** 10n;
  return { yocto, rate: decimalString(rateScaled) };
}

/**
 * Convert a fiat amount into USD cents. `getRates(code)` throws its own
 * `503 fx_unavailable` when the upstream and the cache are both empty.
 */
async function usdMinorFor(
  amountMinor: number,
  currency: string,
): Promise<{ usdMinor: number; rate: number }> {
  const code = currency.trim().toUpperCase();
  if (code === 'USD') return { usdMinor: amountMinor, rate: 1 };

  const snapshot = await getRates(code);
  const rate = snapshot.rates.USD;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    throw new ApiError(503, 'fx_unavailable', `No USD rate is available for ${code} right now`);
  }

  const exponent = currencyExponent(code);
  const usdMinor =
    amountMinor <= 0
      ? 0
      : Math.max(1, Math.round((amountMinor / 10 ** exponent) * rate * 100));
  return { usdMinor, rate };
}

type ChainQuote = { asset: 'near' | 'usdc'; chainAmount: bigint; usdMinor: number };

/** The single fiat -> chain conversion used by both presets and manual bounties. */
async function chainAmountFor(
  asset: 'near' | 'usdc',
  amountMinor: number,
  currency: string,
): Promise<ChainQuote> {
  if (asset === 'usdc' && !config.near.usdcContract) {
    throw ApiError.conflict(
      'usdc_not_configured',
      'USDC rewards are not configured on this server',
    );
  }

  const { usdMinor } = await usdMinorFor(amountMinor, currency);

  if (asset === 'usdc') {
    return { asset, chainAmount: chainFromUsdMinor(usdMinor), usdMinor };
  }

  const snapshot = await getRates('USD');
  const nearPerUsd = snapshot.rates.NEAR;
  if (typeof nearPerUsd !== 'number' || !Number.isFinite(nearPerUsd) || nearPerUsd <= 0) {
    throw new ApiError(
      503,
      'fx_unavailable',
      'No NEAR price is available right now, so a reward cannot be priced in NEAR',
    );
  }

  const { yocto } = yoctoFromUsdMinor(usdMinor, nearPerUsd);
  return { asset, chainAmount: yocto, usdMinor };
}

async function memberIdForUser(db: Db, groupId: string, userId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `select id from members
      where group_id = $1 and user_id = $2 and status <> 'removed'`,
    [groupId, userId],
  );
  const row = rows[0];
  if (!row) throw ApiError.forbidden('You are not a member of this group');
  return row.id;
}

// ---------------------------------------------------------------------------
// Treasuries
// ---------------------------------------------------------------------------

export type SocialCapsInput = {
  autoApproveCapMinor: number;
  midApproveCapMinor: number;
  periodDays: number;
  periodCapMinor: number;
};

type TreasuryRow = {
  id: string;
  group_id: string;
  label: string;
  network: string;
  dao_account: string;
  source: string;
  auto_role: string;
  council_role: string;
  auto_approve_cap_minor: number;
  mid_approve_cap_minor: number;
  period_days: number;
  period_cap_minor: number;
  policy: SputnikPolicy | null;
  policy_synced_at: Date | null;
  created_by: string | null;
  created_at: Date;
};

const TREASURY_COLUMNS = `t.id, t.group_id, t.label, t.network, t.dao_account, t.source,
  t.auto_role, t.council_role, t.auto_approve_cap_minor, t.mid_approve_cap_minor,
  t.period_days, t.period_cap_minor, t.policy, t.policy_synced_at, t.created_by,
  t.created_at`;

export type TreasuryView = {
  id: string;
  groupId: string;
  label: string;
  network: string;
  daoAccount: string;
  source: string;
  autoRole: string;
  councilRole: string;
  caps: TreasuryCaps;
  periodDays: number;
  policy: SputnikPolicy | null;
  policySyncedAt: string | null;
  roles: { auto: RoleRequirement; council: RoleRequirement } | null;
  createdAt: string;
};

function mapTreasury(row: TreasuryRow): TreasuryView {
  return {
    id: row.id,
    groupId: row.group_id,
    label: row.label,
    network: row.network,
    daoAccount: row.dao_account,
    source: row.source,
    autoRole: row.auto_role,
    councilRole: row.council_role,
    caps: {
      autoApproveCapMinor: row.auto_approve_cap_minor,
      midApproveCapMinor: row.mid_approve_cap_minor,
      periodCapMinor: row.period_cap_minor,
    },
    periodDays: row.period_days,
    policy: row.policy,
    policySyncedAt: row.policy_synced_at ? iso(row.policy_synced_at) : null,
    roles: row.policy
      ? {
          auto: describeRole(row.policy, row.auto_role),
          council: describeRole(row.policy, row.council_role),
        }
      : null,
    createdAt: iso(row.created_at),
  };
}

export async function loadTreasury(db: Db, treasuryId: string): Promise<TreasuryRow> {
  const { rows } = await db.query<TreasuryRow>(
    `select ${TREASURY_COLUMNS} from dao_treasuries t where t.id = $1`,
    [treasuryId],
  );
  const row = rows[0];
  if (!row) {
    throw new ApiError(
      404,
      'treasury_not_found',
      'That treasury is not registered for this group',
    );
  }
  return row;
}

function resolveCaps(input: Partial<SocialCapsInput> | undefined): SocialCapsInput {
  const caps: SocialCapsInput = {
    autoApproveCapMinor: input?.autoApproveCapMinor ?? config.social.autoApproveCapMinor,
    midApproveCapMinor: input?.midApproveCapMinor ?? config.social.midApproveCapMinor,
    periodDays: input?.periodDays ?? config.social.periodDays,
    periodCapMinor: input?.periodCapMinor ?? config.social.periodCapMinor,
  };

  const values = [
    caps.autoApproveCapMinor,
    caps.midApproveCapMinor,
    caps.periodCapMinor,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw ApiError.badRequest('invalid_amount', 'Every cap must be a positive whole amount');
  }
  if (!Number.isSafeInteger(caps.periodDays) || caps.periodDays < 1 || caps.periodDays > 365) {
    throw ApiError.badRequest('invalid_amount', 'The period must be between 1 and 365 days');
  }
  if (caps.midApproveCapMinor < caps.autoApproveCapMinor) {
    throw ApiError.badRequest(
      'invalid_amount',
      'The council cap cannot be lower than the auto-approve cap',
    );
  }
  if (caps.periodCapMinor < caps.midApproveCapMinor) {
    throw ApiError.badRequest(
      'invalid_amount',
      'The period cap cannot be lower than the council cap',
    );
  }
  return caps;
}

export type RegisterTreasuryInput = {
  groupId: string;
  userId: string;
  label: string;
  daoAccount: string;
  network?: string;
  caps?: Partial<SocialCapsInput>;
};

/**
 * Registration proves the account is a NEAR id, reads its policy once and stores
 * that snapshot. A second treasury for the same DAO in the same group is a 409.
 */
export async function registerTreasury(input: RegisterTreasuryInput): Promise<TreasuryView> {
  const daoAccount = input.daoAccount.trim().toLowerCase();
  if (!isNearAccountId(daoAccount)) {
    throw ApiError.badRequest('invalid_dao_account', 'That is not a NEAR account id');
  }

  const network = input.network ?? config.near.network;
  if (network !== config.near.network) {
    throw ApiError.badRequest(
      'invalid_dao_account',
      `This server settles on ${config.near.network}, so a ${network} DAO cannot be registered`,
    );
  }

  const caps = resolveCaps(input.caps);
  // Trezu runs the same Sputnik contract (trezu.org/terms-of-use), so neither the
  // chain nor the account name tells the products apart — every treasury is a
  // Sputnik DAO. `trezu` stays in the schema for rows recorded before this.
  const source = 'sputnik';
  const policy = await getPolicy(daoAccount);
  const memberId = await memberIdForUser(poolDb, input.groupId, input.userId);

  try {
    const { rows } = await query<{ id: string }>(
      `insert into dao_treasuries
         (group_id, label, network, dao_account, source, auto_role, council_role,
          auto_approve_cap_minor, mid_approve_cap_minor, period_days, period_cap_minor,
          policy, policy_synced_at, created_by)
       values ($1, $2, $3, $4, $5, 'payout', 'council', $6, $7, $8, $9, $10::jsonb, now(), $11)
       returning id`,
      [
        input.groupId,
        input.label.trim(),
        network,
        daoAccount,
        source,
        caps.autoApproveCapMinor,
        caps.midApproveCapMinor,
        caps.periodDays,
        caps.periodCapMinor,
        JSON.stringify(policy),
        memberId,
      ],
    );
    const created = rows[0];
    if (!created) throw new Error('dao treasury insert returned no row');
    return mapTreasury(await loadTreasury(poolDb, created.id));
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw ApiError.conflict(
        'treasury_exists',
        'That DAO is already registered as a treasury for this group',
      );
    }
    throw error;
  }
}

export async function listTreasuries(groupId: string): Promise<TreasuryView[]> {
  const { rows } = await query<TreasuryRow>(
    `select ${TREASURY_COLUMNS}
       from dao_treasuries t
      where t.group_id = $1
      order by t.created_at asc`,
    [groupId],
  );
  return rows.map(mapTreasury);
}

/** Refresh the stored `get_policy()` snapshot; nothing else on the row changes. */
export async function syncTreasuryPolicy(treasuryId: string): Promise<TreasuryView> {
  const treasury = await loadTreasury(poolDb, treasuryId);
  const policy = await getPolicy(treasury.dao_account);

  await query(
    `update dao_treasuries
        set policy = $2::jsonb, policy_synced_at = now()
      where id = $1`,
    [treasuryId, JSON.stringify(policy)],
  );

  return mapTreasury({ ...treasury, policy, policy_synced_at: new Date() });
}

async function firstTreasuryId(db: Db, groupId: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `select id from dao_treasuries
      where group_id = $1
      order by created_at asc
      limit 1`,
    [groupId],
  );
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Bounties
// ---------------------------------------------------------------------------

type BountyRow = {
  id: string;
  group_id: string;
  treasury_id: string | null;
  title: string;
  description: string;
  category: string;
  source: string;
  asset: string;
  amount_minor: number;
  currency: string;
  chain_amount: string;
  status: string;
  visibility: string;
  deadline: Date | null;
  claimer_member_id: string | null;
  claimed_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  treasury_label: string | null;
  dao_account: string | null;
  claimer_name: string | null;
};

const BOUNTY_COLUMNS = `b.id, b.group_id, b.treasury_id, b.title, b.description,
  b.category, b.source, b.asset, b.amount_minor, b.currency, b.chain_amount::text,
  b.status, b.visibility, b.deadline, b.claimer_member_id, b.claimed_at,
  b.created_by, b.created_at, b.updated_at,
  t.label as treasury_label, t.dao_account, u.display_name as claimer_name`;

const BOUNTY_FROM = `from bounties b
  left join dao_treasuries t on t.id = b.treasury_id
  left join members m on m.id = b.claimer_member_id
  left join users u on u.id = m.user_id`;

export type BountyView = {
  id: string;
  groupId: string;
  treasuryId: string | null;
  treasuryLabel: string | null;
  daoAccount: string | null;
  title: string;
  description: string;
  category: string;
  source: string;
  asset: 'near' | 'usdc';
  amountMinor: number;
  currency: string;
  amountDisplay: string;
  chainAmount: string;
  chainDisplay: string;
  chainSymbol: string;
  status: string;
  visibility: string;
  deadline: string | null;
  claimerMemberId: string | null;
  claimerName: string | null;
  claimedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

function mapBounty(row: BountyRow): BountyView {
  const asset = row.asset === 'usdc' ? 'usdc' : 'near';
  const currency = row.currency.trim();
  return {
    id: row.id,
    groupId: row.group_id,
    treasuryId: row.treasury_id,
    treasuryLabel: row.treasury_label,
    daoAccount: row.dao_account,
    title: row.title,
    description: row.description,
    category: row.category,
    source: row.source,
    asset,
    amountMinor: row.amount_minor,
    currency,
    amountDisplay: formatAmount(row.amount_minor, currency),
    chainAmount: row.chain_amount,
    chainDisplay: formatTokenUnits(BigInt(row.chain_amount), chainDecimals(asset)),
    chainSymbol: chainSymbol(asset),
    status: row.status,
    visibility: row.visibility,
    deadline: row.deadline ? iso(row.deadline) : null,
    claimerMemberId: row.claimer_member_id,
    claimerName: row.claimer_name,
    claimedAt: row.claimed_at ? iso(row.claimed_at) : null,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function loadBountyRow(db: Db, bountyId: string): Promise<BountyRow> {
  const { rows } = await db.query<BountyRow>(
    `select ${BOUNTY_COLUMNS} ${BOUNTY_FROM} where b.id = $1`,
    [bountyId],
  );
  const row = rows[0];
  if (!row) {
    throw new ApiError(404, 'bounty_not_found', 'That bounty is not on this board');
  }
  return row;
}

export type BountyClaimView = {
  id: string;
  bountyId: string;
  memberId: string;
  memberName: string | null;
  note: string;
  evidenceUrl: string | null;
  status: string;
  submittedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
};

type ClaimRow = {
  id: string;
  bounty_id: string;
  member_id: string;
  member_name: string | null;
  note: string;
  evidence_url: string | null;
  status: string;
  submitted_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
};

function mapClaim(row: ClaimRow): BountyClaimView {
  return {
    id: row.id,
    bountyId: row.bounty_id,
    memberId: row.member_id,
    memberName: row.member_name,
    note: row.note,
    evidenceUrl: row.evidence_url,
    status: row.status,
    submittedAt: iso(row.submitted_at),
    decidedBy: row.decided_by,
    decidedAt: row.decided_at ? iso(row.decided_at) : null,
    decisionNote: row.decision_note,
  };
}

export type BountyEventView = {
  id: string;
  eventType: string;
  summary: string;
  actorMemberId: string | null;
  actorName: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type EventRow = {
  id: string;
  event_type: string;
  summary: string;
  actor_member_id: string | null;
  actor_name: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
};

/** Writes one audit row. Never `ledger_events` — this is narrative, not money. */
export async function recordBountyEvent(
  tx: Db,
  input: {
    bountyId: string;
    groupId: string;
    actorMemberId: string | null;
    eventType: string;
    summary: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `insert into bounty_events
       (bounty_id, group_id, actor_member_id, event_type, summary, metadata)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.bountyId,
      input.groupId,
      input.actorMemberId,
      input.eventType,
      input.summary,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

export type BountyDetail = {
  bounty: BountyView;
  claims: BountyClaimView[];
  payouts: PayoutView[];
  events: BountyEventView[];
};

export async function getBounty(bountyId: string): Promise<BountyDetail> {
  const row = await loadBountyRow(poolDb, bountyId);

  const [claims, payouts, events] = await Promise.all([
    query<ClaimRow>(
      `select c.id, c.bounty_id, c.member_id, u.display_name as member_name, c.note,
              c.evidence_url, c.status, c.submitted_at, c.decided_by, c.decided_at,
              c.decision_note
         from bounty_claims c
         left join members m on m.id = c.member_id
         left join users u on u.id = m.user_id
        where c.bounty_id = $1
        order by c.submitted_at desc`,
      [bountyId],
    ),
    query<PayoutRow>(
      `select ${PAYOUT_COLUMNS} ${PAYOUT_FROM} where p.bounty_id = $1
        order by p.created_at desc`,
      [bountyId],
    ),
    query<EventRow>(
      `select e.id, e.event_type, e.summary, e.actor_member_id,
              u.display_name as actor_name, e.metadata, e.created_at
         from bounty_events e
         left join members m on m.id = e.actor_member_id
         left join users u on u.id = m.user_id
        where e.bounty_id = $1
        order by e.created_at asc`,
      [bountyId],
    ),
  ]);

  return {
    bounty: mapBounty(row),
    claims: claims.rows.map(mapClaim),
    payouts: payouts.rows.map(mapPayout),
    events: events.rows.map((event) => ({
      id: event.id,
      eventType: event.event_type,
      summary: event.summary,
      actorMemberId: event.actor_member_id,
      actorName: event.actor_name,
      metadata: event.metadata,
      createdAt: iso(event.created_at),
    })),
  };
}

/**
 * The board. Presets are generated lazily on read — writing them from
 * `bills.ts` would break the additive contract (§12.1).
 */
export async function listBounties(groupId: string): Promise<BountyView[]> {
  await generatePresetBounties(groupId);

  const { rows } = await query<BountyRow>(
    `select ${BOUNTY_COLUMNS} ${BOUNTY_FROM}
      where b.group_id = $1
      order by b.created_at desc`,
    [groupId],
  );
  return rows.map(mapBounty);
}

/** Unauthenticated board: public rows only, no preset sweep. */
export async function listPublicBounties(): Promise<BountyView[]> {
  const { rows } = await query<BountyRow>(
    `select ${BOUNTY_COLUMNS} ${BOUNTY_FROM}
      where b.visibility = 'public'
      order by b.created_at desc
      limit 100`,
  );
  return rows.map(mapBounty);
}

type PresetCandidate = {
  agreement_id: string;
  label: string;
  fronted_by: string;
  total: string;
  currency: string;
};

/**
 * Lazy preset A1/A2 sweep. A preset row is ordinary data: once it exists nothing
 * recreates it, and the group may edit or cancel it. The dedupe key is
 * `(group_id, source, title)` because `bounties` carries no unique index.
 */
export async function generatePresetBounties(groupId: string): Promise<number> {
  const treasuryId = await firstTreasuryId(poolDb, groupId);
  if (!treasuryId) return 0;

  try {
    const [fronted, collecting] = await Promise.all([
      query<PresetCandidate>(
        `select a.id as agreement_id,
                coalesce(nullif(a.terms_snapshot->>'title', ''),
                         'Agreement ' || left(a.id::text, 8)) as label,
                a.fronted_by,
                sum(b.total) as total,
                max(b.currency) as currency
           from agreements a
           join bills b on b.agreement_id = a.id
          where a.group_id = $1
            and a.fronted_by is not null
            and b.status in ('FINALIZED', 'COLLECTING', 'SETTLED')
          group by a.id, a.fronted_by`,
        [groupId],
      ),
      query<PresetCandidate>(
        `select a.id as agreement_id,
                coalesce(nullif(a.terms_snapshot->>'title', ''),
                         'Agreement ' || left(a.id::text, 8)) as label,
                a.fronted_by,
                coalesce(sum(s.amount), 0) as total,
                max(s.currency) as currency
           from agreements a
           join bills b on b.agreement_id = a.id
           join shares s on s.bill_id = b.id
          where a.group_id = $1
            and a.fronted_by is not null
            and s.status not in ('PAID', 'WAIVED', 'CANCELLED')
          group by a.id, a.fronted_by
         having coalesce(sum(s.amount), 0) > 0`,
        [groupId],
      ),
    ]);

    let created = 0;
    created += await insertPresetGroup(groupId, treasuryId, 'fronting', 'Fronting reward', fronted.rows);
    created += await insertPresetGroup(groupId, treasuryId, 'collection', 'Collection reward', collecting.rows);
    return created;
  } catch (error) {
    // A preset is a convenience. A missing FX rate must never break the board.
    console.warn('[social] preset sweep skipped:', (error as Error).message);
    return 0;
  }
}

async function insertPresetGroup(
  groupId: string,
  treasuryId: string,
  source: 'fronting' | 'collection',
  prefix: string,
  candidates: PresetCandidate[],
): Promise<number> {
  let created = 0;

  for (const candidate of candidates) {
    const currency = candidate.currency.trim();
    const base = Number(candidate.total);
    if (!Number.isFinite(base) || base <= 0) continue;

    const amountMinor = presetRewardMinor(base, config.social.autoApproveCapMinor);
    const title = `${prefix} · ${candidate.label}`;
    const chain = await chainAmountFor('near', amountMinor, currency);

    const { rows } = await query<{ id: string }>(
      `insert into bounties
         (group_id, treasury_id, title, description, category, source,
          asset, amount_minor, currency, chain_amount, status, visibility, created_by)
       select $1, $2, $3, $4, $5, $6, 'near', $7, $8, $9::numeric, 'open', 'group', $10
        where not exists (
          select 1 from bounties b
           where b.group_id = $1 and b.source = $6 and b.title = $3
        )
       returning id`,
      [
        groupId,
        treasuryId,
        title,
        `Auto-generated when "${candidate.label}" (agreement ${candidate.agreement_id}) reached settlement.`,
        source === 'fronting' ? 'fronting' : 'collection',
        source,
        amountMinor,
        currency,
        chain.chainAmount.toString(),
        candidate.fronted_by,
      ],
    );

    if (rows[0]) created += 1;
  }

  return created;
}

function presetRewardMinor(baseMinor: number, capMinor: number): number {
  const raw = Math.floor((baseMinor * PRESET_REWARD_BPS) / 10_000);
  return Math.max(1, Math.min(capMinor, raw));
}

export type CreateBountyInput = {
  groupId: string;
  userId: string;
  treasuryId?: string | null;
  title: string;
  description: string;
  category?: string;
  asset?: 'near' | 'usdc';
  amountMinor: number;
  currency: string;
  deadline?: string | null;
  visibility?: 'group' | 'public';
};

export async function createBounty(input: CreateBountyInput): Promise<BountyView> {
  // `requiredMinor` accepts zero, so the positive check has to happen here.
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw ApiError.badRequest('invalid_amount', 'A reward must be a positive whole amount');
  }

  const currency = input.currency.trim().toUpperCase();
  const asset = input.asset ?? 'near';
  const visibility = input.visibility ?? 'group';

  let treasuryId = input.treasuryId ?? null;
  if (treasuryId) {
    const treasury = await loadTreasury(poolDb, treasuryId);
    if (treasury.group_id !== input.groupId) {
      throw new ApiError(404, 'treasury_not_found', 'That treasury belongs to another group');
    }
  } else {
    treasuryId = await firstTreasuryId(poolDb, input.groupId);
  }

  const chain = await chainAmountFor(asset, input.amountMinor, currency);
  const createdBy = await memberIdForUser(poolDb, input.groupId, input.userId);

  const { rows } = await query<{ id: string }>(
    `insert into bounties
       (group_id, treasury_id, title, description, category, source,
        asset, amount_minor, currency, chain_amount, status, visibility, deadline, created_by)
     values ($1, $2, $3, $4, $5, 'manual', $6, $7, $8, $9::numeric, 'open', $10, $11, $12)
     returning id`,
    [
      input.groupId,
      treasuryId,
      input.title.trim(),
      input.description.trim(),
      input.category?.trim() || 'general',
      asset,
      input.amountMinor,
      currency,
      chain.chainAmount.toString(),
      visibility,
      input.deadline ?? null,
      createdBy,
    ],
  );

  const created = rows[0];
  if (!created) throw new Error('bounty insert returned no row');
  return mapBounty(await loadBountyRow(poolDb, created.id));
}

type ClaimTarget = {
  id: string;
  group_id: string;
  status: string;
  claimer_member_id: string | null;
  title: string;
};

async function lockBounty(tx: Db, bountyId: string): Promise<ClaimTarget> {
  const { rows } = await tx.query<ClaimTarget>(
    `select id, group_id, status, claimer_member_id, title
       from bounties where id = $1 for update`,
    [bountyId],
  );
  const row = rows[0];
  if (!row) throw new ApiError(404, 'bounty_not_found', 'That bounty is not on this board');
  return row;
}

/** A member takes an open bounty. The unique key is (bounty_id, member_id). */
export async function claimBounty(
  bountyId: string,
  member: MemberContext,
): Promise<{ claimId: string; bountyId: string; status: string }> {
  try {
    return await withTransaction(async (tx) => {
      const bounty = await lockBounty(tx, bountyId);
      if (bounty.group_id !== member.groupId) {
        throw new ApiError(404, 'bounty_not_found', 'That bounty is not on this board');
      }
      if (bounty.status !== 'open') {
        throw ApiError.conflict('bounty_not_open', 'This bounty is not open for claims');
      }

      const { rows } = await tx.query<{ id: string }>(
        `insert into bounty_claims (bounty_id, member_id, note)
         values ($1, $2, '')
         returning id`,
        [bountyId, member.id],
      );
      const claim = rows[0];
      if (!claim) throw new Error('bounty claim insert returned no row');

      await tx.query(
        `update bounties
            set status = 'claimed', claimer_member_id = $2, claimed_at = now(), updated_at = now()
          where id = $1`,
        [bountyId, member.id],
      );

      await recordBountyEvent(tx, {
        bountyId,
        groupId: bounty.group_id,
        actorMemberId: member.id,
        eventType: 'claimed',
        summary: `${member.displayName} claimed "${bounty.title}"`,
        metadata: { claimId: claim.id },
      });

      return { claimId: claim.id, bountyId, status: 'claimed' };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw ApiError.conflict('claim_already_exists', 'You have already claimed this bounty');
    }
    throw error;
  }
}

export type SubmitClaimInput = { note: string; evidenceUrl?: string | null };

/** The claimer files their note and evidence; the claim keeps its single row. */
export async function submitClaim(
  bountyId: string,
  member: MemberContext,
  input: SubmitClaimInput,
): Promise<BountyClaimView> {
  return withTransaction(async (tx) => {
    const bounty = await lockBounty(tx, bountyId);
    if (bounty.group_id !== member.groupId) {
      throw new ApiError(404, 'bounty_not_found', 'That bounty is not on this board');
    }
    if (bounty.status !== 'claimed' && bounty.status !== 'submitted') {
      throw ApiError.conflict('bounty_not_open', 'This bounty is no longer accepting submissions');
    }
    if (bounty.claimer_member_id !== member.id) {
      throw ApiError.forbidden('Only the member who claimed this bounty can submit it');
    }

    const { rows } = await tx.query<ClaimRow>(
      `update bounty_claims c
          set note = $3, evidence_url = $4, status = 'submitted', submitted_at = now()
        where c.bounty_id = $1 and c.member_id = $2
          and c.status <> 'rejected'
        returning c.id, c.bounty_id, c.member_id,
                  (select u.display_name from members m
                     join users u on u.id = m.user_id
                    where m.id = c.member_id) as member_name,
                  c.note, c.evidence_url, c.status, c.submitted_at, c.decided_by,
                  c.decided_at, c.decision_note`,
      [bountyId, member.id, input.note.trim(), input.evidenceUrl ?? null],
    );

    const claim = rows[0];
    if (!claim) {
      throw new ApiError(404, 'claim_not_found', 'You have not claimed this bounty');
    }

    await tx.query(
      `update bounties set status = 'submitted', updated_at = now() where id = $1`,
      [bountyId],
    );

    await recordBountyEvent(tx, {
      bountyId,
      groupId: bounty.group_id,
      actorMemberId: member.id,
      eventType: 'submitted',
      summary: `${member.displayName} submitted work for "${bounty.title}"`,
      metadata: { claimId: claim.id },
    });

    return mapClaim(claim);
  });
}

export type DecideClaimInput = { decision: 'approve' | 'reject'; note?: string | null };

type ClaimDecisionRow = {
  id: string;
  bounty_id: string;
  member_id: string;
  status: string;
  group_id: string;
  title: string;
  amount_minor: number;
  currency: string;
};

/** Approval moves the bounty to `approved`. It never moves money. */
export async function decideClaim(
  claimId: string,
  actor: MemberContext,
  input: DecideClaimInput,
): Promise<{ claimId: string; bountyId: string; claimStatus: string; bountyStatus: string }> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<ClaimDecisionRow>(
      `select c.id, c.bounty_id, c.member_id, c.status,
              b.group_id, b.title, b.amount_minor, b.currency
         from bounty_claims c
         join bounties b on b.id = c.bounty_id
        where c.id = $1
        for update of c, b`,
      [claimId],
    );

    const claim = rows[0];
    if (!claim) {
      throw new ApiError(404, 'claim_not_found', 'That claim is no longer on this bounty');
    }
    if (claim.group_id !== actor.groupId) {
      throw new ApiError(404, 'claim_not_found', 'That claim is no longer on this bounty');
    }
    if (actor.role !== 'owner' && actor.role !== 'fronter') {
      throw ApiError.forbidden('Only a council member can decide this claim');
    }
    if (claim.status !== 'submitted') {
      throw ApiError.conflict('bounty_not_open', 'That claim has already been decided');
    }

    const approve = input.decision === 'approve';
    const claimStatus = approve ? 'approved' : 'rejected';
    const bountyStatus = approve ? 'approved' : 'rejected';

    await tx.query(
      `update bounty_claims
          set status = $2, decided_by = $3, decided_at = now(), decision_note = $4
        where id = $1`,
      [claimId, claimStatus, actor.id, input.note ?? null],
    );

    await tx.query(
      `update bounties set status = $2, updated_at = now() where id = $1`,
      [claim.bounty_id, bountyStatus],
    );

    const currency = claim.currency.trim();
    await recordBountyEvent(tx, {
      bountyId: claim.bounty_id,
      groupId: claim.group_id,
      actorMemberId: actor.id,
      eventType: approve ? 'approved' : 'rejected',
      summary: approve
        ? `${actor.displayName} approved "${claim.title}" for ${formatAmount(claim.amount_minor, currency)} ${currency}`
        : `${actor.displayName} rejected the claim on "${claim.title}"`,
      metadata: { claimId, decision: input.decision, note: input.note ?? null },
    });

    return { claimId, bountyId: claim.bounty_id, claimStatus, bountyStatus };
  });
}

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

type PayoutRow = {
  id: string;
  bounty_id: string;
  claim_id: string;
  treasury_id: string;
  recipient_account: string;
  asset: string;
  amount_minor: number;
  currency: string;
  chain_amount: string;
  tier: string;
  policy_role: string;
  required_approvals: number;
  proposal_id: string | null;
  proposal_tx_hash: string | null;
  status: string;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
  dao_account: string | null;
  group_id: string;
  claimer_member_id: string;
};

const PAYOUT_COLUMNS = `p.id, p.bounty_id, p.claim_id, p.treasury_id, p.recipient_account,
  p.asset, p.amount_minor, p.currency, p.chain_amount::text, p.tier, p.policy_role,
  p.required_approvals, p.proposal_id, p.proposal_tx_hash, p.status, p.failure_reason,
  p.created_at, p.updated_at, t.dao_account, b.group_id, c.member_id as claimer_member_id`;

const PAYOUT_FROM = `from bounty_payouts p
  join bounties b on b.id = p.bounty_id
  join bounty_claims c on c.id = p.claim_id
  left join dao_treasuries t on t.id = p.treasury_id`;

export type PayoutView = {
  id: string;
  bountyId: string;
  claimId: string;
  treasuryId: string;
  recipientAccount: string;
  asset: 'near' | 'usdc';
  amountMinor: number;
  currency: string;
  amountDisplay: string;
  chainAmount: string;
  chainDisplay: string;
  chainSymbol: string;
  tier: PayoutTier;
  policyRole: string;
  requiredApprovals: number;
  proposalId: string | null;
  proposalTxHash: string | null;
  status: string;
  failureReason: string | null;
  explorerUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

function mapPayout(row: PayoutRow): PayoutView {
  const asset = row.asset === 'usdc' ? 'usdc' : 'near';
  const currency = row.currency.trim();
  return {
    id: row.id,
    bountyId: row.bounty_id,
    claimId: row.claim_id,
    treasuryId: row.treasury_id,
    recipientAccount: row.recipient_account,
    asset,
    amountMinor: row.amount_minor,
    currency,
    amountDisplay: formatAmount(row.amount_minor, currency),
    chainAmount: row.chain_amount,
    chainDisplay: formatTokenUnits(BigInt(row.chain_amount), chainDecimals(asset)),
    chainSymbol: chainSymbol(asset),
    tier: row.tier as PayoutTier,
    policyRole: row.policy_role,
    requiredApprovals: row.required_approvals,
    proposalId: row.proposal_id,
    proposalTxHash: row.proposal_tx_hash,
    status: row.status,
    failureReason: row.failure_reason,
    explorerUrl: row.proposal_tx_hash ? explorerTx(row.proposal_tx_hash) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function loadPayoutRow(db: Db, payoutId: string): Promise<PayoutRow> {
  const { rows } = await db.query<PayoutRow>(
    `select ${PAYOUT_COLUMNS} ${PAYOUT_FROM} where p.id = $1`,
    [payoutId],
  );
  const row = rows[0];
  if (!row) throw ApiError.notFound('Payout not found');
  return row;
}

type PayoutPlanBase = {
  claimId: string;
  bountyId: string;
  bountyTitle: string;
  treasuryId: string;
  daoAccount: string;
  asset: 'near' | 'usdc';
  amountMinor: number;
  currency: string;
  chainAmount: string;
  recipientAccount: string;
  signerAccount: string;
  tier: PayoutTier;
  policyRole: string;
  reason: string;
  role: RoleRequirement;
  trustScore: number;
  spentInPeriodMinor: number;
  periodCapMinor: number;
  headroomMinor: number;
  canPrepare: boolean;
  policy: SputnikPolicy;
};

export type PayoutPlanView = Omit<PayoutPlanBase, 'policy' | 'treasuryId'> & {
  treasuryId: string;
};

function toPayoutPlanView(plan: PayoutPlanBase): PayoutPlanView {
  return {
    claimId: plan.claimId,
    bountyId: plan.bountyId,
    bountyTitle: plan.bountyTitle,
    treasuryId: plan.treasuryId,
    daoAccount: plan.daoAccount,
    asset: plan.asset,
    amountMinor: plan.amountMinor,
    currency: plan.currency,
    chainAmount: plan.chainAmount,
    recipientAccount: plan.recipientAccount,
    signerAccount: plan.signerAccount,
    tier: plan.tier,
    policyRole: plan.policyRole,
    reason: plan.reason,
    role: plan.role,
    trustScore: plan.trustScore,
    spentInPeriodMinor: plan.spentInPeriodMinor,
    periodCapMinor: plan.periodCapMinor,
    headroomMinor: plan.headroomMinor,
    canPrepare: plan.canPrepare,
  };
}

type PlanQueryRow = {
  claim_id: string;
  claim_status: string;
  claimer_member_id: string;
  bounty_id: string;
  bounty_title: string;
  group_id: string;
  bounty_status: string;
  treasury_id: string | null;
  amount_minor: number;
  currency: string;
  asset: string;
  chain_amount: string;
  dao_account: string | null;
  auto_role: string | null;
  council_role: string | null;
  auto_approve_cap_minor: number | null;
  mid_approve_cap_minor: number | null;
  period_days: number | null;
  period_cap_minor: number | null;
  policy: SputnikPolicy | null;
};

/**
 * Everything the tier engine needs, and not one write. `prepareBountyPayout`
 * calls this and then persists the row.
 */
async function buildPayoutPlan(claimId: string, signerId: string): Promise<PayoutPlanBase> {
  const { rows } = await poolDb.query<PlanQueryRow>(
    `select c.id as claim_id, c.status as claim_status, c.member_id as claimer_member_id,
            b.id as bounty_id, b.title as bounty_title, b.group_id, b.status as bounty_status,
            b.amount_minor, b.currency, b.asset, b.chain_amount::text,
            t.id as treasury_id, t.dao_account, t.auto_role, t.council_role,
            t.auto_approve_cap_minor, t.mid_approve_cap_minor, t.period_days,
            t.period_cap_minor, t.policy
       from bounty_claims c
       join bounties b on b.id = c.bounty_id
       left join dao_treasuries t on t.id = b.treasury_id
      where c.id = $1`,
    [claimId],
  );

  const row = rows[0];
  if (!row) {
    throw new ApiError(404, 'claim_not_found', 'That claim is no longer on this bounty');
  }
  if (row.bounty_status !== 'approved') {
    throw ApiError.conflict(
      'bounty_not_open',
      'Approve the claim before preparing a payout',
    );
  }
  if (!row.treasury_id || !row.dao_account) {
    throw new ApiError(
      404,
      'treasury_not_found',
      'Register a treasury before paying a bounty',
    );
  }

  const { rows: accounts } = await poolDb.query<{
    member_id: string;
    near_account: string | null;
  }>(
    `select m.id as member_id,
            case when u.near_verified then coalesce(m.near_account, u.near_account) end as near_account
       from members m
       join users u on u.id = m.user_id
      where m.group_id = $1 and m.id = any($2::uuid[])`,
    [row.group_id, [signerId, row.claimer_member_id]],
  );

  const signerAccount = accounts.find((item) => item.member_id === signerId)?.near_account ?? null;
  const recipientAccount =
    accounts.find((item) => item.member_id === row.claimer_member_id)?.near_account ?? null;

  if (!signerAccount) {
    throw ApiError.conflict(
      'member_near_missing',
      'Link your NEAR account before signing a payout',
    );
  }
  if (!recipientAccount) {
    throw ApiError.conflict(
      'member_near_missing',
      'The claimant has not linked a NEAR account yet',
    );
  }

  const policy = row.policy ?? (await getPolicy(row.dao_account));
  const autoRole = row.auto_role ?? 'payout';
  const councilRole = row.council_role ?? 'council';
  const periodDays = row.period_days ?? config.social.periodDays;
  const caps: TreasuryCaps = {
    autoApproveCapMinor: row.auto_approve_cap_minor ?? config.social.autoApproveCapMinor,
    midApproveCapMinor: row.mid_approve_cap_minor ?? config.social.midApproveCapMinor,
    periodCapMinor: row.period_cap_minor ?? config.social.periodCapMinor,
  };

  const currency = row.currency.trim();
  const trust = await loadTrust(row.group_id, row.claimer_member_id);

  const { rows: spentRows } = await poolDb.query<{ spent: string }>(
    `select coalesce(sum(amount_minor), 0) as spent
       from bounty_payouts
      where treasury_id = $1
        and currency = $2
        and status in ('proposed', 'approved', 'executed')
        and created_at >= now() - ($3::int * interval '1 day')`,
    [row.treasury_id, currency, periodDays],
  );
  const spentInPeriodMinor = Number(spentRows[0]?.spent ?? 0);

  const decision = decidePayoutTier({
    amountMinor: row.amount_minor,
    trustScore: trust.score,
    spentInPeriodMinor,
    caps,
    roleNames: { auto: autoRole, council: councilRole },
    autoRoleExists: describeRole(policy, autoRole).exists,
  });

  const role = describeRole(policy, decision.roleName);

  return {
    claimId,
    bountyId: row.bounty_id,
    bountyTitle: row.bounty_title,
    treasuryId: row.treasury_id,
    daoAccount: row.dao_account,
    asset: row.asset === 'usdc' ? 'usdc' : 'near',
    amountMinor: row.amount_minor,
    currency,
    chainAmount: row.chain_amount,
    recipientAccount,
    signerAccount,
    tier: decision.tier,
    policyRole: decision.roleName,
    reason: decision.reason,
    role,
    trustScore: trust.score,
    spentInPeriodMinor,
    periodCapMinor: caps.periodCapMinor,
    headroomMinor: Math.max(0, caps.periodCapMinor - spentInPeriodMinor),
    canPrepare: role.exists,
    policy,
  };
}

/** Preview: tier, role, approvals and headroom, with no row written. */
export async function planBountyPayout(
  claimId: string,
  signerId: string,
): Promise<PayoutPlanView> {
  return toPayoutPlanView(await buildPayoutPlan(claimId, signerId));
}

export type PreparePayoutResult = {
  payout: PayoutView;
  plan: PayoutPlanView;
  transaction: string;
  blockHash: string;
};

/**
 * Builds the unsigned `add_proposal` transaction and freezes the payout row.
 * The member's wallet signs; the server never sees a key.
 */
export async function prepareBountyPayout(
  claimId: string,
  signerId: string,
): Promise<PreparePayoutResult> {
  const plan = await buildPayoutPlan(claimId, signerId);

  if (!plan.canPrepare) {
    throw ApiError.conflict(
      'dao_view_failed',
      `The DAO policy has no "${plan.policyRole}" role, so this payout cannot be proposed`,
    );
  }

  const yocto = BigInt(plan.chainAmount);
  const kind =
    plan.asset === 'usdc'
      ? ftTransferKind({
          tokenContract: config.near.usdcContract,
          receiverId: plan.recipientAccount,
          baseUnits: yocto,
          memo: `Bounty ${plan.bountyId}`,
        })
      : nativeTransferKind(plan.recipientAccount, yocto);

  const description = `Bounty payout: ${plan.bountyTitle} (${formatAmount(
    plan.amountMinor,
    plan.currency,
  )} ${plan.currency})`.slice(0, 480);

  const prepared = await prepareAddProposal({
    signerId: plan.signerAccount,
    daoAccount: plan.daoAccount,
    description,
    kind,
    bondYocto: proposalBondYocto(plan.policy),
  });

  try {
    const { rows } = await query<{ id: string }>(
      `insert into bounty_payouts
         (bounty_id, claim_id, treasury_id, recipient_account, asset, amount_minor,
          currency, chain_amount, tier, policy_role, required_approvals, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11, 'proposed')
       returning id`,
      [
        plan.bountyId,
        plan.claimId,
        plan.treasuryId,
        plan.recipientAccount,
        plan.asset,
        plan.amountMinor,
        plan.currency,
        plan.chainAmount,
        plan.tier,
        plan.policyRole,
        plan.role.requiredApprovals,
      ],
    );
    const created = rows[0];
    if (!created) throw new Error('bounty payout insert returned no row');

    await recordBountyEvent(poolDb, {
      bountyId: plan.bountyId,
      groupId: (await loadBountyRow(poolDb, plan.bountyId)).group_id,
      actorMemberId: signerId,
      eventType: 'payout_prepared',
      summary: `Payout prepared: ${formatAmount(plan.amountMinor, plan.currency)} ${plan.currency} via ${plan.policyRole}`,
      metadata: { payoutId: created.id, tier: plan.tier },
    });

    const payout = mapPayout(await loadPayoutRow(poolDb, created.id));
    return {
      payout,
      plan: toPayoutPlanView(plan),
      transaction: prepared.transaction,
      blockHash: prepared.blockHash,
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw ApiError.conflict('claim_already_exists', 'A payout already exists for this claim');
    }
    throw error;
  }
}

/** Stores the hash the wallet broadcast. */
export async function recordPayoutTx(
  payoutId: string,
  txHash: string,
  proposalId?: string | null,
): Promise<PayoutView> {
  const payout = await loadPayoutRow(poolDb, payoutId);
  if (payout.status === 'executed') {
    throw ApiError.conflict('bounty_not_open', 'That payout has already executed');
  }

  await query(
    `update bounty_payouts
        set proposal_tx_hash = $2,
            proposal_id = coalesce($3, proposal_id),
            updated_at = now()
      where id = $1`,
    [payoutId, txHash.trim(), proposalId ?? null],
  );

  return mapPayout(await loadPayoutRow(poolDb, payoutId));
}

// Sputnik v2 has no `Executed` status: the vote that reaches the threshold runs
// the transfer in the same transaction and the proposal stays `Approved`.
const EXECUTED_PROPOSAL_STATES = new Set(['Approved', 'Executed', 'Completed']);
// Trezu multi-sig parks a passed proposal until someone finalises it.
const APPROVED_PROPOSAL_STATES = new Set(['Requested', 'VotePending']);
const FAILED_PROPOSAL_STATES = new Set([
  'Rejected',
  'Expired',
  'Failed',
  'Moved',
  'Removed',
  'Cancelled',
]);

const FT_TRANSFER_METHOD = 'ft_transfer';

type ProposalKindView = {
  Transfer?: { receiver_id?: unknown; amount?: unknown };
  FunctionCall?: {
    actions?: { method_name?: unknown; args?: unknown }[];
  };
};

/** The `args` of a Sputnik action are base64 JSON, so a bad blob proves nothing. */
function decodeActionArgs(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Amounts arrive as decimal strings; anything else cannot equal a base-unit row. */
function chainAmountArg(raw: unknown): bigint | null {
  return typeof raw === 'string' && /^\d+$/.test(raw) ? BigInt(raw) : null;
}

/**
 * The DAO executes whatever the wallet submitted, so an `executed` status alone
 * does not say *what* was paid. Only a proposal naming the row's recipient for
 * the row's exact base units may settle it: a native `Transfer` pays
 * `receiver_id`/`amount`, an NEP-141 `ft_transfer` names the contract as the
 * call target and the contributor inside `args`.
 */
function assertPayoutMatchesProposal(payout: PayoutRow, proposal: SputnikProposal): void {
  const kind = (proposal.kind ?? null) as ProposalKindView | null;
  if (!kind || typeof kind !== 'object') {
    throw ApiError.conflict(
      'payout_proposal_mismatch',
      'That proposal carries no action, so it cannot be the payout we prepared',
    );
  }

  const expectedChainAmount = BigInt(payout.chain_amount);

  if (kind.Transfer) {
    const receiver = kind.Transfer.receiver_id;
    if (receiver !== payout.recipient_account) {
      throw ApiError.conflict(
        'payout_proposal_wrong_receiver',
        `That proposal pays ${
          typeof receiver === 'string' ? receiver : 'an unknown account'
        }, not ${payout.recipient_account}`,
      );
    }
    const amount = kind.Transfer.amount;
    if (chainAmountArg(amount) !== expectedChainAmount) {
      throw ApiError.conflict(
        'payout_proposal_wrong_amount',
        `That proposal moves ${
          typeof amount === 'string' ? amount : 'an unknown amount'
        } base units, not ${payout.chain_amount}`,
      );
    }
    return;
  }

  if (kind.FunctionCall) {
    const action = kind.FunctionCall.actions?.[0];
    const method = typeof action?.method_name === 'string' ? action.method_name : null;
    if (!action || method !== FT_TRANSFER_METHOD) {
      throw ApiError.conflict(
        'payout_proposal_wrong_method',
        `That proposal calls ${method ?? 'nothing'}, not ${FT_TRANSFER_METHOD}`,
      );
    }

    const args = decodeActionArgs(action.args);
    const receiver = args?.receiver_id;
    if (receiver !== payout.recipient_account) {
      throw ApiError.conflict(
        'payout_proposal_wrong_receiver',
        `That proposal pays ${
          typeof receiver === 'string' ? receiver : 'an unknown account'
        }, not ${payout.recipient_account}`,
      );
    }
    const amount = args?.amount;
    if (chainAmountArg(amount) !== expectedChainAmount) {
      throw ApiError.conflict(
        'payout_proposal_wrong_amount',
        `That proposal moves ${
          typeof amount === 'string' ? amount : 'an unknown amount'
        } base units, not ${payout.chain_amount}`,
      );
    }
    return;
  }

  throw ApiError.conflict(
    'payout_proposal_mismatch',
    'That proposal is not a transfer this payout can settle',
  );
}

/**
 * Reads `get_proposal` and settles the row. Executing recomputes the
 * contributor's trust in the same transaction as the status change.
 */
export async function syncPayout(payoutId: string): Promise<PayoutView> {
  const payout = await loadPayoutRow(poolDb, payoutId);

  if (!payout.proposal_id) {
    throw ApiError.badRequest(
      'invalid_proposal_id',
      'Record the proposal id from your wallet before syncing',
    );
  }
  if (!payout.dao_account) {
    throw new ApiError(
      404,
      'treasury_not_found',
      'The treasury behind this payout is no longer registered',
    );
  }

  const proposal = await getProposal(payout.dao_account, payout.proposal_id);
  if (!proposal) {
    throw ApiError.notFound('The DAO does not know that proposal yet');
  }

  const status = proposal.status;
  let next: string | null = null;
  if (EXECUTED_PROPOSAL_STATES.has(status)) next = 'executed';
  else if (APPROVED_PROPOSAL_STATES.has(status)) next = 'approved';
  else if (FAILED_PROPOSAL_STATES.has(status)) next = 'failed';

  if (!next || next === payout.status) {
    return mapPayout(payout);
  }

  if (next === 'executed') {
    // The DAO executed *a* proposal; make sure it is the one we prepared.
    assertPayoutMatchesProposal(payout, proposal);

    await withTransaction(async (tx) => {
      await tx.query('select id from bounty_payouts where id = $1 for update', [payoutId]);
      const current = await loadPayoutRow(tx, payoutId);
      if (current.status === 'executed') return;

      await tx.query(
        `update bounty_payouts
            set status = 'executed', failure_reason = null, updated_at = now()
          where id = $1`,
        [payoutId],
      );
      await tx.query(
        `update bounties set status = 'paid', updated_at = now() where id = $1`,
        [payout.bounty_id],
      );

      await recordBountyEvent(tx, {
        bountyId: payout.bounty_id,
        groupId: payout.group_id,
        actorMemberId: payout.claimer_member_id,
        eventType: 'paid',
        summary: `Paid ${formatAmount(payout.amount_minor, payout.currency.trim())} ${payout.currency.trim()} on chain`,
        metadata: {
          payoutId,
          proposalId: payout.proposal_id,
          txHash: payout.proposal_tx_hash,
        },
      });

      await recomputeTrust(tx, payout.group_id, payout.claimer_member_id);
    });
  } else {
    await query(
      `update bounty_payouts
          set status = $2, failure_reason = $3, updated_at = now()
        where id = $1`,
      [
        payoutId,
        next,
        next === 'failed' ? `The DAO reported "${status}"` : null,
      ],
    );
  }

  return mapPayout(await loadPayoutRow(poolDb, payoutId));
}

// ---------------------------------------------------------------------------
// Contributor trust
// ---------------------------------------------------------------------------

export type TrustView = {
  memberId: string;
  completedCount: number;
  paidMinor: number;
  currency: string;
  score: number;
  lastPaidAt: string | null;
};

type TrustRow = {
  member_id: string;
  score: number;
  completed_count: number;
  paid_minor: number;
  last_paid_at: Date | null;
};

/** A member with no settled payout yet simply scores zero. */
export async function loadTrust(groupId: string, memberId: string): Promise<TrustView> {
  const { rows } = await query<TrustRow>(
    `select member_id, score, completed_count, paid_minor, last_paid_at
       from contributor_trust
      where group_id = $1 and member_id = $2`,
    [groupId, memberId],
  );

  const row = rows[0];
  const currency = await groupCurrency(poolDb, groupId);
  if (!row) {
    return {
      memberId,
      completedCount: 0,
      paidMinor: 0,
      currency,
      score: 0,
      lastPaidAt: null,
    };
  }

  return {
    memberId,
    completedCount: row.completed_count,
    paidMinor: row.paid_minor,
    currency,
    score: row.score,
    lastPaidAt: row.last_paid_at ? iso(row.last_paid_at) : null,
  };
}

export async function listTrust(groupId: string): Promise<TrustView[]> {
  const currency = await groupCurrency(poolDb, groupId);
  const { rows } = await query<TrustRow>(
    `select ct.member_id, ct.score, ct.completed_count, ct.paid_minor, ct.last_paid_at
       from contributor_trust ct
      where ct.group_id = $1
      order by ct.score desc, ct.paid_minor desc`,
    [groupId],
  );

  return rows.map((row) => ({
    memberId: row.member_id,
    completedCount: row.completed_count,
    paidMinor: row.paid_minor,
    currency,
    score: row.score,
    lastPaidAt: row.last_paid_at ? iso(row.last_paid_at) : null,
  }));
}

async function groupCurrency(db: Db, groupId: string): Promise<string> {
  const { rows } = await db.query<{ default_currency: string }>(
    `select default_currency from groups where id = $1`,
    [groupId],
  );
  return rows[0]?.default_currency.trim() ?? 'USD';
}

/** Counts executed payouts and their fiat volume, then upserts the score. */
export async function recomputeTrust(
  tx: Db,
  groupId: string,
  memberId: string,
): Promise<TrustView> {
  const currency = await groupCurrency(tx, groupId);

  const { rows } = await tx.query<{
    completed: number;
    paid: string;
    last_paid: Date | null;
  }>(
    `select count(*)::int as completed,
            coalesce(sum(p.amount_minor), 0) as paid,
            max(p.updated_at) as last_paid
       from bounty_payouts p
       join bounty_claims c on c.id = p.claim_id
       join bounties b on b.id = p.bounty_id
      where p.status = 'executed'
        and c.member_id = $1
        and b.group_id = $2
        and p.currency = $3`,
    [memberId, groupId, currency],
  );

  const summary = rows[0];
  const completedCount = summary?.completed ?? 0;
  const paidMinor = Number(summary?.paid ?? 0);
  const lastPaidAt = summary?.last_paid ?? null;
  const score = trustScoreFor({ completedCount, paidMinor, currency });

  await tx.query(
    `insert into contributor_trust
       (group_id, member_id, score, completed_count, paid_minor, last_paid_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, now())
     on conflict (group_id, member_id) do update
       set score = excluded.score,
           completed_count = excluded.completed_count,
           paid_minor = excluded.paid_minor,
           last_paid_at = excluded.last_paid_at,
           updated_at = now()`,
    [groupId, memberId, score, completedCount, paidMinor, lastPaidAt],
  );

  return {
    memberId,
    completedCount,
    paidMinor,
    currency,
    score,
    lastPaidAt: lastPaidAt ? iso(lastPaidAt) : null,
  };
}
