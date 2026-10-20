// KTPlanExecutor Tier 2（Phase 10）: ADD_NOTIFICATION / ADD_REMINDER / 限定 UPDATE_FIELD
//
// 検証内容（§26〜30）: notification（unique / exact duplicate / possible duplicate / FIELD_ENTITY recipient / missing recipient field /
//   invalid condition / existing preserved / verification mismatch / stale config）、reminder（valid / invalid base field / duplicate /
//   possible duplicate / recipient resolution / existing preserved / stale / verification）、UPDATE_FIELD（label only / required only /
//   label + required / type change / code change / stale / code・type preserved / unexpected mutation）、combined DAG、full payload safety（mutant 検出）
//
// 実行方法: node tests/ai-plan-executor-tier2.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { KTDeps, KTPlanReview, KTPlanExecutor } = loadToolkit();
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const E = KTPlanExecutor, R = KTPlanReview;

const clone = (v) => JSON.parse(JSON.stringify(v));
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], ...o });
const step = (id, actionType, targetKind, targetRef, sp = {}, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' }, ...extra });
const pf = (temporaryId, label, suggestedCode, type, extra = {}) => ({ temporaryId, label, suggestedCode, type, typeValid: true, required: false, options: [], reason: '', evidenceIds: [], alternativeExistingFieldCode: null, codeConflict: false, labelDuplicate: false, ...extra });
const plan = (steps, proposedFields = [], extra = {}) => ({ planVersion: '1', requestId: 'tk-t2', goal: 'g', assessment: { summary: '' }, relevantFields: [], proposedFields, steps, alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', ...extra });

const DATA = FX.makeData();
const DEPS = KTDeps.buildDependencyData(DATA, KTDeps.normalizeFields(DATA.fields));
const reviewOf = (p) => R.review({ plan: p, data: DATA, deps: DEPS, scan: null, incoming: null });
const approveAll = (p, rv) => R.executorOutput(p, rv, p.steps.map(s => s.id));
const st0 = (rv) => rv.steps[0];
const codes0 = (rv) => rv.steps[0].issues.map(i => i.code);
const run = async (input, mock, { review = null } = {}) => { const prepared = await E.prepare(input, { api: mock.api, appId: '341' }); const log = prepared.status === 'PREPARED' ? await E.executePreview(prepared, { api: mock.api, review, data: DATA }) : null; return { prepared, log }; };
const check = (log, name) => log.steps[0].verification?.checks?.find(c => c.name === name);

(async () => {
console.log('\n--- 1. ADD_NOTIFICATION（レコードの条件通知）---');
{
  // add unique: 既存 2 件 ＋ 新規 1 件 = 3 件（FIELD_ENTITY の通知先）
  const p = plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', '担当者設定通知', { name: '担当者設定通知', targets: ['FIELD_ENTITY:owner'], filterCond: 'owner not in ("")' })]);
  const rv = reviewOf(p); const mock = makeKintoneMock(DATA);
  assert(st0(rv).diff.after.scope === 'perRecord' && !codes0(rv).some(c => /^COND_/.test(c)), '前提: Review は perRecord・条件式は受理される');
  const { prepared, log } = await run(approveAll(p, rv), mock, { review: rv });
  assert(prepared.status === 'PREPARED' && prepared.steps[0].prepared.payload.scope === 'perRecord' && prepared.steps[0].prepared.payload.entries[0].targets[0].entity.type === 'FIELD_ENTITY' && prepared.steps[0].prepared.payload.entries[0].targets[0].entity.code === 'owner', 'prepare: scope をレコードの条件通知に解決・FIELD_ENTITY:owner → entity { FIELD_ENTITY, owner }');
  assert(log.status === 'DONE' && log.steps[0].status === 'VERIFIED' && mock.st.perRecord.length === 3 && mock.st.perRecord[2].filterCond === 'owner not in ("")' && mock.st.perRecord[2].targets[0].entity.code === 'owner' && mock.st.general.length === 5, '反映: 既存 2 件を保持して 3 件目として追加（アプリの条件通知 5 件は触らない）');
  assert(log.steps[0].requests[0].path.endsWith('/perRecord.json') && log.steps[0].requests[0].existing === 2 && log.steps[0].requests[0].total === 3 && log.steps[0].before.count === 2 && log.steps[0].after.count === 3, 'full payload: 現在の設定 ＋ 承認分 = 完全な After payload（before 2 → after 3）');
  const v = log.steps[0].verification;
  assert(v.ok && ['existingCountBefore', 'existingPreserved', 'addedCount', 'unexpectedRemoved', 'unexpectedChanged', 'exists', 'condition', 'recipients', 'title'].every(n => v.checks.find(c => c.name === n)?.ok) && check(log, 'existingCountBefore').actual === 2 && check(log, 'addedCount').actual === 1, 'verification: existingCountBefore 2 / existingPreserved / addedCount 1 / unexpectedRemoved 0 / unexpectedChanged 0 / 新規通知の条件・通知先・タイトル');
  assert(log.simulation.compared && log.simulation.match === true, 'Simulation（Review の After の通知）と実際が一致');
  const rb = E.buildRollbackPlan(log, prepared);
  assert(rb.steps[0].actionType === 'RESTORE_NOTIFICATION_SETTINGS' && /2 件/.test(rb.steps[0].note) && rb.executed === false, 'rollback 計画: RESTORE_NOTIFICATION_SETTINGS（実行しない）');
  const audit = E.buildAudit({ plan: p, review: rv, prepared, execution: log });
  assert(audit.beforeAfter[0].before.count === 2 && audit.beforeAfter[0].after.count === 3 && audit.beforeSnapshot.perRecordNotify.notifications.length === 2, 'Audit: notification before / after と snapshot 参照');
}
{
  // exact duplicate: 既存「高額案件の登録」と同一 → Review で DUPLICATE（INVALID ではなく要確認）→ 承認しても Executor は EXACT_DUPLICATE で止める
  const p = plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', '高額案件', { name: '高額案件の登録', targets: ['USER:user1', 'FIELD_ENTITY:approver', 'FIELD_ENTITY:owner_org'], filterCond: 'amount >= "1000000"' })]);
  const rv = reviewOf(p); const mock = makeKintoneMock(DATA);
  assert(codes0(rv).includes('DUPLICATE'), '前提: Review が DUPLICATE');
  const prepared = await E.prepare(approveAll(p, rv), { api: mock.api, appId: '341' });
  assert(prepared.status === 'BLOCKED' && prepared.steps[0].status === 'BLOCKED' && prepared.steps[0].reason === 'EXACT_DUPLICATE' && mock.calls.every(c => c.startsWith('GET')), 'exact duplicate: 実行直前の再チェックで EXACT_DUPLICATE → 実行しない・書き込みなし');
}
{
  // possible duplicate: 既存と通知先が重なり条件が同じ（タイトル違い）→ 警告付きで最終確認へ
  const p = plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', '高額案件アラート', { name: '高額案件アラート', targets: ['FIELD_ENTITY:approver'], filterCond: 'amount >= "1000000"' })]);
  const rv = reviewOf(p); const mock = makeKintoneMock(DATA);
  const prepared = await E.prepare(approveAll(p, rv), { api: mock.api, appId: '341' });
  assert(prepared.status === 'PREPARED' && prepared.steps[0].status === 'PENDING' && prepared.steps[0].warnings?.[0]?.code === 'POSSIBLE_DUPLICATE' && prepared.steps[0].warnings[0].existing.title === '高額案件の登録', 'possible duplicate: PENDING のまま warnings に POSSIBLE_DUPLICATE（最終確認で再度人間に見せる）');
}
{
  // missing recipient field / invalid recipient type / invalid condition / ambiguous scope
  const p1 = plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', 'x', { name: 'x', targets: ['FIELD_ENTITY:ghost'], filterCond: 'amount >= "1"' })]);
  const rv1 = reviewOf(p1);
  assert(st0(rv1).status === 'INVALID' && R.executorOutput(p1, rv1, ['P1']).approvedSteps.length === 0, '存在しないフィールドの通知先は Review で INVALID');
  const p2 = plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', 'x', { name: 'x', targets: ['FIELD_ENTITY:case_name'], filterCond: 'amount >= "1"' })]);
  const rv2 = reviewOf(p2); const m2 = makeKintoneMock(DATA);
  const pr2 = await E.prepare(approveAll(p2, rv2), { api: m2.api, appId: '341' });
  assert(pr2.steps[0].status === 'UNSUPPORTED' && pr2.steps[0].reason === 'RECIPIENT_FIELD_INVALID', '文字列フィールドを通知先にした → RECIPIENT_FIELD_INVALID（通知先に使える型だけ）');
  const p3 = plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', 'x', { name: 'x', targets: ['FIELD_ENTITY:owner'], filterCond: 'owner != ""' })]);
  const rv3 = reviewOf(p3); const m3 = makeKintoneMock(DATA);
  const pr3 = await E.prepare(approveAll(p3, rv3), { api: m3.api, appId: '341' });
  assert(codes0(rv3).includes('COND_INVALID') && pr3.steps[0].status === 'BLOCKED' && pr3.steps[0].reason === 'INVALID_CONDITION' && m3.calls.length === 0, 'invalid condition（USER_SELECT に !=）: Review が COND_INVALID → Executor は API に投げず INVALID_CONDITION で停止');
  const p4 = plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', 'x', { name: 'x', targets: ['FIELD_ENTITY:owner'], filterCond: 'amount >= "1"', events: ['recordEdited'] })]);
  const rv4 = reviewOf(p4); const m4 = makeKintoneMock(DATA);
  const pr4 = await E.prepare(approveAll(p4, rv4), { api: m4.api, appId: '341' });
  assert(pr4.steps[0].status === 'UNSUPPORTED' && pr4.steps[0].reason === 'NOTIFICATION_SCOPE_AMBIGUOUS', '条件式とイベントの両方 → どちらの通知か決められず実行しない（REQUIRE_CONFIRMATION 相当）');
  // staging E2E（app 343）: AI が存在しないイベント名（recordAdd）を条件通知に添えた → 不明なイベントは曖昧さの根拠にしない（Review が要確認・After から除外済み）
  const p5 = plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', 'x', { name: 'x', targets: ['FIELD_ENTITY:owner'], filterCond: 'amount >= "1"', events: ['recordAdd', 'recordEdit'] })]);
  const rv5 = reviewOf(p5); const m5 = makeKintoneMock(DATA);
  const pr5 = await E.prepare(approveAll(p5, rv5), { api: m5.api, appId: '341' });
  assert(codes0(rv5).includes('NOTIFICATION_EVENT_UNKNOWN') && pr5.steps[0].status === 'PENDING' && pr5.steps[0].prepared.payload.scope === 'perRecord', '不明なイベント名だけなら曖昧ではない → レコードの条件通知として実行可（Review は要確認）');
}
{
  // アプリの条件通知（events）: 既存 5 件 ＋ 1 件・notifyToCommenter を保持
  const p = plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', 'x', { name: 'x', targets: ['FIELD_ENTITY:owner_group'], events: ['recordAdded', 'statusChanged'] })]);
  const rv = reviewOf(p); const mock = makeKintoneMock(DATA); mock.st.notifyToCommenter = true;
  const { prepared, log } = await run(approveAll(p, rv), mock, { review: rv });
  assert(prepared.steps[0].prepared.payload.scope === 'general' && log.status === 'DONE' && mock.st.general.length === 6 && mock.st.general[5].entity.code === 'owner_group' && mock.st.general[5].recordAdded && mock.st.general[5].statusChanged && !mock.st.general[5].recordEdited && mock.st.notifyToCommenter === true, 'アプリの条件通知: scope general・イベントのフラグ・既存 5 件と notifyToCommenter を保持');
  assert(check(log, 'event').ok && check(log, 'recipients').ok && check(log, 'existingPreserved').ok && log.simulation.match === true, 'verification: event / recipients / 既存保持・Simulation 一致');
}
{
  // verification mismatch（API 200 だが既存が 1 件抜ける mutant）→ VERIFY_FAILED・unexpectedRemoved 1
  const p = plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', 'y', { name: 'y', targets: ['FIELD_ENTITY:owner'], filterCond: 'amount >= "7"' })]);
  const rv = reviewOf(p); const mock = makeKintoneMock(DATA); mock.ctl.dropOneExistingOnPut = 'perRecord';
  const { log } = await run(approveAll(p, rv), mock, { review: rv });
  assert(log.steps[0].status === 'VERIFY_FAILED' && check(log, 'unexpectedRemoved').actual === 1 && check(log, 'existingPreserved').ok === false && log.status === 'FAILED', '既存 1 件が抜ける mutant を検出（unexpectedRemoved 1 → VERIFY_FAILED）');
}
{
  // stale notification config: Review 後に通知設定が変わった → STALE_PLAN
  const p = plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', 'z', { name: 'z', targets: ['FIELD_ENTITY:owner'], filterCond: 'amount >= "9"' })]);
  const rv = reviewOf(p); const mock = makeKintoneMock(DATA); mock.st.perRecord[0].filterCond = 'amount >= "2000000"';
  const prepared = await E.prepare(approveAll(p, rv), { api: mock.api, appId: '341' });
  assert(prepared.status === 'BLOCKED' && prepared.blockers.some(b => b.code === 'STALE_PLAN') && prepared.stale.diffs.some(d => d.kind === 'NOTIFICATION'), 'stale: 通知設定の変更を検出 → STALE_PLAN');
  const m2 = makeKintoneMock(DATA); m2.st.general.push({ entity: { type: 'USER', code: 'user9' }, includeSubs: false, recordAdded: true, recordEdited: false, commentAdded: false, statusChanged: false, fileImported: false });
  const pr2 = await E.prepare(approveAll(p, rv), { api: m2.api, appId: '341' });
  assert(pr2.status === 'BLOCKED' && pr2.stale.diffs.some(d => d.kind === 'NOTIFICATION' && d.change === 'ADDED'), 'stale: アプリの条件通知の追加（未反映の変更）も検出');
}

console.log('\n--- 2. ADD_REMINDER ---');
{
  const p = plan([step('P1', 'ADD_REMINDER', 'REMINDER', '期限30日前', { name: '期限30日前', timingField: 'due_date', daysLater: '-30', time: '09:00', targets: ['FIELD_ENTITY:owner'], filterCond: 'ステータス not in ("完了")' })]);
  const rv = reviewOf(p); const mock = makeKintoneMock(DATA);
  assert(st0(rv).safety !== 'BLOCKED' && !codes0(rv).some(c => /^COND_/.test(c)), '前提: Review OK');
  const { prepared, log } = await run(approveAll(p, rv), mock, { review: rv });
  const e = prepared.steps[0].prepared.payload.entries[0];
  assert(prepared.status === 'PREPARED' && e.timing.code === 'due_date' && e.timing.daysLater === '-30' && e.timing.time === '09:00' && e.targets[0].entity.code === 'owner' && e.filterCond === 'ステータス not in ("完了")', 'prepare: base date field / timing / days / recipients / condition を構造化');
  assert(log.status === 'DONE' && log.steps[0].status === 'VERIFIED' && mock.st.reminders.length === 2 && mock.st.reminders[0].title === '期限前日のリマインド' && mock.st.timezone === 'Asia/Tokyo', '反映: 既存 1 件 ＋ 新規 = 2 件・timezone 保持');
  assert(['exists', 'timing', 'recipients', 'condition', 'existingPreserved', 'addedCount'].every(n => check(log, n)?.ok) && log.simulation.match === true, 'verification: reminder存在 / timing / recipients / condition / 既存維持・Simulation 一致');
  assert(E.buildRollbackPlan(log, prepared).steps[0].actionType === 'RESTORE_REMINDER_SETTINGS', 'rollback: RESTORE_REMINDER_SETTINGS');
}
{
  const bad = plan([step('P1', 'ADD_REMINDER', 'REMINDER', 'x', { name: 'x', timingField: 'case_name', daysLater: '-1', time: '09:00', targets: ['FIELD_ENTITY:owner'] })]);
  const rv = reviewOf(bad);
  assert(st0(rv).status === 'INVALID' && codes0(rv).includes('REMINDER_FIELD_TYPE') && R.executorOutput(bad, rv, ['P1']).approvedSteps.length === 0, 'invalid base field（文字列）→ Review INVALID（BLOCK）');
  const noTime = plan([step('P1', 'ADD_REMINDER', 'REMINDER', 'x', { name: 'x', timingField: 'due_date', daysLater: '-3', targets: ['FIELD_ENTITY:owner'] })]);
  const rvT = reviewOf(noTime); const mT = makeKintoneMock(DATA);
  const prT = await E.prepare(approveAll(noTime, rvT), { api: mT.api, appId: '341' });
  assert(prT.steps[0].status === 'UNSUPPORTED' && prT.steps[0].reason === 'REMINDER_TIME_MISSING', '通知時刻が無い → REMINDER_TIME_MISSING（勝手に決めない）');
  const dup = plan([step('P1', 'ADD_REMINDER', 'REMINDER', '期限前日のリマインド', { name: '期限前日のリマインド', timingField: 'due_date', daysLater: '-1', time: '09:00', targets: ['FIELD_ENTITY:owner', 'FIELD_ENTITY:owner_group', 'USER:user1'], filterCond: 'amount > "0"' })]);
  const rvD = reviewOf(dup); const mD = makeKintoneMock(DATA);
  const prD = await E.prepare({ ...R.executorOutput(dup, rvD, ['P1']), approvedSteps: ['P1'] }, { api: mD.api, appId: '341' });
  assert(prD.steps[0].status === 'BLOCKED' && ['EXACT_DUPLICATE', 'INVALID_CONDITION', 'REVIEW_BLOCKED'].includes(prD.steps[0].reason), `duplicate reminder: 実行しない（${prD.steps[0].reason}）`);
  const poss = plan([step('P1', 'ADD_REMINDER', 'REMINDER', '期限3日前', { name: '期限3日前', timingField: 'due_date', daysLater: '-3', time: '10:00', targets: ['FIELD_ENTITY:owner'] })]);
  const rvP = reviewOf(poss); const mP = makeKintoneMock(DATA);
  const prP = await E.prepare(approveAll(poss, rvP), { api: mP.api, appId: '341' });
  assert(prP.steps[0].status === 'PENDING' && prP.steps[0].warnings?.[0]?.code === 'POSSIBLE_DUPLICATE', 'possible duplicate（同じ基準日・通知先が重なる）→ 警告付きで実行可');
  const cr = plan([step('P1', 'ADD_REMINDER', 'REMINDER', 'c', { name: 'c', timingField: 'due_date', daysLater: '1', time: '08:00', targets: ['CREATOR'] })]);
  const rvC = reviewOf(cr); const mC = makeKintoneMock(DATA);
  const prC = await E.prepare(approveAll(cr, rvC), { api: mC.api, appId: '341' });
  assert(prC.steps[0].prepared?.payload.entries[0].targets[0].entity.code === '作成者' && prC.steps[0].prepared.payload.entries[0].targets[0].entity.type === 'FIELD_ENTITY', 'recipient resolution: CREATOR → FIELD_ENTITY 作成者');
  const stale = makeKintoneMock(DATA); stale.st.reminders[0].timing.daysLater = '-2';
  const prS = await E.prepare(approveAll(poss, rvP), { api: stale.api, appId: '341' });
  assert(prS.status === 'BLOCKED' && prS.stale.diffs.some(d => d.kind === 'REMINDER'), 'stale: リマインダー設定の変更を検出');
  const mut = makeKintoneMock(DATA); mut.ctl.mangleReminderTime = true;
  const rM = await run(approveAll(poss, rvP), mut, { review: rvP });
  assert(rM.log.steps[0].status === 'VERIFY_FAILED' && check(rM.log, 'timing').ok === false, 'verification: 反映後の timing が期待と違えば VERIFY_FAILED');
}

console.log('\n--- 3. UPDATE_FIELD（表示名・必須のみ）---');
{
  const req = plan([step('P1', 'UPDATE_FIELD', 'FIELD', 'owner', { required: true })]);
  const rv = reviewOf(req); const mock = makeKintoneMock(DATA);
  assert(st0(rv).safety === 'REVIEW_REQUIRED' && st0(rv).diff.before.required === false && st0(rv).diff.after.required === true, '前提: Review は REVIEW_REQUIRED・Before 必須いいえ → After はい');
  const { prepared, log } = await run(approveAll(req, rv), mock, { review: rv });
  const pp = prepared.steps[0].prepared;
  assert(prepared.status === 'PREPARED' && pp.payload.code === 'owner' && same(pp.payload.changes, { required: true }) && pp.sensitive[0].code === 'REQUIRED_CHANGE' && /今後の保存時に入力必須になります/.test(pp.sensitive[0].message) && /既存レコードに値が入っているかは確認していません/.test(pp.sensitive[0].message), 'required only: payload は required だけ・注意は計画の検査の指摘（今後の保存時に必須 / 既存レコードは未確認）');
  assert(log.status === 'DONE' && log.steps[0].status === 'VERIFIED' && mock.st.fields.owner.required === true && mock.st.fields.owner.type === 'USER_SELECT' && mock.st.fields.owner.label === '担当者' && same(mock.st.fields.owner.entities, DATA.fields.owner.entities), '反映: required だけ変わり type / label / entities は保持');
  assert(['exists', 'codePreserved', 'typePreserved', 'changed:required', 'otherPropertiesPreserved', 'existingFieldsPreserved'].every(n => check(log, n)?.ok) && log.steps[0].before.required === false && log.steps[0].after.required === true && log.simulation.match === true, 'verification: code / type 不変・requested attribute だけ変更・その他保持・before / after・Simulation 一致');
  assert(E.buildRollbackPlan(log, prepared).steps[0].actionType === 'RESTORE_FIELD_PROPERTY' && E.buildRollbackPlan(log, prepared).steps[0].api.payload.properties.owner.required === false, 'rollback: RESTORE_FIELD_PROPERTY（required を false に戻す計画）');
}
{
  const lab = plan([step('P1', 'UPDATE_FIELD', 'FIELD', 'owner', { name: '営業担当者' })]);
  const rv = reviewOf(lab); const mock = makeKintoneMock(DATA);
  const { prepared, log } = await run(approveAll(lab, rv), mock, { review: rv });
  assert(prepared.steps[0].prepared.sensitive[0].code === 'LABEL_CHANGE' && /フィールドコード（owner）は変わりません/.test(prepared.steps[0].prepared.sensitive[0].message) && log.steps[0].status === 'VERIFIED' && mock.st.fields.owner.label === '営業担当者' && mock.st.fields.owner.code === 'owner' && mock.st.fields.owner.required === false, 'label only: 表示名だけ変更・コード不変の明記');
  const both = plan([step('P1', 'UPDATE_FIELD', 'FIELD', 'owner', { name: '営業担当者', required: true })]);
  const rvB = reviewOf(both); const mB = makeKintoneMock(DATA);
  const rB = await run(approveAll(both, rvB), mB, { review: rvB });
  assert(rB.log.steps[0].status === 'VERIFIED' && mB.st.fields.owner.label === '営業担当者' && mB.st.fields.owner.required === true && Object.keys(rB.prepared.steps[0].prepared.payload.changes).sort().join() === 'label,required', 'label + required');
}
{
  const typ = plan([step('P1', 'UPDATE_FIELD', 'FIELD', 'amount', { fieldType: 'SINGLE_LINE_TEXT' })]);
  const rv = reviewOf(typ); const mock = makeKintoneMock(DATA);
  const pr = await E.prepare({ ...R.executorOutput(typ, rv, ['P1']), approvedSteps: ['P1'] }, { api: mock.api, appId: '341' });
  assert(pr.steps[0].status !== 'PENDING' && (pr.steps[0].reason === 'FIELD_CHANGE_NOT_SUPPORTED' || pr.steps[0].reason === 'REVIEW_BLOCKED') && mock.calls.every(c => c.startsWith('GET')), 'unsupported type change → 実行しない');
  const opt = plan([step('P1', 'UPDATE_FIELD', 'FIELD', 'kind', { options: ['A'] })]);
  const rvO = reviewOf(opt); const mO = makeKintoneMock(DATA);
  const prO = await E.prepare({ ...R.executorOutput(opt, rvO, ['P1']), approvedSteps: ['P1'] }, { api: mO.api, appId: '341' });
  assert(prO.steps[0].status !== 'PENDING', '選択肢の変更は実行しない');
  // field code change rejection: diff.after.code を書き換えた Review を与えても拒否（2026-10-21: コードは表示名・必須以外の変更として、分類で反映しない）
  const rvC = clone(rv); rvC.steps[0].diff.after = { ...rvC.steps[0].diff.before, code: 'amount2' }; rvC.steps[0].status = 'VALID'; rvC.steps[0].safety = 'REVIEW_REQUIRED';
  const prC = await E.prepare({ plan: typ, review: rvC, approvedSteps: ['P1'] }, { api: makeKintoneMock(DATA).api, appId: '341' });
  assert(prC.steps[0].status === 'UNSUPPORTED' && prC.steps[0].reason === 'FIELD_CHANGE_NOT_SUPPORTED' && /code/.test(prC.steps[0].message), 'field code change rejection');
  //   2026-10-21: 渡された計画の検査の結果の書き込む値（表示名）を書き換えても、書き込む内容は取り直した設定に対する計画の検査から作る。書き換えた結果と違うので止まり、書き込まない
  const req2 = plan([step('P1', 'UPDATE_FIELD', 'FIELD', 'owner', { required: true })]);
  const rvT = reviewOf(req2); rvT.steps[0].diff.after = { ...rvT.steps[0].diff.after, label: '書き換えた表示名' };
  const mT = makeKintoneMock(DATA);
  const prT = await E.prepare(approveAll(req2, rvT), { api: mT.api, appId: '341' });
  assert(prT.status === 'BLOCKED' && prT.steps[0].status === 'BLOCKED' && prT.steps[0].reason === 'REVALIDATION_FAILED' && same(prT.steps[0].prepared.payload.changes, { required: true }) && mT.calls.every(c => c.startsWith('GET')),
    '計画の検査の結果を書き換えても: 書き込む内容（必須だけ）は取り直した設定に対する計画の検査から作り、計画の検査のときの内容と違うので止める（書き込みなし）');
  // stale field: Review 後に label が変わっていた
  const lab = plan([step('P1', 'UPDATE_FIELD', 'FIELD', 'owner', { required: true })]);
  const rvL = reviewOf(lab); const mL = makeKintoneMock(DATA); mL.st.fields.owner.label = '担当者（変更済み）';
  const prL = await E.prepare(approveAll(lab, rvL), { api: mL.api, appId: '341' });
  assert(prL.status === 'BLOCKED' && prL.stale.diffs.some(d => d.id === 'owner' && d.change === 'CHANGED'), 'stale field → STALE_PLAN');
  // apply 直前に値が変わった（prepare 後）→ TARGET_CHANGED で失敗・当て直さない
  const mX = makeKintoneMock(DATA);
  const prX = await E.prepare(approveAll(lab, rvL), { api: mX.api, appId: '341' });
  mX.st.fields.owner.required = true; mX.st.revision += 1;
  const lgX = await E.executePreview(prX, { api: mX.api, review: rvL });
  assert(lgX.steps[0].status === 'FAILED' && ['TARGET_CHANGED', 'REVISION_MISMATCH'].includes(lgX.steps[0].reason), `prepare 後の変更 → 失敗（${lgX.steps[0].reason}）`);
  // unexpected mutation: モックが他の属性も変えてしまう → VERIFY_FAILED
  const mM = makeKintoneMock(DATA); const origUpdate = mM.api.updatePreviewFields; mM.api.updatePreviewFields = async (a, props, rev) => { const r = await origUpdate(a, props, rev); mM.st.fields.owner.noLabel = true; return r; };
  const rM = await run(approveAll(lab, rvL), mM, { review: rvL });
  assert(rM.log.steps[0].status === 'VERIFY_FAILED' && check(rM.log, 'otherPropertiesPreserved').ok === false && check(rM.log, 'otherPropertiesPreserved').actual.includes('noLabel'), 'unexpected mutation（noLabel が変わった）→ VERIFY_FAILED');
}

console.log('\n--- 4. Combined plan（DAG）・full payload safety ---');
{
  const p = plan([
    step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'DATE' }),
    step('P2', 'UPDATE_FIELD', 'FIELD', 'NEW_FIELD_1', { required: true }, { dependsOn: ['P1'] }),
    step('P3', 'ADD_REMINDER', 'REMINDER', '更新期限30日前', { name: '更新期限30日前', timingField: 'NEW_FIELD_1', daysLater: '-30', time: '09:00', targets: ['FIELD_ENTITY:owner'] }, { dependsOn: ['P1'] }),
    step('P4', 'ADD_NOTIFICATION', 'NOTIFICATION', '更新期限設定通知', { name: '更新期限設定通知', targets: ['FIELD_ENTITY:owner'], filterCond: 'NEW_FIELD_1 >= TODAY()' }, { dependsOn: ['P1'] }),
  ], [pf('NEW_FIELD_1', '更新期限', 'renewal_date', 'DATE')]);
  const rv = reviewOf(p); const mock = makeKintoneMock(DATA);
  assert(rv.steps.every(r => r.safety !== 'BLOCKED') && rv.steps[2].diff.after.timing.code === 'renewal_date' && rv.steps[3].diff.after.filterCond === 'renewal_date >= TODAY()', '前提: Review は temporary field を実コードに解決（リマインダーの基準日・通知の条件）');
  const { prepared, log } = await run(approveAll(p, rv), mock, { review: rv });
  assert(prepared.status === 'PREPARED' && prepared.summary.executable === 4 && prepared.temporaryIdMap.NEW_FIELD_1 === 'renewal_date', 'prepare: 4 step 実行可能・temporaryId → renewal_date');
  assert(log.status === 'DONE' && log.steps.map(s => `${s.stepId}:${s.status}`).join() === 'P1:VERIFIED,P2:VERIFIED,P3:VERIFIED,P4:VERIFIED', `DAG: P1 → P2 / P3 / P4 すべて VERIFIED（${log.steps.map(s => s.stepId + ':' + s.status).join()}）`);
  const order = mock.calls.filter(c => /^(POST|PUT)/.test(c));
  assert(order.join(' | ') === 'POST fields | PUT fields | PUT reminders | PUT perRecord', `API 順序: フィールド追加 → 必須化 → リマインダー → 通知（${order.join(' | ')}）`);
  assert(mock.st.fields.renewal_date.required === true && mock.st.reminders[1].timing.code === 'renewal_date' && mock.st.perRecord[2].filterCond === 'renewal_date >= TODAY()' && mock.st.reminders.length === 2 && mock.st.perRecord.length === 3, '実コードで反映され、既存の通知 2 件・リマインダー 1 件は保持');
  assert(log.simulation.match === true && log.reanalysis.after.fields === log.reanalysis.before.fields + 1, 'Simulation 一致・再解析');
  // P1 が失敗 → 依存する P2 / P3 / P4 は未実行
  const m2 = makeKintoneMock(DATA); m2.ctl.failAddField = 'renewal_date';
  const r2 = await run(approveAll(p, rv), m2, { review: rv });
  assert(r2.log.steps.map(s => s.status).join() === 'FAILED,SKIPPED,SKIPPED,SKIPPED' && m2.st.reminders.length === 1 && m2.st.perRecord.length === 2, 'failed dependency: P1 失敗 → 以降未実行・設定は変わらない');
}
{
  // full payload safety: existing 5 + new 1 → 6（アプリの条件通知で既存を 5 件に）
  const data5 = clone(DATA);   // fixture のアプリの条件通知は 5 件
  const p = plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', 'x', { name: 'x', targets: ['FIELD_ENTITY:owner_org'], events: ['commentAdded'] })]);
  const rv = R.review({ plan: p, data: data5 }); const mock = makeKintoneMock(data5);
  assert(mock.st.general.length === 5, '前提: 既存 5 件');
  const { log } = await run(approveAll(p, rv), mock, { review: rv });
  assert(log.steps[0].status === 'VERIFIED' && mock.st.general.length === 6 && check(log, 'existingCountBefore').actual === 5 && check(log, 'addedCount').actual === 1 && check(log, 'unexpectedRemoved').actual === 0, 'existing 5 + new 1 → after 6');
  const mut = makeKintoneMock(data5); mut.ctl.dropOneExistingOnPut = 'general';
  const r2 = await run(approveAll(p, rv), mut, { review: rv });
  assert(r2.log.steps[0].status === 'VERIFY_FAILED' && check(r2.log, 'unexpectedRemoved').actual === 1 && check(r2.log, 'existingPreserved').ok === false, '既存 1 件が抜ける mutant を unexpectedRemoved で検出 → VERIFY_FAILED');
  assert(JSON.stringify(DATA) === JSON.stringify(FX.makeData()), 'DATA 不変');
}

function same(a, b) { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); }
console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
