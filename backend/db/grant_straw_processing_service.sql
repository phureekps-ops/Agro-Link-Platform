-- grant_straw_processing_service.sql
--
-- Adds two more rate-card line items to the existing unified machinery/
-- drying-yard provider portal (src/routes/machinery.js) — requested
-- directly by the user:
--   * เครื่องอัดเม็ดฟางข้าว (rice-straw PELLET press — compresses loose straw
--     into small fuel/feed pellets)
--   * เครื่องอัดก้อนฟางข้าว (rice-straw BALER — compresses loose straw into
--     large bales for storage/transport/resale)
-- These are two distinct machines/services, not one item with two names —
-- a provider may own either, both, or neither.
--
-- Reuses every piece of existing infrastructure rather than adding
-- anything new: the same machinery/drying-yard org_types (MachineryService
-- and its four pre-consolidation legacy values, plus DryingYardService)
-- already cover "a provider who owns farm equipment for hire" broadly
-- enough that straw pelletizing/baling doesn't need its own org_type or
-- its own booking table — both slot into marketplace.service_listing /
-- marketplace.machinery_booking exactly like the existing seven items
-- (plow_rough, plow_secondary_seed, rotary_till, spraying, harvesting,
-- trucking, drying).
--
-- Only two CHECK constraints need widening — additive drop-and-re-add
-- pattern used for every prior addition to this table (see grant_
-- fertilizer_mixing_service.sql's own comment for the identical
-- reasoning; this migration must repeat every value that file's widening
-- already added, since these constraints are replaced wholesale each time,
-- not incrementally):
--   * service_type gets a new 'straw_processing' bucket, shared by both new
--     items — post-harvest handling of the crop's straw BYPRODUCT is
--     distinct enough from drying_storage (which is about the farmer's own
--     harvested grain/produce) to warrant its own category rather than
--     being folded into an existing one.
--   * service_key gets two new values: 'straw_pelletizing' and
--     'straw_baling'.
-- No new table, no new org_type: the ON CONFLICT (org_id, service_key)
-- partial unique index PUT /machinery/rate-card upserts against already
-- covers any service_key (it is not scoped per service_type), so nothing
-- else in the schema needs to change.
ALTER TABLE marketplace.service_listing DROP CONSTRAINT IF EXISTS service_listing_service_type_check;
ALTER TABLE marketplace.service_listing ADD CONSTRAINT service_listing_service_type_check
  CHECK (service_type = ANY (ARRAY[
    'land_preparation', 'harvesting', 'pest_control', 'transport', 'drying_storage',
    'fertilizer_mixing', 'straw_processing', 'other'
  ]));

ALTER TABLE marketplace.service_listing DROP CONSTRAINT IF EXISTS service_listing_service_key_check;
ALTER TABLE marketplace.service_listing ADD CONSTRAINT service_listing_service_key_check
  CHECK (service_key IS NULL OR service_key IN (
    'plow_rough', 'plow_secondary_seed', 'rotary_till', 'spraying', 'harvesting', 'trucking', 'drying',
    'fertilizer_custom_mix', 'straw_pelletizing', 'straw_baling'
  ));
