// Non-AI settings-fetch behavior retained from the original panel test. Old AI state/precheck cases are replaced by release-workspace and execution suites.
'use strict';
// 偽の DOM では Fields の表の描画（renderFields の行の追加）が途中で失敗する（querySelector が #id だけ）。描画の失敗はこの試験の対象ではないので無視する。
//   それ以外の非同期の失敗は数えて、最後に 0 件であることを確かめる
const KNOWN_REJECTIONS = [/kintone is not defined/, /renderFields|renderRows/];
const unexpected = [];
process.on('unhandledRejection', (e) => { const s = String((e && (e.stack || e.message)) || e); if (KNOWN_REJECTIONS.some(re => re.test(s))) return; unexpected.push(s.slice(0, 300)); });
const path = require('path');
const SRC_PATH = process.env.KT_SRC || path.join(__dirname, '..', 'kintoneAppToolkit.user.js');
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');

const { makeFakeDocument } = require('./helpers/fake-dom.js');
const { makeFakeKintone } = require('./helpers/fake-kintone-api.js');
const FX = require('./fixtures/ai-context-app.js');
const { assert, state } = makeAssert();

const MINI_KEY = 'kt_mini_test.cybozu.com_global';
const ticks = async (n = 40) => { for (let k = 0; k < n; k++) await new Promise(r => setImmediate(r)); };
function makeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  const writes = [];
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { writes.push([k, String(v)]); m.set(k, String(v)); }, removeItem: (k) => m.delete(k), _m: m, writes };
}
const fakeMonaco = (() => {
  const editor = { value: '', setValue(v) { this.value = v; }, getValue() { return this.value; }, getModel() { return {}; }, focus() { }, getSelection() { return null; }, onDidChangeModelContent() { return { dispose() { } }; } };
  return { editor: { create: () => editor, setModelLanguage: () => { } }, languages: { registerCompletionItemProvider: () => { }, CompletionItemKind: { Field: 1, Snippet: 2 } }, Range: function () { } };
})();

/** 1 回のページ（sandbox）。storage を渡すと、同じ localStorage で読み込み直す（画面遷移） */
function makeEnv({ mini = null, storage = null, data = null, admin = true, layout = null, gateway = null } = {}) {
  const { doc, byId } = makeFakeDocument();
  // This fetch-count test uses a flat DOM. Resolve the reference and manual confirmation descendants;
  // rendering and resize behavior remain covered by release-customize-browser.test.js.
  const setElement = byId.set.bind(byId);
  byId.set = (id, element) => {
    const query = element.querySelector.bind(element);
    element.querySelector = selector => {
      if (id === 'kt-customize-manual-confirm' && /^\[data-manual-(description|cancel|confirm)\]$/.test(selector)) return byId.get('view-customize').querySelector(selector);
      const child = /^#kt-customize-reference-info (\[data-reference-content\]|\[data-open-deps\])$/.exec(String(selector));
      return child && byId.has('kt-customize-reference-info') ? byId.get('view-customize').querySelector(child[1]) : query(selector);
    };
    return setElement(id, element);
  };
  const store = storage || makeStorage(mini == null ? {} : { [MINI_KEY]: mini });
  const T = loadToolkit({ document: doc, localStorage: store });
  const g = T.__sandbox;
  // Observe the unchanged free-product dependency calculation, not a retired AI panel alias.
  let currentData = null;
  const buildDeps = T.KTDeps.buildDependencyData;
  T.KTDeps.buildDependencyData = (...args) => { currentData = args[0]; return buildDeps(...args); };
  const fk = makeFakeKintone(data || FX.makeData(), { admin, layout, gateway });
  const registered = { window: [], document: [], kintone: [] };
  fk.kintone.events = { on: (type, fn) => { registered.kintone.push({ type, fn }); } };
  g.kintone = fk.kintone; g.fetch = fk.fetch;
  g.alert = () => { }; g.confirm = () => true;
  g.addEventListener = (type, fn) => { registered.window.push({ type, fn }); };
  doc.addEventListener = (type, fn) => { registered.document.push({ type, fn }); };
  g.loadMonaco = async () => fakeMonaco;
  const idle = []; g.requestIdleCallback = (fn) => { idle.push(fn); };
  const intervals = []; g.setInterval = (fn) => { intervals.push(fn); return intervals.length; };
  const realSetTimeout = setTimeout;
  g.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, (ms >= 1000 && ms < 9000) ? 0 : ms, ...a);   // deploy の完了待ち（1.5 秒ごと）を待たない
  const start = () => T.startToolkit();
  /** 待ち（ブラウザが空いた時点の予約も実行する） */
  const settle = async () => { await ticks(); for (let r = 0; r < 6 && idle.length; r++) { for (const fn of idle.splice(0)) { try { fn(); } catch (e) { } } await ticks(); } };
  const click = (id) => { const el = byId.get(id); if (!el) throw new Error(`要素がありません: #${id}`); return el.dispatch('click', { currentTarget: el }); };
  const wrap = () => doc.body.children.find(el => el && el.id === 'kt-toolkit') || null;
  const isMini = () => { const w = wrap(); return !!(w && w.classList.contains('is-mini')); };
  return { T, g, doc, byId, fk, store, registered, idle, intervals, start, settle, click, wrap, isMini, currentData: () => currentData, mark: () => fk.calls.length };
}
const sameMap = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const fmt = (m) => Object.keys(m).length ? Object.entries(m).map(([k, v]) => `${k}×${v}`).join(', ') : '（なし）';
const safe = async (label, fn) => { try { await fn(); } catch (e) { assert(false, `${label}: 例外 ${String(e && e.message || e).slice(0, 200)}`); } };

// 段階 1（運用環境の設定の一括取得。Health・Fields などの解析タブが使う）
const STAGE1 = {
  'JS API kintone.app.getFormFields': 1, 'JS API kintone.app.getFormLayout': 1,
  'GET /k/v1/app/views': 1, 'GET /k/v1/app/reports': 1, 'GET /k/v1/app/status': 1,
  'GET /k/v1/app/notifications/general': 1, 'GET /k/v1/app/notifications/perRecord': 1, 'GET /k/v1/app/notifications/reminder': 1,
  'GET /k/v1/app/customize': 1, 'GET /k/v1/app/acl': 1, 'GET /k/v1/record/acl': 1, 'GET /k/v1/field/acl': 1,
  'GET /k/v1/app/actions': 1, 'GET /k/v1/plugins': 1, 'GET /k/v1/app/settings': 1, 'GET /k/v1/app/plugins': 1,
};
// JS の自動解析（Health の整合性チェック・Fields などが使う。ブラウザが空いた時点）。fixture の JS の FILE は 3 件（URL 1 件は外部なので取らない）
const SCAN = { 'GET /k/v1/preview/app/customize': 1, 'fetch /k/v1/file': 3 };
const TABLE = [];   // { c: ケース, label: 場面, s: 設定取得の呼び出し, o: 設定取得ではない通信, fk }

(async () => {
console.log(`\n対象: ${SRC_PATH}`);

// =========================================================
console.log('\n--- §1. 最小化の状態（保存された状態）で初期表示: 設定取得 0 回 ---');
const shared = makeStorage({ [MINI_KEY]: '1' });
await safe('§1', async () => {
  const e = makeEnv({ storage: shared });
  await e.start(); await e.settle();
  const s = e.fk.settingsCalls(), o = e.fk.otherCalls();
  TABLE.push({ c: '1', label: '最小化で初期表示（idle の予約も実行）', s, o, fk: e.fk });
  assert(s.length === 0, `1-1 最小化で開いたら設定取得 0 回: ${s.length} 回（${fmt(e.fk.byPath(s))}）`);
  assert(o.length === 0, `1-2 設定取得ではない通信も起動では起きない（Health のレコードは描画の後）: ${fmt(e.fk.byPath(o))}`);
  assert(e.isMini(), '1-3 最小化の状態は復元されている（is-mini）');
  assert(shared.getItem(MINI_KEY) === '1' && !shared.writes.some(([k]) => k === MINI_KEY), '1-4 起動で最小化の保存の値を書き換えない（復元だけ）');
  assert(e.idle.length === 0, `1-5 最小化中は JS の自動解析を予約しない（requestIdleCallback ${e.idle.length} 件）`);
});

// =========================================================
console.log('\n--- §2. 最小化中の画面遷移（読み込み直し）・kintone のイベント・URL の変化・タイマー・可視性の変化: 0 回 ---');
await safe('§2', async () => {
  // 一覧の画面だけで動くスクリプトなので、画面遷移はページの読み込み直し（同じ localStorage で新しいページ）。2 回繰り返す
  let total = [];
  const pages = [];
  for (let k = 0; k < 2; k++) {
    const e = makeEnv({ storage: shared });
    await e.start(); await e.settle();
    pages.push(e);
    // kintone のイベント・URL の変化・可視性・フォーカスの知らせ（登録された処理があれば全部呼ぶ）
    for (const r of e.registered.kintone) { try { await r.fn({ type: r.type }); } catch (x) { } }
    for (const r of [...e.registered.window, ...e.registered.document]) { if (/popstate|hashchange|visibilitychange|focus|pageshow/.test(r.type)) { try { await r.fn({ type: r.type }); } catch (x) { } } }
    // タイマー（setInterval で登録された処理を数回動かす・空いた時点の予約を実行する）
    for (let t = 0; t < 3; t++) { for (const fn of e.intervals.slice()) { try { fn(); } catch (x) { } } await e.settle(); }
    total = total.concat(e.fk.settingsCalls());
  }
  const all = pages.flatMap(p => p.fk.calls);
  TABLE.push({ c: '2', label: '最小化中に画面遷移 ×2（イベント・タイマー・可視性の知らせも）', s: total, o: all.filter(c => !pages[0].fk.isSettings(c)), fk: pages[0].fk });
  assert(total.length === 0, `2-1 最小化中の画面遷移（2 回）・イベント・タイマー・可視性の変化で設定取得 0 回: ${total.length} 回（${fmt(pages[0].fk.byPath(total))}）`);
  const evTypes = pages.flatMap(p => [...p.registered.window, ...p.registered.document].map(r => r.type));
  assert(!evTypes.some(t => /popstate|hashchange|visibilitychange|focus/.test(t)) && pages.every(p => p.registered.kintone.length === 0), `2-2 画面遷移・可視性の変化を拾う登録は無い（拾っても取得しない）: ${evTypes.join(',') || 'なし'}`);
  assert(pages.every(p => p.isMini()), '2-3 読み込み直しても最小化の状態は保存どおり');
});

// =========================================================
console.log('\n--- §3. 初回の展開: 表示のタブ（Health）に要る設定だけ ---');
const E = makeEnv({ storage: makeStorage({ [MINI_KEY]: '1' }) });
let ROOT = null;
await safe('§3', async () => {
  ROOT = await E.start(); await E.settle();
  const m0 = E.mark();
  await E.click('kt-mini');   // 展開
  await ticks();
  const before = E.fk.settingsCalls(m0);
  assert(sameMap(E.fk.byPath(before), STAGE1), `3-1 展開した直後は段階 1（REST 14 件・JS API 2 件）だけ: ${fmt(E.fk.byPath(before))}`);
  await E.settle();
  const s = E.fk.settingsCalls(m0), o = E.fk.otherCalls(m0);
  TABLE.push({ c: '3', label: '初回の展開（Health。idle の自動解析まで）', s, o, fk: E.fk });
  assert(sameMap(E.fk.byPath(s), { ...STAGE1, ...SCAN }), `3-2 空いた時点の JS の自動解析（preview の customize 1・本文 3）まで含めて、取ったのは要る path だけ: ${fmt(E.fk.byPath(s))}`);
  const NOT_NEEDED = [/^GET \/k\/v1\/app$/, /^GET \/k\/v1\/app\/form\/fields$/, /^GET \/k\/v1\/apps$/, /preview\/app\/plugins/, /getPermissions/, /^GET \/k\/v1\/preview\/app\/(views|status|form)/];
  const extra = Object.keys(E.fk.byPath(s)).filter(k => NOT_NEEDED.some(re => re.test(k)));
  assert(extra.length === 0 && (E.fk.byPath(s)['GET /k/v1/app/customize'] || 0) === 1, `3-3 要らない path（他アプリの定義・アプリ名・Plugins・作業の基準・運用環境の customize の重ね取り）が無い: ${extra.join(', ') || 'なし'}`);
  assert(!E.isMini() && E.store.getItem(MINI_KEY) === '0', '3-4 展開は今までどおり保存する（0）');
  assert(o.length === 1 && o[0].path === '/k/v1/records', `3-5 設定取得ではない通信（Health のレコード）は止めない: ${fmt(E.fk.byPath(o))}`);
});

// =========================================================
console.log('\n--- §4. 再展開: 有効な取得済みがあれば追加 0 回。タブの初回だけ取る。設定の変更の後は要る分だけ取り直す ---');
await safe('§4', async () => {
  let m = E.mark();
  for (let k = 0; k < 3; k++) { await E.click('kt-mini'); await E.settle(); await E.click('kt-mini'); await E.settle(); }
  const s4 = E.fk.settingsCalls(m);
  TABLE.push({ c: '4', label: '最小化 → 再展開 ×3（Health）', s: s4, o: E.fk.otherCalls(m), fk: E.fk });
  assert(s4.length === 0 && !E.isMini(), `4-1 最小化と展開を 3 回繰り返しても追加の設定取得 0 回: ${fmt(E.fk.byPath(s4))}`);
  // タブごとの初回（そのタブを開いたときに要るものだけ）
  const tabStep = async (tab, expect, label) => {
    const m1 = E.mark();
    await E.click(`tab-${tab}`); await E.settle();
    const got = E.fk.settingsCalls(m1);
    assert(sameMap(E.fk.byPath(got), expect), `${label}: ${fmt(E.fk.byPath(got))}`);
    TABLE.push({ c: '4', label: `${tab} タブを初めて開く`, s: got, o: E.fk.otherCalls(m1), fk: E.fk });
    const m2 = E.mark();
    await E.click('kt-mini'); await E.settle(); await E.click('kt-mini'); await E.settle();
    const again = E.fk.settingsCalls(m2);
    assert(again.length === 0, `${label}（最小化 → 再展開は 0 回）: ${fmt(E.fk.byPath(again))}`);
  };
  await tabStep('customize', { 'GET /k/v1/preview/app/customize': 1, 'GET /k/v1/app/customize': 1 }, '4-2 Customize を開いたら一覧の 2 件だけ（運用環境の customize は 1 回にまとめた）');
  await tabStep('plugins', { 'JS API kintone.system.getPermissions': 1, 'GET /k/v1/app/plugins': 1, 'GET /k/v1/preview/app/plugins': 1 }, '4-3 Plugins を開いたら 3 件だけ');
  await tabStep('fields', { 'GET /k/v1/apps': 1 }, '4-4 Fields を開いたらアプリ名の 1 件だけ（解析は取得済み）');
  m = E.mark();
  for (const tab of ['health', 'customize', 'plugins', 'fields', 'relations', 'deps', 'field-scanner']) { await E.click(`tab-${tab}`); await E.settle(); }
  const s4b = E.fk.settingsCalls(m);
  assert(s4b.length === 0, `4-6 一度開いたタブを開き直しても 0 回: ${fmt(E.fk.byPath(s4b))}`);

  // Toolkit 自身の設定の変更（Plugins の deploy の成功。運用環境が変わる）
  await E.click('tab-plugins'); await E.settle();
  m = E.mark();
  const dataNow = FX.makeData();
  E.fk.kintone.api = (orig => { const f = async (url, method, params) => { const r = await orig(url, method, params); if (/\/k\/v1\/app\/plugins/.test(url) && method === 'GET' && !/preview/.test(url)) return { plugins: [{ id: 'plg-new', name: 'New', enabled: true }], revision: '6' }; return r; }; f.url = orig.url; return f; })(E.fk.kintone.api);
  await E.click('kt-plg-deploy'); await E.settle();
  const deployCalls = E.fk.calls.slice(m).map(c => `${c.method} ${c.path}`);
  assert(deployCalls.includes('POST /k/v1/preview/app/deploy') && deployCalls.filter(x => x === 'GET /k/v1/app/plugins').length === 1, `4-7 deploy（利用者の操作）は最後まで動く（deploy → 完了待ち → 一覧の取り直し）: ${deployCalls.join(', ')}`);
  m = E.mark();
  await E.click('kt-mini'); await E.settle(); await E.click('kt-mini'); await E.settle();
  const s4c = E.fk.settingsCalls(m);
  assert(s4c.length === 0, `4-8 設定を変えた後も、運用環境の写しを使わない Plugins タブで展開しただけなら取らない: ${fmt(E.fk.byPath(s4c))}`);
  m = E.mark();
  await E.click('tab-health'); await E.settle();
  const s4d = E.fk.settingsCalls(m);
  TABLE.push({ c: '4', label: '設定の変更（Plugins の deploy）の後に Health を開く', s: s4d, o: E.fk.otherCalls(m), fk: E.fk });
  assert(sameMap(E.fk.byPath(s4d), { ...STAGE1, 'GET /k/v1/preview/app/customize': 1 }), `4-9 古い写しは使わず、要るとき（解析タブを開いた）に段階 1 を取り直す（解析は署名を確かめる 1 件。本文はキャッシュ）: ${fmt(E.fk.byPath(s4d))}`);
  const currentData = E.currentData();
  assert(currentData?.appPlugins?.plugins.length === 1 && currentData.appPlugins.plugins[0].id === 'plg-new', '4-10 取り直した後は新しい設定（deploy 後のアプリのプラグイン）を使う（古い情報を最新として出さない）');
  m = E.mark();
  await E.click('kt-mini'); await E.settle(); await E.click('kt-mini'); await E.settle(); await E.click('tab-health'); await E.settle();
  assert(E.fk.settingsCalls(m).length === 0, '4-12 取り直した後は、また再利用する（0 回）');
  // Customize の一覧（4-2 で取得済み）: deploy は動作テスト環境の全部を運用環境へ反映するので、運用環境との差・「動作テスト環境のみ」の印も古い。次に開いたときに取り直す
  m = E.mark();
  await E.click('tab-customize'); await E.settle();
  const s4f = E.fk.settingsCalls(m);
  TABLE.push({ c: '4', label: '設定の変更（Plugins の deploy）の後に Customize を開く', s: s4f, o: E.fk.otherCalls(m), fk: E.fk });
  assert(sameMap(E.fk.byPath(s4f), { 'GET /k/v1/preview/app/customize': 1, 'GET /k/v1/app/customize': 1 }), `4-13 Plugins の deploy の後に Customize を開くと、一覧（運用環境との差・「動作テスト環境のみ」の印）を取り直す: ${fmt(E.fk.byPath(s4f))}`);
  m = E.mark();
  await E.click('kt-mini'); await E.settle(); await E.click('kt-mini'); await E.settle();
  assert(E.fk.settingsCalls(m).length === 0, `4-14 取り直した一覧は再利用する（最小化 → 再展開で 0 回）: ${fmt(E.fk.byPath(E.fk.settingsCalls(m)))}`);
  void dataNow;
});

// =========================================================
console.log('\n--- §5. 取得の途中で最小化: 送った通信の完了の後に新しい後続の取得 0 回。再展開で足りない分だけ ---');
await safe('§5a', async () => {
  // 展開で開いたページ（保存は 0）。段階 1 の 1 件を止めておき、送った後に最小化する
  const e = makeEnv({ mini: '0' });
  const h = e.fk.hold(/\/k\/v1\/app\/views$/);
  const p = e.start();
  await ticks();
  const sent = e.fk.settingsCalls().length;
  await e.click('kt-mini');                 // 取得の途中で最小化
  const m = e.mark();
  h.release(); await p; await e.settle();
  for (const fn of e.intervals.slice()) { try { fn(); } catch (x) { } }
  await e.settle();
  const after = e.fk.settingsCalls(m), afterOther = e.fk.otherCalls(m);
  TABLE.push({ c: '5', label: '段階 1 の途中で最小化 → 送った分の完了の後', s: after, o: afterOther, fk: e.fk });
  assert(sent === 16, `5a-1 最小化の前に送ったのは段階 1 の 16 件: ${sent}`);
  assert(after.length === 0, `5a-2 送った通信の完了の後、新しい後続の設定取得 0 回（他アプリの定義・Customize・Plugins・アプリ名・JS の解析）: ${fmt(e.fk.byPath(after))}`);
  assert(afterOther.length === 0, `5a-3 描画も展開まで始めない（Health のレコードも 0）: ${fmt(e.fk.byPath(afterOther))}`);
  const m2 = e.mark();
  await e.click('kt-mini'); await e.settle();
  const re = e.fk.settingsCalls(m2);
  TABLE.push({ c: '5', label: '↑の後に再展開（足りない分だけ）', s: re, o: e.fk.otherCalls(m2), fk: e.fk });
  assert(sameMap(e.fk.byPath(re), SCAN), `5a-4 再展開では段階 1 を取り直さず、足りない分（JS の自動解析）だけ: ${fmt(e.fk.byPath(re))}`);
});
await safe('§5b', async () => {
  // JS の自動解析: preview の customize を送った後に最小化 → 本文は取らない → 展開で本文だけ
  const e = makeEnv({ mini: '0' });
  const h = e.fk.hold(/\/k\/v1\/preview\/app\/customize$/);
  await e.start(); await ticks();
  for (const fn of e.idle.splice(0)) fn();
  await ticks();
  const m = e.mark();
  await e.click('kt-mini');
  h.release(); await e.settle();
  const after = e.fk.settingsCalls(m);
  TABLE.push({ c: '5', label: 'JS の自動解析の途中で最小化 → 完了の後', s: after, o: e.fk.otherCalls(m), fk: e.fk });
  assert(after.length === 0, `5b-1 解析の設定を取った後、本文の取得（後続）は始めない: ${fmt(e.fk.byPath(after))}`);
  assert(e.T.KTScan.getStatus().state === 'idle', `5b-2 解析は失敗にもキャッシュにもせず、解析前の状態に戻す: ${e.T.KTScan.getStatus().state}`);
  const m2 = e.mark();
  await e.click('kt-mini'); await e.settle();
  const re = e.fk.settingsCalls(m2);
  TABLE.push({ c: '5', label: '↑の後に再展開', s: re, o: e.fk.otherCalls(m2), fk: e.fk });
  assert(sameMap(e.fk.byPath(re), { 'fetch /k/v1/file': 3 }), `5b-3 再展開で続きの本文 3 件だけ（取れた設定は取り直さない）: ${fmt(e.fk.byPath(re))}`);
  assert(['done', 'cached'].includes(e.T.KTScan.getStatus().state), '5b-4 続きの解析が終わる');
});
await safe('§5c', async () => {
  // Customize の一覧: preview を送った後に最小化 → 運用環境の customize は取らない → 再展開で運用環境だけ
  const e = makeEnv({ mini: '0' });
  await e.start(); await e.settle();
  const h = e.fk.hold(/\/k\/v1\/preview\/app\/customize$/);
  await e.click('tab-customize'); await ticks();
  const m = e.mark();
  await e.click('kt-mini');
  h.release(); await e.settle();
  const after = e.fk.settingsCalls(m);
  assert(after.length === 0, `5c-1 一覧の途中で最小化: 運用環境の customize（後続）は取らない: ${fmt(e.fk.byPath(after))}`);
  const m2 = e.mark();
  await e.click('kt-mini'); await e.settle();
  const re = e.fk.settingsCalls(m2);
  TABLE.push({ c: '5', label: 'Customize の一覧の途中で最小化 → 再展開', s: re, o: e.fk.otherCalls(m2), fk: e.fk });
  assert(sameMap(e.fk.byPath(re), { 'GET /k/v1/app/customize': 1 }), `5c-2 再展開で足りない運用環境の 1 件だけ: ${fmt(e.fk.byPath(re))}`);
});
await safe('§5d', async () => {
  // Plugins: 1 件目を送った後に最小化 → 2 件目は取らない → 再展開で 2 件目だけ
  const e = makeEnv({ mini: '0' });
  await e.start(); await e.settle();
  const h = e.fk.hold(/^\/k\/v1\/app\/plugins$/);
  await e.click('tab-plugins'); await ticks();
  const m = e.mark();
  await e.click('kt-mini');
  h.release(); await e.settle();
  const after = e.fk.settingsCalls(m);
  assert(after.length === 0, `5d-1 Plugins の途中で最小化: 2 件目（preview）は取らない: ${fmt(e.fk.byPath(after))}`);
  const m2 = e.mark();
  await e.click('kt-mini'); await e.settle();
  const re = e.fk.settingsCalls(m2);
  TABLE.push({ c: '5', label: 'Plugins の途中で最小化 → 再展開', s: re, o: e.fk.otherCalls(m2), fk: e.fk });
  assert(sameMap(e.fk.byPath(re), { 'GET /k/v1/preview/app/plugins': 1 }), `5d-2 再展開で 2 件目だけ: ${fmt(e.fk.byPath(re))}`);
});
await safe('§5e', async () => {
  // アプリ名: 100 件ずつの問い合わせの間で止める
  const e = makeEnv({ mini: '0' });
  const ids = Array.from({ length: 150 }, (_, i) => String(1000 + i));
  let n = 0;
  const live = () => n === 0;
  const orig = e.fk.kintone.api;
  e.fk.kintone.api = Object.assign(async (url, method, params) => { if (/apps/.test(url)) n += 1; return orig(url, method, params); }, { url: orig.url });
  const map = await e.T.KTApi.getAppNames(ids, { shouldContinue: live });
  assert(n === 1 && map.size === 100 && Array.isArray(map.pending) && map.pending.length === 50, `5e-1 アプリ名の 2 回目の問い合わせ（後続）は始めず、残りは pending に: 問い合わせ ${n} 回・解決 ${map.size}・残り ${map.pending ? map.pending.length : '-'}`);
});
await safe('§5j', async () => {
  // Field Scanner のフィールド定義の取り直し（fetchFieldList: kintone.app.getFormFields → getFormLayout の順の取得）。
  //   段階 1 でフィールド定義・レイアウトが空だった（取り直しが要る）場面を作る
  const data = FX.makeData();
  const fullFields = data.fields;
  data.fields = {};
  const lay = [];
  const e = makeEnv({ mini: '0', data, layout: lay });
  await e.start(); await ticks();                    // 段階 1（空のフィールド定義・レイアウト）→ 描画。自動の解析は空いた時点に予約
  data.fields = fullFields; lay.push({ type: 'ROW', fields: [{ type: 'SINGLE_LINE_TEXT', code: 'case_name' }] });   // 取り直したときは中身がある
  const h = e.fk.hold(/^kintone\.app\.getFormFields$/);
  for (const fn of e.idle.splice(0)) fn();
  await ticks();
  const sentFields = h.sent;
  const m = e.mark();
  await e.click('kt-mini');                          // フィールド定義の取り直しの途中で最小化
  h.release(); await e.settle();
  const after = e.fk.settingsCalls(m);
  TABLE.push({ c: '5', label: 'Field Scanner: フィールド定義の取り直しの途中で最小化 → 完了の後', s: after, o: e.fk.otherCalls(m), fk: e.fk });
  assert(sentFields === 1 && after.length === 0, `5j-1 送ったフィールド定義の完了の後、レイアウトの取り直し・本文の取得（後続）は 0 回: 送った ${sentFields}・後続 ${fmt(e.fk.byPath(after))}`);
  assert(e.T.KTScan.getStatus().state === 'idle', `5j-2 解析は失敗にもキャッシュにもせず、解析前の状態に戻す: ${e.T.KTScan.getStatus().state}`);
  const m2 = e.mark();
  await e.click('kt-mini'); await e.settle();
  const re = e.fk.settingsCalls(m2);
  TABLE.push({ c: '5', label: '↑の後に再展開（足りない分だけ）', s: re, o: e.fk.otherCalls(m2), fk: e.fk });
  assert(sameMap(e.fk.byPath(re), { 'JS API kintone.app.getFormLayout': 1, 'fetch /k/v1/file': 3 }), `5j-3 再展開ではフィールド定義・カスタマイズ設定を取り直さず、足りない分（レイアウト 1・本文 3）だけ: ${fmt(e.fk.byPath(re))}`);
  assert(['done', 'cached'].includes(e.T.KTScan.getStatus().state), '5j-4 続きの解析が終わる');
});

// =========================================================
console.log('\n--- §6. 利用者の明示の操作は最小化の前後に関係なく動く ---');
await safe('§6', async () => {
  const e = makeEnv({ mini: '0' });
  await e.start(); await e.settle();
  await e.click('tab-customize'); await e.settle();
  await e.click('tab-plugins'); await e.settle();
  await e.click('kt-mini'); await e.settle();   // 最小化
  let m = e.mark();
  await e.byId.get('kt-customize-refresh').onclick(); await e.settle();
  assert(sameMap(e.fk.byPath(e.fk.settingsCalls(m)), { 'GET /k/v1/preview/app/customize': 1, 'GET /k/v1/app/customize': 1 }), `6-1 Customize の［↻ 一覧更新］は最小化中でも取る: ${fmt(e.fk.byPath(e.fk.settingsCalls(m)))}`);
  m = e.mark();
  await e.click('kt-plg-reload'); await e.settle();
  assert(sameMap(e.fk.byPath(e.fk.settingsCalls(m)), { 'GET /k/v1/app/plugins': 1, 'GET /k/v1/preview/app/plugins': 1 }), `6-2 Plugins の［↻ 再取得］は最小化中でも取る: ${fmt(e.fk.byPath(e.fk.settingsCalls(m)))}`);
  m = e.mark();
  await e.byId.get('fs-scan').onclick(); await e.settle();
  assert(sameMap(e.fk.byPath(e.fk.settingsCalls(m)), SCAN), `6-3 Field Scanner の［Scan］は最小化中でも取る（キャッシュを使わない）: ${fmt(e.fk.byPath(e.fk.settingsCalls(m)))}`);
  assert(e.isMini(), '6-4 明示の操作の間も最小化のまま');
});

// =========================================================
console.log('\n--- §7. 最小化の保存・復元は今のまま ---');
await safe('§7', async () => {
  const e = makeEnv({});
  await e.start(); await e.settle();
  assert(!e.isMini() && e.store.getItem(MINI_KEY) === null && !e.store.writes.some(([k]) => k === MINI_KEY), '7-1 保存が無ければ展開で始まり、起動では保存しない（既定 = 展開）');
  await e.click('kt-mini');
  assert(e.isMini() && e.store.getItem(MINI_KEY) === '1', '7-2 最小化すると kt_mini_<host>_global に 1 を保存');
  await e.click('kt-mini');
  assert(!e.isMini() && e.store.getItem(MINI_KEY) === '0', '7-3 展開すると 0 を保存');
  const e2 = makeEnv({ mini: '0' });
  await e2.start(); await e2.settle();
  assert(!e2.isMini(), '7-4 0 が保存されていれば展開で始まる');
  if (e.T.KTFetchGate) {
    const gate = e.T.KTFetchGate.create({ open: true });
    const t = gate.ticket();
    gate.setOpen(false); gate.setOpen(true);
    assert(t.live() === false && gate.ticket().live() === true, '7-5 関所の手形: 発行の後に一度でも最小化したら無効（展開し直しても続きは新しい手形で）');
    assert(e.T.KTFetchGate.of({}).isOpen() === true, '7-6 パネルの無い root は常に展開として扱う（今までどおり取る）');
  } else assert(false, '7-5 設定取得の関所（KTFetchGate）がある');
});

// =========================================================
console.log('\n--- 各ケースの API 呼び出し回数（設定取得の API。path ごと） ---');
console.log('| ケース | 場面 | 設定取得 | 内訳（path ごと） | 設定取得ではない通信 |');
console.log('|---|---|---:|---|---|');
for (const r of TABLE) console.log(`| ${r.c} | ${r.label} | ${r.s.length} | ${fmt(r.fk.byPath(r.s))} | ${fmt(r.fk.byPath(r.o || []))} |`);

assert(unexpected.length === 0, `想定外の非同期の失敗が無い${unexpected.length ? `: ${unexpected.join(' / ')}` : ''}`);
console.log(`\n${state.passed} passed, ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
