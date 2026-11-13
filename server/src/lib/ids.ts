import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** Opaque bearer token handed to the client. Only its hash is stored. */
export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * A shareable pay link's bearer token. Unlike a session token it is stored in
 * the clear: it is meant to be forwarded, and it grants nothing but the ability
 * to read one share's payment instructions.
 */
export function createPayLinkToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Short, human-readable invite code shown in the group screen. */
export function createInviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  let code = '';
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return code;
}

export function newId(): string {
  return randomUUID();
}
