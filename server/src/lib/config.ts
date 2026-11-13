const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  return value === '1' || value.toLowerCase() === 'true';
};

const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * The API and the web export are served from different hostnames in
 * production (keeperapi.globie.ai / keeper.globie.ai), so "where the API lives"
 * and "where the browser app lives" cannot share one origin.
 */
const publicOrigin =
  process.env.PUBLIC_ORIGIN ?? 'https://near-keeperapi.globie.ai';
const webOrigin = process.env.WEB_ORIGIN ?? 'https://near-keeper.globie.ai';

/** Accept a base URL or a full completions URL; both reach the same endpoint. */
const chatCompletionsUrl = (url: string): string => {
  const trimmed = url.replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions')
    ? trimmed
    : `${trimmed}/chat/completions`;
};

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  host: process.env.API_HOST ?? '0.0.0.0',
  port: int(process.env.API_PORT, 3001),

  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://globie:globie@localhost:55432/globie',
  databasePoolMax: int(process.env.DATABASE_POOL_MAX, 10),

  /** Public origin that fronts the API in production. */
  publicOrigin,

  /** Public origin that serves the Expo web export. */
  webOrigin,

  /** Where uploaded receipt photos and videos land before frame extraction. */
  mediaDir: process.env.MEDIA_DIR ?? './var/media',

  sessionTtlDays: int(process.env.SESSION_TTL_DAYS, 60),
  autoMigrate: bool(process.env.AUTO_MIGRATE, true),

  /** Comma separated extra origins; the public origin and localhost are always allowed. */
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  // --- AI (NEAR AI Cloud) ---------------------------------------------------
  /**
   * One OpenAI-compatible key serves both the receipt reader and Globie's
   * voice. `NEAR_AI_BASE_URL` may be the base (`https://cloud-api.near.ai/v1`)
   * or the full `/chat/completions` path, as older `VISION_API_URL` values
   * were. Swap models with `VISION_MODEL` / `AGENT_MODEL`; the request shape in
   * lib/receipt.ts and lib/reply.ts does not change.
   */
  visionApiKey: process.env.NEAR_AI_API_KEY ?? process.env.VISION_API_KEY ?? '',
  visionApiUrl: chatCompletionsUrl(
    process.env.NEAR_AI_BASE_URL ??
      process.env.VISION_API_URL ??
      'https://cloud-api.near.ai/v1',
  ),
  visionModel: process.env.VISION_MODEL ?? 'Qwen/Qwen3-VL-30B-A3B-Instruct',
  visionTimeoutMs: int(process.env.VISION_TIMEOUT_MS, 45_000),
  /** Video frames sampled per upload before reconciliation. */
  visionMaxFrames: int(process.env.VISION_MAX_FRAMES, 5),

  // --- NEAR ----------------------------------------------------------------
  /**
   * The settlement rail: `testnet` in development, and `mainnet` for the one
   * real micro-settlement the submission points an explorer at. Intents is
   * configured separately because 1Click has no testnet deployment at all.
   */
  near: {
    network: process.env.NEAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet',
    // rpc.testnet.near.org now answers every call with a deprecation error, so
    // the default is FastNEAR's public testnet endpoint.
    rpcUrl: process.env.NEAR_RPC_URL ?? 'https://test.rpc.fastnear.com',
    /**
     * The Sputnik DAO V2 factory. Its `create` mints `<name>.<factory>` and
     * initialises it in the same call; the *wallet* pays the deposit, the
     * factory refunds whatever the code storage did not consume.
     */
    daoFactoryAccount:
      process.env.NEAR_DAO_FACTORY_ACCOUNT ??
      (process.env.NEAR_NETWORK === 'mainnet' ? 'sputnik-dao.near' : 'sputnikv2.testnet'),
    /** 6 NEAR is the factory's documented minimum for storing the DAO code. */
    daoCreationDepositYocto: BigInt(
      process.env.NEAR_DAO_CREATION_DEPOSIT_YOCTO ?? '6000000000000000000000000',
    ),
    /**
     * NEP-141 token members pay with. `decimals` is the token's own scale
     * (USDC on NEAR = 6), which is not the ISO-4217 exponent used in the
     * database — lib/near.ts is the only converter.
     */
    usdcContract: process.env.NEAR_USDC_CONTRACT ?? '',
    usdcDecimals: int(process.env.NEAR_USDC_DECIMALS, 6),
    /**
     * The shared agreement registry (dev plan §2.21). Empty disables the
     * "record on chain" path; the read-only anchor keeps working without it.
     */
    agreementsContract: process.env.NEAR_AGREEMENTS_CONTRACT ?? '',
    /** Read-only account used to look up transactions; never signs. */
    serverAccount: process.env.NEAR_SERVER_ACCOUNT ?? '',
    /** 1Click base URL; empty disables the cross-chain quote path. */
    intentsBaseUrl: process.env.NEAR_INTENTS_BASE_URL ?? '',
    explorerUrl:
      process.env.NEAR_EXPLORER_URL ??
      (process.env.NEAR_NETWORK === 'mainnet'
        ? 'https://nearblocks.io'
        : 'https://testnet.nearblocks.io'),
    /**
     * NEP-413: where the wallet sends the signature back. Web wallets append
     * `#accountId=…&publicKey=…&signature=…` to the callback URL, so the web
     * return must be a page of the app that can read a fragment; the native
     * return is the deep link `openAuthSessionAsync` resolves with.
     */
    loginWebReturnUrl:
      process.env.NEAR_LOGIN_WEB_RETURN_URL ?? `${webOrigin}/near/login`,
    loginNativeReturnUrl:
      process.env.NEAR_LOGIN_NATIVE_RETURN_URL ?? 'globiekeeper://auth/near',
  },

  // --- Globie Fund ----------------------------------------------------------
  /**
   * Adopt-a-tree gifts (migration 022). The sanctuary's own NEAR account is the
   * only receiver: there is no checkout session and no PayPal rail, so a gift is
   * the same non-custodial transfer a share settlement uses. Empty disables the
   * donate screen's pay button rather than pointing a wallet at nowhere.
   */
  fund: {
    treasuryAccount: process.env.GLOBIE_FUND_TREASURY_ACCOUNT ?? '',
    /**
     * How long a frozen quote stays settleable. The wallet is asked to sign an
     * exact integer, so a slow donor needs a fresh quote rather than a
     * settlement the chain would reject for the wrong amount.
     */
    quoteTtlMs: int(process.env.GLOBIE_FUND_QUOTE_TTL_MS, 15 * 60_000),
  },

  // --- Social money ---------------------------------------------------------
  /**
   * Defaults for a group's bounty treasury (migration 023). The values are
   * copied onto each `dao_treasuries` row at registration time, so an existing
   * treasury keeps working if these change. Caps are minor units of the group
   * currency; the DAO's own policy remains the final authority.
   */
  social: {
    autoApproveCapMinor: int(process.env.SOCIAL_AUTO_APPROVE_CAP_MINOR, 500),
    midApproveCapMinor: int(process.env.SOCIAL_MID_APPROVE_CAP_MINOR, 2500),
    periodDays: int(process.env.SOCIAL_PERIOD_DAYS, 30),
    periodCapMinor: int(process.env.SOCIAL_PERIOD_CAP_MINOR, 10000),
  },

  // --- Globie MCP -----------------------------------------------------------
  /**
   * mcp.globie.earth exposes streamable HTTP MCP at `/mcp` and accepts a plain
   * `X-Device-Id` header — no OAuth flow. Its `adopt_species` tool writes the
   * Living Deed for a gift; that call happens after the transfer is already
   * proven, so an MCP outage can never block or reverse a donation.
   */
  mcp: {
    baseUrl: (process.env.MCP_GLOBIE_EARTH_URL ?? 'https://mcp.globie.earth').replace(/\/+$/, ''),
    deviceId: process.env.MCP_SESSION_DEVICE_ID ?? '',
    timeoutMs: int(process.env.MCP_TIMEOUT_MS, 10_000),
  },

  // --- fx ------------------------------------------------------------------
  /**
   * Indicative display rates (DEV_PLAN §2.19). There is no public rate
   * endpoint for every chain, so these come from open.er-api.com and are
   * always labelled `≈`.
   */
  fxBase: (process.env.FX_BASE ?? 'THB').toUpperCase(),
  fxRatesUrl: process.env.FX_RATES_URL ?? 'https://open.er-api.com/v6/latest',
  fxCacheTtlMs: int(process.env.FX_CACHE_TTL_MS, 60 * 60 * 1000),

  // --- agent ----------------------------------------------------------------
  /**
   * HMAC key for the agent's confirmation tokens (DEV_PLAN §2.11). Required in
   * production; development falls back to a local constant so the demo runs.
   */
  agentConfirmSecret: process.env.AGENT_CONFIRMATION_SECRET ?? '',

  /**
   * Globie's voice (DEV_PLAN §2.22). The tools stay deterministic; this model
   * only rephrases the sentence they produced. It shares the NEAR AI key but
   * not the vision model — a text model is cheaper and faster for chat.
   *
   * Keep this a non-reasoning model: reply.ts caps output at 220 tokens, and
   * NEAR AI's reasoning models (deepseek-v4.1-flash, gemini-2.5-flash) spend
   * that budget on hidden reasoning and return a sentence cut mid-word.
   */
  agentModel: process.env.AGENT_MODEL ?? 'google/gemini-2.5-flash-lite',
  agentTimeoutMs: int(process.env.AGENT_TIMEOUT_MS, 8_000),
  agentReplyEnabled: bool(process.env.AGENT_REPLY_ENABLED, true),

  // --- jobs -----------------------------------------------------------------
  /** pg-boss workers share this process; turn off for one-shot scripts. */
  jobsEnabled: bool(process.env.JOBS_ENABLED, true),
  reminderSweepCron: process.env.REMINDER_SWEEP_CRON ?? '*/5 * * * *',
  outboxSweepCron: process.env.OUTBOX_SWEEP_CRON ?? '* * * * *',

  // --- notifications --------------------------------------------------------
  /**
   * Channel flags. In-app is always on; the rest stay off until credentials
   * exist, so the demo never fails because a provider is missing.
   */
  notifyInApp: bool(process.env.NOTIFY_IN_APP, true),
  notifyEmail: bool(process.env.NOTIFY_EMAIL, false),
  notifyPush: bool(process.env.NOTIFY_PUSH, false),
  notifyWhatsapp: bool(process.env.NOTIFY_WHATSAPP, false),

  /** `smtp://user:pass@host:587` — empty disables the email channel. */
  smtpUrl: process.env.SMTP_URL ?? '',
  mailFrom: process.env.MAIL_FROM ?? 'Globie <no-reply@globie.local>',

  expoPushUrl: process.env.EXPO_PUSH_URL ?? 'https://exp.host/--/api/v2/push/send',

  whatsappApiUrl: process.env.WHATSAPP_API_URL ?? 'https://graph.facebook.com/v21.0',
  whatsappToken: process.env.WHATSAPP_TOKEN ?? '',
  whatsappPhoneId: process.env.WHATSAPP_PHONE_ID ?? '',
} as const;

export const isProduction = config.nodeEnv === 'production';
