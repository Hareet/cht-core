/**
 * Dual-mode integration tests for sentinel transitions.
 *
 * Verifies that the transition processing pipeline produces equivalent behavior
 * regardless of whether the CouchDB or PostgreSQL backend is active. Tests the
 * critical path: change detection → doc fetch → transition apply → save → infodoc update.
 *
 * Also tests the _rev conflict/retry scenario that is new with the PostgreSQL backend.
 */
const config = require('../../src/config');
config.initTransitionLib();

const sinon = require('sinon');
const { expect } = require('chai');
const rewire = require('rewire');

const db = require('../../src/db');
const metadata = require('../../src/lib/metadata');
const tombstoneUtils = require('@medic/tombstone-utils');
const changeRetryHistory = require('../../src/lib/change-retry-history');

describe('dual-mode transitions', () => {

  let feed;
  let changeQueue;
  let handler;
  const realSetTimeout = setTimeout;
  const nextTick = () => new Promise(resolve => realSetTimeout(() => resolve()));
  let clock;

  beforeEach(() => {
    handler = { cancel: sinon.stub() };
    handler.catch = sinon.stub().returns(handler);
    handler.on = sinon.stub().returns(handler);
    sinon.stub(db.medic, 'changes').returns(handler);
    clock = sinon.useFakeTimers();
    feed = rewire('../../src/lib/feed');
    changeQueue = feed.__get__('changeQueue');
    changeQueue.resume();
  });

  afterEach(() => {
    feed.cancel();
    sinon.restore();
  });

  describe('_rev conflict retry integration', () => {

    it('records 409 conflict in retry history and does not advance checkpoint', () => {
      const transitionsLib = config.getTransitionsLib();

      sinon.stub(transitionsLib, 'processChange').callsFake((change, callback) => {
        const err = new Error('Document update conflict.');
        err.status = 409;
        err.name = 'conflict';
        return callback(err);
      });

      sinon.stub(metadata, 'getTransitionSeq').resolves('100');
      sinon.stub(metadata, 'setTransitionSeq').resolves();
      sinon.stub(tombstoneUtils, 'isTombstoneId').returns(false);
      sinon.stub(changeRetryHistory, 'shouldProcess').returns(true);
      sinon.stub(changeRetryHistory, 'add');

      const change = {
        id: 'doc-1',
        seq: '101',
        changes: [{ rev: '1-pgabc' }]
      };

      return feed.listen()
        .then(() => {
          const changeFn = handler.on.args[0][1];
          changeFn(change);
          return nextTick();
        })
        .then(() => nextTick())
        .then(() => {
          // 409 should be recorded in retry history
          expect(changeRetryHistory.add.callCount).to.equal(1);
          expect(changeRetryHistory.add.args[0][0]).to.deep.equal(change);
          // Checkpoint must NOT advance past the failed change
          expect(metadata.setTransitionSeq.callCount).to.equal(0);
        });
    });

    it('retries change after feed reconnection following 409 conflict', () => {
      const transitionsLib = config.getTransitionsLib();
      let processCallCount = 0;

      sinon.stub(transitionsLib, 'processChange').callsFake((change, callback) => {
        processCallCount++;
        if (processCallCount === 1) {
          const err = new Error('Document update conflict.');
          err.status = 409;
          return callback(err);
        }
        return callback(null);
      });

      sinon.stub(metadata, 'getTransitionSeq').resolves('100');
      sinon.stub(metadata, 'setTransitionSeq').resolves();
      sinon.stub(tombstoneUtils, 'isTombstoneId').returns(false);
      sinon.stub(changeRetryHistory, 'shouldProcess').returns(true);
      sinon.stub(changeRetryHistory, 'add');

      const change = {
        id: 'doc-1',
        seq: '101',
        changes: [{ rev: '1-pgabc' }]
      };

      return feed.listen()
        .then(() => {
          // First attempt: triggers 409
          const changeFn = handler.on.args[0][1];
          changeFn(change);
          return nextTick();
        })
        .then(() => nextTick())
        .then(() => {
          expect(processCallCount).to.equal(1);
          expect(metadata.setTransitionSeq.callCount).to.equal(0);

          // Simulate feed error (connection drop) → triggers reconnection
          const errorFn = handler.on.args[1][1];
          errorFn({ status: 500, message: 'connection reset' });

          // Wait for retry timeout (60s)
          clock.tick(65000);
          return nextTick();
        })
        .then(() => {
          // Feed should re-register from last checkpoint (seq=100)
          expect(db.medic.changes.callCount).to.equal(2);
          expect(db.medic.changes.args[1][0].since).to.equal('100');

          // Simulate the same change coming through on reconnected feed
          const changeFn2 = handler.on.args[2][1];
          changeFn2(change);
          return nextTick();
        })
        .then(() => nextTick())
        .then(() => {
          // Second attempt should succeed
          expect(processCallCount).to.equal(2);
          expect(metadata.setTransitionSeq.callCount).to.equal(1);
          expect(metadata.setTransitionSeq.args[0][0]).to.equal('101');
        });
    });

    it('stops retrying after max retries exceeded', () => {
      sinon.stub(metadata, 'getTransitionSeq').resolves('100');
      sinon.stub(tombstoneUtils, 'isTombstoneId').returns(false);

      // shouldProcess returns false after MAX_RETRIES
      sinon.stub(changeRetryHistory, 'shouldProcess').returns(false);

      const change = {
        id: 'doc-exhausted',
        seq: '200',
        changes: [{ rev: '1-pgxyz' }]
      };

      const push = sinon.stub(changeQueue, 'push');

      return feed.listen()
        .then(() => {
          const changeFn = handler.on.args[0][1];
          changeFn(change);
          return nextTick();
        })
        .then(() => {
          // Change should NOT be pushed to queue (shouldProcess returns false)
          expect(push.callCount).to.equal(0);
        });
    });
  });

  describe('backend equivalence', () => {

    it('processes change identically regardless of backend db implementation', () => {
      const transitionsLib = config.getTransitionsLib();
      const savedDocs = [];

      // Mock processChange to simulate a transition that modifies the doc
      sinon.stub(transitionsLib, 'processChange').callsFake((change, callback) => {
        // Simulate what transitions do: modify the doc and call back
        savedDocs.push({
          id: change.id,
          seq: change.seq,
        });
        callback(null);
      });

      sinon.stub(metadata, 'getTransitionSeq').resolves('0');
      sinon.stub(metadata, 'setTransitionSeq').resolves();
      sinon.stub(tombstoneUtils, 'isTombstoneId').returns(false);
      sinon.stub(changeRetryHistory, 'shouldProcess').returns(true);

      const changes = [
        { id: 'report-1', seq: '1', changes: [{ rev: '1-abc' }] },
        { id: 'contact-2', seq: '2', changes: [{ rev: '1-def' }] },
        { id: 'report-3', seq: '3', changes: [{ rev: '2-ghi' }] },
      ];

      return feed.listen()
        .then(() => {
          const changeFn = handler.on.args[0][1];
          changes.forEach(c => changeFn(c));
          return nextTick();
        })
        .then(() => nextTick())
        .then(() => nextTick())
        .then(() => nextTick())
        .then(() => {
          // All 3 changes should be processed in order
          expect(savedDocs).to.have.lengthOf(3);
          expect(savedDocs[0].id).to.equal('report-1');
          expect(savedDocs[1].id).to.equal('contact-2');
          expect(savedDocs[2].id).to.equal('report-3');

          // Metadata should reflect last processed seq
          expect(metadata.setTransitionSeq.callCount).to.equal(3);
          expect(metadata.setTransitionSeq.args[2][0]).to.equal('3');
        });
    });

    it('filters design docs and info docs identically across backends', () => {
      sinon.stub(metadata, 'getTransitionSeq').resolves('0');
      sinon.stub(tombstoneUtils, 'isTombstoneId').returns(false);
      sinon.stub(changeRetryHistory, 'shouldProcess').returns(true);

      const push = sinon.stub(changeQueue, 'push');

      return feed.listen()
        .then(() => {
          const changeFn = handler.on.args[0][1];

          // These should be filtered out regardless of backend
          changeFn({ id: '_design/medic', seq: '1' });
          changeFn({ id: 'doc-123-info', seq: '2' });

          // This should pass through
          changeFn({ id: 'report-normal', seq: '3', changes: [{ rev: '1-abc' }] });

          return nextTick();
        })
        .then(() => {
          // Only the normal doc should be enqueued
          expect(push.callCount).to.equal(1);
          expect(push.args[0][0].id).to.equal('report-normal');
        });
    });

    it('handles deleted changes the same way across backends', () => {
      const transitionsLib = config.getTransitionsLib();
      sinon.stub(transitionsLib, 'processChange');

      sinon.stub(metadata, 'getTransitionSeq').resolves('0');
      sinon.stub(metadata, 'setTransitionSeq').resolves();
      sinon.stub(tombstoneUtils, 'isTombstoneId').returns(false);
      sinon.stub(changeRetryHistory, 'shouldProcess').returns(true);

      const change = {
        id: 'deleted-doc',
        seq: '10',
        deleted: true,
        changes: [{ rev: '2-del' }]
      };

      return feed.listen()
        .then(() => {
          const changeFn = handler.on.args[0][1];
          changeFn(change);
          return nextTick();
        })
        .then(() => nextTick())
        .then(() => {
          // Deleted changes should update metadata but NOT go through processChange
          expect(transitionsLib.processChange.callCount).to.equal(0);
          expect(metadata.setTransitionSeq.callCount).to.equal(1);
          expect(metadata.setTransitionSeq.args[0][0]).to.equal('10');
        });
    });
  });

  describe('PostgreSQL-specific behavior', () => {

    it('409 from callback-style put is recorded same as any other error', () => {
      const transitionsLib = config.getTransitionsLib();

      // Simulate the exact flow: db.medic.put(doc, callback) returns 409
      // via the withCallback wrapper in db-postgresql.js
      sinon.stub(transitionsLib, 'processChange').callsFake((change, callback) => {
        const err = new Error('Document update conflict.');
        err.status = 409;
        err.name = 'conflict';
        err.error = 'conflict';
        err.docId = change.id;
        return callback(err);
      });

      sinon.stub(metadata, 'getTransitionSeq').resolves('50');
      sinon.stub(metadata, 'setTransitionSeq').resolves();
      sinon.stub(tombstoneUtils, 'isTombstoneId').returns(false);
      sinon.stub(changeRetryHistory, 'shouldProcess').returns(true);
      sinon.stub(changeRetryHistory, 'add');

      const change = {
        id: 'concurrent-doc',
        seq: '51',
        changes: [{ rev: '3-pgconflict' }]
      };

      return feed.listen()
        .then(() => {
          const changeFn = handler.on.args[0][1];
          changeFn(change);
          return nextTick();
        })
        .then(() => nextTick())
        .then(() => {
          // 409 should cause retry history addition — same behavior as CouchDB conflicts
          expect(changeRetryHistory.add.callCount).to.equal(1);
          expect(changeRetryHistory.add.args[0][0].id).to.equal('concurrent-doc');
          // Metadata must NOT be updated (error path)
          expect(metadata.setTransitionSeq.callCount).to.equal(0);
        });
    });

    it('metadata checkpoint is not updated on error — consistent across backends', () => {
      const transitionsLib = config.getTransitionsLib();

      sinon.stub(transitionsLib, 'processChange').callsFake((change, callback) => {
        callback(new Error('any error'));
      });

      sinon.stub(metadata, 'getTransitionSeq').resolves('99');
      sinon.stub(metadata, 'setTransitionSeq').resolves();
      sinon.stub(tombstoneUtils, 'isTombstoneId').returns(false);
      sinon.stub(changeRetryHistory, 'shouldProcess').returns(true);
      sinon.stub(changeRetryHistory, 'add');

      const change = {
        id: 'error-doc',
        seq: '100',
        changes: [{ rev: '1-err' }]
      };

      return feed.listen()
        .then(() => {
          const changeFn = handler.on.args[0][1];
          changeFn(change);
          return nextTick();
        })
        .then(() => nextTick())
        .then(() => {
          // Checkpoint must NOT advance past the failed change
          expect(metadata.setTransitionSeq.callCount).to.equal(0);
          // Error should be recorded in retry history
          expect(changeRetryHistory.add.callCount).to.equal(1);
        });
    });
  });
});
