// KTPlanExecutor Phase 11: 既存設定の変更（UPDATE_NOTIFICATION / UPDATE_REMINDER / UPDATE_VIEW）
//
// 検証内容（§37〜39）:
//   UPDATE_NOTIFICATION: condition change / recipient addition / recipient removal / event removal / stale target（TARGET_CHANGED・STALE_PLAN）/
//     invalid query / unrelated notification preservation（bit 単位）/ verification mismatch
//   UPDATE_REMINDER: timing change / recipient addition / base field change（高リスク・time⇄hoursLater の切替は反映しない）/ invalid field type / stale / preservation / verification
//   UPDATE_VIEW: add displayed field（SAFE）/ remove field / filter change / sort change / missing field / stale / all other views preserved / 表形式以外
//
// 実行方法: node tests/ai-plan-executor-update.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { KTDeps, KTPlanReview, KTPlanExecutor } = loadToolkit();
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const E = KTPlanExecutor, R = KTPlanReview;

const clone = (v) => JSON.parse(JSON.stringify(v));
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], ...o });
const step = (id, actionType, targetKind, targetRef, sp = {}, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: true, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PREVIEW_SUPPORTED', supported: true, reason: 'x' }, ...extra });
const plan = (steps, proposedFields = [], extra = {}) => ({ planVersion: '1', requestId: 'tk-p11', goal: 'g', assessment: { summary: '' }, relevantFields: [], proposedFields, steps, alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', ...extra });

const DATA = FX.makeData();
const DEPS = KTDeps.buildDependencyData(DATA, KTDeps.normalizeFields(DATA.fields));
const reviewOf = (p, data = DATA) => R.review({ plan: p, data, deps: data === DATA ? DEPS : null, scan: null, incoming: null });
const approveAll = (p, rv) => R.executorOutput(p, rv, p.steps.map(s => s.id));
const run = async (input, mock, { review = null, between = null } = {}) => { const prepared = await E.prepare(input, { api: mock.api, appId: '341' }); if (between && prepared.status === 'PREPARED') between(prepared); const log = prepared.status === 'PREPARED' ? await E.executePreview(prepared, { api: mock.api, review }) : null; return { prepared, log }; };
const check = (log, name, i = 0) => log.steps[i].verification?.checks?.find(c => c.name === name);
const okNames = (log, names, i = 0) => names.every(n => check(log, n, i)?.ok === true);
const PRESERVE = ['existingCountBefore', 'countPreserved', 'otherEntriesPreserved', 'unexpectedRemoved', 'unexpectedChanged', 'targetExists', 'unchangedAttributesPreserved'];

(async () => {
console.log('\n--- 1. UPDATE_NOTIFICATION ---');
{
  // condition change: perRecord#1（高額案件の登録）の条件 100 万 → 200 万。他の属性・他の通知は bit 単位でそのまま
  const p = plan([step('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', 'perRecord#1', { filterCond: 'amount >= "2000000"' })]);
  const rv = reviewOf(p); const mock = makeKintoneMock(DATA); const before = clone(mock.st.perRecord);
  assert(rv.steps[0].status === 'NEEDS_CONFIRMATION' && rv.steps[0].safety === 'REVIEW_REQUIRED' && rv.steps[0].diff.target.identity.index === 0, '前提: Review は要確認・identity index 0');
  const { prepared, log } = await run(approveAll(p, rv), mock, { review: rv });
  const pp = prepared.steps[0].prepared;
  assert(prepared.status === 'PREPARED' && pp.payload.scope === 'perRecord' && pp.payload.index === 0 && Object.keys(pp.payload.changes).join() === 'filterCond' && pp.sensitive.some(x => x.code === 'NOTIFICATION_CONDITION_CHANGE') && pp.changeKind === 'UPDATE' && /✎ レコードの条件通知「高額案件の登録」: 条件: amount >= "1000000" → amount >= "2000000"/.test(pp.summary), 'prepare: 変更する属性は条件だけ・条件変更は sensitive（最終確認で警告）・summary は属性単位の差分');
  assert(log.status === 'DONE' && log.steps[0].status === 'VERIFIED' && mock.st.perRecord.length === 2 && mock.st.perRecord[0].filterCond === 'amount >= "2000000"' && mock.st.perRecord[0].title === before[0].title && JSON.stringify(mock.st.perRecord[0].targets) === JSON.stringify(before[0].targets) && JSON.stringify(mock.st.perRecord[1]) === JSON.stringify(before[1]) && mock.st.general.length === 5, '反映: 対象 1 件の条件だけ変わり、名前・通知先（includeSubs 含む）・他の通知はそのまま');
  assert(log.steps[0].requests[0].index === 0 && log.steps[0].requests[0].total === 2 && log.steps[0].requests[0].changedKeys.join() === 'filterCond' && JSON.stringify(log.steps[0].before) === JSON.stringify({ filterCond: 'amount >= "1000000"' }) && JSON.stringify(log.steps[0].after) === JSON.stringify({ filterCond: 'amount >= "2000000"' }), 'full payload: 現在の一覧 → 対象 1 件だけ変更 → 完全な After payload（before / after は変更した属性だけ）');
  assert(okNames(log, [...PRESERVE, 'changed:filterCond']) && check(log, 'existingCountBefore').actual === 2 && check(log, 'countPreserved').actual === 2, 'verification: existingCountBefore 2 / countPreserved / otherEntriesPreserved（bit 単位）/ changed:filterCond / unchangedAttributesPreserved');
  assert(!('simulation' in log) && !('reanalysis' in log), '書いた内容が期待どおりかは手順ごとの読み戻しだけが判定する（照合・再解析の記録は無い。2026-10-21）');
  const rb = E.buildRollbackPlan(log, prepared);
  assert(rb.steps[0].actionType === 'RESTORE_NOTIFICATION_SETTINGS' && rb.steps[0].collection === 'perRecordNotify' && /高額案件の登録/.test(rb.steps[0].note), 'rollback 計画: RESTORE_NOTIFICATION_SETTINGS（perRecordNotify）');
}
{
  // recipient addition: 通知先に owner を追加（既存 3 件の includeSubs を保持し、追加分は includeSubs false）
  const p = plan([step('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', '高額案件の登録', { targets: ['USER:user1', 'FIELD_ENTITY:approver', 'FIELD_ENTITY:owner_org', 'FIELD_ENTITY:owner'] })]);
  const rv = reviewOf(p); const mock = makeKintoneMock(DATA);
  const { prepared, log } = await run(approveAll(p, rv), mock, { review: rv });
  const t = mock.st.perRecord[0].targets;
  assert(log.status === 'DONE' && t.length === 4 && t[2].entity.code === 'owner_org' && t[2].includeSubs === true && t[3].entity.code === 'owner' && t[3].includeSubs === false && mock.st.perRecord[0].filterCond === 'amount >= "1000000"', '通知先の追加: 既存の通知先（includeSubs true の組織）はそのまま・追加分は includeSubs false・条件は変わらない');
  assert(!prepared.steps[0].prepared.sensitive.length && okNames(log, [...PRESERVE, 'changed:targets']), '追加だけなら sensitive なし・verification OK');
}
{
  // recipient removal: 通知先を user1 だけにする → 高リスク警告（sensitive）付きで反映
  const p = plan([step('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', 'perRecord#1', { targets: ['USER:user1'] })]);
  const rv = reviewOf(p); const mock = makeKintoneMock(DATA);
  const { prepared, log } = await run(approveAll(p, rv), mock, { review: rv });
  assert(prepared.steps[0].prepared.sensitive.some(x => x.code === 'NOTIFICATION_RECIPIENTS_REMOVED' && /通知が届かなくなる可能性/.test(x.message)) && log.status === 'DONE' && mock.st.perRecord[0].targets.length === 1 && mock.st.perRecord[0].targets[0].entity.code === 'user1', '通知先の削除: NOTIFICATION_RECIPIENTS_REMOVED を最終確認に出し、反映後は 1 件');
}
{
  // event removal（アプリの条件通知 general#3 = owner）: recordAdded だけにする。他 4 件と notifyToCommenter はそのまま
  const p = plan([step('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', 'general#3', { events: ['recordAdded'] })]);
  const rv = reviewOf(p); const mock = makeKintoneMock(DATA); const before = clone(mock.st.general);
  const { prepared, log } = await run(approveAll(p, rv), mock, { review: rv });
  const g = mock.st.general[2];
  assert(prepared.steps[0].prepared.payload.scope === 'general' && prepared.steps[0].prepared.sensitive.some(x => x.code === 'NOTIFICATION_EVENTS_REMOVED') && log.status === 'DONE' && g.entity.code === 'owner' && g.recordAdded && !g.recordEdited && !g.commentAdded && !g.statusChanged && JSON.stringify(mock.st.general.filter((_, i) => i !== 2)) === JSON.stringify(before.filter((_, i) => i !== 2)) && mock.st.notifyToCommenter === true, 'イベント削除: general#3 のフラグだけ変わり、他 4 件と notifyToCommenter は bit 単位でそのまま');
  assert(okNames(log, [...PRESERVE, 'changed:events']), 'verification OK');
}
{
  // stale target（Review → prepare）: Review 後に対象の条件が変わった → STALE_PLAN（書き込みなし）
  const p = plan([step('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', 'perRecord#1', { targets: ['USER:user1', 'FIELD_ENTITY:approver', 'FIELD_ENTITY:owner_org', 'FIELD_ENTITY:owner'] })]);
  const rv = reviewOf(p); const mock = makeKintoneMock(DATA); mock.st.perRecord[0].filterCond = 'amount >= "5000000"';
  const prepared = await E.prepare(approveAll(p, rv), { api: mock.api, appId: '341' });
  assert(prepared.status === 'BLOCKED' && prepared.blockers.some(b => b.code === 'STALE_PLAN') && mock.calls.every(c => c.startsWith('GET')), 'stale（Review → prepare）: STALE_PLAN・書き込みなし');
  // stale target（prepare → 実行）: 最終確認の間に人間が対象を変えた → TARGET_CHANGED（1 属性でも違えば当て直さない・自動 merge しない）
  const m2 = makeKintoneMock(DATA);
  const r2 = await run(approveAll(p, rv), m2, { review: rv, between: () => { m2.st.perRecord[0].title = '高額案件の登録（改）'; } });
  assert(r2.log.status === 'FAILED' && r2.log.steps[0].status === 'FAILED' && r2.log.steps[0].reason === 'TARGET_CHANGED' && /title/.test(r2.log.steps[0].error.message) && !m2.calls.some(c => c.startsWith('PUT')) && m2.st.perRecord[0].title === '高額案件の登録（改）' && m2.st.perRecord[0].targets.length === 3, 'stale（prepare → 実行）: TARGET_CHANGED で停止・PUT なし・人間の変更はそのまま');
  const m3 = makeKintoneMock(DATA);
  const r3 = await run(approveAll(p, rv), m3, { review: rv, between: () => { m3.st.perRecord[0].targets[2].includeSubs = false; } });
  assert(r3.log.steps[0].status === 'FAILED' && r3.log.steps[0].reason === 'TARGET_CHANGED' && r3.log.steps[0].error.detail.includes('sincePrepare'), 'Review のモデルに無い属性（includeSubs）の変更も、prepare の snapshot との bit 比較で TARGET_CHANGED');
}
{
  // invalid query: USER_SELECT に != → Review が COND_INVALID → Executor は API に投げない
  const p = plan([step('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', 'perRecord#1', { filterCond: 'owner != ""' })]);
  const rv = reviewOf(p); const mock = makeKintoneMock(DATA);
  const prepared = await E.prepare(approveAll(p, rv), { api: mock.api, appId: '341' });
  assert(rv.steps[0].issues.some(i => i.code === 'COND_INVALID') && prepared.steps[0].status === 'BLOCKED' && prepared.steps[0].reason === 'INVALID_CONDITION' && mock.calls.length === 0, 'invalid query: INVALID_CONDITION で停止・API 呼び出しなし');
  // 条件式に LOGINUSER()（レコードの条件通知では使えない）
  const p2 = plan([step('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', 'perRecord#1', { filterCond: 'owner in (LOGINUSER())' })]);
  const rv2 = reviewOf(p2); const m2 = makeKintoneMock(DATA);
  const pr2 = await E.prepare(approveAll(p2, rv2), { api: m2.api, appId: '341' });
  assert(pr2.steps[0].status === 'BLOCKED' && pr2.steps[0].reason === 'INVALID_CONDITION' && m2.calls.length === 0, 'API ごとの制限（LOGINUSER）も Toolkit で止める');
}
{
  // verification mismatch: 他の通知が 1 件抜ける mutant / 他の通知が書き換わる mutant → VERIFY_FAILED
  const p = plan([step('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', 'perRecord#1', { filterCond: 'amount >= "3000000"' })]);
  const rv = reviewOf(p);
  const m1 = makeKintoneMock(DATA); m1.ctl.dropOneExistingOnPut = 'perRecord';
  const r1 = await run(approveAll(p, rv), m1, { review: rv });
  assert(r1.log.steps[0].status === 'VERIFY_FAILED' && r1.log.status === 'FAILED' && check(r1.log, 'countPreserved').ok === false, '既存 1 件が抜ける mutant → VERIFY_FAILED（countPreserved）');
  const m2 = makeKintoneMock(DATA); m2.ctl.mutateList = (what, list) => { if (what === 'perRecord') list[1].title = 'mutated'; return list; };
  const r2 = await run(approveAll(p, rv), m2, { review: rv });
  assert(r2.log.steps[0].status === 'VERIFY_FAILED' && check(r2.log, 'otherEntriesPreserved').ok === false && check(r2.log, 'unexpectedChanged').actual === 1, '他の通知の 1 属性が変わる mutant → VERIFY_FAILED（otherEntriesPreserved・unexpectedChanged 1）');
  const m3 = makeKintoneMock(DATA); m3.ctl.mutateList = (what, list) => { if (what === 'perRecord') list[0].targets = list[0].targets.slice(0, 1); return list; };
  const r3 = await run(approveAll(p, rv), m3, { review: rv });
  assert(r3.log.steps[0].status === 'VERIFY_FAILED' && check(r3.log, 'unchangedAttributesPreserved').ok === false && check(r3.log, 'changed:filterCond').ok === true, '対象の「変更しない属性」が変わる mutant → unchangedAttributesPreserved で検出');
}
{
  // アプリの条件通知の通知先を複数にする → Review INVALID → 実行対象外。同じ値の指定 → NO_CHANGE
  const p = plan([step('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', 'general#3', { targets: ['FIELD_ENTITY:owner', 'USER:user1'] })]);
  const rv = reviewOf(p);
  assert(rv.steps[0].status === 'INVALID' && R.executorOutput(p, rv, ['P1']).approvedSteps.length === 0, 'general の通知先を複数に: INVALID（承認できない）');
  const p2 = plan([step('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', 'general#3', { targets: ['USER:user9'] })]);
  const rv2 = reviewOf(p2); const m2 = makeKintoneMock(DATA);
  const r2 = await run(approveAll(p2, rv2), m2, { review: rv2 });
  assert(r2.log.status === 'DONE' && m2.st.general[2].entity.type === 'USER' && m2.st.general[2].entity.code === 'user9' && m2.st.general[2].recordAdded && m2.st.general[2].commentAdded && m2.st.general.length === 5, 'general の通知先を差し替え（1 件 → 1 件）: イベントのフラグは保持');
}

console.log('\n--- 2. UPDATE_REMINDER ---');
const DATA2 = (() => { const d = FX.makeData(); d.fields.contract_end = { type: 'DATE', code: 'contract_end', label: '契約終了日', required: false }; d.reminderNotify.notifications.push({ timing: { code: 'contract_end', daysLater: '-30', time: '09:00' }, filterCond: 'ステータス not in ("完了")', title: '契約更新リマインダー', targets: [{ entity: { type: 'FIELD_ENTITY', code: 'owner' }, includeSubs: false }] }); return d; })();
{
  // timing change: 契約更新リマインダー（reminder#2）30 日前 → 45 日前。時刻・通知先・条件・他のリマインダーはそのまま
  const p = plan([step('P1', 'UPDATE_REMINDER', 'REMINDER', '契約更新リマインダー', { daysLater: '-45' })]);
  const rv = reviewOf(p, DATA2); const mock = makeKintoneMock(DATA2); const before = clone(mock.st.reminders);
  assert(rv.steps[0].diff.target.id === 'reminder#2' && rv.steps[0].diff.target.identity.index === 1 && rv.steps[0].diff.human[1] === 'タイミング: 30 日前 → 45 日前', '前提: Review は reminder#2 を特定・差分は「30 日前 → 45 日前」');
  const { prepared, log } = await run(approveAll(p, rv), mock, { review: rv });
  const pp = prepared.steps[0].prepared;
  assert(prepared.status === 'PREPARED' && pp.payload.index === 1 && Object.keys(pp.payload.changes).join() === 'timing' && pp.payload.changes.timing.daysLater === '-45' && pp.payload.changes.timing.time === '09:00' && !pp.sensitive.length && /✎ リマインダー「契約更新リマインダー」: タイミング: contract_end の 30 日前 09:00 → contract_end の 45 日前 09:00/.test(pp.summary), 'prepare: 変更は timing だけ・summary は差分');
  assert(log.status === 'DONE' && log.steps[0].status === 'VERIFIED' && mock.st.reminders.length === 2 && mock.st.reminders[1].timing.daysLater === '-45' && mock.st.reminders[1].timing.time === '09:00' && mock.st.reminders[1].timing.code === 'contract_end' && JSON.stringify(mock.st.reminders[1].targets) === JSON.stringify(before[1].targets) && mock.st.reminders[1].filterCond === before[1].filterCond && JSON.stringify(mock.st.reminders[0]) === JSON.stringify(before[0]) && mock.st.timezone === 'Asia/Tokyo', '反映: 日数だけ変わり、時刻・基準日・通知先・条件・他のリマインダー・timezone はそのまま');
  assert(okNames(log, [...PRESERVE, 'changed:timing']), 'verification OK');
  const rb = E.buildRollbackPlan(log, prepared);
  assert(rb.steps[0].actionType === 'RESTORE_REMINDER_SETTINGS' && rb.steps[0].collection === 'reminderNotify', 'rollback 計画: RESTORE_REMINDER_SETTINGS');
}
{
  // recipient addition: 更新担当者（approver）にも通知
  const p = plan([step('P1', 'UPDATE_REMINDER', 'REMINDER', 'reminder#2', { targets: ['FIELD_ENTITY:owner', 'FIELD_ENTITY:approver'] })]);
  const rv = reviewOf(p, DATA2); const mock = makeKintoneMock(DATA2);
  const { log } = await run(approveAll(p, rv), mock, { review: rv });
  assert(log.status === 'DONE' && mock.st.reminders[1].targets.length === 2 && mock.st.reminders[1].targets[1].entity.code === 'approver' && mock.st.reminders[1].timing.daysLater === '-30' && okNames(log, ['changed:targets', 'otherEntriesPreserved']), '通知先の追加: タイミングは変わらない');
}
{
  // base field change（高リスク）: contract_end → due_date（どちらも DATE なので反映できる。sensitive に REMINDER_BASE_FIELD_CHANGE）
  const p = plan([step('P1', 'UPDATE_REMINDER', 'REMINDER', 'reminder#2', { timingField: 'due_date' })]);
  const rv = reviewOf(p, DATA2); const mock = makeKintoneMock(DATA2);
  const { prepared, log } = await run(approveAll(p, rv), mock, { review: rv });
  assert(rv.steps[0].issues.some(i => i.code === 'REMINDER_BASE_FIELD_CHANGE' && i.severity === 'high') && prepared.steps[0].prepared.sensitive.some(x => x.code === 'REMINDER_BASE_FIELD_CHANGE') && log.status === 'DONE' && mock.st.reminders[1].timing.code === 'due_date' && mock.st.reminders[1].timing.daysLater === '-30' && mock.st.reminders[1].timing.time === '09:00', 'base field change: 高リスク警告付きで反映・日数と時刻は保持');
  // 日付 → 日時（作成日時）: 通知時刻の指定方法（time / hoursLater）が変わる → 反映しない
  const p2 = plan([step('P1', 'UPDATE_REMINDER', 'REMINDER', 'reminder#2', { timingField: '作成日時' })]);
  const rv2 = reviewOf(p2, DATA2); const m2 = makeKintoneMock(DATA2);
  const pr2 = await E.prepare(approveAll(p2, rv2), { api: m2.api, appId: '341' });
  assert(pr2.steps[0].status === 'UNSUPPORTED' && pr2.steps[0].reason === 'REMINDER_TIMING_MODE_CHANGE' && !m2.calls.some(c => c.startsWith('PUT')), '日付 → 日時の基準日変更: REMINDER_TIMING_MODE_CHANGE（計画のみ）');
}
{
  // invalid field type: 数値を基準日にする → Review INVALID → 承認できない
  const p = plan([step('P1', 'UPDATE_REMINDER', 'REMINDER', 'reminder#2', { timingField: 'amount' })]);
  const rv = reviewOf(p, DATA2);
  assert(rv.steps[0].status === 'INVALID' && rv.steps[0].issues.some(i => i.code === 'REMINDER_FIELD_TYPE') && R.executorOutput(p, rv, ['P1']).approvedSteps.length === 0, 'invalid field type: INVALID（REMINDER_FIELD_TYPE）');
  // 条件に LOGINUSER（リマインダーでは不可）
  const p2 = plan([step('P1', 'UPDATE_REMINDER', 'REMINDER', 'reminder#2', { filterCond: 'owner in (LOGINUSER())' })]);
  const rv2 = reviewOf(p2, DATA2); const m2 = makeKintoneMock(DATA2);
  const pr2 = await E.prepare(approveAll(p2, rv2), { api: m2.api, appId: '341' });
  assert(pr2.steps[0].status === 'BLOCKED' && pr2.steps[0].reason === 'INVALID_CONDITION', 'リマインダー条件の LOGINUSER: INVALID_CONDITION');
}
{
  // stale: Review 後にリマインダーが変わった → STALE_PLAN / prepare 後に変わった → TARGET_CHANGED
  const p = plan([step('P1', 'UPDATE_REMINDER', 'REMINDER', 'reminder#2', { daysLater: '-45' })]);
  const rv = reviewOf(p, DATA2);
  const m1 = makeKintoneMock(DATA2); m1.st.reminders[1].timing.time = '10:00';
  const pr1 = await E.prepare(approveAll(p, rv), { api: m1.api, appId: '341' });
  assert(pr1.status === 'BLOCKED' && pr1.blockers.some(b => b.code === 'STALE_PLAN') && pr1.stale.diffs.some(d => d.kind === 'REMINDER'), 'stale（Review → prepare）: STALE_PLAN');
  const m2 = makeKintoneMock(DATA2);
  const r2 = await run(approveAll(p, rv), m2, { review: rv, between: () => { m2.st.reminders[1].targets.push({ entity: { type: 'USER', code: 'user9' }, includeSubs: false }); } });
  assert(r2.log.steps[0].status === 'FAILED' && r2.log.steps[0].reason === 'TARGET_CHANGED' && !m2.calls.some(c => c.startsWith('PUT')) && m2.st.reminders[1].targets.length === 2, 'stale（prepare → 実行）: TARGET_CHANGED・人間の変更はそのまま');
}
{
  // verification: 他のリマインダーが書き換わる mutant → VERIFY_FAILED
  const p = plan([step('P1', 'UPDATE_REMINDER', 'REMINDER', 'reminder#2', { daysLater: '-45' })]);
  const rv = reviewOf(p, DATA2); const mock = makeKintoneMock(DATA2); mock.ctl.mutateList = (what, list) => { if (what === 'reminders') list[0].timing.daysLater = '-2'; return list; };
  const { log } = await run(approveAll(p, rv), mock, { review: rv });
  assert(log.steps[0].status === 'VERIFY_FAILED' && check(log, 'otherEntriesPreserved').ok === false && check(log, 'changed:timing').ok === true, '他のリマインダーが変わる mutant → VERIFY_FAILED');
}

console.log('\n--- 3. UPDATE_VIEW ---');
{
  // add displayed field: 承認待ち に amount を追加 → Review SAFE。id / index / 他の一覧は bit 単位でそのまま
  const p = plan([step('P1', 'UPDATE_VIEW', 'VIEW', '承認待ち', { fields: ['case_name', 'approver', 'amount'] })]);
  const rv = reviewOf(p); const mock = makeKintoneMock(DATA); const before = clone(mock.st.views);
  assert(rv.steps[0].status === 'VALID' && rv.steps[0].safety === 'SAFE', '前提: 表示項目の追加だけは SAFE');
  const { prepared, log } = await run(approveAll(p, rv), mock, { review: rv });
  const pp = prepared.steps[0].prepared;
  assert(prepared.status === 'PREPARED' && Object.keys(pp.payload.changes).join() === 'fields' && !pp.sensitive.length && /✎ 一覧「承認待ち」: 表示フィールド: case_name, approver → case_name, approver, amount/.test(pp.summary), 'prepare: 変更は fields だけ');
  assert(log.status === 'DONE' && log.steps[0].status === 'VERIFIED' && mock.st.views['承認待ち'].fields.join() === 'case_name,approver,amount' && mock.st.views['承認待ち'].id === '102' && mock.st.views['承認待ち'].index === '1' && mock.st.views['承認待ち'].filterCond === before['承認待ち'].filterCond && mock.st.views['承認待ち'].sort === before['承認待ち'].sort && JSON.stringify(mock.st.views['顧客別一覧']) === JSON.stringify(before['顧客別一覧']) && Object.keys(mock.st.views).length === 2, '反映: 表示項目だけ変わり、id / index / 絞り込み / 並び順 / 他の一覧はそのまま');
  assert(okNames(log, ['existingCountBefore', 'countPreserved', 'otherViewsPreserved', 'unexpectedRemoved', 'unexpectedChanged', 'targetExists', 'changed:fields', 'unchangedAttributesPreserved', 'idPreserved']), 'verification: otherViewsPreserved / changed:fields / unchangedAttributesPreserved / idPreserved');
  const rb = E.buildRollbackPlan(log, prepared);
  assert(rb.steps[0].actionType === 'RESTORE_VIEWS' && rb.steps[0].collection === 'views', 'rollback 計画: RESTORE_VIEWS');
}
{
  // remove field / filter change / sort change: REVIEW_REQUIRED で反映できる
  const p = plan([
    step('P1', 'UPDATE_VIEW', 'VIEW', '承認待ち', { fields: ['case_name'] }),
    step('P2', 'UPDATE_VIEW', 'VIEW', '顧客別一覧', { filterCond: 'customer_code != "" and amount >= "1"', sort: 'amount desc' }, { dependsOn: ['P1'] }),
  ]);
  const rv = reviewOf(p); const mock = makeKintoneMock(DATA);
  assert(rv.steps[0].safety === 'REVIEW_REQUIRED' && rv.steps[0].issues.some(i => i.code === 'VIEW_FIELDS_REMOVED') && rv.steps[1].issues.some(i => i.code === 'VIEW_FILTER_CHANGE') && rv.steps[1].issues.some(i => i.code === 'VIEW_SORT_CHANGE'), '前提: 削除 / 絞り込み / 並び順は REVIEW_REQUIRED');
  const { prepared, log } = await run(approveAll(p, rv), mock, { review: rv });
  assert(prepared.steps[0].prepared.sensitive.some(x => x.code === 'VIEW_FIELDS_REMOVED') && prepared.steps[1].prepared.sensitive.some(x => x.code === 'VIEW_FILTER_CHANGE'), 'sensitive: 表示項目の削除・絞り込みの変更を最終確認に出す');
  assert(log.status === 'DONE' && mock.st.views['承認待ち'].fields.join() === 'case_name' && mock.st.views['顧客別一覧'].filterCond === 'customer_code != "" and amount >= "1"' && mock.st.views['顧客別一覧'].sort === 'amount desc' && mock.st.views['顧客別一覧'].fields.join() === 'customer_code,case_name,amount,owner', '2 step とも反映（2 回目の PUT は 1 回目の結果を含む完全 payload）');
  assert(okNames(log, ['otherViewsPreserved', 'changed:fields'], 0) && okNames(log, ['otherViewsPreserved', 'changed:filterCond', 'changed:sort'], 1), 'verification OK（両 step）');
}
{
  // missing field: 存在しないフィールド → Review INVALID。Review 後にフィールドが消えた → STALE_PLAN
  const p = plan([step('P1', 'UPDATE_VIEW', 'VIEW', '承認待ち', { fields: ['case_name', 'approver', 'ghost'] })]);
  const rv = reviewOf(p);
  assert(rv.steps[0].status === 'INVALID' && R.executorOutput(p, rv, ['P1']).approvedSteps.length === 0, 'missing field: INVALID');
  const p2 = plan([step('P1', 'UPDATE_VIEW', 'VIEW', '承認待ち', { fields: ['case_name', 'approver', 'amount'] })]);
  const rv2 = reviewOf(p2); const m2 = makeKintoneMock(DATA); delete m2.st.fields.amount;
  const pr2 = await E.prepare(approveAll(p2, rv2), { api: m2.api, appId: '341' });
  assert(pr2.status === 'BLOCKED' && pr2.blockers.some(b => b.code === 'STALE_PLAN'), 'Review 後にフィールドが消えた: STALE_PLAN');
  // invalid filter（USER_SELECT に !=）/ invalid sort
  const p3 = plan([step('P1', 'UPDATE_VIEW', 'VIEW', '承認待ち', { filterCond: 'owner != ""' })]);
  const rv3 = reviewOf(p3); const m3 = makeKintoneMock(DATA);
  const pr3 = await E.prepare(approveAll(p3, rv3), { api: m3.api, appId: '341' });
  assert(pr3.steps[0].status === 'BLOCKED' && pr3.steps[0].reason === 'INVALID_CONDITION' && m3.calls.length === 0, 'invalid filter: INVALID_CONDITION');
  const p4 = plan([step('P1', 'UPDATE_VIEW', 'VIEW', '承認待ち', { sort: 'amount downwards' })]);
  const rv4 = reviewOf(p4); const m4 = makeKintoneMock(DATA);
  const pr4 = await E.prepare(approveAll(p4, rv4), { api: m4.api, appId: '341' });
  assert(pr4.steps[0].status === 'UNSUPPORTED' && pr4.steps[0].reason === 'INVALID_SORT', 'invalid sort: INVALID_SORT（計画のみ）');
}
{
  // stale: Review 後に一覧が変わった → STALE_PLAN / prepare 後 → TARGET_CHANGED
  const p = plan([step('P1', 'UPDATE_VIEW', 'VIEW', '承認待ち', { fields: ['case_name', 'approver', 'amount'] })]);
  const rv = reviewOf(p);
  const m1 = makeKintoneMock(DATA); m1.st.views['承認待ち'].sort = 'case_name asc';
  const pr1 = await E.prepare(approveAll(p, rv), { api: m1.api, appId: '341' });
  assert(pr1.status === 'BLOCKED' && pr1.blockers.some(b => b.code === 'STALE_PLAN') && pr1.stale.diffs.some(d => d.kind === 'VIEW'), 'stale（Review → prepare）: STALE_PLAN');
  const m2 = makeKintoneMock(DATA);
  const r2 = await run(approveAll(p, rv), m2, { review: rv, between: () => { m2.st.views['承認待ち'].fields = ['case_name']; } });
  assert(r2.log.steps[0].status === 'FAILED' && r2.log.steps[0].reason === 'TARGET_CHANGED' && !m2.calls.some(c => c.startsWith('PUT')) && m2.st.views['承認待ち'].fields.join() === 'case_name', 'stale（prepare → 実行）: TARGET_CHANGED・人間の変更はそのまま');
}
{
  // all other views preserved: 他の一覧が書き換わる mutant → VERIFY_FAILED
  const p = plan([step('P1', 'UPDATE_VIEW', 'VIEW', '承認待ち', { fields: ['case_name', 'approver', 'amount'] })]);
  const rv = reviewOf(p); const mock = makeKintoneMock(DATA); mock.ctl.mutateList = (what, list) => { if (what === 'views') list['顧客別一覧'].sort = 'amount asc'; return list; };
  const { log } = await run(approveAll(p, rv), mock, { review: rv });
  assert(log.steps[0].status === 'VERIFY_FAILED' && check(log, 'otherViewsPreserved').ok === false && check(log, 'unexpectedChanged').actual === 1 && check(log, 'changed:fields').ok === true, '他の一覧が変わる mutant → VERIFY_FAILED（otherViewsPreserved）');
}
{
  // 表形式以外（カレンダー）の一覧 → Review は仮適用しない → Executor は VIEW_TYPE_NOT_SUPPORTED
  const d = FX.makeData(); d.views.views['カレンダー'] = { id: '103', name: 'カレンダー', type: 'CALENDAR', index: '2', date: 'due_date', title: 'case_name', filterCond: '', sort: '' };
  const p = plan([step('P1', 'UPDATE_VIEW', 'VIEW', 'カレンダー', { fields: ['case_name'] })]);
  const rv = reviewOf(p, d); const mock = makeKintoneMock(d);
  const prepared = await E.prepare(approveAll(p, rv), { api: mock.api, appId: '341' });
  assert(rv.steps[0].issues.some(i => i.code === 'VIEW_TYPE_NOT_SUPPORTED') && prepared.steps[0].status === 'UNSUPPORTED' && prepared.steps[0].reason === 'VIEW_TYPE_NOT_SUPPORTED', 'カレンダー形式: 計画のみ（Executor も反映しない）');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
