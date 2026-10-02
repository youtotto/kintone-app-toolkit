// Change Plan Review の UI（mountAiDocsPanel: 実行前レビュー / step ごとの Toolkit 検証 / Before・After / 競合 / プロセス図 / Review JSON / 判断）
//
// 検証内容（§41）: review summary / safe・review・blocked / Before・After / conflict / Process diff / proposed field /
//   impact mismatch / unsupported action / Review JSON（Executor-ready）/ AI 提案と Toolkit 検証の分離 / 既存 Planner UI・Q&A・Free 回帰
//
// 実行方法: node tests/ai-plan-review-ui.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { makeFakeHost } = require('./helpers/fake-dom.js');
const { KTDeps, KTScan, KTContext, KTAiClient, KTContextUi, KTPlanReview, mountAiDocsPanel } = loadToolkit();
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
  const panel = mountAiDocsPanel(host, { getInputs: () => inputs, setPreview: () => { }, copyText: async (t) => { copies.push(t); return true; }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: flow });
  const $ = (id) => host.querySelector(`#${id}`);
  return { host, panel, $, copies };
}
async function runPlan(m) {
  m.panel.setMode('plan');
  m.$('kt-ai-goal').value = GOAL;
  await m.$('kt-ai-generate').dispatch('click');
  await m.$('kt-ai-plan').dispatch('click'); await tick(); await tick();
  return m.$('kt-ai-plan-result').innerHTML;
}

(async () => {
console.log('\n--- 1. 実行前レビューの表示 ---');
{
  const m = mount();
  await tick();
  const h = await runPlan(m);
  const rev = m.panel.lastReview();
  assert(rev && rev.reviewVersion === '1' && rev.steps.length === 8, 'plan 受信後に KTPlanReview.review が実行される');
  assert(h.includes('実行前レビュー（Toolkit 検証）') && h.includes('安全に追加できる変更') && h.includes('確認が必要') && h.includes('実行不可') && h.includes('計画のみ'), 'review summary: ✓ 安全 / △ 確認 / × 実行不可 / ○ 計画のみ');
  assert(h.includes('追加：') && h.includes('既存変更：') && h.includes('高リスク変更：') && h.includes('競合候補：') && h.includes('確認事項：') && h.includes('無効：'), 'Change Risk Summary は件数で表示');
  const er = rev.executionReadiness;
  assert(er.safeSteps.includes('P1') && er.reviewSteps.includes('P2') && er.reviewSteps.includes('P4') && er.blockedSteps.includes('P7') && er.planOnlySteps.includes('P8'), `safe / review / blocked / plan-only の振り分け（${JSON.stringify(er)}）`);
  assert(h.includes('以下は AI の提案です') && h.includes('Toolkit で確認した結果') && h.indexOf('kt-ai-review-step" data-step="P1"') > h.indexOf('<b>P1</b>'), 'AI 提案と Toolkit 検証を分けて表示（各 step の下に Toolkit の結果）');
  const p4 = h.slice(h.indexOf('data-step="P4"'));
  assert(p4.includes('確認が必要') && p4.includes('Before:') && p4.includes('After:') && p4.includes('amount &lt; &quot;1000000&quot;') && p4.includes('すべて') && p4.includes('実行できます'), 'step UI: 既存アクションの条件変更に Before / After と「現在可能な操作が制限される」注意');
  assert(h.includes('競合・重複の候補') && h.includes('高額案件の登録') && h.includes('高額案件通知') && h.includes('>既存<') && h.includes('>提案<') && h.includes('通知先:'), 'conflict UI: 既存「高額案件の登録」と提案「高額案件通知」を通知先付きで並べる');
  assert(h.includes('プロセス管理の変更前後') && h.includes('class="kt-ai-mermaid" data-side="before"') && h.includes('data-side="after"') && h.includes('部長承認待ち') && h.includes('flowchart LR'), 'Process diff: Before / After の Mermaid（コード表示。mermaid があれば描画）');
  assert(h.includes('kt-ai-new-field') && h.includes('部長承認者') && h.includes('既存の「承認者」') , 'proposed field: 新規フィールド枠と Toolkit の再利用候補の指摘（POSSIBLE_EXISTING_REUSE）');
  assert(h.includes('Planner の影響範囲に JS が含まれていません') || h.includes('PLANNER_IMPACT'), 'impact mismatch: customer_code を参照する JS を Planner が挙げていない');
  const p8 = h.slice(h.indexOf('kt-ai-review-step" data-step="P8"'));
  assert(p8.includes('計画のみ') && p8.includes('対象外'), 'unsupported action（CUSTOMIZATION_REQUIRED）は無視せず「計画のみ」と明示');
  assert(h.includes('kt-ai-review-diff-toggle') && h.includes('kt-ai-review-json-toggle') && h.includes('kt-ai-review-json-copy') && h.includes('kt-ai-review-raw-toggle') && h.includes('検証範囲:'), 'ボタン（変更前後を比較 / Review JSON / Raw Diff）と検証範囲');
  // Before / After トグル・Review JSON
  await m.$('kt-ai-plan-result').dispatch({ type: 'click', target: { id: 'kt-ai-review-diff-toggle' } });
  await m.$('kt-ai-plan-result').dispatch({ type: 'click', target: { id: 'kt-ai-review-diff-toggle' } });
  const dh = h.slice(h.indexOf('id="kt-ai-review-diff"'), h.indexOf('id="kt-ai-review-json"'));
  assert(m.$('kt-ai-review-diff').style.display === '' && dh.includes('＋ 新規フィールド「部長承認者」') && dh.includes('必須: false → true'), '変更前後を比較: 人間が読める差分（変更のある属性だけ）');
  await m.$('kt-ai-plan-result').dispatch({ type: 'click', target: { id: 'kt-ai-review-json-copy' } });
  const out = JSON.parse(m.copies[m.copies.length - 1]);
  assert(out.outputVersion === '1' && out.plan.planVersion === '1' && out.review.reviewVersion === '1' && out.review.steps.every(s => s.stepId) && out.approvedSteps.length === 0 && !out.review.simulation.after, 'Review JSON: { plan, review, approvedSteps: [] }（stepId は安定・After モデルは含めない）');
  // 判断（承認 / 保留 / 却下）
  m.panel.decide('P1', 'approve'); m.panel.decide('P2', 'hold');
  assert(m.panel.reviewOutput().approvedSteps.join() === 'P1', '判断: 承認した step だけ approvedSteps に入る（保存はしない）');
  await m.$('kt-ai-plan-result').dispatch({ type: 'change', target: { dataset: { step: 'P4' }, value: 'reject' } });
  assert(!m.panel.reviewOutput().approvedSteps.includes('P4'), 'select の change で判断を記録');
  assert(JSON.stringify(INPUTS.data) === SNAPSHOT, 'UI 経由でも DATA は変更しない');
}

console.log('\n--- 2. 回帰（Planner UI / Q&A / Free）---');
{
  const m = mount({ planResponse: { ...PLAN_B, plan: { ...PLAN_B.plan, steps: [mkStep('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'USER_SELECT' })] } } });
  await tick();
  const h = await runPlan(m);
  assert(h.includes('変更計画（AI Change Planner）') && h.includes('＋ 新規フィールド') && h.includes('kt-ai-plan-json-toggle') && h.includes('実行前レビュー'), '既存 Planner UI（AI 提案の表示・JSON）は維持されつつレビューが付く');
  assert(m.panel.lastReview().executionReadiness.status === 'REVIEW_REQUIRED' || m.panel.lastReview().executionReadiness.status === 'SAFE', '単純な追加計画は SAFE / REVIEW_REQUIRED');
  // Q&A（質問する）は変わらない
  const qa = mount();
  await tick();
  qa.panel.setMode('qa');
  qa.$('kt-ai-target-type').value = 'app'; await qa.$('kt-ai-target-type').dispatch('change');
  qa.$('kt-ai-question').value = 'このアプリの構造は？';
  await qa.$('kt-ai-generate').dispatch('click');
  await qa.$('kt-ai-copy-prompt').dispatch('click');
  assert(qa.copies.length === 1 && qa.copies[0].includes('## Context') && qa.$('kt-ai-plan-result').style.display === 'none' && qa.panel.lastReview() === null, 'Assistant Q&A / Free AI docs は影響なし（レビューは走らない）');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
