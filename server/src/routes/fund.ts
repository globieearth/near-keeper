/**
 * The Globie Fund as the donate screen sees it: what is needed, what a gift
 * costs right now, and the deed that proves it happened.
 *
 * There is no payment endpoint here. The donor's wallet makes the transfer with
 * the instruction `/near/ft-transfer` or `/near/native-transfer` returns, and
 * this route only reads the resulting hash back from the chain.
 */

import type { FastifyPluginAsync } from 'fastify';

import { config } from '../lib/config.js';
import {
  createFundQuote,
  listFundDeeds,
  listFundProjects,
  settleFundDeed,
  type FundAsset,
} from '../lib/fund.js';
import { ApiError } from '../lib/http-error.js';
import { asRecord, enumValue, requiredString, requiredUuid } from '../lib/validate.js';
import { requireUser } from '../plugins/auth.js';

/**
 * Base58 of a 32-byte hash is 43 or 44 characters. This only screens out junk
 * before the RPC sees it; the node still rejects hashes that decode to the
 * wrong byte length, which the verification reports as "not found".
 */
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

const ASSETS = ['usdc', 'near'] as const;

export const fundRoutes: FastifyPluginAsync = async (app) => {
  /** The catalogue plus everything the screen needs to render a pay button. */
  app.get('/fund/projects', async (request) => {
    requireUser(request);

    return {
      projects: await listFundProjects(),
      assets: (config.near.usdcContract ? ASSETS : ['near']) as readonly FundAsset[],
      network: config.near.network,
      explorerUrl: config.near.explorerUrl,
      treasuryAccount: config.fund.treasuryAccount || null,
    };
  });

  /** The donor's own giving history. */
  app.get('/fund/deeds', async (request) => {
    const auth = requireUser(request);
    return listFundDeeds(auth.userId);
  });

  /**
   * Freeze a gift. `qty` is a number of trees, never an amount of money — the
   * price per tree belongs to the sanctuary and lives in `fund_projects`.
   */
  app.post('/fund/quote', async (request) => {
    const auth = requireUser(request);
    const body = asRecord(request.body);

    const projectId = requiredString(body, 'projectId', { min: 1, max: 64 });
    const asset = enumValue(body, 'asset', ASSETS, 'usdc');

    const rawQty = body.qty;
    const qty = typeof rawQty === 'number' ? rawQty : Number(rawQty ?? 1);
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > 1000) {
      throw ApiError.badRequest(
        'invalid_qty',
        'qty must be a whole number of trees between 1 and 1000',
      );
    }

    return createFundQuote({ userId: auth.userId, projectId, qty, asset });
  });

  /** The donor pastes the hash their wallet produced; the chain decides. */
  app.post('/fund/settle', async (request) => {
    const auth = requireUser(request);
    const body = asRecord(request.body);

    const quoteId = requiredUuid(body, 'quoteId');
    const txHash = body.txHash;
    if (typeof txHash !== 'string' || !TX_HASH.test(txHash.trim())) {
      throw ApiError.badRequest(
        'invalid_txHash',
        'txHash must be the base58 hash of the transfer',
      );
    }

    return settleFundDeed({
      quoteId,
      userId: auth.userId,
      txHash: txHash.trim(),
    });
  });
};
