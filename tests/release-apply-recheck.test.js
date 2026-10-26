'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { createHash } = require('node:crypto');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const { KTReleaseExecution } = require(process.env.KT_EXECUTION_SRC || '../src/release-execution.js');
const T = loadToolkit(), clone = x => JSON.parse(JSON.stringify(x));
const hash = x => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const old = 'kintone.events.on("app.record.edit.show",e=>{return e;});';
const code = 'kintone.events.on("app.record.edit.show",e=>{e.record.memo.disabled=true;return e;});';
const writes = m => m.calls.filter(x => !x.startsWith('GET'));
async function fixture({ settings = 0, file = null, jsFirst = false, steps: customSteps = null, fileCount = 1, fields = {}, proposedFields = [] } = {}) {
  const field = code => ({ code, label: code, type: 'SINGLE_LINE_TEXT', required: false });
  const m = makeKintoneMock({ fields: { memo: field('memo'), other: field('other'), ...fields }, views: { views: {} },
    customize: { scope: 'ALL', desktop: { js: file === 'replace' ? [{ type: 'FILE', file: { name: 'test.js', fileKey: 'base' } }] : [], css: [] }, mobile: { js: [], css: [] } } },
    { jsSources: file === 'replace' ? [{ name: 'test.js', target: 'desktop', text: old }] : [] });
  const steps = customSteps || ['memo', 'other'].slice(0, settings).map((targetRef, i) => ({ id: 'P' + i, actionType: 'UPDATE_FIELD', targetRef, spec: { required: true }, dependsOn: jsFirst ? ['C1'] : [], title: targetRef }));
  const artifacts = file ? [{ customizationId: 'C1', title: '備考の制御', result: { generated: file === 'replace' ? { strategy: 'EXTEND_EXISTING_JS', body: code } : { strategy: 'NEW_JS_FILE', code },
    artifactOutcome: { state: 'ready', operations: Array.from({ length: fileCount }, (_, i) => ({ action: file === 'replace' ? 'replace' : 'create', targetPlatform: 'desktop', targetFile: i ? 'test' + i + '.js' : 'test.js', contentHash: hash(code),
      ...(file === 'replace' ? { baseHash: T.KTScan.hashText(old), targetExistingFileId: 'base' } : {}) })) } } }] : [];
  if (file) steps.push({ id: 'C1', actionType: 'CUSTOMIZATION_REQUIRED', spec: { customizationId: 'C1' }, dependsOn: [] });
  const service = KTReleaseExecution.create({ appId: '310', api: m.api, loadBase: async () => ({ ok: true, current: await m.current() }), currentOf: b => b.current, planExecutor: T.KTPlanExecutor, jsExecutor: T.KTJsExecutor, hash: async x => hash(x) });
  const prepared = await service.prepare({ plan: { steps, proposedFields, customizations: file ? [{ customizationId: 'C1' }] : [] }, artifacts, base: { current: await m.current() } });
  assert.equal(prepared.ok, true, JSON.stringify(prepared.reasons));
  return { m, service, run: { prepared } };
}
async function applyLost(f, { method = 'updatePreviewFields', write = true, at = 1, hideReadback = false } = {}) {
  const original = f.m.api[method], get = f.m.api.getPreviewCustomize;
  let calls = 0, thrown = false;
  f.m.api[method] = async (...args) => { if (++calls !== at) return original(...args); if (write) await original(...args); thrown = true; throw Error('response lost'); };
  if (hideReadback) f.m.api.getPreviewCustomize = async (...args) => { if (thrown) throw Error('read offline'); return get(...args); };
  f.run.result = await f.service.apply({ prepared: f.run.prepared });
  f.m.api[method] = original; f.m.api.getPreviewCustomize = get;
  assert.equal(f.run.result.status, 'unknown', JSON.stringify(f.run.result));
  return f.run.result;
}
async function recheck(f) {
  const before = clone(f.run), count = writes(f.m).length;
  const result = await f.service.recheckApply(f.run);
  assert.deepEqual(clone(f.run), before, 'input evidence remains intact');
  assert.equal(writes(f.m).length, count, 'readback sends no writes or uploads');
  return result;
}
for (const write of [false, true]) test('settings lost response: current state identifies written=' + write, async () => {
  const f = await fixture({ settings: 1 }); await applyLost(f, { write });
  const original = clone(f.run.result), result = await recheck(f);
  assert.equal(result.status, write ? 'complete' : 'failed', JSON.stringify(result));
  assert.equal(result.recoveryState, write ? 'applied' : 'not-applied'); assert.equal(result.written, write);
  assert.equal(result.settings.steps[0].previousOutcome.error.message, original.settings.steps[0].error.message);
  assert.equal(result.settings.writeIntents[0].acknowledged, false, 'intent is not relabeled an ACK');
  if (write) { f.run.result = result; assert.equal((await f.service.prepareRollback(f.run)).ok, true); }
});
for (const write of [false, true]) test('two settings in the same collection use the latest complete state: last written=' + write, async () => {
  const f = await fixture({ settings: 2 }); await applyLost(f, { at: 2, write });
  const result = await recheck(f); assert.equal(result.status, write ? 'complete' : 'partial', JSON.stringify(result));
  assert.equal(result.settings.steps.filter(s => s.status === 'VERIFIED').length, write ? 2 : 1);
  f.run.result = result; const rollback = await f.service.prepareRollback(f.run); assert.equal(rollback.ok, true, JSON.stringify(rollback));
});
test('two views preserve all entries, rather than checking an intermediate list', async () => {
  const steps = ['one', 'two'].map((name, i) => ({ id: 'V' + i, title: name, actionType: 'ADD_VIEW', targetRef: name, spec: { name, type: 'LIST', fields: ['memo'], filterCond: '', sort: 'memo asc' }, dependsOn: [] }));
  const f = await fixture({ steps }); await applyLost(f, { method: 'putPreviewViews', at: 2 });
  const result = await recheck(f); assert.equal(result.status, 'complete', JSON.stringify(result));
});
test('a third-party setting change is neither success nor safe rollback', async () => {
  const f = await fixture({ settings: 1 }); await applyLost(f); f.m.st.fields.other.label = 'someone else';
  const result = await recheck(f); assert.equal(result.recoveryState, 'changed'); assert.equal(result.status, 'unknown'); assert.equal(result.retryable, false);
  f.run.result = result; assert.equal((await f.service.prepareRollback(f.run)).ok, false);
});
test('an acknowledged earlier write reverted later is a changed state', async () => {
  const f = await fixture({ settings: 2 }); await applyLost(f, { at: 2, write: false }); f.m.st.fields.memo.required = false;
  assert.equal((await recheck(f)).recoveryState, 'changed');
});
test('read failure preserves the unknown request and its error', async () => {
  const f = await fixture({ settings: 1 }); await applyLost(f); const evidence = clone(f.run.result.settings);
  f.m.api.getPreviewFields = async () => { throw Error('offline'); };
  const result = await recheck(f); assert.equal(result.status, 'unknown'); assert.deepEqual(clone(result.settings), evidence);
});
test('mixed revisions cannot certify a settings result', async () => {
  const f = await fixture({ settings: 1 }); await applyLost(f);
  const get = f.m.api.getPreviewViews; f.m.api.getPreviewViews = async (...a) => ({ ...await get(...a), revision: '100' });
  assert.equal((await recheck(f)).status, 'unknown');
});
test('old evidence without submitted requests stays unknown', async () => {
  const f = await fixture({ settings: 1 }); await applyLost(f); delete f.run.result.settings.writeIntents;
  assert.equal((await recheck(f)).recoveryState, 'unknown');
});
test('mismatched app identity is rejected before reading', async () => {
  const f = await fixture({ settings: 1 }); await applyLost(f); f.run.result.settings.appId = '999'; const count = f.m.calls.length;
  assert.equal((await recheck(f)).status, 'unknown'); assert.equal(f.m.calls.length, count);
});
for (const file of ['new', 'replace']) test('lost JavaScript response checks actual source and permits explicit rollback: ' + file, async () => {
  const f = await fixture({ file }); await applyLost(f, { method: 'putPreviewCustomize' });
  const originalPut = clone(f.run.result.files.put), result = await recheck(f); assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.deepEqual(clone(result.files.previousOutcome.put), originalPut); assert.equal(result.files.put.confirmedByReadback, true);
  f.run.result = result; const rollback = await f.service.prepareRollback(f.run); assert.equal(rollback.ok, true, JSON.stringify(rollback));
});
test('lost JavaScript request with no write is observed without resending', async () => {
  const f = await fixture({ file: 'new' }); await applyLost(f, { method: 'putPreviewCustomize', write: false, hideReadback: true });
  const result = await recheck(f); assert.equal(result.recoveryState, 'not-applied', JSON.stringify(result)); assert.equal(result.written, false);
});
test('settings applied but later JavaScript absent is partial', async () => {
  const f = await fixture({ settings: 1, file: 'new' }); await applyLost(f, { method: 'putPreviewCustomize', write: false, hideReadback: true });
  const result = await recheck(f); assert.equal(result.status, 'partial', JSON.stringify(result)); assert.equal(result.files.previewUnchanged, true);
});
test('JavaScript-first response loss never claims later settings completed', async () => {
  const f = await fixture({ settings: 1, file: 'new', jsFirst: true }); await applyLost(f, { method: 'putPreviewCustomize' });
  const result = await recheck(f); assert.equal(result.status, 'partial', JSON.stringify(result)); assert.equal(result.files.status, 'DONE'); assert.equal(f.m.st.fields.memo.required, false);
  f.run.result = result; assert.equal((await f.service.prepareRollback(f.run)).ok, true);
});
test('JavaScript first remains verified while later settings have an unknown response', async () => {
  const f = await fixture({ settings: 1, file: 'new', jsFirst: true }); await applyLost(f);
  const result = await recheck(f); assert.equal(result.status, 'complete', JSON.stringify(result));
});
test('new files with reversed order are changed, not verified', async () => {
  const f = await fixture({ file: 'new', fileCount: 2 }); await applyLost(f, { method: 'putPreviewCustomize' }); f.m.st.customize.desktop.js.reverse();
  assert.equal((await recheck(f)).recoveryState, 'changed');
});
test('matching names with different source are changed', async () => {
  const f = await fixture({ file: 'new' }); await applyLost(f, { method: 'putPreviewCustomize' });
  const key = f.m.st.customize.desktop.js[0].fileKey; f.m.st.files.get(key).content = '// something else';
  assert.equal((await recheck(f)).recoveryState, 'changed');
});
test('download failure is unknown, not a content mismatch', async () => {
  const f = await fixture({ file: 'new' }); await applyLost(f, { method: 'putPreviewCustomize' }); f.m.api.downloadFile = async () => { throw Error('offline'); };
  assert.equal((await recheck(f)).recoveryState, 'unknown');
});
test('later revision during JavaScript readback prevents promotion', async () => {
  const f = await fixture({ file: 'new' }); await applyLost(f, { method: 'putPreviewCustomize' });
  const get = f.m.api.getPreviewCustomize; let calls = 0;
  f.m.api.getPreviewCustomize = async (...a) => { const r = await get(...a); return ++calls > 1 ? { ...r, revision: String(+r.revision + 1) } : r; };
  assert.equal((await recheck(f)).status, 'unknown');
});



test('option rename uses the approved after-definition, not the old payload key', async () => {
  const fields = { choice: { code: 'choice', label: '会計ソフト', type: 'DROP_DOWN', required: false, options: { old: { label: 'old', index: '0' } }, defaultValue: 'old' } };
  const steps = [{ id: 'P1', actionType: 'UPDATE_FIELD', targetRef: 'choice', spec: { optionEdits: { items: [{ from: 'old', label: 'new' }], removed: [], defaultValue: ['new'] } }, dependsOn: [] }];
  const f = await fixture({ fields, steps }); await applyLost(f); const result = await recheck(f);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  f.run.result = result; const rollback = await f.service.prepareRollback(f.run);
  assert.equal(rollback.ok, false, 'manual recovery restriction still applies'); assert.ok(rollback.reasons.some(x => x.code === 'MANUAL_FIELD_RECOVERY'));
});
test('field deletion readback checks the removed field and other form layout', async () => {
  const steps = [{ id: 'P1', actionType: 'DELETE_FIELD', targetRef: 'other', spec: {}, dependsOn: [] }];
  const f = await fixture({ steps }); await applyLost(f, { method: 'deletePreviewFields' });
  assert.equal((await recheck(f)).status, 'complete');
  f.m.st.layout.reverse(); f.m.st.fields.memo.label = 'changed';
  assert.equal((await recheck(f)).recoveryState, 'changed');
});
for (const write of [false, true]) test('POST field response: known absence or insufficient placement evidence, written=' + write, async () => {
  const steps = [{ id: 'P1', actionType: 'ADD_FIELD', targetRef: 'F1', spec: { placement: { position: 'AFTER_ROW', anchor: 'memo' } }, dependsOn: [] }];
  const proposedFields = [{ temporaryId: 'F1', suggestedCode: 'new_field', label: '確認欄', type: 'SINGLE_LINE_TEXT', required: false }];
  const f = await fixture({ steps, proposedFields }); await applyLost(f, { method: 'addPreviewFields', write });
  const result = await recheck(f); assert.equal(result.recoveryState, write ? 'unknown' : 'not-applied', JSON.stringify(result));
  assert.equal(result.status, write ? 'unknown' : 'failed'); assert.equal(result.written, write ? null : false);
});
test('null body read is unavailable rather than a third-party change', async () => {
  const f = await fixture({ file: 'new' }); await applyLost(f, { method: 'putPreviewCustomize' }); f.m.api.downloadFile = async () => null;
  assert.equal((await recheck(f)).recoveryState, 'unknown');
});
test('approved preparation from a different environment is rejected before reading', async () => {
  const f = await fixture({ file: 'new' }); await applyLost(f, { method: 'putPreviewCustomize' }); f.run.prepared.files.env = 'production';
  const count = f.m.calls.length; assert.equal((await recheck(f)).status, 'unknown'); assert.equal(f.m.calls.length, count);
});
test('changed approval material cannot certify an apply result', async () => {
  const f = await fixture({ settings: 1 }); await applyLost(f); f.run.prepared.settings.steps[0].prepared.payload.changes.required = false;
  assert.equal((await recheck(f)).recoveryState, 'unknown');
});
test('after recheck, fresh third-party change still blocks rollback', async () => {
  const f = await fixture({ settings: 1, file: 'new' }); await applyLost(f, { method: 'putPreviewCustomize' });
  f.run.result = await recheck(f); assert.equal(f.run.result.status, 'complete');
  f.m.st.fields.memo.label = 'changed'; const count = writes(f.m).length;
  const rollback = await f.service.prepareRollback(f.run); assert.equal(rollback.ok, false); assert.equal(writes(f.m).length, count);
});

for (const add of [false, true]) test('app action GET empty destination code matches submitted request: add=' + add, async () => {
  const m = makeKintoneMock(require('./fixtures/ai-context-app.js').makeData());
  const operations = [{ id: 'A1', actionType: add ? 'ADD_APP_ACTION' : 'UPDATE_APP_ACTION', targetRef: add ? '新規アクション' : '見積を作成',
    spec: add ? { name: '新規アクション', destApp: '311', actionMappings: [{ srcType: 'FIELD', srcField: 'case_name', destField: 'quote_title' }], entities: ['GROUP:everyone'], filterCond: '' } : { filterCond: 'amount >= "1"' }, dependsOn: [] }];
  const prepared = await T.KTPlanExecutor.prepareOperations({ appId: '310', operations }, { api: m.api, current: await m.current() });
  assert.equal(prepared.status, 'PREPARED');
  const put = m.api.putPreviewActions; m.api.putPreviewActions = async (...a) => { await put(...a); throw Error('response lost'); };
  const execution = await T.KTPlanExecutor.executePreview(prepared, { api: m.api }); m.api.putPreviewActions = put;
  const count = writes(m).length, original = clone(execution);
  const result = await T.KTPlanExecutor.recheckPreview(execution, prepared, { api: m.api });
  assert.equal(result.state, 'applied', JSON.stringify(result));
  assert.deepEqual(clone(execution), original); assert.equal(writes(m).length, count);
  assert.deepEqual(clone(result.execution.previousOutcome.actualAfterRaw), original.actualAfterRaw);
  m.st.actions['見積を作成'].filterCond = 'amount > "1234"';
  assert.equal((await T.KTPlanExecutor.recheckPreview(execution, prepared, { api: m.api })).state, 'changed');
  m.st.actions['見積を作成'].filterCond = original.actualAfterRaw.actions.actions['見積を作成'].filterCond;
  m.st.actions['見積を作成'].destApp.app = '999';
  assert.equal((await T.KTPlanExecutor.recheckPreview(execution, prepared, { api: m.api })).state, 'changed');
});

