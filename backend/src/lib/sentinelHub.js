/**
 * Sentinel Hub (Copernicus Data Space Ecosystem) client — P7 of the RAP-T
 * readiness roadmap, per the AgroLink x RAP-T Gap Analysis report's roadmap
 * item "P7 — เชื่อมต่อ API ภาพถ่ายดาวเทียมจริง: แทนที่การป้อนข้อมูลด้วยมือ
 * ด้วยการเชื่อมต่อ Sentinel Hub, Google Earth Engine หรือ GISTDA". Replaces
 * manual NDVI entry in satellite.observation (grant_satellite_observation.
 * sql) with a real call to ESA's Copernicus Data Space Ecosystem (CDSE)
 * Statistical API, for any registry.production_unit — every one has a
 * gps_boundary (NOT NULL PostGIS Polygon, see 02_full_schema.sql; farmers
 * draw it at registration via register-plot.html) that can be used as the
 * area of interest without any new schema.
 *
 * Why Sentinel Hub and not Google Earth Engine or GISTDA (decided with the
 * user after comparing the three): Earth Engine's generous free tier is
 * noncommercial-only and AgroLink is a commercial platform, so it risked
 * metered/paid usage from day one; GISTDA's only confirmed public endpoint
 * at the time of writing was a basemap map-tile service, not an analytics
 * API that can compute NDVI over an arbitrary polygon. Sentinel Hub via
 * CDSE is free within a published quota, documented, and already has
 * 'sentinel2_optical' reserved as a valid satellite.observation.
 * source_provider value (grant_satellite_observation.sql's original CHECK
 * constraint already anticipated this).
 *
 * Needs two environment variables, set on Render — NEVER commit real
 * values to git (see render.yaml's SENTINELHUB_CLIENT_ID/
 * SENTINELHUB_CLIENT_SECRET, both sync: false so Render prompts for them
 * instead of generating or storing a value in this repo):
 *   - SENTINELHUB_CLIENT_ID
 *   - SENTINELHUB_CLIENT_SECRET
 * Created from an OAuth client on the CDSE dashboard
 * (shapps.dataspace.copernicus.eu/dashboard -> User Settings -> OAuth
 * clients -> Create) — see DEPLOY.md for the full sign-up walkthrough.
 *
 * HONESTY NOTE, written before this was ever called against a live
 * account (none existed yet when this file was written — the user chose
 * "ยังไม่มี ต้องไปสมัครเอง" when asked): the token endpoint, Statistical
 * API endpoint, request shape, and NDVI evalscript below are taken
 * directly from CDSE's own official documentation
 * (documentation.dataspace.copernicus.eu/APIs/Token.html and
 * .../APIs/SentinelHub/Statistical/Examples.html), not from a working
 * test. The one piece NOT directly confirmed from docs is the exact CRS
 * URI the Statistical API expects for a WGS84 (EPSG:4326) polygon coming
 * straight out of PostGIS's ST_AsGeoJSON() — this uses Sentinel Hub's
 * commonly-documented convention "http://www.opengis.net/def/crs/
 * OGC/1.3/CRS84" (lon,lat order, matching GeoJSON's own coordinate
 * order). Likewise, the response-parsing shape in extractLatestMeanNdvi()
 * (outputs.<id>.bands.B0.stats) follows Sentinel Hub's standard
 * Statistical API response shape but has not been checked against a real
 * response body. TEST THIS against a real plot once real CDSE credentials
 * exist, and fix extractLatestMeanNdvi()/fetchNdviStatistics() here if the
 * live response disagrees with what's assumed.
 *
 * Uses Node's built-in global fetch() (Node 18+, already the case for
 * Render's default Node runtime here) — no new npm dependency added.
 */

const TOKEN_URL = 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';
const STATISTICS_URL = 'https://sh.dataspace.copernicus.eu/statistics/v1';
const PROCESS_URL = 'https://sh.dataspace.copernicus.eu/api/v1/process';

// NDVI from Sentinel-2 L2A B04 (red) / B08 (NIR). Only pixels whose
// Scene Classification Layer (SCL) is 4 (vegetation) or 5 (not vegetated /
// bare soil) are kept: this drops clouds (8, 9), cirrus (10), cloud shadow
// (3), water (6), snow (11), saturated/defective (1) and unclassified (7)
// pixels. The first live test on 2026-11-14 used an evalscript that only
// masked water, so a partly cloudy scene pulled the mean NDVI down; this
// stricter mask fixes that. noDataCount in the response = masked pixels,
// so (sampleCount - noDataCount) / sampleCount = the clear-sky share of
// the plot on that date.
const NDVI_EVALSCRIPT = `//VERSION=3
function setup() {
  return {
    input: [{
      bands: ["B04", "B08", "SCL", "dataMask"]
    }],
    output: [
      { id: "data", bands: 1 },
      { id: "dataMask", bands: 1 }
    ]
  };
}

function evaluatePixel(samples) {
  let ndvi = (samples.B08 - samples.B04) / (samples.B08 + samples.B04);
  var valid = 1;
  if (samples.B08 + samples.B04 === 0) {
    valid = 0;
  }
  if (samples.SCL !== 4 && samples.SCL !== 5) {
    valid = 0;
  }
  return {
    data: [ndvi],
    dataMask: [samples.dataMask * valid],
  };
}`;

// A date counts only when at least this share of the plot's pixels is
// clear sky — a mean over a few pixels between clouds is not a reliable
// reading of the whole plot.
const MIN_CLEAR_RATIO = 0.6;
// A plot smaller than a few pixels cannot give a meaningful plot mean.
const MIN_PIXELS = 4;

// In-process token cache — fine for a single Node process (if Render
// restarts the service, this just re-fetches on next use). CDSE's own
// docs explicitly warn that requesting a fresh token per API call is
// rate-limited (HTTP 429), so this is not just an optimization.
let cachedToken = null; // { accessToken, expiresAt (ms epoch) }

class SentinelHubError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'SentinelHubError';
    this.sentinelHubError = true;
    this.status = status;
    this.body = body;
  }
}

function isConfigured() {
  return Boolean(process.env.SENTINELHUB_CLIENT_ID && process.env.SENTINELHUB_CLIENT_SECRET);
}

/**
 * OAuth2 client_credentials grant against CDSE's Keycloak token endpoint
 * (documentation.dataspace.copernicus.eu/APIs/Token.html). Caches the
 * token until shortly before it expires.
 */
async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 30_000) {
    return cachedToken.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.SENTINELHUB_CLIENT_ID,
    client_secret: process.env.SENTINELHUB_CLIENT_SECRET,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok || !json || !json.access_token) {
    throw new SentinelHubError('sentinelhub_token_request_failed', { status: res.status, body: json });
  }

  cachedToken = {
    accessToken: json.access_token,
    expiresAt: now + Number(json.expires_in || 300) * 1000,
  };
  return cachedToken.accessToken;
}

/**
 * Calls the Statistical API for one GeoJSON Polygon (expected in
 * EPSG:4326 — straight from PostGIS's ST_AsGeoJSON(gps_boundary)) over
 * [fromDate, toDate] (YYYY-MM-DD strings), aggregated per day by default
 * (P1D), so each interval is one acquisition date (Sentinel-2 passes every
 * ~5 days). Returns the raw parsed response body; see parseDailySeries().
 */
async function fetchNdviStatistics({ geoJsonPolygon, fromDate, toDate, interval = 'P1D' }) {
  const accessToken = await getAccessToken();

  const requestBody = {
    input: {
      bounds: {
        geometry: geoJsonPolygon,
        properties: {
          crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
        },
      },
      data: [
        {
          type: 'sentinel-2-l2a',
          dataFilter: { mosaickingOrder: 'leastCC', maxCloudCoverage: 80 },
        },
      ],
    },
    aggregation: {
      timeRange: { from: `${fromDate}T00:00:00Z`, to: `${toDate}T23:59:59Z` },
      aggregationInterval: { of: interval },
      evalscript: NDVI_EVALSCRIPT,
      // resx/resy are in the units of the request CRS. The geometry is sent
      // in CRS84 (degrees), so "10" meant 10 DEGREES per pixel: every plot
      // collapsed into a single coarse pixel (sampleCount 1), found in the
      // first live run on 2026-11-14. 0.0001 degree ≈ 11 m, close to
      // Sentinel-2's native 10 m for B04/B08.
      resx: 0.0001,
      resy: 0.0001,
    },
  };

  const res = await fetch(STATISTICS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(requestBody),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok || !json) {
    throw new SentinelHubError('sentinelhub_statistics_request_failed', { status: res.status, body: json });
  }
  return json;
}

/**
 * Turns a Statistical API response aggregated per day (P1D) into one
 * entry per acquisition date that has enough clear-sky pixels. Each entry
 * carries the real acquisition date (the interval's own start date, since
 * one P1D interval = one calendar day), the mean NDVI of the clear pixels,
 * and the clear-sky share, so later analysis can weigh or filter readings.
 */
function parseDailySeries(statisticsResponse, minClearRatio = MIN_CLEAR_RATIO) {
  const intervals = (statisticsResponse && statisticsResponse.data) || [];
  const out = [];
  for (const interval of intervals) {
    const stats = interval && interval.outputs && interval.outputs.data
      && interval.outputs.data.bands && interval.outputs.data.bands.B0
      && interval.outputs.data.bands.B0.stats;
    if (!stats) continue;
    const total = Number(stats.sampleCount) || 0;
    const masked = Number(stats.noDataCount) || 0;
    const valid = total - masked;
    const mean = Number(stats.mean);
    if (total <= 0 || valid <= 0 || !Number.isFinite(mean)) continue;
    const clearRatio = valid / total;
    if (clearRatio < minClearRatio) continue;
    const from = (interval.interval && interval.interval.from) || '';
    out.push({
      observationDate: from.slice(0, 10),
      valueNumeric: Number(mean.toFixed(4)),
      sampleCount: valid,
      totalCount: total,
      clearRatio: Number(clearRatio.toFixed(3)),
      stDev: Number.isFinite(Number(stats.stDev)) ? Number(Number(stats.stDev).toFixed(4)) : null,
    });
  }
  return out.sort((x, y) => x.observationDate.localeCompare(y.observationDate));
}

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDay = d => d.toISOString().slice(0, 10);

/**
 * Daily clear-sky NDVI series for one plot between two dates. The range is
 * fetched in chunks of at most 90 days so one long request cannot time out.
 */
async function fetchNdviSeries(geoJsonPolygon, fromDate, toDate) {
  const series = [];
  let start = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  while (start <= end) {
    const chunkEnd = new Date(Math.min(start.getTime() + 89 * DAY_MS, end.getTime()));
    const res = await fetchNdviStatistics({ geoJsonPolygon, fromDate: isoDay(start), toDate: isoDay(chunkEnd), interval: 'P1D' });
    series.push(...parseDailySeries(res, 0));
    start = new Date(chunkEnd.getTime() + DAY_MS);
  }
  // sampleCount from the Statistical API counts every pixel of the plot's
  // bounding box, and pixels outside the polygon come back as noData (found
  // on 2026-11-14: an irregular 62-rai plot had a constant 60% "clear"
  // share on cloud-free days). So the clear-sky share is measured against
  // the plot's own pixel count, taken as the largest valid count seen in
  // the window (a fully clear day), not against the bounding box.
  const ref = series.reduce((m, p) => Math.max(m, p.sampleCount), 0);
  if (ref < MIN_PIXELS) return [];
  return series
    .map(p => ({ ...p, totalCount: ref, clearRatio: Number((p.sampleCount / ref).toFixed(3)) }))
    .filter(p => p.clearRatio >= MIN_CLEAR_RATIO);
}

/**
 * High-level entry point used by the single-plot admin button: the most
 * recent clear-sky acquisition in the last 60 days, with its real date.
 * Returns null (not a thrown error) when no clear-sky pass was found — a
 * normal outcome in Thailand's rainy season.
 */
async function fetchLatestNdvi(geoJsonPolygon) {
  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - 60 * DAY_MS);
  const series = await fetchNdviSeries(geoJsonPolygon, isoDay(fromDate), isoDay(toDate));
  return series.length ? series[series.length - 1] : null;
}


// ---------------------------------------------------------------------------
// Plot images (Process API) — a picture of the plot and its surroundings on
// one acquisition date, for the NDVI viewer in the admin and cooperative
// portals. Two looks: true colour (what the eye would see) and an NDVI
// colour ramp (brown = bare soil, yellow = sparse, green = dense crop).
// ---------------------------------------------------------------------------
const TRUE_COLOR_EVALSCRIPT = `//VERSION=3
function setup() {
  return { input: ["B02", "B03", "B04", "dataMask"], output: { bands: 4 } };
}
function evaluatePixel(s) {
  return [2.5 * s.B04, 2.5 * s.B03, 2.5 * s.B02, s.dataMask];
}`;

const NDVI_COLOR_EVALSCRIPT = `//VERSION=3
function setup() {
  return { input: ["B04", "B08", "dataMask"], output: { bands: 4 } };
}
function evaluatePixel(s) {
  let v = (s.B08 - s.B04) / (s.B08 + s.B04);
  let c = colorBlend(v,
    [0.0, 0.2, 0.4, 0.6, 0.8],
    [[0.62, 0.42, 0.25], [0.86, 0.78, 0.47], [0.70, 0.84, 0.43], [0.30, 0.65, 0.27], [0.06, 0.40, 0.16]]);
  return [c[0], c[1], c[2], s.dataMask];
}`;

const imageCache = new Map(); // key -> { buffer, at }
const IMAGE_CACHE_MAX = 120;

/**
 * PNG of bbox [minLon, minLat, maxLon, maxLat] on one date. kind is
 * 'truecolor' or 'ndvi'. Cached in memory so re-opening the same plot/date
 * does not spend Copernicus processing units again (the cache resets when
 * Render restarts the service).
 */
async function fetchPlotImage({ bbox, date, kind, width, height }) {
  const key = [bbox.map(v => v.toFixed(6)).join(','), date, kind, width, height].join('|');
  if (imageCache.has(key)) return imageCache.get(key).buffer;

  const accessToken = await getAccessToken();
  const requestBody = {
    input: {
      bounds: { bbox, properties: { crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84' } },
      data: [{
        type: 'sentinel-2-l2a',
        dataFilter: { timeRange: { from: `${date}T00:00:00Z`, to: `${date}T23:59:59Z` }, mosaickingOrder: 'leastCC' },
      }],
    },
    output: { width, height, responses: [{ identifier: 'default', format: { type: 'image/png' } }] },
    evalscript: kind === 'ndvi' ? NDVI_COLOR_EVALSCRIPT : TRUE_COLOR_EVALSCRIPT,
  };
  const res = await fetch(PROCESS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'image/png', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(requestBody),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => null);
    throw new SentinelHubError('sentinelhub_process_request_failed', { status: res.status, body });
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
  imageCache.set(key, { buffer, at: Date.now() });
  return buffer;
}

module.exports = { isConfigured, fetchLatestNdvi, fetchNdviSeries, parseDailySeries, fetchPlotImage, SentinelHubError, MIN_CLEAR_RATIO };
