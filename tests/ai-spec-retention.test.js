// 有料確認（2026-10-07）の回帰: 計画の AI が承認者・通知先が未確定のとき、確定している金額条件・日数・遷移まで REQUIRE_CONFIRMATION の details の文章に畳み
//   spec を {} にした。利用者の指示: 確認待ちでも決まっている条件は spec に残す。未確定の承認者だけ保留。実行に必要な情報が揃うまでは反映を許可しない。
//   要件が文章に登場するだけでなく、対応する手順・spec・JS 仕様・未解決事項のどこに保持されているかを確認する。C1 の対象外の要件は「この JS の担当範囲外」。
//   再利用フィールドの警告は、読むだけと、値の書き込み・制御変更を分ける
//
// 検証内容（2026-10-07 独立レビューの指摘 1〜5 の修正を含む）:
//   §1 要件の値の取り出し（KTPlanReview.traceRequirements。2026-10-17 に要件の保持の状態と警告を削除し、説明済みの判定・必須の効果の対象が使う値だけにした）:
//      新ケース 1（3 日は spec・100 万円は spec にも JS にも無い）/ 旧 §10（100 万円が spec:P2.filterCond）。
//      数の anchor は単位付きだけ（「1回目」「2件以上」は値にしない）・比較語の境界の同値（100万円未満 ↔ amount <= "999999"）・午前 9 時 ↔ "09:00"
//   §2 要件の値の取り出し: 新ケース 2（100 万円が spec に無い）/ 旧 CX-1 初版（1000000 が spec:P5.filterCond）
//   §3 反映の制限（T1）: ADD_PROCESS_STATUS の assignees [] ＋ 確認待ち（validation.pending ACTOR、または NEEDS_CONFIRMATION ＋ 承認者 / 作業者の blocking 質問 ＋ 中間ステータス）
//      → Review に ASSIGNEES_PENDING・Executor は Review の issue だけを見て UNSUPPORTED。終端ステータス・質問なし・回答後（assignees あり）は止めない。
//      ADD_REMINDER / ADD_NOTIFICATION の targets [] は TARGETS_MISSING
//   §4 確認待ちの spec を見せる（T2）: REQUIRE_CONFIRMATION に spec があれば r.spec。「確認してから決める：…」は proposal.summary があるときだけ。右の要約は normalizeSpec を通す
//   §5 再利用の読み書き（T3）: READ と確定したときだけ PLANNER_IMPACT_MISSING を出さない。customizations が空は従来どおり警告・ADD_PROCESS_STATUS がある ステータス REUSE は警告・
//      標準手順の spec が書き込む（アプリアクションの転記先・ルックアップの取得項目）は WRITE
//   §6 担当範囲（T4）: coverage の OUT_OF_SCOPE は outOfScope・他の customization の担当は「正規化後に同一」か「2-gram の Dice 係数 0.6 以上かつ自分より 0.2 以上高い」ときだけ・
//      担当の無い OUT_OF_SCOPE は unowned（check coverage-owner）・code-intro / コードカードで別に出す・buildGenerator の otherCustomizations
//   （§7 の会話の要件の保持の警告は、2026-10-17 に警告と一緒に削除した）
//
// 実行方法: node tests/ai-spec-retention.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const T = loadToolkit();
const { KTPlanReview, KTPlanExecutor, KTPlanText, KTCodeReview, KTContext, KTContextUi, KTAiClient, KTAiConversation, KTAiChatUi, KTAiWorkspaceViewModel: VM } = T;
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const SR = require('./fixtures/spec-retention-cases.js');
const R = KTPlanReview, E = KTPlanExecutor;

const INPUTS = SR.inputs353(T);
const clone = SR.clone;
const review = (p, extra = {}) => R.review({ plan: clone(p), ...INPUTS, ...extra });
const st = (rv, id) => rv.steps.find(s => s.stepId === id);
const codes = (s) => (s?.issues || []).map(i => i.code);
const trOf = (tr, id) => (tr?.requirements || []).find(r => r.id === id) || null;
const anchor = (tr, kind, value) => (tr?.anchors || []).find(a => a.kind === kind && String(a.value) === String(value)) || null;
const held = (a, prefix) => (a?.heldIn || []).filter(h => h.startsWith(prefix));
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], changeKind: null, assigneeType: null, customizationId: null, ...o });
const mkStep = (id, actionType, targetKind, targetRef, sp = {}, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, ...extra });
const mkPlan = (steps, extra = {}) => ({ planVersion: '1', goal: 'g', assessment: { summary: '', usableExistingFields: [], usableExistingSettings: [], missingCapabilities: [], uncertainties: [] }, relevantFields: [], proposedFields: [], steps, alternatives: [], impact: [], questions: [], provisionals: [], unknowns: [], planConfidence: 'INFERRED', solution: 'STANDARD', customizations: [], ...extra });
const classify = (p, rv, extra = {}) => E.classifySteps({ plan: p, review: rv, approvedSteps: p.steps.map(s => s.id), fieldsNow: INPUTS.data.fields, processNow: INPUTS.data.status, ...extra });
const tick = () => new Promise(r => setTimeout(r, 0));
const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };
// C-1 第 3 段（2026-10-08）: 古い確認の流れ（依頼 → すぐ計画 → 仕様の確定 →「コードを作って」→ コードのカード）は削除した。
//   会話の節（§6 の後半・§7）は、共有の部品（tests/helpers/new-flow.js の makeConvC）で新しい流れ（依頼 → 仮案 → 採用 → 最終案）の上で試す
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
/** 仮案の AI の偽物: どの依頼にも同じ仮案（判断・要件の操作なし）を返す（台帳には計画の turn の要件だけが入る） */
const DRAFT_S = { reply: '依頼どおりの案です。', intent: 'propose', proposal: { behaviors: [{ text: '依頼どおりに設定する', origin: 'user' }], assumptions: [], decisions: [], approach: { standard: ['設定'], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [] } };
const makeConvN = ({ planImpl, generate = undefined }) => {
  const x = K.makeConvC({ planImpl, ...(generate ? { generate } : {}) });
  x.services.propose = async () => ({ ok: true, proposal: K.normalized(DRAFT_S), ctx: { facts: [] }, perf: { baseWaitMs: 0, contextMs: 1, requestMs: 1 } });
  return x;
};
/** 依頼 → 仮案 →「この内容で進めて」で採用 → 計画 → 最終案 */
const startN = async (x, goal) => { await x.c.send(goal); await x.c.send('この内容で進めて'); await ticks(); };

(async () => {
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e}`); } }

// =========================================================
console.log('\n--- §0. 前提: App 353 の設定と計画の fixture ---');
await section(async () => {
  assert(Object.keys(INPUTS.data.fields).length === 18 && INPUTS.data.status.enable === true && Object.keys(INPUTS.data.status.states).length === 3 && INPUTS.scan && INPUTS.deps.edges.length > 0, 'App 353: フィールド 18・プロセス 3 ステータス・JS 2 本の解析（依存関係あり）');
  assert(!/@|https?:\/\/|cybozu/.test(JSON.stringify(SR)), 'fixture にメールアドレス・URL・ドメインを含まない');
  assert(SR.CASE1_PLAN.steps[1].actionType === 'REQUIRE_CONFIRMATION' && Object.keys(SR.CASE1_PLAN.steps[1].spec).length === 0 && SR.CASE2_PLAN.steps[0].actionType === 'REQUIRE_CONFIRMATION' && Object.keys(SR.CASE2_PLAN.steps[0].spec).length === 0, '新ケース 1・2: 確認待ちの手順の spec が {}（有料確認で観測した形）');
  assert(SR.OLD_S10_PLAN.steps[1].spec.filterCond === 'ステータス in ("承認待ち") and amount >= "1000000"' && SR.OLD_CX1_PLAN.steps.length === 11 && SR.OLD_CX1_PLAN.steps[4].spec.filterCond === 'amount >= "1000000"', '旧 §10・旧 CX-1 初版: 確認待ちでも spec に条件がある');
});

// =========================================================
console.log('\n--- §1. 要件の値の取り出し: 新ケース 1 と旧 §10（3 日・100 万円・金額 がどの置き場所にあるか）---');
await section(async () => {
  //   簡素化（2026-10-17）: 要件の保持の確認（状態 spec / js / unresolved と REQUIREMENT_CONDITION_NOT_IN_SPEC の警告）は削除した。
  //   残るのは、説明済みの判定と必須の効果の対象のフィールドが使う値（単位つきの数・フィールド）と、計画の構造化した置き場所（spec・JS）だけ
  const tr = R.traceRequirements({ plan: SR.CASE1_PLAN, requirements: SR.REQUIREMENTS.case1, data: INPUTS.data });
  const r1 = trOf(tr, 'R1'), r2 = trOf(tr, 'R2');
  assert(r1 && r2 && JSON.stringify(Object.keys(tr)) === '["requirements"]' && JSON.stringify(Object.keys(r1)) === '["id","anchors"]', `要件ごとに id と値だけを返す（状態・警告は無い）: ${JSON.stringify(Object.keys(r1 || {}))}`);
  const d3 = anchor(r1, 'number', 3), yen = anchor(r1, 'number', 1000000);
  assert(d3 && d3.heldIn.includes('spec:P1.daysLater'), `R1: 3 日は spec:P1.daysLater にある: ${JSON.stringify(d3 && d3.heldIn)}`);
  assert(yen && yen.heldIn.length === 0, `R1: 100 万円は spec にも JS にも無い（確認待ちの手順の説明・質問は置き場所にしない）: ${JSON.stringify(yen && yen.heldIn)}`);
  assert(!r1.anchors.some(a => a.kind === 'name') && !r2.anchors.length, `「」の名前・ステータス名は取り出さない。条件の無い要件（R2）は値なし: ${JSON.stringify(r1.anchors.map(a => [a.kind, a.value]))}`);
  // 独立レビュー 2: 個数・序数（件・回目）と単位の無い裸の数は anchor にしない
  const req = (id, condition, extra = {}) => ({ id, target: '', condition, behavior: 'x', exceptions: [], decision: 'decided', disposition: 'adopted', planRefs: [], ...extra });
  const cnt = R.traceRequirements({ plan: SR.CASE1_PLAN, requirements: [req('R1', '1回目の差戻し'), req('R2', '2件以上'), req('R3', '5を超える'), req('R4', '3人以上・2つ目・10個・4行目')], data: INPUTS.data });
  assert(cnt.requirements.every(r => !r.anchors.some(a => a.kind === 'number')), `「1回目の差戻し」「2件以上」「5を超える」「3人以上…」: 数は anchor にしない: ${JSON.stringify(cnt.requirements.map(r => [r.id, r.anchors.length]))}`);
  // 比較語の境界の同値: 100万円未満 ↔ amount <= "999999"、100万円超 ↔ >= "1000001"、100万円以下 ↔ <= "1000000"
  const bplan = (cond) => mkPlan([mkStep('P1', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '課長へ申請', { name: '課長へ申請', from: '作成中', to: '承認待ち', filterCond: cond }, { confidence: 'CONFIRMED' })]);
  const b1 = R.traceRequirements({ plan: bplan('amount <= "999999"'), requirements: [req('R1', '金額が100万円未満')], data: INPUTS.data });
  const b1a = anchor(b1.requirements[0], 'number', 1000000);
  assert(b1a && JSON.stringify(b1a.values) === '[1000000,999999]' && b1a.heldIn.includes('spec:P1.filterCond'), `「100万円未満」＋ amount <= "999999" → spec にある（values に 999999）: ${JSON.stringify(b1a)}`);
  const b2 = R.traceRequirements({ plan: bplan('amount >= "1000001"'), requirements: [req('R1', '金額が100万円超')], data: INPUTS.data });
  const b3 = R.traceRequirements({ plan: bplan('amount <= "1000000"'), requirements: [req('R1', '金額が100万円以下')], data: INPUTS.data });
  const b4 = R.traceRequirements({ plan: bplan('amount >= "1000001"'), requirements: [req('R1', '金額が100万円以上')], data: INPUTS.data });
  const b4a = anchor(b4.requirements[0], 'number', 1000000);
  assert(anchor(b2.requirements[0], 'number', 1000000).heldIn.includes('spec:P1.filterCond') && anchor(b3.requirements[0], 'number', 1000000).heldIn.includes('spec:P1.filterCond') && b4a && JSON.stringify(b4a.values) === '[1000000,999999]' && b4a.heldIn.length === 0, `「超」は N+1、「以下」は N も一致。「以上」は N+1（1000001）を認めない: ${JSON.stringify([anchor(b2.requirements[0], 'number', 1000000).heldIn, anchor(b3.requirements[0], 'number', 1000000).heldIn, b4a])}`);
  // 時刻: 午前9時 ↔ time "09:00"（CASE1 の P1）、午後3時 ↔ "15:00"
  const t1 = R.traceRequirements({ plan: SR.CASE1_PLAN, requirements: [req('R1', '午前9時')], data: INPUTS.data });
  assert(anchor(t1.requirements[0], 'number', 9).heldIn.includes('spec:P1.time'), `「午前9時」は spec の time "09:00" と一致: ${JSON.stringify(anchor(t1.requirements[0], 'number', 9))}`);
  const pm = clone(SR.CASE1_PLAN); pm.steps[0].spec.time = '15:00';
  const t2 = R.traceRequirements({ plan: pm, requirements: [req('R1', '午後3時')], data: INPUTS.data });
  // 再レビュー 2026-10-07: 「午後 3 時」の値は 15 だけ（素の 3 を残すと daysLater の 3 などと偶然一致する）
  assert(anchor(t2.requirements[0], 'number', 15).heldIn.includes('spec:P1.time') && !anchor(t2.requirements[0], 'number', 3), `「午後3時」は "15:00" と一致し、素の 3 は値にしない: ${JSON.stringify(t2.requirements[0].anchors)}`);
  const pm3 = clone(SR.CASE1_PLAN); pm3.steps[0].spec.time = '09:00';   // daysLater 3 のまま。午後 3 時は 15 なので daysLater の 3 とは一致しない
  const t3 = R.traceRequirements({ plan: pm3, requirements: [req('R1', '午後3時')], data: INPUTS.data });
  assert(!anchor(t3.requirements[0], 'number', 15).heldIn.some(h => h.startsWith('spec:')), `「午後3時」が daysLater の 3 と一致しない: ${JSON.stringify(anchor(t3.requirements[0], 'number', 15))}`);
  // 旧 §10: 同じ依頼で P2 が spec を持っていた → 100 万円（と金額 = amount）は spec:P2.filterCond
  const old = R.traceRequirements({ plan: SR.OLD_S10_PLAN, requirements: SR.REQUIREMENTS.case1, data: INPUTS.data });
  const o1 = trOf(old, 'R1'), oyen = anchor(o1, 'number', 1000000);
  assert(oyen && oyen.heldIn.includes('spec:P2.filterCond') && anchor(o1, 'field', 'amount') && anchor(o1, 'field', 'amount').heldIn.includes('spec:P2.filterCond'), `旧 §10: 100 万円（と金額 = amount）は spec:P2.filterCond にある: ${JSON.stringify(oyen && oyen.heldIn)}`);
  // 台帳が無い・計画の確認は要件の照合の結果を持たない
  assert(JSON.stringify(R.traceRequirements({ plan: SR.CASE1_PLAN, requirements: [], data: INPUTS.data })) === '{"requirements":[]}' && JSON.stringify(R.traceRequirements({ plan: SR.CASE1_PLAN })) === '{"requirements":[]}', '台帳が無ければ空（例外にしない）');
  const rv = review(SR.CASE1_PLAN);
  assert(!('requirementTrace' in rv) && !(rv.warnings || []).some(w => w.code === 'REQUIREMENT_CONDITION_NOT_IN_SPEC'), '計画の確認は要件の保持を照合しない（requirementTrace・REQUIREMENT_CONDITION_NOT_IN_SPEC は無い）');
});

// =========================================================
console.log('\n--- §2. 要件の値の取り出し: 新ケース 2 と旧 CX-1 初版（100 万円の分岐）---');
await section(async () => {
  const tr = R.traceRequirements({ plan: SR.CASE2_PLAN, requirements: SR.REQUIREMENTS.case2, data: INPUTS.data });
  const yen = anchor(trOf(tr, 'R1'), 'number', 1000000);
  assert(yen && !held(yen, 'spec:').length && !held(yen, 'js:').length, `R1: 100 万円は spec にも JS にも無い（P1 は確認待ちで spec が {}）: ${JSON.stringify(yen && yen.heldIn)}`);
  assert(['R3', 'R4', 'R5', 'R6'].every(id => !trOf(tr, id).anchors.length), '数もフィールドも無い要件（承認済み・差戻し後・既存の判定を残す・PC とモバイル）は値なし');
  // 旧 CX-1 初版: 分岐が spec にある
  const old = R.traceRequirements({ plan: SR.OLD_CX1_PLAN, requirements: SR.REQUIREMENTS.case2, data: INPUTS.data });
  const o1 = trOf(old, 'R1'), oyen = anchor(o1, 'number', 1000000);
  assert(oyen && oyen.heldIn.includes('spec:P5.filterCond') && anchor(o1, 'field', 'amount').heldIn.includes('spec:P4.filterCond') && anchor(o1, 'field', 'amount').heldIn.includes('spec:P5.filterCond'), `旧 CX-1: 1000000 が spec:P5.filterCond（金額 = amount は P4 / P5）にある: ${JSON.stringify(oyen && oyen.heldIn)}`);
});

// =========================================================
console.log('\n--- §3. 反映の制限（T1）: 承認者が確認待ちのステータスは反映しない ---');
await section(async () => {
  // 承認者の blocking の質問（確認待ちの条件 (ii) の材料）
  const Q_APPROVER = [{ id: 'Q1', question: '部長承認待ちの承認者（部長）に当たる kintone のユーザーまたはグループを教えてください', reason: '', relatedEvidenceIds: [], priority: 'blocking', topic: 'approver', options: [], recommendation: '' }];
  const branch = (extra, planExtra = { questions: Q_APPROVER }) => mkPlan([
    mkStep('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認待ち', { name: '部長承認待ち', assigneeType: 'ONE' }, extra),
    mkStep('P2', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長へ申請', { name: '部長へ申請', from: '作成中', to: '部長承認待ち', filterCond: 'amount >= "1000000"' }, { dependsOn: ['P1'] }),
    mkStep('P3', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長が承認する', { name: '部長が承認する', from: '部長承認待ち', to: '承認済み' }, { dependsOn: ['P1'] }),
  ], planExtra);
  const pending = branch({ confidence: 'NEEDS_CONFIRMATION', validation: { status: 'needs_confirmation', issues: [] } });
  const rvP = review(pending);
  const p1 = st(rvP, 'P1');
  assert(codes(p1).includes('ASSIGNEES_PENDING') && p1.issues.find(i => i.code === 'ASSIGNEES_PENDING').severity === 'medium' && p1.status === 'NEEDS_CONFIRMATION' && /（作業者 確認待ち）/.test(p1.diff.human[0]) && !/作業者の指定なし/.test(p1.diff.human[0]), `Review: assignees [] ＋ 確認待ち（承認者の blocking 質問・中間ステータス）→ ASSIGNEES_PENDING（medium）・「（作業者 確認待ち）」: ${JSON.stringify({ codes: codes(p1), human: p1.diff.human[0] })}`);
  const clsP = classify(pending, rvP);
  const c1 = clsP.find(x => x.stepId === 'P1');
  assert(c1.status === 'UNSUPPORTED' && c1.reason === 'ASSIGNEES_PENDING' && c1.message === '作業者が決まっていません（確認待ち。回答すると反映できます）' && !c1.prepared, `Executor: classify が UNSUPPORTED ASSIGNEES_PENDING（作業者なしで反映しない）: ${JSON.stringify({ status: c1.status, reason: c1.reason })}`);
  assert(clsP.filter(x => x.stepId !== 'P1').every(x => x.status === 'BLOCKED'), 'P1 に依存する遷移の手順も反映しない（情報が揃うまで止める）');
  const ready = E.applyReadiness(pending, rvP).find(a => a.stepId === 'P1');
  assert(ready && ready.apply !== 'AUTO' && /確認待ち/.test(ready.message || ''), `反映の可否の表示も「自動で反映できる」にならない: ${JSON.stringify(ready)}`);
  // confidence だけ NEEDS_CONFIRMATION（Gateway の validation は ok）でも、承認者の blocking 質問 ＋ 中間ステータスなら同じ
  const rvC = review(branch({ confidence: 'NEEDS_CONFIRMATION' }));
  assert(codes(st(rvC, 'P1')).includes('ASSIGNEES_PENDING') && classify(branch({ confidence: 'NEEDS_CONFIRMATION' }), rvC).find(x => x.stepId === 'P1').reason === 'ASSIGNEES_PENDING', 'confidence NEEDS_CONFIRMATION ＋ 承認者の blocking 質問 ＋ 中間ステータス → 止める');
  // (i) Gateway の validation.pending === 'ACTOR' だけで止まる（質問が無くても。confidence も書き換えられていない）
  const actor = branch({ confidence: 'INFERRED', validation: { status: 'needs_confirmation', pending: 'ACTOR', issues: ['承認者が未確定'] } }, { questions: [] });
  const rvA = review(actor);
  assert(codes(st(rvA, 'P1')).includes('ASSIGNEES_PENDING') && classify(actor, rvA).find(x => x.stepId === 'P1').reason === 'ASSIGNEES_PENDING', `validation.pending = ACTOR だけで止まる: ${JSON.stringify(codes(st(rvA, 'P1')))}`);
  // 再レビュー 2026-10-07（実害 1）: Gateway の応答 → KTAiClient.validatePlan → Review → classify の経路でも印が落ちない
  //   （以前は validatePlan が validation を { status, issues } に作り直していて pending が消え、Gateway の印だけでは止まらなかった）
  const ctxE = KTContext.buildPlan({ goal: 'g', data: INPUTS.data, deps: INPUTS.deps, scan: INPUTS.scan, incoming: null });
  const vE = KTAiClient.validatePlan({ ok: true, contractVersion: '2.1', meta: { requestId: 'r' }, plan: clone(actor) }, ctxE);
  const pE = vE.ok ? vE.normalized.steps.find(s => s.id === 'P1') : null;
  assert(vE.ok && pE && pE.validation.pending === 'ACTOR' && pE.validation.status === 'needs_confirmation' && pE.confidence === 'INFERRED', `validatePlan は validation.pending = 'ACTOR' を運ぶ（confidence は変えない）: ${JSON.stringify(vE.ok ? pE && pE.validation : vE.errors)}`);
  const rvE = vE.ok ? review(vE.normalized) : null, cE = rvE ? classify(vE.normalized, rvE).find(x => x.stepId === 'P1') : null;
  assert(rvE && codes(st(rvE, 'P1')).includes('ASSIGNEES_PENDING') && cE.status === 'UNSUPPORTED' && cE.reason === 'ASSIGNEES_PENDING', `Gateway の印だけの計画が、正規化を通しても Review と Executor で確認待ちになる: ${JSON.stringify(rvE && { codes: codes(st(rvE, 'P1')), status: cE && cE.status })}`);
  const vE2 = KTAiClient.validatePlan({ ok: true, contractVersion: '2.1', meta: { requestId: 'r' }, plan: clone(branch({ confidence: 'INFERRED', validation: { status: 'needs_confirmation', pending: 'OTHER', issues: [] } }, { questions: [] })) }, ctxE);
  assert(vE2.ok && !('pending' in vE2.normalized.steps.find(s => s.id === 'P1').validation), 'validatePlan は pending の値が ACTOR 以外なら運ばない（契約の値だけ受ける）');
  // 独立レビュー 1・4: 承認者 / 作業者の blocking 質問が無ければ、confidence NEEDS_CONFIRMATION でも止めない（別の理由の確認待ちを作業者の確認待ちにしない）
  const noQ = branch({ confidence: 'NEEDS_CONFIRMATION', validation: { status: 'needs_confirmation', issues: [] } }, { questions: [{ ...Q_APPROVER[0], topic: 'threshold', question: '金額の境界は 100 万円ちょうどを含みますか' }] });
  const rvQ = review(noQ);
  assert(!codes(st(rvQ, 'P1')).includes('ASSIGNEES_PENDING') && classify(noQ, rvQ).find(x => x.stepId === 'P1').status === 'PENDING', '承認者 / 作業者以外の質問だけなら止めない（Executor も Review の issue だけを見る）');
  // 独立レビュー 5: 終端のステータス（遷移元になるアクションが無い）は confidence NEEDS_CONFIRMATION でも止めない（作業者なしが正しい）
  const terminal = mkPlan([
    mkStep('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '完了', { name: '完了', assigneeType: 'ONE' }, { confidence: 'NEEDS_CONFIRMATION', validation: { status: 'needs_confirmation', issues: [] } }),
    mkStep('P2', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '完了にする', { name: '完了にする', from: '承認済み', to: '完了' }, { dependsOn: ['P1'] }),
  ], { questions: Q_APPROVER });
  const rvT = review(terminal), cT = classify(terminal, rvT).find(x => x.stepId === 'P1');
  assert(!codes(st(rvT, 'P1')).includes('ASSIGNEES_PENDING') && /（作業者の指定なし）/.test(st(rvT, 'P1').diff.human[0]) && cT.status === 'PENDING' && /（作業者なし）/.test(cT.prepared.summary), `終端ステータスは confidence NEEDS_CONFIRMATION でも止めない: ${JSON.stringify({ codes: codes(st(rvT, 'P1')), status: cT.status })}`);
  // 回答後（assignees が入った版）は止めない
  const answered = branch({ confidence: 'CONFIRMED', validation: { status: 'ok', issues: [] } });
  answered.steps[0].spec.assignees = ['FIELD_ENTITY:owner'];   // owner はユーザー選択フィールド
  const rvAns = review(answered), cAns = classify(answered, rvAns).find(x => x.stepId === 'P1');
  assert(!codes(st(rvAns, 'P1')).includes('ASSIGNEES_PENDING') && /作業者: /.test(st(rvAns, 'P1').diff.human[0]) && cAns.status === 'PENDING' && cAns.prepared.expect.assignees.length === 1, `回答後（assignees が入った版）は止めない: ${JSON.stringify({ codes: codes(st(rvAns, 'P1')), status: cAns.status, reason: cAns.reason })}`);
  // Executor は条件を再計算しない: Review に ASSIGNEES_PENDING があれば、計画の confidence が HIGH でも止まる（理由が混ざらない）
  const cMix = classify(branch({ confidence: 'HIGH' }), rvP).find(x => x.stepId === 'P1');
  assert(cMix.status === 'UNSUPPORTED' && cMix.reason === 'ASSIGNEES_PENDING', 'Executor は Review の issue だけで判定する（自分で再計算しない）');
  // 確認待ちでない空（終端のステータスなど）は従来どおり「作業者なし」で反映できる
  const high = branch({ confidence: 'HIGH' });
  const rvH = review(high);
  const h1 = st(rvH, 'P1');
  assert(!codes(h1).includes('ASSIGNEES_PENDING') && /（作業者の指定なし）/.test(h1.diff.human[0]), `確認待ちでない空: Review は従来どおり「（作業者の指定なし）」: ${JSON.stringify({ codes: codes(h1), human: h1.diff.human[0] })}`);
  const ch1 = classify(high, rvH).find(x => x.stepId === 'P1');
  assert(ch1.status === 'PENDING' && ch1.prepared && /（作業者なし）/.test(ch1.prepared.summary) && ch1.prepared.expect.assignees.length === 0, `確認待ちでない空: Executor は従来どおり「（作業者なし）」で反映できる: ${JSON.stringify({ status: ch1.status, reason: ch1.reason, summary: ch1.prepared && ch1.prepared.summary })}`);
  const closed = classify(branch({ confidence: 'CONFIRMED' }), review(branch({ confidence: 'CONFIRMED' }))).find(x => x.stepId === 'P1');
  assert(closed.status === 'PENDING', 'CONFIRMED の空も反映できる（終端のステータスは作業者なしが正しい）');
  // ADD_REMINDER / ADD_NOTIFICATION の targets 空は TARGETS_MISSING で止まる（既存の動きの固定）
  const rem = mkPlan([mkStep('P1', 'ADD_REMINDER', 'REMINDER', '停滞リマインダー', { name: '停滞リマインダー', filterCond: 'ステータス in ("承認待ち")', timingField: '更新日時', daysLater: '3', time: '09:00' }, { confidence: 'NEEDS_CONFIRMATION' })]);
  const rvR = review(rem), cR = classify(rem, rvR)[0];
  // リマインダーの Review は通知先の空を issue にしない（反映は Executor の prepare が TARGETS_MISSING で止める）
  assert(st(rvR, 'P1').status !== 'INVALID' && cR.status === 'UNSUPPORTED' && cR.reason === 'TARGETS_MISSING' && cR.message === '通知先が決まっていません', `ADD_REMINDER の通知先 [] → Executor が TARGETS_MISSING（反映しない）: ${cR.status}/${cR.reason}`);
  const ntf = mkPlan([mkStep('P1', 'ADD_NOTIFICATION', 'NOTIFICATION', '高額案件の通知', { name: '高額案件の通知', filterCond: 'amount >= "1000000"' }, { confidence: 'NEEDS_CONFIRMATION' })]);
  const rvN = review(ntf), cN = classify(ntf, rvN)[0];
  assert(codes(st(rvN, 'P1')).includes('TARGETS_MISSING') && cN.status === 'UNSUPPORTED' && cN.reason === 'TARGETS_MISSING', `ADD_NOTIFICATION の通知先 [] → TARGETS_MISSING（反映しない）: ${cN.status}/${cN.reason}`);
});

// =========================================================
console.log('\n--- §4. 確認待ちの spec を見せる（T2）---');
await section(async () => {
  const old = review(SR.OLD_S10_PLAN);
  const p2 = st(old, 'P2');
  const line = (p2.diff.human || []).find(l => l.startsWith('確認してから決める：'));
  assert(p2.spec && p2.spec.filterCond === 'ステータス in ("承認待ち") and amount >= "1000000"' && p2.spec.daysLater === '3' && p2.spec.time === '09:00' && p2.spec.timingField === '更新日時', `REQUIRE_CONFIRMATION に spec があれば r.spec に正規化して残す: ${JSON.stringify(p2.spec)}`);
  assert(line && /条件 ステータス in \("承認待ち"\) and amount >= "1000000"/.test(line) && /基準日 更新日時/.test(line) && /3 日後/.test(line) && /09:00/.test(line), `diff.human に「確認してから決める：条件 …・基準日 …・3 日後・09:00」: ${line}`);
  assert(p2.diff.human[0] === '100万円以上の案件の上長宛通知先を確定する（仮適用なし）' && p2.safety === 'PLAN_ONLY' && p2.diff.changeType === 'NO_CHANGE', '定型の行・計画のみ（仮適用しない）は従来どおり');
  const p2new = st(review(SR.CASE1_PLAN), 'P2');
  assert(p2new.spec === null && !(p2new.diff.human || []).some(l => /確認してから決める/.test(l)), 'spec が {} なら従来どおり（spec null・1 行を足さない）');
  // details の文章（未確定事項・確定後の設定）からは spec を作らない（説明文の語を条件にしない）
  const withDetails = clone(SR.CASE2_PLAN);
  const p1 = st(review(withDetails), 'P1');
  assert(p1.spec === null, '確認待ちの手順の details（承認者・経路の方針…）は spec にしない');
  // 右の要約（変更内容）の「反映の前に確かめること」: title に加えて spec の条件を添える
  const vOld = { planId: 'p', version: 1, goal: SR.OLD_S10_PLAN.goal, plan: SR.OLD_S10_PLAN, review: old, ctx: null };
  const sumOld = KTAiChatUi.changeSummaryHtml(vOld, { open: [] });
  const mOld = /反映の前に確かめること<\/div><div class="kt-ai-sum-warn"><ul><li>([^<]*)<\/li>/.exec(sumOld);
  assert(mOld && /^100万円以上の案件の上長宛通知先を確定する（/.test(mOld[1]) && /条件 ステータス in \(&quot;承認待ち&quot;\) and amount &gt;= &quot;1000000&quot;/.test(mOld[1]) && /3 日後/.test(mOld[1]) && /09:00/.test(mOld[1]), `右の要約: 「反映の前に確かめること」に条件・日数・時刻を添える: ${mOld && mOld[1]}`);
  const vNew = { planId: 'p', version: 1, goal: SR.CASE1_PLAN.goal, plan: SR.CASE1_PLAN, review: review(SR.CASE1_PLAN), ctx: null };
  const mNew = /反映の前に確かめること<\/div><div class="kt-ai-sum-warn"><ul><li>([^<]*)<\/li>/.exec(KTAiChatUi.changeSummaryHtml(vNew, { open: [] }));
  assert(mNew && mNew[1] === '高額案件の上長通知先を確定', `spec が {} なら title だけ（従来どおり）: ${mNew && mNew[1]}`);
  const det = KTPlanText.specDetails(SR.OLD_S10_PLAN.steps[1], { data: INPUTS.data });
  assert(det.map(d => d.key).join('・') === '条件・基準日・タイミング・時刻' && det[1].value === '更新日時' && det[2].value === '3 日後', `KTPlanText.specDetails は actionType で絞らない（REQUIRE_CONFIRMATION でも作れる）: ${JSON.stringify(det)}`);
  // 独立レビュー 5: proposal.summary が空（手順カードの要約が spec から作られる）なら「確認してから決める：…」の 1 行は足さない（二重になる）。r.spec は残す
  const noSum = clone(SR.OLD_S10_PLAN); noSum.steps[1].proposal.summary = '';
  const p2ns = st(review(noSum), 'P2');
  assert(p2ns.spec && p2ns.spec.daysLater === '3' && !(p2ns.diff.human || []).some(l => /確認してから決める/.test(l)), `summary が空なら 1 行を足さない（spec は残す）: ${JSON.stringify(p2ns.diff.human)}`);
  // 右の要約は normalizeSpec を通す（プレースホルダ「なし」を落とす）: filterCond "なし" は出さず、日数だけ添える
  const ph = clone(SR.OLD_S10_PLAN); ph.steps[1].spec = { filterCond: 'なし', daysLater: '3' }; ph.steps[1].proposal.details = [{ key: '未確定事項', value: '上長の通知先（条件 amount >= "5000000"）' }];
  const mPh = /反映の前に確かめること<\/div><div class="kt-ai-sum-warn"><ul><li>([^<]*)<\/li>/.exec(KTAiChatUi.changeSummaryHtml({ planId: 'p', version: 1, goal: ph.goal, plan: ph, review: null, ctx: null }, { open: [] }));
  assert(mPh && /3 日後/.test(mPh[1]) && !/なし/.test(mPh[1]) && !/5000000/.test(mPh[1]), `右の要約: 「なし」は落とし、details の文からは spec を作らない: ${mPh && mPh[1]}`);
});

// =========================================================
console.log('\n--- §5. 再利用フィールドの警告（T3）: 読むだけと、値の書き込み・制御変更を分ける ---');
await section(async () => {
  const cust = (access) => ({ customizationId: 'C1', requirement: '承認済みでは金額を編集不可にする', whyStandardInsufficient: 'ステータスで切り替えるアクセス権は無い', strategy: 'NEW_JS_FILE', implementation: 'JAVASCRIPT', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'ステータス', access }, { code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済み")' }], apis: ['kintone.events.on'], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [] });
  const planOf = (access) => mkPlan([
    mkStep('P1', 'REUSE_FIELD', 'FIELD', 'ステータス', { fields: ['ステータス'] }, { confidence: 'CONFIRMED' }),
    mkStep('C1', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C1' }, { dependsOn: ['P1'], confidence: 'CONFIRMED' }),
  ], { solution: 'HYBRID', customizations: [cust(access)] });
  const rd = review(planOf('READ'));
  //   2026-10-19: 影響の照合の項目（access・note）は確認の結果に持たない（警告の文に扱いの理由を書く）。前提は依存関係の影響で確かめる
  const impSt = T.KTDeps.impactOf(INPUTS.deps, 'ステータス').direct || [];
  assert(impSt.length > 0 && impSt.some(d => d.sourceType === 'CUSTOMIZE'), `前提: ステータス は既存の設定・JS（dealLock.js）から参照されている: ${impSt.length}`);
  assert(!rd.warnings.some(w => /^PLANNER_IMPACT_(MISSING|MISMATCH)$/.test(w.code) && w.stepIds.includes('P1')) && !codes(st(rd, 'P1')).some(c => /^PLANNER_IMPACT/.test(c)) && st(rd, 'P1').status === 'VALID', `JS が READ するだけ → PLANNER_IMPACT_MISSING を出さない（手順も VALID のまま）: ${JSON.stringify(rd.warnings.map(w => w.code))}`);
  const ct = review(planOf('CONTROL'));
  const w = ct.warnings.find(x => x.code === 'PLANNER_IMPACT_MISSING' && x.stepIds.includes('P1'));
  assert(w && /JavaScript が編集可否を変える/.test(w.message) && codes(st(ct, 'P1')).includes('PLANNER_IMPACT_MISSING') && st(ct, 'P1').status === 'WARNING', `JS が CONTROL する → 従来どおり PLANNER_IMPACT_MISSING（message に「JavaScript が編集可否を変える」）: ${w && w.message}`);
  const wr = review(planOf('WRITE'));
  assert(wr.warnings.some(x => x.code === 'PLANNER_IMPACT_MISSING' && /JavaScript が値を変える/.test(x.message)), 'JS が WRITE する → 警告（message に「JavaScript が値を変える」）');
  // 影響範囲を挙げていれば CONTROL でも MISSING は出ない（従来どおり）。参照の無いフィールドへの影響の主張は OVERSTATED（従来どおり）
  //   簡素化（2026-10-17）: JavaScript の影響を挙げたかは構造（targetKind JS・targetRef = 参照する JavaScript のファイル）で決める（説明文の語では決めない。tests/ai-plan-review.test.js の §8）
  const said = review({ ...planOf('CONTROL'), impact: [{ targetKind: 'FIELD', targetRef: 'ステータス', description: '一覧がステータスを参照', evidenceIds: [], confidence: 'CONFIRMED' }, { targetKind: 'JS', targetRef: 'dealLock.js', description: 'ステータスを参照して編集可否を変える', evidenceIds: [], confidence: 'CONFIRMED' }] });
  assert(!said.warnings.some(x => /^PLANNER_IMPACT_(MISSING|MISMATCH)$/.test(x.code)), 'Planner が JS の影響を JavaScript のファイル（dealLock.js）で挙げていれば CONTROL でも警告なし');
  // 作成日時 は App 353 のどの設定・JS からも参照されていない（memo は一覧が参照している）
  const over = review({ ...mkPlan([mkStep('P1', 'REUSE_FIELD', 'FIELD', '作成日時', { fields: ['作成日時'] }, { confidence: 'CONFIRMED' })]), impact: [{ targetKind: 'FIELD', targetRef: '作成日時', description: '多くの設定が参照', evidenceIds: [], confidence: 'INFERRED' }] });
  assert((T.KTDeps.impactOf(INPUTS.deps, '作成日時').direct || []).length === 0 && over.warnings.some(x => x.code === 'PLANNER_IMPACT_OVERSTATED' && x.stepIds.includes('P1')), `OVERSTATED は従来どおり（参照が無いのに影響を主張）: ${JSON.stringify(over.warnings.map(w => w.code))}`);
  // 独立レビュー 3: READ と確定したときだけ警告を出さない。customizations が空（JS にも標準手順にも出ない）の REUSE_FIELD は判定不能 → 従来どおり警告
  const bare = review(mkPlan([mkStep('P1', 'REUSE_FIELD', 'FIELD', 'ステータス', { fields: ['ステータス'] }, { confidence: 'CONFIRMED' })]));
  const bareW = bare.warnings.find(x => x.code === 'PLANNER_IMPACT_MISSING' && x.stepIds.includes('P1'));
  assert(bareW && !/この計画の/.test(bareW.message), `customizations が空の REUSE_FIELD は従来どおり警告（扱いを判定できないので、扱いの理由の文は付けない）: ${JSON.stringify({ codes: bare.warnings.map(w => w.code), msg: bareW && bareW.message })}`);
  // ステータス型のフィールドで、計画に ADD_PROCESS_STATUS があれば値の集合が変わる → JS が READ だけでも警告（WRITE 扱い）
  const withStatus = planOf('READ');
  withStatus.steps.push(mkStep('P2', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認待ち', { name: '部長承認待ち', assigneeType: 'ONE' }, { confidence: 'CONFIRMED' }));
  const ws = review(withStatus);
  assert(ws.warnings.some(x => x.code === 'PLANNER_IMPACT_MISSING' && x.stepIds.includes('P1') && /ステータスの追加・変更で値の集合が変わる/.test(x.message)), `ADD_PROCESS_STATUS がある計画の ステータス REUSE は警告あり（WRITE 扱い。文に「ステータスの追加・変更で値の集合が変わる」）: ${(ws.warnings.find(x => x.code === 'PLANNER_IMPACT_MISSING') || {}).message}`);
  const withUpd = planOf('READ');
  withUpd.steps.push(mkStep('P2', 'UPDATE_PROCESS', 'PROCESS_STATUS', '承認待ち', { name: '承認待ち', changeKind: 'STATUS', assignees: ['FIELD_ENTITY:作業者'] }, { confidence: 'CONFIRMED' }));
  assert(review(withUpd).warnings.some(x => x.code === 'PLANNER_IMPACT_MISSING' && x.stepIds.includes('P1') && /ステータスの追加・変更で値の集合が変わる/.test(x.message)), 'UPDATE_PROCESS（changeKind STATUS）でも同じ');
  // 標準手順の spec がフィールドに値を書き込む（アプリアクションの転記先・ルックアップの取得項目）→ WRITE 扱い
  const withAct = mkPlan([
    mkStep('P1', 'REUSE_FIELD', 'FIELD', 'amount', { fields: ['amount'] }, { confidence: 'CONFIRMED' }),
    mkStep('P2', 'ADD_APP_ACTION', 'APP_ACTION', '見積を複製', { name: '見積を複製', destApp: '353', actionMappings: [{ srcType: 'FIELD', srcField: 'amount', destField: 'amount' }] }, { confidence: 'CONFIRMED' }),
  ]);
  const wa = review(withAct);
  const SPEC_WRITES = /この計画の手順（ルックアップ \/ アプリアクション \/ フィールドの変更）がこのフィールドに値を書き込む/;
  assert(wa.warnings.some(x => x.code === 'PLANNER_IMPACT_MISSING' && x.stepIds.includes('P1') && SPEC_WRITES.test(x.message)), `アプリアクションの転記先 → WRITE（標準手順が値を書き込む）で警告: ${JSON.stringify(wa.warnings.map(w => w.message))}`);
  const withLk = mkPlan([
    mkStep('P1', 'REUSE_FIELD', 'FIELD', 'amount', { fields: ['amount'] }, { confidence: 'CONFIRMED' }),
    mkStep('P2', 'UPDATE_LOOKUP', 'FIELD', 'customer_code', { addMappings: [{ relatedField: 'price', field: 'amount' }] }, { confidence: 'CONFIRMED' }),
  ]);
  const wl = review(withLk);
  assert(wl.warnings.some(x => x.code === 'PLANNER_IMPACT_MISSING' && x.stepIds.includes('P1') && SPEC_WRITES.test(x.message)), `ルックアップの取得項目（addMappings[].field）→ WRITE（標準手順が値を書き込む）: ${JSON.stringify(wl.warnings.map(w => w.message))}`);
  // 有料確認の新ケース 2 そのもの: P3（REUSE_FIELD ステータス）に PLANNER_IMPACT_MISSING が出ていたが、C1 / C2 は READ なので出ない
  const c2 = review(SR.CASE2_PLAN);
  assert(!c2.warnings.some(x => x.code === 'PLANNER_IMPACT_MISSING' && x.stepIds.includes('P3')) && st(c2, 'P3').status === 'VALID', `新ケース 2 の P3（REUSE_FIELD ステータス・JS は READ）に PLANNER_IMPACT_MISSING を出さない: ${JSON.stringify(c2.warnings.map(w => w.code))}`);
  // 設定を変える手順（UPDATE_FIELD）は従来どおり警告する（ai-plan-review.test.js §8 と同じ）
  const FX310 = (() => { const { KTDeps } = T; const data = FX.makeData(); const deps = KTDeps.buildDependencyData(data, KTDeps.normalizeFields(data.fields)); return { data, deps }; })();
  const upd = R.review({ plan: mkPlan([mkStep('P1', 'UPDATE_FIELD', 'FIELD', 'customer_code', { required: true })]), ...FX310, scan: null, incoming: null });
  assert(upd.warnings.some(x => x.code === 'PLANNER_IMPACT_MISSING' && x.stepIds.includes('P1')), 'UPDATE_FIELD（設定を変える）は従来どおり PLANNER_IMPACT_MISSING');
});

// =========================================================
console.log('\n--- §6. coverage の担当範囲（T4）---');
await section(async () => {
  const C1 = SR.CASE2_PLAN.customizations[0], C2 = SR.CASE2_PLAN.customizations[1];
  const CODE = "(function () {\n  'use strict';\n  kintone.events.on(['mobile.app.record.create.show', 'mobile.app.record.edit.show', 'mobile.app.record.create.change.items', 'mobile.app.record.edit.change.items'], function (event) {\n    var record = event.record;\n    if (record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n      var rows = record['items'].value;\n      for (var i = 0; i < rows.length; i++) {\n        rows[i].value['item_name'].disabled = true;\n        rows[i].value['qty'].disabled = true;\n        rows[i].value['unit_price'].disabled = true;\n      }\n    }\n    return event;\n  });\n})();\n";
  const gen = (coverage) => ({ strategy: 'NEW_JS_FILE', targetFile: 'mobileDealLock.js', summary: 'モバイルで承認済みの金額と明細セルを編集不可にする', code: CODE, patch: null, events: C2.events, fields: C2.fields.map(f => ({ code: f.code, access: f.access })), apis: ['kintone.events.on'], assumptions: [], warnings: [], coverage });
  const rvOf = (coverage, plan = SR.CASE2_PLAN) => KTCodeReview.review({ generated: gen(coverage), customization: C2, plan, data: INPUTS.data, scan: INPUTS.scan, existingSource: null });
  // 段階 C: 担当は requirementId で引く（契約 20 §5）。文の照合（同一文・2-gram の Dice 係数）・note の文言（P1 の名指し・標準設定）からの推定は削除した。
  //   記録した有料確認の応答（旧い形。requirementId 無し）は入口で C2（この JavaScript の id）に変換する（自分の要件の申告として扱う）。
  //   簡素化 B（2026-10-17）: NOT_MET・PARTIAL の確認は生成工程の機械検査の coverage（review）が行う（Toolkit の coverage-unmet は削除した。以前の期待: NOT_MET は登録不可）
  const asIs = rvOf(SR.CASE2_GENERATED_COVERAGE);
  assert(asIs.coverage.declared.every(d => d.requirementId === 'C2') && asIs.coverage.outOfScope.length === 0 && asIs.coverage.notAchieved.some(x => x.code === 'AI_NOT_MET' && /100万円以上は部長承認/.test(x.message) && /手順「/.test(x.message) && !/\bP1\b/.test(x.message)) && asIs.coverage.notAchieved.some(x => x.code === 'AI_PARTIAL' && /PCとモバイルの両方で使う/.test(x.message)) && !(asIs.checks || []).some(x => x.name === 'coverage-unmet'), `旧い形の coverage: すべて自分の id に変換（申告は計画の構造に対応づけるだけ。Toolkit は検査にしない。note の番号は手順の名前に）: ${JSON.stringify({ na: asIs.coverage.notAchieved.map(x => [x.code, x.message]), oos: asIs.coverage.outOfScope })}`);
  // Gateway の新しい形（requirementId つき）: P1（確認待ち）→ unowned、P3（REUSE_FIELD。設定を変える手順）→ 手順の担当、C1 → 別の JavaScript の担当、C2 → 自分
  const cov = [
    { requirementId: 'P1', text: '100万円以上は部長承認', status: 'OUT_OF_SCOPE', note: 'P1 で承認者を確定し、標準のプロセス管理で分岐を設定する' },
    { requirementId: 'C1', text: C1.requirement, status: 'NOT_MET', note: 'PC は対象外' },
    { requirementId: 'C2', text: C2.requirement.replace(/。/g, ''), status: 'PARTIAL', note: '自分の担当（句読点だけ違う）' },
    { requirementId: 'P3', text: '承認待ちの通知', status: 'OUT_OF_SCOPE', note: '標準設定で対応' },
  ];
  const rv = rvOf(cov);
  const oos = rv.coverage.outOfScope, na = rv.coverage.notAchieved;
  const oosP = oos.find(x => x.requirementId === 'P1');
  assert(oosP && oosP.code === 'AI_OUT_OF_SCOPE' && /担当が計画にありません/.test(oosP.message) && !/\bP1\b/.test(oosP.message) && rv.coverage.unowned.some(x => x.requirementId === 'P1') && !na.some(x => /100万円以上は部長承認/.test(x.message)), `P1（確認待ちの手順）の OUT_OF_SCOPE は担当が無い（unowned）。notAchieved には入れない: ${JSON.stringify({ oos: oos.map(x => [x.requirementId, x.code]), un: rv.coverage.unowned.map(x => x.requirementId) })}`);
  const oosC1 = oos.find(x => x.requirementId === 'C1');
  assert(oosC1 && oosC1.code === 'OTHER_OWNER' && oosC1.customizationId === 'C1' && /（別の JavaScript「.+」の担当/.test(oosC1.message) && !/\bC1\b/.test(oosC1.message) && !na.some(x => x.message.startsWith(C1.requirement)), `C1 の id の NOT_MET は別の JavaScript の担当（message は「別の JavaScript「…」の担当」）: ${JSON.stringify(oosC1 && oosC1.message)}`);
  assert(na.some(x => x.code === 'AI_PARTIAL' && x.requirementId === 'C2') && oos.some(x => x.requirementId === 'P3' && x.code === 'OTHER_OWNER' && x.owner === 'step'), '自分（C2）の PARTIAL は notAchieved・設定を変える手順（P3）は手順の担当');
  assert(rvOf(cov, null).coverage.outOfScope.every(x => x.code === 'AI_OUT_OF_SCOPE') && rvOf(cov, null).coverage.unowned.length === 3, 'plan が無ければ P1 / P3 / C1 の担当は引けない（unowned）');
  // 文の類似で付け替えない（段階 C: 文の照合そのものを削除）: 別の JavaScript の要件と同じ文でも、自分の id なら自分の要件
  const revPlan = clone(SR.CASE2_PLAN);
  revPlan.customizations[0].requirement = '承認済みでは金額と明細を編集不可にする';
  revPlan.customizations[1].requirement = 'モバイルでも承認済みの金額を編集不可にする';
  const rvRev = (coverage) => KTCodeReview.review({ generated: gen(coverage), customization: revPlan.customizations[1], plan: revPlan, data: INPUTS.data, scan: INPUTS.scan, existingSource: null });
  const partial = rvRev([{ requirementId: 'C2', text: '金額を編集不可にする', status: 'PARTIAL', note: '一覧のインライン編集では止めない' }]);
  assert(partial.coverage.notAchieved.some(x => x.code === 'AI_PARTIAL' && /^金額を編集不可にする/.test(x.message)) && partial.coverage.outOfScope.length === 0, `自分の id の PARTIAL は notAchieved: ${JSON.stringify({ na: partial.coverage.notAchieved.map(x => x.message), oos: partial.coverage.outOfScope })}`);
  const sameText = rvRev([{ requirementId: 'C2', text: '承認済みでは金額と明細を編集不可にする', status: 'NOT_MET', note: 'PC は対象外' }]);
  assert(sameText.coverage.outOfScope.length === 0 && sameText.coverage.notAchieved.some(x => x.code === 'AI_NOT_MET'), `C1 と同じ文でも自分の id なら自分の要件（文で付け替えない）: ${JSON.stringify(sameText.coverage.notAchieved.map(x => x.code))}`);
  // 担当の無い OUT_OF_SCOPE は unowned ＋ check coverage-owner（review）。設定を変える手順の id なら unowned にしない
  const un = rvRev([{ requirementId: 'R9', text: '承認後に Slack へ知らせる', status: 'OUT_OF_SCOPE', note: '別の仕組みで扱う' }, { requirementId: 'P1', text: '100万円以上は部長承認', status: 'OUT_OF_SCOPE', note: 'P1 で承認者を確定し、標準のプロセス管理で分岐を設定する' }, { requirementId: 'P3', text: '承認待ちの通知', status: 'OUT_OF_SCOPE', note: '標準設定で対応' }, { requirementId: 'C9', text: '帳票の出力', status: 'OUT_OF_SCOPE', note: 'C9 の担当' }]);
  const owner = un.checks.filter(ch => ch.name === 'coverage-owner');
  assert(un.coverage.unowned.map(x => x.requirement).join('|') === '承認後に Slack へ知らせる|100万円以上は部長承認|帳票の出力' && un.coverage.outOfScope.length === 4 && !(un.checks || []).some(ch => ch.name === 'coverage-unmet'), `担当（設定を変える手順）の無い OUT_OF_SCOPE は unowned（R9 は台帳に無い・P1 は確認待ち・C9 は計画に無い）: ${JSON.stringify(un.coverage.unowned)}`);
  assert(owner.length === 3 && owner.every(ch => !ch.ok && ch.severity === 'review') && owner[0].message === '担当範囲外とされた要件「承認後に Slack へ知らせる」の担当が計画に見つかりません。計画全体の確認に残します' && un.status !== 'OK', `check coverage-owner（review）: ${JSON.stringify(owner)}`);
  //   C-1 第 3 段: 会話のコードのカード（MSG.CODE・codeCardHtml）は削除した。担当の決まっていない要件は右の「コード」の見出し（codePaneHtml）と最終案のカードに出す（最終案は §6 の下の会話の節）
  let cardUn = '';
  try { cardUn = KTAiChatUi.codePaneHtml({ generated: gen([]), review: un, existingSource: null }).head; } catch (e) { cardUn = `例外: ${e && e.stack}`; }
  assert(!/kt-ai-code-unowned|kt-ai-code-out-of-scope|計画で担当が決まっていない要件|担当範囲外/.test(cardUn) && /＋ 新規 JS: |✎ 既存 JS を変更: /.test(cardUn), `右の「コード」の見出しには担当範囲外・担当の無い要件を出さない（2026-10-14: 担当の無い要件は右の「変更内容」の「確認できないこと」に 1 回）: ${cardUn.slice(0, 400)}`);
  // クライアントの検証は OUT_OF_SCOPE を語彙として受け取る（語彙外は従来どおり PARTIAL）
  const gctx = KTContext.buildGenerator({ customization: C2, plan: SR.CASE2_PLAN, planId: 'p', version: 1, data: INPUTS.data, deps: INPUTS.deps, scan: INPUTS.scan });
  const RESP = { ok: true, contractVersion: '2.1', meta: { requestId: 'g1', gateway: { product: 'toolkit', feature: 'customization-generator', promptVersion: '1', contextVersion: 'customization-1' }, normalization: { warnings: [] }, ai: { model: 'm' } }, generated: { ...gen([{ requirement: '100万円以上は部長承認', status: 'OUT_OF_SCOPE', note: 'P1' }, { requirement: 'x', status: 'BOGUS', note: '' }]), gatewayChecks: { security: [] } } };
  const vg = KTAiClient.validateGenerated(RESP, gctx);
  const covN = vg.normalized?.coverage || vg.normalized?.generated?.coverage || [];
  assert(vg.ok && covN[0]?.status === 'OUT_OF_SCOPE' && covN[1]?.status === 'PARTIAL', `validateGenerated: OUT_OF_SCOPE を残す（語彙外は PARTIAL）: ${JSON.stringify({ ok: vg.ok, errors: vg.errors, cov: covN })}`);
  // buildGenerator の plan.otherCustomizations（この customization 以外。無ければ []）
  const other = gctx.plan.otherCustomizations;
  assert(Array.isArray(other) && other.length === 2 && other.map(x => x.customizationId).join(',') === 'C1,C3' && other[0].requirement === C1.requirement && JSON.stringify(other[0].platform) === '["desktop"]' && Object.keys(other[0]).sort().join(',') === 'customizationId,platform,requirement', `buildGenerator: plan.otherCustomizations = C1 / C3（customizationId・requirement・platform）: ${JSON.stringify(other)}`);
  const solo = KTContext.buildGenerator({ customization: C2, plan: { ...SR.CASE2_PLAN, customizations: [C2] }, planId: 'p', version: 1, data: INPUTS.data });
  assert(Array.isArray(solo.plan.otherCustomizations) && solo.plan.otherCustomizations.length === 0 && Array.isArray(KTContext.buildGenerator({ customization: C2, plan: null, data: INPUTS.data }).plan.otherCustomizations), '他に customization が無ければ []（plan が無くても []）');
  // 確認の結果（KTCodeReview の coverage）は outOfScope と notAchieved を分けて持つ（2026-10-19: 同じ値を写す表示の型の codeSummary は削除した。表示は codePaneHtml と最終案）
  assert(rv.coverage.outOfScope.length === 3 && rv.coverage.notAchieved.length >= 1, `coverage: outOfScope と notAchieved を分けて持つ: ${JSON.stringify({ oos: rv.coverage.outOfScope.length, na: rv.coverage.notAchieved.length })}`);
  // 会話: 満たせない部分と担当範囲外を分けて出す。
  //   C-1 第 3 段: 従来の生成の案内（code-intro）は削除した。新しい流れでは最終案のカードの「実現できない点・対応範囲」に、満たせない部分（cannot）・
  //   この JavaScript の対応範囲外（担当のある要件）・担当が計画に無い要件の順に分けて出す
  const custStep = mkStep('C1', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C1' }, { solution: 'CUSTOMIZATION', confidence: 'CONFIRMED' });
  const custC1 = { customizationId: 'C1', requirement: '承認済みでは金額を編集不可にする', whyStandardInsufficient: 'ステータスで切り替えるアクセス権は無い', strategy: 'NEW_JS_FILE', implementation: 'JAVASCRIPT', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認済み")', effects: ['lock'] }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [] };
  const hybrid = mkPlan([custStep], { goal: '承認済みでは金額を編集できなくして', solution: 'HYBRID', customizations: [custC1] });
  /** 偽の生成工程（共有の部品の makeGenerate）の結果の形式確認に、この節の coverage を入れる */
  const runFinal = async (coverage) => {
    const base = K.makeGenerate({ sequence: ['good'] });
    const generate = { calls: base.calls, impl: async (args) => { const r = await base.impl(args); r.review = { ...r.review, coverage: { achieved: [], notAchieved: [], outOfScope: [], unowned: [], ...coverage } }; return r; } };
    const x = makeConvN({ planImpl: () => { const p = clone(hybrid); return { plan: p, ctx: { facts: [] }, review: R.review({ plan: p, ...INPUTS }), turn: null }; }, generate });
    await startN(x, '承認済みでは金額を編集できなくして');
    const v = x.c.activePlan();
    return { x, v, gen: base.calls.length, text: v && v.final ? K.stripC(K.finalHtml(x)) : '', right: v && v.final ? K.stripC(KTAiChatUi.changeSummaryHtml(v, {})) : '' };
  };
  const f1 = await runFinal({ notAchieved: [{ code: 'SUBTABLE_ROWS', message: '明細の行の追加・削除は止められません' }], outOfScope: [{ code: 'AI_OUT_OF_SCOPE', requirement: '100万円以上は部長承認', owner: 'step', message: '100万円以上は部長承認（P1 の標準設定で扱う）' }] });
  const t1 = f1.text;
  //   2026-10-16（説明文を読みやすくする）: 制約の行は「明細の行の追加・削除は防ぎません（画面）。理由。」
  assert(f1.gen === 1 && /この案の制約/.test(t1) && /明細（テーブル）の行の追加・削除は防ぎません/.test(t1) && !/対応範囲外|担当が計画にありません|100万円以上は部長承認（P1 の標準設定で扱う）/.test(t1 + f1.right), `最終案のカード: 満たせない部分は「この案の制約」。ほかの手順が担当する要件は左右どちらにも範囲外として出さない（2026-10-14）: ${t1.slice(t1.indexOf('実現できない点'), t1.indexOf('実現できない点') + 300)}`);
  const f2 = await runFinal({ outOfScope: [{ code: 'OTHER_OWNER', requirement: 'r', owner: 'customization', customizationId: 'C2', message: 'モバイルの編集制御（C2 の担当）' }] });
  assert(f2.gen === 1 && !/明細の行の追加・削除|この案の制約/.test(f2.text) && !/対応範囲外|モバイルの編集制御（C2 の担当）/.test(f2.text + f2.right), `最終案のカード: 担当範囲外だけのときは制約の節を出さず、担当のある要件は列挙しない（2026-10-14）: ${f2.text.slice(f2.text.indexOf('実現できない点'), f2.text.indexOf('実現できない点') + 200)}`);
  // 担当が計画に無い要件（unowned）は「担当が計画にありません」として、担当のある範囲外とは別の行に出す
  const f3 = await runFinal({ outOfScope: [{ code: 'OTHER_OWNER', requirement: '承認待ちの通知', owner: 'step', message: '承認待ちの通知（標準設定で対応）' }, { code: 'AI_OUT_OF_SCOPE', requirement: '承認後に Slack へ知らせる', owner: 'unowned', note: '別の仕組み', message: '承認後に Slack へ知らせる（別の仕組み）' }], unowned: [{ code: 'UNOWNED', requirement: '承認後に Slack へ知らせる', message: '承認後に Slack へ知らせる' }] });
  const t3 = f3.text;
  assert(f3.gen === 1 && /確認できないこと/.test(f3.right) && /「承認後に Slack へ知らせる」は、この計画のどの手順・JavaScript が担当するか決まっていません/.test(f3.right) && !/承認待ちの通知（標準設定で対応）|対応範囲外|担当が計画にありません/.test(t3 + f3.right), `右の「変更内容」の「確認できないこと」: 担当の無い要件は 1 回・担当のある要件は出さない（2026-10-14）: ${t3.slice(t3.indexOf('実現できない点'), t3.indexOf('実現できない点') + 300)}`);
});

console.log(`\n${state.failed === 0 ? 'ALL PASS' : 'SOME FAILED'}: ${state.passed} passed, ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})();
