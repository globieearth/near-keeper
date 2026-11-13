import {
    createSocialDaoTreasury,
    prepareBountyPayout,
    prepareNearAnchorCall,
    prepareNearFtTransfer,
    prepareNearNativeTransfer,
    prepareNearRecordAcceptance,
} from './api';
import { NEAR_NETWORK, NEAR_WALLET_URL } from './config';
import type { PreparedDaoCreation, SignedConsent } from './types';

/**
 * Client-side NEAR helpers. The app holds no NEAR key: everything here builds
 * URLs or validates input, and the wallet does the signing. `payNearTransfer`
 * ties those pieces together — ask the API for the transfer, let the wallet
 * pop up and approve it, hand back the hash.
 */

/** Same grammar as the server's `isNearAccountId`, so a typo costs no round trip. */
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isNearAccountId(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && ACCOUNT_ID.test(value);
}

function base(explorerUrl: string): string {
  return explorerUrl.replace(/\/$/, '');
}

/** A NEP-141 transfer's page on the explorer in `/near/status`. */
export function nearTxUrl(explorerUrl: string, txHash: string): string {
  return `${base(explorerUrl)}/txns/${txHash}`;
}

export function nearAccountUrl(explorerUrl: string, accountId: string): string {
  return `${base(explorerUrl)}/address/${accountId}`;
}

/**
 * The wallet's NEP-413 page. NEP-413 says a web wallet answers by appending
 * `#accountId=…&publicKey=…&signature=…&state=…` to `callbackUrl`, which is why
 * `callbackUrl` here must be the return page (web) or the app deep link (native).
 *
 * Built by hand rather than with `URLSearchParams`, whose React Native
 * implementation is not complete.
 */
export function walletSignMessageUrl(params: {
  message: string;
  /** Base64 of the 32-byte nonce, exactly as `/auth/near/nonce` issued it. */
  nonce: string;
  recipient: string;
  callbackUrl: string;
  state: string;
  /** Wallet base URL; Meteor when omitted. */
  walletUrl?: string;
}): string {
  const query = [
    ['message', params.message],
    ['nonce', params.nonce],
    ['recipient', params.recipient],
    ['callbackUrl', params.callbackUrl],
    ['state', params.state],
  ]
    .map(([key, value]) => `${key}=${encodeURIComponent(value!)}`)
    .join('&');

  return `${(params.walletUrl ?? NEAR_WALLET_URL).replace(/\/$/, '')}/sign-message?${query}`;
}

/**
 * Meteor's dapp hand-off. It has no `/sign-message` page to redirect to: the
 * popup only learns what to sign from the opener's `postMessage`, and answers
 * the same way. If the opener never posts, the popup sits on its "Receiving
 * details from Dapp" screen. See `getMeteorPostMessenger()` in
 * `@meteorwallet/sdk`.
 */
export const METEOR_SIGN_MESSAGE = 'sign_message';

/**
 * `EDappActionSource.website_post_message` — a short code, not the enum's long
 * name. The wallet compares the `source` query parameter against the code, so
 * the long name falls through to its redirect-callback path and renders
 * "Couldn't parse the correct arguments for authentication".
 */
export const METEOR_SOURCE_POST_MESSAGE = 'wpm';

export function meteorConnectUrl(params: {
  uid: string;
  network: string;
  actionType: string;
}): string {
  return (
    `${NEAR_WALLET_URL}/connect/${params.network}/${params.actionType}` +
    `?source=${METEOR_SOURCE_POST_MESSAGE}&connectionUid=${encodeURIComponent(params.uid)}`
  );
}

/** Correlates our requests with the wallet's answers; the wallet only echoes it. */
export function newConnectionUid(): string {
  const bytes = new Uint8Array(16);
  const source = globalThis.crypto;
  if (source && typeof source.getRandomValues === 'function') {
    source.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * The nonce leaves the API as base64 (it also appears in the message text), but
 * Meteor takes it as raw bytes. Decoded by hand because React Native has no
 * `atob`.
 */
export function base64ToBytes(value: string): number[] {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const character of value) {
    if (character === '=') break;
    const index = BASE64_ALPHABET.indexOf(character);
    if (index === -1) continue;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  return bytes;
}

/**
 * `EExternalActionType.sign`: the wallet signs the transactions we hand it,
 * broadcasts them, and reports the execution outcome. That is the whole
 * one-tap payment — no redirect, no copy-paste.
 */
export const METEOR_SIGN = 'sign';

export const METEOR_POLL_MS = 450;
const METEOR_POPUP_WIDTH = 390;
const METEOR_POPUP_HEIGHT = 650;

export const POPUP_BLOCKED =
  'The wallet window was blocked. Allow pop-ups for this site and try again.';

/** Meteor's `endTags` → what the person can do about it. */
export const METEOR_FAILURES: Record<string, string> = {
  INCOMPLETE_ACTION: 'The wallet did not finish signing. Please try again.',
  NEW_ACTION_STARTED: 'A newer wallet request replaced this one. Please try again.',
  NO_ACCOUNTS: 'That wallet has no NEAR account yet. Create or import one first.',
  POPUP_WINDOW_OPEN_FAILED: POPUP_BLOCKED,
  POPUP_WINDOW_REFUSED: POPUP_BLOCKED,
};

/** Target origin for `postMessage`; anything else is ignored by the wallet. */
export function walletOrigin(walletUrl: string = NEAR_WALLET_URL): string {
  const match = /^[a-z][a-z\d+.-]*:\/\/[^/?#]+/i.exec(walletUrl);
  return match ? match[0] : walletUrl;
}

export function popupFeatures(): string {
  const screenX = typeof window.screenX === 'number' ? window.screenX : 0;
  const screenY = typeof window.screenY === 'number' ? window.screenY : 0;
  const left = Math.max(0, screenX + (window.outerWidth - METEOR_POPUP_WIDTH) / 2);
  const top = Math.max(0, screenY + (window.outerHeight - METEOR_POPUP_HEIGHT) / 2);
  return (
    `popup=1,width=${METEOR_POPUP_WIDTH},height=${METEOR_POPUP_HEIGHT},` +
    `left=${Math.round(left)},top=${Math.round(top)}`
  );
}

/** What the wallet posts back on `window`; only the fields we consume. */
export type MeteorPayload = {
  accountId?: string;
  publicKey?: string;
  signature?: string;
  state?: string;
  /** `sign` only: one outcome per transaction we sent. */
  executionOutcomes?: Array<{ transaction_outcome?: { id?: string } }>;
};

type MeteorAnswer = {
  uid?: string;
  status?: string;
  endTags?: string[];
  payload?: MeteorPayload;
};

export type MeteorOutcome<T> =
  | { status: 'success'; value: T }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

/**
 * Meteor has no page a browser can be redirected to. The popup at
 * `/connect/{network}/{action}` learns what to do from the opener's
 * `postMessage` — re-sent every 450 ms until the wallet answers — and answers
 * the same way. Opened on its own it says "Couldn't parse the correct
 * arguments for authentication", which is what the old redirect hit.
 */
export function runMeteorAction<T>(params: {
  actionType: string;
  inputs: unknown;
  /** Turn the wallet's success payload into the value the caller wants. */
  extract: (payload: MeteorPayload) => T | Promise<T>;
  /** Shown when the wallet fails without an `endTag` we can explain. */
  failureMessage?: string;
}): Promise<MeteorOutcome<T>> {
  const fallback =
    params.failureMessage ?? 'The wallet did not complete the request. Please try again.';
  const uid = newConnectionUid();
  const origin = walletOrigin();
  const popup = window.open(
    meteorConnectUrl({ uid, network: NEAR_NETWORK, actionType: params.actionType }),
    '_blank',
    popupFeatures()
  );
  if (!popup) return Promise.resolve({ status: 'error', message: POPUP_BLOCKED });

  return new Promise<MeteorOutcome<T>>((resolve) => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let settled = false;

    const clear = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      window.removeEventListener('message', onMessage);
    };

    const settle = (outcome: MeteorOutcome<T>) => {
      if (settled) return;
      settled = true;
      clear();
      try {
        popup.close();
      } catch {
        // Already gone; nothing to clean up.
      }
      resolve(outcome);
    };

    function onMessage(event: MessageEvent) {
      if (settled || event.origin !== origin) return;
      const answer = event.data as MeteorAnswer | null;
      if (!answer || answer.uid !== uid) return;

      if (answer.status === 'closed_success') {
        // Approved: stop polling and read what the wallet sent back.
        clear();
        void Promise.resolve()
          .then(() => params.extract(answer.payload ?? {}))
          .then(
            (value) => settle({ status: 'success', value }),
            (cause: unknown) =>
              settle({
                status: 'error',
                message: cause instanceof Error ? cause.message : fallback,
              })
          );
        return;
      }

      if (answer.status === 'closed_window') {
        settle({ status: 'cancelled' });
        return;
      }

      if (answer.status === 'closed_fail') {
        const tags = answer.endTags ?? [];
        const tag = tags[tags.length - 1] ?? '';
        if (tag === 'USER_CANCELLED' || tag === 'WINDOW_CLOSED') {
          settle({ status: 'cancelled' });
        } else {
          settle({ status: 'error', message: METEOR_FAILURES[tag] ?? fallback });
        }
      }
    }

    const send = () => {
      if (settled) return;
      if (popup.closed) {
        settle({ status: 'cancelled' });
        return;
      }
      // `inputs` only travels while initializing, exactly as Meteor expects.
      popup.postMessage(
        {
          uid,
          actionType: params.actionType,
          status: 'initializing',
          network: NEAR_NETWORK,
          endTags: [],
          inputs: params.inputs,
        },
        origin
      );
    };

    window.addEventListener('message', onMessage);
    send();
    timer = setInterval(send, METEOR_POLL_MS);
  });
}

export type NearPayOutcome =
  | { status: 'sent'; txHash: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

/**
 * Accepting a group agreement is a NEP-413 signature, not a transaction: it
 * costs nothing and needs no block. No `callbackUrl` is sent, because there is
 * no return page to append the signature to — the popup answers inline, and the
 * API verifies the digest with an empty callback URL.
 */
export async function signAgreementTerms(input: {
  message: string;
  /** Base64 of the 32 raw bytes `GET /agreements/:id/consent` issued. */
  nonce: string;
  recipient: string;
}): Promise<MeteorOutcome<SignedConsent>> {
  const outcome = await runMeteorAction<SignedConsent>({
    actionType: METEOR_SIGN_MESSAGE,
    inputs: {
      message: input.message,
      nonce: base64ToBytes(input.nonce),
      recipient: input.recipient,
      // Echoed back so a swapped challenge shows up as a mismatch.
      state: input.nonce,
    },
    failureMessage: 'The wallet did not sign the terms. Please try again.',
    extract: (payload) => {
      if (!payload.accountId || !payload.publicKey || !payload.signature) {
        throw new Error('The wallet returned an incomplete signature. Please try again.');
      }
      return {
        accountId: payload.accountId,
        publicKey: payload.publicKey,
        signature: payload.signature,
      };
    },
  });

  return outcome;
}

/**
 * Sign and publish one prepared transaction in Meteor. Shared by payments and
 * anchors so both report the same way: a receipt id, or a cancel, or a message
 * the caller can show.
 */
async function signMeteorTransaction(transaction: string): Promise<NearPayOutcome> {
  const outcome = await runMeteorAction<string>({
    actionType: METEOR_SIGN,
    // Meteor takes transactions as a comma-joined list of base64 strings.
    inputs: { transactions: transaction },
    extract: (payload) => {
      const id = payload.executionOutcomes?.[0]?.transaction_outcome?.id;
      if (!id) {
        throw new Error(
          'The wallet closed without a receipt. Check your wallet history before trying again.'
        );
      }
      return id;
    },
  });

  return outcome.status === 'success' ? { status: 'sent', txHash: outcome.value } : outcome;
}

/**
 * One tap, one approval: the API encodes the transfer, the wallet signs and
 * sends it in a popup over this page, and the hash comes back for the caller to
 * settle with. Web only — a native auth sheet returns a redirect, not an
 * execution outcome, so native keeps the paste-the-hash flow.
 */
export async function payNearTransfer(input: {
  receiverId: string;
  amount: string;
  memo?: string | null;
  /** Set when paying from a pay link, so the API checks the wallet owes it. */
  shareId?: string;
}): Promise<NearPayOutcome> {
  let transaction: string;
  try {
    const prepared = await prepareNearFtTransfer(input);
    transaction = prepared.transaction;
  } catch (cause) {
    return {
      status: 'error',
      message: cause instanceof Error ? cause.message : 'Could not prepare the transfer',
    };
  }

  return signMeteorTransaction(transaction);
}

/**
 * Native NEAR gifts. Unlike a token transfer there is no contract call and no
 * memo, so the only thing the wallet can get wrong is the amount — which is why
 * the caller passes the quote's exact `chainAmount` instead of a decimal.
 */
export async function payNearNativeTransfer(input: {
  receiverId: string;
  deposit: string;
}): Promise<NearPayOutcome> {
  let transaction: string;
  try {
    const prepared = await prepareNearNativeTransfer(input);
    transaction = prepared.transaction;
  } catch (cause) {
    return {
      status: 'error',
      message: cause instanceof Error ? cause.message : 'Could not prepare the transfer',
    };
  }

  return signMeteorTransaction(transaction);
}

/**
 * The registry half of an agreement: a `record_acceptance` call that writes
 * this member's signature into the shared contract. Unlike the read-only
 * anchor it costs storage, and the contract only accepts it from the account
 * that signed — so this is the member's own act, not the fronter's.
 */
export async function payNearRecordAcceptance(input: {
  agreementId: string;
}): Promise<NearPayOutcome> {
  let transaction: string;
  try {
    const prepared = await prepareNearRecordAcceptance(input.agreementId);
    transaction = prepared.transaction;
  } catch (cause) {
    return {
      status: 'error',
      message:
        cause instanceof Error ? cause.message : 'Could not prepare the registry call',
    };
  }

  return signMeteorTransaction(transaction);
}

/**
 * The anchor half of an agreement: a read-only `ft_balance_of` call whose
 * argument is the terms digest. It moves nothing, so the wallet popup shows a
 * Call rather than a transfer — but it is still the fronter's own signature on
 * public record, which is what makes the terms provable.
 */
export async function payNearAnchorCall(input: {
  agreementId: string;
}): Promise<NearPayOutcome> {
  let transaction: string;
  try {
    const prepared = await prepareNearAnchorCall(input.agreementId);
    transaction = prepared.transaction;
  } catch (cause) {
    return {
      status: 'error',
      message: cause instanceof Error ? cause.message : 'Could not prepare the anchor call',
    };
  }

  return signMeteorTransaction(transaction);
}

/**
 * Social Money: the payout is an `add_proposal` on the group's Sputnik DAO, so
 * the wallet signs a proposal instead of a transfer. Preparing it also freezes
 * the payout row, which is why the id comes back with the hash — the caller
 * records both. Native has no execution outcome to read, so it keeps the
 * paste-the-hash flow and calls `prepareBountyPayout` itself.
 */
export type SputnikPayoutOutcome =
  | { status: 'sent'; txHash: string; payoutId: string }
  | { status: 'cancelled'; payoutId: string }
  | { status: 'error'; message: string };

export async function payNearSputnikCall(input: {
  bountyId: string;
  claimId: string;
}): Promise<SputnikPayoutOutcome> {
  let prepared: Awaited<ReturnType<typeof prepareBountyPayout>>;
  try {
    prepared = await prepareBountyPayout(input.bountyId, input.claimId);
  } catch (cause) {
    return {
      status: 'error',
      message:
        cause instanceof Error ? cause.message : 'Could not prepare the DAO proposal',
    };
  }

  const outcome = await signMeteorTransaction(prepared.transaction);
  if (outcome.status === 'sent') {
    return { status: 'sent', txHash: outcome.txHash, payoutId: prepared.payout.id };
  }
  if (outcome.status === 'cancelled') {
    return { status: 'cancelled', payoutId: prepared.payout.id };
  }
  return outcome;
}

/**
 * Creating a DAO is one factory call, so it signs like any other prepared
 * transaction. The wallet pays the storage deposit out of the member's own
 * balance; there is no treasury yet to pay it. `prepared` comes back with the
 * account the factory will mint, which is what the caller registers afterwards.
 */
export type DaoCreationOutcome =
  | { status: 'sent'; txHash: string; created: PreparedDaoCreation }
  | { status: 'cancelled'; created: PreparedDaoCreation }
  | { status: 'error'; message: string };

export async function payNearCreateDao(input: {
  groupId: string;
  name: string;
  label: string;
  purpose?: string;
}): Promise<DaoCreationOutcome> {
  let created: PreparedDaoCreation;
  try {
    created = await createSocialDaoTreasury(input.groupId, {
      name: input.name,
      label: input.label,
      purpose: input.purpose,
    });
  } catch (cause) {
    return {
      status: 'error',
      message:
        cause instanceof Error ? cause.message : 'Could not prepare the DAO creation',
    };
  }

  const outcome = await signMeteorTransaction(created.transaction);
  if (outcome.status === 'sent') {
    return { status: 'sent', txHash: outcome.txHash, created };
  }
  if (outcome.status === 'cancelled') {
    return { status: 'cancelled', created };
  }
  return outcome;
}
