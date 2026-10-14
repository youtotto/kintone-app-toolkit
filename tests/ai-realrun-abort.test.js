// 実機確認（2026-10-09）で見つかった生成停止の回帰（設計 §0f.3 の 1〜3・利用者の指示 §5 の表の 4〜5 行目の Toolkit 側。有料の AI は使わない）
//
// 検証内容:
//   §T0 停止の種類（KTAiConversation.stopKindOf。1 か所）と終了不明の印・本文が JSON でない応答の印（KTAiClient の settle）
//   §T1 C1 と C2 の計画で C1 の生成が TIMEOUT・TRANSPORT_ERROR・UPSTREAM_ERROR detail timeout → C2 の生成・自動の見直し・受け付けた発言の計画の送信が 0 件、
//        計画の AI は増えない・質問は増えない・最終案は未完成（承認できない）で［残りの JavaScript を作る］1 つ。押すと計画の AI 0 回で残りだけ生成する。
//        止めた送信で受け付けた指示は、未完成の最終案と［残りの JavaScript を作る］で作った最終案のカード・承認の欄の確認項目に「まだ計画に入っていません」と
//        ［受け付けた指示を計画に入れる］（レビューの指摘 row4。T1-7b・T1-10b・T1-10c・T1-11）
//   §T2 利用者のキャンセル（生成中）: 同じく後続 0 件・未完成の最終案・知らせに「採用します」を戻さない・続きは［残りの JavaScript を作る］
//   §T3 C1 が検証済みで C2 が時間切れ → ［残りの JavaScript を作る］は C1 を流用して C2 だけ作る
//   §T4 遅れた結果: 中断を無視して後から返った結果は使わない（最新の案を上書きしない）。services の偽物と、実際の client（transport が中断を無視する）の両方。
//        中断できない待ち（customizeRevision）の間に別の送信が始まったら、前の送信の結果で最新の案を変えない（送信ごとの印 sendSeq の分岐。T4-4）
//   §T5 計画の自動の見直しの時間切れ: 生成 0 件・未完成の最終案（作っていない JavaScript）。自動の見直しの失敗の［再試行］は内部の依頼文を利用者の発言として送らない。
//        止まった送信の後（自動の見直し・生成の halt の後）に届いた作業中の質問は始めない（T5-7・T5-8）
//   §T6 予算・回数の上限で止めた: ［残りの JavaScript を作る］は無効で理由を出す
//   §T7 期限: health の deadlineMs ＋ 受信の余裕 20 秒（上限 330 秒）・無ければ 240 秒・timeoutMs だけの互換・AUTH_TOKEN_EXPIRED の再試行は残り時間だけ・
//        逐次配信が上限を越えて届き続けても TIMEOUT（絶対時間）・transport の時刻（相対 ms。本文なし）
//   §T8 画面: health の limits の期限を client の呼び出しに渡す（生成の要求も。打ち切り＝deadlineMs ＋ 20 秒。T8-1b）・［キャンセル］は作業中の質問も止める
//   §T9 作業中の質問（askNow・askAside）の中断: 送信の取り消し・［キャンセル］（cancelAsides）で signal が abort される・止めた後の答えは出さない・止まった送信では新しい質問を受け付けない
//   §T10 呼び出しの記録: end（ok / error / unknown）・requestId（取れた場合だけ）・transport の時刻
//
// 実行方法: node tests/ai-realrun-abort.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const T = loadToolkit();
const { KTAiConversation, KTAiClient, KTContext } = T;
const { assert, state } = makeAssert();
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const FX = require('./fixtures/ai-context-app.js');
const { clone, makeConvC, makeGenerate, stripC, finalHtml } = K;
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const I = KTAiConversation.INTENT;

// ---- 部品: C1・C2 の 2 つの JavaScript の計画（どちらも承認待ちの金額の編集不可。偽の生成工程の good で検証済みになる）----
const CUST1 = K.custOf(['lock']);
const CUST2 = K.custOf(['lock'], { customizationId: 'C2', requirement: '承認待ちでは金額を編集不可にする（2 つ目の画面）' });
const planJs2 = (args) => {
  const r = K.planJs(args, { cust: CUST1 });
  r.plan.steps.push({ id: 'C2', actionType: 'CUSTOMIZATION_REQUIRED', targetKind: 'JS', targetRef: null, title: 'JavaScript 2', spec: { customizationId: 'C2' }, dependsOn: [] });
  r.plan.customizations.push(clone(CUST2));
  r.review.steps.push({ stepId: 'C2', status: 'VALID', safety: 'PLAN_ONLY', customization: clone(CUST2), codeGeneration: { supported: true, strategy: 'NEW_JS_FILE', reason: null }, issues: [] });
  r.review.executionReadiness.planOnlySteps.push('C2');
  return r;
};
const aiErr = (code, o = {}) => new KTAiClient.AiClientError({ code, message: o.message || `テスト: ${code}`, ...(o.details ? { details: o.details } : {}), ...(o.requestId ? { requestId: o.requestId } : {}) });
const UPSTREAM_TIMEOUT = () => aiErr('UPSTREAM_ERROR', { details: { ok: false, error: { code: 'UPSTREAM_ERROR', message: 'AI プロバイダが時間内に応答しませんでした', detail: 'timeout' } } });
/**
 * 偽の生成工程（cid ごとの振る舞い）。plan = { C1: [ 'throw:TIMEOUT', 'good' ], ... }（呼び出しの順に使う。尽きたら最後）。
 *   'throw:<code>' = その code の AiClientError を投げる / 'upstream-timeout' = Gateway の期限 / 'gate' = gates[cid] が開くまで待つ（signal の abort で CANCELLED）/
 *   'gate-ignore' = 中断を無視して gates[cid] が開くまで待ち、検証済みの結果を返す
 */
function stagedGenerate(plan, { gates = {}, onCall = null } = {}) {
  const base = makeGenerate({ sequence: ['good'] });
  const seen = [], n = {};
  const impl = async (args) => {
    const cid = args.customizationId;
    n[cid] = (n[cid] || 0) + 1;
    const list = plan[cid] || ['good'];
    const what = list[Math.min(n[cid] - 1, list.length - 1)];
    seen.push({ cid, what, signal: args.signal || null });
    if (onCall) onCall({ cid, what, args });
    if (what === 'upstream-timeout') throw UPSTREAM_TIMEOUT();
    if (/^throw:/.test(what)) throw aiErr(what.slice(6));
    if (what === 'gate') {
      await new Promise((resolve, reject) => {
        const g = gates[cid];
        if (args.signal) { if (args.signal.aborted) return reject(aiErr('CANCELLED')); args.signal.addEventListener('abort', () => reject(aiErr('CANCELLED')), { once: true }); }
        g.p.then(resolve);
      });
    }
    if (what === 'gate-ignore') await gates[cid].p;
    return base.impl(args);
  };
  return { impl, calls: base.calls, seen, count: (cid) => seen.filter(x => x.cid === cid).length };
}
const sendUntilAdopt = async (x, { signal = null } = {}) => { for (const s of K.REQUESTS.slice(0, 3)) await x.c.send(s); return x.c.send(K.REQUESTS[3], signal ? { signal } : {}); };
const pressRest = (x) => x.c.send('コードを作って', { intentOverride: I.GENERATE_CODE, displayText: '残りの JavaScript を作る' });
const visibleText = (h) => stripC(String(h).replace(/<details[\s\S]*?<\/details>/g, ''));
const restButtonOf = (h) => { const m = /<button[^>]*data-act="choice"[^>]*data-intent="GENERATE_CODE"[^>]*>([^<]*)<\/button>/.exec(h) || /<button[^>]*data-act="choice"[^>]*>残りの JavaScript を作る<\/button>/.exec(h); return m ? { html: m[0], label: m[1] || '残りの JavaScript を作る', disabled: /\sdisabled/.test(m[0]) } : null; };

(async () => {
// =========================================================
console.log('\n--- §T0. 停止の種類（stopKindOf）と終了不明 ---');
await section(async () => {
  const S = KTAiConversation.stopKindOf;
  const rows = [
    [aiErr('TIMEOUT'), 'timeout'], [aiErr('CANCELLED'), 'cancelled'], [Object.assign(new Error('x'), { name: 'AbortError' }), 'cancelled'],
    [aiErr('TRANSPORT_ERROR'), 'disconnected'], [UPSTREAM_TIMEOUT(), 'timeout'],
    [aiErr('UPSTREAM_ERROR', { details: { error: { code: 'UPSTREAM_ERROR', detail: { upstreamStatus: 500 } } } }), null], [aiErr('UPSTREAM_ERROR'), null],
    [aiErr('UPSTREAM_ERROR', { details: { error: { code: 'UPSTREAM_ERROR', detail: { reason: 'aborted' } } } }), 'disconnected'],
    [aiErr('INVALID_RESPONSE', { details: { bodyNotJson: true } }), 'disconnected'], [aiErr('INVALID_RESPONSE', { details: { errors: [] } }), null],
    [aiErr('BUDGET_EXCEEDED'), 'budget'], [aiErr('MONTHLY_LIMIT_EXCEEDED'), 'budget'], [aiErr('RATE_LIMITED'), 'rate'],
    [aiErr('AUTH_TOKEN_EXPIRED'), 'auth'], [aiErr('AUTH_INVALID_TOKEN'), 'auth'], [aiErr('SESSION_EXPIRED'), 'auth'],
    [aiErr('GENERATION_DECLINED'), null], [aiErr('MODEL_OUTPUT_INVALID'), null], [aiErr('INTERNAL_ERROR'), null], [null, null], [{ code: 'REPEAT_SAME_INPUT' }, null],
  ];
  const bad = rows.filter(([e, k]) => S(e) !== k).map(([e, k]) => `${e && e.code}→${S(e)}（期待 ${k}）`);
  assert(!bad.length, `T0-1: 停止の種類の表（取り消し・時間切れ・切断・上限・認証だけを止める。JS ごとの失敗は null）: ${bad.join(' / ') || 'すべて一致'}`);
  assert(['cancelled', 'timeout', 'disconnected'].every(KTAiConversation.stopEndUnknown) && !['budget', 'rate', 'auth', null].some(KTAiConversation.stopEndUnknown) && KTAiConversation.callEndOf(aiErr('TIMEOUT')) === 'unknown' && KTAiConversation.callEndOf(aiErr('RATE_LIMITED')) === 'error', 'T0-2: 終了不明は取り消し・時間切れ・切断だけ（呼び出しの記録の end は unknown）。上限・認証は error');
  let nj = null;
  try { await KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: async () => ({ status: 502, body: '<html>bad gateway</html>' }) }).ask({ ctx: { contextVersion: '1', facts: [] } }); } catch (e) { nj = e; }
  assert(nj && nj.code === 'INVALID_RESPONSE' && nj.details && nj.details.bodyNotJson === true && KTAiConversation.stopKindOf(nj) === 'disconnected', `T0-3: 本文が JSON でない応答（端の 5xx の HTML）は INVALID_RESPONSE に印を付け、通信の切断として止める: ${nj && nj.code}`);
});

// =========================================================
console.log('\n--- §T1. C1 の生成が時間切れ・切断・Gateway の期限 → C2・自動の見直し・取り込みは 0 件、未完成の最終案と［残りの JavaScript を作る］ ---');
for (const [label, what, kind] of [['TIMEOUT', 'throw:TIMEOUT', 'timeout'], ['TRANSPORT_ERROR', 'throw:TRANSPORT_ERROR', 'disconnected'], ['UPSTREAM_ERROR detail timeout', 'upstream-timeout', 'timeout']]) {
  await section(async () => {
    const gates = { C1: K.gate() };
    const gen = stagedGenerate({ C1: ['gate-ignore', 'good'], C2: ['good'] }, { gates });
    //   最初の C1 だけ gate で止め、その間に指示（取り込みの対象）と質問を受け付ける。gate を開くと C1 は止める失敗を投げる
    const realImpl = gen.impl; let first = true;
    gen.impl = async (args) => { if (args.customizationId === 'C1' && first) { first = false; await gates.C1.p; gen.seen.push({ cid: 'C1', what }); if (what === 'upstream-timeout') throw UPSTREAM_TIMEOUT(); throw aiErr(what.slice(6)); } return realImpl(args); };
    const x = makeConvC({ planImpl: planJs2, generate: gen });
    for (const s of K.REQUESTS.slice(0, 3)) await x.c.send(s);
    const p = x.c.send(K.REQUESTS[3]);
    await K.ticks(30);
    const plans0 = x.calls.plan.length;
    const q = await x.c.send('明細の金額も同じ条件で編集できないようにして');
    gates.C1.open(); const r = await p; await K.ticks(6);
    const v = x.c.activePlan();
    const genC2 = gen.seen.filter(s => s.cid === 'C2').length;
    assert(q && q.queued === true && plans0 === 1 && x.calls.plan.length === 1 && genC2 === 0 && gen.seen.filter(s => s.cid === 'C1').length === 1, `T1-1（${label}）: C2 の生成 0 件・計画の AI は増えない（自動の見直し・受け付けた指示の取り込みも 0 件）: ${JSON.stringify({ plans: x.calls.plan.length, seen: gen.seen.map(s => s.cid), queued: q && q.queued })}`);
    const ack = x.c.messages().find(m => m.data && m.data.kind === 'answers-ack');
    assert(ack && ack.data.stage === 'stopped' && /途中で止めたため、まだ計画に入っていません/.test(ack.text), `T1-2（${label}）: 生成中に受け付けた指示は計画に入れず「まだ入っていません」（記録したまま）: ${ack && ack.data.stage}`);
    assert(x.calls.ask.length === 0 && (v.openQuestions || []).length === 0 && !x.c.messages().some(m => m.type === 'ERROR'), `T1-3（${label}）: 質問は増えない・エラーのカード（同じ依頼の［再試行］）も出さない`);
    const fin = v.final;
    assert(r.ok === true && !r.cancelled && fin && fin.approvable === false && fin.incomplete && fin.incomplete.kind === kind && fin.incomplete.stoppedAt === 'C1' && JSON.stringify(fin.incomplete.notStarted) === '["C2"]' && v.generated.C1.status === 'failed' && v.generated.C1.failure.stop === kind && !v.generated.C2 && r.incomplete && r.incomplete.kind === kind, `T1-4（${label}）: 最終案は未完成（止めた C1・作っていない C2）: ${JSON.stringify(fin && fin.incomplete)}`);
    const ap = x.c.approveFinal({ planId: v.planId, version: v.version });
    assert(ap.ok === false && ap.reason === 'NOT_APPROVABLE' && x.c.finalReadiness().ready === false && x.c.finalReadiness().reasons[0].kind === 'incomplete', `T1-5（${label}）: 未完成の最終案は承認できない（理由の先頭は未完成）: ${ap.reason}`);
    const h = finalHtml(x), vis = visibleText(h);
    const b = restButtonOf(h);
    //   2026-10-14 の設計し直し（指示書 §1.4）: 止めた送信の最終案は「作成途中」の短いカード（見出し・できたもの・止めたもの・理由・残り n 件・ボタン。理由は 1 回だけ）
    assert(/作成途中/.test(vis) && !/未完成/.test(vis) && b && !b.disabled && /data-text="コードを作って"/.test(b.html) && [...h.matchAll(/<button[^>]*data-intent="REVISE_PLAN"[^>]*>/g)].every(mm => /data-display="受け付けた指示を計画に入れる"/.test(mm[0])) && !/data-fix=/.test(h) && !/data-act="final-fix"/.test(h), `T1-6（${label}）: カードの見出しは「作成途中」（「未完成」は出さない）・JavaScript の次の手は［残りの JavaScript を作る］1 つ（計画の修正の依頼（fix）は出さない。計画の差分更新のボタンは、まだ入っていない受け付けた指示を入れる［受け付けた指示を計画に入れる］だけ）: ${b && b.html}`);
    const WHY = { timeout: 'AIの応答が時間切れになりました', disconnected: 'AIサービスとの通信が切れました' }[kind];
    assert(vis.includes(`まだできた JavaScript はありません。JavaScriptの作成中に、${WHY}。JavaScript 2は手を付けていません。`) && /残り 2 件から再開できます/.test(vis) && (vis.match(new RegExp(WHY, 'g')) || []).length === 1 && !/JavaScript を作っている途中で止めました|まだ作っていない JavaScript が/.test(vis), `T1-7（${label}）: 作成途中のカードに、止めた JavaScript（手順の title）と理由・作っていない JavaScript・残りの件数（理由は 1 回だけ）: ${vis.replace(/\s+/g, ' ').slice(0, 240)}`);
    //   レビューの指摘 row4（2026-10-09）: 止めた送信で受け付けていた指示は、未完成の最終案のカードにも「まだ計画に入っていません」と、計画に入れる次の手（既存の choice の導線）
    const pendBtn = /<button[^>]*data-act="choice"[^>]*data-intent="REVISE_PLAN"[^>]*data-display="受け付けた指示を計画に入れる"[^>]*>/.exec(h);
    assert(fin.pendingInstructions && fin.pendingInstructions.length === 1 && /受け付けた指示 1 件はまだ計画に入っていません（この最終案には入っていません）/.test(vis) && vis.includes('明細の金額も同じ条件で編集できないようにして') && pendBtn && /data-text="明細の金額も同じ条件で編集できないようにして"/.test(pendBtn[0]) && !/\sdisabled/.test(pendBtn[0]), `T1-7b（${label}）: 未完成の最終案のカードに、まだ計画に入っていない受け付けた指示（1 件・本文）と［受け付けた指示を計画に入れる］: ${(vis.match(/受け付けた指示[^\n]*/) || [''])[0]}`);
    assert(!/TIMEOUT|TRANSPORT_ERROR|UPSTREAM_ERROR|\bC[12]\b/.test(vis) && !/約\s*[0-9]+\s*(秒|分)|1 分前後|十数秒/.test(vis), `T1-8（${label}）: 通常の表示に内部の値・時間の目安を出さない: ${(vis.match(/TIMEOUT|TRANSPORT_ERROR|UPSTREAM_ERROR|\bC[12]\b|約\s*[0-9]+\s*(秒|分)|1 分前後|十数秒/) || [''])[0]}`);
    const tm = x.c.state.metrics.timings.slice(-1)[0];
    assert(tm && tm.halt && tm.halt.kind === kind && tm.calls.some(c => c.kind === 'generate' && c.end === (kind === 'timeout' || kind === 'disconnected' ? 'unknown' : 'error')) && fin.usage.unknownCalls === 1, `T1-9（${label}）: 送信の記録に止めた理由と、終了不明の生成の呼び出し（費用は確定できない）: ${JSON.stringify({ halt: tm && tm.halt, calls: tm && tm.calls.map(c => [c.kind, c.end]) })}`);
    // ［残りの JavaScript を作る］: 計画の AI は呼ばず、止めた C1 と作っていない C2 だけを作る
    const r2 = await pressRest(x);
    const v2 = x.c.activePlan();
    assert(r2.ok && r2.intent === I.GENERATE_CODE && x.calls.plan.length === 1 && gen.seen.filter(s => s.cid === 'C1').length === 2 && gen.seen.filter(s => s.cid === 'C2').length === 1 && v2.version === v.version + 1 && v2.generated.C1.status === 'verified' && v2.generated.C2.status === 'verified' && !v2.final.incomplete && v2.final.approvable === true && x.calls.ask.length === 0, `T1-10（${label}）: ［残りの JavaScript を作る］→ 計画の AI 0 回・残りだけ生成・承認できる最終案: ${JSON.stringify({ plans: x.calls.plan.length, seen: gen.seen.map(s => s.cid), st: [v2.generated.C1 && v2.generated.C1.status, v2.generated.C2 && v2.generated.C2.status] })}`);
    //   レビューの指摘 row4: ［残りの JavaScript を作る］で作った最終案のカードにも、まだ計画に入っていない受け付けた指示を出す（承認できる最終案でも黙って落とさない）
    const h2 = finalHtml(x), vis2 = visibleText(h2);
    assert(v2.final.pendingInstructions && v2.final.pendingInstructions.length === 1 && /受け付けた指示 1 件はまだ計画に入っていません（この最終案には入っていません）/.test(vis2) && /data-display="受け付けた指示を計画に入れる"/.test(h2), `T1-10b（${label}）: ［残りの JavaScript を作る］で作った最終案のカードにも「受け付けた指示 1 件はまだ計画に入っていません」と［受け付けた指示を計画に入れる］: ${(vis2.match(/受け付けた指示[^\n]*/) || [''])[0]}`);
    //   ［受け付けた指示を計画に入れる］（choice の REVISE_PLAN）→ 計画の差分更新 1 回。その指示が入った版では「まだ入っていません」を出さない
    const pendText = (/data-display="受け付けた指示を計画に入れる"/.test(h2) && (/<button[^>]*data-text="([^"]*)"[^>]*data-intent="REVISE_PLAN"[^>]*data-display="受け付けた指示を計画に入れる"/.exec(h2) || [])[1]) || '';
    const plansB = x.calls.plan.length;
    await x.c.send(pendText, { intentOverride: I.REVISE_PLAN, displayText: '受け付けた指示を計画に入れる' });
    const v3 = x.c.activePlan();
    assert(pendText === '明細の金額も同じ条件で編集できないようにして' && x.calls.plan.length === plansB + 1 && v3.version > v2.version && v3.final && (v3.final.pendingInstructions || []).length === 0 && !/受け付けた指示 [0-9]+ 件はまだ計画に入っていません/.test(visibleText(finalHtml(x))), `T1-10c（${label}）: 押すと計画の差分更新 1 回で指示を入れ、入った版の最終案には出さない: ${JSON.stringify({ pendText, plans: [plansB, x.calls.plan.length], v: v3.version, pend: v3.final && v3.final.pendingInstructions })}`);
  });
}

// =========================================================
console.log('\n--- §T2. 利用者のキャンセル（生成中）→ 後続 0 件・未完成の最終案・「採用します」を戻さない ---');
await section(async () => {
  const gates = { C1: K.gate() };
  const gen = stagedGenerate({ C1: ['gate', 'good'], C2: ['good'] }, { gates });
  const x = makeConvC({ planImpl: planJs2, generate: gen });
  const ac = new AbortController();
  const p = sendUntilAdopt(x, { signal: ac.signal });
  await K.ticks(30);
  assert(gen.count('C1') === 1 && gen.seen[0].signal === ac.signal, 'T2-0: 前提: C1 の生成中（送信の signal を生成工程に渡している）');
  ac.abort();
  const r = await p; await K.ticks(4);
  const v = x.c.activePlan();
  assert(r.cancelled === true && r.ok === false && gen.count('C2') === 0 && x.calls.plan.length === 1 && x.calls.ask.length === 0, `T2-1: キャンセル → C2 の生成 0 件・計画の AI は増えない・質問は増えない: ${JSON.stringify({ seen: gen.seen.map(s => s.cid), plans: x.calls.plan.length })}`);
  assert(v.final && v.final.incomplete && v.final.incomplete.kind === 'cancelled' && v.generated.C1.status === 'failed' && v.generated.C1.failure.stop === 'cancelled' && JSON.stringify(v.final.incomplete.notStarted) === '["C2"]' && v.final.approvable === false && x.c.draft().status === 'adopted', `T2-2: 計画と途中の結果は残し、最終案は未完成（キャンセル）: ${JSON.stringify(v.final && v.final.incomplete)}`);
  const n = x.c.messages().filter(m => m.data && m.data.kind === 'cancelled').slice(-1)[0];
  assert(n && /残りの JavaScript を作る/.test(n.text) && !/採用します/.test(n.text) && n.data.text == null && r.incomplete && !/入力は残しています/.test(n.text), `T2-3: キャンセルの知らせに「採用します」を戻さず、続きの操作を案内する: ${n && n.text} / ${n && JSON.stringify(n.data)}`);
  const b = restButtonOf(finalHtml(x));
  assert(b && !b.disabled, 'T2-4: 未完成の最終案に［残りの JavaScript を作る］');
  const r2 = await pressRest(x);
  const v2 = x.c.activePlan();
  assert(r2.ok && x.calls.plan.length === 1 && gen.count('C1') === 2 && gen.count('C2') === 1 && v2.final.approvable === true && !v2.final.incomplete, `T2-5: 押すと計画の AI 0 回で C1・C2 を作る: ${JSON.stringify({ plans: x.calls.plan.length, seen: gen.seen.map(s => s.cid) })}`);
});
await section(async () => {
  //   計画の作成中の取り消し: 中断の後に返った計画は使わない（版を作らない・仮案は採用前のまま・知らせは今までどおり入力を残す）
  const pg = K.gate();
  const x = makeConvC({ planImpl: planJs2, planGate: pg });
  for (const s of K.REQUESTS.slice(0, 3)) await x.c.send(s);
  const ac = new AbortController();
  const p = x.c.send(K.REQUESTS[3], { signal: ac.signal });
  await K.ticks(10);
  ac.abort(); pg.open();
  const r = await p; await K.ticks(4);
  const n = x.c.messages().filter(m => m.data && m.data.kind === 'cancelled').slice(-1)[0];
  assert(r.cancelled === true && !x.c.activePlan() && x.c.draft().status === 'open' && n && /入力は残しています/.test(n.text) && n.data.text === K.REQUESTS[3] && x.calls.plan.length === 1, `T2-6: 計画の作成中の取り消しは今までどおり（中断の後に返った計画は版にしない・仮案は開いたまま・入力を残す）: ${JSON.stringify({ plan: !!x.c.activePlan(), draft: x.c.draft().status, text: n && n.data.text })}`);
});

// =========================================================
console.log('\n--- §T3. C1 は検証済み・C2 が時間切れ → ［残りの JavaScript を作る］は C1 を流用して C2 だけ ---');
await section(async () => {
  const gen = stagedGenerate({ C1: ['good'], C2: ['throw:TIMEOUT', 'good'] });
  const x = makeConvC({ planImpl: planJs2, generate: gen });
  await sendUntilAdopt(x);
  const v = x.c.activePlan();
  assert(v.generated.C1.status === 'verified' && v.generated.C2.status === 'failed' && v.generated.C2.failure.stop === 'timeout' && v.final.incomplete && v.final.incomplete.stoppedAt === 'C2' && v.final.incomplete.notStarted.length === 0 && v.final.approvable === false, `T3-1: 完了した C1 は残し、止めた C2 で未完成: ${JSON.stringify(v.final.incomplete)}`);
  const vis = visibleText(finalHtml(x));
  //   2026-10-14 の設計し直し: できた C1（手順の title）・止めた C2・残り 1 件。未着手の文は出さない
  assert(/JavaScriptはできました。JavaScript 2の作成中に、AIの応答が時間切れになりました。/.test(vis) && !/手を付けていません/.test(vis) && /完成した分は残っています。残り 1 件から再開できます。/.test(vis) && !/未完成/.test(vis), `T3-2: 作っていない JavaScript が無いときは、できたものと止めたものの文だけ: ${vis.replace(/\s+/g, ' ').slice(0, 240)}`);
  const c1Hash = v.generated.C1.candidateHash;
  const r2 = await pressRest(x);
  const v2 = x.c.activePlan();
  assert(r2.ok && x.calls.plan.length === 1 && gen.count('C1') === 1 && gen.count('C2') === 2 && v2.generated.C1.reused === true && v2.generated.C1.candidateHash === c1Hash && v2.generated.C2.status === 'verified' && v2.final.approvable === true && v2.final.changedSince.reused.includes('C1') && JSON.stringify(v2.final.changedSince.regenerated) === '["C2"]', `T3-3: 検証済みの C1 は流用し、C2 だけ生成（計画の AI 0 回）: ${JSON.stringify({ seen: gen.seen.map(s => s.cid), changed: v2.final.changedSince })}`);
});

// =========================================================
console.log('\n--- §T4. 遅れた結果（中断を無視して後から返った結果）で最新の案を上書きしない ---');
await section(async () => {
  //   services の偽物が中断を無視して、取り消しの後に検証済みの結果を返す → 使わない（取り消しとして扱う）。C2 は送らない
  const gates = { C1: K.gate() };
  const gen = stagedGenerate({ C1: ['gate-ignore', 'good'], C2: ['good'] }, { gates });
  const x = makeConvC({ planImpl: planJs2, generate: gen });
  const ac = new AbortController();
  const p = sendUntilAdopt(x, { signal: ac.signal });
  await K.ticks(30);
  ac.abort(); await K.ticks(2); gates.C1.open();
  const r = await p; await K.ticks(4);
  const v = x.c.activePlan();
  const call = x.c.state.metrics.timings.slice(-1)[0].calls.find(c => c.kind === 'generate');
  assert(r.cancelled === true && v.generated.C1.status === 'failed' && v.generated.C1.failure.stop === 'cancelled' && !v.generated.C1.generated && gen.count('C2') === 0 && v.final.incomplete && call && call.discarded === true, `T4-1: 中断の後に返った生成の結果は使わない（C1 は止めた扱い・C2 は 0 件・記録に使わなかった印）: ${JSON.stringify({ st: v.generated.C1.status, seen: gen.seen.map(s => s.cid), call })}`);
});
await section(async () => {
  //   実際の client（KTAiClient.createAiClient）: transport が中断を無視して、あとから結果を返す。取り消しの時点で CANCELLED になり、遅れた応答は誰も使わない。
  //   ［残りの JavaScript を作る］でできた新しい版は、遅れた応答が届いても変わらない
  const data = FX.makeData();
  const gctx = KTContext.buildGenerator({ customization: { customizationId: 'C1', requirement: '承認待ちでは金額を編集不可', whyStandardInsufficient: 'w', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [] }, plan: { goal: 'g', steps: [] }, planId: 'p', version: 1, data });
  const RESP = { ok: true, contractVersion: '2.1', meta: { requestId: 'g-late', gateway: { product: 'toolkit', feature: 'customization-generator', promptVersion: '1', contextVersion: 'customization-1' }, normalization: { warnings: [] }, ai: { model: 'm' } }, generated: { strategy: 'NEW_JS_FILE', targetFile: 'late.js', summary: 's', code: "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) { return event; });\n})();", patch: null, events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], coverage: [], gatewayChecks: { security: [] } } };
  const tg = K.gate(); let lateDone = false, sentSignal = null;
  const transport = async ({ signal }) => { sentSignal = signal; await tg.p; lateDone = true; return { status: 200, body: JSON.stringify(RESP) }; };   // signal を無視する
  const cl = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport });
  const base = makeGenerate({ sequence: ['good'] });
  let first = true; const seen = [];
  const gen = { calls: base.calls, impl: async (args) => { seen.push(args.customizationId); if (first) { first = false; await cl.generate({ ctx: gctx, signal: args.signal }); } return base.impl(args); } };
  const x = makeConvC({ planImpl: planJs2, generate: gen });
  const ac = new AbortController();
  const p = sendUntilAdopt(x, { signal: ac.signal });
  await K.ticks(30);
  ac.abort();
  const r = await p; await K.ticks(4);
  const v1 = x.c.activePlan();
  assert(r.cancelled === true && sentSignal && sentSignal.aborted === true && !lateDone && v1.generated.C1.failure && v1.generated.C1.failure.stop === 'cancelled' && JSON.stringify(seen) === '["C1"]', `T4-2: 取り消しの時点で client は CANCELLED（transport の応答を待たない）・C2 は送らない: ${JSON.stringify({ seen, late: lateDone })}`);
  await pressRest(x);
  const v2 = x.c.activePlan();
  const snap = JSON.stringify({ v: v2.version, c1: v2.generated.C1.candidateHash, c2: v2.generated.C2.candidateHash, st: [v2.generated.C1.status, v2.generated.C2.status] });
  const finals = x.finals().length;
  tg.open(); await sleep(5); await K.ticks(6);
  assert(lateDone && x.c.activePlan() === v2 && JSON.stringify({ v: v2.version, c1: v2.generated.C1.candidateHash, c2: v2.generated.C2.candidateHash, st: [v2.generated.C1.status, v2.generated.C2.status] }) === snap && x.finals().length === finals && v1.generated.C1.failure.stop === 'cancelled' && v2.final.approvable === true, `T4-3: 遅れて届いた応答は最新の版（［残りの JavaScript を作る］の版）も前の版も変えない: ${snap}`);
});
await section(async () => {
  //   レビューの指摘（abort-gw の［no］・2026-10-09）: 送信ごとの印 sendSeq の分岐（late()）。中断できない待ち（services.customizeRevision。signal を受けない）の間に
  //   新しい送信が始まったら、前の送信は待ちの後に生成・確定・最終案へ進まず、最新の案（activePlan）を変えない。
  //   会話の send は 1 つずつしか走らない（busy の間の発言は受け付けに回る）ので、新しい送信が始まった状態は送信ごとの印を進めて作る
  const g = K.gate();
  const gen = stagedGenerate({ C1: ['good'], C2: ['good'] });
  const x = makeConvC({ planImpl: planJs2, generate: gen });
  let waiting = 0;
  x.services.customizeRevision = async () => { waiting += 1; await g.p; return '43'; };
  for (const s of K.REQUESTS.slice(0, 3)) await x.c.send(s);
  const p = x.c.send(K.REQUESTS[3]);
  await K.waitUntil(() => waiting > 0, 80);
  const v = x.c.activePlan();
  const finals = x.finals().length, msgs = x.c.messages().length;
  const seq0 = x.c.state.sendSeq;
  assert(waiting === 1 && !!v && !v.final && gen.seen.length === 0 && typeof seq0 === 'number', `T4-4 前提: 最初の計画を版にした後、JavaScript の仕様の確定の待ち（中断できない）で止まっている（送信ごとの印 ${seq0}）`);
  x.c.state.sendSeq = (Number(seq0) || 0) + 1;   // 別の送信が始まった
  g.open();
  const r = await p; await K.ticks(6);
  const v2 = x.c.activePlan();
  assert(v2 === v && gen.seen.length === 0 && !v.final && Object.keys(v.generated || {}).length === 0 && v.spec && v.spec.status !== 'CONFIRMED' && x.finals().length === finals && !x.c.messages().slice(msgs).some(m => m.type === 'FINAL' || m.type === 'ERROR') && x.calls.plan.length === 1, `T4-4: 待ちの後の前の送信は生成 0 件・仕様の確定も最終案も作らない（最新の案を変えない）: ${JSON.stringify({ seen: gen.seen.map(s => s.cid), final: !!v.final, spec: v.spec && v.spec.status, plans: x.calls.plan.length, r: r && { ok: r.ok, discarded: r.discarded } })}`);
});

// =========================================================
console.log('\n--- §T5. 計画の自動の見直しの時間切れ・失敗 ---');
const CUST_NOEFF = K.custOf(null);
const planNoEff = (args) => K.planJs(args, { cust: CUST_NOEFF });
await section(async () => {
  const gen = stagedGenerate({ C1: ['good'] });
  const x = makeConvC({ planImpl: (args) => { if (args.revision) throw aiErr('TIMEOUT'); return planNoEff(args); }, generate: gen });
  const r = await sendUntilAdopt(x);
  const v = x.c.activePlan();
  const auto = x.calls.plan.filter(c => c.revision);
  assert(x.calls.plan.length === 2 && auto.length === 1 && gen.seen.length === 0 && v.final && v.final.incomplete && v.final.incomplete.stage === 'plan-auto' && v.final.incomplete.kind === 'timeout' && JSON.stringify(v.final.incomplete.notStarted) === '["C1"]' && v.final.approvable === false && r.ok === true, `T5-1: 自動の見直しの時間切れ → 生成 0 件・未完成の最終案（作っていない JavaScript）: ${JSON.stringify({ plans: x.calls.plan.length, gen: gen.seen.length, inc: v.final && v.final.incomplete })}`);
  const internal = /必要な動作（効果）を特定できません|customizations\[\]/;
  assert(!x.c.messages().some(m => m.type === 'ERROR') && !x.c.messages().some(m => internal.test(String(m.text || '')) || internal.test(String((m.data && (m.data.retryText || m.data.text)) || ''))), 'T5-2: 内部の依頼文を会話・［再試行］に出さない（エラーのカードも出さない）');
  const vis = visibleText(finalHtml(x));
  //   2026-10-14 の設計し直し: 作成途中のカードに、止めた段階（計画の自動の見直し）と理由・作っていない JavaScript（手順の title）・残り 1 件・ボタン
  assert(/まだできた JavaScript はありません。計画の自動の見直しの途中で、AIの応答が時間切れになりました。JavaScriptは手を付けていません。/.test(vis) && /残り 1 件から再開できます/.test(vis) && restButtonOf(finalHtml(x)), `T5-3: カードに止めた段階（計画の自動の見直し）と作っていない JavaScript・［残りの JavaScript を作る］: ${vis.replace(/\s+/g, ' ').slice(0, 240)}`);
  await pressRest(x);
  assert(x.calls.plan.length === 2 && !x.c.messages().some(m => m.type === 'USER' && internal.test(String(m.text))), `T5-4: 押しても自動の見直し（計画の AI）は繰り返さない・利用者の発言に内部の文が入らない: ${x.calls.plan.length}`);
});
await section(async () => {
  //   自動の見直しが計画を返さなかった（例外でない失敗）: エラーの［再試行］は内部の依頼文ではなく最終案の作り直し（GENERATE_CODE）
  const gen = stagedGenerate({ C1: ['good'] });
  const x = makeConvC({ planImpl: (args) => (args.revision ? K.planFail() : planNoEff(args)), generate: gen });
  await sendUntilAdopt(x);
  const err = x.c.messages().filter(m => m.type === 'ERROR').slice(-1)[0];
  assert(err && err.data.retryText === 'コードを作って' && err.data.intent === I.GENERATE_CODE && !/必要な動作（効果）を特定できません/.test(err.data.retryText), `T5-5: 自動の見直しの失敗の［再試行］は「コードを作って」（GENERATE_CODE）。内部の依頼文を利用者の発言として送らない: ${err && JSON.stringify({ t: err.data.retryText, i: err.data.intent })}`);
  const plans = x.calls.plan.length;
  await x.c.send(err.data.retryText, { intentOverride: err.data.intent });
  assert(x.calls.plan.length === plans && !x.c.messages().some(m => m.type === 'USER' && /必要な動作（効果）を特定できません/.test(String(m.text))), 'T5-6: ［再試行］は計画の AI を呼ばない');
});
await section(async () => {
  //   自動の見直しの後の待ち（仕様の自動確定）の間に届いた質問: 止まった送信では受け付けない（作業中の質問を 0 件にする。下書きに残す）
  const gen = stagedGenerate({ C1: ['good'] });
  const cg = K.gate();
  const x = makeConvC({ planImpl: (args) => { if (args.revision) throw aiErr('TIMEOUT'); return planNoEff(args); }, generate: gen });
  let waited = false;
  x.services.customizeRevision = async () => { waited = true; await cg.p; return '42'; };
  const p = sendUntilAdopt(x);
  await K.ticks(40);
  const q = await x.c.send('金額の上限は何円ですか？');
  cg.open(); await p; await K.ticks(4);
  assert(waited && q === null && x.calls.ask.length === 0, `T5-7: 止まった送信の後は新しい作業中の質問を始めない（受け付けずに下書きに残す）: ${JSON.stringify({ waited, q, asks: x.calls.ask.length })}`);
});

await section(async () => {
  //   レビューの指摘 row4（2026-10-09）: 生成の halt の後に届いた作業中の質問も始めない。C1 は 1 回目に JS ごとの失敗（INTERNAL_ERROR）・C2 は検証済み。
  //   ［残りの JavaScript を作る］で C1 が時間切れ（halt）→ C2 の流用の判定（模擬の環境の確認）を待つ間に届いた質問は受け付けない
  let halted = false;
  const envGate = K.gate();
  const gen = stagedGenerate({ C1: ['throw:INTERNAL_ERROR', 'throw:TIMEOUT'], C2: ['good'] }, { onCall: ({ what }) => { if (what === 'throw:TIMEOUT') halted = true; } });
  const x = makeConvC({ planImpl: planJs2, generate: gen });
  let waited = false;
  x.services.simEnvKey = async ({ customizationId }) => { if (halted && customizationId === 'C2') { waited = true; await envGate.p; } return 'env-1'; };
  await sendUntilAdopt(x);
  const v1 = x.c.activePlan();
  assert(v1.final && v1.generated.C1 && v1.generated.C1.status === 'failed' && !(v1.generated.C1.failure || {}).stop && v1.generated.C2 && v1.generated.C2.status === 'verified', `前提: C1 は JS ごとの失敗・C2 は検証済み: ${JSON.stringify({ c1: v1.generated.C1 && v1.generated.C1.status, c2: v1.generated.C2 && v1.generated.C2.status })}`);
  const p = pressRest(x);
  await K.waitUntil(() => waited, 200);
  const asks0 = x.calls.ask.length;
  const q = await x.c.send('金額の上限は何円ですか？');
  envGate.open(); await p; await K.ticks(4);
  const v2 = x.c.activePlan();
  assert(waited && q === null && x.calls.ask.length === asks0 && v2.final && v2.final.incomplete && v2.final.incomplete.kind === 'timeout' && v2.final.incomplete.stoppedAt === 'C1' && v2.generated.C2 && v2.generated.C2.reused === true, `T5-8: 生成の halt の後（C2 の流用の判定を待つ間）に届いた作業中の質問は始めない（受け付けずに下書きに残す）。C2 は流用し、最終案は未完成: ${JSON.stringify({ waited, q, asks: x.calls.ask.length, inc: v2.final && v2.final.incomplete, c2: v2.generated.C2 && v2.generated.C2.reused })}`);
});
await section(async () => {
  //   レビューの指摘 row4（2026-10-09）: 画面: 生成中に受け付けた指示が止めた送信で計画に入らなかったら、［残りの JavaScript を作る］で作った最終案の承認の欄の確認項目にも 1 行
  const g = K.gate(); let n = 0;
  const sg = K.screenGenerate({ field: 'case_name', targetFile: 'caseLock.js' });
  const generateImpl = async (a) => { n += 1; if (n === 1) { await g.p; throw aiErr('TIMEOUT'); } return sg.impl(a); };
  const m = K.mount({ health: K.HEALTH_V, planImpl: K.planImplOf(K.screenPlan('js')), generateImpl, liveBase: true });
  await K.ticks();
  for (const s0 of K.REQUESTS.slice(0, 3)) { await m.panel.send(s0); await K.ticks(10); }
  const pAdopt = m.panel.send(K.REQUESTS[3]);
  await K.waitUntil(() => n === 1, 400);
  const pQ = m.panel.send('案件名の上限も同じ条件で編集できないようにして');
  await K.ticks(8);
  g.open(); await pAdopt; await pQ; await K.ticks(10);
  const v1 = m.conv().activePlan();
  assert(v1 && v1.final && v1.final.incomplete && (v1.final.pendingInstructions || []).length === 1, `前提: 画面で生成が時間切れ → 未完成の最終案・受け付けた指示 1 件が入っていない: ${JSON.stringify({ inc: v1 && v1.final && v1.final.incomplete, pend: v1 && v1.final && v1.final.pendingInstructions })}`);
  await K.clickChat(m, 'choice', { text: 'コードを作って', intent: I.GENERATE_CODE, display: '残りの JavaScript を作る' });
  await K.waitUntil(() => { const v = m.conv().activePlan(); return v && v !== v1 && v.final; }, 400);
  await K.waitUntil(() => ['ready', 'blocked', 'unavailable'].includes(m.panel.finalPrecheck().status) && m.panel.finalPrecheck().planId === v1.planId && m.panel.finalPrecheck().version === m.conv().activePlan().version, 120); await K.ticks(2);
  const pre = m.panel.finalPrecheck();
  const conf = (pre.items && pre.items.confirmations) || [];
  const line = conf.find(c => c && typeof c === 'object' && /受け付けた指示 1 件はまだ計画に入っていません/.test(c.text || ''));
  const chat = stripC(m.chat().replace(/<details[\s\S]*?<\/details>/g, '')), chatAll = stripC(m.chat());
  assert(m.conv().activePlan().final.approvable === true && pre.status === 'ready' && line && /受け付けた指示を計画に入れる/.test(line.text) && /確認項目（この承認で確認済みとして扱います）/.test(chatAll) && chat.includes('受け付けた指示 1 件はまだ計画に入っていません（この最終案には入っていません'), `T1-11: ［残りの JavaScript を作る］で作った承認できる最終案の承認の欄の確認項目に「受け付けた指示 1 件はまだ計画に入っていません」: ${JSON.stringify({ status: pre.status, conf })}`);
});

// =========================================================
console.log('\n--- §T6. 予算・回数の上限で止めた → ボタンは無効で理由 ---');
for (const code of ['MONTHLY_LIMIT_EXCEEDED', 'BUDGET_EXCEEDED']) {
  await section(async () => {
    const gen = stagedGenerate({ C1: [`throw:${code}`, 'good'], C2: ['good'] });
    const x = makeConvC({ planImpl: planJs2, generate: gen });
    await sendUntilAdopt(x);
    const v = x.c.activePlan();
    const h = finalHtml(x), b = restButtonOf(h);
    assert(v.final.incomplete && v.final.incomplete.kind === 'budget' && gen.count('C2') === 0 && b && b.disabled === true && /の作成中に、利用の上限（予算・回数）に達しました/.test(stripC(h)) && /上限を見直すまで、続きは送りません。/.test(stripC(h)) && !/残り [0-9]+ 件/.test(stripC(h)) && v.final.approvable === false, `T6-1（${code}）: 上限で止めた → C2 は 0 件・［残りの JavaScript を作る］は無効で理由: ${b && b.html}`);
    assert(!v.final.incomplete.endUnknown && !/終わったかは確かめられていません/.test(stripC(h)) && v.final.usage.unknownCalls === 0, `T6-2（${code}）: 上限の拒否は送る前・AI を呼ぶ前の失敗（終了不明にしない）`);
  });
}

// =========================================================
console.log('\n--- §T7. 期限（health の deadlineMs ＋ 受信の余裕・上限・既定・互換）と絶対時間 ---');
await section(async () => {
  const L = KTAiClient.clientLimitFromDeadline;
  assert(L(300000) === 320000 && L(120000) === 140000 && L(320000) === 330000 && L(900000) === 330000 && L(null) === null && L(undefined) === null && L(0) === null && L('x') === null && KTAiClient.CLIENT_LIMIT_DEFAULT_MS === 240000 && KTAiClient.RECEIVE_MARGIN_MS === 20000 && KTAiClient.CLIENT_LIMIT_MAX_MS === 330000, 'T7-1: 打ち切り = deadlineMs ＋ 20 秒（上限 330 秒）・期限が無ければ null（既定の 240 秒）');
  const H = clone(K.HEALTH); H.limits = { version: 1, deadlineMs: { 'toolkit.assistant-qa': 120000, 'toolkit.change-planner': 300000, 'toolkit.customization-generator': 300000 }, features: { 'toolkit.customization-generator': { model: 'm', maxOutputTokens: 32000, maxAiCalls: 3 } } };
  const cap = KTAiClient.capabilityFromHealth(H), cap0 = KTAiClient.capabilityFromHealth(K.HEALTH);
  assert(cap.available && cap.limits && cap.limits.deadlineMs['change-planner'] === 300000 && cap.limits.deadlineMs['assistant-qa'] === 120000 && cap.limits.features['customization-generator'].maxAiCalls === 3 && !cap0.limits, `T7-2: health の limits を feature の名前で読む（古い Gateway は無し）: ${JSON.stringify(cap.limits)}`);
});
await section(async () => {
  //   タイマーの長さ: 画面のタイマー（sandbox の setTimeout）を差し替えて、要求ごとの打ち切りの ms を記録する（すぐ発火させる）
  const sb = T.__sandbox; const realST = sb.setTimeout; const delays = [];
  sb.setTimeout = (fn, ms) => { delays.push(ms); return realST(fn, 1); };
  const hang = async ({ signal }) => new Promise((_, rej) => { if (signal) signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }); });
  const pctx = { facts: [], goal: 'g', contextVersion: '1' };
  const run = async (opts, call) => { delays.length = 0; let e0 = null; try { await call(KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: hang, ...opts })); } catch (e) { e0 = e; } return { delay: delays[0], code: e0 && e0.code, transport: e0 && e0.transport }; };
  try {
    const a = await run({}, (c) => c.plan({ ctx: pctx, deadlineMs: 300000 }));
    const b = await run({}, (c) => c.plan({ ctx: pctx }));
    const cMax = await run({}, (c) => c.plan({ ctx: pctx, deadlineMs: 600000 }));
    const d = await run({ timeoutMs: 1234 }, (c) => c.plan({ ctx: pctx, deadlineMs: 300000 }));
    const e = await run({ longTimeoutMs: 4321 }, (c) => c.plan({ ctx: pctx, deadlineMs: 300000 }));
    const gq = await run({}, (c) => c.ask({ ctx: { contextVersion: '1', facts: [] }, deadlineMs: 120000 }));
    const gs = await run({}, (c) => c.ask({ ctx: { contextVersion: '1', facts: [] }, deadlineMs: 120000, onText: () => { } }));
    assert(a.delay === 320000 && a.code === 'TIMEOUT' && b.delay === 240000 && cMax.delay === 330000, `T7-3: 計画の打ち切りは health の deadlineMs ＋ 20 秒・無ければ 240 秒・上限 330 秒: ${JSON.stringify([a.delay, b.delay, cMax.delay])}`);
    assert(d.delay === 1234 && e.delay === 4321, `T7-4: 明示した timeoutMs・longTimeoutMs は今どおり優先（テスト・旧呼び出しの互換）: ${JSON.stringify([d.delay, e.delay])}`);
    assert(gq.delay === 60000 && gs.delay === 140000, `T7-5: 逐次表示の無い質問は今の 60 秒（kintone.proxy の上限）・逐次表示の質問は assistant-qa の期限 ＋ 20 秒: ${JSON.stringify([gq.delay, gs.delay])}`);
    assert(a.transport && a.transport.startedAt === 0 && Number.isFinite(a.transport.endAt) && a.transport.headersAt === null, `T7-6: 時間切れの例外にも transport の時刻（相対 ms。見出しは届いていない）: ${JSON.stringify(a.transport)}`);
  } finally { sb.setTimeout = realST; }
});
await section(async () => {
  //   AUTH_TOKEN_EXPIRED の再試行は、最初の要求の残り時間だけ（全体を最初の打ち切りの内に収める）
  const sb = T.__sandbox; const realST = sb.setTimeout; const delays = [];
  sb.setTimeout = (fn, ms) => { delays.push(ms); return realST(fn, ms); };
  try {
    let n = 0;
    const transport = async ({ signal }) => { n += 1; if (n === 1) { await sleep(60); return { status: 401, body: JSON.stringify({ ok: false, error: { code: 'AUTH_TOKEN_EXPIRED', message: 'expired' } }) }; } return new Promise((_, rej) => { if (signal) signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }); }); };
    const c = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport, longTimeoutMs: 200, onAuthExpired: async () => true });
    const t0 = Date.now(); let e0 = null;
    try { await c.generate({ ctx: { facts: [], contextVersion: 'customization-1', customization: {} } }); } catch (e) { e0 = e; }
    const el = Date.now() - t0;
    assert(e0 && e0.code === 'TIMEOUT' && n === 2 && delays.length >= 2 && delays[0] === 200 && delays[1] < 200 && delays[1] > 0 && el < 330, `T7-7: 期限切れの再試行の待ちは残り時間だけ（合計が最初の打ち切りを大きく越えない）: ${JSON.stringify({ code: e0 && e0.code, n, delays: delays.slice(0, 2), el })}`);
    n = 0; delays.length = 0;
    const slow = async () => { n += 1; await sleep(80); return { status: 401, body: JSON.stringify({ ok: false, error: { code: 'AUTH_TOKEN_EXPIRED', message: 'expired' } }) }; };
    const c2 = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: slow, longTimeoutMs: 100, onAuthExpired: async () => { await sleep(40); return true; } });
    let e1 = null; try { await c2.generate({ ctx: { facts: [], contextVersion: 'customization-1', customization: {} } }); } catch (e) { e1 = e; }
    assert(e1 && e1.code === 'TIMEOUT' && n === 1, `T7-8: 残り時間が無ければ送り直さずに TIMEOUT: ${JSON.stringify({ code: e1 && e1.code, n })}`);
  } finally { sb.setTimeout = realST; }
  void sleep;
});
await section(async () => {
  //   逐次配信が上限を越えて届き続けても TIMEOUT（タイマーは絶対時間。delta・keepalive で延ばさない）。打ち切りで本文の読み取りも止める
  const enc = new TextEncoder();
  let reads = 0, aborted = false, deltas = 0;
  const fetchFn = async (url, init) => {
    const signal = init.signal;
    if (signal) signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    return { status: 200, headers: { get: () => 'text/event-stream' }, body: { getReader: () => ({ read: () => new Promise((resolve, reject) => { if (aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); setTimeout(() => { if (aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); reads += 1; resolve({ value: enc.encode(`event: delta\ndata: ${JSON.stringify({ text: 'あ' })}\n\n`), done: false }); }, 10); }) }) } };
  };
  const c = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: KTAiClient.createDefaultTransport({ kintoneApi: null, fetchFn }), longTimeoutMs: 120 });
  const t0 = Date.now(); let e0 = null; const trace = {};
  try { await c.plan({ ctx: { facts: [], goal: 'g', contextVersion: '1' }, onText: () => { deltas += 1; }, trace }); } catch (e) { e0 = e; }
  const el = Date.now() - t0;
  const readsAt = reads; await sleep(60);
  assert(e0 && e0.code === 'TIMEOUT' && deltas >= 3 && el < 400 && aborted && reads === readsAt, `T7-9: 逐次配信が届き続けても上限で TIMEOUT・読み取りも止める: ${JSON.stringify({ code: e0 && e0.code, deltas, el, reads, readsAt })}`);
  assert(trace.transport && trace.transport.headersAt != null && trace.transport.firstByteAt != null && trace.transport.endAt >= trace.transport.firstByteAt && trace.limitMs === 120, `T7-10: transport の時刻（見出し・最初の断片・終わり。相対 ms）と打ち切りの ms を記録する（本文なし）: ${JSON.stringify(trace)}`);
});
await section(async () => {
  //   成功した要求の時刻（直接の fetch・JSON）
  const fetchFn = async () => ({ status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ ok: true, contractVersion: '2.1', meta: { requestId: 'r', gateway: {}, normalization: { warnings: [] }, ai: { model: 'm' } }, answer: 'a', facts: [], analysis: [], recommendations: [], unknowns: [] }) });
  const c = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: KTAiClient.createDefaultTransport({ kintoneApi: null, fetchFn }) });
  const trace = {};
  const a = await c.ask({ ctx: { contextVersion: '1', facts: [] }, trace });
  assert(a && trace.transport && trace.transport.startedAt === 0 && Number.isFinite(trace.transport.headersAt) && Number.isFinite(trace.transport.firstByteAt) && Number.isFinite(trace.transport.endAt) && Object.keys(trace.transport).sort().join(',') === 'endAt,firstByteAt,headersAt,startedAt', `T7-11: 成功した要求の時刻（数値だけ）: ${JSON.stringify(trace.transport)}`);
});

// =========================================================
console.log('\n--- §T8. 画面: health の limits の期限を呼び出しに渡す・［キャンセル］は作業中の質問も止める ---');
await section(async () => {
  const H = clone(K.HEALTH); H.limits = { version: 1, deadlineMs: { 'toolkit.assistant-qa': 120000, 'toolkit.change-planner': 300000, 'toolkit.customization-generator': 280000 }, features: {} };
  const m = K.mount({ health: H });
  await K.ticks();
  await K.adoptOnScreen(m);
  assert(m.calls.propose.length >= 1 && m.calls.propose.every(c => c.deadlineMs === 120000) && m.calls.plan.length >= 1 && m.calls.plan.every(c => c.deadlineMs === 300000), `T8-1: 画面は health の deadlineMs を feature ごとに client へ渡す（仮案 120 秒・計画 300 秒）: ${JSON.stringify({ p: m.calls.propose.map(c => c.deadlineMs), plan: m.calls.plan.map(c => c.deadlineMs) })}`);
  const m0 = K.mount();
  await K.ticks();
  await K.adoptOnScreen(m0);
  assert(m0.calls.plan.length >= 1 && m0.calls.plan.every(c => c.deadlineMs === null), 'T8-2: health に limits が無い（古い Gateway）ときは期限を渡さない（client は今の 240 秒）');
  const conv = m0.conv(); let n = 0; const orig = conv.cancelAsides;
  conv.cancelAsides = () => { n += 1; return orig(); };
  await m0.$('kt-ai-cancel').dispatch('click');
  conv.cancelAsides = orig;
  assert(n === 1, 'T8-3: ［キャンセル］は送信と作業中の質問の両方を止める（cancelAsides を呼ぶ）');
});
await section(async () => {
  //   レビューの指摘 row5（2026-10-09）: 生成の要求にも health の customization-generator の deadlineMs を渡し、client の打ち切りは deadlineMs ＋ 20 秒
  const H = clone(K.HEALTH_V); H.limits = { version: 1, deadlineMs: { 'toolkit.assistant-qa': 120000, 'toolkit.change-planner': 300000, 'toolkit.customization-generator': 280000 }, features: {} };
  const genArgs = [];
  const sg = K.screenGenerate({ field: 'case_name', targetFile: 'caseLock.js' });
  const m = K.mount({ health: H, planImpl: K.planImplOf(K.screenPlan('js')), generateImpl: (a) => { genArgs.push({ deadlineMs: a.deadlineMs ?? null }); return sg.impl(a); }, liveBase: true });
  await K.ticks();
  await K.adoptOnScreen(m); await K.ticks(20);
  //   client の打ち切り（画面のタイマーを差し替えて ms を記録。すぐ発火させる）
  const sb = T.__sandbox; const realST = sb.setTimeout; const delays = [];
  sb.setTimeout = (fn, ms) => { delays.push(ms); return realST(fn, 1); };
  let e0 = null;
  try { await KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: async ({ signal }) => new Promise((_, rej) => { if (signal) signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }); }) }).generate({ ctx: { facts: [], contextVersion: 'customization-1', customization: {} }, deadlineMs: genArgs.length ? genArgs[0].deadlineMs : null }); } catch (e) { e0 = e; } finally { sb.setTimeout = realST; }
  assert(genArgs.length >= 1 && genArgs.every(g => g.deadlineMs === 280000) && delays[0] === 300000 && e0 && e0.code === 'TIMEOUT', `T8-1b: 画面は生成の要求にも health の deadlineMs（280 秒）を渡し、client の打ち切りは deadlineMs ＋ 20 秒（300 秒）: ${JSON.stringify({ gen: genArgs, delay: delays[0], code: e0 && e0.code })}`);
});
await section(async () => {
  //   画面: 生成中に［キャンセル］→ 入力欄に送った文（採用の発言）を戻さない・最終案のカードは未完成で［残りの JavaScript を作る］
  let genSignal = null, genCalls = 0;
  const generateImpl = ({ signal }) => { genCalls += 1; genSignal = signal; return new Promise((_, rej) => { if (signal) signal.addEventListener('abort', () => rej(aiErr('CANCELLED')), { once: true }); }); };
  const m = K.mount({ health: K.HEALTH_V, planImpl: K.planImplOf(K.screenPlan('js')), generateImpl, liveBase: true });
  await K.ticks();
  for (const s of K.REQUESTS.slice(0, 3)) { await m.panel.send(s); await K.ticks(10); }
  m.$('kt-ai-input').value = K.REQUESTS[3];
  const pClick = m.$('kt-ai-send').dispatch('click');
  await K.waitUntil(() => genCalls === 1, 400);
  assert(genCalls === 1 && genSignal && m.$('kt-ai-cancel').style.display === '', 'T8-4: 前提: 生成中（［キャンセル］が出ている）');
  await m.$('kt-ai-cancel').dispatch('click');
  await pClick; await K.ticks(10);
  const v = m.conv().activePlan();
  const chat = m.chat();
  assert(genSignal.aborted === true && v && v.final && v.final.incomplete && v.final.incomplete.kind === 'cancelled' && m.$('kt-ai-input').value === '' && /data-display="残りの JavaScript を作る"/.test(chat) && /キャンセルしました。計画と、できた JavaScript は最終案のカードに残しています/.test(chat), `T8-5: 画面の［キャンセル］→ 生成の要求を abort・入力欄に「${K.REQUESTS[3]}」を戻さない・最終案は未完成で続きのボタン: ${JSON.stringify({ input: m.$('kt-ai-input').value, inc: v && v.final && v.final.incomplete })}`);
});

// =========================================================
console.log('\n--- §T9. 作業中の質問の中断 ---');
await section(async () => {
  //   生成中の質問（acceptWhileBusy → askNow）は送信の signal につながる。送信の取り消しで質問の要求も abort される
  const gates = { C1: K.gate() };
  const gen = stagedGenerate({ C1: ['gate', 'good'], C2: ['good'] }, { gates });
  const x = makeConvC({ planImpl: planJs2, generate: gen });
  const askSignals = []; const ag = K.gate();
  x.services.ask = async (args) => { x.calls.ask.push({ question: args.question }); askSignals.push(args.signal); await ag.p; return { ok: true, answer: { answer: '遅れた答えです。', facts: [], analysis: [], recommendations: [], unknowns: [] }, ctx: { facts: [] } }; };
  const ac = new AbortController();
  const p = sendUntilAdopt(x, { signal: ac.signal });
  await K.ticks(30);
  const q = await x.c.send('金額の上限は何円ですか？');
  await K.ticks(2);
  assert(q && q.asked === true && askSignals.length === 1 && askSignals[0] && askSignals[0].aborted === false && x.c.asidesRunning() === 1, 'T9-0: 前提: 生成中の質問は作業と並べて送る（中断の signal 付き）');
  ac.abort();
  await p; await K.ticks(2);
  assert(askSignals[0].aborted === true, 'T9-1: 送信の［キャンセル］で、作業中の質問の要求も abort される');
  ag.open(); await sleep(2); await K.ticks(4);
  assert(!x.c.messages().some(m => m.type === 'ANSWER' && /遅れた答えです/.test(String(m.text))) && x.c.asidesRunning() === 0, 'T9-2: 止めた後に（中断を無視して）届いた答えは出さない');
});
await section(async () => {
  //   送信が終わった後も走っている質問（askAside）は cancelAsides（［キャンセル］）で止まる
  const x = makeConvC({ planImpl: planJs2, generate: stagedGenerate({ C1: ['good'], C2: ['good'] }) });
  const askSignals = []; const ag = K.gate();
  x.services.ask = async (args) => { askSignals.push(args.signal); await ag.p; return { ok: true, answer: { answer: '答えです。', facts: [], analysis: [], recommendations: [], unknowns: [] }, ctx: { facts: [] } }; };
  await sendUntilAdopt(x);
  const v = x.c.activePlan();
  const r = await x.c.send('これで進めて。CSVにも効きますか？');
  await K.ticks(2);
  assert(askSignals.length === 1 && !x.c.isBusy() && x.c.asidesRunning() === 1 && askSignals[0].aborted === false, `T9-3: 前提: 送信が終わっても質問が走っている: ${JSON.stringify({ n: askSignals.length, busy: x.c.isBusy(), running: x.c.asidesRunning(), intent: r && r.intent })}`);
  const stopped = x.c.cancelAsides();
  ag.open(); await sleep(2); await K.ticks(4);
  assert(stopped === 1 && askSignals[0].aborted === true && !x.c.messages().some(m => m.type === 'ANSWER' && m.data && m.data.kind === 'aside-answer') && x.c.activePlan() === v, 'T9-4: ［キャンセル］（cancelAsides）で送信の後の質問も止まり、答えは出さない（最終案は変えない）');
  void v;
});
await section(async () => {
  //   新しい会話で走っている質問を止める
  const x = makeConvC({ planImpl: planJs2, generate: stagedGenerate({ C1: ['good'], C2: ['good'] }) });
  const askSignals = []; const ag = K.gate();
  x.services.ask = async (args) => { askSignals.push(args.signal); await ag.p; return { ok: true, answer: { answer: '答えです。', facts: [], analysis: [], recommendations: [], unknowns: [] }, ctx: { facts: [] } }; };
  await sendUntilAdopt(x);
  await x.c.send('これで進めて。CSVにも効きますか？');
  await K.ticks(2);
  x.c.startNew();
  ag.open(); await sleep(2); await K.ticks(2);
  assert(askSignals.length === 1 && askSignals[0].aborted === true && x.c.asidesRunning() === 0, 'T9-5: 新しい会話で走っている質問を止める');
});

// =========================================================
console.log('\n--- §T10. 呼び出しの記録（end・requestId・transport の時刻。本文なし） ---');
await section(async () => {
  const base = makeGenerate({ sequence: ['good'] });
  const gen = { calls: base.calls, impl: async (args) => {
    if (args.customizationId === 'C1') { const e = aiErr('TIMEOUT'); e.callTrace = { requestId: 'tk-sent-1', limitMs: 320000, transport: { startedAt: 0, headersAt: 1200, firstByteAt: null, endAt: 320000 } }; throw e; }
    return base.impl(args);
  } };
  const x = makeConvC({ planImpl: planJs2, generate: gen });
  await sendUntilAdopt(x);
  const calls = x.c.state.metrics.timings.slice(-1)[0].calls;
  const g = calls.find(c => c.kind === 'generate'), p = calls.find(c => c.kind === 'plan');
  assert(g && g.end === 'unknown' && g.code === 'TIMEOUT' && g.requestId === 'tk-sent-1' && g.limitMs === 320000 && g.transport && g.transport.headersAt === 1200 && g.transport.endAt === 320000 && p && p.end === 'ok' && !('requestId' in p), `T10-1: 生成の時間切れは end unknown・送った requestId と transport の時刻を残す。取れない呼び出しは requestId を付けない: ${JSON.stringify({ g, p: p && { end: p.end, keys: Object.keys(p) } })}`);
  const json = JSON.stringify(x.c.state.metrics.timings.slice(-1)[0]);
  assert(!/承認待ちでは金額を編集不可|function \(event\)|kintone\.events/.test(json), 'T10-2: 呼び出しの記録に本文（依頼・コード）を入れない');
});
await section(async () => {
  //   計画の例外（時間切れ）も呼び出しの記録に残す（end unknown）。既存の計画の［再試行］は今までどおり「採用します」
  const x = makeConvC({ planImpl: () => { throw aiErr('TIMEOUT'); } });
  const r = await sendUntilAdopt(x);
  const tm = x.c.state.metrics.timings.slice(-1)[0];
  const err = x.c.messages().filter(m => m.type === 'ERROR').slice(-1)[0];
  assert(r.error && r.error.code === 'TIMEOUT' && tm.calls.some(c => c.kind === 'plan' && c.end === 'unknown' && c.code === 'TIMEOUT') && err && err.data.retryText === '採用します' && err.data.intent === I.ADOPT_DRAFT && x.c.draft().status === 'open', `T10-3: 計画の時間切れは呼び出しの記録に end unknown・［再試行］は今までどおり「採用します」: ${JSON.stringify(tm.calls)}`);
});

console.log(`\n${state.passed} passed, ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})();
