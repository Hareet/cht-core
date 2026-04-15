#!/usr/bin/env node
/**
 * Parallel facility refresh — uses all available CPU cores.
 * Processes users in batches of CONCURRENCY, each in its own PG connection.
 *
 * Usage:
 *   node refresh-facilities-parallel.js              # all users
 *   node refresh-facilities-parallel.js --chw-only   # skip managers/national_admin
 */
const pg = require('pg');

const CONCURRENCY = parseInt(process.env.CONCURRENCY || '12');
const CHW_ONLY = process.argv.includes('--chw-only');

async function run() {
  const pool = new pg.Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    user: process.env.POSTGRES_USER || 'cht',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'cht',
    max: CONCURRENCY + 2,
  });

  let query = 'SELECT user_id, username, roles FROM v1.user_settings';
  if (CHW_ONLY) {
    query += " WHERE '{district_admin}' && roles";
  }
  const users = (await pool.query(query)).rows;
  console.log(`Processing ${users.length} users at concurrency ${CONCURRENCY}` +
    (CHW_ONLY ? ' (CHW only)' : ' (all users)'));

  let done = 0;
  let errors = 0;
  const start = Date.now();

  // Process in parallel batches
  for (let i = 0; i < users.length; i += CONCURRENCY) {
    const batch = users.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (user) => {
      const client = await pool.connect();
      try {
        await client.query("SET work_mem = '2GB'");
        await client.query('SELECT v1.refresh_user_facilities($1)', [user.user_id]);
        done++;
      } catch (e) {
        errors++;
        console.error(`  ERROR ${user.username}: ${e.message.substring(0, 80)}`);
      } finally {
        client.release();
      }
    }));
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const rate = (done / (Date.now() - start) * 1000).toFixed(1);
    console.log(`  ${done}/${users.length} done (${elapsed}s, ${rate} users/sec)`);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nComplete: ${done} users in ${elapsed}s (${errors} errors)`);

  const uaf = await pool.query('SELECT count(*) FROM v1.user_accessible_facilities');
  console.log(`user_accessible_facilities: ${uaf.rows[0].count} rows`);

  const sample = await pool.query(`
    SELECT us.username, array_to_string(us.roles, ',') as roles, count(uaf.facility_id) as facilities
    FROM v1.user_settings us
    JOIN v1.user_accessible_facilities uaf ON uaf.user_id = us.user_id
    GROUP BY us.username, us.roles
    ORDER BY facilities DESC
    LIMIT 10
  `);
  console.log('\nTop users by facility count:');
  sample.rows.forEach(r => console.log(`  ${r.username} (${r.roles}): ${r.facilities}`));

  await pool.end();
}

run().catch(e => { console.error(e.message); process.exit(1); });
