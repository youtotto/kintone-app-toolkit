'use strict';
// Offline settlement through the existing ledger. No AI, network, or kintone.
const test = require('node:test');
const assert = require('node:assert/strict');
const { KTAiBudget: B } = require('./helpers/load-toolkit.js').loadToolkit();
const storage = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) }; };
const raw = (input, output, cached = 0, write = 0, short = 0, long = 0) => ({
  input_tokens: input, output_tokens: output, input_tokens_details: {
    cached_tokens: cached, cache_write_tokens: write, cache_write_tokens_details: { ttl_30m_tokens: short, ttl_12h_tokens: long },
  },
});
const complete = raw(1000, 100, 400, 400, 100, 300);
async function settle(response, { kind = 'ask', gateway = false, failure = false, model = 'gpt-6.1-sol' } = {}) {
  const store = storage();
  const budget = B.create({ storage: store, session: storage(), host: 'cache.test', locks: null, sessionId: 'offline' });
  await budget.configure({ limitUsd: 20, maxCalls: 20 });
  const limits = { features: { [B.FEATURE_OF[kind]]: { model } },
    ...(gateway ? { budgetAllowance: { version: 1, models: ['gpt-6.1-sol', 'gpt-6.1-terra'] } } : {}) };
  const client = budget.wrap({ [kind]: async () => {
    if (failure) throw Object.assign(new Error('upstream'), { code: 'UPSTREAM_ERROR', details: { error: { budget: response.budgetMeta } } });
    return response;
  } }, { limits });
  if (failure) await assert.rejects(client[kind]({ ctx: {} }));
  else await client[kind]({ ctx: {} });
  return { summary: budget.summary(), entry: JSON.parse(store.getItem(budget.ledgerKey())).entries[0] };
}
test('通常入力・読取・30分/12時間書込を重ねず合計する', async () => {
  const { entry } = await settle({ ai: { model: 'gpt-6.1-sol', usage: complete } });
  assert.equal(entry.costUsd, 0.00319); assert.equal(entry.costComplete, true);
  assert.equal(entry.calls[0].cacheWrite30m, 100); assert.equal(entry.calls[0].cacheWrite12h, 300);
  assert.equal(entry.costCachedUsd, null); assert.equal(entry.reservedUsd, 0);
});
test('書込0が明示されていればTTL内訳なしでも算定する', async () => {
  const { entry } = await settle({ ai: { usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } } });
  assert.equal(entry.costUsd, 0.003);
});
for (const [label, usage] of [
  ['cache内訳欠落', { input_tokens: 1000, output_tokens: 100 }],
  ['読取欠落', { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cache_write_tokens: 0 } }],
  ['書込TTL不明', { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 500 } }],
  ['読取と書込が全入力超過', raw(1000, 100, 700, 400, 400)],
  ['書込内訳が不一致', raw(1000, 100, 100, 400, 200, 300)],
  ['負のTTL', raw(1000, 100, 0, 0, -1, 0)],
]) test(label + 'を0扱いせず確保を残す', async () => {
  const { entry } = await settle({ ai: { usage } });
  assert.equal(entry.costUsd, null); assert.equal(entry.costComplete, false); assert.ok(entry.reservedUsd > 0);
});
test('長文料金の境界を呼び出しごとに適用する', async () => {
  const a = await settle({ ai: { usage: raw(272000, 100) } });
  const b = await settle({ ai: { usage: raw(272001, 100) } });
  assert.equal(a.entry.costUsd, 0.545); assert.equal(b.entry.costUsd, 1.089504);
});
test('修復ごとのcache内訳を保持し、不明な修復を合計から消さない', async () => {
  const known = { kind: 'generate', inputTokens: 1000, outputTokens: 100, cachedTokens: 400, cacheWriteTokens: 400, cacheWriteTokens30m: 100, cacheWriteTokens12h: 300 };
  const missing = { kind: 'repair', inputTokens: 800, outputTokens: 50 };
  const { entry } = await settle({ ai: { usage: { input_tokens: 1000, output_tokens: 100 } }, timing: { ai: { count: 2 }, calls: [known, missing] } }, { kind: 'generate' });
  assert.equal(entry.costKnownUsd, 0.00319); assert.equal(entry.costUsd, null); assert.equal(entry.status, 'partial-unknown');
  assert.equal(entry.calls.length, 2); assert.equal(entry.calls[1].cached, null); assert.ok(entry.reservedUsd > 0);
});
for (const failure of [false, true]) test((failure ? '失敗' : '成功') + 'でもGatewayの算定とcall内訳をそのまま記録する', async () => {
  const usage = { inputTokens: 1000, outputTokens: 100, cachedTokens: 400, cacheWriteTokens: 400, cacheWriteTokens30m: 100, cacheWriteTokens12h: 300 };
  const { entry } = await settle({ budgetMeta: { spentUsd: 0.00319, complete: true, calls: [{ kind: 'qa', model: 'gpt-6.1-sol', boundUsd: 0.1, costUsd: 0.00319, usage }] } }, { gateway: true, failure });
  assert.equal(entry.costUsd, 0.00319); assert.equal(entry.calls[0].cacheWrite12h, 300);
  assert.equal(entry.gatewayCalls[0].usage.cached, 400); assert.equal(entry.reservedUsd, 0);
  assert.equal(entry.gatewayCalls[0].model, 'gpt-6.1-sol');
});

test('SolとTerraでGatewayとToolkitが同じusageを同じ金額・未確定として扱う', async () => {
  const path = require('node:path'), { pathToFileURL } = require('node:url');
  const aiRoot = process.env.KT_AI_REPO || path.resolve(__dirname, '../../AI');
  const { costMicroOf, priceOf } = await import(pathToFileURL(path.join(aiRoot, 'worker/src/v2/budget.mjs')).href);
  for (const model of ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6.1-terra-2026-10-27']) for (const usage of [complete, raw(272000, 100), raw(272001, 100), raw(800, 10, 200, 500, 500, 0),
    { input_tokens: 1000, output_tokens: 100 }, raw(1000, 100, 900, 200, 200, 0),
    { ...raw(1000, 100), output_tokens_details: { reasoning_tokens: 101 } },
    { ...raw(1000, 100), input_tokens: '1000' },
    { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
    { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0, cache_write_tokens_details: { ttl_30m_tokens: null, ttl_12h_tokens: 0 } } },
  ]) {
    const micro = costMicroOf(usage, priceOf(model));
    const { entry } = await settle({ ai: { model, usage } }, { model });
    assert.equal(entry.costUsd, micro == null ? null : micro / 1e6);
  }
});
test('予約はキャッシュ命中の割引を当てにしない', () => {
  const e = B.estimate({ kind: 'ask', ctxBytes: 0 });
  assert.ok(e.calls[0].usd >= (e.calls[0].input * 5 + e.calls[0].output * 10) / 1e6);
});

test('healthのTerra設定を相談・仮案の見積もりと上限強制に使い、計画・生成と既定はSolのまま', () => {
  const limits = { features: { 'assistant-qa': { model: 'gpt-6.1-terra', maxOutputTokens: 4000, maxAiCalls: 1 } },
    budgetAllowance: { version: 1, models: ['gpt-6.1-sol', 'gpt-6.1-terra'] } };
  for (const kind of ['ask', 'propose']) {
    const base = B.estimate({ kind, ctxBytes: 0 }), terra = B.estimate({ kind, ctxBytes: 0, limits });
    assert.equal(base.model, 'gpt-6.1-sol'); assert.equal(terra.model, 'gpt-6.1-terra'); assert.equal(terra.ok, true);
    assert.equal(terra.maxCalls, base.maxCalls); assert.equal(terra.maxOutputTokens, base.maxOutputTokens);
    assert.equal(terra.maxUsd, base.maxUsd / 2); assert.equal(B.enforcementOf(limits, kind), 'gateway');
    const b = B.gatewayBound({ kind, bodyBytes: 0, limits });
    assert.equal(b.maxUsd, B.gatewayBound({ kind, bodyBytes: 0 }).maxUsd / 2);
    assert.ok(b.calls[0].usd >= (b.calls[0].inputBytes * 2.5 + b.calls[0].output * 5) / 1e6);
  }
  for (const kind of ['plan', 'generate']) {
    assert.equal(B.estimate({ kind, limits }).model, 'gpt-6.1-sol');
    assert.equal(B.gatewayBound({ kind, limits }).model, 'gpt-6.1-sol');
  }
  for (const model of ['gpt-6.1-terra', 'gpt-6.1-terra-2026-10-27']) {
    limits.features['assistant-qa'].model = model;
    assert.equal(B.priceOf(model), B.PRICES['gpt-6.1-terra']);
    assert.equal(B.enforcementOf(limits, 'ask'), 'gateway');
    assert.equal(B.estimate({ kind: 'ask', limits }).ok, true);
  }
  limits.budgetAllowance.models = ['gpt-6.1-sol'];
  assert.equal(B.enforcementOf(limits, 'ask'), 'estimate', '旧Gatewayにないモデルの上限強制を想定しない');
  limits.features['assistant-qa'].model = 'gpt-6.1-terra-other';
  assert.equal(B.priceOf('gpt-6.1-terra-other'), null);
  assert.equal(B.estimate({ kind: 'ask', limits }).reason, 'unknown-model');
});

test('Terraは通常・読取・保持期間別書込の単価と長文境界で精算する', async () => {
  for (const [usage, cost] of [[raw(1000, 100), 0.0015], [complete, 0.001595],
    [raw(272000, 100), 0.2725], [raw(272001, 100), 0.544752]]) {
    const { entry, summary } = await settle({ ai: { model: 'gpt-6.1-terra', usage } }, { model: 'gpt-6.1-terra' });
    assert.equal(entry.estimatedModel, 'gpt-6.1-terra'); assert.equal(entry.costUsd, cost);
    assert.equal(entry.costComplete, true); assert.equal(entry.reservedUsd, 0); assert.equal(summary.stopped, null);
  }
  const { entry } = await settle({ ai: { model: 'gpt-6.1-terra', usage: { input_tokens: 1000, output_tokens: 100 } } }, { model: 'gpt-6.1-terra' });
  assert.equal(entry.costUsd, null); assert.equal(entry.costComplete, false); assert.ok(entry.reservedUsd > 0);
});

test('明示した相談・資料の用途をhealthから選び、見積もりと上限強制を同じモデルにそろえる', async () => {
  const { KTAiClient: Client } = require('./helpers/load-toolkit.js').loadToolkit();
  const advertised = { model: 'gpt-6.1-sol', modelsByPurpose: { consultation: 'gpt-6.1-terra', document: 'gpt-6.1-sol' }, maxOutputTokens: 4000, maxAiCalls: 1 };
  const limits = Client.limitsFromHealth({ limits: { version: 1, features: { 'toolkit.assistant-qa': advertised },
    deadlineMs: { 'toolkit.assistant-qa': 30000 }, budgetAllowance: { version: 1, models: ['gpt-6.1-terra', 'gpt-6.1-sol'] } } });
  const ctx = requestPurpose => ({ question: '同じ依頼文', requestPurpose });
  for (const kind of ['ask', 'propose']) {
    for (const [purpose, model] of [['consultation', 'gpt-6.1-terra'], ['document', 'gpt-6.1-sol'], [undefined, 'gpt-6.1-sol']]) {
      assert.equal(B.estimate({ kind, ctx: ctx(purpose), ctxBytes: 0, limits }).model, model);
      assert.equal(B.gatewayBound({ kind, ctx: ctx(purpose), bodyBytes: 0, limits }).model, model);
      assert.equal(B.enforcementOf(limits, kind, ctx(purpose)), 'gateway');
    }
  }
  for (const kind of ['plan', 'generate']) assert.equal(B.estimate({ kind, ctx: ctx('consultation'), limits }).model, 'gpt-6.1-sol');
  limits.budgetAllowance.models = ['gpt-6.1-terra'];
  assert.equal(B.enforcementOf(limits, 'propose', ctx('consultation')), 'gateway');
  assert.equal(B.enforcementOf(limits, 'propose', ctx('document')), 'estimate');
  limits.features['assistant-qa'].modelsByPurpose.document = 'unknown-model';
  assert.equal(B.estimate({ kind: 'propose', ctx: ctx('document'), limits }).reason, 'unknown-model');
  delete limits.features['assistant-qa'].modelsByPurpose;
  limits.features['assistant-qa'].model = 'gpt-6.1-terra';
  assert.equal(B.estimate({ kind: 'propose', ctx: ctx('document'), limits }).model, 'gpt-6.1-terra', '旧healthは従来modelのまま');
});

for (const failure of [false, true]) test('Terraの' + (failure ? '失敗' : '成功') + 'の費用・キャッシュ内訳・モデル名をGatewayの記録から残す', async () => {
  const usage = { inputTokens: 1000, outputTokens: 100, cachedTokens: 400, cacheWriteTokens: 400, cacheWriteTokens30m: 100, cacheWriteTokens12h: 300 };
  const { entry, summary } = await settle({ budgetMeta: { spentUsd: 0.001595, complete: true,
    calls: [{ kind: 'qa', model: 'gpt-6.1-terra', boundUsd: 0.1, costUsd: 0.001595, usage }] } },
  { gateway: true, failure, model: 'gpt-6.1-terra' });
  assert.equal(entry.enforcement, 'gateway'); assert.equal(entry.estimatedModel, 'gpt-6.1-terra');
  assert.equal(entry.costUsd, 0.001595); assert.equal(entry.gatewayCalls[0].model, 'gpt-6.1-terra');
  assert.equal(entry.calls[0].cacheWrite30m, 100); assert.equal(entry.calls[0].cacheWrite12h, 300);
  assert.equal(entry.reservedUsd, 0); assert.equal(summary.stopped, null);
});

test('Terraを見積もった後に高いモデルが返れば、従来どおり追加送信を止める', async () => {
  const { entry, summary } = await settle({ ai: { model: 'gpt-6.1-sol', usage: complete } }, { model: 'gpt-6.1-terra' });
  assert.equal(summary.stopped.reason, 'model'); assert.equal(entry.costUsd, null); assert.ok(entry.reservedUsd > 0);
});
