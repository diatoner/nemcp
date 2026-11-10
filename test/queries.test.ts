import { mkdirSync, rmSync } from 'node:fs';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

const DIR = 'test/.data';
process.env.NEM_DATA_DIR = DIR;

const { query, db } = await import('../src/core/db.js');
const { distributionSql, pricesSql, regionSummarySql } = await import('../src/core/queries.js');

beforeAll(async () => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(`${DIR}/dispatch_price`, { recursive: true });
  mkdirSync(`${DIR}/dispatch_regionsum`, { recursive: true });
  const c = await db();
  // 12 SA1 intervals; demand negative in the last 3; one price spike.
  await c.run(`
    COPY (
      SELECT TIMESTAMP '2026-11-07 00:00:00' + i * INTERVAL 5 MINUTE AS INTERVAL_END_UTC,
             'SA1' AS REGIONID, '0' AS INTERVENTION, '2026/11/07 00:00:00' AS LASTCHANGED,
             CASE WHEN i = 5 THEN '300' ELSE '-10' END AS RRP, 'test://p' || i AS SOURCE_URL
      FROM range(1, 13) t(i)
    ) TO '${DIR}/dispatch_price/a.parquet' (FORMAT parquet)`);
  await c.run(`
    COPY (
      SELECT TIMESTAMP '2026-11-07 00:00:00' + i * INTERVAL 5 MINUTE AS INTERVAL_END_UTC,
             'SA1' AS REGIONID, '0' AS INTERVENTION, '2026/11/07 00:00:00' AS LASTCHANGED,
             CASE WHEN i > 9 THEN '-200' ELSE '1000' END AS TOTALDEMAND,
             '3000.123456' AS AVAILABLEGENERATION, '400' AS NETINTERCHANGE
      FROM range(1, 13) t(i)
    ) TO '${DIR}/dispatch_regionsum/a.parquet' (FORMAT parquet)`);
});

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const range = { region: 'SA1', from: '2026-11-07 00:00:00', to: '2026-11-07 02:00:00' };

describe('queries', () => {
  it('returns counts as numbers (fix 1)', async () => {
    const [row] = await query(pricesSql('1h'), range);
    expect(typeof row.n_intervals).toBe('number');
    expect(typeof row.source_files).toBe('number');
  });

  it('floors negative demand and withholds tail shares on small samples (fixes 2, 3)', async () => {
    const [s] = await query(distributionSql, range);
    expect(s.n_intervals).toBe(12);
    expect(s.n_negative_demand).toBe(3);
    expect(s.share_value_top_1pct_intervals).toBeNull();
    // value: one interval at 300 × 1000/12 = 25000; eight at -10 × 1000/12; three at 0
    expect(s.total_energy_value_dollars).toBe(Math.round(25000 + 8 * (-10 * 1000 / 12)));
  });

  it('rounds available generation (fix 4)', async () => {
    const [row] = await query(regionSummarySql, { region: 'SA1', limit: 1 });
    expect(row.available_generation_mw).toBe(3000.1);
  });
});
