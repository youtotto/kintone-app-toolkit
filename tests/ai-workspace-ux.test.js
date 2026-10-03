// Development Workspace UX Finalization（Phase 19）: 「開発支援」タブ・左 Conversation（履歴）/ 右 Workspace（現在の成果物の正本）・
// 要約カード・Active Artifact・自動表示の抑制・Human Approval は右・無料出力は右・狭い幅・Customize → 開発支援・ViewModel
//
// 検証内容（§30）: tab label 開発支援 / internal id 維持 / chat plan summary / full plan only workspace / review summary / full review only workspace /
//   code summary / full code only workspace / execution summary / Evidence detail workspace / old plan / active version / Human Decision workspace only /
//   free context / narrow width / Customize→開発支援 / ViewModel / auto navigation
//
// 実行方法: node tests/ai-workspace-ux.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { makeFakeHost, makeFakeDocument } = require('./helpers/fake-dom.js');
const T = loadToolkit();
const { KTDeps, KTScan, KTContext, KTContextUi, KTAiClient, KTAiConversation, KTAiChatUi, KTAiWorkspaceViewModel: VM, KTPlanReview, mountAiWorkspace } = T;
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const { buildScanPayload } = require('./helpers/scan-payload.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const SRC_TEXT = fs.readFileSync(path.join(__dirname, '..', 'kintoneAppToolkit.user.js'), 'utf8');

// ---- fixtures（ai-customization / ai-first-ux と同じ形）----
const FIELD_ON_OFF = ["(function () {", "  'use strict';", "  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {", "    var record = event.record;", "    if (record['ステータス'].value === '承認待ち') {", "      record['amount'].disabled = true;", "    }", "    return event;", "  });", "})();"].join('\n');
function buildInputs() {
  const data = FX.makeData();
  data.customize.desktop.js.push({ type: 'FILE', file: { contentType: 'text/javascript', fileKey: '20261003000000EEEE', name: 'fieldOnOff.js', size: '300' } });
  const fieldsN = KTDeps.normalizeFields(data.fields);
  const deps = KTDeps.buildDependencyData(data, fieldsN);
  const files = [...FX.files, { name: 'fieldOnOff.js', target: 'desktop', kind: 'js', text: FIELD_ON_OFF }];
  const fieldRows = fieldsN.map(f => ({ code: f.code, label: f.label, type: f.rawType }));
  const scan = buildScanPayload({ KTScan, KTDeps }, { appId: FX.SELF_APP, files, fields: fieldRows, deps, skippedUrlFiles: FX.skippedUrlFiles });
  scan.results = KTScan.analyze({ fields: fieldRows, files: files.filter(f => f.kind === 'js'), snippet: { before: 24, after: 48 } });
  KTDeps.mergeScannerEdges(deps, scan);
  KTDeps.applyIncomingRefs(deps, FX.incoming);
  return { data, deps, scan, incoming: FX.incoming };
}
const INPUTS = buildInputs();
const GOAL = '更新状況を管理したい';
const GOAL_HYBRID = '100万円以上なら部長承認にして、承認後は金額を編集できなくしたい';
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], customizationId: null, ...o });
const mkStep = (id, actionType, targetKind, targetRef, sp, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' }, ...extra });
const META = { requestId: 'pl-1', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm' }, usage: { usedThisMonth: 1, monthlyLimit: 20 } };
const OPTIONS = ['未着手', '進行中', '完了'];
const PLAN_V1 = { ok: true, contractVersion: '2.1', meta: META, plan: { goal: GOAL, assessment: { summary: '更新状況を表すフィールドが無いので追加します。', usableExistingFields: [], usableExistingSettings: [], missingCapabilities: ['更新状況'], uncertainties: [] }, relevantFields: [], proposedFields: [{ temporaryId: 'NEW_FIELD_1', label: '更新状況', suggestedCode: 'progress', type: 'DROP_DOWN', typeValid: true, required: false, options: OPTIONS, reason: '更新状況を表すフィールドが無いため', evidenceIds: [], alternativeExistingFieldCode: null, codeConflict: false, labelDuplicate: false }], steps: [mkStep('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'DROP_DOWN', options: OPTIONS }, { title: '更新状況フィールドを追加' }), mkStep('P2', 'ADD_VIEW', 'VIEW', '担当者別', { name: '担当者別', fields: ['owner', 'case_name', 'NEW_FIELD_1'], filterCond: 'owner in (LOGINUSER())', sort: 'due_date asc' }, { dependsOn: ['P1'], title: '一覧「担当者別」を追加' })], alternatives: [], impact: [], questions: [{ id: 'Q1', question: '更新状況の選択肢は 3 段階でよいですか', reason: 'goal から決められない', relatedEvidenceIds: [] }], unknowns: [], planConfidence: 'INFERRED' } };
const PLAN_V2 = { ok: true, contractVersion: '2.1', meta: { ...META, requestId: 'pl-2' }, plan: { goal: GOAL, assessment: { summary: '既存の担当者を使い、一覧の追加だけにします。', usableExistingFields: [], usableExistingSettings: [], missingCapabilities: [], uncertainties: [] }, relevantFields: [], proposedFields: [], steps: [mkStep('P1', 'REUSE_FIELD', 'FIELD', 'owner', {}, { title: '既存「担当者」を利用' }), mkStep('P2', 'ADD_VIEW', 'VIEW', '担当者別', { name: '担当者別', fields: ['owner', 'case_name'], filterCond: 'owner in (LOGINUSER())', sort: 'due_date asc' }, { title: '一覧「担当者別」を追加' })], alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED' } };
const cust = (o = {}) => ({ customizationId: 'C1', requirement: '承認後（完了）は金額を編集できなくする', whyStandardInsufficient: 'フィールドのアクセス権はステータスで切り替えられない', strategy: 'EXTEND_EXISTING_JS', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [{ name: 'fieldOnOff.js', target: 'desktop', reason: '同じフィールド（金額）を制御している' }], risks: [], questions: [], dependsOn: [], evidenceIds: [], ...o });
const STD_STEP = () => mkStep('P1', 'ADD_VIEW', 'VIEW', '承認済み', { name: '承認済み', fields: ['case_name', 'amount', 'approver'], filterCond: 'ステータス in ("完了")', sort: 'due_date asc' }, { title: '一覧「承認済み」を追加', solution: 'STANDARD' });
const JS_STEP = () => mkStep('P2', 'CUSTOMIZATION_REQUIRED', 'JS', 'fieldOnOff.js', { customizationId: 'C1' }, { title: '承認後は金額を編集できなくする（JavaScript）', solution: 'CUSTOMIZATION' });
const PLAN_HYBRID = { ok: true, contractVersion: '2.1', meta: { ...META, requestId: 'pl-h1' }, plan: { goal: GOAL_HYBRID, solution: 'HYBRID', assessment: { summary: '承認フローは標準のプロセス管理、承認後のロックは JavaScript が必要です。', usableExistingFields: [], usableExistingSettings: [], missingCapabilities: [], uncertainties: [] }, relevantFields: [], proposedFields: [], steps: [STD_STEP(), JS_STEP()], customizations: [cust()], alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED' } };
const hash = (t) => KTScan.hashText(t);
const PATCH_GOOD = { baseHash: hash(FIELD_ON_OFF), operations: [{ type: 'INSERT_AFTER', anchor: "      record['amount'].disabled = true;\n    }", content: "    if (record['ステータス'] && record['ステータス'].value === '完了') {\n      record['amount'].disabled = true;\n    }" }] };
const PATTERNS = [{ id: 'field-disable', purpose: '条件に応じてフィールドの編集可否を制御する', implementation: 'JAVASCRIPT', preferredStandardAlternatives: ['フィールドのアクセス権'], matched: {}, score: 7 }];
const genResponse = (ctx, g) => ({ ok: true, contractVersion: '2.1', meta: { requestId: 'gen-1', usage: { usedThisMonth: 3, monthlyLimit: 20 }, normalization: { warnings: [] }, gateway: { feature: 'customization-generator' } }, generated: { strategy: ctx.customization.strategy, targetFile: ctx.existingFile?.name || 'amountWarning.js', summary: ctx.customization.requirement, events: ctx.customization.events, fields: ctx.customization.fields, apis: [], assumptions: [], warnings: [], gatewayChecks: { security: [] }, patterns: PATTERNS, ...g } });
const genPatch = (patch = PATCH_GOOD) => ({ strategy: 'EXTEND_EXISTING_JS', targetFile: 'fieldOnOff.js', summary: '完了でも金額を編集不可にする', code: patch.operations.map(o => o.content).join('\n'), patch, events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [] });
const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'] }, 'change-planner': { implemented: true, promptVersions: ['1'] }, 'customization-generator': { implemented: true, promptVersions: ['1'] } } }, usage: { monthlyLimit: 20, usedThisMonth: 1 } };
const makeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const answerFor = (ctx, text) => ({ ok: true, contractVersion: '2.1', meta: { requestId: 'qa-1', usage: { usedThisMonth: 2, monthlyLimit: 20 }, normalization: { warnings: [] } }, answer: text, facts: ctx.facts.length ? [{ text: 'fact', evidenceIds: [ctx.facts[0].id] }] : [], analysis: [], recommendations: [], unknowns: [] });
const tick = () => new Promise(r => setTimeout(r, 0));
const ticks = async (n = 4) => { for (let i = 0; i < n; i++) await tick(); };
function mount({ inputs = INPUTS, paid = true, plans = null, now = null } = {}) {
  const storage = makeStorage();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' });
  settings.setConsent(true);
  const calls = { ask: [], plan: [], generate: [] };
  const client = {
    async getHealth() { return HEALTH; },
    async ask({ ctx, requestId }) { calls.ask.push({ ctx }); const v = KTAiClient.validateAnswer(answerFor(ctx, 'このフィールドは金額です。'), ctx); return { ...v.normalized, requestId, clientWarnings: v.warnings }; },
    async plan({ ctx, requestId }) { calls.plan.push({ ctx }); const resp = plans ? plans(ctx) : (ctx.revision ? PLAN_V2 : PLAN_V1); const v = KTAiClient.validatePlan(resp, ctx); return { ...v.normalized, requestId, clientWarnings: v.warnings }; },
    async generate({ ctx, requestId }) { calls.generate.push({ ctx }); const v = KTAiClient.validateGenerated(genResponse(ctx, genPatch({ ...PATCH_GOOD, baseHash: ctx.existingFile?.hash || PATCH_GOOD.baseHash })), ctx); if (!v.ok) throw new Error(v.errors[0].message); return { ...v.normalized, requestId, clientWarnings: v.warnings }; },
  };
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner,customization-generator', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const flow = { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false };
  const host = makeFakeHost();
  const copies = [], opened = [];
  const mock = makeKintoneMock(inputs.data, { jsSources: [{ name: 'fieldOnOff.js', target: 'desktop', text: FIELD_ON_OFF }] });
  const clock = { t: 1000000 };
  const panel = mountAiWorkspace(host, {
    getInputs: () => inputs, copyText: async (t) => { copies.push(t); return true; }, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' },
    ...(paid ? { settings, session, hostname: 't.cybozu.com', connectFlow: flow } : {}),
    executor: { api: mock.api, appId: '341' }, openCustomize: (x) => { opened.push(x); return { found: true }; },
    now: now || (() => clock.t),
  });
  const $ = (id) => host.querySelector(`#${id}`);
  const ws = () => ['kt-ai-subject-info', 'kt-ai-spec', 'kt-ai-plan-result', 'kt-ai-review-result', 'kt-ai-exec', 'kt-ai-jsreg', 'kt-ai-code-head', 'kt-ai-code-review'].map(id => $(id).innerHTML).join('\n');
  return { host, panel, $, calls, copies, opened, mock, clock, ws, conv: () => panel.conversation(), chat: () => $('kt-ai-chat').innerHTML, msgs: () => panel.conversation().state.messages, types: () => panel.conversation().state.messages.map(m => m.type) };
}
const clickChat = (m, act, extra = {}) => m.$('kt-ai-chat').dispatch({ type: 'click', target: { dataset: { act, ...extra } } });
const clickPane = (m, pane, target) => m.$(`kt-ai-pane-${pane}`).dispatch({ type: 'click', target });
const clickTab = (m, pane) => m.$('kt-ai-drawer-tabs').dispatch({ type: 'click', target: { dataset: { pane } } });
const confirmSpec = async (m) => { const v = m.conv().activePlan(); if (v?.spec) await clickPane(m, 'plan', { dataset: { act: 'confirm-spec', plan: v.planId, version: String(v.version) } }); };
const writes = (m) => m.mock.calls.filter(c => !c.startsWith('GET'));

(async () => {
// =========================================================
console.log('\n--- §1. Tab Naming: 表示名「開発支援」・内部 id は ai / AI Workspace のまま ---');
{
  const { doc, byId } = makeFakeDocument();
  const T2 = loadToolkit({ document: doc });
  const wrap = T2.mountRoot();
  const tab = byId.get('tab-ai');
  assert(tab && tab.id === 'tab-ai' && wrap.innerHTML.includes('>開発支援</button>') && !wrap.innerHTML.includes('>AI</button>') && wrap.ktTabs.TABS.includes('ai') && byId.has('view-ai'), 'タブの表示名は「開発支援」、内部 id（tab-ai / view-ai / TABS "ai"）は維持');
  assert(/開発支援/.test(tab.title) && /変更計画/.test(tab.title) && /AI Workspace/.test(tab.title), 'タブの title: 何ができるか（内部名 AI Workspace）');
  assert(/<b>開発支援<\/b>/.test(wrap.innerHTML), '移行案内も「開発支援」');
  assert(/function mountAiWorkspace\(/.test(SRC_TEXT) && /KTAiWorkspaceViewModel/.test(SRC_TEXT), '内部名 AI Workspace（mountAiWorkspace / KTAiWorkspaceViewModel）');
}

// =========================================================
console.log('\n--- §2. Workspace Architecture: 左 Conversation / 右 Workspace（常設）・ペイン・作業状態・ヘッダー ---');
{
  const m = mount();
  await ticks();
  const html = m.host.innerHTML;
  for (const p of ['plan', 'review', 'code', 'exec', 'evidence', 'context', 'connection']) assert(html.includes(`id="kt-ai-pane-${p}"`) && html.includes(`data-pane="${p}"`), `Workspace のペイン ${p}（${VM.PANE_JA[p]}）`);
  assert(/data-pane="plan">計画/.test(m.$('kt-ai-drawer-tabs').innerHTML) && /検証/.test(m.$('kt-ai-drawer-tabs').innerHTML) && /コード/.test(m.$('kt-ai-drawer-tabs').innerHTML) && /実行/.test(m.$('kt-ai-drawer-tabs').innerHTML) && /根拠/.test(m.$('kt-ai-drawer-tabs').innerHTML), 'タブ名: 計画 / 検証 / コード / 実行 / 根拠 / Context / 接続');
  assert(m.panel.drawerState().open === true && m.panel.drawerState().pane === 'plan' && m.$('kt-ai-drawer').style.display === 'flex', '右 Workspace は常設で初期は「計画」');
  assert(/\.kt-ai-drawer\{ flex:0 0 46%;[^}]*display:flex/.test(html) && /#kt-ai-workspace #kt-ai-drawer-toggle\{ display:none; \}/.test(html), 'desktop: 右ペイン常設（display:flex）・折りたたみ toggle は非表示（CSS）');
  assert(/作業中の成果物はありません/.test(m.$('kt-ai-ws-state').innerHTML), '作業状態（Workspace State）: 初期は成果物なし');
  const header = m.$('kt-ai-header').innerHTML;
  assert(/<b style="font-size:13px;">開発支援<\/b>/.test(header) && new RegExp(`App ${FX.SELF_APP} 案件管理`).test(header) && /解析<\/span> ✓/.test(header) && /JavaScript<\/span> ✓/.test(header) && /AI<\/span> ✓/.test(header) && !/Fields<\/span>/.test(header) && !/Nest Rec AI<\/span>/.test(header), 'ヘッダー（§22）: 開発支援 / App 341 案件管理 / 解析 ✓ JavaScript ✓ AI ✓（技術情報は並べない）');
  assert(/フィールド 23/.test(header) && /依存関係/.test(header) && /Nest Rec AI: /.test(header), '件数・接続の文は「詳細」（折りたたみ）に');
  assert(/何を実現したいですか？/.test(m.chat()) && /100万円以上なら部長承認にしたい/.test(m.chat()) && /顧客マスタから住所も取得したい/.test(m.chat()) && /このフィールドの使われ方を知りたい/.test(m.chat()) && /既存JavaScriptを修正したい/.test(m.chat()) && /左は相談の履歴、右は現在の計画/.test(m.chat()), 'Empty State（§21）: やりたいことが入口・左右の思想');
}

// =========================================================
console.log('\n--- §3〜§8. 計画 / Review / Before・After / 実行: 左は要約、右は正本（重複なし） ---');
{
  const m = mount();
  await ticks();
  await m.panel.send(GOAL); await ticks();
  const chat = m.chat();
  // 計画
  assert(/kt-ai-plan-card/.test(chat) && /変更計画 v1 を作成しました。/.test(chat) && /標準設定<\/span><b>2件/.test(chat) && /JavaScript<\/span><b>0件/.test(chat) && /確認が必要<\/span><b>1件/.test(chat) && /新規フィールド<\/span><b>1件/.test(chat) && /data-act="open-plan"/.test(chat), 'chat plan summary（§5）: 件数と［計画を見る］');
  assert(!/更新状況フィールドを追加/.test(chat) && !/kt-ai-new-field/.test(chat) && !/理由：/.test(chat) && !/提案の内容/.test(chat), 'chat には計画の本文（手順・新規フィールド・理由）が無い');
  const plan = m.$('kt-ai-plan-result').innerHTML;
  assert(/変更計画（AI の提案）/.test(plan) && /更新状況フィールドを追加/.test(plan) && /kt-ai-new-field/.test(plan) && /一覧「担当者別」を追加/.test(plan) && !/kt-ai-decision/.test(plan) && !/id="kt-ai-review"/.test(plan), 'full plan only workspace（右「計画」）: 手順・新規フィールド。判断の select / Review は無い');
  assert(/kt-ai-tech/.test(plan) && /requestId: tk-/.test(plan) && /kt-ai-plan-json-toggle/.test(plan), '技術者向け（requestId / JSON）は「詳細」（details）に');
  assert(m.panel.activeArtifact()?.type === 'CHANGE_PLAN' && m.panel.activeArtifact()?.version === 1 && m.panel.drawerState().pane === 'plan', 'Active Artifact: CHANGE_PLAN v1 → 右は「計画」（Auto Navigation）');
  assert(/変更計画 v1/.test(m.$('kt-ai-ws-state').innerHTML) && /Review済み/.test(m.$('kt-ai-ws-state').innerHTML) && /Preview未反映/.test(m.$('kt-ai-ws-state').innerHTML) && /表示中: 変更計画 v1/.test(m.$('kt-ai-ws-state').innerHTML), 'Workspace State（§10）: 変更計画 v1 / Review済み / Preview未反映');
  // Review
  assert(/kt-ai-review-card/.test(chat) && /Toolkitで変更計画を検証しました。/.test(chat) && /✓ 実行可能<\/span><b>\d+件/.test(chat) && /△ 確認必要<\/span><b>\d+件/.test(chat) && /× 実行不可<\/span><b>\d+件/.test(chat) && /data-act="open-review"/.test(chat) && !/kt-ai-decision/.test(chat) && !/安全に追加できる変更/.test(chat), 'review summary（§6）: 件数と［検証結果を見る］。判断 select・内訳は無い');
  const review = m.$('kt-ai-review-result').innerHTML;
  assert(/Toolkit で確認した結果/.test(review) && /手順ごとの判定と判断/.test(review) && (review.match(/kt-ai-decision/g) || []).length === 2 && /安全に追加できる変更/.test(review) && /kt-ai-review-diff-toggle/.test(review) && /kt-ai-tech/.test(review) && /kt-ai-review-json-copy/.test(review), 'full review only workspace（右「検証」）: 手順ごとの判定 ＋ 判断 select（2 件）・集約・変更前後・技術者向け');
  await clickChat(m, 'open-review');
  assert(m.panel.drawerState().pane === 'review', '［検証結果を見る］→ 右「検証」');
  // Human Decision は右だけ
  await m.$('kt-ai-review-result').dispatch({ type: 'change', target: { dataset: { step: 'P1' }, value: 'approve' } });
  await m.$('kt-ai-review-result').dispatch({ type: 'change', target: { dataset: { step: 'P2' }, value: 'approve' } });
  assert(/承認 2/.test(m.$('kt-ai-review-decisions').textContent) && !/kt-ai-decision/.test(m.chat()), 'Human Decision workspace only（§16）: 右「検証」の select で判断。会話に select は無い');
  // Before / After
  await clickChat(m, 'before-after', { plan: m.conv().activePlan().planId, version: '1' });
  assert(/kt-ai-diff-card/.test(m.chat()) && /data-act="open-diff"/.test(m.chat()) && !/P2<\/b>/.test(m.chat()), 'Before / After: 会話は案内だけ');
  await clickChat(m, 'open-diff');
  assert(m.panel.drawerState().pane === 'review' && m.$('kt-ai-review-diff').style.display === '' && /P2<\/b>/.test(review), '［変更前後を見る］→ 右「検証」の変更前後が開く');
  // 旧版 / 最新版（§15）
  await m.panel.send('更新状況フィールドはいらない'); await ticks();
  const c3 = m.chat();
  assert(/変更計画 v2 を見直しました。/.test(c3) && /v2 に更新済み/.test(c3) && /kt-ai-plan-card is-old/.test(c3) && m.conv().planHistory().length === 2, 'old plan: v1 のカードは「v2 に更新済み」（履歴として残る）');
  assert(m.panel.activeArtifact()?.version === 2 && !/kt-ai-new-field/.test(m.$('kt-ai-plan-result').innerHTML) && /既存「担当者」を利用/.test(m.$('kt-ai-plan-result').innerHTML) && /変更計画 v2/.test(m.$('kt-ai-ws-state').innerHTML), 'active version: 右は v2 だけ（activeArtifact v2・作業状態 v2）');
  // v2 の手順を承認してから反映（判断は版ごと）
  await m.$('kt-ai-review-result').dispatch({ type: 'change', target: { dataset: { step: 'P1' }, value: 'approve' } });
  await m.$('kt-ai-review-result').dispatch({ type: 'change', target: { dataset: { step: 'P2' }, value: 'approve' } });
  // 実行（標準設定）
  await clickChat(m, 'open-plan');
  await clickPane(m, 'exec', { id: 'kt-ai-exec-start' }); await ticks();
  assert(m.panel.executorState().stage === 'confirm' && m.panel.drawerState().pane === 'exec' && m.panel.activeArtifact()?.type === 'EXECUTION' && /動作テスト環境への反映<\/b>/.test(m.$('kt-ai-exec').innerHTML) && !/Preview Executor/.test(m.$('kt-ai-exec').innerHTML), '［動作テスト環境へ反映］→ 右「実行」（最終確認。用語は「動作テスト環境への反映」）');
  await clickPane(m, 'exec', { id: 'kt-ai-exec-go' }); await ticks(8);
  const c2 = m.chat();
  assert(m.panel.executorState().stage === 'done' && /kt-ai-execution-card/.test(c2) && /動作テスト環境へ反映しました。/.test(c2) && /✓ \d+ 件 VERIFIED/.test(c2) && /運用環境には反映されていません。/.test(c2) && /data-act="exec-details"/.test(c2) && !/Simulationとの一致/.test(c2) && !/監査 JSON/.test(c2), 'execution summary（§8）: 件数・運用環境の注意・［実行結果を見る］。進捗 / Simulation / 監査は会話に無い');
  assert(/Simulationとの一致/.test(m.$('kt-ai-exec').innerHTML) && /kt-ai-exec-audit-copy/.test(m.$('kt-ai-exec').innerHTML) && /Preview反映済み/.test(m.$('kt-ai-ws-state').innerHTML), '右「実行」に詳細（Simulation / 監査 / 戻す）。作業状態は Preview反映済み');
}

// =========================================================
console.log('\n--- §9. Evidence: 根拠チップは会話に残し、詳細は右「根拠」だけ ---');
{
  const m = mount();
  await ticks();
  await m.panel.send('金額は何に使ってる？'); await ticks();
  const chat = m.chat();
  const eid = (chat.match(/data-eid="(E\d+)"/) || [])[1];
  assert(eid && !/kt-ai-fact-detail/.test(chat) && !/statement/.test(chat), `回答に根拠チップ（${eid}）はあるが、根拠の全文は会話に無い`);
  await m.$('kt-ai-chat').dispatch({ type: 'click', target: { dataset: { eid } } });
  assert(m.panel.drawerState().pane === 'evidence' && m.$('kt-ai-fact-detail').style.display === '' && m.$('kt-ai-fact-detail').innerHTML.length > 20 && m.panel.activeArtifact()?.type === 'EVIDENCE' && m.panel.activeArtifact()?.id === eid, 'チップ → 右「根拠」に詳細（EVIDENCE artifact）。会話は変わらない');
  assert(m.chat() === chat, '会話本文は二重表示しない');
}

// =========================================================
console.log('\n--- §7 / §20. Customize → 開発支援（JS 相談）: 左は会話、右は仕様 → コード → Preview 結果 ---');
{
  const m = mount({ plans: () => PLAN_HYBRID });
  await ticks();
  const seed = KTContext.buildConsultationSeed({ data: INPUTS.data, deps: INPUTS.deps, scan: INPUTS.scan, file: { name: 'fieldOnOff.js', target: 'desktop', type: 'FILE', fileKey: '20261003000000EEEE', size: '300' }, sourceText: FIELD_ON_OFF, appName: '案件管理' });
  const r = m.panel.consult(seed);
  assert(r.ok && /fieldOnOff\.js について相談します。/.test(m.chat()) && /何を変更したいですか？/.test(m.chat()) && !/app\.record\.create\.show/.test(m.chat()) && !/イベント：/.test(m.chat()), 'Customize → 開発支援: 左は「fieldOnOff.js について相談します。何を変更したいですか？」だけ');
  const info = m.$('kt-ai-subject-info').innerHTML;
  assert(/相談中の JavaScript/.test(info) && /fieldOnOff\.js/.test(info) && /app\.record\.create\.show/.test(info) && /制御<\/span><span>amount/.test(info) && /取得済み/.test(info) && m.panel.drawerState().pane === 'plan' && m.panel.activeArtifact()?.type === 'CONSULTATION', '右「計画」に相談対象の現在情報（イベント / 制御 / 本文）。artifact CONSULTATION');
  assert(/相談中: fieldOnOff\.js（PC）/.test(m.$('kt-ai-header').innerHTML) && /fieldOnOff\.js/.test(m.$('kt-ai-ws-state').innerHTML) && /相談中/.test(m.$('kt-ai-ws-state').innerHTML), 'ヘッダーの相談中バッジ・作業状態「fieldOnOff.js / 相談中」');
  await m.panel.send('承認済みでは金額を編集できなくしたい'); await ticks();
  assert(/実装仕様 v1 をまとめました/.test(m.chat()) && /✎ fieldOnOff\.js を変更（PC）/.test(m.chat()) && !/data-act="confirm-spec"/.test(m.chat()) && /data-act="open-spec"/.test(m.chat()), '仕様（左）: 要約と［仕様を見る］。確定ボタンは無い');
  assert(/data-act="confirm-spec"/.test(m.$('kt-ai-spec').innerHTML) && /amount（CONTROL）/.test(m.$('kt-ai-spec').innerHTML) && /仕様 v1 確認待ち/.test(m.$('kt-ai-ws-state').innerHTML) && /コード未生成/.test(m.$('kt-ai-ws-state').innerHTML) && /Preview未登録/.test(m.$('kt-ai-ws-state').innerHTML), '仕様（右「計画」）: 詳細と［この仕様で確定］。作業状態「仕様 v1 確認待ち / コード未生成 / Preview未登録」');
  await confirmSpec(m);
  assert(m.conv().activePlan().spec.status === 'CONFIRMED' && m.panel.activeArtifact()?.type === 'CUSTOMIZATION_SPEC' && /仕様 v1 確定/.test(m.$('kt-ai-ws-state').innerHTML), '［この仕様で確定］（右）→ CONFIRMED・artifact CUSTOMIZATION_SPEC');
  await clickPane(m, 'plan', { dataset: { act: 'generate', cid: 'C1' } }); await ticks();
  const c = m.chat();
  assert(/JavaScript を生成しました。/.test(c) && /✎ <b>fieldOnOff\.js<\/b>（PC）/.test(c) && /Toolkit Code Review：/.test(c) && /✓ 検査を通過/.test(c) && /data-act="open-code"/.test(c) && !/✓ Patch/.test(c) && !/参考パターン/.test(c), 'code summary（§7）: ファイル名・Code Review ✓・［コードを見る］［Diffを見る］。内訳・参考パターンは無い');
  assert(m.panel.drawerState().pane === 'code' && m.panel.activeArtifact()?.type === 'GENERATED_CODE' && m.$('kt-ai-code-view').textContent.includes("value === '完了'") && /✓ Patch/.test(m.$('kt-ai-code-review').innerHTML) && /参考パターン/.test(m.$('kt-ai-code-review').innerHTML) && m.$('kt-ai-code-register').style.display === '', 'full code only workspace（右「コード」が自動で開く）: 全文・検査の内訳・参考パターン・［動作テスト環境へ登録］');
  assert(/コード生成済み/.test(m.$('kt-ai-ws-state').innerHTML), '作業状態: コード生成済み');
  await clickPane(m, 'code', { id: 'kt-ai-code-register' }); await ticks();
  assert(m.panel.jsExecState().stage === 'confirm' && m.panel.drawerState().pane === 'exec' && /JavaScript を動作テスト環境へ登録します。/.test(m.$('kt-ai-jsreg').innerHTML), '［動作テスト環境へ登録］（右「コード」）→ 右「実行」の最終確認（Final Confirmation は従来どおり）');
  for (const x of (m.panel.jsExecState().prepared?.confirmations || [])) await m.host.querySelector('#kt-ai-pane-exec').dispatch({ type: 'change', target: { dataset: { ackKey: x.key }, checked: true } });   // Phase 21: 確認が必要な項目を 1 件ずつ確認
  await clickPane(m, 'exec', { id: 'kt-ai-jsreg-go' }); await ticks(8);
  const c4 = m.chat();
  assert(m.panel.jsExecState().stage === 'done' && /JavaScript を動作テスト環境へ登録しました。/.test(c4) && /✎ fieldOnOff\.js（PC）/.test(c4) && /✓ 1 \/ 1 件 VERIFIED/.test(c4) && /data-act="open-js-result"/.test(c4) && /data-act="open-customize"/.test(c4) && !/planVsActual/.test(c4) && !/Audit/.test(c4), 'JS 登録の要約（左）: ファイル・✓ 1 / 1・［登録結果を見る］［Customize で確認］。検証の内訳・監査は無い');
  assert(/planVsActual/.test(m.$('kt-ai-jsreg').innerHTML) && /Preview登録済み/.test(m.$('kt-ai-ws-state').innerHTML), '右「実行」に検証の内訳。作業状態 Preview登録済み');
  await clickChat(m, 'open-customize', { target: 'desktop', name: 'fieldOnOff.js' });
  assert(m.opened.length === 1 && m.opened[0].name === 'fieldOnOff.js', '［Customize で確認］→ Customize タブへ');
  assert(writes(m).filter(w => /PUT customize/.test(w)).length === 1, '書き込みは登録の PUT 1 回だけ（会話の文章では書かない）');
}

// =========================================================
console.log('\n--- §13. Auto Navigation: 読んでいる最中のペインは奪わない（タブを自分で選んだ後 60 秒は印だけ） ---');
{
  const m = mount();
  await ticks();
  await clickTab(m, 'context');
  assert(m.panel.drawerState().pane === 'context' && m.panel.drawerState().pinned === 'context', 'タブ「Context」を自分で選ぶ（pinned）');
  await m.panel.send(GOAL); await ticks();
  assert(m.panel.drawerState().pane === 'context' && m.panel.drawerState().unread.includes('plan') && /data-pane="plan">計画<span class="kt-ai-dtab-dot"/.test(m.$('kt-ai-drawer-tabs').innerHTML) && m.panel.activeArtifact()?.type === 'CHANGE_PLAN', '計画が届いても Context を読んでいる最中は切り替えず、「計画」タブに ● を付ける（artifact は更新）');
  await clickTab(m, 'plan');
  assert(m.panel.drawerState().pane === 'plan' && !m.panel.drawerState().unread.includes('plan') && !/kt-ai-dtab-dot/.test(m.$('kt-ai-drawer-tabs').innerHTML), 'タブ「計画」を開くと印が消える');
  const m2 = mount();
  await ticks();
  await clickTab(m2, 'context');
  m2.clock.t += 61 * 1000;
  await m2.panel.send(GOAL); await ticks();
  assert(m2.panel.drawerState().pane === 'plan', '60 秒を過ぎていれば自動で「計画」へ');
  const m3 = mount();
  await ticks();
  await clickChat(m3, 'open-plan');   // 会話のボタンからの移動は「読んでいる最中」ではない
  await m3.panel.send(GOAL); await ticks();
  assert(m3.panel.drawerState().pane === 'plan' && m3.panel.drawerState().pinned === null, '会話のボタンからの移動は pin にならない（自動表示は通る）');
}

// =========================================================
console.log('\n--- §18 / §19. Free Features / Connection は右（Context / 接続） ---');
{
  const f = mount({ paid: false });
  await ticks();
  assert(/id="kt-ai-pane-context"[\s\S]*id="kt-ai-generate"[\s\S]*id="kt-ai-pane-connection"/.test(f.host.innerHTML) && f.host.innerHTML.includes('id="kt-ai-copy-prompt"') && f.host.innerHTML.includes('id="kt-ai-doc-kind"'), 'free context: AI Prompt / Markdown / JSON / ドキュメントは右「Context」');
  await f.$('kt-ai-free').dispatch({ type: 'click', target: { id: 'kt-ai-free-generate' } });
  assert(f.panel.drawerState().pane === 'context' && f.panel.activeArtifact()?.type === 'CONTEXT', '無料パネルの［AI用Promptを生成］→ 右「Context」（artifact CONTEXT）');
  f.panel.setMode('doc', { kind: 'spec' }); f.$('kt-ai-generate').dispatch('click'); await ticks();
  assert(f.panel.currentOutput()?.text.includes('## Context') && f.calls.plan.length === 0, 'ドキュメントは右「Context」で生成（Gateway 不要）');
  const m = mount();
  await ticks();
  assert(/data-pane="connection"/.test(m.$('kt-ai-drawer-tabs').innerHTML) && /id="kt-ai-pane-connection"[\s\S]*id="kt-ai-paid"/.test(m.host.innerHTML) && /AI<\/span> ✓/.test(m.$('kt-ai-header').innerHTML) && !/kt-ai-session-lines/.test(m.$('kt-ai-header').innerHTML), 'connection: 接続情報は右「接続」。上部は AI ✓ だけ');
}

// =========================================================
console.log('\n--- §23 / §24. Narrow Width: 縦積み・折りたたみ ---');
{
  const m = mount();
  await ticks();
  const html = m.host.innerHTML;
  assert(/container-type:inline-size; container-name:kt-ai-ws;/.test(html) && /@container kt-ai-ws \(max-width: 760px\)\{[\s\S]*\.kt-ai-ws-body\{ flex-direction:column; \}[\s\S]*\.kt-ai-drawer\{ flex:0 0 auto; max-height:55%; \}[\s\S]*is-drawer-collapsed \.kt-ai-drawer\{ display:none; \}[\s\S]*#kt-ai-drawer-toggle\{ display:inline-block; \}/.test(html), '狭い幅（container query: 開発支援タブ自身の幅 ≤ 760px）: Conversation → Workspace の縦積み・Workspace は折りたためる・toggle は狭い幅だけ');
  await m.$('kt-ai-header').dispatch({ type: 'click', target: { id: 'kt-ai-drawer-toggle' } });
  assert(m.panel.drawerState().open === false && /作業パネルを表示/.test(m.$('kt-ai-header').innerHTML), '折りたたむ（is-drawer-collapsed）');
  await m.$('kt-ai-header').dispatch({ type: 'click', target: { id: 'kt-ai-drawer-toggle' } });
  assert(m.panel.drawerState().open === true && m.panel.drawerState().pane === 'plan', '展開（同じペインに戻る）');
  assert(!/kt-ai-drawer-close/.test(m.$('kt-ai-drawer-tabs').innerHTML), 'タブ列に × は無い（常設）');
}

// =========================================================
console.log('\n--- §27. ViewModel（純関数）: Chat と Workspace は同じ値 ---');
{
  const gen = KTContextUi.generatePlan({ goal: GOAL, inputs: INPUTS });
  const v = { planId: 'p', version: 1, status: 'ACTIVE', goal: GOAL, plan: { ...KTAiClient.validatePlan(PLAN_V1, gen.ctx).normalized, requestId: 'pl-1' } };
  v.review = KTPlanReview.review({ plan: v.plan, ...INPUTS });
  const ps = VM.planSummary(v);
  assert(ps.version === 1 && ps.standard === 2 && ps.javascript === 0 && ps.confirmations === 1 && ps.newFields === 1 && ps.statusJa === '最新' && ps.superseded === false, 'planSummary: 標準設定 2 / JavaScript 0 / 確認 1 / 新規フィールド 1');
  const old = VM.planSummary({ ...v, status: 'SUPERSEDED' }, { latestVersion: 3 });
  assert(old.superseded && old.latestVersion === 3 && old.statusJa === '旧バージョン', 'planSummary: 旧版（v3 に更新済み）');
  const rs = VM.reviewSummary(v);
  assert(rs && rs.safe + rs.review + rs.blocked + rs.planOnly === 2 && rs.js === null, 'reviewSummary: Toolkit の判定の件数（JS 無し）');
  assert(VM.reviewSummary({ plan: v.plan }) === null && VM.specSummary(v) === null && VM.executionSummary({ stage: 'idle' }) === null && VM.jsExecutionSummary({ stage: 'idle' }) === null, '無いものは null');
  const ws = VM.workspaceState({ version: v, execState: { stage: 'idle' }, jsExec: { stage: 'idle' }, subject: null });
  assert(ws.kind === 'plan' && ws.lines.join('|') === '変更計画 v1|Review済み|Preview未反映', 'workspaceState（計画）');
  const vh = { planId: 'h', version: 2, status: 'ACTIVE', goal: GOAL_HYBRID, plan: PLAN_HYBRID.plan, review: null, spec: { specId: 'h:spec', version: 2, status: 'CONFIRMED', confirmedAt: 'x', customizations: PLAN_HYBRID.plan.customizations }, generated: { C1: { generated: { ...genPatch(), patterns: PATTERNS }, review: { status: 'OK', diff: { added: 3, removed: 0 } }, existingSource: { name: 'fieldOnOff.js', target: 'desktop', text: FIELD_ON_OFF } } } };
  const subject = { name: 'fieldOnOff.js', platform: 'desktop' };
  const wsj = VM.workspaceState({ version: vh, execState: { stage: 'idle' }, jsExec: { stage: 'idle' }, subject });
  assert(wsj.kind === 'js' && wsj.lines.join('|') === 'fieldOnOff.js|仕様 v2 確定|コード生成済み|Preview未登録', 'workspaceState（JS 相談）: fieldOnOff.js / 仕様 v2 確定 / コード生成済み / Preview未登録');
  const wsj2 = VM.workspaceState({ version: vh, execState: { stage: 'idle' }, jsExec: { stage: 'done', execution: { executionId: 'x', status: 'DONE', put: { ok: true }, steps: [{ name: 'fieldOnOff.js', target: 'desktop', kind: 'REPLACE_FILE', status: 'VERIFIED' }] } }, subject });
  assert(wsj2.lines[3] === 'Preview登録済み', 'workspaceState: 登録後は Preview登録済み');
  const cs = VM.codeSummary(vh.generated.C1, 'C1', vh);
  assert(cs.targetFile === 'fieldOnOff.js' && cs.ok && cs.added === 3 && cs.removed === 0 && cs.target === 'desktop' && cs.patterns.join() === 'field-disable' && cs.external === false, 'codeSummary');
  const sp = VM.specSummary(vh);
  assert(sp.specVersion === 2 && sp.status === 'CONFIRMED' && sp.customizations[0].files.join() === 'fieldOnOff.js' && sp.customizations[0].platform.join() === 'desktop', 'specSummary');
  const js = VM.jsExecutionSummary({ stage: 'done', execution: { executionId: 'x', status: 'DONE', put: { ok: true }, steps: [{ name: 'a.js', target: 'mobile', kind: 'ADD_FILE', status: 'VERIFIED' }, { name: 'b.js', target: 'desktop', kind: 'REPLACE_FILE', status: 'VERIFY_FAILED' }], rollback: { status: 'ROLLED_BACK_VERIFIED', verification: { restoredToSnapshot: true } } } });
  assert(js.verified === 1 && js.steps.length === 2 && js.ok && js.written && js.rolledBack && js.rollbackRestored === true && js.firstStep.name === 'a.js', 'jsExecutionSummary');
  assert(VM.artifactLabel({ type: 'CHANGE_PLAN', version: 3 }) === '変更計画 v3' && VM.artifactLabel({ type: 'GENERATED_CODE', customizationId: 'C1', targetFile: 'a.js' }) === '生成コード C1（a.js）' && VM.paneFor({ type: 'EXECUTION' }) === 'exec' && VM.paneFor({ type: 'REVIEW' }) === 'review' && VM.paneFor({ type: 'DOCUMENT' }) === 'context', 'artifactLabel / paneFor');
  assert(Object.keys(VM.ARTIFACT).sort().join() === 'CHANGE_PLAN,CONSULTATION,CONTEXT,CUSTOMIZATION_SPEC,DOCUMENT,EVIDENCE,EXECUTION,GENERATED_CODE,REVIEW,ROLLBACK', 'Artifact Types（§12）');
  // Chat と Workspace が同じ値（別々に計算しない）
  const card = KTAiChatUi.planCardHtml(v);
  assert(new RegExp(`標準設定</span><b>${ps.standard}件`).test(card) && new RegExp(`確認が必要</span><b>${ps.confirmations}件`).test(card), 'planCardHtml は planSummary の値をそのまま使う');
  const rc = KTAiChatUi.reviewCardHtml(v);
  assert(new RegExp(`✓ 実行可能</span><b>${rs.safe}件`).test(rc), 'reviewCardHtml は reviewSummary の値をそのまま使う');
  assert(!/function assetCardsHtml|function customizationCardHtml/.test(SRC_TEXT), '重複レンダラー（資産カード / Customization カード）は削除');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
