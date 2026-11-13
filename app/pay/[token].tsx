import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SuccessPulse } from '@/components/ui/celebrate';
import { Icon, icon } from '@/components/ui/icon';
import { useMascotToast } from '@/components/ui/mascot-toast';
import { Screen } from '@/components/ui/screen';
import { SectionHeading } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { ApiError, getPayLink } from '@/lib/api';
import { IS_WEB } from '@/lib/config';
import { payNearTransfer } from '@/lib/near';
import { forgetNearNext, rememberNearNext } from '@/lib/near-login';
import { useNearStatus, useSettleFromNear } from '@/lib/queries';
import { useSession } from '@/lib/session-context';
import type { NearSettleResult, PayLinkView } from '@/lib/types';

/**
 * One share's payment instructions, reachable without an account.
 *
 * A forwardable link is the whole point: a payer who will not install the app
 * can still see the amount, the payee and the memo. The page never charges
 * anything on its own — paying opens the visitor's own wallet, which is the
 * only place a transfer can be signed.
 */
export default function PayLinkScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  // The bearer token arrived in the URL, so this read is the one thing the page
  // does; it carries no session and reaches no other bill.
  const link = useQuery({
    queryKey: ['pay-link', token],
    queryFn: () => getPayLink(token ?? ''),
    enabled: Boolean(token),
    retry: false,
  });

  return (
    <Screen
      header={{
        title: 'Pay your share',
        subtitle: link.data ? link.data.billTitle : 'A bill split in Globie Keeper.',
        // A forwarded link is usually the first page; back exists only when the
        // visitor came from inside a stack.
        back: router.canGoBack(),
      }}
      bottomInset={space.xl}
    >
      {link.isLoading ? (
        <>
          <Skeleton height={120} />
          <Skeleton height={180} />
        </>
      ) : link.error ? (
        <Card>
          <SectionHeading
            glyph={icon.alert}
            title="This link does not open"
            hint="It may have been mistyped, or the share it pointed at is gone."
          />
          <Text variant="body" tone="muted">
            {link.error.message}
          </Text>
          <Button
            title="Try again"
            icon={icon.refresh}
            variant="secondary"
            compact
            onPress={() => link.refetch()}
            style={styles.inline}
          />
        </Card>
      ) : link.data ? (
        <PaySheet data={link.data} token={token ?? ''} />
      ) : null}

      <View style={styles.footnote}>
        <Icon name={icon.shield} size={14} color={colors.mutedDim} />
        <Text variant="caption" tone="dim" style={styles.flex}>
          Globie Keeper never holds your money. You sign the transfer in your own wallet, and
          the bill updates only after the chain confirms it.
        </Text>
      </View>
    </Screen>
  );
}

function PaySheet({ data, token }: { data: PayLinkView; token: string }) {
  const notify = useMascotToast();
  const client = useQueryClient();
  const { session, signInWithNear } = useSession();
  // Signed out there is no `/near/status` to read, and no wallet to show.
  const nearRail = useNearStatus(Boolean(session));
  const settleFromNear = useSettleFromNear();

  const [busy, setBusy] = useState<'signin' | 'pay' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState<NearSettleResult | null>(null);

  const paid = data.status === 'paid' || settled !== null;
  const payable = Boolean(data.chainAmount && data.payeeAccount);
  // The wallet popup is a web flow; another platform keeps the manual details.
  const oneTap = IS_WEB && payable;

  const details = [
    `Amount: ${data.amount} ${data.currency}`,
    data.chainAmount ? `Send: ${data.chainAmount} USDC` : null,
    data.payeeAccount ? `To: ${data.payeeAccount}` : null,
    `Memo: ${data.memo}`,
    data.tokenContract ? `Token: ${data.tokenContract}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  async function copyDetails() {
    await Clipboard.setStringAsync(details);
    notify({
      title: 'Payment details copied',
      body: 'Paste them beside the transfer in your wallet.',
    });
  }

  /**
   * The guest clicked pay. A wallet cannot act on a session it does not have,
   * so the page proves the wallet first — and remembers this link, because a
   * wallet that navigates the whole page would otherwise land on the home
   * screen and lose the share.
   */
  async function signInToPay() {
    setBusy('signin');
    setError(null);
    rememberNearNext(`/pay/${token}`);
    const outcome = await signInWithNear();
    // A popup signs in without unloading the page, so nothing will read it.
    if (outcome.status !== 'redirecting') forgetNearNext();
    setBusy(null);
    if (outcome.status === 'error') setError(outcome.message);
  }

  /** One tap: Globie fills the wallet prompt, the wallet signs, the server verifies. */
  async function payNow() {
    if (!data.chainAmount || !data.payeeAccount) return;
    setBusy('pay');
    setError(null);
    try {
      const outcome = await payNearTransfer({
        receiverId: data.payeeAccount,
        amount: data.chainAmount,
        memo: data.memo,
        shareId: data.shareId,
      });
      if (outcome.status === 'cancelled') return;
      if (outcome.status === 'error') {
        setError(outcome.message);
        return;
      }

      const result = await settleFromNear.mutateAsync({
        shareId: data.shareId,
        txHash: outcome.txHash,
      });
      setSettled(result);
      await client.invalidateQueries({ queryKey: ['pay-link', token] });
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
      setError(settleMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Card tone={paid ? 'accent' : 'surface'}>
        <SectionHeading
          glyph={paid ? icon.checkCircle : icon.receipt}
          title={data.billTitle}
          hint={
            paid
              ? 'This share is paid and verified on chain.'
              : 'Your share of a bill someone already paid upfront.'
          }
        />
        <View style={styles.amountRow}>
          <Text variant="display">{data.amount}</Text>
          <Text variant="title" tone="muted">
            {data.currency}
          </Text>
        </View>
        {data.chainAmount ? (
          <Text variant="body" tone="muted">
            {data.chainAmount} USDC to send
          </Text>
        ) : (
          <Text variant="body" tone="muted">
            No transfer amount has been frozen for this share yet. Ask the fronter to request
            it, then open this link again.
          </Text>
        )}
      </Card>

      {paid ? (
        settled ? (
          <Card tone="accent">
            <SuccessPulse
              title={settled.billSettled ? 'Bill settled' : 'Paid on NEAR'}
              amount={`${data.amount} ${data.currency}`}
              body={
                settled.alreadyPaid
                  ? 'That transfer was already recorded. Nothing was counted twice.'
                  : settled.billSettled
                    ? 'Everyone is square. The bill is settled on NEAR.'
                    : `Globie read the transfer on chain.${
                        settled.rank ? ` You were #${settled.rank} to pay.` : ''
                      }`
              }
            />
            <Button
              title="View the transfer"
              icon={icon.link}
              variant="secondary"
              onPress={() => void Linking.openURL(settled.explorerUrl)}
            />
          </Card>
        ) : data.explorerUrl ? (
          <Card>
            <SectionHeading glyph={icon.check} title="Verified on chain" />
            <Button
              title="View the transfer"
              icon={icon.link}
              variant="secondary"
              onPress={() => void Linking.openURL(data.explorerUrl as string)}
            />
          </Card>
        ) : null
      ) : (
        <>
          {oneTap ? (
            <Card tone="accent">
              <SectionHeading
                glyph={icon.near}
                title="Pay in one tap"
                hint={
                  session
                    ? 'Globie opens your wallet with the transfer filled in. You approve it there — nothing is signed for you.'
                    : 'Sign in with the wallet that holds your USDC, then approve one transfer.'
                }
              />
              {session ? (
                <>
                  <Button
                    title={`Pay ${data.chainAmount} USDC`}
                    icon={icon.send}
                    loading={busy === 'pay'}
                    onPress={() => void payNow()}
                  />
                  <Text variant="caption" tone="dim">
                    {nearRail.data?.account ? `Signing as ${nearRail.data.account}. ` : ''}
                    The bill updates only after NEAR confirms the transfer.
                  </Text>
                </>
              ) : (
                <>
                  <Button
                    title="Sign in with NEAR to pay"
                    icon={icon.near}
                    loading={busy === 'signin'}
                    onPress={() => void signInToPay()}
                  />
                  <Text variant="caption" tone="dim">
                    Signing in proves the wallet is yours, so Globie can credit this payment
                    to you.
                  </Text>
                </>
              )}
            </Card>
          ) : null}

          {error ? (
            <View accessibilityLiveRegion="polite" style={styles.errorBox}>
              <View style={styles.errorHead}>
                <Icon name={icon.warning} size={16} color={colors.danger} />
                <Text variant="label" tone="danger">
                  The payment did not go through
                </Text>
              </View>
              <Text variant="caption" tone="danger">
                {error}
              </Text>
            </View>
          ) : null}

          <Card>
            <SectionHeading
              glyph={icon.near}
              title={oneTap ? 'Or send it yourself' : 'Send it from your wallet'}
              hint={
                oneTap
                  ? 'Prefer your own wallet? Copy these details across.'
                  : 'Open your NEAR wallet, start a USDC transfer, and copy these details across.'
              }
            />
            <Row label="Pay to" value={data.payeeAccount ?? 'Not set yet'} mono />
            <Row
              label="Amount"
              value={data.chainAmount ? `${data.chainAmount} USDC` : 'Not requested yet'}
              mono
            />
            <Row label="Memo" value={data.memo} mono />
            {data.tokenContract ? (
              <Row label="Token contract" value={data.tokenContract} mono tone="dim" />
            ) : null}
            <Button
              title="Copy payment details"
              icon={icon.copy}
              onPress={copyDetails}
              disabled={!data.chainAmount || !data.payeeAccount}
              style={styles.inline}
            />
            <Text variant="caption" tone="dim">
              The memo is how the bill finds your payment. Without it the transfer arrives,
              but nothing settles.
            </Text>
          </Card>
        </>
      )}
    </>
  );
}

/**
 * A transfer can only settle the share of the member who owes it, so signing in
 * with someone else's account fails after the money has already moved. Say that
 * plainly instead of repeating the API's 403.
 */
function settleMessage(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 403) {
    return 'This pay link belongs to a different Globie account. Sign in with the account that owes this share — otherwise send the transfer yourself with the details below.';
  }
  return cause instanceof Error ? cause.message : 'Could not verify the transfer';
}

function Row({
  label,
  value,
  mono,
  tone = 'default',
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'default' | 'dim';
}) {
  return (
    <View style={styles.row}>
      <Text variant="caption" tone="muted" style={styles.rowLabel}>
        {label}
      </Text>
      <Text variant={mono ? 'mono' : 'body'} tone={tone} style={styles.flex}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  inline: { alignSelf: 'flex-start' },
  amountRow: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingVertical: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.hairline,
  },
  rowLabel: { width: 104 },
  footnote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingTop: space.sm,
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
});
