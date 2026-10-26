'use strict';
// Explicit file selection and the existing conversation/approval route. No external requests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { KTReleaseWorkspace: W } = require('../src/release-workspace.js');
const { KTReleaseContext: C } = require('../src/release-context.js');
const { fixture, proposal, plan, deferred, clone } = require('./helpers/release-workspace-fixture.js');
const selection = (target = 'desktop', extra = {}) => ({ name: 'shared.js', target, type: 'FILE', environment: 'preview', ...extra });
const file = (target, revision = 1) => ({ name: 'shared.js', target, type: 'FILE', fileKey: target + '-' + revision, sourceAvailable: true, text: '// ' + target + ' current ' + revision });
const base = (revision = 1) => ({ ok: true, appId: '310', env: 'preview', stamp: 'preview:' + revision, revision: { preview: String(revision) }, loadedAt: revision,
  data: { fields: {}, status: { states: {}, actions: [] } }, files: [file('desktop', revision), file('mobile', revision)] });
function setup(options = {}) {
  let current = base(); const proposals = [], plans = [];
  const f = fixture(W, { plan: plan({ platforms: [] }), loadBase: async args => options.loadBase ? options.loadBase(args, current) : clone(current),
    propose: args => { proposals.push(args); return options.propose ? options.propose(args) : proposal(); },
    makePlan: args => { plans.push(args); return { plan: plan({ platforms: [] }) }; } });
  return { ...f, proposals, plans, state: () => f.controller.getState(), setBase: value => { current = value; } };
}
const semanticState = state => { const value = clone(state); delete value.consultationTarget; return value; };

test('selecting or clearing a file does not call AI, reset a conversation or change a prepared approval', async () => {
  const f = setup();
  await f.controller.send('一覧を追加してください'); await f.controller.adopt();
  const before = f.state(), calls = f.calls.length;
  assert.equal(f.controller.setConsultationTarget(selection()), true);
  assert.deepEqual(semanticState(f.state()), semanticState(before));
  assert.equal(f.controller.setConsultationTarget(null), true);
  assert.deepEqual(f.state(), before); assert.equal(f.calls.length, calls); assert.equal(f.writes.length, 0);
});

test('selection records only file identity; fresh PC and mobile bodies are resolved for each send', async () => {
  const f = setup();
  assert.equal(f.controller.setConsultationTarget(selection('desktop', { fileKey: 'old', revision: '0', source: 'UNSAVED_OR_STALE', text: 'UNSAVED_OR_STALE' })), true);
  await f.controller.send('この処理を説明してください');
  assert.equal(f.proposals[0].consultationTarget.fileKey, 'desktop-1');
  assert.equal(f.state().messages[0].consultationTarget.target, 'desktop');
  assert.equal(JSON.stringify(f.state()).includes('UNSAVED_OR_STALE'), false);
  f.setBase(base(2)); await f.controller.send('入力時の動きも説明してください');
  assert.equal(f.proposals[1].consultationTarget.fileKey, 'desktop-2');
  assert.equal(f.proposals[1].consultationTarget.revision, '2');
  f.controller.setConsultationTarget(selection('mobile'));
  await f.controller.send('こちらも同じ動きにしてください');
  const last = f.proposals.at(-1), context = C.proposal(last);
  assert.equal(context.focus.target.id, 'mobile:js:shared.js');
  assert.equal(context.focus.target.fileKey, 'mobile-2');
  assert.equal(context.facts.find(x => x.kind === 'js-file' && x.value.target === 'mobile').value.source, '// mobile current 2');
  const history = context.facts.find(x => x.kind === 'consultation-history').value;
  assert.deepEqual(history.map(x => x.target.target), ['desktop', 'desktop', 'mobile']);
  assert.deepEqual(history.map(x => x.text), ['この処理を説明してください', '入力時の動きも説明してください', 'こちらも同じ動きにしてください']);
  assert.ok(context.conversation.discussion.every(x => !Object.hasOwn(x, 'consultationTarget')));
});

test('browsing another file cannot replace the target of an accepted proposal', async () => {
  const f = setup(); f.controller.setConsultationTarget(selection());
  await f.controller.send('このJavaScriptを修正してください');
  f.controller.setConsultationTarget(selection('mobile'));
  f.setBase(base(2)); await f.controller.adopt();
  assert.equal(f.plans[0].consultationTarget.target, 'desktop');
  assert.equal(f.plans[0].consultationTarget.fileKey, 'desktop-2');
  const context = C.plan(f.plans[0]);
  assert.deepEqual(context.subject, { type: 'javascript', sourceId: 'desktop:js:shared.js', name: 'shared.js', target: 'desktop', customizationType: 'FILE', sourceAvailable: true });
  assert.equal(f.state().adoptedTarget.target, 'desktop');
  const before = f.state(); f.controller.setConsultationTarget(null);
  assert.deepEqual(semanticState(f.state()), semanticState(before));
});

test('busy selection is rejected without changing the in-flight target', async () => {
  const pending = deferred(), f = setup({ propose: () => pending.promise });
  f.controller.setConsultationTarget(selection());
  const sending = f.controller.send('このJavaScriptを説明してください');
  assert.equal(f.controller.setConsultationTarget(selection('mobile')), false);
  pending.resolve(proposal()); await sending;
  assert.equal(f.proposals[0].consultationTarget.target, 'desktop');
  assert.equal(f.state().consultationTarget.target, 'desktop');
});

for (const [name, mutate, code] of [
  ['missing selected file', b => { b.files = b.files.filter(f => f.target !== 'desktop'); }, 'CONSULTATION_TARGET_CHANGED'],
  ['duplicate selected file', b => { b.files.push(file('desktop')); }, 'CONSULTATION_TARGET_CHANGED'],
  ['missing body', b => { b.files[0].text = null; b.files[0].sourceAvailable = false; }, 'CONSULTATION_SOURCE_UNAVAILABLE'],
  ['production base', b => { b.env = 'production'; }, 'CONSULTATION_ENVIRONMENT'],
]) test(name + ' stops before a paid proposal request', async () => {
  const f = setup(), b = base(); mutate(b); f.setBase(b); f.controller.setConsultationTarget(selection());
  assert.equal(await f.controller.send('修正してください'), false);
  assert.equal(f.proposals.length, 0); assert.equal(f.plans.length, 0); assert.equal(f.state().error.code, code);
  assert.equal(f.writes.length, 0);
});

test('removed adopted target stops before a paid plan request even if another file is selected', async () => {
  const f = setup(); f.controller.setConsultationTarget(selection()); await f.controller.send('修正してください');
  const b = base(2); b.files = [file('mobile', 2)]; f.setBase(b); f.controller.setConsultationTarget(selection('mobile'));
  assert.equal(await f.controller.adopt(), false); assert.equal(f.plans.length, 0);
  assert.equal(f.state().error.code, 'CONSULTATION_TARGET_CHANGED');
});

test('selected suggestions update their proposal target, not a later file selection', async () => {
  const p = proposal(); p.proposal.behaviors.push({ id: 'B3', text: '備考も表示する', origin: 'suggestion' });
  const f = setup({ propose: () => clone(p) }); f.controller.setConsultationTarget(selection()); await f.controller.send('一覧を追加してください');
  const ref = { taskId: f.state().taskId, version: f.state().version };
  f.controller.setConsultationTarget(selection('mobile'));
  assert.equal(f.controller.selectSuggestion('B3', true, ref), true);
  await f.controller.updateSuggestions(ref);
  assert.equal(f.proposals.at(-1).consultationTarget.target, 'desktop');
});

test('a new conversation clears file references; invalid selections leave the existing target intact', async () => {
  const f = setup(); f.controller.setConsultationTarget(selection());
  for (const value of [selection('mobile', { environment: 'production' }), selection('desktop', { type: 'URL' }), selection('invalid'), selection('desktop', { name: '' })]) {
    assert.equal(f.controller.setConsultationTarget(value), false); assert.deepEqual(f.state().consultationTarget, selection());
  }
  await f.controller.send('変更してください'); f.controller.newTask();
  assert.equal(f.state().consultationTarget, null); assert.equal(f.state().proposalTarget, null); assert.equal(f.state().adoptedTarget, null);
  assert.equal(f.state().messages.length, 0); const calls = f.proposals.length;
  await f.controller.send('アプリの概要を説明してください');
  assert.equal(f.proposals.length, calls + 1);
  const context = C.proposal(f.proposals.at(-1));
  assert.equal(context.focus.resolution, 'none'); assert.ok(!context.facts.some(x => x.kind === 'consultation-history'));
});
