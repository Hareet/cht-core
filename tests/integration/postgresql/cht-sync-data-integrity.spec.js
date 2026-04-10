/**
 * cht-sync Data Integrity and Edge Case Tests
 *
 * Validates edge cases identified from cht-sync source analysis (MCP research):
 *
 * 1. Soft delete behavior (_deleted column, NOT row removal)
 * 2. Security detail stripping (user docs: password_scheme, derived_key, salt removed)
 * 3. Message documents (data_record without form field — SMS)
 * 4. Sensitive/private document fields (fields.private)
 * 5. couchdb_progress table tracking
 * 6. Source identifier tracking (multi-database support)
 * 7. UPSERT conflict resolution (ON CONFLICT (_id) DO UPDATE)
 *
 * These tests fill gaps identified by cross-referencing:
 * - cht-sync-wiki: Data Import (importer.js sanitization, deletion handling)
 * - cht-core-wiki: Database Schema (document types, message docs)
 * - cht-kapa-docs: Document types and their sync behavior
 *
 * Prerequisites: CouchDB, API, PostgreSQL, and cht-sync must be running.
 */
const utils = require('../../utils/agent-harness');
const uuid = require('uuid').v4;

describe('cht-sync data integrity and edge cases', () => {

  describe('soft delete behavior', () => {
    it('should set _deleted=true on row when document is deleted, not remove the row', async function () {
      this.timeout(60000);
      const docId = `integrity-delete-${uuid()}`;
      const doc = {
        _id: docId,
        type: 'data_record',
        fields: { test: 'soft-delete' },
        reported_date: Date.now(),
      };
      await utils.saveDoc(doc);
      await utils.waitForDocInPostgres(docId, 45000);

      // Verify it exists and is not deleted
      const rowBefore = await utils.getPostgresRawRow(docId);
      expect(rowBefore).to.exist;
      expect(rowBefore._deleted).to.satisfy(v => v === false || v === null);

      // Delete the document in CouchDB
      await utils.deleteDoc(docId);

      // cht-sync should mark _deleted=true, NOT remove the row
      // This is confirmed by: importer.js addDeletesToResult() + ON CONFLICT UPDATE
      const maxWait = 30000;
      const start = Date.now();
      let softDeleted = false;
      while (Date.now() - start < maxWait) {
        const row = await utils.getPostgresRawRow(docId);
        if (row && row._deleted === true) {
          softDeleted = true;
          // The doc JSONB should also reflect deletion
          expect(row.doc._deleted).to.be.true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      expect(softDeleted).to.be.true;

      // Row should still exist (not removed)
      const result = await utils.pgQuery(
        `SELECT COUNT(*) as cnt FROM ${utils.pgDocsTable()} WHERE _id = $1`,
        [docId]
      );
      expect(parseInt(result.rows[0].cnt)).to.equal(1);
    });
  });

  describe('security detail stripping', () => {
    it('should remove sensitive fields from user documents', async function () {
      this.timeout(60000);

      // Create a user via the API — this creates an org.couchdb.user: doc
      const username = `integrity-user-${Date.now()}`;
      const user = {
        username,
        password: 'Str0ngP@ss123!',
        place: undefined, // will use default
        roles: ['chw'],
        contact: {
          _id: `fixture:user:${username}`,
          name: 'Integrity Test User',
        },
      };

      // We can't easily create a raw user doc, but we can check that
      // if a user doc lands in PostgreSQL, sensitive fields are stripped.
      // cht-sync's removeSecurityDetails strips: password_scheme, derived_key, salt
      // from docs where type === 'user' && _id.startsWith('org.couchdb.user:')

      // Instead of creating a user, verify the sanitization on any user doc
      // that already exists in the _users database (which cht-sync may sync)
      const result = await utils.pgQuery(
        `SELECT doc FROM ${utils.pgDocsTable()}
         WHERE _id LIKE 'org.couchdb.user:%' LIMIT 5`
      );

      if (result.rows.length > 0) {
        for (const row of result.rows) {
          // These fields should have been stripped by cht-sync's removeSecurityDetails
          expect(row.doc).to.not.have.property('password_scheme');
          expect(row.doc).to.not.have.property('derived_key');
          expect(row.doc).to.not.have.property('salt');
        }
      } else {
        // If _users DB is not being synced, skip gracefully
        console.log('No user documents found in PostgreSQL — _users DB may not be synced. Skipping.');
        this.skip();
      }
    });
  });

  describe('message documents (SMS without form)', () => {
    it('should replicate SMS message documents (data_record without form)', async function () {
      this.timeout(60000);
      // Messages are data_records WITHOUT a form field — incoming SMS
      const msgId = `integrity-msg-${uuid()}`;
      const messageDoc = {
        _id: msgId,
        type: 'data_record',
        // No 'form' field — this distinguishes messages from reports
        from: '+254700000099',
        sms_message: {
          from: '+254700000099',
          message: 'Test SMS message for PostgreSQL sync',
          sent_timestamp: Date.now(),
        },
        reported_date: Date.now(),
      };
      await utils.saveDoc(messageDoc);

      const pgDoc = await utils.waitForDocInPostgres(msgId, 45000);
      expect(pgDoc).to.exist;
      expect(pgDoc.type).to.equal('data_record');
      expect(pgDoc).to.not.have.property('form'); // messages have no form
      expect(pgDoc.sms_message).to.exist;
      expect(pgDoc.sms_message.message).to.equal('Test SMS message for PostgreSQL sync');
      expect(pgDoc.from).to.equal('+254700000099');

      await utils.deleteDoc(msgId);
    });
  });

  describe('sensitive/private document fields', () => {
    it('should replicate reports with private fields intact in PostgreSQL', async function () {
      this.timeout(60000);
      // CHT supports fields.private = 'yes' to exclude sensitive fields from
      // subordinate user replication. This is a replication-level filter, NOT
      // a cht-sync filter — private docs should still appear fully in PostgreSQL.
      const reportId = `integrity-private-${uuid()}`;
      const report = {
        _id: reportId,
        type: 'data_record',
        form: 'pregnancy',
        fields: {
          patient_name: 'Confidential Patient',
          private: 'yes',
          hiv_status: 'positive',
        },
        reported_date: Date.now(),
      };
      await utils.saveDoc(report);

      const pgDoc = await utils.waitForDocInPostgres(reportId, 45000);
      expect(pgDoc).to.exist;
      // cht-sync replicates ALL documents fully — private field filtering
      // is a client replication concern, not a cht-sync concern
      expect(pgDoc.fields.private).to.equal('yes');
      expect(pgDoc.fields.hiv_status).to.equal('positive');
      expect(pgDoc.fields.patient_name).to.equal('Confidential Patient');

      await utils.deleteDoc(reportId);
    });
  });

  describe('couchdb_progress tracking', () => {
    it('should track sync progress with source, seq, pending, and updated_at', async () => {
      const progress = await utils.getPostgresProgress();
      expect(progress).to.be.an('array').that.is.not.empty;

      for (const entry of progress) {
        expect(entry).to.have.property('source');
        expect(entry).to.have.property('seq');
        expect(entry).to.have.property('updated_at');
        // pending may be 0 or null when caught up
        expect(entry).to.have.property('pending');
      }
    });

    it('should advance seq after new documents are synced', async function () {
      this.timeout(60000);
      const progressBefore = await utils.getPostgresProgress();
      const sourceBefore = progressBefore[0];

      // Create a document to advance the changes feed
      const docId = `integrity-progress-${uuid()}`;
      await utils.saveDoc({
        _id: docId,
        type: 'data_record',
        fields: {},
        reported_date: Date.now(),
      });
      await utils.waitForDocInPostgres(docId, 45000);

      const progressAfter = await utils.getPostgresProgress();
      const sourceAfter = progressAfter.find(p => p.source === sourceBefore.source);
      expect(sourceAfter).to.exist;
      // Seq should have advanced (CouchDB seqs are strings but should differ)
      expect(sourceAfter.seq).to.not.equal(sourceBefore.seq);
      // updated_at should be recent
      const updatedAt = new Date(sourceAfter.updated_at);
      expect(updatedAt.getTime()).to.be.above(Date.now() - 120000); // within last 2 minutes

      await utils.deleteDoc(docId);
    });
  });

  describe('source identifier tracking', () => {
    it('should record the CouchDB source for each document', async function () {
      this.timeout(60000);
      const docId = `integrity-source-${uuid()}`;
      await utils.saveDoc({
        _id: docId,
        type: 'data_record',
        fields: {},
        reported_date: Date.now(),
      });
      await utils.waitForDocInPostgres(docId, 45000);

      const row = await utils.getPostgresRawRow(docId);
      expect(row).to.exist;
      // source should be set to the CouchDB hostname:port/dbname
      expect(row.source).to.be.a('string').that.is.not.empty;
      // source should match the progress table's source
      const progress = await utils.getPostgresProgress();
      const sources = progress.map(p => p.source);
      expect(sources).to.include(row.source);

      await utils.deleteDoc(docId);
    });
  });

  describe('UPSERT conflict resolution', () => {
    it('should update existing documents via ON CONFLICT (_id) DO UPDATE', async function () {
      this.timeout(60000);
      const docId = `integrity-upsert-${uuid()}`;
      const doc = {
        _id: docId,
        type: 'data_record',
        fields: { version: 1 },
        reported_date: Date.now(),
      };
      await utils.saveDoc(doc);
      await utils.waitForDocInPostgres(docId, 45000);

      // Get initial saved_timestamp
      const rowV1 = await utils.getPostgresRawRow(docId);
      expect(rowV1.doc.fields.version).to.equal(1);
      const tsV1 = new Date(rowV1.saved_timestamp).getTime();

      // Update the document
      const savedDoc = await utils.getDoc(docId);
      savedDoc.fields.version = 2;
      await utils.saveDoc(savedDoc);

      // Wait for the UPSERT to update the existing row
      const maxWait = 30000;
      const start = Date.now();
      let rowV2;
      while (Date.now() - start < maxWait) {
        rowV2 = await utils.getPostgresRawRow(docId);
        if (rowV2 && rowV2.doc.fields?.version === 2) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      expect(rowV2.doc.fields.version).to.equal(2);

      // saved_timestamp should have been updated
      const tsV2 = new Date(rowV2.saved_timestamp).getTime();
      expect(tsV2).to.be.at.least(tsV1);

      // There should be exactly ONE row (UPSERT, not INSERT)
      const countResult = await utils.pgQuery(
        `SELECT COUNT(*) as cnt FROM ${utils.pgDocsTable()} WHERE _id = $1`,
        [docId]
      );
      expect(parseInt(countResult.rows[0].cnt)).to.equal(1);

      await utils.deleteDoc(docId);
    });
  });
});
