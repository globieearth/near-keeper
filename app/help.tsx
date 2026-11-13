import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Icon, icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { useHelpTopics } from '@/lib/queries';
import { useSession } from '@/lib/session-context';
import type { HelpAudience, HelpTopic } from '@/lib/types';

const AUDIENCE: Record<HelpAudience, string> = {
  everyone: 'Everyone',
  members: 'Members',
  fronters: 'Fronters',
};

/** A route with a `[param]` cannot be opened without that value. */
function openable(topic: HelpTopic): boolean {
  return Boolean(topic.screen && !topic.screen.includes('['));
}

function matches(topic: HelpTopic, query: string): boolean {
  if (!query) return true;
  const haystack = [topic.title, topic.summary, ...topic.steps].join(' ').toLowerCase();
  return haystack.includes(query);
}

export default function HelpScreen() {
  const help = useHelpTopics();
  const { session } = useSession();
  const params = useLocalSearchParams<{ topic?: string }>();
  const [query, setQuery] = useState('');
  // `undefined` means "follow the deep link"; a tap replaces it, and `null`
  // means the reader asked for the whole list.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);

  const selectedId = picked === undefined ? params.topic ?? null : picked;
  const topics = useMemo(() => help.data?.topics ?? [], [help.data]);
  const selected = topics.find((topic) => topic.id === selectedId) ?? null;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return topics.filter((topic) => matches(topic, needle));
  }, [topics, query]);

  return (
    <Screen
      header={{
        title: 'How Globie works',
        subtitle: 'The manual for every screen, kept in one place.',
        back: true,
      }}
      bottomInset={space.xl}
    >
      {help.isLoading ? (
        <>
          <Skeleton height={52} />
          <Skeleton height={96} />
          <Skeleton height={96} />
        </>
      ) : help.error ? (
        <Card>
          <Text variant="title">Could not load the manual</Text>
          <Text variant="body" tone="muted">
            {help.error.message}
          </Text>
          <Button
            title="Try again"
            icon={icon.refresh}
            variant="secondary"
            compact
            onPress={() => help.refetch()}
            style={styles.inline}
          />
        </Card>
      ) : selected ? (
        <TopicPage
          topic={selected}
          topics={topics}
          canOpen={Boolean(session) && openable(selected)}
          onAll={() => setPicked(null)}
          onSelect={setPicked}
        />
      ) : (
        <>
          <Field
            label="Search the manual"
            value={query}
            onChangeText={setQuery}
            placeholder="wallets, receipts, paying, points…"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />

          {filtered.length === 0 ? (
            <Card>
              <Text variant="title">No page matches that</Text>
              <Text variant="body" tone="muted">
                Try a shorter word, or ask Globie in the chat — it reads this same manual.
              </Text>
            </Card>
          ) : (
            filtered.map((topic, index) => (
              <Pressable
                key={topic.id}
                accessibilityRole="button"
                accessibilityLabel={`${topic.title}. ${topic.summary}`}
                onPress={() => setPicked(topic.id)}
              >
                <Card enter={index}>
                  <View style={styles.row}>
                    <View style={styles.copy}>
                      <Text variant="label">{topic.title}</Text>
                      <Text variant="caption" tone="dim">
                        {topic.summary}
                      </Text>
                    </View>
                    <Icon name={icon.chevronRight} size={18} color={colors.muted} />
                  </View>
                </Card>
              </Pressable>
            ))
          )}
        </>
      )}
    </Screen>
  );
}

type TopicPageProps = {
  topic: HelpTopic;
  topics: HelpTopic[];
  canOpen: boolean;
  onAll: () => void;
  onSelect: (id: string) => void;
};

function TopicPage({ topic, topics, canOpen, onAll, onSelect }: TopicPageProps) {
  const related = topic.related
    .map((id) => topics.find((entry) => entry.id === id))
    .filter((entry): entry is HelpTopic => Boolean(entry));

  return (
    <>
      <Button
        title="All topics"
        icon={icon.chevronBack}
        variant="ghost"
        compact
        onPress={onAll}
        style={styles.inline}
      />

      <Card tone="accent">
        <Text variant="caption" tone="accent">
          {AUDIENCE[topic.audience]}
        </Text>
        <Text variant="title">{topic.title}</Text>
        <Text variant="body" tone="muted">
          {topic.summary}
        </Text>
      </Card>

      <Card>
        <Text variant="label" tone="muted">
          Step by step
        </Text>
        {topic.steps.map((step, index) => (
          <View key={step} style={styles.step}>
            <View style={styles.badge}>
              <Text variant="caption" tone="accent">
                {index + 1}
              </Text>
            </View>
            <Text variant="body" style={styles.copy}>
              {step}
            </Text>
          </View>
        ))}
        {canOpen && topic.screen ? (
          <Button
            title="Open it in the app"
            icon={icon.arrowForward}
            iconSide="right"
            variant="secondary"
            compact
            onPress={() => router.push(topic.screen as Href)}
            style={styles.inline}
          />
        ) : null}
      </Card>

      {related.length > 0 ? (
        <Card tone="alt">
          <Text variant="label" tone="muted">
            Related
          </Text>
          <View style={styles.chips}>
            {related.map((entry) => (
              <Pressable
                key={entry.id}
                accessibilityRole="button"
                accessibilityLabel={`Read ${entry.title}`}
                onPress={() => onSelect(entry.id)}
                style={styles.chip}
              >
                <Text variant="caption">{entry.title}</Text>
              </Pressable>
            ))}
          </View>
        </Card>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  copy: { flex: 1, gap: space.xs },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  badge: {
    width: 24,
    height: 24,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.wash,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  inline: { alignSelf: 'flex-start' },
});
