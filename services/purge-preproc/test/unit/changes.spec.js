'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const EventEmitter = require('events');

const db = require('../../src/db');
const changes = require('../../src/changes');

describe('Changes', () => {
  let fakeClient;

  beforeEach(() => {
    fakeClient = new EventEmitter();
    fakeClient.query = sinon.stub().resolves();
    fakeClient.release = sinon.stub();
    sinon.stub(db, 'getClient').resolves(fakeClient);
  });

  afterEach(async () => {
    await changes.stop();
    sinon.restore();
  });

  describe('drain', () => {
    it('should return changed and deleted sets separately', async () => {
      await changes.start();

      // Simulate changed doc notification
      fakeClient.emit('notification', {
        channel: 'couchdb_changes',
        payload: JSON.stringify({ id: 'doc1', deleted: false }),
      });

      // Simulate deleted doc notification
      fakeClient.emit('notification', {
        channel: 'couchdb_changes',
        payload: JSON.stringify({ id: 'doc2', deleted: true }),
      });

      // Simulate another changed doc
      fakeClient.emit('notification', {
        channel: 'couchdb_changes',
        payload: JSON.stringify({ id: 'doc3' }),
      });

      const { changed, deleted } = changes.drain();

      expect(changed.size).to.equal(2);
      expect(changed.has('doc1')).to.be.true;
      expect(changed.has('doc3')).to.be.true;
      expect(deleted.size).to.equal(1);
      expect(deleted.has('doc2')).to.be.true;
    });

    it('should clear sets after drain', async () => {
      await changes.start();

      fakeClient.emit('notification', {
        channel: 'couchdb_changes',
        payload: JSON.stringify({ id: 'doc1' }),
      });
      fakeClient.emit('notification', {
        channel: 'couchdb_changes',
        payload: JSON.stringify({ id: 'doc2', deleted: true }),
      });

      changes.drain();
      const { changed, deleted } = changes.drain();

      expect(changed.size).to.equal(0);
      expect(deleted.size).to.equal(0);
    });

    it('should ignore notifications from other channels', async () => {
      await changes.start();

      fakeClient.emit('notification', {
        channel: 'other_channel',
        payload: JSON.stringify({ id: 'doc1' }),
      });

      const { changed, deleted } = changes.drain();

      expect(changed.size).to.equal(0);
      expect(deleted.size).to.equal(0);
    });

    it('should ignore malformed payloads', async () => {
      await changes.start();

      fakeClient.emit('notification', {
        channel: 'couchdb_changes',
        payload: 'not json',
      });

      const { changed, deleted } = changes.drain();

      expect(changed.size).to.equal(0);
      expect(deleted.size).to.equal(0);
    });
  });
});
