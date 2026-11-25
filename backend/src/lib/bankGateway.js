/**
 * ตัวเชื่อมระบบโอนเงินธนาคาร (สินเชื่อระหว่างสหกรณ์ — routes/coopLending.js)
 *
 * AgroLink ไม่ถือเงินเอง: ทุกคำสั่งโอนเป็นการสั่งจากบัญชีธนาคารของสหกรณ์ หลังผู้มีอำนาจอนุมัติครบ 2 คน
 * ไฟล์นี้แยกส่วนที่คุยกับธนาคารออกเป็น "ไดรเวอร์" เพื่อเพิ่มธนาคารคู่ค้าภายหลังได้โดยไม่แก้ส่วนอื่น
 *
 * ไดรเวอร์ที่มีตอนนี้:
 *   sandbox — โหมดทดสอบ ไม่โอนเงินจริงและไม่ได้ตรวจชื่อบัญชีกับธนาคารจริง (ค่าเริ่มต้น)
 *             เลขบัญชีขึ้นต้น 999 = ไม่พบบัญชี · ขึ้นต้น 000 = โอนไม่สำเร็จ (เงินไม่พอ) — ไว้ทดสอบกรณีผิดพลาด
 * เลือกด้วยตัวแปรสภาพแวดล้อม BANK_GATEWAY_DRIVER (ค่าเริ่มต้น sandbox)
 *
 * เมื่อเลือกธนาคารคู่ค้าแล้ว: เพิ่มไดรเวอร์ใหม่ใน DRIVERS ที่มี verifyAccount() และ transfer() รูปเดียวกัน
 * กุญแจ/ใบรับรองของธนาคารให้อ่านจากตัวแปรสภาพแวดล้อมบน Render เท่านั้น ห้ามเก็บใน git
 * transfer() ต้องส่ง idempotencyKey ให้ธนาคาร เพื่อให้การส่งซ้ำ (เน็ตหลุด) ไม่โอนซ้ำ
 */
const crypto = require('crypto');

const sandbox = {
  name: 'sandbox',
  live: false,
  label_th: 'โหมดทดสอบ — ยังไม่ได้เชื่อมธนาคารจริง ไม่มีการโอนเงินจริง',
  /** ตรวจชื่อบัญชี → { status: 'Verified'|'Failed', account_name, note } */
  async verifyAccount({ account_no: accountNo, account_name: accountName }) {
    if (String(accountNo).startsWith('999')) return { status: 'Failed', account_name: null, note: 'ไม่พบบัญชีนี้ (sandbox)' };
    return { status: 'Verified', account_name: accountName, note: 'sandbox: ใช้ชื่อที่กรอก ไม่ได้ตรวจกับธนาคารจริง' };
  },
  /** สั่งโอน → { status: 'Succeeded'|'Failed'|'Submitted', bank_ref, failure_reason } */
  async transfer({ from, idempotencyKey }) {
    if (String(from.account_no).startsWith('000')) return { status: 'Failed', bank_ref: null, failure_reason: 'ยอดเงินในบัญชีต้นทางไม่พอ (sandbox)' };
    const ref = `SBX-${crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 12).toUpperCase()}`;
    return { status: 'Succeeded', bank_ref: ref, failure_reason: null };
  },
};

const DRIVERS = { sandbox };

function driver() {
  const name = (process.env.BANK_GATEWAY_DRIVER || 'sandbox').trim();
  const d = DRIVERS[name];
  if (!d) throw new Error(`bank_gateway_driver_unknown:${name}`);
  return d;
}

function info() {
  const d = driver();
  return { driver: d.name, live: d.live, label_th: d.label_th };
}

module.exports = { driver, info, DRIVERS };
