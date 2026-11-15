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
  assert.equal(button(html, 'update-suggestions'), undefined); assert.match(button(html, 'adopt'), / disabled/);
  assert.match(html, /data-release-decision="Q1"/); assert.match(html, /選択や入力だけではAIを呼びません/);
});

test('選択済みの追加提案は確認でき、採用操作は更新まで無効にする', async () => {
  const f = await setup(), s = f.controller.getState();
  f.controller.selectSuggestion('B3', true, { taskId: s.taskId, version: s.version });
  const state = f.controller.getState(); state.proposal.decisions = [];
  const html = clean(KTReleaseView.render(state));
  assert.match(html, /data-release-suggestion="B3"[^>]* checked/);
  assert.equal(button(html, 'update-suggestions'), undefined); assert.doesNotMatch(button(html, 'send'), / disabled/); assert.match(html, /まとめて送信/); assert.match(button(html, 'adopt'), / disabled/);
  assert.match(html, /チェックするだけでは、案の更新やAIの呼び出しは行いません/);
});

test('相談欄の訂正と選択提案を同じ送信にまとめ、作成はまだ許可しない', async () => {
  const f = await setup(), s = f.controller.getState();
  f.controller.selectSuggestion('B3', true, { taskId: s.taskId, version: s.version });
  const html = clean(KTReleaseView.render(f.controller.getState(), { draft: '条件を訂正します' }));
  assert.equal(button(html, 'update-suggestions'), undefined); assert.doesNotMatch(button(html, 'send'), / disabled/);
  assert.match(html, /まとめて送信/); assert.match(html, /条件を訂正します/); assert.match(button(html, 'adopt'), / disabled/);
});

test('更新失敗後は選択を直してまとめて再送でき、未接続・処理中は送信しない', async () => {
  const f = await setup(), s = f.controller.getState();
  s.selectedSuggestionIds = ['B3']; s.proposalPending = true;
  let html = clean(KTReleaseView.render(s));
  assert.doesNotMatch(button(html, 'send'), / disabled/); assert.doesNotMatch(html.match(/<input[^>]*data-release-suggestion="B3"[^>]*>/)[0], / disabled/);
  assert.match(button(html, 'adopt'), / disabled/);
  s.proposalPending = false;
  html = clean(KTReleaseView.render(s, { connection: { connected: false, available: false } }));
  assert.match(button(html, 'send'), / disabled/);
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

test('必須補足に理由付きの表示を添え、依存順と元データを維持して任意案と区別する',async()=>{
 const f=await setup(),state=f.controller.getState();state.proposal.decisions=[];
 state.proposal.behaviors=[{id:'B1',text:'理由の保存先として理由欄を追加する<script>',origin:'ai'},{id:'B2',text:'理由が空なら保存を止める',origin:'user'},{id:'B3',text:'理由を一覧に表示する',origin:'suggestion'}];
 const before=JSON.stringify(state),html=clean(KTReleaseView.render(state));
 assert.equal((html.match(/data-release-required-support/g)||[]).length,1);assert.match(html,/実現に必要な補足：/);assert.match(html,/理由欄を追加する&lt;script&gt;/);
 assert.ok(html.indexOf('理由の保存先')<html.indexOf('理由が空なら'));assert.ok(html.includes('<h3>任意の改善提案</h3>'));
 assert.equal((html.match(/type="checkbox"/g)||[]).length,1);assert.match(html,/data-release-suggestion="B3"/);assert.equal(JSON.stringify(state),before);
 assert.doesNotMatch(button(html,'adopt'),/ disabled/);
});
