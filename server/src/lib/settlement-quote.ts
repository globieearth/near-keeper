/**
 * The settlement quote (DEV_PLAN §2.19).
 *
 * A NEAR transfer moves USDC, so the number the wallet signs is a USD number,
 * while the ledger keeps the group's currency. The conversion therefore happens
 * exactly once — here — and is frozen on the row it belongs to: the member sees
 * the quote, signs that exact integer, and `verifyTransfer()` compares against
 * the same stored integer. Recomputing at settle time would reject a transfer
 * the member made correctly at the rate they were shown.
 */

import { query, type Db } from '../db/pool.js';
import { getRates } from './fx.js';
import { ApiError } from './http-error.js';
import { currencyExponent } from './money.js';
import { chainFromUsdMinor, formatTokenUnits } from './near.js';

/** The three tables that carry a frozen quote. Never user input. */
export type QuoteTable = 'shares' | 'tips' | 'interest_charges';

/** The quote columns `shares`, `tips` and `interest_charges` all carry. */
export type QuoteColumns = {
  quoted_chain_amount?: string | number | null;
  quote_rate?: string | number | null;
  quote_as_of?: Date | string | null;
};

export type SettlementQuote = {
  /** USDC base units; exactly what `verifyTransfer()` compares. */
  baseUnits: bigint;
  /** `baseUnits` in token units ("1.49") — what the member pastes into a wallet. */
  amount: string;
  /** USD per one unit of the ledger currency, as published at `asOf`. */
  rate: number;
  /** When the rate was published. */
  asOf: string;
};

const poolDb: Db = { query };

/**
 * The amount this row costs once converted at today's rate. The ledger stays in
 * `currency`, USDC is a USD token, and the FX table is the only bridge between
 * them — never a 1:1 assumption.
 */
export async function quoteSettlement(
  amountMinor: number,
  currency: string,
): Promise<SettlementQuote> {
  const code = currency.trim().toUpperCase();

  // USD is the token's own currency: no rate fetch, no rounding drift.
  if (code === 'USD') {
    const baseUnits = chainFromUsdMinor(Math.max(0, amountMinor));
    return {
      baseUnits,
      amount: formatTokenUnits(baseUnits),
      rate: 1,
      asOf: new Date().toISOString(),
    };
  }

  const snapshot = await getRates(code);
  const rate = snapshot.rates.USD;

  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    // `getRates` throws `fx_unavailable` when it knows nothing; a table that
    // answers without USD is just as unusable.
    throw new ApiError(503, 'fx_unavailable', `No USD rate is available for ${code}`);
  }

  // `amountMinor` is the ledger's minor units, `rate` is USD per major unit.
  // A positive debt never quotes as zero: USDC has no smaller unit than a cent.
  const usdMinor =
    amountMinor <= 0
      ? 0
      : Math.max(1, Math.round((amountMinor / 10 ** currencyExponent(code)) * rate * 100));

  const baseUnits = chainFromUsdMinor(usdMinor);

  return {
    baseUnits,
    amount: formatTokenUnits(baseUnits),
    rate,
    asOf: snapshot.asOf,
  };
}

/** The quote a row already carries, or `null` when it has never been quoted. */
export function quoteFromRow(row: QuoteColumns | null | undefined): SettlementQuote | null {
  if (!row) return null;
  if (row.quoted_chain_amount === null || row.quoted_chain_amount === undefined) return null;
  if (row.quote_rate === null || row.quote_rate === undefined) return null;
  if (row.quote_as_of === null || row.quote_as_of === undefined) return null;

  const baseUnits = BigInt(String(row.quoted_chain_amount));
  return {
    baseUnits,
    amount: formatTokenUnits(baseUnits),
    rate: Number(row.quote_rate),
    asOf: new Date(row.quote_as_of).toISOString(),
  };
}

/**
 * The quote for a row: the frozen one when it exists, otherwise a fresh one
 * written onto the row. Requesting the same amount twice therefore keeps the
 * number the member was already shown instead of moving with the market.
 */
export async function ensureQuote(input: {
  table: QuoteTable;
  id: string;
  amountMinor: number;
  currency: string;
  /** Quote columns from the row the caller already loaded, if it selected them. */
  stored?: QuoteColumns | null;
  db?: Db;
}): Promise<SettlementQuote> {
  const frozen = quoteFromRow(input.stored);
  if (frozen) return frozen;

  const quote = await quoteSettlement(input.amountMinor, input.currency);
  const client = input.db ?? poolDb;

  const { rows } = await client.query<QuoteColumns>(
    `update ${input.table}
        set quoted_chain_amount = $2,
            quote_rate = $3,
            quote_as_of = $4::timestamptz
      where id = $1 and quoted_chain_amount is null
      returning quoted_chain_amount, quote_rate, quote_as_of`,
    [input.id, quote.baseUnits.toString(), quote.rate, quote.asOf],
  );

  const written = quoteFromRow(rows[0]);
  if (written) return written;

  // Another request froze this row first. Whatever it wrote is what the wallet
  // may already have seen, so it wins over our freshly computed quote.
  const reread = await client.query<QuoteColumns>(
    `select quoted_chain_amount, quote_rate, quote_as_of
       from ${input.table} where id = $1`,
    [input.id],
  );

  return quoteFromRow(reread.rows[0]) ?? quote;
}
