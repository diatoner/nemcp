export interface EvalCase {
  name: string;
  region: 'NSW1' | 'QLD1' | 'SA1' | 'TAS1' | 'VIC1';
  interval: string;
  expect: RegExp[];          // every pattern must match some finding
  needs?: string[];          // data folders required; case is skipped if missing
}

export const EVENTS: EvalCase[] = [
  {
    name: 'SA 26 Jan 2026 19:30 — heatwave evening, Heywood held at test limit',
    region: 'SA1',
    interval: '2026-01-26T19:30:00+10:00',
    expect: [
      /SA1 price was \$19,441\/MWh/,
      /above every connected neighbour/,
      /Heywood was at its import limit, 465 MW into SA1, set by VS_600_TEST/,
      /No interconnector or network constraints were violated/,
    ],
  },
  {
    name: 'SA 26 Jan 2026 21:30 — batteries spent, gas carrying, price still near cap',
    region: 'SA1',
    interval: '2026-01-26T21:30:00+10:00',
    expect: [
      /Batteries in SA1: .*largely stopped/,
      /SA1 price was \$1\d,\d{3}\/MWh/,           // still five figures when batteries had stopped
      /Heywood was at its import limit/,
    ],
    needs: ['dispatch_unit_scada'],
    // Fleet data: peak ~573 MW (30-min to 20:00 NEM), ~8 MW by 21:30. Press: "much of the fleet ran out
    // shortly after 20:00" (O'Neil, via Energy-Storage.news) is consistent with individual units emptying,
    // not fleet output; Modo: "output fell almost to zero in the final hour" (spike ended 21:45) matches.
  },
  {
    name: 'SA 22 Jun 2026 07:20 — winter morning, counter-price flow and NRM violation',
    region: 'SA1',
    interval: '2026-06-22T07:20:00+10:00',
    expect: [
      /SA1 price was \$20,300\/MWh/,
      /SA1 was exporting/,
      /Murraylink was forced to export 148 MW out of SA1/,
      /counter-price flow/,
      /NRM_SA1_VIC1 was violated by 43\.04 MW/,
    ],
  },
];
