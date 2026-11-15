'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { KTReleaseWorkspace: W } = require('../src/release-workspace.js');
const F = require('./helpers/release-workspace-fixture.js');

const QUESTIONS = [
  { id: 'Q1', key: 'placement', question: '出発地と到着地をどこに配置しますか？', blocking: true, options: ['手段の後', '明細の末尾'] },
  { id: 'Q2', key: 'required', question: '入力漏れのある場合は保存を止めますか？', blocking: true, options: ['保存を止める', '保存を許可する'] },
];
const IDEAS = [
  { id: 'B3', text: '経費の合計を一覧に表示する。', origin: 'suggestion' },
  { id: 'B4', text: '申請者へリマインドを通知する。', origin: 'suggestion' },
];
const INITIAL_REQUEST = '経費申請で出発地と到着地を入力できるようにしてください。';
const reference = controller => { const { taskId, version } = controller.getState(); return { taskId, version }; };
function initial() {
  const response = F.proposal();
  response.proposal.decisions = F.clone(QUESTIONS);
  response.proposal.behaviors.push(...F.clone(IDEAS));
  return response;
}
async function start(options = {}) {
  const f = F.fixture(W, { propose: () => initial(), ...options });
  await f.controller.send(INITIAL_REQUEST);
  return f;
}
function draft(controller, id, answer) { return controller.setDecisionDraft(id, answer, reference(controller)); }
function chooseBoth(controller) {
  assert.equal(draft(controller, 'Q1', '手段の後'), true);
  assert.equal(draft(controller, 'Q2', '交通費のときだけ保存を止めてください。'), true);
}
function assertNoExecution(f) {
  assert.equal(f.count('plan'), 0);
  assert.equal(f.count('generate'), 0);
  assert.equal(f.count('prepare'), 0);
  assert.equal(f.writes.length, 0);
}

test('確認事項の選択と変更はローカルに保持し、AI・設定取得・確定回答を増やさない', async () => {
  const f = await start(), before = f.controller.getState(), calls = f.calls.length;
  chooseBoth(f.controller);
  assert.equal(draft(f.controller, 'Q1', '明細の末尾に変更してください。'), true);
  const state = f.controller.getState();
  assert.deepEqual(state.decisionDrafts, {
    Q1: { question: QUESTIONS[0].question, answer: '明細の末尾に変更してください。' },
    Q2: { question: QUESTIONS[1].question, answer: '交通費のときだけ保存を止めてください。' },
  });
  assert.deepEqual(state.answers, []);
  assert.deepEqual(state.proposal, before.proposal);
  assert.equal(state.version, before.version);
  assert.equal(f.calls.length, calls);
  assert.equal(await f.controller.adopt(), false);
  assertNoExecution(f);
});

test('送信文は質問本文・各回答・選択した追加提案・自由文を一つにまとめる', async () => {
  const f = await start(); chooseBoth(f.controller);
  assert.equal(f.controller.selectSuggestion('B3', true, reference(f.controller)), true);
  const state = f.controller.getState(), freeText = 'モバイルでも同じ動作にしてください。';
  const request = W.proposalFeedbackRequest(state, freeText);
  for (const text of [QUESTIONS[0].question, QUESTIONS[1].question, '手段の後', '交通費のときだけ保存を止めてください。', IDEAS[0].text, freeText]) {
    assert.ok(request.includes(text), '送信文に含まれない: ' + text);
    assert.equal(request.split(text).length - 1, 1, '送信文で重複している: ' + text);
  }
  assert.ok(!request.includes(IDEAS[1].text));
  assert.ok(request.indexOf(QUESTIONS[0].question) < request.indexOf(QUESTIONS[1].question));
  assert.deepEqual(f.controller.getState(), state);
  assert.equal(f.count('propose'), 1);
});

test('全回答と追加指示を一回の相談として送り、AIで確認された回答だけを確定する', async () => {
  const received = [];
  const f = await start({ propose: args => {
    received.push(F.clone(args));
    if (!args.previous) return initial();
    const response = initial();
    response.turn.answers = [
      { id: 'Q1', text: '手段の後', kind: 'answer' },
      { id: 'Q2', text: '交通費のときだけ保存を止めてください。', kind: 'answer' },
    ];
    response.proposal.behaviors.find(b => b.id === 'B3').origin = 'user';
    return response;
  } });
  chooseBoth(f.controller);
  f.controller.selectSuggestion('B3', true, reference(f.controller));
  f.controller.setRequestPurpose('document');
  const before = f.controller.getState(), text = 'モバイルにも対応してください。';
  const request = W.proposalFeedbackRequest(before, text);
  assert.equal(await f.controller.updateSuggestions({ ...reference(f.controller), text }), true);
  assert.equal(f.count('propose'), 2);
  assert.equal(received[1].requestPurpose, 'consultation');
  assert.equal(received[1].text, request);
  assert.deepEqual(received[1].previous, before.proposal);
  const after = f.controller.getState();
  assert.deepEqual(after.answers.map(a => [a.id, a.answer]), [['Q1', '手段の後'], ['Q2', '交通費のときだけ保存を止めてください。']]);
  assert.deepEqual(after.decisionDrafts, {});
  assert.deepEqual(after.selectedSuggestionIds, []);
  assert.equal(after.messages.filter(m => m.role === 'user').at(-1).text, request);
  assertNoExecution(f);
});

test('通信失敗でも未送信回答を保持し、自動再送や確定・作成をしない', async () => {
  const f = await start({ propose: args => { if (args.previous) throw Error('固定の通信失敗'); return initial(); } });
  chooseBoth(f.controller);
  const expected = f.controller.getState().decisionDrafts;
  assert.equal(await f.controller.updateSuggestions(reference(f.controller)), false);
  assert.deepEqual(f.controller.getState().decisionDrafts, expected);
  assert.deepEqual(f.controller.getState().answers, []);
  assert.equal(f.controller.getState().proposalPending, true);
  assert.equal(await f.controller.adopt(), false);
  assert.equal(f.count('propose'), 2);
  assertNoExecution(f);
});

test('送信前の回答は保存復元でき、新しい会話には持ち越さない', async () => {
  const f = await start(); chooseBoth(f.controller);
  f.controller.selectSuggestion('B3', true, reference(f.controller));
  const expected = f.controller.getState().decisionDrafts;
  const saved = JSON.parse(JSON.stringify(f.controller.exportSession()));
  const restored = F.fixture(W);
  assert.equal(await restored.controller.restoreSession(saved), true);
  assert.deepEqual(restored.controller.getState().decisionDrafts, expected);
  assert.deepEqual(restored.controller.getState().selectedSuggestionIds, ['B3']);
  assert.deepEqual(restored.controller.getState().answers, []);
  assert.equal(restored.count('propose'), 0);
  assert.equal(await restored.controller.adopt(), false);
  assert.equal(restored.controller.newTask(), true);
  assert.deepEqual(restored.controller.getState().decisionDrafts, {});
  assert.deepEqual(restored.controller.getState().selectedSuggestionIds, []);
  assertNoExecution(restored);
});

test('古い版・別会話・存在しない質問の操作は回答やAI呼び出しを変えない', async () => {
  const f = await start(), old = reference(f.controller);
  assert.equal(draft(f.controller, 'Q1', '手段の後'), true);
  const expected = f.controller.getState().decisionDrafts;
  for (const stale of [{ ...old, version: old.version - 1 }, { ...old, taskId: old.taskId + 1 }]) {
    assert.equal(f.controller.setDecisionDraft('Q1', '末尾', stale), false);
    assert.equal(await f.controller.updateSuggestions({ ...stale, text: '送らないでください。' }), false);
  }
  assert.equal(draft(f.controller, 'Q999', '回答'), false);
  assert.equal(draft(f.controller, '__proto__', '回答'), false);
  assert.equal(draft(f.controller, 'Q1', { value: '回答' }), false);
  assert.deepEqual(f.controller.getState().decisionDrafts, expected);
  assert.equal(f.count('propose'), 1);
  f.controller.newTask(); await f.controller.send(INITIAL_REQUEST);
  assert.equal(f.controller.getState().version, old.version);
  assert.equal(f.controller.setDecisionDraft('Q1', '以前の回答', old), false);
  assert.equal(await f.controller.updateSuggestions(old), false);
  assert.deepEqual(f.controller.getState().decisionDrafts, {});
  assert.equal(f.count('propose'), 2);
  assertNoExecution(f);
});

test('同じ質問IDでも本文が変わった場合は以前の回答を再利用しない', async () => {
  const f = await start({ propose: args => {
    const response = initial();
    if (args.previous) response.proposal.decisions[0].question = '一覧にはどの項目を表示しますか？';
    return response;
  } });
  chooseBoth(f.controller);
  await f.controller.updateSuggestions(reference(f.controller));
  const state = f.controller.getState();
  assert.equal(state.decisionDrafts.Q1, undefined);
  assert.deepEqual(state.decisionDrafts.Q2, { question: QUESTIONS[1].question, answer: '交通費のときだけ保存を止めてください。' });
  const request = W.proposalFeedbackRequest(state);
  assert.ok(!request.includes('手段の後'));
  assert.ok(request.includes(QUESTIONS[1].question));
  assert.deepEqual(state.answers, []);
  assert.equal(await f.controller.adopt(), false);
  assertNoExecution(f);
});

test('送信中の二重送信・回答変更・採用は受け付けず、追加AIを呼ばない', async () => {
  const pending = F.deferred();
  const f = await start({ propose: args => args.previous ? pending.promise : initial() });
  chooseBoth(f.controller);
  const ref = reference(f.controller), sending = f.controller.updateSuggestions(ref);
  assert.equal(await f.controller.updateSuggestions(ref), false);
  assert.equal(f.controller.setDecisionDraft('Q1', '送信中の変更', ref), false);
  assert.equal(await f.controller.adopt(), false);
  assert.equal(f.controller.newTask(), false);
  pending.resolve(initial()); await sending;
  assert.equal(f.count('propose'), 2);
  assertNoExecution(f);
});

test('回答の削除と空の一括送信ではAIを呼ばない', async () => {
  const f = await start();
  assert.equal(draft(f.controller, 'Q1', '手段の後'), true);
  assert.equal(draft(f.controller, 'Q1', ''), true);
  assert.deepEqual(f.controller.getState().decisionDrafts, {});
  assert.equal(W.proposalFeedbackRequest(f.controller.getState(), '  '), '');
  assert.equal(await f.controller.updateSuggestions(reference(f.controller)), false);
  assert.equal(f.count('propose'), 1);
  assertNoExecution(f);
});
