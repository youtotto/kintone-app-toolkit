// 最終 RC の E2E（2026-10-04・実機）で見つけた生成コードの見逃しの回帰テスト
//
// 検証内容:
//   N3 使える画面の違う API: kintone.app.record.getFieldElement は PC のレコード詳細・印刷画面とモバイルのレコード詳細画面でしか使えない
//      （公式ドキュメント。作成・編集画面では null）。BF-C の生成コードは作成・編集画面のイベントでこれを使い、警告が出なかったのに、
//      API の検査は「目録にあります」で通した。API の目録に使える画面を持たせ、handler のイベントの画面と照合する
//      （どのイベントでも使えない → 登録不可、一部で使えない → 確認。既存のコードに元からある呼び出しは数えない）
//   N2 空の判定の undefined: 作成画面では空のフィールドの value が undefined になる（入力して消した後・保存時のイベントでも。実機）。
//      §2 手順 4 の生成（v3）は `=== null` と空文字だけで判定し、保存時の必須チェックが効かなかった。
//      C-1 第 2 段（§0d.4）で Toolkit の推定による判定（empty-undefined）は外した。生成工程で守る: AI版 sandbox/test/run.mjs §5
//      「S2_V3（実機 N2）: 作成画面の空（undefined）を見逃し、保存は止まらない」「S2_V3: 編集画面の空（''）では止まり、入力ありでは止まらない」
//      「S2_V2: undefined も判定して作成画面でも保存を止める」、worker/test/cases/required-effects.mjs「lock: …作成画面の空 → not-locked（…空は undefined の印）」。
//      ここに残すのは、記録した出力が生成の直後の modern JavaScript の修正とパッチの適用を通ること
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
const handler = (events, body) => `(function () {\n  'use strict';\n  kintone.events.on(${JSON.stringify(events).replace(/"/g, "'")}, function (event) {\n    const record = event.record;\n${body}\n    return event;\n  });\n})();`;
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
  const gfe = "const el = kintone.app.record.getFieldElement('amount');\n    if (el) { el.style.color = 'red'; }";
  const detail = review(code(['app.record.detail.show'], gfe));
  assert(!check(detail, 'api-screen').length, '詳細画面のイベントで getFieldElement → 問題なし');
  const mixed = review(code(['app.record.detail.show', 'app.record.edit.show'], gfe));
  const xm = check(mixed, 'api-screen')[0] || {};
  assert(xm.severity === 'review' && /編集/.test(xm.message || '') && !codesOf(mixed.registration.blockers).includes('api-screen') && codesOf(mixed.registration.confirmations).includes('api-screen'), `詳細と編集の両方のイベント → 編集画面では動かないので確認（登録不可にはしない）: ${xm.severity} ${xm.message}`);
  const space = review(code(['app.record.create.show'], "const sp = kintone.app.record.getSpaceElement('warn');\n    if (sp) { sp.textContent = '注意'; }"));
  assert(!check(space, 'api-screen').length, '作成画面のイベントで getSpaceElement → 問題なし（使える画面）');
  const shownIndex = review(code(['app.record.index.show'], "kintone.app.record.setFieldShown('amount', false);"));
  assert((check(shownIndex, 'api-screen')[0] || {}).severity === 'block', '一覧画面のイベントで setFieldShown → 登録不可');
  const listOk = review(code(['app.record.index.show'], "const els = kintone.app.getFieldElements('amount');"));
  const listNg = review(code(['app.record.edit.show'], "const els = kintone.app.getFieldElements('amount');"));
  assert(!check(listOk, 'api-screen').length && (check(listNg, 'api-screen')[0] || {}).severity === 'block', '一覧のフィールド要素は一覧画面なら問題なし・編集画面なら登録不可');
  const mob = (events) => review(code(events, "const el = kintone.mobile.app.record.getFieldElement('amount');"), cust({ platform: ['mobile'] }));
  assert((check(mob(['mobile.app.record.edit.show']), 'api-screen')[0] || {}).severity === 'block' && !check(mob(['mobile.app.record.detail.show']), 'api-screen').length && !check(mob(['mobile.app.record.detail.show']), 'apis').length, 'モバイルの getFieldElement: 編集画面は登録不可・詳細画面は問題なし（目録に無い API とも言わない）');
  // 名前で渡した handler の中も見る
  const named = review("(function () {\n  'use strict';\n  function paint(event) {\n    const el = kintone.app.record.getFieldElement('amount');\n    if (el) { el.style.color = 'red'; }\n    return event;\n  }\n  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], paint);\n})();");
  assert((check(named, 'api-screen')[0] || {}).severity === 'block', '名前で渡した handler（function paint）の中の getFieldElement も照合する');
  // どの handler から呼ばれるか分からない関数の中は照合しない（画面が分からない）
  const helper = review("(function () {\n  'use strict';\n  function paint() {\n    const el = kintone.app.record.getFieldElement('amount');\n    if (el) { el.style.color = 'red'; }\n  }\n  window.ktPaint = paint;\n})();");
  assert(!check(helper, 'api-screen').length, '呼び出し元の画面が分からない関数の中は照合しない');
  // 既存のコードに元からある呼び出しは数えない（今回足したコードだけを照合する）
  const base = handler(['app.record.edit.show'], "    const el = kintone.app.record.getFieldElement('amount');\n    if (el) { el.style.color = 'red'; }");
  const added = ext(base, "  kintone.events.on(['app.record.edit.submit'], function (event) {\n    return event;\n  });\n");
  assert(!check(added, 'api-screen').length, '既存のコードに元からある getFieldElement は数えない');
  const added2 = ext(base, "  kintone.events.on(['app.record.create.show'], function (event) {\n    const el2 = kintone.app.record.getFieldElement('amount');\n    return event;\n  });\n");
  assert((check(added2, 'api-screen')[0] || {}).severity === 'block', '今回足した handler の getFieldElement は照合する');
}

// =========================================================
console.log('\n--- N2 実機の再生（RC E2E の §2 手順 4）: 記録した出力のパッチを適用できる（記法は生成工程の機械検査・空の判定の undefined は生成工程の模擬テスト）---');
{
  const edited = R.DEAL_VALIDATE.replace(/\s*$/, '') + '\n// 別の担当者のメモ（RC E2E: 外部からの変更の確認）\n';
  assert(KTScan.hashText(edited) === '17734541' && KTScan.hashText(R.DEAL_VALIDATE) === '6a64035a', `前提: 別の担当者の変更の後の dealValidate.js を再現（指紋 17734541）: ${KTScan.hashText(edited)}`);
  //   簡素化 B（2026-10-16）: 記法（var）の自動修正と検査は生成工程（Gateway の modern-js.mjs）だけが行う（Toolkit の写しの KTModernJs は削除。追加した var だけを直し、
  //   既存の var を変えないことは AI版 worker/test/cases/modern-js.mjs が確かめる）。Toolkit の形式確認は記録した出力（var を含む）をそのまま検査する
  const src3 = { name: 'dealValidate.js', target: 'desktop', text: edited };
  const v3 = KTCodeReview.review({ generated: E2E.S2_V3.generated, customization: E2E.S2_V3.customization, plan: null, data: JSON.parse(JSON.stringify(DATA)), scan: null, existingSource: src3 });
  assert(!v3.checks.some(x => x.name === 'modern-js'), 'Toolkit の形式確認は記法を確かめない（生成工程の機械検査の modern-js が確かめる）');
  // 段階 C（5.5 の縮小）: 既存の handler の var は自動では変えない（直すのは追加した var だけ）。既存の var amount は変更していない行なので記法の検査の対象外
  assert(/var amount = event\.record\['amount'\]\.value;/.test(v3.finalCode || '') && v3.checks.some(x => x.name === 'patch' && /元のコードは保持（全文の書き換えなし）$/.test(x.message)), `既存の dealValidate.js の var amount はそのまま（全文を書き換えない）: ${JSON.stringify(v3.checks.filter(x => /^patch/.test(x.name)).map(x => x.message))}`);
  assert(!check(v3, 'patch').length, '再生の前提: パッチは適用できる');
  // v3 の空の判定（undefined を扱わない）・v2（undefined も判定）の違いは、生成工程の模擬テストが確かめる（sandbox/test/run.mjs §5 の S2_V3・S2_V2）
  assert(/画面/.test((KTCodeReview.HOW_TO_CHECK || {})['api-screen'] || ''), '確かめること（api-screen）がある');
}

// N2 空の判定の書き方（empty-undefined の検出の範囲）は C-1 第 2 段（§0d.4）で判定ごと外した。生成工程で守る回帰はファイルの先頭の説明のとおり

// =========================================================
console.log('\n--- モデル更新（gpt-6.1-sol）の評価で見つけた誤検知: 正しいコードを登録不可にしない ---');
{
  const M = require('./fixtures/rc-model-replay.js');
  const data = JSON.parse(JSON.stringify(DATA));
  const run = (x) => KTCodeReview.review({ generated: x.generated, customization: x.customization, plan: null, data, scan: null, existingSource: { name: 'dealLock.js', target: 'desktop', text: R.DEAL_LOCK } });
  // 1) error = null（空白を挟む普通の書き方）をエラーの設定と数えない
  const bfc = run(M.SOL_BFC);
  assert(M.SOL_BFC.verdictAtRun === 'BLOCKED' && /field\.error = null/.test(M.SOL_BFC.generated.code), '前提: 実行時の判定は登録不可（保存時の分岐の field.error = null を数えた）');
  // 同じイベントの error と編集不可の判定（error-cancels-edit）は §0d.4 で外した。生成工程で守る: AI版 worker/test/cases/required-effects.mjs「§0d.1 S7（既知の競合）」（排他的な分岐の正しい候補を機械検査で止めない）
  assert(bfc.registration.verdict !== 'BLOCKED', `SOL_BFC: 注意は編集不可（!field.disabled）を見る条件の中だけ・保存時は null で消すだけ → 形式確認では登録不可にしない: ${bfc.registration.verdict} ${JSON.stringify(codesOf(bfc.registration.blockers))}`);
  const ops = safe(() => KTCodeReview.kintoneFieldOps(KTScan.stripCommentsOnly("(function () {\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    event.record['amount'].disabled = true;\n    event.record['amount'].error = null;\n    return event;\n  });\n})();")), []);
  assert(ops.length === 1 && ops[0].error === false && ops[0].disabled === true, `error = null だけの handler はエラーを出す handler ではない: ${JSON.stringify(ops.map(o => [o.error, o.disabled]))}`);
  const genuine = review(handler(['app.record.edit.show'], "    if (record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }\n    if (Number(record['amount'].value) > 1000000) {\n      record['amount'].error = '金額が大きい';\n    } else {\n      record['amount'].error = null;\n    }"), cust({ fields: [{ code: 'amount', access: 'CONTROL' }] }));
  // §0d.4: 競合の断定は生成工程（Gateway の check behavior・candidate-error-same-event と模擬テスト。AI版 required-effects.mjs「§0d.1 S7」・sandbox/test/run.mjs「R13 同じ handler」）。
  //   Toolkit は生成工程の結果を取り込み、結果が無い（返却の欠落）・模擬テストの fail（明示された失敗）なら登録不可にする（attachBehavior）
  const REQ_G = [{ requirementId: 'C1', field: 'amount', effect: 'lock', events: ['app.record.edit.show'], condition: 'ステータス in ("承認済み")' }];
  const GW_G = { requiredEffects: [{ requirementId: 'C1', field: 'amount', effect: 'lock', status: 'present', check: 'behavior', checkReason: ['candidate-error-same-event'], events: [{ event: 'app.record.edit.show', status: 'present' }] }],
    behavior: { status: 'failed', reason: null, cases: [{ id: 'k1', field: 'amount', effect: 'lock', expect: 'lock', event: 'app.record.edit.show', side: 'match', verdict: 'fail', message: '承認済みで金額が編集できます（同じイベントの error で編集不可が取り消されました）' }] } };
  const gNone = KTCodeReview.attachBehavior(genuine, null, { requiredEffects: REQ_G, customization: cust() });
  const gFail = KTCodeReview.attachBehavior(genuine, GW_G, { requiredEffects: REQ_G, customization: cust() });
  assert(gNone.registration.verdict === 'BLOCKED' && check(gNone, 'required-effects').some(x => x.severity === 'block'), `編集不可を見ずにエラーを出す（同じイベントで disabled）→ 生成工程の結果が無い間は登録不可（返却の欠落）: ${gNone.registration.verdict}`);
  assert(gFail.registration.verdict === 'BLOCKED' && check(gFail, 'behavior-fail').some(x => x.severity === 'block'), `同じ候補で模擬テストが編集不可の取り消しを見つけた（Gateway の behavior の fail）→ 登録不可: ${gFail.registration.verdict}`);
  // 2) 画面を見分ける前方一致の文字列（'app.record.index.'）を、登録しているイベント名と取り違えない
  const cx1 = run(M.SOL_CX1);
  assert(M.SOL_CX1.blockersAtRun.includes('events') && /indexOf\('app\.record\.index\.'\)/.test(M.SOL_CX1.generated.code), '前提: 実行時は「kintone に無いイベント: app.record.index.」で登録不可');
  assert(!codesOf(cx1.registration.blockers).includes('events'), `SOL_CX1: event.type.indexOf('app.record.index.') は登録しているイベントではない → events で止めない: ${JSON.stringify(codesOf(cx1.registration.blockers))}`);
  const directBad = review("(function () {\n  kintone.events.on('app.record.update.show', function (event) {\n    return event;\n  });\n})();");
  const prefixReg = review("(function () {\n  kintone.events.on('app.record.index.', function (event) {\n    return event;\n  });\n})();");
  assert(codesOf(directBad.registration.blockers).includes('events') && codesOf(prefixReg.registration.blockers).includes('events'), '登録しているイベント名が kintone に無い（app.record.update.show・前方一致の文字列を直接登録）→ 従来どおり登録不可');
}

// =========================================================
console.log('\n--- モデル更新の評価: 既存フィールドを使う手順（REUSE_FIELD・設定の変更なし）を承認すれば、依存する手順を反映できる ---');
{
  const { KTPlanReview: PR, KTPlanExecutor: PE } = T;
  const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
  const sp = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], addMappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], ...o });
  const stp = (id, actionType, targetKind, targetRef, s = {}, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: sp(s), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PREVIEW_SUPPORTED', supported: true, reason: 'x' }, ...extra });
  const pfd = (temporaryId, label, suggestedCode, type) => ({ temporaryId, label, suggestedCode, type, typeValid: true, required: false, options: [], reason: '', evidenceIds: [], alternativeExistingFieldCode: null, codeConflict: false, labelDuplicate: false });
  const mk = (steps, proposedFields = []) => ({ planVersion: '1', requestId: 'tk-rc-reuse', goal: 'g', assessment: { summary: '' }, relevantFields: [], proposedFields, steps, alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED', solution: 'STANDARD', customizations: [] });
  const data = FX.makeData();
  const deps = KTDeps.buildDependencyData(data, KTDeps.normalizeFields(data.fields));
  const reuse = (ref) => stp('P1', 'REUSE_FIELD', 'FIELD', ref, {}, { execution: { mode: 'PLAN_ONLY', supported: false, reason: '既存フィールドを使う' } });
  const addField = stp('P2', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'DATE' }, { dependsOn: ['P1'] });
  const p = mk([reuse('owner'), addField], [pfd('NEW_FIELD_1', '確認日', 'checked_on', 'DATE')]);
  const rv = PR.review({ plan: p, data, deps, scan: null, incoming: null });
  const s2 = (list) => list.find(x => x.stepId === 'P2') || {};
  const both = safe(() => PE.classifySteps({ plan: p, review: rv, approvedSteps: ['P1', 'P2'] }), []);
  const only2 = safe(() => PE.classifySteps({ plan: p, review: rv, approvedSteps: ['P2'] }), []);
  assert(s2(both).status === 'PENDING', `既存フィールドを使う手順（P1・owner）も承認 → 依存する P2 を反映できる（以前は「依存する P1 が実行されない」で止まった）: ${s2(both).status} ${s2(both).message}`);
  //   簡素化 A（2026-10-16）: 以前は P1（既存フィールドを使うだけ・書き込みなし）の承認が無いと P2 を止めていた。書き込みの要らない手順は今の設定が内容を満たすので、
  //   承認の有無に関係なく依存を満たす（手順ごとの承認の名残り。値の無い手順は満たさない: tests/ai-no-change-steps §N2）
  assert(s2(only2).status === 'PENDING', `P1 を承認していなくても、既存フィールドを使う手順は依存を満たす: ${s2(only2).status} ${s2(only2).message}`);
  const rd = safe(() => PE.applyReadiness(p, rv), []);
  const rdOf = (id) => rd.find(x => x.stepId === id) || {};
  assert(rdOf('P1').apply === 'CONFIRM' && /設定の変更はありません/.test(rdOf('P1').message || '') && rdOf('P2').apply === 'AUTO', `承認前の見込み: P1 は確認（既存フィールドの利用）・P2 は自動で反映できる: ${JSON.stringify(rd.map(x => [x.stepId, x.apply]))}`);
  const mock = makeKintoneMock(data);
  const prepared = await PE.prepare(PR.executorOutput(p, rv, ['P1', 'P2']), { api: mock.api, appId: '310' });
  const log = prepared.status === 'PREPARED' ? await PE.executePreview(prepared, { api: mock.api, review: rv, data }) : null;
  const p2 = log ? (log.steps || []).find(x => x.stepId === 'P2') : null;
  assert(prepared.status === 'PREPARED' && p2 && p2.status === 'VERIFIED', `反映: P1（設定の変更なし）を承認して P2（確認日）を動作テスト環境へ追加・検証: ${prepared.status} ${p2 && p2.status}`);
  // 無いフィールドを「使う」手順は検証で無効 → 依存する手順も止める（従来どおり）
  const bad = mk([reuse('no_such_field'), addField], [pfd('NEW_FIELD_1', '確認日', 'checked_on', 'DATE')]);
  const rvBad = PR.review({ plan: bad, data, deps, scan: null, incoming: null });
  const badCls = safe(() => PE.classifySteps({ plan: bad, review: rvBad, approvedSteps: ['P1', 'P2'] }), []);
  assert(s2(badCls).status === 'BLOCKED', `無いフィールドを使う手順（検証で無効）に依存する手順は止める: ${s2(badCls).status} ${s2(badCls).reason}`);
}

// =========================================================
console.log('\n--- モデル更新の評価（実機）: 「error が自分の文言なら null」の条件では、前のイベントの表示は消えない（event.record に残らない）---');
{
  // 実機（gpt-6.1-sol / medium の BF-C）で生成されたコード。1,000,001 で警告 → 999,999 や空にしても警告が消えなかった
  //   （表示中も kintone.app.record.get() の amount.error は undefined、次の change でも event.record.amount.error は undefined。実機で確認）
  const SOL_DEVICE = "(function () {\n  'use strict';\n  const amountNotice = '注意：金額が100万円を超えています（この注意では保存を止めません）。';\n  kintone.events.on([\n    'app.record.create.show',\n    'app.record.edit.show',\n    'app.record.create.change.amount',\n    'app.record.edit.change.amount'\n  ], function (event) {\n    const field = event.record['amount'];\n    if (Number(field.value) > 1000000 && !field.disabled) {\n      if (!field.error || field.error === amountNotice) {\n        field.error = amountNotice;\n      }\n    } else if (field.error === amountNotice) {\n      field.error = null;\n    }\n    return event;\n  });\n  kintone.events.on(['app.record.create.submit', 'app.record.edit.submit'], function (event) {\n    const field = event.record['amount'];\n    if (field.error === amountNotice) {\n      field.error = null;\n    }\n    return event;\n  });\n})();";
  const EV = ['app.record.create.show', 'app.record.edit.show', 'app.record.create.change.amount', 'app.record.edit.change.amount'];
  const c = cust({ events: EV, fields: [{ code: 'amount', access: 'CONTROL', condition: 'amount > "1000000"' }] });
  const flagged = (rv) => (rv.checks || []).filter(x => x.name === 'error-clear-compare' && !x.ok);
  const sol = review(SOL_DEVICE, c);
  const x = flagged(sol)[0] || {};
  assert(x.severity === 'review' && /amount/.test(x.message || '') && /前のイベント/.test(x.message || '') && /undefined/.test(x.message || ''), `実機の sol のコード: 表示を消す条件が error の今の値を見ている → 確認（理由つき）: ${x.message}`);
  assert(codesOf(sol.registration.confirmations).includes('error-clear-compare') && !codesOf(sol.registration.blockers).includes('error-clear-compare'), '登録の判定は確認が必要（登録不可にはしない）');
  // 正しい書き方: 条件に当てはまらなければ比べずに null（RC 実機の terra のコード）・直接の参照でも比べていれば数える
  const ok1 = review(handler(EV, "    if (Number(record['amount'].value) > 1000000 && !record['amount'].disabled) {\n      record['amount'].error = '金額が100万円を超えています。';\n    } else {\n      record['amount'].error = null;\n    }"), c);
  const ng2 = review(handler(EV, "    if (Number(record['amount'].value) > 1000000) {\n      record['amount'].error = 'over';\n    } else if (record['amount'].error === 'over') {\n      record['amount'].error = null;\n    }"), c);
  const ng3 = review(handler(EV, "    if (record.amount.error) {\n      record.amount.error = null;\n    }\n    if (Number(record.amount.value) > 1000000) {\n      record.amount.error = 'over';\n    }"), c);
  assert(!flagged(ok1).length && flagged(ng2).length && flagged(ng3).length, `条件に当てはまらなければ null → 数えない／error を比べて消す（直接の参照・ドット記法）→ 数える: ${[ok1, ng2, ng3].map(r => flagged(r).length).join('/')}`);
  // 保存時（submit）の比較は数えない（保存は止まらず、表示も保存の後に消える）・既存のコードに元からあるものは数えない
  const sub = review(handler(['app.record.create.submit'], "    const f = record['amount'];\n    if (f.error === 'over') {\n      f.error = null;\n    }"), cust({ events: ['app.record.create.submit'] }));
  const base = handler(EV, "    if (record['amount'].error === 'over') {\n      record['amount'].error = null;\n    }");
  const existing = ext(base, "  kintone.events.on(['app.record.edit.submit'], function (event) {\n    return event;\n  });\n", cust({ strategy: 'EXTEND_EXISTING_JS', events: EV }));
  assert(!flagged(sub).length && !flagged(existing).length, '保存時の比較・既存のコードに元からある比較は数えない');
  assert(/警告が出る値から出ない値/.test((KTCodeReview.HOW_TO_CHECK || {})['error-clear-compare'] || ''), '確かめること: 警告が出る値から出ない値に変えて、表示が消えることを確かめる');
}

console.log(`\n${state.failed === 0 ? 'ALL PASSED' : 'FAILED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
