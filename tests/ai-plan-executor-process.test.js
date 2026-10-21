// KTPlanExecutor Phase 12: プロセス管理の Preview Executor（Process Change Group = 1 PUT）
//
// 検証内容（§36〜44）:
//   §36 model: Change Group の形成（非 Process の依存が先に済む範囲でまとめる）/ identity の照合
//   §37 ADD_STATUS: normal / duplicate / unreachable（STATUS_UNREACHABLE で BLOCKED）/ temporary field assignee（ADD_FIELD → Process group）/ invalid assignee
//   §38 ADD_ACTION: unknown from・to / duplicate / identical / overlapping / invalid condition / 遷移元が複数
//   §39 UPDATE action: add condition（§9 の警告）/ narrow / broaden / invalid / stale（STALE_PLAN・TARGET_CHANGED）
//   §40 Full preservation: 3 状態・3 アクション → 4 状態・6 アクション、既存は bit 単位で保持。既存アクションを落とす mutant を検出
//   §41 Transaction group: 複数 step → PUT 1 回。PUT 失敗で Process 全 step FAILED・先行 ADD_FIELD は残る
//   §42 Verification: 新規 / 変更 / 保持 / 予期しない変更 / enable 不変 / kintone 側の副作用（KINTONE_SIDE_EFFECT）
//   §43 Rollback: 変更 → verify → restore → snapshot と完全一致。cross-category（Process を先に戻し、参照が消えてからフィールド削除）
//   §44 Rollback stale: 反映後に人間が別アクションを変更 → ROLLBACK_STALE・人間の変更を消さない
//
// 実行方法: node tests/ai-plan-executor-process.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { KTDeps, KTPlanReview, KTPlanExecutor } = loadToolkit();
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const E = KTPlanExecutor, R = KTPlanReview;

const clone = (v) => JSON.parse(JSON.stringify(v));
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], changeKind: null, assigneeType: null, ...o });
const step = (id, actionType, targetKind, targetRef, sp = {}, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PREVIEW_SUPPORTED', supported: true, reason: 'x' }, ...extra });
const pf = (temporaryId, label, suggestedCode, type, extra = {}) => ({ temporaryId, label, suggestedCode, type, typeValid: true, required: false, options: [], reason: '', evidenceIds: [], alternativeExistingFieldCode: null, codeConflict: false, labelDuplicate: false, ...extra });
const plan = (steps, proposedFields = [], extra = {}) => ({ planVersion: '1', requestId: 'tk-p12', goal: 'g', assessment: { summary: '' }, relevantFields: [], proposedFields, steps, alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', ...extra });

const DATA = FX.makeData();
const DEPS = KTDeps.buildDependencyData(DATA, KTDeps.normalizeFields(DATA.fields));
const reviewOf = (p, data = DATA) => R.review({ plan: p, data, deps: data === DATA ? DEPS : null, scan: null, incoming: null });
const approveAll = (p, rv) => R.executorOutput(p, rv, p.steps.map(s => s.id));
async function flow(p, mock, { data = DATA, between = null, betweenRollback = null, skipRollback = false, afterExec = null } = {}) {
  const rv = reviewOf(p, data);
  const prepared = await E.prepare(approveAll(p, rv), { api: mock.api, appId: '341' });
  if (between && prepared.status === 'PREPARED') between(prepared);
  const log = prepared.status === 'PREPARED' ? await E.executePreview(prepared, { api: mock.api, review: rv }) : null;
  if (afterExec && log) afterExec(log, prepared);
  const rb = log && !skipRollback ? await E.prepareRollback(log, prepared, { api: mock.api }) : null;
  if (rb && betweenRollback) betweenRollback(rb);
  const rolled = rb && rb.status === 'PREPARED' ? await E.executeRollback(rb, { api: mock.api, execution: log }) : null;
  return { rv, prepared, log, rb, rolled };
}
const statusOf = (mock) => clone(mock.st.status);
const stripRev = (o) => { const { revision, ...r } = o || {}; return r; };
const check = (log, i, name) => log.steps[i].verification?.checks?.find(c => c.name === name);
/** 承認分岐（§0 の代表ユースケース）: 部長承認ステータス ＋ 部長へ申請 / 部長承認する ＋ 承認するの条件 */
const BRANCH = () => plan([
  step('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認', { name: '部長承認', assignees: ['FIELD_ENTITY:approver'], assigneeType: 'ONE' }),
  step('P2', 'UPDATE_PROCESS', 'PROCESS_ACTION', '承認する', { filterCond: 'amount <= "999999"', changeKind: 'ACTION_CONDITION' }, { dependsOn: ['P1'] }),
  step('P3', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長へ申請', { name: '部長へ申請', from: '承認待ち', to: '部長承認', filterCond: 'amount >= "1000000"' }, { dependsOn: ['P1'] }),
  step('P4', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長承認する', { name: '部長承認する', from: '部長承認', to: '完了' }, { dependsOn: ['P1'] }),
]);

(async () => {
console.log('\n--- 1. §37 / §40 / §41 承認分岐（Change Group = 1 PUT・完全保持）---');
{
  const p = BRANCH(); const mock = makeKintoneMock(DATA); const before = statusOf(mock);
  const { rv, prepared, log, rb, rolled } = await flow(p, mock, { skipRollback: true });
  assert(rv.steps.every(r => r.safety === 'REVIEW_REQUIRED') && rv.simulation.process.partition.find(x => x.from === '承認待ち').verdict === 'PARTITION_OK', '前提: Review は 4 step とも REVIEW_REQUIRED・条件の分割は PARTITION_OK');
  assert(prepared.status === 'PREPARED' && prepared.groups.length === 1 && prepared.groups[0].groupId === 'PROCESS_CHANGE_1' && prepared.groups[0].stepIds.join() === 'P1,P2,P3,P4' && prepared.steps.every(s => s.groupId === 'PROCESS_CHANGE_1'), 'prepare: Process 関連 4 step が 1 つの Change Group');
  const pp = prepared.steps.map(s => s.prepared);
  assert(pp[0].mutation.kind === 'ADD_STATUS' && pp[0].mutation.assignee.type === 'ONE' && pp[0].mutation.assignee.entities[0].entity.code === 'approver' && pp[1].mutation.kind === 'UPDATE_ACTION' && pp[1].mutation.set.filterCond === 'amount <= "999999"' && pp[1].sensitive.some(x => x.code === 'EXISTING_PATH_RESTRICTED' && /既存の操作可能条件を変更します/.test(x.message)) && pp[2].mutation.kind === 'ADD_ACTION' && pp[2].mutation.action.type === 'PRIMARY' && pp[3].mutation.action.from === '部長承認', 'prepare: 変更（mutation）だけを作る・条件変更は §9 の警告を sensitive に');
  assert(log.status === 'DONE' && log.steps.every(s => s.status === 'VERIFIED' && s.groupId === 'PROCESS_CHANGE_1') && mock.calls.filter(c => c === 'PUT status').length === 1 && log.steps[0].requests[0].stepIds.join() === 'P1,P2,P3,P4', '反映: 4 step を 1 回の PUT で（全 step VERIFIED・同じ requests）');
  const now = statusOf(mock);
  assert(Object.keys(now.states).length === 4 && now.actions.length === 5 && now.states['部長承認'].index === '3' && now.states['部長承認'].assignee.type === 'ONE' && now.states['部長承認'].assignee.entities[0].entity.code === 'approver', '新しいステータスは末尾（index 3）・作業者 approver（ONE）');
  assert(JSON.stringify(now.states['未処理']) === JSON.stringify(before.states['未処理']) && JSON.stringify(now.states['承認待ち']) === JSON.stringify(before.states['承認待ち']) && JSON.stringify(now.states['完了']) === JSON.stringify(before.states['完了']) && now.states['承認待ち'].assignee.entities.some(e => e.entity.type === 'CUSTOM_FIELD') && now.states['承認待ち'].assignee.entities.some(e => e.entity.type === 'CREATOR'), '既存 3 ステータスは bit 単位で保持（CUSTOM_FIELD / CREATOR / includeSubs を含む）');
  assert(JSON.stringify(now.actions.find(a => a.name === '申請する')) === JSON.stringify(before.actions[0]) && JSON.stringify(now.actions.find(a => a.name === '取り下げる')) === JSON.stringify(before.actions[2]) && now.actions.find(a => a.name === '承認する').filterCond === 'amount <= "999999"' && now.actions.find(a => a.name === '承認する').to === '完了' && now.enable === true, '既存アクションは保持（SECONDARY の executableUser 含む）・承認するは条件だけ変更・enable 不変');
  assert(now.actions.find(a => a.name === '部長へ申請').from === '承認待ち' && now.actions.find(a => a.name === '部長へ申請').filterCond === 'amount >= "1000000"' && now.actions.find(a => a.name === '部長承認する').to === '完了', '新しいアクション 2 件');
  const v = log.steps[0].verification;
  assert(v.ok && ['enableUnchanged', 'existingStatesPreserved', 'existingActionsPreserved', 'unexpectedRemoved', 'unexpectedChanged', 'noUnexpectedAdditions', 'noSideEffects'].every(n => v.checks.find(c => c.name === n)?.ok) && check(log, 0, 'newStatusExists').ok && check(log, 1, 'actionUpdated').ok && check(log, 2, 'newActionExists').ok && check(log, 3, 'newActionExists').ok, 'verification: enable / 既存の保持 / 予期しない変更なし / 新規・変更の確認 / 副作用なし');
  assert(log.process && log.process.mermaid.before && log.process.mermaid.planned.includes('部長承認') && log.process.mermaid.actual.includes('部長承認') && log.process.actual.states.length === 4 && log.process.partition.length, 'Before / Planned / Actual の Mermaid と分割判定（書いた内容の判定は手順ごとの読み戻し）');
  assert(log.actualAfter.processStates === 4 && log.actualAfter.processActions === 5 && log.actualAfter.addedStatuses.join() === '部長承認' && log.actualAfter.addedActions.join() === '部長へ申請,部長承認する' && log.actualAfter.updatedProcess.join() === '承認する', 'actualAfter にプロセスの件数');
  const plan1 = E.buildRollbackPlan(log, prepared);
  assert(plan1.steps.length === 1 && plan1.steps[0].actionType === 'RESTORE_PROCESS_SETTINGS' && plan1.steps[0].stepIds.join() === 'P1,P2,P3,P4' && plan1.steps[0].collection === 'status', 'rollback 計画: Change Group は 1 手順（RESTORE_PROCESS_SETTINGS）');
  const rb2 = await E.prepareRollback(log, prepared, { api: mock.api });
  const rolled2 = await E.executeRollback(rb2, { api: mock.api, execution: log });
  assert(rolled2.status === 'ROLLED_BACK_VERIFIED' && JSON.stringify(statusOf(mock)) === JSON.stringify(before) && rolled2.verification.restoredToSnapshot === true && log.steps.every(s => s.rollbackStatus === 'ROLLBACK_VERIFIED') && mock.calls.filter(c => c === 'PUT status').length === 2, '§43 Rollback: snapshot のプロセス設定と完全一致（ROLLED_BACK_VERIFIED）・各 step に rollbackStatus');
  const audit = E.buildAudit({ plan: p, review: rv, prepared, execution: log, rollback: rolled2 });
  assert(audit.execution.process && audit.execution.process.before.states.length === 3 && /部長承認/.test(audit.execution.process.mermaid.planned) && audit.execution.process.actual.states.length === 4 && audit.rollback.status === 'ROLLED_BACK_VERIFIED' && audit.afterSnapshot.status && audit.beforeSnapshot.status, '§32 Audit: Before / Planned / Actual のプロセス（Planned は計画の図。2026-10-19: 確認の結果の要約の写しは持たない）・snapshot・rollback');
}
{
  // §40: 3 状態 / 3 アクション → 4 状態 / 6 アクション（SECONDARY の差し戻しを含む）
  const p = plan([
    step('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認', { name: '部長承認', assignees: ['FIELD_ENTITY:approver', 'GROUP:sales_group'], assigneeType: 'ALL' }),
    step('P2', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長へ申請', { name: '部長へ申請', from: '承認待ち', to: '部長承認', filterCond: 'amount >= "1000000"' }, { dependsOn: ['P1'] }),
    step('P3', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長承認する', { name: '部長承認する', from: '部長承認', to: '完了' }, { dependsOn: ['P1'] }),
    step('P4', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '差し戻す', { name: '差し戻す', from: '部長承認', to: '未処理', entities: ['FIELD_ENTITY:owner'] }, { dependsOn: ['P1'] }),
  ]);
  const mock = makeKintoneMock(DATA); const before = statusOf(mock);
  const { log } = await flow(p, mock, { skipRollback: true });
  const now = statusOf(mock);
  assert(log.status === 'DONE' && Object.keys(now.states).length === 4 && now.actions.length === 6 && before.actions.every(a => JSON.stringify(now.actions.find(x => x.name === a.name && x.from === a.from)) === JSON.stringify(a)) && ['未処理', '承認待ち', '完了'].every(n => JSON.stringify(now.states[n]) === JSON.stringify(before.states[n])), '3 状態 / 3 アクション → 4 / 6。既存 3 / 3 は bit 単位で保持');
  assert(now.states['部長承認'].assignee.type === 'ALL' && now.states['部長承認'].assignee.entities.length === 2 && now.actions.find(a => a.name === '差し戻す').type === 'SECONDARY' && now.actions.find(a => a.name === '差し戻す').executableUser.entities[0].entity.code === 'owner' && now.actions.find(a => a.name === '部長へ申請').type === 'PRIMARY' && !now.actions.find(a => a.name === '部長へ申請').executableUser, 'ALL の作業者 2 件・SECONDARY（実行可能ユーザー owner）・PRIMARY には executableUser を付けない');
  // mutant: 既存アクションを 1 件落とす PUT → VERIFY_FAILED（existingActionsPreserved / unexpectedRemoved 1）
  const m2 = makeKintoneMock(DATA); m2.ctl.mutateList = (what, body) => { if (what === 'status') body.actions = body.actions.filter(a => a.name !== '取り下げる'); return body; };
  const r2 = await flow(p, m2, { skipRollback: true });
  assert(r2.log.status === 'FAILED' && r2.log.steps.every(s => s.status === 'VERIFY_FAILED') && check(r2.log, 0, 'existingActionsPreserved').ok === false && check(r2.log, 0, 'unexpectedRemoved').actual === 1, '既存アクションを落とす mutant → 全 step VERIFY_FAILED（unexpectedRemoved 1）');
  // mutant: 既存ステータスの作業者が書き換わる → unexpectedChanged
  const m3 = makeKintoneMock(DATA); m3.ctl.mutateList = (what, body) => { if (what === 'status') body.states['承認待ち'].assignee.entities = body.states['承認待ち'].assignee.entities.slice(0, 1); return body; };
  const r3 = await flow(p, m3, { skipRollback: true });
  assert(r3.log.steps[0].status === 'VERIFY_FAILED' && check(r3.log, 0, 'existingStatesPreserved').ok === false && check(r3.log, 0, 'unexpectedChanged').actual === 1, '既存ステータスの作業者が変わる mutant → unexpectedChanged 1');
}

console.log('\n--- 1b. 書いた結果を手順ごとに承認した内容と比べる（2026-10-21。反映した後の照合の代わり）---');
{
  //   (a) 手順ごとの確かめに matchesApproved（書いた結果が、計画の検査の After から作った承認した内容 expect と同じ）がある
  const p = BRANCH(); const mock = makeKintoneMock(DATA);
  const { log } = await flow(p, mock, { skipRollback: true });
  assert(log.status === 'DONE' && [0, 1, 2, 3].every(i => check(log, i, 'matchesApproved')?.ok === true), `手順ごとに、書いた結果が承認した内容と同じ（matchesApproved）: ${JSON.stringify(log.steps.map(s => check(log, log.steps.indexOf(s), 'matchesApproved')))}`);
  //   (b) 合成の誤り（送る内容が承認した内容と違う）: 送った内容と kintone の保存結果は一致するが、承認した内容と違う → その手順が VERIFY_FAILED・反映は PARTIAL
  //       （グループ全体の確かめは通る。前は反映した後の照合の注意だけで、反映は DONE だった）
  const m2 = makeKintoneMock(DATA); const orig = E.PROCESS_GROUP.compose;
  E.PROCESS_GROUP.compose = function (cur, steps) { const next = orig.call(this, cur, steps); const a = next.actions.find(x => x.name === '部長へ申請'); if (a) a.filterCond = 'amount >= "2000000"'; return next; };
  let r2 = null; try { r2 = await flow(p, m2, { skipRollback: true }); } finally { E.PROCESS_GROUP.compose = orig; }
  const mis = check(r2.log, 2, 'matchesApproved');
  assert(r2.log.status === 'PARTIAL' && r2.log.steps.map(s => s.status).join() === 'VERIFIED,VERIFIED,VERIFY_FAILED,VERIFIED' && check(r2.log, 2, 'newActionExists')?.ok === true && mis && mis.ok === false && /1000000/.test(mis.expected.filterCond) && /2000000/.test(mis.actual.filterCond),
    `合成の誤りは、手順ごとの承認した内容との比べが見つける（送った内容との一致だけでは見つからない）: ${JSON.stringify({ steps: r2.log.steps.map(s => s.status), mis })}`);
}

console.log('\n--- 2. §36 / §37 Change Group の形成・孤立・新規フィールドの作業者・cross-category rollback ---');
{
  // ADD_FIELD（部長承認者）→ Process group（作業者 = NEW_FIELD_1）。group は P1 の後に 1 回の PUT。Rollback は Process → Field の順
  const p = plan([
    step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1'),
    step('P2', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認', { name: '部長承認', assignees: ['NEW_FIELD_1'] }, { dependsOn: ['P1'] }),
    step('P3', 'UPDATE_PROCESS', 'PROCESS_ACTION', '承認する', { filterCond: 'amount <= "999999"', changeKind: 'ACTION_CONDITION' }, { dependsOn: ['P2'] }),
    step('P4', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長へ申請', { name: '部長へ申請', from: '承認待ち', to: '部長承認', filterCond: 'amount >= "1000000"' }, { dependsOn: ['P2'] }),
    step('P5', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長承認する', { name: '部長承認する', from: '部長承認', to: '完了' }, { dependsOn: ['P2'] }),
  ], [pf('NEW_FIELD_1', '部長承認者', 'manager_approver', 'USER_SELECT')]);
  const mock = makeKintoneMock(DATA); const beforeS = statusOf(mock);
  const { prepared, log, rb, rolled } = await flow(p, mock);
  assert(prepared.groups.length === 1 && prepared.groups[0].stepIds.join() === 'P2,P3,P4,P5' && prepared.groups[0].anchorStepId === 'P2' && prepared.steps[0].groupId === null, 'group: P2〜P5（非 Process の依存 P1 が先に済む）');
  assert(log.status === 'DONE' && log.steps.map(s => s.status).join() === 'VERIFIED,VERIFIED,VERIFIED,VERIFIED,VERIFIED' && mock.calls.indexOf('POST fields') < mock.calls.indexOf('PUT status') && mock.calls.filter(c => c === 'PUT status').length === 2 && log.processActual.states['部長承認'].assignee.entities[0].entity.code === 'manager_approver', '§24 順序: フィールド追加 → Process 1 PUT・作業者は新規フィールド（temporaryId を解決）');
  assert(rb.steps.map(s => s.actionType).join() === 'RESTORE_PROCESS_SETTINGS,DELETE_FIELD' && rolled.status === 'ROLLED_BACK_VERIFIED' && JSON.stringify(statusOf(mock)) === JSON.stringify(beforeS) && !mock.st.fields.manager_approver, '§31 cross-category rollback: Process を先に戻し（参照が消えてから）フィールドを削除・snapshot と一致');
}
{
  // Change Group の分割: Process step の非 Process 依存がアンカーより後にあれば別グループ
  const p = plan([
    step('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認', { name: '部長承認' }),
    step('P2', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長へ申請', { name: '部長へ申請', from: '承認待ち', to: '部長承認', filterCond: 'amount >= "1000000"' }, { dependsOn: ['P1'] }),
    step('P3', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長承認する', { name: '部長承認する', from: '部長承認', to: '完了' }, { dependsOn: ['P1'] }),
    step('P4', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', {}, { dependsOn: ['P1'] }),
    step('P5', 'UPDATE_PROCESS', 'PROCESS_STATUS', '部長承認', { assignees: ['NEW_FIELD_1'], changeKind: 'ASSIGNEE' }, { dependsOn: ['P4'] }),
  ], [pf('NEW_FIELD_1', '部長承認者', 'manager_approver', 'USER_SELECT')]);
  const rv = reviewOf(p); const mock = makeKintoneMock(DATA);
  const prepared = await E.prepare(approveAll(p, rv), { api: mock.api, appId: '341' });
  assert(prepared.status === 'PREPARED' && prepared.groups.map(g => g.stepIds.join('+')).join(' ') === 'P1+P2+P3 P5', 'P5 は P4（フィールド追加）の後なので 2 つ目の Change Group');
  const log = await E.executePreview(prepared, { api: mock.api, review: rv });
  assert(log.status === 'DONE' && mock.calls.filter(c => c === 'PUT status').length === 2 && mock.st.status.states['部長承認'].assignee.entities[0].entity.code === 'manager_approver', '2 グループ → PUT 2 回・順序どおり');
}
{
  // 孤立（遷移するアクションが無い）→ STATUS_UNREACHABLE で BLOCKED（書き込みなし）
  const p = plan([step('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '差戻し', { name: '差戻し' })]);
  const rv = reviewOf(p); const mock = makeKintoneMock(DATA);
  const prepared = await E.prepare(approveAll(p, rv), { api: mock.api, appId: '341' });
  assert(rv.conflicts.some(c => c.code === 'STATUS_UNREACHABLE') && prepared.status === 'BLOCKED' && prepared.steps[0].status === 'BLOCKED' && prepared.steps[0].reason === 'STATUS_UNREACHABLE' && !mock.calls.some(c => /^PUT/.test(c)), 'unreachable: STATUS_UNREACHABLE で実行不可');
  // 重複 / 不正な作業者フィールドは Review で INVALID → 承認できない
  const dup = reviewOf(plan([step('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '承認待ち', { name: '承認待ち' })]));
  const badAsg = reviewOf(plan([step('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認', { name: '部長承認', assignees: ['FIELD_ENTITY:case_name'] })]));
  assert(dup.steps[0].status === 'INVALID' && badAsg.steps[0].status === 'INVALID' && badAsg.steps[0].issues.some(i => i.code === 'ASSIGNEE_FIELD_INVALID'), 'duplicate / invalid assignee: INVALID');
  // プロセス管理が無効なアプリ → PROCESS_ENABLE_NOT_SUPPORTED（計画のみ）
  const d = FX.makeData(); d.status.enable = false;
  const p2 = plan([step('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認', { name: '部長承認' }), step('P2', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長へ', { name: '部長へ', from: '承認待ち', to: '部長承認' }, { dependsOn: ['P1'] })]);
  const rv2 = reviewOf(p2, d); const m2 = makeKintoneMock(d);
  const pr2 = await E.prepare(approveAll(p2, rv2), { api: m2.api, appId: '341' });
  assert(rv2.steps[0].issues.some(i => i.code === 'PROCESS_DISABLED') && pr2.steps.every(s => s.status === 'UNSUPPORTED' && s.reason === 'PROCESS_ENABLE_NOT_SUPPORTED') && !m2.calls.some(c => /^PUT/.test(c)), '無効なプロセス管理: PROCESS_ENABLE_NOT_SUPPORTED（Toolkit は有効化しない）');
}

console.log('\n--- 3. §38 ADD_ACTION ---');
{
  const unkFrom = reviewOf(plan([step('P1', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', 'x', { name: 'x', from: '存在しない', to: '完了' })]));
  const unkTo = reviewOf(plan([step('P1', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', 'x', { name: 'x', from: '承認待ち', to: '存在しない' })]));
  const dupName = reviewOf(plan([step('P1', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '承認する', { name: '承認する', from: '承認待ち', to: '未処理' })]));
  assert(unkFrom.steps[0].status === 'INVALID' && unkTo.steps[0].status === 'INVALID' && dupName.steps[0].status === 'INVALID' && dupName.steps[0].issues.some(i => i.code === 'ACTION_DUPLICATE'), 'unknown from / unknown to / duplicate name: INVALID');
  const ident = plan([step('P1', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '別名承認', { name: '別名承認', from: '承認待ち', to: '完了' })]);
  const rvI = reviewOf(ident); const mI = makeKintoneMock(DATA);
  const prI = await E.prepare(approveAll(ident, rvI), { api: mI.api, appId: '341' });
  assert(rvI.steps[0].issues.some(i => i.code === 'ACTION_SAME_CONDITION') && rvI.steps[0].safety === 'REVIEW_REQUIRED' && prI.status === 'PREPARED', 'identical transition（同じ遷移元・同じ条件）: 高リスク警告付きで承認すれば実行可');
  // Phase 20: 前のステータス（未処理）へ戻すアクションは分岐の相手にしない（kintone の条件は表示するボタンの切り替え）→ 分岐は進む方向（完了）で確かめる
  const ov = plan([step('P1', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長へ', { name: '部長へ', from: '承認待ち', to: '完了', filterCond: 'amount >= "1000000"' })]);
  const rvO = reviewOf(ov);
  assert(rvO.steps[0].issues.some(i => i.code === 'ACTION_CONDITION_OVERLAP') && rvO.steps[0].issues.some(i => i.code === 'PROCESS_CONDITION_OVERLAP'), 'overlapping condition: 既存の無条件「承認する」と重なる警告（分岐が強制されない）');
  const inv = plan([step('P1', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', 'x', { name: 'x', from: '承認待ち', to: '完了', filterCond: 'owner in (LOGINUSER())' })]);
  const rvV = reviewOf(inv); const mV = makeKintoneMock(DATA);
  const prV = await E.prepare(approveAll(inv, rvV), { api: mV.api, appId: '341' });
  assert(rvV.steps[0].issues.some(i => i.code === 'COND_INVALID') && prV.steps[0].status === 'BLOCKED' && prV.steps[0].reason === 'INVALID_CONDITION' && mV.calls.length === 0, 'invalid condition（プロセスで LOGINUSER）: API に投げず INVALID_CONDITION');
  const multi = plan([step('P1', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', 'x', { name: 'x', from: '未処理,承認待ち', to: '完了' })]);
  const rvM = reviewOf(multi); const mM = makeKintoneMock(DATA);
  const prM = await E.prepare(approveAll(multi, rvM), { api: mM.api, appId: '341' });
  assert(prM.steps[0].status === 'UNSUPPORTED' && prM.steps[0].reason === 'MULTI_FROM_NOT_SUPPORTED', '遷移元が複数: 計画のみ（1 件ずつに分ける）');
}

console.log('\n--- 4. §39 UPDATE action（条件）---');
{
  // add condition（§9）: 承認する 条件なし → amount < 1000000。sensitive に警告。反映後は他の属性不変
  const p = plan([step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '承認する', { filterCond: 'amount <= "999999"', changeKind: 'ACTION_CONDITION' })]);
  const mock = makeKintoneMock(DATA); const before = statusOf(mock);
  const { prepared, log, rolled } = await flow(p, mock);
  assert(prepared.steps[0].prepared.sensitive.some(x => x.code === 'EXISTING_PATH_RESTRICTED' && x.message.includes('現在はすべての「承認待ち」で実行できます') && x.message.includes('変更後は「amount <= "999999"」の場合のみ実行可能になります')), '§9: 既存の操作可能条件を変更します（現在はすべて… / 変更後は…のみ）');
  assert(log.status === 'DONE' && log.steps[0].status === 'VERIFIED' && JSON.stringify(log.steps[0].after) === JSON.stringify({ filterCond: 'amount <= "999999"' }) && mock.calls.filter(c => c === 'PUT status').length === 2 && rolled.status === 'ROLLED_BACK_VERIFIED' && JSON.stringify(statusOf(mock)) === JSON.stringify(before), 'add condition → VERIFIED → rollback で元どおり（PUT は実行 1 回 ＋ rollback 1 回）');
  // narrow / broaden
  const narrow = plan([step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', { filterCond: 'amount >= "100"' })]);
  const rvN = reviewOf(narrow); const mN = makeKintoneMock(DATA);
  const rN = await flow(narrow, mN, { skipRollback: true });
  assert(rvN.steps[0].issues.some(i => i.code === 'EXISTING_PATH_RESTRICTED') && rN.log.status === 'DONE' && mN.st.status.actions[0].filterCond === 'amount >= "100"' && !mN.st.status.actions[0].executableUser && mN.st.status.actions[0].type === 'PRIMARY', 'narrow（> 0 → >= 100）: 警告付きで反映・PRIMARY（executableUser は kintone の GET と同じく無し）');
  const broaden = plan([step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', { filterCond: 'amount >= "0"' })]);
  const rvB = reviewOf(broaden); const mB = makeKintoneMock(DATA);
  const rB = await flow(broaden, mB, { skipRollback: true });
  assert(rvB.steps[0].issues.some(i => i.code === 'CONDITION_CHANGE') && rB.log.status === 'DONE' && mB.st.status.actions[0].filterCond === 'amount >= "0"', 'broaden: CONDITION_CHANGE・反映');
  // 2026-10-14（Q2 の局所修正）: 「100 万円未満」を <= と != の and で表した条件（数値の条件に < は使えない）。Review は分岐を PARTITION_OK と判定し、
  //   UPDATE_PROCESS（ACTION_CONDITION）と ADD_PROCESS_ACTION の filterCond は文字列のまま API の payload（モックに保存される状態）に入る
  const LOW = 'amount <= "1000000" and amount != "1000000"';
  const comp = BRANCH(); comp.steps[1].spec.filterCond = LOW;
  const mC = makeKintoneMock(DATA);
  const rC = await flow(comp, mC, { skipRollback: true });
  assert(rC.rv.steps.every(r => r.status !== 'INVALID') && !rC.rv.steps.some(r => r.issues.some(i => ['CONDITION_CHANGE_UNPARSED', 'ACTION_CONDITION_UNPARSED', 'ACTION_CONDITION_OVERLAP', 'PROCESS_CONDITION_UNKNOWN', 'PROCESS_CONDITION_OVERLAP'].includes(i.code))) && rC.rv.steps[1].issues.some(i => i.code === 'EXISTING_PATH_RESTRICTED') && rC.rv.simulation.process.partition.find(x => x.from === '承認待ち').verdict === 'PARTITION_OK', 'compound（<= 1000000 and != 1000000 / >= 1000000）: Review は EXISTING_PATH_RESTRICTED だけで、重なり・判定不能を出さず PARTITION_OK');
  const pC = rC.prepared.steps.map(s => s.prepared);
  assert(rC.prepared.status === 'PREPARED' && pC[1].mutation.kind === 'UPDATE_ACTION' && pC[1].mutation.set.filterCond === LOW && pC[2].mutation.kind === 'ADD_ACTION' && pC[2].mutation.action.filterCond === 'amount >= "1000000"', 'compound: prepare の変更（mutation）に式がそのまま（変換・丸めなし）');
  assert(rC.log.status === 'DONE' && rC.log.steps.every(s => s.status === 'VERIFIED') && mC.st.status.actions.find(a => a.name === '承認する').filterCond === LOW && mC.st.status.actions.find(a => a.name === '部長へ申請').filterCond === 'amount >= "1000000"' && JSON.stringify(rC.log.steps[1].after) === JSON.stringify({ filterCond: LOW }), 'compound: PUT の payload（モックの保存）と after に式がそのまま・全 step VERIFIED');
  // invalid expression
  const bad = plan([step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '承認する', { filterCond: 'owner != ""' })]);
  const rvX = reviewOf(bad); const mX = makeKintoneMock(DATA);
  const prX = await E.prepare(approveAll(bad, rvX), { api: mX.api, appId: '341' });
  assert(prX.steps[0].status === 'BLOCKED' && prX.steps[0].reason === 'INVALID_CONDITION' && mX.calls.length === 0, 'invalid expression（USER_SELECT に !=）: INVALID_CONDITION');
  // stale: Review 後に人間がそのアクションを変えた → STALE_PLAN / prepare 後 → TARGET_CHANGED
  const m1 = makeKintoneMock(DATA); m1.st.status.actions[1].filterCond = 'amount >= "1"';
  const pr1 = await E.prepare(approveAll(p, reviewOf(p)), { api: m1.api, appId: '341' });
  assert(pr1.status === 'BLOCKED' && pr1.blockers.some(b => b.code === 'STALE_PLAN') && pr1.stale.diffs.some(d => d.kind === 'PROCESS_ACTION' && d.id === '承認する'), 'stale（Review → prepare）: STALE_PLAN（PROCESS_ACTION の差分）');
  const m2 = makeKintoneMock(DATA);
  const r2 = await flow(p, m2, { between: () => { m2.st.status.actions[1].to = '未処理'; } });
  assert(r2.log.status === 'FAILED' && r2.log.steps[0].status === 'FAILED' && r2.log.steps[0].reason === 'TARGET_CHANGED' && !m2.calls.some(c => c === 'PUT status') && m2.st.status.actions[1].to === '未処理', 'stale（prepare → 実行）: TARGET_CHANGED・PUT なし・人間の変更はそのまま');
  const m3 = makeKintoneMock(DATA); m3.st.status.enable = false;
  const pr3 = await E.prepare(approveAll(p, reviewOf(p)), { api: m3.api, appId: '341' });
  assert(pr3.status === 'BLOCKED' && pr3.stale.diffs.some(d => d.kind === 'PROCESS' && d.id === 'enable'), 'enable の変更も STALE_PLAN（§20）');
}

console.log('\n--- 5. 作業者 / 実行可能ユーザー（§12〜14）---');
{
  const p = plan([step('P1', 'UPDATE_PROCESS', 'PROCESS_STATUS', '承認待ち', { assignees: ['FIELD_ENTITY:approver'], assigneeType: 'ANY', changeKind: 'ASSIGNEE' })]);
  const mock = makeKintoneMock(DATA); const before = statusOf(mock);
  const { prepared, log, rolled } = await flow(p, mock);
  assert(prepared.steps[0].prepared.mutation.kind === 'UPDATE_STATUS' && prepared.steps[0].prepared.sensitive.some(x => x.code === 'ASSIGNEE_CHANGE') && log.status === 'DONE' && mock.calls.filter(c => c === 'PUT status').length === 2, 'Case B 相当: 作業者を承認者フィールドに（ASSIGNEE_CHANGE を最終確認に）');
  const after = log.processActual;
  assert(after.states['承認待ち'].assignee.type === 'ANY' && after.states['承認待ち'].assignee.entities.length === 1 && after.states['承認待ち'].assignee.entities[0].entity.code === 'approver' && after.states['承認待ち'].assignee.entities[0].includeSubs === false && JSON.stringify(after.states['未処理']) === JSON.stringify(before.states['未処理']) && JSON.stringify(after.actions) === JSON.stringify(before.actions), '作業者と指定形式（ANY）だけ変わり、他は保持');
  assert(rolled.status === 'ROLLED_BACK_VERIFIED' && JSON.stringify(statusOf(mock)) === JSON.stringify(before), 'rollback で作業者 6 件（CUSTOM_FIELD / CREATOR 含む）に戻る');
  // 実行可能ユーザーの変更（取り下げる: owner + user2 → owner だけ）
  const p2 = plan([step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '取り下げる', { entities: ['FIELD_ENTITY:owner'], changeKind: 'EXECUTABLE_USER' })]);
  const m2 = makeKintoneMock(DATA);
  const r2 = await flow(p2, m2, { skipRollback: true });
  assert(r2.prepared.steps[0].prepared.sensitive.some(x => x.code === 'EXECUTABLE_USER_CHANGE') && r2.log.status === 'DONE' && m2.st.status.actions[2].type === 'SECONDARY' && m2.st.status.actions[2].executableUser.entities.length === 1 && m2.st.status.actions[2].executableUser.entities[0].entity.code === 'owner', '実行可能ユーザーの変更: 高リスク警告・反映後は owner だけ');
  // 作業者の指定形式が語彙外 / 実行可能ユーザーに CREATOR → Review で止まる
  const badT = reviewOf(plan([step('P1', 'UPDATE_PROCESS', 'PROCESS_STATUS', '承認待ち', { assignees: ['FIELD_ENTITY:approver'], assigneeType: '責任者が承認' })]));
  assert(badT.steps[0].issues.some(i => i.code === 'ASSIGNEE_TYPE_UNKNOWN'), '語彙外の assigneeType は要確認（API 値にしない）');
}

console.log('\n--- 6. §41 / §27 Transaction group の失敗・§17 副作用・§44 rollback stale ---');
{
  // PUT 失敗 → Process 全 step FAILED・先行 ADD_FIELD は VERIFIED のまま（Fail Stop）
  const p = plan([
    step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1'),
    step('P2', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認', { name: '部長承認', assignees: ['NEW_FIELD_1'] }, { dependsOn: ['P1'] }),
    step('P3', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長へ申請', { name: '部長へ申請', from: '承認待ち', to: '部長承認', filterCond: 'amount >= "1000000"' }, { dependsOn: ['P2'] }),
    step('P4', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長承認する', { name: '部長承認する', from: '部長承認', to: '完了' }, { dependsOn: ['P2'] }),
    step('P5', 'ADD_NOTIFICATION', 'NOTIFICATION', '部長承認通知', { name: '部長承認通知', targets: ['NEW_FIELD_1'], filterCond: 'amount >= "1000000"' }, { dependsOn: ['P4'] }),
  ], [pf('NEW_FIELD_1', '部長承認者', 'manager_approver', 'USER_SELECT')]);
  const mock = makeKintoneMock(DATA); mock.ctl.failPut = 'status'; const beforeS = statusOf(mock);
  const { log, rb, rolled } = await flow(p, mock);
  assert(log.status === 'PARTIAL' && log.steps.map(s => s.status).join() === 'VERIFIED,FAILED,FAILED,FAILED,SKIPPED' && log.steps[1].reason === 'API_ERROR' && log.steps[4].reason === 'STOPPED_AFTER_FAILURE' && JSON.stringify(stripRev(log.actualAfterRaw.status)) === JSON.stringify(beforeS) && log.actualAfterRaw.fields.properties.manager_approver, 'PUT 失敗: Process 3 step FAILED・後続 SKIPPED・プロセス設定は無傷・先行フィールドは残る');
  assert(rb.steps.map(s => s.actionType).join() === 'DELETE_FIELD' && rolled.status === 'ROLLED_BACK_VERIFIED' && !mock.st.fields.manager_approver, 'rollback 対象は反映済みのフィールドだけ');
}
{
  // §17 kintone 側の副作用: PUT 後に一覧「（作業者が自分）」が自動で増えた → KINTONE_SIDE_EFFECT（正常扱いしない）→ rollback で一覧も戻す
  const p = BRANCH(); const mock = makeKintoneMock(DATA); const beforeV = clone(mock.st.views);
  mock.ctl.sideEffectOnStatusPut = (st) => { st.views['（作業者が自分）'] = { id: '999', name: '（作業者が自分）', type: 'LIST', builtinType: 'ASSIGNEE', index: '2', fields: ['case_name'], filterCond: '', sort: '' }; };
  const { log, rb, rolled } = await flow(p, mock);
  assert(log.steps.every(s => s.status === 'VERIFY_FAILED' && s.reason === 'KINTONE_SIDE_EFFECT') && check(log, 0, 'noSideEffects').ok === false && log.steps[0].verification.sideEffects[0].collection === 'views' && log.status === 'FAILED', '副作用: KINTONE_SIDE_EFFECT として VERIFY_FAILED（正常扱いしない）');
  assert(rb.steps.map(s => s.actionType).join() === 'RESTORE_PROCESS_SETTINGS,RESTORE_VIEWS' && rolled.status === 'ROLLED_BACK_VERIFIED' && JSON.stringify(mock.st.views) === JSON.stringify(beforeV) && Object.keys(mock.st.status.states).length === 3, 'rollback: 副作用の一覧とプロセス設定の両方を snapshot へ');
}
{
  // §44 rollback stale: 反映後に人間が別アクション（取り下げる）を変更 → ROLLBACK_STALE・人間の変更を消さない
  const p = BRANCH(); const mock = makeKintoneMock(DATA);
  const { rb, rolled } = await flow(p, mock, { afterExec: () => { mock.st.status.actions.find(a => a.name === '取り下げる').filterCond = 'amount >= "1"'; mock.st.revision += 1; } });
  assert(rb.status === 'BLOCKED' && rb.blockers[0].code === 'ROLLBACK_STALE' && rb.steps[0].status === 'ROLLBACK_STALE' && rb.steps[0].reason === 'THIRD_PARTY_CHANGE' && rb.stale.diffs.some(d => d.kind === 'PROCESS_ACTION' && d.id === '取り下げる') && rolled === null, 'ROLLBACK_STALE: 準備で止まる・差分（PROCESS_ACTION 取り下げる）');
  assert(mock.st.status.actions.find(a => a.name === '取り下げる').filterCond === 'amount >= "1"' && Object.keys(mock.st.status.states).length === 4 && mock.calls.filter(c => c === 'PUT status').length === 1, '人間の変更を消さない（PUT は実行の 1 回だけ）');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
