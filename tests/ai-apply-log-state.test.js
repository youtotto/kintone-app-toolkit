// 反映の記録が反映・登録の状態を持つ（2026-10-23・評価の記録 §12.60。画面の流れ・偽の kintone・固定の応答。有料の AI は呼ばない）
//
// 検証内容: 右上の反映・登録の状態（execState / jsExec）は反映・登録ごとに新しい入れ物で、反映を始めた記録（applyLog）がその入れ物をそのまま持つ。
//   描くたびの記録への写し（syncApplyLog）と、記録を開くときの右上への逆写しは無い。
//   §R1 現在の最終案と過去の反映の記録を切り替えても、現在の承認・反映の状態（承認の記録・結果・右上の設定の反映）は変わらない
//   §R2 描き直しだけでは、記録・右上の状態・今の判定が書き換わらない
//   §R3 一部失敗: 成功・失敗・未実施の件数が、結果のカード・右の「反映」・反映の記録・見出しの状態で一致する
//   §R4 過去の記録を開いて戻す準備をしても、別の反映の復元対象と混ざらない。戻せなかった確認（rollback-blocked）は別の記録へ移って戻っても理由が残る
//   §R5 復元を実行する前の確認（rollback-confirm）のまま別の最終案の反映へ移ると、その確認だけ取り消す（書き込み・復元なし。結果と snapshot はそのまま）。
//       開き直しても放置した確認は出ず、改めて確認を始められる。戻した結果・戻せなかった確認は触らない
//
// 実行方法: node tests/ai-apply-log-state.test.js（KT_SRC=<別ビルド> で別の版に対して走らせる）
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const T = loadToolkit();
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const VM = T.KTAiWorkspaceViewModel;
const { assert, state } = makeAssert();
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }
/** 反映の記録の行（id・状態の語・JavaScript の登録か） */
const logRows = (m) => [...m.$('kt-ai-apply-log').innerHTML.matchAll(/<li class="kt-ai-apply-log-item" data-log="([^"]+)"[\s\S]*?font-weight:600;">([^<]+)<\/span>[\s\S]*?<\/li>/g)].map(x => ({ id: x[1], label: x[2], js: /JavaScript の登録/.test(x[0]) }));
const openLog = async (m, id) => { await m.$('kt-ai-pane-log').dispatch({ type: 'click', target: { dataset: { act: 'log-open', log: id } } }); await K.ticks(4); };
const exIdOf = (st) => (st && st.execution && st.execution.executionId) || null;
/** 1 つのページで、JavaScript だけの最終案（A）を登録 → 新しい会話 → 設定だけの最終案（B）を反映（記録 2 件。右上の設定は B、登録は A のまま） */
async function twoRecords() {
  const kinds = ['js', 'settings']; let i = 0;
  const gen = K.screenGenerate({ field: 'case_name', targetFile: 'caseLock.js' });
  const m = K.mount({ health: K.HEALTH_V, planImpl: (a) => K.planImplOf(K.screenPlan(kinds[Math.min(i++, kinds.length - 1)]))(a), generateImpl: gen.impl });
  await K.ticks();
  const vA = await K.adoptOnScreen(m); await K.ticks(20);
  const rA = await K.applyOnScreen(m);
  const exA = exIdOf(m.panel.jsExecState());   // 新しい会話にすると右上の登録は新しい入れ物になるので、ここで控える
  await m.$('kt-ai-new-conv').dispatch('click'); await K.ticks();
  const vB = await K.adoptOnScreen(m); await K.ticks(20);
  const rB = await K.applyOnScreen(m);
  const rows = logRows(m);
  return { m, vA, vB, rA, rB, idA: rows.find(x => x.js).id, idB: rows.find(x => !x.js).id, exA, exB: exIdOf(m.panel.executorState()) };
}
const snapshotOf = (m, v) => JSON.stringify({ approval: v.approval || null, status: v.status, run: m.panel.finalRun(), exec: m.panel.executorState(), js: m.panel.jsExecState(), log: m.$('kt-ai-apply-log').innerHTML, readiness: m.conv().finalReadiness(v) });
/** 今の最終案の承認・結果・右上の設定の反映・今の判定（過去の記録の表示で変わってよい登録の表示・記録の一覧は含めない） */
const currentOf = (m, v) => JSON.stringify({ approval: v.approval || null, status: v.status, run: m.panel.finalRun(), exec: m.panel.executorState(), readiness: m.conv().finalReadiness(v) });

(async () => {
// =========================================================
console.log('\n--- §R1. 現在の最終案と過去の記録を切り替えても、現在の承認・反映の状態は変わらない ---');
await section(async () => {
  const { m, vA, vB, rA, rB, idA, idB, exA, exB } = await twoRecords();
  assert(rA.run && rA.run.ok && rB.run && rB.run.ok && vA.status === 'EXECUTED' && vB.status === 'EXECUTED' && exA && exB && logRows(m).length === 2, `前提: JavaScript の登録（A）と設定の反映（B）が終わり、記録は 2 件: ${JSON.stringify({ a: rA.writes, b: rB.writes, rows: logRows(m) })}`);
  const before = currentOf(m, vB);
  //   過去の記録 A（前の会話の JavaScript の登録）を開く → 右上の登録は A を指す。今の最終案 B の承認・結果・右上の設定の反映は変わらない
  await openLog(m, idA);
  const afterOpenA = { jsEx: exIdOf(m.panel.jsExecState()), exec: exIdOf(m.panel.executorState()), note: /反映の記録から開いた JavaScript の登録です（前の会話・/.test(m.$('kt-ai-jsreg').innerHTML) };
  assert(afterOpenA.jsEx === exA && afterOpenA.exec === exB && currentOf(m, vB) === before && !!vB.approval && m.panel.finalRun().stage === 'done',
    `R1-1: 過去の記録を開いても、今の最終案の承認・結果・右上の設定の反映は変わらない: ${JSON.stringify(afterOpenA)}`);
  //   記録 B（今の反映）を開き直しても同じ入れ物（状態は変わらない）
  await openLog(m, idB);
  assert(exIdOf(m.panel.executorState()) === exB && m.panel.executorState().stage === 'done' && currentOf(m, vB) === before, 'R1-2: 今の反映の記録を開き直しても、右上の設定の反映・承認・結果は同じ');
});

// =========================================================
console.log('\n--- §R2. 描き直しだけでは、記録・右上の状態・今の判定が書き換わらない ---');
await section(async () => {
  const { m, vB } = await twoRecords();
  const before = snapshotOf(m, vB);
  const e0 = m.panel.executorState(), j0 = m.panel.jsExecState();
  for (let i = 0; i < 3; i++) { m.conv().notice('（テスト）描き直し', { kind: 'test-redraw' }); await K.ticks(2); }
  await m.$('kt-ai-header').dispatch({ type: 'click', target: { dataset: { act: 'open-log' } } }); await K.ticks(2);
  const after = snapshotOf(m, vB);
  assert(after === before && m.panel.executorState() === e0 && m.panel.jsExecState() === j0, `R2: 描き直し・記録の表示だけでは、記録・右上の状態（同じ入れ物のまま）・承認・結果・今の判定は変わらない`);
});

// =========================================================
console.log('\n--- §R3. 一部失敗の件数は、結果のカード・右の「反映」・記録・見出しで一致する ---');
await section(async () => {
  //   設定と JavaScript の最終案（P1 フィールドの追加・P2 一覧の追加・C1 は P1 に依存）。P2 の書き込みを失敗させる → P1 だけ反映・P2 失敗・JavaScript は登録しない
  const gen = K.screenGenerate({ field: 'approval_memo', targetFile: 'memoLock.js' });
  const m = K.mount({ health: K.HEALTH_V, planImpl: K.planImplOf(K.screenPlan('mixed')), generateImpl: gen.impl });
  await K.ticks();
  const v = await K.adoptOnScreen(m); await K.ticks(20);
  m.mock.ctl.failPut = 'views';
  const r = await K.applyOnScreen(m);
  const s = r.run && r.run.settings;
  const rec = VM.executionSummary(m.panel.executorState());
  const right = (m.$('kt-ai-exec').innerHTML.match(/<b>([^<]*反映済み[^<]*)<\/b>/) || [])[1] || '';
  const row = logRows(m)[0];
  assert(r.run && r.run.stage === 'stopped' && r.run.partial === true && s && s.verified === 1 && s.failed === 1 && rec && rec.verified === 1 && rec.failed === 1 && rec.warn === 0 && rec.status !== 'DONE'
    && /^一部だけ反映しました（要確認）。/.test(r.card) && /標準設定: ✓ 1 件反映・× 1 件は失敗（以降は未実行）/.test(r.card) && /JavaScript: 未登録（設定の手順が途中で止まったため、登録していません）/.test(r.card)
    && right === '1 件反映済み・1 件失敗・以降未実行（0 件）' && row && row.label === '一部だけ反映（要確認）' && /data-status="partial">一部反映（要確認）/.test(m.$('kt-ai-ws-state').innerHTML) && !m.mock.calls.includes('PUT customize') && v.status === 'EXECUTED',
    `R3: 一部失敗の件数と状態が、結果のカード・右の「反映」・記録・見出しで一致する（JavaScript は登録しない）: ${JSON.stringify({ run: r.run && { stage: r.run.stage, partial: r.run.partial, settings: s }, rec, right, row, card: (r.card || '').split('\n').slice(0, 3) })}`);
});

// =========================================================
console.log('\n--- §R4. 過去の記録の復元は別の反映と混ざらない。戻せなかった確認は理由が残る ---');
await section(async () => {
  const { m, vB, idA, idB, exA, exB } = await twoRecords();
  //   過去の記録 A（JavaScript の登録）を開いて戻す準備 → 復元の対象は A。今の反映 B（設定）の右上は触らない
  await openLog(m, idA);
  const rbA = await m.panel.startJsRollback();
  const execB = m.panel.executorState();
  assert(rbA && rbA.status === 'PREPARED' && rbA.executionId === exA && exIdOf(execB) === exB && execB.stage === 'done' && !execB.rollback && m.panel.jsExecState().stage === 'rollback-confirm',
    `R4-1: 過去の記録の戻す準備は、その記録の反映（A）だけを対象にし、今の反映（B）の状態は変わらない: ${JSON.stringify({ rb: rbA && { status: rbA.status, executionId: rbA.executionId }, execB: { ex: exIdOf(execB), stage: execB.stage } })}`);
  m.panel.cancelJsRollback(); await K.ticks(2);
  //   今の反映 B の戻す準備が止まる（反映の後にほかの作業者が同じ一覧を変えた）→ 別の記録 A を開いて B に戻っても、止まった理由は残る（前は開き直すと「反映済み」に戻していた）
  m.mock.st.views['承認待ち一覧'].filterCond = 'case_name like "別の作業者"'; m.mock.st.revision += 1;
  const w0 = K.writesOf(m).length;
  const rbB = await m.panel.startRollback();
  const blocked0 = /自動では元に戻せません/.test(m.$('kt-ai-exec').innerHTML);
  await openLog(m, idA);
  await openLog(m, idB);
  const stB = m.panel.executorState();
  assert(rbB && rbB.status === 'BLOCKED' && blocked0 && stB.stage === 'rollback-blocked' && exIdOf(stB) === exB && /自動では元に戻せません/.test(m.$('kt-ai-exec').innerHTML) && logRows(m).find(x => x.id === idB).label === '反映済み（未復元）' && K.writesOf(m).length === w0 && !!vB.approval,
    `R4-2: 戻せなかった確認は、別の記録へ移って戻っても理由が残る（書き込み 0・承認はそのまま）: ${JSON.stringify({ rb: rbB && rbB.status, stage: stB.stage, ex: exIdOf(stB), blockedNow: /自動では元に戻せません/.test(m.$('kt-ai-exec').innerHTML) })}`);
  //   確認を取り消すと「反映済み」に戻り、もう一度戻す確認へ進める（復元の経路はそのまま）
  m.panel.cancelRollback(); await K.ticks(2);
  assert(m.panel.executorState().stage === 'done' && exIdOf(m.panel.executorState()) === exB, 'R4-3: 戻せなかった確認を取り消すと反映済みに戻る（復元の経路は変えていない）');
});

// =========================================================
console.log('\n--- §R5. 復元の確認のまま別の最終案へ移ると、その確認だけ取り消す ---');
await section(async () => {
  //   同じ会話で、設定だけの最終案 A（一覧の追加）を反映 → A の戻す確認を開いたまま → 別の最終案 B（フィールドの追加）を反映
  let n = 0;
  const planB = (goal) => { const b = K.PLAN_V1(goal), mixed = K.screenPlan('mixed')(goal); return { ...b, plan: { ...b.plan, proposedFields: mixed.plan.proposedFields, steps: [mixed.plan.steps[0]] } }; };
  const m = K.mount({ health: K.HEALTH_V, planImpl: (a) => (n++ === 0 ? K.planImplOf(K.screenPlan('settings')) : K.planImplOf(planB))(a) });
  await K.ticks();
  const vA = await K.adoptOnScreen(m); await K.ticks(20);
  const rA = await K.applyOnScreen(m);
  const stA = m.panel.executorState(), exA = exIdOf(stA);
  const rbA0 = await m.panel.startRollback();
  const keepOf = (st) => JSON.stringify({ execution: st.execution, prepared: st.prepared, rollbackPlan: st.rollbackPlan });
  const beforeA = keepOf(stA);
  const w0 = K.writesOf(m).length, viewBefore = JSON.stringify(m.mock.st.views['承認待ち一覧']);
  assert(rA.run && rA.run.ok && rbA0 && rbA0.status === 'PREPARED' && stA.stage === 'rollback-confirm' && !!stA.rollback, `前提: A を反映し、戻す確認を開いたまま: ${JSON.stringify({ run: rA.run && rA.run.ok, rb: rbA0 && rbA0.status, stage: stA.stage })}`);
  const vB = await K.adoptOnScreen(m); await K.ticks(20);
  const rB = await K.applyOnScreen(m);
  const stB = m.panel.executorState(), exB = exIdOf(stB);
  //   1. B の反映へ移ると A の未実行の確認は取り消される。5. 取り消しだけでは書き込み・復元は起きない（書き込みは B の分だけ。A の一覧は残る）。結果と snapshot はそのまま
  assert(vB && vB.planId !== vA.planId && rB.run && rB.run.ok && exB && exB !== exA && stA.stage === 'done' && !stA.rollback && keepOf(stA) === beforeA
    && JSON.stringify(m.mock.st.views['承認待ち一覧']) === viewBefore && !K.writesOf(m).slice(w0).some(w => /views/.test(w)) && logRows(m).length === 2 && /変更前の状態に戻す確認を取り消しました。/.test(K.stripC(m.chat())),
    `R5-1: 別の最終案 B の反映へ移ると、A の復元の確認だけ取り消される（結果・snapshot はそのまま。書き込みは B の分だけ・復元なし。元に戻すのカードは取り消しの 1 文）: ${JSON.stringify({ planB: !!vB && vB.planId !== vA.planId, runB: !!(rB.run && rB.run.ok), stageA: stA.stage, rollbackA: !!stA.rollback, same: keepOf(stA) === beforeA, writes: K.writesOf(m).slice(w0) })}`);
  //   2. A を開き直しても放置した確認は出ず、元の反映の結果が出る。3. A の復元対象と B の実行の状態は混ざらない。4. A で改めて復元の確認を始められる
  const idA = logRows(m).map(x => x.id).find(id => id !== logRows(m)[0].id);
  await openLog(m, idA);
  const exec = m.$('kt-ai-exec').innerHTML;
  const reopened = { ex: exIdOf(m.panel.executorState()), stage: m.panel.executorState().stage, confirmShown: /id="kt-ai-exec-rollback-go"/.test(exec), resultShown: /id="kt-ai-exec-result"/.test(exec) && /1 件一致/.test(exec) };
  const w1 = K.writesOf(m).length;
  const rbA = await m.panel.startRollback();
  assert(reopened.ex === exA && reopened.stage === 'done' && !reopened.confirmShown && reopened.resultShown && rbA && rbA.status === 'PREPARED' && rbA.executionId === exA && stB.stage === 'done' && exIdOf(stB) === exB && !stB.rollback && K.writesOf(m).length === w1,
    `R5-2: A を開き直すと元の結果だけが出て（放置した確認は出ない）、改めて戻す確認を始められる。B の状態は変わらない: ${JSON.stringify({ reopened, rb: rbA && { status: rbA.status, executionId: rbA.executionId }, stageB: stB.stage })}`);
  m.panel.cancelRollback(); await K.ticks(2);
  //   6. 戻した結果は触らない: A を戻し終えてから新しい会話にしても「元に戻し済み」のまま
  await m.panel.startRollback(); await K.ticks(2);
  await m.$('kt-ai-pane-exec').dispatch({ type: 'click', target: { id: 'kt-ai-exec-rollback-go' } }); await K.ticks(8);
  const rolled = m.panel.executorState().stage;
  await m.$('kt-ai-new-conv').dispatch('click'); await K.ticks(4);
  const rowA = logRows(m).find(x => x.id === idA);
  assert(rolled === 'rolled-back' && stA.stage === 'rolled-back' && stA.rollback && stA.rollback.status === 'ROLLED_BACK_VERIFIED' && rowA && rowA.label === '元に戻し済み' && !m.mock.st.views['承認待ち一覧'],
    `R5-3: 戻した結果（元に戻し済み）は、新しい会話にしても変わらない: ${JSON.stringify({ rolled, stageA: stA.stage, row: rowA })}`);
});

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
