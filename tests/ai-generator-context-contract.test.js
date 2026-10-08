// 担当間の契約の素材（会話フローの再設計 §0c.7・2026-10-08）: Toolkit の KTContext.buildGenerator が作る Generator Context を固定する
//
// 決まったアプリの素材から、Toolkit の本物の関数（KTAiConversation.requiredEffectsOf → KTContext.buildGenerator）で Context を作り、
// tests/fixtures/generator-context-contract.json と一致するかを毎回確かめる（決定的。時刻・版は固定）。
// この JSON は結合の担当が AI版にも写して、Gateway の検証（validate-generator-context）と隔離環境（動作テスト）に通す。
//
// 素材に入れたもの:
//   - 既存 JS（tantou.js）が、計画に無いフィールド（担当 tantou）を編集画面で読む → verification.appFields にアプリのすべてのフィールドがあること
//   - 保存だけの警告（備考 memo が空なら保存のときに確認。効果の events は保存だけ）と、画面の編集不可（金額 amount。効果の events は表示だけ）を同じ customization に持つ
//   - 計画で新設するフィールド（NEW_FIELD_1 → approver_note）の編集不可（必須の効果は採番後のコード・appFields は planned）
//   - 選択肢のフィールド（区分 category・DROP_DOWN）は appFields に options（50 件まで）、テーブルの列（qty）は subtable
//   - 送れなかった既存 JS の形（URL 指定の外部のライブラリ events []・上限で送れなかった一覧画面だけの JS）
//     §0c.8（2026-10-08）: URL 指定のファイルの events は KTContext.relatedFilesFor（画面の generate と同じ関数）で決める。[] は既知のライブラリの配布元（js.cybozu.com など）だけ
//   - §0c.8: 入力できないフィールド（レコード番号・ステータス・計算・自動計算の文字列・ルックアップのコピー先）は appFields の readOnly: true
//
// 実行方法: node tests/ai-generator-context-contract.test.js
// 素材を変えたときの書き出し: UPDATE_CONTRACT=1 node tests/ai-generator-context-contract.test.js（差分を確かめてから commit する）
'use strict';
const fs = require('fs');
const path = require('path');
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const T = loadToolkit();
const { KTDeps, KTScan, KTContext, KTAiConversation } = T;
const { assert, state } = makeAssert();
const FIXTURE = path.join(__dirname, 'fixtures', 'generator-context-contract.json');
const NOW = '2026-10-08T00:00:00.000Z';

// ---- アプリの素材（kintone のフォームの設定の形）----
const DATA = {
  appId: '901',
  fields: {
    'レコード番号': { type: 'RECORD_NUMBER', code: 'レコード番号', label: 'レコード番号' },
    'ステータス': { type: 'STATUS', code: 'ステータス', label: 'ステータス', enabled: true },
    amount: { type: 'NUMBER', code: 'amount', label: '金額' },
    memo: { type: 'MULTI_LINE_TEXT', code: 'memo', label: '備考' },
    tantou: { type: 'SINGLE_LINE_TEXT', code: 'tantou', label: '担当' },
    customer: { type: 'SINGLE_LINE_TEXT', code: 'customer', label: '顧客名', required: true },
    category: { type: 'DROP_DOWN', code: 'category', label: '区分', options: { '新規': { label: '新規', index: '0' }, '更新': { label: '更新', index: '1' }, '解約': { label: '解約', index: '2' } } },
    total: { type: 'CALC', code: 'total', label: '合計', expression: 'SUM(qty)' },
    //   §0c.8: ルックアップ（キーは入力できる）とそのコピー先（入力できない）・自動計算の文字列 1 行（入力できない）
    kokyaku_lookup: { type: 'SINGLE_LINE_TEXT', code: 'kokyaku_lookup', label: '顧客コード', lookup: { relatedApp: { app: '902', code: '' }, relatedKeyField: 'code', fieldMappings: [{ field: 'kokyaku_name', relatedField: 'name' }], lookupPickerFields: ['name'], filterCond: '', sort: '' } },
    kokyaku_name: { type: 'SINGLE_LINE_TEXT', code: 'kokyaku_name', label: '顧客名（ルックアップ）' },
    title_auto: { type: 'SINGLE_LINE_TEXT', code: 'title_auto', label: '件名（自動計算）', expression: 'customer & "様"', hideExpression: false },
    items: { type: 'SUBTABLE', code: 'items', label: '明細', fields: { item_name: { type: 'SINGLE_LINE_TEXT', code: 'item_name', label: '品名' }, qty: { type: 'NUMBER', code: 'qty', label: '数量' } } },
  },
  status: { enable: true, states: { '作成中': { name: '作成中', index: '0' }, '承認待ち': { name: '承認待ち', index: '1' }, '承認済': { name: '承認済', index: '2' } }, actions: [] },
  layout: [],
  customize: { desktop: { js: [{ type: 'URL', url: 'https://js.cybozu.com/luxon/3.4.4/luxon.min.js' }, { type: 'FILE', file: { name: 'tantou.js', fileKey: 'K-TANTOU' } }, { type: 'FILE', file: { name: 'list.js', fileKey: 'K-LIST' } }, { type: 'FILE', file: { name: 'common.js', fileKey: 'K-COMMON' } }], css: [] }, mobile: { js: [], css: [] } },
};
// 既存 JS: 編集画面で計画に無いフィールド（担当）を読み、入力の補助をするだけ（kintone の状態は変えない）
const TANTOU_JS = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    var name = event.record['tantou'].value;\n    if (!name) console.log('担当が未入力です');\n    return event;\n  });\n})();";
//   §0c.10（2026-10-08）: 共通の関数を定義するだけのファイル（イベントを登録しない・必須の効果のフィールドを参照しない）。動作テストには送らず relatedOmitted（reason other・events []）で知らせる
const COMMON_JS = "window.KtCommon = { isBlank: function (v) { return v == null || v === ''; } };";
// 計画（承認済みでは金額と承認メモを編集不可・備考が空なら保存のときに確認）
const PLAN = {
  goal: '承認済みでは金額と承認メモを編集できないようにし、備考が空なら保存のときに確認する',
  proposedFields: [{ temporaryId: 'NEW_FIELD_1', suggestedCode: 'approver_note', label: '承認メモ', type: 'SINGLE_LINE_TEXT' }],
  steps: [
    { id: 'P1', actionType: 'ADD_FIELD', targetKind: 'FIELD', targetRef: 'NEW_FIELD_1', title: '承認メモ（文字列 1 行）を追加', spec: { type: 'SINGLE_LINE_TEXT', label: '承認メモ' }, dependsOn: [] },
    { id: 'C1', actionType: 'CUSTOMIZATION_REQUIRED', targetKind: 'JS', targetRef: null, title: 'JavaScript', spec: { customizationId: 'C1' }, dependsOn: ['P1'] },
  ],
  customizations: [{
    customizationId: 'C1', requirement: '承認済みでは金額と承認メモを編集不可にし、備考が空なら保存のときに確認する（保存は止めない）', whyStandardInsufficient: 'ステータスで編集可否を切り替えるアクセス権は無い',
    strategy: 'NEW_JS_FILE', implementation: 'JAVASCRIPT', platform: ['desktop'], events: ['app.record.edit.show', 'app.record.edit.submit'],
    fields: [
      { code: 'ステータス', access: 'READ', effects: [] },
      { code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済")', effects: [{ effect: 'lock', condition: '', events: ['app.record.edit.show'] }] },
      { code: 'NEW_FIELD_1', access: 'CONTROL', condition: 'ステータス in ("承認済")', effects: [{ effect: 'lock', condition: '', events: ['app.record.edit.show'] }] },
      { code: 'memo', access: 'CONTROL', effects: [{ effect: 'warn', condition: 'memo = ""', events: ['app.record.edit.submit'] }] },
    ],
    apis: [], existingFiles: [], risks: [], questions: [], dependsOn: ['P1'],
  }],
};
const LABELS = { amount: '金額', memo: '備考', tantou: '担当', 'ステータス': 'ステータス', approver_note: '承認メモ' };

/** 素材から Context を作る（毎回同じ結果になること。版の名前と大きさは固定の値に置き換える） */
function buildContract() {
  const fieldsN = KTDeps.normalizeFields(DATA.fields);
  const deps = KTDeps.buildDependencyData(DATA, fieldsN);
  const files = [{ name: 'tantou.js', target: 'desktop', kind: 'js', text: TANTOU_JS }, { name: 'luxon.min.js', target: 'desktop', kind: 'js', note: 'external URL (skipped)' }, { name: 'common.js', target: 'desktop', kind: 'js', text: COMMON_JS }];
  const scan = KTScan.buildPayload({ appId: DATA.appId, fields: KTScan.fieldList(DATA.fields, DATA.layout), files, deps, scannedAt: NOW, source: 'preview' });
  const req = KTAiConversation.requiredEffectsOf(PLAN, 'C1', [], { labels: LABELS });
  //   §0c.8: URL 指定のファイルの扱いは画面の generate と同じ関数（KTContext.relatedFilesFor）で決める（手で作らない）。
  //   list.js は上限で送れなかった形（一覧画面だけのイベント）を手で足す（4 件・合計 131,072 文字を超える素材は大きすぎるため）
  const urlSel = KTContext.relatedFilesFor(KTScan.summarizeFiles(scan, DATA).filter(f => f.url), { targets: ['desktop'], requiredEffects: req.effects });
  //   §0c.10: 関係しない本文ありのファイル（common.js）も画面の generate と同じ関数で relatedOmitted（reason other）にする
  const otherSel = KTContext.relatedFilesFor(KTScan.summarizeFiles(scan, DATA).filter(f => f.name === 'common.js'), { targets: ['desktop'], requiredEffects: req.effects });
  const verification = {
    requirementIds: [{ id: 'C1', kind: 'customization', text: PLAN.customizations[0].requirement }, { id: 'P1', kind: 'step', text: PLAN.steps[0].title }],
    requiredEffects: req.effects,
    relatedFiles: [{ name: 'tantou.js', target: 'desktop', text: TANTOU_JS }],
    relatedOmitted: [...urlSel.relatedOmitted, { name: 'list.js', target: 'desktop', reason: 'limit', events: ['app.record.index.show'] }, ...otherSel.relatedOmitted],
  };
  const ctx = KTContext.buildGenerator({ customization: PLAN.customizations[0], plan: PLAN, planId: 'plan_contract', version: 1, data: DATA, deps, scan, existingSource: null, userRequests: [PLAN.goal], decisions: [], verification, options: { now: NOW } });
  //   版の名前（Toolkit の版・解析器・目録）と大きさは版を上げるたびに変わるので、契約の素材では固定の値にする（Gateway は情報として受けるだけ）
  ctx.generator = { name: 'kintone App Toolkit', version: 'contract', analyzerVersion: 'contract', catalogVersion: 'contract' };
  ctx.size = null;
  return { req, ctx };
}

const { req, ctx } = buildContract();
const doc = {
  purpose: '担当間の契約の素材（会話フローの再設計 §0c.7）。Toolkit の KTContext.buildGenerator が作る Generator Context。tests/ai-generator-context-contract.test.js が毎回作り直して一致を確かめる。AI版に写して Gateway の検証と隔離環境に通す',
  material: '既存 JS（tantou.js）が計画に無いフィールド（担当）を編集画面で読む／保存だけの警告（備考）と画面の編集不可（金額）を同じ customization に持つ／計画で新設するフィールド（承認メモ）の編集不可／§0c.10: 関係しない共通の関数のファイル（common.js）は送らず relatedOmitted の reason other・events []',
  ctx,
};
const text = `${JSON.stringify(doc, null, 2)}\n`;
if (process.env.UPDATE_CONTRACT === '1') { fs.writeFileSync(FIXTURE, text); console.log(`書き出しました: ${FIXTURE}`); }

console.log('\n--- 契約の素材: 必須の効果（requiredEffectsOf）---');
const ef = (field, effect) => req.effects.find(e => e.field === field && e.effect === effect) || null;
assert(req.unresolved.length === 0 && req.effects.length === 3, `必須の効果は 3 件・特定できないものは無い: ${JSON.stringify(req)}`);
assert(ef('amount', 'lock') && JSON.stringify(ef('amount', 'lock').events) === JSON.stringify(['app.record.edit.show']) && ef('amount', 'lock').condition === 'ステータス in ("承認済")', `金額の編集不可は表示のイベントだけ・フィールドの条件: ${JSON.stringify(ef('amount', 'lock'))}`);
assert(ef('memo', 'warn') && JSON.stringify(ef('memo', 'warn').events) === JSON.stringify(['app.record.edit.submit']) && ef('memo', 'warn').condition === 'memo = ""', `備考の警告は保存のイベントだけ（保存だけの警告）・効果の条件: ${JSON.stringify(ef('memo', 'warn'))}`);
assert(ef('approver_note', 'lock') && !JSON.stringify(req).includes('NEW_FIELD_1'), `新設フィールドの必須の効果は採番後のコード（approver_note）: ${JSON.stringify(ef('approver_note', 'lock'))}`);

console.log('\n--- 契約の素材: Generator Context の形 ---');
const v = ctx.verification || {};
const app = (code) => (v.appFields || []).find(f => f.code === code) || null;
assert(Array.isArray(v.appFields) && app('tantou') && app('tantou').type === 'SINGLE_LINE_TEXT' && !ctx.fields.some(f => f.code === 'tantou'), `appFields に計画に無いフィールド（担当）がある（ctx.fields には無い。生成の AI には渡さない）: ${JSON.stringify(app('tantou'))}`);
assert(app('category') && JSON.stringify(app('category').options) === JSON.stringify(['新規', '更新', '解約']) && !('options' in app('amount')), `選択肢の型だけ options（kintone の並び順）: ${JSON.stringify([app('category'), app('amount')])}`);
assert(app('qty') && app('qty').subtable === 'items' && app('approver_note') && app('approver_note').planned === true, `テーブルの列は subtable・新設フィールドは planned: ${JSON.stringify([app('qty'), app('approver_note')])}`);
assert((v.appFields || []).every(f => Object.keys(f).every(k => ['code', 'type', 'label', 'subtable', 'planned', 'readOnly', 'options'].includes(k))), `appFields の項目は code・type・label・subtable・planned・readOnly・options だけ: ${JSON.stringify((v.appFields || []).map(f => Object.keys(f)))}`);
//   §0c.8（2026-10-08）: 入力できないフィールドは readOnly: true（ルックアップのキー・入力するフィールド・新設フィールドには付けない）
const ro = (code) => !!(app(code) && app(code).readOnly === true);
assert(['レコード番号', 'ステータス', 'total', 'kokyaku_name', 'title_auto'].every(ro) && !['kokyaku_lookup', 'amount', 'memo', 'tantou', 'customer', 'category', 'qty', 'approver_note'].some(ro), `readOnly は入力できないフィールドだけ（レコード番号・ステータス・計算・ルックアップのコピー先・自動計算の文字列）: ${JSON.stringify((v.appFields || []).filter(f => f.readOnly).map(f => f.code))}`);
//   §0c.8: URL 指定のファイルの events。既知のライブラリの配布元だけ []、それ以外（自社のサーバーなど）は null（画面とホストが違うかどうかでは決めない）
const urlOmitted = (url) => KTContext.relatedFilesFor(KTScan.summarizeFiles(null, { customize: { desktop: { js: [{ type: 'URL', url }] } } }), { targets: ['desktop'], requiredEffects: req.effects }).relatedOmitted[0] || null;
assert(JSON.stringify(urlOmitted('https://js.cybozu.com/luxon/3.4.4/luxon.min.js').events) === '[]' && urlOmitted('https://biz.example.co.jp/kintone/biz.js').events === null && urlOmitted('https://cdn.jsdelivr.net/gh/someone/repo/biz.js').events === null && urlOmitted('https://ajax.googleapis.com/other/biz.js').events === null && JSON.stringify(urlOmitted('https://ajax.googleapis.com/ajax/libs/jquery/3.7.1/jquery.min.js').events) === '[]', 'URL 指定の既存 JS: 既知のライブラリの配布元だけ events []・自社のサーバーや配布元の別のパスは null');
const custFields = ctx.customization.fields;
assert(JSON.stringify(custFields.find(f => f.code === 'memo').effects) === JSON.stringify([{ effect: 'warn', condition: 'memo = ""', events: ['app.record.edit.submit'] }]) && JSON.stringify(custFields.find(f => f.code === 'approver_note').effects) === JSON.stringify([{ effect: 'lock', condition: '', events: ['app.record.edit.show'] }]), `customization.fields[].effects は効果ごとの条件とイベント（新設フィールドのコードは採番後）: ${JSON.stringify(custFields)}`);
assert(JSON.stringify(v.relatedOmitted) === JSON.stringify([{ name: 'luxon.min.js', target: 'desktop', reason: 'url', events: [] }, { name: 'list.js', target: 'desktop', reason: 'limit', events: ['app.record.index.show'] }, { name: 'common.js', target: 'desktop', reason: 'other', events: [] }]) && v.relatedFiles.length === 1 && !('cases' in v), `送れなかった既存 JS（reason・events）と送る既存 JS。代表条件は送らない: ${JSON.stringify({ omitted: v.relatedOmitted, files: v.relatedFiles.map(f => f.name) })}`);
assert(ctx.generatedAt === NOW && ctx.size === null && ctx.generator.version === 'contract', '時刻・版・大きさは固定の値');

console.log('\n--- 契約の素材: 決定的に作れる・書き出した JSON と一致する ---');
const again = buildContract();
assert(JSON.stringify(again.ctx) === JSON.stringify(ctx), '同じ素材から 2 回作っても同じ Context になる（決定的）');
const saved = fs.existsSync(FIXTURE) ? fs.readFileSync(FIXTURE, 'utf8') : null;
assert(saved !== null && saved === text, `tests/fixtures/generator-context-contract.json と一致する（素材や buildGenerator を変えたら UPDATE_CONTRACT=1 で書き出し、差分を確かめる）${saved === null ? '（ファイルがありません）' : ''}`);
if (saved !== null && saved !== text) {
  const a = saved.split('\n'), b = text.split('\n');
  const i = a.findIndex((l, k) => l !== b[k]);
  console.log(`  最初に違う行 ${i + 1}: 保存 ${JSON.stringify(a[i])} / 今 ${JSON.stringify(b[i])}`);
}

console.log(`\n${state.passed} passed, ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
