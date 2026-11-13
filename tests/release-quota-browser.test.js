'use strict';
// Offline browser only: all network requests intercepted; every service/API is a fixture.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { devBaseLoaderOf } = require('./helpers/dev-base-fake.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const F = require('./helpers/release-workspace-fixture.js'), E = require('./helpers/release-explanation-fixture.js');
const root = path.resolve(__dirname, '..');
const usage = (consultation = 1, creation = 3) => ({ version: 2, plan: 'toolkit-light', yyyymm: '209910', resetsAt: '2099-10-31T15:00:00.000Z', timeZone: 'Asia/Tokyo', buckets: { consultation: { limit: 100, used: 100 - consultation, reserved: 0, remaining: consultation }, creation: { limit: 15, used: 15 - creation, reserved: 0, remaining: creation } } });
test('接続の残数を応答ごとに更新し、相談上限でも作成でき、作成上限でも無料操作と会話を残す', { timeout: 90000 }, async () => {
  let pw; try { pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); } catch { pw = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
  const { describeRegistry } = await import(require('./helpers/ai-repo.js').aiUrl('worker/src/v2/prompt-registry.mjs'));
  const health = { ok: true, supportedContractVersions: ['2.1'], registry: describeRegistry(), entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }] };
  const prod = { appId: '310', appName: '回数表示の確認', fields: { memo: { type: 'MULTI_LINE_TEXT', code: 'memo', label: '備考' } }, layout: [], views: { views: {}, revision: '1' }, status: { enable: false, states: {}, actions: [] }, customize: { scope: 'ALL', desktop: { js: [], css: [] }, mobile: { js: [], css: [] } } };
  const T = loadToolkit(), mock = makeKintoneMock(prod), loadBase = devBaseLoaderOf({ KTDevBase: { load: T.KTDevBase.loadForRelease } }, { appId: '310', production: prod, mockRef: () => mock });
  let current = usage(), failNext = false, holdHealth = false, holdProposal = true;
  const proposalHeld = F.deferred(), healthHeld = F.deferred(), healthStarted = F.deferred(); const calls = [], unexpected = [], errors = [];
  const browser = await pw.chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    await context.route('**/*', route => { if (route.request().url() === 'https://quota.test.invalid/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ja"><meta charset="utf-8"><div id="app" style="height:100vh"></div></html>' }); unexpected.push(route.request().url()); return route.abort(); });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.exposeFunction('base', loadBase); await page.exposeFunction('api', (name, args) => mock.api[name](...args));
    await page.exposeFunction('service', async (name, ctx) => {
      calls.push({ name, purpose: ctx?.requestPurpose });
      if (name === 'getHealth') { const snapshot = JSON.parse(JSON.stringify(current)); if (holdHealth) { healthStarted.resolve(); await healthHeld.promise; } return { ...health, meta: { usage: snapshot } }; }
      if (name === 'propose' && holdProposal) await proposalHeld.promise;
      const bucket = name === 'propose' && ctx.requestPurpose !== 'document' ? 'consultation' : 'creation';
      if (failNext) { failNext = false; current = usage(0, 0); return { failure: { code: 'MONTHLY_LIMIT_EXCEEDED', details: { error: { detail: { bucket, usage: current } } } } }; }
      current.buckets[bucket].remaining--; current.buckets[bucket].used++;
      const body = name === 'plan' ? F.plan({ settings: false }) : name === 'generate' ? F.generated(ctx.customization) : ctx.requestPurpose === 'document' ? E.response('資料の固定応答') : F.proposal();
      return { ...body, usage: current };
    });
    await page.goto('https://quota.test.invalid/');
    let source = fs.readFileSync(path.join(root, 'kintoneAppToolkit.user.js'), 'utf8').replace('waitReady().then(() => startToolkit());', '');
    const end = source.lastIndexOf('})();'); source = source.slice(0, end) + '\nglobalThis.QuotaTest={mountReleaseWorkspace,KTAiClient};\n' + source.slice(end);
    await page.addScriptTag({ content: source });
    await page.evaluate(({ prod, names }) => {
      const settings = QuotaTest.KTAiClient.createSettingsStore(); settings.setConsent(true, 'release-raw-source-1'); window.copies = [];
      const client = Object.fromEntries(['getHealth', 'propose', 'plan', 'generate'].map(name => [name, async input => { const r = await window.service(name, input?.ctx); if (r.failure) throw new QuotaTest.KTAiClient.AiClientError(r.failure); return r; }]));
      window.work = QuotaTest.mountReleaseWorkspace(document.querySelector('#app'), { appId: '310', settings, session: { client, status: () => ({ connected: true, apiBase: 'https://gateway.test.invalid' }) }, loadDevBase: window.base, executor: { api: Object.fromEntries(names.map(name => [name, (...args) => window.api(name, args)])) }, getInputs: () => ({ data: prod }), copyText: async text => copies.push(text) }); work.onVisible();
    }, { prod, names: Object.keys(mock.api) });
    const action = name => page.locator('[data-release-action="' + name + '"]').first();
    const phase = value => page.waitForFunction(v => work.controller.getState().phase === v, value);
    const open = async () => { await action('connect').click(); return page.locator('dialog'); };
    await page.waitForFunction(() => work.capability().available);
    await page.locator('#kt-release-input').fill(F.REQUEST); await action('send').click();
    holdHealth = true; await page.evaluate(() => { window.pendingHealth = work.refreshCapability(true); }); await healthStarted.promise;
    holdProposal = false; proposalHeld.resolve(); await phase('proposal');
    healthHeld.resolve(); await page.evaluate(() => pendingHealth); holdHealth = false;
    assert.equal(await page.evaluate(() => work.capability().usage.buckets.consultation.remaining), 0, '先に始めたhealthの残り1回で完了応答の0回を巻き戻さない');
    assert.equal(await action('send').isDisabled(), true); assert.equal(await page.locator('#kt-release-input').isEnabled(), true); assert.equal(await action('adopt').isEnabled(), true);
    await action('adopt').click(); await phase('review');
    assert.deepEqual(calls.filter(c => c.name !== 'getHealth').map(c => c.name), ['propose', 'plan', 'generate', 'generate']);
    assert.equal(await action('apply').isEnabled(), true);
    const before = await page.evaluate(() => work.controller.getState());
    let dialog = await open(); assert.match(await dialog.locator('[data-usage-bucket="consultation"]').innerText(), /残り 0回/); assert.match(await dialog.locator('[data-usage-bucket="creation"]').innerText(), /残り 0回/);
    assert.match(await dialog.locator('[data-usage-reset]').innerText(), /2099年11月1日.*00:00.*日本時間/); assert.match(await dialog.innerText(), /契約全体で共有/); assert.doesNotMatch(await dialog.innerText(), /米ドル|token|gpt-/i);
    await dialog.getByText('回数の数え方', { exact: true }).click(); assert.match(await dialog.innerText(), /コード生成の要求ごとに作成1回/);
    const out = path.join(__dirname, '.build/release-quota'); fs.mkdirSync(out, { recursive: true }); await page.screenshot({ path: path.join(out, 'connection-usage.png') });
    await dialog.locator('[data-close]').click();
    await action('documents').click(); dialog = page.locator('dialog'); assert.equal(await dialog.locator('[data-document-create]').isDisabled(), true); assert.equal(await dialog.locator('[data-offline-export]').isEnabled(), true); await dialog.locator('[data-close]').click();
    assert.deepEqual(await page.evaluate(() => work.controller.getState().artifacts), before.artifacts);
    current = usage(4, 1); await page.evaluate(() => work.refreshCapability(true));
    await action('documents').click(); await page.locator('[data-document-create]').click(); await page.waitForFunction(() => work.controller.getState().explanations.length === 1);
    assert.equal(await action('copy-explanation').isEnabled(), true); await action('copy-explanation').click(); assert.equal(await page.evaluate(() => copies.length), 1);
    assert.equal(await action('send').isDisabled(), true); await action('focus-consultation').click(); assert.equal(await action('send').isEnabled(), true);
    failNext = true; await page.locator('#kt-release-input').fill('修正の相談'); await action('send').click(); await page.waitForFunction(() => work.controller.getState().error?.code === 'MONTHLY_LIMIT_EXCEEDED');
    assert.equal(await page.locator('#kt-release-input').inputValue(), '修正の相談'); assert.equal(await action('send').isDisabled(), true); assert.equal(await page.evaluate(() => work.controller.getState().explanations.length), 1);
    dialog = await open(); assert.match(await dialog.locator('[data-usage-bucket="consultation"]').innerText(), /残り 0回/);
    current = null; await page.evaluate(() => work.refreshCapability(true)); assert.match(await dialog.locator('[data-usage]').innerText(), /未確認/); assert.doesNotMatch(await dialog.locator('[data-usage]').innerText(), /残り 0/);
    current = { yyyymm: '209910', plan: 'old', monthlyLimit: 30, usedThisMonth: 30, remainingThisMonth: 0 }; await page.evaluate(() => work.refreshCapability(true)); assert.match(await dialog.locator('[data-usage-legacy]').innerText(), /残り 0回.*月 30回/);
    await dialog.locator('[data-close]').click(); assert.equal(await action('send').isDisabled(), true);
    current = usage(0, 0); current.buckets.consultation.used = 99; current.buckets.consultation.reserved = 1;
    await page.evaluate(() => work.refreshCapability(true)); assert.match(await page.locator('.ktr-compose-actions').innerText(), /処理中の分を確保/); assert.doesNotMatch(await page.locator('.ktr-compose-actions').innerText(), /今月.*上限/);
    current = usage(0, 0); current.resetsAt = new Date(Date.now() + 400).toISOString();
    await page.evaluate(() => work.refreshCapability(true)); assert.equal(await action('send').isDisabled(), true);
    await action('documents').click(); assert.equal(await page.locator('[data-document-create]').isDisabled(), true);
    current = usage(5, 7);
    await page.waitForFunction(() => work.capability().usage.buckets.consultation.remaining === 5);
    assert.equal(await page.locator('[data-document-create]').isEnabled(), true, '開いている資料ダイアログも更新する'); await page.locator('dialog [data-close]').click();
    assert.equal(await action('send').isEnabled(), true, '更新日時になると手動更新なしで古いゼロを解除し利用状況を取得する');
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  } finally { await browser.close(); }
});
