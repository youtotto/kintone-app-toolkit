// 実機確認（2026-10-10）で見つかった「生成結果が届かない」の回帰（見えないタブの凍結から再開した時の、打ち切りのタイマーと受信の競合。有料の AI は使わない）
//
// 実機の経過: 生成 C1 を送った直後にタブが見えなくなり、ブラウザーがページを凍結した。Gateway は約 126 秒で生成を終えて成功として数えたが、
//   ページは凍結の間に受信を処理できず、再開した時に 330 秒の打ち切りのタイマー（送信から 627 秒後に動いた）が先に動いて、要求を中断し終了不明にした。
//
// 検証内容:
//   §R1 client（KTAiClient.createAiClient）: 打ち切りのタイマーが予定より LATE_TIMER_MS 以上遅れて動いた（凍結からの再開）→ すぐには打ち切らず、
//        RESUME_GRACE_MS の猶予で受信の処理を先に進める。猶予の間に届いた応答を使う（TIMEOUT にしない・猶予のタイマーは片付く）／猶予の間に届かなければ
//        TIMEOUT（details.timerLateMs・送り方の signal を中断）／遅れが LATE_TIMER_MS 未満なら今どおりすぐ TIMEOUT（猶予なし）／TIMEOUT の後に届いた応答は使わない／
//        中断できない送り方（kintone.proxy と同じく signal を無視する）でも、猶予の間に届いた応答を使う
//   §R2 検証の上限（KTAiBudget.wrap）と組み合わせ: 猶予の間に届いた応答は done（使用量で精算・終了不明にしない）／届かなければ unknown（TIMEOUT）。
//        精算は 1 回だけ（done の記録が後から unknown に戻らない）
//   §R3 会話: C1 の生成の打ち切りが遅れて動き、猶予の間に応答が届く → C1 は検証済み・C2 の生成は 1 回だけ・止まらない（未完成の最終案にしない）。
//        猶予の間に届かない → 今までどおり時間切れで止まり、C2 は始めない
//
// 実行方法: node tests/ai-realrun-resume.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const vm = require('vm');
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const T = loadToolkit();
const { KTAiClient, KTAiBudget } = T;
const { assert, state } = makeAssert();
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const { clone, makeConvC, makeGenerate } = K;
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }
const ticks = (n = 6) => K.ticks(n);

const LIMIT = 1000;                        // 要求の打ち切り（longTimeoutMs で明示。ほかのタイマーと区別できる長さ）
const LATE = KTAiClient.LATE_TIMER_MS, GRACE = KTAiClient.RESUME_GRACE_MS;
const MODEL = 'gpt-6.1-sol';
const usage = (i, o) => ({ input_tokens: i, output_tokens: o, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } });
const GEN_RESP = (requestId = 'g-1') => ({ ok: true, contractVersion: '2.1', meta: { requestId, ai: { model: MODEL, usage: usage(1000, 200) } }, generated: { strategy: 'NEW_JS_FILE', targetFile: 'a.js', summary: '承認済みでは金額を編集不可にします。', code: '(function () {\n  \'use strict\';\n})();', patch: null } });
const GCTX = { contextVersion: '1', customization: { customizationId: 'C1', strategy: 'NEW_JS_FILE', requirement: '承認済みでは金額を編集不可にする' } };

/**
 * 打ち切りのタイマーだけを手で動かす（ms === LIMIT のタイマーと、その中で作られた猶予のタイマー）。ほかのタイマーは本物。
 *   fireLimit(late) = 予定より late ms 遅れて動いたことにして（sandbox の Date.now を進める）打ち切りのタイマーを動かす。猶予のタイマーは held に残る
 */
function heldTimers() {
  const sb = T.__sandbox;
  const realST = sb.setTimeout, realCT = sb.clearTimeout;
  const D = vm.runInContext('Date', sb);
  const realNow = D.now;
  let skew = 0, tid = 1e9, capture = false;
  const held = new Map();
  sb.setTimeout = (fn, ms) => { if (ms === LIMIT || capture) { capture = false; const id = ++tid; held.set(id, { fn, ms }); return id; } return realST(fn, ms); };
  sb.clearTimeout = (id) => { if (held.has(id)) { held.delete(id); return; } realCT(id); };
  D.now = () => realNow.call(D) + skew;
  const find = (ms) => [...held].find(([, x]) => x.ms === ms) || null;
  return {
    held, has: (ms) => !!find(ms),
    fireLimit(late) { const h = find(LIMIT); if (!h) return false; held.delete(h[0]); skew += LIMIT + late; capture = true; try { h[1].fn(); } finally { capture = false; } return true; },
    fireGrace() { const h = find(GRACE); if (!h) return false; held.delete(h[0]); skew += GRACE; h[1].fn(); return true; },
    restore() { sb.setTimeout = realST; sb.clearTimeout = realCT; D.now = realNow; },
  };
}
/** 送り方の偽物: resolve() で応答を返す。honorAbort = signal の中断で AbortError（fetch と同じ）。false なら中断を無視（kintone.proxy と同じ） */
function controlledTransport({ honorAbort = true } = {}) {
  const st = { calls: 0, signal: null, resolve: null, settled: false };
  st.send = ({ signal }) => new Promise((res, rej) => {
    st.calls += 1; st.signal = signal;
    st.resolve = (body, status = 200) => { st.settled = true; res({ status, body: JSON.stringify(body) }); };
    if (honorAbort && signal) signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  return st;
}
const settleOf = (p) => p.then(v => ({ v }), e => ({ e }));
const isPending = async (p) => { const mark = {}; const r = await Promise.race([p, Promise.resolve(mark)]); return r === mark; };

(async () => {
// =========================================================
console.log('\n--- §R1. client: 打ち切りのタイマーが遅れて動いたときの猶予 ---');
await section(async () => {
  assert(LATE === 5000 && GRACE === 3000, `R1-0: 遅れの判定 5 秒・猶予 3 秒（1 回だけ）: ${LATE} / ${GRACE}`);
});
await section(async () => {
  //   遅れて動いた → 猶予 → その間に応答 → 成功（TIMEOUT にしない・猶予のタイマーは片付く・中断しない）
  const ht = heldTimers();
  try {
    const tr = controlledTransport();
    const c = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: tr.send, longTimeoutMs: LIMIT });
    const p = settleOf(c.generate({ ctx: GCTX, requestId: 'g-1' }));
    await ticks();
    assert(tr.calls === 1 && ht.has(LIMIT), 'R1-1a: 前提: 送信中で、打ち切りのタイマーがある');
    ht.fireLimit(60000);
    await ticks();
    assert(ht.has(GRACE) && await isPending(p) && tr.signal && !tr.signal.aborted, `R1-1b: 60 秒遅れて動いた打ち切りは、すぐには中断せず猶予のタイマー（${GRACE} ms）を置く: ${JSON.stringify({ grace: ht.has(GRACE), aborted: tr.signal && tr.signal.aborted })}`);
    tr.resolve(GEN_RESP('g-1'));
    const r = await p; await ticks();
    assert(r.v && r.v.code && r.v.strategy === 'NEW_JS_FILE' && !r.e && !ht.has(GRACE) && !tr.signal.aborted, `R1-1c: 猶予の間に届いた応答を使う（TIMEOUT にしない）・猶予のタイマーは片付く: ${JSON.stringify({ err: r.e && r.e.code, grace: ht.has(GRACE) })}`);
  } finally { ht.restore(); }
});
await section(async () => {
  //   遅れて動いた → 猶予の間に届かない → TIMEOUT（遅れた ms・中断）。その後に届いた応答は使わない
  const ht = heldTimers();
  try {
    const tr = controlledTransport();
    const c = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: tr.send, longTimeoutMs: LIMIT });
    const p = settleOf(c.generate({ ctx: GCTX, requestId: 'g-2' }));
    await ticks();
    ht.fireLimit(297000);
    await ticks();
    assert(await isPending(p), 'R1-2a: 猶予の間はまだ決めない');
    ht.fireGrace();
    const r = await p;
    const late = r.e && r.e.details ? r.e.details.timerLateMs : null;
    assert(r.e && r.e.code === 'TIMEOUT' && late >= 297000 && late < 297000 + 2000 && tr.signal.aborted === true && r.e.transport && Number.isFinite(r.e.transport.endAt), `R1-2b: 猶予の間に届かなければ TIMEOUT（遅れた ms を details.timerLateMs に・送り方を中断・transport の時刻つき）: ${JSON.stringify({ code: r.e && r.e.code, late, aborted: tr.signal.aborted })}`);
    tr.resolve(GEN_RESP('g-2'));
    await ticks();
    assert(r.e.code === 'TIMEOUT', 'R1-2c: TIMEOUT の後に届いた応答は使わない（結果は変わらない）');
  } finally { ht.restore(); }
});
await section(async () => {
  //   遅れが 5 秒未満 → 今どおりすぐ TIMEOUT（猶予なし・timerLateMs なし）
  const ht = heldTimers();
  try {
    const tr = controlledTransport();
    const c = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: tr.send, longTimeoutMs: LIMIT });
    const p = settleOf(c.generate({ ctx: GCTX, requestId: 'g-3' }));
    await ticks();
    ht.fireLimit(1500);
    const r = await p;
    assert(r.e && r.e.code === 'TIMEOUT' && !ht.has(GRACE) && !(r.e.details && r.e.details.timerLateMs != null) && tr.signal.aborted === true, `R1-3: 遅れが ${LATE} ms 未満ならすぐ TIMEOUT（猶予なし）: ${JSON.stringify({ code: r.e && r.e.code, grace: ht.has(GRACE) })}`);
  } finally { ht.restore(); }
});
await section(async () => {
  //   中断できない送り方（kintone.proxy と同じく signal を無視）: 猶予の間に届いた応答を使う／届かなければ TIMEOUT で、後から届いた応答は使わない
  const ht = heldTimers();
  try {
    const tr = controlledTransport({ honorAbort: false });
    const c = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: tr.send, longTimeoutMs: LIMIT });
    const p = settleOf(c.plan({ ctx: { facts: [], goal: 'g', contextVersion: '1' }, requestId: 'p-1' }));
    await ticks();
    ht.fireLimit(30000);
    await ticks();
    tr.resolve({ ok: true, contractVersion: '2.1', meta: { requestId: 'p-1', ai: { model: MODEL, usage: usage(500, 100) } }, plan: { goal: 'g', assessment: { summary: 's' }, steps: [] } });
    const r = await p;
    assert(r.v && r.v.goal === 'g' && !r.e, `R1-4a: 中断できない送り方でも、猶予の間に届いた応答を使う: ${JSON.stringify(r.e && r.e.code)}`);
    const tr2 = controlledTransport({ honorAbort: false });
    const c2 = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: tr2.send, longTimeoutMs: LIMIT });
    const p2 = settleOf(c2.plan({ ctx: { facts: [], goal: 'g', contextVersion: '1' }, requestId: 'p-2' }));
    await ticks();
    ht.fireLimit(30000); await ticks(); ht.fireGrace();
    const r2 = await p2;
    tr2.resolve({ ok: true, contractVersion: '2.1', meta: { requestId: 'p-2' }, plan: { goal: 'g', assessment: { summary: 's' }, steps: [] } });
    await ticks();
    assert(r2.e && r2.e.code === 'TIMEOUT', `R1-4b: 猶予の間に届かなければ TIMEOUT・後から届いた応答は使わない: ${JSON.stringify(r2.e && r2.e.code)}`);
  } finally { ht.restore(); }
});

// =========================================================
console.log('\n--- §R2. 検証の上限と組み合わせ: 猶予の間に届いた応答は done（終了不明にしない）---');
const HOST = 't.cybozu.com';
const setConfig = (storage, o = {}) => storage.setItem(`ktAi.budget.v1.${HOST}`, JSON.stringify({ id: 'v1', limitUsd: 10, maxCalls: 100, createdAt: '2026-10-10T00:00:00Z', ...o }));
const ledgerOf = (storage) => { const raw = storage.getItem(`ktAi.budgetLedger.v1.${HOST}.v1`); return raw ? JSON.parse(raw) : null; };
await section(async () => {
  const ht = heldTimers();
  try {
    const storage = K.makeStorage(); setConfig(storage);
    const budget = KTAiBudget.create({ storage, host: HOST, locks: null, sessionId: 'p-r2' });
    const tr = controlledTransport();
    const c = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: tr.send, longTimeoutMs: LIMIT });
    const p = settleOf(budget.wrap(c).generate({ ctx: GCTX, requestId: 'g-b1' }));
    await ticks(10);
    assert(tr.calls === 1 && ledgerOf(storage).entries[0].status === 'in-flight', 'R2-1a: 前提: 確保して送信中');
    ht.fireLimit(120000); await ticks();
    tr.resolve(GEN_RESP('g-b1'));
    const r = await p; await ticks(10);
    const e0 = ledgerOf(storage).entries[0];
    assert(r.v && !r.e && e0.status === 'done' && e0.reservedUsd === 0 && e0.costUsd > 0 && e0.calls.length === 1 && e0.reason == null, `R2-1b: 猶予の間に届いた応答は使用量で精算（done・確保 0）。終了不明にしない: ${JSON.stringify({ status: e0.status, reserved: e0.reservedUsd, cost: e0.costUsd, reason: e0.reason })}`);
    //   後から何が来ても done のまま（打ち切りのタイマーは片付いている）
    await ticks(10);
    assert(ledgerOf(storage).entries[0].status === 'done' && ledgerOf(storage).entries.length === 1 && !ht.has(GRACE) && !ht.has(LIMIT), 'R2-1c: 精算は 1 回だけ（done の記録が後から unknown に戻らない・記録は 1 件）');
  } finally { ht.restore(); }
});
await section(async () => {
  const ht = heldTimers();
  try {
    const storage = K.makeStorage(); setConfig(storage);
    const budget = KTAiBudget.create({ storage, host: HOST, locks: null, sessionId: 'p-r2b' });
    const tr = controlledTransport();
    const c = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: tr.send, longTimeoutMs: LIMIT });
    const p = settleOf(budget.wrap(c).generate({ ctx: GCTX, requestId: 'g-b2' }));
    await ticks(10);
    ht.fireLimit(120000); await ticks(); ht.fireGrace();
    const r = await p; await ticks(10);
    const e0 = ledgerOf(storage).entries[0];
    assert(r.e && r.e.code === 'TIMEOUT' && e0.status === 'unknown' && e0.reservedUsd > 0 && e0.reason === 'TIMEOUT', `R2-2: 猶予の間に届かなければ今までどおり終了不明（確保額を残す）: ${JSON.stringify({ code: r.e && r.e.code, status: e0.status, reason: e0.reason })}`);
  } finally { ht.restore(); }
});

// =========================================================
console.log('\n--- §R3. 会話: C1 の打ち切りが遅れて動いても、猶予の間に届けば C2 へ進む（1 回だけ）---');
const CUST1 = K.custOf(['lock']);
const CUST2 = K.custOf(['lock'], { customizationId: 'C2', requirement: '承認待ちでは金額を編集不可にする（2 つ目の画面）' });
const planJs2 = (args) => {
  const r = K.planJs(args, { cust: CUST1 });
  r.plan.steps.push({ id: 'C2', actionType: 'CUSTOMIZATION_REQUIRED', targetKind: 'JS', targetRef: null, title: 'JavaScript 2', spec: { customizationId: 'C2' }, dependsOn: [] });
  r.plan.customizations.push(clone(CUST2));
  r.review.steps.push({ stepId: 'C2', status: 'VALID', safety: 'PLAN_ONLY', customization: clone(CUST2), codeGeneration: { supported: true, strategy: 'NEW_JS_FILE', reason: null }, issues: [] });
  return r;
};
/** 生成工程の偽物: C1 の最初の呼び出しだけ、実際の client（送り方は手で返す）を通してから検証済みの結果を返す */
function clientGatedGenerate(tr) {
  const base = makeGenerate({ sequence: ['good'] });
  const seen = [];
  let first = true;
  const c = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: tr.send, longTimeoutMs: LIMIT });
  const impl = async (args) => {
    seen.push(args.customizationId);
    if (args.customizationId === 'C1' && first) { first = false; await c.generate({ ctx: GCTX, requestId: 'g-conv', signal: args.signal || null }); }
    return base.impl(args);
  };
  return { impl, calls: base.calls, seen, count: (cid) => seen.filter(x => x === cid).length };
}
const sendUntilAdopt = async (x) => { for (const s of K.REQUESTS.slice(0, 3)) await x.c.send(s); return x.c.send(K.REQUESTS[3]); };
await section(async () => {
  const ht = heldTimers();
  try {
    const tr = controlledTransport();
    const gen = clientGatedGenerate(tr);
    const x = makeConvC({ planImpl: planJs2, generate: gen });
    const p = sendUntilAdopt(x);
    for (let i = 0; i < 60 && !ht.has(LIMIT); i++) await ticks(1);
    assert(gen.count('C1') === 1 && tr.calls === 1 && ht.has(LIMIT), 'R3-1a: 前提: C1 の生成の要求が送信中');
    ht.fireLimit(300000); await ticks();
    tr.resolve(GEN_RESP('g-conv'));
    const r = await p; await ticks(6);
    const v = x.c.activePlan();
    assert(r.ok && v && v.generated.C1 && v.generated.C1.status === 'verified' && v.generated.C2 && v.generated.C2.status === 'verified' && gen.count('C1') === 1 && gen.count('C2') === 1 && v.final && !v.final.incomplete,
      `R3-1b: 猶予の間に届いた C1 を取り込み、C2 の生成は 1 回だけ・未完成の最終案にしない: ${JSON.stringify({ ok: r.ok, c1: v && v.generated.C1 && v.generated.C1.status, c2: v && v.generated.C2 && v.generated.C2.status, seen: gen.seen, incomplete: v && v.final && v.final.incomplete })}`);
  } finally { ht.restore(); }
});
await section(async () => {
  const ht = heldTimers();
  try {
    const tr = controlledTransport();
    const gen = clientGatedGenerate(tr);
    const x = makeConvC({ planImpl: planJs2, generate: gen });
    const p = sendUntilAdopt(x);
    for (let i = 0; i < 60 && !ht.has(LIMIT); i++) await ticks(1);
    ht.fireLimit(300000); await ticks(); ht.fireGrace();
    const r = await p; await ticks(6);
    tr.resolve(GEN_RESP('g-conv')); await ticks(6);
    const v = x.c.activePlan();
    assert(v && v.final && v.final.incomplete && v.final.incomplete.kind === 'timeout' && gen.count('C2') === 0 && v.generated.C1.status === 'failed',
      `R3-2: 猶予の間に届かなければ今までどおり時間切れで止まり、C2 は始めない（後から届いた応答で版を変えない）: ${JSON.stringify({ ok: r.ok, inc: v && v.final && v.final.incomplete && v.final.incomplete.kind, seen: gen.seen, c1: v && v.generated.C1 && v.generated.C1.status })}`);
  } finally { ht.restore(); }
});

console.log(`\n${state.passed} passed, ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})();
