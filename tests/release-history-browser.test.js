'use strict';
// Actual IndexedDB and UI, isolated origin. Every network request is intercepted; no live AI or kintone.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { devBaseLoaderOf } = require('./helpers/dev-base-fake.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const F = require('./helpers/release-workspace-fixture.js'), E = require('./helpers/release-explanation-fixture.js');
const root = path.resolve(__dirname, '..'), origin = 'https://release-history.test.invalid';
function bundle() {
  const source = fs.readFileSync(path.join(root, 'kintoneAppToolkit.user.js'), 'utf8').replace('waitReady().then(() => startToolkit());', '');
  const end = source.lastIndexOf('})();');
  return source.slice(0, end) + '\nglobalThis.HistoryTest={mountReleaseWorkspace,KTAiClient,KTReleaseHistory};\n' + source.slice(end);
}
const production = () => ({ appId: '310', appName: '案件管理', fields: {
  memo: { type: 'MULTI_LINE_TEXT', code: 'memo', label: '備考', required: false },
  ステータス: { type: 'STATUS', code: 'ステータス', label: 'ステータス', enabled: true }
}, layout: [], views: { views: {}, revision: '1' }, status: { enable: true, states: {
  作成中: { name: '作成中', index: '0', assignee: { type: 'ONE', entities: [] } },
  承認待ち: { name: '承認待ち', index: '1', assignee: { type: 'ONE', entities: [] } },
  承認済み: { name: '承認済み', index: '2', assignee: { type: 'ONE', entities: [] } }
}, actions: [] }, customize: { scope: 'ALL', desktop: { js: [], css: [] }, mobile: { js: [], css: [] } } });

test('会話を自動保存・自動復元し、下書き・採用・成果物・選択中の会話を維持する（実IndexedDB・外部通信なし）', { timeout: 150000 }, async () => {
  let pw; try { pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
  catch (_) { pw = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
  const { describeRegistry } = await import(require('./helpers/ai-repo.js').aiUrl('worker/src/v2/prompt-registry.mjs'));
  const health = { ok: true, supportedContractVersions: ['2.1'], registry: describeRegistry(), entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }] };
  const T = loadToolkit(), prod = production(), mock = makeKintoneMock(prod);
  const loadBase = devBaseLoaderOf({ KTDevBase: { load: T.KTDevBase.loadForRelease } }, { appId: '310', production: prod, mockRef: () => mock });
  let heldBase = null, heldBaseStarted = null, heldBaseReason = null;
  const calls = [], errors = [], unexpected = [], dbName = 'toolkit-history-browser-' + Date.now();
  const browser = await pw.chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 920 } });
    await context.route('**/*', route => {
      if (route.request().url() === origin + '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ja" style="height:100%"><meta charset="utf-8"><title>Toolkit 履歴確認</title><body style="margin:0;height:100%"><div id="app" style="height:100%;display:flex;flex-direction:column"></div></body></html>' });
      unexpected.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    const out = path.join(root, 'tests/.build/release-history-browser'); fs.mkdirSync(out, { recursive: true });
    await page.exposeFunction('historyBase', async (...args) => {
      if (heldBase && (!heldBaseReason || args[0]?.reason === heldBaseReason)) { heldBaseStarted?.resolve(args[0]?.reason); await heldBase.promise; }
      return loadBase(...args);
    });
    await page.exposeFunction('historyApi', async (name, args) => mock.api[name](...args));
    await page.exposeFunction('historyService', async (name, ctx) => {
      calls.push({ name, ctx });
      if (name === 'getHealth') return health;
      if (name === 'propose') {
        if (String(ctx?.text || ctx?.question || ctx?.request || '').includes('引継ぎ') || calls.filter(call => call.name === 'propose').length === 2) {
          const reply = E.response('保存する引継ぎ資料');
          const memo = ctx.facts?.find(fact => fact.field?.code === 'memo');
          reply.explanation.sections.forEach(section => { section.evidenceIds = memo ? [memo.id] : []; });
          return reply;
        }
        return F.proposal();
      }
      if (name === 'plan') return F.plan();
      return F.generated(ctx.customization);
    });
    const mount = async (options = {}) => {
      await page.addScriptTag({ content: bundle() });
      await page.evaluate(({ prod, names, dbName, options }) => {
        window.downloads = []; window.holdHistoryLoad = !!options.holdHistoryLoad;
        // Gate delivery after a real IndexedDB load; do not change production dependencies.
        const createHistory = HistoryTest.KTReleaseHistory.create;
        HistoryTest.KTReleaseHistory.create = args => {
          const store = createHistory(args), load = store.load;
          store.load = async (...args) => {
            const result = await load(...args);
            if (window.holdHistoryLoad) { window.historyLoadStarted = true; await new Promise(resolve => { window.releaseHistoryLoad = resolve; }); }
            return result;
          };
          return store;
        };
        const client = Object.fromEntries(['getHealth', 'propose', 'plan', 'generate'].map(name => [name, input => window.historyService(name, input?.ctx)]));
        window.historyScope = { domain: location.origin, appId: '310', userId: options.userId || 'u1', environment: 'preview' };
        window.work = HistoryTest.mountReleaseWorkspace(document.querySelector('#app'), {
          appId: '310', settings: HistoryTest.KTAiClient.createSettingsStore(),
          session: { client, status: () => ({ connected: true, apiBase: 'https://gateway.test.invalid' }) },
          loadDevBase: window.historyBase, executor: { api: Object.fromEntries(names.map(name => [name, (...args) => window.historyApi(name, args)])) },
          getInputs: () => ({ data: prod, deps: {}, scan: { files: [] } }), copyText: async text => { window.copied = text; },
          downloadText: (name, text, type) => window.downloads.push({ name, text, type }),
          historyScope: window.historyScope, historyOptions: { dbName: options.dbName || dbName, ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}) },
          historySessionOptions: { debounceMs: 20 }
        });
        const home = document.createElement('div'), element = document.createElement('div'); home.hidden = true; document.body.appendChild(home); home.appendChild(element);
        const editorListeners = new Set(); window.editorDrafts = { version: 1, files: [], active: null };
        window.editDraft = value => { window.editorDrafts = value; for (const listener of editorListeners) listener(); };
        work.attachCodePanel({ home, element, exportDrafts: () => structuredClone(window.editorDrafts), restoreDrafts: value => { window.editorDrafts = structuredClone(value || { version: 1, files: [], active: null }); return true; }, canRestoreDrafts: () => true,
          subscribeDrafts: listener => { editorListeners.add(listener); return () => editorListeners.delete(listener); } });
        work.onVisible();
      }, { prod, names: Object.keys(mock.api), dbName, options });
      await page.waitForFunction(() => work.capability().available === true && !!work.history());
      if (options.waitReady !== false) {
        await page.evaluate(() => work.history().ready());
        assert.equal(await page.evaluate(() => work.history().isInitializing()), false);
      }
    };
    const action = name => page.locator('[data-release-action="' + name + '"]:visible').first();
    const phase = value => page.waitForFunction(value => work.controller.getState().phase === value, value);
    const saved = async () => page.waitForFunction(() => work.history().getStatus().state === 'saved' && !work.history().isDirty() && !!work.history().getCurrent());
    const paid = () => calls.filter(call => call.name !== 'getHealth').length;
    const send = async text => { await page.locator('#kt-release-input').fill(text); await action('send').click(); };
    const historyList = async () => {
      await action('saved-history').click(); await page.locator('dialog [data-history-list]').waitFor({ state: 'attached' });
      await page.waitForFunction(() => !document.querySelector('dialog [data-history-note]')?.textContent.includes('読み込んでいます'));
      assert.equal(await page.locator('[data-history-save]').count(), 0, 'saving is automatic; the list has no manual-save action');
    };
    const autoReload = async (id, options) => {
      await saved();
      const paidBefore = paid(), writesBefore = mock.calls.filter(call => !call.startsWith('GET')).length;
      await page.reload(); await mount(options);
      assert.equal(await page.evaluate(() => work.history().getCurrent()?.id || null), id, 'reload restores the selected conversation without opening history');
      assert.equal(await page.locator('dialog[open]').count(), 0, 'automatic restore needs no history dialog');
      assert.equal(paid(), paidBefore, 'automatic restore never calls paid AI');
      assert.equal(mock.calls.filter(call => !call.startsWith('GET')).length, writesBefore, 'automatic restore never writes to kintone');
      await saved();
    };
    const manualOpen = async (id, checkPendingClose = false) => {
      await historyList();
      if (checkPendingClose) { heldBase = F.deferred(); heldBaseStarted = F.deferred(); }
      await page.locator('[data-history-open="' + id + '"]').click();
      if (checkPendingClose) {
        await heldBaseStarted.promise;
        assert.equal(await page.locator('dialog [data-close]').isDisabled(), true, 'the loading conversation cannot be dismissed mid-restore');
        assert.equal(await page.locator('[data-history-export]').isDisabled(), true, 'manual restoration also disables export');
        await page.keyboard.press('Escape'); assert.equal(await page.locator('dialog[open]').count(), 1);
        heldBase.resolve(); heldBase = null; heldBaseStarted = null;
      }
      await page.waitForFunction(() => !document.querySelector('dialog[open]')); await saved();
    };
    await page.goto(origin + '/'); await mount();
    assert.equal(await action('saved-history').innerText(), '保存した会話');
    assert.equal(await page.locator('[data-history-save]').count(), 0);
    assert.equal(await page.locator('[data-history-retry]').isVisible(), false);
    await send(F.REQUEST); await page.locator('[data-consent]').click(); await phase('proposal');
    await saved();
    const composing = await page.evaluate(() => {
      const input = document.querySelector('#kt-release-input'); window.composingDraftNode = input;
      input.focus(); input.value = 'まだ送らない修正の下書き'; input.setSelectionRange(2, 6);
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '修正' }));
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '修正', isComposing: true }));
      return { sameNode: document.querySelector('#kt-release-input') === input, focused: document.activeElement === input,
        selection: [input.selectionStart, input.selectionEnd], status: document.querySelector('[data-release-history-state]').dataset.releaseHistoryState };
    });
    assert.deepEqual(composing, { sameNode: true, focused: true, selection: [2, 6], status: 'saving' }, 'IME input must not rebuild the composer when autosave begins');
    await saved();
    assert.deepEqual(await page.evaluate(() => {
      const input = document.querySelector('#kt-release-input');
      return { sameNode: input === window.composingDraftNode, focused: document.activeElement === input,
        selection: [input.selectionStart, input.selectionEnd], status: document.querySelector('[data-release-history-state]').dataset.releaseHistoryState };
    }), { sameNode: true, focused: true, selection: [2, 6], status: 'saved' }, 'autosave completion must preserve the composing node, focus and selection');
    await page.evaluate(() => window.composingDraftNode.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '修正' })));
    const editorDrafts = { version: 1, active: 'local-draft', files: [{ key: 'local-draft', name: '手元の編集.js', text: '// まだ登録しない変更\nconst draftValue = 42;', registeredText: '', environment: 'preview', target: 'desktop', kind: 'js' }] };
    await page.evaluate(value => window.editDraft(value), editorDrafts); await saved();
    const firstId = await page.evaluate(() => work.history().getCurrent().id), proposalPaid = paid();
    // Reproduce the live race: open history while startup still holds an empty workspace.
    for (const boundary of ['stored-payload', 'restore-base']) {
      const paidBefore = paid(), writesBefore = mock.calls.filter(call => !call.startsWith('GET')).length;
      const priorMessages = await page.evaluate(() => work.controller.getState().messages);
      await page.reload();
      if (boundary === 'restore-base') { heldBase = F.deferred(); heldBaseStarted = F.deferred(); heldBaseReason = 'history-open'; }
      await mount({ waitReady: false, holdHistoryLoad: boundary === 'stored-payload' });
      if (boundary === 'stored-payload') await page.waitForFunction(() => window.historyLoadStarted === true);
      else await heldBaseStarted.promise;
      assert.deepEqual(await page.evaluate(() => work.controller.getState().messages), []);
      await action('saved-history').click();
      assert.equal(await page.locator('[data-history-export]').isDisabled(), true);
      assert.match(await page.locator('[data-history-export]').getAttribute('title'), /読み込み完了後/);
      // Even a queued/synthetic click cannot bypass the UI guard.
      await page.locator('[data-history-export]').dispatchEvent('click');
      assert.equal(await page.evaluate(() => window.downloads.length), 0);
      if (boundary === 'stored-payload') await page.screenshot({ path: path.join(out, 'export-loading.png'), fullPage: true });
      if (boundary === 'stored-payload') await page.evaluate(() => { window.holdHistoryLoad = false; window.releaseHistoryLoad(); });
      else { heldBase.resolve(); heldBase = null; heldBaseStarted = null; heldBaseReason = null; }
      await page.waitForFunction(() => !document.querySelector('[data-history-export]').disabled);
      assert.equal(await page.evaluate(() => window.downloads.length), 0, 'completing restore does not trigger a deferred download');
      await page.locator('[data-history-export]').click();
      const exported = await page.evaluate(() => JSON.parse(window.downloads.at(-1).text));
      assert.deepEqual(exported, await page.evaluate(() => work.history().exportCurrent()));
      assert.deepEqual(exported.session.state.messages, priorMessages);
      assert.equal(exported.draft, 'まだ送らない修正の下書き'); assert.deepEqual(exported.editor, editorDrafts);
      assert.equal(await page.evaluate(() => window.downloads.length), 1);
      assert.equal(paid(), paidBefore); assert.equal(mock.calls.filter(call => !call.startsWith('GET')).length, writesBefore);
      await page.locator('dialog [data-close]').click();
    }
    await autoReload(firstId);
    assert.equal(await page.locator('#kt-release-input').inputValue(), 'まだ送らない修正の下書き');
    assert.equal(await page.evaluate(() => work.controller.getState().phase), 'proposal');
    assert.equal(paid(), proposalPaid, 'restoring the proposal never calls AI'); assert.deepEqual(await page.evaluate(() => window.editorDrafts), editorDrafts);
    assert.match(await page.locator('.ktr-chat-log').innerText(), /承認待ち/);
    await page.locator('#kt-release-input').fill(''); await action('adopt').click(); await phase('review');
    await send('引継ぎ資料にまとめてください');
    await page.waitForFunction(() => work.controller.getState().explanations.length === 1);
    await page.locator('#kt-release-input').fill('資料への追記は後で送ります'); await saved();
    const before = await page.evaluate(() => ({ adopted: work.controller.getState().adopted, artifacts: work.controller.exportSession().state.artifacts, explanation: work.controller.getState().explanations[0], prepared: work.controller.getState().prepared }));
    assert.ok(before.prepared, 'the adopted change was approved for the pre-reload app state');
    const documentPaid = paid(); await autoReload(firstId);
    const after = await page.evaluate(() => work.controller.getState());
    assert.deepEqual(after.adopted, before.adopted); assert.deepEqual(after.artifacts, before.artifacts);
    assert.deepEqual(after.explanations[0], before.explanation); assert.equal(after.prepared, null);
    assert.equal(after.error?.code, 'APPROVAL_CHANGED');
    assert.equal(await page.evaluate(() => work.controller.apply()), false, 'automatic restore cannot reuse the previous approval');
    assert.deepEqual(await page.evaluate(() => window.editorDrafts), editorDrafts);
    assert.equal(await page.locator('#kt-release-input').inputValue(), '資料への追記は後で送ります');
    assert.match(await page.locator('.ktr-explanation').innerText(), /保存する引継ぎ資料/);
    assert.equal(await action('copy-explanation').isVisible(), true); await action('copy-explanation').click();
    assert.match(await page.evaluate(() => window.copied), /保存する引継ぎ資料/); assert.equal(paid(), documentPaid);
    assert.equal(await page.locator('[data-release-action="apply"]').count(), 0);
    await page.locator('#kt-release-input').fill(''); await action('show-changes').click();
    await action('reprepare').click(); await phase('review'); await action('apply').click(); await phase('result'); await saved();
    const resultPaid = paid(), writes = mock.calls.filter(call => !call.startsWith('GET')).length;
    await autoReload(firstId);
    assert.equal(await page.evaluate(() => work.controller.getState().runs.at(-1).archived), true);
    assert.match(await page.locator('main').innerText(), /保存した反映結果です/);
    assert.equal(await page.locator('[data-release-action="apply"],[data-release-action="request-rollback"],[data-release-action="rollback"],[data-release-action="recheck-apply"],[data-release-action="recheck-rollback"]').count(), 0);
    assert.equal(paid(), resultPaid); assert.equal(mock.calls.filter(call => !call.startsWith('GET')).length, writes);
    await historyList();
    assert.equal(await page.locator('[data-history-delete="' + firstId + '"]').isDisabled(), true);
    await page.locator('[data-history-complete]').click();
    await page.waitForFunction(() => work.history().getCurrent().completedAt != null);
    await page.locator('[data-history-pin="' + firstId + '"]').click();
    await page.waitForFunction(() => work.history().getCurrent().pinned === true);
    await page.locator('dialog [data-close]').click();
    assert.match(await page.locator('[data-release-history-state="saved"]').innerText(), /完了.*保護中/);
    await historyList(); await page.locator('[data-history-new]').click(); await page.waitForFunction(() => !document.querySelector('dialog[open]')); await phase('idle');
    await page.locator('#kt-release-input').fill('二つ目の会話の下書き'); await saved();
    const secondId = await page.evaluate(() => work.history().getCurrent().id); assert.notEqual(secondId, firstId);
    // Selecting an older conversation changes the next startup target even without editing it.
    await manualOpen(firstId, true);
    const olderSelected = await page.evaluate(() => work.history().getCurrent());
    await autoReload(firstId);
    const olderRestored = await page.evaluate(() => work.history().getCurrent());
    assert.equal(olderRestored.revision, olderSelected.revision, 'viewing an old conversation does not rewrite it');
    assert.equal(olderRestored.completedAt, olderSelected.completedAt);
    assert.equal(olderRestored.pinned, true);
    assert.equal(await page.evaluate(() => work.controller.getState().runs.at(-1).archived), true);
    await manualOpen(secondId);
    assert.equal(await page.locator('#kt-release-input').inputValue(), '二つ目の会話の下書き');
    await historyList();
    assert.equal(await page.locator('[data-history-open]').count(), 2);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'history list remains usable on narrow screens');
    await page.screenshot({ path: path.join(out, 'history-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 920 });
    page.once('dialog', dialog => dialog.accept()); await page.locator('[data-history-delete="' + firstId + '"]').click();
    await page.waitForFunction(id => !document.querySelector('[data-history-delete="' + id + '"]'), firstId);
    assert.equal(await page.locator('[data-history-delete="' + secondId + '"]').isDisabled(), true);
    await page.locator('dialog [data-close]').click();
    assert.equal(await page.locator('#kt-release-input').inputValue(), '二つ目の会話の下書き');
    // Keep a separate destination so the manual-open race checks never target the disabled active row.
    assert.equal(await page.evaluate(() => work.view.newTask()), true);
    await page.locator('#kt-release-input').fill('読み込み先の別の会話'); await saved();
    const guardTargetId = await page.evaluate(() => work.history().getCurrent().id);
    assert.notEqual(guardTargetId, secondId); await manualOpen(secondId);
    // Account changes during async boundaries must never expose or restore the old account's saved work.
    await page.reload(); await mount();
    heldBase = F.deferred(); heldBaseStarted = F.deferred();
    await action('saved-history').click(); await heldBaseStarted.promise;
    await page.evaluate(() => { window.historyScope.userId = 'u2'; });
    heldBase.resolve(); heldBase = null; heldBaseStarted = null;
    await page.waitForFunction(() => !document.querySelector('[data-history-note]')?.textContent.includes('読み込んでいます'));
    assert.equal(await page.locator('[data-history-open]').count(), 0, 'account change during app access check hides the old account list');
    assert.match(await page.locator('[data-history-note]').innerText(), /利用者|アプリ/);
    await page.locator('dialog [data-close]').click();
    await page.evaluate(() => { window.historyScope.userId = 'u1'; });
    await page.locator('#kt-release-input').fill('読み込み前の入力を維持'); await saved();
    const retained = await page.evaluate(() => ({ state: work.controller.getState(), draft: work.view.getDraft(), editor: window.editorDrafts, id: work.history().getCurrent().id }));
    for (const boundary of ['stored-payload', 'restore-base']) {
      await historyList();
      if (boundary === 'stored-payload') await page.evaluate(() => { window.holdHistoryLoad = true; window.historyLoadStarted = false; });
      else { heldBase = F.deferred(); heldBaseStarted = F.deferred(); }
      await page.locator('[data-history-open="' + guardTargetId + '"]').click();
      if (boundary === 'stored-payload') await page.waitForFunction(() => window.historyLoadStarted === true);
      else await heldBaseStarted.promise;
      await page.evaluate(() => { window.historyScope.userId = 'u2'; });
      if (boundary === 'stored-payload') await page.evaluate(() => { window.holdHistoryLoad = false; window.releaseHistoryLoad(); });
      else { heldBase.resolve(); heldBase = null; heldBaseStarted = null; }
      await page.waitForFunction(() => work.history().isSwitching() === false);
      assert.equal(await page.locator('dialog[open]').count(), 1, boundary + ': failed open leaves the dialog available');
      assert.deepEqual(await page.evaluate(() => ({ state: work.controller.getState(), draft: work.view.getDraft(), editor: window.editorDrafts, id: work.history().getCurrent().id })), retained, boundary + ': old account data must not replace the active workspace');
      assert.equal(paid(), resultPaid);
      await page.locator('dialog [data-close]').click();
      await page.evaluate(async () => { window.historyScope.userId = 'u1'; await work.history().flush(); });
    }
    // The same physical IndexedDB database remains isolated by current app/user scope.
    await page.reload(); await mount({ userId: 'u2' });
    assert.equal(await page.evaluate(() => work.history().getCurrent()), null, 'another account never automatically restores the previous account selection');
    assert.equal(await page.locator('#kt-release-input').inputValue(), '');
    await historyList();
    assert.equal(await page.locator('[data-history-open]').count(), 0); assert.match(await page.locator('[data-history-list]').innerText(), /保存した会話はありません/);
    await page.locator('dialog [data-close]').click();
    // Typing while startup awaits the fresh app read cancels restoration, including typing then undoing.
    for (const undoTyping of [false, true]) {
      const startupOptions = { dbName: dbName + '-startup-' + (undoTyping ? 'undo' : 'append') };
      await page.reload(); await mount(startupOptions);
      const priorDraft = '復元を待っている以前の下書き';
      await page.locator('#kt-release-input').fill(priorDraft); await saved();
      const priorId = await page.evaluate(() => work.history().getCurrent().id);
      const paidBefore = paid(), writesBefore = mock.calls.filter(call => !call.startsWith('GET')).length;
      await page.reload();
      heldBase = F.deferred(); heldBaseStarted = F.deferred(); heldBaseReason = 'history-open';
      await mount({ ...startupOptions, waitReady: false });
      assert.equal(await heldBaseStarted.promise, 'history-open', 'startup is held during the fresh app read');
      assert.equal(await page.evaluate(() => work.history().isInitializing()), true);
      assert.equal(await page.evaluate(() => work.history().getCurrent()), null);
      assert.equal(await page.locator('#kt-release-input').inputValue(), '');
      const typedDraft = '復元を待つ間に入力した新しい下書き';
      await page.locator('#kt-release-input').fill(typedDraft);
      if (undoTyping) await page.locator('#kt-release-input').fill('');
      heldBase.resolve(); heldBase = null; heldBaseStarted = null; heldBaseReason = null;
      assert.equal(await page.evaluate(() => work.history().ready()), false, 'user input cancels the pending startup restore');
      assert.equal(await page.evaluate(() => work.history().isInitializing()), false);
      assert.equal(await page.evaluate(() => work.controller.getState().phase), 'idle');
      assert.equal(await page.locator('#kt-release-input').inputValue(), undoTyping ? '' : typedDraft);
      // Wait for the debounce alone: no explicit save, flush, history dialog, or additional edit.
      await page.waitForFunction(() => work.history().getStatus().state === 'saved' && !work.history().isDirty());
      if (undoTyping) {
        assert.equal(await page.evaluate(() => work.history().getCurrent()), null, 'typing then undoing still prevents the old conversation from appearing');
        assert.equal(await page.locator('#kt-release-input').inputValue(), '');
      } else {
        const typedId = await page.evaluate(() => work.history().getCurrent()?.id);
        assert.ok(typedId); assert.notEqual(typedId, priorId, 'the new input is saved separately from the old conversation');
        await autoReload(typedId, startupOptions);
        assert.equal(await page.locator('#kt-release-input').inputValue(), typedDraft, 'the new input was durably autosaved without another action');
      }
      const retainedPriorDraft = await page.evaluate(async ({ id, dbName }) => {
        const store = HistoryTest.KTReleaseHistory.create({ indexedDB, scope: window.historyScope, dbName });
        try { return (await store.load(id))?.payload.draft; } finally { store.close(); }
      }, { id: priorId, dbName: startupOptions.dbName });
      assert.equal(retainedPriorDraft, priorDraft, 'cancelled startup never overwrites the earlier saved draft');
      assert.equal(paid(), paidBefore); assert.equal(mock.calls.filter(call => !call.startsWith('GET')).length, writesBefore);
    }
    // Storage errors leave the active draft intact and are explained in the compact header.
    await page.reload(); await mount({ dbName: dbName + '-quota', maxBytes: 5000 });
    await page.locator('#kt-release-input').fill('削除できる以前の下書き'); await saved();
    const quotaSavedId = await page.evaluate(() => work.history().getCurrent().id);
    assert.equal(await page.evaluate(() => work.view.newTask()), true);
    await page.evaluate(() => work.history().flush());
    assert.equal(await page.evaluate(() => work.history().getCurrent()), null);
    await page.reload(); await mount({ dbName: dbName + '-quota', maxBytes: 5000 });
    assert.equal(await page.evaluate(() => work.history().getCurrent()), null, 'explicitly starting an empty task prevents restoring the prior conversation');
    assert.equal(await page.locator('#kt-release-input').inputValue(), '');
    assert.equal(await page.evaluate(() => work.controller.getState().phase), 'idle');
    assert.deepEqual(await page.evaluate(() => work.controller.getState().messages), []);
    await historyList();
    assert.equal(await page.locator('[data-history-open="' + quotaSavedId + '"]').count(), 1, 'the empty selection keeps the earlier saved conversation');
    assert.equal(await page.locator('[data-history-retry]').isVisible(), false, 'retry is hidden while saving is healthy');
    await page.locator('dialog [data-close]').click();
    const largeDraft = '容量を超えた下書き'.repeat(700);
    await page.locator('#kt-release-input').fill(largeDraft);
    await page.waitForFunction(() => work.history().getStatus().state === 'error');
    assert.equal(await page.locator('#kt-release-input').inputValue(), largeDraft);
    await page.locator('.ktr-history-status-detail > summary').click();
    assert.match(await page.locator('.ktr-history-status-message').innerText(), /容量/);
    assert.deepEqual(await page.evaluate(async () => {
      const input = document.querySelector('#kt-release-input');
      await work.history().flush().catch(() => {});
      return { sameNode: input === document.querySelector('#kt-release-input'), detailsOpen: document.querySelector('.ktr-history-status-detail').open };
    }), { sameNode: true, detailsOpen: true }, 'repeat save errors preserve the opened detail and composer');
    const beforeFailedNew = await page.evaluate(() => work.controller.getState().taskId);
    assert.equal(await page.evaluate(() => work.view.newTask()), false);
    assert.equal(await page.evaluate(() => work.controller.getState().taskId), beforeFailedNew);
    assert.equal(await page.locator('#kt-release-input').inputValue(), largeDraft);
    await historyList(); assert.equal(await page.locator('[data-history-delete="' + quotaSavedId + '"]').isVisible(), true, 'a failed save must not hide older entries needed for cleanup');
    assert.equal(await page.locator('[data-history-retry]').innerText(), '保存をやり直す');
    await page.locator('[data-history-retry]').click();
    await page.waitForFunction(() => !document.querySelector('dialog [data-close]').disabled);
    assert.equal(await page.locator('#kt-release-input').inputValue(), largeDraft, 'a retry failure preserves the unsaved draft');
    assert.equal(await page.evaluate(() => work.history().getStatus().state), 'error');
    assert.equal(await page.locator('[data-history-export]').isEnabled(), true, 'quota failures must still permit rescuing the active draft');
    await page.locator('[data-history-export]').click();
    assert.equal(await page.evaluate(() => JSON.parse(window.downloads.at(-1).text).draft), largeDraft);
    await page.screenshot({ path: path.join(out, 'history-storage-error.png'), fullPage: true });
    assert.equal(paid(), resultPaid); assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    await context.close();
  } finally { await browser.close(); }
});
