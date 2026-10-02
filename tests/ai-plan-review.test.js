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
  assert(Object.keys(caps).length === 19 && Object.values(caps).every(c => 'simulate' in c && 'validate' in c && 'defaultSafety' in c && 'execution' in c), 'ACTION_CAPABILITIES: 全 actionType に simulate / validate / defaultSafety / execution');
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
  const uniq = review(plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', '担当者設定通知', [['通知先', 'owner'], ['条件', 'owner != ""']])]));
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
  const rem2 = review(plan([step('P1', 'ADD_REMINDER', 'REMINDER', '期限30日前', [['基準日', '期限'], ['日数', '-30'], ['通知先', '担当者']])]));
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
  const over = review(plan([step('P1', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', [['取得項目', 'other_name → case_name']])]));
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
  const twoNotif = review(plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', '担当者通知', [['通知先', 'owner'], ['条件', 'owner != ""']]), step('P4', 'ADD_NOTIFICATION', 'NOTIFICATION', '担当者設定通知', [['通知先', 'owner'], ['条件', 'owner != ""']])]));
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

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
