/**
 * กรมพัฒนาที่ดิน (LDD) — soil-analysis open data connector.
 *
 * Source: LDD open-data catalog, dataset "การตรวจวิเคราะห์ดิน" (osd01,
 * https://lddcatalog.ldd.go.th/en/dataset/osd01, licence: Creative Commons
 * Attributions). Its JSON resource is https://osd101.ldd.go.th/api/data.php.
 * The data dictionary (datadict_soilanalysis.csv) lists ONE ROW PER ANALYSIS
 * ITEM: parameter (name, may contain HTML), province, value (number, text or
 * blank), latitude, longitude, date, address, village, district, amphur.
 *
 * LDD publishes no API for its fertiliser recommendation itself — the
 * recommendation is still computed by AgroLink's own calculator
 * (routes/fertilizer.js). This connector supplies the SOIL VALUES: it groups
 * the per-item rows into samples (same point + date), maps the parameter
 * names to pH / OM / N / P / K / EC, and converts them to the low/medium/high
 * levels the calculator reads.
 *
 * The request parameters of data.php are not documented publicly (the
 * catalog's "Parameter Request" sheet could not be read), so the URL is a
 * template: LDD_SOIL_API_URL, default
 *   https://osd101.ldd.go.th/api/data.php?province={province}
 * {province} is replaced by the URL-encoded Thai province name. Rows are
 * ALSO filtered by province locally, so an API that ignores the parameter
 * still works (only slower). Admin › ข้อมูลดิน กพด. shows the raw parameter
 * names seen, so a mapping gap is visible instead of silent.
 */

const crypto = require('crypto');

const DEFAULT_URL = 'https://osd101.ldd.go.th/api/data.php?province={province}';
const MAX_BYTES = 40 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
function stripHtml(s) {
  return String(s == null ? '' : s)
    .replace(/<sub>\s*2\s*<\/sub>/gi, '2').replace(/<sub>\s*5\s*<\/sub>/gi, '5')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Analysis item name → 'ph' | 'om' | 'n' | 'p' | 'k' | 'ec' | null. Order matters. */
function classifyParameter(raw) {
  const s = stripHtml(raw);
  if (!s) return null;
  const lower = s.toLowerCase();
  if (/buffer|lime requirement|ความต้องการปูน/.test(lower)) return null;
  if (/\bph\b|ความเป็นกรด/.test(lower)) return 'ph';
  if (/อินทรียวัตถุ|organic\s*matter|\bo\.?\s?m\.?\b/.test(lower)) return 'om';
  if (/การนำไฟฟ้า|\bec\b|electrical\s*conductivity|ความเค็ม/.test(lower)) return 'ec';
  if (/ฟอสฟอรัส|phosphorus|\bp2o5\b|\bavail(able)?\.?\s*p\b/.test(lower) || /^P\b/.test(s)) return 'p';
  if (/โพแทสเซียม|โพแทสเซี่ยม|โปแตสเซียม|โพแตสเซียม|potassium|\bk2o\b|\b(exch|avail)\w*\.?\s*k\b/.test(lower) || /^K\b/.test(s)) return 'k';
  if (/ไนโตรเจน|nitrogen|\btotal\s*n\b/.test(lower) || /^N\b/.test(s)) return 'n';
  return null;
}

/** "12.5", "<0.5", "1,234.5 mg/kg" → number; "-", "", text → null. */
function parseNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = stripHtml(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** Text levels some reports use instead of a number. */
function parseLevelText(v) {
  const s = stripHtml(v);
  if (/ต่ำ|low/i.test(s)) return 'low';
  if (/ปานกลาง|medium|moderate/i.test(s)) return 'medium';
  if (/สูง|high/i.test(s)) return 'high';
  return null;
}

const TH_MONTHS = [
  ['มกราคม', 'ม.ค.'], ['กุมภาพันธ์', 'ก.พ.'], ['มีนาคม', 'มี.ค.'], ['เมษายน', 'เม.ย.'], ['พฤษภาคม', 'พ.ค.'], ['มิถุนายน', 'มิ.ย.'],
  ['กรกฎาคม', 'ก.ค.'], ['สิงหาคม', 'ส.ค.'], ['กันยายน', 'ก.ย.'], ['ตุลาคม', 'ต.ค.'], ['พฤศจิกายน', 'พ.ย.'], ['ธันวาคม', 'ธ.ค.'],
];
/**
 * '2025-08-01', '2025-08-01 10:00', '01/08/2568', '1/8/2025',
 * '13 พฤศจิกายน พ.ศ. 2569' (the osd101 API format), '13 พ.ย. 69' → 'YYYY-MM-DD' | null
 */
function parseDate(v) {
  const s = String(v == null ? '' : v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  let y; let mo; let d;
  if (m) { [, y, mo, d] = m.map(Number); } else if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/))) {
    [, d, mo, y] = m.map(Number);
  } else {
    const idx = TH_MONTHS.findIndex(([full, abbr]) => s.includes(full) || s.includes(abbr));
    const dm = s.match(/^(\d{1,2})\s/);
    const ym = s.match(/(\d{4}|\d{2})\s*$/);
    if (idx === -1 || !dm || !ym) return null;
    d = Number(dm[1]); mo = idx + 1; y = Number(ym[1]);
    if (y < 100) y += 2500; // '69' = พ.ศ. 2569
  }
  if (y > 2400) y -= 543; // Buddhist year
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y > 1990 && y < 2100)) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Accepts an array, or {data|result|results|records|items: [...]}. */
function extractRows(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    for (const k of ['data', 'result', 'results', 'records', 'items', 'rows']) {
      if (Array.isArray(json[k])) return json[k];
    }
  }
  return null;
}

const pick = (r, ...keys) => {
  for (const k of keys) if (r[k] !== undefined && r[k] !== null && r[k] !== '') return r[k];
  return null;
};
const normProvince = (s) => stripHtml(s).replace(/^จังหวัด|^จ\.\s*/, '').replace(/\s+/g, '');

/**
 * Per-item rows → samples. A sample = one location + date (+ address).
 * Returns { samples, unmapped: {parameterName: count}, rows }.
 */
const shortHash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

/**
 * The API returns one row per analysis item, and the same point + date +
 * address can hold SEVERAL samples (e.g. 5 soil samples from one farm the same
 * day, each with its own pH/OM/P/K/EC rows). Sample n at a location = the n-th
 * time each parameter appears there, so a sample's key is
 * location#occurrence. `_occ` on a row (set by the admin import page before it
 * splits a big file into chunks) overrides the local count so keys stay the
 * same across chunks. The house-number address is only hashed into the key,
 * never stored.
 */
function groupSamples(rows, province) {
  const want = province ? normProvince(province) : null;
  const samples = new Map();
  const occ = new Map();
  const unmapped = {};
  let used = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const prov = pick(r, 'province', 'province_name', 'changwat');
    if (want && prov && normProvince(prov) !== want) continue;
    const lat = parseNumber(pick(r, 'latitude', 'lat'));
    const lng = parseNumber(pick(r, 'longitude', 'lng', 'lon', 'long'));
    if (!(lat > 4 && lat < 22 && lng > 96 && lng < 107)) continue; // inside Thailand
    const date = parseDate(pick(r, 'date', 'analysis_date', 'sample_date'));
    const param = pick(r, 'parameter', 'param', 'name');
    const kind = classifyParameter(param);
    if (!kind) { const n = stripHtml(param) || '(ว่าง)'; unmapped[n] = (unmapped[n] || 0) + 1; continue; }
    const address = [pick(r, 'address'), pick(r, 'village'), pick(r, 'district'), pick(r, 'amphur')].map((x) => stripHtml(x || ''));
    const base = `${lat.toFixed(5)},${lng.toFixed(5)},${date || ''},${shortHash(address.join('|'))}`;
    let n;
    if (Number.isInteger(r._occ) && r._occ >= 0) n = r._occ;
    else {
      const ok = `${base}|${stripHtml(param)}`;
      n = occ.get(ok) || 0;
      occ.set(ok, n + 1);
    }
    const key = `${base}#${n}`;
    let s = samples.get(key);
    if (!s) {
      s = {
        sample_key: key, province: prov ? normProvince(prov) : (want || null), amphur: stripHtml(pick(r, 'amphur')) || null,
        district: stripHtml(pick(r, 'district')) || null, village: stripHtml(pick(r, 'village')) || null,
        latitude: lat, longitude: lng, sampled_on: date, values: {}, text_levels: {}, raw: {},
      };
      samples.set(key, s);
    }
    const v = pick(r, 'value', 'result');
    const x = parseNumber(v);
    if (x !== null) s.values[kind] = x;
    else if (parseLevelText(v)) s.text_levels[kind] = parseLevelText(v);
    s.raw[stripHtml(param)] = v === null ? null : stripHtml(v);
    used += 1;
  }
  return { samples: [...samples.values()].filter((s) => Object.keys(s.values).length || Object.keys(s.text_levels).length), unmapped, used };
}

// ---------------------------------------------------------------------------
// Levels. OM classes are LDD's (คู่มือวิเคราะห์ดิน สำนักวิทยาศาสตร์เพื่อการ
// พัฒนาที่ดิน: ต่ำมาก <0.5 … ปานกลาง 1.5–2.5 … สูง 3.5–4.5 …) collapsed to
// three levels. The P and K cut-offs are general interpretation values (K
// 60 / 90 mg/kg follow the class breaks LDD uses in its national K survey);
// they are approximations, labelled as such to the farmer — a level printed
// on the farmer's own LDD lab report or Test Kit always wins.
// ---------------------------------------------------------------------------
const CRITERIA = {
  om: { low_below: 1.5, high_above: 3.5, unit: '%', note: 'เกณฑ์อินทรียวัตถุของ กพด. (ต่ำ <1.5, ปานกลาง 1.5–3.5, สูง >3.5)' },
  p: { low_below: 10, high_above: 25, unit: 'mg/kg', note: 'ฟอสฟอรัสที่เป็นประโยชน์ (Bray II) เกณฑ์ประเมินทั่วไป — ประมาณการ' },
  k: { low_below: 60, high_above: 90, unit: 'mg/kg', note: 'โพแทสเซียมที่แลกเปลี่ยนได้ ใช้จุดแบ่ง 60/90 mg/kg ของ กพด. — ประมาณการ' },
};
function levelOf(kind, value) {
  const c = CRITERIA[kind];
  if (!c || value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const v = Number(value);
  if (v < c.low_below) return 'low';
  if (v > c.high_above) return 'high';
  return 'medium';
}
/** N level is read from organic matter (soil N tests are unstable). */
function levelsOf(sample) {
  const t = sample.text_levels || {};
  const v = sample.values || {};
  return {
    n_level: levelOf('om', v.om) || t.n || t.om || null,
    p_level: levelOf('p', v.p) || t.p || null,
    k_level: levelOf('k', v.k) || t.k || null,
  };
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1); const dLng = toR(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function buildUrl(province) {
  const tpl = process.env.LDD_SOIL_API_URL || DEFAULT_URL;
  return tpl.includes('{province}') ? tpl.replace('{province}', encodeURIComponent(province || '')) : tpl;
}

async function fetchRows(province, { timeoutMs = 30000 } = {}) {
  const url = buildUrl(province);
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'AgroLink/1.0 (+soil fertilizer advisory)' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // undici hides the real reason in err.cause (DNS, refused, TLS chain, timeout …)
    if (err.name === 'TimeoutError') throw new Error(`ldd_timeout (${Math.round(timeoutMs / 1000)}s)`);
    const c = err.cause || {};
    throw new Error(`ldd_fetch_failed: ${[c.code, c.message].filter(Boolean).join(' — ') || err.message}`.slice(0, 280));
  }
  if (!res.ok) {
    const err = new Error(`ldd_http_${res.status}`);
    err.status = res.status;
    throw err;
  }
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error('ldd_response_too_large');
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('ldd_response_too_large');
  let json;
  try { json = JSON.parse(text.replace(/^﻿/, '')); } catch { throw new Error('ldd_not_json'); }
  const rows = extractRows(json);
  if (!rows) throw new Error('ldd_unexpected_shape');
  return { url, rows };
}

// ---------------------------------------------------------------------------
// Cache (production.ldd_soil_sample / production.ldd_soil_sync — see
// grant_fertilizer_ldd.sql). `c` is a client already inside a session.
// ---------------------------------------------------------------------------
const MAX_AGE_DAYS = 7;

async function markError(c, prov, message) {
  await c.query(
    `INSERT INTO production.ldd_soil_sync (province, fetched_at, status, error) VALUES ($1, now(), 'error', $2)
     ON CONFLICT (province) DO UPDATE SET fetched_at=now(), status='error', error=EXCLUDED.error`,
    [prov, String(message).slice(0, 300)],
  );
}

/**
 * Writes one province's rows. append=false replaces the province's cached
 * samples; append=true adds to them (used by chunked admin imports).
 * Runs in its own transaction.
 */
async function storeRows(c, prov, rows, { append = false } = {}) {
  const { samples, unmapped, used } = groupSamples(rows, prov);
  await c.query('BEGIN');
  try {
    if (!append) await c.query('DELETE FROM production.ldd_soil_sample WHERE province=$1', [prov]);
    for (let i = 0; i < samples.length; i += 500) {
      const chunk = samples.slice(i, i + 500);
      const params = [];
      const vals = chunk.map((s, j) => {
        const b = j * 14;
        params.push(s.sample_key, prov, s.amphur, s.district, s.village, s.latitude, s.longitude, s.sampled_on,
          s.values.ph ?? null, s.values.om ?? null, s.values.n ?? null, s.values.p ?? null, s.values.k ?? null,
          JSON.stringify({ ec: s.values.ec ?? null, text_levels: s.text_levels, raw: s.raw }));
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8}::date,$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13},$${b + 14}::jsonb)`;
      });
      await c.query(
        `INSERT INTO production.ldd_soil_sample
           (sample_key, province, amphur, district, village, latitude, longitude, sampled_on, ph, om_pct, n_pct, p_ppm, k_ppm, extra)
         VALUES ${vals.join(',')}
         ON CONFLICT (sample_key) DO UPDATE SET -- same point split across import chunks: merge the values
           ph=COALESCE(EXCLUDED.ph, ldd_soil_sample.ph), om_pct=COALESCE(EXCLUDED.om_pct, ldd_soil_sample.om_pct),
           n_pct=COALESCE(EXCLUDED.n_pct, ldd_soil_sample.n_pct), p_ppm=COALESCE(EXCLUDED.p_ppm, ldd_soil_sample.p_ppm),
           k_ppm=COALESCE(EXCLUDED.k_ppm, ldd_soil_sample.k_ppm),
           extra=jsonb_build_object('ec', COALESCE(EXCLUDED.extra->'ec', ldd_soil_sample.extra->'ec'),
             'text_levels', COALESCE(ldd_soil_sample.extra->'text_levels', '{}'::jsonb) || COALESCE(EXCLUDED.extra->'text_levels', '{}'::jsonb),
             'raw', COALESCE(ldd_soil_sample.extra->'raw', '{}'::jsonb) || COALESCE(EXCLUDED.extra->'raw', '{}'::jsonb)),
           fetched_at=now()`, params,
      );
    }
    const prev = append ? (await c.query('SELECT rows_received, rows_used, unmapped FROM production.ldd_soil_sync WHERE province=$1', [prov])).rows[0] : null;
    const merged = { ...((prev && prev.unmapped) || {}) };
    Object.entries(unmapped).forEach(([k, v]) => { merged[k] = (merged[k] || 0) + v; });
    const top = Object.entries(merged).sort((x, y) => y[1] - x[1]).slice(0, 30);
    const total = (await c.query('SELECT COUNT(*)::int AS n FROM production.ldd_soil_sample WHERE province=$1', [prov])).rows[0].n;
    await c.query(
      `INSERT INTO production.ldd_soil_sync (province, fetched_at, status, rows_received, rows_used, samples, unmapped, error)
       VALUES ($1, now(), 'ok', $2, $3, $4, $5::jsonb, NULL)
       ON CONFLICT (province) DO UPDATE SET fetched_at=now(), status='ok', rows_received=EXCLUDED.rows_received,
         rows_used=EXCLUDED.rows_used, samples=EXCLUDED.samples, unmapped=EXCLUDED.unmapped, error=NULL`,
      [prov, rows.length + ((prev && prev.rows_received) || 0), used + ((prev && prev.rows_used) || 0), total, JSON.stringify(Object.fromEntries(top))],
    );
    await c.query('COMMIT');
    return { rows_received: rows.length, rows_used: used, samples: total, unmapped };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function syncProvince(c, province, { timeoutMs = 30000 } = {}) {
  const prov = normProvince(province);
  let fetched;
  try {
    fetched = await fetchRows(prov, { timeoutMs });
  } catch (err) {
    await markError(c, prov, err.message);
    return { province: prov, status: 'error', error: err.message };
  }
  // the API ignores ?province= (it returns rows of every province), so keep them all
  const all = await importRows(c, fetched.rows);
  const mine = all.find((x) => x.province === prov);
  if (!mine) {
    await markError(c, prov, `ไม่มีข้อมูลของจังหวัดนี้ในผลที่ได้ (${fetched.rows.length} แถว จาก ${all.length} จังหวัด)`);
    return { province: prov, status: 'error', error: 'no_rows_for_province', rows_received: fetched.rows.length, other_provinces: all.map((x) => x.province) };
  }
  return { province: prov, status: 'ok', ...mine, rows_received_total: fetched.rows.length, provinces_updated: all.length };
}

/**
 * Admin upload of the API's JSON (saved from a browser) when the server
 * cannot reach osd101 itself. Rows without a province use `province`.
 */
async function importRows(c, rows, { province = null, append = false } = {}) {
  const byProv = new Map();
  const fallback = province ? normProvince(province) : null;
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const p = normProvince(pick(r, 'province', 'province_name', 'changwat') || '') || fallback;
    if (!p) continue;
    if (fallback && p !== fallback) continue;
    if (!byProv.has(p)) byProv.set(p, []);
    byProv.get(p).push(fallback && !pick(r, 'province', 'province_name', 'changwat') ? { ...r, province: fallback } : r);
  }
  const out = [];
  for (const [p, list] of byProv) out.push({ province: p, ...(await storeRows(c, p, list, { append })) });
  return out;
}

/** Syncs the province if it was never fetched or the copy is older than MAX_AGE_DAYS (errors retried after 1 h). */
async function ensureProvince(c, province) {
  const prov = normProvince(province);
  const s = (await c.query('SELECT status, fetched_at FROM production.ldd_soil_sync WHERE province=$1', [prov])).rows[0];
  const ageH = s ? (Date.now() - new Date(s.fetched_at).getTime()) / 3600e3 : Infinity;
  // LDD_SOIL_AUTO_FETCH=0: never call LDD from a farmer request (use admin imports only)
  if (process.env.LDD_SOIL_AUTO_FETCH === '0') return { province: prov, status: s ? s.status : 'none', cached: true };
  if (!s || (s.status === 'ok' && ageH > MAX_AGE_DAYS * 24) || (s.status === 'error' && ageH > 1)) {
    return syncProvince(c, prov, { timeoutMs: 15000 });
  }
  return { province: prov, status: s.status, cached: true };
}

/** Nearest cached samples to a point, with distance and levels. */
async function nearest(c, lat, lng, province, { limit = 5, radiusKm = 50 } = {}) {
  const prov = province ? normProvince(province) : null;
  const rows = (await c.query(
    `SELECT sample_key, province, amphur, district, village, latitude, longitude, sampled_on::text AS sampled_on,
            ph, om_pct, n_pct, p_ppm, k_ppm, extra
       FROM production.ldd_soil_sample
      WHERE ($1::text IS NULL OR province=$1)
        AND latitude BETWEEN $2::float8 - 1 AND $2::float8 + 1 AND longitude BETWEEN $3::float8 - 1 AND $3::float8 + 1`,
    [prov, lat, lng],
  )).rows;
  return rows
    .map((r) => {
      const values = {
        ph: r.ph === null ? undefined : Number(r.ph), om: r.om_pct === null ? undefined : Number(r.om_pct),
        p: r.p_ppm === null ? undefined : Number(r.p_ppm), k: r.k_ppm === null ? undefined : Number(r.k_ppm),
      };
      const textLevels = (r.extra && r.extra.text_levels) || {};
      return {
        ...r,
        ph: values.ph ?? null,
        om_pct: values.om ?? null,
        p_ppm: values.p ?? null,
        k_ppm: values.k ?? null,
        distance_km: Math.round(haversineKm(lat, lng, Number(r.latitude), Number(r.longitude)) * 10) / 10,
        levels: levelsOf({ values, text_levels: textLevels }),
      };
    })
    .filter((r) => r.distance_km <= radiusKm)
    // closer first; among samples within 2 km of each other, newer first
    .sort((a, b) => (Math.abs(a.distance_km - b.distance_km) < 2 ? String(b.sampled_on).localeCompare(String(a.sampled_on)) : a.distance_km - b.distance_km))
    .slice(0, limit);
}

module.exports = {
  stripHtml, classifyParameter, parseNumber, parseDate, parseLevelText, extractRows, groupSamples,
  levelOf, levelsOf, haversineKm, buildUrl, fetchRows, syncProvince, importRows, storeRows, ensureProvince, nearest, normProvince, CRITERIA,
  LINKS: {
    eservice: 'https://osd101.ldd.go.th',
    soil_card: 'http://iddindee.ldd.go.th',
    dataset: 'https://lddcatalog.ldd.go.th/en/dataset/osd01',
  },
};
