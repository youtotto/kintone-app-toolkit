// JavaScript解析：REST APIパラメータで外部アプリが明示されたフィールド参照の回帰テスト
//
// 背景（v2.2.3 の修正）:
//   App 1080「電子申告依頼」の saveAfterStamp.js が、App 1112 を REST API で取得・更新している。
//   { app: 1112, fields: [...] } の fields や { app: 1112, record: {...} } のキーは App 1112 側の
//   フィールドだが、文字列だけを見て App 1080 の「存在しない参照」として誤検出されていた。
//
// 検証内容:
//   1. 外部アプリの fields が自アプリの unknown refs に入らない
//   2. 外部アプリの record キーも unknown refs に入らない
//   3. 自アプリの通常のフィールド参照は従来どおり検出される
//   4. app: kintone.app.getId() は自アプリ扱い
//   5. app: 数値リテラル は外部アプリ扱い（EXTERNAL_FIELD として依存データへ）
//   6. app: 未解決変数 は過剰に断定しない
//
// 実行方法:
//   node tests/js-external-app-refs.test.js
//   （終了コード 0 = 成功、1 = 失敗）
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- 実スクリプトを sandbox に読み込み、KTScan / KTDeps を取り出す ----
const SRC_PATH = path.join(__dirname, '..', 'kintoneAppToolkit.user.js');
let code = fs.readFileSync(SRC_PATH, 'utf8');
const lastClose = code.lastIndexOf('})();');
if (lastClose < 0) throw new Error('IIFE close not found');
code = code.slice(0, lastClose) + '\n  globalThis.__TEST__ = { KTScan, KTDeps };\n' + code.slice(lastClose);

const noop = () => { };
const fakeStorage = { getItem: () => null, setItem: noop, removeItem: noop };
const sandbox = {
  console, setTimeout, clearTimeout,
  setInterval: () => 0, clearInterval: noop,
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
const SELF_APP = 1080;
const jsFile = (name, text) => ({ name, target: 'desktop', kind: 'js', text });
const unknownCodes = (files, fields) => KTScan.collectUnknownFieldRefs(files, fields, [], SELF_APP).map(u => u.code);
const candidates = (text) => KTScan.extractFieldCodeCandidates(KTScan.stripCommentsOnly(text), () => 1);

// App 1080 に実在するフィールド（フィクスチャの自アプリ参照に対応）
const FIELDS_1080 = ['レコード番号', 'コダトコード', '得意先名', 'スタンプ画像', '承認者', '進捗メモ', '電子申告依頼日']
  .map(code => ({ code }));

// =========================================================
// フィクスチャ：saveAfterStamp.js 相当（App 1080 → App 1112 を REST API で取得・更新）
// =========================================================
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'saveAfterStamp.js'), 'utf8');
const files = [jsFile('saveAfterStamp.js', FIXTURE)];
const unknown = KTScan.collectUnknownFieldRefs(files, FIELDS_1080, [], SELF_APP);
const unknownList = unknown.map(u => u.code);
const external = KTScan.collectExternalFieldRefs(files, SELF_APP);
const cands = candidates(FIXTURE);
const EXT_CODES = ['電子申告実施日_所得税', '電子申告実施日_消費税', '電子申告実施日_贈与税'];

console.log('\n--- 1. 外部アプリの fields が自アプリの unknown refs に入らない ---');
{
  for (const c of EXT_CODES) assert(!unknownList.includes(c), `「${c}」を App 1080 の存在しない参照として報告しない`);
  const readCands = cands.filter(c => EXT_CODES.includes(c.code) && c.access === 'READ');
  assert(readCands.length === 3 && readCands.every(c => c.appRef && c.appRef.kind === 'literal' && c.appRef.appId === '1112'),
    'fields: [...] の各コードに appRef {kind:literal, appId:1112} と access READ が付く');
}

console.log('\n--- 2. 外部アプリの record キーも unknown refs に入らない ---');
{
  const writeCands = cands.filter(c => EXT_CODES.includes(c.code) && c.access === 'WRITE');
  assert(writeCands.length === 3, `record: {…} の3キーを WRITE 候補として抽出する（実際: ${writeCands.length}）`);
  assert(writeCands.every(c => c.appRef && c.appRef.kind === 'literal' && c.appRef.appId === '1112'),
    'record: {…} のキーに appRef {kind:literal, appId:1112} が付く');
  // 1. と合わせて、READ/WRITE どちらの経路からも unknown refs に混入しないことは 1. で検証済み
  assert(!cands.some(c => c.code === 'id'), 'updateRecord の id キーはフィールド候補にしない');
}

console.log('\n--- 3. 自アプリの通常のフィールド参照は従来どおり検出される ---');
{
  assert(unknownList.includes('旧_承認者'), "record['旧_承認者'] は App 1080 の存在しない参照として検出する");
  const u = unknown.find(x => x.code === '旧_承認者');
  assert(u && u.confidence === 'HIGH', 'record[…] 直接参照は確度HIGHのまま');
  assert(!unknownList.includes('得意先名') && !unknownList.includes('承認者') && !unknownList.includes('スタンプ画像'),
    '実在するフィールドは unknown refs に入らない');
  assert(cands.some(c => c.code === '得意先名' && c.appRef == null), "record['得意先名'] は appRef なし（自アプリの通常参照）");
}

console.log('\n--- 4. app: kintone.app.getId() は自アプリ扱い ---');
{
  const c = cands.find(x => x.code === '旧_進捗メモ');
  assert(c && c.appRef && c.appRef.kind === 'self', 'const appId = kintone.app.getId(); { app: appId } → appRef.kind = self（変数経由でも解決）');
  assert(unknownList.includes('旧_進捗メモ'), '自アプリ宛て REST の fields にある存在しないコードは検出する');
  assert(!external.some(e => e.code === '旧_進捗メモ'), '自アプリ宛ては外部フィールド参照に含めない');
}

console.log('\n--- 5. app: 数値リテラル は外部アプリ扱い ---');
{
  const ext1112 = external.filter(e => e.appId === '1112');
  const reads = ext1112.filter(e => e.access === 'READ').map(e => e.code).sort();
  const writes = ext1112.filter(e => e.access === 'WRITE').map(e => e.code).sort();
  assert(EXT_CODES.every(c => reads.includes(c)), `app 1112 の READ に電子申告実施日_* 3件が含まれる（実際: ${reads.join(', ')}）`);
  assert(JSON.stringify(writes) === JSON.stringify([...EXT_CODES].sort()), `app 1112 の WRITE は電子申告実施日_* 3件（実際: ${writes.join(', ')}）`);
  assert(reads.includes('レコード番号') && reads.includes('コダトコード') && reads.includes('得意先名'),
    'fields に含まれる自アプリと同名のコードも、app 1112 側の参照として扱う');
  assert(ext1112.every(e => e.file === 'saveAfterStamp.js' && e.target === 'desktop' && e.lines.length > 0),
    '外部参照はファイル名・target・行番号を持つ');
}

console.log('\n--- 6. app: 未解決変数 は過剰に断定しない ---');
{
  const c = cands.find(x => x.code === '不明先_項目');
  assert(c && c.appRef && c.appRef.kind === 'unknown', 'const targetAppId = SOME_VARIABLE → appRef.kind = unknown');
  assert(unknownList.includes('不明先_項目'), '外部と断定できないので、従来どおり候補として残す（除外しない）');
  const u = unknown.find(x => x.code === '不明先_項目');
  assert(u && u.confidence !== 'HIGH', `確度は HIGH にしない（実際: ${u && u.confidence}）`);
  assert(!external.some(e => e.code === '不明先_項目'), '外部フィールド参照にも含めない（断定しない）');
}

// =========================================================
// 7. 追加パターン（インライン）
// =========================================================
console.log('\n--- 7. 追加パターン ---');
{
  const text = `
    const p1 = { app: 1080, fields: ['同一ID_項目'] };            // 自アプリと同じIDの数値リテラル
    const p2 = { app: '1112', fields: ['文字列ID_項目'] };         // 文字列のアプリID
    client.record.getRecords(p2);
    const app = 1112;
    client.record.getRecords({ app, fields: ['省略記法_項目'] });  // { app } 省略記法 + 変数解決
    client.record.updateRecords({ app: 1112, records: [{ id: 1, record: { 一括更新_項目: { value: 1 } } }] });
    client.record.addRecords({ app: 1112, records: [{ 一括追加_項目: { value: 1 } }, { updateKey: 1 }] });
    kintone.api(kintone.api.url('/k/v1/record.json', true), 'PUT', { app: Number(kintone.app.getId()), id: 1, record: { 自アプリ更新_項目: { value: 1 } } });
    const targetFields = ['名前ヒューリスティクス_項目'];             // app 文脈のない配列（従来どおり）
    const v = response.records[0]['応答アクセス_項目'].value;      // 応答オブジェクトの添字（現状は候補にしない）
  `;
  const f = [jsFile('inline.js', text)];
  const codes = unknownCodes(f, []);
  const ext = KTScan.collectExternalFieldRefs(f, SELF_APP);
  const cs = candidates(text);

  assert(codes.includes('同一ID_項目') && !ext.some(e => e.code === '同一ID_項目'), 'app: 1080（自アプリと同じID）は自アプリ扱い');
  assert(!codes.includes('文字列ID_項目') && ext.some(e => e.appId === '1112' && e.code === '文字列ID_項目'), "app: '1112'（文字列）も外部扱い");
  assert(!codes.includes('省略記法_項目') && ext.some(e => e.code === '省略記法_項目'), '{ app } 省略記法は const app = 1112 を辿って外部扱い');
  assert(ext.some(e => e.code === '一括更新_項目' && e.access === 'WRITE'), 'updateRecords の records[].record キーを WRITE 外部参照として扱う');
  assert(ext.some(e => e.code === '一括追加_項目' && e.access === 'WRITE'), 'addRecords の records[] 要素キーを WRITE 外部参照として扱う');
  assert(!cs.some(c => c.code === 'updateKey'), 'records[] 要素の updateKey はフィールド候補にしない');
  const selfW = cs.find(c => c.code === '自アプリ更新_項目');
  assert(selfW && selfW.appRef && selfW.appRef.kind === 'self' && selfW.access === 'WRITE', 'Number(kintone.app.getId()) は自アプリ扱い（薄い包みを剥がす）');
  assert(codes.includes('自アプリ更新_項目'), '自アプリ宛て record キーの存在しないコードは検出する');
  assert(codes.includes('名前ヒューリスティクス_項目'), 'app 文脈のない field 名の配列は従来どおり拾う（後退なし）');
  assert(!cs.some(c => c.code === '応答アクセス_項目'), "response.records[0]['…'] は自アプリ参照として拾わない（現状仕様の明示）");
}

// =========================================================
// 8. 依存データへの統合：EXTERNAL_FIELD エッジとして表現される
// =========================================================
console.log('\n--- 8. 依存データへの統合 ---');
{
  const DATA = {
    appId: SELF_APP,
    fields: Object.fromEntries(FIELDS_1080.map(f => [f.code, { type: 'SINGLE_LINE_TEXT', code: f.code, label: f.code }])),
    settings: { name: '電子申告依頼' },
  };
  const deps = KTDeps.buildDependencyData(DATA, KTDeps.normalizeFields(DATA.fields));
  KTDeps.mergeScannerEdges(deps, {
    results: [], appRefs: [{ appId: '1112', file: 'saveAfterStamp.js', target: 'desktop', kind: 'LITERAL', line: 20, raw: 'app: 1112', confidence: 'MEDIUM' }],
    fileEvents: {}, unknownRefs: unknown, unknownStatuses: [], externalRefs: external,
  });
  const extEdges = deps.edges.filter(e => e.sourceType === 'CUSTOMIZE' && e.targetType === 'EXTERNAL_FIELD');
  assert(extEdges.length === 9, `saveAfterStamp.js → EXTERNAL_FIELD のエッジが 9 本（READ 6 + WRITE 3）できる（実際: ${extEdges.length}）`);
  assert(extEdges.every(e => e.context && e.context.appId === '1112' && e.context.settingType === 'JS_EXTERNAL_FIELD'),
    'エッジの context.appId = 1112（グラフでは接続先アプリに畳める形）');
  assert(extEdges.some(e => e.targetId === '1112:電子申告実施日_所得税' && e.relationType === 'JS_READ')
    && extEdges.some(e => e.targetId === '1112:電子申告実施日_所得税' && e.relationType === 'JS_WRITE'),
    '電子申告実施日_所得税 は READ と WRITE の両方のエッジを持つ');
  assert(extEdges.every(e => e.sourceId === 'desktop:js:saveAfterStamp.js'), 'sourceId は既存の CUSTOMIZE ノードIDの形式に一致する');
  assert(deps.nodes.some(n => n.id === 'APP:1112'), 'APP:1112 ノードが存在する');
  assert(!deps.edges.some(e => e.targetType === 'FIELD' && EXT_CODES.includes(e.targetId)),
    '外部フィールドを自アプリの FIELD ノードへのエッジにしない');
  assert(!(deps.meta.unknownJsRefs || []).some(u => EXT_CODES.includes(u.code)),
    'deps.meta.unknownJsRefs（Healthの整合性チェック）に外部フィールドが混入しない');
  // 再スキャン時に重複しない（CUSTOMIZE 由来エッジは入れ替え）
  KTDeps.mergeScannerEdges(deps, { results: [], appRefs: [], fileEvents: {}, unknownRefs: [], unknownStatuses: [], externalRefs: external });
  assert(deps.edges.filter(e => e.sourceType === 'CUSTOMIZE' && e.targetType === 'EXTERNAL_FIELD').length === 9, '再スキャンでエッジが重複しない');
  if (typeof KTDeps.buildSubgraph === 'function') {
    const g = KTDeps.buildSubgraph(deps, { focusId: 'CUSTOMIZE:desktop:js:saveAfterStamp.js', scopes: [], depth: 1, foldExternalFields: true });
    assert(g && g.edges.some(e => e.targetType === 'APP' && String(e.targetId) === '1112'),
      'グラフでは EXTERNAL_FIELD が接続先アプリ（APP:1112）に畳まれる');
  }
}

// =========================================================
// 9. REST API 呼び出しとの関連：渡されていない { app, fields } は依存（EXTERNAL_FIELD）にしない
//   app の値は「どのアプリのフィールドか」の判定に使い（自アプリの存在しない参照にはしない）、
//   呼び出しの引数として渡されているかを「依存の根拠」に使う。
// =========================================================
console.log('\n--- 9. REST API 呼び出しとの関連 ---');
{
  const text = `
    // (1) どこにも渡されていない設定オブジェクト → 外部フィールドとして検出しない
    const unrelatedConfig = {
      app: 1112,
      fields: ['外部項目']
    };

    // (2) 変数に入れてから REST API Client へ渡す → 外部フィールドとして検出する
    const params = {
      app: 1112,
      fields: ['外部項目2']
    };
    client.record.getRecords(params);

    // (3) 引数にオブジェクトリテラルを直接書く
    client.record.getRecords({ app: 1112, fields: ['外部項目3'] });

    // (4) kintone.api の第3引数
    kintone.api(kintone.api.url('/k/v1/records.json', true), 'GET', { app: 1112, fields: ['外部項目4'] });

    // (5) await 付き・メンバー参照で渡す（params.fields のような部分参照は「渡した」とみなさない）
    const q = { app: 1112, fields: ['外部項目5'] };
    const r = await client.record.getRecords(q);
    someHelper(unrelatedConfig.fields);

    // (6) bulkRequest のように入れ子の payload で渡す
    client.bulkRequest({ requests: [{ method: 'GET', api: '/k/v1/records.json', payload: { app: 1112, fields: ['外部項目6'] } }] });

    // (7) コールバックのブロック内で作っただけ（呼び出し引数の一部ではない）
    items.forEach((it) => { const cfg = { app: 1112, fields: ['外部項目7'] }; });

    // (8) 自アプリ向けの設定が渡されていなくても、従来どおり自アプリの候補になる
    const selfCfg = { app: kintone.app.getId(), fields: ['自アプリ未使用_項目'] };
  `;
  const f = [jsFile('rest-linkage.js', text)];
  const codes = unknownCodes(f, []);
  const ext = KTScan.collectExternalFieldRefs(f, SELF_APP);
  const extCodes = ext.map(e => e.code);
  const cs = candidates(text);

  assert(!extCodes.includes('外部項目'), '(1) 渡されていない { app: 1112, fields } は EXTERNAL_FIELD にしない');
  assert(!codes.includes('外部項目'), '(1) 同時に、app: 1112 が明示されているので自アプリの存在しない参照にもしない');
  const c1 = cs.find(c => c.code === '外部項目');
  assert(c1 && c1.appRef && c1.appRef.kind === 'literal' && c1.appRef.restCall === false,
    '(1) 候補には appRef {literal, restCall:false} が付く（未呼出と分かる）');
  assert(extCodes.includes('外部項目2') && !codes.includes('外部項目2'), '(2) 変数経由で client.record.getRecords(params) に渡すと外部フィールドになる');
  assert(ext.find(e => e.code === '外部項目2').via === 'client.record.getRecords', '(2) 呼び出し先（via）を保持する');
  assert(extCodes.includes('外部項目3'), '(3) 引数のオブジェクトリテラルも外部フィールドになる');
  assert(extCodes.includes('外部項目4') && ext.find(e => e.code === '外部項目4').via === 'kintone.api', '(4) kintone.api(url, method, { app, fields }) も対象');
  assert(extCodes.includes('外部項目5'), '(5) await 付きの呼び出しでも変数経由の受け渡しを認識する');
  assert(extCodes.includes('外部項目6') && ext.find(e => e.code === '外部項目6').via === 'client.bulkRequest', '(6) 入れ子の payload（bulkRequest）も呼び出し引数の一部として認識する');
  assert(!extCodes.includes('外部項目7') && !codes.includes('外部項目7'), '(7) ブロック内で作っただけのオブジェクトは依存にも自アプリ参照にもしない');
  assert(codes.includes('自アプリ未使用_項目'), '(8) 自アプリ向け（kintone.app.getId()）は渡されていなくても従来どおり候補に残す');
  assert(!codes.includes('外部項目3') && !codes.includes('外部項目5'), '外部アプリ向けの各コードは自アプリの存在しない参照に混入しない');
}

// =========================================================
// 10. 依存（EXTERNAL_FIELD）にするのは、呼び出し先を kintone REST API と認識できる場合だけ
//   fetchAll(params) / showConfig(params) のような独自関数は、内部で REST API を使うかを
//   静的に追跡できないため、確定した外部フィールド依存にはしない（誤検出の抑制を優先）。
// =========================================================
console.log('\n--- 10. 呼び出し先が kintone REST API と認識できる場合だけ依存にする ---');
{
  const text = `
    const params = { app: 1112, fields: ['外部項目A'] };
    showConfig(params);                                   // REST API と無関係な独自関数

    const p2 = { app: 1112, fields: ['外部項目B'] };
    fetchAll(p2);                                         // 独自ラッパー（内部は追跡できない）

    someFunction({ app: 1112, fields: ['外部項目C'] });     // 引数に直接書いても同じ

    const p3 = { app: 1112, fields: ['外部項目D'] };
    logParams(p3);
    restClient.record.getRecords(p3);                     // 同じ変数が REST API にも渡されていれば依存にする（変数名は client 以外でも可）

    this.client.record.addRecord({ app: 1112, record: { 外部項目E: { value: 1 } } });
    const p4 = { app: 1112, fields: ['外部項目F'] };
    const cursor = await client.record.createCursor(p4);
    client.record.getRecord({ app: 1112, id: 1 });        // fields なし → 候補なし（例外にならない）
  `;
  const f = [jsFile('callee.js', text)];
  const codes = unknownCodes(f, []);
  const ext = KTScan.collectExternalFieldRefs(f, SELF_APP);
  const cs = candidates(text);
  const extCodes = ext.map(e => e.code);

  assert(!['外部項目A', '外部項目B', '外部項目C'].some(c => extCodes.includes(c)),
    '独自関数（showConfig / fetchAll / someFunction）に渡しただけでは EXTERNAL_FIELD にしない');
  assert(!['外部項目A', '外部項目B', '外部項目C'].some(c => codes.includes(c)),
    '同時に app: 1112 が明示されているので、自アプリの存在しない参照にもしない');
  const cA = cs.find(c => c.code === '外部項目A');
  assert(cA && cA.appRef && cA.appRef.restCall === false && cA.appRef.callee === 'showConfig',
    '候補には呼び出し先（showConfig）と restCall:false が記録される（未確定と分かる）');
  assert(extCodes.includes('外部項目D') && ext.find(e => e.code === '外部項目D').via === 'restClient.record.getRecords',
    '独自関数と REST API の両方に渡されていれば REST API 側を根拠に依存にする（restClient.record.* も認識）');
  assert(ext.some(e => e.code === '外部項目E' && e.access === 'WRITE' && e.via === 'this.client.record.addRecord'),
    'this.client.record.addRecord も REST API として認識する');
  assert(ext.some(e => e.code === '外部項目F' && e.via === 'client.record.createCursor'),
    'createCursor（app, fields）も対象');
  assert(['client.record.getRecords', 'client.record.getRecord', 'client.record.updateRecord', 'client.record.updateRecords',
    'client.record.addRecord', 'client.record.addRecords', 'kintone.api', 'client.bulkRequest', 'restClient.record.getAllRecords']
    .every(KTScan.isRestCallee), '認識対象: 指定6メソッド + kintone.api / bulkRequest / getAllRecords');
  assert(!['fetchAll', 'showConfig', 'someFunction', 'kintone.api.url', 'client.record']
    .some(KTScan.isRestCallee), '対象外: 独自関数 / kintone.api.url / メソッド名なし');
}

// =========================================================
// 11. 同一コードの候補が互いに影響しない
//   外部っぽいオブジェクトに同じコードがあっても、別箇所の本物の自アプリ参照が
//   コード単位の重複排除などで消えないこと。
// =========================================================
console.log('\n--- 11. 同一コードの候補が互いに影響しない ---');
{
  const text = `
    const unrelated = {
      app: 1112,
      fields: ['存在しない項目']
    };

    showConfig(unrelated);

    // 本物の自アプリ参照
    record['存在しない項目'];
  `;
  const f = [jsFile('mixed.js', text)];
  const unknownRefs = KTScan.collectUnknownFieldRefs(f, [], [], SELF_APP);
  const ext = KTScan.collectExternalFieldRefs(f, SELF_APP);
  assert(ext.length === 0, 'unrelated からは EXTERNAL_FIELD を作らない');
  const u = unknownRefs.find(x => x.code === '存在しない項目');
  assert(!!u, "record['存在しない項目'] は自アプリの unknown ref として残る");
  assert(u && u.confidence === 'HIGH' && u.count === 1 && u.patterns.length === 1 && /record\[/.test(u.patterns[0]),
    `残る unknown ref は record[…] 由来の1件だけ（外部候補の件数・確度・パターンが混ざらない。実際: count=${u && u.count}, patterns=${u && u.patterns.join('/')}）`);
  assert(u && u.files.length === 1 && u.files[0].lines.length === 1 && u.files[0].lines[0] === 10,
    `行番号も record[…] の1行（10行目）だけ（実際: ${u && JSON.stringify(u.files)}）`);
  // 逆順（先に自アプリ参照、後に外部っぽいオブジェクト）でも同じ
  const f2 = [jsFile('mixed2.js', `record['存在しない項目'];\nconst unrelated = { app: 1112, fields: ['存在しない項目'] };\nshowConfig(unrelated);`)];
  const u2 = KTScan.collectUnknownFieldRefs(f2, [], [], SELF_APP).find(x => x.code === '存在しない項目');
  assert(u2 && u2.count === 1 && u2.confidence === 'HIGH', '出現順が逆でも結果は同じ');
}

console.log(failed ? `\n${failed} test(s) FAILED` : '\nAll tests passed');
process.exit(failed ? 1 : 0);
