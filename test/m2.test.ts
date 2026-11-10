import { mkdirSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DIR = 'test/.data-m2';
process.env.NEM_DATA_DIR = DIR;

const { db, query } = await import('../src/core/db.js');
const { extremeDaysSql, lookupUnitSql, pricesSql } = await import('../src/core/queries.js');
const { completenessCaveats, coverage, freshnessCaveats } = await import('../src/core/meta.js');

beforeAll(async () => {
  rmSync(DIR, { recursive: true, force: true });
  for (const t of ['dispatch_price', 'dudetailsummary', 'station']) mkdirSync(`${DIR}/${t}`, { recursive: true });
  const c = await db();
  // i = 1..576 → interval ends 2026-01-26 00:05 … 2026-01-28 00:00 NEM. Spike i 220–250; gap i 400–409.
  await c.run(`
    COPY (
      SELECT TIMESTAMP '2026-01-25 14:00:00' + i * INTERVAL 5 MINUTE AS INTERVAL_END_UTC,
             'SA1' AS REGIONID, '0' AS INTERVENTION, '2026/01/26 00:00:00' AS LASTCHANGED,
             CASE WHEN i BETWEEN 220 AND 250 THEN '15000' WHEN i <= 288 THEN '50' ELSE '40' END AS RRP,
             'test://p' || i AS SOURCE_URL
      FROM range(1, 577) t(i)
      WHERE i NOT BETWEEN 400 AND 409
    ) TO '${DIR}/dispatch_price/a.parquet' (FORMAT parquet)`);
  await c.run(`
    COPY (
      SELECT * FROM (VALUES
        ('TORRB1', 'SA1', 'TORRENSB', 'OLDCO', 'GENERATOR', '2020/01/01 00:00:00', '2024/12/31 00:00:00', '2020/01/01 00:00:00', 'x#1'),
        ('TORRB1', 'SA1', 'TORRENSB', 'NEWCO', 'GENERATOR', '2025/01/01 00:00:00', '2999/12/31 00:00:00', '2025/01/01 00:00:00', 'x#2'),
        ('HPR1',   'SA1', 'HPRG',     'NEOEN', 'BIDIRECTIONAL', '2024/06/01 00:00:00', '2999/12/31 00:00:00', '2024/06/01 00:00:00', 'x#3')
      ) v(DUID, REGIONID, STATIONID, PARTICIPANTID, DISPATCHTYPE, START_DATE, END_DATE, LASTCHANGED, SOURCE_URL)
    ) TO '${DIR}/dudetailsummary/a.parquet' (FORMAT parquet)`);
  await c.run(`
    COPY (
      SELECT * FROM (VALUES ('TORRENSB', 'Torrens Island B', '2025/01/01 00:00:00'))
      v(STATIONID, STATIONNAME, LASTCHANGED)
    ) TO '${DIR}/station/a.parquet' (FORMAT parquet)`);
});

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const win = { region: 'SA1', from: '2026-01-25 14:00:00', to: '2026-01-27 14:00:00' };

describe('M2 tools', () => {
  it('ranks extreme days with completeness', async () => {
    const rows = await query(extremeDaysSql('highest', 5), win);
    expect(rows.map((r) => r.nem_day)).toEqual(['2026-01-26', '2026-01-27']);
    expect(rows[0].n_intervals).toBe(288);
    expect(rows[0].intervals_ge_5000).toBe(31);
    expect(rows[1].n_intervals).toBe(278);
  });

  it('labels bucket start and end', async () => {
    const [d1] = await query(pricesSql('1d'), win);
    expect(d1.bucket_start_nem).toBe('2026-01-26 00:00');
    expect(d1.bucket_end_nem).toBe('2026-01-27 00:00');
  });

  it('reports coverage and gaps', async () => {
    const c = await coverage('dispatch_price');
    expect(c.by_month).toEqual([{ nem_month: '2026-01', intervals: 566, expected: 8928, completeness: 0.0634 }]);
    expect(c.gaps).toHaveLength(1);
    expect(c.gaps[0].missing_intervals).toBe(10);
  });

  it('flags incomplete and empty windows', () => {
    const from = '2026-01-26T00:00:00+10:00';
    const to = '2026-01-28T00:00:00+10:00';
    expect(completenessCaveats(566, from, to)[0]).toMatch(/Only 566 of 576/);
    expect(completenessCaveats(0, from, to)[0]).toMatch(/No data/);
    expect(completenessCaveats(576, from, to)).toEqual([]);
  });

  it('flags stale data only when the request reaches past it', () => {
    const f = { data_as_of_utc: '2026-01-27T14:00:00Z', data_as_of_nem: '2026-01-28 00:00 NEM', data_age_minutes: 90 };
    expect(freshnessCaveats(f)[0]).toMatch(/stale/);
    expect(freshnessCaveats(f, '2026-01-27T00:00:00+10:00')).toEqual([]);
  });

  it('looks up the latest registration for a unit, with station name and encoded URL', async () => {
    const rows = await query(lookupUnitSql(true), { q: '%torrens%', exact: 'torrens' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ duid: 'TORRB1', participant_id: 'NEWCO', station_name: 'Torrens Island B', source_url: 'x%232' });
  });
});
