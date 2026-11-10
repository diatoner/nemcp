import { query } from './db.js';
import { pq } from './queries.js';

export const STALE_MINUTES = 15;

export interface Freshness {
  data_as_of_utc: string | null;
  data_as_of_nem: string | null;
  data_age_minutes: number | null;
}

let cached: { at: number; f: Freshness } | undefined;

/** Latest loaded dispatch interval (cached 30 s). */
export async function freshness(): Promise<Freshness> {
  if (cached && Date.now() - cached.at < 30_000) return cached.f;
  let f: Freshness = { data_as_of_utc: null, data_as_of_nem: null, data_age_minutes: null };
  try {
    const [r] = await query(`
      SELECT strftime(max(INTERVAL_END_UTC), '%Y-%m-%dT%H:%M:%SZ')                  AS utc,
             strftime(max(INTERVAL_END_UTC) + INTERVAL 10 HOUR, '%Y-%m-%d %H:%M')  AS nem
      FROM ${pq('dispatch_price')}`);
    if (r?.utc) {
      const utc = String(r.utc);
      f = {
        data_as_of_utc: utc,
        data_as_of_nem: `${r.nem} NEM`,
        data_age_minutes: Math.max(0, Math.round((Date.now() - Date.parse(utc)) / 60_000)),
      };
    }
  } catch {
    // no parquet files yet
  }
  cached = { at: Date.now(), f };
  return f;
}

/** Warn when data is stale and the request reaches past the latest loaded interval. */
export function freshnessCaveats(f: Freshness, rangeTo?: string): string[] {
  if (!f.data_as_of_utc) return ['No dispatch data is loaded. Run ingestion or a backfill.'];
  const reachesPastData = rangeTo === undefined || Date.parse(rangeTo) > Date.parse(f.data_as_of_utc);
  if (f.data_age_minutes !== null && f.data_age_minutes > STALE_MINUTES && reachesPastData) {
    return [
      `Data is stale: the latest loaded interval ends ${f.data_as_of_nem} (${f.data_age_minutes} min ago). ` +
      'Ingestion may have stopped, so recent intervals are missing.',
    ];
  }
  return [];
}

/** Compare intervals found with intervals expected in [from, to], capped at now. */
export function completenessCaveats(found: number, from: string, to: string, now = Date.now()): string[] {
  const end = Math.min(Date.parse(to), now);
  const expected = Math.max(0, Math.round((end - Date.parse(from)) / 300_000));
  if (found === 0) return ['No data in this window. Call get_coverage to see what is loaded.'];
  if (expected > 0 && found < expected) {
    const pct = ((100 * found) / expected).toFixed(1);
    return [`Only ${found} of ${expected} expected 5-minute intervals are present (${pct}%). Call get_coverage to find the gaps.`];
  }
  return [];
}

/** What is loaded: per-region span, per-NEM-month completeness, and gaps. */
export async function coverage(table: 'dispatch_price' | 'dispatch_regionsum') {
  const src = pq(table);
  const by_region = await query(`
    SELECT REGIONID AS region,
           strftime(min(INTERVAL_END_UTC) + INTERVAL 10 HOUR, '%Y-%m-%d %H:%M') AS first_interval_end_nem,
           strftime(max(INTERVAL_END_UTC) + INTERVAL 10 HOUR, '%Y-%m-%d %H:%M') AS last_interval_end_nem,
           count(DISTINCT INTERVAL_END_UTC)::INTEGER                            AS intervals
    FROM ${src} WHERE INTERVENTION = '0'
    GROUP BY 1 ORDER BY 1`);
  const by_month = await query(`
    WITH t AS (
      SELECT DISTINCT INTERVAL_END_UTC + INTERVAL 10 HOUR - INTERVAL 5 MINUTE AS start_nem
      FROM ${src} WHERE INTERVENTION = '0'
    )
    SELECT strftime(start_nem, '%Y-%m')                              AS nem_month,
           count(*)::INTEGER                                         AS intervals,
           (day(last_day(min(start_nem))) * 288)::INTEGER            AS expected,
           round(count(*) / (day(last_day(min(start_nem))) * 288.0), 4) AS completeness
    FROM t GROUP BY 1 ORDER BY 1`);
  const gaps = await query(`
    WITH t AS (SELECT DISTINCT INTERVAL_END_UTC AS ts FROM ${src} WHERE INTERVENTION = '0'),
    g AS (SELECT lag(ts) OVER (ORDER BY ts) AS prev, ts FROM t)
    SELECT strftime(prev + INTERVAL 10 HOUR, '%Y-%m-%d %H:%M') AS last_before_gap_nem,
           strftime(ts   + INTERVAL 10 HOUR, '%Y-%m-%d %H:%M') AS first_after_gap_nem,
           (date_diff('minute', prev, ts) // 5 - 1)::INTEGER  AS missing_intervals
    FROM g
    WHERE prev IS NOT NULL AND ts - prev > INTERVAL 5 MINUTE
    ORDER BY prev
    LIMIT 50`);
  return { by_region, by_month, gaps, gaps_truncated: gaps.length === 50 };
}
