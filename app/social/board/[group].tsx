import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Icon, icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { SectionHeading } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { useMascotToast } from '@/components/ui/mascot-toast';
import { IS_WEB, NEAR_NETWORK } from '@/lib/config';
import { useMoney } from '@/lib/money-context';
import { currencyExponent, toMinor } from '@/lib/money';
import { payNearCreateDao } from '@/lib/near';
import {
  useBountyBoard,
  useConfirmSocialDao,
  useCreateSocialBounty,
  useGroup,
  useRegisterSocialTreasury,
  useSocialTreasuries,
  useSocialTrust,
  useSyncSocialTreasury,
} from '@/lib/queries';
import type { SocialBounty } from '@/lib/types';

/**
 * The group's bounty board. Reading it also materialises the preset bounties the
 * server ships, so an untouched group still opens onto something to take. Money
 * is only ever prepared here — the signature happens on the bounty screen, in the
 * member's own wallet.
 */
export default function BountyBoardScreen() {
  const { group: groupId } = useLocalSearchParams<{ group: string }>();
  const group = useGroup(groupId);
  const treasuries = useSocialTreasuries(groupId);
  const board = useBountyBoard(groupId);
  const trust = useSocialTrust(groupId);
  const money = useMoney();
  const notify = useMascotToast();

  const register = useRegisterSocialTreasury(groupId);
  const sync = useSyncSocialTreasury(groupId);
  const create = useCreateSocialBounty(groupId);
  const confirmDao = useConfirmSocialDao(groupId);

  const [addingTreasury, setAddingTreasury] = useState(false);
  const [daoHelp, setDaoHelp] = useState(false);
  const [treasuryLabel, setTreasuryLabel] = useState('');
  const [daoAccount, setDaoAccount] = useState('');
  const [syncingId, setSyncingId] = useState<string | null>(null);

  const [daoName, setDaoName] = useState('');
  const [daoBusy, setDaoBusy] = useState(false);
  const [mintedDao, setMintedDao] = useState<{ daoAccount: string; label: string } | null>(null);

  const [posting, setPosting] = useState(false);
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [reward, setReward] = useState('');
  const [category, setCategory] = useState('');

  const me = group.data?.me;
  const canManageTreasury = me?.role === 'owner' || me?.role === 'fronter';
  const currency = group.data?.group.defaultCurrency ?? 'THB';

  const rows = board.data?.bounties ?? [];
  const presets = rows.filter((row) => row.source === 'preset');
  const open = rows.filter((row) => row.status === 'open');
  const active = rows.filter(
    (row) => row.status === 'claimed' || row.status === 'submitted' || row.status === 'approved'
  );
  const paid = rows.filter((row) => row.status === 'paid');
  const treasuryList = treasuries.data?.treasuries ?? [];
  const contributors = trust.data?.contributors ?? [];

  const isPending = register.isPending || sync.isPending || create.isPending || daoBusy;
  const daoFactory = NEAR_NETWORK === 'mainnet' ? 'sputnik-dao.near' : 'sputnikv2.testnet';

  /** The DAO is minted by the factory; only `confirm` writes the treasury row. */
  async function onRecordCreatedDao(daoAccount: string, label: string) {
    try {
      await confirmDao.mutateAsync({ daoAccount, label });
      setMintedDao(null);
      setDaoName('');
      notify({
        title: 'DAO minted',
        body: `${daoAccount} is the group treasury. Fund it, then the board can pay.`,
      });
    } catch (cause) {
      setMintedDao({ daoAccount, label });
      notify({
        title: 'Sent, not readable yet',
        body: cause instanceof Error ? cause.message : 'Give the chain a moment, then check again.',
      });
    }
  }

  async function onCreateDao() {
    const name = daoName.trim().toLowerCase();
    if (!name) {
      notify({ title: 'Name the DAO', body: 'A short lowercase name is enough.' });
      return;
    }
    setDaoBusy(true);
    try {
      const outcome = await payNearCreateDao({ groupId, name, label: name });
      if (outcome.status === 'cancelled') {
        notify({ title: 'Nothing was charged', body: 'The wallet closed before signing.' });
        return;
      }
      if (outcome.status === 'error') {
        notify({ title: 'DAO not created', body: outcome.message });
        return;
      }
      await onRecordCreatedDao(outcome.created.daoAccount, outcome.created.name);
    } finally {
      setDaoBusy(false);
    }
  }

  async function onCheckMintedDao() {
    if (!mintedDao) return;
    setDaoBusy(true);
    try {
      await onRecordCreatedDao(mintedDao.daoAccount, mintedDao.label);
    } finally {
      setDaoBusy(false);
    }
  }

  async function onRegisterTreasury() {
    const label = treasuryLabel.trim();
    const account = daoAccount.trim();
    if (!label || !account) {
      notify({ title: 'Fill both fields', body: 'A label and the DAO account, then try again.' });
      return;
    }
    try {
      await register.mutateAsync({ label, daoAccount: account });
      setTreasuryLabel('');
      setDaoAccount('');
      setAddingTreasury(false);
      notify({ title: 'DAO connected', body: 'The policy was read and the caps are stored.' });
    } catch (cause) {
      notify({
        title: 'Could not read the DAO',
        body: cause instanceof Error ? cause.message : 'Check the account and try again.',
      });
    }
  }

  async function onSync(treasuryId: string) {
    setSyncingId(treasuryId);
    try {
      await sync.mutateAsync(treasuryId);
      notify({ title: 'Policy refreshed', body: 'Roles and approvals are up to date.' });
    } catch (cause) {
      notify({
        title: 'Sync failed',
        body: cause instanceof Error ? cause.message : 'The chain did not answer.',
      });
    } finally {
      setSyncingId(null);
    }
  }

  async function onCreateBounty() {
    const cleanTitle = title.trim();
    const amountMinor = toMinor(reward, currencyExponent(currency));
    if (!cleanTitle) {
      notify({ title: 'Name the work', body: 'A bounty needs a title the group can read.' });
      return;
    }
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
      notify({ title: 'Set a reward', body: 'Enter an amount larger than zero.' });
      return;
    }
    try {
      await create.mutateAsync({
        title: cleanTitle,
        description: brief.trim() || undefined,
        category: category.trim() || undefined,
        amountMinor,
        currency,
        treasuryId: treasuryList[0]?.id ?? null,
      });
      setTitle('');
      setBrief('');
      setReward('');
      setCategory('');
      setPosting(false);
      notify({ title: 'Bounty posted', body: 'It is open for the group to claim.' });
    } catch (cause) {
      notify({
        title: 'Could not post it',
        body: cause instanceof Error ? cause.message : 'Try again in a moment.',
      });
    }
  }

  function openBounty(bounty: SocialBounty) {
    router.push({ pathname: '/social/[id]', params: { id: bounty.id } });
  }

  if (group.isLoading) {
    return (
      <Screen scroll={false} header={{ title: 'Bounties', back: true }}>
        <View style={styles.list}>
          <Skeleton height={92} />
          <Skeleton height={56} width="70%" />
          <Skeleton height={56} />
        </View>
      </Screen>
    );
  }

  if (group.error) {
    return (
      <Screen scroll={false} header={{ title: 'Bounties', back: true }}>
        <EmptyState
          icon={icon.warning}
          title="Could not open the board"
          body={group.error.message}
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

  return (
    <Screen
      header={{
        title: 'Bounties',
        subtitle: 'Post work, pick who did it, and let the group DAO pay. Every payout is a proposal your own wallet signs.',
        back: true,
        action: (
          <View style={styles.halo}>
            <Icon name={icon.gift} size={24} color={colors.accent} />
          </View>
        ),
      }}
      bottomInset={space.xl}
    >
      <SectionHeading
        glyph={icon.shield}
        title="Treasury"
        hint="The DAO this group pays from, and what it will approve on its own."
        action={
          canManageTreasury && treasuryList.length > 0 ? (
            <Button
              variant="ghost"
              compact
              icon={icon.add}
              title="Add"
              onPress={() => setAddingTreasury((value) => !value)}
            />
          ) : undefined
        }
      />

      {treasuries.isLoading ? (
        <Skeleton height={110} />
      ) : treasuryList.length === 0 ? (
        <Card tone="alt" enter={1}>
          <Text variant="label">No DAO yet</Text>
          <Text variant="caption" tone="muted">
            {canManageTreasury
              ? 'Mint one below with defaults, or connect a Sputnik DAO the group already owns.'
              : 'The group owner or a fronter connects the DAO. Once it is here, bounties can be paid.'}
          </Text>
        </Card>
      ) : (
        <View style={styles.list}>
          {treasuryList.map((treasury, index) => (
            <Card key={treasury.id} enter={index + 1}>
              <View style={styles.treasuryHead}>
                <View style={styles.treasuryCopy}>
                  <Text variant="label">{treasury.label}</Text>
                  <Text variant="mono" tone="muted">
                    {treasury.daoAccount}
                  </Text>
                </View>
                <Button
                  variant="ghost"
                  compact
                  icon={icon.sync}
                  title="Sync"
                  loading={syncingId === treasury.id}
                  disabled={isPending}
                  onPress={() => onSync(treasury.id)}
                />
              </View>

              <View style={styles.chips}>
                <Chip label="Auto" value={money.format(treasury.caps.autoApproveCapMinor, currency)} />
                <Chip label="Council" value={money.format(treasury.caps.midApproveCapMinor, currency)} />
                <Chip label="Period" value={money.format(treasury.caps.periodCapMinor, currency)} />
                <Chip label="Window" value={`${treasury.periodDays}d`} />
              </View>

              <View style={styles.roles}>
                <RoleLine
                  name={treasury.autoRole}
                  role={treasury.roles?.auto}
                  fallback="Not in the policy yet"
                />
                <RoleLine
                  name={treasury.councilRole}
                  role={treasury.roles?.council}
                  fallback="Not in the policy yet"
                />
              </View>

              <Text variant="caption" tone="dim">
                {treasury.policySyncedAt
                  ? `Policy read ${new Date(treasury.policySyncedAt).toLocaleString()}`
                  : 'Policy has not been read from the chain yet.'}
              </Text>
            </Card>
          ))}
        </View>
      )}

      {canManageTreasury && treasuryList.length === 0 ? (
        <Card tone="alt" enter={1}>
          <Text variant="label">Create a DAO with defaults</Text>
          <Text variant="caption" tone="muted">
            Globie asks the {daoFactory} factory to mint
            {' '}
            {`${daoName.trim() || 'your-name'}.${daoFactory}`}. The council is this group&apos;s
            owners and fronters, and proposals default to a 7-day window.
          </Text>
          {IS_WEB ? (
            <>
              <Field
                label="DAO name"
                value={daoName}
                onChangeText={setDaoName}
                placeholder="market-day"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Text variant="caption" tone="warn">
                Your own wallet signs and pays about 6 NEAR for the DAO&apos;s storage — keep about
                6.3 NEAR liquid so gas is covered too. The factory refunds whatever the code does
                not use.
              </Text>
              <Button
                variant="primary"
                icon={icon.sparkles}
                title="Create with wallet"
                loading={daoBusy}
                disabled={isPending}
                onPress={onCreateDao}
              />
            </>
          ) : (
            <Text variant="caption" tone="muted">
              Minting needs the wallet popup, which only the browser build has. Open Globie on the
              web to create it here — or make the DAO in a builder such as Trezu and paste its
              account below.
            </Text>
          )}
          {mintedDao ? (
            <Card tone="surface" enter={false}>
              <Text variant="label">Waiting for {mintedDao.daoAccount}</Text>
              <Text variant="caption" tone="muted">
                The transaction is in, but the chain has not returned its policy yet. That usually
                takes a few seconds.
              </Text>
              <Button
                variant="secondary"
                compact
                icon={icon.refresh}
                title="Check again"
                loading={daoBusy}
                disabled={daoBusy}
                onPress={onCheckMintedDao}
                style={styles.inline}
              />
            </Card>
          ) : null}
        </Card>
      ) : null}

      {canManageTreasury && (addingTreasury || treasuryList.length === 0) ? (
        <Card tone="alt" enter={2}>
          <Text variant="label">Connect a DAO</Text>
          <Text variant="caption" tone="muted">
            Paste a Sputnik DAO account on {NEAR_NETWORK} and Globie reads its policy.
          </Text>
          <Field
            label="Label"
            value={treasuryLabel}
            onChangeText={setTreasuryLabel}
            placeholder="Main treasury"
            autoCapitalize="sentences"
          />
          <Field
            label="DAO account"
            value={daoAccount}
            onChangeText={setDaoAccount}
            placeholder={NEAR_NETWORK === 'mainnet' ? 'group.sputnik-dao.near' : 'group.sputnikv2.testnet'}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Button
            variant="secondary"
            icon={icon.link}
            title="Read the policy"
            loading={register.isPending}
            disabled={isPending}
            onPress={onRegisterTreasury}
          />
          <Button
            variant="ghost"
            compact
            icon={icon.information}
            title="How do I get a DAO account?"
            onPress={() => setDaoHelp((value) => !value)}
            style={styles.inline}
          />
          {daoHelp ? (
            <Card tone="surface" enter={false}>
              <Text variant="label">Where a DAO account comes from</Text>
              <Text variant="caption" tone="muted">
                A DAO account is a NEAR account running the Sputnik v2 contract — it answers
                get_policy. A plain wallet account does not, so pasting one fails with “did not
                return JSON”.
              </Text>
              <Text variant="caption" tone="muted">
                1. On the web, tap Create with wallet above: Globie calls create on the{' '}
                {NEAR_NETWORK === 'mainnet' ? 'sputnik-dao.near' : 'sputnikv2.testnet'} factory
                with this group&apos;s owners and fronters as the council. The signing wallet needs
                about 6.3 NEAR for the deposit and gas; on a phone use the web build, or build one
                in a DAO app such as Trezu.
              </Text>
              <Text variant="caption" tone="muted">
                2. It has to be on {NEAR_NETWORK}; on this app that means an account ending in
                .{NEAR_NETWORK === 'mainnet' ? 'sputnik-dao.near' : 'sputnikv2.testnet'}.
              </Text>
              <Text variant="caption" tone="muted">
                3. Paste it above, give it a label and tap Read the policy. The caps and roles are
                stored, so the board can pay from it.
              </Text>
              <Button
                variant="secondary"
                compact
                icon={icon.bulb}
                title="Read the full guide"
                onPress={() =>
                  router.push({ pathname: '/help', params: { topic: 'dao-account' } })
                }
                style={styles.inline}
              />
              <Button
                variant="ghost"
                compact
                icon={icon.globe}
                title="Open the NEAR DAO guide"
                onPress={() => void Linking.openURL('https://docs.near.org/primitives/dao')}
                style={styles.inline}
              />
            </Card>
          ) : null}
        </Card>
      ) : null}

      <SectionHeading
        glyph={icon.gift}
        title="Bounty board"
        hint="Preset work ships with every group. Anything else is posted by a member."
        action={
          <Button
            variant="ghost"
            compact
            icon={icon.add}
            title="Post"
            onPress={() => setPosting((value) => !value)}
          />
        }
      />

      {posting ? (
        <Card tone="alt" enter={1}>
          <Field
            label="What needs doing"
            value={title}
            onChangeText={setTitle}
            placeholder="Design a poster for the market day"
            autoCapitalize="sentences"
          />
          <Field
            label="Details"
            value={brief}
            onChangeText={setBrief}
            placeholder="What counts as done"
            multiline
          />
          <View style={styles.row2}>
            <View style={styles.grow}>
              <Field
                label={`Reward (${currency})`}
                value={reward}
                onChangeText={setReward}
                placeholder="0.00"
                keyboardType="decimal-pad"
              />
            </View>
            <View style={styles.grow}>
              <Field
                label="Category"
                value={category}
                onChangeText={setCategory}
                placeholder="design"
                autoCapitalize="none"
              />
            </View>
          </View>
          <Button
            variant="primary"
            icon={icon.send}
            title="Post bounty"
            loading={create.isPending}
            disabled={isPending}
            onPress={onCreateBounty}
          />
        </Card>
      ) : null}

      {presets.length > 0 ? (
        <View>
          <Text variant="caption" tone="muted">
            Ready-made
          </Text>
          <View style={styles.presetRow}>
            {presets.map((preset) => (
              <Pressable
                key={preset.id}
                onPress={() => openBounty(preset)}
                accessibilityRole="button"
                accessibilityLabel={`Open preset bounty ${preset.title}`}
                style={styles.presetChip}
              >
                <Text variant="caption" tone="accent">
                  {preset.title}
                </Text>
                <Text variant="caption" tone="muted">
                  {preset.amountDisplay}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      {board.isLoading ? (
        <View style={styles.list}>
          <Skeleton height={64} />
          <Skeleton height={64} />
        </View>
      ) : board.error ? (
        <EmptyState
          icon={icon.warning}
          title="Could not load the board"
          body={board.error.message}
          action={
            <Button
              variant="secondary"
              compact
              icon={icon.refresh}
              title="Try again"
              onPress={() => board.refetch()}
            />
          }
        />
      ) : open.length === 0 && active.length === 0 && paid.length === 0 ? (
        <EmptyState
          icon={icon.giftOutline}
          title="Nothing on the board"
          body="Post the first piece of work and a member can pick it up."
        />
      ) : (
        <View style={styles.list}>
          <BountyList title="Open" rows={open} onOpen={openBounty} />
          <BountyList title="In progress" rows={active} onOpen={openBounty} />
          <BountyList title="Paid" rows={paid} onOpen={openBounty} muted />
        </View>
      )}

      <SectionHeading
        glyph={icon.medal}
        title="Contributors"
        hint="Trust grows with each settled payout and decides how much one person may approve."
      />

      {trust.isLoading ? (
        <Skeleton height={72} />
      ) : contributors.length === 0 ? (
        <Card tone="alt">
          <Text variant="caption" tone="muted">
            No one has been paid from this group yet. The first settled bounty starts the table.
          </Text>
        </Card>
      ) : (
        <View style={styles.list}>
          {contributors.map((row, index) => (
            <Card key={row.memberId} tone="alt" enter={index}>
              <View style={styles.trustRow}>
                <View style={styles.grow}>
                  <Text variant="label">{row.memberId.slice(0, 8)}</Text>
                  <Text variant="caption" tone="muted">
                    {row.completedCount} paid · {money.format(row.paidMinor, row.currency)}
                  </Text>
                </View>
                <View style={styles.score}>
                  <Text variant="mono" tone="accent">
                    {row.score}
                  </Text>
                  <Text variant="caption" tone="muted">
                    trust
                  </Text>
                </View>
              </View>
            </Card>
          ))}
        </View>
      )}
    </Screen>
  );
}

function BountyList({
  title,
  rows,
  onOpen,
  muted,
}: {
  title: string;
  rows: SocialBounty[];
  onOpen: (bounty: SocialBounty) => void;
  muted?: boolean;
}) {
  if (rows.length === 0) return null;

  return (
    <View style={styles.list}>
      <Text variant="caption" tone="muted">
        {title}
      </Text>
      {rows.map((bounty) => (
        <Pressable
          key={bounty.id}
          onPress={() => onOpen(bounty)}
          accessibilityRole="button"
          accessibilityLabel={`Open bounty ${bounty.title}`}
          style={({ pressed }) => [pressed && styles.pressed]}
        >
          <Card tone={muted ? 'alt' : 'surface'} style={styles.bountyRow}>
            <View style={styles.grow}>
              <Text variant="label">{bounty.title}</Text>
              <Text variant="caption" tone="muted">
                {bounty.category} · {bounty.status}
                {bounty.claimerName ? ` · ${bounty.claimerName}` : ''}
              </Text>
            </View>
            <View style={styles.amount}>
              <Text variant="mono">{bounty.amountDisplay}</Text>
              <Text variant="caption" tone="muted">
                {bounty.chainDisplay} {bounty.chainSymbol}
              </Text>
            </View>
            <Icon name={icon.chevronRight} size={16} color={colors.mutedDim} />
          </Card>
        </Pressable>
      ))}
    </View>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.chip}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="mono" style={styles.chipValue}>
        {value}
      </Text>
    </View>
  );
}

function RoleLine({
  name,
  role,
  fallback,
}: {
  name: string;
  role?: { exists: boolean; memberCount: number; requiredApprovals: number } | null;
  fallback: string;
}) {
  return (
    <View style={styles.roleLine}>
      <Text variant="caption" tone="muted">
        {name}
      </Text>
      <Text variant="caption" tone={role?.exists ? 'default' : 'dim'}>
        {role?.exists
          ? `${role.memberCount} member${role.memberCount === 1 ? '' : 's'} · ${role.requiredApprovals} approval${role.requiredApprovals === 1 ? '' : 's'}`
          : fallback}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  halo: {
    width: 52,
    height: 52,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.wash,
    borderWidth: 1,
    borderColor: colors.border,
  },
  list: { gap: space.sm },
  row2: { flexDirection: 'row', gap: space.md },
  grow: { flex: 1, gap: 2 },
  treasuryHead: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  treasuryCopy: { flex: 1, gap: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: {
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 1,
  },
  chipValue: { fontSize: 12 },
  roles: { gap: 2 },
  roleLine: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  presetChip: {
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    gap: 1,
  },
  bountyRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  amount: { alignItems: 'flex-end', gap: 1 },
  pressed: { opacity: 0.82 },
  inline: { alignSelf: 'flex-start' },
  trustRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  score: { alignItems: 'flex-end', gap: 1 },
});
