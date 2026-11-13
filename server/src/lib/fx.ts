/**
 * Indicative display rates (DEV_PLAN §2.19).
 *
 * There is no on-chain exchange rate for a group's currency, so a member's
 * chosen display currency is converted with a market rate, always rendered with
 * `≈`, and the canonical amount in the group currency is what is stored and
 * charged.
 */

import { query } from '../db/pool.js';
import { config } from './config.js';
import { ApiError } from './http-error.js';

export type FxSnapshot = {
  base: string;
  asOf: string;
  source: string;
  /** True when the upstream fetch failed and this is the last known good set. */
  stale: boolean;
  /** Quote code → units of quote per 1 base. Always contains `rates[base] = 1`. */
  rates: Record<string, number>;
};

type UpstreamPayload = {
  result?: string;
  provider?: string;
  time_last_update_unix?: number;
  rates?: Record<string, number>;
};

const DEFAULT_SOURCE = 'open.er-api.com';
/**
 * The fiat feed above has no crypto pairs, so a gift quoted in native NEAR
 * would never find a price. This spot endpoint fills that one gap.
 */
const TOKEN_SYMBOL = 'NEAR';
const TOKEN_SPOT_URL = 'https://api.coinbase.com/v2/prices/NEAR-USD/spot';
const TOKEN_SOURCE = 'api.coinbase.com';
/** A stale snapshot is retried sooner than a fresh one so an outage self-heals. */
const RETRY_MS = 5 * 60_000;

const cache = new Map<string, { snapshot: FxSnapshot; expiresAt: number }>();
const inflight = new Map<string, Promise<FxSnapshot>>();

function normalizeBase(value: string | undefined): string {
  const code = (value ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : config.fxBase;
}

/**
 * `NEAR` priced in USD, best effort. Returns the inverted rate so it can sit in
 * the `USD` snapshot beside the fiat rows (`rates[quote] = quote per 1 base`).
 * A failure here must not invalidate the fiat table, so it resolves to null.
 */
async function fetchTokenRate(): Promise<{ nearPerUsd: number; asOf: Date } | null> {
  try {
    const response = await fetch(TOKEN_SPOT_URL, {
      headers: {
        accept: 'application/json',
        'user-agent': 'GlobieKeeper/1.0 (+https://globie.ai)',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`spot answered ${response.status}`);

    const payload = (await response.json()) as { data?: { amount?: string } };
    const usdPerNear = Number(payload.data?.amount);
    if (!Number.isFinite(usdPerNear) || usdPerNear <= 0) {
      throw new Error('spot payload had no usable amount');
    }
    return { nearPerUsd: 1 / usdPerNear, asOf: new Date() };
  } catch (error) {
    console.warn('[fx]', TOKEN_SYMBOL, 'spot failed:', (error as Error).message);
    return null;
  }
}

async function fetchUpstream(base: string): Promise<FxSnapshot> {
  const response = await fetch(`${config.fxRatesUrl}/${base}`, {
    headers: {
      accept: 'application/json',
      'user-agent': 'GlobieKeeper/1.0 (+https://globie.ai)',
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) throw new Error(`upstream answered ${response.status}`);

  const payload = (await response.json()) as UpstreamPayload;
  if (payload.result !== 'success' || !payload.rates) {
    throw new Error('upstream payload was not a success');
  }

  const rates: Record<string, number> = {};
  for (const [quote, rate] of Object.entries(payload.rates)) {
    if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
      rates[quote.toUpperCase()] = rate;
    }
  }
  rates[base] = 1;

  let asOf = payload.time_last_update_unix
    ? new Date(payload.time_last_update_unix * 1000)
    : new Date();
  let source = payload.provider ?? DEFAULT_SOURCE;

  if (base === 'USD' && !(TOKEN_SYMBOL in rates)) {
    const spot = await fetchTokenRate();
    if (spot) {
      rates[TOKEN_SYMBOL] = spot.nearPerUsd;
      asOf = spot.asOf;
      source = `${source}+${TOKEN_SOURCE}`;
    }
  }

  return {
    base,
    asOf: asOf.toISOString(),
    source,
    stale: false,
    rates,
  };
}

/** Remember the last good table so an upstream outage degrades instead of 500s. */
async function persist(snapshot: FxSnapshot): Promise<void> {
  const quotes = Object.keys(snapshot.rates);
  if (quotes.length === 0) return;

  try {
    await query(
      `insert into fx_rates (base, quote, rate, as_of, source)
       select $1, t.quote, t.rate, $2::timestamptz, $3
         from unnest($4::text[], $5::numeric[]) as t(quote, rate)
       on conflict (base, quote) do update
         set rate = excluded.rate, as_of = excluded.as_of, source = excluded.source`,
      [
        snapshot.base,
        snapshot.asOf,
        snapshot.source,
        quotes,
        quotes.map((quote) => snapshot.rates[quote]),
      ],
    );
  } catch (error) {
    // A missing snapshot only costs freshness; it must not fail the request.
    console.warn('[fx] could not persist rates:', (error as Error).message);
  }
}

async function loadPersisted(base: string): Promise<FxSnapshot | null> {
  const { rows } = await query<{
    quote: string;
    rate: string;
    as_of: Date;
    source: string;
  }>(
    `select quote, rate::text, as_of, source from fx_rates where base = $1`,
    [base],
  );
  if (rows.length === 0) return null;

  const rates: Record<string, number> = {};
  let newest = 0;
  let source = DEFAULT_SOURCE;

  for (const row of rows) {
    const rate = Number(row.rate);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    rates[row.quote.trim()] = rate;
    const at = new Date(row.as_of).getTime();
    if (at > newest) {
      newest = at;
      source = row.source;
    }
  }
  rates[base] = 1;

  return {
    base,
    asOf: new Date(newest).toISOString(),
    source,
    stale: true,
    rates,
  };
}

/**
 * Cached rate table for one base. Refreshed at most once per `fxCacheTtlMs`;
 * concurrent callers share one upstream request.
 */
export async function getRates(requestedBase?: string): Promise<FxSnapshot> {
  const base = normalizeBase(requestedBase);

  const hit = cache.get(base);
  if (hit && hit.expiresAt > Date.now()) return hit.snapshot;

  const pending = inflight.get(base);
  if (pending) return pending;

  const task = (async (): Promise<FxSnapshot> => {
    try {
      const fresh = await fetchUpstream(base);
      cache.set(base, { snapshot: fresh, expiresAt: Date.now() + config.fxCacheTtlMs });
      await persist(fresh);
      return fresh;
    } catch (error) {
      console.warn('[fx] upstream failed:', base, (error as Error).message);

      const lastKnown = await loadPersisted(base);
      if (lastKnown) {
        cache.set(base, { snapshot: lastKnown, expiresAt: Date.now() + RETRY_MS });
        return lastKnown;
      }

      throw new ApiError(503, 'fx_unavailable', 'Exchange rates are unavailable right now');
    } finally {
      inflight.delete(base);
    }
  })();

  inflight.set(base, task);
  return task;
}
