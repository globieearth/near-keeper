import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { SectionHeading } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { space } from '@/components/ui/theme';
import { IS_WEB } from '@/lib/config';
import {
    nearErrorMessage,
    readNearReturn,
    startNearLogin,
    takeNearNext,
    takeNearNonce,
    type NearReturn,
} from '@/lib/near-login';
import { useSession } from '@/lib/session-context';

type NearParams = {
  accountId?: string;
  publicKey?: string;
  signature?: string;
  state?: string;
  error?: string;
};

/**
 * Where a NEAR wallet sends the browser after signing (NEP-413). The wallet
 * appends the signature to this page as a URL fragment, which never reaches the
 * server; the fragment becomes a real session here and the gate shows the app.
 */
function readCurrentReturn(params: NearParams): NearReturn {
  const fromUrl = IS_WEB ? readNearReturn(window.location.href) : null;
  const param = (value?: string) => (typeof value === 'string' && value ? value : null);

  return {
    accountId: fromUrl?.accountId ?? param(params.accountId),
    publicKey: fromUrl?.publicKey ?? param(params.publicKey),
    signature: fromUrl?.signature ?? param(params.signature),
    nonce: fromUrl?.nonce ?? param(params.state),
    error: fromUrl?.error ?? param(params.error),
  };
}

export default function NearLoginScreen() {
  const params = useLocalSearchParams<NearParams>();
  const { session, completeNearLogin } = useSession();

  // Reading the fragment is pure, so the first render already knows whether the
  // wallet came back with a signature, an error, or nothing at all.
  const { accountId, publicKey, signature, nonce, error: errorCode } = readCurrentReturn(params);
  const empty = !errorCode && !(accountId && publicKey && signature);

  const started = useRef(false);
  const [error, setError] = useState<string | null>(() =>
    errorCode ? nearErrorMessage(errorCode) : null
  );
  const [retrying, setRetrying] = useState(false);

  /**
   * A `/sign-message` wallet opened in a popup lands back here inside that
   * popup, while the opener still holds the promise for this sign-in and the
   * only copy of the nonce. Both tabs would race on the single-use nonce, so
   * the popup stays passive: the opener reads this URL and finishes the login.
   */
  const inPopup = IS_WEB && typeof window !== 'undefined' && Boolean(window.opener);

  useEffect(() => {
    if (started.current || errorCode || inPopup) return;
    if (!accountId || !publicKey || !signature) return;
    started.current = true;

    // `state` is the nonce when the wallet echoes it; the stored copy covers the
    // wallet that dropped it.
    completeNearLogin(
      { accountId, publicKey, signature, nonce, error: null },
      takeNearNonce()
    )
      // A pay link remembers where the person came from; a plain sign-in has
      // no destination and lands on the home screen.
      .then(() => router.replace((takeNearNext() as Href | null) ?? '/'))
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : nearErrorMessage(null))
      );
  }, [accountId, completeNearLogin, errorCode, inPopup, nonce, publicKey, signature]);

  // The session already landed; the replace above is what moves the URL back.
  if (session) return null;

  const back = () => router.replace('/');

  async function retry() {
    setRetrying(true);
    setError(null);
    const outcome = await startNearLogin();
    if (outcome.status === 'error') setError(outcome.message);
    setRetrying(false);
  }

  if (error) {
    return (
      <Screen scroll={false}>
        <EmptyState
          icon={icon.warning}
          title="NEAR did not complete the sign-in"
          body={error}
          action={
            <View style={styles.stack}>
              <Button
                title="Try NEAR again"
                icon={icon.near}
                onPress={retry}
                loading={retrying}
              />
              <Button
                variant="secondary"
                icon={icon.chevronBack}
                title="Back to sign in"
                onPress={back}
              />
            </View>
          }
        />
      </Screen>
    );
  }

  if (empty) {
    return (
      <Screen scroll={false}>
        <EmptyState
          icon={icon.warning}
          title="Nothing to confirm"
          body="This link has no signature attached. Start again from the sign-in screen."
          action={<Button icon={icon.chevronBack} title="Back to sign in" onPress={back} />}
        />
      </Screen>
    );
  }

  return (
    <Screen scroll={false}>
      <Card>
        <SectionHeading
          glyph={icon.near}
          title="Signing you in"
          hint="Your wallet signed the message. Checking it on NEAR."
        />
        <Skeleton height={20} width="64%" />
        <Skeleton height={20} width="40%" />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.sm, alignSelf: 'stretch' },
});
