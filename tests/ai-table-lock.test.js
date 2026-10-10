// 対象がテーブル（明細）の「編集できない」要件と、計画が列に置いた「編集できない」の結び付き（2026-10-10・C1 の検証素材の整理で判明。有料の AI は使わない）
//
// 経緯: 受信の切り分け（2026-10-10）で、手で作った模擬の計画（C1 の fields に明細の列が無く、テーブル items に「編集できない」）で本物の生成を 1 回通したところ、
//   生成工程の AI は計画に無い列を使わず（生成の指示: 計画の fields の範囲だけを使う）、金額だけを編集不可にして「明細: 編集できない」が要件未達になった。
//   素材を実 AI の CX-1 の計画の形（AI版 sandbox/test/fixtures/scenarios/cx1.js の C1: 金額と品名・数量・単価に「編集できない」・テーブルは fields に無い）に直すと、
//   利用者の要件「明細を編集不可」（target 明細・effects lock）の対象を計画のフィールドから特定できず（target-unresolved。テーブルを READ で入れると no-owner-field）、
//   生成の前に準備未完了になった。kintone の disabled はセル（列）に効き、テーブル自体には効かないので、テーブルを対象にした「編集できない」は、同じ customization が
//   そのテーブルの列に置いた「編集できない」で満たす（列の組に要件の id を足す）。
//
// 検証内容:
//   §L1 requiredEffectsOf（KTAiConversation）: CX-1 の C1 の形（テーブルは fields に無い）・テーブルを READ で入れた形 → 金額（R3）と品名・数量・単価（R4）・未解決 0。
//        今までどおりの形: テーブルに「編集できない」を置いた計画（列なし）はテーブルのまま／要件に条件があり列に条件が無い → condition-unknown／
//        表示の切り替えは結び付けない／「金額と明細」のような複数の対象は特定できないまま／列の構造（tableColumns）が無ければ今までどおり／別の customization の列には結び付けない
//   §L2 会話: 仮案の要件（金額・明細に「編集できない」）→ 採用 → 計画（CX-1 の C1 の形・列だけ）→ 生成に渡す必須の効果は 4 件（金額は R1、列は R2 の id つき）・
//        準備未完了にならず計画の差分更新を依頼しない・C1 は検証済み・承認できる
//
// 実行方法: node tests/ai-table-lock.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const T = loadToolkit();
const { KTAiConversation, KTCodeReview, KTScan } = T;
const { assert, state } = makeAssert();
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const { clone, B, req, makeConvC } = K;
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }

const ST = 'ステータス in ("承認済み")';
const LABELS = { amount: '金額', items: '明細', item_name: '品名', qty: '数量', unit_price: '単価', subtotal: '小計', 'ステータス': 'ステータス' };
const COLUMNS = { item_name: 'items', qty: 'items', unit_price: 'items', subtotal: 'items' };
const lockF = (code, condition = ST) => ({ code, access: 'CONTROL', condition, effects: ['lock'] });
/** 実 AI の CX-1 の計画の C1 の fields（cx1.js。効果は今の契約の形で補ったもの）。テーブル items は fields に無い */
const CX1_C1_FIELDS = [{ code: 'ステータス', access: 'READ' }, lockF('amount'), lockF('item_name'), lockF('qty'), lockF('unit_price')];
const planOf = (custs) => ({ customizations: custs, proposedFields: [] });
const cust = (id, fields, o = {}) => ({ customizationId: id, strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.create.show', 'app.record.edit.show'], fields, ...o });
const R = (id, target, effects, o = {}) => ({ id, target, condition: '承認済み', behavior: '編集不可にする', decision: 'decided', disposition: 'adopted', planRefs: ['C1'], effects, ...o });
const REQS = [R('R3', '金額', ['lock']), R('R4', '明細', ['lock'])];
const sum = (r) => ({ effects: r.effects.map(e => `${e.field}|${e.effect}|${[...e.requirementIds].sort().join('+')}`).sort(), unresolved: r.unresolved.map(u => `${u.field}|${u.effect || ''}|${u.reason}|${u.requirementId || ''}`) });
const reqOf = (plan, reqs, o = {}) => KTAiConversation.requiredEffectsOf(plan, 'C1', reqs, { labels: LABELS, columns: COLUMNS, ...o });

(async () => {
// =========================================================
console.log('\n--- §L1. requiredEffectsOf: テーブルを対象にした「編集できない」を列で満たす ---');
await section(async () => {
  const s = sum(reqOf(planOf([cust('C1', clone(CX1_C1_FIELDS))]), REQS));
  assert(JSON.stringify(s.effects) === JSON.stringify(['amount|lock|C1+R3', 'item_name|lock|C1+R4', 'qty|lock|C1+R4', 'unit_price|lock|C1+R4']) && s.unresolved.length === 0,
    `L1-1: CX-1 の C1 の形（テーブルは fields に無い）: 金額は R3、品名・数量・単価は R4 で満たす・未解決 0: ${JSON.stringify(s)}`);
  const s2 = sum(reqOf(planOf([cust('C1', [...clone(CX1_C1_FIELDS), { code: 'items', access: 'READ' }])]), REQS));
  assert(JSON.stringify(s2.effects) === JSON.stringify(s.effects) && s2.unresolved.length === 0, `L1-2: テーブルを READ で入れた形でも同じ（テーブルに担当が無い no-owner-field にしない）: ${JSON.stringify(s2)}`);
});
await section(async () => {
  //   今までどおりの形
  const s = sum(reqOf(planOf([cust('C1', [{ code: 'ステータス', access: 'READ' }, lockF('amount'), lockF('items')])]), REQS));
  assert(s.effects.includes('items|lock|C1+R4') && s.effects.includes('amount|lock|C1+R3') && s.unresolved.length === 0, `L1-3: テーブルに「編集できない」を置いた計画（列なし）はテーブルのまま: ${JSON.stringify(s)}`);
  const noCond = [{ code: 'ステータス', access: 'READ' }, lockF('amount'), lockF('item_name', ''), lockF('qty', '')];
  const s4 = sum(reqOf(planOf([cust('C1', noCond)]), REQS));
  assert(s4.unresolved.includes('items|lock|condition-unknown|R4') && !s4.effects.some(k => /R4/.test(k)), `L1-4: 要件に条件があり列の効果に条件が無い → condition-unknown（「いつでも」にしない）: ${JSON.stringify(s4)}`);
  const sh = [{ code: 'ステータス', access: 'READ' }, { code: 'item_name', access: 'CONTROL', condition: ST, effects: ['show-hide'] }];
  const r5 = reqOf(planOf([cust('C1', sh)]), [R('R5', '明細', ['show-hide'])]);
  assert(!r5.effects.some(e => e.requirementIds.includes('R5')) && r5.unresolved.some(u => u.requirementId === 'R5' && u.reason === 'target-unresolved'), `L1-5: 表示の切り替えはテーブルの列に結び付けない（今までどおり）: ${JSON.stringify(sum(r5))}`);
  const s6 = sum(reqOf(planOf([cust('C1', clone(CX1_C1_FIELDS))]), [R('R3', '金額と明細', ['lock'])]));
  assert(s6.unresolved.includes('|lock|target-unresolved|R3'), `L1-6: 「金額と明細」のような複数の対象は特定できないまま（計画の AI が対象をフィールドに付け替える）: ${JSON.stringify(s6)}`);
  const s7 = sum(reqOf(planOf([cust('C1', clone(CX1_C1_FIELDS))]), REQS, { columns: {} }));
  assert(s7.unresolved.includes('|lock|target-unresolved|R4'), `L1-7: 列の構造（tableColumns）が無ければ今までどおり（特定できない）: ${JSON.stringify(s7)}`);
  const other = planOf([cust('C1', [{ code: 'ステータス', access: 'READ' }, lockF('amount')]), cust('C2', [lockF('item_name')], { platform: ['mobile'], events: ['mobile.app.record.edit.show'] })]);
  const s8 = sum(reqOf(other, REQS));
  assert(!s8.effects.some(k => /item_name/.test(k)) && s8.unresolved.includes('|lock|target-unresolved|R4'), `L1-8: 別の customization の列には結び付けない: ${JSON.stringify(s8)}`);
});

// =========================================================
console.log('\n--- §L2. 会話: 仮案の要件（金額・明細に「編集できない」）→ 採用 → CX-1 の C1 の形の計画 → 生成 ---');
const U = '承認済みでは金額と明細を変更できなくして';
const tableScript = ({ utterance }) => (utterance === U ? { reply: '承認済みでは金額と明細を編集不可にします。', intent: 'propose',
  proposal: { behaviors: [B('「承認済み」では金額と明細を変更できなくする', 'user')], assumptions: [], decisions: [], approach: { standard: [], js: ['承認済みの金額と明細の編集不可（PC）'] }, cannot: ['明細の行の追加・削除ボタン自体は止められません'] },
  turn: { ops: [], answers: [], requirementOps: [
    req('add', { target: '金額', condition: '承認済み', behavior: '金額を編集不可にする', sourceQuotes: ['承認済みでは金額と明細を変更できなくして'], planRefs: ['B1'], effects: ['lock'] }),
    req('add', { target: '明細', condition: '承認済み', behavior: '明細を編集不可にする', sourceQuotes: ['承認済みでは金額と明細を変更できなくして'], planRefs: ['B1'], effects: ['lock'] }),
  ] } } : null);
const C1 = cust('C1', clone(CX1_C1_FIELDS), { requirement: '承認済みでは金額と明細（品名・数量・単価）を PC で編集不可にする', whyStandardInsufficient: 'ステータスで切り替えるアクセス権は無い', implementation: 'JAVASCRIPT', apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [] });
const tablePlan = (args) => {
  const ops = (args.requirements || []).map(r => ({ op: 'update', id: r.id, target: r.target, condition: r.condition, behavior: r.behavior, exceptions: r.exceptions || [], decision: r.decision, disposition: 'adopted', sourceQuotes: [], planRefs: ['C1'], effects: ['lock'], note: '' }));
  const plan = { goal: args.goal, assessment: { summary: '承認済みでは金額と明細を編集不可にします。' }, steps: [{ id: 'C1', actionType: 'CUSTOMIZATION_REQUIRED', targetKind: 'JS', targetRef: null, title: 'JavaScript', spec: { customizationId: 'C1' }, dependsOn: [] }], customizations: [clone(C1)], provisionals: [], questions: [], unknowns: [], impact: [], solution: 'CUSTOMIZATION' };
  return { plan, ctx: null, gatewayPlan: clone(plan), turn: { reply: '承認済みでは金額と明細のセルを編集不可にします。', requirementOps: ops, utteranceCoverage: [] },
    review: { base: { baseVersion: '1', env: 'preview', ok: true, fingerprint: 'fp-1', revision: { preview: '10' } }, steps: [{ stepId: 'C1', status: 'VALID', safety: 'PLAN_ONLY', customization: clone(C1), codeGeneration: { supported: true, strategy: 'NEW_JS_FILE', reason: null }, issues: [] }], executionReadiness: { safeSteps: [], reviewSteps: [], blockedSteps: [], planOnlySteps: ['C1'] }, warnings: [] } };
};
/** 生成工程の偽物: 金額と品名・数量・単価を編集不可にする候補（実 AI の CX-1 の C1 の処理と同じ書き方）。渡された必須の効果を記録する */
const LOCK_CODE = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n      record['items'].value.forEach(function (row) {\n        row.value['item_name'].disabled = true;\n        row.value['qty'].disabled = true;\n        row.value['unit_price'].disabled = true;\n      });\n    }\n    return event;\n  });\n})();";
const tableGenerate = () => {
  const seen = [];
  const impl = async (args) => {
    seen.push({ cid: args.customizationId, requiredEffects: clone(args.requiredEffects || []) });
    const c = (args.version.plan.customizations || []).find(x => x.customizationId === args.customizationId);
    const generated = { strategy: 'NEW_JS_FILE', targetFile: 'approvedLock.js', summary: '承認済みでは金額と明細を編集不可にします。', code: LOCK_CODE, patch: null, events: c.events, fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL' }, { code: 'items', access: 'READ' }, { code: 'item_name', access: 'CONTROL' }, { code: 'qty', access: 'CONTROL' }, { code: 'unit_price', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], coverage: [{ requirementId: 'C1', status: 'MET', note: '', text: c.requirement }] };
    const review = KTCodeReview.review({ generated, customization: c, plan: args.version.plan, data: clone(K.DATA_C), scan: null, existingSource: null });
    const candidateHash = KTScan.candidateHashOf({ strategy: generated.strategy, targetFile: generated.targetFile, code: generated.code, patch: null, customizationId: 'C1' });
    const cand = { code: LOCK_CODE, has: { amount: ['lock'], item_name: ['lock'], qty: ['lock'], unit_price: ['lock'] } };
    return { ok: true, generated, review, ctx: { size: { approxTokens: 1000 } }, existingSource: null, inputHash: 'h-table', verification: K.fakeVerification(cand, args.requiredEffects, { candidateHash }), candidateHash, requirementIds: [{ id: 'C1', kind: 'customization', text: c.requirement }] };
  };
  return { impl, seen, calls: seen };
};
await section(async () => {
  const gen = tableGenerate();
  const x = makeConvC({ scriptFn: tableScript, labels: LABELS, generate: gen, planImpl: tablePlan });
  x.services.tableColumns = () => clone(COLUMNS);
  await x.c.send(U);
  await x.c.send('採用します');
  const v = x.c.activePlan();
  const ids = Object.fromEntries((x.c.requirements(v.planId) || []).map(r => [r.target, r.id]));
  const g = gen.seen.find(s => s.cid === 'C1');
  const keys = g ? g.requiredEffects.map(e => `${e.field}|${e.effect}|${[...(e.requirementIds || [e.requirementId])].sort().join('+')}`).sort() : [];
  const want = [`amount|lock|C1+${ids['金額']}`, `item_name|lock|C1+${ids['明細']}`, `qty|lock|C1+${ids['明細']}`, `unit_price|lock|C1+${ids['明細']}`].sort();
  assert(g && JSON.stringify(keys) === JSON.stringify(want), `L2-1: 生成に渡す必須の効果は 4 件（金額は「金額」の要件、品名・数量・単価は「明細」の要件の id つき）: ${JSON.stringify({ keys, want })}`);
  assert(v.generated.C1 && v.generated.C1.status === 'verified' && v.final && v.final.approvable === true && x.calls.plan.length === 1 && gen.seen.length === 1,
    `L2-2: 準備未完了にならず（計画の差分更新を依頼しない・計画の AI 1 回）、C1 は検証済み・承認できる: ${JSON.stringify({ status: v.generated.C1 && v.generated.C1.status, verdict: v.generated.C1 && v.generated.C1.verdict && v.generated.C1.verdict.reason, approvable: v.final && v.final.approvable, plans: x.calls.plan.length, gens: gen.seen.length })}`);
});

console.log(`\n${state.passed} passed, ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})();
