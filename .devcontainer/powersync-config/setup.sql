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
-- 3. Purge Status
-- Tracks which documents should be excluded from sync per role.
-- Populated by the purge preprocessing service (Agent 4).
-- ============================================================
CREATE TABLE IF NOT EXISTS v1.purge_status (
  doc_id    TEXT NOT NULL,
  role_hash TEXT NOT NULL,
  purged_at TIMESTAMP DEFAULT NOW(),
  reason    TEXT,
  PRIMARY KEY (doc_id, role_hash)
);

CREATE INDEX IF NOT EXISTS idx_purge_status_role
  ON v1.purge_status(role_hash);

-- ============================================================
-- 4. Sync-eligible documents view (materialized)
-- Contacts that are NOT purged for a given role.
-- Since Sync Streams don't support NOT IN (subquery),
-- we use INNER JOIN against this table instead.
-- Refreshed by purge preprocessor after each run.
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS v1.unpurged_contacts AS
  SELECT c._id AS doc_id, 'all' AS role_hash
  FROM v1.couchdb c
  WHERE c.doc ->> 'type' IN ('contact', 'person', 'clinic', 'health_center', 'district_hospital')
    AND NOT COALESCE(c._deleted, false)
  EXCEPT
  SELECT ps.doc_id, ps.role_hash
  FROM v1.purge_status ps;

-- Purge exclusion strategy:
-- PowerSync Sync Streams cannot do NOT IN (subquery) or LEFT JOIN.
-- Instead, when the purge preprocessor (Agent 4) inserts into purge_status,
-- a trigger checks whether ALL active roles have purged the doc. Only when
-- every role has purged it does the trigger soft-delete the couchdb row.
-- The Sync Streams already filter on _deleted != true, so universally-purged
-- docs are automatically excluded from all users.
--
-- Per-role purge (where some roles purge but others don't) is a known
-- limitation of this approach. In CHT, this mainly affects tasks/targets
-- (which are user-scoped, so role doesn't matter) and reports (where
-- per-role purge differences are rare). For the rare cross-role case,
-- the purge preprocessor should filter at the user_accessible_facilities
-- level instead of relying on soft-delete.

CREATE OR REPLACE FUNCTION v1.purge_soft_delete()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_active_roles INT;
  v_purged_roles INT;
BEGIN
  -- Count distinct active role hashes in the system
  SELECT COUNT(DISTINCT role_hash) INTO v_active_roles
  FROM v1.user_settings;

  -- Count how many distinct roles have purged this doc
  SELECT COUNT(DISTINCT role_hash) INTO v_purged_roles
  FROM v1.purge_status
  WHERE doc_id = NEW.doc_id;

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
  AFTER INSERT ON v1.purge_status
  FOR EACH ROW EXECUTE FUNCTION v1.purge_soft_delete();

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

  -- Step 5b: Add shortcodes (patient_id, place_id) directly to report_facilities.
  -- CHT reports reference subjects by shortcode (e.g., patient_id="13602").
  -- The shortcode inherits the depth of the contact it belongs to, so
  -- report_depth filtering is applied here too.
  INSERT INTO v1.user_report_facilities (user_id, facility_id)
  SELECT p_user_id, c.doc ->> 'patient_id'
  FROM v1.couchdb c
  JOIN v1.user_accessible_facilities uaf
    ON c._id = uaf.facility_id AND uaf.user_id = p_user_id
  WHERE c.doc ->> 'patient_id' IS NOT NULL
    AND NOT COALESCE(c._deleted, false)
    AND (
      uaf.depth <= (SELECT report_depth FROM v1.user_settings WHERE user_id = p_user_id)
      OR (SELECT report_depth FROM v1.user_settings WHERE user_id = p_user_id) < 0
    )
  ON CONFLICT (user_id, facility_id) DO NOTHING;

  INSERT INTO v1.user_report_facilities (user_id, facility_id)
  SELECT p_user_id, c.doc ->> 'place_id'
  FROM v1.couchdb c
  JOIN v1.user_accessible_facilities uaf
    ON c._id = uaf.facility_id AND uaf.user_id = p_user_id
  WHERE c.doc ->> 'place_id' IS NOT NULL
    AND NOT COALESCE(c._deleted, false)
    AND (
      uaf.depth <= (SELECT report_depth FROM v1.user_settings WHERE user_id = p_user_id)
      OR (SELECT report_depth FROM v1.user_settings WHERE user_id = p_user_id) < 0
    )
  ON CONFLICT (user_id, facility_id) DO NOTHING;
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
-- 7. Publication for PowerSync logical replication
-- PowerSync reads changes via the PostgreSQL WAL.
-- All tables referenced in Sync Streams must be published.
-- ============================================================
DROP PUBLICATION IF EXISTS powersync;
CREATE PUBLICATION powersync FOR TABLE
  v1.couchdb,
  v1.user_settings,
  v1.user_accessible_facilities,
  v1.user_report_facilities,
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
SELECT v1.refresh_all_user_facilities();

COMMIT;
