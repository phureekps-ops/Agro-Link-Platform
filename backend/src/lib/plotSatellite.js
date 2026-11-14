/**
 * Shared read side of the plot satellite viewer (NDVI chart + plot image),
 * used by both GET /admin/production-units/:id/satellite* (admin.js) and
 * GET /coop/production-units/:id/satellite* (coopcollection.js). Each route
 * opens its own session context (platform / organization) and passes the
 * client in, so access rules stay with the route.
 */
const sentinelHub = require('./sentinelHub');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const IMAGE_LONG_SIDE = 512;

function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }
function isDate(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

async function loadUnit(client, unitId) {
  const r = await client.query(
    `SELECT pu.unit_id, pu.commodity_code, c.name_th AS commodity_name_th, pu.area_rai, pu.season_id,
            f.full_name AS farmer_name, ST_AsGeoJSON(pu.gps_boundary, 6)::json AS geometry
       FROM registry.production_unit pu
       JOIN identity.farmer f ON f.farmer_id = pu.owner_farmer_id
       LEFT JOIN registry.commodity_ref c ON c.commodity_code = pu.commodity_code
      WHERE pu.unit_id = $1`,
    [unitId],
  );
  return r.rows[0] || null;
}

/** View box around the plot: the plot's own extent plus 40% on each side
 *  (at least ~150 m), so the field is seen with its neighbours. */
function viewBox(geometry) {
  const ring = geometry.coordinates[0];
  const xs = ring.map(p => p[0]); const ys = ring.map(p => p[1]);
  let [minx, maxx, miny, maxy] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const padX = Math.max((maxx - minx) * 0.4, 0.0014); const padY = Math.max((maxy - miny) * 0.4, 0.0014);
  minx -= padX; maxx += padX; miny -= padY; maxy += padY;
  const latMid = (miny + maxy) / 2;
  const widthM = (maxx - minx) * 111320 * Math.cos(latMid * Math.PI / 180);
  const heightM = (maxy - miny) * 110574;
  const w = widthM >= heightM ? IMAGE_LONG_SIDE : Math.round(IMAGE_LONG_SIDE * widthM / heightM);
  const h = heightM > widthM ? IMAGE_LONG_SIDE : Math.round(IMAGE_LONG_SIDE * heightM / widthM);
  return { bbox: [minx, miny, maxx, maxy], width: w, height: h };
}

/** Plot details + its clear-sky Sentinel-2 NDVI series, oldest first. */
async function getSeries(client, unitId) {
  const unit = await loadUnit(client, unitId);
  if (!unit) return null;
  const obs = await client.query(
    `SELECT observation_date, value_numeric, note
       FROM satellite.observation
      WHERE unit_id = $1 AND source_provider = 'sentinel2_optical' AND observation_type = 'ndvi'
        AND value_numeric IS NOT NULL
      ORDER BY observation_date`,
    [unitId],
  );
  const points = obs.rows.map((r) => {
    const m = /ปลอดเมฆ (\d+)%/.exec(r.note || '');
    const d = r.observation_date instanceof Date
      ? `${r.observation_date.getFullYear()}-${String(r.observation_date.getMonth() + 1).padStart(2, '0')}-${String(r.observation_date.getDate()).padStart(2, '0')}`
      : String(r.observation_date).slice(0, 10);
    return { date: d, ndvi: Number(r.value_numeric), clear_pct: m ? Number(m[1]) : null };
  });
  const vb = viewBox(unit.geometry);
  return {
    unit: {
      unit_id: unit.unit_id, farmer_name: unit.farmer_name, commodity_code: unit.commodity_code,
      commodity_name_th: unit.commodity_name_th, area_rai: Number(unit.area_rai), season_id: unit.season_id,
      boundary: unit.geometry.coordinates[0],
    },
    view: vb,
    points,
  };
}

/** PNG (base64) of the plot surroundings on one date, plus the box it covers
 *  so the client can draw the plot boundary on top. */
async function getImage(client, unitId, date, kind) {
  const unit = await loadUnit(client, unitId);
  if (!unit) return null;
  const vb = viewBox(unit.geometry);
  const png = await sentinelHub.fetchPlotImage({ bbox: vb.bbox, date, kind, width: vb.width, height: vb.height });
  return { date, kind, view: vb, png_base64: png.toString('base64') };
}

module.exports = { isUuid, isDate, getSeries, getImage };
