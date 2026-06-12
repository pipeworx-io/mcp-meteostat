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
 * Finding station IDs: use find_stations (search by name/country/proximity
 * over the bulk station catalog) — no need to leave the platform.
 *
 * API: https://dev.meteostat.net/bulk
 * Tools:
 * - find_stations:       look up station IDs by name / country / lat-lon
 * - get_daily_history:   daily values between two dates
 * - get_monthly_normals: 30-year monthly climate normals
 */


const BULK_BASE = 'https://bulk.meteostat.net/v2';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const tools: McpToolExport['tools'] = [
  {
    name: 'find_stations',
    description:
      'Find Meteostat weather station IDs by place name and/or geographic proximity — the lookup you need BEFORE get_daily_history / get_monthly_normals (which require a station_id). Search by name ("San Francisco", "Heathrow"), filter by country (ISO-2 like "US", "GB"), and/or rank by nearest to a lat/lon. Returns each station\'s id, name, country, region, coordinates, elevation, timezone, and data inventory (which granularities — hourly/daily/monthly — are available and their date ranges, so you can pick a station that actually has the period you need). Use for "weather station near X", "what is the station ID for Y", "stations in country Z".',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Station/place name substring (case-insensitive), e.g. "Heathrow", "San Francisco".' },
        country: { type: 'string', description: 'ISO-2 country code filter (e.g. "US", "GB", "DE").' },
        near_lat: { type: 'number', description: 'Latitude to rank stations by proximity (pair with near_lon).' },
        near_lon: { type: 'number', description: 'Longitude to rank stations by proximity (pair with near_lat).' },
        limit: { type: 'number', description: 'Max stations to return (1-50, default 10).' },
      },
      required: [],
    },
  },
  {
    name: 'get_daily_history',
    description:
      'Daily historical weather for a Meteostat station between two dates. Returns date-keyed temperature (avg/min/max), precipitation, snow, wind, pressure, sun hours. Get a station_id from find_stations.',
    inputSchema: {
      type: 'object',
      properties: {
        station_id: { type: 'string', description: 'Meteostat station ID (e.g., "72494") — from find_stations' },
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
        station_id: { type: 'string', description: 'Meteostat station ID — from find_stations' },
      },
      required: ['station_id'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'find_stations':
      return findStations(
        args.query as string | undefined,
        args.country as string | undefined,
        args.near_lat as number | undefined,
        args.near_lon as number | undefined,
        (args.limit as number) ?? 10,
      );
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

// ── Station search ───────────────────────────────────────────────────
// The full station catalog (~22k stations) as gzipped JSON. The pack header
// used to say "no search API exists" — but this bulk dump gives us one. Each
// station's `id` is the same key the daily/normals/hourly bulk files use
// (alphanumeric, e.g. "00FAY" or "72494").

interface RawStation {
  id: string;
  name?: { en?: string };
  country?: string;
  region?: string;
  identifiers?: { national?: string; wmo?: string; icao?: string };
  location?: { latitude?: number; longitude?: number; elevation?: number };
  timezone?: string;
  inventory?: Record<string, { start?: string | number | null; end?: string | number | null }>;
}

let stationsCache: RawStation[] | null = null;

async function loadStations(): Promise<RawStation[]> {
  if (stationsCache) return stationsCache;
  const text = await fetchGzipText(`${BULK_BASE}/stations/full.json.gz`);
  stationsCache = JSON.parse(text) as RawStation[];
  return stationsCache;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function shapeStation(s: RawStation, distanceKm?: number) {
  return {
    station_id: s.id,
    name: s.name?.en ?? null,
    country: s.country ?? null,
    region: s.region ?? null,
    identifiers: s.identifiers ?? null,
    latitude: s.location?.latitude ?? null,
    longitude: s.location?.longitude ?? null,
    elevation_m: s.location?.elevation ?? null,
    timezone: s.timezone ?? null,
    inventory: s.inventory ?? null,
    ...(distanceKm != null ? { distance_km: Math.round(distanceKm * 10) / 10 } : {}),
  };
}

async function findStations(
  query: string | undefined,
  country: string | undefined,
  nearLat: number | undefined,
  nearLon: number | undefined,
  limit: number,
) {
  const hasProximity = typeof nearLat === 'number' && typeof nearLon === 'number';
  if (!query?.trim() && !country?.trim() && !hasProximity) {
    throw new Error('Provide at least one of: query (place name), country (ISO-2), or near_lat + near_lon.');
  }
  const cap = Math.min(50, Math.max(1, limit));
  const q = query?.toLowerCase().trim();
  const cc = country?.toUpperCase().trim();

  const stations = await loadStations();
  const matches = stations.filter((s) => {
    if (cc && (s.country ?? '').toUpperCase() !== cc) return false;
    if (q && !(s.name?.en ?? '').toLowerCase().includes(q)) return false;
    return true;
  });

  if (hasProximity) {
    const ranked = matches
      .filter((s) => typeof s.location?.latitude === 'number' && typeof s.location?.longitude === 'number')
      .map((s) => ({ s, d: haversineKm(nearLat!, nearLon!, s.location!.latitude!, s.location!.longitude!) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, cap);
    return { total_matched: matches.length, stations: ranked.map(({ s, d }) => shapeStation(s, d)) };
  }

  return {
    total_matched: matches.length,
    stations: matches.slice(0, cap).map((s) => shapeStation(s)),
  };
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
  if (!/^[A-Za-z0-9]+$/.test(id)) throw new Error('station_id must be a Meteostat station ID (alphanumeric, e.g. "72494" or "00FAY" — use find_stations to look one up)');

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
  if (!/^[A-Za-z0-9]+$/.test(id)) throw new Error('station_id must be a Meteostat station ID (alphanumeric, e.g. "72494" or "00FAY" — use find_stations to look one up)');

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
