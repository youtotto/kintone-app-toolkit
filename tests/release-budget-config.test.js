'use strict';

// 実予算部品と固定の応答だけを使う。AI・kintone・認証先へは接続しない。
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { KTAiBudget: B } = loadToolkit({ verificationBudget: true });
const host = 'budget-test.cybozu.com';
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function storage() {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) };
}
function locks() {
  let tail = Promise.resolve(); const calls = [];
  return { calls, request(name, options, work) { calls.push({ name, options }); const next = tail.then(work); tail = next.catch(() => {}); return next; } };
}
function fixture({ store = storage(), lock = locks(), sessionId = 'page-one' } = {}) {
  const budget = B.create({ storage: store, session: storage(), host, locks: lock, sessionId, now: () => Date.UTC(2026, 9, 24) });
  return { budget, store, lock };
}
const reason = expected => error => error.code === 'BUDGET_EXCEEDED' && error.details?.budget?.reason === expected;
const limits = { budgetAllowance: { version: 1, models: ['gpt-6.1-sol'] }, features: { 'assistant-qa': { model: 'gpt-6.1-sol', maxOutputTokens: 4000, maxAiCalls: 1 } } };
const response = { ai: { model: 'gpt-6.1-sol', usage: { input_tokens: 100, output_tokens: 50 } }, budgetMeta: { spentUsd: 0.01, complete: true, calls: [{ kind: 'propose', boundUsd: 0.1, costUsd: 0.01 }] } };

test('新規設定を正規化し、一意な枠と作成日時を保存してsummaryで確認できる', async () => {
  const f = fixture();
  assert.equal(f.budget.state(), 'disabled');
  const first = await f.budget.configure({ limitUsd: '1.00', maxCalls: '8' });
  assert.equal(first.enabled, true); assert.equal(first.ok, true);
  assert.equal(first.limitUsd, 1); assert.equal(first.maxCalls, 8);
  assert.equal(first.usedCalls, 0); assert.equal(first.reservedUsd, 0);
  assert.equal('entries' in first, false);
  assert.equal(f.budget.state(), 'on');
  assert.deepEqual(plain(f.budget.summary()), plain(first));
  assert.equal(f.budget.readState().config.createdAt, '2026-10-24T00:00:00.000Z');
  const oldKey = f.budget.ledgerKey(), oldLedger = f.store.getItem(oldKey);
  const second = await f.budget.configure({ limitUsd: 1, maxCalls: 8 });
  assert.notEqual(first.id, second.id);
  assert.equal(f.store.getItem(oldKey), oldLedger);
  assert.ok(f.lock.calls.every(c => c.name === 'ktAi.budget:' + host && c.options.mode === 'exclusive'));
});

test('ロック待機中に会話が始まったら旧設定と台帳を保ち、新しい枠を作らない', async () => {
  const entered = deferred(), gate = deferred(); let waiting = false, idle = true, checks = 0;
  const lock = { request: async (_name, _options, work) => { if (waiting) { entered.resolve(); await gate.promise; } return work(); } };
  const f = fixture({ lock }); await f.budget.configure({ limitUsd: 1, maxCalls: 8 });
  const before = [...f.store.data.entries()];
  waiting = true;
  const setting = f.budget.configure({ limitUsd: 2, maxCalls: 10 }, () => { checks++; return idle; });
  await entered.promise;
  assert.equal(checks, 0, '開始条件はロックを得るまで確認しない');
  idle = false; gate.resolve();
  await assert.rejects(setting, reason('conversation-active'));
  assert.equal(checks, 1);
  assert.deepEqual([...f.store.data.entries()], before);
  assert.equal(f.budget.summary().limitUsd, 1);
  assert.equal(f.budget.summary().maxCalls, 8);
  assert.equal(f.budget.state(), 'on');
});

test('金額と回数は既存parseConfigの規則を守り、不正な入力で設定を変更しない', async () => {
  const f = fixture(); await f.budget.configure({ limitUsd: 1, maxCalls: 8 });
  const before = f.store.getItem(f.budget.configKey);
  for (const input of [{ limitUsd: -1, maxCalls: 8 }, { limitUsd: NaN, maxCalls: 8 }, { limitUsd: true, maxCalls: 8 },
    { limitUsd: '', maxCalls: 8 }, { limitUsd: 1, maxCalls: 1.5 }, { limitUsd: 1, maxCalls: -1 }, { limitUsd: 1, maxCalls: Infinity }]) {
    await assert.rejects(f.budget.configure(input), reason('config-invalid'));
    assert.equal(f.store.getItem(f.budget.configKey), before);
  }
  const zero = await f.budget.configure({ limitUsd: 0, maxCalls: 0 });
  assert.equal(zero.limitUsd, 0); assert.equal(zero.maxCalls, 0);
  let calls = 0;
  const client = f.budget.wrap({ propose: async () => { calls++; return response; } }, { limits });
  await assert.rejects(client.propose({ ctx: {} }), reason('limit'));
  assert.equal(calls, 0);
});

test('自分と別タブの進行中の要求がある間は新規枠に切り替えない', async () => {
  const f = fixture(); await f.budget.configure({ limitUsd: 1, maxCalls: 8 });
  const other = fixture({ store: f.store, lock: f.lock, sessionId: 'page-two' });
  const entered = deferred(), gate = deferred();
  const client = f.budget.wrap({ propose: async () => { entered.resolve(); await gate.promise; return response; } }, { limits });
  const running = client.propose({ ctx: {} }); await entered.promise;
  const config = f.store.getItem(f.budget.configKey), oldKey = f.budget.ledgerKey(), ledger = f.store.getItem(oldKey);
  for (const budget of [f.budget, other.budget]) await assert.rejects(budget.configure({ limitUsd: 1, maxCalls: 8 }), reason('in-flight'));
  assert.equal(f.store.getItem(f.budget.configKey), config);
  assert.equal(f.store.getItem(oldKey), ledger);
  gate.resolve(); await running;
  assert.equal(f.budget.summary().inFlight, 0); assert.equal(f.budget.summary().done, 1);
  await other.budget.configure({ limitUsd: 1, maxCalls: 8 });
});

test('終了不明の確保と旧記録を消さず、新しい枠だけを空で始める', async () => {
  const f = fixture(); await f.budget.configure({ limitUsd: 1, maxCalls: 8 });
  const client = f.budget.wrap({ propose: async () => { throw Object.assign(new Error('通信が切れました。'), { code: 'NETWORK_ERROR' }); } }, { limits });
  await assert.rejects(client.propose({ ctx: {} }));
  const oldKey = f.budget.ledgerKey(), oldLedger = f.store.getItem(oldKey), before = f.budget.summary();
  assert.equal(before.unknown, 1); assert.ok(before.reservedUsd > 0);
  const after = await f.budget.configure({ limitUsd: 1, maxCalls: 8 });
  assert.notEqual(after.id, before.id); assert.equal(after.usedCalls, 0); assert.equal(after.unknown, 0);
  assert.equal(f.store.getItem(oldKey), oldLedger);
});

for (const failedPart of ['config', 'ledger']) test(`${failedPart}の保存失敗後は旧設定や無制限へ戻らず送信を止め、再設定で回復できる`, async () => {
  const f = fixture(); await f.budget.configure({ limitUsd: 1, maxCalls: 8 });
  const config = f.store.getItem(f.budget.configKey), oldKey = f.budget.ledgerKey(), ledger = f.store.getItem(oldKey);
  const set = f.store.setItem;
  f.store.setItem = (key, value) => { if (failedPart === 'config' ? key === f.budget.configKey : key.startsWith(B.LEDGER_PREFIX)) throw new Error('保存できません。'); set(key, value); };
  await assert.rejects(f.budget.configure({ limitUsd: 1, maxCalls: 8 }), reason(failedPart === 'config' ? 'config-write' : 'ledger-write'));
  assert.equal(f.budget.state(), 'broken'); assert.equal(f.budget.summary().ok, false);
  assert.equal(f.store.getItem(f.budget.configKey), config); assert.equal(f.store.getItem(oldKey), ledger);
  let calls = 0;
  const client = f.budget.wrap({ propose: async () => { calls++; return response; } }, { limits });
  await assert.rejects(client.propose({ ctx: {} })); assert.equal(calls, 0);
  f.store.setItem = set;
  assert.equal((await f.budget.configure({ limitUsd: 1, maxCalls: 8 })).ok, true);
});

test('初回の保存失敗でも予算無効に戻らない', async () => {
  const f = fixture(); f.store.setItem = () => { throw new Error('保存できません。'); };
  await assert.rejects(f.budget.configure({ limitUsd: 1, maxCalls: 8 }), reason('ledger-write'));
  assert.equal(f.budget.state(), 'broken');
  let calls = 0;
  await assert.rejects(f.budget.wrap({ propose: async () => { calls++; } }).propose({ ctx: {} }));
  assert.equal(calls, 0);
});

test('設定の読み取りと保存後の読み戻しが失敗したら送信しない', async () => {
  for (const afterWrite of [false, true]) {
    const f = fixture(), get = f.store.getItem, set = f.store.setItem; let unreadable = !afterWrite;
    f.store.getItem = key => { if (unreadable) throw new Error('読めません。'); return get(key); };
    f.store.setItem = (key, value) => { set(key, value); if (key === f.budget.configKey) unreadable = true; };
    await assert.rejects(f.budget.configure({ limitUsd: 1, maxCalls: 8 }), reason('config-unreadable'));
    assert.equal(f.budget.state(), 'broken');
    let calls = 0;
    await assert.rejects(f.budget.wrap({ propose: async () => { calls++; } }).propose({ ctx: {} }));
    assert.equal(calls, 0);
  }
});

test('保存が黙って失敗しても読み戻しで検出する', async () => {
  const f = fixture(); f.store.setItem = () => {};
  await assert.rejects(f.budget.configure({ limitUsd: 1, maxCalls: 8 }), reason('ledger-write'));
  assert.equal(f.budget.state(), 'broken');
});

test('壊れた旧台帳を上書きせず設定と送信を止める', async () => {
  const f = fixture(); await f.budget.configure({ limitUsd: 1, maxCalls: 8 });
  const key = f.budget.ledgerKey(); f.store.setItem(key, '{broken');
  await assert.rejects(f.budget.configure({ limitUsd: 1, maxCalls: 8 }), reason('ledger-broken'));
  assert.equal(f.store.getItem(key), '{broken'); assert.equal(f.budget.state(), 'broken');
});

test('正式なconfigureから確保と精算を通し、8回の後は9回目を送らない', async () => {
  const f = fixture(); await f.budget.configure({ limitUsd: 1, maxCalls: 8 });
  const sent = [];
  const client = f.budget.wrap({ propose: async args => {
    sent.push(args);
    const s = f.budget.summary(); assert.equal(s.inFlight, 1); assert.ok(s.reservedUsd > 0);
    return response;
  } }, { limits });
  for (let index = 0; index < 8; index++) await client.propose({ ctx: { request: '固定の依頼' } });
  const summary = f.budget.summary();
  assert.equal(summary.enforcement, 'gateway'); assert.equal(summary.usedCalls, 8);
  assert.equal(summary.recordedUsd, 0.08); assert.equal(summary.reservedUsd, 0); assert.equal(summary.done, 8);
  await assert.rejects(client.propose({ ctx: {} }), reason('calls'));
  assert.equal(sent.length, 8);
  assert.ok(sent.every(p => p.budget.allowanceUsd > 0 && p.budget.allowanceUsd <= 1));
});


test('成功応答の費用不足は終了不明と分離し、確保・回数・再読込を維持する', async () => {
  const f = fixture(); await f.budget.configure({ limitUsd: 1, maxCalls: 1 });
  const r = { ...response, budgetMeta: { spentUsd: 0, complete: false, calls: [{ kind: 'propose', boundUsd: 0.1, costUsd: null, costReason: 'cache-usage-unknown' }] } };
  const client = f.budget.wrap({ propose: async () => r }, { limits });
  await client.propose({ ctx: {} });
  const s = f.budget.summary(), e = f.budget.readState().ledger.entries[0];
  assert.equal(s.costUnknown, 1); assert.equal(s.completionUnknown, 0); assert.equal(s.unknown, 1);
  assert.equal(s.usedCalls, 1); assert.ok(s.reservedUsd > 0); assert.equal(e.costUsd, null); assert.equal(e.costComplete, false);
  assert.equal(e.responseState, 'succeeded'); assert.match(B.summaryText(s), /応答完了・費用未確定 1 件/); assert.doesNotMatch(B.summaryText(s), /終了不明/);
  const restored = fixture({ store: f.store, sessionId: 'after-reload' });
  restored.budget.wrap({}, { limits });
  assert.deepEqual(plain(restored.budget.summary()), plain(s));
  await assert.rejects(client.propose({ ctx: {} }), reason('calls'));
});

test('一部だけ費用が分かる成功応答も、既知費用と未知分の確保を分けて残す', async () => {
  const f = fixture(); await f.budget.configure({ limitUsd: 1, maxCalls: 4 });
  const r = { ...response, budgetMeta: { spentUsd: 0.01, complete: false, calls: [{ kind: 'propose', boundUsd: 0.1, costUsd: 0.01 }, { kind: 'repair', boundUsd: 0.1, costUsd: null }] } };
  await f.budget.wrap({ propose: async () => r }, { limits }).propose({ ctx: {} });
  const s = f.budget.summary(); assert.equal(s.recordedUsd, 0.01); assert.ok(s.reservedUsd > 0); assert.equal(s.usedCalls, 2);
  assert.equal(s.costUnknown, 1); assert.equal(s.completionUnknown, 0); assert.doesNotMatch(B.summaryText(s), /終了不明/);
  assert.match(B.summaryText(s), /費用未確定/); // 呼出し超過による停止表示でも保持
});

test('通信失敗と旧記録の終了不明を成功扱いせず、確定済み費用は未確定にしない', async () => {
  const f = fixture(); await f.budget.configure({ limitUsd: 1, maxCalls: 8 });
  await f.budget.wrap({ propose: async () => response }, { limits }).propose({ ctx: {} });
  assert.equal(f.budget.summary().costUnknown, 0); assert.equal(f.budget.summary().done, 1);
  await assert.rejects(f.budget.wrap({ propose: async () => { throw new Error('disconnected'); } }, { limits }).propose({ ctx: {} }));
  const s = f.budget.summary(); assert.equal(s.completionUnknown, 1); assert.equal(s.costUnknown, 0); assert.match(B.summaryText(s), /終了不明 1 件/);
  const legacy = { version: 1, entries: [{ key: 'old', status: 'unknown', reservedUsd: 0.1, reservedCalls: 1, costUsd: null, costComplete: false, calls: [], endedAt: '2026-10-30', reason: null }] };
  const total = B.totalsOf(legacy); assert.equal(total.completionUnknown, 1); assert.equal(total.costUnknown, 0); assert.equal(total.reservedUsd, 0.1);
});
