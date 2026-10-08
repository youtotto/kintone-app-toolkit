// AI Workspace（Phase 15）: 独立 AI タブ / Templates からの移行 / 会話コントローラ（KTAiConversation）/ 計画のバージョン / 安全性
//
// 検証内容:
//   §39 AI Tab: mount / switch / minimized・expanded / narrow width（CSS）/ free state / connected state / Templates から AI 移行
//   §40 Conversation: ASK / PLAN / REVISE_PLAN / EXPLAIN_PLAN / EXPLAIN_REVIEW / REQUEST_PREVIEW / REQUEST_ROLLBACK / ambiguous / errors / rate limit / retry / cancel
//   §41 Versioning: v1 → revision → v2 / v1 inactive / Executor cannot use v1 / rollback は正しい実行に結び付く
//   §42 Safety: チャットの文章だけでは write 0 件（「実行して」「戻して」）/ Toolkit Review は AI の説明で変わらない
//   C-1 第 3 段（2026-10-08）: 古い確認の流れ（依頼から直接計画・変更案のカード・手順ごとの承認で反映）は削除した。依頼は仮案 → 採用 → 最終案、
//     承認と反映は最終案の［動作テスト環境へ反映］1 回（§0e.1・2026-10-09。承認の欄の準備（書き込みなし）の後に押せる）で、版・説明・反映・元に戻す・安全性をこの流れの上で確かめる
//
// 実行方法: node tests/ai-workspace.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { makeFakeHost, makeFakeDocument } = require('./helpers/fake-dom.js');
const { createNewFlowKit } = require('./helpers/new-flow.js');
const T0 = loadToolkit();
const { KTDeps, KTScan, KTContext, KTAiClient, KTAiConversation, KTAiChatUi, KTPlanReview, mountAiWorkspace, renderCustomize } = T0;
const KIT = createNewFlowKit(T0);
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const { buildScanPayload } = require('./helpers/scan-payload.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');

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
const tick = () => new Promise(r => setTimeout(r, 0));
const ticks = async (n = 4) => { for (let i = 0; i < n; i++) await tick(); };
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], ...o });
const mkStep = (id, actionType, targetKind, targetRef, sp, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' }, ...extra });
const OPTIONS = ['未着手', '進行中', '完了'];
const META = { requestId: 'pl-x', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm' }, usage: { usedThisMonth: 1, monthlyLimit: 20 } };
/** v1: 新規フィールド（更新状況）＋ 一覧 */
const PLAN_V1 = {
  ok: true, contractVersion: '2.1', meta: META,
  plan: {
    goal: GOAL,
    assessment: { summary: '更新状況を表すフィールドが無いので追加します。', usableExistingFields: [], usableExistingSettings: [], missingCapabilities: ['更新状況'], uncertainties: [] },
    relevantFields: [],
    proposedFields: [{ temporaryId: 'NEW_FIELD_1', label: '更新状況', suggestedCode: 'progress', type: 'DROP_DOWN', typeValid: true, required: false, options: OPTIONS, reason: '更新状況を表すフィールドが無いため', evidenceIds: [], alternativeExistingFieldCode: null, codeConflict: false, labelDuplicate: false }],
    steps: [
      mkStep('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'DROP_DOWN', options: OPTIONS }, { title: '更新状況フィールドを追加' }),
      mkStep('P2', 'ADD_VIEW', 'VIEW', '担当者別', { name: '担当者別', fields: ['owner', 'case_name', 'NEW_FIELD_1'], filterCond: 'owner in (LOGINUSER())', sort: 'due_date asc' }, { dependsOn: ['P1'], title: '一覧「担当者別」を追加' }),
    ],
    alternatives: [], impact: [], questions: [{ id: 'Q1', question: '更新状況の選択肢は 3 段階でよいですか', reason: 'goal から決められない', relatedEvidenceIds: [] }], unknowns: [], planConfidence: 'INFERRED',
  },
};
/** v2（修正: 新規フィールドは作らず既存 owner を使う）: 一覧だけ */
const PLAN_V2 = {
  ok: true, contractVersion: '2.1', meta: { ...META, requestId: 'pl-y' },
  plan: {
    goal: GOAL,
    assessment: { summary: '既存の担当者を使い、一覧の追加だけにします。修正: 新規フィールド「更新状況」を外しました。', usableExistingFields: [], usableExistingSettings: [], missingCapabilities: [], uncertainties: [] },
    relevantFields: [], proposedFields: [],
    steps: [
      mkStep('P1', 'REUSE_FIELD', 'FIELD', 'owner', {}, { title: '既存「担当者」を利用' }),
      mkStep('P2', 'ADD_VIEW', 'VIEW', '担当者別', { name: '担当者別', fields: ['owner', 'case_name'], filterCond: 'owner in (LOGINUSER())', sort: 'due_date asc' }, { title: '一覧「担当者別」を追加' }),
    ],
    alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED',
  },
};
//   C-1 第 3 段（2026-10-08）: 接続先は仮案に対応した形（assistant-qa の conversation に proposal）。無い接続先は「接続先が非対応」で計画に進まない（ai-flow-redesign の F 系）
const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'], conversation: ['requirements', 'proposal'] }, 'change-planner': { implemented: true, promptVersions: ['1'] } } }, usage: { monthlyLimit: 20, usedThisMonth: 1 } };
/**
 * 仮案の偽の応答（決めることの無い仮案。依頼の文を実現する動作にする）。
 *   C-1 第 3 段（2026-10-08）: 古い確認の流れ（依頼から直接計画を作る）は削除した。依頼は仮案 →「これで進めて」で採用 → 計画（PLAN_V1）→ 最終案の順
 */
const proposalFor = (utterance, requestId = 'pp-1') => KIT.normalized({ reply: '設定の変更でできます。', intent: 'propose', proposal: { behaviors: [KIT.B(utterance, 'user')], assumptions: [], decisions: [], approach: { standard: ['フィールドと一覧の追加'], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [] } }, requestId);
const makeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
/** 回答（facts の根拠ID は ctx から取る） */
const answerFor = (ctx, text) => ({ ok: true, contractVersion: '2.1', meta: { requestId: 'qa-1', usage: { usedThisMonth: 2, monthlyLimit: 20 }, normalization: { warnings: [] } }, answer: text, facts: ctx.facts.length ? [{ text: 'fact', evidenceIds: [ctx.facts[0].id] }] : [], analysis: [], recommendations: [], unknowns: [] });

/**
 * AI タブを mount する（fake DOM）。client は ctx の形で応答を切り替える（planContext → 説明、revision → v2）
 */
function mount({ paid = true, connected = true, planResponses = null, askError = null, planError = null, askDelay = null, executor = undefined, inputs = INPUTS, consent = true } = {}) {
  const storage = makeStorage();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' });
  if (consent) settings.setConsent(true);
  const calls = { ask: [], plan: [], propose: [], health: 0 };
  const client = {
    async getHealth() { calls.health++; return HEALTH; },
    async propose({ ctx, requestId }) { calls.propose.push({ ctx, requestId }); return proposalFor(ctx.question, requestId || 'pp-1'); },
    async ask({ ctx, requestId, signal }) {
      calls.ask.push({ ctx, requestId, signal });
      if (askDelay) await askDelay(signal);
      if (askError) { const e = typeof askError === 'function' ? askError() : askError; if (e) throw e; }
      const text = ctx.planContext ? (ctx.planContext.kind === 'EXPLAIN_REVIEW' ? '条件の変更を含むため確認が必要と判定されています。実は安全です。' : `${ctx.planContext.plan.steps[0]?.id || 'P1'} は一覧を追加する手順です。`) : 'このフィールドはルックアップのコピー先です。';
      const v = KTAiClient.validateAnswer(answerFor(ctx, text), ctx);
      return { ...v.normalized, requestId: v.normalized.requestId || requestId, clientWarnings: v.warnings };
    },
    async plan({ ctx, requestId, signal }) {
      calls.plan.push({ ctx, requestId, signal });
      if (planError) { const e = typeof planError === 'function' ? planError() : planError; if (e) throw e; }
      const resp = planResponses ? planResponses(ctx) : (ctx.revision ? PLAN_V2 : PLAN_V1);
      const v = KTAiClient.validatePlan(resp, ctx);
      return { ...v.normalized, requestId, clientWarnings: v.warnings };
    },
  };
  let isConnected = connected;
  const session = { status() { return { connected: isConnected, apiBase: 'https://gw.test', refreshExpiresAt: isConnected ? '2099-01-01T00:00:00Z' : null, scope: isConnected ? { product: 'toolkit', feature: 'assistant-qa,change-planner', domain: 't.cybozu.com' } : null }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { isConnected = false; return { revoked: true }; }, client };
  const flow = { start: async () => { isConnected = true; return {}; }, cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false };
  const host = makeFakeHost();
  const copies = [], downloads = [];
  const mock = makeKintoneMock(inputs.data);
  const panel = mountAiWorkspace(host, {
    getInputs: () => inputs, copyText: async (t) => { copies.push(t); return true; }, downloadText: (name, text) => downloads.push({ name, text }), colors: { border: '#ccc', bg: '#fff' },
    ...(paid ? { settings, session, hostname: 't.cybozu.com', connectFlow: flow } : {}),
    executor: executor === undefined ? { api: mock.api, appId: '341' } : executor,
  });
  const $ = (id) => host.querySelector(`#${id}`);
  return { host, panel, $, calls, copies, downloads, mock, session, settings, conv: () => panel.conversation(), chat: () => $('kt-ai-chat').innerHTML, msgs: () => panel.conversation().state.messages, types: () => panel.conversation().state.messages.map(m => m.type) };
}
const clickChat = (m, act, extra = {}) => m.$('kt-ai-chat').dispatch({ type: 'click', target: { dataset: { act, ...extra } } });
// 2026-10-06: 反映の操作（#kt-ai-exec の中のボタン）は右下の右の「反映」（#kt-ai-pane-exec）でクリックを受け付ける
const clickExec = (m, id) => m.$('kt-ai-pane-exec').dispatch({ type: 'click', target: { id } });
const writes = (m) => m.mock.calls.filter(c => !c.startsWith('GET'));
/** 画面: 依頼 → 仮案 →「これで進めて」で採用 → 計画 → 最終案（C-1 第 3 段: 従来の m.panel.send(依頼) の置き換え） */
async function adoptScreen(m, goal = GOAL) { await m.panel.send(goal); await ticks(6); await m.panel.send('これで進めて'); await ticks(10); return m.conv().activePlan(); }
/**
 * 画面: 承認の欄の準備（書き込みなし）が終わるのを待って、最終案のカードの［動作テスト環境へ反映］を 1 回押す（§0e.1: 承認と反映を 1 回で行う。承認できない最終案は押せない）。
 *   返す: 押す前のボタン・承認の欄の準備、押した後の結果（finalRun）・書き込み・結果のカード（tests/helpers/new-flow.js の applyOnScreen）
 */
const applyScreen = (m) => KIT.applyOnScreen(m);

(async () => {
// =========================================================
console.log('\n--- 1. KTAiConversation.classifyIntent（決定的規則） ---');
{
  const I = KTAiConversation.INTENT;
  const noPlan = {};
  const v1 = { planId: 'p1', version: 1, status: 'ACTIVE', plan: PLAN_V1.plan, review: { steps: [] } };
  const withPlan = { activePlan: v1, activeReview: { review: v1.review } };
  const withExec = { ...withPlan, activeExecution: { executionId: 'ex1', written: true, rolledBack: false } };
  const cls = (t, st = noPlan) => KTAiConversation.classifyIntent(t, st).intent;
  // ASK（Planner は起動しない）
  assert(cls('このフィールドは何に使ってる？') === I.ASK && cls('このフィールドは何に使ってる？', withPlan) === I.ASK, 'ASK: 現在の設定の質問（計画があっても ASK）');
  assert(cls('承認者フィールドはどこで使われていますか') === I.ASK && cls('このアプリの構造を教えて') === I.ASK && cls('顧客コード') === I.ASK, 'ASK: 質問形・単語だけ（既定は Q&A。計画は作らない）');
  // PLAN
  assert(cls('100万円以上なら部長承認を追加したい') === I.PLAN && cls('契約終了30日前に担当者へ通知したい') === I.PLAN && cls('顧客マスタから住所と電話番号も取って') === I.PLAN && cls('この案件から請求アプリに備考も転記したい') === I.PLAN, 'PLAN: 実現したいこと（4 シナリオの 1 文目）');
  // REVISE（計画があるとき）
  assert(cls('新しい承認者は作らず既存の承認者を使って', withPlan) === I.REVISE_PLAN && cls('住所は既存の顧客住所を使って', withPlan) === I.REVISE_PLAN && cls('既存の請求書作成を使って', withPlan) === I.REVISE_PLAN && cls('通知はいらない', withPlan) === I.REVISE_PLAN && cls('既存の承認者を使えない？', withPlan) === I.REVISE_PLAN, 'REVISE_PLAN: 既存の X を使って / いらない / 使えない？（計画がある）');
  assert(cls('更新状況は3段階ではなく5段階にして', withPlan) === I.REVISE_PLAN, 'REVISE_PLAN: 計画の語（新規フィールドのラベル）に触れる');
  assert(cls('新しい承認者は作らず既存の承認者を使って') === I.PLAN, '計画が無ければ「既存の…を使って」は新しい計画');
  // EXPLAIN
  assert(cls('P1って何してる？', withPlan) === I.EXPLAIN_PLAN && cls('なぜこのフィールドが必要？', withPlan) === I.EXPLAIN_PLAN && cls('P2 の理由を教えて', withPlan) === I.EXPLAIN_PLAN, 'EXPLAIN_PLAN: P3って何してる？ / なぜこのフィールドが必要？');
  assert(cls('何でこれ危ないの？', withPlan) === I.EXPLAIN_REVIEW && cls('なぜ確認が必要なの？', withPlan) === I.EXPLAIN_REVIEW && cls('どうして実行不可なの', withPlan) === I.EXPLAIN_REVIEW, 'EXPLAIN_REVIEW: 危ない / 確認が必要 / 実行不可 の理由');
  assert(cls('なぜこのフィールドが必要？') === I.ASK, '計画が無ければ EXPLAIN にならない（質問として扱う）');
  // REQUEST_PREVIEW（承認にはならない。意図の認識だけ）
  for (const t of ['これで進めたい', '動作テストして', 'Previewに反映して', '全部承認', 'そのまま実行', 'いいから反映して', '実行して']) assert(cls(t, withPlan) === I.REQUEST_PREVIEW, `REQUEST_PREVIEW: 「${t}」`);
  assert(cls('これで進めたい') === I.GENERAL && KTAiConversation.classifyIntent('これで進めたい', noPlan).reason === 'NO_PLAN', '計画が無ければ進めるものがない（GENERAL / NO_PLAN）');
  // REQUEST_ROLLBACK
  assert(cls('やっぱり元に戻して', withExec) === I.REQUEST_ROLLBACK && cls('戻して', withExec) === I.REQUEST_ROLLBACK && cls('ロールバックして', withExec) === I.REQUEST_ROLLBACK, 'REQUEST_ROLLBACK: 反映済みの実行がある');
  assert(cls('元に戻して', withPlan) === I.GENERAL && KTAiConversation.classifyIntent('元に戻して', withPlan).reason === 'NO_EXECUTION', '反映していなければ戻すものがない（GENERAL / NO_EXECUTION）');
  // 曖昧
  assert(cls('これどう？', withPlan) === I.AMBIGUOUS && (KTAiConversation.classifyIntent('これどう？', withPlan).choices || []).includes(I.EXPLAIN_PLAN), 'AMBIGUOUS: 「これどう？」は何を指すか聞く（選択肢に計画の説明）');
  // 2026-10-05 第 3 段で変更: 計画があるときの新しい要望は、聞き返さずに計画の AI に読ませる（要件として追加し、計画の更新・返答を 1 回の応答で返す。
  //   以前は「修正か新規か」を聞き返し、言い回しによっては指示が落ちた）。計画は AI が返した要件の操作と差分で変わり、kintone には何も書き込まない
  assert(cls('契約終了30日前に担当者へ通知したい', withPlan) === I.REVISE_PLAN && KTAiConversation.classifyIntent('契約終了30日前に担当者へ通知したい', withPlan).reason === 'TURN', '計画があるときの新しい要望は、聞き返さずに計画の AI へ（TURN）');
  assert(cls('ありがとう') === I.GENERAL && cls('') === I.GENERAL, 'GENERAL: 挨拶・空');
  // 実行済みの計画
  const executed = { activePlan: { ...v1, status: 'EXECUTED' } };
  // Phase 21（実機 §2）: 反映済みの計画の後は、修正の文・計画の語に触れる依頼も新しい計画（以前は REVISE →「改めて入力」→ 入れ直しても同じ判定で先へ進めなかった）
  assert(cls('通知はいらない', executed) === I.PLAN && KTAiConversation.classifyIntent('通知はいらない', executed).reason === 'NEW_PLAN_AFTER_EXECUTION', '反映済みの計画への「修正だけ」の文は新しい計画（基準は反映後の動作テスト環境）');
  assert(cls('顧客マスタから住所と電話番号も取って', executed) === I.PLAN && cls('顧客マスタから住所と電話番号も取って', { activePlan: { ...v1, status: 'ROLLED_BACK' } }) === I.PLAN, '反映済み / 戻し済みの計画のあとの新しい要望は新しい計画（実機: 「〜も取って」が修正扱いになっていた）');
  assert(KTAiConversation.planTerms(PLAN_V1.plan).includes('更新状況') && KTAiConversation.planTerms(PLAN_V1.plan).includes('担当者別'), 'planTerms: 新規フィールドのラベル・手順の対象');
}

// =========================================================
console.log('\n--- 2. KTAiConversation.create（fake services。履歴は送らない）---');
//   C-1 第 3 段（2026-10-08）: 古い確認の流れ（依頼から直接計画を作る・変更案のカード・確認のカード）は削除した。
//   依頼は仮案（services.propose）→「これで進めて」で採用 → 計画（services.plan）→ 最終案。版・説明・反映の写し・元に戻す・エラーは、この流れの上で確かめる
{
  const log = [], proposeLog = [];
  const pctx = KTContext.buildPlan({ goal: GOAL, ...INPUTS, options: { now: '2026-10-02T00:00:00.000Z' } });
  const planOf = (resp, ctx) => KTAiClient.validatePlan(resp, ctx).normalized;
  const services = {
    conversationFeatures: () => ['requirements', 'proposal'],
    async propose(args) { proposeLog.push(args.utterance); return { ok: true, proposal: proposalFor(args.utterance), ctx: { facts: [] }, perf: {} }; },
    async ask({ question }) { log.push(['ask', question]); return { ok: true, answer: { answer: 'A', facts: [], analysis: [], recommendations: [], unknowns: [] }, ctx: { facts: [] } }; },
    async plan({ goal, revision }) { log.push(['plan', goal, revision ? revision.request : null]); const ctx = revision ? KTContext.buildPlan({ goal, ...INPUTS, options: { revision } }) : pctx; const p = planOf(revision ? PLAN_V2 : PLAN_V1, ctx); return { plan: p, ctx, review: KTPlanReview.review({ plan: p, ...INPUTS }) }; },
    async explain({ question, kind, plan, version }) { log.push(['explain', question, kind, version]); return { answer: `explain ${plan.steps.length}`, facts: [], analysis: [], recommendations: [], unknowns: [] }; },
    readiness(v) { return { approved: 0, executable: 0, unsupported: 0, blocked: 0, undecided: v.plan.steps.length }; },
  };
  const c = KTAiConversation.create({ services, now: () => '2026-10-02T00:00:00.000Z' });
  let changes = 0; c.onChange(() => changes++);
  const r1 = await c.send('このフィールドは何に使ってる？');
  assert(r1.intent === 'ASK' && log[0][0] === 'ask' && c.messages().map(m => m.type).join() === 'USER,ANSWER' && c.activePlan() === null, 'ASK → services.ask → USER / ANSWER。計画は作らない');
  assert(changes > 0 && c.messages().every(m => m.id && m.at === '2026-10-02T00:00:00.000Z' && ['user', 'assistant', 'toolkit', 'system'].includes(m.role)), 'メッセージは { id, type, role, text, at, data }（文字列だけではない）');
  const r2p = await c.send(GOAL);
  const r2 = await c.send('これで進めて');
  const v1 = c.activePlan();
  assert(r2p.intent === 'PROPOSE' && proposeLog.join() === GOAL && r2.intent === 'ADOPT_DRAFT' && log[1][0] === 'plan' && log[1][1].split('\n')[0] === GOAL && /採用した方針: /.test(log[1][1]) && !log[1][2], 'PLAN → 仮案（services.propose）→ 採用 → services.plan（goal の 1 行目は依頼。採用した方針を添える。revision 無し）');
  assert(v1 && v1.version === 1 && v1.basedOnVersion === null && v1.status === 'ACTIVE' && v1.plan.steps.length === 2 && v1.review && v1.goal === GOAL && v1.revisionRequest === null && v1.fromDraft, 'v1: { planId, version 1, basedOnVersion null, goal, revisionRequest null, review }（仮案から作った版）');
  //   変更案のカード（PLAN）・Toolkit の確認（REVIEW）・確認の要約（review-summary）は削除した（ai-flow-redesign の F5-1）。版ごとのカードは最終案（FINAL）1 枚
  assert(c.messages().map(m => m.type).slice(2).join() === 'USER,DRAFT,USER,ASSISTANT_TEXT,FINAL' && !c.messages().some(m => ['PLAN', 'REVIEW'].includes(m.type) || ['plan-summary', 'review-summary'].includes(m.data?.kind)), '仮案 → 採用 → 最終案のカード 1 枚（変更案・確認のカードは出さない）');
  const r3 = await c.send('新しい承認者は作らず既存の承認者を使って');
  const v2 = c.activePlan();
  assert(r3.intent === 'REVISE_PLAN' && log[2][0] === 'plan' && log[2][1] === GOAL && log[2][2] === '新しい承認者は作らず既存の承認者を使って', 'REVISE_PLAN → services.plan（同じ goal ＋ revision.request）。旧 JSON の patch ではなく再計画');
  assert(v2.version === 2 && v2.basedOnVersion === 1 && v2.planId === v1.planId && v2.revisionRequest === '新しい承認者は作らず既存の承認者を使って' && v2.status === 'ACTIVE' && v1.status === 'SUPERSEDED' && v2.plan.steps[0].actionType === 'REUSE_FIELD', 'v2: version 2 / basedOnVersion 1 / 同じ planId / v1 は SUPERSEDED');
  assert(c.planHistory().length === 2 && c.messages().filter(m => m.type === 'FINAL').map(m => m.data.version).join() === '1,2', '履歴 2 版・最終案のカードは版ごと（「変更案を直しました。」の要約の文は削除。版の番号は会話に出さない）');
  const r4 = await c.send('P1って何してる？');
  assert(r4.intent === 'EXPLAIN_PLAN' && log[3][0] === 'explain' && log[3][2] === 'EXPLAIN_PLAN' && log[3][3] === 2 && c.activePlan() === v2 && c.planHistory().length === 2, 'EXPLAIN_PLAN → services.explain（最新版）。計画は変わらない（版も増えない）');
  const r5 = await c.send('何でこれ危ないの？');
  assert(r5.intent === 'EXPLAIN_REVIEW' && log[4][2] === 'EXPLAIN_REVIEW' && c.messages()[c.messages().length - 1].type === 'ANSWER' && c.messages()[c.messages().length - 1].data.kind === 'EXPLAIN_REVIEW', 'EXPLAIN_REVIEW → services.explain（kind EXPLAIN_REVIEW）→ ANSWER');
  const n = log.length;
  //   最終案の流れでは、反映は最終案の承認の後だけ（承認の前は承認へ案内する。ai-flow-redesign の F10-1）
  const r6a = await c.send('これで進めたい');
  assert(r6a.intent === 'REQUEST_PREVIEW' && log.length === n && c.messages()[c.messages().length - 1].data.kind === 'preview-needs-approval' && c.activePlan().status === 'ACTIVE', 'REQUEST_PREVIEW（最終案の承認の前）→ AI 呼び出し無し・承認への案内（反映の準備はしない）');
  assert(c.approveFinal({ planId: v2.planId, version: v2.version }).ok, '最終案を承認する（承認は画面のボタンだけ。会話の文では承認しない）');
  const r6 = await c.send('これで進めたい');
  const lastM = c.messages()[c.messages().length - 1];
  assert(r6.intent === 'REQUEST_PREVIEW' && log.length === n && lastM.role === 'toolkit' && lastM.data.kind === 'preview-approved' && lastM.data.version === 2 && !c.messages().some(x => x.data && x.data.kind === 'preview-ready'), 'REQUEST_PREVIEW（承認の後）→ AI 呼び出し無し・承認済みの最終案は結果の場所を案内するだけ（§0e.1: 反映は最終案のカードの［動作テスト環境へ反映］1 回。手順ごとの準備の件数のカードは出さない）');
  const r7 = await c.send('全部承認');
  assert(r7.intent === 'REQUEST_PREVIEW' && c.activePlan().status === 'ACTIVE' && log.length === n, '「全部承認」は意図の認識だけ（計画の状態も AI 呼び出しも変わらない）');
  const r8 = await c.send('元に戻して');
  assert(r8.intent === 'GENERAL' && r8.reason === 'NO_EXECUTION' && /元に戻せる反映はありません/.test(c.messages()[c.messages().length - 1].text), '反映していないときの「元に戻して」は案内だけ');
  const r9 = await c.send('これどう？');
  assert(r9.intent === 'AMBIGUOUS' && c.messages()[c.messages().length - 1].data.kind === 'choices' && c.messages()[c.messages().length - 1].data.choices.length >= 2, 'AMBIGUOUS → 選択肢（計画は変えない）');
  const r10 = await c.send('これどう？', { intentOverride: 'EXPLAIN_PLAN' });
  assert(r10.intent === 'EXPLAIN_PLAN' && r10.reason === 'USER_CHOICE' && log[log.length - 1][0] === 'explain', '選択肢を選ぶと、その intent で送る');
  // 実行の写し（KTPlanExecutor の状態を渡すだけ）
  const exec = { stage: 'running', prepared: { executionId: 'ex_1', steps: [{ stepId: 'P2', actionType: 'ADD_VIEW', status: 'PENDING' }] }, execution: { executionId: 'ex_1', status: 'RUNNING', steps: [{ stepId: 'P2', actionType: 'ADD_VIEW', status: 'RUNNING' }] } };
  c.noteExecution({ stage: 'preparing', prepared: exec.prepared, execution: null });
  assert(!c.messages().some(m => m.type === 'EXECUTION'), 'prepare / 最終確認の段階では会話に出さない（まだ書いていない）');
  c.noteExecution(exec);
  assert(c.messages().filter(m => m.type === 'EXECUTION').length === 1 && c.state.activeExecution.executionId === 'ex_1' && c.state.activeExecution.planId === v2.planId && c.state.activeExecution.version === 2 && v2.executionId === 'ex_1', 'running → EXECUTION メッセージ 1 件（実行は最新版 v2 に結び付く）');
  c.noteExecution({ ...exec, stage: 'running' });
  assert(c.messages().filter(m => m.type === 'EXECUTION').length === 1, '同じ executionId では増えない');
  c.noteExecution({ ...exec, stage: 'done', execution: { executionId: 'ex_1', status: 'DONE', steps: [{ stepId: 'P2', actionType: 'ADD_VIEW', status: 'VERIFIED' }], reanalysis: { available: true, after: { fields: 23, edges: 10 } } } });
  assert(v2.status === 'EXECUTED' && c.messages()[c.messages().length - 1].type === 'SYSTEM_NOTICE' && /動作テスト環境の設定が変更されました/.test(c.messages()[c.messages().length - 1].text) && /再解析/.test(c.messages()[c.messages().length - 1].text), 'done → SYSTEM_NOTICE「動作テスト環境の設定が変更されました」＋再解析・計画は EXECUTED');
  const r11 = await c.send('やっぱり元に戻して');
  assert(r11.intent === 'REQUEST_ROLLBACK' && c.messages()[c.messages().length - 1].data.kind === 'rollback-ready' && c.messages()[c.messages().length - 1].data.executionId === 'ex_1', 'REQUEST_ROLLBACK → 「変更前の状態へ戻せます」（即 Rollback しない）');
  const r12 = await c.send('通知はいらない');
  //   反映済みの計画の後の依頼は、新しい依頼として仮案から作る（C-1 第 3 段。計画の AI でその計画を直さない）
  assert(r12.intent === 'PROPOSE' && r12.reason === 'NEW_REQUEST_NEW_PLAN_AFTER_EXECUTION' && proposeLog[proposeLog.length - 1] === '通知はいらない' && log.filter(l => l[0] === 'plan').length === 2 && c.planHistory().length === 2 && v2.status === 'EXECUTED' && c.draft() && c.draft().status === 'open', '反映済みの計画は修正しない: 新しい依頼として仮案から作る（旧計画は EXECUTED のまま・計画の AI は呼ばない）');
  //   「反映済みです。この依頼は新しい計画として作ります（基準は今の動作テスト環境…）」と何を基準にするかを先に伝える（kind 'new-plan-after-execution'）。
  //   C-1 第 3 段: この知らせは仮案の入口で出す（新しい依頼として仮案から作るとき）
  assert(c.messages().some(m => m.data && m.data.kind === 'new-plan-after-execution' && /反映済み/.test(m.text) && /新しい計画として作ります/.test(m.text)), '反映済みの計画の後の依頼: 何を基準にするか（反映後の動作テスト環境）を先に伝える');
  c.noteExecution({ stage: 'rollback-confirm', prepared: exec.prepared, execution: exec.execution, rollback: { status: 'PREPARED', steps: [] } });
  c.noteExecution({ stage: 'rolled-back', prepared: exec.prepared, execution: exec.execution, rollback: { status: 'ROLLED_BACK_VERIFIED', steps: [{ stepId: 'R1', status: 'ROLLBACK_VERIFIED' }] } });
  assert(c.messages().filter(m => m.type === 'ROLLBACK').length === 1 && v2.status === 'ROLLED_BACK' && c.state.activeExecution.rolledBack === true && /変更前の状態に戻しました/.test(c.messages()[c.messages().length - 1].text), 'rollback → ROLLBACK メッセージ 1 件・rolled-back → 計画は ROLLED_BACK・通知');
  const r13 = await c.send('元に戻して');
  assert(r13.reason === 'NO_EXECUTION', '戻した後は戻すものがない');
  // エラー / キャンセル
  const failing = KTAiConversation.create({ services: { ...services, async ask() { throw new KTAiClient.AiClientError({ code: 'RATE_LIMITED', message: 'x', retryAfterSeconds: 42, requestId: 'e-1' }); } } });
  const fr = await failing.send('何に使ってる？');
  const em = failing.messages()[failing.messages().length - 1];
  assert(fr.ok === false && fr.error.code === 'RATE_LIMITED' && em.type === 'ERROR' && em.data.code === 'RATE_LIMITED' && em.data.retryable === true && em.data.retryAfterSeconds === 42 && em.data.retryText === '何に使ってる？' && !failing.messages().some(m => m.type === 'LOADING'), 'RATE_LIMITED → ERROR（retryable・retryAfter・再試行の文を保持）。LOADING は消える');
  const cancelling = KTAiConversation.create({ services: { ...services, async ask({ signal }) { return new Promise((_, rej) => { signal.addEventListener('abort', () => rej(new KTAiClient.AiClientError({ code: 'CANCELLED', message: 'c' }))); }); } } });
  const ac = new AbortController();
  const pending = cancelling.send('何に使ってる？', { signal: ac.signal });
  await tick();
  assert(cancelling.isBusy() && cancelling.messages()[cancelling.messages().length - 1].type === 'LOADING' && cancelling.messages()[cancelling.messages().length - 1].text === '確認しています...', 'loading: ASK は「確認しています...」');
  ac.abort();
  const cr = await pending;
  assert(cr.cancelled === true && cancelling.messages()[cancelling.messages().length - 1].type === 'SYSTEM_NOTICE' && /キャンセルしました/.test(cancelling.messages()[cancelling.messages().length - 1].text) && cancelling.messages()[cancelling.messages().length - 1].data.text === '何に使ってる？', 'キャンセル → SYSTEM_NOTICE（入力を保持）');
  // 上限
  const small = KTAiConversation.create({ services, maxMessages: 6 });
  for (let i = 0; i < 5; i++) await small.send(`質問${i}？`);
  assert(small.messages().length === 6 && small.state.dropped === 4, 'メッセージ上限（古いものから外し、件数を記録）');
  //   loading 文言: 従来の「現在の設定を確認し、変更計画を作っています...」「変更計画を見直しています...」は、最終案の流れの進みの 1 枚カードに置き換えた
  //   （ai-flow-redesign の C3b-1・C3b-13）
  const slow = KTAiConversation.create({ services: { ...services, plan: (p) => new Promise(r => setTimeout(() => r(services.plan(p)), 5)) } });
  await slow.send(GOAL);
  const sp = slow.send('これで進めて'); await tick();
  assert(slow.messages()[slow.messages().length - 1].text === '最終案を作っています' && slow.messages()[slow.messages().length - 1].data?.kind === 'progress', 'loading: 採用の後は進みの 1 枚カード「最終案を作っています」');
  await sp;
  const sp2 = slow.send('通知はいらない'); await tick();
  assert(slow.messages()[slow.messages().length - 1].text === '最終案を直しています' && slow.messages()[slow.messages().length - 1].data?.kind === 'progress', 'loading: 最終案の修正は進みの 1 枚カード「最終案を直しています」');
  await sp2;
}

// =========================================================
console.log('\n--- 3. AI タブ（mountRoot / switch / minimized / 旧 Templates からの移行。Phase 18: Templates タブは無い）---');
{
  const { doc, byId } = makeFakeDocument();
  const T = loadToolkit({ document: doc });
  const wrap = T.mountRoot();
  assert(wrap.ktTabs && wrap.ktTabs.TABS.includes('ai') && wrap.ktTabs.TABS[wrap.ktTabs.TABS.length - 1] === 'ai', 'TABS に ai（トップレベルの独立タブ）');
  const tabAi = byId.get('tab-ai'), viewAi = byId.get('view-ai');
  assert(tabAi && tabAi.tagName === 'BUTTON' && viewAi && viewAi.style.display === 'none' && viewAi.classList.contains('kt-fill-view') && /開発支援/.test(tabAi.title) && /変更計画/.test(tabAi.title), '開発支援タブのボタンと view（初期は非表示・高さ追従の view。Phase 19: 表示名「開発支援」）');
  assert(wrap.innerHTML.includes('>開発支援</button>') && !wrap.innerHTML.includes('>AI</button>') && !wrap.innerHTML.includes('>Templates</button>') && !wrap.ktTabs.TABS.includes('templates') && !byId.has('tab-templates') && !byId.has('view-templates'), 'タブ列に AI はあり Templates は無い（Phase 18: 廃止）');
  let switched = null; wrap.ktTabs.onSwitch((id) => { switched = id; });
  await tabAi.dispatch('click');
  assert(viewAi.style.display === 'block' && tabAi.classList.contains('active') && byId.get('view-health').style.display === 'none' && !byId.get('tab-health').classList.contains('active') && switched === 'ai', 'switch: AI タブで view-ai を表示・他を隠す・onSwitch が呼ばれる');
  await byId.get('tab-customize').dispatch('click');
  assert(viewAi.style.display === 'none' && byId.get('view-customize').style.display === 'block', 'switch: 戻せる（Customize）');
  await byId.get('kt-mini').dispatch('click');
  assert(wrap.classList.contains('is-mini'), 'minimized: is-mini（body / tabs は CSS で隠れる）');
  await byId.get('kt-mini').dispatch('click');
  assert(!wrap.classList.contains('is-mini'), 'expanded: 戻る');
  assert(/#kt-toolkit\.is-mini \.body\{ display:none/.test(wrap.innerHTML) && /@media \(max-width: 760px\)/.test(wrap.innerHTML), 'mini の CSS と狭い幅の CSS が root にある');
  // 全画面のときだけ文字を少し大きく（zoom は .is-full:not(.is-mini) の bar / body だけ。#kt-zoom は全画面でだけ見える）
  assert(/#kt-toolkit\.is-full:not\(\.is-mini\) > \.body \{ zoom: var\(--kt-full-zoom, 1\.1\); \}/.test(wrap.innerHTML) && /#kt-toolkit:not\(\.is-full\) #kt-zoom, #kt-toolkit\.is-mini #kt-zoom \{ display: none !important; \}/.test(wrap.innerHTML), '全画面の文字サイズ: zoom の CSS（既定 110%・パネル表示 / 最小化では等倍・ボタンは全画面だけ）');
  const zoomBtn = byId.get('kt-zoom');
  assert(zoomBtn && zoomBtn.textContent === '文字 110%' && wrap.ktZoom.get() === 1.1, '#kt-zoom: 既定 110%');
  await zoomBtn.dispatch('click');
  assert(zoomBtn.textContent === '文字 120%' && wrap.ktZoom.get() === 1.2, '#kt-zoom: 押すと 120%');
  await zoomBtn.dispatch('click'); await zoomBtn.dispatch('click');
  assert(zoomBtn.textContent === '文字 100%' && wrap.ktZoom.get() === 1, '#kt-zoom: 130% → 100%（等倍に戻せる）');
  await zoomBtn.dispatch('click');
  assert(zoomBtn.textContent === '文字 110%', '#kt-zoom: 100% の次は 110%（巡回）');
  await byId.get('kt-full').dispatch('click');
  assert(wrap.classList.contains('is-full'), '全画面: is-full（zoom は CSS で bar / body に効く）');
  await byId.get('kt-full').dispatch('click');
  assert(!wrap.classList.contains('is-full'), '全画面: 戻る');
  // Phase 18: Customize 側に AI mode・GitHub の Snippets は無い（Customize は登録済みコードの確認・解析と AI への相談だけ）
  const src = renderCustomize.toString();
  assert(!src.includes('value="ai"') && !src.includes('mountAiWorkspace') && !src.includes('api.github.com') && !src.includes('Snippets') && src.includes('kt-customize-consult'), 'Customize: AI mode / GitHub Snippets は無く、［AIに相談］だけが AI への導線');
  // AI タブ側に移行済みの機能（最低限の一覧）
  const m = mount();
  await ticks();
  const html = m.host.innerHTML;
  const MIGRATED = { 'AI Prompt': 'kt-ai-copy-prompt', Markdown: 'kt-ai-copy-md', JSON: 'kt-ai-copy-json', Connection: 'kt-ai-connect-start', Assistant: 'kt-ai-ask', Planner: 'kt-ai-plan', Review: 'kt-ai-plan-result', Executor: 'kt-ai-pane-plan', Rollback: 'kt-ai-pane-plan', Composer: 'kt-ai-input' };
  assert(Object.values(MIGRATED).every(id => html.includes(`id="${id}"`)), `移行一覧: ${Object.keys(MIGRATED).join(' / ')} の要素が AI タブにある`);
  await adoptScreen(m);
  const plan = m.$('kt-ai-plan-result').innerHTML;
  assert(!plan.includes('id="kt-ai-review"') && m.$('kt-ai-review-result').innerHTML.includes('id="kt-ai-review"') && /動作テスト環境への反映/.test(m.$('kt-ai-exec').innerHTML) && m.$('kt-ai-exec').innerHTML.includes('kt-ai-apply-note') && m.$('kt-ai-exec-empty').style.display === 'none', '2026-10-06: 「変更内容」は AI の提案だけ。Toolkit で確認した結果は右の「確認結果」、動作テスト環境への反映は右のタブ「反映」（§0e.1: 最終案の流れでは、反映の操作は最終案のカードの［動作テスト環境へ反映］）');
  assert(html.includes(KTContextUi_INTRO()) , '無料の説明文（KTContextUi.INTRO_TEXT）も AI タブに移行');
  function KTContextUi_INTRO() { return loadToolkit().KTContextUi.INTRO_TEXT.slice(0, 20); }
}

// =========================================================
console.log('\n--- 4. AI Workspace: free / connected / responsive / header ---');
{
  const f = mount({ paid: false });
  const free = f.$('kt-ai-free');
  assert(free.style.display === '' && /この環境では AI の会話を使えません/.test(free.innerHTML) && free.innerHTML.length < 300, 'free state（接続機能なし）: AI の会話を使えないことを短く案内する');
  assert(!free.innerHTML.includes('kt-ai-free-connect') && f.$('kt-ai-send').disabled === true && f.$('kt-ai-paid').style.display === 'none', 'free state（接続機能なし）: 接続ボタン無し・composer 無効・接続ペイン無し');
  // 無料パネルの［AI用Promptを生成］は出さない（2026-10-06）。接続機能の無い環境では、右の「Context」のタブから開く
  assert(!/kt-ai-free-generate/.test(free.innerHTML), '無料パネルに［AI用Promptを生成］は出さない');
  await f.$('kt-ai-drawer-tabs').dispatch({ type: 'click', target: { dataset: { pane: 'context' } } });
  assert(f.panel.drawerState().open && f.panel.drawerState().pane === 'context', '接続機能の無い環境: 右の「Context」のタブで開く');
  f.$('kt-ai-target-type').value = 'app'; f.$('kt-ai-question').value = 'このアプリの構造は？';
  await f.$('kt-ai-generate').dispatch('click');
  await f.$('kt-ai-copy-prompt').dispatch('click'); await f.$('kt-ai-copy-md').dispatch('click'); await f.$('kt-ai-copy-json').dispatch('click');
  assert(f.copies.length === 3 && f.copies[0].includes('## Context') && JSON.parse(f.copies[2]).contextVersion === '1' && f.$('kt-ai-preview').textContent.includes('## Context') && f.$('kt-ai-download').disabled === false, '無料機能: AI Prompt / Markdown / JSON のコピー・内蔵プレビュー・保存ボタン（Templates のエディタに依存しない）');
  await f.$('kt-ai-download').dispatch('click');
  assert(f.downloads.length === 1 && /^ai-context_app\d+_prompt\.md$/.test(f.downloads[0].name), '保存: ファイル名は従来どおり');
  // 未接続（接続機能あり）
  const u = mount({ connected: false });
  await ticks();
  assert(u.$('kt-ai-free').style.display === '' && u.$('kt-ai-free').innerHTML.includes('id="kt-ai-free-connect"') && /接続していません/.test(u.$('kt-ai-free').innerHTML) && u.$('kt-ai-send').disabled === true && u.$('kt-ai-input').disabled === false && /Nest Rec AI に接続すると送れます/.test(u.$('kt-ai-composer-note').textContent), 'free state（未接続）: 短い案内と［接続する］・送信は接続後（入力欄は書ける）');
  assert(u.calls.health === 0, '未接続なら health を呼ばない');
  await u.$('kt-ai-free').dispatch({ type: 'click', target: { id: 'kt-ai-free-connect' } }); await ticks();
  assert(u.session.status().connected && u.$('kt-ai-free').style.display === 'none' && u.$('kt-ai-send').disabled === false && u.msgs().some(m => m.type === 'SYSTEM_NOTICE' && /接続しました/.test(m.text)), '[Nest Rec AIに接続] → 接続フロー → 接続済み: 無料パネルが消え composer 有効・通知');
  // 接続済み
  const c = mount();
  await ticks();
  assert(c.$('kt-ai-free').style.display === 'none' && c.$('kt-ai-send').disabled === false && c.$('kt-ai-input').disabled === false && /Enter で送信/.test(c.$('kt-ai-composer-note').textContent), 'connected state: composer 有効（Enter で送信）');
  // 2026-10-06（利用者の指示）: 通常の入口は会話の履歴・入力欄・送信だけ。会話の方式・例の発言・模擬応答・計測を出さない。［新しい会話］は 1 か所。
  //   接続できる環境の通常の画面に「Context」のタブを出さない。何も選ばずに、開いた直後の入力をそのまま送れる（実 AI の会話）
  { const h = c.host.innerHTML;
    assert(!/会話の方式|例の発言|模擬応答|kt-ai-agent-bar|data-pane="dev"/.test(h + c.$('kt-ai-drawer-tabs').innerHTML) && (h.match(/>新しい会話</g) || []).length === 1, '通常の入口: 会話の方式・例の発言・模擬応答・開発者の画面が無い・［新しい会話］は 1 か所');
    // 2026-10-07: 右のタブは 変更内容・コード・確認結果・反映（主）と 詳細情報・接続（控えめ）。"btn" クラスは付かない
    const tabs = c.$('kt-ai-drawer-tabs').innerHTML;
    const tabOf = (p) => (new RegExp(`<button[^>]*data-pane="${p}"[^>]*>([^<]*)`).exec(tabs) || [])[0] || '';
    assert(/data-pane="context"[^>]*style="display:none;"/.test(tabs) && !/data-pane="(plan|review|code|exec|evidence|connection)"[^>]*display:none/.test(tabs) && /data-pane="exec"[^>]*>反映</.test(tabs) && !/class="btn/.test(tabs)
      && /変更内容$/.test(tabOf('plan')) && /コード$/.test(tabOf('code')) && /確認結果$/.test(tabOf('review')) && /詳細情報$/.test(tabOf('evidence')) && /接続$/.test(tabOf('connection'))
      && ['plan', 'code', 'review', 'exec'].every(p => /class="kt-ai-dtab(?: active)?"/.test(tabOf(p))) && ['evidence', 'connection'].every(p => /is-quiet/.test(tabOf(p))), '通常の入口: 右は 変更内容・コード・確認結果・反映（と控えめな 詳細情報・接続）。「Context」のタブは出さない');
    const c2 = mount(); await ticks();
    await c2.panel.send('このフィールドは何に使ってる？'); await ticks();
    assert(c2.calls.ask.length === 1 && c2.msgs().some(m => m.type === 'USER' && /何に使ってる/.test(m.text)), '何も選ばずに、自分の言葉をそのまま送れる（実 AI の会話）'); }
  { const h = c.host.innerHTML; const i = (t) => h.indexOf(t);
    assert(i('id="kt-ai-pane-context"') > 0 && i('id="kt-ai-pane-context"') < i('id="kt-ai-generate"') && i('id="kt-ai-generate"') < i('id="kt-ai-pane-connection"') && i('id="kt-ai-pane-connection"') < i('id="kt-ai-connect-start"') && i('id="kt-ai-pane-plan"') < i('id="kt-ai-plan-result"') && i('id="kt-ai-plan-result"') < i('id="kt-ai-pane-evidence"'), '無料出力は Context ペイン・接続は接続ペイン・計画の全文は「変更内容」ペイン（削除していない）');
    // 2026-10-06: 「変更内容」= 対象の JS・空の案内・要約・実装の内容・<details> の中の計画の全文。右の「反映」（#kt-ai-pane-exec）は内容の領域の外（右下）・反映の記録は 'log' ペイン
    assert(i('id="kt-ai-pane-plan"') < i('id="kt-ai-subject-info"') && i('id="kt-ai-subject-info"') < i('id="kt-ai-pane-plan-empty"') && i('id="kt-ai-pane-plan-empty"') < i('id="kt-ai-change-summary"') && i('id="kt-ai-change-summary"') < i('id="kt-ai-spec"') && i('id="kt-ai-spec"') < i('<details id="kt-ai-plan-detail"') && i('<details id="kt-ai-plan-detail"') < i('id="kt-ai-plan-result"') && i('id="kt-ai-plan-result"') < i('id="kt-ai-pane-review"'), '「変更内容」ペイン: 相談中の JS・空の案内・変更内容の要約・実装の内容・［計画の詳細と根拠］の中の計画の全文');
    assert(i('id="kt-ai-right-body"') < i('id="kt-ai-pane-log"') && i('id="kt-ai-pane-log"') < i('id="kt-ai-apply-log"') && /id="kt-ai-pane-exec" class="kt-ai-pane"/.test(h) && i('id="kt-ai-right-body"') < i('id="kt-ai-pane-exec"') && i('id="kt-ai-pane-exec"') < i('id="kt-ai-exec"') && i('id="kt-ai-exec"') < i('id="kt-ai-jsreg"') && c.$('kt-ai-pane-exec').style.display === 'none', '右のタブ「反映」（#kt-ai-pane-exec）は内容の領域の中で #kt-ai-exec・#kt-ai-jsreg を持つ（初期は「変更内容」のタブなので隠れている）・反映の記録は #kt-ai-pane-log の中');
    assert(/id="kt-ai-split" class="kt-ai-split" role="separator"/.test(h) && i('class="kt-ai-ws-main"') < i('id="kt-ai-split"') && i('id="kt-ai-split"') < i('id="kt-ai-drawer"') && /<b>会話<\/b><button id="kt-ai-new-conv"/.test(h) && /<b>現在の作業内容<\/b><span id="kt-ai-ws-state"/.test(h), '画面: 左＝「会話」と［新しい会話］・右＝「現在の作業内容」・間に幅を変える境目（role=separator）'); }
  // ヘッダー（2026-10-06）: 開発支援・アプリ名（App ID）・反映先（動作テスト環境。運用環境は変えない）・AI の接続のボタン。「解析 ✓ JavaScript ✓ AI ✓」の並びは無い。件数は［詳細］に
  const header = c.$('kt-ai-header').innerHTML;
  assert(/開発支援/.test(header) && new RegExp(`案件管理（App ${FX.SELF_APP}）`).test(header) && /反映先：<b>動作テスト環境<\/b>（運用環境は変更しません）/.test(header) && /id="kt-ai-header-status"[^>]*data-act="open-connection"[^>]*>AI 接続済み</.test(header)
    && !/解析<\/span> ✓|JavaScript<\/span> ✓|AI<\/span> ✓/.test(header) && !/今回の変更の基準|revision/.test(header) && !/Fields<\/span>/.test(header) && /フィールド 23/.test(header), 'ヘッダー（2026-10-06）: 開発支援 / 案件管理（App 341）/ 反映先：動作テスト環境（運用環境は変更しません）/ ［AI 接続済み］。件数は「詳細」に');
  // 作業の基準（baseHtml）: 「HH:MM 取得・運用環境との差 N 件」［差分を見る］［再取得］。取得できないときは止めていることを書く。「今回の変更の基準」「revision」の語は出さない
  { const conn = { paidEnabled: true, connected: true, available: true };
    const okBase = { ok: true, loadedAt: '2026-10-06T01:23:00.000Z', revision: { preview: 12, production: 11 }, diff: { available: true, items: [{ change: 'CHANGED', message: '一覧「担当者別」' }] }, errors: [], files: [] };
    const hb = KTAiChatUi.headerHtml({ app: { id: '341', name: '案件管理' }, connection: conn, base: okBase });
    assert(/反映先：<b>動作テスト環境<\/b>（運用環境は変更しません）｜<span id="kt-ai-base"/.test(hb) && /\d{1,2}:\d{2} 取得・運用環境との差 1 件/.test(hb) && /data-act="open-base-diff"[^>]*>差分を見る</.test(hb) && /data-act="refresh-base"[^>]*>再取得</.test(hb) && !/今回の変更の基準|revision/.test(hb), 'ヘッダーの作業の基準: 「HH:MM 取得・運用環境との差 1 件」［差分を見る］［再取得］（「今回の変更の基準」「revision」の語は出さない）');
    const hbErr = KTAiChatUi.headerHtml({ app: { id: '341', name: '案件管理' }, connection: conn, base: { ok: false, message: '権限がありません' } });
    assert(/動作テスト環境の設定を取得できませんでした（権限がありません）。変更案・コードの作成と反映は止めています（運用環境の設定では進めません）。/.test(hbErr) && /data-act="refresh-base"/.test(hbErr), 'ヘッダーの作業の基準: 取得できないときは、変更案・コードの作成と反映を止めていることを書く（運用環境の設定では進めない）');
    const hbFree = KTAiChatUi.headerHtml({ app: { id: '341', name: '案件管理' }, connection: { paidEnabled: false } });
    assert(!/反映先：/.test(hbFree) && !/kt-ai-header-status/.test(hbFree), '接続機能の無い環境のヘッダーには反映先と AI の接続を出さない'); }
  // ［詳細］の開閉（描き直しても保つ）
  const detailOpen = () => /id="kt-ai-header-detail" style="flex:/.test(c.$('kt-ai-header').innerHTML) && /id="kt-ai-header-toggle"[^>]*aria-expanded="true"/.test(c.$('kt-ai-header').innerHTML);
  assert(/id="kt-ai-header-detail" style="display:none;/.test(header) && /id="kt-ai-header-toggle"[^>]*aria-expanded="false"/.test(header), 'ヘッダーの詳細は展開式（初期は閉）');
  await c.$('kt-ai-header').dispatch({ type: 'click', target: { id: 'kt-ai-header-toggle' } });
  assert(detailOpen(), '詳細を展開できる');
  c.panel.renderHeader();
  await c.$('kt-ai-drawer-tabs').dispatch({ type: 'click', target: { dataset: { pane: 'review' } } });
  assert(detailOpen(), '詳細の開閉は描き直しても保つ（ペインの切り替えでヘッダーを描き直しても閉じない）');
  await c.$('kt-ai-header').dispatch({ type: 'click', target: { id: 'kt-ai-header-toggle' } });
  assert(!detailOpen() && /id="kt-ai-header-detail" style="display:none;/.test(c.$('kt-ai-header').innerHTML), '詳細をもう一度押すと閉じる');
  // レスポンシブ（CSS）: 狭い幅は縦に積むだけ（境目を隠す。右は折りたたまない）
  const css = c.host.innerHTML;
  const narrow = (/@container kt-ai-ws \(max-width: 760px\)\{([\s\S]*?)\n\s*\}/.exec(css) || [])[1] || '';
  assert(narrow.includes('#kt-ai-workspace .kt-ai-ws-body{ flex-direction:column; }') && narrow.includes('#kt-ai-workspace .kt-ai-split{ display:none; }') && narrow.includes('.kt-ai-card .kt-ai-mermaid-row{ flex-direction:column; }') && !/\.kt-ai-drawer\{[^}]*display:\s*none/.test(narrow), 'narrow width（container query）: 会話と現在の作業内容は縦に積む・境目は隠す・右は隠さない・Mermaid は縦表示（Edge 半幅・パネル表示）');
  assert(/#kt-ai-workspace \.kt-ai-drawer\{ flex:0 1 var\(--kt-ai-right\);/.test(css) && !/is-drawer-collapsed|kt-ai-drawer-toggle|kt-ai-drawer-close/.test(css), '右の幅は --kt-ai-right（境目で変える）。折りたたみの CSS・ボタンは無い');
  assert(/\.kt-ai-card \.kt-ai-mermaid-row > div\{[^}]*overflow-x:auto/.test(css), 'Mermaid は横スクロール可');
  // 右（現在の作業内容）は常に表示（2026-10-06: 折りたたみは廃止。closeDrawer は公開しない）
  await c.$('kt-ai-drawer-tabs').dispatch({ type: 'click', target: { dataset: { pane: 'plan' } } });
  { const ds = c.panel.drawerState();
    assert(ds.open === true && ds.pane === 'plan' && Array.isArray(ds.unread) && typeof ds.rightWidth === 'number' && c.$('kt-ai-pane-plan').style.display === 'block' && c.$('kt-ai-pane-context').style.display === 'none' && typeof c.panel.closeDrawer === 'undefined' && !/作業パネルを(隠す|表示)|kt-ai-drawer-toggle/.test(c.$('kt-ai-header').innerHTML), 'Workspace（右）は常に表示し既定は「変更内容」ペイン（折りたたみのボタン・closeDrawer は無い）'); }
  // 左右の幅: setSplit(pct) で右の幅（%、28〜68）を変える。幅を変えても右は表示したまま
  assert(c.panel.setSplit(80) === 68 && c.panel.drawerState().rightWidth === 68 && c.panel.setSplit(10) === 28 && c.panel.drawerState().rightWidth === 28 && c.panel.setSplit(50) === 50 && c.panel.drawerState().open === true, 'setSplit: 右の幅は 28〜68% に収める（drawerState().rightWidth）・右は表示したまま');
  await c.$('kt-ai-drawer-tabs').dispatch({ type: 'click', target: { dataset: { pane: 'evidence' } } });
  assert(c.panel.drawerState().pane === 'evidence' && c.panel.drawerState().open === true && c.$('kt-ai-pane-evidence').style.display === 'block' && c.$('kt-ai-pane-plan').style.display === 'none' && /class="kt-ai-dtab active[^"]*" data-pane="evidence"/.test(c.$('kt-ai-drawer-tabs').innerHTML), 'タブの切り替え（詳細情報）。切り替えても右は閉じない');
  // ヘッダーの［反映の記録］→ 'log' ペイン（記録が 0 件の案内）・［AI 接続済み］→ 右の「接続」
  await c.$('kt-ai-header').dispatch({ type: 'click', target: { dataset: { act: 'open-log' } } });
  assert(c.panel.drawerState().pane === 'log' && c.$('kt-ai-pane-log').style.display === 'block' && /このページで動作テスト環境に反映した変更は、まだありません。/.test(c.$('kt-ai-apply-log').innerHTML) && !/kt-ai-count/.test(c.$('kt-ai-header').innerHTML), 'ヘッダーの［反映の記録］→ 反映の記録（0 件の案内。件数の表示は無い）');
  await c.$('kt-ai-header').dispatch({ type: 'click', target: { dataset: { act: 'open-connection' } } });
  assert(c.panel.drawerState().pane === 'connection' && c.$('kt-ai-pane-connection').style.display === 'block', 'ヘッダーの［AI 接続済み］→ 右の「接続」');
  assert(/このアプリについて、相談したいことや変更したいことを入力してください/.test(c.chat()), '会話が空のときの案内（2026-10-06: 相談・変更したいことを入力する）');
}

// =========================================================
console.log('\n--- 5. AI Workspace: 会話（ASK / PLAN / REVISE / EXPLAIN / PREVIEW / Review 統合）---');
//   C-1 第 3 段（2026-10-08）: 依頼は仮案 → 採用 → 計画 → 最終案のカード 1 枚（変更案のカード・確認のカード・変更前後のカードは削除）。
//   右の「変更内容」「確認結果」「反映」と、説明・反映の依頼の扱いは、この流れの上で確かめる
{
  const m = mount();
  await ticks();
  // ASK
  m.$('kt-ai-input').value = 'このフィールドは何に使ってる？';
  await m.$('kt-ai-send').dispatch('click'); await ticks();
  assert(m.calls.ask.length === 1 && m.calls.plan.length === 0 && m.calls.ask[0].ctx.contextVersion === '1' && m.calls.ask[0].ctx.question === 'このフィールドは何に使ってる？' && !('planContext' in m.calls.ask[0].ctx), 'ASK: assistant-qa（contextVersion 1）だけ。Planner は呼ばない。planContext 無し');
  assert(m.types().join() === 'USER,ANSWER' && /kt-ai-answer-card/.test(m.chat()) && /ルックアップのコピー先/.test(m.chat()) && m.$('kt-ai-input').value === '', 'ASK → 回答カード（送信後に入力欄は空）');
  { const card = (/<div class="kt-ai-card kt-ai-answer-card[\s\S]*$/.exec(m.chat()) || [''])[0];
    const head = card.split('<details')[0];
    assert(/<div class="kt-ai-who">AI<\/div>/.test(m.chat()) && !/kt-ai-who">(Toolkit|SYSTEM)</.test(m.chat()) && !/AI回答|requestId|\[E\d+\]/.test(head.replace(/<[^>]*>/g, '')) && /<details class="kt-ai-answer-detail"/.test(card), '回答カード（2026-10-06）: 発言者は「AI」。「AI回答」「requestId」の見出し・本文の [E1] は出さない（根拠は［根拠と詳細］の中）'); }
  { const ac = KTAiChatUi.answerCardHtml({ type: 'ANSWER', role: 'assistant', text: 'x', data: { answer: { answer: 'ルックアップのコピー先です [E1]。', facts: [{ text: 'コピー先の設定', evidenceIds: ['E1'] }], analysis: [], recommendations: [], unknowns: [], requestId: 'qa-9' } } });
    const acHead = ac.split('<details')[0], acDetail = ac.slice(ac.indexOf('<details'));
    assert(/ルックアップのコピー先です。/.test(acHead) && !/\[E1\]|data-eid|AI回答|requestId/.test(acHead) && /requestId: qa-9/.test(acDetail) && /E1/.test(acDetail), '回答カード: 本文の [E1] はチップにせず消す・requestId と根拠は［根拠と詳細］の中に残る'); }
  const r1 = m.calls.ask[0];
  assert(JSON.stringify(r1.ctx).length < 300000 && !JSON.stringify(r1.ctx).includes('"messages"'), 'LLM へ会話履歴は送らない（Context だけ）');
  // 曖昧な対象 → 候補
  await m.panel.send('名前の使い方を教えて'); await ticks();
  const lastA = m.msgs()[m.msgs().length - 1];
  assert(lastA.data?.kind === 'candidates' ? (lastA.data.candidates.length >= 2 && /kt-ai-candidates-card/.test(m.chat())) : lastA.type === 'ANSWER', 'ASK: 対象が曖昧なら候補を出す（決めない）／特定できれば回答');
  // PLAN（仮案 → 採用 → 計画）
  const v1 = await adoptScreen(m);
  assert(m.calls.propose.length === 1 && m.calls.propose[0].ctx.question === GOAL && m.calls.plan.length === 1 && m.calls.plan[0].ctx.contextVersion === 'planner-1' && m.calls.plan[0].ctx.goal.split('\n')[0] === GOAL && !m.calls.plan[0].ctx.revision, 'PLAN: 仮案（assistant-qa の proposal）→ 採用 → change-planner（planner-1。goal の 1 行目は依頼。revision 無し）');
  assert(v1.version === 1 && v1.fromDraft && m.panel.lastPlan() === v1.plan && m.panel.lastReview() === v1.review && v1.review.steps.length === 2, 'PLAN → v1。lastPlan / lastReview（Review / Decision / Executor の入力）は v1 に同期');
  const chat1 = m.chat();
  //   2026-10-06 の変更案のカード（「変更案ができました。」・変わる内容・Toolkit の確認・［変更内容を見る］）は削除した（ai-flow-redesign の R09-1・R09-3・F5-1）。
  //   版ごとのカードは最終案のカード 1 枚（要約・反映先と主な影響・まだ何も反映していません・［この内容で反映する］。手順の本文・版の番号は出さない。R09-9・画面-1）
  { const finalText = chat1.slice(chat1.indexOf('class="kt-ai-card kt-ai-final-card')).replace(/<[^>]*>/g, '');
    assert(/最終案ができました。/.test(finalText) && /更新状況を表すフィールドが無いので追加します。/.test(finalText) && /反映先と主な影響/.test(finalText) && /まだ何も反映していません。/.test(finalText) && /data-act="final-approve"[^>]*>動作テスト環境へ反映</.test(chat1) && !/v\d|変更計画/.test(finalText) && !/＋ 更新状況フィールドを追加/.test(chat1) && !/kt-ai-plan-card/.test(chat1), '最終案のカード: 「最終案ができました。」・要約・反映先と主な影響・まだ何も反映していません・［動作テスト環境へ反映］。手順の本文・版の番号・変更案のカードは出さない'); }
  assert(!/提案の内容（/.test(chat1) && /＋ 新規フィールド<\/b>/.test(m.$('kt-ai-plan-result').innerHTML) && /更新状況/.test(m.$('kt-ai-plan-result').innerHTML) && /DROP_DOWN/.test(m.$('kt-ai-plan-result').innerHTML), '提案資産（新規フィールド / 一覧）の詳細は右の「変更内容」の計画の全文だけ（WORKSPACE_ONLY）');
  { const sum = m.$('kt-ai-change-summary').innerHTML;
    assert(/<h3>更新状況を管理したい<\/h3>/.test(sum) && /何が変わるか（Toolkit が確かめた変更前後）/.test(sum) && /新しいフィールド：更新状況（DROP_DOWN）/.test(sum) && /確認したいこと（1 件）/.test(sum) && /更新状況の選択肢は 3 段階でよいですか/.test(sum) && !/P1|P2|E\d/.test(sum.replace(/<[^>]*>/g, '')) && m.$('kt-ai-pane-plan-empty').style.display === 'none' && m.$('kt-ai-plan-detail').style.display === '', '右の「変更内容」: 変更内容の要約（見出し=goal・何が変わるか・確認したいこと。手順・根拠の番号は出さない）・計画の全文は［計画の詳細と根拠］'); }
  //   Toolkit の確認（REVIEW）の記録のメッセージは削除した（F5-1）。確認の結果は右の「確認結果」にまとめる。判断の select は会話に無い
  assert(!m.msgs().some(x => x.type === 'REVIEW') && !/kt-ai-review-card/.test(chat1) && !/Toolkitで変更計画を検証しました|検証結果を見る/.test(chat1) && !/kt-ai-decision/.test(chat1), 'Toolkit の確認は会話のカードにしない（REVIEW のメッセージは無い）。判断の select は会話に無い');
  //   会話のカードの承認は最終案の［この内容で反映する］だけ（R16・画面-3）。チャットの文章・手順ごとの判断の select・反映の開始は会話に無い
  assert(!/<select/.test(chat1) && !/data-act="(approve|decide|exec-start|exec-go)"/.test(chat1) && !/id="kt-ai-exec-(start|go)"/.test(chat1) && /まだ何も反映していません。/.test(chat1), '会話のカードに手順ごとの判断・右の「反映」の操作は無い（承認と反映は最終案の［動作テスト環境へ反映］だけ。チャットの文章では承認にならない）');
  assert(m.$('kt-ai-review-result').innerHTML.includes('Toolkit で確認した結果') && !m.$('kt-ai-plan-result').innerHTML.includes('kt-ai-decision') && m.panel.drawerState().open === true && m.panel.drawerState().pane === 'plan' && m.panel.activeArtifact()?.type === 'CHANGE_PLAN', 'Review 統合: 右の「確認結果」に Toolkit で確認した結果。計画受信で右は「変更内容」（activeArtifact CHANGE_PLAN）');
  //   ［Before / After］（DIFF のカード）は変更案のカードのボタンだった。変更案のカードと一緒に入口が無くなった（R の報告の「到達しなくなった小さな残り」）。
  //   変更前後は右の「確認結果」の中にある
  assert(m.$('kt-ai-review-diff') && /P2<\/b>/.test(m.$('kt-ai-review-result').innerHTML) && !/data-act="before-after"/.test(chat1), '変更前後は右の「確認結果」の中（会話に［Before / After］は無い）');
  // 右のペインを開く（右は常に表示。別のペインを見ていても切り替わる）
  m.panel.showPane('evidence');
  await clickChat(m, 'open-plan', { plan: v1.planId, version: '1' });
  assert(m.panel.drawerState().open === true && m.panel.drawerState().pane === 'plan', '［変更内容を見る］（open-plan）→ 右の「変更内容」ペイン');
  await clickChat(m, 'open-review', { plan: v1.planId, version: '1' });
  assert(m.panel.drawerState().open === true && m.panel.drawerState().pane === 'review', '［検証と判断を開く］（open-review）→ 右の「確認結果」ペイン');
  // REVISE
  await m.panel.send('新しい承認者は作らず既存の承認者を使って'); await ticks(10);
  const rv = m.calls.plan[1];
  assert(m.calls.plan.length === 2 && rv.ctx.goal.split('\n')[0] === GOAL && rv.ctx.revision && rv.ctx.revision.basedOnVersion === 1 && rv.ctx.revision.request === '新しい承認者は作らず既存の承認者を使って' && rv.ctx.revision.previousPlan.steps.length === 2 && rv.ctx.revision.previousPlan.proposedFields[0].temporaryId === 'NEW_FIELD_1' && rv.ctx.revision.previousPlan.steps[0].spec.fieldType === 'DROP_DOWN', 'REVISE: 同じ goal ＋ revision（basedOnVersion 1 / request / 前回の計画の要約: steps・proposedFields・spec）を送る');
  assert(rv.ctx.retrieval.fields.some(f => f.code === 'approver') || rv.ctx.retrieval.matchedTerms.some(t => /承認者/.test(t.key)), 'revision の語（承認者）も辞書照合に使う');
  const v2 = m.conv().activePlan();
  assert(v2.version === 2 && v2.basedOnVersion === 1 && v1.status === 'SUPERSEDED' && m.panel.lastPlan() === v2.plan && m.panel.lastReview() === v2.review && v2.plan.steps[0].actionType === 'REUSE_FIELD', 'REVISE → v2 が最新。lastPlan / lastReview は v2（v1 は SUPERSEDED）');
  //   v2 の最終案のカード（「最終案を直しました。」・入れた指示）と、前の最終案は 1 行に畳む（ai-flow-redesign の R10-4・F2-2）
  { const chat2 = m.chat(); const text2 = chat2.replace(/<[^>]*>/g, '');
    assert(/最終案を直しました。/.test(text2) && /入れた指示: 新しい承認者は作らず既存の承認者を使って/.test(text2) && /<details class="kt-ai-card kt-ai-old-card kt-ai-final-card is-old"><summary>前の最終案 — このあと直した案があります/.test(chat2) && (chat2.match(/class="kt-ai-card kt-ai-final-card"/g) || []).length === 1 && !/↻ 既存「担当者」を利用/.test(chat2) && !/変更計画 v\d|v\d に更新済み/.test(text2), 'v2 の最終案のカード（「最終案を直しました。」）・v1 の最終案は「このあと直した案があります」に畳む。手順の本文・版の番号は会話に無い'); }
  assert(m.conv().planHistory().length === 2 && !/kt-ai-new-field/.test(m.$('kt-ai-plan-result').innerHTML) && /担当者/.test(m.$('kt-ai-plan-result').innerHTML) && m.panel.activeArtifact()?.version === 2, '右の「変更内容」は最新版 v2 だけ（v1 の新規フィールド枠は無い・activeArtifact は v2）');
  // EXPLAIN_PLAN
  await m.panel.send('P1って何してる？'); await ticks();
  const ex = m.calls.ask[m.calls.ask.length - 1];
  assert(ex.ctx.contextVersion === '1' && ex.ctx.planContext && ex.ctx.planContext.kind === 'EXPLAIN_PLAN' && ex.ctx.planContext.plan.version === 2 && ex.ctx.planContext.plan.steps.length === 2 && ex.ctx.planContext.review && ex.ctx.planContext.review.steps.length === 2 && ex.ctx.question === 'P1って何してる？', 'EXPLAIN_PLAN: Q&A Context に planContext（計画 v2 の要約 ＋ Review の写し）');
  assert(ex.ctx.facts.every(f => /^E\d+$/.test(f.id)) && ex.ctx.facts.some(f => f.kind === 'overview') && ex.ctx.facts.length <= 120 && !ex.ctx.planContext.plan.steps[0].spec, '説明の facts は計画が引用した根拠と概要だけ（ID は計画と同じ）。spec は送らない');
  assert(m.conv().planHistory().length === 2 && m.conv().activePlan() === v2 && /変更案の説明（変更案は変えていません）/.test(m.chat()), 'Explain は計画を変えない（版は増えない）・回答カードに明記（「変更案の説明（変更案は変えていません）」）');
  // EXPLAIN_REVIEW: AI が「実は安全です」と言っても Review は変わらない
  const before = JSON.stringify(m.panel.lastReview());
  await m.panel.send('何でこれ危ないの？'); await ticks();
  const ex2 = m.calls.ask[m.calls.ask.length - 1];
  assert(ex2.ctx.planContext.kind === 'EXPLAIN_REVIEW' && /実は安全です/.test(m.chat()) && JSON.stringify(m.panel.lastReview()) === before && m.panel.lastReview() === v2.review && /確認結果の説明（判定は Toolkit が確かめた結果のままです。説明で判定は変わりません）/.test(m.chat()), 'EXPLAIN_REVIEW: AI の説明で Review（判定・safety）は変わらない（Toolkit が正本。「確認結果の説明」に明記）');
  // REQUEST_PREVIEW（承認なし）: 最終案の流れでは、承認の前は承認へ案内する（ai-flow-redesign の F10-1）
  const w0 = writes(m).length;
  await m.panel.send('これで進めたい'); await ticks();
  const pr = m.msgs()[m.msgs().length - 1];
  assert(pr.data.kind === 'preview-needs-approval' && /［動作テスト環境へ反映］/.test(pr.text) && !/実行前レビュー/.test(m.chat()) && m.panel.executorState().stage === 'idle' && writes(m).length === w0, 'REQUEST_PREVIEW（承認前）: 最終案の［動作テスト環境へ反映］へ案内。Executor は動かない・書き込み 0');
  // §0e.1（2026-10-09）: 承認の欄の準備（書き込みなし）が終わると［動作テスト環境へ反映］を押せる。承認の欄に、反映する設定と自動では反映しない手順を出す
  //   （以前の「承認後の REQUEST_PREVIEW の件数（実行可 1・未対応 1）」は、この承認の欄の重要事項に置き換えた）
  await ticks(20);
  { const pre = m.panel.finalPrecheck();
    assert(pre.status === 'ready' && pre.items.settings.length === 1 && pre.items.manual.length === 1 && writes(m).length === w0 && /反映の前の確認（書き込みなし）/.test(m.chat()) && !m.conv().activePlan().approval, '承認の欄: 反映する設定 1 件・自動では反映しない手順 1 件（既存フィールドの利用は計画のみ）。準備は書き込まず、まだ承認しない'); }
  const ar5 = await applyScreen(m);
  assert(ar5.button && ar5.button.label === '動作テスト環境へ反映' && !ar5.button.disabled && ar5.run && ar5.run.stage === 'done' && ar5.run.ok && JSON.stringify(ar5.writes) === '["PUT views"]', '最終案のカードの［動作テスト環境へ反映］1 回で承認と反映（実行できる 1 件だけを書き込む）');
  await m.panel.send('これで進めたい'); await ticks();
  const pr2 = m.msgs()[m.msgs().length - 1];
  assert(pr2.data.kind === 'preview-approved' && /承認済みです/.test(pr2.text) && !/動作テスト環境へ反映する準備ができました/.test(m.chat()), 'REQUEST_PREVIEW（承認・反映の後）: 結果の場所を案内するだけ');
  assert(writes(m).length === w0 + 1 && !/id="kt-ai-exec-confirm"/.test(m.$('kt-ai-exec').innerHTML), 'チャットでは Executor を開始しない（新しい書き込み・最終確認は出ない）');
}

// =========================================================
console.log('\n--- 6. Executor / Rollback 統合と Versioning（v1 は Executor へ進めない）---');
{
  const m = mount();
  await ticks();
  //   C-1 第 3 段（2026-10-08）: 依頼は仮案 → 採用 → 最終案。承認は最終案のカードの［この内容で反映する］（手順ごとの判断ではない。ai-flow-redesign の 画面-3・画面-3b）
  const v1 = await adoptScreen(m);
  //   §0e.1: 画面の承認は反映と 1 回なので、版が変わると承認を引き継がないことは承認の記録（会話コントローラ）で確かめる
  assert(m.conv().approveFinal({ planId: v1.planId, version: v1.version }).ok && m.panel.reviewOutput().approvedSteps.join() === 'P1,P2', '前提: v1 の最終案を承認（却下していない手順は承認済み）');
  await m.panel.send('新しい承認者は作らず既存の承認者を使って'); await ticks(10);
  const v2 = m.conv().activePlan();
  assert(m.panel.reviewOutput().approvedSteps.length === 0 && !v2.approval && m.panel.reviewOutput().plan.requestId === v2.plan.requestId && m.panel.reviewOutput().plan.requestId !== v1.plan.requestId, '版が変わると承認はやり直し（v1 の承認は v2 に持ち越さない。R16-5・画面-4）・executorOutput は v2');
  await ticks(20);
  { const pre = m.panel.finalPrecheck();
    assert(pre.status === 'ready' && pre.planId === v2.planId && pre.items.settings.length === 1 && pre.items.manual.length === 1 && writes(m).length === 0 && !m.msgs().some(x => x.type === 'EXECUTION') && m.panel.applyHold() === null && !v2.approval, '承認の欄: v2 の最終案ができると書き込みをしない準備を自動で走らせ、重要事項を出す（書き込み 0・まだ承認しない・反映を止める理由は無い）');
    assert(/kt-ai-apply-note/.test(m.$('kt-ai-exec').innerHTML) && /最終案のカードの［動作テスト環境へ反映］/.test(m.$('kt-ai-exec').innerHTML) && !/id="kt-ai-exec-start"/.test(m.$('kt-ai-exec').innerHTML), '右の「反映」に準備・最終確認の段は出さない（最終案のカードの［動作テスト環境へ反映］1 回で反映する）'); }
  m.panel.showPane('review');
  const ar6 = await applyScreen(m);
  const out = m.panel.reviewOutput();
  assert(ar6.button && !ar6.button.disabled && v2.approval && v2.approval.precheck && out.plan.steps[0].actionType === 'REUSE_FIELD' && !out.plan.steps.some(s => s.actionType === 'ADD_FIELD') && out.approvedSteps.join() === 'P1,P2', '［動作テスト環境へ反映］1 回で v2 を承認（承認の欄の準備の指紋つき）。Executor の入力（executorOutput）は v2 だけ（v1 の ADD_FIELD は含まれない）');
  assert(m.panel.drawerState().pane === 'exec' && m.$('kt-ai-pane-exec').style.display === 'block', '押すと右のタブ「反映」に切り替わる（進捗と詳細）');
  const st = m.panel.executorState();
  assert(st.stage === 'done' && st.execution.status === 'DONE' && m.mock.st.views['担当者別'] && !m.mock.st.fields.progress && JSON.stringify(ar6.writes) === '["PUT views"]', '1 回の操作で反映: v2 の一覧だけが入る（v1 の新規フィールドは作られない）');
  const chat = m.chat();
  assert(m.msgs().filter(x => x.type === 'EXECUTION').length === 1 && ar6.cardCount === 1 && /動作テスト環境へ反映しました。/.test(ar6.card) && /標準設定: ✓ 1 件を反映（反映後の確認で一致）/.test(ar6.card) && !/VERIFIED/.test(chat) && !/Simulation/.test(chat) && /運用環境には反映されていません。/.test(ar6.card) && /data-act="exec-details"/.test(ar6.cardHtml) && /data-act="rollback"/.test(ar6.cardHtml) && !/kt-ai-execution-card/.test(chat) && /Simulationとの一致：✓/.test(m.$('kt-ai-exec').innerHTML) && !/まだ何も反映していません/.test(chat.slice(chat.indexOf('class="kt-ai-card kt-ai-final-card"'))), '結果のカード 1 枚（2026-10-09）: 反映しました・標準設定 ✓ 1 件（VERIFIED の語は出さない）/ 運用環境には反映されていません / [実行結果を見る][設定を変更前の状態に戻す]。実行のカードは結果のカードにまとめ、最終案のカードに「まだ何も反映していません」を出さない。Simulation・進捗は右の「反映」');
  { const paneNow = m.panel.drawerState().pane;
    await clickChat(m, 'exec-details', { execution: st.execution.executionId });
    assert(m.panel.drawerState().pane === 'exec' && m.$('kt-ai-pane-exec').style.display === 'block' && /id="kt-ai-exec-result"/.test(m.$('kt-ai-exec').innerHTML), '［実行結果を見る］→ 右のタブ「反映」に切り替わる'); }
  // 反映の記録（ヘッダーの［反映の記録］で開く。件数を出す）・記録の［監査 JSON をコピー］（#kt-ai-pane-log のクリック）
  await m.$('kt-ai-header').dispatch({ type: 'click', target: { dataset: { act: 'open-log' } } });
  { const logHtml = m.$('kt-ai-apply-log').innerHTML;
    const logId = (/data-log="([^"]+)"/.exec(logHtml) || [])[1] || null;
    assert(m.panel.drawerState().pane === 'log' && /反映済み（未復元）/.test(logHtml) && logId && /id="kt-ai-log-open"[^>]*data-act="open-log"[^>]*>反映の記録<span class="kt-ai-count">1<\/span>/.test(m.$('kt-ai-header').innerHTML), 'ヘッダーの［反映の記録］（件数 1）→ 反映の記録に「反映済み（未復元）」が残る');
    const nCopies = m.copies.length;
    await m.$('kt-ai-pane-log').dispatch({ type: 'click', target: { dataset: { act: 'log-audit', log: logId } } });
    const copied = m.copies.length === nCopies + 1 ? JSON.parse(m.copies[m.copies.length - 1]) : null;
    assert(copied && copied.execution && copied.execution.executionId === st.execution.executionId && copied.plan.steps[0].actionType === 'REUSE_FIELD', '反映の記録の［監査 JSON をコピー］（#kt-ai-pane-log のクリック）→ 実行した版（v2）の監査 JSON'); }
  { const notice = m.msgs().find(x => x.type === 'SYSTEM_NOTICE' && /動作テスト環境の設定が変更されました/.test(x.text));
    assert(notice && notice.data?.kind === 'preview-changed' && KTAiChatUi.isHiddenMessage(notice) && !/動作テスト環境の設定が変更されました/.test(chat) && v2.status === 'EXECUTED' && v2.executionId === st.execution.executionId && v1.status === 'SUPERSEDED', 'SYSTEM: 動作テスト環境の設定が変更されました（記録に残す。反映のカードと同じ内容なので会話には出さない）。v2 は EXECUTED（実行 ID を保持）'); }
  const audit = m.panel.auditJson();
  assert(audit.plan.steps[0].actionType === 'REUSE_FIELD' && audit.execution.executionId === st.execution.executionId, '監査 JSON は実行した版（v2）の計画');
  // REQUEST_ROLLBACK（即 Rollback しない）
  const w1 = writes(m).length;
  await m.panel.send('やっぱり元に戻して'); await ticks();
  const rr = m.msgs()[m.msgs().length - 1];
  assert(rr.data.kind === 'rollback-ready' && rr.data.executionId === st.execution.executionId && /変更前の状態へ戻せます/.test(m.chat()) && /反映する前の設定に戻します。/.test(m.chat()) && !/snapshot|スナップショット/i.test(m.chat().replace(/<[^>]*>/g, '')) && m.panel.executorState().stage === 'done' && writes(m).length === w1 && m.mock.st.views['担当者別'], 'REQUEST_ROLLBACK → 「変更前の状態へ戻せます」「反映する前の設定に戻します。」（snapshot の語は出さない）[変更前の状態に戻す]。Rollback はまだ始まらない（書き込み 0・一覧は残る）');
  await clickChat(m, 'rollback', { execution: st.execution.executionId }); await ticks();
  assert(m.panel.executorState().stage === 'rollback-confirm' && writes(m).length === w1 && m.$('kt-ai-exec').innerHTML.includes('id="kt-ai-exec-rollback-go"') && m.msgs().filter(x => x.type === 'ROLLBACK').length === 1 && /確認画面で「変更前の状態に戻す」を押すと戻します/.test(m.chat()), 'カードの [変更前の状態に戻す] → 現在の設定を確認（書き込みなし）→ 既存の Rollback 確認（右下の右の「反映」）。会話には ROLLBACK カード');
  await clickExec(m, 'kt-ai-exec-rollback-go'); await ticks(8);
  { const rbNotice = m.msgs().find(x => x.type === 'SYSTEM_NOTICE' && /変更前の状態に戻しました/.test(x.text));
    assert(m.panel.executorState().stage === 'rolled-back' && !m.mock.st.views['担当者別'] && /変更前の状態へ戻しました。/.test(m.chat()) && /反映する前の設定との比較：✓ 一致/.test(m.chat()) && !/ROLLBACK_VERIFIED|snapshot/i.test(m.chat()) && /✓ 1 件 ROLLBACK_VERIFIED/.test(m.$('kt-ai-exec').innerHTML) && v2.status === 'ROLLED_BACK' && rbNotice && KTAiChatUi.isHiddenMessage(rbNotice) && !/変更前の状態に戻しました/.test(m.chat()), 'Rollback 確認 → 戻す → Rollback Result カード「変更前の状態へ戻しました。」「反映する前の設定との比較：✓ 一致」（詳細は右下の右の「反映」）・v2 は ROLLED_BACK・戻した通知は記録に残し会話には出さない'); }
  assert(m.panel.auditJson().rollback && m.panel.auditJson().plan.steps[0].actionType === 'REUSE_FIELD', 'rollback は正しい実行（v2）に結び付く（監査 JSON）');
  // 反映後に新しい計画を作っても、戻していない実行は失わない（別シナリオ）
  const n = mount();
  await ticks();
  await adoptScreen(n);
  // 未回答の確認事項（Q1。priority 無し）があっても承認・反映は止まらない
  const an = await applyScreen(n);
  assert(an.button && !an.button.disabled && n.panel.applyHold() === null && n.conv().answerContext().open.length === 1 && !n.conv().answerContext().open[0].priority, '未回答の確認事項（priority 無し）があっても承認・反映は止めない（applyHold null・［動作テスト環境へ反映］を押せる）');
  assert(n.panel.executorState().stage === 'done' && n.mock.st.fields.progress && an.run.ok, 'v1 を反映（1 回の操作）');
  //   C-1 第 3 段: 反映済みの計画の後の依頼は、新しい依頼として仮案から（その計画は直さない）→ 採用で新しい計画の系列
  await n.panel.send('契約終了30日前に担当者へ通知したい'); await ticks(6);
  assert(n.calls.propose.length === 2 && n.conv().draft() && n.conv().draft().status === 'open' && n.conv().planHistory().length === 1, '反映済みのあとの新しい要望 → 新しい仮案（反映済みの計画は直さない）');
  await n.panel.send('これで進めて'); await ticks(10);
  assert(n.conv().planHistory().length >= 2 && n.conv().activePlan().planId !== n.conv().planHistory()[0].planId && n.panel.executorState().stage === 'done' && n.panel.executorState().execution && /data-act="rollback"/.test(n.chat()), '新しい計画を作っても、戻していない実行結果（Rollback 可能）は残る');
}

// =========================================================
console.log('\n--- 7. Safety: 自然言語 ≠ 承認（write 0 件）/ errors / rate limit / retry / cancel ---');
{
  const m = mount();
  await ticks();
  await adoptScreen(m);
  //   C-1 第 3 段（2026-10-08）: 最終案の流れでは、承認の前の反映の依頼は承認（［この内容で反映する］）への案内だけ（ai-flow-redesign の F10-1）
  for (const t of ['全部承認', 'そのまま実行', 'いいから反映して', '実行して']) {
    await m.panel.send(t); await ticks();
    const last = m.msgs()[m.msgs().length - 1];
    assert(last.data?.kind === 'preview-needs-approval' && !m.conv().activePlan().approval && writes(m).length === 0 && m.panel.executorState().stage === 'idle' && [...(m.panel.reviewOutput().approvedSteps)].length === 0, `Safety: 「${t}」→ 承認への案内だけ。承認 0・Executor idle・write 0 件`);
  }
  await m.panel.send('戻して'); await ticks();
  assert(writes(m).length === 0 && m.panel.executorState().stage === 'idle' && /元に戻せる反映はありません/.test(m.chat()), 'Safety: 「戻して」だけでは write 0 件（反映していない）');
  assert(!/<button[^>]*>[^<]*運用環境へ反映/.test(m.chat()) && !/deploy/i.test(m.chat()), '会話にも「運用環境へ反映」/ deploy は無い');
  // 先に確認したいこと（priority 'blocking'）が残っている間は反映しない（2026-10-06: 必要な確認が終わった内容だけを反映できる）。答えて変更案に入れると反映できる
  {
    const BLOCKING_V1 = { ...PLAN_V1, plan: { ...PLAN_V1.plan, questions: [{ id: 'Q1', question: '更新状況の選択肢は 3 段階でよいですか', reason: 'goal から決められない', relatedEvidenceIds: [], priority: 'blocking' }] } };
    const b = mount({ planResponses: (ctx) => (ctx.revision ? PLAN_V2 : BLOCKING_V1) });
    await ticks();
    await adoptScreen(b);
    //   C-1 第 3 段: 先に決めたいことは最終案のカードの中（変更案のカードは削除。ai-flow-redesign の R10-1・R10-2）。最終案は承認できない
    const arB = await applyScreen(b);
    const approvedB = !!b.conv().activePlan().approval;
    const holdText = '先に確認したいことが 1 件残っています。左の会話で答えると反映できます。';
    assert(b.panel.applyHold() === holdText && !approvedB && arB.button && arB.button.disabled && writes(b).length === 0 && b.conv().activePlan().final.approvable === false && /先に決めたいことが 1 件残っています。答えると反映できるようになります。/.test(b.chat()), 'blocking の確認事項が残っている: applyHold に理由・最終案は承認できず、カードに「先に決めたいことが 1 件残っています」');
    assert(!/id="kt-ai-exec-start"/.test(b.$('kt-ai-exec').innerHTML) && b.$('kt-ai-exec').innerHTML.includes(holdText), 'blocking の確認事項が残っている: 右の「反映」に反映の操作は無く、止めている理由を表示（最終案のカードの［動作テスト環境へ反映］も押せない）');
    const sr = await b.panel.startExecutor();
    await clickExec(b, 'kt-ai-exec-start'); await ticks();
    assert(sr === null && b.panel.executorState().stage === 'idle' && writes(b).length === 0, 'blocking の確認事項が残っている: startExecutor は null・ボタンを押しても準備しない（書き込み 0）');
    // 最終案のカードの回答欄に答えて［回答を送る］→ 直した最終案（確認事項なし）では承認・反映できる
    const qkey = (/data-qkey="([^"]+)"/.exec(b.chat()) || [])[1] || null;
    const v1b = b.conv().activePlan();
    await b.$('kt-ai-chat').dispatch({ type: 'input', target: { dataset: { qkey }, value: '3 段階でよい' } });
    await clickChat(b, 'answer-questions', { plan: v1b.planId, version: String(v1b.version) }); await ticks(10);
    const arB2 = await applyScreen(b);
    assert(arB2.button && !arB2.button.disabled && arB2.run && arB2.run.ok && b.conv().activePlan().approval, '直した最終案は［動作テスト環境へ反映］を押せて、承認と反映ができる（版が変わると承認はやり直し）');
    assert(qkey && b.conv().activePlan().version === 2 && b.conv().answerContext().open.length === 0 && b.conv().ledger().every(e => e.appliedInVersion === 2) && b.panel.applyHold() === null && b.panel.executorState().stage === 'done' && !b.$('kt-ai-exec').innerHTML.includes(holdText), '回答して変更案に入れると反映を止めない（applyHold null・反映できた）');
  }
  // errors
  const e1 = mount({ askError: () => new KTAiClient.AiClientError({ code: 'UPSTREAM_ERROR', message: 'x', requestId: 'e-1' }) });
  await ticks();
  e1.$('kt-ai-input').value = 'このフィールドは何に使ってる？';
  await e1.$('kt-ai-send').dispatch('click'); await ticks();
  assert(e1.types()[e1.types().length - 1] === 'ERROR' && /kt-ai-error-card/.test(e1.chat()) && /AI プロバイダが応答しませんでした/.test(e1.chat()) && /<details class="kt-ai-tech"><summary>詳細情報<\/summary><div class="kt-ai-error-code">UPSTREAM_ERROR \/ requestId: e-1<\/div><\/details>/.test(e1.chat()) && !/\[UPSTREAM_ERROR\]/.test(e1.chat()) && /data-act="retry"/.test(e1.chat()) && e1.$('kt-ai-input').value === 'このフィールドは何に使ってる？', 'errors: ERROR カード（文言・[再試行]。code と requestId は［詳細情報］の中・[CODE] の形では出さない）。入力欄の内容は残る');
  // rate limit → retry
  let fail = true;
  const r = mount({ askError: () => (fail ? new KTAiClient.AiClientError({ code: 'RATE_LIMITED', message: 'x', retryAfterSeconds: 42, requestId: 'e-2' }) : null) });
  await ticks();
  r.$('kt-ai-input').value = 'このフィールドは何に使ってる？';
  await r.$('kt-ai-send').dispatch('click'); await ticks();
  assert(/アクセスが集中しています/.test(r.chat()) && /約42秒後に再実行できます/.test(r.chat()) && /<div class="kt-ai-error-code">RATE_LIMITED \/ requestId: e-2<\/div>/.test(r.chat()) && !/\[RATE_LIMITED\]/.test(r.chat()) && r.$('kt-ai-input').value === 'このフィールドは何に使ってる？' && r.$('kt-ai-send').disabled === false, 'rate limit: 文言・retryAfter・composer の内容を失わない・再送できる');
  fail = false;
  await clickChat(r, 'retry', { text: 'このフィールドは何に使ってる？' }); await ticks();
  assert(r.calls.ask.length === 2 && r.types()[r.types().length - 1] === 'ANSWER' && r.$('kt-ai-input').value === '', 'retry: [再試行] で同じ文を再送 → 回答（成功後に入力欄は空）');
  // cancel（AbortController）
  let aborted = false;
  const c = mount({ askDelay: (signal) => new Promise((_, rej) => { signal.addEventListener('abort', () => { aborted = true; rej(new KTAiClient.AiClientError({ code: 'CANCELLED', message: 'c' })); }); }) });
  await ticks();
  c.$('kt-ai-input').value = 'このフィールドは何に使ってる？';
  const p = c.$('kt-ai-send').dispatch('click'); await ticks();
  assert(c.conv().isBusy() && c.$('kt-ai-cancel').style.display === '' && c.$('kt-ai-send').disabled === true && /確認しています\.\.\./.test(c.chat()), 'loading: 「確認しています...」・[キャンセル] 表示・送信は無効');
  await c.$('kt-ai-cancel').dispatch('click'); await p; await ticks();
  assert(aborted && c.calls.ask[0].signal && /キャンセルしました/.test(c.chat()) && c.$('kt-ai-input').value === 'このフィールドは何に使ってる？' && c.$('kt-ai-cancel').style.display === 'none' && c.$('kt-ai-send').disabled === false, 'cancel: AbortSignal で中断 → 「キャンセルしました」・入力を保持・送信可');
  // 同意（初回）
  const k = mount({ consent: false });
  await ticks();
  const kr = await k.panel.send('このフィールドは何に使ってる？'); await ticks();
  assert(kr && kr.pendingConsent === true && k.$('kt-ai-consent').style.display === '' && k.calls.ask.length === 0, '初回は送信前の確認（同意）を出し、まだ送らない');
  await k.$('kt-ai-consent-ok').dispatch('click'); await ticks();
  assert(k.settings.hasConsent() && k.calls.ask.length === 1 && k.types()[k.types().length - 1] === 'ANSWER', '同意 → 送信');
  // 長い会話（表示上限）
  const l = mount();
  await ticks();
  for (let i = 0; i < 35; i++) await l.panel.send(`質問${i}？`);
  assert(l.msgs().length === 70 && /以前のメッセージ 10 件を表示/.test(l.chat()) && (l.chat().match(/class="kt-ai-msg /g) || []).length === 60, 'long conversation: 直近 60 件だけ描く（以前の分は展開）');
  await clickChat(l, 'show-all');
  assert((l.chat().match(/class="kt-ai-msg /g) || []).length === 70, '展開で全件');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
