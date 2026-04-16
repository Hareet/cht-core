# Next Phase Implementation: Two Options for Production Rollout

**Date**: 2026-04-16
**Status**: Design document — ONE option will be selected for implementation
**Depends on**: Benchmark findings (`.agents/tasks/BENCHMARK_FINDINGS.md`)

---

## Context

Benchmarking revealed that PowerSync and PouchDB have near-identical initial sync times under Go edition constraints (~230s), but for different reasons:
- PouchDB is **network-bound** (72MB over 3G)
- PowerSync is **CPU-bound** (WASM SQLite writes under constrained CPU)

PowerSync has clear advantages in server efficiency (0.7s vs ~90s), wire transfer (1.3MB vs 72MB), and query performance (1ms vs PouchDB views). However, Go edition devices (56.3% of the CIV fleet) face memory pressure: 56.5MB JS heap (vs PouchDB's 18.6MB) and 88.3MB storage (vs 72.1MB).

Two **mutually exclusive options** are presented below. We will implement only one:

- **Option A: Dual-backend per-facility rollout** — Budget+ devices get PowerSync immediately, Go edition stays on PouchDB, a new pg2couch bridge keeps both in sync. Accepts that 56% of the fleet stays on the old stack.
- **Option B: Drop the `doc` column from PowerSync client schema** — Roughly halve storage and heap usage, making PowerSync viable for ALL devices including Go edition. Enables a single-backend migration for the entire fleet.

---

## Option A: Dual-Backend Architecture with pg2couch

### Overview

Budget+ devices (43.7% of fleet, 1,140 users) move to PowerSync/PostgreSQL for the full performance benefit. Go edition devices (56.3%, 1,471 users) stay on PouchDB/CouchDB until pre-seeded SQLite or the `doc` column optimization makes PowerSync viable for them.

Both groups must see each other's data in near-real-time.

### Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        PostgreSQL                                │
│                  (single national instance)                      │
│                                                                  │
│  v1.couchdb table:                                               │
│    _id, doc (JSONB), source ('couch2pg' | 'powersync'),          │
│    _deleted, saved_timestamp, resolved_subject_place_id,         │
│    submitter_place_id, parent_place_id, purged, ...              │
│                                                                  │
└───────────┬──────────────────────────────┬───────────────────────┘
            │                              │
       ┌────▼────┐                    ┌────▼────┐
       │couch2pg │                    │PowerSync│
       │(existing)│                    │ Service │
       │CouchDB→PG│                    │PG WAL→WS│
       └────┬────┘                    └────┬────┘
            │                              │
       ┌────▼────┐                    ┌────▼────┐
       │ CouchDB │                    │PowerSync│
       │         │◄───pg2couch────────│  SDK    │
       │         │    (NEW)           │(budget+)│
       └────┬────┘                    └─────────┘
            │
       ┌────▼────┐
       │ PouchDB │
       │(Go edit)│
       └─────────┘
```

### Write Paths

#### Path A: Go Edition User Submits a Report (PouchDB → CouchDB → PostgreSQL)

```
1. CHW on Go edition phone submits pregnancy registration form
2. PouchDB writes to local IndexedDB (instant, offline-capable)
3. When online, PouchDB replicates to CouchDB (existing v5 replication)
4. Sentinel processes transitions on CouchDB changes feed
5. couch2pg picks up the change, writes to v1.couchdb with source='couch2pg'
6. PowerSync WAL processor sees the INSERT, updates bucket data
7. Budget+ users on PowerSync receive the report on next sync frame (~1-5s)
```

No changes needed. This is the existing pipeline.

#### Path B: Budget+ User Submits a Report (PowerSync → PostgreSQL → CouchDB)

```
1. CHW on budget phone submits home visit form
2. PowerSync SDK writes to local SQLite upload queue (instant, offline-capable)
3. When online, SDK calls POST /api/v1/powersync/upload with CRUD batch
4. Upload handler writes directly to PostgreSQL v1.couchdb with source='powersync'
5. PowerSync WAL processor sees the INSERT, updates bucket data
6. Other budget+ PowerSync users receive the report on next sync frame (~1-5s)
7. pg2couch service (NEW) detects source='powersync' write via LISTEN/NOTIFY
8. pg2couch writes the full doc to CouchDB via _bulk_docs API
9. Sentinel processes transitions on CouchDB changes feed
10. Go edition PouchDB users receive the report via normal CouchDB replication (~5-10s)
```

Steps 7-10 are new. Steps 1-6 already exist.

### pg2couch Service Design

#### PostgreSQL Components

**Source column on v1.couchdb:**

```sql
-- Add source tracking column (idempotent)
ALTER TABLE v1.couchdb ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'couch2pg';

-- Index for pg2couch polling
CREATE INDEX IF NOT EXISTS idx_couchdb_source_powersync
  ON v1.couchdb (saved_timestamp)
  WHERE source = 'powersync';
```

**Notification trigger:**

```sql
CREATE OR REPLACE FUNCTION v1.notify_powersync_write()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Only notify for PowerSync-originated writes, not couch2pg
  IF NEW.source = 'powersync' THEN
    PERFORM pg_notify('powersync_write', json_build_object(
      'doc_id', NEW._id,
      'deleted', COALESCE(NEW._deleted, false)
    )::text);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notify_powersync_write
  AFTER INSERT OR UPDATE ON v1.couchdb
  FOR EACH ROW
  WHEN (NEW.source = 'powersync')
  EXECUTE FUNCTION v1.notify_powersync_write();
```

**Upload handler change (api/src/controllers/powersync-upload.js):**

The existing upload handler must set `source = 'powersync'` on writes:

```javascript
// In processCrudEntry, when writing to PostgreSQL:
await pgPool.query(
  `INSERT INTO v1.couchdb (_id, doc, _deleted, source)
   VALUES ($1, $2::jsonb, false, 'powersync')
   ON CONFLICT (_id) DO UPDATE SET doc = $2::jsonb, _deleted = false, source = 'powersync'`,
  [docId, JSON.stringify(doc)]
);
```

#### pg2couch Service (New Node.js Service)

**Location**: `services/pg2couch/` (new directory, similar to `services/purge-preproc/`)

**Core logic:**

```javascript
const { Client } = require('pg');
const http = require('http');

const PG_URI = process.env.PS_DATABASE_URI;
const COUCH_URL = process.env.COUCH_URL; // http://admin:password@couchdb:5984/medic

class Pg2CouchBridge {
  constructor() {
    this.pgClient = new Client({ connectionString: PG_URI });
    this.batchQueue = [];
    this.batchTimer = null;
    this.BATCH_SIZE = 100;
    this.BATCH_INTERVAL_MS = 1000;
  }

  async start() {
    await this.pgClient.connect();
    await this.pgClient.query('LISTEN powersync_write');

    this.pgClient.on('notification', (msg) => {
      const { doc_id, deleted } = JSON.parse(msg.payload);
      this.batchQueue.push({ doc_id, deleted });
      this.scheduleBatch();
    });

    // Catch-up: process any powersync writes that happened while service was down
    await this.catchUp();

    console.log('pg2couch bridge started, listening for powersync_write notifications');
  }

  scheduleBatch() {
    if (this.batchTimer) return;
    if (this.batchQueue.length >= this.BATCH_SIZE) {
      this.processBatch();
    } else {
      this.batchTimer = setTimeout(() => {
        this.batchTimer = null;
        this.processBatch();
      }, this.BATCH_INTERVAL_MS);
    }
  }

  async processBatch() {
    const batch = this.batchQueue.splice(0, this.BATCH_SIZE);
    if (batch.length === 0) return;

    // Fetch full docs from PostgreSQL
    const docIds = batch.map(b => b.doc_id);
    const result = await this.pgClient.query(
      'SELECT _id, doc, _deleted FROM v1.couchdb WHERE _id = ANY($1)',
      [docIds]
    );

    // For each doc, upsert to CouchDB
    const couchDocs = [];
    for (const row of result.rows) {
      const doc = row.doc;
      doc._id = row._id;

      // Fetch current _rev from CouchDB (needed for update)
      const existing = await this.couchGet(row._id).catch(() => null);
      if (existing) {
        doc._rev = existing._rev;
      }

      if (row._deleted) {
        doc._deleted = true;
      }

      couchDocs.push(doc);
    }

    // Bulk write to CouchDB
    if (couchDocs.length > 0) {
      await this.couchBulkDocs(couchDocs);
      console.log(`pg2couch: pushed ${couchDocs.length} docs to CouchDB`);
    }

    // Mark as synced in PostgreSQL (prevent re-processing)
    await this.pgClient.query(
      `UPDATE v1.couchdb SET source = 'powersync_synced'
       WHERE _id = ANY($1) AND source = 'powersync'`,
      [docIds]
    );
  }

  async catchUp() {
    // Process any unsynced powersync writes from before service started
    const result = await this.pgClient.query(
      `SELECT _id FROM v1.couchdb WHERE source = 'powersync'
       ORDER BY saved_timestamp LIMIT 1000`
    );
    for (const row of result.rows) {
      this.batchQueue.push({ doc_id: row._id, deleted: false });
    }
    if (this.batchQueue.length > 0) {
      console.log(`pg2couch: catching up on ${this.batchQueue.length} unsynced docs`);
      while (this.batchQueue.length > 0) {
        await this.processBatch();
      }
    }
  }

  // HTTP helpers for CouchDB
  async couchGet(docId) { /* GET COUCH_URL/docId */ }
  async couchBulkDocs(docs) { /* POST COUCH_URL/_bulk_docs */ }
}
```

#### Loop Prevention

The `source` column prevents infinite loops:

| Write origin | source value | couch2pg action | pg2couch action |
|-------------|-------------|-----------------|-----------------|
| couch2pg (from CouchDB) | `couch2pg` | N/A (it wrote this) | **IGNORE** (not powersync) |
| PowerSync upload handler | `powersync` | N/A (came from PG directly) | **PUSH to CouchDB** |
| pg2couch pushed to CouchDB | — | couch2pg picks up, writes `source='couch2pg'` | **IGNORE** (source is couch2pg) |
| PouchDB → CouchDB → couch2pg | `couch2pg` | N/A (it wrote this) | **IGNORE** |

After pg2couch pushes a doc, it sets `source = 'powersync_synced'`. When couch2pg later picks up the same doc from CouchDB (because pg2couch wrote it there), it overwrites with `source = 'couch2pg'`. No conflict — the document content is identical.

#### Docker Compose Service

```yaml
# In docker-compose.postgres.yml
pg2couch:
  build:
    context: ${CHT_CORE_PATH}/services/pg2couch
    dockerfile: Dockerfile
  container_name: cht-pg2couch
  restart: always
  environment:
    - PS_DATABASE_URI=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/cht
    - COUCH_URL=http://${COUCHDB_USER}:${COUCHDB_PASSWORD}@couchdb:5984/medic
  networks:
    - cht-net
  depends_on:
    - postgres
```

#### Sentinel Compatibility

Sentinel processes document transitions from CouchDB's `_changes` feed. With the dual-backend:

- **Go edition writes**: PouchDB → CouchDB → Sentinel processes immediately
- **Budget+ writes**: PowerSync → PostgreSQL → pg2couch → CouchDB → Sentinel processes with ~5s delay

Sentinel doesn't need any changes. It always reads from CouchDB, and pg2couch ensures all PowerSync-originated writes reach CouchDB.

If Sentinel is later migrated to read from PostgreSQL (Agent 2's work with `CHT_DB_BACKEND=postgresql`), it would process PowerSync writes immediately and CouchDB writes via couch2pg — the mirror image.

#### Latency Expectations

| Scenario | Path | Latency |
|----------|------|---------|
| Budget+ user A writes → Budget+ user B sees it | PG → WAL → PowerSync | ~1-5s |
| Budget+ user writes → Go edition user sees it | PG → pg2couch → CouchDB → PouchDB | ~5-15s |
| Go edition user writes → Budget+ user sees it | CouchDB → couch2pg → PG → WAL → PowerSync | ~5-10s |
| Go edition user A writes → Go edition user B sees it | CouchDB → PouchDB replication | ~5-10s (unchanged) |
| Any user writes → Sentinel processes it | All paths end at CouchDB | 0-15s |

All paths are eventual consistency with single-digit second latency. No path exceeds 15s in normal conditions.

#### Feature Flag Configuration

The existing feature flag system supports this out of the box:

```json
{
  "powersync": {
    "enabled": true,
    "facilities": [
      "facility-uuid-with-budget-devices",
      "facility-uuid-with-standard-devices"
    ],
    "rollout_percentage": 0
  }
}
```

- Facilities with Go edition devices: NOT in the `facilities` array → PouchDB
- Facilities with budget+ devices: in the `facilities` array → PowerSync
- The client bootstrapper checks `/api/v1/powersync/status` and decides which path

For gradual rollout, `rollout_percentage` can be used instead (hash-based, consistent per user).

---

## Option B: Drop the `doc` Column from PowerSync Client Schema

### Overview

The current Sync Stream queries select both extracted columns AND the full JSON document:

```sql
SELECT
  contacts._id AS id,
  contacts.doc ->> 'name' AS name,           -- extracted: ~10 bytes
  contacts.doc ->> 'contact_type' AS type,    -- extracted: ~6 bytes
  ...
  CAST(contacts.doc AS TEXT) AS doc           -- FULL JSON: ~2-5KB
FROM v1.couchdb contacts
```

Every document is stored twice on the client: once as individual columns, once as the full JSON blob in the `doc` column. For 12K reports at ~3KB average, the `doc` column alone accounts for ~36MB in the reports table, plus another copy in `ps_oplog`. This is the primary driver of the 88.3MB storage and 56.5MB heap.

### Changes Required

#### 1. Sync Stream Queries (sync-config.yaml)

Remove `CAST(doc AS TEXT) AS doc` and `CAST(doc->'fields' AS TEXT) AS fields` from every query. Instead, extract all fields that the client app needs as individual columns.

**Before (contacts):**
```sql
SELECT
  contacts._id AS id,
  contacts.doc ->> 'name' AS name,
  ifnull(contacts.doc ->> 'contact_type', contacts.doc ->> 'type') AS contact_type,
  ifnull(contacts.doc -> 'parent' ->> '_id', contacts.doc ->> 'parent') AS parent_id,
  contacts.doc ->> 'patient_id' AS patient_id,
  contacts.doc ->> 'phone' AS phone,
  contacts.doc ->> 'date_of_birth' AS date_of_birth,
  contacts.doc ->> 'sex' AS sex,
  contacts.doc ->> 'reported_date' AS reported_date,
  CAST(contacts.doc AS TEXT) AS doc              -- ← REMOVE THIS
FROM v1.couchdb contacts
```

**After (contacts):**
```sql
SELECT
  contacts._id AS id,
  contacts.doc ->> 'name' AS name,
  ifnull(contacts.doc ->> 'contact_type', contacts.doc ->> 'type') AS contact_type,
  ifnull(contacts.doc -> 'parent' ->> '_id', contacts.doc ->> 'parent') AS parent_id,
  contacts.doc ->> 'patient_id' AS patient_id,
  contacts.doc ->> 'phone' AS phone,
  contacts.doc ->> 'date_of_birth' AS date_of_birth,
  contacts.doc ->> 'sex' AS sex,
  contacts.doc ->> 'reported_date' AS reported_date,
  contacts.doc ->> 'notes' AS notes                -- ← ADD any fields the app needs
FROM v1.couchdb contacts
```

**Before (reports):**
```sql
SELECT
  reports._id AS id,
  reports.doc ->> 'form' AS form,
  reports.doc ->> 'patient_id' AS patient_id,
  reports.doc -> 'contact' ->> '_id' AS submitter_id,
  reports.doc ->> 'reported_date' AS reported_date,
  reports.doc -> 'fields' ->> 'private' AS is_private,
  reports.doc -> 'fields' ->> 'needs_signoff' AS needs_signoff,
  CAST(reports.doc -> 'fields' AS TEXT) AS fields,    -- ← KEEP or REMOVE?
  CAST(reports.doc AS TEXT) AS doc                     -- ← REMOVE THIS
FROM v1.couchdb reports
```

**Decision on `fields`**: The `fields` column contains the form submission data as JSON (~1-3KB). The rules engine, contact-summary, and report detail view all need access to form field values. Options:

**Option A: Keep `fields`, drop `doc` only**
- Removes the top-level document wrapper (~500 bytes of metadata per doc)
- `fields` still provides form data for rules engine
- Estimated savings: ~30-40% of `doc` column size
- Storage: 88MB → ~55-60MB
- Heap: 56MB → ~35-40MB

**Option B: Drop both `fields` and `doc`, extract individual form fields**
- Requires knowing EVERY form field that tasks.js/targets.js/contact-summary access
- Different per deployment config (CIV fields differ from Kenya fields)
- Makes the sync config deployment-specific (must be generated by cht-conf)
- Storage: 88MB → ~30-35MB
- Heap: 56MB → ~20-25MB
- **Most complex but most impactful**

**Option C: Keep `fields`, drop `doc`, compress `fields` on the wire**
- PowerSync transmits `fields` as TEXT, but on the client we could store it compressed
- Requires custom serialization in the adapter
- Not natively supported by PowerSync SDK

**Recommended: Option A for immediate impact, Option B as a future optimization tied to cht-conf generating sync configs per deployment.**

#### 2. PowerSync Client Schema (powersync-schema.ts)

Remove the `doc` column from every table definition:

```typescript
// Before
new Table({ name: 'contacts', columns: [
  t('name'), t('contact_type'), t('parent_id'), t('patient_id'),
  t('place_id'), t('phone'), t('date_of_birth'), t('sex'),
  t('reported_date'), t('doc'),  // ← REMOVE
]}),

// After
new Table({ name: 'contacts', columns: [
  t('name'), t('contact_type'), t('parent_id'), t('patient_id'),
  t('place_id'), t('phone'), t('date_of_birth'), t('sex'),
  t('reported_date'),
  // doc column removed — use individual columns instead
]}),
```

#### 3. Rules Engine Adapter (shared-libs/rules-engine/src/adapters/powersync-adapter.js)

The rules engine currently expects full CouchDB documents. The adapter must reconstruct a document-like object from columns:

```javascript
// Current: returns full doc from PowerSync SQLite
async function getReportsForContact(contactId) {
  const rows = await db.getAll(
    'SELECT * FROM reports WHERE patient_id = ?', [contactId]
  );
  return rows.map(row => JSON.parse(row.doc));  // ← uses doc column
}

// After: reconstruct from columns
async function getReportsForContact(contactId) {
  const rows = await db.getAll(
    'SELECT * FROM reports WHERE patient_id = ?', [contactId]
  );
  return rows.map(row => ({
    _id: row.id,
    type: 'data_record',
    form: row.form,
    patient_id: row.patient_id,
    reported_date: row.reported_date,
    contact: { _id: row.submitter_id },
    fields: row.fields ? JSON.parse(row.fields) : {},
    // Metadata needed by rules engine:
    _rev: undefined,  // Not available — rules engine must not depend on _rev
  }));
}
```

The `fields` JSON parse is the key operation. For a typical report with 20-30 form fields, `JSON.parse` of a 1-3KB string takes <1ms. The rules engine processes one contact+reports tuple at a time, so this adds negligible overhead.

For contacts:
```javascript
function contactFromRow(row) {
  return {
    _id: row.id,
    type: row.contact_type === 'person' ? 'person' : 'contact',
    contact_type: row.contact_type,
    name: row.name,
    patient_id: row.patient_id,
    date_of_birth: row.date_of_birth,
    sex: row.sex,
    phone: row.phone,
    parent: { _id: row.parent_id },
    reported_date: row.reported_date,
  };
}
```

#### 4. Contact Summary (contact-summary.templated.js)

Contact summary accesses document fields to build the contact detail page. The CIV config's contact-summary uses fields like:
- `contact.name`, `contact.date_of_birth`, `contact.sex`, `contact.phone` — all extracted columns
- `contact.parent.name` — requires a JOIN or separate query (parent is a different contact)

Fields accessed by contact-summary that aren't currently extracted columns need to be added to the Sync Stream query. For CIV, audit the `contact-summary.templated.js` to identify all referenced fields.

#### 5. Enketo Forms (form pre-fill)

Forms that pre-fill from existing documents (e.g., edit forms) use `db:person` or `db:contact` references. These resolve to full documents via the Angular `DbService`. With PowerSync, the `DbService` adapter would need to reconstruct the document from columns, same as the rules engine adapter.

### What Does NOT Change

- **PostgreSQL server-side**: `v1.couchdb.doc` JSONB column stays intact. Full documents remain in PostgreSQL.
- **couch2pg**: Continues replicating full documents from CouchDB to PostgreSQL.
- **pg2couch**: Reads full documents from PostgreSQL, pushes to CouchDB.
- **Sentinel**: Reads full documents from CouchDB. No impact.
- **Upload handler**: Receives full documents from PowerSync SDK upload queue. The SDK sends whatever the app wrote to local SQLite — with no `doc` column, the upload payload is smaller too.
- **PouchDB path**: Completely unchanged. Go edition users on PouchDB still get full JSON documents.

### Estimated Impact

| Metric | With `doc` | Without `doc` (Option A) | Without `doc` or `fields` (Option B) |
|--------|-----------|-------------------------|-------------------------------------|
| Storage | 88.3MB | ~55MB | ~35MB |
| JS heap | 56.5MB | ~35MB | ~22MB |
| Wire transfer | 1.3MB | ~0.8MB | ~0.5MB |
| Sync time (3G) | 232s | ~150s | ~100s |
| Go edition safe | Risky | **Yes** | **Yes** |
| Rules engine changes | None | Moderate (adapter reconstruction) | Major (per-config field extraction) |
| cht-conf dependency | None | None | **Yes** (generates sync config per deployment) |

### Cross-Deployment Risk: What We Can't Validate from CIV Testing Alone

The CIV config is one deployment. CHT runs in 47 Kenyan counties, multiple countries, and dozens of NGO-customized configurations. Each has its own `tasks.js`, `targets.js`, `contact-summary.templated.js`, forms, and potentially custom JavaScript. Dropping `doc` is safe for CIV — but may break other deployments in ways we can't predict from CIV testing.

#### Risk 1: Custom contact-summary field access

`contact-summary.templated.js` generates the contact detail page. It can access ANY property on the contact document:

```javascript
// CIV — uses extracted columns (safe):
fields: [
  { label: 'Phone', value: contact.phone },
  { label: 'DOB', value: contact.date_of_birth },
]

// Another deployment — accesses custom nested fields (BREAKS without doc):
fields: [
  { label: 'Insurance ID', value: contact.insurance?.policy_number },
  { label: 'Disability', value: contact.custom_assessment?.disability_type },
  { label: 'Linked CHW', value: contact.linked_docs?.chw_ref },
]
```

The `insurance`, `custom_assessment`, and `linked_docs` fields are deployment-specific. They're not in our extracted columns and wouldn't exist in the PowerSync client schema. The contact detail page would show blank values.

**Can we detect this statically?** Partially. A JavaScript AST parser can scan `contact-summary.templated.js` for property access patterns on the `contact` and `report` parameters. However:
- Some configs use dynamic property access: `contact[fieldName]` where `fieldName` comes from a variable
- Some configs use helper functions that receive the doc and access properties internally
- `contact-summary-extras.js` can define arbitrary functions that are called from the main template

A static analyzer would catch 80-90% of field references. The remaining 10-20% require runtime testing against the actual config.

#### Risk 2: Complex tasks.js and targets.js accessing fields outside `report.fields`

The rules engine evaluates task/target rules against contact and report documents. Most field access goes through `report.fields.*` (which the `fields` JSON column preserves). But some configs access top-level document properties that Sentinel adds:

```javascript
// Accessing Sentinel-added metadata (NOT in report.fields):
{
  appliesIf: (contact, report) => {
    // Scheduled messages added by Sentinel:
    return report.scheduled_tasks?.some(task => task.state === 'pending');
  }
}

// Transition metadata:
{
  appliesIf: (contact, report) => {
    return report.transitions?.registration?.ok === true;
  }
}

// Error tracking:
{
  resolvedIf: (contact, report) => {
    return !report.errors || report.errors.length === 0;
  }
}
```

`report.scheduled_tasks`, `report.transitions`, and `report.errors` are NOT in `report.fields` — they're top-level properties added by Sentinel after submission. Without `doc`, these are invisible unless explicitly extracted as columns.

**Can we detect this statically?** Yes, more reliably than contact-summary. `tasks.js` and `targets.js` follow a structured contract:
- `appliesTo`: string ('contacts' or 'reports')
- `appliesIf`: function with `(contact, report)` parameters
- `resolvedIf`: function with `(contact, report, event, dueDate)` parameters
- `events[].dueDate`: function that accesses report fields

An AST parser can walk these function bodies and extract all property access chains on the `contact` and `report` parameters. The CHT `cht-conf` compiler already parses these files — extending it to emit a "required fields" manifest is feasible.

**Key fields that commonly appear outside `report.fields`:**

| Field | Where it comes from | How common |
|-------|-------------------|-----------|
| `report.scheduled_tasks` | Sentinel `schedules` transition | Very common — SMS scheduling |
| `report.transitions` | Sentinel transition metadata | Common — registration workflows |
| `report.errors` | Sentinel validation/transition errors | Moderate |
| `report.verified` | Manual verification by supervisor | Some deployments |
| `report.patient` | Hydrated patient reference | Rare (usually use `report.fields.patient_id`) |
| `report.kujua_message` | Legacy SMS flag | Legacy deployments only |
| `contact.linked_docs` | Registration-generated cross-references | Some deployments |
| `contact.muted` | Muting transition | Common |

#### Risk 4: cht-conf custom code in extras files

`contact-summary-extras.js`, `tasks.extras.js`, and `targets.extras.js` are arbitrary JavaScript that gets compiled alongside the main config. They can:
- Define helper functions that receive full documents and access any property
- Import shared modules that traverse document trees
- Build computed fields from multiple nested properties

Example from a real deployment:
```javascript
// tasks.extras.js
const isHighRisk = (report) => {
  const bmi = report.fields?.bmi;
  const age = report.fields?.age;
  const history = report.previous_pregnancies; // ← NOT in fields
  const referral = report.transitions?.referral; // ← NOT in fields
  return bmi < 18 || age > 40 || history > 4 || referral?.ok;
};
```

**Can we detect this statically?** Same approach as tasks.js — AST parsing of the extras files. The challenge is that these files can define complex helper functions with indirect property access, making static analysis less reliable. Runtime testing (actually running the rules engine against test data) is the most reliable validation.

### Option B — Safe Variant (Recommended)

Given the cross-deployment risks, the safe approach is incremental:

**Step 1: Drop `doc` from reports only, keep `fields`**
- Reports are 80%+ of storage. This is where the savings come from.
- The `fields` JSON column preserves ALL form submission data.
- `report.fields.*` access (the most common pattern) works unchanged.
- Top-level report metadata (`scheduled_tasks`, `transitions`, `errors`) is lost — but these can be added as extracted columns for configs that need them.
- **Risk**: configs that access `report.scheduled_tasks` or `report.transitions` break silently. Mitigation: cht-conf analyzer.

**Step 2: Keep `doc` on contacts (for now)**
- Contact documents are small (~500 bytes each). Keeping `doc` on contacts adds ~5-10MB for a typical CHW's contact set — modest compared to the 30-40MB saved on reports.
- Contact-summary accesses arbitrary contact fields that are impossible to fully enumerate without per-deployment analysis.
- This is the safety net: contact detail pages keep working for all deployments.

**Step 3: Keep `doc` on global_config**
- `app_settings`, forms, translations are small in count but accessed in arbitrary ways by the Angular app.
- The app reads `settings.tasks`, `settings.contact_types`, `settings.schedules`, etc.
- These MUST have the full doc or the app breaks.

**Step 4: Build cht-conf field analyzer**
- Extend cht-conf to scan `tasks.js`, `targets.js`, `contact-summary.templated.js`, and extras files
- Output a manifest of all document properties accessed per document type
- Use this to validate that extracted columns cover everything before deploying to a new config
- Once validated per-deployment, `doc` can be safely dropped from contacts too

**Safe variant estimated impact (reports only):**

| Metric | Current | Safe variant | Full Option B |
|--------|---------|-------------|---------------|
| Storage | 88.3MB | **~55-60MB** | ~35MB |
| JS heap | 56.5MB | **~35-40MB** | ~22MB |
| Go edition safe | Risky | **Yes** | Yes |
| Cross-deployment risk | N/A | **Low** (contacts keep doc) | High (needs per-config validation) |

Dropping `doc` from reports alone brings heap from 56.5MB to ~35-40MB — safely within Go edition's budget and comparable to PouchDB's 18.6MB + Angular app overhead.

### Testing Plan

**Phase 1: Validate with reports only (biggest table, safe variant)**
1. Remove `CAST(doc AS TEXT) AS doc` from the reports Sync Stream query
2. Keep `CAST(doc->'fields' AS TEXT) AS fields` (Option A)
3. Remove `doc` column from `reports` table in PowerSync client schema
4. Update rules engine adapter to reconstruct report objects from columns
5. Run rules engine unit tests — verify tasks.js/targets.js produce same output
6. Run Node.js benchmark — measure storage/heap reduction for reports
7. Run browser benchmark — verify heap is reduced

**Phase 2: Extend to contacts**
1. Remove `doc` from contacts Sync Stream query
2. Add any missing fields that contact-summary references
3. Update rules engine adapter for contact reconstruction
4. Test contact-summary rendering with column-only data

**Phase 3: Extend to all tables**
1. Remove `doc` from tasks, targets, global_config, user_settings, user_meta
2. For global_config (app_settings, forms, translations): these may NEED the full doc since the app reads arbitrary config values. Evaluate case-by-case.

**Phase 4: Measure and validate**
1. Full browser benchmark with Go edition throttling
2. Rules engine parity test: PouchDB adapter vs PowerSync adapter produce identical tasks/targets
3. Memory profiling: confirm heap reduction on simulated Go edition
4. End-to-end: submit form → upload → re-sync → verify data integrity

---

## Comparison: Option A vs Option B

| Dimension | Option A (Dual-Backend) | Option B (Drop `doc`) |
|-----------|------------------------|----------------------|
| **Fleet coverage** | 43.7% on PowerSync, 56.3% stay on PouchDB | **100% on PowerSync** |
| **New infrastructure** | pg2couch service, source column, loop prevention | None — schema and adapter changes only |
| **Operational complexity** | High — two sync paths, bidirectional bridge, monitoring both | Low — single sync path for all users |
| **Data consistency** | Eventual (5-15s cross-backend latency) | Immediate (single source of truth) |
| **Sentinel impact** | None (reads CouchDB, pg2couch feeds it) | None (processes from CouchDB during transition) |
| **CouchDB retirement path** | Blocked until Go edition moves to PowerSync | **Unblocked** — all users on PostgreSQL |
| **Effort** | 3-5 days (pg2couch) + ongoing operational burden | 2-4 days (schema + adapter changes) |
| **Risk** | Dual-write consistency bugs, loop prevention edge cases | Rules engine parity, missing field extraction |
| **Go edition heap** | 18.6MB (PouchDB, unchanged) | **~35MB** (PowerSync without doc, viable) |
| **Go edition storage** | 72.1MB (PouchDB, unchanged) | **~55MB** (PowerSync without doc, smaller than PouchDB) |

**Option B (safe variant) is recommended** because it enables a single-backend migration for 100% of the fleet, avoids dual-backend operational complexity, and unblocks CouchDB retirement. The safe variant (drop `doc` from reports only, keep on contacts and global_config) minimizes cross-deployment risk while delivering 80%+ of the memory/storage benefit.

---

## Agent Assignments for Option A (if selected)

| Agent | Task | Scope |
|-------|------|-------|
| NEW | Build pg2couch service | `services/pg2couch/` |
| 1 | Add `source` column to upload handler, notification trigger | `api/src/controllers/`, `.devcontainer/powersync-config/setup.sql` |
| 7 | Integration tests for dual-backend data flow | `tests/` |

## Agent Assignments for Option B Safe Variant (if selected)

| Agent | Task | Scope |
|-------|------|-------|
| **Agent 3** | Remove `CAST(doc AS TEXT) AS doc` from **reports, tasks, targets, sms_messages, and user_meta** Sync Stream queries in `sync-config.yaml`. **Keep `doc` on contacts and global_config** (safety net for cross-deployment compat). Keep `CAST(doc->'fields' AS TEXT) AS fields` on reports. Analyze CIV's `tasks.js` and `targets.js` for any `report.*` access outside of `report.fields` (e.g., `report.scheduled_tasks`, `report.transitions`) and add those as extracted columns if found. Update `powersync.yaml` inline config to match. | `.devcontainer/powersync-config/` |
| **Agent 5** | Remove `doc` column from **reports, tasks, targets, sms_messages, user_meta** table definitions in `powersync-schema.ts`. **Keep `doc` on contacts, global_config, user_settings_doc**. Remove any `doc` references for report/task access in `powersync.service.ts`, `powersync-connector.ts`, `powersync-contacts.service.ts`. Update benchmark scripts. | `webapp/src/ts/services/powersync/` |
| **Agent 6** | Update rules engine PowerSync adapter to reconstruct **report** document objects from extracted columns + `fields` JSON. Implement `reportFromRow()` mapping function. Contact documents still have `doc` so no reconstruction needed there. Verify dual-mode parity: PouchDB adapter and PowerSync adapter produce identical tasks/targets from the same CIV test data. | `shared-libs/rules-engine/` |
| **Agent 7** | Test rules engine parity (PouchDB vs PowerSync adapter output) using CIV's `tasks.js` and `targets.js`. Benchmark heap/storage reduction — verify reports-only `doc` removal achieves ~35-40MB heap. Run browser benchmark with Go edition throttling. | `tests/` |

### Option B Safe Variant Execution Order

```
Agent 3 (sync-config: drop doc from reports/tasks/targets only)
  ↓
Agent 5 (client schema)  +  Agent 6 (rules engine report adapter)  ← parallel
  ↓
Agent 7 (parity tests + benchmark)
```

Agent 3 goes first because the Sync Stream queries define which columns are available. Agents 5 and 6 can work in parallel once Agent 3 commits. Agent 7 validates everything after merge.

### Future: Full `doc` Removal (after cht-conf analyzer exists)

Once cht-conf can scan a deployment's config and output a manifest of all accessed document fields:
1. Run the analyzer against the target deployment's config
2. Add any missing fields as extracted columns in sync-config.yaml
3. Drop `doc` from contacts
4. Run parity tests
5. Deploy

This makes full `doc` removal safe for any deployment, not just CIV. The analyzer is a cht-conf feature (~2-4 weeks effort) that benefits the entire CHT ecosystem, not just the PowerSync migration.
