/**
 * Canonical terms, so "the member accepted these exact terms" is checkable.
 *
 * `terms_snapshot` is jsonb: Postgres stores it parsed and hands the keys back
 * in its own order, so hashing `JSON.stringify(row.terms_snapshot)` would give
 * a different digest on every round trip. Sorting keys recursively and
 * dropping whitespace produces one byte string per document, which is what
 * gets hashed at creation and re-hashed at every verification.
 *
 * A NEP-413 signature covers this hash (DEV_PLAN §2.21), so a mismatch is not a
 * formatting quirk — it means the terms changed after somebody signed them.
 */

import { createHash } from 'node:crypto';

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry ?? null)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
      .join(',')}}`;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return JSON.stringify(value);
  }

  return JSON.stringify(value);
}

/** One byte string per terms document, independent of key order. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

/** Lowercase hex sha256 of the canonical form — the value members sign. */
export function termsHashOf(snapshot: unknown): string {
  return createHash('sha256').update(canonicalJson(snapshot), 'utf8').digest('hex');
}

/**
 * The exact NEP-413 message a member signs. Kept here so the client and the
 * verifier cannot disagree about wording or separators.
 */
export function consentMessage(input: {
  agreementId: string;
  termsHash: string;
}): string {
  return `Globie agreement ${input.agreementId} · terms sha256:${input.termsHash} · I accept these terms`;
}
