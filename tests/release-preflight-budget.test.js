'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { KTAiBudget: B } = require('./helpers/load-toolkit.js').loadToolkit({ verificationBudget: true });
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
const limits = { budgetAllowance: { version: 1, models: ['gpt-6.1-sol'] }, features: { 'customization-generator': { model: 'gpt-6.1-sol', maxOutputTokens: 4000, maxAiCalls: 2 } } };
async function failedRequest(code, detail = {}) {
  const store = storage(), budget = B.create({ storage: store, session: storage(), host: 'preflight-budget.test', locks: { request: (_name, _options, work) => work() }, sessionId: 'preflight-test' });
  await budget.configure({ limitUsd: 1, maxCalls: 8 });
  const error = Object.assign(new Error(code), { code, details: { error: { code, detail }, artifactOutcome: { state: 'unverified', operations: [] } } });
  let requests = 0;
  const client = budget.wrap({ generate: async () => { requests++; throw error; } }, { limits });
  await assert.rejects(client.generate({ ctx: {} }), actual => actual === error);
  return { requests, summary: budget.summary(), entry: JSON.parse(store.getItem(budget.ledgerKey())).entries[0] };
}
for (const code of ['REQUIRED_EFFECTS_UNRESOLVED', 'SANDBOX_OUTDATED', 'SANDBOX_UNAVAILABLE']) {
  test(code + ': generation preflight releases the budget and calls reserved before sending', async () => {
    // Gateway stops before its first AI call and omits budget metadata when calls is empty.
    const { requests, summary, entry } = await failedRequest(code, { reasonCodes: ['BEHAVIOR_unavailable'] });
    assert.equal(requests, 1); assert.equal(entry.status, 'released'); assert.equal(entry.costUsd, 0); assert.equal(entry.costComplete, true);
    assert.equal(summary.unknown, 0); assert.equal(summary.reservedUsd, 0); assert.equal(summary.usedCalls, 0);
  });
}
for (const code of ['UPSTREAM_ERROR', 'NETWORK_ERROR']) {
  test(code + ': an uncertain AI result keeps its reservation', async () => {
    const { summary, entry } = await failedRequest(code);
    assert.equal(entry.status, 'unknown'); assert.equal(entry.costUsd, null); assert.equal(summary.unknown, 1);
    assert.ok(summary.reservedUsd > 0); assert.ok(summary.usedCalls > 0);
  });
}
