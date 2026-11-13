/**
 * The public half of a pay link.
 *
 * Registered without a session check because the link exists to reach someone
 * who has not signed in. The answer is a read-only view of one share: what to
 * send, to whom, and with which memo. It never exposes the payer's identity, an
 * account balance or any other bill.
 */

import type { FastifyPluginAsync } from 'fastify';

import { query } from '../db/pool.js';
import { config } from '../lib/config.js';
import { ApiError } from '../lib/http-error.js';
import { formatAmount } from '../lib/money.js';
import { explorerTx } from '../lib/near.js';
import { isPayLinkToken } from '../lib/pay-links.js';
import { quoteFromRow } from '../lib/settlement-quote.js';

type PayLinkParams = { Params: { token: string } };

type PayLinkRow = {
  share_id: string;
  amount: number;
  currency: string;
  status: string;
  bill_title: string | null;
  payee_account: string | null;
  settlement_tx_hash: string | null;
  quoted_chain_amount: string | null;
  quote_rate: string | null;
  quote_as_of: Date | null;
};

export const payLinkRoutes: FastifyPluginAsync = async (app) => {
  /**
   * No auth: the bearer token is the credential, and it buys exactly this read.
   * A malformed token is a 404 rather than a 400 so the route does not confirm
   * which shapes could exist.
   */
  app.get<PayLinkParams>('/pay/:token', async (request) => {
    const { token } = request.params;
    if (!isPayLinkToken(token)) throw ApiError.notFound('Pay link not found');

    const { rows } = await query<PayLinkRow>(
      `select s.id as share_id, s.amount, s.currency, s.status,
              s.settlement_tx_hash,
              s.quoted_chain_amount, s.quote_rate, s.quote_as_of,
              coalesce(nullif(b.title, ''), b.merchant) as bill_title,
              coalesce(
                case when fu.near_verified then fm.near_account end,
                case when fu.near_verified then fu.near_account end,
                a.treasury_account
              ) as payee_account
         from share_pay_links sp
         join shares s on s.id = sp.share_id
         join bills b on b.id = s.bill_id
         join agreements a on a.id = b.agreement_id
         left join members fm on fm.id = a.fronted_by
         left join users fu on fu.id = fm.user_id
        where sp.token = $1`,
      [token],
    );

    const row = rows[0];
    if (!row) throw ApiError.notFound('Pay link not found');

    // The quote is frozen when the link is created, so the number here is the
    // number the wallet must sign — not a fresh conversion that has since moved.
    const quote = quoteFromRow(row);
    const paid = ['paid', 'settled', 'refunded'].includes(row.status);
    const title = row.bill_title?.trim();

    return {
      // The id itself is not a credential — settling still needs a session that
      // owns the share — but it lets a signed-in visitor pay without leaving
      // this page for the Shares list.
      shareId: row.share_id,
      billTitle: title && title.length > 0 ? title : 'Shared bill',
      currency: row.currency.trim(),
      amountMinor: row.amount,
      amount: formatAmount(row.amount, row.currency),
      chainAmount: quote?.amount ?? null,
      payeeAccount: row.payee_account,
      tokenContract: config.near.usdcContract || null,
      memo: `globie:${row.share_id}`,
      status: paid ? 'paid' : 'due',
      explorerUrl:
        paid && row.settlement_tx_hash ? explorerTx(row.settlement_tx_hash) : null,
    };
  });
};
