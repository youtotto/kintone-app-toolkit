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

// =========================================================
console.log('\n--- G7. JS の登録の判定（KTCodeReview.registration）: 静的に確かめられる要件違反は登録不可・確かめられないことは確認・それ以外は動作未確認 ---');
const REG = (() => {
  const data = FX.makeData();
  data.fields.items = { type: 'SUBTABLE', code: 'items', label: '明細', noLabel: false, fields: { item_name: { type: 'SINGLE_LINE_TEXT', code: 'item_name', label: '品名' }, qty: { type: 'NUMBER', code: 'qty', label: '数量' } } };
  const cust = (o = {}) => ({ customizationId: 'C1', requirement: '承認済みでは金額を編集不可にする', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }], apis: [], existingFiles: [], ...o });
  const gen = (code, o = {}) => ({ strategy: 'NEW_JS_FILE', targetFile: 'lock.js', summary: '承認済みで金額を編集不可', code, patch: null, events: [], fields: [], apis: [], assumptions: [], warnings: [], ...o });
  const wrap = (events, body) => `(function () {\n  'use strict';\n  kintone.events.on(${JSON.stringify(events).replace(/"/g, "'")}, function (event) {\n    var record = event.record;\n${body}\n    return event;\n  });\n})();`;
  const review = (code, c = cust(), g = {}) => KTCodeReview.review({ generated: gen(code, g), customization: c, plan: null, data, scan: null, existingSource: null });
  const chk = (rv, name) => (rv.checks || []).find(x => x.name === name) || null;
  return { data, cust, gen, wrap, review, chk };
})();
{
  const { cust, wrap, review, chk } = REG;
  const IF_LOCK = "    if (record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }";
  const ok = review(wrap(['app.record.edit.show'], IF_LOCK));
  assert(ok.registration && ok.registration.verdict === 'RUNTIME_UNVERIFIED' && ok.registration.blockers.length === 0 && ok.registration.unverified.some(u => u.code === 'RUNTIME_NOT_RUN') && chk(ok, 'conditional-control').ok, '条件（承認済み）の中でだけロック: 静的な検査は通過・動作は未確認（RUNTIME_UNVERIFIED）');
  // 条件の書き方が違っても誤って止めない: 変数に入れた条件・早い return で除外・名前付き関数
  const varLocked = review(wrap(['app.record.edit.show'], "    var locked = record['ステータス'].value === '承認済み';\n    if (locked) {\n      record['amount'].disabled = true;\n    }"));
  const guard = review(wrap(['app.record.edit.show'], "    if (record['ステータス'].value !== '承認済み') {\n      return event;\n    }\n    record['amount'].disabled = true;"));
  assert(varLocked.registration.verdict === 'RUNTIME_UNVERIFIED' && guard.registration.verdict === 'RUNTIME_UNVERIFIED', '条件を変数に入れる書き方・早い return で除外する書き方は通す（正常な書き方を一律に拒否しない）');
  // F42（実機）: 要件は承認済みのときだけ → 条件の外でロック → 登録不可
  const outside = review(wrap(['app.record.edit.show'], IF_LOCK + "\n    record['owner'].disabled = true;"), cust({ fields: [{ code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }, { code: 'owner', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }] }));
  assert(outside.registration.verdict === 'BLOCKED' && chk(outside, 'conditional-control') && outside.checks.some(x => x.name === 'conditional-control' && !x.ok && x.severity === 'block' && /owner/.test(x.message) && /条件の外/.test(x.message)), 'F42: 条件つきの要件なのに条件の外でロック → 登録不可（conditional-control）');
  // 条件が実装仕様に構造化されていない（要件の文だけ）→ 証明できないので確認（従来の F42 の検査）
  const outsideNoCond = review(wrap(['app.record.edit.show'], IF_LOCK + "\n    record['owner'].disabled = true;"), cust({ requirement: '承認済みでは金額と担当者を編集不可にする', fields: [{ code: 'amount', access: 'CONTROL' }, { code: 'owner', access: 'CONTROL' }] }));
  assert(outsideNoCond.registration.verdict === 'NEEDS_CONFIRMATION' && outsideNoCond.registration.confirmations.some(x => x.code === 'unconditional-control' && /動作テスト環境で/.test(x.howToCheck)), '条件が構造化されていなければ「確認が必要」（静的に証明できる範囲と区別する）');
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
  const dyn = review("(function () {\n  'use strict';\n  var f = 'amount';\n  kintone.events.on(['app.record.edit.show', 'app.record.edit.change.' + f], function (event) {\n    if (Number(event.record['amount'].value) >= 1000000) event.record['amount'].error = 'x'; else event.record['amount'].error = null;\n    return event;\n  });\n})();", cust({ requirement: '金額が 100 万円以上なら警告する', events: ['app.record.edit.show', 'app.record.edit.change.amount'], fields: [{ code: 'amount', access: 'CONTROL' }] }));
  assert(dyn.registration.verdict !== 'BLOCKED' && dyn.registration.confirmations.some(x => x.code === 'planned-events'), 'イベント名を組み立てている（静的に特定できない）→ 止めずに確認が必要');
}

// =========================================================
console.log('\n--- G7b. 条件の外のロックの見落とし（モデル比較の CX-1 基準側で発見）: ループ・存在確認だけの条件は計画の条件の外。正常な書き方（関数・switch・else）は止めない ---');
{
  const { cust, wrap, review, chk } = REG;
  const both = cust({ requirement: '承認済みでは金額と明細を編集不可にする', fields: [{ code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }, { code: 'items', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }] });
  // 基準側（gpt-4.1-mini）の差分そのもの: 承認済みの if の閉じ括弧の後ろに明細のループを足した（どのステータスでも明細が編集できなくなる）
  const leaked = "    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }\n      record['items'].value.forEach(function(row) {\n        for (var key in row.value) {\n          if (row.value.hasOwnProperty(key)) {\n            row.value[key].disabled = true;\n          }\n        }\n      });";
  const rvLeak = review(wrap(['app.record.edit.show'], leaked), both);
  const cc = rvLeak.checks.find(x => x.name === 'conditional-control' && !x.ok && /items/.test(x.message));
  assert(rvLeak.registration.verdict === 'BLOCKED' && cc && cc.severity === 'block' && /条件の外/.test(cc.message) && /見ていません/.test(cc.message), `ループ・hasOwnProperty だけの条件の中のロック → 計画の条件の外として登録不可: ${cc && cc.message}`);
  assert(!rvLeak.registration.confirmations.some(x => x.code === 'conditional-control' && /items/.test(x.message)), '「確かめられません」（同意すれば登録できる確認）に落とさない');
  // 正しい位置（if の中）なら止めない
  const inside = "    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n      record['items'].value.forEach(function(row) {\n        for (var key in row.value) {\n          if (row.value.hasOwnProperty(key)) {\n            row.value[key].disabled = true;\n          }\n        }\n      });\n    }";
  const rvIn = review(wrap(['app.record.edit.show'], inside), both);
  assert(rvIn.registration.verdict !== 'BLOCKED' && rvIn.checks.filter(x => x.name === 'conditional-control').every(x => x.ok), `if の中のループ・hasOwnProperty は条件（承認済み）の中として認める: ${JSON.stringify(rvIn.registration.blockers)}`);
  // 存在確認だけの if（明細があれば）の中 → 計画の条件の外
  const exist = "    if (record['ステータス'].value === '承認済み') { record['amount'].disabled = true; }\n    if (record['items'] && record['items'].value) {\n      record['items'].value.forEach(function (row) { row.value['qty'].disabled = true; });\n    }";
  const rvExist = review(wrap(['app.record.edit.show'], exist), both);
  assert(rvExist.registration.verdict === 'BLOCKED' && rvExist.registration.blockers.some(b => b.code === 'conditional-control' && /items/.test(b.message)), '存在確認（if (record.items && record.items.value)）だけの中のロック → 登録不可');
  // 別の項目の条件だけ（ステータスを見ない）→ 計画の条件の外
  const otherField = review(wrap(['app.record.edit.show'], "    if (record['owner'].value.length) {\n      record['amount'].disabled = true;\n    }"));
  assert(otherField.registration.verdict === 'BLOCKED' && otherField.registration.blockers.some(b => b.code === 'conditional-control'), '別の項目（担当者）の条件だけでロック → 計画の条件（ステータス）を見ていないので登録不可');
  // 正常な書き方は止めない: 条件の中から呼ぶ関数・switch・else・関数で判定
  const helperCalled = review("(function () {\n  'use strict';\n  function lockAll(record) {\n    record['amount'].disabled = true;\n  }\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    if (event.record['ステータス'].value === '承認済み') {\n      lockAll(event.record);\n    }\n    return event;\n  });\n})();");
  assert(helperCalled.registration.verdict === 'RUNTIME_UNVERIFIED' && chk(helperCalled, 'conditional-control').ok, `条件の中から呼ぶ関数の中のロックは止めない（呼び出し元の条件を見る）: ${JSON.stringify(helperCalled.registration)}`);
  const helperAlways = review("(function () {\n  'use strict';\n  function lockAll(record) {\n    record['amount'].disabled = true;\n  }\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    lockAll(event.record);\n    return event;\n  });\n})();");
  assert(helperAlways.registration.verdict === 'BLOCKED' && helperAlways.registration.blockers.some(b => b.code === 'conditional-control'), '条件なしで呼ぶ関数の中のロック → 登録不可');
  const helperRef = review("(function () {\n  'use strict';\n  function lockAll(event) {\n    event.record['amount'].disabled = true;\n    return event;\n  }\n  var guarded = function (event) { return event.record['ステータス'].value === '承認済み' ? lockAll(event) : event; };\n  kintone.events.on(['app.record.edit.show'], guarded);\n})();");
  assert(helperRef.registration.verdict !== 'BLOCKED', `呼び出し方を静的に追えない関数の中のロックは止めない（確認に回す）: ${JSON.stringify(helperRef.registration.blockers)}`);
  const sw = review(wrap(['app.record.edit.show'], "    switch (record['ステータス'].value) {\n      case '承認済み':\n        record['amount'].disabled = true;\n        break;\n      default:\n        break;\n    }"));
  assert(sw.registration.verdict === 'RUNTIME_UNVERIFIED' && chk(sw, 'conditional-control').ok, 'switch (ステータス) の case の中は条件の中');
  const els = review(wrap(['app.record.edit.show'], "    if (record['ステータス'].value !== '承認済み') {\n      record['amount'].disabled = false;\n    } else {\n      record['amount'].disabled = true;\n    }"));
  assert(els.registration.verdict === 'RUNTIME_UNVERIFIED' && chk(els, 'conditional-control').ok, 'ステータスの if の else の中は条件の中（else of (…)）');
  const fnCond = review("(function () {\n  'use strict';\n  function isApproved(record) {\n    return record['ステータス'].value === '承認済み';\n  }\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    if (isApproved(event.record)) {\n      event.record['amount'].disabled = true;\n    }\n    return event;\n  });\n})();");
  assert(fnCond.registration.verdict === 'RUNTIME_UNVERIFIED' && chk(fnCond, 'conditional-control').ok, '判定を関数にした書き方（isApproved(record)）は関数の中身で照合して止めない');
  const param = review("(function () {\n  'use strict';\n  function lockIf(record, locked) {\n    if (locked) record['amount'].disabled = true;\n  }\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    lockIf(event.record, event.record['ステータス'].value === '承認済み');\n    return event;\n  });\n})();");
  assert(param.registration.verdict === 'NEEDS_CONFIRMATION' && param.registration.confirmations.some(x => x.code === 'conditional-control'), '引数で渡した条件（中身を静的に追えない）→ 止めずに確認が必要');
  // 構造化されていない要件（条件は文だけ）でも、ループと hasOwnProperty だけに囲まれたロックは「条件なし」と同じ（確認に回す）
  const noCondLoop = review(wrap(['app.record.edit.show'], "    if (record['ステータス'].value === '承認済み') { record['amount'].disabled = true; }\n    record['items'].value.forEach(function (row) {\n      for (var key in row.value) {\n        if (row.value.hasOwnProperty(key)) { row.value['qty'].disabled = true; }\n      }\n    });"), cust({ requirement: '承認済みでは金額と明細を編集不可にする', fields: [{ code: 'amount', access: 'CONTROL' }, { code: 'items', access: 'CONTROL' }] }));
  assert(noCondLoop.registration.confirmations.some(x => x.code === 'unconditional-control' && /qty/.test(x.message)), `条件が構造化されていない要件: ループと hasOwnProperty だけの中のロックも「条件なし」と指摘: ${JSON.stringify(noCondLoop.registration.confirmations.map(x => x.code))}`);
  // 基準側（gpt-4.1-mini）CX-1 3 回目の差分そのもの: 既存の PC の handler の中に、新しい登録（PC ＋ モバイル）を丸ごと差し込んだ
  const LOCK_BASE = "(function () {\n  'use strict';\n  // 承認済みの案件は金額を変更できないようにする（既存の運用ルール）\n  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {\n    var record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }\n    return event;\n  });\n})();\n";
  const nestedPatch = { baseHash: null, operations: [{ type: 'INSERT_AFTER', anchor: "    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }", content: "\n  // PCとモバイルの両方のレコード作成・編集画面で承認済みなら金額と明細を編集不可にする\n  const EVENTS = ['app.record.create.show', 'app.record.edit.show', 'mobile.app.record.create.show', 'mobile.app.record.edit.show'];\n  kintone.events.on(EVENTS, function(event) {\n    var record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n      if (record['items'] && Array.isArray(record['items'].value)) {\n        record['items'].value.forEach(function(row) {\n          for (const col in row.value) {\n            row.value[col].disabled = true;\n          }\n        });\n      }\n    }\n    return event;\n  });" }] };
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
  const CELLS = "    var locked = record['ステータス'].value === '承認済み';\n    if (locked) {\n      record['amount'].disabled = true;\n      record['items'].value.forEach(function (row) {\n        for (var key in row.value) { row.value[key].disabled = true; }\n      });\n    }";
  const c = cust({ requirement: '承認済みでは金額と明細を編集不可にし、明細の行の追加・削除も禁止する', fields: [{ code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }, { code: 'items', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }] });
  const rv = review(wrap(['app.record.edit.show'], CELLS), c, { summary: '承認済みでは金額と明細を編集不可にし、明細の行追加・削除も禁止する' });
  assert(rv.coverage && rv.coverage.notAchieved.some(x => x.code === 'SUBTABLE_ROWS' && /行の追加・削除は止められません/.test(x.message)) && rv.coverage.achieved.some(x => /セルを編集不可/.test(x)), '達成範囲: セルの編集不可は達成・行の追加・削除は未達（Toolkit が示す）');
  assert(chk(rv, 'summary-scope') && !chk(rv, 'summary-scope').ok && /行の追加・削除は止まりません/.test(chk(rv, 'summary-scope').message) && rv.registration.verdict === 'NEEDS_CONFIRMATION', 'AI の要約「行追加・削除も禁止する」は満たせない → 確認が必要（要件を満たした扱いにしない）');
  assert(chk(rv, 'conditional-control') && rv.checks.filter(x => x.name === 'conditional-control').every(x => x.ok), '行のループでのセルのロックも、条件（locked = 承認済み）の中として認める');
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
  const rvBad = review(badCode, c);
  const refused = KTJsExecutor.changeFromGenerated({ customization: c, generated: REG.gen(badCode), review: rvBad });
  assert(!refused.ok && /登録できません/.test(refused.message), '要件違反（BLOCKED）のコードは登録の変更にできない');
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
  const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'] }, 'change-planner': { implemented: true, promptVersions: ['1'] }, 'customization-generator': { implemented: true, promptVersions: ['1'] } } }, contract: { usage: { usedThisMonth: 1, monthlyLimit: 200 } } };
  const CUST = { customizationId: 'C1', requirement: '承認済みでは金額を編集不可にする', whyStandardInsufficient: 'ステータスで編集可否を変えられない', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [], confidence: 'INFERRED' };
  const planResp = (goal) => ({ ok: true, contractVersion: '2.1', meta: { requestId: 'pl', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm' }, usage: { usedThisMonth: 1, monthlyLimit: 200 } }, plan: { goal, solution: 'CUSTOMIZATION', assessment: { summary: 's', usableExistingFields: [], usableExistingSettings: [], gaps: [], evidenceIds: [] }, relevantFields: [], proposedFields: [], steps: [step('C1', 'CUSTOMIZATION_REQUIRED', 'JS', 'lock.js', { customizationId: 'C1' }, { solution: 'CUSTOMIZATION', execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' } })], alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', customizations: [CUST] } });
  const CODE = REG.wrap(['app.record.edit.show'], "    if (record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }\n    kintone.api(kintone.api.url('/k/v1/records', true), 'GET', { app: 500, query: '' });");
  const client = {
    async getHealth() { return HEALTH; },
    async plan({ ctx, requestId }) { const v = KTAiClient.validatePlan(planResp(ctx.goal), ctx); if (!v.ok) throw new Error(JSON.stringify(v.errors)); return { ...v.normalized, requestId, clientWarnings: v.warnings }; },
    async generate({ ctx, requestId }) { return { requestId, strategy: 'NEW_JS_FILE', targetFile: 'lock.js', summary: '承認済みで金額を編集不可', code: CODE, patch: null, events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: ['kintone.api'], assumptions: [], warnings: [], gatewayChecks: {} }; },
  };
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner,customization-generator', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const flow = { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false };
  const host = makeFakeHost();
  const mock = makeKintoneMock(REG.data);
  const deps = KTDeps.buildDependencyData(REG.data, KTDeps.normalizeFields(REG.data.fields));
  const panel = mountAiWorkspace(host, { getInputs: () => ({ data: REG.data, deps, scan: null, incoming: null }), copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: flow, executor: { api: mock.api, appId: '310' } });
  await tick(8);
  await panel.send('承認済みでは金額を編集できなくしたい');
  const v1 = panel.conversation().activePlan();
  await panel.confirmSpec(v1.planId, v1.version);
  await panel.send('C1 のコードを作って');
  const g1 = panel.generated('C1');
  assert(g1 && g1.review.registration.verdict === 'NEEDS_CONFIRMATION', '前提: 生成したコードは「確認が必要」（他アプリの読み取り）');
  // 計画を修正して新しい版ができた後に、古い版のカードから登録しようとする
  await panel.send('承認待ちでも金額を編集不可にして', { intent: KTAiConversation.INTENT.REVISE_PLAN });
  const v2 = panel.conversation().activePlan();
  assert(v2 !== v1 && v2.version > v1.version, '前提: 計画が新しい版になった');
  await panel.startJsRegister(v1);
  assert(panel.jsExecState().stage === 'blocked' && panel.jsExecState().prepared.blockers.some(b => b.code === 'NOT_LATEST_VERSION') && !mock.calls.some(x => x === 'PUT customize'), '古い版（v1）のカードからは登録しない（NOT_LATEST_VERSION）');
  // 最新の版で生成して登録の確認へ: 確認の項目を 1 件ずつチェックするまで登録ボタンは押せない・押しても登録しない
  await panel.confirmSpec(v2.planId, v2.version);
  await panel.send('C1 のコードを作って');
  await panel.startJsRegister(panel.conversation().activePlan());
  await tick(4);
  const jx = panel.jsExecState();
  const paneHtml = () => host.querySelector('#kt-ai-jsreg').innerHTML;
  assert(jx.stage === 'confirm' && jx.prepared.confirmations.length >= 1 && /登録の前に確認が必要な項目/.test(paneHtml()) && /class="kt-ai-jsreg-ack"/.test(paneHtml()) && /id="kt-ai-jsreg-go"[^>]*disabled/.test(paneHtml()) && /動作は未確認/.test(paneHtml()), '確認画面: 確認が必要な項目（チェック欄）・動作は未確認・すべて確認するまで登録ボタンは無効');
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
  const { cust, wrap, review } = REG;
  const c = cust({ requirement: '承認済みでは明細の品名・数量を編集不可にする', fields: [{ code: 'item_name', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }, { code: 'qty', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }] });
  const inside = review(wrap(['app.record.edit.show'], "    if (record['ステータス'].value === '承認済み') {\n      record['items'].value.forEach(function (row) {\n        Object.keys(row.value).forEach(function (key) { row.value[key].disabled = true; });\n      });\n    }"), c);
  assert(inside.registration.verdict !== 'BLOCKED' && !inside.registration.blockers.some(b => b.code === 'planned-fields'), `G9: 計画した列（item_name / qty）を全列のループで条件の中でロック → 要件の処理がある（planned-fields で止めない）: ${JSON.stringify(inside.registration.blockers)}`);
  const outside = review(wrap(['app.record.edit.show'], "    record['items'].value.forEach(function (row) {\n      Object.keys(row.value).forEach(function (key) { row.value[key].disabled = true; });\n    });"), c);
  assert(outside.registration.verdict === 'BLOCKED' && outside.registration.blockers.some(b => b.code === 'conditional-control' && /item_name|qty/.test(b.message)), '全列のループが条件の外 → 計画した列も条件の外として登録不可');
  const both = review(wrap(['app.record.edit.show', 'mobile.app.record.edit.show'], "    if (record['ステータス'].value === '承認済み') {\n      record['items'].value.forEach(function (row) {\n        for (var key in row.value) { row.value[key].disabled = true; }\n      });\n    }"), cust({ platform: ['desktop', 'mobile'], events: ['app.record.edit.show', 'mobile.app.record.edit.show'], requirement: '承認済みでは明細を編集不可（PC とモバイル）', fields: [{ code: 'item_name', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }, { code: 'qty', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }] }));
  assert(!both.registration.blockers.some(b => b.code === 'platform-fields' || b.code === 'planned-fields'), `PC とモバイルの 1 つの handler で全列をロック → 両方の画面で扱っている: ${JSON.stringify(both.registration.blockers)}`);
  const oneCol = review(wrap(['app.record.edit.show'], "    if (record['ステータス'].value === '承認済み') {\n      record['items'].value.forEach(function (row) { row.value['item_name'].disabled = true; });\n    }"), c);
  assert(oneCol.registration.verdict === 'BLOCKED' && oneCol.registration.blockers.some(b => b.code === 'planned-fields' && /qty/.test(b.message)), '計画した列の一部（qty）しかロックしていない → 要件の処理が無い（登録不可）');
  // G8 の表示: 正確な要約（「セル」と書く）を「要約が言い切っている」としない。要件が明細そのものの変更禁止なら、行が残ることを要件の側の確認にする
  const CELL_LOCK = "    if (record['ステータス'].value === '承認済み') {\n      record['items'].value.forEach(function (row) { row.value['item_name'].disabled = true; row.value['qty'].disabled = true; });\n    }";
  const cellsOnly = review(wrap(['app.record.edit.show'], CELL_LOCK), cust({ requirement: '承認済みでは明細の品名・数量のセルを編集不可にする', fields: [{ code: 'item_name', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }, { code: 'qty', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }] }), { summary: '承認済みのとき明細の品名・数量のセルを編集不可にします' });
  assert(!cellsOnly.registration.confirmations.some(x => x.code === 'summary-scope' || x.code === 'requirement-scope') && cellsOnly.coverage.notAchieved.some(x => x.code === 'SUBTABLE_ROWS'), `要件も要約も「セル」に限る → 確認にしない（行が残ることは達成範囲に出す）: ${JSON.stringify(cellsOnly.registration.confirmations.map(x => x.code))}`);
  const tableReq = review(wrap(['app.record.edit.show'], CELL_LOCK), cust({ requirement: '承認済みでは明細を変更できないようにする', fields: [{ code: 'item_name', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }, { code: 'qty', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }] }), { summary: '承認済みのとき明細の品名・数量のセルを編集不可にします' });
  assert(tableReq.registration.confirmations.some(x => x.code === 'requirement-scope' && /行の追加・削除/.test(x.message) && /運用/.test(x.howToCheck)) && !tableReq.registration.confirmations.some(x => x.code === 'summary-scope'), '要件は明細の変更禁止・要約は正確 → 要件の側の確認（requirement-scope）。要約の問題にはしない');
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
  const svc = (p) => ({ async plan() { return { plan: p, ctx: null, review: null }; }, async ask() { return { ok: true, answer: { answer: 'a' } }; } });
  const one = KTAiConversation.create({ services: svc(mkPlan(['C1'])) });
  await one.send('紹介元を顧客区分で切り替えて表示したい');
  const v1 = one.activePlan(); v1.generated = { C1: { generated: { strategy: 'NEW_JS_FILE' } } };
  one.noteJsExecution({ stage: 'running', execution: { executionId: 'jx1', status: 'RUNNING', put: null } });
  one.noteJsExecution({ stage: 'done', execution: { executionId: 'jx1', status: 'DONE', put: { ok: true } } });
  assert(v1.status === 'EXECUTED' && v1.jsExecutionId === 'jx1', `カスタマイズだけの計画で、すべて生成して登録 → 計画は反映済み: ${v1.status}`);
  const next = KTAiConversation.classifyIntent('顧客区分を既存に変えたら紹介元を空にして', { activePlan: { ...v1, plan: { ...v1.plan, proposedFields: [{ temporaryId: 'NEW_FIELD_1', label: '紹介元', suggestedCode: 'referral_source' }] } } });
  assert(next.intent === KTAiConversation.INTENT.PLAN, `登録の後の依頼は新しい計画（登録済みのカスタマイズを含む見直しにしない）: ${next.intent}/${next.reason}`);
  const two = KTAiConversation.create({ services: svc(mkPlan(['C1', 'C2'])) });
  await two.send('紹介元を顧客区分で切り替えて表示したい');
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
  const sc = shown.checks.find(x => x.name === 'conditional-control');
  assert(sc && sc.ok && /表示の切り替え/.test(sc.message) && !shown.registration.confirmations.some(x => x.code === 'conditional-control'), `表示の切り替え（setFieldShown）が条件の項目を見ている → 確認にしない: ${sc && sc.message}`);
  const err = rv(['app.record.create.submit', 'app.record.edit.submit'], "    if (event.record['customer_category'].value === '新規' && !event.record['referral_source'].value) {\n      event.record['referral_source'].error = '紹介元を入力してください';\n    } else {\n      event.record['referral_source'].error = null;\n    }", 'customer_category in ("新規")');
  assert(err.checks.find(x => x.name === 'conditional-control').ok && !err.registration.confirmations.some(x => x.code === 'conditional-control'), '入力チェック（.error）が条件の中 → 確認にしない');
  const blindShown = rv(['app.record.edit.show'], "    kintone.app.record.setFieldShown('referral_source', false);", 'customer_category not in ("新規")');
  assert(blindShown.registration.confirmations.some(x => x.code === 'conditional-control' && /表示の切り替えで制御していますが/.test(x.message)), '条件を見ない表示の切り替え → 確かめられないので確認');
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
