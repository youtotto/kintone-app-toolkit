'use strict';
// Offline browser: every network request is intercepted; no live AI or kintone.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { makeEnvGetter, fileEntry } = require('./helpers/dev-base-fake.js');
const F = require('./helpers/release-workspace-fixture.js'), E = require('./helpers/release-explanation-fixture.js');
const root = path.resolve(__dirname, '..'), clone = F.clone;

test('独立Config Lensで無料の比較・設定保存、説明時だけAIへ渡し会話と手元編集を保つ', { timeout: 120000 }, async () => {
  let pw; try { pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
  catch { pw = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
  const { describeRegistry } = await import(require('./helpers/ai-repo.js').aiUrl('worker/src/v2/prompt-registry.mjs'));
  const health = { ok: true, supportedContractVersions: ['2.1'], registry: describeRegistry(), entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }] };
  const prod = { appId: '398', appName: '比較用', fields: { memo: { code: 'memo', label: '備考', type: 'SINGLE_LINE_TEXT' } }, layout: [], views: { views: {} }, settings: { name: '比較用', description: '' }, customize: { scope: 'ALL', desktop: { js: [fileEntry('old', 'test.js', 'OLD;')], css: [] }, mobile: { js: [], css: [] } } };
  prod.adminNotes = { content: '<p>運用の管理メモ</p>', includeInTemplateAndDuplicates: false };
  const prev = clone(prod);
  prev.adminNotes = { content: '<img src=x onerror=alert(1)>動作テストの管理メモ', includeInTemplateAndDuplicates: true };
  prev.fields.memo.required = true;
  prev.fields.added = { code: 'added', label: '<img src=x onerror=alert(1)>', type: 'SINGLE_LINE_TEXT' };
  prev.customize.desktop.js = [fileEntry('new', 'test.js', 'NEW;')];
  const T = loadToolkit(), calls = [], unexpected = [], errors = [];
  let revision = '2', failCore = false, holdNextRead = false, pauseNextRead = false, releaseRead, failNextAI = false, reads = 0;
  const getter = () => makeEnvGetter({ preview: prev, production: prod, files: { old: 'OLD;', new: 'NEW;' }, revisions: { preview: revision, production: '1' }, fail: { ...(failCore ? { 'preview:app/form/fields': new Error('fixture core denied') } : {}), 'production:field/acl': Object.assign(new Error('fixture denied'), { status: 403 }) } });
  const loadBase = async () => {
    reads++;
    const result = await T.KTDevBase.loadForRelease({ appId: '398', ...getter() });
    if (holdNextRead) { holdNextRead = false; await new Promise(resolve => { releaseRead = resolve; }); }
    if (pauseNextRead) { pauseNextRead = false; return { ok: false, paused: true, status: 'PAUSED', loadedAt: result.loadedAt, errors: [], partial: {} }; }
    return clone(result);
  };
  const browser = await pw.chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    await context.route('**/*', route => {
      if (route.request().url() === 'https://diff.test.invalid/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ja"><meta charset="utf-8"><body style="margin:0"><nav><button id="tab-ai">AI Assistant</button><button id="tab-lens">Config Lens</button></nav><div id="app" style="height:100vh"></div><div id="lens" hidden></div><div id="code-home"><textarea id="code">local secret draft</textarea></div></body></html>' });
      unexpected.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('base', loadBase);
    await page.exposeFunction('service', async (name, ctx) => {
      calls.push({ name, ctx });
      if (name === 'getHealth') return health;
      if (name === 'propose' && ctx.requestPurpose === 'document') {
        if (failNextAI) { failNextAI = false; throw new Error('固定の通信失敗'); }
        const result = E.response('未反映の変更の説明');
        result.explanation.sections.forEach(section => { section.evidenceIds = [ctx.facts[0].id]; });
        return result;
      }
      if (name === 'propose') return F.proposal();
      throw Error('Unexpected ' + name);
    });
    await page.goto('https://diff.test.invalid/');
    let source = fs.readFileSync(path.join(root, 'kintoneAppToolkit.user.js'), 'utf8').replace('waitReady().then(() => startToolkit());', '');
    const end = source.lastIndexOf('})();');
    source = source.slice(0, end) + '\nglobalThis.DiffTest={mountReleaseWorkspace,mountReleaseConfigLens,KTAiClient};\n' + source.slice(end);
    await page.addScriptTag({ content: source });
    await page.evaluate(prod => {
      window.connected = false; window.saved = []; window.saveFailure = false; window.canRead = true; window.lensVisible = false;
      window.edits = [{ name: 'test.js', kind: 'js', target: 'desktop', environment: 'preview', state: 'edited', text: 'local secret draft', fileKey: 'do-not-send' }];
      window.showAi = () => { lensVisible = false; document.querySelector('#lens').hidden = true; document.querySelector('#app').hidden = false; };
      window.showLens = () => { lensVisible = true; document.querySelector('#lens').hidden = false; document.querySelector('#app').hidden = true; return lens.onVisible(); };
      const client = Object.fromEntries(['getHealth', 'propose', 'plan', 'generate'].map(name => [name, async input => window.service(name, input?.ctx)]));
      window.work = DiffTest.mountReleaseWorkspace(document.querySelector('#app'), {
        appId: '398', settings: DiffTest.KTAiClient.createSettingsStore(), session: { client, status: () => ({ connected, apiBase: 'https://gateway.test.invalid' }) },
        loadDevBase: window.base, getInputs: () => ({ data: prod }), copyText: () => {}, downloadText: (name, text) => saved.push({ name, text }), openConfigLens: window.showLens
      });
      work.attachCodePanel({ element: document.querySelector('#code'), home: document.querySelector('#code-home'), getLocalEdits: () => edits });
      window.lens = DiffTest.mountReleaseConfigLens(document.querySelector('#lens'), {
        loadBase: window.base, domain: 'fixture.cybozu.com', localEdits: () => edits, canRead: () => canRead, isVisible: () => lensVisible,
        downloadText: (name, text, type) => { if (saveFailure) throw new Error('固定の保存失敗'); saved.push({ name, text, type }); },
        explain: (result, edits) => { showAi(); return work.explainEnvironmentComparison(result, edits); }
      });
      document.querySelector('#tab-ai').onclick = showAi;
      document.querySelector('#tab-lens').onclick = showLens;
    }, prod);
    const pane = () => page.locator('#lens');
    const action = name => page.locator('[data-release-action="' + name + '"]').first();
    const lensAction = name => pane().locator('[data-cl-action="' + name + '"]');
    const waitResult = () => page.waitForFunction(() => !document.querySelector('#lens [data-cl-action="refresh"]')?.disabled && !!document.querySelector('#lens [data-cl-category="fields"]'));
    const open = async () => { await page.locator('#tab-lens').click(); await waitResult(); };
    const refresh = async () => { await lensAction('refresh').click(); await waitResult(); };
    const paid = () => calls.filter(call => call.name !== 'getHealth').length;
    const acceptedState = () => page.evaluate(() => { const s = work.controller.getState(); return { proposal: s.proposal, version: s.version, answers: s.answers, plan: s.plan, prepared: s.prepared, runs: s.runs, consultationTarget: s.consultationTarget }; });

    assert.equal(reads, 0, '独立タブを開くまでは比較用に取得しない');
    await open();
    assert.equal(await pane().isVisible(), true, '独立したConfig Lensタブから比較を開く');
    assert.equal(await page.locator('dialog').count(), 0, '比較をAI内のダイアログへ重ねない');
    assert.equal(calls.length, 0, '未接続で無料一覧を開いてもAIもhealthも呼ばない');
    assert.match(await pane().innerText(), /確認できた変更/);
    assert.equal(await pane().locator('img').count(), 0, '設定値はHTMLとして実行しない');
    await pane().locator('.ktcl-notes > summary').first().click();
    assert.match(await pane().innerText(), /手元で編集中・未登録/);
    await pane().locator('[data-cl-category="aclField"]').click();
    assert.equal(await pane().locator('[data-cl-category="aclField"]').evaluate(button => {
      const row = button.getBoundingClientRect(), navigation = button.closest('nav').getBoundingClientRect();
      return row.top >= navigation.top - 1 && row.bottom <= navigation.bottom + 1;
    }), true, 'スクロールしたカテゴリを選んでも選択位置が見える');
    assert.match(await pane().locator('[data-cl-result-category="aclField"]').innerText(), /比較できていません|未確認/);
    await pane().locator('[data-cl-category="notes"]').click();
    for (const summary of await pane().locator('.ktcl-entry > summary').all()) await summary.click();
    assert.match(await pane().locator('[data-cl-result-category="notes"]').innerText(), /運用の管理メモ/);
    assert.match(await pane().locator('[data-cl-result-category="notes"]').innerText(), /動作テストの管理メモ/);
    assert.equal(await pane().locator('img').count(), 0, '管理者用メモのHTMLは文字として表示する');
    await pane().locator('[data-cl-category="fields"]').click();
    await pane().locator('[data-cl-kind="added"]').click();
    assert.equal(await pane().locator('.ktcl-entry').count(), 1, 'カテゴリと変更種別で絞れる');
    await pane().locator('.ktcl-entry > summary').click();
    assert.match(await pane().locator('.ktcl-entry').innerText(), /運用環境/);
    assert.match(await pane().locator('.ktcl-entry').innerText(), /動作テスト環境/);
    const out = path.join(__dirname, '.build/release-environment-diff'); fs.mkdirSync(out, { recursive: true });
    await page.screenshot({ path: path.join(out, 'comparison-wide.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await pane().evaluate(element => element.scrollWidth <= element.clientWidth + 2), true, '狭い画面でもタブ全体をはみ出さない');
    await page.screenshot({ path: path.join(out, 'comparison-narrow.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });

    const beforeSave = reads;
    await lensAction('save-production').click();
    await page.waitForFunction(() => saved.length === 1);
    await lensAction('save-preview').click();
    await page.waitForFunction(() => saved.length === 2);
    const saved = await page.evaluate(() => window.saved.map(item => ({ ...item, doc: JSON.parse(item.text) })));
    assert.equal(saved[0].doc.source.environment, 'production');
    assert.equal(saved[1].doc.source.environment, 'preview');
    assert.equal(saved[0].doc.source.revision, '1'); assert.equal(saved[1].doc.source.revision, '2');
    assert.equal(saved[0].doc.source.domain, 'fixture.cybozu.com'); assert.equal(saved[0].doc.source.appId, '398');
    assert.equal(saved[0].doc.settings.fields.properties.added, undefined);
    assert.equal(saved[1].doc.settings.fields.properties.added.code, 'added');
    assert.equal(saved[0].doc.settings.fields.properties.memo.required, undefined);
    assert.equal(saved[1].doc.settings.fields.properties.memo.required, true);
    assert.equal(saved[0].doc.settings.adminNotes.content, prod.adminNotes.content);
    assert.equal(saved[1].doc.settings.adminNotes.content, prev.adminNotes.content);
    assert.ok(saved.every(item => item.doc.coverage.some(row => row.id === 'notes' && row.status === 'included')));
    assert.ok(saved.every(item => item.type === 'application/json' && item.doc.settings.customize), '絞り込みと無関係に選んだ環境の取得済み設定全体を保存する');
    assert.ok(saved[0].doc.coverage.some(item => item.id === 'aclField' && item.status === 'unavailable'));
    assert.doesNotMatch(JSON.stringify(saved), /local secret draft|do-not-send|OLD;|NEW;/);
    assert.equal(reads, beforeSave, '取得済み設定の保存は再取得しない');
    assert.equal(calls.length, 0, '設定保存でもAIもhealthも呼ばない');
    await page.evaluate(() => { saveFailure = true; });
    await lensAction('save-preview').click();
    await page.waitForFunction(() => document.querySelector('#lens [data-cl-error]')?.textContent.includes('固定の保存失敗'));
    assert.equal(await page.evaluate(() => saved.length), 2);
    assert.equal(await pane().locator('[data-cl-export-status]').count(), 0, '保存失敗で成功表示を残さない');
    await page.evaluate(() => { saveFailure = false; });

    // The free tab remains usable while disconnected. Only an explicit
    // explanation request opens the existing connection/consent path.
    await lensAction('explain').click();
    await page.waitForFunction(() => !!document.querySelector('dialog'));
    assert.equal(paid(), 0);
    await page.locator('dialog [data-close]').last().click();
    await page.evaluate(() => { connected = true; return work.refreshCapability(true); });
    await open(); await lensAction('explain').click();
    await page.locator('dialog:has([data-consent]) [data-close]').click();
    await page.waitForFunction(() => !document.querySelector('#lens [data-cl-action="explain"]').disabled);
    assert.equal(paid(), 0, '送信同意を取り消すとAIは呼ばない');

    await page.locator('#tab-ai').click();
    await page.locator('#kt-release-input').fill(F.REQUEST);
    await action('send').click(); await page.locator('[data-consent]').click();
    await page.waitForFunction(() => work.controller.getState().phase === 'proposal');
    await page.evaluate(() => work.controller.setConsultationTarget({ type: 'FILE', name: 'test.js', target: 'desktop', environment: 'preview' }));
    const before = await acceptedState();
    await page.locator('#kt-release-input').fill('残しておく下書き');
    await open(); const initial = paid();
    await lensAction('explain').evaluate(button => { button.click(); button.click(); });
    await page.waitForFunction(() => work.controller.getState().explanations.length === 1);
    assert.equal(paid(), initial + 1, '説明ボタンの二重押下は1回だけ送信する');
    const sent = calls.at(-1).ctx;
    assert.deepEqual(sent.focus.target, { type: 'environment-diff', id: 'production->preview' });
    assert.equal(sent.requestPurpose, 'document');
    assert.ok(sent.facts.some(fact => fact.kind === 'env-diff-coverage'));
    assert.ok(sent.facts.some(fact => fact.value?.before?.text === 'OLD;' && fact.value?.after?.text === 'NEW;'));
    assert.ok(sent.facts.some(fact => fact.kind === 'local-unregistered-edit'));
    assert.doesNotMatch(JSON.stringify(sent), /local secret draft|do-not-send|残しておく下書き/);
    assert.ok(sent.facts.every(fact => /^E\d+$/.test(fact.id) && fact.statement && fact.confidence));
    assert.deepEqual(await acceptedState(), before, '説明のための送信で採用対象を変更しない');
    assert.equal(await page.locator('#kt-release-input').inputValue(), '残しておく下書き');
    assert.equal(await page.locator('#code').inputValue(), 'local secret draft');
    await action('code').click(); await action('code').click();
    assert.equal(await page.locator('#code').inputValue(), 'local secret draft');

    await open(); const unchangedCalls = paid(); revision = '3';
    await lensAction('explain').click();
    await page.waitForFunction(() => work.controller.getState().error?.code === 'ENVIRONMENT_COMPARISON_CHANGED');
    assert.equal(paid(), unchangedCalls, '一覧の後に設定が変わればAI送信前に止める');
    await open(); await refresh(); failNextAI = true;
    await lensAction('explain').click();
    await page.waitForFunction(() => work.controller.getState().error?.message.includes('固定の通信失敗'));
    assert.equal(await page.locator('#kt-release-input').inputValue(), '残しておく下書き');

    // A delayed read must not revive the snapshot invalidated by a settings
    // change, even when the pane was left while that read was running.
    await open(); holdNextRead = true; releaseRead = null;
    await lensAction('refresh').click();
    while (!releaseRead) await new Promise(resolve => setTimeout(resolve, 10));
    await page.evaluate(() => { showAi(); lens.markStale(); });
    revision = '4'; releaseRead();
    await page.waitForFunction(() => !document.querySelector('#lens [data-cl-action="refresh"]').disabled);
    assert.equal(await pane().locator('[data-cl-category="fields"]').count(), 0, '古い取得結果を無効化の後に再表示しない');
    await open(); assert.match((await pane().locator('.ktcl-provenance').allTextContents()).join(' '), /設定の版：左 1 ／ 右 4/);

    pauseNextRead = true; await lensAction('refresh').click();
    await page.waitForFunction(() => !document.querySelector('#lens [data-cl-action="refresh"]').disabled);
    assert.equal(await pane().locator('[data-cl-category="fields"]').count(), 0, '中断した取得を完了済みの一覧として残さない');
    await page.locator('#tab-ai').click(); await open();
    assert.match((await pane().locator('.ktcl-provenance').allTextContents()).join(' '), /設定の版：左 1 ／ 右 4/, '再表示で中断した取得をやり直す');

    failCore = true; await refresh();
    assert.equal(await lensAction('explain').isDisabled(), true, '説明に必要な動作テスト環境の取得が失敗したら押せない');
    assert.match(await pane().innerText(), /未確認|比較できていません/);
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
    await page.evaluate(() => { lens.dispose(); work.dispose(); }); await context.close();
  } finally { await browser.close(); }
});
