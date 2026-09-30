// JavaScript解析：カスタマイズファイルの識別キーの回帰テスト
//
// 背景:
//   JavaScript解析の結果は「どのファイルか」をキーにして依存関係データへ合流する。
//   依存関係データ上のファイルの識別子は  <target>:<kind>:<ファイル名>  （例: desktop:js:common.js）で、
//   CUSTOMIZE ノードのID・エッジの sourceId・イベント種別（meta.jsEvents）のキーがこの形で揃っている。
//   一方、JS内のアプリID参照を集約するキーだけが  <ファイル名>|<アプリID>  で target を含んでおらず、
//   PC用とモバイル用に同名のファイルがあると1件に合流していた
//   （片方のファイルのアプリ参照エッジが欠落し、行番号がもう片方のファイルのものとして記録される）。
//
// 検証内容:
//   1. PC用／モバイル用の同名ファイルのアプリID参照が、ファイルごとのエッジになる（行番号も混ざらない）
//   2. 同じファイル内の複数回の参照は、従来どおり1本に集約される
//   3. 識別子の形が揃っており、JS由来のエッジの参照元がすべて CUSTOMIZE ノードに対応する
//   4. 「存在しない参照」のファイル表記（現状は <target>:<ファイル名>）からも、対応するノードを特定できる
//
// 実行方法:
//   node tests/js-file-key.test.js
//   （終了コード 0 = 成功、1 = 失敗）
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- 実スクリプトを sandbox に読み込み、KTScan / KTDeps を取り出す ----
const SRC = path.join(__dirname, '..', 'kintoneAppToolkit.user.js');
let code = fs.readFileSync(SRC, 'utf8');
const lastClose = code.lastIndexOf('})();');
if (lastClose < 0) throw new Error('IIFE close not found');
code = code.slice(0, lastClose) + '\n  globalThis.__TEST__ = { KTScan, KTDeps };\n' + code.slice(lastClose);

const noop = () => { };
const fakeStorage = { getItem: () => null, setItem: noop, removeItem: noop };
const sandbox = {
  console, setTimeout, clearTimeout,
  setInterval: () => 0, clearInterval: noop, // waitReady のポーリングは動かさない
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
const { KTScan, KTDeps } = sandbox.__TEST__;

// ---- テストユーティリティ ----
let failed = 0;
const assert = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) failed++;
};
const SELF_APP = 320;

// =========================================================
// フィクスチャ：App 320「受注管理」。PC用とモバイル用に同名の common.js を登録している
// =========================================================
// GET /k/v1/app/customize.json と同じ形
const fileItem = (name, fileKey) => ({ type: 'FILE', file: { contentType: 'text/javascript', fileKey, name, size: '1024' } });
const CUSTOMIZE = {
  scope: 'ALL',
  desktop: {
    js: [
      { type: 'URL', url: 'https://js.cybozu.com/luxon/3.4.4/luxon.min.js' },
      fileItem('common.js', '20260930000000AAAA'),
      fileItem('desktop-only.js', '20260930000000BBBB'),
    ],
    css: [{ type: 'FILE', file: { contentType: 'text/css', fileKey: '20260930000000CCCC', name: 'style.css', size: '256' } }],
  },
  mobile: {
    js: [fileItem('common.js', '20260930000000DDDD')], // PC用と同名（内容は別）
    css: [],
  },
  revision: '5',
};

// PC用 common.js：app 1112 を 3行目と 9行目で参照、変数指定のアプリ参照が 10行目
const DESKTOP_COMMON = [
  "(function () {",
  "  'use strict';",
  "  const params = { app: 1112, fields: ['customer_code'] };",
  "  kintone.events.on('app.record.edit.show', (event) => {",
  "    const name = event.record['customer'].value;",
  "    const old = event.record['legacy_code'].value;",
  "    return event;",
  "  });",
  "  kintone.api(kintone.api.url('/k/v1/records.json', true), 'GET', { app: 1112, fields: ['customer_code'] });",
  "  const cfg = { app: OTHER_APP };",
  "})();",
].join('\n');
// モバイル用 common.js：app 1112 を 7行目で参照、変数指定のアプリ参照が 8行目
const MOBILE_COMMON = [
  "(function () {",
  "  'use strict';",
  "  kintone.events.on('mobile.app.record.edit.show', (event) => {",
  "    const name = event.record['customer'].value;",
  "    const old = event.record['legacy_code'].value;",
  "  });",
  "  const params = { app: 1112, fields: ['customer_code'] };",
  "  const other = { app: TARGET_APP_ID };",
  "  client.record.getRecords(params);",
  "})();",
].join('\n');
const DESKTOP_ONLY = "const p = { app: 2001 };\n";

const files = [
  { name: 'common.js', target: 'desktop', kind: 'js', text: DESKTOP_COMMON },
  { name: 'desktop-only.js', target: 'desktop', kind: 'js', text: DESKTOP_ONLY },
  { name: 'common.js', target: 'mobile', kind: 'js', text: MOBILE_COMMON },
];
const FIELDS = [{ code: 'customer', label: '顧客名' }, { code: 'amount', label: '金額' }];

// Field Scanner（scanOnce）と同じ手順で、JS本文からアプリID参照を集める（自アプリIDは除外）
const appRefs = [];
for (const f of files) {
  const clean = KTScan.stripCommentsOnly(f.text);
  const li = KTScan.buildLineIndex(clean);
  for (const ref of KTDeps.extractAppIdRefs(clean, (i) => KTScan.lineAt(li, i))) {
    if (ref.appId && String(ref.appId) === String(SELF_APP)) continue;
    appRefs.push({ ...ref, file: f.name, target: f.target });
  }
}
const unknownRefs = KTScan.collectUnknownFieldRefs(files, FIELDS, [], SELF_APP);
const externalRefs = KTScan.collectExternalFieldRefs(files, SELF_APP);
const scan = {
  // フィールド利用（Field Scanner の analyze 相当）：PC用・モバイル用の両方が customer を読む
  results: [{
    code: 'customer', label: '顧客名', type: 'SINGLE_LINE_TEXT', used: true, count: 2,
    files: ['desktop: common.js', 'mobile: common.js'],
    matches: [
      { file: 'common.js', target: 'desktop', kind: 'js', line: 5, access: 'READ', confidence: 'HIGH', snippet: '' },
      { file: 'common.js', target: 'mobile', kind: 'js', line: 4, access: 'READ', confidence: 'HIGH', snippet: '' },
    ],
  }],
  appRefs, unknownRefs, externalRefs, unknownStatuses: [],
  fileEvents: {
    'desktop:js:common.js': [{ name: 'app.record.edit.show', direct: true }],
    'mobile:js:common.js': [{ name: 'mobile.app.record.edit.show', direct: true }],
  },
};

const buildDeps = () => {
  const DATA = {
    appId: SELF_APP,
    fields: Object.fromEntries(FIELDS.map(f => [f.code, { type: 'SINGLE_LINE_TEXT', code: f.code, label: f.label }])),
    customize: CUSTOMIZE,
    settings: { name: '受注管理' },
  };
  return KTDeps.buildDependencyData(DATA, KTDeps.normalizeFields(DATA.fields));
};
const deps = buildDeps();
KTDeps.mergeScannerEdges(deps, scan);

const appEdges = (appId) => deps.edges.filter(e =>
  e.sourceType === 'CUSTOMIZE' && e.relationType === 'APP_REFERENCE' && e.targetType === 'APP' && String(e.targetId) === String(appId));
const appEdge = (sourceId, appId) => appEdges(appId).filter(e => e.sourceId === sourceId);

// =========================================================
// 0. fixture の前提（走査で得られるアプリID参照）
// =========================================================
console.log('\n--- 0. fixture の前提 ---');
{
  const lit = (target) => appRefs.filter(r => r.file === 'common.js' && r.target === target && r.appId === '1112').map(r => r.line);
  assert(JSON.stringify(lit('desktop')) === JSON.stringify([3, 9]) && JSON.stringify(lit('mobile')) === JSON.stringify([7]),
    `app 1112 への参照: PC用 common.js は 3・9行目、モバイル用 common.js は 7行目（実際: ${lit('desktop')} / ${lit('mobile')}）`);
  assert(appRefs.filter(r => !r.appId).length === 2, '変数指定のアプリ参照（特定不可）は PC用・モバイル用に 1 件ずつ');
}

// =========================================================
// 1. 同名ファイル（PC用／モバイル用）のアプリID参照はファイルごとのエッジになる
// =========================================================
console.log('\n--- 1. 同名ファイルのアプリID参照を合流させない ---');
{
  assert(appEdges('1112').length === 2, `app 1112 へのエッジは PC用・モバイル用の 2 本（実際: ${appEdges('1112').length} 本）`);
  const d = appEdge('desktop:js:common.js', '1112')[0];
  const m = appEdge('mobile:js:common.js', '1112')[0];
  assert(!!d && !!m, 'PC用（desktop:js:common.js）とモバイル用（mobile:js:common.js）のそれぞれが参照元になる');
  assert(JSON.stringify(d?.context?.lines) === JSON.stringify([3, 9]) && d?.context?.matchCount === 2,
    `PC用のエッジの行番号は PC用ファイルのものだけ（実際: ${JSON.stringify(d?.context?.lines)}）`);
  assert(JSON.stringify(m?.context?.lines) === JSON.stringify([7]) && m?.context?.matchCount === 1,
    `モバイル用のエッジの行番号は モバイル用ファイルのものだけ（実際: ${JSON.stringify(m?.context?.lines)}）`);
  assert(d?.context?.target === 'desktop' && m?.context?.target === 'mobile', 'context.target が参照元ファイルの target と一致する');

  // 変数指定（アプリIDを特定できない参照）も、ファイルごとに 1 本
  assert(appEdges('UNKNOWN').length === 2
    && JSON.stringify(appEdge('desktop:js:common.js', 'UNKNOWN')[0]?.context?.lines) === JSON.stringify([10])
    && JSON.stringify(appEdge('mobile:js:common.js', 'UNKNOWN')[0]?.context?.lines) === JSON.stringify([8]),
    '変数指定のアプリ参照も PC用（10行目）・モバイル用（8行目）で別のエッジになる');

  // アプリ間依存（Relations の依存関係サマリー）にも、ファイルごとの行として出る
  const links = KTDeps.buildAppLinks(deps, SELF_APP).filter(r => r.kind === 'JavaScript');
  assert(links.filter(r => r.destAppId === '1112').length === 2, `依存関係サマリーの JavaScript → app 1112 は 2 行（実際: ${links.filter(r => r.destAppId === '1112').length}）`);
  assert(links.length === 5, `JavaScript 行は 5 行（app 1112 ×2・不明 ×2・app 2001 ×1。実際: ${links.length}）`);
}

// =========================================================
// 2. 集約の単位は従来どおり（ファイル × 接続先アプリ）
// =========================================================
console.log('\n--- 2. 集約の単位 ---');
{
  assert(appEdge('desktop:js:common.js', '1112').length === 1, '同じファイルから同じアプリへの複数回の参照は 1 本に集約する（3・9行目）');
  assert(appEdge('desktop:js:desktop-only.js', '2001').length === 1 && appEdges('2001').length === 1,
    '別名のファイル（desktop-only.js → app 2001）は従来どおり独立したエッジ');
  assert(appEdges('1112').every(e => e.confidence === 'UNCERTAIN' && e.context.settingType === 'JS_APP_ID'),
    '確度（UNCERTAIN）・設定種別（JS_APP_ID）は従来どおり');
  // 再スキャン（再合流）しても重複しない
  const before = deps.edges.length;
  KTDeps.mergeScannerEdges(deps, scan);
  assert(deps.edges.length === before && appEdges('1112').length === 2, `再合流してもエッジが重複しない（${before} → ${deps.edges.length}）`);
}

// =========================================================
// 3. 識別子の形が揃っている（<target>:<kind>:<ファイル名>）
// =========================================================
console.log('\n--- 3. ファイルの識別子の整合 ---');
{
  const nodeIds = new Set(deps.nodes.map(n => n.id));
  assert(['CUSTOMIZE:desktop:js:common.js', 'CUSTOMIZE:mobile:js:common.js', 'CUSTOMIZE:desktop:js:desktop-only.js', 'CUSTOMIZE:desktop:css:style.css']
    .every(id => nodeIds.has(id)), 'CUSTOMIZE ノードのIDは CUSTOMIZE:<target>:<kind>:<ファイル名>（同名でも target が違えば別ノード）');

  const jsEdges = deps.edges.filter(e => e.sourceType === 'CUSTOMIZE');
  const kinds = [...new Set(jsEdges.map(e => e.context.settingType))].sort();
  assert(JSON.stringify(kinds) === JSON.stringify(['JS', 'JS_APP_ID', 'JS_EXTERNAL_FIELD']),
    `フィールド利用・アプリID参照・外部アプリのフィールド参照 の 3 種類のエッジがある（実際: ${kinds.join(', ')}）`);
  assert(jsEdges.every(e => nodeIds.has(`CUSTOMIZE:${e.sourceId}`)),
    'JS由来のエッジの参照元（sourceId）は、種類を問わずすべて CUSTOMIZE ノードに対応する');
  assert(jsEdges.every(e => e.sourceId === `${e.context.target}:js:${e.sourceName}`),
    'sourceId = <target>:js:<ファイル名>、sourceName = ファイル名 で揃っている');

  // イベント種別（meta.jsEvents）も同じキーで引ける → 変更影響の注記に、そのファイルのイベントが出る
  const direct = KTDeps.impactOf(deps, 'customer').direct.filter(d => d.sourceType === 'CUSTOMIZE');
  assert(direct.length === 2, `customer の JavaScript からの利用は PC用・モバイル用の 2 件（実際: ${direct.length}）`);
  assert(direct.some(d => /5行目/.test(d.note) && /イベント: app\.record\.edit\.show/.test(d.note))
    && direct.some(d => /4行目/.test(d.note) && /イベント: mobile\.app\.record\.edit\.show/.test(d.note)),
    `行番号とイベント種別が、それぞれのファイルのものになる（実際: ${direct.map(d => d.note).join(' || ')}）`);
  const evNode = deps.nodes.find(n => n.id === 'CUSTOMIZE:mobile:js:common.js');
  assert(Array.isArray(evNode?.events) && evNode.events[0].name === 'mobile.app.record.edit.show', 'CUSTOMIZE ノードにも同じキーでイベント種別が付く');
}

// =========================================================
// 4. 「存在しない参照」のファイル表記（現状仕様の明示）
//   files[].name は <target>:<ファイル名>（kind を含まない）。依存関係データ上の識別子とは表記が異なるが、
//   JavaScript のみが対象のため、target とファイル名から対応する CUSTOMIZE ノードを一意に特定できる。
// =========================================================
console.log('\n--- 4. 存在しない参照のファイル表記 ---');
{
  const nodeIds = new Set(deps.nodes.map(n => n.id));
  const u = (deps.meta.unknownJsRefs || []).find(x => x.code === 'legacy_code');
  const names = (u?.files || []).map(f => f.name).sort();
  assert(JSON.stringify(names) === JSON.stringify(['desktop:common.js', 'mobile:common.js']),
    `同名ファイルでも PC用・モバイル用を別ファイルとして報告する（実際: ${names.join(', ')}）`);
  assert(JSON.stringify((u?.files || []).find(f => f.name === 'desktop:common.js')?.lines) === JSON.stringify([6])
    && JSON.stringify((u?.files || []).find(f => f.name === 'mobile:common.js')?.lines) === JSON.stringify([5]),
    '行番号はそれぞれのファイルのもの（PC用 6行目／モバイル用 5行目）');
  const toNodeId = (name) => {
    const i = name.indexOf(':'); // target（desktop / mobile）は ':' を含まない
    return `CUSTOMIZE:${name.slice(0, i)}:js:${name.slice(i + 1)}`;
  };
  assert(names.length === 2 && names.every(n => nodeIds.has(toNodeId(n))), 'target とファイル名から、対応する CUSTOMIZE ノードを特定できる');
  const broken = KTDeps.findBrokenRefs(deps).find(b => b.code === 'legacy_code');
  assert(!!broken && broken.settingName === 'desktop:common.js / mobile:common.js',
    `存在しない参照の表示（ファイル・設定名）は従来どおり（実際: ${broken?.settingName}）`);
}

console.log(failed ? `\n${failed} test(s) FAILED` : '\nAll tests passed');
process.exit(failed ? 1 : 0);
