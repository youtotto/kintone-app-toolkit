// KTPlanExecutor（Phase 9: Preview Executor MVP）
//
// 検証内容（§32〜34）: ADD_FIELD / duplicate field / stale revision / not approved / review invalid / unsupported action /
//   dependency order / failed dependency / double execute / partial failure / verification success・failure（反映した後の判定は手順ごとの読み戻しだけ。2026-10-21）/
//   snapshot / ADD_VIEW（add・duplicate・existing views preserved・field missing・proposed field resolved・stale config）/
//   layout（existing layout preserved・added field・no accidental removal）/ permission / revision mismatch / production deploy 無し
//
// kintone API はモック（動作テスト環境の状態を Map で持つ）。実行経路: plan → KTPlanReview → 承認 → executorOutput → prepare → executePreview
// 実行方法: node tests/ai-plan-executor.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { KTDeps, KTPlanReview, KTPlanExecutor } = loadToolkit();
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const E = KTPlanExecutor, R = KTPlanReview;

const clone = (v) => JSON.parse(JSON.stringify(v));
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], ...o });
const step = (id, actionType, targetKind, targetRef, sp = {}, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' }, ...extra });
const pf = (temporaryId, label, suggestedCode, type, extra = {}) => ({ temporaryId, label, suggestedCode, type, typeValid: true, required: false, options: [], reason: '', evidenceIds: [], alternativeExistingFieldCode: null, codeConflict: false, labelDuplicate: false, ...extra });
const plan = (steps, proposedFields = [], extra = {}) => ({ planVersion: '1', requestId: 'tk-exec', goal: 'g', assessment: { summary: '' }, relevantFields: [], proposedFields, steps, alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', ...extra });

const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');

const DATA = FX.makeData();
const DEPS = KTDeps.buildDependencyData(DATA, KTDeps.normalizeFields(DATA.fields));
const reviewOf = (p) => R.review({ plan: p, data: DATA, deps: DEPS, scan: null, incoming: null });
const PROGRESS = { options: ['未着手', '進行中', '完了'] };
const planField = () => plan([step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'DROP_DOWN', options: PROGRESS.options })], [pf('NEW_FIELD_1', '更新状況', 'progress', 'DROP_DOWN', { options: PROGRESS.options })]);
const planFieldView = () => plan([
  step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'DROP_DOWN', options: PROGRESS.options }),
  step('P2', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_2', { fieldType: 'DATE' }),
  step('P3', 'ADD_VIEW', 'VIEW', '担当者別', { name: '担当者別', fields: ['owner', 'case_name', 'NEW_FIELD_1', 'NEW_FIELD_2'], filterCond: 'owner in (LOGINUSER())', sort: 'due_date asc' }, { dependsOn: ['P1', 'P2'] }),
], [pf('NEW_FIELD_1', '更新状況', 'progress', 'DROP_DOWN', { options: PROGRESS.options }), pf('NEW_FIELD_2', '確認日', 'checked_on', 'DATE')]);
const approveAll = (p, rv) => R.executorOutput(p, rv, p.steps.map(s => s.id));
const run = async (input, mock, { review = null, onProgress = null } = {}) => { const prepared = await E.prepare(input, { api: mock.api, current: await mock.current(), appId: '341' }); const log = prepared.status === 'PREPARED' ? await E.executePreview(prepared, { api: mock.api, review, onProgress }) : null; return { prepared, log }; };

(async () => {
console.log('\n--- 1. ADD_FIELD: 承認 → prepare → preview へ反映 → 再取得で検証 ---');
{
  const p = planField(); const rv = reviewOf(p); const mock = makeKintoneMock(DATA, { autoPlace: false });   // 自動配置しない場合（Executor が末尾行を足す）
  const input = approveAll(p, rv);
  assert(input.approvedSteps.join() === 'P1' && st0(rv).safety === 'SAFE', '前提: Review は SAFE・承認済み');
  const prepared = await E.prepare(input, { api: mock.api, current: await mock.current(), appId: '341' });
  assert(prepared.status === 'PREPARED' && prepared.summary.executable === 1 && prepared.blockers.length === 0 && prepared.stale.status === 'FRESH', `prepare: PREPARED（executable 1・stale FRESH）: ${JSON.stringify(prepared.blockers)}`);
  assert(prepared.executionId.startsWith('ex_') && prepared.env === 'preview' && prepared.appId === '341' && prepared.revision.preview === '12' && prepared.revision.production === '12' && prepared.revision.reviewed === '12', 'executionId / env preview / revision（preview・production・計画を確かめた時点）');
  assert(prepared.snapshot && prepared.snapshot.revision === '12' && Object.keys(prepared.snapshot.fields.properties).length === Object.keys(DATA.fields).length && Array.isArray(prepared.snapshot.layout.layout) && prepared.snapshot.views.views['顧客別一覧'], 'snapshot: 実行前の fields / layout / views / revision');
  assert(prepared.temporaryIdMap.NEW_FIELD_1 === 'progress' && prepared.steps[0].prepared.payload.properties.progress.type === 'DROP_DOWN' && prepared.steps[0].prepared.payload.properties.progress.options['進行中'].index === '1', 'temporaryId → 実コード（progress）・API payload（options に index）');
  assert(mock.calls.filter(c => c.startsWith('POST') || c.startsWith('PUT')).length === 0, 'prepare は書き込まない');
  const events = [];
  const log = await E.executePreview(prepared, { api: mock.api, review: rv, onProgress: (s) => events.push(`${s.stepId}:${s.status}`) });
  assert(log.status === 'DONE' && log.steps[0].status === 'VERIFIED' && log.beforeRevision === '12' && log.afterRevision === '14', `実行: DONE・P1 VERIFIED・revision 12 → 14（POST fields ＋ PUT layout）: ${log.status} ${log.steps[0].status} ${log.afterRevision}`);
  assert(events.join(',') === 'P1:RUNNING,P1:APPLIED,P1:VERIFIED', `進捗: RUNNING → APPLIED → VERIFIED（${events.join(',')}）`);
  assert(mock.st.fields.progress && mock.st.fields.progress.type === 'DROP_DOWN' && mock.st.fields.progress.label === '更新状況' && Object.keys(mock.st.fields.progress.options).length === 3, 'モックの動作テスト環境にフィールドが追加された');
  const v = log.steps[0].verification;
  assert(v.ok && v.checks.find(c => c.name === 'options').ok && v.checks.find(c => c.name === 'existingFieldsPreserved').ok && v.checks.find(c => c.name === 'layoutContainsField').ok && v.checks.find(c => c.name === 'existingLayoutPreserved').ok, 'verification: exists / type / label / required / options / 既存フィールド・レイアウト保持');
  assert(log.steps[0].requests.map(r => r.method + ' ' + r.path).join(' | ') === 'POST /k/v1/preview/app/form/fields.json | PUT /k/v1/preview/app/form/layout.json' && log.steps[0].requests[1].placement === 'APPENDED_ROW', 'レイアウト: 末尾の行として追加（既存の行は変えない）');
  assert(mock.st.layout.length === prepared.snapshot.layout.layout.length + 1 && mock.st.layout[mock.st.layout.length - 1].fields[0].code === 'progress' && JSON.stringify(mock.st.layout.slice(0, -1)) === JSON.stringify(prepared.snapshot.layout.layout), 'レイアウト: 既存の行は完全に保持され、新しい行が 1 つ増える');
  //   2026-10-21: 反映した後の取得は、元に戻すときの基準（actualAfterRaw）と要約（actualAfter）に使う。書いた内容が期待どおりかは手順ごとの読み戻し（上の verification）だけが判定し、
  //   計画の検査の After との照合（Simulation）・依存関係の再解析は持たない（反映した後の依存関係は、画面が反映の直後に取り直す作業の基準が持つ）
  assert(!('simulation' in log) && !('reanalysis' in log) && log.actualAfterRaw && log.actualAfterRaw.fields.properties.progress && log.actualAfterRaw.layout.layout.length === mock.st.layout.length, '反映した後の判定は手順ごとの読み戻しだけ（照合・再解析の記録は無い）・元に戻すときの基準は反映直後の設定');
  assert(log.actualAfter.addedFields.join() === 'progress' && log.finishedAt && !/cookie|Bearer|refreshToken/i.test(JSON.stringify(log)), 'actualAfter の要約・秘密情報なし');
  const rb = E.buildRollbackPlan(log, prepared);
  assert(rb.executed === false && rb.steps.length === 1 && rb.steps[0].actionType === 'DELETE_FIELD' && rb.steps[0].api.payload.fields.join() === 'progress' && rb.snapshotRevision === '12', 'ロールバック計画: DELETE_FIELD（実行しない）＋ snapshot');
  const audit = E.buildAudit({ goal: '更新状況を管理したい', plan: p, review: rv, prepared, execution: log });
  const auditChecks = { v: audit.auditVersion === '2', goal: audit.goal === '更新状況を管理したい', plan: audit.plan.steps.length === 1, review: audit.review.steps.length === 1, noDec: !('humanDecisions' in audit), exec: audit.execution.executionId === prepared.executionId, ver: audit.verification[0].status === 'VERIFIED', snap: audit.beforeSnapshot.revision === '12', after: audit.actualAfter.addedFields.join() === 'progress', rb: audit.rollbackPlan.steps.length === 1, noAfter: !audit.review.simulation.after };
  if (!Object.values(auditChecks).every(Boolean)) console.log('audit checks', auditChecks);
  assert(Object.values(auditChecks).every(Boolean), 'Audit JSON: goal / plan / review / execution / verification / before snapshot / actual after / rollback（After モデルは含めない。手順を外す判断の欄は無い: 2026-10-19 廃止）');
  // 二重実行
  let err = null; try { await E.executePreview(prepared, { api: mock.api }); } catch (e) { err = e; }
  assert(err && err.code === 'ALREADY_EXECUTED' && Object.keys(mock.st.fields).filter(c => c === 'progress').length === 1 && mock.calls.filter(c => c.startsWith('POST')).length === 1, '同じ prepare の二重実行は拒否（POST は 1 回だけ）');
  // 再度 prepare すると、追加済みのフィールドが「Review 時点との差異」になる（stale）
  const again = await E.prepare(input, { api: mock.api, current: await mock.current(), appId: '341' });
  assert(again.status === 'BLOCKED' && again.blockers.some(b => b.code === 'STALE_PLAN') && again.stale.diffs.some(d => d.kind === 'FIELD' && d.id === 'progress' && d.change === 'ADDED'), '再クリック相当（新しい prepare）は STALE_PLAN で止まり、同じ ADD_FIELD が 2 つ作られない');
}

console.log('\n--- 2. 承認・Review・allowlist による拒否 ---');
{
  const p = planField(); const rv = reviewOf(p); const mock = makeKintoneMock(DATA);
  const none = await E.prepare(R.executorOutput(p, rv, []), { api: mock.api, current: await mock.current(), appId: '341' });
  assert(none.status === 'BLOCKED' && none.blockers[0].code === 'NOTHING_TO_EXECUTE' && none.steps[0].status === 'SKIPPED' && none.steps[0].reason === 'NOT_APPROVED' && mock.calls.length === 0, 'not approved → SKIPPED・何も呼ばない');
  const dup = plan([step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'NUMBER' })], [pf('NEW_FIELD_1', '金額2', 'amount', 'NUMBER')]);
  const dupRv = reviewOf(dup);
  const dupOut = R.executorOutput(dup, dupRv, ['P1']);
  const dupPrep = await E.prepare({ ...dupOut, approvedSteps: ['P1'] }, { api: mock.api, current: await mock.current(), appId: '341' });
  assert(st0(dupRv).status === 'INVALID' && dupOut.approvedSteps.length === 0 && dupPrep.steps[0].status === 'BLOCKED' && dupPrep.steps[0].reason === 'REVIEW_BLOCKED', 'duplicate field（Review INVALID）→ executorOutput は承認を落とし、無理に渡しても REVIEW_BLOCKED');
  const unsup = plan([
    step('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認', { name: '部長承認', assignees: ['FIELD_ENTITY:approver'] }),
    step('P2', 'CUSTOMIZATION_REQUIRED', 'JS', '', {}),
    step('P3', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'CALC' }),
    step('P4', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_2', { fieldType: 'DROP_DOWN' }),
    step('P5', 'UPDATE_RECORD_ACL', 'RECORD_ACL', 'record#1', { entities: ['USER:user1'], accessibility: 'READ' }),
  ], [pf('NEW_FIELD_1', '合計2', 'total2', 'CALC'), pf('NEW_FIELD_2', '区分', 'kubun', 'DROP_DOWN')]);
  const unsupRv = reviewOf(unsup);
  const unsupPrep = await E.prepare(R.executorOutput(unsup, unsupRv, ['P1', 'P2', 'P3', 'P4', 'P5']), { api: mock.api, current: await mock.current(), appId: '341' });
  const reasons = Object.fromEntries(unsupPrep.steps.map(s => [s.stepId, `${s.status}:${s.reason}`]));
  assert(reasons.P1 === 'BLOCKED:STATUS_UNREACHABLE' && reasons.P2 === 'UNSUPPORTED:PLAN_ONLY' && reasons.P3 === 'UNSUPPORTED:FIELD_TYPE_NOT_SUPPORTED' && /UNSUPPORTED|BLOCKED/.test(reasons.P5), `unsupported: 孤立ステータス（STATUS_UNREACHABLE）/ JS / CALC 型 / ACL は無視せず理由を出す: ${JSON.stringify(reasons)}`);
  assert(reasons.P4 === 'UNSUPPORTED:OPTIONS_MISSING' || reasons.P4 === 'BLOCKED:REVIEW_BLOCKED' || /UNSUPPORTED|BLOCKED/.test(reasons.P4), `選択肢の無い DROP_DOWN は実行しない（${reasons.P4}）`);
  assert(unsupPrep.status === 'BLOCKED' && unsupPrep.blockers[0].code === 'NOTHING_TO_EXECUTE' && unsupPrep.summary.unsupported + unsupPrep.summary.blocked >= 4, '実行できる step が無ければ BLOCKED（NOTHING_TO_EXECUTE）');
  assert(Object.values(E.ACTION_CAPABILITIES).every(c => c.productionDeploy === false) && Object.entries(E.ACTION_CAPABILITIES).filter(([, c]) => c.previewExecute).map(([k]) => k).sort().join() === 'ADD_APP_ACTION,ADD_FIELD,ADD_NOTIFICATION,ADD_PROCESS_ACTION,ADD_PROCESS_STATUS,ADD_REMINDER,ADD_VIEW,UPDATE_APP_ACTION,UPDATE_FIELD,UPDATE_LOOKUP,UPDATE_NOTIFICATION,UPDATE_PROCESS,UPDATE_REMINDER,UPDATE_VIEW' && E.ACTION_CAPABILITIES.UPDATE_LOOKUP.rollbackStrategy === 'RESTORE_LOOKUP_SETTINGS' && E.ACTION_CAPABILITIES.ADD_APP_ACTION.rollbackStrategy === 'RESTORE_APP_ACTION_SETTINGS' && E.ACTION_CAPABILITIES.UPDATE_APP_ACTION.rollbackStrategy === 'RESTORE_APP_ACTION_SETTINGS' && E.ACTION_CAPABILITIES.UPDATE_PROCESS.rollbackStrategy === 'RESTORE_PROCESS_SETTINGS' && E.ACTION_CAPABILITIES.UPDATE_NOTIFICATION.rollbackStrategy === 'RESTORE_NOTIFICATION_SETTINGS' && E.ACTION_CAPABILITIES.UPDATE_REMINDER.rollbackStrategy === 'RESTORE_REMINDER_SETTINGS' && E.ACTION_CAPABILITIES.UPDATE_VIEW.rollbackStrategy === 'RESTORE_VIEWS' && E.ACTION_CAPABILITIES.ADD_FIELD.rollbackStrategy === 'DELETE_FIELD' && E.ACTION_CAPABILITIES.ADD_NOTIFICATION.rollbackStrategy === 'RESTORE_NOTIFICATION_SETTINGS' && E.ACTION_CAPABILITIES.ADD_REMINDER.rollbackStrategy === 'RESTORE_REMINDER_SETTINGS' && E.ACTION_CAPABILITIES.UPDATE_FIELD.rollbackStrategy === 'RESTORE_FIELD_PROPERTY' && E.ACTION_CAPABILITIES.UPDATE_RECORD_ACL.previewExecute === false && E.ACTION_CAPABILITIES.ADD_LOOKUP.previewExecute === false, 'Action Capability Registry（Tier 2 / Phase 11〜14）: previewExecute は ADD / UPDATE 系 ＋ プロセス管理 3 種 ＋ UPDATE_LOOKUP ＋ アプリアクション 2 種・productionDeploy は全て false・ACL / 新規 Lookup は不可');
  const api = E.createKintoneApi({ kintoneApi: { api: Object.assign(() => Promise.resolve({}), { url: (p) => p }) } });
  assert(!('deploy' in api) && !Object.keys(api).some(k => /deploy/i.test(k)) && Object.keys(api).every(k => /Preview/.test(k) || /^get(ProductionViews|App|AppFields)$/.test(k) || /^(uploadFile|downloadFile)$/.test(k)), 'kintone API adapter に運用環境へ反映する関数は無い（運用環境は GET のみ: 一覧の revision・参照元アプリの定義。書き込みは preview のみ。Phase 17 の uploadFile は一時ファイルの作成・downloadFile は読み取り）');
}

console.log('\n--- 3. stale（Review 後の変更）・revision・権限 ---');
{
  const p = planField(); const rv = reviewOf(p);
  const m1 = makeKintoneMock(DATA); m1.st.prodRevision = 13; m1.st.revision = 13;
  const s1 = await E.prepare(approveAll(p, rv), { api: m1.api, current: await m1.current(), appId: '341' });
  assert(s1.status === 'BLOCKED' && s1.blockers.some(b => b.code === 'STALE_PLAN' && /同じ依頼をもう一度送って/.test(b.message)) && s1.stale.diffs[0].kind === 'APP' && /12 → 13/.test(s1.stale.diffs[0].message), '運用環境の revision が変わった → STALE_PLAN「計画作成後にアプリ設定が変更されています。設定を取り直して、同じ依頼をもう一度送ってください。」');
  const m2 = makeKintoneMock(DATA); m2.st.fields.extra_memo = { type: 'SINGLE_LINE_TEXT', code: 'extra_memo', label: '人間が足したメモ' }; m2.st.layout.push({ type: 'ROW', fields: [{ type: 'SINGLE_LINE_TEXT', code: 'extra_memo' }] });
  const s2 = await E.prepare(approveAll(p, rv), { api: m2.api, current: await m2.current(), appId: '341' });
  assert(s2.status === 'BLOCKED' && s2.stale.diffs.some(d => d.kind === 'FIELD' && d.id === 'extra_memo' && d.change === 'ADDED') && m2.calls.every(c => c.startsWith('GET')), '動作テスト環境に未反映の変更（人間がフィールド追加）→ STALE_PLAN・書き込みなし');
  const m3 = makeKintoneMock(DATA); m3.st.fields.amount.label = '金額（税込）';
  const s3 = await E.prepare(approveAll(p, rv), { api: m3.api, current: await m3.current(), appId: '341' });
  assert(s3.status === 'BLOCKED' && s3.stale.diffs.some(d => d.id === 'amount' && d.change === 'CHANGED'), '既存フィールドの設定変更 → STALE_PLAN（当て直さない）');
  const m4 = makeKintoneMock(DATA); delete m4.st.views['承認待ち'];
  const s4 = await E.prepare(approveAll(p, rv), { api: m4.api, current: await m4.current(), appId: '341' });
  assert(s4.status === 'BLOCKED' && s4.stale.diffs.some(d => d.kind === 'VIEW' && d.id === '承認待ち' && d.change === 'REMOVED'), '一覧の削除 → STALE_PLAN');
  const m35 = makeKintoneMock(DATA); delete m35.st.fields['カテゴリー']; m35.st.fields['作成者'].label = 'Created by';
  const s35 = await E.prepare(approveAll(p, rv), { api: m35.api, current: await m35.current(), appId: '341' });
  assert(s35.status === 'PREPARED' && s35.stale.status === 'FRESH', 'システムフィールド（カテゴリー・作成者 など）の有無・表記の揺れは stale にしない');
  //   2026-10-23: 準備は設定を自分で取らない。権限が無いことは作業の基準の取得（画面）で分かり、準備には届かない（今の設定を作る段で CB_NO02）・書き込みも無い
  const m5 = makeKintoneMock(DATA, { permission: false });
  let e5 = null; try { await m5.current(); } catch (e) { e5 = e; }
  assert(e5 && e5.code === 'CB_NO02' && m5.calls.length === 0, 'アプリ管理権限が無い → 今の設定（作業の基準）を取れずに止まる（kintone の認可結果が正本。準備に届かない・書き込みなし）');
  // revision mismatch: prepare と execute の間に他の変更
  const m6 = makeKintoneMock(DATA);
  const prep6 = await E.prepare(approveAll(p, rv), { api: m6.api, current: await m6.current(), appId: '341' });
  m6.st.revision = 20;
  const log6 = await E.executePreview(prep6, { api: m6.api, review: rv });
  assert(log6.status === 'FAILED' && log6.steps[0].status === 'FAILED' && log6.steps[0].reason === 'REVISION_MISMATCH' && !m6.st.fields.progress, '実行直前に revision が変わった → API が拒否 → FAILED（REVISION_MISMATCH）・何も反映されない');
  // 実行直前の重複（prepare 後に同じコードが作られた）
  const m7 = makeKintoneMock(DATA);
  const prep7 = await E.prepare(approveAll(p, rv), { api: m7.api, current: await m7.current(), appId: '341' });
  m7.st.fields.progress = { type: 'SINGLE_LINE_TEXT', code: 'progress', label: '別の進捗' }; m7.st.layout.push({ type: 'ROW', fields: [{ type: 'SINGLE_LINE_TEXT', code: 'progress' }] });
  const log7 = await E.executePreview(prep7, { api: m7.api, review: rv });
  assert(log7.status === 'FAILED' && log7.steps[0].status === 'FAILED' && m7.st.fields.progress.label === '別の進捗', 'prepare 後に同じコードが作られた → API の重複エラーで FAILED（上書きしない）');
}

console.log('\n--- 4. 実行順（DAG）・部分失敗・Fail Stop・検証失敗・Simulation mismatch ---');
{
  const p = planFieldView(); const rv = reviewOf(p); const mock = makeKintoneMock(DATA);
  assert(rv.steps.every(r => r.safety === 'SAFE') && rv.steps[2].diff.after.fields.join() === 'owner,case_name,progress,checked_on', '前提: 3 step とも SAFE・一覧の NEW_FIELD は実コードに解決');
  const { prepared, log } = await run(approveAll(p, rv), mock, { review: rv });
  assert(prepared.status === 'PREPARED' && prepared.summary.executable === 3, 'prepare: 3 step 実行可能');
  assert(log.status === 'DONE' && log.steps.map(s => `${s.stepId}:${s.status}`).join() === 'P1:VERIFIED,P2:VERIFIED,P3:VERIFIED', `dependsOn 順に実行して全て VERIFIED（${log.steps.map(s => s.stepId + ':' + s.status).join()}）`);
  const order = mock.calls.filter(c => /^(POST|PUT views)/.test(c));
  assert(order.join(' | ') === 'POST fields | POST fields | PUT views', `API 呼び出し順: P1 → P2 → P3（${order.join(' | ')}）`);
  assert(mock.st.views['担当者別'] && mock.st.views['担当者別'].fields.join() === 'owner,case_name,progress,checked_on' && mock.st.views['担当者別'].index === '2' && Object.keys(mock.st.views).length === 3, '一覧: 既存 2 件を保持して 3 件目として追加（index は最大 + 1）');
  assert(log.actualAfter.addedViews.join() === '担当者別', 'actualAfter の要約（追加した一覧）');
  // 部分失敗（P2 が失敗 → P3 は未実行。P1 は戻さない）
  const m2 = makeKintoneMock(DATA); m2.ctl.failAddField = 'checked_on';
  const r2 = await run(approveAll(p, rv), m2, { review: rv });
  assert(r2.log.status === 'PARTIAL' && r2.log.steps.map(s => s.status).join() === 'VERIFIED,FAILED,SKIPPED' && r2.log.steps[2].reason === 'STOPPED_AFTER_FAILURE' && m2.st.fields.progress && !m2.st.fields.checked_on && !m2.st.views['担当者別'], '部分失敗: 1 件反映済み・1 件失敗・以降未実行（反映済みは戻さない）→ PARTIAL');
  assert(r2.log.steps[1].error && r2.log.steps[1].error.code === 'GAIA_IL04' && r2.log.steps[1].reason === 'API_ERROR', '失敗した step の API エラー（code / message）を記録');
  const rb2 = E.buildRollbackPlan(r2.log, r2.prepared);
  assert(rb2.steps.length === 1 && rb2.steps[0].stepId === 'P1' && rb2.steps[0].actionType === 'DELETE_FIELD', 'ロールバック計画は反映済み step だけ（逆順）');
  // 独立 step も停止優先（P1 失敗 → P2, P3 を実行しない）
  const m3 = makeKintoneMock(DATA); m3.ctl.failAddField = 'progress';
  const r3 = await run(approveAll(p, rv), m3, { review: rv });
  assert(r3.log.status === 'FAILED' && r3.log.steps.map(s => s.status).join() === 'FAILED,SKIPPED,SKIPPED' && Object.keys(m3.st.fields).length === Object.keys(DATA.fields).length, 'Fail Stop: 最初の失敗で独立 step も止める（安全側）');
  // 依存先が未承認なら後続は BLOCKED
  const m4 = makeKintoneMock(DATA);
  const prep4 = await E.prepare(R.executorOutput(p, rv, ['P2', 'P3']), { api: m4.api, current: await m4.current(), appId: '341' });
  assert(prep4.steps.map(s => `${s.stepId}:${s.status}`).join() === 'P1:SKIPPED,P2:PENDING,P3:BLOCKED' && prep4.steps[2].reason === 'DEPENDENCY_NOT_EXECUTABLE', '依存する P1 が未承認 → P3 は BLOCKED（P2 だけ実行対象）');
  // 検証失敗（API は 200 だが状態が一致しない）
  const m5 = makeKintoneMock(DATA); m5.ctl.mangleLabel = true;
  const r5 = await run(approveAll(p, rv), m5, { review: rv });
  assert(r5.log.steps[0].status === 'VERIFY_FAILED' && r5.log.steps[0].verification.checks.find(c => c.name === 'label').ok === false && r5.log.steps[1].status === 'SKIPPED' && r5.log.status === 'FAILED', 'API 成功・状態不一致 → VERIFY_FAILED・以降停止');
  //   2026-10-21: 反映した後の照合（Review の After と実際の After の比較・SIMULATION_MISMATCH）は廃止した。kintone の補正は手順ごとの読み戻しが VERIFY_FAILED にする（上の r5）。
  //   計画と違う内容を書かないことは反映の前の準備が持つ（取り直した設定に対する計画の検査の After と、計画を作ったときの After が違えば REVALIDATION_FAILED。tier2 の 1-6）。
  //   計画の検査の After を書き換えて渡しても、反映の判定（状態・読み戻し）は変わらない（判定に使わない）
  const rvBad = clone(rv); rvBad.simulation.after.fields.progress.label = '進捗（別名）';
  const r6 = await run(approveAll(p, rv), makeKintoneMock(DATA), { review: rvBad });
  assert(r6.log.status === 'DONE' && r6.log.steps.every(s => s.status === 'VERIFIED') && !('simulation' in r6.log) && !('simulation' in r5.log), '計画の検査の After は反映の判定に使わない（書いた内容の判定は手順ごとの読み戻しだけ。照合の記録は無い）');
}

console.log('\n--- 5. ADD_VIEW / layout ---');
{
  const pv = plan([step('P1', 'ADD_VIEW', 'VIEW', '担当者別', { name: '担当者別', fields: ['owner', 'case_name', 'amount'], filterCond: 'owner in (LOGINUSER())', sort: 'due_date asc' })]);
  const rv = reviewOf(pv); const mock = makeKintoneMock(DATA);
  const { prepared, log } = await run(approveAll(pv, rv), mock, { review: rv });
  assert(log.status === 'DONE' && log.steps[0].status === 'VERIFIED' && log.steps[0].requests[0].existingViews === 2 && log.steps[0].requests[0].totalViews === 3, 'ADD_VIEW: current + new = complete payload');
  assert(mock.st.views['顧客別一覧'] && mock.st.views['承認待ち'] && mock.st.views['担当者別'].filterCond === 'owner in (LOGINUSER())' && mock.st.views['担当者別'].sort === 'due_date asc' && mock.st.views['担当者別'].type === 'LIST', '既存の一覧を失わない・絞り込み / 並び順 / 形式');
  const v = log.steps[0].verification;
  assert(v.ok && ['exists', 'type', 'fields', 'filterCond', 'sort', 'existingViewsPreserved'].every(n => v.checks.find(c => c.name === n)?.ok), 'verification: exists / fields / filter / sort / 既存保持');
  const rb = E.buildRollbackPlan(log, prepared);
  assert(rb.steps[0].actionType === 'RESTORE_VIEWS' && /2 件/.test(rb.steps[0].note), 'ロールバック計画: snapshot の一覧設定を戻す');
  //   2026-10-21: 一覧の追加の読み戻しは、ほかの一覧の中身まで見る（書き込みの直前に取得した一覧と同じ）。同じ実行の後の手順の全体置換が前の手順の一覧を変えたら、
  //   後の手順が VERIFY_FAILED（前は反映した後の照合が、注意の表示だけで見ていた）
  const pv2 = plan([step('P1', 'ADD_VIEW', 'VIEW', '担当者別', { name: '担当者別', fields: ['owner', 'case_name', 'amount'], filterCond: 'owner in (LOGINUSER())', sort: 'due_date asc' }),
    step('P2', 'ADD_VIEW', 'VIEW', '期限順', { name: '期限順', fields: ['case_name', 'due_date'], sort: 'due_date asc' })]);
  const rv2 = reviewOf(pv2); const m7 = makeKintoneMock(DATA); let viewPuts = 0;
  m7.ctl.mutateList = (what, list) => { if (what === 'views' && ++viewPuts === 2 && list['担当者別']) list['担当者別'].filterCond = ''; return list; };
  const r7 = await run(approveAll(pv2, rv2), m7, { review: rv2 });
  const pres7 = r7.log.steps[1].verification && r7.log.steps[1].verification.checks.find(c => c.name === 'existingViewsPreserved');
  assert(r7.log.steps[0].status === 'VERIFIED' && r7.log.steps[1].status === 'VERIFY_FAILED' && pres7 && pres7.ok === false && JSON.stringify(pres7.actual) === JSON.stringify(['担当者別']) && r7.log.status === 'PARTIAL',
    `一覧の追加の読み戻し: 後の手順の全体置換が前の手順の一覧を変えたら VERIFY_FAILED（ほかの一覧の中身まで見る）: ${JSON.stringify({ steps: r7.log.steps.map(s => s.status), pres: pres7 })}`);
  // duplicate: Review が INVALID
  const dupV = plan([step('P1', 'ADD_VIEW', 'VIEW', '承認待ち', { name: '承認待ち', fields: ['case_name'] })]);
  const dupRv = reviewOf(dupV);
  assert(st0(dupRv).status === 'INVALID' && R.executorOutput(dupV, dupRv, ['P1']).approvedSteps.length === 0, '同名の一覧（Review INVALID）は実行対象にならない');
  // 実行直前に同名の一覧が作られた
  const m2 = makeKintoneMock(DATA);
  const prep2 = await E.prepare(approveAll(pv, rv), { api: m2.api, current: await m2.current(), appId: '341' });
  m2.st.views['担当者別'] = { id: '555', name: '担当者別', type: 'LIST', index: '2', fields: ['case_name'], filterCond: '', sort: '' };
  const log2 = await E.executePreview(prep2, { api: m2.api, review: rv });
  assert(log2.steps[0].status === 'FAILED' && log2.steps[0].reason === 'TARGET_EXISTS' && m2.st.views['担当者別'].fields.join() === 'case_name', '実行直前の重複 → TARGET_EXISTS（既存を上書きしない）');
  // field missing: Review が INVALID
  const missV = plan([step('P1', 'ADD_VIEW', 'VIEW', 'x', { name: 'x', fields: ['ghost_field'] })]);
  const missRv = reviewOf(missV);
  assert(st0(missRv).status === 'INVALID' && st0(missRv).issues.some(i => i.code === 'UNKNOWN_FIELD'), '存在しないフィールドの一覧は Review で INVALID');
  // stale config（一覧の設定が変わった）
  const m3 = makeKintoneMock(DATA); m3.st.views['承認待ち'].fields = ['case_name'];
  const prep3 = await E.prepare(approveAll(pv, rv), { api: m3.api, current: await m3.current(), appId: '341' });
  assert(prep3.status === 'BLOCKED' && prep3.stale.diffs.some(d => d.kind === 'VIEW' && d.id === '承認待ち' && d.change === 'CHANGED'), '一覧設定が 計画を確かめた後に変わった → STALE_PLAN');
  // layout: kintone が自動配置した場合は PUT しない
  const pf1 = planField(); const rvf = reviewOf(pf1); const m4 = makeKintoneMock(DATA, { autoPlace: true });
  const r4 = await run(approveAll(pf1, rvf), m4, { review: rvf });
  assert(r4.log.steps[0].status === 'VERIFIED' && r4.log.steps[0].requests.length === 2 && r4.log.steps[0].requests[1].placement === 'AUTO' && m4.calls.filter(c => c === 'PUT layout').length === 0 && m4.st.layout.length === r4.prepared.snapshot.layout.layout.length + 1, 'kintone が自動配置していればレイアウトを PUT しない（placement AUTO）・既存の行は保持');
  const r5 = await run(approveAll(pf1, rvf), makeKintoneMock(DATA), { review: rvf });
  assert(r5.log.steps[0].verification.checks.find(c => c.name === 'existingLayoutPreserved').ok && r5.log.steps[0].verification.checks.find(c => c.name === 'layoutContainsField').ok, 'レイアウト検証: 既存の行を保持・追加フィールドが含まれる（no accidental removal）');
}

console.log('\n--- 5b. staging E2E（app 344）で見つかった癖 ---');
{
  // AI が「owner = LOGIN_USER()」と書き、Review は COND_UNKNOWN_FUNCTION（要確認）。承認しても kintone が GAIA_IL08 で拒否するので、Executor は最初から実行しない
  const pv = plan([step('P1', 'ADD_VIEW', 'VIEW', '担当者別', { name: '担当者別', fields: ['case_name', 'amount'], filterCond: 'owner = LOGIN_USER()' })]);
  const rv = reviewOf(pv); const mock = makeKintoneMock(DATA);
  assert(st0(rv).status === 'NEEDS_CONFIRMATION' && codes0(rv).includes('COND_UNKNOWN_FUNCTION'), '前提: Review は要確認（COND_UNKNOWN_FUNCTION）');
  const prep = await E.prepare(R.executorOutput(pv, rv, ['P1']), { api: mock.api, current: await mock.current(), appId: '341' });
  assert(prep.steps[0].status === 'BLOCKED' && prep.steps[0].reason === 'INVALID_CONDITION' && prep.status === 'BLOCKED' && mock.calls.length === 0, '条件式が kintone で評価できない step は承認されても BLOCKED（INVALID_CONDITION）・API を呼ばない');
  // 反映した step が無いときは「一致」と言わない（反映後の確認は手順ごとの読み戻しの件数だけ。2026-10-21）
  const p2 = planField(); const rv2 = reviewOf(p2); const m2 = makeKintoneMock(DATA); m2.ctl.failAddField = 'progress';
  const r2 = await run(approveAll(p2, rv2), m2, { review: rv2 });
  assert(r2.log.status === 'FAILED' && r2.log.steps[0].status === 'FAILED' && !r2.log.steps.some(s => s.status === 'VERIFIED') && !('simulation' in r2.log), '全 step 失敗 → FAILED（読み戻しで一致した手順は 0 件・照合の記録は無い）');
}

console.log('\n--- 6. 入力の検証・DATA 不変 ---');
{
  const mock = makeKintoneMock(DATA);
  const bad = await E.prepare({ plan: null, review: null, approvedSteps: [] }, { api: mock.api, current: await mock.current(), appId: '341' });
  assert(bad.status === 'BLOCKED' && bad.blockers[0].code === 'INVALID_INPUT', 'plan / review が無ければ INVALID_INPUT');
  const p = planField(); const rv = reviewOf(p);
  const out = R.executorOutput(p, rv, ['P1']);
  assert(out.review.simulation.before && out.review.simulation.before.revision === '12' && !out.review.simulation.after && Array.isArray(out.review.simulation.order), 'executorOutput は Before（設定の版 含む）と order を残し After は落とす');
  const noBefore = clone(out); delete noBefore.review.simulation.before;
  const nb = await E.prepare(noBefore, { api: mock.api, current: await mock.current(), appId: '341' });
  assert(nb.status === 'BLOCKED' && nb.blockers[0].code === 'NO_BEFORE_MODEL', 'Before モデルの無い古い Review は実行しない');
  let err = null; try { await E.executePreview(nb, { api: mock.api }); } catch (e) { err = e; }
  assert(err && err.code === 'NOT_PREPARED', 'BLOCKED な prepare は実行できない');
  assert(JSON.stringify(DATA) === JSON.stringify(FX.makeData()), 'DATA（運用環境の解析結果）は変更されない');
}

function st0(rv) { return rv.steps[0]; }
function codes0(rv) { return rv.steps[0].issues.map(i => i.code); }
console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
