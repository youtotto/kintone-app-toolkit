'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { KTReleaseWorkspace: W } = require('../src/release-workspace.js');
const { KTReleaseView: V } = require('../src/release-view.js');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const F = require('./helpers/release-workspace-fixture.js');
const usage = (remaining = 97, reserved = 2, limit = 100) => ({ version: 3, plan: 'toolkit-light', yyyymm: '209910', resetsAt: '2099-10-31T15:00:00.000Z', timeZone: 'Asia/Tokyo', credits: { limit, used: limit - remaining - reserved, reserved, remaining } });
const disabled = (html, action) => / disabled/.test(html.match(new RegExp('<button[^>]*data-release-action="' + action + '"[^>]*>'))?.[0] || '');

test('共通クレジットはサーバーの残数を使い、確保分を二重に引かず不明をゼロにしない', () => {
  const value = usage(64, 1, 73), normalized = W.usageOf(value);
  assert.deepEqual(normalized.credits, { limit: 73, used: 8, reserved: 1, remaining: 64 });
  assert.equal(normalized.version, 3); assert.equal(value.credits.remaining, 64);
  for (const invalid of [null, '0', -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const malformed = W.usageOf({ ...usage(), credits: { limit: 100, used: 8, reserved: 1, remaining: invalid } });
    assert.equal(malformed.credits.remaining, null);
    assert.equal(W.usageBlocked(malformed, 'consultation'), false);
    assert.equal(W.usageBlocked(malformed, 'creation'), false);
    assert.match(V.usageHtml(malformed), /残り 未確認/);
  }
  assert.equal(W.usageOf({ ...usage(), credits: null }).credits, null);
  assert.equal(W.usageOf({ version: 5, credits: value.credits }), null);
});

test('共通残数ゼロは相談と作成の両方を止め、確保中と消費済みを区別する', () => {
  const consumed = W.usageOf(usage(0, 0)), reserved = W.usageOf(usage(0, 2));
  for (const key of ['consultation', 'creation', 'credits']) {
    assert.equal(W.usageBlocked(consumed, key), true); assert.equal(W.usageReserved(consumed, key), false);
    assert.equal(W.usageBlocked(reserved, key), true); assert.equal(W.usageReserved(reserved, key), true);
    assert.equal(W.usageBlocked(consumed, key, Date.parse(consumed.resetsAt)), false);
  }
});

test('同じ現行プランIDを新形式だけSOLOと表示し、契約名から上限を補わない', () => {
  const html = V.usageHtml(usage(64, 1, 73));
  assert.match(html, /SOLO/); assert.match(html, /data-usage-credits/); assert.match(html, /残り 64 \/ 月 73/);
  assert.match(html, /利用済み 8・確保中 1/); assert.match(html, /クレジットは契約全体で共有/);
  assert.doesNotMatch(html, /data-usage-bucket|ライト|作成.*回|相談.*回|円|gpt-|token/i);
  assert.equal(W.usagePlanLabel({ version: 2, plan: 'toolkit-light' }), 'ライト');
  assert.equal(W.usagePlanLabel({ version: 2, plan: 'toolkit-standard' }), 'スタンダード');
  assert.equal(W.usagePlanLabel({ version: 3, plan: 'toolkit-standard' }), 'TEAM');
  assert.equal(W.usagePlanLabel({ version: 3, plan: 'unknown-plan' }), '契約プラン');
});

test('Businessはサーバーの500cr・9800円とMULTI込みを表示する',()=>{
 const u=W.usageOf({version:4,plan:'toolkit-business',price:{monthlyJpy:9800,taxIncluded:true},options:{multiDomain:true,multiIncluded:true},operationCosts:{consultation:1,document:2,diagnosis:3,business:10,final:3},credits:{limit:500,used:23,reserved:2,remaining:475}});
 assert.equal(W.usagePlanLabel(u),'Business（MULTI込み）');
 const html=V.usageHtml(u);assert.match(html,/Business（MULTI込み）/);assert.match(html,/9,800/);assert.match(html,/475.*500/);assert.doesNotMatch(html,/11,800|250クレジット/);
});

test('共通クレジットの上限案内は種類で重みを変えず、確保中なら月替わり待ちにしない', () => {
  const error = { code: 'MONTHLY_LIMIT_EXCEEDED', details: { error: { detail: { bucket: 'credits', usage: usage(0, 0) } } } };
  assert.match(W.monthlyLimitText(error), /今月のクレジットの上限.*2099年11月1日/);
  assert.doesNotMatch(W.monthlyLimitText(error), /作成回数|相談回数/);
  error.details.error.detail.usage = usage(0, 2);
  assert.match(W.monthlyLimitText(error), /クレジットは処理中.*確保.*接続を更新/);
  assert.doesNotMatch(W.monthlyLimitText(error), /今月.*上限|2099年/);
});

test('接続詳細に要求ごとの1クレジットと複数要求を説明し、通常画面は短い案内を保つ', async () => {
  const details = V.usageDetailsHtml(usage());
  assert.match(details, /処理1件につき共通の1クレジット/);
  assert.match(details, /計画1件＋コード生成2件なら合計3クレジット/);
  assert.match(details, /自動修復・確認では追加消費しません/);
  assert.match(details, /閲覧・コピー・保存・反映・元に戻す操作は0クレジット/);
  assert.doesNotMatch(details, /相談1回|作成1回|円/);
  const f = F.fixture(W); await f.controller.send(F.REQUEST);
  const html = V.render(f.controller.getState(), { connection: { connected: true, available: true, usage: usage() } });
  assert.match(html, /送信ごとに1クレジット/); assert.match(html, /必要なクレジットは計画の内容で変わります/);
  assert.doesNotMatch(html, /相談1回|作成1回|計画1件＋コード生成2件/);
  assert.match(V.usageDetailsHtml({ version: 2 }), /コード生成の要求ごとに作成1回/);
});

test('共通枠の上限でも下書き・作成済み成果物・無料操作を残す', async () => {
  const f = F.fixture(W); await f.controller.send(F.REQUEST); await f.controller.adopt();
  const state = f.controller.getState(), connection = { connected: true, available: true, canPlan: true, canConsult: false, canCreate: false, usage: usage(0, 0) };
  const html = V.render(state, { draft: '残る入力', connection });
  assert.equal(disabled(html, 'send'), true); assert.equal(disabled(html, 'apply'), true, '未送信文がある間は従来どおり反映しない');
  assert.equal(disabled(V.render(state, { connection }), 'apply'), false, 'クレジット上限だけでは反映を止めない');
  assert.equal(disabled(html, 'copy-code'), false); assert.equal(disabled(html, 'download-code'), false);
  assert.match(html, /残る入力/); assert.doesNotMatch(html.match(/<textarea[^>]*>/)[0], /disabled/);
  assert.deepEqual(f.controller.getState().artifacts, state.artifacts);
});

test('成功応答の共通usageをクライアントが維持する', () => {
  const C = loadToolkit().KTAiClient, value = usage(0, 0);
  const result = C.receive('proposal', { ...F.proposal(), ok: true, contractVersion: '2.1', meta: { usage: value } });
  assert.deepEqual(result.usage, value);
  assert.equal(W.usageBlocked(W.usageOf(result.usage), 'consultation'), true);
  assert.equal(W.usageBlocked(W.usageOf(result.usage), 'creation'), true);
});

const bundledUsage = (remaining = 97, reserved = 0, limit = 100) => ({
  ...usage(remaining, reserved, limit), version: 4,
  price: { monthlyJpy: limit === 250 ? 4980 : 2480, taxIncluded: true },
  operationCosts: { consultation: 1, document: 2, final: 3 }
});

test('新方式だけ相談1・資料2・最終案一式3と案内し、旧方式の説明は読み替えない', async () => {
  const details = V.usageDetailsHtml(bundledUsage());
  assert.match(details, /相談・仮案.*1回につき1クレジット/);
  assert.match(details, /資料の作成や修正.*1回につき2クレジット/);
  assert.match(details, /最終案一式で3クレジット/);
  assert.match(details, /JavaScriptの本数による追加消費はありません/);
  assert.match(details, /計画ができた時点で3クレジットが確定/);
  assert.match(details, /1会話全体が定額という意味ではありません/);
  assert.doesNotMatch(details, /生成ごとに1件|必要な生成件数|米ドル|gpt-/i);
  assert.match(V.usageDetailsHtml(usage()), /処理1件につき共通の1クレジット/);
  assert.doesNotMatch(V.usageDetailsHtml(usage()), /最終案一式で3クレジット/);
  const f = F.fixture(W); await f.controller.send(F.REQUEST);
  const base = { connected: true, available: true, canPlan: true, canConsult: true, canDocument: true, canCreate: true, usage: bundledUsage() };
  const proposal = V.render(f.controller.getState(), { connection: base });
  assert.match(proposal, /送信ごとに1クレジット/);
  assert.match(proposal, /最終案の作成は3クレジット/);
  assert.doesNotMatch(proposal, /必要なクレジットは計画の内容で変わります/);
  const document = V.render({ ...f.controller.getState(), requestPurpose: 'document' }, { connection: base });
  assert.match(document, /送信ごとに2クレジット/);
});

test('新方式の資料と最終案は必要残数ごとに止め、残数があるときは使い切ったと表示しない', async () => {
  const f = F.fixture(W); await f.controller.send(F.REQUEST);
  const state = f.controller.getState();
  const base = { connected: true, available: true, canPlan: true, canConsult: true };
  let connection = { ...base, canDocument: false, canCreate: false, usage: bundledUsage(1) };
  let html = V.render(state, { connection });
  assert.equal(disabled(html, 'send'), false);
  assert.equal(disabled(html, 'adopt'), true);
  assert.match(html, /この操作には3クレジット必要です。残りは1クレジットです/);
  html = V.render({ ...state, requestPurpose: 'document' }, { connection });
  assert.equal(disabled(html, 'send'), true);
  assert.match(html, /この操作には2クレジット必要です。残りは1クレジットです/);
  assert.doesNotMatch(html, /今月のクレジットの上限です/);
  connection = { ...base, canDocument: true, canCreate: false, usage: bundledUsage(2) };
  html = V.render({ ...state, requestPurpose: 'document' }, { connection });
  assert.equal(disabled(html, 'send'), false, '残2では資料を作れても最終案は作れない');
  assert.equal(disabled(html, 'adopt'), true);
  assert.match(html, /送信ごとに2クレジット/);
});

test('新方式は資料に必要な分が確保中なら、残1でも月替わり待ちと表示しない', async () => {
  const f = F.fixture(W); await f.controller.send(F.REQUEST);
  const html = V.render({ ...f.controller.getState(), requestPurpose: 'document' }, {
    connection: { connected: true, available: true, canPlan: true, canConsult: true, canDocument: false, canCreate: false, usage: bundledUsage(1, 2) }
  });
  assert.match(html, /処理中の分を確保しています/);
  assert.doesNotMatch(html, /この操作には2クレジット必要|今月のクレジットの上限です/);
});

test('同じ最終案の再開はサービスの判定で許可し、新しい作成の残数不足だけで止めない', async () => {
  const f = F.fixture(W, { generate: async () => { throw Object.assign(new Error('一時的な接続エラー'), { code: 'NETWORK_ERROR' }); } });
  await f.controller.send(F.REQUEST); await f.controller.adopt();
  const state = f.controller.getState();
  assert.equal(state.phase, 'incomplete');
  const connection = { connected: true, available: true, canPlan: true, canConsult: false, canDocument: false, canCreate: false, canResume: true, usage: bundledUsage(0) };
  assert.equal(disabled(V.render(state, { connection }), 'resume'), false);
  assert.equal(disabled(V.render(state, { connection: { ...connection, canResume: false } }), 'resume'), true);
  assert.equal(disabled(V.render(state, { connection: { ...connection, canResume: undefined } }), 'resume'), true, '旧方式はcanCreateを引き継ぐ');
});

test('新方式の接続表示はサーバーの税込価格と月枠を使い、不明な価格を補完しない', () => {
  const starter = V.usageHtml(bundledUsage(97));
  assert.match(starter, /月額 2,480円（税込）/);
  assert.match(starter, /残り 97 \/ 月 100/);
  const standard = V.usageHtml({ ...bundledUsage(248, 0, 250), plan: 'toolkit-standard' });
  assert.match(standard, /TEAM/);
  assert.match(standard, /月額 4,980円（税込）/);
  assert.match(standard, /残り 248 \/ 月 250/);
  assert.doesNotMatch(V.usageHtml({ ...bundledUsage(), price: null }), /data-usage-price|2,480|4,980/);
  assert.doesNotMatch(V.usageHtml({ ...usage(), price: { monthlyJpy: 2480, taxIncluded: true } }), /data-usage-price|円/);
});

test('MULTIはオプション込みの月額を表示し、契約の共通クレジット枠を増やさない', () => {
  for (const [plan,limit,price] of [['toolkit-light',100,4480],['toolkit-standard',250,6980]]) {
    const raw = { ...bundledUsage(limit-2,0,limit), plan, options: {multiDomain:true}, price:{monthlyJpy:price,taxIncluded:true} };
    const normalized = W.usageOf(raw), html = V.usageHtml(normalized);
    assert.equal(normalized.options.multiDomain,true);
    assert.equal(normalized.credits.limit,limit);
    assert.match(html,/ ＋ MULTI/);
    assert.ok(html.includes(price.toLocaleString('ja-JP')+'円'));
    assert.ok(html.includes('月 '+limit));
    assert.equal(W.usageOf({...raw,options:{multiDomain:'true'}}).options,undefined);
  }
});

test('雑談の月枠は接続先の値を表示し、契約変更後も使用済み回数を保持する',()=>{
 const state=F.fixture(W).controller.getState();
 const render=(limit,usage)=>V.render(state,{connection:{connected:true,available:true,canSmalltalk:true,smalltalkMonthlyLimit:limit},smalltalk:{getState:()=>({open:true,pending:false,turns:[],draft:'',usage})}});
 for(const limit of [200,500,1000]){
  assert.ok(render(limit).includes('1契約につき月'+limit+'回'));
  const html=render(limit,{monthly:{limit:300,used:36,remaining:264,resetsAt:'2099-12-31T15:00:00Z'}});
  assert.ok(html.includes('今回の契約期間 36/'+limit+'回'));assert.doesNotMatch(html,/36\/300回/);
 }
 assert.match(render(null),/月の上限は接続先から確認します/);
 assert.doesNotMatch(render(null),/月300回|月200回|月500回|月1000回/);
 const old=render(null,{monthly:{limit:300,used:36,remaining:264,resetsAt:'2099-12-31T15:00:00Z'}});
 assert.match(old,/今回の契約期間 36\/300回/);
 const over=render(200,{monthly:{limit:1000,used:600,remaining:400,resetsAt:'2099-12-31T15:00:00Z'}});
 assert.match(over,/今回の契約期間 600\/200回/);assert.match(over,/から利用できます/);
});
