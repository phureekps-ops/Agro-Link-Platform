const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

/**
 * Local-disk-backed object storage adapter (see backend/db/grant_object_
 * storage.sql for the storage.file_object metadata table this writes
 * alongside). Every function here is deliberately the ONLY place that
 * touches the filesystem for uploads — swapping this file's internals for
 * an S3/GCS/Azure Blob client is the entire migration path to a real
 * storage backend; nothing in routes/storage.js or any other route needs
 * to change.
 *
 * STORAGE_ROOT defaults to backend/storage_data/ (sibling of src/), created
 * on first use if missing. Override with the STORAGE_ROOT env var (e.g. to
 * point at a mounted volume in a real deployment).
 */
const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(__dirname, '..', '..', 'storage_data');

const MAX_BYTES = 5 * 1024 * 1024; // 5MB — matches the file_object_byte_size_check DB constraint and express.json's own 5mb body limit (server.js).

// Small allowlist rather than accepting any content_type — this sandbox
// only ever needs scanned documents/photos, not arbitrary file types.
const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
]);

function ensureStorageRoot() {
  if (!fs.existsSync(STORAGE_ROOT)) {
    fs.mkdirSync(STORAGE_ROOT, { recursive: true });
  }
}

/**
 * Decodes a data: URL or bare base64 string into a Buffer, validating size
 * and (if a data: URL) the declared MIME type against ALLOWED_CONTENT_TYPES.
 * Throws a plain Error with a short machine-readable message — routes map
 * these to 400 responses, same shape as every other validation error in
 * this codebase.
 */
function decodeBase64Payload(fileBase64, contentType) {
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error('unsupported_content_type');
  }
  let raw = fileBase64;
  const dataUrlMatch = /^data:([^;]+);base64,(.*)$/s.exec(fileBase64);
  if (dataUrlMatch) {
    if (dataUrlMatch[1] !== contentType) {
      throw new Error('content_type_mismatch');
    }
    raw = dataUrlMatch[2];
  }
  const buffer = Buffer.from(raw, 'base64');
  if (buffer.length === 0) {
    throw new Error('empty_file');
  }
  if (buffer.length > MAX_BYTES) {
    throw new Error('file_too_large');
  }
  return buffer;
}

/**
 * Writes `buffer` to disk under a content-addressed-ish filename (random
 * UUID, not the sha256 itself — two different uploads of the same bytes
 * get two distinct file_object rows/files, matching the "files are
 * immutable, never deduplicated" design decision in the migration's header
 * comment) and returns everything the caller needs to INSERT a storage.
 * file_object row.
 */
async function saveFile(buffer, { originalFilename, contentType }) {
  ensureStorageRoot();
  const sha256Hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const ext = path.extname(originalFilename || '').slice(0, 10).replace(/[^a-zA-Z0-9.]/g, '');
  const storagePath = `${crypto.randomUUID()}${ext}`;
  const absolutePath = path.join(STORAGE_ROOT, storagePath);
  await fsp.writeFile(absolutePath, buffer);
  return { storagePath, sha256Hash, byteSize: buffer.length };
}

async function readFile(storagePath) {
  const absolutePath = path.join(STORAGE_ROOT, storagePath);
  return fsp.readFile(absolutePath);
}

module.exports = {
  STORAGE_ROOT,
  MAX_BYTES,
  ALLOWED_CONTENT_TYPES,
  decodeBase64Payload,
  saveFile,
  readFile,
};
