import { query } from '../db/pool.js';
import { config } from './config.js';
import { createSessionToken, hashToken } from './ids.js';

/** Bearer token plus its 60-day row; NEAR sign-in is the only caller. */
export async function issueSession(userId: string): Promise<string> {
  const token = createSessionToken();
  await query(
    `insert into sessions (token_hash, user_id, expires_at)
     values ($1, $2, now() + ($3 || ' days')::interval)`,
    [hashToken(token), userId, String(config.sessionTtlDays)],
  );
  return token;
}
