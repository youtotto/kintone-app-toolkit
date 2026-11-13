'use strict';
// Presentation only, with locally collected synthetic settings and no services.
const test = require('node:test'), assert = require('node:assert/strict');
const { KTBusinessConsultation: B } = require('../src/release-business-consultation.js');
const { KTBusinessConsultationView: V } = require('../src/release-business-consultation-view.js');
const F = require('./helpers/business-fixture.js');
const scope = { domain: 'fixture.cybozu.com', appId: '310' };
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function fixture({ selected = null, legacy = false, reference = false, environment = 'production' } = {}) {
  const { s } = await F.snapshot({ environment }), analysis = legacy ? F.output(s) : F.workflowOutput(s);
  if (!legacy) {
    const second = F.clone(analysis.rules[0]);
    Object.assign(second, { ruleId: 'R2', stageName: '期限を確認する', processStateId: null });
    second.questions[0].question = '期限は誰が確認しますか。';
    analysis.rules.push(second);
  }
  const doc = { id: 'focus-analysis', title: '業務工程の整理', kind: 'business-understanding', snapshot: s, businessUnderstanding: analysis,
    sourceScope: { ...scope, environment: s.environment, revision: s.revision, snapshotId: s.snapshotId, startedAt: s.startedAt, completedAt: s.completedAt } };
  if (reference) Object.assign(doc, { kind: undefined, sections: [], unknowns: ['運用は未確認'] });
  const h = await B.create(doc, scope, selected);
  return { h, state: { businessContext: h, businessMode: 'understand', businessSelectedIds: [], businessAnswerDrafts: {}, businessResult: null } };
}
const render = (state, disabled = false) => V.render(state, { canConsultBusiness: true }, disabled);
function detailsWithClass(html, className) {
  const opening = new RegExp('<details\\b[^>]*class="[^"]*\\b' + className + '\\b[^"]*"[^>]*>').exec(html);
  assert.ok(opening, className);
  let depth = 1, end = opening.index + opening[0].length;
  for (const match of html.slice(end).matchAll(/<\/?details\b[^>]*>/g)) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return { opening: opening[0], html: html.slice(opening.index, end + match.index + match[0].length) };
  }
  assert.fail('Unclosed details: ' + className);
}
function detailsDepthAt(html, marker) {
  const at = html.indexOf(marker); assert.ok(at >= 0, marker);
  return [...html.slice(0, at).matchAll(/<\/?details\b[^>]*>/g)].reduce((depth, m) => depth + (m[0].startsWith('</') ? -1 : 1), 0);
}
const panels = html => [...html.matchAll(/data-release-panel="(business-consultation-[^"]+)"/g)].map(m => m[1]);

test('工程の概要と全詳細を相談・照合・回答フォームより先に表示し、原本と送信範囲を変えない', async () => {
  const { h, state } = await fixture(), before = F.clone(h), wireBefore = B.wire(h), html = render(state);
  assert.equal(detailsDepthAt(html, 'class="ktr-business-source-summary ktr-note"'), 0);
  assert.ok(html.indexOf('class="ktr-business-source-summary ktr-note"') < html.indexOf('class="ktr-business-workflow-source"'));
  assert.ok(html.includes('分析の取得元：運用環境・アプリ 310・設定の版 22・取得日時 ' + h.sourceScope.completedAt));
  assert.match(html, /class="ktr-business-workflow-source"/); assert.match(html, /相談する範囲：全工程（2件）/);
  assert.doesNotMatch(html, /相談の元になった業務工程|元の分析にある工程全体を表示しています/);
  assert.ok(html.indexOf('ktr-workflow-overview') < html.indexOf('<h3>業務分析を使った相談</h3>'));
  assert.ok(html.indexOf('data-workflow-rule="R2"') < html.indexOf('class="ktr-business-source"'));
  assert.ok(html.indexOf('data-workflow-rule="R2"') < html.indexOf('data-business-input="source:R1:0"'));
  for (const r of h.analysis.rules) {
    for (const text of [r.stageName, r.inference, r.trigger.interpretation, r.nextAction.interpretation, ...r.inputs.map(x => x.interpretation), ...r.notifications.map(x => x.interpretation)]) assert.ok(html.includes(esc(text)), text);
    for (const ref of r.evidenceRefs) assert.ok(html.includes('data-business-evidence="' + ref.evidenceId + '"'));
  }
  assert.deepEqual(h, before); assert.deepEqual(B.wire(h), wireBefore);
});

test('一工程の相談でも元の全工程は参考表示し、選択と運用記録による送信範囲を説明する', async () => {
  const { h, state } = await fixture({ selected: 'R2' }), before = F.clone(h), html = render(state);
  assert.match(html, /選択工程：R2 期限を確認する/);
  assert.match(html, /表示は元の工程全体です。相談の中心は上記の選択工程です。送信時は選択工程と、添付する運用記録の参照工程を使います/);
  assert.ok(html.includes('data-workflow-rule="R1"')); assert.ok(html.includes('data-workflow-rule="R2"'));
  assert.equal(V.questions(state).length, 1); assert.ok(html.includes('data-business-input="source:R2:0"'));
  assert.ok(!html.includes('data-business-input="source:R1:0"'));
  assert.deepEqual(B.wire(h).analysis.rules.map(r => r.ruleId), ['R2']); assert.deepEqual(h, before);
});

test('工程分析の対象環境は現在画面の環境を推測せず、保存された取得元を常時表示', async () => {
  for (const [environment, label] of [['production', '運用環境'], ['preview', '動作テスト環境']]) {
    const { h, state } = await fixture({ environment }), html = render(state);
    const line = /<p class="ktr-business-source-summary ktr-note">([^<]+)<\/p>/.exec(html);
    assert.ok(line); assert.equal(line[1], '分析の取得元：' + label + '・アプリ 310・設定の版 22・取得日時 ' + h.sourceScope.completedAt);
    assert.equal(detailsDepthAt(html, line[0]), 0);
    assert.ok(html.indexOf(line[0]) < html.indexOf('ktr-workflow-overview'));
  }
});

test('添付した運用記録が別工程を参照する場合も、選択工程だけを送信するとは表示しない', async () => {
  const { h, state } = await fixture({ selected: 'R2' });
  state.businessContext = B.record(h, { kind: 'current_operation', text: '申請内容を確認した後に期限を確認します。', sourceRuleRefs: [B.ruleRef(h, 'R1')] });
  const before = F.clone(state), html = render(state), wire = B.wire(state.businessContext);
  assert.match(html, /相談の中心は上記の選択工程/); assert.match(html, /添付する運用記録の参照工程を使います/);
  assert.doesNotMatch(html, /AIへ渡す工程は上記の選択工程だけ/);
  assert.deepEqual(wire.analysis.rules.map(r => r.ruleId), ['R1', 'R2']);
  assert.deepEqual(wire.selection, { type: 'rule', ruleId: 'R2' });
  assert.deepEqual(V.questions(state).map(q => q.questionId), ['source:R2:0']);
  assert.deepEqual(state, before);
});

test('任意質問は親と個別detailsを閉じて開始し、質問ID・下書き・全記録操作を保持', async () => {
  const { h, state } = await fixture(), q = V.questions(state)[0], prefix = h.analysisId + ':' + h.analysisHash + ':';
  state.businessAnswerDrafts[prefix + q.questionId] = '<未保存の回答>&';
  state.businessAnswerDrafts[prefix + 'relation:' + q.questionId] = 'corrects';
  state.businessAnswerDrafts['other-analysis:' + q.questionId] = '別分析の下書き';
  const before = F.clone(state), html = render(state), group = detailsWithClass(html, 'ktr-business-questions');
  assert.doesNotMatch(group.opening, /\sopen(?:\s|>)/); assert.match(group.html, /詳しく確認する（2件・任意）/);
  assert.match(group.html, /未回答の項目は未確認のまま保持/);
  const individuals = [...group.html.matchAll(/<details class="ktr-business-question"[^>]*>/g)];
  assert.equal(individuals.length, 2); individuals.forEach(m => assert.doesNotMatch(m[0], /\sopen(?:\s|>)/));
  assert.ok(group.html.includes('&lt;未保存の回答&gt;&amp;')); assert.ok(!group.html.includes('別分析の下書き'));
  assert.match(group.html, /value="corrects" selected/);
  for (const item of V.questions(state)) {
    assert.ok(group.html.includes('data-business-input="' + item.questionId + '"'));
    const actionPattern = new RegExp('data-release-action="business-record" data-release-id="' + item.questionId + '"', 'g');
    assert.equal([...group.html.matchAll(actionPattern)].length, 4);
    for (const value of [item.text, item.purpose]) assert.ok(group.html.includes(esc(value)));
  }
  assert.deepEqual(panels(render(state)), panels(html), 'stable IDs survive redraws despite workflow SVG IDs changing');
  assert.deepEqual(state, before);
});

test('仮案・計画の確認質問を任意と表示せず、回答内容と保存操作は同じまま保持', async () => {
  const { state } = await fixture();
  state.businessResult = { blocks: [], statementDrafts: [], questions: [
    { questionId: 'optional', text: '任意の確認', purpose: '説明の補足', blockingFor: 'none' },
    { questionId: 'proposal', text: '希望の対象を確認', purpose: '仮案の対象', blockingFor: 'proposal' },
    { questionId: 'plan', text: '変更条件を確認', purpose: '計画の前提', blockingFor: 'plan' }
  ] };
  const html = render(state), optional = detailsWithClass(html, 'ktr-business-questions');
  assert.match(html, /仮案・計画に進む前の確認（2件）/);
  assert.match(html, /<summary>仮案に進む前：希望の対象を確認<\/summary>/);
  assert.match(html, /<summary>計画に進む前：変更条件を確認<\/summary>/);
  assert.match(optional.html, /1件・任意/); assert.ok(!optional.html.includes('data-business-input="proposal"')); assert.ok(!optional.html.includes('data-business-input="plan"'));
  for (const id of ['optional', 'proposal', 'plan']) assert.ok(html.includes('data-business-input="' + id + '"'));
});

test('個人別権限の未確認と追加入力は折りたたまれず、照合と安全ゲートは維持', async () => {
  const { h, state } = await fixture();
  h.freshness = { status: 'changed', acknowledged: false, rows: [{ comparison: 'history', category: 'process', status: 'changed' }] };
  state.businessReviewRequired = true; state.businessMode = 'improve';
  const before = F.clone(state), html = render(state, true), source = detailsWithClass(html, 'ktr-business-source');
  assert.equal(detailsDepthAt(html, 'class="ktr-business-unverified"'), 0);
  assert.equal(detailsDepthAt(html, '<legend>運用の説明・変更希望を追加する</legend>'), 0);
  assert.doesNotMatch(source.opening, /\sopen(?:\s|>)/); assert.match(source.html, /取得状態と元の根拠/);
  for (const action of ['check', 'ack', 'close']) assert.match(source.html, new RegExp('data-release-action="business-' + action + '"[^>]* disabled'));
  assert.match(source.html, /分析時→現在 \/ process：変更あり/); assert.match(source.html, /差分と未確認範囲を確認しました/);
  assert.match(html, /採用時の前提を再確認するまで、案の再開・反映を止めています/);
  assert.match(html, /data-release-action="business-send"[^>]* disabled/); assert.deepEqual(state, before);
});

test('旧ルールと参考資料の相談を維持し、工程図を捏造しない', async () => {
  for (const options of [{ legacy: true, selected: 'R1' }, { reference: true }]) {
    const { h, state } = await fixture(options), before = F.clone(h), html = render(state);
    assert.doesNotMatch(html, /class="ktr-business-workflow-source"/); assert.match(html, /業務分析を使った相談/);
    assert.equal(detailsDepthAt(html, 'class="ktr-business-source-summary ktr-note"'), 0);
    assert.ok(html.indexOf('class="ktr-business-source-summary ktr-note"') < html.indexOf('<h3>業務分析を使った相談</h3>'));
    assert.ok(html.includes('分析の取得元：運用環境・アプリ 310・設定の版 22・取得日時 ' + h.sourceScope.completedAt));
    assert.match(html, /個人別の実効権限/); assert.match(html, /data-business-input="new"/);
    if (options.legacy) { assert.match(html, /選択ルール：R1/); assert.match(html, /1件・任意/); }
    else assert.match(html, /参考資料の記述です。設定の取得状態は未確認/);
    assert.deepEqual(h, before);
  }
});

test('相談応答と確認待ち記録を失わず表示し、任意文字列をHTMLにしない', async () => {
  const { state } = await fixture();
  state.businessResult = { blocks: [{ kind: 'inference', text: '<img src=x onerror=bad()>', ruleRefs: [], evidenceRefs: [], statementRefs: [], messageRefs: [] }], questions: [], statementDrafts: [{ kind: 'current_operation', text: '<未保存の提案>' }] };
  const html = render(state);
  assert.match(html, /&lt;img src=x onerror=bad\(\)&gt;/); assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /確認待ち：現在の運用 \/ &lt;未保存の提案&gt;/); assert.match(html, /data-release-action="business-draft"/);
  assert.ok(html.indexOf('data-workflow-rule="R2"') < html.indexOf('&lt;img src=x'));
  assert.doesNotMatch(html, /class="ktr-business-questions"/);
});

test('参照元が不正な場合は工程を再表示せず、未確認表示と解除操作を残す', async () => {
  const { state } = await fixture(); state.businessInvalid = '参照が変わりました';
  const html = render(state); assert.match(html, /相談の参照元を確認できません/);
  assert.doesNotMatch(html, /class="ktr-business-workflow-source"/);
  assert.equal(detailsDepthAt(html, 'class="ktr-business-source-summary ktr-note"'), 0);
  assert.equal(detailsDepthAt(html, 'class="ktr-business-unverified"'), 0);
  assert.match(html, /data-release-action="business-close"/);
});
