import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { instance, query } from '../core/db.js';
import { completenessCaveats, coverage, freshness, freshnessCaveats } from '../core/meta.js';
import {
  DATA, distributionSql, extremeDaysSql, genByFuelSql, genByUnitSql, lookupUnitSql, MIN_TAIL_N, pricesSql, regionSummarySql,
} from '../core/queries.js';
import { TIME_CONVENTION, toUtcSql } from '../core/time.js';
import { ingestFeed } from '../ingest/ingest.js';
import { exists } from '../ingest/write.js';
import { describeInterconnector } from '../core/interconnectors.js';
import {interconnectorsSql} from '../core/queries.js';
import { loadConstraints } from '../core/constraints.js';
import { explainInterval } from '../core/explain.js';
import { priceRunsSql, violationsSql } from '../core/queries.js';

const REGIONS = ['NSW1', 'QLD1', 'SA1', 'TAS1', 'VIC1'] as const;
const MAX_ROWS = 2000;

const META = {
  time_convention: TIME_CONVENTION,
  run: 'Pricing run only (INTERVENTION = 0).',
  attribution: 'Source: AEMO NEMWeb (DispatchIS, MMSDM). © AEMO, used under its Copyright Permissions Notice.',
};

const json = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
});

/** Every response carries META, data freshness, and caveats (freshness first). */
async function respond(body: Record<string, unknown> & { caveats?: string[] }, rangeTo?: string) {
  const f = await freshness();
  return json({ ...META, ...f, ...body, caveats: [...freshnessCaveats(f, rangeTo), ...(body.caveats ?? [])] });
}

const windowArgs = {
  interval: z.string().optional().describe('Interval END time (period-ending), ISO 8601 with offset, e.g. 2026-01-26T19:30:00+10:00'),
  from: z.string().optional().describe('Range start, ISO 8601 with offset (exclusive). Use with `to` instead of `interval`.'),
  to: z.string().optional().describe('Range end, ISO 8601 with offset (inclusive)'),
};

/** One interval → the 5-minute window ending at it; otherwise from/to. */
function resolveWindow(a: { interval?: string; from?: string; to?: string }) {
  if (a.interval) {
    const end = Date.parse(a.interval);
    if (Number.isNaN(end)) throw new Error(`Invalid interval: ${a.interval}`);
    return { snapshot: true, from: new Date(end - 300_000).toISOString(), to: new Date(end).toISOString() };
  }
  if (a.from && a.to) return { snapshot: false, from: a.from, to: a.to };
  throw new Error('Provide either `interval`, or both `from` and `to`.');
}

const range = {
  from: z.string().describe('ISO 8601 with offset, e.g. 2026-01-26T00:00:00+10:00 (exclusive)'),
  to: z.string().describe('ISO 8601 with offset (inclusive)'),
};

const server = new McpServer({ name: 'nem-mcp', version: '0.2.0' });

server.registerTool(
  'get_coverage',
  {
    title: 'What NEM data is loaded',
    description:
      'Per-region first/last interval, per-NEM-month completeness, and gaps in loaded dispatch data. ' +
      'Call this before analysing long ranges, or when results look incomplete.',
    inputSchema: { table: z.enum(['dispatch_price', 'dispatch_regionsum']).default('dispatch_price') },
  },
  async ({ table }) => {
    const c = await coverage(table);
    const caveats = c.gaps_truncated ? ['Only the first 50 gaps are listed.'] : [];
    return respond({ table, ...c, caveats });
  },
);

server.registerTool(
  'get_prices',
  {
    title: 'NEM regional prices',
    description:
      'Regional reference prices (RRP, $/MWh) from AEMO 5-minute dispatch, aggregated into period-ending ' +
      'buckets aligned to NEM time. For "which days were most extreme", use get_extreme_days instead.',
    inputSchema: {
      region: z.enum(REGIONS),
      ...range,
      resolution: z.enum(['5min', '30min', '1h', '1d']).default('30min'),
    },
  },
  async ({ region, from, to, resolution }) => {
    const rows = await query(pricesSql(resolution), { region, from: toUtcSql(from), to: toUtcSql(to) });
    const found = rows.reduce((s, r) => s + Number(r.n_intervals), 0);
    const caveats = [
      'mean_rrp is a simple time-average, not demand-weighted.',
      ...completenessCaveats(found, from, to),
    ];
    if (rows.length > 400) caveats.push('Large result. To find extreme days, use get_extreme_days.');
    return respond(
      {
        units: { mean_rrp: '$/MWh', min_rrp: '$/MWh', max_rrp: '$/MWh' },
        region, resolution,
        rows: rows.slice(0, MAX_ROWS),
        truncated: rows.length > MAX_ROWS,
        caveats,
      },
      to,
    );
  },
);

server.registerTool(
  'get_extreme_days',
  {
    title: 'Most extreme NEM days',
    description:
      'Ranks NEM days in a window by daily average price (highest or lowest), with each day\'s max, min, ' +
      'count of intervals >= $5,000/MWh and negative intervals, and its share of the period average.',
    inputSchema: {
      region: z.enum(REGIONS),
      ...range,
      order: z.enum(['highest', 'lowest']).default('highest'),
      n: z.number().int().min(1).max(100).default(10),
    },
  },
  async ({ region, from, to, order, n }) => {
    const rows = await query(extremeDaysSql(order, n), { region, from: toUtcSql(from), to: toUtcSql(to) });
    const caveats = [
      'share_of_period_mean = day mean / sum of daily means (its contribution to the period time-average).',
      'Days with n_intervals < 288 are incomplete.',
    ];
    if (rows.length === 0) caveats.unshift('No data in this window. Call get_coverage to see what is loaded.');
    return respond({ units: { prices: '$/MWh' }, region, from, to, order, rows, caveats }, to);
  },
);

server.registerTool(
  'get_price_distribution',
  {
    title: 'NEM price distribution and tail concentration',
    description:
      'Percentiles of 5-minute prices, plus the share of total energy value (price × demand) ' +
      'in the highest-price 1% and 0.1% of intervals.',
    inputSchema: { region: z.enum(REGIONS), ...range },
  },
  async ({ region, from, to }) => {
    const [stats] = await query(distributionSql, { region, from: toUtcSql(from), to: toUtcSql(to) });
    const n = stats?.n_intervals == null ? 0 : Number(stats.n_intervals);
    const units = { prices: '$/MWh', total_energy_value_dollars: 'AUD', shares: 'fraction 0–1' };
    const caveats = completenessCaveats(n, from, to);
    if (n === 0) return respond({ units, region, from, to, stats: null, caveats }, to);

    if (n < MIN_TAIL_N) {
      caveats.push(`Only ${n} intervals: tail shares are withheld (null) below ${MIN_TAIL_N}. Widen the date range.`);
    }
    caveats.push(
      'Energy value = RRP × max(TOTALDEMAND, 0) × 5/60 h. A proxy for wholesale value, not what consumers pay.',
      'TOTALDEMAND can be negative in high-rooftop-PV regions (e.g. SA at midday); those intervals contribute zero value.',
      'Negative-price intervals reduce total value, so tail shares can exceed intuition.',
    );
    if (Number(stats.n_negative_demand) > 0) {
      caveats.push(`${stats.n_negative_demand} interval(s) had negative TOTALDEMAND in this window.`);
    }
    return respond({ units, region, from, to, stats, caveats }, to);
  },
);

server.registerTool(
  'get_region_summary',
  {
    title: 'Latest NEM region summary',
    description: 'Most recent loaded 5-minute intervals for a region: price, demand, available generation, net interchange.',
    inputSchema: {
      region: z.enum(REGIONS),
      limit: z.number().int().min(1).max(288).default(12),
    },
  },
  async ({ region, limit }) => {
    const rows = await query(regionSummarySql, { region, limit });
    return respond({
      units: { rrp: '$/MWh', '*_mw': 'MW' },
      region, rows,
      caveats: [
        'net_interchange_mw: net interconnector flow from the regional reference node (MMS docs); positive = export.',
        'total_demand_mw is demand less dispatchable loads, and can be negative when rooftop PV exceeds regional demand.',
      ],
    });
  },
);

server.registerTool(
  'lookup_unit',
  {
    title: 'Look up a NEM unit (DUID)',
    description: 'Find generating/load units by DUID, station ID or station name (partial, case-insensitive).',
    inputSchema: { query: z.string().min(2).describe('e.g. "TORRB1", "torrens", "hornsdale"') },
  },
  async ({ query: q }) => {
    if (!(await exists(join(DATA, 'dudetailsummary')))) {
      return respond({
        rows: [],
        caveats: ['Unit reference data is not loaded. Run: pnpm backfill --tables=DUDETAILSUMMARY,STATION --from=2025-10 --to=2026-09'],
      });
    }
    const withStation = await exists(join(DATA, 'station'));
    const rows = await query(lookupUnitSql(withStation), { q: `%${q}%`, exact: q });
    const caveats = [
      'Fuel/technology is not in the MMS data model; dispatch_type only distinguishes generator, load, etc.',
      'active = registration END_DATE is in the future; inactive rows are retired or superseded registrations.',
    ];
    if (!withStation) caveats.push('Station names not loaded (backfill STATION).');
    if (rows.length === 25) caveats.push('Showing the first 25 matches; refine the query.');
    return respond({ query: q, rows, caveats });
  },
);

server.registerTool(
  'get_interconnectors',
  {
    title: 'NEM interconnector flows and limits',
    description:
      'Interconnector flows against their export/import limits, and the constraint setting each limit. ' +
      'With `interval`: a snapshot. With `from`/`to`: per-interconnector summary incl. how often each was at a limit. ' +
      'Use this to check whether a region could import during a price event.',
    inputSchema: { ...windowArgs, region: z.enum(REGIONS).optional().describe('Only interconnectors touching this region') },
  },
  async (args) => {
    const w = resolveWindow(args);
    const rows = await query(interconnectorsSql(w.snapshot), { from: toUtcSql(w.from), to: toUtcSql(w.to) });
    const enriched = rows
      .map((r) => ({ ...describeInterconnector(String(r.interconnector_id)), ...r }))
            .filter((r) => !args.region || r.from_region === args.region || r.to_region === args.region
        || (r.from_region === null && String(r.interconnector_id).includes(args.region)))
    const unknown = enriched.filter((r) => r.from_region === null).map((r) => r.interconnector_id);
    const caveats = [
      'Positive flow_mw = from_region → to_region (AEMO convention).',
      'at_*_limit uses a ±1 MW tolerance against the dispatch export/import limits.',
      'export_limit_constraint / import_limit_constraint name the constraint setting that limit; look it up with get_constraints.',
      'Limits are signed bounds: import_limit_mw ≤ flow_mw ≤ export_limit_mw. A positive import_limit_mw means flow could not reverse.',
    ];
    if (unknown.length) caveats.push(`Direction/name unknown for: ${unknown.join(', ')}.`);
    if (enriched.length === 0) caveats.unshift('No interconnector data in this window. Call get_coverage, or backfill DISPATCHINTERCONNECTORRES.');
    return respond({ units: { '*_mw': 'MW' }, ...w, rows: enriched, caveats }, w.to);
  },
);

server.registerTool(
  'get_constraints',
  {
    title: 'Binding NEM network constraints',
    description:
      'Constraints that bound (non-zero marginal value) or were violated, ranked by total |marginal value|, ' +
      'with AEMO description and the interconnector/unit terms on their left-hand side. ' +
      'With `interval`: that interval. With `from`/`to`: aggregated over the window.',
    inputSchema: {
      ...windowArgs,
      binding_only: z.boolean().default(true),
      include_unit_limits: z.boolean().default(false).describe('Include single-unit/zero-limit constraints (often penalty-weighted)'),
      scope: z.array(z.enum(['fcas', 'interconnector', 'unit', 'network'])).optional()
        .describe('Only these scopes, e.g. ["interconnector","network"] for energy-price explanations'),
      n: z.number().int().min(1).max(100).default(15),
    },
  },
  async (args) => {
    const w = resolveWindow(args);
    const { rows, withDesc, termsLoaded } = await loadConstraints({
      fromSql: toUtcSql(w.from), toSql: toUtcSql(w.to),
      bindingOnly: args.binding_only, n: args.n,
      includeUnitLimits: args.include_unit_limits, scopes: args.scope,
    });
    const caveats = [
      'marginal_value is the constraint shadow price: change in dispatch cost per 1 MW relaxation of its RHS. Non-zero = binding.',
      'intervals_violated > 0 means the constraint was relaxed; prices then may reflect constraint violation penalties, not scarcity.',
      'scope: fcas, interconnector (has an interconnector term), network, or unit (single-unit/zero limits, hidden by default). ' +
        'mv_above_price_cap = marginal value exceeds $20,300, which usually reflects penalty weighting, not $/MWh.',
    ];
    caveats.push(withDesc
      ? 'Descriptions use the latest GENCONDATA version, which may differ from the version in force at the time.'
      : 'Descriptions not loaded: backfill GENCONDATA.');
    if (!termsLoaded) caveats.push('Constraint terms not loaded: backfill SPDINTERCONNECTORCONSTRAINT and SPDCONNECTIONPOINTCONSTRAINT.');
    if (rows.length === 0) caveats.unshift('No binding constraints found in this window (or no constraint data; call get_coverage).');
    return respond({ ...w, rows, caveats }, w.to);
  },
);

server.registerTool(
  'find_events',
  {
    title: 'Find NEM price events',
    description:
      'Find runs of consecutive 5-minute intervals: price spikes (rrp >= threshold, default $1,000) or negative prices ' +
      '(rrp < threshold, default $0) for a region, ranked by intensity; or NEM-wide violated constraints. ' +
      'Use this to find moments worth explaining, then call explain_interval on peak_interval_end_nem.',
    inputSchema: {
      kind: z.enum(['spike', 'negative', 'violation']),
      region: z.enum(REGIONS).optional().describe('Required for spike/negative'),
      ...range,
      threshold: z.number().optional().describe('$/MWh; default 1000 for spike, 0 for negative'),
      min_intervals: z.number().int().min(1).default(1).describe('Minimum run length in 5-minute intervals'),
      n: z.number().int().min(1).max(100).default(10),
    },
  },
  async ({ kind, region, from, to, threshold, min_intervals, n }) => {
    const win = { from: toUtcSql(from), to: toUtcSql(to) };
    if (kind === 'violation') {
      const rows = await query(violationsSql(n), win);
      return respond({ kind, from, to, rows, caveats: [
        'Constraints are NEM-wide; region is ignored for violations.',
        ...(rows.length ? [] : ['No violated constraints in this window (or no constraint data; call get_coverage).']),
      ] }, to);
    }
    if (!region) throw new Error('region is required for spike/negative events');
    const t = threshold ?? (kind === 'spike' ? 1000 : 0);
    const rows = await query(priceRunsSql(kind, n), { ...win, region, threshold: t, min_intervals });
    return respond({
      kind, region, from, to, threshold: t, min_intervals, units: { prices: '$/MWh' }, rows,
      caveats: [
        `A run is consecutive 5-minute intervals with rrp ${kind === 'spike' ? '>=' : '<'} ${t}; a missing interval splits a run.`,
        kind === 'spike' ? 'Ranked by sum of price over the run (intensity × duration).' : 'Ranked by duration, then depth.',
        ...(rows.length ? [] : ['No events found (or no data; call get_coverage).']),
      ],
    }, to);
  },
);

server.registerTool(
  'explain_interval',
  {
    title: 'Explain a NEM interval',
    description:
      'Evidence pack for one region at one 5-minute interval: every region\'s price and demand, the price over the ' +
      'previous hour, links into the region (flow vs limits, limiting constraint), binding network constraints, and ' +
      'deterministic findings computed from that evidence. Narrate the findings; do not add causes they do not support.',
    inputSchema: {
      region: z.enum(REGIONS),
      interval: z.string().describe('Interval END time (period-ending), ISO 8601 with offset, e.g. 2026-01-26T19:30:00+10:00'),
    },
  },
  async ({ region, interval }) => {
    const pack = await explainInterval(region, interval);
    if (!pack.found) {
      return respond({ region, interval, caveats: ['No price/demand data for this interval. Call get_coverage.'] }, interval);
    }
    return respond({
      ...pack,
      caveats: [
        'findings are computed by the server from the evidence fields named in each finding; treat them as the factual basis.',
        'Constraint descriptions use the latest GENCONDATA version.',
        'Unit-level and FCAS constraints are excluded here; use get_constraints with include_unit_limits for those.',
      ],
    }, interval);
  },
);

server.registerTool(
  'get_generation',
  {
    title: 'NEM generation by fuel or unit',
    description:
      'Actual unit output (SCADA) in a region, by fuel group (time series) or by unit (top N by energy). ' +
      'Batteries: positive = discharging, negative = charging. Use to see which fleets ramped up or ran out.',
    inputSchema: {
      region: z.enum(REGIONS),
      ...windowArgs,
      by: z.enum(['fuel', 'unit']).default('fuel'),
      resolution: z.enum(['5min', '30min', '1h']).default('5min'),
      n: z.number().int().min(1).max(100).default(15),
    },
  },
  async (args) => {
    const w = resolveWindow(args);
    const caveats: string[] = [];
    if (!(await exists(join(DATA, 'dispatch_unit_scada')))) {
      return respond({ rows: [], caveats: ['Unit SCADA not loaded: backfill DISPATCH_UNIT_SCADA, and ingest the scada feed.'] });
    }
    if (!(await exists(join(DATA, 'dudetailsummary')))) {
      return respond({ rows: [], caveats: ['Unit reference data not loaded: backfill DUDETAILSUMMARY.'] });
    }
    const withFuel = await exists(join(DATA, 'unit_fuel'));
    const params = { region: args.region, from: toUtcSql(w.from), to: toUtcSql(w.to) };
    const rows = args.by === 'fuel'
      ? await query(genByFuelSql(args.resolution, withFuel), params)
      : await query(genByUnitSql(args.n, withFuel), params);
    caveats.push(
      'SCADA is measured at the start of each dispatch interval, so it lags the period-ending timestamp by up to 5 minutes.',
      'Covers scheduled/semi-scheduled units with SCADA; excludes rooftop PV and most small non-scheduled generation.',
      'LOAD-type DUIDs are negated so charging/consumption appears negative.',
      withFuel ? 'fuel_group comes from the AEMO Registration and Exemption List; "unknown" = unmapped DUID.'
               : 'Fuel types not loaded (run `pnpm fuel`); only batteries (BIDIRECTIONAL) are identified.',
    );
    if (rows.length === 0) caveats.unshift('No generation data in this window. Call get_coverage or backfill DISPATCH_UNIT_SCADA.');
    return respond({
      units: { '*_mw': 'MW', energy_mwh: 'MWh' },
      region: args.region, by: args.by, ...w,
      rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS, caveats,
    }, w.to);
  },
);

await server.connect(new StdioServerTransport());
console.error('nem-mcp running on stdio');

// Optional: run DispatchIS ingestion inside the server so data never goes stale while Claude is open.
// Set NEM_INGEST=1 in the MCP config, and do NOT also run `pnpm ingest --watch` (concurrent writers).
if (process.env.NEM_INGEST === '1') {
  const conn = await (await instance()).connect();
  const limit = Number(process.env.NEM_INGEST_LIMIT ?? 288); // CURRENT keeps ~2 days; markers skip seen files
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const feed of ['dispatchis', 'scada'] as const) {
        const n = await ingestFeed(conn, feed, limit);
        if (n) console.error(`ingest ${feed}: ${n} new file(s)`);
      }
    } catch (err) {
      console.error('ingest error:', err);
    } finally {
      busy = false;
    }
  };
  void tick();
  setInterval(tick, 60_000);
  console.error(`in-process ingest enabled (limit ${limit}, every 60 s)`);
}
