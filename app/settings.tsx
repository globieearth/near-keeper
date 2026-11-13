import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { Platform, StyleSheet, Switch, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Icon, icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { SectionHeading } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { isNearAccountId } from '@/lib/near';
import { hasPushTarget, pushSupported, registerForPush, type PushOutcome } from '@/lib/push';
import {
    queryKeys,
    useLinkNearAccount,
    useMyProfile,
    useNearStatus,
    useNotificationSettings,
    useUpdateNotificationChannel,
    type NotificationChannel,
} from '@/lib/queries';

/** One sentence per channel, written from the member's side of the nudge. */
const COPY: Record<NotificationChannel, { title: string; body: string }> = {
  in_app: {
    title: 'In the app',
    body: 'A card in Activity, on every device you sign in to.',
  },
  push: {
    title: 'Push to this phone',
    body: 'A banner on the lock screen, even with the app closed.',
  },
  email: {
    title: 'Email',
    body: 'A message to the address on your account.',
  },
  whatsapp: {
    title: 'WhatsApp',
    body: 'A message from the Globie Keeper number.',
  },
};

/**
 * Why a promised channel cannot fire for this member, in the member's terms.
 * `available` means the server can deliver at all; push also needs a device and
 * an Expo project, so a browser can never satisfy it.
 */
function channelBody(channel: NotificationChannel, available: boolean): string {
  if (available) return COPY[channel].body;
  switch (channel) {
    case 'push':
      return pushSupported()
        ? 'This build is not linked to an Expo project yet, so push cannot be delivered.'
        : 'Browsers cannot receive push. Your reminders wait in Activity.';
    case 'email':
      return 'Globie is not sending email yet. Your reminders wait in Activity.';
    case 'whatsapp':
      return 'Globie is not sending WhatsApp yet. Your reminders wait in Activity.';
    case 'in_app':
      return 'In-app reminders are switched off on this server.';
  }
}

/** The reason the "Turn on push" button cannot be pressed here. */
function pushBlockedReason(): string | null {
  if (!pushSupported()) {
    return 'This is the web build, which cannot receive push. Globie keeps your reminders in Activity.';
  }
  if (!hasPushTarget()) {
    return 'This build is not linked to an Expo project yet, so it cannot register for push.';
  }
  return null;
}

function pushNotice(outcome: PushOutcome): string {
  switch (outcome.status) {
    case 'registered':
      return 'This phone will get Globie reminders.';
    case 'unsupported':
      return 'This browser gets in-app reminders and email. Push needs the mobile app.';
    case 'denied':
      return 'Globie Keeper is not allowed to notify on this device. Allow it in system settings, then try again.';
    case 'unconfigured':
      return 'Push is not configured for this build yet.';
    case 'failed':
      return outcome.message;
  }
}

export default function SettingsScreen() {
  const settings = useNotificationSettings();
  const update = useUpdateNotificationChannel();
  const profile = useMyProfile();
  const nearRail = useNearStatus();
  const linkNear = useLinkNearAccount();
  const client = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [nearDraft, setNearDraft] = useState<string | null>(null);

  // The NEAR account lives in `/me`, so the rail's status is only used for
  // `configured` / `network`; the linked value itself comes from the profile.
  const savedNear = profile.data?.nearAccount ?? '';
  const nearValue = nearDraft ?? savedNear;
  const nearTyped = (nearDraft ?? '').trim();
  const nearDirty = nearDraft !== null && nearTyped !== savedNear;
  const nearInvalid = nearTyped !== '' && !isNearAccountId(nearTyped);

  const canPush = pushSupported() && hasPushTarget();
  const blockedPush = pushBlockedReason();

  async function saveNear() {
    const next = (nearDraft ?? '').trim();
    if (!isNearAccountId(next)) return;
    try {
      await linkNear.mutateAsync(next);
      setNearDraft(null);
    } catch {
      // The mutation error renders under the field; keep the draft for a retry.
    }
  }

  async function unlinkNear() {
    try {
      await linkNear.mutateAsync(null);
      setNearDraft(null);
    } catch {
      // Same as above.
    }
  }

  async function enablePush() {
    setAsking(true);
    setNotice(null);
    const outcome = await registerForPush();
    setAsking(false);
    if (outcome.status === 'registered') {
      await client.invalidateQueries({ queryKey: queryKeys.myNotifications });
    }
    setNotice(pushNotice(outcome));
  }

  return (
    <Screen
      header={{
        title: 'Settings',
        subtitle: 'Where you get paid, and where Globie nudges you.',
        back: true,
      }}
      bottomInset={space.xl}
    >
      <Card>
        <SectionHeading
          glyph={icon.near}
          title="NEAR account"
          hint="Settle in USDC on the NEAR rail, straight from your own wallet. Globie never holds a key."
        />
        {nearRail.isLoading || profile.isLoading ? (
          <Skeleton height={76} />
        ) : nearRail.data && !nearRail.data.configured ? (
          <Text variant="caption" tone="muted">
            This server has no NEAR rail configured, so payments cannot be settled yet.
          </Text>
        ) : (
          <>
            <Field
              label="Your NEAR account"
              hint={
                savedNear
                  ? `Linked on ${nearRail.data?.network ?? 'NEAR'}. Money only moves when your wallet signs.`
                  : 'The account you pay from. Linking it moves nothing; you approve every transfer in your wallet.'
              }
              value={nearValue}
              onChangeText={setNearDraft}
              placeholder={nearRail.data?.network === 'mainnet' ? 'nok.near' : 'nok.testnet'}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={() => {
                if (nearDirty && !nearInvalid) void saveNear();
              }}
              editable={!linkNear.isPending}
              error={
                linkNear.error
                  ? linkNear.error.message
                  : nearInvalid
                    ? 'That is not a NEAR account ID.'
                    : undefined
              }
            />
            <Button
              title="Save NEAR account"
              icon={icon.check}
              variant="secondary"
              compact
              onPress={() => void saveNear()}
              loading={linkNear.isPending}
              disabled={!nearDirty || nearInvalid}
              style={styles.inline}
            />
            {savedNear ? (
              <View style={styles.status}>
                <Icon
                  name={profile.data?.nearVerified ? icon.checkCircle : icon.time}
                  size={16}
                  color={profile.data?.nearVerified ? colors.accent : colors.muted}
                />
                <Text
                  variant="body"
                  tone={profile.data?.nearVerified ? 'accent' : 'muted'}
                  style={styles.flex}
                >
                  {profile.data?.nearVerified
                    ? 'Verified on NEAR.'
                    : 'Saved. It is verified the first time your wallet signs for it.'}
                </Text>
              </View>
            ) : null}
            {savedNear ? (
              <Button
                title="Unlink NEAR account"
                icon={icon.close}
                variant="ghost"
                compact
                onPress={() => void unlinkNear()}
                disabled={linkNear.isPending}
                style={styles.inline}
              />
            ) : null}
          </>
        )}
      </Card>

      {settings.isLoading ? (
        <View style={styles.list} accessibilityElementsHidden>
          <Skeleton height={72} />
          <Skeleton height={72} />
        </View>
      ) : settings.error ? (
        <Card>
          <Text variant="title">Could not load your reminders</Text>
          <Text variant="body" tone="muted">
            {settings.error.message}
          </Text>
          <Button
            variant="secondary"
            compact
            icon={icon.refresh}
            title="Try again"
            onPress={() => settings.refetch()}
            style={styles.inline}
          />
        </Card>
      ) : (
        <Card>
          <SectionHeading
            glyph={icon.bell}
            title="Where to reach me"
            hint="Quiet hours are 22:00 to 08:00, wherever you are."
          />
          <View style={styles.rows}>
            {(settings.data?.channels ?? []).map((row) => {
              const copy = COPY[row.channel];
              return (
                <View key={row.channel} style={styles.row}>
                  <View style={styles.copy}>
                    <Text variant="label">{copy.title}</Text>
                    <Text variant="caption" tone="dim">
                      {channelBody(row.channel, row.available)}
                    </Text>
                  </View>
                  <Switch
                    accessibilityLabel={copy.title}
                    value={row.enabled && row.available}
                    disabled={!row.available || update.isPending}
                    onValueChange={(next) => update.mutate({ channel: row.channel, enabled: next })}
                    trackColor={{ false: colors.surfaceHi, true: colors.accentDeep }}
                    thumbColor={row.enabled && row.available ? colors.accent : colors.mutedDim}
                  />
                </View>
              );
            })}
          </View>
          {update.error ? (
            <Text variant="caption" tone="danger" accessibilityLiveRegion="polite">
              {update.error.message}
            </Text>
          ) : null}
        </Card>
      )}

      <Card>
        <SectionHeading
          glyph={icon.phone}
          title="This device"
          hint={
            Platform.OS === 'web'
              ? 'Browsers cannot receive push; the in-app feed covers it.'
              : 'One handset, one account.'
          }
        />
        {settings.data?.pushRegistered ? (
          <View style={styles.status}>
            <Icon name={icon.checkCircle} size={16} color={colors.accent} />
            <Text variant="body" tone="accent" style={styles.flex}>
              Push is on for this device.
            </Text>
          </View>
        ) : (
          <>
            <Button
              title="Turn on push"
              icon={icon.bell}
              variant="secondary"
              onPress={enablePush}
              loading={asking}
              disabled={!canPush}
            />
            {blockedPush ? (
              <Text variant="caption" tone="dim">
                {blockedPush}
              </Text>
            ) : null}
          </>
        )}
        {notice ? (
          <Text variant="caption" tone="muted" accessibilityLiveRegion="polite">
            {notice}
          </Text>
        ) : null}
      </Card>

      <Card>
        <SectionHeading
          glyph={icon.bulb}
          title="How Globie works"
          hint="The manual for every screen, in one place — and Globie can read it back to you."
        />
        <Button
          title="Open the manual"
          icon={icon.arrowForward}
          iconSide="right"
          variant="secondary"
          compact
          onPress={() => router.push('/help')}
          style={styles.inline}
        />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.sm },
  rows: { gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  copy: { flex: 1, gap: 2 },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(110, 240, 190, 0.28)',
    backgroundColor: colors.wash,
  },
  flex: { flex: 1 },
  inline: { alignSelf: 'flex-start' },
});
