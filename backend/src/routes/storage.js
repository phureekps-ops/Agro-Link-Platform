const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const objectStorage = require('../lib/storage');

const router = express.Router();

/**
 * Generic object storage upload/download (M01 — see backend/db/
 * grant_object_storage.sql for the storage.file_object table and the
 * design rationale). Deliberately subject-type agnostic — ANY authenticated
 * subject (farmer/organization/organization_member/government_officer/
 * platform) can upload and later download their own files, so future
 * modules (KYC photos, underwriting attachments, ...) can reuse these same
 * two routes instead of reinventing base64-in-a-text-column each time (see
 * POST /machinery/photos for the older pattern this is meant to replace
 * going forward — that route is left as-is, not retrofitted, per this
 * migration's own Follow-up note on only one real consumer being wired up
 * so far).
 *
 * Ownership: a file's owner is whoever uploaded it (owner_subject_type/
 * owner_subject_id, captured from req.subject at upload time) — only that
 * same subject, or a platform (Ops) subject, may download it or read its
 * metadata. This is intentionally a flat, generic rule at this layer; a
 * domain route that needs a DIFFERENT rule (e.g. "any government officer
 * may view this cooperative's registration document") wraps its OWN check
 * around a call to this file's metadata rather than this route trying to
 * know about cooperative_profile, gov officer scope, etc. — same
 * ownership-gating pattern used everywhere else in this codebase (route
 * validates, not a shared generic layer).
 */
router.use(requireAuth);

const MISSING_FIELDS_ERROR = { error: 'missing_required_fields', required: ['purpose', 'filename', 'content_type', 'file_base64', 'uploaded_by'] };

const DECODE_ERROR_STATUS = {
  unsupported_content_type: 400,
  content_type_mismatch: 400,
  empty_file: 400,
  file_too_large: 413,
};

/**
 * POST /storage/upload
 * Body: { purpose, filename, content_type, file_base64 }
 * file_base64 may be a bare base64 string or a full data: URL (see
 * lib/storage.js's decodeBase64Payload). Returns the new file_id plus a
 * few metadata fields the caller can show immediately without a second
 * round-trip to GET /storage/:id/meta.
 */
router.post('/upload', async (req, res, next) => {
  const { subjectType, subjectId } = req.subject;
  const {
    purpose, filename, content_type: contentType, file_base64: fileBase64, uploaded_by: uploadedBy,
  } = req.body || {};

  if (!purpose || !filename || !contentType || !fileBase64 || !uploadedBy) {
    return res.status(400).json(MISSING_FIELDS_ERROR);
  }

  let buffer;
  try {
    buffer = objectStorage.decodeBase64Payload(fileBase64, contentType);
  } catch (decodeErr) {
    const status = DECODE_ERROR_STATUS[decodeErr.message] || 400;
    return res.status(status).json({ error: decodeErr.message });
  }

  try {
    const saved = await objectStorage.saveFile(buffer, { originalFilename: filename, contentType });

    const result = await withSessionContext(subjectType, subjectId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO storage.file_object
           (owner_subject_type, owner_subject_id, purpose, original_filename, content_type, byte_size, sha256_hash, storage_path, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING file_id, byte_size, sha256_hash, created_at`,
        [subjectType, subjectId, purpose, filename, contentType, saved.byteSize, saved.sha256Hash, saved.storagePath, uploadedBy],
      );
      await logAccess(client, 'write', 'storage.file_object', rows[0].file_id);
      return rows[0];
    });

    return res.status(201).json({
      file_id: result.file_id,
      byte_size: result.byte_size,
      sha256_hash: result.sha256_hash,
      created_at: result.created_at,
    });
  } catch (err) {
    return next(err);
  }
});

/** Loads a file_object row and checks whether req.subject may access it. */
async function loadOwnedFile(client, fileId, subject) {
  const { rows } = await client.query(
    `SELECT file_id, owner_subject_type, owner_subject_id, purpose, original_filename, content_type, byte_size, sha256_hash, storage_path, uploaded_by, created_at
       FROM storage.file_object WHERE file_id = $1`,
    [fileId],
  );
  if (rows.length === 0) return { notFound: true };
  const file = rows[0];
  const isOwner = file.owner_subject_type === subject.subjectType
    && String(file.owner_subject_id) === String(subject.subjectId);
  const isPlatform = subject.subjectType === 'platform';
  if (!isOwner && !isPlatform) return { forbidden: true };
  return { file };
}

/** GET /storage/:id/meta — metadata only, no file bytes. */
router.get('/:id/meta', async (req, res, next) => {
  const { subjectType, subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext(subjectType, subjectId, async (client) => {
      const loaded = await loadOwnedFile(client, id, req.subject);
      if (loaded.file) await logAccess(client, 'read', 'storage.file_object', id);
      return loaded;
    });
    if (result.notFound) return res.status(404).json({ error: 'file_not_found' });
    if (result.forbidden) return res.status(403).json({ error: 'not_file_owner' });
    const { storage_path: _storagePath, ...meta } = result.file;
    return res.json(meta);
  } catch (err) {
    return next(err);
  }
});

/** GET /storage/:id — streams the raw file bytes back with the original Content-Type. */
router.get('/:id', async (req, res, next) => {
  const { subjectType, subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext(subjectType, subjectId, async (client) => {
      const loaded = await loadOwnedFile(client, id, req.subject);
      if (loaded.file) await logAccess(client, 'read', 'storage.file_object', id);
      return loaded;
    });
    if (result.notFound) return res.status(404).json({ error: 'file_not_found' });
    if (result.forbidden) return res.status(403).json({ error: 'not_file_owner' });

    const buffer = await objectStorage.readFile(result.file.storage_path);
    res.setHeader('Content-Type', result.file.content_type);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(result.file.original_filename)}"`);
    return res.send(buffer);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
