// Preview Executor の UI（mountAiDocsPanel: 実行前レビューの「動作テスト環境へ反映」/ 最終確認 / 進捗 / 結果 / 未対応 / 監査 JSON）
//
// 検証内容（§35）: preview button / confirmation / progress / success / failure / unsupported / verified / simulation mismatch /
//   production deploy button absent / stale / 権限
//
// 実行方法: node tests/ai-plan-executor-ui.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { makeFakeHost } = require('./helpers/fake-dom.js');
const { KTDeps, KTScan, KTContext, KTAiClient, mountAiDocsPanel } = loadToolkit();
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
const clone = (v) => JSON.parse(JSON.stringify(v));
/** 動作テスト環境のモック（tests/ai-plan-executor.test.js と同じ振る舞いの最小版） */
function makeKintoneMock(data, { permission = true } = {}) {
  const st = { fields: clone(data.fields), layout: Object.values(data.fields).map(f => ({ type: 'ROW', fields: [{ type: f.type, code: f.code }] })), views: clone(data.views.views), revision: Number(data.views.revision), prodRevision: Number(data.views.revision) };
  const calls = [];
  const err = (code, message) => Object.assign(new Error(message), { code, message });
  const ctl = { failAddField: null, onWrite: null };
  const api = {
    async getPreviewFields() { calls.push('GET fields'); if (!permission) throw err('CB_NO02', '権限がありません。'); return { properties: clone(st.fields), revision: String(st.revision) }; },
    async getPreviewLayout() { calls.push('GET layout'); return { layout: clone(st.layout), revision: String(st.revision) }; },
    async getPreviewViews() { calls.push('GET views'); return { views: clone(st.views), revision: String(st.revision) }; },
    async getProductionViews() { calls.push('GET prod views'); return { views: clone(data.views.views), revision: String(st.prodRevision) }; },
    async addPreviewFields(app, properties) { calls.push('POST fields'); if (ctl.onWrite) ctl.onWrite('POST fields'); if (ctl.failAddField) throw err('GAIA_IL04', 'モックの失敗'); for (const [code, p] of Object.entries(properties)) { if (st.fields[code]) throw err('GAIA_FC01', '既に存在'); st.fields[code] = clone(p); } st.revision += 1; return { revision: String(st.revision) }; },
    async putPreviewLayout(app, layout) { calls.push('PUT layout'); st.layout = clone(layout); st.revision += 1; return { revision: String(st.revision) }; },
    async putPreviewViews(app, views) { calls.push('PUT views'); if (ctl.onWrite) ctl.onWrite('PUT views'); st.views = Object.fromEntries(Object.entries(views).map(([n, v]) => [n, { id: '9', ...clone(v) }])); st.revision += 1; return { views: {}, revision: String(st.revision) }; },
  };
  return { api, st, calls, ctl };
}
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
  const panel = mountAiDocsPanel(host, { getInputs: () => inputs, setPreview: () => { }, copyText: async (t) => { copies.push(t); return true; }, downloadText: (name, text) => downloads.push({ name, text }), colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: flow, executor: executor === undefined ? { api: mock.api, appId: '341' } : executor });
  const $ = (id) => host.querySelector(`#${id}`);
  return { host, panel, $, copies, downloads, mock };
}
async function runPlan(m) {
  m.panel.setMode('plan');
  m.$('kt-ai-goal').value = GOAL;
  await m.$('kt-ai-generate').dispatch('click');
  await m.$('kt-ai-plan').dispatch('click'); await tick(); await tick();
  return m.$('kt-ai-plan-result').innerHTML;
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
  assert(h.includes('id="kt-ai-exec"'), '実行前レビューの中に Executor ブロックの枠がある');
  const e0 = execHtml(m);
  assert(e0.includes('動作テスト環境への反映') && e0.includes('承認済み・実行可能') && e0.includes('承認済みだが未対応') && e0.includes('実行不可') && /id="kt-ai-exec-start"[^>]*disabled/.test(e0) && e0.includes('承認済みで実行できる step がありません'), '承認が無ければ件数 0 でボタンは押せない');
  assert(hasButton(e0, '動作テスト環境へ反映') && !hasButton(e0, '運用環境へ反映') && !/<button[^>]*>(実行|反映)<\/button>/.test(e0), 'ボタンには必ず「動作テスト環境」と明記（「実行」「反映」だけのボタンは無い）');
  m.panel.decide('P1', 'approve'); m.panel.decide('P2', 'approve'); m.panel.decide('P3', 'approve');
  const e1 = execHtml(m);
  assert(/承認済み・実行可能[\s\S]*?<b>2 件（P1, P2）/.test(e1) && /承認済みだが未対応[\s\S]*?<b>1 件（P3）/.test(e1) && e1.includes('P3') && e1.includes('PLAN_ONLY') && e1.includes('現在の Executor では自動反映できません'), '承認すると「✓ 承認済み・実行可能 2 件 / △ 承認済みだが未対応 1 件」。未対応は無視せず PLAN_ONLY と明示');
  assert(/id="kt-ai-exec-start"(?![^>]*disabled)/.test(e1) && m.mock.calls.length === 0, '実行可能な step があればボタンが有効。ここまで kintone API は呼ばない');
  m.panel.decide('P2', 'hold');
  assert(/承認済み・実行可能[\s\S]*?<b>1 件（P1）/.test(execHtml(m)), '判断を変えると件数が追従する（保留は実行しない）');
  m.panel.decide('P2', 'approve');
  // 最終確認
  await click(m, 'kt-ai-exec-start'); await tick();
  const st = m.panel.executorState();
  const e2 = execHtml(m);
  assert(st.stage === 'confirm' && st.prepared && st.prepared.status === 'PREPARED' && m.mock.calls.every(c => c.startsWith('GET')), 'ボタン押下 → prepare（取得と再検証のみ。書き込みなし）→ 最終確認');
  assert(e2.includes('動作テスト環境へ以下を反映します。') && e2.includes('＋ フィールド追加 1 件') && e2.includes('＋ 一覧追加 1 件') && e2.includes('運用環境には反映されません。') && hasButton(e2, 'キャンセル') && e2.includes('id="kt-ai-exec-go"') && hasButton(e2, '動作テスト環境へ反映'), '最終確認: 反映内容の件数・「運用環境には反映されません。」・キャンセル / 動作テスト環境へ反映');
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
  assert(/P1[\s\S]*VERIFIED[\s\S]*P2[\s\S]*VERIFIED[\s\S]*P3[\s\S]*PLAN_ONLY/.test(e3) && e3.includes('現在の Executor では自動反映できません'), '結果一覧: P1 / P2 VERIFIED・P3 は PLAN_ONLY と表示');
  assert(m.mock.st.fields.progress && m.mock.st.views['担当者別'] && m.mock.st.views['担当者別'].fields.join() === 'owner,case_name,progress', 'モックの動作テスト環境にフィールドと一覧が入った（一覧の NEW_FIELD_1 は実コード）');
  assert(!hasButton(e3, '運用環境へ反映') && !/<button[^>]*>[^<]*deploy/i.test(e3), '完了画面に「運用環境へ反映」ボタンは無い（Never Auto Deploy）');
  assert(e3.includes('再解析：フィールド 24 件（実行前 23）'), '再解析の要約（フィールド数 23 → 24）');
  // 監査 JSON / snapshot / rollback
  await click(m, 'kt-ai-exec-audit-copy');
  const audit = JSON.parse(m.copies[m.copies.length - 1]);
  assert(audit.auditVersion === '1' && audit.goal === GOAL && audit.plan.steps.length === 3 && audit.humanDecisions.P1 === 'approve' && audit.execution.status === 'DONE' && audit.verification.length === 3 && audit.beforeSnapshot.revision === '12' && audit.actualAfter.addedFields.join() === 'progress' && audit.rollbackPlan.steps.length === 2 && audit.rollbackPlan.executed === false, '監査 JSON: goal / plan / review / 判断 / execution / verification / before snapshot / actual after / rollback 計画');
  await click(m, 'kt-ai-exec-audit-download');
  assert(m.downloads.length === 1 && /^toolkit-ai-execution-ex_.*\.json$/.test(m.downloads[0].name) && JSON.parse(m.downloads[0].text).auditVersion === '1', '監査 JSON を保存（ファイル名に executionId）');
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

console.log('\n--- 3. 回帰: Review UI の既存要素は変わらない ---');
{
  const m = mount();
  await tick();
  const h = await runPlan(m);
  assert(h.includes('実行前レビュー（Toolkit 検証）') && h.includes('kt-ai-review-json-copy') && h.includes('kt-ai-review-decisions'), 'Review の表示・Review JSON・判断の集計は従来どおり');
  assert(JSON.stringify(INPUTS.data) === JSON.stringify(FX.makeData()), 'UI 経由でも DATA は変更しない');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
