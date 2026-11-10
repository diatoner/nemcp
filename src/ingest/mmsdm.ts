import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { DuckDBConnection } from '@duckdb/node-api';
import { splitCsvLine } from '../aemo-csv/parse.js';
import { listZips, NEMWEB_BASE } from './nemweb.js';
import { exists } from './write.js';

const sqlLit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** MMS table name → our data folder. */
export const TABLE_DIRS: Record<string, string> = {
  DISPATCHPRICE: 'dispatch_price',
  DISPATCHREGIONSUM: 'dispatch_regionsum',
  DISPATCHINTERCONNECTORRES: 'dispatch_interconnectorres',
  DISPATCHCONSTRAINT: 'dispatch_constraint',
  DISPATCH_UNIT_SCADA: 'dispatch_unit_scada',
  DUDETAILSUMMARY: 'dudetailsummary',
  STATION: 'station',
  GENCONDATA: 'gencondata',
  SPDCONNECTIONPOINTCONSTRAINT: 'spdconnectionpointconstraint',
  SPDINTERCONNECTORCONSTRAINT: 'spdinterconnectorconstraint',
  SPDREGIONCONSTRAINT: 'spdregionconstraint',
};

export function mmsdmDataDir(year: number, month: number) {
  const mm = String(month).padStart(2, '0');
  return `/Data_Archive/Wholesale_Electricity/MMSDM/${year}/MMSDM_${year}_${mm}/MMSDM_Historical_Data_SQLLoader/DATA/`;
}

/** Matches both naming schemes: PUBLIC_ARCHIVE#T#FILEnn#… (Aug 2024+) and PUBLIC_DVD_T_… (older). */
function tablePattern(table: string) {
  return new RegExp(
    `(PUBLIC_ARCHIVE(%23|#)${table}(%23|#)FILE\\d+(%23|#)|PUBLIC_DVD_${table}_)\\d{12}\\.zip$`,
    'i',
  );
}

async function readLine(path: string, lineNo: number): Promise<string> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    if (++n === lineNo) { rl.close(); return line; }
  }
  throw new Error(`${path} has fewer than ${lineNo} lines`);
}

/** Stream a (possibly large) archive zip to disk, hash it, and extract its CSV with `unzip -p`. */
async function downloadCsv(url: string) {
  const res = await fetch(url, { headers: { 'User-Agent': 'nem-mcp (public-utility prototype)' } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} fetching ${url}`);

  const base = join(tmpdir(), `nem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const zipPath = `${base}.zip`;
  const csvPath = `${base}.csv`;

  const hash = createHash('sha256');
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
  body.on('data', (chunk: Buffer) => hash.update(chunk));
  await pipeline(body, createWriteStream(zipPath));
  const sha256 = hash.digest('hex');

  try {
    const p = spawn('unzip', ['-p', zipPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise<void>((resolve, reject) => {
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`unzip exited ${code} for ${url}`))));
    });
    await Promise.all([pipeline(p.stdout, createWriteStream(csvPath)), exited]);
  } finally {
    await rm(zipPath, { force: true });
  }
  return { csvPath, sha256 };
}

/** Load one monthly MMSDM table into data/<table>/archive/YYYY-MM_FILEnn.parquet. */
export async function backfillMonth(conn: DuckDBConnection, dataDir: string, table: string, year: number, month: number) {
  const dir = mmsdmDataDir(year, month);
  let urls: string[];
  try {
    urls = await listZips(dir, tablePattern(table));
  } catch (err) {
    console.error(`skip ${table} ${year}-${month}: ${(err as Error).message} (not published yet?)`);
    return 0;
  }
  if (urls.length === 0) {
    console.error(`skip ${table} ${year}-${month}: no matching files in ${dir}`);
    return 0;
  }

  const outDir = join(dataDir, TABLE_DIRS[table] ?? table.toLowerCase(), 'archive');
  await mkdir(outDir, { recursive: true });
  let written = 0;

  for (const [i, url] of urls.entries()) {
    const ym = `${year}-${String(month).padStart(2, '0')}`;
    const out = join(outDir, `${ym}_FILE${String(i + 1).padStart(2, '0')}.parquet`);
    if (await exists(out)) continue;

    const { csvPath, sha256 } = await downloadCsv(url);
    const cleanPath = `${csvPath}.clean.csv`;
    try {
      const { columns, rows } = await cleanAemoCsv(csvPath, cleanPath);

      const derived = columns.includes('SETTLEMENTDATE')
        ? `, try_strptime(SETTLEMENTDATE, '%Y/%m/%d %H:%M:%S') - INTERVAL 10 HOUR AS INTERVAL_END_UTC`
        : '';
      const tmpOut = `${out}.tmp`;
      await conn.run(`
        COPY (
          SELECT *,
                 ${sqlLit(url)}                     AS SOURCE_URL,
                 ${sqlLit(sha256)}                  AS SOURCE_SHA256
                 ${derived}
          FROM read_csv(${sqlLit(cleanPath)},
                        header = true, all_varchar = true,
                        delim = ',', quote = '"', escape = '"')
        ) TO ${sqlLit(tmpOut)} (FORMAT parquet, COMPRESSION zstd)
      `);
      await rename(tmpOut, out);
      written++;
      console.error(`wrote ${out} (${rows} rows)`);
    } finally {
      await rm(csvPath, { force: true });
      await rm(cleanPath, { force: true });
    }
  }
  return written;
}

const csvField = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Stream an AEMO single-table CSV into a clean CSV: header from the I row,
 * only D rows, prefix columns dropped, SOURCE_ROW = exact source line number.
 */
export async function cleanAemoCsv(rawPath: string, cleanPath: string) {
  const rl = createInterface({ input: createReadStream(rawPath), crlfDelay: Infinity });
  const out = createWriteStream(cleanPath);
  const write = (s: string) =>
    out.write(s) ? Promise.resolve() : new Promise<void>((r) => out.once('drain', () => r()));

  let columns: string[] | undefined;
  let lineNo = 0;
  let rows = 0;

  for await (const line of rl) {
    lineNo++;
    if (!line) continue;
    const f = splitCsvLine(line);
    if (f[0] === 'I') {
      if (columns) throw new Error(`Second I row at line ${lineNo} of ${rawPath}; needs the multi-table parser`);
      columns = f.slice(4).map((c) => c.trim().toUpperCase());
      await write([...columns, 'SOURCE_ROW'].map(csvField).join(',') + '\n');
    } else if (f[0] === 'D') {
      if (!columns) throw new Error(`D row before I row at line ${lineNo} of ${rawPath}`);
      const values = f.slice(4);
      if (values.length !== columns.length) {
        throw new Error(`Line ${lineNo}: ${values.length} values vs ${columns.length} columns`);
      }
      await write([...values, String(lineNo)].map(csvField).join(',') + '\n');
      rows++;
    }
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  if (!columns) throw new Error(`No I row in ${rawPath}`);
  return { columns, rows };
}

export { NEMWEB_BASE };
