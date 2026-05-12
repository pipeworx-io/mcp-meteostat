interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Meteostat MCP — historical weather from 11k+ stations (no auth)
 *
 * Uses the free bulk-CSV interface at bulk.meteostat.net. Complements the
 * `weather` pack (Open-Meteo, gridded reanalysis) with station-level data:
 * actual readings from physical weather stations, not interpolated.
 *
 * Finding station IDs: visit https://meteostat.net, search a place, the URL
 * ends in the numeric station ID (e.g., 72494 = San Francisco Intl).
 * Meteostat's public free tier doesn't expose a search API, so station_id is
 * required input. For a hosted search, use their RapidAPI plan.
 *
 * API: https://dev.meteostat.net/bulk
 * Tools:
 * - get_daily_history:   daily values between two dates
 * - get_monthly_normals: 30-year monthly climate normals
 */


const BULK_BASE = 'https://bulk.meteostat.net/v2';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const tools: McpToolExport['tools'] = [
  {
    name: 'get_daily_history',
    description:
      'Daily historical weather for a Meteostat station between two dates. Returns date-keyed temperature (avg/min/max), precipitation, snow, wind, pressure, sun hours. Station IDs are numeric — find them at meteostat.net (URL suffix).',
    inputSchema: {
      type: 'object',
      properties: {
        station_id: { type: 'string', description: 'Meteostat numeric station ID (e.g., "72494")' },
        start_date: { type: 'string', description: 'YYYY-MM-DD inclusive' },
        end_date: { type: 'string', description: 'YYYY-MM-DD inclusive' },
      },
      required: ['station_id', 'start_date', 'end_date'],
    },
  },
  {
    name: 'get_monthly_normals',
    description:
      'Monthly climate normals for a station — long-run averages of temperature, precipitation, and pressure by calendar month. Useful for "what\'s normal in May here" baselines.',
    inputSchema: {
      type: 'object',
      properties: {
        station_id: { type: 'string', description: 'Meteostat numeric station ID' },
      },
      required: ['station_id'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'get_daily_history':
      return getDailyHistory(
        reqStr(args, 'station_id', '"72494" (KSFO)'),
        reqStr(args, 'start_date', '"2020-01-01"'),
        reqStr(args, 'end_date', '"2020-12-31"'),
      );
    case 'get_monthly_normals':
      return getMonthlyNormals(reqStr(args, 'station_id', '"72494"'));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" is missing or empty. Pass a string like ${example}.`);
  }
  return v;
}

async function fetchGzipText(url: string): Promise<string> {
  const res = await fetch(url);
  if (res.status === 404) {
    throw new Error(`Meteostat: no data file at ${url} — check the station ID`);
  }
  if (!res.ok) {
    throw new Error(`Meteostat error: ${res.status} ${res.statusText}`);
  }
  // Bulk files are gzipped; Cloudflare's fetch handles decompression automatically
  // when the response advertises Content-Encoding: gzip, but bulk.meteostat.net
  // serves them as application/octet-stream with the gzip extension — we have to
  // decompress ourselves via DecompressionStream.
  if (!res.body) throw new Error('Meteostat: empty response body');
  const ds = new DecompressionStream('gzip');
  const stream = res.body.pipeThrough(ds);
  return new Response(stream).text();
}

function parseCsv(text: string): string[][] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(','));
}

// ── Daily history ────────────────────────────────────────────────────
// Bulk daily CSV columns (no header):
//   date, tavg, tmin, tmax, prcp, snow, wdir, wspd, wpgt, pres, tsun

interface DailyRow {
  date: string;
  tavg_c: number | null;
  tmin_c: number | null;
  tmax_c: number | null;
  precip_mm: number | null;
  snow_mm: number | null;
  wind_dir_deg: number | null;
  wind_speed_kmh: number | null;
  wind_peak_kmh: number | null;
  pressure_hpa: number | null;
  sunshine_min: number | null;
}

function num(v: string): number | null {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function getDailyHistory(stationId: string, start: string, end: string) {
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new Error('start_date and end_date must be YYYY-MM-DD');
  }
  if (start > end) throw new Error('start_date must be <= end_date');
  const id = stationId.trim();
  if (!/^\d+$/.test(id)) throw new Error('station_id must be a numeric Meteostat ID');

  const text = await fetchGzipText(`${BULK_BASE}/daily/${id}.csv.gz`);
  const rows = parseCsv(text);

  const out: DailyRow[] = [];
  for (const r of rows) {
    if (r.length < 11) continue;
    const date = r[0];
    if (date < start || date > end) continue;
    out.push({
      date,
      tavg_c: num(r[1]),
      tmin_c: num(r[2]),
      tmax_c: num(r[3]),
      precip_mm: num(r[4]),
      snow_mm: num(r[5]),
      wind_dir_deg: num(r[6]),
      wind_speed_kmh: num(r[7]),
      wind_peak_kmh: num(r[8]),
      pressure_hpa: num(r[9]),
      sunshine_min: num(r[10]),
    });
  }

  return {
    station_id: id,
    start_date: start,
    end_date: end,
    count: out.length,
    days: out,
  };
}

// ── Monthly normals ──────────────────────────────────────────────────
// Bulk normals CSV columns:
//   start, end, month, tavg, tmin, tmax, prcp, wspd, pres, tsun

async function getMonthlyNormals(stationId: string) {
  const id = stationId.trim();
  if (!/^\d+$/.test(id)) throw new Error('station_id must be a numeric Meteostat ID');

  const text = await fetchGzipText(`${BULK_BASE}/normals/${id}.csv.gz`);
  const rows = parseCsv(text);

  const out = rows
    .filter((r) => r.length >= 10)
    .map((r) => ({
      reference_start_year: Number(r[0]),
      reference_end_year: Number(r[1]),
      month: Number(r[2]),
      tavg_c: num(r[3]),
      tmin_c: num(r[4]),
      tmax_c: num(r[5]),
      precip_mm: num(r[6]),
      wind_speed_kmh: num(r[7]),
      pressure_hpa: num(r[8]),
      sunshine_min: num(r[9]),
    }));

  return {
    station_id: id,
    count: out.length,
    normals: out,
  };
}

export default { tools, callTool, meter: { credits: 2 } } satisfies McpToolExport;
