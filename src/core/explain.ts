import { loadConstraints } from './constraints.js';
import { query } from './db.js';
import { describeInterconnector } from './interconnectors.js';
import { interconnectorsSql, pricesSql, regionsAtSql } from './queries.js';
import { toUtcSql } from './time.js';
import { join } from 'node:path';
import { exists } from '../ingest/write.js';
import { DATA, genByFuelSql } from './queries.js';

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const fmt$ = (v: number) => `$${v.toLocaleString('en-AU', { maximumFractionDigits: 0 })}/MWh`;

interface Finding { fact: string; evidence: string[] }

/** Evidence pack + deterministic findings for one region at one interval. */
export async function explainInterval(region: string, interval: string) {
  const end = Date.parse(interval);
  if (Number.isNaN(end)) throw new Error(`Invalid interval: ${interval}`);
  const iso = (ms: number) => new Date(ms).toISOString();
  const at = toUtcSql(iso(end));
  const prev5 = toUtcSql(iso(end - 300_000));

  // Sequential: one DuckDB connection.
  const regions = await query(regionsAtSql, { at });
  const trajectory = await query(pricesSql('5min'), { region, from: toUtcSql(iso(end - 3_600_000)), to: at });
  const ics = await query(interconnectorsSql(true), { from: prev5, to: at });
  const cons = await loadConstraints({
    fromSql: prev5, toSql: at, bindingOnly: true, n: 8, includeUnitLimits: false, scopes: ['interconnector', 'network'],
  });

  const self = regions.find((r) => r.region === region);
  if (!self) return { found: false as const, region, interval };

  const rrp = Number(self.rrp);
  const priceOf = (reg: string | null) => (reg ? num(regions.find((r) => r.region === reg)?.rrp) : null);

  // Express every link touching the region as "flow INTO region" with its max/min into region.
  const links = ics
    .map((r) => ({ ...describeInterconnector(String(r.interconnector_id)), ...r }))
    .filter((l) => l.from_region === region || l.to_region === region)
    .map((l) => {
      const inbound = l.to_region === region;
      const flowIn = (inbound ? 1 : -1) * Number(l.flow_mw);
      const maxIn = inbound ? Number(l.export_limit_mw) : -Number(l.import_limit_mw);
      const minIn = inbound ? Number(l.import_limit_mw) : -Number(l.export_limit_mw);
      const neighbour = inbound ? l.from_region : l.to_region;
      return {
        interconnector_id: String(l.interconnector_id),
        name: l.name,
        neighbour,
        neighbour_rrp: priceOf(neighbour),
        flow_into_region_mw: Math.round(flowIn * 10) / 10,
        max_into_region_mw: maxIn,
        min_into_region_mw: minIn,
        import_capped: Math.abs(flowIn - maxIn) <= 1,
        limiting_constraint: String(inbound ? l.export_limit_constraint : l.import_limit_constraint ?? '') || null,
      };
    });

  const findings: Finding[] = [];
  const consById = new Map(cons.rows.map((c) => [String(c.constraint_id), c as Row]));

  // 1. Price and trajectory
  const first = trajectory[0];
  if (first) {
    findings.push({
      fact: `${region} price was ${fmt$(rrp)}, from ${fmt$(Number(first.mean_rrp))} an hour earlier (${first.bucket_end_nem} NEM).`,
      evidence: ['regions', 'trajectory'],
    });
  }

    // 2. Separation from neighbours (dedupe: several links can share a neighbour)
  const nbr = new Map<string, number>();
  for (const l of links) if (l.neighbour && l.neighbour_rrp !== null) nbr.set(l.neighbour, Number(l.neighbour_rrp));
  const maxN = nbr.size ? Math.max(...nbr.values()) : null;
  if (maxN !== null) {
    const gap = rrp - maxN;
    if (Math.abs(gap) > 100 && Math.abs(gap) > 0.2 * Math.abs(maxN)) {
      findings.push({
        fact: `${region} was ${gap > 0 ? 'above' : 'below'} every connected neighbour by at least ${fmt$(Math.abs(gap))} ` +
          `(${[...nbr].map(([r, p]) => `${r} ${fmt$(p)}`).join(', ')}). Prices this far apart mean the regions were not acting as one market.`,
        evidence: ['regions', 'links'],
      });
    }
  }

  // 3. Each link, described by what actually happened
  const netIn = links.reduce((s, l) => s + l.flow_into_region_mw, 0);
  findings.push({
    fact: `Net flow into ${region}: ${Math.round(netIn)} MW${netIn < -1 ? ` (${region} was exporting)` : ''}.`,
    evidence: ['links', 'regions'],
  });
  for (const l of links) {
    const label = l.name ?? l.interconnector_id;
    const c = l.limiting_constraint ? consById.get(l.limiting_constraint) : undefined;
    const mv = c ? Number(c.max_abs_marginal_value) : null;
    const by = l.limiting_constraint
      ? ` by ${l.limiting_constraint}` +
        (c ? ` (marginal value ${fmt$(mv!)}${mv! > 20_300 ? ', above the price cap, so penalty-weighted' : ''}` +
             `${c.description ? `: "${c.description}"` : ''})` : '')
      : '';
    const ev = ['links', 'binding_constraints'];

    if (l.min_into_region_mw > l.max_into_region_mw + 1) {
      findings.push({
        fact: `${label}: limits were inconsistent (at least ${l.min_into_region_mw} MW and at most ${l.max_into_region_mw} MW into ${region}, ` +
          `a gap of ${Math.round((l.min_into_region_mw - l.max_into_region_mw) * 10) / 10} MW), so dispatch could not satisfy every constraint.`,
        evidence: ['links'],
      });
    }
    if (l.import_capped && l.max_into_region_mw < -1) {
      const counter = l.neighbour_rrp !== null && rrp > l.neighbour_rrp;
      findings.push({
        fact: `${label} was forced to export ${Math.abs(l.flow_into_region_mw)} MW out of ${region}${by}.` +
          (counter ? ` This is a counter-price flow: power left ${region} for lower-priced ${l.neighbour} (${fmt$(l.neighbour_rrp!)}).` : ''),
        evidence: ev,
      });
    } else if (l.import_capped && Math.abs(l.max_into_region_mw) <= 1) {
      findings.push({ fact: `${label} could not import into ${region} (limit 0 MW)${by}.`, evidence: ev });
    } else if (l.import_capped) {
      findings.push({ fact: `${label} was at its import limit, ${l.flow_into_region_mw} MW into ${region}, set${by}.`, evidence: ev });
    } else {
      findings.push({
        fact: `${label} had spare import capacity: ${l.flow_into_region_mw} MW of up to ${l.max_into_region_mw} MW into ${region}.`,
        evidence: ['links'],
      });
    }
  }

  // 4. Violations, with meaning
  const violated = cons.rows.filter((c) => Number(c.intervals_violated) > 0);
  if (violated.length) {
    for (const c of violated) {
      findings.push({
        fact: `${c.constraint_id} was violated by ${c.max_violation_mw} MW${c.description ? ` ("${c.description}")` : ''}; the price may include penalty effects.` +
          (c.limit_type === 'Negative Residue'
            ? ' Negative residue management limits flows from high- to low-price regions; violation means dispatch could not fully stop such a flow.'
            : ''),
        evidence: ['binding_constraints'],
      });
    }
  } else {
    findings.push({
      fact: 'No interconnector or network constraints were violated, so the price reflects binding limits and offers, not penalty pricing.',
      evidence: ['binding_constraints'],
    });
  }

  // 6. Supply headroom
  const avail = num(self.available_generation_mw);
  const dem = num(self.total_demand_mw);
  if (avail !== null && dem !== null) {
    findings.push({
      fact: `Generation offered as available in ${region}: ${Math.round(avail)} MW against ${Math.round(dem)} MW demand ` +
        `(headroom ${Math.round(avail - dem)} MW before imports). Availability is offered at any price, so headroom does not mean cheap supply.`,
      evidence: ['regions'],
    });
  }
  
    // 7. Generation mix: now vs an hour earlier (needs unit SCADA)
  let generation_mix: Row[] | null = null;
  if ((await exists(join(DATA, 'dispatch_unit_scada'))) && (await exists(join(DATA, 'dudetailsummary')))) {
    const withFuel = await exists(join(DATA, 'unit_fuel'));
    const gen = await query(genByFuelSql('5min', withFuel), { region, from: toUtcSql(iso(end - 3_600_000)), to: at });
    const buckets = [...new Set(gen.map((g) => String(g.bucket_end_nem)))].sort();
    if (buckets.length >= 2) {
      const snap = (b: string) => new Map(gen.filter((g) => g.bucket_end_nem === b).map((g) => [String(g.fuel_group), Number(g.mean_mw)]));
      const then = snap(buckets[0]);
      const now = snap(buckets[buckets.length - 1]);
      generation_mix = [...new Set([...then.keys(), ...now.keys()])]
        .map((f) => {
          const a = then.get(f) ?? 0, b = now.get(f) ?? 0;
          return { fuel_group: f, mw_hour_earlier: a, mw_now: b, change_mw: Math.round((b - a) * 10) / 10 };
        })
        .sort((x, y) => Math.abs(y.change_mw) - Math.abs(x.change_mw));

      const bat = generation_mix.find((g) => g.fuel_group === 'battery');
      if (bat) {
        const fell = bat.mw_hour_earlier > 50 && bat.mw_now < 0.25 * bat.mw_hour_earlier;
        findings.push({
          fact: `Batteries in ${region}: ${Math.round(bat.mw_now)} MW now, from ${Math.round(bat.mw_hour_earlier)} MW an hour earlier` +
            (fell ? ' — battery output had largely stopped.' : '.'),
          evidence: ['generation_mix'],
        });
      }
      const movers = generation_mix.filter((g) => g.fuel_group !== 'battery' && Math.abs(g.change_mw) >= 50).slice(0, 3);
      if (movers.length) {
        findings.push({
          fact: `Largest changes in output over the hour: ${movers.map((g) => `${g.fuel_group} ${Math.round(g.mw_hour_earlier)} → ${Math.round(g.mw_now)} MW`).join('; ')}.`,
          evidence: ['generation_mix'],
        });
      }
    }
  }

  return {
    found: true as const,
    region,
    interval_end_nem: `${regions[0] ? '' : ''}${new Date(end + 10 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')} NEM`,
    findings,
    regions,
    trajectory,
    links,
    binding_constraints: cons.rows,
    not_yet_available: [
      ...(generation_mix ? [] : ['Unit output: backfill DISPATCH_UNIT_SCADA (and run `pnpm fuel` for fuel types).']),
      'Price setter and rebids (whose offer set the price, and why it changed): M5 bids.',
    ],
  };
}
