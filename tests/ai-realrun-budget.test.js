// 実機確認（2026-10-09）の予算管理の回帰（設計 §0f.4・利用者の指示 §5 の表の 6〜7 行目の Toolkit 側。有料の AI は使わない）
//
// 検証内容:
//   §B0 見積もり（KTAiBudget.estimate）: 入力 token は送る Context のバイト数から（キャッシュ命中を前提にしない）・出力は health の limits の出力の上限（Gateway が実際に使う値）、
//        無ければ表（会話 4,000・計画 48,000・生成 32,000）。応答の出力の上限が見積もりに使った値を超えたら以後を止める・内部の呼び出しの最大（会話・仮案 1・計画の全体 1・差分 2・生成 1 ＋ 修復 2）・単価の表（gpt-6.1-sol 入力 2・出力 10 米ドル / 100 万 token）。
//        表に無いモデル・種類は送らない
//   §B1 設定と記録: 設定が無ければ無効（session.client をそのまま使う・記録を書かない）。設定があるのに記録を読めない・壊れている・書けないときは送らない
//   §B2 確保と精算: 残りより次の要求の最大が大きい → 送信 0 件／回数も同じ／終了不明（時間切れ・取り消し・usage の無い応答・AI を呼んだ後のエラー）は確保を解放しない／
//        AI を呼ぶ前に止まった失敗だけ解放／差分 → 全体・生成の修復の一部の usage が無い → partial-unknown（無い分の確保を残す）／並行の質問も確保額に含む／
//        読み込み直しで進行中のまま残った記録は終了不明／応答のモデル・出力の上限・呼び出しの数が表を超えたら以後を止める／Web Locks／送る前の取り消しは解放／記録に本文を入れない
//   §B3 予算が有効なときは直接の送信の失敗から kintone.proxy へ送り直さない（noProxyFallback）。既定は今までどおり
//   §B4 画面: 残りより生成の最大が大きい → 生成の送信 0 件・最終案は予算で止まった未完成（必要な額・残り）／前の生成が終了不明 → ［残りの JavaScript を作る］も送らない／
//        生成中の質問も確保額に含む／中断で usage が返らない → 費用 0 や予算内と表示せず終了不明・費用未確定／予算が無効なら今までと同じ／記録に本文が入らない／
//        設定が壊れていれば最初の仮案も送らない／見出しに記録済み・確保中・上限（有効なときだけ）
//   §B5 表示: 最終案の詳細の「AI の呼び出し N 回（内部を含め最大 M 回）。うち K 回は使用量が不明のため、費用は未確定です。確認できた分 …」（finalUsageOf）・
//        JavaScript ごとの「生成 N 回目」の不明の回数・修復の token が一部だけのときの印・入力か出力の片方だけの usage は使用量が不明（generationEstimate）
//   記録の費用（レビューの指摘 row7）: 費用が確定していない記録（進行中・終了不明・一部不明）は costUsd が null・costComplete false・確認できた分は costKnownUsd
//
// 実行方法: node tests/ai-realrun-budget.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const T = loadToolkit();
const { KTAiClient, KTAiBudget, KTAiConversation, KTAiChatUi } = T;
const { assert, state } = makeAssert();
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const { clone, stripC } = K;
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }
const tick = () => new Promise(r => setTimeout(r, 0));
const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };

const HOST = 't.cybozu.com';
const CFG_KEY = `ktAi.budget.v1.${HOST}`;
const ledgerKey = (id = 'v1') => `ktAi.budgetLedger.v1.${HOST}.${id}`;
const MODEL = 'gpt-6.1-sol';
const CREATED = '2026-10-09T00:00:00Z';
//   偽の応答のモデルを単価の表にあるモデルにする（部品の台本の META・計画の PLAN_META は 'm'。表に無いモデルは以後を止める＝§B2-12 で別に確かめる）
K.META.ai.model = MODEL; K.PLAN_META.ai.model = MODEL;
const setConfig = (storage, o = {}) => storage.setItem(CFG_KEY, JSON.stringify({ id: 'v1', limitUsd: 1, maxCalls: 100, createdAt: CREATED, ...o }));
const mkBudget = ({ storage = K.makeStorage(), config = null, locks = null, sessionId = 'p-test' } = {}) => { if (config) setConfig(storage, config); return { storage, budget: KTAiBudget.create({ storage, host: HOST, locks, sessionId }) }; };
const ledgerOf = (storage, id = 'v1') => { const raw = storage.getItem(ledgerKey(id)); return raw ? JSON.parse(raw) : null; };
const aiErr = (code, o = {}) => new KTAiClient.AiClientError({ code, message: o.message || `テスト: ${code}`, ...(o.details ? { details: o.details } : {}) });
const gwErr = (code, detail = null) => aiErr(code, { details: { ok: false, error: { code, message: 'x', ...(detail != null ? { detail } : {}) } } });
const usage = (i, o, cached = 0) => ({ input_tokens: i, output_tokens: o, input_tokens_details: { cached_tokens: cached }, output_tokens_details: { reasoning_tokens: 0 } });
const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
/** 偽の session.client（呼び出しを記録する。impl[kind] が無ければ使用量つきの成功） */
function fakeClient(impl = {}) {
  const calls = [];
  const mk = (kind) => async (p) => { calls.push({ kind, p }); if (impl[kind]) return impl[kind](p); return { ai: { model: MODEL, usage: usage(1000, 200) } }; };
  return { calls, client: { getHealth: async () => ({ ok: true }), ask: mk('ask'), propose: mk('propose'), plan: mk('plan'), generate: mk('generate') }, count: (k) => calls.filter(c => c.kind === k).length };
}
const catchOf = async (p) => { try { await p; return null; } catch (e) { return e; } };
const reasonOf = (e) => (e && e.details && e.details.budget ? e.details.budget.reason : null);
const restButtonOf = (h) => { const m = /<button[^>]*data-act="choice"[^>]*>残りの JavaScript を作る<\/button>/.exec(h); return m ? { html: m[0], disabled: /\sdisabled/.test(m[0]) } : null; };
const ALLOWED_ENTRY_KEYS = ['key', 'requestId', 'feature', 'kind', 'mode', 'sessionId', 'startedAt', 'endedAt', 'status', 'reservedUsd', 'reservedCalls', 'maxCallUsd', 'estimatedModel', 'maxOutputTokens', 'ctxBytes', 'model', 'calls', 'costUsd', 'costKnownUsd', 'costComplete', 'costCachedUsd', 'reason'];

(async () => {
// =========================================================
console.log('\n--- §B0. 見積もり（入力はバイト数から・出力の上限は health の値（無ければ表）・内部の呼び出しの最大・単価の表） ---');
await section(async () => {
  const E = KTAiBudget.estimate;
  const eAsk = E({ kind: 'ask', ctxBytes: 10000 });
  assert(eAsk.ok && eAsk.feature === 'assistant-qa' && eAsk.model === MODEL && eAsk.maxCalls === 1 && eAsk.calls[0].input === 15500 && eAsk.calls[0].output === 4000 && eAsk.maxUsd === 0.071,
    `B0-1: 質問: 入力 = (指示 18,000 B ＋ 1.3 × Context 10,000 B) / 2 = 15,500・出力 4,000・1 回・(15,500×2 ＋ 4,000×10) / 100 万 = 0.071 米ドル: ${JSON.stringify(eAsk)}`);
  const eProp = E({ kind: 'propose', ctxBytes: 10000 });
  assert(eProp.ok && eProp.maxCalls === 1 && eProp.calls[0].output === 4000 && eProp.calls[0].input === Math.ceil((32000 + 13000) / 2), `B0-2: 仮案も assistant-qa（出力 4,000・1 回）: ${JSON.stringify(eProp.calls)}`);
  const ePlan = E({ kind: 'plan', ctxBytes: 60000 });
  assert(ePlan.ok && ePlan.mode === 'plan-full' && ePlan.maxCalls === 1 && ePlan.calls[0].input === 85000 && ePlan.calls[0].output === 48000 && ePlan.maxUsd === 0.65, `B0-3: 計画の全体: 1 回・出力 48,000・0.65 米ドル: ${JSON.stringify(ePlan.calls)}`);
  const ePatch = E({ kind: 'plan', ctx: { revision: { mode: 'patch' } }, ctxBytes: 60000 });
  assert(ePatch.ok && ePatch.mode === 'plan-patch' && ePatch.maxCalls === 2 && ePatch.calls.map(c => c.kind).join() === 'plan-patch,plan-full' && ePatch.calls.every(c => c.output === 48000) && ePatch.maxUsd === 1.308,
    `B0-4: 計画の差分更新: 差分 → 全体の作り直しで最大 2 回（Gateway の内部の追加の呼び出しも確保する）: ${JSON.stringify(ePatch.calls)}`);
  const eGen = E({ kind: 'generate', ctxBytes: 10000 });
  assert(eGen.ok && eGen.maxCalls === 3 && eGen.calls.map(c => c.kind).join() === 'generate,repair,repair' && eGen.calls[0].input === 21500 && eGen.calls[1].input === 21500 + 32000 + 4000 && eGen.calls.every(c => c.output === 32000) && eGen.maxUsd === 1.233,
    `B0-5: 生成: 最初の 1 回 ＋ 修復 2 回（修復の入力に前の出力と指摘を足す）・出力 32,000 × 3・1.233 米ドル: ${JSON.stringify(eGen.calls)}`);
  const H = (o) => ({ features: { 'customization-generator': { model: MODEL, ...o } } });
  const eBig = E({ kind: 'generate', ctxBytes: 10000, limits: H({ maxOutputTokens: 64000, maxAiCalls: 4 }) });
  const eSmall = E({ kind: 'generate', ctxBytes: 10000, limits: H({ maxOutputTokens: 1000, maxAiCalls: 1 }) });
  //   レビューの指摘（2026-10-09・費用の見積もり）: 出力の上限は health の値（Gateway が実際に使う上限）があればその値（大きいときも小さいときも）、無ければ表の値。
  //   呼び出しの最大は今までどおり表との大きい方（小さい値で回数を減らさない）
  assert(eBig.ok && eBig.maxOutputTokens === 64000 && eBig.maxCalls === 4 && eSmall.ok && eSmall.maxOutputTokens === 1000 && eSmall.maxCalls === 3 && eSmall.calls.every(c => c.output === 1000) && eSmall.calls[1].input === 21500 + 1000 + 4000 && eSmall.maxUsd === 0.179 && eGen.maxOutputTokens === 32000,
    `B0-6: health の出力の上限があればその値（大きい 64,000・小さい 1,000 のどちらも health の値。修復の入力も 1,000 で数える）・無ければ表の 32,000。呼び出しの最大は表との大きい方: ${JSON.stringify({ big: [eBig.maxOutputTokens, eBig.maxCalls], small: [eSmall.maxOutputTokens, eSmall.maxCalls, eSmall.maxUsd], table: eGen.maxOutputTokens })}`);
  {
    //   応答の設定の上限が、見積もりに使った値（health の 1,000）を超えたら以後を止める（表の 4,000 とは比べない）
    const { storage, budget } = mkBudget({ config: { limitUsd: 5 } });
    const lim = { features: { 'assistant-qa': { model: MODEL, maxOutputTokens: 1000 } } };
    const fc = fakeClient({ ask: () => ({ ai: { model: MODEL, usage: usage(100, 10), settings: { maxOutputTokens: 2000 } } }) });
    const w = budget.wrap(fc.client, { limits: lim });
    await w.ask({ ctx: { q: 1 } });
    const e = await catchOf(w.ask({ ctx: { q: 2 } }));
    const lg = ledgerOf(storage);
    assert(lg.entries[0].maxOutputTokens === 1000 && lg.stopped && lg.stopped.reason === 'output-limit' && lg.stopped.maxOutputTokens === 2000 && e && reasonOf(e) === 'stopped' && fc.count('ask') === 1, `B0-6b: 応答の出力の上限（2,000）が見積もりに使った health の値（1,000）を超えたら以後を止める（表の 4,000 より小さくても）: ${JSON.stringify({ est: lg.entries[0].maxOutputTokens, stopped: lg.stopped, asks: fc.count('ask') })}`);
  }
  const ePlanH = E({ kind: 'plan', ctxBytes: 60000, limits: { features: { 'change-planner': { model: MODEL, maxOutputTokens: 48000, maxAiCalls: 2 } } } });
  assert(ePlanH.ok && ePlanH.maxCalls === 1, 'B0-7: 計画の全体の作り直しは health の maxAiCalls（差分 → 全体の 2）があっても 1 回（差分の要求だけ 2 回）');
  const eUnknownModel = E({ kind: 'plan', ctxBytes: 100, limits: { features: { 'change-planner': { model: 'gpt-9-ultra' } } } });
  const eUnknownKind = E({ kind: 'explain' });
  assert(!eUnknownModel.ok && eUnknownModel.reason === 'unknown-model' && eUnknownModel.model === 'gpt-9-ultra' && !eUnknownKind.ok && eUnknownKind.reason === 'unknown-feature', `B0-8: 表に無いモデル・種類は見積もらない（送らない）: ${JSON.stringify({ eUnknownModel, eUnknownKind })}`);
  const P = KTAiBudget.priceOf;
  assert(P(MODEL).input === 2 && P(MODEL).output === 10 && P(`${MODEL}-2026-08-01`) === P(MODEL) && P('constructor') === null && P('m') === null && P('') === null, 'B0-9: 単価の表: gpt-6.1-sol は入力 2・出力 10 米ドル / 100 万 token（日付つきの版も同じ）。表に無い名前（constructor など）は null');
  const eJa = E({ kind: 'ask', ctx: { a: 'あ'.repeat(1000) } });
  assert(eJa.ok && eJa.ctxBytes === 3008, `B0-10: 入力の大きさは送る Context の UTF-8 のバイト数（文字数ではない）: ${eJa.ctxBytes}`);
});

// =========================================================
console.log('\n--- §B1. 設定と記録（無効なら今と同じ・読めない・壊れている・書けないときは送らない） ---');
await section(async () => {
  const { storage, budget } = mkBudget();
  const fc = fakeClient();
  const w = budget.wrap(fc.client);
  const r = await w.ask({ ctx: { q: 1 }, requestId: 'r-off' });
  assert(!budget.enabled() && r && fc.count('ask') === 1 && fc.calls[0].p.requestId === 'r-off' && !('noProxyFallback' in fc.calls[0].p) && storage.getItem(ledgerKey()) === null && budget.summary().enabled === false && KTAiBudget.summaryText(budget.summary()) === '',
    'B1-1: 設定が無ければ無効: 素通し（引数を変えない・noProxyFallback を付けない）・記録を書かない・見出しの行も無い');
  const cases = [
    ['config-invalid', (s) => s.setItem(CFG_KEY, '{bad')],
    ['config-invalid', (s) => setConfig(s, { limitUsd: -1 })],
    ['ledger-broken', (s) => { setConfig(s); s.setItem(ledgerKey(), 'xx'); }],
    ['ledger-broken', (s) => { setConfig(s); s.setItem(ledgerKey(), JSON.stringify({ version: 1, id: 'v1', configCreatedAt: CREATED, entries: [{ key: 'k', status: 'weird' }] })); }],
    ['ledger-mismatch', (s) => { setConfig(s); s.setItem(ledgerKey(), JSON.stringify({ version: 1, id: 'v1', configCreatedAt: '2025-01-01T00:00:00Z', entries: [], stopped: null })); }],
  ];
  for (const [want, prep] of cases) {
    const st = K.makeStorage(); prep(st);
    const b = KTAiBudget.create({ storage: st, host: HOST, locks: null });
    const f = fakeClient();
    const e = await catchOf(b.wrap(f.client).propose({ ctx: { q: 1 }, requestId: 'r' }));
    assert(e && e.code === 'BUDGET_EXCEEDED' && reasonOf(e) === want && f.calls.length === 0 && b.enabled() && b.summary().ok === false && /読めない/.test(KTAiBudget.summaryText(b.summary())) && /検証の上限を確かめられないため、AI に送りませんでした/.test(KTAiClient.errorText(e.code, e)),
      `B1-2（${want}）: 設定があるのに設定・記録を読めない／壊れている／設定と合わない → 送らない（送信 0 件）: ${e && e.code} / ${reasonOf(e)} / ${e && KTAiClient.errorText(e.code, e)}`);
  }
  //   記録を読めない（getItem が例外）・書けない（setItem が例外）
  const base = K.makeStorage(); setConfig(base);
  const unreadable = { getItem: (k) => { if (k === ledgerKey()) throw new Error('denied'); return base.getItem(k); }, setItem: (k, v) => base.setItem(k, v), removeItem: (k) => base.removeItem(k) };
  const f1 = fakeClient();
  const e1 = await catchOf(KTAiBudget.create({ storage: unreadable, host: HOST, locks: null }).wrap(f1.client).ask({ ctx: {} }));
  const base2 = K.makeStorage(); setConfig(base2);
  const unwritable = { getItem: (k) => base2.getItem(k), setItem: () => { throw new Error('QuotaExceeded'); }, removeItem: () => { } };
  const f2 = fakeClient();
  const e2 = await catchOf(KTAiBudget.create({ storage: unwritable, host: HOST, locks: null }).wrap(f2.client).ask({ ctx: {} }));
  assert(reasonOf(e1) === 'ledger-unreadable' && f1.calls.length === 0 && reasonOf(e2) === 'ledger-write' && f2.calls.length === 0, `B1-3: 記録を読めない・書けないときも送らない（送る前に in-flight を書けなければ送らない）: ${reasonOf(e1)} / ${reasonOf(e2)}`);
});

// =========================================================
console.log('\n--- §B2. 確保と精算 ---');
await section(async () => {
  //   成功（使用量あり）→ done・確保を解放・費用（キャッシュの割引なし）と参考の割引あり
  const { storage, budget } = mkBudget({ config: { limitUsd: 1 } });
  const fc = fakeClient({ ask: () => ({ ai: { model: MODEL, usage: usage(1000, 200, 300) } }) });
  await budget.wrap(fc.client).ask({ ctx: { q: '質問' }, requestId: 'r-1' });
  const e0 = ledgerOf(storage).entries[0];
  assert(e0 && e0.status === 'done' && e0.requestId === 'r-1' && e0.reservedUsd === 0 && e0.costUsd === 0.004 && e0.costKnownUsd === 0.004 && e0.costComplete === true && e0.costCachedUsd === 0.00343 && e0.calls.length === 1 && e0.calls[0].input === 1000 && e0.calls[0].cached === 300 && e0.model === MODEL && fc.calls[0].p.noProxyFallback === true && fc.calls[0].p.requestId === 'r-1',
    `B2-1: 応答の usage で精算（done・確保 0・費用はキャッシュの割引なし 0.004、割引ありは参考 0.00343）・送るときは kintone.proxy への送り直しをしない印: ${JSON.stringify(e0)}`);
});
await section(async () => {
  //   残りより次の要求の最大が大きい → 送らない（偽の client の呼び出し 0）。必要な額・残りを画面の文に
  const { storage, budget } = mkBudget({ config: { limitUsd: 0.5 } });
  const fc = fakeClient();
  const e = await catchOf(budget.wrap(fc.client).generate({ ctx: { customization: { x: 1 } }, requestId: 'g-1' }));
  const b = e && e.details && e.details.budget;
  const text = e ? KTAiClient.errorText(e.code, e) : '';
  assert(e && e.code === 'BUDGET_EXCEEDED' && b.reason === 'limit' && b.needUsd > b.remainingUsd && b.remainingUsd === 0.5 && b.needCalls === 3 && fc.calls.length === 0 && (ledgerOf(storage) === null || ledgerOf(storage).entries.length === 0)
    && /検証の上限（費用・回数）を超えるため、AI に送りませんでした（次の要求は最大 約 [0-9.]+ 米ドル・AI の呼び出し 3 回、残りは 約 0\.5 米ドル・100 回です/.test(text) && KTAiConversation.stopKindOf(e) === 'budget',
    `B2-2: 残りの予算より次の要求の最大費用が大きい → 送信 0 件・記録も書かない・画面の文に必要な額と残り・会話の停止の種類は budget: ${text}`);
  const { budget: b2 } = mkBudget({ config: { limitUsd: 100, maxCalls: 2 } });
  const f2 = fakeClient();
  const eg = await catchOf(b2.wrap(f2.client).generate({ ctx: {} }));
  const ea = await catchOf(b2.wrap(f2.client).ask({ ctx: {} }));
  assert(reasonOf(eg) === 'calls' && f2.count('generate') === 0 && ea === null && f2.count('ask') === 1, `B2-3: 回数も同じく判定する（上限 2 回に生成の最大 3 回は送らない。質問の 1 回は送る）: ${reasonOf(eg)}`);
});
await section(async () => {
  //   終了不明（時間切れ）は確保を解放しない → 次の要求は残りに収まらず送らない
  const { storage, budget } = mkBudget({ config: { limitUsd: 2 } });
  const fc = fakeClient({ generate: () => { throw aiErr('TIMEOUT'); } });
  const w = budget.wrap(fc.client);
  const ctx = { customization: { id: 'C1' } };
  const est = KTAiBudget.estimate({ kind: 'generate', ctx });
  const e1 = await catchOf(w.generate({ ctx, requestId: 'g-1' }));
  const en = ledgerOf(storage).entries[0];
  const s1 = budget.summary();
  const e2 = await catchOf(w.generate({ ctx, requestId: 'g-2' }));
  assert(e1 && e1.code === 'TIMEOUT' && en.status === 'unknown' && en.reason === 'TIMEOUT' && en.reservedUsd === est.maxUsd && en.reservedCalls === 3 && s1.unknown === 1 && s1.reservedUsd === est.maxUsd && s1.recordedUsd === 0
    && reasonOf(e2) === 'limit' && e2.details.budget.remainingUsd < est.maxUsd && fc.count('generate') === 1 && /終了不明 1 件/.test(KTAiBudget.summaryText(s1)),
    `B2-4: 前の要求が終了不明（時間切れ）→ 確保額（${est.maxUsd}）が残り、次の生成は送らない（送信は 1 件のまま）: ${JSON.stringify({ en, s1, e2: e2 && e2.details })}`);
  //   取り消し・usage の無い応答・AI を呼んだ後のエラー（Gateway の上流の失敗・応答の検証の失敗）も終了不明
  const kinds = [
    ['CANCELLED', () => { throw aiErr('CANCELLED'); }],
    ['NO_USAGE', () => ({ ai: { model: MODEL } })],
    ['UPSTREAM_ERROR', () => { throw gwErr('UPSTREAM_ERROR', { upstreamStatus: 500 }); }],
    ['RATE_LIMITED', () => { throw gwErr('RATE_LIMITED'); }],
    ['UNSUPPORTED_CONTRACT_VERSION', () => { throw aiErr('UNSUPPORTED_CONTRACT_VERSION', { details: { errors: [{ code: 'UNSUPPORTED_CONTRACT_VERSION' }] } }); }],
  ];
  for (const [label, impl] of kinds) {
    const { storage: s, budget: b } = mkBudget({ config: { limitUsd: 10 } });
    await catchOf(b.wrap(fakeClient({ ask: impl }).client).ask({ ctx: {} }));
    const x = ledgerOf(s).entries[0];
    //   レビューの指摘 row7: 終了不明の記録は費用が確定していない（costUsd は null・costComplete false）。確認できた費用は 0（costKnownUsd）で、確保は残す
    assert(x.status === 'unknown' && x.reservedUsd > 0 && x.reservedCalls === 1 && x.costUsd === null && x.costKnownUsd === 0 && x.costComplete === false && b.summary().recordedUsd === 0 && b.summary().reservedUsd === x.reservedUsd, `B2-5（${label}）: AI を呼んだかもしれない失敗・usage の無い応答は終了不明（確認できた費用は 0・費用は未確定（0 と精算しない）・確保を解放しない）: ${JSON.stringify({ status: x.status, reason: x.reason, reservedUsd: x.reservedUsd, costUsd: x.costUsd, costKnownUsd: x.costKnownUsd, costComplete: x.costComplete })}`);
  }
  //   AI を呼ぶ前に止まった失敗だけ解放（認証・月次の上限・Gateway 自身のレート制限）
  for (const [label, err] of [['AUTH_INVALID_TOKEN', gwErr('AUTH_INVALID_TOKEN')], ['MONTHLY_LIMIT_EXCEEDED', gwErr('MONTHLY_LIMIT_EXCEEDED')], ['RATE_LIMITED（Gateway 自身）', gwErr('RATE_LIMITED', { limit: 10 })]]) {
    const { storage: s, budget: b } = mkBudget({ config: { limitUsd: 10 } });
    await catchOf(b.wrap(fakeClient({ ask: () => { throw err; } }).client).ask({ ctx: {} }));
    const x = ledgerOf(s).entries[0];
    assert(x.status === 'released' && x.reservedUsd === 0 && x.reservedCalls === 0 && x.costUsd === 0 && x.costComplete === true && b.summary().usedCalls === 0, `B2-6（${label}）: AI を呼ぶ前に止まった失敗は確保を解放する: ${JSON.stringify(x)}`);
  }
});
await section(async () => {
  //   Gateway の内部の追加の呼び出し: 計画の差分 → 全体（2 回）・生成の修復（3 回）を送る前に確保し、一部の usage が無ければ partial-unknown（無い分の確保を残す）
  const { storage, budget } = mkBudget({ config: { limitUsd: 10 } });
  const g = gate();
  let inFlight = null;
  const fc = fakeClient({
    plan: async () => { inFlight = clone(ledgerOf(storage).entries.slice(-1)[0]); await g.p; return { ai: { model: MODEL, usage: usage(30000, 2000) }, revisionMeta: { requested: 'patch', mode: 'full', fallbackReason: 'PATCH_LLM_TIMEOUT', patchAttempt: { latencyMs: 60000, usage: null } } }; },
  });
  const p = budget.wrap(fc.client).plan({ ctx: { goal: 'g', revision: { mode: 'patch' } }, requestId: 'pl-1' });
  await ticks(); g.open(); await p;
  const x = ledgerOf(storage).entries[0];
  assert(inFlight && inFlight.status === 'in-flight' && inFlight.reservedCalls === 2 && inFlight.mode === 'plan-patch' && x.status === 'partial-unknown' && x.calls.length === 2 && x.calls[0] === null && x.costUsd === null && x.costKnownUsd === 0.08 && x.costComplete === false && x.reservedUsd === x.maxCallUsd && x.reservedUsd > 0 && budget.summary().recordedUsd === 0.08,
    `B2-7: 計画の差分更新は送る前に 2 回分を確保。差分の試みの usage が無い → partial-unknown（確認できた全体の分 0.08 米ドル・無い 1 回分の確保を残す）: ${JSON.stringify({ inFlight: inFlight && [inFlight.status, inFlight.reservedCalls], x })}`);
  const { storage: s2, budget: b2 } = mkBudget({ config: { limitUsd: 10 } });
  let inFlightG = null;
  const fg = fakeClient({
    generate: async () => { inFlightG = clone(ledgerOf(s2).entries.slice(-1)[0]); return { ai: { model: MODEL, usage: usage(5000, 800) }, timing: { version: '1', ai: { count: 3, repairs: 2 }, calls: [{ kind: 'generate', attempt: 0, ok: true, inputTokens: 5000, outputTokens: 800 }, { kind: 'repair', attempt: 1, ok: true, inputTokens: 6000, outputTokens: 900 }, { kind: 'repair', attempt: 2, ok: false, inputTokens: null, outputTokens: null }] }, verification: { repairs: { count: 2 } } }; },
  });
  await b2.wrap(fg.client).generate({ ctx: { customization: {} } });
  const y = ledgerOf(s2).entries[0];
  assert(inFlightG && inFlightG.reservedCalls === 3 && y.status === 'partial-unknown' && y.calls.length === 3 && y.calls.filter(c => c === null).length === 1 && y.costUsd === null && y.costKnownUsd === 0.039 && y.costComplete === false && y.reservedUsd === y.maxCallUsd,
    `B2-8: 生成は送る前に最初の 1 回 ＋ 修復 2 回を確保。失敗した修復の token が無い → partial-unknown（確認できた分 0.039 米ドル・無い 1 回分の確保を残す）: ${JSON.stringify(y)}`);
});
await section(async () => {
  //   並行: 生成の確保が残っている間の質問は、その確保額も含めて判定する
  const { storage, budget } = mkBudget({ config: { limitUsd: 10 } });
  const g = gate();
  const fc = fakeClient({ generate: async () => { await g.p; return { ai: { model: MODEL, usage: usage(5000, 800) } }; } });
  const w = budget.wrap(fc.client);
  const genCtx = { customization: { id: 'C1' } }, askCtx = { question: '金額はどこで使われていますか' };
  const estG = KTAiBudget.estimate({ kind: 'generate', ctx: genCtx }), estA = KTAiBudget.estimate({ kind: 'ask', ctx: askCtx });
  setConfig(storage, { limitUsd: Math.round((estG.maxUsd + estA.maxUsd / 2) * 1e6) / 1e6 });
  const pg = w.generate({ ctx: genCtx });
  await ticks();
  const sMid = budget.summary();
  const ea = await catchOf(w.ask({ ctx: askCtx }));
  assert(sMid.inFlight === 1 && sMid.reservedUsd === estG.maxUsd && reasonOf(ea) === 'limit' && fc.count('ask') === 0 && ea.details.budget.remainingUsd < estA.maxUsd,
    `B2-9: 生成中（確保 ${estG.maxUsd} 米ドル・3 回）の並行の質問は、生成の確保額を含めて判定して送らない: ${JSON.stringify({ sMid, ea: ea && ea.details })}`);
  setConfig(storage, { limitUsd: 10 });
  //   レビューの指摘 row6（2026-10-09）: 質問の偽の client も止め、両方が進行中の時点で確保額と回数の合計を確かめる（すぐ応答すると質問は精算済みになり、合計を確かめられない）
  const ga = gate();
  const fc2 = fakeClient({ generate: async () => { await g.p; return { ai: { model: MODEL, usage: usage(5000, 800) } }; }, ask: async () => { await ga.p; return { ai: { model: MODEL, usage: usage(1000, 200) } }; } });
  const { storage: s2, budget: b2 } = mkBudget({ config: { limitUsd: 10 }, sessionId: 'p-both' });
  const w2 = b2.wrap(fc2.client);
  const pg2 = w2.generate({ ctx: genCtx }); await ticks();
  const pa = w2.ask({ ctx: askCtx }); await ticks();
  const sBoth = b2.summary();
  ga.open(); await pa;
  const sAfterAsk = b2.summary();
  g.open(); await pg; await pg2;
  const round6 = (v) => Math.round(v * 1e6) / 1e6;
  assert(fc2.count('ask') === 1 && fc2.count('generate') === 1 && sBoth.inFlight === 2 && sBoth.reservedUsd === round6(estG.maxUsd + estA.maxUsd) && sBoth.usedCalls === estG.maxCalls + estA.maxCalls && sAfterAsk.inFlight === 1 && sAfterAsk.reservedUsd === estG.maxUsd && ledgerOf(s2).entries.length === 2,
    `B2-10: 上限に収まれば並行の質問も送り、両方が進行中の間の確保額は両方の合計（生成 ${estG.maxUsd} ＋ 質問 ${estA.maxUsd}・回数 ${estG.maxCalls} ＋ ${estA.maxCalls}）。質問の精算の後は生成の確保だけ残る: ${JSON.stringify({ sBoth, sAfterAsk })}`);
});
await section(async () => {
  //   読み込み直し: 前のページで in-flight のまま残った記録は終了不明として数え、確保を解放しない
  const storage = K.makeStorage(); setConfig(storage, { limitUsd: 0.1 });
  const old = KTAiBudget.create({ storage, host: HOST, locks: null, sessionId: 'p-old' });
  const pOld = old.wrap(fakeClient({ ask: () => new Promise(() => { }) }).client).ask({ ctx: {} });
  void pOld.catch(() => { });
  await ticks();
  const est = KTAiBudget.estimate({ kind: 'ask', ctx: {} });
  const reloaded = KTAiBudget.create({ storage, host: HOST, locks: null, sessionId: 'p-new' });
  const s = reloaded.summary();
  const fc = fakeClient();
  const e = await catchOf(reloaded.wrap(fc.client).ask({ ctx: {} }));
  const x = ledgerOf(storage).entries[0];
  assert(s.unknown === 1 && s.inFlight === 0 && s.reservedUsd === est.maxUsd && reasonOf(e) === 'limit' && fc.calls.length === 0 && x.status === 'unknown' && x.reason === 'NOT_SETTLED',
    `B2-11: 読み込み直しで進行中のまま残った記録は終了不明（確保を残す）。残りに収まらない質問は送らない: ${JSON.stringify({ s, x: [x.status, x.reason], e: reasonOf(e) })}`);
});
await section(async () => {
  //   応答のモデル・出力の上限・呼び出しの数が見積もりの表を超えた → 以後を止める
  const cases = [
    ['model', 'ask', () => ({ ai: { model: 'm', usage: usage(100, 10) } })],
    ['output-limit', 'ask', () => ({ ai: { model: MODEL, usage: usage(100, 10), settings: { maxOutputTokens: 9000 } } })],
    ['calls', 'plan', () => ({ ai: { model: MODEL, usage: usage(100, 10) }, revisionMeta: { requested: 'full', mode: 'full', patchAttempt: { usage: usage(1, 1) } } })],
  ];
  for (const [want, kind, impl] of cases) {
    const { storage, budget } = mkBudget({ config: { limitUsd: 10 } });
    const fc = fakeClient({ [kind]: impl });
    const w = budget.wrap(fc.client);
    await w[kind]({ ctx: { goal: 'g' } });
    const led = ledgerOf(storage);
    const e = await catchOf(w.ask({ ctx: {} }));
    assert(led.stopped && led.stopped.reason === want && reasonOf(e) === 'stopped' && fc.calls.length === 1 && /以後の送信を止めています/.test(KTAiClient.errorText(e.code, e)) && /以後の送信を止めています/.test(KTAiBudget.summaryText(budget.summary())),
      `B2-12（${want}）: 応答が見積もりの表を超えた → 以後の送信を止める（次の質問も送らない）: ${JSON.stringify(led.stopped)} / ${e && KTAiClient.errorText(e.code, e)}`);
  }
  //   表に無いモデルの応答の費用は確定しない（確保を残す）
  const { storage: s3, budget: b3 } = mkBudget({ config: { limitUsd: 10 } });
  await b3.wrap(fakeClient({ ask: () => ({ ai: { model: 'unknown-model', usage: usage(100, 10) } }) }).client).ask({ ctx: {} });
  const z = ledgerOf(s3).entries[0];
  assert(z.status === 'unknown' && z.reservedUsd > 0 && z.costUsd === null && z.costKnownUsd === 0 && z.costComplete === false, 'B2-13: 単価の表に無いモデルの応答は費用を確定しない（終了不明と同じく確保を残す。costUsd は null）');
});
await section(async () => {
  //   Web Locks: 確保と精算はタブ間で 1 つずつ（名前は ktAi.budget:<host>・exclusive）
  const names = []; let chain = Promise.resolve();
  const locks = { request(name, opts, fn) { names.push([name, opts && opts.mode]); const r = chain.then(() => fn()); chain = r.catch(() => { }); return r; } };
  const { budget } = mkBudget({ config: { limitUsd: 10 }, locks });
  await budget.wrap(fakeClient().client).ask({ ctx: {} });
  assert(names.length >= 2 && names.every(([n, mode]) => n === `ktAi.budget:${HOST}` && mode === 'exclusive'), `B2-14: 確保と精算は Web Locks の中（複数のタブで同時に判定しない）: ${JSON.stringify(names)}`);
  //   送る前に取り消された → 送らずに解放（偽の client の呼び出し 0）
  const { storage, budget: b2 } = mkBudget({ config: { limitUsd: 10 } });
  const ac = new AbortController(); ac.abort();
  const fc = fakeClient();
  const e = await catchOf(b2.wrap(fc.client).ask({ ctx: {}, signal: ac.signal }));
  const x = ledgerOf(storage).entries[0];
  assert(e && e.code === 'CANCELLED' && fc.calls.length === 0 && x.status === 'released' && x.reservedUsd === 0, 'B2-15: 送る前に取り消された要求は送らずに解放する');
});
await section(async () => {
  //   記録に本文（Context・発言・ゴール・フィールド）を入れない
  const { storage, budget } = mkBudget({ config: { limitUsd: 10 } });
  const w = budget.wrap(fakeClient({ plan: () => { throw aiErr('TIMEOUT'); } }).client);
  await w.ask({ ctx: { question: '秘密の依頼文XYZ', app: { fields: [{ code: 'secret_field_ABC' }] } } });
  await catchOf(w.plan({ ctx: { goal: 'ゴール文QQQ', facts: [{ id: 'E1', statement: '事実の文RRR' }] } }));
  const raw = storage.getItem(ledgerKey());
  const led = JSON.parse(raw);
  assert(!/XYZ|ABC|QQQ|RRR|秘密|ゴール|事実/.test(raw) && led.entries.length === 2 && led.entries.every(e => Object.keys(e).every(k => ALLOWED_ENTRY_KEYS.includes(k))) && Object.keys(led).sort().join() === 'configCreatedAt,entries,id,stopped,version',
    `B2-16: 記録は状態・確保額・token の数だけ（本文を入れない）: ${raw.slice(0, 300)}`);
});

// =========================================================
console.log('\n--- §B3. 予算が有効なときは直接の送信の失敗から kintone.proxy へ送り直さない ---');
await section(async () => {
  const proxyCalls = [];
  const kintoneApi = { proxy: async (...a) => { proxyCalls.push(a); return ['{"ok":true}', 200]; } };
  const fetchFn = async () => { throw new TypeError('Failed to fetch'); };
  const tr = KTAiClient.createDefaultTransport({ kintoneApi, fetchFn, nowFn: () => 0 });
  const r0 = await tr({ url: 'https://gw.test/v2/review', method: 'POST', headers: {}, body: '{}', preferDirect: true });
  const e1 = await catchOf(tr({ url: 'https://gw.test/v2/review', method: 'POST', headers: {}, body: '{}', preferDirect: true, noProxyFallback: true }));
  assert(r0 && r0.via === 'proxy' && proxyCalls.length === 1 && e1 && /Failed to fetch/.test(e1.message), `B3-1: 既定は直接の送信の失敗（5 秒以内）から kintone.proxy に切り替える（今までどおり）。noProxyFallback なら送り直さない: ${JSON.stringify({ via: r0 && r0.via, proxy: proxyCalls.length })}`);
  //   client の 4 つの要求は noProxyFallback を transport まで渡す（予算の包みが付ける）
  const seen = [];
  const transport = async (a) => { seen.push(a.noProxyFallback === true); return { status: 500, body: JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'x' } }) }; };
  const client = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: HOST, transport });
  await catchOf(client.plan({ ctx: { facts: [], goal: 'g', contextVersion: 'p' }, noProxyFallback: true }));
  await catchOf(client.plan({ ctx: { facts: [], goal: 'g', contextVersion: 'p' } }));
  const { budget } = mkBudget({ config: { limitUsd: 10 } });
  await catchOf(budget.wrap({ ask: (p) => client.ask(p), propose: (p) => client.propose(p), plan: (p) => client.plan(p), generate: (p) => client.generate(p) }).generate({ ctx: { customization: {}, contextVersion: 'c' } }));
  assert(seen.join() === 'true,false,true', `B3-2: 予算が有効なときの要求だけ transport に noProxyFallback が届く: ${seen.join()}`);
});

// =========================================================
console.log('\n--- §B4. 画面（mountAiWorkspace の makeClient が session.client を包む） ---');
/** 画面: 台本の発言で仮案 → 採用 → 計画 → 生成（JavaScript 1 つ）。generateImpl は screenGenerate を包む（モデルと使用量を付ける） */
function mountB({ budget, generate = null, health = K.HEALTH_V } = {}) {
  const gen = K.screenGenerate({ field: 'case_name', targetFile: 'caseLock.js' });
  const seen = [];
  const generateImpl = async (a) => { seen.push({ noProxyFallback: a.noProxyFallback, signal: a.signal || null }); if (generate) return generate(a, gen); const r = await gen.impl(a); r.ai = { model: MODEL, usage: usage(3000, 700) }; return r; };
  const m = K.mount({ health, planImpl: K.planImplOf(K.screenPlan('js')), generateImpl, liveBase: true, extra: { budget } });
  return { m, gen, seen };
}
await section(async () => {
  //   残りの予算より生成の最大費用が大きい → 生成の送信 0 件・最終案は予算で止まった未完成（承認できない・続きのボタンは無効・必要な額と残り）
  const { storage, budget } = mkBudget({ config: { limitUsd: 1 } });
  const { m, gen, seen } = mountB({ budget });
  await ticks();
  const v = await K.adoptOnScreen(m); await ticks(20);
  const fin = v && v.final;
  const chat = m.chat();
  const led = ledgerOf(storage);
  const kinds = led ? led.entries.map(e => `${e.kind}:${e.status}`) : [];
  const btn = restButtonOf(chat);
  const head = m.$('kt-ai-header').innerHTML;
  assert(seen.length === 0 && gen.calls.length === 0 && m.calls.plan.length === 1 && fin && fin.incomplete && fin.incomplete.kind === 'budget' && fin.incomplete.budget && fin.incomplete.budget.reason === 'limit' && fin.incomplete.budget.needUsd > fin.incomplete.budget.remainingUsd && !fin.approvable,
    `B4-1: 残りより生成の最大が大きい → 生成の送信 0 件（偽の client の呼び出し 0）・最終案は予算で止まった未完成（承認できない）: ${JSON.stringify({ seen: seen.length, inc: fin && fin.incomplete, kinds })}`);
  assert(btn && btn.disabled && /利用の上限（予算・回数）に達しました（次の要求は最大 約 [0-9.]+ 米ドル・AI の呼び出し 3 回、残りは 約 [0-9.]+ 米ドル/.test(stripC(chat)) && kinds.join() === 'propose:done,propose:done,propose:done,plan:done' && /検証の上限: 記録済み 約 [0-9.]+ 米ドル・確保中 約 0 米ドル ／ 上限 1 米ドル・AI の呼び出し 4 \/ 100 回/.test(stripC(head)),
    `B4-2: 最終案の理由に必要な額と残り・［残りの JavaScript を作る］は無効・記録に生成は無い・見出しに記録済み・確保中・上限: ${JSON.stringify({ btn, kinds, head: stripC(head).slice(0, 120) })}`);
  const line = stripC(chat).split('\n').find(s => /AI の呼び出し \d+ 回（内部を含め最大/.test(s)) || '';
  assert(/AI の呼び出し 1 回（内部を含め最大 1 回）。合計 入力 500 \/ 出力 200 トークン・約 0\.003 米ドル（キャッシュの割引なし）/.test(line) && /検証の上限で送らなかった要求 1 件（費用なし）/.test(stripC(chat)), `B4-3: 最終案の詳細: 送った呼び出しだけを数え、送らなかった要求は費用なしと分けて出す: ${line}`);
  //   記録に本文が入らない（発言・ゴール・フィールドのコード・コード）
  const raw = storage.getItem(ledgerKey());
  assert(!K.REQUESTS.some(r => raw.includes(r)) && !/課長|部長|承認|case_name|amount|kintone\.events|record/.test(raw) && JSON.parse(raw).entries.every(e => Object.keys(e).every(k => ALLOWED_ENTRY_KEYS.includes(k))), `B4-4: 画面の記録にも本文（発言・計画・フィールド・コード）が入らない: ${raw.slice(0, 200)}`);
  //   回数の上限でも同じ（仮案 3・計画 1 の後、生成の最大 3 回は上限 6 回に収まらない）
  const { budget: b2 } = mkBudget({ config: { limitUsd: 100, maxCalls: 6 } });
  const r2 = mountB({ budget: b2 });
  await ticks();
  const v2 = await K.adoptOnScreen(r2.m); await ticks(20);
  assert(r2.seen.length === 0 && v2 && v2.final && v2.final.incomplete && v2.final.incomplete.kind === 'budget' && v2.final.incomplete.budget.reason === 'calls', `B4-5: 回数の上限（6 回）でも生成を送らず、予算で止まった未完成: ${JSON.stringify(v2 && v2.final && v2.final.incomplete)}`);
});
await section(async () => {
  //   前の生成が終了不明（時間切れ）→ 確保額が残り、［残りの JavaScript を作る］でも送らない
  const { storage, budget } = mkBudget({ config: { limitUsd: 2 } });
  const { m, seen } = mountB({ budget, generate: () => { throw aiErr('TIMEOUT'); } });
  await ticks();
  const v = await K.adoptOnScreen(m); await ticks(20);
  const gEntry = ledgerOf(storage).entries.find(e => e.kind === 'generate');
  const head1 = stripC(m.$('kt-ai-header').innerHTML);
  const line1 = stripC(m.chat()).split('\n').find(s => /AI の呼び出し \d+ 回（内部を含め最大/.test(s)) || '';
  assert(seen.length === 1 && seen[0].noProxyFallback === true && v && v.final && v.final.incomplete && v.final.incomplete.kind === 'timeout' && gEntry.status === 'unknown' && gEntry.reservedUsd > 1 && /終了不明 1 件/.test(head1)
    && /AI の呼び出し 2 回（内部を含め最大 4 回）。うち 1 回は使用量が不明のため、費用は未確定です。確認できた分 入力 500 \/ 出力 200 トークン・約 0\.003 米ドル/.test(line1) && !/合計/.test(line1),
    `B4-6: 生成の時間切れ → 記録は終了不明（確保を残す）・見出しに終了不明・最終案の詳細は使用量が不明・費用は未確定（合計と言わない）: ${JSON.stringify({ g: gEntry && [gEntry.status, gEntry.reservedUsd], head1, line1 })}`);
  await m.panel.send('コードを作って', { intent: KTAiConversation.INTENT.GENERATE_CODE, displayText: '残りの JavaScript を作る' }); await ticks(20);
  const v2 = m.conv().activePlan();
  const gens = ledgerOf(storage).entries.filter(e => e.kind === 'generate');
  assert(seen.length === 1 && gens.length === 1 && v2 && v2.final && v2.final.incomplete && v2.final.incomplete.kind === 'budget' && v2.final.incomplete.budget.remainingUsd < v2.final.incomplete.budget.needUsd,
    `B4-7: 前の要求が終了不明 → その確保額が残り、［残りの JavaScript を作る］の生成も送らない（送信 0 件・予算で止まった未完成）: ${JSON.stringify({ seen: seen.length, inc: v2 && v2.final && v2.final.incomplete })}`);
});
await section(async () => {
  //   中断（［キャンセル］）で usage が返らない → 費用 0 や予算内と表示せず、終了不明・費用未確定を残す
  const { storage, budget } = mkBudget({ config: { limitUsd: 5 } });
  const { m, seen } = mountB({ budget, generate: ({ signal }) => new Promise((_, rej) => { if (signal) signal.addEventListener('abort', () => rej(aiErr('CANCELLED')), { once: true }); }) });
  await ticks();
  for (const s of K.REQUESTS.slice(0, 3)) { await m.panel.send(s); await ticks(10); }
  m.$('kt-ai-input').value = K.REQUESTS[3];
  const pClick = m.$('kt-ai-send').dispatch('click');
  await K.waitUntil(() => seen.length === 1, 400);
  const mid = budget.summary();
  await m.$('kt-ai-cancel').dispatch('click');
  await pClick; await ticks(10);
  const v = m.conv().activePlan();
  const gEntry = ledgerOf(storage).entries.find(e => e.kind === 'generate');
  const s = budget.summary();
  const head = stripC(m.$('kt-ai-header').innerHTML);
  const line = stripC(m.chat()).split('\n').find(x => /AI の呼び出し \d+ 回（内部を含め最大/.test(x)) || '';
  assert(mid.inFlight === 1 && mid.reservedUsd > 1 && v && v.final && v.final.incomplete && v.final.incomplete.kind === 'cancelled' && gEntry.status === 'unknown' && gEntry.reason === 'CANCELLED' && gEntry.costUsd === null && gEntry.costKnownUsd === 0 && gEntry.costComplete === false && gEntry.reservedUsd > 1 && s.unknown === 1 && s.reservedUsd === gEntry.reservedUsd,
    `B4-8: 生成中の取り消し → 記録は終了不明（確認できた費用は 0・費用は未確定（costUsd は null）・確保を残す）: ${JSON.stringify({ mid, g: gEntry && [gEntry.status, gEntry.reason, gEntry.reservedUsd, gEntry.costUsd, gEntry.costKnownUsd], s })}`);
  assert(/確保中 約 [1-9][0-9.]* 米ドル（終了不明 1 件）/.test(head) && /うち 1 回は使用量が不明のため、費用は未確定です/.test(line) && !/合計|約 0 米ドル（/.test(line),
    `B4-9: 画面も費用 0・予算内とは出さない（見出しは確保中と終了不明、最終案の詳細は費用は未確定）: ${head} / ${line}`);
});
await section(async () => {
  //   生成中の質問（作業中に受け付けた質問）も確保額に含めて判定する
  const { storage, budget } = mkBudget({ config: { limitUsd: 5 } });
  const g = gate();
  const { m, seen } = mountB({ budget, generate: async (a, gen) => { await g.p; const r = await gen.impl(a); r.ai = { model: MODEL, usage: usage(3000, 700) }; return r; } });
  await ticks();
  for (const s of K.REQUESTS.slice(0, 3)) { await m.panel.send(s); await ticks(10); }
  const pAdopt = m.panel.send(K.REQUESTS[3]);
  await K.waitUntil(() => seen.length === 1, 400);
  const mid = budget.summary();
  //   いまの記録済み ＋ 確保額のすぐ上に上限を下げる（生成の確保額が残っている間の質問は収まらない）
  setConfig(storage, { limitUsd: Math.round((mid.recordedUsd + mid.reservedUsd + 0.01) * 1e6) / 1e6 });
  const askBefore = m.calls.ask.length;
  await m.panel.send('金額のフィールドはどこで使われていますか？'); await ticks(10);
  const refusedText = stripC(m.chat());
  const askRefused = m.calls.ask.length - askBefore;
  setConfig(storage, { limitUsd: 5 });
  await m.panel.send('金額のフィールドはどこで使われていますか？'); await ticks(10);
  const askSent = m.calls.ask.length - askBefore;
  const midBoth = budget.summary();
  g.open(); await pAdopt; await ticks(20);
  assert(mid.inFlight === 1 && askRefused === 0 && /検証の上限（費用・回数）を超えるため、AI に送りませんでした（次の要求は最大 約/.test(refusedText) && askSent === 1 && midBoth.reservedUsd >= mid.reservedUsd,
    `B4-10: 生成中の並行の質問は、生成の確保額を含めて判定する（収まらなければ送らず理由を出す・収まれば送る）: ${JSON.stringify({ mid, askRefused, askSent, midBoth })}`);
});
await section(async () => {
  //   予算が無効なら今までと同じ（session.client をそのまま使う・記録を書かない・見出しに出さない）
  const { storage, budget } = mkBudget();
  const { m, seen } = mountB({ budget });
  await ticks();
  const v = await K.adoptOnScreen(m); await ticks(20);
  const head = m.$('kt-ai-header').innerHTML;
  assert(seen.length === 1 && seen[0].noProxyFallback === undefined && storage.getItem(ledgerKey()) === null && !/kt-ai-budget|検証の上限/.test(head) && v && v.final && !v.final.incomplete && m.calls.propose.length === 3 && m.calls.plan.length === 1,
    `B4-11: 予算の設定が無ければ今までと同じ（包まない・記録を書かない・見出しに出さない・最終案は完成）: ${JSON.stringify({ seen, inc: v && v.final && v.final.incomplete })}`);
  //   d.budget を渡さない画面（既定の作り方）でも、テストの localStorage に設定が無ければ無効
  const m0 = K.mount();
  assert(m0.panel.budget() && m0.panel.budget().enabled() === false, 'B4-12: 既定の画面の検証の上限は、設定が無ければ無効');
});
await section(async () => {
  //   設定があるのに壊れている → 最初の仮案も送らない（理由を出す）
  const storage = K.makeStorage(); storage.setItem(CFG_KEY, '{"id":"v1",');
  const budget = KTAiBudget.create({ storage, host: HOST, locks: null });
  const { m } = mountB({ budget });
  await ticks();
  await m.panel.send(K.REQUESTS[0]); await ticks(10);
  const text = stripC(m.chat());
  const head = stripC(m.$('kt-ai-header').innerHTML);
  assert(m.calls.propose.length === 0 && /検証の上限を確かめられないため、AI に送りませんでした（検証の上限の設定の形が正しくありません）/.test(text) && /設定または記録を読めないため、AI に送りません/.test(head),
    `B4-13: 設定が壊れていれば最初の仮案も送らない（送信 0 件・理由を出す・見出しにも出す）: ${text.slice(-200)} / ${head.slice(0, 80)}`);
});

// =========================================================
console.log('\n--- §B5. 表示（使用量が一部だけのときに合計と言わない・内部を含めた最大・JavaScript ごとの不明の回数） ---');
await section(async () => {
  const { finalUsageOf, generationEstimate, nextAttempts } = KTAiConversation;
  const u = finalUsageOf({ aiCalls: 5, calls: [
    { kind: 'plan', end: 'ok', ai: { inputTokens: 1000, outputTokens: 100, patchAttempt: { inputTokens: null, outputTokens: null } } },
    { kind: 'generate', end: 'unknown', ai: null },
    { kind: 'generate', end: 'error', notSent: 'budget' },
  ], asides: [{ kind: 'aside', pending: true }, { kind: 'aside', pending: false, ai: { inputTokens: 200, outputTokens: 50 } }] });
  assert(u.sentCalls === 4 && u.notSent === 1 && u.notSentBudget === 1 && u.maxCalls === 7 && u.usageUnknown === 3 && u.measured === 2 && u.tokens.input === 1200 && u.tokens.output === 150 && u.costUsd === 0.0039 && u.unknownCalls === 1,
    `B5-1: 送った要求 4（送らなかった 1 を除く）・内部を含めた最大 7（差分 → 全体 2・終了不明の生成 3・質問 1×2）・使用量が不明 3（差分の試み・終了不明の生成・終わっていない質問）・確認できた分だけの費用: ${JSON.stringify(u)}`);
  const u2 = finalUsageOf({ aiCalls: 2, calls: [] });
  assert(u2.sentCalls === 2 && u2.usageUnknown === 2 && u2.measured === 0 && u2.costUsd === 0, `B5-2: 呼び出しの回数に入っているのに記録の無い呼び出しは、使用量が不明として数える（0 として扱わない）: ${JSON.stringify(u2)}`);
  const u3 = finalUsageOf({ aiCalls: 2, calls: [{ kind: 'generate', end: 'error', preAi: true }, { kind: 'generate', end: 'error', notSent: true }] });
  assert(u3.sentCalls === 0 && u3.preAi === 1 && u3.notSent === 1 && u3.notSentBudget === 0 && u3.usageUnknown === 0, `B5-3: Gateway が AI を呼ぶ前に止めた要求・送る前の理由で送らなかった要求は費用なし（使用量が不明に数えない。検証の上限の件数には入れない）: ${JSON.stringify(u3)}`);
  //   修復の token が一部だけ → 'partial'・不明の回数
  const eP = generationEstimate({ generated: { ai: { usage: { input_tokens: 5000, output_tokens: 800 } }, timing: { ai: { count: 3, repairs: 2 }, calls: [{ kind: 'generate', inputTokens: 5000, outputTokens: 800 }, { kind: 'repair', inputTokens: 6000, outputTokens: 900 }, { kind: 'repair', inputTokens: null, outputTokens: null }] } } });
  const eN = generationEstimate({ generated: { ai: { usage: { input_tokens: 5000, output_tokens: 800 } }, verification: { repairs: { count: 2 } } } });
  assert(eP.repairs.measured === 'partial' && eP.repairs.unknown === 1 && eP.unknownCalls === 1 && eP.input === 11000 && eN.unknownCalls === 2 && eN.repairs.measured === 'none',
    `B5-4: 修復の token が一部だけなら 'partial'（'all' と言わない）・修復の token が無ければ不明の回数: ${JSON.stringify({ eP, eN })}`);
  //   JavaScript ごとの「生成 N 回目」: 使用量が不明な回があれば「確認できた分」と不明の回数・費用は未確定
  const gen = { strategy: 'NEW_JS_FILE', targetFile: 'a.js', summary: '', code: "(function () { 'use strict'; })();", patch: null, events: [], fields: [], apis: [], assumptions: [], warnings: [], coverage: [] };
  const a1 = nextAttempts(null, { inputHash: 'h1', estimate: { measured: true, input: 3000, output: 400, costUsd: 0.01, unknownCalls: 0 } });
  const a2 = nextAttempts({ attempts: a1 }, { inputHash: 'h2' });
  const head2 = KTAiChatUi.codePaneHtml({ generated: gen, review: null, existingSource: null, attempts: a2 }).head;
  const headOld = KTAiChatUi.codePaneHtml({ generated: gen, review: null, existingSource: null, attempts: { count: 2, measured: 1, tokens: { input: 3000, output: 400 }, costUsd: 0.01 } }).head;
  const headAll = KTAiChatUi.codePaneHtml({ generated: gen, review: null, existingSource: null, attempts: a1 }).head;
  assert(a2.unknown === 1 && /生成 2 回目（確認できた分の使用量: 入力 3000 \/ 出力 400 token・約 0\.01 米ドル。使用量が不明な回が 1 回あり、費用は未確定）/.test(stripC(head2)) && /使用量が不明な回が 1 回/.test(stripC(headOld)) && /生成 1 回目（使用量: 入力 3000 \/ 出力 400 token・約 0\.01 米ドル）/.test(stripC(headAll)),
    `B5-5: JavaScript ごとの表示も、使用量が不明な回があれば「確認できた分」と不明の回数（古い記録は回数の差から）。すべて分かれば今までどおり: ${stripC(head2).slice(0, 200)}`);
  //   レビューの指摘 row7（2026-10-09）: 生成の応答の usage に入力か出力の片方しか無いときは使用量が不明（欠けた側を 0 として「合計」と言わない。KTAiBudget.callsOf と同じ）
  const eIn = generationEstimate({ generated: { ai: { usage: { input_tokens: 5000 } } } });
  const eOut = generationEstimate({ generated: { ai: { usage: { output_tokens: 800 } } } });
  const eBoth = generationEstimate({ generated: { ai: { usage: { input_tokens: 5000, output_tokens: 800 } } } });
  const uOne = finalUsageOf({ aiCalls: 1, calls: [{ kind: 'generate', end: 'ok', repairs: 0, ...(eIn.measured !== false ? { genEstimate: eIn } : {}) }] });
  assert(eIn.measured === false && eIn.input === null && eOut.measured === false && eBoth.measured === true && eBoth.input === 5000 && eBoth.output === 800 && KTAiBudget.callsOf('generate', { ai: { usage: { input_tokens: 5000 } } })[0] === null && uOne.usageUnknown === 1 && uOne.measured === 0,
    `B5-6: 片方だけの usage は使用量が不明（最終案は「使用量が不明」に数える・記録の callsOf と同じ扱い）: ${JSON.stringify({ eIn, eOut, uOne: [uOne.usageUnknown, uOne.measured] })}`);
});

console.log(`\n${state.failed ? 'NG' : 'OK'}: ${state.passed} passed, ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})();
