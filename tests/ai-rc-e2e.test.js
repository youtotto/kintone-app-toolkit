// 最終 RC の E2E（2026-10-04・実機）で見つけた生成コードの見逃しの回帰テスト
//
// 検証内容:
//   N3 使える画面の違う API: kintone.app.record.getFieldElement は PC のレコード詳細・印刷画面とモバイルのレコード詳細画面でしか使えない
//      （公式ドキュメント。作成・編集画面では null）。BF-C の生成コードは作成・編集画面のイベントでこれを使い、警告が出なかった。
//      簡素化 B（2026-10-17）: API の目録の使える画面（screens）と、それで handler の画面と照合する Toolkit の検査（api-screen）は削除した。
//      生成した候補の検査は生成工程（Gateway）が正本で、生成工程の検査には同じ規則が無く、移植していない（判定しない範囲として残る）。
//      ここに残すのは、目録がモバイルの getFieldElement / getFieldElements を知っていること（目録に無い API と扱わない）と、Toolkit が判定しないこと
//   N2 空の判定の undefined: 作成画面では空のフィールドの value が undefined になる（入力して消した後・保存時のイベントでも。実機）。
//      §2 手順 4 の生成（v3）は `=== null` と空文字だけで判定し、保存時の必須チェックが効かなかった。
//      C-1 第 2 段（§0d.4）で Toolkit の推定による判定（empty-undefined）は外した。生成工程で守る: AI版 sandbox/test/run.mjs §5
//      「S2_V3（実機 N2）: 作成画面の空（undefined）を見逃し、保存は止まらない」「S2_V3: 編集画面の空（''）では止まり、入力ありでは止まらない」
//      「S2_V2: undefined も判定して作成画面でも保存を止める」、worker/test/cases/required-effects.mjs「lock: …作成画面の空 → not-locked（…空は undefined の印）」。
//      ここに残すのは、記録した出力が生成の直後の modern JavaScript の修正とパッチの適用を通ること
//   表示を消す条件（実機の sol のコード。error の今の値を見て消す → 前のイベントの表示は event.record に残らないので消えない）:
//      簡素化 B（2026-10-17）: Toolkit の検査（error-clear-compare）は削除した。生成工程の検査にも同じ規則は無く、移植していない（判定しない範囲として残る）
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
//   2026-10-18（AI版 契約 20 §20）: 統合の書き込む本文は生成工程が合成して返す（generated.body）。記録した出力（記録の時点の受け渡し）には本文が無いので、
//   形式確認に渡すときはテストの偽の生成工程の本文（gwWithBody。既存の本文と patch から作る）を持たせる（記録の値は変えない）
const { gwWithBody } = require('./helpers/gw-hash.js');

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
console.log('\n--- N3 API の目録（簡素化 B: 使える画面の照合は削除）---');
{
  const apis = safe(() => KTJsCatalog.extractApis("kintone.mobile.app.record.getFieldElement('a'); kintone.mobile.app.getFieldElements('a');"), []);
  assert(apis.length === 2 && apis.every(a => a.known), `モバイルの getFieldElement / getFieldElements を目録に足す（Toolkit が知らない機能（API） と扱わない）: ${JSON.stringify(apis.map(a => [a.name, a.known]))}`);
  assert(Number(KTJsCatalog.CATALOG_VERSION) >= 2 && Number(KTScan.ANALYZER_VERSION) >= 15, `目録・解析の版を上げた（古い Field Scanner のキャッシュの API の判定を使わない）: ${KTJsCatalog.CATALOG_VERSION} / ${KTScan.ANALYZER_VERSION}`);
  assert(typeof KTJsCatalog.apiScreens === 'undefined' && !('api-screen' in (KTCodeReview.HOW_TO_CHECK || {})), '簡素化 B: 使える画面（apiScreens）と api-screen の確かめ方は持たない');
}

// =========================================================
console.log('\n--- N3 実機の再生（RC E2E の BF-C）: 作成・編集画面のイベントで getFieldElement（Toolkit は判定しない）---');
{
  const data = JSON.parse(JSON.stringify(DATA));
  const rv = KTCodeReview.review({ generated: E2E.BFC.generated, customization: E2E.BFC.customization, plan: null, data, scan: null, existingSource: { name: 'dealLock.js', target: 'desktop', text: R.DEAL_LOCK } });
  assert(E2E.BFC.review.verdict === 'NEEDS_CONFIRMATION' && /getFieldElement/.test(E2E.BFC.generated.code), '前提: 実機の判定は確認が必要（getFieldElement を見逃した）');
  assert(!rv.checks.some(x => x.name === 'api-screen') && !codesOf(rv.registration.blockers).includes('api-screen'), `簡素化 B: Toolkit のコードの検査は使える画面を照合しない（AI サービスの検査にも同じ規則は無い）: ${JSON.stringify(codesOf(rv.registration.blockers))}`);
}

// =========================================================
console.log('\n--- N2 実機の再生（RC E2E の §2 手順 4）: 記録した出力のパッチを適用できる（記法はAI サービスのコードの検査・空の判定の undefined は模擬テスト）---');
{
  const edited = R.DEAL_VALIDATE.replace(/\s*$/, '') + '\n// 別の担当者のメモ（RC E2E: 外部からの変更の確認）\n';
  assert(KTScan.hashText(edited) === '17734541' && KTScan.hashText(R.DEAL_VALIDATE) === '6a64035a', `前提: 別の担当者の変更の後の dealValidate.js を再現（指紋 17734541）: ${KTScan.hashText(edited)}`);
  //   簡素化 B（2026-10-16）: 記法（var）の自動修正と検査は生成工程（Gateway の modern-js.mjs）だけが行う（Toolkit の写しの KTModernJs は削除。追加した var だけを直し、
  //   既存の var を変えないことは AI版 worker/test/cases/modern-js.mjs が確かめる）。Toolkit の形式確認は記録した出力（var を含む）をそのまま検査する
  const src3 = { name: 'dealValidate.js', target: 'desktop', text: edited };
  const v3 = KTCodeReview.review({ generated: gwWithBody(E2E.S2_V3.generated, edited), customization: E2E.S2_V3.customization, plan: null, data: JSON.parse(JSON.stringify(DATA)), scan: null, existingSource: src3 });
  assert(!v3.checks.some(x => x.name === 'modern-js'), 'Toolkit のコードの検査は記法を確かめない（AI サービスのコードの検査の modern-js が確かめる）');
  // 段階 C（5.5 の縮小）: 既存の handler の var は自動では変えない（直すのは追加した var だけ）。既存の var amount は変更していない行なので記法の検査の対象外
  assert(/var amount = event\.record\['amount'\]\.value;/.test(v3.finalCode || '') && v3.checks.some(x => x.name === 'patch' && /元のコードは保持（既存の行の削除なし）$/.test(x.message)) && v3.finalCode === gwWithBody(E2E.S2_V3.generated, edited).body, `既存の dealValidate.js の var amount はそのまま（受け取った統合の本文のまま書き込む。既存の var を変えないのはAI サービスの合成）: ${JSON.stringify(v3.checks.filter(x => /^patch/.test(x.name)).map(x => x.message))}`);
  assert(!check(v3, 'patch').length, '再生の前提: 統合の本文を受け取れる（patch の確認に止める項目が無い）');
  // v3 の空の判定（undefined を扱わない）・v2（undefined も判定）の違いは、生成工程の模擬テストが確かめる（sandbox/test/run.mjs §5 の S2_V3・S2_V2）
}

// N2 空の判定の書き方（empty-undefined の検出の範囲）は C-1 第 2 段（§0d.4）で判定ごと外した。生成工程で守る回帰はファイルの先頭の説明のとおり

// =========================================================
console.log('\n--- モデル更新（gpt-6.1-sol）の評価で見つけた誤検知: 正しいコードを登録不可にしない ---');
{
  const M = require('./fixtures/rc-model-replay.js');
  const data = JSON.parse(JSON.stringify(DATA));
  const run = (x) => KTCodeReview.review({ generated: gwWithBody(x.generated, R.DEAL_LOCK), customization: x.customization, plan: null, data, scan: null, existingSource: { name: 'dealLock.js', target: 'desktop', text: R.DEAL_LOCK } });
  // 1) error = null（空白を挟む普通の書き方）をエラーの設定と数えない
  const bfc = run(M.SOL_BFC);
  assert(M.SOL_BFC.verdictAtRun === 'BLOCKED' && /field\.error = null/.test(M.SOL_BFC.generated.code), '前提: 実行時の判定は登録不可（保存時の分岐の field.error = null を数えた）');
  // 同じイベントの error と編集不可の判定（error-cancels-edit）は §0d.4 で外した。生成工程で守る: AI版 worker/test/cases/required-effects.mjs「§0d.1 S7（既知の競合）」（排他的な分岐の正しい候補を機械検査で止めない）
  assert(bfc.registration.verdict !== 'BLOCKED', `SOL_BFC: 注意は編集不可（!field.disabled）を見る条件の中だけ・保存時は null で消すだけ → コードの検査では登録不可にしない: ${bfc.registration.verdict} ${JSON.stringify(codesOf(bfc.registration.blockers))}`);
  //   簡素化 B（2026-10-17）: error = null の数え方（Toolkit の kintoneFieldOps）は、Toolkit のエラー表示の規則と一緒に削除した
  assert(typeof KTCodeReview.kintoneFieldOps === 'undefined', 'error = null の数え方は Toolkit に無い（AI サービスの検査と模擬テスト）');
  const genuine = review(handler(['app.record.edit.show'], "    if (record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }\n    if (Number(record['amount'].value) > 1000000) {\n      record['amount'].error = '金額が大きい';\n    } else {\n      record['amount'].error = null;\n    }"), cust({ fields: [{ code: 'amount', access: 'CONTROL' }] }));
  // §0d.4: 競合の断定は生成工程（Gateway の check behavior・candidate-error-same-event と模擬テスト。AI版 required-effects.mjs「§0d.1 S7」・sandbox/test/run.mjs「R13 同じ handler」）。
  //   Toolkit は生成工程の結果を取り込み、結果が無い（返却の欠落）・模擬テストの fail（明示された失敗）なら登録不可にする（attachBehavior）
  const REQ_G = [{ requirementId: 'C1', field: 'amount', effect: 'lock', events: ['app.record.edit.show'], condition: 'ステータス in ("承認済み")' }];
  const GW_G = { requiredEffects: [{ requirementId: 'C1', field: 'amount', effect: 'lock', status: 'present', check: 'behavior', checkReason: ['candidate-error-same-event'], events: [{ event: 'app.record.edit.show', status: 'present' }] }],
    behavior: { status: 'failed', reason: null, cases: [{ id: 'k1', field: 'amount', effect: 'lock', expect: 'lock', event: 'app.record.edit.show', side: 'match', verdict: 'fail', message: '承認済みで金額が編集できます（同じイベントの error で編集不可が取り消されました）' }] } };
  const gNone = KTCodeReview.attachBehavior(genuine, null, { requiredEffects: REQ_G, customization: cust() });
  const gFail = KTCodeReview.attachBehavior(genuine, GW_G, { requiredEffects: REQ_G, customization: cust() });
  assert(gNone.registration.verdict === 'BLOCKED' && check(gNone, 'required-effects').some(x => x.severity === 'block'), `編集不可を見ずにエラーを出す（同じイベントで disabled）→ AI サービスの結果が無い間は登録不可（返却の欠落）: ${gNone.registration.verdict}`);
  assert(gFail.registration.verdict === 'BLOCKED' && check(gFail, 'behavior-fail').some(x => x.severity === 'block'), `同じ候補で模擬テストが編集不可の取り消しを見つけた（AI サービスの behavior の fail）→ 登録不可: ${gFail.registration.verdict}`);
  // 2) 画面を見分ける前方一致の文字列（'app.record.index.'）を、登録しているイベント名と取り違えない
  const cx1 = run(M.SOL_CX1);
  assert(M.SOL_CX1.blockersAtRun.includes('events') && /indexOf\('app\.record\.index\.'\)/.test(M.SOL_CX1.generated.code), '前提: 実行時は「kintone に無いイベント: app.record.index.」で登録不可');
  assert(!codesOf(cx1.registration.blockers).includes('events'), `SOL_CX1: event.type.indexOf('app.record.index.') は登録しているイベントではない → events で止めない: ${JSON.stringify(codesOf(cx1.registration.blockers))}`);
  //   簡素化 B（2026-10-17）: 登録しているイベント名が kintone に無いことは、生成工程の機械検査（events。block）が確かめる（Toolkit の events は削除した）。
  //   Toolkit はその結果を登録不可として取り込む
  const directBad = review("(function () {\n  kintone.events.on('app.record.update.show', function (event) {\n    return event;\n  });\n})();");
  const directV = KTCodeReview.attachBehavior(directBad, { version: '1', candidateHash: '0123456789abcdef', passed: false, machine: [{ name: 'events', ok: false, severity: 'block', message: 'kintone に無いイベントをコードで使っています: 「app.record.update.show」' }], requiredEffects: [], behavior: { status: 'not-run', reason: 'machine-blocked', cases: [] } }, { requiredEffects: [], customization: cust() });
  assert(!codesOf(directBad.registration.blockers).includes('events') && directV.registration.verdict === 'BLOCKED' && codesOf(directV.registration.blockers).includes('events'), '登録しているイベント名が kintone に無い → AI サービスの events（block）で登録不可（Toolkit は判定し直さない）');
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
  const prepared = await PE.prepare(PR.executorOutput(p, rv, ['P1', 'P2']), { api: mock.api, current: await mock.current(), appId: '310' });
  const log = prepared.status === 'PREPARED' ? await PE.executePreview(prepared, { api: mock.api, review: rv }) : null;
  const p2 = log ? (log.steps || []).find(x => x.stepId === 'P2') : null;
  assert(prepared.status === 'PREPARED' && p2 && p2.status === 'VERIFIED', `反映: P1（設定の変更なし）を承認して P2（確認日）を動作テスト環境へ追加・検証: ${prepared.status} ${p2 && p2.status}`);
  // 無いフィールドを「使う」手順は検証で無効 → 依存する手順も止める（従来どおり）
  const bad = mk([reuse('no_such_field'), addField], [pfd('NEW_FIELD_1', '確認日', 'checked_on', 'DATE')]);
  const rvBad = PR.review({ plan: bad, data, deps, scan: null, incoming: null });
  const badCls = safe(() => PE.classifySteps({ plan: bad, review: rvBad, approvedSteps: ['P1', 'P2'] }), []);
  assert(s2(badCls).status === 'BLOCKED', `無いフィールドを使う手順（検証で無効）に依存する手順は止める: ${s2(badCls).status} ${s2(badCls).reason}`);
}

console.log(`\n${state.failed === 0 ? 'ALL PASSED' : 'FAILED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
