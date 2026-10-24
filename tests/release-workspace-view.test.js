'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { KTReleaseWorkspace } = require('../src/release-workspace.js');
const { KTReleaseView } = require('../src/release-view.js');
const { fixture, REQUEST, proposal, deferred } = require('./helpers/release-workspace-fixture.js');
const clone = value => JSON.parse(JSON.stringify(value));
const normal = html => String(html).replace(/<details\b[\s\S]*?<\/details>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '');
const decode = value => String(value).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function hostOf() {
  const listeners = new Map();
  let html = '', input = null;
  const host = { ownerDocument: { activeElement: null }, addEventListener(type, fn) { const values = listeners.get(type) || []; values.push(fn); listeners.set(type, values); }, removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter(x => x !== fn)); },
    querySelector: selector => selector === '#kt-release-input' ? input : null,
    querySelectorAll(selector) {
      if (selector !== '[data-release-base-disabled]' && selector !== '[data-release-draft-note]') return [];
      const marker = selector.slice(1, -1), attribute = marker === 'data-release-base-disabled' ? 'disabled' : 'hidden';
      return (html.match(/<[^>]+>/g) || []).filter(tag => tag.includes(marker)).map(original => {
        let tag = original;
        const node = { dataset: { releaseBaseDisabled: /data-release-base-disabled="true"/.test(tag) ? 'true' : 'false' } };
        Object.defineProperty(node, attribute, { get: () => new RegExp('\\s' + attribute + '(?:\\s|>)').test(tag), set(value) {
          const next = tag.replace(new RegExp('\\s' + attribute + '(?=\\s|>)', 'g'), '').replace(/>$/, value ? ' ' + attribute + '>' : '>');
          html = html.replace(tag, next); tag = next;
        } });
        return node;
      });
    },
    async dispatch(type, event = {}) { for (const fn of listeners.get(type) || []) await fn({ type, preventDefault() {}, ...event }); }, listenerCount: type => (listeners.get(type) || []).length };
  Object.defineProperty(host, 'innerHTML', { get: () => html, set(value) { html = String(value); const tag = /<textarea\b[^>]*id="kt-release-input"([^>]*)>([\s\S]*?)<\/textarea>/.exec(html); input = tag ? { id: 'kt-release-input', value: decode(tag[2]), disabled: /\bdisabled\b/.test(tag[1]), selectionStart: 0, selectionEnd: 0, focus() { host.ownerDocument.activeElement = input; }, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; } } : null; } });
  return host;
}
function buttonOf(host, action, id) {
  const tags = String(host.innerHTML).match(/<button\b[^>]*>/g) || [];
  const tag = tags.find(t => t.includes(`data-release-action="${action}"`) && (id == null || t.includes(`data-release-id="${id}"`)));
  assert.ok(tag, `画面に操作 ${action}${id ? ':' + id : ''} がある`);
  return { disabled: /\sdisabled(?:\s|>)/.test(tag), dataset: { releaseAction: action, ...(id ? { releaseId: id } : {}) } };
}
async function click(host, action, id) { const target = buttonOf(host, action, id); assert.equal(target.disabled, false, `操作 ${action} が有効`); await host.dispatch('click', { target }); }
async function type(host, text) { const input = host.querySelector('#kt-release-input'); assert.ok(input); input.value = text; input.focus(); await host.dispatch('input', { target: input }); }
async function mounted(options = {}) {
  const f = fixture(KTReleaseWorkspace, options.fixture || {}), host = hostOf();
  const view = KTReleaseView.create(host, { controller: f.controller, appName: '受入試験用アプリ', ...options.view });
  return { ...f, host, view };
}
async function finishProposal(f) { await type(f.host, REQUEST); await click(f.host, 'send'); await click(f.host, 'adopt'); }

test('相談と入力を残したまま、右の案→変更内容→結果で一度だけ採用・反映する', async () => {
  const f = await mounted();
  assert.match(normal(f.host.innerHTML), /相談すると、ここに案を表示します/);
  assert.match(normal(f.host.innerHTML), /class="ktr-pane-title">相談/);
  await type(f.host, REQUEST); await click(f.host, 'send');
  assert.match(normal(f.host.innerHTML), /承認待ちの一覧を追加する/);
  assert.equal((normal(f.host.innerHTML).match(/data-release-action="adopt"/g) || []).length, 1);
  assert.equal((f.host.innerHTML.match(/id="kt-release-input"/g) || []).length, 1);
  assert.match(normal(f.host.innerHTML), /承認待ちの案件を確認する一覧を追加/);
  assert.equal(f.count('plan'), 0);
  await click(f.host, 'adopt');
  assert.match(normal(f.host.innerHTML), /今回反映する内容/);
  assert.ok(f.host.querySelector('#kt-release-input'));
  assert.equal(f.host.querySelector('#kt-release-input').disabled, false);
  assert.doesNotMatch(f.host.innerHTML, /data-release-action="(?:consult|current)"/);
  assert.equal(f.writes.length, 0);
  await click(f.host, 'apply');
  assert.match(normal(f.host.innerHTML), /動作テスト環境に反映しました/);
  assert.equal((f.host.innerHTML.match(/id="kt-release-input"/g) || []).length, 1);
  assert.equal(f.count('apply'), 1);
  assert.equal(f.writes.length, 3);
});

test('作成後に届いた前提と注意点も通常表示に残し、新しい承認条件にはしない', async () => {
  const f = await mounted();
  await finishProposal(f);
  const state = f.controller.getState();
  state.plan.impact = [{ description: '既存の一覧は変更しません。' }];
  state.plan.customizations[0].risks = ['他の画面には適用しません。'];
  state.artifacts[0].result.assumptions = ['承認済みから差し戻せる運用が前提です。'];
  state.artifacts[0].result.warnings = ['他の画面には適用しません。', '<script>注意</script>'];
  const before = JSON.stringify(state), html = KTReleaseView.render(state), shown = normal(html);
  assert.doesNotMatch(shown, /既存の一覧は変更しません/);
  assert.match(html, /data-release-panel="plan-explanation"><summary>計画の説明を見る<\/summary>[\s\S]*既存の一覧は変更しません/);
  assert.match(shown, /承認済みから差し戻せる運用が前提/);
  assert.equal((shown.match(/他の画面には適用しません/g) || []).length, 1);
  assert.doesNotMatch(shown, /<script>/);
  assert.equal((shown.match(/data-release-action="apply"/g) || []).length, 1);
  assert.equal(JSON.stringify(state), before);
});

test('反映内容の長い見出しや計画の要約を注意点に重ねず、条件と確認事項は残す', async () => {
  const f = await mounted();
  await finishProposal(f);
  const state = f.controller.getState();
  const pc = 'PCの備考を承認済みでは編集不可にし、作成中では編集可能にする。';
  const mobile = 'モバイルの備考を承認済みでは編集不可にし、作成中では編集可能にする。';
  const warning = 'PC・モバイルとも画面上の編集制御です。';
  const confirmation = '既存のJavaScriptの2行を置き換えます。';
  state.prepared.changes = [
    { id: 'C1', kind: 'javascript', title: pc, target: 'desktop', file: 'dealLock.js', operation: 'REPLACE_FILE' },
    { id: 'C2', kind: 'javascript', title: mobile, target: 'mobile', file: 'mobile-approved-field-lock.js', operation: 'REPLACE_FILE' }
  ];
  state.prepared.confirmations = [confirmation];
  state.plan.impact = [{ description: 'dealLock.js：備考の編集制御を追加' }, { description: 'mobile-approved-field-lock.js：備考の編集制御を追加' }, { description: warning }];
  state.plan.customizations[0].requirement = pc;
  state.plan.customizations[1].requirement = mobile;
  state.plan.customizations[0].risks = [warning, confirmation];
  state.plan.customizations[1].risks = [warning];
  state.artifacts[0].result.assumptions = ['PCでは承認済みの場合に適用します。'];
  state.artifacts[1].result.warnings = ['モバイルでは作成中の場合に編集できます。'];
  const before = JSON.stringify(state), html = KTReleaseView.render(state), shown = normal(html);
  assert.equal(shown.split(pc).length - 1, 1);
  assert.equal(shown.split(mobile).length - 1, 1);
  assert.doesNotMatch(shown, /<h4>|備考の編集制御を追加/);
  assert.match(shown, /<h3>前提と注意点<\/h3><ul/);
  assert.equal(shown.split(warning).length - 1, 1, 'a plan explanation must not suppress a visible warning');
  assert.match(shown, /PC・モバイルとも画面上の編集制御です。<\/span><p class="ktr-note">説明元：PC／モバイル/);
  assert.match(shown, /PCでは承認済みの場合に適用します/);
  assert.match(shown, /モバイルでは作成中の場合に編集できます/);
  assert.match(shown, /ktr-confirmations[\s\S]*反映前に確認してください[\s\S]*既存のJavaScriptの2行/);
  assert.equal((shown.match(/data-release-action="apply"/g) || []).length, 1);
  assert.equal(buttonOf({ innerHTML: html }, 'apply').disabled, false);
  assert.equal(JSON.stringify(state), before, 'rendering must not change the prepared signature, decision or confirmations');
});

test('注意の文が対象を言わなくても説明元を残し、同じ画面の変更はファイルで区別する', async () => {
  const f = await mounted();
  await finishProposal(f);
  const state = f.controller.getState();
  state.plan.customizations[0].risks = ['一覧での編集には適用しません。'];
  let shown = normal(KTReleaseView.render(state));
  assert.match(shown, /一覧での編集には適用しません。<\/span><p class="ktr-note">説明元：PC<\/p>/);
  state.plan.customizations[1].platform = ['desktop'];
  state.plan.customizations[1].risks = ['この変更は作成中だけに適用します。'];
  state.artifacts[0].result.targetFile = 'memo-lock.js';
  state.artifacts[1].result.targetFile = 'other-rule.js';
  shown = normal(KTReleaseView.render(state));
  assert.match(shown, /一覧での編集には適用しません。<\/span><p class="ktr-note">説明元：PC：memo-lock.js/);
  assert.match(shown, /この変更は作成中だけに適用します。<\/span><p class="ktr-note">説明元：PC：other-rule.js/);
});

test('注意点がなく計画の説明だけある場合も、空の注意見出しを出さない', () => {
  const state = { phase: 'review', messages: [], runs: [], artifacts: [], plan: { impact: [{ description: '備考の編集制御を追加' }] }, prepared: { ok: true, changes: [], confirmations: [] } };
  const html = KTReleaseView.render(state);
  assert.doesNotMatch(normal(html), /前提と注意点|作成時の補足|備考の編集制御を追加/);
  assert.match(html, /data-release-panel="plan-explanation"/);
  state.plan.impact = [];
  assert.doesNotMatch(KTReleaseView.render(state), /plan-explanation|前提と注意点/);
});

test('確認事項は折りたたみの外に出し、承認操作を増やさない', async () => {
  const f = await mounted({ fixture: { prepare: async ({ base }) => ({ ok: true, changes: [{ title: '備考の編集制御を変更' }], settings: [], files: [], confirmations: ['既存のJavaScriptの2行を置き換えます。'], reasons: [], baseStamp: base.stamp }) } });
  await finishProposal(f);
  const html = normal(f.host.innerHTML);
  assert.match(html, /既存のJavaScriptの2行を置き換えます/);
  assert.equal((html.match(/data-release-action="apply"/g) || []).length, 1);
  assert.doesNotMatch(html, /手順ごとの承認|承認保留却下/);
});

test('承認前に設定の変更前後を開け、JavaScriptは対象と追加・置換を通常の文で区別できる', () => {
  const state = { phase: 'review', messages: [], runs: [], artifacts: [], prepared: { ok: true, changes: [
    { id: 'P1', kind: 'setting', title: '金額を必須入力に変更', description: '入力が無い場合は保存できなくします。', before: { amount: { required: false } }, after: { amount: { required: true } } },
    { id: 'P2', kind: 'setting', title: '一覧を追加', technicalSummary: '表示 memo・絞り込み ステータス in ("承認待ち")', after: { name: '<script>見出し</script>' } },
    { id: 'C1', kind: 'javascript', title: 'PCの備考の編集制御', file: 'approved-memo.js', target: 'desktop', operation: 'REPLACE_FILE' },
    { id: 'C2', kind: 'javascript', title: 'モバイルの備考の編集制御', file: 'mobile-memo.js', target: 'mobile', operation: 'ADD_FILE' }
  ], confirmations: [] } };
  const before = JSON.stringify(state), html = KTReleaseView.render(state), visible = normal(html);
  assert.match(visible, /金額を必須入力に変更[\s\S]*入力が無い場合は保存できなくします/);
  assert.doesNotMatch(visible, /表示 memo|ステータス in/);
  assert.match(html, /表示 memo/);
  assert.match(html, /change-P1[\s\S]*変更前[\s\S]*required&quot;: false[\s\S]*変更後[\s\S]*required&quot;: true/);
  const onlyAfter = html.match(/data-release-panel="change-P2"([\s\S]*?)<\/details>/)[1];
  assert.doesNotMatch(onlyAfter, /変更前/);
  assert.match(onlyAfter, /変更後[\s\S]*&lt;script&gt;見出し/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(visible, /required|変更前|変更後/);
  assert.match(visible, /PC用の「approved-memo.js」を置き換えます/);
  assert.match(visible, /モバイル用の「mobile-memo.js」を追加します/);
  assert.equal(JSON.stringify(state), before);
});

test('計画で必要になった質問と復元前の確認事項を、詳細だけに隠さない', () => {
  const blocked = { phase: 'blocked', error: { code: 'PLAN_QUESTION', message: '確認が必要です。' }, plan: { questions: [{ question: '誰に承認を依頼しますか？', blocking: true }] }, runs: [], messages: [], artifacts: [] };
  assert.match(normal(KTReleaseView.render(blocked)), /誰に承認を依頼しますか/);
  const restoring = { ...blocked, phase: 'rollback-confirm', error: null, rollback: { runId: 'r1', prepared: { ok: true, confirmations: [{ message: 'この反映で追加した一覧を削除します。' }] } }, runs: [{ id: 'r1', prepared: { changes: ['一覧を追加'] } }] };
  assert.match(normal(KTReleaseView.render(restoring)), /この反映で追加した一覧を削除します/);
});

test('変更と検証済みの同一本文が混ざるときは、変更しない内容を区別する', () => {
  const state = { phase: 'review', prepared: { ok: true, changes: ['備考の編集制御を追加'], unchanged: [{ title: '既存の入力チェック', message: '既存の内容と同じため、登録しません。' }] }, messages: [], artifacts: [], runs: [] };
  const html = normal(KTReleaseView.render(state));
  assert.match(html, /今回反映する内容[\s\S]*備考の編集制御を追加/);
  assert.match(html, /変更しない内容[\s\S]*既存の入力チェック：既存の内容と同じため、登録しません/);
});

test('静的な検証だけで完了した成果物を、模擬テストにも通ったとは表示しない', () => {
  const state = { phase: 'review', prepared: { ok: true, changes: ['JavaScriptを追加'] }, messages: [], runs: [], artifacts: [{ customizationId: 'C1', title: '画面の変更', result: { code: '/* verified */', verification: { passed: true, behavior: { status: 'not-run' } }, artifactOutcome: { state: 'ready', message: '検証が完了しました。', operations: [] } } }] };
  const html = KTReleaseView.render(state);
  assert.match(html, /検証が完了しました/);
  assert.match(normal(html), /作成したJavaScriptの検証は完了しています/);
  assert.doesNotMatch(html, /コードの検査と模擬テスト|模擬テスト.{0,8}通過/);
  assert.equal(html.split('検証が完了しました。').length - 1, 1);
});

test('右の変更内容を見ながら入力でき、送信時にだけ承認対象を無効化する', async () => {
  const pending = deferred(), entered = deferred();
  let responses = 0;
  const f = await mounted({ fixture: { propose: async () => { if (++responses === 1) return proposal(); entered.resolve(); return pending.promise; } } });
  await finishProposal(f);
  const before = f.controller.getState().prepared.signature;
  await type(f.host, '一覧の名前を変えてください');
  assert.equal(f.controller.getState().prepared.signature, before);
  assert.equal(f.controller.getState().phase, 'review');
  assert.equal(buttonOf(f.host, 'apply').disabled, true, '未送信の修正を含まない案を反映させない');
  await type(f.host, '');
  assert.equal(buttonOf(f.host, 'apply').disabled, false);
  assert.equal(f.controller.getState().prepared.signature, before);
  await type(f.host, '一覧の名前を変えてください');
  const sent = click(f.host, 'send'); await entered.promise;
  assert.equal(f.controller.getState().phase, 'consulting');
  assert.equal(f.controller.getState().prepared, null);
  assert.doesNotMatch(f.host.innerHTML, /data-release-action="(?:apply|adopt)"/);
  assert.match(normal(f.host.innerHTML), /一覧の名前を変えてください/);
  assert.match(normal(f.host.innerHTML), /承認待ちの一覧を追加します/);
  assert.equal(f.host.querySelector('#kt-release-input').disabled, true);
  pending.resolve(proposal('一覧の名前を変更する仮案です。')); await sent;
  assert.equal(f.controller.getState().phase, 'proposal');
  assert.equal(f.host.querySelector('#kt-release-input').disabled, false);
  assert.equal(f.count('plan'), 1);
  assert.equal(f.count('apply'), 0);
});

test('すべての進行段階で相談と入力は1つ残り、処理中の入力だけ無効になる', () => {
  const messages = [{ id: 1, role: 'user', text: '依頼の内容' }, { id: 2, role: 'assistant', text: '前の返答' }];
  const base = { messages, proposal: proposal().proposal, plan: { customizations: [] }, prepared: { ok: true, changes: [] }, artifacts: [], runs: [] };
  const locked = new Set(['consulting', 'building', 'preparing', 'applying', 'rolling-back']);
  for (const phase of ['idle', 'consulting', 'proposal', 'building', 'preparing', 'review', 'incomplete', 'unchanged', 'blocked', 'applying', 'result', 'rollback-confirm', 'rolling-back']) {
    const host = hostOf(); host.innerHTML = KTReleaseView.render({ ...base, phase });
    assert.equal((host.innerHTML.match(/id="kt-release-input"/g) || []).length, 1, phase);
    assert.equal((host.innerHTML.match(/data-release-action="send"/g) || []).length, 1, phase);
    assert.match(normal(host.innerHTML), /依頼の内容[\s\S]*前の返答/, phase);
    assert.equal(host.querySelector('#kt-release-input').disabled, locked.has(phase), phase);
  }
});

test('再描画で入力中の文字と選択範囲を保持する', async () => {
  const f = await mounted(); await finishProposal(f);
  await type(f.host, '書きかけの修正コメント');
  f.host.querySelector('#kt-release-input').setSelectionRange(2, 7);
  f.view.render();
  const input = f.host.querySelector('#kt-release-input');
  assert.equal(input.value, '書きかけの修正コメント');
  assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 7);
  assert.equal(f.controller.getState().phase, 'review');
});

test('送信前の同意を取り消すと、依頼文を残してAIへ送らない', async () => {
  const f = await mounted({ view: { beforeSend: async () => false } });
  await type(f.host, '残しておく依頼文'); await click(f.host, 'send');
  assert.equal(f.host.querySelector('#kt-release-input').value, '残しておく依頼文');
  assert.equal(f.count('propose'), 0);
});

test('送信の同意待ちでも古い反映を実行できず、取消後は下書きを残す', async () => {
  const waiting = deferred(), entered = deferred(); let confirmations = 0;
  const f = await mounted({ view: { beforeSend: async () => { if (++confirmations === 1) return true; entered.resolve(); return waiting.promise; } } });
  await finishProposal(f); const signature = f.controller.getState().prepared.signature;
  await type(f.host, '反映前に直す内容');
  const sent = click(f.host, 'send'); await entered.promise;
  assert.equal(f.controller.getState().prepared.signature, signature);
  assert.equal(f.controller.getState().phase, 'review');
  assert.equal(buttonOf(f.host, 'apply').disabled, true);
  assert.equal(f.count('propose'), 1);
  waiting.resolve(false); await sent;
  assert.equal(f.host.querySelector('#kt-release-input').value, '反映前に直す内容');
  assert.equal(f.count('apply'), 0); assert.equal(f.count('propose'), 1);
  await type(f.host, ''); assert.equal(buttonOf(f.host, 'apply').disabled, false);
});

test('未送信の修正があると採用・再開・反映・復元を抑止し、判定そのものは変えない', () => {
  const base = { messages: [], proposal: proposal().proposal, plan: { customizations: [] }, prepared: { ok: true, changes: [] }, artifacts: [], runs: [] };
  for (const [phase, action] of [['proposal', 'adopt'], ['incomplete', 'resume'], ['review', 'apply'], ['rollback-confirm', 'rollback']]) {
    const state = { ...base, phase, rollback: { runId: 'r1', prepared: { ok: true } }, runs: [{ id: 'r1', prepared: { changes: [] } }] };
    const original = JSON.stringify(state), host = hostOf();
    host.innerHTML = KTReleaseView.render(state, { draft: '未送信の修正' });
    assert.equal(buttonOf(host, action).disabled, true, phase);
    assert.equal(JSON.stringify(state), original);
  }
});

test('必須の判断は未回答なら採用できず、構造化された回答があれば同じ質問を繰り返さない', () => {
  const base = { phase: 'proposal', proposal: { ...proposal().proposal, decisions: [{ id: 'Q1', label: '承認者', question: '承認者を指定してください', blocking: true, options: ['今の指定を使う'] }] }, messages: [], runs: [], artifacts: [], answers: [] };
  const host = hostOf(); host.innerHTML = KTReleaseView.render(base);
  assert.equal(buttonOf(host, 'adopt').disabled, true);
  host.innerHTML = KTReleaseView.render({ ...base, answers: [{ id: 'Q1', label: '承認者', answer: '今の指定を使う' }] });
  assert.equal(buttonOf(host, 'adopt').disabled, false);
  assert.match(normal(host.innerHTML), /承認者：今の指定を使う/);
  assert.doesNotMatch(normal(host.innerHTML), /承認者を指定してください/);
});

test('未接続または計画の能力が無い場合は採用操作を無効にする', () => {
  const state = { phase: 'proposal', proposal: proposal().proposal, messages: [], runs: [], artifacts: [] };
  const host = hostOf();
  for (const connection of [{ connected: false }, { connected: true, canPlan: false }, { connected: true, available: false }]) {
    host.innerHTML = KTReleaseView.render(state, { connection });
    assert.equal(buttonOf(host, 'adopt').disabled, true);
  }
});

test('既存ファイルへの統合は、追加断片ではなく検証済みの全文を表示・コピー・保存する', async () => {
  const fullBody = "// 既存の入力チェック\n(function(){'use strict';})();\n// 追加した編集制御";
  const state = { phase: 'review', plan: {}, adopted: {}, prepared: { ok: true, changes: ['備考を編集できなくする'], confirmations: [] }, messages: [], runs: [], artifacts: [{ customizationId: 'C1', title: 'PCの備考の編集制御', result: { strategy: 'EXTEND_EXISTING_JS', targetFile: 'existing.js', code: '// 追加した編集制御', body: fullBody, artifactOutcome: { state: 'ready', operations: [{ targetPlatform: 'desktop' }] } } }] };
  const host = hostOf(), copied = [], downloaded = [];
  const view = KTReleaseView.create(host, { controller: { getState: () => clone(state), subscribe: () => () => {} }, onCopy: async value => copied.push(value), onDownload: async (name, value) => downloaded.push([name, value]) });
  assert.match(host.innerHTML, /既存の入力チェック/);
  await click(host, 'copy-code', 'C1'); await click(host, 'download-code', 'C1');
  assert.deepEqual(copied, [fullBody]);
  assert.deepEqual(downloaded, [['existing.js', fullBody]]);
  view.dispose();
});

test('根拠とその設定の詳細は返答ごとに保持し、別の返答へ付け替えない', () => {
  const state = { phase: 'idle', messages: [{ id: 10, role: 'assistant', text: '前の返答', facts: [{ statement: '前の設定だけの事実', value: { name: '承認待ち', marker: '<old>' } }] }, { id: 11, role: 'assistant', text: '新しい返答', facts: [{ text: '新しい設定だけの事実', value: { name: '部長承認待ち', marker: '<new>' } }] }], runs: [], artifacts: [] };
  const html = KTReleaseView.render(state);
  assert.match(html, /data-release-panel="facts-10"[\s\S]*?前の設定だけの事実[\s\S]*?<\/details>/);
  assert.match(html, /data-release-panel="facts-11"[\s\S]*?新しい設定だけの事実[\s\S]*?<\/details>/);
  assert.doesNotMatch(html.match(/data-release-panel="facts-10"([\s\S]*?)<\/details>/)[1], /新しい設定/);
  assert.match(html, /data-release-panel="fact-value-10-0"[\s\S]*?&lt;old&gt;/);
  assert.doesNotMatch(html.match(/data-release-panel="fact-value-10-0"([\s\S]*?)<\/details>/)[1], /部長承認待ち|&lt;new&gt;/);
  assert.match(html, /data-release-panel="fact-value-11-0"[\s\S]*?部長承認待ち/);
  assert.doesNotMatch(html, /<old>|<new>/);
});

test('古い反映記録を開いても現在の作業は変わらず、その記録だけを復元する', async () => {
  const f = await mounted(); await finishProposal(f); await click(f.host, 'apply');
  const first = f.controller.getState().runs[0].id;
  await click(f.host, 'new-task'); await finishProposal(f); await click(f.host, 'apply');
  const second = f.controller.getState().runs[1].id;
  await click(f.host, 'history', first);
  assert.equal(f.controller.getState().runs.at(-1).id, second);
  await click(f.host, 'request-rollback', first);
  assert.equal(f.controller.getState().rollback.runId, first);
  await click(f.host, 'rollback', first);
  assert.deepEqual(f.rollbackWrites, [first]);
  assert.equal(f.controller.getState().runs[1].rollback, undefined);
  assert.match(normal(f.host.innerHTML), /反映前の状態に戻しました/);
  assert.doesNotMatch(normal(f.host.innerHTML), /<h2>動作テスト環境に反映しました/);
});

test('未完了の同じ理由を通常表示へ重複させない', () => {
  const message = '接続が切れたため、モバイル用の作成が完了していません。';
  const state = { phase: 'incomplete', error: { message }, plan: { customizations: [{ customizationId: 'C1', requirement: 'モバイルの編集制御' }] }, artifacts: [{ customizationId: 'C1', title: 'モバイルの編集制御', error: { message } }], runs: [], messages: [] };
  assert.equal(normal(KTReleaseView.render(state)).split(message).length - 1, 1);
});

test('無料の資料とアプリ情報へ、新しいAI作業面から移れる', async () => {
  let free = 0, details = 0;
  const f = await mounted({ view: { onFreeContext: async () => { free++; }, onDetails: async () => { details++; } } });
  await click(f.host, 'free-context'); await click(f.host, 'details');
  assert.equal(free, 1); assert.equal(details, 1); assert.equal(f.count('propose'), 0);
});

test('再描画ごとにイベントを重ねず、破棄すると購読と操作を外す', async () => {
  const f = await mounted();
  f.view.render(); f.view.render();
  assert.equal(f.host.listenerCount('click'), 1);
  assert.equal(f.host.listenerCount('input'), 1);
  f.view.dispose();
  assert.equal(f.host.listenerCount('click'), 0);
  assert.equal(f.host.listenerCount('input'), 0);
});
