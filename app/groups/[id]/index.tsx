import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { GlobieChat } from '@/components/chat/globie-chat';
import { Timeline } from '@/components/chat/timeline';
import { InviteCard } from '@/components/groups/invite-card';
import { SplitVotePanel } from '@/components/groups/split-vote-panel';
import { TxReceipt } from '@/components/ledger/tx-receipt';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { haptics } from '@/components/ui/haptics';
import { Icon, icon } from '@/components/ui/icon';
import { useMascotToast } from '@/components/ui/mascot-toast';
import { Screen } from '@/components/ui/screen';
import { SectionHeading } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { colors, radius, space, type } from '@/components/ui/theme';
import { ApiError, requestAgreementConsent } from '@/lib/api';
import { IS_WEB } from '@/lib/config';
import { formatMinor, toMinor } from '@/lib/money';
import { useMoney } from '@/lib/money-context';
import {
    nearAccountUrl,
    payNearAnchorCall,
    payNearRecordAcceptance,
    signAgreementTerms
} from '@/lib/near';
import {
    useAcceptAgreement,
    useAgreementAcceptances,
    useAnchorAgreement,
    useCloneAgreement,
    useCreateAgreement,
    useGroup,
    useGroupTimeline,
    useNearStatus
} from '@/lib/queries';
import type { Agreement, AgreementConsent } from '@/lib/types';

/** Percent typed by a person → basis points the API stores (2.5 → 250). */
function percentToBps(value: string): number | null {
  const percent = Number(value.replace(',', '.'));
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return Math.round(percent * 100);
}

/** Basis points → the percent a person reads, without trailing zeros. */
function bpsToPercent(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

const statusCopy: Record<Agreement['status'], string> = {
  draft: 'Draft',
  pending: 'Pending',
  accepted: 'Agreed',
  cancelled: 'Cancelled',
  settled: 'Settled',
};

/** What to say when the server refuses a consent signature. */
const consentFailureCopy: Record<string, string> = {
  terms_changed: 'These terms changed after you opened them. Reload and sign the new version.',
  consent_nonce_invalid: 'That signature request expired. Tap accept to sign again.',
  consent_message_invalid: 'The wallet signed something other than these terms. Please try again.',
  consent_wrong_account: 'That wallet is not the NEAR account linked to your member record.',
  consent_account_in_use: 'That NEAR account already accepted these terms for another member.',
  agreement_closed: 'This agreement is already closed.',
  near_not_configured: 'NEAR signing is not switched on for this server yet.',
  near_login_bad_signature: 'The wallet signed a different message. Reload and sign again.',
  near_login_bad_public_key: 'That wallet key is not an ed25519 key this app can verify.',
  near_login_key_not_found: 'That wallet key is not on the NEAR account it claims to sign for.',
  near_login_key_not_full_access: 'That key can only call one contract, so it cannot sign these terms.',
  near_rpc_failed: 'NEAR is not answering right now. Try again in a moment.',
  // Anchoring mistakes, each one something the fronter can act on.
  invalid_txHash: 'That is not a NEAR transaction hash. Copy it from your wallet history.',
  terms_missing: 'These terms have no digest yet, so there is nothing to anchor.',
  near_account_missing: 'Link a NEAR account before anchoring — the call has to be signed by you.',
  nothing_to_anchor: 'Every signature on these terms already has an on-chain receipt.',
  near_tx_not_found: 'NEAR has not seen that transaction yet. Wait a moment, then try again.',
  near_tx_failed: 'That transaction failed on chain, so it proves nothing. An anchor must succeed.',
  near_tx_wrong_sender: 'That transaction was signed by another account, not yours.',
  near_tx_wrong_token: 'That transaction called a different contract. The anchor calls the USDC token.',
  near_tx_wrong_method: 'That is not an anchor call. Paste the hash of the transaction the app just made.',
  near_tx_wrong_digest: 'That transaction does not carry these terms. Anchor these exact terms and try again.',
  // Registry mistakes, each one something the signing member can act on.
  registry_not_configured: 'The shared registry is not switched on for this server yet.',
  nothing_to_record: 'This signature is already in the registry, or it has not been signed yet.',
  near_account_mismatch: 'The registry only accepts this record from the account that signed it.',
};

function consentErrorCopy(cause: unknown): string {
  if (cause instanceof ApiError) {
    return (
      consentFailureCopy[cause.code] ??
      (cause.code.startsWith('near_')
        ? `NEAR refused the signature (${cause.code}). Please try again.`
        : cause.message)
    );
  }
  return cause instanceof Error ? cause.message : 'Could not record your signature. Try again.';
}

/** How many of the newest ledger rows the chat shows before the toggle expands it. */
const CHAT_PREVIEW_COUNT = 3;

export default function GroupScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const notify = useMascotToast();
  const money = useMoney();
  const group = useGroup(id);
  const timeline = useGroupTimeline(id);
  const createAgreement = useCreateAgreement(id);
  const acceptAgreement = useAcceptAgreement(id);
  const cloneAgreement = useCloneAgreement(id);

  const [estimate, setEstimate] = useState('');
  const [deadlineDays, setDeadlineDays] = useState('3');
  /** 'none' is a real choice, signed into the terms, not a missing value. */
  const [lateFee, setLateFee] = useState<'none' | 'monthly'>('none');
  const [interestRate, setInterestRate] = useState('');
  const [interestCap, setInterestCap] = useState('');
  /** Chosen once, at creation: a free signature, or a signature plus a public record. */
  const [consentLevel, setConsentLevel] = useState<'signed' | 'anchored'>('signed');
  /** The default the agreement is signed with; members can still vote to change it. */
  const [splitMode, setSplitMode] = useState<'itemised' | 'equal'>('itemised');
  /** True while the wallet popup is open, so the button cannot be tapped twice. */
  const [signing, setSigning] = useState(false);
  /** The chat opens collapsed to its newest rows; the heading toggle expands it. */
  const [showAllEvents, setShowAllEvents] = useState(false);

  if (group.isLoading) {
    return (
      <Screen scroll={false} header={{ title: 'Group', back: true }}>
        <Skeleton height={28} width="55%" />
        <Skeleton height={124} />
        <Skeleton height={96} />
      </Screen>
    );
  }

  if (group.error || !group.data) {
    return (
      <Screen scroll={false} header={{ title: 'Group', back: true }}>
        <EmptyState
          icon={icon.warning}
          title="Group unavailable"
          body={group.error?.message ?? 'This group is gone, or the link is wrong.'}
          action={
            <Button
              variant="secondary"
              compact
              icon={icon.refresh}
              title="Try again"
              onPress={() => group.refetch()}
            />
          }
        />
      </Screen>
    );
  }

  const { members, agreement, bill, me } = group.data;
  const currency = group.data.group.defaultCurrency;
  const myAcceptanceMissing =
    agreement?.status === 'pending' &&
    !timeline.data?.events.some(
      (event) => event.type === 'agreement.accepted' && event.actor === me.displayName
    );
  const agreed = agreement?.status === 'accepted';
  const isFronter = Boolean(agreement && agreement.frontedBy === me.id);
  /** A settled rent or subscription can be reused for the next period. */
  const repeatable =
    isFronter && agreement?.status === 'settled' && (agreement.recurrence ?? 'none') !== 'none';

  // Three rows is enough to show the group is alive without burying the rest of
  // the screen; anything longer gets the Latest / All toggle in the heading.
  const events = timeline.data?.events ?? [];
  const canCollapseEvents = events.length > CHAT_PREVIEW_COUNT;
  const collapsedEvents = canCollapseEvents && !showAllEvents;

  async function onCreateAgreement() {
    const estimatedTotalMinor = toMinor(estimate || '0');
    if (!Number.isFinite(estimatedTotalMinor)) return;
    const days = Number(deadlineDays) || 3;
    const rateBps = percentToBps(interestRate);
    const capBps = percentToBps(interestCap);
    // A monthly fee with no usable rate would be rejected by the API; say so
    // here instead of sending a request that cannot succeed.
    if (lateFee === 'monthly' && (rateBps === null || rateBps <= 0)) return;
    await createAgreement.mutateAsync({
      estimatedTotalMinor,
      deadline: new Date(Date.now() + days * 86_400_000).toISOString(),
      consentLevel,
      splitMode,
      interestMode: lateFee,
      interestRateBps: lateFee === 'monthly' ? rateBps : null,
      interestCapBps: lateFee === 'monthly' ? capBps : null,
    });
    setEstimate('');
    setInterestRate('');
    setInterestCap('');
    notify({
      title: 'Agreement set',
      body: `${formatMinor(estimatedTotalMinor, currency)} locked in — everyone taps to agree.`,
    });
  }

  /**
   * Web signs the terms with the wallet: the API hands back a single-use
   * challenge, the popup covers it, and the signature is what gets accepted.
   * Native has no popup, so it keeps the tap-only path.
   */
  async function onAcceptAgreement(agreementId: string) {
    if (!IS_WEB) {
      await acceptAgreement.mutateAsync({ agreementId });
      notify({ title: 'You agreed', body: 'Your tap is on record.' });
      return;
    }

    setSigning(true);
    try {
      let challenge: AgreementConsent;
      try {
        challenge = await requestAgreementConsent(agreementId);
      } catch (cause) {
        notify({ title: 'Could not prepare the signature', body: consentErrorCopy(cause) });
        return;
      }

      const outcome = await signAgreementTerms({
        message: challenge.message,
        nonce: challenge.nonce,
        recipient: challenge.recipient,
      });
      if (outcome.status === 'cancelled') return;
      if (outcome.status === 'error') {
        notify({ title: 'Not signed', body: outcome.message });
        return;
      }

      try {
        await acceptAgreement.mutateAsync({
          agreementId,
          signedMessage: challenge.nonce,
          payload: outcome.value,
        });
      } catch (cause) {
        notify({ title: 'Signature not accepted', body: consentErrorCopy(cause) });
        return;
      }

      notify({
        title: 'Signed and agreed',
        body: 'Your wallet signature is on these exact terms.',
      });
    } finally {
      setSigning(false);
    }
  }

  const billAction = bill
    ? bill.items.length > 0 || !isFronter
      ? { title: 'Open the expense', glyph: icon.receipt }
      : { title: 'Add the expense', glyph: icon.upload }
    : isFronter
      ? { title: 'Add the expense', glyph: icon.camera }
      : { title: 'Waiting for the details', glyph: icon.time };

  async function onStartNextPeriod(agreementId: string) {
    try {
      await cloneAgreement.mutateAsync({ agreementId });
      notify({
        title: 'Next period opened',
        body: 'Same people, same split. Everyone signs the new dates.',
      });
    } catch (cause) {
      notify({
        title: 'Could not start the next period',
        body: cause instanceof ApiError ? cause.message : 'Try again in a moment.',
      });
    }
  }

  return (
    <Screen
      header={{
        title: group.data.group.name,
        subtitle: `${members.length} in the group · ${currency}`,
        back: true,
      }}
      bottomInset={space.xl}
    >
      <InviteCard group={group.data.group} memberCount={members.length} />

      <Card tone="alt" enter={1}>
        <SectionHeading
          glyph={icon.people}
          title="Who is in"
          hint={`${members.length} in the group`}
        />
        <View style={styles.memberChips}>
          {members.map((member) => {
            const mine = member.id === me.id;
            return (
              <View key={member.id} style={[styles.chip, mine && styles.chipMe]}>
                <Icon name={icon.person} size={12} color={mine ? colors.accent : colors.mutedDim} />
                <Text variant="caption" tone={mine ? 'accent' : 'muted'}>
                  {member.displayName}
                  {member.role === 'owner' ? ' (host)' : ''}
                </Text>
              </View>
            );
          })}
        </View>
      </Card>

      {!agreement ? (
        <Card tone="accent" enter={2}>
          <SectionHeading
            glyph={icon.shield}
            title="Set the agreement"
            hint="Everyone taps once. Nobody argues later about who said they were in."
          />
          <Field
            label={`Estimated total (${currency})`}
            value={estimate}
            onChangeText={setEstimate}
            keyboardType="decimal-pad"
            placeholder="1200.00"
          />
          <Field
            label="Reimburse within (days)"
            value={deadlineDays}
            onChangeText={setDeadlineDays}
            keyboardType="number-pad"
            error={createAgreement.error?.message}
          />
          <View style={styles.lateFee}>
            <Text variant="label" tone="muted">
              How to divide the bill
            </Text>
            <View style={styles.toggle}>
              <ToggleSegment
                label="By line item"
                active={splitMode === 'itemised'}
                accessibilityLabel="Divide the bill by line item"
                onPress={() => setSplitMode('itemised')}
              />
              <ToggleSegment
                label="Evenly"
                active={splitMode === 'equal'}
                accessibilityLabel="Divide the bill evenly between members"
                onPress={() => setSplitMode('equal')}
              />
            </View>
            <Text variant="caption" tone="muted">
              {splitMode === 'equal'
                ? 'Everyone pays the same share, whatever they ordered. The group can still vote to change this later.'
                : 'Each person pays for the lines they had. The group can still vote to change this later.'}
            </Text>
          </View>
          <View style={styles.lateFee}>
            <Text variant="label" tone="muted">
              If someone is late
            </Text>
            <View style={styles.toggle}>
              <ToggleSegment
                label="No late fee"
                active={lateFee === 'none'}
                accessibilityLabel="No late fee"
                onPress={() => setLateFee('none')}
              />
              <ToggleSegment
                label="Monthly fee"
                active={lateFee === 'monthly'}
                accessibilityLabel="A monthly late fee"
                onPress={() => setLateFee('monthly')}
              />
            </View>
            {lateFee === 'monthly' ? (
              <>
                <Field
                  label="Late fee (% per month)"
                  value={interestRate}
                  onChangeText={setInterestRate}
                  keyboardType="decimal-pad"
                  placeholder="2"
                  error={
                    percentToBps(interestRate) === null
                      ? 'Give the monthly fee a rate, or choose no late fee.'
                      : undefined
                  }
                />
                <Field
                  label="Cap (% of the share, optional)"
                  value={interestCap}
                  onChangeText={setInterestCap}
                  keyboardType="decimal-pad"
                  placeholder="20"
                />
                <Text variant="caption" tone="muted">
                  Charged on top of the share, only after the due date, and only by the person
                  who fronted. Everyone signs these exact terms.
                </Text>
              </>
            ) : (
              <Text variant="caption" tone="muted">
                Nobody can be charged extra for paying late. This is part of the terms everyone
                signs.
              </Text>
            )}
          </View>
          <View style={styles.lateFee}>
            <Text variant="label" tone="muted">
              How the agreement is proven
            </Text>
            <View style={styles.toggle}>
              <ToggleSegment
                label="Wallet signature"
                active={consentLevel === 'signed'}
                accessibilityLabel="Prove the agreement with wallet signatures only"
                onPress={() => setConsentLevel('signed')}
              />
              <ToggleSegment
                label="Anchor on chain"
                active={consentLevel === 'anchored'}
                accessibilityLabel="Anchor the agreement on chain"
                onPress={() => setConsentLevel('anchored')}
              />
            </View>
            <Text variant="caption" tone="muted">
              {consentLevel === 'anchored'
                ? 'Everyone still signs for free. After that, each member can publish their own signature to a shared NEAR registry, so any explorer can show the agreement.'
                : 'Everyone signs these exact terms with their wallet. Free, off-chain, and verifiable inside this app.'}
            </Text>
          </View>
          <Button
            title="Create agreement"
            icon={icon.check}
            onPress={onCreateAgreement}
            loading={createAgreement.isPending}
          />
        </Card>
      ) : (
        <Card tone={agreed ? 'accent' : 'surface'} enter={2}>
          <View style={styles.rowBetween}>
            <Text variant="label" tone="muted">
              Agreement
            </Text>
            <View style={[styles.badge, agreed && styles.badgeAgreed]}>
              <Icon
                name={agreed ? icon.shield : icon.time}
                size={12}
                color={agreed ? colors.accent : colors.warn}
              />
              <Text variant="caption" tone={agreed ? 'accent' : 'warn'}>
                {statusCopy[agreement.status]}
              </Text>
            </View>
          </View>
          <Text variant="figure" numberOfLines={1}>
            {money.format(agreement.estimatedTotalMinor, agreement.currency)}
          </Text>
          <Text variant="caption" tone="muted">
            {money.approximate(agreement.estimatedTotalMinor, agreement.currency)
              ? `${money.formatOriginal(agreement.estimatedTotalMinor, agreement.currency)} · `
              : ''}
            {agreement.acceptedCount} of {agreement.memberCount} accepted
            {agreement.deadline
              ? `, due ${new Date(agreement.deadline).toLocaleDateString()}`
              : ''}
          </Text>
          <Text variant="caption" tone="muted">
            {agreement.interestMode === 'monthly' && agreement.interestRateBps
              ? `Late fee ${bpsToPercent(agreement.interestRateBps)} per month${
                  agreement.interestCapBps
                    ? `, capped at ${bpsToPercent(agreement.interestCapBps)} of the share`
                    : ''
                }`
              : 'No late fee'}
          </Text>

          <SplitVotePanel
            groupId={id}
            agreementId={agreement.id}
            summary={group.data.splitVote}
            disabled={agreement.status === 'settled' || agreement.status === 'cancelled'}
          />

          {myAcceptanceMissing ? (
            <View style={styles.actions}>
              <Button
                title={IS_WEB ? 'Sign & agree with wallet' : 'I agree to these terms'}
                icon={icon.check}
                onPress={() => onAcceptAgreement(agreement.id)}
                loading={signing || acceptAgreement.isPending}
                disabled={signing || acceptAgreement.isPending}
              />
              <Text variant="caption" tone="muted">
                {IS_WEB
                  ? agreement.consentLevel === 'anchored'
                    ? 'Signing is free. Once everyone has signed, the fronter publishes the terms digest on chain with a 0.000001 USDC self-transfer.'
                    : 'Signing is free and proves you accepted these exact terms.'
                  : 'Your tap is recorded against these terms.'}
              </Text>
            </View>
          ) : agreement.status === 'settled' ? (
            <View style={styles.actions}>
              <Text variant="caption" tone="muted">
                This {agreement.recurrence === 'weekly' ? 'week' : 'period'} is settled.
              </Text>
              {bill ? (
                <Button
                  title="Open the bill"
                  variant="secondary"
                  icon={icon.receipt}
                  onPress={() =>
                    router.push({
                      pathname: '/groups/[id]/bill',
                      params: { id, billId: bill.id },
                    })
                  }
                />
              ) : null}
              {repeatable ? (
                <Button
                  title="Start next period"
                  icon={icon.refresh}
                  onPress={() => onStartNextPeriod(agreement.id)}
                  loading={cloneAgreement.isPending}
                  disabled={cloneAgreement.isPending}
                />
              ) : null}
            </View>
          ) : agreed ? (
            <View style={styles.actions}>
              <Button
                title={billAction.title}
                icon={billAction.glyph}
                onPress={() =>
                  bill
                    ? router.push({
                        pathname: '/groups/[id]/bill',
                        params: { id, billId: bill.id },
                      })
                    : router.push({ pathname: '/groups/[id]/bill', params: { id } })
                }
              />
              <Button
                title="Leaderboard"
                variant="secondary"
                icon={icon.hero}
                onPress={() => router.push({ pathname: '/groups/[id]/leaderboard', params: { id } })}
              />
            </View>
          ) : (
            <View style={styles.waiting}>
              <Icon name={icon.time} size={14} color={colors.warn} />
              <Text variant="caption" tone="warn">
                Waiting for every member to tap accept.
              </Text>
            </View>
          )}

          <AgreementProof
            agreement={agreement}
            groupId={id}
            isFronter={isFronter}
            myMemberId={me.id}
          />
        </Card>
      )}

      <View style={styles.section}>
        <SectionHeading
          glyph={icon.chat}
          title="Group chat"
          hint={
            collapsedEvents
              ? `Latest ${CHAT_PREVIEW_COUNT} of ${events.length} · every tap lands here.`
              : canCollapseEvents
                ? `All ${events.length} · every tap lands here.`
                : 'Every tap lands here.'
          }
          action={
            canCollapseEvents ? (
              <TimelineToggle
                showAll={showAllEvents}
                total={events.length}
                onChange={setShowAllEvents}
              />
            ) : undefined
          }
        />
        <Timeline
          events={events}
          currency={currency}
          limit={collapsedEvents ? CHAT_PREVIEW_COUNT : undefined}
        />
      </View>

      <GlobieChat
        groupId={id}
        agreementId={agreement?.id ?? null}
        billId={bill?.id ?? null}
        billStatus={bill?.status ?? null}
        currency={currency}
        members={members}
        isFronter={isFronter}
        memberName={me.displayName}
      />

      <View style={styles.linkRow}>
        <Button
          variant="ghost"
          compact
          icon={icon.hero}
          title="Who fronted the most this month?"
          onPress={() => router.push({ pathname: '/groups/[id]/leaderboard', params: { id } })}
        />
        <Button
          variant="ghost"
          compact
          icon={icon.gift}
          title="Bounties and the group DAO"
          onPress={() =>
            router.push({ pathname: '/social/board/[group]', params: { group: id } })
          }
        />
      </View>
    </Screen>
  );
}

/**
 * A two-state switch for the chat: the newest few rows, or the whole ledger.
 * It is a disclosure rather than a tab bar — one control, two fixed segments —
 * so it sits in the heading and never grows with the number of messages.
 */
function TimelineToggle({
  showAll,
  total,
  onChange,
}: {
  showAll: boolean;
  total: number;
  onChange: (next: boolean) => void;
}) {
  return (
    <View style={styles.toggle}>
      <ToggleSegment
        label="Latest"
        active={!showAll}
        accessibilityLabel={`Show the latest ${CHAT_PREVIEW_COUNT} messages`}
        onPress={() => onChange(false)}
      />
      <ToggleSegment
        label={`All ${total}`}
        active={showAll}
        accessibilityLabel={`Show all ${total} messages`}
        onPress={() => onChange(true)}
      />
    </View>
  );
}

/** One half of the toggle. The selected half is a raised pill, not just a tint. */
function ToggleSegment({
  label,
  active,
  accessibilityLabel,
  onPress,
}: {
  label: string;
  active: boolean;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      aria-pressed={active}
      hitSlop={{ top: space.sm, bottom: space.sm }}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={() => {
        if (active) return;
        haptics.select();
        onPress();
      }}
      style={[
        styles.toggleSegment,
        active && styles.toggleSegmentActive,
        hovered && !active && styles.toggleSegmentHover,
      ]}
    >
      <Text variant="caption" tone={active ? 'accent' : 'muted'} style={styles.toggleLabel}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The evidence behind an agreement. A NEP-413 signature has no transaction, so
 * this is the only place a member can see who signed, with which account, and
 * whether that signature has been published. Two paths publish it: a member can
 * write their own signature into the shared registry, and the fronter can still
 * make one read-only USDC call that carries the terms digest as its argument.
 */
function AgreementProof({
  agreement,
  groupId,
  isFronter,
  myMemberId,
}: {
  agreement: Agreement;
  groupId: string;
  isFronter: boolean;
  myMemberId: string;
}) {
  const notify = useMascotToast();
  const proof = useAgreementAcceptances(agreement.id);
  const rail = useNearStatus();
  const anchorAgreement = useAnchorAgreement(groupId);
  const [anchoring, setAnchoring] = useState(false);
  const [recordingId, setRecordingId] = useState<string | null>(null);

  const acceptances = proof.data?.acceptances ?? [];
  const termsHash = proof.data?.termsHash ?? agreement.termsHash ?? null;
  const explorerUrl = rail.data?.explorerUrl;
  const registry = rail.data?.agreementsContract ?? null;
  const signed = acceptances.filter((row) => row.signature);
  const unanchored = signed.filter((row) => !row.anchorTxHash);
  const anchored = acceptances.filter((row) => row.anchorTxHash);
  // Anchoring needs the wallet popup, so web only.
  const canAnchor =
    isFronter && IS_WEB && agreement.consentLevel === 'anchored' && Boolean(termsHash)
    && unanchored.length > 0;
  // A registry record is per member: each one signs for themselves, so the
  // button lives on the row of the person looking at it.
  const canRecord = IS_WEB && agreement.consentLevel === 'anchored' && Boolean(registry);

  async function onRecord() {
    setRecordingId(myMemberId);
    try {
      // The contract only accepts this from the account that signed, so the
      // wallet that pops up must be the member's own.
      const payment = await payNearRecordAcceptance({ agreementId: agreement.id });
      if (payment.status === 'cancelled') return;
      if (payment.status === 'error') {
        notify({ title: 'Not recorded', body: payment.message });
        return;
      }

      const result = await anchorAgreement.mutateAsync({
        agreementId: agreement.id,
        txHash: payment.txHash,
      });
      notify({
        title: 'Signature recorded',
        body: `${result.anchor.anchoredCount} ${
          result.anchor.anchoredCount === 1 ? 'signature now has' : 'signatures now have'
        } a public receipt.`,
      });
    } catch (cause) {
      notify({ title: 'Not recorded', body: consentErrorCopy(cause) });
    } finally {
      setRecordingId(null);
    }
  }

  async function onAnchor() {
    if (!termsHash) return;

    setAnchoring(true);
    try {
      // A read-only call whose argument is the digest: nothing moves, and the
      // wallet only pays gas for a public, permanent proof.
      const payment = await payNearAnchorCall({ agreementId: agreement.id });
      if (payment.status === 'cancelled') return;
      if (payment.status === 'error') {
        notify({ title: 'Anchor not sent', body: payment.message });
        return;
      }

      const result = await anchorAgreement.mutateAsync({
        agreementId: agreement.id,
        txHash: payment.txHash,
      });
      notify({
        title: 'Agreement anchored',
        body: `${result.anchor.anchoredCount} ${
          result.anchor.anchoredCount === 1 ? 'signature now has' : 'signatures now have'
        } a public receipt.`,
      });
    } catch (cause) {
      notify({ title: 'Not anchored', body: consentErrorCopy(cause) });
    } finally {
      setAnchoring(false);
    }
  }

  if (acceptances.length === 0) return null;

  return (
    <View style={styles.proof}>
      <View style={styles.rowBetween}>
        <View style={styles.proofTitle}>
          <Icon name={icon.shield} size={13} color={colors.accent} />
          <Text variant="label" tone="muted">
            Proof
          </Text>
        </View>
        <Text variant="caption" tone="muted">
          {signed.length} signed · {anchored.length} on chain
        </Text>
      </View>

      {acceptances.map((row) => {
        const mine = row.memberId === myMemberId;
        const recordable = canRecord && mine && Boolean(row.signature) && !row.anchorTxHash;
        return (
          <View key={row.memberId} style={styles.proofRow}>
            <View style={styles.proofIdentity}>
              <Text variant="caption" numberOfLines={1}>
                {row.displayName}
              </Text>
              {row.nearAccount ? (
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel={`Open ${row.nearAccount} on the NEAR explorer`}
                  disabled={!explorerUrl}
                  onPress={() =>
                    explorerUrl
                      ? void WebBrowser.openBrowserAsync(
                          nearAccountUrl(explorerUrl, row.nearAccount!)
                        )
                      : undefined
                  }
                  style={styles.proofAccount}
                >
                  <Text variant="caption" tone="accent" numberOfLines={1} style={styles.mono}>
                    {row.nearAccount}
                  </Text>
                  {explorerUrl ? (
                    <Icon name={icon.link} size={11} color={colors.mutedDim} />
                  ) : null}
                </Pressable>
              ) : (
                <Text variant="caption" tone="muted">
                  {row.signature ? 'Signature, no account' : 'Tap only'}
                </Text>
              )}
            </View>
            <View style={styles.proofStatus}>
              <Text variant="caption" tone={row.anchorTxHash ? 'accent' : 'muted'}>
                {row.anchorTxHash ? 'On chain' : row.signature ? 'Signed' : 'Tapped'}
              </Text>
              {recordable ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Record your signature in the NEAR registry"
                  disabled={recordingId !== null}
                  onPress={() => void onRecord()}
                  style={styles.recordAction}
                >
                  <Text variant="caption" tone="accent">
                    {recordingId === myMemberId ? 'Recording…' : 'Record'}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        );
      })}

      {anchored.map((row) => (
        <TxReceipt key={`${row.memberId}-tx`} txHash={row.anchorTxHash!} />
      ))}

      {canAnchor ? (
        <View style={styles.actions}>
          <Button
            title="Anchor on chain"
            icon={icon.near}
            onPress={onAnchor}
            loading={anchoring}
            disabled={anchoring}
          />
          <Text variant="caption" tone="muted">
            {registry
              ? 'Each member can record their own signature. The fronter can also publish the terms digest with one read-only USDC call; NEAR reads it back before anything is marked anchored.'
              : 'One read-only call to the USDC contract carries the terms digest as its argument. NEAR reads it back before anything is marked anchored.'}
          </Text>
        </View>
      ) : agreement.consentLevel === 'anchored' && anchored.length > 0 ? (
        <Text variant="caption" tone="accent">
          The terms digest is published — anyone can check it without this app.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  memberChips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  // squared off: a person is not a status pill
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
  },
  chipMe: { backgroundColor: colors.wash },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.warn,
  },
  badgeAgreed: { borderColor: colors.accentText },
  actions: { gap: space.sm },
  lateFee: { gap: space.sm },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  section: { gap: space.md },
  linkRow: { alignItems: 'center' },
  // The proof panel is separated by a rule, not another card: it belongs to the agreement.
  proof: {
    gap: space.sm,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  proofTitle: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  proofRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  proofIdentity: { flex: 1, gap: 2 },
  proofStatus: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  recordAction: {
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.accentText,
  },
  proofAccount: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  mono: { fontFamily: type.mono },
  // A pill inside a pill: the rim names the control, the filled half names the state.
  toggle: {
    flexDirection: 'row',
    gap: 2,
    padding: 2,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  toggleSegment: {
    paddingHorizontal: space.sm + 2,
    paddingVertical: 5,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    // Both halves carry the rim so selecting one never resizes either.
    borderWidth: 1,
    borderColor: 'transparent',
  },
  toggleSegmentActive: {
    backgroundColor: colors.wash,
    borderColor: 'rgba(110, 240, 190, 0.24)',
  },
  toggleSegmentHover: { backgroundColor: colors.surfaceHi },
  // Same weight in both halves, so selecting one never nudges the other.
  toggleLabel: { fontWeight: '600' },
});
