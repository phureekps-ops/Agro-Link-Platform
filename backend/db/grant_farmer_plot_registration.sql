-- ============================================================================
-- AgroLink Platform — Backend API Gateway: Farmer Plot/Production-Unit
-- Self-Registration Grant
-- ============================================================================
-- Added 2026-08-23. Until now, registry.production_unit (the table behind
-- "แปลง / หน่วยผลิต" — one row per plot/pen/pond/orchard per production
-- cycle) had ONLY a GET /farmer/production-units read endpoint
-- (grant_farmer_portal_reads.sql — SELECT only). Every farmer/coop/buyer/
-- lender route across the whole codebase only ever JOINs or SELECTs this
-- table; nothing could create a new row through the API. The only rows
-- that ever existed came from dev_sample_data.sql's raw COPY, which is
-- deliberately never run against production — so a real farmer had no way
-- to register their own plot at all.
--
-- This adds POST /farmer/production-units, following the same pattern as
-- underwriting.submit_application() (see 02_full_schema.sql): a single
-- SECURITY DEFINER function that does its own validation (farmer exists,
-- commodity_code is a real registry.commodity_ref row, the GPS boundary
-- parses as a valid GeoJSON Polygon, area_rai is positive) before
-- inserting — rather than granting agrolink_app raw INSERT on the table
-- and trusting the Node layer alone. owner_farmer_id is a function
-- parameter, but exactly like submit_application()'s p_farmer_id, the
-- Node route ALWAYS passes req.subject's id here, never anything read
-- from the request body — so a farmer can only ever register a plot as
-- themselves.
-- ============================================================================

CREATE OR REPLACE FUNCTION registry.register_production_unit(
    p_farmer_id uuid,
    p_unit_type text,
    p_gps_boundary_geojson text,
    p_area_rai numeric,
    p_commodity_code text,
    p_season_id text
) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_unit_id uuid;
  v_geom geometry;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM identity.farmer WHERE farmer_id = p_farmer_id) THEN
    RAISE EXCEPTION 'ไม่พบเกษตรกรรหัส %', p_farmer_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM registry.commodity_ref WHERE commodity_code = p_commodity_code) THEN
    RAISE EXCEPTION 'ไม่พบรหัสพืช/สัตว์เศรษฐกิจ %', p_commodity_code;
  END IF;

  IF p_area_rai IS NULL OR p_area_rai <= 0 THEN
    RAISE EXCEPTION 'พื้นที่ (ไร่) ต้องมากกว่า 0';
  END IF;

  BEGIN
    v_geom := ST_SetSRID(ST_GeomFromGeoJSON(p_gps_boundary_geojson), 4326);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'รูปแบบขอบเขต GPS ไม่ถูกต้อง (ต้องเป็น GeoJSON Polygon)';
  END;

  IF v_geom IS NULL OR GeometryType(v_geom) <> 'POLYGON' THEN
    RAISE EXCEPTION 'ขอบเขต GPS ต้องเป็นรูปหลายเหลี่ยม (Polygon) อย่างน้อย 3 จุด';
  END IF;

  IF NOT ST_IsValid(v_geom) THEN
    RAISE EXCEPTION 'ขอบเขต GPS ที่วาดไม่ถูกต้องตามหลักเรขาคณิต (เส้นขอบเขตตัดกันเอง) กรุณาวาดใหม่';
  END IF;

  INSERT INTO registry.production_unit
    (owner_farmer_id, unit_type, gps_boundary, area_rai, commodity_code, season_id)
  VALUES
    (p_farmer_id, p_unit_type, v_geom, p_area_rai, p_commodity_code, p_season_id)
  RETURNING unit_id INTO v_unit_id;

  RETURN v_unit_id;
END;
$$;

COMMENT ON FUNCTION registry.register_production_unit IS
  'ให้เกษตรกรลงทะเบียนแปลง/หน่วยผลิตของตนเอง (Plot/Pen/Pond/Orchard) ด้วยตนเองผ่าน POST /farmer/production-units — แทนที่จะต้องรอ seed ข้อมูลจากฝั่งเซิร์ฟเวอร์เท่านั้น';

GRANT EXECUTE ON FUNCTION registry.register_production_unit(uuid, text, text, numeric, text, text) TO agrolink_app;
