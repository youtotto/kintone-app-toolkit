'use strict';
// modern JavaScript の検査（構文解析・スコープ解析）の共通の例。Gateway の worker/test/fixtures/modern-js-vectors.mjs と同じ内容
//   fixed: 直した宣言（名前:語）/ remaining: 直せなかった宣言（名前:理由）/ parseError: 構文エラー
module.exports = { MODERN_JS_VECTORS: [
 {
  "id": "V1",
  "title": "ハンドラの var は const（再代入するものは let）・再代入しない let は const",
  "code": "(function () {\n  'use strict';\n  kintone.events.on('app.record.create.show', function (event) {\n    var record = event.record;\n    var n = 0;\n    n += 1;\n    let a = 1;\n    let b = 2;\n    b = 3;\n    return event;\n  });\n})();\n",
  "fixed": [
   "record:const",
   "n:let",
   "a:const"
  ],
  "remaining": []
 },
 {
  "id": "V2",
  "title": "コメント・文字列・テンプレート・正規表現の中の var は数えない",
  "code": "(function () {\n  // var x は使わない\n  const s = 'var y';\n  const t = `var ${s}`;\n  const re = /var z/;\n  /* var w */\n  return [s, t, re];\n})();\n",
  "fixed": [],
  "remaining": []
 },
 {
  "id": "V3",
  "title": "ファイル直下の var は直さない（グローバル変数）",
  "code": "var GLOBAL_X = 1;\n(function () {\n  var y = GLOBAL_X;\n  return y;\n})();\n",
  "fixed": [
   "y:const"
  ],
  "remaining": [
   "GLOBAL_X:TOP_LEVEL"
  ]
 },
 {
  "id": "V4",
  "title": "宣言より前の参照・自分の初期値の中の参照は直さない（TDZ）",
  "code": "(function () {\n  console.log(x);\n  var x = 1;\n  var o = o || {};\n})();\n",
  "fixed": [],
  "remaining": [
   "x:USED_BEFORE_DECLARATION",
   "o:USED_BEFORE_DECLARATION"
  ]
 },
 {
  "id": "V5",
  "title": "ブロックの外で使う var は直さない",
  "code": "(function (a) {\n  if (a) {\n    var x = 1;\n  }\n  return x;\n})(true);\n",
  "fixed": [],
  "remaining": [
   "x:USED_OUTSIDE_BLOCK"
  ]
 },
 {
  "id": "V6",
  "title": "for の var: 繰り返しの中だけなら let、後で使うなら直さない",
  "code": "(function () {\n  for (var i = 0; i < 3; i++) {\n    console.log(i);\n  }\n  for (var j = 0; j < 3; j++) {}\n  return j;\n})();\n",
  "fixed": [
   "i:let"
  ],
  "remaining": [
   "j:USED_OUTSIDE_BLOCK"
  ]
 },
 {
  "id": "V7",
  "title": "for...of の var は const",
  "code": "(function (rows) {\n  for (var row of rows) {\n    console.log(row.value);\n  }\n})([]);\n",
  "fixed": [
   "row:const"
  ],
  "remaining": []
 },
 {
  "id": "V8",
  "title": "繰り返しの中で関数から参照する var・初期値の無い var は直さない",
  "code": "(function () {\n  for (var i = 0; i < 3; i++) {\n    setTimeout(function () { console.log(i); });\n  }\n  while (Math.random() > 0.5) {\n    var acc;\n    acc = (acc || 0) + 1;\n  }\n})();\n",
  "fixed": [],
  "remaining": [
   "i:LOOP_CLOSURE",
   "acc:LOOP_NO_INIT"
  ]
 },
 {
  "id": "V9",
  "title": "switch の case・巻き上げる関数からの参照・引数と同じ名前・ブロックの無い if・eval は直さない",
  "code": "(function (p) {\n  switch (p) { case 1: var a = 1; break; }\n  helper();\n  var h = 1;\n  function helper() { return h; }\n  var p = 2;\n  if (p) var q = 1;\n})(1);\n(function () { var e = 1; eval('e'); })();\n",
  "fixed": [],
  "remaining": [
   "a:SWITCH_CASE",
   "h:HOISTED_FUNCTION_REF",
   "p:REDECLARED",
   "q:SINGLE_STATEMENT_CONTEXT",
   "e:DYNAMIC_SCOPE"
  ]
 },
 {
  "id": "V10",
  "title": "分割代入: 全部再代入しなければ const。一部だけ再代入する let はそのまま（違反にしない）",
  "code": "(function (o, arr) {\n  var { a, b } = o;\n  let [c, d] = arr;\n  d = 2;\n  let { e } = o;\n  return [a, b, c, d, e];\n})({}, []);\n",
  "fixed": [
   "a, b:const",
   "e:const"
  ],
  "remaining": []
 },
 {
  "id": "V11",
  "title": "入れ子の関数（宣言の後）から再代入する var は let",
  "code": "(function (rows) {\n  var total = 0;\n  rows.forEach(function (r) { total += r; });\n  return total;\n})([]);\n",
  "fixed": [
   "total:let"
  ],
  "remaining": []
 },
 {
  "id": "V12",
  "title": "構文エラーは検査できない（parseError）",
  "code": "(function () { var = 1; })();\n",
  "parseError": true,
  "fixed": [],
  "remaining": []
 },
 {
  "id": "V13",
  "title": "const に代入する宣言は let に直す（実行すると TypeError）",
  "code": "(function () {\n  const count = 0;\n  count += 1;\n  const done = false;\n  return [count, done];\n})();\n",
  "fixed": [
   "count:let"
  ],
  "remaining": []
 }
] };
