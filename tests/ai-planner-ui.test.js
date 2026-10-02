// AI Change Planner の UI（mountAiDocsPanel のモード切替・変更計画の作成・表示）と KTAiClient.plan / validatePlan
//
// 検証内容（Phase 7 §38）:
//   - mode switch（質問する / 変更計画を作る）/ goal 入力・例プリセット / 無料: 変更計画 Prompt の生成・コピー
//   - loading / result（実現したいこと・現在利用できるもの・追加が必要なもの・変更計画 P1..・影響範囲・確認したいこと・解析できないこと）
//   - 新規フィールドの強調表示 / 既存・新規提案・変更・確認必要・無効のバッジ / 代替案 / 根拠チップ / JSON view・copy
//   - errors（RATE_LIMITED / FEATURE_NOT_ENTITLED / planner 未契約）/ assistant-qa（質問する）は変わらない / 無料機能は影響なし
//   - KTAiClient.plan: envelope（feature change-planner / contextVersion planner-1）、validatePlan（未知根拠ID・存在しない既存の除去）
//
// 実行方法: node tests/ai-planner-ui.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { makeFakeHost } = require('./helpers/fake-dom.js');
const { KTDeps, KTScan, KTContext, KTAiClient, KTContextUi, mountAiDocsPanel } = loadToolkit();
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const { buildScanPayload } = require('./helpers/scan-payload.js');
const C = KTAiClient.ERROR_CODES;

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
const GOAL = '金額が100万円以上なら部長承認を追加して、承認されたら担当者に通知したい';
const PCTX = KTContext.buildPlan({ goal: GOAL, ...INPUTS, options: { now: '2026-10-02T00:00:00.000Z' } });
const eid = (code) => PCTX.facts.find(f => f.kind === 'field' && f.field?.code === code).id;
const E_AMOUNT = eid('amount'), E_OWNER = eid('owner'), E_APPROVER = eid('approver');
const E_STATE = PCTX.facts.find(f => f.kind === 'process-state' && f.state?.name === '承認待ち').id;

const HEALTH_BOTH = {
  ok: true, supportedContractVersions: ['2.0', '2.1'],
  entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner'] }],
  registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'] }, 'change-planner': { implemented: true, promptVersions: ['1'] } } },
  usage: { yyyymm: '202610', monthlyLimit: 100, usedThisMonth: 3, remainingThisMonth: 97 }, contractExpiresAt: '2099-01-01T00:00:00Z', auth: { type: 'access_token' },
};
const HEALTH_QA_ONLY = { ...HEALTH_BOTH, entitlements: [{ product: 'toolkit', features: ['assistant-qa'] }] };
/** Gateway の Change Plan 応答（正規化済みの形。Worker の validate-plan.mjs と同じ構造） */
const PLAN_RESPONSE = {
  ok: true, contractVersion: '2.1',
  meta: { requestId: 'pl-x', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [{ code: 'INVALID_EVIDENCE_REF_REMOVED', path: 'steps[1]', message: '未知の根拠ID を除去しました: E999' }] }, ai: { provider: 'openai', model: 'm' }, usage: { yyyymm: '202610', usedThisMonth: 4, remainingThisMonth: 96, monthlyLimit: 100 } },
  plan: {
    goal: GOAL,
    assessment: { summary: '金額と担当者は存在します。部長承認の作業者を特定する情報はありません。', usableExistingFields: [{ fieldCode: 'amount', note: '承認条件の判定', evidenceIds: [E_AMOUNT] }, { fieldCode: 'owner', note: '通知先', evidenceIds: [E_OWNER] }], usableExistingSettings: [{ kind: 'PROCESS_STATUS', name: '承認待ち', note: '既存の承認ステップ', evidenceIds: [E_STATE] }], missingCapabilities: ['部長を特定するフィールド'], uncertainties: ['承認者が部長を指すかは不明'] },
    relevantFields: [{ fieldCode: 'amount', role: '承認条件', evidenceIds: [E_AMOUNT] }, { fieldCode: 'owner', role: '通知先', evidenceIds: [E_OWNER] }],
    proposedFields: [{ temporaryId: 'NEW_FIELD_1', label: '部長承認者', suggestedCode: 'manager_approver', type: 'USER_SELECT', typeValid: true, required: false, options: [], reason: '現在のフォームには部長承認の作業者を特定する情報がありません', evidenceIds: [E_APPROVER], alternativeExistingFieldCode: 'approver', codeConflict: false, labelDuplicate: false }],
    steps: [
      { id: 'P1', actionType: 'ADD_FIELD', targetKind: 'PROPOSED_FIELD', targetRef: 'NEW_FIELD_1', targetExists: true, title: '部長承認者フィールドを追加', proposal: { summary: 'ユーザー選択フィールドを追加', details: [{ key: 'type', value: 'USER_SELECT' }] }, dependsOn: [], reason: '作業者を特定するため', evidenceIds: [E_APPROVER], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PLAN_ONLY', supported: false, reason: 'Planner MVP では自動変更未実装' } },
      { id: 'P2', actionType: 'ADD_PROCESS_STATUS', targetKind: 'PROCESS_STATUS', targetRef: '部長承認待ち', targetExists: false, title: 'ステータス「部長承認待ち」を追加', proposal: { summary: '作業者 = NEW_FIELD_1', details: [] }, dependsOn: ['P1'], reason: '承認待ちの後に部長承認', evidenceIds: [E_STATE], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' } },
      { id: 'P3', actionType: 'ADD_NOTIFICATION', targetKind: 'NOTIFICATION', targetRef: null, targetExists: null, title: '承認済み通知', proposal: { summary: '完了になったら owner へ通知', details: [{ key: 'target', value: 'owner' }] }, dependsOn: ['P2'], reason: '担当者へ通知', evidenceIds: [E_OWNER], confidence: 'NEEDS_CONFIRMATION', alternativeId: null, validation: { status: 'needs_confirmation', issues: [] }, execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' } },
      { id: 'P4', actionType: 'REUSE_FIELD', targetKind: 'FIELD', targetRef: 'approver', targetExists: true, title: '既存の承認者を使う', proposal: { summary: 'approver を部長に設定', details: [] }, dependsOn: [], reason: '既存で代用', evidenceIds: [E_APPROVER], confidence: 'NEEDS_CONFIRMATION', alternativeId: 'A1', validation: { status: 'needs_confirmation', issues: [] }, execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' } },
      { id: 'P5', actionType: 'UPDATE_VIEW', targetKind: 'VIEW', targetRef: '存在しない一覧', targetExists: false, title: '一覧を変更', proposal: { summary: 'x', details: [] }, dependsOn: [], reason: 'x', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'invalid', issues: ['存在しないVIEW「存在しない一覧」を既存として参照しています'] }, execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' } },
    ],
    alternatives: [{ id: 'A1', title: '既存「承認者」を再利用', summary: '新規フィールドを追加しない案', stepIds: ['P4'] }],
    impact: [{ targetKind: 'FIELD', targetRef: 'amount', description: '通知・一覧・計算式から参照されている', evidenceIds: [E_AMOUNT], confidence: 'CONFIRMED', validation: { status: 'ok' } }],
    questions: [{ id: 'Q1', question: '既存の「承認者」は部長を指定する項目ですか？', reason: '再利用できれば新規フィールドが不要', relatedEvidenceIds: [E_APPROVER] }],
    unknowns: ['プラグイン設定は確認できない'],
    planConfidence: 'NEEDS_CONFIRMATION',
    summary: { steps: 5, invalidSteps: 1, needsConfirmation: 2, proposedFields: 1, questions: 1 },
  },
};
const v2err = (status, code, extra = {}) => ({ status, body: JSON.stringify({ ok: false, contractVersion: '2.1', error: { code, message: 'm', requestId: 'e-1', ...extra } }) });
const okBody = (json) => ({ status: 200, body: JSON.stringify(json) });
const makeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const tick = () => new Promise(r => setTimeout(r, 0));

/** パネル mount（有料側は fake session: client.plan / ask / getHealth を記録） */
function mount({ health = HEALTH_BOTH, planResponses = [], askResponses = [], connected = true } = {}) {
  const storage = makeStorage();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' });
  const calls = { health: 0, plan: [], ask: [] };
  const pq = [...planResponses], aq = [...askResponses];
  const client = {
    async getHealth() { calls.health++; return health; },
    async ask({ ctx, requestId }) { calls.ask.push({ ctx, requestId }); const r = aq.shift(); if (r?.name === 'AiClientError') throw r; return r; },
    async plan({ ctx, requestId }) {
      calls.plan.push({ ctx, requestId });
      const r = pq.shift();
      if (r?.name === 'AiClientError') throw r;
      const v = KTAiClient.validatePlan(r, ctx);
      if (!v.ok) throw new KTAiClient.AiClientError({ code: v.errors[0].code, message: v.errors[0].message, requestId });
      return { ...v.normalized, requestId: v.normalized.requestId || requestId, clientWarnings: v.warnings };
    },
  };
  const session = { status() { return { connected, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const flow = { start: async () => { throw new Error('x'); }, cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false };
  const host = makeFakeHost();
  const copies = [];
  const panel = mountAiDocsPanel(host, { getInputs: () => INPUTS, setPreview: () => { }, copyText: async (t) => { copies.push(t); return true; }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: flow });
  const $ = (id) => host.querySelector(`#${id}`);
  return { host, panel, $, calls, copies, settings };
}

(async () => {
console.log('\n--- 1. KTAiClient: plan envelope / validatePlan ---');
{
  const env = KTAiClient.buildPlanEnvelope({ ctx: PCTX, requestId: 'pl-1', pluginVersion: '9.9.9', now: 'N' });
  assert(env.contractVersion === '2.1' && env.meta.product === 'toolkit' && env.meta.feature === 'change-planner' && env.meta.promptVersion === '1' && env.meta.contextVersion === 'planner-1' && env.payload === PCTX, 'buildPlanEnvelope: toolkit.change-planner / planner-1 / payload は Planner Context そのもの');
  let threw = null; try { KTAiClient.buildPlanEnvelope({ ctx: KTContext.build({ question: 'x', ...INPUTS }) }); } catch (e) { threw = e; }
  assert(threw && threw.code === C.NO_CONTEXT, 'Q&A の Context（goal 無し）では plan envelope を作らない');
  let sent = null;
  const client = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 'tok', hostname: 'h', transport: async (req) => { sent = req; return okBody(PLAN_RESPONSE); } });
  const p = await client.plan({ ctx: PCTX, requestId: 'pl-2' });
  assert(sent.url === 'https://gw.test/v2/review' && JSON.parse(sent.body).meta.feature === 'change-planner' && p.goal === GOAL && p.steps.length === 5 && p.proposedFields.length === 1 && p.requestId === 'pl-x' && p.usage.usedThisMonth === 4, 'client.plan: POST /v2/review（change-planner）→ 検証済み plan');
  const bad = JSON.parse(JSON.stringify(PLAN_RESPONSE));
  bad.plan.relevantFields.push({ fieldCode: 'ghost', role: 'x', evidenceIds: ['E1'] });
  bad.plan.steps[0].evidenceIds = [E_APPROVER, 'E999'];
  bad.plan.steps.push({ ...bad.plan.steps[3], id: 'P6', targetRef: 'ghost2', alternativeId: null, validation: { status: 'ok', issues: [] } });
  const v = KTAiClient.validatePlan(bad, PCTX);
  assert(v.ok && !v.normalized.relevantFields.some(f => f.fieldCode === 'ghost') && v.normalized.steps[0].evidenceIds.join() === E_APPROVER && v.normalized.steps.find(s => s.id === 'P6').validation.status === 'invalid' && v.warnings.length >= 3, 'validatePlan: 未知の根拠ID 除去・存在しない既存フィールド除去・存在しない既存を参照する step は invalid（クライアント側でも検証）');
  assert(KTAiClient.validatePlan({ ...PLAN_RESPONSE, plan: null }, PCTX).ok === false && KTAiClient.validatePlan({ ...PLAN_RESPONSE, contractVersion: '2.0' }, PCTX).ok === false, 'plan 無し / contractVersion 不一致 → NG');
  const cap = KTAiClient.capabilityFromHealth(HEALTH_BOTH);
  const capQa = KTAiClient.capabilityFromHealth(HEALTH_QA_ONLY);
  assert(cap.available && cap.features['change-planner'].available === true && capQa.available && capQa.features['change-planner'].available === false && capQa.features['change-planner'].reason === C.NOT_ENTITLED, 'capability: feature ごとの可否（Q&A のみの契約では planner 不可）');
}

console.log('\n--- 2. UI: mode switch / goal / 無料の生成 ---');
{
  const m = mount();
  await tick();
  assert(m.$('kt-ai-qa-inputs').style.display === 'flex' && m.$('kt-ai-plan-inputs').style.display === 'none' && m.$('kt-ai-plan').style.display === 'none' && m.$('kt-ai-ask').style.display === '' && m.panel.mode() === 'qa', '初期はモード「質問する」（Q&A の入力・ボタンのみ）');
  assert(m.host.innerHTML.includes('質問する') && m.host.innerHTML.includes('変更計画を作る') && m.host.innerHTML.includes('実現したいことを入力'), 'モード切替と goal 入力欄のマークアップ');
  m.panel.setMode('plan');
  assert(m.panel.mode() === 'plan' && m.$('kt-ai-qa-inputs').style.display === 'none' && m.$('kt-ai-plan-inputs').style.display === 'flex' && m.$('kt-ai-plan').style.display === '' && m.$('kt-ai-ask').style.display === 'none' && m.$('kt-ai-generate').textContent === '変更計画 Prompt を生成', 'mode switch: 変更計画の入力欄・「変更計画を作成」ボタン・生成ボタンの文言');
  assert(m.$('kt-ai-plan').disabled === false, 'planner の entitlement があれば「変更計画を作成」が有効');
  // goal 無しで生成 → 案内
  await m.$('kt-ai-generate').dispatch('click');
  assert(m.$('kt-ai-status').textContent.includes('実現したいこと'), 'goal 未入力の案内');
  // 例プリセット → goal
  m.$('kt-ai-goal-preset').value = KTContextUi.PLANNER_PRESETS[1]; await m.$('kt-ai-goal-preset').dispatch('change');
  assert(m.$('kt-ai-goal').value === KTContextUi.PLANNER_PRESETS[1], '例の選択で goal に入る');
  m.$('kt-ai-goal').value = GOAL;
  await m.$('kt-ai-generate').dispatch('click');
  assert(m.$('kt-ai-status').textContent.includes('生成しました') && m.$('kt-ai-actions').style.display === 'flex' && m.$('kt-ai-result').innerHTML.includes('変更計画'), '無料: Planner Context を生成（結果サマリ）');
  await m.$('kt-ai-copy-prompt').dispatch('click');
  await m.$('kt-ai-copy-json').dispatch('click');
  assert(m.copies.length === 2 && m.copies[0].includes('変更計画を作るアシスタント') && m.copies[0].includes(GOAL) && JSON.parse(m.copies[1]).contextVersion === 'planner-1', '無料: 変更計画 Prompt / JSON のコピー（Gateway 不要）');
  const out = m.panel.currentOutput();
  assert(out && out.filename.includes('_plan_'), 'ローカル保存のファイル名に _plan');
  // Q&A に戻すと Q&A の入力・ボタンに戻り、生成結果はクリア
  m.panel.setMode('qa');
  assert(m.panel.mode() === 'qa' && m.$('kt-ai-actions').style.display === 'none' && m.$('kt-ai-generate').textContent === 'AI Prompt を生成', 'Q&A へ戻す');
}

console.log('\n--- 3. UI: 変更計画の作成（loading → result）---');
{
  const m = mount({ planResponses: [PLAN_RESPONSE] });
  await tick();
  m.panel.setMode('plan');
  m.$('kt-ai-goal').value = GOAL;
  await m.$('kt-ai-generate').dispatch('click');
  await m.$('kt-ai-plan').dispatch('click'); await tick();
  assert(m.$('kt-ai-consent').style.display === '' && m.calls.plan.length === 0, '初回は送信前の確認（consent）');
  const clickP = m.$('kt-ai-consent-ok').dispatch('click');
  await tick();
  await clickP; await tick();
  assert(m.calls.plan.length === 1 && m.calls.plan[0].ctx.contextVersion === 'planner-1' && m.calls.plan[0].ctx.goal === GOAL, 'client.plan に Planner Context を渡す');
  assert(m.$('kt-ai-paid-status').textContent.includes('変更計画を受信しました') && m.$('kt-ai-paid-status').textContent.includes('手順 5 件') && m.$('kt-ai-paid-status').textContent.includes('新規フィールド 1 件') && m.$('kt-ai-plan').disabled === false, '受信ステータス（手順・新規フィールド・確認事項の件数）');
  const h = m.$('kt-ai-plan-result').innerHTML;
  assert(m.$('kt-ai-plan-result').style.display === '' && ['実現したいこと', '現在利用できるもの', '追加が必要なもの', '変更計画', '代替案', '影響範囲', '確認したいこと', '解析できないこと'].every(t => h.includes(t)), 'result: 必要な節がすべて表示される');
  assert(h.includes('＋ 新規フィールド') && h.includes('部長承認者') && h.includes('USER_SELECT') && h.includes('kt-ai-new-field') && h.includes('特定する情報がありません'), '新規フィールド提案は目立つ枠（＋ 新規フィールド / 名前 / 種類 / 理由）');
  assert(h.includes('>既存<') && h.includes('>＋ 新規<') && h.includes('>△ 確認必要<') && h.includes('>× 無効<') && h.includes('>↻ 再利用<') && h.includes('>✎ 既存変更<'), '既存 / ＋ 新規 / ✎ 既存変更 / ↻ 再利用 / △ 確認必要 / × 無効 のバッジ（Phase 11 §35）');
  assert(h.includes('<b>P1</b>') && h.includes('<b>P2</b>') && h.includes('<b>P3</b>') && h.includes('依存：P1 の後') && h.includes('依存：P2 の後'), '手順 P1〜P3 と依存関係');
  assert(h.includes('<b>A1</b>') && h.includes('既存「承認者」を再利用') && h.indexOf('<b>P4</b>') > h.indexOf('代替案'), '代替案 A1 の下に P4');
  assert(h.includes(`data-eid="${E_AMOUNT}"`) && h.includes(`data-eid="${E_APPROVER}"`), '根拠チップ（data-eid）');
  assert(h.includes('kt-ai-plan-json-toggle') && h.includes('kt-ai-plan-json-copy') && h.includes('&quot;planVersion&quot;: &quot;1&quot;') && h.includes('検証で除去・調整した項目'), 'JSON view / copy と検証の warnings');
  assert(h.includes('存在しない一覧') && h.includes('既存として参照'), '無効な step は理由付きで表示（黙って消さない）');
  // 根拠チップ → fact 詳細
  const fact = m.panel.showEvidence(E_AMOUNT);
  assert(fact && fact.field.code === 'amount' && m.$('kt-ai-fact-detail').style.display === '', '根拠チップ → Evidence 詳細');
  // JSON copy（delegated click）
  await m.$('kt-ai-plan-result').dispatch({ type: 'click', target: { id: 'kt-ai-plan-json-copy' } });
  const json = JSON.parse(m.copies[m.copies.length - 1]);
  assert(json.planVersion === '1' && json.steps.length === 5 && json.steps[0].execution.mode === 'PLAN_ONLY' && !('clientWarnings' in json) && !('usage' in json), 'Change Plan JSON のコピー（Executor へ渡す形: planVersion / steps / execution）');
  assert(m.panel.lastPlan().goal === GOAL, 'lastPlan');
  // モードを Q&A に戻すと plan の結果は隠れ、戻すと再表示
  m.panel.setMode('qa'); assert(m.$('kt-ai-plan-result').style.display === 'none', 'Q&A モードでは plan 結果を隠す');
  m.panel.setMode('plan'); assert(m.$('kt-ai-plan-result').style.display === '', 'plan モードで再表示');
}

console.log('\n--- 4. UI: errors / entitlement / Q&A と無料機能は不変 ---');
{
  const m = mount({ planResponses: [new KTAiClient.AiClientError({ code: C.RATE_LIMITED, message: 'x', retryAfterSeconds: 42, requestId: 'e-9' })] });
  await tick(); m.settings.setConsent(true);
  m.panel.setMode('plan'); m.$('kt-ai-goal').value = GOAL; await m.$('kt-ai-generate').dispatch('click');
  await m.$('kt-ai-plan').dispatch('click'); await tick();
  assert(m.$('kt-ai-paid-status').textContent.includes('[RATE_LIMITED]') && m.$('kt-ai-paid-status').textContent.includes('約42秒後') && m.$('kt-ai-plan').disabled === false && m.$('kt-ai-plan-result').style.display === 'none', 'RATE_LIMITED: 文言・retryAfter・ボタンは有効のまま');
  const q = mount({ health: HEALTH_QA_ONLY });
  await tick(); q.settings.setConsent(true);
  q.panel.setMode('plan'); q.$('kt-ai-goal').value = GOAL; await q.$('kt-ai-generate').dispatch('click');
  assert(q.$('kt-ai-plan').disabled === true && q.$('kt-ai-ask').disabled === false, 'planner の entitlement が無い: 「変更計画を作成」は無効・「AIに質問」は有効');
  const r = await q.panel.plan();
  assert(r === null && q.$('kt-ai-paid-status').textContent.includes('「変更計画を作る」を利用できません') && q.calls.plan.length === 0, 'planner 未契約で plan() → 文言・送信しない');
  const nc = mount({ planResponses: [PLAN_RESPONSE] });
  await tick(); nc.settings.setConsent(true);
  nc.panel.setMode('plan');
  const r2 = await nc.panel.plan();
  assert(r2 === null && nc.$('kt-ai-paid-status').textContent.includes('先に「変更計画 Prompt を生成」'), 'Context 未生成で plan() → 案内');
  const fe = mount({ planResponses: [new KTAiClient.AiClientError({ code: C.FEATURE_NOT_ENTITLED, message: 'x', requestId: 'e-f' })] });
  await tick(); fe.settings.setConsent(true);
  fe.panel.setMode('plan'); fe.$('kt-ai-goal').value = GOAL; await fe.$('kt-ai-generate').dispatch('click');
  await fe.$('kt-ai-plan').dispatch('click'); await tick();
  assert(fe.$('kt-ai-paid-status').textContent.includes('[FEATURE_NOT_ENTITLED]') && fe.$('kt-ai-plan').disabled === true, 'Gateway が FEATURE_NOT_ENTITLED → 文言・ボタン無効');
}
{
  // assistant-qa（質問する）は従来どおり
  const GOOD_QA = { ok: true, contractVersion: '2.1', meta: { requestId: 'tk-x', usage: { usedThisMonth: 4, monthlyLimit: 100 }, normalization: { warnings: [] } }, answer: '顧客コードはルックアップのコピー先です', answerEvidenceIds: [], facts: [], analysis: [], recommendations: [], unknowns: [] };
  const m = mount({ askResponses: [{ answer: GOOD_QA.answer, facts: [], analysis: [], recommendations: [], unknowns: [], requestId: 'tk-x', usage: GOOD_QA.meta.usage, clientWarnings: [], gatewayWarnings: [] }] });
  await tick(); m.settings.setConsent(true);
  m.$('kt-ai-target-type').value = 'field'; await m.$('kt-ai-target-type').dispatch('change'); m.$('kt-ai-target').value = 'customer_code'; m.$('kt-ai-question').value = '顧客コードを削除して大丈夫？';
  await m.$('kt-ai-generate').dispatch('click');
  await m.$('kt-ai-ask').dispatch('click'); await tick();
  assert(m.calls.ask.length === 1 && m.calls.ask[0].ctx.contextVersion === '1' && m.calls.plan.length === 0 && m.$('kt-ai-answer').style.display === '' && m.$('kt-ai-plan-result').style.display === 'none', 'assistant-qa: 従来の Q&A は変わらない（contextVersion 1・plan は呼ばない）');
  // 無料機能（AI Prompt 生成・コピー）は Gateway 無しでも
  const free = mount({ connected: false });
  await tick();
  free.panel.setMode('plan'); free.$('kt-ai-goal').value = '担当者が設定されたら本人に通知したい';
  await free.$('kt-ai-generate').dispatch('click');
  await free.$('kt-ai-copy-md').dispatch('click');
  assert(free.copies.length === 1 && free.copies[0].includes('Change Planner Context') && free.$('kt-ai-plan').disabled === true, '未接続でも無料の変更計画 Prompt / Markdown は使える（「変更計画を作成」は無効）');
  free.panel.setMode('qa');
  await free.$('kt-ai-generate').dispatch('click'); await free.$('kt-ai-copy-prompt').dispatch('click');
  assert(free.copies.length === 2 && free.copies[1].includes('## Context'), 'Free AI document（Q&A の Prompt）は影響なし');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
