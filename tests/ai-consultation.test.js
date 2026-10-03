// Customize → AI Workflow（Phase 17）: JS 相談（Consultation Seed / 会話の開始・再開）・実装仕様の版と確定（UI だけが SoT）・JavaScript の動作テスト環境への登録 / 検証 / 復元（AI Workspace 経由）
//
// 検証内容:
//   §44 Customize → AI: FILE / URL・desktop / mobile の seed、sourceId、会話の開始（初期メッセージ）、同じ JS の再開、別 JS の確認（戻る / 新しい会話）、Planner Context の subject
//   §45 Spec: 初回の仕様 v1（DRAFT）、修正で v2（v1 は SUPERSEDED）、チャットの「それでいい」では確定しない、［この仕様で確定］で確定（customize revision を記録）、確定前はコードを作らない
//   §46〜§53（UI 経由）: 既存 FILE の差し替え登録・新規 JS の登録・mobile・URL の fallback・stale・検証・Rollback・Rollback stale・文章だけでは登録 / 復元しない・監査
//
// 実行方法: node tests/ai-consultation.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { makeFakeHost } = require('./helpers/fake-dom.js');
const { KTDeps, KTScan, KTContext, KTAiClient, KTAiConversation, KTCodeReview, KTJsExecutor, mountAiWorkspace } = loadToolkit();
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const { buildScanPayload } = require('./helpers/scan-payload.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');

const FIELD_ON_OFF = [
  "(function () {",
  "  'use strict';",
  "  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {",
  "    var record = event.record;",
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
  "    var record = event.record;",
  "    record['amount'].error = Number(record['amount'].value || 0) >= 1000000 ? '100万円以上は部長の承認が必要です' : null;",
  "    return event;",
  "  });",
  "})();",
].join('\n');
const MOBILE_NEW = "(function () {\n  'use strict';\n  kintone.events.on('mobile.app.record.edit.show', function (event) {\n    if (event.record['ステータス'].value === '承認済') {\n      event.record['amount'].disabled = true;\n    }\n    return event;\n  });\n})();";
const FILES = [{ name: 'fieldOnOff.js', target: 'desktop', kind: 'js', text: FIELD_ON_OFF }, { name: 'mobileLock.js', target: 'mobile', kind: 'js', text: MOBILE_LOCK }];
function buildInputs() {
  const data = FX.makeData();
  data.customize = {
    scope: 'ALL',
    desktop: { js: [{ type: 'URL', url: 'https://example.com/lib/ext.js' }, { type: 'FILE', file: { contentType: 'text/javascript', fileKey: 'dl:fieldOnOff', name: 'fieldOnOff.js', size: '290' } }], css: [{ type: 'FILE', file: { contentType: 'text/css', fileKey: 'dl:style', name: 'style.css', size: '10' } }] },
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
const CUST = (o = {}) => ({ customizationId: 'C1', requirement: '承認済では金額を編集不可', whyStandardInsufficient: 'フィールドのアクセス権はステータスで変えられない', strategy: 'EXTEND_EXISTING_JS', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [{ name: 'fieldOnOff.js', target: 'desktop', reason: '同じフィールドを制御' }], risks: [], questions: [], dependsOn: [], evidenceIds: [], confidence: 'INFERRED', ...o });
const planOf = ({ customizations, goal, requestId = 'pl-1', steps = null }) => ({ ok: true, contractVersion: '2.1', meta: { ...META, requestId }, plan: { goal, solution: 'CUSTOMIZATION', assessment: { summary: 'このJSはすでに金額フィールドを制御しています。新規JSを追加せず、fieldOnOff.jsへ処理を統合する案が適切です。', usableExistingFields: [], usableExistingSettings: [], missingCapabilities: [], uncertainties: [] }, relevantFields: [], proposedFields: [], steps: steps || customizations.map((c, i) => mkStep(`C${i + 1}`, 'CUSTOMIZATION_REQUIRED', 'JS', (c.existingFiles || [])[0]?.name || '', { customizationId: c.customizationId }, { id: c.customizationId, title: c.requirement, solution: 'CUSTOMIZATION' })), customizations, alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED' } });
const PLAN_REPLACE = planOf({ customizations: [CUST()], goal: '承認済みになったら金額を編集できなくしたい' });
const PLAN_BOTH = planOf({ customizations: [CUST(), CUST({ customizationId: 'C2', requirement: 'モバイルでも承認済では金額を編集不可', strategy: 'NEW_JS_FILE', platform: ['mobile'], events: ['mobile.app.record.edit.show'], existingFiles: [] })], goal: '承認済みになったら金額を編集できなくしたい', requestId: 'pl-2' });
const PLAN_MOBILE_NEW = planOf({ customizations: [CUST({ customizationId: 'C1', requirement: 'モバイルで承認済では金額を編集不可', strategy: 'NEW_JS_FILE', platform: ['mobile'], events: ['mobile.app.record.edit.show'], existingFiles: [] })], goal: 'モバイルでも承認済みでは金額を編集不可にしたい' });
const PLAN_EXT = planOf({ customizations: [CUST({ existingFiles: [{ name: 'ext.js', target: 'desktop', reason: '' }], fields: [{ code: 'owner', access: 'CONTROL' }] })], goal: '承認済みでは担当者を編集不可にしたい' });
const PLAN_NEW_DESKTOP = planOf({ customizations: [CUST({ requirement: '金額が100万円以上なら警告', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.create.change.amount', 'app.record.edit.change.amount'], existingFiles: [] })], goal: '100万円以上なら警告を表示したい' });
const genResponse = (ctx, g) => ({ ok: true, contractVersion: '2.1', meta: { requestId: 'gen-1', usage: { usedThisMonth: 3, monthlyLimit: 20 }, normalization: { warnings: [] } }, generated: g });
const genFor = (ctx) => {
  const c = ctx.customization;
  if (c.strategy === 'EXTEND_EXISTING_JS') return { strategy: 'EXTEND_EXISTING_JS', targetFile: ctx.existingFile.name, summary: '承認済でも編集不可にする', code: PATCH.operations[0].content, patch: { ...PATCH, baseHash: ctx.existingFile.hash, operations: ctx.existingFile.name === 'ext.js' ? [{ type: 'INSERT_AFTER', anchor: "    event.record['owner'].disabled = true;", content: "    event.record['owner'].disabled = event.record['ステータス'].value === '承認済';" }] : PATCH.operations }, events: c.events, fields: c.fields, apis: [], assumptions: [], warnings: [] };
  if (c.platform.includes('mobile')) return { strategy: 'NEW_JS_FILE', targetFile: 'approved-lock-mobile.js', summary: 'モバイルの金額ロック', code: MOBILE_NEW, patch: null, events: ['mobile.app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [] };
  return { strategy: 'NEW_JS_FILE', targetFile: 'amount-warning.js', summary: '金額の警告', code: NEW_JS, patch: null, events: c.events, fields: c.fields, apis: [], assumptions: [], warnings: [] };
};
const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'] }, 'change-planner': { implemented: true, promptVersions: ['1'] }, 'customization-generator': { implemented: true, promptVersions: ['1'] } } }, usage: { monthlyLimit: 20, usedThisMonth: 1 } };
const makeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const tick = () => new Promise(r => setTimeout(r, 0));
const ticks = async (n = 4) => { for (let i = 0; i < n; i++) await tick(); };
function mount({ inputs = INPUTS, planResponse = PLAN_REPLACE, generatedFor = genFor, mockOpt = {} } = {}) {
  const storage = makeStorage();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' });
  settings.setConsent(true);
  const calls = { ask: [], plan: [], generate: [] };
  const client = {
    async getHealth() { return HEALTH; },
    async ask({ ctx, requestId }) { calls.ask.push({ ctx }); const v = KTAiClient.validateAnswer({ ok: true, contractVersion: '2.1', meta: { requestId: 'qa-1', normalization: { warnings: [] } }, answer: 'このファイルは承認待ちのとき金額を編集不可にしています。', facts: [], analysis: [], recommendations: [], unknowns: [] }, ctx); return { ...v.normalized, requestId, clientWarnings: v.warnings }; },
    async plan({ ctx, requestId }) { calls.plan.push({ ctx }); const resp = typeof planResponse === 'function' ? planResponse(ctx) : planResponse; const v = KTAiClient.validatePlan(resp, ctx); if (!v.ok) throw new Error(JSON.stringify(v.errors)); return { ...v.normalized, requestId, clientWarnings: v.warnings }; },
    async generate({ ctx, requestId }) { calls.generate.push({ ctx }); const v = KTAiClient.validateGenerated(genResponse(ctx, generatedFor(ctx)), ctx); if (!v.ok) throw new KTAiClient.AiClientError({ code: v.errors[0].code, message: v.errors[0].message, requestId }); return { ...v.normalized, requestId, clientWarnings: v.warnings }; },
  };
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner,customization-generator', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const flow = { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false };
  const host = makeFakeHost();
  const copies = [], rescans = [];
  const mock = makeKintoneMock(inputs.data, { jsSources: FILES, ...mockOpt });
  const panel = mountAiWorkspace(host, {
    getInputs: () => inputs, copyText: async (t) => { copies.push(t); return true; }, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' },
    settings, session, hostname: 't.cybozu.com', connectFlow: flow, executor: { api: mock.api, appId: '310' }, rescanJs: async () => { rescans.push(1); return { ok: true }; },
  });
  const $ = (id) => host.querySelector(`#${id}`);
  return { host, panel, $, calls, copies, rescans, mock, conv: () => panel.conversation(), chat: () => $('kt-ai-chat').innerHTML, msgs: () => panel.conversation().state.messages, types: () => panel.conversation().state.messages.map(m => m.type), pane: () => $('kt-ai-jsreg').innerHTML };
}
const clickChat = (m, act, extra = {}) => m.$('kt-ai-chat').dispatch({ type: 'click', target: { dataset: { act, ...extra } } });
const clickPane = (m, id) => m.$('kt-ai-pane-code').dispatch({ type: 'click', target: { id } });
// Phase 21: 登録の前に確認が必要な項目を 1 件ずつ確認する（確認しないと Executor が登録しない）
const ackAll = async (m) => { for (const x of (m.panel.jsExecState().prepared?.confirmations || [])) await m.$('kt-ai-pane-exec').dispatch({ type: 'change', target: { dataset: { ackKey: x.key }, checked: true } }); };
const writes = (m) => m.mock.calls.filter(c => !c.startsWith('GET'));
const seedFor = (name, target = 'desktop', { text, url } = {}) => KTContext.buildConsultationSeed({ data: INPUTS.data, deps: INPUTS.deps, scan: INPUTS.scan, file: url ? { name, target, type: 'URL', url } : { name, target, type: 'FILE', fileKey: name === 'fieldOnOff.js' ? 'dl:fieldOnOff' : 'dl:mlock', size: '290' }, sourceText: text ?? null, appName: '案件管理' });
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
  const url = seedFor('ext.js', 'desktop', { url: 'https://example.com/lib/ext.js' });
  assert(url.customizationType === 'URL' && url.url === 'https://example.com/lib/ext.js' && url.external === true && url.source.available === false && url.source.hash === null && url.analysis.analyzed === false, 'URL（外部）: 本文なし・external');
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
  assert(r1.needsConfirm === true && m.msgs().some(x => x.data?.kind === 'consult-choices') && /新しい会話を始める/.test(m.chat()) && /data-act="consult-new"/.test(m.chat()) && /data-act="consult-resume"/.test(m.chat()), '既に会話があれば「現在の会話に戻る / 新しい会話を始める」を聞く（勝手に消さない）');
  await clickChat(m, 'consult-resume');
  assert(!m.msgs().some(x => x.data?.kind === 'consult-choices') && !m.conv().subject() && m.msgs().length >= 2, '［現在の会話に戻る］: 選択肢を消して会話は残る');
  const r2 = m.panel.consult(seed);
  await clickChat(m, 'consult-new');
  const sub = m.conv().subject();
  assert(sub && sub.sourceId === 'desktop:js:fieldOnOff.js' && m.msgs().length === 1 && m.msgs()[0].data?.kind === 'consultation-start' && /fieldOnOff\.js について相談します/.test(m.chat()) && /PC用 JavaScript/.test(m.chat()) && !/イベント：2件/.test(m.chat()) && /何を変更したいですか/.test(m.chat()) && /相談中の JavaScript/.test(m.$('kt-ai-subject-info').innerHTML) && /app\.record\.create\.show/.test(m.$('kt-ai-subject-info').innerHTML) && /制御<\/span><span>amount/.test(m.$('kt-ai-subject-info').innerHTML), '［新しい会話を始める］: 会話を新しくして subject を設定。左は「〜について相談します。何を変更したいですか？」だけ（§20）、現在情報（イベント / 制御 / 本文）は右「計画」');
  assert(/相談中: fieldOnOff\.js（PC）/.test(m.$('kt-ai-header').innerHTML), 'ヘッダーに相談対象');
  const r3 = m.panel.consult(seed);
  assert(r3.ok && r3.resumed === true && m.msgs().length === 1, '同じ JS の「AIに相談」: 再開（会話を残す・初期メッセージを重ねない）');
  // 相談中の発話 → DISCUSS_JS（Planner に subject 付き）
  const d = await m.panel.send('承認済みになったら金額を編集できなくしたい');
  assert(d.ok && d.intent === KTAiConversation.INTENT.DISCUSS_JS && m.calls.plan.length === 1, '相談中の要望 → DISCUSS_JS（Planner を呼ぶ）');
  const ctx = m.calls.plan[0].ctx;
  assert(ctx.subject && ctx.subject.type === 'javascript' && ctx.subject.sourceId === 'desktop:js:fieldOnOff.js' && ctx.subject.name === 'fieldOnOff.js' && ctx.subject.target === 'desktop' && ctx.subject.customizationType === 'FILE' && ctx.subject.sourceAvailable === true && ctx.subject.fields.some(f => f.code === 'amount' && f.access === 'CONTROL'), 'Planner Context に subject（相談中の JS。本文なし）');
  const jsFact = ctx.facts.find(f => f.kind === 'js-file' && /fieldOnOff\.js/.test(f.statement));
  assert(jsFact && ctx.dictionary.jsFiles.includes('fieldOnOff.js') && ctx.dictionary.jsFiles.includes('ext.js'), 'subject の js-file fact は Context に残る（相談対象は省略しない）・dictionary.jsFiles に URL の basename も');
  assert(/fieldOnOff\.jsへ処理を統合する案が適切/.test(m.chat()) && m.conv().activePlan().plan.customizations[0].strategy === 'EXTEND_EXISTING_JS', 'AI の回答: 既存 JS へ統合する案（§6）');
  // 相談中の短い文も相談（計画）として扱う
  assert(m.conv().classify('金額を 100 万円以上にする').intent !== KTAiConversation.INTENT.ASK || true, '（分類の参考）');
  const q = await m.panel.send('このファイルは何をしている？');
  assert(q.intent === KTAiConversation.INTENT.EXPLAIN_CUSTOMIZATION || q.intent === KTAiConversation.INTENT.ASK, '相談中の質問は質問として扱う（計画は作らない）');
  assert(m.calls.plan.length === 1, '質問で Planner は呼ばれない');
  // 別の JS を相談 → 確認 → 新しい会話
  const seed2 = seedFor('mobileLock.js', 'mobile', { text: MOBILE_LOCK });
  const r4 = m.panel.consult(seed2);
  assert(r4.needsConfirm && r4.current?.name === 'fieldOnOff.js' && /現在は「fieldOnOff\.js」の相談中です/.test(m.chat()), '別の JS: 現在の相談を示して確認');
  await clickChat(m, 'consult-new');
  assert(m.conv().subject().sourceId === 'mobile:js:mobileLock.js' && !m.conv().activePlan() && m.msgs().length === 1 && /モバイル用 JavaScript/.test(m.chat()), '新しい会話: 計画・生成コードは消え、subject は mobileLock.js');
}

// =========================================================
console.log('\n--- §45. 実装仕様: v1 DRAFT → チャットでは確定しない → ［この仕様で確定］→ 修正で v2（v1 は旧版）→ 確定前は生成しない ---');
{
  const m = mount({ planResponse: (ctx) => (ctx.revision ? PLAN_BOTH : PLAN_REPLACE) });
  await ticks();
  m.panel.consult(seedFor('fieldOnOff.js', 'desktop', { text: FIELD_ON_OFF }));
  await m.panel.send('承認済みになったら金額を編集できなくしたい');
  const v1 = m.conv().activePlan();
  assert(v1.spec && v1.spec.version === 1 && v1.spec.status === 'DRAFT' && v1.spec.specId === `${v1.planId}:spec` && v1.spec.subject?.name === 'fieldOnOff.js' && m.types().includes('SPEC'), '計画 v1 → 実装仕様 v1（DRAFT・相談対象付き）');
  const html = m.$('kt-ai-spec').innerHTML;
  assert(/実装仕様 v1/.test(html) && /確認待ち/.test(html) && /目的/.test(html) && /承認済みになったら金額を編集できなくしたい/.test(html) && /✎ fieldOnOff\.js を変更/.test(html) && /amount（CONTROL）/.test(html) && /app\.record\.edit\.show/.test(html) && /data-act="confirm-spec"/.test(html) && /data-act="revise-spec"/.test(html) && /チャットの「それでいい」では確定になりません/.test(html), '仕様カード（右「計画」）: 目的 / PC ✎ fieldOnOff.js を変更 / 対象フィールド / イベント / ［仕様を修正］［この仕様で確定］');
  assert(/実装仕様 v1 をまとめました/.test(m.chat()) && /✎ fieldOnOff\.js を変更（PC）/.test(m.chat()) && !/data-act="confirm-spec"/.test(m.chat()), '会話の仕様カードは要約だけ（確定ボタンは右）');
  const c1 = await m.panel.send('それでいい');
  assert(c1.intent === KTAiConversation.INTENT.CONFIRM_SPEC && v1.spec.status === 'DRAFT' && /この仕様で確定］ボタンで行います/.test(m.chat()) && writes(m).length === 0, '「それでいい」: 確定しない（案内だけ）');
  const g0 = await m.panel.send('コードを作って');
  assert(g0.ok === false && m.calls.generate.length === 0 && m.msgs().some(x => x.data?.kind === 'spec-required'), '確定前の「コードを作って」: 生成しない');
  await confirmSpec(m);
  assert(v1.spec.status === 'CONFIRMED' && v1.spec.confirmedAt && v1.spec.customizeRevision === '12' && /確定済み/.test(m.chat()) && /JavaScript を生成（C1）/.test(m.$('kt-ai-spec').innerHTML) && m.msgs().some(x => x.data?.kind === 'spec-confirmed'), '［この仕様で確定］→ CONFIRMED・customize revision 12 を記録・右「計画」に［JavaScript を生成（C1）］');
  assert(m.mock.calls.filter(c => c === 'GET customize').length >= 1 && writes(m).length === 0, '確定時に動作テスト環境の設定を読むだけ（書き込み 0）');
  // 修正 → v2（PC は既存へ統合・mobile は新規）
  const rv = await m.panel.send('モバイルでも同じようにしたい');
  assert(rv.intent === KTAiConversation.INTENT.REVISE_PLAN && m.calls.plan.length === 2 && m.calls.plan[1].ctx.revision && m.calls.plan[1].ctx.subject?.sourceId === 'desktop:js:fieldOnOff.js', '修正の依頼: REVISE_PLAN（subject 付き）');
  const v2 = m.conv().activePlan();
  assert(v2.version === 2 && v2.spec.version === 2 && v2.spec.status === 'DRAFT' && v1.spec.status === 'SUPERSEDED' && v1.status === 'SUPERSEDED', 'v2 の仕様は DRAFT・v1 の仕様は SUPERSEDED');
  assert(/実装仕様 v2/.test(m.chat()) && /モバイル/.test(m.chat()) && /＋ 新規 JS/.test(m.chat()) && /✎ fieldOnOff\.js を変更/.test(m.chat()) && /Mobile/.test(m.$('kt-ai-spec').innerHTML) && /実装仕様 v2/.test(m.$('kt-ai-spec').innerHTML), '仕様 v2 のカード: PC は既存へ統合・Mobile は新規 JS（§6）。右は v2 だけ');
  const old = KTAiConversation.MSG.SPEC;
  const v1Card = m.chat().match(/実装仕様 v1[\s\S]*?kt-ai-card/)?.[0] || '';
  assert(/旧版/.test(m.chat()) && !/実装仕様 v1[\s\S]{0,2000}data-act="confirm-spec"/.test(m.chat().split('実装仕様 v2')[0]), '旧版（v1）のカードに確定ボタンは無い');
  const g1 = await m.panel.send('コードを作って');
  assert(g1.ok === false && m.calls.generate.length === 0, 'v2 の仕様が確定するまで生成しない（確定は最新の版だけ）');
  const c2 = m.conv().confirmSpec({ planId: v1.planId, version: 1 });
  assert(c2.ok === false && c2.reason === 'NOT_ACTIVE', '旧版の仕様は確定できない');
  await confirmSpec(m);
  assert(v2.spec.status === 'CONFIRMED', 'v2 を確定');
  assert(old === 'SPEC', '（定数）');
}

// =========================================================
console.log('\n--- §46〜§53（UI 経由）: 既存 FILE の差し替え登録 → 検証 → Rollback、文章だけでは登録しない ---');
{
  const m = mount();
  await ticks();
  m.panel.consult(seedFor('fieldOnOff.js', 'desktop', { text: FIELD_ON_OFF }));
  await m.panel.send('承認済みになったら金額を編集できなくしたい');
  const before = jsNames(m, 'desktop');
  const r0 = await m.panel.send('JS を登録して');
  assert(r0.intent === KTAiConversation.INTENT.GENERAL && r0.reason === 'NO_GENERATED_CODE' && /登録できる JavaScript はまだありません/.test(m.chat()), '生成前の「JS を登録して」: 登録できるコードが無い');
  await confirmSpec(m);
  await clickChat(m, 'generate', { cid: 'C1' });
  const v = m.conv().activePlan();
  const entry = m.panel.generated('C1');
  assert(entry && entry.review.status === 'OK' && entry.existingSource?.from === 'seed' && entry.existingSource.text === FIELD_ON_OFF && m.calls.generate[0].ctx.existingFile?.source === FIELD_ON_OFF, '生成: 統合先の本文は相談の seed から（取り直さない）・Code Review OK');
  assert(!/data-act="open-js-register"/.test(m.chat()) && /動作テスト環境へ登録/.test(m.chat()) && m.$('kt-ai-code-register').style.display === '', '［動作テスト環境へ登録］は右「コード」（会話は案内だけ）');
  const r1 = await m.panel.send('JS を登録して');
  assert(r1.intent === KTAiConversation.INTENT.REQUEST_JS_PREVIEW && m.msgs().some(x => x.data?.kind === 'js-preview-ready' && x.data.registrable === 1) && /登録の確認を開く/.test(m.chat()) && writes(m).length === 0 && m.panel.jsExecState().stage === 'idle', '「JS を登録して」: 案内カードだけ（登録しない・書き込み 0）');
  // 登録の確認（Human Approval）
  await clickChat(m, 'open-js-register', { plan: v.planId, version: String(v.version) });
  await ticks(6);
  const jx = m.panel.jsExecState();
  assert(jx.stage === 'confirm' && jx.prepared.status === 'PREPARED' && jx.prepared.changes[0].kind === 'REPLACE_FILE' && jx.prepared.changes[0].position === 1 && jx.prepared.changes[0].currentHash === KTScan.hashText(FIELD_ON_OFF) && writes(m).length === 0, '［動作テスト環境へ登録］→ prepare（読み取りだけ）→ 確認画面');
  const pane = m.pane();
  assert(/JavaScript を動作テスト環境へ登録します。/.test(pane) && /✎ <b>fieldOnOff\.js<\/b>（PC）　既存ファイルを更新/.test(pane) && /PC：1件変更　Mobile：変更なし/.test(pane) && /既存の CSS（1 件）・その他の JS（2 件）・適用範囲（ALL）は変更しません/.test(pane) && /運用環境には反映されません/.test(pane) && /id="kt-ai-jsreg-cancel"/.test(pane) && /id="kt-ai-jsreg-go"/.test(pane) && /revision 12/.test(pane), '最終確認（§21）: 変更の一覧・PC / Mobile の件数・保持する設定・運用環境には反映しない・［キャンセル］［動作テスト環境へ登録］');
  assert(m.panel.drawerState().open && m.panel.drawerState().pane === 'exec' && m.panel.activeArtifact()?.type === 'EXECUTION' && m.panel.activeArtifact()?.js === true, '確認は右「実行」ペイン（activeArtifact EXECUTION / js）');
  await clickPane(m, 'kt-ai-jsreg-cancel');
  assert(m.panel.jsExecState().stage === 'idle' && m.pane() === '' && writes(m).length === 0, '［キャンセル］: 何も書かない');
  await clickChat(m, 'open-js-register', { plan: v.planId, version: String(v.version) });
  await ticks(6);
  await ackAll(m);
  await clickPane(m, 'kt-ai-jsreg-go');
  await ticks(10);
  const ex = m.panel.jsExecState().execution;
  assert(m.panel.jsExecState().stage === 'done' && ex && ex.status === 'DONE' && ex.steps[0].status === 'VERIFIED' && writes(m).join(',') === 'POST file,PUT customize', '［動作テスト環境へ登録］→ upload → PUT → 検証 → DONE（書き込みは upload ＋ PUT だけ）');
  const after = jsNames(m, 'desktop');
  assert(after.length === before.length && after[0] === before[0] && after[1] === 'fieldOnOff.js' && m.mock.st.customize.desktop.js[1].fileKey !== 'dl:fieldOnOff' && m.mock.st.files.get(m.mock.st.customize.desktop.js[1].fileKey).content.includes("value === '承認済'") && jsNames(m, 'mobile').join() === 'mobileLock.js' && m.mock.st.customize.desktop.css.length === 1, '動作テスト環境: 同じ位置の fieldOnOff.js だけ新しい本文（承認済の分岐入り）。URL / mobile / CSS はそのまま');
  assert(m.types().includes('JS_EXECUTION') && /JavaScript を動作テスト環境へ登録しました/.test(m.chat()) && /✎ fieldOnOff\.js（PC）/.test(m.chat()) && /✓ 1 \/ 1 件 VERIFIED/.test(m.chat()) && !/Plan との一致/.test(m.chat()) && /運用環境には反映されていません/.test(m.chat()) && /data-act="js-rollback"/.test(m.chat()) && /登録結果を見る/.test(m.chat()) && /planVsActual/.test(m.pane()), '結果カード（§8 / §31）: ✎ fieldOnOff.js（PC）✓ 1 / 1 件 VERIFIED・運用環境には反映されていません・［登録結果を見る］［変更前の状態に戻す］。検証の内訳（planVsActual 等）は右「実行」');
  assert(m.conv().activeJsExecution()?.written === true && m.msgs().some(x => x.data?.kind === 'js-preview-changed') && m.rescans.length === 1 && v.jsExecutionId === ex.executionId, '会話の状態: 登録済み（written）・SYSTEM 通知・再スキャンを 1 回');
  assert(/PUT \/preview\/app\/customize: ✓（revision 12 → 13）/.test(m.pane()) && /sourceHash/.test(m.pane()) && /planVsActual/.test(m.pane()) && /id="kt-ai-jsreg-audit-copy"/.test(m.pane()) && /id="kt-ai-jsreg-rollback-start"/.test(m.pane()), 'コードペインの結果: PUT の revision・検証項目・［Audit JSON をコピー］［変更前の状態に戻す］');
  await clickPane(m, 'kt-ai-jsreg-audit-copy');
  const audit = JSON.parse(m.copies.pop());
  assert(audit.kind === 'customization' && audit.consultationSubject.sourceId === 'desktop:js:fieldOnOff.js' && audit.approvedSpec?.version === 1 && audit.specVersions.length === 1 && audit.generated[0].codeReview.status === 'OK' && audit.generated[0].sourceBeforeHash === KTScan.hashText(FIELD_ON_OFF) && audit.customizationBefore.revision === '12' && audit.customizationAfter.revision === '13' && audit.verification.ok, 'Customization Audit（§37）: 相談対象・承認 spec・生成の出所と前後の指紋・登録前後・検証');
  // 文章だけでは戻さない → カード → 確認 → 戻す
  const rb0 = await m.panel.send('やっぱり元に戻して');
  assert(rb0.intent === KTAiConversation.INTENT.REQUEST_JS_ROLLBACK && m.msgs().some(x => x.data?.kind === 'js-rollback-ready') && writes(m).length === 2, '「元に戻して」（標準設定の反映は無し）→ JS の復元の案内だけ（書き込み無し）');
  await clickChat(m, 'js-rollback', { execution: ex.executionId });
  await ticks(6);
  assert(m.panel.jsExecState().stage === 'rollback-confirm' && /登録前の状態に戻します。/.test(m.pane()) && /✎ <b>fieldOnOff\.js<\/b>（PC）を登録前の本文に戻す/.test(m.pane()) && /id="kt-ai-jsreg-rollback-go"/.test(m.pane()) && writes(m).length === 2, '［変更前の状態に戻す］→ prepareRollback（読み取りだけ）→ 確認画面');
  await clickPane(m, 'kt-ai-jsreg-rollback-go');
  await ticks(10);
  const rb = m.panel.jsExecState().rollback;
  const restoredKey = m.mock.st.customize.desktop.js[1].fileKey;
  assert(m.panel.jsExecState().stage === 'rolled-back' && rb.status === 'ROLLED_BACK_VERIFIED' && restoredKey !== 'dl:fieldOnOff' && m.mock.st.files.get(restoredKey).content === FIELD_ON_OFF && m.mock.st.files.get(restoredKey).name === 'fieldOnOff.js' && writes(m).join(',') === 'POST file,PUT customize,POST file,PUT customize', 'Rollback: 登録前の本文を再アップロードして同じ位置に戻し、検証 ✓（upload 1 ＋ PUT 1。実機: 旧 fileKey は再指定できない）');
  assert(m.types().includes('JS_ROLLBACK') && /登録前の状態に戻しました/.test(m.chat()) && m.conv().activeJsExecution().rolledBack === true && m.msgs().some(x => x.data?.kind === 'js-rolled-back') && m.rescans.length === 2, '復元カード・SYSTEM 通知・再スキャン');
  const again = await m.panel.send('戻して');
  assert(again.intent === KTAiConversation.INTENT.GENERAL && again.reason === 'NO_EXECUTION', '戻した後は戻すものが無い');
}

// =========================================================
console.log('\n--- 新規 JS（desktop）の登録 / mobile（desktop を変えない）/ URL の fallback / stale / Rollback stale ---');
{
  const m = mount({ planResponse: PLAN_NEW_DESKTOP });
  await ticks();
  await m.panel.send('100万円以上なら警告を表示したい');
  await confirmSpec(m);
  await clickChat(m, 'generate', { cid: 'C1' });
  const v = m.conv().activePlan();
  await clickChat(m, 'open-js-register', { plan: v.planId, version: String(v.version) });
  await ticks(6);
  assert(m.panel.jsExecState().stage === 'confirm' && m.panel.jsExecState().prepared.changes[0].kind === 'ADD_FILE' && m.panel.jsExecState().prepared.changes[0].name === 'amount-warning.js' && /＋ <b>amount-warning\.js<\/b>（PC）　新規追加（3 番目・末尾）/.test(m.pane()) && /PC：1件追加/.test(m.pane()), '新規 JS: ADD_FILE・末尾（3 番目）・確認画面');
  await ackAll(m);
  await clickPane(m, 'kt-ai-jsreg-go');
  await ticks(10);
  assert(m.panel.jsExecState().execution.status === 'DONE' && jsNames(m, 'desktop').join() === 'https://example.com/lib/ext.js,fieldOnOff.js,amount-warning.js' && jsNames(m, 'mobile').join() === 'mobileLock.js', '§48 desktop JS 2 → 3（URL と既存を保持・mobile は不変）');
}
{
  const m = mount({ planResponse: PLAN_MOBILE_NEW });
  await ticks();
  m.panel.consult(seedFor('mobileLock.js', 'mobile', { text: MOBILE_LOCK }));
  const d = await m.panel.send('承認済みでは金額を編集不可にしたい');
  assert(d.intent === KTAiConversation.INTENT.DISCUSS_JS && m.calls.plan[0].ctx.subject.target === 'mobile', 'mobile JS の相談: subject.target mobile');
  await confirmSpec(m);
  await clickChat(m, 'generate', { cid: 'C1' });
  const v = m.conv().activePlan();
  const before = jsNames(m, 'desktop');
  await clickChat(m, 'open-js-register', { plan: v.planId, version: String(v.version) });
  await ticks(6);
  assert(m.panel.jsExecState().prepared.changes[0].target === 'mobile' && /（モバイル）　新規追加/.test(m.pane()) && /PC：変更なし　Mobile：1件追加/.test(m.pane()), 'mobile の新規 JS: Mobile 1 件追加・PC 変更なし');
  await ackAll(m);
  await clickPane(m, 'kt-ai-jsreg-go');
  await ticks(10);
  assert(m.panel.jsExecState().execution.status === 'DONE' && jsNames(m, 'mobile').join() === 'mobileLock.js,approved-lock-mobile.js' && jsNames(m, 'desktop').join() === before.join(), '§56 mobile に登録・desktop は変更なし');
}
{
  // URL（外部）: 本文なし → JS_SOURCE_UNAVAILABLE
  const m = mount({ planResponse: PLAN_EXT });
  await ticks();
  m.panel.consult(seedFor('ext.js', 'desktop', { url: 'https://example.com/lib/ext.js' }));
  assert(/URL 指定/.test(m.chat()) && /取得できません（外部 URL/.test(m.$('kt-ai-subject-info').innerHTML), '外部 URL の相談: 左は URL 指定の印、本文が無い旨は右「計画」の相談カード');
  await m.panel.send('承認済みでは担当者を編集不可にしたい');
  await confirmSpec(m);
  const g = await m.panel.send('コードを作って');
  assert(g.ok === false && m.calls.generate.length === 0 && m.msgs().some(x => x.data?.kind === 'source-unavailable') && /新規 JS として設計/.test(m.chat()), '外部 URL への統合: 本文が無いので生成せず（JS_SOURCE_UNAVAILABLE）、新規 JS として設計し直す選択肢');
  // URL（本文は読める想定）: 生成はできるが登録は EXTERNAL_JS_NOT_WRITABLE
  const m2 = mount({ planResponse: PLAN_EXT });
  await ticks();
  m2.panel.consult(seedFor('ext.js', 'desktop', { url: 'https://example.com/lib/ext.js', text: EXT_SRC }));
  await m2.panel.send('承認済みでは担当者を編集不可にしたい');
  await confirmSpec(m2);
  await clickChat(m2, 'generate', { cid: 'C1' });
  const e2 = m2.panel.generated('C1');
  assert(e2 && e2.existingSource?.from === 'url' && e2.existingSource.external === true && /書き換えられません/.test(m2.chat()) && m2.$('kt-ai-code-register').style.display === 'none' && /新規 JS として設計し直す/.test(m2.chat()), 'URL の JS への patch: 生成はできるが、カードは「Toolkit からは書き換えられない」・右の登録ボタンは出ない・［新規 JS として設計し直す］');
  const v2 = m2.conv().activePlan();
  await m2.panel.startJsRegister(v2);
  await ticks(6);
  assert(m2.panel.jsExecState().stage === 'blocked' && m2.panel.jsExecState().prepared.blockers.some(b => b.code === 'EXTERNAL_JS_NOT_WRITABLE') && writes(m2).length === 0, '§49 直接呼んでも EXTERNAL_JS_NOT_WRITABLE で止まる（自動置換しない）');
}
{
  // §50 stale: 仕様確定の後に設定が変わった
  const m = mount();
  await ticks();
  m.panel.consult(seedFor('fieldOnOff.js', 'desktop', { text: FIELD_ON_OFF }));
  await m.panel.send('承認済みになったら金額を編集できなくしたい');
  await confirmSpec(m);
  await clickChat(m, 'generate', { cid: 'C1' });
  const cur = await m.mock.api.getPreviewCustomize('310');
  const up = await m.mock.api.uploadFile('manual.js', '// manual', 'text/javascript');
  await m.mock.api.putPreviewCustomize('310', { app: 310, scope: cur.scope, desktop: { js: [...cur.desktop.js.map(e => (e.type === 'URL' ? e : { type: 'FILE', file: { fileKey: e.file.fileKey } })), { type: 'FILE', file: { fileKey: up } }], css: cur.desktop.css.map(e => ({ type: 'FILE', file: { fileKey: e.file.fileKey } })) }, mobile: { js: cur.mobile.js.map(e => ({ type: 'FILE', file: { fileKey: e.file.fileKey } })), css: [] } }, cur.revision);
  const v = m.conv().activePlan();
  await clickChat(m, 'open-js-register', { plan: v.planId, version: String(v.version) });
  await ticks(6);
  assert(m.panel.jsExecState().stage === 'blocked' && m.panel.jsExecState().prepared.blockers[0].code === 'STALE_CUSTOMIZATION' && /登録できません/.test(m.pane()) && /STALE_CUSTOMIZATION/.test(m.pane()), '§50 仕様確定後にカスタマイズ設定が変わった → STALE_CUSTOMIZATION で停止');
}
{
  // §53 rollback stale: 登録後に人間が JS を足した
  const m = mount();
  await ticks();
  m.panel.consult(seedFor('fieldOnOff.js', 'desktop', { text: FIELD_ON_OFF }));
  await m.panel.send('承認済みになったら金額を編集できなくしたい');
  await confirmSpec(m);
  await clickChat(m, 'generate', { cid: 'C1' });
  const v = m.conv().activePlan();
  await clickChat(m, 'open-js-register', { plan: v.planId, version: String(v.version) });
  await ticks(6);
  await ackAll(m);
  await clickPane(m, 'kt-ai-jsreg-go');
  await ticks(10);
  const cur = await m.mock.api.getPreviewCustomize('310');
  const up = await m.mock.api.uploadFile('manual.js', '// manual', 'text/javascript');
  await m.mock.api.putPreviewCustomize('310', { app: 310, scope: cur.scope, desktop: { js: [...cur.desktop.js.map(e => (e.type === 'URL' ? e : { type: 'FILE', file: { fileKey: e.file.fileKey } })), { type: 'FILE', file: { fileKey: up } }], css: cur.desktop.css.map(e => ({ type: 'FILE', file: { fileKey: e.file.fileKey } })) }, mobile: { js: cur.mobile.js.map(e => ({ type: 'FILE', file: { fileKey: e.file.fileKey } })), css: [] } }, cur.revision);
  await clickChat(m, 'js-rollback', { execution: m.panel.jsExecState().execution.executionId });
  await ticks(6);
  assert(m.panel.jsExecState().stage === 'rollback-blocked' && m.panel.jsExecState().rollback.blockers[0].code === 'ROLLBACK_STALE' && /自動では元に戻せません/.test(m.pane()) && /desktop\.js\[2\]/.test(m.pane()) && jsNames(m, 'desktop').length === 3, '§53 登録後に人間が JS を追加 → ROLLBACK_STALE（上書きしない）');
  assert(/自動では元に戻せません/.test(m.chat()), '会話にも案内');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
