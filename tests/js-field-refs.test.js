// JavaScript解析：フィールドコード候補抽出の回帰テスト
//
// 背景（v2.2.1 の修正）:
//   「存在しない参照（フィールドコード・ステータス名）」に、フィールドコードではない文字列
//   （帳票の表示ラベル labels、選択肢値 option）が混入していた。
//   原因は、名前に field を含む変数・キーの配列を見つけると、最初の ']' までにある
//   すべての文字列リテラルを入れ子構造を無視して拾っていたこと。
//
// 検証内容:
//   - 表示ラベル・選択肢値をフィールドコードとして拾わないこと（誤検出の抑制）
//   - 実際にフィールドコードとして使われる文脈は引き続き検出できること（後退防止）
//   - テンプレートリテラルの動的参照を「存在しない静的フィールド」と断定しないこと
//
// 実行方法:
//   node tests/js-field-refs.test.js
//   （終了コード 0 = 成功、1 = 失敗）
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- 実スクリプトを sandbox に読み込み、KTScan を取り出す ----
const SRC_PATH = path.join(__dirname, '..', 'kintoneAppToolkit.user.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
let code = SRC;
const lastClose = code.lastIndexOf('})();');
if (lastClose < 0) throw new Error('IIFE close not found');
code = code.slice(0, lastClose) + '\n  globalThis.__TEST__ = { KTScan };\n' + code.slice(lastClose);

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
const { KTScan } = sandbox.__TEST__;

// ---- テストユーティリティ ----
let failed = 0;
const assert = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) failed++;
};

/** 候補抽出を実行し、静的なコード一覧・動的なコード一覧を返す */
function extract(src) {
  const cands = KTScan.extractFieldCodeCandidates(src, () => 1);
  return {
    all: cands,
    // 「存在しないフィールド」判定に渡るのは動的でない候補のみ（collectUnknownFieldRefs と同じ条件）
    static: [...new Set(cands.filter(c => !c.dynamic).map(c => c.code))],
    dynamic: [...new Set(cands.filter(c => c.dynamic).map(c => c.code))],
  };
}
const has = (r, code) => r.static.includes(code);

// =========================================================
// 1. 誤検出しないケース（今回の修正対象）
// =========================================================
console.log('\n--- 1. 誤検出しないケース ---');
{
  // 選択肢値 option と、実フィールド配列 fields が同じオブジェクトに同居する形
  const r = extract(`
    const config = {
        option: "不動産所得",
        fields: ["不動産所得金額"]
    };

    selectedValues.includes(config.option);
    setFieldsDisabled(record, config.fields, true);
  `);
  assert(!has(r, '不動産所得'), '選択肢値 option の "不動産所得" をフィールド参照として拾わない');
  assert(has(r, '不動産所得金額'), 'fields 配列の "不動産所得金額" はフィールド参照として拾う');
}
{
  // 帳票の表示ラベル labels と、実フィールド moneyFields が同居する形
  const r = extract(`
    pushDetailRows({
        labels: ["不動産所得"],
        moneyFields: ["不動産所得_合計"]
    });

    function pushDetailRows({ record, labels, moneyFields }) {
        const v = getFieldValue(record, moneyFields[index], "0");
    }
  `);
  assert(!has(r, '不動産所得'), '表示ラベル labels の "不動産所得" をフィールド参照として拾わない');
  assert(has(r, '不動産所得_合計'), 'moneyFields 配列の "不動産所得_合計" はフィールド参照として拾う');
  assert(!has(r, '0'), 'getFieldValue の既定値 "0" を第2引数と取り違えない');
}
{
  // 実際の fieldOnOff.js と同型：名前に FIELD を含む配列の中に、入れ子で option と fields がある
  const r = extract(`
    const INCOME_FIELD_GROUPS = [
        {
            option: "不動産所得",
            fields: [
                "不動産所得金額",
                "調整_不動産所得",
                "取得棟数",
            ],
        },
        {
            option: "事業所得",
            fields: ["事業所得金額"],
        },
    ];

    const selectedIncomeTypes = toValueArray(getFieldValue(record, "所得区分", []));
    INCOME_FIELD_GROUPS.forEach((group) => {
        setFieldsDisabled(record, group.fields, !selectedIncomeTypes.includes(group.option));
    });
  `);
  assert(!has(r, '不動産所得'), 'FIELD を含む配列に入れ子の option "不動産所得" を拾わない');
  assert(!has(r, '事業所得'), 'FIELD を含む配列に入れ子の option "事業所得" を拾わない');
  assert(has(r, '不動産所得金額') && has(r, '調整_不動産所得') && has(r, '取得棟数'),
    '入れ子の fields 配列の要素はすべてフィールド参照として拾う');
  assert(has(r, '事業所得金額'), '2つめのグループの fields 要素も拾う（走査位置のずれで取りこぼさない）');
  assert(has(r, '所得区分'), 'getFieldValue(record, "所得区分", []) はフィールド参照として拾う');
}
{
  // 実際の inputCheck.js と同型：field を含む名前の配列の中に labels / moneyFields がある
  const r = extract(`
    const detailFieldSets = [
        {
            labels: ["基本料金", "不動産所得", "事業所得", "消費税"],
            moneyFields: ["基本料金_確定申告", "不動産所得_合計", "事業所得_合計", "消費税_合計"],
        },
    ];
  `);
  assert(!has(r, '不動産所得') && !has(r, '基本料金') && !has(r, '消費税'),
    '入れ子の labels は（外側が field 名の配列でも）フィールド参照として拾わない');
  assert(has(r, '不動産所得_合計') && has(r, '基本料金_確定申告') && has(r, '消費税_合計'),
    '入れ子の moneyFields はフィールド参照として拾う');
}

// =========================================================
// 2. 引き続き検出するケース（後退防止）
// =========================================================
console.log('\n--- 2. 引き続き検出するケース ---');
{
  const r = extract(`const v = getFieldValue(record, "その他加算_株価計算", "");`);
  assert(has(r, 'その他加算_株価計算'), 'getFieldValue(record, "CODE") をフィールド参照として拾う');
  const c = r.all.find(x => x.code === 'その他加算_株価計算');
  assert(c && c.confidence === 'HIGH', 'record を第1引数に渡す呼び出しの第2引数は確度HIGH');
}
{
  const r = extract(`
    const fields = ["FIELD_A", "FIELD_B"];
    setFieldsDisabled(record, fields, true);
  `);
  assert(has(r, 'FIELD_A') && has(r, 'FIELD_B'), '変数経由の配列（field名）の要素をフィールド参照として拾う');
}
{
  const r = extract(`setFieldsDisabled(record, ["FIELD_C", "FIELD_D"], true);`);
  assert(has(r, 'FIELD_C') && has(r, 'FIELD_D'), '配列リテラルを直接渡す形もフィールド参照として拾う');
}
{
  const r = extract(`
    kintone.app.record.setFieldShown("表示制御対象", false);
    const a = record["得意先名"].value;
    const b = record.取引先コード.value;
    setFieldValue(record, "合計金額", 100);
  `);
  assert(has(r, '表示制御対象'), '既存パターン: setFieldShown の第1引数');
  assert(has(r, '得意先名'), "既存パターン: record['CODE']");
  assert(has(r, '取引先コード'), '既存パターン: record.CODE.value');
  assert(has(r, '合計金額'), 'setFieldValue(record, "CODE", v)');
}
{
  // 独自のラッパー関数でも、名前がフィールド操作を示していれば拾う
  const r = extract(`toggleFieldVisibility(event.record, "任意ラッパー_項目");`);
  assert(has(r, '任意ラッパー_項目'), '独自のフィールド操作ラッパー（名前に field を含む）も拾う');
}

// =========================================================
// 2-b. 第1引数が record でも、フィールド操作ではない呼び出しは拾わない
//   「第1引数が record なら第2引数はフィールドコード」という条件だけでは
//   表示・判定用の文字列まで拾ってしまうため、関数名がフィールド操作を
//   示していること（5) の配列名と同じ /field/i）も条件にしている。
// =========================================================
console.log('\n--- 2-b. record 引数だがフィールド操作でない呼び出し ---');
{
  const r = extract(`
    showMessage(record, "不動産所得");
    checkCondition(record, "不動産所得");
    formatLabel(record, "合計金額");
    console.log(record, "デバッグ表示");
    validate(record, ["不動産所得", "事業所得"]);
  `);
  assert(!has(r, '不動産所得'), 'showMessage / checkCondition の第2引数 "不動産所得" を拾わない');
  assert(!has(r, '合計金額'), 'formatLabel(record, "…") の第2引数を拾わない');
  assert(!has(r, 'デバッグ表示'), 'console.log(record, "…") の第2引数を拾わない');
  assert(!has(r, '事業所得'), 'フィールド操作を示さない関数へ渡す配列の要素も拾わない');
  assert(r.static.length === 0, 'フィールド操作でない record 呼び出しからは候補が出ない');
}
{
  // 同じ文字列でも、フィールド操作関数へ渡されていれば拾う（文脈で判定できていることの確認）
  const r = extract(`
    showMessage(record, "不動産所得");
    setFieldsDisabled(record, ["不動産所得金額"], true);
  `);
  assert(!has(r, '不動産所得') && has(r, '不動産所得金額'),
    '同一ファイル内でも、フィールド操作関数へ渡された値だけを拾う');
}

// =========================================================
// 3. 動的参照（テンプレートリテラル）
// =========================================================
console.log('\n--- 3. 動的参照（テンプレートリテラル）---');
{
  const r = extract(`
    for (let index = 1; index <= 5; index += 1) {
        const item = record[\`品目\${index}_株価計算\`];
        const price = record[\`金額\${index}_株価計算\`];
    }
    const other = record[\`その他項目\${index}\`];
  `);
  // 現仕様（修正前）: テンプレート文字列そのものが「存在しない静的フィールド」として検出されていた
  // 修正後の期待動作: 動的参照として印を付け、存在しない静的フィールドとしては報告しない
  assert(r.static.length === 0, '未解決のテンプレートリテラルを「存在しない静的フィールド」として扱わない');
  assert(r.dynamic.includes('品目${index}_株価計算') && r.dynamic.includes('金額${index}_株価計算')
    && r.dynamic.includes('その他項目${index}'),
    '動的参照は dynamic フラグ付きで候補としては保持する（将来の静的展開に備える）');
  // 静的展開（品目1_株価計算 … 品目5_株価計算 への解決）は今回のスコープ外＝別課題
}
{
  // ${...} を含まないテンプレートリテラルは通常の静的コードとして扱う
  const r = extract('const v = record[`得意先名`].value;');
  assert(has(r, '得意先名'), '${...} を含まないテンプレートリテラルは静的なフィールド参照として扱う');
}
{
  // 「存在しないフィールド」の集計側でも動的候補が除外されていること（実装ガードの確認）
  const fn = SRC.slice(SRC.indexOf('function collectUnknownFieldRefs'), SRC.indexOf('function collectUnknownFieldRefs') + 1600);
  assert(/if \(c\.dynamic\) continue;/.test(fn),
    'collectUnknownFieldRefs が dynamic 候補を集計から除外している');
}

// =========================================================
// 4. 既存の除外ルール（誤検出抑制）が維持されていること
// =========================================================
console.log('\n--- 4. 既存の除外ルール ---');
{
  const r = extract(`
    const a = record["これは 空白入り"];
    const b = record["https://example.com/x"];
    const c = record["$id"];
    const d = record["app.record.index.show"];
    const e = record["config.json"];
  `);
  assert(r.static.length === 0, '空白・URL・$id・イベント名・ファイル名は候補にしない');
}

console.log(failed ? `\n${failed} test(s) FAILED` : '\nAll tests passed');
process.exit(failed ? 1 : 0);
