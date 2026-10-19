// Change Plan Review の表示（右の「変更内容」の要約と［計画の詳細と根拠］: Toolkit の確認 / Before・After / 重なり / プロセス図 / 確かめてほしい指摘 / Executor の入力）
//
// 検証内容（§41）: review summary / safe・review・blocked / Before・After / conflict / Process diff / proposed field /
//   impact mismatch / unsupported action / Executor の入力（Executor-ready）/ AI 提案と Toolkit 検証の分離 / 既存 Planner UI・Q&A・Free 回帰
//
// 実行方法: node tests/ai-plan-review-ui.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { withDevBase } = require('./helpers/dev-base-fake.js');
const { makeFakeHost } = require('./helpers/fake-dom.js');
const { KTDevBase, KTDeps, KTScan, KTContext, KTAiClient, KTContextUi, KTAiChatUi, KTPlanReview, mountAiWorkspace } = loadToolkit();
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
  const panel = mountAiWorkspace(host, withDevBase({ KTDevBase }, { getInputs: () => inputs, setPreview: () => { }, copyText: async (t) => { copies.push(t); return true; }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: flow }));
  const $ = (id) => host.querySelector(`#${id}`);
  return { host, panel, $, copies };
}
// 簡素化 D・E（2026-10-16）: Context ペインの［変更計画を作成］（仮案を経ない計画 → 手順ごとの承認 → 反映の入口）は削除した。
// 2026-10-19: 右の「確認結果」のタブ（KTContextUi.reviewHtml）と［この手順を反映しない］は廃止した。Toolkit が確かめた結果は右の「変更内容」の要約
//   （KTAiChatUi.changeSummaryHtml）、AI の提案の全文は［計画の詳細と根拠］（KTContextUi.planHtml）。ここでは画面と同じ部品を同じ呼び方で使って表示を確かめる
const planOf = (raw) => { const v = KTAiClient.validatePlan(raw, PCTX); return { ...v.normalized, clientWarnings: v.warnings }; };
const LABELS = Object.fromEntries(KTDeps.normalizeFields(INPUTS.data.fields).map(f => [f.code, f.label]));
const summaryHtml = (plan, review) => KTAiChatUi.changeSummaryHtml({ plan, review, ctx: PCTX }, { labels: LABELS });
const detailHtml = (plan) => KTContextUi.planHtml(plan, { data: INPUTS.data, ctx: PCTX });
/** 「何が変わるか」の手順の行（手順の名前で始まる li） */
const rowOf = (h, id) => { const a = h.indexOf(`<li><span>${id} `); return a < 0 ? '' : h.slice(a, h.indexOf('</li>', a)); };
/** 見出しの次の内容（次の見出しまで） */
const secOf = (h, label) => { const a = h.indexOf(`>${label}</div>`); if (a < 0) return ''; const b = h.indexOf('kt-ai-sum-label', a + label.length); return h.slice(a, b < 0 ? h.length : b); };

(async () => {
console.log('\n--- 1. Toolkit が確かめた結果の表示（右の「変更内容」と［計画の詳細と根拠］と同じ部品）---');
{
  const plan = planOf(PLAN_B);
  const rev = KTPlanReview.review({ plan, ...INPUTS });
  const sum = summaryHtml(plan, rev), detail = detailHtml(plan);
  assert(rev && rev.reviewVersion === '1' && rev.steps.length === 8, '計画を Toolkit が確認する（KTPlanReview.review）');
  assert(sum.includes('何が変わるか（Toolkit が確かめた変更前後）') && !sum.includes('安全に追加できる変更') && !sum.includes('AI の説明より優先'), '変更内容: Toolkit が確かめた変更前後（安全区分から別に数えた行と「AI の説明より優先」の包括的な文は出さない）');
  assert(!/追加：\d|既存変更：|高リスク変更：|競合候補：/.test(sum + detail) && typeof rev.summary.counts.highRisk === 'number' && typeof rev.summary.counts.conflicts === 'number', `内部の分類の件数（追加・既存変更・高リスク・競合候補）は画面に出さない（確認のデータと監査 JSON には残る）: ${JSON.stringify(rev.summary.counts)}`);
  const er = rev.executionReadiness;
  assert(er.safeSteps.includes('P1') && er.reviewSteps.includes('P2') && er.reviewSteps.includes('P4') && er.blockedSteps.includes('P7') && er.planOnlySteps.includes('P8'), `safe / review / blocked / plan-only の振り分け（確認のデータ。表示はしない）（${JSON.stringify(er)}）`);
  assert(detail.includes('以下は AI の提案です') && detail.includes('この上の要約にあります') && !detail.includes('kt-ai-sum-check') && !detail.includes('Toolkit で確認した結果'), 'AI の提案（計画の全文）と Toolkit の確認（変更内容の要約）を分ける。計画の全文に確認の結果を併記しない');
  const p4 = rowOf(sum, 'P4');
  assert(p4.includes('Before:') && p4.includes('After:') && p4.includes('amount &lt; &quot;1000000&quot;') && !p4.includes('△'), `既存アクションの条件変更: 手順の行に Before / After と実行される式（反映できない手順の行に「確かめてください」の指摘は重ねない）: ${p4.slice(0, 200)}`);
  const cannot = secOf(sum, '反映できないこと');
  assert(/P4 UPDATE_PROCESS：反映できません（条件式が kintone で評価できない/.test(cannot) && /P7 UPDATE_VIEW：反映できません/.test(cannot), `反映できない手順は「反映できないこと」に理由と一緒に出す: ${cannot.replace(/<[^>]+>/g, ' ').slice(0, 200)}`);
  const p5 = rowOf(sum, 'P5');
  assert(p5.includes('高額案件通知') && p5.includes('通知先:') && p5.includes('△ Toolkit が確かめてほしい点（2 件）') && /既存の通知「高額案件の登録」（通知先 [^<]*?）と同一です/.test(p5), `重なり: 提案「高額案件通知」の行に、既存「高額案件の登録」と通知先を並べる（前は確認結果の競合の欄）: ${p5.slice(0, 300)}`);
  assert(/<details class="kt-ai-tech kt-ai-sum-process"><summary>プロセス管理の変更前後（図）<\/summary>[\s\S]*class="kt-ai-mermaid" data-side="before"[\s\S]*data-side="after"[\s\S]*<\/details>/.test(sum) && sum.includes('部長承認待ち') && sum.includes('flowchart LR'), 'プロセス管理の変更前後: Before / After の Mermaid を変更内容の［プロセス管理の変更前後（図）］の中に出す（前は確認結果。図のラベルには実行される式が入るので通常の文には出さない）');
  assert(detail.includes('kt-ai-new-field') && detail.includes('部長承認者') && rowOf(sum, 'P1').includes('△ Toolkit が確かめてほしい点（1 件）') && rowOf(sum, 'P1').includes('既存の「承認者」で代用できる可能性'), '新規フィールド: 計画の全文に新規フィールドの枠、変更内容の行に Toolkit の再利用候補の指摘（POSSIBLE_EXISTING_REUSE）');
  const p6 = rowOf(sum, 'P6');
  assert(p6.includes('必須: false → true') && p6.includes('△ Toolkit が確かめてほしい点（2 件）') && p6.includes('「顧客コード」を必須に変更します') && p6.includes('Planner の影響範囲に、その JavaScript のファイルが挙がっていません'), `確かめてほしい指摘（必須への変更・影響範囲の食い違い）は手順の行に出す（前は確認結果の手順ごとの判定）: ${p6.slice(0, 300)}`);
  const outside = (x) => x.replace(/<details[\s\S]*?<\/details>/g, '');
  assert(!outside(p6).includes('必須に変更します') && outside(p6).includes('必須: false → true') && !outside(rowOf(sum, 'P5')).includes('1000000&quot;）と同一'), '指摘の文（実行される式・内部の語を含む）は開くと出す。行に見せるのは変更前後と件数の 1 行');
  assert(rowOf(sum, 'P5').includes('と同一です') && rowOf(sum, 'P1').includes('代用できる可能性') && !/kt-ai-sum-notes/.test(sum), '計画全体の注意点のうち、手順の行に出した指摘（同じ手順・同じ種類）は重ねない（この計画ではすべて手順の行）');
  const p8 = rowOf(sum, 'P8');
  assert(p8.includes('計画のみ') && !(sum + detail).includes('コードを作る'), `JavaScript の手順（customization の無い CUSTOMIZATION_REQUIRED）は無視せず「計画のみ」と出す（［コードを作る］は出さない）: ${p8.slice(0, 160)}`);
  assert(/何が変わるか（Toolkit が確かめた変更前後）/.test(sum) && /変更計画（AI の提案）/.test(detail) && !/kt-ai-review-|kt-ai-decision|この手順を反映しない|Review JSON/.test(sum + detail), '確認結果の操作（変更前後を比較・Review JSON・Raw Diff・手順を外す欄）は無い（記録は反映の監査 JSON）');
  assert(rowOf(sum, 'P1').includes('＋ 新規フィールド「部長承認者」') && p6.includes('必須: false → true'), '変更前後: 人間が読める差分（変更のある属性だけ）を手順の行に出す');
  const out = KTPlanReview.executorOutput(plan, rev);
  assert(out.outputVersion === '1' && out.plan.planVersion === '1' && out.review.reviewVersion === '1' && out.review.steps.every(s => s.stepId) && out.approvedSteps.length === 0 && !out.review.simulation.after, 'Executor の入力: { plan, review, approvedSteps: [] }（stepId は安定・After モデルは含めない）');
  //   承認は最終案の 1 回（すべての手順）。反映できない手順は承認した手順に入らない
  const outAll = KTPlanReview.executorOutput(plan, rev, rev.steps.map(s => s.stepId));
  assert(outAll.approvedSteps.length === rev.steps.filter(r => r.safety !== 'BLOCKED').length && !outAll.approvedSteps.includes('P7'), '最終案の承認（すべての手順）: 反映できない手順は最初から承認した手順に入らない');
  assert(KTContextUi.reviewHtml === undefined && KTContextUi.reviewStepHtml === undefined && KTContextUi.decisionSummary === undefined, '確認結果の描画と手順を外す集計の公開口は無い');
  assert(JSON.stringify(INPUTS.data) === SNAPSHOT, '確認と表示で DATA は変更しない');
}

console.log('\n--- 2. 回帰（計画の表示 / Q&A / Free）---');
{
  const plan = planOf({ ...PLAN_B, plan: { ...PLAN_B.plan, steps: [mkStep('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'USER_SELECT' })] } });
  const rev = KTPlanReview.review({ plan, ...INPUTS });
  const sum = summaryHtml(plan, rev), detail = detailHtml(plan);
  assert(detail.includes('変更計画（AI の提案）') && detail.includes('kt-ai-plan-json-toggle') && sum.includes('何が変わるか（Toolkit が確かめた変更前後）') && rowOf(sum, 'P1').includes('＋ 新規フィールド'), '計画の表示（AI 提案の全文・JSON）と Toolkit が確かめた変更前後');
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
