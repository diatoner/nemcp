export interface AemoRow {
  line: number;      // 1-based line in the source CSV (provenance)
  values: string[];
}

export interface AemoTable {
  key: string;       // e.g. "DISPATCH_PRICE"
  version: string;   // e.g. "5"
  columns: string[]; // upper-cased column names
  rows: AemoRow[];
}

/** Split one CSV line, honouring double quotes and "" escapes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Parse an AEMO multi-record CSV into tables keyed by REPORTTYPE_SUBTYPE. */
export function parseAemoCsv(text: string): Map<string, AemoTable> {
  const tables = new Map<string, AemoTable>();
  const lines = text.split(/\r?\n/);

  lines.forEach((raw, idx) => {
    if (!raw) return;
    const f = splitCsvLine(raw);
    const kind = f[0];
    if (kind !== 'I' && kind !== 'D') return; // C rows: comments/headers/footers

    const key = `${f[1]}_${f[2]}`.toUpperCase();

    if (kind === 'I') {
      const columns = f.slice(4).map((c) => c.trim().toUpperCase());
      const existing = tables.get(key);
      if (existing && existing.columns.join() !== columns.join()) {
        throw new Error(`Schema changed mid-file for ${key} at line ${idx + 1}`);
      }
      if (!existing) tables.set(key, { key, version: f[3], columns, rows: [] });
      return;
    }

    const table = tables.get(key);
    if (!table) throw new Error(`D row before I row for ${key} at line ${idx + 1}`);
    const values = f.slice(4);
    if (values.length !== table.columns.length) {
      throw new Error(
        `Column count mismatch for ${key} at line ${idx + 1}: ` +
        `${values.length} values vs ${table.columns.length} columns`,
      );
    }
    table.rows.push({ line: idx + 1, values });
  });

  return tables;
}
