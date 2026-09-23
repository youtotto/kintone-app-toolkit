// 他アプリからの参照（KTIncoming）：ルックアップの参照キー／コピー元の計上と、走査結果の Fields 反映の回帰テスト
//
// 背景（v2.2.4 で確認された 2 件の問題）:
//   問題1: Relations タブで「他アプリからの参照」を走査しても、Fields タブの利用数・変更影響が
//          ページを再読み込みするまで更新されなかった（走査完了時に Fields の再計算契機が無かった）。
//   問題2: 見積（297）のルックアップが 商品マスタ（296）の old_price を「ほかのフィールドのコピー」の
//          コピー元にしていても、296 側の Fields で old_price の「他アプリ」が 0 件のままだった
//          （走査結果の行に参照キーしか保持しておらず、コピー元が依存エッジに展開されていなかった）。
//
// 検証内容:
//   1. ルックアップキーの参照先フィールドが incoming dependency として計上される
//   2. ルックアップのコピー元フィールドも incoming dependency として計上される
//   3. コピー先フィールド（相手アプリ側）を、このアプリの参照先フィールドと誤認しない
//   4. 複数のコピー項目（テーブル内ルックアップ含む）がすべて計上される
//   5. 走査結果を取り込んだ後に Fields の集計（impactOf）を再生成すると最新結果が反映される
//   6. 走査前は「未走査」、走査完了で onDepsUpdated が呼ばれ、ページ再読み込みなしで最新状態になる
//   7. ルックアップ以外（関連レコード・アプリアクション・297 側の依存生成）に回帰がない
//
// 実行方法:
//   node tests/incoming-lookup-refs.test.js
//   （終了コード 0 = 成功、1 = 失敗）
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const FX = require('./fixtures/lookup-apps-296-297.js');

// ---- 実スクリプトを sandbox に読み込み、内部モジュール／関数を取り出す ----
const SRC = path.join(__dirname, '..', 'kintoneAppToolkit.user.js');
let code = fs.readFileSync(SRC, 'utf8');
const lastClose = code.lastIndexOf('})();');
if (lastClose < 0) throw new Error('IIFE close not found');
code = code.slice(0, lastClose)
  + '\n  globalThis.__TEST__ = { KTIncoming, KTDeps, buildRelations, bindIncoming };\n'
  + code.slice(lastClose);

const noop = () => { };
// キャッシュの版管理を検証するため、値を実際に保持する localStorage 代替
const store = new Map();
const fakeStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const sandbox = {
  console, setTimeout, clearTimeout,
  setInterval: () => 0, clearInterval: noop, // waitReady のポーリングは動かさない（起動処理は走らせない）
  localStorage: fakeStorage, sessionStorage: fakeStorage,
  navigator: {},
  document: {
    createElement: () => ({ style: {}, setAttribute: noop, addEventListener: noop, appendChild: noop }),
    querySelector: () => null, getElementById: () => null,
    head: { appendChild: noop }, body: { appendChild: noop, removeChild: noop },
    documentElement: { matches: () => false },
    addEventListener: noop,
  },
  matchMedia: () => ({ matches: false, addEventListener: noop }),
  location: { host: 'test.cybozu.com', origin: 'https://test.cybozu.com' },
  requestIdleCallback: noop,
  ResizeObserver: class { observe() { } disconnect() { } },
  addEventListener: noop, removeEventListener: noop,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'kintoneAppToolkit.user.js' });
const { KTIncoming, KTDeps, buildRelations, bindIncoming } = sandbox.__TEST__;

// ---- kintone API のスタブ（走査で使う /k/v1/apps, /k/v1/app/form/fields, /k/v1/app/actions だけ応答する）----
const apiCalls = [];
const api = async (u, method, params) => {
  const s = String(u);
  apiCalls.push({ path: s, params });
  if (s.startsWith('/k/v1/apps')) {
    if (params && Array.isArray(params.ids)) {
      const ids = params.ids.map(String);
      return { apps: FX.apps.filter(a => ids.includes(String(a.appId))) };
    }
    const offset = Number(params?.offset || 0);
    const limit = Number(params?.limit || 100);
    return { apps: FX.apps.slice(offset, offset + limit) };
  }
  if (s.startsWith('/k/v1/app/form/fields')) {
    const f = FX.fieldsByApp[String(params?.app)];
    if (!f) throw new Error('GAIA_AP01: permission denied (403)');
    return f;
  }
  if (s.startsWith('/k/v1/app/actions')) return FX.actionsByApp[String(params?.app)] || { actions: {} };
  return {};
};
api.url = (p) => p;
sandbox.kintone = { api, app: { getId: () => null } };

// ---- テストユーティリティ ----
let failed = 0;
const assert = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) failed++;
};
const SELF = FX.SELF_APP; // '296'
const app297 = FX.apps.find(a => a.appId === '297');
const app298 = FX.apps.find(a => a.appId === '298');

/** 商品マスタ（296）の依存関係データを新しく作る */
const buildDeps296 = () => {
  const DATA = { appId: Number(SELF), fields: FX.fields296.properties, actions: { actions: {} }, settings: { name: '商品マスタ' } };
  return KTDeps.buildDependencyData(DATA, KTDeps.normalizeFields(DATA.fields));
};
const incomingEdges = (deps, code) => deps.edges.filter(e =>
  e.relationType === 'REFERENCED_BY' && e.sourceType === 'EXTERNAL_APP' && e.targetType === 'FIELD' && e.targetId === code);
const crossTexts = (deps, code) => KTDeps.impactOf(deps, code).crossApp.map(c => `${c.text}｜${c.note}`);
const hasUnscannedCaution = (deps, code) => KTDeps.impactOf(deps, code).cautions.some(c => /未走査/.test(c));

// =========================================================
// 1. 走査（analyzeApp）：見積（297）から 商品マスタ（296）への参照行
// =========================================================
console.log('\n--- 1. analyzeApp: 参照キーとコピー元を行に保持する ---');
const rows297 = KTIncoming.analyzeApp(app297, SELF, FX.fields297, FX.actions297);
const luRow = rows297.find(r => r.kind === 'ルックアップ' && r.sourceField === 'product_lookup');
assert(!!luRow, 'ルックアップ「商品」（product_lookup）の行が生成される');
assert(luRow?.targetField === 'product_code', `参照キー targetField = product_code（実際: ${luRow?.targetField}）`);
assert(luRow?.appId === '297' && luRow?.appName === '見積', '参照元アプリは app 297 見積');
assert(luRow?.sourceLabel === '商品', `参照元の設定名はフィールドラベル「商品」（実際: ${luRow?.sourceLabel}）`);
const copyFroms = (luRow?.copyFields || []).map(c => c.from);
assert(copyFroms.includes('old_price'), `copyFields に old_price（コピー元）が含まれる（実際: ${JSON.stringify(luRow?.copyFields)}）`);
assert(copyFroms.includes('product_name'), 'copyFields に product_name（コピー元）が含まれる');
assert((luRow?.copyFields || []).find(c => c.from === 'old_price')?.to === 'quote_price', 'old_price のコピー先 quote_price を保持する（表示用）');
assert(!copyFroms.includes('quote_price') && !copyFroms.includes('quote_product_name'), 'コピー先（quote_price / quote_product_name）はコピー元として扱わない');
assert(luRow?.note === '2項目を取得', `備考は従来どおり「2項目を取得」（実際: ${luRow?.note}）`);
assert(!rows297.some(r => r.sourceField === 'customer_lookup'), '別アプリ（298）向けのルックアップは 296 への参照として扱わない');

// =========================================================
// 2. applyIncomingRefs → impactOf：Fields の「他アプリ」集計に反映される
// =========================================================
console.log('\n--- 2. 参照キー／コピー元が incoming dependency として計上される ---');
const deps = buildDeps296();
const incoming = {
  rows: [...rows297, ...KTIncoming.analyzeApp(app298, SELF, FX.fields298, FX.actionsByApp['298'])],
  errors: [], stats: { scannedApps: 2, referencingApps: 1, failedApps: 0, includeActions: true, truncated: false },
  scannedAt: '2026-09-23T00:00:00.000Z',
};
// 走査前のスナップショット（Fields 初回描画に相当）
const beforeKey = KTDeps.impactOf(deps, 'product_code');
const beforeCopy = KTDeps.impactOf(deps, 'old_price');
assert(beforeKey.counts.crossApp === 0 && beforeCopy.counts.crossApp === 0, '走査前: product_code / old_price の他アプリ件数は 0');
assert(hasUnscannedCaution(deps, 'old_price'), '走査前: 変更影響の注意書きに「未走査」が出る');

KTDeps.applyIncomingRefs(deps, incoming);

// product_code は「商品」（product_lookup）と テーブル内「明細商品」（item_lookup）の両方の参照キー → 2 件
const keyImpact = KTDeps.impactOf(deps, 'product_code');
assert(keyImpact.counts.crossApp === 2, `product_code: 他アプリからの参照 2 件（2つのルックアップの参照キー。実際: ${keyImpact.counts.crossApp}）`);
assert(incomingEdges(deps, 'product_code').filter(e => e.context?.settingName === '商品').length === 1,
  'product_code: ルックアップ「商品」の参照キーとして 1 件');
// 「他アプリ連携 N 件」の N は参照設定（依存関係）の件数であり、参照元アプリのユニーク数ではない
//   同じ App 297 の 2 つのルックアップから参照 → 2 件（参照元アプリは 1 アプリ）。影響詳細では個別に確認できる
{
  const srcApps = new Set(incomingEdges(deps, 'product_code').map(e => e.sourceId));
  assert(keyImpact.counts.crossApp === 2 && srcApps.size === 1,
    `他アプリ連携の件数は設定単位（2 件）で、参照元アプリ数（${srcApps.size}）ではない`);
  const names = keyImpact.crossApp.map(c => (c.text.match(/ルックアップ「([^」]+)」/) || [])[1]).sort();
  assert(JSON.stringify(names) === JSON.stringify(['商品', '明細商品']),
    `影響詳細で「商品」「明細商品」の 2 参照を個別に確認できる（実際: ${names.join(', ')}）`);
}
const keyText = crossTexts(deps, 'product_code').join(' || ');
assert(/app 297 見積/.test(keyText) && /ルックアップ「商品」/.test(keyText) && /参照キー/.test(keyText),
  `product_code: どのアプリ・どのルックアップ・どの役割かが分かる（実際: ${keyText}）`);

const copyImpact = KTDeps.impactOf(deps, 'old_price');
assert(copyImpact.counts.crossApp === 1, `old_price: 他アプリからの参照 1 件（実際: ${copyImpact.counts.crossApp}）`);
const copyText = crossTexts(deps, 'old_price').join(' || ');
assert(/app 297 見積/.test(copyText) && /ルックアップ「商品」/.test(copyText) && /コピー元/.test(copyText),
  `old_price: ルックアップ「商品」のコピー元として参照されていることが分かる（実際: ${copyText}）`);
assert(/quote_price/.test(copyText), 'old_price: コピー先（quote_price）が備考で分かる');
const copyEdge = incomingEdges(deps, 'old_price')[0];
assert(copyEdge?.confidence === 'CERTAIN' && copyEdge?.context?.settingType === 'INCOMING_ルックアップ',
  '既存モデル（REFERENCED_BY / EXTERNAL_APP / CERTAIN）のまま表現されている');
assert(copyEdge?.context?.role === 'コピー元', `エッジの context.role = コピー元（実際: ${copyEdge?.context?.role}）`);
assert(incomingEdges(deps, 'product_code')[0]?.context?.role === '参照キー', 'product_code のエッジの context.role = 参照キー');

// 直接利用の一覧にも「どの設定のどの役割か」が添えられる（利用数の内訳として確認できる）
const directIn = copyImpact.direct.find(d => d.sourceType === 'EXTERNAL_APP');
assert(!!directIn && /ルックアップ「商品」のコピー元/.test(directIn.note),
  `直接利用の注記にルックアップ名と役割が入る（実際: ${directIn?.note}）`);
assert(copyImpact.counts.direct === 1, `old_price の利用数（直接）が 1 になる（実際: ${copyImpact.counts.direct}）`);

// 使用箇所バッジは生の識別子（EXTERNAL_APP）ではなく「他アプリ」
const usage = KTDeps.usageMapFromEdges(deps.edges);
assert(Array.isArray(usage.old_price) && usage.old_price.includes('他アプリ') && !usage.old_price.includes('EXTERNAL_APP'),
  `使用箇所バッジは「他アプリ」（実際: ${JSON.stringify(usage.old_price)}）`);
assert(deps.meta.incomingScannedAt === incoming.scannedAt, 'meta.incomingScannedAt が走査日時になる');
assert(!hasUnscannedCaution(deps, 'old_price'), '走査後: 「未走査」の注意書きが消える');

// =========================================================
// 3. コピー先（相手アプリ側）を誤認しない
// =========================================================
console.log('\n--- 3. コピー先フィールドを誤認しない ---');
for (const c of ['quote_price', 'quote_product_name', 'item_price', 'customer_name']) {
  assert(incomingEdges(deps, c).length === 0, `296 側に ${c}（297 側のコピー先）への被参照エッジが作られない`);
}
assert(!deps.nodes.some(n => n.type === 'FIELD' && /quote_price/.test(n.id)), '296 側に quote_price の FIELD ノードが増えない');

// 297 側（参照元アプリ）の依存生成は従来どおり：コピー元は EXTERNAL_FIELD、コピー先は自アプリの FIELD
const DATA297 = { appId: 297, fields: FX.fields297.properties, actions: FX.actions297, settings: { name: '見積' } };
const deps297 = KTDeps.buildDependencyData(DATA297, KTDeps.normalizeFields(DATA297.fields));
const ext = (id) => deps297.edges.some(e => e.targetType === 'EXTERNAL_FIELD' && e.targetId === id);
assert(ext('296:product_code'), '297 側: LOOKUP_KEY → EXTERNAL_FIELD 296:product_code');
assert(ext('296:old_price'), '297 側: コピー元 → EXTERNAL_FIELD 296:old_price');
assert(!ext('296:quote_price') && !ext('297:quote_price'), '297 側: コピー先 quote_price は外部フィールドにならない');
assert(deps297.edges.some(e => e.relationType === 'LOOKUP_COPY_TO' && e.targetType === 'FIELD' && e.targetId === 'quote_price'),
  '297 側: quote_price は自アプリの LOOKUP_COPY_TO（従来どおり）');

// =========================================================
// 4. 複数のコピー項目（テーブル内ルックアップ含む）がすべて計上される
// =========================================================
console.log('\n--- 4. 複数のコピー項目がすべて計上される ---');
const luEdges = deps.edges.filter(e => e.relationType === 'REFERENCED_BY' && e.context?.settingName === '商品');
assert(luEdges.length === 3, `ルックアップ「商品」由来のエッジ = 3（参照キー1＋コピー元2。実際: ${luEdges.length}）`);
assert(incomingEdges(deps, 'product_name').some(e => e.context?.settingName === '商品' && e.context?.role === 'コピー元'),
  'product_name もルックアップ「商品」のコピー元として計上される');
const itemRow = rows297.find(r => r.kind === 'ルックアップ' && r.sourceField === 'item_lookup');
assert(!!itemRow && /テーブル items 内/.test(itemRow.note), `テーブル内ルックアップの行が生成される（備考: ${itemRow?.note}）`);
assert(incomingEdges(deps, 'new_price').some(e => e.context?.settingName === '明細商品' && e.context?.role === 'コピー元'),
  'テーブル内ルックアップ「明細商品」のコピー元 new_price も計上される');
assert(KTDeps.impactOf(deps, 'new_price').counts.crossApp === 1, 'new_price: 他アプリからの参照 1 件');
// 同じフィールドが参照キーとコピー元を兼ねる場合は 1 本にまとめ、役割を併記する
{
  const d2 = buildDeps296();
  KTDeps.applyIncomingRefs(d2, {
    rows: [{ appId: '297', appName: '見積', kind: 'ルックアップ', sourceField: 'x', sourceLabel: 'X',
      targetField: 'product_code', copyFields: [{ from: 'product_code', to: 'code_copy' }], note: '1項目を取得' }],
    stats: {}, scannedAt: '2026-09-23T00:00:00.000Z',
  });
  const es = incomingEdges(d2, 'product_code');
  assert(es.length === 1 && es[0].context.role === '参照キー・コピー元',
    `参照キー兼コピー元は 1 本のエッジに役割を併記（実際: ${es.length} 本, role=${es[0]?.context?.role}）`);
}

// =========================================================
// 5. 走査後に Fields の集計を再生成すると最新結果が反映される（再取り込みで重複しない）
// =========================================================
console.log('\n--- 5. 集計の再生成 ---');
assert(beforeCopy.counts.crossApp === 0 && KTDeps.impactOf(deps, 'old_price').counts.crossApp === 1,
  '同じ deps オブジェクトで impactOf を取り直すと 0 → 1 に更新される（Fields 再描画で反映される前提が成り立つ）');
const edgeCountOnce = deps.edges.length;
KTDeps.applyIncomingRefs(deps, incoming);
assert(deps.edges.length === edgeCountOnce, `再取り込みしてもエッジが重複しない（${edgeCountOnce} → ${deps.edges.length}）`);
assert(KTDeps.impactOf(deps, 'old_price').counts.crossApp === 1, '再取り込み後も old_price は 1 件のまま');

// =========================================================
// 6. 走査前は「未走査」、走査完了で onDepsUpdated が呼ばれ、再読み込みなしで最新になる
// =========================================================
console.log('\n--- 6. Relations の走査 → Fields 再計算の契機 ---');
function fakeEl() {
  const listeners = {};
  return {
    disabled: false, textContent: '', innerHTML: '', checked: true,
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    querySelector: () => null,
    fire: async (ev) => { for (const fn of (listeners[ev] || [])) await fn(); },
  };
}
const makeView = () => {
  const els = { '#kt-in-scan': fakeEl(), '#kt-in-status': fakeEl(), '#kt-in-result': fakeEl(), '#kt-in-actions': fakeEl() };
  return { els, view: { querySelector: (sel) => els[sel] || null } };
};

(async () => {
  // 旧形式（v1）のキャッシュが残っていても読まずに破棄する（コピー元を持たないため）
  store.set(`ktIncoming.v1.${SELF}`, JSON.stringify({ rows: [], stats: {}, scannedAt: new Date().toISOString() }));
  assert(KTIncoming.loadCache(SELF) === null, '旧形式（v1）のキャッシュは読まない');
  assert(!store.has(`ktIncoming.v1.${SELF}`), '旧形式（v1）のキャッシュは破棄される');

  const depsUI = buildDeps296();
  let updated = 0;
  const { els, view } = makeView();
  bindIncoming(view, Number(SELF), depsUI, () => { updated++; });
  assert(els['#kt-in-status'].textContent === '未走査', `走査前のステータスは「未走査」（実際: ${els['#kt-in-status'].textContent}）`);
  assert(hasUnscannedCaution(depsUI, 'old_price') && KTDeps.impactOf(depsUI, 'old_price').counts.crossApp === 0,
    '走査前: Fields の集計は「未走査」＋他アプリ 0 件');
  assert(updated === 0, '走査前は onDepsUpdated を呼ばない');

  // 「走査する」を押す（実際の KTIncoming.run が API スタブに対して動く）
  apiCalls.length = 0;
  await els['#kt-in-scan'].fire('click');

  assert(updated === 1, `走査完了で onDepsUpdated が 1 回呼ばれる（実際: ${updated} 回）`);
  assert(/2 アプリを確認/.test(els['#kt-in-status'].textContent) && /1 アプリから参照あり/.test(els['#kt-in-status'].textContent),
    `走査結果のサマリーが表示される（実際: ${els['#kt-in-status'].textContent}）`);
  assert(apiCalls.some(c => c.path.startsWith('/k/v1/app/form/fields') && String(c.params.app) === '297'), '297 のフォーム設定を取得している');
  assert(!apiCalls.some(c => c.path.startsWith('/k/v1/app/form/fields') && String(c.params.app) === SELF), '自アプリ（296）は走査対象に含めない');

  // 同じ deps オブジェクトから再計算すると最新の被参照が反映される（＝再読み込み不要）
  assert(KTDeps.impactOf(depsUI, 'product_code').counts.crossApp === 2, '走査後: product_code の他アプリ件数 2（「商品」「明細商品」の参照キー）');
  assert(KTDeps.impactOf(depsUI, 'old_price').counts.crossApp === 1, '走査後: old_price の他アプリ件数 1');
  assert(!hasUnscannedCaution(depsUI, 'old_price'), '走査後: 「未走査」の注意書きが消える');
  assert(/old_price/.test(els['#kt-in-result'].innerHTML) && /コピー元/.test(els['#kt-in-result'].innerHTML),
    'Relations の一覧にもコピー元（old_price）が表示される');
  assert(/product_code/.test(els['#kt-in-result'].innerHTML) && /参照キー/.test(els['#kt-in-result'].innerHTML),
    'Relations の一覧に参照キー（product_code）が表示される');

  // 走査結果は新形式（v2）で保存され、次回はキャッシュから復元できる
  const cached = KTIncoming.loadCache(SELF);
  assert(store.has(`ktIncoming.v2.${SELF}`) && !!cached, '走査結果は v2 形式でキャッシュされる');
  assert(!!cached && cached.rows.some(r => r.sourceField === 'product_lookup' && (r.copyFields || []).some(c => c.from === 'old_price')),
    'キャッシュにコピー元（copyFields）が含まれる');

  // キャッシュから復元する描画（再描画時）は、deps へ取り込むが onDepsUpdated は呼ばない（無限ループ防止）
  const depsCached = buildDeps296();
  let updated2 = 0;
  const v2 = makeView();
  bindIncoming(v2.view, Number(SELF), depsCached, () => { updated2++; });
  assert(/キャッシュ/.test(v2.els['#kt-in-status'].textContent), 'キャッシュからの復元表示になる');
  assert(KTDeps.impactOf(depsCached, 'old_price').counts.crossApp === 1, 'キャッシュ復元でも deps に取り込まれる');
  assert(updated2 === 0, 'キャッシュ復元時は onDepsUpdated を呼ばない');

  // =========================================================
  // 7. ルックアップ以外に回帰がない
  // =========================================================
  console.log('\n--- 7. ルックアップ以外の走査・依存生成に回帰がない ---');
  const rtRow = rows297.find(r => r.kind === '関連レコード');
  assert(!!rtRow && rtRow.sourceField === 'related_products' && rtRow.targetField === 'category' && rtRow.note === 'quote_category で突合',
    `関連レコードの行（突合フィールド category）は従来どおり（実際: ${JSON.stringify(rtRow && { t: rtRow.targetField, n: rtRow.note })}）`);
  assert(incomingEdges(deps, 'category').some(e => e.context?.kind === '関連レコード' && !e.context?.role),
    'category: 関連レコードからの被参照エッジ（役割の付与なし）');
  assert(/app 297 見積 の関連レコード「関連商品」から参照されている/.test(crossTexts(deps, 'category').join(' ')),
    `関連レコードの文言は従来どおり（実際: ${crossTexts(deps, 'category').join(' ')}）`);
  const acRow = rows297.find(r => r.kind === 'アプリアクション');
  assert(!!acRow && JSON.stringify(acRow.destFields) === JSON.stringify(['product_name', 'memo']) && acRow.note === '2項目を転記',
    'アプリアクションの行（転記先 product_name / memo）は従来どおり');
  assert(incomingEdges(deps, 'memo').length === 1 && incomingEdges(deps, 'memo')[0].context.role === '転記先',
    'memo: アプリアクションの転記先として 1 件');
  assert(KTDeps.impactOf(deps, 'product_name').counts.crossApp === 2,
    `product_name: ルックアップのコピー元 1 件＋アプリアクションの転記先 1 件 = 2（実際: ${KTDeps.impactOf(deps, 'product_name').counts.crossApp}）`);
  // 297 側の Relations（Summary と Details の整合）も従来どおり
  const rel297 = buildRelations(DATA297);
  const links297 = KTDeps.buildAppLinks(deps297, 297);
  assert(rel297.lookups.length === links297.filter(r => r.kind === 'ルックアップ').length,
    `297 側: relations.lookups(${rel297.lookups.length}) ⇔ Summary ルックアップ(${links297.filter(r => r.kind === 'ルックアップ').length})`);
  assert(rel297.relatedTables.length === links297.filter(r => r.kind === '関連レコード').length, '297 側: 関連レコードの件数整合');
  assert(rel297.lookups.find(l => l.code === 'product_lookup')?.fieldMappings.some(m => m.from === 'old_price' && m.to === 'quote_price'),
    '297 側 Details: old_price → quote_price のコピー設定を保持');

  console.log(`\n${failed ? 'FAILED' : 'ALL PASSED'}: ${failed} failure(s)`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
