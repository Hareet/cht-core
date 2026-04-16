const { Client } = require('pg');

(async () => {
  const client = new Client({ host: 'postgres', user: 'cht', password: 'pgpass', database: 'cht' });
  await client.connect();

  const username = process.argv[2] || 'chw_test_1';
  const userId = `org.couchdb.user:${username}`;

  // Check user_settings table
  const us = await client.query('SELECT * FROM v1.user_settings WHERE user_id = $1', [userId]);
  console.log('=== v1.user_settings ===');
  if (us.rows.length) {
    console.log(JSON.stringify(us.rows[0], null, 2));
  } else {
    console.log('NOT FOUND');
  }

  // Check accessible facilities
  const af = await client.query('SELECT count(*) as cnt FROM v1.user_accessible_facilities WHERE user_id = $1', [userId]);
  console.log('\n=== accessible_facilities count ===');
  console.log(af.rows[0].cnt);

  // Check what roles the Sync Streams expect
  const roles = await client.query("SELECT DISTINCT doc->>'roles' as roles FROM v1.couchdb WHERE _id = $1", [userId]);
  console.log('\n=== roles from couchdb doc ===');
  console.log(roles.rows[0]?.roles);

  await client.end();
})();
