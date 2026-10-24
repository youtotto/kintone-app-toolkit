'use strict';
// Isolated browser, fixed services and a fake preview app. Every network request is intercepted.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { devBaseLoaderOf } = require('./helpers/dev-base-fake.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const F = require('./helpers/release-workspace-fixture.js');
const root = path.resolve(__dirname, '..');
function browserBundle() {
  const source = fs.readFileSync(path.join(root, 'kintoneAppToolkit.user.js'), 'utf8').replace('waitReady().then(() => startToolkit());', '');
  const end = source.lastIndexOf('})();');
  return source.slice(0, end) + '\nglobalThis.BudgetTest={mountReleaseWorkspace,KTAiClient,KTAiBudget};\n' + source.slice(end);
}
const preview = () => ({
  appId: '310', appName: '検証用アプリ', fields: { memo: { type: 'MULTI_LINE_TEXT', code: 'memo', label: '備考' } },
  layout: [], views: { views: {}, revision: '1' }, status: { enable: false, states: {}, actions: [] },
  customize: { scope: 'ALL', desktop: { js: [], css: [] }, mobile: { js: [], css: [] } }
});
test('検証用上限は接続の詳細だけで設定し、会話中は切り替えず、同じ利用記録を読み直す', { timeout: 90000 }, async () => {
  let pw;
  try { pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
  catch (_) { pw = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
  const { describeRegistry } = await import(pathToFileURL(path.join(process.env.KT_AI_REPO || path.resolve(root, '../AI'), 'worker/src/v2/prompt-registry.mjs')).href);
  const health = { ok: true, supportedContractVersions: ['2.1'], registry: describeRegistry(), entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }] };
  const T = loadToolkit(), prod = preview(), mock = makeKintoneMock(prod);
  const loadBase = devBaseLoaderOf({ KTDevBase: { load: T.KTDevBase.loadForRelease } }, { appId: '310', production: prod, mockRef: () => mock });
  const calls = [], unexpected = [], errors = [], held = F.deferred();
  const browser = await pw.chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    await context.route('**/*', route => {
      if (route.request().url() === 'https://budget.test.invalid/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ja" style="height:100%"><meta charset="utf-8"><body style="margin:0;height:100%"><div id="app" style="height:100%;display:flex;flex-direction:column;min-height:0"></div></body></html>' });
      unexpected.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.exposeFunction('testBase', loadBase);
    await page.exposeFunction('testApi', (name, args) => mock.api[name](...args));
    await page.exposeFunction('testService', async name => {
      calls.push(name);
      if (name === 'getHealth') return health;
      if (name === 'propose') return held.promise;
      if (name === 'plan') return { ...F.plan({ settings: false, platforms: [] }), ai: { model: 'gpt-6.1-sol', usage: { input_tokens: 500, output_tokens: 100 } } };
      throw new Error('This fixture must not generate code or authenticate.');
    });
    await page.goto('https://budget.test.invalid/');
    await page.addScriptTag({ content: browserBundle() });
    await page.evaluate(async ({ names, prod }) => {
      const config = { id: 'previous-test-only', limitUsd: 1.6, maxCalls: 14, createdAt: '2026-10-24T00:00:00.000Z' };
      localStorage.setItem('ktAi.budget.v1.budget.test.invalid', JSON.stringify(config));
      window.testBudget = BudgetTest.KTAiBudget.create({ storage: localStorage, session: sessionStorage, host: 'budget.test.invalid', locks: null, sessionId: 'browser-test-only' });
      // The old ledger is seeded through real accounting with local, fixed responses only.
      const settled = testBudget.wrap({ ask: async () => ({ ai: { model: 'gpt-6.1-sol', usage: { input_tokens: 500, output_tokens: 100 } } }) });
      await settled.ask({ ctx: { question: '旧枠の固定応答' }, requestId: 'old-done' });
      const interrupted = testBudget.wrap({ ask: async () => { throw new BudgetTest.KTAiClient.AiClientError({ code: BudgetTest.KTAiClient.ERROR_CODES.TIMEOUT, message: '固定の切断' }); } });
      try { await interrupted.ask({ ctx: { question: '旧枠の固定切断' }, requestId: 'old-unknown' }); } catch (_) {}
      window.oldLedgerKey = testBudget.ledgerKey(); window.oldLedger = localStorage.getItem(oldLedgerKey);
      const settings = BudgetTest.KTAiClient.createSettingsStore(); settings.setConsent(true, 'release-raw-source-1');
      const client = Object.fromEntries(['getHealth', 'propose', 'plan', 'generate'].map(name => [name, () => window.testService(name)]));
      window.work = BudgetTest.mountReleaseWorkspace(document.querySelector('#app'), {
        appId: '310', settings, budget: testBudget,
        session: { client, status: () => ({ connected: true, apiBase: 'https://gateway.test.invalid' }) },
        loadDevBase: window.testBase, executor: { api: Object.fromEntries(names.map(name => [name, (...args) => window.testApi(name, args)])) },
        getInputs: () => ({ data: prod, deps: {}, scan: { files: [] } }), canAutoFetch: () => true
      });
      window.work.onVisible();
    }, { names: Object.keys(mock.api), prod });
    const action = name => page.locator('[data-release-action="' + name + '"]').first();
    const field = name => page.locator('dialog [data-budget-' + name + ']');
    const close = () => page.locator('dialog [data-close]').click();
    const phase = value => page.waitForFunction(v => work.controller.getState().phase === v, value);
    const summary = () => page.evaluate(() => testBudget.summary());
    const open = async () => {
      await action('connect').click();
    };
    const expand = () => page.locator('dialog [data-budget-panel] > summary').click();
    const sameStatus = async () => assert.equal(await field('status').innerText(), await page.evaluate(() => BudgetTest.KTAiBudget.summaryText(testBudget.summary())));
    await page.waitForFunction(() => work.capability().available);
    const old = await summary();
    assert.equal(old.enabled, true); assert.equal(old.unknown, 1); assert.equal(old.usedCalls, 2);
    assert.ok(old.recordedUsd > 0 && old.reservedUsd > 0);
    await page.locator('#kt-release-input').fill('まだ送信しない下書き');
    await open();
    assert.equal(await page.locator('dialog [data-budget-panel]').evaluate(e => e.open), false);
    assert.doesNotMatch(await page.locator('body').innerText(), /米ドル|記録済み|確保中/);
    await expand(); await sameStatus();
    assert.match(await field('status').innerText(), /終了不明 1 件/);
    assert.equal(Number(await field('usd').inputValue()), 1); assert.equal(await field('calls').inputValue(), '8');
    await field('usd').fill('-1'); await field('start').click();
    assert.equal((await summary()).id, old.id, 'invalid values do not replace an existing budget');
    await field('usd').fill('1'); await field('calls').fill('8'); await field('start').click();
    await page.waitForFunction(id => testBudget.summary().id !== id, old.id);
    const configured = await summary();
    assert.equal(configured.limitUsd, 1); assert.equal(configured.maxCalls, 8);
    assert.equal(configured.usedCalls, 0); assert.equal(configured.recordedUsd, 0); assert.equal(configured.reservedUsd, 0);
    assert.equal(await page.evaluate(() => localStorage.getItem(oldLedgerKey)), await page.evaluate(() => oldLedger));
    assert.ok((await field('id').innerText()).includes(configured.id)); await sameStatus();
    await close();
    assert.equal(await page.locator('#kt-release-input').inputValue(), 'まだ送信しない下書き');
    assert.equal(await page.evaluate(() => work.controller.getState().phase), 'idle');
    assert.doesNotMatch(await page.locator('.ktr-workspace').innerText(), /米ドル|記録済み|確保中/);
    assert.deepEqual(calls, ['getHealth'], 'opening and configuring use no authentication or proposal service');

    await action('send').click(); await phase('consulting');
    await open(); await expand();
    assert.equal(await field('start').isDisabled(), true);
    const whileRunning = await summary();
    assert.equal(whileRunning.id, configured.id); assert.equal(whileRunning.inFlight, 1);
    await field('start').dispatchEvent('click');
    assert.equal((await summary()).id, configured.id, 'the click handler also guards a disabled control');
    held.resolve({ ...F.proposal('既存の内容を変更せず確認します。'), ai: { model: 'gpt-6.1-sol', usage: { input_tokens: 400, output_tokens: 100 } } });
    await phase('proposal'); await page.waitForFunction(() => testBudget.summary().inFlight === 0);
    assert.equal(await field('start').isDisabled(), true, 'a completed response still belongs to an active conversation');
    await sameStatus(); await field('start').dispatchEvent('click');
    assert.equal((await summary()).id, configured.id);
    await close();
    assert.equal(await page.evaluate(() => work.controller.getState().phase), 'proposal');
    await action('adopt').click(); await phase('unchanged'); await open(); await expand();
    const finished = await summary();
    assert.equal(finished.id, configured.id); assert.equal(finished.usedCalls, 2);
    assert.equal(finished.done, 2); assert.equal(finished.unknown, 0); assert.equal(finished.reservedUsd, 0);
    assert.ok(finished.recordedUsd > 0);
    assert.equal(await field('start').isDisabled(), true, 'leave the finished task explicitly before creating a new budget');
    await sameStatus(); await close(); await action('new-task').click(); await phase('idle'); await open(); await expand();
    assert.equal(await field('start').isEnabled(), true);
    assert.deepEqual(await summary(), finished, 'leaving a conversation never resets accounting'); await sameStatus();
    assert.equal(await page.evaluate(() => localStorage.getItem(oldLedgerKey)), await page.evaluate(() => oldLedger));
    const out = path.join(root, 'tests/.build/release-budget'); fs.mkdirSync(out, { recursive: true });
    await page.screenshot({ path: path.join(out, 'developer-limit.png'), fullPage: true }); await close();
    assert.doesNotMatch(await page.locator('.ktr-workspace').innerText(), /米ドル|記録済み|確保中/);
    assert.deepEqual(calls, ['getHealth', 'propose', 'plan']);
    assert.equal(mock.calls.filter(c => !c.startsWith('GET')).length, 0);
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
    await page.evaluate(() => work.dispose());
  } finally { await browser.close(); }
});
