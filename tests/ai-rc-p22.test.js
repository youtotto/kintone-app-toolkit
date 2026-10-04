// Phase 22（AI 開発支援の残課題修正と RC 準備）の回帰テスト
//
// 検証内容:
//   F-F2-1 条件つきロックの誤判定: 既存の条件つきの編集不可（承認済みのとき）を「条件なしに編集不可」と扱わない。
//          条件なし（E）と条件つき（D）を区別し、条件とロックの関係を保ったまま判定する
//   F-F2-2 変数経由のフィールド参照: const field = record['金額']; の field.disabled / field.error / field.value を、
//          直接（record.金額）・ブラケット（record['金額']）と同じに数える（入力チェック・エラー表示・編集不可・値の参照・条件つきの処理）
//
// 実行方法: node tests/ai-rc-p22.test.js（KT_SRC=<別ビルド> で修正前の版に対して走らせると RED になる）
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { KTDeps, KTScan, KTCodeReview } = loadToolkit();
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const R = require('./fixtures/p21-bfc-replay.js');

const clean = (t) => KTScan.stripCommentsOnly(t);
// 修正前の版（KT_SRC）には無い関数を呼んでも落ちない（失敗として数える）
const safe = (fn, fallback = null) => { try { return fn(); } catch (e) { return fallback; } };
const ops = (text) => safe(() => KTCodeReview.fieldOperations(clean(text)), []);
const checksOf = (text) => safe(() => KTCodeReview.inputChecks(clean(text)), []);
const locks = (text, code) => safe(() => KTCodeReview.disableSites(clean(text), code), []);
const writes = (text) => safe(() => KTCodeReview.writeTargets(clean(text)), new Map());
const handler = (events, body) => `(function () {\n  'use strict';\n  kintone.events.on(${JSON.stringify(events).replace(/"/g, "'")}, function (event) {\n    var record = event.record;\n${body}\n    return event;\n  });\n})();`;
const EDIT = ['app.record.edit.show'];
const SUBMIT = ['app.record.create.submit', 'app.record.edit.submit'];

// =========================================================
console.log('\n--- F-F2 ロック判定 1〜8: 直接・ブラケット・変数経由・条件つき（if / else / && / || / 入れ子）・条件なし ---');
{
  // 1. 条件なしの disabled（E）
  const e1 = locks(handler(EDIT, "    record['金額'].disabled = true;"), '金額');
  assert(e1.length === 1 && e1[0].unconditional === true && e1[0].conds.length === 0, `1. 条件なしの disabled → 条件なし（unconditional）: ${JSON.stringify(e1.map(x => [x.unconditional, x.conds]))}`);
  // 2. if の中の disabled（D）
  const e2 = locks(handler(EDIT, "    if (record['ステータス'].value === '承認済み') {\n      record['金額'].disabled = true;\n    }"), '金額');
  assert(e2.length === 1 && e2[0].unconditional === false && /ステータス/.test(e2[0].conds[0]) && /承認済み/.test(e2[0].conds[0]), `2. if の中の disabled → 条件つき（囲む条件を保つ）: ${JSON.stringify(e2.map(x => x.conds))}`);
  // 3. else の中の disabled
  const e3 = locks(handler(EDIT, "    if (record['ステータス'].value !== '承認済み') {\n      record['金額'].disabled = false;\n    } else {\n      record['金額'].disabled = true;\n    }"), '金額');
  assert(e3.length === 1 && e3[0].unconditional === false && /^else of \(record\['ステータス'\]\.value !== '承認済み'\)/.test(e3[0].conds[0]), `3. else の中の disabled → 対応する if の条件つき（else of …）: ${JSON.stringify(e3.map(x => x.conds))}`);
  // 4. 複数条件（&& / ||）
  const e4a = locks(handler(EDIT, "    if (record['ステータス'].value === '承認済み' && Number(record['金額'].value) > 0) {\n      record['金額'].disabled = true;\n    }"), '金額');
  const e4b = locks(handler(EDIT, "    if (record['ステータス'].value === '承認済み' || record['ステータス'].value === '完了') {\n      record['金額'].disabled = true;\n    }"), '金額');
  assert(e4a.length === 1 && !e4a[0].unconditional && /&&/.test(e4a[0].conds[0]) && e4b.length === 1 && !e4b[0].unconditional && /\|\|/.test(e4b[0].conds[0]), `4. 複数条件（&& / ||）→ 条件全体を保つ: ${JSON.stringify([e4a[0] && e4a[0].conds, e4b[0] && e4b[0].conds])}`);
  // 5. 入れ子の if
  const e5 = locks(handler(EDIT, "    if (record['ステータス'].value === '承認済み') {\n      if (Number(record['金額'].value) >= 1000000) {\n        record['金額'].disabled = true;\n      }\n    }"), '金額');
  assert(e5.length === 1 && e5[0].conds.length === 2 && /ステータス/.test(e5[0].conds[0]) && /1000000/.test(e5[0].conds[1]), `5. 入れ子の if → 外側と内側の条件の両方: ${JSON.stringify(e5.map(x => x.conds))}`);
  // 6. ブラケット記法（B）と直接のドット記法（A。日本語のコードも）
  const e6b = locks(handler(EDIT, "    record['金額'].disabled = true;"), '金額');
  const e6a = locks(handler(EDIT, "    record.金額.disabled = true;"), '金額');
  const e6e = locks("(function () {\n  kintone.events.on('app.record.edit.show', function (event) {\n    event.record.金額.disabled = true;\n    return event;\n  });\n})();", '金額');
  assert(e6b.length === 1 && e6b[0].via === 'bracket' && e6a.length === 1 && e6a[0].via === 'dot' && e6e.length === 1 && e6e[0].via === 'dot', `6. ブラケット記法・ドット記法（record.金額 / event.record.金額）を数える: ${JSON.stringify([e6b, e6a, e6e].map(l => l.map(x => x.via)))}`);
  // 7. 変数経由（C）
  const e7 = locks(handler(EDIT, "    const field = record.金額;\n    if (record['ステータス'].value === '承認済み') {\n      field.disabled = true;\n    }"), '金額');
  const e7b = locks(handler(EDIT, "    var f = event.record['金額'];\n    f.disabled = true;"), '金額');
  assert(e7.length === 1 && e7[0].via === 'alias' && e7[0].alias === 'field' && !e7[0].unconditional && e7b.length === 1 && e7b[0].via === 'alias' && e7b[0].unconditional, `7. 変数に入れたフィールドの disabled を数える（条件つき / 条件なしも区別）: ${JSON.stringify([e7, e7b].map(l => l.map(x => [x.via, x.unconditional])))}`);
  // 8. 別フィールドの変数との混同が起きない（別の handler の同じ名前・同じ handler の別の変数）
  const two = "(function () {\n  'use strict';\n  kintone.events.on('app.record.edit.show', function (event) {\n    const field = event.record['金額'];\n    if (event.record['ステータス'].value === '承認済み') {\n      field.disabled = true;\n    }\n    return event;\n  });\n  kintone.events.on('app.record.create.show', function (event) {\n    const field = event.record['備考'];\n    field.disabled = true;\n    return event;\n  });\n})();";
  const amt = locks(two, '金額'), memo = locks(two, '備考');
  assert(amt.length === 1 && !amt[0].unconditional && memo.length === 1 && memo[0].unconditional, `8a. 別の handler の同じ名前の変数（field）を取り違えない（金額は条件つき・備考は条件なし）: ${JSON.stringify([amt.map(x => x.unconditional), memo.map(x => x.unconditional)])}`);
  const same = handler(EDIT, "    var a = record['金額'];\n    var b = record['備考'];\n    b.disabled = true;");
  assert(locks(same, '金額').length === 0 && locks(same, '備考').length === 1, '8b. 同じ handler の別の変数（a = 金額 / b = 備考）: b.disabled は備考だけ');
}

// =========================================================
console.log('\n--- F-F2 入力チェック 9〜15: 直接・変数経由の .value の判定、field.error / event.error、保存時・値の変更時、複数のフィールド ---');
{
  // 9. record.xxx.value を直接判定
  const c9 = checksOf(handler(SUBMIT, "    if (!record['金額'].value) {\n      record['金額'].error = '金額を入力してください';\n    }"));
  assert(c9.length === 1 && c9[0].target === '金額' && c9[0].checks.includes('金額') && c9[0].kind === 'field-error', `9. record['金額'].value を直接判定するエラー表示 → 金額の入力チェック: ${JSON.stringify(c9)}`);
  // 10. 変数経由で .value を判定（field.error）
  const c10 = checksOf(handler(EDIT.concat(['app.record.edit.change.金額']), "    const field = record['金額'];\n    if (field.value > 1000000) {\n      field.error = '100万円を超えています';\n    } else {\n      field.error = null;\n    }"));
  assert(c10.length === 1 && c10[0].target === '金額' && c10[0].via === 'alias' && c10[0].checks.includes('金額'), `10. 変数に入れたフィールドの .value を判定 → 金額の入力チェック（error = null の解除は数えない）: ${JSON.stringify(c10)}`);
  // 11. event.error（レコード全体のエラー）
  const c11 = checksOf(handler(SUBMIT, "    const amountField = record.金額;\n    if (!amountField.value) {\n      event.error = '金額を入力してください';\n    }"));
  assert(c11.length === 1 && c11[0].kind === 'event-error' && c11[0].target === null && c11[0].checks.includes('金額'), `11. event.error（条件で金額を読む）→ 金額の入力チェック: ${JSON.stringify(c11)}`);
  // 12. field.error（括弧なしの if）
  const c12 = checksOf(handler(SUBMIT, "    var f = event.record['備考'];\n    if (f.value && f.value.length > 100) f.error = '100 文字までです';"));
  assert(c12.length === 1 && c12[0].target === '備考' && c12[0].kind === 'field-error' && c12[0].checks.includes('備考'), `12. 変数の field.error（括弧なしの if）→ 備考の入力チェック: ${JSON.stringify(c12)}`);
  // 13. 保存イベントの中
  assert(c9[0] && c9[0].events.includes('app.record.create.submit') && c9[0].events.includes('app.record.edit.submit') && c11[0] && c11[0].events.includes('app.record.edit.submit'), '13. 保存時（submit）のイベントの中の入力チェック（イベントを添える）');
  // 14. 値の変更イベントの中（三項演算子の右辺で値を読む）
  const c14 = checksOf("(function () {\n  kintone.events.on(['app.record.edit.change.金額', 'app.record.create.change.金額'], function (event) {\n    const field = event.record['金額'];\n    field.error = Number(field.value) > 1000000 ? '100万円を超えています' : null;\n    return event;\n  });\n})();");
  assert(c14.length === 1 && c14[0].target === '金額' && c14[0].checks.includes('金額') && c14[0].events.includes('app.record.edit.change.金額'), `14. 値の変更時（change）のイベント・右辺で値を読むエラー表示 → 入力チェック: ${JSON.stringify(c14)}`);
  // 15. 同じファイルの複数のフィールド
  const c15 = checksOf(handler(SUBMIT, "    const amount = record['金額'];\n    const memo = record.備考;\n    if (!amount.value) amount.error = '金額を入力してください';\n    if (memo.value && memo.value.length > 100) memo.error = '100 文字までです';"));
  const byTarget = Object.fromEntries(c15.map(x => [x.target, x.checks]));
  assert(c15.length === 2 && byTarget['金額'] && byTarget['金額'].includes('金額') && !byTarget['金額'].includes('備考') && byTarget['備考'] && byTarget['備考'].includes('備考') && !byTarget['備考'].includes('金額'), `15. 同じファイルの 2 つのフィールドの入力チェックを取り違えない: ${JSON.stringify(c15)}`);
}

// =========================================================
console.log('\n--- F-F2 誤検知の防止 16〜18: 値を読むだけ・コメント・別の変数への代入 ---');
{
  // 16. 値を読むだけ（入力チェックではない）
  const t16 = handler(SUBMIT, "    var v = record['金額'].value;\n    console.log(v);\n    var total = Number(record.金額.value) * 2;\n    if (total > 0) console.log(total);");
  const o16 = ops(t16);
  assert(checksOf(t16).length === 0 && o16.length >= 2 && o16.every(o => o.op === 'read' && o.code === '金額'), `16. 値を読むだけのコードを入力チェック扱いしない（操作は値の参照だけ）: ${JSON.stringify(o16.map(o => [o.op, o.code]))}`);
  // 17. コメントの中の文字列は解析しない
  const t17 = handler(EDIT, "    // record['金額'].disabled = true;\n    /* const f = record['金額'];\n       f.error = '金額を入力してください'; */\n    console.log('done');");
  assert(locks(t17, '金額').length === 0 && checksOf(t17).length === 0 && writes(t17).size === 0 && ops(t17).length === 0, '17. コメントの中のロック・エラー表示を数えない');
  // 18. 別の変数への代入をフィールドとして追わない
  const t18a = handler(EDIT, "    const field = record['金額'];\n    const v = field.value;\n    v.disabled = true;");
  const t18b = handler(EDIT, "    let f = record['金額'];\n    f = {};\n    f.disabled = true;");
  const t18c = handler(EDIT, "    const field = record['金額'];\n    [1, 2].forEach(function (field) {\n      field.disabled = true;\n    });");
  const t18d = handler(EDIT, "    const field = record['金額'];\n    const t = field.type;\n    t.error = 'x';");
  const t18e = handler(EDIT, "    let f = record['金額'];\n    f = record['備考'];\n    f.disabled = true;");
  assert(locks(t18a, '金額').length === 0 && !writes(t18a).has('金額'), '18a. 値のコピー（const v = field.value）の v.disabled は金額のロックではない');
  assert(locks(t18b, '金額').length === 0, '18b. 別の値を代入した後（f = {}）の f.disabled は金額のロックではない');
  assert(locks(t18c, '金額').length === 0, '18c. 同じ名前の引数（forEach の function (field)）は別の変数');
  assert(!writes(t18d).has('金額') && checksOf(t18d).length === 0, '18d. 別のプロパティ（field.type）を入れた変数は追わない');
  assert(locks(t18e, '金額').length === 0 && locks(t18e, '備考').length === 1, '18e. 別のフィールドを代入し直した後は、そのフィールド（備考）として数える');
}

// =========================================================
console.log('\n--- F-F2 Code Review: 条件なし（E）と条件つき（D）を同じに扱わない・既存のコードと新しいコードを分ける ---');
const DATA = (() => {
  const d = FX.makeData();
  d.fields['金額'] = { type: 'NUMBER', code: '金額', label: '金額', noLabel: false, required: false };
  d.fields['備考'] = { type: 'MULTI_LINE_TEXT', code: '備考', label: '備考', noLabel: false, required: false };
  d.fields['ステータス'] = { type: 'STATUS', code: 'ステータス', label: 'ステータス', enabled: true };
  return d;
})();
const cust = (o = {}) => ({ customizationId: 'C1', requirement: '承認済みでは金額を編集不可にする', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events: EDIT, fields: [{ code: '金額', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }], apis: [], existingFiles: [], ...o });
const gen = (code, o = {}) => ({ strategy: 'NEW_JS_FILE', targetFile: 'lock.js', summary: 's', code, patch: null, events: [], fields: [], apis: [], ...o });
const review = (code, c = cust(), g = {}, existing = null) => KTCodeReview.review({ generated: gen(code, g), customization: c, plan: null, data: DATA, scan: null, existingSource: existing });
const cc = (rv) => (rv.checks || []).filter(x => x.name === 'conditional-control');
{
  // 新しいコード: 条件なし（E）→ 登録不可 / 計画の条件の中（D）→ 通過 / 別の条件の中 → 計画の条件を見ていないので登録不可
  const E = review(handler(EDIT, "    record['金額'].disabled = true;"));
  const D = review(handler(EDIT, "    if (record['ステータス'].value === '承認済み') {\n      record['金額'].disabled = true;\n    }"));
  const DO = review(handler(EDIT, "    if (record['備考'].value) {\n      record['金額'].disabled = true;\n    }"));
  assert(E.registration.verdict === 'BLOCKED' && cc(E).some(x => x.severity === 'block' && /条件の外/.test(x.message)), `E（条件なし）の新しいロック → 登録不可: ${E.registration.verdict}`);
  assert(D.registration.verdict === 'RUNTIME_UNVERIFIED' && cc(D).every(x => x.ok), `D（計画の条件の中）の新しいロック → 通過: ${D.registration.verdict} ${JSON.stringify(cc(D).map(x => x.message))}`);
  assert(DO.registration.verdict === 'BLOCKED' && cc(DO).some(x => x.severity === 'block' && /備考/.test(x.message) && /見ていません/.test(x.message)), `別の条件（備考）の中の新しいロック → 計画の条件（ステータス）を見ていないので登録不可: ${JSON.stringify(cc(DO).map(x => x.message))}`);
  // 変数経由の条件の外のロック（修正前は数えず「見つかりません」の確認止まり）→ 登録不可
  const AE = review(handler(EDIT, "    const field = record['金額'];\n    if (record['ステータス'].value === '承認済み') {\n      console.log('approved');\n    }\n    field.disabled = true;"));
  assert(AE.registration.verdict === 'BLOCKED' && cc(AE).some(x => x.severity === 'block' && /field\.disabled = true/.test(x.message)), `変数経由の条件の外のロック → 登録不可（本当に危険なコードは止める）: ${JSON.stringify(cc(AE).map(x => [x.severity, x.message]))}`);
  const AD = review(handler(EDIT, "    const field = record['金額'];\n    if (record['ステータス'].value === '承認済み') {\n      field.disabled = true;\n    }"));
  assert(AD.registration.verdict === 'RUNTIME_UNVERIFIED' && cc(AD).every(x => x.ok), `変数経由の条件の中のロック → 通過: ${AD.registration.verdict}`);
}
{
  // 既存のコード（統合先）にあるロック: 条件なし（E）と別の条件の中（D）を分ける
  const BASE_E = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    var record = event.record;\n    record['金額'].disabled = true;\n    return event;\n  });\n})();\n";
  const BASE_D = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    var record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['金額'].disabled = true;\n    }\n    return event;\n  });\n})();\n";
  const warn = "  kintone.events.on(['app.record.edit.show', 'app.record.edit.change.金額'], function (event) {\n    var amount = event.record['金額'];\n    if (Number(amount.value) > 1000000 && !amount.disabled) {\n      amount.error = '金額が1,000,000円を超えています。';\n    } else {\n      amount.error = null;\n    }\n    return event;\n  });\n";
  const warnCust = cust({ requirement: '金額が100万円を超えたら警告する', strategy: 'EXTEND_EXISTING_JS', events: ['app.record.edit.show', 'app.record.edit.change.金額'], fields: [{ code: '金額', access: 'CONTROL', condition: '金額 >= "1000000" and 金額 != "1000000"' }], existingFiles: [{ name: 'lock.js', target: 'desktop' }] });
  const ext = (base, content, c) => KTCodeReview.review({ generated: gen(content, { strategy: 'EXTEND_EXISTING_JS', targetFile: 'lock.js', patch: { baseHash: KTScan.hashText(base), operations: [{ type: 'INSERT_BEFORE', anchor: '})();', content }] } }), customization: c, plan: null, data: DATA, scan: null, existingSource: { name: 'lock.js', target: 'desktop', text: base } });
  const rD = ext(BASE_D, warn, warnCust);
  const mD = cc(rD).map(x => x.message).join(' / ');
  assert(cc(rD).length === 1 && cc(rD)[0].ok && /入力チェック/.test(mD) && /別の条件の制御/.test(mD) && !/条件なし/.test(mD) && !rD.registration.confirmations.some(x => x.code === 'conditional-control'), `既存の条件つきロック（D: 承認済みのとき）＋ 新しい入力チェック → 「条件なし」と言わず確認にもしない: ${mD}`);
  const rE = ext(BASE_E, warn, warnCust);
  const xE = cc(rE)[0] || {};
  assert(!xE.ok && xE.severity === 'review' && /既存のコードで条件なしに編集不可/.test(xE.message || ''), `既存の条件なしロック（E）＋ 新しい入力チェック → 「条件なし」の確認は残す（E は本当に条件なし）: ${xE.message}`);
  // 既存の別の条件のロック ＋ 新しいロック（計画の条件の中）= 同じ種類の制御が両方効く → 確認（「条件なし」とは言わない）
  const lockCust = cust({ requirement: '金額が100万円以上なら金額を編集不可にする', strategy: 'EXTEND_EXISTING_JS', fields: [{ code: '金額', access: 'CONTROL', condition: '金額 >= "1000000"' }], existingFiles: [{ name: 'lock.js', target: 'desktop' }] });
  const both = ext(BASE_D, "  kintone.events.on(['app.record.edit.show'], function (event) {\n    if (Number(event.record['金額'].value) >= 1000000) {\n      event.record['金額'].disabled = true;\n    }\n    return event;\n  });\n", lockCust);
  const xB = cc(both)[0] || {};
  assert(!xB.ok && xB.severity === 'review' && /別の条件「record\['ステータス'\] && record\['ステータス'\]\.value === '承認済み'」のときにも編集不可/.test(xB.message || '') && !/条件なし/.test(xB.message || ''), `既存の別の条件のロック ＋ 新しいロック → 「別の条件のときにも編集不可」の確認（条件なしとは言わない）: ${xB.message}`);
}

// =========================================================
console.log('\n--- F-F2 実機の再生（Phase 21 BF-C）: 実際の生成コード・既存の dealLock.js / dealValidate.js ---');
{
  const data = FX.makeData();
  data.fields = JSON.parse(JSON.stringify(R.FIELDS));
  data.customize = { scope: 'ALL', desktop: { js: [{ type: 'FILE', file: { contentType: 'text/javascript', fileKey: 'pv:lock', name: 'dealLock.js', size: '422' } }, { type: 'FILE', file: { contentType: 'text/javascript', fileKey: 'pv:validate', name: 'dealValidate.js', size: '542' } }], css: [] }, mobile: { js: [], css: [] }, revision: '55' };
  const fieldsN = KTDeps.normalizeFields(data.fields);
  const files = [{ name: 'dealLock.js', target: 'desktop', kind: 'js', text: R.DEAL_LOCK }, { name: 'dealValidate.js', target: 'desktop', kind: 'js', text: R.DEAL_VALIDATE }];
  // 実機の Field Scanner と同じ解析（KTScan.buildPayload）で作る（テスト用の簡易版 buildScanPayload は .error = を CONTROL と数えない）
  const scan = KTScan.buildPayload({ appId: 353, files, fields: fieldsN.map(f => ({ code: f.code, label: f.label, type: f.rawType })), deps: KTDeps.buildDependencyData(data, fieldsN), scannedAt: '2026-10-04T00:16:00.000Z' });
  const rv = KTCodeReview.review({ generated: R.GENERATED, customization: R.CUSTOMIZATION, plan: null, data, scan, existingSource: { name: 'dealLock.js', target: 'desktop', text: R.DEAL_LOCK } });
  const c = cc(rv)[0] || {};
  const codes = rv.registration.confirmations.map(x => x.code);
  assert(R.P21_CONFIRMATIONS.length === 4 && R.P21_CONFIRMATIONS.includes('conditional-control'), '前提: Phase 21 の判定は確認 4 件（conditional-control を含む）');
  assert(c.ok === true && /入力チェック（エラー表示）/.test(c.message) && /承認済み/.test(c.message) && !/条件なし/.test(c.message), `BF-C: conditional-control は通過（金額の入力チェックは計画の条件の中・既存の承認済みのロックは別の条件の制御）: ${c.message}`);
  assert(rv.registration.verdict === 'NEEDS_CONFIRMATION' && !codes.includes('conditional-control') && ['error-cancels-edit', 'duplicate-handler', 'existing-conflict'].every(x => codes.includes(x)) && codes.length === 3, `BF-C: 確認は 4 件 → 3 件（不要な conditional-control が無くなる。残りは実際に確かめること）: ${codes.join(', ')}`);
  assert(!rv.registration.blockers.length, '登録不可にはならない（動作テスト環境での確認は残る）');
}

// =========================================================
console.log('\n--- F-F2 他の検査も変数経由を数える: 作成画面のシステムフィールド・対象と異なるフィールド・PC とモバイル ---');
{
  const data = JSON.parse(JSON.stringify(DATA));
  const mob = (body, events = ['mobile.app.record.create.show', 'mobile.app.record.edit.show']) => KTCodeReview.review({ generated: gen(`(function () {\n  'use strict';\n  kintone.events.on(${JSON.stringify(events).replace(/"/g, "'")}, function (event) {\n    const record = event.record;\n${body}\n    return event;\n  });\n})();`), customization: cust({ platform: ['mobile'], events }), plan: null, data, scan: null, existingSource: null });
  const aliasRead = mob("    const st = record['ステータス'];\n    if (st.value === '承認済み') {\n      record['金額'].disabled = true;\n    }");
  assert(aliasRead.registration.blockers.some(b => b.code === 'create-missing-field'), `作成画面で、変数に入れたステータスを確かめずに .value → 登録不可（create-missing-field）: ${JSON.stringify(aliasRead.registration.blockers.map(b => b.code))}`);
  const aliasGuard = mob("    const st = record['ステータス'];\n    if (st && st.value === '承認済み') {\n      record['金額'].disabled = true;\n    }");
  const dotRead = mob("    if (record.ステータス.value === '承認済み') {\n      record.金額.disabled = true;\n    }");
  assert(!aliasGuard.registration.blockers.some(b => b.code === 'create-missing-field') && dotRead.registration.blockers.some(b => b.code === 'create-missing-field'), `変数の存在を確かめていれば止めない・ドット記法（record.ステータス.value）も確かめずに読めば止める: ${JSON.stringify([aliasGuard, dotRead].map(r => r.registration.blockers.map(b => b.code)))}`);
  // 計画に無いフィールドを変数経由で書き換える → 登録不可（修正前は見逃した）
  const off = review(handler(EDIT, "    if (record['ステータス'].value === '承認済み') {\n      record['金額'].disabled = true;\n    }\n    const memo = record['備考'];\n    memo.value = '承認済み';"));
  assert(off.registration.blockers.some(b => b.code === 'target-fields' && /備考/.test(b.message)), `計画に無いフィールド（備考）を変数経由で書き換える → 登録不可（対象と異なるフィールド）: ${JSON.stringify(off.registration.blockers.map(b => b.code))}`);
  // PC とモバイル: PC は変数経由・モバイルは直接でロック → 片方だけとは言わない
  const both = cust({ platform: ['desktop', 'mobile'], events: ['app.record.edit.show', 'mobile.app.record.edit.show'] });
  const code = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    const field = event.record['金額'];\n    if (event.record['ステータス'].value === '承認済み') {\n      field.disabled = true;\n    }\n    return event;\n  });\n  kintone.events.on(['mobile.app.record.edit.show'], function (event) {\n    if (event.record['ステータス'].value === '承認済み') {\n      event.record['金額'].disabled = true;\n    }\n    return event;\n  });\n})();";
  const pm = review(code, both);
  assert(!pm.registration.blockers.some(b => b.code === 'platform-fields') && pm.registration.verdict !== 'BLOCKED', `PC（変数経由）とモバイル（直接）の両方でロック → PC とモバイルの片方だけとは言わない: ${JSON.stringify(pm.registration.blockers.map(b => b.code))}`);
}

// =========================================================
console.log('\n--- F-F2 Field Scanner（KTScan）: 日本語のコードのドット記法・変数に入れたフィールドのアクセス種別 ---');
{
  const fields = [{ code: '金額', label: '金額', type: 'NUMBER' }, { code: '備考', label: '備考', type: 'MULTI_LINE_TEXT' }];
  const a1 = KTScan.analyzeFile({ name: 'a.js', target: 'desktop', kind: 'js', text: handler(EDIT, "    record.金額.disabled = true;") }, { fields });
  assert(a1.fieldAccess['金額'] && a1.fieldAccess['金額'].CONTROL >= 1, `record.金額.disabled（日本語のコードのドット記法）→ 金額の CONTROL: ${JSON.stringify(a1.fieldAccess)}`);
  const a2 = KTScan.analyzeFile({ name: 'b.js', target: 'desktop', kind: 'js', text: handler(EDIT, "    const field = record['金額'];\n    field.disabled = true;\n    const memo = record['備考'];\n    console.log(memo.value);") }, { fields });
  assert(a2.fieldAccess['金額'] && a2.fieldAccess['金額'].CONTROL >= 1 && a2.fieldAccess['備考'] && a2.fieldAccess['備考'].READ >= 1 && !a2.fieldAccess['備考'].CONTROL, `変数に入れたフィールド: 金額は CONTROL・備考は READ（使われ方で数える）: ${JSON.stringify(a2.fieldAccess)}`);
  assert(KTScan.ANALYZER_VERSION === '14', '解析ロジックの版を上げた（古い Field Scanner のキャッシュを使わない）');
}

console.log(`\n${state.failed === 0 ? 'ALL PASSED' : 'FAILED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed === 0 ? 0 : 1);
