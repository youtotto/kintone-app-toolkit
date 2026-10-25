'use strict';
// Fixed responses through public actions; no model text interpretation or external calls.
const test = require('node:test'), assert = require('node:assert/strict');
const { KTReleaseWorkspace: Workspace } = require('../src/release-workspace.js');
const { KTReleaseView: View } = require('../src/release-view.js');
const { fixture, proposal, deferred, REQUEST } = require('./helpers/release-workspace-fixture.js');
const state = f => f.controller.getState();
const button = f => View.render(state(f)).match(/<button\b[^>]*data-release-action="adopt"[^>]*>/)?.[0];
const error = code => Object.assign(new Error('AI model output does not match schema'), { code });
const revised = () => { const r = proposal(); r.proposal.behaviors = [{ id: 'B2', origin: 'user', text: '確認メモは備考の上へ置き、一覧は追加しない' }]; return r; };

for (const code of ['MODEL_OUTPUT_INVALID', 'NETWORK_ERROR']) test('修正が' + code + 'で失敗したら、旧案の作成を画面と入口の両方で止める', async () => {
  let fail = false;
  const f = fixture(Workspace, { propose: args => { if (fail) throw error(code); return args.previous ? revised() : proposal(); } });
  await f.controller.send(REQUEST); await f.controller.adopt(); const old = state(f).proposal;
  fail = true; assert.equal(await f.controller.send('配置を備考の上に変更して一覧は取り消します'), false);
  assert.deepEqual(state(f).proposal, old); assert.equal(state(f).plan, null); assert.deepEqual(state(f).artifacts, []);
  assert.match(button(f), / disabled/);
  const count = f.count('plan');
  assert.equal(await f.controller.adopt(), false); assert.equal(await f.controller.prepare(), false);
  assert.equal(await f.controller.resume(), false); assert.equal(await f.controller.apply(), false);
  assert.equal(f.count('plan'), count); assert.equal(f.writes.length, 0);
  assert.match(View.render(state(f)), /相談内容をもう一度送信/);
  if (code === 'MODEL_OUTPUT_INVALID') assert.doesNotMatch(state(f).error.message, /schema|model output/);
  fail = false; await f.controller.send('配置を備考の上に変更して一覧は取り消します');
  assert.doesNotMatch(button(f), / disabled/); await f.controller.adopt();
  assert.deepEqual(f.calls.filter(c => c.method === 'plan').at(-1).proposal, revised().proposal); assert.equal(f.writes.length, 0);
});

test('設定取得に失敗しても旧案を採用させず、取得と再送の成功で回復する', async () => {
  let fail = false;
  const f = fixture(Workspace, { loadBase: () => { if (fail) throw error('BASE_UNAVAILABLE'); return { ok: true, current: {}, stamp: 'preview:1', files: [], inputs: { data: {} } }; } });
  await f.controller.send(REQUEST); fail = true; await f.controller.send('一覧は取り消します');
  assert.equal(await f.controller.adopt(), false); assert.equal(f.count('plan'), 0); assert.match(button(f), / disabled/);
  fail = false; await f.controller.send('一覧は取り消します'); await f.controller.adopt();
  assert.equal(state(f).phase, 'review'); assert.equal(f.writes.length, 0);
});

test('相談中断後に届く成功応答で旧案の採用禁止を解除しない', async () => {
  const entered = deferred(), gate = deferred(); let n = 0;
  const f = fixture(Workspace, { propose: async () => { if (++n === 2) { entered.resolve(); await gate.promise; } return n === 1 ? proposal() : revised(); } });
  await f.controller.send(REQUEST); const sending = f.controller.send('一覧を取り消す'); await entered.promise;
  assert.equal(await f.controller.adopt(), false);
  f.controller.cancel(); gate.resolve(); await sending;
  assert.equal(await f.controller.adopt(), false); assert.match(button(f), / disabled/); assert.equal(f.count('plan'), 0);
  await f.controller.send('一覧を取り消す'); await f.controller.adopt();
  assert.equal(state(f).phase, 'review'); assert.equal(f.writes.length, 0);
});

test('失敗した修正の後に質問だけ成功しても、旧案を採用可能に戻さない', async () => {
  let n = 0;
  const f = fixture(Workspace, { propose: () => { ++n; if (n === 2) throw error('MODEL_OUTPUT_INVALID'); const r = proposal(); if (n === 3) { r.intent = 'question'; r.proposalUnchanged = true; } return n >= 4 ? revised() : r; } });
  await f.controller.send(REQUEST); await f.controller.send('一覧を取り消します'); await f.controller.send('PCとモバイルはどこが違いますか');
  assert.equal(await f.controller.adopt(), false); assert.match(button(f), / disabled/); assert.equal(f.count('plan'), 0);
  await f.controller.send('一覧を取り消して案を更新してください'); await f.controller.adopt();
  assert.equal(state(f).phase, 'review'); assert.equal(f.writes.length, 0);
});

test('通常の質問が成功した場合は仮案を変えず、明示的な作成は引き続きできる', async () => {
  let n = 0;
  const f = fixture(Workspace, { propose: () => { const r = proposal(); if (++n > 1) { r.intent = 'question'; r.proposalUnchanged = true; } return r; } });
  await f.controller.send(REQUEST); const before = state(f).proposal; await f.controller.send('この案の対象画面を教えて');
  assert.deepEqual(state(f).proposal, before); assert.equal(f.count('plan'), 0);
  assert.doesNotMatch(button(f), / disabled/); await f.controller.adopt(); assert.equal(state(f).phase, 'review'); assert.equal(f.writes.length, 0);
});

test('質問だけでも失敗した応答の意図は推定せず、新しい会話で状態をリセットする', async () => {
  let n = 0; const f = fixture(Workspace, { propose: () => { if (++n === 2) throw error('NETWORK_ERROR'); return proposal(); } });
  await f.controller.send(REQUEST); await f.controller.send('対象画面はどれですか');
  assert.equal(await f.controller.adopt(), false); assert.equal(f.count('plan'), 0);
  f.controller.newTask(); await f.controller.send('別の案を作ります'); await f.controller.adopt();
  assert.equal(state(f).phase, 'review'); assert.equal(f.writes.length, 0);
});

test('計画作成だけが失敗した場合は、相談済みの同じ案をもう一度作成できる', async () => {
  let fail = true;
  const f = fixture(Workspace, { makePlan: () => { if (fail) throw error('NETWORK_ERROR'); return { plan: f.plan }; } });
  await f.controller.send(REQUEST); await f.controller.adopt();
  assert.equal(state(f).phase, 'incomplete'); assert.match(View.render(state(f)), /もう一度作成/);
  fail = false; await f.controller.adopt(); assert.equal(state(f).phase, 'review'); assert.equal(f.count('plan'), 2); assert.equal(f.writes.length, 0);
});


test('仮案から消えた回答済みの質問も、識別子で訂正し明示取消だけを外す', async () => {
  const q1 = { id: 'Q1', key: 'field.placement', label: '配置', question: '確認メモの配置はどこですか。', blocking: true };
  const q2 = { id: 'Q2', key: 'view.name', label: '一覧', question: '一覧名を指定してください。', blocking: true };
  const q3 = { id: 'Q3', key: 'field.required', label: '必須入力', question: '確認メモを必須入力にしますか。', blocking: false };
  const inputs = []; let n = 0, plannedInput = null;
  const f = fixture(Workspace, { propose: args => {
    inputs.push(args); const r = proposal();
    if (++n === 1) r.proposal.decisions = [q1, q2, q3];
    if (n === 2) r.turn.answers = [{ id: 'Q1', kind: 'value', text: '備考の下' }, { id: 'Q2', kind: 'value', text: '確認待ち' }, { id: 'Q3', kind: 'value', text: '任意入力' }];
    if (n === 3) { r.turn.answers = [{ id: 'Q1', kind: 'value', text: '備考の上' }]; r.turn.ops = [{ id: 'Q2', op: 'reject' }]; }
    return r;
  }, makePlan: args => { plannedInput = args; return { plan: f.plan }; } });
  await f.controller.send('確認メモと一覧を追加');
  await f.controller.send('備考の下、一覧名は確認待ち、確認メモは任意入力');
  assert.deepEqual(state(f).proposal.decisions, []);
  await f.controller.send('配置を備考の上に訂正、一覧は取り消し');
  assert.equal(state(f).answers.length, 2);
  assert.deepEqual(state(f).answers.find(a => a.id === 'Q1'), { id: 'Q1', key: q1.key, label: q1.label, question: q1.question, answer: '備考の上', kind: 'value' });
  assert.deepEqual(state(f).answers.find(a => a.id === 'Q3'), { id: 'Q3', key: q3.key, label: q3.label, question: q3.question, answer: '任意入力', kind: 'value' });
  await f.controller.adopt();
  assert.deepEqual(f.calls.filter(c => c.method === 'plan').at(-1).proposal, state(f).adopted);
  assert.deepEqual(plannedInput.answers, state(f).answers);
  assert.equal(state(f).questionIdFloor, 3);
  await f.controller.send('別の確認事項を追加');
  const input = inputs.at(-1);
  assert.equal(input.questionIdFloor, 3);
  const { KTReleaseContext: Context } = require('../src/release-context.js');
  assert.equal(Context.proposal(input).conversation.itemIdFloor.Q, 3);
  assert.deepEqual(Context.plan(plannedInput).decisions.map(d => [d.id, d.answer]).sort((a, b) => a[0].localeCompare(b[0])), [['D1', '備考の上'], ['D3', '任意入力']]);
  assert.equal(state(f).messages.some(m => m.text === '備考の下、一覧名は確認待ち、確認メモは任意入力'), true, '以前の発言は会話履歴に残す');
  assert.equal(f.writes.length, 0);
});

for (const outcome of ['failure', 'cancel']) test('質問ID高水位は' + outcome + 'の応答で進まず、新しい会話でだけ0へ戻る', async () => {
  const entered = deferred(), gate = deferred(); let n = 0;
  const f = fixture(Workspace, { propose: async () => {
    const r = proposal();
    if (++n === 1) r.proposal.decisions = [{ id: 'Q1', blocking: false, question: '配置を確認' }];
    if (n === 2) {
      entered.resolve(); await gate.promise;
      if (outcome === 'failure') throw error('MODEL_OUTPUT_INVALID');
      r.proposal.decisions = [{ id: 'Q2', blocking: false, question: '別の配置を確認' }];
    }
    return r;
  } });
  await f.controller.send(REQUEST); assert.equal(state(f).questionIdFloor, 1);
  const sending = f.controller.send('配置を変える'); await entered.promise;
  if (outcome === 'cancel') f.controller.cancel();
  gate.resolve(); await sending;
  assert.equal(state(f).questionIdFloor, 1);
  f.controller.newTask(); assert.equal(state(f).questionIdFloor, 0);
  assert.equal(state(f).proposalPending, false); assert.equal(f.writes.length, 0);
});

test('応答形式の診断は閉じた詳細に許可した三項目だけを文字として表示する', async () => {
  const details = { error: { detail: {
    errors: [{ code: 'PROPOSAL_ANSWER_ID_UNKNOWN', path: 'turn.answers[0].id', message: '<img src=x onerror=alert(1)>', token: 'PRIVATE_TOKEN' }],
    warnings: [{ code: 'W1', path: 'proposal.decisions', message: '識別子を確認', rawResponse: 'PRIVATE_RESPONSE' }],
    authorization: 'PRIVATE_AUTH', costUsd: 'PRIVATE_COST',
  } }, raw: 'PRIVATE_RAW' };
  let n = 0;
  const f = fixture(Workspace, { propose: () => { if (++n > 1) throw Object.assign(error('MODEL_OUTPUT_INVALID'), { details }); return proposal(); } });
  await f.controller.send(REQUEST); await f.controller.send('一覧を取消');
  const html = View.render(state(f));
  assert.match(html, /<details data-release-panel="response-diagnostics"><summary>問題の詳細（技術者向け）/);
  assert.match(html, /PROPOSAL_ANSWER_ID_UNKNOWN/); assert.match(html, /turn.answers\[0\].id/);
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img src=x|PRIVATE_|AI model output/);
  assert.deepEqual(state(f).error.detail, details, '診断情報は消さず、画面に出すキーだけを限定');
});

test('診断が無い形でも通常の失敗案内を残し、別種のエラーには形式診断を出さない', () => {
  for (const [code, detail] of [['MODEL_OUTPUT_INVALID', { unknown: 'PRIVATE_RAW' }], ['NETWORK_ERROR', { errors: [{ code: 'PRIVATE_CODE', message: 'PRIVATE_DETAIL' }] }]]) {
    const html = View.render({ phase: 'proposal', proposal: proposal().proposal, proposalPending: true, messages: [], error: { code, message: '案は更新していません。', detail } });
    assert.match(html, /案は更新していません/);
    assert.doesNotMatch(html, /response-diagnostics|PRIVATE_/);
  }
});
