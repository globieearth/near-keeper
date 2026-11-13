import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from 'react';

import { onUnauthorized } from './api';
import {
    startNearLogin,
    verifyNearReturn,
    type NearLoginOutcome,
    type NearReturn
} from './near-login';
import { registerForPush, unregisterPush } from './push';
import { clearSession, getSession, type StoredSession } from './session';
import type { WalletId } from './wallets';

type SessionState = {
  session: StoredSession | null;
  ready: boolean;
  /** Opens the chosen NEAR wallet; native resolves with the outcome in place. */
  signInWithNear: (walletId?: WalletId) => Promise<NearLoginOutcome>;
  /** Return page: check the signature the wallet appended and keep the session. */
  completeNearLogin: (
    returned: NearReturn,
    fallbackNonce?: string | null
  ) => Promise<StoredSession>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<StoredSession | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSession()
      .then((stored) => {
        if (cancelled) return;
        setSessionState(stored);
        // Expo tokens can rotate between launches; re-registering is idempotent.
        if (stored) void registerForPush();
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // api.ts already deleted the stored token; this drops the in-memory copy so
  // the gate re-renders the sign-in screen on the very next frame.
  useEffect(() => onUnauthorized(() => setSessionState(null)), []);

  const signInWithNear = useCallback(async (walletId?: WalletId) => {
    const outcome = await startNearLogin(walletId);
    if (outcome.status === 'signed-in') {
      setSessionState(outcome.session);
      void registerForPush();
    }
    return outcome;
  }, []);

  const completeNearLogin = useCallback(
    async (returned: NearReturn, fallbackNonce?: string | null) => {
      const next = await verifyNearReturn(returned, fallbackNonce);
      setSessionState(next);
      void registerForPush();
      return next;
    },
    []
  );

  const signOut = useCallback(async () => {
    // The token has to be dropped while the session is still valid.
    await unregisterPush();
    await clearSession();
    setSessionState(null);
  }, []);

  const value = useMemo(
    () => ({
      session,
      ready,
      signInWithNear,
      completeNearLogin,
      signOut,
    }),
    [session, ready, signInWithNear, completeNearLogin, signOut]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider');
  return context;
}
