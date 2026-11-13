import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Icon, icon } from '@/components/ui/icon';
import { BabyKaeNa } from '@/components/ui/mascot';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { stagger } from '@/components/ui/transitions';
import { formatMinor } from '@/lib/money';
import { useAgentChat, useAgentMessage } from '@/lib/queries';
import type {
    AgentResponse,
    AgentToolName,
    AgentTurn,
    Member,
    ReminderTone,
    Share
} from '@/lib/types';

type Props = {
  /** The group this chat belongs to, so a member's prompts can open its bill. */
  groupId: string;
  agreementId: string | null;
  billId: string | null;
  billStatus: string | null;
  currency: string;
  members: Member[];
  /** Only the member who fronted the expense may steer the bill. */
  isFronter: boolean;
  /** The signed-in member, so Globie can talk to them by name. */
  memberName: string;
};

type Message = { id: string; from: 'you' | 'globie'; text: string };

type Pending = { tool: AgentToolName; args: Record<string, unknown>; token: string };

type Choice = {
  action: 'reminder' | 'payment' | 'award';
  tone: ReminderTone;
  shares: Share[];
};

/**
 * A prompt under the composer: either a line for Globie, or a plain navigation
 * for the member's own share/bill — which never reaches the agent at all.
 */
type Quick = { label: string; onPress?: () => void };

type Intent =
  | { kind: 'help' }
  | { kind: 'read_receipt' }
  | { kind: 'split' }
  | { kind: 'confirm_lines' }
  | { kind: 'status' }
  | { kind: 'remind'; tone: ReminderTone; memberHint: string | null }
  | { kind: 'payment_request'; memberHint: string | null }
  | { kind: 'points'; memberHint: string | null }
  | { kind: 'unknown' };

/** A bill can still be re-split until it is finalized (DEV_PLAN §2.6). */
const SPLITTABLE = new Set(['UPLOADED', 'PARSING', 'PARSED', 'ALLOCATED', 'CONFIRMED']);
const OPEN_SHARE = (share: Share) =>
  !['paid', 'settled', 'refunded'].includes(share.status);
const PAID_SHARE = (share: Share) => ['paid', 'settled'].includes(share.status);

/** Globie talks to a person, not an account: "Somchai", not "Somchai K.". */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || 'there';
}

/** What a parked confirmation will actually do, in words the member can weigh. */
const toolCopy: Record<AgentToolName, string> = {
  parse_receipt_media: 'Re-read the expense',
  propose_allocation: 'Propose a split',
  request_item_confirmation: 'Ask everyone to confirm their lines',
  create_payment_request: 'Request a NEAR transfer',
  get_bill_status: 'Check who still owes',
  send_reminder: 'Send a nudge',
  award_points: 'Award Globie points',
  explain_feature: 'Explain how it works',
};

/**
 * The conversational surface over `POST /api/agent/message` (DEV_PLAN §2.11,
 * §2.22).
 *
 * Globie is deterministic, so the composer maps a plain-language line onto one
 * of the eight tools and shows the server's reply — which the server writes in
 * Globie's own voice from the tool's ground truth. Anything that moves money or
 * messages a member comes back as `confirmationRequired` and is only replayed —
 * with the same arguments — after the user taps Confirm. A line that maps onto
 * no tool goes to `POST /api/agent/chat`, which can explain the state but
 * cannot change it.
 */
export function GlobieChat({
  groupId,
  agreementId,
  billId,
  billStatus,
  currency,
  members,
  isFronter,
  memberName,
}: Props) {
  const agent = useAgentMessage();
  const agentChat = useAgentChat();
  const busy = agent.isPending || agentChat.isPending;

  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'm0',
      from: 'globie',
      text: isFronter
        ? `${firstName(memberName)}, I have the books for this group. Ask me where things stand, who owes, or tell me to split, chase, or request.`
        : `${firstName(memberName)}, I have the books for this group. Ask me where things stand or who owes — pay your share from the My shares tab.`,
    },
  ]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The last few turns, so a follow-up ("and Bob?") has something to point at. */
  const [turns, setTurns] = useState<AgentTurn[]>([]);
  /** What the member typed, carried into the tool call so the reply can answer it. */
  const lastSaid = useRef<string | null>(null);
  /** Enter and the Send button can both fire in one tick; this keeps it one send. */
  const inFlight = useRef(false);

  const collected = billStatus === 'FINALIZED' || billStatus === 'COLLECTING';
  const splittable = Boolean(billId) && SPLITTABLE.has(billStatus ?? '');

  // Steering the bill is the fronter's job; a member only gets their own three
  // moves — see what is owed, pay their share, open the bill (§2.11, §2.19).
  const quick: Quick[] = [];
  if (isFronter) {
    if (splittable) {
      quick.push({ label: 'Split the bill' }, { label: 'Ask everyone to confirm' });
    }
    if (collected) {
      quick.push({ label: 'Who still owes?' }, { label: 'Nudge the late payer' });
      if (agreementId) quick.push({ label: 'Ask everyone to pay' });
    }
  } else if (billId) {
    quick.push(
      { label: 'Who still owes?' },
      { label: 'Pay my share', onPress: () => router.push('/me/shares') },
      {
        label: 'Open the bill',
        onPress: () =>
          router.push({ pathname: '/groups/[id]/bill', params: { id: groupId, billId } }),
      }
    );
  }

  function say(from: Message['from'], text: string) {
    // Derive the id from the appended position: a ref counter can restart at 0
    // while `messages` survives (Fast Refresh), which produced duplicate keys.
    setMessages((current) => [...current, { id: `m${current.length}`, from, text }]);
    setTurns((current) => [...current, { from, text }]);
  }

  /** One tool call; a confirmation challenge is parked until the user taps. */
  async function run(
    tool: AgentToolName,
    args: Record<string, unknown>,
    confirmToken?: string | null
  ): Promise<AgentResponse> {
    const response = await agent.mutateAsync({
      tool,
      args,
      confirmToken,
      say: lastSaid.current,
      history: turns,
    });
    setPending(
      response.confirmationRequired && response.confirmToken
        ? { tool, args, token: response.confirmToken }
        : null
    );
    say('globie', response.reply);
    return response;
  }

  /** Ask the server for the shares of this bill without narrating the answer. */
  async function loadShares(): Promise<Share[]> {
    if (!billId) return [];
    const response = await agent.mutateAsync({
      tool: 'get_bill_status',
      args: { bill_id: billId },
      narrate: false,
    });
    const shares = response.result.shares;
    return Array.isArray(shares) ? (shares as Share[]) : [];
  }

  async function pickShare(action: Choice['action'], tone: ReminderTone, share: Share) {
    setChoice(null);
    setError(null);
    try {
      if (action === 'reminder') {
        await run('send_reminder', { share_id: share.id, tone });
      } else if (action === 'payment') {
        await run('create_payment_request', { bill_id: share.billId, share_id: share.id });
      } else if (agreementId) {
        await run('award_points', {
          agreement_id: agreementId,
          share_id: share.id,
          reason: 'globie',
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Globie could not do that.');
    }
  }

  async function collectShare(
    action: Choice['action'],
    tone: ReminderTone,
    memberHint: string | null
  ) {
    const shares = await loadShares();
    const pool = action === 'award' ? shares.filter(PAID_SHARE) : shares.filter(OPEN_SHARE);

    if (pool.length === 0) {
      say(
        'globie',
        action === 'award'
          ? 'Nothing has been paid yet, so there is nothing to award. Globie goes out once a share is paid.'
          : 'Everyone is paid up — nothing to chase.'
      );
      return;
    }

    const matches = memberHint
      ? pool.filter((share) => share.memberId === memberHint)
      : pool;

    if (matches.length === 0) {
      say('globie', 'They have no share in that state. Pick someone from the list.');
      setChoice({ action, tone, shares: pool });
      return;
    }
    if (matches.length === 1) {
      await pickShare(action, tone, matches[0]);
      return;
    }

    setChoice({ action, tone, shares: matches });
    say(
      'globie',
      action === 'reminder'
        ? 'Who should I nudge?'
        : action === 'payment'
          ? 'Which share should I request?'
          : 'Who should get the Globie?'
    );
  }

  async function submit(text: string) {
    const line = text.trim();
    if (!line || busy || inFlight.current) return;

    inFlight.current = true;
    setDraft('');
    setError(null);
    setPending(null);
    setChoice(null);
    lastSaid.current = line;
    say('you', line);

    const intent = parseIntent(line, members);

    try {
      // The manual is public: any member can ask, and no group state is read.
      if (intent.kind === 'help') {
        await run('explain_feature', { question: line });
        return;
      }

      if (intent.kind !== 'status' && intent.kind !== 'unknown' && !isFronter) {
        say(
          'globie',
          'That one is the fronter’s call — they fronted this expense. I can still tell you where the money stands, and you can pay your share from the My shares tab.'
        );
        return;
      }

      if (intent.kind === 'read_receipt' || intent.kind === 'split' || intent.kind === 'confirm_lines' || intent.kind === 'status') {
        if (!billId) {
          say('globie', 'There is nothing on the books yet — add the expense and I will take it from there.');
          return;
        }
        const tool: AgentToolName =
          intent.kind === 'read_receipt'
            ? 'parse_receipt_media'
            : intent.kind === 'split'
              ? 'propose_allocation'
              : intent.kind === 'confirm_lines'
                ? 'request_item_confirmation'
                : 'get_bill_status';
        await run(tool, { bill_id: billId });
        return;
      }

      if (intent.kind === 'remind') {
        if (!billId) {
          say('globie', 'There is nothing on the books yet — add the expense and I will take it from there.');
          return;
        }
        await collectShare('reminder', intent.tone, intent.memberHint);
        return;
      }

      if (intent.kind === 'payment_request') {
        if (!billId) {
          say('globie', 'There is nothing on the books yet — add the expense and I will take it from there.');
          return;
        }
        if (!collected) {
          say('globie', 'I can request transfers once the bill is finalised — finalise it and I will send them.');
          return;
        }
        await collectShare('payment', 'friendly', intent.memberHint);
        return;
      }

      if (intent.kind === 'points') {
        if (!agreementId) {
          say('globie', 'Points live on an agreement — create one and I will keep score.');
          return;
        }
        await collectShare('award', 'friendly', intent.memberHint);
        return;
      }

      // No tool matched, so there is nothing to execute. Answer from the state
      // this member is already allowed to read (DEV_PLAN §2.22).
      const chat = await agentChat.mutateAsync({
        say: line,
        history: turns,
        billId,
        agreementId,
      });
      say('globie', chat.reply);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Globie could not do that.');
    } finally {
      inFlight.current = false;
    }
  }

  async function confirm() {
    if (!pending) return;
    setError(null);
    try {
      await run(pending.tool, pending.args, pending.token);
    } catch (cause) {
      setPending(null);
      setError(cause instanceof Error ? cause.message : 'That confirmation did not go through.');
    }
  }

  return (
    <Card>
      <View style={styles.header}>
        <BabyKaeNa
          size={42}
          variant="badge"
          mood={busy ? 'cheer' : 'idle'}
          sparkles={false}
          label={null}
        />
        <View style={styles.headCopy}>
          <Text variant="title">Globie</Text>
          <Text variant="caption" tone="muted">
            {busy ? 'Working' : 'Acts only when you say so'}
          </Text>
        </View>
      </View>

      <View style={styles.messages}>
        {messages.map((message, index) => (
          <Animated.View
            key={message.id}
            entering={stagger(index, 40)}
            style={[styles.bubble, message.from === 'you' ? styles.youBubble : styles.globieBubble]}
          >
            <Text variant="caption" tone={message.from === 'you' ? 'ink' : 'muted'}>
              {message.from === 'you' ? 'You' : 'Globie'}
            </Text>
            <Text variant="body" tone={message.from === 'you' ? 'ink' : 'default'}>
              {message.text}
            </Text>
          </Animated.View>
        ))}
      </View>

      {pending ? (
        <View style={styles.confirm}>
          <View style={styles.confirmHead}>
            <Icon name={icon.hand} size={15} color={colors.warn} />
            <Text variant="label" tone="warn">
              Waiting on your OK
            </Text>
          </View>
          <Text variant="body">{toolCopy[pending.tool]}</Text>
          <View style={styles.actions}>
            <Button
              title="Confirm"
              compact
              icon={icon.check}
              onPress={() => void confirm()}
              loading={busy}
            />
            <Button
              title="Cancel"
              variant="secondary"
              compact
              disabled={busy}
              onPress={() => setPending(null)}
            />
          </View>
        </View>
      ) : null}

      {choice ? (
        <View style={styles.choices}>
          {choice.shares.map((share) => (
            <Button
              key={share.id}
              compact
              variant="secondary"
              title={`${share.memberName}, ${formatMinor(
                share.amountMinor,
                share.currency || currency
              )}`}
              disabled={busy}
              onPress={() => void pickShare(choice.action, choice.tone, share)}
            />
          ))}
        </View>
      ) : null}

      {quick.length > 0 && !pending && !choice ? (
        <View style={styles.choices}>
          {quick.map((item) => (
            <Button
              key={item.label}
              compact
              variant="secondary"
              title={item.label}
              disabled={busy}
              onPress={() => (item.onPress ? item.onPress() : void submit(item.label))}
            />
          ))}
        </View>
      ) : null}

      {error ? (
        <View accessibilityLiveRegion="polite" style={styles.errorBox}>
          <Icon name={icon.alert} size={14} color={colors.danger} />
          <Text variant="caption" tone="danger" style={styles.flex}>
            {error}
          </Text>
        </View>
      ) : null}

      <Field
        label="Ask Globie"
        value={draft}
        onChangeText={setDraft}
        placeholder="who still owes?"
        returnKeyType="send"
        onSubmitEditing={() => void submit(draft)}
        editable={!busy}
      />
      <Button title="Send" icon={icon.send} onPress={() => void submit(draft)} loading={busy} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Intent parsing
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Longest matching member name wins, so "Ben" never beats "Ben Carter". */
function findMember(text: string, members: Member[]): string | null {
  const matches = members
    .filter((member) => {
      const name = member.displayName.toLowerCase();
      const first = name.split(' ')[0] ?? name;
      if (text.includes(name)) return true;
      return (
        first.length >= 3 && new RegExp(`(^|\\W)${escapeRegExp(first)}(\\W|$)`).test(text)
      );
    })
    .sort((left, right) => right.displayName.length - left.displayName.length);
  return matches[0]?.id ?? null;
}

function toneOf(text: string): ReminderTone {
  if (/\bfinal\b/.test(text)) return 'final';
  if (/\bfirm\b/.test(text)) return 'firm';
  return 'friendly';
}

/** A question about how the app works, as opposed to an order for it. */
const HELP_QUESTION =
  /\b(help|manual|guide|tutorial|explain|walk me through)\b|\bhow (do|does|can|to)\b|\bwhat (is|are|does)\b/;

/** Action words win over "how do I …": the member is asking Globie to act. */
const HELP_ACTION =
  /\b(split|divide|confirm|nudge|remind|chase|poke|hurry|overdue|late|request|invoice|reimburse|points?|owes?|outstanding|unpaid)\b/;

/**
 * Keyword routing, in precedence order. Globie is deterministic by design —
 * the same sentence always picks the same tool, so the demo is repeatable.
 */
function parseIntent(raw: string, members: Member[]): Intent {
  const text = raw.toLowerCase();

  // Help comes first: "how do I add an expense" contains an action noun that the
  // receipt lane would otherwise claim (DEV_PLAN §2.23). An action verb in the
  // line still wins, so "how do I split the bill" keeps splitting.
  if (HELP_QUESTION.test(text) && !HELP_ACTION.test(text)) {
    return { kind: 'help' };
  }

  if (/\b(re-?read|scan|parse|ocr)\b|\bread (the |that |this )?(receipt|expense|invoice|bill)\b|\b(receipt|expense|invoice)\b/.test(text)) {
    return { kind: 'read_receipt' };
  }
  if (/\b(split|divide|who had what)\b/.test(text)) {
    return { kind: 'split' };
  }
  if (/\bconfirm\b.*\b(lines?|items?|orders?|shares?)\b|\bask (everyone|them|the group)\b/.test(text)) {
    return { kind: 'confirm_lines' };
  }
  if (/\b(nudge|remind(er)?|chase|poke|hurry|late|overdue)\b/.test(text)) {
    return { kind: 'remind', tone: toneOf(text), memberHint: findMember(text, members) };
  }
  // "Pay the fronter back" is a member-side reimbursement: the NEAR transfer
  // names the fronter as payee, so requesting the transfer is the whole action.
  if (
    /\brequest (payment|money)\b|\bsend .*\b(payment|request|invoice)\b|\binvoice\b/.test(text) ||
    /\bpay\b[^.!?]{0,24}\bback\b|\breimburse\b/.test(text)
  ) {
    return { kind: 'payment_request', memberHint: findMember(text, members) };
  }
  if (/\b(points?|globie)\b/.test(text)) {
    return { kind: 'points', memberHint: findMember(text, members) };
  }
  if (/\bstatus\b|\bwho (still )?owes?\b|\boutstanding\b|\bunpaid\b|\bhow much\b/.test(text)) {
    return { kind: 'status' };
  }
  return { kind: 'unknown' };
}

// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  headCopy: { flex: 1, gap: 1 },
  messages: { gap: space.sm },
  bubble: {
    gap: 2,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    maxWidth: '92%',
  },
  globieBubble: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderTopLeftRadius: radius.sm,
  },
  youBubble: {
    alignSelf: 'flex-end',
    backgroundColor: colors.accent,
    borderColor: colors.accent,
    borderTopRightRadius: radius.sm,
  },
  confirm: {
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(240, 168, 104, 0.45)',
    backgroundColor: colors.warnWash,
  },
  confirmHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  actions: { flexDirection: 'row', gap: space.sm },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  flex: { flex: 1 },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.dangerWash,
  },
});
