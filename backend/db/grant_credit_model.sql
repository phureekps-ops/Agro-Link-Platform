-- grant_credit_model.sql
--
-- Adds a genuinely-TRAINED credit-scoring layer on top of the existing
-- risk.compute_credit_score() function (originally defined in
-- 02_full_schema.sql as a fixed-weight rule-based formula: 30% production-
-- verification-on-time rate + 25% contract-completion rate + 25% on-time-
-- repayment rate + 20% delivery-settlement rate, thresholded into A/B/C/D
-- at fixed cutoffs — see that function's original comment).
--
-- This does NOT remove or rewrite that rule-based formula — it stays
-- exactly as-is, computing the same 4 factor numbers it always did. What
-- changes is what happens AFTER those factors are computed: if a
-- sufficiently-trained model exists in the new risk.credit_model table
-- below, its logistic-regression weights are used instead to produce the
-- final score_value/risk_tier; if not (no model yet, or the last training
-- run didn't have enough real data — see MIN thresholds in
-- POST /admin/credit-model/retrain, src/routes/admin.js), the original
-- rule-based formula's result is used unchanged. Every score row in
-- risk.credit_score records which method actually produced it, both via
-- the pre-existing model_version column and a new 'scoring_method' key
-- inside the factors jsonb ('ml_logistic_regression' vs
-- 'rule_based_fallback') — so nothing is silently guessed at either by an
-- admin auditing scores or by a farmer viewing their own history.
--
-- Why logistic regression specifically, and why gated on a minimum sample
-- size: this is a genuinely early-stage pilot (see the "AI" homepage-copy
-- discussion this conversation started from) — there is no guarantee there
-- is enough real farmer repayment/contract history yet to train ANY model
-- reliably. Logistic regression over the same 4 already-computed factor
-- ratios is the simplest model that (a) can be trained with a hand-written
-- gradient-descent loop in plain Node.js — no new ML library/service
-- dependency in a stack that has never had one — and (b) degrades
-- gracefully: with too little/imbalanced data the fitted weights would be
-- unreliable, so POST /admin/credit-model/retrain refuses to activate a
-- model below MIN_TRAINING_SAMPLES/MIN_PER_CLASS and leaves the existing
-- rule-based (or previous model) path untouched. This is an honest "learns
-- from real data" system, not a rebrand of the same fixed formula.

-- ---------------------------------------------------------------------
-- 1. risk.credit_model — one row per training run. Only ever ONE row has
--    is_active = true at a time (enforced by POST /admin/credit-model/
--    retrain deactivating the previous row in the same transaction, not by
--    a DB constraint — mirrors how e.g. marketplace.service_listing's
--    "one active rate-card price per service_key" is also
--    application-enforced rather than constraint-enforced elsewhere in
--    this project). Old rows are kept (not deleted) purely as an audit
--    trail of every training attempt, successful or not.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS risk.credit_model (
  model_id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  trained_at         timestamptz NOT NULL DEFAULT now(),
  sample_size        int NOT NULL,
  positive_count     int NOT NULL,
  negative_count     int NOT NULL,
  -- Per-feature mean/std used to z-score-normalize inputs at both training
  -- and scoring time (JSON keys: production, contract, repayment,
  -- delivery) — stored so risk.compute_credit_score() below normalizes
  -- new farmers' factors the exact same way the model was trained on.
  feature_means      jsonb NOT NULL,
  feature_stds       jsonb NOT NULL,
  -- Fitted logistic-regression coefficients, same 4 JSON keys as above.
  weights            jsonb NOT NULL,
  bias               numeric NOT NULL,
  training_accuracy  numeric(5,4),
  is_active          boolean NOT NULL DEFAULT false,
  notes              text,
  CONSTRAINT credit_model_sample_size_check CHECK (sample_size >= 0),
  CONSTRAINT credit_model_counts_check CHECK (positive_count >= 0 AND negative_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_credit_model_active ON risk.credit_model (is_active) WHERE is_active = true;

GRANT SELECT, INSERT, UPDATE ON risk.credit_model TO agrolink_app;

-- ---------------------------------------------------------------------
-- 2. Replace risk.compute_credit_score() — same signature/return type
--    (uuid, the new risk.credit_score row's id) as the original in
--    02_full_schema.sql, so every existing caller (POST routes that
--    trigger a rescoring elsewhere in the codebase) keeps working
--    unchanged. The four factor computations below are copied VERBATIM
--    from the original function — only the block after "ปัจจัยที่ 4" is
--    new.
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
    v_z1 NUMERIC; v_z2 NUMERIC; v_z3 NUMERIC; v_z4 NUMERIC;
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

            v_logit := v_model.bias
              + (v_model.weights->>'production')::numeric * COALESCE(v_z1, 0)
              + (v_model.weights->>'contract')::numeric    * COALESCE(v_z2, 0)
              + (v_model.weights->>'repayment')::numeric   * COALESCE(v_z3, 0)
              + (v_model.weights->>'delivery')::numeric    * COALESCE(v_z4, 0);

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

COMMENT ON FUNCTION risk.compute_credit_score(p_farmer_id uuid) IS 'คำนวณปัจจัยทั้ง 4 แบบเดิม (การยืนยันงวดตรงเวลา/สัญญาสำเร็จ/ชำระคืนตรงเวลา/ส่งมอบผ่านเกณฑ์) เหมือนเดิมทุกประการ แต่ถ้ามีโมเดล risk.credit_model ที่ผ่านเกณฑ์ข้อมูลขั้นต่ำ (POST /admin/credit-model/retrain) จะใช้คะแนนจากโมเดลที่ฝึกจากข้อมูลจริงแทนสูตรถ่วงน้ำหนักคงที่ — ถ้าไม่มีหรือมีปัญหาใดๆ จะใช้สูตรเดิม (v1.0-rule-based) เสมอ ไม่มีทางล้มเหลว';

COMMENT ON TABLE risk.credit_model IS 'ประวัติการฝึกโมเดลคะแนนเครดิต (logistic regression บน 4 ปัจจัยเดียวกับสูตรกฎเดิม) — ดู POST/GET /admin/credit-model* ใน src/routes/admin.js และ MIN_TRAINING_SAMPLES/MIN_PER_CLASS สำหรับเกณฑ์ขั้นต่ำก่อนจะเปิดใช้งานจริง (is_active = true)';
