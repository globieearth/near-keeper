/**
 * The one MCP call this server makes: `adopt_species` on mcp.globie.earth.
 *
 * That tool writes the Living Deed for an adopted tree and credits Globie Earth
 * eco-tokens. It explicitly does *not* take payment — so it runs after the
 * donor's NEAR transfer has already been verified on chain, and `reference`
 * carries that transaction hash. The tool wraps an idempotent RPC keyed on the
 * reference, so retrying a settlement returns the original deed instead of
 * minting a second one.
 *
 * Only `initialize` → `notifications/initialized` → `tools/call` is
 * implemented. That is the whole streamable-HTTP handshake this one tool needs;
 * a general MCP client would be a dependency this project does not want.
 */

import { config } from './config.js';

type JsonRpcResponse = {
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type ToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Header name the server hands back on `initialize`; reused for the session. */
const SESSION_HEADER = 'mcp-session-id';

let sessionId: string | null = null;
let nextId = 1;

/** Empty `MCP_SESSION_DEVICE_ID` keeps this feature off rather than guessing an identity. */
export function isGlobieMcpConfigured(): boolean {
  return Boolean(config.mcp.baseUrl && config.mcp.deviceId);
}

function requestHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'X-Device-Id': config.mcp.deviceId,
    ...(sessionId ? { [SESSION_HEADER]: sessionId } : {}),
  };
}

/** Streamable HTTP may answer either a JSON body or an SSE stream. */
function parseSse(text: string): JsonRpcResponse[] {
  const payloads: JsonRpcResponse[] = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;

    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;

    try {
      payloads.push(JSON.parse(data) as JsonRpcResponse);
    } catch {
      // Keep-alive comments and partial frames are not our problem.
    }
  }

  return payloads;
}

async function post(body: unknown, id?: number): Promise<unknown> {
  const response = await fetch(`${config.mcp.baseUrl}/mcp`, {
    method: 'POST',
    headers: requestHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.mcp.timeoutMs),
  });

  const assigned = response.headers.get(SESSION_HEADER);
  if (assigned) sessionId = assigned;

  if (!response.ok) {
    throw new Error(`mcp answered ${response.status}`);
  }

  // A notification is acknowledged with an empty 202.
  if (response.status === 202) return null;

  const contentType = response.headers.get('content-type') ?? '';
  const payloads = contentType.includes('text/event-stream')
    ? parseSse(await response.text())
    : [JSON.parse(await response.text()) as JsonRpcResponse];

  const match =
    id === undefined
      ? payloads[0]
      : payloads.find((payload) => payload.id === id) ?? payloads[0];

  if (!match) throw new Error('mcp returned no JSON-RPC payload');
  if (match.error) {
    throw new Error(`mcp ${match.error.code ?? 'error'}: ${match.error.message ?? 'unknown'}`);
  }

  return match.result;
}

async function ensureSession(): Promise<void> {
  if (sessionId) return;

  const id = nextId++;
  await post(
    {
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'globie-keeper', version: '1.0.0' },
      },
    },
    id,
  );

  // `tools/list` and `tools/call` are rejected until the client acknowledges.
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  await ensureSession();
  const id = nextId++;

  try {
    return (await post(
      { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
      id,
    )) as ToolResult;
  } catch (error) {
    // A session can expire between gifts; one fresh handshake is enough.
    sessionId = null;
    await ensureSession();
    return (await post(
      { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } },
      id,
    )) as ToolResult;
  }
}

const DEED_REF = /GLB-\d{4}-\d{6}/;

/** Pull the deed number out of whichever shape the tool answers with. */
function extractDeedRef(result: ToolResult): string | null {
  const structured = result.structuredContent ?? {};
  for (const key of ['deed_ref', 'deedRef', 'deed_id', 'deed']) {
    const value = structured[key];
    if (typeof value === 'string' && DEED_REF.test(value)) return value;
  }

  for (const item of result.content ?? []) {
    if (typeof item.text !== 'string') continue;
    const found = DEED_REF.exec(item.text);
    if (found) return found[0];
  }

  return null;
}

/**
 * Record an adoption in Globie Earth. Throws on transport or tool errors; the
 * caller treats that as "deed number pending" — the chain payment already
 * stands, and the same `reference` makes a later retry safe.
 */
export async function adoptSpecies(input: {
  speciesId: string;
  quantity: number;
  /** The settlement transaction hash — the idempotency key. */
  reference: string;
}): Promise<{ deedRef: string | null }> {
  const result = await callTool('adopt_species', {
    species_id: input.speciesId,
    quantity: input.quantity,
    reference: input.reference,
  });

  if (result.isError) {
    const message = result.content?.find((item) => item.text)?.text ?? 'adopt_species failed';
    throw new Error(message);
  }

  return { deedRef: extractDeedRef(result) };
}
