import { DuckDBInstance } from '@duckdb/node-api';
import { ingestDispatchIs } from './ingest.js';

const watch = process.argv.includes('--watch');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : 12;

const instance = await DuckDBInstance.create(':memory:');
const conn = await instance.connect();

do {
  try {
    const n = await ingestDispatchIs(conn, limit);
    console.error(`${new Date().toISOString()} ingest pass done, ${n} new file(s)`);
  } catch (err) {
    console.error('ingest error:', err);
  }
  if (watch) await new Promise((r) => setTimeout(r, 60_000));
} while (watch);
