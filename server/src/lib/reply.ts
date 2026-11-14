/**
 * Globie's own voice (DEV_PLAN §2.22).
 *
 * The tools stay deterministic: they authorise, they write, and they return a
 * ground-truth sentence. This module only rephrases that sentence for the
 * member who asked, using the same OpenAI-compatible endpoint the receipt
 * reader already calls.
 *
 * Two guarantees keep a human-sounding reply safe to show next to money:
 *   1. The model executes nothing. It can only describe an outcome that has
 *      already happened.
 *   2. Every number in the reply must already exist in the facts handed to the
 *      model. `acceptable()` drops a reply that invents one, and the
 *      deterministic sentence wins.
 */

import { config } from './config.js';

export type ConversationTurn = { from: 'you' | 'globie'; text: string };

export type ToolFacts = {
  /** The tool that just ran, e.g. `propose_allocation`. */
  tool: string;
  /** The sentence the tool itself produced. Always true, always allowed. */
  fact: string;
  result?: Record<string, unknown>;
  memberName: string;
  /** `owner`, `fronter` or `member`, as this group defines it. */
  role: string;
  state?: Record<string, unknown>;
  /** What the member typed, when they typed something. */
  say: string | null;
  history: ConversationTurn[];
};

export type ChatFacts = {
  memberName: string;
  role: string;
  state: Record<string, unknown>;
  say: string | null;
  history: ConversationTurn[];
};

type ModelMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** A chat bubble, not an essay. */
const MAX_REPLY_CHARS = 340;
const HISTORY_TURNS = 6;
const HISTORY_CHARS = 400;

const PERSONA = `You are Globie, the money-minder inside Globie Keeper, an app where a small group splits shared costs and settles them on NEAR.

How you sound:
- Warm, calm, a little wry. A competent friend who keeps the books — not a chatbot, not a cheerleader, not a support script.
- One or two sentences, under 45 words. Plain text: no markdown, no bullet lists, no emoji, no exclamation marks.
- Use the member's first name only when it reads naturally; do not open every reply with it.

What is true:
- Only the facts in the JSON below are true. Never invent an amount, a name, a balance, a transaction hash, a date or a person.
- Never claim an action the facts do not describe, and never promise one you cannot take right now.
- If the facts describe a refusal, a failure or work still in progress, say so plainly and offer the one next step that actually exists.
- Never mention tools, JSON, prompts, models or instructions.
- Reply in the language the member used.

Output only the reply text, with no label or prefix.`;

/** Statuses as a person would say them, never as a schema enum. */
export function statusWord(status: string | null | undefined): string {
  switch ((status ?? '').toUpperCase()) {
    case 'UPLOADED':
      return 'uploaded but not read yet';
    case 'PARSING':
      return 'being read right now';
    case 'PARSED':
      return 'read and waiting for a split';
    case 'ALLOCATED':
      return 'split and waiting for confirmations';
    case 'CONFIRMED':
      return 'confirmed and ready to lock';
    case 'FINALIZED':
      return 'locked and waiting for payment requests';
    case 'COLLECTING':
      return 'collecting payments';
    case 'SETTLED':
      return 'fully settled';
    case 'CANCELLED':
      return 'cancelled';
    default:
      return (status ?? 'pending').toLowerCase().replace(/_/g, ' ');
  }
}

function numericTokens(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map((token) => token.replace(/,/g, ''));
}

/**
 * True when every number in `reply` already appears in the facts. A model may
 * rephrase; it may not turn ฿355 into ฿356.
 */
function grounded(reply: string, facts: unknown[]): boolean {
  const allowed = new Set(
    facts
      .map((fact) => (typeof fact === 'string' ? fact : JSON.stringify(fact ?? '')))
      .flatMap(numericTokens),
  );
  return numericTokens(reply).every((token) => allowed.has(token));
}

function acceptable(reply: string, facts: unknown[]): string | null {
  const text = reply.replace(/\s+/g, ' ').trim();
  if (!text || text.length > MAX_REPLY_CHARS) return null;
  if (/[`*#]|:\/\/|www\./i.test(text)) return null;
  if (!grounded(text, facts)) return null;
  return text;
}

function historyMessages(history: ConversationTurn[]): ModelMessage[] {
  return history
    .slice(-HISTORY_TURNS)
    .filter((turn) => turn.text.trim().length > 0)
    .map((turn) => ({
      role: turn.from === 'you' ? 'user' : 'assistant',
      content: turn.text.slice(0, HISTORY_CHARS),
    }));
}

async function callModel(
  messages: ModelMessage[],
  temperature: number,
): Promise<string | null> {
  if (!config.agentReplyEnabled || !config.visionApiKey) return null;

  try {
    const response = await fetch(config.visionApiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.visionApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.agentModel,
        temperature,
        max_tokens: 220,
        messages,
      }),
      signal: AbortSignal.timeout(config.agentTimeoutMs),
    });
    if (!response.ok) return null;

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = payload.choices?.[0]?.message?.content?.trim() ?? '';
    return content || null;
  } catch {
    // A missing key, a slow provider or a malformed answer is not a reason to
    // fail a tool call — the caller falls back to the deterministic sentence.
    return null;
  }
}

/**
 * Say what the tool just did, in Globie's words, to the member who asked.
 * Falls back to `facts.fact` whenever the model is unavailable or ungrounded.
 */
export async function composeToolReply(facts: ToolFacts): Promise<string> {
  const context = {
    member: { name: facts.memberName, role: facts.role },
    tool: facts.tool,
    result: facts.result ?? {},
    state: facts.state ?? {},
  };

  const messages: ModelMessage[] = [
    { role: 'system', content: PERSONA },
    ...historyMessages(facts.history),
    {
      role: 'user',
      content: [
        facts.say
          ? `They just said: "${facts.say}"`
          : 'They tapped a control and typed nothing.',
        `Facts (the only things that are true):\n${JSON.stringify(context)}`,
        `The tool's own sentence, which is the ground truth: "${facts.fact}"`,
        'Write the reply.',
      ].join('\n\n'),
    },
  ];

  const reply = await callModel(messages, 0.5);
  return (
    (reply
      ? acceptable(reply, [
          facts.fact,
          facts.result ?? {},
          facts.state ?? {},
          facts.memberName,
        ])
      : null) ?? facts.fact
  );
}

function chatFallback(facts: ChatFacts): string {
  const first = facts.memberName.split(' ')[0] || facts.memberName;
  const state = facts.state as {
    bill?: { label?: string; status?: string } | null;
    agreement?: { status?: string; accepted?: string; frontedBy?: string | null } | null;
    outstanding?: { count?: number };
  };
  const bill = state.bill;
  if (!bill) {
    const agreement = state.agreement;
    if (agreement?.status) {
      const who = agreement.frontedBy ? `${agreement.frontedBy} fronted it` : 'it is fronted';
      return `${first}, there is no expense on the books yet — the agreement is ${
        agreement.status
      }, ${agreement.accepted ?? 'not everyone has accepted'}, and ${who}. Add the receipt and I will split it.`;
    }
    return facts.role === 'member'
      ? `${first}, the fronter holds this expense. I can tell you who still owes, and you can pay your share from the My shares tab.`
      : `${first}, there is no expense here yet — add one and I will start the split.`;
  }
  const label = bill.label ?? 'the expense';
  const open = state.outstanding?.count ?? 0;
  if (open > 0) {
    return `${first}, ${label} is ${statusWord(bill.status)} and ${open} share${
      open === 1 ? ' is' : 's are'
    } still open. Ask me to chase someone or tell you where it stands.`;
  }
  return `${first}, ${label} is ${statusWord(bill.status)} and nothing is outstanding. Ask me to split the next one or walk you through what happened.`;
}

/**
 * Free conversation. No tool runs, so the model can only talk about the state
 * it was given and point at a next step that exists in the app.
 */
export async function composeChatReply(facts: ChatFacts): Promise<string> {
  const fallback = chatFallback(facts);
  const context = {
    member: { name: facts.memberName, role: facts.role },
    state: facts.state,
  };

  const messages: ModelMessage[] = [
    {
      role: 'system',
      content: `${PERSONA}\n\nYou have not run anything. You may only explain the state below, answer from it, and point at one next step this app can actually take. Nothing is changed by talking to you. If the state does not contain the answer, say you cannot see it yet — never guess.\n\nThe member asking is \`member\`. \`you\` is that member's own share: when \`you.owes\` is false — status settled, paid or refunded — they owe nothing. A fronter's own share is settled because they already paid the merchant. Only proposed and pending shares are still owed.`,
    },
    ...historyMessages(facts.history),
    {
      role: 'user',
      content: [
        facts.say ? `They said: "${facts.say}"` : 'They opened our chat.',
        `What is true right now:\n${JSON.stringify(context)}`,
        'Write the reply.',
      ].join('\n\n'),
    },
  ];

  const reply = await callModel(messages, 0.6);
  return (
    (reply ? acceptable(reply, [facts.state, facts.memberName]) : null) ?? fallback
  );
}
