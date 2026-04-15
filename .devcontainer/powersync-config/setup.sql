-- PowerSync Sync Streams: PostgreSQL Supporting Tables
-- Run this after cht-sync has created the v1.couchdb base table.
--
-- These tables support the Sync Streams queries by pre-computing
-- hierarchical access (which facilities each user can see) and
-- tracking purge status (which docs to exclude per role).

BEGIN;

-- ============================================================
-- 1. User Settings
-- Maps CHT users to their facility, roles, and replication depth.
-- Populated by the auth/token service from CHT app_settings.
-- ============================================================
CREATE TABLE IF NOT EXISTS v1.user_settings (
  user_id     TEXT PRIMARY KEY,
  username    TEXT NOT NULL,
  facility_id TEXT NOT NULL,       -- user's assigned place in hierarchy
  contact_id  TEXT,                -- user's associated contact person doc
  roles       TEXT[] DEFAULT '{}', -- CHT role names (e.g., chw, chw_supervisor)
  role_hash   TEXT,                -- MD5 of sorted roles, used for purge grouping
  replication_depth INT DEFAULT -1, -- contact depth: -1 = unlimited
  report_depth      INT DEFAULT -1, -- report depth: -1 = no restriction (added in CHT 3.10)
  replicate_primary_contacts BOOLEAN DEFAULT false -- v4.18+: sync primary contacts beyond depth
);

CREATE INDEX IF NOT EXISTS idx_user_settings_facility
  ON v1.user_settings(facility_id);
CREATE INDEX IF NOT EXISTS idx_user_settings_role_hash
  ON v1.user_settings(role_hash);

-- ============================================================
-- 2. User Accessible Facilities
-- Pre-computed table of (user_id, facility_id) pairs.
-- A user can sync docs belonging to any facility in this table.
-- Maintained by refresh_accessible_facilities() below.
-- ============================================================
CREATE TABLE IF NOT EXISTS v1.user_accessible_facilities (
  user_id     TEXT NOT NULL,
  facility_id TEXT NOT NULL,
  depth       INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, facility_id)
);

CREATE INDEX IF NOT EXISTS idx_uaf_facility
  ON v1.user_accessible_facilities(facility_id);

-- ============================================================
-- 2b. User Report Facilities
-- Subset of user_accessible_facilities filtered by report_depth.
-- Reports from OTHER users are only synced for contacts within
-- this set. The user's OWN reports always sync (handled in the
-- Sync Stream query with a submitter = auth check).
-- ============================================================
CREATE TABLE IF NOT EXISTS v1.user_report_facilities (
  user_id     TEXT NOT NULL,
  facility_id TEXT NOT NULL,
  PRIMARY KEY (user_id, facility_id)
);

CREATE INDEX IF NOT EXISTS idx_urf_facility
  ON v1.user_report_facilities(facility_id);

-- ============================================================
-- 2c. Report Subjects (pre-resolved)
-- Maps each report to its single resolved subject UUID.
-- Eliminates the need for 9 OR arms and shortcodes in the
-- Sync Stream query. Also populates resolved_subject_id on couchdb.
-- Populated by refresh_report_subjects() and auto-maintained
-- by a BEFORE trigger on v1.couchdb.
-- ============================================================
CREATE TABLE IF NOT EXISTS v1.report_subjects (
  report_id  TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_report_subjects_subject
  ON v1.report_subjects(subject_id);

-- ============================================================
-- 2c-bis. Resolved Subject ID (denormalized on couchdb)
-- Stores the resolved subject UUID directly on the couchdb row.
-- Eliminates the INNER JOIN report_subjects in Sync Streams,
-- removing ~640 extra bucket keys from the JOIN dimension.
-- Maintained by the BEFORE trigger (auto_resolve_report_subject).
-- ============================================================
ALTER TABLE v1.couchdb ADD COLUMN IF NOT EXISTS resolved_subject_id TEXT;

CREATE INDEX IF NOT EXISTS idx_couchdb_resolved_subject
  ON v1.couchdb(resolved_subject_id)
  WHERE resolved_subject_id IS NOT NULL;

-- ============================================================
-- 2c-ter. Resolved Subject Place ID (denormalized on couchdb)
-- Stores the place (clinic/HC/etc.) containing the report's subject.
-- For person subjects: the person's parent._id (their clinic).
-- For place subjects: the subject_id itself.
-- Eliminates the need for person IDs in user_accessible_facilities,
-- enabling O(places) instead of O(persons) bucket counts in Sync Streams.
-- Maintained by the BEFORE trigger (auto_resolve_report_subject).
-- ============================================================
ALTER TABLE v1.couchdb ADD COLUMN IF NOT EXISTS resolved_subject_place_id TEXT;

CREATE INDEX IF NOT EXISTS idx_couchdb_resolved_subject_place
  ON v1.couchdb(resolved_subject_place_id)
  WHERE resolved_subject_place_id IS NOT NULL;

-- ============================================================
-- 2c-quat. Contact Parent Place (person → containing place lookup)
-- Maps each person contact to their parent place (clinic/HC/etc.).
-- Used by Sync Stream JOINs so that person contacts and SMS messages
-- can match against accessible_facilities (which contains only places,
-- not person IDs) without needing person IDs in the CTE.
-- Only contains person-type contacts, not places.
-- Maintained by trigger on v1.couchdb.
-- ============================================================
CREATE TABLE IF NOT EXISTS v1.contact_parent_place (
  contact_id TEXT PRIMARY KEY,
  place_id   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cpp_place
  ON v1.contact_parent_place(place_id);

-- Indexes for shortcode → UUID resolution during subject resolution.
-- Reports reference subjects by shortcode (e.g., patient_id="13602").
-- These indexes make the lookup fast during refresh_report_subjects().
CREATE INDEX IF NOT EXISTS idx_couchdb_patient_id
  ON v1.couchdb ((doc ->> 'patient_id'))
  WHERE doc ->> 'patient_id' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_couchdb_place_id
  ON v1.couchdb ((doc ->> 'place_id'))
  WHERE doc ->> 'place_id' IS NOT NULL;

-- Indexes for Sync Stream queries with purge JOIN.
-- These help PostgreSQL choose the right join order: drive from
-- couchdb (selective type/user conditions) → PK lookup into purge_status,
-- rather than scanning all purge_status rows for a role.
CREATE INDEX IF NOT EXISTS idx_couchdb_tasks_by_user
  ON v1.couchdb ((doc ->> 'user'))
  WHERE doc ->> 'type' = 'task' AND NOT COALESCE(_deleted, false);

CREATE INDEX IF NOT EXISTS idx_couchdb_reports_by_submitter
  ON v1.couchdb ((doc -> 'contact' ->> '_id'))
  WHERE doc ->> 'type' = 'data_record'
    AND doc ->> 'form' IS NOT NULL
    AND NOT COALESCE(_deleted, false);

CREATE INDEX IF NOT EXISTS idx_couchdb_targets_by_owner
  ON v1.couchdb ((doc ->> 'owner'))
  WHERE doc ->> 'type' = 'target' AND NOT COALESCE(_deleted, false);

CREATE INDEX IF NOT EXISTS idx_couchdb_reports_by_subject_place
  ON v1.couchdb (resolved_subject_place_id)
  WHERE resolved_subject_place_id IS NOT NULL
    AND NOT COALESCE(_deleted, false)
    AND doc ->> 'type' = 'data_record'
    AND doc ->> 'form' IS NOT NULL;

-- Expression statistics for JSONB conditions.
-- PostgreSQL defaults to 0.5% selectivity for JSONB ->> 'x' = 'y' expressions.
-- These statistics give the planner actual value distributions so it can
-- choose better join orders (drive from couchdb, not from purge_status).
CREATE STATISTICS IF NOT EXISTS stat_couchdb_doc_type ON (doc ->> 'type') FROM v1.couchdb;
CREATE STATISTICS IF NOT EXISTS stat_couchdb_doc_form ON (doc ->> 'form') FROM v1.couchdb;

-- ============================================================
-- 2d. Needs-signoff Visibility (pre-computed)
-- Maps each needs_signoff report to the users who should see it
-- (based on the submitter's ancestor chain matching the user's
-- accessible_facilities). Eliminates the 5-arm OR ancestor walk
-- in the Sync Stream query, reducing to 1 bucket per user.
-- Populated by refresh_needs_signoff_visibility() and auto-maintained
-- by a trigger on v1.couchdb for needs_signoff reports.
-- ============================================================
CREATE TABLE IF NOT EXISTS v1.report_needs_signoff_visible (
  report_id       TEXT NOT NULL,
  visible_to_user TEXT NOT NULL,
  PRIMARY KEY (report_id, visible_to_user)
);

CREATE INDEX IF NOT EXISTS idx_rnsv_user
  ON v1.report_needs_signoff_visible(visible_to_user);

-- ============================================================
-- 3. Purge Status
-- Tracks which documents should be excluded from sync per role.
-- Populated by the purge preprocessing service (Agent 4).
-- Schema matches public.purge_status (Agent 4's canonical definition).
--
-- SYNC STREAMS INTEGRATION:
-- PowerSync Sync Streams cannot do NOT EXISTS, NOT IN, or LEFT JOIN.
-- auth.parameter() can ONLY be used with = operator on row data.
-- Therefore, per-role purge exclusion uses INNER JOIN:
--   INNER JOIN purge_status ps ON ps.doc_id = t._id
--     AND ps.role_hash = auth.parameter('role_hash')
--     AND ps.purged = false
-- This requires EVERY purgeable doc to have a purge_status row
-- (purged=false for non-purged docs). The auto_create_purge_status
-- trigger below ensures new docs get rows immediately on INSERT.
-- ============================================================
CREATE TABLE IF NOT EXISTS v1.purge_status (
  doc_id       TEXT        NOT NULL,
  role_hash    TEXT        NOT NULL,
  purged       BOOLEAN     NOT NULL DEFAULT false,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seq          TEXT,
  aggressive   BOOLEAN     NOT NULL DEFAULT false,
  requested_by TEXT,
  reason       TEXT,
  PRIMARY KEY (doc_id, role_hash)
);

-- For Sync Streams JOIN: lookup by (doc_id, role_hash) is covered by PK.
-- Partial index for purge preprocessor: "all purged docs for this role"
CREATE INDEX IF NOT EXISTS idx_purge_status_role_purged
  ON v1.purge_status (role_hash) WHERE purged = true;

-- For incremental evaluation: "which docs were evaluated before a given time?"
CREATE INDEX IF NOT EXISTS idx_purge_status_evaluated_at
  ON v1.purge_status (evaluated_at);

-- Legacy index (kept for backward compatibility with any existing queries)
CREATE INDEX IF NOT EXISTS idx_purge_status_role
  ON v1.purge_status(role_hash);

-- ============================================================
-- 4. Purge exclusion strategy (INNER JOIN approach)
-- ============================================================
-- PowerSync Sync Streams cannot do NOT EXISTS, NOT IN, or LEFT JOIN.
-- auth.parameter() can ONLY appear with = operator against row data.
--
-- TWO-LAYER PURGE EXCLUSION:
--
-- Layer 1: Per-role purge (INNER JOIN in Sync Streams)
--   Purgeable doc types (data_record, task, target) get an INNER JOIN
--   against purge_status in each Sync Stream query:
--     INNER JOIN purge_status ps ON ps.doc_id = t._id
--       AND ps.role_hash = auth.parameter('role_hash')
--       AND ps.purged = false
--   This requires EVERY purgeable doc to have a row in purge_status.
--   New docs get rows via the auto_create_purge_status trigger below.
--   Contact queries do NOT need this JOIN (contacts are never purged).
--
-- Layer 2: Universal purge (soft-delete trigger, safety net)
--   When ALL active roles have purged a doc, the purge_soft_delete
--   trigger sets _deleted=true on the couchdb row. This catches edge
--   cases and provides a hard floor: universally-purged docs are
--   excluded from ALL streams (contacts included) via _deleted != true.

CREATE OR REPLACE FUNCTION v1.purge_soft_delete()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_active_roles INT;
  v_purged_roles INT;
BEGIN
  -- Only act when a doc is marked as purged
  IF NOT NEW.purged THEN
    RETURN NEW;
  END IF;

  -- Count distinct active role hashes in the system
  SELECT COUNT(DISTINCT role_hash) INTO v_active_roles
  FROM v1.user_settings;

  -- Count how many distinct roles have purged this doc (purged=true only)
  SELECT COUNT(DISTINCT role_hash) INTO v_purged_roles
  FROM v1.purge_status
  WHERE doc_id = NEW.doc_id
    AND purged = true;

  -- Only soft-delete when ALL active roles have purged this doc
  IF v_purged_roles >= v_active_roles THEN
    UPDATE v1.couchdb
    SET _deleted = true
    WHERE _id = NEW.doc_id
      AND NOT COALESCE(_deleted, false);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_purge_soft_delete ON v1.purge_status;
CREATE TRIGGER trg_purge_soft_delete
  AFTER INSERT OR UPDATE ON v1.purge_status
  FOR EACH ROW EXECUTE FUNCTION v1.purge_soft_delete();

-- ============================================================
-- 4b. Auto-create purge_status rows for new purgeable documents
-- Ensures new data_records, tasks, and targets get purge_status
-- rows (purged=false) for all active roles immediately on INSERT.
-- Without this, the INNER JOIN in Sync Streams would exclude new
-- docs until the purge preprocessor evaluates them.
-- Contacts are never purged and don't need rows.
-- ============================================================
CREATE OR REPLACE FUNCTION v1.auto_create_purge_status()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT COALESCE(NEW._deleted, false) THEN
    INSERT INTO v1.purge_status (doc_id, role_hash, purged, evaluated_at, reason)
    SELECT NEW._id, us.role_hash, false, NOW(), 'auto_init'
    FROM (SELECT DISTINCT role_hash FROM v1.user_settings WHERE role_hash IS NOT NULL) us
    ON CONFLICT (doc_id, role_hash) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_create_purge_status ON v1.couchdb;
CREATE TRIGGER trg_auto_create_purge_status
  AFTER INSERT ON v1.couchdb
  FOR EACH ROW
  WHEN (NEW.doc ->> 'type' IN ('data_record', 'task', 'target'))
  EXECUTE FUNCTION v1.auto_create_purge_status();

-- ============================================================
-- 5. Function: Refresh accessible facilities for one user
-- Uses recursive CTE to walk the contact hierarchy downward
-- from the user's facility_id to replication_depth levels.
-- Then adds:
--   a) Ancestors: places UP from the user's facility (parent chain)
--   b) Primary contacts: the contact person of every accessible place
--   c) User's own contact_id from user_settings
-- This implements CHT's replicate_primary_contacts behavior
-- (see api/src/services/authorization.js addPrimaryContactsSubjects).
-- ============================================================
CREATE OR REPLACE FUNCTION v1.refresh_user_facilities(p_user_id TEXT)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_facility_id TEXT;
  v_contact_id TEXT;
  v_depth INT;
BEGIN
  -- Get user's facility, contact, and depth config
  SELECT facility_id, contact_id, replication_depth
  INTO v_facility_id, v_contact_id, v_depth
  FROM v1.user_settings
  WHERE user_id = p_user_id;

  IF v_facility_id IS NULL THEN
    RETURN;
  END IF;

  -- Clear existing entries
  DELETE FROM v1.user_accessible_facilities WHERE user_id = p_user_id;

  -- Unlimited depth: -1 means sync everything below
  IF v_depth < 0 THEN
    v_depth := 100; -- effectively unlimited
  END IF;

  -- Step 1: Walk hierarchy DOWNWARD from user's facility (descendants)
  -- CHT parent field points UP (child.parent._id = parent._id)
  INSERT INTO v1.user_accessible_facilities (user_id, facility_id, depth)
  WITH RECURSIVE descendants AS (
    -- Start: the user's assigned facility
    SELECT v_facility_id AS _id, 0 AS depth

    UNION ALL

    -- Children: contacts whose parent._id matches current level
    -- Handle both formats: parent as string or parent as object
    SELECT c._id, d.depth + 1
    FROM v1.couchdb c
    JOIN descendants d ON (
      c.doc -> 'parent' ->> '_id' = d._id
      OR (jsonb_typeof(c.doc -> 'parent') = 'string' AND c.doc ->> 'parent' = d._id)
    )
    WHERE d.depth < v_depth
      AND NOT COALESCE(c._deleted, false)
      AND c.doc ->> 'type' IN ('contact', 'person', 'clinic', 'health_center', 'district_hospital')
  )
  SELECT p_user_id, _id, depth FROM descendants;

  -- Step 1.5: REMOVED — person expansion now handled at query time.
  -- Previously this step added all direct children (persons) of accessible
  -- places to the CTE, creating ~8,000 entries per user at production scale.
  -- Now, person contacts are matched via INNER JOIN contact_parent_place in
  -- the Sync Stream queries, and reports match via resolved_subject_place_id.
  -- This reduces CTE entries from O(persons) to O(places): ~55 vs ~8,055.

  -- Step 2: Walk hierarchy UPWARD from user's facility (ancestors)
  -- Adds parent places so user can see their HC, county, etc.
  -- Ancestors get depth 0 (same as facility) since they're structural.
  INSERT INTO v1.user_accessible_facilities (user_id, facility_id, depth)
  WITH RECURSIVE ancestors AS (
    -- Start: parent of user's facility
    SELECT
      CASE
        WHEN jsonb_typeof(c.doc -> 'parent') = 'object' THEN c.doc -> 'parent' ->> '_id'
        WHEN jsonb_typeof(c.doc -> 'parent') = 'string' THEN c.doc ->> 'parent'
      END AS _id
    FROM v1.couchdb c
    WHERE c._id = v_facility_id
      AND NOT COALESCE(c._deleted, false)

    UNION ALL

    -- Walk up: each ancestor's parent
    SELECT
      CASE
        WHEN jsonb_typeof(c.doc -> 'parent') = 'object' THEN c.doc -> 'parent' ->> '_id'
        WHEN jsonb_typeof(c.doc -> 'parent') = 'string' THEN c.doc ->> 'parent'
      END
    FROM v1.couchdb c
    JOIN ancestors a ON c._id = a._id
    WHERE a._id IS NOT NULL
      AND NOT COALESCE(c._deleted, false)
  )
  SELECT p_user_id, _id, 0
  FROM ancestors
  WHERE _id IS NOT NULL
  ON CONFLICT (user_id, facility_id) DO NOTHING;

  -- Step 3: Add primary contacts of all accessible places
  -- Each place's doc.contact._id is its primary contact person.
  -- CHT's addPrimaryContactsSubjects adds these to subjectIds.
  -- The primary contact inherits the depth of its parent place.
  INSERT INTO v1.user_accessible_facilities (user_id, facility_id, depth)
  SELECT DISTINCT p_user_id,
    CASE
      WHEN jsonb_typeof(c.doc -> 'contact') = 'object' THEN c.doc -> 'contact' ->> '_id'
      WHEN jsonb_typeof(c.doc -> 'contact') = 'string' THEN c.doc ->> 'contact'
    END,
    uaf.depth  -- inherit depth from the place (for report_depth filtering)
  FROM v1.couchdb c
  JOIN v1.user_accessible_facilities uaf ON c._id = uaf.facility_id AND uaf.user_id = p_user_id
  WHERE c.doc -> 'contact' IS NOT NULL
    AND NOT COALESCE(c._deleted, false)
    AND c.doc ->> 'type' IN ('contact', 'clinic', 'health_center', 'district_hospital')
    AND CASE
      WHEN jsonb_typeof(c.doc -> 'contact') = 'object' THEN c.doc -> 'contact' ->> '_id'
      WHEN jsonb_typeof(c.doc -> 'contact') = 'string' THEN c.doc ->> 'contact'
    END IS NOT NULL
  ON CONFLICT (user_id, facility_id) DO NOTHING;

  -- Step 4: Always include the user's own contact person
  -- (from user_settings.contact_id)
  IF v_contact_id IS NOT NULL THEN
    INSERT INTO v1.user_accessible_facilities (user_id, facility_id, depth)
    VALUES (p_user_id, v_contact_id, 0)
    ON CONFLICT (user_id, facility_id) DO NOTHING;
  END IF;

  -- Step 5: Populate user_report_facilities (report_depth-filtered subset)
  -- PowerSync only allows = comparisons with auth parameters, so we
  -- pre-compute the depth filter here instead of in the Sync Stream CTE.
  --
  -- NOTE: Shortcodes (patient_id, place_id) are added ONLY to
  -- user_report_facilities, NOT to user_accessible_facilities. This is
  -- because accessible_facilities is used by contacts, targets, and
  -- sms_messages streams which match by _id (always a UUID). Putting
  -- shortcodes there creates empty PowerSync buckets — one per shortcode
  -- per stream — wasting bandwidth and counting against the 1,000 bucket
  -- limit per user.
  DELETE FROM v1.user_report_facilities WHERE user_id = p_user_id;

  -- Step 5a: Copy UUIDs from accessible_facilities, filtered by report_depth
  INSERT INTO v1.user_report_facilities (user_id, facility_id)
  SELECT p_user_id, facility_id
  FROM v1.user_accessible_facilities
  WHERE user_id = p_user_id
    AND (
      depth <= (SELECT report_depth FROM v1.user_settings WHERE user_id = p_user_id)
      OR (SELECT report_depth FROM v1.user_settings WHERE user_id = p_user_id) < 0
    );

  -- Step 5b: REMOVED — shortcodes no longer needed in user_report_facilities.
  -- Subject resolution is now handled by resolved_subject_id on the couchdb
  -- row (denormalized from report_subjects). The all_data Sync Stream query
  -- uses reports.resolved_subject_id IN accessible_facilities (no JOIN).
  -- user_report_facilities is retained but no longer referenced in Sync Streams.
END;
$$;

-- ============================================================
-- 6. Function: Refresh accessible facilities for ALL users
-- Call after hierarchy changes or user role updates.
-- ============================================================
CREATE OR REPLACE FUNCTION v1.refresh_all_user_facilities()
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_user RECORD;
BEGIN
  FOR v_user IN SELECT user_id FROM v1.user_settings LOOP
    PERFORM v1.refresh_user_facilities(v_user.user_id);
  END LOOP;
END;
$$;

-- ============================================================
-- 7. Report Subject Resolution
-- Resolves a report's subject to a single UUID by following
-- CHT's getSubject() priority chain:
--   patient_id → fields.patient_id → place_id → fields.place_id
--   → patient_uuid → fields.patient_uuid → place_uuid
--   → fields.place_uuid → contact._id
-- Shortcodes (patient_id, place_id) are resolved by looking up
-- the contact whose shortcode matches.
-- ============================================================
CREATE OR REPLACE FUNCTION v1.resolve_report_subject(p_doc JSONB)
RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    -- 1. patient_id shortcode → contact UUID
    (SELECT c._id FROM v1.couchdb c
     WHERE c.doc ->> 'patient_id' = p_doc ->> 'patient_id'
       AND p_doc ->> 'patient_id' IS NOT NULL AND p_doc ->> 'patient_id' != ''
       AND NOT COALESCE(c._deleted, false)
       AND c.doc ->> 'type' IN ('contact', 'person', 'clinic', 'health_center', 'district_hospital')
     LIMIT 1),
    -- 2. fields.patient_id shortcode → contact UUID
    (SELECT c._id FROM v1.couchdb c
     WHERE c.doc ->> 'patient_id' = p_doc -> 'fields' ->> 'patient_id'
       AND p_doc -> 'fields' ->> 'patient_id' IS NOT NULL
       AND p_doc -> 'fields' ->> 'patient_id' != ''
       AND NOT COALESCE(c._deleted, false)
       AND c.doc ->> 'type' IN ('contact', 'person', 'clinic', 'health_center', 'district_hospital')
     LIMIT 1),
    -- 3. place_id shortcode → place UUID
    (SELECT c._id FROM v1.couchdb c
     WHERE c.doc ->> 'place_id' = p_doc ->> 'place_id'
       AND p_doc ->> 'place_id' IS NOT NULL AND p_doc ->> 'place_id' != ''
       AND NOT COALESCE(c._deleted, false)
       AND c.doc ->> 'type' IN ('contact', 'person', 'clinic', 'health_center', 'district_hospital')
     LIMIT 1),
    -- 4. fields.place_id shortcode → place UUID
    (SELECT c._id FROM v1.couchdb c
     WHERE c.doc ->> 'place_id' = p_doc -> 'fields' ->> 'place_id'
       AND p_doc -> 'fields' ->> 'place_id' IS NOT NULL
       AND p_doc -> 'fields' ->> 'place_id' != ''
       AND NOT COALESCE(c._deleted, false)
       AND c.doc ->> 'type' IN ('contact', 'person', 'clinic', 'health_center', 'district_hospital')
     LIMIT 1),
    -- 5-9: UUID fields (no resolution needed, use directly)
    NULLIF(p_doc ->> 'patient_uuid', ''),
    NULLIF(p_doc -> 'fields' ->> 'patient_uuid', ''),
    NULLIF(p_doc ->> 'place_uuid', ''),
    NULLIF(p_doc -> 'fields' ->> 'place_uuid', ''),
    NULLIF(p_doc -> 'contact' ->> '_id', '')
  );
$$;

-- ============================================================
-- 7b. Resolve Subject Place
-- Given a resolved subject_id (from resolve_report_subject),
-- returns the containing PLACE:
--   - If subject is a person → parent._id (the clinic/area)
--   - If subject is a place → subject itself
-- This enables Sync Stream queries to match reports against
-- accessible_facilities using only place IDs (not person IDs).
-- ============================================================
CREATE OR REPLACE FUNCTION v1.resolve_subject_place(p_subject_id TEXT)
RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT CASE
    -- Legacy person type → return parent place
    WHEN c.doc ->> 'type' = 'person' THEN
      COALESCE(c.doc -> 'parent' ->> '_id', c.doc ->> 'parent')
    -- Legacy place types → return self
    WHEN c.doc ->> 'type' IN ('clinic', 'health_center', 'district_hospital') THEN
      c._id
    -- Modern CHT (type='contact'): check contact_type
    -- contact_type='person' (or unset) → person → return parent
    WHEN c.doc ->> 'type' = 'contact'
         AND COALESCE(c.doc ->> 'contact_type', 'person') = 'person' THEN
      COALESCE(c.doc -> 'parent' ->> '_id', c.doc ->> 'parent')
    -- Anything else (place contact_type) → return self
    ELSE c._id
  END
  FROM v1.couchdb c
  WHERE c._id = p_subject_id
    AND NOT COALESCE(c._deleted, false)
  LIMIT 1;
$$;

-- Batch-refresh all report subjects. Call after data loads or
-- when contacts change (shortcode→UUID mapping may change).
-- Also syncs resolved_subject_id on the couchdb rows to match.
CREATE OR REPLACE FUNCTION v1.refresh_report_subjects()
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  TRUNCATE v1.report_subjects;

  INSERT INTO v1.report_subjects (report_id, subject_id)
  SELECT report_id, subject_id
  FROM (
    SELECT r._id AS report_id,
           v1.resolve_report_subject(r.doc) AS subject_id
    FROM v1.couchdb r
    WHERE r.doc ->> 'type' = 'data_record'
      AND r.doc ->> 'form' IS NOT NULL
      AND NOT COALESCE(r._deleted, false)
  ) resolved
  WHERE subject_id IS NOT NULL;

  -- Sync resolved_subject_id on couchdb rows to match report_subjects.
  -- This keeps the denormalized column consistent after batch re-resolves
  -- (e.g., when a contact's shortcode changes and the UUID mapping shifts).
  -- Uses a direct UPDATE (not the BEFORE trigger path) since we already
  -- have the resolved values in report_subjects.
  UPDATE v1.couchdb c
  SET resolved_subject_id = rs.subject_id
  FROM v1.report_subjects rs
  WHERE rs.report_id = c._id
    AND c.resolved_subject_id IS DISTINCT FROM rs.subject_id;

  -- Clear resolved_subject_id for reports that no longer resolve
  -- (removed from report_subjects because subject_id became NULL).
  UPDATE v1.couchdb c
  SET resolved_subject_id = NULL
  WHERE c.doc ->> 'type' = 'data_record'
    AND c.doc ->> 'form' IS NOT NULL
    AND NOT COALESCE(c._deleted, false)
    AND c.resolved_subject_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM v1.report_subjects rs WHERE rs.report_id = c._id
    );

  -- Batch-populate resolved_subject_place_id from resolved_subject_id.
  -- For each report, looks up the subject and determines the containing place:
  --   person subject → parent._id (clinic), place subject → self.
  UPDATE v1.couchdb c
  SET resolved_subject_place_id = CASE
    WHEN subj.doc ->> 'type' = 'person' THEN
      COALESCE(subj.doc -> 'parent' ->> '_id', subj.doc ->> 'parent')
    WHEN subj.doc ->> 'type' IN ('clinic', 'health_center', 'district_hospital') THEN
      subj._id
    WHEN subj.doc ->> 'type' = 'contact'
         AND COALESCE(subj.doc ->> 'contact_type', 'person') = 'person' THEN
      COALESCE(subj.doc -> 'parent' ->> '_id', subj.doc ->> 'parent')
    ELSE subj._id
  END
  FROM v1.couchdb subj
  WHERE subj._id = c.resolved_subject_id
    AND NOT COALESCE(subj._deleted, false)
    AND c.doc ->> 'type' = 'data_record'
    AND c.doc ->> 'form' IS NOT NULL
    AND NOT COALESCE(c._deleted, false)
    AND c.resolved_subject_id IS NOT NULL;

  -- Clear resolved_subject_place_id for reports without subjects
  UPDATE v1.couchdb c
  SET resolved_subject_place_id = NULL
  WHERE c.doc ->> 'type' = 'data_record'
    AND c.doc ->> 'form' IS NOT NULL
    AND NOT COALESCE(c._deleted, false)
    AND c.resolved_subject_id IS NULL
    AND c.resolved_subject_place_id IS NOT NULL;
END;
$$;

-- Auto-resolve trigger: keeps report_subjects in sync with couchdb.
-- Fires only for data_records (reports) to minimize overhead.
CREATE OR REPLACE FUNCTION v1.auto_resolve_report_subject()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_subject_id TEXT;
  v_subject_place_id TEXT;
BEGIN
  IF NEW.doc ->> 'form' IS NOT NULL AND NOT COALESCE(NEW._deleted, false) THEN
    v_subject_id := v1.resolve_report_subject(NEW.doc);
    -- Denormalize onto the couchdb row (BEFORE trigger can modify NEW directly)
    NEW.resolved_subject_id := v_subject_id;
    IF v_subject_id IS NOT NULL THEN
      -- Resolve the containing place (person→parent, place→self)
      v_subject_place_id := v1.resolve_subject_place(v_subject_id);
      NEW.resolved_subject_place_id := v_subject_place_id;
      INSERT INTO v1.report_subjects (report_id, subject_id)
      VALUES (NEW._id, v_subject_id)
      ON CONFLICT (report_id) DO UPDATE SET subject_id = EXCLUDED.subject_id;
    ELSE
      NEW.resolved_subject_place_id := NULL;
      DELETE FROM v1.report_subjects WHERE report_id = NEW._id;
    END IF;
  ELSIF COALESCE(NEW._deleted, false) THEN
    NEW.resolved_subject_id := NULL;
    NEW.resolved_subject_place_id := NULL;
    DELETE FROM v1.report_subjects WHERE report_id = NEW._id;
  END IF;
  RETURN NEW;
END;
$$;

-- BEFORE trigger: sets resolved_subject_id in-place (no recursive UPDATE needed).
-- Also maintains report_subjects table for backward compatibility.
DROP TRIGGER IF EXISTS trg_auto_resolve_report_subject ON v1.couchdb;
CREATE TRIGGER trg_auto_resolve_report_subject
  BEFORE INSERT OR UPDATE ON v1.couchdb
  FOR EACH ROW
  WHEN (NEW.doc ->> 'type' = 'data_record')
  EXECUTE FUNCTION v1.auto_resolve_report_subject();

-- ============================================================
-- 7c. Contact Parent Place Trigger
-- Maintains contact_parent_place for person-type contacts.
-- When a person is inserted/updated, stores their parent place.
-- Only persons are tracked (not place contacts like clinics).
-- ============================================================
CREATE OR REPLACE FUNCTION v1.auto_update_contact_parent_place()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_place_id TEXT;
  v_is_person BOOLEAN;
BEGIN
  -- Determine if this contact is a person
  v_is_person := (
    NEW.doc ->> 'type' = 'person'
    OR (
      NEW.doc ->> 'type' = 'contact'
      AND COALESCE(NEW.doc ->> 'contact_type', 'person') = 'person'
    )
  );

  IF NOT COALESCE(NEW._deleted, false) AND v_is_person THEN
    v_place_id := COALESCE(NEW.doc -> 'parent' ->> '_id', NEW.doc ->> 'parent');
    IF v_place_id IS NOT NULL THEN
      INSERT INTO v1.contact_parent_place (contact_id, place_id)
      VALUES (NEW._id, v_place_id)
      ON CONFLICT (contact_id) DO UPDATE SET place_id = EXCLUDED.place_id;
    ELSE
      DELETE FROM v1.contact_parent_place WHERE contact_id = NEW._id;
    END IF;
  ELSE
    -- Deleted or not a person — remove from lookup
    DELETE FROM v1.contact_parent_place WHERE contact_id = NEW._id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_update_contact_parent_place ON v1.couchdb;
CREATE TRIGGER trg_auto_update_contact_parent_place
  AFTER INSERT OR UPDATE ON v1.couchdb
  FOR EACH ROW
  WHEN (NEW.doc ->> 'type' IN ('contact', 'person', 'clinic', 'health_center', 'district_hospital'))
  EXECUTE FUNCTION v1.auto_update_contact_parent_place();

-- ============================================================
-- 8. Needs-signoff Visibility
-- Pre-computes which users can see each needs_signoff report.
-- For each such report, walks the submitter's ancestor chain
-- (up to 5 levels via recursive CTE), then finds all users
-- whose accessible_facilities include any of those ancestors.
-- ============================================================
CREATE OR REPLACE FUNCTION v1.refresh_needs_signoff_visibility()
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  TRUNCATE v1.report_needs_signoff_visible;

  INSERT INTO v1.report_needs_signoff_visible (report_id, visible_to_user)
  SELECT DISTINCT r._id, uaf.user_id
  FROM v1.couchdb r
  CROSS JOIN LATERAL (
    -- Walk submitter's ancestor chain (recursive, up to 5 levels)
    WITH RECURSIVE chain AS (
      SELECT r.doc -> 'contact' ->> '_id' AS ancestor_id, 0 AS lvl
      UNION ALL
      SELECT
        CASE
          WHEN jsonb_typeof(c.doc -> 'parent') = 'object' THEN c.doc -> 'parent' ->> '_id'
          WHEN jsonb_typeof(c.doc -> 'parent') = 'string' THEN c.doc ->> 'parent'
        END,
        chain.lvl + 1
      FROM chain
      JOIN v1.couchdb c ON c._id = chain.ancestor_id
      WHERE chain.lvl < 5
        AND chain.ancestor_id IS NOT NULL
        AND NOT COALESCE(c._deleted, false)
    )
    SELECT ancestor_id FROM chain WHERE ancestor_id IS NOT NULL
  ) ancestors
  JOIN v1.user_accessible_facilities uaf ON uaf.facility_id = ancestors.ancestor_id
  WHERE NOT COALESCE(r._deleted, false)
    AND r.doc ->> 'type' = 'data_record'
    AND r.doc ->> 'form' IS NOT NULL
    AND r.doc -> 'fields' ->> 'needs_signoff' = 'true'
    AND r.doc -> 'contact' ->> '_id' IS NOT NULL;
END;
$$;

-- Single-report refresh: used by the auto-trigger when a needs_signoff
-- report is inserted or updated.
CREATE OR REPLACE FUNCTION v1.refresh_single_needs_signoff(p_report_id TEXT, p_contact_id TEXT)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM v1.report_needs_signoff_visible WHERE report_id = p_report_id;

  IF p_contact_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO v1.report_needs_signoff_visible (report_id, visible_to_user)
  SELECT DISTINCT p_report_id, uaf.user_id
  FROM (
    WITH RECURSIVE chain AS (
      SELECT p_contact_id AS ancestor_id, 0 AS lvl
      UNION ALL
      SELECT
        CASE
          WHEN jsonb_typeof(c.doc -> 'parent') = 'object' THEN c.doc -> 'parent' ->> '_id'
          WHEN jsonb_typeof(c.doc -> 'parent') = 'string' THEN c.doc ->> 'parent'
        END,
        chain.lvl + 1
      FROM chain
      JOIN v1.couchdb c ON c._id = chain.ancestor_id
      WHERE chain.lvl < 5
        AND chain.ancestor_id IS NOT NULL
        AND NOT COALESCE(c._deleted, false)
    )
    SELECT ancestor_id FROM chain WHERE ancestor_id IS NOT NULL
  ) ancestors
  JOIN v1.user_accessible_facilities uaf ON uaf.facility_id = ancestors.ancestor_id;
END;
$$;

-- Auto-trigger: keeps report_needs_signoff_visible in sync with couchdb.
-- Fires only for data_records (same WHEN clause as report_subjects trigger).
CREATE OR REPLACE FUNCTION v1.auto_refresh_needs_signoff()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.doc -> 'fields' ->> 'needs_signoff' = 'true'
     AND NEW.doc ->> 'form' IS NOT NULL
     AND NOT COALESCE(NEW._deleted, false) THEN
    PERFORM v1.refresh_single_needs_signoff(NEW._id, NEW.doc -> 'contact' ->> '_id');
  ELSE
    -- Not a needs_signoff report (or deleted) — remove any existing visibility rows
    DELETE FROM v1.report_needs_signoff_visible WHERE report_id = NEW._id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_refresh_needs_signoff ON v1.couchdb;
CREATE TRIGGER trg_auto_refresh_needs_signoff
  AFTER INSERT OR UPDATE ON v1.couchdb
  FOR EACH ROW
  WHEN (NEW.doc ->> 'type' = 'data_record')
  EXECUTE FUNCTION v1.auto_refresh_needs_signoff();

-- ============================================================
-- 9. Publication for PowerSync logical replication
-- PowerSync reads changes via the PostgreSQL WAL.
-- All tables referenced in Sync Streams must be published.
-- ============================================================
DROP PUBLICATION IF EXISTS powersync;
CREATE PUBLICATION powersync FOR TABLE
  v1.couchdb,
  v1.user_settings,
  v1.user_accessible_facilities,
  v1.user_report_facilities,
  v1.report_subjects,
  v1.report_needs_signoff_visible,
  v1.contact_parent_place,
  v1.purge_status;

-- ============================================================
-- 8. Seed test data: user_settings for development
-- Maps to the test hierarchy in the couchdb table.
-- ============================================================
INSERT INTO v1.user_settings (user_id, username, facility_id, contact_id, roles, role_hash,
                              replication_depth, report_depth, replicate_primary_contacts)
VALUES
  -- CHW assigned to Kibera Clinic A
  -- contact depth 1 (sees clinic + direct patients), report_depth 1
  ('org.couchdb.user:chw_user', 'chw_user',
   '3ec4f112db4527a356e1aa8593002eb1', -- Kibera Clinic A
   '3ec4f112db4527a356e1aa8593002fc0', -- Bob (the CHW)
   ARRAY['chw'], md5('chw'), 1, 1, false),

  -- Supervisor at Kibera Health Center
  -- contact depth 2, report_depth 1, replicate_primary_contacts enabled
  ('org.couchdb.user:supervisor_user', 'supervisor_user',
   '3ec4f112db4527a356e1aa8593001f1e', -- Kibera Health Center
   NULL,
   ARRAY['chw_supervisor'], md5('chw_supervisor'), 2, 1, true),

  -- County admin at Nairobi County, unlimited depth
  ('org.couchdb.user:county_admin', 'county_admin',
   '3ec4f112db4527a356e1aa8593001299', -- Nairobi County
   NULL,
   ARRAY['national_admin'], md5('national_admin'), -1, -1, false)
ON CONFLICT (user_id) DO NOTHING;

-- Compute accessible facilities for seed users
-- (Step 1.5 removed — CTE now contains only places, not persons)
SELECT v1.refresh_all_user_facilities();

-- Batch-populate contact_parent_place (person → parent place lookup)
-- Used by Sync Stream JOINs for person contacts and SMS matching.
TRUNCATE v1.contact_parent_place;
INSERT INTO v1.contact_parent_place (contact_id, place_id)
SELECT c._id, COALESCE(c.doc -> 'parent' ->> '_id', c.doc ->> 'parent')
FROM v1.couchdb c
WHERE NOT COALESCE(c._deleted, false)
  AND (
    c.doc ->> 'type' = 'person'
    OR (c.doc ->> 'type' = 'contact'
        AND COALESCE(c.doc ->> 'contact_type', 'person') = 'person')
  )
  AND COALESCE(c.doc -> 'parent' ->> '_id', c.doc ->> 'parent') IS NOT NULL
ON CONFLICT (contact_id) DO NOTHING;

-- Pre-resolve report subjects (shortcode → UUID mapping)
-- Also populates resolved_subject_id and resolved_subject_place_id
SELECT v1.refresh_report_subjects();

-- Pre-compute needs_signoff visibility (ancestor chain → user mapping)
SELECT v1.refresh_needs_signoff_visibility();

-- Bulk-populate purge_status for all existing purgeable documents.
-- Creates (doc_id, role_hash, purged=false) for every data_record, task,
-- and target doc × every active role_hash. This ensures the Sync Streams
-- INNER JOIN includes existing docs that haven't been evaluated by the
-- purge preprocessor yet.
INSERT INTO v1.purge_status (doc_id, role_hash, purged, evaluated_at, reason)
SELECT c._id, us.role_hash, false, NOW(), 'bulk_init'
FROM v1.couchdb c
CROSS JOIN (SELECT DISTINCT role_hash FROM v1.user_settings WHERE role_hash IS NOT NULL) us
WHERE NOT COALESCE(c._deleted, false)
  AND c.doc ->> 'type' IN ('data_record', 'task', 'target')
ON CONFLICT (doc_id, role_hash) DO NOTHING;

COMMIT;
