-- PowerSync Bucket Semantics Test: Seed Data
-- Creates bucket_test_user with exactly 15 accessible facilities
-- and matching couchdb documents for the 5-experiment test config.
--
-- Run: docker exec -i cht-postgres psql -U cht -d cht < bucket-test-setup.sql
-- Verify: SELECT count(*) FROM v1.user_accessible_facilities
--         WHERE user_id = 'org.couchdb.user:bucket_test_user';  -- expect 15

BEGIN;

-- Test user in user_settings
INSERT INTO v1.user_settings (
  user_id, username, facility_id, contact_id,
  roles, role_hash, replication_depth, report_depth
) VALUES (
  'org.couchdb.user:bucket_test_user',
  'bucket_test_user',
  'bucket-test-facility-root',
  'bucket-test-contact-1',
  ARRAY['chw'],
  md5('chw'),
  1,
  1
) ON CONFLICT (user_id) DO NOTHING;

-- Exactly 15 accessible facilities (known count for unambiguous bucket measurement)
DELETE FROM v1.user_accessible_facilities
WHERE user_id = 'org.couchdb.user:bucket_test_user';

INSERT INTO v1.user_accessible_facilities (user_id, facility_id, depth)
SELECT
  'org.couchdb.user:bucket_test_user',
  'bucket-test-fac-' || lpad(n::text, 3, '0'),
  0
FROM generate_series(1, 15) AS n;

-- 15 matching contact documents in v1.couchdb
-- These have type=contact so JOIN/subquery/CTE experiments can find rows.
-- They also have a 'user' field matching the test user for exp1_direct.
INSERT INTO v1.couchdb (_id, doc, _deleted)
SELECT
  'bucket-test-fac-' || lpad(n::text, 3, '0'),
  jsonb_build_object(
    '_id', 'bucket-test-fac-' || lpad(n::text, 3, '0'),
    'type', 'contact',
    'contact_type', 'clinic',
    'name', 'Test Clinic ' || n,
    'user', 'org.couchdb.user:bucket_test_user'
  ),
  false
FROM generate_series(1, 15) AS n
ON CONFLICT (_id) DO UPDATE SET doc = EXCLUDED.doc, _deleted = false;

-- 1 extra doc matching only the direct auth filter (exp1_direct control)
INSERT INTO v1.couchdb (_id, doc, _deleted)
VALUES (
  'bucket-test-direct-match',
  '{"_id":"bucket-test-direct-match","type":"contact","user":"org.couchdb.user:bucket_test_user","name":"Direct Auth Match"}'::jsonb,
  false
) ON CONFLICT (_id) DO UPDATE SET doc = EXCLUDED.doc, _deleted = false;

COMMIT;

-- Verification queries
SELECT 'user_accessible_facilities count' AS check,
       count(*)::text AS result
FROM v1.user_accessible_facilities
WHERE user_id = 'org.couchdb.user:bucket_test_user'
UNION ALL
SELECT 'couchdb test docs count',
       count(*)::text
FROM v1.couchdb
WHERE _id LIKE 'bucket-test-%' AND _deleted = false;
