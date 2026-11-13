/**
 * Globie Fund — adopt a tree in the Isaan sanctuary, paid on NEAR.
 *
 * A gift is not a checkout. There is no cart, no session, no refund and no
 * third-party processor: the donor's own wallet transfers either USDC (NEP-141
 * `ft_transfer`) or native NEAR (`Transfer`) straight to the sanctuary, and the
 * deed is written only after that transfer is read back from the chain. The
 * server holds no key and never custody.
 *
 * The quote exists because the price of NEAR moves while a wallet is open. The
 * exact integer the donor signs is frozen in `fund_quotes` first, and
 * settlement verifies against that same integer — otherwise a correct transfer
 * could be rejected for "wrong amount" minutes later.
 *
 * `fund_deeds.settlement_tx_hash` is unique, so a replayed settlement cannot
 * mint a second deed. That is this feature's equivalent of the
 * `payments(provider, provider_ref)` guard a share settlement uses.
 */

import { query, withTransaction, type Db } from '../db/pool.js';
import { config } from './config.js';
import { getRates } from './fx.js';
import { adoptSpecies, isGlobieMcpConfigured } from './globie-mcp.js';
import { ApiError } from './http-error.js';
import {
    chainFromUsdMinor,
    explorerTx,
    formatTokenUnits,
    isNearAccountId,
    verifyNativeTransfer,
    verifyTransfer,
} from './near.js';

export type FundAsset = 'usdc' | 'near';

/** Matches `fund_quotes.quote_rate numeric(24, 12)` — 12 decimals of a rate. */
const RATE_SCALE = 1_000_000_000_000n;
const RATE_DECIMALS = 12;

/** The pool-shaped `Db` so the loaders can also take a transaction client. */
const poolDb: Db = { query };

type ProjectRow = {
  id: string;
  name: string;
  latin_name: string;
  thai_name: string | null;
  story: string;
  need_level: string;
  need_note: string;
  unit_price_minor: number;
  currency: string;
};

export type FundProject = {
  id: string;
  name: string;
  latinName: string;
  thaiName: string | null;
  story: string;
  needLevel: 'urgent' | 'critical' | 'steady';
  needNote: string;
  unitPriceMinor: number;
  currency: string;
};

const PROJECT_COLUMNS = `id, name, latin_name, thai_name, story, need_level,
                         need_note, unit_price_minor, currency`;

function mapProject(row: ProjectRow): FundProject {
  return {
    id: row.id,
    name: row.name,
    latinName: row.latin_name,
    thaiName: row.thai_name,
    story: row.story,
    needLevel: row.need_level as FundProject['needLevel'],
    needNote: row.need_note,
    unitPriceMinor: row.unit_price_minor,
    currency: row.currency.trim(),
  };
}

export async function listFundProjects(): Promise<FundProject[]> {
  const { rows } = await query<ProjectRow>(
    `select ${PROJECT_COLUMNS}
       from fund_projects
      order by sort_order asc, name asc`,
  );
  return rows.map(mapProject);
}

async function loadProject(db: Db, projectId: string): Promise<ProjectRow> {
  const { rows } = await db.query<ProjectRow>(
    `select ${PROJECT_COLUMNS} from fund_projects where id = $1`,
    [projectId],
  );
  const row = rows[0];
  if (!row) throw ApiError.notFound('That tree is not in the sanctuary catalogue');
  return row;
}

/** The donor's own linked wallet — a group subaccount is irrelevant here. */
async function loadDonorAccount(userId: string): Promise<string | null> {
  const { rows } = await query<{ near_account: string | null }>(
    `select case when near_verified then near_account end as near_account
       from users where id = $1`,
    [userId],
  );
  return rows[0]?.near_account ?? null;
}

/** `scaled / 10^12` as the decimal string `numeric(24, 12)` expects. */
function decimalString(scaled: bigint): string {
  const whole = scaled / RATE_SCALE;
  const fraction = (scaled % RATE_SCALE)
    .toString()
    .padStart(RATE_DECIMALS, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * USD cents -> yoctoNEAR at `nearPerUsd` (NEAR per 1 USD, i.e.
 * `getRates('USD').rates.NEAR`). Multiply, do not divide: the rate already
 * says how much NEAR one dollar buys.
 *
 * Both sides are scaled integers, so the conversion never goes through a
 * float: cents × rate(1e-12) × 10^24 / 100 = cents × rate × 10^10.
 */
function yoctoFromUsdMinor(
  usdMinor: number,
  nearPerUsd: number,
): { yocto: bigint; rate: string } {
  const rateScaled = BigInt(Math.round(nearPerUsd * Number(RATE_SCALE)));
  if (rateScaled <= 0n) {
    throw new ApiError(503, 'fx_unavailable', 'NEAR has no usable price right now');
  }

  const yocto = BigInt(usdMinor) * rateScaled * 10n ** 10n;
  return { yocto, rate: decimalString(rateScaled) };
}

export type CreateFundQuoteInput = {
  userId: string;
  projectId: string;
  qty: number;
  asset: FundAsset;
};

export type FundQuote = {
  quoteId: string;
  projectId: string;
  projectName: string;
  asset: FundAsset;
  qty: number;
  amountMinor: number;
  currency: string;
  /** The exact integer the wallet signs, in the asset's own base units. */
  chainAmount: string;
  /** The same number written for a human: "5.00" USDC or "1.6392…" NEAR. */
  amountDisplay: string;
  /** USDC contract for `usdc`; null for native NEAR, which calls no contract. */
  tokenContract: string | null;
  decimals: number;
  treasuryAccount: string;
  /** USD per one unit of the asset when this quote was frozen. */
  quoteRate: number;
  quoteAsOf: string;
  expiresAt: string;
};

/**
 * Freeze the gift: how much this many trees costs, in whichever asset the donor
 * chose, at the price right now. Nothing is paid until the wallet signs.
 */
export async function createFundQuote(
  input: CreateFundQuoteInput,
): Promise<FundQuote> {
  if (!config.fund.treasuryAccount || !isNearAccountId(config.fund.treasuryAccount)) {
    throw ApiError.conflict(
      'fund_not_configured',
      'The sanctuary has not linked a NEAR account for gifts yet',
    );
  }

  const payerAccount = await loadDonorAccount(input.userId);
  if (!payerAccount || !isNearAccountId(payerAccount)) {
    throw ApiError.conflict(
      'member_near_missing',
      'Link your NEAR account before giving — the gift has to be signed by you',
    );
  }

  const project = await loadProject(poolDb, input.projectId);
  const amountMinor = project.unit_price_minor * input.qty;
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw ApiError.badRequest('invalid_qty', 'That many trees is not a valid gift');
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.fund.quoteTtlMs);

  let chainAmount: bigint;
  let quoteRate: string;
  let quoteAsOf: Date;

  if (input.asset === 'usdc') {
    if (!config.near.usdcContract) {
      throw ApiError.conflict(
        'fund_usdc_unavailable',
        'USDC gifts are not configured on this server — give in NEAR instead',
      );
    }
    chainAmount = chainFromUsdMinor(amountMinor);
    quoteRate = '1';
    quoteAsOf = now;
  } else {
    const snapshot = await getRates('USD');
    const nearPerUsd = snapshot.rates.NEAR;
    if (typeof nearPerUsd !== 'number' || !Number.isFinite(nearPerUsd) || nearPerUsd <= 0) {
      throw new ApiError(
        503,
        'fx_unavailable',
        'No NEAR price is available right now, so a gift cannot be quoted in NEAR',
      );
    }
    const converted = yoctoFromUsdMinor(amountMinor, nearPerUsd);
    chainAmount = converted.yocto;
    quoteRate = converted.rate;
    quoteAsOf = new Date(snapshot.asOf);
  }

  const { rows } = await query<{ id: string; expires_at: Date }>(
    `insert into fund_quotes
       (project_id, user_id, payer_account, qty, amount_minor, currency, asset,
        chain_amount, quote_rate, quote_as_of, treasury_account, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning id, expires_at`,
    [
      project.id,
      input.userId,
      payerAccount,
      input.qty,
      amountMinor,
      project.currency.trim(),
      input.asset,
      chainAmount.toString(),
      quoteRate,
      quoteAsOf.toISOString(),
      config.fund.treasuryAccount,
      expiresAt.toISOString(),
    ],
  );

  const created = rows[0];
  if (!created) throw new Error('fund quote insert returned no row');

  const decimals = input.asset === 'near' ? 24 : config.near.usdcDecimals;

  return {
    quoteId: created.id,
    projectId: project.id,
    projectName: project.name,
    asset: input.asset,
    qty: input.qty,
    amountMinor,
    currency: project.currency.trim(),
    chainAmount: chainAmount.toString(),
    amountDisplay: formatTokenUnits(chainAmount, decimals),
    tokenContract: input.asset === 'usdc' ? config.near.usdcContract : null,
    decimals,
    treasuryAccount: config.fund.treasuryAccount,
    quoteRate: Number(quoteRate),
    quoteAsOf: quoteAsOf.toISOString(),
    expiresAt: created.expires_at.toISOString(),
  };
}

type QuoteRow = {
  id: string;
  project_id: string;
  project_name: string;
  user_id: string | null;
  payer_account: string;
  qty: number;
  amount_minor: number;
  currency: string;
  asset: FundAsset;
  chain_amount: string;
  treasury_account: string;
  expires_at: Date;
};

async function loadQuote(db: Db, quoteId: string): Promise<QuoteRow> {
  const { rows } = await db.query<QuoteRow>(
    `select q.id, q.project_id, p.name as project_name, q.user_id,
            q.payer_account, q.qty, q.amount_minor, q.currency, q.asset,
            q.chain_amount::text, q.treasury_account, q.expires_at
       from fund_quotes q
       join fund_projects p on p.id = q.project_id
      where q.id = $1`,
    [quoteId],
  );

  const row = rows[0];
  if (!row) throw ApiError.notFound('Fund quote not found');
  return row;
}

type DeedRow = {
  id: string;
  deed_ref: string;
  quote_id: string;
  project_id: string;
  project_name: string;
  user_id: string | null;
  payer_account: string;
  qty: number;
  amount_minor: number;
  currency: string;
  asset: FundAsset;
  chain_amount: string;
  treasury_account: string;
  provider: string;
  settlement_tx_hash: string;
  mcp_deed_ref: string | null;
  mcp_synced_at: Date | null;
  created_at: Date;
};

const DEED_COLUMNS = `d.id, d.deed_ref, d.quote_id, d.project_id,
                      p.name as project_name, d.user_id, d.payer_account,
                      d.qty, d.amount_minor, d.currency, d.asset,
                      d.chain_amount::text, d.treasury_account, d.provider,
                      d.settlement_tx_hash, d.mcp_deed_ref, d.mcp_synced_at,
                      d.created_at`;

export type FundDeed = {
  id: string;
  deedRef: string;
  projectId: string;
  projectName: string;
  qty: number;
  amountMinor: number;
  currency: string;
  asset: FundAsset;
  chainAmount: string;
  amountDisplay: string;
  payerAccount: string;
  treasuryAccount: string;
  provider: string;
  txHash: string;
  explorerUrl: string;
  mcpDeedRef: string | null;
  createdAt: string;
};

function mapDeed(row: DeedRow): FundDeed {
  const decimals = row.asset === 'near' ? 24 : config.near.usdcDecimals;

  return {
    id: row.id,
    deedRef: row.deed_ref,
    projectId: row.project_id,
    projectName: row.project_name,
    qty: row.qty,
    amountMinor: row.amount_minor,
    currency: row.currency.trim(),
    asset: row.asset,
    chainAmount: row.chain_amount,
    amountDisplay: formatTokenUnits(BigInt(row.chain_amount), decimals),
    payerAccount: row.payer_account,
    treasuryAccount: row.treasury_account,
    provider: row.provider,
    txHash: row.settlement_tx_hash,
    explorerUrl: explorerTx(row.settlement_tx_hash),
    mcpDeedRef: row.mcp_deed_ref,
    createdAt: row.created_at.toISOString(),
  };
}

async function loadDeedByQuote(db: Db, quoteId: string): Promise<DeedRow | null> {
  const { rows } = await db.query<DeedRow>(
    `select ${DEED_COLUMNS}
       from fund_deeds d
       join fund_projects p on p.id = d.project_id
      where d.quote_id = $1`,
    [quoteId],
  );
  return rows[0] ?? null;
}

export type SettleFundDeedInput = {
  quoteId: string;
  userId: string;
  txHash: string;
};

export type SettleFundDeedResult = {
  deed: FundDeed;
  alreadySettled: boolean;
  /** The Living Deed number from mcp.globie.earth, once it answered. */
  mcpDeedRef: string | null;
  explorerUrl: string;
};

/**
 * Prove the transfer and write the deed. Verification in lib/near.ts is the
 * only path to a deed; the live-deed sync afterwards is best-effort, because a
 * confirmed chain payment is real whether or not the MCP answers.
 */
export async function settleFundDeed(
  input: SettleFundDeedInput,
): Promise<SettleFundDeedResult> {
  const quote = await loadQuote(poolDb, input.quoteId);

  // A quote belongs to the donor who asked for it — anyone else's is invisible.
  if (quote.user_id && quote.user_id !== input.userId) {
    throw ApiError.notFound('Fund quote not found');
  }

  const settled = await loadDeedByQuote(poolDb, quote.id);
  if (settled) {
    return {
      deed: mapDeed(settled),
      alreadySettled: true,
      mcpDeedRef: settled.mcp_deed_ref,
      explorerUrl: explorerTx(settled.settlement_tx_hash),
    };
  }

  if (new Date(quote.expires_at).getTime() <= Date.now()) {
    throw ApiError.conflict(
      'fund_quote_expired',
      'This quote expired — ask for a fresh one so the amount matches the market',
    );
  }

  const expected = BigInt(quote.chain_amount);

  // The frozen account is part of the proof: a transfer sent anywhere else is
  // rejected here rather than silently donating to an attacker's wallet.
  const transfer =
    quote.asset === 'usdc'
      ? await verifyTransfer({
          txHash: input.txHash,
          senderId: quote.payer_account,
          expectedReceiver: quote.treasury_account,
          expectedChainAmount: expected,
        })
      : await verifyNativeTransfer({
          txHash: input.txHash,
          senderId: quote.payer_account,
          expectedReceiver: quote.treasury_account,
          expectedYocto: expected,
        });

  const deed = await withTransaction(async (tx) => {
    // Serialises two settlements racing on the same quote; the unique
    // `settlement_tx_hash` below is the second, independent guard.
    await tx.query('select id from fund_quotes where id = $1 for update', [quote.id]);

    const existing = await loadDeedByQuote(tx, quote.id);
    if (existing) return { row: existing, created: false };

    const { rows } = await tx.query<DeedRow>(
      `with inserted as (
         insert into fund_deeds
           (quote_id, project_id, user_id, payer_account, qty, amount_minor,
            currency, asset, chain_amount, treasury_account, provider,
            settlement_tx_hash)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'near_transfer', $11)
         returning *
       )
       select ${DEED_COLUMNS}
         from inserted d
         join fund_projects p on p.id = d.project_id`,
      [
        quote.id,
        quote.project_id,
        quote.user_id,
        quote.payer_account,
        quote.qty,
        quote.amount_minor,
        quote.currency.trim(),
        quote.asset,
        quote.chain_amount,
        quote.treasury_account,
        transfer.txHash,
      ],
    );

    const row = rows[0];
    if (!row) throw new Error('fund deed insert returned no row');
    return { row, created: true };
  });

  let mcpDeedRef = deed.row.mcp_deed_ref;

  // The chain already decided; this only adds the sanctuary's own deed number.
  if (!mcpDeedRef && isGlobieMcpConfigured()) {
    try {
      const adopted = await adoptSpecies({
        speciesId: deed.row.project_id,
        quantity: deed.row.qty,
        reference: deed.row.settlement_tx_hash,
      });

      if (adopted.deedRef) {
        await query(
          `update fund_deeds
              set mcp_deed_ref = $2, mcp_synced_at = now()
            where id = $1`,
          [deed.row.id, adopted.deedRef],
        );
        mcpDeedRef = adopted.deedRef;
      }
    } catch (error) {
      // A donor's gift must never fail because someone else's server is down.
      console.warn('[fund] deed sync failed:', (error as Error).message);
    }
  }

  return {
    deed: mapDeed(deed.row),
    alreadySettled: !deed.created,
    mcpDeedRef,
    explorerUrl: transfer.explorerUrl,
  };
}

export type FundGiving = {
  deeds: FundDeed[];
  totalMinor: number;
  totalTrees: number;
};

/** The donor's own giving history, newest first. */
export async function listFundDeeds(userId: string): Promise<FundGiving> {
  const { rows } = await query<DeedRow>(
    `select ${DEED_COLUMNS}
       from fund_deeds d
       join fund_projects p on p.id = d.project_id
      where d.user_id = $1
      order by d.created_at desc
      limit 100`,
    [userId],
  );

  const deeds = rows.map(mapDeed);

  return {
    deeds,
    totalMinor: rows
      .filter((row) => row.currency.trim() === 'USD')
      .reduce((sum, row) => sum + row.amount_minor, 0),
    totalTrees: rows.reduce((sum, row) => sum + row.qty, 0),
  };
}
