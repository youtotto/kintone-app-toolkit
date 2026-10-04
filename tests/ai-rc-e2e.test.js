// 最終 RC の E2E（2026-10-04・実機）で見つけた生成コードの見逃しの回帰テスト
//
// 検証内容:
//   N3 使える画面の違う API: kintone.app.record.getFieldElement は PC のレコード詳細・印刷画面とモバイルのレコード詳細画面でしか使えない
//      （公式ドキュメント。作成・編集画面では null）。BF-C の生成コードは作成・編集画面のイベントでこれを使い、警告が出なかったのに、
//      API の検査は「目録にあります」で通した。API の目録に使える画面を持たせ、handler のイベントの画面と照合する
//      （どのイベントでも使えない → 登録不可、一部で使えない → 確認。既存のコードに元からある呼び出しは数えない）
//   N2 空の判定の undefined: 作成画面では空のフィールドの value が undefined になる（入力して消した後・保存時のイベントでも。実機）。
//      §2 手順 4 の生成（v3）は `=== null` と空文字だけで判定し、保存時の必須チェックが効かなかった。作成画面の handler で、
//      フィールドの値を空文字と比べる判定に undefined の扱い（=== undefined / == null / !value / || '' など）が無いものを確認に回す
//
// 実行方法: node tests/ai-rc-e2e.test.js（KT_SRC=<別ビルド> で修正前の版に対して走らせると RED になる）
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const T = loadToolkit();
const { KTDeps, KTScan, KTCodeReview, KTJsCatalog } = T;
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const R = require('./fixtures/p21-bfc-replay.js');
const E2E = require('./fixtures/rc-e2e-replay.js');

// 修正前の版（KT_SRC）には無い関数を呼んでも落ちない（失敗として数える）
const safe = (fn, fallback = null) => { try { return fn(); } catch (e) { return fallback; } };
const DATA = (() => {
  const d = FX.makeData();
  d.fields = JSON.parse(JSON.stringify(R.FIELDS));
  d.fields.customer_category = { type: 'DROP_DOWN', code: 'customer_category', label: '顧客区分', noLabel: false, required: false, options: { '新規': { label: '新規', index: '0' }, '既存': { label: '既存', index: '1' } }, defaultValue: '' };
  d.fields.referral_source = { type: 'SINGLE_LINE_TEXT', code: 'referral_source', label: '紹介元', noLabel: false, required: false, defaultValue: '' };
  return d;
})();
const handler = (events, body) => `(function () {\n  'use strict';\n  kintone.events.on(${JSON.stringify(events).replace(/"/g, "'")}, function (event) {\n    var record = event.record;\n${body}\n    return event;\n  });\n})();`;
const cust = (o = {}) => ({ customizationId: 'C1', requirement: 'r', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events: [], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [], ...o });
const gen = (code, o = {}) => ({ strategy: 'NEW_JS_FILE', targetFile: 'gen.js', summary: 's', code, patch: null, events: [], fields: [], apis: [], ...o });
const review = (code, c = cust(), g = {}, existing = null) => KTCodeReview.review({ generated: gen(code, g), customization: c, plan: null, data: DATA, scan: null, existingSource: existing });
const ext = (base, content, c = cust({ strategy: 'EXTEND_EXISTING_JS' })) => KTCodeReview.review({ generated: gen(content, { strategy: 'EXTEND_EXISTING_JS', targetFile: 'base.js', patch: { baseHash: KTScan.hashText(base), operations: [{ type: 'INSERT_BEFORE', anchor: '})();', content }] } }), customization: c, plan: null, data: DATA, scan: null, existingSource: { name: 'base.js', target: 'desktop', text: base } });
const check = (rv, name) => (rv.checks || []).filter(x => x.name === name && !x.ok);
const codesOf = (list) => (list || []).map(x => x.code);

(async () => {
// =========================================================
console.log('\n--- N3 API の目録: 使える画面（公式ドキュメント）---');
{
  const s = (n) => safe(() => KTJsCatalog.apiScreens(n), null);
  const eq = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...b].sort());
  assert(eq(s('kintone.app.record.getFieldElement'), ['detail', 'print']) && eq(s('kintone.mobile.app.record.getFieldElement'), ['detail']), `getFieldElement: PC は詳細・印刷、モバイルは詳細だけ: ${JSON.stringify([s('kintone.app.record.getFieldElement'), s('kintone.mobile.app.record.getFieldElement')])}`);
  assert(eq(s('kintone.app.record.getSpaceElement'), ['create', 'edit', 'detail', 'print']) && eq(s('kintone.mobile.app.record.getSpaceElement'), ['create', 'edit', 'detail']), 'getSpaceElement: PC は追加・編集・詳細・印刷、モバイルは追加・編集・詳細');
  assert(eq(s('kintone.app.record.setFieldShown'), ['create', 'edit', 'detail', 'print']) && eq(s('kintone.mobile.app.record.setFieldShown'), ['create', 'edit', 'detail']) && eq(s('kintone.app.record.setGroupFieldOpen'), ['create', 'edit', 'detail', 'print']) && eq(s('kintone.mobile.app.record.setGroupFieldOpen'), ['create', 'edit', 'detail']), 'setFieldShown / setGroupFieldOpen: PC は印刷も、モバイルは追加・編集・詳細');
  assert(eq(s('kintone.app.record.getHeaderMenuSpaceElement'), ['create', 'edit', 'detail']) && eq(s('kintone.app.getFieldElements'), ['index', 'index-edit']) && eq(s('kintone.mobile.app.getFieldElements'), ['index', 'index-edit']), 'レコードのメニューの上側は追加・編集・詳細、一覧のフィールド要素は一覧（表形式）だけ');
  assert(s('kintone.app.record.get') === null && s('kintone.api') === null, '画面を確かめていない API は照合しない（null）');
  const apis = safe(() => KTJsCatalog.extractApis("kintone.mobile.app.record.getFieldElement('a'); kintone.mobile.app.getFieldElements('a');"), []);
  assert(apis.length === 2 && apis.every(a => a.known), `モバイルの getFieldElement / getFieldElements を目録に足す（目録に無い API と扱わない）: ${JSON.stringify(apis.map(a => [a.name, a.known]))}`);
  assert(Number(KTJsCatalog.CATALOG_VERSION) >= 2 && Number(KTScan.ANALYZER_VERSION) >= 15, `目録・解析の版を上げた（古い Field Scanner のキャッシュの API の判定を使わない）: ${KTJsCatalog.CATALOG_VERSION} / ${KTScan.ANALYZER_VERSION}`);
}

// =========================================================
console.log('\n--- N3 実機の再生（RC E2E の BF-C）: 作成・編集画面のイベントで getFieldElement → 登録不可 ---');
{
  const data = JSON.parse(JSON.stringify(DATA));
  const rv = KTCodeReview.review({ generated: E2E.BFC.generated, customization: E2E.BFC.customization, plan: null, data, scan: null, existingSource: { name: 'dealLock.js', target: 'desktop', text: R.DEAL_LOCK } });
  const x = check(rv, 'api-screen')[0] || {};
  assert(E2E.BFC.review.verdict === 'NEEDS_CONFIRMATION' && /getFieldElement/.test(E2E.BFC.generated.code), '前提: 実機の判定は確認が必要（getFieldElement を見逃した）');
  assert(x.severity === 'block' && /kintone\.app\.record\.getFieldElement/.test(x.message || '') && /作成/.test(x.message || '') && /編集/.test(x.message || '') && /null/.test(x.message || ''), `getFieldElement は作成・編集画面では使えない → 登録不可（理由・使える画面つき）: ${x.message}`);
  assert(rv.registration.verdict === 'BLOCKED' && codesOf(rv.registration.blockers).includes('api-screen'), `登録の判定は登録不可: ${rv.registration.verdict} ${JSON.stringify(codesOf(rv.registration.blockers))}`);
}

// =========================================================
console.log('\n--- N3 handler のイベントと使える画面の照合 ---');
{
  const code = (events, line) => handler(events, `    ${line}`);
  const gfe = "var el = kintone.app.record.getFieldElement('amount');\n    if (el) { el.style.color = 'red'; }";
  const detail = review(code(['app.record.detail.show'], gfe));
  assert(!check(detail, 'api-screen').length, '詳細画面のイベントで getFieldElement → 問題なし');
  const mixed = review(code(['app.record.detail.show', 'app.record.edit.show'], gfe));
  const xm = check(mixed, 'api-screen')[0] || {};
  assert(xm.severity === 'review' && /編集/.test(xm.message || '') && !codesOf(mixed.registration.blockers).includes('api-screen') && codesOf(mixed.registration.confirmations).includes('api-screen'), `詳細と編集の両方のイベント → 編集画面では動かないので確認（登録不可にはしない）: ${xm.severity} ${xm.message}`);
  const space = review(code(['app.record.create.show'], "var sp = kintone.app.record.getSpaceElement('warn');\n    if (sp) { sp.textContent = '注意'; }"));
  assert(!check(space, 'api-screen').length, '作成画面のイベントで getSpaceElement → 問題なし（使える画面）');
  const shownIndex = review(code(['app.record.index.show'], "kintone.app.record.setFieldShown('amount', false);"));
  assert((check(shownIndex, 'api-screen')[0] || {}).severity === 'block', '一覧画面のイベントで setFieldShown → 登録不可');
  const listOk = review(code(['app.record.index.show'], "var els = kintone.app.getFieldElements('amount');"));
  const listNg = review(code(['app.record.edit.show'], "var els = kintone.app.getFieldElements('amount');"));
  assert(!check(listOk, 'api-screen').length && (check(listNg, 'api-screen')[0] || {}).severity === 'block', '一覧のフィールド要素は一覧画面なら問題なし・編集画面なら登録不可');
  const mob = (events) => review(code(events, "var el = kintone.mobile.app.record.getFieldElement('amount');"), cust({ platform: ['mobile'] }));
  assert((check(mob(['mobile.app.record.edit.show']), 'api-screen')[0] || {}).severity === 'block' && !check(mob(['mobile.app.record.detail.show']), 'api-screen').length && !check(mob(['mobile.app.record.detail.show']), 'apis').length, 'モバイルの getFieldElement: 編集画面は登録不可・詳細画面は問題なし（目録に無い API とも言わない）');
  // 名前で渡した handler の中も見る
  const named = review("(function () {\n  'use strict';\n  function paint(event) {\n    var el = kintone.app.record.getFieldElement('amount');\n    if (el) { el.style.color = 'red'; }\n    return event;\n  }\n  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], paint);\n})();");
  assert((check(named, 'api-screen')[0] || {}).severity === 'block', '名前で渡した handler（function paint）の中の getFieldElement も照合する');
  // どの handler から呼ばれるか分からない関数の中は照合しない（画面が分からない）
  const helper = review("(function () {\n  'use strict';\n  function paint() {\n    var el = kintone.app.record.getFieldElement('amount');\n    if (el) { el.style.color = 'red'; }\n  }\n  window.ktPaint = paint;\n})();");
  assert(!check(helper, 'api-screen').length, '呼び出し元の画面が分からない関数の中は照合しない');
  // 既存のコードに元からある呼び出しは数えない（今回足したコードだけを照合する）
  const base = handler(['app.record.edit.show'], "    var el = kintone.app.record.getFieldElement('amount');\n    if (el) { el.style.color = 'red'; }");
  const added = ext(base, "  kintone.events.on(['app.record.edit.submit'], function (event) {\n    return event;\n  });\n");
  assert(!check(added, 'api-screen').length, '既存のコードに元からある getFieldElement は数えない');
  const added2 = ext(base, "  kintone.events.on(['app.record.create.show'], function (event) {\n    var el2 = kintone.app.record.getFieldElement('amount');\n    return event;\n  });\n");
  assert((check(added2, 'api-screen')[0] || {}).severity === 'block', '今回足した handler の getFieldElement は照合する');
}

// =========================================================
console.log('\n--- N2 実機の再生（RC E2E の §2 手順 4）: 空の判定に undefined が無い必須チェック → 確認 ---');
{
  const edited = R.DEAL_VALIDATE.replace(/\s*$/, '') + '\n// 別の担当者のメモ（RC E2E: 外部からの変更の確認）\n';
  assert(KTScan.hashText(edited) === '17734541' && KTScan.hashText(R.DEAL_VALIDATE) === '6a64035a', `前提: 別の担当者の変更の後の dealValidate.js を再現（指紋 17734541）: ${KTScan.hashText(edited)}`);
  const v3 = KTCodeReview.review({ generated: E2E.S2_V3.generated, customization: E2E.S2_V3.customization, plan: null, data: JSON.parse(JSON.stringify(DATA)), scan: null, existingSource: { name: 'dealValidate.js', target: 'desktop', text: edited } });
  const x = check(v3, 'empty-undefined')[0] || {};
  assert(!check(v3, 'patch').length, '再生の前提: パッチは適用できる');
  assert(x.severity === 'review' && /referral_source/.test(x.message || '') && /undefined/.test(x.message || '') && /作成画面/.test(x.message || ''), `v3: referral_source の空の判定が undefined を扱っていない → 確認（理由つき）: ${x.message}`);
  assert(codesOf(v3.registration.confirmations).includes('empty-undefined') && v3.registration.verdict === 'NEEDS_CONFIRMATION', `登録の判定は確認が必要（確認の項目に入る）: ${JSON.stringify(codesOf(v3.registration.confirmations))}`);
  const v2 = KTCodeReview.review({ generated: E2E.S2_V2.generated, customization: E2E.S2_V2.customization, plan: null, data: JSON.parse(JSON.stringify(DATA)), scan: null, existingSource: { name: 'dealValidate.js', target: 'desktop', text: R.DEAL_VALIDATE } });
  assert(/=== undefined/.test(E2E.S2_V2.generated.code) && !check(v2, 'empty-undefined').length, 'v2（undefined も判定）→ 確認しない。既存の金額のチェック（undefined を判定）も数えない');
  const hint = KTCodeReview.HOW_TO_CHECK && KTCodeReview.HOW_TO_CHECK['empty-undefined'];
  assert(/作成画面/.test(hint || '') && /空/.test(hint || ''), `確かめること: 作成画面で空のまま保存する: ${hint}`);
  assert(/画面/.test((KTCodeReview.HOW_TO_CHECK || {})['api-screen'] || ''), '確かめること（api-screen）がある');
}

// =========================================================
console.log('\n--- N2 空の判定の書き方 ---');
{
  const SUB = ['app.record.create.submit', 'app.record.edit.submit'];
  const req = (cond, pre = "    var v = record['referral_source'].value;") => review(handler(SUB, `${pre}\n    if (${cond}) {\n      record['referral_source'].error = '紹介元を入力してください';\n    }`), cust({ fields: [{ code: 'referral_source', access: 'CONTROL' }] }));
  const flagged = (rv) => check(rv, 'empty-undefined').length > 0;
  const okCases = {
    '!v': req('!v'),
    "v == null || v === ''": req("v == null || v === ''"),
    "v === undefined || v === null || v === ''": req("v === undefined || v === null || v === ''"),
    "typeof v === 'undefined' || v === ''": req("typeof v === 'undefined' || v === ''"),
    "v == undefined || String(v).trim() === ''": req("v == undefined || String(v).trim() === ''"),
    "(v || '') === ''": req("(v || '') === ''"),
    "String(v || '').trim() === ''": req("String(v || '').trim() === ''"),
    "var v = …value || ''; v === ''": req("v === ''", "    var v = record['referral_source'].value || '';"),
    "var v = …value ?? ''; v.trim() === ''": req("v.trim() === ''", "    var v = record['referral_source'].value ?? '';"),
  };
  const okBad = Object.entries(okCases).filter(([, rv]) => flagged(rv)).map(([k]) => k);
  assert(!okBad.length, `undefined を扱っている書き方は確認しない: ${okBad.join(' / ') || 'すべて通過'}`);
  const ngCases = {
    "v === ''": req("v === ''"),
    "v === null || v === ''": req("v === null || v === ''"),
    "String(v).trim() === ''": req("String(v).trim() === ''"),
    "v.trim() === ''": req("v.trim() === ''"),
    "record['referral_source'].value === ''": req("record['referral_source'].value === ''", ''),
    "record.referral_source.value === ''": req("record.referral_source.value === '' || record.referral_source.value === null", ''),
    "v !== '' && v !== null（入力ありの判定）": req("v !== '' && v !== null"),
  };
  const ngMiss = Object.entries(ngCases).filter(([, rv]) => !flagged(rv)).map(([k]) => k);
  assert(!ngMiss.length, `undefined を扱っていない書き方は確認に回す: ${ngMiss.join(' / ') || 'すべて検出'}`);
  // 「入力あり」の判定で同じ値を数値に変えて比べる形（実機の BF-C の生成コード: amount !== '' && amount !== null && Number(amount) > 1000000）は、
  //   undefined が NaN になって条件が成り立たないので数えない（数値に変えずに使う形は数える）
  const amt = (body) => review(handler(['app.record.create.show', 'app.record.create.change.amount'], body), cust({ fields: [{ code: 'amount', access: 'CONTROL' }] }));
  const numCopy = amt("    var amount = record['amount'].value;\n    if (amount !== '' && amount !== null && Number(amount) > 1000000) {\n      record['amount'].error = '金額が1,000,000円を超えています。';\n    }");
  const numField = amt("    if (record.amount.value !== '' && Number(record.amount.value) > 0) {\n      record['amount'].error = 'x';\n    }");
  const strUse = amt("    var amount = record['amount'].value;\n    if (amount !== '' && amount !== null) {\n      record['amount'].error = amount + ' 円';\n    }");
  assert(!flagged(numCopy) && !flagged(numField) && flagged(strUse), `入力ありの判定で同じ値を Number() で比べる形は数えない・数値に変えずに使う形は数える: ${[numCopy, numField, strUse].map(flagged).join(' / ')}`);
  // 変数に入れたフィールド（Phase 22 の解決）
  const alias = review(handler(SUB, "    var f = record['referral_source'];\n    if (f.value === '' || f.value === null) {\n      f.error = '紹介元を入力してください';\n    }"), cust({ fields: [{ code: 'referral_source', access: 'CONTROL' }] }));
  const aliasOk = review(handler(SUB, "    var f = record['referral_source'];\n    if (!f.value) {\n      f.error = '紹介元を入力してください';\n    }"), cust({ fields: [{ code: 'referral_source', access: 'CONTROL' }] }));
  assert(flagged(alias) && /referral_source/.test((check(alias, 'empty-undefined')[0] || {}).message || '') && !flagged(aliasOk), '変数に入れたフィールドの value も同じに見る（f.value === \'\' は確認・!f.value は通過）');
  // 三項演算子で error を設定する書き方（実機の v3 と同じ形）
  const tern = review(handler(SUB, "    var v = record['referral_source'].value;\n    record['referral_source'].error = v === null || String(v).trim() === '' ? '紹介元を入力してください' : null;"), cust({ fields: [{ code: 'referral_source', access: 'CONTROL' }] }));
  assert(flagged(tern), '三項演算子の条件の中の空の判定も見る');
  // 作成画面のイベントだけ（編集画面だけの handler は数えない。実機で確かめたのは作成画面）
  const editOnly = review(handler(['app.record.edit.submit'], "    var v = record['referral_source'].value;\n    if (v === '') {\n      record['referral_source'].error = 'x';\n    }"), cust({ fields: [{ code: 'referral_source', access: 'CONTROL' }] }));
  const mobileCreate = review(handler(['mobile.app.record.create.submit'], "    var v = record['referral_source'].value;\n    if (v === '') {\n      record['referral_source'].error = 'x';\n    }"), cust({ platform: ['mobile'], fields: [{ code: 'referral_source', access: 'CONTROL' }] }));
  assert(!flagged(editOnly) && flagged(mobileCreate), '編集画面だけの handler は数えない・モバイルの作成画面は数える');
  // フィールドの値ではない変数・既存のコードに元からある判定は数えない
  const notField = review(handler(SUB, "    var s = 'abc';\n    if (s === '') {\n      record['referral_source'].error = 'x';\n    }"), cust({ fields: [{ code: 'referral_source', access: 'CONTROL' }] }));
  const base = handler(SUB, "    var v = record['referral_source'].value;\n    if (v === '') {\n      record['referral_source'].error = 'x';\n    }");
  const existing = ext(base, "  kintone.events.on(['app.record.create.show'], function (event) {\n    return event;\n  });\n", cust({ strategy: 'EXTEND_EXISTING_JS', fields: [{ code: 'referral_source', access: 'CONTROL' }] }));
  assert(!flagged(notField) && !flagged(existing), 'フィールドの値ではない変数・既存のコードに元からある判定は数えない');
}

console.log(`\n${state.failed === 0 ? 'ALL PASSED' : 'FAILED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
