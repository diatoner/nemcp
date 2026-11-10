import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAemoCsv, splitCsvLine } from '../src/aemo-csv/parse.js';

describe('splitCsvLine', () => {
  it('handles quotes and escaped quotes', () => {
    expect(splitCsvLine('D,"a,b","say ""hi""",3')).toEqual(['D', 'a,b', 'say "hi"', '3']);
  });
});

describe('parseAemoCsv', () => {
  const text = readFileSync('test/fixtures/mini_dispatchis.csv', 'utf8');
  const tables = parseAemoCsv(text);

  it('finds each table', () => {
    expect([...tables.keys()].sort()).toEqual(['DISPATCH_PRICE', 'DISPATCH_REGIONSUM']);
  });

  it('parses rows with provenance line numbers', () => {
    const price = tables.get('DISPATCH_PRICE')!;
    expect(price.columns).toContain('RRP');
    expect(price.rows).toHaveLength(2);
    expect(price.rows[0].line).toBe(3);
    expect(price.rows[1].values[price.columns.indexOf('RRP')]).toBe('-12.5');
  });
});
