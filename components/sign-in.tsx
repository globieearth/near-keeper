import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { useSession } from '@/lib/session-context';
import { availableWallets, DEFAULT_WALLET_ID, type WalletId } from '@/lib/wallets';
import { Button } from './ui/button';
import { Icon, icon } from './ui/icon';
import { BabyKaeNa } from './ui/mascot';
import { Screen } from './ui/screen';
import { Text } from './ui/text';
import { colors, radius, space } from './ui/theme';
import { enter } from './ui/transitions';

const WALLETS = availableWallets();

export function SignIn() {
  const { signInWithNear } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<WalletId | null>(null);

  async function near(id: WalletId) {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      // Web runs the wallet's own popup handshake; on device the wallet comes
      // back through the deep link first. A redirect wallet leaves the page.
      const outcome = await signInWithNear(id);
      if (outcome.status === 'error') setError(outcome.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not reach the NEAR wallet');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen style={styles.screen}>
      <Animated.View entering={enter.card} style={styles.hero}>
        <BabyKaeNa size={116} halo style={styles.mark} />
        <Text variant="display" style={styles.centered}>
          Globie Keeper
        </Text>
        <Text variant="body" tone="muted" style={styles.centered}>
          Someone fronts the cash. Everyone taps once to agree, once to settle.
        </Text>
      </Animated.View>

      {error ? (
        <View accessibilityLiveRegion="polite" style={styles.errorBox}>
          <View style={styles.errorHead}>
            <Icon name={icon.alert} size={15} color={colors.danger} />
            <Text variant="label" tone="danger">
              That did not sign you in
            </Text>
          </View>
          <Text variant="caption" tone="danger">
            {error}
          </Text>
        </View>
      ) : null}

      <View style={styles.wallets}>
        {WALLETS.map((wallet) => (
          <View key={wallet.id} style={styles.wallet}>
            <Button
              title={wallet.name}
              variant={wallet.id === DEFAULT_WALLET_ID ? 'primary' : 'secondary'}
              icon={icon.shares}
              onPress={() => near(wallet.id)}
              loading={busy === wallet.id}
              disabled={busy !== null && busy !== wallet.id}
            />
            <Text variant="caption" tone="dim">
              {wallet.hint}
            </Text>
          </View>
        ))}
      </View>

      <Text variant="caption" tone="muted" style={styles.centered}>
        No password. Your NEAR wallet signs a message, and the signature signs you in.
      </Text>

      {/* The manual is public, so a visitor can read it before picking a wallet. */}
      <Button
        title="How this works"
        variant="ghost"
        compact
        icon={icon.information}
        onPress={() => router.push('/help')}
        style={styles.help}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  // Sign-in is a form, not a feed: it keeps its own narrow measure in a wide browser.
  screen: { justifyContent: 'center', gap: space.lg, maxWidth: 440 },
  hero: { gap: space.sm, alignItems: 'center', marginBottom: space.sm },
  // the wordmark: Baby Kae Na, the Globie Keeper mascot, leading the sign-in
  mark: { marginBottom: space.xs },
  centered: { textAlign: 'center' },
  help: { alignSelf: 'center' },
  wallets: { gap: space.md },
  wallet: { gap: space.xs },
  errorBox: {
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.dangerWash,
  },
  errorHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});
