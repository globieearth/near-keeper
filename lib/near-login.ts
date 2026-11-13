import * as WebBrowser from 'expo-web-browser';

import { completeNearLogin, requestNearNonce } from './api';
import { IS_WEB } from './config';
import {
    base64ToBytes,
    METEOR_SIGN_MESSAGE,
    popupFeatures,
    runMeteorAction,
    walletOrigin,
    walletSignMessageUrl
} from './near';
import type { StoredSession } from './session';
import {
    DEFAULT_WALLET_ID,
    NEAR_WALLETS,
    walletById,
    type NearWallet,
    type WalletId
} from './wallets';

/**
 * NEP-413 login from the client side. The API issues a nonce and checks the
 * signature; the wallet owns the key. This module only opens the wallet and
 * trades what comes back for a session.
 */

/** Must match NEAR_LOGIN_NATIVE_RETURN_URL on the server, i.e. app.json `scheme`. */
const NATIVE_RETURN_URL = 'globiekeeper://auth/near';

/**
 * Browsers drop the fragment of a redirect, but a full page load also drops the
 * nonce we fetched before leaving. Keep it so verification survives a wallet
 * that omits `state`.
 */
const RETURN_KEY = 'globie.near.login';

/** The wallet picked last time, so a retry reopens the same one. */
const WALLET_KEY = 'globie.near.wallet';

export type NearLoginOutcome =
  | { status: 'signed-in'; session: StoredSession }
  /** `redirect` wallets leave the page; the return page finishes the login. */
  | { status: 'redirecting' }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

const MESSAGES: Record<string, string> = {
  cancelled: 'NEAR sign-in was cancelled.',
  near_not_configured: 'NEAR sign-in is not switched on for this server yet.',
  near_account_invalid: 'The wallet returned an account id Globie cannot read.',
  near_nonce_invalid: 'That sign-in request expired. Please try again.',
  near_nonce_account_mismatch:
    'The wallet signed with a different account than the one requested. Please try again.',
  near_login_bad_public_key: 'That wallet key is not a valid NEAR key.',
  near_login_key_not_found: 'That key is not an access key on this account.',
  near_login_key_not_full_access:
    'Sign-in needs a full-access key. Pick a different wallet or key and try again.',
  near_login_bad_signature: 'The signature did not match. Please try again.',
};

export function nearErrorMessage(code: string | null): string {
  return (
    (code ? MESSAGES[code] : null) ?? 'NEAR sign-in did not complete. Please try again.'
  );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function readPairs(raw: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const index = pair.indexOf('=');
    const key = index === -1 ? pair : pair.slice(0, index);
    const value = index === -1 ? '' : pair.slice(index + 1);
    values.set(safeDecode(key), safeDecode(value));
  }
  return values;
}

/**
 * What a wallet puts on the fragment: `#accountId=…&publicKey=…&signature=…&state=…`,
 * or `#error=…&state=…`.
 */
export type NearReturn = {
  accountId: string | null;
  publicKey: string | null;
  signature: string | null;
  nonce: string | null;
  error: string | null;
};

/**
 * Wallets answer on the fragment (`#accountId=…`), because fragments are not
 * sent in the `Referer`. Read the query too so a wallet that used `?` still
 * works.
 */
export function readNearReturn(url: string): NearReturn {
  const hash = url.split('#')[1];
  const values = hash ? readPairs(hash) : readPairs(url.split('?')[1] ?? '');

  return {
    accountId: values.get('accountId') ?? null,
    publicKey: values.get('publicKey') ?? null,
    signature: values.get('signature') ?? null,
    nonce: values.get('state') ?? null,
    error: values.get('error') ?? null,
  };
}

/** Web-only: the page reloads between fetching the nonce and coming back. */
export function rememberNearNonce(nonce: string): void {
  if (!IS_WEB) return;
  try {
    window.sessionStorage.setItem(RETURN_KEY, nonce);
  } catch {
    // Private mode or a blocked store: `state` is still the primary carrier.
  }
}

export function takeNearNonce(): string | null {
  if (!IS_WEB) return null;
  try {
    const nonce = window.sessionStorage.getItem(RETURN_KEY);
    window.sessionStorage.removeItem(RETURN_KEY);
    return nonce;
  } catch {
    return null;
  }
}

/**
 * Where to land after a wallet that navigates the whole page (a pay link, not
 * the sign-in screen). Same reason as the nonce: a full load loses the route.
 */
const NEXT_KEY = 'globie.near.next';

export function rememberNearNext(path: string): void {
  if (!IS_WEB) return;
  try {
    window.sessionStorage.setItem(NEXT_KEY, path);
  } catch {
    // Private mode or a blocked store: the wallet returns to the home screen.
  }
}

export function takeNearNext(): string | null {
  if (!IS_WEB) return null;
  try {
    const path = window.sessionStorage.getItem(NEXT_KEY);
    window.sessionStorage.removeItem(NEXT_KEY);
    // Only an app-relative path: a stored absolute URL would be an open redirect.
    return path && path.startsWith('/') && !path.startsWith('//') ? path : null;
  } catch {
    return null;
  }
}

/** A popup sign-in never reloads the page, so the destination was not used. */
export function forgetNearNext(): void {
  if (!IS_WEB) return;
  try {
    window.sessionStorage.removeItem(NEXT_KEY);
  } catch {
    // Nothing stored, nothing to drop.
  }
}

/** Remember the picker choice; a retry should not dump the person back to Meteor. */
export function rememberWallet(id: WalletId): void {
  if (!IS_WEB) return;
  try {
    window.localStorage.setItem(WALLET_KEY, id);
  } catch {
    // Private mode or a blocked store: the caller still gets `id` back.
  }
}

export function lastWalletId(): WalletId {
  if (!IS_WEB) return DEFAULT_WALLET_ID;
  try {
    const saved = window.localStorage.getItem(WALLET_KEY);
    const match = NEAR_WALLETS.find((wallet) => wallet.id === saved);
    if (match) return match.id;
  } catch {
    // Fall through to the default rather than failing sign-in over storage.
  }
  return DEFAULT_WALLET_ID;
}

type NearChallenge = {
  nonce: string;
  message: string;
  recipient: string;
  callbackUrl: string;
  /** The chain the API verifies on; the wallet must be on the same one. */
  network: string;
};

/** What a `redirect` wallet posts to the opener on success. */
type WalletAnswer = {
  status?: string;
  state?: string;
  signedRequest?: { accountId?: string; publicKey?: string; signature?: string };
};

/**
 * A `/sign-message` web wallet. A popup is tried first so the page keeps its
 * state; if the browser blocks it, the caller falls back to a full redirect.
 * No live wallet uses this path today — MyNearWallet, which defined it, retired
 * on 31 October 2026 — but it is the shape any future web wallet would take.
 *
 * These wallets do not `postMessage` back: they navigate the window that
 * opened them to `callbackUrl#accountId=…&publicKey=…&signature=…&state=…`.
 * While the popup sits on the wallet's origin its `location` is unreadable
 * (SecurityError), so the return leg is a guarded read of that href — the
 * moment it stops throwing, the fragment is ours.
 */
function signInWithRedirectWallet(
  challenge: NearChallenge,
  wallet: NearWallet
): Promise<NearLoginOutcome> | null {
  const url = walletSignMessageUrl({
    message: challenge.message,
    nonce: challenge.nonce,
    recipient: challenge.recipient,
    callbackUrl: challenge.callbackUrl,
    state: challenge.nonce,
    walletUrl: wallet.url,
  });

  let popup: Window | null = null;
  try {
    popup = window.open(url, '_blank', popupFeatures());
  } catch {
    popup = null;
  }
  // Pop-up blocked: the page navigates instead, and `/near/login` finishes it.
  if (!popup) return null;

  const origin = walletOrigin(wallet.url);
  const opened = popup;
  /** Where the wallet was told to send the popup back to. */
  const expected = challenge.callbackUrl.split('#')[0]!.split('?')[0]!;

  return new Promise<NearLoginOutcome>((resolve) => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let settled = false;

    const clear = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      window.removeEventListener('message', onMessage);
    };

    const settle = (outcome: NearLoginOutcome) => {
      if (settled) return;
      settled = true;
      clear();
      resolve(outcome);
    };

    function onMessage(event: MessageEvent) {
      if (settled || event.origin !== origin) return;
      const answer = event.data as WalletAnswer | null;
      if (!answer) return;

      if (answer.status === 'success' && answer.signedRequest) {
        const { accountId, publicKey, signature } = answer.signedRequest;
        void Promise.resolve()
          .then(() =>
            verifyNearReturn(
              {
                accountId: accountId ?? null,
                publicKey: publicKey ?? null,
                signature: signature ?? null,
                nonce: answer.state ?? challenge.nonce,
                error: null,
              },
              challenge.nonce
            )
          )
          .then(
            (session) => settle({ status: 'signed-in', session }),
            (cause: unknown) =>
              settle({
                status: 'error',
                message: cause instanceof Error ? cause.message : nearErrorMessage(null),
              })
          );
        return;
      }

      if (
        answer.status === 'failure' ||
        answer.status === 'error' ||
        answer.status === 'rejected'
      ) {
        settle({ status: 'cancelled' });
      }
    }

    window.addEventListener('message', onMessage);
    timer = setInterval(() => {
      if (settled) return;
      if (opened.closed) return settle({ status: 'cancelled' });

      let href: string;
      try {
        href = opened.location.href;
      } catch {
        // Still on the wallet's origin — nothing to read yet.
        return;
      }

      if (!href.startsWith(expected)) return;

      const returned = readNearReturn(href);
      if (returned.error) {
        settle(
          /reject|cancel|denied/i.test(returned.error)
            ? { status: 'cancelled' }
            : { status: 'error', message: nearErrorMessage(returned.error) }
        );
        return;
      }
      if (!returned.accountId || !returned.signature) return;

      settled = true;
      clear();
      void verifyNearReturn(returned, challenge.nonce).then(
        (session) => {
          try {
            opened.close();
          } catch {
            // The person may have already closed it.
          }
          resolve({ status: 'signed-in', session });
        },
        (cause: unknown) => {
          settled = false;
          settle({
            status: 'error',
            message: cause instanceof Error ? cause.message : nearErrorMessage(null),
          });
        }
      );
    }, 500);
  });
}

/** The bare NEP-413 answer both extensions ultimately return. */
type SignedMessage = { accountId?: string; publicKey?: string; signature?: string };

/**
 * What a browser extension exposes on `window`.
 *
 * The extensions disagree on two things, so every member past `signMessage` is
 * optional:
 *
 *   - Nightly lives at `window.nightly.near`, exposes `isConnected` and
 *     `connect()`, and resolves `signMessage` straight to the signed message.
 *   - Sender lives at `window.near`, has no `isConnected`/`connect` — approval
 *     goes through `isSignedIn()`/`requestSignIn()` — and resolves
 *     `signMessage` to a wrapper carrying the answer on `response`.
 */
type InjectedProvider = {
  isConnected?: boolean;
  /** Nightly reports the network it will sign on. */
  networkInfo?: { networkId?: string };
  connect?: (onAccountChange?: unknown, eagerConnect?: boolean) => Promise<unknown>;
  /** Sender only: the site is approved through `requestSignIn`, not `connect`. */
  isSignedIn?: () => boolean;
  requestSignIn?: (params?: {
    contractId?: string;
    methodNames?: string[];
  }) => Promise<unknown>;
  signMessage(input: {
    message: string;
    nonce: Uint8Array | number[];
    recipient: string;
    callbackUrl?: string;
    state?: string;
  }): Promise<SignedMessage & { response?: SignedMessage; error?: string }>;
};

function injectedProvider(wallet: NearWallet): InjectedProvider | null {
  if (!IS_WEB) return null;
  const host = window as unknown as {
    nightly?: { near?: InjectedProvider };
    /** Sender's injected surface. */
    near?: InjectedProvider;
  };
  return wallet.id === 'sender' ? (host.near ?? null) : (host.nightly?.near ?? null);
}

/** Extensions inject after the page loads, so give them a few seconds. */
function waitForInjected(wallet: NearWallet, timeoutMs = 3000, stepMs = 50) {
  const found = injectedProvider(wallet);
  if (found || wallet.kind !== 'injected') return Promise.resolve(found);

  return new Promise<InjectedProvider | null>((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const provider = injectedProvider(wallet);
      if (provider || Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        resolve(provider);
      }
    }, stepMs);
  });
}

/**
 * How long a wallet may sit on an approval prompt. An extension that rejects
 * the request internally never answers at all, so without this the button
 * spins on `busy` forever.
 */
const WALLET_PROMPT_TIMEOUT_MS = 120_000;

function withDeadline<T>(work: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), WALLET_PROMPT_TIMEOUT_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause);
      }
    );
  });
}

/**
 * Web: Meteor's popup signs the NEP-413 message through the shared wallet
 * channel and posts the signature back. Native never comes through here — its
 * auth sheet appends the signature to the deep link instead.
 */
function signInWithMeteor(challenge: NearChallenge): Promise<NearLoginOutcome> {
  return runMeteorAction<StoredSession>({
    actionType: METEOR_SIGN_MESSAGE,
    inputs: {
      message: challenge.message,
      // The wallet signs raw bytes; the API issued base64.
      nonce: base64ToBytes(challenge.nonce),
      recipient: challenge.recipient,
      callbackUrl: challenge.callbackUrl,
      // Echoed back as `payload.state`, so a changed nonce shows up as a mismatch.
      state: challenge.nonce,
    },
    failureMessage: nearErrorMessage(null),
    extract: (payload) =>
      verifyNearReturn(
        {
          accountId: payload.accountId ?? null,
          publicKey: payload.publicKey ?? null,
          signature: payload.signature ?? null,
          nonce: payload.state ?? challenge.nonce,
          error: null,
        },
        challenge.nonce
      ),
  }).then((outcome) =>
    outcome.status === 'success' ? { status: 'signed-in', session: outcome.value } : outcome
  );
}

async function signInWithInjectedWallet(
  challenge: NearChallenge,
  wallet: NearWallet
): Promise<NearLoginOutcome> {
  const provider = await waitForInjected(wallet);
  if (!provider) {
    return {
      status: 'error',
      message: `Could not reach ${wallet.name}. Install the wallet extension or pick another wallet.`,
    };
  }

  try {
    // A signature made on another chain can never be checked against this
    // server's account state, so say that instead of letting the wallet prompt
    // for a signature that is guaranteed to fail.
    const walletNetwork = provider.networkInfo?.networkId;
    if (walletNetwork && challenge.network && walletNetwork !== challenge.network) {
      return {
        status: 'error',
        message: `${wallet.name} is on ${walletNetwork}, but this app signs in on ${challenge.network}. Switch the wallet's NEAR network and try again.`,
      };
    }

    // `signMessage` rejects on a site that has not been approved yet, so get
    // approval first — that is also what prompts the extension popup. Nightly
    // exposes `connect()`; Sender exposes `isSignedIn()`/`requestSignIn()`.
    const approvalMessage = `${wallet.name} did not answer. Open the extension and approve the connection, then try again.`;
    if (provider.isSignedIn && provider.requestSignIn) {
      if (!provider.isSignedIn()) {
        await withDeadline(
          provider.requestSignIn({ contractId: '', methodNames: [] }),
          approvalMessage
        );
      }
    } else if (provider.connect && !provider.isConnected) {
      await withDeadline(provider.connect(), approvalMessage);
    }

    /**
     * Nightly forwards these parameters through `JSON.stringify` in its
     * injected bridge, so a `Uint8Array` arrives as `{"0":…,"1":…}` and the
     * extension's Borsh `u8[32]` cannot encode it: the popup fails and the
     * promise never settles. A plain byte array survives that round trip.
     * Sender's `near-api-js` surface expects the typed array.
     */
    const nonce =
      wallet.id === 'nightly'
        ? base64ToBytes(challenge.nonce)
        : Uint8Array.from(base64ToBytes(challenge.nonce));

    const raw = await withDeadline(
      provider.signMessage({
        message: challenge.message,
        nonce,
        recipient: challenge.recipient,
        callbackUrl: challenge.callbackUrl,
        // Echoed back so a swapped challenge shows up as a mismatch.
        state: challenge.nonce,
      }),
      `${wallet.name} did not answer. Open the extension and approve the sign-in, then try again.`
    );

    // Sender answers with a notification wrapper; Nightly answers directly.
    if (raw.error) {
      return /reject|denied|cancel/i.test(raw.error)
        ? { status: 'cancelled' }
        : { status: 'error', message: raw.error };
    }
    const signed = raw.response ?? raw;

    const session = await verifyNearReturn(
      {
        accountId: signed.accountId ?? null,
        publicKey: signed.publicKey ?? null,
        signature: signed.signature ?? null,
        nonce: challenge.nonce,
        error: null,
      },
      challenge.nonce
    );
    return { status: 'signed-in', session };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    if (/reject|denied|cancel/i.test(message)) return { status: 'cancelled' };
    return { status: 'error', message: message || nearErrorMessage(null) };
  }
}

/**
 * Web runs the wallet's own handshake; native opens the auth sheet against the
 * deep link for any wallet with a `/sign-message` page. Every path ends in
 * `verifyNearReturn`, so the server sees one shape.
 */
export async function startNearLogin(walletId?: WalletId): Promise<NearLoginOutcome> {
  try {
    let wallet = walletById(walletId ?? lastWalletId());
    // An extension cannot be reached from the native auth sheet.
    if (!IS_WEB && wallet.kind === 'injected') wallet = walletById(DEFAULT_WALLET_ID);
    rememberWallet(wallet.id);

    const challenge = await requestNearNonce({ returnTo: IS_WEB ? 'web' : 'native' });
    rememberNearNonce(challenge.nonce);

    if (IS_WEB) {
      if (wallet.kind === 'meteor') return await signInWithMeteor(challenge);

      if (wallet.kind === 'injected') {
        return await signInWithInjectedWallet(challenge, wallet);
      }

      const popup = signInWithRedirectWallet(challenge, wallet);
      if (popup) return await popup;

      // Pop-up blocked: leave the page; the wallet returns to `/near/login`.
      window.location.assign(
        walletSignMessageUrl({
          message: challenge.message,
          nonce: challenge.nonce,
          recipient: challenge.recipient,
          callbackUrl: challenge.callbackUrl,
          state: challenge.nonce,
          walletUrl: wallet.url,
        })
      );
      return { status: 'redirecting' };
    }

    const url = walletSignMessageUrl({
      message: challenge.message,
      nonce: challenge.nonce,
      recipient: challenge.recipient,
      callbackUrl: challenge.callbackUrl,
      // `state` is opaque to the wallet; the nonce is already unique and
      // single-use, so it doubles as the correlation id.
      state: challenge.nonce,
      walletUrl: wallet.url,
    });

    const result = await WebBrowser.openAuthSessionAsync(url, NATIVE_RETURN_URL);
    if (result.type !== 'success') return { status: 'cancelled' };

    const returned = readNearReturn(result.url);
    if (returned.error) return { status: 'error', message: nearErrorMessage(returned.error) };

    const session = await verifyNearReturn(returned, challenge.nonce);
    return { status: 'signed-in', session };
  } catch (cause) {
    return {
      status: 'error',
      message: cause instanceof Error ? cause.message : nearErrorMessage(null),
    };
  }
}

/**
 * Both entry points (the native sheet and `app/near/login.tsx`) end here.
 * `fallbackNonce` covers a wallet that dropped `state`.
 */
export async function verifyNearReturn(
  returned: NearReturn,
  fallbackNonce?: string | null
): Promise<StoredSession> {
  const nonce = returned.nonce ?? fallbackNonce ?? null;
  if (!returned.accountId || !returned.publicKey || !returned.signature || !nonce) {
    throw new Error(nearErrorMessage(null));
  }

  return completeNearLogin({
    accountId: returned.accountId,
    publicKey: returned.publicKey,
    signature: returned.signature,
    nonce,
  });
}
