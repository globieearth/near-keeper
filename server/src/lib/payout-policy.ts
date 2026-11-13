/**
 * The bounty payout tier engine.
 *
 * Every payout is either unlocked by reputation (small and mid tiers) or goes
 * to the DAO council (large, or an untrusted contributor). The rules live here
 * as a pure function so the same decision can be explained in the UI, tested
 * without a database, and re-checked by hand from the numbers shown on screen.
 *
 * Caps are in minor units of the group currency. They are enforced by this API
 * before a proposal is ever prepared; the chain's own policy is the second
 * gate, never the first one to be asked.
 */

import { currencyExponent } from './money.js';

export type PayoutTier = 'auto' | 'council_one' | 'dao';

/** A member's reputation unlocks a tier; the cap decides whether it applies. */
export const TRUST_AUTO_THRESHOLD = 30;
export const TRUST_MID_THRESHOLD = 60;

export type TreasuryCaps = {
  autoApproveCapMinor: number;
  midApproveCapMinor: number;
  periodCapMinor: number;
};

export type TierDecision = {
  tier: PayoutTier;
  /** Policy role the proposal is addressed to. */
  roleName: string;
  /** Short machine-readable reason, rendered verbatim by the client. */
  reason: string;
};

export type TierInput = {
  amountMinor: number;
  trustScore: number;
  /** Bounty money already committed in the current rolling period. */
  spentInPeriodMinor: number;
  caps: TreasuryCaps;
  roleNames: { auto: string; council: string };
  /** A role that is absent from the on-chain policy cannot be used. */
  autoRoleExists?: boolean;
};

function clampTrust(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(100, Math.max(0, Math.trunc(score)));
}

/**
 * Decide how much approval a payout needs.
 *
 * Order matters: the period budget is checked first, because spending past it
 * is a treasury decision no reputation can override. `auto` then needs both a
 * small amount and a proven contributor; `council_one` only relaxes the role.
 */
export function decidePayoutTier(input: TierInput): TierDecision {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new Error('amountMinor must be a positive integer in minor units');
  }

  const trust = clampTrust(input.trustScore);
  const spent = Number.isSafeInteger(input.spentInPeriodMinor)
    ? Math.max(0, input.spentInPeriodMinor)
    : 0;
  const { caps } = input;
  const autoRoleExists = input.autoRoleExists ?? true;

  const periodExceeded = spent + input.amountMinor > caps.periodCapMinor;
  if (periodExceeded) {
    return {
      tier: 'dao',
      roleName: input.roleNames.council,
      reason: 'period_cap_reached',
    };
  }

  if (
    autoRoleExists &&
    trust >= TRUST_AUTO_THRESHOLD &&
    input.amountMinor <= caps.autoApproveCapMinor
  ) {
    return {
      tier: 'auto',
      roleName: input.roleNames.auto,
      reason: 'trusted_small_payout',
    };
  }

  if (trust >= TRUST_MID_THRESHOLD && input.amountMinor <= caps.midApproveCapMinor) {
    return {
      tier: 'council_one',
      roleName: input.roleNames.council,
      reason: 'trusted_mid_payout',
    };
  }

  let reason = 'above_mid_cap';
  if (input.amountMinor <= caps.midApproveCapMinor) {
    reason = trust < TRUST_AUTO_THRESHOLD ? 'trust_below_auto' : 'trust_below_mid';
  }
  return { tier: 'dao', roleName: input.roleNames.council, reason };
}

export type TrustInput = {
  completedCount: number;
  /** Lifetime bounty money paid in minor units of `currency`. */
  paidMinor: number;
  currency: string;
};

/**
 * Recompute a member's 0-100 trust score from what actually happened: each
 * completed bounty is worth 10 points, and every 10 whole units paid adds one
 * more, capped at 30. Three completions reach the auto tier; six reach the mid
 * tier; 100 needs both volume and consistency.
 *
 * Only executed payouts call this, so an unpaid claim cannot inflate a score.
 */
export function trustScoreFor(input: TrustInput): number {
  const exponent = currencyExponent(input.currency);
  const wholeUnits = Math.floor(
    Math.max(0, input.paidMinor) / 10 ** exponent,
  );
  const volumePoints = Math.min(30, Math.floor(wholeUnits / 10));
  const completionPoints = Math.max(0, Math.trunc(input.completedCount)) * 10;

  return Math.min(100, completionPoints + volumePoints);
}
