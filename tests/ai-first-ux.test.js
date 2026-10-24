// AI-first UX Refactoring（Phase 18）: Templates タブ廃止・Documents / AI Context の AI タブ統合・Customize の Snippets 廃止・
// Pattern Library（Gateway）の表示・implementation（JAVASCRIPT / CSS / JS_CSS）・AI → Customize 導線・移行案内
//
// 検証内容:
//   §36 Templates Removal: tab 不存在 / tab count / AI tab 正常 / Customize 正常 / 旧 Templates への参照なし / dead mount なし
//   §37 Feature Migration: AI Prompt / Markdown / JSON（Context ペイン）・Documents（ドキュメントを作る・DOCUMENT intent・カード）・
//        CSS / Snippet 資産（Toolkit には無い → Gateway の Pattern Library。応答の generated.patterns を表示・Audit）
//   §38 Pattern 表示 / implementation / standard-first（Toolkit 側）
//   §33 Migration Notice / §30 AI → Customize
//
// 実行方法: node tests/ai-first-ux.test.js
'use strict';
//   2026-10-09: 実行が 10 秒を越えると、sandbox に読み込んだ本体の起動処理（waitReady の 10 秒の待ちの後の kintone.app.getId()）が
//   「kintone is not defined」（テストが kintone を置いた後は kintone.app が無い TypeError）で落ちてテストが途中で止まる（テストの内容と関係ない）。
//   ほかのテストと同じく、その起動処理の例外だけを無視する
process.on('unhandledRejection', (e) => { if (/kintone is not defined|reading 'getId'/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const fs = require('fs');
const path = require('path');
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { withDevBase } = require('./helpers/dev-base-fake.js');
const { gwCandidateHash, gwHashOfCtx, withGwHash, gwWithBody } = require('./helpers/gw-hash.js');
const { makeFakeHost, makeFakeDocument } = require('./helpers/fake-dom.js');
const T = loadToolkit();
const { KTDeps, KTScan, KTContext, KTContextUi, KTAiClient, KTAiConversation, KTAiChatUi, KTPlanReview, KTJsExecutor, mountAiWorkspace, renderCustomize } = T;
const { assert, state } = makeAssert();
// C-1 第 3 段（2026-10-08）: 古い確認の流れ（仕様の確定 confirmSpec・「コードを作って」の従来の生成）を前提にしていた試験は、
//   共有の部品（tests/helpers/new-flow.js）の台本で新しい流れ（仮案 → 採用 → 計画 → 生成工程 → 最終案 → 承認）の上に移した
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const FX = require('./fixtures/ai-context-app.js');
const { buildScanPayload } = require('./helpers/scan-payload.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const SRC_TEXT = fs.readFileSync(path.join(__dirname, '..', 'kintoneAppToolkit.user.js'), 'utf8');

// ---- fixtures（ai-customization.test.js と同じ形。既存 JS fieldOnOff.js ＋ Hybrid の計画） ----
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
const GOAL_HYBRID = '100万円以上なら部長承認にして、承認後は金額を編集できなくしたい';
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], customizationId: null, ...o });
const mkStep = (id, actionType, targetKind, targetRef, sp, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' }, ...extra });
const META = { requestId: 'pl-h1', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm' }, usage: { usedThisMonth: 1, monthlyLimit: 20 } };
const cust = (o = {}) => ({ customizationId: 'C1', requirement: '承認後（完了）は金額を編集できなくする', whyStandardInsufficient: 'フィールドのアクセス権はステータスで切り替えられない', strategy: 'EXTEND_EXISTING_JS', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL', effects: ['lock'] }], apis: [], existingFiles: [{ name: 'fieldOnOff.js', target: 'desktop', reason: '同じフィールド（金額）を制御している' }], risks: [], questions: [], dependsOn: [], evidenceIds: [], ...o });
const STD_STEP = () => mkStep('P1', 'ADD_VIEW', 'VIEW', '承認済み', { name: '承認済み', fields: ['case_name', 'amount', 'approver'], filterCond: 'ステータス in ("完了")', sort: 'due_date asc' }, { title: '一覧「承認済み」を追加', solution: 'STANDARD' });
const JS_STEP = (cid = 'C1', extra = {}) => mkStep('P2', 'CUSTOMIZATION_REQUIRED', 'JS', 'fieldOnOff.js', { customizationId: cid }, { title: '承認後は金額を編集できなくする（JavaScript）', solution: 'CUSTOMIZATION', ...extra });
const planOf = ({ steps, customizations = [], solution = null, goal = GOAL_HYBRID, questions = [], requestId = 'pl-h1' }) => ({ ok: true, contractVersion: '2.1', meta: { ...META, requestId }, plan: { goal, ...(solution ? { solution } : {}), assessment: { summary: '承認フローは標準のプロセス管理、承認後のロックは JavaScript が必要です。', usableExistingFields: [], usableExistingSettings: [], missingCapabilities: [], uncertainties: [] }, relevantFields: [], proposedFields: [], steps, customizations, alternatives: [], impact: [], questions, unknowns: [], planConfidence: 'INFERRED' } });
const PLAN_HYBRID = planOf({ steps: [STD_STEP(), JS_STEP()], customizations: [cust()], solution: 'HYBRID' });
const hash = (t) => KTScan.hashText(t);
const PATCH_GOOD = { baseHash: hash(FIELD_ON_OFF), operations: [{ type: 'INSERT_AFTER', anchor: "      record['amount'].disabled = true;\n    }", content: "    if (record['ステータス'] && record['ステータス'].value === '完了') {\n      record['amount'].disabled = true;\n    }" }] };
const PATTERNS = [{ id: 'field-disable', purpose: '条件に応じてフィールドの編集可否を制御する', implementation: 'JAVASCRIPT', preferredStandardAlternatives: ['フィールドのアクセス権', 'プロセス管理の「作業者だけ編集可」'], matched: { triggers: ['編集(不可|でき|させ|制限|ロック)'], events: ['app.record.edit.show'], fieldAccess: ['CONTROL'], apis: [] }, score: 7 }];
// §0c.6（2026-10-08）: 従来の流れの登録は、接続先が必須の効果の確認に対応し（health の verification に requiredEffects）、生成工程の検証が合格したものだけ。
//   この試験は登録の経路（upload・PUT・検証・戻す）を確かめるので、偽の生成工程は Toolkit が渡した必須の効果をそのまま「処理あり・動作テストで合格」で返す
//   （効果の区別そのものの検証は tests/ai-flow-redesign.test.js の §D）
//   簡素化 B（2026-10-17）・2026-10-18: 本物の Gateway と同じく、検証結果に書き込む本文の指紋（bodyHash。Gateway と同じ計算。tests/helpers/gw-hash.js）を入れる
const passVerification = (ctx, g = null) => { const re = (ctx && ctx.verification && ctx.verification.requiredEffects) || []; return re.length ? { version: '1', ...(g ? { bodyHash: gwHashOfCtx(ctx, g) } : {}), passed: true, machine: [], requiredEffects: re.map(x => ({ requirementId: x.requirementId, requirementIds: x.requirementIds, field: x.field, effect: x.effect, status: 'present' })), behavior: { status: 'passed', reason: null, cases: re.flatMap((x, i) => (x.events && x.events.length ? x.events : [null]).flatMap((ev, j) => (x.condition ? ['match', 'nomatch'] : ['match']).map(side => ({ id: `K${i + 1}-${j + 1}-${side}`, requirementIds: x.requirementIds, field: x.field, effect: x.effect, expect: side === 'match' ? x.effect : ({ lock: 'not-locked', warn: 'not-warned', 'block-save': 'save-allowed', 'set-value': 'value-unchanged', 'show-hide': 'show-hide' })[x.effect], side, ...(ev ? { event: ev } : {}), verdict: 'pass', observed: {}, message: '期待どおり' })))) }, repairs: { count: 0, reasons: [], stoppedBy: null }, unverified: ['実際の画面での動作'] } : undefined; };
const genResponse = (ctx, g) => ({ ok: true, contractVersion: '2.1', meta: { requestId: 'gen-1', usage: { usedThisMonth: 3, monthlyLimit: 20 }, normalization: { warnings: [] }, gateway: { feature: 'customization-generator' }, patternLibrary: { version: '1', selected: ['field-disable'] } }, generated: { strategy: ctx.customization.strategy, targetFile: ctx.existingFile?.name || 'amountWarning.js', summary: ctx.customization.requirement, events: ctx.customization.events, fields: ctx.customization.fields, apis: [], assumptions: [], warnings: [], gatewayChecks: { security: [] }, patterns: PATTERNS, ...g }, ...(passVerification(ctx, g) ? { verification: passVerification(ctx, g) } : {}) });
//   2026-10-18（AI版 契約 20 §20）: 統合の書き込む本文は生成工程が合成して返す（偽の生成工程は送られた既存の本文と patch から作る）
const genPatch = (patch = PATCH_GOOD, src = FIELD_ON_OFF) => gwWithBody({ strategy: 'EXTEND_EXISTING_JS', targetFile: 'fieldOnOff.js', summary: '完了でも金額を編集不可にする', code: patch.operations.map(o => o.content).join('\n'), patch, events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [] }, src);
const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'], conversation: ['requirements', 'brief', 'stream', 'proposal', 'suggestion', 'adoptQuote', 'itemIds'] }, 'change-planner': { implemented: true, promptVersions: ['1'], revisionModes: ['full', 'patch'], stream: ['reply'], requirementOps: ['decisionRefs'] }, 'customization-generator': { implemented: true, promptVersions: ['1'], stream: ['progress'], verification: ['requirementId', 'requiredEffects', 'effectGroups', 'relatedOmitted', 'appFields', 'saveDialog', 'reasonCategory', 'caseSide', 'eventCases', 'loadFaithful', 'registrationCheck', 'emptyCase', 'hideCondition', 'registrationCounts', 'caseCoverage', 'cancelCheck', 'limitCode', 'scopeList', 'tableRowChange', 'caseInvalid', 'rowButtons', 'conditionFrom', 'effectCheck', 'networkCheck', 'verifiedBody', 'registrationSelect'] } } }, usage: { monthlyLimit: 20, usedThisMonth: 1 } };
const makeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const answerFor = (ctx, text) => ({ ok: true, contractVersion: '2.1', meta: { requestId: 'qa-1', usage: { usedThisMonth: 2, monthlyLimit: 20 }, normalization: { warnings: [] } }, answer: text, facts: [], analysis: [], recommendations: [], unknowns: [] });
const tick = () => new Promise(r => setTimeout(r, 0));
const ticks = async (n = 4) => { for (let i = 0; i < n; i++) await tick(); };
function mount({ inputs = INPUTS, paid = true, planResponse = PLAN_HYBRID, openCustomize = undefined } = {}) {
  const storage = makeStorage();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' });
  settings.setConsent(true);
  const calls = { ask: [], plan: [], generate: [], health: 0 };
  const client = {
    async getHealth() { calls.health++; return HEALTH; },
    async ask({ ctx, requestId, signal }) { calls.ask.push({ ctx }); return { ...KTAiClient.receive('answer', answerFor(ctx, 'このフィールドは金額です。')), requestId, clientWarnings: [] }; },
    //   仮案は共有の部品の台本で答える（計画は PLAN_HYBRID・生成は fieldOnOff.js の patch と生成工程の合格）
    async propose({ ctx, requestId }) { calls.propose = (calls.propose || 0) + 1; const raw = K.script({ utterance: ctx.question, previous: ctx.conversation.proposal, requirements: ctx.conversation.requirements }); if (!raw) throw new Error(`台本がありません: ${ctx.question}`); return K.normalized(raw, requestId, null, ctx.conversation); },
    async plan({ ctx, requestId }) { calls.plan.push({ ctx }); return { ...KTAiClient.receive('plan', K.rawWithPlannerMapping(planResponse, ctx)), requestId, clientWarnings: [] }; },
    async generate({ ctx, requestId }) { calls.generate.push({ ctx }); return { ...KTAiClient.receive('generated', genResponse(ctx, genPatch({ ...PATCH_GOOD, baseHash: ctx.existingFile?.hash || PATCH_GOOD.baseHash }, ctx.existingFile ? ctx.existingFile.source : FIELD_ON_OFF))), requestId, clientWarnings: [] }; },
  };
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner,customization-generator', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const flow = { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false };
  const host = makeFakeHost();
  const copies = [], downloads = [], opened = [];
  const mock = makeKintoneMock(inputs.data, { jsSources: [{ name: 'fieldOnOff.js', target: 'desktop', text: FIELD_ON_OFF }] });
  const panel = mountAiWorkspace(host, withDevBase(T, {
    getInputs: () => inputs, copyText: async (t) => { copies.push(t); return true; }, downloadText: (name, text) => downloads.push({ name, text }), colors: { border: '#ccc', bg: '#fff' },
    ...(paid ? { settings, session, hostname: 't.cybozu.com', connectFlow: flow } : {}),
    executor: { api: mock.api, appId: '310' },
    openCustomize: openCustomize === undefined ? (x) => { opened.push(x); return { found: true }; } : openCustomize,
  }));
  const $ = (id) => host.querySelector(`#${id}`);
  return { host, panel, $, calls, copies, downloads, opened, mock, conv: () => panel.conversation(), chat: () => $('kt-ai-chat').innerHTML, msgs: () => panel.conversation().state.messages, types: () => panel.conversation().state.messages.map(m => m.type) };
}
const clickChat = (m, act, extra = {}) => m.$('kt-ai-chat').dispatch({ type: 'click', target: { dataset: { act, ...extra } } });
/** 新しい流れ: 台本の 4 発言で仮案 → 採用 → 最終案（JavaScript は生成工程で検証済み）まで進める */
const adoptFinal = async (m) => { const v = await K.adoptOnScreen(m); return v; };
/** §0e.1（2026-10-09）: 最終案のカードの［動作テスト環境へ反映］を 1 回押す（承認の欄の準備を待ってから。承認と登録を 1 回で行う） */
const applyFinal = (m) => K.applyOnScreen(m);
const writes = (m) => m.mock.calls.filter(c => !c.startsWith('GET'));

/** Customize タブの mount 用: Monaco とドキュメントの最小スタブ */
function fakeMonacoWindow(sandboxDoc) {
  const editor = { value: '', setValue(v) { this.value = v; }, getValue() { return this.value; }, getModel() { return {}; }, focus() { }, getSelection() { return null; } };
  const monaco = { editor: { create: () => editor, setModelLanguage: () => { } }, languages: { registerCompletionItemProvider: () => { monaco._completions = (monaco._completions || 0) + 1; }, CompletionItemKind: { Field: 1, Snippet: 2 } }, Range: function () { } };
  return { editor, monaco };
}

(async () => {
// =========================================================
console.log('\n--- §36. Templates Removal: タブ構成 / 参照なし / dead mount なし ---');
{
  const { doc, byId } = makeFakeDocument();
  const T2 = loadToolkit({ document: doc });
  const wrap = T2.mountRoot();
  const TABS = wrap.ktTabs.TABS;
  assert(!TABS.includes('templates') && !byId.has('tab-templates') && !byId.has('view-templates') && !wrap.innerHTML.includes('>Templates</button>'), 'Templates タブ（ボタン / view / TABS）が無い');
  assert(TABS.length === 12 && TABS.join(',') === 'health,fields,views,graphs,relations,deps,notice,acl,customize,field-scanner,plugins,ai', `tab count 12・順序（Fact の解析タブ → Customize → Field Scanner → Plugins → AI）: ${TABS.join(',')}`);
  assert(TABS.every(id => byId.has(`tab-${id}`) && byId.has(`view-${id}`)), '全タブにボタンと view がある（dead なタブ無し）');
  const tabAi = byId.get('tab-ai'), viewAi = byId.get('view-ai');
  await tabAi.dispatch('click');
  assert(viewAi.style.display === 'block' && tabAi.classList.contains('active'), 'AI タブ正常（切り替え）');
  await byId.get('tab-customize').dispatch('click');
  assert(byId.get('view-customize').style.display === 'block' && viewAi.style.display === 'none' && byId.get('view-customize').classList.contains('kt-fill-view'), 'Customize タブ正常（切り替え・高さ追従）');
  // 旧 Templates への参照（コード）が無い
  const refs = ['renderTemplates', 'kt-template-', '#view-templates', 'tab-templates', 'kintone-Customize-template', 'api.github.com', 'KINTONE_TEMPLATE', 'buildRequirementsPromptFromEditor', 'async function initEditor', 'monacoEditorResizeCleanup', 'kt_tpl_cache', 'loadSnippets', 'kt-customize-insert', 'Snippet Overview'];
  const found = refs.filter(r => SRC_TEXT.includes(r));
  assert(found.length === 0, `旧 Templates / GitHub Snippets への参照がソースに無い${found.length ? `（残: ${found.join(', ')}）` : ''}`);
  assert(!/async function uploadOnce\(/.test(SRC_TEXT), 'Templates だけが使っていた uploadOnce ラッパは無い（Customize は KTApi.uploadFile）');
  assert(/function buildDocPayloadLiteFromPrefetch\(/.test(SRC_TEXT) && /buildDocPayloadLiteFromPrefetch\(\{ \.\.\.\(data/.test(SRC_TEXT), 'Documents 由来の Common Context Model（buildDocPayloadLiteFromPrefetch）は KTContext が使うので残す');
  assert(/function registerFieldCompletions\(/.test(SRC_TEXT) && /registerFieldCompletions\(monaco, DATA\?\.fields\)/.test(SRC_TEXT), 'フィールド補完（registerFieldCompletions）は Customize のエディタへ移動');
  assert(!/renderTemplates\(root/.test(SRC_TEXT) && /renderCustomize\(root, DATA, appId, \{/.test(SRC_TEXT) && /root\.ktCustomize = c/.test(SRC_TEXT), 'boot: renderTemplates の mount 無し・renderCustomize の戻り（show）を root.ktCustomize に保持');
}

// =========================================================
console.log('\n--- §36b. Customize 正常（Snippets 無し・［AIに相談］・show()） ---');
{
  const { doc, byId } = makeFakeDocument();
  const { monaco } = fakeMonacoWindow(doc);
  const T2 = loadToolkit({ document: doc });
  // renderCustomize は root.querySelector('#view-customize') と loadMonaco（window.loadMonaco）を使う
  const wrap = T2.mountRoot();
  const g = T2.__sandbox;   // vm の global（window）。Customize は window.loadMonaco / kintone.api / fetch を使う
  g.loadMonaco = async () => monaco;
  const data = INPUTS.data;
  let consulted = null;
  const api = makeKintoneMock(data, { jsSources: [{ name: 'fieldOnOff.js', target: 'desktop', text: FIELD_ON_OFF }] }).api;
  // KTApi は kintone.api を直接呼ぶので、mock のカスタマイズ設定を kintone.api に見せる（preview / production とも同じ内容）
  const kapi = async (url, method, body) => { if (/app\/customize\.json/.test(url) && method === 'GET') return api.getPreviewCustomize(body); throw new Error(`unexpected ${method} ${url}`); };
  kapi.url = (p) => p;
  g.kintone = { api: kapi, getRequestToken: () => 'tok' };
  g.fetch = async () => ({ ok: true, status: 200, text: async () => FIELD_ON_OFF });
  const c = await T2.renderCustomize(wrap, data, '310', { consult: (seed) => { consulted = seed; return { ok: true }; }, getInputs: () => INPUTS });
  const sel = byId.get('kt-customize-source');
  const selHtml = (/<select id="kt-customize-source"[\s\S]*?<\/select>/.exec(byId.get('view-customize').innerHTML) || [''])[0];
  assert(sel && [...selHtml.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]).join(',') === 'JavaScript,css,JavaScriptMobile,cssMobile', 'Customize の一覧の種類は JavaScript / CSS × PC / モバイルだけ（GitHub Snippets は無い）');
  assert(!byId.has('kt-customize-insert') && byId.has('kt-customize-refresh') && byId.has('kt-customize-env'), '［挿入］ボタンは無い。一覧更新と環境差分の表示はある');
  assert(c && typeof c.show === 'function' && typeof c.refresh === 'function', 'renderCustomize は { show, refresh } を返す（AI → Customize 導線用）');
  assert(doc.head.children.some(el => el.id === 'kt-customize-inline-style' && /\.btn \{/.test(el.textContent)), 'ダイアログ用の .btn 共通 style は Customize が 1 回だけ付ける（旧 Templates から移管）');
  assert(monaco._completions === 1, 'フィールド補完は Customize のエディタに 1 回登録');
  const list = byId.get('kt-customize-list');
  const rows = list.children;
  assert(rows.length >= 1 && rows.some(r => /fieldOnOff\.js/.test(r.innerHTML)) && rows.every(r => r.children.some(b => b.className.includes('kt-customize-consult'))), 'JS 一覧: 登録済みファイル（fieldOnOff.js）の行に［AIに相談］');
  const r = await c.show({ target: 'desktop', kind: 'js', name: 'fieldOnOff.js' });
  assert(r && r.found === true && r.src === 'JavaScript' && /AI タブから: fieldOnOff\.js（PC）/.test(byId.get('kt-customize-meta').textContent), 'show({ desktop, js, fieldOnOff.js }): 一覧を切り替えて該当行を示す（書き込みなし）');
  const r2 = await c.show({ target: 'mobile', kind: 'js', name: 'nope.js' });
  assert(r2.found === false && sel.value === 'JavaScriptMobile' && /現在の一覧にありません/.test(byId.get('kt-customize-meta').textContent), 'show: 無いファイルは found false（モバイルの一覧に切り替わる）');
  // ［AIに相談］→ consult（seed）
  const consultBtn = rows.find(r => /fieldOnOff\.js/.test(r.innerHTML)).children.find(b => b.className.includes('kt-customize-consult'));
  await consultBtn.dispatch('click', { stopPropagation() { }, preventDefault() { } });
  assert(consulted && consulted.name === 'fieldOnOff.js' && consulted.platform === 'desktop' && consulted.source?.available === true, '［AIに相談］→ JsConsultationSeed（本文あり）を AI へ');
}

// =========================================================
console.log('\n--- §33. Migration Notice（初回だけ・閉じると保存） ---');
{
  const { doc, byId } = makeFakeDocument();
  const store = makeStorage();
  const T2 = loadToolkit({ document: doc, localStorage: store });
  const wrap = T2.mountRoot();
  const n = byId.get('kt-migration-notice');
  assert(n && n.classList.contains('is-shown') && /Templates タブの機能は/.test(wrap.innerHTML) && /<b>開発支援<\/b>/.test(wrap.innerHTML) && /<b>Customize<\/b>/.test(wrap.innerHTML), '初回: 案内（Templates の機能は 開発支援 / Customize へ移動）が表示される');
  assert(/#kt-toolkit\.is-mini #kt-migration-notice\{ display:none !important; \}/.test(wrap.innerHTML), '最小化中は案内も隠れる（CSS）');
  await byId.get('kt-migration-close').dispatch('click');
  assert(!n.classList.contains('is-shown') && store.getItem('ktTemplatesMovedNotice.v1') === '1', '× で閉じる → 非表示・localStorage に保存');
  const { doc: doc2, byId: byId2 } = makeFakeDocument();
  const T3 = loadToolkit({ document: doc2, localStorage: store });
  T3.mountRoot();
  assert(!byId2.get('kt-migration-notice').classList.contains('is-shown'), '2 回目以降: 表示しない（永続バナーにしない）');
}

// =========================================================
console.log('\n--- §37. Feature Migration: AI Prompt / Markdown / JSON / Documents（Context ペイン・無料） ---');
{
  const f = mount({ paid: false });
  await ticks();
  const html = f.host.innerHTML;
  for (const id of ['kt-ai-copy-prompt', 'kt-ai-copy-md', 'kt-ai-copy-json', 'kt-ai-mode-qa', 'kt-ai-mode-plan', 'kt-ai-mode-doc', 'kt-ai-doc-kind', 'kt-ai-download']) assert(html.includes(`id="${id}"`), `Context ペインに ${id}`);
  const kinds = [...((/<select id="kt-ai-doc-kind"[\s\S]*?<\/select>/.exec(html) || [''])[0]).matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
  assert(kinds.join(',') === 'spec,requirements,review-request,changes,handover,plain,improvement', `ドキュメントの種類 7 件: ${kinds.join(',')}`);
  // 2026-10-06（利用者の指示）: 未接続の案内は短く（接続の状況と接続の操作だけ。ほかの体験へ誘わない）。無料の資料づくりは右の「Context」（接続機能の無い環境では出す）
  assert(!/無料で利用できます|AI用Promptを生成/.test(f.$('kt-ai-free').innerHTML) && f.$('kt-ai-free').innerHTML.length < 600, '未接続の案内は短い（無料機能の一覧・ほかの体験への誘いを出さない）');
  // 無料（未接続）でもドキュメントを作れる
  f.panel.setMode('doc', { kind: 'spec' });
  f.$('kt-ai-generate').dispatch('click');
  await ticks();
  assert(f.$('kt-ai-generate').textContent === 'ドキュメント Prompt を生成' && f.$('kt-ai-doc-inputs').style.display === 'flex' && f.$('kt-ai-qa-inputs').style.display === 'none', 'ドキュメントモード: 入力欄とボタン名');
  const out = f.panel.currentOutput();
  assert(out && /あなたは kintone の設計者です/.test(out.text) && /## 出力の構成/.test(out.text) && /1\. 基本情報/.test(out.text) && /## Context/.test(out.text) && /AI Context/.test(out.text), 'アプリ仕様書の Prompt: 役割・規則・構成（旧 documents の見出し）＋ Context（Toolkit の解析結果）');
  assert(out.filename === 'ai-document_spec_app310_prompt.md', `保存ファイル名: ${out.filename}`);
  f.$('kt-ai-view').value = 'markdown'; f.$('kt-ai-view').dispatch('change');
  assert(/# アプリ仕様書（現状整理）（ドラフトの骨格）/.test(f.panel.currentOutput().text) && /## フィールド構成/.test(f.panel.currentOutput().text) && /— AI Context/.test(f.panel.currentOutput().text), 'Markdown: 構成の骨格 ＋ Context');
  f.$('kt-ai-view').value = 'json'; f.$('kt-ai-view').dispatch('change');
  assert(JSON.parse(f.panel.currentOutput().text).contextVersion === '1', 'JSON: Context');
  assert(f.calls.ask.length === 0 && f.calls.plan.length === 0, 'ドキュメントの生成で AI（Gateway）は呼ばない');
  // 種類を変えると作り直す / changes は計画が無いと作れない
  f.$('kt-ai-doc-kind').value = 'changes'; f.$('kt-ai-doc-kind').dispatch('change');
  await ticks();
  assert(/まとめる変更計画がありません/.test(f.$('kt-ai-status').textContent), '「変更内容のまとめ」は計画が無いと作れない（案内）');
  for (const k of ['requirements', 'review-request', 'handover', 'plain', 'improvement']) {
    const g = KTContextUi.generateDocument({ kind: k, inputs: INPUTS });
    const kd = KTContextUi.documentKind(k);
    assert(g.ok && g.kind === k && g.outputs.prompt.includes(kd.role) && kd.outline.every(o => g.outputs.prompt.includes(o)) && g.outputs.prompt.includes('## Context') && g.outputs.markdown.includes(`# ${kd.label}`), `generateDocument(${k}): 役割・構成・Context`);
  }
  assert(KTContextUi.generateDocument({ kind: 'spec', inputs: null }).ok === false, 'データが無ければ no-data');
}

// =========================================================
console.log('\n--- §37b. DOCUMENT intent（チャット）: LLM を使わずカード・コピー・「Context」タブで開く ---');
{
  const I = KTAiConversation.INTENT;
  const cls = (t, st = {}) => KTAiConversation.classifyIntent(t, st);
  const v1 = { planId: 'p1', version: 1, status: 'ACTIVE', plan: PLAN_HYBRID.plan, review: { steps: [] } };
  assert(cls('このアプリの仕様書を作って').intent === I.DOCUMENT && cls('このアプリの仕様書を作って').documentKind === 'spec', '「このアプリの仕様書を作って」→ DOCUMENT(spec)');
  assert(cls('引継ぎ資料を作って').documentKind === 'handover' && cls('要件定義書のドラフトを出して').documentKind === 'requirements' && cls('開発のレビュー依頼を書いて').documentKind === 'review-request' && cls('改善提案をまとめて').documentKind === 'improvement', '種類の判定: 引継ぎ / 要件定義 / レビュー依頼 / 改善提案');
  assert(cls('非エンジニア向けに説明して').intent === I.DOCUMENT && cls('非エンジニア向けに説明して').documentKind === 'plain' && cls('現場の人にもわかるように説明して').documentKind === 'plain', '「非エンジニア向けに説明して」→ DOCUMENT(plain)');
  assert(cls('この改修内容をまとめて', { activePlan: v1 }).documentKind === 'changes' && cls('変更内容を Markdown にして', { activePlan: v1 }).documentKind === 'changes', '計画があるとき「改修内容をまとめて」→ changes');
  assert(cls('この改修内容をまとめて').documentKind === 'spec', '計画が無いとき「改修内容をまとめて」→ spec に落とす');
  assert(cls('この計画を説明して', { activePlan: v1 }).intent === I.EXPLAIN_PLAN && cls('コードを作って', { activePlan: { ...v1, spec: { status: 'CONFIRMED', version: 1 } } }).intent === I.GENERATE_CODE && cls('このフィールドは何に使ってる？').intent === I.ASK && cls('100万円以上なら部長承認を追加したい').intent === I.PLAN, 'DOCUMENT は文書の名詞 ＋ 依頼の語だけ（計画の説明 / コード生成 / 質問 / 計画は従来どおり）');
  assert(KTContextUi.detectDocumentKind('仕様書') === null && KTContextUi.detectDocumentKind('資料はどこ？') === null, '名詞だけ・質問は DOCUMENT ではない');
  // チャット
  const m = mount();
  await ticks();
  const r = await m.panel.send('このアプリの仕様書を作って');
  assert(r && r.ok && r.intent === I.DOCUMENT && m.calls.ask.length === 0 && m.calls.plan.length === 0 && m.calls.generate.length === 0, 'チャットの DOCUMENT: Gateway を呼ばない（無料）');
  const dm = m.msgs().find(x => x.type === 'DOCUMENT');
  assert(dm && dm.data.kind === 'spec' && dm.data.outputs.prompt.includes('## Context') && /kt-ai-document-card/.test(m.chat()) && /無料・AI 送信なし/.test(m.chat()) && /data-act="copy-doc"/.test(m.chat()) && /data-act="open-doc-context"/.test(m.chat()), 'DOCUMENT カード: 種類・Prompt / Markdown / JSON のコピー・「Context」タブで開く');
  await clickChat(m, 'copy-doc', { mid: dm.id, key: 'prompt' });
  assert(m.copies.length === 1 && m.copies[0] === dm.data.outputs.prompt, '［Prompt をコピー］');
  await clickChat(m, 'copy-doc', { mid: dm.id, key: 'markdown' });
  assert(m.copies.length === 2 && m.copies[1] === dm.data.outputs.markdown, '［Markdown をコピー］');
  assert(m.panel.mode() === 'doc' && m.$('kt-ai-doc-kind').value === 'spec' && m.panel.currentOutput()?.text === dm.data.outputs.prompt, 'Context ペインも同じ結果（モード doc・種類 spec・保存できる）');
  await clickChat(m, 'open-doc-context', { kind: 'handover' });
  assert(m.panel.drawerState().pane === 'context' && m.$('kt-ai-doc-kind').value === 'handover' && /引継ぎ資料/.test(m.panel.currentOutput().text), '［「Context」タブで開く］: ペインを開き、その種類で作り直す');
  // 計画 → 変更内容のまとめ（Toolkit の記録）。C-1 第 3 段: 最終案（JavaScript は生成工程で検証済み）まで新しい流れで進める
  await adoptFinal(m);
  const r2 = await m.panel.send('この改修内容をまとめて');
  const dm2 = m.msgs().filter(x => x.type === 'DOCUMENT').pop();
  assert(r2.ok && dm2.data.kind === 'changes' && /# 変更内容のまとめ — 計画 v1/.test(dm2.data.outputs.markdown) && /\| P1 \| 一覧「承認済み」を追加 \| ADD_VIEW \| 標準設定 \|/.test(dm2.data.outputs.markdown) && /\*\*C1\*\* 承認後（完了）は金額を編集できなくする（既存 fieldOnOff\.js を変更・PC・JavaScript）/.test(dm2.data.outputs.markdown) && /生成コード: fieldOnOff\.js（Toolkit のコードの検査: OK・参考パターン field-disable）/.test(dm2.data.outputs.markdown) && /運用環境には反映していません/.test(dm2.data.outputs.markdown), '「この改修内容をまとめて」: 計画 v1 の手順表・JS カスタマイズ・生成コード（Code Review・参考パターン）・運用環境は未反映');
  assert(/## 変更計画（Toolkit の記録）/.test(dm2.data.outputs.prompt) && /改修記録を書くエンジニア/.test(dm2.data.outputs.prompt) && JSON.parse(dm2.data.outputs.json).plan.goal === GOAL_HYBRID, 'changes の Prompt は記録 ＋ Context、JSON は計画（compact）＋ Context');
  assert(writes(m).length === 0, 'ドキュメントで kintone への書き込みは 0 件');
}

// =========================================================
console.log('\n--- §38. Pattern Library（AI サービスの generated.patterns）: 表示 / Audit / Standard-first の再確認 ---');
{
  const m = mount();
  await ticks();
  //   C-1 第 3 段: コードは最終案のパイプラインが生成工程に 1 回頼む（「コードを作って」の従来の生成は削除）
  const vP = await adoptFinal(m);
  assert(vP && vP.final && m.calls.generate.length === 1, `コード生成（AI サービスが patterns を返す）: ${m.calls.generate.length}`);
  const entry = m.panel.generated('C1');
  assert(entry && Array.isArray(entry.generated.patterns) && entry.generated.patterns[0].id === 'field-disable' && entry.generated.patterns[0].preferredStandardAlternatives.length === 2 && !('implementationNotes' in entry.generated.patterns[0]), 'validateGenerated: patterns（id / purpose / implementation / preferredStandardAlternatives）を通す。知識本体は無い');
  //   右の「コード」に出す操作（act open-code）で開く。C-1 第 3 段（2026-10-08）: open-code のボタンを出していたコードのカードは削除し、
  //   最終案のカードに［コードを見る］（act open-code）を置いた。最終案の後に右の「コード」を開く入口があることを確かめてから、表示の中身を確かめる
  assert(/data-act="open-code"/.test(m.chat()), '最終案の後に、生成したコードを右の「コード」で開く入口（［コードを見る］）がある');
  await clickChat(m, 'open-code', { cid: 'C1', view: 'code' }); await ticks();
  const codePane = m.$('kt-ai-code-review').innerHTML;
  assert(/参考にした実装パターン: <span class="kt-ai-pattern" title="条件に応じてフィールドの編集可否を制御する">field-disable<\/span>/.test(codePane) && /標準設定で代替できないか再確認: フィールドのアクセス権 \/ プロセス管理の「作業者だけ編集可」/.test(codePane) && !/参考パターン/.test(m.chat()), '右「コード」: 参考パターンと「標準設定で代替できないか再確認」（人間への standard-first の再確認）。会話には出さない（Phase 19）');
  //   C-1 第 3 段（2026-10-08）: 会話のコードのカード（type CODE）は削除した。参考パターンの行は右の「コード」の部品（patternsHtml）だけが作る
  assert(KTAiChatUi.patternsHtml({ ...genPatch(), patterns: [] }) === '' && /参考にした実装パターン/.test(KTAiChatUi.patternsHtml(entry.generated)) && KTAiConversation.MSG.CODE === undefined, 'patterns が空なら参考パターンの行は出ない（右の「コード」の部品）');
  // Audit に patterns
  const audit = KTJsExecutor.buildAudit({ generated: [{ customizationId: 'C1', generated: entry.generated, review: entry.review, existingSource: entry.existingSource }] });
  assert(audit.generated[0].patterns.length === 1 && audit.generated[0].patterns[0] === 'field-disable', 'Customization Audit の generated に patterns（id だけ）');
  assert(!SRC_TEXT.includes('implementationNotes:') && !SRC_TEXT.includes('pitfalls:'), 'Toolkit（公開 MIT）には Pattern の知識本体（implementationNotes / pitfalls）を持たない（Gateway 側）');
}

// =========================================================
console.log('\n--- §38b. implementation（JAVASCRIPT / CSS / JS_CSS）: 受け取り・Review・表示 ---');
{
  const gen = KTContextUi.generatePlan({ goal: GOAL_HYBRID, inputs: INPUTS });
  //   2026-10-23（§12.61）: implementation の既定（省略・語彙外 → JAVASCRIPT）は Gateway の validate-plan だけが行う。Toolkit の受け取りは形をそのまま返す
  const vc = KTAiClient.receive('plan', planOf({ steps: [STD_STEP(), JS_STEP()], customizations: [cust({ implementation: 'CSS', events: [], fields: [] })], solution: 'HYBRID' }));
  assert(vc.customizations[0].implementation === 'CSS', 'CSS はそのまま（語彙外の既定は Gateway）');
  const reviewOf = (c) => { const p = { ...KTAiClient.receive('plan', planOf({ steps: [STD_STEP(), JS_STEP()], customizations: [c], solution: 'HYBRID' })), requestId: 'x' }; const rv = KTPlanReview.review({ plan: p, ...INPUTS }); return { plan: p, review: rv, js: (rv.steps || []).find(r => r.solution === 'CUSTOMIZATION') }; };
  const css = reviewOf(cust({ implementation: 'CSS', events: [], fields: [], strategy: 'NEW_JS_FILE', existingFiles: [] }));
  assert(css.js.codeGeneration.supported === false && css.js.codeGeneration.reason === 'CSS_NOT_GENERATED' && css.js.customization.implementation === 'CSS' && css.js.issues.some(i => i.code === 'JS_CSS_ONLY') && !css.js.issues.some(i => i.code === 'JS_EVENT_MISSING') && css.js.status !== 'INVALID', 'implementation CSS: 生成不可（CSS_NOT_GENERATED）・イベント無しでも要確認にしない・計画には残る');
  const jscss = reviewOf(cust({ implementation: 'JS_CSS' }));
  assert(jscss.js.codeGeneration.supported === true && jscss.js.customization.implementation === 'JS_CSS' && jscss.js.issues.some(i => i.code === 'JS_CSS_PART_MANUAL' && i.severity === 'low'), 'implementation JS_CSS: JavaScript 部分は生成可（CSS は手動の注記）');
  const plain = reviewOf(cust({ implementation: 'JAVASCRIPT' }));
  assert(plain.js.codeGeneration.supported === true && plain.js.customization.implementation === 'JAVASCRIPT' && !plain.js.issues.some(i => /^JS_CSS/.test(i.code)), 'implementation JAVASCRIPT: 従来どおり（AI サービスの既定を受け取った形）');
  //   2026-10-19: 実装仕様のカード（実装の行）は廃止した。CSS で生成しないことは右の「変更内容」の「反映できないこと」に理由と一緒に出す
  const sumCss = KTAiChatUi.changeSummaryHtml({ planId: 'p', version: 1, status: 'ACTIVE', goal: GOAL_HYBRID, plan: css.plan, review: css.review });
  assert(/Toolkit ではコードを作れません（CSS は生成の対象外）/.test(sumCss), `変更内容: 実装 CSS は「反映できないこと」に作れない理由（CSS は生成の対象外）: ${sumCss.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300)}`);
  const sumJs = KTAiChatUi.changeSummaryHtml({ planId: 'p', version: 1, status: 'ACTIVE', goal: GOAL_HYBRID, plan: plain.plan, review: plain.review });
  assert(/何が変わるか/.test(sumJs) && !/CSS は生成の対象外/.test(sumJs), 'JAVASCRIPT のときは変更内容に CSS の理由を出さない（既定）');
}

// =========================================================
console.log('\n--- §30. AI → Customize（結果カード / コードペインの「Customize タブで確認」） ---');
{
  const m = mount();
  await ticks();
  await adoptFinal(m);
  const ar = await applyFinal(m);
  assert(ar.button && !ar.button.disabled && ar.v.approval && ar.pre.items.files.length === 1, '［動作テスト環境へ反映］1 回で承認と登録（承認の欄に登録するファイル）');
  const jx = m.panel.jsExecState();
  assert(jx.stage === 'done' && jx.execution.status === 'DONE', `登録 → DONE（${jx.stage} / ${jx.execution?.status}）`);
  assert(/data-act="open-customize" data-target="desktop" data-name="fieldOnOff\.js"/.test(ar.cardHtml) && /Customize タブで確認/.test(ar.cardHtml), '反映の結果のカードに［Customize タブで確認］（登録したファイルの platform と名前）');
  assert(/id="kt-ai-jsreg-open-customize"/.test(m.$('kt-ai-jsreg').innerHTML), 'コードペインの結果にも［Customize タブで確認］');
  await clickChat(m, 'open-customize', { target: 'desktop', name: 'fieldOnOff.js' });
  assert(m.opened.length === 1 && m.opened[0].target === 'desktop' && m.opened[0].kind === 'js' && m.opened[0].name === 'fieldOnOff.js', 'クリック → openCustomize({ desktop, js, fieldOnOff.js })（タブ切替と一覧の表示は boot 側）');
  await m.$('kt-ai-pane-code').dispatch({ type: 'click', target: { id: 'kt-ai-jsreg-open-customize' } });
  assert(m.opened.length === 2 && m.opened[1].name === 'fieldOnOff.js', 'コードペインの［Customize タブで確認］も同じ');
  const m2 = mount({ openCustomize: null });
  await ticks();
  await adoptFinal(m2); await applyFinal(m2);
  await clickChat(m2, 'open-customize', { target: 'desktop', name: 'fieldOnOff.js' });
  assert(m2.panel.jsExecState().stage === 'done', 'openCustomize が無い環境ではクリックしても何も起きない（エラーにしない）');
}

// =========================================================
console.log('\n--- U7（Phase 20 実機）. 会話・「変更前の状態に戻す」はこのページの中だけ: 戻していない間は離れる前に確認し、カードで知らせる ---');
{
  const m = mount();
  await ticks();
  await adoptFinal(m);
  await K.waitUntil(() => m.panel.finalPrecheck().status === 'ready', 60);
  assert(typeof m.panel.unrevertedPreviewChange === 'function' && m.panel.unrevertedPreviewChange() === false, '登録前は確認しない（承認の欄の準備は読み取りだけ）');
  await applyFinal(m);
  assert(m.panel.jsExecState().stage === 'done' && m.panel.unrevertedPreviewChange() === true, '登録して戻していない間は、ページを離れる前に確認する（ページを離れると戻す手段が消える）');
  assert(/このページを離れる/.test(m.chat()) && /変更を中止/.test(m.chat()), 'JS 登録カード: このページを離れると会話と「変更前の状態に戻す」が使えない・その後は kintone の［変更を中止］');
  //   §0e.1: 標準設定と JavaScript を 1 回で反映したので、戻すのも結果のカードから JavaScript → 設定の順（JavaScript を戻すまで設定の［戻す］は出さない）
  const fa = () => { const h = m.chat(); const i = h.lastIndexOf('kt-ai-final-apply-card'); return i >= 0 ? h.slice(i) : ''; };
  const jsId = m.panel.jsExecState().execution.executionId, exId = m.panel.executorState().execution.executionId;
  assert(/data-act="js-rollback"/.test(fa()) && !/data-act="rollback"/.test(fa()) && /JavaScript を先に戻してから設定を戻します/.test(fa()), '結果のカード: 戻すときは JavaScript を先に（設定の［戻す］はまだ出さない）');
  await clickChat(m, 'js-rollback', { execution: jsId }); await ticks(6);
  await m.$('kt-ai-pane-exec').dispatch({ type: 'click', target: { id: 'kt-ai-jsreg-rollback-go' } }); await ticks(8);
  assert(/rolled-back/.test(m.panel.jsExecState().stage) && m.panel.unrevertedPreviewChange() === true && /data-act="rollback"/.test(fa()) && /登録前の状態に戻し済み/.test(fa()), `JavaScript を戻した後も、設定が残る間は確認を続ける（結果のカードに設定の［戻す］が出る）（${m.panel.jsExecState().stage}）`);
  await clickChat(m, 'rollback', { execution: exId }); await ticks(6);
  await m.$('kt-ai-pane-exec').dispatch({ type: 'click', target: { id: 'kt-ai-exec-rollback-go' } }); await ticks(8);
  assert(m.panel.executorState().stage === 'rolled-back' && m.panel.unrevertedPreviewChange() === false, `設定も戻した後は確認しない（${m.panel.executorState().stage}）`);
}

// =========================================================
console.log('\n--- §35. AI-first の開発思想（UI の文言: 標準設定 / JavaScript を先に選ばせない） ---');
{
  const m = mount();
  await ticks();
  assert(/このアプリについて、相談したいことや変更したいことを入力してください/.test(m.host.innerHTML) && !/会話の方式|例の発言/.test(m.host.innerHTML), 'composer: 「このアプリについて、相談したいことや変更したいことを入力してください」（手段・会話の方式を選ばせない）');
  assert(/このアプリについて、相談したいことや変更したいことを入力してください/.test(m.chat()) && !/<button/.test(m.chat()), '空の会話: 相談・変更したいことを入力する案内だけ（例文のボタンなし）');
  assert(!/<option value="snippets">/.test(SRC_TEXT) && !/CSS templates|Css  \(GitHub/.test(SRC_TEXT), 'ユーザーが CSS テンプレート / Snippet を選ぶ UI は無い');
  assert(/function detectDocumentKind\(/.test(SRC_TEXT) && /DOCUMENT_KINDS/.test(SRC_TEXT), 'Documents は AI タブの DOCUMENT（種類の判定は決定的）');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
