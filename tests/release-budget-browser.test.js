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
  return source.slice(0, end) + '\nglobalThis.BudgetTest={mountReleaseWorkspace,KTAiClient};\n' + source.slice(end);
}
const preview = () => ({
  appId: '310', appName: '検証用アプリ', fields: { memo: { type: 'MULTI_LINE_TEXT', code: 'memo', label: '備考' } },
  layout: [], views: { views: {}, revision: '1' }, status: { enable: false, states: {}, actions: [] },
  customize: { scope: 'ALL', desktop: { js: [], css: [] }, mobile: { js: [], css: [] } }
});
for (const budgetState of ['broken', 'exhausted']) test('旧検証上限を無視して相談・保存を維持: '+budgetState, { timeout: 90000 }, async () => {
  let pw;
  try { pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
  catch (_) { pw = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
  const { describeRegistry } = await import(require('./helpers/ai-repo.js').aiUrl('worker/src/v2/prompt-registry.mjs'));
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
      if (name === 'plan') return { ...F.plan({ settings: false, platforms: [] }), ai: { model: 'gpt-6.1-sol', usage: { input_tokens: 500, output_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } } };
      throw new Error('This fixture must not generate code or authenticate.');
    });
    await page.goto('https://budget.test.invalid/');
    await page.addScriptTag({ content: browserBundle() });
    await page.evaluate(async ({ names, prod, budgetState }) => {
      window.budgetReportDownloads = [];
      localStorage.setItem('ktAi.devMode', '1');
      const config = { id: 'previous-test-only', limitUsd: 1.6, maxCalls: 14, createdAt: '2026-10-24T00:00:00.000Z' };
      localStorage.setItem('ktAi.budget.v1.budget.test.invalid', JSON.stringify(config));
      window.oldLedgerKey='ktAi.budgetLedger.v1.budget.test.invalid.previous-test-only';
      localStorage.setItem(oldLedgerKey,'{"entries":[{"status":"unknown","reservedUsd":999999}]}');
      window.oldLedger=localStorage.getItem(oldLedgerKey);
      window.oldConfig=budgetState==='broken'?'broken-old-config':JSON.stringify({...config,limitUsd:0,maxCalls:0});localStorage.setItem('ktAi.budget.v1.budget.test.invalid',oldConfig);
      const settings = BudgetTest.KTAiClient.createSettingsStore(); settings.setConsent(true, 'release-raw-source-1');
      const client = Object.fromEntries(['getHealth', 'propose', 'plan', 'generate'].map(name => [name, () => window.testService(name)]));
      window.work = BudgetTest.mountReleaseWorkspace(document.querySelector('#app'), {
        appId: '310', settings,
        session: { client, status: () => ({ connected: true, apiBase: 'https://gateway.test.invalid' }) },
        loadDevBase: window.testBase, executor: { api: Object.fromEntries(names.map(name => [name, (...args) => window.testApi(name, args)])) },
        getInputs: () => ({ data: prod, deps: {}, scan: { files: [] } }), canAutoFetch: () => true,
        downloadText: (name, text, type) => window.budgetReportDownloads.push({ name, text, type })
      });
      window.work.onVisible();
    }, { names: Object.keys(mock.api), prod, budgetState });
    const action = name => page.locator('[data-release-action="' + name + '"]').first();

    await page.waitForFunction(() => work.capability().available);
    await page.locator('#kt-release-input').fill('保存済みの検証上限を使わず確認します');
    await action('connect').click();
    assert.equal(await page.locator('[data-budget-panel], [data-staging-select], [data-production-select]').count(),0);
    assert.doesNotMatch(await page.locator('dialog').innerText(),/米ドル|検証用|開発者|staging|workers\.dev/);
    await page.locator('dialog [data-close]').click();
    assert.equal(await page.locator('#kt-release-input').inputValue(),'保存済みの検証上限を使わず確認します');
    await action('send').click();
    await page.waitForFunction(()=>work.controller.getState().phase==='consulting');
    held.resolve(F.proposal('通常の相談結果です。'));
    await page.waitForFunction(()=>work.controller.getState().phase==='proposal');
    assert.equal(calls.filter(x=>x==='propose').length,1);
    const state=await page.evaluate(()=>({config:localStorage.getItem('ktAi.budget.v1.budget.test.invalid'),ledger:localStorage.getItem(oldLedgerKey),oldLedger,oldConfig,messages:work.controller.getState().messages.length}));
    assert.equal(state.config,state.oldConfig);assert.equal(state.ledger,state.oldLedger);assert.ok(state.messages>=2);
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert.equal(mock.st.revision,1);
    if(process.env.KT_PROOF_DIR){fs.mkdirSync(process.env.KT_PROOF_DIR,{recursive:true});await action('connect').click();await page.screenshot({path:path.join(process.env.KT_PROOF_DIR,'public-connection.png')});}
  } finally { await browser.close(); }
});
