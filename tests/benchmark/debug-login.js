const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--ignore-certificate-errors','--disable-gpu'],
  });
  const page = await browser.newPage();
  page.on('console', msg => console.log('[PAGE]', msg.text()));
  page.on('pageerror', err => console.log('[ERROR]', err.message));

  console.log('Loading login page...');
  await page.goto('https://nginx/medic/login', { waitUntil: 'networkidle2', timeout: 30000 });
  console.log('URL:', page.url());
  console.log('Title:', await page.title());

  const hasForm = await page.evaluate(() => !!document.querySelector('#user'));
  console.log('Login form found:', hasForm);

  const USER = process.argv[2] || 'chw_test_1';
  const PASS = process.argv[3] || 'BenchTest2026!';
  console.log('Logging in as:', USER);
  await page.type('#user', USER);
  await page.type('#password', PASS);
  await page.click('#login');
  console.log('Login clicked, waiting 10s...');

  await new Promise(r => setTimeout(r, 10000));
  console.log('URL after login:', page.url());

  // Handle password reset if prompted
  if (page.url().includes('password-reset')) {
    console.log('Password reset required, completing...');
    const NEW_PASS = PASS + '2';
    // Fill: current password, new password, confirm password
    const inputs = await page.$$('input[type="password"]');
    console.log('Password inputs found:', inputs.length);
    if (inputs.length >= 3) {
      await inputs[0].type('Secret1!pass');
      await inputs[1].type(NEW_PASS);
      await inputs[2].type(NEW_PASS);
      // Find the submit button
      const btnSelector = await page.evaluate(() => {
        const candidates = [...document.querySelectorAll('button, input[type=submit], a.btn, .submit')];
        return candidates.map(el => ({
          tag: el.tagName,
          type: el.type,
          text: el.textContent?.trim(),
          classes: el.className,
          id: el.id,
        }));
      });
      console.log('Buttons found:', JSON.stringify(btnSelector));
      // Click any button/submit element
      await page.evaluate(() => {
        const btn = document.querySelector('button') || document.querySelector('input[type=submit]') || document.querySelector('a.btn');
        if (btn) btn.click();
      });
      console.log('Password reset submitted, waiting 15s...');
      await new Promise(r => setTimeout(r, 15000));
      console.log('URL after reset:', page.url());
    } else {
      console.log('Unexpected form layout, dumping HTML...');
      const html = await page.evaluate(() => document.body.innerHTML.substring(0, 2000));
      console.log(html);
    }
  }

  // Handle "too many docs" replication warning dialog
  const hasWarning = await page.evaluate(() => {
    const body = document.body?.innerText || '';
    return body.includes('exceeds recommended limit') || body.includes('Do you wish to continue');
  });
  if (hasWarning) {
    console.log('Replication warning dialog detected, clicking Continue...');
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, a.btn')];
      const continueBtn = btns.find(b => b.textContent?.trim().toLowerCase() === 'continue');
      if (continueBtn) continueBtn.click();
    });
    await new Promise(r => setTimeout(r, 5000));
    console.log('URL after continue:', page.url());
  }

  const pageInfo = await page.evaluate(() => ({
    url: window.location.href,
    bodySnippet: document.body?.innerText?.substring(0, 500),
    hasPouchDB: typeof window.PouchDB !== 'undefined',
    hasNgVersion: !!document.querySelector('[ng-version]'),
    syncStatusEl: document.querySelector('.sync-status')?.outerHTML || null,
    windowKeys: Object.keys(window).filter(k => k.match(/pouch|sync|repl|db/i)),
  }));
  console.log('Page info:', JSON.stringify(pageInfo, null, 2));

  const storage = await page.evaluate(async () => {
    const est = await navigator.storage.estimate();
    return { usedMB: (est.usage/1e6).toFixed(1), quotaMB: (est.quota/1e6).toFixed(0) };
  });
  console.log('Storage:', storage);

  console.log('Waiting 30s for sync activity...');
  await new Promise(r => setTimeout(r, 30000));

  const storage2 = await page.evaluate(async () => {
    const est = await navigator.storage.estimate();
    return { usedMB: (est.usage/1e6).toFixed(1), quotaMB: (est.quota/1e6).toFixed(0) };
  });
  console.log('Storage after 30s:', storage2);
  console.log('URL now:', page.url());

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
