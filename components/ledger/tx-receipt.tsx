import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Icon, icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { colors, radius, space, type } from '@/components/ui/theme';
import { nearTxUrl } from '@/lib/near';
import { useNearStatus } from '@/lib/queries';

/** `2YbZa…9QkL` — enough to match a hash by eye, short enough for a ledger row. */
function shortHash(txHash: string): string {
  return txHash.length <= 13 ? txHash : `${txHash.slice(0, 6)}\u2026${txHash.slice(-4)}`;
}

/**
 * The receipt for one settled transfer. Collapsed it is a single strip under the
 * transaction it belongs to; expanded it hands over the full hash and the
 * explorer link, so a member can check the chain without trusting the app.
 *
 * It reads the explorer base from `/near/status`, which every screen already
 * queries, so a caller only has to know the hash.
 */
export function TxReceipt({ txHash }: { txHash: string }) {
  const rail = useNearStatus();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const explorerUrl = rail.data?.explorerUrl;

  // Nothing to link to until the rail is configured — no dead strip.
  if (!explorerUrl) return null;

  const toggle = () => {
    setOpen((value) => !value);
    setCopied(false);
  };

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`On-chain receipt ${shortHash(txHash)}. ${
          open ? 'Hide' : 'Show'
        } the explorer link.`}
        accessibilityState={{ expanded: open }}
        onPress={toggle}
        style={({ pressed }) => [styles.summary, pressed && styles.summaryPressed]}
      >
        <Icon name={icon.link} size={13} color={colors.accentText} />
        <Text variant="caption" tone="accent" style={styles.flex} numberOfLines={1}>
          Verified on chain
        </Text>
        <Text variant="caption" tone="muted" style={styles.hash} numberOfLines={1}>
          {shortHash(txHash)}
        </Text>
        <View style={open ? styles.chevronOpen : styles.chevron}>
          <Icon name={icon.chevronDown} size={13} color={colors.mutedDim} />
        </View>
      </Pressable>

      {open ? (
        <View style={styles.panel}>
          <Text variant="caption" tone="muted" selectable style={styles.full}>
            {txHash}
          </Text>
          <View style={styles.actions}>
            <Button
              title={copied ? 'Copied' : 'Copy hash'}
              compact
              variant="ghost"
              icon={icon.copy}
              onPress={() => {
                void Clipboard.setStringAsync(txHash);
                setCopied(true);
              }}
            />
            <Button
              title="View on NEAR"
              compact
              variant="secondary"
              icon={icon.link}
              onPress={() => void WebBrowser.openBrowserAsync(nearTxUrl(explorerUrl, txHash))}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xs },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: 6,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    backgroundColor: colors.wash,
  },
  summaryPressed: { backgroundColor: colors.surfaceHi },
  flex: { flex: 1 },
  hash: { fontFamily: type.mono },
  chevron: { transform: [{ rotate: '0deg' }] },
  chevronOpen: { transform: [{ rotate: '180deg' }] },
  panel: {
    gap: space.sm,
    padding: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  full: { fontFamily: type.mono, lineHeight: 17 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});
