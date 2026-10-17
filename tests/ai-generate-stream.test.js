// 生成の停滞を観測できるようにし、未完了分から再開する（2026-10-14・指示書 §5。契約 20 §18 の progress）。有料の AI は使わない。
//
// 検証内容:
//   §S1 client: health の customization-generator.stream に progress があるときだけ Accept: text/event-stream を付けて onEvent を受ける（偽の fetch の SSE を
//        実際の createAiClient + createDefaultTransport で読む）。無いときは Accept 無し・JSON のまま。trace.progress は相対 ms と受けた数だけ（本文なし）。
//        keepalive のコメント・`: start` は AI の進捗に数えない（transport の firstByteAt は付くが textAt は null のまま）。画面は印のある接続先にだけ onEvent を渡す。
//        progress の相対 ms の起点は transport と同じ（token を取った後。trace.origin は記録に写さない）。trace.via = 受けた経路（direct / direct-stream / proxy）
//   §S2 progress → 進みのカードの段階 generate の文: sent で「コードを生成しています」・verify の start で「コードを確認しています」・修復は「コードを直しています（n 回目）」・
//        最初の本文断片が届かないまま普段の所要時間（timingStore の推定。テストでは storage の値）を過ぎると「応答に時間がかかっています」・本文が届けば戻る。
//        response.created（started）は本文ではない。段階の構造は変えない。質問は増やさない
//   §S3 画面（実際の client・偽の Gateway）: SSE の event: error（502 UPSTREAM_ERROR detail timeout）→ 時間切れとして送信を止める（後続の JavaScript 0 件）・
//        未完成の最終案・検証の上限の記録（KTAiBudget）の確保は unknown のまま（解放しない）
//   §S4 画面: done が無いまま SSE が終わる → TRANSPORT_ERROR → 切断として止める・終了不明。正常な SSE（progress → done）では承認できる最終案（途中の断片は候補にしない）
//   §S5 3 本の JavaScript（C1・C2 検証済み・C3 時間切れ）→ 未完成の最終案の文に「残り 1 件」「検証済みの JavaScript 2 件」→ ［残りの JavaScript を作る］で
//        計画の AI 0 回・C1 / C2 は流用（reused）・C3 だけ生成 → 承認できる最終案（ai-realrun-abort §T3 の 3 本版）。
//        残りの件数は検証済みでない数（止める前に別の理由で生成できなかった JavaScript も数え、文の件数と押した後の生成の呼び出しの数が一致する）
//   §S6 呼び出しの記録（timing.calls[]）に progress の相対 ms が入り、本文が入らない
//   §S7 印のある接続先で JSON の 4xx が返った要求の記録: via は direct・progress は付かない（SSE で受けた要求だけ via direct-stream と progress）
//
// 実行方法: node tests/ai-generate-stream.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { gwCandidateHash } = require('./helpers/gw-hash.js');
const T = loadToolkit();
const { KTAiConversation, KTAiClient, KTAiBudget, KTAiChatUi, KTContext, KTScan } = T;
const { assert, state } = makeAssert();
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const FX = require('./fixtures/ai-context-app.js');
const { clone, makeConvC, makeGenerate, stripC, finalHtml } = K;
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const I = KTAiConversation.INTENT;
const HOST = 't.cybozu.com';
const MODEL = 'gpt-6.1-sol';
//   検証の上限（KTAiBudget）を使う節のため、偽の応答のモデルを単価の表にあるモデルにする（ai-realrun-budget と同じ）
K.META.ai.model = MODEL; K.PLAN_META.ai.model = MODEL;
const usage = (i, o) => ({ input_tokens: i, output_tokens: o, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } });
const aiErr = (code, o = {}) => new KTAiClient.AiClientError({ code, message: o.message || `テスト: ${code}`, ...(o.details ? { details: o.details } : {}) });
/** Gateway の期限（契約 20 §16）のエラー本文（Toolkit の stopKindOf が timeout と読む形） */
const UPSTREAM_TIMEOUT_BODY = { ok: false, error: { code: 'UPSTREAM_ERROR', message: 'AI プロバイダが時間内に応答しませんでした', detail: 'timeout' } };
const visibleText = (h) => stripC(String(h).replace(/<details[\s\S]*?<\/details>/g, ''));
const restButtonOf = (h) => { const m = /<button[^>]*data-act="choice"[^>]*data-intent="GENERATE_CODE"[^>]*>([^<]*)<\/button>/.exec(h); return m ? { html: m[0], disabled: /\sdisabled/.test(m[0]) } : null; };
const pressRest = (x) => x.c.send('コードを作って', { intentOverride: I.GENERATE_CODE, displayText: '残りの JavaScript を作る' });
const sendUntilAdopt = async (x) => { for (const s of K.REQUESTS.slice(0, 3)) await x.c.send(s); return x.c.send(K.REQUESTS[3]); };
/** 本文（依頼・コード・フィールド）が記録に入っていないか */
const NO_BODY = /承認待ちでは|function \(event\)|kintone\.events|record\[|case_name|disabled = true/;

// ---- 部品: SSE の偽の Response（実際の readSseResponse が読む）----
const enc = new TextEncoder();
/**
 * SSE の本文を blocks の順に 1 ブロックずつ流す偽の Response。文字列はそのまま（`: keepalive` などのコメント）、{ event, data } は event: / data: の 2 行。
 *   step(block, i) = ブロックを渡す前に待つ（時間差・途中の観測）。end = 'close'（普通に終わる）| 'error'（本文の読み取りが例外で終わる = 途中切断）
 */
function sseResponse(blocks, { status = 200, step = null, end = 'close' } = {}) {
  let i = 0;
  const chunkOf = (b) => (typeof b === 'string' ? `${b}\n\n` : `event: ${b.event}\ndata: ${JSON.stringify(b.data)}\n\n`);
  return { status, headers: { get: (k) => (/content-type/i.test(k) ? 'text/event-stream; charset=utf-8' : null) }, body: { getReader: () => ({ read: async () => {
    if (i >= blocks.length) { if (end === 'error') throw new TypeError('network error'); return { value: undefined, done: true }; }
    const b = blocks[i++];
    if (step) await step(b, i - 1);
    return { value: enc.encode(chunkOf(b)), done: false };
  } }) } };
}
const jsonResponse = (status, obj) => ({ status, headers: { get: (k) => (/content-type/i.test(k) ? 'application/json' : null) }, text: async () => JSON.stringify(obj) });
/** 進みの通知（契約 20 §18）。attempt は generate 0・repair は修復の回数 */
const PG = (stage, phase, extra = {}) => ({ event: 'progress', data: { stage, attempt: stage === 'repair' ? 1 : 0, phase, t: 0, ...extra } });
/** 生成工程の正常な SSE（送信 → 見出し → 最初のイベント → keepalive → 本文 → 断片 → 完了 → 検証 → done） */
const okBlocks = (doneBody, { beforeText = [] } = {}) => [': start', PG('generate', 'sent'), PG('generate', 'headers'), PG('generate', 'started'), ': keepalive', ...beforeText, PG('generate', 'text'), PG('generate', 'delta', { chars: 240 }), PG('generate', 'done', { ok: true, end: 'completed' }), PG('verify', 'start'), PG('verify', 'done', { passed: true, behavior: 'passed' }), { event: 'done', data: doneBody }];
/** 生成工程の応答（契約の形。validateGenerated を通す）。field = Generator Context の CONTROL のフィールド。timing = meta.timing（契約 20 §15。2026-10-15 §1.5 の upstream の回帰で渡す） */
function genDone(ctx, requestId, { timing = null } = {}) {
  const cust = ctx.customization || {};
  const cid = cust.customizationId || 'C1';
  const field = ((cust.fields || []).find(f => f.access === 'CONTROL') || {}).code || 'case_name';
  const code = K.lockCode(field);
  const targetFile = `${cid.toLowerCase()}Lock.js`;
  const req0 = (ctx.verification && ctx.verification.requiredEffects) || [];
  const candidateHash = gwCandidateHash({ strategy: 'NEW_JS_FILE', targetFile, code, customizationId: cid });
  return { ok: true, contractVersion: '2.1', meta: { requestId, gateway: { product: 'toolkit', feature: 'customization-generator', promptVersion: '1', contextVersion: 'customization-1' }, normalization: { warnings: [] }, ai: { model: MODEL, latencyMs: 40000, streamed: true, usage: usage(3000, 700) }, ...(timing ? { timing } : {}) },
    generated: { strategy: 'NEW_JS_FILE', targetFile, summary: '承認待ちでは編集できないようにします。', code, patch: null, events: ['app.record.edit.show'], fields: [{ code: field, access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], coverage: [{ requirementId: cid, status: 'MET', note: '' }] },
    verification: K.fakeVerification({ code, has: { [field]: ['lock'] } }, req0, { candidateHash }) };
}
/** health: 生成工程に進みの通知の印（stream: ['progress']）。無印の接続先は K.HEALTH_V のまま */
const HEALTH_S = (() => { const h = clone(K.HEALTH_V); h.registry.toolkit['customization-generator'].stream = ['progress']; return h; })();
/** 画面の計画: 案件名と金額を承認待ちで編集不可にする 2 本の JavaScript（C1・C2） */
const planRaw2 = (goal) => {
  const b = K.screenPlan('js')(goal);
  b.plan.steps.push(K.mkStep('C2', 'CUSTOMIZATION_REQUIRED', 'JS', null, { customizationId: 'C2' }, { title: 'JavaScript 2', solution: 'CUSTOMIZATION' }));
  b.plan.customizations.push(K.custLock('amount', { customizationId: 'C2', requirement: '承認待ちでは金額を編集できないようにする' }));
  return b;
};
/**
 * 偽の Gateway（fetch）。実際の KTAiClient.createAiClient + createDefaultTransport を通す。GET /v2/health → health。POST /v2/review は envelope の feature で分岐:
 *   assistant-qa の仮案 = 台本（K.script。Accept が SSE なら event: delta → done = 会話の逐次表示の経路）/ change-planner = planRaw(goal) / customization-generator = onGenerate({ ctx, requestId, accept })
 */
function fakeGateway({ health = HEALTH_S, planRaw = planRaw2, onGenerate }) {
  const seen = { health: 0, propose: [], plan: [], generate: [], ask: 0 };
  const fetchFn = async (url, init = {}) => {
    const accept = (init.headers || {})['Accept'] || null;
    if (/\/v2\/health$/.test(url)) { seen.health += 1; return jsonResponse(200, health); }
    const env = JSON.parse(init.body);
    const feature = env.meta.feature, ctx = env.payload, requestId = env.meta.requestId;
    if (feature === 'assistant-qa') {
      if (ctx.conversation && ctx.conversation.mode === 'proposal') {
        seen.propose.push({ accept });
        const raw = K.script({ utterance: ctx.question, previous: ctx.conversation.proposal, requirements: ctx.conversation.requirements });
        if (!raw) return jsonResponse(500, { ok: false, error: { code: 'INTERNAL_ERROR', message: `台本がありません: ${ctx.question}` } });
        const body = { ok: true, contractVersion: '2.1', meta: { ...K.META, requestId }, ...raw };
        if (/text\/event-stream/.test(accept || '')) return sseResponse([': start', { event: 'delta', data: { text: raw.reply.slice(0, 8) } }, { event: 'delta', data: { text: raw.reply.slice(8) } }, { event: 'done', data: body }]);
        return jsonResponse(200, body);
      }
      seen.ask += 1;
      return jsonResponse(200, K.answerFor(ctx, '答えです。'));
    }
    //   2026-10-15（追加の指示 1）: 偽の計画の AI は要件の対応づけ（turn.requirementOps）を返す（K.rawWithPlannerMapping）
    if (feature === 'change-planner') { seen.plan.push({ accept }); return jsonResponse(200, K.rawWithPlannerMapping({ ...planRaw(ctx.goal), meta: { ...K.PLAN_META, requestId } }, ctx)); }
    if (feature === 'customization-generator') { const rec = { accept, ctx, requestId }; seen.generate.push(rec); return onGenerate(rec); }
    return jsonResponse(500, { ok: false, error: { code: 'INTERNAL_ERROR', message: `unknown feature ${feature}` } });
  };
  return { fetchFn, seen };
}
/** 画面を実際の client（偽の Gateway）で開き、台本の 4 発言で最終案まで進める */
async function mountReal({ health = HEALTH_S, planRaw = planRaw2, onGenerate, budget = undefined } = {}) {
  const gw = fakeGateway({ health, planRaw, onGenerate });
  const client = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: HOST, transport: KTAiClient.createDefaultTransport({ kintoneApi: null, fetchFn: gw.fetchFn }) });
  const m = K.mount({ health, clientWrap: () => client, ...(budget !== undefined ? { extra: { budget } } : {}) });
  await K.ticks();
  await K.adoptOnScreen(m);
  await K.waitUntil(() => { const v = m.conv().activePlan(); return !!(v && v.final); }, 600); await K.ticks(10);
  return { m, gw, client, v: m.conv().activePlan() };
}
const CFG_KEY = `ktAi.budget.v1.${HOST}`;
const ledgerKey = (id = 'v1') => `ktAi.budgetLedger.v1.${HOST}.${id}`;
const mkBudget = ({ limitUsd = 5 } = {}) => { const storage = K.makeStorage(); storage.setItem(CFG_KEY, JSON.stringify({ id: 'v1', limitUsd, maxCalls: 100, createdAt: '2026-10-14T00:00:00Z' })); return { storage, budget: KTAiBudget.create({ storage, host: HOST, locks: null, sessionId: 'p-stream' }) }; };
const ledgerOf = (storage) => { const raw = storage.getItem(ledgerKey()); return raw ? JSON.parse(raw) : null; };
const lastCalls = (conv) => conv.state.metrics.timings.slice(-1)[0].calls;
// ---- 部品: 3 本の JavaScript の計画（C1・C2・C3。ai-realrun-abort の planJs2 の 3 本版）と、cid ごとの振る舞いの偽の生成工程 ----
const CUST1 = K.custOf(['lock']);
const CUST2 = K.custOf(['lock'], { customizationId: 'C2', requirement: '承認待ちでは金額を編集不可にする（2 つ目の画面）' });
const CUST3 = K.custOf(['lock'], { customizationId: 'C3', requirement: '承認待ちでは金額を編集不可にする（3 つ目の画面）' });
const planJs3 = (args) => {
  const r = K.planJs(args, { cust: CUST1 });
  for (const c of [CUST2, CUST3]) {
    //   2026-10-14: 作成途中のカードは計画の手順の title で JavaScript を呼ぶので、業務の名前を付ける（内部の番号を title に入れない）
    r.plan.steps.push({ id: c.customizationId, actionType: 'CUSTOMIZATION_REQUIRED', targetKind: 'JS', targetRef: null, title: c.customizationId === 'C2' ? 'モバイルの編集制御' : 'モバイルの入力チェック', spec: { customizationId: c.customizationId }, dependsOn: [] });
    r.plan.customizations.push(clone(c));
    r.review.steps.push({ stepId: c.customizationId, status: 'VALID', safety: 'PLAN_ONLY', customization: clone(c), codeGeneration: { supported: true, strategy: 'NEW_JS_FILE', reason: null }, issues: [] });
    r.review.executionReadiness.planOnlySteps.push(c.customizationId);
  }
  return r;
};
/** 偽の生成工程（cid ごとの振る舞い。'throw:<code>' = その code を投げる / 'good' = 検証済み）。ai-realrun-abort の stagedGenerate と同じ作法 */
function stagedGenerate(plan) {
  const base = makeGenerate({ sequence: ['good'] });
  const seen = [], n = {};
  const impl = async (args) => {
    const cid = args.customizationId;
    n[cid] = (n[cid] || 0) + 1;
    const list = plan[cid] || ['good'];
    const what = list[Math.min(n[cid] - 1, list.length - 1)];
    seen.push({ cid, what });
    if (/^throw:/.test(what)) throw aiErr(what.slice(6));
    return base.impl(args);
  };
  return { impl, calls: base.calls, seen, count: (cid) => seen.filter(x => x.cid === cid).length };
}

(async () => {
// =========================================================
console.log('\n--- §S1. client: 印のある接続先だけ Accept を付けて progress を受ける（実際の client + transport。偽の fetch の SSE） ---');
const GCTX = KTContext.buildGenerator({ customization: { customizationId: 'C1', requirement: '承認待ちでは金額を編集不可', whyStandardInsufficient: 'w', strategy: 'NEW_JS_FILE', platform: ['desktop'], implementation: 'JAVASCRIPT', events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [] }, plan: { goal: 'g', steps: [] }, planId: 'p', version: 1, data: FX.makeData() });
await section(async () => {
  //   onEvent あり: Accept が付き、SSE の progress が onEvent に届く（done / error は届かない）。trace.progress は相対 ms と受けた数だけ。順序は sent ≤ headers ≤ started ≤ text ≤ last ≤ done ≤ verify ≤ verifyDone
  const headersSeen = [];
  const fetchFn = async (url, init) => { headersSeen.push({ ...init.headers }); const requestId = JSON.parse(init.body).meta.requestId; return /text\/event-stream/.test(init.headers.Accept || '') ? sseResponse(okBlocks(genDone(GCTX, requestId), { beforeText: [': keepalive'] }), { step: (b, i) => (i === 6 ? sleep(6) : sleep(1)) }) : jsonResponse(200, genDone(GCTX, requestId)); };
  const c = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: HOST, transport: KTAiClient.createDefaultTransport({ kintoneApi: null, fetchFn }) });
  const events = []; const trace = {};
  const g = await c.generate({ ctx: GCTX, trace, onEvent: (ev) => events.push(`${ev.event}:${ev.data && ev.data.stage}:${ev.data && ev.data.phase}`) });
  const pg = trace.progress;
  const order = pg ? [pg.sentAt, pg.headersAt, pg.startedAt, pg.textAt, pg.lastAt, pg.doneAt, pg.verifyAt, pg.verifyDoneAt] : [];
  const monotone = order.every((v, i) => Number.isFinite(v) && (i === 0 || v >= order[i - 1]));
  assert(headersSeen[0].Accept === 'text/event-stream' && g && typeof g.code === 'string' && events.join(',') === 'progress:generate:sent,progress:generate:headers,progress:generate:started,progress:generate:text,progress:generate:delta,progress:generate:done,progress:verify:start,progress:verify:done', `S1-1: onEvent があれば Accept: text/event-stream を付け、progress だけが onEvent に届く（done / error は従来の本文・エラーになる）: ${JSON.stringify({ accept: headersSeen[0].Accept, events })}`);
  assert(pg && monotone && pg.events === 8 && Object.keys(pg).sort().join(',') === 'deltaEvents,doneAt,events,headersAt,lastAt,sentAt,startedAt,textAt,textChars,verifyAt,verifyDoneAt' && pg.textChars === 240 && pg.deltaEvents === 2 && pg.textAt - pg.startedAt >= 5 && !NO_BODY.test(JSON.stringify(trace)), `S1-2: trace.progress は相対 ms（送信 ≤ 見出し ≤ 最初のイベント ≤ 最初の本文 ≤ 最後の進捗 ≤ 完了 ≤ 検証の前後）と受けた数・本文の文字数の累計（textChars = 最後の delta の chars）・断片の通知の数（deltaEvents）だけ。本文の遅い応答では textAt が startedAt より後。本文は入らない: ${JSON.stringify(pg)}`);
  assert(trace.transport && trace.transport.firstByteAt != null && trace.transport.firstByteAt <= pg.sentAt, `S1-3: transport の firstByteAt は \`: start\` のコメントで付く（AI の進捗の時刻ではない。progress の sentAt より前）: ${JSON.stringify({ transport: trace.transport, sentAt: pg.sentAt })}`);
  //   onEvent なし: Accept 無し・JSON のまま（従来の経路）。trace.progress は作らない
  headersSeen.length = 0;
  const trace2 = {};
  const g2 = await c.generate({ ctx: GCTX, trace: trace2 });
  assert(!('Accept' in headersSeen[0]) && g2 && typeof g2.code === 'string' && trace2.progress === undefined && Object.keys(trace2).sort().join(',') === 'limitMs,transport,via' && trace2.via === 'direct', `S1-4: onEvent が無ければ Accept を付けず JSON のまま（従来の経路）。trace に progress は作らない（via は direct）: ${JSON.stringify({ headers: Object.keys(headersSeen[0]), keys: Object.keys(trace2), via: trace2.via })}`);
});
await section(async () => {
  //   keepalive だけの間（開始通知の後、本文が来ない）: コメントは onEvent に届かず、textAt は null のまま（進捗に数えない）。本文が届けば textAt が付く
  let snap = null; const events = []; const trace = {};
  const blocks = [': start', PG('generate', 'sent'), PG('generate', 'headers'), PG('generate', 'started'), ': keepalive', ': keepalive', ': keepalive', PG('generate', 'text'), PG('generate', 'done', { ok: true, end: 'completed' }), PG('verify', 'start'), PG('verify', 'done', { passed: true }), null];
  const fetchFn = async (url, init) => { const requestId = JSON.parse(init.body).meta.requestId; blocks[blocks.length - 1] = { event: 'done', data: genDone(GCTX, requestId) }; return sseResponse(blocks, { step: async (b, i) => { if (i === 7) snap = { textAt: trace.progress.textAt, lastAt: trace.progress.lastAt, events: trace.progress.events, received: events.length, firstByteAt: trace.transport.firstByteAt }; await sleep(1); } }); };
  const c = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: HOST, transport: KTAiClient.createDefaultTransport({ kintoneApi: null, fetchFn }) });
  await c.generate({ ctx: GCTX, trace, onEvent: (ev) => events.push(ev.event) });
  assert(snap && snap.textAt === null && snap.events === 3 && snap.received === 3 && snap.firstByteAt != null && snap.lastAt === trace.progress.startedAt && trace.progress.textAt != null && events.every(e => e === 'progress'), `S1-5: keepalive のコメントは onEvent に届かず進捗に数えない（開始通知の後も textAt は null・最後の進捗は started のまま）。本文が届いてから textAt: ${JSON.stringify({ snap, after: trace.progress })}`);
});
await section(async () => {
  //   画面: health の customization-generator.stream に progress がある接続先にだけ onEvent を渡す（無い接続先 = 古い Gateway には渡さない = Accept が付かない）
  const run = async (health) => {
    const sg = K.screenGenerate({ field: 'case_name', targetFile: 'caseLock.js' });
    const seen = [];
    const m = K.mount({ health, planImpl: K.planImplOf(K.screenPlan('js')), generateImpl: (a) => { seen.push({ onEvent: typeof a.onEvent, keys: Object.keys(a).sort().join(',') }); return sg.impl(a); } });
    await K.ticks();
    const v = await K.adoptOnScreen(m); await K.ticks(20);
    return { seen, v };
  };
  const withMark = await run(HEALTH_S), without = await run(K.HEALTH_V);
  assert(withMark.seen.length === 1 && withMark.seen[0].onEvent === 'function' && withMark.v && withMark.v.final && withMark.v.final.approvable === true, `S1-6: 印のある接続先: 画面の generate は client に onEvent を渡す（最終案は今までどおり承認できる）: ${JSON.stringify(withMark.seen)}`);
  assert(without.seen.length === 1 && without.seen[0].onEvent === 'undefined' && !/onEvent/.test(without.seen[0].keys) && without.v && without.v.final && without.v.final.approvable === true, `S1-7: 印の無い接続先（古い Gateway）: onEvent を渡さない（Accept を付けない・JSON のまま）: ${JSON.stringify(without.seen)}`);
});
await section(async () => {
  //   レビューの指摘 3（2026-10-14）: progress の相対 ms の起点は transport と同じ（rawRequest の t0 = token を取った後）。偽の getToken に待ちを入れても、
  //   transport.headersAt と progress.headersAt の差に token の取得時間が入らない。起点（trace.origin）は列挙しない（記録・JSON に写さない）
  const TOKEN_WAIT_MS = 300;
  const fetchFn = async (url, init) => { const requestId = JSON.parse(init.body).meta.requestId; return sseResponse(okBlocks(genDone(GCTX, requestId)), { step: () => sleep(1) }); };
  const c = KTAiClient.createAiClient({ apiBase: 'https://gw.test', getToken: async () => { await sleep(TOKEN_WAIT_MS); return 't'; }, hostname: HOST, transport: KTAiClient.createDefaultTransport({ kintoneApi: null, fetchFn }) });
  const trace = {};
  const g = await c.generate({ ctx: GCTX, trace, onEvent: () => { } });
  const pg = trace.progress, tm = trace.transport;
  const gap = pg && tm && Number.isFinite(pg.headersAt) && Number.isFinite(tm.headersAt) ? pg.headersAt - tm.headersAt : null;
  assert(g && typeof g.code === 'string' && Number.isFinite(trace.origin) && !Object.keys(trace).includes('origin') && !/origin/.test(JSON.stringify(trace)) && gap != null && gap >= 0 && gap < TOKEN_WAIT_MS / 2 && pg.sentAt >= 0 && tm.headersAt <= pg.sentAt && pg.sentAt <= pg.headersAt && trace.via === 'direct-stream', `S1-8: progress の相対 ms は transport と同じ起点（token を取った後）。transport.headersAt と progress.headersAt の差に token の取得時間（${TOKEN_WAIT_MS}ms）を含めない。起点は記録に写さない: ${JSON.stringify({ gap, transport: tm, progress: pg, via: trace.via, keys: Object.keys(trace) })}`);
});

// =========================================================
console.log('\n--- §S2. progress → 進みのカードの段階 generate の文（生成 / 確認 / 直す / 時間がかかっています） ---');
await section(async () => {
  //   普段の所要時間（timingStore の推定）: storage の実測 20 秒。既定（30 秒）は実測が無いときだけ
  const storage = K.makeStorage(); storage.setItem('ktAi.timing.v1', JSON.stringify({ generate: { avg: 20000, n: 1 } }));
  const g = K.gate(); let onProgress = null;
  const base = makeGenerate({ sequence: ['good'] });
  const gen = { calls: base.calls, impl: async (args) => { onProgress = args.onProgress; await g.p; return base.impl(args); } };
  const x = makeConvC({ planImpl: (args) => K.planJs(args), generate: gen, storage });
  for (const s of K.REQUESTS.slice(0, 3)) await x.c.send(s);
  const p = x.c.send(K.REQUESTS[3]);
  await K.waitUntil(() => typeof onProgress === 'function', 200);
  const stage = () => x.c.progress().stages.find(s => s.key === 'generate');
  const pm = () => x.c.messages().find(m => m.data && m.data.kind === 'progress');
  assert(typeof onProgress === 'function' && stage() && stage().state === 'active' && stage().detail === '', 'S2-0: 前提: 生成中（会話は services.generate に onProgress を渡す。通知の前の文は空）');
  onProgress({ stage: 'generate', attempt: 0, phase: 'sent', t: 0 });
  const w0 = x.c.progress().aiWait;
  assert(stage().detail === 'コードを生成しています' && w0 && w0.sentAt === x.clock() && w0.textAt === null && w0.slowAfterMs === 20000, `S2-1: sent → 「コードを生成しています」。進みのカードの data に aiWait（送った時刻・本文の印・普段の所要時間 20 秒）: ${JSON.stringify({ detail: stage().detail, aiWait: w0 })}`);
  x.advance(5000); onProgress({ stage: 'generate', attempt: 0, phase: 'headers', t: 5000 }); onProgress({ stage: 'generate', attempt: 0, phase: 'started', t: 5100 });
  assert(stage().detail === 'コードを生成しています' && x.c.progress().aiWait.textAt === null, 'S2-2: 見出し・最初のイベント（response.created）は本文ではない → 文は変わらず、本文の印も付かない');
  x.advance(14000); x.c.tickProgress();
  assert(stage().detail === 'コードを生成しています', 'S2-3: 普段の所要時間（20 秒）の手前（19 秒）では「応答に時間がかかっています」にしない');
  x.advance(2000); x.c.tickProgress();
  const h = KTAiChatUi.progressInnerHtml(pm());
  assert(stage().detail === '応答に時間がかかっています' && /応答に時間がかかっています/.test(h) && /「JavaScript」を作っています/.test(h) && !/Gateway|provider|SSE|timeout/i.test(stripC(h)), `S2-4（2026-10-14: 段階の名前は手順の title）: 本文が届かないまま普段の所要時間を過ぎると、1 秒ごとの描き直しで「応答に時間がかかっています」（段階の見出し・構造はそのまま。部品名・英語は出さない）: ${stripC(h).replace(/\s+/g, ' ').slice(0, 160)}`);
  onProgress({ stage: 'generate', attempt: 0, phase: 'text', t: 21000 });
  assert(stage().detail === 'コードを生成しています' && x.c.progress().aiWait.textAt === x.clock(), 'S2-5: 最初の本文断片が届けば「コードを生成しています」に戻る（本文の印が付く）');
  x.advance(30000); x.c.tickProgress(); onProgress({ stage: 'generate', attempt: 0, phase: 'delta', t: 51000, chars: 500 });
  assert(stage().detail === 'コードを生成しています' && x.c.progress().stages.map(s => s.key).join(',') === 'plan,generate,summarize', 'S2-6: 本文が届いた後は時間が経っても「時間がかかっています」にしない（進んでいる）。段階は増えない');
  onProgress({ stage: 'generate', attempt: 0, phase: 'done', t: 52000, ok: true, end: 'completed' });
  onProgress({ stage: 'verify', attempt: 0, phase: 'start', t: 52100 });
  assert(stage().detail === 'コードを確認しています' && x.c.progress().aiWait === null, 'S2-7: verify の start → 「コードを確認しています」（AI の応答待ちの印は消す）');
  x.advance(40000); x.c.tickProgress();
  assert(stage().detail === 'コードを確認しています', 'S2-8: 確認の間は時間が経っても「応答に時間がかかっています」にしない（AI の応答待ちではない）');
  onProgress({ stage: 'verify', attempt: 0, phase: 'done', t: 60000, passed: false, behavior: 'failed' });
  onProgress({ stage: 'repair', attempt: 1, phase: 'sent', t: 60100 });
  assert(stage().detail === 'コードを直しています（1 回目）' && x.c.progress().aiWait && x.c.progress().aiWait.textAt === null, 'S2-9: 修復の sent → 「コードを直しています（1 回目）」');
  x.advance(25000); x.c.tickProgress();
  assert(stage().detail === '応答に時間がかかっています', 'S2-10: 修復の呼び出しでも同じ判定（本文が届かないまま普段の所要時間を過ぎた）');
  onProgress({ stage: 'repair', attempt: 1, phase: 'text', t: 85000 });
  assert(stage().detail === 'コードを直しています（1 回目）', 'S2-11: 修復の本文が届けば「コードを直しています（1 回目）」に戻る');
  onProgress({ stage: 'repair', attempt: 1, phase: 'done', t: 90000, ok: true, end: 'completed' }); onProgress({ stage: 'verify', attempt: 1, phase: 'start', t: 90100 }); onProgress({ stage: 'verify', attempt: 1, phase: 'done', t: 91000, passed: true, behavior: 'passed' });
  onProgress({ stage: 'other', phase: 'x' }); onProgress(null); onProgress('keepalive');
  const keys = x.c.progress().stages.map(s => `${s.key}:${s.state}`).join(',');
  g.open(); const r = await p; await K.ticks(6);
  const v = x.c.activePlan();
  assert(r.ok && keys === 'plan:done,generate:active,summarize:todo' && x.c.progress() === null && v.final.approvable === true && x.calls.ask.length === 0 && (v.openQuestions || []).length === 0 && !x.c.messages().some(m => m.type === 'ERROR'), `S2-12: 知らない通知は無視・段階の構造は変えない（計画 → generate → summarize）・完了で進みのカードは消える・質問は増えない: ${JSON.stringify({ keys, final: v.final && v.final.approvable })}`);
});

// =========================================================
console.log('\n--- §S3. 画面（実際の client・偽の Gateway）: SSE の event: error（502 UPSTREAM_ERROR detail timeout）→ 時間切れとして止める・台帳の確保は unknown ---');
await section(async () => {
  const { storage, budget } = mkBudget({ limitUsd: 5 });
  const onGenerate = ({ requestId }) => sseResponse([': start', PG('generate', 'sent'), PG('generate', 'headers'), PG('generate', 'started'), ': keepalive', { event: 'error', data: { status: 502, body: JSON.stringify({ ...UPSTREAM_TIMEOUT_BODY, meta: { requestId } }) } }], { step: () => sleep(1) });
  const { m, gw, v } = await mountReal({ onGenerate, budget });
  const fin = v && v.final;
  const chat = m.chat(), vis = visibleText(chat);
  const gEntry = ledgerOf(storage) ? ledgerOf(storage).entries.find(e => e.kind === 'generate') : null;
  assert(gw.seen.generate.length === 1 && gw.seen.generate[0].accept === 'text/event-stream' && gw.seen.generate[0].ctx.customization.customizationId === 'C1' && gw.seen.plan.length === 1 && gw.seen.ask === 0, `S3-1: 生成の要求は Accept: text/event-stream で 1 件（C1）だけ。C2 は送らない（後続 0）・計画の AI は増えない: ${JSON.stringify({ gen: gw.seen.generate.map(g => [g.ctx.customization.customizationId, g.accept]), plan: gw.seen.plan.length })}`);
  assert(fin && fin.approvable === false && fin.incomplete && fin.incomplete.kind === 'timeout' && fin.incomplete.stoppedAt === 'C1' && JSON.stringify(fin.incomplete.notStarted) === '["C2"]' && v.generated.C1.status === 'failed' && v.generated.C1.failure.stop === 'timeout' && v.generated.C1.failure.endUnknown === true && !v.generated.C2, `S3-2: SSE の error（Gateway の期限）は時間切れ（stopKindOf timeout）→ 未完成の最終案（止めた C1・作っていない C2・終了不明）: ${JSON.stringify(fin && fin.incomplete)}`);
  const b = restButtonOf(chat);
  //   2026-10-14 の設計し直し（指示書 §1.4）: 作成途中のカード（できたもの・止めたもの・理由・残りの件数。「未完成」の見出しと説明の文は無い）
  assert(/作成途中/.test(vis) && !/未完成/.test(vis) && b && !b.disabled && /まだできた JavaScript はありません。JavaScriptの作成中に、AIの応答が時間切れになりました。JavaScript 2は手を付けていません。/.test(vis) && /残り 2 件から再開できます/.test(vis) && (v.openQuestions || []).length === 0, `S3-3: 次の操作は［残りの JavaScript を作る］1 つ（残り 2 件・できた JavaScript は無し）。質問は増やさない: ${vis.replace(/\s+/g, ' ').slice(0, 240)}`);
  assert(gEntry && gEntry.status === 'unknown' && gEntry.reservedUsd > 0 && gEntry.reason === 'UPSTREAM_ERROR' && /終了不明 1 件/.test(stripC(m.$('kt-ai-header').innerHTML)), `S3-4: 検証の上限の記録: 生成の確保は unknown のまま（解放しない・費用は未確定）: ${JSON.stringify(gEntry && [gEntry.status, gEntry.reservedUsd, gEntry.reason])}`);
  const call = lastCalls(m.conv()).find(c => c.kind === 'generate');
  assert(call && call.end === 'unknown' && call.code === 'UPSTREAM_ERROR' && call.progress && Number.isFinite(call.progress.sentAt) && Number.isFinite(call.progress.headersAt) && Number.isFinite(call.progress.startedAt) && call.progress.textAt === null && call.progress.doneAt === null && call.progress.events === 3 && call.transport && call.transport.firstByteAt != null, `S3-5: 呼び出しの記録: end unknown・progress は送信・見出し・最初のイベントまで（本文は届いていない = textAt null）: ${JSON.stringify({ end: call && call.end, progress: call && call.progress })}`);
  assert(!NO_BODY.test(JSON.stringify(m.conv().state.metrics.timings.slice(-1)[0])) && !NO_BODY.test(storage.getItem(ledgerKey())), 'S3-6: 呼び出しの記録・検証の上限の記録に本文（依頼・コード・フィールド）を入れない');
});

// =========================================================
console.log('\n--- §S4. 画面: done が無いまま切れる → 切断・終了不明。正常な SSE では承認できる最終案 ---');
await section(async () => {
  const onGenerate = () => sseResponse([': start', PG('generate', 'sent'), PG('generate', 'headers'), PG('generate', 'started'), PG('generate', 'text'), PG('generate', 'delta', { chars: 80 })], { step: () => sleep(1) });
  const { m, gw, v } = await mountReal({ onGenerate });
  const fin = v && v.final;
  const call = lastCalls(m.conv()).find(c => c.kind === 'generate');
  assert(gw.seen.generate.length === 1 && fin && fin.approvable === false && fin.incomplete && fin.incomplete.kind === 'disconnected' && fin.incomplete.stoppedAt === 'C1' && JSON.stringify(fin.incomplete.notStarted) === '["C2"]' && v.generated.C1.failure.stop === 'disconnected' && v.generated.C1.failure.endUnknown === true && !v.generated.C1.generated, `S4-1: done が無いまま終わった SSE は TRANSPORT_ERROR → 切断として止める（後続 0・終了不明・途中の断片は候補にしない）: ${JSON.stringify(fin && fin.incomplete)}`);
  assert(call && call.end === 'unknown' && call.code === 'TRANSPORT_ERROR' && call.via === 'direct-stream' && call.progress && Number.isFinite(call.progress.textAt) && call.progress.doneAt === null && call.progress.events === 5, `S4-2: 呼び出しの記録: 本文は届き始めていた（textAt あり）が完了していない（doneAt null）。失敗した要求でも受けた経路（via direct-stream）が残る: ${JSON.stringify(call && { via: call.via, progress: call.progress })}`);
  assert(/の作成中に、AIサービスとの通信が切れました。/.test(visibleText(m.chat())) && /残り 2 件から再開できます/.test(visibleText(m.chat())), 'S4-3: 利用者には切断の理由と残りの件数（部品名は出さない。2026-10-14: 作成途中のカードの文）');
});
await section(async () => {
  //   正常な SSE（progress → done）: C1・C2 とも検証済み → 承認できる最終案。呼び出しの記録に progress の全部の印。会話の逐次表示（仮案の delta）も実際の client で届く
  const onGenerate = ({ ctx, requestId }) => sseResponse(okBlocks(genDone(ctx, requestId)), { step: () => sleep(1) });
  const { m, gw, v } = await mountReal({ onGenerate });
  const fin = v && v.final;
  const calls = lastCalls(m.conv()).filter(c => c.kind === 'generate');
  assert(gw.seen.generate.length === 2 && gw.seen.generate.every(g => g.accept === 'text/event-stream') && fin && fin.approvable === true && !fin.incomplete && v.generated.C1.status === 'verified' && v.generated.C2.status === 'verified', `S4-4: 正常な SSE では 2 本とも検証済み・承認できる最終案（done の本文を候補にする）: ${JSON.stringify({ gen: gw.seen.generate.length, st: [v.generated.C1 && v.generated.C1.status, v.generated.C2 && v.generated.C2.status], inc: fin && fin.incomplete })}`);
  assert(calls.length === 2 && calls.every(c => c.end === 'ok' && c.progress && c.progress.events === 8 && ['sentAt', 'headersAt', 'startedAt', 'textAt', 'lastAt', 'doneAt', 'verifyAt', 'verifyDoneAt'].every(k => Number.isFinite(c.progress[k]))), `S4-5: 呼び出しの記録に progress の全部の印（相対 ms）: ${JSON.stringify(calls.map(c => c.progress))}`);
  assert(gw.seen.propose.length >= 3 && gw.seen.propose.every(p => p.accept === 'text/event-stream') && !/undefined/.test(m.chat()), `S4-6: 会話の逐次表示（仮案の SSE: delta → done）は実際の client で今までどおり届く: ${JSON.stringify(gw.seen.propose.map(p => p.accept))}`);
  assert(!NO_BODY.test(JSON.stringify(m.conv().state.metrics.timings.slice(-1)[0])), 'S4-7: 呼び出しの記録に本文を入れない');
});

// =========================================================
console.log('\n--- §S5. 3 本の JavaScript: C1・C2 検証済み・C3 時間切れ → 残り 1 件・検証済み 2 件 → ［残りの JavaScript を作る］は C3 だけ ---');
await section(async () => {
  const gen = stagedGenerate({ C1: ['good'], C2: ['good'], C3: ['throw:TIMEOUT', 'good'] });
  const x = makeConvC({ planImpl: planJs3, generate: gen });
  await sendUntilAdopt(x);
  const v = x.c.activePlan();
  assert(v.generated.C1.status === 'verified' && v.generated.C2.status === 'verified' && v.generated.C3.status === 'failed' && v.generated.C3.failure.stop === 'timeout' && v.final.incomplete && v.final.incomplete.stoppedAt === 'C3' && v.final.incomplete.notStarted.length === 0 && v.final.approvable === false, `S5-1: 完了した C1・C2 は残し、止めた C3 で未完成: ${JSON.stringify(v.final.incomplete)}`);
  const h = finalHtml(x), vis = visibleText(h);
  const b = restButtonOf(h);
  //   2026-10-14 の設計し直し（指示書 §1.4）: 作成途中のカードは、できたもの（手順の title）・止めたもの・理由・残り n 件（押したときに実際に作る数）の短い文
  assert(b && !b.disabled && /JavaScript・モバイルの編集制御はできました。モバイルの入力チェックの作成中に、AIの応答が時間切れになりました。/.test(vis) && /完成した分は残っています。残り 1 件から再開できます。/.test(vis) && !/手を付けていません/.test(vis) && !/\bC[123]\b/.test(vis), `S5-2: 作成途中のカードに、できたもの・止めたもの・理由・残りの件数（内部の番号は出さない）: ${vis.replace(/\s+/g, ' ').slice(0, 240)}`);
  assert(x.calls.ask.length === 0 && (v.openQuestions || []).length === 0 && !x.c.messages().some(m => m.type === 'ERROR') && !/速くな/.test(vis), 'S5-3: 失敗を新しい確認（質問・エラーのカード）に変えない。「速くなる」とは書かない');
  const hashes = [v.generated.C1.candidateHash, v.generated.C2.candidateHash];
  const r2 = await pressRest(x);
  const v2 = x.c.activePlan();
  assert(r2.ok && r2.intent === I.GENERATE_CODE && x.calls.plan.length === 1 && gen.count('C1') === 1 && gen.count('C2') === 1 && gen.count('C3') === 2 && v2.generated.C1.reused === true && v2.generated.C2.reused === true && v2.generated.C1.candidateHash === hashes[0] && v2.generated.C2.candidateHash === hashes[1] && v2.generated.C3.status === 'verified' && v2.final.approvable === true && !v2.final.incomplete && JSON.stringify(v2.final.changedSince.reused) === '["C1","C2"]' && JSON.stringify(v2.final.changedSince.regenerated) === '["C3"]', `S5-4: ［残りの JavaScript を作る］→ 計画の AI 0 回・C1 / C2 は流用（検証結果もそのまま）・C3 だけ生成 → 承認できる最終案: ${JSON.stringify({ plans: x.calls.plan.length, seen: gen.seen.map(s => s.cid), changed: v2.final.changedSince })}`);
  const ap = x.c.approveFinal(K.approveArgs(v2));
  assert(ap.ok === true, `S5-5: 承認できる: ${JSON.stringify(ap)}`);
});
await section(async () => {
  //   C2 で止めた（C3 は作っていない）: 残り 2 件・検証済み 1 件。押すと C1 だけ流用
  const gen = stagedGenerate({ C1: ['good'], C2: ['throw:TIMEOUT', 'good'], C3: ['good'] });
  const x = makeConvC({ planImpl: planJs3, generate: gen });
  await sendUntilAdopt(x);
  const v = x.c.activePlan();
  const vis = visibleText(finalHtml(x));
  assert(v.final.incomplete && v.final.incomplete.stoppedAt === 'C2' && JSON.stringify(v.final.incomplete.notStarted) === '["C3"]' && /JavaScriptはできました。モバイルの編集制御の作成中に、AIの応答が時間切れになりました。モバイルの入力チェックは手を付けていません。/.test(vis) && /残り 2 件から再開できます/.test(vis), `S5-6: 止めた 1 件＋作っていない 1 件 = 残り 2 件（未着手は「手を付けていません」の 1 文）: ${vis.replace(/\s+/g, ' ').slice(0, 240)}`);
  await pressRest(x);
  const v2 = x.c.activePlan();
  assert(x.calls.plan.length === 1 && gen.count('C1') === 1 && gen.count('C2') === 2 && gen.count('C3') === 1 && v2.generated.C1.reused === true && v2.generated.C2.status === 'verified' && v2.generated.C3.status === 'verified' && v2.final.approvable === true, `S5-7: 押すと C1 は流用・C2 と C3 を生成: ${JSON.stringify({ seen: gen.seen.map(s => s.cid) })}`);
});
await section(async () => {
  //   最初の C1 で止めた: 検証済みは無い → 「検証済みの JavaScript はまだありません」（0 件を「そのまま使います」と言わない）
  const gen = stagedGenerate({ C1: ['throw:TIMEOUT', 'good'], C2: ['good'], C3: ['good'] });
  const x = makeConvC({ planImpl: planJs3, generate: gen });
  await sendUntilAdopt(x);
  const vis = visibleText(finalHtml(x));
  assert(/まだできた JavaScript はありません。JavaScriptの作成中に、AIの応答が時間切れになりました。モバイルの編集制御・モバイルの入力チェックは手を付けていません。/.test(vis) && /残り 3 件から再開できます/.test(vis) && !/完成した分は残っています/.test(vis), `S5-8: できた JavaScript が無いときは「まだできた JavaScript はありません。」（「完成した分は残っています」とは言わない）: ${vis.replace(/\s+/g, ' ').slice(0, 240)}`);
});
await section(async () => {
  //   レビューの指摘 1（2026-10-14）: 止める前に別の理由で生成できなかった JavaScript（AI が断った GENERATION_DECLINED = 止めない失敗）も残りに数える。
  //   ［残りの JavaScript を作る］は検証済み以外を全部作り直すので、文の件数と押した後の生成の呼び出しの数を一致させる: C1 が断られ → C2 が時間切れ → C3 未着手 = 残り 3 件・生成 3 回
  const gen = stagedGenerate({ C1: ['throw:GENERATION_DECLINED', 'good'], C2: ['throw:TIMEOUT', 'good'], C3: ['good'] });
  const x = makeConvC({ planImpl: planJs3, generate: gen });
  await sendUntilAdopt(x);
  const v = x.c.activePlan();
  const vis = visibleText(finalHtml(x));
  assert(v.generated.C1.status === 'failed' && !v.generated.C1.failure.stop && v.generated.C1.failure.reason === 'GENERATION_DECLINED' && v.generated.C2.status === 'failed' && v.generated.C2.failure.stop === 'timeout' && v.final.incomplete && v.final.incomplete.stoppedAt === 'C2' && JSON.stringify(v.final.incomplete.notStarted) === '["C3"]' && v.final.approvable === false, `S5-9: 前提: C1 は止めない失敗（AI が断った）・C2 で止めた・C3 は作っていない: ${JSON.stringify({ c1: v.generated.C1.failure, inc: v.final.incomplete })}`);
  assert(/まだできた JavaScript はありません。モバイルの編集制御の作成中に、AIの応答が時間切れになりました。モバイルの入力チェックは手を付けていません。JavaScriptは作れませんでした。/.test(vis) && /残り 3 件から再開できます/.test(vis) && !/\bC[123]\b/.test(vis) && (v.openQuestions || []).length === 0, `S5-10: 止めたもの・未着手・作れなかったものをそれぞれ 1 文で出し、残りは検証済みでない 3 件（止めた 1 件＋未着手 1 件の 2 件にしない。内部の番号は出さない・質問は増やさない）: ${vis.replace(/\s+/g, ' ').slice(0, 240)}`);
  const before = gen.seen.length;
  const r2 = await pressRest(x);
  const v2 = x.c.activePlan();
  assert(r2.ok && gen.seen.length - before === 3 && gen.count('C1') === 2 && gen.count('C2') === 2 && gen.count('C3') === 1 && x.calls.plan.length === 1 && ['C1', 'C2', 'C3'].every(cid => v2.generated[cid].status === 'verified' && !v2.generated[cid].reused) && v2.final.approvable === true && !v2.final.incomplete && JSON.stringify(v2.final.changedSince.reused) === '[]' && JSON.stringify(v2.final.changedSince.regenerated) === '["C1","C2","C3"]', `S5-11: 押すと文の件数どおり生成を 3 回呼ぶ（断られた C1 も作り直す。計画の AI 0 回）→ 承認できる最終案: ${JSON.stringify({ seen: gen.seen.slice(before).map(s => s.cid), plans: x.calls.plan.length, changed: v2.final.changedSince })}`);
});

// =========================================================
console.log('\n--- §S6. 呼び出しの記録（timing.calls[]）の progress（相対 ms・本文なし。偽の services の callTrace を写す） ---');
await section(async () => {
  const base = makeGenerate({ sequence: ['good'] });
  const progress = { sentAt: 120, headersAt: 900, startedAt: 1100, textAt: 9500, lastAt: 40100, doneAt: 41500, verifyAt: 41600, verifyDoneAt: 44000, events: 12 };
  const gen = { calls: base.calls, impl: async (args) => { const r = await base.impl(args); return { ...r, callTrace: { requestId: 'tk-stream-1', limitMs: 240000, transport: { startedAt: 0, headersAt: 50, firstByteAt: 60, endAt: 44100 }, progress: { ...progress } } }; } };
  const x = makeConvC({ planImpl: (args) => K.planJs(args), generate: gen });
  await sendUntilAdopt(x);
  const g = lastCalls(x.c).find(c => c.kind === 'generate');
  assert(g && g.end === 'ok' && g.requestId === 'tk-stream-1' && JSON.stringify(g.progress) === JSON.stringify(progress) && g.transport.firstByteAt === 60, `S6-1: 成功した生成の記録に progress（相対 ms と受けた数）を写す: ${JSON.stringify(g && g.progress)}`);
  //   失敗（例外の callTrace）でも写す。通知の無い呼び出し（progress null）には付けない
  const gen2 = { calls: base.calls, impl: async (args) => { if (args.customizationId === 'C1') { const e = aiErr('TIMEOUT'); e.callTrace = { requestId: 'tk-stream-2', limitMs: 240000, transport: { startedAt: 0, headersAt: 50, firstByteAt: 60, endAt: 240000 }, progress: { ...progress, textAt: null, lastAt: 1100, doneAt: null, verifyAt: null, verifyDoneAt: null, events: 3 } }; throw e; } return base.impl(args); } };
  const y = makeConvC({ planImpl: (args) => K.planJs(args), generate: gen2 });
  await sendUntilAdopt(y);
  const g2 = lastCalls(y.c).find(c => c.kind === 'generate'), p2 = lastCalls(y.c).find(c => c.kind === 'plan');
  assert(g2 && g2.end === 'unknown' && g2.progress && g2.progress.textAt === null && g2.progress.events === 3 && p2 && !('progress' in p2), `S6-2: 時間切れの生成の記録にも progress（届いたところまで）。計画の呼び出しには付けない: ${JSON.stringify({ g: g2 && g2.progress, pKeys: p2 && Object.keys(p2) })}`);
  assert(!NO_BODY.test(JSON.stringify(x.c.state.metrics.timings.slice(-1)[0])) && !NO_BODY.test(JSON.stringify(y.c.state.metrics.timings.slice(-1)[0])), 'S6-3: 呼び出しの記録に本文（依頼・コード）を入れない');
});

// =========================================================
console.log('\n--- §S7. 印のある接続先で JSON の 4xx が返る → 呼び出しの記録に via（direct）が付き progress は付かない（SSE で受けた要求だけ progress） ---');
await section(async () => {
  //   レビューの指摘 2（2026-10-14）: onEvent を渡しただけで trace.progress が作られるので、実際に SSE で受けていない要求（JSON の 4xx）に全部 null の progress を付けない。
  //   C1 は JSON の 422（GENERATION_DECLINED = 止めない失敗）・C2 は SSE で検証済み（実際の client・偽の Gateway）
  const DECLINED_BODY = { ok: false, error: { code: 'GENERATION_DECLINED', message: 'テスト: AI はこの依頼に対するコード生成を行いませんでした', reason: 'テストの理由' } };
  const onGenerate = ({ ctx, requestId }) => (ctx.customization.customizationId === 'C1' ? jsonResponse(422, { ...DECLINED_BODY, meta: { requestId } }) : sseResponse(okBlocks(genDone(ctx, requestId)), { step: () => sleep(1) }));
  const { m, gw, v } = await mountReal({ onGenerate });
  const calls = lastCalls(m.conv()).filter(c => c.kind === 'generate');
  const c1 = calls[0] || null, c2 = calls[1] || null;
  assert(gw.seen.generate.length === 2 && gw.seen.generate.every(g => g.accept === 'text/event-stream') && v.generated.C1 && v.generated.C1.status === 'failed' && !v.generated.C1.failure.stop && v.generated.C2 && v.generated.C2.status === 'verified' && v.final && !v.final.incomplete, `S7-1: 前提: Accept を付けて送り、C1 は JSON の 422（止めない失敗。C2 も送る）・C2 は SSE で検証済み: ${JSON.stringify({ gen: gw.seen.generate.map(g => [g.ctx.customization.customizationId, g.accept]), st: [v.generated.C1 && v.generated.C1.status, v.generated.C2 && v.generated.C2.status] })}`);
  assert(c1 && c1.end === 'error' && c1.code === 'GENERATION_DECLINED' && c1.via === 'direct' && !('progress' in c1) && c1.transport && c1.transport.headersAt != null && c1.transport.endAt != null, `S7-2: JSON で返った要求の記録: via direct・progress 無し（全部 null の progress を付けない）・transport の時刻はある: ${JSON.stringify(c1 && { end: c1.end, code: c1.code, via: c1.via, keys: Object.keys(c1), transport: c1.transport })}`);
  assert(c2 && c2.end === 'ok' && c2.via === 'direct-stream' && c2.progress && c2.progress.events === 8 && Number.isFinite(c2.progress.doneAt), `S7-3: SSE で受けた要求の記録: via direct-stream・progress あり: ${JSON.stringify(c2 && { via: c2.via, progress: c2.progress })}`);
  assert(!NO_BODY.test(JSON.stringify(m.conv().state.metrics.timings.slice(-1)[0])), 'S7-4: 呼び出しの記録に本文を入れない');
});

// =========================================================
console.log('\n--- §S8. 右の「コード」: 生成に失敗して流用元も無い記録（generated null）を開いても例外にしない（統合 scenarios §7l で発見。止めない失敗の後の［残りの JavaScript を作る］の経路） ---');
await section(async () => {
  //   sendChat は GENERATE_CODE の後に作り直した最初の JavaScript を右の「コード」に出す（showCode → codePaneHtml）。止めない失敗（AI が断った等）で流用元も無い記録は
  //   generated が null なので、修正前は generated.strategy の読み取りで TypeError になり、送信の処理が例外で終わっていた
  const empty = KTAiChatUi.codePaneHtml(null);
  let threw = null, pane = null;
  try { pane = KTAiChatUi.codePaneHtml({ status: 'failed', generated: null, review: null, existingSource: null, failure: { reason: 'GENERATION_DECLINED', message: 'テスト' } }, { view: 'code' }); } catch (e) { threw = e; }
  assert(!threw && pane && pane.head === empty.head && pane.code === '' && pane.diff === '' && pane.review === '', `S8-1: generated が無い記録の「コード」は空の表示（例外にしない）: ${threw ? String(threw && threw.message) : JSON.stringify(pane)}`);
});

// =========================================================
console.log('\n--- §S9. 受信した本文の文字数（2026-10-15 §1.5）: trace.progress の textChars / deltaEvents・成功の timing.calls[].upstream（8 キー）・失敗の記録の upstream と textChars・詳細の 1 句 ---');
const UPSTREAM_KEYS_JOINED = 'headersMs,firstEventMs,firstTextMs,lastProgressMs,endMs,end,textChars,deltaCount';
/** 上流（AI プロバイダ）の観測（契約 20 §15 の 8 キー）。成功と時間切れ（期限の直前まで本文を流し続けていた形） */
const UP_OK = { headersMs: 800, firstEventMs: 950, firstTextMs: 9000, lastProgressMs: 39000, endMs: 40000, end: 'completed', textChars: 5200, deltaCount: 61 };
const UP_TIMEOUT = { headersMs: 700, firstEventMs: 900, firstTextMs: 8000, lastProgressMs: 239000, endMs: 240000, end: 'incomplete', textChars: 12345, deltaCount: 300 };
const TIMING_OK = { version: '1', totalMs: 42000, ai: { count: 2, ms: 41000, repairs: 1 }, calls: [{ kind: 'generate', attempt: 0, ms: 40000, ok: true, inputTokens: 3000, outputTokens: 700, upstream: UP_OK }, { kind: 'repair', attempt: 1, ms: 1000, ok: true, inputTokens: 100, outputTokens: 50 }], behavior: { ms: 1000, runs: 1, calls: 2 } };
/** Gateway の期限の 502 の本文に error.upstream を含める（契約 20 §16） */
const timeoutBodyWith = (upstream, requestId) => JSON.stringify({ ...UPSTREAM_TIMEOUT_BODY, error: { ...UPSTREAM_TIMEOUT_BODY.error, ...(upstream ? { upstream } : {}) }, meta: { requestId } });
await section(async () => {
  //   (a) trace.progress: text / delta の chars（累計）の最後の値が textChars、本文の断片の通知の数が deltaEvents（keepalive・started は数えない）
  const blocks = [': start', PG('generate', 'sent'), PG('generate', 'headers'), PG('generate', 'started'), ': keepalive', PG('generate', 'text', { chars: 120, deltaChars: 120 }), PG('generate', 'delta', { chars: 2400, deltaChars: 300 }), PG('generate', 'delta', { chars: 5200, deltaChars: 80 }), PG('generate', 'done', { ok: true, end: 'completed' }), PG('verify', 'start'), PG('verify', 'done', { passed: true }), null];
  const fetchFn = async (url, init) => { const requestId = JSON.parse(init.body).meta.requestId; blocks[blocks.length - 1] = { event: 'done', data: genDone(GCTX, requestId, { timing: TIMING_OK }) }; return sseResponse(blocks, { step: () => sleep(1) }); };
  const c = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: HOST, transport: KTAiClient.createDefaultTransport({ kintoneApi: null, fetchFn }) });
  const trace = {};
  const g = await c.generate({ ctx: GCTX, trace, onEvent: () => { } });
  assert(trace.progress && trace.progress.textChars === 5200 && trace.progress.deltaEvents === 3 && trace.progress.events === 9 && !NO_BODY.test(JSON.stringify(trace)), `S9-1: trace.progress の textChars は最後に受けた累計（5200）・deltaEvents は本文の断片の通知の数（3。keepalive・started は数えない。events は progress の総数 9）: ${JSON.stringify(trace.progress)}`);
  //   (c) 成功の generated.timing.calls[0].upstream は 8 キー（契約の順）。upstream の無い呼び出しは null
  const up = g.timing && Array.isArray(g.timing.calls) ? g.timing.calls[0].upstream : null;
  assert(up && Object.keys(up).join(',') === UPSTREAM_KEYS_JOINED && up.textChars === 5200 && up.deltaCount === 61 && up.end === 'completed' && up.headersMs === 800 && g.timing.calls[1].upstream === null && KTAiClient.UPSTREAM_KEYS.join(',') === UPSTREAM_KEYS_JOINED, `S9-2: 成功の記録 generated.timing.calls[0].upstream は 8 キー（headersMs … textChars, deltaCount）。無い呼び出しは null: ${JSON.stringify(g.timing && g.timing.calls)}`);
  //   白リスト: 余計なキーは落ちる・文字列の数は数に・負の数と数でない end は null・形が違えば null
  const nu = KTAiClient.normalizeUpstream({ headersMs: '12', end: 7, textChars: -1, bogus: 1 });
  assert(nu && Object.keys(nu).join(',') === UPSTREAM_KEYS_JOINED && nu.headersMs === 12 && nu.end === null && nu.textChars === null && nu.deltaCount === null && KTAiClient.normalizeUpstream(null) === null && KTAiClient.normalizeUpstream('x') === null && KTAiClient.normalizeUpstream([1]) === null, `S9-3: upstream は 8 キーの白リスト（数か null・end は文字列か null。形が違えば null）: ${JSON.stringify(nu)}`);
});
await section(async () => {
  //   (b) 画面（実際の client・偽の Gateway）: 本文が届き始めてから Gateway の期限（SSE の error 502。error.upstream つき）→ 失敗の記録に upstream（8 キー）と Toolkit が受けた累計（textChars）。本文は残さない
  const onGenerate = ({ requestId }) => sseResponse([': start', PG('generate', 'sent'), PG('generate', 'headers'), PG('generate', 'started'), PG('generate', 'text', { chars: 100, deltaChars: 100 }), PG('generate', 'delta', { chars: 9800, deltaChars: 400 }), { event: 'error', data: { status: 502, body: timeoutBodyWith(UP_TIMEOUT, requestId) } }], { step: () => sleep(1) });
  const { m, v } = await mountReal({ onGenerate });
  const f = v && v.generated && v.generated.C1 ? v.generated.C1.failure : null;
  assert(v.generated.C1.status === 'failed' && f && f.stop === 'timeout' && f.upstream && Object.keys(f.upstream).join(',') === UPSTREAM_KEYS_JOINED && f.upstream.textChars === 12345 && f.upstream.deltaCount === 300 && f.upstream.end === 'incomplete' && f.upstream.endMs === 240000 && f.textChars === 9800 && !NO_BODY.test(JSON.stringify(f)), `S9-4: 失敗の記録 failure.upstream（Gateway の 502 の error.upstream。8 キー）と failure.textChars（Toolkit が受けた進みの通知の累計 9800）。本文は無い: ${JSON.stringify(f)}`);
  const call = lastCalls(m.conv()).find(c => c.kind === 'generate');
  assert(call && call.end === 'unknown' && call.upstream && call.upstream.textChars === 12345 && Object.keys(call.upstream).join(',') === UPSTREAM_KEYS_JOINED && call.progress && call.progress.textChars === 9800 && call.progress.deltaEvents === 2 && !NO_BODY.test(JSON.stringify(m.conv().state.metrics.timings.slice(-1)[0])), `S9-5: 呼び出しの記録（timing.calls[]）にも upstream（8 キー）と progress の textChars / deltaEvents。本文は無い: ${JSON.stringify(call && { upstream: call.upstream, progress: call.progress })}`);
  //   (d) 作成途中の「詳細（時間と AI の利用）」に 1 句（Gateway の観測の文字数。token 数ではないと書く）。通常表示には出さない・ほかの表示は増やさない
  const chat = m.chat();
  const detail = (chat.match(/<details class="kt-ai-tech"[^>]*><summary>詳細（時間と AI の利用）<\/summary>[\s\S]*?<\/details>/) || [''])[0];
  assert(/時間切れまでに受信した本文 約 12345 文字（token 数ではありません）/.test(stripC(detail)) && (stripC(chat).match(/時間切れまでに受信した本文/g) || []).length === 1 && !/時間切れまでに受信した本文/.test(visibleText(chat)) && /作成途中/.test(visibleText(chat)), `S9-6: 作成途中の詳細に「時間切れまでに受信した本文 約 12345 文字（token 数ではありません）」の 1 句だけ（通常表示には出さない）: ${stripC(detail).replace(/\s+/g, ' ').slice(0, 200)}`);
});
await section(async () => {
  //   Gateway の upstream に文字数が無い（非ストリーム = null）ときは Toolkit が受けた累計で書く。本文を受けていない・観測が無いときは何も出さない
  const onGenerate2 = ({ requestId }) => sseResponse([': start', PG('generate', 'sent'), PG('generate', 'headers'), PG('generate', 'started'), PG('generate', 'text', { chars: 100 }), PG('generate', 'delta', { chars: 9800 }), { event: 'error', data: { status: 502, body: timeoutBodyWith({ ...UP_TIMEOUT, textChars: null, deltaCount: null }, requestId) } }], { step: () => sleep(1) });
  const a = await mountReal({ onGenerate: onGenerate2 });
  const fa = a.v.generated.C1.failure;
  assert(fa.upstream && fa.upstream.textChars === null && fa.textChars === 9800 && /時間切れまでに受信した本文 約 9800 文字（token 数ではありません）/.test(stripC(a.m.chat())), `S9-7: Gateway の文字数が無ければ Toolkit が受けた累計（9800）で 1 句: ${JSON.stringify(fa)}`);
  const onGenerate3 = ({ requestId }) => sseResponse([': start', PG('generate', 'sent'), PG('generate', 'headers'), PG('generate', 'started'), ': keepalive', { event: 'error', data: { status: 502, body: timeoutBodyWith(null, requestId) } }], { step: () => sleep(1) });
  const b = await mountReal({ onGenerate: onGenerate3 });
  const fb = b.v.generated.C1.failure;
  assert(fb.stop === 'timeout' && !('upstream' in fb) && !('textChars' in fb) && !/時間切れまでに受信した本文/.test(b.m.chat()) && /作成途中/.test(visibleText(b.m.chat())), `S9-8: 観測が無く本文も受けていなければ、記録にキーを足さず 1 句も出さない（古い Gateway の 502 も同じ）: ${JSON.stringify(fb)}`);
});

console.log(`\n${state.passed} passed, ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})();
