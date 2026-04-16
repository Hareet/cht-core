const http = require('http');
const AUTH = 'Basic ' + Buffer.from('admin:secret21512').toString('base64');

function pgQuery(sql) {
  // Use the API proxy to run psql since we can't use pg module
  return new Promise((resolve, reject) => {
    const { execSync } = require('child_process');
    try {
      const result = execSync(
        `PGPASSWORD=pgpass psql -h postgres -U cht -d cht -t -A -F'|' -c "${sql.replace(/"/g, '\\"')}"`,
        { encoding: 'utf8', timeout: 30000 }
      );
      resolve(result.trim());
    } catch (e) {
      reject(e);
    }
  });
}

(async () => {
  const userId = 'org.couchdb.user:chw_test_1';

  console.log('=== Bucket Analysis for chw_test_1 ===\n');

  // 1. Accessible facilities count
  const totalFac = await pgQuery(`SELECT count(*) FROM v1.user_accessible_facilities WHERE user_id = '${userId}'`);
  console.log(`Total accessible_facilities: ${totalFac}`);

  // 2. By depth
  const byDepth = await pgQuery(`SELECT depth, count(*) FROM v1.user_accessible_facilities WHERE user_id = '${userId}' GROUP BY depth ORDER BY depth`);
  console.log('\nBy depth:');
  byDepth.split('\n').forEach(r => {
    const [depth, count] = r.split('|');
    console.log(`  depth ${depth}: ${count} facilities`);
  });

  // 3. By contact_type
  const byType = await pgQuery(`
    SELECT COALESCE(c.doc->>'contact_type', c.doc->>'type') as ctype, count(*)
    FROM v1.user_accessible_facilities uaf
    JOIN v1.couchdb c ON c._id = uaf.facility_id
    WHERE uaf.user_id = '${userId}'
    GROUP BY 1 ORDER BY 2 DESC
  `);
  console.log('\nBy contact_type:');
  byType.split('\n').forEach(r => {
    const [ctype, count] = r.split('|');
    console.log(`  ${ctype}: ${count}`);
  });

  // 4. Bucket composition
  // all_data stream: 1 bucket per accessible_facility (shared CTE) + own reports + needs_signoff
  // tasks: 1 bucket (user_id filter)
  // global_config: 1 bucket (no filter)
  // user_settings_doc: 1 bucket (user_id filter)
  // user_meta: 1 bucket (user_id filter)
  // unassigned_reports: 1 bucket (if can_view_unallocated)
  const fixedBuckets = 5; // tasks + global_config + user_settings + user_meta + own_reports
  const cteEntries = parseInt(totalFac);
  const estimatedBuckets = cteEntries + fixedBuckets;
  console.log(`\nEstimated bucket breakdown:`);
  console.log(`  accessible_facilities (CTE): ${cteEntries}`);
  console.log(`  Fixed buckets (tasks, global, user_settings, user_meta, own_reports): ${fixedBuckets}`);
  console.log(`  Estimated total: ${estimatedBuckets}`);
  console.log(`  Actual (from PowerSync log): 453`);

  // 5. What's in the CTE that shouldn't be?
  // Families and households are places in CIV — do they need to be in accessible_facilities?
  const familyHousehold = await pgQuery(`
    SELECT COALESCE(c.doc->>'contact_type', c.doc->>'type') as ctype, count(*)
    FROM v1.user_accessible_facilities uaf
    JOIN v1.couchdb c ON c._id = uaf.facility_id
    WHERE uaf.user_id = '${userId}'
      AND COALESCE(c.doc->>'contact_type', c.doc->>'type') IN ('c80_family', 'c90_household')
    GROUP BY 1 ORDER BY 2 DESC
  `);
  console.log('\nFamilies + Households in CTE:');
  familyHousehold.split('\n').forEach(r => {
    const [ctype, count] = r.split('|');
    console.log(`  ${ctype}: ${count}`);
  });

  // 6. If we exclude families+households, what's the bucket count?
  const withoutFamHH = await pgQuery(`
    SELECT count(*) FROM v1.user_accessible_facilities uaf
    JOIN v1.couchdb c ON c._id = uaf.facility_id
    WHERE uaf.user_id = '${userId}'
      AND COALESCE(c.doc->>'contact_type', c.doc->>'type') NOT IN ('c80_family', 'c90_household')
  `);
  console.log(`\nWithout families+households: ${withoutFamHH} facilities`);
  console.log(`Estimated buckets: ${parseInt(withoutFamHH) + fixedBuckets}`);

  // 7. If we only keep structural places (chw_site and above)
  const structuralOnly = await pgQuery(`
    SELECT count(*) FROM v1.user_accessible_facilities uaf
    JOIN v1.couchdb c ON c._id = uaf.facility_id
    WHERE uaf.user_id = '${userId}'
      AND COALESCE(c.doc->>'contact_type', c.doc->>'type') IN (
        'c10_central', 'c20_region', 'c30_district',
        'c40_supervision_area', 'c50_health_area',
        'c60_locality', 'c70_chw_site',
        'clinic', 'health_center', 'district_hospital'
      )
  `);
  console.log(`\nStructural places only (chw_site+above): ${structuralOnly} facilities`);
  console.log(`Estimated buckets: ${parseInt(structuralOnly) + fixedBuckets}`);

})().catch(e => { console.error(e); process.exit(1); });
