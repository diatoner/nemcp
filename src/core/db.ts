import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

let instP: Promise<DuckDBInstance> | undefined;
let conn: DuckDBConnection | undefined;

/** One DuckDB instance per process; settings are instance-wide. */
export function instance(): Promise<DuckDBInstance> {
  return (instP ??= (async () => {
    const inst = await DuckDBInstance.create(':memory:');
    const c = await inst.connect();
    await c.run(`SET memory_limit = '1GB'`);
    await c.run(`SET threads = 2`);
    return inst;
  })());
}

/** Connection used for read queries. Ingest should open its own via instance().connect(). */
export async function db(): Promise<DuckDBConnection> {
  if (!conn) conn = await (await instance()).connect();
  return conn;
}

/** Run SQL with named $params; returns JSON-safe row objects. */
export async function query(sql: string, params: Record<string, string | number> = {}) {
  const reader = await (await db()).runAndReadAll(sql, params);
  return reader.getRowObjectsJson();
}
