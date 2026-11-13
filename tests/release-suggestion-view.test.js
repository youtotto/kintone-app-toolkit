'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { KTReleaseWorkspace } = require('../src/release-workspace.js');
const { KTReleaseView } = require('../src/release-view.js');
const { fixture, proposal } = require('./helpers/release-workspace-fixture.js');
const clean = html => html.replace(/<style>[\s\S]*?<\/style>/g, '');
const proposalResponse = () => {
  const r = proposal();
  r.proposal.behaviors.push({ id: 'B3', text: '備考を一覧に表示する', origin: 'suggestion' }, { id: 'B4', text: '確認担当者へ通知する', origin: 'suggestion' });
  r.proposal.assumptions = [{ id: 'A1', text: '現在の担当者を使います' }];
  r.proposal.cannot = ['モバイルの実際の画面では未確認です'];
  r.proposal.decisions = [{ id: 'Q1', blocking: true, question: '誰が確認しますか？', options: ['現在の担当者'] }];
  return r;
};
async function setup() {
  const f = fixture(KTReleaseWorkspace, { propose: async () => proposalResponse() });
  await f.controller.send('備考を編集不可にしてください');
  return f;
}
const button = (html, action) => (html.match(/<button\b[^>]*>/g) || []).find(tag => tag.includes(`data-release-action="${action}"`));

test('追加提案だけにチェック欄を出し、必須質問・前提・制約を別に残す', async () => {
  const f = await setup(), s = f.controller.getState(), html = clean(KTReleaseView.render(s));
  const panel = html.match(/<section data-release-panel="suggestions">[\s\S]*?<\/section>/)[0];
  assert.equal((html.match(/type="checkbox"/g) || []).length, 2);
  assert.match(panel, /data-release-suggestion="B3"/); assert.match(panel, /data-release-suggestion="B4"/);
  assert.doesNotMatch(panel, /誰が確認|現在の担当者を使います|モバイルの実際/);
  assert.match(html, /誰が確認しますか/); assert.match(html, /この案の前提/); assert.match(html, /この案の制約/);
  assert.match(button(html, 'update-suggestions'), / disabled/); assert.match(button(html, 'adopt'), / disabled/);
});

test('選択済みの追加提案は確認でき、採用操作は更新まで無効にする', async () => {
  const f = await setup(), s = f.controller.getState();
  f.controller.selectSuggestion('B3', true, { taskId: s.taskId, version: s.version });
  const state = f.controller.getState(); state.proposal.decisions = [];
  const html = clean(KTReleaseView.render(state));
  assert.match(html, /data-release-suggestion="B3"[^>]* checked/);
  assert.doesNotMatch(button(html, 'update-suggestions'), / disabled/); assert.match(button(html, 'adopt'), / disabled/);
  assert.match(html, /チェックするだけでは、案の更新やAIの呼び出しは行いません/);
});

test('未送信の文章があると更新操作を止め、内容を黙って捨てない', async () => {
  const f = await setup(), s = f.controller.getState();
  f.controller.selectSuggestion('B3', true, { taskId: s.taskId, version: s.version });
  const html = clean(KTReleaseView.render(f.controller.getState(), { draft: '条件を訂正します' }));
  assert.match(button(html, 'update-suggestions'), / disabled/); assert.match(html, /入力した内容を送信するか/);
});

test('更新失敗・未接続では更新を押せず、処理中の参照ではチェックできない', async () => {
  const f = await setup(), s = f.controller.getState();
  s.selectedSuggestionIds = ['B3']; s.proposalPending = true;
  let html = clean(KTReleaseView.render(s));
  assert.match(button(html, 'update-suggestions'), / disabled/); assert.match(html, /data-release-suggestion="B3"[^>]* disabled/);
  s.proposalPending = false;
  html = clean(KTReleaseView.render(s, { connection: { connected: false, available: false } }));
  assert.match(button(html, 'update-suggestions'), / disabled/);
  s.phase = 'consulting'; html = clean(KTReleaseView.render(s));
  assert.doesNotMatch(html, /data-release-action="update-suggestions"/);
  assert.match(html, /data-release-suggestion="B3"[^>]* disabled/);
});

test('追加提案の文章・IDをHTMLとして実行しない', async () => {
  const f = await setup(), s = f.controller.getState();
  s.proposal.behaviors = [{ id: 'B3" onclick="evil()', origin: 'suggestion', text: '<img src=x onerror=evil()>' }];
  const html = clean(KTReleaseView.render(s));
  assert.doesNotMatch(html, /<img| onclick="evil/); assert.match(html, /&lt;img/); assert.match(html, /&quot; onclick=&quot;/);
});
