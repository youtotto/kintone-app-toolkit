// AI Change Planner の UI（mountAiWorkspace のモード切替・変更計画の作成・表示）と KTAiClient.plan / receive
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
const { withDevBase } = require('./helpers/dev-base-fake.js');
const { makeFakeHost } = require('./helpers/fake-dom.js');
const { KTDevBase, KTDeps, KTScan, KTContext, KTAiClient, KTContextUi, mountAiWorkspace } = loadToolkit();
//   簡素化 E（2026-10-16）: Context ペインの［変更計画を作成］（仮案を経ない計画 → 手順ごとの承認 → 反映の入口）は削除した。計画は会話の仮案から作る
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
  registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'], conversation: ['requirements', 'brief', 'stream', 'proposal', 'suggestion', 'adoptQuote', 'itemIds'] }, 'change-planner': { implemented: true, promptVersions: ['1'], revisionModes: ['full', 'patch'], stream: ['reply'], requirementOps: ['decisionRefs'] } } },
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
      const got = KTAiClient.receive('plan', r); return { ...got, requestId: got.requestId || requestId, clientWarnings: [] };
    },
  };
  const session = { status() { return { connected, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const flow = { start: async () => { throw new Error('x'); }, cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false };
  const host = makeFakeHost();
  const copies = [];
  const panel = mountAiWorkspace(host, withDevBase({ KTDevBase }, { getInputs: () => INPUTS, setPreview: () => { }, copyText: async (t) => { copies.push(t); return true; }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: flow }));
  const $ = (id) => host.querySelector(`#${id}`);
  return { host, panel, $, calls, copies, settings };
}

(async () => {
console.log('\n--- 1. KTAiClient: plan envelope / receive ---');
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
  //   2026-10-23（§12.61）: 未知の根拠 ID の除去・存在しない既存資産の invalid は Gateway（validate-plan）の仕事。Toolkit の受け取りは契約の関所だけで、形はそのまま返す
  const thrownP = (r) => { try { KTAiClient.receive('plan', r); return null; } catch (e) { return e.code; } };
  assert(KTAiClient.receive('plan', bad).relevantFields.some(x => x.fieldCode === 'ghost') && thrownP({ ...PLAN_RESPONSE, plan: null }) === 'INVALID_RESPONSE' && thrownP({ ...PLAN_RESPONSE, contractVersion: '2.0' }) === 'UNSUPPORTED_CONTRACT_VERSION', 'receive: AI サービスの形をそのまま返す（根拠 ID・既存資産を読み直さない）。plan 無し / contractVersion 不一致 → AiClientError');
  const cap = KTAiClient.capabilityFromHealth(HEALTH_BOTH);
  const capQa = KTAiClient.capabilityFromHealth(HEALTH_QA_ONLY);
  assert(cap.available && cap.features['change-planner'].available === true && capQa.available && capQa.features['change-planner'].available === false && capQa.features['change-planner'].reason === C.NOT_ENTITLED, 'capability: feature ごとの可否（Q&A のみの契約では planner 不可）');
}

console.log('\n--- 2. UI: mode switch / goal / 無料の生成 ---');
{
  const m = mount();
  await tick();
  assert(m.$('kt-ai-qa-inputs').style.display === 'flex' && m.$('kt-ai-plan-inputs').style.display === 'none' && !m.host.innerHTML.includes('id="kt-ai-plan"') && m.$('kt-ai-ask').style.display === '' && m.panel.mode() === 'qa', '初期はモード「質問する」（Q&A の入力・ボタンのみ。［変更計画を作成］は無い）');
  assert(m.host.innerHTML.includes('質問する') && m.host.innerHTML.includes('変更計画を作る') && m.host.innerHTML.includes('実現したいことを入力'), 'モード切替と goal 入力欄のマークアップ');
  m.panel.setMode('plan');
  assert(m.panel.mode() === 'plan' && m.$('kt-ai-qa-inputs').style.display === 'none' && m.$('kt-ai-plan-inputs').style.display === 'flex' && !m.host.innerHTML.includes('id="kt-ai-plan"') && m.$('kt-ai-ask').style.display === 'none' && m.$('kt-ai-generate').textContent === '変更計画 Prompt を生成' && typeof m.panel.plan === 'undefined', 'mode switch: 変更計画の入力欄・無料の Prompt の生成の文言（有料の［変更計画を作成］と plan() は無い）');
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

console.log('\n--- 3. 計画の表示（会話の計画の右の「計画」と同じ部品 KTContextUi.planHtml・planJson）---');
//   送信前の確認・受信の文言・drawer の扱いは会話の流れのテスト（ai-workspace・ai-flow-redesign）が確かめる
{
  const planN = { ...KTAiClient.receive('plan', PLAN_RESPONSE), clientWarnings: [] };
  //   右の「計画」と同じ呼び方（計画の確認の結果は渡さない。mountAiWorkspace の renderDrawer）
  const h = KTContextUi.planHtml(planN, { data: INPUTS.data, ctx: PCTX });
  assert(h.includes('＋ 新規フィールド') && h.includes('部長承認者') && h.includes('USER_SELECT') && h.includes('kt-ai-new-field') && h.includes('特定する情報がありません'), '新規フィールド提案は目立つ枠（＋ 新規フィールド / 名前 / 種類 / 理由）');
  assert(h.includes('>既存<') && h.includes('>＋ 新規<') && h.includes('>△ 確認必要<') && h.includes('>× 無効<') && h.includes('>↻ 再利用<') && h.includes('>✎ 既存変更<'), '既存 / ＋ 新規 / ✎ 既存変更 / ↻ 再利用 / △ 確認必要 / × 無効 のバッジ（Phase 11 §35）');
  assert(h.includes('<b>P1</b>') && h.includes('<b>P2</b>') && h.includes('<b>P3</b>') && h.includes('依存：P1 の後') && h.includes('依存：P2 の後'), '手順 P1〜P3 と依存関係');
  assert(h.includes('<b>A1</b>') && h.includes('既存「承認者」を再利用') && h.indexOf('<b>P4</b>') > h.indexOf('代替案'), '代替案 A1 の下に P4');
  assert(h.includes(`data-eid="${E_AMOUNT}"`) && h.includes(`data-eid="${E_APPROVER}"`), '根拠チップ（data-eid）');
  assert(h.includes('kt-ai-plan-json-toggle') && h.includes('kt-ai-plan-json-copy') && h.includes('&quot;planVersion&quot;: &quot;1&quot;') && h.includes('AI の返答から Toolkit が外した項目（技術者向け）'), 'JSON view / copy と検証の warnings');
  assert(h.includes('存在しない一覧') && h.includes('既存として参照'), '無効な step は理由付きで表示（黙って消さない）');
  const json = KTContextUi.planJson(planN);
  assert(json.planVersion === '1' && json.steps.length === 5 && json.steps[0].execution.mode === 'PLAN_ONLY' && !('clientWarnings' in json) && !('usage' in json), 'Change Plan JSON（右の「計画」の［JSON をコピー］と同じ部品 planJson）: planVersion / steps / execution');
}

console.log('\n--- 4. UI: Q&A と無料機能は不変（有料の［変更計画を作成］の誤りの文言は、入口ごと削除した）---');
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
  assert(free.copies.length === 1 && free.copies[0].includes('Change Planner Context') && !free.host.innerHTML.includes('id="kt-ai-plan"'), '未接続でも無料の変更計画 Prompt / Markdown は使える（有料の［変更計画を作成］は無い）');
  free.panel.setMode('qa');
  await free.$('kt-ai-generate').dispatch('click'); await free.$('kt-ai-copy-prompt').dispatch('click');
  assert(free.copies.length === 2 && free.copies[1].includes('## Context'), 'Free AI document（Q&A の Prompt）は影響なし');
}

// ---- 段階 C（C3b・契約 16 §8）: 計画の AI の説明（reply）の逐次表示。health の stream に reply があるときだけ ----
console.log('\n--- 段階 C: 計画の reply の SSE ---');
{
  const sse = (events) => events.map(([ev, data]) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  const sseResp = (text, chunks = 1) => {
    const parts = []; const n = Math.max(1, Math.ceil(text.length / chunks)); for (let i = 0; i < text.length; i += n) parts.push(text.slice(i, i + n));
    let k = 0; const enc = new TextEncoder();
    return { status: 200, headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null) }, body: { getReader: () => ({ read: async () => (k < parts.length ? { value: enc.encode(parts[k++]), done: false } : { value: undefined, done: true }) }) }, text: async () => text };
  };
  // 能力: registry.toolkit['change-planner'].stream に 'reply' を含む接続先だけ計画を使える（接続時の 1 回の確認）
  const health = (stream) => ({ ok: true, supportedContractVersions: ['2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'], conversation: ['requirements', 'brief', 'stream', 'proposal', 'suggestion', 'adoptQuote', 'itemIds'] }, 'change-planner': { implemented: true, promptVersions: ['1'], revisionModes: ['full', 'patch'], requirementOps: ['decisionRefs'], ...(stream ? { stream } : {}) } } } });
  const capNew = KTAiClient.capabilityFromHealth(health(['reply'])), capOld = KTAiClient.capabilityFromHealth(health(null));
  assert(JSON.stringify(capNew.features['change-planner'].stream) === '["reply"]' && capNew.features['change-planner'].available === true && capOld.features['change-planner'].available === false && capOld.features['change-planner'].reason === 'CAPABILITY_OUTDATED' && JSON.stringify(capOld.features['change-planner'].lacking) === '["reply"]', `health の stream（reply）を能力として読む。2026-10-23（§12.61）: 無い接続先は接続時の確認で計画を使えない（CAPABILITY_OUTDATED・足りない印）: ${JSON.stringify(capOld.features['change-planner'])}`);
  // SSE: delta は reply の増分 → onText にここまでの全文、done の本文は通常の計画と同じに検証
  const text = ': start\n\n' + sse([['delta', { text: '承認待ちの間だけ' }], ['delta', { text: '金額を編集不可にします。' }]]) + sse([['done', PLAN_RESPONSE]]);
  let sentHeaders = null, sentBody = null; const seen = [];
  const client = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: KTAiClient.createDefaultTransport({ kintoneApi: null, fetchFn: async (url, init) => { sentHeaders = init.headers; sentBody = init.body; return sseResp(text, 5); } }) });
  const p = await client.plan({ ctx: PCTX, requestId: 'pl-s', onText: (t) => seen.push(t) });
  assert(sentHeaders.Accept === 'text/event-stream' && JSON.parse(sentBody).meta.feature === 'change-planner', '計画の依頼に onText があれば Accept: text/event-stream を付けて送る');
  assert(seen.length === 2 && seen[1] === '承認待ちの間だけ金額を編集不可にします。', `届いた reply をここまでの全文として渡す: ${JSON.stringify(seen)}`);
  assert(p.goal === GOAL && p.steps.length === 5, 'done の本文は従来の計画と同じに検証して返す（turn.reply は done の全体で置き換わる）');
  // error イベントは通常のエラー
  const client2 = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: KTAiClient.createDefaultTransport({ kintoneApi: null, fetchFn: async () => sseResp(sse([['delta', { text: '途中' }], ['error', { status: 429, body: JSON.stringify({ ok: false, contractVersion: '2.1', error: { code: 'RATE_LIMITED', message: 'm', requestId: 'e-1', retryAfterSeconds: 5 } }) }]])) }) });
  let err = null; try { await client2.plan({ ctx: PCTX, onText: () => { } }); } catch (e) { err = e; }
  assert(err && err.code === 'RATE_LIMITED' && err.httpStatus === 429, `計画の SSE の error イベントは通常のエラー: ${err && err.code}`);
  // onText が無ければ従来どおり（SSE を求めない）
  let sent3 = null;
  const client3 = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: async (req) => { sent3 = req; return okBody(PLAN_RESPONSE); } });
  const p3 = await client3.plan({ ctx: PCTX });
  assert(p3.steps.length === 5 && !(sent3.headers && sent3.headers.Accept === 'text/event-stream'), 'onText の無い計画は従来の 1 回の応答');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
