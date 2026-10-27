'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
function load(name, file, overrides = {}) {
  if (!file) return require('../src/' + name);
  const filename = path.resolve(__dirname, '../src', name), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = module.paths;
  loaded.require = id => Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : require(id);
  loaded._compile(fs.readFileSync(file, 'utf8'), filename); return loaded.exports;
}
const { KTReleaseWorkspace: Workspace } = load('release-workspace.js', process.env.KT_RELEASE_WORKSPACE_SRC);
const { KTReleaseView: View } = load('release-view.js', process.env.KT_RELEASE_VIEW_SRC, { './release-workspace.js': { KTReleaseWorkspace: Workspace } });
const { fixture, REQUEST, generated, plan, deferred } = require('./helpers/release-workspace-fixture.js');
const get = f => f.controller.getState(), ai = f => ['propose', 'plan', 'generate'].map(m => f.count(m));
const html = state => View.render(state).replace(/<style>[\s\S]*?<\/style>/g, '');
const build = async f => { await f.controller.send(REQUEST); await f.controller.adopt(); };
async function unknownApply() {
  const f = fixture(Workspace, { apply: async () => ({ status: 'unknown', written: null, message: '応答を受け取れませんでした', files: { marker: 'keep' }, settings: { marker: 'keep-settings' } }) });
  await build(f); await f.controller.apply();
  return { f, id: get(f).runs[0].id };
}

test('反映の結果不明を読み取りだけで確認し、承認・計画・元の証拠を保持する', async () => {
  const { f, id } = await unknownApply(), before = get(f), counts = ai(f), writes = f.writes.length;
  let reads = 0;
  f.execution.recheckApply = async run => { reads++; assert.equal(run.id, id); run.goal = '写しだけ'; return { ...run.result, status: 'complete', written: true, recoveryState: 'applied', message: '一致しました' }; };
  assert.match(html(before), /data-release-action="recheck-apply"[^>]*>反映結果を確認する/);
  assert.doesNotMatch(html(before), /data-release-action="apply"|data-release-action="request-rollback"/);
  assert.equal(await f.controller.recheckApply(id), true);
  const after = get(f);
  assert.equal(after.phase, 'result'); assert.equal(after.runs[0].status, 'complete');
  assert.deepEqual(after.runs[0].approval, before.runs[0].approval);
  assert.deepEqual(after.runs[0].prepared, before.runs[0].prepared);
  assert.deepEqual(after.plan, before.plan); assert.deepEqual(after.artifacts, before.artifacts);
  assert.deepEqual(after.runs[0].result.files, { marker: 'keep' }); assert.equal(after.runs[0].goal, before.runs[0].goal);
  assert.equal(reads, 1); assert.deepEqual(ai(f), counts); assert.equal(f.writes.length, writes); assert.equal(f.count('apply'), 1);
  assert.equal(await f.controller.recheckApply(id), false); assert.equal(await f.controller.apply(), false);
});

test('反映の再確認中は二重操作・会話・中断を受けず、遅れた結果は対象記録にだけ入る', async () => {
  const { f, id } = await unknownApply(), gate = deferred(), entered = deferred(), counts = ai(f);
  f.execution.recheckApply = async () => { entered.resolve(); return gate.promise; };
  const work = f.controller.recheckApply(id); await entered.promise;
  assert.equal(get(f).phase, 'checking-result');
  const screen = html(get(f)); assert.match(screen, /反映結果を確認しています/); assert.doesNotMatch(screen, /復元結果を確認しています/); assert.match(screen, /<textarea[^>]* disabled/);
  assert.equal(await f.controller.recheckApply(id), false); assert.equal(await f.controller.apply(), false);
  assert.equal(await f.controller.requestRollback(id), false); assert.equal(await f.controller.send('別の相談'), false);
  assert.equal(f.controller.newTask(), false); assert.equal(f.controller.cancel(), false);
  gate.resolve({ status: 'unknown', written: null, recoveryState: 'unknown', message: '確認できません' }); await work;
  assert.equal(get(f).phase, 'result'); assert.equal(get(f).runs[0].status, 'unknown'); assert.deepEqual(ai(f), counts);
});

test('過去の反映記録を再確認しても、進行中の別の案と作業段階を上書きしない', async () => {
  const { f, id } = await unknownApply(); f.controller.newTask(); await f.controller.send('現在の別の相談');
  const before = get(f), counts = ai(f);
  f.execution.recheckApply = async run => ({ ...run.result, status: 'failed', written: false, recoveryState: 'not-applied', message: '反映前でした' });
  await f.controller.recheckApply(id); const after = get(f);
  const withoutRuns = state => { const copy = { ...state }; delete copy.runs; return copy; };
  assert.deepEqual(withoutRuns(after), withoutRuns(before)); assert.deepEqual(ai(f), counts);
  assert.equal(after.runs[0].status, 'failed'); assert.equal(f.count('apply'), 1);
});

for (const result of ['throw', 'invalid']) test('再確認の' + result + 'では元の証拠と結果不明を維持する', async () => {
  const { f, id } = await unknownApply(), before = get(f).runs[0];
  f.execution.recheckApply = async () => { if (result === 'throw') throw Error('読取不可'); return { status: 'unexpected' }; };
  await f.controller.recheckApply(id);
  const after = get(f).runs[0];
  assert.equal(after.status, 'unknown'); assert.deepEqual(after.result.files, before.result.files);
  assert.deepEqual(after.result.settings, before.result.settings); assert.equal(after.result.written, null);
});

test('第三者変更と判定された反映の部分結果から復元を開始しない', async () => {
  const { f, id } = await unknownApply();
  f.execution.recheckApply = async run => ({ ...run.result, status: 'partial', written: true, recoveryState: 'changed', retryable: false, message: '別の変更があります' });
  await f.controller.recheckApply(id);
  assert.doesNotMatch(html(get(f)), /data-release-action="request-rollback"/);
  assert.equal(await f.controller.requestRollback(id), false); assert.equal(f.count('prepareRollback'), 0);
});

for (const [state, title, resume] of [
  ['incomplete', '作成途中です', true], ['failed', '検証で不一致がありました', true], ['unverified', '検証できない内容があります', false]
]) test(state + 'を見出しと次の操作で区別する', async () => {
  const f = fixture(Workspace, { generate: ({ customization }) => generated(customization, { state, message: '検証の具体的な理由' }) });
  await build(f); const current = get(f), screen = html(current), counts = ai(f);
  assert.match(screen, new RegExp('<h2>' + title)); assert.match(screen, /検証の具体的な理由/);
  assert.equal(screen.includes('data-release-action="resume"'), resume);
  const codeScreen = View.render(current, { codePanelState: () => ({ open: true, available: true }) });
  assert.match(codeScreen, new RegExp('ktr-code-attention[\\s\\S]*?' + title));
  if (!resume) {
    assert.match(screen, /data-release-action="focus-consultation"/);
    assert.equal(await f.controller.resume(), false); assert.deepEqual(ai(f), counts);
  }
  assert.equal(f.count('apply'), 0);
});

test('完成済みと検証不能の混在では完成済みを保持し、再生成を誘導しない', async () => {
  const f = fixture(Workspace, { generate: ({ customization }) => generated(customization, { state: customization.customizationId === 'C1' ? 'ready' : 'unverified' }) });
  await build(f); const before = get(f), counts = ai(f), screen = html(before);
  assert.equal(before.artifacts[0].result.artifactOutcome.state, 'ready');
  assert.match(screen, /できた内容/); assert.match(screen, /完成した内容は残っています/);
  assert.doesNotMatch(screen, /data-release-action="resume"|反映する変更はありません/);
  assert.equal(await f.controller.resume(), false); assert.deepEqual(ai(f), counts);
  assert.deepEqual(get(f).artifacts, before.artifacts);
});

test('検証不能と辞退は同じ要求をそのまま有料再生成へ送らない', async () => {
  for (const code of ['SANDBOX_OUTDATED','SANDBOX_UNAVAILABLE','REQUIRED_EFFECTS_UNRESOLVED','CONDITION_SOURCE_UNVERIFIABLE','GENERATION_DECLINED']) {
    const f = fixture(Workspace, { generate: () => { throw Object.assign(Error('作成前に止まりました'), { code }); } });
    await build(f); const counts = ai(f), screen = html(get(f));
    assert.doesNotMatch(screen, /data-release-action="resume"/, code);
    assert.match(screen, /相談欄で内容を修正する/);
    assert.equal(await f.controller.resume(), false, code); assert.deepEqual(ai(f), counts);
  }
});

test('不一致の明示的な再作成では完成済みを再生成しない', async () => {
  let failed = true;
  const f = fixture(Workspace, { generate: ({ customization }) => generated(customization, { state: customization.customizationId === 'C2' && failed ? 'failed' : 'ready' }) });
  await build(f); assert.equal(get(f).phase, 'incomplete');
  failed = false; assert.equal(await f.controller.resume(), true);
  assert.equal(get(f).phase, 'review');
  assert.equal(f.calls.filter(c => c.method === 'generate' && c.id === 'C1').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'generate' && c.id === 'C2').length, 2);
  assert.equal(f.count('apply'), 0);
});

test('計画時の重要な仮決定を最終確認へ届け、質問・制約・採用済み回答と混同しない', async () => {
  const p = plan(); p.provisionals = [{ id: 'V1', topic: '対象の操作', choice: 'PCの一覧編集にも備考の編集制御を適用します。<script>', reason: '同じ項目を一覧から変更できるためです。', changeHint: '一覧編集は対象外にしたい、と相談してください。' }];
  const f = fixture(Workspace, { plan: p }); await build(f);
  const before = get(f), counts = ai(f), screen = html(before);
  assert.match(screen, /<h3>計画で決めたこと<\/h3>/);
  assert.match(screen, /PCの一覧編集にも備考の編集制御を適用します。&lt;script&gt;/);
  assert.match(screen, /同じ項目を一覧から変更できるためです/);
  assert.match(screen, /変更したいとき/); assert.match(screen, /反映前に相談してください/);
  assert.doesNotMatch(screen, /<script>|data-release-action="answer"/);
  assert.match(screen, /data-release-action="apply"/);
  assert.deepEqual(get(f), before); assert.deepEqual(ai(f), counts);
  assert.equal(before.prepared.confirmations.length, 0);
  assert.deepEqual(before.adopted, get(f).adopted);
  const without = { ...before, plan: { ...before.plan, provisionals: [] } };
  assert.doesNotMatch(html(without), /計画で決めたこと/);
});


test('一部の書き込みを把握していても全体結果が不明な間は復元せず読取確認へ進む', async () => {
  const f = fixture(Workspace, { apply: async () => ({ status: 'unknown', written: true, message: '一部の応答を受け取れませんでした' }) });
  await build(f); await f.controller.apply(); const state = get(f), id = state.runs[0].id;
  assert.match(html(state), /data-release-action="recheck-apply"/);
  assert.doesNotMatch(html(state), /data-release-action="request-rollback"/);
  assert.equal(await f.controller.requestRollback(id), false); assert.equal(f.count('prepareRollback'), 0);
});


test('過去の復元結果を読み取り直しても新しい案の段階と内容を保持する', async () => {
  const f = fixture(Workspace, { rollback: async () => ({ status: 'unknown', message: '戻した結果を確認できません' }) });
  await build(f); await f.controller.apply(); const id = get(f).runs[0].id;
  await f.controller.requestRollback(id); await f.controller.rollback(id);
  f.controller.newTask(); await f.controller.send('別の変更案');
  const before = get(f), counts = ai(f), writes = f.writes.length, restores = f.count('rollback');
  f.execution.recheckRollback = async run => ({ ...run.rollback, status: 'complete', message: '戻した結果を確認しました' });
  assert.equal(await f.controller.recheckRollback(id), true); const after = get(f);
  const withoutRuns = state => { const copy = { ...state }; delete copy.runs; return copy; };
  assert.deepEqual(withoutRuns(after), withoutRuns(before));
  assert.equal(after.runs[0].rollback.status, 'complete'); assert.deepEqual(ai(f), counts);
  assert.equal(f.writes.length, writes); assert.equal(f.count('rollback'), restores);
  assert.match(html(after), /data-release-action="adopt"/);
});


test('利用上限の後は接続確認と明示的再開を選べ、毎回の上限確認と完成済みの保持を続ける', async () => {
  let available = false, paid = 0;
  const f = fixture(Workspace, { generate: ({ customization }) => {
    if (customization.customizationId === 'C2' && !available) throw Object.assign(Error('limit'), { code: 'BUDGET_EXCEEDED' });
    paid++; return generated(customization);
  } });
  await build(f); const before = get(f), screen = html(before);
  assert.match(screen, /AIの利用上限に達しました/);
  assert.match(screen, /data-release-action="connect"[^>]*>利用状況を確認する/);
  assert.match(screen, /data-release-action="resume"[^>]*>未完了の作成を再開/);
  assert.match(screen, /利用可能になったら/); assert.equal(paid, 1);
  assert.equal(f.calls.filter(c => c.method === 'generate' && c.id === 'C2').length, 1, '上限停止後は自動で再試行しない');
  await f.controller.resume();
  assert.equal(get(f).phase, 'incomplete'); assert.equal(get(f).error.code, 'BUDGET_EXCEEDED'); assert.equal(paid, 1, '手動再開もサービスの上限確認を通る');
  available = true; await f.controller.resume();
  assert.equal(get(f).phase, 'review'); assert.equal(paid, 2);
  assert.equal(f.calls.filter(c => c.method === 'generate' && c.id === 'C1').length, 1, '完成したコードを再生成しない');
  assert.deepEqual(get(f).artifacts[0], before.artifacts[0]); assert.equal(f.count('plan'), 1); assert.equal(f.count('apply'), 0);
});


for (const outcome of ['unverified', 'declined']) test('後続の資料相談が利用上限で止まっても既存の' + outcome + 'を再生成しない', async () => {
  const f = fixture(Workspace, { generate: ({ customization }) => {
    if (outcome === 'declined') throw Object.assign(Error('declined'), { code: 'GENERATION_DECLINED' });
    return generated(customization, { state: 'unverified' });
  } });
  await build(f);
  f.services.propose = async () => { throw Object.assign(Error('budget'), { code: 'BUDGET_EXCEEDED' }); };
  await f.controller.send('資料を作って', { requestPurpose: 'document' });
  const before = get(f), counts = ai(f), screen = html(before);
  assert.equal(before.error.code, 'BUDGET_EXCEEDED'); assert.equal(before.phase, 'incomplete');
  assert.equal(Workspace.creationStateOf(before).kind, outcome);
  assert.doesNotMatch(screen, /data-release-action="resume"/);
  assert.match(screen, /data-release-action="focus-consultation"/);
  assert.equal(await f.controller.resume(), false); assert.deepEqual(ai(f), counts);
  assert.deepEqual(get(f).artifacts, before.artifacts);
});
