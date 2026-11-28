const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/lib/coopRisk');

const TODAY = '2026-11-28';
const codes = (list) => list.map((s) => s.code).sort();
const LISTING = {
  listing_id: 'L1', borrower_org_id: 'B1', project_type: 'procurement',
  details: { volume_t: 1000, period_from: '2026-09-01', period_to: '2027-02-28', reference_price: 10 },
};

test('early warning: purchase below plan, price drop, inventory mismatch, buyer default, report late, revenue below plan, unusual transfer', () => {
  const pc = (kg, price) => ({ quantity_kg: kg, actual: price });
  const items = [
    { item_id: 'i1', facility_id: 'F', amount: 20000, status: 'Paid', seller_name: 'ก', created_at: '2026-11-20', price_check: pc(2500, 8) },
    { item_id: 'i2', facility_id: 'F', amount: 22000, status: 'Paid', seller_name: 'ข', created_at: '2026-11-21', price_check: pc(2750, 8) },
    { item_id: 'i3', facility_id: 'F', amount: 21000, status: 'Paid', seller_name: 'ค', created_at: '2026-11-22', price_check: pc(2600, 8) },
    { item_id: 'i4', facility_id: 'F', amount: 400000, status: 'Funded', seller_name: 'ง', created_at: '2026-11-25', price_check: pc(50000, 8),
      payout_created_at: '2026-11-25T01:00:00Z', transfer_at: '2026-11-26T01:00:00Z' },
    { item_id: 'i5', facility_id: 'F', amount: 999999, status: 'Rejected', seller_name: 'x', created_at: '2026-11-25' }, // ไม่นับรายการที่ถูกปฏิเสธ
  ];
  const out = R.earlyWarnings({
    listing: LISTING, agreement: { agreement_id: 'A1', signed_at: '2026-08-01' }, items, deliveries_kg: 0,
    tranches: [{ agreement_id: 'A1', seq: 1, borrower_input: { inventory_value: 100000, sales_amount: 50000 }, reconciliation: { paid_amount: 463000 } }],
    reports: [{ report_id: 'r1', period_label: 'ต.ค. 69', created_at: '2026-10-31', revenue: 100000, planned_revenue: 400000, buyer_overdue: 30000 }],
    dairy: { rejected_30d: 3 }, settings: {}, today: TODAY,
  });
  assert.deepEqual(codes(out), ['ew_buyer_default', 'ew_buyer_default', 'ew_inflow_below', 'ew_inventory_mismatch', 'ew_price_drop', 'ew_purchase_below_plan',
    'ew_unusual_transfer', 'ew_unusual_transfer']);
  const below = out.find((s) => s.code === 'ew_purchase_below_plan');
  assert.equal(below.severity, 'high'); // 57,850 กก. จากแผน ณ วันนี้ ~485,000 กก. (ต่ำกว่าครึ่งของเกณฑ์ 70%)
  assert.equal(below.agreement_id, 'A1');
  assert.equal(out.find((s) => s.code === 'ew_price_drop').severity, 'warning'); // ลดลง 20% (เกณฑ์ 15%, สูง 30%)
  assert.equal(out.find((s) => s.code === 'ew_inventory_mismatch').severity, 'high'); // ขาด 67.6%
  assert.equal(out.find((s) => s.code === 'ew_inflow_below').severity, 'high'); // 25% ของประมาณการ
  assert.ok(out.every((s) => s.category === 'early_warning' && s.dedupe_key.startsWith(`${s.code}:`)));
  assert.deepEqual(out.filter((s) => s.code === 'ew_unusual_transfer').map((s) => s.item_id), ['i4', 'i4']); // บัญชีใหม่ + ยอดสูงกว่าค่ากลาง 3 เท่า

  // สินเชื่อสมาชิก: เงินไปถึงสมาชิก ไม่ใช่สินค้าคงคลัง จึงไม่ตรวจสินค้าคงเหลือ
  assert.deepEqual(R.earlyWarnings({ listing: { ...LISTING, project_type: 'member_onlending', details: {} }, agreement: { agreement_id: 'A1', signed_at: '2026-11-01' }, today: TODAY,
    tranches: [{ agreement_id: 'A1', seq: 1, borrower_input: { sales_amount: 0 }, reconciliation: { paid_amount: 1e6 } }] }), []);
  // ไม่มีรายงานเลย 120 วันหลังลงนาม → เตือน, เกิน 2 เท่า → สูง ; เกณฑ์ปรับได้
  const late = R.earlyWarnings({ listing: { ...LISTING, project_type: 'investment', details: {} }, agreement: { agreement_id: 'A1', signed_at: '2026-07-31' }, today: TODAY });
  assert.deepEqual(codes(late), ['ew_report_late']);
  assert.equal(late[0].severity, 'warning');
  assert.equal(R.earlyWarnings({ listing: { ...LISTING, project_type: 'investment', details: {} }, agreement: { agreement_id: 'A1', signed_at: '2026-07-31' }, today: TODAY, settings: { ew_report_days: 50 } })[0].severity, 'high');
  // ดำเนินการตามแผน → ไม่มีสัญญาณ
  const ok = R.earlyWarnings({ listing: LISTING, agreement: { agreement_id: 'A1', signed_at: '2026-09-01' }, items: [], deliveries_kg: 500000,
    reports: [{ report_id: 'r2', period_label: 'พ.ย.', created_at: '2026-11-25', revenue: 400000, planned_revenue: 400000 }], today: TODAY });
  assert.deepEqual(ok, []);
});

test('fraud signals: duplicate, ghost seller, related party, quantity vs area/satellite, shared account, backdated edit, split listing', () => {
  const procure = (id, seller, amount, extra = {}) => ({
    item_id: id, listing_id: 'L1', seller_type: 'farmer', purpose: 'procurement', seller_id: seller, seller_name: `นาย ${seller}`, amount, status: 'Paid',
    created_at: '2026-11-01', ...extra,
  });
  const out = R.fraudSignals({
    borrower: { org_id: 'B1', profile: { signatories: 'ประธานกรรมการ นายสมชาย ใจดี, ผู้จัดการ นางสมศรี มีสุข', debts: [{ outstanding: 5e6 }], max_borrowing: 20e6 } },
    related: [{ person_name: 'นายสมชาย ใจดี', role: 'ประธาน', related_name: 'หจก. ใจดีการเกษตร', related_tax_id: '0123456789012' }],
    items: [
      procure('d1', 'F1', 50000, { service_date: '2026-11-01', doc_no: 'INV-1' }),
      procure('d2', 'F1', 50000, { service_date: '2026-11-05', doc_no: 'INV-2' }),
      procure('g1', 'F2', 10000),
      procure('q1', 'F3', 90000, { price_check: { quantity_kg: 9000 } }),
      { item_id: 'rp', listing_id: 'L1', seller_type: 'organization', purpose: 'inputs', seller_id: 'O9', seller_name: 'หจก. ใจดีการเกษตร', seller_tax_id: '0123456789012', amount: 300000, status: 'Paid', created_at: '2026-11-02' },
      procure('acc', 'F4', 15000, { payout: { bank_code: '004', account_no: '1112223334', account_name: 'นางสมศรี มีสุข', owners: 2, is_borrower_account: false } }),
    ],
    farmers: {
      F1: { plots: [{ area_rai: 20, max_t_per_rai: 1, predicted_crop: 'rice' }], joined_at: '2015-01-01' },
      F2: { plots: [], joined_at: '2026-10-20' },
      F3: { plots: [{ area_rai: 5, max_t_per_rai: 1, predicted_crop: 'fallow', crop_confidence: 0.8 }], joined_at: '2010-01-01' },
      F4: { plots: [{ area_rai: 10, max_t_per_rai: 1 }], joined_at: '2012-01-01' },
    },
    listings: [
      { listing_id: 'L1', status: 'Signed', project_type: 'member_onlending', amount_requested: 5e6, created_at: '2026-09-15', listed_at: '2026-09-20' },
      { listing_id: 'L2', status: 'Draft', project_type: 'member_onlending', amount_requested: 7e6, created_at: '2026-11-10' },
      { listing_id: 'L3', status: 'Draft', project_type: 'member_onlending', amount_requested: 7e6, created_at: '2026-11-20' },
    ],
    history: [
      { history_id: 'h0', changed_at: '2026-09-01', old_financials: [{ year: 2567, net_income: 1 }], new_financials: [{ year: 2567, net_income: 999999 }] }, // ก่อนขอกู้ ไม่นับ
      { history_id: 'h1', changed_at: '2026-10-15', old_financials: [{ year: 2567, net_income: 2e6, revenue: 30e6 }], new_financials: [{ year: 2567, net_income: 3.5e6, revenue: 30e6 }, { year: 2568, net_income: 1 }] },
    ],
    settings: {}, today: TODAY,
  });
  assert.deepEqual(codes(out), ['fr_backdated_edit', 'fr_duplicate_invoice', 'fr_ghost_seller', 'fr_quantity_mismatch', 'fr_quantity_mismatch',
    'fr_related_party', 'fr_related_party', 'fr_shared_account', 'fr_split_listing']);
  assert.ok(out.every((s) => s.category === 'fraud' && s.borrower_org_id === 'B1'));
  assert.equal(out.find((s) => s.code === 'fr_duplicate_invoice').dedupe_key, 'fr_duplicate_invoice:d1:d2');
  assert.equal(out.find((s) => s.code === 'fr_ghost_seller').severity, 'high'); // ไม่มีแปลง และเป็นสมาชิก 12 วันก่อนขาย
  assert.deepEqual(out.filter((s) => s.code === 'fr_related_party').map((s) => s.item_id).sort(), ['acc', 'rp']); // นิติบุคคลที่แจ้ง + ชื่อบัญชี = ผู้จัดการ
  assert.deepEqual(out.filter((s) => s.code === 'fr_quantity_mismatch').map((s) => s.severity).sort(), ['high', 'warning']); // 9,000 > 5 ไร่×1 ตัน×1.5 ; ดาวเทียมไม่พบพืช
  const be = out.find((s) => s.code === 'fr_backdated_edit');
  assert.equal(be.severity, 'high');
  assert.deepEqual(be.detail_changes, [{ year: 2567, field: 'net_income', label: 'กำไรสุทธิ', from: 2e6, to: 3.5e6, pct: 75 }]);
  const split = out.find((s) => s.code === 'fr_split_listing');
  assert.equal(split.severity, 'high'); // 19 ล้าน > 20 − 5
  assert.equal(split.listing_id, 'L3');
  // ไม่มีสัญญาณเมื่อข้อมูลปกติ
  assert.deepEqual(R.fraudSignals({ borrower: { org_id: 'B1', profile: {} }, items: [procure('n1', 'F1', 1000)], farmers: { F1: { plots: [{ area_rai: 3 }], joined_at: '2000-01-01' } }, today: TODAY }), []);
});

test('helpers: settings fall back to defaults; person names drop role words', () => {
  assert.equal(R.cfg({ ew_report_days: '45', fee_pct: 1, fraud_yield_factor: null }).ew_report_days, 45);
  assert.equal(R.cfg({ fraud_yield_factor: null }).fraud_yield_factor, 1.5);
  assert.equal('fee_pct' in R.cfg({ fee_pct: 1 }), false);
  assert.deepEqual(R.personNames('ประธานกรรมการ นายสมชาย ใจดี; ผู้จัดการ นางสมศรี มีสุข\nนาย ก'), ['นายสมชาย ใจดี', 'นางสมศรี มีสุข']);
  assert.ok(Object.values(R.CODES).every(([cat, title]) => ['early_warning', 'fraud'].includes(cat) && title.length > 5));
});
