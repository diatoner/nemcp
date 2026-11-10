# nemcp

An MCP server that lets AI assistants query, and explain, Australian National Electricity Market (NEM) data from nemweb.com.au.

## What it can do for you

- **Find market patterns from natural language queries.** Search any region and date range for price spikes, long runs of negative prices, and violated constraints, ranked by intensity.
- **Run a postmortem on price spikes.** Ask "why did SA hit $19,000/MWh at 7:30pm on 26 January?" and get findings computed from AEMO data: interconnector limits, binding network constraints, which fuels ramped up or ran out, and whether any constraint was violated.
- **See the grid's plumbing.** Interconnector flows against their limits, the constraint setting each limit (with AEMO's own description), and generation by fuel or by unit (gas, wind, solar, batteries, coal, hydro).
- **Give live updates on if you should run your dishwasher.** Hook your agent up to `nemcp` and Home Assistant, and intelligently schedule your appliances based on wholesale electricity prices.
- **Reveal which units and companies make the most on bids.** `get_generation` by unit, multiplied by price, gives revenue per station. Group by `participant_id` and you have revenue per company. One caveat: hedge contracts aren’t in the data, so this is pool revenue, not profit.
- **Fact check outside analysis.** Every response states its time convention, units, caveats, and data freshness, and links back to the exact AEMO file it came from.

## Installation

Requirements: Node 22+, pnpm, `unzip` on your PATH, and roughly 5–10 GB of disk for a year of data.

```bash
git clone https://github.com/OWNER/nemcp.git
cd nemcp
pnpm install
pnpm test
```

Load data: a year of prices and demand, unit reference data, and fuel types.

```bash
pnpm backfill --from=2025-10 --to=2026-09
pnpm backfill --tables=DUDETAILSUMMARY,STATION --from=2025-10 --to=2026-09
pnpm fuel     # AEMO registration list; if the download is blocked, pass a downloaded .xlsx path
```

Optional deeper data, for constraints, interconnectors and unit output (large downloads, so pick months):

```bash
pnpm backfill --tables=DISPATCHINTERCONNECTORRES,DISPATCHCONSTRAINT,DISPATCH_UNIT_SCADA --from=2026-01 --to=2026-01
pnpm backfill --tables=GENCONDATA,SPDINTERCONNECTORCONSTRAINT,SPDCONNECTIONPOINTCONSTRAINT --from=2024-01 --to=2026-09
```

Connect it to Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "nem": {
      "command": "/path/to/node",
      "args": ["/path/to/nemcp/node_modules/tsx/dist/cli.mjs", "/path/to/nemcp/src/server/index.ts"],
      "env": { "NEM_DATA_DIR": "/path/to/nemcp/data", "NEM_INGEST": "1" }
    }
  }
}
```

`NEM_INGEST=1` keeps live 5-minute data flowing while the server runs. Don't also run `pnpm ingest --watch` at the same time.

Or with Claude Code:

```bash
claude mcp add nem -e NEM_DATA_DIR="$PWD/data" -e NEM_INGEST=1 -- pnpm --dir "$PWD" tsx src/server/index.ts
```

Restart the client, then try: *"Call get_coverage, then explain the biggest SA price spike in January 2026."*

## Disclaimer

This was vibe coded: built quickly in conversation with an AI assistant, tested against real data, but not audited. Expect rough edges, check anything important against AEMO's own reports, and open an issue if you find something wrong.

Not affiliated with AEMO. Market data © AEMO, used under its [Copyright Permissions Notice](https://www.aemo.com.au/privacy-and-legal-notices/copyright-permissions). Nothing here is financial or trading advice. Wholesale "energy value" figures are pool estimates, not what consumers pay.
