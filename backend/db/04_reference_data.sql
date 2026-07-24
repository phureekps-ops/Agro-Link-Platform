--
-- AgroLink Platform — production reference/config data.
--
-- This file contains ONLY static reference and business-rule-configuration
-- rows that the application logic depends on to behave correctly:
--   - registry.commodity_ref: fixed lookup list used by dropdowns and
--     validation across the farmer/buyer portals. (registry.rice_grade_ref
--     is deliberately NOT included here — grant_input_supplier_and_buy_
--     prices.sql already seeds it idempotently with ON CONFLICT DO NOTHING,
--     so including it here too would just duplicate-key-error on restore.)
--   - identity.role: the fixed set of role codes the platform recognizes.
--   - production.stage_template: the standard crop-stage timeline per
--     commodity, used to generate a farmer's production calendar.
--   - underwriting.loan_policy: the risk-tier lending rules the automatic
--     underwriting decision logic reads.
--   - monitoring.metric_threshold / retention.retention_policy: the
--     alerting and data-retention configuration the ops/monitoring
--     features read.
--
-- Deliberately EXCLUDED: every table holding farmer/organization/contract/
-- loan/order/delivery/ledger/audit/notification data. Those rows in the
-- sandbox are fake data generated while building and testing this project
-- and must NOT be loaded into a real pilot database. A pilot should start
-- with these reference tables populated and everything else empty, so the
-- first real farmers/organizations that register are the first real rows.
--

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;

COPY registry.commodity_ref (commodity_code, name_th, agrovoc_ref) FROM stdin;
RICE_JASMINE	ข้าวหอมมะลิ	c_7951
RICE_PADDY	ข้าวเปลือกเจ้า	c_7951
CASSAVA	มันสำปะหลัง	c_1739
\.


COPY identity.role (role_code, description) FROM stdin;
farmer.self	เจ้าของบัญชีเกษตรกร จัดการข้อมูลของตนเอง
org.admin	ผู้ดูแลบัญชีองค์กร
field_agent	เจ้าหน้าที่ภาคสนามช่วยขึ้นทะเบียนแทนเกษตรกร
\.

COPY production.stage_template (stage_template_id, commodity_code, stage_seq, stage_name, typical_offset_days) FROM stdin;
fb56cc21-d6ef-448f-95c5-c0200f3e8cba	RICE_JASMINE	1	เตรียมดินและเพาะกล้า	0
d2d07765-75f4-48a7-a61d-cd5223ffb57a	RICE_JASMINE	2	ปลูก/ปักดำ	20
04b910bd-6c0e-4ea6-aabd-bf2e32e1713a	RICE_JASMINE	3	ดูแลรักษา/ใส่ปุ๋ย	45
c004b039-1496-49ba-bdae-74ed1e9bdb02	RICE_JASMINE	4	เก็บเกี่ยว	110
b7c0f1e1-dc3c-494d-b7d5-3cbd05cdd93a	RICE_PADDY	1	เตรียมดินและเพาะกล้า	0
4ccc44fe-a381-427a-9ebc-51fb89263c89	RICE_PADDY	2	ปลูก/ปักดำ	18
f4b8efd6-5a3b-4b9c-a978-b1b914cfc691	RICE_PADDY	3	ดูแลรักษา/ใส่ปุ๋ย	40
ce15d6b0-45ec-4008-888a-a35d6ef27071	RICE_PADDY	4	เก็บเกี่ยว	100
18db73c9-a69f-48e8-b50a-e6e40742f356	CASSAVA	1	เตรียมดินและปลูก	0
48ac3df2-8721-4b66-a573-3e90f87cb232	CASSAVA	2	ดูแลรักษาระยะแรก	60
eb0b0424-2216-4417-8f07-93caa51bb36b	CASSAVA	3	ดูแลรักษาระยะปลาย	180
fab5443d-4d22-41fb-b07c-e90dbfca29be	CASSAVA	4	เก็บเกี่ยว	300
\.

COPY underwriting.loan_policy (risk_tier, max_principal_amount, interest_rate_bps, auto_approve, policy_note, updated_at) FROM stdin;
A	50000.00	800	t	ความเสี่ยงต่ำ อนุมัติอัตโนมัติภายในวงเงิน	2026-07-22 09:23:06.165504+00
B	20000.00	1200	t	ความเสี่ยงปานกลางค่อนต่ำ อนุมัติอัตโนมัติภายในวงเงินที่ลดลง	2026-07-22 09:23:06.165504+00
C	5000.00	1800	f	ความเสี่ยงปานกลาง ต้องผ่านการพิจารณาโดยเจ้าหน้าที่เสมอแม้อยู่ในวงเงิน	2026-07-22 09:23:06.165504+00
D	0.00	0	f	ความเสี่ยงสูง ปฏิเสธอัตโนมัติ ไม่มีวงเงินให้	2026-07-22 09:23:06.165504+00
\.

COPY monitoring.metric_threshold (threshold_id, metric_name, comparison, warning_value, critical_value, unit, description, created_at) FROM stdin;
e40d294e-6d78-4724-b98b-95ae7664fa86	reporting_dashboard_latency_avg_ms	gt	10.000	50.000	ms	Latency เฉลี่ยของ Query แดชบอร์ดบริหาร — เกณฑ์อ้างอิงจากผลทดสอบขั้นที่ 9 (10 client=15.45ms, 50 client=82.24ms)	2026-07-23 10:31:31.494287+00
d4bfe9b1-080f-4042-9103-e717b86cd176	reporting_dashboard_tps	lt	400.000	200.000	tx/s	Throughput ขั้นต่ำที่ยอมรับได้ของระบบรายงานเชิงบริหาร — เกณฑ์อ้างอิงจาก Baseline 1 client=341.24 tx/s ของขั้นที่ 9	2026-07-23 10:31:31.494287+00
4cc85843-b456-404f-869f-7a54791a2330	ledger_reconciliation_variance	gt	0.000	0.010	THB	ส่วนต่างบัญชี (ledger.v_reconciliation_summary) ต้องเป็น 0.00 เสมอ ค่าใดๆ ที่ไม่ใช่ 0 ถือเป็นเหตุฉุกเฉินระดับ Critical ทันที	2026-07-23 10:31:31.494287+00
\.

COPY retention.retention_policy (policy_id, table_schema, table_name, date_column, retain_days, last_purged_at, rows_purged_last_run, notes) FROM stdin;
da250de3-4fde-4870-8daa-80fe75ef870d	audit	access_log	occurred_at	365	2026-07-23 10:34:09.494368+00	50	เก็บ 1 ปีตามแนวทาง PDPA/GDPR สำหรับการสอบทานเชิงความปลอดภัยย้อนหลัง
fc659114-e02c-4698-86f6-70ce5c5f849e	notification	notification_log	created_at	180	2026-07-23 10:34:09.503599+00	5	เก็บ 6 เดือน เพียงพอสำหรับการอ้างอิงประวัติการแจ้งเตือนเชิงธุรกิจ
\.

