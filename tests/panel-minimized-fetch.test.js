// パネルの表示状態に合わせた設定取得（設定取得の関所 KTFetchGate）の回帰（2026-10-10 利用者の指示）。
//   目的: Toolkit を最小化して使っている間は、設定取得のための API 通信を発生させない。
//   偽の kintone（tests/helpers/fake-kintone-api.js）で、設定取得の API（レコードと書き込みを除く REST の GET・JS API・本文の取得）を path ごとに数える。
//     1. 最小化の状態（保存された状態）で初期表示 → 設定取得 0 回
//     2. 最小化中の画面遷移（読み込み直し・kintone のイベント・URL の変化）・タイマー・可視性の変化 → 0 回
//     3. 初回の展開 → 表示のタブ（Health）に要る設定だけ（取った path の一覧。要らない path が無いこと）
//     4. 最小化 → 再展開 → 追加 0 回（有効な取得済み）。タブごとの初回だけ取る。Toolkit 自身の設定の変更の後は、要るときに要る分だけ取り直す
//     5. 取得の途中で最小化 → 送った通信の完了の後に新しい後続の取得 0 回。再展開で足りない分だけ
//   あわせて: 利用者の明示の操作（［一覧更新］・［再取得］・［Scan］・開発支援の［再取得］）は最小化の前後に関係なく動く／
//   設定取得ではない通信（AI の Gateway の health）は止めない／最小化の保存・復元は今のまま
//   2026-10-10 の独立の確認で見つかった漏れ・止めすぎ・古い印（追加）:
//     §5i〜§5j 段の中の順の取得（承認の欄の準備の相手アプリの定義（JavaScript の準備は 2026-10-23 から取得しない）・Field Scanner のフィールド定義の取り直し）も、途中で最小化したら後続 0 回。再展開で足りない分だけ
//     §8 ［動作テスト環境へ反映］の中の照合の取り直し（利用者の明示の操作）は、最小化中でも止めずに正しい変わった点を出す
//     §9 最小化で開いたページでも、AI の接続の確認（トークンの交換・/v2/health）は起動時に 1 回ずつ行う（設定取得は 0 回のまま）
//     4-13 Plugins の deploy（運用環境が変わる）の後に Customize を開くと、一覧（運用環境との差・「動作テスト環境のみ」の印）を取り直す
//   2026-10-10 の判断点の戻し（利用者の依頼「設定が変更された場合は古い情報を最新として扱わず、次に必要になった時点で再取得する」
//   「取得中に最小化した場合、新たな取得処理や後続リクエストを開始しない」）:
//     §10 登録・戻すの後の作業の基準の取り直しは、見えている間はすぐ取り、最小化中は取らずに古い印を付け、展開したら取り直す（登録・戻すの操作そのものは止めない）
//   2026-10-10 の確認の残り 2 件:
//     §11 登録・戻すの後の JavaScript の解析し直し（開発支援の rescanJs → 本物の KTScan）も、最小化中は取らずに古い印を付け、解析の結果を使う表示が見えたら 1 回だけ
//         （見えている間はすぐ。利用者の［Scan］は止めない。印より前に始めた解析の完了で印を外さない。途中で最小化したら後続を始めない）
//     §12 最小化中の自分の登録の後に別の変更（JavaScript を戻す・設定を戻す・ほかの場所の invalidateDevBase）があったら、展開の取り直しで見えているときと同じく
//         承認の取り消しを判定する。見送るときは世代を進める（書き込みの前に始めた取得の完了で古い印を外さない）
//
// 実行方法: node tests/panel-minimized-fetch.test.js
//   修正前の版で同じ確かめ方をするとき（RED の確認）: KT_SRC=<修正前の kintoneAppToolkit.user.js> node tests/panel-minimized-fetch.test.js
//   （修正前の版には入口の関数が無いので、入口（waitReady().then(async () => {...})）を __ktMain として取り出した写しを一時ディレクトリに作って読む）
'use strict';
// 偽の DOM では Fields の表の描画（renderFields の行の追加）が途中で失敗する（querySelector が #id だけ）。描画の失敗はこの試験の対象ではないので無視する。
//   それ以外の非同期の失敗は数えて、最後に 0 件であることを確かめる
const KNOWN_REJECTIONS = [/kintone is not defined/, /renderFields|renderRows/];
const unexpected = [];
process.on('unhandledRejection', (e) => { const s = String((e && (e.stack || e.message)) || e); if (KNOWN_REJECTIONS.some(re => re.test(s))) return; unexpected.push(s.slice(0, 300)); });
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- 修正前の版（入口の関数が無い）なら、入口を取り出した写しを読む ----
const SRC_PATH = process.env.KT_SRC || path.join(__dirname, '..', 'kintoneAppToolkit.user.js');
const SRC_TEXT = fs.readFileSync(SRC_PATH, 'utf8');
const HAS_START = /function startToolkit\(/.test(SRC_TEXT);
if (!HAS_START) {
  const OPEN = 'waitReady().then(async () => {';
  const i = SRC_TEXT.lastIndexOf(OPEN);
  if (i < 0) throw new Error('修正前の版の入口が見つかりません');
  let code = SRC_TEXT.slice(0, i) + 'const __ktMain = (async () => {' + SRC_TEXT.slice(i + OPEN.length);
  const lastClose = code.lastIndexOf('})();');
  code = code.slice(0, lastClose) + '  globalThis.__ktMain = __ktMain;\n' + code.slice(lastClose);
  const copy = path.join(os.tmpdir(), `kt-panel-minimized-old-${process.pid}.user.js`);
  fs.writeFileSync(copy, code);
  process.env.KT_SRC = copy;
  process.on('exit', () => { try { fs.unlinkSync(copy); } catch (e) { } });
}

const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
//   簡素化（2026-10-17）: 反映できるかは、最新の版なら会話の今の判定、前の版なら最終案の記録で確かめる（tests/helpers/final-state.js）
const FS = require('./helpers/final-state.js');
const { makeFakeDocument, makeFakeHost } = require('./helpers/fake-dom.js');
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
  const editor = { value: '', setValue(v) { this.value = v; }, getValue() { return this.value; }, getModel() { return {}; }, focus() { }, getSelection() { return null; } };
  return { editor: { create: () => editor, setModelLanguage: () => { } }, languages: { registerCompletionItemProvider: () => { }, CompletionItemKind: { Field: 1, Snippet: 2 } }, Range: function () { } };
})();

/** 1 回のページ（sandbox）。storage を渡すと、同じ localStorage で読み込み直す（画面遷移） */
function makeEnv({ mini = null, storage = null, data = null, admin = true, layout = null, gateway = null } = {}) {
  const { doc, byId } = makeFakeDocument();
  const store = storage || makeStorage(mini == null ? {} : { [MINI_KEY]: mini });
  const T = loadToolkit({ document: doc, localStorage: store });
  const g = T.__sandbox;
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
  const start = () => (typeof T.startToolkit === 'function' ? T.startToolkit() : g.__ktMain());
  /** 待ち（ブラウザが空いた時点の予約も実行する） */
  const settle = async () => { await ticks(); for (let r = 0; r < 6 && idle.length; r++) { for (const fn of idle.splice(0)) { try { fn(); } catch (e) { } } await ticks(); } };
  const click = (id) => { const el = byId.get(id); if (!el) throw new Error(`要素がありません: #${id}`); return el.dispatch('click', { currentTarget: el }); };
  const wrap = () => doc.body.children.find(el => el && el.id === 'kt-toolkit') || null;
  const isMini = () => { const w = wrap(); return !!(w && w.classList.contains('is-mini')); };
  return { T, g, doc, byId, fk, store, registered, idle, intervals, start, settle, click, wrap, isMini, mark: () => fk.calls.length };
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
// 開発支援の画面の偽の動作テスト環境（tests/helpers/kintone-preview-mock.js）の呼び出しは 'GET fields' のような文字列。表で同じ形に数える
const KITFK = { byPath: (list) => { const m = {}; for (const c of list) m[`mock ${c}`] = (m[`mock ${c}`] || 0) + 1; return m; } };
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

(async () => {
console.log(`\n対象: ${SRC_PATH}${HAS_START ? '' : '（修正前の版。入口を取り出した写しで実行）'}`);

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
  await tabStep('ai', { 'GET /k/v1/app': 2, 'GET /k/v1/app/form/fields': 2 }, '4-5 開発支援を開いたら他アプリの定義（2 件 × 2 アプリ）だけ（未接続なので作業の基準は無い）');
  m = E.mark();
  for (const tab of ['health', 'customize', 'plugins', 'fields', 'relations', 'deps', 'field-scanner', 'ai']) { await E.click(`tab-${tab}`); await E.settle(); }
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
  const inputs = ROOT && ROOT.ktAi && typeof ROOT.ktAi.inputs === 'function' ? ROOT.ktAi.inputs() : null;
  assert(inputs && inputs.data && inputs.data.appPlugins && inputs.data.appPlugins.plugins.length === 1 && inputs.data.appPlugins.plugins[0].id === 'plg-new', '4-10 取り直した後は新しい設定（deploy 後のアプリのプラグイン）を使う（古い情報を最新として出さない）');
  m = E.mark();
  await E.click('tab-ai'); await E.settle();
  const s4e = E.fk.settingsCalls(m);
  assert(sameMap(E.fk.byPath(s4e), { 'GET /k/v1/app': 2, 'GET /k/v1/app/form/fields': 2 }), `4-11 他アプリの定義も古いとし、開発支援を開いたときに取り直す: ${fmt(E.fk.byPath(s4e))}`);
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
// 開発支援の作業の基準（接続済み。本物の KTDevBase.load を偽の kintone で動かす）
const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'], conversation: ['requirements', 'brief', 'stream', 'proposal', 'suggestion', 'adoptQuote', 'itemIds'] }, 'change-planner': { implemented: true, promptVersions: ['1'], revisionModes: ['full', 'patch'], stream: ['reply'], requirementOps: ['decisionRefs'] }, 'customization-generator': { implemented: true, promptVersions: ['1'], stream: ['progress'] } } }, usage: { monthlyLimit: 20, usedThisMonth: 1 } };
function mountAi(T, fk, { visible }) {
  const storage = makeStorage();
  const settings = T.KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' });
  settings.setConsent(true);
  const health = { n: 0 };
  const client = { async getHealth() { health.n += 1; return HEALTH; } };
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const flow = { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false };
  const getImpl = (p, params) => fk.kintone.api(fk.kintone.api.url(p), 'GET', params);
  const download = (key) => fk.fetch('/k/v1/file.json?fileKey=' + key).then(r => r.text());
  let loads = 0;
  const data = FX.makeData();
  const clock = { t: 1000000 };
  const panel = T.mountAiWorkspace(makeFakeHost(), {
    getInputs: () => ({ data, deps: null, scan: null, incoming: null }), copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' },
    settings, session, hostname: 't.cybozu.com', connectFlow: flow, now: () => clock.t,
    canAutoFetch: () => visible.v,
    loadDevBase: ({ shouldContinue = null, resume = null } = {}) => { loads += 1; return T.KTDevBase.load({ appId: '310', getImpl, download, fetchRelated: (fields, actions) => T.fetchRelatedApps(fields, getImpl, actions), shouldContinue, resume }); },
  });
  return { panel, health, loads: () => loads, clock };
}
const DEVBASE_STAGE1 = 30, DEVBASE_RELATED = 4, DEVBASE_FILES = 6;
await safe('§5f', async () => {
  const e = makeEnv({ mini: '0' });
  const visible = { v: false };
  const ai = mountAi(e.T, e.fk, { visible });
  await e.settle();
  const s0 = e.fk.settingsCalls();
  TABLE.push({ c: '5', label: '開発支援: 接続済みでも見えていない間（最小化中・別のタブ）', s: s0, o: e.fk.otherCalls(), fk: e.fk });
  assert(s0.length === 0 && ai.loads() === 0, `5f-1 見えていない間は接続しても作業の基準を取らない: ${s0.length} 回・読み込み ${ai.loads()}`);
  assert(ai.health.n >= 1, `5f-2 設定取得ではない通信（Gateway の health）は止めない: ${ai.health.n} 回`);
  // 見えた → 段階 1 の途中で見えなくなる → 完了の後は後続（他アプリの定義・本文）を取らない
  const h = e.fk.hold(/\/k\/v1\/preview\/app\/views$/);
  visible.v = true; ai.panel.onVisible(); await ticks();
  const sent = e.fk.settingsCalls().length;
  visible.v = false;
  const m = e.mark();
  h.release(); await e.settle();
  const after = e.fk.settingsCalls(m);
  TABLE.push({ c: '5', label: '開発支援: 作業の基準の段階 1 の途中で最小化 → 完了の後', s: after, o: e.fk.otherCalls(m), fk: e.fk });
  assert(sent === DEVBASE_STAGE1, `5f-3 見えなくなる前に送ったのは作業の基準の段階 1（30 件）: ${sent}`);
  assert(after.length === 0, `5f-4 完了の後、後続（他アプリの定義・本文のダウンロード）は 0 回: ${fmt(e.fk.byPath(after))}`);
  assert(ai.panel.devBase() === null && ai.panel.devBaseFetchState().partial === true, '5f-5 途中で止めた取得は基準にしない（前の基準のまま）。取れた段は続きのために残す');
  const m2 = e.mark();
  visible.v = true; ai.panel.onVisible(); await e.settle();
  const re = e.fk.settingsCalls(m2);
  TABLE.push({ c: '5', label: '開発支援: ↑の後に再び見えた（足りない段だけ）', s: re, o: e.fk.otherCalls(m2), fk: e.fk });
  assert(re.length === DEVBASE_RELATED + DEVBASE_FILES && !re.some(c => /preview\/app\/views/.test(c.path)), `5f-6 再び見えたら足りない段（他アプリ 4・本文 6）だけ。段階 1 は取り直さない: ${fmt(e.fk.byPath(re))}`);
  assert(ai.panel.devBase() && ai.panel.devBase().ok === true, '5f-7 続きから取った基準を使う');
  const m3 = e.mark();
  visible.v = false; visible.v = true; ai.panel.onVisible(); await e.settle();
  assert(e.fk.settingsCalls(m3).length === 0, '5f-8 1 分以内に再び見えても取り直さない（有効な取得済み）');
  // Toolkit のほかの場所で設定を変えた → 古い印。見えていない間は取らず、見えたときに 1 回
  ai.panel.invalidateDevBase();
  visible.v = false;
  const m4 = e.mark();
  ai.panel.refreshDevBase({ maxAgeMs: 60 * 1000, reason: 'tab' }); await e.settle();
  assert(e.fk.settingsCalls(m4).length === 0, '5f-9 設定の変更の後も、見えていない間は取り直さない');
  visible.v = true; ai.panel.onVisible(); await e.settle();
  const re2 = e.fk.settingsCalls(m4);
  TABLE.push({ c: '4', label: '開発支援: 設定の変更の後に見えた（1 分以内でも取り直す）', s: re2, o: e.fk.otherCalls(m4), fk: e.fk });
  assert(re2.length === DEVBASE_STAGE1 + DEVBASE_RELATED + DEVBASE_FILES, `5f-10 古い印のある基準は 1 分以内でも使わず、見えたときに取り直す: ${re2.length} 回`);
  // 利用者の明示の［再取得］は見えていなくても動く
  visible.v = false;
  const m5 = e.mark();
  await ai.panel.refreshDevBase({ reason: 'manual' }); await e.settle();
  assert(e.fk.settingsCalls(m5).length === DEVBASE_STAGE1 + DEVBASE_RELATED + DEVBASE_FILES, `5f-11 利用者の［再取得］（manual）は最小化中でも最後まで取る: ${e.fk.settingsCalls(m5).length} 回`);
  // 自動の取得の途中に明示の処理が合流したら、見えなくなっても止めない
  ai.clock.t += 120 * 1000;
  const h2 = e.fk.hold(/\/k\/v1\/preview\/app\/views$/);
  visible.v = true; ai.panel.onVisible(); await ticks();
  const joined = ai.panel.refreshDevBase({ reason: 'plan' });
  visible.v = false;
  const m6 = e.mark();
  h2.release(); await joined; await e.settle();
  assert(e.fk.settingsCalls(m6).length === DEVBASE_RELATED + DEVBASE_FILES, `5f-12 明示の処理（計画）が合流した取得は、見えなくなっても最後まで取る: ${fmt(e.fk.byPath(e.fk.settingsCalls(m6)))}`);
});

// 承認の欄の準備（最終案ができると自動で始まる。作業の基準を取る。2026-10-23: 設定の準備・JavaScript の準備は、その基準の今の設定を受け取り、動作テスト環境の設定・カスタマイズ・本文を取らない）
await safe('§5g', async () => {
  const T = loadToolkit();
  const { createNewFlowKit } = require('./helpers/new-flow.js');
  const KIT = createNewFlowKit(T);
  const visible = { v: false };
  const gen = KIT.screenGenerate({});
  //   2026-10-23: 作業の基準の読み込みの間の GET を区別する（準備の中の GET が 0 件であることを確かめる）
  const loads = []; let mref = null;
  const loader = KIT.loadDevBaseFromMock(() => mref.mock);
  const m = KIT.mount({ health: KIT.HEALTH_V, planImpl: KIT.planImplOf(KIT.screenPlan('mixed')), generateImpl: gen.impl, extra: { canAutoFetch: () => visible.v, loadDevBase: async (a = {}) => { const from = mref.mock.calls.length; const b = await loader(a); loads.push({ reason: a.reason || null, from, to: mref.mock.calls.length }); return b; } } });
  mref = m;
  await ticks();
  for (const s of KIT.REQUESTS) { await m.panel.send(s); await ticks(10); }   // 依頼・計画・生成は利用者の操作（見えていなくても進む）
  await ticks(30);
  const v = m.conv().activePlan();
  const gets = () => m.mock.calls.filter(c => /^GET /.test(c)).length;
  const g0 = gets();
  await ticks(20);
  assert(v && v.final && FS.readyOf(v) && m.panel.finalPrecheck().status === 'idle' && m.panel.devBaseFetchState().precheckDeferred === true && gets() === g0, `5g-1 見えていない間は承認の欄の準備（自動の取得）を始めない: ${m.panel.finalPrecheck().status}・GET ${gets() - g0}`);
  // 見えた → 承認の欄の準備が終わる。2026-10-23: 設定の準備・JavaScript の準備は作業の基準の今の設定を受け取り、動作テスト環境の設定・カスタマイズ・本文を取らない
  //   （準備の中の GET は 0 件。作業の基準の取り直しがあれば、その読み込みの中だけ）。見えなくなっても準備の中に後続の取得は無い（前は運用環境の一覧の取得で止めていた）
  const g1 = m.mock.calls.length;
  visible.v = true; m.panel.onVisible();
  await KIT.waitUntil(() => ['ready', 'blocked'].includes(m.panel.finalPrecheck().status), 80);
  const inLoad = (i) => loads.some(l => i >= l.from && i < l.to);
  const outside = m.mock.calls.map((c, i) => ({ c, i })).slice(g1).filter(x => /^GET /.test(x.c) && !inLoad(x.i)).map(x => x.c);
  assert(m.panel.finalPrecheck().status === 'ready' && outside.length === 0, `5g-2 見えたら準備が終わる。準備の中で動作テスト環境の設定・カスタマイズ・本文を取らない（作業の基準の今の設定を使う）: ${m.panel.finalPrecheck().status}・準備の中の GET ${outside.join(', ') || '0 件'}・基準の読み込み ${loads.filter(l => l.from >= g1).map(l => l.reason).join(', ') || 'なし'}`);
});

// 承認の欄の準備の「段の中の順の取得」（2026-10-10 の独立の確認で見つかった漏れ）。
//   開発支援の画面（偽の動作テスト環境）で最終案まで進め（依頼・計画・生成は利用者の操作）、見えた → 準備の途中の 1 件を止めて見えなくする → 完了の後の後続の GET を数える
async function precheckEnv() {
  const T = loadToolkit();
  const { createNewFlowKit } = require('./helpers/new-flow.js');
  const KIT = createNewFlowKit(T);
  const visible = { v: false };
  const gen = KIT.screenGenerate({});
  const m = KIT.mount({ health: KIT.HEALTH_V, planImpl: KIT.planImplOf(KIT.screenPlan('mixed')), generateImpl: gen.impl, extra: { canAutoFetch: () => visible.v } });
  await ticks();
  for (const s of KIT.REQUESTS) { await m.panel.send(s); await ticks(10); }
  await ticks(30);
  /** 準備の途中で name の読み取りを 1 回止める（止めた 1 件は見えなくなった後に返す = 送った通信の完了） */
  const holdOnce = (name) => {
    let open; const held = new Promise((r) => { open = r; });
    const orig = m.mock.api[name];
    const h = { hit: false, release: () => open(), restore: () => { m.mock.api[name] = orig; } };
    m.mock.api[name] = async (...a) => { if (!h.hit && m.panel.finalPrecheck().status === 'running') { h.hit = true; await held; } return orig.apply(m.mock.api, a); };
    return h;
  };
  const gets = (from) => m.mock.calls.slice(from).filter(c => /^GET /.test(c));
  return { T, KIT, m, visible, holdOnce, gets };
}
await safe('§5i', async () => {
  // 設定の準備（KTPlanExecutor.prepare）の相手アプリの定義（fetchRelatedAppsForLookups: アプリごとに 基本情報 → フィールド定義 の順の取得）。
  //   画面の計画にはルックアップの手順が無いので、準備に渡す承認済みの出力だけを、ルックアップの手順のある出力（tests/ai-plan-executor-lookup.test.js の代表ユースケース）に差し替える
  //   （準備・関所・続きの記録は本物のまま）
  const { T, KIT, m, visible, holdOnce, gets } = await precheckEnv();
  const R = T.KTPlanReview, E = T.KTPlanExecutor;
  const sp = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], changeKind: null, assigneeType: null, addMappings: [], addPickerFields: [], ...o });
  const st = (id, actionType, targetKind, targetRef, s = {}, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: sp(s), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PREVIEW_SUPPORTED', supported: true, reason: 'x' }, ...extra });
  const pf = (temporaryId, label, suggestedCode, type) => ({ temporaryId, label, suggestedCode, type, typeValid: true, required: false, options: [], reason: '', evidenceIds: [], alternativeExistingFieldCode: null, codeConflict: false, labelDuplicate: false });
  const plan = { planVersion: '1', requestId: 'tk-p13', goal: 'g', assessment: { summary: '' }, relevantFields: [], proposedFields: [pf('NEW_FIELD_1', '顧客住所', 'customer_address', 'SINGLE_LINE_TEXT')], steps: [
    st('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'SINGLE_LINE_TEXT' }),
    st('P3', 'UPDATE_LOOKUP', 'LOOKUP', 'customer_lookup', { addMappings: [{ relatedField: 'address', field: 'NEW_FIELD_1' }] }, { dependsOn: ['P1'] }),
  ], alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED' };
  const data = FX.makeData();
  const rv = R.review({ plan, data, deps: T.KTDeps.buildDependencyData(data, T.KTDeps.normalizeFields(data.fields)), scan: null, incoming: null });
  const lookupOut = R.executorOutput(plan, rv, plan.steps.map(s => s.id));
  const origPrepare = E.prepare;
  E.prepare = (out, o) => origPrepare(lookupOut, o);
  try {
    const h = holdOnce('getApp');
    visible.v = true; m.panel.onVisible();
    await KIT.waitUntil(() => h.hit, 80);
    visible.v = false;
    const g1 = m.mock.calls.length;
    h.release(); await ticks(40);
    const after = gets(g1);
    TABLE.push({ c: '5', label: '承認の欄の準備: 相手アプリの定義の途中（基本情報を送った後）で最小化 → 完了の後', s: after, o: [], fk: KITFK });
    assert(h.hit && sameSet(after, ['GET app']) && m.panel.finalPrecheck().status === 'idle', `5i-1 送った基本情報の完了の後、後続（フィールド定義・JavaScript の準備）の取得は 0 回: ${after.join(', ') || 'なし'}・${m.panel.finalPrecheck().status}`);
    h.restore();
    const g2 = m.mock.calls.length;
    visible.v = true; m.panel.onVisible();
    await KIT.waitUntil(() => ['ready', 'blocked'].includes(m.panel.finalPrecheck().status), 80);
    const re = gets(g2);
    TABLE.push({ c: '5', label: '↑の後に再び見えた（足りない分だけ）', s: re, o: [], fk: KITFK });
    assert(['ready', 'blocked'].includes(m.panel.finalPrecheck().status) && sameSet(re, ['GET app', 'GET app fields']), `5i-2 再び見えたら相手アプリ（基本情報とフィールド定義）を取り直す。動作テスト環境の設定・カスタマイズは取らない（作業の基準の今の設定を使う。2026-10-23）: ${re.join(', ') || 'なし'}`);
    // 部品の単位: 明示の操作（shouldContinue なし）は止めない／自動（偽）は基本情報の後で止める
    const mock2 = { calls: [], api: { getApp: async (id) => { mock2.calls.push(`GET app ${id}`); return { appId: String(id), name: 'x', code: '' }; }, getAppFields: async (id) => { mock2.calls.push(`GET app fields ${id}`); return { properties: {}, revision: '1' }; } } };
    const reviews = [{ actionType: 'UPDATE_LOOKUP', diff: { target: { identity: { relatedApp: { app: '500' } } } } }, { actionType: 'UPDATE_LOOKUP', diff: { target: { identity: { relatedApp: { app: '311' } } } } }];
    let paused = false;
    try { await E.fetchRelatedAppsForLookups(mock2.api, { properties: {} }, reviews, null, { shouldContinue: () => false }); } catch (e) { paused = T.KTFetchGate.isPaused(e); }
    assert(paused && mock2.calls.length === 2 && mock2.calls.every(c => /^GET app \d+$/.test(c)), `5i-3 アプリごとの順の取得: 自動の取得で見えなくなっていたら、送った基本情報の後のフィールド定義を始めない: ${mock2.calls.join(', ')}`);
    mock2.calls.length = 0;
    const r = await E.fetchRelatedAppsForLookups(mock2.api, { properties: {} }, reviews, null);
    assert(mock2.calls.length === 4 && r['500'] && r['311'], `5i-4 明示の操作（shouldContinue なし）は最後まで取る: ${mock2.calls.join(', ')}`);
  } finally { E.prepare = origPrepare; }
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
console.log('\n--- §8. 利用者の明示の操作の中の取得は止めない: ［動作テスト環境へ反映］の照合の取り直し（最小化中でも正しい変わった点） ---');
await safe('§8', async () => {
  // 承認の欄の準備の後に動作テスト環境へフィールドが足された状態で［動作テスト環境へ反映］を押す。押した直後に最小化（開発支援が見えない）しても、
  //   照合の取り直し（computePrecheck）は利用者の操作の中の取得なので止めず、見えているときと同じ変わった点を出す
  const { createNewFlowKit } = require('./helpers/new-flow.js');
  const out = {};
  for (const hidden of [false, true]) {
    const T = loadToolkit();
    const KIT = createNewFlowKit(T);
    const visible = { v: true };
    const gen = KIT.screenGenerate({ field: 'approval_memo', targetFile: 'memoLock.js' });
    const m = KIT.mount({ health: KIT.HEALTH_V, planImpl: KIT.planImplOf(KIT.screenPlan('mixed')), generateImpl: gen.impl, extra: { canAutoFetch: () => visible.v } });
    await KIT.ticks();
    await KIT.adoptOnScreen(m); await KIT.ticks(20);
    let g0 = 0;
    const r = await KIT.applyOnScreen(m, { before: async () => {
      await m.mock.api.addPreviewFields('341', { other_note: { type: 'SINGLE_LINE_TEXT', code: 'other_note', label: 'x' } });
      if (hidden) visible.v = false;   // 押す直前に最小化
      g0 = m.mock.calls.length;
    } });
    out[hidden] = { stage: r.run && r.run.stage, written: r.run && r.run.written, changes: (r.run && r.run.stop && r.run.stop.changes) || [], gets: m.mock.calls.slice(g0).filter(c => /^GET /.test(c)), writes: m.mock.calls.slice(g0).filter(c => !/^GET/.test(c)) };   // 押した後の書き込み（押す前に足したフィールドは数えない）
  }
  const a = out[false], b = out[true];
  TABLE.push({ c: 'E', label: '［動作テスト環境へ反映］の照合の取り直し（押した直後に最小化）', s: b.gets, o: [], fk: KITFK });
  assert(a.stage === 'stopped' && a.written === false && a.changes.length === 4, `8-1 前提（見えているとき）: 書き込まずに止め、変わった点 4 項目: ${a.changes.join(' / ')}`);
  assert(b.stage === 'stopped' && b.written === false && b.writes.length === 0 && JSON.stringify(b.changes) === JSON.stringify(a.changes), `8-2 最小化中でも同じ正しい変わった点（4 項目）を出す（「反映する設定の手順が無くなりました」などの誤りを出さない）: ${b.changes.join(' / ')}`);
  //   2026-10-23: 押した直後の作業の基準の取り直し（明示の操作）は関所で止めない。照合の取り直しの準備（設定・JavaScript）はその基準の今の設定を受け取り、取得しない（前は運用環境の一覧・カスタマイズを取っていた）
  assert(b.gets.includes('GET fields') && b.gets.includes('GET customize') && !b.gets.includes('GET prod views') && JSON.stringify(b.gets) === JSON.stringify(a.gets), `8-3 押した直後の作業の基準の取り直しを関所で止めず、見えているときと同じ取得（照合の準備は取得しない）: ${b.gets.join(', ')}`);
});

// =========================================================
console.log('\n--- §9. 最小化で開いたページでも、設定取得ではない通信（AI の接続の確認）は起動時に行う ---');
const SESSION_KEY = 'ktAi.v2.test.cybozu.com';
function makeGateway() {
  let seq = 0;
  return (method, p) => {
    if (p === '/v2/token/exchange') {
      seq += 1;
      return { status: 200, body: JSON.stringify({ ok: true, contractVersion: '2.1', tokenType: 'Bearer', accessToken: `v1.AT-${seq}.sig`, expiresAt: '2099-01-01T00:00:00Z', expiresInSec: 2700, refreshToken: `v1.RT-${seq}.sig`, refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { customerId: 'c', domain: 'test.cybozu.com', product: 'toolkit', feature: 'assistant-qa', tokenId: `at_${seq}`, familyId: 'f' }, customer: { plan: 'pro', monthlyLimit: 100, expiresAt: '2099-01-01T00:00:00Z' } }) };
    }
    if (p === '/v2/health') return { status: 200, body: JSON.stringify(HEALTH) };
    return { status: 404, body: JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'not found' } }) };
  };
}
const connectedSession = () => JSON.stringify({ apiBase: 'https://gw.test', refreshToken: 'v1.RT-0.sig', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa', domain: 'test.cybozu.com' }, connectedAt: '2026-10-01T00:00:00Z' });
await safe('§9', async () => {
  const e = makeEnv({ storage: makeStorage({ [MINI_KEY]: '1', [SESSION_KEY]: connectedSession() }), gateway: makeGateway() });
  const root = await e.start(); await e.settle();
  const s = e.fk.settingsCalls(), o = e.fk.otherCalls();
  const gw = o.filter(c => c.kind === 'proxy');
  TABLE.push({ c: '1', label: '最小化で初期表示（AI 接続済み。接続の確認は起動時）', s, o, fk: e.fk });
  assert(s.length === 0, `9-1 最小化で開いたら設定取得 0 回のまま（作業の基準も取らない）: ${fmt(e.fk.byPath(s))}`);
  assert(sameMap(e.fk.byPath(gw), { 'POST /v2/token/exchange': 1, 'GET /v2/health': 1 }) && o.length === gw.length, `9-2 AI の接続の確認（トークンの交換・health）は起動時に 1 回ずつ（設定取得ではない通信は止めない）: ${fmt(e.fk.byPath(o))}`);
  assert(e.isMini(), '9-3 最小化のまま');
  const m = e.mark();
  await e.click('kt-mini'); await e.settle();
  const s2 = e.fk.settingsCalls(m), gw2 = e.fk.otherCalls(m).filter(c => c.kind === 'proxy');
  TABLE.push({ c: '3', label: '↑の後に初回の展開（Health。AI 接続済み）', s: s2, o: e.fk.otherCalls(m), fk: e.fk });
  assert(sameMap(e.fk.byPath(s2), { ...STAGE1, ...SCAN }), `9-4 展開したら Health に要る設定だけ（接続済みでも作業の基準は開発支援が見えるまで取らない）: ${fmt(e.fk.byPath(s2))}`);
  assert(gw2.length === 0, `9-5 開発支援の組み立ては起動時の接続の確認（同じセッション・health の結果）を使い、トークンの交換・health を二重に送らない: ${fmt(e.fk.byPath(gw2))}`);
  const cap = root && root.ktAi && typeof root.ktAi.capability === 'function' ? root.ktAi.capability() : null;
  assert(!!(cap && cap.available), `9-6 起動時の接続の確認の結果で利用可（available）: ${JSON.stringify(cap && { available: cap.available, reason: cap.reason })}`);
  const m3 = e.mark();
  await e.click('tab-ai'); await e.settle();
  const s3 = e.fk.settingsCalls(m3);
  assert(s3.some(c => /^\/k\/v1\/preview\/app\/form\/fields$/.test(c.path)) && e.fk.otherCalls(m3).filter(c => c.kind === 'proxy').length === 0, `9-7 開発支援を開いたら（見えた）作業の基準を取る（自動の設定取得は見えたとき）: ${s3.length} 回`);
});

// =========================================================
console.log('\n--- §10. 登録・戻すの後の作業の基準の取り直し: 見えている間はすぐ取り、最小化中は取らずに古い印を付け、展開したら取り直す ---');
await safe('§10', async () => {
  //   ［動作テスト環境へ反映］（設定 ＋ JavaScript の登録）→［JavaScript を戻す］→［設定を戻す］を順に行い、それぞれの操作の直前に最小化した（開発支援が見えない）場合と、
  //   見えたままの場合を比べる。登録・戻すの操作そのもの（書き込みと、その操作の中の照合の読み取り）は止めない。作業の基準の取り直しは偽の loadDevBase で数える
  const { createNewFlowKit } = require('./helpers/new-flow.js');
  const out = {};
  for (const hidden of [false, true]) {
    const T = loadToolkit();
    const KIT = createNewFlowKit(T);
    const visible = { v: true };
    const loads = [];   // 作業の基準の取り直し（reason・始めた時点の偽の動作テスト環境の呼び出しの位置）
    let mref = null;
    const loader = KIT.loadDevBaseFromMock(() => mref.mock);
    const gen = KIT.screenGenerate({ field: 'approval_memo', targetFile: 'memoLock.js' });
    const m = KIT.mount({ health: KIT.HEALTH_V, planImpl: KIT.planImplOf(KIT.screenPlan('mixed')), generateImpl: gen.impl,
      extra: { canAutoFetch: () => visible.v, loadDevBase: (a = {}) => { loads.push({ reason: a.reason || null, at: mref.mock.calls.length }); return loader(a); } } });
    mref = m;
    await KIT.ticks();
    await KIT.adoptOnScreen(m); await KIT.ticks(20);
    const o = out[hidden] = {};
    const revOf = () => { const s = T.KTDevBase.stamp(m.panel.devBase()); return s && s.revision ? s.revision.preview : null; };
    const hasFile = () => ((m.panel.devBase() && m.panel.devBase().files) || []).some(f => f && f.name === 'memoLock.js');
    const revoked = () => m.msgs().filter(x => x && x.data && x.data.kind === 'approval-revoked').length;
    const gets = (from, to = undefined) => m.mock.calls.slice(from, to).filter(c => /^GET /.test(c));
    /** 展開（開発支援が見えた）→ その間の取り直し */
    const expand = async () => {
      const l = loads.length, c = m.mock.calls.length;
      visible.v = true; m.panel.onVisible(); await KIT.ticks(30);
      return { reasons: loads.slice(l).map(x => x.reason), gets: gets(c), state: { ...m.panel.devBaseFetchState() }, rev: revOf(), hasFile: hasFile(), approval: !!(m.conv().activePlan() && m.conv().activePlan().approval), revoked: revoked() };
    };
    // 1. ［動作テスト環境へ反映］（押す直前に最小化）
    const l0 = loads.length;
    const r = await KIT.applyOnScreen(m, { before: async () => { if (hidden) visible.v = false; } });
    await KIT.ticks(30);
    const putIdx = m.mock.calls.lastIndexOf('PUT customize');   // JavaScript の登録の書き込み
    const afterPut = loads.slice(l0).filter(x => x.at > putIdx);
    const reload = afterPut.find(x => x.reason === 'after-js-register');
    o.reg = { stage: r.run && r.run.stage, registered: !!(r.run && r.run.js && r.run.js.registered), reasons: afterPut.map(x => x.reason),
      verify: gets(putIdx + 1, reload ? reload.at : undefined),   // 登録の中の照合の読み取り（取り直しを始める前まで）
      getsAfterPut: gets(putIdx + 1), state: { ...m.panel.devBaseFetchState() }, rev: revOf(), hasFile: hasFile() };
    o.regExpand = await expand();
    // 2. ［JavaScript を戻す］（押す直前に最小化）
    if (hidden) visible.v = false;
    let l = loads.length;
    const jrb = await m.panel.startJsRollback(); const jrbStatus = jrb && jrb.status;   // 戻した後は同じ記録の状態が変わるので、準備の時点で控える
    await m.panel.confirmJsRollback(); await KIT.ticks(30);
    o.jsrb = { prepared: jrbStatus, stage: m.panel.jsExecState().stage, reasons: loads.slice(l).map(x => x.reason), state: { ...m.panel.devBaseFetchState() }, rev: revOf() };
    o.jsrbExpand = await expand();
    // 3. ［設定を戻す］（押す直前に最小化）
    if (hidden) visible.v = false;
    l = loads.length;
    const srb = await m.panel.startRollback(); const srbStatus = srb && srb.status;
    await m.panel.confirmRollback(); await KIT.ticks(30);
    o.srb = { prepared: srbStatus, stage: m.panel.executorState().stage, reasons: loads.slice(l).map(x => x.reason), state: { ...m.panel.devBaseFetchState() }, rev: revOf() };
    o.srbExpand = await expand();
  }
  const a = out[false], b = out[true];
  TABLE.push({ c: 'E', label: '最小化中の JavaScript の登録（書き込みの後: 照合の読み取りだけ・作業の基準の取り直し 0 回）', s: b.reg.getsAfterPut, o: [], fk: KITFK });
  TABLE.push({ c: 'E', label: '↑の後に展開（作業の基準を 1 回取り直す）', s: b.regExpand.gets, o: [], fk: KITFK });
  // 前提（見えているとき）: 今までどおり、それぞれの操作の後にすぐ 1 回取り直す。展開（見えたまま）では取り直さない
  assert(a.reg.stage === 'done' && a.reg.registered && JSON.stringify(a.reg.reasons) === '["after-js-register"]' && a.reg.hasFile && a.regExpand.reasons.length === 0,
    `10-1 前提（見えているとき）: 登録の後にすぐ 1 回取り直し、登録した後の基準になる: ${a.reg.stage}・${a.reg.reasons.join(', ') || 'なし'}・ファイル ${a.reg.hasFile}`);
  assert(a.jsrb.stage === 'rolled-back' && JSON.stringify(a.jsrb.reasons) === '["after-js-rollback"]' && a.srb.stage === 'rolled-back' && JSON.stringify(a.srb.reasons) === '["after-rollback"]' && a.jsrbExpand.reasons.length === 0 && a.srbExpand.reasons.length === 0,
    `10-2 前提（見えているとき）: JavaScript を戻す・設定を戻すの後もすぐ 1 回ずつ取り直す: ${a.jsrb.stage}・${a.jsrb.reasons.join(', ') || 'なし'}／${a.srb.stage}・${a.srb.reasons.join(', ') || 'なし'}`);
  // 最小化中の登録
  assert(b.reg.stage === 'done' && b.reg.registered && b.reg.reasons.length === 0 && b.reg.state.stale === true && b.reg.state.wanted === true,
    `10-3 最小化中の登録: 登録は最後まで動き、登録の後の作業の基準の取り直しは 0 回。今の基準に古い印と「次に見えたときに取る」印を付ける: ${b.reg.stage}・取り直し ${b.reg.reasons.join(', ') || '0 回'}・${JSON.stringify(b.reg.state)}`);
  assert(b.reg.verify.length > 0 && JSON.stringify(b.reg.getsAfterPut) === JSON.stringify(a.reg.verify),
    `10-4 登録の中の照合の読み取り（書き込みの後の確かめ）は止めず、見えているときと同じ。それ以外の取得は始めない: ${b.reg.getsAfterPut.join(', ') || 'なし'}（見えているとき: ${a.reg.verify.join(', ')}）`);
  assert(!b.reg.hasFile && b.reg.rev !== a.reg.rev,
    `10-5 取り直すまでは、古い基準を登録の後の基準として扱わない（古い印のまま。revision ${b.reg.rev}・見えているときの登録の後は ${a.reg.rev}）`);
  assert(JSON.stringify(b.regExpand.reasons) === '["tab"]' && b.regExpand.state.stale === false && b.regExpand.state.wanted === false && b.regExpand.rev === a.reg.rev && b.regExpand.hasFile,
    `10-6 展開する（開発支援が見える）と 1 回取り直し、登録の後の基準になる（見えているときと同じ revision・登録したファイル）: ${b.regExpand.reasons.join(', ') || '0 回'}・revision ${b.regExpand.rev}・ファイル ${b.regExpand.hasFile}`);
  assert(b.regExpand.approval === a.regExpand.approval && b.regExpand.revoked === a.regExpand.revoked && b.regExpand.revoked === 0,
    `10-7 見送った取り直しは自分の登録の直後の取り直しと同じに扱い、承認の基準との違いで承認を外さない（見えているときと同じ）: 承認 ${b.regExpand.approval}（見えているとき ${a.regExpand.approval}）・取り消し ${b.regExpand.revoked}`);
  // 最小化中に戻す
  assert(b.jsrb.prepared === 'PREPARED' && b.jsrb.stage === 'rolled-back' && b.jsrb.reasons.length === 0 && b.jsrb.state.stale === true && b.jsrb.rev === b.regExpand.rev,
    `10-8 最小化中に JavaScript を戻す: 戻すは最後まで動き、取り直しは 0 回で古い印を付ける（基準は前のまま）: ${b.jsrb.stage}・取り直し ${b.jsrb.reasons.join(', ') || '0 回'}・${JSON.stringify(b.jsrb.state)}`);
  assert(JSON.stringify(b.jsrbExpand.reasons) === '["tab"]' && b.jsrbExpand.state.stale === false && b.jsrbExpand.rev === a.jsrb.rev,
    `10-9 展開すると 1 回取り直し、戻した後の基準になる（見えているときと同じ revision ${a.jsrb.rev}）: ${b.jsrbExpand.reasons.join(', ') || '0 回'}・revision ${b.jsrbExpand.rev}`);
  assert(b.srb.prepared === 'PREPARED' && b.srb.stage === 'rolled-back' && b.srb.reasons.length === 0 && b.srb.state.stale === true && b.srb.rev === b.jsrbExpand.rev,
    `10-10 最小化中に設定を戻す: 戻すは最後まで動き、取り直しは 0 回で古い印を付ける: ${b.srb.stage}・取り直し ${b.srb.reasons.join(', ') || '0 回'}・${JSON.stringify(b.srb.state)}`);
  assert(JSON.stringify(b.srbExpand.reasons) === '["tab"]' && b.srbExpand.state.stale === false && b.srbExpand.rev === a.srb.rev,
    `10-11 展開すると 1 回取り直し、戻した後の基準になる（見えているときと同じ revision ${a.srb.rev}）: ${b.srbExpand.reasons.join(', ') || '0 回'}・revision ${b.srbExpand.rev}`);
});

// =========================================================
console.log('\n--- §11. 登録・戻すの後の JavaScript の解析し直し（本物の KTScan）: 見えている間はすぐ、最小化中は取らずに古い印を付け、解析の結果を使う表示が見えたら 1 回だけ ---');
//   ページ（startToolkit。Field Scanner を本物の KTScan に登録し、JS の自動解析まで終える）と同じ Toolkit の中に、開発支援の画面（偽の動作テスト環境で登録・戻す）を組み立てる。
//   開発支援の rescanJs は renderAiWorkspace と同じつなぎ方（KTScan.rescanAfterWrite に関所を渡す）。修正前の版は、そのときのつなぎ方（KTScan.run({ force: true, silent: true })）で数える。
//   数えるのはページの偽の kintone（解析の取得: preview の customize・本文）。開発支援の登録・戻すの書き込みと照合は偽の動作テスト環境の側（数えない）
const RESCAN_WIRE = 'rescanJs: () => KTScan.rescanAfterWrite({ gate: KTFetchGate.of(root) })';
const rescanOf = (T, root) => (typeof T.KTScan.rescanAfterWrite === 'function'
  ? () => T.KTScan.rescanAfterWrite({ gate: T.KTFetchGate.of(root) })
  : () => T.KTScan.run({ force: true, silent: true }));
await safe('§11', async () => {
  const { createNewFlowKit } = require('./helpers/new-flow.js');
  const T0 = loadToolkit();
  assert(String(T0.renderAiWorkspace).includes(RESCAN_WIRE), `11-0 開発支援の rescanJs（登録・戻すの後の解析し直し）は関所を渡した KTScan.rescanAfterWrite につなぐ（${RESCAN_WIRE}）`);
  const out = {};
  for (const hidden of [false, true]) {
    const e = makeEnv({ mini: '0' });
    const root = await e.start(); await e.settle();
    const gate = e.T.KTFetchGate.of(root);
    const KIT = createNewFlowKit(e.T);
    const gen = KIT.screenGenerate({ field: 'approval_memo', targetFile: 'memoLock.js' });
    const m = KIT.mount({ health: KIT.HEALTH_V, planImpl: KIT.planImplOf(KIT.screenPlan('mixed')), generateImpl: gen.impl,
      extra: { canAutoFetch: () => gate.isOpen(), rescanJs: rescanOf(e.T, root) } });
    await KIT.ticks(); await KIT.adoptOnScreen(m); await KIT.ticks(20);
    const stale = () => (typeof e.T.KTScan.isStale === 'function' ? e.T.KTScan.isStale() : null);
    const scanState = () => e.T.KTScan.getStatus().state;
    const toggle = async () => { await e.click('kt-mini'); await e.settle(); };
    const o = out[hidden] = { start: scanState() };
    // 1. ［動作テスト環境へ反映］（設定 ＋ JavaScript の登録。押す前に最小化）→ 展開（Health のタブ = 解析の結果を使う表示）
    if (hidden) await toggle();
    let mk = e.mark();
    const r = await KIT.applyOnScreen(m); await e.settle();
    o.reg = { registered: !!(r.run && r.run.js && r.run.js.registered), s: e.fk.settingsCalls(mk), stale: stale(), mini: e.isMini() };
    mk = e.mark();
    if (hidden) await toggle();
    o.regExpand = { s: e.fk.settingsCalls(mk), stale: stale(), state: scanState() };
    mk = e.mark();
    await toggle(); await toggle();
    o.regAgain = e.fk.settingsCalls(mk);
    // 2. ［JavaScript を戻す］（Customize のタブ = 解析の結果を使わない表示を開いてから最小化）→ 展開（Customize のまま）→ Health を開く
    await e.click('tab-customize'); await e.settle();
    if (hidden) await toggle();
    mk = e.mark();
    const jrb = await m.panel.startJsRollback(); const jrbStatus = jrb && jrb.status;
    await m.panel.confirmJsRollback(); await e.settle();
    o.jsrb = { prepared: jrbStatus, stage: m.panel.jsExecState().stage, s: e.fk.settingsCalls(mk), stale: stale() };
    mk = e.mark();
    if (hidden) await toggle();
    o.jsrbExpand = { s: e.fk.settingsCalls(mk), stale: stale() };
    mk = e.mark();
    await e.click('tab-health'); await e.settle();
    o.jsrbHealth = { s: e.fk.settingsCalls(mk), stale: stale(), state: scanState() };
    if (hidden) {
      // 3. 最小化中の書き込みの後に、利用者が［Scan］を押した（明示の操作は止めない）→ 印を外す → 展開しても解析し直さない
      await toggle();
      mk = e.mark();
      await rescanOf(e.T, root)(); await e.settle();
      const deferred = e.fk.settingsCalls(mk), staleMid = stale();
      await e.byId.get('fs-scan').onclick(); await e.settle();
      o.explicit = { deferred, staleMid, s: e.fk.settingsCalls(mk), stale: stale() };
      mk = e.mark();
      await toggle();
      o.explicitExpand = e.fk.settingsCalls(mk);
      // 4. 書き込みの前に始めた解析（最小化中の［Scan］の途中）が書き込みの後に完了しても、古い印は外さない（最新として扱わない）→ 展開で 1 回
      await toggle();
      const h = e.fk.hold(/^\/k\/v1\/file$/);
      const p = e.byId.get('fs-scan').onclick(); await ticks();
      mk = e.mark();
      await rescanOf(e.T, root)(); await ticks();
      h.release(); await p; await e.settle();
      o.genOld = { s: e.fk.settingsCalls(mk), stale: stale(), state: scanState() };
      mk = e.mark();
      await toggle();
      o.genExpand = { s: e.fk.settingsCalls(mk), stale: stale() };
    }
    o.unexpectedAt = unexpected.length;
  }
  const a = out[false], b = out[true];
  TABLE.push({ c: 'E', label: '最小化中の JavaScript の登録の後の JS の解析し直し（本物の KTScan）', s: b.reg.s, o: [], fk: E.fk });
  TABLE.push({ c: 'E', label: '↑の後に展開（Health。解析し直しを 1 回）', s: b.regExpand.s, o: [], fk: E.fk });
  TABLE.push({ c: 'E', label: '最小化中の JavaScript を戻すの後の JS の解析し直し（本物の KTScan）', s: b.jsrb.s, o: [], fk: E.fk });
  TABLE.push({ c: 'E', label: '↑の後に展開（Customize のまま → Health を開く）', s: b.jsrbExpand.s.concat(b.jsrbHealth.s), o: [], fk: E.fk });
  // 前提（見えているとき）: 今までどおり、登録・戻すの後にすぐ解析し直す（preview の customize 1・本文 3）
  assert(a.start === 'done' && a.reg.registered && sameMap(E.fk.byPath(a.reg.s), SCAN) && a.reg.stale !== true,
    `11-1 前提（見えているとき）: 登録の後にすぐ解析し直す（preview の customize 1・本文 3）: ${fmt(E.fk.byPath(a.reg.s))}`);
  assert(a.jsrb.stage === 'rolled-back' && sameMap(E.fk.byPath(a.jsrb.s), SCAN) && a.jsrbHealth.s.length === 0 && a.regAgain.length === 0,
    `11-2 前提（見えているとき）: JavaScript を戻すの後もすぐ解析し直し（Customize のタブを表示していても）、その後の表示・最小化と展開では取らない: ${fmt(E.fk.byPath(a.jsrb.s))}・Health ${a.jsrbHealth.s.length} 回`);
  // 最小化中の登録・戻す
  assert(b.reg.registered && b.reg.mini && b.reg.s.length === 0 && b.reg.stale === true,
    `11-3 最小化中の登録: 登録は最後まで動き、登録の後の解析の取得（preview の customize・本文）は 0 回。解析の結果に古い印を付ける: ${b.reg.s.length} 回（${fmt(E.fk.byPath(b.reg.s))}）・印 ${b.reg.stale}`);
  assert(sameMap(E.fk.byPath(b.regExpand.s), SCAN) && b.regExpand.stale === false && b.regExpand.state === 'done' && b.regAgain.length === 0,
    `11-4 展開して解析の結果を使う表示（Health）が見えたら 1 回だけ解析し直す（キャッシュを使わない）。その後の最小化と展開では取らない: ${fmt(E.fk.byPath(b.regExpand.s))}・再び ${b.regAgain.length} 回`);
  assert(b.jsrb.prepared === 'PREPARED' && b.jsrb.stage === 'rolled-back' && b.jsrb.s.length === 0 && b.jsrb.stale === true,
    `11-5 最小化中に JavaScript を戻す: 戻すは最後まで動き、解析の取得は 0 回で古い印を付ける: ${b.jsrb.stage}・${b.jsrb.s.length} 回（${fmt(E.fk.byPath(b.jsrb.s))}）`);
  assert(b.jsrbExpand.s.length === 0 && b.jsrbExpand.stale === true && sameMap(E.fk.byPath(b.jsrbHealth.s), SCAN) && b.jsrbHealth.stale === false,
    `11-6 解析の結果を使わない表示（Customize）で展開しただけでは取らず、Health を開いた（必要になった）ときに 1 回だけ解析し直す: 展開 ${b.jsrbExpand.s.length} 回・Health ${fmt(E.fk.byPath(b.jsrbHealth.s))}`);
  assert(b.explicit && b.explicit.deferred.length === 0 && b.explicit.staleMid === true && sameMap(E.fk.byPath(b.explicit.s), SCAN) && b.explicit.stale === false && b.explicitExpand.length === 0,
    `11-7 古い印のある間に利用者が［Scan］を押したら最小化中でも取り（止めない）、印を外す。展開しても解析し直さない: ［Scan］${fmt(E.fk.byPath(b.explicit ? b.explicit.s : []))}・展開 ${b.explicitExpand ? b.explicitExpand.length : '-'} 回`);
  assert(b.genOld && b.genOld.stale === true && b.genOld.state === 'done' && sameMap(E.fk.byPath(b.genExpand.s), SCAN) && b.genExpand.stale === false,
    `11-8 書き込みの前に始めた解析（最小化中の［Scan］の途中）が書き込みの後に完了しても古い印は外さず、展開で 1 回だけ解析し直す: 完了の後の印 ${b.genOld && b.genOld.stale}・展開 ${b.genExpand ? fmt(E.fk.byPath(b.genExpand.s)) : '-'}`);
  // 見えている間に始めた解析し直しの途中（preview の customize を送った後）で最小化 → 本文（後続）は取らない → 展開で続きの本文だけ
  {
    const e = makeEnv({ mini: '0' });
    const root = await e.start(); await e.settle();
    const h = e.fk.hold(/^\/k\/v1\/preview\/app\/customize$/);
    const mk = e.mark();
    const p = rescanOf(e.T, root)(); await ticks();
    await e.click('kt-mini');
    h.release(); await p; await e.settle();
    const after = e.fk.settingsCalls(mk), staleMid = typeof e.T.KTScan.isStale === 'function' ? e.T.KTScan.isStale() : null, stMid = e.T.KTScan.getStatus().state;
    const mk2 = e.mark();
    await e.click('kt-mini'); await e.settle();
    const re = e.fk.settingsCalls(mk2);
    TABLE.push({ c: '5', label: '登録の後の JS の解析し直しの途中で最小化 → 完了の後', s: after.slice(1), o: [], fk: E.fk });
    TABLE.push({ c: '5', label: '↑の後に再展開（続きの本文だけ）', s: re, o: [], fk: E.fk });
    assert(sameMap(E.fk.byPath(after), { 'GET /k/v1/preview/app/customize': 1 }) && staleMid === true && stMid === 'done' && sameMap(E.fk.byPath(re), { 'fetch /k/v1/file': 3 }) && e.T.KTScan.isStale() === false,
      `11-9 解析し直しの途中で最小化したら、送った customize の完了の後の本文（後続）は 0 回で古い印のまま（状態は解析前の「解析済み」に戻す）。展開で続きの本文だけ: 途中 ${fmt(E.fk.byPath(after))}・状態 ${stMid}・展開 ${fmt(E.fk.byPath(re))}`);
  }
});

// =========================================================
console.log('\n--- §12. 最小化中の自分の登録の後に別の変更（JavaScript を戻す・設定を戻す・ほかの場所の変更）: 展開の取り直しで、見えているときと同じく承認の取り消しを判定する ---');
await safe('§12', async () => {
  const { createNewFlowKit } = require('./helpers/new-flow.js');
  const setup = async () => {
    const T = loadToolkit();
    const KIT = createNewFlowKit(T);
    const visible = { v: true };
    const loads = [];
    let mref = null;
    const loader = KIT.loadDevBaseFromMock(() => mref.mock);
    const gen = KIT.screenGenerate({ field: 'approval_memo', targetFile: 'memoLock.js' });
    const m = KIT.mount({ health: KIT.HEALTH_V, planImpl: KIT.planImplOf(KIT.screenPlan('mixed')), generateImpl: gen.impl,
      extra: { canAutoFetch: () => visible.v, loadDevBase: (x = {}) => { loads.push(x.reason || null); return loader(x); } } });
    mref = m;
    await KIT.ticks();
    await KIT.adoptOnScreen(m); await KIT.ticks(20);
    const info = () => ({ approval: !!(m.conv().activePlan() && m.conv().activePlan().approval), revoked: m.msgs().filter(x => x && x.data && x.data.kind === 'approval-revoked').length, reasons: loads.slice(), state: { ...m.panel.devBaseFetchState() } });
    const register = async (hide) => { await KIT.applyOnScreen(m, { before: async () => { if (hide) visible.v = false; } }); await KIT.ticks(30); };
    const expand = async () => { visible.v = true; m.panel.onVisible(); await KIT.ticks(30); };
    return { T, KIT, m, visible, loads, info, register, expand };
  };
  const rollbackBoth = async (x) => {
    await x.m.panel.startJsRollback(); await x.m.panel.confirmJsRollback(); await x.KIT.ticks(30);
    await x.m.panel.startRollback(); await x.m.panel.confirmRollback(); await x.KIT.ticks(30);
  };
  // ほかの場所の変更（動作テスト環境へフィールドを足し、Toolkit のほかの場所の知らせ invalidateDevBase）
  const outside = async (x) => { await x.m.mock.api.addPreviewFields('341', { ext_note: { type: 'SINGLE_LINE_TEXT', code: 'ext_note', label: 'ext' } }); x.m.panel.invalidateDevBase(); };
  // (a) 登録 → JavaScript を戻す → 設定を戻す（見えたまま／登録の前に最小化して、展開は最後だけ）
  const va = await setup(); await va.register(false); await rollbackBoth(va); await va.expand();
  const A = va.info();
  const ha = await setup(); await ha.register(true); await rollbackBoth(ha);
  const HAmid = ha.info();
  await ha.expand();
  const HA = ha.info();
  assert(A.approval === false && A.revoked === 1, `12-1 前提（見えているとき）: 登録 → JavaScript を戻す → 設定を戻すで、設定を戻した後の取り直しが承認を取り消す: 承認 ${A.approval}・取り消し ${A.revoked}`);
  //   登録・戻すの後の続きの取り直し（after-js-register / after-js-rollback / after-rollback）。after-apply は反映の操作の中の取り直し（明示）なので数えない
  const deferredOf = (rs) => rs.filter(r => ['after-js-register', 'after-js-rollback', 'after-rollback'].includes(r));
  assert(HAmid.approval === true && HAmid.revoked === 0 && deferredOf(HAmid.reasons).length === 0 && HAmid.state.stale === true,
    `12-2 最小化中は登録・戻すの後の取り直しを見送る（判定は展開の取り直しで）: 取り直し ${deferredOf(HAmid.reasons).join(', ') || '0 回'}・印 ${HAmid.state.stale}`);
  assert(HA.approval === A.approval && HA.revoked === A.revoked && HA.reasons[HA.reasons.length - 1] === 'tab',
    `12-3 最小化中に登録の後で戻したら、展開の取り直しで見えているときと同じく承認の取り消しを判定する（自分の登録の印を残さない）: 承認 ${HA.approval}（見えているとき ${A.approval}）・取り消し ${HA.revoked}（${A.revoked}）`);
  // (b) 登録 → ほかの場所の変更（見えたまま／登録の前に最小化）→ 展開
  const vb = await setup(); await vb.register(false); await outside(vb); await vb.expand();
  const B = vb.info();
  const hb = await setup(); await hb.register(true); await outside(hb); await hb.expand();
  const HB = hb.info();
  assert(B.approval === false && B.revoked === 1, `12-4 前提（見えているとき）: 登録の後のほかの場所の変更は、次の取り直しで承認を取り消す: 承認 ${B.approval}・取り消し ${B.revoked}`);
  assert(HB.approval === B.approval && HB.revoked === B.revoked && HB.reasons[HB.reasons.length - 1] === 'tab',
    `12-5 最小化中の登録の後にほかの場所の変更（invalidateDevBase）があったら、展開の取り直しで見えているときと同じく承認の取り消しを判定する: 承認 ${HB.approval}（見えているとき ${B.approval}）・取り消し ${HB.revoked}（${B.revoked}）`);
  // (c) 見送るときの古い印は世代を進める: 書き込みの前に始めた取得（明示の［再取得］）が書き込みの後に完了しても、古い印のまま（最新として扱わない）。展開で 1 回取り直す
  for (const reason of ['after-js-register', 'after-js-rollback', 'after-rollback']) {
    const T = loadToolkit();
    const KIT = createNewFlowKit(T);
    const visible = { v: true };
    const loads = [];
    let mref = null, hold = null;
    const loader = KIT.loadDevBaseFromMock(() => mref.mock);
    const m = KIT.mount({ health: KIT.HEALTH_V, extra: { canAutoFetch: () => visible.v, loadDevBase: async (x = {}) => { loads.push(x.reason || null); if (hold) await hold.p; return loader(x); } } });
    mref = m;
    await KIT.ticks(30);
    visible.v = false;
    let open = null;
    hold = { p: new Promise((r) => { open = r; }) };
    const p = m.panel.refreshDevBase({ reason: 'manual' });   // 書き込みの前に始めた取得（明示の操作なので最小化中でも最後まで取る）
    await KIT.ticks(5);
    await m.panel.refreshDevBase({ reason });                  // 最小化中に書き込みが終わった（取り直しは見送る）
    const mid = { ...m.panel.devBaseFetchState() };
    open(); hold = null; await p; await KIT.ticks(10);
    const after = { ...m.panel.devBaseFetchState() };
    const l = loads.length;
    visible.v = true; m.panel.onVisible(); await KIT.ticks(30);
    const fin = { ...m.panel.devBaseFetchState() };
    assert(mid.stale === true && mid.wanted === true && mid.loading === true && after.stale === true && JSON.stringify(loads.slice(l)) === '["tab"]' && fin.stale === false,
      `12-6 ${reason}: 見送るときに世代を進め、書き込みの前に始めた取得が後で完了しても古い印のまま。展開で 1 回取り直す: 見送り ${JSON.stringify({ stale: mid.stale, wanted: mid.wanted, loading: mid.loading })}・前の取得の完了の後 stale=${after.stale}・展開 ${loads.slice(l).join(', ') || '0 回'}・stale=${fin.stale}`);
  }
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
