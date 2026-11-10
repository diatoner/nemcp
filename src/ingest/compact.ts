import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { DATA_DIR } from './ingest.js';
import { exists } from './write.js';

const sqlLit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const LIVE_RE = /^PUBLIC_(?:DISPATCHIS|DISPATCHSCADA)_(\d{4})(\d{2})\d{6}_\d+\.parquet$/i;

// Default: compact every month before the current NEM month.
const currentNemMonth = new Date(Date.now() + 10 * 3600_000).toISOString().slice(0, 7);
const before = process.argv.find((a) => a.startsWith('--before='))?.split('=')[1] ?? currentNemMonth;
const dryRun = process.argv.includes('--dry-run');

const conn = await (await DuckDBInstance.create(':memory:')).connect();
const tables = (await readdir(DATA_DIR, { withFileTypes: true }))
  .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
  .map((d) => d.name);

for (const table of tables) {
  const dir = join(DATA_DIR, table);
  const byMonth = new Map<string, string[]>();
  for (const f of await readdir(dir)) {
    const m = LIVE_RE.exec(f);
    if (!m) continue;
    const month = `${m[1]}-${m[2]}`;
    if (month >= before) continue;
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month)!.push(join(dir, f));
  }

  for (const [month, files] of byMonth) {
    const archiveDir = join(dir, 'archive');
    await mkdir(archiveDir, { recursive: true });
    const out = join(archiveDir, `${month}_LIVE.parquet`);
    const inputs = (await exists(out)) ? [out, ...files] : files;
    console.error(`${table} ${month}: ${files.length} live file(s)${inputs.length > files.length ? ' + existing' : ''} → ${out}`);
    if (dryRun) continue;

    const tmp = `${out}.tmp`;
    await conn.run(`
      COPY (SELECT * FROM read_parquet([${inputs.map(sqlLit).join(', ')}], union_by_name = true))
      TO ${sqlLit(tmp)} (FORMAT parquet, COMPRESSION zstd)`);
    await rename(tmp, out);
    for (const f of files) await rm(f);
  }
}
console.error('compaction done');
