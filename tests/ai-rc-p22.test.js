// Phase 22（AI 開発支援の残課題修正と RC 準備）の回帰テスト
//
// 検証内容:
//   F-F2-1 条件つきロックの誤判定: 既存の条件つきの編集不可（承認済みのとき）を「条件なしに編集不可」と扱わない。
//          条件なし（E）と条件つき（D）を区別し、条件とロックの関係を保ったまま判定する
//          （§0d.4・2026-10-08: 条件とロックの関係の合否は生成工程（Gateway の機械検査と模擬テスト）が行う。Toolkit は生成工程の結果を取り込み、
//           登録の可否を明示された失敗・返却の欠落で決める。ここではその取り込みを、今の契約の形の結果で確かめる）
//   F-F2-2 変数経由のフィールド参照: const field = record['金額']; の field.disabled / field.error / field.value を、
//          直接（record.金額）・ブラケット（record['金額']）と同じに数える（Field Scanner の KTScan.analyzeFile）。
//          簡素化 B（2026-10-17）: 生成した候補を Toolkit が解析し直す関数（disableSites・inputChecks・fieldOperations・writeTargets）と、それを使う検査
//          （create-missing-field・target-fields・platform-fields など）は削除した（生成した候補の検査は生成工程。生成工程に無い規則は移植していない）
//   生成の拒否 AI がコード生成を断った（GENERATION_DECLINED）ことを、通信・認証・契約・時間切れ・応答形式の異常と区別して表示する。
//          前に生成したコード・計画の状態は変えず、再試行できる
//
// 実行方法: node tests/ai-rc-p22.test.js（KT_SRC=<別ビルド> で修正前の版に対して走らせると RED になる）
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
//   簡素化（2026-10-17）: 反映できるかは、最新の版なら会話の今の判定、前の版なら最終案の記録で確かめる（tests/helpers/final-state.js）
const FS = require('./helpers/final-state.js');
const { withDevBase } = require('./helpers/dev-base-fake.js');
const T2 = loadToolkit();
const { KTDeps, KTScan, KTCodeReview, KTAiClient, KTAiConversation, KTAiChatUi } = T2;
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const R = require('./fixtures/p21-bfc-replay.js');
//   2026-10-18（AI版 契約 20 §20）: 統合の書き込む本文は生成工程が合成して返す（generated.body）。記録した出力（記録の時点の受け渡し）と手作りの統合の候補には本文が無いので、
//   形式確認に渡すときはテストの偽の生成工程の本文（gwWithBody。既存の本文と patch から作る）を持たせる（記録の値は変えない）
const { gwWithBody } = require('./helpers/gw-hash.js');
// C-1 第 3 段（2026-10-08）: 新しい流れの共有の部品（会話の生成の拒否を、最終案の上で確かめる）
const { createNewFlowKit } = require('./helpers/new-flow.js');

// 修正前の版（KT_SRC）には無い関数を呼んでも落ちない（失敗として数える）
const safe = (fn, fallback = null) => { try { return fn(); } catch (e) { return fallback; } };
const tm = (code, dark) => safe(() => KTAiChatUi.themedMermaid(code, dark), null);
const handler = (events, body) => `(function () {\n  'use strict';\n  kintone.events.on(${JSON.stringify(events).replace(/"/g, "'")}, function (event) {\n    const record = event.record;\n${body}\n    return event;\n  });\n})();`;
const EDIT = ['app.record.edit.show'];

(async () => {
// =========================================================
console.log('\n--- F-F2 生成した候補の解析し直し（簡素化 B で削除）---');
{
  assert(['disableSites', 'inputChecks', 'fieldOperations', 'writeTargets', 'kintoneFieldOps'].every(n => typeof KTCodeReview[n] === 'undefined'), '生成した候補を Toolkit が解析し直す関数は持たない（候補の検査は生成工程）');
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
// §0d.4（2026-10-08）: 条件とロックの関係（条件の外・別の条件・既存のコードの条件）を Toolkit が推定する判定（conditional-control・
//   unconditional-control・existing-conflict・error-cancels-edit）は削除した。判定は生成工程（Gateway の機械検査と模擬テスト）が行い、
//   Toolkit はその結果（必須の効果の照合・模擬テストの明示された失敗・返却の欠落）を取り込んで登録の可否を決める。
//   下の偽の生成工程の結果は、今の契約の Gateway の形（requiredEffects[].status・check・checkReason・events と behavior.cases の side・expect・verdict）。
//   どのケースが fail になるかは、AI版の回帰で確かめた Gateway の代表条件（条件に合う → lock・合わない → not-locked、警告は warn・not-warned・warn-unlocked）に合わせた。
const DELETED_CHECKS = ['conditional-control', 'unconditional-control', 'existing-conflict', 'error-cancels-edit', 'error-cancels-other-js'];
const deletedIn = (rv) => (rv.checks || []).filter(x => DELETED_CHECKS.includes(x.name)).map(x => x.name);
const LOCK_COND = 'ステータス in ("承認済み")';
const effOf = (o) => ({ requirementId: 'C1', field: '金額', effect: 'lock', events: EDIT, condition: LOCK_COND, ...o });
/** Gateway の代表条件の結果（効果のイベントごとに「合う」と「合わない」。警告は「編集不可にしていない」warn-unlocked も）。fails: 不合格にするケースの [side, expect] */
const gwCasesOf = (e, fails = []) => {
  const exp = e.effect === 'warn' ? [['match', 'warn'], ['nomatch', 'not-warned'], ['match', 'not-locked']] : [['match', 'lock'], ['nomatch', 'not-locked']];
  return e.events.flatMap((ev, i) => exp.map(([side, expect], j) => {
    const fail = fails.some(([s, x]) => s === side && x === expect);
    return { id: `k${i}-${j}`, requirementId: e.requirementId, field: e.field, effect: e.effect, event: ev, side, expect, verdict: fail ? 'fail' : 'pass', message: fail ? `「${e.field}」が期待（${expect}）と違いました（${side === 'match' ? '条件に合う' : '条件に合わない'}レコード）` : '' };
  }));
};
const gwVerOf = (effects, cases) => ({
  requiredEffects: effects.map(e => ({ requirementId: e.requirementId, field: e.field, effect: e.effect, status: 'present', check: 'behavior', checkReason: e.effect === 'warn' ? ['effect-kind'] : ['conditional'], events: e.events.map(ev => ({ event: ev, status: 'present' })) })),
  behavior: { status: cases.some(k => k.verdict === 'fail') ? 'failed' : 'passed', cases },
});
const withGw = (rv, effects, cases, c = cust()) => KTCodeReview.attachBehavior(rv, cases === null ? null : gwVerOf(effects, cases), { requiredEffects: effects, customization: c });
const blockNames = (rv) => (rv.checks || []).filter(x => !x.ok && x.severity === 'block').map(x => x.name);
{
  // 新しいコード: 条件なし（E）・別の条件の中（DO）・変数経由の条件の外（AE）のロックは、Gateway の模擬テストの「合わない」（または「合う」）の
  //   不合格を取り込んで登録不可。計画の条件の中（D・AD）は Gateway の合格のまま通す。Toolkit は条件の推定による検査を出さない
  const E = review(handler(EDIT, "    record['金額'].disabled = true;"));
  const D = review(handler(EDIT, "    if (record['ステータス'].value === '承認済み') {\n      record['金額'].disabled = true;\n    }"));
  const DO = review(handler(EDIT, "    if (record['備考'].value) {\n      record['金額'].disabled = true;\n    }"));
  const AE = review(handler(EDIT, "    const field = record['金額'];\n    if (record['ステータス'].value === '承認済み') {\n      console.log('approved');\n    }\n    field.disabled = true;"));
  const AD = review(handler(EDIT, "    const field = record['金額'];\n    if (record['ステータス'].value === '承認済み') {\n      field.disabled = true;\n    }"));
  const L = [effOf()];
  assert([E, D, DO, AE, AD].every(r => !deletedIn(r).length && r.registration.verdict === 'RUNTIME_UNVERIFIED'), `形式確認だけでは条件とロックの関係を推定しない（削除した検査を出さない。生成工程の結果が無ければ動作は未確認）: ${JSON.stringify([E, D, DO, AE, AD].map(r => [r.registration.verdict, deletedIn(r)]))}`);
  const gE = withGw(E, L, gwCasesOf(L[0], [['nomatch', 'not-locked']]));
  assert(gE.registration.verdict === 'BLOCKED' && blockNames(gE).includes('behavior-fail'), `E（条件なし）の新しいロック → 生成工程の模擬テストの「合わない」の不合格で登録不可: ${gE.registration.verdict} ${JSON.stringify(blockNames(gE))}`);
  const gD = withGw(D, L, gwCasesOf(L[0]));
  assert(gD.registration.verdict === 'RUNTIME_UNVERIFIED' && !blockNames(gD).length, `D（計画の条件の中）の新しいロック → 生成工程の合格のまま通過（動作テスト環境での確認は残る）: ${gD.registration.verdict} ${JSON.stringify(blockNames(gD))}`);
  const gDO = withGw(DO, L, gwCasesOf(L[0], [['nomatch', 'not-locked']]));
  assert(gDO.registration.verdict === 'BLOCKED' && blockNames(gDO).includes('behavior-fail'), `別の条件（備考）の中の新しいロック → 生成工程の「合わない」（作成中・備考あり）の不合格で登録不可: ${JSON.stringify(blockNames(gDO))}`);
  const gAE = withGw(AE, L, gwCasesOf(L[0], [['nomatch', 'not-locked']]));
  assert(gAE.registration.verdict === 'BLOCKED' && blockNames(gAE).includes('behavior-fail'), `変数経由の条件の外のロック → 生成工程の不合格で登録不可（本当に危険なコードは止める）: ${JSON.stringify(blockNames(gAE))}`);
  const gAD = withGw(AD, L, gwCasesOf(L[0]));
  assert(gAD.registration.verdict === 'RUNTIME_UNVERIFIED' && !blockNames(gAD).length, `変数経由の条件の中のロック → 通過: ${gAD.registration.verdict}`);
  // 生成工程の結果が返らない（返却の欠落）ときは、Toolkit が自分で合否を作らずに登録不可（未確認を合格に読み替えない）
  const nE = withGw(E, L, null), nD = withGw(D, L, null);
  assert([nE, nD].every(r => r.registration.verdict === 'BLOCKED' && blockNames(r).includes('required-effects') && blockNames(r).includes('behavior-untested')), `生成工程の結果が無い → 条件の中のロックでも登録不可（required-effects・behavior-untested）: ${JSON.stringify([nE, nD].map(blockNames))}`);
}
{
  // 既存のコード（統合先）にあるロック: 条件なし（E）と別の条件の中（D）を分ける
  const BASE_E = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    const record = event.record;\n    record['金額'].disabled = true;\n    return event;\n  });\n})();\n";
  const BASE_D = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['金額'].disabled = true;\n    }\n    return event;\n  });\n})();\n";
  const warn = "  kintone.events.on(['app.record.edit.show', 'app.record.edit.change.金額'], function (event) {\n    const amount = event.record['金額'];\n    if (Number(amount.value) > 1000000 && !amount.disabled) {\n      amount.error = '金額が1,000,000円を超えています。';\n    } else {\n      amount.error = null;\n    }\n    return event;\n  });\n";
  const warnCust = cust({ requirement: '金額が100万円を超えたら警告する', strategy: 'EXTEND_EXISTING_JS', events: ['app.record.edit.show', 'app.record.edit.change.金額'], fields: [{ code: '金額', access: 'CONTROL', condition: '金額 >= "1000000" and 金額 != "1000000"' }], existingFiles: [{ name: 'lock.js', target: 'desktop' }] });
  const ext = (base, content, c) => KTCodeReview.review({ generated: gwWithBody(gen(content, { strategy: 'EXTEND_EXISTING_JS', targetFile: 'lock.js', patch: { baseHash: KTScan.hashText(base), operations: [{ type: 'INSERT_BEFORE', anchor: '})();', content }] } }), base), customization: c, plan: null, data: DATA, scan: null, existingSource: { name: 'lock.js', target: 'desktop', text: base } });
  // 警告の必須の効果（Gateway の代表条件: 合う → warn・合わない → not-warned・編集不可にしていない → not-locked。表示と金額の変更の両方のイベント）
  const W = [effOf({ effect: 'warn', events: ['app.record.edit.show', 'app.record.edit.change.金額'], condition: '金額 > 1000000' })];
  // 既存の条件つきロック（承認済みのとき）＋ 新しい入力チェック: Gateway の代表条件（作成中・100 万円超）では既存のロックは効かず、警告が出て編集もできる → 合格のまま
  const rD = ext(BASE_D, warn, warnCust);
  const gD = withGw(rD, W, gwCasesOf(W[0]), warnCust);
  assert(!deletedIn(rD).length && gD.registration.verdict !== 'BLOCKED' && !blockNames(gD).length, `既存の条件つきロック（D: 承認済みのとき）＋ 新しい入力チェック → Toolkit は条件の推定で確認・登録不可にしない（生成工程の合格のまま）: ${gD.registration.verdict} ${JSON.stringify(deletedIn(rD))}`);
  // 既存の条件なしロック（E）＋ 新しい入力チェック: 統合した候補では金額が常に編集不可なので、Gateway の warn-unlocked（not-locked）と「合う」の警告が不合格 → 登録不可
  const rE = ext(BASE_E, warn, warnCust);
  const gE = withGw(rE, W, gwCasesOf(W[0], [['match', 'warn'], ['match', 'not-locked']]), warnCust);
  assert(!deletedIn(rE).length && gE.registration.verdict === 'BLOCKED' && blockNames(gE).includes('behavior-fail'), `既存の条件なしロック（E）＋ 新しい入力チェック → 生成工程の warn-unlocked の不合格を取り込んで登録不可（Toolkit の推定の確認は出さない）: ${gE.registration.verdict} ${JSON.stringify(blockNames(gE))}`);
  // 既存の別の条件のロック ＋ 新しいロック（計画の条件の中）: 計画の効果（100 万円以上で編集不可）は Gateway の代表条件で合格。既存の承認済みのロックは計画の外の既存の動作で、
  //   Toolkit は「別の条件のときにも編集不可」を推定で確認にしない（隔離環境は統合した候補を動かして観測する: AI版 sandbox/test/run.mjs の R15）
  const lockCust = cust({ requirement: '金額が100万円以上なら金額を編集不可にする', strategy: 'EXTEND_EXISTING_JS', fields: [{ code: '金額', access: 'CONTROL', condition: '金額 >= "1000000"' }], existingFiles: [{ name: 'lock.js', target: 'desktop' }] });
  const both = ext(BASE_D, "  kintone.events.on(['app.record.edit.show'], function (event) {\n    if (Number(event.record['金額'].value) >= 1000000) {\n      event.record['金額'].disabled = true;\n    }\n    return event;\n  });\n", lockCust);
  const BL = [effOf({ condition: '金額 >= 1000000' })];
  const gB = withGw(both, BL, gwCasesOf(BL[0]), lockCust);
  assert(!deletedIn(both).length && gB.registration.verdict !== 'BLOCKED' && !blockNames(gB).length, `既存の別の条件のロック ＋ 新しいロック → Toolkit は推定の確認を出さず、生成工程の合格のまま: ${gB.registration.verdict} ${JSON.stringify(deletedIn(both))}`);
  const fB = withGw(both, BL, gwCasesOf(BL[0], [['nomatch', 'not-locked']]), lockCust);
  assert(fB.registration.verdict === 'BLOCKED' && blockNames(fB).includes('behavior-fail'), `同じ統合で、生成工程が「合わない」の不合格を返したら登録不可（明示された失敗は取り込む）: ${JSON.stringify(blockNames(fB))}`);
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
  //   簡素化 B（2026-10-16）: 記法（var）は生成工程の機械検査が確かめる（Toolkit の写しの自動修正 KTModernJs は削除）。記録した AI の出力（var を含む）をそのまま検査する
  const srcL = { name: 'dealLock.js', target: 'desktop', text: R.DEAL_LOCK };
  const rv = KTCodeReview.review({ generated: gwWithBody(R.GENERATED, R.DEAL_LOCK), customization: R.CUSTOMIZATION, plan: null, data, scan, existingSource: srcL });
  const codes = rv.registration.confirmations.map(x => x.code);
  assert(R.P21_CONFIRMATIONS.length === 4 && R.P21_CONFIRMATIONS.includes('conditional-control'), '前提: Phase 21 の判定は確認 4 件（conditional-control を含む）');
  // §0d.4: 条件とロックの関係・同じイベントの error と編集不可・既存のファイルとの重なりの推定（conditional-control・error-cancels-edit・existing-conflict）は削除。
  //   BF-C の候補（承認済みは既存のロック・作成中の 100 万円超は警告だけ）の実際の動きは、AI版の隔離環境の回帰（sandbox/test/run.mjs §4 の p21）で確かめている
  assert(!deletedIn(rv).length, `BF-C: Toolkit は条件・競合の推定の検査を出さない: ${JSON.stringify(deletedIn(rv))}`);
  // 段階 A（5.4）・簡素化 B（2026-10-17）: AI の申告の PARTIAL（承認済みでは警告を出さない）の確認は、生成工程の機械検査の coverage（review）が行う
  //   （Toolkit の coverage-unmet と、Toolkit だけの規則の重複した handler（duplicate-handler）は削除した）。Toolkit の形式確認だけでは確認事項にならない
  assert(!codes.some(x => DELETED_CHECKS.includes(x) || x === 'duplicate-handler' || x === 'coverage-unmet') && rv.registration.verdict !== 'BLOCKED', `BF-C: Toolkit の形式確認は候補の検査・申告の確認を作らない: ${JSON.stringify(codes)}`);
  const rvG = KTCodeReview.attachBehavior(rv, { version: '1', candidateHash: '0123456789abcdef', passed: true, machine: [{ name: 'coverage', ok: false, severity: 'review', message: 'この JavaScript の要件のうち満たせないと申告されたものがあります: 一部だけ「金額が1,000,000円を厳密に超えるとき…」' }], requiredEffects: [], behavior: { status: 'not-run', reason: 'no-required-effects', cases: [] } }, { requiredEffects: [], customization: R.CUSTOMIZATION });
  assert(rvG.registration.verdict === 'NEEDS_CONFIRMATION' && rvG.registration.confirmations.some(x => x.code === 'coverage'), 'BF-C: 生成工程の coverage の確認を取り込むと確認が必要');
  assert(!rv.registration.blockers.length, '登録不可にはならない（動作テスト環境での確認は残る）');
}

// =========================================================
console.log('\n--- F-F2 他の検査（簡素化 B で削除）: 作成画面のシステムフィールド・対象と異なるフィールド・PC とモバイル ---');
{
  //   簡素化 B（2026-10-17）: 作成画面で確かめずに読むシステムフィールド（create-missing-field）・計画に無いフィールドの書き換え（target-fields）・PC とモバイルの
  //   片方だけの処理（platform-fields）は Toolkit だけの規則で、削除した。作成画面の例外は生成工程の模擬テスト（作成画面の空のレコード）、画面ごとの処理は生成工程の
  //   必須の効果（効果のイベントごと）、計画に無い書き換えは生成工程の計画との一致（生成した AI が申告したフィールドだけ）の範囲（tests/ai-acceptance-p21.test.js）
  const data = JSON.parse(JSON.stringify(DATA));
  const mob = (body, events = ['mobile.app.record.create.show', 'mobile.app.record.edit.show']) => KTCodeReview.review({ generated: gen(`(function () {\n  'use strict';\n  kintone.events.on(${JSON.stringify(events).replace(/"/g, "'")}, function (event) {\n    const record = event.record;\n${body}\n    return event;\n  });\n})();`), customization: cust({ platform: ['mobile'], events }), plan: null, data, scan: null, existingSource: null });
  const aliasRead = mob("    const st = record['ステータス'];\n    if (st.value === '承認済み') {\n      record['金額'].disabled = true;\n    }");
  const off = review(handler(EDIT, "    if (record['ステータス'].value === '承認済み') {\n      record['金額'].disabled = true;\n    }\n    const memo = record['備考'];\n    memo.value = '承認済み';"));
  const REMOVED = ['create-missing-field', 'target-fields', 'platform-fields'];
  assert([aliasRead, off].every(r => !r.checks.some(x => REMOVED.includes(x.name)) && r.registration.verdict !== 'BLOCKED'), `Toolkit の形式確認は作成画面の読み方・計画に無い書き換えを判定しない: ${JSON.stringify([aliasRead, off].map(r => r.checks.filter(x => !x.ok).map(x => x.name)))}`);
}

// =========================================================
console.log('\n--- F-F2 Field Scanner（KTScan）: 日本語のコードのドット記法・変数に入れたフィールドのアクセス種別 ---');
{
  const fields = [{ code: '金額', label: '金額', type: 'NUMBER' }, { code: '備考', label: '備考', type: 'MULTI_LINE_TEXT' }];
  const a1 = KTScan.analyzeFile({ name: 'a.js', target: 'desktop', kind: 'js', text: handler(EDIT, "    record.金額.disabled = true;") }, { fields });
  assert(a1.fieldAccess['金額'] && a1.fieldAccess['金額'].CONTROL >= 1, `record.金額.disabled（日本語のコードのドット記法）→ 金額の CONTROL: ${JSON.stringify(a1.fieldAccess)}`);
  const a2 = KTScan.analyzeFile({ name: 'b.js', target: 'desktop', kind: 'js', text: handler(EDIT, "    const field = record['金額'];\n    field.disabled = true;\n    const memo = record['備考'];\n    console.log(memo.value);") }, { fields });
  assert(a2.fieldAccess['金額'] && a2.fieldAccess['金額'].CONTROL >= 1 && a2.fieldAccess['備考'] && a2.fieldAccess['備考'].READ >= 1 && !a2.fieldAccess['備考'].CONTROL, `変数に入れたフィールド: 金額は CONTROL・備考は READ（使われ方で数える）: ${JSON.stringify(a2.fieldAccess)}`);
  assert(Number(KTScan.ANALYZER_VERSION) >= 14, '解析ロジックの版を上げた（古い Field Scanner のキャッシュを使わない。後の版で上がっていてもよい）');
}

// =========================================================
console.log('\n--- 生成の拒否（GENERATION_DECLINED）: AI が生成しなかったことを、通信・認証・契約・時間切れ・応答形式の異常と区別する ---');
const GCTX = { contextVersion: 'customization-1', customization: { customizationId: 'C1', strategy: 'NEW_JS_FILE' } };
const reply = (status, body) => async () => ({ status, body: typeof body === 'string' ? body : JSON.stringify(body) });
const gwError = (status, code, detail = null) => reply(status, { ok: false, contractVersion: '2.1', error: { code, message: code, requestId: 'gen-x', ...(detail ? { detail } : {}) } });
const DECLINE_DETAIL = { reason: 'items が許可されたフィールドに無いため実装できません', coverage: [{ requirement: '承認済みでは明細を編集不可', status: 'NOT_MET', note: 'items が許可されたフィールドに無いため実装できません' }], warnings: [] };
const OK_BODY = { ok: true, contractVersion: '2.1', meta: { requestId: 'gen-x' }, generated: { strategy: 'NEW_JS_FILE', targetFile: 'a.js', summary: 's', code: "(function () {\n  kintone.events.on('app.record.edit.show', function (event) { return event; });\n})();", patch: null, events: ['app.record.edit.show'], fields: [], apis: ['kintone.events.on'], assumptions: [], warnings: [] }, verification: { version: '1', passed: true, machine: [], requiredEffects: [] } };
const aiClient = (transport) => KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 't.cybozu.com', transport, timeoutMs: 150 });
const tryGenerate = async (transport) => { try { return { ok: true, r: await aiClient(transport).generate({ ctx: GCTX, requestId: 'gen-x' }) }; } catch (e) { return { ok: false, e }; } };
{
  const hang = async ({ signal }) => new Promise((res, rej) => { if (signal) signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }); });
  const cases = [
    ['AI が生成しなかった（422 GENERATION_DECLINED）', gwError(422, 'GENERATION_DECLINED', DECLINE_DETAIL), 'GENERATION_DECLINED', 'declined'],
    ['通信（送れない）', async () => { throw new TypeError('Failed to fetch'); }, 'TRANSPORT_ERROR', 'network'],
    ['AI サービス（502 UPSTREAM_ERROR）', gwError(502, 'UPSTREAM_ERROR'), 'UPSTREAM_ERROR', 'network'],
    ['認証（401）', gwError(401, 'AUTH_INVALID_TOKEN'), 'AUTH_INVALID_TOKEN', 'auth'],
    ['契約・利用範囲（403 FEATURE_NOT_ENTITLED）', gwError(403, 'FEATURE_NOT_ENTITLED'), 'FEATURE_NOT_ENTITLED', 'license'],
    ['契約・利用範囲（429 MONTHLY_LIMIT_EXCEEDED）', gwError(429, 'MONTHLY_LIMIT_EXCEEDED'), 'MONTHLY_LIMIT_EXCEEDED', 'license'],
    ['時間切れ', hang, 'TIMEOUT', 'timeout'],
    ['応答形式の異常（502 MODEL_OUTPUT_INVALID）', gwError(502, 'MODEL_OUTPUT_INVALID'), 'MODEL_OUTPUT_INVALID', 'format'],
    ['応答形式の異常（JSON でない）', reply(200, '<html>maintenance</html>'), 'INVALID_RESPONSE', 'format'],
  ];
  const ok = await tryGenerate(reply(200, OK_BODY));
  assert(ok.ok && ok.r && typeof ok.r.code === 'string' && /kintone\.events\.on/.test(ok.r.code), '成功: AI が正常にコードを返した（例外なし・generated を返す）');
  for (const [label, transport, code, cat] of cases) {
    const r = await tryGenerate(transport);
    const e = r.e || {};
    assert(!r.ok && e.code === code && safe(() => KTAiClient.errorCategory(e.code)) === cat, `${label} → ${code}（種類 ${cat}）: ${e.code} / ${safe(() => KTAiClient.errorCategory(e.code))}`);
  }
  const d = await tryGenerate(gwError(422, 'GENERATION_DECLINED', DECLINE_DETAIL));
  assert(safe(() => KTAiClient.declineReasonOf(d.e)) === DECLINE_DETAIL.reason, 'AI の説明（Gateway が長さで切った理由）を取り出せる');
  const text = KTAiClient.errorText('GENERATION_DECLINED');
  assert(/AI はこの依頼に対するコード生成を行いませんでした/.test(text) && /通信や契約の問題ではありません/.test(text), `生成しなかったことが分かる文言（通信・契約の障害としない）: ${text}`);
  assert(!/契約形式/.test(KTAiClient.errorText('MODEL_OUTPUT_INVALID')) && /応答の形式/.test(KTAiClient.errorText('MODEL_OUTPUT_INVALID')), `応答形式の異常の文言に「契約」を使わない: ${KTAiClient.errorText('MODEL_OUTPUT_INVALID')}`);
  //   2026-10-15（ページ期限切れへの対応）: 種類「ページの有効期限」（PAGE_EXPIRED。接続・認証や契約にまとめない）を足したので 9 種類
  assert(Object.values(KTAiClient.CATEGORY_JA || {}).length === 9 && KTAiClient.CATEGORY_JA.declined === 'AI が生成しなかった' && KTAiClient.CATEGORY_JA.license === '契約・利用範囲' && KTAiClient.CATEGORY_JA.page === 'ページの有効期限', '種類の表示名（AI が生成しなかった・契約・利用範囲・ページの有効期限 …）');
}
{
  // 会話: 生成済みのコードがある状態で作り直しが拒否されても、前のコード・計画の状態は変わらない。拒否は再試行できる
  //   C-1 第 3 段（2026-10-08）: 新しい流れ（依頼 → 仮案 → 採用 → 最終案）の上で確かめる（共有の部品 tests/helpers/new-flow.js）。
  //   JavaScript の作り直しは最終案の作り直し（同じ計画の新しい版）で、生成の失敗は最終案の「実現できない点」に出る（従来の仕様の確定と、生成のエラーのカードは無い）。
  //   1 回目は検証を通らない候補（作り直せる）、2 回目は AI が生成を断る、3 回目は検証を通る候補
  const K = createNewFlowKit(T2);
  let n = 0;
  const base = K.makeGenerate({ sequence: ['bad', 'good'] });
  const gen = { calls: base.calls, impl: async (args) => { n += 1; if (n === 2) await aiClient(gwError(422, 'GENERATION_DECLINED', DECLINE_DETAIL)).generate({ ctx: GCTX, requestId: 'gen-y' }); return base.impl(args); } };
  const x = K.makeConvC({ generate: gen });
  await K.adoptC(x);
  const v = x.c.activePlan();
  const first = v && v.generated && v.generated.C1 ? v.generated.C1 : null;
  assert(first && first.generated && /kintone\.events\.on/.test(first.generated.code) && first.status !== 'verified', `前提: 1 回目の生成でコードがある（検証を通っていないので作り直せる）: ${JSON.stringify(Object.keys((v && v.generated) || {}))} ${first && first.status}`);
  const planBefore = JSON.stringify(v.plan);
  const res = await x.c.send('C1 のコードを作り直して');
  const v2 = x.c.activePlan();
  const e2 = v2 && v2.generated ? v2.generated.C1 : null;
  assert(res && res.intent === 'GENERATE_CODE' && v2 !== v && e2 && e2.status === 'failed' && e2.failure && e2.failure.reason === 'GENERATION_DECLINED' && v2.final && FS.readyOf(v2) === false, `拒否 → 最終案の JavaScript は「生成できなかった」（種類は AI が生成しなかった）: ${JSON.stringify(e2 && { status: e2.status, failure: e2.failure })}`);
  const cannot = (v2 && v2.final ? v2.final.cannot : []).filter(c => c.kind === 'failed');
  assert(cannot.length === 1 && cannot[0].text.includes(KTAiClient.errorText('GENERATION_DECLINED').slice(0, 40)) && /通信や契約の問題ではありません/.test(cannot[0].text) && /もう一度最終案を作る/.test(cannot[0].next), `拒否は通信・契約の障害と区別して書き、作り直せることを示す: ${JSON.stringify(cannot)}`);
  assert(v.generated.C1 === first && e2.generated === first.generated && JSON.stringify(v2.plan) === planBefore, '前に生成したコード・計画の状態は変わらない（前の版の結果は書き換えず、新しい版にも前のコードを持つ）');
  const html = K.finalHtml(x);
  assert(/AI はこの依頼に対するコード生成を行いませんでした/.test(html) && !/ネットワークエラー/.test(html), '最終案のカード: AI が生成しなかったことを出す（ネットワークエラーとしない）');
  //   C-1 第 3 段: 生成工程の 1 依頼（generateAndVerify）が AI の生成の拒否を受けたときは、AI の説明（KTAiClient.declineReasonOf）を
  //   最終案のカードの「実現できない点」に出す（以前はエラーのカードに「AI の説明: …」を出した）
  assert(/items が許可されたフィールドに無いため実装できません/.test(html),`最終案のカードに AI の説明（Gateway が返した理由）を出す: ${JSON.stringify(e2.failure)}`);
  const again = await x.c.send('C1 のコードを作って');
  const v3 = x.c.activePlan();
  assert(again && again.ok === true && v3 !== v2 && v3.generated.C1 && v3.generated.C1.status === 'verified' && FS.readyOf(v3) === true, '再試行（もう一度作る）で生成できる');
}

// =========================================================
console.log('\n--- 余計な確認: 確認の手順（REQUIRE_CONFIRMATION）を承認すれば、依存する手順を反映できる（必要な値が無い手順は従来どおり止める）---');
{
  const { KTPlanReview: PR, KTPlanExecutor: PE } = T2;
  const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
  const sp = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], addMappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], ...o });
  const stp = (id, actionType, targetKind, targetRef, s = {}, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: sp(s), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PREVIEW_SUPPORTED', supported: true, reason: 'x' }, ...extra });
  const pfd = (temporaryId, label, suggestedCode, type, extra = {}) => ({ temporaryId, label, suggestedCode, type, typeValid: true, required: false, options: [], reason: '', evidenceIds: [], alternativeExistingFieldCode: null, codeConflict: false, labelDuplicate: false, ...extra });
  const mk = (steps, proposedFields = []) => ({ planVersion: '1', requestId: 'tk-p22-conf', goal: 'g', assessment: { summary: '' }, relevantFields: [], proposedFields, steps, alternatives: [], impact: [], questions: [{ id: 'Q1', question: '「確認日」は日付のフィールドでよいですか？', reason: '種類の指定が無い', relatedEvidenceIds: [] }], unknowns: [], planConfidence: 'INFERRED', solution: 'STANDARD', customizations: [] });
  const data = FX.makeData();
  const deps = KTDeps.buildDependencyData(data, KTDeps.normalizeFields(data.fields));
  const confirm = stp('P1', 'REQUIRE_CONFIRMATION', 'NONE', null, {}, { execution: { mode: 'PLAN_ONLY', supported: false, reason: '確認事項' } });
  const addField = stp('P2', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'DATE' }, { dependsOn: ['P1'] });
  const p = mk([confirm, addField], [pfd('NEW_FIELD_1', '確認日', 'checked_on', 'DATE')]);
  const rv = PR.review({ plan: p, data, deps, scan: null, incoming: null });
  const both = PE.classifySteps({ plan: p, review: rv, approvedSteps: ['P1', 'P2'] });
  const only2 = PE.classifySteps({ plan: p, review: rv, approvedSteps: ['P2'] });
  const s2 = (list) => list.find(x => x.stepId === 'P2') || {};
  assert(s2(both).status === 'PENDING', `確認の手順（P1）も承認 → 依存する P2 を反映できる（以前は「依存する P1 が実行されない」で止まった）: ${s2(both).status} ${s2(both).message}`);
  assert(s2(only2).status === 'BLOCKED' && s2(only2).reason === 'DEPENDENCY_NOT_EXECUTABLE' && /確認の手順 P1 を承認すると反映できます/.test(s2(only2).message), `確認の手順を承認していなければ止め、承認すれば進めることを示す: ${s2(only2).message}`);
  const rd = PE.applyReadiness(p, rv);
  const rdOf = (id) => rd.find(x => x.stepId === id) || {};
  assert(rdOf('P1').apply === 'CONFIRM' && /承認すると確認済み/.test(rdOf('P1').message || '') && rdOf('P2').apply === 'AUTO', `承認前の見込み: P1 は確認事項・P2 は自動で反映できる: ${JSON.stringify(rd.map(x => [x.stepId, x.apply]))}`);
  // 反映: P2 だけを書き込む（確認の手順は設定を変えない）
  const mock = makeKintoneMock(data);
  const prepared = await PE.prepare(PR.executorOutput(p, rv, ['P1', 'P2']), { api: mock.api, current: await mock.current(), appId: '310' });
  const log = prepared.status === 'PREPARED' ? await PE.executePreview(prepared, { api: mock.api, review: rv }) : null;
  const p2 = log ? (log.steps || []).find(x => x.stepId === 'P2') : null;
  assert(prepared.status === 'PREPARED' && log && p2 && p2.status === 'VERIFIED', `確認の手順を承認して反映 → P2（確認日）を動作テスト環境へ追加・検証: ${prepared.status} ${JSON.stringify(prepared.blockers)} ${p2 && p2.status}`);
  // 必須の確認（回答が無いと安全に変更できない）: 依存する手順そのものに必要な値が無ければ、確認の手順を承認しても反映しない
  const remind = stp('P2', 'ADD_REMINDER', 'REMINDER', '期日の前日', { name: '期日の前日', timingField: 'due_date', daysLater: '-1', time: null, targets: ['FIELD_ENTITY:owner'], filterCond: '' }, { dependsOn: ['P1'] });
  const p3 = mk([confirm, remind]);
  const rv3 = PR.review({ plan: p3, data, deps, scan: null, incoming: null });
  const r3 = PE.classifySteps({ plan: p3, review: rv3, approvedSteps: ['P1', 'P2'] }).find(x => x.stepId === 'P2') || {};
  assert(r3.status !== 'PENDING', `必要な値（通知時刻）が無い手順は、確認の手順を承認しても反映しない: ${r3.status} ${r3.reason}`);
}

// =========================================================
console.log('\n--- ダークテーマのプロセス図: 暗い配色で描く（ライトは変えない）---');
{
  const { KTPlanReview: PR } = T2;
  const before = { states: [{ name: '作成中' }, { name: '承認待ち' }, { name: '承認済み' }], actions: [{ name: '申請する', from: '作成中', to: '承認待ち', filterCond: '' }, { name: '承認する', from: '承認待ち', to: '承認済み', filterCond: '' }] };
  const after = { states: [...before.states, { name: '部長承認待ち', origin: 'proposed' }], actions: [...before.actions, { name: '部長へ申請', from: '作成中', to: '部長承認待ち', filterCond: 'amount >= "1000000"' }] };
  const code = PR.processMermaid(after, before);
  assert(/fill:#e3f0ff,stroke:#1a73e8/.test(code) && /linkStyle \d+ stroke:#1a73e8,stroke-width:3px/.test(code), '前提: プロセス図は追加・変更を明るい青で強調する（ライトの配色）');
  const light = tm(code, false);
  assert(light === code, 'ライトテーマでは何も変えない（既存の表示のまま）');
  const dark = tm(code, true);
  assert(/^%%\{init: \{"theme": "base", "themeVariables": \{/.test(dark) && /"background": "transparent"/.test(dark) && /"primaryColor": "#1f2a3a"/.test(dark) && /"primaryTextColor": "#eef2f8"/.test(dark) && /"lineColor": "#9aa4b2"/.test(dark) && /"edgeLabelBackground": "#1b1b1b"/.test(dark), 'ダーク: 背景（透明）・ノード・文字・線・辺のラベルを暗い配色に');
  assert(!/#e3f0ff/.test(dark) && /fill:#16325c,stroke:#7fb2ff,color:#f5f8ff/.test(dark) && /stroke:#7fb2ff,stroke-width:3px/.test(dark) && !/stroke:#1a73e8/.test(dark), 'ダーク: 追加・変更の強調（明るい青）を暗い背景で読める色に替える');
  assert(tm(dark, true) === dark && tm('', true) === '', '二重に変換しない・空はそのまま');
  const wsDark = KTAiChatUi.workspaceHtml({ isDark: true, border: '#2a2a2a', bg: '#111' });
  const wsLight = KTAiChatUi.workspaceHtml({ isDark: false, border: '#ccc', bg: '#F5F5F5' });
  assert(/id="kt-ai-workspace" data-theme="dark"/.test(wsDark) && !/data-theme="dark"/.test(wsLight.replace(/#kt-ai-workspace\[data-theme="dark"\]/g, '')) && /#kt-ai-workspace\[data-theme="dark"\] \.mermaid svg\{ background:transparent !important; \}/.test(wsDark), '開発支援のタブにテーマを付け、ダークのときだけプロセス図の背景を透明にする');
  // 実機で見つけた漏れ: 開発支援タブの組み立て（renderAiWorkspace → mountAiWorkspace）が isDark を渡しておらず、ダークでも印が付かなかった
  const { makeFakeHost } = require('./helpers/fake-dom.js');
  for (const dark of [true, false]) {
    const T3 = loadToolkit();
    T3.__sandbox.matchMedia = () => ({ matches: dark, addEventListener() { } });
    const inner = makeFakeHost();
    const view = { innerHTML: '', querySelector: (sel) => (sel === '#kt-ai-host' ? inner : null) };
    T3.renderAiWorkspace({ querySelector: (sel) => (sel === '#view-ai' ? view : null) }, FX.makeData(), '310', { getContextInputs: () => ({ data: FX.makeData() }) });
    const html = String(inner.innerHTML || '');
    assert(/id="kt-ai-workspace"/.test(html) && (dark ? /id="kt-ai-workspace" data-theme="dark"/.test(html) : !/id="kt-ai-workspace" data-theme="dark"/.test(html)), `開発支援タブの組み立て（renderAiWorkspace）でも、${dark ? 'ダークのときは印（data-theme="dark"）を付ける' : 'ライトのときは印を付けない'}`);
  }
  // 実機で見つけた描画の問題: 隠れているペインで描くと Mermaid が大きさを 0 と計算し、図が 16px に潰れた（検証ペインの Before / After が見えなかった。ライトでも同じ）。
  //   表示されている図だけを描き、隠れている図はペインを開いたとき（showPane）に描く。
  //   2026-10-19: 右の「確認結果」のタブは廃止した。図のあるペインは「反映」（Before / Planned / Actual）と「変更内容」（［プロセス管理の変更前後（図）］は開いたときに描く。tests/ai-process-mermaid.test.js）
  {
    const T4 = loadToolkit();
    const ran = [];
    T4.__sandbox.mermaid = { run: ({ nodes }) => { ran.push(...nodes); return Promise.resolve(); } };
    const host = makeFakeHost();
    const panel = T4.mountAiWorkspace(host, withDevBase(T4, { getInputs: () => ({ data: FX.makeData() }), copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' } }));
    const mk = (visible) => ({ textContent: 'flowchart LR\n  S0["作成中"]\n  S1["承認待ち"]\n  S0 -->|申請する| S1', visible, getClientRects() { return this.visible ? [{ width: 100 }] : []; }, replaceWith(d) { this.replaced = d; } });
    const shownPre = mk(true), hiddenPre = mk(false);
    host.querySelector('#kt-ai-pane-exec').querySelectorAll = (sel) => (sel === 'pre.kt-ai-mermaid' ? [shownPre, hiddenPre].filter(p => !p.replaced) : []);
    panel.showPane('exec');
    assert(shownPre.replaced && !hiddenPre.replaced && ran.length === 1 && /flowchart LR/.test(ran[0].textContent), `表示されている図だけを描く（隠れている図は pre のまま残す）: ${ran.length}`);
    hiddenPre.visible = true;
    panel.showPane('exec');
    assert(hiddenPre.replaced && ran.length === 2, `ペインを開いた（見えた）ときに、残しておいた図を描く: ${ran.length}`);
  }
}

console.log(`\n${state.failed === 0 ? 'ALL PASSED' : 'FAILED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
