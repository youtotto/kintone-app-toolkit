// §12.69（2026-10-23）: テーブルの行の追加・削除のボタンを隠す公式 API（kintone.app.record.showAddTableRowButtons / showDeleteTableRowButtons ほか。
//   PC・モバイルとも追加・編集画面）を、目録・解析・効果の語彙・必須の効果・形式確認・最終案の文に通す。
//   以前は「行のボタンを隠す API は Toolkit がまだ扱っていません」という固定文（KTCodeReview の SUBTABLE_ROWS・最終案の制約の理由）で、kintone にある機能を
//   Toolkit の都合で不可能のように説明していた。Gateway 側（AI版 worker/test/cases/row-buttons.mjs）と組。
//
// 検証内容:
//   §1 目録と解析: KTJsCatalog.APIS に 8 つ（CATALOG_VERSION 3）。Field Scanner は showAddTableRowButtons('items', …) をテーブル items の CONTROL と読む
//   §2 必須の効果（requiredEffectsOf）: テーブルに置いた hide-row-buttons はそのまま・列に置いたものはテーブルへ・テーブルでも列でもないフィールドは「実現できない点」
//   §3 形式確認（KTCodeReview.review）: 列の編集不可だけの計画は「「明細」テーブルの入力欄を編集できなくしても、行の追加・削除はできます」（API・Toolkit の都合を書かない）。
//      同じテーブルに hide-row-buttons があればこの制約は書かない
//   §4 会話: 金額の編集不可＋明細の行のボタンを隠す計画 → 生成 → 検証済み（代表条件 row-buttons-hidden / row-buttons-shown）→ 承認できる。右の変更内容と確かめ方の文
//   §5 会話: 列の編集不可だけの計画の最終案の制約の文（「明細」テーブルの行は追加・削除できます＋理由＋次にすること）
// 実行方法: node tests/ai-row-buttons.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const FS = require('./helpers/final-state.js');
const { createNewFlowKit } = require('./helpers/new-flow.js');
const T2 = loadToolkit();
const { KTScan, KTCodeReview, KTAiConversation, KTAiChatUi, KTJsCatalog } = T2;
const { assert, state } = makeAssert();
const K = createNewFlowKit(T2);
const { makeConvC, makeGenerate, planJs, custOf, adoptC, finalHtml, stripC, ST_C, CAND, DATA_C, clone } = K;

const ROW_APIS = ['showAddTableRowButtons', 'showDeleteTableRowButtons', 'getAddTableRowButtonsDisplayState', 'getDeleteTableRowButtonsDisplayState'];
const COND = 'ステータス in ("承認待ち")';
const COLUMNS = { qty: 'items', item_name: 'items', unit_price: 'items', subtotal: 'items' };
/** 承認待ちでは金額を編集不可にし、「明細」テーブルの行の追加・削除のボタンを隠す（それ以外は戻す） */
const CODE = `(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (${ST_C}) {\n      record['amount'].disabled = true;\n      kintone.app.record.showAddTableRowButtons('items', 'HIDDEN');\n      kintone.app.record.showDeleteTableRowButtons('items', 'HIDDEN');\n    } else {\n      record['amount'].disabled = false;\n      kintone.app.record.showAddTableRowButtons('items', 'VISIBLE');\n      kintone.app.record.showDeleteTableRowButtons('items', 'VISIBLE');\n    }\n    return event;\n  });\n})();`;
/** 承認待ちでは金額と明細の品名・数量・単価を編集不可にする（行のボタンは触らない） */
const CODE_CELLS = `(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    const record = event.record;\n    const on = ${ST_C};\n    record['amount'].disabled = on;\n    (record['items'].value || []).forEach(function (row) { row.value['qty'].disabled = on; });\n    return event;\n  });\n})();`;
const F_STATUS = { code: 'ステータス', access: 'READ' };
const F_AMOUNT = { code: 'amount', access: 'CONTROL', condition: COND, effects: ['lock'] };
const F_ROWS = { code: 'items', access: 'CONTROL', condition: COND, effects: ['hide-row-buttons'] };
const F_QTY = { code: 'qty', access: 'CONTROL', condition: COND, effects: ['lock'] };
const APIS = ['kintone.events.on', 'kintone.app.record.showAddTableRowButtons', 'kintone.app.record.showDeleteTableRowButtons'];
/** 画面に出すフィールドの名前（実際のアプリと同じく、テーブル items は「明細」） */
const LABELS = { amount: '金額', 'ステータス': 'ステータス', memo: '備考', items: '明細', qty: '数量', item_name: '品名', unit_price: '単価', subtotal: '小計' };

(async () => {
// =========================================================
console.log('\n--- §1 目録と解析 ---');
{
  assert(KTJsCatalog.CATALOG_VERSION === '3' && ROW_APIS.every(n => KTJsCatalog.APIS.some(a => a.name === `kintone.app.record.${n}` && a.kind === 'ui') && KTJsCatalog.APIS.some(a => a.name === `kintone.mobile.app.record.${n}` && a.kind === 'ui')),
    `1-1 KTJsCatalog.APIS に公式 API 8 つ（PC・モバイル）・CATALOG_VERSION 3: ${KTJsCatalog.CATALOG_VERSION}`);
  const fields = Object.values(DATA_C.fields).map(f => ({ code: f.code, label: f.label, type: f.type }));
  const an = KTScan.analyzeFile({ name: 'rows.js', target: 'desktop', kind: 'js', text: CODE }, { fields });
  assert(an.fieldAccess && an.fieldAccess.items && an.fieldAccess.items.CONTROL >= 2 && an.fieldAccess.amount && an.fieldAccess.amount.CONTROL >= 1, `1-2 Field Scanner: showAddTableRowButtons('items', …) はテーブル items の CONTROL: ${JSON.stringify(an.fieldAccess && an.fieldAccess.items)}`);
  const an2 = KTScan.analyzeFile({ name: 'get.js', target: 'desktop', kind: 'js', text: "(function () {\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    kintone.app.record.getAddTableRowButtonsDisplayState('items').then(function (s) { console.log(s); });\n    return event;\n  });\n})();" }, { fields });
  assert(an2.fieldAccess && an2.fieldAccess.items && an2.fieldAccess.items.READ >= 1 && !an2.fieldAccess.items.CONTROL, `1-3 状態の取得（get…DisplayState）は READ: ${JSON.stringify(an2.fieldAccess && an2.fieldAccess.items)}`);
}

// =========================================================
console.log('\n--- §2 必須の効果: 対象はテーブルのフィールド ---');
{
  const planOf = (fields) => ({ customizations: [custOf(['lock'], { fields })] });
  const re = KTAiConversation.requiredEffectsOf(planOf([F_STATUS, F_AMOUNT, F_ROWS]), 'C1', [], { labels: {}, columns: COLUMNS });
  assert(re.effects.some(x => x.field === 'items' && x.effect === 'hide-row-buttons' && x.condition === COND) && re.effects.some(x => x.field === 'amount' && x.effect === 'lock') && !re.notPossible.length && !re.unresolved.length,
    `2-1 テーブル items に置いた hide-row-buttons はそのまま必須の効果（条件つき）: ${JSON.stringify(re.effects.map(x => [x.field, x.effect]))}`);
  const col = KTAiConversation.requiredEffectsOf(planOf([F_STATUS, { code: 'qty', access: 'CONTROL', condition: COND, effects: ['hide-row-buttons'] }]), 'C1', [], { labels: {}, columns: COLUMNS });
  assert(col.effects.some(x => x.field === 'items' && x.effect === 'hide-row-buttons') && !col.effects.some(x => x.field === 'qty') && !col.notPossible.length,
    `2-2 列 qty に置いた hide-row-buttons はテーブル items へ: ${JSON.stringify(col.effects.map(x => [x.field, x.effect]))}`);
  const bad = KTAiConversation.requiredEffectsOf(planOf([F_STATUS, { code: 'amount', access: 'CONTROL', condition: COND, effects: ['hide-row-buttons'] }]), 'C1', [], { labels: {}, columns: COLUMNS });
  assert(!bad.effects.some(x => x.effect === 'hide-row-buttons') && bad.notPossible.some(n => n.field === 'amount' && n.effect === 'hide-row-buttons' && n.reason === 'row-buttons-not-table'),
    `2-3 テーブルでも列でもない金額に置いたものは「実現できない点」（row-buttons-not-table。必須の効果にしない）: ${JSON.stringify(bad.notPossible)}`);
  const noStruct = KTAiConversation.requiredEffectsOf(planOf([F_STATUS, F_ROWS]), 'C1', [], { labels: {}, columns: {} });
  assert(noStruct.effects.some(x => x.field === 'items' && x.effect === 'hide-row-buttons') && !noStruct.notPossible.length, '2-4 アプリの構造（列の一覧）が無ければテーブルかどうかを判定しない（必須の効果のまま。AI サービスが確かめる）');
}

// =========================================================
console.log('\n--- §3 コードの検査: 行の追加・削除の制約の文と条件 ---');
{
  const gen = (c, code) => ({ strategy: 'NEW_JS_FILE', targetFile: 'a.js', summary: 's', code, patch: null, events: ['app.record.edit.show'], fields: c.fields.filter(f => f.access !== 'READ').map(f => ({ code: f.code, access: 'CONTROL' })), apis: [], assumptions: [], warnings: [], coverage: [] });
  const review = (c, code) => KTCodeReview.review({ generated: gen(c, code), customization: c, plan: null, data: clone(DATA_C), scan: null, existingSource: null });
  const lockOnly = review(custOf(['lock'], { fields: [F_STATUS, F_AMOUNT, F_QTY] }), CODE_CELLS);
  const rows = (lockOnly.coverage.notAchieved || []).filter(y => y.code === 'SUBTABLE_ROWS');
  assert(rows.length === 1 && /^「明細」テーブルの入力欄を編集できなくしても、行の追加・削除はできます（行の追加・削除のボタンは残ります）$/.test(rows[0].message) && rows[0].tables && rows[0].tables[0] === 'items',
    `3-1 列の編集不可だけ → 制約「「明細」テーブルの入力欄を編集できなくしても、行の追加・削除はできます」（テーブルの名前で。API・Toolkit の都合を書かない）: ${JSON.stringify(rows.map(r => r.message))}`);
  assert(!/API|Toolkit|セル|明細行/.test(rows[0] ? rows[0].message : ''), '3-2 制約の文に API・Toolkit・セル・明細行の語が無い');
  const both = review(custOf(['lock'], { fields: [F_STATUS, F_AMOUNT, F_QTY, F_ROWS] }), CODE);
  assert(!(both.coverage.notAchieved || []).some(y => y.code === 'SUBTABLE_ROWS'), `3-3 同じテーブルに hide-row-buttons があれば、この制約は書かない（隠せているかは必須の効果と模擬テストが確かめる）: ${JSON.stringify((both.coverage.notAchieved || []).map(y => y.code))}`);
  const pane = KTAiChatUi.codePaneHtml({ generated: gen(custOf(['lock'], { fields: [F_STATUS, F_AMOUNT, F_QTY] }), CODE_CELLS), review: lockOnly, existingSource: null });
  assert(/要件のうち満たせない部分（Toolkit の確認）: 「明細」テーブルの入力欄を編集できなくしても、行の追加・削除はできます/.test(pane.head) && !/Toolkit がまだ扱って|API/.test(pane.head.replace(/REST API/g, '')), '3-4 右の「コード」の見出しにも同じ文（内部の都合を書かない）');
}

// =========================================================
console.log('\n--- §3b コードの検査: AI の申告（limitCode SUBTABLE_ROWS）から作る制約の文のテーブル（2026-10-24 独立レビュー） ---');
{
  const genCov = (c, code, coverage) => ({ strategy: 'NEW_JS_FILE', targetFile: 'a.js', summary: 's', code, patch: null, events: ['app.record.edit.show'], fields: c.fields.filter(f => f.access !== 'READ').map(f => ({ code: f.code, access: 'CONTROL' })), apis: [], assumptions: [], warnings: [], coverage });
  const review = (c, code, coverage) => KTCodeReview.review({ generated: genCov(c, code, coverage), customization: c, plan: null, data: clone(DATA_C), scan: null, existingSource: null });
  const CLAIM = [{ requirementId: 'C1', status: 'NOT_MET', note: '行の追加・削除は止められません', limitCode: 'SUBTABLE_ROWS' }];
  const withBtn = review(custOf(['lock'], { fields: [F_STATUS, F_AMOUNT, F_ROWS] }), CODE, CLAIM);
  const naB = withBtn.coverage.notAchieved || [];
  assert(naB.some(y => y.code === 'AI_NOT_MET' && y.limitCode === 'SUBTABLE_ROWS') && !naB.some(y => y.code === 'SUBTABLE_ROWS'), `3b-1 計画にそのテーブルの hide-row-buttons があるのに AI が SUBTABLE_ROWS と申告 → 固定文「ボタンを隠す処理はこの計画に入っていません」は足さない（AI の申告の行は残る）: ${JSON.stringify(naB.map(y => [y.code, y.tables]))}`);
  const noTable = review(custOf(['lock'], { fields: [F_STATUS, F_AMOUNT] }), CODE_CELLS, CLAIM);
  const naN = noTable.coverage.notAchieved || [];
  const fixedN = naN.find(y => y.code === 'SUBTABLE_ROWS');
  assert(fixedN && fixedN.fromLimitCode === true && Array.isArray(fixedN.tables) && fixedN.tables.length === 0 && /^テーブルの入力欄を編集できなくしても/.test(fixedN.message), `3b-2 計画にテーブルのフィールドが無ければ名前の無い一般形（名前を推定しない）: ${JSON.stringify(naN.map(y => [y.code, y.tables, y.message]))}`);
  const lockCols = review(custOf(['lock'], { fields: [F_STATUS, F_AMOUNT, F_QTY] }), CODE_CELLS, CLAIM);
  const naL = (lockCols.coverage.notAchieved || []).filter(y => y.code === 'SUBTABLE_ROWS');
  assert(naL.length === 1 && !naL[0].fromLimitCode && JSON.stringify(naL[0].tables) === '["items"]', `3b-3 列の編集不可があれば構造の検査の行（tables ["items"]）だけで、申告からの固定文は重ねない: ${JSON.stringify(naL)}`);
}

// =========================================================
console.log('\n--- §3c 合否: Gateway が落とした画面の no-event を免除として読む（2026-10-24 独立レビュー 2） ---');
{
  const EVS = ['app.record.edit.show', 'app.record.detail.show'];
  const REQ_TK = [{ requirementId: 'R1', requirementIds: ['R1'], field: 'items', effect: 'hide-row-buttons', events: EVS, condition: COND }];
  const caseOf = (o) => ({ requirementId: 'R1', requirementIds: ['R1'], field: 'items', effect: 'hide-row-buttons', platform: 'desktop', observed: {}, message: '期待どおり', ...o });
  const passes = [caseOf({ id: 'K1', expect: 'row-buttons-hidden', side: 'match', kind: 'match', event: 'app.record.edit.show', verdict: 'pass' }), caseOf({ id: 'K2', expect: 'row-buttons-shown', side: 'nomatch', kind: 'nomatch', event: 'app.record.edit.show', verdict: 'pass' })];
  const skips = [caseOf({ id: 'K3', expect: null, side: 'match', kind: 'match', event: 'app.record.detail.show', verdict: 'not-run', reason: 'no-event', observed: null, message: '確かめるイベントがありません' }), caseOf({ id: 'K4', expect: null, side: 'nomatch', kind: 'nomatch', event: 'app.record.detail.show', verdict: 'not-run', reason: 'no-event', observed: null, message: '確かめるイベントがありません' })];
  const gwVer = (cases) => ({ version: '1', passed: true, machine: [], requiredEffects: [{ requirementId: 'R1', requirementIds: ['R1'], field: 'items', effect: 'hide-row-buttons', status: 'present', check: 'behavior', checkReason: 'conditional', checkReasons: ['conditional'], events: [{ event: 'app.record.edit.show', status: 'present' }] }], behavior: { status: 'passed', reason: null, cases }, repairs: { count: 0, reasons: [], stoppedBy: null }, unverified: [] });
  const ok = KTCodeReview.effectResults(gwVer([...passes, ...skips]), REQ_TK, { omitted: [] });
  assert(ok.ok === true && ok.items.length === 1 && ok.items[0].behavior === 'pass', `3c-1 詳細画面の分に no-event の not-run があれば、編集画面の合格で合否は合格: ${JSON.stringify({ ok: ok.ok, items: ok.items.map(i => [i.behavior, i.notRunReasons]) })}`);
  const ng = KTCodeReview.effectResults(gwVer(passes), REQ_TK, { omitted: [] });
  assert(ng.ok === false && ng.items[0].behavior === 'not-run' && (ng.items[0].notRunReasons || []).includes('case-coverage'), `3c-2 対照: 落とした画面の記録が無いと、正しい JavaScript でも case-coverage の not-run（Gateway が no-event を記録する理由）: ${JSON.stringify(ng.items.map(i => [i.behavior, i.notRunReasons]))}`);
}

// =========================================================
console.log('\n--- §3d 合否: 模擬テストの環境の版（sandbox-outdated）と非同期の続き（async-after-return）は環境の理由の未確認（2026-10-24 §12.70） ---');
{
  const REQ_TK = [{ requirementId: 'R1', requirementIds: ['R1'], field: 'items', effect: 'hide-row-buttons', events: ['app.record.edit.show'], condition: COND }];
  const caseOf = (o) => ({ requirementId: 'R1', requirementIds: ['R1'], field: 'items', effect: 'hide-row-buttons', platform: 'desktop', event: 'app.record.edit.show', ...o });
  const gwVer = (cases) => ({ version: '1', passed: true, machine: [], requiredEffects: [{ requirementId: 'R1', requirementIds: ['R1'], field: 'items', effect: 'hide-row-buttons', status: 'present', check: 'behavior', checkReason: 'conditional', checkReasons: ['conditional'], events: [{ event: 'app.record.edit.show', status: 'present' }] }], behavior: { status: 'not-run', reason: cases[0].reason, cases }, repairs: { count: 0, reasons: [], stoppedBy: null }, unverified: [] });
  for (const reason of ['sandbox-outdated', 'async-after-return']) {
    const cases = [caseOf({ id: 'K1', expect: 'row-buttons-hidden', side: 'match', kind: 'match', verdict: 'not-run', reason, reasonCategory: 'environment', observed: null, message: 'x' }), caseOf({ id: 'K2', expect: 'row-buttons-shown', side: 'nomatch', kind: 'nomatch', verdict: 'pass', observed: {}, message: '期待どおり' })];
    const er = KTCodeReview.effectResults(gwVer(cases), REQ_TK, { omitted: [] });
    assert(er.ok === false && er.items[0].behavior === 'not-run' && JSON.stringify(er.items[0].notRunReasons) === JSON.stringify([reason]) && er.reasonCategory === 'env', `3d ${reason}: 合格にしない・理由の区分は環境（env。理由の表に項目がある）: ${JSON.stringify({ ok: er.ok, cat: er.reasonCategory, items: er.items.map(i => [i.behavior, i.notRunReasons]) })}`);
  }
  assert(/この Toolkit に必要な機能に対応していません/.test(T2.KTAiClient.errorText('CAPABILITY_OUTDATED')) && /接続先の設定を確かめてください/.test(T2.KTAiClient.errorText('CAPABILITY_OUTDATED')) && !/版が古く/.test(T2.KTAiClient.errorText('CAPABILITY_OUTDATED')), `3d-3 能力の印が欠けるときの文は検出した事実と次の行動（版が古いとは言わない）: ${T2.KTAiClient.errorText('CAPABILITY_OUTDATED')}`);
}

// =========================================================
console.log('\n--- §3e 接続時の印: 行のボタンの効果を検証できない接続先（health の verification に rowButtons が無い）には生成を依頼しない（2026-10-24 §12.70 レビュー 3） ---');
{
  const h = clone(K.HEALTH_V);
  const g = h.registry.toolkit['customization-generator'];
  assert(g.verification.includes('rowButtons'), '3e-0 今の偽の health（本物の prompt-registry と同じ印）に rowButtons がある');
  g.verification = g.verification.filter(x => x !== 'rowButtons');
  const c = T2.KTAiClient.capabilityFromHealth(h);
  assert(c.features['customization-generator'].available === false && c.features['customization-generator'].reason === 'CAPABILITY_OUTDATED' && JSON.stringify(c.features['customization-generator'].lacking) === JSON.stringify(['rowButtons']) && c.features['change-planner'].available === true,
    `3e-1 rowButtons の無い接続先（旧 Gateway）は生成を使えない（CAPABILITY_OUTDATED・lacking rowButtons。効果を落とした有料の生成に進まない）。計画は使える: ${JSON.stringify(c.features['customization-generator'])}`);
}

// =========================================================
console.log('\n--- §4 会話: 金額の編集不可＋明細の行のボタンを隠す計画 → 検証済み・承認できる ---');
{
  CAND.rowbtn = { code: CODE, has: { amount: ['lock'], items: ['hide-row-buttons'] } };
  const CUST_R = custOf(['lock'], { requirement: '承認待ちでは金額を編集不可にし、明細の行を追加・削除できなくする', fields: [F_STATUS, F_AMOUNT, F_ROWS], apis: APIS });
  const genOf = () => ({ strategy: 'NEW_JS_FILE', targetFile: 'rows.js', summary: '承認待ちでは金額を編集不可にし、明細の行の追加・削除のボタンを隠します。', code: CODE, patch: null, events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }, { code: 'items', access: 'CONTROL' }], apis: APIS, assumptions: [], warnings: [], coverage: [{ requirementId: 'C1', status: 'MET', note: '' }] });
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_R, summary: '承認待ちでは金額を編集不可にし、明細の行の追加・削除のボタンを隠します。' }), generate: makeGenerate({ sequence: ['rowbtn'], generatedOf: genOf }), labels: LABELS });
  await adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1;
  assert(e && e.status === 'verified' && FS.readyOf(v) === true && !(v.final.cannot || []).length && e.requiredEffects.some(r => r.field === 'items' && r.effect === 'hide-row-buttons'),
    `4-1 必須の効果に行のボタンを隠す効果が入り、検証済み・承認できる: ${JSON.stringify({ status: e && e.status, ready: FS.readyOf(v), req: e && e.requiredEffects.map(r => [r.field, r.effect]) })}`);
  const cases = (e.verification.behavior.cases || []).map(c => [c.expect, c.side, c.verdict]);
  assert(cases.some(c => c[0] === 'row-buttons-hidden' && c[1] === 'match' && c[2] === 'pass') && cases.some(c => c[0] === 'row-buttons-shown' && c[1] === 'nomatch' && c[2] === 'pass'), `4-2 確かめる条件: 合う → 行の追加・削除のボタンが表示されない・合わない → 表示される（どちらも合格）: ${JSON.stringify(cases)}`);
  const summary = stripC(KTAiChatUi.changeSummaryHtml(v, {}));
  assert(/テーブルの行の追加・削除のボタンを隠す — 処理あり・模擬テストで合格/.test(summary) && /行の追加・削除のボタンが表示されない/.test(summary) && /行の追加・削除のボタンが表示される/.test(summary) && !/API|セル|明細行/.test(summary.replace(/REST API/g, '')),
    `4-3 右の「変更内容」: 必須の動作と確かめる条件の文が kintone 標準の用語（API・セル・明細行を使わない）`);
  const text = stripC(finalHtml(x));
  assert(!/行は追加・削除できます|行の追加・削除は防ぎません|Toolkit がまだ扱って/.test(text), '4-4 最終案のカードに「行は追加・削除できます」の制約は出ない（隠す効果が計画にあり、検証した）');
  assert(/行の追加・削除の制御/.test(text), `4-5 ［コードを見る］の見出しに「行の追加・削除の制御」: ${text.split('\n').filter(l => /コードを見る/.test(l)).join(' | ')}`);
  const howTo = v.final.verification && Array.isArray(v.final.verification.howTo) ? v.final.verification.howTo : [];
  assert(howTo.some(s => /の行の追加・削除のボタンを隠す/.test(s)) && !howTo.some(s => /をテーブルの行の追加・削除のボタンを隠す/.test(s)), `4-6 反映した後に確かめることの文: 「〇〇の行の追加・削除のボタンを隠す」（「〇〇をテーブルの…」と言わない）: ${JSON.stringify(howTo)}`);
}

// =========================================================
console.log('\n--- §5 会話: 列の編集不可だけの計画の最終案の制約の文 ---');
{
  CAND.cells = { code: CODE_CELLS, has: { amount: ['lock'], qty: ['lock'] } };
  const CUST_L = custOf(['lock'], { requirement: '承認待ちでは金額と明細の数量を編集不可にする', fields: [F_STATUS, F_AMOUNT, F_QTY] });
  const genOf = () => ({ strategy: 'NEW_JS_FILE', targetFile: 'cells.js', summary: '承認待ちでは金額と明細の数量を編集不可にします。', code: CODE_CELLS, patch: null, events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }, { code: 'qty', access: 'CONTROL' }], apis: ['kintone.events.on'], assumptions: [], warnings: [], coverage: [{ requirementId: 'C1', status: 'MET', note: '' }] });
  const x = makeConvC({ planImpl: (args) => planJs(args, { cust: CUST_L, summary: '承認待ちでは金額と明細の数量を編集不可にします。' }), generate: makeGenerate({ sequence: ['cells'], generatedOf: genOf }), labels: LABELS });
  await adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1;
  const text = stripC(finalHtml(x));
  assert(e && e.status === 'verified' && /「明細」テーブルの行は追加・削除できます/.test(text) && /入力欄を編集できなくしても、行の追加・削除のボタンは残るためです/.test(text) && !/依頼に加えて|ボタンを隠す処理/.test(text),
    `5-1 最終案の制約: 「「明細」テーブルの行は追加・削除できます」＋理由と次にすること: ${text.split('\n').filter(l => /行/.test(l)).join(' | ').slice(0, 400)}`);
  assert(!/Toolkit がまだ扱って|行のボタンを隠す API|セル|明細行/.test(text), '5-2 最終案の文に「Toolkit がまだ扱って」「API」「セル」「明細行」が無い');
}

console.log(`\n${state.failed === 0 ? 'ALL PASSED' : 'FAILED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
