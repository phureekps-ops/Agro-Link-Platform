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

// NDVI from Sentinel-2 L2A B04 (red) / B08 (NIR), masking out nodata
// pixels, pixels where NDVI is undefined (B04+B08 == 0), and water pixels
// (Scene Classification Layer value 6) from the statistics — taken
// verbatim from CDSE's own documented Statistical API NDVI example.
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

  var validNdviMask = 1;
  if (samples.B08 + samples.B04 === 0) {
    validNdviMask = 0;
  }

  var noWaterMask = 1;
  if (samples.SCL === 6) {
    noWaterMask = 0;
  }

  return {
    data: [ndvi],
    dataMask: [samples.dataMask * validNdviMask * noWaterMask],
  };
}`;

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
 * [fromDate, toDate] (YYYY-MM-DD strings), aggregated in 10-day buckets
 * (Sentinel-2's own revisit time is ~5 days, so a 10-day bucket gives
 * each one a real chance at a cloud-free pass without over-fetching).
 * Returns the raw parsed response body; see extractLatestMeanNdvi() for
 * how callers interpret it.
 */
async function fetchNdviStatistics({ geoJsonPolygon, fromDate, toDate }) {
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
          dataFilter: { mosaickingOrder: 'leastCC' },
        },
      ],
    },
    aggregation: {
      timeRange: { from: `${fromDate}T00:00:00Z`, to: `${toDate}T23:59:59Z` },
      aggregationInterval: { of: 'P10D' },
      evalscript: NDVI_EVALSCRIPT,
      resx: 10,
      resy: 10,
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
 * Picks the most recent 10-day bucket in the response that actually has
 * valid (cloud-free, non-water) pixels, and returns its mean NDVI. Walks
 * backwards from the newest bucket so the result is always the latest
 * usable pass, not just the latest bucket regardless of cloud cover.
 * Returns null if every bucket in the requested window was fully
 * clouded/no-data — a real, expected outcome during Thailand's rainy
 * season, not an error.
 */
function extractLatestMeanNdvi(statisticsResponse) {
  const intervals = (statisticsResponse && statisticsResponse.data) || [];
  for (let i = intervals.length - 1; i >= 0; i -= 1) {
    const interval = intervals[i];
    const stats = interval
      && interval.outputs
      && interval.outputs.data
      && interval.outputs.data.bands
      && interval.outputs.data.bands.B0
      && interval.outputs.data.bands.B0.stats;
    if (stats && stats.sampleCount > 0 && stats.mean !== null && stats.mean !== undefined) {
      const isoDate = (interval.interval && (interval.interval.to || interval.interval.from)) || '';
      return {
        observationDate: isoDate.slice(0, 10),
        valueNumeric: Number(Number(stats.mean).toFixed(4)),
        sampleCount: stats.sampleCount,
      };
    }
  }
  return null;
}

/**
 * High-level entry point used by the admin route: given a plot's GeoJSON
 * boundary, fetches the most recent cloud-free mean NDVI from the last 60
 * days. Returns null (not a thrown error) when no cloud-free pass was
 * found in that window — callers should surface this as a normal "no
 * imagery available" outcome, not a system error.
 */
async function fetchLatestNdvi(geoJsonPolygon) {
  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - 60 * 24 * 60 * 60 * 1000);
  const toStr = toDate.toISOString().slice(0, 10);
  const fromStr = fromDate.toISOString().slice(0, 10);

  const statisticsResponse = await fetchNdviStatistics({ geoJsonPolygon, fromDate: fromStr, toDate: toStr });
  return extractLatestMeanNdvi(statisticsResponse);
}

module.exports = { isConfigured, fetchLatestNdvi, SentinelHubError };
