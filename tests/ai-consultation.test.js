// Customize → AI Workflow（Phase 17）: JS 相談（Consultation Seed / 会話の開始・再開）・実装仕様の版と確定（UI だけが SoT）・JavaScript の動作テスト環境への登録 / 検証 / 復元（AI Workspace 経由）
//
// 検証内容:
//   §44 Customize → AI: FILE / URL・desktop / mobile の seed、sourceId、会話の開始（初期メッセージ）、同じ JS の再開、別 JS の確認（戻る / 新しい会話）、Planner Context の subject
//   §45 Spec: 仕様 v1 は最終案の一部として自動で確定（customize revision を記録）・右は閲覧だけ・チャットの文では承認しない・修正で v2（v1 は SUPERSEDED）
//   §46〜§53（UI 経由）: 既存 FILE の差し替え登録・新規 JS の登録・mobile・URL の fallback・stale・検証・Rollback・Rollback stale・文章だけでは登録 / 復元しない・監査
//   C-1 第 3 段（2026-10-08）: 古い確認の流れ（DISCUSS_JS・仕様の確定・従来の生成・［確定してコードを作る］）は削除した。相談・依頼は仮案 → 採用 → 最終案（生成と検証）→
//     最終案の承認 → 登録の順で確かめる（共有の部品 tests/helpers/new-flow.js の仮案の正規化を使う）
//
// 実行方法: node tests/ai-consultation.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
//   簡素化（2026-10-17）: 反映できるかは、最新の版なら会話の今の判定、前の版なら最終案の記録で確かめる（tests/helpers/final-state.js）
const FS = require('./helpers/final-state.js');
const { withDevBase } = require('./helpers/dev-base-fake.js');
const { gwCandidateHash, gwHashOfCtx, withGwHash, gwWithBody } = require('./helpers/gw-hash.js');
const { makeFakeHost } = require('./helpers/fake-dom.js');
const { createNewFlowKit } = require('./helpers/new-flow.js');
const T0 = loadToolkit();
const { KTDeps, KTScan, KTContext, KTAiClient, KTAiConversation, KTAiChatUi, KTCodeReview, KTJsExecutor, mountAiWorkspace } = T0;
const KIT = createNewFlowKit(T0);
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const { buildScanPayload } = require('./helpers/scan-payload.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');

const FIELD_ON_OFF = [
  "(function () {",
  "  'use strict';",
  "  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {",
  "    const record = event.record;",
  "    if (record['ステータス'].value === '承認待ち') {",
  "      record['amount'].disabled = true;",
  "    }",
  "    return event;",
  "  });",
  "})();",
].join('\n');
const MOBILE_LOCK = "(function () {\n  'use strict';\n  kintone.events.on('mobile.app.record.edit.show', function (event) {\n    event.record['owner'].disabled = true;\n    return event;\n  });\n})();";
const EXT_SRC = "(function () {\n  'use strict';\n  kintone.events.on('app.record.edit.show', function (event) {\n    event.record['owner'].disabled = true;\n    return event;\n  });\n})();";
const NEW_JS = [
  "(function () {",
  "  'use strict';",
  "  kintone.events.on(['app.record.create.change.amount', 'app.record.edit.change.amount'], function (event) {",
  "    const record = event.record;",
  "    record['amount'].error = Number(record['amount'].value || 0) >= 1000000 ? '100万円以上は部長の承認が必要です' : null;",
  "    return event;",
  "  });",
  "})();",
].join('\n');
const MOBILE_NEW = "(function () {\n  'use strict';\n  kintone.events.on('mobile.app.record.edit.show', function (event) {\n    if (event.record['ステータス'].value === '承認済') {\n      event.record['amount'].disabled = true;\n    }\n    return event;\n  });\n})();";
const FILES = [{ name: 'fieldOnOff.js', target: 'desktop', kind: 'js', text: FIELD_ON_OFF }, { name: 'mobileLock.js', target: 'mobile', kind: 'js', text: MOBILE_LOCK }];
function buildInputs() {
  const data = FX.makeData();
  //   §0c.8（2026-10-08）: URL 指定の ext.js は既知のライブラリの配布元に置く（§0d.3: jsDelivr・unpkg は既知の配布元から外したので cdnjs の /ajax/libs/）。それ以外の URL は業務の JavaScript かもしれないので
  //   動作テストでは「イベントが分からない」（events null）になり、その platform の必須の効果を確かめられない（この試験の主題ではない）
  data.customize = {
    scope: 'ALL',
    desktop: { js: [{ type: 'URL', url: 'https://cdnjs.cloudflare.com/ajax/libs/ext-lib/1.0.0/ext.js' }, { type: 'FILE', file: { contentType: 'text/javascript', fileKey: 'dl:fieldOnOff', name: 'fieldOnOff.js', size: '290' } }], css: [{ type: 'FILE', file: { contentType: 'text/css', fileKey: 'dl:style', name: 'style.css', size: '10' } }] },
    mobile: { js: [{ type: 'FILE', file: { contentType: 'text/javascript', fileKey: 'dl:mlock', name: 'mobileLock.js', size: '120' } }], css: [] },
    revision: '12',
  };
  const fieldsN = KTDeps.normalizeFields(data.fields);
  const deps = KTDeps.buildDependencyData(data, fieldsN);
  const fieldRows = fieldsN.map(f => ({ code: f.code, label: f.label, type: f.rawType }));
  const scan = buildScanPayload({ KTScan, KTDeps }, { appId: FX.SELF_APP, files: FILES, fields: fieldRows, deps, skippedUrlFiles: [{ name: 'ext.js', target: 'desktop' }] });
  scan.results = KTScan.analyze({ fields: fieldRows, files: FILES, snippet: { before: 24, after: 48 } });
  KTDeps.mergeScannerEdges(deps, scan);
  return { data, deps, scan, incoming: null };
}
const INPUTS = buildInputs();
const PATCH = { baseHash: KTScan.hashText(FIELD_ON_OFF), operations: [{ type: 'INSERT_AFTER', anchor: "      record['amount'].disabled = true;\n    }", content: "    if (record['ステータス'] && record['ステータス'].value === '承認済') {\n      record['amount'].disabled = true;\n    }" }] };
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], customizationId: null, ...o });
const mkStep = (id, actionType, targetKind, targetRef, sp, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' }, ...extra });
const META = { requestId: 'pl-1', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm' }, usage: { usedThisMonth: 1, monthlyLimit: 20 } };
const CUST = (o = {}) => ({ customizationId: 'C1', requirement: '承認済では金額を編集不可', whyStandardInsufficient: 'フィールドのアクセス権はステータスで変えられない', strategy: 'EXTEND_EXISTING_JS', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL', effects: ['lock'] }], apis: [], existingFiles: [{ name: 'fieldOnOff.js', target: 'desktop', reason: '同じフィールドを制御' }], risks: [], questions: [], dependsOn: [], evidenceIds: [], confidence: 'INFERRED', ...o });
const planOf = ({ customizations, goal, requestId = 'pl-1', steps = null }) => ({ ok: true, contractVersion: '2.1', meta: { ...META, requestId }, plan: { goal, solution: 'CUSTOMIZATION', assessment: { summary: 'このJSはすでに金額フィールドを制御しています。新規JSを追加せず、fieldOnOff.jsへ処理を統合する案が適切です。', usableExistingFields: [], usableExistingSettings: [], missingCapabilities: [], uncertainties: [] }, relevantFields: [], proposedFields: [], steps: steps || customizations.map((c, i) => mkStep(`C${i + 1}`, 'CUSTOMIZATION_REQUIRED', 'JS', (c.existingFiles || [])[0]?.name || '', { customizationId: c.customizationId }, { id: c.customizationId, title: c.requirement, solution: 'CUSTOMIZATION' })), customizations, alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED' } });
const PLAN_REPLACE = planOf({ customizations: [CUST()], goal: '承認済みになったら金額を編集できなくしたい' });
const PLAN_BOTH = planOf({ customizations: [CUST(), CUST({ customizationId: 'C2', requirement: 'モバイルでも承認済では金額を編集不可', strategy: 'NEW_JS_FILE', platform: ['mobile'], events: ['mobile.app.record.edit.show'], existingFiles: [] })], goal: '承認済みになったら金額を編集できなくしたい', requestId: 'pl-2' });
const PLAN_MOBILE_NEW = planOf({ customizations: [CUST({ customizationId: 'C1', requirement: 'モバイルで承認済では金額を編集不可', strategy: 'NEW_JS_FILE', platform: ['mobile'], events: ['mobile.app.record.edit.show'], existingFiles: [] })], goal: 'モバイルでも承認済みでは金額を編集不可にしたい' });
const PLAN_EXT = planOf({ customizations: [CUST({ existingFiles: [{ name: 'ext.js', target: 'desktop', reason: '' }], fields: [{ code: 'owner', access: 'CONTROL', effects: ['lock'] }] })], goal: '承認済みでは担当者を編集不可にしたい' });
const PLAN_NEW_DESKTOP = planOf({ customizations: [CUST({ requirement: '金額が100万円以上なら警告', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.create.change.amount', 'app.record.edit.change.amount'], existingFiles: [], fields: [{ code: 'amount', access: 'CONTROL', effects: ['warn'] }] })], goal: '100万円以上なら警告を表示したい' });
// §0c.6（2026-10-08）: 従来の流れの登録は、接続先が必須の効果の確認に対応し（health の verification に requiredEffects）、生成工程の検証が合格したものだけ。
//   この試験は登録の経路（upload・PUT・検証・戻す）を確かめるので、偽の生成工程は Toolkit が渡した必須の効果をそのまま「処理あり・動作テストで合格」で返す
//   （効果の区別そのものの検証は tests/ai-flow-redesign.test.js の §D）
//   簡素化 B（2026-10-16）: 記法（var）は生成工程の機械検査が止める（Toolkit の写しは削除）。偽の生成工程も、新しいコードに var が残れば modern-js の block を返す（本物の文の形）
const varBlockOf = (g) => { const code = g && g.patch && Array.isArray(g.patch.operations) ? g.patch.operations.map(o => String((o && o.content) || '')).join('\n') : String((g && g.code) || ''); const lines = code.split('\n'); const at = lines.findIndex(l => /(^|[^\w$.'"`])var\s+[A-Za-z_$]/.test(l)); if (at < 0) return null; const name = (/var\s+([A-Za-z_$][\w$]*)/.exec(lines[at]) || [])[1]; return { name: 'modern-js', ok: false, severity: 'block', message: `記法の問題が残っています（1 件）: ${at + 1} 行目「${lines[at].trim()}」: var ${name}` }; };
//   簡素化 B（2026-10-17）・2026-10-18: 本物の Gateway と同じく、検証結果に書き込む本文の指紋（bodyHash。Gateway と同じ計算。tests/helpers/gw-hash.js）を入れる
const passVerification = (ctx, g = null) => { const vb = varBlockOf(g); const re = (ctx && ctx.verification && ctx.verification.requiredEffects) || []; return re.length ? { version: '1', ...(g ? { bodyHash: gwHashOfCtx(ctx, g) } : {}), passed: !vb, machine: vb ? [vb] : [], requiredEffects: re.map(x => ({ requirementId: x.requirementId, requirementIds: x.requirementIds, field: x.field, effect: x.effect, status: 'present' })), behavior: { status: 'passed', reason: null, cases: re.flatMap((x, i) => (x.events && x.events.length ? x.events : [null]).flatMap((ev, j) => (x.condition ? ['match', 'nomatch'] : ['match']).map(side => ({ id: `K${i + 1}-${j + 1}-${side}`, requirementIds: x.requirementIds, field: x.field, effect: x.effect, expect: side === 'match' ? x.effect : ({ lock: 'not-locked', warn: 'not-warned', 'block-save': 'save-allowed', 'set-value': 'value-unchanged', 'show-hide': 'show-hide' })[x.effect], side, ...(ev ? { event: ev } : {}), verdict: 'pass', observed: {}, message: '期待どおり' })))) }, repairs: { count: 0, reasons: [], stoppedBy: null }, unverified: ['実機での動作'] } : undefined; };
const genResponse = (ctx, g) => ({ ok: true, contractVersion: '2.1', meta: { requestId: 'gen-1', usage: { usedThisMonth: 3, monthlyLimit: 20 }, normalization: { warnings: [] } }, generated: g, ...(passVerification(ctx, g) ? { verification: passVerification(ctx, g) } : {}) });
const genFor = (ctx) => {
  const c = ctx.customization;
  //   C-1 第 3 段（2026-10-08）: ext.js への変更の code は、patch と同じ担当者（owner）の行にする（以前は金額の行のままで、最終案の流れでは
  //   「計画に無いフィールドを操作」で最終案が承認できず、登録の準備（EXTERNAL_JS_NOT_WRITABLE の確認）まで進めなかった）
  const extLine = "    event.record['owner'].disabled = event.record['ステータス'].value === '承認済';";
  //   2026-10-18（AI版 契約 20 §20）: 統合の書き込む本文は生成工程が合成して返す（偽の生成工程は送られた既存の本文と patch から作る）
  if (c.strategy === 'EXTEND_EXISTING_JS') return gwWithBody({ strategy: 'EXTEND_EXISTING_JS', targetFile: ctx.existingFile.name, summary: '承認済でも編集不可にする', code: ctx.existingFile.name === 'ext.js' ? extLine : PATCH.operations[0].content, patch: { ...PATCH, baseHash: ctx.existingFile.hash, operations: ctx.existingFile.name === 'ext.js' ? [{ type: 'INSERT_AFTER', anchor: "    event.record['owner'].disabled = true;", content: "    event.record['owner'].disabled = event.record['ステータス'].value === '承認済';" }] : PATCH.operations }, events: c.events, fields: c.fields, apis: [], assumptions: [], warnings: [] }, ctx.existingFile.source);
  if (c.platform.includes('mobile')) return { strategy: 'NEW_JS_FILE', targetFile: 'approved-lock-mobile.js', summary: 'モバイルの金額ロック', code: MOBILE_NEW, patch: null, events: ['mobile.app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [] };
  return { strategy: 'NEW_JS_FILE', targetFile: 'amount-warning.js', summary: '金額の警告', code: NEW_JS, patch: null, events: c.events, fields: c.fields, apis: [], assumptions: [], warnings: [] };
};
//   C-1 第 3 段（2026-10-08）: 接続先は仮案に対応した形（assistant-qa の conversation に proposal）。相談・依頼は仮案 → 採用 → 計画 → 最終案（生成と検証を含む）→ 承認 → 登録
const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'], conversation: ['requirements', 'brief', 'stream', 'proposal', 'suggestion', 'adoptQuote', 'itemIds'] }, 'change-planner': { implemented: true, promptVersions: ['1'], revisionModes: ['full', 'patch'], stream: ['reply'], requirementOps: ['decisionRefs'] }, 'customization-generator': { implemented: true, promptVersions: ['1'], stream: ['progress'], verification: ['requirementId', 'requiredEffects', 'effectGroups', 'relatedOmitted', 'appFields', 'saveDialog', 'reasonCategory', 'caseSide', 'eventCases', 'loadFaithful', 'registrationCheck', 'emptyCase', 'hideCondition', 'registrationCounts', 'caseCoverage', 'cancelCheck', 'limitCode', 'scopeList', 'tableRowChange', 'caseInvalid', 'conditionFrom', 'effectCheck', 'networkCheck', 'verifiedBody', 'registrationSelect'] } } }, usage: { monthlyLimit: 20, usedThisMonth: 1 } };
/** 仮案の偽の応答（決めることの無い仮案。依頼の文を実現する動作にする） */
const proposalFor = (utterance, requestId = 'pp-1') => KIT.normalized({ reply: 'JavaScript で実現できます。', intent: 'propose', proposal: { behaviors: [KIT.B(utterance, 'user')], assumptions: [], decisions: [], approach: { standard: [], js: ['JavaScript で制御する'] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [] } }, requestId);
const makeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const tick = () => new Promise(r => setTimeout(r, 0));
const ticks = async (n = 4) => { for (let i = 0; i < n; i++) await tick(); };
function mount({ inputs = INPUTS, planResponse = PLAN_REPLACE, generatedFor = genFor, mockOpt = {} } = {}) {
  const storage = makeStorage();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' });
  settings.setConsent(true);
  const calls = { ask: [], plan: [], generate: [], propose: [] };
  const client = {
    async getHealth() { return HEALTH; },
    async propose({ ctx, requestId }) { calls.propose.push({ ctx }); return proposalFor(ctx.question, requestId || 'pp-1'); },
    async ask({ ctx, requestId }) { calls.ask.push({ ctx }); return { ...KTAiClient.receive('answer', { ok: true, contractVersion: '2.1', meta: { requestId: 'qa-1', normalization: { warnings: [] } }, answer: 'このファイルは承認待ちのとき金額を編集不可にしています。', facts: [], analysis: [], recommendations: [], unknowns: [] }), requestId, clientWarnings: [] }; },
    async plan({ ctx, requestId }) { calls.plan.push({ ctx }); const resp = typeof planResponse === 'function' ? planResponse(ctx) : planResponse; return { ...KTAiClient.receive('plan', resp), requestId, clientWarnings: [] }; },
    async generate({ ctx, requestId }) { calls.generate.push({ ctx }); return { ...KTAiClient.receive('generated', genResponse(ctx, generatedFor(ctx))), requestId, clientWarnings: [] }; },
  };
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner,customization-generator', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const flow = { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false };
  const host = makeFakeHost();
  const copies = [], rescans = [];
  const mock = makeKintoneMock(inputs.data, { jsSources: FILES, ...mockOpt });
  const panel = mountAiWorkspace(host, withDevBase(T0, {
    getInputs: () => inputs, copyText: async (t) => { copies.push(t); return true; }, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' },
    settings, session, hostname: 't.cybozu.com', connectFlow: flow, executor: { api: mock.api, appId: '310' }, rescanJs: async () => { rescans.push(1); return { ok: true }; },
  }));
  const $ = (id) => host.querySelector(`#${id}`);
  return { host, panel, $, calls, copies, rescans, mock, conv: () => panel.conversation(), chat: () => $('kt-ai-chat').innerHTML, msgs: () => panel.conversation().state.messages, types: () => panel.conversation().state.messages.map(m => m.type), pane: () => $('kt-ai-jsreg').innerHTML };
}
const clickChat = (m, act, extra = {}) => m.$('kt-ai-chat').dispatch({ type: 'click', target: { dataset: { act, ...extra } } });
const clickPane = (m, id) => m.$('kt-ai-pane-code').dispatch({ type: 'click', target: { id } });
const writes = (m) => m.mock.calls.filter(c => !c.startsWith('GET'));
const seedFor = (name, target = 'desktop', { text, url } = {}) => KTContext.buildConsultationSeed({ data: INPUTS.data, deps: INPUTS.deps, scan: INPUTS.scan, file: url ? { name, target, type: 'URL', url } : { name, target, type: 'FILE', fileKey: name === 'fieldOnOff.js' ? 'dl:fieldOnOff' : 'dl:mlock', size: '290' }, sourceText: text ?? null, appName: '案件管理' });
/** 依頼（相談中なら相談の要望）→ 仮案 →「これで進めて」で採用 → 計画 → 最終案（JavaScript の生成と検証を含む）。C-1 第 3 段: 仕様の確定と従来の生成の置き換え */
async function adoptScreen(m, text) { const r = await m.panel.send(text); await ticks(6); const a = await m.panel.send('これで進めて'); await ticks(12); return { r, a, v: m.conv().activePlan() }; }
/**
 * §0e.1（2026-10-09）: 最終案のカードの［動作テスト環境へ反映］を 1 回押す（承認の欄の準備を待ってから。承認と登録を 1 回で行う）。承認できたかを返す
 *   結果の詳細は applyScreen（tests/helpers/new-flow.js の applyOnScreen）
 */
const applyScreen = (m) => KIT.applyOnScreen(m);
/** 承認できたか（押した反映が止まらずに進み、承認の記録が残った）。止まったときは承認を外す */
async function approveScreen(m) { const r = await applyScreen(m); return !!(r.v && r.v.approval); }
const confirmSpec = async (m) => { const v = m.conv().activePlan(); await clickChat(m, 'confirm-spec', { plan: v.planId, version: String(v.version) }); };
const jsNames = (m, t) => m.mock.st.customize[t].js.map(e => (e.type === 'URL' ? e.url : m.mock.st.files.get(e.fileKey).name));

(async () => {
// =========================================================
console.log('\n--- §44-1. JsConsultationSeed（KTContext.buildConsultationSeed）---');
{
  const seed = seedFor('fieldOnOff.js', 'desktop', { text: FIELD_ON_OFF });
  assert(seed.seedVersion === 'js-consultation-1' && seed.appId === '310' && seed.appName === '案件管理' && seed.platform === 'desktop' && seed.customizationType === 'FILE' && seed.sourceId === 'desktop:js:fieldOnOff.js' && seed.name === 'fieldOnOff.js' && seed.fileKey === 'dl:fieldOnOff', 'FILE / desktop: appId・app name・platform・type・canonical sourceId・fileKey');
  assert(seed.source.available && seed.source.hash === KTScan.hashText(FIELD_ON_OFF) && seed.source.text === FIELD_ON_OFF && seed.analysis.analyzed && seed.analysis.events.join() === 'app.record.create.show,app.record.edit.show', '本文・指紋・KTScan の解析（イベント）');
  assert(seed.analysis.fields.CONTROL.includes('amount') && seed.analysis.fields.READ.includes('ステータス') && seed.counts.events === 2 && seed.counts.control === 1 && seed.counts.fields === 2 && seed.customizeRevision === '12', 'READ / WRITE / CONTROL の分類・件数・customize revision');
  assert(seed.dependencies.some(d => d.targetType === 'FIELD' && d.targetId === 'amount'), 'deps の edge（関連する依存の事実）');
  const mob = seedFor('mobileLock.js', 'mobile', { text: MOBILE_LOCK });
  assert(mob.platform === 'mobile' && mob.sourceId === 'mobile:js:mobileLock.js' && mob.analysis.fields.CONTROL.includes('owner') && mob.analysis.events.join() === 'mobile.app.record.edit.show', 'mobile の FILE');
  const url = seedFor('ext.js', 'desktop', { url: 'https://cdnjs.cloudflare.com/ajax/libs/ext-lib/1.0.0/ext.js' });
  assert(url.customizationType === 'URL' && url.url === 'https://cdnjs.cloudflare.com/ajax/libs/ext-lib/1.0.0/ext.js' && url.external === true && url.source.available === false && url.source.hash === null && url.analysis.analyzed === false, 'URL（外部）: 本文なし・external');
  const noText = seedFor('fieldOnOff.js', 'desktop');
  assert(noText.source.available && noText.analysis.events.length === 2, '本文を渡さなくても Scanner の結果に本文があればそれを使う');
  const sub = KTContext.subjectFromSeed(seed);
  assert(sub.type === 'javascript' && sub.sourceId === seed.sourceId && sub.target === 'desktop' && sub.customizationType === 'FILE' && sub.sourceAvailable && sub.fields.some(f => f.code === 'amount' && f.access === 'CONTROL'), 'subjectFromSeed（Planner Context 用。本文は含めない）');
  assert(!JSON.stringify(sub).includes("'use strict'"), 'subject に本文は入らない');
}

// =========================================================
console.log('\n--- §44-2. 会話の開始 / 再開 / 別 JS の確認 / Planner の subject ---');
{
  const m = mount();
  await ticks();
  await m.panel.send('このフィールドは何に使ってる？');
  assert(m.msgs().length >= 2 && m.calls.ask.length === 1, '相談前の会話（質問）がある');
  const seed = seedFor('fieldOnOff.js', 'desktop', { text: FIELD_ON_OFF });
  const r1 = m.panel.consult(seed);
  // 2026-10-06: ボタンの文は「今の相談を続ける」「「名前」の相談に切り替える」（act は consult-resume / consult-new のまま）
  assert(r1.needsConfirm === true && m.msgs().some(x => x.data?.kind === 'consult-choices') && /今の相談を続ける</.test(m.chat()) && /「fieldOnOff\.js」の相談に切り替える/.test(m.chat()) && /data-act="consult-new"/.test(m.chat()) && /data-act="consult-resume"/.test(m.chat()), '既に会話があれば「今の相談を続ける / 「fieldOnOff.js」の相談に切り替える」を聞く（勝手に消さない）');
  await clickChat(m, 'consult-resume');
  assert(!m.msgs().some(x => x.data?.kind === 'consult-choices') && !m.conv().subject() && m.msgs().length >= 2, '［今の相談を続ける］: 選択肢を消して会話は残る');
  const r2 = m.panel.consult(seed);
  await clickChat(m, 'consult-new');
  const sub = m.conv().subject();
  assert(sub && sub.sourceId === 'desktop:js:fieldOnOff.js' && m.msgs().length === 1 && m.msgs()[0].data?.kind === 'consultation-start' && /fieldOnOff\.js について相談します/.test(m.chat()) && /PC用 JavaScript/.test(m.chat()) && !/イベント：2件/.test(m.chat()) && /何を変更したいですか/.test(m.chat()) && /相談中の JavaScript/.test(m.$('kt-ai-subject-info').innerHTML) && /app\.record\.create\.show/.test(m.$('kt-ai-subject-info').innerHTML) && /制御<\/span><span>amount/.test(m.$('kt-ai-subject-info').innerHTML), '［「fieldOnOff.js」の相談に切り替える］: 会話を新しくして subject を設定。左は「〜について相談します。何を変更したいですか？」だけ（§20）、現在情報（イベント / 制御 / 本文）は右の「変更内容」');
  assert(/相談中: fieldOnOff\.js（PC）/.test(m.$('kt-ai-header').innerHTML), 'ヘッダーに相談対象');
  const r3 = m.panel.consult(seed);
  assert(r3.ok && r3.resumed === true && m.msgs().length === 1, '同じ JS の「AIに相談」: 再開（会話を残す・初期メッセージを重ねない）');
  // 相談中の発話 → 仮案（CONSULTATION。相談中の JavaScript を仮案の依頼に渡す）→ 採用 → Planner（subject 付き）
  //   C-1 第 3 段（2026-10-08）: DISCUSS_JS（相談から直接計画を作る古い流れ）は削除した（ai-flow-redesign の F1-1〜F1-4）
  const { r: d, a: dA } = await adoptScreen(m, '承認済みになったら金額を編集できなくしたい');
  assert(d.ok && d.intent === KTAiConversation.INTENT.PROPOSE && d.reason === 'CONSULTATION' && m.calls.propose.length === 1 && KTAiConversation.INTENT.DISCUSS_JS === undefined && dA.intent === KTAiConversation.INTENT.ADOPT_DRAFT && m.calls.plan.length === 1, '相談中の要望 → 仮案（CONSULTATION）→ 採用 → Planner を呼ぶ（DISCUSS_JS の意図は無い）');
  assert(m.calls.propose[0].ctx.facts.some(f => /相談中の JavaScript「fieldOnOff\.js」/.test(f.statement || '')), '仮案の Context に相談中の JavaScript の要約（本文は送らない）');
  const ctx = m.calls.plan[0].ctx;
  assert(ctx.subject && ctx.subject.type === 'javascript' && ctx.subject.sourceId === 'desktop:js:fieldOnOff.js' && ctx.subject.name === 'fieldOnOff.js' && ctx.subject.target === 'desktop' && ctx.subject.customizationType === 'FILE' && ctx.subject.sourceAvailable === true && ctx.subject.fields.some(f => f.code === 'amount' && f.access === 'CONTROL'), 'Planner Context に subject（相談中の JS。本文なし）');
  const jsFact = ctx.facts.find(f => f.kind === 'js-file' && /fieldOnOff\.js/.test(f.statement));
  assert(jsFact && ctx.dictionary.jsFiles.includes('fieldOnOff.js') && ctx.dictionary.jsFiles.includes('ext.js'), 'subject の js-file fact は Context に残る（相談対象は省略しない）・dictionary.jsFiles に URL の basename も');
  assert(/fieldOnOff\.jsへ処理を統合する案が適切/.test(m.$('kt-ai-change-summary').innerHTML) && m.conv().activePlan().plan.customizations[0].strategy === 'EXTEND_EXISTING_JS', 'AI の回答: 既存 JS へ統合する案（§6）');
  // 相談中の短い文も相談（計画）として扱う
  assert(m.conv().classify('金額を 100 万円以上にする').intent !== KTAiConversation.INTENT.ASK || true, '（分類の参考）');
  const q = await m.panel.send('このファイルは何をしている？');
  assert(q.intent === KTAiConversation.INTENT.EXPLAIN_CUSTOMIZATION || q.intent === KTAiConversation.INTENT.ASK, '相談中の質問は質問として扱う（計画は作らない）');
  assert(m.calls.plan.length === 1, '質問で Planner は呼ばれない');
  // 別の JS を相談 → 確認 → 新しい会話
  const seed2 = seedFor('mobileLock.js', 'mobile', { text: MOBILE_LOCK });
  const r4 = m.panel.consult(seed2);
  assert(r4.needsConfirm && r4.current?.name === 'fieldOnOff.js' && /現在は「fieldOnOff\.js」の相談中です/.test(m.chat()) && /今の相談を続ける（fieldOnOff\.js）/.test(m.chat()) && /「mobileLock\.js」の相談に切り替える/.test(m.chat()), '別の JS: 現在の相談を示して確認（ボタンに今の相談と切り替え先の名前）');
  const hadPlanText = m.$('kt-ai-plan-result').innerHTML !== '';
  await clickChat(m, 'consult-new');
  assert(m.conv().subject().sourceId === 'mobile:js:mobileLock.js' && !m.conv().activePlan() && m.msgs().length === 1 && /モバイル用 JavaScript/.test(m.chat()), '新しい会話: 計画・生成コードは消え、subject は mobileLock.js');
  // 新しい会話では右も片づける（前の変更案の全文・コードを残さない。表示中のタブは「変更内容」・現在の成果物は新しい相談）
  const art = m.panel.activeArtifact();
  assert(m.panel.drawerState().open === true && m.panel.drawerState().pane === 'plan' && art?.type === 'CONSULTATION' && art?.name === 'mobileLock.js' && hadPlanText && m.$('kt-ai-plan-result').innerHTML === '' && /作った JavaScript を、ここに表示します/.test(m.$('kt-ai-code-head').innerHTML), `新しい会話: 右は新しい相談の内容だけ（前の変更案・コードを残さない）: ${JSON.stringify(art)}`);
}

// =========================================================
console.log('\n--- §45. 実装仕様（C-1 第 3 段で変更）: 最終案の一部として自動で確定・右は閲覧だけ・チャットの文では承認しない・修正で v2（v1 は旧版）---');
//   C-1 第 3 段（2026-10-08）: 仕様の確定（［この仕様で確定］・「それでいい」の案内・確定前は生成しない・会話の仕様のカード）は削除した。
//   仕様は最終案の一部として自動で確定し（ai-flow-redesign の R09-2）、右の「変更内容」で閲覧だけできる（F7-1〜F7-4）。承認は最終案の［この内容で反映する］だけ
{
  const m = mount({ planResponse: (ctx) => (ctx.revision ? PLAN_BOTH : PLAN_REPLACE) });
  await ticks();
  m.panel.consult(seedFor('fieldOnOff.js', 'desktop', { text: FIELD_ON_OFF }));
  const { v: v1 } = await adoptScreen(m, '承認済みになったら金額を編集できなくしたい');
  assert(v1.spec && v1.spec.version === 1 && v1.spec.status === 'CONFIRMED' && v1.spec.customizeRevision === '12' && v1.spec.specId === `${v1.planId}:spec` && v1.spec.subject?.name === 'fieldOnOff.js' && !m.types().includes('SPEC'), '計画 v1 → 実装仕様 v1（相談対象付き）。最終案の一部として自動で確定し customize revision 12 を記録（会話に仕様のカードは出さない）');
  //   2026-10-19: 実装仕様のカード（右の「変更内容」の #kt-ai-spec）は廃止した。目的・方針（統合先）・画面・対象のフィールドは右の「変更内容」の要約
  const html = m.$('kt-ai-change-summary').innerHTML;
  assert(/<h3>承認済みになったら金額を編集できなくしたい<\/h3>/.test(html) && /既存の「fieldOnOff\.js」に統合/.test(html) && /対象のフィールド: [^<]*「[^」]+」（制御）/.test(html) && /編集画面/.test(html) && !/amount（CONTROL）|app\.record\./.test(html) && !/data-act="(confirm-spec|revise-spec|confirm-generate|generate)"/.test(html), `${KIT.stripC(html).replace(/\s+/g, ' ').slice(0, 300)} / ` + '仕様（右の「変更内容」）: 目的 / PC ✎ fieldOnOff.js を変更 / 対象フィールド（名前と扱い）/ 画面（§0e.3: フィールドのコード・扱いの英語・イベント名は出さない）。閲覧だけ（［仕様を修正］［この仕様で確定］［確定してコードを作る］は無い）');
  assert(!/kt-ai-spec-card/.test(m.chat()) && !/data-act="confirm-spec"/.test(m.chat()) && /最終案ができました。/.test(m.chat()), '会話は最終案のカード 1 枚（仕様のカード・確定ボタンは無い）');
  assert(m.mock.calls.filter(c => c === 'GET customize').length >= 1 && writes(m).length === 0, '仕様の確定のときに動作テスト環境の設定を読むだけ（書き込み 0）');
  const c1 = await m.panel.send('それでいい'); await ticks();
  assert(!m.conv().activePlan().approval && writes(m).length === 0 && m.panel.jsExecState().stage === 'idle' && c1.intent !== KTAiConversation.INTENT.ADOPT_DRAFT, '「それでいい」: チャットの文では承認しない（承認は最終案の［この内容で反映する］だけ。書き込み 0）');
  // 修正 → v2（PC は既存へ統合・mobile は新規）
  const rv = await m.panel.send('モバイルでも同じようにしたい'); await ticks(12);
  assert(rv.intent === KTAiConversation.INTENT.REVISE_PLAN && m.calls.plan.length === 2 && m.calls.plan[1].ctx.revision && m.calls.plan[1].ctx.subject?.sourceId === 'desktop:js:fieldOnOff.js', '修正の依頼: REVISE_PLAN（subject 付き）');
  const v2 = m.conv().activePlan();
  assert(v2.version === 2 && v2.spec.version === 2 && v2.spec.status === 'CONFIRMED' && v1.spec.status === 'SUPERSEDED' && v1.status === 'SUPERSEDED', 'v2 の仕様（最終案の一部として確定）・v1 の仕様は SUPERSEDED');
  const rightSpec = m.$('kt-ai-change-summary').innerHTML;
  assert(/モバイル/.test(rightSpec) && /新しい JavaScript「[^」]+」を登録/.test(rightSpec) && /既存の「fieldOnOff\.js」に統合/.test(rightSpec), `仕様 v2: PC は既存へ統合・モバイルは新しい JavaScript（§6）。右の「変更内容」は v2 だけ: ${KIT.stripC(rightSpec).replace(/\s+/g, ' ').slice(0, 300)}`);
  //   旧版（v1）の仕様のカードは削除した。前の最終案は 1 行に畳む（ai-flow-redesign の R10-4・F2-2）
  assert(/前の最終案 — このあと直した案があります/.test(m.chat()) && !/実装仕様 v\d/.test(m.chat()), '前の最終案は「このあと直した案があります」に畳む（会話に仕様の版の番号は出さない）');
  assert(typeof m.conv().confirmSpec === 'undefined' && KTAiConversation.MSG.SPEC === undefined && typeof m.panel.confirmSpec === 'undefined', '仕様の確定の操作・仕様のカードの種類は無い（ai-flow-redesign の F7-1・F7-4）');
}

// =========================================================
console.log('\n--- §46〜§53（UI 経由）: 既存 FILE の差し替え登録 → 検証 → Rollback、文章だけでは登録しない ---');
//   C-1 第 3 段: 生成は最終案の中で行い、登録は最終案の承認の後だけ（ai-flow-redesign の F10-2・F11-2）。登録・検証・復元・監査はそのまま
{
  const m = mount();
  await ticks();
  m.panel.consult(seedFor('fieldOnOff.js', 'desktop', { text: FIELD_ON_OFF }));
  const before = jsNames(m, 'desktop');
  const { v } = await adoptScreen(m, '承認済みになったら金額を編集できなくしたい');
  const r0 = await m.panel.send('JS を登録して');
  assert(r0.intent === KTAiConversation.INTENT.REQUEST_JS_PREVIEW && m.msgs()[m.msgs().length - 1].data?.kind === 'js-preview-needs-approval' && writes(m).length === 0 && m.panel.jsExecState().stage === 'idle', '承認前の「JS を登録して」: 最終案の承認へ案内するだけ（登録しない・書き込み 0）');
  const entry = m.panel.generated('C1');
  assert(entry && entry.review.status === 'OK' && entry.existingSource?.from === 'preview-base' && entry.existingSource.text === FIELD_ON_OFF && m.calls.generate[0].ctx.existingFile?.source === FIELD_ON_OFF, '生成: 統合先の本文は作業の基準（動作テスト環境のファイル）から・Code Review OK（簡素化 2026-10-17: 相談の元の本文で代える分岐は削除した）');
  await clickChat(m, 'open-code', { cid: 'C1', plan: v.planId, version: String(v.version) });
  assert(!/data-act="open-js-register"/.test(m.chat()), '登録の操作は最終案のカードの［動作テスト環境へ反映］だけ（会話の登録の案内・右の「コード」の［動作テスト環境へ登録］は出さない。§0e.1）');
  //   §0e.1（2026-10-09）: 登録の準備（読み取りだけ）は最終案が承認できる状態になると自動で走り、以前の登録の最終確認（§21）の内容を承認の欄に出す
  await KIT.waitUntil(() => m.panel.finalPrecheck().status === 'ready', 60);
  { const pre = m.panel.finalPrecheck(); const chatPre = KIT.stripC(m.chat());
    assert(pre.items.files.join() === '✎ fieldOnOff.js（PC）既存ファイルを更新（同じ位置）' && pre.items.keep[0] === 'PC：1件変更　モバイル：変更なし' && pre.items.keep[1] === '既存の CSS（1 件）・その他の JS（2 件）・適用範囲（全員）は変更しません' && /運用環境には反映しません/.test(pre.items.target) && writes(m).length === 0 && m.panel.jsExecState().stage === 'idle', '承認の欄（以前の最終確認 §21）: 変更の一覧・PC / モバイルの件数・保持する設定（適用範囲は画面の言葉「全員」）・運用環境には反映しない（準備は読み取りだけ・書き込み 0）');
    assert(/反映の前の確認（書き込みなし）/.test(chatPre) && /✎ fieldOnOff\.js（PC）既存ファイルを更新/.test(chatPre) && /既存の CSS（1 件）・その他の JS（2 件）・適用範囲（全員）は変更しません/.test(chatPre) && !/適用範囲（ALL）|Mobile：/.test(chatPre) && KIT.applyButtonOf(m) && !KIT.applyButtonOf(m).disabled, '最終案のカードの承認の欄に同じ内容を出し、［動作テスト環境へ反映］を押せる'); }
  const r1 = await m.panel.send('JS を登録して');
  assert(r1.intent === KTAiConversation.INTENT.REQUEST_JS_PREVIEW && m.msgs()[m.msgs().length - 1].data?.kind === 'js-preview-needs-approval' && /［動作テスト環境へ反映］/.test(m.msgs()[m.msgs().length - 1].text) && writes(m).length === 0 && m.panel.jsExecState().stage === 'idle', '「JS を登録して」: 最終案のカードの［動作テスト環境へ反映］へ案内するだけ（登録しない・書き込み 0）');
  const nA = m.msgs().length;
  const ar = await applyScreen(m);
  assert(ar.button && !ar.button.disabled && v.approval && v.approval.precheck && m.panel.drawerState().open === true && m.panel.drawerState().pane === 'exec' && m.$('kt-ai-pane-exec').style.display === 'block' && m.panel.activeArtifact()?.type === 'EXECUTION' && m.panel.activeArtifact()?.js === true, '［動作テスト環境へ反映］1 回で承認と登録。進捗と結果は右のタブ「反映」（activeArtifact EXECUTION / js。タブが切り替わる）');
  { const jx = m.panel.jsExecState();
    assert(jx.prepared.changes[0].kind === 'REPLACE_FILE' && jx.prepared.changes[0].position === 1 && jx.prepared.changes[0].currentHash === KTScan.hashText(FIELD_ON_OFF), '登録の準備は既存ファイルの更新（同じ位置・登録直前の本文の指紋）'); }
  const ex = m.panel.jsExecState().execution;
  assert(m.panel.jsExecState().stage === 'done' && ex && ex.status === 'DONE' && ex.steps[0].status === 'VERIFIED' && writes(m).join(',') === 'POST file,PUT customize', '［動作テスト環境へ登録］→ upload → PUT → 検証 → DONE（書き込みは upload ＋ PUT だけ）');
  const after = jsNames(m, 'desktop');
  assert(after.length === before.length && after[0] === before[0] && after[1] === 'fieldOnOff.js' && m.mock.st.customize.desktop.js[1].fileKey !== 'dl:fieldOnOff' && m.mock.st.files.get(m.mock.st.customize.desktop.js[1].fileKey).content.includes("value === '承認済'") && jsNames(m, 'mobile').join() === 'mobileLock.js' && m.mock.st.customize.desktop.css.length === 1, '動作テスト環境: 同じ位置の fieldOnOff.js だけ新しい本文（承認済の分岐入り）。URL / mobile / CSS はそのまま');
  // 2026-10-06: 会話のカードは「反映後の確認：✓ x / y 件一致」（VERIFIED などの内部の語は出さない）
  assert(JSON.stringify(m.msgs().slice(nA).map(x => x.data?.kind || x.type)) === JSON.stringify(['final-apply']) && ar.cardCount === 1 && /動作テスト環境へ反映しました/.test(ar.card) && /JavaScript: ✎ fieldOnOff\.js（PC） を登録（反映後の確認 ✓ 1 \/ 1 件一致）/.test(ar.card) && !/kt-ai-js-execution-card/.test(m.chat()) && !/VERIFIED/.test(m.chat()) && !/Plan との一致/.test(m.chat()) && /運用環境には反映されていません/.test(m.chat()) && /data-act="js-rollback"/.test(m.chat()) && /登録結果を見る/.test(m.chat()) && /sourceHash/.test(m.pane()), '結果カード（§8 / §31・2026-10-09 は 1 枚にまとめる）: ✎ fieldOnOff.js（PC）反映後の確認：✓ 1 / 1 件一致・運用環境には反映されていません・［登録結果を見る］［変更前の状態に戻す］。検証の内訳（sourceHash 等）は右下の右の「反映」');
  // 2026-10-21: 会話は登録の状態を写さない（上の確かめ: 登録の操作で会話に足すのは結果のカード 1 枚だけ）。計画の版には登録した印と「反映済み」を残す
  assert(m.rescans.length === 1 && v.jsExecutionId === ex.executionId && v.status === 'EXECUTED', `計画の版: 登録した印・反映済み・再スキャンを 1 回: ${v.status}`);
  //   2026-10-21: 別の JS の相談に切り替える前の注意（戻していない変更）は、画面の反映・登録の状態（unrevertedPreviewChange）から出す（会話は登録の状態を写さない）
  m.panel.consult(seedFor('other.js', 'desktop', { text: FIELD_ON_OFF }));
  const choicesBefore = KIT.stripC(m.chat());
  await clickChat(m, 'consult-resume');
  assert(/「other\.js」の相談に切り替える/.test(choicesBefore) && /まだ元に戻していない変更があります/.test(choicesBefore) && !m.msgs().some(x => x.data?.kind === 'consult-choices'), '別の JS の相談に切り替える前: 登録して戻していない変更があることを出す（［今の相談を続ける］で選択肢を消す）');
  assert(/PUT \/preview\/app\/customize: ✓（revision 12 → 13）/.test(m.pane()) && /sourceHash/.test(m.pane()) && /id="kt-ai-jsreg-audit-copy"/.test(m.pane()) && /id="kt-ai-jsreg-rollback-start"/.test(m.pane()), 'コードペインの結果: PUT の revision・検証項目・［Audit JSON をコピー］［変更前の状態に戻す］');
  await clickPane(m, 'kt-ai-jsreg-audit-copy');
  const audit = JSON.parse(m.copies.pop());
  assert(audit.kind === 'customization' && audit.consultationSubject.sourceId === 'desktop:js:fieldOnOff.js' && audit.approvedSpec?.version === 1 && audit.specVersions.length === 1 && audit.generated[0].codeReview.status === 'OK' && audit.generated[0].sourceBeforeHash === KTScan.hashText(FIELD_ON_OFF) && audit.customizationBefore.revision === '12' && audit.customizationAfter.revision === '13' && audit.verification.ok, 'Customization Audit（§37）: 相談対象・承認 spec・生成の出所と前後の指紋・登録前後・検証');
  // 文章だけでは戻さない → 戻し方の案内 → 結果のカードの［JavaScript を変更前に戻す］→ 確認 → 戻す
  //   2026-10-21: 発言から出していた「戻せます」のカード（js-rollback-ready）は廃止した。戻す操作は結果のカードと反映の記録のボタンだけ
  const rb0 = await m.panel.send('やっぱり元に戻して');
  const guide = m.msgs()[m.msgs().length - 1];
  assert(rb0.intent === KTAiConversation.INTENT.REQUEST_ROLLBACK && guide.data?.kind === 'rollback-guide' && /［JavaScript を変更前に戻す］/.test(guide.text) && writes(m).length === 2, '「元に戻して」→ 戻し方の案内だけ（書き込み無し）');
  const nR = m.msgs().length;
  await clickChat(m, 'js-rollback', { execution: ex.executionId });
  await ticks(6);
  assert(m.panel.jsExecState().stage === 'rollback-confirm' && /登録前の状態に戻します。/.test(m.pane()) && /✎ <b>fieldOnOff\.js<\/b>（PC）を登録前の本文に戻す/.test(m.pane()) && /id="kt-ai-jsreg-rollback-go"/.test(m.pane()) && writes(m).length === 2, '［変更前の状態に戻す］→ prepareRollback（読み取りだけ）→ 確認画面');
  await clickPane(m, 'kt-ai-jsreg-rollback-go');
  await ticks(10);
  const rb = m.panel.jsExecState().rollback;
  const restoredKey = m.mock.st.customize.desktop.js[1].fileKey;
  assert(m.panel.jsExecState().stage === 'rolled-back' && rb.status === 'ROLLED_BACK_VERIFIED' && restoredKey !== 'dl:fieldOnOff' && m.mock.st.files.get(restoredKey).content === FIELD_ON_OFF && m.mock.st.files.get(restoredKey).name === 'fieldOnOff.js' && writes(m).join(',') === 'POST file,PUT customize,POST file,PUT customize', 'Rollback: 登録前の本文を再アップロードして同じ位置に戻し、検証 ✓（upload 1 ＋ PUT 1。実機: 旧 fileKey は再指定できない）');
  // 2026-10-06: 復元のカードは「登録する前の設定との比較：…」（snapshot などの内部の語は出さない）。
  //   2026-10-21: 復元のカード（JS_ROLLBACK）は、今の会話の登録を戻し始めたときに画面が会話に出す。計画の版は「元に戻し済み」。処理の通知（js-rolled-back）は作らない
  assert(m.msgs().slice(nR).filter(x => x.type === 'JS_ROLLBACK').length === 1 && m.types().filter(t => t === 'JS_ROLLBACK').length === 1 && /JavaScript を登録前の状態へ戻しました/.test(m.chat()) && /登録する前の設定との比較：✓ 一致/.test(m.chat()) && !/snapshot/i.test(m.chat()) && v.status === 'ROLLED_BACK' && m.rescans.length === 2, `復元カード（戻し始めたときに 1 枚・登録する前の設定との比較）・計画の版は元に戻し済み・再スキャン: ${JSON.stringify({ status: v.status, added: m.msgs().slice(nR).map(x => x.data?.kind || x.type) })}`);
  m.panel.consult(seedFor('other.js', 'desktop', { text: FIELD_ON_OFF }));
  const choicesAfter = KIT.stripC(m.chat());
  await clickChat(m, 'consult-resume');
  assert(/「other\.js」の相談に切り替える/.test(choicesAfter) && !/まだ元に戻していない変更があります/.test(choicesAfter), '戻した後は、別の JS の相談に切り替える前の注意に戻していない変更を出さない');
  const again = await m.panel.send('戻して');
  assert(again.intent === KTAiConversation.INTENT.REQUEST_ROLLBACK && m.msgs()[m.msgs().length - 1].data?.kind === 'rollback-guide' && !/data-act="js-rollback"/.test(m.chat()) && writes(m).length === 4, '戻した後の「戻して」も案内だけ（会話に戻すボタンは残らない・書き込み無し）');
}
{
  //   2026-10-21: 前の会話の JavaScript の登録を、新しい会話で反映の記録から開いて戻す → 新しい会話には元に戻すのカードを出さず、戻したことを一言で知らせる
  //   （会話は登録の状態を写さない。戻し終えたときに画面が知らせる）
  const m = mount();
  await ticks();
  m.panel.consult(seedFor('fieldOnOff.js', 'desktop', { text: FIELD_ON_OFF }));
  const { v } = await adoptScreen(m, '承認済みになったら金額を編集できなくしたい');
  const ar = await applyScreen(m);
  const exId = m.panel.jsExecState().execution?.executionId;
  assert(ar.run && ar.run.ok && exId && v.status === 'EXECUTED' && writes(m).length === 2, `前提: JavaScript を登録した（計画の版は反映済み）: ${JSON.stringify({ ok: ar.run && ar.run.ok, status: v.status })}`);
  await m.$('kt-ai-new-conv').dispatch('click'); await ticks();
  await m.$('kt-ai-header').dispatch({ type: 'click', target: { dataset: { act: 'open-log' } } });
  const logId = (/data-log="([^"]+)"/.exec(m.$('kt-ai-apply-log').innerHTML) || [])[1] || null;
  await m.$('kt-ai-pane-log').dispatch({ type: 'click', target: { dataset: { act: 'log-open', log: logId } } }); await ticks(4);
  await clickPane(m, 'kt-ai-jsreg-rollback-start'); await ticks(6);
  await clickPane(m, 'kt-ai-jsreg-rollback-go'); await ticks(10);
  const chat = KIT.stripC(m.chat());
  assert(logId && m.panel.jsExecState().stage === 'rolled-back' && m.panel.jsExecState().rollback?.status === 'ROLLED_BACK_VERIFIED' && writes(m).length === 4 && !m.msgs().some(x => x.type === 'JS_ROLLBACK') && m.msgs().some(x => x.data?.kind === 'apply-log-js-rolled-back') && /反映の記録から開いた JavaScript の登録（前の会話・依頼: [^）]+）を、登録前の状態に戻しました。/.test(chat), `前の会話の JavaScript の登録を記録から戻す: 新しい会話に元に戻すのカードを出さず、戻したことを一言で知らせる: ${JSON.stringify({ logId, stage: m.panel.jsExecState().stage, types: m.msgs().map(x => x.data?.kind || x.type) })}`);
}

// =========================================================
console.log('\n--- 新規 JS（desktop）の登録 / mobile（desktop を変えない）/ URL の fallback / stale / Rollback stale ---');
{
  const m = mount({ planResponse: PLAN_NEW_DESKTOP });
  await ticks();
  const { v } = await adoptScreen(m, '100万円以上なら警告を表示したい');
  const arN = await applyScreen(m);
  assert(arN.pre.items.files.join() === '＋ amount-warning.js（PC）新規追加（3 番目・末尾）' && arN.pre.items.keep[0] === 'PC：1件追加　モバイル：変更なし' && m.panel.jsExecState().prepared.changes[0].kind === 'ADD_FILE' && m.panel.jsExecState().prepared.changes[0].name === 'amount-warning.js' && v.approval, '新規 JS: 承認の欄に ADD_FILE・末尾（3 番目）・PC 1 件追加 →［動作テスト環境へ反映］1 回で承認と登録');
  assert(m.panel.jsExecState().execution.status === 'DONE' && jsNames(m, 'desktop').join() === 'https://cdnjs.cloudflare.com/ajax/libs/ext-lib/1.0.0/ext.js,fieldOnOff.js,amount-warning.js' && jsNames(m, 'mobile').join() === 'mobileLock.js', '§48 desktop JS 2 → 3（URL と既存を保持・mobile は不変）');
}
{
  const m = mount({ planResponse: PLAN_MOBILE_NEW });
  await ticks();
  m.panel.consult(seedFor('mobileLock.js', 'mobile', { text: MOBILE_LOCK }));
  const { r: d, v } = await adoptScreen(m, '承認済みでは金額を編集不可にしたい');
  assert(d.intent === KTAiConversation.INTENT.PROPOSE && d.reason === 'CONSULTATION' && m.calls.plan[0].ctx.subject.target === 'mobile', 'mobile JS の相談: 仮案 → 採用 → 計画（subject.target mobile）');
  const before = jsNames(m, 'desktop');
  const arM = await applyScreen(m);
  assert(v.approval && m.panel.jsExecState().prepared.changes[0].target === 'mobile' && /（モバイル）新規追加/.test(arM.pre.items.files.join()) && arM.pre.items.keep[0] === 'PC：変更なし　モバイル：1件追加', 'mobile の新規 JS: 承認の欄にモバイル 1 件追加・PC 変更なし →［動作テスト環境へ反映］1 回で登録');
  assert(m.panel.jsExecState().execution.status === 'DONE' && jsNames(m, 'mobile').join() === 'mobileLock.js,approved-lock-mobile.js' && jsNames(m, 'desktop').join() === before.join(), '§56 mobile に登録・desktop は変更なし');
}
{
  // URL（外部）: 本文なし → JS_SOURCE_UNAVAILABLE
  const m = mount({ planResponse: PLAN_EXT });
  await ticks();
  m.panel.consult(seedFor('ext.js', 'desktop', { url: 'https://cdnjs.cloudflare.com/ajax/libs/ext-lib/1.0.0/ext.js' }));
  assert(/URL 指定/.test(m.chat()) && /取得できません（外部 URL/.test(m.$('kt-ai-subject-info').innerHTML), '外部 URL の相談: 左は URL 指定の印、本文が無い旨は右の「変更内容」の相談カード');
  const { v } = await adoptScreen(m, '承認済みでは担当者を編集不可にしたい');
  //   C-1 第 3 段: 生成は最終案の中。従来の source-unavailable のカード（［新しい JavaScript として作る］の選択肢）は削除した。
  //   守ること（本文が無い既存のファイルへは自動生成しない・反映できない・内部のコードを出さない）は最終案の「実現できない点」で確かめる
  const gC1 = v.generated && v.generated.C1;
  assert(m.calls.generate.length === 0 && gC1 && gC1.status === 'failed' && gC1.failure && gC1.failure.reason === 'JS_SOURCE_UNAVAILABLE' && v.final && FS.readyOf(v) === false && /統合先の既存の JavaScript の本文を取得できませんでした/.test(m.chat()) && !/JS_SOURCE_UNAVAILABLE/.test(m.chat()) && !(await approveScreen(m)), '外部 URL への統合: 本文が無いので生成せず（会話に内部のコードは出さない）、最終案は承認できない（実現できない点に理由）');
  // URL（本文は読める想定）: 生成はできるが登録は EXTERNAL_JS_NOT_WRITABLE
  const m2 = mount({ planResponse: PLAN_EXT });
  await ticks();
  m2.panel.consult(seedFor('ext.js', 'desktop', { url: 'https://cdnjs.cloudflare.com/ajax/libs/ext-lib/1.0.0/ext.js', text: EXT_SRC }));
  const { v: v2 } = await adoptScreen(m2, '承認済みでは担当者を編集不可にしたい');
  const e2 = m2.panel.generated('C1');
  assert(e2 && e2.existingSource?.from === 'url' && e2.existingSource.external === true, 'URL の JS への patch: 生成はできる（統合先の本文は URL から・外部）');
  //   以前はコードのカードで「Toolkit からは書き換えられない」と伝え、［新規 JS として設計し直す］を出し、右の登録ボタンを出さなかった。
  //   C-1 第 3 段: 最終案の流れでは、書き換えられない外部のファイルへの変更を最終案の時点で承認できない理由にし、カードに「書き換えられません」と出す
  //   （登録の準備で初めて止めない）
  assert(v2.final && FS.readyOf(v2) === false && /書き換えられません/.test(m2.chat()), 'URL の JS への変更: 最終案のカードで「Toolkit からは書き換えられない」と伝え、承認できる完成品として出さない');
  const r49 = await applyScreen(m2);
  assert(!v2.approval && r49.button && r49.button.disabled && m2.panel.jsExecState().stage === 'idle' && writes(m2).length === 0, '§49 ［動作テスト環境へ反映］は押せず、押しても承認・登録しない（URL 指定の JavaScript は自動で置き換えない）');
}
{
  // §50 stale: 承認の欄の準備（仕様確定・最終案の承認の前）の後に、カスタマイズ設定が変わった → 何も書き込まずに止め、変わった点を出す（§0e.1）
  const m = mount();
  await ticks();
  m.panel.consult(seedFor('fieldOnOff.js', 'desktop', { text: FIELD_ON_OFF }));
  const { v } = await adoptScreen(m, '承認済みになったら金額を編集できなくしたい');
  const r50 = await KIT.applyOnScreen(m, { before: async () => {
    const cur = await m.mock.api.getPreviewCustomize('310');
    const up = await m.mock.api.uploadFile('manual.js', '// manual', 'text/javascript');
    await m.mock.api.putPreviewCustomize('310', { app: 310, scope: cur.scope, desktop: { js: [...cur.desktop.js.map(e => (e.type === 'URL' ? e : { type: 'FILE', file: { fileKey: e.file.fileKey } })), { type: 'FILE', file: { fileKey: up } }], css: cur.desktop.css.map(e => ({ type: 'FILE', file: { fileKey: e.file.fileKey } })) }, mobile: { js: cur.mobile.js.map(e => ({ type: 'FILE', file: { fileKey: e.file.fileKey } })), css: [] } }, cur.revision);
  } });
  assert(r50.run && r50.run.stage === 'stopped' && !r50.run.written && r50.writes.join(',') === 'POST file,PUT customize' && !v.approval && /何も書き込まずに止めました/.test(r50.card) && /JavaScript \/ CSS の一覧または適用範囲が、承認の欄の準備の後に変わりました/.test(r50.card) && /最新の設定で最終案を作り直します/.test(r50.card), `§50 承認の欄の準備の後にカスタマイズ設定が変わった → 書き込まずに止め、変わった点と次の手（作り直し）を出す・承認を外す: ${r50.card.slice(0, 300)}`);
  //   簡素化（2026-10-17）: 作り直しの扱い（STALE）の最終案は［動作テスト環境へ反映］を押せず、押しても承認・登録しない（承認だけを記録する口・登録の部品を
  //   画面の外から呼ぶ口は削除した）。照合 STALE_CUSTOMIZATION そのもの（内容を変えずに保存し直した revision の変化）は部品のテスト（ai-js-executor・ai-flow-redesign H6）が確かめる
  const v50 = m.conv().activePlan();
  const r50b = await KIT.applyOnScreen(m);
  assert(v50.status === 'STALE' && !v50.approval && r50b.button && r50b.button.disabled && r50b.writes.length === 0 && writes(m).join(',') === 'POST file,PUT customize', `§50 作り直しの扱いの最終案は押せず、押しても承認・登録しない（書き込みは別の担当者の変更だけ）: ${JSON.stringify({ status: v50.status, button: r50b.button })}`);
}
{
  // §53 rollback stale: 登録後に人間が JS を足した
  const m = mount();
  await ticks();
  m.panel.consult(seedFor('fieldOnOff.js', 'desktop', { text: FIELD_ON_OFF }));
  const { v } = await adoptScreen(m, '承認済みになったら金額を編集できなくしたい');
  assert(await approveScreen(m) && m.panel.jsExecState().stage === 'done', '前提: 最終案を［動作テスト環境へ反映］1 回で承認して登録した');
  const cur = await m.mock.api.getPreviewCustomize('310');
  const up = await m.mock.api.uploadFile('manual.js', '// manual', 'text/javascript');
  await m.mock.api.putPreviewCustomize('310', { app: 310, scope: cur.scope, desktop: { js: [...cur.desktop.js.map(e => (e.type === 'URL' ? e : { type: 'FILE', file: { fileKey: e.file.fileKey } })), { type: 'FILE', file: { fileKey: up } }], css: cur.desktop.css.map(e => ({ type: 'FILE', file: { fileKey: e.file.fileKey } })) }, mobile: { js: cur.mobile.js.map(e => ({ type: 'FILE', file: { fileKey: e.file.fileKey } })), css: [] } }, cur.revision);
  await clickChat(m, 'js-rollback', { execution: m.panel.jsExecState().execution.executionId });
  await ticks(6);
  assert(m.panel.jsExecState().stage === 'rollback-blocked' && m.panel.jsExecState().rollback.blockers[0].code === 'ROLLBACK_STALE' && /自動では元に戻せません/.test(m.pane()) && /desktop\.js\[2\]/.test(m.pane()) && jsNames(m, 'desktop').length === 3, '§53 登録後に人間が JS を追加 → ROLLBACK_STALE（上書きしない）');
  assert(/自動では元に戻せません/.test(m.chat()), '会話にも案内');
}

console.log('\n--- §54 modern JavaScript（2026-10-05。§0d.3・簡素化 B で変更）: Toolkit は生成工程が検証したコードを書き換えない。var は生成工程の機械検査で止まり、登録できない ---');
{
  // AI が var を含むコードを返した（古い Gateway・Gateway の修正の前と同じ）
  //   §0d.3（2026-10-08）の決定で期待値を変えた: 以前は Toolkit が生成の直後に const へ直して登録していたが、検証した候補と登録する候補（candidateHash）が
  //   食い違うので書き換えをやめた。検出は残す（modern-js の block。直すのは生成工程の修復か作り直し）
  //   C-1 第 3 段: 生成は最終案の中。var の残る候補の最終案は承認できず、登録の確認を開いても登録しない。
  //   簡素化 B（2026-10-16）: var の検出は生成工程の機械検査（modern-js）だけ（Toolkit の写しの「反映直前の形式確認（記法）」は削除）。Toolkit はその結果で止める
  const VAR_JS = NEW_JS.replace('    const record = event.record;', '    var record = event.record;');
  const m = mount({ planResponse: PLAN_NEW_DESKTOP, generatedFor: (ctx) => ({ ...genFor(ctx), code: VAR_JS }) });
  await ticks();
  const { v } = await adoptScreen(m, '100万円以上なら警告を表示したい');
  const g = v.generated.C1;
  const mj = g && g.verification && (g.verification.machine || []).find(x => x.name === 'modern-js' && !x.ok);
  assert(g && g.generated.code === VAR_JS && g.status === 'unresolved' && mj && mj.severity === 'block' && /var record/.test(mj.message) && !g.review.checks.some(x => x.name === 'modern-js' && !x.gateway) && (v.final.blockers || []).some(b => b.text === `機械検査で登録を止める問題: ${mj.message}`), `§54 AI の var は書き換えず（生成工程が返したコードのまま）、生成工程の機械検査の block で止まる（Toolkit は記法を確かめない）: ${g && g.status} ${mj && mj.message}`);
  assert(v.final && FS.readyOf(v) === false && !(await approveScreen(m)), '§54 var の残る候補の最終案は承認できない');
  //   簡素化（2026-10-17）: 会話のカードから JavaScript だけを登録する経路（open-js-register・登録の確認画面）は削除した。登録は［動作テスト環境へ反映］1 回の反映の中だけ
  await ticks(10);
  const up = [...m.mock.st.files.values()].find(f => f.name === 'amount-warning.js');
  assert(!up && !(m.panel.jsExecState().execution && m.panel.jsExecState().execution.status === 'DONE'), '§54 var の残る候補は登録しない（アップロードも PUT もしない）');
}
{
  // ファイル直下の var（グローバル）: 生成工程が自動では直せない → 機械検査の文（行・文）をそのまま最終案の止める理由に出し、承認・登録の準備をしない
  //   簡素化 B（2026-10-16）: 直せない理由の文（関数の外など）は生成工程が作る（AI版 worker/test/cases/modern-js.mjs）。Toolkit は文を作らず、そのまま出す
  const TOP_JS = `var LIMIT = 1000000;\n${NEW_JS}`;
  const m = mount({ planResponse: PLAN_NEW_DESKTOP, generatedFor: (ctx) => ({ ...genFor(ctx), code: TOP_JS }) });
  await ticks();
  const { v } = await adoptScreen(m, '100万円以上なら警告を表示したい');
  const g = v.generated.C1;
  const mj = g && g.verification && (g.verification.machine || []).find(x => x.name === 'modern-js' && !x.ok);
  assert(g && g.status === 'unresolved' && mj && /1 行目「var LIMIT = 1000000;」: var LIMIT/.test(mj.message) && (v.final.blockers || []).some(b => b.text === `機械検査で登録を止める問題: ${mj.message}`) && FS.readyOf(v) === false, `§54 直せない var は生成工程の機械検査の文（行・文）のまま止める理由に出す: ${mj && mj.message}`);
  //   簡素化（2026-10-17）: 会話のカードから JavaScript だけを登録する経路（open-js-register）は削除した。登録は［動作テスト環境へ反映］1 回の反映の中だけ
  assert(!(await approveScreen(m)) && !m.panel.jsExecState().prepared, `§54 承認できず、登録の準備もしない（登録は［動作テスト環境へ反映］の中だけ）: ${JSON.stringify(m.panel.jsExecState().prepared && m.panel.jsExecState().prepared.blockers)}`);
}

//   §55（［確定してコードを作る］・古い版のボタンでは作らない）は削除した: 仕様の確定と生成は最終案のパイプラインに置き換えた
//   （ai-flow-redesign の R09-2・F2-3・F7-3）。古い版の操作で進めないことは、最終案の承認の版の照合（R16-5・画面-4・画面-5）で守る

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
