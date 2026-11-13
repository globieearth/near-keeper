import { API_BASE } from './config';
import { clearSession, getSession, setSession, type StoredSession } from './session';
import type {
    Agreement,
    AgreementAcceptances,
    AgreementAnchor,
    AgreementConsent,
    FundAsset,
    FundCatalogue,
    FundGiving,
    FundQuote,
    FundSettleResult,
    InterestCharge,
    InterestResponse,
    InterestSettleResult,
    NearSettleResult,
    NearStatus,
    PayLinkView,
    PreparedAnchorCall,
    PreparedBountyPayout,
    PreparedDaoCreation,
    PreparedFtTransfer,
    PreparedNativeTransfer,
    PreparedRecordAcceptance,
    SharePayLink,
    SignedConsent,
    SocialBounty,
    SocialBountyDetail,
    SocialClaim,
    SocialPayout,
    SocialPayoutPlan,
    SocialTreasury,
    SocialTrust,
    TipSettleResult,
    TipTransferRequest,
    TransferRequest,
    TreasuryCaps
} from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  formData?: FormData;
  signal?: AbortSignal;
};

const unauthorizedListeners = new Set<() => void>();

/**
 * A token the server no longer recognises (expired, or the user row is gone)
 * cannot be repaired by retrying. Drop it and let the shell show sign-in
 * instead of an app that looks signed in but loads nothing.
 */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const session = await getSession();
  const headers: Record<string, string> = {};
  if (session) headers.Authorization = `Bearer ${session.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers,
      body:
        options.formData ??
        (options.body === undefined ? undefined : JSON.stringify(options.body)),
      signal: options.signal,
    });
  } catch {
    // A dropped connection, a proxy timeout or an error page without CORS
    // headers all reach us as the browser's own "Failed to fetch". Say
    // something the member can act on instead of echoing that.
    throw new ApiError(
      0,
      'network_error',
      'Could not reach Globie Keeper — check your connection and try again.'
    );
  }

  const text = await response.text();
  const payload = text ? safeJson(text) : null;

  if (!response.ok) {
    const code = (payload as { code?: string } | null)?.code ?? 'request_failed';
    const message =
      (payload as { message?: string } | null)?.message ??
      `Request failed (${response.status})`;

    // Only the session middleware's 401 means "this token is dead". A failed
    // NEAR login is also a 401, but it carries its own `near_login_*` code and
    // must not sign out the member who is trying to attach a wallet.
    if (response.status === 401 && code === 'unauthorized' && session) {
      await clearSession();
      for (const listener of unauthorizedListeners) listener();
    }

    throw new ApiError(response.status, code, message);
  }

  return payload as T;
}

type SessionPayload = { token: string; userId: string; displayName: string };

/** One place that turns a session response into the stored record. */
async function storeSession(payload: SessionPayload): Promise<StoredSession> {
  const session: StoredSession = {
    token: payload.token,
    userId: payload.userId,
    displayName: payload.displayName,
  };
  await setSession(session);
  return session;
}

/**
 * NEAR rails. The API never holds a key: it quotes a transfer, then verifies a
 * hash the member's own wallet produced.
 */
export async function nearStatus(): Promise<NearStatus> {
  return request<NearStatus>('/near/status');
}

/** Link (or with `null`, unlink) the account this member settles from. */
export async function linkNearAccount(
  nearAccount: string | null
): Promise<{ account: string | null; verified: boolean }> {
  return request<{ account: string | null; verified: boolean }>('/near/account', {
    method: 'PATCH',
    body: { nearAccount },
  });
}

/** Ask the API to quote the fronter's payout for one share. */
export async function requestNearTransfer(shareId: string): Promise<TransferRequest> {
  return request<TransferRequest>(`/shares/${shareId}/request-transfer`, { body: {} });
}

/** Hand the API a hash; it reads the chain and settles the share. */
export async function settleFromNear(
  shareId: string,
  txHash: string
): Promise<NearSettleResult> {
  return request<NearSettleResult>(`/shares/${shareId}/settle`, { body: { txHash } });
}

/**
 * Freeze the quote for a share and mint a link anyone can open. The transfer is
 * the same one `/shares/:id/request-transfer` returns, so the link and the app
 * can never show two different amounts.
 */
export async function createSharePayLink(shareId: string): Promise<SharePayLink> {
  return request<SharePayLink>(`/shares/${shareId}/pay-link`, { body: {} });
}

/** Read a pay link. Signed out on purpose — that is the audience. */
export async function getPayLink(token: string): Promise<PayLinkView> {
  return request<PayLinkView>(`/pay/${encodeURIComponent(token)}`);
}

/** Ask the API for the transfer that tips the fronter of a bill. */
export async function requestTipTransfer(
  billId: string,
  input: { amountMinor: number; message?: string }
): Promise<TipTransferRequest> {
  return request<TipTransferRequest>(`/bills/${billId}/tips`, { body: input });
}

/** Hand the API a hash; it reads the chain and marks the tip paid. */
export async function settleTipFromNear(
  tipId: string,
  txHash: string
): Promise<TipSettleResult> {
  return request<TipSettleResult>(`/tips/${tipId}/settle`, { body: { txHash } });
}

/** The agreed late-fee rule and every charge raised on this bill. */
export async function fetchBillInterest(billId: string): Promise<InterestResponse> {
  return request<InterestResponse>(`/bills/${billId}/interest`);
}

/** Raise — or re-raise — the agreed fee on one overdue share. Fronter only. */
export async function raiseInterestCharge(
  billId: string,
  shareId: string
): Promise<{ interest: InterestCharge }> {
  return request<{ interest: InterestCharge }>(`/bills/${billId}/interest`, {
    body: { shareId },
  });
}

/** Hand the API a hash; it reads the chain and marks the late fee paid. */
export async function settleInterestFromNear(
  chargeId: string,
  txHash: string
): Promise<InterestSettleResult> {
  return request<InterestSettleResult>(`/interest/${chargeId}/settle`, {
    body: { txHash },
  });
}

export type CsvDownload = { filename: string; body: string };

/**
 * The bill as a CSV. `request()` parses JSON, so this reads the response itself:
 * the same bearer header, the filename the API chose, the body untouched.
 */
export async function downloadBillCsv(billId: string): Promise<CsvDownload> {
  const session = await getSession();
  const headers: Record<string, string> = {};
  if (session) headers.Authorization = `Bearer ${session.token}`;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/bills/${billId}/export.csv`, { headers });
  } catch {
    throw new ApiError(
      0,
      'network_error',
      'Could not reach Globie Keeper — check your connection and try again.'
    );
  }

  if (!response.ok) {
    const text = await response.text();
    const payload = text ? (safeJson(text) as { code?: string; message?: string }) : null;
    throw new ApiError(
      response.status,
      payload?.code ?? 'request_failed',
      payload?.message ?? `Request failed (${response.status})`
    );
  }

  const disposition = response.headers.get('Content-Disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1];

  return {
    filename: filename ?? `bill-${billId.slice(0, 8)}.csv`,
    body: await response.text(),
  };
}

/**
 * Ask the API to encode the `ft_transfer` behind a one-tap payment. It signs
 * nothing: the wallet pops up and approves a transfer for exactly this amount,
 * payee and memo, and the API later checks the hash it produced.
 */
export async function prepareNearFtTransfer(input: {
  receiverId: string;
  amount: string;
  memo?: string | null;
  /** The share this payment settles; lets the API refuse a wallet that does not owe it. */
  shareId?: string;
}): Promise<PreparedFtTransfer> {
  return request<PreparedFtTransfer>('/near/ft-transfer', { body: input });
}

/**
 * The native-NEAR sibling. `deposit` is the exact yoctoNEAR integer the gift
 * quote froze — passing it through as a string avoids the rounding that would
 * make the wallet sign a different amount than the server verifies.
 */
export async function prepareNearNativeTransfer(input: {
  receiverId: string;
  deposit: string;
}): Promise<PreparedNativeTransfer> {
  return request<PreparedNativeTransfer>('/near/native-transfer', { body: input });
}

/** The trees the sanctuary is asking for, and which assets can pay for them. */
export async function fetchFundCatalogue(): Promise<FundCatalogue> {
  return request<FundCatalogue>('/fund/projects');
}

/** Freeze what `qty` trees cost right now, in the chosen asset. */
export async function requestFundQuote(input: {
  projectId: string;
  qty: number;
  asset: FundAsset;
}): Promise<FundQuote> {
  return request<FundQuote>('/fund/quote', { body: input });
}

/** Hand the API the hash the wallet produced; the chain decides the rest. */
export async function settleFundDeed(
  quoteId: string,
  txHash: string
): Promise<FundSettleResult> {
  return request<FundSettleResult>('/fund/settle', { body: { quoteId, txHash } });
}

/** The donor's own deeds, newest first. */
export async function fetchFundDeeds(): Promise<FundGiving> {
  return request<FundGiving>('/fund/deeds');
}

/**
 * Ask the API to encode the anchor call behind "Anchor on chain": a read-only
 * `ft_balance_of` on the USDC contract with the terms digest as its argument.
 * The wallet signs it; the API then re-reads the hash and checks the digest.
 */
export async function prepareNearAnchorCall(agreementId: string): Promise<PreparedAnchorCall> {
  return request<PreparedAnchorCall>('/near/anchor-call', { body: { agreementId } });
}

/**
 * Ask the API to encode "Record on chain" for the caller's own signature: a
 * `record_acceptance` call on the shared registry. Only the account that
 * signed can submit it, so the wallet must be the member's own.
 */
export async function prepareNearRecordAcceptance(
  agreementId: string
): Promise<PreparedRecordAcceptance> {
  return request<PreparedRecordAcceptance>('/near/record-acceptance', {
    body: { agreementId },
  });
}

/**
 * NEP-413 hop 1. The nonce is opaque to the client: hand it to the wallet and
 * give it straight back to `/auth/near/verify`. `returnTo` decides which
 * `callbackUrl` the wallet appends its signature fragment to.
 */
export async function requestNearNonce(input: {
  accountId?: string;
  returnTo: 'web' | 'native';
}): Promise<{
  nonce: string;
  message: string;
  recipient: string;
  callbackUrl: string;
  /** The chain this server verifies signatures on (`testnet` / `mainnet`). */
  network: string;
}> {
  return request<{
    nonce: string;
    message: string;
    recipient: string;
    callbackUrl: string;
    network: string;
  }>('/auth/near/nonce', { body: input });
}

/** NEP-413 hop 2. Wallet-only signup is created here on first use. */
export async function completeNearLogin(input: {
  accountId: string;
  publicKey: string;
  signature: string;
  nonce: string;
}): Promise<StoredSession> {
  return storeSession(await request<SessionPayload>('/auth/near/verify', { body: input }));
}

/**
 * Hop 1 of signing the terms: hand back the exact message, nonce and recipient
 * the wallet is about to cover. Nothing is accepted until the signature lands.
 */
export async function requestAgreementConsent(agreementId: string): Promise<AgreementConsent> {
  return request<AgreementConsent>(`/agreements/${agreementId}/consent`);
}

/**
 * Hop 2: post the wallet's answer. The API re-hashes the terms and verifies the
 * signature against the same nonce, so a tampered snapshot is refused.
 */
export async function submitAgreementConsent(
  agreementId: string,
  input: { signedMessage: string; payload: SignedConsent }
): Promise<{ agreement: Agreement }> {
  return request<{ agreement: Agreement }>(`/agreements/${agreementId}/accept`, {
    body: input,
  });
}

/**
 * Who accepted, with which account, and whether that signature has been made
 * public. A NEP-413 signature has no hash, so this is the only proof view.
 */
export async function agreementAcceptances(agreementId: string): Promise<AgreementAcceptances> {
  return request<AgreementAcceptances>(`/agreements/${agreementId}/acceptances`);
}

/**
 * Hand the API the hash of the fronter's anchor call. The API re-reads it from
 * chain — signer, contract, `ft_balance_of`, digest in `args.account_id` —
 * before any acceptance is marked anchored.
 */
export async function anchorAgreement(
  agreementId: string,
  txHash: string
): Promise<{ agreement: Agreement; anchor: AgreementAnchor }> {
  return request<{ agreement: Agreement; anchor: AgreementAnchor }>(
    `/agreements/${agreementId}/anchor`,
    { body: { txHash } }
  );
}

/**
 * Social Money. Every payout ends in an unsigned `add_proposal` transaction the
 * member's own wallet signs; none of these calls moves money by itself.
 */

/** The group's registered DAOs, with their caps and last policy snapshot. */
export async function fetchSocialTreasuries(
  groupId: string
): Promise<{ treasuries: SocialTreasury[] }> {
  return request<{ treasuries: SocialTreasury[] }>(`/groups/${groupId}/treasuries`);
}

/** Reads `get_policy()` once and stores the snapshot. Owner or fronter only. */
export async function registerSocialTreasury(
  groupId: string,
  input: {
    label: string;
    daoAccount: string;
    network?: string;
    caps?: Partial<TreasuryCaps>;
  }
): Promise<SocialTreasury> {
  return request<SocialTreasury>(`/groups/${groupId}/treasuries`, { body: input });
}

/** Refresh the stored policy after the DAO changes on chain. */
export async function syncSocialTreasury(treasuryId: string): Promise<SocialTreasury> {
  return request<SocialTreasury>(`/treasuries/${treasuryId}/sync`, { body: {} });
}

/**
 * The unsigned factory `create` for a group with no DAO yet. The council
 * defaults to the group's owner and fronters; the wallet pays the deposit.
 */
export async function createSocialDaoTreasury(
  groupId: string,
  input: { name: string; label: string; purpose?: string }
): Promise<PreparedDaoCreation> {
  return request<PreparedDaoCreation>(`/groups/${groupId}/treasuries/create`, {
    body: input,
  });
}

/**
 * Register the DAO the factory just minted. Waits for `get_policy()` to answer,
 * so a landed transaction that is not readable yet becomes a retry, not a row.
 */
export async function confirmSocialDaoTreasury(
  groupId: string,
  input: { daoAccount: string; label: string; caps?: Partial<TreasuryCaps> }
): Promise<SocialTreasury> {
  return request<SocialTreasury>(`/groups/${groupId}/treasuries/create/confirm`, {
    body: input,
  });
}

/** The board. Reading it also generates the preset bounties that do not exist. */
export async function fetchBountyBoard(
  groupId: string
): Promise<{ bounties: SocialBounty[] }> {
  return request<{ bounties: SocialBounty[] }>(`/groups/${groupId}/bounties`);
}

/** A manual bounty. Presets are never created here — they appear on read. */
export async function createSocialBounty(
  groupId: string,
  input: {
    title: string;
    description?: string;
    category?: string;
    amountMinor: number;
    currency?: string;
    asset?: 'near' | 'usdc';
    visibility?: 'group' | 'public';
    deadline?: string;
    treasuryId?: string | null;
  }
): Promise<SocialBounty> {
  return request<SocialBounty>(`/groups/${groupId}/bounties`, { body: input });
}

/** The bounty, its claims, its payouts and its event log. */
export async function fetchBounty(bountyId: string): Promise<SocialBountyDetail> {
  return request<SocialBountyDetail>(`/bounties/${bountyId}`);
}

/** Taking an open bounty. A member may hold at most one live claim. */
export async function claimSocialBounty(
  bountyId: string
): Promise<{ claimId: string; bountyId: string; status: string }> {
  return request<{ claimId: string; bountyId: string; status: string }>(
    `/bounties/${bountyId}/claim`,
    { body: {} }
  );
}

/** File the note and the evidence link that the council will judge. */
export async function submitSocialClaim(
  bountyId: string,
  input: { note: string; evidenceUrl?: string }
): Promise<SocialClaim> {
  return request<SocialClaim>(`/bounties/${bountyId}/submit`, { body: input });
}

/** Council approves or rejects. Approval only opens the payout step. */
export async function decideSocialClaim(
  bountyId: string,
  input: { claimId: string; decision: 'approve' | 'reject'; note?: string }
): Promise<{ claimId: string; bountyId: string; claimStatus: string; bountyStatus: string }> {
  return request<{
    claimId: string;
    bountyId: string;
    claimStatus: string;
    bountyStatus: string;
  }>(`/bounties/${bountyId}/decide`, { body: input });
}

/** Which tier the policy picks, and whether the DAO can actually propose it. */
export async function previewBountyPayout(
  bountyId: string,
  claimId: string
): Promise<SocialPayoutPlan> {
  return request<SocialPayoutPlan>(`/bounties/${bountyId}/payout/preview`, {
    body: { claimId },
  });
}

/** Freeze the payout and build the unsigned `add_proposal` transaction. */
export async function prepareBountyPayout(
  bountyId: string,
  claimId: string
): Promise<PreparedBountyPayout> {
  return request<PreparedBountyPayout>(`/bounties/${bountyId}/payout`, {
    body: { claimId },
  });
}

/** Hand back the hash the wallet broadcast; the chain decides the rest. */
export async function recordBountyPayoutTx(
  payoutId: string,
  input: { txHash: string; proposalId?: string }
): Promise<SocialPayout> {
  return request<SocialPayout>(`/payouts/${payoutId}/tx`, { body: input });
}

/** Re-read `get_proposal`; on execution the payout settles and trust follows. */
export async function syncBountyPayout(payoutId: string): Promise<SocialPayout> {
  return request<SocialPayout>(`/payouts/${payoutId}/sync`, { body: {} });
}

/** Everyone who has been paid by this group, best trust first. */
export async function fetchContributorTrust(
  groupId: string
): Promise<{ contributors: SocialTrust[] }> {
  return request<{ contributors: SocialTrust[] }>(`/groups/${groupId}/trust`);
}

/** Bounties a group marked public; no session required. */
export async function fetchPublicBountyBoard(): Promise<{ bounties: SocialBounty[] }> {
  return request<{ bounties: SocialBounty[] }>('/public/board');
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
