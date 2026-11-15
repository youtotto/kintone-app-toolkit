'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const P = loadToolkit().KTPlanExecutor;
const clone = x => JSON.parse(JSON.stringify(x));
const field = (code, label, type = 'SINGLE_LINE_TEXT', extra = {}) => ({ code, label, type, required: false, ...extra });
function mock(autoPlace = true) {
  const fields = { a: field('a', '案件名'), b: field('b', '金額', 'NUMBER'), c: field('c', '担当者'),
    g: field('g', '経理情報', 'GROUP'), t: field('t', '明細', 'SUBTABLE', { noLabel: true, fields: { col: field('col', '品名') } }) };
  const m = makeKintoneMock({ fields, views: { views: {}, revision: '10' }, status: { enable: false, states: {}, actions: [] } }, { autoPlace });
  m.st.layout = [
    { type: 'ROW', fields: [{ type: 'LABEL', label: '<b>既存の説明</b>', size: { width: '240', height: '40' } }, { type: 'SPACER', elementId: 'space_1', size: { width: '80', height: '40' } }] },
    { type: 'ROW', fields: [{ type: 'SINGLE_LINE_TEXT', code: 'a', size: { width: '250' } }, { type: 'NUMBER', code: 'b', size: { width: '190' } }] },
    { type: 'GROUP', code: 'g', layout: [{ type: 'ROW', fields: [{ type: 'SINGLE_LINE_TEXT', code: 'c', size: { width: '200' } }] }] },
    { type: 'SUBTABLE', code: 't', fields: [{ type: 'SINGLE_LINE_TEXT', code: 'col', size: { width: '160' } }] },
    { type: 'ROW', fields: [{ type: 'HR', size: { width: '400' } }] },
    { type: 'ROW', fields: [] }
  ];
  return m;
}
const definition = (id = 'F1', code = 'new_field') => ({ temporaryId: id, suggestedCode: code, label: code === 'new_field' ? '経理担当者' : '経理確認日', type: 'SINGLE_LINE_TEXT', required: false });
const operation = (position = 'AFTER_FIELD', anchor = 'b', extra = {}) => ({ id: 'P1', actionType: 'ADD_FIELD', targetRef: 'F1', title: '経理担当者を追加', spec: { placement: { position, anchor } }, dependsOn: [], ...extra });
const prep = async (m, operations = [operation()], proposedFields = [definition()], flags = {}) => P.prepareOperations({ appId: '310', operations, proposedFields, requireFieldPlacement: true, ...flags }, { api: m.api, current: await m.current() });
const writes = m => m.calls.filter(x => !x.startsWith('GET'));
function where(rows, code) {
  for (let row = 0; row < rows.length; row++) {
    const node = rows[row], column = (node.fields || []).findIndex(x => x.code === code);
    if (column >= 0) return { rows, row, column, node };
    if (node.layout) { const inner = where(node.layout, code); if (inner) return inner; }
  }
  return null;
}
for (const autoPlace of [true, false]) for (const [position, anchor, check] of [
  ['BEFORE_ROW', 'b', rows => where(rows, 'new_field').row + 1 === where(rows, 'b').row],
  ['AFTER_ROW', 'b', rows => where(rows, 'new_field').row === where(rows, 'b').row + 1],
  ['BEFORE_FIELD', 'b', rows => where(rows, 'new_field').node === where(rows, 'b').node && where(rows, 'new_field').column + 1 === where(rows, 'b').column],
  ['AFTER_FIELD', 'b', rows => where(rows, 'new_field').node === where(rows, 'b').node && where(rows, 'new_field').column === where(rows, 'b').column + 1],
  ['GROUP_END', 'g', rows => where(rows, 'new_field').rows === rows[2].layout && where(rows, 'new_field').row === rows[2].layout.length - 1],
  ['FORM_END', '', rows => where(rows, 'new_field').row === rows.length - 1],
  ['AFTER_FIELD', 'c', rows => where(rows, 'new_field').node === where(rows, 'c').node && where(rows, 'new_field').column === 1],
  ['BEFORE_ROW', 't', rows => where(rows, 'new_field').row + 1 === rows.findIndex(r => r.code === 't')],
  ['AFTER_ROW', 'g', rows => where(rows, 'new_field').row === rows.findIndex(r => r.code === 'g') + 1],
]) {
  test(position + ' ' + anchor + ', kintone auto placement ' + autoPlace, async () => {
    const m = mock(autoPlace), original = clone(m.st.layout), p = await prep(m, [operation(position, anchor)]);
    assert.equal(p.status, 'PREPARED', JSON.stringify(p.blockers));
    assert.equal(writes(m).length, 0);
    assert.equal(p.steps[0].prepared.placement.position, position);
    assert.ok(p.steps[0].prepared.placementDescription.endsWith('配置します。'));
    const e = await P.executePreview(p, { api: m.api });
    assert.equal(e.status, 'DONE', JSON.stringify(e.steps));
    assert.ok(check(m.st.layout), 'new field is at the approved position');
    assert.deepEqual(m.st.layout[0], original[0], 'label HTML, spacer ID and size are unchanged');
    const rb = await P.prepareRollback(e, p, { api: m.api });
    assert.equal(rb.status, 'PREPARED', JSON.stringify(rb.blockers));
    await P.executeRollback(rb, { api: m.api, execution: e });
    assert.equal(rb.status, 'ROLLED_BACK_VERIFIED', JSON.stringify(rb.steps));
    assert.deepEqual(m.st.layout, original, 'undo removes only the addition, preserving existing empty rows');
    assert.equal(m.st.prodRevision, 10);
  });
}
test('new fields form a dependency chain, with typed temporary IDs', async () => {
  const m = mock(), original = clone(m.st.layout);
  const operations = [operation('AFTER_FIELD', 'F1', { id: 'P2', targetRef: 'F2', dependsOn: ['P1'] }), operation()];
  const p = await prep(m, operations, [definition(), definition('F2', 'new_second')]);
  assert.equal(p.status, 'PREPARED', JSON.stringify(p.blockers));
  assert.deepEqual(clone(p.steps.map(x => x.stepId)), ['P1', 'P2']);
  assert.equal(p.steps[1].prepared.placement.anchor, 'new_field');
  const e = await P.executePreview(p, { api: m.api });
  assert.equal(e.status, 'DONE', JSON.stringify(e.steps));
  assert.deepEqual(where(m.st.layout, 'b').node.fields.map(x => x.code), ['a', 'b', 'new_field', 'new_second']);
  const rb = await P.prepareRollback(e, p, { api: m.api }); await P.executeRollback(rb, { api: m.api, execution: e });
  assert.equal(rb.status, 'ROLLED_BACK_VERIFIED', JSON.stringify(rb.steps)); assert.deepEqual(m.st.layout, original);
});
for (const [name, operations, fields, extra] of [
  ['missing placement', [{ ...operation(), spec: {} }]],
  ['unknown position', [operation('SIDEWAYS', 'a')]],
  ['missing anchor', [operation('AFTER_ROW', 'missing')]],
  ['form end with an anchor', [operation('FORM_END', 'a')]],
  ['group end with ordinary field', [operation('GROUP_END', 'a')]],
  ['same row at a group', [operation('AFTER_FIELD', 'g')]],
  ['same row at a table', [operation('BEFORE_FIELD', 't')]],
  ['above table column', [operation('BEFORE_ROW', 'col')]],
  ['self reference', [operation('AFTER_FIELD', 'F1')]],
  ['unexecuted new anchor', [operation('AFTER_FIELD', 'F2')], [definition(), definition('F2', 'new_second')]],
  ['new anchor without dependency', [operation(), operation('AFTER_FIELD', 'F1', { id: 'P2', targetRef: 'F2' })], [definition(), definition('F2', 'new_second')]],
  ['new anchor dependency cycle', [operation('AFTER_FIELD', 'F2', { dependsOn: ['P2'] }), operation('AFTER_FIELD', 'F1', { id: 'P2', targetRef: 'F2', dependsOn: ['P1'] })], [definition(), definition('F2', 'new_second')]],
  ['unsupported placement property', [{ ...operation(), spec: { placement: { position: 'AFTER_FIELD', anchor: 'a', width: 999 } } }]],
]) {
  test('invalid placement blocks before a field POST: ' + name, async () => {
    const m = mock(), p = await prep(m, operations, fields || [definition()], extra || {});
    assert.equal(p.status, 'BLOCKED', JSON.stringify(p.steps)); assert.equal(writes(m).length, 0);
  });
}
test('legacy caller without explicit placement keeps its existing append behavior', async () => {
  const m = mock(false), p = await prep(m, [{ ...operation(), spec: {} }], [definition()], { requireFieldPlacement: false });
  assert.equal(p.status, 'PREPARED');
  const e = await P.executePreview(p, { api: m.api }); assert.equal(e.status, 'DONE');
  assert.equal(where(m.st.layout, 'new_field').row, m.st.layout.length - 1);
});
test('duplicate anchor locations are not guessed', async () => {
  const m = mock(); m.st.layout.push({ type: 'ROW', fields: [{ type: 'NUMBER', code: 'b' }] });
  const p = await prep(m); assert.equal(p.status, 'BLOCKED'); assert.equal(writes(m).length, 0);
});
test('changing approved placement or expected layout is rejected without writes', async () => {
  for (const change of ['placement', 'layout']) {
    const m = mock(), p = await prep(m);
    if (change === 'placement') p.steps[0].prepared.placement.anchor = 'a'; else p.steps[0].prepared.layoutAfter.reverse();
    await assert.rejects(() => P.executePreview(p, { api: m.api }), e => e.code === 'PREPARED_CHANGED');
    assert.equal(writes(m).length, 0);
  }
});
test('form change before the field POST is rejected by its expected revision', async () => {
  const m = mock(), p = await prep(m); m.st.layout.reverse(); m.st.revision++;
  const changed = clone(m.st.layout), e = await P.executePreview(p, { api: m.api });
  assert.equal(e.status, 'FAILED'); assert.equal(m.st.fields.new_field, undefined); assert.deepEqual(m.st.layout, changed);
});
test('change between field POST and layout GET stops without overwriting, and rollback preserves it', async () => {
  const m = mock(), p = await prep(m), post = m.api.addPreviewFields;
  m.api.addPreviewFields = async (...args) => {
    const r = await post(...args); m.st.layout[0].fields[0].label = '別の担当者が更新した説明'; m.st.revision++; return r;
  };
  const e = await P.executePreview(p, { api: m.api });
  assert.equal(e.status, 'FAILED'); assert.ok(e.steps[0].partial);
  assert.equal(m.calls.filter(x => x === 'PUT layout').length, 0); assert.ok(m.st.fields.new_field);
  const changed = clone(m.st.layout); changed.splice(where(changed, 'new_field').row, 1);
  const rb = await P.prepareRollback(e, p, { api: m.api }); assert.equal(rb.status, 'PREPARED');
  await P.executeRollback(rb, { api: m.api, execution: e });
  assert.equal(rb.status, 'ROLLED_BACK_VERIFIED'); assert.deepEqual(m.st.layout, changed);
});
test('layout PUT failure records the created field and permits removing only that field', async () => {
  const m = mock(), before = clone(m.st.layout), p = await prep(m); m.ctl.failPut = 'layout';
  const e = await P.executePreview(p, { api: m.api }); assert.equal(e.status, 'FAILED'); assert.ok(e.steps[0].partial);
  m.ctl.failPut = null; const rb = await P.prepareRollback(e, p, { api: m.api });
  await P.executeRollback(rb, { api: m.api, execution: e }); assert.equal(rb.status, 'ROLLED_BACK_VERIFIED'); assert.deepEqual(m.st.layout, before);
});
for (const mutation of ['wrong-position', 'label-content', 'element-id', 'drop-field']) {
  test('readback rejects ' + mutation + ' after layout write', async () => {
    const m = mock(), p = await prep(m), put = m.api.putPreviewLayout;
    m.api.putPreviewLayout = async (...args) => {
      const r = await put(...args);
      if (mutation === 'wrong-position') { const at = where(m.st.layout, 'new_field'); const [f] = at.node.fields.splice(at.column, 1); m.st.layout.push({ type: 'ROW', fields: [f] }); }
      if (mutation === 'label-content') m.st.layout[0].fields[0].label = '消えた説明';
      if (mutation === 'element-id') m.st.layout[0].fields[1].elementId = 'different';
      if (mutation === 'drop-field') { const at = where(m.st.layout, 'a'); at.node.fields.splice(at.column, 1); }
      return r;
    };
    const e = await P.executePreview(p, { api: m.api });
    assert.equal(e.status, 'FAILED'); assert.equal(e.steps[0].status, 'VERIFY_FAILED');
  });
}
test('kintone size normalization does not reject a correctly placed field', async () => {
  const m = mock(), p = await prep(m), put = m.api.putPreviewLayout;
  m.api.putPreviewLayout = async (...args) => { const r = await put(...args); where(m.st.layout, 'new_field').node.fields.find(f => f.code === 'new_field').size = { width: '215' }; return r; };
  const e = await P.executePreview(p, { api: m.api }); assert.equal(e.status, 'DONE');
});
for (const change of ['order', 'label', 'width']) test('rollback does not overwrite a later form ' + change + ' change', async () => {
  const m = mock(), p = await prep(m), e = await P.executePreview(p, { api: m.api });
  if (change === 'order') m.st.layout.reverse();
  if (change === 'label') m.st.layout[0].fields[0].label = '編集後';
  if (change === 'width') where(m.st.layout, 'a').node.fields[0].size.width = '300';
  m.st.revision++; const changed = clone(m.st.layout), count = writes(m).length;
  const rb = await P.prepareRollback(e, p, { api: m.api });
  assert.equal(rb.status, 'BLOCKED'); assert.equal(rb.steps[0].reason, 'LAYOUT_CHANGED');
  assert.equal(writes(m).length, count); assert.deepEqual(m.st.layout, changed); assert.ok(m.st.fields.new_field);
});
test('rollback checks again after its confirmation', async () => {
  const m = mock(), p = await prep(m), e = await P.executePreview(p, { api: m.api }), rb = await P.prepareRollback(e, p, { api: m.api });
  m.st.layout[0].fields[0].label = '確認後の変更'; m.st.revision++; const count = writes(m).length;
  await P.executeRollback(rb, { api: m.api, execution: e });
  assert.equal(rb.status, 'ROLLBACK_FAILED'); assert.equal(writes(m).length, count); assert.ok(m.st.fields.new_field);
});

for (const autoPlace of [true, false]) for (const position of ['BEFORE_FIELD', 'AFTER_FIELD']) test('existing table column ' + position + ', auto placement ' + autoPlace, async () => {
  const m = mock(autoPlace), originalFields = clone(m.st.fields), originalLayout = clone(m.st.layout);
  const p = await prep(m, [operation(position, 'col')]);
  assert.equal(p.status, 'PREPARED', JSON.stringify(p.blockers));
  const prepared = p.steps[0].prepared;
  assert.equal(prepared.expect.subtable, 't');
  assert.match(prepared.placementDescription, /テーブル「明細」/);
  assert.deepEqual(Object.keys(prepared.payload.properties), ['t']);
  assert.equal(prepared.payload.properties.t.label, '明細');
  assert.equal(prepared.payload.properties.t.noLabel, true);
  assert.deepEqual(Object.keys(prepared.payload.properties.t.fields), ['new_field']);
  const e = await P.executePreview(p, { api: m.api });
  assert.equal(e.status, 'DONE', JSON.stringify(e.steps));
  assert.equal(m.st.fields.new_field, undefined, 'new column must not become a top-level field');
  assert.equal(m.st.fields.t.fields.new_field.code, 'new_field');
  assert.deepEqual(where(m.st.layout, 'col').node.fields.map(f => f.code), position === 'AFTER_FIELD' ? ['col', 'new_field'] : ['new_field', 'col']);
  const deleteCodes = [], del = m.api.deletePreviewFields;
  m.api.deletePreviewFields = async (app, codes, revision) => { deleteCodes.push(...codes); return del(app, codes, revision); };
  const rb = await P.prepareRollback(e, p, { api: m.api });
  assert.equal(rb.status, 'PREPARED', JSON.stringify(rb.blockers));
  await P.executeRollback(rb, { api: m.api, execution: e });
  assert.equal(rb.status, 'ROLLED_BACK_VERIFIED', JSON.stringify(rb.steps));
  assert.deepEqual(deleteCodes, ['new_field'], 'never delete the table to undo a new column');
  assert.deepEqual(m.st.fields, originalFields); assert.deepEqual(m.st.layout, originalLayout);
});

test('temporary column IDs chain within one table and readback tolerates API defaults on previous additions', async () => {
  const m = mock(), original = clone({ fields: m.st.fields, layout: m.st.layout });
  const operations = [operation('AFTER_FIELD', 'F1', { id: 'P2', targetRef: 'F2', dependsOn: ['P1'] }), operation('AFTER_FIELD', 'col')];
  const p = await prep(m, operations, [definition(), definition('F2', 'new_second')]);
  assert.equal(p.status, 'PREPARED', JSON.stringify(p.blockers));
  assert.equal(p.steps[1].prepared.expect.subtable, 't');
  const post = m.api.addPreviewFields;
  m.api.addPreviewFields = async (...args) => { const r = await post(...args); for (const f of Object.values(m.st.fields.t.fields)) if (f.code.startsWith('new_')) f.defaultValue = ''; return r; };
  const e = await P.executePreview(p, { api: m.api }); assert.equal(e.status, 'DONE', JSON.stringify(e.steps));
  assert.deepEqual(where(m.st.layout, 'col').node.fields.map(f => f.code), ['col', 'new_field', 'new_second']);
  const rb = await P.prepareRollback(e, p, { api: m.api }); assert.equal(rb.status, 'PREPARED', JSON.stringify(rb.blockers));
  await P.executeRollback(rb, { api: m.api, execution: e });
  assert.equal(rb.status, 'ROLLED_BACK_VERIFIED', JSON.stringify(rb.steps));
  assert.deepEqual({ fields: m.st.fields, layout: m.st.layout }, original);
});

for (const type of ['USER_SELECT', 'ORGANIZATION_SELECT', 'GROUP_SELECT', 'DATE', 'NUMBER']) test('table supports permitted field type ' + type, async () => {
  const m = mock(), p = await prep(m, [operation('AFTER_FIELD', 'col')], [{ ...definition(), type }]);
  assert.equal(p.status, 'PREPARED', JSON.stringify(p.blockers));
  const e = await P.executePreview(p, { api: m.api }); assert.equal(e.status, 'DONE', JSON.stringify(e.steps));
  assert.equal(m.st.fields.t.fields.new_field.type, type);
});

test('mismatched layout and field membership blocks before POST', async () => {
  const m = mock(); const table = m.st.layout.find(r => r.type === 'SUBTABLE');
  table.fields.push({ type: 'NUMBER', code: 'b' }); m.st.layout[1].fields.pop();
  const p = await prep(m, [operation('AFTER_FIELD', 'b')]);
  assert.equal(p.status, 'BLOCKED'); assert.equal(writes(m).length, 0);
});

test('a nested code collision is not converted into a top-level field', async () => {
  const m = mock(), p = await prep(m, [operation('AFTER_FIELD', 'b')], [definition('F1', 'col')]);
  assert.equal(p.status, 'BLOCKED'); assert.equal(writes(m).length, 0);
});

for (const mutation of ['change-existing-column', 'drop-existing-column', 'wrong-parent']) test('nested readback rejects ' + mutation, async () => {
  const m = mock(), p = await prep(m, [operation('BEFORE_FIELD', 'col')]), post = m.api.addPreviewFields;
  m.api.addPreviewFields = async (...args) => {
    const r = await post(...args);
    if (mutation === 'change-existing-column') m.st.fields.t.fields.col.label = '勝手に変更';
    if (mutation === 'drop-existing-column') delete m.st.fields.t.fields.col;
    if (mutation === 'wrong-parent') { m.st.fields.new_field = m.st.fields.t.fields.new_field; delete m.st.fields.t.fields.new_field; }
    return r;
  };
  const e = await P.executePreview(p, { api: m.api }); assert.equal(e.status, 'FAILED', JSON.stringify(e.steps));
  assert.notEqual(e.steps[0].status, 'DONE');
});

test('table column revision changes before creation do not write', async () => {
  const m = mock(), p = await prep(m, [operation('AFTER_FIELD', 'col')]);
  m.st.fields.t.fields.col.label = 'ほかの人の更新'; m.st.revision++;
  const e = await P.executePreview(p, { api: m.api }); assert.equal(e.status, 'FAILED');
  assert.equal(writes(m).length, 0); assert.equal(m.st.fields.t.fields.new_field, undefined);
});

test('table layout failure can roll back only the newly created column', async () => {
  const m = mock(), original = clone({ fields: m.st.fields, layout: m.st.layout }), p = await prep(m, [operation('BEFORE_FIELD', 'col')]);
  m.ctl.failPut = 'layout'; const e = await P.executePreview(p, { api: m.api });
  assert.equal(e.status, 'FAILED'); assert.ok(e.steps[0].partial); assert.ok(m.st.fields.t.fields.new_field);
  m.ctl.failPut = null; const rb = await P.prepareRollback(e, p, { api: m.api });
  await P.executeRollback(rb, { api: m.api, execution: e }); assert.equal(rb.status, 'ROLLED_BACK_VERIFIED', JSON.stringify(rb.steps));
  assert.deepEqual({ fields: m.st.fields, layout: m.st.layout }, original);
});

test('rollback detects a later changed column definition', async () => {
  const m = mock(), p = await prep(m, [operation('AFTER_FIELD', 'col')]), e = await P.executePreview(p, { api: m.api });
  assert.equal(e.status, 'DONE'); m.st.fields.t.fields.new_field.label = 'ほかの人が変更'; m.st.revision++;
  const rb = await P.prepareRollback(e, p, { api: m.api }); assert.equal(rb.status, 'BLOCKED');
  assert.equal(rb.steps[0].reason, 'FIELD_CHANGED'); assert.ok(m.st.fields.t.fields.new_field);
});

test('rollback sees references from sibling table columns rather than treating membership as a reference', async () => {
  const m = mock(), p = await prep(m, [operation('AFTER_FIELD', 'col')]), e = await P.executePreview(p, { api: m.api });
  assert.equal(e.status, 'DONE');
  m.st.fields.t.fields.col.type = 'CALC'; m.st.fields.t.fields.col.expression = 'new_field'; m.st.revision++;
  const rb = await P.prepareRollback(e, p, { api: m.api }); assert.equal(rb.status, 'BLOCKED');
  assert.equal(rb.steps[0].reason, 'FIELD_REFERENCED'); assert.ok(m.st.fields.t.fields.new_field);
});
