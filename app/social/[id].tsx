import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { SectionHeading } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { useMascotToast } from '@/components/ui/mascot-toast';
import { IS_WEB } from '@/lib/config';
import { useMoney } from '@/lib/money-context';
import { payNearSputnikCall } from '@/lib/near';
import {
  useBounty,
  useClaimSocialBounty,
  useDecideSocialClaim,
  useGroup,
  usePrepareBountyPayout,
  usePreviewBountyPayout,
  useRecordBountyPayoutTx,
  useSubmitSocialClaim,
  useSyncBountyPayout,
} from '@/lib/queries';
import type { PayoutTier, SocialPayoutPlan } from '@/lib/types';

/** How each tier reads in the payout card. */
const TIER_LABEL: Record<PayoutTier, string> = {
  auto: 'Auto-approved',
  council_one: 'One council approval',
  dao: 'Full DAO vote',
};

/**
 * Bounty detail: the reward in fiat and in its NEAR asset, then whatever the
 * claim is waiting on — a submission, the council's answer, or the wallet step
 * that turns an approved claim into a Sputnik proposal. Nothing here signs
 * anything; the proposal leaves as an unsigned transaction.
 */
export default function BountyScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const detail = useBounty(id);
  const bounty = detail.data?.bounty;
  const group = useGroup(bounty?.groupId ?? '');
  const money = useMoney();
  const notify = useMascotToast();

  const claim = useClaimSocialBounty(id);
  const submit = useSubmitSocialClaim(id);
  const decide = useDecideSocialClaim(id);
  const preview = usePreviewBountyPayout(id);
  const prepare = usePrepareBountyPayout(id, bounty?.groupId ?? '');
  const record = useRecordBountyPayoutTx(id);
  const sync = useSyncBountyPayout(id, bounty?.groupId ?? '');

  const [note, setNote] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [decisionNote, setDecisionNote] = useState('');
  const [plan, setPlan] = useState<SocialPayoutPlan | null>(null);
  const [signing, setSigning] = useState(false);
  const [frozen, setFrozen] = useState<{ payoutId: string } | null>(null);
  const [txHash, setTxHash] = useState('');
  const [syncingId, setSyncingId] = useState<string | null>(null);

  const claims = detail.data?.claims ?? [];
  const payouts = detail.data?.payouts ?? [];
  const events = detail.data?.events ?? [];
  const me = group.data?.me;
  const isCouncil = me?.role === 'owner' || me?.role === 'fronter';

  const mine = claims.find((row) => row.memberId === me?.id && row.status !== 'rejected');
  const approved = claims.find((row) => row.status === 'approved');
  const waitingOnCouncil = isCouncil
    ? claims.filter((row) => row.status === 'submitted')
    : [];

  function explain(cause: unknown, fallback: string) {
    return cause instanceof Error ? cause.message : fallback;
  }

  async function onClaim() {
    try {
      await claim.mutateAsync();
      notify({ title: 'Claimed', body: 'File the note and the evidence when the work is done.' });
    } catch (cause) {
      notify({ title: 'Could not claim it', body: explain(cause, 'Try again in a moment.') });
    }
  }

  async function onSubmit() {
    const cleanNote = note.trim();
    if (!cleanNote) {
      notify({ title: 'Say what you did', body: 'A note is what the council reads.' });
      return;
    }
    try {
      await submit.mutateAsync({
        note: cleanNote,
        evidenceUrl: evidenceUrl.trim() || undefined,
      });
      setNote('');
      setEvidenceUrl('');
      notify({ title: 'Sent for review', body: 'The council has been asked to decide.' });
    } catch (cause) {
      notify({ title: 'Could not submit', body: explain(cause, 'Try again in a moment.') });
    }
  }

  async function onDecide(claimId: string, decision: 'approve' | 'reject') {
    try {
      await decide.mutateAsync({
        claimId,
        decision,
        note: decisionNote.trim() || undefined,
      });
      setDecisionNote('');
      setPlan(null);
      notify({
        title: decision === 'approve' ? 'Approved' : 'Rejected',
        body:
          decision === 'approve'
            ? 'The payout step is open now.'
            : 'The claim is closed and the bounty is back with the council.',
      });
    } catch (cause) {
      notify({ title: 'Could not record it', body: explain(cause, 'Try again in a moment.') });
    }
  }

  async function onPreview(claimId: string) {
    try {
      const next = await preview.mutateAsync(claimId);
      setPlan(next);
    } catch (cause) {
      notify({ title: 'Could not read the policy', body: explain(cause, 'Try again in a moment.') });
    }
  }

  /** Web: the wallet popup covers the proposal; the hash comes back to record. */
  async function onProposeWithWallet(claimId: string) {
    setSigning(true);
    try {
      const outcome = await payNearSputnikCall({ bountyId: id, claimId });
      if (outcome.status === 'cancelled') return;
      if (outcome.status === 'error') {
        notify({ title: 'Proposal not sent', body: outcome.message });
        return;
      }
      await record.mutateAsync({ payoutId: outcome.payoutId, txHash: outcome.txHash });
      setPlan(null);
      notify({
        title: 'Proposal broadcast',
        body: 'Sync the payout once the DAO executes the proposal.',
      });
    } catch (cause) {
      notify({ title: 'Could not record it', body: explain(cause, 'Try again in a moment.') });
    } finally {
      setSigning(false);
    }
  }

  /** Native: freeze the payout, sign in a wallet, then paste the hash back. */
  async function onFreeze(claimId: string) {
    try {
      const prepared = await prepare.mutateAsync(claimId);
      setFrozen({ payoutId: prepared.payout.id });
      setPlan(null);
      notify({
        title: 'Payout frozen',
        body: 'Sign the proposal in your wallet, then paste the hash below.',
      });
    } catch (cause) {
      notify({ title: 'Could not prepare it', body: explain(cause, 'Try again in a moment.') });
    }
  }

  async function onRecordNative() {
    if (!frozen) return;
    const clean = txHash.trim();
    if (!clean) return;
    try {
      await record.mutateAsync({ payoutId: frozen.payoutId, txHash: clean });
      setTxHash('');
      setFrozen(null);
      notify({ title: 'Hash recorded', body: 'Sync the payout once the DAO executes it.' });
    } catch (cause) {
      notify({ title: 'Could not record it', body: explain(cause, 'Try again in a moment.') });
    }
  }

  async function onSync(payoutId: string) {
    setSyncingId(payoutId);
    try {
      const next = await sync.mutateAsync(payoutId);
      notify({
        title: next.status === 'executed' ? 'Paid' : 'Still pending',
        body:
          next.status === 'executed'
            ? 'The claim is settled and the claimer\u2019s trust went up.'
            : next.failureReason ?? 'The DAO has not executed that proposal yet.',
      });
    } catch (cause) {
      notify({ title: 'Sync failed', body: explain(cause, 'The chain did not answer.') });
    } finally {
      setSyncingId(null);
    }
  }

  if (detail.isLoading) {
    return (
      <Screen scroll={false} header={{ title: 'Bounty', back: true }}>
        <View style={styles.list}>
          <Skeleton height={120} />
          <Skeleton height={64} />
          <Skeleton height={64} />
        </View>
      </Screen>
    );
  }

  if (detail.error || !bounty) {
    return (
      <Screen scroll={false} header={{ title: 'Bounty', back: true }}>
        <EmptyState
          icon={icon.warning}
          title="Could not open this bounty"
          body={detail.error?.message ?? 'It may have been removed.'}
          action={
            <Button
              variant="secondary"
              compact
              icon={icon.refresh}
              title="Try again"
              onPress={() => detail.refetch()}
            />
          }
        />
      </Screen>
    );
  }

  const settled = bounty.status === 'paid' || bounty.status === 'cancelled';

  return (
    <Screen
      header={{
        title: bounty.title,
        subtitle: `${bounty.category} · ${bounty.status}`,
        back: true,
      }}
      bottomInset={space.xl}
    >
      <Card tone="accent" enter={1}>
        <Text variant="caption" tone="muted">
          Reward
        </Text>
        <Text variant="display">{bounty.amountDisplay}</Text>
        <Text variant="mono" tone="accent">
          {bounty.chainDisplay} {bounty.chainSymbol}
        </Text>
        <View style={styles.metaRow}>
          <Text variant="caption" tone="muted">
            {bounty.treasuryLabel ?? 'No DAO linked'}
          </Text>
          <Text variant="caption" tone="muted">
            {bounty.deadline
              ? `Due ${new Date(bounty.deadline).toLocaleDateString()}`
              : 'No deadline'}
          </Text>
        </View>
        {bounty.daoAccount ? (
          <Text variant="mono" tone="dim">
            {bounty.daoAccount}
          </Text>
        ) : null}
      </Card>

      {bounty.description ? (
        <Card enter={2}>
          <Text variant="body">{bounty.description}</Text>
        </Card>
      ) : null}

      {!settled ? (
        <>
          <SectionHeading glyph={icon.hand} title="Your part" hint="Claim it, do it, file it." />

          {!mine && bounty.status === 'open' ? (
            <Button
              title="Claim this bounty"
              icon={icon.hand}
              loading={claim.isPending}
              disabled={claim.isPending}
              onPress={onClaim}
            />
          ) : null}

          {mine?.status === 'claimed' ? (
            <Card tone="alt">
              <Field
                label="What you did"
                value={note}
                onChangeText={setNote}
                placeholder="A line the council can judge"
                multiline
              />
              <Field
                label="Evidence link"
                hint="A public link to the work — a folder, a post, a photo."
                value={evidenceUrl}
                onChangeText={setEvidenceUrl}
                placeholder="https://"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Button
                title="Submit for review"
                icon={icon.send}
                loading={submit.isPending}
                disabled={submit.isPending}
                onPress={onSubmit}
              />
            </Card>
          ) : null}

          {mine?.status === 'submitted' ? (
            <Card tone="alt">
              <Text variant="label">Waiting for the council</Text>
              <Text variant="caption" tone="muted">
                Your note and evidence are in. The council approves or rejects next.
              </Text>
            </Card>
          ) : null}

          {waitingOnCouncil.length > 0 ? (
            <Card>
              <Text variant="label">Council decision</Text>
              <Field
                label="Note"
                hint="Optional. It is stored with the decision."
                value={decisionNote}
                onChangeText={setDecisionNote}
                placeholder="Why this call"
              />
              {waitingOnCouncil.map((row) => (
                <View key={row.id} style={styles.decisionRow}>
                  <Text variant="caption" tone="muted">
                    {row.memberName ?? 'A member'} · {row.note}
                  </Text>
                  {row.evidenceUrl ? (
                    <Pressable
                      accessibilityRole="link"
                      onPress={() => void Linking.openURL(row.evidenceUrl as string)}
                    >
                      <Text variant="caption" tone="accent">
                        Open the evidence
                      </Text>
                    </Pressable>
                  ) : null}
                  <View style={styles.decisionButtons}>
                    <Button
                      variant="secondary"
                      compact
                      icon={icon.check}
                      title="Approve"
                      loading={decide.isPending}
                      disabled={decide.isPending}
                      onPress={() => onDecide(row.id, 'approve')}
                    />
                    <Button
                      variant="danger"
                      compact
                      icon={icon.close}
                      title="Reject"
                      disabled={decide.isPending}
                      onPress={() => onDecide(row.id, 'reject')}
                    />
                  </View>
                </View>
              ))}
            </Card>
          ) : null}
        </>
      ) : null}

      {approved && isCouncil && !settled ? (
        <>
          <SectionHeading
            glyph={icon.shield}
            title="Payout"
            hint="The DAO proposal the wallet signs. Money only moves when the DAO executes it."
          />

          {plan ? (
            <Card tone="alt">
              <View style={styles.planRow}>
                <Text variant="label">{TIER_LABEL[plan.tier]}</Text>
                <Text variant="caption" tone="muted">
                  {plan.role.requiredApprovals} approval
                  {plan.role.requiredApprovals === 1 ? '' : 's'} needed
                </Text>
              </View>
              <Text variant="caption" tone="muted">
                {plan.reason}
              </Text>
              <View style={styles.planMetrics}>
                <Metric label="Trust" value={String(plan.trustScore)} />
                <Metric
                  label="Headroom"
                  value={money.format(plan.headroomMinor, plan.currency)}
                />
                <Metric label="Signer" value={plan.signerAccount} />
              </View>
              {!plan.canPrepare ? (
                <Text variant="caption" tone="warn">
                  The DAO cannot propose this yet. Check the roles and the period cap, then sync
                  the policy on the board.
                </Text>
              ) : IS_WEB ? (
                <Button
                  title="Open wallet & propose"
                  icon={icon.near}
                  loading={signing}
                  disabled={signing}
                  onPress={() => onProposeWithWallet(plan.claimId)}
                />
              ) : (
                <Button
                  title="Freeze payout"
                  icon={icon.lock}
                  loading={prepare.isPending}
                  disabled={prepare.isPending}
                  onPress={() => onFreeze(plan.claimId)}
                />
              )}
            </Card>
          ) : (
            <Button
              variant="secondary"
              title="Preview the payout"
              icon={icon.chart}
              loading={preview.isPending}
              disabled={preview.isPending}
              onPress={() => onPreview(approved.id)}
            />
          )}

          {frozen ? (
            <Card tone="alt">
              <Field
                label="Proposal transaction hash"
                hint="Copy it from your wallet right after signing. Globie only reads the chain."
                value={txHash}
                onChangeText={setTxHash}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                placeholder="2YbZa…"
                returnKeyType="done"
                onSubmitEditing={() => void onRecordNative()}
              />
              <Button
                title="Record the hash"
                compact
                icon={icon.check}
                loading={record.isPending}
                disabled={txHash.trim().length === 0 || record.isPending}
                onPress={() => void onRecordNative()}
              />
            </Card>
          ) : null}
        </>
      ) : null}

      {payouts.length > 0 ? (
        <>
          <SectionHeading glyph={icon.cash} title="Payouts" hint="Read from the DAO, not promised." />
          <View style={styles.list}>
            {payouts.map((payout, index) => (
              <Card key={payout.id} tone="alt" enter={index}>
                <View style={styles.payoutRow}>
                  <View style={styles.grow}>
                    <Text variant="label">
                      {payout.chainDisplay} {payout.chainSymbol}
                    </Text>
                    <Text variant="caption" tone="muted">
                      {TIER_LABEL[payout.tier]} · {payout.status}
                      {payout.proposalId ? ` · proposal ${payout.proposalId}` : ''}
                    </Text>
                  </View>
                  <Button
                    variant="ghost"
                    compact
                    icon={icon.sync}
                    title="Sync"
                    loading={syncingId === payout.id}
                    disabled={syncingId !== null}
                    onPress={() => onSync(payout.id)}
                  />
                </View>
                {payout.failureReason ? (
                  <Text variant="caption" tone="danger">
                    {payout.failureReason}
                  </Text>
                ) : null}
                {payout.explorerUrl ? (
                  <Pressable
                    accessibilityRole="link"
                    onPress={() => void Linking.openURL(payout.explorerUrl as string)}
                  >
                    <Text variant="caption" tone="accent">
                      Open on the explorer
                    </Text>
                  </Pressable>
                ) : null}
              </Card>
            ))}
          </View>
        </>
      ) : null}

      {claims.length > 0 ? (
        <>
          <SectionHeading glyph={icon.people} title="Claims" hint="Who put a hand up, and what came of it." />
          <View style={styles.list}>
            {claims.map((row) => (
              <Card key={row.id} tone="alt">
                <View style={styles.payoutRow}>
                  <Text variant="label">{row.memberName ?? 'A member'}</Text>
                  <Text variant="caption" tone="muted">
                    {row.status}
                  </Text>
                </View>
                <Text variant="caption" tone="muted">
                  {row.note}
                </Text>
                {row.decisionNote ? (
                  <Text variant="caption" tone="dim">
                    Council: {row.decisionNote}
                  </Text>
                ) : null}
              </Card>
            ))}
          </View>
        </>
      ) : null}

      {events.length > 0 ? (
        <>
          <SectionHeading glyph={icon.time} title="History" />
          <View style={styles.list}>
            {events.map((event) => (
              <View key={event.id} style={styles.eventRow}>
                <View style={styles.dot} />
                <View style={styles.grow}>
                  <Text variant="caption">{event.summary}</Text>
                  <Text variant="caption" tone="dim">
                    {new Date(event.createdAt).toLocaleString()}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </>
      ) : null}

      <Button
        variant="ghost"
        compact
        icon={icon.chevronBack}
        title="Back to the board"
        onPress={() =>
          router.replace({
            pathname: '/social/board/[group]',
            params: { group: bounty.groupId },
          })
        }
      />
    </Screen>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="mono" numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.sm },
  grow: { flex: 1, gap: 2 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  decisionRow: { gap: space.xs, marginTop: space.sm },
  decisionButtons: { flexDirection: 'row', gap: space.sm },
  planRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space.md },
  planMetrics: { flexDirection: 'row', gap: space.md },
  metric: { flex: 1, gap: 1 },
  payoutRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  eventRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  dot: {
    width: 6,
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    marginTop: 6,
  },
});
