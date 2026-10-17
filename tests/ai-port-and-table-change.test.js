// 誤った検証による修復の繰り返しを止める（2026-10-10・実機の素材の整理で判明。有料の AI は使わない）— Toolkit の担当（仕様 §5・§6）
//
// 経緯: 2026-10-10 の実機（自然な会話）で、C3（PC の既存の入力チェック dealValidate.js をモバイルへ移植）の必須の効果が「保存を止める・条件は空」のまま
//   生成工程へ渡り、空欄が「いつでも保存を止める」と扱われた。生成されたコードは移植元と同じ判定（空欄・負の数だけ止める）で正しかったのに、
//   「いつでも止める」代表条件で不合格になり、修復を呼んで同じ候補が返った（tests/fixtures/nl1010-port.js の C3_CASES_THEN・C3_REPAIRS_THEN）。
//   C1・C2 のテーブル（明細）の変更のイベントでも、Gateway が壊れた模擬の入力（テーブル自体の change に行の配列の value）を作り、正しいコードを不合格にした。
//   → Toolkit は、条件の空の保存禁止に別の画面の移植元があるときは「移植元と同じ条件」（conditionFrom）として送り、確かめる手段が無ければ「いつでも」にせず
//   条件が分からない（condition-unknown）で止める。壊れた入力（case-invalid）は環境の区分にして修復も［計画を直すよう依頼する］も出さない。
//
// 検証内容:
//   §P1 requiredEffectsOf（保存済みの計画の C3）: 移植元（dealValidate.js・desktop・保存のイベント・金額・本文あり）と接続先の印 → conditionFrom／
//        印が無い → condition-unknown（not-capable）／本文を送れない → condition-unknown（no-source）／existingFiles が空・同じ画面のファイルだけ・
//        対のイベントの一部だけ・金額を参照しない・統合（EXTEND）・編集不可の空条件・jsFiles が無い → 今までどおり（'' はいつでも・未解決なし）／C1・C2 は変わらない
//   §P2 KTContext.effectJsFilesOf: source は生成の ctx の otherFiles に本文を入れられるか（buildGenerator と同じ規則。16 KB を超える・名前で挙げていない → false）・
//        生成の要求の requiredEffects に conditionFrom を載せる
//   §P3 会話（偽の services）: 移植元と比べる代表条件（same-as-source）で検証済み・承認できる／接続先が非対応・本文を送れない → 生成を呼ばず準備未完了
//        （計画の差分更新を自動で依頼しない・［計画を直すよう依頼する］を出さない・「いつでも保存を止める」にしない）／移植元と違う動き → 修復の対象（文は移植元の名前で）／
//        流用の鍵: 移植元が同じなら流用・移植元が無くなれば作り直す
//   §P4 語彙: case-invalid（区分 env）は修復も［計画を直すよう依頼する］も出さない・condition-unknown（区分 condition）は計画を直す（条件を推測で書かせない）／
//        health の印 tableRowChange・caseInvalid が欠ける接続先は「接続先が非対応」
//   §P5 生成結果の正規化: repairs.notRepaired・代表条件の reference・refFile・refEvent を落とさない（最終案の詳細に修復しなかった結果を 1 行）
//   §P6 画面: 画面の解析（scan）から jsFiles を作り、health の印 conditionFrom がある接続先で、生成の ctx の requiredEffects に conditionFrom と移植元の本文が載る
//   §P7 文言（§6）: 「kintone の JavaScript では止められません」の言い切りが残っていない・SUBTABLE_ROWS の判定（符号・承認を止めない扱い）は今のまま
//   独立レビュー後の修正（2026-10-14・仕様 §10.2）: T-1 移植元を確かめられない（画面の解析が無い・一覧に無い・本文の解析が無い・イベントの登録を読めない）ときは
//     「いつでも」にせず condition-unknown（no-source / events-unreadable）（P1-8〜P1-8g・P2-8・P2-9・P3-6b・P3-6c）／T-2 見出し「必須の動作を確かめられません」（P3-4・P3-6）／
//     T-4 日本語の名前の移植元でも本文を送れる（P2-7）／T-5 比べた動きの文に error の置き場所（フィールド名＋コード／画面全体）を出す（P3-3・P3-9・P3-13・P3-14）
//
//   修正前の版（KT_SRC）でも例外で止めずに各 assert を評価する（無い関数は例外を section が受けて FAIL にする）
//
// 実行方法: node tests/ai-port-and-table-change.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const fs = require('fs');
const path = require('path');
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { gwCandidateHash } = require('./helpers/gw-hash.js');
const T = loadToolkit();
const { KTAiConversation, KTCodeReview, KTScan, KTContext, KTAiClient, KTPlanReview } = T;
const { assert, state } = makeAssert();
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const { clone, B, req, makeConvC, GEN_EFFECT_FEATURES } = K;
const F = require('./fixtures/nl1010-port.js');
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }

const LABELS = { amount: '金額', 'ステータス': 'ステータス', items: '明細', item_name: '品名', qty: '数量', unit_price: '単価', subtotal: '小計' };
const SUBMITS = ['app.record.create.submit', 'app.record.edit.submit'];
const M_SUBMITS = ['mobile.app.record.create.submit', 'mobile.app.record.edit.submit'];
const PLAN = { customizations: clone(F.CUSTOMIZATIONS), proposedFields: [] };
const C3 = () => clone(F.CUSTOMIZATIONS.find(c => c.customizationId === 'C3'));
/** 画面の解析から作るアプリの JavaScript の一覧（KTContext.effectJsFilesOf の形）。dealValidate.js は本文を生成に送れる */
const JSF = (o = {}) => [
  { name: 'dealLock.js', target: 'desktop', events: ['app.record.create.show', 'app.record.edit.show'], fields: ['amount', 'ステータス'], source: false },
  { name: 'dealValidate.js', target: 'desktop', events: [...SUBMITS], fields: ['amount'], source: true, ...o },
];
const CF = { file: 'dealValidate.js', target: 'desktop', events: [...SUBMITS] };
const reqOf = (plan, cid, o = {}) => KTAiConversation.requiredEffectsOf(plan, cid, [], { labels: LABELS, columns: { item_name: 'items', qty: 'items', unit_price: 'items', subtotal: 'items' }, readOnly: null, ...o });
const planWith = (c3) => ({ customizations: [...clone(F.CUSTOMIZATIONS).filter(c => c.customizationId !== 'C3'), c3], proposedFields: [] });
const short = (r) => ({ effects: (r.effects || []).map(e => ({ field: e.field, effect: e.effect, events: e.events, condition: e.condition, ...(e.conditionFrom ? { conditionFrom: e.conditionFrom } : {}) })), unresolved: r.unresolved || [] });
/** 今までの結果（移植元の判定が無い形）: 金額の保存禁止・条件は空・conditionFrom なし・未解決なし */
const ALWAYS = JSON.stringify({ effects: [{ field: 'amount', effect: 'block-save', events: M_SUBMITS, condition: '' }], unresolved: [] });

(async () => {
// =========================================================
console.log('\n--- §P1. requiredEffectsOf: 既存の入力チェックの移植は「いつでも保存を止める」にしない ---');
await section(async () => {
  const c3 = C3();
  assert(c3.strategy === 'NEW_JS_FILE' && JSON.stringify(c3.platform) === JSON.stringify(['mobile']) && c3.existingFiles.length === 1 && c3.existingFiles[0].name === 'dealValidate.js' && c3.existingFiles[0].target === 'desktop' && c3.fields[0].effects[0].effect === 'block-save' && c3.fields[0].effects[0].condition === '',
    `P1-0: 前提: 保存済みの計画の C3 はモバイルの新しいファイル・existingFiles に PC の dealValidate.js・金額の保存禁止の条件は空: ${JSON.stringify({ s: c3.strategy, p: c3.platform, ex: c3.existingFiles })}`);
  assert(JSON.stringify(F.C3_REQUIRED_EFFECTS_THEN.map(e => e.condition)) === JSON.stringify(['']) && F.C3_CASES_THEN.filter(x => x.verdict === 'fail').every(x => x.expect === 'block-save') && F.C3_REPAIRS_THEN.count === 1 && F.C3_REPAIRS_THEN.stoppedBy === 'same-failure',
    'P1-0b: 前提（保存済みのログ）: そのときの必須の効果は条件が空で、正しいコードが「保存が止まる」の期待で不合格になり、修復を 1 回呼んで同じ候補が返った');
  const r = reqOf(PLAN, 'C3', { jsFiles: JSF(), capable: { conditionFrom: true } });
  assert(JSON.stringify(short(r)) === JSON.stringify({ effects: [{ field: 'amount', effect: 'block-save', events: M_SUBMITS, condition: '', conditionFrom: CF }], unresolved: [] }),
    `P1-1: 移植元（PC の dealValidate.js が対の保存のイベントを登録し金額を参照・本文を送れる）と接続先の印 → conditionFrom（条件は移植元と同じ。未解決なし）: ${JSON.stringify(short(r))}`);
  const nc = reqOf(PLAN, 'C3', { jsFiles: JSF(), capable: { conditionFrom: false } });
  assert(nc.unresolved.length === 1 && nc.unresolved[0].field === 'amount' && nc.unresolved[0].effect === 'block-save' && nc.unresolved[0].reason === 'condition-unknown' && nc.unresolved[0].source === 'dealValidate.js' && nc.unresolved[0].why === 'not-capable' && nc.unresolved[0].requirementId === 'C3' && !nc.effects.some(e => e.conditionFrom),
    `P1-2: 接続先に印 conditionFrom が無い → condition-unknown（not-capable。「いつでも」の効果として確かめない）: ${JSON.stringify(nc.unresolved)}`);
  const ncap = reqOf(PLAN, 'C3', { jsFiles: JSF() });
  assert(ncap.unresolved.length === 1 && ncap.unresolved[0].why === 'not-capable', `P1-2b: capable を渡さない（既定 {}）も非対応として扱う: ${JSON.stringify(ncap.unresolved)}`);
  const ns = reqOf(PLAN, 'C3', { jsFiles: JSF({ source: false }), capable: { conditionFrom: true } });
  assert(ns.unresolved.length === 1 && ns.unresolved[0].reason === 'condition-unknown' && ns.unresolved[0].source === 'dealValidate.js' && ns.unresolved[0].why === 'no-source',
    `P1-3: 移植元の本文を生成に送れない（source false）→ condition-unknown（no-source）: ${JSON.stringify(ns.unresolved)}`);
});
await section(async () => {
  //   移植元が無い・当たらないときは今までどおり（'' はいつでも・未解決なし）
  const on = { jsFiles: JSF(), capable: { conditionFrom: true } };
  const noEx = reqOf(planWith({ ...C3(), existingFiles: [] }), 'C3', on);
  assert(JSON.stringify(short(noEx)) === ALWAYS, `P1-4: existingFiles が空 → 今までどおり（条件は空のまま・未解決なし）: ${JSON.stringify(short(noEx))}`);
  const sameP = reqOf(planWith({ ...C3(), existingFiles: [{ name: 'dealValidateMobile.js', target: 'mobile', reason: '同じ画面の既存の入力チェック' }] }), 'C3', { ...on, jsFiles: [...JSF(), { name: 'dealValidateMobile.js', target: 'mobile', events: [...M_SUBMITS], fields: ['amount'], source: true }] });
  assert(JSON.stringify(short(sameP)) === ALWAYS, `P1-5: 同じ画面（モバイル）の既存ファイルだけ → 移植元にしない: ${JSON.stringify(short(sameP))}`);
  const half = reqOf(PLAN, 'C3', { ...on, jsFiles: JSF({ events: ['app.record.edit.submit'] }) });
  assert(JSON.stringify(short(half)) === ALWAYS, `P1-6: 移植元が対のイベントの一部（編集の保存だけ）しか登録しない → 移植元にしない: ${JSON.stringify(short(half))}`);
  const noField = reqOf(PLAN, 'C3', { ...on, jsFiles: JSF({ fields: ['deal_name'] }) });
  assert(JSON.stringify(short(noField)) === ALWAYS, `P1-7: 移植元が金額を参照しない → 移植元にしない: ${JSON.stringify(short(noField))}`);
  //   レビュー T-1（2026-10-14）: 期待を「今までどおり（'' はいつでも・未解決なし）」から「condition-unknown（no-source）」に変えた。別の画面の移植元が計画にあるのに
  //   画面の解析が無いとき、空欄を「いつでも保存を止める」として生成へ渡すと、正しい移植コードが不合格 → 修復 → same-failure という 10-10 の不具合が再発する（前の期待が誤り）
  const noList = reqOf(PLAN, 'C3', { capable: { conditionFrom: true } });
  assert(noList.unresolved.length === 1 && noList.unresolved[0].field === 'amount' && noList.unresolved[0].effect === 'block-save' && noList.unresolved[0].reason === 'condition-unknown' && noList.unresolved[0].source === 'dealValidate.js' && noList.unresolved[0].why === 'no-source' && !noList.effects.some(e => e.conditionFrom),
    `P1-8: jsFiles が無い（画面の解析が無い）→ condition-unknown（no-source。「いつでも」にしない）: ${JSON.stringify(short(noList))}`);
  const notListed = reqOf(PLAN, 'C3', { ...on, jsFiles: JSF().filter(f => f.name !== 'dealValidate.js') });
  assert(notListed.unresolved.length === 1 && notListed.unresolved[0].reason === 'condition-unknown' && notListed.unresolved[0].source === 'dealValidate.js' && notListed.unresolved[0].why === 'no-source',
    `P1-8b: 移植元が画面の解析の一覧に無い → condition-unknown（no-source）: ${JSON.stringify(notListed.unresolved)}`);
  const unread = reqOf(PLAN, 'C3', { ...on, jsFiles: JSF({ events: [], analyzed: true, eventsUnresolved: true }) });
  assert(unread.unresolved.length === 1 && unread.unresolved[0].reason === 'condition-unknown' && unread.unresolved[0].source === 'dealValidate.js' && unread.unresolved[0].why === 'events-unreadable' && !unread.effects.some(e => e.conditionFrom),
    `P1-8c: 移植元のイベントの登録を本文から読めない（eventsUnresolved・events []）→ condition-unknown（events-unreadable。「登録しない」と読まない）: ${JSON.stringify(unread.unresolved)}`);
  const noAn = reqOf(PLAN, 'C3', { ...on, jsFiles: JSF({ events: [], fields: [], source: false, analyzed: false, eventsUnresolved: false }) });
  assert(noAn.unresolved.length === 1 && noAn.unresolved[0].why === 'events-unreadable' && noAn.unresolved[0].source === 'dealValidate.js',
    `P1-8d: 移植元の本文の解析が無い（analyzed false）→ condition-unknown（events-unreadable）: ${JSON.stringify(noAn.unresolved)}`);
  const unrelated = reqOf(PLAN, 'C3', { ...on, jsFiles: JSF({ events: ['app.record.edit.show'], analyzed: true, eventsUnresolved: false }) });
  assert(JSON.stringify(short(unrelated)) === ALWAYS, `P1-8e: 解析済みで対のイベントを登録しない F は移植元ではない → 今までどおり（'' のまま・未解決なし）: ${JSON.stringify(short(unrelated))}`);
  //   複数の移植元の候補（existingFiles が 2 つ）: 1 つが確かめられなくても、確かめられた方を移植元にする／どれも確かめられなければ最初の確かめられなかった理由
  const two = planWith({ ...C3(), existingFiles: [{ name: 'other.js', target: 'desktop', reason: '関連' }, { name: 'dealValidate.js', target: 'desktop', reason: '移植元' }] });
  const twoR = reqOf(two, 'C3', { ...on, jsFiles: [...JSF(), { name: 'other.js', target: 'desktop', events: [], fields: [], source: false, analyzed: false, eventsUnresolved: false }] });
  assert(twoR.effects.length === 1 && twoR.effects[0].conditionFrom && twoR.effects[0].conditionFrom.file === 'dealValidate.js' && !twoR.unresolved.length,
    `P1-8f: 複数の候補のうち 1 つ（other.js）が確かめられなくても、確かめられた dealValidate.js を移植元にする: ${JSON.stringify(short(twoR))}`);
  const twoU = reqOf(two, 'C3', { ...on, jsFiles: [...JSF({ events: [], analyzed: true, eventsUnresolved: true }), { name: 'other.js', target: 'desktop', events: [], fields: [], source: false, analyzed: false, eventsUnresolved: false }] });
  assert(twoU.unresolved.length === 1 && twoU.unresolved[0].source === 'other.js' && twoU.unresolved[0].why === 'events-unreadable' && !twoU.effects.some(e => e.conditionFrom),
    `P1-8g: どれも確かめられない → 最初の確かめられなかった理由（other.js・events-unreadable）で unresolved: ${JSON.stringify(twoU.unresolved)}`);
  const ext = reqOf(planWith({ ...C3(), strategy: 'EXTEND_EXISTING_JS', existingFiles: [{ name: 'dealValidateMobile.js', target: 'mobile', reason: '統合先' }, { name: 'dealValidate.js', target: 'desktop', reason: '移植元' }] }), 'C3', on);
  assert(!ext.effects.some(e => e.conditionFrom) && !ext.unresolved.some(u => u.source), `P1-9: 統合（EXTEND_EXISTING_JS）→ 移植元にしない: ${JSON.stringify(short(ext))}`);
  const lockC = { ...C3(), fields: [{ code: 'amount', access: 'CONTROL', effects: [{ effect: 'lock', condition: '' }] }] };
  const lk = reqOf(planWith(lockC), 'C3', on);
  assert(JSON.stringify(short(lk)) === JSON.stringify({ effects: [{ field: 'amount', effect: 'lock', events: M_SUBMITS, condition: '' }], unresolved: [] }), `P1-10: 編集不可の空条件 → 今までどおり（保存禁止だけが対象）: ${JSON.stringify(short(lk))}`);
  const condC = { ...C3(), fields: [{ code: 'amount', access: 'CONTROL', effects: [{ effect: 'block-save', condition: 'amount < 0' }] }] };
  const cd = reqOf(planWith(condC), 'C3', on);
  assert(cd.effects.length === 1 && cd.effects[0].condition === 'amount < 0' && !cd.effects[0].conditionFrom && !cd.unresolved.length, `P1-11: 計画が条件を書いた保存禁止 → 計画の条件のまま（移植元で上書きしない）: ${JSON.stringify(short(cd))}`);
  for (const cid of ['C1', 'C2']) {
    const a = reqOf(PLAN, cid), b = reqOf(PLAN, cid, on);
    assert(JSON.stringify(a) === JSON.stringify(b) && !b.effects.some(e => e.conditionFrom), `P1-12（${cid}）: 保存禁止の無い C1・C2 の必須の効果は jsFiles・印で変わらない: ${JSON.stringify(short(b))}`);
  }
});

// =========================================================
console.log('\n--- §P2. KTContext.effectJsFilesOf と生成の要求 ---');
const DATA = { appId: '353', fields: clone(K.DATA_C.fields), status: clone(K.DATA_C.status), layout: [], customize: { scope: 'ALL', desktop: { js: [{ type: 'FILE', file: { name: 'dealLock.js', fileKey: 'k-lock' } }, { type: 'FILE', file: { name: 'dealValidate.js', fileKey: 'k-validate' } }], css: [] }, mobile: { js: [], css: [] } } };
const scanOf = (validateText = F.DEAL_VALIDATE_JS) => ({ files: [{ name: 'dealLock.js', target: 'desktop', kind: 'js', text: F.DEAL_LOCK_JS }, { name: 'dealValidate.js', target: 'desktop', kind: 'js', text: validateText }], results: [{ code: 'amount', matches: [{ kind: 'js', file: 'dealValidate.js', target: 'desktop', access: 'READ' }, { kind: 'js', file: 'dealLock.js', target: 'desktop', access: 'CONTROL' }] }, { code: 'ステータス', matches: [{ kind: 'js', file: 'dealLock.js', target: 'desktop', access: 'READ' }] }] });
const otherSrc = (ctx, name) => { const f = (ctx && Array.isArray(ctx.otherFiles) ? ctx.otherFiles : []).find(x => x.name === name); return f ? typeof f.source === 'string' : null; };
await section(async () => {
  const list = KTContext.effectJsFilesOf({ customization: C3(), data: DATA, scan: scanOf() });
  const v = list.find(f => f.name === 'dealValidate.js'), l = list.find(f => f.name === 'dealLock.js');
  assert(v && v.target === 'desktop' && SUBMITS.every(e => v.events.includes(e)) && v.fields.includes('amount') && v.source === true && l && l.source === false,
    `P2-1: 画面の解析から: dealValidate.js は保存のイベント・金額・本文を送れる（C3 が名前で挙げる）／dealLock.js は名前で挙げていないので本文なし: ${JSON.stringify(list)}`);
  const ctx = KTContext.buildGenerator({ customization: C3(), plan: PLAN, data: DATA, scan: scanOf(), options: { now: '2026-10-10T00:00:00.000Z' } });
  assert(otherSrc(ctx, 'dealValidate.js') === true && otherSrc(ctx, 'dealLock.js') === false, `P2-2: 同じ規則: 生成の ctx の otherFiles にも dealValidate.js の本文だけが載る: ${JSON.stringify((ctx.otherFiles || []).map(f => [f.name, typeof f.source]))}`);
  //   16 KB を超える移植元は本文を送らない（生成の ctx も effectJsFilesOf も同じ）→ requiredEffectsOf は no-source
  let big = F.DEAL_VALIDATE_JS; for (let i = 0; big.length <= 16 * 1024; i++) big += `\nfunction pad_${i}(x) { return x + ${i}; }`;
  const listB = KTContext.effectJsFilesOf({ customization: C3(), data: DATA, scan: scanOf(big) });
  const ctxB = KTContext.buildGenerator({ customization: C3(), plan: PLAN, data: DATA, scan: scanOf(big), options: { now: '2026-10-10T00:00:00.000Z' } });
  const rB = reqOf(PLAN, 'C3', { jsFiles: listB, capable: { conditionFrom: true } });
  assert(listB.find(f => f.name === 'dealValidate.js').source === false && otherSrc(ctxB, 'dealValidate.js') === false && rB.unresolved.length === 1 && rB.unresolved[0].why === 'no-source',
    `P2-3: 16 KB を超える移植元 → 本文を送らない（effectJsFilesOf と生成の ctx で同じ）→ 条件が分からない（no-source）: ${JSON.stringify({ src: listB.find(f => f.name === 'dealValidate.js').source, ctx: otherSrc(ctxB, 'dealValidate.js'), u: rB.unresolved })}`);
  //   統合先（C1 の dealLock.js）は otherFiles に入らない
  const c1 = clone(F.CUSTOMIZATIONS.find(c => c.customizationId === 'C1'));
  const l1 = KTContext.effectJsFilesOf({ customization: c1, data: DATA, scan: scanOf() });
  assert(l1.every(f => f.source === false), `P2-4: C1（dealLock.js に統合・dealValidate.js を名前で挙げない）では本文を送るファイルは無い: ${JSON.stringify(l1.map(f => [f.name, f.source]))}`);
});
await section(async () => {
  //   生成の要求: requiredEffects に conditionFrom を載せる（Gateway の契約 20 §4.1）
  const eff = reqOf(PLAN, 'C3', { jsFiles: JSF(), capable: { conditionFrom: true } }).effects;
  const ctx = KTContext.buildGenerator({ customization: C3(), plan: PLAN, data: DATA, scan: scanOf(), verification: { requirementIds: [{ id: 'C3', kind: 'customization', text: 'x' }], requiredEffects: eff, relatedFiles: [], relatedOmitted: [] }, options: { now: '2026-10-10T00:00:00.000Z' } });
  const re = ctx.verification && ctx.verification.requiredEffects;
  assert(Array.isArray(re) && re.length === 1 && JSON.stringify(re[0].conditionFrom) === JSON.stringify(CF) && re[0].condition === '' && JSON.stringify(re[0].events) === JSON.stringify(M_SUBMITS),
    `P2-5: 生成の ctx の verification.requiredEffects に conditionFrom（file・target・events）が載る（condition は空のまま）: ${JSON.stringify(re)}`);
  const ctx0 = KTContext.buildGenerator({ customization: C3(), plan: PLAN, data: DATA, scan: scanOf(), verification: { requirementIds: [], requiredEffects: [{ ...eff[0], conditionFrom: { file: '', target: 'desktop', events: [] } }], relatedFiles: [], relatedOmitted: [] }, options: { now: '2026-10-10T00:00:00.000Z' } });
  assert(!('conditionFrom' in ctx0.verification.requiredEffects[0]), 'P2-6: 壊れた conditionFrom（file・events が空）は載せない');
});
await section(async () => {
  //   レビュー T-4（2026-10-14）: 計画の existingFiles の名前は正規表現を通さずに named に入れる → 日本語の名前の移植元（requirement の文には名前が無い）でも本文を送れる
  const name = '金額チェック.js';
  const data = clone(DATA); data.customize.desktop.js.push({ type: 'FILE', file: { name, fileKey: 'k-ja' } });
  const scan = { files: [{ name: 'dealLock.js', target: 'desktop', kind: 'js', text: F.DEAL_LOCK_JS }, { name, target: 'desktop', kind: 'js', text: F.DEAL_VALIDATE_JS }], results: [{ code: 'amount', matches: [{ kind: 'js', file: name, target: 'desktop', access: 'READ' }] }] };
  const c3 = { ...C3(), requirement: 'PC の既存の入力チェックをモバイルへ移植する。', risks: [], existingFiles: [{ name, target: 'desktop', reason: '移植元' }] };
  const list = KTContext.effectJsFilesOf({ customization: c3, data, scan });
  const f = list.find(x => x.name === name);
  const ctx = KTContext.buildGenerator({ customization: c3, plan: planWith(c3), data, scan, options: { now: '2026-10-10T00:00:00.000Z' } });
  const r = reqOf(planWith(c3), 'C3', { jsFiles: list, capable: { conditionFrom: true } });
  assert(f && f.source === true && f.analyzed === true && f.eventsUnresolved === false && otherSrc(ctx, name) === true && r.effects.length === 1 && r.effects[0].conditionFrom && r.effects[0].conditionFrom.file === name && !r.unresolved.length,
    `P2-7: 日本語の名前の移植元でも本文を送れる（effectJsFilesOf と生成の ctx で同じ規則）→ conditionFrom: ${JSON.stringify({ f, ctx: otherSrc(ctx, name), r: short(r) })}`);
  //   レビュー T-1: effectJsFilesOf は analyzed・eventsUnresolved を載せる。イベント名を組み立てる本文 → eventsUnresolved → 移植元を確かめられない（events-unreadable）
  const DYN = "(function () {\n  'use strict';\n  var evs = ['create', 'edit'].map(function (s) { return 'app.record.' + s + '.submit'; });\n  kintone.events.on(evs, function (event) {\n    var amount = event.record['amount'].value;\n    if (amount === '' || amount === null || amount === undefined) {\n      event.record['amount'].error = '金額を入力してください';\n    }\n    return event;\n  });\n})();\n";
  const scanDyn = { files: [{ name: 'dealLock.js', target: 'desktop', kind: 'js', text: F.DEAL_LOCK_JS }, { name: 'dealValidate.js', target: 'desktop', kind: 'js', text: DYN }], results: [{ code: 'amount', matches: [{ kind: 'js', file: 'dealValidate.js', target: 'desktop', access: 'READ' }] }] };
  const listD = KTContext.effectJsFilesOf({ customization: C3(), data: DATA, scan: scanDyn });
  const ld = listD.find(x => x.name === 'dealValidate.js');
  const rd = reqOf(PLAN, 'C3', { jsFiles: listD, capable: { conditionFrom: true } });
  assert(ld && ld.analyzed === true && ld.eventsUnresolved === true && ld.fields.includes('amount') && rd.unresolved.length === 1 && rd.unresolved[0].why === 'events-unreadable' && !rd.effects.some(e => e.conditionFrom),
    `P2-8: イベント名を組み立てる本文 → eventsUnresolved → condition-unknown（events-unreadable。「いつでも」にしない）: ${JSON.stringify({ ld, u: rd.unresolved })}`);
  //   本文の無いファイル（取得失敗の note）→ analyzed false → 同じく確かめられない
  const scanNo = { files: [{ name: 'dealValidate.js', target: 'desktop', kind: 'js', note: '本文を取得できません' }] };
  const listN = KTContext.effectJsFilesOf({ customization: C3(), data: DATA, scan: scanNo });
  const ln = listN.find(x => x.name === 'dealValidate.js');
  const rn = reqOf(PLAN, 'C3', { jsFiles: listN, capable: { conditionFrom: true } });
  assert(ln && ln.analyzed === false && ln.source === false && rn.unresolved.length === 1 && rn.unresolved[0].why === 'events-unreadable',
    `P2-9: 本文の無いファイル（取得できない）→ analyzed false → condition-unknown（events-unreadable）: ${JSON.stringify({ ln, u: rn.unresolved })}`);
});

// =========================================================
console.log('\n--- §P3. 会話: 移植元と比べる・確かめる手段が無ければ止める ---');
const U_PORT = '今ある入力チェックはモバイルでも同じように使いたい';
const portScript = ({ utterance }) => (utterance === U_PORT ? { reply: 'PC の入力チェックを、モバイルでも同じ判定で動くようにします。', intent: 'propose',
  proposal: { behaviors: [B('PC の既存の入力チェックを、モバイルでも同じ判定で動かす', 'user')], assumptions: [], decisions: [], approach: { standard: [], js: ['既存の入力チェックのモバイルへの移植'] }, cannot: [] },
  turn: { ops: [], answers: [], requirementOps: [req('add', { target: '入力チェック', condition: '', behavior: '既存の入力チェックをモバイルでも同じ判定で使う', sourceQuotes: [U_PORT], planRefs: ['B1'], effects: [] })] } } : null);
const portPlan = (args) => {
  const c = { ...C3(), dependsOn: [], evidenceIds: [] };
  const ops = (args.requirements || []).map(r => ({ op: 'update', id: r.id, target: r.target, condition: r.condition, behavior: r.behavior, exceptions: r.exceptions || [], decision: r.decision, disposition: 'adopted', sourceQuotes: [], planRefs: ['C3'], effects: [], note: '' }));
  const plan = { goal: args.goal, assessment: { summary: 'PC の入力チェックをモバイルへ移します。' }, steps: [{ id: 'C3', actionType: 'CUSTOMIZATION_REQUIRED', targetKind: 'JS', targetRef: null, title: 'JavaScript', spec: { customizationId: 'C3' }, dependsOn: [] }], customizations: [clone(c)], provisionals: [], questions: [], unknowns: [], impact: [], solution: 'CUSTOMIZATION' };
  return { plan, ctx: null, gatewayPlan: clone(plan), turn: { reply: 'PC の入力チェックをモバイルへ移します。', requirementOps: ops, utteranceCoverage: [] },
    review: { base: { baseVersion: '1', env: 'preview', ok: true, fingerprint: 'fp-1', revision: { preview: '10' } }, steps: [{ stepId: 'C3', status: 'VALID', safety: 'PLAN_ONLY', customization: clone(c), codeGeneration: { supported: true, strategy: 'NEW_JS_FILE', reason: null }, issues: [] }], executionReadiness: { safeSteps: [], reviewSteps: [], blockedSteps: [], planOnlySteps: ['C3'] }, warnings: [] } };
};
const pairOf = (ev) => ev.replace(/^mobile\./, '');
const VALUES = [['', '空', { stopped: true, errors: { amount: '金額を入力してください' }, eventError: null }], ['-1', '-1', { stopped: true, errors: { amount: '金額は0円以上で入力してください' }, eventError: null }], ['0', '0', { stopped: false, errors: {}, eventError: null }], ['1', '1', { stopped: false, errors: {}, eventError: null }]];
/** 生成工程の偽物: C3 の生成されたコードを返し、移植元と比べる代表条件（expect same-as-source・kind port）の結果を契約 20 の形で返す（KTAiClient.normalizeVerification を通す）。
 *  mode = pass（移植元と同じ）/ fail（負の数の判定を抜いた候補: -1 で移植元は止めるのに止めない）/
 *  fail-event（空のとき event.error で止める候補）/ fail-field（空のとき金額でなく品名（item_name）に error を置く候補）— レビュー T-5 の置き場所の違い */
const portGenerate = ({ mode = 'pass' } = {}) => {
  const seen = [];
  const failing = /^fail/.test(mode);
  const impl = async (args) => {
    seen.push({ cid: args.customizationId, version: args.version.version, requiredEffects: clone(args.requiredEffects || []) });
    const c = (args.version.plan.customizations || []).find(x => x.customizationId === args.customizationId);
    const e0 = (args.requiredEffects || [])[0] || {};
    const generated = { strategy: 'NEW_JS_FILE', targetFile: 'dealValidateMobile.js', summary: 'PC と同じ保存時の入力チェックをモバイルにも用意します。', code: F.C3_CODE, patch: null, events: [...M_SUBMITS], fields: [{ code: 'amount', access: 'CONTROL' }], apis: ['kintone.events.on'], assumptions: [], warnings: [], coverage: [{ requirementId: 'C3', status: 'MET', note: '', text: c.requirement }] };
    const review = KTCodeReview.review({ generated, customization: c, plan: args.version.plan, data: clone(K.DATA_C), scan: null, existingSource: null });
    const candidateHash = gwCandidateHash({ strategy: generated.strategy, targetFile: generated.targetFile, code: generated.code, patch: null, customizationId: 'C3' });
    let n = 0;
    const cases = (e0.events || []).flatMap(ev => VALUES.map(([val, ja, ref]) => {
      const mine = mode === 'fail' && val === '-1' ? { stopped: false, errors: {}, eventError: null }
        : mode === 'fail-event' && val === '' ? { stopped: true, errors: {}, eventError: '金額を入力してください' }
        : mode === 'fail-field' && val === '' ? { stopped: true, errors: { item_name: '金額を入力してください' }, eventError: null }
        : clone(ref);
      const fail = JSON.stringify(mine) !== JSON.stringify(ref);
      return { id: `K${++n}`, requirementId: 'C3', requirementIds: ['C3'], field: 'amount', effect: 'block-save', expect: 'same-as-source', side: 'match', kind: 'port', event: ev, refEvent: pairOf(ev), refFile: { file: 'dealValidate.js', target: 'desktop' }, verdict: fail ? 'fail' : 'pass', reference: ref, observed: mine, cause: fail ? 'expectation' : undefined,
        note: `金額 が ${ja} で${/create/.test(ev) ? 'モバイルの作成画面' : 'モバイルの編集画面'}で保存する: 移植元「dealValidate.js」と同じ動き（保存を止めるか・エラーの文）`,
        message: fail ? (mode === 'fail' ? `金額 が ${ja} で保存する: 移植元は止める・エラー「金額は0円以上で入力してください」のに、生成したコードは止めない` : `金額 が ${ja} で保存する: 移植元と違う動きです`) : '移植元と同じ動きです' };
    }));
    const raw = { version: '1', candidateHash, sameAsPrevious: false, passed: !failing, machine: [{ name: 'syntax', ok: true, severity: 'info', message: '構文エラーなし' }, { name: 'required-effects', ok: true, severity: 'info', message: '必須の効果の処理があります' }],
      requiredEffects: [{ requirementId: 'C3', requirementIds: ['C3'], field: 'amount', effect: 'block-save', status: 'present' }],
      behavior: { status: failing ? 'failed' : 'passed', reason: null, cases, ...clone(K.GW_SCOPE) }, repairs: { count: failing ? 1 : 0, reasons: [], stoppedBy: failing ? 'same-failure' : null }, unverified: ['実機での動作'] };
    const verification = KTAiClient.normalizeVerification(raw);
    return { ok: true, generated, review, ctx: { size: { approxTokens: 1000 } }, existingSource: null, inputHash: `h-${seen.length}`, verification, candidateHash, requirementIds: [{ id: 'C3', kind: 'customization', text: c.requirement }] };
  };
  return { impl, seen, calls: seen };
};
const convOf = ({ mode = 'pass', supported = true, jsFiles = () => JSF() } = {}) => {
  const gen = portGenerate({ mode });
  const x = makeConvC({ scriptFn: portScript, labels: LABELS, generate: gen, planImpl: portPlan, supported });
  x.services.jsFiles = jsFiles;
  return { x, gen };
};
const runPort = async (o) => { const r = convOf(o); await r.x.c.send(U_PORT); await r.x.c.send('採用します'); return { ...r, v: r.x.c.activePlan() }; };
await section(async () => {
  const { x, gen, v } = await runPort();
  const e = v && v.generated && v.generated.C3;
  const sent = gen.seen[0] && gen.seen[0].requiredEffects;
  assert(gen.seen.length === 1 && Array.isArray(sent) && sent.length === 1 && JSON.stringify(sent[0].conditionFrom) === JSON.stringify(CF) && sent[0].condition === '',
    `P3-1: 生成に渡す必須の効果に conditionFrom（移植元 dealValidate.js の保存のイベント）が付く（会話の呼び出し側が services.jsFiles と印から作る）: ${JSON.stringify(sent)}`);
  assert(e && e.status === 'verified' && v.final && v.final.approvable === true && x.calls.plan.length === 1,
    `P3-2: 移植元と比べる代表条件（same-as-source）の合格で検証済み・承認できる（計画の AI 1 回・生成 1 回・修復 0）: ${JSON.stringify({ status: e && e.status, verdict: e && e.verdict && [e.verdict.kind, e.verdict.reason], approvable: v.final && v.final.approvable, plans: x.calls.plan.length })}`);
  const html = K.stripC(T.KTAiChatUi.changeSummaryHtml(v, {}));   // 2026-10-14（設計し直し）: 代表条件の一覧と必須の動作の行は右の「変更内容」の検証の明細
  //   レビュー T-5（2026-10-14）: 期待の文を「止める（エラー「…」）」から「止める（「金額」（amount）のエラー「…」）」に変えた（error の置き場所（フィールド／画面全体）を出す。
  //   置き場所だけが違う不合格が同じ文に見えていたため）
  assert(/移植元「dealValidate\.js」と同じ動き/.test(html) && /移植元: 止める（「金額」（amount）のエラー「金額を入力してください」）／生成したコード: 止める（「金額」（amount）のエラー「金額を入力してください」）/.test(html) && /移植元: 止めない／生成したコード: 止めない/.test(html) && /「金額」（モバイル）: 保存を止める（移植元「dealValidate\.js」と同じ条件）/.test(html) && !/same-as-source/.test(html),
    `P3-3: 最終案の代表条件の一覧は「移植元「dealValidate.js」と同じ動き」と、比べた動き（移植元: 止める（「金額」（amount）のエラー「…」）／生成したコード: …）で出す。必須の動作の行は「保存を止める（移植元「dealValidate.js」と同じ条件）」（内部の語を出さない）: ${(html.match(/移植元「dealValidate[\s\S]{0,200}/) || [''])[0]}`);
});
await section(async () => {
  //   接続先が非対応（印 conditionFrom が無い）→ 生成を呼ばず準備未完了。計画の差分更新を自動で依頼しない・［計画を直すよう依頼する］を出さない
  const { x, gen, v } = await runPort({ supported: [...GEN_EFFECT_FEATURES] });
  const e = v && v.generated && v.generated.C3;
  const html = K.finalHtml(x);
  const reason = (e && e.verdict && e.verdict.reason) || '';
  //   レビュー T-2（2026-10-14）: 見出しは「必須の動作はまだ確かめていません」（動作は決まっていて、同じ条件かを確かめる手段が無いだけ。「特定できません」と言わない）。
  //   レビュー 3（2026-10-14・人が判断できる形）: 接続先が非対応のときだけ「この接続先では…検査ができません」。本文を取れない（読めない）ときは「同じ条件かは確かめていません」（不可能と読める「確かめられません」は使わない）
  assert(e && e.status === 'not-ready' && e.verdict.kind === 'effects-unknown' && e.verdict.port === true && !e.verdict.fix && /^必須の動作はまだ確かめていません（/.test(reason) && !/特定できません/.test(reason) && /「dealValidate\.js」/.test(reason) && /この接続先では同じ条件かを確かめる検査ができません/.test(reason) && /「いつでも保存を止める」にはしていません/.test(reason) && !/condition-unknown|not-capable|block-save/.test(reason),
    `P3-4: 接続先が非対応 → 準備未完了（見出しは「必須の動作はまだ確かめていません」。理由は移植元の名前と接続先の検査ができないこと。内部の語を出さない・［計画を直すよう依頼する］なし）: ${JSON.stringify(e && e.verdict)}`);
  assert(gen.seen.length === 0 && x.calls.plan.length === 1 && v.final && v.final.approvable === false && !v.final.fix && !/kt-ai-final-fix/.test(html) && (v.final.readiness.reasons || []).some(t => /移植元と同じかを、この接続先では確かめる検査ができない/.test(t && t.text)),
    `P3-5: 生成 0・計画の差分更新を自動で依頼しない（計画の AI 1 回）・最終案は承認できず、直す操作は出さない: ${JSON.stringify({ gens: gen.seen.length, plans: x.calls.plan.length, fix: v.final && v.final.fix, reasons: v.final && v.final.readiness && v.final.readiness.reasons })}`);
  const ns = await runPort({ jsFiles: () => JSF({ source: false }) });
  const en = ns.v && ns.v.generated && ns.v.generated.C3;
  assert(en && en.status === 'not-ready' && en.verdict.port === true && /^必須の動作はまだ確かめていません（/.test(en.verdict.reason) && /移植元の本文を取れない/.test(en.verdict.reason) && /同じ条件かは確かめていません/.test(en.verdict.reason) && !/確かめられません/.test(`${en.verdict.reason}${en.verdict.next}`) && /本文を取れないので、同じ条件かは確かめていません/.test(en.verdict.next) && (ns.v.final.readiness.reasons || []).some(t => /移植元の本文を取れない（読めない）ので確かめていません/.test(t && t.text)) && ns.gen.seen.length === 0 && ns.x.calls.plan.length === 1 && !ns.v.final.fix,
    `P3-6: 移植元の本文を送れない → 同じく準備未完了（見出しは「まだ確かめていません」。理由・次の方針・反映できない理由は「本文を取れないので、同じ条件かは確かめていません」）・生成 0・自動の差分更新なし: ${JSON.stringify(en && en.verdict)}`);
  //   レビュー T-1（2026-10-14）: 移植元のイベントの登録を本文から読めない（eventsUnresolved）→ 生成を呼ばず準備未完了（理由と次の方針は「読めない」。内部の語を出さない）
  const ur = await runPort({ jsFiles: () => JSF({ events: [], analyzed: true, eventsUnresolved: true }) });
  const eu = ur.v && ur.v.generated && ur.v.generated.C3;
  assert(eu && eu.status === 'not-ready' && eu.verdict.port === true && !eu.verdict.fix && /^必須の動作はまだ確かめていません（/.test(eu.verdict.reason) && /移植元「dealValidate\.js」のイベントの登録を本文から読めないので、同じ条件かは確かめていません/.test(eu.verdict.reason) && /イベントの登録を本文から読めないので、同じ条件かは確かめていません/.test(eu.verdict.next) && !/確かめられません/.test(`${eu.verdict.reason}${eu.verdict.next}`) && !/events-unreadable/.test(`${eu.verdict.reason}${eu.verdict.next}`) && ur.gen.seen.length === 0 && ur.x.calls.plan.length === 1 && ur.v.final.approvable === false && !ur.v.final.fix,
    `P3-6b: 移植元のイベントの登録を本文から読めない → 生成を呼ばず準備未完了（「いつでも」にしない・自動の差分更新なし・「確かめていません」の形）: ${JSON.stringify(eu && eu.verdict)}`);
  //   画面の解析が無い（services.jsFiles が null）→ 同じく止める（10-10 の不具合の経路: 空欄のまま生成へ渡さない）
  const nl = await runPort({ jsFiles: () => null });
  const el = nl.v && nl.v.generated && nl.v.generated.C3;
  assert(el && el.status === 'not-ready' && el.verdict.port === true && /^必須の動作はまだ確かめていません（/.test(el.verdict.reason) && /移植元の本文を取れない/.test(el.verdict.reason) && nl.gen.seen.length === 0 && nl.x.calls.plan.length === 1 && nl.v.final.approvable === false && !nl.v.final.fix,
    `P3-6c: 画面の解析が無い（jsFiles null）→ 生成を呼ばず準備未完了（「いつでも保存を止める」として生成へ渡さない）: ${JSON.stringify(el && el.verdict)}`);
});
await section(async () => {
  //   移植元と違う動き（負の数の判定を抜いた候補）→ 候補の誤り（修復の対象）。直す依頼の文は移植元の名前で書く
  const { x, gen, v } = await runPort({ mode: 'fail' });
  const e = v && v.generated && v.generated.C3;
  assert(e && e.status === 'unresolved' && e.verdict.kind === 'behavior-fail' && e.verdict.fix === 'revise' && gen.seen.length === 1 && v.final && v.final.approvable === false,
    `P3-7: 移植元と違う動き → 未解決（模擬テストの不合格。候補の誤り）: ${JSON.stringify(e && e.verdict && [e.verdict.status, e.verdict.kind, e.verdict.reason])}`);
  assert(v.final.fix && /「金額」の保存を止める動きが、移植元「dealValidate\.js」と同じになりませんでした（模擬テスト）/.test(v.final.fix.text) && /移植元は止める・エラー「金額は0円以上で入力してください」/.test(v.final.fix.text),
    `P3-8: 直す依頼の文は「移植元「dealValidate.js」と同じにならなかった」と、生成工程の記録（移植元の動き）で書く: ${v.final.fix && v.final.fix.text}`);
  const html = K.stripC(K.finalHtml(x));
  //   レビュー T-5: 文の形は P3-3 と同じく置き場所つき
  assert(/移植元: 止める（「金額」（amount）のエラー「金額は0円以上で入力してください」）／生成したコード: 止めない/.test(html), `P3-9: 最終案の代表条件の一覧に、比べた動きの違いを出す: ${(html.match(/移植元: 止める（「金額」（amount）のエラー「金額は0円以上[\s\S]{0,40}/) || [''])[0]}`);
});
await section(async () => {
  //   レビュー T-5（2026-10-14・Gateway の R-2 と同じ形）: error の置き場所の違い（event.error／別のフィールド）が、比べた動きの文に出る（同じ文の矛盾した行にしない）
  const ev = await runPort({ mode: 'fail-event' });
  const h1 = K.stripC(K.finalHtml(ev.x));
  assert(ev.v.generated.C3.status === 'unresolved' && /移植元: 止める（「金額」（amount）のエラー「金額を入力してください」）／生成したコード: 止める（画面全体のエラー「金額を入力してください」）/.test(h1),
    `P3-13: event.error で止める候補 → 生成したコードは「画面全体のエラー」と出る（移植元のフィールドの error と同じ文に見せない）: ${(h1.match(/移植元: 止める（「金額」（amount）のエラー「金額を入力してください」）／生成したコード: [^<]{0,60}/) || [''])[0]}`);
  const fd = await runPort({ mode: 'fail-field' });
  const h2 = K.stripC(K.finalHtml(fd.x));
  assert(fd.v.generated.C3.status === 'unresolved' && /移植元: 止める（「金額」（amount）のエラー「金額を入力してください」）／生成したコード: 止める（「品名」（item_name）のエラー「金額を入力してください」）/.test(h2),
    `P3-14: 別のフィールド（品名）に error を置く候補 → フィールド名とコードで置き場所の違いが出る: ${(h2.match(/移植元: 止める（「金額」（amount）のエラー「金額を入力してください」）／生成したコード: [^<]{0,60}/) || [''])[0]}`);
});
await section(async () => {
  //   流用の鍵: 移植元が同じ → 前の版の生成結果を流用／移植元が無くなった（移植元が保存のイベントを登録しなくなった）→ 作り直す（必須の効果が「いつでも」に変わる）
  let files = JSF();
  const { x, gen } = convOf({ jsFiles: () => files });
  await x.c.send(U_PORT); await x.c.send('採用します');
  const v1 = x.c.activePlan();
  assert(v1 && v1.generated.C3 && v1.generated.C3.status === 'verified' && gen.seen.length === 1, `P3-10: 前提: 1 版目は検証済み（生成 1 回）: ${JSON.stringify({ st: v1 && v1.generated.C3 && v1.generated.C3.status, gens: gen.seen.length })}`);
  await x.c.send('説明の文を少し丁寧にしてください');
  const v2 = x.c.activePlan();
  assert(v2 && v2.version !== v1.version && v2.generated.C3 && v2.generated.C3.reused === true && gen.seen.length === 1, `P3-11: 移植元が同じなら流用する（生成を呼ばない）: ${JSON.stringify({ ver: [v1.version, v2 && v2.version], reused: v2 && v2.generated.C3 && v2.generated.C3.reused, gens: gen.seen.length })}`);
  files = JSF({ events: ['app.record.edit.show'] });
  await x.c.send('もう一度確認してください');
  const v3 = x.c.activePlan();
  const sent3 = gen.seen[1] && gen.seen[1].requiredEffects;
  assert(v3 && v3.version !== v2.version && v3.generated.C3 && !v3.generated.C3.reused && gen.seen.length === 2 && Array.isArray(sent3) && sent3.length === 1 && !sent3[0].conditionFrom,
    `P3-12: 移植元が無くなった → 流用せず作り直す（必須の効果に conditionFrom が無い）: ${JSON.stringify({ reused: v3 && v3.generated.C3 && v3.generated.C3.reused, gens: gen.seen.length, sent3 })}`);
});

// =========================================================
console.log('\n--- §P4. 語彙（case-invalid・condition-unknown）と health の印 ---');
await section(async () => {
  const R = KTAiConversation.BEHAVIOR_REASONS;
  assert(R['case-invalid'] && R['case-invalid'].category === 'env' && !R['case-invalid'].fix && /模擬テストの入力（代表条件）の形が隔離環境の約束と合わない/.test(R['case-invalid'].text) && /生成したコードの誤りとは判定していません/.test(R['case-invalid'].text),
    `P4-1: case-invalid は区分 env（修復も作り直しも出さない）・文は契約 20 §13 と同じ: ${JSON.stringify(R['case-invalid'])}`);
  assert(R['condition-unknown'] && R['condition-unknown'].category === 'condition' && /保存を止める条件が分からない/.test(R['condition-unknown'].text), `P4-2: condition-unknown は区分 condition（計画を直す対象）: ${JSON.stringify(R['condition-unknown'])}`);
});
await section(async () => {
  //   壊れた入力（case-invalid）の not-run → 環境の区分。修復も［計画を直すよう依頼する］も出さない・「環境が使えない」とまとめない
  const gen = K.makeGenerate({ sequence: ['good'], env: 'case-invalid', caseReason: 'case-invalid' });
  const x = makeConvC({ generate: gen });
  await K.adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1;
  const html = K.finalHtml(x);
  assert(e && e.status === 'not-run' && e.verdict.kind === 'environment' && !e.verdict.fix && /模擬テストの入力（代表条件）の形が隔離環境の約束と合わない/.test(e.verdict.reason) && !/模擬テストの環境が使えない/.test(e.verdict.reason),
    `P4-3: case-invalid の not-run → 環境の区分（直す操作なし）・理由は入力の不正（環境が使えない、とまとめない）: ${JSON.stringify(e && e.verdict && [e.verdict.kind, e.verdict.fix, e.verdict.reason])}`);
  assert(gen.calls.length === 1 && !v.final.fix && !/kt-ai-final-fix/.test(html) && v.final.approvable === false && (v.final.readiness.reasons || []).some(t => /検証の入力の問題です/.test(t && t.text) && /修復は依頼していません/.test(t && t.text)),
    `P4-4: 生成 1 回のまま（作り直さない）・［計画を直すよう依頼する］を出さない・承認できない理由は入力の不正: ${JSON.stringify({ gens: gen.calls.length, fix: v.final.fix, reasons: v.final.readiness.reasons })}`);
});
await section(async () => {
  //   condition-unknown の not-run（Gateway が conditionFrom を受け付けなかった）→ 計画を直す。条件を推測で書かせない（「フィールドと値の比較」の指示にしない）
  const gen = K.makeGenerate({ sequence: ['good'], env: 'condition-unknown', caseReason: 'condition-unknown' });
  const x = makeConvC({ generate: gen });
  await K.adoptC(x);
  const v = x.c.activePlan(), e = v.generated.C1;
  assert(e && e.status === 'not-run' && e.verdict.category === 'condition' && e.verdict.fix === 'revise' && v.final.fix && /保存を止める条件を推測で書かないでください/.test(v.final.fix.text) && !/フィールドと値の比較/.test(v.final.fix.text) && gen.calls.length === 1,
    `P4-5: condition-unknown → 区分 condition・［計画を直すよう依頼する］の文は移植元から引き継ぐ指示（条件を推測で書かせない）・修復しない: ${JSON.stringify({ v: e && e.verdict && [e.verdict.category, e.verdict.fix], fix: v.final.fix && v.final.fix.text })}`);
});
await section(async () => {
  //   health の印: tableRowChange・caseInvalid のどちらかが欠ける接続先は「接続先が非対応」（壊れた入力で正しい候補を不合格にする形の Gateway を新しい形として受け入れない）
  const out = [];
  for (const mark of ['tableRowChange', 'caseInvalid']) {
    const x = makeConvC({ supported: GEN_EFFECT_FEATURES.filter(f => f !== mark) });
    await K.adoptC(x);
    out.push([mark, x.c.activePlan().generated.C1.status, x.c.activePlan().final.approvable]);
  }
  assert(out.every(r => r[1] === 'unsupported' && r[2] === false), `P4-6: 印 tableRowChange・caseInvalid が欠ける接続先は「接続先が非対応」: ${JSON.stringify(out)}`);
  const y = makeConvC({ supported: [...GEN_EFFECT_FEATURES] });
  await K.adoptC(y);
  assert(y.c.activePlan().generated.C1.status === 'verified', 'P4-7: 印 conditionFrom が無くても、移植元の無い計画は今までどおり検証済み（conditionFrom は移植元の判定だけに使う）');
});

// =========================================================
console.log('\n--- §P5. 生成結果の正規化: 修復しなかった理由・移植元と比べた動き ---');
await section(async () => {
  const raw = { version: '1', candidateHash: 'abcdef0123456789', passed: true, machine: [], requiredEffects: [{ requirementId: 'C3', field: 'amount', effect: 'block-save', status: 'present' }],
    behavior: { status: 'not-run', reason: 'partial', cases: [{ id: 'K1', requirementId: 'C3', field: 'amount', effect: 'block-save', expect: 'same-as-source', side: 'match', kind: 'port', event: 'mobile.app.record.edit.submit', refEvent: 'app.record.edit.submit', refFile: { file: 'dealValidate.js', target: 'desktop' }, verdict: 'pass', reference: { stopped: true, errors: { amount: '金額を入力してください' }, eventError: null }, message: 'ok' }, { id: 'K2', requirementId: 'C3', field: 'amount', effect: 'block-save', expect: 'block-save', side: 'match', verdict: 'not-run', reason: 'case-invalid', message: '模擬テストの入力の形が合いません' }] },
    repairs: { count: 0, reasons: ['模擬テストの入力の不正（1 件）は生成したコードの不合格ではないので、修復を依頼していません'], stoppedBy: null, notRepaired: [{ reason: 'case-invalid', category: 'environment', count: 1 }, { reason: 'condition-unknown', category: 'condition', count: 2 }, { reason: 'x', count: 0 }] } };
  const n = KTAiClient.normalizeVerification(raw);
  assert(n && n.repairs && JSON.stringify(n.repairs.notRepaired) === JSON.stringify([{ reason: 'case-invalid', category: 'environment', count: 1 }, { reason: 'condition-unknown', category: 'condition', count: 2 }]),
    `P5-1: repairs.notRepaired（理由ごとの数）を落とさない（数が 0 のものは落とす）: ${JSON.stringify(n && n.repairs)}`);
  const k1 = n.behavior.cases[0];
  assert(k1.expect === 'same-as-source' && k1.kind === 'port' && k1.refEvent === 'app.record.edit.submit' && JSON.stringify(k1.refFile) === JSON.stringify({ file: 'dealValidate.js', target: 'desktop' }) && k1.reference && k1.reference.stopped === true && k1.reference.errors.amount === '金額を入力してください' && k1.reference.eventError === null,
    `P5-2: 移植元と比べた代表条件の refFile・refEvent・reference を落とさない: ${JSON.stringify(k1)}`);
  const n0 = KTAiClient.normalizeVerification({ ...raw, repairs: { count: 0, reasons: [], stoppedBy: null } });
  assert(!('notRepaired' in n0.repairs), 'P5-3: notRepaired が無い応答（今までの Gateway）では持たない');
});
await section(async () => {
  //   最終案の詳細（代表条件の一覧）に、修復を依頼しなかった結果を 1 行で出す
  const notRepGen = () => {
    const base = K.makeGenerate({ sequence: ['good'], env: 'case-invalid', caseReason: 'case-invalid' });
    return { calls: base.calls, impl: async (args) => { const r = await base.impl(args); r.verification.repairs = { ...r.verification.repairs, notRepaired: [{ reason: 'case-invalid', category: 'environment', count: 2 }] }; return r; } };
  };
  const x = makeConvC({ generate: notRepGen() });
  await K.adoptC(x);
  const html = T.KTAiChatUi.changeSummaryHtml(x.c.activePlan(), {});   // 2026-10-14: 右の「変更内容」の検証の明細
  assert(/修復を依頼しなかった結果: 模擬テストの入力の不正 2 件（生成したコードの不合格ではありません）/.test(K.stripC(html)) && /kt-ai-final-not-repaired/.test(html),
    `P5-4: 最終案の詳細に「修復を依頼しなかった結果: 模擬テストの入力の不正 N 件」を出す: ${(K.stripC(html).match(/修復を依頼しなかった[\s\S]{0,80}/) || [''])[0]}`);
});

// =========================================================
console.log('\n--- §P6. 画面: 画面の解析から jsFiles を作り、生成の要求に conditionFrom と移植元の本文が載る ---');
await section(async () => {
  const inputs = clone(K.INPUTS);
  inputs.data.customize.desktop.js.push({ type: 'FILE', file: { contentType: 'text/javascript', fileKey: '20261010000000VVVV', name: 'dealValidate.js', size: String(F.DEAL_VALIDATE_JS.length) } });
  inputs.scan.files = [...(inputs.scan.files || []), { name: 'dealValidate.js', target: 'desktop', kind: 'js', text: F.DEAL_VALIDATE_JS }];
  inputs.scan.results = [...(inputs.scan.results || []), { code: 'amount', matches: [{ kind: 'js', file: 'dealValidate.js', target: 'desktop', access: 'READ' }] }];
  const custP = { ...C3(), dependsOn: [], evidenceIds: [] };
  const planRaw = (goal) => { const b = K.PLAN_V1(goal); return { ...b, plan: { ...b.plan, solution: 'CUSTOMIZATION', assessment: { ...b.plan.assessment, summary: 'PC の入力チェックをモバイルへ移します。' }, steps: [K.mkStep('C3', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C3' }, { title: 'JavaScript', solution: 'CUSTOMIZATION' })], customizations: [clone(custP)] } }; };
  const calls = [];
  const genImpl = async ({ ctx, requestId }) => {
    calls.push(clone(ctx));
    const re = (ctx.verification && ctx.verification.requiredEffects) || [];
    const candidateHash = gwCandidateHash({ strategy: 'NEW_JS_FILE', targetFile: 'dealValidateMobile.js', code: F.C3_CODE, customizationId: 'C3' });
    const cases = re.flatMap(e => (e.events || []).flatMap((ev, i) => VALUES.map(([val, ja, ref], j) => ({ id: `K${i}-${j}`, requirementId: 'C3', requirementIds: ['C3'], field: 'amount', effect: 'block-save', expect: 'same-as-source', side: 'match', kind: 'port', event: ev, refEvent: pairOf(ev), refFile: { file: 'dealValidate.js', target: 'desktop' }, verdict: 'pass', reference: ref, observed: ref, note: `金額 が ${ja} で保存する: 移植元と同じ動き`, message: '移植元と同じ動きです' }))));
    const resp = { ok: true, contractVersion: '2.1', meta: { requestId, gateway: { product: 'toolkit', feature: 'customization-generator', promptVersion: '1', contextVersion: 'customization-1' }, normalization: { warnings: [] }, ai: { model: 'm' } },
      generated: { strategy: 'NEW_JS_FILE', targetFile: 'dealValidateMobile.js', summary: 'PC と同じ保存時の入力チェックをモバイルにも用意します。', code: F.C3_CODE, patch: null, events: [...M_SUBMITS], fields: [{ code: 'amount', access: 'CONTROL' }], apis: ['kintone.events.on'], assumptions: [], warnings: [], coverage: [{ requirementId: 'C3', status: 'MET', note: '' }] },
      verification: { version: '1', candidateHash, sameAsPrevious: false, passed: true, machine: [{ name: 'syntax', ok: true, severity: 'info', message: '構文エラーなし' }], requiredEffects: re.map(e => ({ requirementId: e.requirementId, requirementIds: e.requirementIds, field: e.field, effect: e.effect, status: 'present' })), behavior: { status: 'passed', reason: null, cases, ...clone(K.GW_SCOPE) }, repairs: { count: 0, reasons: [], stoppedBy: null }, unverified: [] } };
    const vv = KTAiClient.validateGenerated(resp, ctx);
    if (!vv.ok) throw new Error(JSON.stringify(vv.errors));
    return { ...vv.normalized, requestId };
  };
  const m = K.mount({ health: K.HEALTH_V, planImpl: K.planImplOf(planRaw), generateImpl: genImpl, extra: { getInputs: () => inputs } });
  await K.ticks();
  const v = await K.adoptOnScreen(m);
  await K.ticks(20);
  const ctx = calls[0] || null;
  const re = ctx && ctx.verification && ctx.verification.requiredEffects;
  const of = ctx && (ctx.otherFiles || []).find(f => f.name === 'dealValidate.js');
  assert(ctx && Array.isArray(re) && re.length === 1 && JSON.stringify(re[0].conditionFrom) === JSON.stringify(CF) && of && of.source === F.DEAL_VALIDATE_JS && of.sourceUse === 'reference-only',
    `P6-1: 画面: 画面の解析（scan）から jsFiles を作り（services.jsFiles）、health の印 conditionFrom がある接続先で、生成の ctx の requiredEffects に conditionFrom・otherFiles に移植元の本文: ${JSON.stringify({ calls: calls.length, re, of: of && { name: of.name, src: typeof of.source } })}`);
  const fv = (m.conv().activePlan() || v || {});
  assert(fv.generated && fv.generated.C3 && fv.generated.C3.status === 'verified', `P6-2: 画面でも C3 は移植元と比べる代表条件で検証済み: ${JSON.stringify(fv.generated && fv.generated.C3 && fv.generated.C3.verdict)}`);
});

// =========================================================
console.log('\n--- §P7. 文言（§6）: 行の追加・削除を「kintone の JavaScript では止められない」と言い切らない ---');
await section(async () => {
  const src = fs.readFileSync(process.env.KT_SRC || path.join(__dirname, '..', 'kintoneAppToolkit.user.js'), 'utf8');
  for (const s of ['kintone の JavaScript では止められません', '編集できなくできるのはセルだけ', '行の追加・削除は JavaScript では止められない', '行の追加・削除は JavaScript では止められません']) assert(!src.includes(s), `P7-1: 本文に言い切り「${s}」が残っていない`);
});
await section(async () => {
  //   SUBTABLE_ROWS の判定（実現できない点。承認を止めない）は今のまま。文だけ変えた
  //   簡素化 B（2026-10-17）: 当てはまるかは計画の構造（明細に編集不可の効果がある）で決める（以前はコードのセルの編集不可を解析していた）
  const c = { customizationId: 'C1', requirement: '承認済みでは明細を編集不可にする', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'ステータス', access: 'READ' }, { code: 'items', access: 'CONTROL', condition: 'ステータス in ("承認済み")', effects: ['lock'] }], apis: [], existingFiles: [] };
  const code = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'].value === '承認済み') {\n      record['items'].value.forEach(function (row) {\n        for (const key in row.value) { row.value[key].disabled = true; }\n      });\n    }\n    return event;\n  });\n})();";
  const generated = { strategy: 'NEW_JS_FILE', targetFile: 'lock.js', summary: '承認済みでは明細を編集不可にします。', code, patch: null, events: ['app.record.edit.show'], fields: [{ code: 'items', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], coverage: [{ requirementId: 'C1', status: 'MET', note: '' }] };
  const rv = KTCodeReview.review({ generated, customization: c, plan: { customizations: [c] }, data: clone(K.DATA_C), scan: null, existingSource: null });
  const row = rv.coverage && rv.coverage.notAchieved.find(x => x.code === 'SUBTABLE_ROWS');
  assert(row && /セルを編集不可にしても、明細（テーブル）の行の追加・削除は止まりません/.test(row.message) && /ボタンを隠す API は Toolkit がまだ扱っていません/.test(row.message) && rv.registration.verdict !== 'BLOCKED',
    `P7-2: SUBTABLE_ROWS は今のまま出る（符号・承認を止めない）。文は「セルを編集不可にしても…止まりません（…ボタンを隠す API は Toolkit がまだ扱っていません）」: ${JSON.stringify({ row, verdict: rv.registration && rv.registration.verdict })}`);
  //   P7-3（計画の確認の JS_LIMIT_SUBTABLE_ROWS）は、要件の文の語の照合なので 2026-10-17 に削除した（行が残ることは上の P7-2 の SUBTABLE_ROWS が示す）
  //   生成の AI に渡すテーブルの扱いの文も言い切らない
  const ctx = KTContext.buildGenerator({ customization: { ...c, fields: [{ code: 'ステータス', access: 'READ' }, { code: 'qty', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }] }, plan: { customizations: [c] }, data: clone(K.DATA_C), scan: null, options: { now: '2026-10-10T00:00:00.000Z' } });
  const how = (((ctx.constraints || {}).tables || [])[0] || {}).how || '';
  assert(/セルの disabled では行の追加・削除は止まらない/.test(how) && !/JavaScript では止められない/.test(how), `P7-4: 生成の ctx のテーブルの扱い（constraints.tables[].how）も言い切らない: ${how}`);
});

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed, ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})();
