import { join } from 'node:path';
import { exists } from '../ingest/write.js';
import { query } from './db.js';
import { constraintsSql, DATA, interconnectorTermsSql, unitTermsSql } from './queries.js';

export type Scope = 'fcas' | 'interconnector' | 'unit' | 'network';

export interface LoadOpts {
  fromSql: string;
  toSql: string;
  bindingOnly: boolean;
  n: number;
  includeUnitLimits: boolean;
  scopes?: Scope[];
}

/** Binding constraints in a window, with description, LHS terms (top 8) and a scope classification. */
export async function loadConstraints(o: LoadOpts) {
  const has = (t: string) => exists(join(DATA, t));
  const withDesc = await has('gencondata');
  const filtered = !o.includeUnitLimits || o.scopes;
  const rows = await query(constraintsSql(withDesc, o.bindingOnly, filtered ? o.n * 4 : o.n), {
    from: o.fromSql, to: o.toSql,
  });

  const ids = rows.map((r) => String(r.constraint_id));
  const termRows: Record<string, unknown>[] = [];
  if (ids.length && (await has('spdinterconnectorconstraint'))) termRows.push(...(await query(interconnectorTermsSql(ids))));
  if (ids.length && (await has('spdconnectionpointconstraint'))) {
    termRows.push(...(await query(unitTermsSql(ids, await has('dudetailsummary')))));
  }
  const byId = new Map<string, Record<string, unknown>[]>();
  for (const t of termRows) {
    const k = String(t.constraint_id);
    if (!byId.has(k)) byId.set(k, []);
    byId.get(k)!.push(t);
  }

  const out = rows
    .map((r) => {
      const id = String(r.constraint_id);
      const terms = (byId.get(id) ?? []).sort((a, b) => Math.abs(Number(b.factor)) - Math.abs(Number(a.factor)));
      const scope: Scope =
        r.limit_type === 'FCAS' || id.startsWith('F_') ? 'fcas'
        : terms.some((t) => t.kind === 'interconnector') ? 'interconnector'
        : id.startsWith('#') || id.startsWith('$') || /_ZERO$/.test(id) || (terms.length === 1 && terms[0].kind === 'unit') ? 'unit'
        : 'network';
      return {
        ...r,
        scope,
        mv_above_price_cap: Number(r.max_abs_marginal_value) > 20_300,
        terms_total: terms.length,
        terms: terms.slice(0, 8).map(({ constraint_id: _, ...t }) => t),
      };
    })
    .filter((r) => (o.includeUnitLimits || r.scope !== 'unit') && (!o.scopes || o.scopes.includes(r.scope)))
    .slice(0, o.n);

  return { rows: out, withDesc, termsLoaded: termRows.length > 0 };
}
