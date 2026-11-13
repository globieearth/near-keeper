import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { TxReceipt } from '@/components/ledger/tx-receipt';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Icon, icon, type IconName } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { useMoney } from '@/lib/money-context';
import type { Share } from '@/lib/types';

const statusCopy: Record<Share['status'], string> = {
  proposed: 'Waiting on you',
  confirmed: 'You confirmed this share',
  requested: 'Payment requested',
  paid: 'Paid',
  settled: 'Settled',
  disputed: 'Disputed',
  failed: 'Didn\u2019t go through, nothing was charged',
  refunded: 'Refunded',
};

const statusTone: Record<Share['status'], 'muted' | 'accent' | 'danger'> = {
  proposed: 'muted',
  confirmed: 'muted',
  requested: 'muted',
  paid: 'accent',
  settled: 'accent',
  disputed: 'danger',
  failed: 'danger',
  refunded: 'muted',
};

/** One glyph per state, so a share is readable before the words are. */
const statusGlyph: Record<Share['status'], IconName> = {
  proposed: icon.time,
  confirmed: icon.check,
  requested: icon.send,
  paid: icon.checkCircle,
  settled: icon.checkCircle,
  disputed: icon.alert,
  failed: icon.alert,
  refunded: icon.refresh,
};

export function ShareRow({
  share,
  onPress,
  onPay,
  onPrepare,
  onSettle,
  settling = false,
}: {
  share: Share;
  onPress?: () => void;
  /** Web: the wallet signs in a popup, so one tap settles the share. */
  onPay?: () => void;
  /** Native: fetch the recipient and memo, since the share may not have them. */
  onPrepare?: () => Promise<void>;
  /** Native: the rail wants a pasted NEP-141 transfer hash instead of a link. */
  onSettle?: (txHash: string) => void;
  settling?: boolean;
}) {
  const settled = share.status === 'paid' || share.status === 'settled';
  const tone = statusTone[share.status];
  const tint = tone === 'accent' ? colors.accent : tone === 'danger' ? colors.danger : colors.mutedDim;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [nearOpen, setNearOpen] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [txHash, setTxHash] = useState('');
  const [copied, setCopied] = useState(false);
  const money = useMoney();
  // A share is what the member will be charged, so the canonical amount keeps
  // its place under the conversion (§2.19).
  const approx = money.approximate(share.amountMinor, share.currency);
  // The server sends these once the fronter asked for the money on NEAR, so the
  // payer never has to be told the amount and memo out of band.
  const near = share.payTo && share.chainAmount ? share : null;

  const copy = (
    <View style={styles.copy}>
      <View style={styles.line}>
        <View style={[styles.disc, tone === 'danger' && styles.discDanger]}>
          <Icon name={statusGlyph[share.status]} size={15} color={tint} />
        </View>
        <Text variant="label" style={styles.flex} numberOfLines={1}>
          {share.groupName ?? 'Group'}
        </Text>
        {onPress ? <Icon name={icon.chevronRight} size={15} color={colors.mutedDim} /> : null}
      </View>
      <Text variant="caption" tone={tone}>
        {statusCopy[share.status]}
        {share.dueAt ? `, due ${new Date(share.dueAt).toLocaleDateString()}` : ''}
      </Text>
    </View>
  );

  const submitNear = () => {
    const hash = txHash.trim();
    if (!hash || !onSettle) return;
    onSettle(hash);
  };

  const toggleNear = () => {
    if (nearOpen) {
      setNearOpen(false);
      return;
    }
    if (near || !onPrepare) {
      setNearOpen(true);
      return;
    }
    // The share has no recipient or memo yet: ask for them before opening a
    // panel that would otherwise have nothing to show.
    setPreparing(true);
    void onPrepare()
      .then(() => setNearOpen(true))
      .catch(() => undefined)
      .finally(() => setPreparing(false));
  };

  return (
    <View style={styles.stack}>
      <View style={styles.row}>
        {onPress ? (
          // one interactive surface per row: the copy navigates, the Pay button pays
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${share.groupName ?? 'group'}`}
            onPress={onPress}
            onHoverIn={() => setHovered(true)}
            onHoverOut={() => setHovered(false)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            style={({ pressed }) => [
              styles.hit,
              hovered && styles.hitHovered,
              pressed && styles.hitPressed,
              focused && styles.hitFocused,
            ]}
          >
            {copy}
          </Pressable>
        ) : (
          <View style={styles.hit}>{copy}</View>
        )}

        <View style={styles.amount}>
          <Text variant="mono" tone={settled ? 'accent' : 'default'}>
            {money.format(share.amountMinor, share.currency)}
          </Text>
          {approx ? (
            <Text variant="caption" tone="dim" style={styles.amountNote}>
              {money.formatOriginal(share.amountMinor, share.currency)}
            </Text>
          ) : null}
        </View>
        {onPay ? (
          <Button
            title={near ? `Pay ${near.chainAmount} USDC` : 'Pay on NEAR'}
            compact
            icon={icon.near}
            loading={settling}
            disabled={settled || settling}
            onPress={onPay}
          />
        ) : onSettle ? (
          <Button
            title="Pay on NEAR"
            compact
            variant={nearOpen ? 'secondary' : 'primary'}
            icon={icon.near}
            loading={preparing}
            disabled={settled || preparing}
            onPress={toggleNear}
          />
        ) : null}
      </View>

      {settled && share.settlementTxHash ? (
        <TxReceipt txHash={share.settlementTxHash} />
      ) : share.status === 'settled' ? (
        // The fronter's own share is `settled` by construction: they handed the
        // merchant cash, so it was never owed and no transfer exists to verify.
        <Text variant="caption" tone="dim" style={styles.advance}>
          Paid at the merchant. This share was never owed, so there is no transfer to verify.
        </Text>
      ) : null}

      {onSettle && nearOpen ? (
        <View style={styles.settle}>
          {near ? (
            <View style={styles.brief}>
              <Text variant="caption" tone="dim">
                Send this from your own NEAR wallet
              </Text>
              <Text variant="mono">
                {near.chainAmount} USDC to {near.payTo}
              </Text>
              {near.quoteRate ? (
                <Text variant="caption" tone="dim">
                  Locked at 1 {share.currency} = ${near.quoteRate.toFixed(4)}
                </Text>
              ) : null}
              {near.memo ? (
                <View style={styles.memoRow}>
                  <Text variant="caption" tone="dim" style={styles.flex} numberOfLines={1}>
                    Memo: {near.memo}
                  </Text>
                  <Button
                    title={copied ? 'Copied' : 'Copy memo'}
                    compact
                    variant="ghost"
                    icon={icon.copy}
                    onPress={() => {
                      void Clipboard.setStringAsync(near.memo ?? '');
                      setCopied(true);
                    }}
                  />
                </View>
              ) : null}
            </View>
          ) : null}
          <Field
            label="NEAR transaction hash"
            hint="Copy it from your wallet right after the transfer. Globie only reads the chain."
            value={txHash}
            onChangeText={setTxHash}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            placeholder="2YbZa…"
            returnKeyType="done"
            onSubmitEditing={submitNear}
          />
          <View style={styles.settleActions}>
            <Button
              title="Confirm payment"
              compact
              icon={icon.check}
              loading={settling}
              disabled={txHash.trim().length === 0 || settling}
              onPress={submitNear}
            />
            <Button
              title="Cancel"
              compact
              variant="ghost"
              disabled={settling}
              onPress={() => {
                setNearOpen(false);
                setTxHash('');
              }}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.xs,
    paddingHorizontal: space.xs,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceAlt,
  },
  hit: {
    flex: 1,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
  },
  hitHovered: { backgroundColor: colors.surfaceHi },
  hitPressed: { backgroundColor: colors.surface },
  hitFocused: { outlineWidth: 2, outlineColor: colors.focus, outlineOffset: 1 },
  copy: { gap: space.xs },
  amount: { alignItems: 'flex-end' },
  amountNote: { textAlign: 'right' },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  flex: { flex: 1 },
  disc: {
    width: 26,
    height: 26,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  discDanger: { backgroundColor: colors.dangerWash, borderColor: 'rgba(255, 107, 107, 0.3)' },
  settle: {
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  settleActions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  brief: { gap: space.xs },
  memoRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  advance: { paddingHorizontal: space.sm, paddingBottom: space.xs },
});
