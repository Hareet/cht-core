'use strict';

const db = require('./db');

// PostgreSQL changes detection using LISTEN/NOTIFY.
//
// cht-sync already creates a trigger on v1.couchdb that fires pg_notify('couchdb_changes', ...)
// on every INSERT or UPDATE. The payload is JSON: { id, deleted, saved_timestamp }.
//
// This module listens on that channel and accumulates changed document IDs.
// The purge engine can drain the accumulated IDs to know what to re-evaluate.

let client = null;
let changedIds = new Set();
let listening = false;

const start = async () => {
  if (listening) {
    return;
  }

  client = await db.getClient();

  client.on('notification', (msg) => {
    if (msg.channel !== 'couchdb_changes') {
      return;
    }

    try {
      const payload = JSON.parse(msg.payload);
      if (payload.id && !payload.deleted) {
        changedIds.add(payload.id);
      }
    } catch {
      // Ignore malformed payloads
    }
  });

  client.on('error', (err) => {
    console.error('LISTEN client error:', err.message);
    listening = false;
    // Reconnect after a short delay
    setTimeout(() => start().catch(console.error), 5000);
  });

  await client.query('LISTEN couchdb_changes');
  listening = true;
  console.log('Listening for couchdb_changes notifications');
};

// Drain accumulated changed IDs. Returns the set and clears it.
const drain = () => {
  const ids = changedIds;
  changedIds = new Set();
  return ids;
};

const stop = async () => {
  if (client) {
    try {
      await client.query('UNLISTEN couchdb_changes');
    } catch {
      // Ignore errors during cleanup
    }
    client.release();
    client = null;
  }
  listening = false;
};

const isListening = () => listening;

module.exports = {
  start,
  drain,
  stop,
  isListening,
};
