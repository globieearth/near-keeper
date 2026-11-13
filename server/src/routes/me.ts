import type { FastifyPluginAsync } from 'fastify';

import { query } from '../db/pool.js';
import { config } from '../lib/config.js';
import { ApiError } from '../lib/http-error.js';
import { isNearAccountId, isNearConfigured } from '../lib/near.js';
import { channelEnabled, FALLBACK_ORDER, type Channel } from '../lib/notify.js';
import { mapShare, type ShareRow } from '../lib/serialize.js';
import { ensureQuote } from '../lib/settlement-quote.js';
import {
    asRecord,
    currencyCode,
    requiredString,
} from '../lib/validate.js';
import { requireUser } from '../plugins/auth.js';

type ActivityRow = {
  time: Date;
  event_id: string;
  event_type: string;
  amount_minor: number;
  currency: string;
  metadata: Record<string, unknown> | null;
  group_id: string;
  group_name: string;
};

/** A confirmed line on a bill that has not been locked into shares yet. */
type PendingRow = {
  bill_id: string;
  group_id: string;
  group_name: string;
  merchant: string | null;
  currency: string;
  bill_status: string;
  amount_minor: number;
  fronted_by: string | null;
  is_fronter: boolean;
};

/** Currency to show when the member has no open shares yet. */
async function fallbackCurrency(userId: string): Promise<string> {
  const { rows } = await query<{ default_currency: string }>(
    `select g.default_currency
       from members m
       join groups g on g.id = m.group_id
      where m.user_id = $1 and m.status <> 'removed'
      order by m.joined_at asc
      limit 1`,
    [userId],
  );

  const row = rows[0];
  return row ? row.default_currency.trim() : 'THB';
}

/**
 * Consent lives on `notification_preferences` per *member*, because reminders
 * are decided per share. The screen edits it per user, so a channel reads as on
 * unless one of the user's memberships turned it off.
 */
async function notificationSettings(userId: string) {
  const { rows } = await query<{ channel: string; enabled: boolean }>(
    `select p.channel, bool_and(p.enabled) as enabled
       from notification_preferences p
       join members m on m.id = p.member_id
      where m.user_id = $1
      group by p.channel`,
    [userId],
  );

  const off = new Set(rows.filter((row) => !row.enabled).map((row) => row.channel));

  const profile = await query<{ push_token: string | null }>(
    `select push_token from users where id = $1`,
    [userId],
  );

  return {
    channels: FALLBACK_ORDER.map((channel) => ({
      channel,
      enabled: !off.has(channel),
      available: channelEnabled(channel),
    })),
    pushRegistered: Boolean(profile.rows[0]?.push_token),
  };
}

export const meRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Profile plus the display-currency preference (DEV_PLAN §2.19) and the
   * NEAR account reimbursements settle into.
   */
  app.get('/me', async (request) => {
    const auth = requireUser(request);

    const { rows } = await query<{
      display_currency: string | null;
      near_account: string | null;
      near_verified: boolean;
    }>(
      `select u.display_currency, u.near_account, u.near_verified
         from users u
        where u.id = $1`,
      [auth.userId],
    );

    const row = rows[0];

    return {
      userId: auth.userId,
      email: auth.email,
      displayName: auth.displayName,
      displayCurrency: row?.display_currency?.trim() ?? null,
      nearAccount: row?.near_account?.trim() ?? null,
      nearVerified: Boolean(row?.near_verified),
    };
  });

  /**
   * Display currency is presentation only: it changes how amounts are rendered,
   * never what is stored or charged. `null` clears the override, so the client
   * falls back to the device or group currency.
   */
  app.patch('/me', async (request) => {
    const auth = requireUser(request);
    const body = asRecord(request.body);

    if ('displayCurrency' in body) {
      const requested = body.displayCurrency;
      const displayCurrency =
        requested === undefined || requested === null || requested === ''
          ? null
          : currencyCode(requested, 'displayCurrency');

      await query(`update users set display_currency = $2 where id = $1`, [
        auth.userId,
        displayCurrency,
      ]);
    }

    const { rows } = await query<{ display_currency: string | null }>(
      `select display_currency from users where id = $1`,
      [auth.userId],
    );

    return {
      userId: auth.userId,
      displayCurrency: rows[0]?.display_currency?.trim() ?? null,
    };
  });

  /** Everything this user still owes, across every group, oldest deadline first. */
  app.get('/me/shares', async (request) => {
    const auth = requireUser(request);

    const { rows } = await query<ShareRow>(
      `select s.id, s.bill_id, b.agreement_id, a.group_id, g.name as group_name,
              s.member_id, u.display_name as member_name, s.amount, s.currency,
              s.status, s.due_at, s.paid_at, s.created_at,
              s.settlement_tx_hash,
              s.quoted_chain_amount, s.quote_rate, s.quote_as_of,
              coalesce(
                case when fu.near_verified then fm.near_account end,
                case when fu.near_verified then fu.near_account end,
                a.treasury_account
              ) as pay_to
         from shares s
         join bills b on b.id = s.bill_id
         join agreements a on a.id = b.agreement_id
         join groups g on g.id = a.group_id
         join members m on m.id = s.member_id
         join users u on u.id = m.user_id
         left join members fm on fm.id = a.fronted_by
         left join users fu on fu.id = fm.user_id
        where m.user_id = $1
          and m.status <> 'removed'
          and s.status not in ('paid', 'settled', 'refunded')
        order by s.due_at asc nulls last, s.created_at asc`,
      [auth.userId],
    );

    // A requested share needs the recipient, the token amount and the memo so
    // the payer's wallet can sign the transfer.
    const nearReady = isNearConfigured();
    const shares = await Promise.all(
      rows.map(async (row) => {
        const share = mapShare(row);
        // The destination decides whether this share is payable at all, so it
        // is reported even before a quote exists. Missing means the fronter has
        // nowhere to receive, and the screen should say so instead of failing
        // after the payer taps.
        const payTo = row.pay_to && isNearAccountId(row.pay_to) ? row.pay_to : null;

        if (!nearReady || row.status !== 'requested' || !payTo) {
          return { ...share, payTo };
        }

        // The quote was frozen when the payment was requested; a row that
        // predates frozen quotes gets one now, so the payer always has the
        // exact USDC integer this server will verify.
        const quote = await ensureQuote({
          table: 'shares',
          id: row.id,
          amountMinor: row.amount,
          currency: row.currency,
          stored: row,
        });

        return {
          ...share,
          payTo: row.pay_to,
          tokenContract: config.near.usdcContract,
          chainAmount: quote.amount,
          quoteRate: quote.rate,
          quoteAsOf: quote.asOf,
          memo: `globie:${row.id}`,
        };
      }),
    );
    const outstandingMinor = shares.reduce((sum, share) => sum + share.amountMinor, 0);
    const currency = shares.length > 0 ? shares[0]!.currency : await fallbackCurrency(auth.userId);

    // Lines this member has already confirmed on a bill the fronter has not
    // locked yet. `shares` rows only exist after `POST /bills/:id/finalize`,
    // so without this bucket a member who did everything right sees THB 0.00
    // and concludes their confirmation was lost.
    const { rows: pendingRows } = await query<PendingRow>(
      `select b.id as bill_id, a.group_id, g.name as group_name,
              b.merchant, b.currency, b.status as bill_status,
              sum(al.amount)::int as amount_minor,
              fu.display_name as fronted_by,
              bool_or(a.fronted_by = me.id) as is_fronter
         from allocations al
         join bill_items bi on bi.id = al.bill_item_id
         join bills b on b.id = bi.bill_id
         join agreements a on a.id = b.agreement_id
         join groups g on g.id = a.group_id
         join members me on me.id = al.member_id
         left join members fm on fm.id = a.fronted_by
         left join users fu on fu.id = fm.user_id
        where me.user_id = $1
          and me.status <> 'removed'
          and al.status = 'confirmed'
          and b.status in ('UPLOADED', 'PARSING', 'PARSED', 'ALLOCATED', 'CONFIRMED')
          and not exists (select 1 from shares s where s.bill_id = b.id)
          and al.amount > 0
        group by b.id, a.group_id, g.name, b.merchant, b.currency, b.status,
                 fu.display_name, b.created_at
        order by b.created_at asc`,
      [auth.userId],
    );

    const pending = pendingRows.map((row) => ({
      billId: row.bill_id,
      groupId: row.group_id,
      groupName: row.group_name,
      merchant: row.merchant,
      amountMinor: row.amount_minor,
      currency: row.currency.trim(),
      billStatus: row.bill_status,
      frontedBy: row.fronted_by,
      isFronter: row.is_fronter,
    }));

    return { shares, outstandingMinor, currency, pending };
  });

  /**
   * Everything that happened in every group this user belongs to, newest first.
   * The row shape mirrors `/groups/:id/timeline` so one renderer serves both
   * feeds; `groupName` is what the cross-group version adds.
   */
  app.get('/me/activity', async (request) => {
    const auth = requireUser(request);

    const { rows } = await query<ActivityRow>(
      `select e.time, e.event_id, e.event_type, e.amount_minor, e.currency, e.metadata,
              e.group_id, g.name as group_name
         from ledger_events e
         join groups g on g.id = e.group_id
         join members m on m.group_id = e.group_id
        where m.user_id = $1 and m.status <> 'removed'
        order by e.time desc
        limit 60`,
      [auth.userId],
    );

    const events = rows.map((row) => {
      const metadata = row.metadata ?? {};
      const actor =
        typeof metadata.actor === 'string' && metadata.actor ? metadata.actor : 'Globie';
      const summary =
        typeof metadata.summary === 'string' && metadata.summary
          ? metadata.summary
          : row.event_type;

      return {
        id: row.event_id,
        at: new Date(row.time).toISOString(),
        actor,
        type: row.event_type,
        summary,
        groupId: row.group_id,
        groupName: row.group_name,
        ...(row.amount_minor > 0
          ? { amountMinor: row.amount_minor, currency: row.currency }
          : {}),
        ...(typeof metadata.tx_hash === 'string' && metadata.tx_hash
          ? { txHash: metadata.tx_hash }
          : {}),
      };
    });

    return { events };
  });

  /** Globie balance across every group this user belongs to. */
  app.get('/me/points', async (request) => {
    const auth = requireUser(request);

    const { rows } = await query<{ balance: number }>(
      `select coalesce(sum(pa.delta), 0)::bigint as balance
         from points_awards pa
         join members m on m.id = pa.member_id
        where m.user_id = $1`,
      [auth.userId],
    );

    return { balance: rows[0]?.balance ?? 0 };
  });

  // --- notifications (DEV_PLAN §2.13) -------------------------------------

  app.get('/me/notifications', async (request) => {
    const auth = requireUser(request);
    return notificationSettings(auth.userId);
  });

  /** One toggle fans out to every membership, so the screen stays per-user. */
  app.patch('/me/notifications', async (request) => {
    const auth = requireUser(request);
    const body = asRecord(request.body);
    const channel = body.channel;

    if (typeof channel !== 'string' || !FALLBACK_ORDER.includes(channel as Channel)) {
      throw ApiError.badRequest(
        'invalid_channel',
        `channel must be one of ${FALLBACK_ORDER.join(', ')}`,
      );
    }
    if (typeof body.enabled !== 'boolean') {
      throw ApiError.badRequest('invalid_enabled', 'enabled must be a boolean');
    }

    await query(
      `insert into notification_preferences (member_id, channel, enabled)
       select m.id, $2, $3
         from members m
        where m.user_id = $1 and m.status <> 'removed'
       on conflict (member_id, channel)
       do update set enabled = excluded.enabled, updated_at = now()`,
      [auth.userId, channel, body.enabled],
    );

    return notificationSettings(auth.userId);
  });

  /** The Expo push token this handset registered; one device, one user. */
  app.post('/me/push-token', async (request) => {
    const auth = requireUser(request);
    const body = asRecord(request.body);
    const token = requiredString(body, 'token', { min: 8, max: 200 });

    await query(`update users set push_token = $2 where id = $1`, [auth.userId, token]);
    return { registered: true };
  });

  /** Sign-out clears it so the next account on this handset gets no pushes. */
  app.delete('/me/push-token', async (request) => {
    const auth = requireUser(request);
    await query(`update users set push_token = null where id = $1`, [auth.userId]);
    return { registered: false };
  });
};
