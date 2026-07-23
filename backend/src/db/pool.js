const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  // A client sitting idle in the pool hit a background error (e.g. server
  // restarted). Log it — do not crash the whole API process over one
  // connection.
  console.error('[db] unexpected error on idle client', err);
});

/**
 * Runs `fn(client)` against a connection that has:
 *   1. SET ROLE agrolink_app         — assume the least-privilege role RLS
 *                                       policies are written against (Layer 8).
 *      agrolink_backend itself is a LOGIN-only service account and is NOT
 *      granted any table access directly, by design.
 *   2. security.set_session_context() — validates subjectType/subjectId
 *      against identity.subject_role and sets app.subject_type/app.subject_id
 *      so every RLS policy downstream sees the right actor.
 *
 * Always resets the role and releases the client back to the pool in a
 * `finally`, so a thrown error never leaks an assumed role or a lingering
 * session-context setting to whichever request borrows this connection next.
 *
 * subjectType/subjectId should already be the *validated* identity from the
 * caller's JWT (see middleware/auth.js) — this function does not re-check
 * who is allowed to claim to be whom, only that identity.subject_role has a
 * role for them at all (which set_session_context itself enforces).
 */
async function withSessionContext(subjectType, subjectId, fn) {
  const client = await pool.connect();
  try {
    await client.query('SET ROLE agrolink_app');
    await client.query('SELECT security.set_session_context($1, $2)', [subjectType, subjectId]);
    return await fn(client);
  } finally {
    try {
      await client.query('RESET ROLE');
    } catch (resetErr) {
      console.error('[db] failed to RESET ROLE before releasing client', resetErr);
    }
    client.release();
  }
}

/**
 * Fire-and-forget-ish helper for audit.log_access() — call this from inside
 * an existing withSessionContext() callback (same client, same already-set
 * session context) right after a successful read/write of sensitive data.
 * Per Layer 8, audit.log_access() raises if no session context is set, so
 * this must never be called outside withSessionContext().
 */
async function logAccess(client, action, resourceType, resourceId = null) {
  await client.query('SELECT audit.log_access($1, $2, $3)', [action, resourceType, resourceId]);
}

/**
 * Like withSessionContext(), but for the one case that genuinely has no
 * subject yet: registration. There is no farmer/organization identity to
 * set app.subject_type/app.subject_id to until AFTER the INSERT returns a
 * new id — so this only does the SET ROLE agrolink_app half, and the caller
 * is responsible for calling security.set_session_context() itself once it
 * has a freshly-created id (see POST /auth/register), before calling
 * logAccess() on the same client.
 */
async function withServiceRole(fn) {
  const client = await pool.connect();
  try {
    await client.query('SET ROLE agrolink_app');
    return await fn(client);
  } finally {
    try {
      await client.query('RESET ROLE');
    } catch (resetErr) {
      console.error('[db] failed to RESET ROLE before releasing client', resetErr);
    }
    client.release();
  }
}

module.exports = { pool, withSessionContext, withServiceRole, logAccess };
