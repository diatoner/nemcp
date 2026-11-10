import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanAemoCsv } from '../src/ingest/mmsdm.js';

const dir = mkdtempSync(join(tmpdir(), 'nem-clean-'));
let i = 0;
const raw = (lines: string[]) => {
  const p = join(dir, `raw-${i++}.csv`);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
};

describe('cleanAemoCsv', () => {
  it('keeps D rows, drops prefix columns, records source lines', async () => {
    const p = raw([
      'C,NEMP.WORLD,PUBLIC_ARCHIVE#DISPATCHPRICE,AEMO,PUBLIC',
      'I,DISPATCH,PRICE,5,SETTLEMENTDATE,REGIONID,RRP',
      'D,DISPATCH,PRICE,5,"2026/09/01 00:05:00",SA1,"1,234.5"',
      'D,DISPATCH,PRICE,5,"2026/09/01 00:05:00",VIC1,-3',
      'C,"END OF REPORT",4',
    ]);
    const out = `${p}.clean.csv`;
    expect(await cleanAemoCsv(p, out)).toEqual({ columns: ['SETTLEMENTDATE', 'REGIONID', 'RRP'], rows: 2 });
    expect(readFileSync(out, 'utf8').trim().split('\n')).toEqual([
      '"SETTLEMENTDATE","REGIONID","RRP","SOURCE_ROW"',
      '"2026/09/01 00:05:00","SA1","1,234.5","3"',
      '"2026/09/01 00:05:00","VIC1","-3","4"',
    ]);
  });

  it('rejects a second I row', async () => {
    const p = raw(['I,A,B,1,X', 'D,A,B,1,1', 'I,A,C,1,Y']);
    await expect(cleanAemoCsv(p, `${p}.clean.csv`)).rejects.toThrow(/Second I row/);
  });
});
