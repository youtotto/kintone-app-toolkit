// KTPlanExecutor Phase 11: Rollback Executor（動作テスト環境を実行前 snapshot へ戻す）
//
// 検証内容（§40〜42）:
//   §40 8 action の rollback: ADD_FIELD（add → verify → rollback → absent）/ ADD_VIEW / ADD_NOTIFICATION / UPDATE_NOTIFICATION / ADD_REMINDER /
//       UPDATE_REMINDER / UPDATE_FIELD（required → 戻す）/ UPDATE_VIEW、逆 DAG 順、ROLLED_BACK_VERIFIED、snapshot との全体比較、audit.rollback
//   §41 rollback stale: 実行後に人間が同じ集合を変更 → ROLLBACK_STALE で止め、第三者変更を消さない。別の集合の変更は warning（触らない）。
//       追加フィールドが参照された / 変更された → 削除しない。準備 → 実行の間の変更も止める。revision 不一致は再試行しない
//   §42 partial rollback: 途中失敗した実行は反映済みの step だけ逆順に戻す。rollback が途中で失敗したらそれ以前へ進まない（一部の変更だけ元に戻りました）
//
// 実行方法: node tests/ai-plan-executor-rollback.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { KTDeps, KTPlanReview, KTPlanExecutor } = loadToolkit();
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const E = KTPlanExecutor, R = KTPlanReview;

const clone = (v) => JSON.parse(JSON.stringify(v));
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], ...o });
const step = (id, actionType, targetKind, targetRef, sp = {}, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PREVIEW_SUPPORTED', supported: true, reason: 'x' }, ...extra });
const pf = (temporaryId, label, suggestedCode, type, extra = {}) => ({ temporaryId, label, suggestedCode, type, typeValid: true, required: false, options: [], reason: '', evidenceIds: [], alternativeExistingFieldCode: null, codeConflict: false, labelDuplicate: false, ...extra });
const plan = (steps, proposedFields = [], extra = {}) => ({ planVersion: '1', requestId: 'tk-rb', goal: 'g', assessment: { summary: '' }, relevantFields: [], proposedFields, steps, alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', ...extra });

const DATA = FX.makeData();
const DEPS = KTDeps.buildDependencyData(DATA, KTDeps.normalizeFields(DATA.fields));
const reviewOf = (p, data = DATA) => R.review({ plan: p, data, deps: data === DATA ? DEPS : null, scan: null, incoming: null });
const approveAll = (p, rv) => R.executorOutput(p, rv, p.steps.map(s => s.id));
/** 計画 → Review → prepare → 実行 → （between）→ rollback 準備 → 実行。各段階の結果を返す */
async function flow(p, mock, { data = DATA, between = null, betweenRollback = null, skipRollback = false } = {}) {
  const rv = reviewOf(p, data);
  const prepared = await E.prepare(approveAll(p, rv), { api: mock.api, appId: '341' });
  const log = prepared.status === 'PREPARED' ? await E.executePreview(prepared, { api: mock.api, review: rv, data }) : null;
  if (between) between(log, prepared);
  const rb = log && !skipRollback ? await E.prepareRollback(log, prepared, { api: mock.api }) : null;
  if (rb && betweenRollback) betweenRollback(rb);
  const rolled = rb && rb.status === 'PREPARED' ? await E.executeRollback(rb, { api: mock.api, execution: log }) : null;
  return { rv, prepared, log, rb, rolled };
}
const snapOf = (mock) => clone({ fields: mock.st.fields, layout: mock.st.layout, views: mock.st.views, general: mock.st.general, notifyToCommenter: mock.st.notifyToCommenter, perRecord: mock.st.perRecord, reminders: mock.st.reminders, timezone: mock.st.timezone });
const sameAsSnap = (mock, snap) => JSON.stringify(snapOf(mock)) === JSON.stringify(snap);
const statuses = (rb) => rb.steps.map(s => `${s.stepId}:${s.status}`).join(' ');

(async () => {
console.log('\n--- 1. §40 Rollback — ADD 系 ---');
{
  // ADD_FIELD: add → verify → rollback → absent（レイアウトも snapshot へ）
  const p = plan([step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1')], [pf('NEW_FIELD_1', '進捗メモ', 'progress_memo', 'SINGLE_LINE_TEXT')]);
  const mock = makeKintoneMock(DATA); const snap = snapOf(mock);
  const { log, rb, rolled } = await flow(p, mock);
  assert(log.status === 'DONE' && log.actualAfterRaw && log.actualAfterRaw.fields.properties.progress_memo && log.snapshot && !log.snapshot.fields.properties.progress_memo, '前提: 反映済み・実行ログに実行前 snapshot と反映直後の設定（actualAfterRaw）がある');
  assert(rolled === rb && rb.steps.length === 1 && rb.steps[0].actionType === 'DELETE_FIELD' && rb.steps[0].collection === 'fields' && rb.steps[0].target === 'progress_memo' && rb.steps[0].sourceActionType === 'ADD_FIELD' && !rb.warnings.length && !rb.blockers.length && rb.stale.status === 'FRESH', 'prepareRollback: DELETE_FIELD 1 件・stale なし・警告なし（準備の結果を実行が引き継ぐ）');
  assert(rolled.status === 'ROLLED_BACK_VERIFIED' && rolled.steps[0].status === 'ROLLBACK_VERIFIED' && !mock.st.fields.progress_memo && sameAsSnap(mock, snap), 'executeRollback: フィールドが消え、設定全体が実行前と一致（ROLLED_BACK_VERIFIED）');
  assert(rolled.steps[0].requests[0].method === 'DELETE' && mock.calls.filter(c => c === 'DELETE fields').length === 1 && rolled.steps[0].verification.checks.every(c => c.ok) && ['fieldAbsent', 'otherFieldsPreserved', 'layoutFieldRemoved', 'layoutRestored'].every(n => rolled.steps[0].verification.checks.find(c => c.name === n)), 'DELETE は 1 回・検証項目 fieldAbsent / otherFieldsPreserved / layoutFieldRemoved / layoutRestored');
  assert(rolled.verification.restoredToSnapshot === true && rolled.verification.diffs.length === 0 && rolled.message === '動作テスト環境を実行前の状態に戻しました。', '§31: 現在の preview == 実行前 snapshot');
  assert(log.rollback === rolled && log.lifecycle === 'ROLLED_BACK_VERIFIED' && log.steps[0].rollbackStatus === 'ROLLBACK_VERIFIED', 'lifecycle: 実行ログに rollback の結果と step の rollbackStatus');
  const audit = E.buildAudit({ plan: p, prepared: null, execution: log, rollback: rolled });
  assert(audit.auditVersion === '2' && audit.rollback && audit.rollback.requestedAt && audit.rollback.status === 'ROLLED_BACK_VERIFIED' && audit.rollback.steps.length === 1 && audit.rollback.verification.restoredToSnapshot === true && audit.afterSnapshot && !audit.execution.actualAfterRaw && !audit.execution.rollback, 'Audit: rollback { requestedAt, status, steps, verification }・afterSnapshot（反映直後）・execution 内に重複を持たない');
  // 2 回目の rollback はできない
  const again = await E.prepareRollback(log, (await E.prepare(approveAll(p, reviewOf(p)), { api: mock.api, appId: '341' })), { api: mock.api });
  assert(again.status === 'BLOCKED' && again.blockers[0].code === 'INVALID_INPUT', '別の prepare との組は INVALID_INPUT');
}
{
  // ADD_FIELD（レイアウトを自分で追加した場合 = autoPlace false）→ rollback でレイアウトも snapshot へ
  const p = plan([step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1')], [pf('NEW_FIELD_1', '進捗メモ', 'progress_memo', 'SINGLE_LINE_TEXT')]);
  const mock = makeKintoneMock(DATA, { autoPlace: false }); const snap = snapOf(mock);
  const { log, rolled } = await flow(p, mock);
  assert(log.steps[0].requests.some(r => r.placement === 'APPENDED_ROW') && rolled.status === 'ROLLED_BACK_VERIFIED' && sameAsSnap(mock, snap), 'APPENDED_ROW の場合もレイアウトを含めて実行前と一致');
}
{
  // ADD_VIEW: add → rollback → original views（id も保持）
  const p = plan([step('P1', 'ADD_VIEW', 'VIEW', '進捗一覧', { name: '進捗一覧', fields: ['case_name', 'owner'], sort: 'due_date asc' })]);
  const mock = makeKintoneMock(DATA); const snap = snapOf(mock);
  const { rb, rolled } = await flow(p, mock);
  assert(rb.steps[0].actionType === 'RESTORE_VIEWS' && rolled.status === 'ROLLED_BACK_VERIFIED' && !mock.st.views['進捗一覧'] && sameAsSnap(mock, snap) && rolled.steps[0].requests[0].method === 'PUT' && rolled.verification.restoredToSnapshot === true, 'ADD_VIEW → RESTORE_VIEWS: 一覧が実行前と一致（id 含む）');
}
{
  // ADD_NOTIFICATION（perRecord）: add → rollback → original notifications
  const p = plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', '担当者設定通知', { name: '担当者設定通知', targets: ['FIELD_ENTITY:owner'], filterCond: 'owner not in ("")' })]);
  const mock = makeKintoneMock(DATA); const snap = snapOf(mock);
  const { log, rb, rolled } = await flow(p, mock);
  assert(log.status === 'DONE' && mock.calls.filter(c => c === 'PUT perRecord').length === 2 && rb.steps[0].actionType === 'RESTORE_NOTIFICATION_SETTINGS' && rb.steps[0].collection === 'perRecordNotify' && rolled.status === 'ROLLED_BACK_VERIFIED' && mock.st.perRecord.length === 2 && sameAsSnap(mock, snap), 'ADD_NOTIFICATION → RESTORE_NOTIFICATION_SETTINGS: 2 件に戻る');
  // アプリの条件通知（general）: notifyToCommenter も保持
  const p2 = plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', 'x', { name: 'x', targets: ['FIELD_ENTITY:owner_group'], events: ['recordAdded'] })]);
  const m2 = makeKintoneMock(DATA); const snap2 = snapOf(m2);
  const r2 = await flow(p2, m2);
  assert(r2.rb.steps[0].collection === 'generalNotify' && r2.rolled.status === 'ROLLED_BACK_VERIFIED' && m2.st.general.length === 5 && m2.st.notifyToCommenter === true && sameAsSnap(m2, snap2), 'general も snapshot へ（notifyToCommenter 保持）');
}
{
  // ADD_REMINDER: add → rollback
  const p = plan([step('P1', 'ADD_REMINDER', 'REMINDER', '期限30日前', { name: '期限30日前', timingField: 'due_date', daysLater: '-30', time: '09:00', targets: ['FIELD_ENTITY:owner'] })]);
  const mock = makeKintoneMock(DATA); const snap = snapOf(mock);
  const { rb, rolled } = await flow(p, mock);
  assert(rb.steps[0].actionType === 'RESTORE_REMINDER_SETTINGS' && rolled.status === 'ROLLED_BACK_VERIFIED' && mock.st.reminders.length === 1 && mock.st.timezone === 'Asia/Tokyo' && sameAsSnap(mock, snap), 'ADD_REMINDER → RESTORE_REMINDER_SETTINGS（timezone 保持）');
}

console.log('\n--- 2. §40 Rollback — UPDATE 系 ---');
{
  // UPDATE_NOTIFICATION: change → rollback → original
  const p = plan([step('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', 'perRecord#1', { targets: ['USER:user1', 'FIELD_ENTITY:approver', 'FIELD_ENTITY:owner_org', 'FIELD_ENTITY:owner'] })]);
  const mock = makeKintoneMock(DATA); const snap = snapOf(mock);
  const { log, rolled } = await flow(p, mock);
  assert(log.status === 'DONE' && rolled.status === 'ROLLED_BACK_VERIFIED' && mock.st.perRecord[0].targets.length === 3 && sameAsSnap(mock, snap), 'UPDATE_NOTIFICATION → 通知先が 3 件に戻り、全体が実行前と一致');
}
{
  // UPDATE_REMINDER: change → rollback
  const p = plan([step('P1', 'UPDATE_REMINDER', 'REMINDER', 'reminder#1', { daysLater: '-3' })]);
  const mock = makeKintoneMock(DATA); const snap = snapOf(mock);
  const { log, rolled } = await flow(p, mock);
  assert(log.status === 'DONE' && mock.st.reminders[0].timing.daysLater === '-1' && rolled.status === 'ROLLED_BACK_VERIFIED' && sameAsSnap(mock, snap), 'UPDATE_REMINDER → 日数が -1 に戻る');
}
{
  // UPDATE_FIELD: required true → rollback → false（他の属性はそのまま）
  const p = plan([step('P1', 'UPDATE_FIELD', 'FIELD', 'owner', { required: true })]);
  const mock = makeKintoneMock(DATA); const snap = snapOf(mock);
  const { log, rb, rolled } = await flow(p, mock);
  assert(log.status === 'DONE' && mock.st.fields.owner.required === false && rb.steps[0].actionType === 'RESTORE_FIELD_PROPERTY' && rolled.status === 'ROLLED_BACK_VERIFIED' && rolled.steps[0].requests[0].keys.join() === 'required' && rolled.steps[0].verification.checks.find(c => c.name === 'restored:required').ok && rolled.steps[0].verification.checks.find(c => c.name === 'otherPropertiesPreserved').ok && sameAsSnap(mock, snap), 'UPDATE_FIELD → required が false に戻り（PUT は required だけ）、他の属性は保持');
  // label + required の 2 属性
  const p2 = plan([step('P1', 'UPDATE_FIELD', 'FIELD', 'owner', { required: true, name: '担当者（必須）' })]);
  const m2 = makeKintoneMock(DATA); const snap2 = snapOf(m2);
  const r2 = await flow(p2, m2);
  assert(r2.log.status === 'DONE' && r2.rolled.status === 'ROLLED_BACK_VERIFIED' && m2.st.fields.owner.label === DATA.fields.owner.label && sameAsSnap(m2, snap2), 'UPDATE_FIELD（表示名＋必須）→ 両方戻る');
}
{
  // UPDATE_VIEW: change → rollback
  const p = plan([step('P1', 'UPDATE_VIEW', 'VIEW', '承認待ち', { fields: ['case_name', 'approver', 'amount'] })]);
  const mock = makeKintoneMock(DATA); const snap = snapOf(mock);
  const { log, rolled } = await flow(p, mock);
  assert(log.status === 'DONE' && rolled.status === 'ROLLED_BACK_VERIFIED' && mock.st.views['承認待ち'].fields.join() === 'case_name,approver' && mock.st.views['承認待ち'].id === '102' && sameAsSnap(mock, snap), 'UPDATE_VIEW → 表示項目が戻り id も保持');
}
{
  // 複合（DAG）: P1 ADD_FIELD → P2 ADD_VIEW（新規フィールドを表示）→ P3 ADD_NOTIFICATION → P4 UPDATE_NOTIFICATION（同じ perRecord）。rollback は P4 → P3 → P2 → P1 の逆順
  const p = plan([
    step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1'),
    step('P2', 'ADD_VIEW', 'VIEW', '進捗一覧', { name: '進捗一覧', fields: ['case_name', 'NEW_FIELD_1'] }, { dependsOn: ['P1'] }),
    step('P3', 'ADD_NOTIFICATION', 'NOTIFICATION', '担当者設定通知', { name: '担当者設定通知', targets: ['FIELD_ENTITY:owner'], filterCond: 'owner not in ("")' }, { dependsOn: ['P2'] }),
    step('P4', 'UPDATE_NOTIFICATION', 'NOTIFICATION', 'perRecord#1', { filterCond: 'amount >= "2000000"' }, { dependsOn: ['P3'] }),
  ], [pf('NEW_FIELD_1', '進捗メモ', 'progress_memo', 'SINGLE_LINE_TEXT')]);
  const mock = makeKintoneMock(DATA); const snap = snapOf(mock);
  const { log, rb, rolled } = await flow(p, mock);
  assert(log.status === 'DONE' && log.steps.every(s => s.status === 'VERIFIED'), '前提: 4 step 反映');
  assert(rb.steps.map(s => s.stepId).join() === 'P4,P3,P2,P1' && rb.steps.map(s => s.actionType).join() === 'RESTORE_NOTIFICATION_SETTINGS,RESTORE_NOTIFICATION_SETTINGS,RESTORE_VIEWS,DELETE_FIELD', '逆 DAG 順（P4 → P3 → P2 → P1）');
  assert(rolled.status === 'ROLLED_BACK_VERIFIED' && statuses(rolled) === 'P4:ROLLBACK_VERIFIED P3:ROLLBACK_VERIFIED P2:ROLLBACK_VERIFIED P1:ROLLBACK_VERIFIED' && rolled.steps[1].reason === 'ALREADY_RESTORED' && mock.calls.filter(c => c === 'PUT perRecord').length === 3, '同じ集合（perRecord）は最初の手順で snapshot に戻り、2 つ目は ALREADY_RESTORED（PUT は実行 2 回 ＋ rollback 1 回）');
  assert(sameAsSnap(mock, snap) && rolled.verification.restoredToSnapshot === true, '全体が実行前と一致');
}

console.log('\n--- 3. §41 Rollback stale ---');
{
  // 実行後に人間が同じ集合（perRecord）を変更 → ROLLBACK_STALE。第三者変更は残る
  const p = plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', '担当者設定通知', { name: '担当者設定通知', targets: ['FIELD_ENTITY:owner'], filterCond: 'owner not in ("")' })]);
  const mock = makeKintoneMock(DATA);
  const { rb, rolled } = await flow(p, mock, { between: () => { mock.st.perRecord[0].title = '人間が変更'; } });
  assert(rb.status === 'BLOCKED' && rb.blockers[0].code === 'ROLLBACK_STALE' && rb.steps[0].status === 'ROLLBACK_STALE' && rb.steps[0].reason === 'THIRD_PARTY_CHANGE' && rb.stale.status === 'STALE' && rb.stale.diffs.some(d => d.kind === 'NOTIFICATION') && rolled === null, 'ROLLBACK_STALE: 準備で止まる（書き込みなし）・差分を人間向けに出す');
  assert(mock.st.perRecord[0].title === '人間が変更' && mock.st.perRecord.length === 3 && !mock.calls.slice(mock.calls.lastIndexOf('PUT perRecord') + 1).some(c => /^(PUT|DELETE)/.test(c)), '第三者変更を消さない・rollback の書き込みなし');
}
{
  // 実行後に人間が別の集合（一覧）を変更 → rollback 対象（通知）は変わっていないので戻せる。警告を出し、人間の一覧には触れない
  const p = plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', '担当者設定通知', { name: '担当者設定通知', targets: ['FIELD_ENTITY:owner'], filterCond: 'owner not in ("")' })]);
  const mock = makeKintoneMock(DATA);
  const { rb, rolled } = await flow(p, mock, { between: () => { mock.st.views['人間の一覧'] = { id: '555', name: '人間の一覧', type: 'LIST', index: '2', fields: ['case_name'], filterCond: '', sort: '' }; mock.st.revision += 1; } });
  assert(!rb.blockers.length && rb.warnings.some(w => w.code === 'OTHER_CHANGES_SINCE_EXECUTION') && rolled.status === 'ROLLED_BACK_VERIFIED' && mock.st.perRecord.length === 2 && mock.st.views['人間の一覧'] && rolled.verification.restoredToSnapshot === false && rolled.verification.diffs.some(d => d.kind === 'VIEW' && d.id === '人間の一覧'), '別の集合の第三者変更: 警告付きで戻せる・人間の一覧は残る・snapshot との差分として報告');
}
{
  // ADD_FIELD の後に人間がそのフィールドを一覧で参照した → 削除しない（FIELD_REFERENCED）
  const p = plan([step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1')], [pf('NEW_FIELD_1', '進捗メモ', 'progress_memo', 'SINGLE_LINE_TEXT')]);
  const mock = makeKintoneMock(DATA);
  const { rb } = await flow(p, mock, { between: () => { mock.st.views['承認待ち'].fields.push('progress_memo'); mock.st.revision += 1; } });
  assert(rb.status === 'BLOCKED' && rb.steps[0].status === 'ROLLBACK_STALE' && rb.steps[0].reason === 'FIELD_REFERENCED' && /一覧「承認待ち」の表示項目/.test(rb.steps[0].message) && mock.st.fields.progress_memo, 'FIELD_REFERENCED: 参照されたフィールドは削除しない');
  // 人間が追加フィールドの定義を変えた → FIELD_CHANGED
  const m2 = makeKintoneMock(DATA);
  const r2 = await flow(p, m2, { between: () => { m2.st.fields.progress_memo.label = '人間が変更'; m2.st.revision += 1; } });
  assert(r2.rb.status === 'BLOCKED' && r2.rb.steps[0].reason === 'FIELD_CHANGED' && m2.st.fields.progress_memo.label === '人間が変更', 'FIELD_CHANGED: 定義が変わったフィールドは削除しない');
  // UPDATE_FIELD の後に人間が同じフィールドを変えた → FIELD_CHANGED
  const p3 = plan([step('P1', 'UPDATE_FIELD', 'FIELD', 'owner', { required: true })]);
  const m3 = makeKintoneMock(DATA);
  const r3 = await flow(p3, m3, { between: () => { m3.st.fields.owner.label = '人間が変更'; m3.st.revision += 1; } });
  assert(r3.rb.status === 'BLOCKED' && r3.rb.steps[0].reason === 'FIELD_CHANGED' && m3.st.fields.owner.required === true && m3.st.fields.owner.label === '人間が変更', 'UPDATE_FIELD の rollback: 反映後に変わったフィールドは戻さない');
}
{
  // 準備（確認画面）→ 実行の間に人間が変更 → 実行時の再判定で ROLLBACK_STALE（書き込みなし）
  const p = plan([step('P1', 'UPDATE_VIEW', 'VIEW', '承認待ち', { fields: ['case_name', 'approver', 'amount'] })]);
  const mock = makeKintoneMock(DATA);
  const { rb, rolled } = await flow(p, mock, { betweenRollback: () => { mock.st.views['承認待ち'].sort = 'amount desc'; mock.st.revision += 1; } });
  assert(!rb.blockers.length && rolled.status === 'ROLLBACK_FAILED' && rolled.steps[0].status === 'ROLLBACK_STALE' && mock.st.views['承認待ち'].sort === 'amount desc' && mock.st.views['承認待ち'].fields.join() === 'case_name,approver,amount' && mock.calls.filter(c => c === 'PUT views').length === 1, '準備後の変更: 実行直前の再判定で止まる・PUT なし（実行時の 1 回だけ）');
  assert(rolled.message === '元に戻せませんでした。' && rolled.partial === false && rolled.verification.restoredToSnapshot === false, '結果: 元に戻せませんでした（partial ではない）');
}
{
  // revision 不一致（他の変更が同時に入った）→ ROLLBACK_FAILED / REVISION_MISMATCH。再試行しない（PUT は 1 回）
  const p = plan([step('P1', 'UPDATE_REMINDER', 'REMINDER', 'reminder#1', { daysLater: '-3' })]);
  const mock = makeKintoneMock(DATA);
  const { rolled } = await flow(p, mock, { betweenRollback: () => { mock.ctl.onWrite = (what) => { if (what === 'PUT reminders') mock.st.revision += 1; }; } });
  assert(rolled.status === 'ROLLBACK_FAILED' && rolled.steps[0].status === 'ROLLBACK_FAILED' && rolled.steps[0].reason === 'REVISION_MISMATCH' && mock.calls.filter(c => c === 'PUT reminders').length === 2 && mock.st.reminders[0].timing.daysLater === '-3', 'REVISION_MISMATCH: 再試行せず停止（PUT は実行 1 回 ＋ rollback 1 回）');
}
{
  // 入力の守り: 反映直後の設定が無い / 2 回目の rollback / 反映した step が無い
  const p = plan([step('P1', 'ADD_VIEW', 'VIEW', '進捗一覧', { name: '進捗一覧', fields: ['case_name'] })]);
  const mock = makeKintoneMock(DATA);
  const { log, prepared, rolled } = await flow(p, mock);
  const again = await E.prepareRollback(log, prepared, { api: mock.api });
  assert(rolled.status === 'ROLLED_BACK_VERIFIED' && again.status === 'BLOCKED' && again.blockers[0].code === 'ALREADY_ROLLED_BACK', '同じ実行を 2 回戻せない（ALREADY_ROLLED_BACK）');
  const m2 = makeKintoneMock(DATA);
  const r2 = await flow(p, m2, { skipRollback: true });
  r2.log.actualAfterRaw = null;
  const rb2 = await E.prepareRollback(r2.log, r2.prepared, { api: m2.api });
  assert(rb2.status === 'BLOCKED' && rb2.blockers[0].code === 'NO_ACTUAL_AFTER', '反映直後の設定が無ければ戻さない（NO_ACTUAL_AFTER）');
  const m3 = makeKintoneMock(DATA); m3.ctl.failPut = 'views';
  const r3 = await flow(p, m3);
  assert(r3.log.status === 'FAILED' && r3.rb.status === 'BLOCKED' && r3.rb.blockers[0].code === 'NOTHING_TO_ROLLBACK' && r3.rolled === null, '何も反映されなかった実行: NOTHING_TO_ROLLBACK');
  let thrown = null; try { await E.executeRollback(r3.rb, { api: m3.api, execution: r3.log }); } catch (e) { thrown = e; }
  assert(thrown && thrown.code === 'NOT_PREPARED', 'BLOCKED の rollback は実行できない');
}

console.log('\n--- 4. §42 Partial rollback ---');
{
  // 実行が途中で失敗（P1 ADD_FIELD VERIFIED・P2 ADD_NOTIFICATION VERIFIED・P3 ADD_VIEW FAILED）→ rollback は P2 → P1（P3 は対象外）
  const p = plan([
    step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1'),
    step('P2', 'ADD_NOTIFICATION', 'NOTIFICATION', '担当者設定通知', { name: '担当者設定通知', targets: ['FIELD_ENTITY:owner'], filterCond: 'owner not in ("")' }, { dependsOn: ['P1'] }),
    step('P3', 'ADD_VIEW', 'VIEW', '進捗一覧', { name: '進捗一覧', fields: ['case_name', 'NEW_FIELD_1'] }, { dependsOn: ['P2'] }),
  ], [pf('NEW_FIELD_1', '進捗メモ', 'progress_memo', 'SINGLE_LINE_TEXT')]);
  const mock = makeKintoneMock(DATA); mock.ctl.failPut = 'views'; const snap = snapOf(mock);
  const { log, rb, rolled } = await flow(p, mock);
  assert(log.status === 'PARTIAL' && log.steps.map(s => s.status).join() === 'VERIFIED,VERIFIED,FAILED', '前提: P3 で失敗（PARTIAL）');
  assert(rb.steps.map(s => s.stepId).join() === 'P2,P1' && rolled.status === 'ROLLED_BACK_VERIFIED' && statuses(rolled) === 'P2:ROLLBACK_VERIFIED P1:ROLLBACK_VERIFIED' && sameAsSnap(mock, snap), '反映済みの P2 → P1 だけ逆順に戻す（P3 は対象外）・全体が実行前と一致');
}
{
  // rollback が途中で失敗: P2 の rollback は成功・P1（DELETE_FIELD）が失敗 → 停止。「一部の変更だけ元に戻りました」
  const p = plan([
    step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1'),
    step('P2', 'ADD_NOTIFICATION', 'NOTIFICATION', '担当者設定通知', { name: '担当者設定通知', targets: ['FIELD_ENTITY:owner'], filterCond: 'owner not in ("")' }, { dependsOn: ['P1'] }),
  ], [pf('NEW_FIELD_1', '進捗メモ', 'progress_memo', 'SINGLE_LINE_TEXT')]);
  const mock = makeKintoneMock(DATA);
  const { log, rolled } = await flow(p, mock, { betweenRollback: () => { mock.ctl.failDelete = true; } });
  assert(rolled.status === 'ROLLBACK_FAILED' && statuses(rolled) === 'P2:ROLLBACK_VERIFIED P1:ROLLBACK_FAILED' && rolled.partial === true && rolled.message === '一部の変更だけ元に戻りました。' && mock.st.perRecord.length === 2 && mock.st.fields.progress_memo, 'P2 成功・P1 失敗 → 停止・partial・通知は戻りフィールドは残る');
  assert(log.lifecycle === 'ROLLBACK_FAILED' && log.steps[0].rollbackStatus === 'ROLLBACK_FAILED' && log.steps[1].rollbackStatus === 'ROLLBACK_VERIFIED' && rolled.verification.restoredToSnapshot === false && rolled.verification.diffs.some(d => d.kind === 'FIELD' && d.id === 'progress_memo'), 'lifecycle と全体検証（snapshot との差分にフィールドが残る）');
  const audit = E.buildAudit({ plan: p, execution: log, rollback: rolled });
  assert(audit.rollback.status === 'ROLLBACK_FAILED' && audit.rollback.partial === true && audit.rollback.steps.map(s => s.status).join() === 'ROLLBACK_VERIFIED,ROLLBACK_FAILED' && audit.rollback.steps[1].error.code === 'GAIA_XX', 'Audit に部分 rollback の結果');
}
{
  // 3 step で真ん中が失敗 → それ以前（P1）へ進まない（ROLLBACK_SKIPPED）
  const p = plan([
    step('P1', 'UPDATE_FIELD', 'FIELD', 'owner', { required: true }),
    step('P2', 'ADD_VIEW', 'VIEW', '進捗一覧', { name: '進捗一覧', fields: ['case_name'] }, { dependsOn: ['P1'] }),
    step('P3', 'ADD_REMINDER', 'REMINDER', '期限30日前', { name: '期限30日前', timingField: 'due_date', daysLater: '-30', time: '09:00', targets: ['FIELD_ENTITY:owner'] }, { dependsOn: ['P2'] }),
  ]);
  const mock = makeKintoneMock(DATA);
  const { log, rolled } = await flow(p, mock, { betweenRollback: () => { mock.ctl.failPut = 'views'; } });
  assert(log.status === 'DONE' && rolled.status === 'ROLLBACK_FAILED' && statuses(rolled) === 'P3:ROLLBACK_VERIFIED P2:ROLLBACK_FAILED P1:ROLLBACK_SKIPPED' && rolled.steps[2].reason === 'STOPPED_AFTER_FAILURE' && mock.st.fields.owner.required === true && mock.st.reminders.length === 1 && mock.st.views['進捗一覧'], 'P3 成功・P2 失敗 → P1 は実行しない（owner の必須は true のまま）');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
