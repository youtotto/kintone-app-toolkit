// KTQueryCheck（Phase 10）: kintone の「アプリの設定を変更する操作」で受理される条件式かを Toolkit 側で決定的に検査する
//
// 根拠: cybozu developer network「クエリの書き方」の演算子 / 関数 / API ごとの追加の制限（2026-10-02 確認）
// 実行方法: node tests/ai-query-check.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { KTQueryCheck: Q, KTPlanReview } = loadToolkit();
const { assert, state } = makeAssert();

const F = { owner: { type: 'USER_SELECT' }, org: { type: 'ORGANIZATION_SELECT' }, grp: { type: 'GROUP_SELECT' }, amount: { type: 'NUMBER' }, total: { type: 'CALC' }, due_date: { type: 'DATE' }, at: { type: 'DATETIME' }, tm: { type: 'TIME' }, case_name: { type: 'SINGLE_LINE_TEXT' }, url: { type: 'LINK' }, memo: { type: 'MULTI_LINE_TEXT' }, rich: { type: 'RICH_TEXT' }, file: { type: 'FILE' }, kind: { type: 'DROP_DOWN' }, tags: { type: 'CHECK_BOX' }, lk: { type: 'LOOKUP', baseType: 'NUMBER' }, ref: { type: 'REFERENCE_TABLE' }, sub_amount: { type: 'NUMBER', subtable: 'tbl' }, 'ステータス': { type: 'STATUS' }, '作成者': { type: 'CREATOR' }, '更新日時': { type: 'UPDATED_TIME' } };
const ok = (c, usage = 'view') => Q.check(c, { fields: F, usage }).ok;
const codesOf = (c, usage = 'view') => Q.check(c, { fields: F, usage }).errors.map(e => e.code);

console.log('\n--- 1. 構文 ---');
assert(ok('') && Q.check('', { fields: F }).empty, '空は OK（条件なし）');
assert(ok('amount >= "1000000"') && ok('amount >= 1000000') && ok('case_name = "A"') && ok('case_name like "株式会社"') && ok('kind in ("A", "B")') && ok('kind not in ("")') && ok('memo is empty') && ok('memo is not empty'), '基本の演算子');
assert(ok('(owner in (LOGINUSER())) and (amount >= "1")') && ok('due_date <= FROM_TODAY(30, DAYS) and ステータス not in ("完了")'), '括弧・and・関数');
assert(codesOf('なし').includes('COND_SYNTAX') && codesOf('担当者が空から設定された場合').includes('COND_SYNTAX'), '散文は COND_SYNTAX');
assert(codesOf('NOT(IS_NULL(owner)) AND PREVIOUS_VALUE(owner) != owner').includes('COND_SYNTAX'), 'kintone に無い関数式は構文で落ちる');
assert(codesOf('owner = LOGIN_USER()').includes('COND_UNKNOWN_FUNCTION') && codesOf('owner = LOGIN_USER()').includes('COND_OPERATOR_NOT_ALLOWED'), 'LOGIN_USER（綴り違い）→ 未知の関数・= も不可');
assert(codesOf("case_name = 'A'").includes('COND_SYNTAX') && codesOf('case_name = "A').includes('COND_SYNTAX') && codesOf('amount >= "1" order by amount').includes('COND_SYNTAX'), "シングルクオート・閉じ忘れ・order by は COND_SYNTAX");
assert(codesOf('amount >= "1" or amount <= "5" and kind in ("A")').includes('COND_MIXED_AND_OR') && ok('amount >= "1" or amount <= "5"'), 'and と or の混在は不可（設定の制限）');
assert(codesOf('amount >= case_name').includes('COND_SYNTAX'), 'フィールド同士の比較は不可');
assert(ok('case_name = "引用\\"符"'), 'エスケープした " を含む文字列');

console.log('\n--- 2. 型ごとの演算子（設定の操作）---');
assert(codesOf('owner != ""').includes('COND_OPERATOR_NOT_ALLOWED') && ok('owner not in ("")') && ok('owner in (LOGINUSER())'), 'USER_SELECT は in / not in だけ（!= は不可）');
assert(codesOf('amount > "1"').includes('COND_OPERATOR_NOT_ALLOWED') && ok('amount >= "1"') && codesOf('lk > 1').includes('COND_OPERATOR_NOT_ALLOWED'), 'NUMBER / CALC / ルックアップ（基の型 NUMBER）は > < が使えない');
assert(codesOf('case_name not in ("a")').includes('COND_OPERATOR_NOT_ALLOWED') && ok('case_name in ("a")') && ok('url like "http"'), '文字列（1行）/ リンクは not in が使えない');
assert(ok('memo like "x"') && codesOf('memo = "x"').includes('COND_OPERATOR_NOT_ALLOWED') && ok('rich not like "x"') && ok('file is empty'), '複数行 / リッチ / 添付');
assert(ok('ステータス in ("完了")') && codesOf('ステータス = "完了"').includes('COND_OPERATOR_NOT_ALLOWED'), 'ステータスは設定の操作では in / not in だけ');
assert(ok('作成者 in (LOGINUSER())') && ok('レコード番号 >= 10') && codesOf('レコード番号 > 10').includes('COND_OPERATOR_NOT_ALLOWED') && ok('$id = 5'), 'システム識別子（作成者 / レコード番号 / $id）');
assert(ok('due_date = TODAY()') && codesOf('due_date = NOW()').includes('COND_FUNCTION_NOT_ALLOWED') && ok('at = NOW()') && ok('更新日時 = THIS_MONTH()'), '日付には NOW() が使えない・日時には使える');
assert(codesOf('amount = TODAY()').includes('COND_FUNCTION_NOT_ALLOWED') && codesOf('owner in (PRIMARY_ORGANIZATION())').length === 0 && codesOf('grp in (LOGINUSER())').includes('COND_FUNCTION_NOT_ALLOWED'), '関数は型に合うものだけ（グループ選択には関数なし）');
assert(codesOf('due_date <= FROM_TODAY(30)').includes('COND_VALUE_TYPE') && ok('due_date <= FROM_TODAY(-30, DAYS)'), 'FROM_TODAY は (数値, 単位)');
assert(codesOf('case_name = 123').includes('COND_VALUE_TYPE') && ok('amount = 123'), '数値リテラルは数値型だけ');
assert(codesOf('sub_amount >= "1"').includes('COND_FIELD_NOT_ALLOWED'), 'テーブル内フィールドは in / not in でだけ');
assert(ok('ref.name in ("a")') || codesOf('ref.name in ("a")').every(c => c === 'COND_UNKNOWN_FIELD'), '関連レコードのフィールドは判定しない（参照先の型に依存）');
assert(codesOf('ghost = "1"').includes('COND_UNKNOWN_FIELD'), '存在しないフィールド');

console.log('\n--- 3. API ごとの追加の制限 ---');
assert(codesOf('owner in (LOGINUSER())', 'perRecordNotification').includes('COND_FUNCTION_NOT_ALLOWED') && ok('owner not in ("")', 'perRecordNotification') && codesOf('memo like "x"', 'perRecordNotification').includes('COND_FIELD_NOT_ALLOWED'), 'レコードの条件通知: LOGINUSER 不可・複数行 / リッチ / 添付 / 関連レコードは条件にできない');
assert(codesOf('owner in (LOGINUSER())', 'reminder').includes('COND_FUNCTION_NOT_ALLOWED') && ok('due_date <= FROM_TODAY(30, DAYS)', 'reminder') && ok('memo like "x"', 'reminder'), 'リマインダー: LOGINUSER 不可・複数行は可');
assert(codesOf('ステータス in ("完了")', 'process').includes('COND_FIELD_NOT_ALLOWED') && ok('amount >= "1000000"', 'process') && codesOf('amount > "1000000"', 'process').includes('COND_OPERATOR_NOT_ALLOWED'), 'プロセス管理: ステータスは条件にできない・> は不可（実機の挙動と一致）');
assert(codesOf('case_name like "a"', 'recordAcl').includes('COND_OPERATOR_NOT_ALLOWED') && codesOf('due_date = TODAY()', 'recordAcl').includes('COND_FUNCTION_NOT_ALLOWED'), 'レコードのアクセス権: like / 関数は不可');
assert(ok('owner in (LOGINUSER())', 'view') && ok('memo like "x"', 'view'), '一覧は追加の制限なし');

console.log('\n--- 4. KTPlanReview との連携 ---');
{
  const FX = require('./fixtures/ai-context-app.js');
  const DATA = FX.makeData();
  const step = (id, actionType, targetKind, targetRef, sp) => ({ id, actionType, targetKind, targetRef, title: id, proposal: { summary: '', details: [] }, spec: sp, dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null });
  const plan = (steps) => ({ planVersion: '1', goal: 'g', assessment: { summary: '' }, relevantFields: [], proposedFields: [], steps, alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED' });
  const rv = (p) => KTPlanReview.review({ plan: p, data: DATA });
  const bad = rv(plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', 'x', { targets: ['FIELD_ENTITY:owner'], filterCond: 'owner != ""' })])).steps[0];
  assert(bad.status === 'NEEDS_CONFIRMATION' && bad.issues.some(i => i.code === 'COND_INVALID' && /!=/.test(i.message) && i.conditionErrors), 'Review: 受理されない条件式は COND_INVALID（要確認）と理由');
  const fn = rv(plan([step('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', 'x', { targets: ['FIELD_ENTITY:owner'], filterCond: 'owner in (LOGINUSER())' })])).steps[0];
  assert(fn.issues.some(i => i.code === 'COND_INVALID' && /LOGINUSER/.test(i.message)), 'Review: レコードの条件通知で LOGINUSER() は COND_INVALID');
  const okv = rv(plan([step('P1', 'ADD_VIEW', 'VIEW', 'v', { name: 'v', fields: ['case_name'], filterCond: 'owner in (LOGINUSER()) and amount >= "1"' })])).steps[0];
  assert(!okv.issues.some(i => /^COND_/.test(i.code)), 'Review: 一覧の正しい条件式は指摘なし');
  const pr = rv(plan([step('P1', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', 'a', { name: 'a', from: '未処理', to: '承認待ち', filterCond: 'amount > "1000000"' })])).steps[0];
  assert(pr.issues.some(i => i.code === 'COND_INVALID' && />/.test(i.message)), 'Review: プロセスの条件で > は COND_INVALID（実機で設定できない）');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
