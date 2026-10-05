// 生成コードの modern JavaScript（2026-10-05）: 構文解析・スコープ解析による no-var / prefer-const / const-assign の検査と安全な自動修正（KTModernJs）
//
// 合格条件（以前は var を含む生成コードが「問題なし」で登録できた）:
//   M1 共通の例（tests/fixtures/modern-js-vectors.js）は Gateway（worker/src/v2/toolkit/modern-js.mjs）と同じ結果
//   M2 統合の合成（applyPatchWithRanges）は KTCodeReview.applyPatch と同じ全文。操作の content の区間（後の操作が途中に入ると分かれる）
//   M3 Code Review: 新規・追加・変更した範囲の var は登録できない（具体的な理由）。既存の未変更の var は対象外。コメント・文字列の var は数えない
//   M4 生成の直後の修正（fixGenerated）は、既存の var を書き換えず、追加した var を const / let にして patch の content と anchor に書き戻す
//   M5 構文解析器（acorn）を読み込めないときは検査できない → 登録できない（推測で通さない）
//
// 実行方法: node tests/ai-modern-js.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const T = loadToolkit();
const { KTModernJs, KTCodeReview, KTScan } = T;
const { assert, state } = makeAssert();
const { MODERN_JS_VECTORS } = require('./fixtures/modern-js-vectors.js');

const sorted = (a) => [...a].sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

console.log('\n--- M1 共通の例（Gateway と同じ結果） ---');
assert(KTModernJs && KTModernJs.available(), 'M1: 構文解析器（acorn）を読み込んでいる');
for (const v of MODERN_JS_VECTORS) {
  const r = KTModernJs.fix(v.code);
  const fixed = r.fixed.map(f => `${f.name}:${f.fix.text}`);
  const rem = r.remaining.map(f => `${f.name}:${f.reason}`);
  const again = v.parseError ? null : KTModernJs.analyze(r.code);
  assert(!!r.parseError === !!v.parseError && same(fixed, v.fixed) && same(rem, v.remaining) && (v.parseError || (again.parsed && same(again.findings.map(f => `${f.name}:${f.reason}`), v.remaining))), `M1 ${v.id} ${v.title}: fixed=${JSON.stringify(fixed)} remaining=${JSON.stringify(rem)}`);
}

console.log('\n--- M2 統合の合成（KTCodeReview.applyPatch と同じ全文・content の区間） ---');
{
  const SRC = "(function () {\r\n  'use strict';\r\n  kintone.events.on(['app.record.create.submit'], function (event) {\r\n    var amount = event.record['amount'].value;\r\n    return event;\r\n  });\r\n})();\r\n";
  const patches = [
    { operations: [{ type: 'INSERT_AFTER', anchor: "    var amount = event.record['amount'].value;", content: '    const a = 1;\n' }] },
    { operations: [{ type: 'INSERT_BEFORE', anchor: '    return event;', content: '    const b = 2;' }, { type: 'REPLACE', anchor: "'use strict';", content: "'use strict'; // 厳格" }] },
    { operations: [{ type: 'APPEND', anchor: '', content: '// 末尾' }] },
    { operations: [{ type: 'INSERT_AFTER', anchor: "    var amount = event.record['amount'].value;", content: '    const a = 1;\n    const c = 3;\n' }, { type: 'INSERT_AFTER', anchor: '    const a = 1;', content: '    const b = 2;' }] },
  ];
  for (const [i, p] of patches.entries()) {
    const ref = KTCodeReview.applyPatch(SRC, { baseHash: KTScan.hashText(SRC), ...p });
    const mine = KTModernJs.applyPatchWithRanges(SRC, p);
    assert(ref.ok && mine.ok && ref.text.replace(/\r\n/g, '\n') === mine.normText, `M2-${i + 1}: 合成した全文が KTCodeReview.applyPatch と同じ`);
  }
  const nested = KTModernJs.applyPatchWithRanges(SRC, patches[3]);
  const texts = nested.ranges.map(r => ({ op: r.op, off: r.off, t: nested.normText.slice(r.start, r.end) }));
  assert(texts.some(x => x.op === 0 && x.off === 0 && x.t === '    const a = 1;') && texts.some(x => x.op === 1 && x.off === 0 && x.t === '    const b = 2;') && texts.some(x => x.op === 0 && x.off === '    const a = 1;'.length && x.t === '\n    const c = 3;'),`M2: 後の操作が前の content の途中に入ると、前の区間は 2 つに分かれ、content の位置（off）を持つ: ${JSON.stringify(texts)}`);
}

console.log('\n--- M3 Code Review（新規・追加・変更した範囲だけ。登録できない理由） ---');
const CUST = { customizationId: 'C1', requirement: '金額が100万円を超えたら警告', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.create.change.amount', 'app.record.edit.change.amount'], fields: [{ code: 'amount', access: 'CONTROL', condition: '' }], apis: [], existingFiles: [] };
const DATA = { appId: '353', fields: { amount: { code: 'amount', label: '金額', type: 'NUMBER' } }, layout: [] };
const NEW = (decl) => `(function () {\n  'use strict';\n  kintone.events.on(['app.record.create.change.amount', 'app.record.edit.change.amount'], function (event) {\n    // var はコメントの中なら数えない\n    ${decl} v = Number(event.record['amount'].value || 0);\n    event.record['amount'].error = v > 1000000 ? 'var の文字は文字列なら数えない' : null;\n    return event;\n  });\n})();\n`;
const gen = (code) => ({ strategy: 'NEW_JS_FILE', targetFile: 'amount-warning.js', code, patch: null, events: CUST.events, fields: [{ code: 'amount', access: 'CONTROL' }], apis: [] });
const mj = (r) => r.checks.filter(c => c.name === 'modern-js');
{
  const ok = KTCodeReview.review({ generated: gen(NEW('const')), customization: CUST, data: DATA });
  assert(mj(ok).length === 1 && mj(ok)[0].ok && ok.status !== 'BLOCKED', `M3: const だけ・コメントと文字列の var は数えない → 通過: ${JSON.stringify(mj(ok))}`);
  const bad = KTCodeReview.review({ generated: gen(NEW('var')), customization: CUST, data: DATA });
  assert(bad.status === 'BLOCKED' && bad.registration.verdict === 'BLOCKED' && mj(bad).some(c => !c.ok && /5 行目「var v = Number/.test(c.message) && /const に直せます/.test(c.message)), `M3: 直していない新しい var → 登録できない（行・文・直し方）: ${JSON.stringify(mj(bad).map(c => c.message))}`);
  const top = KTCodeReview.review({ generated: gen(`var LIMIT = 1000000;\n${NEW('const')}`), customization: CUST, data: DATA });
  assert(top.status === 'BLOCKED' && mj(top).some(c => !c.ok && /var LIMIT — 自動で直せません（関数の外/.test(c.message)), `M3: 直せない var → 登録できない（具体的な理由）: ${JSON.stringify(mj(top).map(c => c.message))}`);
  // 既存ファイルへの統合: 既存の var は対象外・追加した var だけを見る
  const SRC = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.create.change.amount', 'app.record.edit.change.amount'], function (event) {\n    var amount = event.record['amount'].value;\n    return event;\n  });\n})();\n";
  const ext = (decl) => ({ strategy: 'EXTEND_EXISTING_JS', targetFile: 'dealValidate.js', code: `    ${decl} limit = 1000000;\n`, patch: { baseHash: KTScan.hashText(SRC), operations: [{ type: 'INSERT_AFTER', anchor: "    var amount = event.record['amount'].value;", content: `    ${decl} limit = 1000000;\n    event.record['amount'].error = Number(amount) > limit ? '注意' : null;\n` }] }, events: CUST.events, fields: [{ code: 'amount', access: 'CONTROL' }], apis: [] });
  const custE = { ...CUST, strategy: 'EXTEND_EXISTING_JS', existingFiles: [{ name: 'dealValidate.js', target: 'desktop' }] };
  const src = { name: 'dealValidate.js', target: 'desktop', text: SRC };
  const keep = KTCodeReview.review({ generated: ext('const'), customization: custE, data: DATA, existingSource: src });
  assert(mj(keep).length === 1 && mj(keep)[0].ok, `M3: 既存ファイルの var（変更していない行）は対象外: ${JSON.stringify(mj(keep))}`);
  const addVar = KTCodeReview.review({ generated: ext('var'), customization: custE, data: DATA, existingSource: src });
  assert(addVar.status === 'BLOCKED' && mj(addVar).filter(c => !c.ok).length === 1 && /var limit/.test(mj(addVar).find(c => !c.ok).message), `M3: 追加した var だけを数える（既存の var amount は数えない）: ${JSON.stringify(mj(addVar).map(c => c.message))}`);
  // M4 生成の直後の修正
  const f = KTModernJs.fixGenerated({ generated: ext('var'), existingSource: src });
  assert(f.status === 'fixed' && /^    const limit = 1000000;/.test(f.generated.patch.operations[0].content) && f.generated.code === '    const limit = 1000000;\n' && f.generated.patch.operations[0].anchor === "    var amount = event.record['amount'].value;", `M4: 追加した var だけ const にして content と表示用の code に書き戻す（anchor の既存の var はそのまま）: ${JSON.stringify(f.generated.patch.operations[0])}`);
  const after = KTCodeReview.review({ generated: f.generated, customization: custE, data: DATA, existingSource: src });
  assert(after.status !== 'BLOCKED' && mj(after)[0].ok && /var amount = event\.record\['amount'\]\.value;/.test(after.finalCode), `M4: 直した後は全部の検査を通り、登録する全文に既存の var はそのまま: ${after.status}`);
  const fNew = KTModernJs.fixGenerated({ generated: gen(NEW('var')) });
  assert(fNew.status === 'fixed' && /    const v = Number/.test(fNew.generated.code), 'M4: 新規ファイルの var も直す');
  const fTop = KTModernJs.fixGenerated({ generated: gen(`var LIMIT = 1000000;\n${NEW('var')}`) });
  assert(fTop.status === 'failed' && fTop.remaining.length === 1 && fTop.remaining[0].reason === 'TOP_LEVEL' && /    const v = Number/.test(fTop.generated.code), 'M4: 直せる箇所は直し、直せない箇所（ファイル直下）は残す（Code Review が登録できないと判定）');
  // Gateway が直した記録は、検査の結果に添える
  const gw = KTCodeReview.review({ generated: { ...gen(NEW('const')), gatewayChecks: { modernJs: { status: 'fixed', fixed: [{ line: 5, rule: 'no-var', name: 'v', to: 'const' }] } } }, customization: CUST, data: DATA });
  assert(/生成の後に 1 か所を const \/ let に直しました/.test(mj(gw)[0].message), `M4: Gateway が直した箇所の数を検査の結果に出す: ${mj(gw)[0].message}`);
}

console.log('\n--- M5 構文解析器を読み込めないとき ---');
{
  const T2 = loadToolkit({ acorn: false });
  assert(!T2.KTModernJs.available(), 'M5: acorn が無い状態');
  const r = T2.KTCodeReview.review({ generated: gen(NEW('const')), customization: CUST, data: DATA });
  assert(r.status === 'BLOCKED' && r.checks.some(c => c.name === 'modern-js' && !c.ok && /構文解析器（acorn）を読み込めないため/.test(c.message)), 'M5: 検査できないので登録できない（推測で通さない）');
  const f = T2.KTModernJs.fixGenerated({ generated: gen(NEW('var')) });
  assert(f.status === 'unchecked' && f.generated.code === NEW('var'), 'M5: 直さずにそのまま返す（Code Review が止める）');
}

console.log('\n--- M6 kintone のページ（AMD の define がある）・差分レビューの指摘 ---');
{
  // kintone のページには define.amd がある（実機で確認）。同梱の acorn は define に登録されず、Toolkit の中で使える
  const T3 = loadToolkit({ pageDefine: true });
  assert(T3.KTModernJs.available() && T3.KTModernJs.analyze('(function () { const a = 1; return a; })();').parsed, 'M6: ページに AMD の define があっても、同梱の acorn で検査できる（以前の @require の UMD 版は define に登録され、グローバルに出なかった）');
  // REPLACE: anchor の行をそのまま残した行（既存の var）は変更していない行。足した行だけを直す
  const SRC = "(function () {\n  kintone.events.on('app.record.create.submit', function (event) {\n    var amount = event.record['amount'].value;\n    if (!amount) { event.record['amount'].error = '必須'; }\n    return event;\n  });\n})();\n";
  const anchor = "    var amount = event.record['amount'].value;\n    if (!amount) { event.record['amount'].error = '必須'; }";
  const content = "    var amount = event.record['amount'].value;\n    var limit = 1000000;\n    if (!amount) { event.record['amount'].error = '必須'; }";
  const g = { strategy: 'EXTEND_EXISTING_JS', targetFile: 'dealValidate.js', code: '    var limit = 1000000;\n', patch: { baseHash: KTScan.hashText(SRC), operations: [{ type: 'REPLACE', anchor, content }] }, events: [], fields: [], apis: [] };
  const f = KTModernJs.fixGenerated({ generated: g, existingSource: { name: 'dealValidate.js', target: 'desktop', text: SRC } });
  assert(f.status === 'fixed' && f.fixed.map(x => x.name).join() === 'limit' && f.generated.patch.operations[0].content.startsWith("    var amount = event.record['amount'].value;\n    const limit = 1000000;") && f.generated.code === '    const limit = 1000000;\n', `M6: REPLACE で残した既存の var は直さず、足した var だけを直す（表示用の code も同じ）: ${JSON.stringify(f.fixed.map(x => x.name))}`);
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
