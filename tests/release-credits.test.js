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
  assert.equal(W.usageOf({ version: 4, credits: value.credits }), null);
});

test('共通残数ゼロは相談と作成の両方を止め、確保中と消費済みを区別する', () => {
  const consumed = W.usageOf(usage(0, 0)), reserved = W.usageOf(usage(0, 2));
  for (const key of ['consultation', 'creation', 'credits']) {
    assert.equal(W.usageBlocked(consumed, key), true); assert.equal(W.usageReserved(consumed, key), false);
    assert.equal(W.usageBlocked(reserved, key), true); assert.equal(W.usageReserved(reserved, key), true);
    assert.equal(W.usageBlocked(consumed, key, Date.parse(consumed.resetsAt)), false);
  }
});

test('同じ現行プランIDを新形式だけスターターと表示し、契約名から上限を補わない', () => {
  const html = V.usageHtml(usage(64, 1, 73));
  assert.match(html, /スターター/); assert.match(html, /data-usage-credits/); assert.match(html, /残り 64 \/ 月 73/);
  assert.match(html, /利用済み 8・確保中 1/); assert.match(html, /クレジットは契約全体で共有/);
  assert.doesNotMatch(html, /data-usage-bucket|ライト|作成.*回|相談.*回|円|gpt-|token/i);
  assert.equal(W.usagePlanLabel({ version: 2, plan: 'toolkit-light' }), 'ライト');
  assert.equal(W.usagePlanLabel({ version: 3, plan: 'toolkit-standard' }), 'スタンダード');
  assert.equal(W.usagePlanLabel({ version: 3, plan: 'unknown-plan' }), '契約プラン');
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
