-- grant_laser_land_leveling_service.sql
--
-- Adds one more rate-card line item to the existing unified machinery/
-- drying-yard provider portal (src/routes/machinery.js) — requested
-- directly by the user:
--   * ปรับพื้นที่แปลงนาด้วยระบบเลเซอร์ (laser-guided precision land leveling —
--     grading a paddy field flat using GPS/laser-controlled equipment, so
--     water depth stays even across the whole plot)
--
-- Unlike grant_straw_processing_service.sql (which needed a brand-new
-- service_type bucket), this one is fundamentally a LAND-PREPARATION
-- activity — same category as the existing plow_rough / plow_secondary_
-- seed / rotary_till items — so it reuses the service_type = 'land_
-- preparation' value that's already valid in the CHECK constraint.
-- Nothing needs to change there. It also means no frontend filter-dropdown
-- edits are needed anywhere (frontend/machinery-marketplace.html and
-- frontend/admin/featured-listings.html both already have a
-- "land_preparation" filter option that this new item automatically falls
-- under).
--
-- Only the service_key CHECK constraint needs widening — additive
-- drop-and-re-add pattern used for every prior addition to this table
-- (see grant_straw_processing_service.sql's own comment for the identical
-- reasoning; this migration must repeat every value that file's widening
-- already added, since this constraint is replaced wholesale each time,
-- not incrementally):
--   * service_key gets one new value: 'laser_land_leveling'.
-- No new table, no new org_type, no service_type change: the
-- ON CONFLICT (org_id, service_key) partial unique index PUT
-- /machinery/rate-card upserts against already covers any service_key (it
-- is not scoped per service_type), so nothing else in the schema needs to
-- change.
ALTER TABLE marketplace.service_listing DROP CONSTRAINT IF EXISTS service_listing_service_key_check;
ALTER TABLE marketplace.service_listing ADD CONSTRAINT service_listing_service_key_check
  CHECK (service_key IS NULL OR service_key IN (
    'plow_rough', 'plow_secondary_seed', 'rotary_till', 'spraying', 'harvesting', 'trucking', 'drying',
    'fertilizer_custom_mix', 'straw_pelletizing', 'straw_baling', 'laser_land_leveling'
  ));
