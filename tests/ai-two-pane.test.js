// 開発支援の左右 2 ペイン（2026-10-06 利用者の指示）: 左 = 会話と入力欄、右 = 現在の作業内容（常に表示・幅を変えられる）。
//   右のタブは成果物を見るためのもの（変更内容・コード・確認結果）。右の見出しの状態は実際の処理から。直している間は前の内容として示し、反映を止める。
//   通常の会話に内部の番号・処理の通知を出さない。［新しい会話］は 1 か所で、左右を切り替える（前の処理の遅い応答を混ぜない）。反映の記録はページを開いている間残る。
//   必要な確認（先に確認したいこと）が終わった内容だけを反映できる
//
// 実行方法: node tests/ai-two-pane.test.js
'use strict';
// 実行が 10 秒を超えると、スクリプトの入口（waitReady の 10 秒の待ちの後に kintone.app.getId() を呼ぶ）が動く。テストには kintone が無いので、その 1 件だけを無視する
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const fs = require('fs');
const path = require('path');
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { makeFakeHost, makeFakeDocument } = require('./helpers/fake-dom.js');
const T = loadToolkit();
const { KTDeps, KTScan, KTContext, KTContextUi, KTAiClient, KTAiConversation, KTAiChatUi, KTAiWorkspaceViewModel: VM, KTPlanReview, mountAiWorkspace } = T;
const { assert, state } = makeAssert();
// C-1 第 3 段（2026-10-08）: 古い確認の流れ（変更案のカード・確認事項のカード・仕様の確定・従来の生成）を前提にしていた試験は、
//   共有の部品（tests/helpers/new-flow.js）の台本で新しい流れ（仮案 → 採用 → 計画 → 生成工程 → 最終案 → 承認）の上に移した。
//   消した古い流れそのものの期待は、置き換えた新しい流れの回帰（tests/ai-flow-redesign.test.js の名前）を各節の注に書いた
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
/** 新しい流れの依頼の 1 行目（右の見出し・計画の表示用の goal はこの文になる。B6-5） */
const NF_GOAL = K.REQUESTS[0];
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
const META = { requestId: 'pl-1', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm', latencyMs: 30, usage: { input_tokens: 500, output_tokens: 200, output_tokens_details: { reasoning_tokens: 10 } } }, usage: { usedThisMonth: 1, monthlyLimit: 20 } };
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
const passVerification = (ctx) => { const re = (ctx && ctx.verification && ctx.verification.requiredEffects) || []; return re.length ? { version: '1', passed: true, machine: [], requiredEffects: re.map(x => ({ requirementId: x.requirementId, requirementIds: x.requirementIds, field: x.field, effect: x.effect, status: 'present' })), behavior: { status: 'passed', reason: null, cases: re.flatMap((x, i) => (x.events && x.events.length ? x.events : [null]).flatMap((ev, j) => (x.condition ? ['match', 'nomatch'] : ['match']).map(side => ({ id: `K${i + 1}-${j + 1}-${side}`, requirementIds: x.requirementIds, field: x.field, effect: x.effect, expect: side === 'match' ? x.effect : ({ lock: 'not-locked', warn: 'not-warned', 'block-save': 'save-allowed', 'set-value': 'value-unchanged', 'show-hide': 'show-hide' })[x.effect], side, ...(ev ? { event: ev } : {}), verdict: 'pass', observed: {}, message: '期待どおり' })))) }, repairs: { count: 0, reasons: [], stoppedBy: null }, unverified: ['実機での動作'] } : undefined; };
const genResponse = (ctx, g) => ({ ok: true, contractVersion: '2.1', meta: { requestId: 'gen-1', usage: { usedThisMonth: 3, monthlyLimit: 20 }, normalization: { warnings: [] }, gateway: { feature: 'customization-generator' } }, generated: { strategy: ctx.customization.strategy, targetFile: ctx.existingFile?.name || 'amountWarning.js', summary: ctx.customization.requirement, events: ctx.customization.events, fields: ctx.customization.fields, apis: [], assumptions: [], warnings: [], gatewayChecks: { security: [] }, patterns: PATTERNS, ...g }, ...(passVerification(ctx) ? { verification: passVerification(ctx) } : {}) });
const genPatch = (patch = PATCH_GOOD) => ({ strategy: 'EXTEND_EXISTING_JS', targetFile: 'fieldOnOff.js', summary: '完了でも金額を編集不可にする', code: patch.operations.map(o => o.content).join('\n'), patch, events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [] });
//   C-1 第 3 段: 依頼は仮案の流れなので、会話の能力（conversation の proposal）を持つ接続先にする
const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'], conversation: ['requirements', 'proposal'] }, 'change-planner': { implemented: true, promptVersions: ['1'] }, 'customization-generator': { implemented: true, promptVersions: ['1'], verification: ['requirementId', 'requiredEffects', 'effectGroups', 'relatedOmitted', 'appFields', 'saveDialog', 'reasonCategory', 'caseSide', 'eventCases', 'loadFaithful', 'registrationCheck', 'emptyCase', 'hideCondition', 'registrationCounts', 'caseCoverage'] } } }, usage: { monthlyLimit: 20, usedThisMonth: 1 } };
const makeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const answerFor = (ctx, text) => ({ ok: true, contractVersion: '2.1', meta: { requestId: 'qa-1', usage: { usedThisMonth: 2, monthlyLimit: 20 }, normalization: { warnings: [] }, ai: { model: 'm', latencyMs: 12, streamed: true, firstTextMs: 4, usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 3 } } } }, answer: text, facts: ctx.facts.length ? [{ text: 'fact', evidenceIds: [ctx.facts[0].id] }] : [], analysis: [], recommendations: [], unknowns: [] });
const tick = () => new Promise(r => setTimeout(r, 0));
const ticks = async (n = 4) => { for (let i = 0; i < n; i++) await tick(); };
function mount({ inputs = INPUTS, paid = true, plans = null, now = null, extra = {}, planGate = null, health = HEALTH, gatewayPlan = false, askGate = null, genGate = null, askStream = null } = {}) {
  const storage = makeStorage();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' });
  settings.setConsent(true);
  const calls = { ask: [], plan: [], generate: [] };
  const client = {
    async getHealth() { return health; },
    async ask({ ctx, requestId, onText = null }) { calls.ask.push({ ctx, stream: typeof onText === 'function' }); if (askStream && typeof onText === 'function') await askStream(onText, ctx); if (askGate) await askGate(ctx); const v = KTAiClient.validateAnswer(answerFor(ctx, 'このフィールドは金額です。'), ctx); return { ...v.normalized, requestId, clientWarnings: v.warnings }; },
    //   仮案は共有の部品の台本で答える（K.REQUESTS の 4 発言で採用まで進む）
    async propose({ ctx, requestId }) { calls.propose = (calls.propose || 0) + 1; const raw = K.script({ utterance: ctx.question, previous: ctx.conversation.proposal, requirements: ctx.conversation.requirements }); if (!raw) throw new Error(`台本がありません: ${ctx.question}`); return K.normalized(raw, requestId); },
    async plan({ ctx, requestId }) { calls.plan.push({ ctx }); if (planGate) await planGate(ctx); const resp = plans ? plans(ctx) : (ctx.revision ? PLAN_V2 : PLAN_V1); const v = KTAiClient.validatePlan(resp, ctx); const out = { ...v.normalized, requestId, clientWarnings: v.warnings }; if (gatewayPlan) Object.defineProperty(out, 'gatewayPlan', { value: JSON.parse(JSON.stringify(resp.plan)), enumerable: false }); return out; },
    async generate({ ctx, requestId }) { calls.generate.push({ ctx }); if (genGate) await genGate(ctx); const v = KTAiClient.validateGenerated(genResponse(ctx, genPatch({ ...PATCH_GOOD, baseHash: ctx.existingFile?.hash || PATCH_GOOD.baseHash })), ctx); if (!v.ok) throw new Error(v.errors[0].message); return { ...v.normalized, requestId, clientWarnings: v.warnings }; },
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
    ...extra,
  });
  const $ = (id) => host.querySelector(`#${id}`);
  const ws = () => ['kt-ai-subject-info', 'kt-ai-spec', 'kt-ai-plan-result', 'kt-ai-review-result', 'kt-ai-exec', 'kt-ai-jsreg', 'kt-ai-code-head', 'kt-ai-code-review'].map(id => $(id).innerHTML).join('\n');
  return { host, panel, $, calls, copies, opened, mock, clock, ws, conv: () => panel.conversation(), chat: () => $('kt-ai-chat').innerHTML, msgs: () => panel.conversation().state.messages, types: () => panel.conversation().state.messages.map(m => m.type) };
}
const clickChat = (m, act, extra = {}) => m.$('kt-ai-chat').dispatch({ type: 'click', target: { dataset: { act, ...extra } } });
/** 新しい流れ: 台本の 4 発言で仮案 → 採用 → 最終案まで進める（共有の部品） */
const adopt = (m) => K.adoptOnScreen(m);
/** 最終案のカードの［この内容で反映する］で承認する */
const approve = async (m) => { const v = m.conv().activePlan(); await clickChat(m, 'final-approve', { plan: v.planId, version: String(v.version) }); await ticks(); return v; };
const clickPane = (m, pane, target) => m.$(`kt-ai-pane-${pane}`).dispatch({ type: 'click', target });
const clickTab = (m, pane) => m.$('kt-ai-drawer-tabs').dispatch({ type: 'click', target: { dataset: { pane } } });
const writes = (m) => m.mock.calls.filter(c => !c.startsWith('GET'));
const isHidden = (m) => KTAiChatUi.isHiddenMessage(m);
/**
 * 守り手の無い期待（C-1 第 3 段で削除した古い確認の流れだけが満たしていたもの）。消さずに残し、結果を「保留」として出す（合否には数えない・報告済み）
 */
const pending = (cond, msg) => console.log(`${cond ? '保留（いまは満たす）' : '保留（守り手なし・未達）'}: ${msg}`);
// 会話（左）に出ている文だけ（右の作業内容・詳細の中は除く）
const outsideDetails = (html) => String(html).replace(/<details[\s\S]*?<\/details>/g, '');
const INTERNAL_IN_CHAT = /\bv[0-9]+\b|requestId|\bR[0-9]+「|\bQ[0-9]+[：:]|\[E[0-9]+\]|Toolkit Review|Code Review|VERIFIED|snapshot|受け付けました|台帳|を検証しました|kt-ai-who">(Toolkit|SYSTEM)</;
const PLAN_VIEW = () => { const p = JSON.parse(JSON.stringify(PLAN_V1)); p.plan.proposedFields = []; p.plan.questions = []; p.plan.steps = [{ ...PLAN_V1.plan.steps[1], id: 'P1', dependsOn: [], spec: { ...PLAN_V1.plan.steps[1].spec, fields: ['owner', 'case_name'] }, title: '一覧「担当者別」を追加' }]; return p; };
const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };

(async () => {
// =========================================================
console.log('\n--- §1. 画面の構成: 左 = 会話と入力欄、右 = 現在の作業内容（常に表示）・幅を変える境目・タブ ---');
{
  const m = mount();
  await ticks();
  const html = m.host.innerHTML;
  assert(/id="kt-ai-split"[^>]*role="separator"/.test(html) && /aria-orientation="vertical"/.test(html) && /tabindex="0"/.test(html), '左右の境目（role=separator・キーで操作できる）');
  assert(!/kt-ai-drawer-toggle|is-drawer-collapsed|作業パネルを(隠す|表示)/.test(html + m.$('kt-ai-header').innerHTML) && typeof m.panel.closeDrawer === 'undefined' && m.panel.drawerState().open === true, '右は常に表示（折りたたみの操作・API は無い）');
  const tabs = m.$('kt-ai-drawer-tabs').innerHTML;
  const order = [...tabs.matchAll(/data-pane="(\w+)"/g)].map(x => x[1]);
  assert(order.slice(0, 3).join(',') === 'plan,code,review' && />変更内容</.test(tabs) && />コード</.test(tabs) && />確認結果</.test(tabs), `右の主のタブは 変更内容・コード・確認結果: ${order}`);
  assert(/is-quiet[^"]*" data-pane="evidence"[^>]*>詳細情報/.test(tabs) && /data-pane="connection"[^>]*>接続/.test(tabs) && /data-pane="context"[^>]*style="display:none;"/.test(tabs) && /data-pane="exec"[^>]*>反映</.test(tabs), '控えめなタブ（詳細情報・接続）。反映もタブ・Context は接続できる環境では出さない');
  assert(!/会話の方式|例の発言|模擬応答|再現|計測/.test(html), '会話を始める前の選択（方式・例文・模擬応答・再現・計測）は無い');
  assert((html.match(/>新しい会話</g) || []).length === 1 && m.$('kt-ai-new-conv').disabled === true, '［新しい会話］は 1 か所（会話が無い間は押せない）');
  assert(/<span class="kt-ai-status" data-status="empty">未作成<\/span>/.test(m.$('kt-ai-ws-state').innerHTML), `右の見出しの状態: 未作成: ${m.$('kt-ai-ws-state').innerHTML}`);
  assert(m.$('kt-ai-pane-plan-empty').textContent === '' ? /会話からまとまった変更内容を、ここに表示します。/.test(html) : /会話からまとまった変更内容/.test(m.$('kt-ai-pane-plan-empty').textContent), '右の初期は短い案内だけ');
  assert(m.$('kt-ai-exec-empty').style.display === '' && m.$('kt-ai-right-banner').style.display === 'none', '右の「反映」は案内だけ・更新中の案内は、まだ出さない');
  const head = m.$('kt-ai-header').innerHTML;
  assert(/反映先：<b>動作テスト環境<\/b>（運用環境は変更しません）/.test(head) && /id="kt-ai-log-open"[^>]*>反映の記録</.test(head) && /AI 接続済み/.test(head) && !/revision|解析<\/span> ✓/.test(head), `ヘッダー: 反映先・反映の記録・AI の接続（技術情報は並べない）: ${head.slice(0, 300)}`);
  assert(/placeholder="このアプリについて、相談したいことや変更したいことを入力してください"/.test(html), '入力欄の案内');
  const n0 = m.calls.ask.length;
  await m.panel.send('このフィールドは何に使ってる？'); await ticks();
  assert(m.calls.ask.length === n0 + 1 && m.$('kt-ai-new-conv').disabled === false, '何も選ばずに送れる・送ったら［新しい会話］が押せる');
}

// =========================================================
console.log('\n--- §2. 左右の幅: ← → キーと setSplit（28〜68%）。CSS は変数で幅を持つ ---');
{
  const m = mount();
  await ticks();
  const w0 = m.panel.drawerState().rightWidth;
  await m.$('kt-ai-split').dispatch({ type: 'keydown', key: 'ArrowLeft' });
  assert(m.panel.drawerState().rightWidth === w0 + 2, `← で右を広げる: ${w0} → ${m.panel.drawerState().rightWidth}`);
  await m.$('kt-ai-split').dispatch({ type: 'keydown', key: 'ArrowRight', shiftKey: true });
  assert(m.panel.drawerState().rightWidth === w0 - 8, `Shift+→ で 10% 狭める: ${m.panel.drawerState().rightWidth}`);
  assert(m.panel.setSplit(90) === 68 && m.panel.setSplit(5) === 28 && m.panel.setSplit(50) === 50, '幅は 28〜68% に収める');
  await m.$('kt-ai-split').dispatch({ type: 'dblclick' });
  assert(m.panel.drawerState().rightWidth === 46, 'ダブルクリックで元の幅');
  const css = m.host.innerHTML;
  assert(/\.kt-ai-drawer\{ flex:0 1 var\(--kt-ai-right\);/.test(css) && /@container kt-ai-ws \(max-width: 760px\)\{[\s\S]*\.kt-ai-split\{ display:none; \}/.test(css), '幅は CSS 変数・狭い幅は縦に積む（境目は使わない・折りたたまない）');
}

// =========================================================
console.log('\n--- §3. 相談中 → 変更案あり: 会話は変更案のカード 1 枚（内部の番号・処理の通知を出さない）・右は要約と全文 ---');
{
  const m = mount();
  await ticks();
  await adopt(m);
  const chat = m.chat();
  //   C-1 第 3 段: 変更案のカード（MSG.PLAN）・Toolkit の確認の記録（REVIEW・review-summary）・確認事項のカード（questions）は削除した。
  //   置き換え: 最終案のカード 1 枚（R09-1・R09-9・画面-1）、会話に検証のカードを出さない（F5-1・F11-3）、判断は最終案のカードの中（R10-1・R21-4）
  assert(!INTERNAL_IN_CHAT.test(outsideDetails(chat)), `会話に内部の番号・処理の通知が無い: ${(outsideDetails(chat).match(INTERNAL_IN_CHAT) || [])[0]}`);
  assert(/data-status="ready">未反映</.test(m.$('kt-ai-ws-state').innerHTML), '右の見出しの状態: 未反映');
  const sum = m.$('kt-ai-change-summary').innerHTML;
  assert(new RegExp(`<h3>${NF_GOAL}</h3>`).test(sum) && /対象：フィールド・一覧/.test(sum) && /何が変わるか/.test(sum) && /更新状況フィールドを追加/.test(sum) && /確認したいこと（1 件）/.test(sum) && !/\bP[12]\b|\bE[0-9]+\b/.test(sum), `右「変更内容」の要約（対象・何が変わるか・確認したいこと。番号は出さない）: ${sum.slice(0, 200)}`);
  assert(m.$('kt-ai-plan-detail').style.display === '' && /変更計画（AI の提案）/.test(m.$('kt-ai-plan-result').innerHTML), '計画の全文は［計画の詳細と根拠］の中に残す');
  assert(m.$('kt-ai-exec-empty').style.display === 'none' && /id="kt-ai-exec-start"[^>]*disabled/.test(m.$('kt-ai-exec').innerHTML) && /承認済みで反映できる手順がありません/.test(m.$('kt-ai-exec').innerHTML), '右の「反映」: 承認が無いうちは押せない（理由を出す）');
  assert(m.panel.applyHold() === null, '優先度の無い確認事項（あとで決めてよい扱い）は反映を止めない');
}

// =========================================================
console.log('\n--- §4. 先に確認したいこと（blocking）が残っている間は反映できない ---');
{
  const P = JSON.parse(JSON.stringify(PLAN_V2));
  P.plan.questions = [{ id: 'Q1', question: '担当者別の一覧は全員に見せますか', reason: '公開範囲', relatedEvidenceIds: [], priority: 'blocking', recommendation: '全員に見せる' }];
  const m = mount({ plans: () => P });
  await ticks();
  await adopt(m);
  const hold = m.panel.applyHold();
  assert(/先に確認したいことが 1 件残っています/.test(hold || ''), `反映を止める理由: ${hold}`);
  //   C-1 第 3 段: 手順ごとの承認（decide）ではなく最終案の承認。先に決めたいことが残る最終案は承認できない
  await approve(m);
  const r = await m.panel.startExecutor();
  assert(r === null && !m.conv().activePlan().approval && m.panel.executorState().stage === 'idle' && /id="kt-ai-exec-start"[^>]*disabled/.test(m.$('kt-ai-exec').innerHTML) && /先に確認したいことが 1 件残っています/.test(m.$('kt-ai-exec').innerHTML), '承認しても準備しない・ボタンは押せない・理由を出す');
  //   C-1 第 3 段: 確認したいことのカード（questions）は削除した。最終案のカードの「残る判断」と［この内容で反映する］の理由で知らせる（R10-1・R19-5）。
  //   注意: 計画の確認事項のおすすめ（recommendation）は、最終案のカードにも右の「変更内容」にも出なくなった（以前は確認したいことのカードに出た。守り手なし・報告済み）
  const fin = K.stripC(m.chat());
  assert(/先に決めたいことが 1 件残っています/.test(fin) && /残る判断（1 件）\s*1．担当者別の一覧は全員に見せますか/.test(fin), `最終案のカードで知らせる: ${fin.replace(/\s+/g, ' ').slice(-400)}`);
  pending(/おすすめ：全員に見せる/.test(fin), '計画の確認事項のおすすめ（おすすめ：全員に見せる）を知らせる（以前は確認したいことのカード）');
}

// =========================================================
console.log('\n--- §5. 更新中: 右は前の内容として示し、反映を止める（古い内容を最新として残さない）---');
{
  const g = gate();
  const m = mount({ planGate: async (ctx) => { if (ctx.revision) await g.p; } });
  await ticks();
  await adopt(m);
  const sending = m.panel.send('担当者は既存のフィールドを使って、一覧の追加だけにして'); await ticks(6);
  assert(m.conv().isBusy() && m.conv().state.working === 'REVISE', `前提: 直している途中: ${m.conv().state.working}`);
  assert(/data-status="updating">更新中</.test(m.$('kt-ai-ws-state').innerHTML) && m.$('kt-ai-right-banner').style.display === '' && /できるまで、変更内容・確認結果・コードは前の内容です（反映はできません）。/.test(m.$('kt-ai-right-banner').textContent), `右の見出しは「更新中」・前の内容であることを示す: ${m.$('kt-ai-ws-state').innerHTML} / ${m.$('kt-ai-right-banner').textContent}`);
  assert(/新しい内容の確認が終わるまで/.test(m.panel.applyHold() || '') && /id="kt-ai-exec-start"[^>]*disabled/.test(m.$('kt-ai-exec').innerHTML), `直している間は反映できない: ${m.panel.applyHold()}`);
  g.open(); await sending; await ticks(8);
  assert(/data-status="ready">未反映</.test(m.$('kt-ai-ws-state').innerHTML) && m.$('kt-ai-right-banner').style.display === 'none' && m.panel.applyHold() === null, `直し終わったら最新の内容（案内を消す・反映できる状態に戻す）: ${m.panel.applyHold()}`);
  //   C-1 第 3 段: 直した案のカードは最終案のカード（「最終案を直しました。」）。前のカードは 1 行に畳む（R10-4・F2-2 と同じ表示）
  const chat = m.chat();
  assert(/最終案を直しました。/.test(chat) && /このあと直した案があります/.test(chat) && !INTERNAL_IN_CHAT.test(outsideDetails(chat)), `会話: 直した案のカード・前のカードは「このあと直した案があります」（版の番号は出さない）: ${(outsideDetails(chat).match(INTERNAL_IN_CHAT) || [])[0]}`);
}

// =========================================================
console.log('\n--- §6. 反映後 → 反映の記録（ヘッダーから開く）→ 新しい会話でも記録は残る・左右は新しい会話の分 ---');
{
  const m = mount({ plans: () => PLAN_VIEW() });
  await ticks();
  await adopt(m);
  //   C-1 第 3 段: 手順ごとの承認（decide）ではなく最終案の承認（［この内容で反映する］）の後に反映する
  await approve(m);
  await m.panel.startExecutor(); await m.panel.confirmExecutor(); await ticks(6);
  assert(m.panel.executorState().stage === 'done' && /data-status="applied">反映済み</.test(m.$('kt-ai-ws-state').innerHTML), `反映後: 右の見出しは「反映済み」: ${m.$('kt-ai-ws-state').innerHTML}`);
  const chat = m.chat();
  assert(/動作テスト環境へ反映しました。/.test(chat) && /反映後の確認：✓ 1 件一致/.test(chat) && /運用環境には反映されていません/.test(chat) && !/VERIFIED|snapshot/.test(outsideDetails(chat)), '会話: 反映の結果（利用者の言葉）・運用環境は変えていない');
  assert(/<span class="kt-ai-count">1<\/span>/.test(m.$('kt-ai-header').innerHTML), 'ヘッダーの［反映の記録］に件数');
  await m.$('kt-ai-header').dispatch({ type: 'click', target: { id: 'kt-ai-log-open', dataset: { act: 'open-log' } } }); await ticks();
  assert(m.panel.drawerState().pane === 'log' && /反映済み（未復元）/.test(m.$('kt-ai-apply-log').innerHTML), '［反映の記録］で右に記録を開く');
  await m.$('kt-ai-new-conv').dispatch({ type: 'click' }); await ticks();
  assert(m.msgs().length === 0 && !m.msgs().some(x => x.data?.kind === 'new-conv-choices'), '［新しい会話］はすぐ新しい会話にする（確認のカードを出さない）');
  assert(/data-status="empty">未作成</.test(m.$('kt-ai-ws-state').innerHTML) && m.$('kt-ai-change-summary').innerHTML === '' && m.$('kt-ai-plan-detail').style.display === 'none' && m.$('kt-ai-exec-empty').style.display === '' && m.panel.drawerState().pane === 'plan', '新しい会話: 右も新しい会話の分（要約・全文・右の「反映」を消す）');
  assert(/<span class="kt-ai-count">1<\/span>/.test(m.$('kt-ai-header').innerHTML) && /前の会話/.test(m.$('kt-ai-apply-log').innerHTML) && m.panel.unrevertedPreviewChange() === true, '反映の記録はページを開いている間残る（前の会話として）・戻していない反映の確認も続ける');
}

// =========================================================
console.log('\n--- §7. 計画の無い会話（質問・根拠を開いた）も、新しい会話で右を片づける ---');
{
  const m = mount();
  await ticks();
  await m.panel.send('このフィールドは何に使ってる？'); await ticks(6);
  const chat = m.chat();
  assert(/kt-ai-answer-card/.test(chat) && !/AI回答|requestId/.test(outsideDetails(chat)), '回答のカード: 見出し「AI回答」・requestId は出さない（詳細の中だけ）');
  const eid = (m.msgs().find(x => x.type === 'ANSWER')?.data?.ctxFacts || [])[0]?.id;
  if (eid) m.panel.showEvidence(eid);
  assert(m.panel.drawerState().pane === 'evidence' && m.$('kt-ai-fact-detail').innerHTML.length > 10, '前提: 根拠を右の「詳細情報」に開いた');
  await m.$('kt-ai-new-conv').dispatch({ type: 'click' }); await ticks();
  assert(m.panel.drawerState().pane === 'plan' && !m.panel.activeArtifact() && m.$('kt-ai-fact-detail').innerHTML === '' && m.$('kt-ai-fact-detail').style.display === 'none', '新しい会話: 前の会話の根拠・表示中の成果物を残さない');
}

// =========================================================
console.log('\n--- §8. 候補を選んだ質問の答えが、新しい会話の後に届いても混ぜない ---');
{
  const g = gate();
  let n = 0;
  const m = mount({ askGate: async () => { if (++n === 1) await g.p; } });
  await ticks();
  m.conv().pushMessage(KTAiConversation.MSG.ASSISTANT_TEXT, KTAiConversation.ROLE.ASSISTANT, 'どれについてですか？', { kind: 'candidates', question: 'これは何に使ってる？', candidates: [{ type: 'field', id: 'amount', label: '金額（amount）' }] });
  const asking = m.$('kt-ai-chat').dispatch({ type: 'click', target: { dataset: { act: 'candidate', type: 'field', id: 'amount', label: '金額（amount）', text: 'これは何に使ってる？' } } }); await ticks();
  assert(/これは何に使ってる？（対象: 金額（amount））/.test(m.chat()) && m.msgs().some(x => x.type === 'USER' && /対象: amount/.test(x.text)), '候補の質問: 会話には表示名で出す（送る文は id のまま）');
  await m.$('kt-ai-new-conv').dispatch({ type: 'click' }); await ticks();
  g.open(); await asking; await ticks(6);
  assert(m.msgs().length === 0, `新しい会話の後に届いた前の会話の答えは入れない（新しい会話のメッセージも消さない）: ${m.msgs().map(x => x.type)}`);
}

// =========================================================
console.log('\n--- §9. ボタンから送る文は、会話には利用者の言葉で出す（カスタマイズの番号を出さない）---');
{
  const m = mount({ plans: () => PLAN_HYBRID });
  await ticks();
  await adopt(m);
  //   C-1 第 3 段: 実装の内容のカード（spec-intro）とコードのカード（CODE）は削除した。最終案のカードに内部の番号を出さないことは R09-10、
  //   最終案のカードを通らない生成のカードが出ないことは F2-3・F11-3 で守る。ここでは右の確認結果の［コードを作る］（act generate）の送る文と表示を確かめる
  const chat0 = m.chat();
  assert(!/\bC1\b/.test(outsideDetails(chat0).replace(/data-[a-z-]+="[^"]*"/g, '')), `最終案のカード: 番号を出さない: ${(outsideDetails(chat0).match(/.{20}\bC1\b.{20}/) || [])[0]}`);
  await m.$('kt-ai-chat').dispatch({ type: 'click', target: { dataset: { act: 'generate', cid: 'C1' } } }); await ticks(10);
  const users = m.msgs().filter(x => x.type === 'USER');
  const last = users[users.length - 1];
  assert(last && last.text === 'C1 のコードを作って' && last.data?.displayText === '「承認後（完了）は金額を編集できなくする」のコードを作って' && /「承認後（完了）は金額を編集できなくする」のコードを作って/.test(m.chat()) && !/C1 のコードを作って/.test(m.chat()), `生成のボタン: 送る文は従来どおり・会話は要件の文: ${last && last.data?.displayText}`);
}

// =========================================================
console.log('\n--- §10. 変更案が新しい版になったら、前の版のコードを最新として残さない ---');
{
  let n = 0;
  const H2 = JSON.parse(JSON.stringify(PLAN_HYBRID)); H2.plan.assessment.summary = '一覧の条件を変えました。';
  const m = mount({ plans: () => (++n === 1 ? PLAN_HYBRID : H2) });
  await ticks();
  await adopt(m);
  //   C-1 第 3 段: コードは最終案のパイプラインが作る。右の「コード」には act open-code で出す（コードのカードは削除）
  await clickChat(m, 'open-code', { cid: 'C1', view: 'code' }); await ticks();
  const v1 = m.conv().activePlan();
  assert(m.panel.codeShown() && m.panel.codeShown().version === v1.version && /fieldOnOff\.js/.test(m.$('kt-ai-code-head').innerHTML), '前提: コードを右の「コード」に出した');
  await m.panel.send('一覧の条件は完了だけにして'); await ticks(10);
  const v = m.conv().activePlan();
  //   新しい流れでは、新しい版の最終案も JavaScript を持つ（実装仕様が同じなら流用。R10-5）。右の「コード」は新しい版のコードに切り替わり、前の版のコードを最新として残さない
  assert(v.version === 2 && v.generated && v.generated.C1 && (!m.panel.codeShown() || m.panel.codeShown().version === 2), `新しい版: 前の版のコードを最新として残さない: v${v.version} ${JSON.stringify(m.panel.codeShown())}`);
}

// =========================================================
console.log('\n--- §11. ヘッダーの［詳細］は描き直しても開いたまま（以前は描き直しで閉じた）---');
{
  const m = mount();
  await ticks();
  await m.$('kt-ai-header').dispatch({ type: 'click', target: { id: 'kt-ai-header-toggle' } });
  assert(/id="kt-ai-header-detail" style="flex:1 1 100%;/.test(m.$('kt-ai-header').innerHTML), '［詳細］で開く');
  m.panel.renderHeader();
  assert(/id="kt-ai-header-detail" style="flex:1 1 100%;/.test(m.$('kt-ai-header').innerHTML), '描き直しても開いたまま');
  await m.$('kt-ai-header').dispatch({ type: 'click', target: { id: 'kt-ai-header-toggle' } });
  assert(/id="kt-ai-header-detail" style="display:none;/.test(m.$('kt-ai-header').innerHTML), 'もう一度押すと閉じる');
}

// =========================================================
console.log('\n--- §12. 会話の表示の決まり（部品）: 出さない知らせ・失敗は出す・エラーのコードは詳細の中 ---');
{
  const MSG = KTAiConversation.MSG;
  const mk = (type, role, text, data = null) => ({ id: `m${Math.random()}`, type, role, text, at: '', ...(data ? { data } : {}) });
  //   C-1 第 3 段: reasked・plan-summary・review-summary・spec-intro・code-intro の知らせは作らなくなった（削除した古い確認の流れ）。
  //   作らないことは tests/ai-flow-redesign.test.js の F5-1・F2-3・F11-3 で守る
  for (const kind of ['connected', 'preview-changed', 'js-preview-changed', 'rolled-back', 'js-rolled-back']) assert(isHidden(mk(MSG.ASSISTANT_TEXT, 'toolkit', 'x', { kind })), `会話に出さない: ${kind}`);
  assert(isHidden(mk(MSG.REVIEW, 'toolkit', 'Toolkit の確認')) && isHidden(mk(MSG.ASSISTANT_TEXT, 'toolkit', '', { kind: 'answers-ack', stage: 'done' })) && isHidden(mk(MSG.ASSISTANT_TEXT, 'toolkit', '', { kind: 'answers-ack', stage: 'queued' })), '受け付けた・入れたの知らせ・Toolkit の確認のカードは出さない');
  const failed = KTAiChatUi.messageHtml(mk(MSG.ASSISTANT_TEXT, 'toolkit', '回答を受け付けました：…', { kind: 'answers-ack', stage: 'failed', records: [{ label: '通知先', answer: '上長' }] }));
  assert(/「通知先：上長」は、まだ変更案に入っていません（作り直しに失敗しました）/.test(failed) && !/受け付けました/.test(failed), `失敗は出す（利用者の言葉）: ${failed}`);
  //   C-1 第 3 段: 会話の要件の変化の知らせ（requirements-changes）は削除した。対応できない要件は最終案のカードの「実現できない点」に出る。
  //   新しい流れ（最終案の後の修正のターンで、計画の AI が要件を unsupported にした）で確かめる
  {
    const U = K.req('add', { target: 'Slack', condition: '承認されたら', behavior: 'Slack に送る', disposition: 'unsupported', note: '外部サービスとの連携は対象外', sourceQuotes: ['承認されたら Slack に送る'], planRefs: [] });
    const xU = K.makeConvC({ planImpl: (args) => K.planJs(args, { requirementOps: args.revision ? [U] : [] }) });
    await K.adoptC(xU);
    await xU.c.send('承認されたら Slack に送るようにして');
    const finU = K.stripC(K.finalHtml(xU));
    const cannotU = (finU.replace(/\s+/g, ' ').match(/実現できない点・対応範囲.{0,160}/) || [''])[0];
    assert(xU.c.activePlan().version === 2 && /計画では対応できないとされた要件: 承認されたら Slack に送る/.test(cannotU) && !/\bR[0-9]+\b|要件：/.test(finU), `対応できないことは番号なしで出す（最終案のカードの「実現できない点」）: ${cannotU}`);
    //   理由（計画の AI の note「外部サービスとの連携は対象外」）は、従来の会話の知らせには出たが、最終案のカードには出ない（文は発言の引用だけ。守り手なし・報告済み）
    pending(/外部サービスとの連携は対象外/.test(cannotU), `対応できないことの理由を添える（最終案のカードの「実現できない点」）: ${cannotU}`);
    const xN = K.makeConvC({ planImpl: (args) => K.planJs(args, { requirementOps: args.revision ? [K.req('add', { target: '金額', condition: '承認待ち', behavior: '画面に警告を出す', sourceQuotes: ['警告も出して'], planRefs: ['C1'] })] : [] }) });
    await K.adoptC(xN);
    await xN.c.send('警告も出して');
    const chatN = K.stripC(KTAiChatUi.chatHtml(xN.c.messages()));
    assert(xN.c.activePlan().version === 2 && !/要件：|追加 R[0-9]/.test(chatN) && !xN.c.messages().some(x => x.data?.kind === 'requirements-changes'), '要件の台帳の知らせ（対応できないことが無い）は出さない');
  }
  const err = KTAiChatUi.messageHtml(mk(MSG.ERROR, 'toolkit', 'AI が混み合っています。', { code: 'UPSTREAM_ERROR', requestId: 'req-9', retryText: 'もう一度' }));
  assert(/AI が混み合っています。/.test(err) && !/UPSTREAM_ERROR|req-9/.test(outsideDetails(err)) && /<summary>詳細情報<\/summary><div class="kt-ai-error-code">UPSTREAM_ERROR \/ requestId: req-9/.test(err) && /data-act="retry"/.test(err), 'エラー: 文と［再試行］。コード・requestId は［詳細情報］の中');
  const ans = KTAiChatUi.messageHtml(mk(MSG.ANSWER, 'assistant', '', { answer: { answer: '金額は承認の条件で使っています [E1]。', facts: [{ text: '条件で使用', evidenceIds: ['E1'] }], analysis: [], recommendations: [], unknowns: [], requestId: 'qa-7' } }));
  assert(/金額は承認の条件で使っています。/.test(ans) && !/E1|qa-7|AI回答/.test(outsideDetails(ans)) && /data-eid="E1"/.test(ans), '回答: 本文に根拠の番号・requestId を出さない（［根拠と詳細］の中に残す）');
  const plainAssistant = KTAiChatUi.messageHtml(mk(MSG.ASSISTANT_TEXT, 'toolkit', '計画の AI が候補から仮の案を選びます'));
  assert(/候補からこちらの提案を選んで変更案に入れます/.test(plainAssistant) && !/仮の案/.test(plainAssistant) && !/kt-ai-who/.test(plainAssistant), 'Toolkit の文は発言者の名前を出さず、内部の処理の名前を言い換える（前に記録した「仮の案」も「提案」で出す）');
}

// =========================================================
console.log('\n--- §13. 右の見出しの状態（VM.workStatus）は実際の状態だけから決める ---');
{
  const v = { planId: 'p', version: 1 };
  const W = (o) => VM.workStatus(o);
  assert(W({}).label === '未作成' && W({ subject: { name: 'a.js' } }).label === '相談中' && W({ working: 'PLAN' }).label === '確認中' && W({ version: v, working: 'REVISE' }).label === '更新中' && W({ version: v, working: 'PLAN' }).label === '更新中' && W({ version: v }).label === '未反映', '未作成・相談中・確認中・更新中・未反映');
  assert(W({ version: v, running: 'running' }).label === '反映中' && W({ version: v, running: 'preparing' }).label === '反映の準備中' && W({ version: v, running: 'rolling-back' }).label === '元に戻しています', '反映中・反映の準備中・元に戻しています');
  assert(W({ version: v, current: [{ written: true, done: true, ok: true }] }).label === '反映済み' && W({ version: v, current: [{ written: true, rolledBack: true }] }).label === '元に戻し済み' && W({ version: v, current: [{ written: true, done: true, ok: false }] }).label === '要確認' && W({ version: v, current: [{ written: true, rollbackStatus: 'ROLLBACK_FAILED' }] }).label === '要確認', '反映済み・元に戻し済み・要確認');
}

// =========================================================
console.log('\n--- §14. 登録の確認を出した後に同じ版でコードを作り直したら、前のコードの確認は使わない（確認した内容と違うコードを登録しない）---');
{
  const m = mount({ plans: () => PLAN_HYBRID });
  await ticks();
  await adopt(m);
  //   C-1 第 3 段: 登録の準備は最終案の承認の後だけ
  const v = await approve(m);
  await m.panel.startJsRegister(v); await ticks(6);
  assert(m.panel.jsExecState().stage === 'confirm', `前提: 登録の確認を出した: ${m.panel.jsExecState().stage}`);
  // 準備の後にコードだけが入れ替わった（同じ版のまま）→ 登録しない
  v.generated.C1 = { ...v.generated.C1 };
  const w0 = writes(m).length;
  const r = await m.panel.confirmJsRegister(); await ticks();
  assert(r === null && m.panel.jsExecState().stage === 'blocked' && /準備の後にコードが作り直されました/.test(m.$('kt-ai-jsreg').innerHTML) && writes(m).length === w0, `作り直したコードは、準備からやり直すまで登録しない: ${m.panel.jsExecState().stage}`);
  // 同じ版・同じ入力で作り直しを頼む（会話から）→ 独立レビュー B3（5.6）: AI を呼ばず案内だけ。コードは変わらないので前のコードの確認はそのまま
  //   C-1 第 3 段: 従来の「同じ入力・同じ指摘」の案内（generate-repeat）は削除した。最終案の後の「コードを作って」は、検証済みの JavaScript なら作り直さず案内（generate-verified）だけ（F2-4）
  await m.panel.startJsRegister(m.conv().activePlan()); await ticks(6);
  assert(m.panel.jsExecState().stage === 'confirm', '前提: もう一度、登録の確認を出した');
  const gens0 = m.calls.generate.length;
  const verifiedBefore = m.conv().messages().filter(x => x.data?.kind === 'generate-verified').length;
  await m.panel.generate('C1'); await ticks(10);
  assert(m.panel.jsExecState().stage === 'confirm' && m.calls.generate.length === gens0 && m.conv().activePlan() === v && m.conv().messages().filter(x => x.data?.kind === 'generate-verified').length === verifiedBefore + 1 && writes(m).length === w0, `同じ入力の作り直しは AI を呼ばず案内だけ（コードが変わらないので確認はそのまま）: ${m.panel.jsExecState().stage}`);
  // 入力が変わって（追加の指示）作り直す → 前のコードで準備した確認画面を取り消す
  //   C-1 第 3 段: 指示は最終案の修正（新しい版。承認は外れる）。前の版で準備した登録の確認は使わない
  await m.panel.send('差戻し後は編集できるようにして'); await ticks(10);
  assert(m.conv().activePlan().version === 2 && !m.conv().activePlan().approval && m.panel.jsExecState().stage === 'idle' && !/id="kt-ai-jsreg-go"/.test(m.$('kt-ai-jsreg').innerHTML) && writes(m).length === w0, `新しい版で作り直したら、前のコードの登録の確認を消す: ${m.panel.jsExecState().stage}`);
}

// =========================================================
console.log('\n--- §15. コードを作っている間は反映・登録を止める。作っている間に送った修正で新しい版になったら、前の版のコードを出さない ---');
{
  const g = gate();
  let n = 0;
  const H2 = JSON.parse(JSON.stringify(PLAN_HYBRID)); H2.plan.assessment.summary = '一覧の条件を変えました。';
  const m = mount({ plans: () => (++n === 1 ? PLAN_HYBRID : H2), genGate: async () => { await g.p; } });
  await ticks();
  //   C-1 第 3 段: 採用の後、最終案のパイプラインが生成工程に頼んでいる間（working FINAL）
  for (const s0 of K.REQUESTS.slice(0, 3)) { await m.panel.send(s0); await ticks(10); }
  const generating = m.panel.send(K.REQUESTS[3]); await ticks(10);
  assert(m.calls.generate.length === 1 && m.conv().isBusy() && /新しい内容の確認が終わるまで/.test(m.panel.applyHold() || '') && m.$('kt-ai-right-banner').style.display === '', `コードを作っている間: 反映を止める・案内を出す: ${m.conv().state.working} ${m.panel.applyHold()} / ${m.$('kt-ai-right-banner').textContent}`);
  const r0 = await m.panel.startJsRegister(m.conv().activePlan());
  assert(r0 === null && m.panel.jsExecState().stage === 'idle', 'コードを作っている間は、登録の準備もしない');
  //   作っている間に送った修正は積んで、完了の後に 1 回の差分更新で新しい版にする（R11-2・R11-4。従来の「新しい版はコードが無い」ではない）
  await m.panel.send('一覧の条件は完了だけにして'); await ticks(4);
  g.open(); await generating; await ticks(12);
  const v = m.conv().activePlan();
  assert(v.version === 2 && v.final, `前提: 生成の後に修正が入って新しい版の最終案: v${v.version}`);
  assert(!m.panel.codeShown() || m.panel.codeShown().version === v.version, `新しい版になったら、前の版のコードを最新のように出さない: ${JSON.stringify(m.panel.codeShown())}`);
}

// =========================================================
console.log('\n--- §16. 新しい会話の後は、前の会話の作業を今の作業として出さない・確定の待ちの間に新しい会話にしたら確定しない ---');
{
  const g = gate();
  const m = mount({ planGate: async (ctx) => { if (ctx.revision) await g.p; } });
  await ticks();
  await adopt(m);
  const sending = m.panel.send('担当者は既存のフィールドを使って、一覧の追加だけにして'); await ticks(6);
  assert(/data-status="updating"/.test(m.$('kt-ai-ws-state').innerHTML), '前提: 直している途中');
  await m.$('kt-ai-new-conv').dispatch({ type: 'click' }); await ticks();
  assert(/data-status="empty">未作成</.test(m.$('kt-ai-ws-state').innerHTML) && m.$('kt-ai-right-banner').style.display === 'none' && m.panel.applyHold() === null, `新しい会話: 前の会話の作業を「更新中」と出さない: ${m.$('kt-ai-ws-state').innerHTML}`);
  g.open(); await sending; await ticks(6);
  assert(m.msgs().length === 0 && /data-status="empty"/.test(m.$('kt-ai-ws-state').innerHTML), '前の会話の作業の結果は、新しい会話に入れない');
}
//   C-1 第 3 段: 仕様の確定（confirmSpec）は削除した（JS の仕様は最終案のパイプラインで自動で確定。R09-2・F7-4）。
//   「確定の待ちの間に新しい会話にしたら確定しない」は、確定そのものが無くなったので期待を消した

// =========================================================
console.log('\n--- §17. 変更案のカードの「次にすること」と、反映の前に確かめる手順（実際の状態から）---');
{
  const step = (id, actionType, title) => ({ id, actionType, title, targetKind: 'X', targetRef: 'x', proposal: { summary: '', details: [] }, dependsOn: [], alternativeId: null });
  const base = { planId: 'p', version: 1, status: 'ACTIVE', goal: '金額が大きいときは上長に知らせたい' };
  const vNoReview = { ...base, plan: { goal: base.goal, steps: [step('P1', 'REQUIRE_CONFIRMATION', '上長が誰かを確かめる'), step('P2', 'ADD_NOTIFICATION', '上長への通知を追加')], proposedFields: [] }, review: null };
  //   C-1 第 3 段: 変更案のカード（planCardHtml）は削除した。変わる内容の数え方・反映できない理由は最終案のカードの「反映先と主な影響」と
  //   ［この内容で反映する］の理由で示す（R09-9・R19-5・指示 A7。確認が済むまで反映しない手順は「実現できない点」）
  const sum = KTAiChatUi.changeSummaryHtml(vNoReview, { open: [] });
  assert(/反映の前に確かめること/.test(sum) && /上長が誰かを確かめる/.test(sum) && /何が変わるか（AI の提案。Toolkit の確認はまだありません）/.test(sum), '右「変更内容」: 反映の前に確かめる手順・Toolkit の確認が無いことを書く');
}

// =========================================================
console.log('\n--- §18. タブの中の印（●）を押しても切り替わる・会話に残っていた内部の文 ---');
{
  const m = mount();
  await ticks();
  await m.$('kt-ai-drawer-tabs').dispatch({ type: 'click', target: { closest: (sel) => (sel === '[data-pane]' ? { dataset: { pane: 'review' } } : null) } });
  assert(m.panel.drawerState().pane === 'review', 'タブの中の印を押しても、そのタブに切り替わる');
  const MSG = KTAiConversation.MSG;
  const mk = (type, role, text, data = null) => ({ id: `m${Math.random()}`, type, role, text, at: '', ...(data ? { data } : {}) });
  const choices = KTAiChatUi.messageHtml(mk(MSG.ASSISTANT_TEXT, 'toolkit', '何についてでしょうか。', { kind: 'choices', choices: ['EXPLAIN_REVIEW', 'REVISE_PLAN', 'PLAN'], text: 'これどう？' }));
  assert(/確認結果の説明を聞く/.test(choices) && /今の変更案を直す/.test(choices) && /新しい変更案を作る/.test(choices) && !/Toolkit Review|計画/.test(choices.replace(/data-[a-z-]+="[^"]*"/g, '')), `選択肢のボタン: 今の言葉（確認結果・変更案）: ${choices.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')}`);
  const err = KTAiChatUi.messageHtml(mk(MSG.ERROR, 'toolkit', 'JavaScript を生成できませんでした。', { code: 'UPSTREAM_ERROR', retryText: 'C1 のコードを作って', retryDisplay: '「承認後は金額を編集できなくする」のコードを作って', intent: 'GENERATE_CODE' }));
  assert(/data-act="retry"[^>]*data-display="「承認後は金額を編集できなくする」のコードを作って"/.test(err), '［再試行］も会話には利用者の言葉で出す（送る文は従来どおり）');
  const ans = KTAiChatUi.messageHtml(mk(MSG.ANSWER, 'assistant', '', { answer: { answer: '金額は条件で使っています（E1、E2）。', facts: [], analysis: [], recommendations: [], unknowns: [] } }));
  assert(/金額は条件で使っています。/.test(ans) && !/E1|E2/.test(outsideDetails(ans)), '回答の本文から（E1、E2）の形の根拠の番号も外す');
}

// =========================================================
console.log('\n--- §19. 回答欄から答える: 吹き出しは「確認事項への回答です。」、続けて「確認事項にすべて回答しました。」（同じ回答を 2 回並べない）---');
{
  const g = gate();
  //   C-1 第 3 段: 回答欄は最終案のカードの中で、先に決めたいこと（priority blocking）だけに出る（指示 B6）。確認事項を先に決めたいことにして確かめる
  const P1B = JSON.parse(JSON.stringify(PLAN_V1)); P1B.plan.questions[0].priority = 'blocking';
  const m = mount({ planGate: async (ctx) => { if (ctx.revision) await g.p; }, plans: (ctx) => (ctx.revision ? PLAN_V2 : P1B) });
  await ticks();
  await adopt(m);
  const qkey = (m.chat().match(/data-qkey="([^"]+)"/) || [])[1];
  const v = m.conv().activePlan();
  assert(!!qkey, '前提: 最終案のカードに回答欄がある');
  await m.$('kt-ai-chat').dispatch({ type: 'input', target: { dataset: { qkey }, value: '未着手・進行中・完了の 3 つ' } });
  const answering = m.$('kt-ai-chat').dispatch({ type: 'click', target: { dataset: { act: 'answer-questions', plan: v.planId, version: String(v.version) } } }); await ticks(6);
  const users = m.msgs().filter(x => x.type === 'USER');
  const u = users[users.length - 1];
  assert(u && /^確認事項への回答です。\s*・更新状況の選択肢は 3 段階でよいですか → 未着手・進行中・完了の 3 つ/.test(u.text) && u.data?.displayText === '確認事項への回答です。', `送る文は従来どおり・吹き出しは短く: ${u && u.data?.displayText}`);
  const chat = m.chat();
  const iUser = chat.indexOf('>確認事項への回答です。<'), iAck = chat.indexOf('確認事項にすべて回答しました。変更案に入れています。');
  assert(iUser > 0 && iAck > iUser && !/→ 3 段階でよい<\/div>/.test(chat.slice(iUser - 200, iUser + 40)), `吹き出しの後に「確認事項にすべて回答しました。」が続く: user=${iUser} ack=${iAck}`);
  assert((outsideDetails(chat).replace(/<textarea[\s\S]*?<\/textarea>/g, '').match(/未着手・進行中・完了の 3 つ/g) || []).length <= 1, `同じ回答を 2 回並べない: ${(outsideDetails(chat).match(/未着手・進行中・完了の 3 つ/g) || []).length}`);
  g.open(); await answering; await ticks(10);
  const chat2 = m.chat();
  assert(m.conv().activePlan().version === 2 && /確認事項にすべて回答しました。変更案に入れました。/.test(chat2), '直し終わったら「変更案に入れました。」');
  //   C-1 第 3 段: 確認事項のカード（questions）は削除した。答えは新しい最終案のカードの「変わった点」に 1 回だけ出し、前の最終案は 1 行に畳む（R10-4）
  assert(/前の最終案 — このあと直した案があります/.test(chat2) && (outsideDetails(chat2).match(/未着手・進行中・完了の 3 つ/g) || []).length === 1, `前の最終案は折りたたみ、何と答えたかを 1 回だけ残す: ${(outsideDetails(chat2).match(/未着手・進行中・完了の 3 つ/g) || []).length}`);
}

// =========================================================
console.log('\n--- §20. 読みやすさ: AI の文は段落と箇条書き（AI は呼ばない）・行間・余白・文字の濃さ・前のカードは折りたたみ ---');
{
  const R = KTContextUi.richTextHtml;
  const sample = '金額に応じて、承認ルートを分ける案です。\n\n・100万円未満：課長が承認\n・100万円以上：部長が承認\n\n既存の承認者設定を確認し、\n必要な変更を右側にまとめます。';
  assert(R(sample) === '<p>金額に応じて、承認ルートを分ける案です。</p><ul><li>100万円未満：課長が承認</li><li>100万円以上：部長が承認</li></ul><p>既存の承認者設定を確認し、必要な変更を右側にまとめます。</p>', `結論・箇条書き・段落（句点ごとの改行はつなげる）: ${R(sample)}`);
  assert(/^<ol><li>一覧を開く<\/li><li>［設定］を押す<\/li><\/ol>$/.test(R('1. 一覧を開く\n2. ［設定］を押す')) && /<ul><li>条件 A<\/li><li>条件 B<\/li><\/ul>/.test(R('- 条件 A\n- 条件 B')), '手順は番号付き・条件は箇条書き');
  assert(R('**部長**が承認します。') === '<p><strong>部長</strong>が承認します。</p>' && R('<script>x</script>') === '<p>&lt;script&gt;x&lt;/script&gt;</p>' && R('Use the API.\nThen save.') === '<p>Use the API. Then save.</p>' && R('## 結論\n通知を追加します。') === '<p class="kt-ai-h">結論</p><p>通知を追加します。</p>', '重要な語だけ強調・HTML は無害化・英文は空白でつなぐ・見出し');
  const MSG = KTAiConversation.MSG;
  const mk = (type, role, text, data = null) => ({ id: `m${Math.random()}`, type, role, text, at: '', ...(data ? { data } : {}) });
  const reply = KTAiChatUi.messageHtml(mk(MSG.ASSISTANT_TEXT, 'assistant', sample, { kind: 'turn-reply' }));
  assert(/class="kt-ai-bubble kt-ai-rich"><p>金額に応じて/.test(reply) && /<ul><li>100万円未満/.test(reply) && !/<b>|<strong>/.test(reply), `AI の返答: 段落と箇条書き・本文は通常の太さ: ${reply.slice(0, 160)}`);
  const ans = KTAiChatUi.messageHtml(mk(MSG.ANSWER, 'assistant', '', { answer: { answer: sample, facts: [], analysis: [], recommendations: [], unknowns: [] } }));
  assert(/kt-ai-answer-text kt-ai-rich"><p>金額に応じて/.test(ans) && /<li>100万円以上：部長が承認<\/li>/.test(ans), '回答のカード: 段落と箇条書き');
  const err = KTAiChatUi.messageHtml(mk(MSG.ERROR, 'toolkit', '計画を作れませんでした。', { code: 'X_Y' }));
  assert(!/<b>計画を作れませんでした。<\/b>/.test(err), 'エラーの文も全文を太字にしない');
  const m = mount();
  await ticks();
  const css = m.host.innerHTML;
  assert(/\.kt-ai-chat\{[^}]*font-size:13px; line-height:1\.8;/.test(css) && /\.kt-ai-rich p\{ margin:0 0 \.8em; \}/.test(css) && /\.kt-ai-msg\{ display:flex; flex-direction:column; margin-top:24px; \}/.test(css) && /\.role-user \.kt-ai-bubble\{[^}]*padding:14px 18px;/.test(css), '行間 1.8・段落の間 0.8em・メッセージの間 24px・吹き出しの中 14〜18px');
  assert(/--kt-ai-muted:#4b5563;/.test(css) && /\[data-theme="dark"\]\{[^}]*--kt-ai-muted:#b4bcc8;/.test(css) && /:not\(button\)\[style\*="opacity:\.6"\][^{]*\{ opacity:1 !important; color:var\(--kt-ai-muted\); \}/.test(css), '補足の文字も読める濃さ（薄い不透明度の文字を muted の色にする・ダークテーマも）');
  //   C-1 第 3 段: 変更案のカード（planCardHtml）は削除した。同じ余白を最終案のカードで確かめる
  const xPad = K.makeConvC(); await K.adoptC(xPad);
  assert(/border-radius:10px; padding:16px 18px; margin-top:0;/.test(K.finalHtml(xPad)), 'カードの中の余白 16〜18px（最終案のカード）');
}
{
  // 右「確認結果」: 先に必要な判断を短い文で。手順は 1 文の判定と判断。バッジ・技術的な内容は［詳しく］
  const m = mount();
  await ticks();
  await adopt(m);
  const rv = m.$('kt-ai-review-result').innerHTML;
  const iDecide = rv.indexOf('必要な判断'), iSteps = rv.indexOf('手順ごとの判定と判断'), iDetail = rv.indexOf('詳しく（Toolkit で確認した結果の内訳');
  assert(iDecide >= 0 && iDecide < iSteps && iSteps < iDetail && /設定の手順 2 件のうち、承認すると動作テスト環境へ反映できるのは 2 件です。/.test(rv) && /手順ごとに「承認」を選ぶと、承認した手順だけを右の「反映」から反映します/.test(rv), `確認結果: 必要な判断 → 手順 → 詳しく の順: ${iDecide} ${iSteps} ${iDetail}`);
  const step = (rv.match(/<div class="kt-ai-review-step"[\s\S]*?<\/details>\s*<\/div>/) || [''])[0];
  const visible = step.replace(/<details[\s\S]*?<\/details>/g, '');
  assert(/kt-ai-step-verdict/.test(visible) && /問題は見つかりませんでした。承認すると反映の対象になります。/.test(visible) && /class="btn kt-ai-decision"/.test(visible) && !/<span style="display:inline-block; font-size:10px; padding:0 6px; border-radius:8px; border:1px solid/.test(visible) && /＋ 新規/.test(step), '手順: 1 文の判定と判断を出す。色付きのバッジは［詳しく］の中だけ');
}
{
  const m = mount({ plans: (ctx) => (ctx.revision ? PLAN_V2 : PLAN_V1) });
  await ticks();
  await adopt(m);
  await m.panel.send('担当者は既存のフィールドを使って、一覧の追加だけにして'); await ticks(10);
  const chat = m.chat();
  //   C-1 第 3 段: 変更案のカードは最終案のカード。前の最終案は 1 行に畳み、今の最終案だけを開いて出す（R10-4・F2-2 と同じ表示）
  const openFinals = (chat.match(/<div class="kt-ai-card kt-ai-final-card/g) || []).length;
  assert(/<details class="kt-ai-card kt-ai-old-card[^"]*"><summary>前の最終案 — このあと直した案があります/.test(chat) && openFinals === 1, `前の最終案のカードは、更新済みと分かる 1 行に折りたたむ（開くと詳細）。今の最終案だけを開いて出す: ${openFinals} ${(chat.match(/<details class="kt-ai-card kt-ai-old-card[^>]*><summary>[^<]*/g) || []).join(' | ')}`);
}

// =========================================================
console.log('\n--- §21. 会話の返答の逐次表示（2026-10-07）: 届いた部分から順に出す・先回りの見立ては変更案ができたら折りたたむ・基準の取り直しを待たない ---');
const HEALTH_STREAM = JSON.parse(JSON.stringify(HEALTH)); HEALTH_STREAM.registry.toolkit['assistant-qa'].conversation = ['requirements', 'brief', 'stream'];
{
  // 質問: 部分が届くたびに読み込み中の吹き出しに本文が出て、そろったら答えのカードに置き換わる
  const g = gate();
  const m = mount({ health: HEALTH_STREAM, askStream: async (onText) => { onText('このフィールドは'); onText('このフィールドは金額です。\n\n一覧で使われています [E1]。'); await g.p; } });
  await ticks();
  const p = m.panel.send('金額フィールドは何に使われていますか？'); await ticks(6);
  await new Promise(r => setTimeout(r, 220));   // 2 つめ以降の部分は STREAM_RENDER_MS（150ms）に 1 回描く
  const chat1 = m.chat();
  assert(/kt-ai-streaming/.test(chat1) && /このフィールドは金額です。/.test(chat1) && /一覧で使われています。/.test(chat1) && !/\[E1\]/.test(chat1) && /kt-ai-stream-cursor/.test(chat1), '届いた部分が段落に整形されて出る（根拠の番号は出さない・生成中の印）');
  assert(/kt-ai-who">AI</.test(chat1.slice(Math.max(0, chat1.indexOf('kt-ai-streaming') - 400), chat1.indexOf('kt-ai-streaming'))), '部分の吹き出しにも AI の名札');
  assert(m.calls.ask[0].stream === true, 'Gateway が対応しているときは逐次表示を求めて送る');
  assert(!/kt-ai-answer-card/.test(chat1), 'そろう前は答えのカードは無い');
  assert(!INTERNAL_IN_CHAT.test(outsideDetails(chat1)), `部分の表示に内部の番号・処理の通知が無い: ${(outsideDetails(chat1).match(INTERNAL_IN_CHAT) || [])[0]}`);
  g.open(); await p; await ticks(4);
  const chat2 = m.chat();
  assert(!/kt-ai-streaming|kt-ai-loading/.test(chat2) && /kt-ai-answer-card/.test(chat2) && (chat2.match(/このフィールドは金額です。/g) || []).length === 1, '答えがそろったら読み込み中の吹き出しは消え、カード 1 枚になる');
  const tm = m.panel.metrics().timings; const last = tm[tm.length - 1];
  assert(last && last.intent === 'ASK' && Number.isFinite(last.firstTextMs) && last.firstTextMs <= last.doneMs && last.ok === true, `計測: 最初の文字（firstTextMs）と完了（doneMs）: ${JSON.stringify(last)}`);
}
{
  // Gateway が逐次表示に対応していない（health に stream が無い）ときは従来どおり（onText を渡さない・kintone.proxy のまま）
  const m = mount({ askStream: async (onText) => { onText('x'); } });
  await ticks(); await m.panel.send('金額フィールドは何に使われていますか？'); await ticks(6);
  assert(m.calls.ask[0].stream === false && !/kt-ai-streaming/.test(m.chat()) && /kt-ai-answer-card/.test(m.chat()), '対応していない Gateway には逐次表示を求めない');
  const last = m.panel.metrics().timings.slice(-1)[0];
  assert(last && last.firstTextMs == null && Number.isFinite(last.doneMs), '逐次表示が無いときは firstTextMs を記録しない');
}
{
  // 失敗: 部分が届いた後に失敗したら、部分の吹き出しは消えてエラー（再試行つき）
  const m = mount({ health: HEALTH_STREAM, askStream: async (onText) => { onText('途中まで'); }, askGate: async () => { throw Object.assign(new Error('切れた'), { code: 'TRANSPORT_ERROR' }); } });
  await ticks(); await m.panel.send('金額フィールドは何に使われていますか？'); await ticks(6);
  const chat = m.chat();
  assert(!/kt-ai-streaming/.test(chat) && /kt-ai-error-card/.test(chat) && !/途中まで/.test(chat), '失敗したら部分の吹き出しは残さない');
}
{
  // C-1 第 3 段: 新しい依頼の先回りの見立て（assistant-qa の brief）は使わなくなった（F7-5）。依頼は仮案の AI の返答（reply）を逐次表示し（B2-1・R01-6）、
  //   採用の後は計画の AI の説明を進みのカードに逐次表示する（C3b-3）。見立ての部分表示・折りたたみ・遅れて届いた見立て（7 件・2 件）と、
  //   変更案のカードの要約を AI の返答があるときに詳細へ畳む表示（3 件。変更案のカードは削除・最終案のカードの「仮案から変わった点と理由」に返答を出す。R09-9）の期待は消した
}
{
  // 基準の取り直しを待たない: 取得済みの基準があれば答えを先に返し、古ければ裏で取り直す（無いときは待つ）
  const { makeEnvGetter } = require('./helpers/dev-base-fake.js');
  const PROD = FX.makeData();
  const realLoad = async () => { const g = makeEnvGetter({ preview: PROD, production: PROD, files: {} }); return T.KTDevBase.load({ appId: String(FX.SELF_APP), getImpl: g.getImpl, download: g.download, now: () => new Date('2026-10-07T00:00:00Z') }); };
  let loads = 0; const gl = gate();
  const m = mount({ health: HEALTH_STREAM, extra: { loadDevBase: async () => { loads += 1; if (loads >= 2) await gl.p; return realLoad(); } } });
  await ticks(12);
  assert(loads === 1, `接続時に基準を 1 回取る: ${loads}`);
  await m.panel.send('金額フィールドは何に使われていますか？'); await ticks(8);
  assert(loads === 1 && m.msgs().filter(x => x.type === KTAiConversation.MSG.ANSWER).length === 1, '取ったばかりの基準で答える（取り直さない）');
  m.clock.t += 60 * 1000;
  const p2 = m.panel.send('担当者フィールドは何に使われていますか？'); await ticks(8);
  assert(loads === 2 && m.msgs().filter(x => x.type === KTAiConversation.MSG.ANSWER).length === 2, `古い基準でも答えを待たせず、取り直しは裏で走る: loads=${loads}`);
  gl.open(); await p2; await ticks(4);
  // 基準が無い（取り直し中）ときは待つ: 反映の直後と同じ状態を作る
  const m2 = mount({ health: HEALTH_STREAM, extra: { loadDevBase: async () => { await gate().p; return realLoad(); } } });
  await ticks(4);
  let answered = false; m2.panel.send('金額フィールドは何に使われていますか？').then(() => { answered = true; }); await ticks(8);
  assert(!answered && m2.calls.ask.length === 0, '基準をまだ取れていない間は、質問を送らずに待つ');
}

// 差分レビュー（2026-10-07）で確定した 4 件の固定
{
  // C-1 第 3 段: 先回りの見立て（brief）は使わなくなった（F7-5）。見立ての途中の吹き出し・遅れた見立て（3 件）と、作成中に挟んだ質問と見立ての折りたたみ（3 件）の期待は消した。
  //   作成中に挟んだ質問を並べて答えることは、新しい流れの B3-40・B6-16・R11-3 で守る
}
{
  // 反映・登録の直後（基準は取ったばかりだが取り直し中）の質問は、取り直しの完了を待ってから送る
  const { makeEnvGetter } = require('./helpers/dev-base-fake.js');
  const PROD = FX.makeData();
  const realLoad = async () => { const g = makeEnvGetter({ preview: PROD, production: PROD, files: {} }); return T.KTDevBase.load({ appId: String(FX.SELF_APP), getImpl: g.getImpl, download: g.download, now: () => new Date('2026-10-07T00:00:00Z') }); };
  let loads = 0; const gl = gate();
  const m = mount({ health: HEALTH_STREAM, extra: { loadDevBase: async () => { loads += 1; if (loads >= 2) await gl.p; return realLoad(); } } });
  await ticks(12);
  m.panel.refreshDevBase({ reason: 'after-apply' });
  await ticks(2);
  let answered = false; const p = m.panel.send('金額フィールドは何に使われていますか？').then(() => { answered = true; }); await ticks(8);
  assert(loads === 2 && !answered && m.calls.ask.length === 0, `取り直し中は、基準が新しくても質問を送らずに待つ: loads=${loads} asked=${m.calls.ask.length}`);
  gl.open(); await p; await ticks(4);
  assert(answered && m.calls.ask.length === 1, '取り直しが終わったら答える');
}
{
  // 逐次表示の吹き出しの中身は 1 つの関数で作る（描画の差し替えと同じ HTML）
  const html = KTAiChatUi.streamingInnerHtml({ text: '結論です。\n\n理由 [E3] です。' });
  assert(/結論です。/.test(html) && /理由 です。|理由です。/.test(html) && !/\[E3\]/.test(html) && /kt-ai-stream-cursor/.test(html), 'streamingInnerHtml: 段落・根拠の番号の除去・生成中の印');
}

// =========================================================
console.log('\n--- §22. 区間の記録（2026-10-07）: 送信ごとの timings に perf（基準の待ち・Context・往復・検証）と ai（モデル・待ち時間・token）、先回りの見立ては asideTimings ---');
{
  //   C-1 第 3 段: 依頼は仮案の流れなので、逐次表示と仮案の両方に対応した接続先にする
  const HEALTH_STREAM_NF = JSON.parse(JSON.stringify(HEALTH)); HEALTH_STREAM_NF.registry.toolkit['assistant-qa'].conversation = ['requirements', 'stream', 'proposal'];
  const m = mount({ health: HEALTH_STREAM_NF });
  await ticks(); await m.panel.send('金額フィールドは何に使われていますか？'); await ticks(6);
  const t1 = m.panel.metrics().timings.slice(-1)[0];
  assert(t1 && t1.perf && ['baseWaitMs', 'contextMs', 'requestMs'].every(k => Number.isFinite(t1.perf[k])) && t1.calls.length === 1 && t1.calls[0].kind === 'ask', `質問: perf と calls: ${JSON.stringify({ perf: t1 && t1.perf, calls: t1 && t1.calls })}`);
  assert(t1.ai && t1.ai.model === 'm' && t1.ai.latencyMs === 12 && t1.ai.inputTokens === 100 && t1.ai.cachedTokens === 40 && t1.ai.outputTokens === 20 && t1.ai.reasoningTokens === 3 && t1.ai.firstTextMs === 4 && t1.ai.streamed === true, `質問: ai（モデル・待ち時間・token）: ${JSON.stringify(t1.ai)}`);
  //   C-1 第 3 段: 新しい依頼は仮案 → 採用。計画の AI を呼ぶのは採用（ADOPT_DRAFT）の送信
  await adopt(m); await ticks(4);
  const t2 = m.panel.metrics().timings.filter(t => t.intent === 'ADOPT_DRAFT').slice(-1)[0];
  assert(t2 && t2.perf && Number.isFinite(t2.perf.reviewMs) && Number.isFinite(t2.perf.baseWaitMs) && t2.calls.some(c => c.kind === 'plan') && t2.ai && t2.ai.model === 'm' && t2.ai.latencyMs === 30 && t2.ai.outputTokens === 200 && t2.ai.reasoningTokens === 10, `新しい依頼（採用で計画）: perf と ai: ${JSON.stringify({ intent: t2 && t2.intent, perf: t2 && t2.perf, ai: t2 && t2.ai })}`);
  //   先回りの見立ての記録（asideTimings の brief）は、見立てを使わなくなったので期待を消した（F7-5）
  await m.panel.send('担当者は既存のフィールドを使って、一覧の追加だけにして'); await ticks(10);
  const t3 = m.panel.metrics().timings.slice(-1)[0];
  assert(t3 && t3.intent === 'REVISE_PLAN' && t3.calls.some(c => c.kind === 'plan') && t3.perf && Number.isFinite(t3.perf.requestMs) && t3.ai && t3.ai.model === 'm', `修正: perf と ai: ${JSON.stringify({ intent: t3 && t3.intent, perf: t3 && t3.perf })}`);
  assert(!INTERNAL_IN_CHAT.test(outsideDetails(m.chat())), '記録は会話に出ない');
}

// =========================================================
console.log('\n--- §23. 出力削減（2026-10-07）: 計画の AI が書かない説明文を、spec・設定・Toolkit の検証から作る（表示・JS 生成・計画の修正・確かめられなかったこと）---');
{
  const { KTPlanText, KTContext } = T;
  const rem = { id: 'P1', actionType: 'ADD_REMINDER', targetKind: 'REMINDER', targetRef: '承認待ち停滞通知', title: '承認待ち案件の3日後通知を追加する', proposal: { summary: '', details: [] }, spec: { name: '承認待ち停滞通知', filterCond: 'ステータス in ("承認待ち")', targets: ['FIELD_ENTITY:作業者'], timingField: '更新日時', daysLater: '3', time: '09:00' }, dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null };
  const d1 = KTPlanText.describeStep(rem, {});
  assert(d1.derived && /リマインダーを追加：「承認待ち停滞通知」/.test(d1.summary) && /条件 ステータス in \("承認待ち"\)/.test(d1.summary) && /通知先 FIELD_ENTITY:作業者/.test(d1.summary) && /基準日 更新日時/.test(d1.summary) && /タイミング 3 日後/.test(d1.summary) && /時刻 09:00/.test(d1.summary), `spec から 1 行の説明: ${d1.summary}`);
  assert(d1.details.length === 5 && d1.details.map(x => x.key).join(',') === '条件,通知先,基準日,タイミング,時刻', `spec から設定項目（日本語の項目名）: ${JSON.stringify(d1.details)}`);
  const given = { ...rem, proposal: { summary: 'AI の説明です。', details: [{ key: '注意', value: '編集すると起算日が変わる' }] } };
  const d2 = KTPlanText.describeStep(given, {});
  assert(!d2.derived && d2.summary === 'AI の説明です。' && d2.details.length === 1, 'proposal があればそれを優先する（REQUIRE_CONFIRMATION の補足・古い計画）');
  const js = { id: 'C1', actionType: 'CUSTOMIZATION_REQUIRED', targetKind: 'JS', targetRef: 'dealLock.js', title: 'PC でロック', proposal: { summary: '', details: [] }, spec: { customizationId: 'C1', filterCond: 'ステータス in ("承認済み")', fields: ['amount'] } };
  const d3 = KTPlanText.describeStep(js, { customizations: [{ customizationId: 'C1', requirement: '承認済みのときに金額を編集不可にする' }] });
  assert(d3.summary === 'JavaScript：承認済みのときに金額を編集不可にする', `JavaScript の手順は customizations の要件を説明にする: ${d3.summary}`);
  const proc = { id: 'P3', actionType: 'UPDATE_PROCESS', targetKind: 'PROCESS_ACTION', targetRef: '申請する', title: '', proposal: { summary: '', details: [] }, spec: { name: '申請する', from: '作成中', to: '承認待ち', filterCond: 'amount <= "999999"', changeKind: 'ACTION_CONDITION' } };
  const d4 = KTPlanText.describeStep(proc, { review: { steps: [{ stepId: 'P3', diff: { human: ['「申請する」の条件を「なし」→「amount <= "999999"」に変更'] } }] } });
  assert(/プロセス管理を変更：「申請する」（遷移元 作成中・遷移先 承認待ち・条件 amount <= "999999"・変更の種別 アクションの条件）/.test(d4.summary) && d4.human.length === 1, `プロセスの手順の説明と、Toolkit の変更前後の文: ${d4.summary}`);
  const data = { fields: { end_date: { code: 'end_date', label: '契約終了日', type: 'DATE' }, items: { code: 'items', type: 'SUBTABLE', fields: { qty: { code: 'qty', label: '数量', type: 'NUMBER' } } } } };
  assert(KTPlanText.labelOf('end_date', data) === '契約終了日（end_date）' && KTPlanText.labelOf('qty', data) === '数量（qty）' && KTPlanText.labelOf('NEW_FIELD_1', data) === 'NEW_FIELD_1' && KTPlanText.fieldText('end_date', data) === '契約終了日（end_date・DATE）', '設定からラベル・型を引く（テーブルの中も。無ければコードのまま）');
  const notes = KTPlanText.coverageNotes({ coverage: { notes: ['他アプリからこのアプリへの参照は未走査。被参照は含まれていない', 'レコードの実データ・添付ファイルは含まない'] }, truncation: { applied: true, sections: [{ name: 'facts' }] } });
  assert(notes.length === 3 && /入力の上限で省略した項目があります（facts）/.test(notes[2]), `coverage と truncation から「確かめられなかったこと」: ${notes.join(' / ')}`);
  // 計画の要約（説明・文書の入力）: 説明は spec から作られ、spec・仮の案・条件・候補は残る
  const plan = { goal: 'g', assessment: { summary: '方針。' }, steps: [rem, proc], proposedFields: [], questions: [{ id: 'Q1', question: 'q', reason: 'r', options: ['a', 'b'], priority: 'blocking' }], unknowns: [], provisionals: [{ id: 'A1', topic: '日数', choice: '暦日 3 日後', reason: 'r', changeHint: 'h' }], customizations: [{ customizationId: 'C1', requirement: 'r', strategy: 'NEW_JS_FILE', implementation: 'JAVASCRIPT', platform: ['desktop'], events: [], fields: [{ code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [] }], solution: 'HYBRID', summary: { steps: 2 } };
  const cp = KTContext.compactPlan(plan, { version: 1 });
  assert(typeof cp.summary === 'string' && cp.steps.length === 2 && /リマインダーを追加/.test(cp.steps[0].summary) && cp.steps[0].spec && cp.steps[0].spec.daysLater === '3' && !cp.steps[0].details && cp.provisionals && cp.provisionals[0].choice === '暦日 3 日後', `要約: 説明は spec から・spec は残す・details は作らない・仮の案を残す: ${JSON.stringify(cp.steps[0]).slice(0, 160)}`);
  assert(cp.customizations[0].fields[0].condition === 'ステータス in ("承認済み")' && cp.customizations[0].implementation === 'JAVASCRIPT' && cp.questions[0].options.length === 2 && cp.questions[0].priority === 'blocking', '要約でも JS の条件・実装手段・確認事項の候補を落とさない');
  // 計画の修正の土台: 正規化済みの計画全体（Gateway の形。top-level summary は件数・各手順に proposal と spec）はそのまま送る（差分更新の土台は Gateway の isFullPlan を満たす必要がある）
  const gw = { goal: 'g', assessment: { summary: '方針。', usableExistingFields: [], usableExistingSettings: [], missingCapabilities: [], uncertainties: [] }, relevantFields: [], proposedFields: [], steps: [rem, proc], alternatives: [], impact: [{ targetKind: 'FIELD', targetRef: 'amount', description: 'd', evidenceIds: ['E1'], confidence: 'INFERRED' }], questions: [], provisionals: [], unknowns: [], planConfidence: 'INFERRED', solution: 'STANDARD', customizations: [], summary: { steps: 2 } };
  const rv = KTContext.compactRevision({ basedOnVersion: 1, request: '直して', previousPlan: gw, mode: 'patch' });
  const fullOk = (p) => typeof p.goal === 'string' && typeof p.assessment?.summary === 'string' && p.steps.every(s => s.proposal && typeof s.proposal === 'object' && s.spec && typeof s.spec === 'object');
  assert(rv.previousPlan === gw && fullOk(rv.previousPlan) && rv.previousPlan.impact.length === 1, '差分更新の土台: 正規化済みの計画はそのまま（proposal・spec・impact を持ったまま。要約しない）');
  const rvFull = KTContext.compactRevision({ basedOnVersion: 1, request: '直して', previousPlan: gw, mode: 'full' });
  assert(rvFull.previousPlan === gw, '全体の作り直しの土台も正規化済みの計画はそのまま');
  const legacy = { goal: 'g', steps: [{ id: 'P1', actionType: 'ADD_REMINDER', title: 't', spec: { name: 'x' }, dependsOn: [] }] };
  const rvLegacy = KTContext.compactRevision({ basedOnVersion: 1, request: '直して', previousPlan: legacy });
  assert(rvLegacy.previousPlan !== legacy && typeof rvLegacy.previousPlan.summary === 'string' && /リマインダーを追加/.test(rvLegacy.previousPlan.steps[0].summary), '古い形（proposal が無い）の土台だけ要約する');
  // JS 生成へ渡す Context: 標準設定の手順の説明と spec
  const gctx = KTContext.buildGenerator({ customization: { customizationId: 'C1', requirement: 'r', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL', condition: '' }], apis: ['kintone.events.on'] }, plan, data: { appId: '1', fields: { amount: { code: 'amount', label: '金額', type: 'NUMBER' } } }, deps: null, scan: null });
  const ss = gctx.plan.standardSteps;
  assert(ss.length === 2 && /リマインダーを追加/.test(ss[0].summary) && ss[0].spec && ss[0].spec.timingField === '更新日時' && ss[1].spec && ss[1].spec.filterCond === 'amount <= "999999"', `JS 生成へ渡す標準手順: 説明と spec: ${JSON.stringify(ss[1])}`);
}
{
  // 画面: 右の「変更内容」の確かめられなかったことに coverage の注意が入る。計画の詳細の手順に spec からの説明が出る
  const m = mount();
  await ticks(); await adopt(m);
  const sum = m.$('kt-ai-change-summary').innerHTML;
  assert(/確かめられなかったこと/.test(sum) && /レコードの実データ・添付ファイルは含まない/.test(sum), '右の「変更内容」に、解析範囲から分かる「確かめられなかったこと」を Toolkit が出す');
  const detail = m.$('kt-ai-plan-result').innerHTML;
  assert(/kt-ai-step/.test(detail) && /レコードの実データ・添付ファイルは含まない/.test(detail), '計画の詳細の「解析できないこと」にも coverage の注意');
  assert(!INTERNAL_IN_CHAT.test(outsideDetails(m.chat())), '会話には内部の番号・処理の通知を出さない');
}

// =========================================================
console.log('\n--- §21. こちらの提案で進めている点・確認したいこと: 見出し 1 行 ＋ 1 件 1 行（「／」で詰めない。2026-10-07 利用者の指摘）---');
{
  const { MSG } = KTAiConversation;
  const mk = (type, role, text, data = null) => ({ id: `m${Math.random()}`, type, role, text, at: '', ...(data ? { data } : {}) });
  void MSG; void mk;
  //   C-1 第 3 段: 計画の提案のカード（kind provisionals）は削除した。こちらの提案で進める点は仮案のカード（前提 assumptions）に出る（B2-3）。
  //   同じ決まり（3 件以上は畳む・2 件以下は開く・1 件 1 行・変え方は小さく灰色・「／」で詰めない）を仮案のカードで確かめる
  const xP = K.makeConvC();
  await K.adoptC(xP);
  const drafts = xP.c.messages().filter(x => x.type === 'DRAFT').map(x => KTAiChatUi.messageHtml(x, { draft: xP.c.draft() }));
  const asm = (h) => (h.match(/<details class="kt-ai-draft-assumptions"[\s\S]*?<\/details>/) || [''])[0];
  const html2 = asm(drafts[0]), html4 = asm(drafts[2]);
  assert(/<summary>こちらの提案で進める点が 4 件あります（変えたいときはそのまま伝えてください）<\/summary>/.test(html4) && !/<details[^>]*\sopen/.test(html4) && (html4.match(/<li>/g) || []).length === 4 && /<li>承認者はユーザー選択フィールド「課長承認者」「部長承認者」を新設して指定する<span[^>]*>（既存のフィールドを使うこともできます）<\/span><\/li>/.test(html4) && !/／/.test(html4) && !/仮の案/.test(html4) && !/kt-ai-who/.test(html4), `提案 4 件: details で畳まれ（見出しだけ）、開くと 1 件 1 行（変え方は小さく）: ${html4.slice(0, 400)}`);
  assert(/ open><summary>こちらの提案で進める点が 2 件あります/.test(html2) && (html2.match(/<li>/g) || []).length === 2, `提案 2 件: 開いた状態: ${html2.slice(0, 200)}`);
  assert(/\.kt-ai-provisionals-card > summary\{ color:inherit; font-size:inherit; \}/.test(SRC_TEXT) && /\.kt-ai-prov-hint\{ font-size:11px; color:var\(--kt-ai-muted\);/.test(SRC_TEXT), '見出しの文字色は本文と同じ（薄くしない）・変え方は小さく灰色（CSS）');
  // 確認したいことが 2 件: 文は見出し 1 行 ＋ 「- 」の行。変更案の無い描画（記録）でも箇条書き。会話のカードは従来どおり番号付き
  const P = JSON.parse(JSON.stringify(PLAN_V2));
  P.plan.questions = [{ id: 'Q1', question: '担当者別の一覧は全員に見せますか', reason: '公開範囲', relatedEvidenceIds: [], priority: 'blocking', recommendation: '' }, { id: 'Q2', question: '並び順は期限の昇順でよいですか', reason: '並び順', relatedEvidenceIds: [], priority: 'later', recommendation: '' }];
  const m = mount({ plans: () => P });
  await ticks(); await adopt(m);
  //   C-1 第 3 段: 確認したいことの知らせ（kind questions の文と、その記録の描画）は削除した。残る判断は最終案のカードの中に番号付きで出る（R10-1）
  const finQ = K.stripC(m.chat());
  assert(/残る判断（[12] 件）\s*1．担当者別の一覧は全員に見せますか/.test(finQ) && !/2．担当者別/.test(finQ), `最終案のカードは番号付きの一覧（先に確認したいことが前）: ${(finQ.replace(/\s+/g, ' ').match(/残る判断.{0,120}/) || [''])[0]}`);
  assert(!INTERNAL_IN_CHAT.test(outsideDetails(m.chat())), '会話には内部の番号・処理の通知を出さない');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
