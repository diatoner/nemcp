import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = process.env.NEM_EVAL_DATA_DIR;
if (DIR) process.env.NEM_DATA_DIR = DIR;

const { explainInterval } = await import('../src/core/explain.js');
const { EVENTS } = await import('../evals/events.js');

const suite = DIR && existsSync(DIR) ? describe : describe.skip;

suite('evals against real data', () => {
  for (const e of EVENTS) {
    const missing = DIR ? (e.needs ?? []).filter((t) => !existsSync(join(DIR, t))) : [];
    const run = missing.length ? it.skip : it;
    run(e.name, async () => {
      const pack = await explainInterval(e.region, e.interval);
      expect(pack.found).toBe(true);
      const text = pack.found ? pack.findings.map((f) => f.fact).join('\n') : '';
      for (const p of e.expect) expect(text, `missing ${p}`).toMatch(p);
    }, 120_000);
  }
});
