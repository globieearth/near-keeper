/**
 * NEP-413 sign-in: the only wallet login this app offers.
 *
 * Two steps, because the nonce has to exist before the wallet signs:
 *
 *   1. `POST /auth/near/nonce` mints 32 random bytes, stores the exact message
 *      and recipient that make up the signed payload, and returns them. Only
 *      the hash is the lookup key, so a leaked database row cannot be replayed
 *      without the client also presenting the original nonce string.
 *   2. `POST /auth/near/verify` consumes the nonce, rebuilds the Borsh payload
 *      byte-for-byte, checks the ed25519 signature, checks the key is a
 *      FullAccess key on the account, then mints the 60-day session row.
 *
 * No password, no OAuth client, no signing key on the server.
 */

import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';

import { isUniqueViolation, query } from '../db/pool.js';
import { config } from '../lib/config.js';
import { ApiError } from '../lib/http-error.js';
import { hashToken } from '../lib/ids.js';
import { verifySignedMessage } from '../lib/near-auth.js';
import { isNearAccountId } from '../lib/near.js';
import { issueSession } from '../lib/sessions.js';
import { asRecord, requiredString } from '../lib/validate.js';

type UserRow = { id: string; email: string; display_name: string };

type SessionResponse = {
  token: string;
  userId: string;
  displayName: string;
  nearAccount: string;
};

/** Domains that only ever exist for a wallet that never gave an email. */
const WALLET_EMAIL_DOMAIN = 'near.globie';

/** The recipient string wallets display; the host the request arrived on. */
function recipientFor(host: string | undefined): string {
  return (host ?? 'localhost').split(':')[0]!.toLowerCase();
}

function callbackUrlFor(returnTo: string): string {
  return returnTo === 'native'
    ? config.near.loginNativeReturnUrl
    : config.near.loginWebReturnUrl;
}

/**
 * A human-readable message. Wallets show this verbatim, so it says what is
 * being proven and — just as important — what is not.
 */
function buildMessage(accountId: string, recipient: string, nonce: string): string {
  return [
    'Globie Keeper sign-in',
    '',
    `Account: ${accountId || 'any NEAR account'}`,
    `Recipient: ${recipient}`,
    `Nonce: ${nonce}`,
    '',
    'Signing proves you control this account. It does not move funds or approve a transfer.',
  ].join('\n');
}

/**
 * Find the Globie user behind a verified account, creating one on first login.
 *
 * A wallet-only account needs an email row because `users.email` predates the
 * NEAR rail, so it gets `<account>@near.globie` — deterministic, unique per
 * account (account ids cannot contain `@`), and never sent mail.
 */
async function linkNearAccount(accountId: string, publicKey: string): Promise<UserRow> {
  const found = await query<UserRow>(
    `select id, email, display_name from users
      where lower(near_account) = lower($1)
      limit 1`,
    [accountId],
  );
  if (found.rows[0]) {
    await query(
      `update users
          set near_public_key = $2, near_verified = true, near_linked_at = now()
        where id = $1`,
      [found.rows[0].id, publicKey],
    );
    return found.rows[0];
  }

  const email = `${accountId.toLowerCase()}@${WALLET_EMAIL_DOMAIN}`;

  try {
    const { rows } = await query<UserRow>(
      `insert into users
         (email, display_name, near_account, near_public_key, near_verified, near_linked_at)
       values ($1, $2, $3, $4, true, now())
       returning id, email, display_name`,
      [email, accountId, accountId, publicKey],
    );
    return rows[0]!;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    // A concurrent first login (or a pre-existing row with the same synthetic
    // email) won the insert; re-read instead of failing the sign-in.
    const { rows } = await query<UserRow>(
      `select id, email, display_name from users
        where lower(near_account) = lower($1) or lower(email) = lower($2)
        limit 1`,
      [accountId, email],
    );
    const user = rows[0];
    if (!user) throw error;

    await query(
      `update users
          set near_account = $2, near_public_key = $3, near_verified = true, near_linked_at = now()
        where id = $1`,
      [user.id, accountId, publicKey],
    );
    return user;
  }
}

export async function nearAuthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Step 1: hand the client a challenge. `accountId` is optional — a wallet
   * picker decides the account, so most clients cannot know it yet.
   */
  app.post('/auth/near/nonce', async (request) => {
    const body = asRecord(request.body);

    const accountId =
      typeof body.accountId === 'string' ? body.accountId.trim() : '';
    if (accountId && !isNearAccountId(accountId)) {
      throw ApiError.badRequest(
        'near_account_invalid',
        'That is not a NEAR account id',
      );
    }

    const returnTo = body.returnTo === 'native' ? 'native' : 'web';
    const nonce = randomBytes(32).toString('base64');
    const recipient = recipientFor(request.headers.host);
    const message = buildMessage(accountId, recipient, nonce);
    const callbackUrl = callbackUrlFor(returnTo);

    // Bounded cleanup with no scheduled job: expired nonces go on the next mint.
    await query(
      `delete from near_login_nonces where created_at < now() - interval '10 minutes'`,
    );
    await query(
      `insert into near_login_nonces
         (nonce_hash, account_id, recipient, return_to, nonce, message, callback_url)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        hashToken(nonce),
        accountId || null,
        recipient,
        returnTo,
        nonce,
        message,
        callbackUrl,
      ],
    );

    // The client compares this with the wallet's own network: a signature made
    // on the wrong chain can never be checked against an account here.
    return { nonce, message, recipient, callbackUrl, network: config.near.network };
  });

  /**
   * Step 2: the wallet answered with `{accountId, publicKey, signature}`.
   * Consuming the nonce is the replay check — a second attempt with the same
   * signature finds no row.
   */
  app.post('/auth/near/verify', async (request): Promise<SessionResponse> => {
    const body = asRecord(request.body);
    const accountId = requiredString(body, 'accountId', { min: 2, max: 64 });
    const publicKey = requiredString(body, 'publicKey', { min: 8, max: 80 });
    const signature = requiredString(body, 'signature', { min: 80, max: 120 });
    const nonce = requiredString(body, 'nonce', { min: 40, max: 48 });

    if (!isNearAccountId(accountId)) {
      throw ApiError.badRequest(
        'near_account_invalid',
        'That is not a NEAR account id',
      );
    }

    const consumed = await query<{
      account_id: string | null;
      recipient: string;
      message: string;
      nonce: string;
      callback_url: string | null;
    }>(
      `update near_login_nonces
          set consumed_at = now()
        where nonce_hash = $1
          and consumed_at is null
          and created_at > now() - interval '10 minutes'
      returning account_id, recipient, message, nonce, callback_url`,
      [hashToken(nonce)],
    );

    const row = consumed.rows[0];
    if (!row) {
      throw new ApiError(
        401,
        'near_nonce_invalid',
        'That sign-in request expired or was already used. Try again.',
      );
    }

    if (row.account_id && row.account_id.toLowerCase() !== accountId.toLowerCase()) {
      throw new ApiError(
        401,
        'near_nonce_account_mismatch',
        `This challenge was issued for ${row.account_id}, not ${accountId}`,
      );
    }

    await verifySignedMessage(
      { accountId, publicKey, signature },
      {
        message: row.message,
        nonce: Buffer.from(row.nonce, 'base64'),
        recipient: row.recipient,
        callbackUrl: row.callback_url,
      },
    );

    const user = await linkNearAccount(accountId, publicKey);

    return {
      token: await issueSession(user.id),
      userId: user.id,
      displayName: user.display_name,
      nearAccount: accountId,
    };
  });
}
