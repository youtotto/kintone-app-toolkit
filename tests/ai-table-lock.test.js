// 対象がテーブル（明細）の「編集できない」要件と、計画が列に置いた「編集できない」の結び付き（2026-10-10・C1 の検証素材の整理で判明。有料の AI は使わない）
//
// 経緯: 受信の切り分け（2026-10-10）で、手で作った模擬の計画（C1 の fields に明細の列が無く、テーブル items に「編集できない」）で本物の生成を 1 回通したところ、
//   生成工程の AI は計画に無い列を使わず（生成の指示: 計画の fields の範囲だけを使う）、金額だけを編集不可にして「明細: 編集できない」が要件未達になった。
//   素材を実 AI の CX-1 の計画の形（AI版 sandbox/test/fixtures/scenarios/cx1.js の C1: 金額と品名・数量・単価に「編集できない」・テーブルは fields に無い）に直すと、
//   利用者の要件「明細を編集不可」（target 明細・effects lock）の対象を計画のフィールドから特定できず（target-unresolved。テーブルを READ で入れると no-owner-field）、
//   生成の前に準備未完了になった。kintone の disabled はセル（列）に効き、テーブル自体には効かないので、テーブルを対象にした「編集できない」は列で満たす（27ef05e）。
//   同日の確認の指摘 2 件: 27ef05e は計画の列が 1 つでもあればテーブル全体を満たした扱いにし（品名だけでも未解決 0）、条件も「全部の列に条件が無い」ときだけ不足にしていた。
//   → 要る列はアプリの構造（そのテーブルの列）から、入力できない列（KTContext.readOnlyFieldCodes。計算・自動計算・ルックアップのコピー先など、フィールドの定義の根拠）を
//   除いて決め、列ごとに担当と条件を確かめる（不足は未解決に残す）
//
// 検証内容:
//   §L1 requiredEffectsOf（KTAiConversation）:
//        要る列がそろい条件もある（CX-1 の C1 の形・テーブルを READ で入れた形）→ 未解決 0（計算の小計はフィールドの定義の根拠で除く）／
//        3 列中 1 列だけ → 残りの 2 列の不足（no-owner-field・table つき）／全列あるが一部の列の条件が空 → その列の condition-unknown（要件の id はその列に付けない）／
//        入力できない列の根拠が「無し」（[]）なら小計も要る列・根拠が無い（null）なら列に引き継がない（今までどおり特定できない）／
//        テーブル自体に「編集できない」を置いた計画（列なし）は、根拠があれば列の不足・根拠が無ければテーブルのまま／列が CONTROL で「編集できない」が無い → 列の条件で足す／
//        同じ画面で同じ要件が planRefs で指す別の customization が列を担当 → その customization の担当（planRefs に無ければ不足のまま）／
//        別の画面の customization の列では満たさない／表示の切り替えは結び付けない／「金額と明細」のような複数の対象は特定できないまま／列の構造が無ければ今までどおり
//   §L2 会話: 仮案の要件（金額・明細に「編集できない」）→ 採用 → 計画（CX-1 の C1 の形・列だけ）→ 必須の効果 4 件・検証済み・承認できる。
//        計画が品名だけ → 準備未完了（理由は列の名前で・内部のコードを出さない）・計画の差分更新を 1 回依頼（テーブルの列の指示つき）・生成 0・承認できない。
//        前の版で 2 つの JavaScript が列を分担して検証済み → 片方を外した版では、残った JavaScript を流用せず不足を出す（流用で不足を隠さない）
//
// 実行方法: node tests/ai-table-lock.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
//   簡素化（2026-10-17）: 反映できるかは、最新の版なら会話の今の判定、前の版なら最終案の記録で確かめる（tests/helpers/final-state.js）
const FS = require('./helpers/final-state.js');
const { gwCandidateHash } = require('./helpers/gw-hash.js');
const T = loadToolkit();
const { KTAiConversation, KTCodeReview, KTScan, KTContext, KTDeps } = T;
const { assert, state } = makeAssert();
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const { clone, B, req, makeConvC } = K;
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }

const ST = 'ステータス in ("承認済み")';
const LABELS = { amount: '金額', items: '明細', item_name: '品名', qty: '数量', unit_price: '単価', subtotal: '小計', 'ステータス': 'ステータス' };
const COLUMNS = { item_name: 'items', qty: 'items', unit_price: 'items', subtotal: 'items' };
/** 入力できないフィールドの根拠: App 353 のフィールドの定義（tests/fixtures/p21-bfc-replay.js の FIELDS = K.DATA_C.fields）を、画面と同じ KTContext.readOnlyFieldCodes に通す */
const RO = [...KTContext.readOnlyFieldCodes(KTDeps.normalizeFields(K.DATA_C.fields))];
const lockF = (code, condition = ST) => ({ code, access: 'CONTROL', condition, effects: ['lock'] });
/** 実 AI の CX-1 の計画の C1 の fields（cx1.js。効果は今の契約の形で補ったもの）。テーブル items は fields に無い */
const CX1_C1_FIELDS = [{ code: 'ステータス', access: 'READ' }, lockF('amount'), lockF('item_name'), lockF('qty'), lockF('unit_price')];
const planOf = (custs) => ({ customizations: custs, proposedFields: [] });
const cust = (id, fields, o = {}) => ({ customizationId: id, strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.create.show', 'app.record.edit.show'], fields, ...o });
const R = (id, target, effects, o = {}) => ({ id, target, condition: '承認済み', behavior: '編集不可にする', decision: 'decided', disposition: 'adopted', planRefs: ['C1'], effects, ...o });
const REQS = [R('R3', '金額', ['lock']), R('R4', '明細', ['lock'])];
const sum = (r) => ({ effects: r.effects.map(e => `${e.field}|${e.effect}|${[...e.requirementIds].sort().join('+')}`).sort(), unresolved: r.unresolved.map(u => `${u.field}|${u.effect || ''}|${u.reason}|${u.requirementId || ''}${u.table ? `|table:${u.table}` : ''}`).sort() });
const reqOf = (plan, reqs, o = {}, cid = 'C1') => KTAiConversation.requiredEffectsOf(plan, cid, reqs, { labels: LABELS, columns: COLUMNS, readOnly: RO, ...o });
const MISSING = (col, rid = 'R4') => `${col}|lock|no-owner-field|${rid}|table:items`;
const CONDU = (col, rid = 'R4') => `${col}|lock|condition-unknown|${rid}|table:items`;

(async () => {
// =========================================================
console.log('\n--- §L1. requiredEffectsOf: テーブルを対象にした「編集できない」を、編集できる列ごとに確かめる ---');
await section(async () => {
  assert(JSON.stringify(RO.filter(c => COLUMNS[c])) === JSON.stringify(['subtotal']), `L1-0: 前提: 入力できない列はフィールドの定義から小計（計算）だけ: ${JSON.stringify(RO)}`);
  const s = sum(reqOf(planOf([cust('C1', clone(CX1_C1_FIELDS))]), REQS));
  assert(JSON.stringify(s.effects) === JSON.stringify(['amount|lock|C1+R3', 'item_name|lock|C1+R4', 'qty|lock|C1+R4', 'unit_price|lock|C1+R4']) && s.unresolved.length === 0,
    `L1-1: 要る列（品名・数量・単価）がそろい条件もある（CX-1 の C1 の形・テーブルは fields に無い）→ 未解決 0。計算の小計は根拠で除き、不足にしない: ${JSON.stringify(s)}`);
  const s2 = sum(reqOf(planOf([cust('C1', [...clone(CX1_C1_FIELDS), { code: 'items', access: 'READ' }])]), REQS));
  assert(JSON.stringify(s2.effects) === JSON.stringify(s.effects) && s2.unresolved.length === 0, `L1-2: テーブルを READ で入れた形でも同じ: ${JSON.stringify(s2)}`);
});
await section(async () => {
  //   指摘 1: 一部の列だけでテーブル全体を満たした扱いにしない
  const s = sum(reqOf(planOf([cust('C1', [{ code: 'ステータス', access: 'READ' }, lockF('amount'), lockF('item_name')])]), REQS));
  assert(JSON.stringify(s.unresolved) === JSON.stringify([MISSING('qty'), MISSING('unit_price')]) && s.effects.includes('item_name|lock|C1+R4'),
    `L1-3: 3 列中 1 列（品名）だけ → 数量・単価の不足を残す（テーブル全体を満たした扱いにしない）: ${JSON.stringify(s)}`);
  //   指摘 2: 条件の抜けを列ごとに扱う
  const mixed = [{ code: 'ステータス', access: 'READ' }, lockF('amount'), lockF('item_name'), lockF('qty', ''), lockF('unit_price', '')];
  const s4 = sum(reqOf(planOf([cust('C1', mixed)]), REQS));
  assert(JSON.stringify(s4.unresolved) === JSON.stringify([CONDU('qty'), CONDU('unit_price')]) && s4.effects.includes('item_name|lock|C1+R4') && s4.effects.includes('qty|lock|C1') && s4.effects.includes('unit_price|lock|C1'),
    `L1-4: 全列あるが数量・単価の条件が空 → その 2 列の condition-unknown（要件の id は条件のある品名だけ・「いつでも」の編集不可を要件の実現にしない）: ${JSON.stringify(s4)}`);
  const noneCond = [{ code: 'ステータス', access: 'READ' }, lockF('amount'), lockF('item_name', ''), lockF('qty', '')];
  const s5 = sum(reqOf(planOf([cust('C1', noneCond)]), REQS));
  assert(JSON.stringify(s5.unresolved) === JSON.stringify([CONDU('item_name'), CONDU('qty'), MISSING('unit_price')].sort()) && !s5.effects.some(k => /R4/.test(k)),
    `L1-5: 条件の空の列と足りない列が混ざる → 列ごとに condition-unknown と不足: ${JSON.stringify(s5)}`);
});
await section(async () => {
  //   入力できない列は根拠で除く（根拠を変えると結果が変わる＝計画の列から推測していない）
  const plan = planOf([cust('C1', clone(CX1_C1_FIELDS))]);
  const sNone = sum(reqOf(plan, REQS, { readOnly: [] }));
  assert(JSON.stringify(sNone.unresolved) === JSON.stringify([MISSING('subtotal')]), `L1-6: 入力できない列の根拠が「無し」（[]）なら小計も要る列（計算の列を除いたのは根拠による）: ${JSON.stringify(sNone)}`);
  const sNull = sum(reqOf(plan, REQS, { readOnly: null }));
  assert(sNull.unresolved.includes('|lock|target-unresolved|R4') && !sNull.effects.some(k => /R4/.test(k)), `L1-7: 根拠が無い（null）なら列に引き継がず、今までどおり特定できない（満たした扱いにしない・列を推測しない）: ${JSON.stringify(sNull)}`);
  const tableLevel = planOf([cust('C1', [{ code: 'ステータス', access: 'READ' }, lockF('amount'), lockF('items')])]);
  const sT = sum(reqOf(tableLevel, REQS));
  assert(JSON.stringify(sT.unresolved) === JSON.stringify([MISSING('item_name'), MISSING('qty'), MISSING('unit_price')]) && !sT.effects.includes('items|lock|C1+R4'),
    `L1-8: テーブル自体に「編集できない」を置いた計画（列なし）は、根拠があれば列の不足（テーブルの disabled では満たさない）: ${JSON.stringify(sT)}`);
  const sT0 = sum(reqOf(tableLevel, REQS, { readOnly: null }));
  assert(sT0.effects.includes('items|lock|C1+R4') && sT0.unresolved.length === 0, `L1-9: 同じ計画で根拠が無ければ今までどおりテーブルのまま: ${JSON.stringify(sT0)}`);
  const ctrl = [{ code: 'ステータス', access: 'READ' }, lockF('amount'), lockF('item_name'), { code: 'qty', access: 'CONTROL', condition: ST, effects: ['warn'] }, lockF('unit_price')];
  const sC = sum(reqOf(planOf([cust('C1', ctrl)]), REQS));
  assert(sC.unresolved.length === 0 && sC.effects.includes('qty|lock|R4') && sC.effects.includes('item_name|lock|C1+R4'), `L1-10: 列が CONTROL で「編集できない」が無い → 直接の対象と同じく列の条件で足す: ${JSON.stringify(sC)}`);
});
await section(async () => {
  //   既存の担当: 同じ画面で同じ要件が planRefs で指す別の customization が列に「編集できない」を明示しているときだけ
  const split = planOf([cust('C1', [{ code: 'ステータス', access: 'READ' }, lockF('amount'), lockF('item_name')]), cust('C1b', [{ code: 'ステータス', access: 'READ' }, lockF('qty'), lockF('unit_price')])]);
  const both = [R('R3', '金額', ['lock']), R('R4', '明細', ['lock'], { planRefs: ['C1', 'C1b'] })];
  const a = sum(reqOf(split, both)), b = sum(reqOf(split, both, {}, 'C1b'));
  assert(a.unresolved.length === 0 && b.unresolved.length === 0 && a.effects.includes('item_name|lock|C1+R4') && b.effects.includes('qty|lock|C1b+R4') && b.effects.includes('unit_price|lock|C1b+R4'),
    `L1-11: 同じ画面の 2 つの JavaScript が要件の planRefs で列を分担 → どちらも未解決 0（列ごとの条件と要件の id はそれぞれの計算で確かめる）: ${JSON.stringify({ a, b })}`);
  const c = sum(reqOf(split, REQS));
  assert(JSON.stringify(c.unresolved) === JSON.stringify([MISSING('qty'), MISSING('unit_price')]), `L1-12: 別の JavaScript が列を持っていても、要件の planRefs に無ければ担当にしない（推測で不足を消さない）: ${JSON.stringify(c)}`);
  const otherScreen = planOf([cust('C1', [{ code: 'ステータス', access: 'READ' }, lockF('amount'), lockF('item_name')]), cust('C2', [lockF('qty'), lockF('unit_price')], { platform: ['mobile'], events: ['mobile.app.record.edit.show'] })]);
  const d = sum(reqOf(otherScreen, [R('R3', '金額', ['lock']), R('R4', '明細', ['lock'], { planRefs: ['C1', 'C2'] })]));
  assert(JSON.stringify(d.unresolved) === JSON.stringify([MISSING('qty'), MISSING('unit_price')]), `L1-13: 別の画面（モバイル）の JavaScript の列では PC の不足を満たさない: ${JSON.stringify(d)}`);
});
await section(async () => {
  //   今までどおりの形
  const sh = [{ code: 'ステータス', access: 'READ' }, { code: 'item_name', access: 'CONTROL', condition: ST, effects: ['show-hide'] }];
  const r5 = reqOf(planOf([cust('C1', sh)]), [R('R5', '明細', ['show-hide'])]);
  assert(!r5.effects.some(e => e.requirementIds.includes('R5')) && r5.unresolved.some(u => u.requirementId === 'R5' && u.reason === 'target-unresolved'), `L1-14: 表示の切り替えはテーブルの列に結び付けない（今までどおり）: ${JSON.stringify(sum(r5))}`);
  //   2026-10-16（評価の記録 §12.35 の残る限界の修正）: 「金額と明細」のような 1 つのフィールドの名前でない対象は、文を分けずに customization の単位で確かめる
  //   （計画がこの JavaScript に置いた同じ効果の組に要件の id を足す。効果は足さない）。以前は特定できないまま止めていた（計画の AI に対象の付け替えを求めた）
  const s6 = sum(reqOf(planOf([cust('C1', clone(CX1_C1_FIELDS))]), [R('R3', '金額と明細', ['lock'])]));
  assert(JSON.stringify(s6.effects) === JSON.stringify(['amount|lock|C1+R3', 'item_name|lock|C1+R3', 'qty|lock|C1+R3', 'unit_price|lock|C1+R3']) && s6.unresolved.length === 0, `L1-15: 「金額と明細」のような複数の対象は、計画が置いた同じ効果の組に結び付け、止めない: ${JSON.stringify(s6)}`);
  const s7 = sum(reqOf(planOf([cust('C1', clone(CX1_C1_FIELDS))]), REQS, { columns: {} }));
  assert(s7.unresolved.includes('|lock|target-unresolved|R4'), `L1-16: 列の構造（tableColumns）が無ければ今までどおり（特定できない）: ${JSON.stringify(s7)}`);
});
await section(async () => {
  //   一度だけの反証の確認（2026-10-10）で見つかった形
  //   別の JavaScript に任せる列の条件は、ここでも確かめる（その JavaScript の計算で要件が材料から外れても、条件の無い編集不可で満たさない）
  const both = [R('R3', '金額', ['lock']), R('R4', '明細', ['lock'], { planRefs: ['C1', 'C2'] })];
  const noCondOther = planOf([cust('C1', [{ code: 'ステータス', access: 'READ' }, lockF('amount'), lockF('item_name')]), cust('C2', [lockF('qty', ''), lockF('unit_price')])]);
  const a = sum(reqOf(noCondOther, both));
  assert(JSON.stringify(a.unresolved) === JSON.stringify([CONDU('qty')]), `L1-17: 別の JavaScript の列の編集不可に条件が無ければ、任せた側でも condition-unknown（相手の計算に頼って条件の抜けを通さない）: ${JSON.stringify(a)}`);
  //   別の JavaScript の列の編集不可が、その画面のイベントで動くか（読み込まれる画面だけで任せない）
  const BOTH_EV = ['app.record.edit.show', 'mobile.app.record.edit.show'];
  const mobileOnly = (code) => ({ code, access: 'CONTROL', condition: ST, effects: [{ effect: 'lock', condition: ST, events: ['mobile.app.record.edit.show'] }] });
  const plat = planOf([cust('C1', [{ code: 'ステータス', access: 'READ' }, lockF('item_name')], { platform: ['desktop', 'mobile'], events: BOTH_EV }), cust('C2', [mobileOnly('qty'), mobileOnly('unit_price')], { platform: ['desktop', 'mobile'], events: BOTH_EV })]);
  const b = sum(reqOf(plat, [R('R4', '明細', ['lock'], { planRefs: ['C1', 'C2'] })]));
  assert(JSON.stringify(b.unresolved) === JSON.stringify([MISSING('qty'), MISSING('unit_price')]), `L1-18: 別の JavaScript の列の編集不可がモバイルのイベントだけなら、PC の不足を満たさない: ${JSON.stringify(b)}`);
  //   名前の重なり: テーブルと同じ名前の列 → テーブルとして全部の編集できる列を要る（厳しい側）／計画に無い別のフィールドが同じ名前 → 特定できない
  const same = sum(reqOf(planOf([cust('C1', [{ code: 'ステータス', access: 'READ' }, lockF('amount'), lockF('item_name')])]), REQS, { labels: { ...LABELS, item_name: '明細' } }));
  assert(JSON.stringify(same.unresolved) === JSON.stringify([MISSING('qty'), MISSING('unit_price')]), `L1-19: テーブルと同じ名前の列だけを編集不可にした計画でも、テーブルの要件は数量・単価の不足を残す: ${JSON.stringify(same)}`);
  const clash = sum(reqOf(planOf([cust('C1', clone(CX1_C1_FIELDS))]), REQS, { labels: { ...LABELS, memo: '明細' } }));
  assert(clash.unresolved.includes('|lock|target-unresolved|R4') && !clash.effects.some(k => /R4/.test(k)), `L1-20: 計画に無い別のフィールド（備考）がテーブルと同じ名前なら、推測でテーブルにしない（特定できない）: ${JSON.stringify(clash)}`);
});

// =========================================================
console.log('\n--- §L2. 会話: 仮案の要件（金額・明細に「編集できない」）→ 採用 → 計画 → 生成 ---');
const U = '承認済みでは金額と明細を変更できなくして';
const tableScript = ({ utterance }) => (utterance === U ? { reply: '承認済みでは金額と明細を編集不可にします。', intent: 'propose',
  proposal: { behaviors: [B('「承認済み」では金額と明細を変更できなくする', 'user')], assumptions: [], decisions: [], approach: { standard: [], js: ['承認済みの金額と明細の編集不可（PC）'] }, cannot: ['明細の行の追加・削除ボタン自体は止められません'] },
  turn: { ops: [], answers: [], requirementOps: [
    req('add', { target: '金額', condition: '承認済み', behavior: '金額を編集不可にする', sourceQuotes: ['承認済みでは金額と明細を変更できなくして'], planRefs: ['B1'], effects: ['lock'] }),
    req('add', { target: '明細', condition: '承認済み', behavior: '明細を編集不可にする', sourceQuotes: ['承認済みでは金額と明細を変更できなくして'], planRefs: ['B1'], effects: ['lock'] }),
  ] } } : null);
const custOf = (id, fields) => cust(id, fields, { requirement: '承認済みでは金額と明細（品名・数量・単価）を PC で編集不可にする', whyStandardInsufficient: 'ステータスで切り替えるアクセス権は無い', implementation: 'JAVASCRIPT', apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [] });
/** 計画の偽物: custs = この計画の customization。要件はどれも planRefs を refsOf(要件) にする（無ければ全部の customization） */
const tablePlanOf = (custsOf, refsOf = null) => (args) => {
  const custs = custsOf(args);
  const ids = custs.map(c => c.customizationId);
  const ops = (args.requirements || []).map(r => ({ op: 'update', id: r.id, target: r.target, condition: r.condition, behavior: r.behavior, exceptions: r.exceptions || [], decision: r.decision, disposition: 'adopted', sourceQuotes: [], planRefs: refsOf ? refsOf(r, args) : ids, effects: Array.isArray(r.effects) && r.effects.length ? r.effects : ['lock'], note: '' }));
  const plan = { goal: args.goal, assessment: { summary: '承認済みでは金額と明細を編集不可にします。' }, steps: custs.map(c => ({ id: c.customizationId, actionType: 'CUSTOMIZATION_REQUIRED', targetKind: 'JS', targetRef: null, title: 'JavaScript', spec: { customizationId: c.customizationId }, dependsOn: [] })), customizations: clone(custs), provisionals: [], questions: [], unknowns: [], impact: [], solution: 'CUSTOMIZATION' };
  return { plan, ctx: null, gatewayPlan: clone(plan), turn: { reply: '承認済みでは金額と明細のセルを編集不可にします。', requirementOps: ops, utteranceCoverage: [] },
    review: { base: { baseVersion: '1', env: 'preview', ok: true, fingerprint: 'fp-1', revision: { preview: '10' } }, steps: custs.map(c => ({ stepId: c.customizationId, status: 'VALID', safety: 'PLAN_ONLY', customization: clone(c), codeGeneration: { supported: true, strategy: 'NEW_JS_FILE', reason: null }, issues: [] })), warnings: [] } };
};
/** 生成工程の偽物: 計画の C の fields の「編集できない」を、その C の列ごとに処理する候補（実 AI の CX-1 の C1 の処理と同じ書き方）。渡された必須の効果を記録する */
const tableGenerate = () => {
  const seen = [];
  const impl = async (args) => {
    seen.push({ cid: args.customizationId, version: args.version.version, requiredEffects: clone(args.requiredEffects || []) });
    const c = (args.version.plan.customizations || []).find(x => x.customizationId === args.customizationId);
    const effNames = (f) => (f.effects || []).map(x => (x && typeof x === 'object' ? x.effect : x));
    const locked = (c.fields || []).filter(f => effNames(f).includes('lock')).map(f => f.code);
    const warned = (c.fields || []).filter(f => effNames(f).includes('warn')).map(f => f.code);
    const cols = locked.filter(f => COLUMNS[f]), top = locked.filter(f => !COLUMNS[f]), warnCols = warned.filter(f => COLUMNS[f]);
    const warnPart = warnCols.length ? `\n    record['items'].value.forEach(function (row) {\n${warnCols.map(f => `      if (row.value['${f}'].value === '0') row.value['${f}'].error = '0 です';`).join('\n')}\n    });` : '';
    const code = `(function () {\n  'use strict';\n  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n${top.map(f => `      record['${f}'].disabled = true;`).join('\n')}${cols.length ? `\n      record['items'].value.forEach(function (row) {\n${cols.map(f => `        row.value['${f}'].disabled = true;`).join('\n')}\n      });` : ''}\n    }${warnPart}\n    return event;\n  });\n})();`;
    const generated = { strategy: 'NEW_JS_FILE', targetFile: `approvedLock-${c.customizationId}.js`, summary: '承認済みでは編集不可にします。', code, patch: null, events: c.events, fields: [{ code: 'ステータス', access: 'READ' }, ...(cols.length || warnCols.length ? [{ code: 'items', access: 'READ' }] : []), ...[...new Set([...locked, ...warned])].map(f => ({ code: f, access: 'CONTROL' }))], apis: [], assumptions: [], warnings: [], coverage: [{ requirementId: c.customizationId, status: 'MET', note: '', text: c.requirement }] };
    const review = KTCodeReview.review({ generated, customization: c, plan: args.version.plan, data: clone(K.DATA_C), scan: null, existingSource: null });
    const candidateHash = gwCandidateHash({ strategy: generated.strategy, targetFile: generated.targetFile, code: generated.code, patch: null, customizationId: c.customizationId });
    const cand = { code, has: Object.fromEntries([...new Set([...locked, ...warned])].map(f => [f, [...(locked.includes(f) ? ['lock'] : []), ...(warned.includes(f) ? ['warn'] : [])]])) };
    return { ok: true, generated, review, ctx: { size: { approxTokens: 1000 } }, existingSource: null, inputHash: `h-${c.customizationId}`, verification: K.fakeVerification(cand, args.requiredEffects, { candidateHash }), candidateHash, requirementIds: [{ id: c.customizationId, kind: 'customization', text: c.requirement }] };
  };
  return { impl, seen, calls: seen };
};
const convOf = (planImpl, scriptFn = tableScript) => {
  const gen = tableGenerate();
  const x = makeConvC({ scriptFn, labels: LABELS, generate: gen, planImpl });
  x.services.tableColumns = () => clone(COLUMNS);
  x.services.readOnlyFields = () => [...RO];
  return { x, gen };
};
const keysOf = (g) => (g ? g.requiredEffects.map(e => `${e.field}|${e.effect}|${[...(e.requirementIds || [e.requirementId])].sort().join('+')}`).sort() : []);
await section(async () => {
  const { x, gen } = convOf(tablePlanOf(() => [custOf('C1', clone(CX1_C1_FIELDS))]));
  await x.c.send(U);
  await x.c.send('採用します');
  const v = x.c.activePlan();
  const ids = Object.fromEntries((x.c.requirements(v.planId) || []).map(r => [r.target, r.id]));
  const keys = keysOf(gen.seen.find(s => s.cid === 'C1'));
  const want = [`amount|lock|C1+${ids['金額']}`, `item_name|lock|C1+${ids['明細']}`, `qty|lock|C1+${ids['明細']}`, `unit_price|lock|C1+${ids['明細']}`].sort();
  assert(JSON.stringify(keys) === JSON.stringify(want), `L2-1: 生成に渡す必須の効果は 4 件（金額は「金額」の要件、品名・数量・単価は「明細」の要件の id つき。小計は根拠で除く）: ${JSON.stringify({ keys, want })}`);
  assert(v.generated.C1 && v.generated.C1.status === 'verified' && v.final && FS.readyOf(v) === true && x.calls.plan.length === 1 && gen.seen.length === 1,
    `L2-2: 準備未完了にならず（計画の差分更新を依頼しない・計画の AI 1 回）、C1 は検証済み・承認できる: ${JSON.stringify({ status: v.generated.C1 && v.generated.C1.status, verdict: v.generated.C1 && v.generated.C1.verdict && v.generated.C1.verdict.reason, approvable: v.final && FS.readyOf(v), plans: x.calls.plan.length, gens: gen.seen.length })}`);
});
await section(async () => {
  //   不足の会話の経路: 計画が品名だけ（自動の見直しでも同じ計画）→ 要件未達を隠した最終案にしない
  const { x, gen } = convOf(tablePlanOf(() => [custOf('C1', [{ code: 'ステータス', access: 'READ' }, lockF('amount'), lockF('item_name')])]));
  await x.c.send(U);
  await x.c.send('採用します');
  const v = x.c.activePlan();
  const e = v.generated.C1;
  const reason = (e && e.verdict && e.verdict.reason) || '';
  const html = K.finalHtml(x);
  const auto = x.calls.plan[1] || {};
  assert(e && e.status === 'not-ready' && e.verdict.kind === 'effects-unknown' && /「明細」の列のうち/.test(reason) && /「数量」/.test(reason) && /「単価」/.test(reason) && !/qty|unit_price|items|no-owner-field/.test(reason),
    `L2-3: 計画が品名だけ → C1 は準備未完了。理由は列の名前で（「明細」の列のうち「数量」・「単価」）、内部のコードを出さない: ${JSON.stringify({ status: e && e.status, reason })}`);
  assert(x.calls.plan.length === 2 && auto.revision && /テーブル自体には effects を置かず/.test(auto.request || '') && /R\d+ \/ table items \/ lock \/ no-owner-field: qty, unit_price/.test(auto.request || '') && v.final && v.final.fix && /テーブル 「明細」/.test(v.final.fix.text || '') && /テーブル自体には effects を置かず/.test(v.final.fix.text || '') && gen.seen.length === 0 && v.final && FS.readyOf(v) === false && !/仮案のとおり、承認できます/.test(html),
    `L2-4: 計画の差分更新を 1 回だけ自動で依頼（テーブルの列の指示と、不足の列を 1 行にまとめたものつき）・［計画を直すよう依頼する］の文にもテーブルと指示・生成 0・最終案は承認できない（要件未達を隠さない）: ${JSON.stringify({ plans: x.calls.plan.length, request: (auto.request || '').slice(0, 200), gens: gen.seen.length, approvable: v.final && FS.readyOf(v) })}`);
});
await section(async () => {
  //   流用で不足を隠さない: 前の版で C1（品名）と C2（数量・単価）が分担して検証済み → 修正で C2 を外し要件の planRefs を C1 だけにした版（C1 は同じ）。
  //   計画の差分更新の自動の依頼は系列ごとに 1 回なので、最初の計画（C1 だけ・列の不足）でその 1 回を使い（自動の依頼で分担の形になる）、
  //   利用者の修正の版では自動の依頼が無いまま流用の判定に進む形にする（流用の判定がそのまま不足を隠すかを確かめる）
  const onlyC1 = () => [custOf('C1', [{ code: 'ステータス', access: 'READ' }, lockF('amount'), lockF('item_name')])];
  const splitCusts = () => [...onlyC1(), custOf('C2', [{ code: 'ステータス', access: 'READ' }, lockF('qty'), lockF('unit_price')])];
  let planN = 0;
  const custsOf = () => { planN += 1; return planN === 2 ? splitCusts() : onlyC1(); };
  //   「金額」の要件は C1 だけ、「明細」の要件はその版の customization 全部（分担の版は C1・C2、ほかは C1 だけ）
  const { x, gen } = convOf(tablePlanOf(custsOf, (r) => (r.target === '金額' ? ['C1'] : (planN === 2 ? ['C1', 'C2'] : ['C1']))));
  await x.c.send(U);
  await x.c.send('採用します');
  const v1 = x.c.activePlan();
  assert(v1.generated.C1 && v1.generated.C1.status === 'verified' && v1.generated.C2 && v1.generated.C2.status === 'verified' && v1.final && FS.readyOf(v1) === true, `L2-5: 前提: 2 つの JavaScript の分担で検証済み・承認できる: ${JSON.stringify({ c1: v1.generated.C1 && [v1.generated.C1.status, v1.generated.C1.verdict && v1.generated.C1.verdict.unresolved], c2: v1.generated.C2 && [v1.generated.C2.status, v1.generated.C2.verdict && v1.generated.C2.verdict.unresolved], plans: x.calls.plan.length, refs: x.c.requirements(v1.planId).map(r => `${r.target}:${(r.planRefs || []).join('+')}`) })}`);
  await x.c.send('明細の編集不可は C1 だけで扱ってください');
  const v2 = x.c.activePlan();
  const e2 = v2.generated.C1;
  assert(v2.version !== v1.version && e2 && !e2.reused && e2.status === 'not-ready' && v2.final && FS.readyOf(v2) === false,
    `L2-6: 片方を外した版では、同じ C1 でも前の検証済みの結果を流用せず、不足（数量・単価）で準備未完了・承認できない: ${JSON.stringify({ v1: v1.version, v2: v2.version, reused: e2 && e2.reused, status: e2 && e2.status, reason: e2 && e2.verdict && e2.verdict.reason, approvable: v2.final && FS.readyOf(v2), gens: gen.seen.map(s => `${s.cid}@${s.version}`) })}`);
});

await section(async () => {
  //   採用範囲（一度だけの反証の確認で見つかった形）: 計画がテーブルを READ で fields に入れ、別の要件（数量の警告）が列を対象にしても、
  //   テーブルの要件（明細を編集不可）の列の編集不可を「依頼に無い」として外さない（必須の効果・計画・通常表示が食い違わない）
  const U3 = '承認済みでは金額と明細を変更できなくして。数量が0なら警告して';
  const script3 = ({ utterance }) => (utterance === U3 ? { reply: '承認済みでは金額と明細を編集不可にし、数量が0なら警告します。', intent: 'propose',
    proposal: { behaviors: [B('「承認済み」では金額と明細を変更できなくする', 'user'), B('数量が0なら警告する', 'user')], assumptions: [], decisions: [], approach: { standard: [], js: ['承認済みの金額と明細の編集不可・数量の警告（PC）'] }, cannot: [] },
    turn: { ops: [], answers: [], requirementOps: [
      req('add', { target: '金額', condition: '承認済み', behavior: '金額を編集不可にする', sourceQuotes: ['承認済みでは金額と明細を変更できなくして'], planRefs: ['B1'], effects: ['lock'] }),
      req('add', { target: '明細', condition: '承認済み', behavior: '明細を編集不可にする', sourceQuotes: ['承認済みでは金額と明細を変更できなくして'], planRefs: ['B1'], effects: ['lock'] }),
      req('add', { target: '数量', condition: '数量が0', behavior: '警告する', sourceQuotes: ['数量が0なら警告して'], planRefs: ['B2'], effects: ['warn'] }),
    ] } } : null);
  const fields3 = [{ code: 'ステータス', access: 'READ' }, { code: 'items', access: 'READ' }, lockF('amount'), lockF('item_name'),
    { code: 'qty', access: 'CONTROL', condition: '', effects: [{ effect: 'lock', condition: ST }, { effect: 'warn', condition: 'qty = 0' }] }, lockF('unit_price')];
  const { x, gen } = convOf(tablePlanOf(() => [custOf('C1', clone(fields3))]), script3);
  await x.c.send(U3);
  await x.c.send('採用します');
  const v = x.c.activePlan();
  const ids = Object.fromEntries((x.c.requirements(v.planId) || []).map(r => [r.target, r.id]));
  const qtyEff = ((v.plan.customizations[0].fields || []).find(f => f.code === 'qty') || {}).effects || [];
  const keys = keysOf(gen.seen.find(s => s.cid === 'C1'));
  assert(!(v.scopeStripped || []).some(s => s.field === 'qty' && s.effect === 'lock') && qtyEff.some(e => (e && e.effect) === 'lock') && keys.includes(`qty|lock|C1+${ids['明細']}`) && keys.includes(`qty|warn|C1+${ids['数量']}`)
    && x.calls.plan.length === 1 && v.generated.C1 && v.generated.C1.status === 'verified' && v.final && FS.readyOf(v) === true,
    `L2-7: 計画がテーブルを READ で入れ、数量に別の要件（警告）があっても、数量の編集不可は外さない（計画・必須の効果・承認が食い違わない）: ${JSON.stringify({ stripped: v.scopeStripped, qtyEff, keys, plans: x.calls.plan.length, status: v.generated.C1 && v.generated.C1.status, approvable: v.final && FS.readyOf(v) })}`);
});

console.log(`\n${state.passed} passed, ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})();
