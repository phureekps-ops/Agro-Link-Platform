-- ============================================================================
-- AgroLink Platform — Backend API Gateway: ประกาศรับซื้อด่วน (Flash Buy
-- Campaign) — จำกัดจำนวน
-- ============================================================================
-- User request (2026-09-06): "ผู้รับซื้อผลผลิตให้สามารถประกาศราคารับซื้อได้
-- และจำกัดจำนวนการรับซื้อได้สำหรับราคานั้น และเมื่อซื้อได้ครบจำนวนแล้วก็ไม่
-- สามารถรับซื้อได้อีก ต้องตั้งประกาศใหม่ (ใช้สำหรับผู้ซื้อต้องการเร่งซื้อ
-- ผลผลิตเข้าสต๊อกในช่วงเวลาสั้นๆ)" — a Buyer org announces a buy price for
-- a commodity capped at a maximum quantity; once fully filled, the
-- announcement auto-closes and the buyer must open a new one to keep
-- buying. Also required (same request, follow-up message): every farmer-
-- and buyer-facing display of this price must state it applies ONLY to
-- sales completed through this online system — not usable as a reference/
-- justification for in-person sales at a yard (ลานรับซื้อ) or mill gate
-- (หน้าโรงงาน). That disclaimer is UI-only text (both buy-campaigns.html
-- and the buyer's create-campaign form), not a DB column — there's nothing
-- to query or filter on, it's a fixed legal/scope notice.
--
-- Two scoping questions were asked and answered before writing this:
--  1. Commodity scope: ALL commodities (registry.commodity_ref), not just
--     rice grades — unlike marketplace.buy_price_quote (which is rice-only
--     and has no quantity cap / auto-close; that feature stays unchanged
--     and serves a different purpose: a standing daily price board for
--     comparison, not a time-boxed capped buying campaign).
--  2. Selling mechanism: when a farmer sells into an open campaign, the
--     system deducts the quantity IMMEDIATELY (no buyer confirm/reject
--     step first) — matches the buyer's stated need for speed ("เร่งซื้อ
--     ...ช่วงเวลาสั้นๆ"). This reuses produce.record_delivery() (see
--     grant_buyer_portal.sql) to create a normal produce.delivery row at
--     the campaign's price — the farmer's produce still has to be
--     physically delivered and the buyer still runs it through the SAME
--     existing quality-confirm + settle pipeline as every other spot sale
--     (POST /buyer/deliveries/:id/confirm-quality, /settle). This feature
--     only automates the "commit to sell at this price, up to this much"
--     step and its quantity bookkeeping — it does not change how payment
--     or physical handoff work.
--
-- Design decision — one PL/pgSQL function for the whole sell-in
-- transaction (marketplace.sell_into_buy_campaign), same reasoning as
-- produce.record_delivery()/confirm_quality()/settle_delivery(): keeps the
-- "lock the campaign row, validate remaining quantity, insert the
-- delivery, insert the fill record, update the running total, auto-close
-- if full" sequence atomic and in ONE place rather than split across
-- route-layer queries (which would risk a race between two farmers
-- selling into the last bit of remaining quantity at the same time).
-- `SELECT ... FOR UPDATE` on the campaign row is what actually prevents
-- that race — two concurrent calls serialize on that lock, so the second
-- one always sees the already-decremented quantity_sold_ton.
--
-- Not SECURITY DEFINER: same reasoning as record_delivery()/
-- confirm_quality() in grant_buyer_portal.sql — it doesn't touch any
-- FORCE-RLS table, it just needs direct grants since it runs with the
-- caller's (agrolink_app's) own privileges (produce.delivery and
-- registry.production_unit already have no RLS at all — explicit WHERE/
-- ownership checks ARE the security boundary, same convention as every
-- other marketplace.*/produce.* table in this codebase).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. marketplace.buy_campaign — one row per "ประกาศรับซื้อด่วน".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.buy_campaign (
  campaign_id         uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  org_id              uuid NOT NULL REFERENCES identity.organization(org_id),
  commodity_code      text NOT NULL REFERENCES registry.commodity_ref(commodity_code),
  unit_price          numeric(18,2) NOT NULL,
  price_unit          text NOT NULL DEFAULT 'บาท/ตัน',
  quantity_limit_ton  numeric(12,3) NOT NULL,
  quantity_sold_ton   numeric(12,3) NOT NULL DEFAULT 0,
  status              text NOT NULL DEFAULT 'open',
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz,
  CONSTRAINT buy_campaign_unit_price_check CHECK (unit_price > 0),
  CONSTRAINT buy_campaign_quantity_limit_check CHECK (quantity_limit_ton > 0),
  CONSTRAINT buy_campaign_quantity_sold_check CHECK (quantity_sold_ton >= 0),
  CONSTRAINT buy_campaign_quantity_bounds_check CHECK (quantity_sold_ton <= quantity_limit_ton),
  CONSTRAINT buy_campaign_status_check CHECK (status IN ('open', 'closed'))
);

CREATE INDEX IF NOT EXISTS idx_buy_campaign_org ON marketplace.buy_campaign (org_id);
CREATE INDEX IF NOT EXISTS idx_buy_campaign_status ON marketplace.buy_campaign (status);

-- ---------------------------------------------------------------------------
-- 2. marketplace.buy_campaign_order — one row per farmer sell-in against a
--    campaign. Links to the produce.delivery row that the sell-in created,
--    so a farmer's "ประวัติการขายของฉัน" can show the delivery's real
--    status (delivered/accepted/rejected/settled) rather than duplicating
--    it. No RLS — same explicit-WHERE convention as produce.delivery /
--    marketplace.product_order.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.buy_campaign_order (
  order_id      uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  campaign_id   uuid NOT NULL REFERENCES marketplace.buy_campaign(campaign_id),
  farmer_id     uuid NOT NULL REFERENCES identity.farmer(farmer_id),
  unit_id       uuid NOT NULL REFERENCES registry.production_unit(unit_id),
  delivery_id   uuid NOT NULL REFERENCES produce.delivery(delivery_id),
  quantity_ton  numeric(12,3) NOT NULL,
  unit_price    numeric(18,2) NOT NULL,
  total_amount  numeric(18,2) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT buy_campaign_order_quantity_check CHECK (quantity_ton > 0),
  CONSTRAINT buy_campaign_order_unit_price_check CHECK (unit_price > 0),
  CONSTRAINT buy_campaign_order_total_amount_check CHECK (total_amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_buy_campaign_order_campaign ON marketplace.buy_campaign_order (campaign_id);
CREATE INDEX IF NOT EXISTS idx_buy_campaign_order_farmer ON marketplace.buy_campaign_order (farmer_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. marketplace.sell_into_buy_campaign() — the whole sell-in transaction,
--    atomically. Raises plain RAISE EXCEPTION with Thai messages on
--    business-rule violations, same convention as produce.record_delivery/
--    confirm_quality — the calling route matches on message substrings to
--    turn these into structured 4xx responses instead of a generic 500.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION marketplace.sell_into_buy_campaign(
  p_campaign_id uuid,
  p_farmer_id uuid,
  p_unit_id uuid,
  p_quantity_ton numeric
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_org_id         uuid;
  v_commodity_code text;
  v_unit_price     numeric(18,2);
  v_limit          numeric(12,3);
  v_sold           numeric(12,3);
  v_status         text;
  v_remaining      numeric(12,3);
  v_new_sold       numeric(12,3);
  v_delivery_id    uuid;
  v_order_id       uuid;
BEGIN
  IF p_quantity_ton IS NULL OR p_quantity_ton <= 0 THEN
    RAISE EXCEPTION 'จำนวนที่ต้องการขายต้องมากกว่า 0';
  END IF;

  -- FOR UPDATE locks this campaign row for the rest of the transaction —
  -- a second concurrent sell-in against the same campaign blocks here
  -- until this one commits, so quantity_sold_ton is always read after the
  -- previous sell-in's update, never a stale value. This is what actually
  -- prevents overselling past quantity_limit_ton under concurrent farmers.
  SELECT org_id, commodity_code, unit_price, quantity_limit_ton, quantity_sold_ton, status
    INTO v_org_id, v_commodity_code, v_unit_price, v_limit, v_sold, v_status
    FROM marketplace.buy_campaign
   WHERE campaign_id = p_campaign_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบประกาศรับซื้อ %', p_campaign_id;
  END IF;
  IF v_status <> 'open' THEN
    RAISE EXCEPTION 'ประกาศรับซื้อ % ปิดรับซื้อแล้ว ไม่สามารถขายเข้าประกาศนี้ได้อีก', p_campaign_id;
  END IF;

  v_remaining := v_limit - v_sold;
  IF p_quantity_ton > v_remaining THEN
    RAISE EXCEPTION 'จำนวนที่ต้องการขาย (%) เกินจำนวนคงเหลือของประกาศนี้ (% ตัน)', p_quantity_ton, v_remaining;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM registry.production_unit WHERE unit_id = p_unit_id AND owner_farmer_id = p_farmer_id
  ) THEN
    RAISE EXCEPTION 'แปลง/หน่วยผลิต % ไม่ใช่ของเกษตรกรรายนี้', p_unit_id;
  END IF;

  -- Spot-sale delivery at the campaign's fixed price — no contract_id,
  -- same as any other Spot Sale via POST /buyer/deliveries.
  v_delivery_id := produce.record_delivery(p_unit_id, v_org_id, v_commodity_code, p_quantity_ton, NULL, NULL, v_unit_price);

  INSERT INTO marketplace.buy_campaign_order
    (campaign_id, farmer_id, unit_id, delivery_id, quantity_ton, unit_price, total_amount)
  VALUES
    (p_campaign_id, p_farmer_id, p_unit_id, v_delivery_id, p_quantity_ton, v_unit_price, p_quantity_ton * v_unit_price)
  RETURNING order_id INTO v_order_id;

  v_new_sold := v_sold + p_quantity_ton;
  UPDATE marketplace.buy_campaign
     SET quantity_sold_ton = v_new_sold,
         status = CASE WHEN v_new_sold >= v_limit THEN 'closed' ELSE 'open' END,
         closed_at = CASE WHEN v_new_sold >= v_limit THEN now() ELSE closed_at END
   WHERE campaign_id = p_campaign_id;

  RETURN v_order_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Grants — agrolink_app is the sole application role (see every other
--    grant_*.sql). GRANT EXECUTE is listed explicitly even though recent
--    functions in this codebase have not always needed it (see
--    grant_cooperative_finance_dashboard.sql's note on this), to avoid any
--    ambiguity — matches the more recent explicit-grant convention (e.g.
--    grant_b2b_commerce_engine.sql).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON marketplace.buy_campaign TO agrolink_app;
GRANT SELECT, INSERT ON marketplace.buy_campaign_order TO agrolink_app;
GRANT EXECUTE ON FUNCTION marketplace.sell_into_buy_campaign(uuid, uuid, uuid, numeric) TO agrolink_app;
