'use strict';
// Offline browser only. Real controller/client boundary; AI and kintone responses are fixtures.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { devBaseLoaderOf } = require('./helpers/dev-base-fake.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const F = require('./helpers/release-workspace-fixture.js'), E = require('./helpers/release-explanation-fixture.js');
const root = path.resolve(__dirname, '..');
const usage = (remaining = 4, reserved = 0) => ({ version: 3, plan: 'toolkit-light', yyyymm: '209910', resetsAt: '2099-10-31T15:00:00.000Z', timeZone: 'Asia/Tokyo', credits: { limit: 100, used: 100 - remaining - reserved, reserved, remaining } });

test('共通クレジットで相談・資料・計画・生成を数え、上限からの部分再開と月替わりでも入力と成果物を保持する', { timeout: 120000 }, async () => {
  let pw; try { pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); } catch { pw = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
  const { describeRegistry } = await import(pathToFileURL(path.join(process.env.KT_AI_REPO || path.resolve(root, '../AI'), 'worker/src/v2/prompt-registry.mjs')).href);
  const health = { ok: true, supportedContractVersions: ['2.1'], registry: describeRegistry(), entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }] };
  const prod = { appId: '310', appName: '共通クレジットの確認', fields: { memo: { type: 'MULTI_LINE_TEXT', code: 'memo', label: '備考' } }, layout: [], views: { views: {}, revision: '1' }, status: { enable: false, states: {}, actions: [] }, customize: { scope: 'ALL', desktop: { js: [], css: [] }, mobile: { js: [], css: [] } } };
  const T = loadToolkit(), mock = makeKintoneMock(prod), loadBase = devBaseLoaderOf({ KTDevBase: { load: T.KTDevBase.loadForRelease } }, { appId: '310', production: prod, mockRef: () => mock });
  let current = usage(), failNext = false, holdHealth = false, holdProposal = true;
  const proposalHeld = F.deferred(), healthHeld = F.deferred(), healthStarted = F.deferred(), calls = [], unexpected = [], errors = [];
  const requests = () => calls.filter(c => c.name !== 'getHealth');
  const browser = await pw.chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, serviceWorkers: 'block' });
    await context.route('**/*', route => { if (route.request().url() === 'https://credits.test.invalid/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ja"><meta charset="utf-8"><div id="app" style="height:100vh"></div></html>' }); unexpected.push(route.request().url()); return route.abort(); });
    const page = await context.newPage(); page.setDefaultTimeout(7000); page.on('pageerror', e => errors.push(e.message));
    await page.exposeFunction('base', loadBase); await page.exposeFunction('api', (name, args) => mock.api[name](...args));
    await page.exposeFunction('service', async (name, ctx) => {
      calls.push({ name, purpose: ctx?.requestPurpose, customizationId: ctx?.customization?.customizationId });
      if (name === 'getHealth') { const snapshot = JSON.parse(JSON.stringify(current)); if (holdHealth) { healthStarted.resolve(); await healthHeld.promise; } return { ...health, meta: { usage: snapshot } }; }
      if (name === 'propose' && holdProposal) await proposalHeld.promise;
      if (failNext) { failNext = false; current = usage(0, 2); return { failure: { code: 'MONTHLY_LIMIT_EXCEEDED', details: { error: { detail: { bucket: 'credits', reason: 'QUOTA_RESERVED', usage: current } } } } }; }
      assert.ok(current.credits.remaining > 0, 'ローカルで既知のゼロならGateway要求を送らない');
      current.credits.remaining--; current.credits.used++;
      const body = name === 'plan' ? F.plan({ settings: false }) : name === 'generate' ? F.generated(ctx.customization) : ctx.requestPurpose === 'document' ? E.response('資料の固定応答') : F.proposal();
      return { ...body, usage: current };
    });
    await page.goto('https://credits.test.invalid/');
    let source = fs.readFileSync(path.join(root, 'kintoneAppToolkit.user.js'), 'utf8').replace('waitReady().then(() => startToolkit());', '');
    const end = source.lastIndexOf('})();'); source = source.slice(0, end) + '\nglobalThis.CreditsTest={mountReleaseWorkspace,KTAiClient};\n' + source.slice(end);
    await page.addScriptTag({ content: source });
    await page.evaluate(({ prod, names }) => {
      const settings = CreditsTest.KTAiClient.createSettingsStore(); settings.setConsent(true, 'release-raw-source-1'); window.copies = []; window.progressEvents = [];
      const client = Object.fromEntries(['getHealth', 'propose', 'plan', 'generate'].map(name => [name, async input => {
        if (name === 'generate') for (const stage of ['repair', 'verify']) { progressEvents.push(stage); input.onEvent?.({ stage }); }
        const r = await window.service(name, input?.ctx); if (r.failure) throw new CreditsTest.KTAiClient.AiClientError(r.failure); return r;
      }]));
      window.work = CreditsTest.mountReleaseWorkspace(document.querySelector('#app'), { appId: '310', settings, session: { client, status: () => ({ connected: true, apiBase: 'https://gateway.test.invalid' }) }, loadDevBase: window.base, executor: { api: Object.fromEntries(names.map(name => [name, (...args) => window.api(name, args)])) }, getInputs: () => ({ data: prod }), copyText: async text => copies.push(text) }); work.onVisible();
    }, { prod, names: Object.keys(mock.api) });
    const action = name => page.locator('[data-release-action="' + name + '"]').first();
    const phase = value => page.waitForFunction(v => work.controller.getState().phase === v, value);
    const open = async () => { await action('connect').click(); return page.locator('dialog'); };
    await page.waitForFunction(() => work.capability().available);
    await page.locator('#kt-release-input').fill(F.REQUEST); await action('send').click();
    holdHealth = true; await page.evaluate(() => { window.pendingHealth = work.refreshCapability(true); }); await healthStarted.promise;
    holdProposal = false; proposalHeld.resolve(); await phase('proposal'); healthHeld.resolve(); await page.evaluate(() => pendingHealth); holdHealth = false;
    assert.equal(await page.evaluate(() => work.capability().usage.credits.remaining), 3, '遅いhealthの残り4で完了応答の3を巻き戻さない');
    assert.match(await page.locator('.ktr-compose-actions').innerText(), /送信ごとに1クレジット/);
    await action('adopt').click(); await phase('review');
    assert.deepEqual(requests().map(c => c.name), ['propose', 'plan', 'generate', 'generate']);
    assert.equal(await page.evaluate(() => work.capability().usage.credits.remaining), 0);
    assert.deepEqual(await page.evaluate(() => progressEvents), ['repair', 'verify', 'repair', 'verify']);
    assert.equal(await action('send').isDisabled(), true); assert.equal(await action('apply').isEnabled(), true);
    const artifacts = await page.evaluate(() => work.controller.getState().artifacts);
    let dialog = await open(); assert.match(await dialog.locator('[data-usage-plan]').innerText(), /スターター/);
    assert.match(await dialog.locator('[data-usage-credits]').innerText(), /残り 0 \/ 月 100.*利用済み 100・確保中 0/);
    assert.equal(await dialog.locator('[data-usage-bucket]').count(), 0);
    await dialog.getByText('クレジットの数え方', { exact: true }).click();
    assert.match(await dialog.innerText(), /計画1件＋コード生成2件なら合計3クレジット/);
    assert.match(await dialog.innerText(), /自動修復・確認では追加消費しません/); assert.doesNotMatch(await dialog.innerText(), /作成1回|相談1回|円|gpt-|token/i);
    const out = path.join(__dirname, '.build/release-credits'); fs.mkdirSync(out, { recursive: true }); await page.screenshot({ path: path.join(out, 'connection-credits.png') });
    await dialog.locator('[data-close]').click();
    await page.evaluate(() => work.controller.reprepare()); await phase('review'); assert.equal(requests().length, 4, '反映前の確認をやり直してもクレジット要求なし');
    await action('documents').click(); dialog = page.locator('dialog'); assert.equal(await dialog.locator('[data-document-create]').isDisabled(), true); assert.equal(await dialog.locator('[data-offline-export]').isEnabled(), true); await dialog.locator('[data-close]').click();
    current = usage(2); await page.evaluate(() => work.refreshCapability(true));
    await action('documents').click(); assert.match(await page.locator('[data-document-status]').innerText(), /1クレジット/); await page.locator('[data-document-create]').click();
    await page.waitForFunction(() => work.controller.getState().explanations.length === 1); assert.equal(await page.evaluate(() => work.capability().usage.credits.remaining), 1);
    await page.locator('#kt-release-input').fill('資料を短くしてください'); await action('send').click(); await page.waitForFunction(() => work.controller.getState().explanations.length === 2);
    assert.equal(await page.evaluate(() => work.capability().usage.credits.remaining), 0); assert.equal(requests().length, 6, '資料作成も修正も各1要求だけ');
    await action('copy-explanation').click(); assert.equal(await page.evaluate(() => copies.length), 1); assert.equal(requests().length, 6);
    assert.deepEqual(await page.evaluate(() => work.controller.getState().artifacts), artifacts);
    current = usage(2); await page.evaluate(() => work.refreshCapability(true)); failNext = true;
    await page.locator('#kt-release-input').fill('残す資料の修正文'); await action('send').click(); await page.waitForFunction(() => work.controller.getState().error?.code === 'MONTHLY_LIMIT_EXCEEDED');
    assert.equal(await page.locator('#kt-release-input').inputValue(), '残す資料の修正文');
    assert.equal(await action('send').isDisabled(), true); assert.match(await page.locator('.ktr-compose-actions').innerText(), /処理中の分を確保/);
    assert.equal(await page.evaluate(() => work.controller.getState().explanations.length), 2);
    assert.deepEqual(await page.evaluate(() => work.controller.getState().artifacts), artifacts);
    await action('focus-consultation').click(); assert.equal(await action('send').isDisabled(), true, '資料上限と同じ共通枠で相談も停止');
    current = usage(0); current.resetsAt = new Date(Date.now() + 500).toISOString(); await page.evaluate(() => work.refreshCapability(true));
    await action('documents').click(); assert.equal(await page.locator('[data-document-create]').isDisabled(), true);
    current = usage(5); await page.waitForFunction(() => work.capability().usage.credits.remaining === 5);
    assert.equal(await page.locator('[data-document-create]').isEnabled(), true, '月替わりで開いた資料ダイアログも更新'); await page.locator('dialog [data-close]').click();
    assert.equal(await action('send').isEnabled(), true); assert.equal(await page.locator('#kt-release-input').inputValue(), '残す資料の修正文');
    await page.locator('#kt-release-input').fill(''); await page.evaluate(() => work.controller.newTask());
    current = usage(3); await page.evaluate(() => work.refreshCapability(true)); const partialStart = requests().length;
    await page.locator('#kt-release-input').fill(F.REQUEST); await action('send').click(); await phase('proposal');
    await action('adopt').click(); await phase('incomplete');
    assert.deepEqual(requests().slice(partialStart).map(c => c.name), ['propose', 'plan', 'generate']);
    const completed = await page.evaluate(() => work.controller.getState().artifacts.find(a => a.result?.artifactOutcome?.state === 'ready'));
    assert.ok(completed); assert.equal(await action('resume').isDisabled(), true);
    assert.match(await page.locator('.ktr-workspace').innerText(), /クレジットの上限/);
    current = usage(1); await page.evaluate(() => work.refreshCapability(true)); await action('resume').click(); await phase('review');
    assert.deepEqual(requests().slice(partialStart).map(c => c.name), ['propose', 'plan', 'generate', 'generate']);
    assert.equal(requests().at(-1).customizationId, 'C2');
    assert.deepEqual(await page.evaluate(id => work.controller.getState().artifacts.find(a => a.customizationId === id), completed.customizationId), completed);
    assert.equal(await page.evaluate(() => work.capability().usage.credits.remaining), 0); assert.equal(await action('apply').isEnabled(), true);
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  } finally { await browser.close(); }
});
