// AI Workspace（Phase 15）: 独立 AI タブ / Templates からの移行 / 会話コントローラ（KTAiConversation）/ 計画のバージョン / 安全性
//
// 検証内容:
//   §39 AI Tab: mount / switch / minimized・expanded / narrow width（CSS）/ free state / connected state / Templates から AI 移行
//   §40 Conversation: ASK / PLAN / REVISE_PLAN / EXPLAIN_PLAN / EXPLAIN_REVIEW / REQUEST_PREVIEW / REQUEST_ROLLBACK / ambiguous / errors / rate limit / retry / cancel
//   §41 Versioning: v1 → revision → v2 / v1 inactive / Executor cannot use v1 / rollback は正しい実行に結び付く
//   §42 Safety: チャットの文章だけでは write 0 件（「実行して」「戻して」）/ Toolkit Review は AI の説明で変わらない
//
// 実行方法: node tests/ai-workspace.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { makeFakeHost, makeFakeDocument } = require('./helpers/fake-dom.js');
const { KTDeps, KTScan, KTContext, KTAiClient, KTAiConversation, KTAiChatUi, KTPlanReview, mountAiWorkspace, renderTemplates } = loadToolkit();
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
const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'] }, 'change-planner': { implemented: true, promptVersions: ['1'] } } }, usage: { monthlyLimit: 20, usedThisMonth: 1 } };
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
  const calls = { ask: [], plan: [], health: 0 };
  const client = {
    async getHealth() { calls.health++; return HEALTH; },
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
const clickPlan = (m, id) => m.$('kt-ai-plan-result').dispatch({ type: 'click', target: { id } });
const writes = (m) => m.mock.calls.filter(c => !c.startsWith('GET'));

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
  assert(cls('契約終了30日前に担当者へ通知したい', withPlan) === I.AMBIGUOUS && KTAiConversation.classifyIntent('契約終了30日前に担当者へ通知したい', withPlan).reason === 'NEW_OR_REVISE', '計画があるときの新しい要望は「修正か新規か」を聞く（勝手に計画を変えない）');
  assert(cls('ありがとう') === I.GENERAL && cls('') === I.GENERAL, 'GENERAL: 挨拶・空');
  // 実行済みの計画
  const executed = { activePlan: { ...v1, status: 'EXECUTED' } };
  assert(cls('通知はいらない', executed) === I.REVISE_PLAN && KTAiConversation.classifyIntent('通知はいらない', executed).revisable === false, '反映済みの計画への修正は intent REVISE_PLAN（revisable false。送信側が作り直しを案内する）');
  assert(KTAiConversation.planTerms(PLAN_V1.plan).includes('更新状況') && KTAiConversation.planTerms(PLAN_V1.plan).includes('担当者別'), 'planTerms: 新規フィールドのラベル・手順の対象');
}

// =========================================================
console.log('\n--- 2. KTAiConversation.create（fake services。履歴は送らない）---');
{
  const log = [];
  const pctx = KTContext.buildPlan({ goal: GOAL, ...INPUTS, options: { now: '2026-10-02T00:00:00.000Z' } });
  const planOf = (resp, ctx) => KTAiClient.validatePlan(resp, ctx).normalized;
  const services = {
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
  const r2 = await c.send(GOAL);
  const v1 = c.activePlan();
  assert(r2.intent === 'PLAN' && log[1][0] === 'plan' && log[1][1] === GOAL && !log[1][2], 'PLAN → services.plan（goal。revision 無し）');
  assert(v1 && v1.version === 1 && v1.basedOnVersion === null && v1.status === 'ACTIVE' && v1.plan.steps.length === 2 && v1.review && v1.goal === GOAL && v1.revisionRequest === null, 'v1: { planId, version 1, basedOnVersion null, goal, revisionRequest null, review }');
  const types = c.messages().map(m => m.type);
  assert(types.slice(2).join() === 'USER,ASSISTANT_TEXT,PLAN,ASSISTANT_TEXT,REVIEW,ASSISTANT_TEXT' && c.messages().filter(m => m.type === 'PLAN')[0].role === 'assistant' && c.messages().filter(m => m.type === 'REVIEW')[0].role === 'toolkit', 'PLAN（AI）と REVIEW（Toolkit）は別のメッセージ。質問（Q1）も案内');
  assert(c.messages().find(m => m.type === 'ASSISTANT_TEXT' && m.role === 'toolkit').text.includes('変更計画 v1 を検証しました'), 'Toolkit: 「変更計画 v1 を検証しました」');
  const r3 = await c.send('新しい承認者は作らず既存の承認者を使って');
  const v2 = c.activePlan();
  assert(r3.intent === 'REVISE_PLAN' && log[2][0] === 'plan' && log[2][1] === GOAL && log[2][2] === '新しい承認者は作らず既存の承認者を使って', 'REVISE_PLAN → services.plan（同じ goal ＋ revision.request）。旧 JSON の patch ではなく再計画');
  assert(v2.version === 2 && v2.basedOnVersion === 1 && v2.planId === v1.planId && v2.revisionRequest === '新しい承認者は作らず既存の承認者を使って' && v2.status === 'ACTIVE' && v1.status === 'SUPERSEDED' && v2.plan.steps[0].actionType === 'REUSE_FIELD', 'v2: version 2 / basedOnVersion 1 / 同じ planId / v1 は SUPERSEDED');
  assert(c.planHistory().length === 2 && c.messages().find(m => m.type === 'PLAN' && m.data.version === 2) && c.messages().find(m => m.type === 'ASSISTANT_TEXT' && /変更計画 v2 に見直しました/.test(m.text)), '履歴 2 版・「変更計画 v2 に見直しました（v1 の修正）」');
  const r4 = await c.send('P1って何してる？');
  assert(r4.intent === 'EXPLAIN_PLAN' && log[3][0] === 'explain' && log[3][2] === 'EXPLAIN_PLAN' && log[3][3] === 2 && c.activePlan() === v2 && c.planHistory().length === 2, 'EXPLAIN_PLAN → services.explain（最新版）。計画は変わらない（版も増えない）');
  const r5 = await c.send('何でこれ危ないの？');
  assert(r5.intent === 'EXPLAIN_REVIEW' && log[4][2] === 'EXPLAIN_REVIEW' && c.messages()[c.messages().length - 1].type === 'ANSWER' && c.messages()[c.messages().length - 1].data.kind === 'EXPLAIN_REVIEW', 'EXPLAIN_REVIEW → services.explain（kind EXPLAIN_REVIEW）→ ANSWER');
  const n = log.length;
  const r6 = await c.send('これで進めたい');
  const lastM = c.messages()[c.messages().length - 1];
  assert(r6.intent === 'REQUEST_PREVIEW' && log.length === n && lastM.role === 'toolkit' && lastM.data.kind === 'preview-ready' && lastM.data.version === 2 && lastM.data.readiness.undecided === 2, 'REQUEST_PREVIEW → AI 呼び出し無し・Toolkit の「準備」メッセージ（readiness は読み取りだけ）');
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
  assert(r12.intent === 'REVISE_PLAN' && r12.ok === false && /反映済み/.test(c.messages()[c.messages().length - 1].text) && c.planHistory().length === 2, '反映済みの計画は修正しない（AI を呼ばず、新しい計画として作り直す案内）');
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
  // loading 文言
  const slow = KTAiConversation.create({ services: { ...services, plan: (p) => new Promise(r => setTimeout(() => r(services.plan(p)), 5)) } });
  const sp = slow.send(GOAL); await tick();
  assert(slow.messages()[slow.messages().length - 1].text === '現在の設定を確認し、変更計画を作っています...', 'loading: PLAN は「現在の設定を確認し、変更計画を作っています...」');
  await sp;
  const sp2 = slow.send('通知はいらない'); await tick();
  assert(slow.messages()[slow.messages().length - 1].text === '変更計画を見直しています...', 'loading: REVISE は「変更計画を見直しています...」');
  await sp2;
}

// =========================================================
console.log('\n--- 3. AI タブ（mountRoot / switch / minimized / Templates から移行）---');
{
  const { doc, byId } = makeFakeDocument();
  const T = loadToolkit({ document: doc });
  const wrap = T.mountRoot();
  assert(wrap.ktTabs && wrap.ktTabs.TABS.includes('ai') && wrap.ktTabs.TABS[wrap.ktTabs.TABS.length - 1] === 'ai', 'TABS に ai（トップレベルの独立タブ）');
  const tabAi = byId.get('tab-ai'), viewAi = byId.get('view-ai');
  assert(tabAi && tabAi.tagName === 'BUTTON' && viewAi && viewAi.style.display === 'none' && viewAi.classList.contains('kt-fill-view') && /質問・変更計画・Toolkit Review/.test(tabAi.title), 'AI タブのボタンと view（初期は非表示・高さ追従の view）');
  assert(wrap.innerHTML.includes('>AI</button>') && wrap.innerHTML.includes('>Templates</button>'), 'タブ列に AI と Templates の両方');
  let switched = null; wrap.ktTabs.onSwitch((id) => { switched = id; });
  await tabAi.dispatch('click');
  assert(viewAi.style.display === 'block' && tabAi.classList.contains('active') && byId.get('view-health').style.display === 'none' && !byId.get('tab-health').classList.contains('active') && switched === 'ai', 'switch: AI タブで view-ai を表示・他を隠す・onSwitch が呼ばれる');
  await byId.get('tab-templates').dispatch('click');
  assert(viewAi.style.display === 'none' && byId.get('view-templates').style.display === 'block', 'switch: 戻せる');
  await byId.get('kt-mini').dispatch('click');
  assert(wrap.classList.contains('is-mini'), 'minimized: is-mini（body / tabs は CSS で隠れる）');
  await byId.get('kt-mini').dispatch('click');
  assert(!wrap.classList.contains('is-mini'), 'expanded: 戻る');
  assert(/#kt-toolkit\.is-mini \.body\{ display:none/.test(wrap.innerHTML) && /@media \(max-width: 760px\)/.test(wrap.innerHTML), 'mini の CSS と狭い幅の CSS が root にある');
  // Templates 側に AI mode は無い
  const src = renderTemplates.toString();
  assert(!src.includes('value="ai"') && !src.includes('mountAiDocsPanel') && !src.includes('mountAiWorkspace') && !src.includes('id="kt-template-ai"') && !src.includes('getContextInputs') && !src.includes("=== 'ai'"), 'Templates: AI mode（source=ai / AI パネルの mount / #kt-template-ai / getContextInputs）は無い');
  assert(src.includes('Templates (GitHub') && src.includes('Css') && src.includes('Snippets') && src.includes('Documents'), 'Templates は Templates / CSS / Snippets / Documents だけ（本来の用途）');
  // AI タブ側に移行済みの機能（最低限の一覧）
  const m = mount();
  await ticks();
  const html = m.host.innerHTML;
  const MIGRATED = { 'AI Prompt': 'kt-ai-copy-prompt', Markdown: 'kt-ai-copy-md', JSON: 'kt-ai-copy-json', Connection: 'kt-ai-connect-start', Assistant: 'kt-ai-ask', Planner: 'kt-ai-plan', Review: 'kt-ai-plan-result', Executor: 'kt-ai-pane-plan', Rollback: 'kt-ai-pane-plan', Composer: 'kt-ai-input' };
  assert(Object.values(MIGRATED).every(id => html.includes(`id="${id}"`)), `移行一覧: ${Object.keys(MIGRATED).join(' / ')} の要素が AI タブにある`);
  await m.panel.send(GOAL); await ticks();
  const plan = m.$('kt-ai-plan-result').innerHTML;
  assert(plan.includes('id="kt-ai-review"') && m.$('kt-ai-exec').innerHTML.includes('id="kt-ai-exec-start"'), 'Review / Executor（動作テスト環境へ反映）は AI タブの計画ペインに出る');
  assert(html.includes(KTContextUi_INTRO()) , '無料の説明文（KTContextUi.INTRO_TEXT）も AI タブに移行');
  function KTContextUi_INTRO() { return loadToolkit().KTContextUi.INTRO_TEXT.slice(0, 20); }
}

// =========================================================
console.log('\n--- 4. AI Workspace: free / connected / responsive / header ---');
{
  const f = mount({ paid: false });
  const free = f.$('kt-ai-free');
  assert(free.style.display === '' && /AI開発支援/.test(free.innerHTML) && /Nest Rec AI：<b>未接続<\/b>/.test(free.innerHTML) && /無料で利用できます/.test(free.innerHTML) && ['✓ AI Context', '✓ AI Prompt', '✓ Markdown', '✓ JSON'].every(t => free.innerHTML.includes(t)) && free.innerHTML.includes('id="kt-ai-free-generate"'), 'free state（接続機能なし）: AI開発支援 / 未接続 / 無料で利用できます ✓ AI Context ✓ AI Prompt ✓ Markdown ✓ JSON / [AI用Promptを生成]');
  assert(!free.innerHTML.includes('kt-ai-free-connect') && f.$('kt-ai-send').disabled === true && f.$('kt-ai-paid').style.display === 'none', 'free state（接続機能なし）: 接続ボタン無し・composer 無効・接続ペイン無し');
  await f.$('kt-ai-free').dispatch({ type: 'click', target: { id: 'kt-ai-free-generate' } });
  assert(f.panel.drawerState().open && f.panel.drawerState().pane === 'context', '[AI用Promptを生成] → Context ペインを開く');
  f.$('kt-ai-target-type').value = 'app'; f.$('kt-ai-question').value = 'このアプリの構造は？';
  await f.$('kt-ai-generate').dispatch('click');
  await f.$('kt-ai-copy-prompt').dispatch('click'); await f.$('kt-ai-copy-md').dispatch('click'); await f.$('kt-ai-copy-json').dispatch('click');
  assert(f.copies.length === 3 && f.copies[0].includes('## Context') && JSON.parse(f.copies[2]).contextVersion === '1' && f.$('kt-ai-preview').textContent.includes('## Context') && f.$('kt-ai-download').disabled === false, '無料機能: AI Prompt / Markdown / JSON のコピー・内蔵プレビュー・保存ボタン（Templates のエディタに依存しない）');
  await f.$('kt-ai-download').dispatch('click');
  assert(f.downloads.length === 1 && /^ai-context_app\d+_prompt\.md$/.test(f.downloads[0].name), '保存: ファイル名は従来どおり');
  // 未接続（接続機能あり）
  const u = mount({ connected: false });
  await ticks();
  assert(u.$('kt-ai-free').style.display === '' && u.$('kt-ai-free').innerHTML.includes('id="kt-ai-free-connect"') && u.$('kt-ai-send').disabled === true && /Nest Rec AI に接続するとチャット/.test(u.$('kt-ai-composer-note').textContent), 'free state（未接続）: [Nest Rec AIに接続] あり・composer 無効・案内文');
  assert(u.calls.health === 0, '未接続なら health を呼ばない');
  await u.$('kt-ai-free').dispatch({ type: 'click', target: { id: 'kt-ai-free-connect' } }); await ticks();
  assert(u.session.status().connected && u.$('kt-ai-free').style.display === 'none' && u.$('kt-ai-send').disabled === false && u.msgs().some(m => m.type === 'SYSTEM_NOTICE' && /接続しました/.test(m.text)), '[Nest Rec AIに接続] → 接続フロー → 接続済み: 無料パネルが消え composer 有効・通知');
  // 接続済み
  const c = mount();
  await ticks();
  assert(c.$('kt-ai-free').style.display === 'none' && c.$('kt-ai-send').disabled === false && c.$('kt-ai-input').disabled === false && /Enter で送信/.test(c.$('kt-ai-composer-note').textContent), 'connected state: composer 有効（Enter で送信）');
  { const h = c.host.innerHTML; const i = (t) => h.indexOf(t); assert(i('id="kt-ai-pane-context"') > 0 && i('id="kt-ai-pane-context"') < i('id="kt-ai-generate"') && i('id="kt-ai-generate"') < i('id="kt-ai-pane-connection"') && i('id="kt-ai-pane-connection"') < i('id="kt-ai-connect-start"') && i('id="kt-ai-pane-plan"') < i('id="kt-ai-plan-result"') && i('id="kt-ai-plan-result"') < i('id="kt-ai-pane-evidence"'), '無料出力は Context ペイン・接続は接続ペイン・計画は計画ペイン（削除していない）'); }
  const header = c.$('kt-ai-header').innerHTML;
  assert(/案件管理/.test(header) && new RegExp(`App ${FX.SELF_APP}`).test(header) && /Fields<\/span> 23/.test(header) && /Relations<\/span> \d+/.test(header) && /JS<\/span> ✓/.test(header) && /Incoming<\/span> ✓/.test(header) && /Health<\/span>/.test(header) && /Nest Rec AI<\/span> ✓/.test(header), 'Context ヘッダー: アプリ名 / App 341 / Fields / Relations / JS ✓ / Incoming ✓ / Health / Nest Rec AI ✓');
  assert(c.$('kt-ai-header-detail').style.display === 'none' || c.$('kt-ai-header-detail').style.display === undefined, 'ヘッダーの詳細は展開式（初期は閉）');
  await c.$('kt-ai-header').dispatch({ type: 'click', target: { id: 'kt-ai-header-toggle' } });
  assert(c.$('kt-ai-header-detail').style.display === '', '詳細を展開できる');
  // レスポンシブ（CSS）
  const css = c.host.innerHTML;
  assert(/@media \(max-width: 760px\)\{[^}]*#kt-ai-workspace \.kt-ai-ws-body\{ flex-direction:column; \}/.test(css) && /\.kt-ai-drawer\{ flex:0 0 auto; max-height:55%; \}/.test(css) && /\.kt-ai-card \.kt-ai-mermaid-row\{ flex-direction:column; \}/.test(css), 'narrow width: 会話と drawer は縦積み・Mermaid は縦表示（Edge 半幅）');
  assert(/\.kt-ai-card \.kt-ai-mermaid-row > div\{[^}]*overflow-x:auto/.test(css), 'Mermaid は横スクロール可');
  // drawer
  assert(c.$('kt-ai-drawer').style.display === 'none' && c.panel.drawerState().open === false, 'drawer は既定で閉じている（会話が主役）');
  await c.$('kt-ai-header').dispatch({ type: 'click', target: { id: 'kt-ai-drawer-toggle' } });
  assert(c.panel.drawerState().open === true && c.$('kt-ai-drawer').style.display === 'flex' && c.$('kt-ai-pane-plan').style.display === 'block' && c.$('kt-ai-pane-context').style.display === 'none', 'ヘッダーの開閉ボタンで drawer（計画ペイン）を開く');
  await c.$('kt-ai-drawer-tabs').dispatch({ type: 'click', target: { dataset: { pane: 'evidence' } } });
  assert(c.panel.drawerState().pane === 'evidence' && c.$('kt-ai-pane-evidence').style.display === 'block' && /kt-ai-dtab active" data-pane="evidence"/.test(c.$('kt-ai-drawer-tabs').innerHTML), 'drawer のタブ切り替え（根拠）');
  await c.$('kt-ai-drawer-tabs').dispatch({ type: 'click', target: { id: 'kt-ai-drawer-close' } });
  assert(c.panel.drawerState().open === false && c.$('kt-ai-drawer').style.display === 'none', '閉じる');
  assert(/このアプリについて質問したり、実現したいことを伝えてください/.test(c.chat()), '会話が空のときの案内');
}

// =========================================================
console.log('\n--- 5. AI Workspace: 会話（ASK / PLAN / REVISE / EXPLAIN / PREVIEW / Review 統合）---');
{
  const m = mount();
  await ticks();
  // ASK
  m.$('kt-ai-input').value = 'このフィールドは何に使ってる？';
  await m.$('kt-ai-send').dispatch('click'); await ticks();
  assert(m.calls.ask.length === 1 && m.calls.plan.length === 0 && m.calls.ask[0].ctx.contextVersion === '1' && m.calls.ask[0].ctx.question === 'このフィールドは何に使ってる？' && !('planContext' in m.calls.ask[0].ctx), 'ASK: assistant-qa（contextVersion 1）だけ。Planner は呼ばない。planContext 無し');
  assert(m.types().join() === 'USER,ANSWER' && /kt-ai-answer-card/.test(m.chat()) && /ルックアップのコピー先/.test(m.chat()) && m.$('kt-ai-input').value === '', 'ASK → 回答カード（送信後に入力欄は空）');
  const r1 = m.calls.ask[0];
  assert(JSON.stringify(r1.ctx).length < 300000 && !JSON.stringify(r1.ctx).includes('"messages"'), 'LLM へ会話履歴は送らない（Context だけ）');
  // 曖昧な対象 → 候補
  await m.panel.send('名前の使い方を教えて'); await ticks();
  const lastA = m.msgs()[m.msgs().length - 1];
  assert(lastA.data?.kind === 'candidates' ? (lastA.data.candidates.length >= 2 && /kt-ai-candidates-card/.test(m.chat())) : lastA.type === 'ANSWER', 'ASK: 対象が曖昧なら候補を出す（決めない）／特定できれば回答');
  // PLAN
  await m.panel.send(GOAL); await ticks();
  assert(m.calls.plan.length === 1 && m.calls.plan[0].ctx.contextVersion === 'planner-1' && m.calls.plan[0].ctx.goal === GOAL && !m.calls.plan[0].ctx.revision, 'PLAN: change-planner（planner-1。goal。revision 無し）');
  const v1 = m.conv().activePlan();
  assert(v1.version === 1 && m.panel.lastPlan() === v1.plan && m.panel.lastReview() === v1.review && v1.review.steps.length === 2, 'PLAN → v1。lastPlan / lastReview（Review / Decision / Executor の入力）は v1 に同期');
  const chat1 = m.chat();
  assert(/変更計画 v1<\/b>/.test(chat1) && /kt-ai-plan-card/.test(chat1) && /＋ 更新状況フィールドを追加/.test(chat1) && /＋ 一覧「担当者別」を追加/.test(chat1) && /Toolkit Review<\/b>/.test(chat1) && /data-act="open-plan"/.test(chat1) && /data-act="before-after"/.test(chat1) && /data-act="open-review"/.test(chat1), 'Plan Card: 変更計画 v1 / ＋ 手順 / Toolkit Review の件数 / [詳細][Before / After][Reviewを開く]');
  assert(/＋ 新規フィールド<\/b>/.test(chat1) && /<b>更新状況<\/b>/.test(chat1) && /DROP_DOWN/.test(chat1) && /理由：更新状況を表すフィールドが無いため/.test(chat1) && /＋ 一覧<\/b>/.test(chat1) && /提案の内容（2 件）/.test(chat1), 'Proposed Asset Cards: ＋ 新規フィールド（名前 / 型 / 理由）・＋ 一覧（共通カード）');
  assert(/Toolkitで確認した結果<\/b>/.test(chat1) && /✓ 安全に反映可能<\/span><b>\d+ 件/.test(chat1) && /△ 確認が必要<\/span><b>\d+ 件/.test(chat1) && /× 実行不可<\/span><b>0 件/.test(chat1) && /競合候補<\/span><b>\d+ 件/.test(chat1) && /実行前レビューを開く/.test(chat1), 'Review Card: Toolkitで確認した結果 ✓ / △ / × / 競合候補 / [実行前レビューを開く]');
  assert(/チャットの文章では承認になりません/.test(chat1), 'Review Card に「チャットの文章では承認になりません」');
  assert(m.$('kt-ai-plan-result').innerHTML.includes('実行前レビュー（Toolkit 検証）') && m.$('kt-ai-plan-result').innerHTML.includes('kt-ai-decision') && m.panel.drawerState().open === true && m.panel.drawerState().pane === 'plan', 'Review 統合: drawer の計画ペインに実行前レビュー（判断 select）が出て、計画受信で開く');
  // Before / After
  await clickChat(m, 'before-after', { plan: v1.planId, version: '1' }); await ticks();
  assert(m.types()[m.types().length - 1] === 'DIFF' && /kt-ai-diff-card/.test(m.chat()) && /Before \/ After<\/b>/.test(m.chat()) && /P2<\/b>/.test(m.chat()), '[Before / After] → DIFF カード（Review の diff を会話に展開）');
  // Reviewを開く
  m.panel.closeDrawer();
  await clickChat(m, 'open-review', { plan: v1.planId, version: '1' });
  assert(m.panel.drawerState().open === true && m.panel.drawerState().pane === 'plan', '[Reviewを開く] → drawer の計画ペイン');
  // REVISE
  await m.panel.send('新しい承認者は作らず既存の承認者を使って'); await ticks();
  const rv = m.calls.plan[1];
  assert(m.calls.plan.length === 2 && rv.ctx.goal === GOAL && rv.ctx.revision && rv.ctx.revision.basedOnVersion === 1 && rv.ctx.revision.request === '新しい承認者は作らず既存の承認者を使って' && rv.ctx.revision.previousPlan.steps.length === 2 && rv.ctx.revision.previousPlan.proposedFields[0].temporaryId === 'NEW_FIELD_1' && rv.ctx.revision.previousPlan.steps[0].spec.fieldType === 'DROP_DOWN', 'REVISE: 同じ goal ＋ revision（basedOnVersion 1 / request / 前回の計画の要約: steps・proposedFields・spec）を送る');
  assert(rv.ctx.retrieval.fields.some(f => f.code === 'approver') || rv.ctx.retrieval.matchedTerms.some(t => /承認者/.test(t.key)), 'revision の語（承認者）も辞書照合に使う');
  const v2 = m.conv().activePlan();
  assert(v2.version === 2 && v2.basedOnVersion === 1 && v1.status === 'SUPERSEDED' && m.panel.lastPlan() === v2.plan && m.panel.lastReview() === v2.review && v2.plan.steps[0].actionType === 'REUSE_FIELD', 'REVISE → v2 が最新。lastPlan / lastReview は v2（v1 は SUPERSEDED）');
  assert(/変更計画 v2<\/b>/.test(m.chat()) && /v1 の修正/.test(m.chat()) && /旧版（SUPERSEDED）/.test(m.chat()) && /この版は最新ではありません/.test(m.chat()) && /↻ 既存「担当者」を利用/.test(m.chat()), 'v2 カード（v1 の修正）・v1 カードは旧版の表示');
  // EXPLAIN_PLAN
  await m.panel.send('P1って何してる？'); await ticks();
  const ex = m.calls.ask[m.calls.ask.length - 1];
  assert(ex.ctx.contextVersion === '1' && ex.ctx.planContext && ex.ctx.planContext.kind === 'EXPLAIN_PLAN' && ex.ctx.planContext.plan.version === 2 && ex.ctx.planContext.plan.steps.length === 2 && ex.ctx.planContext.review && ex.ctx.planContext.review.steps.length === 2 && ex.ctx.question === 'P1って何してる？', 'EXPLAIN_PLAN: Q&A Context に planContext（計画 v2 の要約 ＋ Review の写し）');
  assert(ex.ctx.facts.every(f => /^E\d+$/.test(f.id)) && ex.ctx.facts.some(f => f.kind === 'overview') && ex.ctx.facts.length <= 120 && !ex.ctx.planContext.plan.steps[0].spec, '説明の facts は計画が引用した根拠と概要だけ（ID は計画と同じ）。spec は送らない');
  assert(m.conv().planHistory().length === 2 && m.conv().activePlan() === v2 && /変更計画の説明（計画は変更していません）/.test(m.chat()), 'Explain は計画を変えない（版は増えない）・回答カードに明記');
  // EXPLAIN_REVIEW: AI が「実は安全です」と言っても Review は変わらない
  const before = JSON.stringify(m.panel.lastReview());
  await m.panel.send('何でこれ危ないの？'); await ticks();
  const ex2 = m.calls.ask[m.calls.ask.length - 1];
  assert(ex2.ctx.planContext.kind === 'EXPLAIN_REVIEW' && /実は安全です/.test(m.chat()) && JSON.stringify(m.panel.lastReview()) === before && m.panel.lastReview() === v2.review && /Toolkit Review の説明（判定は Toolkit が正本/.test(m.chat()), 'EXPLAIN_REVIEW: AI の説明で Review（判定・safety）は変わらない（Toolkit が正本）');
  // REQUEST_PREVIEW（承認なし）
  const w0 = writes(m).length;
  await m.panel.send('これで進めたい'); await ticks();
  const pr = m.msgs()[m.msgs().length - 1];
  assert(pr.data.kind === 'preview-ready' && pr.data.readiness.approved === 0 && pr.data.readiness.undecided === 2 && /承認された手順がまだありません/.test(pr.text) && /実行前レビューを開く/.test(m.chat()) && m.panel.executorState().stage === 'idle' && writes(m).length === w0, 'REQUEST_PREVIEW（承認前）: 「承認された手順がまだありません」＋[実行前レビューを開く]。Executor は動かない・書き込み 0');
  // 承認してから「これで進めたい」
  m.panel.decide('P1', 'approve'); m.panel.decide('P2', 'approve');
  await m.panel.send('これで進めたい'); await ticks();
  const pr2 = m.msgs()[m.msgs().length - 1];
  assert(pr2.data.readiness.approved === 2 && pr2.data.readiness.executable === 1 && pr2.data.readiness.unsupported === 1 && /動作テスト環境へ反映する準備ができました/.test(pr2.text) && /✓ 承認済み・実行可能<\/span><b>1 件/.test(m.chat()) && /△ 承認済みだが未対応（計画のみ）<\/span><b>1 件/.test(m.chat()), 'REQUEST_PREVIEW（承認後）: ✓ 実行可能 1 / △ 未対応 1（REUSE_FIELD は計画のみ）');
  assert(m.panel.executorState().stage === 'idle' && writes(m).length === w0 && !/id="kt-ai-exec-confirm"/.test(m.$('kt-ai-exec').innerHTML), 'チャットでは Executor を開始しない（prepare も最終確認も出ない）');
}

// =========================================================
console.log('\n--- 6. Executor / Rollback 統合と Versioning（v1 は Executor へ進めない）---');
{
  const m = mount();
  await ticks();
  await m.panel.send(GOAL); await ticks();
  const v1 = m.conv().activePlan();
  m.panel.decide('P1', 'approve'); m.panel.decide('P2', 'approve');
  await m.panel.send('新しい承認者は作らず既存の承認者を使って'); await ticks();
  const v2 = m.conv().activePlan();
  assert(m.panel.reviewOutput().approvedSteps.length === 0 && m.panel.reviewOutput().plan.requestId === v2.plan.requestId && m.panel.reviewOutput().plan.requestId !== v1.plan.requestId, '版が変わると判断はやり直し（v1 の承認は v2 に持ち越さない）・executorOutput は v2');
  m.panel.decide('P2', 'approve');
  const out = m.panel.reviewOutput();
  assert(out.plan.steps[0].actionType === 'REUSE_FIELD' && out.approvedSteps.join() === 'P2', 'Executor の入力（executorOutput）は v2 だけ（v1 の ADD_FIELD は含まれない）');
  await clickPlan(m, 'kt-ai-exec-start'); await ticks();
  assert(m.panel.executorState().stage === 'confirm' && writes(m).length === 0 && !m.msgs().some(x => x.type === 'EXECUTION'), '「動作テスト環境へ反映」→ prepare（読み取りだけ）→ 最終確認。会話にはまだ実行カードが出ない');
  await clickPlan(m, 'kt-ai-exec-go'); await ticks(8);
  const st = m.panel.executorState();
  assert(st.stage === 'done' && st.execution.status === 'DONE' && m.mock.st.views['担当者別'] && !m.mock.st.fields.progress, '最終確認 → 反映: v2 の一覧だけが入る（v1 の新規フィールドは作られない）');
  const chat = m.chat();
  assert(m.msgs().filter(x => x.type === 'EXECUTION').length === 1 && /動作テスト環境への反映が完了しました。/.test(chat) && /✓ 1 件 VERIFIED/.test(chat) && /Simulation一致 ✓/.test(chat) && /運用環境には反映されていません。/.test(chat) && /data-act="exec-details"/.test(chat) && /data-act="rollback"/.test(chat), 'Execution Result カード: 完了 / ✓ 1 件 VERIFIED / Simulation一致 ✓ / 運用環境には反映されていません / [詳細][変更前の状態に戻す]');
  assert(m.msgs().some(x => x.type === 'SYSTEM_NOTICE' && /動作テスト環境の設定が変更されました/.test(x.text)) && v2.status === 'EXECUTED' && v2.executionId === st.execution.executionId && v1.status === 'SUPERSEDED', 'SYSTEM: 動作テスト環境の設定が変更されました。v2 は EXECUTED（実行 ID を保持）');
  const audit = m.panel.auditJson();
  assert(audit.plan.steps[0].actionType === 'REUSE_FIELD' && audit.execution.executionId === st.execution.executionId, '監査 JSON は実行した版（v2）の計画');
  // REQUEST_ROLLBACK（即 Rollback しない）
  const w1 = writes(m).length;
  await m.panel.send('やっぱり元に戻して'); await ticks();
  const rr = m.msgs()[m.msgs().length - 1];
  assert(rr.data.kind === 'rollback-ready' && rr.data.executionId === st.execution.executionId && /変更前の状態へ戻せます/.test(m.chat()) && m.panel.executorState().stage === 'done' && writes(m).length === w1 && m.mock.st.views['担当者別'], 'REQUEST_ROLLBACK → 「変更前の状態へ戻せます」[変更前の状態に戻す]。Rollback はまだ始まらない（書き込み 0・一覧は残る）');
  await clickChat(m, 'rollback', { execution: st.execution.executionId }); await ticks();
  assert(m.panel.executorState().stage === 'rollback-confirm' && writes(m).length === w1 && m.$('kt-ai-exec').innerHTML.includes('id="kt-ai-exec-rollback-go"') && m.msgs().filter(x => x.type === 'ROLLBACK').length === 1 && /確認画面で「変更前の状態に戻す」を押すと戻します/.test(m.chat()), 'カードの [変更前の状態に戻す] → 現在の設定を確認（書き込みなし）→ 既存の Rollback 確認（drawer）。会話には ROLLBACK カード');
  await clickPlan(m, 'kt-ai-exec-rollback-go'); await ticks(8);
  assert(m.panel.executorState().stage === 'rolled-back' && !m.mock.st.views['担当者別'] && /(変更前の状態へ戻しました|実行前の状態に戻しました)/.test(m.chat()) && /✓ 1 件 ROLLBACK_VERIFIED/.test(m.chat()) && v2.status === 'ROLLED_BACK' && m.msgs().some(x => x.type === 'SYSTEM_NOTICE' && /変更前の状態に戻しました/.test(x.text)), 'Rollback 確認 → 戻す → Rollback Result カード「変更前の状態へ戻しました。✓ 1 件 ROLLBACK_VERIFIED」・v2 は ROLLED_BACK');
  assert(m.panel.auditJson().rollback && m.panel.auditJson().plan.steps[0].actionType === 'REUSE_FIELD', 'rollback は正しい実行（v2）に結び付く（監査 JSON）');
  // 反映後に新しい計画を作っても、戻していない実行は失わない（別シナリオ）
  const n = mount();
  await ticks();
  await n.panel.send(GOAL); await ticks();
  n.panel.decide('P1', 'approve'); n.panel.decide('P2', 'approve');
  await clickPlan(n, 'kt-ai-exec-start'); await ticks(); await clickPlan(n, 'kt-ai-exec-go'); await ticks(8);
  assert(n.panel.executorState().stage === 'done' && n.mock.st.fields.progress, 'v1 を反映');
  await n.panel.send('契約終了30日前に担当者へ通知したい'); await ticks();
  assert(n.msgs()[n.msgs().length - 1].data?.kind === 'choices' || n.conv().planHistory().length === 2, '反映済みのあとの新しい要望 → 新しい計画（または確認）');
  await n.panel.send('契約終了30日前に担当者へ通知したい', { intent: 'PLAN' }); await ticks();
  assert(n.conv().planHistory().length >= 2 && n.panel.executorState().stage === 'done' && n.panel.executorState().execution && /data-act="rollback"/.test(n.chat()), '新しい計画を作っても、戻していない実行結果（Rollback 可能）は残る');
}

// =========================================================
console.log('\n--- 7. Safety: 自然言語 ≠ 承認（write 0 件）/ errors / rate limit / retry / cancel ---');
{
  const m = mount();
  await ticks();
  await m.panel.send(GOAL); await ticks();
  for (const t of ['全部承認', 'そのまま実行', 'いいから反映して', '実行して']) {
    await m.panel.send(t); await ticks();
    const last = m.msgs()[m.msgs().length - 1];
    assert(last.data?.kind === 'preview-ready' && writes(m).length === 0 && m.panel.executorState().stage === 'idle' && [...(m.panel.reviewOutput().approvedSteps)].length === 0, `Safety: 「${t}」→ 準備メッセージだけ。承認 0・Executor idle・write 0 件`);
  }
  await m.panel.send('戻して'); await ticks();
  assert(writes(m).length === 0 && m.panel.executorState().stage === 'idle' && /元に戻せる反映はありません/.test(m.chat()), 'Safety: 「戻して」だけでは write 0 件（反映していない）');
  assert(!/<button[^>]*>[^<]*運用環境へ反映/.test(m.chat()) && !/deploy/i.test(m.chat()), '会話にも「運用環境へ反映」/ deploy は無い');
  // errors
  const e1 = mount({ askError: () => new KTAiClient.AiClientError({ code: 'UPSTREAM_ERROR', message: 'x', requestId: 'e-1' }) });
  await ticks();
  e1.$('kt-ai-input').value = 'このフィールドは何に使ってる？';
  await e1.$('kt-ai-send').dispatch('click'); await ticks();
  assert(e1.types()[e1.types().length - 1] === 'ERROR' && /kt-ai-error-card/.test(e1.chat()) && /AI プロバイダが応答しませんでした/.test(e1.chat()) && /\[UPSTREAM_ERROR\]/.test(e1.chat()) && /data-act="retry"/.test(e1.chat()) && e1.$('kt-ai-input').value === 'このフィールドは何に使ってる？', 'errors: ERROR カード（文言・code・[再試行]）。入力欄の内容は残る');
  // rate limit → retry
  let fail = true;
  const r = mount({ askError: () => (fail ? new KTAiClient.AiClientError({ code: 'RATE_LIMITED', message: 'x', retryAfterSeconds: 42, requestId: 'e-2' }) : null) });
  await ticks();
  r.$('kt-ai-input').value = 'このフィールドは何に使ってる？';
  await r.$('kt-ai-send').dispatch('click'); await ticks();
  assert(/アクセスが集中しています/.test(r.chat()) && /約42秒後に再実行できます/.test(r.chat()) && /\[RATE_LIMITED\]/.test(r.chat()) && r.$('kt-ai-input').value === 'このフィールドは何に使ってる？' && r.$('kt-ai-send').disabled === false, 'rate limit: 文言・retryAfter・composer の内容を失わない・再送できる');
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
