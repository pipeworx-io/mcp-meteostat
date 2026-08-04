# @pipeworx/meteostat

Meteostat MCP — historical weather from 11,000+ stations, no auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

- `get_daily_history(station_id, start_date, end_date)` — daily readings.
- `get_monthly_normals(station_id)` — long-run monthly climate normals.

## Finding station IDs

The Meteostat **free public tier doesn't expose a search API**. Find IDs interactively at https://meteostat.net — search a place, the URL's numeric suffix is the station ID. Example: San Francisco Intl → `72494`.

For programmatic search, use Meteostat's RapidAPI plan (BYO key) or pair with `nws.get_observation` (US stations via ICAO).

## Data source

`https://bulk.meteostat.net/v2/` — public gzipped CSV bulk files. No key, no quota stated.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "meteostat": {
      "url": "https://gateway.pipeworx.io/meteostat/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Meteostat data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
