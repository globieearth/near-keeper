/**
 * Shareable pay links (migration 019).
 *
 * A link resolves to one share's payment instructions and nothing else. It is
 * a convenience for forwarding, not a second settlement path: the payer still
 * signs a NEP-141 transfer, and `settleShareFromNear()` still decides whether
 * the money moved.
 */

import { query } from '../db/pool.js';
import { createPayLinkToken } from './ids.js';

/** 24 random bytes in base64url: exactly 32 characters, never a uuid. */
const TOKEN = /^[A-Za-z0-9_-]{32}$/;

export function isPayLinkToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

/**
 * The token for this share, created on first request. Re-asking returns the
 * same link: a member who forwards it twice must not end up with two URLs that
 * look equally authoritative.
 */
export async function ensureSharePayLink(input: {
  shareId: string;
  memberId: string;
}): Promise<string> {
  const existing = await query<{ token: string }>(
    'select token from share_pay_links where share_id = $1',
    [input.shareId],
  );
  const known = existing.rows[0]?.token;
  if (known) return known;

  // `on conflict (share_id) do nothing` makes a concurrent first request read
  // the winner's token instead of failing on the unique constraint.
  const inserted = await query<{ token: string }>(
    `insert into share_pay_links (token, share_id, created_by_member_id)
     values ($1, $2, $3)
     on conflict (share_id) do nothing
     returning token`,
    [createPayLinkToken(), input.shareId, input.memberId],
  );
  const created = inserted.rows[0]?.token;
  if (created) return created;

  const reread = await query<{ token: string }>(
    'select token from share_pay_links where share_id = $1',
    [input.shareId],
  );
  const raced = reread.rows[0]?.token;
  if (!raced) throw new Error('Could not create a pay link for this share');
  return raced;
}
