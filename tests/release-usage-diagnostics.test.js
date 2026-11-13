'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { KTReleaseUsageDiagnostics: D } = require('../src/release-usage-diagnostics.js');
const { KTReleaseBudgetReport: R } = require('../src/release-budget-report.js');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { KTAiBudget: B } = loadToolkit({ verificationBudget: true });
const plain = value => JSON.parse(JSON.stringify(value));
const diagnostic = (extra = {}) => ({ version: 1, usageState: 'object', inputDetailsSource: 'input_tokens_details', inputDetailsState: 'object', writeDetailsState: 'missing', writeTokensState: 'valid', ttl30mState: 'missing', ttl12hState: 'missing', hasUnrecognizedWriteFields: false, ...extra });
const storage = () => { const data = new Map(); return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) }; };
const limits = { budgetAllowance: { version: 1, models: ['gpt-6-astra'] }, features: { 'assistant-qa': { model: 'gpt-6-astra', maxOutputTokens: 16000, maxAiCalls: 1 } } };

test('受信診断は既知の列挙値だけを投影し、余分な本文・任意項目を残さない', () => {
  const raw = diagnostic({ prompt: 'PRIVATE_PAYLOAD', arbitrary: { secret: 'PRIVATE_PAYLOAD' } });
  assert.deepEqual(D.sanitize(raw), diagnostic());
  assert.doesNotMatch(JSON.stringify(D.sanitize(raw)) + D.html(raw), /PRIVATE_PAYLOAD|arbitrary/);
  for (const bad of [null, [], {}, diagnostic({ version: 2 }), diagnostic({ inputDetailsSource: 'PRIVATE_PAYLOAD' }), diagnostic({ ttl30mState: '<script>' }), diagnostic({ usageState: 'valid' }), diagnostic({ writeTokensState: 'object' }), diagnostic({ hasUnrecognizedWriteFields: 1 })]) assert.equal(D.sanitize(bad), null);
  const inherited = Object.create(diagnostic()); assert.equal(D.sanitize(inherited), null);
});

test('欠落・null・不正型・有効値を区別して表示し、旧記録から推測しない', () => {
  const html = D.html(diagnostic({ writeDetailsState: 'object', ttl30mState: 'null', ttl12hState: 'invalid', hasUnrecognizedWriteFields: true }));
  for (const text of ['Responses形式', 'オブジェクトあり', '有効な数値あり', 'null', '形式不正', '既知の2項目以外']) assert.ok(html.includes(text));
  assert.match(D.html(diagnostic()), /項目なし/);
  assert.match(D.html(null), /受信状態は未記録/);
  assert.doesNotMatch(D.html(null), /内訳.*項目なし/);
});

for (const streamed of [false, true]) for (const variant of ['complete', 'missing', 'null', 'invalid', 'unrecognized']) {
  test(`${streamed ? 'SSE' : 'JSON'} ${variant}: provider → Worker費用明細 → Toolkit台帳 → JSON表示で内訳を維持`, async () => {
    const { createOpenAiLlm } = await import(require('./helpers/ai-repo.js').aiUrl('worker/src/v2/providers/openai.mjs'));
    const { createRequestBudget } = await import(require('./helpers/ai-repo.js').aiUrl('worker/src/v2/budget.mjs'));
    // Synthetic payload; these counts mirror the saved incident, but are not a recovered provider response.
    const usage = { input_tokens: 30054, output_tokens: 4966, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 30051 }, output_tokens_details: { reasoning_tokens: 337 } };
    const details = usage.input_tokens_details;
    if (variant === 'complete') details.cache_write_tokens_details = { ttl_30m_tokens: 30051, ttl_12h_tokens: 0 };
    if (variant === 'null') details.cache_write_tokens_details = { ttl_30m_tokens: null, ttl_12h_tokens: 0 };
    if (variant === 'invalid') details.cache_write_tokens_details = { ttl_30m_tokens: '30051', ttl_12h_tokens: 0 };
    if (variant === 'unrecognized') details.cache_write_tokens_details = { UNKNOWN_PRIVATE_KEY: 'PRIVATE_PAYLOAD' };
    const raw = { status: 'completed', model: 'gpt-6-astra', service_tier: 'default', output_text: '{}', usage };
    let mockFetches = 0;
    const llm = createOpenAiLlm({ model: 'gpt-6-astra', serviceTier: 'default', maxOutputTokens: 16000,
      env: { OPENAI_API_KEY: 'offline-fixture' }, fetchFn: async () => { mockFetches++; return new Response(streamed ? 'event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: raw }) + '\n\n' : JSON.stringify(raw), { headers: { 'content-type': streamed ? 'text/event-stream' : 'application/json' } }); } });
    const input = { system: 'fixed synthetic instructions', user: 'fixed synthetic question', schema: { type: 'object', properties: {}, additionalProperties: false }, stream: streamed };
    const worker = createRequestBudget({ allowanceUsd: 5 });
    const reservation = worker.reserve('proposal', llm.describeRequest(input));
    const answer = await llm(input);
    assert.deepEqual(answer.meta.usage, usage);
    worker.settle(reservation.entry, answer.meta);
    const gateway = worker.meta(), d = gateway.calls[0].usageDiagnostics;
    assert.ok(d, 'Worker must retain the state of raw usage before normalizing it');
    assert.equal(d.ttl30mState, ({ complete: 'valid', missing: 'missing', null: 'null', invalid: 'invalid', unrecognized: 'missing' })[variant]);
    assert.equal(d.hasUnrecognizedWriteFields, variant === 'unrecognized');
    assert.equal(mockFetches, 1);
    assert.equal(gateway.complete, variant === 'complete');
    if (variant === 'complete') assert.equal(gateway.calls[0].costUsd, 0.623968);
    else { assert.equal(gateway.calls[0].costUsd, null); assert.equal(gateway.calls[0].costReason, 'cache-write-ttl-unknown'); assert.equal(gateway.spentUsd, reservation.boundUsd); }
    const local = storage(), session = storage(), budget = B.create({ storage: local, session, host: 'offline-test.cybozu.com', sessionId: 'before-reload', locks: { request: async (_name, _options, fn) => fn() } });
    await budget.configure({ limitUsd: 5, maxCalls: 1 });
    let fakeRequests = 0;
    await budget.wrap({ propose: async () => { fakeRequests++; return { budgetMeta: gateway, ai: answer.meta }; } }, { limits }).propose({ ctx: {} });
    const saved = budget.readState().ledger.entries[0], before = [...local.data];
    assert.deepEqual(plain(saved.gatewayCalls[0].usageDiagnostics), d);
    const restored = B.create({ storage: local, session, host: 'offline-test.cybozu.com', sessionId: 'after-reload', locks: { request: async (_name, _options, fn) => fn() } });
    restored.wrap({}, { limits });
    const report = R.capture(restored), exported = JSON.parse(JSON.stringify(report)), call = exported.entries[0].calls[0];
    assert.equal(report.status, 'ok'); assert.deepEqual(call.usageDiagnostics, d);
    assert.equal(call.usage.inputTokens, 30054); assert.equal(call.usage.cacheWriteTokens, 30051);
    assert.equal(call.usage.cacheWriteTokens30m, variant === 'complete' ? 30051 : null);
    assert.equal(report.totals.usedCalls, 1); assert.equal(fakeRequests, 1);
    assert.deepEqual([...local.data], before, 'read/export must not alter the ledger');
    assert.doesNotMatch(JSON.stringify(exported) + R.html(exported), /PRIVATE_PAYLOAD|UNKNOWN_PRIVATE_KEY|offline-fixture|fixed synthetic/);
    assert.match(R.html(exported), /使用量の受信状態/);
    if (variant !== 'complete') { assert.equal(report.totals.costUnknownCount, 1); assert.ok(report.totals.reservedUsd > 0); assert.equal(exported.entries[0].status, 'succeeded-cost-unsettled'); }
  });
}

test('旧台帳と壊れた診断情報は受信状態未記録となり、費用・数値を変更しない', () => {
  for (const usageDiagnostics of [undefined, { version: 999, secret: 'PRIVATE_PAYLOAD' }]) {
    const meta = B.budgetMetaOf({ spentUsd: 1, complete: false, calls: [{ costUsd: null, boundUsd: 1, costReason: 'cache-write-ttl-unknown', usage: { inputTokens: 30054, outputTokens: 4966, cachedTokens: 0, cacheWriteTokens: 30051, cacheWriteTokens30m: null, cacheWriteTokens12h: null }, usageDiagnostics }] });
    assert.equal(meta.calls[0].usageDiagnostics, undefined);
    assert.equal(meta.calls[0].usage.cacheWrite30m, null); assert.equal(meta.calls[0].costUsd, null);
    assert.doesNotMatch(JSON.stringify(meta), /PRIVATE_PAYLOAD/);
  }
});
