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
//       (f) 計画の確認で無効な手順（依存先が無効な確認の手順を含む）は、反映の分類だけから「実行できない手順」に指摘の文で出し、承認させない
//   §O3 反映の前の準備（2026-10-21）: 書き込む手順は、取り直した設定に対する計画の検査で分類し、その結果から書き込む内容を作る（手順ごとの準備で取り直した設定を
//       もう一度確かめない）。最終案の［動作テスト環境へ反映］から: (g) 書いた内容は承認した準備・計画の検査の After と同じ (h) 依存が成り立たない手順は止める（書き込み 0）
//       (i) 承認の後（押す直前）に書き込む手順の対象の設定が変わると止める（書き込み 0。承認を取り消す）
//   §O4 反映前後の取得・比較・検証（2026-10-21）: 最終案の［動作テスト環境へ反映］から:
//       (j) 設定 → JavaScript: 登録の準備は設定を書いた直後に取り直した作業の基準で行い、作業の基準をもう一度取り直さない
//       (k) その取り直しが失敗したら、設定を書く前の基準で JavaScript を登録しない (l) JavaScript だけの反映は、押した直後の準備（承認した指紋と一致）を登録に使い、
//       承認した本文・位置を書く (m)(n) 押す前・書き込みの直前にカスタマイズが変わったら止める（書き込み 0）(o) 設定の読み戻しの不一致を完了と出さない
//       (p) JavaScript の本文・順序・PC／モバイルの不一致を完了と出さない (q) 一部失敗の記録と元に戻す対象 (r) 反映した後の照合・再解析を持たない
//       (s) 設定を書く前に始まった作業の基準の取得が書いた後まで続いても、設定を書いた直後の取り直しはそれに合流せず、書いた後の設定で登録の準備をする
//       (t) 書いている途中に始まって止めた取得の続き（書く前の設定）を、設定を書いた直後の取り直しが使わない
//       (u) JavaScript だけの反映で、押した直後の準備に「設定の反映の後に確かめる依存」が残るときは使い回さず、作り直した準備が止める（書き込み 0）
//       （変更が無い手順を書かないことは §O2 (d)、承認の後に設定の対象が変わったら止めることは §O3 (i)）
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
await section(async () => {
  // (f) 無いフィールドの変更（計画の確認で無効）と、それに依存する確認の手順。実行できない手順は反映の分類の 1 つから出す（2026-10-19。前は計画の確認の実行の見込みからも拾っていた）
  const { m, v } = await mountPlan([
    VIEW(),
    K.mkStep('P2', 'UPDATE_FIELD', 'FIELD', 'ghost_field', { required: true }, { title: '備考を必須にする' }),
    K.mkStep('Q1', 'REQUIRE_CONFIRMATION', 'NONE', null, {}, { title: '必須にする時期を担当者に確かめる', dependsOn: ['P2'] }),
  ]);
  const cls = new Map(KTPlanExecutor.applyReadiness(v.plan, v.review).map(x => [x.stepId, x]));
  const rvOf = (id) => (v.review.steps || []).find(r => r.stepId === id) || {};
  assert(rvOf('P2').status === 'INVALID' && rvOf('Q1').status === 'BLOCKED_BY_DEPENDENCY' && cls.get('P2').apply === 'BLOCKED' && cls.get('Q1').apply === 'BLOCKED' && cls.get('Q1').reason === 'REVIEW_BLOCKED' && cls.get('Q1').message === rvOf('Q1').issues[0].message && cls.get('P1').apply === 'AUTO',
    `前提: 計画の確認で無効な手順は、確認の手順も反映の分類で止める（理由は計画の確認の指摘の文）: ${JSON.stringify([...cls.values()].map(x => [x.stepId, x.apply, x.reason, x.message]))}`);
  const rd = m.conv().finalReadiness(v);
  const card = stripC(outside(lastCard(m)));
  const ap = await K.applyOnScreen(m);
  assert(rd.ready === false && rd.reasons.some(x => x.kind === 'blocked') && /実行できない手順: 備考を必須にする（[^）]+）/.test(card) && /実行できない手順: 必須にする時期を担当者に確かめる（依存する P2 が無効のため実行できません）/.test(card) && !/Review で実行不可/.test(card) && ap.button && ap.button.disabled && !ap.writes.length,
    `O2-f: 計画の確認で無効な手順は、確認の手順も含めて「実行できない手順」に指摘の文で出し、承認させない（一覧だけを反映しない・書き込み 0）: ${card.replace(/\s+/g, ' ').slice(0, 400)}`);
  const sum = stripC(m.$('kt-ai-change-summary').innerHTML).replace(/\s+/g, ' ');
  assert(/備考を必須にする：反映できません（存在しないFIELD「ghost_field」を既存として参照）/.test(sum) && /必須にする時期を担当者に確かめる：反映できません（依存する P2 が無効のため実行できません）/.test(sum) && !/Review で実行不可/.test(sum),
    `O2-f2: 右の「変更内容」の「反映できないこと」も同じ 2 件を指摘の文で出す（左の最終案と同じ集まり）: ${(sum.match(/反映できないこと.{0,240}/) || [''])[0]}`);
});

// =========================================================
console.log('\n--- §O3. 反映の前の準備: 取り直した設定に対する計画の検査から書き込む内容を作る（最終案の［動作テスト環境へ反映］）---');
await section(async () => {
  // (g) 承認の欄の準備と、押した後の準備のどちらも、取り直した設定に対する計画の検査で書き込む内容を作る。押した後の内容が承認した準備と違えば止まる（applyFinal の指紋の比較）ので、
  //     反映できたことは同じ内容だったこと。書いた一覧は計画の検査の After と同じ
  const { m, v } = await mountPlan([VIEW()]);
  const ap = await K.applyOnScreen(m);
  const after = (v.review.steps.find(r => r.stepId === 'P1') || {}).diff.after;
  const st = ((ap.exec.prepared && ap.exec.prepared.steps) || []).find(s => s.stepId === 'P1');
  const view = m.mock.st.views['承認待ち一覧'];
  const pick = (x) => x && { fields: [...(x.fields || [])], filterCond: x.filterCond || '', sort: x.sort || '' };
  assert(ap.clicked && ap.run && ap.run.ok && JSON.stringify(ap.writes) === JSON.stringify(['PUT views']) && v.approval && v.approval.precheck && v.approval.precheck.fingerprint && v.approval.precheck.fingerprint.settings
    && st && st.prepared && JSON.stringify(pick(st.prepared.payload.view)) === JSON.stringify(pick(after)) && view && JSON.stringify(pick(view)) === JSON.stringify(pick(after)) && (ap.exec.prepared.blockers || []).length === 0,
    `O3-g: 承認した準備と同じ内容を書く（押した後の準備で作り直した書き込む内容が承認の指紋と一致して反映・書いた一覧は計画の検査の After と同じ）: ${JSON.stringify({ writes: ap.writes, payload: st && st.prepared && pick(st.prepared.payload.view), after: pick(after), view: pick(view) })}`);
});
await section(async () => {
  // (h) 依存先が自動では反映できない手順（型の変更は手作業）に依存する手順は止める（ほかの手順だけを反映しない・書き込み 0）
  const { m, v } = await mountPlan([
    K.mkStep('P1', 'UPDATE_FIELD', 'FIELD', 'amount', { fieldType: 'SINGLE_LINE_TEXT' }, { title: '金額を文字列にする' }),
    K.mkStep('P2', 'ADD_VIEW', 'VIEW', '承認待ち一覧', { name: '承認待ち一覧', fields: ['owner', 'case_name'], filterCond: 'owner in (LOGINUSER())', sort: 'due_date asc' }, { title: '一覧「承認待ち一覧」を追加', dependsOn: ['P1'] }),
  ]);
  const cls = new Map(KTPlanExecutor.applyReadiness(v.plan, v.review).map(x => [x.stepId, x]));
  const rd = m.conv().finalReadiness(v);
  const ap = await K.applyOnScreen(m);
  assert(cls.get('P1') && cls.get('P1').apply === 'MANUAL' && cls.get('P2') && cls.get('P2').apply === 'BLOCKED' && cls.get('P2').reason === 'DEPENDENCY_NOT_EXECUTABLE' && rd.ready === false && ap.button && ap.button.disabled && !ap.writes.length && !m.mock.st.views['承認待ち一覧'],
    `O3-h: 依存先が反映できない手順は止める（承認できない・書き込み 0）: ${JSON.stringify({ P1: cls.get('P1'), P2: cls.get('P2'), reasons: rd.reasons.map(x => x.kind), writes: ap.writes })}`);
});
await section(async () => {
  // (i) 承認の欄の準備の後（押す直前）に、書き込む手順の対象のフィールドを別の作業者が変えた → 押した直後の取り直しで止め、何も書き込まずに承認を取り消す
  const { m, v } = await mountPlan([K.mkStep('P1', 'UPDATE_FIELD', 'FIELD', 'case_name', { name: '案件の名前' }, { title: '案件名の表示名を変える' })]);
  const ap = await K.applyOnScreen(m, { before: () => { m.mock.st.fields.case_name.label = '別の作業者が変えた名前'; } });
  assert(ap.clicked && ap.run && ap.run.stage === 'stopped' && !ap.run.written && !ap.writes.length && m.mock.st.fields.case_name.label === '別の作業者が変えた名前' && !v.approval && /何も書き込/.test(ap.card),
    `O3-i: 承認の後に書き込む手順の対象が変わると、押した直後の取り直しで止める（書き込み 0・承認を取り消す）: ${JSON.stringify({ run: ap.run && { stage: ap.run.stage, stop: ap.run.stop && ap.run.stop.text }, writes: ap.writes })}`);
});

// =========================================================
console.log('\n--- §O4. 反映前後の取得・比較・検証（最終案の［動作テスト環境へ反映］）---');
//   作業の基準の読み込み（理由・結果）と、JavaScript の登録の準備（そのときの作業の基準）を記録して、最終案のカードから反映する。
//   fail = その理由の読み込みを失敗させる / beforeJsWrite = JavaScript の登録（書き込み）を始める直前に呼ぶ（並行の変更の回帰用）
const countedApply = async (kind, { before = null, fail = null, beforeJsWrite = null } = {}) => {
  const JX = T.KTJsExecutor;
  const loads = [], jsPrepares = [];
  let mref = null;
  const loader = K.loadDevBaseFromMock(() => mref.mock);
  const gen = K.screenGenerate({ field: kind === 'js' ? 'case_name' : 'approval_memo', targetFile: kind === 'js' ? 'caseLock.js' : 'memoLock.js' });
  const m = K.mount({ health: K.HEALTH_V, planImpl: K.planImplOf(K.screenPlan(kind)), generateImpl: gen.impl,
    extra: { loadDevBase: (a = {}) => {
      const rec = { reason: a.reason || null, at: mref.mock.calls.length, base: null }; loads.push(rec);
      if (fail && fail === a.reason) { rec.base = { ok: false, status: 'FETCH_FAILED', message: '取得に失敗しました（テスト）', loadedAt: new Date().toISOString(), errors: [] }; return Promise.resolve(rec.base); }
      return loader(a).then((b) => { rec.base = b; return b; });
    } } });
  mref = m;
  await K.ticks();
  const v = await K.adoptOnScreen(m); await K.ticks(20);
  await K.waitUntil(() => !['base', 'running'].includes(m.panel.finalPrecheck().status) && m.panel.finalPrecheck().planId === v.planId, 80); await K.ticks(4);
  const origP = JX.prepare, origE = JX.executePreview;
  JX.prepare = function (input, o) { const b = m.panel.devBase(); jsPrepares.push({ at: m.mock.calls.length, base: b, memo: !!(b && b.data && b.data.fields && b.data.fields.approval_memo), defer: !!(input && input.deferDependencies) }); return origP.call(this, input, o); };
  if (beforeJsWrite) JX.executePreview = function (p, o) { beforeJsWrite(m); return origE.call(this, p, o); };
  try {
    const l0 = loads.length, c0 = m.mock.calls.length;
    const ap = await K.applyOnScreen(m, { before });
    await K.ticks(20);
    //   位置（at）は押した後の偽の kintone の呼び出しの番号（calls と同じ数え方）
    return { m, v, ap, loads: loads.slice(l0).map(x => ({ ...x, at: x.at - c0 })), reasons: loads.slice(l0).map(x => x.reason), calls: m.mock.calls.slice(c0), jsPrepares: jsPrepares.map(x => ({ ...x, at: x.at - c0 })) };
  } finally { JX.prepare = origP; JX.executePreview = origE; }
};
/** 押す前・書き込みの直前に、別の作業者が動作テスト環境のカスタマイズに JavaScript（URL）を足した */
const otherJs = (m) => { m.mock.st.customize.desktop.js.push({ type: 'URL', url: 'https://example.com/other.js' }); m.mock.st.revision += 1; };
await section(async () => {
  // (j) 押した直後の準備（設定を書く前）は新設のフィールドを「設定の反映の後に確かめる」にする。登録の準備は、設定を書いた直後に取り直した作業の基準（after-apply）で
  //     新設のフィールドを確かめ、作業の基準をもう一度取り直さない（前は登録の準備の前に register の取り直しがあった）。revision は進み、カスタマイズの内容は同じ
  const r = await countedApply('mixed');
  const pre = r.jsPrepares[0], reg = r.jsPrepares[1], aa = r.loads.find(x => x.reason === 'after-apply');
  const jp = r.m.panel.jsExecState().prepared;
  assert(r.ap.run.stage === 'done' && r.ap.run.ok && JSON.stringify(r.ap.writes) === JSON.stringify(['POST fields', 'PUT views', 'POST file', 'PUT customize'])
    && JSON.stringify(r.reasons) === JSON.stringify(['execute', 'after-apply', 'after-js-register']) && r.jsPrepares.length === 2
    && pre.defer && !pre.memo && pre.at < r.calls.indexOf('POST fields') && reg && !reg.defer && reg.memo && !!aa && reg.base === aa.base && reg.at > r.calls.indexOf('PUT views')
    && jp && jp.snapshot && aa.base.revision.preview === jp.snapshot.revision && (jp.warnings || []).some(w => w.code === 'CUSTOMIZE_REVISION_ADVANCED') && jp.changes.every(c => c.status === 'PENDING'),
    `O4-j: 設定 → JavaScript の登録の準備は設定を書いた直後の作業の基準で行う（取り直さない）: ${JSON.stringify({ reasons: r.reasons, writes: r.ap.writes, prepares: r.jsPrepares.map(x => ({ at: x.at, memo: x.memo, defer: x.defer })), sameBase: !!(aa && reg && reg.base === aa.base), rev: jp && jp.snapshot && jp.snapshot.revision })}`);
});
await section(async () => {
  // (k) 設定を書いた直後の取り直しが失敗した → 設定を書く前の作業の基準で JavaScript を登録しない（今の設定を確かめられないとして止める。設定は書いたまま・元に戻せる）
  const r = await countedApply('mixed', { fail: 'after-apply' });
  assert(r.ap.run.stage === 'stopped' && r.ap.run.partial && JSON.stringify(r.ap.writes) === JSON.stringify(['POST fields', 'PUT views']) && JSON.stringify(r.reasons) === JSON.stringify(['execute', 'after-apply'])
    && r.jsPrepares.length === 1 && r.ap.run.stop.text === 'JavaScript の登録の準備で止まりました。' && /JavaScript: 未登録（動作テスト環境の今の設定を確かめられませんでした/.test(r.ap.card) && /data-act="rollback"/.test(r.ap.cardHtml),
    `O4-k: 設定を書いた直後の取り直しが失敗したら、前の基準で JavaScript を登録しない: ${JSON.stringify({ reasons: r.reasons, writes: r.ap.writes, stop: r.ap.run.stop, js: r.ap.run.js })}`);
});
await section(async () => {
  // (l) JavaScript だけ: 押した直後の準備（承認した指紋と一致を確かめた）を登録に使う（同じ時点・同じ作業の基準から作り直さない。取り直しも無い）。書いた本文・位置は承認した指紋と同じ
  const r = await countedApply('js');
  const fp = r.v.approval && r.v.approval.precheck && r.v.approval.precheck.fingerprint && r.v.approval.precheck.fingerprint.js;
  const list = r.m.mock.st.customize.desktop.js;
  const idx = list.findIndex(e => e.type === 'FILE' && (r.m.mock.st.files.get(e.fileKey) || {}).name === 'caseLock.js');
  const body = idx >= 0 ? r.m.mock.st.files.get(list[idx].fileKey).content : null;
  const ex = r.m.panel.jsExecState().execution;
  assert(r.ap.run.ok && JSON.stringify(r.ap.writes) === JSON.stringify(['POST file', 'PUT customize']) && JSON.stringify(r.reasons) === JSON.stringify(['execute', 'after-js-register']) && r.jsPrepares.length === 1
    && fp && fp.changes.length === 1 && typeof body === 'string' && T.KTScan.hashText(body) === fp.changes[0].hash && idx === fp.changes[0].position && ex && ex.status === 'DONE' && ex.verification.ok,
    `O4-l: JavaScript だけの反映は押した直後の準備で登録する（承認した本文・位置を書く）: ${JSON.stringify({ reasons: r.reasons, prepares: r.jsPrepares.length, writes: r.ap.writes, idx, fp: fp && fp.changes })}`);
});
await section(async () => {
  // (m) 承認の後（押す前）に別の作業者がカスタマイズを変えた → 押した直後の取り直しと承認の照合で止める（書き込み 0・承認を取り消す）
  const r = await countedApply('js', { before: ({ m }) => otherJs(m) });
  // (n) 押した直後の準備の後（登録の書き込みの直前）に変えた → 登録の部品が書き込みの直前に取り直して止める（アップロードも PUT もしない）
  const r2 = await countedApply('js', { beforeJsWrite: (m) => otherJs(m) });
  const ex2 = r2.m.panel.jsExecState().execution;
  assert(r.ap.run.stage === 'stopped' && !r.ap.writes.length && r.ap.run.stop.text === '承認の欄の準備の後に、動作テスト環境の設定が変わりました。何も書き込まずに止めました。' && !r.v.approval
    && r2.ap.run.stage === 'stopped' && !r2.ap.writes.length && ex2 && ex2.error && ex2.error.code === 'STALE_CUSTOMIZATION' && ex2.previewUnchanged === true && r2.ap.run.stop.text === 'JavaScript を登録できませんでした。' && !r2.v.approval,
    `O4-m/n: 押す前・書き込みの直前にカスタマイズが変わったら止める（書き込み 0）: ${JSON.stringify({ m: { stop: r.ap.run.stop && r.ap.run.stop.text, writes: r.ap.writes }, n: { stop: r2.ap.run.stop && r2.ap.run.stop.text, writes: r2.ap.writes, err: ex2 && ex2.error } })}`);
});
await section(async () => {
  // (o) 設定の読み戻しの不一致（kintone に保存された一覧の絞り込みが違う）→ VERIFY_FAILED。右の「反映」も結果のカードも完了と出さない（照合の行は無い）
  const r = await countedApply('settings', { before: ({ m }) => { m.mock.ctl.mutateList = (what, list) => { if (what === 'views' && list['承認待ち一覧']) list['承認待ち一覧'].filterCond = ''; return list; }; } });
  const ex = r.m.panel.executorState().execution, pane = r.m.$('kt-ai-exec').innerHTML;
  assert(r.ap.run.stage === 'stopped' && r.ap.run.partial && ex.status === 'FAILED' && ex.steps[0].status === 'VERIFY_FAILED' && ex.steps[0].verification.checks.some(c => c.name === 'filterCond' && !c.ok)
    && !pane.includes('動作テスト環境への反映が完了しました。') && pane.includes('⚠ 1 件は一致しません') && !/Simulation|再解析/.test(pane) && /^一部だけ反映しました（要確認）。/.test(r.ap.card),
    `O4-o: 設定の読み戻しの不一致を完了と出さない: ${JSON.stringify({ status: ex.status, step: ex.steps[0].status, card: r.ap.card.split('\n')[0] })}`);
});
await section(async () => {
  // (p) JavaScript の読み戻し: 本文が違う・登録の順序が違う・PC ではなくモバイルに入った → VERIFY_FAILED。結果のカードは「反映しましたが、確認で一致しない点があります」
  const cases = [
    ['本文', (m) => { m.mock.ctl.corruptUploaded = true; }, 'sourceHash'],
    ['順序', (m) => { m.mock.ctl.mutateCustomize = (next) => { const js = next.desktop.js; js.unshift(js.pop()); return next; }; }, 'position'],
    ['PC／モバイル', (m) => { m.mock.ctl.mutateCustomize = (next) => { next.mobile.js.push(next.desktop.js.pop()); return next; }; }, 'platform'],
  ];
  for (const [label, ctl, check] of cases) {
    const r = await countedApply('js', { before: ({ m }) => ctl(m) });
    const ex = r.m.panel.jsExecState().execution;
    const fails = ((ex && ex.steps) || []).flatMap(s => ((s.verification && s.verification.checks) || []).filter(c => !c.ok).map(c => c.name));
    assert(r.ap.run.stage === 'done' && r.ap.run.ok === false && ex.status === 'VERIFY_FAILED' && fails.includes(check) && /^反映しましたが、確認で一致しない点があります（要確認）。/.test(r.ap.card) && !/^動作テスト環境へ反映しました。/.test(r.ap.card),
      `O4-p ${label}: JavaScript の読み戻しの不一致を完了と出さない（${check}）: ${JSON.stringify({ status: ex && ex.status, fails, card: r.ap.card.split('\n')[0] })}`);
  }
});
await section(async () => {
  // (q) 設定を書いた後に JavaScript のアップロードが失敗した → 一部反映。設定の記録（反映直後の設定）と元に戻す対象（書いた手順を逆順）は変わらない。カスタマイズは PUT していない
  const r = await countedApply('mixed', { before: ({ m }) => { m.mock.ctl.failUpload = 'GENERIC'; } });
  const st = r.m.panel.executorState();
  const rb = ((st.rollbackPlan && st.rollbackPlan.steps) || []).map(s => `${s.stepId}:${s.actionType}:${s.target || ''}`);
  assert(r.ap.run.stage === 'stopped' && r.ap.run.partial && JSON.stringify(r.ap.writes) === JSON.stringify(['POST fields', 'PUT views', 'POST file']) && r.m.panel.jsExecState().execution.previewUnchanged === true
    && JSON.stringify(rb) === JSON.stringify(['P2:RESTORE_VIEWS:承認待ち一覧', 'P1:DELETE_FIELD:approval_memo']) && st.execution.actualAfterRaw && st.execution.actualAfterRaw.fields.properties.approval_memo
    && r.ap.run.stop.text === 'JavaScript を登録できませんでした。' && /data-act="rollback"/.test(r.ap.cardHtml),
    `O4-q: 一部失敗の記録と元に戻す対象: ${JSON.stringify({ writes: r.ap.writes, rollback: rb, stop: r.ap.run.stop && r.ap.run.stop.text })}`);
});
await section(async () => {
  // (r) 設定だけ: 反映した後の判定は手順ごとの読み戻しだけ（照合・再解析の記録も表示も無い）。反映直後の設定は元に戻すときの基準として持つ
  const r = await countedApply('settings');
  const ex = r.m.panel.executorState().execution, pane = r.m.$('kt-ai-exec').innerHTML;
  assert(r.ap.run.ok && JSON.stringify(r.ap.writes) === JSON.stringify(['PUT views']) && JSON.stringify(r.reasons) === JSON.stringify(['execute', 'after-apply']) && !('simulation' in ex) && !('reanalysis' in ex)
    && ex.actualAfterRaw && ex.actualAfterRaw.views.views['承認待ち一覧'] && pane.includes('反映後の確認：✓ 1 件一致') && !/Simulation|再解析/.test(pane),
    `O4-r: 反映した後の照合・再解析を持たない: ${JSON.stringify({ keys: Object.keys(ex).sort(), reasons: r.reasons })}`);
});

await section(async () => {
  // (s) 設定を書く前に始まった作業の基準の取得（ほかの操作。ここでは［取り直す］を書き込みの直前に押した）が、書いた後まで続いた → 設定を書いた直後の取り直しは
  //     それに合流せず、終わるのを待ってから書いた後の設定を取る。JavaScript の登録の準備はその基準（新設のフィールドがある）で行い、書く前の基準を使わない
  //     （前は合流した書く前の基準で承認の基準を進め、登録の前の取り直しとの食い違いで承認を取り消して止めていた）
  const JX = T.KTJsExecutor, PE = T.KTPlanExecutor;
  const loads = []; let mref = null, release = null;
  const loader = K.loadDevBaseFromMock(() => mref.mock);
  const gen = K.screenGenerate({ field: 'approval_memo', targetFile: 'memoLock.js' });
  const m = K.mount({ health: K.HEALTH_V, planImpl: K.planImplOf(K.screenPlan('mixed')), generateImpl: gen.impl,
    extra: { loadDevBase: (a = {}) => { const rec = { reason: a.reason || null, base: null }; loads.push(rec); const p = loader(a).then((b) => { rec.base = b; return b; }); return a.reason === 'manual' ? new Promise((res) => { release = () => p.then(res); }) : p; } } });
  mref = m;
  await K.ticks();
  const v = await K.adoptOnScreen(m); await K.ticks(20);
  await K.waitUntil(() => !['base', 'running'].includes(m.panel.finalPrecheck().status) && m.panel.finalPrecheck().planId === v.planId, 80); await K.ticks(4);
  const origP = JX.prepare, origE = PE.executePreview; const regBases = [];
  JX.prepare = function (input, o) { if (!input.deferDependencies) regBases.push(m.panel.devBase()); return origP.call(this, input, o); };
  //   設定の反映が終わった後（設定を書いた直後の取り直しを始めた後）に、書く前に始まった取得を終わらせる
  PE.executePreview = async function (...a) { const r = await origE.apply(this, a); setTimeout(() => { if (release) release(); }, 0); return r; };
  try {
    const l0 = loads.length;
    const ap = await K.applyOnScreen(m, { before: ({ m: mm }) => { mm.mock.ctl.onWrite = (what) => { if (what === 'POST fields') mm.panel.refreshDevBase({ reason: 'manual' }); }; } });
    await K.ticks(30);
    const ls = loads.slice(l0), manual = ls.find(x => x.reason === 'manual'), aa = ls.find(x => x.reason === 'after-apply');
    const memo = (b) => !!(b && b.data && b.data.fields && b.data.fields.approval_memo);
    assert(ap.run.stage === 'done' && ap.run.ok && JSON.stringify(ap.writes) === JSON.stringify(['POST fields', 'PUT views', 'POST file', 'PUT customize']) && JSON.stringify(ls.map(x => x.reason)) === JSON.stringify(['execute', 'manual', 'after-apply', 'after-js-register'])
      && manual && !memo(manual.base) && aa && memo(aa.base) && regBases.length === 1 && regBases[0] === aa.base && !m.msgs().some(x => x.data && x.data.kind === 'approval-revoked'),
      `O4-s: 書く前に始まった取得に合流せず、書いた後の設定で登録の準備をする: ${JSON.stringify({ reasons: ls.map(x => x.reason), manualMemo: memo(manual && manual.base), afterApplyMemo: memo(aa && aa.base), reg: regBases.map(b => ({ memo: memo(b), afterApply: !!(aa && b === aa.base) })), stage: ap.run && ap.run.stage, stop: ap.run && ap.run.stop })}`);
  } finally { JX.prepare = origP; PE.executePreview = origE; m.mock.ctl.onWrite = null; }
});

await section(async () => {
  // (t) 設定を書いている途中（押してから 60 秒より後）に開発支援が見えて自動の取り直し（tab）が始まり、すぐ見えなくなって止まった（取れた段 = 書く前の設定が続きとして残る）
  //     → 設定を書いた後に作業の基準を古いとし、続きを捨てる。設定を書いた直後の取り直しは新しく取り、登録の準備はその基準（新設のフィールドがある）で行う
  //     画面の入口と同じく、止める条件（shouldContinue）と続き（resume）を KTDevBase.load へ渡す読み込みを使う（テストの補助の loadDevBaseFromMock は渡さない）
  const { makeEnvGetter } = require('./helpers/dev-base-fake.js');
  const prodGet = makeEnvGetter({ preview: {}, production: K.INPUTS.data }).getImpl;
  let mref = null, visible = true, fired = false;
  const loads = [];
  const loadDevBase = ({ reason = null, shouldContinue = null, resume = null } = {}) => {
    const rec = { reason, resumed: !!resume, base: null }; loads.push(rec);
    const api = mref.mock.api;
    const PREV = { 'app/form/fields': () => api.getPreviewFields('341'), 'app/form/layout': () => api.getPreviewLayout('341'), 'app/views': () => api.getPreviewViews('341'), 'app/status': () => api.getPreviewStatus('341'),
      'app/notifications/general': () => api.getPreviewGeneralNotifications('341'), 'app/notifications/perRecord': () => api.getPreviewPerRecordNotifications('341'), 'app/notifications/reminder': () => api.getPreviewReminders('341'),
      'app/actions': () => api.getPreviewActions('341'), 'app/customize': () => api.getPreviewCustomize('341') };
    const getImpl = async (p) => { const mm = /^\/k\/v1\/preview\/(.+)$/.exec(p); return mm && PREV[mm[1]] ? PREV[mm[1]]() : prodGet(p); };
    return T.KTDevBase.load({ appId: '341', getImpl, download: (fk) => api.downloadFile(fk), shouldContinue, resume, now: () => mref.clock.t }).then((b) => { rec.base = b; return b; });
  };
  const gen = K.screenGenerate({ field: 'approval_memo', targetFile: 'memoLock.js' });
  const m = K.mount({ health: K.HEALTH_V, planImpl: K.planImplOf(K.screenPlan('mixed')), generateImpl: gen.impl, extra: { loadDevBase, canAutoFetch: () => visible } });
  mref = m;
  await K.ticks();
  const v = await K.adoptOnScreen(m); await K.ticks(20);
  await K.waitUntil(() => !['base', 'running'].includes(m.panel.finalPrecheck().status) && m.panel.finalPrecheck().planId === v.planId, 80); await K.ticks(4);
  const JX = T.KTJsExecutor, origP = JX.prepare, regBases = [];
  JX.prepare = function (input, o) { if (!input.deferDependencies) regBases.push(m.panel.devBase()); return origP.call(this, input, o); };
  const memo = (b) => !!(b && b.data && b.data.fields && b.data.fields.approval_memo);
  try {
    const l0 = loads.length;
    const ap = await K.applyOnScreen(m, { before: ({ m: mm }) => { mm.mock.ctl.onWrite = (what) => { if (what === 'POST fields' && !fired) { fired = true; mm.clock.t += 61000; mm.panel.onVisible(); visible = false; } }; } });
    await K.ticks(30);
    const ls = loads.slice(l0), tab = ls.find(x => x.reason === 'tab'), aa = ls.find(x => x.reason === 'after-apply');
    assert(ap.run.stage === 'done' && ap.run.ok && JSON.stringify(ap.writes) === JSON.stringify(['POST fields', 'PUT views', 'POST file', 'PUT customize']) && JSON.stringify(ls.map(x => x.reason)) === JSON.stringify(['execute', 'tab', 'after-apply'])
      && tab && tab.base && tab.base.paused && aa && !aa.resumed && memo(aa.base) && regBases.length === 1 && regBases[0] === aa.base,
      `O4-t: 書いている途中に止めた取得の続き（書く前の設定）を、書いた直後の取り直しが使わない: ${JSON.stringify({ reasons: ls.map(x => `${x.reason}${x.resumed ? '(続き)' : ''}${x.base && x.base.paused ? '(止めた)' : ''}`), afterApplyMemo: memo(aa && aa.base), reg: regBases.map(memo), stage: ap.run && ap.run.stage, stop: ap.run && ap.run.stop })}`);
  } finally { JX.prepare = origP; m.mock.ctl.onWrite = null; }
});
await section(async () => {
  // (u) JavaScript だけ: 新設のフィールドを Toolkit が作れない種類（計算。手作業に回る）にし、自動で反映できる設定の手順を無くす → 承認の欄の準備に設定の部分が無く、
  //     押した直後の準備は「設定の反映の後に確かめる」依存を残したまま PREPARED。使い回さずに作り直した準備が DEPENDENCY_NOT_APPLIED で止める（無いフィールドに依存する JavaScript を登録しない）
  const base = K.screenPlan('mixed');
  const raw = (goal) => { const r = base(goal); return { ...r, plan: { ...r.plan, proposedFields: r.plan.proposedFields.map(f => ({ ...f, type: 'CALC' })), steps: r.plan.steps.filter(s => s.id !== 'P2').map(s => (s.id === 'P1' ? { ...s, spec: { ...s.spec, fieldType: 'CALC' } } : s)) } }; };
  const gen = K.screenGenerate({ field: 'approval_memo', targetFile: 'memoLock.js' });
  const m = K.mount({ health: K.HEALTH_V, planImpl: K.planImplOf(raw), generateImpl: gen.impl });
  await K.ticks();
  await K.adoptOnScreen(m); await K.ticks(20);
  const JX = T.KTJsExecutor, origP = JX.prepare, preps = [];
  JX.prepare = function (input, o) { const rec = { defer: !!input.deferDependencies }; preps.push(rec); return origP.call(this, input, o).then((p) => { rec.status = p.status; rec.deferred = (p.deferred || []).length; rec.blockers = (p.blockers || []).map(b => b.code); return p; }); };
  try {
    const ap = await K.applyOnScreen(m);
    await K.ticks(20);
    assert(ap.pre.status === 'ready' && ap.pre.settingsStatus === null && (ap.pre.items.deferred || []).length === 1 && ap.button && !ap.button.disabled
      && preps.length === 2 && preps[0].defer && preps[0].status === 'PREPARED' && preps[0].deferred === 1 && !preps[1].defer && preps[1].status === 'BLOCKED' && preps[1].blockers.includes('DEPENDENCY_NOT_APPLIED')
      && ap.run.stage === 'stopped' && !ap.writes.length && ap.run.stop.text === 'JavaScript の登録の準備で止まりました。' && /先に手順「承認メモフィールドを追加」を反映してください/.test(ap.card),
      `O4-u: 依存が残る準備は使い回さず、作り直した準備が止める（書き込み 0）: ${JSON.stringify({ pre: ap.pre && { status: ap.pre.status, deferred: ap.pre.items && ap.pre.items.deferred }, preps, stage: ap.run && ap.run.stage, writes: ap.writes, stop: ap.run && ap.run.stop })}`);
  } finally { JX.prepare = origP; }
});

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
