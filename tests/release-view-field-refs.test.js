'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const { KTReleaseExecution } = require('../src/release-execution.js');
const FX = require('./fixtures/ai-context-app.js');
const T = loadToolkit(), P = T.KTPlanExecutor;
const plain = x => JSON.parse(JSON.stringify(x));
const writes = m => m.calls.filter(x => !x.startsWith('GET'));
const proposed = (temporaryId = 'NEW_FIELD_1', suggestedCode = '確認期限') => ({ temporaryId, suggestedCode, label: suggestedCode, type: 'DATE', required: false });
const add = (ref = 'NEW_FIELD_1', id = 'P1') => ({ id, actionType: 'ADD_FIELD', targetRef: ref, spec: { placement: { position: 'AFTER_ROW', anchor: '確認メモ' } }, dependsOn: [] });
const view = (type = 'ADD_VIEW', sort = 'NEW_FIELD_1 asc', dependsOn = ['P1']) => ({ id: 'V1', actionType: type, targetRef: '確認期限一覧', title: 'NEW_FIELD_1は説明文のまま保持', dependsOn,
  spec: { name: '確認期限一覧', fields: ['確認メモ', 'NEW_FIELD_1'], filterCond: 'case_name like "NEW_FIELD_1"', sort } });
function fixture() {
  const data = FX.makeData();
  data.fields['確認メモ'] = { code: '確認メモ', label: '確認メモ', type: 'SINGLE_LINE_TEXT', required: false };
  return makeKintoneMock(data);
}
const prep = async (m, operations, proposedFields = [proposed()]) => P.prepareOperations({ appId: '310', requireFieldPlacement: true, operations, proposedFields }, { api: m.api, current: await m.current() });
const payloadSort = p => { const v = p.steps.find(s => s.stepId === 'V1').prepared.payload; return v.view?.sort ?? v.changes?.sort; };
for (const type of ['ADD_VIEW', 'UPDATE_VIEW']) test(type + ': real release preparation, mock write/readback and rollback use the actual field code', async () => {
  const m = fixture();
  if (type === 'UPDATE_VIEW') m.st.views['確認期限一覧'] = { name: '確認期限一覧', type: 'LIST', fields: ['確認メモ'], filterCond: '', sort: 'amount desc', index: '4', id: '77' };
  const baseline = plain({ views: m.st.views, layout: m.st.layout, fields: m.st.fields, production: m.st.prodRevision });
  const plan = { steps: [view(type), add()], proposedFields: [proposed()], customizations: [] }, original = plain(plan);
  const loadBase = async () => ({ ok: true, current: await m.current() });
  const service = KTReleaseExecution.create({ appId: '310', api: m.api, loadBase, currentOf: b => b.current, planExecutor: P, jsExecutor: T.KTJsExecutor,
    hash: async x => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex') });
  const p = await service.prepare({ plan, artifacts: [], base: await loadBase() });
  assert.equal(p.ok, true, JSON.stringify(p.reasons));
  assert.equal(payloadSort(p.settings), '確認期限 asc');
  const expected = p.settings.steps.find(s => s.stepId === 'V1').prepared.expect;
  assert.equal(expected.sort, '確認期限 asc');
  assert.deepEqual(plain(expected.fields), ['確認メモ', '確認期限']);
  assert.equal(expected.filterCond, 'case_name like "NEW_FIELD_1"');
  assert.equal(p.changes.find(x => x.id === 'V1').after.sort, '確認期限 asc');
  assert.deepEqual(writes(m), []); assert.deepEqual(plan, original);
  const put = m.api.putPreviewViews, sent = [];
  m.api.putPreviewViews = async (...args) => { sent.push(plain(args[1])); return put(...args); };
  const result = await service.apply({ prepared: p });
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.equal(sent[0]['確認期限一覧'].sort, '確認期限 asc');
  assert.equal(m.st.views['確認期限一覧'].sort, '確認期限 asc');
  assert.ok(writes(m).indexOf('POST fields') < writes(m).indexOf('PUT views'));
  assert.equal(m.st.prodRevision, baseline.production);
  const run = { prepared: p, result }, rb = await service.prepareRollback(run);
  assert.equal(rb.ok, true, JSON.stringify(rb));
  const restored = await service.rollback({ run, prepared: rb });
  assert.equal(restored.status, 'complete', JSON.stringify(restored));
  assert.deepEqual(plain(m.st.views), baseline.views); assert.deepEqual(plain(m.st.fields), baseline.fields); assert.deepEqual(plain(m.st.layout), baseline.layout);
  assert.equal(m.st.prodRevision, baseline.production); assert.deepEqual(plan, original);
});
test('multiple sort keys preserve order, direction and existing codes; temporary IDs match exactly', async () => {
  const m = fixture(); m.st.fields.NEW_FIELD_1_suffix = { code: 'NEW_FIELD_1_suffix', label: '既存項目', type: 'DATE' };
  const v = view('ADD_VIEW', ' NEW_FIELD_10 DESC, amount asc, NEW_FIELD_1 desc, NEW_FIELD_1_suffix asc ', ['P1', 'P10']);
  const p = await prep(m, [v, add(), add('NEW_FIELD_10', 'P10')], [proposed(), proposed('NEW_FIELD_10', '再確認期限')]);
  assert.equal(p.status, 'PREPARED', JSON.stringify(p.blockers));
  assert.equal(payloadSort(p), ' 再確認期限 DESC, amount asc, 確認期限 desc, NEW_FIELD_1_suffix asc ');
});
test('a replacement code that resembles another temporary ID is not replaced twice', async () => {
  const m = fixture(), v = view('ADD_VIEW', 'NEW_FIELD_1 asc, NEW_FIELD_10 desc', ['P1', 'P10']);
  const p = await prep(m, [add(), add('NEW_FIELD_10', 'P10'), v], [proposed('NEW_FIELD_1', 'NEW_FIELD_10'), proposed('NEW_FIELD_10', '別の期限')]);
  assert.equal(p.status, 'PREPARED', JSON.stringify(p.blockers));
  assert.equal(payloadSort(p), 'NEW_FIELD_10 asc, 別の期限 desc');
});
test('existing code resembling a temporary ID, built-in code and empty sort remain unchanged', async () => {
  for (const sort of ['NEW_FIELD_1 asc, レコード番号 desc', '']) {
    const m = fixture(); m.st.fields.NEW_FIELD_1 = { code: 'NEW_FIELD_1', label: '既存の期限', type: 'DATE' };
    const v = view('ADD_VIEW', sort, []); v.spec.fields = ['確認メモ'];
    const p = await prep(m, [v], []);
    assert.equal(p.status, 'PREPARED', JSON.stringify(p.blockers)); assert.equal(payloadSort(p), sort); assert.deepEqual(writes(m), []);
  }
});
for (const kind of ['unknown', 'definition-without-add', 'view-before-add', 'failed-add', 'invalid-sort']) test(kind + ': unresolved or invalid sort cannot be approved or written', async () => {
  const m = fixture(), v = view('ADD_VIEW', kind === 'unknown' ? 'NEW_FIELD_99 asc' : kind === 'invalid-sort' ? 'NEW_FIELD_1' : 'NEW_FIELD_1 asc', []);
  v.spec.fields = ['確認メモ'];
  let operations = [v], fields = [proposed()];
  if (kind === 'view-before-add') operations = [v, add()];
  if (kind === 'invalid-sort') operations = [add(), v];
  if (kind === 'failed-add') { fields = [proposed('NEW_FIELD_1', 'amount')]; operations = [add(), { ...v, dependsOn: ['P1'] }]; }
  const p = await prep(m, operations, fields);
  assert.equal(p.status, 'BLOCKED');
  assert.ok(p.blockers.some(x => ['INVALID_SORT', 'DEPENDENCY_BLOCKED'].includes(x.code)), JSON.stringify(p.blockers));
  await assert.rejects(P.executePreview(p, { api: m.api })); assert.deepEqual(writes(m), []);
});
test('unknown temporary reference in a filter still uses the existing condition checker', async () => {
  const m = fixture(), v = view('ADD_VIEW', 'NEW_FIELD_1 asc');
  v.spec.filterCond = 'NEW_FIELD_1 = "2026-10-26"';
  const p = await prep(m, [add(), v]);
  assert.equal(p.status, 'BLOCKED'); assert.ok(p.blockers.some(x => x.code === 'COND_INVALID')); assert.deepEqual(writes(m), []);
});
