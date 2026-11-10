import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import { parseAemoCsv } from '../aemo-csv/parse.js';
import { fetchZipCsv, listZips } from './nemweb.js';
import { exists, writeTableParquet } from './write.js';

export const DATA_DIR = process.env.NEM_DATA_DIR ?? 'data';
export const FEEDS = {
  dispatchis: { dir: '/Reports/Current/DispatchIS_Reports/', re: /PUBLIC_DISPATCHIS_\d{12}_\d+\.zip$/i },
  scada:      { dir: '/Reports/Current/Dispatch_SCADA/',     re: /PUBLIC_DISPATCHSCADA_\d{12}_\d+\.zip$/i },
} as const;
export type Feed = keyof typeof FEEDS;

/** Ingest the latest `limit` files of a feed. Idempotent via data/_ingested markers. */
export async function ingestFeed(conn: DuckDBConnection, feed: Feed, limit = 12) {
  const markerDir = join(DATA_DIR, '_ingested');
  await mkdir(markerDir, { recursive: true });

  const urls = (await listZips(FEEDS[feed].dir, FEEDS[feed].re)).slice(-limit);
  let newFiles = 0;

  for (const url of urls) {
    const name = url.split('/').pop()!;
    const marker = join(markerDir, `${name}.json`);
    if (await exists(marker)) continue;

    const f = await fetchZipCsv(url);
    const tables = parseAemoCsv(f.csv);
    const written: Record<string, number> = {};
    for (const t of tables.values()) {
      await writeTableParquet(conn, t, { dataDir: DATA_DIR, sourceName: f.name, sourceUrl: url, sha256: f.sha256 });
      written[t.key] = t.rows.length;
    }
    await writeFile(marker, JSON.stringify({ url, sha256: f.sha256, ingestedAt: new Date().toISOString(), tables: written }, null, 2));
    console.error(`ingested ${name}: ${Object.entries(written).map(([k, n]) => `${k}=${n}`).join(' ')}`);
    newFiles++;
  }
  return newFiles;
}

/** Back-compat. */
export const ingestDispatchIs = (conn: DuckDBConnection, limit = 12) => ingestFeed(conn, 'dispatchis', limit);
