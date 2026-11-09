/**
 * Shared helpers for the Dairy Cooperative routes (src/routes/dairy*.js,
 * see backend/db/grant_dairy_cooperative.sql). Generic HTTP/validation
 * helpers are the same ones the straw-mushroom routes use.
 */
const M = require('./mushroom');

const { round2 } = M;

const DAY = 86400000;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

/**
 * A pg DATE column comes back as a JS Date at LOCAL midnight; format it from
 * local components so the calendar day never shifts with the server TZ.
 */
function ds(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

/** Morning/evening shift from a timestamp, in Thai time (before 12:00 = AM). */
function shiftOf(date = new Date()) {
  const bkkHour = new Date(date.getTime() + 7 * 3600 * 1000).getUTCHours();
  return bkkHour < 12 ? 'AM' : 'PM';
}

const QUALITY_PARAMS = {
  fat: 'fat_pct', snf: 'snf_pct', scc: 'scc_k', tbc: 'tbc_k',
};

/**
 * Price per kg for one member on one day: base price + every active rule
 * whose parameter value (from the member's latest test on/before that day)
 * falls in [min_value, max_value). No test yet = base price only, flagged.
 */
function priceFor(base, test, rules) {
  const detail = { base: Number(base), adjustments: [], test_date: test ? test.sample_date : null };
  let price = Number(base);
  if (test) {
    rules.forEach((r) => {
      const v = test[QUALITY_PARAMS[r.param]];
      if (v === null || v === undefined) return;
      const x = Number(v);
      if (r.min_value !== null && x < Number(r.min_value)) return;
      if (r.max_value !== null && x >= Number(r.max_value)) return;
      price += Number(r.adjust_per_kg);
      detail.adjustments.push({ param: r.param, value: x, adjust: Number(r.adjust_per_kg) });
    });
  } else detail.no_test = true;
  price = Math.max(0, round2(price));
  return { price, detail };
}

/** Surplus-alert colour from forecast vs committed (contracts + school milk). */
function alertLevel(forecastKg, committedKg, s) {
  if (!(forecastKg > 0)) return { level: 'green', surplus_pct: 0 };
  if (!(committedKg > 0)) return { level: 'red', surplus_pct: null };
  const pct = round2(((forecastKg - committedKg) / committedKg) * 100);
  let level = 'green';
  if (pct > Number(s.alert_red_pct)) level = 'red';
  else if (pct > Number(s.alert_orange_pct)) level = 'orange';
  else if (pct > Number(s.alert_yellow_pct)) level = 'yellow';
  return { level, surplus_pct: pct };
}

const LEDGER_TYPES = ['milk_sale', 'feed', 'vet_service', 'ai_service', 'loan_repayment', 'share', 'adjustment'];
const DEBIT_TYPES = ['feed', 'vet_service', 'ai_service', 'loan_repayment', 'share', 'adjustment'];
const PARTNER_TYPES = ['processor', 'feed_supplier', 'vet', 'product_buyer', 'transporter'];
const ANIMAL_STATUS = ['Calf', 'Heifer', 'Milking', 'Dry', 'Bull', 'Sold', 'Dead', 'Culled'];
const EVENT_TYPES = ['heat', 'insemination', 'pregnancy_check', 'calving', 'dry_off', 'treatment', 'vaccination', 'sold', 'dead', 'culled', 'note'];
const MEMBER_EVENT_TYPES = ['heat', 'calving', 'dry_off', 'note'];
const PRODUCT_TYPES = ['pasteurized', 'uht', 'yogurt', 'cheese', 'butter', 'powder', 'other'];
const REJECT_REASONS = ['antibiotic', 'temperature', 'smell', 'clot', 'other'];

module.exports = {
  ...M,
  DAY, addDays, daysBetween, ds, shiftOf, priceFor, alertLevel, QUALITY_PARAMS,
  LEDGER_TYPES, DEBIT_TYPES, PARTNER_TYPES, ANIMAL_STATUS, EVENT_TYPES, MEMBER_EVENT_TYPES, PRODUCT_TYPES, REJECT_REASONS,
  DAIRY_PRODUCT_TYPES: PRODUCT_TYPES,
};
