import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SuccessPulse } from '@/components/ui/celebrate';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { haptics } from '@/components/ui/haptics';
import { Icon, icon } from '@/components/ui/icon';
import { BabyKaeNa } from '@/components/ui/mascot';
import { useMascotToast } from '@/components/ui/mascot-toast';
import { Screen } from '@/components/ui/screen';
import { SectionHeading } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { ApiError } from '@/lib/api';
import { IS_NATIVE } from '@/lib/config';
import { crossRate } from '@/lib/fx';
import { currencyExponent } from '@/lib/money';
import { useMoney } from '@/lib/money-context';
import { payNearNativeTransfer, payNearTransfer } from '@/lib/near';
import {
    useFundCatalogue,
    useFundDeeds,
    useFxRates,
    useRequestFundQuote,
    useSettleFundDeed
} from '@/lib/queries';
import type { FundAsset, FundDeed, FundProject, FundQuote } from '@/lib/types';

type Notice = { text: string; explorerUrl?: string };

/** How many trees one tap buys. A gift is counted in trees, never in money. */
const QTY_CHOICES = [1, 2, 5, 10];

const NEED: Record<
  FundProject['needLevel'],
  { label: string; tone: 'warn' | 'danger' | 'muted' }
> = {
  urgent: { label: 'Urgent', tone: 'warn' },
  critical: { label: 'Critical need', tone: 'danger' },
  steady: { label: 'Steady', tone: 'muted' },
};

const ASSET_LABEL: Record<FundAsset, string> = { usdc: 'USDC', near: 'NEAR' };

function asError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(fallback);
}

/** The API speaks in codes; the screen says what the donor can do about them. */
function headline(error: Error): string {
  if (!(error instanceof ApiError)) return 'The gift did not go through';
  switch (error.code) {
    case 'network_error':
      return 'Could not reach Globie Keeper';
    case 'member_near_missing':
      return 'Link your NEAR account first';
    case 'fund_not_configured':
      return 'The sanctuary has no receiving account yet';
    case 'fund_usdc_unavailable':
      return 'USDC gifts are switched off — give in NEAR';
    case 'fund_quote_expired':
      return 'That quote expired';
    case 'fx_unavailable':
      return 'No NEAR price right now';
    default:
      return 'The gift did not go through';
  }
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** The chain reports full precision; a receipt row only has room for six. */
function shortToken(display: string): string {
  const [whole = '0', frac = ''] = display.split('.');
  const cut = frac.slice(0, 6).replace(/0+$/, '');
  return cut ? `${whole}.${cut}` : whole;
}

/**
 * An indicative NEAR figure beside a fiat price. Always `≈`: the amount that
 * actually leaves the wallet is the frozen quote, never this live estimate.
 */
function formatNear(near: number): string {
  const fixed = near.toFixed(near >= 1000 ? 0 : near >= 1 ? 4 : 6);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

function TreeCard({
  project,
  selected,
  near,
  onPress,
}: {
  project: FundProject;
  selected: boolean;
  /** NEAR equivalent of one tree at the live rate, or null when unpriced. */
  near: number | null;
  onPress: () => void;
}) {
  const money = useMoney();
  const need = NEED[project.needLevel];
  const price = money.formatOriginal(project.unitPriceMinor, project.currency);

  return (
    <Pressable
      accessibilityRole="radio"
      aria-checked={selected}
      accessibilityLabel={`${project.name}, ${need.label}. ${price} per tree${
        near === null ? '' : `, about ${formatNear(near)} NEAR`
      }.`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.treeCard,
        selected && styles.treeCardOn,
        pressed && styles.treeCardPressed,
      ]}
    >
      <View style={styles.treeHead}>
        <Text variant="title" style={styles.flex}>
          {project.name}
        </Text>
        {selected ? <Icon name={icon.checkCircle} size={18} color={colors.accent} /> : null}
      </View>
      <View style={styles.needRow}>
        <View style={[styles.needDot, { backgroundColor: needTint(need.tone) }]} />
        <Text variant="caption" tone={need.tone}>
          {need.label}
        </Text>
      </View>
      <Text variant="caption" tone="muted" numberOfLines={3}>
        {project.latinName}
        {project.thaiName ? ` (${project.thaiName})` : ''} — {project.story}
      </Text>
      <Text variant="label" tone="accent">
        {price} / tree
      </Text>
      {near === null ? null : (
        <Text variant="caption" tone="muted">
          ≈ {formatNear(near)} NEAR
        </Text>
      )}
    </Pressable>
  );
}

function needTint(tone: 'warn' | 'danger' | 'muted'): string {
  if (tone === 'warn') return colors.warn;
  if (tone === 'danger') return colors.danger;
  return colors.mutedDim;
}

function DeedRow({ deed, onPress }: { deed: FundDeed; onPress: () => void }) {
  const money = useMoney();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${deed.qty} ${deed.projectName}, deed ${deed.deedRef}. Open the transfer on NEAR.`}
      onPress={onPress}
      style={({ pressed }) => [styles.deedRow, pressed && styles.deedRowPressed]}
    >
      <View style={styles.deedDisc}>
        <Icon name={icon.leaf} size={15} color={colors.accent} />
      </View>
      <View style={styles.flex}>
        <Text variant="label" numberOfLines={1}>
          {deed.qty} × {deed.projectName}
        </Text>
        <Text variant="caption" tone="muted" numberOfLines={1}>
          {formatDay(deed.createdAt)} · Deed {deed.deedRef}
        </Text>
      </View>
      <View style={styles.deedRight}>
        <Text variant="mono" numberOfLines={1}>
          {shortToken(deed.amountDisplay)} {ASSET_LABEL[deed.asset]}
        </Text>
        <Text variant="caption" tone="muted">
          {money.formatOriginal(deed.amountMinor, deed.currency)}
        </Text>
      </View>
    </Pressable>
  );
}

export default function FundScreen() {
  const catalogue = useFundCatalogue();
  const giving = useFundDeeds();
  const requestQuote = useRequestFundQuote();
  const settleDeed = useSettleFundDeed();
  // The NEAR spot row only rides on the USD table (`server/src/lib/fx.ts`).
  const fx = useFxRates('USD');
  const notify = useMascotToast();
  const money = useMoney();

  const [projectId, setProjectId] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [assetChoice, setAssetChoice] = useState<FundAsset>('usdc');
  const [quote, setQuote] = useState<FundQuote | null>(null);
  const [txHash, setTxHash] = useState('');
  const [settling, setSettling] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const projects = catalogue.data?.projects ?? [];
  const assets = catalogue.data?.assets ?? [];
  const treasury = catalogue.data?.treasuryAccount ?? null;
  const selected =
    projects.find((project) => project.id === projectId) ?? projects[0] ?? null;
  const asset: FundAsset = assets.includes(assetChoice) ? assetChoice : assets[0] ?? 'near';

  const deeds = giving.data?.deeds ?? [];
  const givenMinor = giving.data?.totalMinor ?? 0;
  const givenCurrency = deeds[0]?.currency ?? 'USD';
  const draftMinor = (selected?.unitPriceMinor ?? 0) * qty;
  const draftLabel = money.formatOriginal(draftMinor, selected?.currency ?? 'USD');

  /**
   * NEAR per one major unit of `currency`, or null when the rate table has no
   * NEAR row. This is a display-only estimate; the quote still sets the charge.
   */
  function nearFor(amountMinor: number, currency: string): number | null {
    const rate = crossRate(fx.data?.rates ?? null, currency, 'NEAR');
    if (rate === null || rate <= 0) return null;
    const near = (amountMinor / 10 ** currencyExponent(currency)) * rate;
    return Number.isFinite(near) && near > 0 ? near : null;
  }

  const draftNear = nearFor(draftMinor, selected?.currency ?? 'USD');
  const givenNear = nearFor(givenMinor, givenCurrency);

  function chooseProject(project: FundProject) {
    haptics.select();
    setProjectId(project.id);
    setQuote(null);
    setTxHash('');
    setNotice(null);
  }

  function chooseQty(next: number) {
    haptics.select();
    setQty(next);
    setQuote(null);
    setTxHash('');
  }

  function chooseAsset(next: FundAsset) {
    haptics.select();
    setAssetChoice(next);
    setQuote(null);
    setTxHash('');
  }

  /** The API verified the transfer; the deed is the receipt, not the promise. */
  async function recordDeed(frozen: FundQuote, hash: string) {
    setSettling(true);
    setError(null);
    try {
      const result = await settleDeed.mutateAsync({ quoteId: frozen.quoteId, txHash: hash });
      setQuote(null);
      setTxHash('');
      setNotice({
        text: result.alreadySettled
          ? `That transfer was already recorded — deed ${result.deed.deedRef} stands.`
          : `${result.deed.qty} × ${result.deed.projectName} adopted. Deed ${result.deed.deedRef} is written.${
              result.mcpDeedRef ? ` Living Deed ${result.mcpDeedRef}.` : ''
            }`,
        explorerUrl: result.explorerUrl,
      });
      haptics.success();
      notify({
        title: 'Deed written',
        body: `${result.deed.qty} × ${result.deed.projectName} · ${result.deed.deedRef}`,
      });
    } catch (cause) {
      setError(asError(cause, 'Could not verify the transfer'));
    } finally {
      setSettling(false);
    }
  }

  /**
   * Freeze the price first, then let the wallet pay it. On the web the wallet
   * signs over this screen and returns a hash; on native it opens elsewhere, so
   * the same quote is handed to the paste-the-hash panel instead.
   */
  async function give() {
    if (!selected) return;
    setError(null);
    setNotice(null);
    setQuote(null);

    let frozen: FundQuote;
    try {
      frozen = await requestQuote.mutateAsync({ projectId: selected.id, qty, asset });
    } catch (cause) {
      setError(asError(cause, 'Could not price that gift'));
      return;
    }

    if (IS_NATIVE) {
      setQuote(frozen);
      return;
    }

    setSettling(true);
    try {
      const outcome =
        frozen.asset === 'usdc'
          ? await payNearTransfer({
              receiverId: frozen.treasuryAccount,
              amount: frozen.amountDisplay,
            })
          : await payNearNativeTransfer({
              receiverId: frozen.treasuryAccount,
              deposit: frozen.chainAmount,
            });

      if (outcome.status === 'cancelled') return;
      if (outcome.status === 'error') {
        setError(new Error(outcome.message));
        return;
      }
      await recordDeed(frozen, outcome.txHash);
    } finally {
      setSettling(false);
    }
  }

  async function confirmNative() {
    if (!quote) return;
    const hash = txHash.trim();
    if (!hash) return;
    await recordDeed(quote, hash);
  }

  return (
    <Screen
      header={{ title: 'Globie Fund', subtitle: 'Adopt a tree in the Isaan sanctuary.' }}
    >
      <Card tone="accent">
        <View style={styles.heroRow}>
          <View style={styles.heroCopy}>
            <Text variant="label" tone="muted">
              Given to the sanctuary
            </Text>
            <Text variant="figure">{money.formatOriginal(givenMinor, givenCurrency)}</Text>
            <Text variant="caption" tone="muted">
              {giving.data?.totalTrees ?? 0}{' '}
              {giving.data?.totalTrees === 1 ? 'tree' : 'trees'} adopted · {deeds.length}{' '}
              {deeds.length === 1 ? 'gift' : 'gifts'}
            </Text>
            {givenNear === null ? null : (
              <Text variant="caption" tone="muted">
                ≈ {formatNear(givenNear)} NEAR given at the live rate
              </Text>
            )}
          </View>
          <View style={styles.heroGlyph}>
            <BabyKaeNa size={56} variant="face" label={null} />
          </View>
        </View>
      </Card>

      {notice ? (
        <Card>
          <SuccessPulse title="Deed written" body={notice.text} />
          {notice.explorerUrl ? (
            <Button
              variant="secondary"
              compact
              icon={icon.near}
              title="View on NEAR"
              onPress={() => void WebBrowser.openBrowserAsync(notice.explorerUrl!)}
              style={styles.inline}
            />
          ) : null}
        </Card>
      ) : null}

      {error ? (
        <View accessibilityLiveRegion="polite" style={styles.errorBox}>
          <View style={styles.errorHead}>
            <Icon name={icon.warning} size={16} color={colors.danger} />
            <Text variant="label" tone="danger">
              {headline(error)}
            </Text>
          </View>
          <Text variant="caption" tone="danger">
            {error.message}
          </Text>
        </View>
      ) : null}

      <SectionHeading
        glyph={icon.leaf}
        title="Who to adopt"
        hint="Live from the sanctuary."
      />

      {catalogue.isLoading ? (
        <View style={styles.list} accessibilityElementsHidden>
          <Skeleton height={132} />
          <Skeleton height={120} />
        </View>
      ) : catalogue.error ? (
        <Card>
          <Text variant="title">Could not load the sanctuary</Text>
          <Text variant="body" tone="muted">
            {catalogue.error.message}
          </Text>
          <Button
            variant="secondary"
            compact
            icon={icon.refresh}
            title="Try again"
            onPress={() => catalogue.refetch()}
            style={styles.inline}
          />
        </Card>
      ) : !treasury ? (
        <EmptyState
          icon={icon.leafOutline}
          title="Gifts are not open yet"
          body="The sanctuary has not linked a NEAR account for gifts. Once it does, every gift goes straight to it from your own wallet."
        />
      ) : projects.length === 0 ? (
        <EmptyState
          icon={icon.leafOutline}
          title="No trees on the list"
          body="The sanctuary has not published what it needs right now. Check back soon."
        />
      ) : (
        <>
          <View style={styles.treeRow}>
            {projects.map((project) => (
              <TreeCard
                key={project.id}
                project={project}
                selected={selected?.id === project.id}
                near={nearFor(project.unitPriceMinor, project.currency)}
                onPress={() => chooseProject(project)}
              />
            ))}
          </View>

          <Card>
            <SectionHeading glyph={icon.gift} title="Your gift" hint="Every gift plants real trees." />

            <Text variant="label" tone="muted">
              Trees
            </Text>
            <View style={styles.chipRow}>
              {QTY_CHOICES.map((choice) => (
                <Pressable
                  key={choice}
                  accessibilityRole="radio"
                  aria-checked={qty === choice}
                  accessibilityLabel={`${choice} ${choice === 1 ? 'tree' : 'trees'}`}
                  onPress={() => chooseQty(choice)}
                  style={[styles.chip, qty === choice && styles.chipOn]}
                >
                  <Text variant="label" tone={qty === choice ? 'accent' : 'muted'}>
                    {choice}
                  </Text>
                </Pressable>
              ))}
            </View>

            {assets.length > 1 ? (
              <>
                <Text variant="label" tone="muted">
                  Pay with
                </Text>
                <View style={styles.chipRow}>
                  {assets.map((choice) => (
                    <Pressable
                      key={choice}
                      accessibilityRole="radio"
                      aria-checked={asset === choice}
                      accessibilityLabel={`Pay with ${ASSET_LABEL[choice]}`}
                      onPress={() => chooseAsset(choice)}
                      style={[styles.chip, asset === choice && styles.chipOn]}
                    >
                      <Text variant="label" tone={asset === choice ? 'accent' : 'muted'}>
                        {ASSET_LABEL[choice]}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </>
            ) : null}

            <View style={styles.draftRow}>
              <Text variant="caption" tone="muted" style={styles.flex}>
                You&apos;ll adopt {qty} × {selected?.name} · {draftLabel}
              </Text>
              {draftNear === null ? null : (
                <Text variant="label" tone="accent">
                  ≈ {formatNear(draftNear)} NEAR
                </Text>
              )}
            </View>

            <Button
              title={`Donate ${draftLabel}`}
              icon={asset === 'near' ? icon.near : icon.cash}
              loading={settling || requestQuote.isPending}
              disabled={!selected || requestQuote.isPending || settling}
              onPress={() => void give()}
            />
            <Text variant="caption" tone="muted" style={styles.centered}>
              Paid straight into the sanctuary&apos;s {ASSET_LABEL[asset]} account from your
              own wallet. The deed is written the moment it clears — no processor holds the
              money.
            </Text>
          </Card>

          {quote && IS_NATIVE ? (
            <Card tone="alt">
              <SectionHeading
                glyph={icon.near}
                title="Pay from your wallet"
                hint="Send the exact amount, then paste the hash."
              />
              <View style={styles.payLines}>
                <View style={styles.payLine}>
                  <Text variant="caption" tone="muted">
                    To
                  </Text>
                  <Text variant="mono" numberOfLines={1} style={styles.flex}>
                    {quote.treasuryAccount}
                  </Text>
                </View>
                <View style={styles.payLine}>
                  <Text variant="caption" tone="muted">
                    Amount
                  </Text>
                  <Text variant="mono">
                    {quote.amountDisplay} {ASSET_LABEL[quote.asset]}
                  </Text>
                </View>
              </View>
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
                onSubmitEditing={() => void confirmNative()}
              />
              <Button
                title="Confirm payment"
                compact
                icon={icon.check}
                loading={settling}
                disabled={txHash.trim().length === 0 || settling}
                onPress={() => void confirmNative()}
              />
            </Card>
          ) : null}
        </>
      )}

      <SectionHeading
        glyph={icon.receipt}
        title="Your giving"
        hint={`${deeds.length} ${deeds.length === 1 ? 'deed' : 'deeds'}`}
      />

      {giving.isLoading ? (
        <View style={styles.list} accessibilityElementsHidden>
          <Skeleton height={64} />
          <Skeleton height={64} />
        </View>
      ) : giving.error ? (
        <Card>
          <Text variant="body" tone="muted">
            {giving.error.message}
          </Text>
          <Button
            variant="secondary"
            compact
            icon={icon.refresh}
            title="Try again"
            onPress={() => giving.refetch()}
            style={styles.inline}
          />
        </Card>
      ) : deeds.length === 0 ? (
        <Text variant="caption" tone="muted">
          No gifts yet. The first deed is written the moment a transfer clears on NEAR.
        </Text>
      ) : (
        <View style={styles.list}>
          {deeds.map((deed) => (
            <DeedRow
              key={deed.id}
              deed={deed}
              onPress={() => void WebBrowser.openBrowserAsync(deed.explorerUrl)}
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
  draftRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  heroGlyph: {
    width: 58,
    height: 58,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: { gap: space.sm },
  treeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  treeCard: {
    flex: 1,
    minWidth: 150,
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  treeCardOn: {
    borderColor: 'rgba(110, 240, 190, 0.45)',
    backgroundColor: colors.surface,
  },
  treeCardPressed: { backgroundColor: colors.surfaceHi },
  treeHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  needRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  needDot: { width: 6, height: 6, borderRadius: radius.pill },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minWidth: 52,
    alignItems: 'center',
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  chipOn: {
    borderColor: 'rgba(110, 240, 190, 0.45)',
    backgroundColor: colors.wash,
  },
  payLines: { gap: space.xs },
  payLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  deedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceAlt,
  },
  deedRowPressed: { backgroundColor: colors.surface },
  deedDisc: {
    width: 26,
    height: 26,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.wash,
  },
  deedRight: { alignItems: 'flex-end', gap: 1 },
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
  centered: { textAlign: 'center' },
  flex: { flex: 1 },
  inline: { alignSelf: 'flex-start' },
});
