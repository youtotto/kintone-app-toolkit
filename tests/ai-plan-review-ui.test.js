// Change Plan Review の UI（mountAiWorkspace: 実行前レビュー / step ごとの Toolkit 検証 / Before・After / 競合 / プロセス図 / Review JSON / 判断）
//
// 検証内容（§41）: review summary / safe・review・blocked / Before・After / conflict / Process diff / proposed field /
//   impact mismatch / unsupported action / Review JSON（Executor-ready）/ AI 提案と Toolkit 検証の分離 / 既存 Planner UI・Q&A・Free 回帰
//
// 実行方法: node tests/ai-plan-review-ui.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { makeFakeHost } = require('./helpers/fake-dom.js');
const { KTDeps, KTScan, KTContext, KTAiClient, KTContextUi, KTPlanReview, mountAiWorkspace } = loadToolkit();
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
const SNAPSHOT = JSON.stringify(INPUTS.data);
const GOAL = '100万円以上なら部長承認を追加したい';
const PCTX = KTContext.buildPlan({ goal: GOAL, ...INPUTS, options: { now: '2026-10-02T00:00:00.000Z' } });
const E = (code) => PCTX.facts.find(f => f.kind === 'field' && f.field?.code === code).id;
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], ...o });
const mkStep = (id, actionType, targetKind, targetRef, sp, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' }, ...extra });
/** 実機ケース B 相当の Change Plan（AI の提案）*/
const PLAN_B = {
  ok: true, contractVersion: '2.1',
  meta: { requestId: 'pl-b', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm' }, usage: { usedThisMonth: 1, monthlyLimit: 20 } },
  plan: {
    goal: GOAL,
    assessment: { summary: 's', usableExistingFields: [{ fieldCode: 'amount', note: '', evidenceIds: [E('amount')] }], usableExistingSettings: [], missingCapabilities: ['部長承認者'], uncertainties: [] },
    relevantFields: [{ fieldCode: 'amount', role: '判定', evidenceIds: [E('amount')] }],
    proposedFields: [{ temporaryId: 'NEW_FIELD_1', label: '部長承認者', suggestedCode: 'manager_approver', type: 'USER_SELECT', typeValid: true, required: false, options: [], reason: 'r', evidenceIds: [E('approver')], alternativeExistingFieldCode: 'approver', codeConflict: false, labelDuplicate: false }],
    steps: [
      mkStep('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'USER_SELECT' }),
      mkStep('P2', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認待ち', { name: '部長承認待ち', assignees: ['NEW_FIELD_1'] }, { dependsOn: ['P1'] }),
      mkStep('P3', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長へ申請', { name: '部長へ申請', from: '承認待ち', to: '部長承認待ち', filterCond: 'amount >= "1000000"' }, { dependsOn: ['P2'] }),
      mkStep('P4', 'UPDATE_PROCESS', 'PROCESS_ACTION', '承認する', { filterCond: 'amount < "1000000"' }),
      mkStep('P5', 'ADD_NOTIFICATION', 'NOTIFICATION', '高額案件通知', { name: '高額案件通知', targets: ['FIELD_ENTITY:approver', 'FIELD_ENTITY:owner_org', 'USER:user1'], filterCond: 'amount >= "1000000"' }),
      mkStep('P6', 'UPDATE_FIELD', 'FIELD', 'customer_code', { required: true }),
      mkStep('P7', 'UPDATE_VIEW', 'VIEW', '存在しない一覧', { fields: ['case_name'] }),
      mkStep('P8', 'CUSTOMIZATION_REQUIRED', 'JS', null, {}),
    ],
    alternatives: [{ id: 'A1', title: '既存「承認者」を再利用', summary: '', stepIds: [] }],
    impact: [{ targetKind: 'FIELD', targetRef: 'customer_code', description: '一覧から参照', evidenceIds: [], confidence: 'INFERRED', validation: { status: 'ok' } }],
    questions: [{ id: 'Q1', question: '承認者は部長ですか？', reason: '', relatedEvidenceIds: [] }], unknowns: [], planConfidence: 'NEEDS_CONFIRMATION',
    summary: { steps: 8, invalidSteps: 0, needsConfirmation: 0, proposedFields: 1, questions: 1 },
  },
};
const makeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const tick = () => new Promise(r => setTimeout(r, 0));
const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'] }, 'change-planner': { implemented: true, promptVersions: ['1'] } } }, usage: { monthlyLimit: 20, usedThisMonth: 1 } };
function mount({ planResponse = PLAN_B, inputs = INPUTS } = {}) {
  const storage = makeStorage();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' });
  settings.setConsent(true);
  const client = { async getHealth() { return HEALTH; }, async ask() { throw new Error('x'); }, async plan({ ctx, requestId }) { const v = KTAiClient.validatePlan(planResponse, ctx); return { ...v.normalized, requestId, clientWarnings: v.warnings }; } };
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const flow = { start: async () => { throw new Error('x'); }, cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false };
  const host = makeFakeHost();
  const copies = [];
  const panel = mountAiWorkspace(host, { getInputs: () => inputs, setPreview: () => { }, copyText: async (t) => { copies.push(t); return true; }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: flow });
  const $ = (id) => host.querySelector(`#${id}`);
  return { host, panel, $, copies };
}
// 簡素化 D・E（2026-10-16）: Context ペインの［変更計画を作成］（仮案を経ない計画 → 手順ごとの承認 → 反映の入口）は削除した。
//   右の「計画」「確認結果」は会話の計画を同じ部品（KTContextUi.planHtml・reviewHtml）で描くので、ここでは部品を同じ呼び方で使って表示を確かめる。
//   手順ごとの承認・保留は削除し、欄は［この手順を反映しない］だけ（外した手順は最終案の承認の指紋に入る。画面での確認は tests/ai-workspace-ux.test.js）
const planOf = (raw) => { const v = KTAiClient.validatePlan(raw, PCTX); return { ...v.normalized, clientWarnings: v.warnings }; };
const screenHtml = (plan, review, opts = {}) => KTContextUi.planHtml(plan, null, { data: INPUTS.data, ctx: PCTX }) + KTContextUi.reviewHtml(review, plan, opts);

(async () => {
console.log('\n--- 1. 確認結果の表示（右の「計画」「確認結果」と同じ部品）---');
{
  const plan = planOf(PLAN_B);
  const rev = KTPlanReview.review({ plan, ...INPUTS });
  const h = screenHtml(plan, rev);
  assert(rev && rev.reviewVersion === '1' && rev.steps.length === 8, '計画を Toolkit が確認する（KTPlanReview.review）');
  assert(h.includes('Toolkit で確認した結果') && h.includes('動作テスト環境への自動反映') && !h.includes('安全に追加できる変更') && !h.includes('AI の説明より優先'), 'review summary: 反映の件数は反映の分類の 1 か所（安全区分から別に数えた 4 行と「AI の説明より優先」の包括的な文は出さない）');
  assert(h.includes('追加：') && h.includes('既存変更：') && h.includes('高リスク変更：') && h.includes('競合候補：') && h.includes('確認事項：') && h.includes('無効：'), 'Change Risk Summary は件数で表示（［詳しく］の中）');
  const er = rev.executionReadiness;
  assert(er.safeSteps.includes('P1') && er.reviewSteps.includes('P2') && er.reviewSteps.includes('P4') && er.blockedSteps.includes('P7') && er.planOnlySteps.includes('P8'), `safe / review / blocked / plan-only の振り分け（確認結果のデータ。表示はしない）（${JSON.stringify(er)}）`);
  assert(h.includes('以下は AI の提案です') && h.includes('Toolkit で確認した結果') && h.indexOf('kt-ai-review-step" data-step="P1"') > h.indexOf('<b>P1</b>'), 'AI 提案と Toolkit 検証を分けて表示（計画の下に Toolkit の結果）');
  const p4 = h.slice(h.indexOf('kt-ai-review-step" data-step="P4"'));
  assert(p4.includes('内容を確かめてください') && p4.includes('Before:') && p4.includes('After:') && p4.includes('amount &lt; &quot;1000000&quot;') && p4.includes('すべて') && p4.includes('実行できます'), 'step UI: 既存アクションの条件変更に Before / After と「現在可能な操作」（承認は最終案の 1 回なので「確かめてください」）');
  assert(h.includes('競合・重複の候補') && h.includes('高額案件の登録') && h.includes('高額案件通知') && h.includes('>既存<') && h.includes('>提案<') && h.includes('通知先:'), 'conflict UI: 既存「高額案件の登録」と提案「高額案件通知」を通知先付きで並べる');
  assert(h.includes('プロセス管理の変更前後') && h.includes('class="kt-ai-mermaid" data-side="before"') && h.includes('data-side="after"') && h.includes('部長承認待ち') && h.includes('flowchart LR'), 'Process diff: Before / After の Mermaid');
  assert(h.includes('kt-ai-new-field') && h.includes('部長承認者') && h.includes('既存の「承認者」'), 'proposed field: 新規フィールド枠と Toolkit の再利用候補の指摘（POSSIBLE_EXISTING_REUSE）');
  assert(h.includes('Planner の影響範囲に JS が含まれていません') || h.includes('PLANNER_IMPACT'), 'impact mismatch: customer_code を参照する JS を Planner が挙げていない');
  const p8 = h.slice(h.indexOf('kt-ai-review-step" data-step="P8"'));
  assert(p8.includes('反映できません') && !p8.includes('コードを作る'), `JavaScript の手順（customization の無い CUSTOMIZATION_REQUIRED）は無視せず「反映できません」と理由を出す（［コードを作る］は出さない）: ${p8.slice(0, 160)}`);
  assert(h.includes('kt-ai-review-diff-toggle') && h.includes('kt-ai-review-json-toggle') && h.includes('kt-ai-review-json-copy') && h.includes('kt-ai-review-raw-toggle') && h.includes('検証範囲:'), 'ボタン（変更前後を比較 / Review JSON / Raw Diff）と検証範囲');
  const dh = h.slice(h.indexOf('id="kt-ai-review-diff"'), h.indexOf('id="kt-ai-review-json"'));
  assert(dh.includes('＋ 新規フィールド「部長承認者」') && dh.includes('必須: false → true'), '変更前後を比較: 人間が読める差分（変更のある属性だけ）');
  const out = KTPlanReview.executorOutput(plan, rev);
  assert(out.outputVersion === '1' && out.plan.planVersion === '1' && out.review.reviewVersion === '1' && out.review.steps.every(s => s.stepId) && out.approvedSteps.length === 0 && !out.review.simulation.after, 'Review JSON: { plan, review, approvedSteps: [] }（stepId は安定・After モデルは含めない）');
  //   外す指定（簡素化 E）: 外した手順は承認した手順に入らない・確認結果に外した手順と欄の印が出る。承認・保留・未定の集計は出さない
  const outEx = KTPlanReview.executorOutput(plan, rev, rev.steps.map(s => s.stepId).filter(id => id !== 'P4'));
  assert(!outEx.approvedSteps.includes('P4') && outEx.approvedSteps.length === rev.steps.filter(r => r.safety !== 'BLOCKED' && r.stepId !== 'P4').length, '外した手順（P4）は承認した手順に入らない（反映できない手順は最初から入らない）');
  const hx = KTContextUi.reviewHtml(rev, plan, { excluded: ['P4'] });
  const p4x = hx.slice(hx.indexOf('kt-ai-review-step" data-step="P4"'));
  assert(/外した手順: P4/.test(hx) && /type="checkbox" class="kt-ai-decision" data-step="P4" checked/.test(p4x) && !/承認 \d|保留 \d|未定 \d/.test(hx) && !/<option value="approve"/.test(hx), '外した手順を出し、その手順の［この手順を反映しない］に印を付ける（承認・保留・未定の集計と選択は無い）');
  assert(KTContextUi.decisionSummary(rev, []) === '', '外した手順が無ければ何も出さない');
  assert(JSON.stringify(INPUTS.data) === SNAPSHOT, '確認と表示で DATA は変更しない');
}

console.log('\n--- 2. 回帰（計画の表示 / Q&A / Free）---');
{
  const plan = planOf({ ...PLAN_B, plan: { ...PLAN_B.plan, steps: [mkStep('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'USER_SELECT' })] } });
  const rev = KTPlanReview.review({ plan, ...INPUTS });
  const h = screenHtml(plan, rev);
  assert(h.includes('変更計画（AI の提案）') && h.includes('＋ 新規フィールド') && h.includes('kt-ai-plan-json-toggle') && h.includes('Toolkit で確認した結果'), '計画の表示（AI 提案の表示・JSON）と確認結果');
  assert(rev.executionReadiness.status === 'REVIEW_REQUIRED' || rev.executionReadiness.status === 'SAFE', '単純な追加計画は SAFE / REVIEW_REQUIRED');
  // Q&A（質問する）は変わらない
  const qa = mount();
  await tick();
  qa.panel.setMode('qa');
  qa.$('kt-ai-target-type').value = 'app'; await qa.$('kt-ai-target-type').dispatch('change');
  qa.$('kt-ai-question').value = 'このアプリの構造は？';
  await qa.$('kt-ai-generate').dispatch('click');
  await qa.$('kt-ai-copy-prompt').dispatch('click');
  assert(qa.copies.length === 1 && qa.copies[0].includes('## Context') && qa.$('kt-ai-plan-result').style.display === 'none' && qa.panel.lastReview() === null && !qa.host.innerHTML.includes('id="kt-ai-plan"'), 'Assistant Q&A / Free AI docs は影響なし（レビューは走らない。［変更計画を作成］は無い）');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
