import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { AemoTable } from '../aemo-csv/parse.js';

const csvField = (s: string) => `"${s.replace(/"/g, '""')}"`;
const sqlLit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export const exists = (p: string) => access(p).then(() => true, () => false);

export interface WriteOpts {
  dataDir: string;
  sourceName: string;
  sourceUrl: string;
  sha256: string;
}

/** Write one AEMO table from one source file to data/<table>/<source>.parquet (atomic). */
export async function writeTableParquet(conn: DuckDBConnection, table: AemoTable, o: WriteOpts) {
  const tableDir = join(o.dataDir, table.key.toLowerCase());
  const base = o.sourceName.replace(/\.zip$/i, '');
  const out = join(tableDir, `${base}.parquet`);
  if (await exists(out)) return { out, skipped: true };
  await mkdir(tableDir, { recursive: true });

  const header = [...table.columns, 'SOURCE_ROW'].map(csvField).join(',');
  const body = table.rows.map((r) => [...r.values, String(r.line)].map(csvField).join(',')).join('\n');
  const csvPath = join(tmpdir(), `${base}.${table.key}.csv`);
  await writeFile(csvPath, `${header}\n${body}\n`);

  // NEM time is fixed UTC+10, period-ending. Derive a UTC instant when SETTLEMENTDATE exists.
  const derived = table.columns.includes('SETTLEMENTDATE')
    ? `, try_strptime(SETTLEMENTDATE, '%Y/%m/%d %H:%M:%S') - INTERVAL 10 HOUR AS INTERVAL_END_UTC`
    : '';

  const tmpOut = `${out}.tmp`;
  await conn.run(`
    COPY (
      SELECT *,
             ${sqlLit(o.sourceUrl)} AS SOURCE_URL,
             ${sqlLit(o.sha256)} AS SOURCE_SHA256
             ${derived}
      FROM read_csv(${sqlLit(csvPath)}, header = true, all_varchar = true)
    ) TO ${sqlLit(tmpOut)} (FORMAT parquet)
  `);
  await rename(tmpOut, out); // atomic: readers never see a partial file
  await rm(csvPath);
  return { out, skipped: false };
}
