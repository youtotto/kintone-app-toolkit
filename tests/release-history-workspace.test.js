'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { KTReleaseWorkspace: Workspace } = require('../src/release-workspace.js');
const { fixture, proposal, plan, generated, REQUEST, deferred, clone } = require('./helpers/release-workspace-fixture.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const state = f => f.controller.getState();
async function built(options = {}) { const f = fixture(Workspace, options); await f.controller.send(REQUEST); await f.controller.adopt(); return f; }
const document = () => ({ reply: '資料を作成しました。', intent: 'question', proposalUnchanged: true,
  explanation: { title: '引継ぎ資料', sections: [{ heading: '条件', paragraphs: ['承認済みのときだけ編集を止めます。'], items: [], table: { columns: ['対象', '条件'], rows: [['備考', '承認済み']] }, evidenceIds: ['F1'] }], unknowns: [] }, facts: [{ id: 'F1', text: '確認した条件' }] });
const zeroActivity = f => { for (const method of ['propose', 'plan', 'generate', 'prepare', 'apply', 'prepareRollback', 'rollback']) assert.equal(f.count(method), 0, method); assert.equal(f.writes.length, 0); assert.equal(f.rollbackWrites.length, 0); };

test('会話・採用条件・計画・成果物・資料を開き直し、承認は最新設定で明示的に確認し直す', async () => {
  const f = await built();
  f.services.propose = async () => document();
  await f.controller.send('引継ぎ資料を作って', { requestPurpose: 'document' });
  const saved = f.controller.exportSession(), restored = fixture(Workspace);
  assert.equal(saved.version, 'release-workspace-session-1');
  assert.equal(Object.hasOwn(saved.state, 'prepared'), false);
  assert.equal(Object.hasOwn(saved.state, 'rollback'), false);
  assert.equal(Object.hasOwn(saved.state, 'progress'), false);
  assert.equal(Object.hasOwn(saved, 'base'), false);
  assert.equal(await restored.controller.restoreSession(clone(saved)), true);
  zeroActivity(restored);
  assert.deepEqual(restored.calls, [{ method: 'loadBase', reason: 'history-open', revision: 1 }]);
  for (const key of ['messages', 'proposal', 'adopted', 'plan', 'artifacts', 'explanations', 'explanationId', 'requestPurpose', 'answers', 'questionIdFloor', 'taskId']) assert.deepEqual(state(restored)[key], saved.state[key], key);
  assert.equal(state(restored).phase, 'blocked'); assert.equal(state(restored).error.code, 'APPROVAL_CHANGED');
  assert.equal(state(restored).prepared, null); assert.equal(await restored.controller.apply(), false);
  assert.equal(Workspace.canReprepare(state(restored)), true);
  assert.equal(await restored.controller.reprepare(), true); assert.equal(state(restored).phase, 'review');
  assert.equal(restored.count('prepare'), 1); assert.equal(restored.count('generate'), 0); assert.equal(restored.writes.length, 0);
  assert.equal(await restored.controller.apply(), true); assert.equal(state(restored).runs[0].status, 'complete');
});

test('未解決の計画質問・回答履歴と失敗した修正の採用禁止を引き継ぐ', async () => {
  const p = plan({ platforms: [] }); p.questions = [{ id: 'Q7', key: 'placement', question: '配置先はどこですか', blocking: true }];
  const reply = proposal(); reply.proposal.decisions.push({ id: 'Q9', key: 'condition', label: '条件', question: 'いつ止めますか', answer: '承認済み', blocking: true });
  const f = await built({ plan: p, propose: async () => reply });
  f.services.propose = async () => { throw new Error('修正の通信失敗'); };
  await f.controller.send('一覧は取り消し、備考は承認済みだけにして');
  const saved = f.controller.exportSession();
  assert.deepEqual(saved.pendingPlanQuestions, p.questions); assert.equal(saved.state.proposalPending, true);
  assert.equal(saved.state.questionIdFloor, 9);
  let received;
  const next = fixture(Workspace, { propose: async input => { received = input; return proposal(); } });
  assert.equal(await next.controller.restoreSession(saved), true);
  assert.equal(await next.controller.adopt(), false); assert.equal(next.count('plan'), 0);
  assert.equal(await next.controller.send('配置先は備考の下です'), true);
  assert.deepEqual(received.pendingPlanQuestions, p.questions); assert.equal(received.questionIdFloor, 9);
  assert.ok(received.requests.some(text => text.includes('一覧は取り消し')));
  assert.ok(state(next).messages.at(-1).id > saved.sequence);
});

test('相談の途中で保存しても遅い応答を復活させず、修正の再送まで旧案を採用させない', async () => {
  const gate = deferred(), f = fixture(Workspace);
  await f.controller.send(REQUEST); const old = f.controller.exportSession();
  f.services.propose = async () => gate.promise;
  const pending = f.controller.send('承認中も対象に追加してください'); await tick();
  const saved = f.controller.exportSession(); assert.equal(saved.state.phase, 'consulting');
  assert.equal(await f.controller.restoreSession(old), false, '処理中には開かない');
  assert.equal(f.controller.cancel(), true);
  assert.equal(await f.controller.restoreSession(saved), true);
  const reopened = state(f); gate.resolve(proposal('遅れて届いた案')); await pending;
  assert.deepEqual(state(f), reopened); assert.equal(reopened.proposalPending, true);
  assert.equal(await f.controller.adopt(), false); assert.equal(reopened.messages.at(-1).role, 'user');
});

test('資料作成中の保存は採用済み内容を保持し、完成していない資料を自動生成しない', async () => {
  const f = await built(), before = state(f), gate = deferred(); f.services.propose = async () => gate.promise;
  const pending = f.controller.send('資料をまとめて', { requestPurpose: 'document' }); await tick();
  const saved = f.controller.exportSession(), next = fixture(Workspace);
  assert.equal(await next.controller.restoreSession(saved), true); zeroActivity(next);
  assert.deepEqual(state(next).adopted, before.adopted); assert.deepEqual(state(next).plan, before.plan);
  assert.equal(state(next).proposalPending, false); assert.equal(state(next).phase, 'blocked');
  assert.equal(state(next).messages.at(-1).text, '資料をまとめて'); assert.equal(state(next).explanations.length, 0);
  f.controller.cancel(); gate.resolve(document()); await pending;
});

test('設定取得・権限確認の失敗は現在の会話を置き換えない', async () => {
  const saved = (await built()).controller.exportSession(); let fail = false;
  const f = fixture(Workspace, { loadBase: () => fail ? { ok: false, message: '権限がありません' } : { ok: true, stamp: 'other', inputs: { data: { appId: 'test-only' } } } });
  await f.controller.send('今の会話を残してください'); f.controller.setRequestPurpose('ideation');
  const before = state(f), count = f.calls.length; fail = true;
  assert.equal(await f.controller.restoreSession(saved), false); assert.deepEqual(state(f), before);
  assert.deepEqual(f.calls.slice(count).map(call => call.method), ['loadBase']);
});

test('開き直す設定確認の途中に他の操作を開始できず、失敗しても現在の会話を保つ', async () => {
  const saved = (await built()).controller.exportSession(), gate = deferred(); let wait = false;
  const f = fixture(Workspace, { loadBase: async () => wait ? gate.promise : { ok: true, stamp: 'preview:1', inputs: { data: { appId: 'test-only' } } } });
  await f.controller.send('残す内容'); const before = state(f); wait = true;
  const opening = f.controller.restoreSession(saved); await tick();
  assert.equal(await f.controller.send('割り込み'), false); assert.equal(f.controller.newTask(), false);
  assert.equal(await f.controller.restoreSession(saved), false);
  gate.resolve({ ok: false }); assert.equal(await opening, false); assert.deepEqual(state(f), before);
});

test('未知の版・壊れた状態・別アプリと別環境の履歴は開かない', async () => {
  const saved = (await built()).controller.exportSession(), f = fixture(Workspace), before = state(f);
  for (const mutate of [p => { p.version = 'release-workspace-session-99'; }, p => { p.state.messages = {}; }, p => { p.state.plan.steps[0].actionType = null; }, p => { p.state.runs = [{}]; }, p => { p.state.taskId = -1; }, p => { p.pendingPlanQuestions = null; }]) {
    const invalid = clone(saved); mutate(invalid); assert.equal(await f.controller.restoreSession(invalid), false); assert.deepEqual(state(f), before);
  }
  assert.equal(f.count('loadBase'), 0, '形式が不正なら設定取得もしない');
  for (const baseline of [{ ...saved.baseline, appId: 'other-app' }, { ...saved.baseline, environment: 'production' }]) {
    assert.equal(await f.controller.restoreSession({ ...saved, baseline }), false); assert.deepEqual(state(f), before);
  }
});

test('認証情報・旧設定・実行用スナップショットを除き、反映結果を閲覧専用で保存する', async () => {
  const f = await built({ platforms: [], prepare: async () => ({ ok: true, changes: [{ title: '一覧を追加', before: null, after: { name: '承認待ち' } }], confirmations: [], reasons: [], signature: 'private-approval', settings: { privateSnapshot: 'private-before' }, files: null }),
    apply: async () => ({ status: 'complete', written: 1, message: '反映済み', rows: [{ title: '一覧', status: 'VERIFIED' }], settings: { executionId: 'private-execution', before: { fields: 'private-settings' }, steps: [{ title: '一覧', status: 'VERIFIED', prepared: { payload: 'private-payload' } }] } }) });
  await f.controller.apply();
  const saved = f.controller.exportSession(), json = JSON.stringify(saved);
  for (const secret of ['private-approval', 'private-before', 'private-execution', 'private-settings', 'private-payload']) assert.equal(json.includes(secret), false, secret);
  assert.equal(Object.hasOwn(saved.state.runs[0], 'approval'), false); assert.equal(saved.state.runs[0].archived, true);
  const next = fixture(Workspace); assert.equal(await next.controller.restoreSession(saved), true); zeroActivity(next);
  const id = state(next).runs[0].id; assert.equal(state(next).phase, 'result'); assert.equal(state(next).runs[0].result.rows[0].title, '一覧');
  for (const action of ['requestRollback', 'rollback', 'recheckApply', 'recheckRollback']) assert.equal(await next.controller[action](id), false, action);
  for (const action of ['adopt', 'prepare', 'reprepare', 'apply', 'resume']) assert.equal(await next.controller[action](), false, action);
  zeroActivity(next);
});

test('AI応答へ混入した認証・使用量メタデータを保存せず、条件とコードは保持する', async () => {
  const f = await built({ generate: async ({ customization }) => ({ ...generated(customization), api_key: 'private-key', authorization: 'private-auth', generatedMetadata: 'private-other' }),
    propose: async () => { const response = proposal(); response.proposal.apiKey = 'private-proposal'; return response; } });
  const saved = f.controller.exportSession(), json = JSON.stringify(saved);
  for (const secret of ['private-key', 'private-auth', 'private-other', 'private-proposal', 'budgetMeta', 'input_tokens']) assert.equal(json.includes(secret), false, secret);
  assert.match(saved.state.artifacts[0].result.code, /承認済み/);
  assert.equal(await fixture(Workspace).controller.restoreSession(saved), true);
});

test('反映中断の記録は結果未確認として保持し、自動・手動の再実行入口を閉じる', async () => {
  const gate = deferred(), f = await built({ apply: async () => gate.promise });
  const pending = f.controller.apply(); await tick();
  // Approval hashing is asynchronous; wait until the explicit write operation has started.
  while (f.count('apply') === 0) await tick();
  const saved = f.controller.exportSession(), next = fixture(Workspace);
  assert.equal(saved.state.phase, 'applying'); assert.equal(await next.controller.restoreSession(saved), true);
  assert.equal(state(next).phase, 'result'); assert.equal(state(next).runs[0].status, 'unknown');
  assert.equal(state(next).runs[0].result.written, null); assert.equal(state(next).runs[0].archived, true);
  for (const action of ['adopt', 'prepare', 'reprepare', 'apply', 'resume']) assert.equal(await next.controller[action](), false, action);
  assert.equal(await next.controller.recheckApply(state(next).resultRunId), false); zeroActivity(next);
  gate.resolve({ status: 'complete', written: 1 }); await pending;
});

test('復元中断の記録を引き継いでも復元承認と実行状態を復活させない', async () => {
  const gate = deferred(), f = await built({ rollback: async () => gate.promise }); await f.controller.apply();
  const id = state(f).resultRunId; await f.controller.requestRollback(id);
  const pending = f.controller.rollback(id); await tick();
  const saved = f.controller.exportSession(), next = fixture(Workspace);
  assert.equal(saved.state.phase, 'rolling-back'); assert.equal(await next.controller.restoreSession(saved), true);
  assert.equal(state(next).phase, 'result'); assert.equal(state(next).rollback, null); assert.equal(state(next).runs[0].rollback.status, 'unknown');
  assert.equal(await next.controller.rollback(id), false); assert.equal(await next.controller.requestRollback(id), false); assert.equal(await next.controller.recheckRollback(id), false); zeroActivity(next);
  gate.resolve({ status: 'complete' }); await pending;
});

for (const changed of [false, true]) test('作成途中の履歴は明示の再開前に設定を再確認する: 設定変更=' + changed, async () => {
  const gate = deferred(); let second = false;
  const f = fixture(Workspace, { generate: async ({ customization }) => { if (customization.customizationId === 'C2') { second = true; return gate.promise; } return generated(customization); } });
  await f.controller.send(REQUEST); const pending = f.controller.adopt(); while (!second) await tick();
  const saved = f.controller.exportSession(), next = fixture(Workspace);
  if (changed) next.bump();
  assert.equal(await next.controller.restoreSession(saved), true); assert.equal(state(next).phase, 'incomplete'); zeroActivity(next);
  await next.controller.resume();
  assert.equal(next.calls.some(c => c.method === 'loadBase' && c.reason === 'resume'), true);
  assert.equal(next.count('generate'), changed ? 0 : 1); assert.equal(next.writes.length, 0);
  assert.equal(state(next).artifacts[0].customizationId, 'C1');
  assert.equal(state(next).phase, changed ? 'incomplete' : 'review');
  if (changed) assert.equal(state(next).error.code, 'BASE_CHANGED');
  f.controller.cancel(); gate.resolve(generated(f.plan.customizations[1])); await pending;
});

for (const changed of ['view', 'field', 'process', 'script']) test('復元後の無料確認は検証に使った設定の変化を照合する: ' + changed, async () => {
  let revision = 1;
  const loadBase = () => ({ ok: true, stamp: 'preview:' + revision, appId: 'app', env: 'preview', current: {
    fields: { properties: { memo: { type: revision > 1 && changed === 'field' ? 'SINGLE_LINE_TEXT' : 'MULTI_LINE_TEXT', code: 'memo' } } },
    status: { enable: true, states: revision > 1 && changed === 'process' ? { changed: {} } : {}, actions: [] },
    customize: { scope: 'ALL', desktop: { js: revision > 1 && changed === 'script' ? [{ type: 'URL', url: 'https://example.invalid/new.js' }] : [] }, mobile: { js: [] } },
    views: { other: revision }, files: [] } });
  const f = await built({ loadBase }); const saved = f.controller.exportSession();
  assert.match(saved.baseline.verificationFingerprint, /^[a-f0-9]{64}$/);
  revision++;
  const next = fixture(Workspace, { loadBase }); assert.equal(await next.controller.restoreSession(saved), true);
  assert.equal(state(next).error.code, 'BASE_CHANGED'); zeroActivity(next);
  await next.controller.reprepare();
  assert.equal(state(next).phase, changed === 'view' ? 'review' : 'blocked');
  if (changed !== 'view') { assert.equal(state(next).error.code, 'VERIFICATION_CONTEXT_CHANGED'); assert.equal(await next.controller.apply(), false); }
  assert.equal(next.count('generate'), 0); assert.equal(next.writes.length, 0);
});

test('保存した完成コードが検証対象と一致しなければ現在の会話を維持する', async () => {
  const saved = (await built()).controller.exportSession(), f = fixture(Workspace);
  await f.controller.send('現在の内容'); const before = state(f);
  saved.state.artifacts[0].result.code += '\n/* corrupted */';
  assert.equal(await f.controller.restoreSession(saved), false); assert.deepEqual(state(f), before);
});

test('会話・資料・反映の連番とタスク番号を保持し、再保存でも実行記録は閲覧専用を保つ', async () => {
  const f = await built(); await f.controller.apply(); f.controller.newTask();
  f.services.propose = async () => document(); await f.controller.send('資料を作って', { requestPurpose: 'document' });
  const saved = f.controller.exportSession(), next = fixture(Workspace); assert.equal(await next.controller.restoreSession(saved), true);
  const again = next.controller.exportSession(); assert.deepEqual(again.state.runs, saved.state.runs);
  assert.equal(state(next).taskId, saved.state.taskId); next.services.propose = async () => document();
  await next.controller.send('資料に追記して', { requestPurpose: 'document' });
  const after = state(next); assert.ok(after.messages.at(-1).id > saved.sequence); assert.ok(Number(after.explanations.at(-1).id.split('-').at(-1)) > saved.sequence);
  next.controller.newTask(); assert.equal(state(next).taskId, saved.state.taskId + 1);
});


test('認証項目に似たフィールドコードも採用内容・計画・証拠の一部としてそのまま保持する', async () => {
  const p = plan({ platforms: [] });
  p.steps[0].spec.fields = ['password', 'token', 'auth', 'constructor'];
  p.steps[0].spec.conditions = Object.fromEntries(p.steps[0].spec.fields.map(code => [code, { value: '業務条件' }]));
  const response = proposal(); response.proposal.decisions = [{ id: 'Q1', key: 'password', label: 'password', question: '対象条件', answer: '設定済み', blocking: true }];
  response.facts = [{ id: 'F1', fields: clone(p.steps[0].spec.conditions) }];
  const f = await built({ plan: p, propose: async () => response }), saved = f.controller.exportSession();
  saved.authorization = '保存対象外'; saved.state.credentials = '保存対象外';
  const next = fixture(Workspace); assert.equal(await next.controller.restoreSession(saved), true);
  assert.deepEqual(state(next).plan.steps[0].spec.conditions, p.steps[0].spec.conditions);
  assert.deepEqual(state(next).messages[1].facts, response.facts);
  assert.equal(state(next).adopted.decisions[0].key, 'password');
  assert.equal(JSON.stringify(next.controller.exportSession()).includes('保存対象外'), false);
});


test('実際の資料形式の表・根拠・複数行の本文を開き直せる', async () => {
  const { response } = require('./helpers/release-explanation-fixture.js');
  const f = fixture(Workspace, { propose: async () => response() });
  await f.controller.send('資料を作って', { requestPurpose: 'document' });
  const saved = f.controller.exportSession(), next = fixture(Workspace);
  assert.equal(await next.controller.restoreSession(saved), true);
  assert.deepEqual(state(next).explanations, saved.state.explanations);
  assert.deepEqual(state(next).messages, saved.state.messages); zeroActivity(next);
});


test('古い反映の復元中断はその記録へ紐づき、別の反映結果を上書きしない', async () => {
  const gate = deferred(), f = await built({ rollback: async () => gate.promise });
  await f.controller.apply(); const oldId = state(f).resultRunId;
  f.controller.newTask(); await f.controller.send('次の相談'); await f.controller.adopt(); await f.controller.apply(); const newId = state(f).resultRunId;
  await f.controller.requestRollback(oldId); const pending = f.controller.rollback(oldId); await tick();
  const saved = f.controller.exportSession(), next = fixture(Workspace);
  assert.equal(saved.state.resultRunId, oldId); assert.equal(await next.controller.restoreSession(saved), true);
  assert.equal(state(next).resultRunId, oldId);
  assert.equal(state(next).runs.find(r => r.id === oldId).rollback.status, 'unknown');
  assert.equal(state(next).runs.find(r => r.id === newId).rollback, undefined); zeroActivity(next);
  gate.resolve({ status: 'complete' }); await pending;
});


test('設定確認を待つ間に外側の編集が変わった場合は、開き直しを取り消して元の会話を保つ', async () => {
  const saved = (await built()).controller.exportSession(), gate = deferred(); let opening = false, unchanged = true;
  const f = fixture(Workspace, { loadBase: async () => opening ? gate.promise : { ok: true, stamp: 'preview:1', inputs: { data: { appId: 'test-only' } } } });
  await f.controller.send('元の会話'); const before = state(f), calls = f.calls.length; opening = true;
  const pending = f.controller.restoreSession(saved, { shouldContinue: () => unchanged }); await tick();
  unchanged = false; gate.resolve({ ok: true, stamp: 'preview:1', inputs: { data: { appId: 'test-only' } } });
  assert.equal(await pending, false); assert.deepEqual(state(f), before);
  assert.deepEqual(f.calls.slice(calls).map(call => call.method), ['loadBase']);
  assert.equal(f.writes.length, 0); assert.equal(f.rollbackWrites.length, 0);
});


test('応答検証の理由は診断を残した画面と保存復旧で読めるが、生の応答や認証情報は保存しない', async () => {
  const View = require('../src/release-view.js').KTReleaseView;
  const f=fixture(Workspace,{propose:async()=>document()});
  await f.controller.send('診断してください',{requestPurpose:'ideation',diagnosis:true});
  const old=clone(state(f).explanations);
  f.services.propose=async()=>{throw Object.assign(new Error('invalid'),{code:'MODEL_OUTPUT_INVALID',details:{error:{detail:{
    reason:'SCHEMA_INVALID',errors:[{code:'EXPLANATION_MUTATION_CONFLICT',path:'explanation',message:'PRIVATE_MODEL_TEXT',raw:'PRIVATE_MODEL_BODY'},
      {code:'not an identifier PRIVATE_TOKEN',path:'contains private value'}],warnings:[],headers:{Authorization:'PRIVATE_TOKEN'}
  }}}});};
  assert.equal(await f.controller.send('この項目の改善を相談したい'),false);
  const saved=f.controller.exportSession();
  assert.deepEqual(saved.state.error.detail,{errors:[{code:'EXPLANATION_MUTATION_CONFLICT',path:'explanation'}],warnings:[],reason:'SCHEMA_INVALID'});
  assert.doesNotMatch(JSON.stringify(saved),/PRIVATE_|not an identifier|contains private/);
  const restored=fixture(Workspace);assert.equal(await restored.controller.restoreSession(saved),true);
  assert.deepEqual(state(restored).explanations,old);
  const html=View.render(state(restored));assert.equal(html.split('data-release-panel="response-diagnostics"').length-1,1);
  assert.match(html,/EXPLANATION_MUTATION_CONFLICT/);assert.match(html,/SCHEMA_INVALID/);
  const incomplete={...state(restored),phase:'incomplete',explanationId:null,artifacts:[{customizationId:'C1',title:'備考',error:state(restored).error}]};
  const incompleteHtml=View.render(incomplete);
  assert.equal(incompleteHtml.split('data-release-panel="response-diagnostics"').length-1,1);
  assert.match(incompleteHtml,/EXPLANATION_MUTATION_CONFLICT/);

  assert.equal(await restored.controller.adopt(),false);zeroActivity(restored);
  assert.equal(f.count('propose'),1);assert.equal(f.count('plan'),0);assert.equal(f.writes.length,0);
});
