import { mkdir, rename, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import ExcelJS from 'exceljs';
import { DATA_DIR } from './ingest.js';

const DEFAULT_URL =
  'https://www.aemo.com.au/-/media/files/electricity/nem/participant_information/nem-registration-and-exemption-list.xlsx';
const src = process.argv[2] ?? DEFAULT_URL;
const sqlLit = (s: string) => `'${s.replace(/'/g, "''")}'`;

const text = (v: unknown): string => {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('text' in o) return String(o.text);
    if ('result' in o) return String(o.result);
    if ('richText' in o) return (o.richText as { text: string }[]).map((t) => t.text).join('');
  }
  return v === null || v === undefined ? '' : String(v);
};

export function fuelGroup(s: string): string {
  const t = s.toLowerCase();
  if (/battery/.test(t)) return 'battery';
  if (/hydro|water/.test(t)) return 'hydro';
  if (/solar/.test(t)) return 'solar';
  if (/wind/.test(t)) return 'wind';
  if (/brown coal/.test(t)) return 'brown_coal';
  if (/coal/.test(t)) return 'black_coal';
  if (/gas|methane/.test(t)) return 'gas';
  if (/diesel|distillate|liquid|oil/.test(t)) return 'liquid';
  if (/bio|bagasse|landfill|waste/.test(t)) return 'bioenergy';
  return 'other';
}

let buf: Buffer;
if (/^https?:/i.test(src)) {
  const res = await fetch(src, { headers: { 'User-Agent': 'nem-mcp (public-utility prototype)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${src}. Download it in a browser and run: pnpm fuel /path/to/file.xlsx`);
  buf = Buffer.from(await res.arrayBuffer());
} else {
  buf = await readFile(src);
}

const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buf);

const byDuid = new Map<string, Record<string, string | number | null>>();
for (const ws of wb.worksheets) {
  // Find a header row containing "DUID" within the first 10 rows.
  let headerRow = 0;
  const cols: Record<string, number> = {};
  for (let r = 1; r <= 10 && !headerRow; r++) {
    const vals = (ws.getRow(r).values as unknown[]).map((v) => text(v).trim().toLowerCase());
    if (vals.includes('duid')) {
      headerRow = r;
      vals.forEach((v, i) => { if (v) cols[v] = i; });
    }
  }
  if (!headerRow) continue;
  const col = (...needles: string[]) => {
    for (const n of needles) {
      const k = Object.keys(cols).find((c) => c.includes(n));
      if (k) return cols[k];
    }
    return -1;
  };
  const c = {
    duid: cols['duid'], station: col('station name'), region: col('region'),
    fuel: col('fuel source - primary'), fuelDesc: col('fuel source - descriptor'),
    tech: col('technology type - primary'), techDesc: col('technology type - descriptor'),
    cap: col('reg cap', 'max cap'),
  };
  ws.eachRow((row, i) => {
    if (i <= headerRow) return;
    const v = row.values as unknown[];
    const get = (idx: number) => (idx > 0 ? text(v[idx]).trim() : '');
    const duid = get(c.duid);
    if (!duid || duid === '-') return;
    const desc = [get(c.fuel), get(c.fuelDesc), get(c.tech), get(c.techDesc)].join(' ');
    const rec = {
      DUID: duid, STATION_NAME: get(c.station), REGION: get(c.region),
      FUEL_PRIMARY: get(c.fuel), FUEL_DESCRIPTOR: get(c.fuelDesc),
      TECH_PRIMARY: get(c.tech), TECH_DESCRIPTOR: get(c.techDesc),
      REG_CAP_MW: Number(get(c.cap)) || null, FUEL_GROUP: fuelGroup(desc), SHEET: ws.name, SOURCE: src,
    };
    // Keep the first row that has fuel information.
    const prev = byDuid.get(duid);
    if (!prev || (!prev.FUEL_PRIMARY && rec.FUEL_PRIMARY)) byDuid.set(duid, rec);
  });
}
if (byDuid.size === 0) throw new Error('No sheet with a DUID column found; the workbook layout may have changed.');

const outDir = join(DATA_DIR, 'unit_fuel');
await mkdir(outDir, { recursive: true });
const jsonl = join(tmpdir(), `unit_fuel_${Date.now()}.jsonl`);
await writeFile(jsonl, [...byDuid.values()].map((r) => JSON.stringify(r)).join('\n'));
const out = join(outDir, 'unit_fuel.parquet');
const conn = await (await DuckDBInstance.create(':memory:')).connect();
await conn.run(`COPY (SELECT * FROM read_json_auto(${sqlLit(jsonl)})) TO ${sqlLit(out + '.tmp')} (FORMAT parquet)`);
await rename(out + '.tmp', out);
await rm(jsonl);

const counts: Record<string, number> = {};
for (const r of byDuid.values()) counts[String(r.FUEL_GROUP)] = (counts[String(r.FUEL_GROUP)] ?? 0) + 1;
console.error(`wrote ${out}: ${byDuid.size} DUIDs`, counts);
