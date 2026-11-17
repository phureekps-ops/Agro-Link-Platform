-- grant_plot_ai.sql — AgroLink SatAI กลุ่มที่ 1 (แกนโครงการ NIA T69-10-239)
--
-- Adds the storage side of the plot AI in src/lib/plotAI.js /
-- src/lib/plotAIService.js / src/routes/plotai.js:
--
--   ai.crop_profile        reference values per crop class (typical and
--                          maximum yield, reference NDVI peak, days from
--                          peak to harvest). Seeded with APPROXIMATE Thai
--                          averages — Platform Ops should check them against
--                          สศก. figures and edit them (PUT /admin/plot-ai/
--                          crop-profiles/:crop). They drive the baseline
--                          yield forecast and the "impossible yield" check.
--   ai.ground_truth        what a farmer / cooperative / field survey
--                          CONFIRMED a plot grows (+ planting/harvest dates).
--                          This is the training label for the crop
--                          classifier — the data competitors do not have.
--   ai.model               every training run of the crop classifier and the
--                          per-crop yield forecaster, with its cross-
--                          validation metrics. A run only becomes active
--                          (is_active) when it beats the rule/baseline method
--                          on held-out data — same honesty gate as
--                          risk.credit_model (grant_credit_model.sql).
--   ai.plot_assessment     one row per plot per assessment run: crop,
--                          planting/harvest dates, yield forecast, anomaly
--                          flags, risk level, and the full result as jsonb.
--   ai.v_latest_assessment newest assessment per plot.
--
-- Also replaces risk.compute_credit_score() (copied VERBATIM from
-- grant_credit_model.sql) with one addition: a satellite "plot health"
-- factor (AI 4). It does NOT change the rule-based score; it is recorded in
-- factors for audit and used only by a credit model trained after this
-- migration (POST /admin/credit-model/retrain now learns a weight for it).
--
-- Run after grant_credit_model.sql and grant_satellite_observation.sql.
-- Safe to run more than once.
-- ============================================================================

SET client_encoding = 'UTF8';

CREATE SCHEMA IF NOT EXISTS ai;
GRANT USAGE ON SCHEMA ai TO agrolink_app;

-- crop classes used by the models (not commodity codes: RICE_JASMINE and
-- RICE_PADDY are both 'rice' to a satellite)
CREATE TABLE IF NOT EXISTS ai.crop_profile (
  crop_code                text PRIMARY KEY,
  name_th                  text NOT NULL,
  typical_yield_t_per_rai  numeric(8,3),
  max_yield_t_per_rai      numeric(8,3),
  reference_peak_ndvi      numeric(4,3),
  peak_to_harvest_days     int,
  typical_season_days      int,
  source_note              text,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crop_profile_code_check CHECK (crop_code IN ('rice','maize','cassava','sugarcane','vegetable','perennial','fallow'))
);

INSERT INTO ai.crop_profile (crop_code, name_th, typical_yield_t_per_rai, max_yield_t_per_rai, reference_peak_ndvi, peak_to_harvest_days, typical_season_days, source_note) VALUES
  ('rice',      'ข้าว',                     0.450, 1.200, 0.800, 35,  120, 'ค่าเริ่มต้นโดยประมาณ (ข้าวนาปีเฉลี่ยทั้งประเทศ) — ตรวจสอบกับ สศก. แล้วปรับได้'),
  ('maize',     'ข้าวโพด',                   0.700, 1.600, 0.800, 45,  110, 'ค่าเริ่มต้นโดยประมาณ (ข้าวโพดเลี้ยงสัตว์) — ตรวจสอบกับ สศก. แล้วปรับได้'),
  ('cassava',   'มันสำปะหลัง',               3.300, 8.000, 0.750, 120, 300, 'ค่าเริ่มต้นโดยประมาณ — ตรวจสอบกับ สศก. แล้วปรับได้'),
  ('sugarcane', 'อ้อย',                      10.000, 25.000, 0.800, 150, 365, 'ค่าเริ่มต้นโดยประมาณ (อ้อยโรงงาน) — ตรวจสอบกับ สศก. แล้วปรับได้'),
  ('vegetable', 'ผัก/พืชอายุสั้น',            NULL,  NULL,  0.700, NULL, 60,  'ยังไม่พยากรณ์ผลผลิต'),
  ('perennial', 'ไม้ยืนต้น/ไม้ผล',            NULL,  NULL,  0.750, NULL, NULL, 'ยังไม่พยากรณ์ผลผลิต'),
  ('fallow',    'ไม่มีพืชปลูก/พื้นที่ว่าง',    NULL,  NULL,  NULL,  NULL, NULL, 'ไม่มีผลผลิต')
ON CONFLICT (crop_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS ai.ground_truth (
  gt_id              uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  unit_id            uuid NOT NULL REFERENCES registry.production_unit(unit_id) ON DELETE CASCADE,
  crop_code          text NOT NULL REFERENCES ai.crop_profile(crop_code),
  planting_date      date,
  harvest_date       date,
  note               text,
  source             text NOT NULL,
  confirmed_by_type  text NOT NULL,
  confirmed_by_id    uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ground_truth_source_check CHECK (source IN ('farmer','cooperative','field_survey','platform')),
  CONSTRAINT ground_truth_dates_check CHECK (harvest_date IS NULL OR planting_date IS NULL OR harvest_date > planting_date)
);
CREATE INDEX IF NOT EXISTS idx_ground_truth_unit ON ai.ground_truth (unit_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai.model (
  model_id      uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  model_kind    text NOT NULL,
  crop_code     text REFERENCES ai.crop_profile(crop_code),
  trained_at    timestamptz NOT NULL DEFAULT now(),
  sample_size   int NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT false,
  reason        text,
  metrics       jsonb,
  params        jsonb,
  report        jsonb,
  CONSTRAINT model_kind_check CHECK (model_kind IN ('crop_classifier','yield_forecaster')),
  CONSTRAINT model_crop_check CHECK ((model_kind = 'yield_forecaster') = (crop_code IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_model_active
  ON ai.model (model_kind, COALESCE(crop_code, '')) WHERE is_active;

CREATE TABLE IF NOT EXISTS ai.plot_assessment (
  assessment_id          uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  unit_id                uuid NOT NULL REFERENCES registry.production_unit(unit_id) ON DELETE CASCADE,
  assessed_at            timestamptz NOT NULL DEFAULT now(),
  as_of                  date NOT NULL,
  declared_crop          text,
  confirmed_crop         text,
  predicted_crop         text,
  crop_confidence        numeric(4,3),
  crop_method            text,
  planting_date          date,
  harvest_date           date,
  expected_harvest_date  date,
  season_status          text,
  forecast_crop          text,
  forecast_tons          numeric(12,2),
  forecast_tons_low      numeric(12,2),
  forecast_tons_high     numeric(12,2),
  forecast_method        text,
  risk_level             text NOT NULL,
  flags                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  result                 jsonb NOT NULL,
  assessed_by_type       text NOT NULL,
  CONSTRAINT plot_assessment_risk_check CHECK (risk_level IN ('low','medium','high','unknown'))
);
CREATE INDEX IF NOT EXISTS idx_plot_assessment_unit ON ai.plot_assessment (unit_id, assessed_at DESC);

CREATE OR REPLACE VIEW ai.v_latest_assessment AS
SELECT DISTINCT ON (unit_id) *
  FROM ai.plot_assessment
 ORDER BY unit_id, assessed_at DESC;

GRANT SELECT, UPDATE ON ai.crop_profile TO agrolink_app;
GRANT SELECT, INSERT ON ai.ground_truth TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON ai.model TO agrolink_app;
GRANT SELECT, INSERT ON ai.plot_assessment TO agrolink_app;
GRANT SELECT ON ai.v_latest_assessment TO agrolink_app;

-- POST /admin/credit-model/retrain (and the AI 4 plot_health retraining
-- added with this file) reads credit.loan_repayment as agrolink_app, but no
-- migration ever granted it — every retrain so far ended in "permission
-- denied for table loan_repayment". Read-only, same level as the sibling
-- credit.credit_line_repayment table already has.
GRANT SELECT ON credit.loan_repayment TO agrolink_app;

COMMENT ON TABLE ai.ground_truth IS 'ชนิดพืช/วันปลูก/วันเก็บเกี่ยวที่เกษตรกร สหกรณ์ หรือการสำรวจภาคสนามยืนยันแล้ว — ใช้เป็นคำตอบสำหรับสอนโมเดลจำแนกพืช (AgroLink SatAI)';
COMMENT ON TABLE ai.model IS 'ประวัติการเทรนโมเดลจำแนกพืชและพยากรณ์ผลผลิต — เปิดใช้ (is_active) เฉพาะเมื่อแม่นกว่าวิธีพื้นฐานในการทดสอบไขว้ (cross-validation)';
COMMENT ON TABLE ai.plot_assessment IS 'ผลวิเคราะห์แปลงด้วย AI แต่ละครั้ง: ชนิดพืช วันปลูก/เก็บเกี่ยว ผลผลิตคาดการณ์ และความผิดปกติ (src/lib/plotAI.js)';

-- ---------------------------------------------------------------------
-- risk.compute_credit_score() — verbatim from grant_credit_model.sql plus
-- the plot_health factor (ML-only, see header).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION risk.compute_credit_score(p_farmer_id uuid) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_production_total     INT;
    v_production_on_time     INT;
    v_production_factor        NUMERIC;
    v_contract_total               INT;
    v_contract_completed              INT;
    v_contract_factor                    NUMERIC;
    v_repayment_total                        INT;
    v_repayment_on_time                         INT;
    v_repayment_factor                             NUMERIC;
    v_delivery_total                                   INT;
    v_delivery_settled                                    INT;
    v_delivery_factor                                        NUMERIC;
    v_weight_sum          NUMERIC := 0;
    v_score_sum              NUMERIC := 0;
    v_score_value                NUMERIC(5,2);
    v_risk_tier                      TEXT;
    v_factors                            JSONB;
    v_score_id                              UUID;
    -- New below this line: optional ML override.
    v_rule_based_score                              NUMERIC(5,2);
    v_model                                     risk.credit_model%ROWTYPE;
    v_model_version                                TEXT := 'v1.0-rule-based';
    v_z1 NUMERIC; v_z2 NUMERIC; v_z3 NUMERIC; v_z4 NUMERIC; v_z5 NUMERIC;
    -- grant_plot_ai.sql: satellite plot-health factor (AI 4)
    v_plot_assessed                               INT := 0;
    v_plot_low_risk                               INT := 0;
    v_plot_health_factor                          NUMERIC;
    v_logit NUMERIC;
    v_ml_score NUMERIC(5,2);
    v_ml_tier TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM identity.farmer WHERE farmer_id = p_farmer_id) THEN
        RAISE EXCEPTION 'ไม่พบเกษตรกร %', p_farmer_id;
    END IF;

    -- ปัจจัยที่ 1: ความสม่ำเสมอการยืนยันงวดตามแผน (น้ำหนัก 30%)
    SELECT count(*), count(*) FILTER (WHERE sc.actual_date <= sc.planned_date)
    INTO v_production_total, v_production_on_time
    FROM production.stage_calendar sc
    JOIN production.crop_cycle cc ON cc.cycle_id = sc.cycle_id
    JOIN registry.production_unit pu ON pu.unit_id = cc.unit_id
    WHERE pu.owner_farmer_id = p_farmer_id AND sc.status = 'verified';

    IF v_production_total > 0 THEN
        v_production_factor := 100.0 * v_production_on_time / v_production_total;
        v_weight_sum := v_weight_sum + 30; v_score_sum := v_score_sum + v_production_factor * 30;
    END IF;

    -- ปัจจัยที่ 2: อัตราสัญญาที่จบสมบูรณ์ (completed) เทียบกับสัญญาที่ถึงจุดสิ้นสุดแล้วทั้งหมด (น้ำหนัก 25%)
    SELECT count(DISTINCT c.contract_id) FILTER (WHERE c.status IN ('completed','terminated','breached')),
           count(DISTINCT c.contract_id) FILTER (WHERE c.status = 'completed')
    INTO v_contract_total, v_contract_completed
    FROM contract.contract c
    JOIN contract.contract_party cp ON cp.contract_id = c.contract_id
    WHERE cp.party_type = 'farmer' AND cp.party_id = p_farmer_id;

    IF v_contract_total > 0 THEN
        v_contract_factor := 100.0 * v_contract_completed / v_contract_total;
        v_weight_sum := v_weight_sum + 25; v_score_sum := v_score_sum + v_contract_factor * 25;
    END IF;

    -- ปัจจัยที่ 3: อัตราการชำระคืนสินเชื่อตรงเวลา (น้ำหนัก 25%)
    SELECT count(r.repayment_id), count(r.repayment_id) FILTER (WHERE r.status = 'paid_on_time')
    INTO v_repayment_total, v_repayment_on_time
    FROM credit.loan_repayment r
    JOIN contract.contract c ON c.contract_id = r.contract_id
    JOIN contract.contract_party cp ON cp.contract_id = c.contract_id
    WHERE cp.party_type = 'farmer' AND cp.party_id = p_farmer_id;

    IF v_repayment_total > 0 THEN
        v_repayment_factor := 100.0 * v_repayment_on_time / v_repayment_total;
        v_weight_sum := v_weight_sum + 25; v_score_sum := v_score_sum + v_repayment_factor * 25;
    END IF;

    -- ปัจจัยที่ 4: อัตราการส่งมอบผลผลิตที่ชำระเงินสำเร็จ (ไม่ถูกปฏิเสธคุณภาพ) (น้ำหนัก 20%)
    SELECT count(d.delivery_id) FILTER (WHERE d.status IN ('settled','rejected')),
           count(d.delivery_id) FILTER (WHERE d.status = 'settled')
    INTO v_delivery_total, v_delivery_settled
    FROM produce.delivery d
    JOIN registry.production_unit pu ON pu.unit_id = d.unit_id
    WHERE pu.owner_farmer_id = p_farmer_id;

    IF v_delivery_total > 0 THEN
        v_delivery_factor := 100.0 * v_delivery_settled / v_delivery_total;
        v_weight_sum := v_weight_sum + 20; v_score_sum := v_score_sum + v_delivery_factor * 20;
    END IF;

    -- ปัจจัยเสริม (grant_plot_ai.sql): สุขภาพแปลงจากภาพดาวเทียม = สัดส่วนแปลง
    -- ของเกษตรกรที่ AI ตรวจแล้วไม่พบความผิดปกติระดับกลาง/สูง. ไม่ได้เข้าสูตร
    -- ถ่วงน้ำหนักเดิม (คะแนนแบบกฎยังเหมือนเดิมทุกประการ) — ใช้เฉพาะเมื่อโมเดล
    -- ที่เทรนแล้วมีน้ำหนักของปัจจัยนี้ และบันทึกไว้ใน factors เพื่อการตรวจสอบ
    SELECT count(*) FILTER (WHERE a.risk_level IN ('low','medium','high')),
           count(*) FILTER (WHERE a.risk_level = 'low')
    INTO v_plot_assessed, v_plot_low_risk
    FROM ai.v_latest_assessment a
    JOIN registry.production_unit pu ON pu.unit_id = a.unit_id
    WHERE pu.owner_farmer_id = p_farmer_id;

    IF v_plot_assessed > 0 THEN
        v_plot_health_factor := 100.0 * v_plot_low_risk / v_plot_assessed;
    END IF;

    IF v_weight_sum = 0 THEN
        v_score_value := 50.00;
    ELSE
        v_score_value := round(v_score_sum / v_weight_sum, 2);
    END IF;

    v_risk_tier := CASE
        WHEN v_score_value >= 80 THEN 'A'
        WHEN v_score_value >= 60 THEN 'B'
        WHEN v_score_value >= 40 THEN 'C'
        ELSE 'D'
    END;

    -- Captured BEFORE any possible ML override below, so the audit trail
    -- in v_factors can always show what the original fixed-weight formula
    -- would have produced, even on rows where the ML model ends up being
    -- the one actually used.
    v_rule_based_score := v_score_value;

    v_factors := jsonb_build_object(
        'production_reliability', jsonb_build_object('total', v_production_total, 'on_time', v_production_on_time, 'factor_score', v_production_factor),
        'contract_fulfillment', jsonb_build_object('total', v_contract_total, 'completed', v_contract_completed, 'factor_score', v_contract_factor),
        'loan_repayment', jsonb_build_object('total', v_repayment_total, 'on_time', v_repayment_on_time, 'factor_score', v_repayment_factor),
        'delivery_quality', jsonb_build_object('total', v_delivery_total, 'settled', v_delivery_settled, 'factor_score', v_delivery_factor),
        'plot_health', jsonb_build_object('assessed', v_plot_assessed, 'low_risk', v_plot_low_risk, 'factor_score', v_plot_health_factor, 'used_in', 'ml_only'),
        'weight_sum_used', v_weight_sum,
        'insufficient_data', (v_weight_sum = 0)
    );

    -- ---------------------------------------------------------------
    -- NEW: if a sufficiently-trained model is active, override the
    -- rule-based score_value/risk_tier above with the learned score.
    -- Wrapped in its own BEGIN/EXCEPTION block so ANY problem here
    -- (a malformed model row, a division edge case, anything) falls back
    -- to the rule-based v_score_value/v_risk_tier already computed above
    -- rather than ever making credit scoring itself fail.
    -- ---------------------------------------------------------------
    BEGIN
        SELECT * INTO v_model FROM risk.credit_model WHERE is_active = true LIMIT 1;
        IF FOUND THEN
            v_z1 := (COALESCE(v_production_factor, (v_model.feature_means->>'production')::numeric)
                     - (v_model.feature_means->>'production')::numeric) / NULLIF((v_model.feature_stds->>'production')::numeric, 0);
            v_z2 := (COALESCE(v_contract_factor, (v_model.feature_means->>'contract')::numeric)
                     - (v_model.feature_means->>'contract')::numeric) / NULLIF((v_model.feature_stds->>'contract')::numeric, 0);
            v_z3 := (COALESCE(v_repayment_factor, (v_model.feature_means->>'repayment')::numeric)
                     - (v_model.feature_means->>'repayment')::numeric) / NULLIF((v_model.feature_stds->>'repayment')::numeric, 0);
            v_z4 := (COALESCE(v_delivery_factor, (v_model.feature_means->>'delivery')::numeric)
                     - (v_model.feature_means->>'delivery')::numeric) / NULLIF((v_model.feature_stds->>'delivery')::numeric, 0);

            -- plot_health exists only in models trained after grant_plot_ai.sql;
            -- older model rows have no such key and simply contribute 0.
            IF v_model.weights ? 'plot_health' THEN
                v_z5 := (COALESCE(v_plot_health_factor, (v_model.feature_means->>'plot_health')::numeric)
                         - (v_model.feature_means->>'plot_health')::numeric) / NULLIF((v_model.feature_stds->>'plot_health')::numeric, 0);
            END IF;

            v_logit := v_model.bias
              + (v_model.weights->>'production')::numeric * COALESCE(v_z1, 0)
              + (v_model.weights->>'contract')::numeric    * COALESCE(v_z2, 0)
              + (v_model.weights->>'repayment')::numeric   * COALESCE(v_z3, 0)
              + (v_model.weights->>'delivery')::numeric    * COALESCE(v_z4, 0)
              + COALESCE((v_model.weights->>'plot_health')::numeric, 0) * COALESCE(v_z5, 0);

            v_ml_score := round((100.0 / (1 + exp(-v_logit)))::numeric, 2);
            v_ml_tier := CASE
                WHEN v_ml_score >= 80 THEN 'A'
                WHEN v_ml_score >= 60 THEN 'B'
                WHEN v_ml_score >= 40 THEN 'C'
                ELSE 'D'
            END;

            v_score_value := v_ml_score;
            v_risk_tier := v_ml_tier;
            v_model_version := 'v2.0-logistic-regression-' || to_char(v_model.trained_at, 'YYYY-MM-DD');
            v_factors := v_factors || jsonb_build_object(
                'scoring_method', 'ml_logistic_regression',
                'model_id', v_model.model_id,
                'model_trained_at', v_model.trained_at,
                'model_training_accuracy', v_model.training_accuracy,
                -- What the original fixed-weight formula would have said,
                -- kept for audit/comparison purposes (v_score_value itself
                -- has already been overwritten with the ML score above).
                'rule_based_score_value', v_rule_based_score
            );
        ELSE
            v_factors := v_factors || jsonb_build_object('scoring_method', 'rule_based_fallback');
        END IF;
    EXCEPTION WHEN OTHERS THEN
        -- Any failure in the ML path (bad model row, unexpected NULL,
        -- etc.) must never break credit scoring. Explicitly RESET
        -- v_score_value/v_risk_tier back to the rule-based numbers here —
        -- deliberately not relying on "the failure must have happened
        -- before v_score_value was overwritten", since a future edit to
        -- the block above could move that assignment earlier and silently
        -- break that assumption.
        v_score_value := v_rule_based_score;
        v_risk_tier := CASE
            WHEN v_rule_based_score >= 80 THEN 'A'
            WHEN v_rule_based_score >= 60 THEN 'B'
            WHEN v_rule_based_score >= 40 THEN 'C'
            ELSE 'D'
        END;
        v_model_version := 'v1.0-rule-based';
        v_factors := v_factors || jsonb_build_object('scoring_method', 'rule_based_fallback_after_ml_error');
    END;

    INSERT INTO risk.credit_score (farmer_id, score_value, risk_tier, factors, model_version)
    VALUES (p_farmer_id, v_score_value, v_risk_tier, v_factors, v_model_version)
    RETURNING score_id INTO v_score_id;

    UPDATE identity.farmer SET trust_score = v_score_value, updated_at = now() WHERE farmer_id = p_farmer_id;

    RETURN v_score_id;
END;
$$;

COMMENT ON FUNCTION risk.compute_credit_score(p_farmer_id uuid) IS 'คำนวณปัจจัยทั้ง 4 แบบเดิม (การยืนยันงวดตรงเวลา/สัญญาสำเร็จ/ชำระคืนตรงเวลา/ส่งมอบผ่านเกณฑ์) เหมือนเดิมทุกประการ แต่ถ้ามีโมเดล risk.credit_model ที่ผ่านเกณฑ์ข้อมูลขั้นต่ำ (POST /admin/credit-model/retrain) จะใช้คะแนนจากโมเดลที่ฝึกจากข้อมูลจริงแทนสูตรถ่วงน้ำหนักคงที่ — ถ้าไม่มีหรือมีปัญหาใดๆ จะใช้สูตรเดิม (v1.0-rule-based) เสมอ ไม่มีทางล้มเหลว. grant_plot_ai.sql เพิ่มปัจจัยสุขภาพแปลงจากภาพดาวเทียม (plot_health) ให้โมเดลที่เทรนใหม่ใช้ได้ โดยไม่เปลี่ยนสูตรกฎเดิม';
