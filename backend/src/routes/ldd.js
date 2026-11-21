const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireFarmer, requirePlatform } = require('../middleware/auth');
const ldd = require('../lib/lddSoil');
const { TH_PROVINCE_NAME } = require('../lib/thProvinces');

/**
 * ข้อมูลดินกรมพัฒนาที่ดิน (กพด.) สำหรับปุ๋ยสั่งตัด — see lib/lddSoil.js and
 * db/grant_fertilizer_ldd.sql.
 *
 *  farmer  GET  /farmer/ldd/soil-nearby?unit_id=&province_code=TH-xx
 *               nearest LDD soil-analysis points to the plot's centroid,
 *               with levels ready for POST /farmer/soil-tests (source ldd_nearby)
 *  admin   GET  /admin/ldd/status          sync state per province
 *          POST /admin/ldd/sync {province_code}  fetch now; shows unmapped parameter names
 *
 * Both routers are mounted in server.js BEFORE '/farmer' and '/admin'.
 */
const farmer = express.Router();
const admin = express.Router();
farmer.use(requireAuth, requireFarmer);
admin.use(requireAuth, requirePlatform);

const NOT_INSTALLED = '42P01';
const provinceName = (code) => TH_PROVINCE_NAME[String(code || '').trim()] || null;

farmer.get('/soil-nearby', async (req, res, next) => {
  const { subjectId } = req.subject;
  const unitId = req.query.unit_id;
  if (!unitId) return res.status(400).json({ error: 'missing_required_query_param', required: ['unit_id'] });
  try {
    const out = await withSessionContext('farmer', subjectId, async (c) => {
      const unit = (await c.query(
        `SELECT unit_id, area_rai, commodity_code,
                ST_Y(ST_Centroid(gps_boundary)) AS lat, ST_X(ST_Centroid(gps_boundary)) AS lng
           FROM registry.production_unit WHERE unit_id = $1 AND owner_farmer_id = $2`,
        [unitId, subjectId],
      ).catch((e) => { if (e.code === '22P02') return { rows: [] }; throw e; })).rows[0];
      if (!unit) return { status: 404, body: { error: 'production_unit_not_found' } };

      let code = req.query.province_code;
      if (!code) code = (await c.query('SELECT region_code FROM identity.farmer WHERE farmer_id=$1', [subjectId])).rows[0]?.region_code;
      const prov = provinceName(code);
      if (!prov) return { status: 400, body: { error: 'province_required', detail: 'เลือกจังหวัดของแปลง' } };

      const sync = await ldd.ensureProvince(c, prov);
      const samples = await ldd.nearest(c, Number(unit.lat), Number(unit.lng), prov);
      await logAccess(c, 'read', 'production.ldd_soil_sample', null);
      return {
        status: 200,
        body: {
          unit: { unit_id: unit.unit_id, lat: Number(unit.lat), lng: Number(unit.lng) },
          province_code: code,
          province: prov,
          sync: { status: sync.status, cached: !!sync.cached, error: sync.error || null },
          samples,
          criteria: ldd.CRITERIA,
          source: {
            name: 'กรมพัฒนาที่ดิน — ชุดข้อมูลการตรวจวิเคราะห์ดิน (osd01)', licence: 'Creative Commons Attributions', url: ldd.LINKS.dataset,
          },
          links: ldd.LINKS,
          note: 'ค่าดินจากจุดเก็บตัวอย่างของ กพด. ที่ใกล้แปลงที่สุด ไม่ใช่ดินในแปลงของท่านเอง ใช้ประมาณการได้ แต่ผลตรวจดินของแปลงเอง (แล็บ กพด. หรือ Test Kit) แม่นยำกว่า',
        },
      };
    });
    return res.status(out.status).json(out.body);
  } catch (err) {
    if (err.code === NOT_INSTALLED) return res.status(503).json({ error: 'ldd_not_installed' });
    return next(err);
  }
});

admin.get('/status', async (req, res, next) => {
  try {
    const rows = await withSessionContext('platform', req.subject.subjectId, async (c) => (await c.query(
      `SELECT s.*, (SELECT COUNT(*)::int FROM production.ldd_soil_sample x WHERE x.province=s.province) AS cached_samples
         FROM production.ldd_soil_sync s ORDER BY s.fetched_at DESC`,
    )).rows);
    return res.json({ api_url_template: process.env.LDD_SOIL_API_URL || 'https://osd101.ldd.go.th/api/data.php?province={province}', provinces: rows, links: ldd.LINKS });
  } catch (err) {
    if (err.code === NOT_INSTALLED) return res.status(503).json({ error: 'ldd_not_installed' });
    return next(err);
  }
});

admin.post('/sync', async (req, res, next) => {
  const prov = provinceName((req.body || {}).province_code);
  if (!prov) return res.status(400).json({ error: 'invalid_province_code' });
  try {
    const out = await withSessionContext('platform', req.subject.subjectId, (c) => ldd.syncProvince(c, prov));
    return res.json({ ...out, url: ldd.buildUrl(prov) });
  } catch (err) {
    if (err.code === NOT_INSTALLED) return res.status(503).json({ error: 'ldd_not_installed' });
    return next(err);
  }
});

module.exports = { farmer, admin };
