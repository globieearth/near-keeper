import Constants from 'expo-constants';
import { Platform } from 'react-native';

const FALLBACK_ORIGIN = 'http://localhost:3001';
const FALLBACK_WEB_ORIGIN = 'http://localhost:8081';

const PRODUCTION_ORIGIN = 'https://near-keeperapi.globie.ai';
const PRODUCTION_WEB_ORIGIN = 'https://near-keeper.globie.ai';

/**
 * Origin the API lives behind — near-keeperapi.globie.ai in production, the
 * local Fastify port in development. EXPO_PUBLIC_API_URL overrides both.
 */
const envOrigin = process.env.EXPO_PUBLIC_API_URL?.trim();

export const API_ORIGIN = (
  (envOrigin || undefined) ??
  (Constants.expoConfig?.extra?.apiOrigin as string | undefined) ??
  (process.env.NODE_ENV === 'production' ? PRODUCTION_ORIGIN : FALLBACK_ORIGIN)
).replace(/\/$/, '');

export const API_BASE = `${API_ORIGIN}/api`;

/**
 * Public origin of the web app, where invite links land. The API and the SPA are
 * separate hostnames in production, so this cannot derive from API_ORIGIN; set
 * EXPO_PUBLIC_WEB_URL to override.
 */
export const WEB_ORIGIN = (
  process.env.EXPO_PUBLIC_WEB_URL?.trim() ||
  (process.env.NODE_ENV === 'production' ? PRODUCTION_WEB_ORIGIN : FALLBACK_WEB_ORIGIN)
).replace(/\/$/, '');

export const IS_WEB = Platform.OS === 'web';
export const IS_NATIVE = Platform.OS !== 'web';

/**
 * Base URL of the Meteor Wallet web app — the `meteor` entry in
 * `lib/wallets.ts`. The app owns no NEAR keys (the server never signs either),
 * so login and settlement both happen in a wallet. Nightly and Sender are
 * browser extensions and carry fixed URLs in the registry; set
 * EXPO_PUBLIC_NEAR_WALLET_URL only to point the Meteor entry at a self-hosted
 * clone.
 */
export const NEAR_WALLET_URL = (
  process.env.EXPO_PUBLIC_NEAR_WALLET_URL?.trim() || 'https://wallet.meteorwallet.app'
).replace(/\/$/, '');

/**
 * Network the wallet acts on. The signature is only checked against the chain
 * the server is configured for (`NEAR_NETWORK`), so this has to agree with it;
 * the demo runs on testnet, which is also the default here.
 */
export const NEAR_NETWORK: 'testnet' | 'mainnet' =
  process.env.EXPO_PUBLIC_NEAR_NETWORK?.trim() === 'mainnet' ? 'mainnet' : 'testnet';
