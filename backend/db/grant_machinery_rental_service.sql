-- grant_machinery_rental_service.sql
--
-- Adds one more rate-card line item to the existing unified machinery/
-- drying-yard provider portal (src/routes/machinery.js) — requested
-- directly by the user:
--   * ให้เช่าเครื่องจักรกลการเกษตร (bare equipment rental — the provider just
--     lends out the machine itself, billed per day; NOT an operator-
--     performed job like the other 11 items, which are all "we bring the
--     machine and do the work for you" services)
--
-- Despite being a different kind of arrangement (rental vs. operated
-- service), it still fits the existing fixed-key rate-card shape
-- perfectly fine — one row per (org_id, service_key), a Thai label, and a
-- price_unit, exactly like every other item. It doesn't cleanly belong to
-- any of the existing specific buckets (land_preparation / harvesting /
-- pest_control / transport / drying_storage / fertilizer_mixing /
-- straw_processing all describe a specific JOB, not "renting the tool"),
-- so this reuses the pre-existing generic 'other' service_type bucket
-- rather than adding a new one — keeps this migration to a single CHECK
-- constraint widening, no service_type change, and no frontend filter-
-- dropdown edits needed (the "ทั้งหมด/all" option in both
-- frontend/machinery-marketplace.html and frontend/admin/dashboard.html's
-- featured-listings filter already surfaces 'other' rows; neither dropdown
-- has ever had a dedicated 'other' filter option — a pre-existing gap,
-- not something introduced by this migration).
--
-- Only the service_key CHECK constraint needs widening — additive
-- drop-and-re-add pattern used for every prior addition to this table
-- (see grant_laser_land_leveling_service.sql's own comment for the
-- identical reasoning; this migration must repeat every value that file's
-- widening already added, since this constraint is replaced wholesale
-- each time, not incrementally):
--   * service_key gets one new value: 'machinery_rental'.
-- No new table, no new org_type, no service_type change: the
-- ON CONFLICT (org_id, service_key) partial unique index PUT
-- /machinery/rate-card upserts against already covers any service_key (it
-- is not scoped per service_type), so nothing else in the schema needs to
-- change.
ALTER TABLE marketplace.service_listing DROP CONSTRAINT IF EXISTS service_listing_service_key_check;
ALTER TABLE marketplace.service_listing ADD CONSTRAINT service_listing_service_key_check
  CHECK (service_key IS NULL OR service_key IN (
    'plow_rough', 'plow_secondary_seed', 'rotary_till', 'spraying', 'harvesting', 'trucking', 'drying',
    'fertilizer_custom_mix', 'straw_pelletizing', 'straw_baling', 'laser_land_leveling', 'machinery_rental'
  ));
