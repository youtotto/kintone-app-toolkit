// 反映・登録の書き込みと元に戻すことを会話へ知らせる時点と表示（2026-10-21。画面の流れ・偽の kintone・固定の応答。有料の AI は呼ばない）
//
// 検証内容: 会話（KTAiConversation）は反映・登録の状態を写さない。画面が書き終えたとき・戻し始めたとき・戻し終えたときに会話へ知らせる
//   §A1 標準設定を書き終えた直後（書いた後の取り直しの前）に、計画の版はもう「反映済み」（その間の発言を反映済みの版の見直しにしない）
//   §A2 JavaScript を登録し終えた直後（登録の後の読み直しの前）も同じ
//   §A3 今の会話の反映は、反映の記録の［詳細］で開いた後でも、結果のカードから戻すと元に戻すのカードを 1 枚出し、戻した結果もそこに出る（計画の版は「元に戻し済み」）
//   §A4 戻す準備で止まった（反映の後にほかの作業者が設定を変えた）ときも、今の会話の反映なら元に戻すのカードに出る
//   §A5 JavaScript の戻す確認を取り消して押し直しても、元に戻すのカードは 1 枚（書き込みなし）
//
// 実行方法: node tests/ai-apply-record.test.js（KT_SRC=<別ビルド> で別の版に対して走らせる）
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const T = loadToolkit();
const { KTAiConversation } = T;
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const { assert, state } = makeAssert();
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }
/** 会話のメッセージの種類（data.kind が無ければ type） */
const kinds = (m) => m.msgs().map(x => (x.data && x.data.kind) || x.type);
const clickExec = (m, id) => m.$('kt-ai-pane-exec').dispatch({ type: 'click', target: { id } });
const clickJs = (m, id) => m.$('kt-ai-pane-code').dispatch({ type: 'click', target: { id } });
/** 画面（作業の基準の読み込み・登録の後の読み直しを差し替える）: 台本の 4 発言 → 最終案 → 承認の欄の準備が終わるまで */
const mountWith = async (kind, extraOf) => {
  let mref = null;
  const loader = K.loadDevBaseFromMock(() => mref.mock);
  const gen = K.screenGenerate({ field: kind === 'js' ? 'case_name' : 'approval_memo', targetFile: kind === 'js' ? 'caseLock.js' : 'memoLock.js' });
  const m = K.mount({ health: K.HEALTH_V, planImpl: K.planImplOf(K.screenPlan(kind)), generateImpl: gen.impl, extra: extraOf(loader) });
  mref = m;
  await K.ticks();
  const v = await K.adoptOnScreen(m); await K.ticks(20);
  await K.waitUntil(() => m.panel.finalPrecheck().status === 'ready' && m.panel.finalPrecheck().planId === v.planId, 80); await K.ticks(4);
  return { m, v };
};

(async () => {
// =========================================================
console.log('\n--- §A1. 標準設定を書き終えた直後に、計画の版は反映済み ---');
await section(async () => {
  //   一覧の追加だけの最終案。書いた後の取り直し（after-apply）を止めておき、その間の計画の版と発言の分類を見る
  const g = K.gate(); let held = false;
  const { m, v } = await mountWith('settings', (loader) => ({ loadDevBase: (a = {}) => (a.reason === 'after-apply' ? (held = true, g.p.then(() => loader(a))) : loader(a)) }));
  const p = K.clickChat(m, 'final-approve', { plan: v.planId, version: String(v.version) });
  await K.waitUntil(() => held, 300);
  const during = { status: v.status, executionId: v.executionId || null, written: !!m.mock.st.views['承認待ち一覧'], intent: KTAiConversation.classifyIntent('通知はいらない', m.conv().state).intent };
  g.open(); await p; await K.ticks(20);
  assert(held && during.written && during.status === 'EXECUTED' && !!during.executionId && during.intent !== 'REVISE_PLAN' && m.panel.finalRun().stage === 'done' && v.status === 'EXECUTED',
    `A1: 書いた後の取り直しの間も計画の版は反映済み（その間の発言を反映済みの版の見直しにしない）: ${JSON.stringify(during)}`);
});

// =========================================================
console.log('\n--- §A2. JavaScript を登録し終えた直後に、計画の版は反映済み ---');
await section(async () => {
  //   JavaScript だけの最終案。登録の後の読み直し（rescanJs）を止めておき、その間の計画の版を見る
  const g = K.gate(); let armed = false, held = false;
  const { m, v } = await mountWith('js', (loader) => ({ loadDevBase: loader, rescanJs: () => (armed ? (held = true, g.p) : Promise.resolve()) }));
  armed = true;
  const p = K.clickChat(m, 'final-approve', { plan: v.planId, version: String(v.version) });
  await K.waitUntil(() => held, 300);
  const during = { status: v.status, jsExecutionId: v.jsExecutionId || null, put: m.mock.calls.includes('PUT customize') };
  g.open(); await p; await K.ticks(20);
  assert(held && during.put && during.status === 'EXECUTED' && !!during.jsExecutionId && m.panel.finalRun().stage === 'done',
    `A2: 登録の後の読み直しの間も計画の版は反映済み: ${JSON.stringify(during)}`);
});

// =========================================================
console.log('\n--- §A3. 今の会話の反映を記録の［詳細］で開いた後に、結果のカードから戻す ---');
await section(async () => {
  const { m, v } = await K.mountFinal({ kind: 'settings' });
  const r = await K.applyOnScreen(m);
  const exId = m.panel.executorState().execution.executionId;
  await m.$('kt-ai-header').dispatch({ type: 'click', target: { dataset: { act: 'open-log' } } });
  const logId = (/data-log="([^"]+)"/.exec(m.$('kt-ai-apply-log').innerHTML) || [])[1] || null;
  await m.$('kt-ai-pane-log').dispatch({ type: 'click', target: { dataset: { act: 'log-open', log: logId } } }); await K.ticks(4);
  const n0 = m.msgs().length;
  await K.clickChat(m, 'rollback', { execution: exId }); await K.ticks(8);
  const confirming = { stage: m.panel.executorState().stage, guide: /確認画面で「変更前の状態に戻す」を押すと戻します/.test(K.stripC(m.chat())) };
  await clickExec(m, 'kt-ai-exec-rollback-go'); await K.ticks(8);
  const chat = K.stripC(m.chat());
  assert(r.run && r.run.ok && logId && confirming.stage === 'rollback-confirm' && confirming.guide && m.panel.executorState().stage === 'rolled-back'
    && kinds(m).slice(n0).filter(k => k === 'ROLLBACK').length === 1 && !kinds(m).slice(n0).includes('apply-log-rolled-back') && /変更前の状態へ戻しました。/.test(chat) && !/反映の記録から開いた反映/.test(chat) && v.status === 'ROLLED_BACK',
    `A3: 記録で開いた後でも、今の会話の反映は元に戻すのカード 1 枚に確認と結果を出す（計画の版は元に戻し済み）: ${JSON.stringify({ confirming, added: kinds(m).slice(n0), status: v.status })}`);
});

// =========================================================
console.log('\n--- §A4. 戻す準備で止まったときも、元に戻すのカードに出る ---');
await section(async () => {
  const { m, v } = await K.mountFinal({ kind: 'settings' });
  await K.applyOnScreen(m);
  const exId = m.panel.executorState().execution.executionId;
  const w0 = K.writesOf(m).length;
  //   反映の後に、ほかの作業者が同じ一覧の絞り込みを変えた → 戻す準備は現在の設定との照合で止まる（書き込みなし）
  m.mock.st.views['承認待ち一覧'].filterCond = 'case_name like "別の作業者"'; m.mock.st.revision += 1;
  await K.clickChat(m, 'rollback', { execution: exId }); await K.ticks(8);
  const chat = K.stripC(m.chat());
  assert(m.panel.executorState().stage === 'rollback-blocked' && m.msgs().filter(x => x.type === 'ROLLBACK').length === 1 && /自動では元に戻せません。/.test(chat) && K.writesOf(m).length === w0 && v.status === 'EXECUTED',
    `A4: 戻す準備で止まったことを元に戻すのカードに出す（書き込みなし・計画の版は反映済みのまま）: ${JSON.stringify({ stage: m.panel.executorState().stage, cards: m.msgs().filter(x => x.type === 'ROLLBACK').length, status: v.status })}`);
});

// =========================================================
console.log('\n--- §A5. JavaScript の戻す確認を取り消して押し直す ---');
await section(async () => {
  const { m } = await K.mountFinal({ kind: 'js' });
  await K.applyOnScreen(m);
  const exId = m.panel.jsExecState().execution.executionId;
  const w0 = K.writesOf(m).length;
  await K.clickChat(m, 'js-rollback', { execution: exId }); await K.ticks(6);
  const first = m.panel.jsExecState().stage;
  await clickJs(m, 'kt-ai-jsreg-rollback-cancel'); await K.ticks(2);
  const cancelled = m.panel.jsExecState().stage;
  await K.clickChat(m, 'js-rollback', { execution: exId }); await K.ticks(6);
  assert(first === 'rollback-confirm' && cancelled === 'done' && m.panel.jsExecState().stage === 'rollback-confirm' && m.msgs().filter(x => x.type === 'JS_ROLLBACK').length === 1 && K.writesOf(m).length === w0,
    `A5: 取り消して押し直しても、元に戻すのカードは 1 枚（書き込みなし）: ${JSON.stringify({ first, cancelled, now: m.panel.jsExecState().stage, cards: m.msgs().filter(x => x.type === 'JS_ROLLBACK').length })}`);
});

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
