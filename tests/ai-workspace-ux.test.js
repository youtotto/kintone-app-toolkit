// Development Workspace UX Finalization（Phase 19）: 「開発支援」タブ・左 Conversation（履歴）/ 右 Workspace（現在の成果物の正本）・
// 要約カード・Active Artifact・自動表示の抑制・Human Approval は右・無料出力は右・狭い幅・Customize → 開発支援・ViewModel
//
// 検証内容（§30）: tab label 開発支援 / internal id 維持 / chat plan summary / full plan only workspace / review summary / full review only workspace /
//   code summary / full code only workspace / execution summary / Evidence detail workspace / old plan / active version / Human Decision workspace only /
//   free context / narrow width / Customize→開発支援 / ViewModel / auto navigation
//
// 2026-10-06（利用者の指示で作り替え）: 左＝会話（［新しい会話］は 1 か所）・右＝現在の作業内容（常に表示。折りたたみは廃止）・左右の境目。
//   右のタブは 変更内容・コード・確認結果（＋ 詳細情報・接続）、反映は右下の右の「反映」、反映の記録はヘッダーから開く。右の見出しは実際の処理の状態だけ（workStatus）。
//   会話には内部の番号・処理の通知を出さない。必要な確認が終わるまで反映しない（applyHold）
//
// C-1 第 3 段（2026-10-08）: 会話の節は新しい流れ（依頼 → 仮案 →「これで進めて」で採用 → 計画 → 生成 → 最終案のカード → ［動作テスト環境へ反映］で承認と反映）の上で
// §0e.1（2026-10-09）: 承認と反映は最終案のカードの［動作テスト環境へ反映］1 回（承認の欄の準備（書き込みなし）の後に押せる。右の「反映」の準備・最終確認の段は出さない）。
//   右の「反映」の準備・最終確認の部品の照合（新しい会話・更新中の止め）は、承認の記録（会話コントローラ）と部品の呼び出しで確かめる
//   確かめる（planOnScreen・applyOnScreenM）。置き換えた古い確認の流れの会話のカード（変更案のカード・確認事項のカード・Review の要約・仕様のカード・
//   コードのカード・［この仕様で確定］・［JavaScript を生成］）の期待は外し、対応する新しい流れの回帰（tests/ai-flow-redesign.test.js の R09・R10・F2・F7・F11）を各節に書いた。
//   右の作業内容（変更内容・確認結果・コード・反映）・反映の記録・新しい会話・反映を止める理由の期待は、そのまま新しい流れの上で確かめる
//
// 実行方法: node tests/ai-workspace-ux.test.js
'use strict';
// 実行が 10 秒を超えると、スクリプトの入口（waitReady の 10 秒の待ちの後に kintone.app.getId() を呼ぶ）が動く。テストには kintone が無いので、その 1 件だけを無視する
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const fs = require('fs');
const path = require('path');
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
//   簡素化（2026-10-17）: 反映できるかは、最新の版なら会話の今の判定、前の版なら最終案の記録で確かめる（tests/helpers/final-state.js）
const FS = require('./helpers/final-state.js');
const { withDevBase } = require('./helpers/dev-base-fake.js');
const { gwCandidateHash, gwHashOfCtx, withGwHash, gwWithBody } = require('./helpers/gw-hash.js');
const { makeFakeHost, makeFakeDocument } = require('./helpers/fake-dom.js');
const T = loadToolkit();
const { KTDeps, KTScan, KTContext, KTContextUi, KTAiClient, KTAiConversation, KTAiChatUi, KTAiWorkspaceViewModel: VM, KTPlanReview, mountAiWorkspace } = T;
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const { buildScanPayload } = require('./helpers/scan-payload.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const SRC_TEXT = fs.readFileSync(path.join(__dirname, '..', 'kintoneAppToolkit.user.js'), 'utf8');
// C-1 第 3 段: 新しい流れの共有の部品（仮案の応答の正規化）
const { createNewFlowKit } = require('./helpers/new-flow.js');
const KF = createNewFlowKit(T);

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
const cust = (o = {}) => ({ customizationId: 'C1', requirement: '承認後（完了）は金額を編集できなくする', whyStandardInsufficient: 'フィールドのアクセス権はステータスで切り替えられない', strategy: 'EXTEND_EXISTING_JS', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL', effects: ['lock'] }], apis: [], existingFiles: [{ name: 'fieldOnOff.js', target: 'desktop', reason: '同じフィールド（金額）を制御している' }], risks: [], questions: [], dependsOn: [], evidenceIds: [], ...o });
const STD_STEP = () => mkStep('P1', 'ADD_VIEW', 'VIEW', '承認済み', { name: '承認済み', fields: ['case_name', 'amount', 'approver'], filterCond: 'ステータス in ("完了")', sort: 'due_date asc' }, { title: '一覧「承認済み」を追加', solution: 'STANDARD' });
const JS_STEP = () => mkStep('P2', 'CUSTOMIZATION_REQUIRED', 'JS', 'fieldOnOff.js', { customizationId: 'C1' }, { title: '承認後は金額を編集できなくする（JavaScript）', solution: 'CUSTOMIZATION' });
const PLAN_HYBRID = { ok: true, contractVersion: '2.1', meta: { ...META, requestId: 'pl-h1' }, plan: { goal: GOAL_HYBRID, solution: 'HYBRID', assessment: { summary: '承認フローは標準のプロセス管理、承認後のロックは JavaScript が必要です。', usableExistingFields: [], usableExistingSettings: [], missingCapabilities: [], uncertainties: [] }, relevantFields: [], proposedFields: [], steps: [STD_STEP(), JS_STEP()], customizations: [cust()], alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED' } };
const hash = (t) => KTScan.hashText(t);
const PATCH_GOOD = { baseHash: hash(FIELD_ON_OFF), operations: [{ type: 'INSERT_AFTER', anchor: "      record['amount'].disabled = true;\n    }", content: "    if (record['ステータス'] && record['ステータス'].value === '完了') {\n      record['amount'].disabled = true;\n    }" }] };
const PATTERNS = [{ id: 'field-disable', purpose: '条件に応じてフィールドの編集可否を制御する', implementation: 'JAVASCRIPT', preferredStandardAlternatives: ['フィールドのアクセス権'], matched: {}, score: 7 }];
// §0c.6（2026-10-08）: 従来の流れの登録は、接続先が必須の効果の確認に対応し（health の verification に requiredEffects）、生成工程の検証が合格したものだけ。
//   この試験は登録の経路（upload・PUT・検証・戻す）を確かめるので、偽の生成工程は Toolkit が渡した必須の効果をそのまま「処理あり・動作テストで合格」で返す
//   （効果の区別そのものの検証は tests/ai-flow-redesign.test.js の §D）
//   簡素化 B（2026-10-17）・2026-10-18: 本物の Gateway と同じく、検証結果に書き込む本文の指紋（bodyHash。Gateway と同じ計算。tests/helpers/gw-hash.js）を入れる
const passVerification = (ctx, g = null) => { const re = (ctx && ctx.verification && ctx.verification.requiredEffects) || []; return re.length ? { version: '1', ...(g ? { bodyHash: gwHashOfCtx(ctx, g) } : {}), passed: true, machine: [], requiredEffects: re.map(x => ({ requirementId: x.requirementId, requirementIds: x.requirementIds, field: x.field, effect: x.effect, status: 'present' })), behavior: { status: 'passed', reason: null, cases: re.flatMap((x, i) => (x.events && x.events.length ? x.events : [null]).flatMap((ev, j) => (x.condition ? ['match', 'nomatch'] : ['match']).map(side => ({ id: `K${i + 1}-${j + 1}-${side}`, requirementIds: x.requirementIds, field: x.field, effect: x.effect, expect: side === 'match' ? x.effect : ({ lock: 'not-locked', warn: 'not-warned', 'block-save': 'save-allowed', 'set-value': 'value-unchanged', 'show-hide': 'show-hide' })[x.effect], side, ...(ev ? { event: ev } : {}), verdict: 'pass', observed: {}, message: '期待どおり' })))) }, repairs: { count: 0, reasons: [], stoppedBy: null }, unverified: ['実機での動作'] } : undefined; };
const genResponse = (ctx, g) => ({ ok: true, contractVersion: '2.1', meta: { requestId: 'gen-1', usage: { usedThisMonth: 3, monthlyLimit: 20 }, normalization: { warnings: [] }, gateway: { feature: 'customization-generator' } }, generated: { strategy: ctx.customization.strategy, targetFile: ctx.existingFile?.name || 'amountWarning.js', summary: ctx.customization.requirement, events: ctx.customization.events, fields: ctx.customization.fields, apis: [], assumptions: [], warnings: [], gatewayChecks: { security: [] }, patterns: PATTERNS, ...g }, ...(passVerification(ctx, g) ? { verification: passVerification(ctx, g) } : {}) });
//   2026-10-18（AI版 契約 20 §20）: 統合の書き込む本文は生成工程が合成して返す（偽の生成工程は送られた既存の本文と patch から作る）
const genPatch = (patch = PATCH_GOOD, src = FIELD_ON_OFF) => gwWithBody({ strategy: 'EXTEND_EXISTING_JS', targetFile: 'fieldOnOff.js', summary: '完了でも金額を編集不可にする', code: patch.operations.map(o => o.content).join('\n'), patch, events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [] }, src);
// C-1 第 3 段: 仮案の能力（assistant-qa の conversation に proposal）がある接続先。無い接続先は「接続先が非対応」で計画・生成に進まない（tests/ai-flow-redesign.test.js の §B2 の後）
const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'], conversation: ['requirements', 'stream', 'proposal', 'itemIds'] }, 'change-planner': { implemented: true, promptVersions: ['1'] }, 'customization-generator': { implemented: true, promptVersions: ['1'], verification: ['requirementId', 'requiredEffects', 'effectGroups', 'relatedOmitted', 'appFields', 'saveDialog', 'reasonCategory', 'caseSide', 'eventCases', 'loadFaithful', 'registrationCheck', 'emptyCase', 'hideCondition', 'registrationCounts', 'caseCoverage', 'cancelCheck', 'limitCode', 'scopeList', 'tableRowChange', 'caseInvalid', 'conditionFrom', 'effectCheck', 'networkCheck', 'verifiedBody'] } } }, usage: { monthlyLimit: 20, usedThisMonth: 1 } };
const makeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
// C-1 第 3 段: 仮案の台本（依頼の文を実現する動作にした仮案。判断・要件は無く、「これで進めて」で採用する）
const draftRaw = (u) => ({ reply: `「${u}」を実現する変更案にできます。`, intent: 'propose', proposal: { behaviors: [{ text: u, origin: 'user' }], assumptions: [], decisions: [], approach: { standard: ['設定の変更'], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [] } });
const answerFor = (ctx, text) => ({ ok: true, contractVersion: '2.1', meta: { requestId: 'qa-1', usage: { usedThisMonth: 2, monthlyLimit: 20 }, normalization: { warnings: [] } }, answer: text, facts: ctx.facts.length ? [{ text: 'fact', evidenceIds: [ctx.facts[0].id] }] : [], analysis: [], recommendations: [], unknowns: [] });
const tick = () => new Promise(r => setTimeout(r, 0));
const ticks = async (n = 4) => { for (let i = 0; i < n; i++) await tick(); };
function mount({ inputs = INPUTS, paid = true, plans = null, now = null, extra = {}, planGate = null, health = HEALTH, gatewayPlan = false } = {}) {
  const storage = makeStorage();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' });
  settings.setConsent(true);
  const calls = { ask: [], plan: [], generate: [], propose: [] };
  const client = {
    async getHealth() { return health; },
    async ask({ ctx, requestId }) { calls.ask.push({ ctx }); const v = KTAiClient.validateAnswer(answerFor(ctx, 'このフィールドは金額です。'), ctx); return { ...v.normalized, requestId, clientWarnings: v.warnings }; },
    async plan({ ctx, requestId }) { calls.plan.push({ ctx }); if (planGate) await planGate(ctx); const resp = plans ? plans(ctx) : (ctx.revision ? PLAN_V2 : PLAN_V1); const v = KTAiClient.validatePlan(resp, ctx); const out = { ...v.normalized, requestId, clientWarnings: v.warnings }; if (gatewayPlan) Object.defineProperty(out, 'gatewayPlan', { value: JSON.parse(JSON.stringify(resp.plan)), enumerable: false }); return out; },
    async generate({ ctx, requestId }) { calls.generate.push({ ctx }); const v = KTAiClient.validateGenerated(genResponse(ctx, genPatch({ ...PATCH_GOOD, baseHash: ctx.existingFile?.hash || PATCH_GOOD.baseHash }, ctx.existingFile ? ctx.existingFile.source : FIELD_ON_OFF)), ctx); if (!v.ok) throw new Error(v.errors[0].message); return { ...v.normalized, requestId, clientWarnings: v.warnings }; },
    // C-1 第 3 段: 仮案の AI（偽物。依頼の文をそのまま実現する動作にする）
    async propose({ ctx, requestId, onText = null }) { calls.propose.push({ ctx }); const raw = draftRaw(ctx.question); if (typeof onText === 'function') onText(raw.reply); return KF.normalized(raw, requestId, null, ctx.conversation); },
  };
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner,customization-generator', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const flow = { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false };
  const host = makeFakeHost();
  const copies = [], opened = [];
  const mock = makeKintoneMock(inputs.data, { jsSources: [{ name: 'fieldOnOff.js', target: 'desktop', text: FIELD_ON_OFF }] });
  const clock = { t: 1000000 };
  const panel = mountAiWorkspace(host, withDevBase(T, {
    getInputs: () => inputs, copyText: async (t) => { copies.push(t); return true; }, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' },
    ...(paid ? { settings, session, hostname: 't.cybozu.com', connectFlow: flow } : {}),
    executor: { api: mock.api, appId: String(FX.SELF_APP) }, openCustomize: (x) => { opened.push(x); return { found: true }; },
    now: now || (() => clock.t),
    ...extra,
  }));
  const $ = (id) => host.querySelector(`#${id}`);
  const ws = () => ['kt-ai-subject-info', 'kt-ai-spec', 'kt-ai-plan-result', 'kt-ai-review-result', 'kt-ai-exec', 'kt-ai-jsreg', 'kt-ai-code-head', 'kt-ai-code-review'].map(id => $(id).innerHTML).join('\n');
  return { host, panel, $, calls, copies, opened, mock, clock, ws, conv: () => panel.conversation(), chat: () => $('kt-ai-chat').innerHTML, msgs: () => panel.conversation().state.messages, types: () => panel.conversation().state.messages.map(m => m.type) };
}
const clickChat = (m, act, extra = {}) => m.$('kt-ai-chat').dispatch({ type: 'click', target: { dataset: { act, ...extra } } });
const clickPane = (m, pane, target) => m.$(`kt-ai-pane-${pane}`).dispatch({ type: 'click', target });
const clickTab = (m, pane) => m.$('kt-ai-drawer-tabs').dispatch({ type: 'click', target: { dataset: { pane } } });
const writes = (m) => m.mock.calls.filter(c => !c.startsWith('GET'));
/**
 * C-1 第 3 段: 依頼 → 仮案 →「これで進めて」で採用 → 最終案（以前は依頼の文から直接、変更案を作っていた）。
 *   opts は最初の依頼の送信に渡す（{ intent: 'PLAN' } =「新しい変更案にする」。前の計画の後の新しい仮案になる）
 */
const planOnScreen = async (m, goal, opts = {}) => { await m.panel.send(goal, opts); await ticks(8); await m.panel.send('これで進めて'); await ticks(12); return m.conv().activePlan(); };
/** §0e.1（2026-10-09）: 最終案のカードの［動作テスト環境へ反映］を 1 回押す（承認の欄の準備を待ってから。承認と反映を 1 回で行う。tests/helpers/new-flow.js の applyOnScreen） */
const applyOnScreenM = (m, o) => KF.applyOnScreen(m, o);
/** C-1 第 3 段: 採用した仮案から作る計画の goal は「依頼の文」＋「採用した方針: …」。依頼の文（1 行目）で計画を選ぶ */
const firstLine = (s) => String(s ?? '').split('\n')[0];
/**
 * C-1 第 3 段: 右の「コード」に今の最終案の JavaScript（C1）を出す。会話のカードの［コードを見る］（open-code）と同じ操作。
 *   最終案のカードの［コードを見る］がこの操作を送る（ボタンがあることは §7 / §20 で確かめる）。ここでは、右の「コード」の振る舞い（版が変わったら消す・
 *   登録の確認を取り消す）を確かめるために、同じ操作を直接送る
 */
const openCodePane = async (m, cid = 'C1') => { await clickChat(m, 'open-code', { cid, view: 'code' }); await ticks(); };
/** 会話の最後の最終案のカード（FINAL）の HTML */
const lastFinalHtml = (m) => { const msgs = m.msgs(); const f = [...msgs].reverse().find(x => x.type === 'FINAL'); return f ? KTAiChatUi.messageHtml(f, { plans: new Map(m.conv().planHistory().map(v => [`${v.planId}:${v.version}`, v])), activePlan: m.conv().activePlan(), answerState: m.conv().answerContext(), ledger: m.conv().ledger(), answers: new Map() }) : ''; };

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
console.log('\n--- §2. Workspace Architecture: 左 会話 / 右 現在の作業内容（常に表示）・ペイン・右の見出しの状態・ヘッダー ---');
{
  const m = mount();
  await ticks();
  const html = m.host.innerHTML;
  // 2026-10-06: 右のタブは 変更内容・コード・確認結果（主）と 詳細情報・Context・接続（控えめ）。タブとペインが対になる
  for (const p of VM.TABS) assert(html.includes(`id="kt-ai-pane-${p}"`) && html.includes(`data-pane="${p}"`), `Workspace のペイン ${p}（${VM.PANE_JA[p]}）とタブ`);
  // 2026-10-07: 反映（exec）も右のタブ。反映の記録（log）はヘッダーの［反映の記録］から開くペイン（タブにしない）
  assert(/<div id="kt-ai-pane-exec" class="kt-ai-pane">[\s\S]*?id="kt-ai-exec-empty"[\s\S]*?id="kt-ai-exec"[\s\S]*?id="kt-ai-jsreg"/.test(html) && html.includes('data-pane="exec"') && /<b>現在の作業内容<\/b>[\s\S]*id="kt-ai-right-body"[\s\S]*id="kt-ai-pane-exec"/.test(html), 'Workspace のペイン exec（反映）: 右のタブ「反映」（中身が無い間は案内だけ）');
  assert(/<div id="kt-ai-pane-log" class="kt-ai-pane"><div id="kt-ai-apply-log">/.test(html) && !html.includes('data-pane="log"') && /id="kt-ai-log-open"[^>]*data-act="open-log"/.test(m.$('kt-ai-header').innerHTML), 'Workspace のペイン log（反映の記録）: タブではなくヘッダーの［反映の記録］から開く');
  assert(/<details id="kt-ai-plan-detail"[^>]*>[\s\S]*?id="kt-ai-plan-result"/.test(html) && /id="kt-ai-pane-plan"[^>]*><div id="kt-ai-subject-info"><\/div><div id="kt-ai-pane-plan-empty"[^>]*>会話からまとまった変更内容を、ここに表示します。<\/div><div id="kt-ai-change-summary"><\/div><div id="kt-ai-spec"><\/div>/.test(html), '変更内容のペイン: 相談対象・空のときの案内・変更内容の要約・実装の内容、計画の全文は［計画の詳細と根拠］（details）の中');
  const tabs = m.$('kt-ai-drawer-tabs').innerHTML;
  const tabOf = (p) => { const x = tabs.match(new RegExp(`<button type="button" class="([^"]*)" data-pane="${p}"([^>]*)>([^<]*)`)) || []; return { cls: x[1] || '', attrs: x[2] || '', label: x[3] || '' }; };
  const order = [...tabs.matchAll(/data-pane="(\w+)"/g)].map(x => x[1]).join();
  assert(order === 'plan,code,review,exec,evidence,context,connection' && tabOf('plan').label === '変更内容' && tabOf('code').label === 'コード' && tabOf('review').label === '確認結果' && tabOf('exec').label === '反映' && tabOf('evidence').label === '詳細情報' && tabOf('connection').label === '接続' && tabOf('context').label === 'Context', `タブ名: 変更内容 / コード / 確認結果 / 反映 / 詳細情報 / 接続（${order}）`);
  assert(['plan', 'code', 'review', 'exec'].every(p => /^kt-ai-dtab( active)?$/.test(tabOf(p).cls)) && ['evidence', 'context', 'connection'].every(p => /\bis-quiet\b/.test(tabOf(p).cls)) && !/\bbtn\b/.test(tabs) && /style="display:none;"/.test(tabOf('context').attrs) && !/display:none/.test(tabOf('connection').attrs), 'タブの見た目: 主のタブ（変更内容・コード・確認結果）と控えめなタブ（詳細情報・接続）。btn クラスは付けない・接続できる環境では Context を隠す');
  assert(m.panel.drawerState().open === true && m.panel.drawerState().pane === 'plan' && m.$('kt-ai-drawer').style.display !== 'none' && typeof m.panel.closeDrawer === 'undefined' && Object.keys(m.panel.drawerState()).sort().join() === 'open,pane,pinned,rightWidth,unread', '右「現在の作業内容」は常に表示で初期は「変更内容」（closeDrawer は無い。drawerState は open / pane / unread / pinned / rightWidth）');
  assert(/#kt-ai-workspace \.kt-ai-drawer\{ flex:0 1 var\(--kt-ai-right\);[^}]*display:flex/.test(html) && !/kt-ai-drawer-toggle|is-drawer-collapsed|作業パネルを隠す|作業パネルを表示/.test(html), 'desktop: 右は常に表示（flex:0 1 var(--kt-ai-right)・display:flex）。折りたたみの toggle・CSS は無い');
  assert(/class="kt-ai-ws-main"[^>]*>[\s\S]*?<b>会話<\/b><button id="kt-ai-new-conv"[\s\S]*?id="kt-ai-free"[\s\S]*?id="kt-ai-chat"[\s\S]*?id="kt-ai-input"[\s\S]*?<div id="kt-ai-split" class="kt-ai-split" role="separator"[\s\S]*?id="kt-ai-drawer"[\s\S]*?<b>現在の作業内容<\/b>/.test(html) && (html.match(/id="kt-ai-new-conv"/g) || []).length === 1 && !/data-act="new-conv"/.test(html) && m.$('kt-ai-new-conv').disabled === true, '左＝会話（見出し・［新しい会話］は 1 か所・会話・入力欄）、境目（role=separator）、右＝現在の作業内容。会話が 0 件の間は［新しい会話］を押せない');
  assert(m.$('kt-ai-ws-state').innerHTML === '<span class="kt-ai-status" data-status="empty">未作成</span>', `右の見出しの状態: 初期は「未作成」（旧来の「作業中の成果物はありません」などのチップは出さない）: ${m.$('kt-ai-ws-state').innerHTML}`);
  const header = m.$('kt-ai-header').innerHTML;
  assert(/<b style="font-size:12px;">開発支援<\/b>/.test(header) && new RegExp(`案件管理（App ${FX.SELF_APP}）`).test(header) && /反映先：<b>動作テスト環境<\/b>（運用環境は変更しません）/.test(header) && !/解析<\/span>|<\/span> ✓|今回の変更の基準|revision/.test(header) && !/Fields<\/span>/.test(header) && !/Nest Rec AI<\/span>/.test(header), 'ヘッダー（2026-10-06）: 開発支援 / 案件管理（App 310）/ 反映先：動作テスト環境（運用環境は変更しません）。「解析 ✓ JavaScript ✓ AI ✓」の並び・技術情報は並べない');
  assert(/<button type="button" id="kt-ai-header-status" class="kt-ai-quiet" data-act="open-connection"[^>]*>AI 接続済み<\/button>/.test(header) && /id="kt-ai-log-open"[^>]*>反映の記録<\/button>/.test(header), 'ヘッダーの控えめなボタン: ［反映の記録］（0 件は件数を出さない）・［AI 接続済み］（右の「接続」へ）');
  assert(/フィールド 23/.test(header) && /依存関係/.test(header) && /Nest Rec AI: /.test(header) && /id="kt-ai-header-detail" style="display:none;/.test(header), '件数・接続の文は「詳細」（折りたたみ）に');
  await m.$('kt-ai-header').dispatch({ type: 'click', target: { id: 'kt-ai-header-toggle' } });
  m.panel.renderHeader();
  const headerOpen = m.$('kt-ai-header').innerHTML;
  await m.$('kt-ai-header').dispatch({ type: 'click', target: { id: 'kt-ai-header-toggle' } });
  assert(/aria-expanded="true"/.test(headerOpen) && /id="kt-ai-header-detail" style="flex:1 1 100%;/.test(headerOpen) && /id="kt-ai-header-detail" style="display:none;/.test(m.$('kt-ai-header').innerHTML), '［詳細］を開いた状態は描き直しても保つ（もう一度押すと閉じる）');
  await m.$('kt-ai-header').dispatch({ type: 'click', target: { id: 'kt-ai-log-open', dataset: { act: 'open-log' } } });
  assert(m.panel.drawerState().pane === 'log' && /このページではまだ反映していません。/.test(m.$('kt-ai-apply-log').innerHTML) && /運用環境との差/.test(m.$('kt-ai-apply-log').innerHTML), 'ヘッダーの［反映の記録］→ 右に反映の記録（0 件のときはまだ無いことを出す。作業の基準があるので運用環境との差の行も出る）');
  assert(/このアプリについて、相談したいことや変更したいことを入力してください/.test(m.chat()) && !/<button|<li>/.test(m.chat()), 'Empty State（2026-10-06）: 相談・変更したいことを入力する案内だけ（例文の一覧なし）');
}

// =========================================================
console.log('\n--- §3〜§8. 計画 / Review / Before・After / 実行: 左は要約、右は正本（重複なし） ---');
{
  const m = mount();
  await ticks();
  //   C-1 第 3 段: 依頼 → 仮案 → 採用 → 最終案（会話は最終案のカード 1 枚）
  await planOnScreen(m, GOAL);
  const chat = m.chat();
  const { MSG } = KTAiConversation;
  // 変更案（2026-10-06: 会話は 1 枚のカード。版の番号・要件の番号は出さない）
  //   C-1 第 3 段: 変更案のカード（kt-ai-plan-card）・確認事項のカード（answer-questions）は最終案のカードに置き換えた
  //   （tests/ai-flow-redesign.test.js の R09-1・R09-3・R09-9・R09-10 と R10-1・R10-2）。ここでは最終案のカードが要約・件数・まだ反映していないことを出し、版の番号を出さないことを確かめる
  assert(/<b>最終案ができました。<\/b>/.test(chat) && /更新状況を表すフィールドが無いので追加します。/.test(chat + m.$('kt-ai-change-summary').innerHTML) && /設定の手順 2 件/.test(m.$('kt-ai-change-summary').innerHTML) && !/まだ何も反映していません。/.test(chat) && !/変更計画 v\d|v1 を作成|修正: /.test(chat) && !/kt-ai-plan-card/.test(chat), 'chat plan summary（最終案のカード）: 最終案ができました・要約・設定の手順の件数・まだ反映していない（版の番号は出さない）');
  assert(/後で決めてよいことが 1 件あります/.test(chat) && !/Q1/.test(chat), '確認したいこと（後で決めてよいこと）は最終案のカードに件数だけ。番号（Q1）は出さない');
  assert(!/更新状況フィールドを追加/.test(chat) && !/kt-ai-new-field/.test(chat) && !/理由：/.test(chat) && !/提案の内容/.test(chat), 'chat には計画の本文（手順・新規フィールド・理由）が無い');
  assert(!m.msgs().some(x => x.data?.kind === 'plan-summary') && !/変更案を作りました。/.test(chat) && !/<div class="kt-ai-who">(Toolkit|SYSTEM)<\/div>/.test(chat) && /<div class="kt-ai-who">AI<\/div>/.test(chat), '計画の要約の通知（plan-summary）は作らない（最終案のカードにまとめる）。発言者は AI だけ表示（Toolkit / SYSTEM は出さない）');
  const plan = m.$('kt-ai-plan-result').innerHTML;
  assert(/変更計画（AI の提案）/.test(plan) && /更新状況フィールドを追加/.test(plan) && /kt-ai-new-field/.test(plan) && /一覧「担当者別」を追加/.test(plan) && !/kt-ai-decision/.test(plan) && !/id="kt-ai-review"/.test(plan) && m.$('kt-ai-plan-detail').style.display === '', 'full plan only workspace（右の「変更内容」の［計画の詳細と根拠］）: 手順・新規フィールド。判断の select / 確認結果は無い');
  const sum = m.$('kt-ai-change-summary').innerHTML;
  assert(/<h3>更新状況を管理したい<\/h3>/.test(sum) && /対象：フィールド・一覧/.test(sum) && /何が変わるか（Toolkit が確かめた変更前後）/.test(sum) && /更新状況フィールドを追加/.test(sum) && /＋ 新規フィールド「更新状況」/.test(sum) && /新しいフィールド：更新状況/.test(sum) && /確認したいこと（1 件）/.test(sum) && !/\b[PQEC]\d+\b/.test(sum) && m.$('kt-ai-pane-plan-empty').style.display === 'none', '右の「変更内容」の要約: 見出し（依頼）・対象・何が変わるか（Toolkit が確かめた変更前後）・確認したいこと（手順・質問・根拠の番号は出さない）');
  assert(/kt-ai-tech/.test(plan) && /requestId: tk-/.test(plan) && /kt-ai-plan-json-toggle/.test(plan), '技術者向け（requestId / JSON）は「詳細」（details）に');
  assert(m.panel.activeArtifact()?.type === 'CHANGE_PLAN' && m.panel.activeArtifact()?.version === 1 && m.panel.drawerState().pane === 'plan', 'Active Artifact: CHANGE_PLAN v1 → 右は「変更内容」（Auto Navigation）');
  assert(m.$('kt-ai-ws-state').innerHTML === '<span class="kt-ai-status" data-status="ready">未反映</span>', `右の見出しの状態: 変更案ができて反映前は「未反映」（旧来の「変更計画 v1 / Review済み / Preview未反映」のチップは出さない）: ${m.$('kt-ai-ws-state').innerHTML}`);
  // 確認したいこと（priority 無し）が残っていても反映は止めない（承認が 0 件の間は、承認を案内する）
  const exec0 = m.$('kt-ai-exec').innerHTML;
  await KF.waitUntil(() => m.panel.finalPrecheck().status === 'ready', 60);
  { const b0 = KF.applyButtonOf(m);
    assert(m.panel.applyHold() === null && !/kt-ai-exec-start/.test(exec0) && /最終案のカードの［動作テスト環境へ反映］/.test(exec0) && !/step がありません/.test(exec0) && m.$('kt-ai-exec-empty').style.display === 'none' && b0 && !b0.disabled && writes(m).length === 0, '右の「反映」: 最終案の流れでは準備・最終確認の段を出さず、最終案のカードの［動作テスト環境へ反映］を案内する。承認の欄の準備（書き込みなし）が終わると押せる（priority の無い確認事項では止めない）'); }
  // Toolkit の確認（REVIEW）の詳しくは右の「確認結果」
  //   C-1 第 3 段: Review の会話のカード（REVIEW）と要約の通知（review-summary）は作らない（tests/ai-flow-redesign.test.js の R09-3）。最終案のカードは確認結果の場所を示す
  assert(!/kt-ai-review-card/.test(chat) && !/Toolkitで変更計画を検証しました/.test(chat) && !/Toolkit で変更案を確認しました。/.test(chat) && !m.msgs().some(x => x.type === MSG.REVIEW || x.data?.kind === 'review-summary') && /Toolkit の確認結果は右の「確認結果」/.test(m.$('kt-ai-change-summary').innerHTML) && !/kt-ai-decision/.test(chat) && !/安全に追加できる変更/.test(chat), 'review summary: Toolkit の確認は最終案のカードの 1 行だけ（詳しくは右の「確認結果」）。判断 select・内訳は会話に無い');
  const review = m.$('kt-ai-review-result').innerHTML;
  //   簡素化 D・E（2026-10-16）: 手順ごとの承認・保留の select と、安全区分から数えた「安全に追加できる変更」の行は削除した（欄は［この手順を反映しない］だけ・承認は最終案の 1 回）
  assert(/Toolkit で確認した結果/.test(review) && /手順ごとの判定/.test(review) && (review.match(/type="checkbox" class="kt-ai-decision"/g) || []).length === 2 && !/安全に追加できる変更/.test(review) && /kt-ai-review-diff-toggle/.test(review) && /kt-ai-tech/.test(review) && /kt-ai-review-json-copy/.test(review) && m.$('kt-ai-review-empty').style.display === 'none', 'full review only workspace（右の「確認結果」）: 手順ごとの判定 ＋［この手順を反映しない］（2 件）・変更前後・技術者向け');
  await clickTab(m, 'review');
  assert(m.panel.drawerState().pane === 'review', 'タブ「確認結果」→ 右の「確認結果」');
  // 外す指定は右だけ（簡素化 E: 承認・保留の判断は削除。外した手順は最終案の承認の指紋に入り、反映しない）
  await m.$('kt-ai-review-result').dispatch({ type: 'change', target: { dataset: { step: 'P2' }, checked: true } });
  assert(/外した手順: P2/.test(m.$('kt-ai-review-decisions').textContent) && !/kt-ai-decision/.test(m.chat()), 'Human Decision workspace only（§16）: 右の「確認結果」の［この手順を反映しない］で外す。会話に欄は無い');
  await m.$('kt-ai-review-result').dispatch({ type: 'change', target: { dataset: { step: 'P2' }, checked: false } });
  assert(m.$('kt-ai-review-decisions').textContent === '', '外す指定を戻すと、外した手順の行は消える');
  // Before / After: 右の「確認結果」の変更前後
  //   C-1 第 3 段: 変更案のカードの［変更前後を見る］（会話の案内のカード before-after → open-diff）は、変更案のカードと一緒に無くなった。
  //   変更前後は右の「確認結果」の［変更前後］（kt-ai-review-diff-toggle）で開く
  //   （偽の DOM は初めの display:none を読まないので、押す前と後で表示が切り替わることで確かめる）
  const diffBefore = m.$('kt-ai-review-diff').style.display;
  await clickPane(m, 'review', { id: 'kt-ai-review-diff-toggle' });
  assert(m.$('kt-ai-review-diff').style.display !== diffBefore && /id="kt-ai-review-diff-toggle"[^>]*>変更前後を比較</.test(m.$('kt-ai-review-result').innerHTML) && /P2<\/b>/.test(m.$('kt-ai-review-result').innerHTML) && !/kt-ai-diff-card/.test(m.chat()), '［変更前後を比較］→ 右の「確認結果」の変更前後を開く（会話には出さない）');
  // 旧版 / 最新版（§15）
  await m.panel.send('更新状況フィールドはいらない'); await ticks(12);
  const c3 = m.chat();
  //   C-1 第 3 段: 前の変更案のカードは前の最終案のカード（1 行に畳む。tests/ai-flow-redesign.test.js の R10-4・F2-2）
  assert(/<b>最終案を直しました。<\/b>/.test(c3) && /前の最終案 — このあと直した案があります/.test(c3) && m.conv().planHistory().length === 2 && !/v2 に更新済み|変更計画 v\d|v2 を見直し/.test(c3), 'old plan: 前の最終案のカードは「このあと直した案があります」（履歴として残る。版の番号は出さない）');
  const oldCard = KTAiChatUi.messageHtml(m.msgs().find(x => x.type === 'FINAL'), { plans: new Map(m.conv().planHistory().map(v => [`${v.planId}:${v.version}`, v])), activePlan: m.conv().activePlan(), answerState: m.conv().answerContext(), ledger: m.conv().ledger(), answers: new Map() });
  assert(/前の最終案 — このあと直した案があります/.test(oldCard) && !/kt-ai-qa-input/.test(oldCard) && !/data-act="final-approve"/.test(oldCard), 'old plan: 前の最終案のカードには回答欄・承認のボタンを出さない');
  assert(m.panel.activeArtifact()?.version === 2 && !/kt-ai-new-field/.test(m.$('kt-ai-plan-result').innerHTML) && /既存「担当者」を利用/.test(m.$('kt-ai-plan-result').innerHTML) && /既存の担当者を使い、一覧の追加だけにします。/.test(m.$('kt-ai-change-summary').innerHTML) && !/新しいフィールド：/.test(m.$('kt-ai-change-summary').innerHTML) && /data-status="ready"/.test(m.$('kt-ai-ws-state').innerHTML), 'active version: 右は新しい版だけ（activeArtifact v2・変更内容の要約も新しい版）');
  // v2 を承認してから反映（判断は版ごと）
  //   C-1 第 3 段: 反映の許可は最終案のカードの承認（tests/ai-flow-redesign.test.js の R16）。右の「確認結果」の手順ごとの判断（却下など）はそのまま使える
  await m.$('kt-ai-review-result').dispatch({ type: 'change', target: { dataset: { step: 'P1' }, checked: false } });
  await m.$('kt-ai-review-result').dispatch({ type: 'change', target: { dataset: { step: 'P2' }, checked: false } });
  // 実行（標準設定）: 最終案のカードの［動作テスト環境へ反映］1 回。押すと右のタブ「反映」に進捗と結果（表示中のタブから切り替わる）
  await clickChat(m, 'open-plan');
  const ar1 = await applyOnScreenM(m);
  assert(ar1.button && !ar1.button.disabled && ar1.run && ar1.run.stage === 'done' && m.conv().activePlan().approval && m.conv().activePlan().approval.precheck, '前提: 最終案（v2）を［動作テスト環境へ反映］1 回で承認（承認の欄の準備の指紋つき）');
  assert(m.panel.drawerState().pane === 'exec' && m.$('kt-ai-pane-exec').style.display === 'block' && m.panel.activeArtifact()?.type === 'EXECUTION' && /動作テスト環境への反映<\/b>/.test(m.$('kt-ai-exec').innerHTML) && !/id="kt-ai-exec-go"/.test(m.$('kt-ai-exec').innerHTML) && !/Preview Executor/.test(m.$('kt-ai-exec').innerHTML), '［動作テスト環境へ反映］→ 右のタブ「反映」に進捗と結果（タブが切り替わる。用語は「動作テスト環境への反映」。最終確認の段は出さない）');
  const c2 = m.chat();
  assert(m.panel.executorState().stage === 'done' && /kt-ai-final-apply-card/.test(c2) && !/kt-ai-execution-card/.test(c2) && /動作テスト環境へ反映しました。/.test(c2) && /標準設定: ✓ \d+ 件を反映（反映後の確認で一致）/.test(c2) && !/VERIFIED/.test(c2) && /運用環境には反映されていません。/.test(c2) && /data-act="exec-details"/.test(c2) && !/Simulationとの一致/.test(c2) && !/監査 JSON/.test(c2), 'execution summary（結果のカード 1 枚）: 反映後の確認（✓ N 件。VERIFIED の語は出さない）・運用環境の注意・［実行結果を見る］。進捗 / Simulation / 監査は会話に無い');
  assert(m.msgs().some(x => x.data?.kind === 'preview-changed') && !/動作テスト環境の設定が変更されました/.test(c2), '反映の処理の通知（preview-changed）は conv.messages に残し、会話には出さない（反映のカードと同じ内容）');
  assert(/Simulationとの一致/.test(m.$('kt-ai-exec').innerHTML) && /kt-ai-exec-audit-copy/.test(m.$('kt-ai-exec').innerHTML) && /kt-ai-exec-rollback-start/.test(m.$('kt-ai-exec').innerHTML) && m.$('kt-ai-ws-state').innerHTML === '<span class="kt-ai-status" data-status="applied">反映済み</span>', '右下の右の「反映」に詳細（Simulation / 監査 / 戻す）。右の見出しの状態は「反映済み」');
}

// =========================================================
console.log('\n--- §9. Evidence: 根拠チップは会話の［根拠と詳細］に残し、詳細は右の「詳細情報」だけ ---');
{
  const m = mount();
  await ticks();
  await m.panel.send('金額は何に使ってる？'); await ticks();
  const chat = m.chat();
  const eid = (chat.match(/data-eid="(E\d+)"/) || [])[1];
  assert(eid && !/kt-ai-fact-detail/.test(chat) && !/statement/.test(chat), `回答に根拠チップ（${eid}）はあるが、根拠の全文は会話に無い`);
  const [body, detail = ''] = chat.split('<details class="kt-ai-answer-detail"');
  assert(!/AI回答/.test(chat) && !/requestId|data-eid/.test(body) && /data-eid="E1"/.test(detail) && /requestId: /.test(detail), '回答のカード: 「AI回答」の見出しは出さない。根拠チップと requestId は［根拠と詳細］の中だけ');
  const a = { ...m.panel.lastAnswer(), answer: 'このフィールドは金額です [E1]。' };
  const inChat = KTContextUi.answerHtml(a, { chat: true }), inCtx = KTContextUi.answerHtml(a, {});
  assert(/<div class="kt-ai-answer-text kt-ai-rich"><p>このフィールドは金額です。<\/p><\/div>/.test(inChat) && !/\[E1\]/.test(inChat) && /<b>AI回答<\/b>/.test(inCtx) && /class="kt-ai-answer-text"[^>]*>このフィールドは金額です <button[^>]*data-eid="E1"/.test(inCtx), 'answerHtml(a, { chat: true }): 本文の [E1] はチップにせず消す（Context ペインの回答は従来どおり見出し・チップあり）');
  await m.$('kt-ai-chat').dispatch({ type: 'click', target: { dataset: { eid } } });
  assert(m.panel.drawerState().pane === 'evidence' && m.$('kt-ai-fact-detail').style.display === '' && m.$('kt-ai-fact-detail').innerHTML.length > 20 && m.panel.activeArtifact()?.type === 'EVIDENCE' && m.panel.activeArtifact()?.id === eid, 'チップ → 右の「詳細情報」に詳細（EVIDENCE artifact）。会話は変わらない');
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
  assert(/相談中の JavaScript/.test(info) && /fieldOnOff\.js/.test(info) && /app\.record\.create\.show/.test(info) && /制御<\/span><span>amount/.test(info) && /取得済み/.test(info) && m.panel.drawerState().pane === 'plan' && m.panel.activeArtifact()?.type === 'CONSULTATION', '右の「変更内容」に相談対象の現在情報（イベント / 制御 / 本文）。artifact CONSULTATION');
  assert(/相談中: fieldOnOff\.js（PC）/.test(m.$('kt-ai-header').innerHTML) && m.$('kt-ai-ws-state').innerHTML === '<span class="kt-ai-status" data-status="consulting">相談中</span>', 'ヘッダーの相談中バッジ・右の見出しの状態「相談中」');
  //   C-1 第 3 段: 相談の依頼も仮案から（tests/ai-flow-redesign.test.js の F1）。採用すると計画 → JavaScript の生成・検証（生成工程）→ 最終案のカード。
  //   仕様のカード（「JavaScript の実装の内容をまとめました。」・spec-intro）・［この仕様で確定］・［JavaScript を生成］・コードのカード（code-intro）は無い
  //   （tests/ai-flow-redesign.test.js の R09-2・R09-3・F7-1〜F7-3・F2-3・F11-3）
  await planOnScreen(m, '承認済みでは金額を編集できなくしたい');
  const c1 = m.chat();
  const vH = m.conv().activePlan();
  assert(m.calls.propose.length === 1 && m.calls.propose[0].ctx.facts.some(f => /相談中の JavaScript「fieldOnOff\.js」/.test(f.statement)) && vH && vH.final && /<b>最終案ができました。<\/b>/.test(c1) && !/JavaScript の実装の内容をまとめました。/.test(c1) && !/data-act="confirm-spec"/.test(c1) && !/data-act="open-spec"/.test(c1) && !m.msgs().some(x => ['spec-intro', 'code-intro'].includes(x.data?.kind) || ['SPEC', 'CODE'].includes(x.type)), '相談の依頼 → 仮案（相談中の JavaScript を渡す）→ 採用 → 最終案のカード 1 枚（仕様・コードのカードと確定ボタンは無い）');
  assert(/設定の手順 1 件/.test(m.$('kt-ai-change-summary').innerHTML) && /fieldOnOff\.js/.test(c1) && !/\bC1\b/.test(c1.replace(/<[^>]+>/g, ' ')), '最終案のカード: 設定の手順の件数と JavaScript のファイル（番号 C1 は出さない）');
  assert(!/data-act="confirm-spec"/.test(m.$('kt-ai-spec').innerHTML) && /「[^」]+」（制御）/.test(m.$('kt-ai-spec').innerHTML) && !/amount（CONTROL）/.test(m.$('kt-ai-spec').innerHTML) &&/最終案の一部です/.test(m.$('kt-ai-spec').innerHTML) && vH.spec.status === 'CONFIRMED' && vH.spec.autoConfirmed === true && /data-status="ready">未反映</.test(m.$('kt-ai-ws-state').innerHTML), `実装の内容（右の「変更内容」）: 詳細の閲覧だけ（確定は最終案の中で自動）。右の見出しは「未反映」: ${m.$('kt-ai-ws-state').innerHTML}`);
  // 右の「コード」: 全文・検査の内訳・参考パターン・［動作テスト環境へ登録］
  //   C-1 第 3 段: 新しい流れでは、最終案ができたら作った JavaScript を右の「コード」に描いておき（ペインは切り替えない）、最終案のカードの［コードを見る］
  //   からも開ける（以前はコードのカードの［コードを見る］と従来の生成の後の自動表示）
  await clickTab(m, 'code');
  assert(m.panel.drawerState().pane === 'code' && m.$('kt-ai-code-view').textContent.includes("value === '完了'") && /✓ 既存ファイルへの統合/.test(m.$('kt-ai-code-review').innerHTML) && /参考パターン/.test(m.$('kt-ai-code-review').innerHTML), 'full code only workspace（右の「コード」）: 全文・検査の内訳・参考パターン（§0e.1: 仮案から作った最終案の登録は最終案のカードの［動作テスト環境へ反映］から。右の「コード」の［動作テスト環境へ登録］は出さない）');
  assert(/data-status="ready">未反映</.test(m.$('kt-ai-ws-state').innerHTML), 'コードを作った後も、右の見出しは登録まで「未反映」');
  //   C-1 第 3 段: 登録の許可は最終案の承認（承認の前は登録の準備をしない。tests/ai-flow-redesign.test.js の R16・D14・F10-2）。
  //   簡素化（2026-10-17）: 登録の準備と登録は、最終案のカードの［動作テスト環境へ反映］1 回の中だけ（右の「反映」から登録を始める口は無い）
  assert(m.panel.jsExecState().stage === 'idle' && !m.conv().activePlan().approval && writes(m).filter(w => /PUT customize/.test(w)).length === 0, `承認の前は登録の準備・登録に進まない: ${m.panel.jsExecState().stage}`);
  //   §0e.1（2026-10-09）: 最終案のカードの［動作テスト環境へ反映］1 回で、設定の手順と JavaScript の登録を続けて行う（承認の欄に示した確認項目は承認で確認済み。
  //   右の「反映」の登録の最終確認は出さない）。押すと右のタブ「反映」に切り替わる
  await clickTab(m, 'code');
  const arJ = await applyOnScreenM(m);
  assert(arJ.button && !arJ.button.disabled && arJ.pre.items.files.some(x => /✎ fieldOnOff\.js（PC）既存ファイルを更新/.test(x)) && arJ.run && arJ.run.stage === 'done' && m.panel.drawerState().pane === 'exec' && m.$('kt-ai-pane-exec').style.display === 'block', '［動作テスト環境へ反映］1 回 → 承認の欄に置き換えるファイル（fieldOnOff.js）・登録まで進み、右のタブ「反映」に切り替わる');
  const c4 = m.chat();
  assert(m.panel.jsExecState().stage === 'done' && /動作テスト環境へ反映しました。/.test(arJ.card) && /JavaScript: ✎ fieldOnOff\.js（PC） を登録（反映後の確認 ✓ 1 \/ 1 件一致）/.test(arJ.card) && !/VERIFIED/.test(c4) && /data-act="open-js-result"/.test(arJ.cardHtml) && /data-act="open-customize"/.test(arJ.cardHtml) && !/sourceHash/.test(c4) && !/Audit/.test(c4) && !/kt-ai-js-execution-card/.test(c4), 'JS 登録の要約（左・結果のカード 1 枚）: ファイル・反映後の確認（✓ 1 / 1 件一致）・［登録結果を見る］［Customize で確認］。検証の内訳・監査・VERIFIED の語は無い');
  assert(m.msgs().some(x => x.data?.kind === 'js-preview-changed') && !/JavaScript カスタマイズ設定が変更されました/.test(c4), '登録の処理の通知（js-preview-changed）は会話に出さない（登録のカードと同じ内容）');
  assert(/sourceHash/.test(m.$('kt-ai-jsreg').innerHTML) && m.$('kt-ai-ws-state').innerHTML === '<span class="kt-ai-status" data-status="applied">反映済み</span>', '右下の右の「反映」に検証の内訳。右の見出しの状態は「反映済み」');
  await clickChat(m, 'open-customize', { target: 'desktop', name: 'fieldOnOff.js' });
  assert(m.opened.length === 1 && m.opened[0].name === 'fieldOnOff.js', '［Customize で確認］→ Customize タブへ');
  assert(writes(m).filter(w => /PUT customize/.test(w)).length === 1 && JSON.stringify(arJ.writes.filter(w => !/customize|file/.test(w))) === JSON.stringify(writes(m).filter(w => !/customize|file/.test(w))), 'JavaScript の書き込みは登録の PUT 1 回だけ。書き込みはすべて［動作テスト環境へ反映］の 1 回の中（会話の文章では書かない）');
}

// =========================================================
console.log('\n--- §13. Auto Navigation: 読んでいる最中のペインは奪わない（タブを自分で選んだ後 60 秒は印だけ） ---');
{
  const m = mount();
  await ticks();
  await clickTab(m, 'context');
  assert(m.panel.drawerState().pane === 'context' && m.panel.drawerState().pinned === 'context', 'タブ「Context」を自分で選ぶ（pinned）');
  await planOnScreen(m, GOAL);
  assert(m.panel.drawerState().pane === 'context' && m.panel.drawerState().unread.includes('plan') && /data-pane="plan" role="tab" aria-selected="false">変更内容<span class="kt-ai-dtab-dot"/.test(m.$('kt-ai-drawer-tabs').innerHTML) && m.panel.activeArtifact()?.type === 'CHANGE_PLAN', '変更案が届いても Context を読んでいる最中は切り替えず、「変更内容」タブに ● を付ける（artifact は更新）');
  await clickTab(m, 'plan');
  assert(m.panel.drawerState().pane === 'plan' && !m.panel.drawerState().unread.includes('plan') && !/kt-ai-dtab-dot/.test(m.$('kt-ai-drawer-tabs').innerHTML), 'タブ「変更内容」を開くと印が消える');
  const m2 = mount();
  await ticks();
  await clickTab(m2, 'context');
  m2.clock.t += 61 * 1000;
  await planOnScreen(m2, GOAL);
  assert(m2.panel.drawerState().pane === 'plan', '60 秒を過ぎていれば自動で「変更内容」へ');
  const m3 = mount();
  await ticks();
  await clickChat(m3, 'open-plan');   // 会話のボタンからの移動は「読んでいる最中」ではない
  await planOnScreen(m3, GOAL);
  assert(m3.panel.drawerState().pane === 'plan' && m3.panel.drawerState().pinned === null, '会話のボタンからの移動は pin にならない（自動表示は通る）');
}

// =========================================================
console.log('\n--- §18 / §19. Free Features / Connection は右（Context / 接続） ---');
{
  const f = mount({ paid: false });
  await ticks();
  assert(/id="kt-ai-pane-context"[\s\S]*id="kt-ai-generate"[\s\S]*id="kt-ai-pane-connection"/.test(f.host.innerHTML) && f.host.innerHTML.includes('id="kt-ai-copy-prompt"') && f.host.innerHTML.includes('id="kt-ai-doc-kind"'), 'free context: AI Prompt / Markdown / JSON / ドキュメントは右「Context」');
  const ftabs = f.$('kt-ai-drawer-tabs').innerHTML;
  const fheader = f.$('kt-ai-header').innerHTML;
  assert(!/data-pane="context"[^>]*display:none/.test(ftabs) && /data-pane="connection"[^>]*style="display:none;"/.test(ftabs) && !/id="kt-ai-header-status"/.test(fheader) && !/反映先：/.test(fheader), '接続機能の無い環境: 「Context」のタブを出し「接続」を隠す。ヘッダーに AI の接続・反映先は出さない');
  // 無料パネルの［AI用Promptを生成］は出さない（2026-10-06）。接続機能の無い環境では、右の「Context」のタブから開く
  assert(!/kt-ai-free-generate/.test(f.$('kt-ai-free').innerHTML), '無料パネルに［AI用Promptを生成］は出さない');
  await f.$('kt-ai-drawer-tabs').dispatch({ type: 'click', target: { dataset: { pane: 'context' } } });
  assert(f.panel.drawerState().pane === 'context', '接続機能の無い環境: 右の「Context」のタブで開く');
  f.panel.setMode('doc', { kind: 'spec' }); f.$('kt-ai-generate').dispatch('click'); await ticks();
  assert(f.panel.currentOutput()?.text.includes('## Context') && f.calls.plan.length === 0, 'ドキュメントは右「Context」で生成（Gateway 不要）');
  const m = mount();
  await ticks();
  const header = m.$('kt-ai-header').innerHTML;
  assert(/data-pane="connection"/.test(m.$('kt-ai-drawer-tabs').innerHTML) && /id="kt-ai-pane-connection"[\s\S]*id="kt-ai-paid"/.test(m.host.innerHTML) && /id="kt-ai-header-status"[^>]*data-act="open-connection"[^>]*>AI 接続済み<\/button>/.test(header) && !/AI<\/span> ✓/.test(header) && !/kt-ai-session-lines/.test(header), 'connection: 接続情報は右の「接続」。上部は［AI 接続済み］だけ');
  await m.$('kt-ai-header').dispatch({ type: 'click', target: { id: 'kt-ai-header-status', dataset: { act: 'open-connection' } } });
  assert(m.panel.drawerState().pane === 'connection', 'ヘッダーの［AI 接続済み］→ 右の「接続」');
}

// =========================================================
console.log('\n--- §23 / §24. Narrow Width: 縦積み（折りたたまない）・左右の幅 ---');
{
  const m = mount();
  await ticks();
  const html = m.host.innerHTML;
  assert(/container-type:inline-size; container-name:kt-ai-ws;/.test(html) && /@container kt-ai-ws \(max-width: 760px\)\{[\s\S]*?\.kt-ai-ws-body\{ flex-direction:column; \}[\s\S]*?\.kt-ai-split\{ display:none; \}[\s\S]*?\.kt-ai-ws-main\{ flex:1 1 58%; min-width:0; min-height:180px; \}[\s\S]*?\.kt-ai-drawer\{ flex:1 1 42%;/.test(html) && !/\.kt-ai-drawer\{ display:none|is-drawer-collapsed|#kt-ai-drawer-toggle/.test(html), '狭い幅（container query: 開発支援タブ自身の幅 ≤ 760px）: 会話 → 現在の作業内容の縦積みだけ（境目は隠す。右は折りたたまない）');
  // 折りたたみは廃止: 旧 toggle の操作が来ても右は閉じない
  await m.$('kt-ai-header').dispatch({ type: 'click', target: { id: 'kt-ai-drawer-toggle' } });
  assert(m.panel.drawerState().open === true && m.panel.drawerState().pane === 'plan' && typeof m.panel.closeDrawer === 'undefined' && !/作業パネルを隠す|作業パネルを表示|kt-ai-drawer-toggle/.test(m.$('kt-ai-header').innerHTML), '折りたたみは廃止（作業パネルを隠す / 表示・closeDrawer は無い。右は常に表示）');
  m.panel.openDrawer('review');
  assert(m.panel.drawerState().open === true && m.panel.drawerState().pane === 'review', 'openDrawer（旧 API）はペインを開くだけ（右は常に表示）');
  // 左右の境目: 右の幅（%）を 28〜68 の範囲で変えられる
  const w0 = m.panel.drawerState().rightWidth;
  const w1 = m.panel.setSplit(60), w1s = m.panel.drawerState().rightWidth, w2 = m.panel.setSplit(90), w3 = m.panel.setSplit(5);
  assert(w0 === 46 && w1 === 60 && w1s === 60 && w2 === 68 && w3 === 28 && m.panel.drawerState().rightWidth === 28 && m.panel.drawerState().open === true, `左右の境目（setSplit）: 右の幅は 28〜68% の範囲（${w0} → ${w1} → ${w2} → ${w3}）`);
  assert(/<div id="kt-ai-split" class="kt-ai-split" role="separator" aria-orientation="vertical"/.test(html), '境目 #kt-ai-split は role="separator"（ドラッグ・← → キーで幅を変える）');
  assert(!/kt-ai-drawer-close/.test(m.$('kt-ai-drawer-tabs').innerHTML), 'タブ列に × は無い（常に表示）');
}

// =========================================================
console.log('\n--- §27. ViewModel（純関数）: Chat と Workspace は同じ値 ---');
{
  const gen = KTContextUi.generatePlan({ goal: GOAL, inputs: INPUTS });
  const v = { planId: 'p', version: 1, status: 'ACTIVE', goal: GOAL, plan: { ...KTAiClient.validatePlan(PLAN_V1, gen.ctx).normalized, requestId: 'pl-1' } };
  v.review = KTPlanReview.review({ plan: v.plan, ...INPUTS });
  //   簡素化（2026-10-17）: 画面に出ていなかった作業状態（workspaceState）と、それだけが使う planSummary・reviewSummary は削除した
  assert(VM.specSummary(v) === null && VM.executionSummary({ stage: 'idle' }) === null && VM.jsExecutionSummary({ stage: 'idle' }) === null, '無いものは null');
  const vh = { planId: 'h', version: 2, status: 'ACTIVE', goal: GOAL_HYBRID, plan: PLAN_HYBRID.plan, review: null, spec: { specId: 'h:spec', version: 2, status: 'CONFIRMED', confirmedAt: 'x', customizations: PLAN_HYBRID.plan.customizations }, generated: { C1: { generated: { ...genPatch(), patterns: PATTERNS }, review: { status: 'OK', diff: { added: 3, removed: 0 } }, existingSource: { name: 'fieldOnOff.js', target: 'desktop', text: FIELD_ON_OFF } } } };
  const cs = VM.codeSummary(vh.generated.C1, 'C1', vh);
  assert(cs.targetFile === 'fieldOnOff.js' && cs.ok && cs.added === 3 && cs.removed === 0 && cs.target === 'desktop' && cs.patterns.join() === 'field-disable' && cs.external === false, 'codeSummary');
  const sp = VM.specSummary(vh);
  assert(sp.specVersion === 2 && sp.status === 'CONFIRMED' && sp.customizations[0].files.join() === 'fieldOnOff.js' && sp.customizations[0].platform.join() === 'desktop', 'specSummary');
  const js = VM.jsExecutionSummary({ stage: 'done', execution: { executionId: 'x', status: 'DONE', put: { ok: true }, steps: [{ name: 'a.js', target: 'mobile', kind: 'ADD_FILE', status: 'VERIFIED' }, { name: 'b.js', target: 'desktop', kind: 'REPLACE_FILE', status: 'VERIFY_FAILED' }], rollback: { status: 'ROLLED_BACK_VERIFIED', verification: { restoredToSnapshot: true } } } });
  assert(js.verified === 1 && js.steps.length === 2 && js.ok && js.written && js.rolledBack && js.rollbackRestored === true && js.firstStep.name === 'a.js', 'jsExecutionSummary');
  assert(VM.artifactLabel({ type: 'CHANGE_PLAN', version: 3 }) === '変更計画 v3' && VM.artifactLabel({ type: 'GENERATED_CODE', customizationId: 'C1', targetFile: 'a.js' }) === '生成コード C1（a.js）' && VM.paneFor({ type: 'EXECUTION' }) === 'exec' && VM.paneFor({ type: 'REVIEW' }) === 'review' && VM.paneFor({ type: 'DOCUMENT' }) === 'context', 'artifactLabel / paneFor');
  assert(Object.keys(VM.ARTIFACT).sort().join() === 'CHANGE_PLAN,CONSULTATION,CONTEXT,CUSTOMIZATION_SPEC,DOCUMENT,EVIDENCE,EXECUTION,GENERATED_CODE,REVIEW,ROLLBACK', 'Artifact Types（§12）');
  // 2026-10-06: ペインの名前・主のタブ・右の見出しの状態（workStatus）
  assert(JSON.stringify(VM.PANE_JA) === JSON.stringify({ plan: '変更内容', review: '確認結果', code: 'コード', exec: '反映', evidence: '詳細情報', context: 'Context', connection: '接続', log: '反映の記録' }) && VM.PANES.includes('log') && VM.PRIMARY_TABS.join() === 'plan,code,review,exec' && VM.TABS.join() === 'plan,code,review,exec,evidence,context,connection', 'VM: ペインの名前（変更内容・確認結果・コード・反映・詳細情報・Context・接続・反映の記録）・主のタブ（変更内容・コード・確認結果・反映）');
  const S = (o) => { const s = VM.workStatus(o); return `${s.key}:${s.label}`; };
  const exDone = { stage: 'done', execution: { status: 'DONE', steps: [{ status: 'VERIFIED' }] } };
  const exRolled = { stage: 'rolled-back', execution: { status: 'DONE', steps: [{ status: 'VERIFIED' }], rollback: { status: 'ROLLED_BACK_VERIFIED' } } };
  const exRbFailed = { stage: 'rolled-back', execution: { status: 'DONE', steps: [{ status: 'VERIFIED' }], rollback: { status: 'ROLLBACK_FAILED' } } };
  const exPartial = { stage: 'done', execution: { status: 'FAILED', steps: [{ status: 'VERIFIED' }, { status: 'FAILED' }] } };
  const statuses = [S({}), S({ subject: { name: 'a.js' } }), S({ working: 'PLAN' }), S({ version: v, working: 'PLAN' }), S({ version: v, working: 'REVISE' }), S({ version: v, working: 'GENERATE' }), S({ version: v }), S({ version: v, running: 'preparing' }), S({ version: v, running: 'running' }), S({ version: v, running: 'rolling-back' })];
  assert(statuses.join('|') === 'empty:未作成|consulting:相談中|checking:確認中|updating:更新中|updating:更新中|updating:更新中|ready:未反映|applying:反映の準備中|applying:反映中|applying:元に戻しています', `workStatus: 未作成 / 相談中 / 確認中（最初の変更案）/ 更新中 / 未反映 / 反映の準備中・反映中・元に戻しています: ${statuses.join('|')}`);
  const doneSt = [S({ version: v, current: [VM.executionSummary(exDone)] }), S({ version: v, current: [VM.executionSummary(exRolled)] }), S({ version: v, current: [VM.executionSummary(exRbFailed)] }), S({ version: v, current: [VM.executionSummary(exPartial)] }), S({ version: v, current: [VM.executionSummary({ stage: 'confirm', prepared: { executionId: 'x', steps: [] } })] })];
  assert(doneSt.join('|') === 'applied:反映済み|rolled-back:元に戻し済み|attention:要確認|attention:要確認|ready:未反映', `workStatus（今の変更案の反映）: 反映済み / 元に戻し済み / 要確認（戻せない・一部だけ）/ 書き込む前は未反映: ${doneSt.join('|')}`);
  // Chat と Workspace が同じ値（別々に計算しない）
  //   C-1 第 3 段: 変更案のカード（planCardHtml）と Review のカード（reviewCardHtml）の描画は、古い確認の流れと一緒に削除した（tests/ai-flow-redesign.test.js の F7-2）。
  //   会話のカードは最終案のカード 1 枚（R09-1・R09-9）で、版の番号を出さないこと・古い版のカードを畳むことは R09-10・R10-4・F2-2 と、この file の §3〜§8 の old plan で確かめる
  assert(KTAiChatUi.planCardHtml === undefined && KTAiChatUi.reviewCardHtml === undefined && typeof KTAiChatUi.messageHtml === 'function', '変更案のカード・Review のカードの描画は無い（会話のカードは最終案のカード）');
  // 通常の会話に出さない内部処理の通知（isHiddenMessage）。chatHtml は出さないものを数えない
  const { MSG } = KTAiConversation;
  const msg = (kind, extra = {}, type = MSG.ASSISTANT_TEXT, role = 'toolkit') => ({ id: `m-${kind}-${extra.stage || ''}`, type, role, text: `通知 ${kind}`, data: { kind, ...extra } });
  //   C-1 第 3 段: 変更案の要約・確認・仕様・コードの案内（reasked・plan-summary・review-summary・spec-intro・code-intro）は作らなくなった
  //   （tests/ai-flow-redesign.test.js の R09-3・F5-1・F7）。残る内部処理の通知だけを出さない
  const hiddenKinds = ['connected', 'preview-changed', 'js-preview-changed', 'rolled-back', 'js-rolled-back'];
  assert(hiddenKinds.every(k => KTAiChatUi.isHiddenMessage(msg(k))) && !KTAiChatUi.isHiddenMessage(msg('rollback-ready')), 'isHiddenMessage: 内部処理の通知（connected / preview-changed / js-preview-changed / rolled-back / js-rolled-back）は会話に出さない');
  const ackShown = ['queued', 'revising', 'done', 'failed', 'cancelled', 'pending', 'superseded'].filter(st => !KTAiChatUi.isHiddenMessage(msg('answers-ack', { stage: st, texts: ['保存時です'] })));
  const ackHtml = KTAiChatUi.chatHtml([msg('answers-ack', { stage: 'failed', texts: ['保存時です'] })]);
  assert(ackShown.join() === 'failed,cancelled,pending,superseded' && /「保存時です」は、まだ変更案に入っていません（作り直しに失敗しました）。/.test(ackHtml) && /kintone には何も反映していません。/.test(ackHtml), `answers-ack: 受け付けた・入れた の知らせは出さず、まだ変更案に入っていない（失敗・取り消し・上限・置き換え）ときだけ出す: ${ackShown.join()}`);
  //   C-1 第 3 段: 要件の変わった点の通知（requirements-changes。古い流れの announceTurn だけが作った）は削除した。計画が対応できないとした要件は
  //   最終案のカードの「実現できない点」に出す（tests/ai-requirements.test.js の「計画では対応できないとされた要件」）
  const many = [msg('connected'), msg('js-preview-changed'), { id: 'u1', type: MSG.USER, role: 'user', text: '一つめ', data: {} }, msg('preview-changed'), { id: 'u2', type: MSG.USER, role: 'user', text: '二つめ', data: {} }];
  const limited = KTAiChatUi.chatHtml(many, {}, { limit: 1 });
  assert(/以前のメッセージ 1 件を表示/.test(limited) && /二つめ/.test(limited) && !/一つめ/.test(limited) && /このアプリについて、相談したいことや変更したいことを入力してください/.test(KTAiChatUi.chatHtml([msg('preview-changed'), msg('connected')])), 'chatHtml: 出さないものは数えない（以前のメッセージの件数・空の会話の案内）');
  assert(/<div class="kt-ai-who">AI<\/div>/.test(KTAiChatUi.chatHtml([msg('x', {}, MSG.ASSISTANT_TEXT, 'assistant')])) && !/kt-ai-who/.test(KTAiChatUi.chatHtml([msg('x', {}, MSG.ASSISTANT_TEXT, 'toolkit'), msg('y', {}, MSG.SYSTEM_NOTICE, 'system')])) && /<div class="kt-ai-bubble">表示の文<\/div>/.test(KTAiChatUi.chatHtml([{ id: 'u', type: MSG.USER, role: 'user', text: '送る文', data: { displayText: '表示の文' } }])), '発言者の表示: assistant は「AI」、toolkit / system は出さない。利用者の発言は data.displayText があればそれを出す');
  assert(!/function assetCardsHtml|function customizationCardHtml/.test(SRC_TEXT), '重複レンダラー（資産カード / Customization カード）は削除');
}

// =========================================================
// 2026-10-05（利用者の指摘）: 「新しい会話を始めたら新しい会話の内容だけを見たい。一方、あとから検証環境に反映した内容をまとめて確認したい」
console.log('\n--- §21. 新しい会話は新しい会話の内容だけ・動作テスト環境への反映の記録（会話をまたいで、このページを開いている間） ---');
const section = async (fn) => { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 2).join(' / ') : e}`); } };
await section(async () => {
  // N1: 新しい会話で右を空にし、前の会話の計画は新しい会話から反映できない
  const m = mount();
  await ticks();
  await planOnScreen(m, GOAL);
  await m.$('kt-ai-review-result').dispatch({ type: 'change', target: { dataset: { step: 'P1' }, checked: false } });
  //   §0e.1: 承認の欄の準備（書き込みなし）が終わると最終案のカードの［動作テスト環境へ反映］を押せる
  await KF.waitUntil(() => m.panel.finalPrecheck().status === 'ready', 60);
  const vN1 = m.conv().activePlan();
  assert(KF.applyButtonOf(m) && !KF.applyButtonOf(m).disabled && /更新状況/.test(m.$('kt-ai-plan-result').innerHTML), '前提: 計画 v1 の最終案（［動作テスト環境へ反映］を押せる）');
  // ［新しい会話］は左の見出しの 1 か所。押すとすぐ新しい会話（確認のカードは出さない）
  assert(m.$('kt-ai-new-conv').disabled === false, '前提: 会話があるので［新しい会話］を押せる');
  await m.$('kt-ai-new-conv').dispatch('click'); await ticks();
  assert(m.msgs().length === 0 && !/new-conv-choices|kt-ai-choices-card/.test(m.chat()) && m.$('kt-ai-new-conv').disabled === true, 'N1: ［新しい会話］を押すとすぐ新しい会話（確認のカードは出さない）。会話が 0 件の間は押せない');
  assert(m.$('kt-ai-plan-result').innerHTML === '' && m.$('kt-ai-plan-result').style.display === 'none' && m.$('kt-ai-plan-detail').style.display === 'none' && m.$('kt-ai-change-summary').innerHTML === '' && m.$('kt-ai-pane-plan-empty').style.display === '' && m.$('kt-ai-review-result').innerHTML === '' && m.$('kt-ai-review-empty').style.display === '', 'N1: 新しい会話では右の「変更内容」「確認結果」に前の会話の変更案を残さない');
  assert(!/kt-ai-exec-start/.test(m.$('kt-ai-exec').innerHTML) && m.$('kt-ai-pane-exec').style.display === 'none' && m.$('kt-ai-ws-state').innerHTML === '<span class="kt-ai-status" data-status="empty">未作成</span>' && m.panel.drawerState().pane === 'plan' && !m.panel.activeArtifact(), 'N1: 右下の右の「反映」に前の計画の［反映］を出さない（欄も閉じる）・右の見出しは「未作成」・表示中の成果物も無し');
  const ra = await m.panel.applyFinal(vN1.planId, vN1.version); await ticks(4);
  assert(ra === null && !vN1.approval && m.panel.executorState().stage === 'idle' && writes(m).length === 0 && !/data-act="final-approve"/.test(m.chat()), 'N1: 前の会話の計画は新しい会話から反映できない（準備も、最終案のカードの反映も。以前は検証と承認が残り、そのまま反映できた）');
});
await section(async () => {
  // N1b: 計画の無かった会話（質問だけ・根拠を開いた）でも、新しい会話では右を片づける
  const m = mount();
  await ticks();
  await m.panel.send('金額は何に使ってる？'); await ticks();
  const eid = (m.chat().match(/data-eid="(E\d+)"/) || [])[1];
  await m.$('kt-ai-chat').dispatch({ type: 'click', target: { dataset: { eid } } });
  assert(m.panel.drawerState().pane === 'evidence' && m.$('kt-ai-fact-detail').innerHTML.length > 20 && m.panel.activeArtifact()?.type === 'EVIDENCE', '前提: 質問だけの会話で根拠を右の「詳細情報」に開いている');
  await m.$('kt-ai-new-conv').dispatch('click'); await ticks();
  assert(m.msgs().length === 0 && m.$('kt-ai-fact-detail').innerHTML === '' && m.$('kt-ai-fact-detail').style.display === 'none' && !m.panel.activeArtifact() && m.panel.drawerState().pane === 'plan' && /data-status="empty"/.test(m.$('kt-ai-ws-state').innerHTML), 'N1b: 計画の無かった会話でも、新しい会話で根拠の中身・表示中の成果物・表示中のペインを戻す');
});
await section(async () => {
  // N2: ［動作テスト環境へ反映］を押した直後（反映の前の確かめの間）に新しい会話になったら、前の計画は反映しない（何も書き込まない）
  //   簡素化（2026-10-17）: 承認だけを記録して右で準備する口は削除した。押した反映の途中の新しい会話で確かめる
  const m = mount();
  await ticks();
  await planOnScreen(m, GOAL);
  await KF.waitUntil(() => m.panel.finalPrecheck().status === 'ready', 60);
  const v = m.conv().activePlan();
  const p = clickChat(m, 'final-approve', { plan: v.planId, version: String(v.version) });
  await m.$('kt-ai-new-conv').dispatch('click');
  await p; await ticks();
  const fr = m.panel.finalRun();
  assert(fr && fr.stage === 'stopped' && !fr.written && m.panel.executorState().stage === 'idle' && writes(m).length === 0 && m.conv().messages().length === 0, `N2: 押した直後に新しい会話 → 前の計画は反映しない（書き込み 0。新しい会話に前の結果を出さない）: ${fr && fr.stage}`);
});
await section(async () => {
  // N3〜N5: 反映の記録（会話をまたぐ）・記録から戻す・監査 JSON・2 つめの会話の反映
  const m = mount();
  await ticks();
  await planOnScreen(m, GOAL);
  await m.$('kt-ai-review-result').dispatch({ type: 'change', target: { dataset: { step: 'P1' }, checked: false } });
  await applyOnScreenM(m);   // §0e.1: 最終案のカードの［動作テスト環境へ反映］1 回で承認と反映
  const exId = m.panel.executorState().execution?.executionId;
  let log = m.$('kt-ai-apply-log').innerHTML;
  assert(m.mock.st.fields.progress && exId && /動作テスト環境への反映の記録/.test(log) && /反映済み（未復元）/.test(log) && /この会話/.test(log) && /計画 v1/.test(log) && /依頼: 更新状況を管理したい/.test(log) && /更新状況フィールドを追加/.test(log) && /上で表示中/.test(log), 'N3: 反映すると記録に出る（いつ・どの依頼・何を・状態）');
  assert(/id="kt-ai-log-open"[^>]*>反映の記録<span class="kt-ai-count">1<\/span><\/button>/.test(m.$('kt-ai-header').innerHTML), 'N3: ヘッダーの［反映の記録］に件数（1）を出す');
  await m.$('kt-ai-header').dispatch({ type: 'click', target: { id: 'kt-ai-log-open', dataset: { act: 'open-log' } } });
  assert(m.panel.drawerState().pane === 'log' && /class="kt-ai-apply-log-item"/.test(m.$('kt-ai-apply-log').innerHTML), 'N3: ［反映の記録］→ 右に反映の記録（drawerState().pane は log）');
  const logId = (log.match(/data-log="([^"]+)"/) || [])[1];
  await m.$('kt-ai-new-conv').dispatch('click'); await ticks();
  log = m.$('kt-ai-apply-log').innerHTML;
  assert(m.msgs().length === 0 && !/Simulationとの一致/.test(m.$('kt-ai-exec').innerHTML) && /前の会話/.test(log) && /反映済み（未復元）/.test(log) && /data-act="log-open"/.test(log) && /詳細・元に戻す/.test(log) && !/上で表示中/.test(log), 'N3: 新しい会話の右下の右の「反映」に前の会話の反映結果は出さず、反映の記録に「前の会話」として残す');
  assert(m.panel.unrevertedPreviewChange() === true, 'N3: 戻していない反映がある間は、ページを離れる前の確認を続ける（記録の分も含む）');
  // 監査 JSON（記録から）: 反映した時点の計画と判断（新しい会話の後も）
  m.copies.length = 0;
  await clickPane(m, 'log', { dataset: { act: 'log-audit', log: logId } }); await ticks();
  const audit = m.copies.length ? JSON.parse(m.copies[m.copies.length - 1]) : null;
  //   簡素化 E（2026-10-16）: 手順ごとの承認は削除した。監査 JSON の判断（humanDecisions）は外した手順だけ（この反映では無い）
  assert(audit && /更新状況を管理したい/.test(JSON.stringify(audit)) && JSON.stringify(audit).includes(exId) && JSON.stringify(audit.humanDecisions || {}) === '{}', 'N4: 記録の監査 JSON は、反映した時点の計画と外した手順（新しい会話の後も）');
  // 新しい会話でも「戻して」→ カード → 記録から開いて、既存の確認（現在の設定との照合）を通して戻す
  await m.panel.send('やっぱり元に戻して'); await ticks();
  const card = m.msgs().find(x => x.data?.kind === 'rollback-ready');
  assert(card && card.data.executionId === exId, 'N3: 新しい会話でも「戻して」で前の会話の反映を戻す案内');
  await clickChat(m, 'rollback', { execution: exId }); await ticks(8);
  assert(m.panel.executorState().stage === 'rollback-confirm' && /反映の記録から開いた反映です（前の会話・依頼: 更新状況を管理したい）/.test(m.$('kt-ai-exec').innerHTML) && !m.msgs().some(x => x.type === 'EXECUTION'), `N3: 記録から開いて戻す確認へ（新しい会話に前の反映の「反映しています」カードを出さない）: ${m.panel.executorState().stage}`);
  await clickPane(m, 'exec', { id: 'kt-ai-exec-rollback-go' }); await ticks(8);
  log = m.$('kt-ai-apply-log').innerHTML;
  assert(!m.mock.st.fields.progress && /元に戻し済み/.test(log) && m.panel.unrevertedPreviewChange() === false && m.conv().state.activeExecution?.rolledBack === true && m.msgs().some(x => x.data?.kind === 'apply-log-rolled-back') && /反映の記録から開いた反映（前の会話・依頼: 更新状況を管理したい）を、変更前の状態に戻しました。/.test(m.chat()), 'N3: 前の会話の反映を記録から戻せる（記録は「元に戻し済み」・「戻して」の判定も更新・会話に結果の一言）');
  // 戻した結果は右下の右の「反映」に残る（同じ会話の中で通知が増えただけで、右を新しい会話のように片づけない）
  assert(m.panel.executorState().stage === 'rolled-back' && m.$('kt-ai-exec').innerHTML !== '', `N3: 記録から戻した結果は右下の右の「反映」に残る（stage: ${m.panel.executorState().stage}・右の「反映」: ${m.$('kt-ai-exec').innerHTML ? 'あり' : '空'}）`);
  // N5: この会話で別の計画を反映すると、記録は 2 件（右下の右の「反映」は今の会話の反映）
  await planOnScreen(m, GOAL, { intent: 'PLAN' });
  await m.$('kt-ai-review-result').dispatch({ type: 'change', target: { dataset: { step: 'P1' }, checked: false } });
  await applyOnScreenM(m);   // §0e.1: 最終案のカードの［動作テスト環境へ反映］1 回で承認と反映
  log = m.$('kt-ai-apply-log').innerHTML;
  const items = (log.match(/class="kt-ai-apply-log-item"/g) || []).length;
  assert(items === 2 && /元に戻し済み/.test(log) && /反映済み（未復元）/.test(log) && /この会話/.test(log) && /前の会話/.test(log) && m.panel.executorState().stage === 'done' && !/反映の記録から開いた/.test(m.$('kt-ai-exec').innerHTML), `N5: 会話をまたいだ反映が記録にまとまる（${items} 件）。右下の右の「反映」は今の会話の反映`);
});
await section(async () => {
  // N6: 同じ会話で別の計画になったら、前の計画の生成コードをコードペインに残さない
  const m = mount({ plans: (ctx) => (firstLine(ctx.goal) === GOAL_HYBRID ? PLAN_HYBRID : PLAN_V1) });
  await ticks();
  await planOnScreen(m, GOAL_HYBRID);   // C-1 第 3 段: JavaScript は最終案のパイプラインが作る（仕様の確定・［JavaScript を生成］は無い）
  await openCodePane(m);
  assert(m.$('kt-ai-code-view').textContent.includes("value === '完了'"), '前提: 計画 A（JS あり）のコードがコードペインにある（§0e.1: 登録は最終案のカードから。右の「コード」の登録ボタンは出さない）');
  await planOnScreen(m, GOAL, { intent: 'PLAN' });
  assert(m.conv().activePlan().plan.goal === GOAL && !/fieldOnOff\.js/.test(m.$('kt-ai-code-head').innerHTML) && m.$('kt-ai-code-view').style.display === 'none', `N6: 別の計画 B（版の番号は同じ 1）になったら、計画 A のコードと登録ボタンを残さない: ${m.$('kt-ai-code-head').innerHTML.slice(0, 80)}`);
});
await section(async () => {
  // N6b: 同じ計画の新しい版になったら、前の版のコードを最新として残さず、前の版の最終案は反映しない（承認の欄の準備は新しい版でやり直す）
  const m = mount({ plans: () => PLAN_HYBRID });
  await ticks();
  await planOnScreen(m, GOAL_HYBRID);   // C-1 第 3 段: JavaScript は最終案のパイプラインが作る
  await openCodePane(m);
  await KF.waitUntil(() => m.panel.finalPrecheck().status === 'ready', 60);
  const vA = m.conv().activePlan();
  assert(m.panel.finalPrecheck().version === vA.version && m.$('kt-ai-code-view').style.display === '', '前提: 変更案の版 1 のコードを表示し、承認の欄の準備が終わっている');
  await m.panel.send('モバイルでも同じようにして', { intent: 'REVISE_PLAN' }); await ticks(8);
  const vB = m.conv().activePlan();
  assert(vB.planId === vA.planId && vB.version === vA.version + 1 && m.$('kt-ai-code-head').innerHTML === '変更案が新しくなったため、前の変更案のコードは表示していません。新しい変更案でコードを作ると、ここに表示します。' && m.$('kt-ai-code-view').style.display === 'none' && m.panel.codeShown() === null, 'N6b: 同じ計画の新しい版になったら、前の版のコードは消して「変更案が新しくなったため…」と書く');
  const rA = await m.panel.applyFinal(vA.planId, vA.version); await ticks(4);
  assert(rA === null && !vA.approval && m.panel.jsExecState().stage === 'idle' && writes(m).filter(w => /PUT customize/.test(w)).length === 0, 'N6b: 前の版の最終案は反映しない（承認も登録もしない）');
});
await section(async () => {
  // N7: JavaScript の登録も記録に残し、新しい会話の後に記録から開ける
  const m = mount({ plans: () => PLAN_HYBRID });
  await ticks();
  const seed = KTContext.buildConsultationSeed({ data: INPUTS.data, deps: INPUTS.deps, scan: INPUTS.scan, file: { name: 'fieldOnOff.js', target: 'desktop', type: 'FILE', fileKey: '20261003000000EEEE', size: '300' }, sourceText: FIELD_ON_OFF, appName: '案件管理' });
  m.panel.consult(seed);
  await planOnScreen(m, '承認済みでは金額を編集できなくしたい');   // C-1 第 3 段: 相談の依頼も仮案から。JavaScript は最終案のパイプラインが作る
  await openCodePane(m);
  await applyOnScreenM(m);   // §0e.1: 最終案のカードの［動作テスト環境へ反映］1 回で承認と反映（設定の手順 → JavaScript の登録）
  const log = m.$('kt-ai-apply-log').innerHTML;
  assert(m.panel.jsExecState().stage === 'done' && /JavaScript の登録/.test(log) && /PC「fieldOnOff\.js」/.test(log) && /反映済み（未復元）/.test(log), 'N7: JavaScript の登録も記録に出る');
  const logId = (log.match(/data-log="([^"]+)"/) || [])[1];
  await m.$('kt-ai-new-conv').dispatch('click'); await ticks();
  assert(m.msgs().length === 0 && m.panel.jsExecState().stage === 'idle' && !/sourceHash/.test(m.$('kt-ai-jsreg').innerHTML) && /前の会話/.test(m.$('kt-ai-apply-log').innerHTML) && m.panel.unrevertedPreviewChange() === true, 'N7: 新しい会話の右下の右の「反映」に前の会話の登録結果を出さず、記録に残す');
  await clickPane(m, 'log', { dataset: { act: 'log-open', log: logId } }); await ticks();
  assert(m.panel.jsExecState().stage === 'done' && /反映の記録から開いた JavaScript の登録です（前の会話・依頼:/.test(m.$('kt-ai-jsreg').innerHTML) && /sourceHash/.test(m.$('kt-ai-jsreg').innerHTML) && m.msgs().length === 0, 'N7: 記録から開くと、登録の結果を右下の右の「反映」に出す（新しい会話に前の会話のカードは出さない）');
});

// =========================================================
// 2026-10-05（§21 の差分レビューの指摘）: 記録を開く・閉じる・処理の途中・会話の写し・表示
console.log('\n--- §22. 反映の記録の差分レビューの指摘（処理の途中に開く・閉じる・途中で新しい会話・手順・状態・古いコードカード・運用環境との差） ---');
const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
const logItems = (html) => [...html.matchAll(/<li class="kt-ai-apply-log-item" data-log="([^"]+)"[\s\S]*?<\/li>/g)].map(x => ({ id: x[1], html: x[0], label: (x[0].match(/font-weight:600;">([^<]+)<\/span>/) || [])[1] }));
const execHas = (m, id) => new RegExp(`id="${id}"`).test(m.$('kt-ai-exec').innerHTML);
/** §0e.1: 今の最終案の表示（右の「反映」は今の計画の案内・最終案のカードに［動作テスト環境へ反映］がある） */
const nowPlanReady = (m) => /kt-ai-apply-note/.test(m.$('kt-ai-exec').innerHTML) && !/data-act="log-close"/.test(m.$('kt-ai-exec').innerHTML) && !!KF.applyButtonOf(m);
const applyP1 = async (m, goal = GOAL, opts = {}) => {
  await planOnScreen(m, goal, opts);   // C-1 第 3 段: 依頼 → 仮案 → 採用 → 最終案
  await m.$('kt-ai-review-result').dispatch({ type: 'change', target: { dataset: { step: 'P1' }, checked: false } });
  await applyOnScreenM(m);   // §0e.1: 最終案のカードの［動作テスト環境へ反映］1 回で承認と反映
};
await section(async () => {
  // L1（high）: 反映の途中に記録の同じ項目・別の項目を開いても、途中の反映を「完了」にせず、別の記録を上書きしない
  const PLAN_VIEW = JSON.parse(JSON.stringify(PLAN_V1));
  PLAN_VIEW.plan.proposedFields = [];
  PLAN_VIEW.plan.steps = [{ ...PLAN_V1.plan.steps[1], id: 'P1', dependsOn: [], spec: { ...PLAN_V1.plan.steps[1].spec, fields: ['owner', 'case_name'] }, title: '一覧「担当者別」を追加' }];
  PLAN_VIEW.plan.questions = [];
  //   C-1 第 3 段: 最終案は、実行できない設定の手順（反映済みの一覧「担当者別」をもう一度追加する P2）が残ると承認できない（手順を選んで一部だけ反映しない）。
  //   2 つめの計画は、更新状況フィールドの追加（PLAN_V1 の P1）だけにする（確かめるのは反映の記録の振る舞い）
  const PLAN_FIELD = JSON.parse(JSON.stringify(PLAN_V1));
  PLAN_FIELD.plan.steps = [PLAN_V1.plan.steps[0]];
  PLAN_FIELD.plan.questions = [];
  let n = 0;
  const inputs = buildInputs();
  const m = mount({ inputs, plans: () => (++n === 1 ? PLAN_VIEW : PLAN_FIELD) });
  await ticks();
  await planOnScreen(m, GOAL);
  await applyOnScreenM(m);   // §0e.1: 最終案のカードの［動作テスト環境へ反映］1 回で承認と反映
  const exB = m.panel.executorState().execution.executionId;
  inputs.data.views.views['担当者別'] = JSON.parse(JSON.stringify(m.mock.st.views['担当者別']));
  await m.$('kt-ai-new-conv').dispatch('click'); await ticks();
  await planOnScreen(m, GOAL);
  //   反映の途中に記録を開く操作を確かめる（最終案のカードの［動作テスト環境へ反映］を押し、最初の設定の書き込みで止めておく）
  const g = gate();
  { const o = m.mock.api.addPreviewFields; let first = true; m.mock.api.addPreviewFields = async (...a) => { if (first) { first = false; await g.p; } return o.apply(m.mock.api, a); }; }
  await KF.waitUntil(() => m.panel.finalPrecheck().status === 'ready', 60);
  const vL1 = m.conv().activePlan();
  const run = clickChat(m, 'final-approve', { plan: vL1.planId, version: String(vL1.version) });
  await KF.waitUntil(() => m.panel.executorState().stage === 'running', 100); await ticks(2);
  const exA = m.panel.executorState().prepared.executionId;
  const items = logItems(m.$('kt-ai-apply-log').innerHTML);
  const idA = items.find(x => /この会話/.test(x.html)).id, idB = items.find(x => /前の会話/.test(x.html)).id;
  assert(m.panel.executorState().stage === 'running' && items.find(x => x.id === idA).label === '処理中', '前提: 反映の途中（記録は「処理中」）');
  await clickPane(m, 'log', { dataset: { act: 'log-open', log: idA } }); await ticks();
  assert(m.panel.executorState().stage === 'running', `L1: 反映の途中に同じ記録を開いても、途中のまま（「完了」にしない）: ${m.panel.executorState().stage}`);
  await clickPane(m, 'log', { dataset: { act: 'log-open', log: idB } }); await ticks();
  assert(m.panel.executorState().stage === 'running' && m.panel.executorState().prepared.executionId === exA && m.msgs().some(x => x.data?.kind === 'apply-log-busy'), 'L1: 反映の途中は別の記録を開かない（案内を出す）');
  g.open(); await run; await ticks(8);
  const st = m.panel.executorState();
  const items2 = logItems(m.$('kt-ai-apply-log').innerHTML);
  assert(st.stage === 'done' && st.execution.executionId === exA && st.prepared.executionId === exA && m.mock.st.fields.progress && items2.find(x => x.id === idA).label === '反映済み（未復元）' && items2.find(x => x.id === idB).label === '反映済み（未復元）', 'L1: 反映が終わると、結果はその反映の記録に入る（別の記録を上書きしない）');
  await clickPane(m, 'log', { dataset: { act: 'log-open', log: idB } }); await ticks();
  const rbB = await m.panel.startRollback();
  assert(m.panel.executorState().execution.executionId === exB && rbB && rbB.status === 'PREPARED', `L1: 前の反映（B）も記録から開いて戻す確認へ進める: ${rbB && rbB.status}`);
  m.panel.cancelRollback();
  // 戻している途中に同じ記録を開いても、途中のまま
  await clickPane(m, 'log', { dataset: { act: 'log-open', log: idA } }); await ticks();
  await m.panel.startRollback();
  const g2 = gate();
  for (const k of Object.keys(m.mock.api)) { if (/^(get|download)/.test(k)) continue; const o = m.mock.api[k]; let first = true; m.mock.api[k] = async (...a) => { if (first) { first = false; await g2.p; } return o.apply(m.mock.api, a); }; }
  const rb = m.panel.confirmRollback(); await ticks(4);
  const busyStage = m.panel.executorState().stage;
  assert(logItems(m.$('kt-ai-apply-log').innerHTML).find(x => x.id === idA).label === '処理中', `L5: 戻している途中は、記録を「処理中」と出す（「元に戻せず（要確認）」にしない）: ${busyStage}`);
  await clickPane(m, 'log', { dataset: { act: 'log-open', log: idA } }); await ticks();
  assert(m.panel.executorState().stage === busyStage && busyStage === 'rolling-back', `L1: 戻している途中に同じ記録を開いても、途中のまま: ${m.panel.executorState().stage}`);
  g2.open(); await rb; await ticks(8);
  assert(m.panel.executorState().stage === 'rolled-back' && m.panel.executorState().execution.executionId === exA && logItems(m.$('kt-ai-apply-log').innerHTML).find(x => x.id === idA).label === '元に戻し済み', 'L1: 戻し終わった結果は、その反映の記録に入る');
});
await section(async () => {
  // L2（medium）: 記録から開いた前の会話の反映は［閉じる（今の計画に戻る）］で閉じられ、今の計画の［動作テスト環境へ反映］が戻る
  for (const rolled of [true, false]) {
    const m = mount();
    await ticks();
    await applyP1(m);
    if (rolled) { await clickPane(m, 'exec', { id: 'kt-ai-exec-rollback-start' }); await ticks(8); await clickPane(m, 'exec', { id: 'kt-ai-exec-rollback-go' }); await ticks(8); }
    const logId = logItems(m.$('kt-ai-apply-log').innerHTML)[0].id;
    await m.$('kt-ai-new-conv').dispatch('click'); await ticks();
    await planOnScreen(m, GOAL, { intent: 'PLAN' });
    await m.$('kt-ai-review-result').dispatch({ type: 'change', target: { dataset: { step: 'P1' }, checked: false } });
    await KF.waitUntil(() => m.panel.finalPrecheck().status === 'ready', 60);
    assert(nowPlanReady(m) && (rolled ? !KF.applyButtonOf(m).disabled : (KF.applyButtonOf(m).disabled && m.conv().finalReadiness().ready === false && m.conv().finalReadiness().reasons.some(r => r.kind === 'blocked'))), `前提（${rolled ? '戻し済み' : '未復元'}）: 新しい会話の最終案の［動作テスト環境へ反映］が出る（右の「反映」は今の計画の案内）。${rolled ? '押せる' : '前の会話の反映が残っていて同じフィールドが動作テスト環境にあるため、計画の確認（今の動作テスト環境の設定）で反映できない手順になり、承認できず止まり、押せない（理由を出す）'}: ${JSON.stringify(m.panel.finalPrecheck().reasons)}`);
    await clickPane(m, 'log', { dataset: { act: 'log-open', log: logId } }); await ticks();
    assert(!/kt-ai-apply-note/.test(m.$('kt-ai-exec').innerHTML) && /data-act="log-close"/.test(m.$('kt-ai-exec').innerHTML) && /反映の記録から開いた反映です（前の会話・/.test(m.$('kt-ai-exec').innerHTML), `L2（${rolled ? '戻し済み' : '未復元'}）: 記録から開くと、右下の右の「反映」に［閉じる（今の計画に戻る）］が出る`);
    await clickPane(m, 'exec', { dataset: { act: 'log-close' } }); await ticks();
    const label = logItems(m.$('kt-ai-apply-log').innerHTML)[0].label;
    assert(nowPlanReady(m) && m.panel.executorState().stage === 'idle' && label === (rolled ? '元に戻し済み' : '反映済み（未復元）') && m.panel.unrevertedPreviewChange() === !rolled, `L2（${rolled ? '戻し済み' : '未復元'}）: 閉じると今の計画の［動作テスト環境へ反映］に戻る（反映は記録に残る: ${label}）`);
    // 判断の変更・新しい版でも、記録から開いた反映は今の計画に戻る（簡素化 E: 判断は［この手順を反映しない］だけ。外して戻す）
    await clickPane(m, 'log', { dataset: { act: 'log-open', log: logId } }); await ticks();
    await m.$('kt-ai-review-result').dispatch({ type: 'change', target: { dataset: { step: 'P1' }, checked: true } });
    await m.$('kt-ai-review-result').dispatch({ type: 'change', target: { dataset: { step: 'P1' }, checked: false } });
    await KF.waitUntil(() => m.panel.finalPrecheck().status === 'ready', 60);
    assert(nowPlanReady(m), `L2（${rolled ? '戻し済み' : '未復元'}）: 記録から開いた後に今の計画の判断を変えると、今の計画に戻る`);
    await clickPane(m, 'log', { dataset: { act: 'log-open', log: logId } }); await ticks();
    await m.panel.send('担当者は既存のフィールドを使って', { intent: 'REVISE_PLAN' }); await ticks(8);
    assert(m.conv().activePlan().version === 2 && m.panel.executorState().stage === 'idle', `L2（${rolled ? '戻し済み' : '未復元'}）: 新しい版になると、記録から開いた反映は記録に戻し、右下の右の「反映」は今の計画: ${m.panel.executorState().stage}`);
  }
  // 同じ会話の自分の反映は、今までどおり次の計画でも右下の右の「反映」に残す（閉じるボタンも出さない。反映済みの計画の修正は新しい計画になる）
  const m = mount();
  await ticks();
  await applyP1(m);
  const p0 = m.conv().activePlan().planId;
  await planOnScreen(m, '別件で、一覧を追加したい', { intent: 'PLAN' });   // C-1 第 3 段: 新しい依頼も仮案から
  assert(m.conv().activePlan().planId !== p0 && m.panel.executorState().stage === 'done' && !/data-act="log-close"/.test(m.$('kt-ai-exec').innerHTML), 'L2: 同じ会話の反映は、次の計画でも右下の右の「反映」に残す（今までどおり）');
});
await section(async () => {
  // L3（medium）: 反映の途中に新しい会話にしても、終わった後の「戻して」は前の反映を戻す案内を出す（HEAD と同じ）
  const m = mount();
  await ticks();
  await planOnScreen(m, GOAL);
  await m.$('kt-ai-review-result').dispatch({ type: 'change', target: { dataset: { step: 'P1' }, checked: false } });
  //   §0e.1: 最終案のカードの［動作テスト環境へ反映］を押し、書き込みの手前で止めておく
  await KF.waitUntil(() => m.panel.finalPrecheck().status === 'ready', 60);
  const v3 = m.conv().activePlan();
  const g = gate();
  for (const k of Object.keys(m.mock.api)) { if (/^(get|download)/.test(k)) continue; const f = m.mock.api[k]; m.mock.api[k] = async (...a) => { await g.p; return f.apply(m.mock.api, a); }; }
  const p = clickChat(m, 'final-approve', { plan: v3.planId, version: String(v3.version) });
  await KF.waitUntil(() => m.panel.executorState().stage === 'running', 100);
  assert(m.panel.executorState().stage === 'running' && m.conv().state.activeExecution?.written === false, '前提: 反映の途中（まだ書き込んでいない）');
  await m.$('kt-ai-new-conv').dispatch('click'); await ticks();
  g.open(); await p; await ticks(12);
  const exId = m.panel.executorState().execution.executionId;
  assert(m.mock.st.fields.progress && m.conv().state.activeExecution?.executionId === exId && m.conv().state.activeExecution.written === true && m.msgs().length === 0, 'L3: 書き込んで終わったら、「戻して」の判定の写しだけを置く（新しい会話にメッセージは足さない）');
  assert(/前の会話（依頼: 更新状況を管理したい）の反映です。/.test(m.$('kt-ai-exec').innerHTML) && !/反映の記録から開いた/.test(m.$('kt-ai-exec').innerHTML), 'L8: 記録から開いていない反映に「記録から開いた」と書かない');
  await m.panel.send('やっぱり元に戻して'); await ticks();
  const card = m.msgs().find(x => x.data?.kind === 'rollback-ready');
  assert(card && card.data.executionId === exId, 'L3: 「戻して」で前の反映を戻す案内（以前は「反映はまだ行っていません」）');
});
await section(async () => {
  // L4（medium）: 記録の「手順:」は、承認して反映した手順だけ
  const m = mount();
  await ticks();
  await planOnScreen(m, GOAL);
  await m.$('kt-ai-review-result').dispatch({ type: 'change', target: { dataset: { step: 'P1' }, checked: false } });
  await m.$('kt-ai-review-result').dispatch({ type: 'change', target: { dataset: { step: 'P2' }, checked: true } });
  await applyOnScreenM(m);   // §0e.1: 最終案のカードの［動作テスト環境へ反映］1 回（却下した手順は承認の欄にも出さず、反映しない）
  const it = logItems(m.$('kt-ai-apply-log').innerHTML)[0];
  assert(/更新状況フィールドを追加/.test(it.html) && !/担当者別/.test(it.html) && !m.mock.st.views['担当者別'], 'L4: 却下した手順（一覧「担当者別」）は記録の手順に出さない');
});
await section(async () => {
  // L5（medium）: 戻す確認の画面は「元に戻せず（要確認）」にしない。確認のまま新しい会話にしても同じ
  const m = mount();
  await ticks();
  await applyP1(m);
  await clickPane(m, 'exec', { id: 'kt-ai-exec-rollback-start' }); await ticks(8);
  assert(m.panel.executorState().stage === 'rollback-confirm' && logItems(m.$('kt-ai-apply-log').innerHTML)[0].label === '反映済み（未復元）', `L5: 戻す確認の画面の間は「反映済み（未復元）」: ${logItems(m.$('kt-ai-apply-log').innerHTML)[0].label}`);
  await m.$('kt-ai-new-conv').dispatch('click'); await ticks();
  const it = logItems(m.$('kt-ai-apply-log').innerHTML)[0];
  assert(it.label === '反映済み（未復元）' && /詳細・元に戻す/.test(it.html) && m.panel.unrevertedPreviewChange() === true, `L5: 確認のまま新しい会話にしても「反映済み（未復元）」のまま: ${it.label}`);
  await clickPane(m, 'log', { dataset: { act: 'log-open', log: it.id } }); await ticks();
  const rb = await m.panel.startRollback();
  assert(rb && rb.status === 'PREPARED', 'L5: 記録から開いて、もう一度戻す確認へ進める');
});
await section(async () => {
  // L6（medium）: 同じ会話で別の計画になっても、会話に残る前の計画のコードカードからそのコードを見られる（登録はできない）
  //   C-1 第 3 段: JavaScript は最終案のパイプラインが作る（仕様の確定・［JavaScript を生成］・コードのカードは無い）。
  //   最終案のカードの［コードを見る］にカードの計画の版を付けるので、会話に残る前の計画の最終案のカードから、その計画のコードを開ける（1 つめの期待）。
  //   2 つめ以降は、同じ操作（open-code・copy-code）を直接送り、右の「コード」が前の計画のコードを登録ボタン無しで出すことを確かめる
  const m = mount({ plans: (ctx) => (firstLine(ctx.goal) === GOAL_HYBRID ? PLAN_HYBRID : PLAN_V1) });
  await ticks();
  await planOnScreen(m, GOAL_HYBRID);
  const vA = m.conv().activePlan();
  await planOnScreen(m, GOAL, { intent: 'PLAN' });
  const btn = (m.chat().match(/<button[^>]*data-act="open-code"[^>]*data-view="code"[^>]*>/) || [''])[0];
  assert(new RegExp(`data-plan="${vA.planId}" data-version="${vA.version}"`).test(btn), 'L6: 最終案のカードの［コードを見る］に、カードの計画の版を付ける');
  await clickChat(m, 'open-code', { cid: 'C1', view: 'code', plan: vA.planId, version: String(vA.version) }); await ticks();
  assert(m.$('kt-ai-code-view').textContent.includes("value === '完了'") && m.$('kt-ai-code-view').style.display !== 'none', 'L6: 前の計画のカードからコードを見られる（登録ボタンは出さない）');
  await clickChat(m, 'open-code', { cid: 'C1', view: 'code' }); await ticks();
  assert(m.$('kt-ai-code-view').textContent.includes("value === '完了'"), 'L6: 版の付いていない古いカードも、会話の版から探して見られる');
});
await section(async () => {
  // L7（medium）: 記録の「運用環境との差」: ［差分を見る］が効く・title は属性・読み込み直した直後も出す・反映後の件数
  const { makeEnvGetter } = require('./helpers/dev-base-fake.js');
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const PROD = FX.makeData();
  let changed = false;
  const prevData = () => { const d = clone(PROD); if (changed) d.fields.progress = { type: 'DROP_DOWN', code: 'progress', label: '更新状況', noLabel: false, required: false, options: { '未着手': { label: '未着手', index: '0' } } }; return d; };
  const loadDevBase = async () => { const g = makeEnvGetter({ preview: prevData(), production: PROD, files: {} }); return T.KTDevBase.load({ appId: String(FX.SELF_APP), getImpl: g.getImpl, download: g.download, now: () => new Date('2026-10-05T00:00:00Z') }); };
  const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const m = mount({ extra: { loadDevBase } });
  await ticks(12);
  const log0 = m.$('kt-ai-apply-log').innerHTML;
  assert(/運用環境との差：/.test(text(log0)) && /このページではまだ反映していません/.test(log0), 'L7: 読み込み直した直後も、記録に「運用環境との差」を出す');
  const b = (log0.match(/<button[^>]*data-act="open-base-diff"[^>]*>/) || [''])[0];
  assert(/title="運用環境との差を右の「詳細情報」に表示します"/.test(b), `L7: ［差分を見る］の説明は title 属性: ${b}`);
  // ヘッダーの作業の基準: 「HH:MM 取得・運用環境との差」と［差分を見る］［再取得］だけ（「今回の変更の基準」「revision」の語は出さない。詳しくは右の「詳細情報」）
  const header0 = m.$('kt-ai-header').innerHTML;
  assert(/反映先：\s*動作テスト環境\s*（運用環境は変更しません）｜\s*\d\d:\d\d 取得・運用環境との差なし/.test(text(header0)) && /data-act="open-base-diff"[^>]*>差分を見る</.test(header0) && /data-act="refresh-base"[^>]*>再取得</.test(header0) && !/今回の変更の基準|revision/.test(header0), `L7: ヘッダーの作業の基準は「取得の時刻・運用環境との差」と［差分を見る］［再取得］（技術語は出さない）: ${text(header0).slice(0, 120)}`);
  await clickPane(m, 'log', { dataset: { act: 'open-base-diff' } }); await ticks();
  assert(m.panel.drawerState().pane === 'evidence' && /今回の変更の基準（動作テスト環境）/.test(m.$('kt-ai-base-diff').innerHTML) && /revision/.test(m.$('kt-ai-base-diff').innerHTML), 'L7: 記録の［差分を見る］で右の「詳細情報」の差分へ（基準の詳しい内容はここ）');
  const before = (text(m.$('kt-ai-apply-log').innerHTML).match(/運用環境との差：\s*(\d+) 件/) || [])[1];
  await planOnScreen(m, GOAL);
  await m.$('kt-ai-review-result').dispatch({ type: 'change', target: { dataset: { step: 'P1' }, checked: false } });
  //   §0e.1: ［動作テスト環境へ反映］1 回。最初の書き込みで、取り直す動作テスト環境の設定に新しいフィールドが入る
  m.mock.ctl.onWrite = () => { changed = true; };
  await applyOnScreenM(m); await ticks(8);
  const after = (text(m.$('kt-ai-apply-log').innerHTML).match(/運用環境との差：\s*(\d+) 件/) || [])[1];
  const head = (text(m.$('kt-ai-header').innerHTML).match(/運用環境との差\s*(\d+) 件/) || [])[1];
  assert(before != null && after != null && Number(after) === Number(before) + 1 && after === head, `L7: 反映後の取り直しで、記録の件数もヘッダーと同じになる（${before} → ${after}・ヘッダー ${head}）`);
  // 作業の基準を取得できないときは、止めていることを書く（運用環境の設定では進めない）
  const failed = KTAiChatUi.baseHtml({ ok: false, message: '権限がありません' });
  assert(/動作テスト環境の設定を取得できませんでした（権限がありません）。変更案・コードの作成と反映は止めています（運用環境の設定では進めません）。/.test(failed) && /data-act="refresh-base"[^>]*>再取得</.test(failed), 'L7: 作業の基準を取得できないときは、変更案・コードの作成と反映を止めていることを書く（［再取得］）');
});
await section(async () => {
  // L7b（2026-10-16・利用者の報告: 再読み込みしても詳細情報が残る）: 運用環境との差の一覧（右の「詳細情報」の先頭）は、このページで［差分を見る］を押したときだけ出す。
  //   読み込んだ直後（再読み込みの後）・新しい会話の後は出さない（件数は見出しの「運用環境との差 N 件」）。押した後に取り直したら新しい内容に描き直す
  const { makeEnvGetter } = require('./helpers/dev-base-fake.js');
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const PROD = FX.makeData();
  let changed = true;
  const prevData = () => { const d = clone(PROD); if (changed) d.fields.progress = { type: 'DROP_DOWN', code: 'progress', label: '更新状況', noLabel: false, required: false, options: { '未着手': { label: '未着手', index: '0' } } }; return d; };
  const loadDevBase = async () => { const g = makeEnvGetter({ preview: prevData(), production: PROD, files: {} }); return T.KTDevBase.load({ appId: String(FX.SELF_APP), getImpl: g.getImpl, download: g.download, now: () => new Date('2026-10-05T00:00:00Z') }); };
  const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const m = mount({ extra: { loadDevBase } });
  await ticks(12);
  const diff = () => m.$('kt-ai-base-diff').innerHTML;
  m.panel.openDrawer('evidence'); await ticks();
  assert(diff() === '' && /運用環境との差 1 件/.test(text(m.$('kt-ai-header').innerHTML)) && m.panel.drawerState().pane === 'evidence', `L7b-1: 読み込んだ直後は、詳細情報のタブを開いても差の一覧を出さない（件数は見出し）: ${text(diff()).slice(0, 80)}`);
  await clickPane(m, 'log', { dataset: { act: 'open-base-diff' } }); await ticks();
  assert(/今回の変更の基準（動作テスト環境）/.test(diff()) && /更新状況/.test(diff()), 'L7b-2: ［差分を見る］で詳細情報に一覧を出す');
  changed = false;
  await m.$('kt-ai-header').dispatch({ type: 'click', target: { dataset: { act: 'refresh-base' } } }); await ticks(12);
  assert(/今回の変更の基準（動作テスト環境）/.test(diff()) && !/更新状況/.test(diff()) && /運用環境との差なし/.test(text(m.$('kt-ai-header').innerHTML)), `L7b-3: 押した後に取り直したら、新しい内容に描き直す: ${text(diff()).slice(0, 120)}`);
  m.panel.newConversation(); await ticks();
  assert(diff() === '', 'L7b-4: 新しい会話の後は、差の一覧を閉じる（［差分を見る］を押すまで出さない）');
  changed = true;
  const m2 = mount({ extra: { loadDevBase } });
  await ticks(12);
  m2.panel.openDrawer('evidence'); await ticks();
  assert(m2.$('kt-ai-base-diff').innerHTML === '' && /運用環境との差 1 件/.test(text(m2.$('kt-ai-header').innerHTML)), 'L7b-5: 読み込み直した後も、差が残っていれば見出しに件数を出し、詳細情報には［差分を見る］を押すまで出さない');
});
await section(async () => {
  // L8（low）・L9（low）: 同じ会話の前の計画の反映の注記・戻し済みの記録を開いただけで「戻しました」を出さない
  const m = mount();
  await ticks();
  await applyP1(m);
  await planOnScreen(m, '別件で、一覧を追加したい', { intent: 'PLAN' });   // C-1 第 3 段: 新しい依頼も仮案から
  assert(/前の計画（依頼: 更新状況を管理したい）の反映です。/.test(m.$('kt-ai-exec').innerHTML) && !/反映の記録から開いた/.test(m.$('kt-ai-exec').innerHTML), 'L8: 同じ会話の前の計画の反映は「前の計画の反映」と書く（記録から開いていない）');
  const m2 = mount();
  await ticks();
  await applyP1(m2);
  await clickPane(m2, 'exec', { id: 'kt-ai-exec-rollback-start' }); await ticks(8);
  await clickPane(m2, 'exec', { id: 'kt-ai-exec-rollback-go' }); await ticks(8);
  const logId = logItems(m2.$('kt-ai-apply-log').innerHTML)[0].id;
  await m2.$('kt-ai-new-conv').dispatch('click'); await ticks();
  await clickPane(m2, 'log', { dataset: { act: 'log-open', log: logId } }); await ticks();
  assert(m2.panel.executorState().stage === 'rolled-back' && !m2.msgs().some(x => x.data?.kind === 'apply-log-rolled-back'), 'L9: 戻し済みの反映を記録から開いただけでは「戻しました」を出さない');
});

// =========================================================
// 2026-10-05（応答性の第 2 段）: 回答の後は変わる箇所だけを作り直す・作り直しの途中の回答を受け付けてまとめて入れる（画面）
console.log('\n--- §23. 作り直しの途中の送信（画面）・計画の差分更新の依頼（Context） ---');
await section(async () => {
  const PLAN_Q = JSON.parse(JSON.stringify(PLAN_V1));
  PLAN_Q.plan.questions = [{ id: 'Q1', question: '更新状況の選択肢は 3 段階でよいですか', reason: 'goal から決められない', relatedEvidenceIds: [] }, { id: 'Q2', question: '通知はいつ送りますか？', reason: 'タイミング', relatedEvidenceIds: [], topic: 'timing', decisionRef: '' }];
  const PLAN_Q2 = JSON.parse(JSON.stringify(PLAN_Q)); PLAN_Q2.plan.questions = [];
  const HEALTH_P = JSON.parse(JSON.stringify(HEALTH)); HEALTH_P.registry.toolkit['change-planner'].revisionModes = ['full', 'patch'];
  const gates = [];
  const m = mount({ plans: (ctx) => (ctx.revision ? PLAN_Q2 : PLAN_Q), gatewayPlan: true, health: HEALTH_P, planGate: () => gates.shift() });
  await ticks();
  await planOnScreen(m, GOAL);
  let open1; gates.push(new Promise(r => { open1 = r; }));
  m.$('kt-ai-input').value = '保存時です';
  const p = m.$('kt-ai-send').dispatch('click'); await ticks(6);
  const conv = m.conv();
  assert(conv.isBusy() && conv.canQueue() && m.$('kt-ai-send').disabled === false && /^計画を作り直しています。質問にはすぐ答えます。追加の指示・回答もこのまま送れます/.test(m.$('kt-ai-composer-note').textContent), `U1: 計画の作り直しの途中は送信ボタンを止めない（回答・修正の依頼は送れる）: ${m.$('kt-ai-composer-note').textContent}`);
  const rev = m.calls.plan[1].ctx.revision;
  //   C-1 第 3 段: 待ち時間は最終案の進みの 1 枚カード（「最終案を直しています（経過）」。tests/ai-flow-redesign.test.js の C3b-2・C3b-4）。
  //   §0f.5 の 3（2026-10-09）: 残り時間は推定しない（「残り時間は未推定」。根拠の無い「目安 約 N 秒」は出さない）。
  //   以前の受領の表示・読み込み中の表示の「十数秒」の文は、最終案の流れでは会話に出さない（受領の表示は答えた後の 1 行だけ）
  assert(rev.mode === 'patch' && rev.focus.includes('Q2') && rev.previousPlan.goal === GOAL && !('validation' in (rev.previousPlan.steps[0] || {})) && /最終案を直しています（経過 \d+:\d+）/.test(m.chat()) && /残り時間は未推定/.test(m.chat()) && !/目安 約|十数秒|1 分前後/.test(m.chat()), `U2: 回答の後の作り直しは、Gateway の計画（正規化の付けた項目なし）を土台に mode patch で送る・待ち時間は進みのカードに経過と「残り時間は未推定」で出す: ${JSON.stringify({ mode: rev.mode, focus: rev.focus })}`);
  // 直している間: 右の見出しは「更新中」、右は前の内容である案内を出し、反映を止める
  assert(m.$('kt-ai-ws-state').innerHTML === '<span class="kt-ai-status" data-status="updating">更新中</span>' && m.$('kt-ai-right-banner').textContent === '変更案を直しています。できるまで、変更内容・確認結果・コードは前の内容です（反映はできません）。' && m.$('kt-ai-right-banner').style.display === '' && m.panel.applyHold() === '新しい内容の確認が終わるまで、反映はできません。', 'U1: 直している間は右の見出しが「更新中」・右は前の内容である案内・反映を止める');
  m.$('kt-ai-input').value = '3段階でよいです';
  await m.$('kt-ai-send').dispatch('click'); await ticks();
  const c3 = m.chat();
  assert(m.$('kt-ai-input').value === '' && m.calls.plan.length === 2 && /<div class="kt-ai-bubble">3段階でよいです<\/div>/.test(c3) && m.msgs().some(x => x.data?.kind === 'answers-ack' && x.data?.stage === 'queued') && !/回答を受け付けました|いま作り直している計画の後に/.test(c3) && /追加の指示は、できあがった最終案に入れます。/.test(c3), 'U3: 途中の回答は受け付けて入力欄を空にする（AI はまだ呼ばない）。受け付けの知らせは会話に出さず（conv.messages には残る）、進みのカードが「できあがった最終案に入れる」ことを示す（C-1 第 3 段: 確認事項のカードの「まだ入っていない」の表示はカードと一緒に無くなった。tests/ai-flow-redesign.test.js の R11-2）');
  m.$('kt-ai-input').value = 'このフィールドは何に使ってる？';
  await m.$('kt-ai-send').dispatch('click'); await ticks();
  // 2026-10-05 第 3 段で変更: 途中の質問は、作業と並べてすぐ答える（以前は送らず下書きとして残した）
  assert(m.$('kt-ai-input').value === '' && /このフィールドは何に使ってる？/.test(m.chat()) && !/作り直しの後に送ってください。下書きとして残しています/.test(m.$('kt-ai-composer-note').textContent), 'U4: 途中の質問は送って、作業と並べて答える（下書きにしない）');
  m.$('kt-ai-input').value = '';
  open1(); await p; await ticks(12);
  assert(m.calls.plan.length === 3 && /3段階でよいです/.test(m.calls.plan[2].ctx.revision.request) && conv.activePlan().version === 2 && conv.planHistory().length === 2 && !conv.isBusy(), `U5: 作り直しが終わったら続けて入れ、版は v2 だけ: calls=${m.calls.plan.length} v=${conv.activePlan().version}`);
  assert(conv.ledger().filter(e => e.status === 'answered').every(e => e.appliedInVersion === 2) && m.$('kt-ai-send').disabled === false, 'U5: 2 つの回答が v2 に入った');
  assert(m.msgs().filter(x => x.data?.kind === 'answers-ack').every(x => x.data.stage === 'done') && !/受け付けました/.test(m.chat()) && (m.msgs().some(x => x.data?.kind === 'answers-ack' && !x.data.queued && Array.isArray(x.data.records)) ? /変更案に入れました。/.test(m.chat()) : !/変更案に入れました/.test(m.chat())) && m.$('kt-ai-right-banner').style.display === 'none' && /data-status="ready">未反映</.test(m.$('kt-ai-ws-state').innerHTML) && m.panel.applyHold() === null, 'U5: 入れ終わったら案内を消し、右の見出しは「未反映」・反映できる（受け付けの知らせは出さない。回答を送った直後の知らせだけ「変更案に入れました。」）');
});

// =========================================================
// 2026-10-06（利用者の指示）: 必要な確認が終わった内容だけを反映できる（反映を止める理由 applyHold）
console.log('\n--- §24. 反映を止める理由: 先に確認したいこと（blocking）・直している間・設定の手順の無い変更案 ---');
await section(async () => {
  // B1: 先に確認したいこと（priority: blocking）が残っている間は反映を止める。priority 無し・later では止めない
  const withQ = (priority) => { const p = JSON.parse(JSON.stringify(PLAN_V1)); p.plan.questions = [{ id: 'Q1', question: '更新状況の選択肢は 3 段階でよいですか', reason: 'goal から決められない', relatedEvidenceIds: [], ...(priority ? { priority } : {}) }]; return p; };
  const m = mount({ plans: () => withQ('blocking') });
  await ticks();
  await planOnScreen(m, GOAL);
  const hold = m.panel.applyHold();
  const exec = m.$('kt-ai-exec').innerHTML;
  //   簡素化（2026-10-17）: 止める理由は今の判定の 1 か所（会話の finalReadiness の理由）。左の最終案のカードと右の「反映」で同じ文
  assert(hold === '先に決めたいことが 1 件残っています。答えると反映できるようになります。' && !/id="kt-ai-exec-start"/.test(exec) && exec.includes(hold) && m.chat().includes(hold) && KF.applyButtonOf(m) && KF.applyButtonOf(m).disabled, `B1: 先に確認したいこと（blocking）が残っている間は［動作テスト環境へ反映］を押せず、理由を出す（右の「反映」にも理由）: ${hold}`);
  //   C-1 第 3 段: 変更案のカード・確認事項のカードは最終案のカードに置き換えた（tests/ai-flow-redesign.test.js の R10-1・R10-2）。
  //   最終案のカードが「残る判断」と回答欄を出し、承認できない理由（先に決めたいこと）を示す
  const vB = m.conv().activePlan();
  assert(/残る判断（1 件）/.test(m.chat()) && /先に決めたいこと/.test(m.chat()) && /class="kt-ai-qa-input" data-qkey="/.test(m.chat()) && vB.final && FS.readyOf(vB) === false && /先に決めたいことが 1 件/.test(FS.reasonOf(vB)) && /data-act="final-approve"[^>]*disabled/.test(m.chat()), `B1: 最終案のカードでも、先に答えることを案内する（承認のボタンは押せない）: ${vB.final && FS.reasonOf(vB)}`);
  const rB1 = await KF.applyOnScreen(m);
  assert(!vB.approval && !rB1.run && m.panel.executorState().stage === 'idle' && writes(m).length === 0, 'B1: 止めている間は［動作テスト環境へ反映］を押しても、承認・反映の準備・書き込みをしない');
  for (const pr of [null, 'later']) {
    const m2 = mount({ plans: () => withQ(pr) });
    await ticks();
    await planOnScreen(m2, GOAL);
    await KF.waitUntil(() => m2.panel.finalPrecheck().status === 'ready', 60);
    const b2 = KF.applyButtonOf(m2);
    assert(m2.panel.applyHold() === null && b2 && !b2.disabled && m2.panel.finalPrecheck().status === 'ready', `B1: 確認事項の priority が ${pr || '無し'} なら反映は止めない（承認の欄の準備が終わり、［動作テスト環境へ反映］を押せる）`);
  }
});
await section(async () => {
  // B2: 直している間（REVISE）は、［動作テスト環境へ反映］を押しても反映しない。直し終わったら前の版の最終案は反映しない
  //   簡素化（2026-10-17）: 承認だけを記録して準備・書き込みの部品を呼ぶ口は削除した。押したときの止めで確かめる
  const gate = { p: null };
  const m = mount({ planGate: async (ctx) => { if (ctx.revision && gate.p) await gate.p; } });
  await ticks();
  await planOnScreen(m, GOAL);
  await KF.waitUntil(() => m.panel.finalPrecheck().status === 'ready', 60);
  const v1 = m.conv().activePlan();
  assert(KF.applyButtonOf(m) && !KF.applyButtonOf(m).disabled, '前提: 承認の欄の準備が終わり、［動作テスト環境へ反映］が押せる');
  let open; gate.p = new Promise(res => { open = res; });
  const revising = m.panel.send('更新状況フィールドはいらない', { intent: 'REVISE_PLAN' }); await ticks(6);
  const hold = m.panel.applyHold();
  await clickChat(m, 'final-approve', { plan: v1.planId, version: String(v1.version) }); await ticks(4);
  assert(hold === '新しい内容の確認が終わるまで、反映はできません。' && !v1.approval && !m.panel.finalRun() && m.panel.executorState().stage === 'idle' && writes(m).length === 0, `B2: 直している間は押しても承認・反映しない（書き込まない）・止める理由は「新しい内容の確認が終わるまで、反映はできません。」: ${hold}`);
  open(); await revising; await ticks(8);
  const rB = await m.panel.applyFinal(v1.planId, v1.version); await ticks(4);
  assert(m.panel.applyHold() === null && m.conv().activePlan().version === 2 && rB === null && !v1.approval && m.panel.executorState().stage === 'idle' && writes(m).length === 0, 'B2: 直し終わったら止める理由は無くなる（前の版の最終案は反映しない）');
});
await section(async () => {
  // B3: 次の変更案を作っている間（反映は止めている）でも、反映した変更を元に戻す操作は止めない
  const gate = { p: null };
  let planCalls = 0;
  const m = mount({ planGate: async () => { if (++planCalls > 1 && gate.p) await gate.p; } });
  await ticks();
  await applyP1(m);
  assert(m.panel.executorState().stage === 'done' && m.mock.st.fields.progress, '前提: 変更案を反映した');
  let open; gate.p = new Promise(res => { open = res; });
  //   C-1 第 3 段: 次の依頼は仮案から。採用（「これで進めて」）の後の計画の作成を止めておく
  await m.panel.send('別件で、一覧を追加したい', { intent: 'PLAN' }); await ticks(8);
  const working = m.panel.send('これで進めて'); await ticks(6);
  const hold = m.panel.applyHold();
  const rbStatus = (await m.panel.startRollback())?.status;
  await m.panel.confirmRollback(); await ticks(4);
  assert(hold === '新しい内容の確認が終わるまで、反映はできません。' && rbStatus === 'PREPARED' && m.panel.executorState().stage === 'rolled-back' && !m.mock.st.fields.progress, `B3: 次の変更案を作っている間（反映は止めている）でも、元に戻す確認と元に戻す操作はできる: ${hold} / ${m.panel.executorState().stage}`);
  open(); await working; await ticks(8);
});
await section(async () => {
  // B4: 設定の手順が無い変更案（JavaScript だけ）は［動作テスト環境へ反映］を出さず、短い案内だけ
  const PLAN_JS = JSON.parse(JSON.stringify(PLAN_HYBRID));
  PLAN_JS.plan.solution = 'CUSTOMIZATION';
  PLAN_JS.plan.steps = [JS_STEP()];
  const m = mount({ plans: () => PLAN_JS });
  await ticks();
  await planOnScreen(m, GOAL_HYBRID);
  const exec = m.$('kt-ai-exec').innerHTML;
  assert(!/id="kt-ai-exec-start"/.test(exec) && /この変更案に、設定の変更はありません。JavaScript は最終案のカードの［動作テスト環境へ反映］から登録します。/.test(exec), `B4: 設定の手順が無い変更案は［動作テスト環境へ反映］を出さず、JavaScript の登録の場所を案内する: ${exec.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 120)}`);
});

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
