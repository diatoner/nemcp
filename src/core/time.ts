/** Parse an ISO 8601 time (with offset) into a naive UTC timestamp string for DuckDB. */
export function toUtcSql(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid time: ${iso}. Use ISO 8601 with an offset, e.g. 2026-11-07T00:00:00+10:00`);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export const TIME_CONVENTION =
  'All intervals are period-ending. *_utc fields are UTC; *_nem fields are NEM time ' +
  '(fixed UTC+10, no daylight saving; differs from Melbourne/Sydney local time in summer).';
