import { DuckDBInstance } from '@duckdb/node-api';

const conn = await (await DuckDBInstance.create(':memory:')).connect();
const r = await conn.runAndReadAll(`
  SELECT strftime(INTERVAL_END_UTC + INTERVAL 10 HOUR, '%Y-%m-%d %H:%M') AS nem_time,
         REGIONID, RRP, INTERVENTION
  FROM read_parquet('data/dispatch_price/*.parquet', union_by_name = true)
  ORDER BY INTERVAL_END_UTC DESC, REGIONID
  LIMIT 10
`);
console.table(r.getRowObjectsJson());
