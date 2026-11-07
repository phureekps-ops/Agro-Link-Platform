/**
 * Shared helpers for the Straw Mushroom Hub routes (src/routes/mushroom*.js,
 * see backend/db/grant_straw_mushroom.sql).
 */

/** An error a route handler can throw to send a specific 4xx JSON body. */
class HttpError extends Error {
  constructor(status, error, extra = {}) {
    super(error);
    this.httpStatus = status;
    this.body = Object.assign({ error }, extra);
  }
}

const bad = (error, extra) => new HttpError(400, error, extra);
const notFound = (error = 'not_found') => new HttpError(404, error);
const conflict = (error, extra) => new HttpError(409, error, extra);

/**
 * Wraps an async handler: whatever it returns is sent as JSON; HttpError
 * becomes its own status/body; anything else goes to the central error
 * handler in server.js (500, no stack trace to the client).
 */
function h(fn) {
  return async (req, res, next) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (err && err.httpStatus) return res.status(err.httpStatus).json(err.body);
      return next(err);
    }
    return undefined;
  };
}

/** Runs fn(client) inside BEGIN/COMMIT, rolling back on any throw. */
async function tx(client, fn) {
  await client.query('BEGIN');
  try {
    const out = await fn();
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Fee = base x rate% rounded to satang. */
const feeOf = (base, ratePct) => round2((Number(base) * Number(ratePct)) / 100);

/** Today's date in Thailand (UTC+7), as YYYY-MM-DD. Render's DB runs in UTC. */
function bkkToday() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

function num(v, { min = -Infinity, max = Infinity } = {}) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return NaN;
  return n;
}

/** Requires a positive number field; throws HttpError 400 otherwise. */
function needPos(v, field) {
  const n = num(v, { min: 0 });
  if (n === null || Number.isNaN(n) || n <= 0) throw bad('invalid_field', { field });
  return n;
}

function needNonNeg(v, field) {
  const n = num(v, { min: 0 });
  if (n === null || Number.isNaN(n)) throw bad('invalid_field', { field });
  return n;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function needUuid(v, field) {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw bad('invalid_field', { field });
  return v;
}
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

const GRADES = ['A', 'B', 'C'];
const GRADE_LABEL = { A: 'ดอกตูม', B: 'ดอกบาน', C: 'ตกเกรด' };
const PRODUCT_TYPES = ['fresh', 'blanched_frozen', 'soy_pickled', 'canned'];

module.exports = {
  HttpError, bad, notFound, conflict, h, tx, round2, feeOf, bkkToday, isDate, num,
  needPos, needNonNeg, needUuid, isUuid, GRADES, GRADE_LABEL, PRODUCT_TYPES,
};
