'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { createHash } = require('node:crypto');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const { KTReleaseExecution } = require('../src/release-execution.js');
const T = loadToolkit(), clone = x => JSON.parse(JSON.stringify(x));
const hash = x => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const old = 'kintone.events.on("app.record.edit.show",e=>{return e;});';
const code = 'kintone.events.on("app.record.edit.show",e=>{e.record.memo.disabled=true;return e;});';
const writes = m => m.calls.filter(x => !x.startsWith('GET'));
async function fixture({ settings = 0, file = 'new' } = {}) {
  const field = code => ({ code, label: code, type: 'SINGLE_LINE_TEXT', required: false });
  const m = makeKintoneMock({ fields: { memo: field('memo'), other: field('other') }, views: { views: {} },
    customize: { scope: 'ALL', desktop: { js: file === 'replace' ? [{ type: 'FILE', file: { name: 'test.js', fileKey: 'base' } }] : [], css: [] }, mobile: { js: [], css: [] } } },
    { jsSources: file === 'replace' ? [{ name: 'test.js', target: 'desktop', text: old }] : [] });
  const steps = ['memo', 'other'].slice(0, settings).map((targetRef, i) => ({ id: 'P' + i, actionType: 'UPDATE_FIELD', targetRef, spec: { required: true }, dependsOn: [], title: targetRef }));
  const artifacts = file ? [{ customizationId: 'C1', title: '備考の制御', result: { generated: file === 'replace' ? { strategy: 'EXTEND_EXISTING_JS', body: code } : { strategy: 'NEW_JS_FILE', code },
    artifactOutcome: { state: 'ready', operations: [{ action: file === 'replace' ? 'replace' : 'create', targetPlatform: 'desktop', targetFile: 'test.js', contentHash: hash(code),
      ...(file === 'replace' ? { baseHash: T.KTScan.hashText(old), targetExistingFileId: 'base' } : {}) }] } } }] : [];
  if (file) steps.push({ id: 'C1', actionType: 'CUSTOMIZATION_REQUIRED', spec: { customizationId: 'C1' }, dependsOn: [] });
  const service = KTReleaseExecution.create({ appId: '310', api: m.api, loadBase: async () => ({ ok: true, current: await m.current() }), currentOf: b => b.current, planExecutor: T.KTPlanExecutor, jsExecutor: T.KTJsExecutor, hash: async x => hash(x) });
  const prepared = await service.prepare({ plan: { steps, proposedFields: [], customizations: file ? [{ customizationId: 'C1' }] : [] }, artifacts, base: { current: await m.current() } });
  assert.equal(prepared.ok, true, JSON.stringify(prepared.reasons));
  const result = await service.apply({ prepared }); assert.equal(result.status, 'complete', JSON.stringify(result));
  const run = { prepared, result }, rb = await service.prepareRollback(run); assert.equal(rb.ok, true, JSON.stringify(rb.reasons));
  return { m, service, run, rb };
}
async function recheck(f) {
  const before = clone(f.run), count = writes(f.m).length;
  const result = await f.service.recheckRollback(f.run);
  assert.deepEqual(clone(f.run), before, 'recheck does not mutate the recorded run');
  assert.equal(writes(f.m).length, count, 'recheck performs no write');
  return result;
}
for (const file of ['new', 'replace']) test('lost JavaScript restoration response is unknown, read-only recheck confirms ' + file, async () => {
  const f = await fixture({ file }), put = f.m.api.putPreviewCustomize;
  f.m.api.putPreviewCustomize = async (...args) => { await put(...args); throw Error('Failed to fetch'); };
  f.run.rollback = await f.service.rollback({ run: f.run, prepared: f.rb }); assert.equal(f.run.rollback.status, 'unknown');
  f.m.api.putPreviewCustomize = put;
  const result = await recheck(f); assert.equal(result.status, 'complete'); assert.equal(result.recoveryState, 'restored'); assert.equal(result.files.status, 'ROLLED_BACK_VERIFIED');
});
test('lost JavaScript request without write can be confirmed and explicitly retried', async () => {
  const f = await fixture(), put = f.m.api.putPreviewCustomize;
  f.m.api.putPreviewCustomize = async () => { throw Error('Failed to fetch'); };
  f.run.rollback = await f.service.rollback({ run: f.run, prepared: f.rb }); assert.equal(f.run.rollback.status, 'unknown');
  f.m.api.putPreviewCustomize = put;
  f.run.rollback = await recheck(f); assert.equal(f.run.rollback.recoveryState, 'applied'); assert.equal(f.run.rollback.retryable, true);
  const p = await f.service.prepareRollback(f.run); assert.equal(p.ok, true);
  const result = await f.service.rollback({ run: f.run, prepared: p }); assert.equal(result.status, 'complete');
});
test('explicit JavaScript write rejection is not an unknown response', async () => {
  const f = await fixture(); f.m.api.putPreviewCustomize = async () => { throw Object.assign(Error('denied'), { code: 'CB_NO02' }); };
  f.run.rollback = await f.service.rollback({ run: f.run, prepared: f.rb }); assert.equal(f.run.rollback.status, 'partial');
  const result = await recheck(f); assert.equal(result.recoveryState, 'applied'); assert.equal(result.retryable, true);
});
test('JavaScript readback failure is unknown even when executor catches it', async () => {
  const f = await fixture(), put = f.m.api.putPreviewCustomize, get = f.m.api.getPreviewCustomize; let wrote = false;
  f.m.api.putPreviewCustomize = async (...args) => { const result = await put(...args); wrote = true; return result; };
  f.m.api.getPreviewCustomize = async (...args) => { if (wrote) throw Error('offline'); return get(...args); };
  f.run.rollback = await f.service.rollback({ run: f.run, prepared: f.rb }); assert.equal(f.run.rollback.status, 'unknown');
  f.m.api.getPreviewCustomize = get;
  assert.equal((await recheck(f)).status, 'complete');
});
test('replacement body read failure is unknown and is rechecked by actual source', async () => {
  const f = await fixture({ file: 'replace' }), download = f.m.api.downloadFile;
  f.m.api.downloadFile = async () => { throw Error('offline'); };
  f.run.rollback = await f.service.rollback({ run: f.run, prepared: f.rb }); assert.equal(f.run.rollback.status, 'unknown');
  f.m.api.downloadFile = download;
  assert.equal((await recheck(f)).status, 'complete');
});
for (const after of [false, true]) test('settings response loss is unknown; recheck distinguishes written=' + after, async () => {
  const f = await fixture({ settings: 1, file: null }), put = f.m.api.updatePreviewFields;
  f.m.api.updatePreviewFields = async (...args) => { if (after) await put(...args); throw Error('Failed to fetch'); };
  f.run.rollback = await f.service.rollback({ run: f.run, prepared: f.rb }); assert.equal(f.run.rollback.status, 'unknown');
  f.m.api.updatePreviewFields = put;
  const result = await recheck(f); assert.equal(result.recoveryState, after ? 'restored' : 'applied'); assert.equal(result.status, after ? 'complete' : 'partial'); assert.equal(result.retryable, !after);
});
test('settings readback failure is unknown', async () => {
  const f = await fixture({ settings: 1, file: null }), put = f.m.api.updatePreviewFields, get = f.m.api.getPreviewFields; let wrote = false;
  f.m.api.updatePreviewFields = async (...args) => { const result = await put(...args); wrote = true; return result; };
  f.m.api.getPreviewFields = async (...args) => { if (wrote) throw Error('offline'); return get(...args); };
  f.run.rollback = await f.service.rollback({ run: f.run, prepared: f.rb }); assert.equal(f.run.rollback.status, 'unknown');
  f.m.api.getPreviewFields = get; assert.equal((await recheck(f)).status, 'complete');
});
test('partial setting restoration retains verified scripts and retries only remaining setting writes', async () => {
  const f = await fixture({ settings: 2 }), put = f.m.api.updatePreviewFields; let calls = 0;
  f.m.api.updatePreviewFields = async (...args) => { calls++; if (calls === 2) throw Error('Failed to fetch'); return put(...args); };
  f.run.rollback = await f.service.rollback({ run: f.run, prepared: f.rb }); assert.equal(f.run.rollback.status, 'unknown'); assert.equal(f.run.rollback.files.status, 'ROLLED_BACK_VERIFIED');
  f.m.api.updatePreviewFields = put;
  f.run.rollback = await recheck(f); assert.equal(f.run.rollback.recoveryState, 'partial'); assert.equal(f.run.rollback.retryable, true);
  assert.equal(f.run.rollback.settings.steps.filter(x => x.status === 'ROLLBACK_VERIFIED').length, 1);
  const before = writes(f.m).length, p = await f.service.prepareRollback(f.run); assert.equal(p.ok, true, JSON.stringify(p.reasons));
  const result = await f.service.rollback({ run: f.run, prepared: p }); assert.equal(result.status, 'complete');
  assert.deepEqual(writes(f.m).slice(before), ['PUT fields']);
});
test('changed setting is not overwritten or offered as a retry', async () => {
  const f = await fixture({ settings: 1, file: null }); f.run.rollback = { status: 'unknown' }; f.m.st.fields.memo.label = '他の変更';
  const result = await recheck(f); assert.equal(result.recoveryState, 'changed'); assert.equal(result.retryable, false);
});
test('another JavaScript change is not mistaken for a restoration', async () => {
  const f = await fixture({ file: 'replace' }); f.run.rollback = { status: 'unknown' };
  const key = f.m.st.customize.desktop.js[0].fileKey, current = f.m.st.files.get(key);
  f.m.st.files.set('someone-else', { ...current, content: '// different content' }); f.m.st.customize.desktop.js[0].fileKey = 'someone-else';
  const result = await recheck(f); assert.equal(result.recoveryState, 'changed'); assert.equal(result.retryable, false);
});
test('failed recheck remains unknown and retains earlier verified script evidence', async () => {
  const f = await fixture({ settings: 1 }); f.run.rollback = await f.service.rollback({ run: f.run, prepared: f.rb });
  const files = clone(f.run.rollback.files); f.m.api.getPreviewFields = async () => { throw Error('offline'); };
  const result = await recheck(f); assert.equal(result.status, 'unknown'); assert.equal(result.files.status, files.status); assert.equal(T.KTJsExecutor.diffSnapshots(result.files.restoredSnapshot, files.restoredSnapshot).length, 0);
});
test('different app identity cannot be rechecked', async () => {
  const f = await fixture(); f.run.rollback = { status: 'unknown' }; f.run.result.files.appId = '999';
  const result = await recheck(f); assert.equal(result.status, 'unknown'); assert.equal(result.retryable, false);
});

test('a parallel change after recheck is blocked again before any rollback write', async () => {
  const f = await fixture(); f.run.rollback = { status: 'unknown' };
  f.run.rollback = await recheck(f); assert.equal(f.run.rollback.retryable, true);
  f.m.st.customize.scope = 'ADMIN'; const before = writes(f.m).length;
  const p = await f.service.prepareRollback(f.run); assert.equal(p.ok, false); assert.ok(p.reasons.some(x => x.code === 'ROLLBACK_STALE')); assert.equal(writes(f.m).length, before);
});
test('a definite settings denial stays partial and remaining settings can be confirmed', async () => {
  const f = await fixture({ settings: 1 }), put = f.m.api.updatePreviewFields;
  f.m.api.updatePreviewFields = async () => { throw Object.assign(Error('denied'), { code: 'CB_NO02' }); };
  f.run.rollback = await f.service.rollback({ run: f.run, prepared: f.rb }); assert.equal(f.run.rollback.status, 'partial'); assert.equal(f.run.rollback.files.status, 'ROLLED_BACK_VERIFIED');
  f.m.api.updatePreviewFields = put; f.run.rollback = await recheck(f); assert.equal(f.run.rollback.recoveryState, 'partial'); assert.equal(f.run.rollback.retryable, true);
  const p = await f.service.prepareRollback(f.run); assert.equal(p.ok, true); assert.ok(p.restoredFiles); assert.equal(p.files, null);
});
