// Preview Executor の UI（mountAiWorkspace: 実行前レビューの「動作テスト環境へ反映」/ 最終確認 / 進捗 / 結果 / 未対応 / 監査 JSON）
//
// 検証内容（§35）: preview button / confirmation / progress / success / failure / unsupported / verified / simulation mismatch /
//   production deploy button absent / stale / 権限
//
// 実行方法: node tests/ai-plan-executor-ui.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { makeFakeHost } = require('./helpers/fake-dom.js');
const { KTDeps, KTScan, KTContext, KTAiClient, mountAiWorkspace } = loadToolkit();
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
const makeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const tick = () => new Promise(r => setTimeout(r, 0));
const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'] }, 'change-planner': { implemented: true, promptVersions: ['1'] } } }, usage: { monthlyLimit: 20, usedThisMonth: 1 } };
function mount({ planResponse = PLAN_X, inputs = INPUTS, executor = undefined } = {}) {
  const storage = makeStorage();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' });
  settings.setConsent(true);
  const client = { async getHealth() { return HEALTH; }, async ask() { throw new Error('x'); }, async plan({ ctx, requestId }) { const v = KTAiClient.validatePlan(planResponse, ctx); return { ...v.normalized, requestId, clientWarnings: v.warnings }; } };
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const flow = { start: async () => { throw new Error('x'); }, cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false };
  const host = makeFakeHost();
  const copies = [], downloads = [];
  const mock = makeKintoneMock(inputs.data);
  const panel = mountAiWorkspace(host, { getInputs: () => inputs, setPreview: () => { }, copyText: async (t) => { copies.push(t); return true; }, downloadText: (name, text) => downloads.push({ name, text }), colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: flow, executor: executor === undefined ? { api: mock.api, appId: '341' } : executor });
  const $ = (id) => host.querySelector(`#${id}`);
  return { host, panel, $, copies, downloads, mock, session };
}
async function runPlan(m) {
  m.panel.setMode('plan');
  m.$('kt-ai-goal').value = GOAL;
  await m.$('kt-ai-generate').dispatch('click');
  await m.$('kt-ai-plan').dispatch('click'); await tick(); await tick();
  // Phase 19: 右 Workspace は 計画 / 検証 / 実行 のペインに分かれた。従来どおり 1 つの文字列として検証する
  return m.$('kt-ai-plan-result').innerHTML + m.$('kt-ai-review-result').innerHTML + m.$('kt-ai-exec').innerHTML;
}
const click = (m, id) => m.$('kt-ai-plan-result').dispatch({ type: 'click', target: { id } });
const execHtml = (m) => m.$('kt-ai-exec').innerHTML;
const hasButton = (h, label) => new RegExp(`<button[^>]*>[^<]*${label}[^<]*</button>`).test(h);

(async () => {
console.log('\n--- 1. 実行前レビューに「動作テスト環境へ反映」が付く（承認前は押せない）---');
{
  const m = mount();
  await tick();
  const h = await runPlan(m);
  // 2026-10-06 利用者の指示で意図して更新: 反映（exec）はタブではなく、右下の「右の「反映」」（#kt-ai-pane-exec.kt-ai-apply-area）。#kt-ai-exec はこの欄の中
  //   （fake の host は #id の要素を引くたびに作るので、配置は画面の HTML で確かめる）
  assert(/<div id="kt-ai-pane-exec" class="kt-ai-pane">[\s\S]*?<div id="kt-ai-exec"><\/div>/.test(m.host.innerHTML) && /data-pane="exec"[^>]*>反映</.test(m.host.innerHTML), '動作テスト環境への反映のブロックは右のタブ「反映」（#kt-ai-pane-exec）の中の固定要素');
  const e0 = execHtml(m);
  // 2026-10-06 利用者の指示で意図して更新: 承認が 0 件のときの文は「承認済みで反映できる手順がありません（右の「確認結果」で手順を承認してください）」（旧「承認済みで実行できる step がありません」）
  assert(e0.includes('動作テスト環境への反映') && e0.includes('承認済み・実行可能') && e0.includes('承認済みだが未対応') && e0.includes('実行不可') && /id="kt-ai-exec-start"[^>]*disabled/.test(e0) && e0.includes('承認済みで反映できる手順がありません（右の「確認結果」で手順を承認してください）') && !e0.includes('step がありません'), '承認が無ければ件数 0 でボタンは押せない（承認する場所は右の「確認結果」と案内する）');
  assert(hasButton(e0, '動作テスト環境へ反映') && !hasButton(e0, '運用環境へ反映') && !/<button[^>]*>(実行|反映)<\/button>/.test(e0), 'ボタンには必ず「動作テスト環境」と明記（「実行」「反映」だけのボタンは無い）');
  m.panel.decide('P1', 'approve'); m.panel.decide('P2', 'approve'); m.panel.decide('P3', 'approve');
  const e1 = execHtml(m);
  assert(/承認済み・実行可能[\s\S]*?<b>2 件（P1, P2）/.test(e1) && /承認済みだが未対応[\s\S]*?<b>1 件（P3）/.test(e1) && e1.includes('P3') && e1.includes('PLAN_ONLY') && e1.includes('Toolkit からは自動で反映できません'), '承認すると「✓ 承認済み・実行可能 2 件 / △ 承認済みだが未対応 1 件」。未対応は無視せず PLAN_ONLY と明示');
  assert(/id="kt-ai-exec-start"(?![^>]*disabled)/.test(e1) && m.mock.calls.length === 0, '実行可能な step があればボタンが有効。ここまで kintone API は呼ばない');
  m.panel.decide('P2', 'hold');
  assert(/承認済み・実行可能[\s\S]*?<b>1 件（P1）/.test(execHtml(m)), '判断を変えると件数が追従する（保留は実行しない）');
  m.panel.decide('P2', 'approve');
  // 最終確認
  await click(m, 'kt-ai-exec-start'); await tick();
  const st = m.panel.executorState();
  const e2 = execHtml(m);
  assert(st.stage === 'confirm' && st.prepared && st.prepared.status === 'PREPARED' && m.mock.calls.every(c => c.startsWith('GET')), 'ボタン押下 → prepare（取得と再検証のみ。書き込みなし）→ 最終確認');
  assert(e2.includes('動作テスト環境へ以下を反映します。') && /<div[^>]*>追加<\/div>/.test(e2) && e2.includes('＋ フィールド 1 件') && e2.includes('＋ 一覧 1 件') && !/既存設定の変更/.test(e2) && e2.includes('運用環境には反映されません。') && hasButton(e2, 'キャンセル') && e2.includes('id="kt-ai-exec-go"') && hasButton(e2, '動作テスト環境へ反映'), '最終確認: 反映内容の件数・「運用環境には反映されません。」・キャンセル / 動作テスト環境へ反映');
  await click(m, 'kt-ai-exec-cancel');
  assert(m.panel.executorState().stage === 'idle' && /id="kt-ai-exec-start"/.test(execHtml(m)) && !m.mock.st.fields.progress, 'キャンセル → 何も反映せず元に戻る');
  // 実行（進捗 → 結果）
  await click(m, 'kt-ai-exec-start'); await tick();
  let progressSeen = null;
  m.mock.ctl.onWrite = (what) => { if (what === 'POST fields') progressSeen = execHtml(m); };
  await click(m, 'kt-ai-exec-go'); await tick(); await tick();
  const st2 = m.panel.executorState();
  assert(progressSeen && progressSeen.includes('動作テスト環境へ反映しています') && /P1[\s\S]*処理中/.test(progressSeen) && /P2[\s\S]*待機中/.test(progressSeen), '実行中: P1 処理中... / P2 待機中 の進捗表示（画面を固めない）');
  const e3 = execHtml(m);
  assert(st2.stage === 'done' && st2.execution.status === 'DONE' && e3.includes('動作テスト環境への反映が完了しました。') && e3.includes('✓ 2 件 VERIFIED') && e3.includes('⚠ 0 件') && e3.includes('× 0 件') && e3.includes('Simulationとの一致：✓') && e3.includes('運用環境にはまだ反映されていません。'), '完了: ✓ 2 件 VERIFIED / Simulationとの一致 ✓ / 運用環境にはまだ反映されていません');
  assert(/P1[\s\S]*VERIFIED[\s\S]*P2[\s\S]*VERIFIED[\s\S]*P3[\s\S]*PLAN_ONLY/.test(e3) && e3.includes('Toolkit からは自動で反映できません'), '結果一覧: P1 / P2 VERIFIED・P3 は PLAN_ONLY と表示');
  assert(m.mock.st.fields.progress && m.mock.st.views['担当者別'] && m.mock.st.views['担当者別'].fields.join() === 'owner,case_name,progress', 'モックの動作テスト環境にフィールドと一覧が入った（一覧の NEW_FIELD_1 は実コード）');
  assert(!hasButton(e3, '運用環境へ反映') && !/<button[^>]*>[^<]*deploy/i.test(e3), '完了画面に「運用環境へ反映」ボタンは無い（Never Auto Deploy）');
  assert(e3.includes('再解析：フィールド 24 件（実行前 23）'), '再解析の要約（フィールド数 23 → 24）');
  // 監査 JSON / snapshot / rollback
  await click(m, 'kt-ai-exec-audit-copy');
  const audit = JSON.parse(m.copies[m.copies.length - 1]);
  assert(audit.auditVersion === '2' && audit.goal === GOAL && audit.plan.steps.length === 3 && audit.humanDecisions.P1 === 'approve' && audit.execution.status === 'DONE' && audit.verification.length === 3 && audit.beforeSnapshot.revision === '12' && audit.actualAfter.addedFields.join() === 'progress' && audit.rollbackPlan.steps.length === 2 && audit.rollbackPlan.executed === false, '監査 JSON: goal / plan / review / 判断 / execution / verification / before snapshot / actual after / rollback 計画');
  await click(m, 'kt-ai-exec-audit-download');
  assert(m.downloads.length === 1 && /^toolkit-ai-execution-ex_.*\.json$/.test(m.downloads[0].name) && JSON.parse(m.downloads[0].text).auditVersion === '2', '監査 JSON を保存（ファイル名に executionId）');
  await click(m, 'kt-ai-exec-snapshot-copy');
  const snap = JSON.parse(m.copies[m.copies.length - 1]);
  assert(snap.revision === '12' && snap.fields.properties.owner && !snap.fields.properties.progress, '実行前スナップショットをコピー（追加前の設定）');
  await click(m, 'kt-ai-exec-rollback-toggle'); await click(m, 'kt-ai-exec-rollback-toggle');   // fake DOM は display の初期値が無いので 2 回で表示状態
  assert(m.$('kt-ai-exec-rollback').style.display === '' && execHtml(m).includes('DELETE_FIELD') && execHtml(m).includes('RESTORE_VIEWS') && execHtml(m).includes('&quot;executed&quot;: false'), 'ロールバック計画（DELETE_FIELD / RESTORE_VIEWS）を表示できる・実行はしない');
  // 二重実行: 完了後にもう一度押しても新しい prepare は STALE で止まる
  m.panel.decide('P1', 'approve');
  await click(m, 'kt-ai-exec-start'); await tick();
  assert(m.panel.executorState().stage === 'blocked' && execHtml(m).includes('STALE_PLAN') && Object.keys(m.mock.st.fields).filter(c => c === 'progress').length === 1, '再度押しても STALE_PLAN で止まり、同じフィールドは 2 つ作られない');
}

console.log('\n--- 2. 失敗 / 未対応のみ / stale / 権限 / Simulation mismatch / Executor 無し ---');
{
  const m = mount();
  await tick(); await runPlan(m);
  m.panel.decide('P1', 'approve'); m.panel.decide('P2', 'approve');
  m.mock.ctl.failAddField = 'progress';
  await click(m, 'kt-ai-exec-start'); await tick();
  await click(m, 'kt-ai-exec-go'); await tick(); await tick();
  const e = execHtml(m);
  assert(m.panel.executorState().execution.status === 'FAILED' && e.includes('0 件反映済み・1 件失敗・以降未実行（1 件）') && e.includes('× 1 件') && /P1[\s\S]*FAILED/.test(e) && /P2[\s\S]*未実行/.test(e) && !m.mock.st.views['担当者別'], '失敗: Fail Stop・「n 件反映済み / n 件失敗 / 以降未実行」・以降の step は未実行');
}
{
  const m = mount();
  await tick(); await runPlan(m);
  m.panel.decide('P3', 'approve');
  const e = execHtml(m);
  assert(/承認済みだが未対応[\s\S]*?<b>1 件（P3）/.test(e) && /id="kt-ai-exec-start"[^>]*disabled/.test(e), '未対応の step だけ承認 → 件数に出るがボタンは押せない');
}
{
  const m = mount();
  await tick(); await runPlan(m);
  m.panel.decide('P1', 'approve');
  m.mock.st.prodRevision = 13;
  await click(m, 'kt-ai-exec-start'); await tick();
  const e = execHtml(m);
  assert(m.panel.executorState().stage === 'blocked' && e.includes('計画作成後にアプリ設定が変更されています。再レビューしてください。') && e.includes('STALE_PLAN') && e.includes('12 → 13') && e.includes('設定は変更していません') && m.mock.calls.every(c => c.startsWith('GET')), 'stale: STALE_PLAN の文言と差分・書き込みなし');
  await click(m, 'kt-ai-exec-cancel');
  assert(m.panel.executorState().stage === 'idle', 'もう一度確認する / 戻るで idle に');
}
{
  const m = mount();
  await tick(); await runPlan(m);
  m.panel.decide('P1', 'approve');
  const bad = JSON.parse(JSON.stringify(m.panel.lastReview()));
  m.panel.lastReview().simulation.after.fields.progress.label = '別名';   // Review の After をわざと壊す
  await click(m, 'kt-ai-exec-start'); await tick();
  await click(m, 'kt-ai-exec-go'); await tick(); await tick();
  assert(execHtml(m).includes('SIMULATION_MISMATCH') && execHtml(m).includes('Simulationとの一致：×'), 'Simulation After と実際が違えば SIMULATION_MISMATCH を警告');
  void bad;
}
{
  const inputs = INPUTS;
  const m = mount({ executor: null });
  await tick(); await runPlan(m);
  m.panel.decide('P1', 'approve');
  const e = execHtml(m);
  assert(/id="kt-ai-exec-start"[^>]*disabled/.test(e) && e.includes('kintone API が無い'), 'Executor（kintone API）が無い環境では押せない');
  void inputs;
}
{
  const m = mount();
  await tick(); await runPlan(m);
  m.panel.decide('P1', 'approve');
  const orig = m.mock.api.getPreviewFields;
  m.mock.api.getPreviewFields = async () => { throw Object.assign(new Error('権限がありません。'), { code: 'CB_NO02' }); };
  await click(m, 'kt-ai-exec-start'); await tick();
  assert(m.panel.executorState().stage === 'blocked' && execHtml(m).includes('PERMISSION_DENIED') && execHtml(m).includes('権限'), 'アプリ管理権限が無い → PERMISSION_DENIED を明示');
  m.mock.api.getPreviewFields = orig;
}

console.log('\n--- 2b. Tier 2（通知 / リマインダー / フィールド変更）の UI ---');
{
  // 通知 ＋ リマインダー ＋ 必須化 ＋ 表示名変更 ＋ 類似通知
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
  const m = mount({ planResponse: PLAN_T2 });
  await tick(); await runPlan(m);
  for (const id of ['P1', 'P2', 'P3', 'P4', 'P5']) m.panel.decide(id, 'approve');
  const e1 = execHtml(m);
  assert(/通知追加[\s\S]*?<b>2（P1, P5）/.test(e1) && /リマインダー追加[\s\S]*?<b>1（P2）/.test(e1) && /フィールド変更[\s\S]*?<b>2（P3, P4）/.test(e1) && /△ フィールド変更/.test(e1) && /✓ 通知追加/.test(e1), 'カテゴリ別の件数（✓ 通知追加 2 / ✓ リマインダー追加 1 / △ フィールド変更 2）');
  await click(m, 'kt-ai-exec-start'); await tick();
  const e2 = execHtml(m);
  assert(m.panel.executorState().stage === 'confirm' && e2.includes('＋ 通知 2 件') && e2.includes('＋ リマインダー 1 件') && /<div[^>]*>既存設定の変更<\/div>/.test(e2) && e2.includes('✎ フィールド 2 件'), '最終確認: 「追加」と「既存設定の変更」に分けた件数（§36）');
  assert(e2.includes('レコードの条件通知: Before 既存 2 件 → After 3 件') && e2.includes('リマインダー: Before 1 件 → After 2 件') && e2.includes('「担当者」 必須: いいえ → はい（フィールドコード owner は変わりません）') && e2.includes('表示名: 案件名 → 案件名（正式）'), 'Before / After: 通知（既存 2 → 3）・リマインダー（1 → 2）・フィールド（必須 いいえ → はい・表示名）');
  assert(e2.includes('⚠ 既存フィールドを変更します') && e2.includes('「担当者」を必須に変更します。この変更は今後の入力・保存に影響します。既存レコードの値は Toolkit では確認していません。') && e2.includes('フィールドコード（case_name）は変わりません'), 'Sensitive: 必須化と表示名変更を確認ダイアログで目立たせる（指定の文言）');
  assert(/P5[\s\S]*⚠ 既存の設定と似ています[\s\S]*既存: 「高額案件の登録」/.test(e2), 'POSSIBLE_DUPLICATE を最終確認で再度人間に見せる');
  await click(m, 'kt-ai-exec-go'); await tick(); await tick();
  const e3 = execHtml(m);
  const st = m.panel.executorState();
  assert(st.stage === 'done' && st.execution.status === 'DONE' && e3.includes('✓ 5 件 VERIFIED') && e3.includes('Simulationとの一致：✓'), `完了: 5 件 VERIFIED・Simulation 一致（${st.execution?.status}）`);
  assert(e3.includes('通知: Before 既存 2 件 → After 3 件（＋1 件）') && e3.includes('リマインダー: Before 1 件 → After 2 件') && e3.includes('必須: いいえ → はい') && e3.includes('表示名: 案件名 → 案件名（正式）'), '結果一覧の各 step に Before / After');
  assert(m.mock.st.perRecord.length === 4 && m.mock.st.reminders.length === 2 && m.mock.st.fields.owner.required === true && m.mock.st.fields.case_name.label === '案件名（正式）' && m.mock.st.fields.case_name.code === 'case_name' && m.mock.st.general.length === 5, 'モックの動作テスト環境: 通知 2 → 4・リマインダー 1 → 2・必須化・表示名変更・既存はすべて保持');
  await click(m, 'kt-ai-exec-audit-copy');
  const audit = JSON.parse(m.copies[m.copies.length - 1]);
  assert(audit.beforeAfter.length === 5 && audit.beforeAfter.find(x => x.stepId === 'P3').before.required === false && audit.beforeAfter.find(x => x.stepId === 'P3').after.required === true && audit.rollbackPlan.steps.map(x => x.actionType).sort().join() === 'RESTORE_FIELD_PROPERTY,RESTORE_FIELD_PROPERTY,RESTORE_NOTIFICATION_SETTINGS,RESTORE_NOTIFICATION_SETTINGS,RESTORE_REMINDER_SETTINGS', 'Audit: 各 step の before / after と rollback 計画（RESTORE_*）');
}
{
  // 評価できない条件式（AI の `owner != ""`）は承認しても実行不可として出る
  const PLAN_BAD = { ...PLAN_X, plan: { ...PLAN_X.plan, proposedFields: [], steps: [mkStep('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', 'x', { name: 'x', targets: ['FIELD_ENTITY:owner'], filterCond: 'owner != ""' })], summary: { steps: 1, invalidSteps: 0, needsConfirmation: 0, proposedFields: 0, questions: 0 } } };
  const m = mount({ planResponse: PLAN_BAD });
  await tick(); await runPlan(m);
  m.panel.decide('P1', 'approve');
  const e = execHtml(m);
  assert(/実行不可[\s\S]*?<b>1 件（P1）/.test(e) && /id="kt-ai-exec-start"[^>]*disabled/.test(e), '条件式が受理されない通知は「× 実行不可」・ボタンは押せない');
}
{
  // 実機 Case D: 既存と同一の通知を承認しても、prepare の重複再チェックで止まり、理由（EXACT_DUPLICATE）が step ごとに表示される
  const PLAN_DUP = { ...PLAN_X, plan: { ...PLAN_X.plan, proposedFields: [], steps: [mkStep('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', '高額案件の登録_追加', { name: '高額案件の登録_追加', targets: ['USER:user1', 'FIELD_ENTITY:approver', 'FIELD_ENTITY:owner_org'], filterCond: 'amount >= "1000000"' })], summary: { steps: 1, invalidSteps: 0, needsConfirmation: 0, proposedFields: 0, questions: 0 } } };
  const m = mount({ planResponse: PLAN_DUP });
  await tick(); await runPlan(m);
  assert(m.panel.lastReview().steps[0].issues.some(i => i.code === 'DUPLICATE'), 'Review が DUPLICATE');
  m.panel.decide('P1', 'approve');
  await click(m, 'kt-ai-exec-start'); await tick();
  const e = execHtml(m);
  assert(m.panel.executorState().stage === 'blocked' && e.includes('EXACT_DUPLICATE') && e.includes('同じ設定が動作テスト環境に既にあります') && /承認済み・実行可能[\s\S]*?<b>0 件/.test(e) && !m.mock.calls.some(c => /^PUT/.test(c)), '承認しても Executor の重複再チェックで止まり（EXACT_DUPLICATE）、件数は prepare 後の判定で 0 件・書き込みなし');
}

console.log('\n--- 2c. AI 接続が切れても Review / Executor は動く（Executor は Gateway 非依存）---');
{
  const m = mount();
  await tick(); await runPlan(m);
  // 計画生成後に AI 接続が壊れた（タブのスリープ / timeout / 失効）状況を模す: Gateway はすべて失敗、接続は未接続
  m.session.status = () => ({ connected: false, apiBase: 'https://gw.test', refreshExpiresAt: null, scope: null });
  m.session.client.getHealth = async () => { throw Object.assign(new Error('timeout'), { name: 'AiClientError', code: 'TIMEOUT' }); };
  m.session.client.plan = async () => { throw Object.assign(new Error('expired'), { name: 'AiClientError', code: 'SESSION_EXPIRED' }); };
  await m.panel.refreshCapability({ force: true }).catch(() => { });
  m.panel.decide('P1', 'approve'); m.panel.decide('P2', 'approve');
  await click(m, 'kt-ai-exec-start'); await tick();
  assert(m.panel.executorState().stage === 'confirm', 'AI 接続が無くても prepare（kintone API のみ）は動く');
  await click(m, 'kt-ai-exec-go'); await tick(); await tick();
  assert(m.panel.executorState().execution?.status === 'DONE' && m.mock.st.fields.progress && m.mock.st.views['担当者別'], 'AI 接続が切れていても承認済み計画の反映・検証は完了する（Gateway を呼ばない）');
}

console.log('\n--- 2d. Phase 11: 既存設定の変更の表示（バッジ・既存設定を変更・属性単位の差分・「追加」「既存設定の変更」）---');
const PLAN_U = { ...PLAN_X, plan: { ...PLAN_X.plan, proposedFields: [], steps: [
  mkStep('P1', 'UPDATE_NOTIFICATION', 'NOTIFICATION', 'perRecord#1', { filterCond: 'amount >= "2000000"' }, { title: '高額案件通知の条件を 200 万円以上へ' }),
  mkStep('P2', 'UPDATE_VIEW', 'VIEW', '承認待ち', { fields: ['case_name', 'approver', 'amount'] }, { title: '承認待ち一覧に金額を表示' }),
  mkStep('P3', 'ADD_VIEW', 'VIEW', '担当者別', { name: '担当者別', fields: ['owner', 'case_name'] }, { title: '担当者別一覧を追加' }),
], summary: { steps: 3, invalidSteps: 0, needsConfirmation: 0, proposedFields: 0, questions: 0 } } };
{
  const m = mount({ planResponse: PLAN_U });
  await tick(); const h = await runPlan(m);
  assert(h.includes('>✎ 既存変更<') && h.includes('>△ 確認必要<') && h.includes('>＋ 新規<'), 'バッジ: ✎ 既存変更 / △ 確認必要 / ＋ 新規（§35）');
  assert(h.includes('id="kt-ai-review-updates"') && h.includes('✎ 既存設定を変更') && /△<\/span> P1 レコードの条件通知「高額案件の登録」を変更/.test(h) && h.includes('条件: amount &gt;= &quot;1000000&quot; → amount &gt;= &quot;2000000&quot;') && /✓<\/span> P2 一覧「承認待ち」を変更/.test(h) && h.includes('表示フィールド: case_name, approver → case_name, approver, amount'), '「既存設定を変更」の要約: △ 通知（条件の差分だけ）・✓ 一覧（表示項目の差分だけ）（§34）');
  m.panel.decide('P1', 'approve'); m.panel.decide('P2', 'approve'); m.panel.decide('P3', 'approve');
  const e0 = execHtml(m);
  assert(e0.includes('✎ 通知変更') && e0.includes('✎ 一覧変更') && /承認済み・実行可能[\s\S]*?<b>3 件/.test(e0), 'Executor の件数: カテゴリに ✎ 通知変更 / ✎ 一覧変更');
  await click(m, 'kt-ai-exec-start'); await tick();
  const e1 = execHtml(m);
  assert(m.panel.executorState().stage === 'confirm' && /<div[^>]*>追加<\/div>/.test(e1) && e1.includes('＋ 一覧 1 件') && /<div[^>]*>既存設定の変更<\/div>/.test(e1) && e1.includes('✎ 通知 1 件') && e1.includes('✎ 一覧 1 件'), '最終確認: 「追加 ＋ 一覧 1 件」「既存設定の変更 ✎ 通知 1 件 / ✎ 一覧 1 件」（§36）');
  assert(e1.includes('条件: amount &gt;= &quot;1000000&quot; → amount &gt;= &quot;2000000&quot;') && e1.includes('表示フィールド: case_name, approver → case_name, approver, amount') && e1.includes('変更する属性: 条件') && !/通知先: /.test(e1) && e1.includes('⚠ 既存の設定を変更します') && e1.includes('通知される範囲が狭くなります'), '最終確認の Before / After は変更した属性だけ・条件変更は警告（通知が届かなくなる可能性）');
  await click(m, 'kt-ai-exec-go'); await tick(); await tick();
  const ex = m.panel.executorState().execution;
  assert(m.panel.executorState().stage === 'done' && ex.status === 'DONE' && m.mock.st.perRecord[0].filterCond === 'amount >= "2000000"' && m.mock.st.views['承認待ち'].fields.join() === 'case_name,approver,amount' && m.mock.st.views['担当者別'], '反映: 通知の条件・一覧の表示項目・新しい一覧');
  const e2 = execHtml(m);
  assert(e2.includes('動作テスト環境への反映が完了しました。') && e2.includes('✓ 3 件 VERIFIED') && e2.includes('運用環境にはまだ反映されていません。') && hasButton(e2, '変更前の状態に戻す') && e2.includes('id="kt-ai-exec-rollback-start"') && e2.includes('条件: amount &gt;= &quot;1000000&quot; → amount &gt;= &quot;2000000&quot;'), '完了画面: ✓ 3 件 VERIFIED・運用環境には反映されていません・[変更前の状態に戻す]（§17）・進捗行に属性単位の差分');
  // Rollback: 確認 → 実行 → 検証
  await click(m, 'kt-ai-exec-rollback-start'); await tick();
  const r1 = execHtml(m);
  assert(m.panel.executorState().stage === 'rollback-confirm' && r1.includes('動作テスト環境の変更を元に戻します。') && r1.includes('・一覧追加 1 件') && r1.includes('・通知変更 1 件') && r1.includes('・一覧変更 1 件') && r1.includes('運用環境には影響しません。') && hasButton(r1, 'キャンセル') && r1.includes('id="kt-ai-exec-rollback-go"') && hasButton(r1, '変更前の状態に戻す'), 'rollback 確認: 元に戻す内容の件数・運用環境には影響しません・[キャンセル][変更前の状態に戻す]（§18）');
  assert(/P3[\s\S]*?P2[\s\S]*?P1/.test(r1.slice(r1.indexOf('kt-ai-rollback'))) && !m.mock.calls.slice(-10).some(c => /^(PUT|DELETE)/.test(c) && m.mock.calls.indexOf(c) > m.mock.calls.lastIndexOf('GET fields')), '確認までは書き込みなし・順序は P3 → P2 → P1（逆順）');
  await click(m, 'kt-ai-exec-rollback-cancel'); await tick();
  assert(m.panel.executorState().stage === 'done' && hasButton(execHtml(m), '変更前の状態に戻す'), 'キャンセルで完了画面に戻る（ボタンは残る）');
  await click(m, 'kt-ai-exec-rollback-start'); await tick();
  await click(m, 'kt-ai-exec-rollback-go'); await tick(); await tick();
  const r2 = execHtml(m);
  const rb = m.panel.executorState().rollback;
  assert(m.panel.executorState().stage === 'rolled-back' && rb.status === 'ROLLED_BACK_VERIFIED' && r2.includes('動作テスト環境を実行前の状態に戻しました。') && r2.includes('✓ 3 件 ROLLBACK_VERIFIED') && r2.includes('実行前 snapshot との比較：✓ 一致') && r2.includes('運用環境には影響していません。') && !r2.includes('id="kt-ai-exec-rollback-start"'), 'rollback 結果: ROLLED_BACK_VERIFIED・snapshot と一致・ボタンは消える');
  assert(m.mock.st.perRecord[0].filterCond === 'amount >= "1000000"' && m.mock.st.views['承認待ち'].fields.join() === 'case_name,approver' && !m.mock.st.views['担当者別'], '動作テスト環境が実行前に戻っている');
  await click(m, 'kt-ai-exec-audit-copy'); await tick();
  const audit = JSON.parse(m.copies[m.copies.length - 1]);
  assert(audit.auditVersion === '2' && audit.rollback && audit.rollback.status === 'ROLLED_BACK_VERIFIED' && audit.rollback.steps.length === 3 && audit.rollback.verification.restoredToSnapshot === true && audit.rollback.requestedAt, '監査 JSON に rollback { requestedAt, status, steps, verification }（§27）');
}
{
  // Rollback stale（Case D）: 反映後に人間が同じ集合を変更 → 「自動では元に戻せません」[ROLLBACK_STALE]・人間の変更は残る
  const m = mount({ planResponse: PLAN_U });
  await tick(); await runPlan(m);
  m.panel.decide('P1', 'approve');
  await click(m, 'kt-ai-exec-start'); await tick(); await click(m, 'kt-ai-exec-go'); await tick(); await tick();
  assert(m.panel.executorState().execution?.status === 'DONE', '前提: 通知の条件変更を反映');
  m.mock.st.perRecord[0].title = '人間が変更'; m.mock.st.revision += 1;
  await click(m, 'kt-ai-exec-rollback-start'); await tick();
  const r = execHtml(m);
  assert(m.panel.executorState().stage === 'rollback-blocked' && r.includes('自動では元に戻せません') && r.includes('[ROLLBACK_STALE]') && r.includes('反映後にレコードの条件通知の設定が変更されています') && r.includes('現在の動作テスト環境を確認してください') && hasButton(r, '閉じる') && hasButton(r, 'もう一度確認する'), 'ROLLBACK_STALE: 止まる・理由と差分・設定は変更していません');
  assert(m.mock.st.perRecord[0].title === '人間が変更' && m.mock.st.perRecord[0].filterCond === 'amount >= "2000000"', '人間の変更を消さない（PUT なし）');
  await click(m, 'kt-ai-exec-rollback-cancel'); await tick();
  assert(m.panel.executorState().stage === 'done' && hasButton(execHtml(m), '変更前の状態に戻す'), '閉じると完了画面へ');
}
{
  // Partial rollback（§30）: P2 の rollback 成功・P1 失敗 → 「一部の変更だけ元に戻りました。」✓ P2 × P1
  const PLAN_P = { ...PLAN_X, plan: { ...PLAN_X.plan, steps: [
    mkStep('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'DROP_DOWN', options: OPTIONS }),
    mkStep('P2', 'ADD_VIEW', 'VIEW', '担当者別', { name: '担当者別', fields: ['owner', 'case_name', 'NEW_FIELD_1'] }, { dependsOn: ['P1'] }),
  ], summary: { steps: 2, invalidSteps: 0, needsConfirmation: 0, proposedFields: 1, questions: 0 } } };
  const m = mount({ planResponse: PLAN_P });
  await tick(); await runPlan(m);
  m.panel.decide('P1', 'approve'); m.panel.decide('P2', 'approve');
  await click(m, 'kt-ai-exec-start'); await tick(); await click(m, 'kt-ai-exec-go'); await tick(); await tick();
  await click(m, 'kt-ai-exec-rollback-start'); await tick();
  m.mock.ctl.failDelete = true;
  await click(m, 'kt-ai-exec-rollback-go'); await tick(); await tick();
  const r = execHtml(m);
  assert(m.panel.executorState().stage === 'rolled-back' && r.includes('一部の変更だけ元に戻りました。') && /✓ P2[\s\S]*?× P1/.test(r) && r.includes('現在の動作テスト環境を確認してください。') && !m.mock.st.views['担当者別'] && m.mock.st.fields.progress, '§30: 一部の変更だけ元に戻りました ✓ P2 × P1・現在の動作テスト環境を確認してください（一覧は戻りフィールドは残る）');
}

console.log('\n--- 2e. Phase 12: プロセス管理の最終確認（§22）・Before / Planned / Actual（§18）・Change Group・Rollback ---');
{
  const PLAN_PR = { ...PLAN_X, plan: { ...PLAN_X.plan, proposedFields: [], steps: [
    mkStep('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認', { name: '部長承認', assignees: ['FIELD_ENTITY:approver'], assigneeType: 'ONE' }, { title: 'ステータス「部長承認」を追加' }),
    mkStep('P2', 'UPDATE_PROCESS', 'PROCESS_ACTION', '承認する', { filterCond: 'amount <= "999999"', changeKind: 'ACTION_CONDITION' }, { title: '「承認する」を 100 万円未満に限定', dependsOn: ['P1'] }),
    mkStep('P3', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長へ申請', { name: '部長へ申請', from: '承認待ち', to: '部長承認', filterCond: 'amount >= "1000000"' }, { title: '100 万円以上は部長へ', dependsOn: ['P1'] }),
    mkStep('P4', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長承認する', { name: '部長承認する', from: '部長承認', to: '完了' }, { title: '部長が承認', dependsOn: ['P1'] }),
  ], summary: { steps: 4, invalidSteps: 0, needsConfirmation: 0, proposedFields: 0, questions: 0 } } };
  const m = mount({ planResponse: PLAN_PR });
  await tick(); const h = await runPlan(m);
  assert(h.includes('プロセス管理の変更前後') && h.includes('kt-ai-mermaid'), 'Review にプロセスの Before / After（Mermaid）');
  for (const id of ['P1', 'P2', 'P3', 'P4']) m.panel.decide(id, 'approve');
  const e0 = execHtml(m);
  assert(e0.includes('＋ ステータス追加') && e0.includes('＋ アクション追加') && e0.includes('✎ プロセス管理変更') && /承認済み・実行可能[\s\S]*?<b>4 件/.test(e0), 'Executor の件数: ステータス追加 / アクション追加 / プロセス管理変更');
  await click(m, 'kt-ai-exec-start'); await tick();
  const e1 = execHtml(m);
  assert(m.panel.executorState().stage === 'confirm' && e1.includes('id="kt-ai-exec-process-confirm"') && e1.includes('⚠ プロセス管理を変更します') && e1.includes('動作テスト環境の承認フローを変更します。') && e1.includes('PROCESS_CHANGE_1: 4 step を 1 回の更新にまとめます'), '§22: ⚠ プロセス管理を変更します / 承認フローを変更します / Change Group の説明');
  assert(/追加：[\s\S]*?＋ ステータス「部長承認」[\s\S]*?＋ アクション「部長へ申請」[\s\S]*?＋ アクション「部長承認する」/.test(e1) && /既存変更：[\s\S]*?✎ 「承認する」の条件変更/.test(e1), '§22: 追加（＋ ステータス / ＋ アクション）と既存変更（✎ 「承認する」の条件変更）');
  assert(e1.includes('既存の操作可能条件を変更します') && e1.includes('現在はすべての「承認待ち」で実行できます') && e1.includes('変更後は「amount &lt;= &quot;999999&quot;」の場合のみ実行可能になります') && e1.includes('⚠ 既存の設定を変更します'), '§9: 既存の操作可能条件を変更します… を最終確認に表示');
  assert((e1.match(/class="kt-ai-mermaid"/g) || []).length >= 2 && e1.includes('Proposed After') && e1.includes('条件の分割（承認待ち）') && e1.includes('明らかな重複・欠落なし') && e1.includes('運用環境には反映されません。'), '最終確認に Before / Proposed After の Mermaid と条件の分割判定・運用環境には反映されません');
  // 実機（2026-10-04）: 横に並べると枠の幅が分かれて図が縮み、文字が読めなかった → 縦に並べ、枠の中で横にスクロール（図は縮めない）
  assert(/<div style="display:grid; gap:6px; margin-top:6px;"><div style="border:1px solid [^"]*; border-radius:6px; padding:6px; min-width:0; overflow-x:auto;"><div style="font-size:11px; opacity:.7;">Before</.test(e1) && !/flex:1 1 220px/.test(e1), '最終確認の Before / Proposed After は縦に並べる（横に並べない）');
  await click(m, 'kt-ai-exec-go'); await tick(); await tick();
  const ex = m.panel.executorState().execution;
  assert(m.panel.executorState().stage === 'done' && ex.status === 'DONE' && ex.steps.every(s => s.status === 'VERIFIED' && s.groupId === 'PROCESS_CHANGE_1') && Object.keys(m.mock.st.status.states).length === 4 && m.mock.calls.filter(c => c === 'PUT status').length === 1, '反映: 4 step が 1 回の PUT で VERIFIED');
  const e2 = execHtml(m);
  assert(e2.includes('✓ 4 件 VERIFIED') && e2.includes('id="kt-ai-exec-process"') && e2.includes('プロセス管理の Before / Planned / Actual') && (e2.match(/class="kt-ai-mermaid"/g) || []).length >= 3 && e2.includes('Actual: ステータス 未処理 → 承認待ち → 完了 → 部長承認') && e2.includes('[PROCESS_CHANGE_1]') && hasButton(e2, '変更前の状態に戻す'), '§18: 完了画面に Before / Planned / Actual の Mermaid・Actual の要約・グループ表示・[変更前の状態に戻す]');
  assert(/プロセス管理の Before \/ Planned \/ Actual<\/b><div style="display:grid; gap:6px; margin-top:4px;">/.test(e2) && (e2.match(/min-width:0; overflow-x:auto;"><div style="font-size:11px; opacity:.7;">(Before|Planned|Actual)/g) || []).length === 3 && !/flex:1 1 220px/.test(e2), '完了画面の Before / Planned / Actual は縦に並べる（3 つを横に並べない）');
  await click(m, 'kt-ai-exec-rollback-start'); await tick();
  const r1 = execHtml(m);
  assert(m.panel.executorState().stage === 'rollback-confirm' && r1.includes('・プロセス管理の変更 1 件') && r1.includes('実行前のプロセス管理（ステータス・アクション・作業者）全体に戻す') && r1.includes('運用環境には影響しません。'), 'rollback 確認: プロセス管理の変更 1 件 → 全体に戻す');
  await click(m, 'kt-ai-exec-rollback-go'); await tick(); await tick();
  const r2 = execHtml(m);
  assert(m.panel.executorState().stage === 'rolled-back' && m.panel.executorState().rollback.status === 'ROLLED_BACK_VERIFIED' && r2.includes('動作テスト環境を実行前の状態に戻しました。') && Object.keys(m.mock.st.status.states).length === 3 && m.mock.st.status.actions.length === 3 && m.mock.st.status.actions[1].filterCond === '', 'rollback: プロセス設定が実行前（3 ステータス / 3 アクション・承認するは条件なし）に戻る');
  await click(m, 'kt-ai-exec-audit-copy'); await tick();
  const audit = JSON.parse(m.copies[m.copies.length - 1]);
  assert(audit.execution.process && audit.execution.process.planned && audit.execution.process.actual && audit.rollback.status === 'ROLLED_BACK_VERIFIED' && audit.rollback.steps[0].actionType === 'RESTORE_PROCESS_SETTINGS', '監査 JSON に Before / Planned / Actual のプロセスと rollback');
}

console.log('\n--- 2f. Phase 13: ルックアップ（§38 参照元の表示 / §39 最終確認 / §40 参照元が読めない / §41 結果 / Rollback）---');
{
  const PLAN_LK = { ...PLAN_X, plan: { ...PLAN_X.plan, missingCapabilities: [], proposedFields: [
    { temporaryId: 'NEW_FIELD_1', label: '顧客住所', suggestedCode: 'customer_address', type: 'SINGLE_LINE_TEXT', typeValid: true, required: false, options: [], reason: 'r', evidenceIds: [E('owner')], alternativeExistingFieldCode: null, codeConflict: false, labelDuplicate: false },
    { temporaryId: 'NEW_FIELD_2', label: '与信枠', suggestedCode: 'customer_credit', type: 'NUMBER', typeValid: true, required: false, options: [], reason: 'r', evidenceIds: [E('owner')], alternativeExistingFieldCode: null, codeConflict: false, labelDuplicate: false },
  ], steps: [
    mkStep('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'SINGLE_LINE_TEXT' }, { title: '顧客住所フィールドを追加' }),
    mkStep('P2', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_2', { fieldType: 'NUMBER' }, { title: '与信枠フィールドを追加' }),
    mkStep('P3', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', { addMappings: [{ relatedField: 'address', field: 'NEW_FIELD_1' }, { relatedField: 'credit', field: 'NEW_FIELD_2' }] }, { title: '顧客マスタ参照で住所と与信枠も取得', dependsOn: ['P1', 'P2'] }),
  ], summary: { steps: 3, invalidSteps: 0, needsConfirmation: 0, proposedFields: 2, questions: 0 } } };
  const m = mount({ planResponse: PLAN_LK });
  await tick(); const h = await runPlan(m);
  assert(h.includes('id="kt-ai-review-crossapp"') && h.includes('✓ 参照元 App 500「顧客マスタ」：フィールド設定を取得済み（revision 21') && h.includes('実行直前にもう一度取得して照合します'), '§38: Review に参照元アプリ（App 500「顧客マスタ」・取得済み・revision）');
  assert(h.includes('✎ ルックアップ「顧客マスタ参照」（customer_lookup）を変更') && h.includes('参照元: App 500「顧客マスタ」 / キー: code（顧客コード）') && h.includes('＋ 取得項目: address（住所） → customer_address（顧客住所）・この計画で追加') && h.includes('＋ 取得項目: credit（与信枠） → customer_credit（与信枠）・この計画で追加'), '§38: 参照元 / キー / 追加する取得項目（この計画で追加）を Review に表示');
  for (const id of ['P1', 'P2', 'P3']) m.panel.decide(id, 'approve');
  const e0 = execHtml(m);
  assert(e0.includes('✓ フィールド追加') && e0.includes('✎ ルックアップ変更') && /承認済み・実行可能[\s\S]*?<b>3 件/.test(e0), 'Executor の件数: フィールド追加 2 / ルックアップ変更 1');
  await click(m, 'kt-ai-exec-start'); await tick();
  const e1 = execHtml(m);
  assert(m.panel.executorState().stage === 'confirm' && e1.includes('id="kt-ai-exec-lookup-confirm"') && e1.includes('⚠ ルックアップを変更します') && e1.includes('参照元アプリの設定・レコードは変更しません。') && e1.includes('P3 ルックアップ「顧客マスタ参照」（customer_lookup）'), '§39: ⚠ ルックアップを変更します / 参照元アプリは変更しない');
  assert(e1.includes('参照元: App 500「顧客マスタ」 / キー: code') && e1.includes('＋ 取得項目: address（住所） → customer_address（この計画で追加）') && e1.includes('＋ 取得項目: credit（与信枠） → customer_credit（この計画で追加）') && e1.includes('既存の取得項目 2 件（code → customer_code, name → case_name）はそのまま') && e1.includes('参照元アプリ「顧客マスタ」の設定は変更しません（フィールド定義は Review 時点と同じ・revision 21）'), '§39: 参照元 / キー / ＋ 取得項目（この計画で追加）/ 既存はそのまま / 参照元の定義は Review 時点と同じ');
  assert(/既存設定の変更[\s\S]*?✎ ルックアップ 1 件/.test(e1) && /追加[\s\S]*?＋ フィールド 2 件/.test(e1) && e1.includes('変更する属性: 取得項目（参照元アプリ・参照キー・既存の取得項目・表示名・必須はそのまま') && e1.includes('検索方法は kintone が管理するため検証の対象外'), '§39: 追加 2 / 既存設定の変更 1・変更する属性・検索方法の注記');
  await click(m, 'kt-ai-exec-go'); await tick(); await tick();
  const ex = m.panel.executorState().execution;
  assert(m.panel.executorState().stage === 'done' && ex.status === 'DONE' && ex.steps.every(s => s.status === 'VERIFIED') && m.mock.st.fields.customer_lookup.lookup.fieldMappings.length === 4 && m.mock.st.fields.customer_lookup.lookup.relatedApp.app === '500', '反映: 3 step VERIFIED・取得項目 4 件・参照元は不変');
  const e2 = execHtml(m);
  assert(e2.includes('✓ 3 件 VERIFIED') && e2.includes('id="kt-ai-exec-lookup-result"') && e2.includes('✓ ルックアップ「顧客マスタ参照」: 取得項目 2 → 4 件。参照元 App 500「顧客マスタ」: 取得元フィールドは存在・参照元のフィールド定義は Review 時点と同じ。検索方法は kintone が管理（検証対象外）') && e2.includes('Simulationとの一致：✓') && e2.includes('ルックアップの依存 customer_lookup:') && hasButton(e2, '変更前の状態に戻す'), '§41: 結果にルックアップの行（取得項目 2 → 4・参照元の確認・検索方法の注記）と再解析の edge');
  // 実機（Phase 13 Case A）: 反映後に判断のセレクトを触ると Executor が idle に戻り、実行結果と「変更前の状態に戻す」が消えた → 反映後は判断を変えても結果を保つ
  m.panel.decide('P2', '');
  assert(m.panel.executorState().stage === 'done' && m.panel.executorState().execution && m.panel.executorState().execution.status === 'DONE' && hasButton(execHtml(m), '変更前の状態に戻す'), '反映後に判断を変えても実行結果と [変更前の状態に戻す] は消えない');
  m.panel.decide('P2', 'approve');
  await click(m, 'kt-ai-exec-rollback-start'); await tick();
  const r1 = execHtml(m);
  assert(m.panel.executorState().stage === 'rollback-confirm' && r1.includes('・ルックアップ変更 1 件') && r1.includes('・フィールド追加 2 件') && r1.includes('実行前のルックアップ設定（取得項目・選択時表示・絞り込み・並び順）に戻す。参照元アプリには触れない') && (() => { const rb1 = r1.slice(r1.indexOf('id="kt-ai-rollback"')); return rb1.indexOf('ルックアップ変更') < rb1.indexOf('フィールドを削除'); })(), 'rollback 確認: ルックアップの復元（先）とフィールド削除（後）（元に戻す確認の中の順）');
  await click(m, 'kt-ai-exec-rollback-go'); await tick(); await tick();
  const r2 = execHtml(m);
  assert(m.panel.executorState().stage === 'rolled-back' && m.panel.executorState().rollback.status === 'ROLLED_BACK_VERIFIED' && r2.includes('動作テスト環境を実行前の状態に戻しました。') && m.mock.st.fields.customer_lookup.lookup.fieldMappings.length === 2 && !m.mock.st.fields.customer_address && !m.mock.st.fields.customer_credit, 'rollback: 取得項目 2 件・追加フィールドなしに戻る');
  await click(m, 'kt-ai-exec-audit-copy'); await tick();
  const audit = JSON.parse(m.copies[m.copies.length - 1]);
  assert(audit.crossApp && audit.crossApp[0].appId === '500' && audit.crossApp[0].reviewed.fieldsHash === audit.crossApp[0].current.fieldsHash && audit.rollback.steps[0].actionType === 'RESTORE_LOOKUP_SETTINGS' && audit.execution.actualAfter.updatedLookups.join() === '顧客マスタ参照', '監査 JSON: crossApp（指紋）・rollback の先頭は RESTORE_LOOKUP_SETTINGS・updatedLookups');
  // §40: 参照元アプリへのアクセス権が無い（Review は読めていたが、実行時に読めない）
  const m2 = mount({ planResponse: PLAN_LK });
  await tick(); await runPlan(m2);
  for (const id of ['P1', 'P2', 'P3']) m2.panel.decide(id, 'approve');
  m2.mock.ctl.relatedUnavailable = '500';
  await click(m2, 'kt-ai-exec-start'); await tick();
  const b1 = execHtml(m2);
  assert(m2.panel.executorState().stage === 'blocked' && b1.includes('P3 顧客マスタ参照で住所と与信枠も取得：<b>実行不可</b>') && b1.includes('顧客マスタのフィールド設定を確認できません。参照元アプリへのアクセス権を確認してください') && b1.includes('[RELATED_APP_SETTINGS_UNAVAILABLE]') && b1.includes('設定は変更していません。'), '§40: 参照元を読めない → 実行不可・「顧客マスタのフィールド設定を確認できません。参照元アプリへのアクセス権を確認してください」');
  // §38: Review 時点で参照元が読めない → 実行不可（推測しない）
  const inputs3 = buildInputs(); inputs3.data.relatedApps['500'] = { appId: '500', name: null, code: null, revision: null, fields: null, error: { code: 'CB_NO02', message: '権限がありません。', status: 403 } };
  const m3 = mount({ planResponse: PLAN_LK, inputs: inputs3 });
  await tick(); const h3 = await runPlan(m3);
  assert(h3.includes('× 参照元 App 500：フィールド設定を確認できません（権限がありません。）。参照元アプリへのアクセス権を確認してください。相手アプリのフィールドは推測しません') && /P3[\s\S]*?× 実行不可/.test(h3), '§38 / §40: Review 時点で参照元が読めない → × 実行不可・推測しない');
}

console.log('\n--- 2g. Phase 14: アプリアクション（§34〜37 コピー先の表示 / 新規 / 既存変更 / 必須項目の警告 / 結果 / Rollback）---');
{
  // 既存アクション「見積を作成」（→ App 311「見積管理」）に備考（secret_memo → note）を追加 ＋ 新規「請求書作成」（コピー先 311・必須の見積日が未転記）
  const PLAN_AA = { ...PLAN_X, plan: { ...PLAN_X.plan, missingCapabilities: [], proposedFields: [], steps: [
    mkStep('P1', 'UPDATE_APP_ACTION', 'APP_ACTION', '見積を作成', { actionMappings: [{ srcType: 'FIELD', srcField: 'secret_memo', destField: 'note' }] }, { title: '見積を作成に備考も転記' }),
    mkStep('P2', 'ADD_APP_ACTION', 'APP_ACTION', '請求書作成', { name: '請求書作成', destApp: '311', actionMappings: [{ srcType: 'FIELD', srcField: 'case_name', destField: 'quote_title' }, { srcType: 'FIELD', srcField: 'amount', destField: 'quote_amount' }, { srcType: 'RECORD_URL', srcField: null, destField: 'source_url' }], entities: ['GROUP:everyone'] }, { title: '請求書作成アクションを追加' }),
  ], summary: { steps: 2, invalidSteps: 0, needsConfirmation: 0, proposedFields: 0, questions: 0 } } };
  const m = mount({ planResponse: PLAN_AA });
  await tick(); const h = await runPlan(m);
  assert(h.includes('id="kt-ai-review-crossapp"') && h.includes('✓ コピー先 App 311「見積管理」：フィールド設定を取得済み（revision 7'), '§35: Review に相手アプリ（コピー先 App 311「見積管理」・取得済み）');
  assert(h.includes('✎ 既存アプリアクション「見積を作成」を変更') && h.includes('コピー先: App 311「見積管理」') && h.includes('＋ 転記: secret_memo（機密メモ） → note（備考）') && h.includes('＋ 新規アプリアクション「請求書作成」') && h.includes('⚠ コピー先の必須項目: 「見積日」 はこのアクションでは値を設定しません'), '§34 / §36 / §37: Review に既存変更 / 新規 / コピー先 / 転記 / 必須項目の行');
  for (const id of ['P1', 'P2']) m.panel.decide(id, 'approve');
  const e0 = execHtml(m);
  assert(e0.includes('✎ アプリアクション変更') && e0.includes('＋ アプリアクション追加') && /承認済み・実行可能[\s\S]*?<b>2 件/.test(e0), 'Executor の件数: アプリアクション変更 1 / 追加 1');
  await click(m, 'kt-ai-exec-start'); await tick();
  const e1 = execHtml(m);
  assert(m.panel.executorState().stage === 'confirm' && e1.includes('id="kt-ai-exec-app-action-confirm"') && e1.includes('⚠ アプリアクションを追加・変更します') && e1.includes('コピー先アプリの設定・レコードは変更しません。'), '§34: ⚠ アプリアクションを追加・変更します / コピー先は変更しない');
  assert(e1.includes('P1 ✎ 既存アプリアクションを変更「見積を作成」') && e1.includes('コピー先: App 311「見積管理」') && e1.includes('＋ 追加する転記: secret_memo（機密メモ） → note（備考）') && e1.includes('既存の転記 2 件（case_name→quote_title, レコードURL→source_url）はそのまま') && e1.includes('コピー先アプリ「見積管理」の設定・レコードは変更しません（フィールド定義は Review 時点と同じ・revision 7）'), '§34 / §35: 既存変更の行（コピー先 / 追加する転記 / 既存はそのまま / コピー先の指紋）');
  assert(e1.includes('P2 ＋ 新規アプリアクション「請求書作成」') && e1.includes('＋ 転記: case_name（案件名） → quote_title（見積件名）') && e1.includes('＋ 転記: レコードURL → source_url（元案件URL）') && e1.includes('利用者: GROUP:everyone') && e1.includes('class="kt-ai-exec-required-warning"') && e1.includes('⚠ コピー先に必須項目があります') && e1.includes('「見積日」（issue_date）') && e1.includes('このアクションでは値を設定しません。作成時に入力・自動設定されるか確認してください。'), '§36 / §37: 新規アクションの行と必須項目の警告（見積日）');
  assert(/既存設定の変更[\s\S]*?✎ アプリアクション 1 件/.test(e1) && /追加[\s\S]*?＋ アプリアクション 1 件/.test(e1) && e1.includes('変更する属性: 転記（名前・コピー先・既存の転記はそのまま') && e1.includes('アプリアクション: Before 1 件 → After 2 件') && e1.includes('他のアクションが bit 単位で保持されたことを反映後に検証します'), '§34: 追加 1 / 既存設定の変更 1・全体置換の注記');
  await click(m, 'kt-ai-exec-go'); await tick(); await tick();
  const ex = m.panel.executorState().execution;
  assert(m.panel.executorState().stage === 'done' && ex.status === 'DONE' && ex.steps.every(s => s.status === 'VERIFIED') && Object.keys(m.mock.st.actions).length === 2 && m.mock.st.actions['見積を作成'].mappings.length === 3 && m.mock.st.actions['請求書作成'].mappings.length === 3 && m.mock.calls.filter(c => c === 'PUT actions').length === 2, '反映: 2 step VERIFIED（PUT 2 回・既存に転記 1 件追加・新規 1 件）');
  const e2 = execHtml(m);
  assert(e2.includes('✓ 2 件 VERIFIED') && e2.includes('id="kt-ai-exec-app-action-result"') && e2.includes('✓ アプリアクション「見積を作成」: 転記 2 → 3 件。コピー先 App 311「見積管理」（変更なし）。他のアクション 0 件はそのまま') && e2.includes('✓ アプリアクション「請求書作成」を追加: 転記 3 件。コピー先 App 311「見積管理」（変更なし）。他のアクション 1 件はそのまま') && e2.includes('Simulationとの一致：✓') && e2.includes('アプリアクションの依存 見積を作成:') && hasButton(e2, '変更前の状態に戻す'), '結果: アプリアクションの行（転記 2 → 3 / 追加 3 件・コピー先・他のアクションはそのまま）と再解析');
  await click(m, 'kt-ai-exec-rollback-start'); await tick();
  const r1 = execHtml(m);
  assert(m.panel.executorState().stage === 'rollback-confirm' && r1.includes('・アプリアクション追加 1 件') && r1.includes('・アプリアクション変更 1 件') && r1.includes('実行前のアプリアクション全体に戻す（追加したアクションは消え、変更した転記 / 利用者 / 利用条件は元に戻る）。コピー先アプリには触れない'), 'rollback 確認: アプリアクション全体の復元');
  await click(m, 'kt-ai-exec-rollback-go'); await tick(); await tick();
  const r2 = execHtml(m);
  assert(m.panel.executorState().stage === 'rolled-back' && m.panel.executorState().rollback.status === 'ROLLED_BACK_VERIFIED' && r2.includes('動作テスト環境を実行前の状態に戻しました。') && Object.keys(m.mock.st.actions).length === 1 && m.mock.st.actions['見積を作成'].mappings.length === 2, 'rollback: 元の 1 件・転記 2 件に戻る');
  await click(m, 'kt-ai-exec-audit-copy'); await tick();
  const audit = JSON.parse(m.copies[m.copies.length - 1]);
  assert(audit.crossApp.every(c => c.appId === '311' && c.role === 'destination') && audit.rollback.steps[0].actionType === 'RESTORE_APP_ACTION_SETTINGS' && audit.execution.actualAfter.addedAppActions.join() === '請求書作成' && audit.execution.actualAfter.updatedAppActions.join() === '見積を作成', '監査 JSON: crossApp（コピー先）・rollback・added / updatedAppActions');
  // コピー先が読めない（実行時）→ 実行不可
  const m2 = mount({ planResponse: PLAN_AA });
  await tick(); await runPlan(m2);
  for (const id of ['P1', 'P2']) m2.panel.decide(id, 'approve');
  m2.mock.ctl.destUnavailable = '311';
  await click(m2, 'kt-ai-exec-start'); await tick();
  const b1 = execHtml(m2);
  assert(m2.panel.executorState().stage === 'blocked' && b1.includes('P1 見積を作成に備考も転記：<b>実行不可</b>') && b1.includes('コピー先アプリへのアクセス権を確認してください') && b1.includes('[DEST_APP_SETTINGS_UNAVAILABLE]'), 'コピー先を読めない → 実行不可（DEST_APP_SETTINGS_UNAVAILABLE）');
}

console.log('\n--- 3. 回帰: Review UI の既存要素は変わらない ---');
{
  const m = mount();
  await tick();
  const h = await runPlan(m);
  assert(h.includes('Toolkit で確認した結果') && h.includes('kt-ai-review-json-copy') && h.includes('kt-ai-review-decisions'), 'Review の表示・Review JSON・判断の集計は従来どおり');
  assert(JSON.stringify(INPUTS.data) === JSON.stringify(FX.makeData()), 'UI 経由でも DATA は変更しない');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
