-- AgroLink -- ตลาดสินเชื่อระหว่างสหกรณ์: ปรับโครงสร้างหนี้ (Debt Restructuring)
--   ผู้กู้ยื่นคำขอขยายวันครบกำหนดชำระ (และขอลดอัตราดอกเบี้ยได้) พร้อมเหตุผล แผนการชำระใหม่ และมติที่ประชุม
--   ผู้ให้กู้ทุกรายในสัญญาต้องอนุมัติ (อ้างเลขมติของตน) → ระบบคิดดอกเบี้ยถึงวันอนุมัติด้วยเงื่อนไขเดิม แล้วเลื่อนวันครบกำหนด/ปรับอัตรา
--   ปลดระงับวงเงินที่ถูกระงับเพราะค้างชำระ และออกบันทึกข้อตกลงแก้ไขเพิ่มเติมสัญญา (.docx) ให้ลงนาม
--   ผู้ให้กู้รายใดไม่อนุมัติ = คำขอตก · เก็บภาพก่อน/หลังไว้ตรวจสอบ
--
-- รันหลัง grant_coop_lending_marketplace.sql · รันซ้ำได้
-- ============================================================================
SET client_min_messages = warning;

CREATE TABLE IF NOT EXISTS coop_lending.restructure_request (
  request_id        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  agreement_id      uuid NOT NULL REFERENCES coop_lending.loan_agreement(agreement_id),
  listing_id        uuid NOT NULL REFERENCES coop_lending.loan_listing(listing_id),
  borrower_org_id   uuid NOT NULL REFERENCES identity.organization(org_id),
  new_due_date      date NOT NULL,
  new_rate_pct      numeric(6,3) CHECK (new_rate_pct IS NULL OR (new_rate_pct >= 0 AND new_rate_pct <= 30)),
  reason            text NOT NULL CHECK (length(reason) BETWEEN 10 AND 2000),
  repayment_plan    text NOT NULL CHECK (length(repayment_plan) BETWEEN 10 AND 2000),
  file_id           uuid REFERENCES storage.file_object(file_id),          -- มติที่ประชุม/หนังสือขอปรับโครงสร้างหนี้
  outstanding       numeric(16,2) NOT NULL,                                -- เงินต้นคงค้าง ณ วันยื่น
  overdue           numeric(16,2) NOT NULL DEFAULT 0,                      -- ส่วนที่เลยกำหนดแล้ว ณ วันยื่น
  status            text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Withdrawn')),
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  decided_at        timestamptz,
  applied_snapshot  jsonb                                                  -- {before:{items,rates}, after:{...}, accrued_to}
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cl_restructure_pending ON coop_lending.restructure_request (agreement_id) WHERE status = 'Pending';
CREATE INDEX IF NOT EXISTS idx_cl_restructure_borrower ON coop_lending.restructure_request (borrower_org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS coop_lending.restructure_vote (
  request_id     uuid NOT NULL REFERENCES coop_lending.restructure_request(request_id) ON DELETE CASCADE,
  lender_org_id  uuid NOT NULL REFERENCES identity.organization(org_id),
  decision       text NOT NULL CHECK (decision IN ('Approved', 'Rejected')),
  approval_ref   text CHECK (approval_ref IS NULL OR length(approval_ref) BETWEEN 2 AND 200),
  note           text CHECK (note IS NULL OR length(note) <= 2000),
  decided_by     text NOT NULL,
  decided_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, lender_org_id),
  CHECK (decision <> 'Approved' OR approval_ref IS NOT NULL)
);

GRANT SELECT, INSERT, UPDATE ON coop_lending.restructure_request, coop_lending.restructure_vote TO agrolink_app;
