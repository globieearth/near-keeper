import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ShareRow } from '@/components/ledger/share-row';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SuccessPulse } from '@/components/ui/celebrate';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon, icon } from '@/components/ui/icon';
import { BabyKaeNa } from '@/components/ui/mascot';
import { useMascotToast } from '@/components/ui/mascot-toast';
import { Screen } from '@/components/ui/screen';
import { SectionHeading } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { ApiError } from '@/lib/api';
import { IS_NATIVE, IS_WEB } from '@/lib/config';
import { useMoney } from '@/lib/money-context';
import { payNearTransfer } from '@/lib/near';
import {
    useMyPoints,
    useMyShares,
    useNearStatus,
    useRequestNearTransfer,
    useSettleFromNear
} from '@/lib/queries';
import type { PendingShare, Share } from '@/lib/types';

type Notice = { text: string; settled: boolean; explorerUrl?: string };

/** A share this member still owes and can act on right now. */
const PAYABLE: Share['status'][] = ['proposed', 'confirmed', 'requested', 'failed'];

/**
 * A confirmed part of a bill the fronter has not locked yet. It is not a share
 * and cannot be paid, but it is the member's money — showing nothing here is
 * what makes a correct confirmation look lost.
 */
function PendingRow({ row, onPress }: { row: PendingShare; onPress: () => void }) {
  const money = useMoney();
  const amount = money.format(row.amountMinor, row.currency);
  const who = row.frontedBy ?? 'the fronter';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        row.isFronter
          ? `${row.merchant ?? row.groupName}, ${amount} confirmed. Lock the split to collect.`
          : `${row.merchant ?? row.groupName}, ${amount} confirmed by you, waiting for ${who} to lock the split.`
      }
      onPress={onPress}
      style={({ pressed }) => [styles.pending, pressed && styles.pendingPressed]}
    >
      <View style={styles.pendingDisc}>
        <Icon name={icon.time} size={15} color={colors.warn} />
      </View>
      <View style={styles.pendingCopy}>
        <View style={styles.pendingLine}>
          <Text variant="label" style={styles.flex} numberOfLines={1}>
            {row.merchant ?? row.groupName}
          </Text>
          <Text variant="mono">{amount}</Text>
        </View>
        <Text variant="caption" tone="muted">
          {row.isFronter
            ? 'Everyone confirmed — lock the split to turn it into shares.'
            : `Confirmed by you · ${who} still has to lock the split.`}
        </Text>
      </View>
      <Icon name={icon.chevronRight} size={15} color={colors.mutedDim} />
    </Pressable>
  );
}

export default function MySharesScreen() {
  const shares = useMyShares();
  const points = useMyPoints();
  const nearRail = useNearStatus();
  const requestTransfer = useRequestNearTransfer();
  const settleFromNear = useSettleFromNear();
  const notify = useMascotToast();
  const money = useMoney();

  const [settling, setSettling] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const all = shares.data?.shares ?? [];
  const pending = shares.data?.pending ?? [];
  const currency = shares.data?.currency ?? 'THB';
  const noticeUrl = notice?.explorerUrl ?? null;

  /**
   * The member paid from their own wallet, so the app never signs. It sends the
   * hash and the API reads the receipt on chain before crediting the share.
   */
  async function recordSettlement(share: Share, txHash: string) {
    setSettling(share.id);
    setError(null);
    setNotice(null);
    try {
      const result = await settleFromNear.mutateAsync({ shareId: share.id, txHash });
      setNotice({
        text: result.alreadyPaid
          ? 'That transfer was already recorded. Nothing was counted twice.'
          : result.billSettled
            ? 'Everyone is square. The bill is settled on NEAR.'
            : `Paid on NEAR. +${result.pointsAwarded} Globie${
                result.rank ? `. You were #${result.rank} to pay.` : '.'
              }`,
        settled: result.billSettled,
        explorerUrl: result.explorerUrl,
      });
      notify(
        result.billSettled
          ? { title: 'Bill settled', body: 'Everyone is square.' }
          : {
              title: 'Paid on NEAR',
              body: result.rank
                ? `You were #${result.rank} to pay.`
                : 'Globie read the transfer on chain.',
              points: result.pointsAwarded,
            }
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('Could not verify the transfer'));
    } finally {
      setSettling(null);
    }
  }

  /** Native: fetch the recipient and memo before showing the paste-hash panel. */
  async function prepareShare(share: Share) {
    setError(null);
    try {
      await requestTransfer.mutateAsync({ shareId: share.id });
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('Could not prepare the payment'));
      throw cause;
    }
  }

  /**
   * Web: the wallet opens over this screen and signs the transfer, so the hash
   * comes back on its own. Nothing to copy, and no trip to a separate wallet.
   */
  async function payShare(share: Share) {
    setSettling(share.id);
    setError(null);
    setNotice(null);
    try {
      // A share nobody has chased yet carries no recipient. Minting the
      // instruction here is what gives a `proposed` share a Pay button at all —
      // the payer must not have to wait for the fronter.
      let payTo = share.payTo;
      let chainAmount = share.chainAmount;
      let memo = share.memo;
      if (!payTo || !chainAmount) {
        const quote = await requestTransfer.mutateAsync({ shareId: share.id });
        payTo = quote.payTo;
        chainAmount = quote.chainAmount;
        memo = quote.memo;
      }
      const outcome = await payNearTransfer({
        receiverId: payTo,
        amount: chainAmount,
        memo,
      });
      if (outcome.status === 'cancelled') return;
      if (outcome.status === 'error') {
        setError(new Error(outcome.message));
        return;
      }
      await recordSettlement(share, outcome.txHash);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('Could not open the payment'));
    } finally {
      setSettling(null);
    }
  }

  return (
    <Screen
      header={{
        title: 'Shares',
        subtitle: `${points.data?.balance ?? 0} Globie earned so far`,
      }}
    >
      <Card tone="accent">
        <View style={styles.heroRow}>
          <View style={styles.heroCopy}>
            <Text variant="label" tone="muted">
              Outstanding
            </Text>
            <Text variant="figure">
              {money.format(shares.data?.outstandingMinor ?? 0, currency)}
            </Text>
            <Text variant="caption" tone="muted">
              {money.approximate(shares.data?.outstandingMinor ?? 0, currency)
                ? `${money.formatOriginal(shares.data?.outstandingMinor ?? 0, currency)} · `
                : ''}
              {all.length} open {all.length === 1 ? 'share' : 'shares'}
              {pending.length > 0
                ? ` · ${pending.length} confirmed, waiting for the lock`
                : ''}
            </Text>
          </View>
          <View style={styles.heroGlyph}>
            <BabyKaeNa size={56} variant="face" label={null} />
          </View>
        </View>
      </Card>

      {notice?.settled ? (
        <Card>
          <SuccessPulse title="All settled" body={notice.text} />
          {noticeUrl ? (
            <Button
              variant="secondary"
              compact
              icon={icon.near}
              title="View on NEAR"
              onPress={() => void WebBrowser.openBrowserAsync(noticeUrl)}
              style={styles.inline}
            />
          ) : null}
        </Card>
      ) : notice ? (
        <View accessibilityLiveRegion="polite" style={styles.notice}>
          <Icon name={icon.sparkles} size={16} color={colors.accent} />
          <Text variant="body" tone="accent" style={styles.flex}>
            {notice.text}
          </Text>
          {noticeUrl ? (
            <Button
              variant="ghost"
              compact
              icon={icon.near}
              title="View on NEAR"
              onPress={() => void WebBrowser.openBrowserAsync(noticeUrl)}
            />
          ) : null}
        </View>
      ) : null}

      {error ? (
        <View accessibilityLiveRegion="polite" style={styles.errorBox}>
          <View style={styles.errorHead}>
            <Icon name={icon.warning} size={16} color={colors.danger} />
            <Text variant="label" tone="danger">
              {error instanceof ApiError && error.code === 'network_error'
                ? 'Could not reach Globie Keeper'
                : 'The payment did not go through'}
            </Text>
          </View>
          <Text variant="caption" tone="danger">
            {error.message}
          </Text>
        </View>
      ) : null}

      {pending.length > 0 ? (
        <View style={styles.pendingSection}>
          <SectionHeading
            glyph={icon.time}
            title="Confirmed, not locked yet"
            hint={
              pending.some((row) => row.isFronter)
                ? 'You fronted this — lock the split to turn it into shares.'
                : 'Your part is on record. It becomes payable once the fronter locks the split.'
            }
          />
          <View style={styles.list}>
            {pending.map((row) => (
              <PendingRow
                key={row.billId}
                row={row}
                onPress={() =>
                  router.push({
                    pathname: '/groups/[id]/bill',
                    params: { id: row.groupId, billId: row.billId },
                  })
                }
              />
            ))}
          </View>
        </View>
      ) : null}

      {shares.isLoading ? (
        <View style={styles.list} accessibilityElementsHidden>
          <Skeleton height={68} />
          <Skeleton height={68} />
        </View>
      ) : shares.error ? (
        <Card>
          <Text variant="title">Could not load your shares</Text>
          <Text variant="body" tone="muted">
            {shares.error.message}
          </Text>
          <Button
            variant="secondary"
            compact
            icon={icon.refresh}
            title="Try again"
            onPress={() => shares.refetch()}
            style={styles.inline}
          />
        </Card>
      ) : all.length === 0 && pending.length === 0 ? (
        <EmptyState
          icon={icon.checkCircle}
          title="Nothing owed either way"
          body="Join a group with an invite code, confirm your part of an expense, and your share shows up here."
        />
      ) : all.length === 0 ? null : (
        <View style={styles.list}>
          {all.map((share) => (
            <ShareRow
              key={share.id}
              share={share}
              settling={settling === share.id}
              onPay={
                IS_WEB && nearRail.data?.configured && PAYABLE.includes(share.status)
                  ? () => void payShare(share)
                  : undefined
              }
              onPrepare={
                IS_NATIVE && nearRail.data?.configured && PAYABLE.includes(share.status)
                  ? () => prepareShare(share)
                  : undefined
              }
              onSettle={
                IS_NATIVE && nearRail.data?.configured && PAYABLE.includes(share.status)
                  ? (txHash) => void recordSettlement(share, txHash)
                  : undefined
              }
              onPress={() => router.push({ pathname: '/groups/[id]', params: { id: share.groupId } })}
            />
          ))}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  heroRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  heroCopy: { flex: 1, gap: space.xs },
  heroGlyph: {
    width: 58,
    height: 58,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: { gap: space.sm },
  pendingSection: { gap: space.sm },
  pending: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceAlt,
  },
  pendingPressed: { backgroundColor: colors.surface },
  pendingDisc: {
    width: 26,
    height: 26,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.warnWash,
  },
  pendingCopy: { flex: 1, gap: 2 },
  pendingLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(110, 240, 190, 0.28)',
    backgroundColor: colors.wash,
  },
  errorBox: {
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.dangerWash,
  },
  errorHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  flex: { flex: 1 },
  inline: { alignSelf: 'flex-start' },
});
