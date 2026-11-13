'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { KTReleaseWorkspace: W } = require('../src/release-workspace.js');
const { fixture, proposal, REQUEST, deferred, clone } = require('./helpers/release-workspace-fixture.js');
const IDEAS = [
  { id: 'B3', text: '請求書番号を一覧に表示する。', origin: 'suggestion' },
  { id: 'B4', text: '担当者へ通知する。', origin: 'suggestion' },
  { id: 'B5', text: '担当者だけ編集できるようにする。', origin: 'suggestion' }
];
function initial({ question = false } = {}) {
  const r = proposal(); r.proposal.behaviors.push(...clone(IDEAS));
  r.proposal.assumptions = [{ id: 'A1', text: '今の作業者の指定を使います。' }];
  r.proposal.cannot = ['APIからの更新は画面の編集制御の対象外です。'];
  if (question) r.proposal.decisions = [{ id: 'Q1', key: 'recipient', question: '通知先は誰ですか？', blocking: true }];
  return r;
}
const reference = c => { const { taskId, version } = c.getState(); return { taskId, version }; };
const select = (c, id, checked = true) => c.selectSuggestion(id, checked, reference(c));
async function start(options = {}) { const f = fixture(W, { propose: () => initial(), ...options }); await f.controller.send(REQUEST); return f; }

test('チェック・解除は設定取得とAIを呼ばず、仮案を変更しない', async () => {
  const f = await start(), before = f.controller.getState(), calls = f.calls.length;
  assert.equal(select(f.controller, 'B4'), true); assert.equal(select(f.controller, 'B4'), true);
  assert.deepEqual(f.controller.getState().selectedSuggestionIds, ['B4']);
  assert.equal(select(f.controller, 'B3'), true); assert.equal(select(f.controller, 'B4', false), true);
  assert.equal(f.calls.length, calls); assert.deepEqual(f.controller.getState().proposal, before.proposal);
  assert.equal(f.controller.getState().version, before.version); assert.equal(f.writes.length, 0);
});

test('必須質問・前提・本案・不明IDは追加提案として選択できない', async () => {
  const f = await start({ propose: () => initial({ question: true }) });
  for (const id of ['Q1', 'A1', 'B1', 'B999']) assert.equal(select(f.controller, id), false);
  assert.equal(f.controller.selectSuggestion('B3', 'true', reference(f.controller)), false);
  assert.deepEqual(f.controller.getState().selectedSuggestionIds, []); assert.equal(f.count('propose'), 1);
});

test('選択なしでは更新せず、選択中は未反映のまま採用できない', async () => {
  const f = await start(); assert.equal(await f.controller.updateSuggestions(reference(f.controller)), false);
  select(f.controller, 'B3'); assert.equal(await f.controller.adopt(), false);
  assert.equal(f.count('plan'), 0); assert.equal(f.count('propose'), 1);
  select(f.controller, 'B3', false); await f.controller.adopt();
  assert.ok(f.calls.find(c => c.method === 'plan').proposal.behaviors.every(b => b.origin !== 'suggestion'));
  assert.equal(f.writes.length, 0);
});

test('複数選択を元の案の順で一回だけ送り、更新後に別途採用する', async () => {
  let received;
  const f = await start({ propose: args => {
    if (!args.previous) return initial(); received = clone(args);
    const r = initial(); r.intent = 'adopt';
    for (const b of r.proposal.behaviors) if (['B3', 'B4'].includes(b.id)) b.origin = 'user';
    return r;
  } });
  select(f.controller, 'B4'); select(f.controller, 'B3');
  const old = f.controller.getState(), request = W.suggestionRequest(old);
  assert.equal(await f.controller.updateSuggestions(reference(f.controller)), true);
  assert.equal(f.count('propose'), 2); assert.equal(f.count('plan'), 0); assert.equal(f.count('generate'), 0);
  assert.equal(received.text, '選んだ追加提案を現在の案に取り込み、案を更新してください。\n\n- ' + IDEAS[0].text + '\n- ' + IDEAS[1].text);
  assert.ok(!received.text.includes(IDEAS[2].text)); assert.deepEqual(received.previous, old.proposal);
  const after = f.controller.getState(); assert.deepEqual(after.selectedSuggestionIds, []); assert.equal(after.version, 2);
  assert.deepEqual(after.proposal.assumptions, old.proposal.assumptions); assert.deepEqual(after.proposal.cannot, old.proposal.cannot);
  assert.equal(after.messages.filter(m => m.role === 'user').at(-1).text, request);
  await f.controller.adopt(); const adopted = f.calls.find(c => c.method === 'plan').proposal;
  assert.deepEqual(adopted.behaviors.map(b => b.id), ['B1', 'B2', 'B3', 'B4']); assert.equal(f.writes.length, 0);
});

test('更新で必須質問は自動回答せず、未回答の採用を止める', async () => {
  const f = await start({ propose: () => initial({ question: true }) });
  select(f.controller, 'B3'); await f.controller.updateSuggestions(reference(f.controller));
  assert.equal(f.controller.getState().proposal.decisions[0].id, 'Q1');
  assert.equal(await f.controller.adopt(), false); assert.equal(f.count('plan'), 0);
});

test('別の版・別の作業の古いチェック操作は同じIDでも受け付けない', async () => {
  const f = await start(), old = reference(f.controller); select(f.controller, 'B3');
  await f.controller.send('条件を修正してください。');
  assert.equal(f.controller.selectSuggestion('B3', true, old), false);
  assert.equal(await f.controller.updateSuggestions(old), false);
  assert.deepEqual(f.controller.getState().selectedSuggestionIds, []);
  f.controller.newTask(); await f.controller.send(REQUEST);
  assert.equal(f.controller.getState().version, old.version);
  assert.equal(f.controller.selectSuggestion('B3', true, old), false);
  assert.equal(await f.controller.updateSuggestions(old), false); assert.equal(f.count('propose'), 3);
});

test('更新中の二重クリック・選択変更・採用は呼び出しを増やさない', async () => {
  const wait = deferred(), f = await start({ propose: args => args.previous ? wait.promise : initial() });
  select(f.controller, 'B3'); const ref = reference(f.controller), pending = f.controller.updateSuggestions(ref);
  assert.equal(await f.controller.updateSuggestions(ref), false); assert.equal(select(f.controller, 'B4'), false);
  assert.equal(await f.controller.adopt(), false); assert.equal(f.controller.newTask(), false);
  wait.resolve(initial()); await pending; assert.equal(f.count('propose'), 2); assert.equal(f.count('plan'), 0);
});

test('更新失敗は古い案を採用せず、明示再送で回復する', async () => {
  let fail = true;
  const f = await start({ propose: args => { if (args.previous && fail) throw Error('固定の通信失敗'); return initial(); } });
  select(f.controller, 'B3'); const request = W.suggestionRequest(f.controller.getState());
  assert.equal(await f.controller.updateSuggestions(reference(f.controller)), false);
  assert.equal(f.controller.getState().proposalPending, true); assert.deepEqual(f.controller.getState().selectedSuggestionIds, []);
  assert.equal(select(f.controller, 'B3'), false); assert.equal(await f.controller.adopt(), false);
  assert.equal(f.count('propose'), 2); fail = false;
  await f.controller.send(request); assert.equal(f.controller.getState().proposalPending, false);
  assert.equal(f.count('propose'), 3); assert.equal(f.count('plan'), 0); assert.equal(f.writes.length, 0);
});

test('更新への質問だけの返答は、未更新のまま採用を有効にしない', async () => {
  const f = await start({ propose: args => args.previous ? { reply: '通知先を教えてください。', intent: 'question', proposalUnchanged: true } : initial() });
  select(f.controller, 'B4'); await f.controller.updateSuggestions(reference(f.controller));
  assert.equal(f.controller.getState().proposalPending, true); assert.equal(f.controller.getState().version, 1);
  assert.equal(await f.controller.adopt(), false); assert.equal(f.count('plan'), 0);
});

test('更新中断後の遅い応答を新しい会話へ持ち込まない', async () => {
  const wait = deferred(), f = await start({ propose: args => args.previous ? wait.promise : initial() });
  select(f.controller, 'B3'); const pending = f.controller.updateSuggestions(reference(f.controller));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.controller.cancel(), true);
  assert.equal(f.controller.getState().proposalPending, true); assert.equal(await f.controller.adopt(), false);
  assert.equal(f.controller.newTask(), true); wait.resolve(initial()); await pending;
  const state = f.controller.getState(); assert.equal(state.phase, 'idle'); assert.equal(state.proposal, null);
  assert.deepEqual(state.selectedSuggestionIds, []); assert.equal(f.count('plan'), 0); assert.equal(f.writes.length, 0);
});
