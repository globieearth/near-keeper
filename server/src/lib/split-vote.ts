/**
 * Split-mode voting.
 *
 * A group decides how to divide an expense in one of two ways — `itemised`
 * (each member takes what they consumed) or `equal` (the total is divided
 * evenly). The choice is voted on twice over: once on the agreement, and again
 * on a single bill when that expense deserves a different rule.
 *
 * The outcome is never stored. It is derived from the current votes every time
 * it is read, so changing your mind takes effect immediately:
 *
 *   1. Bill votes, when any member has cast one on this bill.
 *   2. Else agreement votes, when any member has cast one on the agreement.
 *   3. Else the mode stored on the agreement when it was created.
 *
 * A majority wins. When the two sides are level and at least one vote exists,
 * the fronter's own vote breaks the tie. Nobody voting is not a tie — it is the
 * creator's original choice. Votes come only from members who are still in the
 * group (`status <> 'removed'`); the count of eligible voters is reported so
 * the client can say "2 of 4 voted".
 */

import { query } from '../db/pool.js';
import type { SplitVote } from './kinds.js';

export type SplitVoteRow = { member_id: string; mode: SplitVote };

export type SplitVoteSummary = {
  /** Votes per option, so the client can render a bar without re-counting. */
  tally: Record<SplitVote, number>;
  totalVotes: number;
  /** Active members eligible to vote, whether or not they did. */
  memberCount: number;
  /** The caller's own vote, on this bill first, then on the agreement. */
  myVote: SplitVote | null;
  resolvedMode: SplitVote;
  /** Which layer produced `resolvedMode`. */
  source: 'bill' | 'agreement' | 'default';
  /** True when the counts were level and the fronter's vote decided it. */
  tie: boolean;
};

/** The only fallback when nobody has voted: the mode the creator signed. */
export function defaultSplitMode(stored: string | null | undefined): SplitVote {
  return stored === 'equal' ? 'equal' : 'itemised';
}

export function tallySplitVotes(votes: SplitVoteRow[]): Record<SplitVote, number> {
  const tally: Record<SplitVote, number> = { itemised: 0, equal: 0 };
  for (const vote of votes) {
    if (vote.mode === 'equal') tally.equal += 1;
    else tally.itemised += 1;
  }
  return tally;
}

/**
 * Majority first; on a level count the fronter's own vote decides. `fallback`
 * is only used when there are no votes at all, or when the fronter did not vote
 * in a tie they alone could break.
 */
export function decideSplitVote(
  votes: SplitVoteRow[],
  fronterId: string | null,
  fallback: SplitVote,
): { mode: SplitVote; tie: boolean } {
  const tally = tallySplitVotes(votes);
  if (tally.equal !== tally.itemised) {
    return { mode: tally.equal > tally.itemised ? 'equal' : 'itemised', tie: false };
  }
  if (votes.length === 0) return { mode: fallback, tie: false };
  const fronterVote = fronterId
    ? votes.find((vote) => vote.member_id === fronterId)
    : undefined;
  return { mode: fronterVote?.mode ?? fallback, tie: true };
}

async function loadAgreementVotes(agreementId: string): Promise<SplitVoteRow[]> {
  const { rows } = await query<SplitVoteRow>(
    `select member_id, mode from agreement_split_votes where agreement_id = $1`,
    [agreementId],
  );
  return rows;
}

async function loadBillVotes(billId: string): Promise<SplitVoteRow[]> {
  const { rows } = await query<SplitVoteRow>(
    `select member_id, mode from bill_split_votes where bill_id = $1`,
    [billId],
  );
  return rows;
}

async function countActiveMembers(groupId: string): Promise<number> {
  const { rows } = await query<{ count: number }>(
    `select count(*)::int as count
       from members where group_id = $1 and status <> 'removed'`,
    [groupId],
  );
  return rows[0]?.count ?? 0;
}

export type SplitSummaryScope = {
  groupId: string;
  /** The stored `agreements.split_mode`; the fallback when nobody votes. */
  storedMode: string | null;
  frontedBy: string | null;
  /** The caller — used only to report their own vote. */
  memberId: string;
};

export async function loadAgreementSplitSummary(
  scope: SplitSummaryScope & { agreementId: string },
): Promise<SplitVoteSummary> {
  const [votes, memberCount] = await Promise.all([
    loadAgreementVotes(scope.agreementId),
    countActiveMembers(scope.groupId),
  ]);
  const fallback = defaultSplitMode(scope.storedMode);
  const decided = decideSplitVote(votes, scope.frontedBy, fallback);
  return {
    tally: tallySplitVotes(votes),
    totalVotes: votes.length,
    memberCount,
    myVote: votes.find((vote) => vote.member_id === scope.memberId)?.mode ?? null,
    resolvedMode: decided.mode,
    source: votes.length > 0 ? 'agreement' : 'default',
    tie: decided.tie,
  };
}

/**
 * The effective rule for one bill: bill votes outrank agreement votes, which
 * outrank the stored mode. This is what the arithmetic must obey.
 */
export async function loadBillSplitSummary(
  scope: SplitSummaryScope & { billId: string; agreementId: string },
): Promise<SplitVoteSummary> {
  const [billVotes, agreementVotes, memberCount] = await Promise.all([
    loadBillVotes(scope.billId),
    loadAgreementVotes(scope.agreementId),
    countActiveMembers(scope.groupId),
  ]);
  const fallback = defaultSplitMode(scope.storedMode);
  const myVote =
    billVotes.find((vote) => vote.member_id === scope.memberId)?.mode ??
    agreementVotes.find((vote) => vote.member_id === scope.memberId)?.mode ??
    null;

  if (billVotes.length > 0) {
    const decided = decideSplitVote(billVotes, scope.frontedBy, fallback);
    return {
      tally: tallySplitVotes(billVotes),
      totalVotes: billVotes.length,
      memberCount,
      myVote,
      resolvedMode: decided.mode,
      source: 'bill',
      tie: decided.tie,
    };
  }
  if (agreementVotes.length > 0) {
    const decided = decideSplitVote(agreementVotes, scope.frontedBy, fallback);
    return {
      tally: tallySplitVotes(agreementVotes),
      totalVotes: agreementVotes.length,
      memberCount,
      myVote,
      resolvedMode: decided.mode,
      source: 'agreement',
      tie: decided.tie,
    };
  }
  return {
    tally: { itemised: 0, equal: 0 },
    totalVotes: 0,
    memberCount,
    myVote,
    resolvedMode: fallback,
    source: 'default',
    tie: false,
  };
}

/** Upsert: a member re-voting replaces their previous choice. */
export async function castAgreementSplitVote(input: {
  agreementId: string;
  memberId: string;
  mode: SplitVote;
}): Promise<void> {
  await query(
    `insert into agreement_split_votes (agreement_id, member_id, mode)
     values ($1, $2, $3)
     on conflict (agreement_id, member_id)
       do update set mode = excluded.mode, updated_at = now()`,
    [input.agreementId, input.memberId, input.mode],
  );
}

export async function castBillSplitVote(input: {
  billId: string;
  memberId: string;
  mode: SplitVote;
}): Promise<void> {
  await query(
    `insert into bill_split_votes (bill_id, member_id, mode)
     values ($1, $2, $3)
     on conflict (bill_id, member_id)
       do update set mode = excluded.mode, updated_at = now()`,
    [input.billId, input.memberId, input.mode],
  );
}
