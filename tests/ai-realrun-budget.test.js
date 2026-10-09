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
//   §B8（再検証前の確認・2026-10-10）: 印のある Gateway の allowanceUsd = min(残り, その要求の上界の見積もり KTAiBudget.gatewayBound)（Gateway の上界の式に寄せた Toolkit の推定）。
//        質問の進行中の計画の更新も送る（allowance の合計は残りを超えない）・残りが本当に足りなければ止める・最初の呼び出しの前の BUDGET_EXCEEDED の後に 1 回だけ残り全額で送り直す・
//        detail が文字列の時間切れ（502 UPSTREAM_ERROR）の error.budget で精算する（確保を渡した allowance の全額のまま残さない）
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
const ALLOWED_ENTRY_KEYS = ['key', 'requestId', 'feature', 'kind', 'mode', 'sessionId', 'startedAt', 'endedAt', 'status', 'reservedUsd', 'reservedCalls', 'maxCallUsd', 'estimatedModel', 'maxOutputTokens', 'ctxBytes', 'model', 'calls', 'costUsd', 'costKnownUsd', 'costComplete', 'costCachedUsd', 'reason', 'enforcement', 'allowanceUsd', 'gatewayCalls'];

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
    && /検証の上限（費用・回数）を超えるため、AI に送りませんでした（次の要求は推定で最大 約 [0-9.]+ 米ドル・AI の呼び出し 3 回、残りは 約 0\.5 米ドル・100 回です（[^）]*推定による送信制限で、Gateway による上限の強制はありません）/.test(text) && KTAiConversation.stopKindOf(e) === 'budget',
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
  assert(btn && btn.disabled && /利用の上限（予算・回数）に達しました（次の要求は推定で最大 約 [0-9.]+ 米ドル・AI の呼び出し 3 回、残りは 約 [0-9.]+ 米ドル/.test(stripC(chat)) && kinds.join() === 'propose:done,propose:done,propose:done,plan:done' && /検証の上限（推定による送信制限・上限の強制は無い）: 記録済み 約 [0-9.]+ 米ドル・確保中 約 0 米ドル ／ 上限 1 米ドル・AI の呼び出し 4 \/ 100 回/.test(stripC(head)),
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
  assert(mid.inFlight === 1 && askRefused === 0 && /検証の上限（費用・回数）を超えるため、AI に送りませんでした（次の要求は推定で最大 約/.test(refusedText) && askSent === 1 && midBoth.reservedUsd >= mid.reservedUsd,
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

// =========================================================
console.log('\n--- §B6. 予算を使う検証で設定を確かめられないときは送らない（再検証前の指示 §3・2026-10-10） ---');
//   「予算を使わない通常の利用」（設定のキーが無く、読取に成功し、このページで一度も有効になっていない）は今までどおり素通し。
//   「予算を使う検証で状態を確かめられない」（設定の読取の例外・このページで一度有効だった設定が消えた・台帳の読取の例外）は送信 0 件（BUDGET_EXCEEDED・理由「設定を確かめられない」）。
//   一度有効だった印は、このページのメモリと sessionStorage（本文なし）。各送信の前に確かめる
const ARMED_KEY = `ktAi.budgetArmed.v1.${HOST}`;
await section(async () => {
  //   通常の利用（設定のキーが無く読取に成功・印なし）は止めない
  const storage = K.makeStorage(), session = K.makeStorage();
  const b = KTAiBudget.create({ storage, session, host: HOST, locks: null });
  const fc = fakeClient();
  const r = await catchOf(b.wrap(fc.client).ask({ ctx: {}, requestId: 'n-1' }));
  assert(r === null && fc.count('ask') === 1 && !('noProxyFallback' in fc.calls[0].p) && !b.enabled() && b.state() === 'disabled' && session.getItem(ARMED_KEY) === null && KTAiBudget.summaryText(b.summary()) === '',
    `B6-1: 予算を設定していない通常の利用（設定のキーが無く、読取に成功）は止めない（素通し・印を書かない）: ${JSON.stringify({ state: b.state(), armed: session.getItem(ARMED_KEY) })}`);
  //   設定の読取の例外 → 送信 0 件（今までは「無効」として上限なしで送っていた）
  const base = K.makeStorage(); setConfig(base, { limitUsd: 10 });
  const cfgThrows = { getItem: (k) => { if (k === CFG_KEY) throw new Error('SecurityError'); return base.getItem(k); }, setItem: (k, v) => base.setItem(k, v), removeItem: (k) => base.removeItem(k) };
  const b2 = KTAiBudget.create({ storage: cfgThrows, session: K.makeStorage(), host: HOST, locks: null });
  const f2 = fakeClient();
  const e2 = await catchOf(b2.wrap(f2.client).propose({ ctx: {} }));
  assert(e2 && e2.code === 'BUDGET_EXCEEDED' && reasonOf(e2) === 'config-unreadable' && f2.calls.length === 0 && b2.enabled() === true && /検証の上限を確かめられないため、AI に送りませんでした（検証の上限の設定を確かめられません（設定を読めません））/.test(KTAiClient.errorText(e2.code, e2)) && /設定を確かめられないため、AI に送りません/.test(KTAiBudget.summaryText(b2.summary())) && KTAiConversation.stopKindOf(e2) === 'budget',
    `B6-2: 設定の読取が例外 → 送信 0 件（理由「設定を確かめられない」・画面は包む側（enabled）・停止の種類は budget）: ${e2 && KTAiClient.errorText(e2.code, e2)}`);
  //   保存領域が無い（storage が取れない）: このタブで一度有効だった印があれば送らない。印が無ければ通常の利用
  //   （localStorage の参照そのものが例外になる場合も「設定を読めない」にしているが、テストの vm では参照の例外を作れないので、ここでは印で確かめる）
  const armedSession = K.makeStorage(); armedSession.setItem(ARMED_KEY, JSON.stringify({ id: 'v1', createdAt: CREATED }));
  const b3 = KTAiBudget.create({ storage: null, session: armedSession, host: HOST, locks: null });
  const f3 = fakeClient();
  const e3 = await catchOf(b3.wrap(f3.client).ask({ ctx: {} }));
  const b3n = KTAiBudget.create({ storage: null, session: K.makeStorage(), host: HOST, locks: null });
  assert(e3 && reasonOf(e3) === 'config-unreadable' && f3.calls.length === 0 && b3.state() === 'broken' && b3n.state() === 'disabled', `B6-3: 保存領域が取れない: このタブで有効だった印があれば送信 0 件・印が無ければ通常の利用: ${reasonOf(e3)} / ${b3n.state()}`);
});
await section(async () => {
  //   このページで一度有効だった設定が消えた（同じページ＝メモリの印）→ 送信 0 件
  const storage = K.makeStorage(), session = K.makeStorage();
  setConfig(storage, { limitUsd: 10 });
  const b = KTAiBudget.create({ storage, session, host: HOST, locks: null });
  const fc = fakeClient();
  const w = b.wrap(fc.client);
  await w.ask({ ctx: {} });
  const armed = session.getItem(ARMED_KEY);
  storage.removeItem(CFG_KEY);
  const e = await catchOf(w.ask({ ctx: {} }));
  assert(fc.count('ask') === 1 && !!armed && !/limitUsd|maxCalls/.test(armed) && JSON.parse(armed).id === 'v1' && e && reasonOf(e) === 'config-missing' && b.enabled() === true && /このページで有効だった設定が見つかりません/.test(KTAiClient.errorText(e.code, e)),
    `B6-4: 一度有効だった設定が消えた（同じページ）→ 次の送信 0 件（理由「設定を確かめられない」）。印は設定の id と作った日時だけ（金額は入れない）: ${JSON.stringify({ asks: fc.count('ask'), armed, e: reasonOf(e) })}`);
  //   読み込み直し（新しいページのインスタンス・同じタブの sessionStorage の印）でも送らない。別のタブ（印なし）は通常の利用として素通し
  const reloaded = KTAiBudget.create({ storage, session, host: HOST, locks: null, sessionId: 'p-reload' });
  const f2 = fakeClient();
  const e2 = await catchOf(reloaded.wrap(f2.client).ask({ ctx: {} }));
  const otherTab = KTAiBudget.create({ storage, session: K.makeStorage(), host: HOST, locks: null });
  const f3 = fakeClient();
  const e3 = await catchOf(otherTab.wrap(f3.client).ask({ ctx: {} }));
  assert(reasonOf(e2) === 'config-missing' && f2.calls.length === 0 && e3 === null && f3.count('ask') === 1 && otherTab.state() === 'disabled',
    `B6-5: 読み込み直しの後も sessionStorage の印で送らない。印の無い別のタブ（設定のキーが無く読めた）は通常の利用: ${JSON.stringify({ reload: reasonOf(e2), other: otherTab.state() })}`);
  //   sessionStorage を読めない・書けない → メモリの印だけ（同じページでは止める）
  const st2 = K.makeStorage(); setConfig(st2, { limitUsd: 10 });
  const badSession = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { } };
  const b4 = KTAiBudget.create({ storage: st2, session: badSession, host: HOST, locks: null });
  const f4 = fakeClient();
  const w4 = b4.wrap(f4.client);
  await w4.ask({ ctx: {} });
  st2.removeItem(CFG_KEY);
  const e4 = await catchOf(w4.ask({ ctx: {} }));
  assert(f4.count('ask') === 1 && reasonOf(e4) === 'config-missing', `B6-6: sessionStorage を読めない・書けないときもメモリの印で止める: ${reasonOf(e4)}`);
});
await section(async () => {
  //   台帳の読取の例外（一度送った後）→ 送信 0 件（確保・精算も記録を読めなければ送らない）。設定が壊れた・別の形になった → 送らない
  const base = K.makeStorage(); setConfig(base, { limitUsd: 10 });
  let ledgerThrows = false;
  const storage = { getItem: (k) => { if (ledgerThrows && k === ledgerKey()) throw new Error('denied'); return base.getItem(k); }, setItem: (k, v) => base.setItem(k, v), removeItem: (k) => base.removeItem(k) };
  const b = KTAiBudget.create({ storage, session: K.makeStorage(), host: HOST, locks: null });
  const fc = fakeClient();
  const w = b.wrap(fc.client);
  await w.ask({ ctx: {} });
  ledgerThrows = true;
  const e = await catchOf(w.ask({ ctx: {} }));
  ledgerThrows = false;
  base.setItem(CFG_KEY, '{bad');
  const e2 = await catchOf(w.ask({ ctx: {} }));
  assert(fc.count('ask') === 1 && reasonOf(e) === 'ledger-unreadable' && reasonOf(e2) === 'config-invalid', `B6-7: 台帳の読取の例外・壊れた設定 → 送信 0 件: ${reasonOf(e)} / ${reasonOf(e2)}`);
});
await section(async () => {
  //   画面: 各送信の前に確かめる（makeClient が送信ごとに状態を読む）。最初の仮案は送り、設定が消えた後の仮案は送らない（理由を出す・見出しにも出す）
  const storage = K.makeStorage(), session = K.makeStorage();
  setConfig(storage, { limitUsd: 10 });
  const budget = KTAiBudget.create({ storage, session, host: HOST, locks: null });
  K.META.ai.model = MODEL;
  const { m } = mountB({ budget });
  await ticks();
  await m.panel.send(K.REQUESTS[0]); await ticks(10);
  const sent1 = m.calls.propose.length;
  storage.removeItem(CFG_KEY);
  await m.panel.send(K.REQUESTS[1]); await ticks(10);
  const text = stripC(m.chat());
  const head = stripC(m.$('kt-ai-header').innerHTML);
  assert(sent1 === 1 && m.calls.propose.length === 1 && /検証の上限を確かめられないため、AI に送りませんでした（検証の上限の設定を確かめられません（このページで有効だった設定が見つかりません/.test(text) && /設定を確かめられないため、AI に送りません/.test(head),
    `B6-8: 画面: 一度有効だった設定が消えた後の送信は 0 件（理由を会話と見出しに出す）: ${JSON.stringify({ sent1, now: m.calls.propose.length })} / ${text.slice(-400)} / ${head.slice(0, 200)}`);
});

// =========================================================
console.log('\n--- §B7. Gateway が要求の上界で強制する上限（health の limits.budgetAllowance・再検証前の指示 §4・2026-10-10） ---');
//   印（limits.budgetAllowance = { version: 1, models }）があるときだけ envelope に budget: { allowanceUsd } を付ける。allowanceUsd = 上限 − 記録済みの費用（不明は確保額）− ほかの進行中・
//   終了不明の確保額。この要求の確保額 = allowanceUsd。meta.budget で精算。Gateway の BUDGET_EXCEEDED（stage first・AI を呼んでいない）は解放して送信を止める。
//   印の無い Gateway は今の推定による送信制限だけ（画面と記録に「推定による送信制限（上限の強制は無い）」と区別して出す）
const BA = { version: 1, models: [MODEL] };
const LIM_ON = { version: 1, deadlineMs: { 'assistant-qa': 120000, 'change-planner': 310000, 'customization-generator': 310000 }, features: { 'assistant-qa': { model: MODEL }, 'change-planner': { model: MODEL }, 'customization-generator': { model: MODEL } }, budgetAllowance: BA };
const LIM_OFF = { version: 1, deadlineMs: { ...LIM_ON.deadlineMs }, features: clone(LIM_ON.features) };
const metaOf = (allowanceUsd, calls) => ({ allowanceUsd, spentUsd: Math.round(calls.reduce((s, c) => s + (c.costUsd != null ? c.costUsd : c.boundUsd), 0) * 1e6) / 1e6, complete: calls.every(c => c.costUsd != null), calls });
const gwBudgetErr = (detail) => Object.assign(gwErr('BUDGET_EXCEEDED', detail), { httpStatus: 402 });
/** 再検証前の確認（並行の要求・2026-10-10）: その要求の上界の見積もり（KTAiBudget.gatewayBound の maxUsd。関数が無い修正前の版では NaN＝例外で止めずに期待で落とす） */
const GBv = (kind, ctx, limits = LIM_ON) => (typeof KTAiBudget.gatewayBound === 'function' ? KTAiBudget.gatewayBound({ kind, ctx, limits }).maxUsd : NaN);
await section(async () => {
  //   health の印の読み取りと、どの要求で強制できるか
  const h = clone(K.HEALTH); h.limits = { version: 1, deadlineMs: { 'toolkit.assistant-qa': 120000 }, budgetAllowance: { version: 1, models: [MODEL, 7, ''] } };
  const lim = KTAiClient.limitsFromHealth(h);
  const cap = KTAiClient.capabilityFromHealth(h);
  const h2 = clone(K.HEALTH); h2.limits = { version: 1, budgetAllowance: { version: 2, models: [MODEL] } };
  const h3 = clone(K.HEALTH); h3.limits = { budgetAllowance: { version: 1, models: [MODEL] } };
  assert(lim && JSON.stringify(lim.budgetAllowance) === JSON.stringify({ version: 1, models: [MODEL] }) && cap.limits && cap.limits.budgetAllowance && KTAiClient.limitsFromHealth(h2) === null && KTAiClient.limitsFromHealth(h3) && KTAiClient.limitsFromHealth(h3).budgetAllowance && Object.keys(KTAiClient.limitsFromHealth(h3).deadlineMs).length === 0,
    `B7-0a: health の limits.budgetAllowance（version 1・models は文字列だけ）を読む（version の違う印は読まない・期限が無くても印は読む）: ${JSON.stringify({ lim, h2: KTAiClient.limitsFromHealth(h2), h3: KTAiClient.limitsFromHealth(h3) })}`);
  const E = KTAiBudget.enforcementOf;
  const other = { ...LIM_ON, features: { ...LIM_ON.features, 'customization-generator': { model: 'gpt-other' } } };
  assert(E(LIM_ON, 'generate') === 'gateway' && E(LIM_ON, 'ask') === 'gateway' && E(LIM_OFF, 'generate') === 'estimate' && E(null, 'plan') === 'estimate' && E(other, 'generate') === 'estimate' && E(other, 'plan') === 'gateway' && E({ ...LIM_ON, features: { 'change-planner': { model: `${MODEL}-2026-08-01` } } }, 'plan') === 'gateway',
    'B7-0b: 強制できるのは印があり、その要求のモデルが印の models にあるときだけ（日付つきの版も同じ。無ければ推定による送信制限）');
  //   envelope の最上位の budget（印があるときだけ・有限・0 以上）
  const env = KTAiClient.buildGenerateEnvelope({ ctx: { customization: {}, contextVersion: 'c' }, budget: { allowanceUsd: 0.1234567 } });
  const env0 = KTAiClient.buildGenerateEnvelope({ ctx: { customization: {}, contextVersion: 'c' } });
  const envBad = KTAiClient.buildPlanEnvelope({ ctx: { facts: [], goal: 'g', contextVersion: 'p' }, budget: { allowanceUsd: -1 } });
  const envNaN = KTAiClient.buildAskEnvelope({ ctx: { facts: [], contextVersion: 'a' }, budget: { allowanceUsd: '1' } });
  assert(JSON.stringify(env.budget) === '{"allowanceUsd":0.123456}' && !('budget' in env0) && !('budget' in envBad) && !('budget' in envNaN) && Object.keys(env).join() === 'contractVersion,meta,payload,budget',
    `B7-0c: envelope の最上位に budget: { allowanceUsd }（6 桁で切り捨て＝残りを超えない）。無い・負・数でなければ付けない: ${JSON.stringify(env.budget)}`);
  //   client の 4 つの要求が budget を envelope まで渡す
  const bodies = [];
  const transport = async (a) => { bodies.push(JSON.parse(a.body)); return { status: 500, body: JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'x' } }) }; };
  const client = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: HOST, transport });
  await catchOf(client.ask({ ctx: { facts: [], contextVersion: 'a' }, budget: { allowanceUsd: 1 } }));
  await catchOf(client.propose({ ctx: { facts: [], contextVersion: 'a', conversation: { mode: 'proposal' }, question: 'q' }, budget: { allowanceUsd: 2 } }));
  await catchOf(client.plan({ ctx: { facts: [], goal: 'g', contextVersion: 'p' }, budget: { allowanceUsd: 3 } }));
  await catchOf(client.generate({ ctx: { customization: {}, contextVersion: 'c' }, budget: { allowanceUsd: 4 } }));
  await catchOf(client.generate({ ctx: { customization: {}, contextVersion: 'c' } }));
  assert(bodies.map(b => (b.budget ? b.budget.allowanceUsd : null)).join() === '1,2,3,4,', `B7-0d: ask / propose / plan / generate は budget を envelope に入れる（渡さなければ入れない）: ${bodies.map(b => JSON.stringify(b.budget || null)).join(' ')}`);
});
await section(async () => {
  //   印あり: 残り = 上限 − 記録済み − ほかの進行中・終了不明の確保額。allowanceUsd = min(残り, この要求の上界の見積もり KTAiBudget.gatewayBound)（再検証前の確認の並行の要求・
  //   2026-10-10。以前の期待「残り全額」を直した）。この要求の確保額 = allowanceUsd。meta.budget で精算
  const GB = (kind, ctx) => GBv(kind, ctx);
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  const { storage, budget } = mkBudget({ config: { limitUsd: 2 } });
  const seen = [];
  const g = gate();
  const fc = fakeClient({
    ask: (p) => { seen.push(['ask', p.budget]); return { ai: { model: MODEL, usage: usage(1000, 200) }, budgetMeta: metaOf(p.budget.allowanceUsd, [{ kind: 'ask', boundUsd: 0.05, costUsd: 0.004 }]) }; },
    plan: async (p) => { seen.push(['plan', p.budget]); await g.p; return { ai: { model: MODEL, usage: usage(30000, 2000) }, budgetMeta: metaOf(p.budget.allowanceUsd, [{ kind: 'plan-patch', boundUsd: 0.6, costUsd: null }, { kind: 'plan-full', boundUsd: 0.5, costUsd: 0.08 }]) }; },
    generate: (p) => { seen.push(['generate', p.budget]); return { ai: { model: MODEL, usage: usage(5000, 800) }, budgetMeta: metaOf(p.budget.allowanceUsd, [{ kind: 'generate', boundUsd: 0.3, costUsd: 0.02 }]) }; },
  });
  const w = budget.wrap(fc.client, { limits: LIM_ON });
  await w.ask({ ctx: {}, requestId: 'a-1' });
  const a1 = ledgerOf(storage).entries[0];
  const ctxP = { goal: 'g', revision: { mode: 'patch' } }, ctxG = { customization: {} };
  const pPlan = w.plan({ ctx: ctxP, requestId: 'p-1' });
  await ticks();
  const pIn = clone(ledgerOf(storage).entries[1]);
  const sMid = budget.summary();
  //   計画の確保（＝ min(残り 1.996, 計画の上界の見積もり)）が残っている間の生成も送る（allowanceUsd = min(残り − 計画の確保, 生成の上界の見積もり)。2 つの確保の合計は残りを超えない）
  const eGen = await catchOf(w.generate({ ctx: ctxG }));
  const gIn = clone(ledgerOf(storage).entries[2] || {});
  g.open(); await pPlan;
  const p1 = ledgerOf(storage).entries[1];
  assert(a1.enforcement === 'gateway' && GB('ask', {}) > 0 && GB('ask', {}) < 2 && a1.allowanceUsd === GB('ask', {}) && seen[0][1].allowanceUsd === a1.allowanceUsd && a1.status === 'done' && a1.costUsd === 0.004 && a1.reservedUsd === 0 && JSON.stringify(a1.gatewayCalls) === JSON.stringify([{ kind: 'ask', boundUsd: 0.05, costUsd: 0.004 }]),
    `B7-1: 印あり: 最初の要求は allowanceUsd = min(上限 2 − 0, 質問の上界の見積もり ${GB('ask', {})}) を渡し、meta.budget の complete で精算（費用 = spentUsd・確保 0）: ${JSON.stringify(a1)}`);
  const wantGen = r6(Math.min(1.996 - pIn.allowanceUsd, GB('generate', ctxG)));
  assert(pIn.status === 'in-flight' && GB('plan', ctxP) < 1.996 && pIn.allowanceUsd === GB('plan', ctxP) && pIn.reservedUsd === pIn.allowanceUsd && seen[1][1].allowanceUsd === pIn.allowanceUsd && sMid.reservedUsd === pIn.allowanceUsd
    && eGen === null && fc.count('generate') === 1 && gIn.allowanceUsd === wantGen && seen[2][1].allowanceUsd === wantGen && wantGen > 0 && pIn.allowanceUsd + gIn.allowanceUsd <= 1.996 + 1e-9,
    `B7-2: 次の要求の allowanceUsd = min(上限 − 記録済み 0.004 = 1.996, 計画の上界の見積もり ${GB('plan', ctxP)})（確保額 = allowanceUsd。残り全額を確保しない）。その確保が残っている間の生成も allowanceUsd = min(残り, 生成の上界の見積もり) で送り、2 つの合計は残りを超えない: ${JSON.stringify({ pIn: [pIn.allowanceUsd, pIn.reservedUsd], sMid: sMid.reservedUsd, gen: [gIn.allowanceUsd, wantGen], eGen: eGen && eGen.details })}`);
  assert(p1.status === 'partial-unknown' && p1.costUsd === null && p1.costKnownUsd === 0.08 && p1.reservedUsd === 0.6 && p1.reservedCalls === 2 && budget.summary().recordedUsd === 0.104 && budget.summary().reservedUsd === 0.6,
    `B7-3: meta.budget が complete でない → 確認できた費用（0.08）を記録し、費用が分からない呼び出しはその上界（boundUsd 0.6）を確保に残す（呼び出しの記録どおり）: ${JSON.stringify(p1)}`);
  const next = await catchOf(w.generate({ ctx: ctxG }));
  assert(next === null && GB('generate', ctxG) > 1.296 && seen[3] && seen[3][0] === 'generate' && seen[3][1].allowanceUsd === 1.296, `B7-4: 次の allowanceUsd = min(2 − 0.104 − 0.6 = 1.296, 生成の上界の見積もり ${GB('generate', ctxG)}) = 1.296（不明は上界で数える）: ${JSON.stringify(seen[3])}`);
});
await section(async () => {
  //   Gateway の BUDGET_EXCEEDED: stage first（AI を呼んでいない）→ 解放し送信を止める理由（budget）。plan-full（差分の後）→ detail.budget で精算（解放しない・送った要求）
  const { storage, budget } = mkBudget({ config: { limitUsd: 1 } });
  const first = gwBudgetErr({ reason: 'over-allowance', stage: 'first', allowanceUsd: 1, boundUsd: 1.27 });
  const fc = fakeClient({ generate: () => { throw first; } });
  const w = budget.wrap(fc.client, { limits: LIM_ON });
  const e = await catchOf(w.generate({ ctx: { customization: {} } }));
  const x = ledgerOf(storage).entries[0];
  const text = KTAiClient.errorText(e.code, e);
  assert(e === first && x.status === 'released' && x.reservedUsd === 0 && x.costUsd === 0 && budget.summary().reservedUsd === 0 && KTAiBudget.preAiOf(e) === true && KTAiBudget.notSentOf(e) === true && KTAiConversation.stopKindOf(e) === 'budget' && /この呼び出しの上界 約 1\.27 米ドル（送る要求の大きさと出力の上限から Gateway が計算）が、渡した残り 約 1 米ドルを超えるため、AI を呼びませんでした/.test(text),
    `B7-5: Gateway の BUDGET_EXCEEDED（stage first）→ 確保を解放・送らなかった要求（費用なし）・送信の停止の種類は budget・画面の文は上界と残り: ${JSON.stringify(x)} / ${text}`);
  const { storage: s2, budget: b2 } = mkBudget({ config: { limitUsd: 1 } });
  const full = gwBudgetErr({ reason: 'over-allowance', stage: 'plan-full', allowanceUsd: 1, boundUsd: 0.9, budget: metaOf(1, [{ kind: 'plan-patch', boundUsd: 0.5, costUsd: 0.2 }]) });
  const f2 = fakeClient({ plan: () => { throw full; } });
  const e2 = await catchOf(b2.wrap(f2.client, { limits: LIM_ON }).plan({ ctx: { goal: 'g', revision: { mode: 'patch' } } }));
  const y = ledgerOf(s2).entries[0];
  assert(e2 === full && y.status === 'done' && y.costUsd === 0.2 && y.reservedUsd === 0 && y.reason === 'BUDGET_EXCEEDED' && KTAiBudget.preAiOf(e2) === false && KTAiBudget.notSentOf(e2) === false && /計画の差分更新を全体の作り直しに切り替える呼び出しは/.test(KTAiClient.errorText(e2.code, e2)),
    `B7-6: Gateway が差分の後の全体の作り直しを止めた（stage plan-full）→ 解放せず detail.budget で精算（差分の 0.2 米ドル）・送った要求として数える: ${JSON.stringify(y)}`);
  //   AI を呼んだ後のほかのエラーも detail.budget があれば精算・無ければ終了不明（渡した allowanceUsd を確保に残す）
  const { storage: s3, budget: b3 } = mkBudget({ config: { limitUsd: 1 } });
  const up = gwErr('UPSTREAM_ERROR', { reason: 'timeout', budget: metaOf(1, [{ kind: 'generate', boundUsd: 0.4, costUsd: null }]) });
  await catchOf(b3.wrap(fakeClient({ generate: () => { throw up; } }).client, { limits: LIM_ON }).generate({ ctx: { customization: {} } }));
  const z = ledgerOf(s3).entries[0];
  const { storage: s4, budget: b4 } = mkBudget({ config: { limitUsd: 1 } });
  await catchOf(b4.wrap(fakeClient({ generate: () => { throw aiErr('TIMEOUT'); } }).client, { limits: LIM_ON }).generate({ ctx: { customization: {} } }));
  const z4 = ledgerOf(s4).entries[0];
  assert(z.status === 'unknown' && z.reservedUsd === 0.4 && z.costUsd === null && z4.status === 'unknown' && z4.reservedUsd === 1 && z4.allowanceUsd === 1,
    `B7-7: AI を呼んだ後のエラー: detail.budget があればその上界を確保に残す（0.4）・無ければ渡した allowanceUsd を残す（1。Gateway はこれを超えて使わない）: ${JSON.stringify({ z: [z.status, z.reservedUsd], z4: [z4.status, z4.reservedUsd] })}`);
});
await section(async () => {
  //   印あり なのに応答に meta.budget が無い（取り決めと合わない）→ 以後を止める。spentUsd が allowanceUsd を超える → 以後を止める
  const { storage, budget } = mkBudget({ config: { limitUsd: 1 } });
  const fc = fakeClient();
  const w = budget.wrap(fc.client, { limits: LIM_ON });
  await w.ask({ ctx: {} });
  const e = await catchOf(w.ask({ ctx: {} }));
  const { storage: s2, budget: b2 } = mkBudget({ config: { limitUsd: 1 } });
  const w2 = b2.wrap(fakeClient({ ask: (p) => ({ ai: { model: MODEL, usage: usage(10, 10) }, budgetMeta: metaOf(p.budget.allowanceUsd, [{ kind: 'ask', boundUsd: 2, costUsd: 1.5 }]) }) }).client, { limits: LIM_ON });
  await w2.ask({ ctx: {} });
  const e2 = await catchOf(w2.ask({ ctx: {} }));
  assert(ledgerOf(storage).stopped && ledgerOf(storage).stopped.reason === 'no-budget-meta' && reasonOf(e) === 'stopped' && fc.count('ask') === 1 && ledgerOf(s2).stopped && ledgerOf(s2).stopped.reason === 'over-allowance' && reasonOf(e2) === 'stopped',
    `B7-8: 印ありで meta.budget の無い応答・渡した上限を超えた spentUsd → 以後の送信を止める: ${JSON.stringify({ a: ledgerOf(storage).stopped, b: ledgerOf(s2).stopped })}`);
});
await section(async () => {
  //   印なし: envelope に budget を付けない・記録は推定（enforcement estimate）・画面の文は推定による送信制限（上限の強制は無い）と区別する。「超えない」「保証」と言わない
  const { storage, budget } = mkBudget({ config: { limitUsd: 1 } });
  const seen = [];
  const fc = fakeClient({ ask: (p) => { seen.push(p.budget); return { ai: { model: MODEL, usage: usage(1000, 200) } }; } });
  const w = budget.wrap(fc.client, { limits: LIM_OFF });
  await w.ask({ ctx: {} });
  const x = ledgerOf(storage).entries[0];
  const head = KTAiBudget.summaryText(budget.summary());
  const eG = await catchOf(w.generate({ ctx: { customization: {} } }));
  const textE = KTAiClient.errorText(eG.code, eG);
  const { budget: bOn } = mkBudget({ config: { limitUsd: 1 } });
  bOn.wrap(fakeClient().client, { limits: LIM_ON });
  const headOn = KTAiBudget.summaryText(bOn.summary());
  const texts = [head, headOn, textE, ...['limit', 'calls', 'unknown-model', 'stopped', 'config-unreadable', 'config-missing', 'gateway-over-allowance'].map(r => KTAiClient.budgetDetailText({ reason: r, needUsd: 1, remainingUsd: 0.5, allowanceUsd: 0.5, boundUsd: 1 }))];
  assert(seen.length === 1 && seen[0] === undefined && x.enforcement === 'estimate' && !('allowanceUsd' in x) && /^検証の上限（推定による送信制限・上限の強制は無い）: 記録済み/.test(head) && /^検証の上限（Gateway が要求ごとに上限を強制）: 記録済み/.test(headOn)
    && /次の要求は推定で最大 約 [0-9.]+ 米ドル/.test(textE) && /推定による送信制限で、Gateway による上限の強制はありません/.test(textE) && texts.every(t => !/超えない|超えることはありません|保証/.test(t)),
    `B7-9: 印なし: budget を付けない・記録は推定・見出しと拒否の文は「推定による送信制限（上限の強制は無い）」。印ありの見出しは「Gateway が要求ごとに上限を強制」。どの文も「超えない」「保証」と言わない: ${JSON.stringify({ head, headOn, textE })}`);
});
await section(async () => {
  //   画面: health の印を読み、makeClient の包みが budget を付ける（仮案・計画・生成）。meta.budget で精算し、見出しは「Gateway が要求ごとに上限を強制」
  //   再検証前の確認（並行の要求・2026-10-10）: 要求ごとの allowanceUsd = min(残り, その要求の上界の見積もり)（以前の期待「残り全額 3 → … → 2.96」を直した）
  const { storage, budget } = mkBudget({ config: { limitUsd: 3 } });
  const health = clone(K.HEALTH_V); health.limits = clone(LIM_ON);
  const sent = [];
  const meta1 = (kind, p) => metaOf(p.budget ? p.budget.allowanceUsd : null, [{ kind, boundUsd: 0.2, costUsd: 0.01 }]);
  const clientWrap = (c) => ({ ...c,
    propose: async (p) => { sent.push(['propose', p.budget, p.ctx]); const r = await c.propose(p); r.ai = { model: MODEL, usage: usage(500, 100) }; r.budgetMeta = meta1('propose', p); return r; },
    plan: async (p) => { sent.push(['plan', p.budget, p.ctx]); const r = await c.plan(p); r.ai = { ...(r.ai || {}), model: MODEL, usage: usage(500, 100) }; r.budgetMeta = meta1('plan-full', p); return r; },
    generate: async (p) => { sent.push(['generate', p.budget, p.ctx]); const r = await c.generate(p); r.ai = { model: MODEL, usage: usage(3000, 700) }; r.budgetMeta = meta1('generate', p); return r; },
  });
  const gen = K.screenGenerate({ field: 'case_name', targetFile: 'caseLock.js' });
  const m = K.mount({ health, planImpl: K.planImplOf(K.screenPlan('js')), generateImpl: gen.impl, liveBase: true, extra: { budget }, clientWrap });
  await ticks();
  const v = await K.adoptOnScreen(m); await ticks(20);
  const led = ledgerOf(storage);
  const head = stripC(m.$('kt-ai-header').innerHTML);
  const allow = sent.map(([k, b]) => `${k}:${b ? b.allowanceUsd : 'none'}`);
  //   送った順の i 番目の残りは 3 − 0.01 × i（前の要求はどれも 0.01 米ドルで確定）。期待 = min(残り, その要求の Context の上界の見積もり)
  const want = sent.map(([k, , ctx], i) => Math.round(Math.min(3 - 0.01 * i, GBv(k, ctx)) * 1e6) / 1e6);
  assert(sent.length === 5 && sent.map(([k]) => k).join() === 'propose,propose,propose,plan,generate' && sent.every(([, b], i) => b && b.allowanceUsd === want[i] && b.allowanceUsd < 3 - 0.01 * i) && JSON.stringify(led.entries.map(e => e.allowanceUsd)) === JSON.stringify(want) && led.entries.every(e => e.enforcement === 'gateway' && e.status === 'done' && e.costUsd === 0.01 && e.reservedUsd === 0) && v && v.final && !v.final.incomplete && /検証の上限（Gateway が要求ごとに上限を強制）: 記録済み 約 0\.05 米ドル・確保中 約 0 米ドル/.test(head),
    `B7-10: 画面: 印のある Gateway には仮案・計画・生成の要求ごとに allowanceUsd = min(残り, その要求の上界の見積もり) を渡し（残り全額にしない）、meta.budget で精算・見出しは強制の印: ${JSON.stringify({ allow, want, head: head.slice(0, 120) })}`);
});
await section(async () => {
  //   画面: Gateway が生成を上限で止めた（stage first）→ 確保を解放・最終案は予算で止まった未完成（［残りの JavaScript を作る］は無効・理由は上界と残り）
  const { storage, budget } = mkBudget({ config: { limitUsd: 3 } });
  const health = clone(K.HEALTH_V); health.limits = clone(LIM_ON);
  const clientWrap = (c) => ({ ...c,
    propose: async (p) => { const r = await c.propose(p); r.ai = { model: MODEL, usage: usage(500, 100) }; r.budgetMeta = metaOf(p.budget.allowanceUsd, [{ kind: 'propose', boundUsd: 0.2, costUsd: 0.01 }]); return r; },
    plan: async (p) => { const r = await c.plan(p); r.ai = { ...(r.ai || {}), model: MODEL, usage: usage(500, 100) }; r.budgetMeta = metaOf(p.budget.allowanceUsd, [{ kind: 'plan-full', boundUsd: 0.2, costUsd: 0.01 }]); return r; },
    generate: async (p) => { throw gwBudgetErr({ reason: 'over-allowance', stage: 'first', allowanceUsd: p.budget.allowanceUsd, boundUsd: 3.2 }); },
  });
  const m = K.mount({ health, planImpl: K.planImplOf(K.screenPlan('js')), generateImpl: async () => { throw new Error('not used'); }, liveBase: true, extra: { budget }, clientWrap });
  await ticks();
  const v = await K.adoptOnScreen(m); await ticks(20);
  const fin = v && v.final;
  const chat = m.chat();
  const g = ledgerOf(storage).entries.find(e => e.kind === 'generate');
  const btn = restButtonOf(chat);
  assert(fin && fin.incomplete && fin.incomplete.kind === 'budget' && fin.incomplete.budget && fin.incomplete.budget.reason === 'gateway-over-allowance' && !fin.approvable && g && g.status === 'released' && g.reservedUsd === 0 && btn && btn.disabled && /呼び出しの上界 約 3\.2 米ドル（送る要求の大きさと出力の上限から Gateway が計算）が、渡した残り 約 2\.96 米ドルを超えるため、Gateway が呼び出しませんでした/.test(stripC(chat)),
    `B7-11: 画面: Gateway が上限で生成を止めた → 確保を解放・送信を止める（予算で止まった未完成・続きのボタンは無効・理由は上界と残り）: ${JSON.stringify({ inc: fin && fin.incomplete, g: g && [g.status, g.reservedUsd] })}`);
});

// =========================================================
console.log('\n--- §B8. 印のある Gateway の要求ごとの allowance（再検証前の確認・2026-10-10: 並行の要求が残りを全部確保しない・最初の呼び出しの前の BUDGET_EXCEEDED の後の 1 回だけの送り直し・時間切れの費用の記録） ---');
//   allowanceUsd = min(残り, その要求の上界の見積もり KTAiBudget.gatewayBound)。見積もりは Gateway の上界の式（(本文のバイト数 ＋ 64 × 2) × 入力の単価 ＋ 出力の上限 × 出力の単価）に
//   寄せた Toolkit の推定（入力 = 送る Context を Gateway が本文に入れる形のバイト数 ＋ 指示と schema の保守的な定数 ＋ 64 × 2・出力 = 出力の上限・内部の呼び出しの最大の分）
const gwErrB = (code, detail, budgetRec) => aiErr(code, { details: { ok: false, error: { code, message: 'x', ...(detail != null ? { detail } : {}), ...(budgetRec ? { budget: budgetRec } : {}) } } });
const w8 = (budget, fc) => budget.wrap(fc.client, { limits: LIM_ON });
await section(async () => {
  //   部品: 上界の見積もりの式
  const GBo = (kind, ctx, limits = LIM_ON) => (typeof KTAiBudget.gatewayBound === 'function' ? KTAiBudget.gatewayBound({ kind, ctx, limits }) : { ok: false, calls: [] });
  const body = (ctx) => (typeof KTAiBudget.gatewayBodyBytesOf === 'function' ? KTAiBudget.gatewayBodyBytesOf(ctx) : NaN);
  const P = KTAiBudget.PROMPT_BYTES;
  const usd = (inBytes, out) => Math.round(inBytes * 2 + out * 10) / 1e6;   // 1e-6 米ドルの整数（バイト数と token 数が整数なので切り上げは要らない）
  const a = GBo('ask', {}), pr = GBo('propose', { facts: [], conversation: { mode: 'proposal' }, question: 'q' });
  const ctxG = { customization: { customizationId: 'C1', requirement: '承認済みでは「金額」を編集不可' } }, g = GBo('generate', ctxG);
  const ctxP = { facts: [], goal: 'g', revision: { mode: 'patch', previousPlan: { customizations: [] } } }, pp = GBo('plan', ctxP), pf = GBo('plan', { facts: [], goal: 'g' });
  const big = GBo('generate', ctxG, { ...LIM_ON, features: { ...LIM_ON.features, 'customization-generator': { model: MODEL, maxOutputTokens: 16000, maxAiCalls: 4 } } });
  assert(body({}) === 4 && body({ a: '"' }) === Buffer.byteLength(JSON.stringify(JSON.stringify({ a: '"' }, null, 1))) && body(ctxG) > Buffer.byteLength(JSON.stringify(ctxG))
    && a.ok && a.calls.length === 1 && a.calls[0].inputBytes === P.ask + 4 + 128 && a.maxUsd === usd(P.ask + 4 + 128, 4000) && a.maxUsd === 0.076264
    && pr.ok && pr.calls.length === 1 && pr.calls[0].inputBytes === P.propose + body({ facts: [], conversation: { mode: 'proposal' }, question: 'q' }) + 128
    && g.calls.map(c => c.kind).join() === 'generate,repair,repair' && g.calls[0].inputBytes === P.generate + body(ctxG) + 128 && g.calls[1].inputBytes === g.calls[0].inputBytes + 32000 * 2 + 8000 && g.calls.every(c => c.output === 32000) && g.maxUsd === Math.round(g.calls.reduce((s, c) => s + usd(c.inputBytes, 32000), 0) * 1e6) / 1e6
    && pp.calls.map(c => c.kind).join() === 'plan-patch,plan-full' && pp.calls[0].inputBytes === P['plan-patch'] + body(ctxP) + 128 && pp.calls[1].inputBytes === P['plan-full'] + body(ctxP) + 128 + 8000 && pf.calls.length === 1 && pf.calls[0].kind === 'plan-full'
    && big.calls.length === 4 && big.calls.every(c => c.output === 16000) && big.calls[1].inputBytes === big.calls[0].inputBytes + 16000 * 2 + 8000,
    `B8-0: 上界の見積もり = (Gateway が本文に入れる形の Context のバイト数 ＋ 指示と schema の定数 ＋ 64 × 2) × 2 / 1e6 ＋ 出力の上限 × 10 / 1e6 を内部の呼び出しの最大の分（生成 ＋ 修復 2・差分 → 全体）。修復・作り直しは前回の出力と余裕を足す。health の出力の上限・呼び出しの最大を使う: ${JSON.stringify({ a: a.maxUsd, g: g.calls, pp: pp.calls, big: big.calls.map(c => [c.inputBytes, c.output]) })}`);
});
await section(async () => {
  //   concurrency-probe の形: 上限 5 米ドル・質問（askAside）の進行中に計画の更新 → 両方送る（以前は質問が残り全額 5 を確保して計画の更新が残り 0 で止まった）。
  //   allowance の合計は残りを超えない
  const { storage, budget } = mkBudget({ config: { limitUsd: 5 } });
  const g = gate();
  const sent = [];
  const fc = fakeClient({
    ask: async (p) => { sent.push(['ask', p.budget]); await g.p; return { ai: { model: MODEL, usage: usage(1000, 200) }, budgetMeta: metaOf(p.budget.allowanceUsd, [{ kind: 'qa', boundUsd: 0.07, costUsd: 0.004 }]) }; },
    plan: async (p) => { sent.push(['plan', p.budget]); return { ai: { model: MODEL, usage: usage(1000, 200) }, budgetMeta: metaOf(p.budget.allowanceUsd, [{ kind: 'plan-full', boundUsd: 0.7, costUsd: 0.004 }]) }; },
  });
  const w = budget.wrap(fc.client, { limits: LIM_ON });
  const ctxAsk = { facts: [], contextVersion: 'a', question: 'q' }, ctxPlan = { facts: [], goal: 'g', contextVersion: 'p' };
  const pAsk = w.ask({ ctx: ctxAsk }).catch(e => e);
  await ticks();
  const ePlan = await catchOf(w.plan({ ctx: ctxPlan }));
  const mid = budget.summary();
  g.open(); await pAsk;
  const [ea, ep] = ledgerOf(storage).entries;
  const GA = GBv('ask', ctxAsk), GP = GBv('plan', ctxPlan);
  assert(ePlan === null && sent.map(([k]) => k).join() === 'ask,plan' && sent[0][1].allowanceUsd === GA && sent[1][1].allowanceUsd === GP && GA + GP <= 5 && ea.allowanceUsd === GA && ep.allowanceUsd === GP && ea.status === 'done' && ep.status === 'done' && budget.summary().reservedUsd === 0 && budget.summary().recordedUsd === 0.008,
    `B8-1: 質問の進行中の計画の更新も送る（質問は min(5, 質問の上界の見積もり ${GA})・計画は min(5 − 質問の確保, 計画の上界の見積もり ${GP})。両方の allowance の合計は残りを超えない）: ${JSON.stringify({ sent, mid: mid.reservedUsd, ePlan: ePlan && ePlan.details })}`);
  //   残りが本当に足りないとき: 上限 = 質問の上界の見積もり（質問の確保で残り 0）→ 計画の更新は送らない（送信 0 件・理由 limit・残り 0）
  const { storage: s2, budget: b2 } = mkBudget({ config: { limitUsd: GA } });
  const g2 = gate();
  const sent2 = [];
  const f2 = fakeClient({ ask: async (p) => { sent2.push(['ask', p.budget]); await g2.p; return { ai: { model: MODEL, usage: usage(1000, 200) }, budgetMeta: metaOf(p.budget.allowanceUsd, [{ kind: 'qa', boundUsd: 0.07, costUsd: 0.004 }]) }; }, plan: async (p) => { sent2.push(['plan', p.budget]); return { ai: { model: MODEL, usage: usage(1000, 200) } }; } });
  const w2 = b2.wrap(f2.client, { limits: LIM_ON });
  const pAsk2 = w2.ask({ ctx: ctxAsk }).catch(e => e);
  await ticks();
  const ePlan2 = await catchOf(w2.plan({ ctx: ctxPlan }));
  g2.open(); await pAsk2;
  assert(reasonOf(ePlan2) === 'limit' && ePlan2.details.budget.mode === 'gateway' && ePlan2.details.budget.remainingUsd === 0 && sent2.map(([k]) => k).join() === 'ask' && sent2[0][1].allowanceUsd === GA && ledgerOf(s2).entries.length === 1,
    `B8-2: 残りが本当に足りない（質問の確保で残り 0）→ 計画の更新は送らない（送信 0 件・理由 limit）: ${JSON.stringify({ e: ePlan2 && ePlan2.details, sent2 })}`);
});
await section(async () => {
  //   Gateway が最初の呼び出しの前に上界で止めた（BUDGET_EXCEEDED・stage first・AI を呼んでいない）→ 確保を解放し、残りがその allowance より大きければ allowanceUsd = 残り で 1 回だけ送り直す
  const ctxG = { customization: {} };
  const GG = GBv('generate', ctxG);
  //   (a) 送り直しで通る（上界 2.5 > 見積もり・≤ 残り 3）
  const { storage, budget } = mkBudget({ config: { limitUsd: 3 } });
  const sent = [];
  const fc = fakeClient({ generate: (p) => { sent.push(p.budget.allowanceUsd); if (p.budget.allowanceUsd < 2.5) throw gwBudgetErr({ reason: 'over-allowance', stage: 'first', allowanceUsd: p.budget.allowanceUsd, boundUsd: 2.5 }); return { ai: { model: MODEL, usage: usage(5000, 800) }, budgetMeta: metaOf(p.budget.allowanceUsd, [{ kind: 'generate', boundUsd: 2.5, costUsd: 0.05 }]) }; } });
  const r = await w8(budget, fc).generate({ ctx: ctxG });
  const es = ledgerOf(storage).entries;
  assert(!!r && GG < 2.5 && JSON.stringify(sent) === JSON.stringify([GG, 3]) && es.length === 2 && es[0].status === 'released' && es[0].reservedUsd === 0 && es[0].allowanceUsd === GG && es[1].status === 'done' && es[1].allowanceUsd === 3 && es[1].costUsd === 0.05 && budget.summary().reservedUsd === 0 && budget.summary().recordedUsd === 0.05,
    `B8-3: 最初の呼び出しの前の BUDGET_EXCEEDED（見積もり ${GG} < 上界 2.5）→ 確保を解放し、allowanceUsd = 残り 3 で 1 回だけ送り直して通る: ${JSON.stringify({ sent, es: es.map(e => [e.status, e.allowanceUsd, e.reservedUsd, e.costUsd]) })}`);
  //   (b) 送り直しても超える（上界 3.5 > 残り 3）→ 止める（送り直しは 1 回だけ・どちらの確保も解放・送信の停止の種類は budget・渡した残りは 3）
  const { storage: s2, budget: b2 } = mkBudget({ config: { limitUsd: 3 } });
  const sent2 = [];
  const f2 = fakeClient({ generate: (p) => { sent2.push(p.budget.allowanceUsd); throw gwBudgetErr({ reason: 'over-allowance', stage: 'first', allowanceUsd: p.budget.allowanceUsd, boundUsd: 3.5 }); } });
  const e2 = await catchOf(w8(b2, f2).generate({ ctx: ctxG }));
  const es2 = ledgerOf(s2).entries;
  assert(e2 && e2.code === 'BUDGET_EXCEEDED' && e2.details.error.detail.allowanceUsd === 3 && KTAiConversation.stopKindOf(e2) === 'budget' && JSON.stringify(sent2) === JSON.stringify([GG, 3]) && es2.length === 2 && es2.every(e => e.status === 'released' && e.reservedUsd === 0) && b2.summary().reservedUsd === 0 && /渡した残り 約 3 米ドルを超えるため/.test(KTAiClient.errorText(e2.code, e2)),
    `B8-4: 送り直しても上界が残りを超える → 止める（送り直しは 1 回だけ・確保は解放・理由の文は渡した残り 3）: ${JSON.stringify({ sent2, es2: es2.map(e => [e.status, e.allowanceUsd]) })}`);
  //   (c) 送り直さない: 渡した allowance が既に残り全額（上限 1 < 見積もり）／AI を呼んだ後（stage plan-full）／表に無いモデル（unknown-model）
  const { budget: b3 } = mkBudget({ config: { limitUsd: 1 } });
  const sent3 = [];
  const e3 = await catchOf(w8(b3, fakeClient({ generate: (p) => { sent3.push(p.budget.allowanceUsd); throw gwBudgetErr({ reason: 'over-allowance', stage: 'first', allowanceUsd: p.budget.allowanceUsd, boundUsd: 1.2 }); } })).generate({ ctx: ctxG }));
  const { budget: b4 } = mkBudget({ config: { limitUsd: 3 } });
  const sent4 = [];
  const e4 = await catchOf(w8(b4, fakeClient({ plan: (p) => { sent4.push(p.budget.allowanceUsd); throw gwBudgetErr({ reason: 'over-allowance', stage: 'plan-full', allowanceUsd: p.budget.allowanceUsd, boundUsd: 2.9, budget: metaOf(p.budget.allowanceUsd, [{ kind: 'plan-patch', boundUsd: 0.6, costUsd: 0.1 }]) }); } })).plan({ ctx: { goal: 'g', revision: { mode: 'patch' } } }));
  const { budget: b5 } = mkBudget({ config: { limitUsd: 3 } });
  const sent5 = [];
  const e5 = await catchOf(w8(b5, fakeClient({ generate: (p) => { sent5.push(p.budget.allowanceUsd); throw gwBudgetErr({ reason: 'unknown-model', stage: 'first', allowanceUsd: p.budget.allowanceUsd, model: 'x' }); } })).generate({ ctx: ctxG }));
  assert(e3 && sent3.length === 1 && sent3[0] === 1 && e4 && sent4.length === 1 && e5 && sent5.length === 1 && KTAiBudget.gatewayFirstOverOf(e3) === true && KTAiBudget.gatewayFirstOverOf(e4) === false && KTAiBudget.gatewayFirstOverOf(e5) === false && KTAiBudget.gatewayFirstOverOf(KTAiBudget.budgetError('limit', {})) === false,
    `B8-5: 送り直さない: 渡した allowance が既に残り全額・AI を呼んだ後の BUDGET_EXCEEDED（stage plan-full）・表に無いモデル（unknown-model）・Toolkit が止めたもの: ${JSON.stringify({ sent3, sent4, sent5 })}`);
});
await section(async () => {
  //   時間切れの記録: Gateway は detail が文字列の 502（UPSTREAM_ERROR detail "timeout"）のとき費用の記録を error.budget に入れる。記録された上界で精算する
  //   （確保を渡した allowance の全額のまま残さない。使用量の分からない呼び出しはその上界を確保に残す）
  const ctxG = { customization: {} };
  const GG = GBv('generate', ctxG);
  const run = async (errOf) => { const { storage, budget } = mkBudget({ config: { limitUsd: 3 } }); const e = await catchOf(w8(budget, fakeClient({ generate: (p) => { throw errOf(p.budget.allowanceUsd); } })).generate({ ctx: ctxG })); return { e, x: ledgerOf(storage).entries[0], s: budget.summary() }; };
  const a = await run((al) => gwErrB('UPSTREAM_ERROR', 'timeout', metaOf(al, [{ kind: 'generate', boundUsd: 0.43, costUsd: null }])));
  const b = await run((al) => gwErrB('UPSTREAM_ERROR', 'timeout', metaOf(al, [{ kind: 'generate', boundUsd: 0.43, costUsd: 0.1 }, { kind: 'repair', boundUsd: 0.5, costUsd: null }])));
  const c = await run(() => gwErrB('UPSTREAM_ERROR', 'timeout', null));
  assert(a.e && a.e.code === 'UPSTREAM_ERROR' && a.x.allowanceUsd === GG && a.x.status === 'unknown' && a.x.reservedUsd === 0.43 && a.x.reservedUsd < GG && a.x.costUsd === null && JSON.stringify(a.x.gatewayCalls) === JSON.stringify([{ kind: 'generate', boundUsd: 0.43, costUsd: null }]) && a.s.reservedUsd === 0.43 && a.s.unknown === 1,
    `B8-6: 印ありで生成が時間切れ（error.budget に呼び出しの記録・費用不明）→ 確保額は記録の上界 0.43（渡した allowance ${GG} の全額のまま残さない）・終了不明: ${JSON.stringify(a.x)}`);
  assert(b.x.status === 'partial-unknown' && b.x.costKnownUsd === 0.1 && b.x.reservedUsd === 0.5 && b.s.recordedUsd === 0.1 && b.s.reservedUsd === 0.5 && c.x.status === 'unknown' && c.x.reservedUsd === GG && c.x.allowanceUsd === GG,
    `B8-7: error.budget の一部の呼び出しの費用が分かる → 確認できた費用を記録し、分からない呼び出しの上界を確保に残す。費用の記録の無い時間切れは今までどおり渡した allowance を確保に残す: ${JSON.stringify({ b: [b.x.status, b.x.costKnownUsd, b.x.reservedUsd], c: [c.x.status, c.x.reservedUsd] })}`);
});

console.log(`\n${state.failed ? 'NG' : 'OK'}: ${state.passed} passed, ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})();
