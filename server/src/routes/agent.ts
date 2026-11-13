/**
 * The Globie chat endpoints (DEV_PLAN §2.10 / §2.11 / §2.22).
 *
 * `/agent/message` stays a single deterministic entry point: the client names
 * one of the eight tools and its arguments. Money-moving tools answer with
 * `confirmationRequired` and a short-lived token; the client repeats the same
 * call with `confirmToken` to commit it.
 *
 * `/agent/chat` is the same conversation with no tool behind it: free text plus
 * the group's current state, answered in Globie's voice. It can explain and
 * point, never act.
 */

import type { FastifyPluginAsync } from 'fastify';

import { AGENT_TOOLS, runAgentChat, runAgentTool } from '../lib/agent.js';
import type { ConversationTurn } from '../lib/reply.js';
import {
    asRecord,
    optionalString,
    pathUuid,
    requiredString,
} from '../lib/validate.js';

/** The last few turns, so a follow-up ("and Bob?") has something to point at. */
function conversationTurns(value: unknown): ConversationTurn[] {
  if (!Array.isArray(value)) return [];

  const turns: ConversationTurn[] = [];
  for (const entry of value.slice(-12)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const text =
      typeof record.text === 'string' ? record.text.trim().slice(0, 500) : '';
    if (!text) continue;
    turns.push({ from: record.from === 'globie' ? 'globie' : 'you', text });
  }
  return turns;
}

function optionalUuid(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (value === undefined || value === null || value === '') return null;
  return pathUuid(value, key);
}

export const agentRoutes: FastifyPluginAsync = async (app) => {
  app.get('/agent/tools', async () => ({
    tools: AGENT_TOOLS,
  }));

  app.post('/agent/message', async (request) => {
    const body = asRecord(request.body);
    const tool = requiredString(body, 'tool', { max: 64 });
    const args = body.args === undefined || body.args === null ? {} : asRecord(body.args);
    const confirmToken = optionalString(body, 'confirmToken', 512);

    return runAgentTool({
      request,
      tool,
      args,
      confirmToken,
      say: optionalString(body, 'say', 500),
      history: conversationTurns(body.history),
      narrate: body.narrate !== false,
    });
  });

  app.post('/agent/chat', async (request) => {
    const body = asRecord(request.body);
    const say = requiredString(body, 'say', { max: 500 });

    return runAgentChat({
      request,
      say,
      history: conversationTurns(body.history),
      billId: optionalUuid(body, 'billId'),
      agreementId: optionalUuid(body, 'agreementId'),
    });
  });
};
