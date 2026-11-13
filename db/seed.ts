/**
 * Demo seed (DEV_PLAN §2.14).
 *
 * Explicit command only — `npm run seed` — never part of deploy or boot. It
 * wipes and rebuilds the demo group so running it twice is safe: three email
 * accounts plus the testnet wallet that signs in through NEP-413.
 *
 * Everything here obeys the same invariants as the API: money is integer minor
 * units, every bill line is split with `allocate()` so nothing is invented or
 * lost, the shares add up to the bill total, and the paid share carries the
 * `share.paid` ledger event the leaderboard reads. Settlement is NEAR: every
 * paid share points at a demo NEP-141 transfer hash, and each matching
 * `payments` row is provider = 'near_transfer'.
 */

import { closePool, withTransaction } from '../server/src/db/pool.js';
import { allocate } from '../server/src/lib/money.js';

const CURRENCY = 'THB';
const INVITE_TOKEN = 'KHAOSI';
/** A shared household tab, not a dinner: it holds several expenses at once. */
const GROUP_NAME = 'Bangkok Flatmates';
const GROUP_KIND = 'groceries';

/** The testnet account the demo signs in with; no email was ever given for it. */
const WALLET_NAME = 'squarelibrary6540.testnet';

const ACCOUNTS = [
  {
    key: 'ana',
    email: 'ana@example.com',
    name: 'Ana',
    role: 'owner',
    // Ana fronts the bills, so this is the `pay_to` of every payment request.
    // It is the one demo name that exists on testnet, so the instruction points
    // at a real account instead of a placeholder.
    near: 'oldhat96.testnet',
  },
  {
    key: 'ben',
    email: 'ben@example.com',
    name: 'Ben',
    role: 'member',
    near: 'globie-ben.testnet',
  },
  {
    key: 'chai',
    email: 'chai@example.com',
    name: 'Chai',
    role: 'member',
    near: 'globie-chai.testnet',
  },
  {
    key: 'wallet',
    // `linkNearAccount()` gives a wallet-only account `<account>@near.globie`;
    // matching that here means a NEP-413 sign-in lands on this row rather than
    // creating a fourth user with an empty group list.
    email: `${WALLET_NAME}@near.globie`,
    name: WALLET_NAME,
    role: 'member',
    near: WALLET_NAME,
  },
] as const;

type AccountKey = (typeof ACCOUNTS)[number]['key'];

const NAMES = Object.fromEntries(
  ACCOUNTS.map((account) => [account.key, account.name]),
) as Record<AccountKey, string>;

/**
 * Demo receipts: the paid shares point at transfers that never happened on
 * chain. They exist so the ledger and UI render settled rows without asking the
 * demo machine for a funded testnet wallet. Each paid share gets its own hash so
 * no two rows share a provider reference.
 */
const DEMO_TX_HASHES = [
  '4xQ9mK2pR7sT1vW8yZ3aB6cD5eF9gH2jN4kL7qP1rS6tU',
  '8pL3nV6yB1sW4rT9mK2qX7cF5dH8jZ3gN6tR1yU4pA9sW',
  '2cF5dH8jZ3gN6tR1yU4pA9sW8pL3nV6yB1sW4rT9mK2qX',
] as const;

const TERMS = {
  version: 'v1',
  rule: 'Everyone accepts the terms before the receipt is uploaded.',
  settle_window: 'Pay your share within 7 days of the bill being locked.',
};

/** The first household shop predates the wallet joining, so it stays a three-way split. */
const FOUNDING_MEMBERS: AccountKey[] = ['ana', 'ben', 'chai'];

/** The later receipts split four ways, which is what the wallet signs in to. */
const FOUR_WAY: AccountKey[] = ['ana', 'ben', 'chai', 'wallet'];

/**
 * Six lines from one receipt. `split` maps a member to how many units of that
 * line they had; the line total is allocated across those weights.
 */
const ITEMS: Array<{
  name: string;
  qty: number;
  unitPrice: number;
  total: number;
  split: Partial<Record<AccountKey, number>>;
}> = [
  {
    name: 'Laundry detergent',
    qty: 2,
    unitPrice: 18_000,
    total: 36_000,
    split: { ana: 1, ben: 1 },
  },
  {
    name: 'Bath towels',
    qty: 1,
    unitPrice: 22_000,
    total: 22_000,
    split: { chai: 1 },
  },
  {
    name: 'Trash bags',
    qty: 1,
    unitPrice: 15_000,
    total: 15_000,
    split: { ana: 1, ben: 1, chai: 1 },
  },
  {
    name: 'Bottled water',
    qty: 3,
    unitPrice: 6_000,
    total: 18_000,
    split: { ana: 1, ben: 2 },
  },
  {
    name: 'Kitchen roll',
    qty: 2,
    unitPrice: 3_500,
    total: 7_000,
    split: { ana: 1, chai: 1 },
  },
  {
    name: 'Coffee beans',
    qty: 2,
    unitPrice: 5_000,
    total: 10_000,
    split: { ben: 1, chai: 1 },
  },
];

/**
 * Two receipts the wallet took part in, so a NEP-413 sign-in lands on populated
 * data. Each item is bought once per member, so every share is 120.00 or 180.00
 * THB and the four shares add up to the bill with nothing left on the fronter.
 */
const EXTRA_BILLS = [
  {
    merchant: 'Big C Rama 4',
    minutesAgo: 190,
    items: [
      { name: 'Dish soap', qty: 4, unitPrice: 5_000 },
      { name: 'Sponges', qty: 4, unitPrice: 7_000 },
    ],
  },
  {
    merchant: 'Tops Market',
    minutesAgo: 110,
    items: [
      { name: 'Toilet paper', qty: 4, unitPrice: 6_000 },
      { name: 'Hand soap', qty: 4, unitPrice: 9_000 },
      { name: 'Dish brush', qty: 4, unitPrice: 3_000 },
    ],
  },
] as const;

const MINUTE = 60_000;
const DAY = 86_400_000;
const ago = (days: number, hours = 0) => new Date(Date.now() - days * DAY - hours * 3_600_000);
const ahead = (days: number) => new Date(Date.now() + days * DAY);
const money = (minor: number) => (minor / 100).toFixed(2);

/** The wallet signed in six hours ago, after the first bill had already settled. */
const WALLET_JOINED_AT = ago(0, 6);

type BillSeedItem = {
  name: string;
  qty: number;
  unitPrice: number;
  total: number;
  split: Partial<Record<AccountKey, number>>;
};

type BillPlan = {
  merchant: string;
  members: AccountKey[];
  createdAt: Date;
  parsedAt: Date | null;
  framesExtracted: number;
  subtotal: number;
  serviceCharge: number;
  tip: number;
  confidence: number;
  sourceFrame: number | null;
  items: BillSeedItem[];
  lockedAt: Date;
  paidAt: Date;
  txHash: string;
};

const BILL_PLANS: BillPlan[] = [
  {
    merchant: 'Makro Srinakarin',
    members: FOUNDING_MEMBERS,
    createdAt: ago(2, 5),
    parsedAt: ago(2, 4),
    framesExtracted: 1,
    subtotal: 108_000,
    serviceCharge: 10_800,
    tip: 1_200,
    confidence: 0.96,
    sourceFrame: 1,
    items: ITEMS,
    // Ana repaid 18 hours after the split locked — the clock the Hero board reads.
    lockedAt: ago(2, 1),
    paidAt: ago(1, 7),
    txHash: DEMO_TX_HASHES[0],
  },
  ...EXTRA_BILLS.map((bill, index): BillPlan => {
    const createdAt = new Date(Date.now() - bill.minutesAgo * MINUTE);
    const items = bill.items.map((item) => ({
      ...item,
      total: item.qty * item.unitPrice,
      split: Object.fromEntries(FOUR_WAY.map((key) => [key, 1])) as Partial<
        Record<AccountKey, number>
      >,
    }));

    return {
      merchant: bill.merchant,
      members: FOUR_WAY,
      createdAt,
      parsedAt: new Date(createdAt.getTime() + MINUTE),
      framesExtracted: 1,
      subtotal: items.reduce((sum, item) => sum + item.total, 0),
      serviceCharge: 0,
      tip: 0,
      confidence: 1,
      sourceFrame: 1,
      items,
      lockedAt: new Date(createdAt.getTime() + 4 * MINUTE),
      paidAt: new Date(createdAt.getTime() + 20 * MINUTE),
      txHash: DEMO_TX_HASHES[index + 1]!,
    };
  }),
];

type LedgerSeed = {
  at: Date;
  type: string;
  actor: string;
  summary: string;
  amountMinor?: number;
  member?: AccountKey;
  agreementId?: string;
  shareId?: string;
  metadata?: Record<string, unknown>;
};

async function clearDemo(tx: {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}): Promise<void> {
  const groups = await tx.query(
    `select distinct g.id
       from groups g
       join members m on m.group_id = g.id
       join users u on u.id = m.user_id
      where lower(u.email) = any($1::text[])`,
    [ACCOUNTS.map((account) => account.email)],
  );
  const groupIds = groups.rows.map((row) => row.id as string);

  if (groupIds.length > 0) {
    const members = await tx.query(
      `select id from members where group_id = any($1::uuid[])`,
      [groupIds],
    );
    const memberIds = members.rows.map((row) => row.id as string);

    // Hypertables and outbox rows carry no cascading foreign key, so they go
    // first; deleting the group then takes bills, shares and reminders with it.
    await tx.query(`delete from ledger_events where group_id = any($1::uuid[])`, [groupIds]);
    await tx.query(`delete from points_events where group_id = any($1::uuid[])`, [groupIds]);
    await tx.query(`delete from agent_events where group_id = any($1::uuid[])`, [groupIds]);
    await tx.query(`delete from notification_events where member_id = any($1::uuid[])`, [
      memberIds,
    ]);
    await tx.query(`delete from notification_outbox where group_id = any($1::uuid[])`, [
      groupIds,
    ]);
    await tx.query(`delete from groups where id = any($1::uuid[])`, [groupIds]);
  }

  await tx.query(`delete from users where lower(email) = any($1::text[])`, [
    ACCOUNTS.map((account) => account.email),
  ]);
}

async function seed(): Promise<void> {
  await withTransaction(async (tx) => {
    await clearDemo(tx);

    const userIds = new Map<AccountKey, string>();
    for (const account of ACCOUNTS) {
      const linkedAt = account.key === 'wallet' ? WALLET_JOINED_AT : ago(3);
      const { rows } = await tx.query<{ id: string }>(
        `insert into users
           (email, display_name, timezone, whatsapp_number,
            near_account, near_verified, near_linked_at)
         values ($1, $2, 'Asia/Bangkok', null, $3, true, $4)
         returning id`,
        [account.email, account.name, account.near, linkedAt],
      );
      userIds.set(account.key, rows[0]!.id);
    }

    const anaId = userIds.get('ana')!;

    const group = await tx.query<{ id: string }>(
      `insert into groups (name, default_currency, kind, owner_id, invite_token)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [GROUP_NAME, CURRENCY, GROUP_KIND, anaId, INVITE_TOKEN],
    );
    const groupId = group.rows[0]!.id;

    const memberIds = new Map<AccountKey, string>();
    for (const [index, account] of ACCOUNTS.entries()) {
      const joinedAt = account.key === 'wallet' ? WALLET_JOINED_AT : ago(3, -index);
      const { rows } = await tx.query<{ id: string }>(
        `insert into members (group_id, user_id, role, near_account, status, joined_at)
         values ($1, $2, $3, $4, 'active', $5)
         returning id`,
        [groupId, userIds.get(account.key), account.role, account.near, joinedAt],
      );
      memberIds.set(account.key, rows[0]!.id);
    }

    const ledger: LedgerSeed[] = [
      {
        at: ago(3),
        type: 'system.group.created',
        actor: 'Ana',
        summary: `Ana started "${GROUP_NAME}"`,
        member: 'ana',
      },
      {
        at: ago(3, -1),
        type: 'member.joined',
        actor: 'Ben',
        summary: 'Ben joined the group',
        member: 'ben',
      },
      {
        at: ago(3, -2),
        type: 'member.joined',
        actor: 'Chai',
        summary: 'Chai joined the group',
        member: 'chai',
      },
      {
        at: WALLET_JOINED_AT,
        type: 'member.joined',
        actor: WALLET_NAME,
        summary: `${WALLET_NAME} joined the group`,
        member: 'wallet',
      },
    ];

    const billShares: Array<Map<AccountKey, { id: string; amount: number }>> = [];
    const agreementIds: string[] = [];

    for (const plan of BILL_PLANS) {
      const total = plan.subtotal + plan.serviceCharge + plan.tip;
      const deadline = ahead(2);
      const openedAt = new Date(plan.createdAt.getTime() - 30 * MINUTE);
      const ledgerStart = ledger.length;

      const agreement = await tx.query<{ id: string }>(
        `insert into agreements
           (group_id, currency, kind, estimated_total, deadline, terms_snapshot, status,
            created_by, fronted_by, created_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, 'accepted', $7, $7, $8)
         returning id`,
        [
          groupId,
          CURRENCY,
          GROUP_KIND,
          total,
          deadline,
          JSON.stringify(TERMS),
          memberIds.get('ana'),
          openedAt,
        ],
      );
      const agreementId = agreement.rows[0]!.id;
      agreementIds.push(agreementId);

      for (const [index, key] of plan.members.entries()) {
        await tx.query(
          `insert into agreement_acceptances (agreement_id, member_id, accepted_at, consent_version)
           values ($1, $2, $3, 'v1')`,
          [
            agreementId,
            memberIds.get(key),
            new Date(openedAt.getTime() + (index + 1) * 2 * MINUTE),
          ],
        );
      }

      const bill = await tx.query<{ id: string }>(
        `insert into bills
           (agreement_id, merchant, currency, kind, subtotal, tax, service_charge, tip, discount,
            total, status, frames_extracted, parsed_at, warnings, created_at)
         values ($1, $2, $3, $4, $5, 0, $6, $7, 0, $8, 'COLLECTING', $9, $10, '[]'::jsonb, $11)
         returning id`,
        [
          agreementId,
          plan.merchant,
          CURRENCY,
          GROUP_KIND,
          plan.subtotal,
          plan.serviceCharge,
          plan.tip,
          total,
          plan.framesExtracted,
          plan.parsedAt,
          plan.createdAt,
        ],
      );
      const billId = bill.rows[0]!.id;

      const perMember = new Map<AccountKey, number>();
      for (const item of plan.items) {
        const { rows } = await tx.query<{ id: string }>(
          `insert into bill_items
             (bill_id, name, qty, unit_price, line_total, confidence, source_frame, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning id`,
          [
            billId,
            item.name,
            item.qty,
            item.unitPrice,
            item.total,
            plan.confidence,
            plan.sourceFrame,
            plan.parsedAt ?? plan.createdAt,
          ],
        );
        const itemId = rows[0]!.id;

        const holders = Object.keys(item.split) as AccountKey[];
        const parts = allocate(
          item.total,
          holders.map((key) => item.split[key] ?? 0),
        );

        for (const [index, key] of holders.entries()) {
          const amount = parts[index] ?? 0;
          await tx.query(
            `insert into allocations (bill_item_id, member_id, qty, amount, status, created_at)
             values ($1, $2, $3, $4, 'confirmed', $5)`,
            [
              itemId,
              memberIds.get(key),
              item.split[key] ?? 1,
              amount,
              new Date((plan.parsedAt ?? plan.createdAt).getTime() + MINUTE),
            ],
          );
          perMember.set(key, (perMember.get(key) ?? 0) + amount);
        }
      }

      // Service charge, tax, tip and any unassigned remainder land on the fronter,
      // exactly as `POST /bills/:id/finalize` does, so the shares add to the total.
      const lineTotal = [...perMember.values()].reduce((sum, amount) => sum + amount, 0);
      const gap = total - lineTotal;
      if (gap < 0) {
        throw new Error(`seed split for ${plan.merchant} is ${money(-gap)} THB over the bill total`);
      }
      if (gap > 0) {
        perMember.set('ana', (perMember.get('ana') ?? 0) + gap);
      }

      const splitTotal = [...perMember.values()].reduce((sum, amount) => sum + amount, 0);
      if (splitTotal !== total) {
        throw new Error(
          `seed split for ${plan.merchant} adds up to ${splitTotal}, expected ${total}`,
        );
      }

      const shares = new Map<AccountKey, { id: string; amount: number }>();
      for (const key of plan.members) {
        const amount = perMember.get(key) ?? 0;
        // Ana fronted every bill, so her share is already settled and carries the
        // repayment clock; everyone else still owes theirs.
        const isPaid = key === 'ana';
        const { rows } = await tx.query<{ id: string }>(
          `insert into shares
             (bill_id, member_id, amount, currency, status, settlement_tx_hash,
              due_at, paid_at, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           returning id`,
          [
            billId,
            memberIds.get(key),
            amount,
            CURRENCY,
            isPaid ? 'paid' : 'requested',
            isPaid ? plan.txHash : null,
            deadline,
            isPaid ? plan.paidAt : null,
            plan.lockedAt,
          ],
        );
        shares.set(key, { id: rows[0]!.id, amount });
      }
      billShares.push(shares);

      // Only a verified transfer writes a payments row, so the paid share has one
      // and the still-open shares do not.
      const paidShare = shares.get('ana')!;
      await tx.query(
        `insert into payments (share_id, provider, provider_ref, amount, currency, status, raw_payload)
         values ($1, 'near_transfer', $2, $3, $4, 'completed', $5::jsonb)`,
        [
          paidShare.id,
          plan.txHash,
          paidShare.amount,
          CURRENCY,
          JSON.stringify({ tx_hash: plan.txHash, rail: 'near_transfer', demo: true }),
        ],
      );

      const parsedAt = plan.parsedAt ?? plan.createdAt;
      const hoursToPay =
        Math.round(((plan.paidAt.getTime() - plan.lockedAt.getTime()) / 3_600_000) * 10) / 10;

      ledger.push({
        at: openedAt,
        type: 'agreement.created',
        actor: 'Ana',
        summary: `Ana opened an agreement for ${plan.merchant} — everyone agrees before anyone pays`,
        amountMinor: total,
        member: 'ana',
      });

      for (const [index, key] of plan.members.filter((key) => key !== 'ana').entries()) {
        ledger.push({
          at: new Date(openedAt.getTime() + (index + 2) * 2 * MINUTE),
          type: 'agreement.accepted',
          actor: NAMES[key],
          summary: `${NAMES[key]} accepted the terms`,
          member: key,
        });
      }

      ledger.push(
        {
          at: plan.createdAt,
          type: 'bill.uploaded',
          actor: 'Ana',
          summary: `Ana added the expense from ${plan.merchant}`,
          member: 'ana',
        },
        {
          at: parsedAt,
          type: 'bill.parsed',
          actor: 'Globie',
          summary: `Globie read ${plan.items.length} items from the expense`,
          amountMinor: total,
          member: 'ana',
        },
        {
          at: new Date(parsedAt.getTime() + MINUTE),
          type: 'bill.allocated',
          actor: 'Globie',
          summary: 'Globie proposed who had what',
          member: 'ana',
        },
        {
          at: new Date(parsedAt.getTime() + 2 * MINUTE),
          type: 'bill.confirmed',
          actor: 'Ben',
          summary: 'Everyone confirmed their own lines',
          member: 'ben',
        },
        {
          at: plan.lockedAt,
          type: 'bill.finalized',
          actor: 'Globie',
          summary: `Shares locked: ${plan.members.length} people, ${money(total)} THB`,
          amountMinor: total,
          member: 'ana',
        },
      );

      for (const key of plan.members.filter((key) => key !== 'ana')) {
        const share = shares.get(key)!;
        ledger.push({
          at: new Date(plan.lockedAt.getTime() + MINUTE),
          type: 'share.requested',
          actor: NAMES[key],
          summary: `${NAMES[key]} was asked for ${money(share.amount)} THB in USDC on NEAR`,
          amountMinor: share.amount,
          member: key,
          shareId: share.id,
          metadata: { rail: 'near_transfer' },
        });
      }

      ledger.push({
        at: plan.paidAt,
        type: 'share.paid',
        actor: 'Ana',
        summary: `Ana paid ${money(paidShare.amount)} THB in USDC on NEAR`,
        amountMinor: paidShare.amount,
        member: 'ana',
        shareId: paidShare.id,
        metadata: { hours_to_pay: hoursToPay, rail: 'near_transfer', tx_hash: plan.txHash },
      });

      for (const entry of ledger.slice(ledgerStart)) {
        entry.agreementId = agreementId;
      }
    }

    // The first bill is the one that carries points and a reminder; the two
    // later receipts exist to give the wallet something open to pay.
    const primaryShares = billShares[0]!;
    const primaryAgreementId = agreementIds[0]!;

    // Ana repaid within 18 hours, which is what the Hero board reads.
    await tx.query(
      `insert into points_awards (agreement_id, member_id, reason, delta, created_at)
       values ($1, $2, 'globie', 10, $3)`,
      [primaryAgreementId, memberIds.get('ana'), BILL_PLANS[0]!.paidAt],
    );
    await tx.query(
      `insert into points_events (time, group_id, member_id, delta, reason, agreement_id, share_id)
       values ($1, $2, $3, 10, 'globie', $4, $5)`,
      [
        BILL_PLANS[0]!.paidAt,
        groupId,
        memberIds.get('ana'),
        primaryAgreementId,
        primaryShares.get('ana')!.id,
      ],
    );

    await tx.query(
      `insert into reminders
         (share_id, scheduled_for, sent_at, channel, template, message, idempotency_key, status)
       values ($1, $2, $2, 'in_app', 'reminder', $3, 'seed:reminder:chai:24h', 'sent')`,
      [
        primaryShares.get('chai')!.id,
        ago(1),
        `Chai, the ${money(primaryShares.get('chai')!.amount)} THB share for ${GROUP_NAME} is still open — pay when you can.`,
      ],
    );

    ledger.push({
      at: ago(1),
      type: 'reminder.sent',
      actor: 'Globie',
      summary: `Globie nudged Chai — ${money(primaryShares.get('chai')!.amount)} THB still open`,
      amountMinor: primaryShares.get('chai')!.amount,
      member: 'chai',
      agreementId: primaryAgreementId,
      shareId: primaryShares.get('chai')!.id,
      metadata: { tone: 'friendly' },
    });

    for (const entry of ledger) {
      await tx.query(
        `insert into ledger_events
           (time, group_id, agreement_id, share_id, member_id, event_type,
            amount_minor, currency, metadata)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          entry.at,
          groupId,
          entry.agreementId ?? null,
          entry.shareId ?? null,
          entry.member ? memberIds.get(entry.member) : null,
          entry.type,
          entry.amountMinor ?? 0,
          CURRENCY,
          JSON.stringify({
            actor: entry.actor,
            summary: entry.summary,
            ...entry.metadata,
          }),
        ],
      );
    }

    const walletOpen = BILL_PLANS.reduce((sum, _plan, index) => {
      const share = billShares[index]!.get('wallet');
      return share ? sum + share.amount : sum;
    }, 0);

    console.log(`[seed] group   ${GROUP_NAME} (${GROUP_KIND}, invite ${INVITE_TOKEN})`);
    console.log(
      `[seed] members ${ACCOUNTS.map(
        (account) => `${account.name} (${account.near})`,
      ).join(', ')}`,
    );
    for (const [index, plan] of BILL_PLANS.entries()) {
      const shares = billShares[index]!;
      const total = plan.subtotal + plan.serviceCharge + plan.tip;
      console.log(
        `[seed] bill    ${money(total)} THB at ${plan.merchant} — ${plan.members
          .map((key) => `${NAMES[key]} ${money(shares.get(key)!.amount)}`)
          .join(', ')}`,
      );
    }
    console.log(`[seed] wallet  ${WALLET_NAME} owes ${money(walletOpen)} THB across 2 open shares`);
  });
}

// `db/` sits outside the `server` package, so this file loads as CJS under
// tsx — hence an async entry point instead of top-level await.
async function main(): Promise<void> {
  try {
    await seed();
    console.log('[seed] done. Sign in as ana@example.com, ben@example.com or chai@example.com,');
    console.log(`[seed] or connect NEAR wallet ${WALLET_NAME}.`);
  } catch (error) {
    console.error('[seed] failed', error);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

void main();
