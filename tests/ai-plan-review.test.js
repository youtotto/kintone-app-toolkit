// KTPlanReview（Change Plan Review & Simulation。Phase 8）
//
// 検証内容（§37〜§40）:
//   Field: ADD_FIELD 正常 / コード衝突 / ラベル重複 / UPDATE_FIELD 不存在 / 型変更・選択肢削除（高リスク）
//   Notification: 一意 / 完全一致（DUPLICATE）/ 類似（POSSIBLE_DUPLICATE）  Reminder: 重複
//   Process: ステータス追加 / 重複 / アクション追加 / 重複 / from・to 不明 / 既存アクションの条件制限 / 条件の重なり / 到達不能
//   Lookup: 取得項目の追加 / コピー先重複 / 新規フィールドの解決 / 既存マッピング上書き
//   Dependencies: 正常 / 不正 / 依存先が無効 → BLOCKED_BY_DEPENDENCY / 循環
//   Plan 内部: 同じフィールドを 2 step で追加 / 2 つの通知が重複
//   Safety: SAFE / REVIEW_REQUIRED / BLOCKED / PLAN_ONLY が Action Catalog どおり
//   Impact re-check: 一致 / Planner 不足 / Planner 過剰
//   Simulation: Before → After の順次適用、元の DATA を変更しない、temporaryId の解決、reviewCoverage
//
// 実行方法: node tests/ai-plan-review.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { KTDeps, KTScan, KTPlanReview } = loadToolkit();
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const { buildScanPayload } = require('./helpers/scan-payload.js');
const R = KTPlanReview;

function buildInputs() {
  const data = FX.makeData();
  const fieldsN = KTDeps.normalizeFields(data.fields);
  const deps = KTDeps.buildDependencyData(data, fieldsN);
  const scan = buildScanPayload({ KTScan, KTDeps }, { appId: FX.SELF_APP, files: FX.files, fields: fieldsN.map(f => ({ code: f.code, label: f.label, type: f.rawType })), deps, skippedUrlFiles: FX.skippedUrlFiles });
  KTDeps.mergeScannerEdges(deps, scan);
  KTDeps.applyIncomingRefs(deps, FX.incoming);
  return { data, deps, scan, incoming: FX.incoming };
}
const INPUTS = buildInputs();
const SNAPSHOT = JSON.stringify(INPUTS.data);
const step = (id, actionType, targetKind, targetRef, details = [], extra = {}) => ({ id, actionType, targetKind, targetRef, title: `${id} ${actionType}`, proposal: { summary: '', details: details.map(([key, value]) => ({ key, value })) }, dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, ...extra });
const pf = (temporaryId, label, suggestedCode, type, extra = {}) => ({ temporaryId, label, suggestedCode, type, typeValid: true, required: false, options: [], reason: '', evidenceIds: [], alternativeExistingFieldCode: null, codeConflict: false, labelDuplicate: false, ...extra });
const plan = (steps, proposedFields = [], extra = {}) => ({ planVersion: '1', goal: 'g', assessment: { summary: '' }, relevantFields: [], proposedFields, steps, alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', ...extra });
const review = (p, inputs = INPUTS) => R.review({ plan: p, ...inputs });
const st = (rev, id) => rev.steps.find(s => s.stepId === id);
const codes = (s) => s.issues.map(i => i.code);

(async () => {
console.log('\n--- 1. Before model / Action Catalog ---');
{
  const m = R.buildBeforeModel(INPUTS.data);
  assert(Object.keys(m.fields).length === 23 && m.fields.amount.type === 'NUMBER' && m.fields.customer_lookup.type === 'LOOKUP' && m.fields.customer_lookup.lookup.mappings.length === 2 && m.fields.tax.expression === 'amount * 0.1', 'Before: フィールド（型・ルックアップ・計算式）');
  assert(m.process.enabled && m.process.states.map(s => s.name).join(',') === '未処理,承認待ち,完了' && m.process.actions.length === 3 && m.process.states[1].assignees.some(e => e.type === 'FIELD_ENTITY' && e.code === 'approver'), 'Before: プロセス（ステータス順・作業者・アクション）');
  assert(m.notifications.general.length === 5 && m.notifications.perRecord.length === 2 && m.reminders.length === 1 && m.views.length === 2 && m.acl.record.length === 2 && m.acl.field.length === 2 && m.appActions.length === 1, 'Before: 通知・リマインダー・一覧・ACL・アプリアクション');
  assert(JSON.stringify(INPUTS.data) === SNAPSHOT, 'buildBeforeModel は DATA を変更しない');
  const caps = R.ACTION_CAPABILITIES;
  assert(caps.ADD_FIELD.defaultSafety === 'SAFE' && caps.ADD_VIEW.defaultSafety === 'SAFE' && caps.ADD_REMINDER.defaultSafety === 'SAFE' && caps.ADD_NOTIFICATION.defaultSafety === 'REVIEW_REQUIRED' && caps.UPDATE_PROCESS.defaultSafety === 'REVIEW_REQUIRED' && caps.UPDATE_RECORD_ACL.defaultSafety === 'REVIEW_REQUIRED' && caps.CUSTOMIZATION_REQUIRED.defaultSafety === 'PLAN_ONLY' && caps.REQUIRE_CONFIRMATION.defaultSafety === 'PLAN_ONLY', 'Action Catalog の既定 safety（§17 の表）');
  assert(Object.keys(caps).length === 20 && Object.values(caps).every(c => 'simulate' in c && 'validate' in c && 'defaultSafety' in c && 'execution' in c) && caps.UPDATE_REMINDER.defaultSafety === 'REVIEW_REQUIRED' && caps.UPDATE_NOTIFICATION.defaultSafety === 'REVIEW_REQUIRED' && caps.UPDATE_VIEW.defaultSafety === 'REVIEW_REQUIRED', 'ACTION_CAPABILITIES: 全 actionType（UPDATE_REMINDER を含む 20 件）に simulate / validate / defaultSafety / execution。UPDATE 系の既定は REVIEW_REQUIRED（Phase 11 §33）');
}

console.log('\n--- 2. Field ---');
{
  const r = review(plan([step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', [['フィールドタイプ', 'DATE']])], [pf('NEW_FIELD_1', '契約終了日', 'contract_end', 'DATE')]));
  const s = st(r, 'P1');
  assert(s.status === 'VALID' && s.safety === 'SAFE' && s.diff.changeType === 'ADD' && s.diff.target.id === 'contract_end' && s.diff.before === null && s.diff.after.type === 'DATE' && s.diff.human[0].includes('＋ 新規フィールド') && s.diff.human.includes('衝突なし'), 'ADD_FIELD normal: VALID / SAFE / ADD / human diff');
  assert(r.simulation.after.fields.contract_end && !INPUTS.data.fields.contract_end && JSON.stringify(INPUTS.data) === SNAPSHOT, 'After モデルに追加され、DATA は不変');
  assert(r.executionReadiness.safeSteps.join() === 'P1' && r.summary.counts.additions === 1 && r.summary.status === 'SAFE', 'readiness: safeSteps / counts');
  const c = review(plan([step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1')], [pf('NEW_FIELD_1', '金額2', 'amount', 'NUMBER')]));
  assert(st(c, 'P1').status === 'INVALID' && st(c, 'P1').safety === 'BLOCKED' && codes(st(c, 'P1')).includes('FIELD_CODE_COLLISION') && c.executionReadiness.blockedSteps.join() === 'P1' && c.summary.status === 'BLOCKED', 'field code collision → INVALID / BLOCKED');
  const l = review(plan([step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1')], [pf('NEW_FIELD_1', '金額', 'amount2', 'NUMBER')]));
  assert(st(l, 'P1').status !== 'INVALID' && codes(st(l, 'P1')).includes('LABEL_DUPLICATE'), 'label duplicate → 警告（追加は可能）');
  const reuse = review(plan([step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1')], [pf('NEW_FIELD_1', '部長承認者', 'manager_approver', 'USER_SELECT')]));
  assert(st(reuse, 'P1').status === 'WARNING' && codes(st(reuse, 'P1')).includes('POSSIBLE_EXISTING_REUSE') && reuse.warnings.some(w => w.code === 'POSSIBLE_EXISTING_REUSE' && w.message.includes('承認者') && w.detail.existing === 'approver'), 'Proposal necessity: 既存「承認者」の再利用候補を Toolkit 側から指摘');
  const u = review(plan([step('P1', 'UPDATE_FIELD', 'FIELD', 'ghost', [['必須', 'true']])]));
  assert(st(u, 'P1').status === 'INVALID' && codes(st(u, 'P1')).includes('UNKNOWN_FIELD'), 'UPDATE_FIELD nonexistent → INVALID');
  const t = review(plan([step('P1', 'UPDATE_FIELD', 'FIELD', 'amount', [['型', 'SINGLE_LINE_TEXT'], ['必須', 'true']])]));
  const ts = st(t, 'P1');
  assert(ts.status === 'NEEDS_CONFIRMATION' && ts.safety === 'REVIEW_REQUIRED' && codes(ts).includes('TYPE_CHANGE') && codes(ts).includes('REQUIRED_CHANGE') && ts.diff.before.type === 'NUMBER' && ts.diff.after.type === 'SINGLE_LINE_TEXT' && ts.diff.human.some(h => h.includes('種類: NUMBER → SINGLE_LINE_TEXT')) && ts.diff.human.some(h => h.includes('必須: false → true')) && t.summary.counts.highRisk === 1, 'type change: 高リスク・Before/After は変更属性だけ');
  const o = review(plan([step('P1', 'UPDATE_FIELD', 'FIELD', 'status_select', [['選択肢', 'A, B']])]), (() => { const i = buildInputs(); i.data.fields.status_select = { type: 'DROP_DOWN', code: 'status_select', label: '区分', options: { A: { label: 'A', index: '0' }, B: { label: 'B', index: '1' }, C: { label: 'C', index: '2' } } }; const fieldsN = KTDeps.normalizeFields(i.data.fields); i.deps = KTDeps.buildDependencyData(i.data, fieldsN); return i; })());
  assert(codes(st(o, 'P1')).includes('OPTIONS_REMOVED') && st(o, 'P1').issues.find(i => i.code === 'OPTIONS_REMOVED').message.includes('C'), '選択肢削除 → OPTIONS_REMOVED（高リスク）');
  const reuseStep = review(plan([step('P1', 'REUSE_FIELD', 'FIELD', 'approver', [], { confidence: 'NEEDS_CONFIRMATION' })]));
  assert(st(reuseStep, 'P1').diff.changeType === 'REUSE' && st(reuseStep, 'P1').status === 'NEEDS_CONFIRMATION' && codes(st(reuseStep, 'P1')).includes('MEANING_UNCONFIRMED'), 'REUSE_FIELD: 変更なし・意味は未確認');
}

console.log('\n--- 3. Notification / Reminder ---');
{
  const uniq = review(plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', '担当者設定通知', [['通知先', 'owner'], ['条件', 'owner not in ("")']])]));
  const us = st(uniq, 'P1');
  assert(us.status === 'VALID' || us.status === 'WARNING', 'unique notification: 追加できる');
  const exact = review(plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', '高額案件', [['通知先', 'user1, approver, owner_org'], ['条件', 'amount >= "1000000"']])]));
  const es = st(exact, 'P1');
  assert(es.status === 'NEEDS_CONFIRMATION' && codes(es).includes('DUPLICATE') && es.issues.find(i => i.code === 'DUPLICATE').existing.title === '高額案件の登録' && exact.conflicts.some(c => c.code === 'DUPLICATE' && c.stepIds.includes('P1')), 'exact duplicate: 既存「高額案件の登録」と同一（USER:user1 は既存設定から種別を補完）→ DUPLICATE / 競合');
  const sim = review(plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', '承認者通知', [['通知先', 'approver'], ['条件', 'amount >= "1000000"']])]));
  const ss = st(sim, 'P1');
  assert(ss.status === 'WARNING' && codes(ss).includes('POSSIBLE_DUPLICATE') && ss.safety === 'REVIEW_REQUIRED', 'possible duplicate: 通知先が重なり条件が同じ → POSSIBLE_DUPLICATE');
  const unk = review(plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', 'x', [['通知先', 'NEW_FIELD_9']])]));
  assert(st(unk, 'P1').status === 'INVALID' && codes(st(unk, 'P1')).includes('PROPOSED_FIELD_NOT_APPLIED'), '通知先の新規フィールドが未追加 → INVALID');
  const rem = review(plan([step('P1', 'ADD_REMINDER', 'REMINDER', '期限前日', [['基準日', 'due_date'], ['日数', '-1'], ['通知先', 'owner, owner_group, user1'], ['条件', 'amount > "0"']])]));
  assert(st(rem, 'P1').status === 'NEEDS_CONFIRMATION' && codes(st(rem, 'P1')).includes('DUPLICATE'), 'reminder duplicate（基準日・日数・通知先・条件が一致）');
  const rem2 = review(plan([step('P1', 'ADD_REMINDER', 'REMINDER', '期限30日前', [['基準日', '期限'], ['日数', '-30'], ['時刻', '09:00'], ['通知先', '担当者']])]));
  const r2 = st(rem2, 'P1');
  assert(r2.status === 'WARNING' && codes(r2).includes('POSSIBLE_DUPLICATE') && r2.diff.after.timing.code === 'due_date' && r2.diff.after.timing.daysLater === '-30' && r2.diff.after.targets[0].code === 'owner', 'reminder: ラベル（期限・担当者）で解決・既存と類似');
  const remBad = review(plan([step('P1', 'ADD_REMINDER', 'REMINDER', 'x', [['基準日', 'amount'], ['日数', '-1'], ['通知先', 'owner']])]));
  assert(st(remBad, 'P1').status === 'INVALID' && codes(st(remBad, 'P1')).includes('REMINDER_FIELD_TYPE'), 'reminder: 基準が日付型でない → INVALID');
}

console.log('\n--- 4. Process ---');
{
  const add = review(plan([step('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認待ち', [['作業者', 'approver']]), step('P2', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長へ', [['遷移元', '承認待ち'], ['遷移先', '部長承認待ち'], ['条件', 'amount >= "1000000"']], { dependsOn: ['P1'] }), step('P3', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長承認', [['遷移元', '部長承認待ち'], ['遷移先', '完了']], { dependsOn: ['P1'] })]));
  assert(st(add, 'P1').status === 'NEEDS_CONFIRMATION' && st(add, 'P1').diff.changeType === 'ADD' && add.simulation.after.process.states.length === 4 && add.simulation.after.process.actions.length === 5, 'add status / add action: After に反映・プロセス変更は確認');
  assert(add.simulation.process.changed && add.simulation.process.mermaid.after.includes('部長承認待ち') && add.simulation.process.mermaid.after.includes('==>') && add.simulation.process.mermaid.before.split('\n').length < add.simulation.process.mermaid.after.split('\n').length && add.simulation.process.mermaid.after.includes('amount ≧'), 'Process Mermaid: Before / After・新規遷移を強調・比較演算子を全角に');
  assert(!add.conflicts.some(c => c.code === 'STATUS_UNREACHABLE'), '遷移で繋がったステータスは到達可能');
  const ov = st(add, 'P2');
  assert(codes(ov).includes('ACTION_CONDITION_OVERLAP') && ov.issues.find(i => i.code === 'ACTION_CONDITION_OVERLAP').message.includes('承認する'), 'overlapping condition candidate: 同じ遷移元「承認待ち」の既存「承認する」（条件なし）と重なる');
  const dup = review(plan([step('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '承認待ち')]));
  assert(st(dup, 'P1').status === 'INVALID' && codes(st(dup, 'P1')).includes('STATUS_DUPLICATE'), 'duplicate status → INVALID');
  const dupA = review(plan([step('P1', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '申請する', [['遷移元', '未処理'], ['遷移先', '承認待ち']])]));
  assert(st(dupA, 'P1').status === 'INVALID' && codes(st(dupA, 'P1')).includes('ACTION_DUPLICATE'), 'duplicate action → INVALID');
  const unk = review(plan([step('P1', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', 'x', [['遷移元', '存在しない'], ['遷移先', '完了']])]));
  assert(st(unk, 'P1').status === 'INVALID' && codes(st(unk, 'P1')).includes('UNKNOWN_STATUS'), 'unknown from → INVALID');
  const unreach = review(plan([step('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '差戻し')]));
  assert(unreach.conflicts.some(c => c.code === 'STATUS_UNREACHABLE' && c.stepIds.includes('P1')), '到達不能ステータス（遷移するアクションが無い）');
  const same = review(plan([step('P1', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '別名申請', [['遷移元', '未処理'], ['遷移先', '承認待ち'], ['条件', 'amount > "0"']])]));
  assert(codes(st(same, 'P1')).includes('ACTION_SAME_CONDITION') && same.conflicts.some(c => c.code === 'ACTION_SAME_CONDITION'), '同じ遷移元・同じ条件のアクション → ACTION_SAME_CONDITION');
  const restrict = review(plan([step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '承認する', [['条件', 'amount < "1000000"']])]));
  const rs = st(restrict, 'P1');
  assert(rs.status === 'NEEDS_CONFIRMATION' && codes(rs).includes('EXISTING_PATH_RESTRICTED') && rs.issues.find(i => i.code === 'EXISTING_PATH_RESTRICTED').message.includes('すべて') && rs.diff.before.filterCond === '' && rs.diff.after.filterCond === 'amount < "1000000"' && rs.diff.human.some(h => h.startsWith('Before:')) && rs.diff.human.some(h => h.startsWith('After:')) && restrict.summary.counts.highRisk === 1, 'existing action condition restriction: 条件なし → 条件あり は EXISTING_PATH_RESTRICTED（高リスク・Before/After）');
  const branch = review(plan([step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', [['条件', 'amount < 1000000 → 承認待ちへ遷移'], ['条件', 'amount >= 1000000 → 部長承認待ちへ遷移']])]));
  assert(st(branch, 'P1').status === 'INVALID' && codes(st(branch, 'P1')).includes('UNKNOWN_STATUS'), '分岐先のステータスが無い → INVALID（dependsOn 不足の検出）');
  const branch2 = review(plan([step('P0', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認待ち'), step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', [['条件', 'amount < 1000000 → 承認待ちへ遷移'], ['条件', 'amount >= 1000000 → 部長承認待ちへ遷移']], { dependsOn: ['P0'] })]));
  const b1 = st(branch2, 'P1');
  assert(b1.status === 'NEEDS_CONFIRMATION' && codes(b1).includes('EXISTING_PATH_RESTRICTED') && codes(b1).includes('BRANCH_ADDED') && branch2.simulation.after.process.actions.filter(a => a.name === '申請する').length === 2, '既存アクションの分岐（amount > "0" → <1,000,000 / >=1,000,000）: 制限＋分岐追加');
  const unkT = review(plan([step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '存在しないアクション', [['条件', 'x']])]));
  assert(st(unkT, 'P1').status === 'INVALID' && codes(st(unkT, 'P1')).includes('UNKNOWN_PROCESS_TARGET'), 'UPDATE_PROCESS unknown target → INVALID');
}

console.log('\n--- 5. Lookup ---');
{
  const add = review(plan([step('P1', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', [['取得項目', 'address → customer_address']])]), (() => { const i = buildInputs(); i.data.fields.customer_address = { type: 'SINGLE_LINE_TEXT', code: 'customer_address', label: '顧客住所' }; i.deps = KTDeps.buildDependencyData(i.data, KTDeps.normalizeFields(i.data.fields)); return i; })());
  const a = st(add, 'P1');
  assert((a.status === 'VALID' || a.status === 'WARNING') && a.safety === 'REVIEW_REQUIRED' && a.diff.changeType === 'UPDATE' && a.diff.after.lookup.mappings.length === 3 && a.diff.after.lookup.mappings.some(m => m.to === 'customer_address') && a.diff.before.lookup.mappings.length === 2, 'add mapping: 既存ルックアップに取得項目を追加（Before 2 → After 3）');
  const dupDest = review(plan([step('P1', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', [['取得項目', 'addr → amount, tel → amount']])]));
  assert(st(dupDest, 'P1').status === 'INVALID' && codes(st(dupDest, 'P1')).includes('LOOKUP_DEST_DUPLICATE'), 'duplicate destination → INVALID');
  const over = review(plan([step('P1', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', [['取得項目', 'address → case_name']])]));   // Phase 13: 取得元は参照元アプリに実在するフィールド（address）
  assert(codes(st(over, 'P1')).includes('LOOKUP_MAPPING_OVERWRITE') && st(over, 'P1').status === 'NEEDS_CONFIRMATION', '既存マッピングの上書き → 高リスク');
  const missing = review(plan([step('P1', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', [['取得項目', 'address → NEW_FIELD_1']])]));
  assert(st(missing, 'P1').status === 'INVALID' && codes(st(missing, 'P1')).includes('PROPOSED_FIELD_NOT_APPLIED'), 'proposed field 未追加のコピー先 → INVALID');
  const resolved = review(plan([step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1'), step('P2', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', [['取得項目', 'address → NEW_FIELD_1']], { dependsOn: ['P1'] })], [pf('NEW_FIELD_1', '顧客住所', 'customer_address', 'SINGLE_LINE_TEXT')]));
  assert(st(resolved, 'P2').status !== 'INVALID' && st(resolved, 'P2').diff.after.lookup.mappings.some(m => m.to === 'customer_address'), 'proposed field resolution: P1 で追加した NEW_FIELD_1 を P2 のコピー先に解決');
  const notLookup = review(plan([step('P1', 'UPDATE_LOOKUP', 'LOOKUP', 'amount', [['取得項目', 'a → b']])]));
  assert(st(notLookup, 'P1').status === 'INVALID' && codes(st(notLookup, 'P1')).includes('NOT_A_LOOKUP'), 'ルックアップでないフィールド → INVALID');
  const addLk = review(plan([step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1'), step('P2', 'ADD_LOOKUP', 'PROPOSED_FIELD', 'NEW_FIELD_2', [['参照元アプリ', '500'], ['参照元フィールド', 'code'], ['取得項目', 'address → NEW_FIELD_1']], { dependsOn: ['P1'] })], [pf('NEW_FIELD_1', '顧客住所', 'customer_address', 'SINGLE_LINE_TEXT'), pf('NEW_FIELD_2', '顧客参照2', 'customer_ref2', 'LOOKUP')]));
  const lk = st(addLk, 'P2');
  assert(lk.status !== 'INVALID' && lk.diff.after.lookup.app === '500' && lk.diff.after.lookup.mappings[0].to === 'customer_address' && addLk.simulation.after.fields.customer_ref2.type === 'LOOKUP', 'ADD_LOOKUP: 新規ルックアップ（参照元・キー・取得項目）を仮適用');
}

console.log('\n--- 6. View / ACL / App Action ---');
{
  const v = review(plan([step('P1', 'ADD_VIEW', 'VIEW', '顧客情報', [['表示フィールド', 'case_name, amount, ghost']])]));
  assert(st(v, 'P1').status === 'INVALID' && codes(st(v, 'P1')).includes('UNKNOWN_FIELD'), 'ADD_VIEW unknown field → INVALID');
  const v2 = review(plan([step('P1', 'ADD_VIEW', 'VIEW', '顧客別一覧', [['表示フィールド', 'case_name']])]));
  assert(codes(st(v2, 'P1')).includes('VIEW_NAME_DUPLICATE'), 'ADD_VIEW name duplicate');
  const v3 = review(plan([step('P1', 'ADD_VIEW', 'VIEW', '期限順', [['表示フィールド', 'case_name, due_date'], ['並び順', 'due_date asc']])]));
  assert(st(v3, 'P1').status === 'VALID' && st(v3, 'P1').safety === 'SAFE' && v3.simulation.after.views.length === 3, 'ADD_VIEW normal → SAFE');
  const acl = review(plan([step('P1', 'UPDATE_FIELD_ACL', 'FIELD_ACL', 'amount', [['対象', 'owner']])]));
  const as = st(acl, 'P1');
  assert(as.status === 'NEEDS_CONFIRMATION' && as.safety === 'REVIEW_REQUIRED' && codes(as).includes('ACL_CHANGE') && codes(as).includes('ACL_EXISTING_RULE') && as.simulated === false && as.diff.before && as.diff.human[0].includes('仮適用なし'), 'ACL: 高リスク・既存ルールあり・仮適用なし（validate only）');
  const aclBad = review(plan([step('P1', 'UPDATE_FIELD_ACL', 'FIELD_ACL', 'ghost', [])]));
  assert(st(aclBad, 'P1').status === 'INVALID' && codes(st(aclBad, 'P1')).includes('UNKNOWN_FIELD'), 'ACL unknown target → INVALID');
  const racl = review(plan([step('P1', 'UPDATE_RECORD_ACL', 'RECORD_ACL', '', [['条件', 'amount >= "1000000"']])]));
  assert(codes(st(racl, 'P1')).includes('ACL_EXISTING_RULE') && st(racl, 'P1').status === 'NEEDS_CONFIRMATION', 'RECORD_ACL: 同じ条件の既存ルール');
  const app = review(plan([step('P1', 'ADD_APP_ACTION', 'APP_ACTION', '見積を作成', [['作成先', '311']])]));
  assert(st(app, 'P1').status === 'INVALID' && codes(st(app, 'P1')).includes('APP_ACTION_NAME_DUPLICATE'), 'APP_ACTION name duplicate');
  const app2 = review(plan([step('P1', 'ADD_APP_ACTION', 'APP_ACTION', '請求を作成', [['作成先', '312'], ['コピー', 'case_name → title, ghost → x']])]));
  assert(st(app2, 'P1').status === 'INVALID' && codes(st(app2, 'P1')).includes('UNKNOWN_FIELD'), 'APP_ACTION source field 不存在');
}

console.log('\n--- 7. Dependencies / Plan 内部 / Safety ---');
{
  const ok = review(plan([step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1'), step('P2', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認待ち', [['作業者', 'NEW_FIELD_1']], { dependsOn: ['P1'] }), step('P3', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長へ', [['遷移元', '承認待ち'], ['遷移先', '部長承認待ち'], ['条件', 'amount >= "1000000"']], { dependsOn: ['P2'] })], [pf('NEW_FIELD_1', '部長承認者', 'manager_approver', 'USER_SELECT')]));
  assert(st(ok, 'P2').status !== 'INVALID' && st(ok, 'P2').diff.after.assignees[0].code === 'manager_approver', 'valid dependsOn: P1 仮適用後の After で P2 が NEW_FIELD_1 を解決（temporaryId → suggestedCode）');
  const bad = review(plan([step('P2', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認待ち', [['作業者', 'NEW_FIELD_1']], { dependsOn: ['P9'] })]));
  assert(st(bad, 'P2').status === 'INVALID' && codes(st(bad, 'P2')).includes('PROPOSED_FIELD_NOT_APPLIED'), 'invalid dependsOn（未追加の NEW_FIELD を参照）→ INVALID');
  const blocked = review(plan([step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1'), step('P2', 'ADD_VIEW', 'VIEW', '新一覧', [['表示フィールド', 'case_name']], { dependsOn: ['P1'] })], [pf('NEW_FIELD_1', '金額2', 'amount', 'NUMBER')]));
  assert(st(blocked, 'P1').status === 'INVALID' && st(blocked, 'P2').status === 'BLOCKED_BY_DEPENDENCY' && st(blocked, 'P2').safety === 'BLOCKED' && st(blocked, 'P2').blockedBy.join() === 'P1' && blocked.executionReadiness.blockedSteps.join() === 'P1,P2', 'blocked dependency: 単独では VALID な P2 も BLOCKED_BY_DEPENDENCY');
  const cycle = review(plan([step('P1', 'ADD_VIEW', 'VIEW', 'v1', [['表示フィールド', 'case_name']], { dependsOn: ['P2'] }), step('P2', 'ADD_VIEW', 'VIEW', 'v2', [['表示フィールド', 'case_name']], { dependsOn: ['P1'] })]));
  assert(cycle.warnings.some(w => w.code === 'CIRCULAR_DEPENDENCY') && st(cycle, 'P1').status === 'INVALID' && st(cycle, 'P2').status === 'INVALID', 'plan cycle → INVALID＋warning');
  const twoFields = review(plan([step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1'), step('P2', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_2')], [pf('NEW_FIELD_1', '部長承認者', 'mgr', 'USER_SELECT'), pf('NEW_FIELD_2', '部長', 'mgr', 'USER_SELECT')]));
  assert(st(twoFields, 'P2').status === 'INVALID' && codes(st(twoFields, 'P2')).includes('PLAN_INTERNAL_DUPLICATE'), 'two steps create same field → PLAN_INTERNAL_DUPLICATE');
  const twoNotif = review(plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', '担当者通知', [['通知先', 'owner'], ['条件', 'owner not in ("")']]), step('P4', 'ADD_NOTIFICATION', 'NOTIFICATION', '担当者設定通知', [['通知先', 'owner'], ['条件', 'owner not in ("")']])]));
  assert(codes(st(twoNotif, 'P4')).includes('PLAN_INTERNAL_DUPLICATE') && twoNotif.conflicts.some(c => c.code === 'PLAN_INTERNAL_DUPLICATE' && c.stepIds.includes('P4') && c.stepIds.includes('P1')), 'two notifications duplicate（別名・同条件・同通知先）→ Plan 内部重複');
  // Safety の 4 種
  const safety = review(plan([
    step('P1', 'ADD_VIEW', 'VIEW', '期限順2', [['表示フィールド', 'case_name']]),
    step('P2', 'UPDATE_PROCESS', 'PROCESS_ACTION', '承認する', [['条件', 'amount < "1000000"']]),
    step('P3', 'UPDATE_FIELD', 'FIELD', 'ghost', [['必須', 'true']]),
    step('P4', 'CUSTOMIZATION_REQUIRED', 'JS', '', []),
  ]));
  assert(st(safety, 'P1').safety === 'SAFE' && st(safety, 'P2').safety === 'REVIEW_REQUIRED' && st(safety, 'P3').safety === 'BLOCKED' && st(safety, 'P4').safety === 'PLAN_ONLY' && st(safety, 'P4').diff.changeType === 'NO_CHANGE' && st(safety, 'P4').diff.human.some(h => h.includes('計画のみ')), 'Safety: SAFE / REVIEW_REQUIRED / BLOCKED / PLAN_ONLY（Action Catalog どおり。未対応は PLAN_ONLY で明示）');
  const er = safety.executionReadiness;
  assert(er.status === 'BLOCKED' && er.safeSteps.join() === 'P1' && er.reviewSteps.join() === 'P2' && er.blockedSteps.join() === 'P3' && er.planOnlySteps.join() === 'P4' && er.approvedSteps.length === 0, 'executionReadiness の集約');
  const unsupported = review(plan([step('P1', 'DELETE_FIELD', 'FIELD', 'amount', [])]));
  assert(st(unsupported, 'P1').status === 'INVALID' && codes(st(unsupported, 'P1')).includes('UNSUPPORTED_ACTION_TYPE'), '語彙外の actionType は無視せず INVALID');
}

console.log('\n--- 8. Impact re-check / coverage / Executor 出力 ---');
{
  const match = review(plan([step('P1', 'UPDATE_FIELD', 'FIELD', 'customer_code', [['必須', 'true']])], [], { impact: [{ targetKind: 'FIELD', targetRef: 'customer_code', description: 'JavaScript 3 件と一覧・ルックアップが参照', evidenceIds: [], confidence: 'CONFIRMED' }] }));
  assert(!match.warnings.some(w => w.code.startsWith('PLANNER_IMPACT')) && match.impactCheck[0].toolkit.js >= 2, 'impact 一致（Planner が JS 影響を挙げている）');
  const missing = review(plan([step('P1', 'UPDATE_FIELD', 'FIELD', 'customer_code', [['必須', 'true']])], [], { impact: [] }));
  assert(missing.warnings.some(w => w.code === 'PLANNER_IMPACT_MISSING' && w.stepIds.includes('P1')) && st(missing, 'P1').issues.some(i => i.code === 'PLANNER_IMPACT_MISSING'), 'Planner 不足: Toolkit の impactOf で参照があるのに Planner に無い → warning');
  const mismatch = review(plan([step('P1', 'UPDATE_FIELD', 'FIELD', 'customer_code', [['必須', 'true']])], [], { impact: [{ targetKind: 'FIELD', targetRef: 'customer_code', description: '一覧のみ', evidenceIds: [], confidence: 'INFERRED' }] }));
  assert(mismatch.warnings.some(w => w.code === 'PLANNER_IMPACT_MISMATCH' && w.message.includes('JavaScript')), 'Planner 過少: JS 参照があるのに Planner が JS を挙げていない → mismatch');
  const over = review(plan([step('P1', 'UPDATE_FIELD', 'FIELD', 'secret_memo', [['必須', 'true']])], [], { impact: [{ targetKind: 'FIELD', targetRef: 'secret_memo', description: '多くの設定が参照', evidenceIds: [], confidence: 'INFERRED' }] }));
  assert(over.warnings.some(w => w.code === 'PLANNER_IMPACT_OVERSTATED') || over.impactCheck[0].toolkit.direct > 0, 'Planner 過剰（参照が無いのに影響を主張）→ OVERSTATED（参照があればそのまま）');
  const cov = match.reviewCoverage;
  assert(cov.fields === true && cov.process === true && cov.notifications === true && cov.lookup === true && cov.acl === 'partial' && cov.javascript === true && Array.isArray(cov.notes) && cov.notes.length >= 3, 'reviewCoverage（未対応は partial / false として明示）');
  const noJs = review(plan([step('P1', 'ADD_VIEW', 'VIEW', 'v', [['表示フィールド', 'case_name']])]), (() => { const d = FX.makeData(); const deps = KTDeps.buildDependencyData(d, KTDeps.normalizeFields(d.fields)); return { data: d, deps, scan: null, incoming: null }; })());
  assert(noJs.reviewCoverage.javascript === false && noJs.reviewCoverage.incoming === false, 'JS 未解析なら coverage.javascript false');
  const out = R.executorOutput(plan([step('P1', 'ADD_VIEW', 'VIEW', 'v', [['表示フィールド', 'case_name']])]), noJs);
  assert(out.outputVersion === '1' && out.plan && out.review.reviewVersion === '1' && Array.isArray(out.approvedSteps) && out.approvedSteps.length === 0 && out.review.steps[0].stepId === 'P1' && !out.review.simulation.after, 'Executor-ready output: { plan, review, approvedSteps: [] }（巨大な After モデルは除く）');
  assert(JSON.stringify(INPUTS.data) === SNAPSHOT, 'すべての review の後も DATA は不変');
}

console.log('\n--- 9. staging E2E（2026-10-02）で見つかった実データの癖 ---');
{
  // A: 既存通知と類似 → step.issues に同じ指摘が 2 回並ばない（plan-level conflict の step への反映は重複を除く）
  const dupA = review(plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', '担当者設定通知', [['通知先', 'owner'], ['条件', 'owner not in ("")']])]));
  const dupCodes = codes(st(dupA, 'P1')).filter(c => c === 'POSSIBLE_DUPLICATE');
  assert(dupCodes.length === 1 && dupA.conflicts.filter(c => c.code === 'POSSIBLE_DUPLICATE').length === 1, 'POSSIBLE_DUPLICATE は step.issues にも conflicts にも 1 回だけ');
  // A: kintone の条件式に無い関数（IS_NULL / PREVIOUS_VALUE）→ COND_UNKNOWN_FUNCTION（要確認。VALID のままにしない）
  const fn = review(plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', '担当者設定通知', [], { spec: { targets: ['FIELD_ENTITY:owner_group'], filterCond: 'NOT(IS_NULL(owner)) AND PREVIOUS_VALUE(owner) != owner' } })]));
  const fnIssue = st(fn, 'P1').issues.find(i => i.code === 'COND_UNKNOWN_FUNCTION');
  assert(fnIssue && /IS_NULL/.test(fnIssue.message) && /PREVIOUS_VALUE/.test(fnIssue.message) && !/NOT\b/.test(fnIssue.message.replace(/NOT\(IS_NULL/, '')) && st(fn, 'P1').status === 'NEEDS_CONFIRMATION', '条件式の未知関数 → COND_UNKNOWN_FUNCTION（NOT / AND は関数扱いしない）');
  const okFn = review(plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', '本日分', [], { spec: { targets: ['FIELD_ENTITY:owner_group'], filterCond: 'due_date = TODAY() and owner in (LOGINUSER())' } })]));
  assert(!codes(st(okFn, 'P1')).includes('COND_UNKNOWN_FUNCTION'), 'kintone の関数（TODAY / LOGINUSER）は指摘しない');
  const fnAct = review(plan([step('P1', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '差戻し', [], { spec: { name: '差戻し', from: '承認待ち', to: '未処理', filterCond: 'ISBLANK(approver)' } })]));
  assert(codes(st(fnAct, 'P1')).includes('COND_UNKNOWN_FUNCTION'), 'プロセスアクションの条件式でも同じ検査');
  // A: 条件式（レコードの条件通知）と events（アプリの条件通知）が混在 → Phase 20: 反映（Executor）と同じく「どちらの通知か決められない」要確認
  //    （以前は NOTIFICATION_EVENTS_IGNORED として ✓ のまま見せ、承認後に反映できなかった）。After のイベントは載せない
  const mixed = st(fn, 'P1');
  const mixed2 = review(plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', '設定通知', [], { spec: { targets: ['FIELD_ENTITY:owner_group'], filterCond: 'amount > "5"', events: ['recordEdited'] } })]));
  assert(codes(st(mixed2, 'P1')).includes('NOTIFICATION_SCOPE_AMBIGUOUS') && st(mixed2, 'P1').status === 'NEEDS_CONFIRMATION' && st(mixed2, 'P1').diff.after.scope === 'perRecord' && st(mixed2, 'P1').diff.after.events.length === 0 && !codes(mixed).includes('NOTIFICATION_SCOPE_AMBIGUOUS'), '条件式と events の混在 → 要確認（NOTIFICATION_SCOPE_AMBIGUOUS）・After にイベントは載せない');
  // C: ルックアップのコピー先が「後の step で追加する新規フィールドのコード」→ UNKNOWN ではなく PROPOSED_FIELD_NOT_APPLIED（順序 / dependsOn の問題と分かる）
  const order = review(plan([
    step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', [], { spec: { fieldType: 'LOOKUP', sourceApp: '999999', keyField: '顧客コード', mappings: [{ from: '住所', to: 'address' }, { from: '電話番号', to: 'phone_number' }] } }),
    step('P2', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_2', [], { dependsOn: ['P1'] }),
    step('P3', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_3', [], { dependsOn: ['P1'] }),
  ], [pf('NEW_FIELD_1', '顧客コード（ルックアップ）', 'customer_code2', 'LOOKUP'), pf('NEW_FIELD_2', '住所', 'address', 'SINGLE_LINE_TEXT'), pf('NEW_FIELD_3', '電話番号', 'phone_number', 'SINGLE_LINE_TEXT')]));
  const p1 = st(order, 'P1');
  assert(p1.status === 'INVALID' && codes(p1).includes('PROPOSED_FIELD_NOT_APPLIED') && !codes(p1).includes('LOOKUP_DEST_UNKNOWN') && p1.issues.some(i => /NEW_FIELD_2/.test(i.message) && /P2/.test(i.message)), 'コピー先が後続 step の新規フィールドコード → PROPOSED_FIELD_NOT_APPLIED（追加予定の step を明示）');
  assert(st(order, 'P2').status === 'BLOCKED_BY_DEPENDENCY' && order.executionReadiness.status === 'BLOCKED', '順序が逆の計画は BLOCKED（Toolkit は自動で並べ替えない）');
  // A（2 回目の実行）: 既存のアプリ通知（fixture では general#3）を UPDATE。name に ID が入る / 条件が散文 / イベントが減る
  const upd = review(plan([step('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', 'general#3', [], { spec: { name: 'general#3', targets: ['FIELD_ENTITY:owner'], filterCond: '担当者フィールドが空から設定された場合（要確認）', events: ['recordEdited'] } })]));
  const u = st(upd, 'P1');
  assert(u.diff.before && u.diff.after && u.diff.after.title === u.diff.before.title, 'spec.name が通知 ID / targetRef と同じならタイトル変更として扱わない');
  assert(codes(u).includes('COND_NOT_EXPRESSION') && codes(u).includes('GENERAL_NOTIFICATION_COND'), '散文の条件 → COND_NOT_EXPRESSION、アプリの条件通知に条件式 → GENERAL_NOTIFICATION_COND');
  const evRemoved = u.issues.find(i => i.code === 'NOTIFICATION_EVENTS_REMOVED');
  assert(evRemoved && evRemoved.severity === 'high' && /recordAdded/.test(evRemoved.message) && upd.summary.counts.highRisk === 1, '通知イベントの削減（既存の通知が止まる）→ 高リスク');
  const condOk = review(plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', '高額', [], { spec: { targets: ['FIELD_ENTITY:owner_group'], filterCond: 'amount >= "1000000" and ステータス in ("承認待ち")' } })]));
  assert(!codes(st(condOk, 'P1')).includes('COND_NOT_EXPRESSION'), '演算子を含む条件式は散文扱いしない');
  // C（3 回目の実行）: ADD_FIELD の後に同じ NEW_FIELD_n を ADD_LOOKUP で「変換」しようとする / 参照元が散文 / ルックアップを 3 本に分割
  const split = review(plan([
    step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', [], { spec: { fieldType: 'SINGLE_LINE_TEXT' } }),
    step('P2', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_2', [], { spec: { fieldType: 'SINGLE_LINE_TEXT' } }),
    step('P3', 'ADD_LOOKUP', 'PROPOSED_FIELD', 'NEW_FIELD_1', [], { dependsOn: ['P1'], spec: { sourceApp: '顧客マスタアプリID（要確認）', keyField: '顧客コード', mappings: [{ from: '顧客コード', to: 'NEW_FIELD_1' }] } }),
    step('P4', 'ADD_LOOKUP', 'PROPOSED_FIELD', 'NEW_FIELD_3', [], { dependsOn: ['P2'], spec: { sourceApp: '顧客マスタアプリID（要確認）', keyField: '顧客コード', mappings: [{ from: '住所', to: 'NEW_FIELD_2' }] } }),
    step('P5', 'ADD_LOOKUP', 'PROPOSED_FIELD', 'NEW_FIELD_4', [], { dependsOn: ['P2'], spec: { sourceApp: '顧客マスタアプリID（要確認）', keyField: '顧客コード', mappings: [{ from: '電話番号', to: 'NEW_FIELD_2' }] } }),
  ], [pf('NEW_FIELD_1', '顧客コード', 'customer_code2', 'SINGLE_LINE_TEXT'), pf('NEW_FIELD_2', '住所', 'address', 'SINGLE_LINE_TEXT'), pf('NEW_FIELD_3', '顧客参照1', 'cust_ref1', 'LOOKUP'), pf('NEW_FIELD_4', '顧客参照2', 'cust_ref2', 'LOOKUP')]));
  const p3 = st(split, 'P3');
  assert(p3.status === 'INVALID' && codes(p3).includes('PLAN_INTERNAL_DUPLICATE') && !codes(p3).includes('FIELD_CODE_COLLISION') && p3.issues.some(i => /P1/.test(i.message)), '同じ NEW_FIELD_n を 2 回追加 → PLAN_INTERNAL_DUPLICATE（既存との衝突ではなく plan 内の重複。追加した step を明示）');
  assert(codes(st(split, 'P4')).includes('LOOKUP_SOURCE_NOT_ID') && st(split, 'P4').status === 'NEEDS_CONFIRMATION', '参照元アプリが数値 ID でない（散文）→ LOOKUP_SOURCE_NOT_ID（要確認）');
  assert(split.conflicts.some(c => c.code === 'LOOKUP_SPLIT' && c.stepIds.includes('P4') && c.stepIds.includes('P5')), '同じ参照元・キーのルックアップが複数 → LOOKUP_SPLIT（1 つのルックアップにまとめられる）');
  const idOk = review(plan([step('P1', 'ADD_LOOKUP', 'PROPOSED_FIELD', 'NEW_FIELD_1', [], { spec: { sourceApp: '999999', keyField: '顧客コード', mappings: [{ from: '住所', to: 'secret_memo' }] } })], [pf('NEW_FIELD_1', '顧客参照', 'cust_ref', 'LOOKUP')]));
  assert(!codes(st(idOk, 'P1')).includes('LOOKUP_SOURCE_NOT_ID') && !idOk.conflicts.some(c => c.code === 'LOOKUP_SPLIT'), '数値の参照元・1 本のルックアップは指摘しない');
  // 実機: 承認しても review.executionReadiness.approvedSteps が [] のままだった → 一致させる。BLOCKED / PLAN_ONLY の承認は採らない
  const mix = review(plan([
    step('P1', 'ADD_VIEW', 'VIEW', '期限順3', [['表示フィールド', 'case_name']]),
    step('P2', 'UPDATE_FIELD', 'FIELD', 'ghost', [['必須', 'true']]),
    step('P3', 'CUSTOMIZATION_REQUIRED', 'JS', '', []),
  ]));
  const eo = R.executorOutput(plan([]), mix, ['P1', 'P2', 'P3', 'P1']);
  assert(eo.approvedSteps.join() === 'P1,P3' && eo.review.executionReadiness.approvedSteps.join() === 'P1,P3' && mix.executionReadiness.approvedSteps.length === 0, 'executorOutput: 承認は BLOCKED でない step（重複を除く。PLAN_ONLY は残して Executor が「未対応」と示す）で、review 内の readiness とも一致。元の review は変えない');
  // Phase 9 staging E2E（app 343）: AI がシステムフィールド「ステータス」の選択肢を変えようとした → 要確認ではなく INVALID
  const sysUpd = review(plan([step('P1', 'UPDATE_FIELD', 'FIELD', 'ステータス', [], { spec: { options: ['未着手', '進行中', '完了'] } })]));
  assert(st(sysUpd, 'P1').status === 'INVALID' && codes(st(sysUpd, 'P1')).includes('SYSTEM_FIELD_IMMUTABLE'), 'ステータス / 作業者 / カテゴリー の変更は API で不可 → SYSTEM_FIELD_IMMUTABLE（INVALID）');
  const sysLabel = review(plan([step('P1', 'UPDATE_FIELD', 'FIELD', '作成者', [], { spec: { name: '登録者' } })]));
  assert(st(sysLabel, 'P1').status !== 'INVALID', '作成者などの表示名変更は可能なので INVALID にしない');
  const sysReq = review(plan([step('P1', 'UPDATE_FIELD', 'FIELD', '作成者', [], { spec: { required: true } })]));
  assert(st(sysReq, 'P1').status === 'INVALID' && codes(st(sysReq, 'P1')).includes('SYSTEM_FIELD_IMMUTABLE'), '作成者などの必須化・型変更は不可 → INVALID');
  // Phase 9 staging E2E: AI が存在しないイベント名（recordUpdated）を書いた → 要確認
  const badEv = review(plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', '更新通知', [], { spec: { targets: ['FIELD_ENTITY:owner_group'], events: ['recordUpdated'] } })]));
  assert(codes(st(badEv, 'P1')).includes('NOTIFICATION_EVENT_UNKNOWN') && st(badEv, 'P1').status === 'NEEDS_CONFIRMATION' && st(badEv, 'P1').diff.after.events.length === 0, '未知のイベント名 → NOTIFICATION_EVENT_UNKNOWN（要確認・After に載せない）');
  // Phase 9 staging E2E（app 341）: AI が filterCond: "なし" と書いた → 空として扱う（散文の条件と誤認しない）
  const noneCond = review(plan([step('P1', 'ADD_VIEW', 'VIEW', '期限順', [], { spec: { name: '期限順', fields: ['case_name', 'owner', 'due_date'], filterCond: 'なし', sort: 'due_date asc' } })]));
  assert(st(noneCond, 'P1').status === 'VALID' && st(noneCond, 'P1').diff.after.filterCond === '' && !codes(st(noneCond, 'P1')).includes('COND_NOT_EXPRESSION'), '「なし」「none」「—」などの placeholder は空扱い（COND_NOT_EXPRESSION にしない）');
  // Phase 10 staging E2E（app 343）: AI が events: ["なし（レコードの条件通知）"] と書いた → 配列の placeholder も空扱い（イベント不明の指摘にしない）
  const noneEv = review(plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', 'n', [], { spec: { name: 'n', targets: ['FIELD_ENTITY:owner_group'], filterCond: 'amount >= "1"', events: ['なし（レコードの条件通知）'] } })]));
  assert(!codes(st(noneEv, 'P1')).includes('NOTIFICATION_EVENT_UNKNOWN') && st(noneEv, 'P1').diff.after.scope === 'perRecord' && !st(noneEv, 'P1').spec.events, '配列の placeholder（なし）は捨てる');
  const noneEv2 = review(plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', 'n2', [['通知先', 'owner_group'], ['条件', 'amount >= "1"'], ['イベント', 'なし（レコードの条件通知）']], { spec: { name: 'n2', targets: ['FIELD_ENTITY:owner_group'], filterCond: 'amount >= "1"', events: ['なし（レコードの条件通知）'] } })]));
  assert(!codes(st(noneEv2, 'P1')).includes('NOTIFICATION_EVENT_UNKNOWN') && !st(noneEv2, 'P1').spec.events, 'details の「イベント: なし」も拾い直さない（実機で spec と details の両方に出た）');
  assert(JSON.stringify(INPUTS.data) === SNAPSHOT, '§9 の後も DATA は不変');
}

console.log('\n--- 10. Phase 11: 既存設定の変更（UPDATE_NOTIFICATION / UPDATE_REMINDER / UPDATE_VIEW）---');
{
  // UPDATE_NOTIFICATION: 対象の同一性を Review 時点で固定（scope / index / id / title / 条件 / イベント）。通知先の追加は low、削除は高リスク
  const add = review(plan([step('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', 'perRecord#1', [], { spec: { targets: ['USER:user1', 'FIELD_ENTITY:approver', 'FIELD_ENTITY:owner_org', 'FIELD_ENTITY:owner'] } })]));
  const sa = st(add, 'P1');
  assert(sa.status === 'NEEDS_CONFIRMATION' && sa.safety === 'REVIEW_REQUIRED' && sa.diff.changeType === 'UPDATE' && codes(sa).includes('NOTIFICATION_RECIPIENTS_ADDED') && !codes(sa).includes('NOTIFICATION_RECIPIENTS_REMOVED'), 'UPDATE_NOTIFICATION 通知先の追加: REVIEW_REQUIRED・RECIPIENTS_ADDED（削除なし）');
  assert(sa.diff.target.identity && sa.diff.target.identity.scope === 'perRecord' && sa.diff.target.identity.index === 0 && sa.diff.target.identity.id === 'perRecord#1' && sa.diff.target.identity.title === '高額案件の登録' && sa.diff.target.identity.filterCond === 'amount >= "1000000"' && sa.diff.target.identity.targets.length === 3, 'target.identity に scope / index / id / title / 条件 / 通知先を固定');
  assert(sa.diff.human.length === 2 && /✎ レコードの条件通知「高額案件の登録」を変更/.test(sa.diff.human[0]) && /^通知先: .* → .*FIELD_ENTITY:owner$/.test(sa.diff.human[1]), '属性単位の差分: 変更した通知先だけが Before → After で出る（条件・名前は出ない）');
  const byTitle = review(plan([step('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', '高額案件の登録', [], { spec: { filterCond: 'amount >= "2000000"' } })]));
  const sb = st(byTitle, 'P1');
  assert(sb.diff.target.id === 'perRecord#1' && codes(sb).includes('NOTIFICATION_CONDITION_CHANGE') && sb.issues.find(i => i.code === 'NOTIFICATION_CONDITION_CHANGE').message.includes('通知される範囲が狭くなります') && sb.diff.after.filterCond === 'amount >= "2000000"' && sb.diff.human.length === 2 && /^条件: /.test(sb.diff.human[1]), '名前で特定・条件を 100 万→200 万: 範囲が狭くなる警告（通知が届かなくなる可能性）・差分は条件だけ');
  const rm = review(plan([step('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', 'perRecord#1', [], { spec: { targets: ['USER:user1'] } })]));
  assert(codes(st(rm, 'P1')).includes('NOTIFICATION_RECIPIENTS_REMOVED') && st(rm, 'P1').issues.find(i => i.code === 'NOTIFICATION_RECIPIENTS_REMOVED').severity === 'high' && st(rm, 'P1').issues.find(i => i.code === 'NOTIFICATION_RECIPIENTS_REMOVED').message.includes('通知が届かなくなる可能性') && rm.summary.counts.highRisk === 1, '通知先の削除: 高リスク（NOTIFICATION_RECIPIENTS_REMOVED・届かなくなる警告）');
  const ev = review(plan([step('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', 'general#3', [], { spec: { events: ['recordAdded'] } })]));
  assert(codes(st(ev, 'P1')).includes('NOTIFICATION_EVENTS_REMOVED') && st(ev, 'P1').diff.after.events.join() === 'recordAdded' && st(ev, 'P1').diff.target.identity.scope === 'general' && st(ev, 'P1').diff.target.identity.index === 2, 'アプリの条件通知のイベント削除: NOTIFICATION_EVENTS_REMOVED（高リスク）・identity は general#3 = index 2');
  const multi = review(plan([step('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', 'general#3', [], { spec: { targets: ['FIELD_ENTITY:owner', 'USER:user1'] } })]));
  assert(st(multi, 'P1').status === 'INVALID' && codes(st(multi, 'P1')).includes('GENERAL_NOTIFICATION_MULTI_TARGET'), 'アプリの条件通知の通知先を複数にする: INVALID（通知先 1 件ごとの設定。追加は ADD_NOTIFICATION）');
  const gcond = review(plan([step('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', 'general#3', [], { spec: { filterCond: 'amount >= "1"', events: ['recordAdded', 'recordEdited', 'commentAdded', 'statusChanged', 'fileImported'] } })]));
  assert(codes(st(gcond, 'P1')).includes('GENERAL_NOTIFICATION_COND') && st(gcond, 'P1').diff.after.filterCond === '' && codes(st(gcond, 'P1')).includes('NOTIFICATION_EVENTS_ADDED'), 'アプリの条件通知に条件式: 反映しない（GENERAL_NOTIFICATION_COND）・イベント追加は low');
  const amb = review(plan([step('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', '', [], { spec: { targets: ['USER:user1'] } })]));
  assert(st(amb, 'P1').status === 'INVALID' && codes(st(amb, 'P1')).includes('UNKNOWN_NOTIFICATION'), '対象未指定: UNKNOWN_NOTIFICATION');
  const dupTitle = review(plan([step('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', '同名', [], { spec: { targets: ['USER:user1'] } })]), (() => { const d = FX.makeData(); d.perRecordNotify.notifications[0].title = '同名'; d.perRecordNotify.notifications[1].title = '同名'; return { data: d }; })());
  assert(st(dupTitle, 'P1').status === 'INVALID' && codes(st(dupTitle, 'P1')).includes('NOTIFICATION_TARGET_AMBIGUOUS'), '同じ名前の通知が 2 件: title だけでは決めない（NOTIFICATION_TARGET_AMBIGUOUS）');
  const inv = review(plan([step('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', 'perRecord#1', [], { spec: { filterCond: 'owner != ""' } })]));
  assert(codes(st(inv, 'P1')).includes('COND_INVALID'), '無効な条件式（USER_SELECT に !=）: COND_INVALID（KTQueryCheck を共通利用）');
  const noch = review(plan([step('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', 'perRecord#1', [], { spec: { targets: ['USER:user1', 'FIELD_ENTITY:approver', 'FIELD_ENTITY:owner_org'], filterCond: 'amount >= "1000000"' } })]));
  assert(codes(st(noch, 'P1')).includes('NO_STRUCTURED_CHANGE') && st(noch, 'P1').diff.changeType === 'NO_CHANGE' && st(noch, 'P1').diff.target.identity, '同じ値を指定: 変更なし（NO_STRUCTURED_CHANGE）');

  // UPDATE_REMINDER: 日数 / 時刻 / 通知先 / 条件 / 基準日（高リスク）
  const rt = review(plan([step('P1', 'UPDATE_REMINDER', 'REMINDER', 'reminder#1', [], { spec: { daysLater: '-3' } })]));
  const sr = st(rt, 'P1');
  assert(sr.status === 'NEEDS_CONFIRMATION' && sr.safety === 'REVIEW_REQUIRED' && sr.diff.changeType === 'UPDATE' && codes(sr).includes('REMINDER_TIMING_CHANGE') && sr.diff.after.daysLater === '-3' && sr.diff.before.daysLater === '-1' && sr.diff.human.length === 2 && sr.diff.human[1] === 'タイミング: 1 日前 → 3 日前', 'UPDATE_REMINDER 日数変更: REVIEW_REQUIRED・差分は「1 日前 → 3 日前」だけ');
  assert(sr.diff.target.identity && sr.diff.target.identity.id === 'reminder#1' && sr.diff.target.identity.index === 0 && sr.diff.target.identity.timing.code === 'due_date' && sr.diff.target.identity.targets.length === 3, 'identity に id / index / timing / 通知先を固定');
  const rr = review(plan([step('P1', 'UPDATE_REMINDER', 'REMINDER', '期限前日のリマインド', [], { spec: { targets: ['FIELD_ENTITY:owner', 'FIELD_ENTITY:owner_group', 'USER:user1', 'FIELD_ENTITY:approver'], time: '10:00' } })]));
  assert(st(rr, 'P1').diff.target.id === 'reminder#1' && codes(st(rr, 'P1')).includes('REMINDER_RECIPIENTS_ADDED') && codes(st(rr, 'P1')).includes('REMINDER_TIMING_CHANGE') && st(rr, 'P1').diff.after.time === '10:00', '名前で特定・通知先の追加と時刻変更');
  const rb = review(plan([step('P1', 'UPDATE_REMINDER', 'REMINDER', 'reminder#1', [], { spec: { timingField: '作成日時' } })]));
  assert(codes(st(rb, 'P1')).includes('REMINDER_BASE_FIELD_CHANGE') && st(rb, 'P1').issues.find(i => i.code === 'REMINDER_BASE_FIELD_CHANGE').severity === 'high' && rb.summary.counts.highRisk === 1 && st(rb, 'P1').diff.after.timingField === '作成日時', '基準日の変更: 高リスク（REMINDER_BASE_FIELD_CHANGE）');
  const rbad = review(plan([step('P1', 'UPDATE_REMINDER', 'REMINDER', 'reminder#1', [], { spec: { timingField: 'amount' } })]));
  assert(st(rbad, 'P1').status === 'INVALID' && codes(st(rbad, 'P1')).includes('REMINDER_FIELD_TYPE'), '日付型でないフィールドを基準日にする: INVALID');
  const rrm = review(plan([step('P1', 'UPDATE_REMINDER', 'REMINDER', 'reminder#1', [], { spec: { targets: ['USER:user1'] } })]));
  assert(codes(st(rrm, 'P1')).includes('REMINDER_RECIPIENTS_REMOVED') && st(rrm, 'P1').issues.find(i => i.code === 'REMINDER_RECIPIENTS_REMOVED').severity === 'high', '通知先の削除: 高リスク');
  const rc = review(plan([step('P1', 'UPDATE_REMINDER', 'REMINDER', 'reminder#1', [], { spec: { filterCond: 'owner in (LOGINUSER())' } })]));
  assert(codes(st(rc, 'P1')).includes('REMINDER_CONDITION_CHANGE') && codes(st(rc, 'P1')).includes('COND_INVALID'), 'リマインダーの条件に LOGINUSER(): COND_INVALID（API ごとの制限）');
  const rnone = review(plan([step('P1', 'UPDATE_REMINDER', 'REMINDER', 'reminder#9', [], { spec: { daysLater: '-3' } })]));
  assert(st(rnone, 'P1').status === 'INVALID' && codes(st(rnone, 'P1')).includes('UNKNOWN_REMINDER'), '存在しないリマインダー: UNKNOWN_REMINDER');

  // UPDATE_VIEW: 表示項目の追加だけなら SAFE 候補、削除 / 絞り込み / 並び順は REVIEW_REQUIRED、表形式以外・組み込みは仮適用しない
  const va = review(plan([step('P1', 'UPDATE_VIEW', 'VIEW', '承認待ち', [], { spec: { fields: ['case_name', 'approver', 'amount'] } })]));
  const sv = st(va, 'P1');
  assert(sv.status === 'VALID' && sv.safety === 'SAFE' && codes(sv).join() === 'VIEW_FIELDS_ADDED' && sv.diff.after.fields.join() === 'case_name,approver,amount' && sv.diff.human.length === 2 && /^表示フィールド: case_name, approver → case_name, approver, amount$/.test(sv.diff.human[1]) && va.executionReadiness.safeSteps.join() === 'P1', 'UPDATE_VIEW 表示項目の追加だけ: SAFE 候補・差分は表示フィールドだけ');
  assert(sv.diff.target.identity && sv.diff.target.identity.name === '承認待ち' && sv.diff.target.identity.id === '102' && sv.diff.target.identity.fields.join() === 'case_name,approver', 'identity に name / id / fields / 条件 / 並び順を固定');
  const vr = review(plan([step('P1', 'UPDATE_VIEW', 'VIEW', '承認待ち', [], { spec: { fields: ['case_name'] } })]));
  assert(st(vr, 'P1').status === 'NEEDS_CONFIRMATION' && st(vr, 'P1').safety === 'REVIEW_REQUIRED' && codes(st(vr, 'P1')).includes('VIEW_FIELDS_REMOVED'), '表示項目の削除: REVIEW_REQUIRED');
  const vf = review(plan([step('P1', 'UPDATE_VIEW', 'VIEW', '承認待ち', [], { spec: { filterCond: 'ステータス in ("承認待ち", "未処理")' } })]));
  assert(st(vf, 'P1').safety === 'REVIEW_REQUIRED' && codes(st(vf, 'P1')).includes('VIEW_FILTER_CHANGE') && st(vf, 'P1').diff.human.length === 2 && /^条件: /.test(st(vf, 'P1').diff.human[1]), '絞り込みの変更: REVIEW_REQUIRED・差分は条件だけ');
  const vs = review(plan([step('P1', 'UPDATE_VIEW', 'VIEW', '承認待ち', [], { spec: { sort: 'amount desc' } })]));
  assert(st(vs, 'P1').safety === 'REVIEW_REQUIRED' && codes(st(vs, 'P1')).includes('VIEW_SORT_CHANGE'), '並び順の変更: REVIEW_REQUIRED');
  const vm = review(plan([step('P1', 'UPDATE_VIEW', 'VIEW', '承認待ち', [], { spec: { fields: ['case_name', 'approver', 'ghost'] } })]));
  assert(st(vm, 'P1').status === 'INVALID' && codes(st(vm, 'P1')).includes('UNKNOWN_FIELD'), '存在しないフィールドを表示項目に: INVALID');
  const vinv = review(plan([step('P1', 'UPDATE_VIEW', 'VIEW', '承認待ち', [], { spec: { filterCond: 'owner != ""' } })]));
  assert(codes(st(vinv, 'P1')).includes('COND_INVALID'), '一覧の絞り込みも KTQueryCheck（USER_SELECT に !=）');
  const vcal = review(plan([step('P1', 'UPDATE_VIEW', 'VIEW', 'カレンダー', [], { spec: { fields: ['case_name'] } })]), (() => { const d = FX.makeData(); d.views.views['カレンダー'] = { id: '103', name: 'カレンダー', type: 'CALENDAR', index: '2', date: 'due_date', title: 'case_name', filterCond: '', sort: '' }; return { data: d }; })());
  assert(st(vcal, 'P1').status === 'NEEDS_CONFIRMATION' && codes(st(vcal, 'P1')).includes('VIEW_TYPE_NOT_SUPPORTED') && st(vcal, 'P1').diff.changeType === 'NO_CHANGE' && !st(vcal, 'P1').simulated, 'カレンダー形式の一覧: 仮適用しない（計画のみ）');
  const vbi = review(plan([step('P1', 'UPDATE_VIEW', 'VIEW', '（作業者が自分）', [], { spec: { fields: ['case_name'] } })]), (() => { const d = FX.makeData(); d.views.views['（作業者が自分）'] = { id: '104', name: '（作業者が自分）', type: 'LIST', builtinType: 'ASSIGNEE', index: '2', fields: ['case_name', 'owner'], filterCond: '', sort: '' }; return { data: d }; })());
  assert(codes(st(vbi, 'P1')).includes('BUILTIN_VIEW_NOT_SUPPORTED') && !st(vbi, 'P1').simulated, '組み込みの一覧（作業者が自分）: 仮適用しない');
  assert(JSON.stringify(INPUTS.data) === SNAPSHOT, '§10 の後も DATA は不変');
}

console.log('\n--- 11. Phase 12: プロセス管理（Before モデル / identity / 作業者 / 実行可能ユーザー / 条件の分割判定）---');
{
  // Process Before Model: name / index / assignee type / entities / action type / executableUser を正規化
  const m = R.buildBeforeModel(INPUTS.data);
  const wait = m.process.states.find(s => s.name === '承認待ち');
  assert(m.process.enabled === true && m.process.states.map(s => s.index).join() === '0,1,2' && wait.assigneeType === 'ALL' && wait.assignees.length === 6 && wait.assignees.some(e => e.type === 'CUSTOM_FIELD' && e.code === 'supervisor') && wait.assignees.some(e => e.type === 'CREATOR'), 'Before: ステータスの index / 作業者の指定形式 / entities（CUSTOM_FIELD・CREATOR を含む）');
  assert(m.process.actions.map(a => a.type).join() === 'PRIMARY,PRIMARY,SECONDARY' && m.process.actions[2].executableUsers.map(e => `${e.type}:${e.code}`).join() === 'FIELD_ENTITY:owner,USER:user2', 'Before: アクションの type（PRIMARY / SECONDARY）と実行可能ユーザー');
  // identity（UPDATE_PROCESS）: アクション / ステータス
  const cond = review(plan([step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '承認する', [], { spec: { filterCond: 'amount < "1000000"', changeKind: 'ACTION_CONDITION' } })]));
  const c1 = st(cond, 'P1');
  assert(c1.diff.target.identity && c1.diff.target.identity.kind === 'PROCESS_ACTION' && c1.diff.target.identity.from === '承認待ち' && c1.diff.target.identity.to === '完了' && c1.diff.target.identity.filterCond === '' && c1.diff.target.identity.type === 'PRIMARY' && c1.diff.changeKind === 'ACTION_CONDITION', 'UPDATE_PROCESS（アクション）: identity に name / from / to / filterCond / type / executableUsers、changeKind ACTION_CONDITION');
  assert(c1.issues.find(i => i.code === 'EXISTING_PATH_RESTRICTED').message === '⚠ 既存の操作可能条件を変更します。「承認する」は、現在はすべての「承認待ち」で実行できます。変更後は「amount < "1000000"」の場合のみ実行可能になります。' && c1.safety === 'REVIEW_REQUIRED' && c1.diff.after.filterCond === 'amount < "1000000"', '§9 の文言: 既存の操作可能条件を変更します（REVIEW_REQUIRED 以上）');
  const broaden = review(plan([step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', [], { spec: { filterCond: 'amount >= "0"' } })]));
  assert(codes(st(broaden, 'P1')).includes('CONDITION_CHANGE') && !codes(st(broaden, 'P1')).includes('EXISTING_PATH_RESTRICTED') && st(broaden, 'P1').safety === 'REVIEW_REQUIRED', 'broaden condition（amount > "0" → >= "0"）: CONDITION_CHANGE（広がる）・それでも REVIEW_REQUIRED');
  const invalidCond = review(plan([step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '承認する', [], { spec: { filterCond: 'owner in (LOGINUSER())' } })]));
  assert(codes(st(invalidCond, 'P1')).includes('COND_INVALID'), 'invalid expression（プロセスで LOGINUSER）: COND_INVALID');
  const asg = review(plan([step('P1', 'UPDATE_PROCESS', 'PROCESS_STATUS', '承認待ち', [], { spec: { assignees: ['FIELD_ENTITY:approver'], assigneeType: 'ANY', changeKind: 'ASSIGNEE' } })]));
  const a1 = st(asg, 'P1');
  assert(a1.diff.target.identity.kind === 'PROCESS_STATUS' && a1.diff.target.identity.index === 1 && a1.diff.target.identity.assigneeType === 'ALL' && a1.diff.target.identity.assignees.length === 6 && a1.diff.changeKind === 'ASSIGNEE' && a1.diff.after.assignees.join() === 'FIELD_ENTITY:approver' && a1.diff.after.assigneeType === 'ANY' && codes(a1).includes('ASSIGNEE_CHANGE') && codes(a1).includes('ASSIGNEE_TYPE_CHANGE') && a1.safety === 'REVIEW_REQUIRED', 'UPDATE_PROCESS（ステータス）: identity に index / assigneeType / assignees、作業者と指定形式の変更（ANY）');
  const first = review(plan([step('P1', 'UPDATE_PROCESS', 'PROCESS_STATUS', '未処理', [], { spec: { assignees: ['FIELD_ENTITY:owner'] } })]));
  assert(st(first, 'P1').status === 'INVALID' && codes(st(first, 'P1')).includes('FIRST_STATUS_ASSIGNEE'), '先頭ステータスの作業者は設定できない（INVALID）');
  const badType = review(plan([step('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認', [], { spec: { name: '部長承認', assignees: ['FIELD_ENTITY:approver'], assigneeType: '上長が承認' } })]));
  assert(codes(st(badType, 'P1')).includes('ASSIGNEE_TYPE_UNKNOWN') && st(badType, 'P1').diff.after.assigneeType === 'ONE', '語彙外の assigneeType: ASSIGNEE_TYPE_UNKNOWN・ONE として扱う（自由文を API 値にしない）');
  const synonym = review(plan([step('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認', [], { spec: { name: '部長承認', assignees: ['FIELD_ENTITY:approver', 'USER:user1'], assigneeType: '全員' } })]));
  assert(st(synonym, 'P1').diff.after.assigneeType === 'ALL' && !codes(st(synonym, 'P1')).includes('ASSIGNEE_TYPE_UNKNOWN'), '「全員」→ ALL（決定的な同義語）');
  const badField = review(plan([step('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認', [], { spec: { name: '部長承認', assignees: ['FIELD_ENTITY:case_name'] } })]));
  assert(st(badField, 'P1').status === 'INVALID' && codes(st(badField, 'P1')).includes('ASSIGNEE_FIELD_INVALID'), '文字列フィールドを作業者に: INVALID（ASSIGNEE_FIELD_INVALID）');
  const temp = review(plan([step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1'), step('P2', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認', [], { spec: { name: '部長承認', assignees: ['NEW_FIELD_1'] }, dependsOn: ['P1'] }), step('P3', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長へ申請', [], { spec: { name: '部長へ申請', from: '承認待ち', to: '部長承認', filterCond: 'amount >= "1000000"' }, dependsOn: ['P2'] }), step('P4', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長承認する', [], { spec: { name: '部長承認する', from: '部長承認', to: '完了' }, dependsOn: ['P2'] }), step('P5', 'UPDATE_PROCESS', 'PROCESS_ACTION', '承認する', [], { spec: { filterCond: 'amount < "1000000"', changeKind: 'ACTION_CONDITION' }, dependsOn: ['P3'] })], [pf('NEW_FIELD_1', '部長承認者', 'manager_approver', 'USER_SELECT')]));
  assert(st(temp, 'P2').diff.after.assignees[0].code === 'manager_approver' && st(temp, 'P2').diff.after.assigneeType === 'ONE' && !temp.conflicts.some(c => c.code === 'STATUS_UNREACHABLE'), '新規フィールドを作業者にするステータス: temporaryId を解決・到達経路あり');
  const part = temp.simulation.process.partition.find(p => p.from === '承認待ち');
  assert(part && part.verdict === 'PARTITION_OK' && /明らかな重複・欠落なし/.test(part.message) && !temp.warnings.some(w => /^PROCESS_CONDITION_/.test(w.code)), '条件の分割判定: 承認する < 100万 / 部長へ申請 >= 100万 → PARTITION_OK（重複・欠落なし）');
  const overlap = review(plan([step('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認', [], { spec: { name: '部長承認' } }), step('P2', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長へ申請', [], { spec: { name: '部長へ申請', from: '承認待ち', to: '部長承認', filterCond: 'amount >= "1000000"' }, dependsOn: ['P1'] }), step('P3', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長承認する', [], { spec: { name: '部長承認する', from: '部長承認', to: '完了' }, dependsOn: ['P1'] })]));
  const op = overlap.simulation.process.partition.find(p => p.from === '承認待ち');
  assert(op.verdict === 'OVERLAP' && overlap.warnings.some(w => w.code === 'PROCESS_CONDITION_OVERLAP' && w.stepIds.includes('P2')) && codes(st(overlap, 'P2')).includes('PROCESS_CONDITION_OVERLAP'), '既存「承認する」（無条件）と「部長へ申請」（>= 100万）→ OVERLAP（両方のボタンが出る）を警告');
  const gap = review(plan([step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '承認する', [], { spec: { filterCond: 'amount < "500000"' } }), step('P2', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長へ申請', [], { spec: { name: '部長へ申請', from: '承認待ち', to: '完了', filterCond: 'amount >= "1000000"' } })]));
  const gp = gap.simulation.process.partition.find(p => p.from === '承認待ち');
  assert(gp.verdict === 'GAP' && gap.warnings.some(w => w.code === 'PROCESS_CONDITION_GAP') && /欠落/.test(gp.message), '< 50万 と >= 100万 → GAP（50万〜100万のレコードはどのアクションも実行できない）');
  const same2 = review(plan([step('P1', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '別名', [], { spec: { name: '別名', from: '承認待ち', to: '完了', filterCond: 'amount >= "1000000"' } }), step('P2', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '別名2', [], { spec: { name: '別名2', from: '承認待ち', to: '完了', filterCond: 'amount >= "1000000"' } })]));   // Phase 20: 戻し（未処理へ）は分岐の相手にしないので、進む方向で比べる
  assert(same2.simulation.process.partition.find(p => p.from === '承認待ち').verdict === 'IDENTICAL' && same2.warnings.some(w => w.code === 'PROCESS_CONDITION_IDENTICAL'), '同一条件 → IDENTICAL（高）');
  const unk = review(plan([step('P1', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '条件付き', [], { spec: { name: '条件付き', from: '承認待ち', to: '完了', filterCond: 'case_name like "緊急"' } })]));
  assert(unk.simulation.process.partition.find(p => p.from === '承認待ち').verdict === 'UNKNOWN' && unk.warnings.some(w => w.code === 'PROCESS_CONDITION_UNKNOWN'), '評価できない条件（like）→ UNKNOWN（安全と断定しない）');
  // 実行可能ユーザー（作業者以外でも実行できるアクション）
  const sec = review(plan([step('P1', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '差し戻す', [], { spec: { name: '差し戻す', from: '承認待ち', to: '未処理', entities: ['FIELD_ENTITY:owner', 'GROUP:sales_group'] } })]));
  assert(st(sec, 'P1').diff.after.type === 'SECONDARY' && st(sec, 'P1').diff.after.executableUsers.join() === 'FIELD_ENTITY:owner,GROUP:sales_group', 'ADD_PROCESS_ACTION with entities → type SECONDARY・executableUsers');
  const secBad = review(plan([step('P1', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '差し戻す', [], { spec: { name: '差し戻す', from: '承認待ち', to: '未処理', entities: ['CREATOR:'] } })]));
  assert(st(secBad, 'P1').status === 'INVALID' && codes(st(secBad, 'P1')).includes('EXECUTABLE_USER_INVALID'), '実行可能ユーザーに CREATOR: INVALID（API で指定できない）');
  const eu = review(plan([step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '取り下げる', [], { spec: { entities: ['FIELD_ENTITY:owner'], changeKind: 'EXECUTABLE_USER' } })]));
  assert(codes(st(eu, 'P1')).includes('EXECUTABLE_USER_CHANGE') && st(eu, 'P1').issues.find(i => i.code === 'EXECUTABLE_USER_CHANGE').severity === 'high' && eu.summary.counts.highRisk === 1 && st(eu, 'P1').diff.changeKind === 'EXECUTABLE_USER' && st(eu, 'P1').diff.after.executableUsers.join() === 'FIELD_ENTITY:owner', 'UPDATE_PROCESS（実行可能ユーザーの変更: user2 を外す）: EXECUTABLE_USER_CHANGE（高リスク）');
  assert(JSON.stringify(INPUTS.data) === SNAPSHOT, '§11 の後も DATA は不変');
}

console.log('\n--- 12. Lookup Preview Executor の Review（Phase 13 §43〜§45） ---');
{
  // 参照元 App 500「顧客マスタ」: code(unique) / name / address / phone(LINK CALL) / memo(MULTI_LINE) / rank(DROP_DOWN) / sales_rep(USER_SELECT) / credit(NUMBER) / contacts(SUBTABLE: contact_name)
  const withDest = (extraFields = {}) => { const i = buildInputs(); for (const [c, f] of Object.entries(extraFields)) i.data.fields[c] = f; i.deps = KTDeps.buildDependencyData(i.data, KTDeps.normalizeFields(i.data.fields)); return i; };
  const fld = (type, code, label, extra = {}) => ({ type, code, label, ...extra });
  const upd = (spec, extra = {}) => step('P1', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', [], { spec, ...extra });
  // ---- §43 context: 既存ルックアップの特定 ----
  const m0 = R.buildBeforeModel(INPUTS.data);
  assert(m0.fields.customer_lookup.lookup.code === '' && m0.fields.customer_lookup.lookup.pickerFields.join() === 'code,name' && m0.fields.customer_lookup.lookup.filterCond === '' && m0.fields.customer_lookup.lookup.sort === '' && m0.fields.customer_lookup.lookup.mappings.length === 2, 'Before: ルックアップは app / code / keyField / mappings / pickerFields / filterCond / sort で正規化');
  const byApp = review(plan([step('P1', 'UPDATE_LOOKUP', 'LOOKUP', '顧客マスタ', [], { spec: { addMappings: [{ relatedField: 'address', field: 'customer_address' }] } })]), withDest({ customer_address: fld('SINGLE_LINE_TEXT', 'customer_address', '顧客住所') }));
  assert(st(byApp, 'P1').status !== 'INVALID' && st(byApp, 'P1').diff.target.id === 'customer_lookup' && codes(st(byApp, 'P1')).includes('LOOKUP_TARGET_RESOLVED'), 'existing lookup detection: 参照元アプリ名で既存ルックアップを 1 件に特定（LOOKUP_TARGET_RESOLVED）');
  const two = withDest({ customer_lookup2: fld('SINGLE_LINE_TEXT', 'customer_lookup2', '顧客マスタ参照2', { lookup: { relatedApp: { app: '500', code: '' }, relatedKeyField: 'code', fieldMappings: [], lookupPickerFields: [], filterCond: '', sort: '' } }) });
  const amb = review(plan([step('P1', 'UPDATE_LOOKUP', 'LOOKUP', '500', [], { spec: { addMappings: [{ relatedField: 'address', field: 'customer_code' }] } })]), two);
  assert(st(amb, 'P1').status === 'INVALID' && codes(st(amb, 'P1')).includes('LOOKUP_TARGET_AMBIGUOUS') && /customer_lookup2/.test(st(amb, 'P1').issues[0].message), 'multiple lookup candidates: 同じ参照元のルックアップが 2 つ → LOOKUP_TARGET_AMBIGUOUS（決めない）');
  const unavailable = (() => { const i = buildInputs(); i.data.relatedApps['500'] = { appId: '500', error: { code: 'CB_NO02', message: '権限がありません', status: 403 } }; return i; })();
  const un = review(plan([upd({ addMappings: [{ relatedField: 'address', field: 'customer_code' }] })]), unavailable);
  assert(st(un, 'P1').status === 'INVALID' && codes(st(un, 'P1')).includes('RELATED_APP_SETTINGS_UNAVAILABLE') && /アクセス権/.test(st(un, 'P1').issues[0].message) && un.crossApp.length === 1 && un.crossApp[0].available === false, 'related app unavailable: 参照元のフィールド設定が読めない → RELATED_APP_SETTINGS_UNAVAILABLE（推測しない。crossApp に available: false）');
  const notLoaded = (() => { const i = buildInputs(); delete i.data.relatedApps; return i; })();
  const nl = review(plan([upd({ addMappings: [{ relatedField: 'address', field: 'customer_code' }] })]), notLoaded);
  assert(st(nl, 'P1').status === 'INVALID' && codes(st(nl, 'P1')).includes('RELATED_APP_SETTINGS_UNAVAILABLE'), 'relatedApps が無い DATA でも UPDATE_LOOKUP は推測せず INVALID');
  const nullLk = (() => { const i = buildInputs(); i.data.fields.blind_lookup = { type: 'SINGLE_LINE_TEXT', code: 'blind_lookup', label: '権限なし参照', lookup: null }; return i; })();
  const nlk = review(plan([step('P1', 'UPDATE_LOOKUP', 'LOOKUP', 'blind_lookup', [], { spec: { addMappings: [{ relatedField: 'address', field: 'customer_code' }] } })]), nullLk);
  assert(st(nlk, 'P1').status === 'INVALID' && codes(st(nlk, 'P1')).includes('RELATED_APP_SETTINGS_UNAVAILABLE') && R.buildBeforeModel(nullLk.data).fields.blind_lookup.lookupUnavailable === true, 'lookup: null（参照先の権限なし）のフィールド → lookupUnavailable、UPDATE_LOOKUP は INVALID');
  // source field exists / missing
  const srcMissing = review(plan([upd({ addMappings: [{ relatedField: 'zip', field: 'customer_code' }] })]));
  assert(st(srcMissing, 'P1').status === 'INVALID' && codes(st(srcMissing, 'P1')).includes('RELATED_FIELD_NOT_FOUND'), 'source field missing: 参照元に無いフィールド → RELATED_FIELD_NOT_FOUND');
  const srcTable = review(plan([upd({ addMappings: [{ relatedField: 'contact_name', field: 'customer_code' }] })]));
  assert(st(srcTable, 'P1').status === 'INVALID' && codes(st(srcTable, 'P1')).includes('RELATED_FIELD_IN_TABLE'), 'source in table: 参照元のテーブル内フィールド → RELATED_FIELD_IN_TABLE');
  const srcLabel = review(plan([upd({ addMappings: [{ relatedField: '住所', field: 'customer_address' }] })]), withDest({ customer_address: fld('SINGLE_LINE_TEXT', 'customer_address', '顧客住所') }));
  assert(st(srcLabel, 'P1').status !== 'INVALID' && st(srcLabel, 'P1').diff.after.lookup.mappings.some(m => m.from === 'address' && m.to === 'customer_address'), 'source by label: 参照元のラベル「住所」→ code address に解決');
  // destination exists / proposed / ambiguous
  const destExists = review(plan([upd({ addMappings: [{ relatedField: 'address', field: 'customer_address' }] })]), withDest({ customer_address: fld('SINGLE_LINE_TEXT', 'customer_address', '顧客住所') }));
  const de = st(destExists, 'P1');
  assert(de.status === 'VALID' && de.safety === 'REVIEW_REQUIRED' && de.diff.changeType === 'UPDATE' && de.diff.lookupChanges.mappings.length === 1 && de.diff.lookupChanges.mappings[0].proposed === false && de.diff.human.some(h => /参照元: App 500「顧客マスタ」 \/ キー: code（顧客コード）/.test(h)) && de.diff.human.some(h => /＋ 取得項目: address（住所） → customer_address（顧客住所）$/.test(h)), 'destination exists: 既存フィールドへ取得項目を追加（VALID / REVIEW_REQUIRED、参照元・キー・取得項目の行）');
  const destProposed = review(plan([step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1'), step('P2', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', [], { dependsOn: ['P1'], spec: { addMappings: [{ relatedField: 'address', field: 'NEW_FIELD_1' }] } })], [pf('NEW_FIELD_1', '顧客住所', 'customer_address', 'SINGLE_LINE_TEXT')]));
  const dp = st(destProposed, 'P2');
  assert(dp.status !== 'INVALID' && dp.diff.lookupChanges.mappings[0].proposed === true && dp.diff.human.some(h => /customer_address（顧客住所）・この計画で追加/.test(h)) && dp.diff.target.identity.mappings.length === 2 && dp.diff.after.lookup.mappings.length === 3, 'destination proposed: 先行 ADD_FIELD の NEW_FIELD_1 をコピー先に解決（・この計画で追加。identity は変更前の 2 項目）');
  const ambData = withDest({ customer_address: fld('SINGLE_LINE_TEXT', 'customer_address', '顧客住所'), ship_address: fld('SINGLE_LINE_TEXT', 'ship_address', '送付先住所') });
  const destAmb = review(plan([step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1'), step('P2', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', [], { dependsOn: ['P1'], spec: { addMappings: [{ relatedField: 'address', field: 'NEW_FIELD_1' }] } })], [pf('NEW_FIELD_1', '住所', 'address_copy', 'SINGLE_LINE_TEXT')]), ambData);
  assert(destAmb.warnings.filter(w => w.code === 'POSSIBLE_EXISTING_REUSE').length === 2 && st(destAmb, 'P1').status === 'WARNING', 'destination ambiguous: 顧客住所 / 送付先住所 が既にある → POSSIBLE_EXISTING_REUSE ×2（新規追加は確認）');
  const pick = review(plan([upd({ addMappings: [{ relatedField: 'address', field: 'customer_address' }] })]), ambData);
  assert(st(pick, 'P1').status === 'NEEDS_CONFIRMATION' && st(pick, 'P1').safety === 'REVIEW_REQUIRED' && codes(st(pick, 'P1')).includes('LOOKUP_DEST_AMBIGUOUS') && /送付先住所/.test(st(pick, 'P1').issues.find(i => i.code === 'LOOKUP_DEST_AMBIGUOUS').message) && st(pick, 'P1').issues.find(i => i.code === 'LOOKUP_DEST_AMBIGUOUS').candidates.join() === 'customer_address,ship_address', 'destination ambiguous（既存を選んだ）: 似た名前の既存フィールドが他にもある → LOOKUP_DEST_AMBIGUOUS（要確認・候補を列挙）');
  const pickOnly = review(plan([upd({ addMappings: [{ relatedField: 'address', field: 'customer_address' }] })]), withDest({ customer_address: fld('SINGLE_LINE_TEXT', 'customer_address', '顧客住所') }));
  assert(!codes(st(pickOnly, 'P1')).includes('LOOKUP_DEST_AMBIGUOUS'), '候補が 1 つだけなら LOOKUP_DEST_AMBIGUOUS は出ない');
  // ---- §44 mapping ----
  const multi = review(plan([step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1'), step('P2', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_2'), step('P3', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', [], { dependsOn: ['P1', 'P2'], spec: { addMappings: [{ relatedField: 'address', field: 'NEW_FIELD_1' }, { relatedField: 'phone', field: 'NEW_FIELD_2' }] } })], [pf('NEW_FIELD_1', '顧客住所', 'customer_address', 'SINGLE_LINE_TEXT'), pf('NEW_FIELD_2', '顧客電話番号', 'customer_phone', 'LINK')]));
  const mu = st(multi, 'P3');
  assert((mu.status === 'VALID' || mu.status === 'WARNING') && mu.diff.after.lookup.mappings.length === 4 && mu.diff.after.lookup.mappings.slice(0, 2).map(m => m.to).join() === 'customer_code,case_name' && mu.diff.after.lookup.pickerFields.join() === 'code,name' && multi.executionReadiness.reviewSteps.includes('P3') && multi.crossApp.length === 1 && multi.crossApp[0].appId === '500' && multi.crossApp[0].stepIds.join() === 'P3' && /^[0-9a-f]{8}$/.test(multi.crossApp[0].fieldsHash) && multi.crossApp[0].revision === '21', 'add multiple mappings: 住所 / 電話番号 を新規 2 フィールドへ（既存 2 項目と picker は保持。crossApp に 500 / revision / fieldsHash）');
  const dup = review(plan([upd({ addMappings: [{ relatedField: 'name', field: 'case_name' }] })]));
  assert(st(dup, 'P1').status === 'NEEDS_CONFIRMATION' && codes(st(dup, 'P1')).includes('LOOKUP_MAPPING_DUPLICATE') && codes(st(dup, 'P1')).includes('NO_STRUCTURED_CHANGE') && st(dup, 'P1').diff.changeType === 'NO_CHANGE', 'duplicate mapping: 既にある取得項目と同じ → LOOKUP_MAPPING_DUPLICATE（変更なし）');
  const conflict = withDest({ customer_address: fld('SINGLE_LINE_TEXT', 'customer_address', '顧客住所'), other_lookup: fld('SINGLE_LINE_TEXT', 'other_lookup', '別参照', { lookup: { relatedApp: { app: '500', code: '' }, relatedKeyField: 'code', fieldMappings: [{ field: 'customer_address', relatedField: 'address' }], lookupPickerFields: [], filterCond: '', sort: '' } }) });
  const cf = review(plan([upd({ addMappings: [{ relatedField: 'address', field: 'customer_address' }] })]), conflict);
  assert(codes(st(cf, 'P1')).includes('LOOKUP_DEST_CONFLICT') && st(cf, 'P1').status === 'NEEDS_CONFIRMATION' && cf.conflicts.some(c => c.code === 'LOOKUP_DEST_CONFLICT'), 'destination conflict: 別のルックアップも書き込むコピー先 → LOOKUP_DEST_CONFLICT（高・conflicts）');
  const tm = review(plan([upd({ addMappings: [{ relatedField: 'address', field: 'amount' }] })]));
  assert(st(tm, 'P1').status === 'INVALID' && codes(st(tm, 'P1')).includes('LOOKUP_TYPE_MISMATCH') && /SINGLE_LINE_TEXT \/ MULTI_LINE_TEXT \/ RICH_TEXT/.test(st(tm, 'P1').issues.find(i => i.code === 'LOOKUP_TYPE_MISMATCH').message), 'type mismatch: 文字列（住所）→ 数値（amount）は取得できない → LOOKUP_TYPE_MISMATCH（取得できる型を示す）');
  const tmP = review(plan([step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1'), step('P2', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', [], { dependsOn: ['P1'], spec: { addMappings: [{ relatedField: 'credit', field: 'NEW_FIELD_1' }] } })], [pf('NEW_FIELD_1', '与信枠', 'credit_copy', 'SINGLE_LINE_TEXT')]));
  assert(st(tmP, 'P2').status === 'INVALID' && /新規フィールドの種類を合わせてください/.test(st(tmP, 'P2').issues.find(i => i.code === 'LOOKUP_TYPE_MISMATCH').message), 'type mismatch（新規コピー先）: NUMBER → SINGLE_LINE_TEXT の新規フィールドは種類を合わせる案内');
  const compat = [['credit', 'amount', true], ['rank', 'customer_code', true], ['memo', 'customer_code', false], ['sales_rep', 'owner', true], ['レコード番号', 'amount', true], ['phone', 'customer_code', false]];
  for (const [from, to, ok] of compat) { const rv = review(plan([upd({ addMappings: [{ relatedField: from, field: to }] })])); assert((st(rv, 'P1').status !== 'INVALID') === ok, `type table: ${from} → ${to} は${ok ? '取得できる' : '取得できない'}`); }
  const self = review(plan([upd({ addMappings: [{ relatedField: 'code', field: 'customer_lookup' }] })]));
  assert(st(self, 'P1').status === 'INVALID' && codes(st(self, 'P1')).includes('LOOKUP_DEST_IS_SELF'), 'self destination: ルックアップ自身をコピー先に → INVALID');
  const preserve = review(plan([upd({ addMappings: [{ relatedField: 'address', field: 'customer_address' }], addPickerFields: ['address'], filterCond: 'rank in ("A")', sort: 'code asc' })]), withDest({ customer_address: fld('SINGLE_LINE_TEXT', 'customer_address', '顧客住所') }));
  const pv = st(preserve, 'P1');
  assert(pv.status === 'NEEDS_CONFIRMATION' && pv.safety === 'REVIEW_REQUIRED' && pv.diff.before.lookup.mappings.length === 2 && pv.diff.after.lookup.mappings.length === 3 && pv.diff.after.lookup.app === '500' && pv.diff.after.lookup.keyField === 'code' && pv.diff.after.lookup.pickerFields.join() === 'code,name,address' && pv.diff.after.lookup.filterCond === 'rank in ("A")' && pv.diff.after.lookup.sort === 'code asc' && pv.diff.target.identity.filterCond === '' && pv.diff.target.identity.related.appId === '500' && pv.diff.target.identity.related.fieldsHash === preserve.crossApp[0].fieldsHash, 'existing preserved: 参照元・キー・既存取得項目・picker を保ったまま追加（identity は変更前、fingerprint 付き）');
  // ---- §45 settings: picker / filterCond / sort / relatedApp・key unchanged ----
  const pk = review(plan([upd({ addPickerFields: ['address', 'name', 'contact_name', 'nothing'] })]));
  assert(st(pk, 'P1').status === 'INVALID' && codes(st(pk, 'P1')).includes('PICKER_FIELD_INVALID') && codes(st(pk, 'P1')).includes('PICKER_FIELD_NOT_FOUND') && codes(st(pk, 'P1')).includes('PICKER_FIELD_DUPLICATE'), 'picker fields: テーブル内 → INVALID、無い → PICKER_FIELD_NOT_FOUND、既にある → 重複（変更なし）');
  const pkOk = review(plan([upd({ addPickerFields: ['address'] })]));
  assert(['VALID', 'WARNING'].includes(st(pkOk, 'P1').status) && st(pkOk, 'P1').safety === 'REVIEW_REQUIRED' && st(pkOk, 'P1').diff.after.lookup.pickerFields.join() === 'code,name,address' && st(pkOk, 'P1').diff.human.some(h => h === '＋ 選択時に表示: address（住所）'), 'picker add: 選択時に表示するフィールドの追加だけ → VALID（JS 参照の警告は別）/ REVIEW_REQUIRED');
  const fcOk = review(plan([upd({ filterCond: 'rank in ("A") and credit >= "100"' })]));
  assert(st(fcOk, 'P1').status === 'NEEDS_CONFIRMATION' && codes(st(fcOk, 'P1')).includes('LOOKUP_FILTER_CHANGE') && !codes(st(fcOk, 'P1')).includes('COND_INVALID') && st(fcOk, 'P1').diff.after.lookup.filterCond === 'rank in ("A") and credit >= "100"', 'filterCond valid: 参照元のフィールドで書かれた条件 → LOOKUP_FILTER_CHANGE（要確認）');
  const fcUnknown = review(plan([upd({ filterCond: 'customer_code = "A"' })]));
  assert(st(fcUnknown, 'P1').status === 'INVALID' && codes(st(fcUnknown, 'P1')).includes('LOOKUP_FILTER_FIELD_UNKNOWN'), 'filterCond invalid（このアプリのフィールドで書いた）: 参照元に無い → LOOKUP_FILTER_FIELD_UNKNOWN');
  const fcTable = review(plan([upd({ filterCond: 'contact_name = "x"' })]));
  assert(codes(st(fcTable, 'P1')).includes('COND_INVALID') && st(fcTable, 'P1').issues.find(i => i.code === 'COND_INVALID').message.includes('テーブル内のフィールド'), 'filterCond invalid（テーブル内）: KTQueryCheck lookup 用途 → COND_INVALID');
  const fcOp = review(plan([upd({ filterCond: 'memo = "x"' })]));
  assert(codes(st(fcOp, 'P1')).includes('COND_INVALID'), 'filterCond invalid（複数行に =）: 演算子の検査も参照元の型で行う');
  const sOk = review(plan([upd({ sort: 'name asc, code desc' })]));
  assert(st(sOk, 'P1').status === 'NEEDS_CONFIRMATION' && codes(st(sOk, 'P1')).includes('LOOKUP_SORT_CHANGE') && st(sOk, 'P1').diff.after.lookup.sort === 'name asc, code desc', 'sort valid: 参照元のフィールド asc / desc');
  const sBad = review(plan([upd({ sort: 'zip asc' })]));
  assert(st(sBad, 'P1').status === 'INVALID' && codes(st(sBad, 'P1')).includes('LOOKUP_SORT_FIELD_UNKNOWN'), 'sort invalid: 参照元に無いフィールド → INVALID');
  const sForm = review(plan([upd({ sort: 'name ascending' })]));
  assert(codes(st(sForm, 'P1')).includes('LOOKUP_SORT_INVALID') && st(sForm, 'P1').status === 'NEEDS_CONFIRMATION', 'sort invalid（形）: 「code asc|desc」でない → 要確認');
  const sType = review(plan([upd({ sort: 'memo asc' })]));
  assert(codes(st(sType, 'P1')).includes('LOOKUP_SORT_FIELD_NOT_SORTABLE'), 'sort invalid（型）: 複数行テキストは並び順に使えない');
  const srcChange = review(plan([upd({ sourceApp: '600', addMappings: [{ relatedField: 'address', field: 'customer_code' }] })]));
  assert(st(srcChange, 'P1').safety === 'PLAN_ONLY' && codes(st(srcChange, 'P1')).includes('LOOKUP_SOURCE_CHANGE') && st(srcChange, 'P1').diff.after.lookup.app === '500' && srcChange.executionReadiness.planOnlySteps.includes('P1'), 'relatedApp change: 参照元の変更は PLAN_ONLY（After の参照元は変えない）');
  const keyChange = review(plan([upd({ keyField: 'name' })]));
  assert(st(keyChange, 'P1').safety === 'PLAN_ONLY' && codes(st(keyChange, 'P1')).includes('LOOKUP_KEY_CHANGE') && st(keyChange, 'P1').diff.changeType === 'NO_CHANGE' && st(keyChange, 'P1').diff.after.lookup.keyField === 'code', 'relatedKey change: キーの変更は PLAN_ONLY（変更なし）');
  const same = review(plan([upd({ sourceApp: '500', keyField: 'code', addPickerFields: ['address'] })]));
  assert(!codes(st(same, 'P1')).includes('LOOKUP_SOURCE_CHANGE') && !codes(st(same, 'P1')).includes('LOOKUP_KEY_CHANGE') && st(same, 'P1').safety === 'REVIEW_REQUIRED', 'relatedApp / key unchanged: 現在と同じ指定は変更と見ない');
  const keyBroken = (() => { const i = buildInputs(); delete i.data.relatedApps['500'].fields.code; return i; })();
  const kb = review(plan([upd({ addPickerFields: ['address'] })]), keyBroken);
  assert(st(kb, 'P1').status === 'INVALID' && codes(st(kb, 'P1')).includes('RELATED_KEY_INVALID'), 'related key validation: 参照元からキーが消えている → RELATED_KEY_INVALID');
  const keyNotUnique = (() => { const i = buildInputs(); i.data.relatedApps['500'].fields.code.unique = false; return i; })();
  const knu = review(plan([upd({ addPickerFields: ['address'] })]), keyNotUnique);
  assert(['VALID', 'WARNING'].includes(st(knu, 'P1').status) && codes(st(knu, 'P1')).includes('LOOKUP_KEY_NOT_UNIQUE') && st(knu, 'P1').issues.find(i => i.code === 'LOOKUP_KEY_NOT_UNIQUE').severity === 'low', 'related key not unique: 運用上の注意（low）。実行は妨げない');
  const addLkChecked = review(plan([step('P1', 'ADD_LOOKUP', 'PROPOSED_FIELD', 'NEW_FIELD_1', [], { spec: { sourceApp: '500', keyField: 'code', mappings: [{ from: 'zip', to: 'customer_code' }] } })], [pf('NEW_FIELD_1', '顧客参照', 'cust_ref', 'LOOKUP')]));
  assert(st(addLkChecked, 'P1').status === 'INVALID' && codes(st(addLkChecked, 'P1')).includes('RELATED_FIELD_NOT_FOUND'), 'ADD_LOOKUP も参照元が取得済みなら取得元の実在を確かめる');
  const addLkNum = review(plan([step('P1', 'ADD_LOOKUP', 'PROPOSED_FIELD', 'NEW_FIELD_1', [], { spec: { sourceApp: '500', keyField: 'credit', mappings: [{ from: 'name', to: 'case_name' }] } })], [pf('NEW_FIELD_1', '与信参照', 'credit_ref', 'LOOKUP')]));
  assert(st(addLkNum, 'P1').status !== 'INVALID' && addLkNum.simulation.after.fields.credit_ref.baseType === 'NUMBER' && codes(st(addLkNum, 'P1')).includes('LOOKUP_KEY_NOT_UNIQUE'), 'ADD_LOOKUP: キーの型をルックアップの型にする（NUMBER）・キーの重複禁止なしは注意');
  const addLkOther = review(plan([step('P1', 'ADD_LOOKUP', 'PROPOSED_FIELD', 'NEW_FIELD_1', [], { spec: { sourceApp: '999999', keyField: 'code', mappings: [{ from: 'name', to: 'case_name' }] } })], [pf('NEW_FIELD_1', '別参照', 'other_ref', 'LOOKUP')]));
  assert(codes(st(addLkOther, 'P1')).includes('LOOKUP_SOURCE_NOT_LOADED') && st(addLkOther, 'P1').status === 'NEEDS_CONFIRMATION', 'ADD_LOOKUP（未取得の参照元）: 推測せず要確認（LOOKUP_SOURCE_NOT_LOADED）');
  // normalizeSpec: details の文章形も addMappings に読む
  const det = review(plan([step('P1', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', [['追加する取得項目', 'address → customer_address, phone → customer_phone'], ['選択時に表示するフィールド', 'address']])]), withDest({ customer_address: fld('SINGLE_LINE_TEXT', 'customer_address', '顧客住所'), customer_phone: fld('LINK', 'customer_phone', '顧客電話', { protocol: 'CALL' }) }));
  assert(st(det, 'P1').status === 'VALID' && st(det, 'P1').diff.after.lookup.mappings.length === 4 && st(det, 'P1').diff.after.lookup.pickerFields.includes('address'), 'details（追加する取得項目 / 選択時に表示するフィールド）も addMappings / addPickerFields に正規化');
  const linkMismatch = review(plan([upd({ addMappings: [{ relatedField: 'phone', field: 'customer_url' }] })]), withDest({ customer_url: fld('LINK', 'customer_url', 'URL', { protocol: 'WEB' }) }));
  assert(st(linkMismatch, 'P1').status === 'INVALID' && /リンクの種類/.test(st(linkMismatch, 'P1').issues.find(i => i.code === 'LOOKUP_TYPE_MISMATCH').message), 'LINK: プロトコル（CALL / WEB）が違えば取得できない');
  // KTQueryCheck lookup usage
  const KTQueryCheck = loadToolkit().KTQueryCheck;
  const relFields = R.relatedAppModel(INPUTS.data.relatedApps['500'], '500').fields;
  assert(KTQueryCheck.USAGE.lookup && KTQueryCheck.check('contact_name in ("a")', { fields: relFields, usage: 'lookup' }).errors.some(e => e.code === 'COND_FIELD_NOT_ALLOWED') && KTQueryCheck.check('rank in ("A")', { fields: relFields, usage: 'lookup' }).ok && KTQueryCheck.check('contact_name in ("a")', { fields: relFields, usage: 'view' }).ok, 'KTQueryCheck lookup 用途: テーブル内のフィールドは in でも不可（view では可）');
  const fh1 = R.fieldsHash(relFields), fh2 = R.fieldsHash(R.relatedAppModel({ ...INPUTS.data.relatedApps['500'], fields: { ...INPUTS.data.relatedApps['500'].fields, extra: { type: 'SINGLE_LINE_TEXT', code: 'extra', label: 'x' } } }, '500').fields);
  assert(fh1 !== fh2 && fh1 === R.fieldsHash(R.relatedAppModel(JSON.parse(JSON.stringify(INPUTS.data.relatedApps['500'])), '500').fields), 'fieldsHash: 定義が変わると変わり、同じ定義なら同じ（ラベルは含めない）');
  assert(JSON.stringify(INPUTS.data) === SNAPSHOT, '§12 の後も DATA は不変');
}

console.log('\n--- 13. App Action Preview Executor の Review（Phase 14 §41〜§44） ---');
{
  // コピー先 App 311「見積管理」: quote_title(必須) / source_url(LINK WEB) / quote_amount(NUMBER) / customer / note(MULTI_LINE) / issue_date(DATE 必須・初期値なし) / quote_no(必須・初期値あり) / due(必須・今日) / owner_q(USER_SELECT) / phone_q(LINK CALL) / rank_q(DROP_DOWN) / attachment(FILE) / items(SUBTABLE)
  // 既存アクション「見積を作成」: case_name → quote_title, レコードURL → source_url。利用者 USER:user1 / GROUP:sales_group
  const upd = (spec, extra = {}) => step('P1', 'UPDATE_APP_ACTION', 'APP_ACTION', '見積を作成', [], { spec, ...extra });
  const add = (spec, extra = {}) => step('P1', 'ADD_APP_ACTION', 'APP_ACTION', spec.name || '請求書作成', [], { spec, ...extra });
  const m0 = R.buildBeforeModel(INPUTS.data);
  assert(m0.appActions.length === 1 && m0.appActions[0].id === '5520' && m0.appActions[0].index === '0' && m0.appActions[0].destApp.app === '311' && m0.appActions[0].mappings.length === 2 && m0.appActions[0].mappings[1].srcType === 'RECORD_URL' && m0.appActions[0].mappings[1].srcField === null && m0.appActions[0].entities.length === 2 && m0.appActions[0].filterCond === '' && m0.appActions[0].destUnavailable === false, 'App Action Model: id / index / destApp{app, code} / mappings(srcType, srcField, destField) / entities / filterCond');
  // ---- §41 destination ----
  const okUpd = review(plan([upd({ actionMappings: [{ srcType: 'FIELD', srcField: 'secret_memo', destField: 'note' }] })]));
  const u = st(okUpd, 'P1');
  assert(['VALID', 'WARNING', 'NEEDS_CONFIRMATION'].includes(u.status) && u.safety === 'REVIEW_REQUIRED' && u.diff.changeType === 'UPDATE' && u.diff.after.mappings.length === 3 && u.diff.after.mappings[2].srcField === 'secret_memo' && u.diff.after.mappings[2].destField === 'note' && u.diff.before.mappings.length === 2 && u.diff.target.identity.kind === 'APP_ACTION' && u.diff.target.identity.id === '5520' && u.diff.target.identity.dest.appId === '311' && /^[0-9a-f]{8}$/.test(u.diff.target.identity.dest.fieldsHash) && okUpd.crossApp.some(c => c.appId === '311' && c.role === 'destination'), 'destination app exists: 既存アクションに転記を 1 件追加（identity に id / コピー先の指紋、crossApp に destination）');
  assert(u.diff.human.some(h => h === '✎ 既存アプリアクション「見積を作成」を変更') && u.diff.human.some(h => h === 'コピー先: App 311「見積管理」') && u.diff.human.some(h => h === '＋ 転記: secret_memo（機密メモ） → note（備考）') && u.diff.human.some(h => h.startsWith('既存の転記 2 件（case_name→quote_title, レコードURL→source_url）はそのまま')), 'human: ✎ 既存アプリアクション / コピー先 App 311「見積管理」 / ＋ 転記 / 既存はそのまま');
  const unavailable = (() => { const i = buildInputs(); i.data.relatedApps['311'] = { appId: '311', error: { code: 'CB_NO02', message: '権限がありません。', status: 403 } }; return i; })();
  const un = review(plan([upd({ actionMappings: [{ srcType: 'FIELD', srcField: 'secret_memo', destField: 'note' }] })]), unavailable);
  assert(st(un, 'P1').status === 'INVALID' && codes(st(un, 'P1')).includes('DEST_APP_SETTINGS_UNAVAILABLE') && /アクセス権/.test(st(un, 'P1').issues[0].message) && un.crossApp[0].available === false, 'destination unavailable: コピー先の設定が読めない → DEST_APP_SETTINGS_UNAVAILABLE（推測しない）');
  const nullDest = (() => { const i = buildInputs(); i.data.actions.actions['見積を作成'].destApp = null; i.data.actions.actions['見積を作成'].mappings = null; return i; })();
  const nd = review(plan([upd({ actionMappings: [{ srcType: 'FIELD', srcField: 'secret_memo', destField: 'note' }] })]), nullDest);
  assert(st(nd, 'P1').status === 'INVALID' && codes(st(nd, 'P1')).includes('DEST_APP_SETTINGS_UNAVAILABLE') && R.buildBeforeModel(nullDest.data).appActions[0].destUnavailable === true, 'destApp: null（コピー先の権限なし）→ destUnavailable・UPDATE は INVALID');
  const notLoaded = review(plan([add({ name: '請求書作成', destApp: '999', actionMappings: [{ srcType: 'FIELD', srcField: 'case_name', destField: 'title' }] })]));
  assert(st(notLoaded, 'P1').status === 'NEEDS_CONFIRMATION' && st(notLoaded, 'P1').safety === 'REVIEW_REQUIRED' && codes(st(notLoaded, 'P1')).includes('DEST_APP_NOT_LOADED') && st(notLoaded, 'P1').diff.after.mappings[0].destField === 'title' && st(notLoaded, 'P1').diff.appActionChanges.destLoaded === false, 'destination not loaded: 未取得のコピー先 → 要確認（転記先は検証できず、Executor が実行直前に取得して検証）');
  const missing = review(plan([upd({ actionMappings: [{ srcType: 'FIELD', srcField: 'secret_memo', destField: 'remarks' }] })]));
  assert(st(missing, 'P1').status === 'INVALID' && codes(st(missing, 'P1')).includes('DEST_FIELD_NOT_FOUND'), 'missing destination field → DEST_FIELD_NOT_FOUND');
  const byLabel = review(plan([upd({ actionMappings: [{ srcType: 'FIELD', srcField: 'secret_memo', destField: '備考' }] })]));
  assert(st(byLabel, 'P1').status !== 'INVALID' && st(byLabel, 'P1').diff.after.mappings[2].destField === 'note', 'destination by label: 「備考」→ note に解決');
  const req = review(plan([add({ name: '見積を複製', destApp: '311', actionMappings: [{ srcType: 'FIELD', srcField: 'case_name', destField: 'quote_title' }] })]));
  const rq = st(req, 'P1').issues.find(i => i.code === 'DEST_REQUIRED_FIELD_UNMAPPED');
  assert(rq && rq.severity === 'medium' && rq.fields.map(f => f.code).join() === 'issue_date' && /作成時に入力・自動設定/.test(rq.message) && st(req, 'P1').status === 'NEEDS_CONFIRMATION' && st(req, 'P1').diff.appActionChanges.requiredUnmapped[0].label === '見積日', 'required unmapped: 必須で初期値の無い issue_date だけ警告（quote_no は初期値あり・due は今日・quote_title は転記）');
  // ---- §42 mapping ----
  const multi = review(plan([upd({ actionMappings: [{ srcType: 'FIELD', srcField: 'secret_memo', destField: 'note' }, { srcType: 'FIELD', srcField: 'amount', destField: 'quote_amount' }, { srcType: 'FIELD', srcField: 'owner', destField: 'owner_q' }] })]));
  assert(st(multi, 'P1').status !== 'INVALID' && st(multi, 'P1').diff.after.mappings.length === 5 && st(multi, 'P1').diff.appActionChanges.mappings.length === 3, 'add multiple: 3 件追加（既存 2 件は保持）');
  const dup = review(plan([upd({ actionMappings: [{ srcType: 'FIELD', srcField: 'case_name', destField: 'quote_title' }] })]));
  assert(codes(st(dup, 'P1')).includes('APP_ACTION_MAPPING_DUPLICATE') && st(dup, 'P1').diff.changeType === 'NO_CHANGE' && codes(st(dup, 'P1')).includes('NO_STRUCTURED_CHANGE'), 'duplicate mapping: 既にある転記 → APP_ACTION_MAPPING_DUPLICATE（変更なし）');
  const conflict = review(plan([upd({ actionMappings: [{ srcType: 'FIELD', srcField: 'customer_code', destField: 'quote_title' }] })]));
  assert(st(conflict, 'P1').status === 'INVALID' && codes(st(conflict, 'P1')).includes('APP_ACTION_DESTINATION_CONFLICT'), 'destination collision: 既存の転記先に別の転記元 → APP_ACTION_DESTINATION_CONFLICT');
  const conflict2 = review(plan([add({ name: '請求書作成', destApp: '311', actionMappings: [{ srcType: 'FIELD', srcField: 'case_name', destField: 'customer' }, { srcType: 'FIELD', srcField: 'customer_code', destField: 'customer' }] })]));
  assert(st(conflict2, 'P1').status === 'INVALID' && codes(st(conflict2, 'P1')).includes('APP_ACTION_DESTINATION_CONFLICT'), 'destination collision（同じ計画内）');
  const compat = [['amount', 'quote_title', false], ['amount', 'quote_amount', true], ['total', 'quote_amount', true], ['レコード番号', 'quote_amount', true], ['case_name', 'note', false], ['secret_memo', 'note', true], ['owner', 'owner_q', true], ['作成者', 'owner_q', true], ['due_date', 'issue_date', true], ['case_name', 'phone_q', true], ['customer_lookup', 'customer', true], ['case_name', 'attachment', false], ['quotes', 'note', false], ['case_name', 'item_name', false]];
  for (const [from, to, ok] of compat) { const rv = review(plan([upd({ actionMappings: [{ srcType: 'FIELD', srcField: from, destField: to }] })])); assert((st(rv, 'P1').status !== 'INVALID') === ok, `type table: ${from} → ${to} は${ok ? '転記できる' : '転記できない'}`); }
  const tm = review(plan([upd({ actionMappings: [{ srcType: 'FIELD', srcField: 'amount', destField: 'customer' }] })]));
  assert(codes(st(tm, 'P1')).includes('APP_ACTION_MAPPING_TYPE_MISMATCH') && /NUMBER/.test(st(tm, 'P1').issues.find(i => i.code === 'APP_ACTION_MAPPING_TYPE_MISMATCH').message), 'type mismatch: 数値 → 文字列（1行）は転記できない（転記できる種類を示す）');
  const url = review(plan([add({ name: '請求書作成', destApp: '311', actionMappings: [{ srcType: 'RECORD_URL', srcField: null, destField: 'source_url' }] })]));
  assert(st(url, 'P1').status !== 'INVALID' && st(url, 'P1').diff.after.mappings[0].srcType === 'RECORD_URL' && st(url, 'P1').diff.after.mappings[0].srcField === null && st(url, 'P1').diff.human.some(h => h === '＋ 転記: レコードURL → source_url（元案件URL）'), 'RECORD_URL: srcField なし・リンク（Web）へ転記');
  const urlBad = review(plan([add({ name: '請求書作成', destApp: '311', actionMappings: [{ srcType: 'RECORD_URL', srcField: null, destField: 'phone_q' }] })]));
  const urlBad2 = review(plan([add({ name: '請求書作成', destApp: '311', actionMappings: [{ srcType: 'RECORD_URL', srcField: null, destField: 'customer' }] })]));
  assert(st(urlBad, 'P1').status === 'INVALID' && st(urlBad2, 'P1').status === 'INVALID' && codes(st(urlBad2, 'P1')).includes('APP_ACTION_MAPPING_TYPE_MISMATCH'), 'RECORD_URL: 電話リンク・文字列へは転記できない');
  const urlText = review(plan([step('P1', 'UPDATE_APP_ACTION', 'APP_ACTION', '見積を作成', [['転記', 'レコードURL → source_url, secret_memo → note']])]));
  assert(st(urlText, 'P1').status !== 'INVALID' && codes(st(urlText, 'P1')).includes('APP_ACTION_MAPPING_DUPLICATE') && st(urlText, 'P1').diff.after.mappings.length === 3, 'details の文章形（レコードURL → …）も actionMappings に正規化（既存の URL 転記は重複として変更なし）');
  const preserved = review(plan([upd({ actionMappings: [{ srcType: 'FIELD', srcField: 'secret_memo', destField: 'note' }] })]));
  const pv = st(preserved, 'P1');
  assert(pv.diff.after.mappings.slice(0, 2).map(m => `${m.srcType}:${m.srcField}:${m.destField}`).join() === 'FIELD:case_name:quote_title,RECORD_URL:null:source_url' && pv.diff.after.entities.map(e => `${e.type}:${e.code}`).join() === 'USER:user1,GROUP:sales_group' && pv.diff.after.destApp.app === '311' && pv.diff.after.name === '見積を作成' && pv.diff.after.index === '0', 'existing preserved: 既存の転記・利用者・コピー先・名前・並び順はそのまま');
  const srcMissing = review(plan([upd({ actionMappings: [{ srcType: 'FIELD', srcField: 'ghost', destField: 'note' }] })]));
  assert(st(srcMissing, 'P1').status === 'INVALID' && codes(st(srcMissing, 'P1')).includes('UNKNOWN_FIELD'), 'source missing → INVALID');
  const srcProposed = review(plan([step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1'), step('P2', 'UPDATE_APP_ACTION', 'APP_ACTION', '見積を作成', [], { dependsOn: ['P1'], spec: { actionMappings: [{ srcType: 'FIELD', srcField: 'NEW_FIELD_1', destField: 'note' }] } })], [pf('NEW_FIELD_1', '備考', 'remarks', 'MULTI_LINE_TEXT')]));
  assert(st(srcProposed, 'P2').status !== 'INVALID' && st(srcProposed, 'P2').diff.after.mappings[2].srcField === 'remarks', 'source proposed: 先行 ADD_FIELD の NEW_FIELD_1 を転記元に解決');
  // ---- §44 update: entities / filterCond / rename / dest change ----
  const ent = review(plan([upd({ entities: ['GROUP:sales_group', 'ORGANIZATION:sales_div'] })]));
  const en = st(ent, 'P1');
  assert(en.status === 'NEEDS_CONFIRMATION' && codes(en).includes('APP_ACTION_ENTITIES_REMOVED') && en.issues.find(i => i.code === 'APP_ACTION_ENTITIES_REMOVED').severity === 'high' && /USER:user1/.test(en.issues.find(i => i.code === 'APP_ACTION_ENTITIES_REMOVED').message) && en.diff.after.entities.map(e => `${e.type}:${e.code}`).join() === 'GROUP:sales_group,ORGANIZATION:sales_div' && ent.summary.counts.highRisk === 1, 'entities change: user1 を外す → APP_ACTION_ENTITIES_REMOVED（高・要確認）');
  const entBad = review(plan([upd({ entities: ['FIELD_ENTITY:owner'] })]));
  assert(st(entBad, 'P1').status === 'INVALID' && codes(st(entBad, 'P1')).includes('APP_ACTION_ENTITY_INVALID'), 'entities: FIELD_ENTITY は使えない（INVALID）');
  const entEveryone = review(plan([add({ name: '請求書作成', destApp: '311', actionMappings: [{ srcType: 'FIELD', srcField: 'case_name', destField: 'customer' }] })]));
  assert(st(entEveryone, 'P1').diff.after.entities.length === 1 && st(entEveryone, 'P1').diff.after.entities[0].code === 'everyone' && codes(st(entEveryone, 'P1')).includes('APP_ACTION_ENTITIES_DEFAULT_EVERYONE'), 'ADD で利用者の指定なし → Everyone（画面の既定）');
  const fc = review(plan([upd({ filterCond: 'ステータス in ("承認待ち")' })]));
  assert(st(fc, 'P1').status === 'NEEDS_CONFIRMATION' && codes(st(fc, 'P1')).includes('APP_ACTION_CONDITION_CHANGE') && !codes(st(fc, 'P1')).includes('COND_INVALID') && st(fc, 'P1').diff.after.filterCond === 'ステータス in ("承認待ち")', 'filterCond change: KTQueryCheck（appAction）で検証して要確認');
  const fcBad = review(plan([upd({ filterCond: 'ISBLANK(owner)' })]));
  assert(codes(st(fcBad, 'P1')).includes('COND_UNKNOWN_FUNCTION'), 'filterCond invalid: kintone に無い関数');
  const rename = review(plan([upd({ name: '見積書を作成', actionMappings: [{ srcType: 'FIELD', srcField: 'secret_memo', destField: 'note' }] })]));
  assert(st(rename, 'P1').safety === 'PLAN_ONLY' && codes(st(rename, 'P1')).includes('APP_ACTION_RENAME') && rename.executionReadiness.planOnlySteps.includes('P1'), 'rename → PLAN_ONLY');
  const destChange = review(plan([upd({ destApp: '600', actionMappings: [{ srcType: 'FIELD', srcField: 'secret_memo', destField: 'note' }] })]));
  assert(st(destChange, 'P1').safety === 'PLAN_ONLY' && codes(st(destChange, 'P1')).includes('APP_ACTION_DEST_CHANGE') && st(destChange, 'P1').diff.after.destApp.app === '311', 'destination change → PLAN_ONLY（After のコピー先は変えない）');
  const sameDest = review(plan([upd({ destApp: '311', actionMappings: [{ srcType: 'FIELD', srcField: 'secret_memo', destField: 'note' }] })]));
  assert(!codes(st(sameDest, 'P1')).includes('APP_ACTION_DEST_CHANGE') && st(sameDest, 'P1').safety === 'REVIEW_REQUIRED', '同じコピー先の指定は変更と見ない');
  // existing action detection / ambiguity
  const byDest = review(plan([step('P1', 'UPDATE_APP_ACTION', 'APP_ACTION', '見積管理', [], { spec: { actionMappings: [{ srcType: 'FIELD', srcField: 'secret_memo', destField: 'note' }] } })]));
  assert(st(byDest, 'P1').status !== 'INVALID' && st(byDest, 'P1').diff.target.id === '見積を作成' && codes(st(byDest, 'P1')).includes('APP_ACTION_TARGET_RESOLVED'), 'existing action detection: コピー先のアプリ名で既存アクションを 1 件に特定');
  const two = (() => { const i = buildInputs(); i.data.actions.actions['再見積'] = { ...JSON.parse(JSON.stringify(i.data.actions.actions['見積を作成'])), name: '再見積', id: '5521', index: '1' }; return i; })();
  const amb = review(plan([step('P1', 'UPDATE_APP_ACTION', 'APP_ACTION', '311', [], { spec: { actionMappings: [{ srcType: 'FIELD', srcField: 'secret_memo', destField: 'note' }] } })]), two);
  assert(st(amb, 'P1').status === 'INVALID' && codes(st(amb, 'P1')).includes('APP_ACTION_TARGET_AMBIGUOUS') && /再見積/.test(st(amb, 'P1').issues[0].message), 'multiple candidates: 同じコピー先のアクションが 2 つ → APP_ACTION_TARGET_AMBIGUOUS（決めない）');
  const addDup = review(plan([add({ name: '見積を作成', destApp: '311', actionMappings: [{ srcType: 'FIELD', srcField: 'case_name', destField: 'customer' }] })]));
  assert(st(addDup, 'P1').status === 'INVALID' && codes(st(addDup, 'P1')).includes('APP_ACTION_NAME_DUPLICATE'), 'ADD: 同名の既存アクション → INVALID（UPDATE を使う）');
  const addOk = review(plan([add({ name: '請求書作成', destApp: '311', actionMappings: [{ srcType: 'FIELD', srcField: 'case_name', destField: 'customer' }, { srcType: 'FIELD', srcField: 'amount', destField: 'quote_amount' }, { srcType: 'RECORD_URL', srcField: null, destField: 'source_url' }], entities: ['GROUP:sales_group'], filterCond: 'amount >= "1"' })]));
  const ao = st(addOk, 'P1');
  assert(ao.status === 'NEEDS_CONFIRMATION' && ao.safety === 'REVIEW_REQUIRED' && ao.diff.changeType === 'ADD' && ao.diff.after.name === '請求書作成' && ao.diff.after.index === '1' && ao.diff.after.destApp.app === '311' && ao.diff.after.mappings.length === 3 && ao.diff.after.entities[0].code === 'sales_group' && ao.diff.after.filterCond === 'amount >= "1"' && addOk.simulation.after.appActions.length === 2 && ao.diff.human[0] === '＋ 新規アプリアクション「請求書作成」' && ao.diff.human.some(h => h === 'コピー先: App 311「見積管理」') && ao.diff.human.some(h => h.startsWith('⚠ コピー先の必須項目: 「見積件名」 「見積日」')), 'ADD_APP_ACTION: 新規アクション（index 末尾・転記 3 件・利用者・条件・必須項目の警告）');
  assert(JSON.stringify(INPUTS.data) === SNAPSHOT, '§13 の後も DATA は不変');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
