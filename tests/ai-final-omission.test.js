// 最終案の変更を会話で外す経路と、反映できない手順を黙って省かないこと（2026-10-19。画面の流れ・固定の応答。有料の AI は呼ばない）
//
// 検証内容:
//   §O1 変更を外す: 右の「確認結果」の［この手順を反映しない］（2026-10-19 に廃止）の代わりは、会話の修正の依頼（REVISE_PLAN）。
//       計画の AI を 1 回呼び（操作と費用の変更）、変わらない JavaScript は作り直さない。新しい版の計画・確認・生成物・承認の欄の準備・書き込みが依頼と一致し、
//       前の版の承認・生成物は新しい版に戻らない。外した手順に依存する手順が残った案は承認できない
//   §O2 反映できない手順を黙って省かない（最終案の［動作テスト環境へ反映］から）:
//       (a) 必要な値が計画に無い手順（通知時刻など）は承認できない（ほかの手順だけを反映しない）
//       (b) 手作業に回す種類（Toolkit が作れないフィールドなど）は承認できるが、決める時点と結果のカードで「自動では反映しない手順」と出す
//       (c) 同じ遷移元の分岐の片方だけは反映しない（承認できない）
//       (d) 本当に変更不要な手順は止めない（書き込まない・手作業や失敗に数えない）
//       (e) 実行の途中の失敗による一部反映は、承認の前から分かっていた手作業の手順と別の文で出す
//
// 実行方法: node tests/ai-final-omission.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const T = loadToolkit();
const { KTPlanExecutor } = T;
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const { assert, state } = makeAssert();
const { stripC } = K;
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }
const outside = (h) => String(h).replace(/<details[\s\S]*?<\/details>/g, '');
/** 会話の最後の最終案のカード（HTML） */
const lastCard = (m, cls = 'kt-ai-final-card') => { const cards = [...m.chat().matchAll(/<div class="kt-ai-msg[^"]*" data-mid="[^"]*">([\s\S]*?)(?=<div class="kt-ai-msg|$)/g)].map(x => x[1]).filter(x => x.includes(cls)); return cards[cards.length - 1] || ''; };
const VIEW = () => K.mkStep('P1', 'ADD_VIEW', 'VIEW', '承認待ち一覧', { name: '承認待ち一覧', fields: ['owner', 'case_name'], filterCond: 'owner in (LOGINUSER())', sort: 'due_date asc' }, { title: '一覧「承認待ち一覧」を追加' });
/** 設定だけの計画（steps と追加のフィールド）で画面を作り、仮案を採用して最終案まで進める */
const mountPlan = async (steps, proposedFields = []) => {
  const raw = (goal) => { const b = K.PLAN_V1(goal); return { ...b, plan: { ...b.plan, proposedFields, steps } }; };
  const m = K.mount({ planImpl: K.planImplOf(raw) });
  await K.ticks();
  const v = await K.adoptOnScreen(m);
  await K.ticks(20);
  return { m, v };
};
const newField = (temporaryId, label, suggestedCode, type, extra = {}) => ({ temporaryId, label, suggestedCode, type, typeValid: true, required: false, options: [], reason: '', evidenceIds: [], alternativeExistingFieldCode: null, codeConflict: false, labelDuplicate: false, ...extra });

(async () => {
// =========================================================
console.log('\n--- §O1. 変更を会話で外す（手順を外す欄の代わり）---');
//   素材: 承認メモのフィールドの追加（P1）・一覧「承認待ち一覧」（P2）・承認待ちでは承認メモを編集できなくする JavaScript（C1。P1 に依存）
const base = K.screenPlan('mixed');
const mountRemove = async (revised) => {
  const gen = K.screenGenerate({ field: 'approval_memo', targetFile: 'memoLock.js' });
  let genN = 0;
  const m = K.mount({ health: K.HEALTH_V, planImpl: ({ ctx, requestId }) => K.planImplOf(ctx.revision ? revised : base)({ ctx, requestId }), generateImpl: (a) => { genN += 1; return gen.impl(a); } });
  await K.ticks();
  const v1 = await K.adoptOnScreen(m);
  await K.ticks(20);
  await K.waitUntil(() => m.panel.finalPrecheck().status === 'ready' && m.panel.finalPrecheck().version === v1.version, 80);
  return { m, v1, genCount: () => genN };
};
await section(async () => {
  //   一覧だけを外す
  const { m, v1, genCount } = await mountRemove((goal) => { const r = base(goal); return { ...r, plan: { ...r.plan, steps: r.plan.steps.filter(s => s.id !== 'P2') } }; });
  const pre1 = m.panel.finalPrecheck();
  assert(v1.plan.steps.map(s => s.id).join() === 'P1,P2,C1' && m.conv().finalReadiness(v1).ready === true && pre1.status === 'ready' && (pre1.items.settings || []).includes('一覧「承認待ち一覧」を追加') && m.calls.plan.length === 1 && genCount() === 1,
    `前提: v1 は一覧を含む最終案（承認できる・承認の欄の準備に一覧がある・計画 1 回・生成 1 回）: ${JSON.stringify({ steps: v1.plan.steps.map(s => s.id), settings: pre1.items && pre1.items.settings })}`);
  const r = await m.panel.send('承認待ち一覧の追加はやめてください'); await K.ticks(40);
  const v2 = m.conv().activePlan();
  assert(r && r.intent === 'REVISE_PLAN' && m.calls.plan.length === 2 && /承認待ち一覧の追加はやめてください/.test(String(m.calls.plan[1].ctx.revision && m.calls.plan[1].ctx.revision.request)) && genCount() === 1,
    `O1-1: 外す依頼は計画の修正（REVISE_PLAN）。計画の AI をもう 1 回呼ぶ（月の利用回数と費用に数える）。変わらない JavaScript は作り直さない（生成は 1 回のまま）: ${JSON.stringify({ intent: r && r.intent, plan: m.calls.plan.length, gen: genCount() })}`);
  assert(v2 && v2 !== v1 && v2.version === 2 && v2.final && v2.plan.steps.map(s => s.id).join() === 'P1,C1' && !(v2.review.steps || []).some(s => s.stepId === 'P2') && v2.generated.C1 && v2.generated.C1.status === 'verified',
    `O1-2: 新しい版の計画・確認・生成物に外した一覧が無い（JavaScript は新しい版でも検証済み）: ${JSON.stringify({ v: v2 && v2.version, steps: v2 && v2.plan.steps.map(s => s.id) })}`);
  const sum = m.$('kt-ai-change-summary').innerHTML;
  const rows = (sum.match(/<li><span>[^<]*/g) || []).map(x => x.replace('<li><span>', ''));
  assert(/何が変わるか/.test(sum) && rows.includes('承認メモフィールドを追加') && !rows.some(x => /承認待ち一覧/.test(x)) && /前の最終案から変わった点[\s\S]*入れた指示: 承認待ち一覧の追加はやめてください/.test(stripC(sum)),
    `O1-3: 右の「変更内容」は新しい版（何が変わるかに承認メモは残り、一覧の行は無い。変わった点に入れた指示）: ${JSON.stringify(rows)}`);
  await K.waitUntil(() => m.panel.finalPrecheck().version === v2.version && m.panel.finalPrecheck().status === 'ready', 80);
  const pre2 = m.panel.finalPrecheck();
  assert(pre2.version === v2.version && pre2.status === 'ready' && JSON.stringify(pre2.items.settings) === JSON.stringify(['承認メモフィールドを追加']) && (pre2.items.files || []).length === 1,
    `O1-4: 承認の欄の準備（書き込みなし）は新しい版でやり直し、外した一覧は反映する設定に入らない: ${JSON.stringify(pre2.items && pre2.items.settings)}`);
  assert(!v1.approval && !v2.approval && v1.status === 'SUPERSEDED', 'O1-5: 前の版の承認は無く、新しい版も押すまで承認しない（前の承認を新しい版に流用しない）');
  const w0 = K.writesOf(m).length;
  const old = await m.panel.applyFinal(v1.planId, v1.version); await K.ticks(4);
  assert(old === null && !v1.approval && K.writesOf(m).length === w0, 'O1-6: 前の版の最終案は反映できない（外した一覧を前の版から書き込まない）');
  const ap = await K.applyOnScreen(m);
  assert(ap.clicked && ap.button && !ap.button.disabled && ap.writes.includes('POST fields') && ap.writes.includes('PUT customize') && !ap.writes.includes('PUT views') && /動作テスト環境へ反映しました/.test(ap.card),
    `O1-7: 新しい版を［動作テスト環境へ反映］1 回で反映: 外した一覧は書き込まない（フィールドと JavaScript だけ）: ${JSON.stringify(ap.writes)}`);
});
await section(async () => {
  //   フィールドを外したのに、計画の AI がそれに依存する一覧と JavaScript を残した
  const { m } = await mountRemove((goal) => { const r = base(goal); return { ...r, plan: { ...r.plan, proposedFields: [], steps: r.plan.steps.filter(s => s.id !== 'P1').map(s => (s.id === 'P2' ? { ...s, dependsOn: ['P1'], spec: { ...s.spec, fields: ['owner', 'NEW_FIELD_1'] } } : s)) } }; });
  await m.panel.send('承認メモのフィールドの追加はやめてください'); await K.ticks(40);
  const v2 = m.conv().activePlan();
  const rd = m.conv().finalReadiness(v2);
  const btn = K.applyButtonOf(m);
  const w0 = K.writesOf(m).length;
  const ap = await K.applyOnScreen(m);
  assert(v2.version === 2 && !v2.plan.steps.some(s => s.id === 'P1') && rd && rd.ready === false && rd.reasons.some(x => x.kind === 'blocked') && btn && btn.disabled && K.writesOf(m).length === w0 && !ap.writes.length,
    `O1-8: 外した手順に依存する手順（一覧・JavaScript）が残った案は、成立しないまま反映しない（承認できない・書き込み 0）: ${JSON.stringify({ reasons: rd && rd.reasons.map(x => x.kind), btn })}`);
});
await section(async () => {
  //   JavaScript を外す
  const { m } = await mountRemove((goal) => { const r = base(goal); return { ...r, plan: { ...r.plan, solution: 'STANDARD', customizations: [], steps: r.plan.steps.filter(s => s.id !== 'C1') } }; });
  await m.panel.send('JavaScript の部分はやめてください'); await K.ticks(40);
  const v2 = m.conv().activePlan();
  const ap = await K.applyOnScreen(m);
  assert(v2.version === 2 && !Object.keys(v2.generated || {}).length && ap.clicked && !ap.button.disabled && ap.writes.includes('POST fields') && ap.writes.includes('PUT views') && !ap.writes.some(w => /customize|file/.test(w)),
    `O1-9: JavaScript を外した版は、前の版で作った JavaScript を登録しない（生成物は新しい版に戻らない）: ${JSON.stringify(ap.writes)}`);
});

// =========================================================
console.log('\n--- §O2. 反映できない手順を黙って省かない（最終案の［動作テスト環境へ反映］から）---');
await section(async () => {
  // (a) 通知時刻の無いリマインダー
  const { m, v } = await mountPlan([VIEW(), K.mkStep('P2', 'ADD_REMINDER', 'NEW_SETTING', '期限7日後', { name: '期限7日後', timingField: 'due_date', daysLater: 7, targets: ['FIELD_ENTITY:owner'] }, { title: '期限の 7 日後に担当者へリマインド' })]);
  const a = KTPlanExecutor.applyReadiness(v.plan, v.review).find(x => x.stepId === 'P2');
  const rd = m.conv().finalReadiness(v);
  const card = outside(lastCard(m));
  const ap = await K.applyOnScreen(m);
  assert(a && a.apply === 'MANUAL' && a.reason === 'REMINDER_TIME_MISSING' && a.valueMissing === true && rd.ready === false && rd.reasons.some(x => x.kind === 'no-values') && ap.button && ap.button.disabled && !ap.writes.length,
    `O2-a1: 必要な値（通知時刻）が計画に無い手順があれば承認できない（一覧だけを反映しない・書き込み 0）: ${JSON.stringify({ a, reasons: rd.reasons.map(x => x.kind), btn: ap.button, writes: ap.writes })}`);
  assert(/最終案（反映できない点があります）/.test(stripC(card)) && /必要な値が計画に無い手順: 期限の 7 日後に担当者へリマインド（通知時刻[^）]*）/.test(stripC(card)) && /値を会話で伝えて、最終案を作り直します/.test(stripC(card)) && !/この内容で反映できます/.test(stripC(card)),
    `O2-a2: 決める時点（最終案のカード）に、止めている手順と足りない値と次の方針を見える文で出す: ${stripC(card).replace(/\s+/g, ' ').slice(0, 300)}`);
  const sum = m.$('kt-ai-change-summary').innerHTML;
  assert(/期限の 7 日後に担当者へリマインド：必要な値が計画に無いため反映できません（通知時刻/.test(sum) && !/kintone の画面で設定/.test(sum), `O2-a3: 右の「変更内容」も同じ判定（「自動で反映できない・kintone で設定」と言わない）: ${stripC(sum).replace(/\s+/g, ' ').match(/反映できないこと.{0,160}/)}`);
});
await section(async () => {
  // (b) Toolkit が作れないフィールド（計算）は手作業に回す
  const { m, v } = await mountPlan([VIEW(), K.mkStep('P2', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'CALC' }, { title: '税込金額の計算フィールドを追加' })], [newField('NEW_FIELD_1', '税込金額', 'amount_tax', 'CALC')]);
  const a = KTPlanExecutor.applyReadiness(v.plan, v.review).find(x => x.stepId === 'P2');
  await K.waitUntil(() => m.panel.finalPrecheck().status === 'ready', 80); await K.ticks(4);
  const card = lastCard(m);
  const manualBox = (card.match(/<div class="kt-ai-final-pre-manual"[\s\S]*?<\/ul>/) || [''])[0];
  assert(a && a.apply === 'MANUAL' && a.reason === 'FIELD_TYPE_NOT_SUPPORTED' && !a.valueMissing && m.conv().finalReadiness(v).ready === true && manualBox && /税込金額の計算フィールドを追加/.test(manualBox) && outside(card).includes(manualBox) && /この内容で反映できます（自動では反映しない手順 1 件を除く）。/.test(stripC(card)),
    `O2-b1: 手作業に回す手順は承認を止めないが、決める時点で見える所（閉じた［反映の前の確認］の外）に出し、反映できるかの 1 文にも件数を添える: ${stripC(outside(card)).replace(/\s+/g, ' ').slice(0, 300)}`);
  const ap = await K.applyOnScreen(m);
  const ex = m.panel.executorState().execution;
  assert(ap.clicked && JSON.stringify(ap.writes) === JSON.stringify(['PUT views']) && /動作テスト環境へ反映しました/.test(ap.card) && /自動では反映していない手順（承認の前から分かっていたもの。kintone の画面で設定してください）: 税込金額の計算フィールドを追加/.test(ap.card) && ex && ex.steps.find(s => s.stepId === 'P2').status === 'UNSUPPORTED',
    `O2-b2: 結果のカードに、反映していない手順を「承認の前から分かっていたもの」として出す（反映した件数だけにしない）: ${ap.card.replace(/\s+/g, ' ').slice(0, 300)}`);
});
await section(async () => {
  // (c) 同じ遷移元（承認待ち）の分岐: 「承認する」の条件の変更（正しい）と、条件式が kintone で評価できない新しいアクション
  const { m, v } = await mountPlan([
    K.mkStep('P1', 'UPDATE_PROCESS', 'PROCESS_ACTION', '承認する', { name: '承認する', from: '承認待ち', to: '完了', filterCond: 'amount <= "999999"', changeKind: 'ACTION_CONDITION' }, { title: '100万円未満だけ承認する' }),
    K.mkStep('P2', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長へ回す', { name: '部長へ回す', from: '承認待ち', to: '完了', filterCond: 'amount >= "1000000" and foo(' }, { title: '100万円以上は部長へ回す' }),
  ]);
  const cls = new Map(KTPlanExecutor.applyReadiness(v.plan, v.review).map(x => [x.stepId, x]));
  const rd = m.conv().finalReadiness(v);
  const ap = await K.applyOnScreen(m);
  assert(cls.get('P2').apply === 'BLOCKED' && cls.get('P1').apply === 'BLOCKED' && cls.get('P1').reason === 'PROCESS_BRANCH_PARTIAL' && rd.ready === false && rd.reasons.some(x => x.kind === 'blocked') && ap.button && ap.button.disabled && !ap.writes.length,
    `O2-c: 組で成立する分岐の片方だけを反映しない（片方が反映できなければ、もう片方も反映せず承認できない・書き込み 0）: ${JSON.stringify({ P1: cls.get('P1'), P2: cls.get('P2') && cls.get('P2').reason, reasons: rd.reasons.map(x => x.kind) })}`);
});
await section(async () => {
  // (d) 今と同じ値の手順（案件名は既に必須）は変更不要
  const { m, v } = await mountPlan([VIEW(), K.mkStep('P2', 'UPDATE_FIELD', 'FIELD', 'case_name', { required: true }, { title: '案件名を必須にする' })]);
  const a = KTPlanExecutor.applyReadiness(v.plan, v.review).find(x => x.stepId === 'P2');
  await K.waitUntil(() => m.panel.finalPrecheck().status === 'ready', 80); await K.ticks(4);
  const pre = m.panel.finalPrecheck();
  const card = lastCard(m);
  const ap = await K.applyOnScreen(m);
  assert(a && a.reason === 'NO_CHANGE' && a.apply === 'CONFIRM' && m.conv().finalReadiness(v).ready === true && (pre.items.manual || []).length === 0 && !/kt-ai-final-pre-manual/.test(card) && ap.clicked && JSON.stringify(ap.writes) === JSON.stringify(['PUT views']) && !/自動では反映していない|失敗/.test(ap.card),
    `O2-d: 本当に変更不要な手順は止めない（承認できる・書き込まない・手作業にも失敗にも数えない）: ${JSON.stringify({ a, manual: pre.items && pre.items.manual, writes: ap.writes })}`);
});
await section(async () => {
  // (e) 実行の途中の失敗（一覧は書けたがフィールドの追加で失敗）
  const { m } = await mountPlan([VIEW(), K.mkStep('P2', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', { fieldType: 'SINGLE_LINE_TEXT' }, { title: '承認メモフィールドを追加' })], [newField('NEW_FIELD_1', '承認メモ', 'approval_memo', 'SINGLE_LINE_TEXT')]);
  m.mock.api.addPreviewFields = async () => { const e = new Error('テストの失敗（フィールドの追加）'); e.code = 'CB_TEST'; throw e; };
  const ap = await K.applyOnScreen(m);
  assert(ap.clicked && JSON.stringify(ap.writes) === JSON.stringify(['PUT views']) && /一部だけ反映しました（要確認）/.test(ap.card) && /標準設定: ✓ 1 件反映・× 1 件は失敗（以降は未実行）/.test(ap.card) && !/承認の前から分かっていたもの/.test(ap.card),
    `O2-e: 途中の失敗による一部反映は「一部だけ反映しました（要確認）」と失敗の件数で出し、承認の前から分かっていた手作業の手順と同じ文にしない: ${ap.card.replace(/\s+/g, ' ').slice(0, 300)}`);
});

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
