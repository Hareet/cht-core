const http = require('http');
const AUTH = 'Basic ' + Buffer.from('admin:secret21512').toString('base64');

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = { method, hostname: 'couchdb', port: 5984, path, headers: { 'Content-Type': 'application/json', 'Authorization': AUTH }};
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const r = http.request(opts, res => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>resolve(JSON.parse(d))); });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const USERNAME = process.argv[2] || 'chw_test_1';
const PASSWORD = process.argv[3] || 'Secret1!pass';

(async () => {
  console.log(`Fixing user: ${USERNAME}, password: ${PASSWORD}`);

  const userDoc = await req('GET', `/_users/org.couchdb.user:${USERNAME}`);
  delete userDoc.password_change;
  delete userDoc.must_change_password;
  userDoc.password = PASSWORD;
  const r1 = await req('PUT', `/_users/org.couchdb.user:${USERNAME}`, JSON.stringify(userDoc));
  console.log('_users doc:', r1.ok ? 'updated' : JSON.stringify(r1));

  const settingsDoc = await req('GET', `/medic/org.couchdb.user:${USERNAME}`);
  delete settingsDoc.password_change;
  delete settingsDoc.must_change_password;
  const r2 = await req('PUT', `/medic/org.couchdb.user:${USERNAME}`, JSON.stringify(settingsDoc));
  console.log('user-settings:', r2.ok ? 'updated' : JSON.stringify(r2));
})();
