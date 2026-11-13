/**
 * NEP-413 — "sign in with NEAR" — verification.
 *
 * The wallet signs
 *
 *   sha256( u32le(2^31 + 413) || borsh{ message, nonce, recipient, callbackUrl } )
 *
 * with an ed25519 key. Three details are easy to get wrong and impossible to
 * notice until a real wallet returns a signature that will not verify:
 *
 *   1. the Borsh field order is message, nonce, recipient, callbackUrl — the
 *      nonce comes before the recipient;
 *   2. NEAR signs the SHA-256 digest of those bytes, not the bytes themselves;
 *   3. near-api-js — which most NEAR wallets bundle — does not encode strings
 *      the way the Borsh spec says. Its `encode_string` writes the length as
 *      the number of UTF-16 code units and each character as `charCodeAt`
 *      truncated to one byte, so `·` (U+00B7) becomes a single `0xB7` instead
 *      of the two UTF-8 bytes `C2 B7`. ASCII messages are identical under both
 *      encodings, which is why login (ASCII) always worked and only consent
 *      (which contains `·`) failed. Verification therefore accepts either
 *      digest.
 *
 * Possession of a signature is not enough: the key must also be a FullAccess
 * key on the account right now, otherwise a FunctionCall-only key could be
 * used to impersonate an account it can only call one contract on.
 *
 * Nothing here signs, stores or moves funds.
 */

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { ApiError } from './http-error.js';
import { rpc } from './near.js';

/** 2^31 + 413, the Borsh tag NEP-413 prepends to the payload. */
const NEP413_TAG = 2_147_484_061;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Ed25519 SubjectPublicKeyInfo header; node:crypto wants DER, not 32 raw bytes. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export type Nep413Payload = {
  message: string;
  /** 32 raw bytes. */
  nonce: Buffer;
  recipient: string;
  callbackUrl?: string | null;
};

export type Nep413SignedMessage = {
  accountId: string;
  /** `ed25519:<base58>` */
  publicKey: string;
  /** base64 of the 64-byte detached signature. */
  signature: string;
};

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u32(bytes.length), bytes]);
}

/**
 * Borsh as near-api-js (and so most NEAR wallets) actually writes strings:
 * the length is the number of UTF-16 code units and each character is stored
 * as its low byte (`charCodeAt & 0xff`) instead of its UTF-8 bytes.
 *
 * For ASCII the two encodings are identical, but the canonical consent message
 * contains `·` (U+00B7), which near-api-js turns into one byte where the
 * Borsh spec turns it into two. A wallet only ever produces one of the two
 * digests, so verification has to accept either.
 */
function borshStringNearApi(value: string): Buffer {
  const bytes = Buffer.alloc(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return Buffer.concat([u32(value.length), bytes]);
}

/** Borsh `Option<String>`: one tag byte, then the string when present. */
function borshOptionString(value: string | null | undefined): Buffer {
  if (value === null || value === undefined) return Buffer.from([0]);
  return Buffer.concat([Buffer.from([1]), borshString(value)]);
}

/**
 * The exact bytes a wallet signs, minus the tag and the hash. Exported so the
 * `verify:near` style scripts and tests can reproduce a payload byte-for-byte.
 */
export function encodePayload(payload: Nep413Payload): Buffer {
  return Buffer.concat([
    borshString(payload.message),
    payload.nonce,
    borshString(payload.recipient),
    borshOptionString(payload.callbackUrl),
  ]);
}

/** Same payload, serialized the way near-api-js-based wallets serialize it. */
function encodePayloadNearApi(payload: Nep413Payload): Buffer {
  return Buffer.concat([
    borshStringNearApi(payload.message),
    payload.nonce,
    borshStringNearApi(payload.recipient),
    borshOptionString(payload.callbackUrl),
  ]);
}

/** sha256 of the tagged payload — what ed25519 actually signs. */
export function payloadDigest(payload: Nep413Payload): Buffer {
  return createHash('sha256')
    .update(Buffer.concat([u32(NEP413_TAG), encodePayload(payload)]))
    .digest();
}

function payloadDigestNearApi(payload: Nep413Payload): Buffer {
  return createHash('sha256')
    .update(Buffer.concat([u32(NEP413_TAG), encodePayloadNearApi(payload)]))
    .digest();
}

export function base58Decode(value: string): Buffer {
  let zeros = 0;
  while (zeros < value.length && value[zeros] === '1') zeros += 1;

  let numeric = 0n;
  for (const char of value) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index < 0) {
      throw ApiError.badRequest('near_login_bad_public_key', 'That public key is not base58');
    }
    numeric = numeric * 58n + BigInt(index);
  }

  const hex = numeric === 0n ? '' : numeric.toString(16);
  const body = Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, 'hex');
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

export function decodePublicKey(publicKey: string): Buffer {
  if (!publicKey.startsWith('ed25519:')) {
    throw ApiError.badRequest(
      'near_login_bad_public_key',
      'Only ed25519 keys can sign a NEP-413 message',
    );
  }

  const bytes = base58Decode(publicKey.slice('ed25519:'.length));
  if (bytes.length !== 32) {
    throw ApiError.badRequest('near_login_bad_public_key', 'That public key is not 32 bytes');
  }
  return bytes;
}

/**
 * True when `signature` is a valid detached ed25519 signature over the digest
 * by the account key. A malformed signature is a `false`, never a crash.
 */
export function verifyPayloadSignature(
  payload: Nep413Payload,
  publicKey: string,
  signature: string,
): boolean {
  const signatureBytes = Buffer.from(signature, 'base64');
  if (signatureBytes.length !== 64) return false;

  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, decodePublicKey(publicKey)]),
      format: 'der',
      type: 'spki',
    });
    // Wallets built on near-api-js encode strings differently from the Borsh
    // spec, so only one of these two digests can ever match a given signature.
    return [payloadDigest(payload), payloadDigestNearApi(payload)].some((digest) =>
      verifySignature(null, digest, key, signatureBytes),
    );
  } catch {
    return false;
  }
}

export type NearAccessKey = {
  fullAccess: boolean;
  nonce: number;
  blockHeight: number;
};

type AccessKeyView = {
  block_height?: number;
  nonce?: number;
  permission?: 'FullAccess' | { FunctionCall?: unknown } | string;
  /**
   * `view_access_key` reports a missing key or account as a string here, inside
   * an HTTP 200 `result`, not as a JSON-RPC `error` object.
   */
  error?: string | null;
};

/** `view_access_key` for one account/key pair, normalised to the two facts we need. */
export async function viewAccessKey(
  accountId: string,
  publicKey: string,
): Promise<NearAccessKey> {
  let result: AccessKeyView;

  try {
    result = await rpc<AccessKeyView>('query', {
      request_type: 'view_access_key',
      finality: 'final',
      account_id: accountId,
      public_key: publicKey,
    });
  } catch (error) {
    // A key that is not on the account is an RPC error, but for a login it is
    // a plain "this wallet does not control this account".
    if (error instanceof ApiError && /does not exist/i.test(error.message)) {
      throw new ApiError(
        401,
        'near_login_key_not_found',
        `${publicKey} is not a key on ${accountId}`,
      );
    }
    throw error;
  }

  if (result?.error) {
    if (/does not exist/i.test(result.error)) {
      throw new ApiError(
        401,
        'near_login_key_not_found',
        `${publicKey} is not a key on ${accountId}`,
      );
    }
    throw new ApiError(502, 'near_rpc_failed', result.error);
  }

  return {
    fullAccess: result?.permission === 'FullAccess',
    nonce: Number(result?.nonce ?? 0),
    blockHeight: Number(result?.block_height ?? 0),
  };
}

/** Login is refused unless the signing key can also act for the whole account. */
export async function assertFullAccessKey(
  accountId: string,
  publicKey: string,
): Promise<NearAccessKey> {
  const key = await viewAccessKey(accountId, publicKey);
  if (!key.fullAccess) {
    throw new ApiError(
      401,
      'near_login_key_not_full_access',
      `${publicKey} is a function-call key, so it cannot prove control of ${accountId}`,
    );
  }
  return key;
}

/**
 * Full NEP-413 check: signature first (cheap), then the on-chain key permission
 * (an RPC round-trip). Throws a 401-coded `ApiError` on every failure so the
 * client can explain exactly what went wrong.
 */
export async function verifySignedMessage(
  signed: Nep413SignedMessage,
  payload: Nep413Payload,
): Promise<NearAccessKey> {
  // Check the key itself before the signature: a malformed key is not a wrong
  // signature, and the client has a different, more actionable message for it.
  decodePublicKey(signed.publicKey);
  if (!verifyPayloadSignature(payload, signed.publicKey, signed.signature)) {
    throw new ApiError(
      401,
      'near_login_bad_signature',
      'That signature does not match the account key and this message',
    );
  }
  return assertFullAccessKey(signed.accountId, signed.publicKey);
}
