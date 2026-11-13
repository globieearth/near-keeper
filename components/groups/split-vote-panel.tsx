import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { haptics } from '@/components/ui/haptics';
import { Icon, icon } from '@/components/ui/icon';
import { useMascotToast } from '@/components/ui/mascot-toast';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { useCastSplitVote } from '@/lib/queries';
import type { SplitVote, SplitVoteSummary } from '@/lib/types';

const optionLabel: Record<SplitVote, string> = {
  itemised: 'By line item',
  equal: 'Evenly',
};

/**
 * The group's split preference. Every member gets the same two options; the
 * majority wins and, on a dead heat, the fronter's own vote decides. Votes at
 * the bill level override the agreement, so the caption says which one applies.
 */
export function SplitVotePanel({
  groupId,
  agreementId,
  billId,
  summary,
  disabled = false,
}: {
  groupId: string;
  agreementId?: string;
  billId?: string;
  summary: SplitVoteSummary | null | undefined;
  disabled?: boolean;
}) {
  const notify = useMascotToast();
  const cast = useCastSplitVote(groupId);
  const [pendingMode, setPendingMode] = useState<SplitVote | null>(null);

  if (!summary) return null;

  async function vote(mode: SplitVote) {
    if (disabled || pendingMode || summary?.myVote === mode) return;
    setPendingMode(mode);
    try {
      await cast.mutateAsync({ mode, agreementId, billId });
      notify({
        title: 'Vote counted',
        body: `You chose to split ${mode === 'equal' ? 'evenly' : 'by line item'}.`,
      });
    } catch (cause) {
      notify({
        title: 'Vote not recorded',
        body: cause instanceof Error ? cause.message : 'Try again in a moment.',
      });
    } finally {
      setPendingMode(null);
    }
  }

  const sourceCopy =
    summary.source === 'bill'
      ? 'This bill is using its own vote, which overrides the agreement.'
      : summary.source === 'agreement'
        ? 'This is the agreement-wide vote, applied to every bill.'
        : 'Nobody has voted yet, so the mode chosen when the agreement was signed applies.';

  return (
    <View style={styles.panel}>
      <View style={styles.heading}>
        <View style={styles.titleRow}>
          <Icon name={icon.people} size={13} color={colors.accent} />
          <Text variant="label" tone="muted">
            How to divide
          </Text>
        </View>
        <Text variant="caption" tone="accent">
          {optionLabel[summary.resolvedMode]}
        </Text>
      </View>

      <View style={styles.toggle}>
        {(['itemised', 'equal'] as const).map((mode) => {
          const active = summary.myVote === mode;
          return (
            <Pressable
              key={mode}
              accessibilityRole="button"
              accessibilityLabel={`Vote to split ${mode === 'equal' ? 'evenly' : 'by line item'}`}
              aria-pressed={active}
              disabled={disabled}
              hitSlop={{ top: space.sm, bottom: space.sm }}
              onPress={() => {
                if (active) return;
                haptics.select();
                void vote(mode);
              }}
              style={[styles.segment, active && styles.segmentActive]}
            >
              <Text variant="caption" tone={active ? 'accent' : 'muted'} style={styles.segmentLabel}>
                {optionLabel[mode]} · {summary.tally[mode]}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Text variant="caption" tone="muted">
        {summary.tie
          ? `Dead heat at ${summary.tally.itemised}–${summary.tally.equal}. The fronter's vote decides.`
          : `${summary.totalVotes} of ${summary.memberCount} ${
              summary.memberCount === 1 ? 'member has' : 'members have'
            } voted. ${sourceCopy}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: space.sm,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  // A pill inside a pill: the rim names the control, the filled half names the vote.
  toggle: {
    flexDirection: 'row',
    gap: 2,
    padding: 2,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  segment: {
    flex: 1,
    paddingHorizontal: space.sm + 2,
    paddingVertical: 5,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  segmentActive: {
    backgroundColor: colors.wash,
    borderColor: 'rgba(110, 240, 190, 0.24)',
  },
  segmentLabel: { fontWeight: '600' },
});
