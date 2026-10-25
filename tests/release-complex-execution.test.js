'use strict';
// Real preview coordinator and executors; only kintone transport and verified AI output are fixed.
// These cases test operation ordering and preservation, not AI interpretation or actual kintone.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const T = loadToolkit();
const { KTReleaseExecution } = require('../src/release-execution.js');
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const field = (code, type = 'SINGLE_LINE_TEXT', extra = {}) => ({ code, label: code, type, required: false, ...extra });
const step = (id, actionType, targetRef, spec = {}, dependsOn = []) => ({ id, actionType, targetRef, spec, dependsOn, title: id + 'の変更' });
const oldSource = platform => 'kintone.events.on("' + (platform === 'mobile' ? 'mobile.' : '') + 'app.record.edit.show",e=>{e.record.memo.value=e.record.referral.value+e.record.referral2.value;return e;});';
const newSource = platform => 'kintone.events.on("' + (platform === 'mobile' ? 'mobile.' : '') + 'app.record.edit.show",e=>{e.record.memo.value=e.record.extra.value;return e;});';
const writes = mock => mock.calls.filter(call => !call.startsWith('GET'));
const contents = mock => clone(Object.fromEntries(['desktop', 'mobile'].map(target => [target, mock.st.customize[target].js.map(file => mock.st.files.get(file.fileKey).content)])));
function fixture() {
  const options = Object.fromEntries(['勘定奉行i10/11', 'PCA会計X/DX', '会計王'].map((label, index) => [label, { label, index: String(index) }]));
  const m = makeKintoneMock({
    fields: { software: field('software', 'DROP_DOWN', { options, defaultValue: '勘定奉行i10/11' }),
      referral: field('referral', 'SINGLE_LINE_TEXT', { label: '紹介経路' }),
      referral2: field('referral2', 'SINGLE_LINE_TEXT', { label: '紹介経路' }),
      calc: field('calc', 'CALC', { expression: 'IF(referral="紹介",100,200)', format: 'NUMBER', displayScale: '0' }),
      calc2: field('calc2', 'CALC', { expression: 'IF(referral2="紹介",1,0)', format: 'NUMBER', displayScale: '0' }),
      memo: field('memo'), untouched: field('untouched') },
    views: { views: { 既存一覧: { id: '4', index: '0', name: '既存一覧', type: 'LIST', fields: ['software', 'referral', 'referral2', 'memo'], filterCond: '', sort: '' } }, revision: '10' },
    customize: { scope: 'ALL', desktop: { js: [{ type: 'FILE', file: { name: 'explanation.js', fileKey: 'pc-base' } }], css: [] },
      mobile: { js: [{ type: 'FILE', file: { name: 'explanation.js', fileKey: 'mobile-base' } }], css: [] } },
    status: { enable: true, states: { 作成中: { name: '作成中', index: '0', assignee: { type: 'ONE', entities: [] } }, 完了: { name: '完了', index: '1', assignee: { type: 'ONE', entities: [] } } },
      actions: [{ name: '完了する', from: '作成中', to: '完了', filterCond: '', type: 'PRIMARY' }] }
  }, { autoPlace: false, jsSources: ['desktop', 'mobile'].map(target => ({ name: 'explanation.js', target, text: oldSource(target) })) });
  const steps = [
    step('CHOICES', 'UPDATE_FIELD', 'software', { optionEdits: { items: [
      { from: '勘定奉行i10/11', label: '奉行クラウド' }, { from: 'PCA会計X/DX', label: 'PCAクラウド' }
    ], removed: ['会計王'], defaultValue: ['奉行クラウド'] } }),
    step('ADD', 'ADD_FIELD', 'F1', { placement: { position: 'BEFORE_ROW', anchor: 'memo' } }, ['CHOICES']),
    step('CALC1', 'UPDATE_FIELD', 'calc', { expression: '200' }, ['ADD']),
    step('CALC2', 'UPDATE_FIELD', 'calc2', { expression: '0' }, ['CALC1']),
    step('VIEW', 'UPDATE_VIEW', '既存一覧', { fields: ['software', 'memo', 'extra'], filterCond: '', sort: '' }, ['CALC2']),
    step('PC', 'CUSTOMIZATION_REQUIRED', 'C_PC', { customizationId: 'C_PC' }, ['VIEW']),
    step('MOBILE', 'CUSTOMIZATION_REQUIRED', 'C_MOBILE', { customizationId: 'C_MOBILE' }, ['VIEW']),
    step('DELETE1', 'DELETE_FIELD', 'referral', {}, ['PC', 'MOBILE']),
    step('DELETE2', 'DELETE_FIELD', 'referral2', {}, ['DELETE1'])
  ];
  const artifacts = ['desktop', 'mobile'].map(target => ({ customizationId: target === 'desktop' ? 'C_PC' : 'C_MOBILE', title: target + 'の説明',
    result: { generated: { strategy: 'EXTEND_EXISTING_JS', body: newSource(target) }, artifactOutcome: { state: 'ready',
      operations: [{ action: 'replace', targetPlatform: target, targetFile: 'explanation.js',
        targetExistingFileId: target === 'desktop' ? 'pc-base' : 'mobile-base',
        baseHash: T.KTScan.hashText(oldSource(target)), contentHash: hash(newSource(target)) }] } } }));
  const plan = { steps, customizations: artifacts.map(a => ({ customizationId: a.customizationId })),
    proposedFields: [{ temporaryId: 'F1', suggestedCode: 'extra', label: '説明メモ', type: 'SINGLE_LINE_TEXT', required: false }] };
  const loadBase = async () => ({ ok: true, current: await m.current() });
  const service = KTReleaseExecution.create({ appId: '310', api: m.api, loadBase, currentOf: b => b.current,
    planExecutor: T.KTPlanExecutor, jsExecutor: T.KTJsExecutor, hash: async v => hash(v) });
  return { m, plan, artifacts, loadBase, service };
}
async function prepare(f) {
  const prepared = await f.service.prepare({ plan: f.plan, artifacts: f.artifacts, base: await f.loadBase() });
  assert.equal(writes(f.m).length, 0, 'preparation never writes');
  return prepared;
}
function ready(prepared) { assert.equal(prepared.ok, true, JSON.stringify(prepared.reasons)); }

for (const ordering of ['declared', 'reversed', 'rotated']) test('mixed choices, layout, two formulas, view and same-named PC/mobile files retain exact dependency order ' + ordering, async () => {
  const f = fixture(), untouched = clone(f.m.st.fields.untouched), beforeStatus = clone(f.m.st.status);
  if (ordering === 'reversed') f.plan.steps.reverse();
  if (ordering === 'rotated') f.plan.steps = [...f.plan.steps.slice(5), ...f.plan.steps.slice(0, 5)];
  const p = await prepare(f); ready(p);
  const oldUpload = f.m.api.uploadFile, oldDelete = f.m.api.deletePreviewFields;
  let uploadCount = 0, deleteCount = 0;
  f.m.api.uploadFile = async (...args) => {
    uploadCount++;
    assert.ok(f.m.st.fields.extra && f.m.st.fields.referral && f.m.st.fields.referral2);
    assert.equal(f.m.st.fields.calc.expression, '200'); assert.equal(f.m.st.fields.calc2.expression, '0');
    assert.deepEqual(f.m.st.views['既存一覧'].fields, ['software', 'memo', 'extra']);
    return oldUpload(...args);
  };
  f.m.api.deletePreviewFields = async (...args) => {
    deleteCount++;
    assert.deepEqual(contents(f.m), { desktop: [newSource('desktop')], mobile: [newSource('mobile')] });
    return oldDelete(...args);
  };
  const r = await f.service.apply({ prepared: p }); assert.equal(r.status, 'complete', JSON.stringify({ status: r.status, reasons: r.reasons, rows: r.rows }));
  assert.equal(uploadCount, 2); assert.equal(deleteCount, 2);
  assert.equal(writes(f.m).filter(c => c === 'PUT customize').length, 1);
  assert.equal(f.m.st.fields.referral, undefined); assert.equal(f.m.st.fields.referral2, undefined);
  assert.deepEqual(Object.keys(f.m.st.fields.software.options), ['奉行クラウド', 'PCAクラウド']);
  const placement = f.m.st.layout.map(row => row.fields?.map(v => v.code).join(','));
  assert.equal(placement.indexOf('extra') + 1, placement.indexOf('memo'));
  assert.deepEqual(f.m.st.fields.untouched, untouched); assert.deepEqual(f.m.st.status, beforeStatus); assert.equal(f.m.st.prodRevision, 10);
});

test('second platform upload failure leaves both registered sources intact and both deletion targets present', async () => {
  const f = fixture(), original = contents(f.m), p = await prepare(f); ready(p);
  const upload = f.m.api.uploadFile; let count = 0;
  f.m.api.uploadFile = async (...args) => {
    if (++count === 2) throw Object.assign(new Error('mobile upload denied'), { code: 'CB_NO02', status: 403 });
    return upload(...args);
  };
  const r = await f.service.apply({ prepared: p });
  assert.equal(r.status, 'partial'); assert.equal(r.written, true);
  assert.deepEqual(contents(f.m), original); assert.ok(f.m.st.fields.referral && f.m.st.fields.referral2);
  assert.ok(!writes(f.m).includes('PUT customize')); assert.ok(!writes(f.m).includes('DELETE fields'));
  assert.equal(f.m.st.fields.calc.expression, '200'); assert.equal(f.m.st.fields.calc2.expression, '0');
  assert.ok(f.m.st.fields.extra); assert.equal(f.m.st.prodRevision, 10);
});

for (const lostReply of [false, true]) test('second deletion ' + (lostReply ? 'response loss stays unknown' : 'denial keeps exact partial state') + ' after both scripts changed', async () => {
  const f = fixture(), p = await prepare(f); ready(p);
  const remove = f.m.api.deletePreviewFields; let count = 0;
  f.m.api.deletePreviewFields = async (...args) => {
    if (++count === 2) {
      if (lostReply) { await remove(...args); throw new Error('second DELETE response lost'); }
      throw Object.assign(new Error('second DELETE denied'), { code: 'CB_NO02', status: 403 });
    }
    return remove(...args);
  };
  const r = await f.service.apply({ prepared: p });
  assert.equal(r.status, lostReply ? 'unknown' : 'partial', JSON.stringify({ status: r.status, reasons: r.reasons, rows: r.rows })); assert.equal(r.written, lostReply ? null : true);
  assert.equal(r.files.status, 'DONE'); assert.equal(f.m.st.fields.referral, undefined);
  assert.equal(!!f.m.st.fields.referral2, !lostReply);
  assert.deepEqual(contents(f.m), { desktop: [newSource('desktop')], mobile: [newSource('mobile')] });
  const writesBeforeRecovery = writes(f.m).length;
  const rb = await f.service.prepareRollback({ prepared: p, result: r });
  assert.equal(writes(f.m).length, writesBeforeRecovery);
  assert.equal(rb.ok, false); assert.ok(rb.reasons.some(x => x.code === (lostReply ? 'RESULT_UNKNOWN' : 'MANUAL_FIELD_RECOVERY')));
  assert.equal(f.m.st.prodRevision, 10);
});

test('mobile source identity conflict blocks the whole mixed plan before the first setting changes', async () => {
  const f = fixture(), before = clone(f.m.st.fields);
  f.artifacts[1].result.artifactOutcome.operations[0].targetExistingFileId = 'pc-base';
  const p = await prepare(f); assert.equal(p.ok, false); assert.ok(p.reasons.some(x => x.code === 'FILE_TARGET_CHANGED'));
  const r = await f.service.apply({ prepared: p }); assert.equal(r.status, 'failed'); assert.equal(writes(f.m).length, 0);
  assert.deepEqual(f.m.st.fields, before);
});

test('forgotten second formula reference blocks all destructive and non-destructive writes', async () => {
  const f = fixture(); f.plan.steps.find(x => x.id === 'CALC2').spec.expression = 'IF(referral2="紹介",2,0)';
  const p = await prepare(f); assert.equal(p.ok, false); assert.ok(p.reasons.some(x => x.code === 'FIELD_REFERENCED'));
  const r = await f.service.apply({ prepared: p }); assert.equal(r.status, 'failed'); assert.equal(writes(f.m).length, 0);
});

test('new formula reference after joint PC/mobile registration stops subsequent deletion', async () => {
  const f = fixture(), p = await prepare(f); ready(p);
  const put = f.m.api.putPreviewCustomize;
  f.m.api.putPreviewCustomize = async (...args) => {
    const r = await put(...args);
    f.m.st.fields.calc2.expression = 'IF(referral2="紹介",9,0)'; f.m.st.revision++;
    return r;
  };
  const r = await f.service.apply({ prepared: p });
  assert.equal(r.status, 'partial', JSON.stringify({ status: r.status, reasons: r.reasons, rows: r.rows })); assert.equal(r.files.status, 'DONE');
  assert.ok(f.m.st.fields.referral2); assert.equal(f.m.st.fields.calc2.expression, 'IF(referral2="紹介",9,0)');
  assert.equal(f.m.st.prodRevision, 10);
});

test('unreachable process addition mixed with valid maintenance never partially applies the valid changes', async () => {
  const f = fixture(), before = clone(f.m.st.fields);
  f.plan.steps.push(step('ISLAND', 'ADD_PROCESS_STATUS', '経理確認', { name: '経理確認', assigneeType: 'ONE', assignees: ['USER:user1'] }));
  const p = await prepare(f); assert.equal(p.ok, false); assert.ok(p.reasons.some(x => x.code === 'STATUS_UNREACHABLE'));
  const r = await f.service.apply({ prepared: p }); assert.equal(r.status, 'failed'); assert.equal(writes(f.m).length, 0);
  assert.deepEqual(f.m.st.fields, before); assert.equal(f.m.st.status.states['経理確認'], undefined);
});

test('a later new-field dependency cannot form a second registration wave hidden inside one approval', async () => {
  const f = fixture();
  f.plan.steps.find(x => x.id === 'ADD').dependsOn = ['DELETE1'];
  const p = await prepare(f); assert.equal(p.ok, false); assert.ok(p.reasons.some(x => x.code === 'REGISTRATION_ORDER_CONFLICT'));
  const r = await f.service.apply({ prepared: p }); assert.equal(r.status, 'failed'); assert.equal(writes(f.m).length, 0);
});
