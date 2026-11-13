import { ApiError } from './http-error.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY = /^[A-Z]{3}$/;

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('invalid_body', 'Expected a JSON object body');
  }
  return value as Record<string, unknown>;
}

export function requiredString(
  source: Record<string, unknown>,
  key: string,
  { min = 1, max = 200 }: { min?: number; max?: number } = {},
): string {
  const value = source[key];
  if (typeof value !== 'string') {
    throw ApiError.badRequest(`invalid_${key}`, `${key} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw ApiError.badRequest(
      `invalid_${key}`,
      `${key} must be ${min}-${max} characters`,
    );
  }
  return trimmed;
}

export function optionalString(
  source: Record<string, unknown>,
  key: string,
  max = 200,
): string | null {
  const value = source[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw ApiError.badRequest(`invalid_${key}`, `${key} must be a string`);
  }
  return value.trim().slice(0, max);
}

export function requiredUuid(
  source: Record<string, unknown>,
  key: string,
): string {
  const value = source[key];
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw ApiError.badRequest(`invalid_${key}`, `${key} must be a UUID`);
  }
  return value;
}

export function pathUuid(value: unknown, key = 'id'): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw ApiError.badRequest(`invalid_${key}`, `${key} must be a UUID`);
  }
  return value;
}

export function requiredMinor(
  source: Record<string, unknown>,
  key: string,
): number {
  const value = source[key];
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw ApiError.badRequest(
      `invalid_${key}`,
      `${key} must be a non-negative integer in minor units`,
    );
  }
  return value;
}

export function currencyCode(value: unknown, key = 'currency'): string {
  if (typeof value !== 'string' || !CURRENCY.test(value.toUpperCase())) {
    throw ApiError.badRequest(`invalid_${key}`, `${key} must be an ISO-4217 code`);
  }
  return value.toUpperCase();
}

/**
 * A closed vocabulary. `fallback` makes the key optional; without it the key
 * is required. The error names every accepted value so a client never has to
 * guess.
 */
export function enumValue<T extends string>(
  source: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback?: T,
): T {
  const value = source[key];
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw ApiError.badRequest(`invalid_${key}`, `${key} is required`);
  }
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw ApiError.badRequest(
      `invalid_${key}`,
      `${key} must be one of ${allowed.join(', ')}`,
    );
  }
  return value as T;
}

/**
 * An optional rate in basis points. 10000 bps is 100%, which is the ceiling
 * for both the monthly rate and the cap — beyond that a late fee stops being a
 * penalty and becomes the whole debt again.
 */
export function optionalBps(
  source: Record<string, unknown>,
  key: string,
  max = 10000,
): number | null {
  const value = source[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw ApiError.badRequest(`invalid_${key}`, `${key} must be a whole number of basis points`);
  }
  if (value <= 0 || value > max) {
    throw ApiError.badRequest(
      `invalid_${key}`,
      `${key} must be between 1 and ${max} basis points`,
    );
  }
  return value;
}

/**
 * Opting out is the empty string or null; anything else must be a plain string.
 */
export function optionalDate(
  source: Record<string, unknown>,
  key: string,
): Date | null {
  const value = source[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw ApiError.badRequest(`invalid_${key}`, `${key} must be an ISO date`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw ApiError.badRequest(`invalid_${key}`, `${key} is not a valid date`);
  }
  return date;
}
