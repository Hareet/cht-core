# Technical Implementation Guide

## PoC Objectives (Months 1-2)

The proof of concept must validate the hard cases FIRST — not the happy path. If PowerSync can't handle purge preprocessing and hierarchical authorization at scale, we need to know before committing.

### PoC Success Criteria
1. PowerSync Sync Streams express CHT's hierarchical permissions (CHP → facility → sub-county → county)
2. Purge preprocessing pattern works: purge.js → purge_status table → Sync Stream exclusion
3. Filtered sync performs better than CouchDB baseline on initial sync time and storage efficiency
4. Offline data entry and sync work reliably on target Android devices (low-end, 1-2GB RAM)
5. Recursive CTE for replication depth doesn't timeout at scale (100K+ location records)

### PoC Scope
- Document types: contacts + reports only (minimum viable)
- Data: Anonymized subset from production eCHIS instance
- Client: CHT webapp with PowerSync SDK (Angular)
- Server: PostgreSQL + PowerSync Service (self-hosted)
- Sync: Filtered by facility hierarchy + purge exclusion

---

## PostgreSQL Schema Design

### Layer 1: JSONB Base (Fast Ingestion from cht-sync)
```sql
-- Extends existing cht-sync couchdb table
CREATE TABLE couchdb (
  uuid TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  doc JSONB NOT NULL,
  doc_type TEXT GENERATED ALWAYS AS (doc->>'type') STORED,
  reported_date BIGINT GENERATED ALWAYS AS ((doc->>'reported_date')::bigint) STORED,
  facility_id TEXT GENERATED ALWAYS AS (
    COALESCE(
      doc->'contact'->'parent'->>'_id',
      doc->'parent'->>'_id',
      doc->>'_id'
    )
  ) STORED,
  saved_timestamp TIMESTAMP DEFAULT NOW(),
  source VARCHAR,
  seq TEXT
);

CREATE INDEX idx_couchdb_doc_type ON couchdb(doc_type);
CREATE INDEX idx_couchdb_reported_date ON couchdb(reported_date);
CREATE INDEX idx_couchdb_facility ON couchdb(facility_id);
CREATE INDEX idx_couchdb_doc_gin ON couchdb USING GIN(doc);
```

### Layer 2: dbt Normalized Tables (Application Queries)
```sql
-- contacts (via dbt incremental model)
CREATE TABLE contacts (
  id UUID PRIMARY KEY,
  name VARCHAR(255),
  contact_type VARCHAR(50),  -- person, clinic, health_center, district_hospital
  parent_id UUID REFERENCES contacts(id),
  facility_id UUID,           -- resolved facility in hierarchy
  phone VARCHAR(50),
  date_of_birth DATE,
  sex VARCHAR(10),
  is_muted BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  doc JSONB                   -- preserve full document for flexibility
);

-- reports (via dbt incremental model)
CREATE TABLE reports (
  id UUID PRIMARY KEY,
  form VARCHAR(100),           -- form type identifier
  subject_id UUID,             -- patient/contact this report is about
  submitter_id UUID,           -- user who submitted
  facility_id UUID,            -- facility for authorization
  reported_date TIMESTAMP,
  is_private BOOLEAN DEFAULT FALSE,
  fields JSONB,                -- form field data
  created_at TIMESTAMP,
  doc JSONB                    -- full document
);

-- tasks (generated client-side by rules engine)
CREATE TABLE tasks (
  id UUID PRIMARY KEY,
  user_id UUID,
  contact_id UUID,
  emission_id VARCHAR(255),
  status VARCHAR(20),          -- Draft, Ready, Completed, Cancelled, Failed
  end_date TIMESTAMP,
  form VARCHAR(100),
  created_at TIMESTAMP,
  doc JSONB
);

-- targets (performance indicators)
CREATE TABLE targets (
  id UUID PRIMARY KEY,
  user_id UUID,
  reporting_period_start DATE,
  reporting_period_end DATE,
  targets JSONB,               -- array of target values
  created_at TIMESTAMP,
  doc JSONB
);
```

### Layer 3: Authorization Support Tables
```sql
-- Location hierarchy with ltree for efficient descendant queries
CREATE EXTENSION IF NOT EXISTS ltree;

CREATE TABLE locations (
  id UUID PRIMARY KEY,
  name VARCHAR(255),
  contact_type VARCHAR(50),
  parent_id UUID REFERENCES locations(id),
  path ltree,                  -- e.g., 'kenya.nairobi.kibera.clinic_a'
  depth INT
);
CREATE INDEX idx_locations_path ON locations USING GIST(path);

-- User assignments (which users belong to which locations)
CREATE TABLE user_assignments (
  user_id UUID,
  facility_id UUID REFERENCES locations(id),
  roles TEXT[],                -- array of role names
  replication_depth INT,       -- from CHT role configuration
  PRIMARY KEY (user_id)
);

-- Purge status (populated by purge preprocessing service)
CREATE TABLE purge_status (
  doc_id TEXT,
  user_role TEXT,              -- role combination hash
  purged_at TIMESTAMP DEFAULT NOW(),
  reason TEXT,
  PRIMARY KEY (doc_id, user_role)
);
CREATE INDEX idx_purge_role ON purge_status(user_role);
```

---

## PowerSync Sync Streams Configuration

### Contacts Stream (hierarchical filtering)
```yaml
streams:
  contacts:
    parameters:
      - |
        WITH RECURSIVE accessible AS (
          SELECT l.id, 0 as depth 
          FROM locations l
          JOIN user_assignments ua ON ua.facility_id = l.id
          WHERE ua.user_id = token_parameters.user_id
          UNION ALL
          SELECT l.id, a.depth + 1 
          FROM locations l
          JOIN accessible a ON l.parent_id = a.id
          WHERE a.depth < (
            SELECT replication_depth FROM user_assignments 
            WHERE user_id = token_parameters.user_id
          )
        )
        SELECT id as facility_id FROM accessible
    
    data:
      - |
        SELECT id, name, contact_type, parent_id, facility_id, 
               phone, date_of_birth, sex, is_muted, created_at, doc
        FROM contacts 
        WHERE facility_id = bucket.facility_id
```

### Reports Stream (with purge exclusion and privacy filtering)
```yaml
  reports:
    parameters:
      - |
        WITH RECURSIVE accessible AS (
          SELECT l.id, 0 as depth 
          FROM locations l
          JOIN user_assignments ua ON ua.facility_id = l.id
          WHERE ua.user_id = token_parameters.user_id
          UNION ALL
          SELECT l.id, a.depth + 1 
          FROM locations l
          JOIN accessible a ON l.parent_id = a.id
          WHERE a.depth < (
            SELECT replication_depth FROM user_assignments 
            WHERE user_id = token_parameters.user_id
          )
        )
        SELECT id as facility_id FROM accessible
    
    data:
      - |
        SELECT r.id, r.form, r.subject_id, r.submitter_id, r.facility_id,
               r.reported_date, r.is_private, r.fields, r.created_at, r.doc
        FROM reports r
        WHERE r.facility_id = bucket.facility_id
          AND NOT (r.is_private = true AND r.submitter_id != token_parameters.user_id)
          AND r.id NOT IN (
            SELECT ps.doc_id FROM purge_status ps
            WHERE ps.user_role = token_parameters.role_hash
          )
```

### Global Config Stream (unfiltered, all users)
```yaml
  config:
    data:
      - |
        SELECT id, doc_type, doc, updated_at
        FROM config_documents
```

### User Meta Stream (per-user filtering)
```yaml
  user_meta:
    data:
      - |
        SELECT id, meta_type, user_id, doc, created_at
        FROM user_meta
        WHERE user_id = token_parameters.user_id
```

---

## Purge Preprocessing Service

The purge preprocessing service bridges CHT's JavaScript purge logic with PowerSync's SQL-based Sync Streams.

### Architecture
```
PostgreSQL (contacts, reports) 
  → Purge Service (Node.js, runs purge.js per contact/reports tuple)
  → purge_status table (doc_id, user_role)
  → PowerSync Sync Streams reference purge_status in WHERE clause
```

### Implementation Sketch
```javascript
// purge-preprocessor.js
const { Pool } = require('pg');
const vm = require('vm');

class PurgePreprocessor {
  constructor(pgPool, purgeConfig) {
    this.pool = pgPool;
    // Compile partner's purge.js function in sandboxed VM
    this.purgeFn = new vm.Script(`(${purgeConfig.fn})`);
  }

  async runForRole(roleHash, roles) {
    const userCtx = { roles };
    
    // Get all contacts with their reports
    const contacts = await this.pool.query(`
      SELECT c.id, c.doc as contact,
        COALESCE(json_agg(r.doc) FILTER (WHERE r.id IS NOT NULL), '[]') as reports,
        COALESCE(json_agg(m.doc) FILTER (WHERE m.id IS NOT NULL), '[]') as messages
      FROM contacts c
      LEFT JOIN reports r ON r.subject_id = c.id
      LEFT JOIN messages m ON m.contact_id = c.id
      GROUP BY c.id, c.doc
    `);

    const toPurge = [];
    for (const row of contacts.rows) {
      const result = this.purgeFn.runInNewContext({
        userCtx,
        contact: row.contact,
        reports: row.reports,
        messages: row.messages
      });
      
      if (result && result.length > 0) {
        toPurge.push(...result.map(docId => ({ doc_id: docId, user_role: roleHash })));
      }
    }

    // Batch upsert to purge_status
    if (toPurge.length > 0) {
      await this.pool.query(`
        INSERT INTO purge_status (doc_id, user_role, purged_at)
        SELECT unnest($1::text[]), $2, NOW()
        ON CONFLICT (doc_id, user_role) DO NOTHING
      `, [toPurge.map(p => p.doc_id), roleHash]);
    }
  }

  // Run on schedule (e.g., nightly, matching CHT's current purge cadence)
  async runAll() {
    const roles = await this.getUniqueRoleCombinations();
    for (const { roleHash, roles: roleList } of roles) {
      await this.runForRole(roleHash, roleList);
    }
  }
}
```

### Schedule
- Run nightly (matching CHT's current server-side purge schedule)
- Could run more frequently if latency is acceptable
- Track last-run timestamp to process only changed contacts/reports incrementally

---

## cht-datasource PostgreSQL Adapter

### Current cht-datasource Pattern
```javascript
// Current: PouchDB on client, CouchDB on server
const datasource = require('@medic/cht-datasource');
const source = datasource.init(db); // db is PouchDB or CouchDB nano instance

// Get a person
const person = await source.person.getByUuid(uuid);
// Get reports for a contact
const reports = await source.report.getBySubject(contactId);
```

### PostgreSQL Adapter Pattern
```javascript
// New: PowerSync on client, PostgreSQL on server
class PostgresAdapter {
  constructor(powerSync) {
    this.db = powerSync; // PowerSync instance with SQLite
  }

  person = {
    getByUuid: async (uuid) => {
      const result = await this.db.get(
        'SELECT * FROM contacts WHERE id = ? AND contact_type = ?',
        [uuid, 'person']
      );
      return result ? this.hydrateContact(result) : null;
    },

    getByFacility: async (facilityId) => {
      return this.db.getAll(
        'SELECT * FROM contacts WHERE facility_id = ? AND contact_type = ? ORDER BY name',
        [facilityId, 'person']
      );
    }
  };

  report = {
    getBySubject: async (contactId) => {
      return this.db.getAll(
        'SELECT * FROM reports WHERE subject_id = ? ORDER BY reported_date DESC',
        [contactId]
      );
    },

    create: async (report) => {
      // Write to local SQLite, PowerSync queues for upload
      await this.db.execute(
        'INSERT INTO reports (id, form, subject_id, submitter_id, facility_id, reported_date, fields, doc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [report.id, report.form, report.subject_id, report.submitter_id, 
         report.facility_id, report.reported_date, JSON.stringify(report.fields), JSON.stringify(report)]
      );
    }
  };

  // Hydrate contact with parent hierarchy (replaces CouchDB's include_docs)
  hydrateContact(row) {
    return {
      ...row,
      _id: row.id,
      parent: row.parent_id ? { _id: row.parent_id } : undefined
    };
  }
}
```

### Feature Flag for Gradual Rollout
```javascript
// In cht-datasource initialization
function createDatasource(config) {
  if (config.USE_POSTGRES_DATASOURCE) {
    return new PostgresAdapter(config.powerSync);
  } else {
    return new PouchDBAdapter(config.db); // existing implementation
  }
}
```

---

## Write Handler (PowerSync Upload Path)

When PowerSync clients upload data, the PowerSync Service calls your write handler API:

```javascript
// write-handler.js — Express endpoint called by PowerSync
const express = require('express');
const router = express.Router();

router.post('/api/powersync/upload', async (req, res) => {
  const { transactions } = req.body;
  const userId = req.auth.userId; // from JWT

  for (const tx of transactions) {
    for (const op of tx.operations) {
      switch (op.type) {
        case 'PUT':
          await handleUpsert(op.table, op.data, userId);
          break;
        case 'PATCH':
          await handleUpdate(op.table, op.data, userId);
          break;
        case 'DELETE':
          await handleDelete(op.table, op.id, userId);
          break;
      }
    }
  }

  res.json({ ok: true });
});

async function handleUpsert(table, data, userId) {
  // Server-side validation (replaces Sentinel transitions)
  if (table === 'reports') {
    validateReport(data);
    data.submitter_id = userId; // enforce server-side
  }

  // Write to PostgreSQL
  const columns = Object.keys(data).join(', ');
  const values = Object.values(data);
  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
  
  await pgPool.query(
    `INSERT INTO ${table} (${columns}) VALUES (${placeholders})
     ON CONFLICT (id) DO UPDATE SET ${
       Object.keys(data).map((k, i) => `${k} = $${i + 1}`).join(', ')
     }`,
    values
  );

  // Trigger Sentinel-equivalent workflows
  await runTransitions(table, data);
}
```

---

## Migration Testing Checklist

### Per-County Rollout Validation
- [ ] Record count reconciliation: PostgreSQL == CouchDB (within 0.01%)
- [ ] Sample detailed record comparison (10% of records, field-by-field)
- [ ] Sync success rate > 99.9% across all users in county
- [ ] Initial sync time within 1.5x CouchDB baseline
- [ ] Form submission works fully offline, syncs on reconnect
- [ ] Purged documents not appearing on client after sync
- [ ] Sensitive documents not visible to unauthorized users
- [ ] Tasks/targets generated correctly by rules engine
- [ ] Configuration updates (app_settings) propagate to all clients
- [ ] User meta (feedback, telemetry) syncing correctly
- [ ] No data loss during 24-hour parallel operation

### Rollback Criteria
- Data loss > 0.01% → Immediate rollback
- Sync failure rate > 1% → Rollback
- Critical functionality broken → Rollback
- Performance degradation > 50% baseline → Rollback