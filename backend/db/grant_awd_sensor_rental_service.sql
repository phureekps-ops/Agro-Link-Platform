-- grant_awd_sensor_rental_service.sql
--
-- Adds one more rate-card line item to the existing unified machinery/
-- drying-yard provider portal (src/routes/machinery.js) — requested
-- directly by the user:
--   * ให้เช่าเซนเซอร์วัดระดับน้ำนาเปียก/แห้ง (AWD) — renting out water-level
--     sensors used for Alternate Wetting and Drying (AWD) monitoring in
--     rice paddies (the same wet/dry cycle measurement the Carbon Module's
--     AWD assessment queue relies on — see carbon.carbon_project /
--     grant_carbon_module_portal_aggregation.sql). This item is purely
--     about the machinery-service portal's own rate card (a provider
--     listing that they rent out the physical sensor hardware); it does
--     not touch the Carbon Module's own AWD evidence/observation tables
--     in any way.
--
-- Like grant_machinery_rental_service.sql's item, this is bare equipment
-- rental (the provider just lends out the sensor hardware, no operator
-- performing a job) rather than an operator-performed service like most
-- of the other rate-card items, so it doesn't cleanly belong to any of
-- the existing specific buckets (land_preparation / harvesting /
-- pest_control / transport / drying_storage / fertilizer_mixing /
-- straw_processing all describe a specific JOB) — it reuses the
-- pre-existing generic 'other' service_type bucket, exactly like
-- machinery_rental did. No new service_type, no frontend filter-dropdown
-- edits needed (same reasoning as grant_machinery_rental_service.sql's own
-- comment: the "ทั้งหมด/all" option in both
-- frontend/machinery-marketplace.html and frontend/admin/dashboard.html's
-- featured-listings filter already surfaces 'other' rows).
--
-- Only the service_key CHECK constraint needs widening — additive
-- drop-and-re-add pattern used for every prior addition to this table
-- (see grant_machinery_rental_service.sql's own comment for the identical
-- reasoning; this migration must repeat every value that file's widening
-- already added, since this constraint is replaced wholesale each time,
-- not incrementally):
--   * service_key gets one new value: 'awd_sensor_rental'.
-- No new table, no new org_type, no service_type change: the
-- ON CONFLICT (org_id, service_key) partial unique index PUT
-- /machinery/rate-card upserts against already covers any service_key (it
-- is not scoped per service_type), so nothing else in the schema needs to
-- change.
ALTER TABLE marketplace.service_listing DROP CONSTRAINT IF EXISTS service_listing_service_key_check;
ALTER TABLE marketplace.service_listing ADD CONSTRAINT service_listing_service_key_check
  CHECK (service_key IS NULL OR service_key IN (
    'plow_rough', 'plow_secondary_seed', 'rotary_till', 'spraying', 'harvesting', 'trucking', 'drying',
    'fertilizer_custom_mix', 'straw_pelletizing', 'straw_baling', 'laser_land_leveling', 'machinery_rental',
    'awd_sensor_rental'
  ));
