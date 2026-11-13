'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { KTReleaseWorkspace: W } = require('../src/release-workspace.js');
const { KTReleaseView: V } = require('../src/release-view.js');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const F = require('./helpers/release-workspace-fixture.js');
const usage = (consultation = 99, creation = 12) => ({ version: 2, plan: 'toolkit-light', yyyymm: '209910', resetsAt: '2099-10-31T15:00:00.000Z', timeZone: 'Asia/Tokyo', buckets: { consultation: { limit: 100, used: 100 - consultation, reserved: 0, remaining: consultation }, creation: { limit: 15, used: 15 - creation - 2, reserved: 2, remaining: creation } } });
const disabled = (html, action) => / disabled/.test(html.match(new RegExp('<button[^>]*data-release-action="' + action + '"[^>]*>'))?.[0] || '');
test('残数はサービスの値を使い、確保分を二重に引かず不明をゼロにしない', () => {
  const u = W.usageOf(usage()); assert.equal(u.buckets.creation.remaining, 12); assert.equal(u.buckets.creation.reserved, 2);
  const bad = usage(); bad.buckets.creation.remaining = null; bad.buckets.consultation.remaining = '0';
  const unknown = W.usageOf(bad); assert.equal(unknown.buckets.creation.remaining, null); assert.equal(unknown.buckets.consultation.remaining, null);
  assert.equal(W.usageBlocked(unknown, 'creation'), false); assert.equal(W.usageOf(null), null);
  const html = V.usageHtml(bad); assert.match(html, /残り 未確認/); assert.doesNotMatch(V.usageHtml(null), /残り 0/);
});
test('相談と作成を独立に判定し、更新時刻を過ぎた古いゼロで送信を止めない', () => {
  const u = W.usageOf(usage(0, 12)); assert.equal(W.usageBlocked(u, 'consultation'), true); assert.equal(W.usageBlocked(u, 'creation'), false);
  assert.equal(W.usageBlocked(u, 'consultation', Date.parse(u.resetsAt)), false);
  assert.match(W.usageResetText(u), /2099年11月1日.*00:00.*日本時間/);
});
test('旧形式の利用回数を維持し、プラン名から上限を補わない', () => {
  const old = W.usageOf({ yyyymm: '209910', plan: 'legacy', monthlyLimit: 23, usedThisMonth: 19, remainingThisMonth: 4 });
  assert.equal(old.version, 1); assert.match(V.usageHtml(old), /AI利用 残り 4回.*月 23回/);
  const custom = usage(); custom.buckets.creation = { limit: 73, used: 8, reserved: 1, remaining: 64 };
  assert.match(V.usageHtml(custom), /残り 64回.*月 73回/); assert.match(V.usageHtml(custom), /契約全体で共有/);
});
test('通常表示は契約プランと残数を示し、原価・モデル・トークンを出さない', () => {
  const html = V.usageHtml({ ...usage(), model: 'secret-model', costUsd: 9, tokens: 100 });
  assert.match(html, /ライト/); assert.match(html, /確保中 2回/);
  assert.doesNotMatch(html, /secret-model|costUsd|tokens|米ドル|1ドメイン/);
});
test('上限でも入力と作成済みの内容を保持し、相談・資料・採用を個別に止める', async () => {
  const f = F.fixture(W); await f.controller.send(F.REQUEST); const state = f.controller.getState();
  const base = { connected: true, available: true, canPlan: true };
  let html = V.render(state, { draft: '残る下書き', connection: { ...base, canConsult: false, canCreate: true } });
  assert.equal(disabled(html, 'send'), true); assert.doesNotMatch(html.match(/<textarea[^>]*>/)[0], /disabled/); assert.match(html, /残る下書き/);
  html = V.render(state, { connection: { ...base, canConsult: false, canCreate: true } }); assert.equal(disabled(html, 'adopt'), false);
  html = V.render({ ...state, requestPurpose: 'document' }, { connection: { ...base, canConsult: false, canCreate: true } }); assert.equal(disabled(html, 'send'), false);
  html = V.render(state, { connection: { ...base, canConsult: true, canCreate: false } }); assert.equal(disabled(html, 'send'), false); assert.equal(disabled(html, 'adopt'), true);
  await f.controller.adopt(); const ready = f.controller.getState();
  html = V.render(ready, { connection: { ...base, canConsult: false, canCreate: false } }); assert.equal(disabled(html, 'apply'), false); assert.match(html, /data-release-action="copy-code"/); assert.equal(disabled(html, 'copy-code'), false); assert.equal(disabled(html, 'download-code'), false);
});
test('月間上限エラーは更新日を示し、案を消さず即時の再試行を勧めない', async () => {
  let stopped = false;
  const f = F.fixture(W, { propose: async () => { if (stopped) throw Object.assign(new Error('upstream'), { code: 'MONTHLY_LIMIT_EXCEEDED', details: { error: { detail: { bucket: 'consultation', usage: usage(0) } } } }); return F.proposal(); } });
  await f.controller.send(F.REQUEST); const before = f.controller.getState(); stopped = true; await f.controller.send('修正する');
  const state = f.controller.getState(); assert.deepEqual(state.proposal, before.proposal); assert.ok(state.messages.length >= before.messages.length);
  assert.match(state.error.message, /今月の相談.*2099年11月1日/); assert.match(state.error.message, /利用可能になってから/); assert.doesNotMatch(state.error.message, /時間をおいて|すぐに|しばらく/);
  assert.equal(state.proposalPending, true);
  const html = V.render(state, { connection: { connected: true, available: true, canConsult: false, canCreate: true } });
  assert.match(html, /送信した内容を案に反映できていません。利用状況を確認し、利用可能になってから相談内容をもう一度送信してください。/);
  assert.doesNotMatch(html, /相談内容をもう一度送信し、更新された案を確認してください。/);
});
test('healthと正常応答の追加usageを読み取り、既存能力判定に合算上限を追加しない', () => {
  const T = loadToolkit(), C = T.KTAiClient;
  const result = C.receive('proposal', { ...F.proposal(), ok: true, contractVersion: '2.1', meta: { usage: usage(0) } });
  assert.equal(result.usage.buckets.consultation.remaining, 0); assert.equal(result.usage.buckets.creation.remaining, 12);
});

test('予約だけで残数ゼロなら翌月待ちにせず、処理完了後の確認を案内する', () => {
  const reserved = usage(0, 0); reserved.buckets.consultation.used = 99; reserved.buckets.consultation.reserved = 1;
  const error = { code: 'MONTHLY_LIMIT_EXCEEDED', details: { error: { detail: { bucket: 'consultation', reason: 'QUOTA_RESERVED', usage: reserved } } } };
  assert.equal(W.usageReserved(W.usageOf(reserved), 'consultation'), true);
  assert.match(W.monthlyLimitText(error), /処理中.*確保.*完了後に［接続を更新］/); assert.doesNotMatch(W.monthlyLimitText(error), /上限に達|2099年|更新は/);
  assert.match(W.monthlyLimitText({ ...error, details: { error: { detail: { bucket: 'consultation', usage: usage(0) } } } }), /今月の相談.*上限.*2099年11月1日/);
});
