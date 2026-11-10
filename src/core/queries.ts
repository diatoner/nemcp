export const DATA = process.env.NEM_DATA_DIR ?? 'data';
export const pq = (table: string) => `read_parquet('${DATA}/${table}/**/*.parquet', union_by_name = true)`;

/** Minimum intervals before tail-share statistics are meaningful (~3.5 days of 5-min data). */
export const MIN_TAIL_N = 1000;

/** Latest version of each pricing-run (INTERVENTION = 0) price row. */
const PRICE_CTE = `
  p AS (
    SELECT DISTINCT ON (INTERVAL_END_UTC, REGIONID)
           INTERVAL_END_UTC, REGIONID, TRY_CAST(RRP AS DOUBLE) AS rrp, SOURCE_URL
    FROM ${pq('dispatch_price')}
    WHERE INTERVENTION = '0'
    ORDER BY INTERVAL_END_UTC, REGIONID, LASTCHANGED DESC
  )`;

const REGIONSUM_CTE = `
  d AS (
    SELECT DISTINCT ON (INTERVAL_END_UTC, REGIONID)
           INTERVAL_END_UTC, REGIONID,
           TRY_CAST(TOTALDEMAND AS DOUBLE)         AS total_demand_mw,
           TRY_CAST(AVAILABLEGENERATION AS DOUBLE) AS available_generation_mw,
           TRY_CAST(NETINTERCHANGE AS DOUBLE)      AS net_interchange_mw
    FROM ${pq('dispatch_regionsum')}
    WHERE INTERVENTION = '0'
    ORDER BY INTERVAL_END_UTC, REGIONID, LASTCHANGED DESC
  )`;

/** Re-encode '#' so archive URLs are clickable (older rows were stored decoded). */
const url = (col: string) => `replace(${col}, '#', '%23')`;

export const BUCKETS = { '5min': '5 minutes', '30min': '30 minutes', '1h': '1 hour', '1d': '1 day' } as const;
export type Resolution = keyof typeof BUCKETS;

/** Prices in period-ending buckets aligned to NEM time; both bucket start and end are labelled. */
export function pricesSql(res: Resolution) {
  const b = BUCKETS[res];
  const start = `time_bucket(INTERVAL '${b}', end_nem - INTERVAL 5 MINUTE)`;
  return `
    WITH ${PRICE_CTE},
    f AS (
      SELECT *, INTERVAL_END_UTC + INTERVAL 10 HOUR AS end_nem
      FROM p
      WHERE REGIONID = $region
        AND INTERVAL_END_UTC >  $from::TIMESTAMP
        AND INTERVAL_END_UTC <= $to::TIMESTAMP
    )
    SELECT
      strftime(${start}, '%Y-%m-%d %H:%M')                      AS bucket_start_nem,
      strftime(${start} + INTERVAL '${b}', '%Y-%m-%d %H:%M')    AS bucket_end_nem,
      round(avg(rrp), 2)                   AS mean_rrp,
      round(min(rrp), 2)                   AS min_rrp,
      round(max(rrp), 2)                   AS max_rrp,
      count(*)::INTEGER                    AS n_intervals,
      count(DISTINCT SOURCE_URL)::INTEGER  AS source_files
    FROM f
    GROUP BY 1, 2
    ORDER BY 1`;
}

/** Price distribution + concentration of energy value in the highest-price intervals. */
export const distributionSql = `
  WITH ${PRICE_CTE}, ${REGIONSUM_CTE},
  j AS (
    SELECT p.rrp,
           d.total_demand_mw,
           p.rrp * greatest(d.total_demand_mw, 0) / 12.0 AS energy_value_dollars
    FROM p JOIN d USING (INTERVAL_END_UTC, REGIONID)
    WHERE REGIONID = $region
      AND INTERVAL_END_UTC >  $from::TIMESTAMP
      AND INTERVAL_END_UTC <= $to::TIMESTAMP
  ),
  r AS (
    SELECT *,
           row_number() OVER (ORDER BY rrp DESC)::INTEGER AS rk,
           count(*) OVER ()::INTEGER                      AS n
    FROM j
  ),
  s AS (
    SELECT
      any_value(n)                                                   AS n_intervals,
      count(*) FILTER (WHERE total_demand_mw < 0)::INTEGER           AS n_negative_demand,
      avg(rrp) AS mean_rrp, median(rrp) AS median_rrp,
      quantile_cont(rrp, 0.01) AS p01, quantile_cont(rrp, 0.10) AS p10,
      quantile_cont(rrp, 0.90) AS p90, quantile_cont(rrp, 0.99) AS p99,
      quantile_cont(rrp, 0.999) AS p999,
      min(rrp) AS min_rrp, max(rrp) AS max_rrp,
      sum(energy_value_dollars)                                      AS total_value,
      sum(energy_value_dollars) FILTER (WHERE rk <= ceil(n * 0.01))  AS top1_value,
      sum(energy_value_dollars) FILTER (WHERE rk <= ceil(n * 0.001)) AS top01_value,
      count(*) FILTER (WHERE rrp < 0)::DOUBLE / any_value(n)         AS share_neg
    FROM r
  )
  SELECT
    n_intervals, n_negative_demand,
    round(mean_rrp, 2) AS mean_rrp, round(median_rrp, 2) AS median_rrp,
    round(p01, 2) AS p01, round(p10, 2) AS p10, round(p90, 2) AS p90,
    round(p99, 2) AS p99, round(p999, 2) AS p999,
    round(min_rrp, 2) AS min_rrp, round(max_rrp, 2) AS max_rrp,
    round(total_value)::BIGINT::DOUBLE AS total_energy_value_dollars,
    CASE WHEN n_intervals >= ${MIN_TAIL_N} AND total_value > 0
         THEN round(top1_value  / total_value, 4) END AS share_value_top_1pct_intervals,
    CASE WHEN n_intervals >= ${MIN_TAIL_N} AND total_value > 0
         THEN round(top01_value / total_value, 4) END AS share_value_top_0_1pct_intervals,
    round(share_neg, 4) AS share_intervals_negative
  FROM s`;

/** Daily stats ranked; avoids pulling a year of daily rows to find the extremes. n is inlined (validated int). */
export function extremeDaysSql(order: 'highest' | 'lowest', n: number) {
  return `
    WITH ${PRICE_CTE},
    f AS (
      SELECT rrp, strftime(INTERVAL_END_UTC + INTERVAL 10 HOUR - INTERVAL 5 MINUTE, '%Y-%m-%d') AS nem_day
      FROM p
      WHERE REGIONID = $region
        AND INTERVAL_END_UTC >  $from::TIMESTAMP
        AND INTERVAL_END_UTC <= $to::TIMESTAMP
    ),
    days AS (
      SELECT nem_day,
             avg(rrp) AS mean_rrp, max(rrp) AS max_rrp, min(rrp) AS min_rrp,
             count(*)::INTEGER                              AS n_intervals,
             count(*) FILTER (WHERE rrp >= 5000)::INTEGER   AS intervals_ge_5000,
             count(*) FILTER (WHERE rrp < 0)::INTEGER       AS intervals_negative
      FROM f GROUP BY 1
    ),
    t AS (SELECT sum(mean_rrp) AS total, count(*)::INTEGER AS n_days FROM days)
    SELECT nem_day,
           round(mean_rrp, 2) AS mean_rrp, round(max_rrp, 2) AS max_rrp, round(min_rrp, 2) AS min_rrp,
           n_intervals, intervals_ge_5000, intervals_negative,
           CASE WHEN t.total > 0 THEN round(mean_rrp / t.total, 4) END AS share_of_period_mean,
           round(t.total / t.n_days, 2) AS period_mean_of_daily_means,
           t.n_days
    FROM days, t
    ORDER BY mean_rrp ${order === 'highest' ? 'DESC' : 'ASC'}
    LIMIT ${Math.trunc(n)}`;
}

export const regionSummarySql = `
  WITH ${PRICE_CTE}, ${REGIONSUM_CTE}
  SELECT strftime(INTERVAL_END_UTC + INTERVAL 10 HOUR, '%Y-%m-%d %H:%M') AS interval_end_nem,
         strftime(INTERVAL_END_UTC, '%Y-%m-%dT%H:%M:%SZ')               AS interval_end_utc,
         round(p.rrp, 2)                       AS rrp,
         round(d.total_demand_mw, 1)           AS total_demand_mw,
         round(d.available_generation_mw, 1)   AS available_generation_mw,
         round(d.net_interchange_mw, 1)        AS net_interchange_mw,
         ${url('p.SOURCE_URL')}                AS source_url
  FROM p JOIN d USING (INTERVAL_END_UTC, REGIONID)
  WHERE REGIONID = $region
  ORDER BY INTERVAL_END_UTC DESC
  LIMIT $limit`;

/** Latest registration row per DUID, optionally joined to station names. */
export function lookupUnitSql(withStation: boolean) {
  const station = withStation
    ? `, s AS (
         SELECT DISTINCT ON (STATIONID) STATIONID, STATIONNAME
         FROM ${pq('station')}
         ORDER BY STATIONID, LASTCHANGED DESC
       )`
    : '';
  const name = withStation ? 's.STATIONNAME' : 'NULL';
  return `
    WITH u AS (
      SELECT DISTINCT ON (DUID)
             DUID, REGIONID, STATIONID, PARTICIPANTID, DISPATCHTYPE, START_DATE, END_DATE, SOURCE_URL
      FROM ${pq('dudetailsummary')}
      ORDER BY DUID, START_DATE DESC, LASTCHANGED DESC
    )${station}
    SELECT u.DUID AS duid, ${name} AS station_name, u.STATIONID AS station_id,
           u.REGIONID AS region, u.PARTICIPANTID AS participant_id,
           u.DISPATCHTYPE AS dispatch_type, u.START_DATE AS start_date, u.END_DATE AS end_date,
           ${url('u.SOURCE_URL')} AS source_url,
           (strptime(u.END_DATE, '%Y/%m/%d %H:%M:%S') >= now()::TIMESTAMP) AS active
    FROM u ${withStation ? 'LEFT JOIN s USING (STATIONID)' : ''}
    WHERE u.DUID ILIKE $q OR u.STATIONID ILIKE $q ${withStation ? 'OR s.STATIONNAME ILIKE $q' : ''}
    ORDER BY (lower(u.DUID) = lower($exact)) DESC, active DESC, u.DUID
    LIMIT 25`;
}

const sqlLit = (s: string) => `'${s.replace(/'/g, "''")}'`;

// ---------- Interconnectors ----------

const IC_CTE = `
  ic AS (
    SELECT DISTINCT ON (INTERVAL_END_UTC, INTERCONNECTORID)
           INTERVAL_END_UTC, INTERCONNECTORID,
           TRY_CAST(MWFLOW AS DOUBLE)        AS flow_mw,
           TRY_CAST(EXPORTLIMIT AS DOUBLE)   AS export_limit_mw,
           TRY_CAST(IMPORTLIMIT AS DOUBLE)   AS import_limit_mw,
           TRY_CAST(MARGINALVALUE AS DOUBLE) AS marginal_value,
           EXPORTGENCONID AS export_limit_constraint,
           IMPORTGENCONID AS import_limit_constraint,
           SOURCE_URL
    FROM ${pq('dispatch_interconnectorres')}
    WHERE INTERVENTION = '0'
      AND INTERVAL_END_UTC >  $from::TIMESTAMP
      AND INTERVAL_END_UTC <= $to::TIMESTAMP
    ORDER BY INTERVAL_END_UTC, INTERCONNECTORID, LASTCHANGED DESC
  )`;

/** ±1 MW tolerance for "at limit". */
const AT_EXPORT = `abs(flow_mw - export_limit_mw) <= 1`;
const AT_IMPORT = `abs(flow_mw - import_limit_mw) <= 1`;

export function interconnectorsSql(snapshot: boolean) {
  if (snapshot) {
    return `
      WITH ${IC_CTE}
      SELECT strftime(INTERVAL_END_UTC + INTERVAL 10 HOUR, '%Y-%m-%d %H:%M') AS interval_end_nem,
             INTERCONNECTORID                AS interconnector_id,
             round(flow_mw, 1)               AS flow_mw,
             round(export_limit_mw, 1)       AS export_limit_mw,
             round(import_limit_mw, 1)       AS import_limit_mw,
             ${AT_EXPORT}                    AS at_export_limit,
             ${AT_IMPORT}                    AS at_import_limit,
             export_limit_constraint, import_limit_constraint,
             round(marginal_value, 2)        AS marginal_value,
             replace(SOURCE_URL, '#', '%23') AS source_url
      FROM ic
      ORDER BY INTERCONNECTORID`;
  }
  return `
    WITH ${IC_CTE}
    SELECT INTERCONNECTORID AS interconnector_id,
           count(*)::INTEGER                                   AS n_intervals,
           round(avg(flow_mw), 1)                              AS mean_flow_mw,
           round(min(flow_mw), 1)                              AS min_flow_mw,
           round(max(flow_mw), 1)                              AS max_flow_mw,
           count(*) FILTER (WHERE ${AT_EXPORT})::INTEGER       AS intervals_at_export_limit,
           count(*) FILTER (WHERE ${AT_IMPORT})::INTEGER       AS intervals_at_import_limit,
           mode(export_limit_constraint) FILTER (WHERE ${AT_EXPORT}) AS usual_export_limiting_constraint,
           mode(import_limit_constraint) FILTER (WHERE ${AT_IMPORT}) AS usual_import_limiting_constraint
    FROM ic
    GROUP BY 1
    ORDER BY 1`;
}

// ---------- Constraints ----------

/**
 * Binding/violated constraints in a window, ranked by total |marginal value|.
 * For a single interval (window of 5 min), each row is that interval's values.
 */
export function constraintsSql(withDescription: boolean, bindingOnly: boolean, n: number) {
  const g = withDescription
    ? `, g AS (
         SELECT DISTINCT ON (GENCONID) GENCONID, DESCRIPTION, LIMITTYPE, REASON
         FROM ${pq('gencondata')}
         ORDER BY GENCONID, EFFECTIVEDATE DESC, TRY_CAST(VERSIONNO AS INTEGER) DESC
       )`
    : '';
  const desc = withDescription
    ? `any_value(g.DESCRIPTION) AS description, any_value(g.LIMITTYPE) AS limit_type, any_value(g.REASON) AS reason,`
    : '';
  return `
    WITH c AS (
      SELECT DISTINCT ON (INTERVAL_END_UTC, CONSTRAINTID)
             INTERVAL_END_UTC, CONSTRAINTID,
             TRY_CAST(RHS AS DOUBLE)             AS rhs,
             TRY_CAST(LHS AS DOUBLE)             AS lhs,
             TRY_CAST(MARGINALVALUE AS DOUBLE)   AS mv,
             TRY_CAST(VIOLATIONDEGREE AS DOUBLE) AS violation,
             SOURCE_URL
      FROM ${pq('dispatch_constraint')}
      WHERE INTERVENTION = '0'
        AND INTERVAL_END_UTC >  $from::TIMESTAMP
        AND INTERVAL_END_UTC <= $to::TIMESTAMP
      ORDER BY INTERVAL_END_UTC, CONSTRAINTID, LASTCHANGED DESC
    )${g}
    SELECT c.CONSTRAINTID AS constraint_id,
           count(*)::INTEGER                                   AS n_intervals,
           count(*) FILTER (WHERE mv <> 0)::INTEGER            AS intervals_binding,
           count(*) FILTER (WHERE violation > 0)::INTEGER      AS intervals_violated,
           round(max(abs(mv)), 2)                              AS max_abs_marginal_value,
           round(sum(abs(mv)), 2)                              AS sum_abs_marginal_value,
           round(sum(least(abs(mv), 20300)), 2)                AS sum_abs_mv_capped,
           round(max(violation), 2)                            AS max_violation_mw,
           round(arg_max(rhs, INTERVAL_END_UTC), 1)            AS rhs_latest,
           round(arg_max(lhs, INTERVAL_END_UTC), 1)            AS lhs_latest,
           strftime(min(INTERVAL_END_UTC) FILTER (WHERE mv <> 0) + INTERVAL 10 HOUR, '%Y-%m-%d %H:%M') AS first_binding_nem,
           strftime(max(INTERVAL_END_UTC) FILTER (WHERE mv <> 0) + INTERVAL 10 HOUR, '%Y-%m-%d %H:%M') AS last_binding_nem,
           ${desc}
           replace(any_value(c.SOURCE_URL), '#', '%23')        AS example_source_url
    FROM c ${withDescription ? 'LEFT JOIN g ON g.GENCONID = c.CONSTRAINTID' : ''}
    GROUP BY c.CONSTRAINTID
    ${bindingOnly ? 'HAVING count(*) FILTER (WHERE mv <> 0 OR violation > 0) > 0' : ''}
    ORDER BY sum_abs_mv_capped DESC NULLS LAST
    LIMIT ${Math.trunc(n)}`;
}

/** Version key: latest EFFECTIVEDATE, then highest VERSIONNO. */
const VER = (t: string) => `${t}.EFFECTIVEDATE || '|' || lpad(${t}.VERSIONNO, 6, '0')`;

/** Interconnector terms (latest version) for the given constraint IDs. */
export function interconnectorTermsSql(ids: string[]) {
  return `
    WITH t AS (SELECT * FROM ${pq('spdinterconnectorconstraint')} WHERE GENCONID IN (${ids.map(sqlLit).join(', ')})),
    v AS (SELECT GENCONID, max(${VER('t')}) AS ver FROM t GROUP BY 1)
    SELECT DISTINCT t.GENCONID AS constraint_id, 'interconnector' AS kind,
           t.INTERCONNECTORID AS term_id, NULL AS duid, NULL AS bid_type,
           TRY_CAST(t.FACTOR AS DOUBLE) AS factor
    FROM t JOIN v ON t.GENCONID = v.GENCONID AND ${VER('t')} = v.ver`;
}

/** Unit (connection point) terms (latest version), mapped to a DUID where possible. */
export function unitTermsSql(ids: string[], withUnits: boolean) {
  const u = withUnits
    ? `, u AS (
         SELECT DISTINCT ON (CONNECTIONPOINTID) CONNECTIONPOINTID, DUID
         FROM ${pq('dudetailsummary')}
         ORDER BY CONNECTIONPOINTID, START_DATE DESC
       )`
    : '';
  return `
    WITH t AS (SELECT * FROM ${pq('spdconnectionpointconstraint')} WHERE GENCONID IN (${ids.map(sqlLit).join(', ')})),
    v AS (SELECT GENCONID, max(${VER('t')}) AS ver FROM t GROUP BY 1)${u}
    SELECT DISTINCT t.GENCONID AS constraint_id, 'unit' AS kind,
           t.CONNECTIONPOINTID AS term_id, ${withUnits ? 'u.DUID' : 'NULL'} AS duid, t.BIDTYPE AS bid_type,
           TRY_CAST(t.FACTOR AS DOUBLE) AS factor
    FROM t JOIN v ON t.GENCONID = v.GENCONID AND ${VER('t')} = v.ver
    ${withUnits ? 'LEFT JOIN u USING (CONNECTIONPOINTID)' : ''}`;
}

// ---------- Events ----------

/**
 * Runs of consecutive 5-minute intervals meeting a price condition (gaps-and-islands).
 * kind 'spike': rrp >= $threshold; kind 'negative': rrp < $threshold. Ranked by intensity.
 */
export function priceRunsSql(kind: 'spike' | 'negative', n: number) {
  const cond = kind === 'spike' ? 'rrp >= $threshold' : 'rrp < $threshold';
  const order = kind === 'spike' ? 'sum(rrp) DESC' : 'count(*) DESC, min(rrp) ASC';
  const peak = kind === 'spike' ? 'arg_max(ts, rrp)' : 'arg_min(ts, rrp)';
  return `
    WITH ${PRICE_CTE},
    f AS (
      SELECT INTERVAL_END_UTC AS ts, rrp FROM p
      WHERE REGIONID = $region
        AND INTERVAL_END_UTC >  $from::TIMESTAMP
        AND INTERVAL_END_UTC <= $to::TIMESTAMP
        AND ${cond}
    ),
    g AS (
      SELECT ts, rrp, ts - to_minutes(5 * (row_number() OVER (ORDER BY ts))::BIGINT) AS grp FROM f
    )
    SELECT strftime(min(ts) - INTERVAL 5 MINUTE + INTERVAL 10 HOUR, '%Y-%m-%d %H:%M') AS start_nem,
           strftime(max(ts) + INTERVAL 10 HOUR, '%Y-%m-%d %H:%M')                     AS end_nem,
           count(*)::INTEGER                     AS intervals,
           round(count(*) * 5 / 60.0, 2)         AS hours,
           round(avg(rrp), 2)                    AS mean_rrp,
           round(max(rrp), 2)                    AS max_rrp,
           round(min(rrp), 2)                    AS min_rrp,
           strftime(${peak} + INTERVAL 10 HOUR, '%Y-%m-%d %H:%M') AS peak_interval_end_nem
    FROM g
    GROUP BY grp
    HAVING count(*) >= $min_intervals
    ORDER BY ${order}
    LIMIT ${Math.trunc(n)}`;
}

/** Constraints violated in a window (NEM-wide; constraints are not region-keyed). */
export function violationsSql(n: number) {
  return `
    WITH c AS (
      SELECT DISTINCT ON (INTERVAL_END_UTC, CONSTRAINTID)
             INTERVAL_END_UTC, CONSTRAINTID, TRY_CAST(VIOLATIONDEGREE AS DOUBLE) AS violation
      FROM ${pq('dispatch_constraint')}
      WHERE INTERVENTION = '0'
        AND INTERVAL_END_UTC >  $from::TIMESTAMP
        AND INTERVAL_END_UTC <= $to::TIMESTAMP
      ORDER BY INTERVAL_END_UTC, CONSTRAINTID, LASTCHANGED DESC
    )
    SELECT CONSTRAINTID AS constraint_id,
           count(*)::INTEGER AS intervals_violated,
           round(max(violation), 2) AS max_violation_mw,
           strftime(min(INTERVAL_END_UTC) + INTERVAL 10 HOUR, '%Y-%m-%d %H:%M') AS first_nem,
           strftime(max(INTERVAL_END_UTC) + INTERVAL 10 HOUR, '%Y-%m-%d %H:%M') AS last_nem
    FROM c WHERE violation > 0
    GROUP BY 1 ORDER BY 2 DESC
    LIMIT ${Math.trunc(n)}`;
}

/** Every region at one interval: price, demand, availability, interchange. */
export const regionsAtSql = `
  WITH ${PRICE_CTE}, ${REGIONSUM_CTE}
  SELECT REGIONID AS region,
         round(p.rrp, 2)                     AS rrp,
         round(d.total_demand_mw, 1)         AS total_demand_mw,
         round(d.available_generation_mw, 1) AS available_generation_mw,
         round(d.net_interchange_mw, 1)      AS net_interchange_mw,
         replace(p.SOURCE_URL, '#', '%23')   AS source_url
  FROM p JOIN d USING (INTERVAL_END_UTC, REGIONID)
  WHERE INTERVAL_END_UTC = $at::TIMESTAMP
  ORDER BY 1`;

// ---------- Generation (unit SCADA) ----------

function scadaCte(withFuel: boolean) {
  const fuel = withFuel
    ? `coalesce(f.fuel_group, CASE WHEN u.DISPATCHTYPE = 'BIDIRECTIONAL' THEN 'battery' END, 'unknown')`
    : `CASE WHEN u.DISPATCHTYPE = 'BIDIRECTIONAL' THEN 'battery' ELSE 'unknown' END`;
  return `
    s AS (
      SELECT DISTINCT ON (INTERVAL_END_UTC, DUID) INTERVAL_END_UTC, DUID, TRY_CAST(SCADAVALUE AS DOUBLE) AS mw
      FROM ${pq('dispatch_unit_scada')}
      WHERE INTERVAL_END_UTC > $from::TIMESTAMP AND INTERVAL_END_UTC <= $to::TIMESTAMP
      ORDER BY INTERVAL_END_UTC, DUID, LASTCHANGED DESC
    ),
    u AS (
      SELECT DISTINCT ON (DUID) DUID, REGIONID, DISPATCHTYPE
      FROM ${pq('dudetailsummary')}
      ORDER BY DUID, START_DATE DESC, LASTCHANGED DESC
    )${withFuel ? `,
    f AS (SELECT DUID, any_value(FUEL_GROUP) AS fuel_group, any_value(STATION_NAME) AS station_name FROM ${pq('unit_fuel')} GROUP BY 1)` : ''},
    x AS (
      SELECT s.INTERVAL_END_UTC, s.DUID, u.DISPATCHTYPE,
             CASE WHEN u.DISPATCHTYPE = 'LOAD' THEN -s.mw ELSE s.mw END AS mw,  -- loads (e.g. old split battery DUIDs) negative
             ${fuel} AS fuel_group,
             ${withFuel ? 'f.station_name' : 'NULL'} AS station_name
      FROM s JOIN u USING (DUID) ${withFuel ? 'LEFT JOIN f USING (DUID)' : ''}
      WHERE u.REGIONID = $region
    )`;
}

/** Fleet output by fuel group per period-ending bucket (NEM time). */
export function genByFuelSql(res: '5min' | '30min' | '1h', withFuel: boolean) {
  const b = BUCKETS[res];
  return `
    WITH ${scadaCte(withFuel)}
    SELECT strftime(time_bucket(INTERVAL '${b}', INTERVAL_END_UTC + INTERVAL 10 HOUR - INTERVAL 5 MINUTE) + INTERVAL '${b}', '%Y-%m-%d %H:%M') AS bucket_end_nem,
           fuel_group,
           round(sum(mw) / count(DISTINCT INTERVAL_END_UTC), 1) AS mean_mw,
           round(sum(mw) * 5 / 60.0, 1)                         AS energy_mwh,
           count(DISTINCT DUID)::INTEGER                        AS units
    FROM x
    GROUP BY 1, 2
    ORDER BY 1, 2`;
}

/** Top units by |energy| in the window. */
export function genByUnitSql(n: number, withFuel: boolean) {
  return `
    WITH ${scadaCte(withFuel)}
    SELECT DUID AS duid, any_value(station_name) AS station_name, any_value(fuel_group) AS fuel_group,
           any_value(DISPATCHTYPE) AS dispatch_type,
           round(avg(mw), 1) AS mean_mw, round(min(mw), 1) AS min_mw, round(max(mw), 1) AS max_mw,
           round(sum(mw) * 5 / 60.0, 1) AS energy_mwh,
           round(arg_max(mw, INTERVAL_END_UTC), 1) AS last_mw
    FROM x
    GROUP BY 1
    ORDER BY abs(sum(mw)) DESC
    LIMIT ${Math.trunc(n)}`;
}
