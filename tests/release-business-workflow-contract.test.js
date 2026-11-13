'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./helpers/business-fixture.js');
const { C } = F;
const VERSION = 'business-workflow-1';
const reference = (s, kind, pointer = null) => ({ evidenceId: s.evidence.find(e => e.kind === kind).evidenceId, pointer });
function workflow(s) {
  const o = F.output(s), r = o.rules[0], field = reference(s, 'field');
  o.schemaVersion = VERSION;
  r.stageName = '申請内容を確認・補完する';
  r.processStateId = reference(s, 'process_state').evidenceId;
  r.evidenceRefs.push(field);
  r.inputs = [{ kind: 'input', interpretation: '申請内容を確認して確認メモを補完する可能性があります。', evidenceRefs: [field, reference(s, 'acl_field')] }];
  r.notifications = [{ interpretation: '申請済みの条件に一致すると経理グループへの確認通知を設定しています。', evidenceRefs: [reference(s, 'notification_record')] }];
  return o;
}
const rejects = (o, s) => assert.ok(C.validateOutput(o, s).length, 'invalid workflow must not be accepted');

test('工程v1は有効プロセス・入力・通知の根拠を保持し、従来の出力も受理する', async () => {
  const { s } = await F.snapshot(), legacy = F.output(s), o = workflow(s);
  assert.deepEqual(C.validateOutput(legacy, s), []);
  assert.deepEqual(C.validateOutput(o, s), []);
  assert.equal(C.outputSchema(legacy), C.OUTPUT_SCHEMA);
  assert.deepEqual(C.outputSchema(o).properties.schemaVersion.enum, [VERSION]);
  assert.equal(C.outputSchema(o).properties.rules.maxItems, 16);
  assert.equal(C.OUTPUT_SCHEMA.properties.rules.maxItems, 8);
  const oldWithStage = F.clone(o); oldWithStage.schemaVersion = legacy.schemaVersion;
  rejects(oldWithStage, s);
  const unknown = F.clone(o); unknown.schemaVersion = 'business-workflow-999';
  rejects(unknown, s);
});

test('工程capabilityは明示したcontextだけに追加し、既存snapshotと生成対象を変えない', async () => {
  const { s } = await F.snapshot(), original = F.clone(s);
  const legacy = C.context(s), ctx = C.context(s, '工程を整理してください。', { workflow: true });
  assert.equal(legacy.clientCapabilities.includes('businessWorkflowV1'), false);
  assert.equal(ctx.clientCapabilities.includes('businessWorkflowV1'), true);
  assert.equal(ctx.clientCapabilities.includes('businessUnderstandingV1'), true);
  assert.deepEqual(ctx.businessSnapshot, original);
  assert.deepEqual(s, original);
  assert.equal(ctx.question, '工程を整理してください。');
});

test('無効プロセスしかない場合は工程表示用contextだけを許可し現行工程へ参照しない', async () => {
  const data = F.raw();
  data.process.enable = false;
  data.notification_record.notifications = [];
  data.notification_reminder.notifications = [];
  for (const key of ['acl_app', 'acl_record', 'acl_field']) data[key].rights = [];
  const { s } = await F.snapshot({ data });
  assert.equal(s.evidence.filter(C.eligible).length, 0);
  assert.ok(C.validateSnapshot(s).length);
  assert.deepEqual(C.validateSnapshot(s, { workflow: true }), []);
  assert.throws(() => C.context(s));
  assert.equal(C.context(s, '工程を整理', { workflow: true }).clientCapabilities.includes('businessWorkflowV1'), true);
  const zero = { schemaVersion: VERSION, snapshotId: s.snapshotId, rules: [], unassignedEvidence: [], noRuleReason: 'プロセス管理は無効であり、現行工程を特定できません。' };
  assert.deepEqual(C.validateOutput(zero, s), []);
  for (const e of s.evidence.filter(e => e.category === 'process')) assert.equal(C.canReference(e, zero), false);
});

test('工程ではfieldを補助引用できるが旧出力では不可、fieldに分類義務を加えない', async () => {
  const { s } = await F.snapshot(), o = workflow(s), field = s.evidence.find(e => e.kind === 'field');
  assert.equal(C.canReference(field, o), true);
  assert.equal(C.canReference(field, F.output(s)), false);
  const withoutField = F.clone(o), r = withoutField.rules[0];
  r.evidenceRefs = r.evidenceRefs.filter(ref => ref.evidenceId !== field.evidenceId);
  r.inputs = [];
  assert.deepEqual(C.validateOutput(withoutField, s), []);
  const unassignedField = F.clone(o);
  unassignedField.unassignedEvidence.push({ evidenceId: field.evidenceId, reason: 'context_only' });
  rejects(unassignedField, s);
  const missing = F.clone(o); missing.unassignedEvidence.pop(); rejects(missing, s);
  const duplicate = F.clone(o); duplicate.unassignedEvidence.push(F.clone(duplicate.unassignedEvidence[0])); rejects(duplicate, s);
});

test('工程のprocessStateIdは有効な状態・同工程の根拠を要求し、状態の重複を拒否する', async () => {
  const { s } = await F.snapshot(), o = workflow(s);
  const action = F.clone(o); action.rules[0].processStateId = reference(s, 'process_action').evidenceId; rejects(action, s);
  const field = F.clone(o); field.rules[0].processStateId = reference(s, 'field').evidenceId; rejects(field, s);
  const missing = F.clone(o); missing.rules[0].processStateId = 'B999'; rejects(missing, s);
  const omitted = F.clone(o), r = omitted.rules[0];
  r.evidenceRefs = r.evidenceRefs.filter(ref => ref.evidenceId !== r.processStateId);
  r.participants = [];
  omitted.unassignedEvidence.push({ evidenceId: r.processStateId, reason: 'context_only' });
  rejects(omitted, s);
  const duplicate = F.clone(o); duplicate.rules.push({ ...F.clone(o.rules[0]), ruleId: 'R2', stageName: '別名の同じ工程' }); rejects(duplicate, s);
  const independent = F.clone(o); independent.rules[0].processStateId = null;
  assert.deepEqual(C.validateOutput(independent, s), []);
});

test('入力・検査には入力項目や条件の根拠が必要で、通知には通知設定または取得JSが必要', async () => {
  const { s } = await F.snapshot(), o = workflow(s);
  for (const kind of ['input', 'check', 'automatic']) {
    const good = F.clone(o); good.rules[0].inputs[0].kind = kind;
    assert.deepEqual(C.validateOutput(good, s), []);
  }
  const noInputRef = F.clone(o); noInputRef.rules[0].inputs[0].evidenceRefs = []; rejects(noInputRef, s);
  const wrongInput = F.clone(o); wrongInput.rules[0].inputs[0].evidenceRefs = [reference(s, 'process_state')]; rejects(wrongInput, s);
  const noCondition = F.clone(o); noCondition.rules[0].inputs[0].evidenceRefs = [reference(s, 'process_action', '/filterCond')]; rejects(noCondition, s);
  const condition = F.clone(o); condition.rules[0].inputs[0] = { kind: 'check', interpretation: '通知条件にある金額等を確認する可能性があります。', evidenceRefs: [reference(s, 'notification_record', '/filterCond')] };
  assert.deepEqual(C.validateOutput(condition, s), []);
  const noNoticeRef = F.clone(o); noNoticeRef.rules[0].notifications[0].evidenceRefs = []; rejects(noNoticeRef, s);
  const wrongNotice = F.clone(o); wrongNotice.rules[0].notifications[0].evidenceRefs = [reference(s, 'acl_field')]; rejects(wrongNotice, s);
  const outside = F.clone(o); outside.rules[0].notifications[0].evidenceRefs = [reference(s, 'notification_reminder')]; rejects(outside, s);
  const badPointer = F.clone(o); badPointer.rules[0].inputs[0].evidenceRefs[0].pointer = '/nonexistent'; rejects(badPointer, s);
});

test('有効な通知イベント・コメント投稿者通知だけを工程の通知根拠として扱う', async () => {
  const data = F.raw();
  data.notification_general.notifications = [{ entity: { type: 'GROUP', code: 'accounting' }, includeSubs: false, recordAdded: true, recordEdited: false, commentAdded: false, statusChanged: false, fileImported: false }];
  data.notification_general.notifyToCommenter = true;
  const { s } = await F.snapshot({ data });
  for (const kind of ['notification_general', 'comment_notification']) {
    const o = workflow(s), ref = reference(s, kind), e = s.evidence.find(e => e.kind === kind);
    o.rules[0].evidenceRefs.push(ref);
    o.rules[0].notifications.push({ interpretation: '設定された条件で通知する想定です。', evidenceRefs: [ref] });
    o.unassignedEvidence = o.unassignedEvidence.filter(x => x.evidenceId !== ref.evidenceId);
    assert.deepEqual(C.validateOutput(o, s), []);
    const disabled = F.clone(s), setting = disabled.evidence.find(x => x.evidenceId === e.evidenceId);
    if (kind === 'comment_notification') setting.value.notifyToCommenter = false;
    else setting.value.recordAdded = false;
    rejects(o, disabled);
  }
});

test('無効・未取得JSとプラグインは現行工程の根拠にせず、取得JSには確認事項を残す', async () => {
  const data = F.raw();
  data.javascript.desktop.js = [{ type: 'FILE', file: { name: 'workflow.js', fileKey: 'fixture-file', size: '100' } }];
  data.plugins.plugins = [{ id: 'enabled', name: '工程補助', enabled: true }, { id: 'disabled', name: '旧通知', enabled: false }];
  const { s } = await F.snapshot({ data, download: async () => "kintone.events.on('app.record.edit.submit', e => { e.record.memo.value = '確認'; return e; });" });
  const o = workflow(s), js = s.evidence.find(e => e.kind === 'javascript'), ref = { evidenceId: js.evidenceId, pointer: '/text' };
  o.rules[0].evidenceRefs.push(ref);
  o.rules[0].inputs.push({ kind: 'automatic', interpretation: '編集保存時に確認メモを補完するコードです。実行結果は未確認です。', evidenceRefs: [ref] });
  o.unassignedEvidence = o.unassignedEvidence.filter(x => x.evidenceId !== js.evidenceId);
  assert.deepEqual(C.validateOutput(o, s), []);
  const noQuestion = F.clone(o); noQuestion.rules[0].questions = []; rejects(noQuestion, s);
  assert.equal(C.canReference(s.evidence.find(e => e.value.name === '旧通知'), o), false);
  assert.equal(C.canReference({ ...js, active: false, value: { ...js.value, scope: 'NONE' } }, o), false);
  assert.equal(C.canReference({ ...js, value: { ...js.value, bodyStatus: 'failed', text: null } }, o), false);
  const inactive = F.clone(s), inactiveJs = inactive.evidence.find(e => e.evidenceId === js.evidenceId);
  inactiveJs.active = false; inactiveJs.value.scope = 'NONE'; rejects(o, inactive);
});

test('工程は16件を上限にし、12000文字を超える説明を拒否する', async () => {
  const { s } = await F.snapshot(), o = workflow(s), r = F.clone(o.rules[0]);
  r.processStateId = null; r.participants = []; r.inputs = []; r.notifications = []; r.questions = [];
  r.inference = 'あ'.repeat(600); r.reasoning = '根拠'; r.trigger.interpretation = '入る条件'; r.nextAction.interpretation = '進む条件';
  o.rules = Array.from({ length: 16 }, (_, i) => ({ ...F.clone(r), ruleId: 'R' + (i + 1), stageName: '工程' + (i + 1) }));
  assert.deepEqual(C.validateOutput(o, s), []);
  const tooMany = F.clone(o); tooMany.rules.push({ ...F.clone(r), ruleId: 'R17', stageName: '工程17' }); rejects(tooMany, s);
  const tooLong = F.clone(o); for (const rule of tooLong.rules) rule.reasoning = 'い'.repeat(200); rejects(tooLong, s);
  const stageName = F.clone(o); stageName.rules[0].stageName = 'あ'.repeat(121); rejects(stageName, s);
});

test('一部工程の相談では元IDと部分根拠を受理し、根拠・工程・入力の検証を緩めない', async () => {
  const { s } = await F.snapshot(), o = workflow(s);
  o.rules[0].ruleId = 'R7';
  o.unassignedEvidence = [];
  rejects(o, s);
  assert.deepEqual(C.validateOutput(o, s, { partial: true }), []);
  for (const mutate of [
    x => { x.rules[0].inputs[0].evidenceRefs = []; },
    x => { x.rules[0].notifications[0].evidenceRefs = [reference(s, 'acl_field')]; },
    x => { x.rules[0].processStateId = reference(s, 'field').evidenceId; },
    x => { x.rules[0].evidenceRefs[0].evidenceId = 'B999'; },
    x => { x.rules.push(F.clone(x.rules[0])); },
    x => { x.rules[0].ruleId = 'R0'; }
  ]) {
    const bad = F.clone(o); mutate(bad);
    assert.ok(C.validateOutput(bad, s, { partial: true }).length);
  }
  const disabled = F.clone(s); disabled.evidence.find(e => e.evidenceId === o.rules[0].processStateId).active = false;
  assert.ok(C.validateOutput(o, disabled, { partial: true }).length);
});

test('fieldの必須指定と計算式を補助根拠として保持し、不正型を受け入れない', () => {
  const field = { code: 'memo', label: '確認メモ', type: 'SINGLE_LINE_TEXT', required: true, expression: 'IF(flag = "はい", "要確認", "")' };
  assert.deepEqual(C.project('field', field), field);
  assert.deepEqual(C.project('field', { code: 'memo', label: '確認メモ', type: 'SINGLE_LINE_TEXT' }), { code: 'memo', label: '確認メモ', type: 'SINGLE_LINE_TEXT' });
  assert.throws(() => C.project('field', { ...field, required: 'true' }));
  assert.throws(() => C.project('field', { ...field, expression: {} }));
});
