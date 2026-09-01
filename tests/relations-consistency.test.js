// Relations の「詳細セクション」と「アプリ間依存Summary（buildAppLinks）」の件数整合テスト
//
// 背景（v2.2.1 の修正）:
//   関連レコード一覧が自アプリ自身を参照する設定（例：同じアプリの他レコードを表示）が、
//   詳細（Related Records）には表示される一方、buildAppLinks の自アプリ除外により
//   Summary から欠落していた。
//
// 検証内容:
//   - buildRelations の lookups / relatedTables / 接続先ありactions の件数が、
//     buildAppLinks の ルックアップ / 関連レコード / アプリアクション 行数と一致すること
//   - REFERENCE_TABLE の APP_REFERENCE edge が設定単位で生成されること（自アプリ参照含む）
//   ※ 仕様上の除外: JS解析由来（JS_APP_ID）の自アプリ参照はスキャン側で除外されるため対象外。
//     接続先不明（destApp 未設定のアクション）は edge を作らないため、件数比較からも除外する。
//
// 実行方法:
//   node tests/relations-consistency.test.js
//   （終了コード 0 = 成功、1 = 失敗）
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- 実スクリプトを sandbox に読み込み、内部関数を取り出す ----
const SRC = path.join(__dirname, '..', 'kintoneAppToolkit.user.js');
let code = fs.readFileSync(SRC, 'utf8');
const lastClose = code.lastIndexOf('})();');
if (lastClose < 0) throw new Error('IIFE close not found');
code = code.slice(0, lastClose)
  + '\n  globalThis.__TEST__ = { buildRelations, KTDeps };\n'
  + code.slice(lastClose);

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
const { buildRelations, KTDeps } = sandbox.__TEST__;

// ---- テストデータ ----
// v2.2.1 のバグ報告と同型: ルックアップ→1096、関連レコード→1084、関連レコード→自アプリ(1072)
const makeFields = () => ({
  'ルックアップ_得意先': {
    type: 'SINGLE_LINE_TEXT', code: 'ルックアップ_得意先', label: 'ルックアップ_得意先',
    lookup: {
      relatedApp: { app: '1096', code: '' },
      relatedKeyField: '得意先コード',
      fieldMappings: [{ field: '得意先名もしくはお客様名', relatedField: '得意先名' }],
      lookupPickerFields: ['得意先名'],
    },
  },
  '関連コード一覧': {
    type: 'REFERENCE_TABLE', code: '関連コード一覧', label: '関連コード一覧',
    referenceTable: {
      relatedApp: { app: '1084', code: '' },
      condition: { field: 'コダトコード', relatedField: 'コダトコード' },
      displayFields: ['項目A'], sort: 'レコード番号 desc, 更新日時 asc',
      filterCond: 'ステータス in ("有効")', size: '10',
    },
  },
  'このお客様の他の依頼': {
    type: 'REFERENCE_TABLE', code: 'このお客様の他の依頼', label: 'このお客様の他の依頼',
    referenceTable: {
      relatedApp: { app: '1072', code: '' }, // 自アプリ参照になり得る設定
      condition: { field: '得意先名もしくはお客様名', relatedField: '得意先名もしくはお客様名' },
      displayFields: ['依頼日'], sort: '',
    },
  },
  '得意先名もしくはお客様名': { type: 'SINGLE_LINE_TEXT', code: '得意先名もしくはお客様名', label: '得意先名もしくはお客様名' },
  'コダトコード': { type: 'SINGLE_LINE_TEXT', code: 'コダトコード', label: 'コダトコード' },
});
const makeActions = () => ({
  actions: {
    '複製して作成': { id: '1', name: '複製して作成', destApp: { app: '1072', code: '' }, mappings: [] }, // 自アプリへのアクション
    '見積作成': {
      id: '2', name: '見積作成', destApp: { app: '1084', code: '' },
      mappings: [
        { srcType: 'FIELD', srcField: 'コダトコード', destField: 'コダトコード' },
        { srcType: 'RECORD_URL', destField: '元レコード' },
      ],
      filterCond: 'ステータス in ("受注")',
    },
  },
});

let failed = 0;
const assert = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) failed++;
};

function checkConsistency(appId, note) {
  const DATA = { appId, fields: makeFields(), actions: makeActions(), settings: { name: '依頼管理' } };
  const relations = buildRelations(DATA);
  const fieldsN = KTDeps.normalizeFields(DATA.fields);
  const deps = KTDeps.buildDependencyData(DATA, fieldsN);
  const appLinks = KTDeps.buildAppLinks(deps, DATA.appId);
  const cnt = (kind) => appLinks.filter(r => r.kind === kind).length;
  // 接続先アプリ不明のアクションは edge を作らないため比較から除外（仕様）
  const actionsWithDest = (relations.actions || []).filter(a => a.toAppId != null).length;

  console.log(`\n--- appId=${appId}（${note}）---`);
  assert(relations.lookups.length === cnt('ルックアップ'),
    `Lookup: relations.lookups(${relations.lookups.length}) ⇔ appLinks ルックアップ(${cnt('ルックアップ')})`);
  assert(relations.relatedTables.length === cnt('関連レコード'),
    `Related Records: relations.relatedTables(${relations.relatedTables.length}) ⇔ appLinks 関連レコード(${cnt('関連レコード')})`);
  assert(actionsWithDest === cnt('アプリアクション'),
    `Actions: 接続先あり(${actionsWithDest}) ⇔ appLinks アプリアクション(${cnt('アプリアクション')})`);
  return { relations, deps, appLinks };
}

// ケース1: 自アプリ=1072（バグ報告の状況。自アプリ参照の関連レコードあり）
const { deps, appLinks } = checkConsistency(1072, '自アプリ参照あり：報告された症状の再現条件');

// REFERENCE_TABLE の edge が設定単位で存在すること
const rtEdge = (src, target) => deps.edges.some(e =>
  e.sourceType === 'FIELD' && e.sourceId === src &&
  e.relationType === 'APP_REFERENCE' && e.targetType === 'APP' &&
  e.targetId === target && e.context?.settingType === 'REFERENCE_TABLE' &&
  e.confidence === 'CERTAIN');
assert(rtEdge('関連コード一覧', '1084'), 'edge: 関連コード一覧 → APP 1084 (REFERENCE_TABLE, CERTAIN)');
assert(rtEdge('このお客様の他の依頼', '1072'), 'edge: このお客様の他の依頼 → APP 1072 (REFERENCE_TABLE, CERTAIN)');

// Summary に自アプリ参照行が「（このアプリ）」付きで表示されること
const selfRow = appLinks.find(r => r.kind === '関連レコード' && r.destAppId === '1072');
assert(!!selfRow, 'appLinks: 関連レコード → app 1072 の行が存在する');
assert(!!selfRow && /（このアプリ）/.test(selfRow.destAppLabel),
  `appLinks: 自アプリ参照行のラベルに「（このアプリ）」が付く（実際: ${selfRow?.destAppLabel}）`);

// 期待件数: ルックアップ1 + 関連レコード2 + アクション2 = 5件
assert(appLinks.length === 5, `appLinks 件数 = 5（実際: ${appLinks.length}）`);

// ---- v2.2.1 UI改善分：Details用データとSummaryの接続キー表示 ----
{
  const DATA = { appId: 1072, fields: makeFields(), actions: makeActions(), settings: { name: '依頼管理' } };
  const relations = buildRelations(DATA);
  const deps2 = KTDeps.buildDependencyData(DATA, KTDeps.normalizeFields(DATA.fields));
  const links = KTDeps.buildAppLinks(deps2, 1072);

  console.log('\n--- Details用データ（buildRelations拡張）---');
  const rt = relations.relatedTables.find(r => r.code === '関連コード一覧');
  assert(rt.filterCond === 'ステータス in ("有効")', 'relatedTables: filterCond を保持する');
  assert(rt.size === '10', 'relatedTables: size を保持する');
  assert(rt.raw && rt.raw.condition && rt.raw.condition.field === 'コダトコード', 'relatedTables: raw（Raw JSON表示用）を保持する');
  const act = relations.actions.find(a => a.id === '2');
  assert(Array.isArray(act.mappingsDetail) && act.mappingsDetail.length === 2, 'actions: mappingsDetail（構造化マッピング）を保持する');
  assert(act.mappingsDetail[0].srcField === 'コダトコード' && act.mappingsDetail[0].destField === 'コダトコード',
    'actions: mappingsDetail の方向は 自アプリ(srcField) → 接続先(destField)');
  assert(act.mappingsDetail[1].srcType === 'RECORD_URL' && act.mappingsDetail[1].srcField === null,
    'actions: srcField の無いマッピング（RECORD_URL等）は srcType を保持する');
  const lu = relations.lookups[0];
  assert('filterCond' in lu && 'sort' in lu && lu.raw != null, 'lookups: filterCond / sort / raw を保持する');

  console.log('\n--- Summary（buildAppLinks）の接続キー・備考表示 ---');
  const rtRow = links.find(r => r.kind === '関連レコード' && r.destAppId === '1084');
  assert(rtRow.destField === 'コダトコード', `Summary: 関連レコード行の接続先フィールドに接続先キーを表示（実際: ${rtRow.destField}）`);
  assert(rtRow.selfKey === 'コダトコード', `Summary: 関連レコード行に自アプリ側キー（selfKey）を付与（実際: ${rtRow.selfKey}）`);
  assert(rtRow.note === '1フィールド表示', `Summary: 備考は表示フィールド数（実際: ${rtRow.note}）`);
  const luRow = links.find(r => r.kind === 'ルックアップ');
  assert(/項目を取得/.test(luRow.note), `Summary: Lookup備考は「n項目を取得」を維持（実際: ${luRow.note}）`);
  assert(links.every(r => r.sourceId != null), 'Summary: 全行に sourceId（Detailsジャンプ用）が付与される');
}

// ケース2: 自アプリ=9999（参照先がすべて他アプリの場合も整合すること）
checkConsistency(9999, '自アプリ参照なし');

console.log(failed ? `\n${failed} test(s) FAILED` : '\nAll tests passed');
process.exit(failed ? 1 : 0);
