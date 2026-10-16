-- ============================================================================
-- AgroLink -- P4 (RAP-T readiness roadmap): farm/cage management module for
-- the 4 caged-fish value chains (TILAPIA_CAGE, TILAPIA_RED_CAGE,
-- SEABASS_CAGE, GROUPER_CAGE -- see grant_rapt_commodity_codes.sql, which
-- registered these 4 commodity_ref rows, and grant_rapt_stage_templates.sql,
-- which seeded their 5-stage grow-out calendar).
--
-- Scope check done BEFORE writing this migration (see the chat reply this
-- commit accompanies for the full reasoning): P4 asks for "farm/orchard/cage
-- MANAGEMENT" for each value chain, not a full commercial module per chain.
-- Of the 6 RAP-T value chains that needed something built here:
--   - DURIAN / CORN_FEED (already registry+calendar only, no change needed)
--   - COFFEE / COCONUT_AROMATIC: tree crops. registry.farmer_plot_
--     registration() (register_production_unit()) is already commodity-
--     agnostic, and POST /farmer/production-units (frontend: register-
--     plot.html) already lets ANY commodity_code register an 'Orchard'
--     unit today -- COFFEE and COCONUT_AROMATIC existing in commodity_ref
--     (grant_rapt_commodity_codes.sql) is the only thing that was missing,
--     and that migration already shipped. NO code change needed here for
--     these two -- confirmed by reading register-plot.html/.js: unit_type
--     and commodity_code are two independent dropdowns, so the generic
--     plot-registration flow was never actually shrimp/rice-specific.
--   - TILAPIA_CAGE / TILAPIA_RED_CAGE / SEABASS_CAGE / GROUPER_CAGE: THIS is
--     the real gap this migration closes. aquaculture.farm_profile
--     (grant_shrimp_auction.sql) is already structurally generic (farmer_
--     id/farm_name/province/district/phone -- no species column at all),
--     so it needs no change and is reused as-is for cage farmers. The real
--     blocker is registry.production_unit.unit_type's CHECK constraint,
--     which only allows ('Plot','Pen','Pond','Orchard') -- none of which
--     correctly describes a floating net cage in a river/reservoir/
--     irrigation canal (the actual RAP-T ปลานิล/ปลาทับทิม/ปลากระพง/ปลาเก๋า
--     practice), and POST /aquaculture/ponds (src/routes/aquaculture.js) is
--     hard-gated to SHRIMP_COMMODITY_CODES + unit_type='Pond', so it
--     rejects these 4 species outright today.
--
-- Fix: widen the CHECK constraint to add 'Cage' as a 5th allowed unit_type
-- (purely additive -- every existing row keeps its current value, nothing
-- is renamed or migrated). src/routes/aquaculture.js then gets a new
-- POST/GET /cages pair, a near-identical sibling of POST/GET /ponds, gated
-- to the 4 fish commodity_codes and unit_type='Cage' instead of 'Pond'.
--
-- Deliberately NOT built in this pass (same "don't extend past what was
-- asked" discipline as the stage_template migration): sampling, auction,
-- and settlement for these 4 species. SHRIMP_AUCTION_ARCHITECTURE.md's
-- sealed-bid/forward-auction flow (aquaculture.sampling_event/
-- auction_size_tier/shrimp_auction/harvest_settlement) is a whole separate
-- commercial-marketplace feature built specifically around shrimp's size-
-- grading economics, not something "farm/cage management" (P4's literal
-- scope) implies on its own. A cage farmer registered through this
-- migration's new routes can track their farm profile and their cages
-- (grow-out units), and -- via the ALREADY-GENERIC production.crop_cycle/
-- stage_calendar mechanism, keyed only by unit_id + commodity_code, no
-- schema change needed -- their 5-stage grow-out calendar. Whether/how
-- caged fish eventually get their own auction-style sales channel is a
-- separate future decision, not assumed here.
--
-- No new table. Re-runnable (DROP CONSTRAINT IF EXISTS before ADD).
-- ============================================================================

ALTER TABLE registry.production_unit
  DROP CONSTRAINT IF EXISTS production_unit_unit_type_check;

ALTER TABLE registry.production_unit
  ADD CONSTRAINT production_unit_unit_type_check
  CHECK (unit_type = ANY (ARRAY['Plot'::text, 'Pen'::text, 'Pond'::text, 'Orchard'::text, 'Cage'::text]));

COMMENT ON CONSTRAINT production_unit_unit_type_check ON registry.production_unit IS
  'Plot=แปลงนา/ไร่นา, Pen=คอกเลี้ยงสัตว์, Pond=บ่อเลี้ยง(ขุดดิน), Orchard=สวนผลไม้, Cage=กระชังเลี้ยงปลา(ลอยน้ำ) -- Cage added for the 4 RAP-T caged-fish commodities (grant_cage_fish_farm_management.sql); for a Cage row, production_unit.area_rai holds the cage''s water volume in ลูกบาศก์เมตร (m3), not land area in ไร่ -- same column-reuse-across-unit-types pattern already used for Pen (livestock headcount context) and Orchard.';
