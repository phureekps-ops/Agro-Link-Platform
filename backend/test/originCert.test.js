const test = require('node:test');
const assert = require('node:assert/strict');
const OC = require('../src/lib/originCert');

test('canonical JSON + SHA-256 do not depend on key order; certificate numbers tolerate typos', () => {
  const a = { b: 1, a: [{ y: 2, x: new Date('2026-11-10T01:00:00Z') }], c: null, u: undefined };
  const b = { c: null, a: [{ x: '2026-11-10T01:00:00.000Z', y: 2 }], b: 1 };
  assert.equal(OC.canonical(a), OC.canonical(b));
  assert.equal(OC.sha256(a), OC.sha256(b));
  assert.notEqual(OC.sha256(a), OC.sha256({ ...b, b: 2 }));
  assert.equal(OC.normCertNo(' oc-ab0d23x5 '.replace('0', 'o')), 'OC-AB0D23X5');
  assert.ok(OC.CERT_RE.test(OC.normCertNo('oc ab1d23x5')));
  assert.equal(OC.thDate('2026-11-27T20:00:00Z'), '28 พ.ย. 2569'); // เวลาไทย
});

test('live diff watches the supply chain only (satellite results may update), PDF renders', async () => {
  const core = {
    subject: { code: 'FG-AAAABBBB', quantity_ton: 3.2 },
    origin: { farmers: 2, plots: 2, area_rai: 23, raw_ton: 5, plots_satellite_confirmed: 1, plots_satellite_mismatch: 1, provinces: ['สุรินทร์'], grades: ['A'], harvest_from: null, harvest_to: null },
    chain: { lots: [{ code: 'LT-1', ton: 5, deliveries: 2 }], batches: [], plot_fingerprints: ['a', 'b'] },
    cooperative: { name: 'สหกรณ์ทดสอบ จำกัด', province: 'สุรินทร์', registration_no: null },
    steps: [{ title: 'รับซื้อผลผลิตจากสมาชิก', from: '2026-11-10T01:00:00.000Z', to: null, detail: '2 ราย' }],
  };
  assert.deepEqual(OC.liveDiff(core, JSON.parse(JSON.stringify(core))), []);
  const sat = JSON.parse(JSON.stringify(core)); sat.origin.plots_satellite_confirmed = 2;
  assert.deepEqual(OC.liveDiff(core, sat), []);
  const moved = JSON.parse(JSON.stringify(core)); moved.origin.raw_ton = 5.5; moved.chain.plot_fingerprints = ['a', 'c'];
  assert.deepEqual(OC.liveDiff(core, moved).map((x) => x.field), ['origin.raw_ton', 'chain.plot_fingerprints']);
  for (const status of ['Issued', 'Revoked']) {
    const pdf = await OC.renderPdf({
      cert_no: 'OC-AAAABBBB', status, issued_at: new Date(), revoked_at: status === 'Revoked' ? new Date() : null, revoked_reason: 'ทดสอบ',
      payload: { core }, payload_sha256: 'f'.repeat(64), prev_sha256: null,
    }, { verifyUrl: 'https://example.test/certificate.html?no=OC-AAAABBBB' });
    assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
    assert.ok(pdf.length > 5000);
  }
});
