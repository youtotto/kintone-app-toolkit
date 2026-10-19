// 反映の画面（KTContextUi.executorHtml: 最終案の反映の前 / 反映中 / 結果 / 失敗 / 止まった理由 / 元に戻す / 監査 JSON）
//
// 検証内容（§35）: preview button / confirmation / progress / success / failure / unsupported / verified / simulation mismatch /
//   production deploy button absent / stale / 権限
//
// 実行方法: node tests/ai-plan-executor-ui.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { KTDeps, KTScan, KTContext, KTAiClient, KTContextUi, KTPlanReview, KTPlanExecutor } = loadToolkit();
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const { buildScanPayload } = require('./helpers/scan-payload.js');

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
const GOAL = '更新状況を管理したい';
const PCTX = KTContext.buildPlan({ goal: GOAL, ...INPUTS, options: { now: '2026-10-02T00:00:00.000Z' } });
const E = (code) => PCTX.facts.find(f => f.kind === 'field' && f.field?.code === code).id;
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], ...o });
const mkStep = (id, actionType, targetKind, targetRef, sp, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' }, ...extra });
const OPTIONS = ['未着手', '進行中', '完了'];
const PLAN_X = {
  ok: true, contractVersion: '2.1',
  meta: { requestId: 'pl-x', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm' }, usage: { usedThisMonth: 1, monthlyLimit: 20 } },
  plan: {
    goal: GOAL,
    assessment: { summary: 's', usableExistingFields: [{ fieldCode: 'owner', note: '', evidenceIds: [E('owner')] }], usableExistingSettings: [], missingCapabilities: ['更新状況'], uncertainties: [] },
    relevantFields: [{ fieldCode: 'owner', role: '担当', evidenceIds: [E('owner')] }],
    proposedFields: [{ temporaryId: 'NEW_FIELD_1', label: '更新状況', suggestedCode: 'progress', type: 'DROP_DOWN', typeValid: true, required: false, options: OPTIONS, reason: 'r', evidenceIds: [E('owner')], alternativeExistingFieldCode: null, codeConflict: false, labelDuplicate: false }],
    steps: [
      mkStep('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'DROP_DOWN', options: OPTIONS }),
      mkStep('P2', 'ADD_VIEW', 'VIEW', '担当者別', { name: '担当者別', fields: ['owner', 'case_name', 'NEW_FIELD_1'], filterCond: 'owner in (LOGINUSER())', sort: 'due_date asc' }, { dependsOn: ['P1'] }),
      mkStep('P3', 'CUSTOMIZATION_REQUIRED', 'JS', null, {}),
    ],
    alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED',
    summary: { steps: 3, invalidSteps: 0, needsConfirmation: 0, proposedFields: 1, questions: 0 },
  },
};
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
//   簡素化 E（2026-10-16）: 手順ごとの承認 → ［動作テスト環境へ反映］→ 最終確認（キャンセル / 反映）の段は削除した（反映は最終案のカードの 1 回）。
//   右の「反映」は、最終案の反映の中で同じ部品（KTPlanExecutor の prepare → executePreview → buildRollbackPlan、元に戻すは prepareRollback → executeRollback）の
//   結果を KTContextUi.executorHtml で描く。ここでは画面と同じ材料で段（反映中・完了・失敗・止まった理由・元に戻す）を描いて確かめる。
//   画面の操作（最終案のカードの［動作テスト環境へ反映］・反映の記録・［変更前の状態に戻す］のボタン）は tests/ai-workspace.test.js・tests/ai-workspace-ux.test.js
const planOf = (raw) => { const v = KTAiClient.validatePlan(raw, PCTX); return { ...v.normalized, clientWarnings: v.warnings }; };
const hasButton = (h, label) => new RegExp(`<button[^>]*>[^<]*${label}[^<]*</button>`).test(h);
/** 画面の反映の状態（execState）と同じ形で段を進める（mountAiWorkspace の startExecutor・confirmExecutor・startRollback・confirmRollback と同じ順） */
async function applyFlow(raw, { inputs = INPUTS, approve = null, beforePrepare = null, between = null, mutateReview = null } = {}) {
  const plan = planOf(raw);
  const review = KTPlanReview.review({ plan, ...inputs });
  const out = KTPlanReview.executorOutput(plan, review, approve || plan.steps.map(st => st.id));
  const mock = makeKintoneMock(inputs.data);
  const s = { stage: 'idle', prepared: null, execution: null, rollbackPlan: null, rollback: null, error: null, classified: KTPlanExecutor.classifySteps(out), available: true, review, finalFlow: true };
  const html = () => KTContextUi.executorHtml(s);
  const idle = html();
  if (beforePrepare) beforePrepare(mock);
  s.stage = 'preparing';
  s.prepared = await KTPlanExecutor.prepare(out, { api: mock.api, appId: '341' });
  if (s.prepared.status !== 'PREPARED') { s.stage = 'blocked'; return { plan, review, out, mock, s, html, idle, progress: null }; }
  if (between) between(mock, s);
  if (mutateReview) mutateReview(review);
  s.stage = 'running';
  let progress = null;
  mock.ctl.onWrite = () => { if (!progress && s.execution) progress = html(); };
  s.execution = await KTPlanExecutor.executePreview(s.prepared, { api: mock.api, review, data: inputs.data, onProgress: (step, partial) => { s.execution = partial; } });
  mock.ctl.onWrite = null;
  s.rollbackPlan = KTPlanExecutor.buildRollbackPlan(s.execution, s.prepared);
  s.stage = 'done';
  return { plan, review, out, mock, s, html, idle, progress };
}
async function rollbackFlow(x, { before = null } = {}) {
  if (before) before(x.mock);
  x.s.stage = 'rollback-preparing';
  x.s.rollback = await KTPlanExecutor.prepareRollback(x.s.execution, x.s.prepared, { api: x.mock.api });
  x.s.stage = x.s.rollback.status === 'PREPARED' ? 'rollback-confirm' : 'rollback-blocked';
  const confirm = x.html();
  if (x.s.stage !== 'rollback-confirm') return { confirm, done: null };
  x.s.stage = 'rolling-back';
  await KTPlanExecutor.executeRollback(x.s.rollback, { api: x.mock.api, execution: x.s.execution });
  x.s.stage = 'rolled-back';
  return { confirm, done: x.html() };
}
const auditOf = (x) => KTPlanExecutor.buildAudit({ goal: x.plan.goal, plan: x.plan, review: x.review, prepared: x.s.prepared, execution: x.s.execution, rollback: x.s.rollback });

(async () => {
console.log('\n--- 1. 反映の画面: 最終案の反映の前・反映中・完了・監査 ---');
{
  const x = await applyFlow(PLAN_X);
  //   反映の前（最終案の流れ）: 反映の画面には準備・最終確認の段もボタンも出さず、最終案のカードの［動作テスト環境へ反映］を案内する
  assert(x.idle.includes('動作テスト環境への反映') && x.idle.includes('最終案のカードの［動作テスト環境へ反映］') && !/id="kt-ai-exec-start"|id="kt-ai-exec-go"|id="kt-ai-exec-confirm"/.test(x.idle), '反映の前: 最終案のカードの［動作テスト環境へ反映］を案内する（手順ごとの承認・最終確認の段とボタンは無い）');
  assert(!hasButton(x.idle, '運用環境へ反映') && !/<button[^>]*>(実行|反映)<\/button>/.test(x.idle), '「運用環境へ反映」「実行」「反映」だけのボタンは無い');
  assert(/承認済み・実行可能[\s\S]*?<b>2 件（P1, P2）/.test(x.idle) && !/承認済みだが未対応[\s\S]*?<b>1 件/.test(x.idle), '内訳: 実行できる設定の手順 2 件。JavaScript の手順（P3）は「未対応」に数えない（最終案の反映で続けて登録する）');
  assert(x.s.prepared.status === 'PREPARED' && x.progress && x.progress.includes('動作テスト環境へ反映しています') && />1\.<[\s\S]*処理中/.test(x.progress), `反映中: 1. 処理中… の進捗表示（画面を固めない）`);
  const e3 = x.html();
  assert(x.s.execution.status === 'DONE' && e3.includes('動作テスト環境への反映が完了しました。') && e3.includes('✓ 2 件 VERIFIED') && e3.includes('⚠ 0 件') && e3.includes('× 0 件') && e3.includes('Simulationとの一致：✓') && e3.includes('運用環境にはまだ反映されていません。'), '完了: ✓ 2 件 VERIFIED / Simulationとの一致 ✓ / 運用環境にはまだ反映されていません');
  assert(/>1\.<[\s\S]*反映済み（確認で一致）[\s\S]*>2\.<[\s\S]*反映済み（確認で一致）/.test(e3) && !/>3\.</.test(e3) && !/>P[0-9]+</.test(e3), '結果一覧: 1・2 は反映済み（確認で一致）。JavaScript の手順は設定の反映の一覧に出さない（手順の番号 P1 も出さない）');
  assert(x.mock.st.fields.progress && x.mock.st.views['担当者別'] && x.mock.st.views['担当者別'].fields.join() === 'owner,case_name,progress', 'モックの動作テスト環境にフィールドと一覧が入った（一覧の NEW_FIELD_1 は実コード）');
  assert(!hasButton(e3, '運用環境へ反映') && !/<button[^>]*>[^<]*deploy/i.test(e3), '完了画面に「運用環境へ反映」ボタンは無い（Never Auto Deploy）');
  assert(e3.includes('再解析：フィールド 24 件（実行前 23）'), '再解析の要約（フィールド数 23 → 24）');
  assert(e3.includes('id="kt-ai-exec-audit-copy"') && e3.includes('id="kt-ai-exec-audit-download"') && e3.includes('id="kt-ai-exec-snapshot-copy"') && hasButton(e3, '変更前の状態に戻す'), '完了画面の［詳しく］: 監査 JSON のコピー・保存・実行前スナップショット・［変更前の状態に戻す］');
  const audit = auditOf(x);
  assert(audit.auditVersion === '2' && audit.goal === GOAL && audit.plan.steps.length === 3 && !('humanDecisions' in audit) && audit.execution.status === 'DONE' && audit.verification.length === 3 && audit.beforeSnapshot.revision === '12' && audit.actualAfter.addedFields.join() === 'progress' && audit.rollbackPlan.steps.length === 2 && audit.rollbackPlan.executed === false, '監査 JSON: goal / plan / review / execution / verification / before snapshot / actual after / rollback 計画（手順を外す判断の欄は無い: 2026-10-19 廃止）');
  const snap = x.s.execution.snapshot || x.s.prepared.snapshot;
  assert(snap.revision === '12' && snap.fields.properties.owner && !snap.fields.properties.progress, '実行前スナップショット（追加前の設定）');
  assert(e3.includes('DELETE_FIELD') && e3.includes('RESTORE_VIEWS') && e3.includes('&quot;executed&quot;: false'), 'ロールバック計画（DELETE_FIELD / RESTORE_VIEWS）を表示できる・実行はしない');
  const again = await KTPlanExecutor.prepare(x.out, { api: x.mock.api, appId: '341' });
  assert(again.status === 'BLOCKED' && again.blockers.some(b => b.code === 'STALE_PLAN') && Object.keys(x.mock.st.fields).filter(c => c === 'progress').length === 1, 'もう一度反映しようとしても STALE_PLAN で止まり、同じフィールドは 2 つ作られない');
}

console.log('\n--- 2. 失敗 / 止まった理由（stale・権限・重複）/ Simulation mismatch ---');
{
  const x = await applyFlow(PLAN_X, { approve: ['P1', 'P2'], between: (mock) => { mock.ctl.failAddField = 'progress'; } });
  const e = x.html();
  assert(x.s.execution.status === 'FAILED' && e.includes('0 件反映済み・1 件失敗・以降未実行（1 件）') && e.includes('× 1 件') && />1\.<[\s\S]*失敗/.test(e) && />2\.<[\s\S]*未実行/.test(e) && !x.mock.st.views['担当者別'], '失敗: Fail Stop・「n 件反映済み / n 件失敗 / 以降未実行」・以降の step は未実行');
}
{
  const x = await applyFlow(PLAN_X, { approve: ['P1'], beforePrepare: (mock) => { mock.st.prodRevision = 13; } });
  const e = x.html();
  assert(x.s.stage === 'blocked' && e.includes('計画作成後にアプリ設定が変更されています。再レビューしてください。') && e.includes('STALE_PLAN') && e.includes('12 → 13') && e.includes('設定は変更していません') && e.includes('最終案のカードの［動作テスト環境へ反映］をもう一度押してください') && !/id="kt-ai-exec-start"/.test(e) && x.mock.calls.every(c => c.startsWith('GET')), 'stale: STALE_PLAN の文言と差分・書き込みなし（やり直しは最終案のカードから。準備だけをやり直すボタンは無い）');
}
{
  const x = await applyFlow(PLAN_X, { approve: ['P1'], mutateReview: (rv) => { rv.simulation.after.fields.progress.label = '別名'; } });
  assert(x.html().includes('SIMULATION_MISMATCH') && x.html().includes('Simulationとの一致：×'), 'Simulation After と実際が違えば SIMULATION_MISMATCH を警告');
}
{
  const x = await applyFlow(PLAN_X, { approve: ['P1'], beforePrepare: (mock) => { mock.api.getPreviewFields = async () => { throw Object.assign(new Error('権限がありません。'), { code: 'CB_NO02' }); }; } });
  assert(x.s.stage === 'blocked' && x.html().includes('PERMISSION_DENIED') && x.html().includes('権限'), 'アプリ管理権限が無い → PERMISSION_DENIED を明示');
}
{
  // 実機 Case D: 既存と同一の通知は、準備の重複の再確認で止まり、理由（EXACT_DUPLICATE）が手順ごとに出る
  const PLAN_DUP = { ...PLAN_X, plan: { ...PLAN_X.plan, proposedFields: [], steps: [mkStep('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', '高額案件の登録_追加', { name: '高額案件の登録_追加', targets: ['USER:user1', 'FIELD_ENTITY:approver', 'FIELD_ENTITY:owner_org'], filterCond: 'amount >= "1000000"' })], summary: { steps: 1, invalidSteps: 0, needsConfirmation: 0, proposedFields: 0, questions: 0 } } };
  const x = await applyFlow(PLAN_DUP);
  const e = x.html();
  assert(x.review.steps[0].issues.some(i => i.code === 'DUPLICATE') && x.s.stage === 'blocked' && e.includes('EXACT_DUPLICATE') && e.includes('同じ設定が動作テスト環境に既にあります') && !x.mock.calls.some(c => /^PUT/.test(c)), '準備の重複の再確認で止まり（EXACT_DUPLICATE）、書き込みなし');
}

console.log('\n--- 2b. Tier 2（通知 / リマインダー / フィールド変更）の結果 ---');
{
  const PLAN_T2 = {
    ok: true, contractVersion: '2.1',
    meta: { requestId: 'pl-t2', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm' }, usage: { usedThisMonth: 1, monthlyLimit: 20 } },
    plan: {
      goal: '担当者が設定されたら本人に通知したい',
      assessment: { summary: 's', usableExistingFields: [{ fieldCode: 'owner', note: '', evidenceIds: [E('owner')] }], usableExistingSettings: [], missingCapabilities: [], uncertainties: [] },
      relevantFields: [{ fieldCode: 'owner', role: '担当', evidenceIds: [E('owner')] }],
      proposedFields: [],
      steps: [
        mkStep('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', '担当者設定通知', { name: '担当者設定通知', targets: ['FIELD_ENTITY:owner'], filterCond: 'owner not in ("")' }),
        mkStep('P2', 'ADD_REMINDER', 'REMINDER', '期限7日前', { name: '期限7日前', timingField: 'due_date', daysLater: '-7', time: '09:00', targets: ['FIELD_ENTITY:owner'] }),
        mkStep('P3', 'UPDATE_FIELD', 'FIELD', 'owner', { required: true }),
        mkStep('P4', 'UPDATE_FIELD', 'FIELD', 'case_name', { name: '案件名（正式）' }),
        mkStep('P5', 'ADD_NOTIFICATION', 'NOTIFICATION', '高額案件アラート', { name: '高額案件アラート', targets: ['FIELD_ENTITY:approver'], filterCond: 'amount >= "1000000"' }),
      ],
      alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED',
      summary: { steps: 5, invalidSteps: 0, needsConfirmation: 0, proposedFields: 0, questions: 0 },
    },
  };
  const x = await applyFlow(PLAN_T2);
  assert(/通知追加[\s\S]*?<b>2（P1, P5）/.test(x.idle) && /リマインダー追加[\s\S]*?<b>1（P2）/.test(x.idle) && /フィールド変更[\s\S]*?<b>2（P3, P4）/.test(x.idle), '内訳: カテゴリ別の件数（通知追加 2 / リマインダー追加 1 / フィールド変更 2）');
  assert(x.s.prepared.steps.some(st => (st.warnings || []).some(w => w && w.code === 'POSSIBLE_DUPLICATE' && /既存の設定と似ています/.test(w.message || ''))), '準備で、似た既存の設定（POSSIBLE_DUPLICATE）を見つける（最終案の反映の前の確認に「重複の可能性」として出す）');
  const e3 = x.html();
  assert(x.s.execution.status === 'DONE' && e3.includes('✓ 5 件 VERIFIED') && e3.includes('Simulationとの一致：✓'), `完了: 5 件 VERIFIED・Simulation 一致（${x.s.execution.status}）`);
  assert(e3.includes('通知: Before 既存 2 件 → After 3 件（＋1 件）') && e3.includes('リマインダー: Before 1 件 → After 2 件') && e3.includes('必須: いいえ → はい') && e3.includes('表示名: 案件名 → 案件名（正式）'), '結果一覧の各 step に Before / After');
  assert(x.mock.st.perRecord.length === 4 && x.mock.st.reminders.length === 2 && x.mock.st.fields.owner.required === true && x.mock.st.fields.case_name.label === '案件名（正式）' && x.mock.st.fields.case_name.code === 'case_name' && x.mock.st.general.length === 5, 'モックの動作テスト環境: 通知 2 → 4・リマインダー 1 → 2・必須化・表示名変更・既存はすべて保持');
  const audit = auditOf(x);
  assert(audit.beforeAfter.length === 5 && audit.beforeAfter.find(b => b.stepId === 'P3').before.required === false && audit.beforeAfter.find(b => b.stepId === 'P3').after.required === true && audit.rollbackPlan.steps.map(st => st.actionType).sort().join() === 'RESTORE_FIELD_PROPERTY,RESTORE_FIELD_PROPERTY,RESTORE_NOTIFICATION_SETTINGS,RESTORE_NOTIFICATION_SETTINGS,RESTORE_REMINDER_SETTINGS', 'Audit: 各 step の before / after と rollback 計画（RESTORE_*）');
}
{
  // 評価できない条件式（AI の `owner != ""`）は、反映の分類で実行不可
  const PLAN_BAD = { ...PLAN_X, plan: { ...PLAN_X.plan, proposedFields: [], steps: [mkStep('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', 'x', { name: 'x', targets: ['FIELD_ENTITY:owner'], filterCond: 'owner != ""' })], summary: { steps: 1, invalidSteps: 0, needsConfirmation: 0, proposedFields: 0, questions: 0 } } };
  const x = await applyFlow(PLAN_BAD);
  assert(/実行不可[\s\S]*?<b>1 件（P1）/.test(x.idle) && x.s.stage === 'blocked' && !x.mock.calls.some(c => /^PUT|^POST/.test(c)), '条件式が受理されない通知は「× 実行不可」・書き込みなし');
}

console.log('\n--- 2d. Phase 11: 既存設定の変更の結果と元に戻す ---');
const PLAN_U = { ...PLAN_X, plan: { ...PLAN_X.plan, proposedFields: [], steps: [
  mkStep('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', 'perRecord#1', { filterCond: 'amount >= "2000000"' }, { title: '高額案件通知の条件を 200 万円以上へ' }),
  mkStep('P2', 'UPDATE_VIEW', 'VIEW', '承認待ち', { fields: ['case_name', 'approver', 'amount'] }, { title: '承認待ち一覧に金額を表示' }),
  mkStep('P3', 'ADD_VIEW', 'VIEW', '担当者別', { name: '担当者別', fields: ['owner', 'case_name'] }, { title: '担当者別一覧を追加' }),
], summary: { steps: 3, invalidSteps: 0, needsConfirmation: 0, proposedFields: 0, questions: 0 } } };
{
  const x = await applyFlow(PLAN_U);
  assert(x.idle.includes('✎ 通知変更') && x.idle.includes('✎ 一覧変更') && /承認済み・実行可能[\s\S]*?<b>3 件/.test(x.idle), '内訳: カテゴリに ✎ 通知変更 / ✎ 一覧変更');
  assert(x.s.execution.status === 'DONE' && x.mock.st.perRecord[0].filterCond === 'amount >= "2000000"' && x.mock.st.views['承認待ち'].fields.join() === 'case_name,approver,amount' && x.mock.st.views['担当者別'], '反映: 通知の条件・一覧の表示項目・新しい一覧');
  const e2 = x.html();
  assert(e2.includes('動作テスト環境への反映が完了しました。') && e2.includes('✓ 3 件 VERIFIED') && e2.includes('運用環境にはまだ反映されていません。') && hasButton(e2, '変更前の状態に戻す') && e2.includes('id="kt-ai-exec-rollback-start"') && e2.includes('条件: amount &gt;= &quot;1000000&quot; → amount &gt;= &quot;2000000&quot;'), '完了画面: ✓ 3 件 VERIFIED・運用環境には反映されていません・[変更前の状態に戻す]（§17）・進捗行に属性単位の差分');
  const r = await rollbackFlow(x);
  assert(r.confirm.includes('動作テスト環境の変更を元に戻します。') && r.confirm.includes('・一覧追加 1 件') && r.confirm.includes('・通知変更 1 件') && r.confirm.includes('・一覧変更 1 件') && r.confirm.includes('運用環境には影響しません。') && hasButton(r.confirm, 'キャンセル') && r.confirm.includes('id="kt-ai-exec-rollback-go"') && hasButton(r.confirm, '変更前の状態に戻す'), 'rollback 確認: 元に戻す内容の件数・運用環境には影響しません・[キャンセル][変更前の状態に戻す]（§18）');
  assert(/P3[\s\S]*?P2[\s\S]*?P1/.test(r.confirm.slice(r.confirm.indexOf('kt-ai-rollback'))), '元に戻す順序は P3 → P2 → P1（逆順）');
  const rb = x.s.rollback;
  assert(rb.status === 'ROLLED_BACK_VERIFIED' && r.done.includes('動作テスト環境を実行前の状態に戻しました。') && r.done.includes('✓ 3 件 ROLLBACK_VERIFIED') && r.done.includes('反映する前の設定との比較：✓ 一致') && r.done.includes('運用環境には影響していません。') && !r.done.includes('id="kt-ai-exec-rollback-start"'), 'rollback 結果: ROLLED_BACK_VERIFIED・snapshot と一致・ボタンは消える');
  assert(x.mock.st.perRecord[0].filterCond === 'amount >= "1000000"' && x.mock.st.views['承認待ち'].fields.join() === 'case_name,approver' && !x.mock.st.views['担当者別'], '動作テスト環境が実行前に戻っている');
  const audit = auditOf(x);
  assert(audit.auditVersion === '2' && audit.rollback && audit.rollback.status === 'ROLLED_BACK_VERIFIED' && audit.rollback.steps.length === 3 && audit.rollback.verification.restoredToSnapshot === true && audit.rollback.requestedAt, '監査 JSON に rollback { requestedAt, status, steps, verification }（§27）');
}
{
  // Rollback stale（Case D）: 反映後に人間が同じ集合を変更 → 「自動では元に戻せません」・人間の変更は残る
  const x = await applyFlow(PLAN_U, { approve: ['P1'] });
  assert(x.s.execution.status === 'DONE', '前提: 通知の条件変更を反映');
  const r = await rollbackFlow(x, { before: (mock) => { mock.st.perRecord[0].title = '人間が変更'; mock.st.revision += 1; } });
  assert(x.s.stage === 'rollback-blocked' && r.confirm.includes('自動では元に戻せません') && r.confirm.includes('data-code="ROLLBACK_STALE"') && !r.confirm.includes('[ROLLBACK_STALE]') && r.confirm.includes('反映後にレコードの条件通知の設定が変更されています') && r.confirm.includes('現在の動作テスト環境を確認してください') && hasButton(r.confirm, '閉じる') && hasButton(r.confirm, 'もう一度確認する'), 'ROLLBACK_STALE: 止まる・理由と差分・設定は変更していません');
  assert(x.mock.st.perRecord[0].title === '人間が変更' && x.mock.st.perRecord[0].filterCond === 'amount >= "2000000"', '人間の変更を消さない（PUT なし）');
}
{
  // Partial rollback（§30）: P2 の rollback 成功・P1 失敗 → 「一部の変更だけ元に戻りました。」✓ P2 × P1
  const PLAN_P = { ...PLAN_X, plan: { ...PLAN_X.plan, steps: [
    mkStep('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'DROP_DOWN', options: OPTIONS }),
    mkStep('P2', 'ADD_VIEW', 'VIEW', '担当者別', { name: '担当者別', fields: ['owner', 'case_name', 'NEW_FIELD_1'] }, { dependsOn: ['P1'] }),
  ], summary: { steps: 2, invalidSteps: 0, needsConfirmation: 0, proposedFields: 1, questions: 0 } } };
  const x = await applyFlow(PLAN_P);
  const r = await rollbackFlow(x, { before: (mock) => { mock.ctl.failDelete = true; } });
  assert(x.s.stage === 'rolled-back' && r.done.includes('一部の変更だけ元に戻りました。') && /✓ P2[\s\S]*?× P1/.test(r.done) && r.done.includes('現在の動作テスト環境を確認してください。') && !x.mock.st.views['担当者別'] && x.mock.st.fields.progress, '§30: 一部の変更だけ元に戻りました ✓ P2 × P1・現在の動作テスト環境を確認してください（一覧は戻りフィールドは残る）');
}

console.log('\n--- 2e. Phase 12: プロセス管理の結果（Before / Planned / Actual・Change Group）と元に戻す ---');
{
  const PLAN_PR = { ...PLAN_X, plan: { ...PLAN_X.plan, proposedFields: [], steps: [
    mkStep('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認', { name: '部長承認', assignees: ['FIELD_ENTITY:approver'], assigneeType: 'ONE' }, { title: 'ステータス「部長承認」を追加' }),
    mkStep('P2', 'UPDATE_PROCESS', 'PROCESS_ACTION', '承認する', { filterCond: 'amount <= "999999"', changeKind: 'ACTION_CONDITION' }, { title: '「承認する」を 100 万円未満に限定', dependsOn: ['P1'] }),
    mkStep('P3', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長へ申請', { name: '部長へ申請', from: '承認待ち', to: '部長承認', filterCond: 'amount >= "1000000"' }, { title: '100 万円以上は部長へ', dependsOn: ['P1'] }),
    mkStep('P4', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長承認する', { name: '部長承認する', from: '部長承認', to: '完了' }, { title: '部長が承認', dependsOn: ['P1'] }),
  ], summary: { steps: 4, invalidSteps: 0, needsConfirmation: 0, proposedFields: 0, questions: 0 } } };
  const x = await applyFlow(PLAN_PR);
  assert(x.idle.includes('＋ ステータス追加') && x.idle.includes('＋ アクション追加') && x.idle.includes('✎ プロセス管理変更') && /承認済み・実行可能[\s\S]*?<b>4 件/.test(x.idle), '内訳: ステータス追加 / アクション追加 / プロセス管理変更');
  const ex = x.s.execution;
  assert(ex.status === 'DONE' && ex.steps.every(st => st.status === 'VERIFIED' && st.groupId === 'PROCESS_CHANGE_1') && Object.keys(x.mock.st.status.states).length === 4 && x.mock.calls.filter(c => c === 'PUT status').length === 1, '反映: 4 step が 1 回の PUT で VERIFIED');
  const e2 = x.html();
  assert(e2.includes('✓ 4 件 VERIFIED') && e2.includes('id="kt-ai-exec-process"') && e2.includes('プロセス管理（反映前 / 計画 / 反映後）') && (e2.match(/class="kt-ai-mermaid"/g) || []).length >= 3 && e2.includes('反映後: ステータス 未処理 → 承認待ち → 完了 → 部長承認') && !/Planned|Actual|Before（/.test(e2) && e2.includes('（プロセス管理の変更はまとめて 1 回で更新）') && !e2.includes('[PROCESS_CHANGE_1]') && hasButton(e2, '変更前の状態に戻す'), '§18: 完了画面に Before / Planned / Actual の Mermaid・Actual の要約・グループ表示・[変更前の状態に戻す]');
  assert(/プロセス管理（反映前 \/ 計画 \/ 反映後）<\/b><div style="display:grid; gap:6px; margin-top:4px;">/.test(e2) && (e2.match(/min-width:0; overflow-x:auto;"><div style="font-size:11px; opacity:.7;">(反映前|計画（反映後の予定）|反映後（)/g) || []).length === 3 && !/flex:1 1 220px/.test(e2), '完了画面の Before / Planned / Actual は縦に並べる（3 つを横に並べない）');
  const r = await rollbackFlow(x);
  assert(r.confirm.includes('・プロセス管理の変更 1 件') && r.confirm.includes('実行前のプロセス管理（ステータス・アクション・作業者）全体に戻す') && r.confirm.includes('運用環境には影響しません。'), 'rollback 確認: プロセス管理の変更 1 件 → 全体に戻す');
  assert(x.s.rollback.status === 'ROLLED_BACK_VERIFIED' && r.done.includes('動作テスト環境を実行前の状態に戻しました。') && Object.keys(x.mock.st.status.states).length === 3 && x.mock.st.status.actions.length === 3 && x.mock.st.status.actions[1].filterCond === '', 'rollback: プロセス設定が実行前（3 ステータス / 3 アクション・承認するは条件なし）に戻る');
  const audit = auditOf(x);
  assert(audit.execution.process && audit.execution.process.planned && audit.execution.process.actual && audit.rollback.status === 'ROLLED_BACK_VERIFIED' && audit.rollback.steps[0].actionType === 'RESTORE_PROCESS_SETTINGS', '監査 JSON に Before / Planned / Actual のプロセスと rollback');
}

console.log('\n--- 2f. Phase 13: ルックアップの結果（§41）・参照元が読めない（§40）・元に戻す ---');
{
  const PLAN_LK = { ...PLAN_X, plan: { ...PLAN_X.plan, missingCapabilities: [], proposedFields: [
    { temporaryId: 'NEW_FIELD_1', label: '顧客住所', suggestedCode: 'customer_address', type: 'SINGLE_LINE_TEXT', typeValid: true, required: false, options: [], reason: 'r', evidenceIds: [E('owner')], alternativeExistingFieldCode: null, codeConflict: false, labelDuplicate: false },
    { temporaryId: 'NEW_FIELD_2', label: '与信枠', suggestedCode: 'customer_credit', type: 'NUMBER', typeValid: true, required: false, options: [], reason: 'r', evidenceIds: [E('owner')], alternativeExistingFieldCode: null, codeConflict: false, labelDuplicate: false },
  ], steps: [
    mkStep('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'SINGLE_LINE_TEXT' }, { title: '顧客住所フィールドを追加' }),
    mkStep('P2', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_2', { fieldType: 'NUMBER' }, { title: '与信枠フィールドを追加' }),
    mkStep('P3', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', { addMappings: [{ relatedField: 'address', field: 'NEW_FIELD_1' }, { relatedField: 'credit', field: 'NEW_FIELD_2' }] }, { title: '顧客マスタ参照で住所と与信枠も取得', dependsOn: ['P1', 'P2'] }),
  ], summary: { steps: 3, invalidSteps: 0, needsConfirmation: 0, proposedFields: 2, questions: 0 } } };
  const x = await applyFlow(PLAN_LK);
  assert(x.idle.includes('✓ フィールド追加') && x.idle.includes('✎ ルックアップ変更') && /承認済み・実行可能[\s\S]*?<b>3 件/.test(x.idle), '内訳: フィールド追加 2 / ルックアップ変更 1');
  const ex = x.s.execution;
  assert(ex.status === 'DONE' && ex.steps.every(st => st.status === 'VERIFIED') && x.mock.st.fields.customer_lookup.lookup.fieldMappings.length === 4 && x.mock.st.fields.customer_lookup.lookup.relatedApp.app === '500', '反映: 3 step VERIFIED・取得項目 4 件・参照元は不変');
  const e2 = x.html();
  assert(e2.includes('✓ 3 件 VERIFIED') && e2.includes('id="kt-ai-exec-lookup-result"') && e2.includes('✓ ルックアップ「顧客マスタ参照」: 取得項目 2 → 4 件。参照元 App 500「顧客マスタ」: 取得元フィールドは存在・参照元のフィールド定義は Review 時点と同じ。検索方法は kintone が管理（検証対象外）') && e2.includes('Simulationとの一致：✓') && e2.includes('ルックアップの依存 customer_lookup:') && hasButton(e2, '変更前の状態に戻す'), '§41: 結果にルックアップの行（取得項目 2 → 4・参照元の確認・検索方法の注記）と再解析の edge');
  const r = await rollbackFlow(x);
  assert(r.confirm.includes('・ルックアップ変更 1 件') && r.confirm.includes('・フィールド追加 2 件') && r.confirm.includes('実行前のルックアップ設定（取得項目・選択時表示・絞り込み・並び順）に戻す。参照元アプリには触れない') && (() => { const rb1 = r.confirm.slice(r.confirm.indexOf('id="kt-ai-rollback"')); return rb1.indexOf('ルックアップ変更') < rb1.indexOf('フィールドを削除'); })(), 'rollback 確認: ルックアップの復元（先）とフィールド削除（後）');
  assert(x.s.rollback.status === 'ROLLED_BACK_VERIFIED' && r.done.includes('動作テスト環境を実行前の状態に戻しました。') && x.mock.st.fields.customer_lookup.lookup.fieldMappings.length === 2 && !x.mock.st.fields.customer_address && !x.mock.st.fields.customer_credit, 'rollback: 取得項目 2 件・追加フィールドなしに戻る');
  const audit = auditOf(x);
  assert(audit.crossApp && audit.crossApp[0].appId === '500' && audit.crossApp[0].reviewed.fieldsHash === audit.crossApp[0].current.fieldsHash && audit.rollback.steps[0].actionType === 'RESTORE_LOOKUP_SETTINGS' && audit.execution.actualAfter.updatedLookups.join() === '顧客マスタ参照', '監査 JSON: crossApp（指紋）・rollback の先頭は RESTORE_LOOKUP_SETTINGS・updatedLookups');
  // §40: 参照元アプリへのアクセス権が無い（確認のときは読めたが、反映の準備で読めない）
  const x2 = await applyFlow(PLAN_LK, { beforePrepare: (mock) => { mock.ctl.relatedUnavailable = '500'; } });
  const b1 = x2.html();
  assert(x2.s.stage === 'blocked' && b1.includes('>顧客マスタ参照で住所と与信枠も取得：<b>実行不可</b>') && b1.includes('顧客マスタのフィールド設定を確認できません。参照元アプリへのアクセス権を確認してください') && b1.includes('data-code="RELATED_APP_SETTINGS_UNAVAILABLE"') && !b1.includes('[RELATED_APP_SETTINGS_UNAVAILABLE]') && b1.includes('設定は変更していません。'), '§40: 参照元を読めない → 実行不可・「顧客マスタのフィールド設定を確認できません。参照元アプリへのアクセス権を確認してください」');
}

console.log('\n--- 2g. Phase 14: アプリアクションの結果・コピー先が読めない・元に戻す ---');
{
  const PLAN_AA = { ...PLAN_X, plan: { ...PLAN_X.plan, missingCapabilities: [], proposedFields: [], steps: [
    mkStep('P1', 'UPDATE_APP_ACTION', 'APP_ACTION', '見積を作成', { actionMappings: [{ srcType: 'FIELD', srcField: 'secret_memo', destField: 'note' }] }, { title: '見積を作成に備考も転記' }),
    mkStep('P2', 'ADD_APP_ACTION', 'APP_ACTION', '請求書作成', { name: '請求書作成', destApp: '311', actionMappings: [{ srcType: 'FIELD', srcField: 'case_name', destField: 'quote_title' }, { srcType: 'FIELD', srcField: 'amount', destField: 'quote_amount' }, { srcType: 'RECORD_URL', srcField: null, destField: 'source_url' }], entities: ['GROUP:everyone'] }, { title: '請求書作成アクションを追加' }),
  ], summary: { steps: 2, invalidSteps: 0, needsConfirmation: 0, proposedFields: 0, questions: 0 } } };
  const x = await applyFlow(PLAN_AA);
  assert(x.idle.includes('✎ アプリアクション変更') && x.idle.includes('＋ アプリアクション追加') && /承認済み・実行可能[\s\S]*?<b>2 件/.test(x.idle), '内訳: アプリアクション変更 1 / 追加 1');
  const ex = x.s.execution;
  assert(ex.status === 'DONE' && ex.steps.every(st => st.status === 'VERIFIED') && Object.keys(x.mock.st.actions).length === 2 && x.mock.st.actions['見積を作成'].mappings.length === 3 && x.mock.st.actions['請求書作成'].mappings.length === 3 && x.mock.calls.filter(c => c === 'PUT actions').length === 2, '反映: 2 step VERIFIED（PUT 2 回・既存に転記 1 件追加・新規 1 件）');
  const e2 = x.html();
  assert(e2.includes('✓ 2 件 VERIFIED') && e2.includes('id="kt-ai-exec-app-action-result"') && e2.includes('✓ アプリアクション「見積を作成」: 転記 2 → 3 件。コピー先 App 311「見積管理」（変更なし）。他のアクション 0 件はそのまま') && e2.includes('✓ アプリアクション「請求書作成」を追加: 転記 3 件。コピー先 App 311「見積管理」（変更なし）。他のアクション 1 件はそのまま') && e2.includes('Simulationとの一致：✓') && e2.includes('アプリアクションの依存 見積を作成:') && hasButton(e2, '変更前の状態に戻す'), '結果: アプリアクションの行（転記 2 → 3 / 追加 3 件・コピー先・他のアクションはそのまま）と再解析');
  const r = await rollbackFlow(x);
  assert(r.confirm.includes('・アプリアクション追加 1 件') && r.confirm.includes('・アプリアクション変更 1 件') && r.confirm.includes('実行前のアプリアクション全体に戻す（追加したアクションは消え、変更した転記 / 利用者 / 利用条件は元に戻る）。コピー先アプリには触れない'), 'rollback 確認: アプリアクション全体の復元');
  assert(x.s.rollback.status === 'ROLLED_BACK_VERIFIED' && r.done.includes('動作テスト環境を実行前の状態に戻しました。') && Object.keys(x.mock.st.actions).length === 1 && x.mock.st.actions['見積を作成'].mappings.length === 2, 'rollback: 元の 1 件・転記 2 件に戻る');
  const audit = auditOf(x);
  assert(audit.crossApp.every(c => c.appId === '311' && c.role === 'destination') && audit.rollback.steps[0].actionType === 'RESTORE_APP_ACTION_SETTINGS' && audit.execution.actualAfter.addedAppActions.join() === '請求書作成' && audit.execution.actualAfter.updatedAppActions.join() === '見積を作成', '監査 JSON: crossApp（コピー先）・rollback・added / updatedAppActions');
  const x2 = await applyFlow(PLAN_AA, { beforePrepare: (mock) => { mock.ctl.destUnavailable = '311'; } });
  const b1 = x2.html();
  assert(x2.s.stage === 'blocked' && b1.includes('>見積を作成に備考も転記：<b>実行不可</b>') && b1.includes('コピー先アプリへのアクセス権を確認してください') && b1.includes('data-code="DEST_APP_SETTINGS_UNAVAILABLE"') && !b1.includes('[DEST_APP_SETTINGS_UNAVAILABLE]'), 'コピー先を読めない → 実行不可（DEST_APP_SETTINGS_UNAVAILABLE）');
}

console.log('\n--- 3. 回帰 ---');
{
  assert(JSON.stringify(INPUTS.data) === JSON.stringify(FX.makeData()), '確認・反映の材料を作っても DATA は変更しない');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
