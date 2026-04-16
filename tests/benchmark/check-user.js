const http = require('http');
const AUTH = 'Basic ' + Buffer.from('admin:secret21512').toString('base64');

function req(path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: 'couchdb', port: 5984, path, headers: { Authorization: AUTH } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

(async () => {
  const username = process.argv[2] || 'chw_test_1';

  console.log('=== _users doc ===');
  const usersDoc = await req(`/_users/org.couchdb.user:${username}`);
  console.log('roles:', usersDoc.roles);
  console.log('type:', usersDoc.type);
  console.log('contact_id:', usersDoc.contact_id);
  console.log('facility_id:', usersDoc.facility_id);

  console.log('\n=== medic user-settings doc ===');
  const medicDoc = await req(`/medic/org.couchdb.user:${username}`);
  console.log('roles:', medicDoc.roles);
  console.log('type:', medicDoc.type);
  console.log('contact_id:', medicDoc.contact_id);
  console.log('facility_id:', medicDoc.facility_id);
})();
