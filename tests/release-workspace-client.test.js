'use strict';

// 旧UIの試験に同居していた通信・利用上限の守りを独立させる。
// すべて固定応答。実際の認証情報、AI、kintoneには接続しない。
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { generated, plan } = require('./helpers/release-workspace-fixture.js');
const T = loadToolkit();
const { KTAiClient: Client, KTAiBudget: Budget, KTContext } = T;
const { KTReleaseContext: ReleaseContext } = require('../src/release-context.js');
const C = Client.ERROR_CODES;
const HOST = 'test.invalid';
const jsonResponse = (status, body) => ({ status, headers: { get: key => /content-type/i.test(key) ? 'application/json' : null }, text: async () => JSON.stringify(body) });
const expired = JSON.stringify({ code: 'CB_CS01', message: 'ページの有効期限が切れています。' });
const store = () => { const values = new Map(); return { getItem: key => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }; };
function budgetFixture({ limitUsd = 5, maxCalls = 10 } = {}) {
  const storage = store();
  storage.setItem(`ktAi.budget.v1.${HOST}`, JSON.stringify({ id: 'release-test', limitUsd, maxCalls, createdAt: '2026-10-24T00:00:00Z' }));
  const budget = Budget.create({ storage, host: HOST, locks: null, sessionId: 'release-test-session' });
  return { budget, storage, entries: () => JSON.parse(storage.getItem(`ktAi.budgetLedger.v1.${HOST}.release-test`) || '{"entries":[]}').entries };
}
const request = { ctx: { question: '試験用の依頼', size: { bytes: 1000 } }, requestId: 'test-request-1' };

test('生成入力は採用した版の前提と制約だけを原形で引き継ぎ、元の仮案と共有しない', () => {
  const adopted = { behaviors: [{ id: 'B1', text: '備考を編集不可にする' }], assumptions: [{ id: 'A2', key: 'scope.memo', label: '対象', text: '承認済みだけが対象です。\n差戻し後は編集できます。', changeHint: '必要なら条件を変更してください。' }], cannot: ['現在の承認の流れは変更しません。'], approach: { standard: [], js: [] }, decisions: [] };
  const p = plan({ settings: false, platforms: ['desktop'] });
  const args = { customization: p.customizations[0], plan: p, proposal: adopted, version: 2, base: { appId: '310', data: { fields: {} }, files: [] } };
  const ctx = ReleaseContext.generator(args);
  const expected = JSON.parse(JSON.stringify({ revision: 2, assumptions: adopted.assumptions, cannot: adopted.cannot }));
  assert.deepEqual(ctx.acceptedProposal, expected);
  const envelope = Client.buildGenerateEnvelope({ ctx });
  assert.deepEqual(JSON.parse(JSON.stringify(envelope.payload.acceptedProposal)), expected);
  adopted.assumptions[0].text = '後から変更した文'; adopted.cannot.push('後から加えた制約');
  assert.deepEqual(ctx.acceptedProposal, expected);
  assert.deepEqual(Object.keys(ctx.acceptedProposal).sort(), ['assumptions', 'cannot', 'revision']);
  assert.equal(ReleaseContext.generator({ ...args, proposal: undefined }).acceptedProposal, undefined);
});

test('無料のフィールド調査は、既存のモバイル用APIの目録と解析の版を保つ', () => {
  const apis = T.KTJsCatalog.extractApis("kintone.mobile.app.record.getFieldElement('a'); kintone.mobile.app.getFieldElements('a');");
  assert.equal(apis.length, 2);
  assert.ok(apis.every(api => api.known));
  assert.ok(Number(T.KTJsCatalog.CATALOG_VERSION) >= 2);
  assert.ok(Number(T.KTScan.ANALYZER_VERSION) >= 15);
});
const successfulResponse = () => ({ ai: { model: 'gpt-6.1-sol', usage: { input_tokens: 500, output_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } } });
function sse(blocks, end = 'close') {
  let index = 0;
  const enc = new TextEncoder();
  return { status: 200, headers: { get: key => /content-type/i.test(key) ? 'text/event-stream' : null }, body: { getReader: () => ({ read: async () => {
    if (index === blocks.length) { if (end === 'error') throw new TypeError('network interrupted'); return { done: true }; }
    const block = blocks[index++];
    return { done: false, value: enc.encode(typeof block === 'string' ? block + '\n\n' : `event: ${block.event}\ndata: ${JSON.stringify(block.data)}\n\n`) };
  } }) } };
}

test('期限切れの接続更新は同じ要求ID・本文で一度だけ直接送り、認証を緩めない', async () => {
  const proxies = [], directs = [];
  const send = Client.createDefaultTransport({ kintoneApi: { proxy: async (...args) => { proxies.push(args); throw expired; } }, fetchFn: async (url, options) => { directs.push({ url, options }); return jsonResponse(200, { ok: true }); } });
  const args = { url: 'https://gateway.test.invalid/v2/token/exchange', method: 'POST', headers: { 'X-Kintone-Domain': HOST, Authorization: 'Bearer TEST_ONLY' }, body: '{"grantType":"refresh_token","requestId":"same-request"}' };
  const result = await send(args);
  assert.equal(result.via, 'direct');
  assert.equal(proxies.length, 1);
  assert.equal(directs.length, 1);
  assert.equal(directs[0].url, args.url);
  assert.equal(directs[0].options.body, args.body);
  assert.deepEqual(JSON.parse(JSON.stringify(directs[0].options.headers)), args.headers);
});

test('直接通信も失敗したら繰り返し送信しない', async () => {
  let proxy = 0, direct = 0;
  const send = Client.createDefaultTransport({ kintoneApi: { proxy: async () => { proxy++; throw expired; } }, fetchFn: async () => { direct++; throw new TypeError('failed'); } });
  await assert.rejects(send({ url: 'https://gateway.test.invalid/v2/health', method: 'GET', headers: {}, body: '' }), error => error.code === C.PAGE_EXPIRED);
  assert.equal(proxy, 1); assert.equal(direct, 1);
});

test('上限が有効な生成要求の切断では、別経路へ重複送信しない', async () => {
  let proxy = 0, direct = 0;
  const send = Client.createDefaultTransport({ kintoneApi: { proxy: async () => { proxy++; return ['{}', 200, {}]; } }, fetchFn: async () => { direct++; throw new TypeError('failed after send'); } });
  await assert.rejects(send({ url: 'https://gateway.test.invalid/v2/review', method: 'POST', headers: {}, body: '{}', preferDirect: true, noProxyFallback: true }));
  assert.equal(direct, 1); assert.equal(proxy, 0);
});

test('ページ期限切れ以外の失敗は接続更新扱いにしない', async () => {
  let direct = 0;
  const send = Client.createDefaultTransport({ kintoneApi: { proxy: async () => { throw { code: 'CB_VA01', message: '入力が不正です。' }; } }, fetchFn: async () => { direct++; return jsonResponse(200, {}); } });
  await assert.rejects(send({ url: 'https://gateway.test.invalid/v2/health', method: 'GET', headers: {}, body: '' }), error => error.code === 'CB_VA01');
  assert.equal(direct, 0);
});

test('接続更新の前に止まった失敗だけ内部の確保を解放する', async () => {
  const a = budgetFixture();
  const before = Object.assign(new Client.AiClientError({ code: C.PAGE_EXPIRED, message: '接続を更新できません。' }), { tokenStage: true });
  const wrapped = a.budget.wrap({ ask: async () => { throw before; } });
  await assert.rejects(wrapped.ask(request));
  assert.equal(a.entries()[0].status, 'released');
  assert.equal(a.entries()[0].reservedUsd, 0);
  assert.equal(a.entries()[0].reservedCalls, 0);
});

test('送った後の通信切断は終了不明として確保を残す', async () => {
  const a = budgetFixture();
  const wrapped = a.budget.wrap({ ask: async () => { throw new Client.AiClientError({ code: C.TRANSPORT_ERROR, message: '通信が切れました。' }); } });
  await assert.rejects(wrapped.ask(request));
  assert.equal(a.entries()[0].status, 'unknown');
  assert.ok(a.entries()[0].reservedUsd > 0);
  assert.equal(a.entries()[0].costUsd, null);
});

test('終了不明の回数を残し、上限を超える次の要求をAIへ送らない', async () => {
  let sent = 0;
  const a = budgetFixture({ maxCalls: 1 });
  const wrapped = a.budget.wrap({ ask: async () => { sent++; throw new Client.AiClientError({ code: C.TIMEOUT, message: '時間切れ' }); } });
  await assert.rejects(wrapped.ask(request));
  await assert.rejects(wrapped.ask({ ...request, requestId: 'test-request-2' }));
  assert.equal(sent, 1);
  assert.equal(a.entries().length, 1);
});

test('完了した要求は同じ台帳で精算し、確保を消費として残さない', async () => {
  const a = budgetFixture();
  const wrapped = a.budget.wrap({ ask: async () => successfulResponse() });
  await wrapped.ask(request);
  const entry = a.entries()[0];
  assert.equal(entry.status, 'done');
  assert.equal(entry.reservedUsd, 0);
  assert.ok(entry.costUsd > 0);
});

test('壊れた上限設定を無制限扱いにせず送信前に止める', async () => {
  let sent = 0;
  const a = budgetFixture();
  a.storage.setItem(`ktAi.budget.v1.${HOST}`, '{broken');
  const wrapped = a.budget.wrap({ ask: async () => { sent++; return successfulResponse(); } });
  await assert.rejects(wrapped.ask(request));
  assert.equal(sent, 0);
});

test('送信前に取り消した要求はAIを呼ばず確保を解放する', async () => {
  let sent = 0;
  const a = budgetFixture();
  const abort = new AbortController(); abort.abort();
  const wrapped = a.budget.wrap({ ask: async () => { sent++; return successfulResponse(); } });
  await assert.rejects(wrapped.ask({ ...request, signal: abort.signal }));
  assert.equal(sent, 0);
  assert.equal(a.entries()[0].status, 'released');
});

const customization = plan({ settings: false, platforms: ['desktop'] }).customizations[0];
const ctx = KTContext.buildGenerator({ customization, plan: { goal: '試験', steps: [] }, planId: 'test', version: 1, data: { fields: {}, status: {}, customize: {} } });
const done = () => {
  const result = generated(customization);
  const { verification, artifactOutcome, ...body } = result;
  return { ok: true, contractVersion: '2.1', meta: {}, generated: body, verification, artifactOutcome };
};
const clientOf = fetchFn => Client.createAiClient({ apiBase: 'https://gateway.test.invalid', customerToken: 'TEST_ONLY', hostname: HOST, transport: Client.createDefaultTransport({ kintoneApi: null, fetchFn }) });

test('進捗は途中の案にならず、完了イベントの本文だけを受け取る', async () => {
  const events = [], seen = [];
  const client = clientOf(async (url, init) => { seen.push(init.headers); return sse([
    ': keepalive', { event: 'progress', data: { stage: 'generate', phase: 'started', t: 0 } },
    { event: 'progress', data: { stage: 'generate', phase: 'text', t: 1 } },
    { event: 'done', data: done() },
  ]); });
  const result = await client.generate({ ctx, onEvent: event => events.push(event.event) });
  assert.equal(seen[0].Accept, 'text/event-stream');
  assert.deepEqual(events, ['progress', 'progress']);
  assert.equal(result.code, generated(customization).code);
});

test('完了イベントが届かない生成通信を成功にしない', async () => {
  const client = clientOf(async () => sse([{ event: 'progress', data: { stage: 'generate', phase: 'text', t: 1 } }], 'error'));
  await assert.rejects(client.generate({ ctx, onEvent: () => {} }));
});

test('keepaliveだけで閉じた通信を空の生成成功にしない', async () => {
  const client = clientOf(async () => sse([': start', ': keepalive']));
  await assert.rejects(client.generate({ ctx, onEvent: () => {} }));
});

test('配置対応の印と現在のフォームを仮案・計画へそのまま渡す', () => {
  const layout = [{type:'ROW',fields:[{type:'NUMBER',code:'amount',size:{width:'180'}},{type:'LABEL',label:'金額の確認',elementId:'money-note'}]},
    {type:'GROUP',code:'billing',layout:[{type:'ROW',fields:[{type:'MULTI_LINE_TEXT',code:'memo'}]}]}];
  const base={appId:'310',data:{fields:{amount:{code:'amount',type:'NUMBER',label:'金額'},memo:{code:'memo',type:'MULTI_LINE_TEXT',label:'備考'}},layout},files:[]};
  const proposal={behaviors:[{id:'B1',text:'金額の右に請求番号を追加します。'}],assumptions:[],cannot:[],decisions:[],approach:{standard:[],js:[]}};
  const before=JSON.stringify(base);
  const contexts=[ReleaseContext.proposal({text:'請求番号を追加',base}),ReleaseContext.plan({proposal,goal:'請求番号を追加',version:1,base})];
  for(const ctx of contexts){
    assert.deepEqual(ctx.clientCapabilities,ctx.contextVersion==='1'?['formLayoutPlacement','fieldMaintenance','appExplanation']:['formLayoutPlacement','fieldMaintenance']);
    assert.deepEqual(ctx.facts.find(f=>f.kind==='layout').value,layout);
  }
  const envelope=Client.buildPlanEnvelope({ctx:contexts[1]});
  assert.deepEqual(JSON.parse(JSON.stringify(envelope.payload.clientCapabilities)),['formLayoutPlacement','fieldMaintenance']);
  contexts[0].facts.find(f=>f.kind==='layout').value[0].fields[1].label='後から変更';
  assert.equal(JSON.stringify(base),before);
});
