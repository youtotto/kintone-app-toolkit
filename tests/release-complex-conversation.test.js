'use strict';
// Fixed responses test structured handoff, not real-model interpretation. No network or kintone writes.
const test = require('node:test'), assert = require('node:assert/strict');
const { KTReleaseWorkspace: Workspace } = require('../src/release-workspace.js');
const { fixture, proposal, plan, generated, deferred, clone } = require('./helpers/release-workspace-fixture.js');
const state = f => f.controller.getState();
const pending = f => Workspace.questions(state(f).proposal, state(f).answers);
const item = (id, text, origin = 'user') => ({ id, text, origin });
const question = (id, key, label, text, blocking = true) => ({ id, key, label, question: text, blocking });
const answered = (id, text) => ({ id, text, kind: 'value' });
function response({ behaviors = [item('B1', '経理確認中は備考だけ編集できるようにする')], decisions = [], answers = [], assumptions = [], cannot = [], unchanged = false } = {}) {
  const r = proposal('案を確認してください。');
  r.intent = 'update';
  r.proposal = { behaviors: clone(behaviors), decisions: clone(decisions), assumptions: clone(assumptions), cannot: clone(cannot), approach: { standard: [], js: [] } };
  r.turn.answers = clone(answers);
  if (unchanged) r.proposalUnchanged = true;
  return r;
}

test('配置・画面・一覧を何度も変えても、採用した構造と修正履歴を分けて渡す', async () => {
  const requests = ['経理確認と任意の確認メモを備考の下へ追加。PCだけ編集制御', 'モバイルも対象、メモは備考の上、一覧は後で', 'メモの追加は取り消す。経理確認中は備考だけ編集可能', '一覧だけ採用。通知は保留'];
  const replies = [
    response({ behaviors: [item('B1', 'PCで経理確認中の編集を制御'), item('B2', '備考の下に確認メモを追加'), item('B3', '確認待ちの一覧を追加', 'suggestion')] }),
    response({ behaviors: [item('B1', 'PC・モバイルで経理確認中の編集を制御'), item('B2', '備考の上に確認メモを追加'), item('B3', '確認待ちの一覧を追加', 'suggestion')] }),
    response({ behaviors: [item('B1', '経理確認中は備考だけ編集可能（PC・モバイル）'), item('B3', '確認待ちの一覧を追加', 'suggestion'), item('B4', '担当者に通知する', 'suggestion')] }),
    response({ behaviors: [item('B1', '経理確認中は備考だけ編集可能（PC・モバイル）'), item('B3', '確認待ちの一覧を追加'), item('B4', '担当者に通知する', 'suggestion')], assumptions: [{ id: 'A1', key: 'process.assignee', label: '作業者', text: '現在の指定を引き継ぐ' }], cannot: ['画面からの編集だけが対象です。'] }),
  ];
  const original = clone(replies), inputs = []; let index = 0;
  const f = fixture(Workspace, { propose: () => replies[index++], makePlan: args => { inputs.push(clone(args)); return { plan: plan() }; }, generate: args => { inputs.push(clone(args)); return generated(args.customization); } });
  for (const request of requests) await f.controller.send(request);
  assert.equal(f.count('plan'), 0);
  await f.controller.adopt();
  assert.equal(state(f).phase, 'review');
  const accepted = clone(replies[3].proposal); accepted.behaviors = accepted.behaviors.filter(b => b.origin !== 'suggestion');
  assert.equal(inputs.length, 3);
  for (const input of inputs) { assert.deepEqual(input.proposal, accepted); assert.deepEqual(input.requests, requests); assert.equal(input.version, 4); }
  assert.equal(inputs[0].goal, requests[0], '最初の依頼を現在の採用内容とは別に保持する');
  assert.deepEqual(replies, original);
  assert.deepEqual(state(f).adopted.behaviors.map(b => b.id), ['B1', 'B3']);
  assert.equal(f.writes.length, 0);
});

test('矛盾を解く質問が二つあるとき、一つの回答だけでは作成へ進めない', async () => {
  const q1 = question('Q1', 'edit.accounting', '経理確認中', '備考だけ編集可能にしますか。');
  const q2 = question('Q2', 'edit.approved', '承認済み', '承認済みでは備考も編集不可にしますか。');
  const replies = [response({ decisions: [q1, q2] }), response({ decisions: [{ ...q1, blocking: false }, q2], answers: [answered('Q1', '備考だけ編集可能')] }), response({ decisions: [{ ...q1, blocking: false }, { ...q2, blocking: false }], answers: [answered('Q2', '承認済みでは備考も編集不可')] })];
  let i = 0; const inputs = [];
  const f = fixture(Workspace, { propose: () => replies[i++], makePlan: args => { inputs.push(args); return { plan: plan() }; } });
  await f.controller.send('全項目を編集不可。ただ経理確認中は備考を編集したい。承認済みはどうしよう');
  assert.deepEqual(pending(f).map(q => q.id), ['Q1', 'Q2']); assert.equal(await f.controller.adopt(), false);
  await f.controller.send('経理確認中は備考だけ編集できます');
  assert.deepEqual(pending(f).map(q => q.id), ['Q2']); assert.equal(await f.controller.adopt(), false); assert.equal(f.count('plan'), 0);
  await f.controller.send('承認済みでは備考も編集不可です');
  assert.deepEqual(pending(f), []); assert.equal(f.count('plan'), 0);
  await f.controller.adopt();
  assert.deepEqual(inputs[0].answers.map(a => [a.id, a.answer]), [['Q1', '備考だけ編集可能'], ['Q2', '承認済みでは備考も編集不可']]);
  assert.equal(f.writes.length, 0);
});

test('同じ質問への明示的な訂正は古い回答を一件だけ置き換えて計画へ渡す', async () => {
  const q = question('Q1', 'process.assignee', '作業者', '課長と部長のどちらを作業者にしますか。');
  const replies = [response({ decisions: [q] }), response({ decisions: [{ ...q, blocking: false }], answers: [answered('Q1', '課長')] }), response({ decisions: [{ ...q, blocking: false }], answers: [answered('Q1', '部長')] })];
  let i = 0; let received;
  const f = fixture(Workspace, { propose: () => replies[i++], makePlan: args => { received = clone(args.answers); return { plan: plan() }; } });
  for (const text of ['承認経路を変えます', '課長にします', '訂正して部長にします']) await f.controller.send(text);
  assert.equal(f.count('plan'), 0); await f.controller.adopt();
  assert.equal(received.length, 1); assert.equal(received[0].answer, '部長'); assert.equal(received[0].question, q.question);
  assert.equal(f.writes.length, 0);
});

test('同じ話題でも別の確認事項は前に回答した質問と区別する', async () => {
  const q1 = question('Q1', 'process.assignee', '作業者', '課長の指定を使いますか。');
  const q2 = question('Q2', 'process.assignee', '作業者', '追加する経理確認の作業者は誰にしますか。');
  const replies = [response({ decisions: [q1] }), response({ answers: [answered('Q1', '既存の課長')] }), response({ decisions: [q2] })];
  let i = 0; const f = fixture(Workspace, { propose: () => replies[i++] });
  for (const text of ['課長承認を追加', '既存の課長', '経理確認も追加']) await f.controller.send(text);
  assert.deepEqual(pending(f).map(q => q.id), ['Q2']);
  assert.equal(await f.controller.adopt(), false); assert.equal(f.count('generate'), 0); assert.equal(f.writes.length, 0);
});

test('作成途中でモバイルだけへ変更したら、以前に完成したPCコードを混ぜない', async () => {
  let proposed = 0; let planned = 0; const generatedInputs = [];
  const f = fixture(Workspace, {
    propose: () => response({ behaviors: [item('B1', proposed++ ? 'モバイルだけで備考を編集不可にする' : 'PC・モバイルで備考を編集不可にする')] }),
    makePlan: () => ({ plan: plan({ settings: false, platforms: planned++ ? ['mobile'] : ['desktop', 'mobile'] }) }),
    generate: args => { generatedInputs.push(clone(args)); return generated(args.customization, planned === 1 && args.customization.platform[0] === 'mobile' ? { state: 'incomplete', message: 'モバイルは作成できませんでした。' } : {}); },
  });
  await f.controller.send('PCとモバイルの備考を編集不可'); await f.controller.adopt();
  assert.equal(state(f).phase, 'incomplete'); assert.equal(state(f).artifacts[0].result.artifactOutcome.state, 'ready');
  await f.controller.send('PCは取り消します。モバイルだけにしてください');
  assert.deepEqual(state(f).artifacts, []); assert.equal(await f.controller.resume(), false);
  await f.controller.adopt(); assert.equal(state(f).phase, 'review'); assert.equal(f.count('generate'), 3);
  assert.deepEqual(state(f).artifacts.map(a => a.result.artifactOutcome.operations[0].targetPlatform), ['mobile']);
  assert.equal(generatedInputs.at(-1).proposal.behaviors[0].text, 'モバイルだけで備考を編集不可にする'); assert.equal(f.writes.length, 0);
});

test('質問だけの応答は仮案を変更せず作成も反映も始めない', async () => {
  const original = response();
  const answer = response({ behaviors: [item('B1', '受け取ってはいけない別案')], unchanged: true });
  answer.intent = 'question'; answer.reply = '画面からの編集だけが対象です。';
  let i = 0; const f = fixture(Workspace, { propose: () => i++ ? answer : original });
  await f.controller.send('経理確認中の編集を変えたい'); const before = state(f);
  await f.controller.send('この変更はどの画面で効きますか');
  assert.deepEqual(state(f).proposal, before.proposal); assert.equal(state(f).version, before.version);
  assert.equal(f.count('plan'), 0); assert.equal(f.count('generate'), 0); assert.equal(f.writes.length, 0);
});

test('新しい相談は旧会話の回答・保留案・修正履歴を引き継がない', async () => {
  const q = question('Q1', 'layout.place', '配置', '備考の上下のどちらに置きますか。');
  const inputs = []; let i = 0;
  const f = fixture(Workspace, { propose: args => { inputs.push(clone(args)); return i++ === 0 ? response({ decisions: [q], behaviors: [item('B1', '確認メモを追加'), item('B2', '一覧も追加', 'suggestion')] }) : i === 2 ? response({ answers: [answered('Q1', '備考の上')] }) : response(); } });
  await f.controller.send('確認メモを追加'); await f.controller.send('備考の上');
  assert.equal(state(f).answers.length, 1); f.controller.newTask(); await f.controller.send('新しい依頼は経理確認だけです');
  assert.equal(inputs.at(-1).previous, null); assert.deepEqual(inputs.at(-1).answers, []);
  assert.deepEqual(inputs.at(-1).requests, ['新しい依頼は経理確認だけです']); assert.equal(state(f).goal, '新しい依頼は経理確認だけです');
  assert.equal(f.writes.length, 0);
});

test('中断した質問の遅い回答を同じ番号の質問がある新しい会話へ持ち込まない', async () => {
  const q = question('Q1', 'process.assignee', '作業者', '経理確認の作業者は誰ですか。');
  const entered = deferred(), gate = deferred(); let i = 0;
  const f = fixture(Workspace, { propose: async () => {
    if (++i === 2) { entered.resolve(); await gate.promise; return response({ answers: [answered('Q1', '以前の担当者')] }); }
    return response({ decisions: [q] });
  } });
  await f.controller.send('最初の変更を相談'); const delayed = f.controller.send('以前の担当者');
  await entered.promise; f.controller.cancel(); f.controller.newTask(); await f.controller.send('別の変更を相談'); const current = state(f);
  gate.resolve(); await delayed;
  assert.deepEqual(state(f), current); assert.deepEqual(state(f).answers, []); assert.deepEqual(pending(f).map(q => q.id), ['Q1']);
  assert.equal(await f.controller.adopt(), false); assert.equal(f.writes.length, 0);
});
