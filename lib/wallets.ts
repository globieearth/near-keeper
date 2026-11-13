import { IS_WEB, NEAR_WALLET_URL } from './config';

/**
 * The NEAR wallets this app can sign in with. NEAR is the only credential —
 * there is no email path — so the picker is the whole sign-in surface.
 *
 * `kind` is the handshake the wallet speaks, not a brand detail:
 *   - `meteor`   — popup that learns its inputs from the opener's `postMessage`
 *   - `redirect` — a `/sign-message` page that answers with `postMessage` or a
 *                  fragment on `callbackUrl`
 *   - `injected` — a browser extension that exposes `signMessage` on `window`
 *
 * No live wallet speaks `redirect` any more: MyNearWallet, the wallet that
 * defined that page, shut down on 31 October 2026. The kind stays because it
 * is what any future web wallet would use.
 */
export type WalletId = 'meteor' | 'nightly' | 'sender';

export type NearWallet = {
  id: WalletId;
  name: string;
  hint: string;
  kind: 'meteor' | 'redirect' | 'injected';
  /** Base URL of the wallet's web app; empty for an injected-only wallet. */
  url: string;
};

export const NEAR_WALLETS: readonly NearWallet[] = [
  {
    id: 'meteor',
    name: 'Meteor Wallet',
    hint: 'Browser extension or web wallet',
    kind: 'meteor',
    url: NEAR_WALLET_URL,
  },
  {
    id: 'nightly',
    name: 'Nightly',
    hint: 'Browser extension or mobile app',
    kind: 'injected',
    url: 'https://nightly.app',
  },
  {
    id: 'sender',
    name: 'Sender',
    hint: 'Browser extension',
    kind: 'injected',
    url: 'https://sender.org',
  },
];

export const DEFAULT_WALLET_ID: WalletId = 'meteor';

/** An injected wallet needs a browser extension, so native only lists web wallets. */
export function availableWallets(): readonly NearWallet[] {
  return IS_WEB
    ? NEAR_WALLETS
    : NEAR_WALLETS.filter((wallet) => wallet.kind !== 'injected');
}

export function walletById(id: WalletId): NearWallet {
  return NEAR_WALLETS.find((wallet) => wallet.id === id) ?? NEAR_WALLETS[0]!;
}
