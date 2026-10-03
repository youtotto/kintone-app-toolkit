// Phase 21（継続開発の整合性・JS 登録条件・AI 品質改善）の回帰テスト
//
// 検証内容:
//   G1 開発支援の作業基準 = 最新の動作テスト環境（KTDevBase）。運用環境は比較のためだけに取得し、差を区別して Context（environment / env-diff）に入れる。
//      再読み込み後（会話履歴なし）でも、動作テスト環境にだけあるフィールド・JS を「存在する」ものとして扱う（再追加しない・「無い」と言わない）
//   G2 コード生成の基準の本文 = 動作テスト環境の fileKey の本文（運用環境の本文・相談を始めた時の古い本文と混ぜない）
//   G3 取得の失敗を「設定なし」「変更なし」と読まない。動作テスト環境が取れなければ計画・生成を止める（運用環境の設定で代わりに進めない）。
//      質問は運用環境の設定で答え、そのことを Context に入れる
//   G4 反映の直前: 計画を作った時点の動作テスト環境と今を内容で比べる（運用環境の revision の差では止めない・別の操作で入った変更は止める）
//
// 実行方法: node tests/ai-acceptance-p21.test.js（KT_SRC=<別ビルド> で修正前の版に対して走らせると RED になる）
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { makeFakeHost } = require('./helpers/fake-dom.js');
const { KTDeps, KTScan, KTDevBase, KTContext, KTAiClient, KTAiConversation, KTPlanReview, KTPlanExecutor, KTCodeReview, KTJsExecutor, mountAiWorkspace } = loadToolkit();
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
  "    var v = Number(event.record['discount_rate'].value || 0);",
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
      return { requestId, strategy: 'EXTEND_EXISTING_JS', targetFile: 'dealLock.js', summary: '値引率の上限チェックを追加', code: '', patch: { baseHash: ctx.existingFile.hash, operations: [{ type: 'INSERT_AFTER', anchor: "  });", content: "\n  kintone.events.on(['app.record.edit.submit'], function (event) {\n    if (Number(event.record['discount_rate'].value || 0) > 30) event.error = '値引率は 30% までです';\n    return event;\n  });" }] }, events: ['app.record.edit.submit'], fields: [{ code: 'discount_rate', access: 'READ' }], apis: [], assumptions: [], warnings: [], gatewayChecks: {} , _anchorUsed: anchor };
    },
  };
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
  assert(/今回の変更の基準：<b>動作テスト環境<\/b>/.test(head) && /運用環境との差：<b>4 件<\/b>/.test(head) && /data-act="refresh-base"/.test(head), '画面: 「今回の変更の基準：動作テスト環境」と運用環境との差の件数・再取得');
  // 新しい会話（会話履歴なし）で、現在の状態と運用環境との差を聞く → 質問の Context に作業の基準と差
  await panel.send('現在の状態と運用環境との差分を説明して');
  const qctx = askCalls[askCalls.length - 1];
  assert(qctx && qctx.facts.some(f => f.key === 'ENV:base' && /動作テスト環境/.test(f.statement)) && qctx.facts.filter(f => f.kind === 'env-diff').length === 4, '質問: 作業の基準と差（4 件）を Context に入れて AI に渡す');
  // 追加したフィールドを指定して入力チェックを依頼 → 計画の Context は動作テスト環境
  const before = loads;
  await panel.send('値引率に入力チェックを追加したい');
  const pctx = planCalls[planCalls.length - 1];
  assert(loads > before, '計画の前に作業の基準を取り直す（別の操作で入った変更も拾う）');
  assert(pctx && pctx.dictionary.fieldCodes.includes('discount_rate') && pctx.facts.some(f => f.kind === 'field' && f.field.code === 'discount_rate' && /動作テスト環境にだけある/.test(f.statement)), '計画: 値引率は存在する（動作テスト環境にだけある）として AI に渡す');
  const v = panel.conversation().activePlan();
  assert(v && v.review && v.review.base && v.review.base.env === 'preview' && v.review.base.revision.preview === '12' && v.review.base.fingerprint === KTDevBase.fingerprint(panel.devBase()), '計画の Review に基準（動作テスト環境・revision・指紋）を残す');
  // コード生成: 統合先の本文は動作テスト環境の本文（運用環境の本文でも、相談時の古い本文でもない）。仕様を確定してから生成する
  await panel.confirmSpec(v.planId, v.version);
  await panel.send('C1 のコードを作って');
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
  assert(/動作テスト環境を取得できませんでした/.test(host.querySelector('#kt-ai-header').innerHTML), '画面: 基準を取得できなかったことを赤で表示');
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

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
