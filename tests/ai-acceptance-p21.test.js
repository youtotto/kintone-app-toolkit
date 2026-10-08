// Phase 21（継続開発の整合性・JS 登録条件・AI 品質改善）の回帰テスト
//
// 検証内容:
//   G1 開発支援の作業基準 = 最新の動作テスト環境（KTDevBase）。運用環境は比較のためだけに取得し、差を区別して Context（environment / env-diff）に入れる。
//      再読み込み後（会話履歴なし）でも、動作テスト環境にだけあるフィールド・JS を「存在する」ものとして扱う（再追加しない・「無い」と言わない）
//   G2 コード生成の基準の本文 = 動作テスト環境の fileKey の本文（運用環境の本文・相談を始めた時の古い本文と混ぜない）
//   G3 取得の失敗を「設定なし」「変更なし」と読まない。動作テスト環境が取れなければ計画・生成を止める（運用環境の設定で代わりに進めない）。
//      質問は運用環境の設定で答え、そのことを Context に入れる
//   G4 反映の直前: 計画を作った時点の動作テスト環境と今を内容で比べる（運用環境の revision の差では止めない・別の操作で入った変更は止める）
//   C-1 第 3 段（2026-10-08）: 会話・画面の節は新しい流れ（依頼 → 仮案 → 採用 → 計画 → 生成 → 最終案 → 承認 → 反映の準備）の上で確かめる。
//      置き換えた古い確認の流れ（仕様の確定・「C1 のコードを作って」で作る従来の生成）は使わない（JavaScript は最終案のパイプラインが作る）
//
// 実行方法: node tests/ai-acceptance-p21.test.js（KT_SRC=<別ビルド> で修正前の版に対して走らせると RED になる）
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { makeFakeHost } = require('./helpers/fake-dom.js');
const T = loadToolkit();
const { KTDeps, KTScan, KTDevBase, KTContext, KTAiClient, KTAiConversation, KTPlanReview, KTPlanExecutor, KTCodeReview, KTJsExecutor, mountAiWorkspace } = T;
// C-1 第 3 段（2026-10-08）: 新しい流れの共有の部品（仮案の応答の正規化・生成工程の能力の印）
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const { makeEnvGetter, fileEntry } = require('./helpers/dev-base-fake.js');

const clone = (v) => JSON.parse(JSON.stringify(v));
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], addMappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], ...o });
const step = (id, actionType, targetKind, targetRef, sp = {}, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PREVIEW_SUPPORTED', supported: true, reason: 'x' }, ...extra });
const pf = (temporaryId, label, suggestedCode, type, extra = {}) => ({ temporaryId, label, suggestedCode, type, typeValid: true, required: false, options: [], reason: '', evidenceIds: [], alternativeExistingFieldCode: null, codeConflict: false, labelDuplicate: false, ...extra });
const plan = (steps, proposedFields = [], extra = {}) => ({ planVersion: '1', requestId: 'tk-p21', goal: 'g', assessment: { summary: '' }, relevantFields: [], proposedFields, steps, alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', solution: 'STANDARD', customizations: [], ...extra });
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
// ---- C-1 第 3 段（2026-10-08）: 新しい流れ（依頼 → 仮案 →「これで進めて」で採用 → 最終案）を通す部品 ----
/** 仮案の台本: 依頼の文を実現する動作にした仮案（判断・要件は無い。採用まで 1 往復） */
const draftRaw = (u) => ({ reply: `「${u}」を実現する変更案にできます。`, intent: 'propose', proposal: { behaviors: [{ text: u, origin: 'user' }], assumptions: [], decisions: [], approach: { standard: [], js: ['JavaScript で実現する'] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [] } });
/** 画面の接続先に仮案の能力（health の conversation の proposal と client.propose）と、生成工程の能力の印を足す */
const withProposal = (health, client) => {
  health.registry.toolkit['assistant-qa'].conversation = ['requirements', 'stream', 'proposal'];
  if (!health.registry.toolkit['customization-generator'].verification) health.registry.toolkit['customization-generator'].verification = ['requirementId', ...K.GEN_EFFECT_FEATURES];
  client.propose = async ({ ctx, requestId, onText }) => { const raw = draftRaw(ctx.question); if (typeof onText === 'function') onText(raw.reply); return K.normalized(raw, requestId); };
  return client;
};
/** 画面: 依頼 → 仮案 →「これで進めて」で採用 → 最終案（最初の計画と JavaScript の生成・検証） */
const planOnScreen = async (panel, goal) => { await panel.send(goal); await tick(10); await panel.send('これで進めて'); await tick(16); return panel.conversation().activePlan(); };
/**
 * 最終案の承認の記録（会話コントローラの approveFinal。承認できない最終案は承認されない）。
 *   §0e.1（2026-10-09）: 画面の承認は最終案のカードの［動作テスト環境へ反映］1 回で登録まで進むので、登録の準備・確認の部品の照合（古い版・確認の項目）を
 *   確かめるこの節では、承認の記録だけを作って部品（startJsRegister / confirmJsRegister）を呼ぶ。画面のボタンで結果まで進める回帰は ai-flow-redesign の §G
 */
const approveOnScreen = async (host, panel) => { void host; const v = panel.conversation().activePlan(); const r = panel.conversation().approveFinal({ planId: v.planId, version: v.version }); await tick(4); return !!(r.ok && v.approval && panel.conversation().approvalValid().ok); };
/** 会話コントローラ: 依頼 → 仮案 →「これで進めて」で採用 → 最初の計画 */
const startPlan = async (c, goal) => { await c.send(goal); return c.send('これで進めて'); };

// ---- 場面: 動作テスト環境に「フィールド追加・一覧追加・JS の変更と追加」が入っている（運用環境は元のまま）。ページを再読み込みした後 ----
const LOCK_V1 = [
  "(function () {",
  "  'use strict';",
  "  kintone.events.on(['app.record.edit.show'], function (event) {",
  "    if (event.record['ステータス'].value === '承認済み') {",
  "      event.record['amount'].disabled = true;",
  "    }",
  "    return event;",
  "  });",
  "})();",
].join('\n');
// 動作テスト環境で登録し直した版（値引率もロックする）
const LOCK_V2 = LOCK_V1.replace("      event.record['amount'].disabled = true;", "      event.record['amount'].disabled = true;\n      event.record['discount_rate'].disabled = true;");
// 動作テスト環境にだけある JS（別の操作で登録された）
const CHECK = [
  "(function () {",
  "  'use strict';",
  "  kintone.events.on(['app.record.create.submit', 'app.record.edit.submit'], function (event) {",
  "    const v = Number(event.record['discount_rate'].value || 0);",
  "    if (v > 30) event.record['discount_rate'].error = '値引率は 30% までです';",
  "    return event;",
  "  });",
  "})();",
].join('\n');
const PROD = FX.makeData();
PROD.customize = { scope: 'ALL', desktop: { js: [fileEntry('pd:lock', 'dealLock.js', LOCK_V1)], css: [] }, mobile: { js: [], css: [] } };
const PREV = clone(PROD);
PREV.fields.discount_rate = { type: 'NUMBER', code: 'discount_rate', label: '値引率', noLabel: false, required: false, unit: '%', unitPosition: 'AFTER' };
PREV.views.views['値引あり'] = { type: 'LIST', name: '値引あり', id: '9001', index: '2', fields: ['case_name', 'discount_rate'], filterCond: 'discount_rate > 0', sort: 'レコード番号 desc' };
PREV.customize = { scope: 'ALL', desktop: { js: [fileEntry('pv:lock', 'dealLock.js', LOCK_V2), fileEntry('pv:check', 'discountCheck.js', CHECK)], css: [] }, mobile: { js: [], css: [] } };
const FILES = { 'pd:lock': LOCK_V1, 'pv:lock': LOCK_V2, 'pv:check': CHECK };
const NOW = () => Date.parse('2026-10-04T01:00:00Z');
const loadBase = (opts = {}) => { const g = makeEnvGetter({ preview: PREV, production: PROD, files: FILES, ...opts }); return { g, p: KTDevBase.load({ appId: '310', getImpl: g.getImpl, download: g.download, now: NOW }) }; };

(async () => {
// =========================================================
console.log('\n--- G1. 作業基準（KTDevBase.load）: 動作テスト環境を基準にし、運用環境との差を区別して持つ ---');
let BASE = null;
{
  assert(typeof KTDevBase === 'object' && KTDevBase && typeof KTDevBase.load === 'function', 'G1: 開発支援の作業基準（KTDevBase）がある');
  const { g, p } = loadBase();
  const base = await p;
  BASE = base;
  assert(base.ok && base.env === 'preview' && base.status === 'OK' && base.revision.preview === '12' && base.revision.production === '10', '基準は動作テスト環境（revision 12）。運用環境（revision 10）は比較用');
  assert(!!base.data.fields.discount_rate && !base.productionData.fields.discount_rate, '動作テスト環境にだけあるフィールド（値引率）が基準の DATA にある');
  const it = (pred) => base.diff.items.find(pred);
  assert(base.diff.available && it(i => i.kind === 'field' && i.id === 'discount_rate' && i.change === 'PREVIEW_ONLY' && /動作テスト環境にだけあります/.test(i.message)), '差: フィールド「値引率」は動作テスト環境にだけある（運用環境には未反映）');
  assert(it(i => i.kind === 'view' && i.id === '値引あり' && i.change === 'PREVIEW_ONLY'), '差: 一覧「値引あり」は動作テスト環境にだけある');
  assert(it(i => i.kind === 'customize' && i.name === 'dealLock.js' && i.change === 'CHANGED' && i.previewHash === KTScan.hashText(LOCK_V2) && i.productionHash === KTScan.hashText(LOCK_V1)), '差: dealLock.js は内容が違う（両方の本文の指紋で比べる）');
  assert(it(i => i.kind === 'customize' && i.name === 'discountCheck.js' && i.change === 'PREVIEW_ONLY'), '差: discountCheck.js は動作テスト環境にだけある');
  assert(!it(i => i.kind === 'field' && i.id === 'amount') && !it(i => i.kind === 'process' || i.kind === 'process-state' || i.kind === 'process-action'), '同じ設定は差に出さない（金額・プロセス管理）');
  const lock = base.files.find(f => f.name === 'dealLock.js');
  assert(lock && lock.env === 'preview' && lock.fileKey === 'pv:lock' && lock.text === LOCK_V2, '基準の本文は動作テスト環境の fileKey（pv:lock）で取った本文（運用環境の本文ではない）');
  assert(g.downloads.includes('pv:lock') && g.downloads.includes('pv:check') && g.downloads.includes('pd:lock') && base.productionFiles.find(f => f.name === 'dealLock.js').text === LOCK_V1, '運用環境の本文は差の比較のためだけに取る（productionFiles に分けて持つ）');
  assert(g.calls.includes('/k/v1/preview/app/form/fields') && g.calls.includes('/k/v1/app/form/fields') && !g.calls.some(c => /deploy|PUT|POST/.test(c)), 'GET だけ（動作テスト環境と運用環境の両方）。設定は変更しない');
  assert(base.scan && base.scan.meta.source === 'preview', '解析（Field Scanner と同じ）も動作テスト環境の本文で作る（source: preview）');
  const sf = KTScan.summarizeFiles(base.scan, base.data);
  assert(sf.find(f => f.name === 'dealLock.js').text === LOCK_V2 && sf.some(f => f.name === 'discountCheck.js' && f.sourceAvailable && f.events.includes('app.record.edit.submit')), 'JS の一覧・本文・イベントは動作テスト環境のもの（運用環境のキャッシュと混ぜない）');
  assert(base.deps && base.deps.nodes.some(n => n.id === 'FIELD:discount_rate'), '依存関係も動作テスト環境の設定で作り直す');
}

// =========================================================
console.log('\n--- G1. Context: 再読み込み後でも動作テスト環境にだけある項目を「存在する」として渡し、運用環境へ反映済みとは書かない ---');
{
  const inputs = KTDevBase.inputsOf(BASE);
  assert(inputs && inputs.data === BASE.data && inputs.environment && inputs.environment.env === 'preview', 'inputsOf: 基準の DATA と environment（facts・注記）');
  const ctx = KTContext.buildPlan({ goal: '値引率に入力チェックを追加したい', data: inputs.data, deps: inputs.deps, scan: inputs.scan, incoming: null, options: { environment: inputs.environment } });
  const base = ctx.facts.find(f => f.key === 'ENV:base');
  assert(base && base.kind === 'environment' && /作業の基準は動作テスト環境/.test(base.statement) && /運用環境へ反映済みとは扱わない/.test(base.statement), 'Planner Context: 作業の基準（動作テスト環境）と「反映済みと扱わない」を明記');
  assert(ctx.facts.some(f => f.kind === 'env-diff' && /値引率/.test(f.statement)) && ctx.facts.some(f => f.kind === 'env-diff' && /dealLock\.js/.test(f.statement)), 'Planner Context: 運用環境との差（env-diff）');
  const fd = ctx.facts.find(f => f.kind === 'field' && f.field && f.field.code === 'discount_rate');
  assert(fd && /はフォームに存在する（動作テスト環境にだけある（運用環境には未反映））/.test(fd.statement) && fd.field.environment, 'Planner Context: 値引率は「存在する（動作テスト環境にだけある）」— 再追加の提案をさせない');
  assert(ctx.dictionary.fieldCodes.includes('discount_rate') && ctx.dictionary.jsFiles.includes('discountCheck.js'), 'dictionary にも動作テスト環境にだけある識別子が入る（「存在しない」と扱わない）');
  const jf = ctx.facts.find(f => f.kind === 'js-file' && f.jsFile && f.jsFile.name === 'dealLock.js');
  assert(jf && jf.jsFile.sourceAvailable && /discount_rate/.test(jf.statement) && /動作テスト環境で内容が変わっている/.test(jf.statement), 'js-file fact: 動作テスト環境の本文の解析（discount_rate も制御）と「内容が変わっている」');
  assert(ctx.facts.some(f => f.key === 'ENV:history' && /保存していません/.test(f.statement) && /推測で述べない/.test(f.statement)), '会話・承認・理由は保存していない（設定から意図や承認を復元しない）');
  const qa = KTContext.build({ question: '現在の状態と運用環境との差分を説明して', data: inputs.data, deps: inputs.deps, scan: inputs.scan, incoming: null, options: { environment: inputs.environment } });
  assert(qa.facts[0].kind === 'environment' && qa.facts.filter(f => f.kind === 'env-diff').length === BASE.diff.items.length, '質問の Context（会話履歴なし）にも作業の基準と差の全件（先頭に置き、上限で削られない）');
  // 運用環境の設定（Phase 20 まで）の Context では値引率が無い → AI は「無い」と答え、追加を提案した
  const old = KTContext.buildPlan({ goal: '値引率に入力チェックを追加したい', data: PROD, deps: null, scan: null, incoming: null });
  assert(!old.dictionary.fieldCodes.includes('discount_rate'), '前提: 運用環境の設定で作る Context には値引率が無い（Phase 20 までの不具合の原因）');
}

// =========================================================
console.log('\n--- G1. Review: 動作テスト環境を基準に検証する（追加済みのフィールドを再び追加する計画を見逃さない）---');
{
  const inputs = KTDevBase.inputsOf(BASE);
  const p = plan([step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'NUMBER' })], [pf('NEW_FIELD_1', '値引率', 'discount_rate', 'NUMBER')]);
  const onPreview = KTPlanReview.review({ plan: p, data: inputs.data, deps: inputs.deps, scan: inputs.scan, incoming: null });
  const onProd = KTPlanReview.review({ plan: p, data: PROD, deps: null, scan: null, incoming: null });
  const bad = (r) => r.steps[0].status === KTPlanReview.STATUS.INVALID || r.steps[0].safety === KTPlanReview.SAFETY.BLOCKED || (r.steps[0].issues || []).some(i => i.severity === 'high');
  console.log('   issues(preview):', onPreview.steps[0].issues.map(i => i.code).join(','), '/ issues(prod):', onProd.steps[0].issues.map(i => i.code).join(','));
  assert(bad(onPreview) && !bad(onProd), '動作テスト環境で検証すると「値引率は既にある」で止まる（運用環境の設定では見逃していた）');
  const pLookup = plan([step('P1', 'ADD_VIEW', 'NEW_SETTING', '値引率の一覧', { name: '値引率の一覧', fields: ['case_name', 'discount_rate'] })]);
  const r2 = KTPlanReview.review({ plan: pLookup, data: inputs.data, deps: inputs.deps, scan: inputs.scan, incoming: null });
  assert(!(r2.steps[0].issues || []).some(i => /UNKNOWN|NOT_FOUND|MISSING/.test(i.code) && /discount_rate/.test(i.message || '')), '動作テスト環境にだけあるフィールドを使う手順を「存在しない」と言わない');
}

// =========================================================
console.log('\n--- G3. 取得の失敗を「なし」と読まない・運用環境へ黙って切り替えない ---');
{
  const denied = Object.assign(new Error('権限がありません。'), { code: 'CB_NO02', status: 403 });
  const b1 = await loadBase({ fail: { 'preview:app/status': denied } }).p;
  assert(!b1.ok && b1.status === 'PERMISSION_DENIED' && /権限/.test(b1.message) && KTDevBase.inputsOf(b1) === null, '動作テスト環境の必須の設定が取れない → 基準なし（inputsOf は null。運用環境で代用しない）');
  const env1 = KTDevBase.environmentOf(b1);
  assert(env1.env === 'production' && env1.facts.length === 1 && /動作テスト環境の設定を取得できませんでした/.test(env1.facts[0].statement) && /「無い」とは言えません/.test(env1.facts[0].statement), '質問用の Context には「運用環境の設定で答えている・動作テスト環境の変更は含まない」を入れる');
  const b2 = await loadBase({ fail: { 'preview:record/acl': new Error('timeout') } }).p;
  assert(b2.ok && KTDevBase.facts(b2).some(f => f.key === 'ENV:missing:recordAcl' && /「無い」とは判断しない/.test(f.statement)), '任意の設定（レコードのアクセス権）が取れない → 基準にはするが「無い」とは扱わない fact');
  const b3 = await loadBase({ fail: { 'production:app/form/fields': new Error('network') } }).p;
  assert(b3.ok && !b3.diff.available && KTDevBase.facts(b3).some(f => f.key === 'ENV:diff' && /差は分かりません/.test(f.statement) && /差が無いとは言えません/.test(f.statement)), '運用環境が取れない → 差は「分からない」（差なしとは言わない）');
  const b4 = await loadBase({ fail: { 'file:pv:lock': new Error('download failed') } }).p;
  const lock4 = b4.files.find(f => f.name === 'dealLock.js');
  assert(b4.ok && lock4.sourceAvailable === false && lock4.text === undefined && KTScan.summarizeFiles(b4.scan, b4.data).find(f => f.name === 'dealLock.js').sourceAvailable === false, '動作テスト環境の本文が取れない → 本文なし（運用環境の本文で補わない）');
  assert(KTDevBase.facts(b4).some(f => f.key === 'ENV:file:desktop:dealLock.js' && /運用環境の本文で代用しないこと/.test(f.statement)), '本文が取れなかったことを Context に入れる');
}

// =========================================================
console.log('\n--- G1 / G2 / G3（画面）. 再読み込みした後の新しい会話: 計画・質問・生成が動作テスト環境を基準にする ---');
{
  const storage = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' });
  settings.setConsent(true);
  const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'] }, 'change-planner': { implemented: true, promptVersions: ['1'] }, 'customization-generator': { implemented: true, promptVersions: ['1'] } } }, contract: { usage: { usedThisMonth: 1, monthlyLimit: 200 } } };
  const CUST = { customizationId: 'C1', requirement: '値引率が 30 を超えたら保存できないようにする（既存の dealLock.js に統合）', whyStandardInsufficient: '標準の入力チェックでは上限値をこの条件で出し分けられない', strategy: 'EXTEND_EXISTING_JS', platform: ['desktop'], implementation: 'JAVASCRIPT', events: ['app.record.edit.submit'], fields: [{ code: 'discount_rate', access: 'READ' }], apis: [], existingFiles: [{ name: 'dealLock.js', target: 'desktop', reason: '既存の制御' }], risks: [], questions: [], dependsOn: [], evidenceIds: [] };
  const PLAN_RESP = { ok: true, contractVersion: '2.1', meta: { requestId: 'pl-21', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm' }, usage: { usedThisMonth: 1, monthlyLimit: 200 } }, plan: { goal: '値引率に入力チェックを追加したい', solution: 'CUSTOMIZATION', assessment: { summary: 's', usableExistingFields: [], usableExistingSettings: [], gaps: [], evidenceIds: [] }, relevantFields: [], proposedFields: [], steps: [step('C1', 'CUSTOMIZATION_REQUIRED', 'JS', 'dealLock.js', { customizationId: 'C1' }, { solution: 'CUSTOMIZATION', execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' } })], alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', customizations: [CUST] } };
  const planCalls = [], askCalls = [], genCalls = [];
  const client = {
    async getHealth() { return HEALTH; },
    async plan({ ctx, requestId }) { planCalls.push(ctx); const v = KTAiClient.validatePlan(PLAN_RESP, ctx); if (!v.ok) throw new Error(JSON.stringify(v.errors)); return { ...v.normalized, requestId, clientWarnings: v.warnings }; },
    async ask({ ctx }) { askCalls.push(ctx); return { answer: '差は 4 件です', citations: [], requestId: 'qa-1' }; },
    async generate({ ctx, requestId }) {
      genCalls.push(ctx);
      const anchor = "      event.record['discount_rate'].disabled = true;";
      return { requestId, strategy: 'EXTEND_EXISTING_JS', targetFile: 'dealLock.js', summary: '値引率の上限チェックを追加', code: '', patch: { baseHash: ctx.existingFile.hash, operations: [{ type: 'INSERT_AFTER', anchor: "  });", content: "\n  kintone.events.on(['app.record.edit.submit'], function (event) {\n    if (Number(event.record['discount_rate'].value || 0) > 30) event.error = '値引率は 30% までです';\n    return event;\n  });" }] }, events: ['app.record.edit.submit'], fields: [{ code: 'discount_rate', access: 'READ' }], apis: [], assumptions: [], warnings: [], gatewayChecks: {} , _anchorUsed: anchor,
        //   C-1 第 3 段: 生成工程の機械検査で止まった候補にする（検証済みにならないので、後の「C1 のコードを作って」は作り直しの対象になる。
        //   基準が取れないときに、その作り直しで生成工程を呼ばないことを確かめるため）
        verification: { version: '1', passed: false, machine: [{ name: 'syntax', ok: false, severity: 'block', message: '構文エラー（テスト）' }], requiredEffects: [], behavior: { status: 'not-run', reason: null, cases: [] }, repairs: { count: 0, reasons: [], stoppedBy: null }, unverified: [] } };
    },
  };
  withProposal(HEALTH, client);   // C-1 第 3 段: 仮案の能力がある接続先（無い接続先は「接続先が非対応」で計画・生成に進まない）
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner,customization-generator', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const flow = { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false };
  let loaderMode = 'ok', loads = 0;
  const loadDevBase = async () => { loads++; return (loaderMode === 'ok' ? loadBase() : loadBase({ fail: { 'preview:app/form/fields': Object.assign(new Error('通信に失敗しました'), { code: null }) } })).p; };
  const host = makeFakeHost();
  // 運用環境の DATA（ページを開いた時点）だけを getInputs で渡す（Phase 20 までの入力）。基準は loadDevBase
  const panel = mountAiWorkspace(host, { getInputs: () => ({ data: PROD, deps: KTDeps.buildDependencyData(PROD, KTDeps.normalizeFields(PROD.fields)), scan: null, incoming: null }), copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: flow, executor: { api: makeKintoneMock(PREV, { jsSources: [{ name: 'dealLock.js', target: 'desktop', text: LOCK_V2 }, { name: 'discountCheck.js', target: 'desktop', text: CHECK }] }).api, appId: '310' }, loadDevBase });
  await tick(10);
  assert(loads >= 1 && panel.devBase() && panel.devBase().ok, '接続を確認したら作業の基準（動作テスト環境）を取得する');
  const head = host.querySelector('#kt-ai-header').innerHTML;
  // 2026-10-06 利用者の指示で意図して更新: ヘッダーは「反映先：動作テスト環境（運用環境は変更しません）」の後ろに作業の基準
  //   「HH:MM 取得・運用環境との差 N 件」［差分を見る］［再取得］。「今回の変更の基準」「revision」の語は出さない（詳しい内容は右の「詳細情報」）
  assert(/反映先：<b>動作テスト環境<\/b>（運用環境は変更しません）/.test(head) && /<span id="kt-ai-base" class="kt-ai-base is-ok">\d{2}:\d{2} 取得・運用環境との差 4 件</.test(head) && /data-act="open-base-diff"[^>]*>差分を見る</.test(head) && /data-act="refresh-base"[^>]*>再取得</.test(head) && !/今回の変更の基準|revision/.test(head), `画面: 反映先（動作テスト環境）と、作業の基準の取得時刻・運用環境との差の件数（4 件）・［差分を見る］［再取得］（「今回の変更の基準」「revision」は出さない）: ${head.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').slice(0, 200)}`);
  // ［差分を見る］→ 右の「詳細情報」に作業の基準の内容（運用環境へ未反映の変更 4 件・revision）を出す
  await host.querySelector('#kt-ai-header').dispatch({ type: 'click', target: { dataset: { act: 'open-base-diff' } } }); await tick();
  const baseDetail = host.querySelector('#kt-ai-base-diff').innerHTML;
  assert(panel.drawerState().pane === 'evidence' && /運用環境へ未反映の変更（4 件）/.test(baseDetail) && /動作テスト環境 revision 12/.test(baseDetail), `画面: ［差分を見る］で右の「詳細情報」に運用環境との差（4 件）と revision を出す（ヘッダーには出さない詳しい内容）: ${panel.drawerState().pane}`);
  // 新しい会話（会話履歴なし）で、現在の状態と運用環境との差を聞く → 質問の Context に作業の基準と差
  await panel.send('現在の状態と運用環境との差分を説明して');
  const qctx = askCalls[askCalls.length - 1];
  assert(qctx && qctx.facts.some(f => f.key === 'ENV:base' && /動作テスト環境/.test(f.statement)) && qctx.facts.filter(f => f.kind === 'env-diff').length === 4, '質問: 作業の基準と差（4 件）を Context に入れて AI に渡す');
  // 追加したフィールドを指定して入力チェックを依頼 → 計画の Context は動作テスト環境
  //   C-1 第 3 段: 依頼 → 仮案 → 採用で計画を作る（JavaScript は最終案のパイプラインが続けて作る）
  const before = loads;
  await planOnScreen(panel, '値引率に入力チェックを追加したい');
  const pctx = planCalls[planCalls.length - 1];
  assert(loads > before, '計画の前に作業の基準を取り直す（別の操作で入った変更も拾う）');
  assert(pctx && pctx.dictionary.fieldCodes.includes('discount_rate') && pctx.facts.some(f => f.kind === 'field' && f.field.code === 'discount_rate' && /動作テスト環境にだけある/.test(f.statement)), '計画: 値引率は存在する（動作テスト環境にだけある）として AI に渡す');
  const v = panel.conversation().activePlan();
  assert(v && v.review && v.review.base && v.review.base.env === 'preview' && v.review.base.revision.preview === '12' && v.review.base.fingerprint === KTDevBase.fingerprint(panel.devBase()), '計画の Review に基準（動作テスト環境・revision・指紋）を残す');
  // コード生成: 統合先の本文は動作テスト環境の本文（運用環境の本文でも、相談時の古い本文でもない）。
  //   C-1 第 3 段: 仕様の確定と「C1 のコードを作って」は無くなり、最終案を作るときに生成する（tests/ai-flow-redesign.test.js の F7）
  const gctx = genCalls[genCalls.length - 1];
  assert(gctx && gctx.existingFile && gctx.existingFile.source === LOCK_V2 && gctx.existingFile.hash === KTScan.hashText(LOCK_V2) && !gctx.existingFile.source.includes('（運用環境）'), '生成: 統合先 dealLock.js の本文は動作テスト環境の版（値引率のロックを含む）');
  const ge = panel.generated('C1');
  assert(ge && ge.existingSource && ge.existingSource.from === 'preview-base' && ge.existingSource.env === 'preview', '生成の記録に本文の出どころ（動作テスト環境の基準）');
  // 基準を取れなくなったら、計画・生成を止める（AI を呼ばない）。質問は運用環境の設定で答え、そのことを Context に入れる
  loaderMode = 'fail';
  const nPlan = planCalls.length, nGen = genCalls.length;
  const r1 = await panel.send('値引率を必須にしたい');
  const errMsg = [...panel.conversation().messages()].reverse().find(m => m.type === 'ERROR');
  assert(planCalls.length === nPlan && errMsg && /動作テスト環境の設定を取得できなかったため、変更計画の作成を止めました/.test(errMsg.text) && /運用環境の設定で代わりに進めることはしません/.test(errMsg.text), '基準が取れない: 計画を作らない（AI を呼ばない）。理由と「運用環境で代用しない」を表示');
  // 2026-10-06 利用者の指示で意図して更新: 文は「動作テスト環境の設定を取得できませんでした（…）。変更案・コードの作成と反映は止めています（運用環境の設定では進めません）。」
  const headErr = host.querySelector('#kt-ai-header').innerHTML;
  assert(/<span id="kt-ai-base" class="kt-ai-base is-error" style="color:#c62828;">動作テスト環境の設定を取得できませんでした（/.test(headErr) && /変更案・コードの作成と反映は止めています（運用環境の設定では進めません）。/.test(headErr) && /data-act="refresh-base"[^>]*>再取得</.test(headErr) && !/今回の変更の基準/.test(headErr), `画面: 基準を取得できなかったことと、変更案・コードの作成と反映を止めていること（運用環境で代用しない）を赤で表示・［再取得］: ${headErr.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').slice(0, 300)}`);
  await panel.send('C1 のコードを作って');
  assert(genCalls.length === nGen, '基準が取れない: コード生成もしない');
  await panel.send('このアプリの通知先は誰ですか？');
  const qctx2 = askCalls[askCalls.length - 1];
  assert(qctx2 && qctx2.facts.some(f => f.key === 'ENV:base' && /運用環境の設定/.test(f.statement) && /動作テスト環境の設定を取得できませんでした/.test(f.statement)), '質問は運用環境の設定で答え、そのことを Context に入れる');
}

// =========================================================
console.log('\n--- G4. 反映の直前: 計画を作った時点の動作テスト環境と今を内容で比べる ---');
{
  const inputs = KTDevBase.inputsOf(BASE);
  const p = plan([step('P1', 'ADD_VIEW', 'NEW_SETTING', '値引率の大きい案件', { name: '値引率の大きい案件', fields: ['case_name', 'amount', 'discount_rate'], filterCond: 'discount_rate >= 10', sort: 'レコード番号 desc' })]);
  const rv = KTPlanReview.review({ plan: p, data: inputs.data, deps: inputs.deps, scan: inputs.scan, incoming: null });
  rv.base = KTDevBase.stamp(BASE);
  const out = KTPlanReview.executorOutput(p, rv, ['P1']);
  // 動作テスト環境（revision 12）は計画の時点と同じ。運用環境（views の revision）は 10 で古い
  const mock = makeKintoneMock(PREV);
  mock.st.revision = 12; mock.st.prodRevision = 10;
  const prep = await KTPlanExecutor.prepare(out, { api: mock.api, appId: '310' });
  assert(prep.status === 'PREPARED' && prep.stale.status === 'FRESH' && prep.revision.reviewedEnv === 'preview', '動作テスト環境が計画の時点と同じなら FRESH（運用環境に未反映の変更があっても止めない）');
  // 運用環境の設定で作った計画（Phase 20 まで）は、動作テスト環境に未反映の変更があると必ず止まっていた（運用環境にもあるフィールドだけの一覧でも）
  const pOld = plan([step('P1', 'ADD_VIEW', 'NEW_SETTING', '金額の大きい案件', { name: '金額の大きい案件', fields: ['case_name', 'amount'], filterCond: 'amount >= 1000000', sort: 'レコード番号 desc' })]);
  const rvProd = KTPlanReview.review({ plan: pOld, data: PROD, deps: null, scan: null, incoming: null });
  const prepOld = await KTPlanExecutor.prepare(KTPlanReview.executorOutput(pOld, rvProd, ['P1']), { api: mock.api, appId: '310' });
  console.log('   old blockers:', prepOld.blockers.map(b => b.code).join(','));
  assert(prepOld.status === 'BLOCKED' && prepOld.blockers.some(b => b.code === 'STALE_PLAN'), '前提: 運用環境の設定で作った計画は、動作テスト環境に未反映の変更があると STALE_PLAN（Phase 20 までの挙動）');
  // 別の操作で動作テスト環境が変わった（計画の後にフィールドが追加された）→ 競合として止める
  const mock2 = makeKintoneMock(PREV);
  mock2.st.revision = 13; mock2.st.prodRevision = 10;
  mock2.st.fields.coupon_code = { type: 'SINGLE_LINE_TEXT', code: 'coupon_code', label: 'クーポン', noLabel: false, required: false };
  const prep2 = await KTPlanExecutor.prepare(out, { api: mock2.api, appId: '310' });
  assert(prep2.status === 'BLOCKED' && prep2.blockers.some(b => b.code === 'STALE_PLAN') && prep2.stale.diffs.some(d => d.id === 'coupon_code' && /計画を作った後の変更/.test(d.message)), '計画の後に別の操作で入った変更（クーポン）を競合として止める');
  // revision だけが進んだ（内容は同じ）→ 止めずに記録
  const mock3 = makeKintoneMock(PREV);
  mock3.st.revision = 14; mock3.st.prodRevision = 10;
  const prep3 = await KTPlanExecutor.prepare(out, { api: mock3.api, appId: '310' });
  assert(prep3.status === 'PREPARED' && prep3.warnings.some(w => w.code === 'PREVIEW_REVISION_ADVANCED'), 'revision だけが進み内容が同じ → 止めずに記録（PREVIEW_REVISION_ADVANCED）');
}

// =========================================================
console.log('\n--- G2. 生成後に統合先の本文が変わった → 登録しない（運用環境の古い JS で上書きしない）---');
{
  const ch = KTJsExecutor.changeFromGenerated({ customization: { customizationId: 'C1', platform: ['desktop'], fields: [], events: [] }, generated: { strategy: 'EXTEND_EXISTING_JS', code: '', targetFile: 'dealLock.js', summary: '' }, review: { status: KTCodeReview.STATUS.OK, finalCode: LOCK_V2 + '\n// added', checks: [] }, existingSource: { name: 'dealLock.js', target: 'desktop', text: LOCK_V2 } });
  assert(ch.ok && ch.change.baseHash === KTScan.hashText(LOCK_V2), '前提: 生成の基準は動作テスト環境の本文（LOCK_V2）');
  const mock = makeKintoneMock(PREV, { jsSources: [{ name: 'dealLock.js', target: 'desktop', text: LOCK_V2 + '\n// 別の人が直した' }] });
  const prep = await KTJsExecutor.prepare({ appId: '310', changes: [ch.change] }, { api: mock.api });
  assert(prep.status === 'BLOCKED' && prep.blockers.some(b => b.code === 'JS_SOURCE_CHANGED'), '生成の後に動作テスト環境の本文が変わっていれば JS_SOURCE_CHANGED（上書きしない）');
  const mockSame = makeKintoneMock(PREV, { jsSources: [{ name: 'dealLock.js', target: 'desktop', text: LOCK_V2 }] });
  const prepOk = await KTJsExecutor.prepare({ appId: '310', changes: [ch.change] }, { api: mockSame.api });
  assert(prepOk.status === 'PREPARED', '本文が生成の時点と同じなら登録の準備ができる');
}

// =========================================================
console.log('\n--- G7. JS の登録の判定（KTCodeReview.registration）: 静的に確かめられる要件違反は登録不可・確かめられないことは確認・それ以外は動作未確認 ---');
const REG = (() => {
  const data = FX.makeData();
  data.fields.items = { type: 'SUBTABLE', code: 'items', label: '明細', noLabel: false, fields: { item_name: { type: 'SINGLE_LINE_TEXT', code: 'item_name', label: '品名' }, qty: { type: 'NUMBER', code: 'qty', label: '数量' } } };
  const cust = (o = {}) => ({ customizationId: 'C1', requirement: '承認済みでは金額を編集不可にする', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }], apis: [], existingFiles: [], ...o });
  const gen = (code, o = {}) => ({ strategy: 'NEW_JS_FILE', targetFile: 'lock.js', summary: '承認済みで金額を編集不可', code, patch: null, events: [], fields: [], apis: [], assumptions: [], warnings: [], ...o });
  const wrap = (events, body) => `(function () {\n  'use strict';\n  kintone.events.on(${JSON.stringify(events).replace(/"/g, "'")}, function (event) {\n    const record = event.record;\n${body}\n    return event;\n  });\n})();`;
  const review = (code, c = cust(), g = {}) => KTCodeReview.review({ generated: gen(code, g), customization: c, plan: null, data, scan: null, existingSource: null });
  const chk = (rv, name) => (rv.checks || []).find(x => x.name === name) || null;
  //   §0d.4（2026-10-08）: 今の契約の生成工程（Gateway）の結果を取り込んだ判定。必須の効果は Toolkit が計画から固定したもの（KTAiConversation.requiredEffectsOf）。
  //   代表条件は効果のイベントごとに「合う」と、条件つきなら「合わない」。fail = 不合格にする代表条件（`フィールド|side`）。Gateway の requiredEffects は present・check behavior
  const gw = (rv, c, { fail = [] } = {}) => {
    const req = KTAiConversation.requiredEffectsOf({ customizations: [c] }, c.customizationId, []).effects;
    let n = 0;
    const cases = req.flatMap(x => x.events.flatMap(ev => (x.condition ? ['match', 'nomatch'] : ['match']).map(side => {
      const bad = fail.includes(`${x.field}|${side}`);
      return { id: `K${++n}`, requirementIds: x.requirementIds, field: x.field, effect: x.effect, expect: side === 'match' ? x.effect : 'not-locked', side, kind: side, event: ev, verdict: bad ? 'fail' : 'pass', observed: {}, message: bad ? `条件に合わないレコードで「${x.field}」が編集できなくなりました` : '期待どおり' };
    })));
    const ver = { version: '1', candidateHash: '0123456789abcdef', passed: true, machine: [], requiredEffects: req.map(x => ({ requirementIds: x.requirementIds, field: x.field, effect: x.effect, status: 'present', check: 'behavior', checkReason: ['conditional'], events: x.events.map(ev => ({ event: ev, status: 'present' })) })), behavior: { status: cases.some(y => y.verdict === 'fail') ? 'failed' : 'passed', reason: null, cases } };
    return KTCodeReview.attachBehavior(rv, ver, { requiredEffects: req, customization: c, effectCheck: true });
  };
  return { data, cust, gen, wrap, review, chk, gw };
})();
{
  const { cust, wrap, review, chk } = REG;
  const IF_LOCK = "    if (record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }";
  const ok = review(wrap(['app.record.edit.show'], IF_LOCK));
  //   §0d.4（2026-10-08）: 条件の内外の照合（conditional-control・unconditional-control）は Toolkit の業務の推定による判定として削除した。
  //   条件の外の編集不可は生成工程の代表条件の「合わない」側（expect not-locked）で不合格になる（AI版 worker/test/cases/required-effects.mjs の
  //   「lock: 条件に合う（承認済）→ lock・合わない（作成中）→ not-locked」「A3 F5」「A1 E1c」「A1 E1b」）。ここでは形式確認の判定（止めない・動作は未確認）だけを確かめる
  assert(ok.registration && ok.registration.verdict === 'RUNTIME_UNVERIFIED' && ok.registration.blockers.length === 0 && ok.registration.unverified.some(u => u.code === 'RUNTIME_NOT_RUN') && !chk(ok, 'conditional-control'), '条件（承認済み）の中でだけロック: 静的な検査は通過・動作は未確認（RUNTIME_UNVERIFIED）');
  // 条件の書き方が違っても誤って止めない: 変数に入れた条件・早い return で除外・名前付き関数
  const varLocked = review(wrap(['app.record.edit.show'], "    const locked = record['ステータス'].value === '承認済み';\n    if (locked) {\n      record['amount'].disabled = true;\n    }"));
  const guard = review(wrap(['app.record.edit.show'], "    if (record['ステータス'].value !== '承認済み') {\n      return event;\n    }\n    record['amount'].disabled = true;"));
  assert(varLocked.registration.verdict === 'RUNTIME_UNVERIFIED' && guard.registration.verdict === 'RUNTIME_UNVERIFIED', '条件を変数に入れる書き方・早い return で除外する書き方は通す（正常な書き方を一律に拒否しない）');
  // F42（実機）: 要件は承認済みのときだけ → 条件の外でロック → 登録不可
  //   §0d.4: 旧 conditional-control（Toolkit の静的な block）の期待は外した。今は生成工程の代表条件「合わない」（作成中のレコードで担当者が編集できる）の不合格を
  //   Toolkit が取り込んで登録不可にする（Gateway の結果の取り込みは tests/ai-flow-redesign.test.js の D38-5・D46-1〜3）
  const fieldsAO = [{ code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済み")', effects: ['lock'] }, { code: 'owner', access: 'CONTROL', condition: 'ステータス in ("承認済み")', effects: ['lock'] }];
  const outsideG = REG.gw(review(wrap(['app.record.edit.show'], IF_LOCK + "\n    record['owner'].disabled = true;"), cust({ fields: fieldsAO })), cust({ fields: fieldsAO }), { fail: ['owner|nomatch'] });
  assert(outsideG.registration.verdict === 'BLOCKED' && outsideG.checks.some(x => x.name === 'behavior-fail' && !x.ok && x.severity === 'block' && /owner/.test(x.message)), `F42: 条件つきの要件なのに条件の外でロック → 生成工程の「合わない」の不合格で登録不可: ${JSON.stringify(outsideG.registration.blockers.map(b => b.code))}`);
  // 条件が実装仕様に構造化されていない（要件の文だけ）→ 旧 unconditional-control（要件の文から条件を推定して確認にする）の期待は外した。
  //   今は Toolkit が必須の効果を固定する段階で、計画のフィールドに構造化した効果・条件が無ければ未特定（field-unspecified）・台帳の要件に条件があるのに計画に無ければ
  //   condition-unknown として準備未完了にする（tests/ai-flow-redesign.test.js の D6-4・D16-1・D22-1・D34。Gateway は文から効果・条件を推定しない:
  //   required-effects.mjs「互換: 効果の無い CONTROL は [] のまま EFFECT_UNSPECIFIED（文から推定しない）」）
  // F41: PC とモバイルの両方が対象なのに片方の画面の処理が無い → 登録不可
  const pcOnly = review(wrap(['app.record.edit.show', 'mobile.app.record.edit.show'], "    if (record['ステータス'].value === '承認済み') { record['amount'].disabled = true; }") + "\n" + wrap(['mobile.app.record.edit.show'], "    if (record['ステータス'].value === '承認済み') { record['owner'].disabled = true; }"), cust({ platform: ['desktop', 'mobile'], events: ['app.record.edit.show', 'mobile.app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }, { code: 'owner', access: 'CONTROL' }] }));
  assert(pcOnly.registration.verdict === 'BLOCKED' && pcOnly.registration.blockers.some(b => b.code === 'platform-fields' && /owner/.test(b.message)), 'F41: PC とモバイルの両方が対象で担当者のロックがモバイルだけ → 登録不可');
  const noMobile = review(wrap(['app.record.edit.show'], IF_LOCK), cust({ platform: ['desktop', 'mobile'] }));
  assert(noMobile.registration.verdict === 'BLOCKED' && noMobile.registration.blockers.some(b => b.code === 'platform') && noMobile.registration.unverified.some(u => u.code === 'MOBILE_RUNTIME_NOT_VERIFIABLE'), 'モバイルも対象なのにモバイルのイベントが無い → 登録不可。モバイルは動作テスト環境で確かめられないことも示す');
  // 対象と異なるフィールド・アプリ
  const offField = review(wrap(['app.record.edit.show'], IF_LOCK + "\n    record['approver'].value = [];"));
  assert(offField.registration.verdict === 'BLOCKED' && offField.registration.blockers.some(b => b.code === 'target-fields' && /approver/.test(b.message)), '計画に無いフィールドの値を書き換える → 登録不可（対象と異なるフィールド）');
  const offErr = review(wrap(['app.record.edit.submit'], "    if (record['ステータス'].value === '承認済み') { record['amount'].disabled = true; }\n    if (!record['due_date'].value) record['due_date'].error = '期日を入れてください';"), cust({ events: ['app.record.edit.submit'] }));
  assert(offErr.registration.verdict !== 'BLOCKED' && offErr.registration.confirmations.some(x => x.code === 'target-fields-error'), '計画に無いフィールドへのエラー表示だけ → 確認が必要（止めない）');
  const otherApp = review(wrap(['app.record.edit.submit.success'], IF_LOCK + "\n    return kintone.api(kintone.api.url('/k/v1/record', true), 'PUT', { app: 999, id: 1, record: {} }).then(function () { return event; });"), cust({ events: ['app.record.edit.submit.success'] }));
  assert(otherApp.registration.verdict === 'BLOCKED' && otherApp.registration.blockers.some(b => b.code === 'target-app' && /999/.test(b.message)), '他のアプリ（999）のレコードを書き換える → 登録不可（対象と異なるアプリ）');
  const readOther = review(wrap(['app.record.edit.show'], IF_LOCK + "\n    kintone.api(kintone.api.url('/k/v1/records', true), 'GET', { app: 500, query: '' });"));
  assert(readOther.registration.verdict === 'NEEDS_CONFIRMATION' && readOther.registration.confirmations.some(x => x.code === 'target-app-read'), '他のアプリの読み取り → 確認が必要');
  // 計画の処理が無い / 計画のイベントが無い
  const absent = review(wrap(['app.record.edit.show'], "    // 何もしない"));
  assert(absent.registration.verdict === 'BLOCKED' && absent.registration.blockers.some(b => b.code === 'planned-fields' && /amount/.test(b.message)), '計画で制御するフィールドがコードに無い → 登録不可（要件の処理が無い）');
  const noChange = review(wrap(['app.record.edit.show'], "    if (Number(record['amount'].value) >= 1000000) record['amount'].error = '100 万円以上です'; else record['amount'].error = null;"), cust({ requirement: '金額が 100 万円以上なら警告する', events: ['app.record.edit.show', 'app.record.edit.change.amount'], fields: [{ code: 'amount', access: 'CONTROL' }] }));
  assert(noChange.registration.verdict === 'BLOCKED' && noChange.registration.blockers.some(b => b.code === 'planned-events' && /change\.amount/.test(b.message)), 'BF-C: 計画の change イベントが無い（入力中に切り替わらない）→ 登録不可');
  const dyn = review("(function () {\n  'use strict';\n  const f = 'amount';\n  kintone.events.on(['app.record.edit.show', 'app.record.edit.change.' + f], function (event) {\n    if (Number(event.record['amount'].value) >= 1000000) event.record['amount'].error = 'x'; else event.record['amount'].error = null;\n    return event;\n  });\n})();", cust({ requirement: '金額が 100 万円以上なら警告する', events: ['app.record.edit.show', 'app.record.edit.change.amount'], fields: [{ code: 'amount', access: 'CONTROL' }] }));
  assert(dyn.registration.verdict !== 'BLOCKED' && dyn.registration.confirmations.some(x => x.code === 'planned-events'), 'イベント名を組み立てている（静的に特定できない）→ 止めずに確認が必要');
}

// =========================================================
console.log('\n--- G7b. 条件の外のロックの見落とし（モデル比較の CX-1 基準側で発見）: ループ・存在確認だけの条件は計画の条件の外。正常な書き方（関数・switch・else）は止めない ---');
{
  const { cust, wrap, review, chk } = REG;
  const both = cust({ requirement: '承認済みでは金額と明細を編集不可にする', fields: [{ code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }, { code: 'items', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }] });
  //   §0d.4（2026-10-08）: 条件の外のロックの静的な照合（conditional-control。ループ・存在確認・別の項目の条件・条件なしで呼ぶ関数）と、静的に追えない書き方を
  //   確認にする判定（switch・引数の条件）は、Toolkit の業務の推定による判定として削除した。条件の外のロックは生成工程の代表条件「合わない」（expect not-locked）で
  //   不合格になる（AI版 worker/test/cases/required-effects.mjs の「lock: 条件に合う（承認済）→ lock・合わない（作成中）→ not-locked」「A3 F5」「A1 E1c」。
  //   明細のループのロックは隔離環境がセルごとに記録する: sandbox/test/run.mjs の R15）。正常な書き方を止めないことも生成工程の側で守る（Gateway は if の中・早い return・
  //   関数の中の処理を機械検査の block にせず check behavior にする: required-effects.mjs「§0d.1 の 2: handler の直下で無条件でない形は behavior」）。
  //   ここでは Toolkit の形式確認が正常な書き方を止めないこと（登録不可にしない）と、生成工程の不合格を取り込んで登録不可にすることだけを確かめる
  // 基準側（gpt-4.1-mini）の差分そのもの: 承認済みの if の閉じ括弧の後ろに明細のループを足した（どのステータスでも明細が編集できなくなる）
  const leaked = "    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }\n      record['items'].value.forEach(function(row) {\n        for (const key in row.value) {\n          if (row.value.hasOwnProperty(key)) {\n            row.value[key].disabled = true;\n          }\n        }\n      });";
  const bothE = cust({ requirement: '承認済みでは金額と明細を編集不可にする', fields: [{ code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済み")', effects: ['lock'] }, { code: 'items', access: 'CONTROL', condition: 'ステータス in ("承認済み")', effects: ['lock'] }] });
  const rvLeakG = REG.gw(review(wrap(['app.record.edit.show'], leaked), bothE), bothE, { fail: ['items|nomatch'] });
  assert(rvLeakG.registration.verdict === 'BLOCKED' && rvLeakG.checks.some(x => x.name === 'behavior-fail' && x.severity === 'block' && /items/.test(x.message)) && !rvLeakG.registration.confirmations.some(x => /items/.test(x.message || '')), `ループ・hasOwnProperty だけの条件の中のロック → 生成工程の「合わない」の不合格で登録不可（同意すれば登録できる確認に落とさない）: ${JSON.stringify(rvLeakG.registration.blockers.map(b => b.code))}`);
  // 正しい位置（if の中）なら止めない
  const inside = "    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n      record['items'].value.forEach(function(row) {\n        for (const key in row.value) {\n          if (row.value.hasOwnProperty(key)) {\n            row.value[key].disabled = true;\n          }\n        }\n      });\n    }";
  const rvIn = review(wrap(['app.record.edit.show'], inside), both);
  assert(rvIn.registration.verdict !== 'BLOCKED', `if の中のループ・hasOwnProperty は止めない: ${JSON.stringify(rvIn.registration.blockers)}`);
  //   存在確認だけの if（明細があれば）の中・別の項目（担当者）の条件だけ・条件なしで呼ぶ関数の中のロック（旧 conditional-control の block）は、上と同じく生成工程の代表条件で扱う
  // 正常な書き方は止めない: 条件の中から呼ぶ関数・switch・else・関数で判定
  const helperCalled = review("(function () {\n  'use strict';\n  function lockAll(record) {\n    record['amount'].disabled = true;\n  }\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    if (event.record['ステータス'].value === '承認済み') {\n      lockAll(event.record);\n    }\n    return event;\n  });\n})();");
  assert(helperCalled.registration.verdict === 'RUNTIME_UNVERIFIED', `条件の中から呼ぶ関数の中のロックは止めない: ${JSON.stringify(helperCalled.registration)}`);
  const helperRef = review("(function () {\n  'use strict';\n  function lockAll(event) {\n    event.record['amount'].disabled = true;\n    return event;\n  }\n  const guarded = function (event) { return event.record['ステータス'].value === '承認済み' ? lockAll(event) : event; };\n  kintone.events.on(['app.record.edit.show'], guarded);\n})();");
  assert(helperRef.registration.verdict !== 'BLOCKED', `呼び出し方を静的に追えない関数の中のロックは止めない: ${JSON.stringify(helperRef.registration.blockers)}`);
  const sw = review(wrap(['app.record.edit.show'], "    switch (record['ステータス'].value) {\n      case '承認済み':\n        record['amount'].disabled = true;\n        break;\n      default:\n        break;\n    }"));
  // 段階 C: switch の case のラベル（値）は静的に読まない。条件どおりに動くかは生成工程の模擬テストで確かめる
  assert(sw.registration.verdict !== 'BLOCKED', 'switch (ステータス) の case の中のロックは止めない（値は生成工程の模擬テストで確かめる）');
  const els = review(wrap(['app.record.edit.show'], "    if (record['ステータス'].value !== '承認済み') {\n      record['amount'].disabled = false;\n    } else {\n      record['amount'].disabled = true;\n    }"));
  assert(els.registration.verdict === 'RUNTIME_UNVERIFIED', 'ステータスの if の else の中のロックは止めない');
  const fnCond = review("(function () {\n  'use strict';\n  function isApproved(record) {\n    return record['ステータス'].value === '承認済み';\n  }\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    if (isApproved(event.record)) {\n      event.record['amount'].disabled = true;\n    }\n    return event;\n  });\n})();");
  assert(fnCond.registration.verdict === 'RUNTIME_UNVERIFIED', '判定を関数にした書き方（isApproved(record)）は止めない');
  const param = review("(function () {\n  'use strict';\n  function lockIf(record, locked) {\n    if (locked) record['amount'].disabled = true;\n  }\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    lockIf(event.record, event.record['ステータス'].value === '承認済み');\n    return event;\n  });\n})();");
  assert(param.registration.verdict !== 'BLOCKED', '引数で渡した条件（中身を静的に追えない）→ 止めない');
  //   構造化されていない要件（条件は文だけ）のループのロック（旧 unconditional-control の確認）は、G7 の注のとおり必須の効果を固定する段階（field-unspecified・condition-unknown）で扱う
  // 基準側（gpt-4.1-mini）CX-1 3 回目の差分そのもの: 既存の PC の handler の中に、新しい登録（PC ＋ モバイル）を丸ごと差し込んだ
  const LOCK_BASE = "(function () {\n  'use strict';\n  // 承認済みの案件は金額を変更できないようにする（既存の運用ルール）\n  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }\n    return event;\n  });\n})();\n";
  const nestedPatch = { baseHash: null, operations: [{ type: 'INSERT_AFTER', anchor: "    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }", content: "\n  // PCとモバイルの両方のレコード作成・編集画面で承認済みなら金額と明細を編集不可にする\n  const EVENTS = ['app.record.create.show', 'app.record.edit.show', 'mobile.app.record.create.show', 'mobile.app.record.edit.show'];\n  kintone.events.on(EVENTS, function(event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n      if (record['items'] && Array.isArray(record['items'].value)) {\n        record['items'].value.forEach(function(row) {\n          for (const col in row.value) {\n            row.value[col].disabled = true;\n          }\n        });\n      }\n    }\n    return event;\n  });" }] };
  const extendBoth = cust({ strategy: 'EXTEND_EXISTING_JS', platform: ['desktop', 'mobile'], events: ['app.record.create.show', 'app.record.edit.show', 'mobile.app.record.create.show', 'mobile.app.record.edit.show'], existingFiles: [{ name: 'dealLock.js', target: 'desktop' }], requirement: '承認済みでは金額と明細を編集不可にする（PC とモバイル）', fields: [{ code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }, { code: 'items', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }] });
  nestedPatch.baseHash = KTScan.hashText(LOCK_BASE);
  const rvNested = KTCodeReview.review({ generated: REG.gen('', { strategy: 'EXTEND_EXISTING_JS', targetFile: 'dealLock.js', patch: nestedPatch, summary: '既存のdealLock.jsにモバイル対応の編集不可制御を追加' }), customization: extendBoth, plan: null, data: REG.data, scan: null, existingSource: { name: 'dealLock.js', target: 'desktop', text: LOCK_BASE } });
  assert(rvNested.registration.verdict === 'BLOCKED' && rvNested.registration.blockers.some(b => b.code === 'nested-registration' && /handler の中/.test(b.message) && /モバイルでは一度も登録されません/.test(b.message)), `既存の handler の中に新しい kintone.events.on を差し込んだ → 登録不可（nested-registration）: ${JSON.stringify(rvNested.registration.blockers.map(b => b.code))}`);
  // 即時関数の直下の関数から登録する書き方は止めない
  // 候補モデル INTEG 2 回目の差分そのもの: 登録の行を REPLACE でイベントを足し、担当者の行を if の中に足した（正しいコード）
  const replacePatch = { baseHash: KTScan.hashText(LOCK_BASE), operations: [{ type: 'REPLACE', anchor: "kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {", content: "kintone.events.on(['app.record.create.show', 'app.record.edit.show', 'app.record.index.edit.show'], function (event) {" }, { type: 'INSERT_AFTER', anchor: "      record['amount'].disabled = true;", content: "\n      record['owner'].disabled = true;" }] };
  const ownerCust = cust({ strategy: 'EXTEND_EXISTING_JS', platform: ['desktop'], events: ['app.record.create.show', 'app.record.edit.show', 'app.record.index.edit.show'], existingFiles: [{ name: 'dealLock.js', target: 'desktop' }], requirement: '承認済みでは担当者も編集不可にする', fields: [{ code: 'owner', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }, { code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }] });
  const rvReplace = KTCodeReview.review({ generated: REG.gen("kintone.events.on(['app.record.create.show', 'app.record.edit.show', 'app.record.index.edit.show'], function (event) {\n      record['owner'].disabled = true;", { strategy: 'EXTEND_EXISTING_JS', targetFile: 'dealLock.js', patch: replacePatch, summary: '承認済みでは担当者も編集不可' }), customization: ownerCust, plan: null, data: REG.data, scan: null, existingSource: { name: 'dealLock.js', target: 'desktop', text: LOCK_BASE } });
  assert(!rvReplace.registration.confirmations.some(x => x.code === 'return-event' || x.code === 'duplicate-handler') && !rvReplace.registration.blockers.length, `登録の行だけを書き換えた差分: 本体は既存のまま（return event あり）・別の handler を足したのではない: ${JSON.stringify(rvReplace.registration.confirmations.map(x => x.code))}`);
  const viaInit = review("(function () {\n  'use strict';\n  function init() {\n    kintone.events.on(['app.record.edit.show'], function (event) {\n      if (event.record['ステータス'].value === '承認済み') {\n        event.record['amount'].disabled = true;\n      }\n      return event;\n    });\n  }\n  init();\n})();");
  assert(viaInit.registration.verdict === 'RUNTIME_UNVERIFIED' && !viaInit.registration.blockers.some(b => b.code === 'nested-registration'), '初期化関数（init）の中の登録は handler の中ではない（止めない）');
}

// =========================================================
console.log('\n--- G8. 要約・詳細・検査結果の整合（明細の行の追加・削除は止められない）---');
{
  const { cust, wrap, review, chk } = REG;
  const CELLS = "    const locked = record['ステータス'].value === '承認済み';\n    if (locked) {\n      record['amount'].disabled = true;\n      record['items'].value.forEach(function (row) {\n        for (const key in row.value) { row.value[key].disabled = true; }\n      });\n    }";
  const c = cust({ requirement: '承認済みでは金額と明細を編集不可にし、明細の行の追加・削除も禁止する', fields: [{ code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }, { code: 'items', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }] });
  const rv = review(wrap(['app.record.edit.show'], CELLS), c, { summary: '承認済みでは金額と明細を編集不可にし、明細の行追加・削除も禁止する' });
  assert(rv.coverage && rv.coverage.notAchieved.some(x => x.code === 'SUBTABLE_ROWS' && /行の追加・削除は止められません/.test(x.message)) && rv.coverage.achieved.some(x => /セルを編集不可/.test(x)), '達成範囲: セルの編集不可は達成・行の追加・削除は未達（Toolkit が示す）');
  //   §0d.4（2026-10-08）: AI の要約・要件の文を正規表現で読んで確認にする判定（summary-scope・requirement-scope）と、条件の内外の照合（conditional-control）は削除した。
  //   「行の追加・削除は止められない」ことは、構造の判定（達成範囲の SUBTABLE_ROWS・コードペインの「満たせない部分」・計画の Review の JS_LIMIT_SUBTABLE_ROWS）で示す（上の 1 件と下の 2 件）
  assert(!chk(rv, 'summary-scope') && rv.registration.verdict !== 'BLOCKED', `行のループでのセルのロック（条件の中）は止めない: ${rv.registration.verdict}`);
  const { KTAiChatUi } = loadToolkit();
  const entry = { generated: REG.gen(wrap(['app.record.edit.show'], CELLS), { summary: '承認済みでは金額と明細を編集不可にし、明細の行追加・削除も禁止する' }), review: rv, existingSource: null };
  const pane = KTAiChatUi.codePaneHtml(entry);
  assert(/要件のうち満たせない部分（Toolkit の確認）: 明細（テーブル）の行の追加・削除は止められません/.test(pane.head) && /<details/.test(pane.head) && /そのまま採用しないでください/.test(pane.head) && pane.head.indexOf('満たせない部分') < pane.head.indexOf('AI の要約'), 'コードペイン: 満たせない部分を AI の要約より先に出し、要約は「食い違う」と畳む');
  // 計画の段階でも分かる（Review の手順に JS_LIMIT_SUBTABLE_ROWS）
  const data = REG.data;
  const p = plan([step('C1', 'CUSTOMIZATION_REQUIRED', 'JS', 'lock.js', { customizationId: 'C1' }, { solution: 'CUSTOMIZATION', execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' } })], [], { solution: 'CUSTOMIZATION', customizations: [{ ...c, whyStandardInsufficient: 'ステータスで編集可否を変えられない', risks: [], questions: [], dependsOn: [], evidenceIds: [], confidence: 'INFERRED', existingFiles: [] }] });
  const r = KTPlanReview.review({ plan: p, data, deps: null, scan: null, incoming: null });
  assert(r.steps[0].issues.some(i => i.code === 'JS_LIMIT_SUBTABLE_ROWS' && /運用（手順・権限）/.test(i.message)), '計画の Review: 明細の行の追加・削除の禁止は JavaScript では満たせない（生成の前に分かる）');
}

// =========================================================
console.log('\n--- G7. 登録処理の側での判定（KTJsExecutor）: 古い画面・再操作・まとめての同意で回避できない ---');
{
  const { cust, wrap, review } = REG;
  const IF_LOCK = "    if (record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }";
  const okCode = wrap(['app.record.edit.show'], IF_LOCK);
  const badCode = okCode.replace("      record['amount'].disabled = true;\n    }", "    }\n    record['amount'].disabled = true;");
  const c = cust();
  //   §0d.4（2026-10-08）: 条件の外のロック（badCode）を登録不可にしていた Toolkit の静的な判定（conditional-control）は削除した。今の契約では、生成工程の
  //   代表条件「合わない」（作成中のレコードで金額が編集できる）が不合格を返し、Toolkit がそれを取り込んで BLOCKED にする。その判定の結果（rvBad）で登録処理の側を確かめる
  const cE = cust({ fields: [{ code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済み")', effects: ['lock'] }] });
  const rvBad = REG.gw(review(badCode, cE), cE, { fail: ['amount|nomatch'] });
  const refused = KTJsExecutor.changeFromGenerated({ customization: cE, generated: REG.gen(badCode), review: rvBad });
  assert(rvBad.registration.verdict === 'BLOCKED' && !refused.ok && /登録できません/.test(refused.message), `要件違反（BLOCKED）のコードは登録の変更にできない: ${rvBad.registration.verdict}`);
  // 古い画面・直接の呼び出し: 判定が BLOCKED の変更を prepare に渡しても止まる
  const rvOk = review(okCode, c);
  const good = KTJsExecutor.changeFromGenerated({ customization: c, generated: REG.gen(okCode), review: rvOk });
  assert(good.ok && good.change.registration && good.change.registration.verdict === 'RUNTIME_UNVERIFIED' && good.change.registration.codeHash === KTScan.hashText(okCode), '前提: 通過したコードの変更には判定と検査したコードの指紋が付く');
  const forged = clone(good.change); forged.registration = { ...forged.registration, verdict: 'BLOCKED', blockers: [{ code: 'conditional-control', message: '条件の外でロック' }] };
  const mk = () => makeKintoneMock(REG.data);
  const p1 = await KTJsExecutor.prepare({ appId: '310', changes: [forged] }, { api: mk().api });
  assert(p1.status === 'BLOCKED' && p1.blockers.some(b => b.code === 'REQUIREMENT_VIOLATION'), 'prepare: 判定が登録不可の変更は止める（UI を通らない呼び出しでも）');
  const tampered = clone(good.change); tampered.content = badCode; tampered.contentHash = KTScan.hashText(badCode);
  const p2 = await KTJsExecutor.prepare({ appId: '310', changes: [tampered] }, { api: mk().api });
  assert(p2.status === 'BLOCKED' && p2.blockers.some(b => b.code === 'CONTENT_CHANGED_AFTER_REVIEW'), 'prepare: 検査の後にコードを差し替えた変更は止める');
  const p3 = await KTJsExecutor.prepare({ appId: '310', changes: [clone(good.change)], recheck: async () => ({ ...rvBad.registration }) }, { api: mk().api });
  assert(p3.status === 'BLOCKED' && p3.blockers.some(b => b.code === 'REQUIREMENT_VIOLATION' && /検査し直すと/.test(b.message)), 'prepare: 最新の基準で検査し直して登録不可なら止める（recheck）');
  const noReg = clone(good.change); delete noReg.registration;
  const p4 = await KTJsExecutor.prepare({ appId: '310', changes: [noReg] }, { api: mk().api });
  assert(p4.status === 'BLOCKED' && p4.blockers.some(b => b.code === 'REGISTRATION_UNKNOWN'), 'prepare: 検査結果の無い変更は止める');
  // 確認が必要な項目: 1 件ずつ確認したものがそろわないと登録しない（まとめての同意では通さない）
  const needCode = wrap(['app.record.edit.show'], IF_LOCK + "\n    kintone.api(kintone.api.url('/k/v1/records', true), 'GET', { app: 500, query: '' });");
  const rvNeed = review(needCode, c);
  const need = KTJsExecutor.changeFromGenerated({ customization: c, generated: REG.gen(needCode), review: rvNeed });
  const m5 = mk();
  const p5 = await KTJsExecutor.prepare({ appId: '310', changes: [need.change] }, { api: m5.api });
  assert(p5.status === 'PREPARED' && p5.verdict === 'NEEDS_CONFIRMATION' && p5.confirmations.length >= 1 && p5.confirmations.every(x => x.key && x.howToCheck) && p5.unverified.some(u => u.code === 'RUNTIME_NOT_RUN'), 'prepare: 確認が必要な項目（key・確かめること）と動作が未確認であることを返す');
  let err = null;
  try { await KTJsExecutor.executePreview(p5, { api: m5.api, acknowledged: [] }); } catch (e) { err = e; }
  assert(err && err.code === 'CONFIRMATION_REQUIRED' && !m5.calls.some(x => x === 'POST file' || x === 'PUT customize'), 'executePreview: 確認していない項目があれば登録しない（書き込みなし）');
  const ex5 = await KTJsExecutor.executePreview(p5, { api: m5.api, fieldRows: KTDeps.normalizeFields(REG.data.fields).map(f => ({ code: f.code, label: f.label, type: f.rawType })), acknowledged: p5.confirmations.map(x => x.key) });
  assert(ex5.status === 'DONE' && m5.calls.includes('PUT customize'), 'すべての項目を 1 件ずつ確認したら登録できる');
}

// =========================================================
console.log('\n--- G7（画面）. 古い版からは登録しない・確認の項目を 1 件ずつチェックしてから登録 ---');
{
  const storage = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' });
  settings.setConsent(true);
  const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'] }, 'change-planner': { implemented: true, promptVersions: ['1'] }, 'customization-generator': { implemented: true, promptVersions: ['1'], verification: ['requirementId', 'requiredEffects', 'effectGroups', 'relatedOmitted', 'appFields', 'saveDialog', 'reasonCategory', 'caseSide', 'eventCases', 'loadFaithful', 'registrationCheck', 'emptyCase', 'hideCondition', 'registrationCounts', 'caseCoverage', 'cancelCheck', 'limitCode', 'scopeList'] } } }, contract: { usage: { usedThisMonth: 1, monthlyLimit: 200 } } };
  const CUST = { customizationId: 'C1', requirement: '承認済みでは金額を編集不可にする', whyStandardInsufficient: 'ステータスで編集可否を変えられない', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済み")', effects: ['lock'] }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [], confidence: 'INFERRED' };
  const planResp = (goal) => ({ ok: true, contractVersion: '2.1', meta: { requestId: 'pl', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm' }, usage: { usedThisMonth: 1, monthlyLimit: 200 } }, plan: { goal, solution: 'CUSTOMIZATION', assessment: { summary: 's', usableExistingFields: [], usableExistingSettings: [], gaps: [], evidenceIds: [] }, relevantFields: [], proposedFields: [], steps: [step('C1', 'CUSTOMIZATION_REQUIRED', 'JS', 'lock.js', { customizationId: 'C1' }, { solution: 'CUSTOMIZATION', execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' } })], alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', customizations: [CUST] } });
  const CODE = REG.wrap(['app.record.edit.show'], "    if (record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }\n    kintone.api(kintone.api.url('/k/v1/records', true), 'GET', { app: 500, query: '' });");
  // §0c.6（2026-10-08）: 従来の流れの登録は、接続先が必須の効果の確認に対応し（health の verification に requiredEffects）、生成工程の検証が合格したものだけ。
  //   この試験は登録の経路（upload・PUT・検証・戻す）を確かめるので、偽の生成工程は Toolkit が渡した必須の効果をそのまま「処理あり・動作テストで合格」で返す
  //   （効果の区別そのものの検証は tests/ai-flow-redesign.test.js の §D）
  const passVerification = (ctx) => { const re = (ctx && ctx.verification && ctx.verification.requiredEffects) || []; return re.length ? { version: '1', passed: true, machine: [], requiredEffects: re.map(x => ({ requirementId: x.requirementId, requirementIds: x.requirementIds, field: x.field, effect: x.effect, status: 'present' })), behavior: { status: 'passed', reason: null, cases: re.flatMap((x, i) => (x.events && x.events.length ? x.events : [null]).flatMap((ev, j) => (x.condition ? ['match', 'nomatch'] : ['match']).map(side => ({ id: `K${i + 1}-${j + 1}-${side}`, requirementIds: x.requirementIds, field: x.field, effect: x.effect, expect: side === 'match' ? x.effect : ({ lock: 'not-locked', warn: 'not-warned', 'block-save': 'save-allowed', 'set-value': 'value-unchanged', 'show-hide': 'show-hide' })[x.effect], side, ...(ev ? { event: ev } : {}), verdict: 'pass', observed: {}, message: '期待どおり' })))) }, repairs: { count: 0, reasons: [], stoppedBy: null }, unverified: ['実機での動作'] } : undefined; };
  const client = {
    async getHealth() { return HEALTH; },
    async plan({ ctx, requestId }) { const v = KTAiClient.validatePlan(planResp(ctx.goal), ctx); if (!v.ok) throw new Error(JSON.stringify(v.errors)); return { ...v.normalized, requestId, clientWarnings: v.warnings }; },
    async generate({ ctx, requestId }) { return { requestId, strategy: 'NEW_JS_FILE', targetFile: 'lock.js', summary: '承認済みで金額を編集不可', code: CODE, patch: null, events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: ['kintone.api'], assumptions: [], warnings: [], gatewayChecks: {}, ...(passVerification(ctx) ? { verification: passVerification(ctx) } : {}) }; },
  };
  withProposal(HEALTH, client);   // C-1 第 3 段: 仮案の能力がある接続先
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner,customization-generator', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const flow = { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false };
  const host = makeFakeHost();
  const mock = makeKintoneMock(REG.data);
  const deps = KTDeps.buildDependencyData(REG.data, KTDeps.normalizeFields(REG.data.fields));
  //   §0c.7（2026-10-08）: 既存 JS の解析（scan）が無いと、本文もイベントも分からない既存 JS は events null（その platform のすべて）として送れなかった扱いになり、
  //   必須の効果を確かめられない（準備未完了）。この試験は登録の経路を確かめるので、アプリ解析の結果（既存 JS の本文）を渡す
  const scanG7 = (() => { const { buildScanPayload } = require('./helpers/scan-payload.js'); const fieldRows = KTDeps.normalizeFields(REG.data.fields).map(f => ({ code: f.code, label: f.label, type: f.rawType })); const sc = buildScanPayload({ KTScan, KTDeps }, { appId: FX.SELF_APP, files: FX.files, fields: fieldRows, deps, skippedUrlFiles: FX.skippedUrlFiles }); sc.results = KTScan.analyze({ fields: fieldRows, files: FX.files.filter(f => f.kind === 'js'), snippet: { before: 24, after: 48 } }); return sc; })();
  const panel = mountAiWorkspace(host, { getInputs: () => ({ data: REG.data, deps, scan: scanG7, incoming: null }), copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: flow, executor: { api: mock.api, appId: '310' } });
  await tick(8);
  //   C-1 第 3 段: 依頼 → 仮案 → 採用 → 最終案（JavaScript は最終案のパイプラインが作る。仕様の確定と「C1 のコードを作って」は無い）→ 承認
  const v1 = await planOnScreen(panel, '承認済みでは金額を編集できなくしたい');
  const g1 = panel.generated('C1');
  assert(g1 && g1.review.registration.verdict === 'NEEDS_CONFIRMATION', '前提: 生成したコードは「確認が必要」（他アプリの読み取り）');
  const ok1 = await approveOnScreen(host, panel);
  assert(ok1 && v1.final && v1.final.approvable, `前提: 最終案（v1）を承認した: ${v1.final && v1.final.blockingReason}`);
  // 計画を修正して新しい版ができた後に、古い版のカードから登録しようとする
  await panel.send('承認待ちでも金額を編集不可にして', { intent: KTAiConversation.INTENT.REVISE_PLAN }); await tick(16);
  const v2 = panel.conversation().activePlan();
  assert(v2 !== v1 && v2.version > v1.version && v2.final && !v2.approval, '前提: 計画が新しい版になった（前の版の承認は新しい版に引き継がない）');
  await panel.startJsRegister(v1);
  assert(panel.jsExecState().stage === 'blocked' && panel.jsExecState().prepared.blockers.some(b => b.code === 'APPROVAL_REQUIRED') && !mock.calls.some(x => x === 'PUT customize'), `最新の版（v2）を承認する前は、古い版（v1）の承認では登録しない（APPROVAL_REQUIRED）: ${JSON.stringify(panel.jsExecState().prepared && panel.jsExecState().prepared.blockers.map(b => b.code))}`);
  //   最新の版（最終案のパイプラインで生成済み）を承認しても、古い版（v1）のカードからは登録しない
  const ok2 = await approveOnScreen(host, panel);
  assert(ok2, '前提: 最新の版（v2）の最終案を承認した');
  await panel.startJsRegister(v1);
  assert(panel.jsExecState().stage === 'blocked' && panel.jsExecState().prepared.blockers.some(b => b.code === 'NOT_LATEST_VERSION') && !mock.calls.some(x => x === 'PUT customize'), `古い版（v1）のカードからは登録しない（NOT_LATEST_VERSION）: ${JSON.stringify(panel.jsExecState().prepared && panel.jsExecState().prepared.blockers.map(b => b.code))}`);
  // 最新の版で登録の確認へ: 確認の項目を 1 件ずつチェックするまで登録ボタンは押せない・押しても登録しない
  //   C-1 第 3 段: 最終案のカードで示して承認した確認の項目（承認の confirmations に記録した code）は、承認で確認済みとしてチェック済みで出る
  //   （段階 C の R21・正しさ C2。tests/ai-flow-redesign.test.js の「正しさ C2」）。チェックを外すと押せず、押しても登録しない（Executor が止める）ことは変わらない
  await panel.startJsRegister(panel.conversation().activePlan());
  await tick(4);
  const jx = panel.jsExecState();
  const paneHtml = () => host.querySelector('#kt-ai-jsreg').innerHTML;
  const vA = panel.conversation().activePlan();
  const seenC1 = (vA.approval && vA.approval.confirmations && vA.approval.confirmations.C1) || [];
  assert(jx.stage === 'confirm' && jx.prepared.confirmations.length >= 1 && jx.prepared.confirmations.every(x => seenC1.includes(x.code)) && /登録の前に確認が必要な項目/.test(paneHtml()) && (paneHtml().match(/class="kt-ai-jsreg-ack"[^>]*checked/g) || []).length === jx.prepared.confirmations.length && /動作は未確認/.test(paneHtml()), '確認画面: 確認が必要な項目（チェック欄）・動作は未確認。最終案で示して承認した項目は承認で確認済み（チェック済み）');
  for (const x of jx.prepared.confirmations) await host.querySelector('#kt-ai-pane-exec').dispatch({ type: 'change', target: { dataset: { ackKey: x.key }, checked: false } });
  assert(/id="kt-ai-jsreg-go"[^>]*disabled/.test(paneHtml()), '確認画面: チェックを外すと、すべて確認するまで登録ボタンは無効');
  await panel.confirmJsRegister();
  assert(panel.jsExecState().stage === 'confirm' && !mock.calls.some(x => x === 'PUT customize') && /確認していないため、登録していません/.test(paneHtml()), '確認せずに登録を押しても登録しない（Executor が止める）');
  for (const x of panel.jsExecState().prepared.confirmations) await host.querySelector('#kt-ai-pane-exec').dispatch({ type: 'change', target: { dataset: { ackKey: x.key }, checked: true } });
  assert(!/id="kt-ai-jsreg-go"[^>]*disabled/.test(paneHtml()), 'すべて確認すると登録ボタンが押せる');
  await panel.confirmJsRegister();
  assert(panel.jsExecState().execution && panel.jsExecState().execution.status === 'DONE' && mock.calls.includes('PUT customize'), '確認した後は登録できる');
}

// =========================================================
console.log('\n--- G5 / G6. Generator への受け渡し（条件・利用者の補足）とクライアント（長い待ち時間・coverage）---');
{
  const data = FX.makeData();
  const cust = { customizationId: 'C1', requirement: '承認済みでは金額を編集不可', whyStandardInsufficient: 'w', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }], apis: [], existingFiles: [] };
  const ctx = KTContext.buildGenerator({ customization: cust, plan: { goal: 'g', steps: [] }, planId: 'p', version: 1, data, userRequests: ['承認済みでは金額を変更できなくして', '', '差戻し後は編集できるように'] });
  assert(ctx.customization.fields[0].condition === 'ステータス in ("承認済み")' && JSON.stringify(ctx.plan.userRequests) === JSON.stringify(['承認済みでは金額を変更できなくして', '差戻し後は編集できるように']), 'G5: Generator Context に制御の条件と、利用者の依頼・補足の原文（空は除く）');
  const RESP = { ok: true, contractVersion: '2.1', meta: { requestId: 'g1', gateway: { product: 'toolkit', feature: 'customization-generator', promptVersion: '1', contextVersion: 'customization-1' }, normalization: { warnings: [] }, ai: { model: 'm' } }, generated: { strategy: 'NEW_JS_FILE', targetFile: 'a.js', summary: 's', code: "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) { return event; });\n})();", patch: null, events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], coverage: [{ requirement: '明細の行の追加・削除', status: 'NOT_MET', note: 'JS では止められない' }, { requirement: 'x', status: 'BOGUS', note: '' }], gatewayChecks: { security: [] } } };
  const slow = (ms) => async () => { await new Promise(r => setTimeout(r, ms)); return { status: 200, body: JSON.stringify(RESP) }; };
  const c1 = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 't.cybozu.com', transport: slow(120), timeoutMs: 50, longTimeoutMs: 2000 });
  let g = null, e1 = null;
  try { g = await c1.generate({ ctx }); } catch (e) { e1 = e; }
  assert(!e1 && g && g.coverage && g.coverage[0].status === 'NOT_MET' && g.coverage[1].status === 'PARTIAL', `G6: コード生成は長い待ち時間で待ち、coverage（要件ごとの達成）を受け取る（語彙外は PARTIAL）${e1 ? `: ${e1.code} ${e1.message}` : ''}`);
  const c2 = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 't.cybozu.com', transport: slow(120), timeoutMs: 50 });
  let e2 = null;
  try { await c2.generate({ ctx }); } catch (e) { e2 = e; }
  assert(e2 && e2.code === 'TIMEOUT', 'timeoutMs だけを指定したときは計画・生成もその値（テスト・旧呼び出しとの互換）');
}

// =========================================================
console.log('\n--- G9 / G10. Generator Context の欠落（モデル比較の候補モデルで発見）: テーブルの中のフィールドには親のテーブル・要件が名前で挙げる既存ファイルは本文 ---');
{
  const data = REG.data;   // items: { item_name, qty }
  const cust = { customizationId: 'C2', requirement: 'モバイルで承認済みのとき明細の品名・数量を編集不可にし、PC の dealValidate.js と同等の検証をモバイルの保存時にも行う', whyStandardInsufficient: 'w', strategy: 'NEW_JS_FILE', platform: ['mobile'], implementation: 'JAVASCRIPT', events: ['mobile.app.record.edit.show', 'mobile.app.record.edit.submit'], fields: [{ code: 'item_name', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }, { code: 'qty', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }, { code: 'amount', access: 'READ' }], apis: [], existingFiles: [] };
  const VALIDATE = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.create.submit', 'app.record.edit.submit'], function (event) {\n    if (!event.record['amount'].value) event.record['amount'].error = '金額を入力してください';\n    return event;\n  });\n})();";
  const scan = { files: [{ name: 'dealValidate.js', target: 'desktop', kind: 'js', text: VALIDATE }, { name: 'unrelated.js', target: 'desktop', kind: 'js', text: '// 別の処理' }], fileEvents: { 'desktop:js:dealValidate.js': ['app.record.create.submit', 'app.record.edit.submit'], 'desktop:js:unrelated.js': [] }, results: [] };
  const ctx = KTContext.buildGenerator({ customization: cust, plan: { goal: 'g', steps: [] }, planId: 'p', version: 1, data, scan });
  const items = ctx.fields.find(f => f.code === 'items');
  assert(items && items.type === 'SUBTABLE' && items.plannedColumns.includes('qty') && ctx.constraints.allowedFields.includes('items') && ctx.constraints.tables && ctx.constraints.tables[0].code === 'items' && /row\.value/.test(ctx.constraints.tables[0].how), `G9: テーブルの中のフィールドだけを計画しても、行を回す親のテーブル（items）を fields / allowedFields / tables で渡す: ${JSON.stringify(ctx.constraints.allowedFields)}`);
  const ref = ctx.otherFiles.find(f => f.name === 'dealValidate.js'); const un = ctx.otherFiles.find(f => f.name === 'unrelated.js');
  assert(ref && ref.source === VALIDATE && ref.sourceUse === 'reference-only' && (!un || !un.source) && /参照用/.test(ctx.constraints.referenceFiles || ''), 'G10: 要件が名前で挙げる既存ファイル（dealValidate.js）は本文を参照用に渡す（挙げていないファイルは要約だけ）');
  const plain = KTContext.buildGenerator({ customization: { ...cust, requirement: '承認済みでは金額を編集不可', fields: [{ code: 'amount', access: 'CONTROL' }] }, plan: { goal: 'g', steps: [] }, planId: 'p', version: 1, data, scan });
  assert(!plain.constraints.tables && !plain.otherFiles.some(f => f.source) && !plain.constraints.referenceFiles && !plain.fields.some(f => f.code === 'items'), 'テーブルも既存ファイルも挙げない計画の Context は従来どおり');
}
{
  // Code Review: 全列のループ（row.value[key]）は計画した列の制御。条件の中なら通し、条件の外なら止める
  //   §0d.4（2026-10-08）: 条件の外の判定は生成工程の代表条件「合わない」の不合格を取り込む形に直した（旧 conditional-control は削除）
  const { cust, wrap, review } = REG;
  const c = cust({ requirement: '承認済みでは明細の品名・数量を編集不可にする', fields: [{ code: 'item_name', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }, { code: 'qty', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }] });
  const inside = review(wrap(['app.record.edit.show'], "    if (record['ステータス'].value === '承認済み') {\n      record['items'].value.forEach(function (row) {\n        Object.keys(row.value).forEach(function (key) { row.value[key].disabled = true; });\n      });\n    }"), c);
  assert(inside.registration.verdict !== 'BLOCKED' && !inside.registration.blockers.some(b => b.code === 'planned-fields'), `G9: 計画した列（item_name / qty）を全列のループで条件の中でロック → 要件の処理がある（planned-fields で止めない）: ${JSON.stringify(inside.registration.blockers)}`);
  const cE = cust({ requirement: '承認済みでは明細の品名・数量を編集不可にする', fields: [{ code: 'item_name', access: 'CONTROL', condition: 'ステータス in ("承認済み")', effects: ['lock'] }, { code: 'qty', access: 'CONTROL', condition: 'ステータス in ("承認済み")', effects: ['lock'] }] });
  const outside = REG.gw(review(wrap(['app.record.edit.show'], "    record['items'].value.forEach(function (row) {\n      Object.keys(row.value).forEach(function (key) { row.value[key].disabled = true; });\n    });"), cE), cE, { fail: ['item_name|nomatch', 'qty|nomatch'] });
  assert(outside.registration.verdict === 'BLOCKED' && outside.checks.some(x => x.name === 'behavior-fail' && x.severity === 'block' && /item_name|qty/.test(x.message)), `全列のループが条件の外 → 生成工程の「合わない」の不合格で、計画した列も登録不可: ${JSON.stringify(outside.registration.blockers.map(b => b.code))}`);
  const both = review(wrap(['app.record.edit.show', 'mobile.app.record.edit.show'], "    if (record['ステータス'].value === '承認済み') {\n      record['items'].value.forEach(function (row) {\n        for (const key in row.value) { row.value[key].disabled = true; }\n      });\n    }"), cust({ platform: ['desktop', 'mobile'], events: ['app.record.edit.show', 'mobile.app.record.edit.show'], requirement: '承認済みでは明細を編集不可（PC とモバイル）', fields: [{ code: 'item_name', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }, { code: 'qty', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }] }));
  assert(!both.registration.blockers.some(b => b.code === 'platform-fields' || b.code === 'planned-fields'), `PC とモバイルの 1 つの handler で全列をロック → 両方の画面で扱っている: ${JSON.stringify(both.registration.blockers)}`);
  const oneCol = review(wrap(['app.record.edit.show'], "    if (record['ステータス'].value === '承認済み') {\n      record['items'].value.forEach(function (row) { row.value['item_name'].disabled = true; });\n    }"), c);
  assert(oneCol.registration.verdict === 'BLOCKED' && oneCol.registration.blockers.some(b => b.code === 'planned-fields' && /qty/.test(b.message)), '計画した列の一部（qty）しかロックしていない → 要件の処理が無い（登録不可）');
  // G8 の表示: 行が残ること（明細の行の追加・削除は止められない）は、構造の判定（達成範囲の SUBTABLE_ROWS）で示す
  //   §0d.4（2026-10-08）: 要件の文・AI の要約を正規表現で読んで確認にする判定（requirement-scope・summary-scope）は削除した（要件の文の読み取りは計画の Review の
  //   JS_LIMIT_SUBTABLE_ROWS と、達成範囲の SUBTABLE_ROWS が持つ。G8 の計画の Review の回帰を参照）
  const CELL_LOCK = "    if (record['ステータス'].value === '承認済み') {\n      record['items'].value.forEach(function (row) { row.value['item_name'].disabled = true; row.value['qty'].disabled = true; });\n    }";
  const cellsOnly = review(wrap(['app.record.edit.show'], CELL_LOCK), cust({ requirement: '承認済みでは明細の品名・数量のセルを編集不可にする', fields: [{ code: 'item_name', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }, { code: 'qty', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }] }), { summary: '承認済みのとき明細の品名・数量のセルを編集不可にします' });
  assert(cellsOnly.registration.verdict !== 'BLOCKED' && cellsOnly.coverage.notAchieved.some(x => x.code === 'SUBTABLE_ROWS'), `要件も要約も「セル」に限る → 止めない（行が残ることは達成範囲に出す）: ${JSON.stringify(cellsOnly.registration.confirmations.map(x => x.code))}`);
}
{
  // §2 の実機: 反映した計画（顧客区分・紹介元・一覧）の後、その計画のフィールドに触れる新しい依頼が「改めて入力してください」から抜けられなかった
  const executedPlan = { planId: 'p1', version: 1, status: 'EXECUTED', goal: '顧客区分と紹介元を追加', plan: plan([step('P1', 'ADD_FIELD', 'FIELD', 'NEW_FIELD_1', { name: '顧客区分', fieldType: 'DROP_DOWN' }), step('P2', 'ADD_FIELD', 'FIELD', 'NEW_FIELD_2', { name: '紹介元', fieldType: 'SINGLE_LINE_TEXT' })], [pf('NEW_FIELD_1', '顧客区分', 'customer_category', 'DROP_DOWN'), pf('NEW_FIELD_2', '紹介元', 'referral_source', 'SINGLE_LINE_TEXT')]) };
  const t = '顧客区分が「既存」のときは紹介元を隠して、「新規」のときだけ表示するようにして（PCの作成・編集画面。顧客区分を変えたときも切り替える）';
  const c1 = KTAiConversation.classifyIntent(t, { activePlan: executedPlan });
  assert(c1.intent === KTAiConversation.INTENT.PLAN && c1.reason === 'NEW_PLAN_AFTER_EXECUTION', `反映済みの計画のフィールドに触れる新しい依頼は新しい計画（以前は REVISE_PLAN →「改めて入力」→ 同じ判定の繰り返し）: ${c1.intent}/${c1.reason}`);
  const active = { ...executedPlan, status: 'ACTIVE' };
  assert(KTAiConversation.classifyIntent(t, { activePlan: active }).intent === KTAiConversation.INTENT.REVISE_PLAN, 'まだ反映していない計画（ACTIVE）なら、従来どおりその計画の修正');
  const q = KTAiConversation.classifyIntent('顧客区分はいつ追加されましたか？', { activePlan: executedPlan });
  assert(q.intent !== KTAiConversation.INTENT.PLAN, `反映済みの計画の語に触れる質問は計画にしない: ${q.intent}`);
}
{
  // §2 の実機（続き）: 「動作テスト」の語だけで反映の依頼にしない
  const active = { planId: 'p2', version: 1, status: 'ACTIVE', goal: 'g', plan: plan([step('C1', 'CUSTOMIZATION_REQUIRED', 'JS', 'dealValidate.js', { customizationId: 'C1' })], [], { solution: 'CUSTOMIZATION', customizations: [{ customizationId: 'C1', requirement: 'r', strategy: 'EXTEND_EXISTING_JS', platform: ['desktop'], events: [], fields: [], apis: [], existingFiles: [{ name: 'dealValidate.js', target: 'desktop' }] }] }) };
  const I = KTAiConversation.INTENT;
  const t1 = KTAiConversation.classifyIntent('dealValidate.js が別の担当者に直されたので、今の動作テスト環境の本文を元に、同じ内容で作り直して', { activePlan: active });
  assert(t1.intent !== I.REQUEST_PREVIEW, `「今の動作テスト環境の本文を元に…作り直して」は反映の依頼ではない: ${t1.intent}/${t1.reason}`);
  assert(KTAiConversation.classifyIntent('動作テスト環境へ反映して', { activePlan: active }).intent === I.REQUEST_PREVIEW && KTAiConversation.classifyIntent('この計画で動作テストして', { activePlan: active }).intent === I.REQUEST_PREVIEW, '「動作テスト環境へ反映して」「動作テストして」は従来どおり反映の依頼');
}
{
  // §2 の実機（続き）: JS を登録したら計画は「反映済み」（標準設定の手順が無く、カスタマイズをすべて生成して登録したとき）。次の依頼は新しい計画
  const mkPlan = (custs) => plan([], [], { solution: 'CUSTOMIZATION', customizations: custs.map(id => ({ customizationId: id, requirement: 'r', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: [], fields: [], apis: [], existingFiles: [] })) });
  //   C-1 第 3 段: 仮案の能力がある接続先で、依頼 → 仮案 → 採用で計画を作る（生成の services は無いので、生成の結果は手で置く）
  const svc = (p) => ({ conversationFeatures: () => ['requirements', 'stream', 'proposal'], async propose(args) { return { ok: true, proposal: K.normalized(draftRaw(args.utterance)), ctx: { facts: [] } }; }, async plan() { return { plan: clone(p), ctx: null, review: null }; }, async ask() { return { ok: true, answer: { answer: 'a' } }; } });
  const one = KTAiConversation.create({ services: svc(mkPlan(['C1'])) });
  await startPlan(one, '紹介元を顧客区分で切り替えて表示したい');
  const v1 = one.activePlan(); v1.generated = { C1: { generated: { strategy: 'NEW_JS_FILE' } } };
  one.noteJsExecution({ stage: 'running', execution: { executionId: 'jx1', status: 'RUNNING', put: null } });
  one.noteJsExecution({ stage: 'done', execution: { executionId: 'jx1', status: 'DONE', put: { ok: true } } });
  assert(v1.status === 'EXECUTED' && v1.jsExecutionId === 'jx1', `カスタマイズだけの計画で、すべて生成して登録 → 計画は反映済み: ${v1.status}`);
  const next = KTAiConversation.classifyIntent('顧客区分を既存に変えたら紹介元を空にして', { activePlan: { ...v1, plan: { ...v1.plan, proposedFields: [{ temporaryId: 'NEW_FIELD_1', label: '紹介元', suggestedCode: 'referral_source' }] } } });
  assert(next.intent === KTAiConversation.INTENT.PLAN, `登録の後の依頼は新しい計画（登録済みのカスタマイズを含む見直しにしない）: ${next.intent}/${next.reason}`);
  const two = KTAiConversation.create({ services: svc(mkPlan(['C1', 'C2'])) });
  await startPlan(two, '紹介元を顧客区分で切り替えて表示したい');
  const v2 = two.activePlan(); v2.generated = { C1: { generated: { strategy: 'NEW_JS_FILE' } } };
  two.noteJsExecution({ stage: 'running', execution: { executionId: 'jx2', status: 'RUNNING', put: null } });
  two.noteJsExecution({ stage: 'done', execution: { executionId: 'jx2', status: 'DONE', put: { ok: true } } });
  assert(v2.status === 'ACTIVE', `まだ生成していないカスタマイズ（C2）が残る計画は反映済みにしない: ${v2.status}`);
}
{
  // §2 の実機（続き）: 表示の切り替え・入力チェックで条件つきに制御するコードを「編集不可が見つかりません」としない
  const data = clone(REG.data);
  data.fields.customer_category = { type: 'DROP_DOWN', code: 'customer_category', label: '顧客区分', options: { '新規': { label: '新規', index: '0' }, '既存': { label: '既存', index: '1' } } };
  data.fields.referral_source = { type: 'SINGLE_LINE_TEXT', code: 'referral_source', label: '紹介元' };
  const c = (events, cond) => ({ customizationId: 'C1', requirement: '顧客区分が新規のときだけ紹介元を表示 / 必須', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events, fields: [{ code: 'customer_category', access: 'READ' }, { code: 'referral_source', access: 'CONTROL', condition: cond }], apis: [], existingFiles: [] });
  const rv = (events, body, cond) => KTCodeReview.review({ generated: REG.gen(`(function () {\n  'use strict';\n  kintone.events.on(${JSON.stringify(events).replace(/"/g, "'")}, function (event) {\n${body}\n    return event;\n  });\n})();`, { summary: 's' }), customization: c(events, cond), plan: null, data, scan: null, existingSource: null });
  const shown = rv(['app.record.create.show', 'app.record.edit.show', 'app.record.create.change.customer_category', 'app.record.edit.change.customer_category'], "    kintone.app.record.setFieldShown('referral_source', event.record['customer_category'].value === '新規');", 'customer_category not in ("新規")');
  //   §0d.4（2026-10-08）: 条件の内外の照合（conditional-control）は削除した。ここでは形式確認が表示の切り替え・入力チェックの正しいコードを止めないこと
  //   （「編集不可が見つかりません」の planned-fields にしない・登録不可にしない）だけを確かめる。条件を見ない表示の切り替え（旧: 確認）は、生成工程の代表条件で
  //   扱う（AI版 worker/test/cases/required-effects.mjs の「§0c.10 G2（本物の隔離環境）: show-hide の condition は隠す条件…逆向きの候補は failed」と「lock: 条件に合う…・合わない…」の組）
  assert(shown.registration.verdict !== 'BLOCKED' && !shown.registration.blockers.some(b => b.code === 'planned-fields') && !shown.checks.some(x => x.name === 'conditional-control'), `表示の切り替え（setFieldShown）が条件の項目を見ている → 止めない: ${JSON.stringify(shown.registration.blockers)}`);
  const err = rv(['app.record.create.submit', 'app.record.edit.submit'], "    if (event.record['customer_category'].value === '新規' && !event.record['referral_source'].value) {\n      event.record['referral_source'].error = '紹介元を入力してください';\n    } else {\n      event.record['referral_source'].error = null;\n    }", 'customer_category in ("新規")');
  assert(err.registration.verdict !== 'BLOCKED' && !err.registration.blockers.some(b => b.code === 'planned-fields'), `入力チェック（.error）が条件の中 → 止めない: ${JSON.stringify(err.registration.blockers)}`);
}
{
  // §6 の実機: kintone.proxy は約 60 秒で打ち切る（GAIA_PR03）。推論モデルの計画（見直し）が「ネットワークエラー」になった
  const calls = [];
  const okResp = { status: 200, text: async () => '{"ok":true}' };
  const proxyOk = { proxy: async (url, method) => { calls.push(['proxy', method]); return ['{"ok":true}', 200, {}]; } };
  const fetchOk = async (url, init) => { calls.push(['fetch', init.method]); return okResp; };
  const t1 = KTAiClient.createDefaultTransport({ kintoneApi: proxyOk, fetchFn: fetchOk });
  const r1 = await t1({ url: 'https://gw.test/v2/review', method: 'POST', headers: {}, body: '{}', preferDirect: true });
  assert(r1.via === 'direct' && calls.length === 1 && calls[0][0] === 'fetch', '時間のかかる要求（preferDirect）はページから直接送る（kintone.proxy を使わない）');
  calls.length = 0;
  const r2 = await t1({ url: 'https://gw.test/v2/review', method: 'POST', headers: {}, body: '{}' });
  assert(r2.via === 'proxy' && calls.length === 1 && calls[0][0] === 'proxy', 'それ以外（質問・接続）は従来どおり kintone.proxy');
  calls.length = 0;
  const blocked = async () => { calls.push(['fetch', 'blocked']); throw new TypeError('Failed to fetch'); };
  const r3 = await KTAiClient.createDefaultTransport({ kintoneApi: proxyOk, fetchFn: blocked })({ url: 'https://gw.test/v2/review', method: 'POST', headers: {}, body: '{}', preferDirect: true });
  assert(r3.via === 'proxy' && calls.map(c => c[0]).join() === 'fetch,proxy', '直接送れない（すぐに失敗）→ kintone.proxy に切り替える');
  calls.length = 0;
  let now = 0;
  const lateFail = async () => { calls.push(['fetch', 'late']); now += 90000; throw new TypeError('network reset'); };
  let e4 = null;
  try { await KTAiClient.createDefaultTransport({ kintoneApi: proxyOk, fetchFn: lateFail, nowFn: () => now })({ url: 'https://gw.test/v2/review', method: 'POST', headers: {}, body: '{}', preferDirect: true }); } catch (e) { e4 = e; }
  assert(e4 && calls.map(c => c[0]).join() === 'fetch', 'Gateway に届いた後の失敗（時間がたってから）では送り直さない（二重に使わない）');
  const proxyTimeout = { proxy: async () => { throw new Error('{"code":"GAIA_PR03","message":"kintoneとプロキシーAPIとの通信がタイムアウトしました。"}'); } };
  let e5 = null;
  try { await KTAiClient.createDefaultTransport({ kintoneApi: proxyTimeout, fetchFn: null })({ url: 'https://gw.test/v2/review', method: 'POST', headers: {}, body: '{}' }); } catch (e) { e5 = e; }
  assert(e5 && e5.code === 'TIMEOUT' && /約 60 秒/.test(e5.message), `kintone.proxy の打ち切り（GAIA_PR03）は「ネットワークエラー」ではなく上限を超えた TIMEOUT: ${e5 && e5.code}`);
  // client: 計画・生成は preferDirect、質問は使わない
  const seen = [];
  const rec = async (req) => { seen.push(req.preferDirect === true); return { status: 200, body: JSON.stringify({ ok: true, contractVersion: '2.1', meta: { requestId: 'r', gateway: {}, normalization: { warnings: [] }, ai: { model: 'm' } }, answer: { answer: 'a', facts: [], analysis: [], recommendations: [], unknowns: [] } }) }; };
  const cl = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: rec });
  try { await cl.ask({ ctx: { contextVersion: '1', facts: [] }, question: 'q' }); } catch (e) { }
  const gctx = KTContext.buildGenerator({ customization: { customizationId: 'C1', requirement: 'r', whyStandardInsufficient: 'w', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [] }, plan: { goal: 'g', steps: [] }, planId: 'p', version: 1, data: FX.makeData() });
  try { await cl.generate({ ctx: gctx }); } catch (e) { }
  assert(seen[0] === false && seen[1] === true, `質問は短い要求（kintone.proxy）・コード生成は長い要求（直接）: ${JSON.stringify(seen)}`);
}
{
  // §5 モバイルの実機: 作成画面のイベントの record にはステータス等のシステムフィールドが無い → 確かめずに .value を読むコードは登録不可
  const data = clone(REG.data);
  data.fields['ステータス'] = { type: 'STATUS', code: 'ステータス', label: 'ステータス', enabled: true };
  const c = { customizationId: 'C2', requirement: 'モバイルで承認済みのとき金額を編集不可にする', strategy: 'NEW_JS_FILE', platform: ['mobile'], implementation: 'JAVASCRIPT', events: ['mobile.app.record.create.show', 'mobile.app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }], apis: [], existingFiles: [] };
  const rv = (body, events = ['mobile.app.record.create.show', 'mobile.app.record.edit.show']) => KTCodeReview.review({ generated: REG.gen(`(function () {\n  'use strict';\n  const EVENTS = ${JSON.stringify(events).replace(/"/g, "'")};\n  kintone.events.on(EVENTS, (event) => {\n    const record = event.record;\n${body}\n    return event;\n  });\n})();`, { targetFile: 'mobile-approved-lock.js', summary: 'モバイルで承認済みのとき金額を編集不可' }), customization: { ...c, events }, plan: null, data, scan: null, existingSource: null });
  // 候補モデル CX-1 1 回目のモバイルのコードの形そのもの（実機で作成画面を開くたびに TypeError）
  const bare = rv("    if (record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }");
  assert(bare.registration.verdict === 'BLOCKED' && bare.registration.blockers.some(b => b.code === 'create-missing-field' && /mobile\.app\.record\.create\.show/.test(b.message) && /TypeError/.test(b.message)), `作成画面のイベントでステータスを確かめずに読む → 登録不可（create-missing-field）: ${JSON.stringify(bare.registration.blockers.map(b => b.code))}`);
  const guarded = rv("    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }");
  const optional = rv("    if (record['ステータス']?.value === '承認済み') {\n      record['amount'].disabled = true;\n    }");
  const early = rv("    if (!record['ステータス']) {\n      return event;\n    }\n    if (record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }");
  const editOnly = rv("    if (record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }", ['mobile.app.record.edit.show']);
  assert([guarded, optional, early, editOnly].every(r => !r.registration.blockers.some(b => b.code === 'create-missing-field')), `存在を確かめる書き方（&&・?.・早い return）と、編集画面だけのイベントは止めない: ${[guarded, optional, early, editOnly].map(r => r.registration.verdict).join(',')}`);
}
{
  // 計画の Review: ステータス名の後ろの注釈（「承認待ち（課長承認として再利用）」）を名前として読まない（モデル比較の CX-1 で「遷移先が存在しません（high）」）
  const data = clone(REG.data);
  data.status = { enable: true, revision: '5', states: { '作成中': { name: '作成中', index: '0', assignee: { type: 'ONE', entities: [] } }, '承認待ち': { name: '承認待ち', index: '1', assignee: { type: 'ONE', entities: [{ entity: { type: 'USER', code: 'u1' }, includeSubs: false }] } }, '承認済み': { name: '承認済み', index: '2', assignee: { type: 'ONE', entities: [] } } }, actions: [{ name: '申請する', from: '作成中', to: '承認待ち', filterCond: '', type: 'PRIMARY' }, { name: '承認する', from: '承認待ち', to: '承認済み', filterCond: '', type: 'PRIMARY' }, { name: '差し戻す', from: '承認待ち', to: '作成中', filterCond: '', type: 'PRIMARY' }] };
  const st = step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', { filterCond: 'amount <= "999999"', changeKind: 'ACTION_CONDITION' }, { proposal: { summary: '「申請する」を 999,999 円以下だけにする', details: [{ key: '遷移元', value: '作成中' }, { key: '遷移先', value: '承認待ち（課長承認として再利用）' }, { key: '条件', value: 'amount <= "999999"' }] } });
  const r = KTPlanReview.review({ plan: plan([st]), data, deps: null, scan: null, incoming: null });
  const iss = r.steps[0].issues.map(i => i.code);
  assert(!iss.includes('UNKNOWN_STATUS') && iss.includes('EXISTING_PATH_RESTRICTED'), `説明文の注釈つきの遷移先を実在のステータス（承認待ち）として読む（既存の経路を狭める注意は残す）: ${iss.join(',')}`);
  const st2 = step('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '申請する', { filterCond: 'amount <= "999999"', changeKind: 'ACTION_CONDITION' }, { proposal: { summary: 's', details: [{ key: '遷移先', value: '課長承認待ち（新設）' }] } });
  const r2 = KTPlanReview.review({ plan: plan([st2]), data, deps: null, scan: null, incoming: null });
  assert(r2.steps[0].issues.some(i => i.code === 'UNKNOWN_STATUS' && /課長承認待ち/.test(i.message)), '注釈を除いても実在しないステータスは従来どおり「存在しません」');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
