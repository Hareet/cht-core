#!/bin/bash
# verify-pg-adapter.sh — Compares CouchDB and PostgreSQL adapter query results.
# Requires: COUCH_URL env var, postgres accessible at postgres:5432 (user=cht, pass=pgpass)
#
# Usage: bash scripts/verify-pg-adapter.sh

set -euo pipefail

export PGPASSWORD=pgpass
pg() { psql -h postgres -U cht -d cht -t -A -c "$1"; }
PASS=0
FAIL=0
TESTS=()

source /tmp/test-ids.env 2>/dev/null || {
  echo "ERROR: /tmp/test-ids.env not found. Create test data first."
  exit 1
}

compare() {
  local name="$1"
  local couch_result="$2"
  local pg_result="$3"

  # Normalize whitespace
  couch_result=$(echo "$couch_result" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$')
  pg_result=$(echo "$pg_result" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$')

  if [ "$couch_result" = "$pg_result" ]; then
    echo "  PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $name"
    echo "    CouchDB: $couch_result"
    echo "    Postgres: $pg_result"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== cht-datasource PostgreSQL Adapter Verification ==="
echo ""

# --- Test 1: getDocById ---
echo "[1] getDocById"
COUCH=$(curl -s "$COUCH_URL/$PERSON_ID" | python3 -c "import sys,json; print(json.load(sys.stdin)['_id'])")
PG=$(pg "SELECT doc->>'_id' FROM v1.couchdb WHERE _id = '$PERSON_ID' AND (_deleted IS NULL OR _deleted = false);")
compare "person by ID" "$COUCH" "$PG"

# --- Test 2: getDocById 404 ---
COUCH=$(curl -s "$COUCH_URL/nonexistent" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error',''))")
PG_COUNT=$(pg "SELECT COUNT(*) FROM v1.couchdb WHERE _id = 'nonexistent' AND (_deleted IS NULL OR _deleted = false);")
PG_RESULT=$([ "$PG_COUNT" = "0" ] && echo "not_found" || echo "found")
compare "missing doc returns not_found" "$COUCH" "$PG_RESULT"

# --- Test 3: contacts_by_type person IDs ---
echo "[2] queryDocIdsByType (contacts_by_type)"
COUCH=$(curl -s "$COUCH_URL/_design/medic-client/_view/contacts_by_type?key=%5B%22person%22%5D&include_docs=false" | python3 -c "
import sys, json
for row in json.load(sys.stdin)['rows']: print(row['id'])")
PG=$(pg "
SELECT _id FROM v1.couchdb
WHERE COALESCE(doc->>'contact_type', doc->>'type') = 'person'
  AND (_deleted IS NULL OR _deleted = false)
ORDER BY _id;")
compare "person IDs" "$COUCH" "$PG"

# --- Test 4: contacts_by_type sort order ---
echo "[3] contacts_by_type sort order (all types)"
COUCH=$(curl -s "$COUCH_URL/_design/medic-client/_view/contacts_by_type?include_docs=false" | python3 -c "
import sys, json
for row in json.load(sys.stdin)['rows']: print(row['id'])")
PG=$(pg "
SELECT _id FROM v1.couchdb
WHERE doc->>'type' IN ('person','clinic','health_center','district_hospital','contact')
  AND (_deleted IS NULL OR _deleted = false)
ORDER BY COALESCE(doc->>'contact_type', doc->>'type'), _id;")
compare "all contacts sorted by type,_id" "$COUCH" "$PG"

# --- Test 5: Lineage — clinic ---
echo "[4] getLineageDocsById (recursive CTE)"
COUCH=$(curl -s "$COUCH_URL/_design/medic-client/_view/docs_by_id_lineage?startkey=%5B%22$CLINIC_ID%22%5D&endkey=%5B%22$CLINIC_ID%22%2C%7B%7D%5D&include_docs=true" | python3 -c "
import sys, json
for row in json.load(sys.stdin)['rows']: print(row['doc']['_id'])")
PG=$(pg "
WITH RECURSIVE lineage AS (
  SELECT doc, COALESCE(doc->'parent'->>'_id', CASE WHEN jsonb_typeof(doc->'parent') = 'string' THEN doc->>'parent' ELSE NULL END) AS parent_id, 0 AS depth
  FROM v1.couchdb WHERE _id = '$CLINIC_ID' AND (_deleted IS NULL OR _deleted = false)
  UNION ALL
  SELECT c.doc, COALESCE(c.doc->'parent'->>'_id', CASE WHEN jsonb_typeof(c.doc->'parent') = 'string' THEN c.doc->>'parent' ELSE NULL END), l.depth + 1
  FROM v1.couchdb c JOIN lineage l ON c._id = l.parent_id
  WHERE l.parent_id IS NOT NULL AND l.parent_id != '' AND (c._deleted IS NULL OR c._deleted = false) AND l.depth < 20
) SELECT doc->>'_id' FROM lineage ORDER BY depth;")
compare "clinic lineage chain" "$COUCH" "$PG"

# --- Test 6: Shortcode resolution ---
echo "[5] resolveShortcode (contacts_by_reference)"
COUCH=$(curl -s "$COUCH_URL/_design/medic-client/_view/contacts_by_reference?key=%5B%22shortcode%22%2C%2213602%22%5D" | python3 -c "
import sys, json; print(json.load(sys.stdin)['rows'][0]['id'])")
PG=$(pg "
SELECT _id FROM v1.couchdb
WHERE (_deleted IS NULL OR _deleted = false)
  AND (doc->>'patient_id' = '13602' OR doc->>'place_id' = '13602')
LIMIT 1;")
compare "patient_id shortcode" "$COUCH" "$PG"

# --- Test 7: Form ID range ---
echo "[6] getDocIdsByIdRange (form: prefix)"
COUCH=$(curl -s "$COUCH_URL/_all_docs?startkey=%22form:%22&endkey=%22form:%EF%BF%B0%22" | python3 -c "
import sys, json; print(len(json.load(sys.stdin)['rows']))")
PG=$(pg "
SELECT COUNT(*) FROM v1.couchdb
WHERE _id >= 'form:' AND _id <= 'form:' || E'\ufff0'
  AND (_deleted IS NULL OR _deleted = false);")
compare "form doc count" "$COUCH" "$PG"

# --- Test 8: Pagination ---
echo "[7] Pagination (limit/skip)"
COUCH=$(curl -s "$COUCH_URL/_design/medic-client/_view/contacts_by_type?key=%5B%22person%22%5D&include_docs=false&limit=1&skip=1" | python3 -c "
import sys, json; print(json.load(sys.stdin)['rows'][0]['id'])")
PG=$(pg "
SELECT _id FROM v1.couchdb
WHERE COALESCE(doc->>'contact_type', doc->>'type') = 'person'
  AND (_deleted IS NULL OR _deleted = false)
ORDER BY _id LIMIT 1 OFFSET 1;")
compare "person page 2 (limit=1,skip=1)" "$COUCH" "$PG"

# --- Summary ---
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && echo "All adapter queries produce identical results to CouchDB." || exit 1
