import { DuckDBInstance } from '@duckdb/node-api';
import { DATA_DIR } from './ingest.js';
import { backfillMonth, TABLE_DIRS } from './mmsdm.js';

const arg = (k: string, d?: string) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;

const [fy, fm] = arg('from', '2025-11')!.split('-').map(Number);
const [ty, tm] = arg('to', '2026-10')!.split('-').map(Number);
const tables = arg('tables', 'DISPATCHPRICE,DISPATCHREGIONSUM')!.split(',');

for (const t of tables) if (!(t in TABLE_DIRS)) throw new Error(`Unknown table ${t}`);

const conn = await (await DuckDBInstance.create(':memory:')).connect();
await conn.run(`SET memory_limit = '2GB'`);

for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, (m = 1)) : m++) {
  for (const t of tables) {
    try {
      await backfillMonth(conn, DATA_DIR, t, y, m);
    } catch (err) {
      console.error(`FAILED ${t} ${y}-${m}:`, err);
    }
  }
}
console.error('backfill done');
