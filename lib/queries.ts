import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
    agreementAcceptances,
    anchorAgreement,
    claimSocialBounty,
    confirmSocialDaoTreasury,
    createSharePayLink,
    createSocialBounty,
    decideSocialClaim,
    fetchBounty,
    fetchBountyBoard,
    fetchContributorTrust,
    fetchFundCatalogue,
    fetchFundDeeds,
    fetchPublicBountyBoard,
    fetchSocialTreasuries,
    linkNearAccount,
    nearStatus,
    prepareBountyPayout,
    previewBountyPayout,
    raiseInterestCharge,
    recordBountyPayoutTx,
    registerSocialTreasury,
    request,
    requestAgreementConsent,
    requestFundQuote,
    requestNearTransfer,
    requestTipTransfer,
    settleFromNear,
    settleFundDeed,
    settleInterestFromNear,
    settleTipFromNear,
    submitAgreementConsent,
    submitSocialClaim,
    syncBountyPayout,
    syncSocialTreasury
} from './api';
import type { FxSnapshot } from './fx';
import type {
    AgentChatResponse,
    AgentResponse,
    AgentToolName,
    AgentTurn,
    Agreement,
    Allocation,
    Bill,
    FundAsset,
    Group,
    HelpTopic,
    InterestCharge,
    InterestResponse,
    LeaderboardRow,
    Member,
    PendingShare,
    Share,
    SignedConsent,
    SocialPayout,
    SocialPayoutPlan,
    SocialTreasury,
    SplitVote,
    SplitVoteSummary,
    TimelineEvent,
    TipsResponse
} from './types';

export type GroupDetail = {
  group: Group;
  members: Member[];
  agreements: Agreement[];
  activeAgreementId: string | null;
  /** Kept for older screens; equal to the active agreement. */
  agreement: Agreement | null;
  /** How the group wants the active agreement divided, if anyone voted. */
  splitVote: SplitVoteSummary | null;
  bill: Bill | null;
  me: Member;
};

/** A membership row in the signed-in member's own group list. */
export type MyGroup = Group & {
  role: Member['role'];
  memberCount: number;
};

export const queryKeys = {
  group: (groupId: string) => ['group', groupId] as const,
  timeline: (groupId: string) => ['timeline', groupId] as const,
  bill: (billId: string) => ['bill', billId] as const,
  leaderboard: (groupId: string) => ['leaderboard', groupId] as const,
  tips: (billId: string) => ['tips', billId] as const,
  interest: (billId: string) => ['interest', billId] as const,
  fxRates: ['fx', 'rates'] as const,
  /** The challenge a wallet is asked to sign; single-use, so never cached long. */
  agreementConsent: (agreementId: string) => ['agreement', agreementId, 'consent'] as const,
  /** Who signed, with which account, and which signatures are anchored. */
  agreementAcceptances: (agreementId: string) =>
    ['agreement', agreementId, 'acceptances'] as const,
  myProfile: ['me', 'profile'] as const,
  myGroups: ['me', 'groups'] as const,
  myShares: ['me', 'shares'] as const,
  myPoints: ['me', 'points'] as const,
  myActivity: ['me', 'activity'] as const,
  myNotifications: ['me', 'notifications'] as const,
  nearStatus: ['near', 'status'] as const,
  /** The trees the sanctuary is asking for; the catalogue changes rarely. */
  fundCatalogue: ['fund', 'catalogue'] as const,
  /** The donor's own deeds, newest first. */
  fundDeeds: ['fund', 'deeds'] as const,
  /** The user manual; it only changes when the app ships a new build. */
  help: ['help'] as const,
  /** Registered Sputnik DAOs and their caps. */
  socialTreasuries: (groupId: string) => ['social', 'treasuries', groupId] as const,
  /** The group's bounty board, presets included. */
  bountyBoard: (groupId: string) => ['social', 'board', groupId] as const,
  /** One bounty with its claims, payouts and event log. */
  bounty: (bountyId: string) => ['social', 'bounty', bountyId] as const,
  /** Contributor trust for the group. */
  socialTrust: (groupId: string) => ['social', 'trust', groupId] as const,
  /** Bounties any visitor may read. */
  publicBoard: ['social', 'public'] as const,
};

export function useGroup(groupId: string) {
  return useQuery({
    queryKey: queryKeys.group(groupId),
    queryFn: () => request<GroupDetail>(`/groups/${groupId}`),
    enabled: Boolean(groupId),
  });
}

export function useGroupTimeline(groupId: string) {
  return useQuery({
    queryKey: queryKeys.timeline(groupId),
    queryFn: () => request<{ events: TimelineEvent[] }>(`/groups/${groupId}/timeline`),
    enabled: Boolean(groupId),
    refetchInterval: 5000,
  });
}

export function useBill(billId: string) {
  return useQuery({
    queryKey: queryKeys.bill(billId),
    queryFn: () =>
      request<{
        bill: Bill;
        allocations: Allocation[];
        shares: Share[];
        interestCharges: InterestCharge[];
        splitVote: SplitVoteSummary;
      }>(`/bills/${billId}`),
    enabled: Boolean(billId),
    refetchInterval: (query) =>
      query.state.data?.bill.status === 'PARSING' ? 1500 : false,
  });
}

export function useLeaderboard(groupId: string) {
  return useQuery({
    queryKey: queryKeys.leaderboard(groupId),
    queryFn: () => request<{ rows: LeaderboardRow[] }>(`/groups/${groupId}/leaderboard`),
    enabled: Boolean(groupId),
  });
}

export type MyProfile = {
  userId: string;
  email: string;
  displayName: string;
  /** null means "no override": the client uses the device or group currency. */
  displayCurrency: string | null;
  /** NEAR account this member settles from, once linked. */
  nearAccount: string | null;
  /** True once a signature or a transfer has proved that account is theirs. */
  nearVerified: boolean;
};

export function useMyProfile(enabled = true) {
  return useQuery({
    queryKey: queryKeys.myProfile,
    queryFn: () => request<MyProfile>('/me'),
    enabled,
  });
}

/** Saving the display currency touches both the device and the account (§2.19). */
export function useUpdateDisplayCurrency() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (displayCurrency: string | null) =>
      request<{ userId: string; displayCurrency: string | null }>('/me', {
        method: 'PATCH',
        body: { displayCurrency },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.myProfile }),
  });
}

/**
 * Indicative market rates for the whole app. Refreshed hourly on the server, so
 * the client caches for the same window and never blocks a render on it.
 * `base` defaults to the server's own base (THB); pass `'USD'` when the caller
 * needs the NEAR spot row, which the server only merges onto the USD table.
 */
export function useFxRates(base?: string) {
  return useQuery({
    queryKey: [...queryKeys.fxRates, base ?? 'default'],
    queryFn: () => request<FxSnapshot>(base ? `/fx/rates?base=${encodeURIComponent(base)}` : '/fx/rates'),
    staleTime: 60 * 60 * 1000,
    retry: 1,
  });
}

/** Every table the member belongs to. The only stable way back into a group. */
export function useMyGroups() {
  return useQuery({
    queryKey: queryKeys.myGroups,
    queryFn: () => request<{ groups: MyGroup[] }>('/groups'),
  });
}

export type MyShares = {
  shares: Share[];
  outstandingMinor: number;
  currency: string;
  /** Confirmed lines on a bill the fronter has not locked yet. */
  pending: PendingShare[];
};

export function useMyShares() {
  return useQuery({
    queryKey: queryKeys.myShares,
    queryFn: () => request<MyShares>('/me/shares'),
  });
}

export function useMyPoints() {
  return useQuery({
    queryKey: queryKeys.myPoints,
    queryFn: () => request<{ balance: number }>('/me/points'),
  });
}

/** The cross-group ledger feed. Slow-moving, so it only refreshes on focus. */
export function useMyActivity() {
  return useQuery({
    queryKey: queryKeys.myActivity,
    queryFn: () => request<{ events: TimelineEvent[] }>('/me/activity'),
    refetchInterval: 15_000,
  });
}

export type NotificationChannel = 'in_app' | 'push' | 'email' | 'whatsapp';

export type NotificationSettings = {
  /** `available` is what the server can actually send; a dark channel still lists. */
  channels: { channel: NotificationChannel; enabled: boolean; available: boolean }[];
  pushRegistered: boolean;
};

export function useNotificationSettings() {
  return useQuery({
    queryKey: queryKeys.myNotifications,
    queryFn: () => request<NotificationSettings>('/me/notifications'),
  });
}

/** One toggle fans out to every membership server-side, so the answer is authoritative. */
export function useUpdateNotificationChannel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { channel: NotificationChannel; enabled: boolean }) =>
      request<NotificationSettings>('/me/notifications', { method: 'PATCH', body: input }),
    onSuccess: (settings) => client.setQueryData(queryKeys.myNotifications, settings),
  });
}

export function useCreateGroup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; currency: string; kind?: string }) =>
      request<{ group: Group; member: Member }>('/groups', { body: input }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.myGroups });
      client.invalidateQueries({ queryKey: ['group'] });
    },
  });
}

export function useJoinGroup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { inviteToken: string; displayName: string }) =>
      request<{ group: Group; member: Member }>('/groups/join', { body: input }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.myGroups }),
  });
}

export function useCreateAgreement(groupId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      estimatedTotalMinor: number;
      deadline: string | null;
      kind?: string;
      splitMode?: 'itemised' | 'equal' | 'weighted' | 'quantity' | 'exact';
      recurrence?: 'none' | 'weekly' | 'monthly';
      consentLevel?: 'signed' | 'anchored';
      /** 'none' is an explicit choice and is signed into the terms. */
      interestMode?: 'none' | 'monthly';
      interestRateBps?: number | null;
      interestCapBps?: number | null;
    }) =>
      request<{ agreement: Agreement }>('/agreements', {
        body: { groupId, ...input },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.group(groupId) }),
  });
}

/**
 * Roll a settled recurring expense (rent, a subscription) into its next period.
 * The server copies the members, split mode and terms and re-hashes them, so
 * everyone signs the new period rather than inheriting an old signature.
 */
export function useCloneAgreement(groupId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ agreementId, estimatedTotalMinor, deadline }: {
      agreementId: string;
      estimatedTotalMinor?: number;
      deadline?: string | null;
    }) =>
      request<{ agreement: Agreement }>(`/agreements/${agreementId}/clone`, {
        body: {
          ...(estimatedTotalMinor === undefined ? {} : { estimatedTotalMinor }),
          ...(deadline === undefined ? {} : { deadline }),
        },
      }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.group(groupId) });
      client.invalidateQueries({ queryKey: queryKeys.timeline(groupId) });
      client.invalidateQueries({ queryKey: queryKeys.myShares });
    },
  });
}

export function useAgreementConsent(agreementId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.agreementConsent(agreementId ?? 'none'),
    queryFn: () => requestAgreementConsent(agreementId!),
    enabled: Boolean(agreementId),
    // Every fetch mints a fresh single-use nonce, so a cached challenge that
    // was never signed is worthless — and one that was signed is consumed.
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
}

/** The proof behind an agreement: signatures, signers, and anchor hashes. */
export function useAgreementAcceptances(agreementId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.agreementAcceptances(agreementId ?? 'none'),
    queryFn: () => agreementAcceptances(agreementId!),
    enabled: Boolean(agreementId),
    // Signatures and anchors arrive over time; the timeline polls, so does this.
    refetchInterval: 5000,
  });
}

export function useAcceptAgreement(groupId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      agreementId: string;
      /** Omitted on native, which has no popup to sign in. */
      signedMessage?: string;
      payload?: SignedConsent;
    }) =>
      input.signedMessage && input.payload
        ? submitAgreementConsent(input.agreementId, {
            signedMessage: input.signedMessage,
            payload: input.payload,
          })
        : request<{ agreement: Agreement }>(`/agreements/${input.agreementId}/accept`, {
            body: {},
          }),
    onSuccess: (_data, input) => {
      client.invalidateQueries({ queryKey: queryKeys.group(groupId) });
      client.invalidateQueries({ queryKey: queryKeys.timeline(groupId) });
      client.invalidateQueries({ queryKey: queryKeys.agreementAcceptances(input.agreementId) });
      client.removeQueries({ queryKey: queryKeys.agreementConsent(input.agreementId) });
    },
  });
}

/**
 * Publish the signed terms. The wallet has already sent the anchor transfer;
 * the hash it produced is what the API re-reads and pins to every signature.
 */
export function useAnchorAgreement(groupId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { agreementId: string; txHash: string }) =>
      anchorAgreement(input.agreementId, input.txHash),
    onSuccess: (_data, input) => {
      client.invalidateQueries({ queryKey: queryKeys.group(groupId) });
      client.invalidateQueries({ queryKey: queryKeys.timeline(groupId) });
      client.invalidateQueries({ queryKey: queryKeys.agreementAcceptances(input.agreementId) });
    },
  });
}

/**
 * Cast this member's vote for how to divide the cost. Agreement votes set the
 * group-wide default; a bill vote overrides it for that one bill only. The
 * server never stores the winner — it re-tallies on every read, so a change of
 * mind takes effect immediately.
 */
export function useCastSplitVote(groupId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { mode: SplitVote; agreementId?: string; billId?: string }) => {
      const path = input.billId
        ? `/bills/${input.billId}/split-vote`
        : input.agreementId
          ? `/agreements/${input.agreementId}/split-vote`
          : null;
      if (!path) throw new Error('A split vote needs an agreement or a bill');
      return request<{ splitVote: SplitVoteSummary }>(path, { body: { mode: input.mode } });
    },
    onSuccess: (_data, vars) => {
      if (vars.billId) client.invalidateQueries({ queryKey: queryKeys.bill(vars.billId) });
      client.invalidateQueries({ queryKey: queryKeys.group(groupId) });
      client.invalidateQueries({ queryKey: queryKeys.timeline(groupId) });
    },
  });
}

/** A bill that arrives already itemised skips the receipt photo entirely. */
export type NewBillItem = {
  name: string;
  qty?: number;
  unitPriceMinor?: number;
  lineTotalMinor?: number;
  unit?: string;
};

export function useCreateBill(groupId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      agreementId: string;
      currency: string;
      source?: 'receipt_vision' | 'manual' | 'invoice' | 'quantity_claim';
      title?: string;
      items?: NewBillItem[];
    }) => request<{ bill: Bill }>('/bills', { body: input }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.group(groupId) }),
  });
}

export function useUploadMedia() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      billId,
      uri,
      kind,
      file,
    }: {
      billId: string;
      uri: string;
      kind: 'photo' | 'video';
      /** Browsers get a real File from the picker; native passes a uri instead. */
      file?: Blob | null;
    }) => {
      const form = new FormData();
      const name = uri.split('/').pop() ?? `receipt.${kind === 'video' ? 'mp4' : 'jpg'}`;
      form.append('kind', kind);
      if (file) {
        form.append('file', file, name);
      } else {
        form.append(
          'file',
          { uri, name, type: kind === 'video' ? 'video/mp4' : 'image/jpeg' } as unknown as Blob
        );
      }
      return request<{ mediaId: string; status: string }>(`/bills/${billId}/media`, {
        method: 'POST',
        formData: form,
      });
    },
    onSuccess: (_data, vars) => {
      client.invalidateQueries({ queryKey: queryKeys.bill(vars.billId) });
      // A re-parse can change the amounts behind the member's open shares, so
      // their own list has to be refetched too.
      client.invalidateQueries({ queryKey: queryKeys.myShares });
    },
  });
}

export function useParseBill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ billId }: { billId: string }) =>
      request<{ status: string }>(`/bills/${billId}/parse`, { body: {} }),
    onSuccess: (_data, vars) =>
      client.invalidateQueries({ queryKey: queryKeys.bill(vars.billId) }),
  });
}

/**
 * Correct the bill's lines by hand. The full line list is sent: entries with
 * an `id` are updated, entries without one are added, and anything omitted is
 * deleted. Tax, service, tip and discount stay as printed, so the total moves
 * with the lines and the bill gains a warning that it no longer matches the
 * receipt.
 */
export function useUpdateBillItems() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      billId,
      items,
    }: {
      billId: string;
      items: { id?: string; name: string; qty: number; unitPriceMinor: number; unit?: string }[];
    }) =>
      request<{ bill: Bill }>(`/bills/${billId}/items`, {
        method: 'PATCH',
        body: { items },
      }),
    onSuccess: (_data, vars) => {
      client.invalidateQueries({ queryKey: queryKeys.bill(vars.billId) });
      // An edited amount changes what each member owes, so their own list must
      // refetch even though they did not touch the bill.
      client.invalidateQueries({ queryKey: queryKeys.myShares });
    },
  });
}

export function useSetAllocations() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      billId,
      allocations,
    }: {
      billId: string;
      allocations: { billItemId: string; memberId: string; qty: number }[];
    }) =>
      request<{ allocations: Allocation[] }>(`/bills/${billId}/allocations`, {
        method: 'PATCH',
        body: { allocations },
      }),
    onSuccess: (_data, vars) => {
      client.invalidateQueries({ queryKey: queryKeys.bill(vars.billId) });
      // A re-split changes what this member has confirmed, which `/me/shares`
      // now shows even before the fronter locks the bill.
      client.invalidateQueries({ queryKey: queryKeys.myShares });
    },
  });
}

/**
 * A member claims their own units on a group buy. Unlike `useSetAllocations`
 * this never touches anyone else's row — the server re-shares the line across
 * whoever has claimed so far, and unclaimed units stay with the fronter.
 */
export function useSetClaims() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      billId,
      claims,
    }: {
      billId: string;
      claims: { billItemId: string; qty: number }[];
    }) =>
      request<{ allocations: Allocation[] }>(`/bills/${billId}/claims`, {
        method: 'PATCH',
        body: { claims },
      }),
    onSuccess: (_data, vars) => {
      client.invalidateQueries({ queryKey: queryKeys.bill(vars.billId) });
      client.invalidateQueries({ queryKey: queryKeys.myShares });
    },
  });
}

export function useConfirmAllocation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ billId, allocationId }: { billId: string; allocationId: string }) =>
      request<{ allocation: Allocation }>(`/allocations/${allocationId}/confirm`, {
        body: {},
      }),
    onSuccess: (_data, vars) => {
      client.invalidateQueries({ queryKey: queryKeys.bill(vars.billId) });
      client.invalidateQueries({ queryKey: queryKeys.myShares });
    },
  });
}

export function useFinalizeBill(groupId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ billId }: { billId: string }) =>
      request<{ bill: Bill; shares: Share[] }>(`/bills/${billId}/finalize`, { body: {} }),
    onSuccess: (_data, vars) => {
      client.invalidateQueries({ queryKey: queryKeys.bill(vars.billId) });
      client.invalidateQueries({ queryKey: queryKeys.group(groupId) });
      client.invalidateQueries({ queryKey: queryKeys.myShares });
      client.invalidateQueries({ queryKey: queryKeys.timeline(groupId) });
    },
  });
}

/** The NEAR rail's readiness plus this member's linked account. */
export function useNearStatus(enabled = true) {
  return useQuery({
    queryKey: queryKeys.nearStatus,
    queryFn: nearStatus,
    enabled,
  });
}

export function useLinkNearAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (nearAccount: string | null) => linkNearAccount(nearAccount),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.nearStatus });
      client.invalidateQueries({ queryKey: queryKeys.myProfile });
    },
  });
}

/**
 * The fronter quotes the payout for one share. The quote carries the recipient,
 * the token amount and the memo, so the payer's wallet builds the transfer.
 */
export function useRequestNearTransfer() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ shareId }: { shareId: string }) => requestNearTransfer(shareId),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.myShares });
      client.invalidateQueries({ queryKey: ['bill'] });
      client.invalidateQueries({ queryKey: ['timeline'] });
    },
  });
}

/**
 * Freezes a share's quote and mints a forwardable link to its payment
 * instructions. The caller copies the URL; the link itself exposes one share.
 */
export function useCreateSharePayLink() {
  return useMutation({
    mutationFn: (shareId: string) => createSharePayLink(shareId),
  });
}

/**
 * A hash the API verified against the chain settles the share and pays out
 * Globie, so the ledger, the bill and the member's lists all go stale.
 */
export function useSettleFromNear() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ shareId, txHash }: { shareId: string; txHash: string }) =>
      settleFromNear(shareId, txHash),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.myShares });
      client.invalidateQueries({ queryKey: queryKeys.myPoints });
      client.invalidateQueries({ queryKey: queryKeys.nearStatus });
      client.invalidateQueries({ queryKey: ['bill'] });
      client.invalidateQueries({ queryKey: ['group'] });
      client.invalidateQueries({ queryKey: ['timeline'] });
    },
    // A mismatch leaves the share payable on either rail; refetching shows it.
    onError: () => client.invalidateQueries({ queryKey: queryKeys.myShares }),
  });
}

/**
 * Tips only exist on a bill that the fronter has already paid, so the caller
 * gates this query on the bill status.
 */
export function useTips(billId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.tips(billId),
    queryFn: () => request<TipsResponse>(`/bills/${billId}/tips`),
    enabled: Boolean(billId) && enabled,
  });
}

/**
 * Requests the tip transfer. The answer is the recipient, token amount and
 * memo the member's own wallet signs; nothing is charged server-side.
 */
export function useRequestTip(billId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { amountMinor: number; message?: string }) =>
      requestTipTransfer(billId, input),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.tips(billId) }),
  });
}

/** A verified tip hash pays the fronter and awards Globie, so caches go stale. */
export function useSettleTip(billId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ tipId, txHash }: { tipId: string; txHash: string }) =>
      settleTipFromNear(tipId, txHash),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.tips(billId) });
      client.invalidateQueries({ queryKey: queryKeys.myPoints });
      client.invalidateQueries({ queryKey: ['timeline'] });
    },
    // A rejected hash leaves the tip `requested`; refetching keeps the card on
    // the instructions instead of showing a dead "paid" row.
    onError: () => client.invalidateQueries({ queryKey: queryKeys.tips(billId) }),
  });
}

/**
 * The agreed late-fee rule plus every charge raised on this bill. Read even
 * before anybody pays, so the bill screen can warn about it.
 */
export function useInterest(billId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.interest(billId),
    queryFn: () => request<InterestResponse>(`/bills/${billId}/interest`),
    enabled: Boolean(billId) && enabled,
  });
}

/** Raising a fee freezes its quote, so the bill and the card both go stale. */
export function useRaiseInterest(billId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (shareId: string) => raiseInterestCharge(billId, shareId),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.interest(billId) });
      client.invalidateQueries({ queryKey: queryKeys.bill(billId) });
      client.invalidateQueries({ queryKey: ['timeline'] });
    },
  });
}

/** A verified hash marks the late fee paid; the member's share is untouched. */
export function useSettleInterest(billId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ chargeId, txHash }: { chargeId: string; txHash: string }) =>
      settleInterestFromNear(chargeId, txHash),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.interest(billId) });
      client.invalidateQueries({ queryKey: queryKeys.bill(billId) });
      client.invalidateQueries({ queryKey: queryKeys.myShares });
      client.invalidateQueries({ queryKey: ['timeline'] });
    },
    // A rejected hash leaves the charge `requested`; refetch rather than
    // showing a paid row that never happened.
    onError: () => client.invalidateQueries({ queryKey: queryKeys.interest(billId) }),
  });
}

export type AgentMessageInput = {
  tool: AgentToolName;
  args: Record<string, unknown>;
  /** Only sent on the replay that commits a confirmed tool. */
  confirmToken?: string | null;
  /** What the member typed, so the reply can answer them rather than narrate. */
  say?: string | null;
  history?: AgentTurn[];
  /** `false` for a silent read whose reply the UI never shows. */
  narrate?: boolean;
};

/**
 * One Globie turn. A confirmed tool answers `confirmationRequired` first and
 * changes nothing; the caller repeats the identical call with the token.
 */
export function useAgentMessage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ tool, args, confirmToken, say, history, narrate }: AgentMessageInput) =>
      request<AgentResponse>('/agent/message', {
        body: {
          tool,
          args,
          ...(confirmToken ? { confirmToken } : {}),
          ...(say ? { say } : {}),
          ...(history && history.length > 0 ? { history } : {}),
          ...(narrate === false ? { narrate: false } : {}),
        },
      }),
    onSuccess: (response) => {
      if (!response.executed) return;
      client.invalidateQueries({ queryKey: ['bill'] });
      client.invalidateQueries({ queryKey: ['group'] });
      client.invalidateQueries({ queryKey: ['timeline'] });
      client.invalidateQueries({ queryKey: ['leaderboard'] });
      client.invalidateQueries({ queryKey: queryKeys.myShares });
      client.invalidateQueries({ queryKey: queryKeys.myPoints });
    },
  });
}

export type AgentChatInput = {
  say: string;
  history?: AgentTurn[];
  billId?: string | null;
  agreementId?: string | null;
};

/** Free conversation (DEV_PLAN §2.22). Nothing is written, so nothing to refetch. */
export function useAgentChat() {
  return useMutation({
    mutationFn: ({ say, history, billId, agreementId }: AgentChatInput) =>
      request<AgentChatResponse>('/agent/chat', {
        body: {
          say,
          ...(history && history.length > 0 ? { history } : {}),
          ...(billId ? { billId } : {}),
          ...(agreementId ? { agreementId } : {}),
        },
      }),
  });
}

/**
 * The user manual (DEV_PLAN §2.23). Public and static, so it is fetched once
 * per app launch and never refetched; the server owns the copy.
 */
export function useHelpTopics() {
  return useQuery({
    queryKey: queryKeys.help,
    queryFn: () => request<{ topics: HelpTopic[] }>('/help'),
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

/** What the sanctuary needs, what it costs, and which assets this server takes. */
export function useFundCatalogue() {
  return useQuery({
    queryKey: queryKeys.fundCatalogue,
    queryFn: fetchFundCatalogue,
    staleTime: 60_000,
  });
}

/** The signed-in donor's deeds — the proof a gift happened. */
export function useFundDeeds() {
  return useQuery({
    queryKey: queryKeys.fundDeeds,
    queryFn: fetchFundDeeds,
  });
}

/**
 * Freezes the exact amount the wallet will sign. The result is single-use and
 * short-lived, so it is never cached — only the POST stays here.
 */
export function useRequestFundQuote() {
  return useMutation({
    mutationFn: (input: { projectId: string; qty: number; asset: FundAsset }) =>
      requestFundQuote(input),
  });
}

/**
 * The donor's wallet made the transfer; this only hands the API the hash it
 * already knows how to read. A new deed means the giving list is stale.
 */
export function useSettleFundDeed() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ quoteId, txHash }: { quoteId: string; txHash: string }) =>
      settleFundDeed(quoteId, txHash),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.fundDeeds });
    },
  });
}

/** The group's registered DAOs. An empty list is normal before setup. */
export function useSocialTreasuries(groupId: string) {
  return useQuery({
    queryKey: queryKeys.socialTreasuries(groupId),
    queryFn: () => fetchSocialTreasuries(groupId),
    enabled: Boolean(groupId),
  });
}

/** Reading the board is also what materialises the preset bounties. */
export function useBountyBoard(groupId: string) {
  return useQuery({
    queryKey: queryKeys.bountyBoard(groupId),
    queryFn: () => fetchBountyBoard(groupId),
    enabled: Boolean(groupId),
  });
}

export function useBounty(bountyId: string) {
  return useQuery({
    queryKey: queryKeys.bounty(bountyId),
    queryFn: () => fetchBounty(bountyId),
    enabled: Boolean(bountyId),
  });
}

export function useSocialTrust(groupId: string) {
  return useQuery({
    queryKey: queryKeys.socialTrust(groupId),
    queryFn: () => fetchContributorTrust(groupId),
    enabled: Boolean(groupId),
  });
}

/** The same board a visitor sees, with no group context. */
export function usePublicBountyBoard() {
  return useQuery({
    queryKey: queryKeys.publicBoard,
    queryFn: fetchPublicBountyBoard,
  });
}

/** Registering a DAO changes the caps card, so only that list is invalidated. */
export function useRegisterSocialTreasury(groupId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      label: string;
      daoAccount: string;
      network?: string;
      caps?: Partial<SocialTreasury['caps']>;
    }) => registerSocialTreasury(groupId, input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.socialTreasuries(groupId) });
    },
  });
}

/** A DAO changed on chain; refresh the snapshot and the table that reads it. */
export function useSyncSocialTreasury(groupId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (treasuryId: string) => syncSocialTreasury(treasuryId),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.socialTreasuries(groupId) });
    },
  });
}

/** A minted DAO becomes a treasury row once its policy is readable. */
export function useConfirmSocialDao(groupId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      daoAccount: string;
      label: string;
      caps?: Partial<SocialTreasury['caps']>;
    }) => confirmSocialDaoTreasury(groupId, input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.socialTreasuries(groupId) });
    },
  });
}

export function useCreateSocialBounty(groupId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      title: string;
      description?: string;
      category?: string;
      amountMinor: number;
      currency?: string;
      asset?: 'near' | 'usdc';
      visibility?: 'group' | 'public';
      deadline?: string;
      treasuryId?: string | null;
    }) => createSocialBounty(groupId, input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.bountyBoard(groupId) });
    },
  });
}

/** Any claim changes the bounty row and its position on the board. */
function invalidateBounty(
  client: ReturnType<typeof useQueryClient>,
  bountyId: string,
) {
  client.invalidateQueries({ queryKey: queryKeys.bounty(bountyId) });
  client.invalidateQueries({ queryKey: ['social', 'board'] });
}

export function useClaimSocialBounty(bountyId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => claimSocialBounty(bountyId),
    onSuccess: () => invalidateBounty(client, bountyId),
  });
}

export function useSubmitSocialClaim(bountyId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { note: string; evidenceUrl?: string }) =>
      submitSocialClaim(bountyId, input),
    onSuccess: () => invalidateBounty(client, bountyId),
  });
}

/** Approval opens the payout step; rejection closes the claim. */
export function useDecideSocialClaim(bountyId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      claimId: string;
      decision: 'approve' | 'reject';
      note?: string;
    }) => decideSocialClaim(bountyId, input),
    onSuccess: () => invalidateBounty(client, bountyId),
  });
}

/** A read dressed as a POST: no row is written, so nothing is invalidated. */
export function usePreviewBountyPayout(bountyId: string) {
  return useMutation<SocialPayoutPlan, Error, string>({
    mutationFn: (claimId: string) => previewBountyPayout(bountyId, claimId),
  });
}

/**
 * Freezes the payout and returns the unsigned transaction. The wallet signs
 * next, so the bounty, board and trust table all go stale at once.
 */
export function usePrepareBountyPayout(bountyId: string, groupId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (claimId: string) => prepareBountyPayout(bountyId, claimId),
    onSuccess: () => {
      invalidateBounty(client, bountyId);
      client.invalidateQueries({ queryKey: queryKeys.socialTrust(groupId) });
    },
  });
}

/** The wallet broadcast; record the hash so the chain can be re-read. */
export function useRecordBountyPayoutTx(bountyId: string) {
  const client = useQueryClient();
  return useMutation<SocialPayout, Error, { payoutId: string; txHash: string; proposalId?: string }>({
    mutationFn: ({ payoutId, ...input }) => recordBountyPayoutTx(payoutId, input),
    onSuccess: () => invalidateBounty(client, bountyId),
  });
}

/** Execution settles the payout and raises the claimer's trust, so both refresh. */
export function useSyncBountyPayout(bountyId: string, groupId: string) {
  const client = useQueryClient();
  return useMutation<SocialPayout, Error, string>({
    mutationFn: (payoutId: string) => syncBountyPayout(payoutId),
    onSuccess: () => {
      invalidateBounty(client, bountyId);
      client.invalidateQueries({ queryKey: queryKeys.socialTrust(groupId) });
    },
  });
}
