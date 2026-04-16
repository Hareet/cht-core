const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const COUCH_URL = 'http://admin:secret21512@couchdb:5984';
const POWERSYNC_URL = 'http://powersync:8080';
const KEY_PATH = '/workspace/cht-core/.devcontainer/powersync-config/dev-private-key.pem';

function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }
function b64url(b) { return b.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,''); }

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = { hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: {} };
    if (u.username) opts.headers['Authorization'] = 'Basic ' + Buffer.from(`${u.username}:${u.password}`).toString('base64');
    http.get(opts, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(JSON.parse(d))); }).on('error', reject);
  });
}

function generateJwt(user, roles) {
  const pk = fs.readFileSync(KEY_PATH, 'utf8');
  const now = Math.floor(Date.now()/1000);
  const h = b64url(Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT',kid:'cht-dev-key-1'})));
  const p = b64url(Buffer.from(JSON.stringify({
    sub: user._id, aud:'cht-powersync-dev', iat:now, exp:now+86400,
    role_hash: md5(roles.sort().join(',')),
    contact_id: user.contact_id||'', report_depth:-1, can_view_unallocated:'false', roles
  })));
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${h}.${p}`);
  return `${h}.${p}.${b64url(sign.sign(pk))}`;
}

(async () => {
  const user = await fetchJson(`${COUCH_URL}/medic/org.couchdb.user:chw_test_1`);
  const roles = ['chw_min_5km'];
  const token = generateJwt(user, roles);

  const { PowerSyncDatabase } = require('@powersync/node');
  const { Schema, Table, Column, ColumnType } = require('@powersync/common');

  const t = (name) => new Column({name, type: ColumnType.TEXT});
  const schema = new Schema([
    new Table({name:'contacts', columns:[t('name'),t('contact_type'),t('parent_id'),t('doc')]}),
    new Table({name:'reports', columns:[t('form'),t('patient_id'),t('doc')]}),
    new Table({name:'tasks', columns:[t('task_user'),t('state'),t('doc')]}),
    new Table({name:'global_config', columns:[t('doc_type'),t('doc')]}),
    new Table({name:'user_settings_doc', columns:[t('doc_type'),t('doc')]}),
  ]);

  const db = new PowerSyncDatabase({schema, database:{dbFilename:`/tmp/ps-quick-${Date.now()}.db`}});
  await db.getAll('SELECT 1');
  console.log('DB ready');

  db.connect({
    fetchCredentials: async () => ({ endpoint: POWERSYNC_URL, token }),
    uploadData: async () => {},
  });
  console.log('Connected, monitoring for 60s...');

  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const tables = await db.getAll("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const counts = {};
    for (const tbl of tables) {
      try {
        const r = await db.get(`SELECT COUNT(*) as c FROM "${tbl.name}"`);
        if (r.c > 0) counts[tbl.name] = r.c;
      } catch {}
    }
    const syncStatus = db.currentStatus;
    console.log(`${(i+1)*5}s:`, JSON.stringify(counts),
      `connected=${syncStatus?.connected}`,
      `lastSynced=${syncStatus?.lastSyncedAt}`);
  }

  await db.disconnectAndClear();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
