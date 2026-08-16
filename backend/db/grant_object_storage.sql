-- AgroLink -- M01 Tenant Foundation, remaining piece #2: a real object
-- storage adapter (local-disk-backed in this sandbox — a real deployment
-- would swap the disk read/write in backend/src/lib/storage.js for an S3/
-- GCS/Azure Blob client without touching this table or the routes built on
-- top of it).
--
-- Context: every existing "file upload" in this codebase before this
-- migration (see server.js's own comment on POST /machinery/photos) inlines
-- a base64 data: URL directly into a text column — workable for a handful
-- of small marketplace photos, but not a real storage layer: no
-- deduplication, no integrity check, no clean download URL, and every
-- consumer has to reinvent the same base64-encode/decode dance. This
-- migration adds ONE generic table or the platform to build on going
-- forward, plus (in the accompanying route/frontend changes) the first real
-- consumer: a cooperative's registration document (ทะเบียนสหกรณ์).
--
-- Design decision: storage.file_object is intentionally subject-type
-- agnostic (owner_subject_type/owner_subject_id mirror the identity.*
-- subject_type convention, not a FK to any one identity table — the same
-- polymorphic-by-convention shape identity.subject_role already uses) so a
-- farmer's KYC photo, a cooperative's registration document, and a lender's
-- underwriting attachment can all live in the same table without a schema
-- change each time. "purpose" is a free-form tag (not a CHECK-constrained
-- enum) for the same reason — a new module can invent its own purpose
-- string without a migration here.
--
-- Design decision: files are immutable once uploaded (no UPDATE grant on
-- storage.file_object below). Replacing a document means uploading a NEW
-- file_object row and repointing the owning table's FK at the new file_id
-- — the old row (and old bytes on disk) stay put. This gives every
-- "document history" a free audit trail for the cost of some unreferenced
-- files accumulating on disk, which is an acceptable trade in a sandbox and
-- a real deployment would run a periodic reconciliation/GC job for.
--
-- Follow-up (not built in this pass):
--   1. No GC of orphaned files (see design decision above) — fine at demo
--      scale, would need a real job in production.
--   2. No per-purpose size/content-type allowlist enforced at the DB layer
--      — backend/src/routes/storage.js enforces a flat 5MB cap and a small
--      MIME allowlist (image/*, application/pdf) for every purpose; a
--      purpose-specific policy table is future work if that's ever not
--      granular enough.
--   3. No virus/malware scanning — same "no real IdP" honesty as
--      grant_staff_and_government_access.sql's own Follow-up section; a
--      production deployment integrating a real storage backend would also
--      want a scanning step before a file is considered "clean" and
--      downloadable.
--   4. Only ONE real UI consumer is wired up (cooperative registration
--      document) — the generic POST /storage/upload + GET /storage/:id
--      routes are ready for other modules to adopt, but no other module's
--      UI calls them yet.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE IF NOT EXISTS storage.file_object (
  file_id             uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  owner_subject_type  text NOT NULL,
  owner_subject_id    uuid,
  purpose             text NOT NULL,
  original_filename   text NOT NULL,
  content_type        text NOT NULL,
  byte_size           integer NOT NULL,
  sha256_hash         text NOT NULL,
  storage_path        text NOT NULL UNIQUE,
  uploaded_by         text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT file_object_byte_size_check CHECK (byte_size > 0 AND byte_size <= 5242880),
  CONSTRAINT file_object_owner_subject_type_check
    CHECK (owner_subject_type IN ('farmer', 'organization', 'organization_member', 'government_officer', 'platform'))
);

CREATE INDEX IF NOT EXISTS idx_file_object_owner ON storage.file_object (owner_subject_type, owner_subject_id);

COMMENT ON TABLE storage.file_object IS
  'ที่เก็บ metadata ของไฟล์ที่อัปโหลด (ตัวไฟล์จริงเก็บบน local disk ที่ backend/storage_data/ — ดู backend/src/lib/storage.js) — เป็นตารางกลางที่ทุกโมดูลใช้ร่วมกันได้ ไม่ผูกกับตารางเจ้าของไฟล์ตารางใดตารางหนึ่งโดยเฉพาะ';
COMMENT ON COLUMN storage.file_object.owner_subject_type IS
  'รูปแบบเดียวกับ identity.subject_role.subject_type — ใครเป็นผู้อัปโหลด/เจ้าของไฟล์นี้ (ใช้ตรวจสิทธิ์ดาวน์โหลด ไม่ใช่ FK ไปยังตาราง identity ใดตารางหนึ่ง)';
COMMENT ON COLUMN storage.file_object.purpose IS
  'ป้ายกำกับอิสระ (ไม่ใช่ enum บังคับ) บอกว่าไฟล์นี้ใช้ทำอะไร เช่น cooperative_registration_document — โมดูลใหม่สามารถตั้งชื่อ purpose ของตัวเองได้โดยไม่ต้องแก้ตารางนี้';
COMMENT ON COLUMN storage.file_object.storage_path IS
  'พาธสัมพัทธ์ใต้ STORAGE_ROOT (ค่าเริ่มต้น backend/storage_data/) — ไม่ใช่พาธเต็มของระบบไฟล์ เพื่อให้ย้าย STORAGE_ROOT ได้โดยไม่ต้องแก้ข้อมูลในตาราง';

-- GRANT USAGE ON SCHEMA is a separate, easy-to-forget grant from the
-- table-level GRANT below (every other new-schema migration in this repo
-- needs both — see 03_grant_schema_usage.sql's own header comment) — found
-- the hard way in testing (42501 permission denied for schema storage on
-- the very first POST /storage/upload call).
GRANT USAGE ON SCHEMA storage TO agrolink_app;

-- No UPDATE/DELETE grant — see the "files are immutable" design decision
-- in the header comment above.
GRANT SELECT, INSERT ON storage.file_object TO agrolink_app;

-- ---------------------------------------------------------------------
-- First real consumer: a cooperative's registration document. Nullable —
-- every cooperative provisioned before this migration (and most after,
-- until someone uploads one) simply has no document on file yet.
-- ---------------------------------------------------------------------
ALTER TABLE registry.cooperative_profile
  ADD COLUMN IF NOT EXISTS registration_document_file_id uuid REFERENCES storage.file_object(file_id);

COMMENT ON COLUMN registry.cooperative_profile.registration_document_file_id IS
  'อ้างอิงไฟล์เอกสารจดทะเบียนสหกรณ์ที่สแกน/อัปโหลดผ่าน POST /storage/upload แล้วเชื่อมด้วย POST /coop/registration-document/link — NULL หมายถึงยังไม่มีเอกสารแนบ';
