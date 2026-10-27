'use strict';
// Selected identifiers + existing Deps/JS Scanner only; all service responses are fixed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { KTReleaseWorkspace: W } = require('../src/release-workspace.js');
const { KTReleaseContext: C } = require('../src/release-context.js');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { fixture, proposal, plan, deferred, clone } = require('./helpers/release-workspace-fixture.js');
const { response: explanation } = require('./helpers/release-explanation-fixture.js');
const T = loadToolkit();
const eventName = 'app.record.edit.submit';
const select = (type = 'field', id = 'amount', extra = {}) => ({ type, id, name: type === 'field' ? '古い表示名' : id, appId: '310', environment: 'preview', ...extra });
const source = (event = eventName, direct = true) => direct
  ? "kintone.events.on('" + event + "', function(event){event.record.amount.value = 1; return event;});"
  : "const eventName = '" + event + "'; kintone.events.on(eventName, function(event){event.record.amount.value = 2; return event;});";
const file = (name, target = 'desktop', text = source()) => ({ name, target, type: 'FILE', env: 'preview', fileKey: target + '-' + name, sourceAvailable: true, text });
function base(revision = 1) {
  const files = [file('first.js'), file('second.js', 'desktop', source(eventName, false)), file('first.js', 'mobile', source('mobile.app.record.edit.submit'))];
  return { ok: true, appId: '310', env: 'preview', loadedAt: '2026-10-27T01:0' + revision + ':00Z', stamp: 'preview:' + revision, revision: { preview: String(revision) }, files,
    data: { fields: { amount: { code: 'amount', label: '金額' + revision, type: 'NUMBER' },
      total: { code: 'total', label: '合計', type: 'CALC', expression: 'amount * 2' },
      items: { code: 'items', label: '明細', type: 'SUBTABLE', fields: { qty: { code: 'qty', label: '数量', type: 'NUMBER' } } } },
      layout: [], status: { enable: false, states: {}, actions: [] }, views: { views: { 一覧: { name: '一覧', fields: ['amount'], sort: 'amount asc', filterCond: '' } } },
      customize: { scope: 'ALL', desktop: { js: files.filter(f => f.target === 'desktop').map(f => ({ type: 'FILE', file: { name: f.name, fileKey: f.fileKey } })), css: [] },
        mobile: { js: files.filter(f => f.target === 'mobile').map(f => ({ type: 'FILE', file: { name: f.name, fileKey: f.fileKey } })), css: [] } } } };
}
const tools = { analyze: T.KTDevBase.analyze, factFromEdge: T.KTContext.factFromEdge };
function setup({ explain = false, propose = null } = {}) {
  let current = base(); const requests = [], plans = [];
  const f = fixture(W, { loadBase: async () => clone(current), plan: plan({ platforms: [] }),
    propose: args => { requests.push(args); return propose ? propose(args) : explain ? explanation() : proposal(); },
    makePlan: args => { plans.push(args); return { plan: plan({ platforms: [] }) }; } });
  return { ...f, requests, plans, state: () => f.controller.getState(), setBase: b => { current = b; } };
}
const eventFacts = c => c.facts.filter(f => f.kind === 'js-event-reference');
const coverage = c => c.facts.find(f => f.kind === 'dependency-coverage').value;
const context = (b, target, extraTools = tools) => C.proposal({ text: '変更の影響を教えてください', consultationTarget: target, base: b }, extraTools);
const withoutTarget = s => { const copy = clone(s); delete copy.consultationTarget; return copy; };

test('field/event selection and clearing preserve prepared work and never call AI or write', async () => {
  const f = setup(); await f.controller.send('一覧を作成してください'); await f.controller.adopt();
  const before = f.state(), calls = f.calls.length;
  for (const target of [select(), select('event', eventName)]) {
    assert.equal(f.controller.setConsultationTarget({ ...target, source: 'UNSAVED', deps: { bad: true } }), true);
    assert.deepEqual(f.state().consultationTarget, target);
    assert.deepEqual(withoutTarget(f.state()), withoutTarget(before));
    assert.equal(f.calls.length, calls); assert.equal(f.writes.length, 0);
  }
  assert.equal(f.controller.setConsultationTarget(null), true); assert.deepEqual(f.state(), before);
});

test('each send resolves the field code and current label, including a table field, without stale source', async () => {
  const f = setup({ explain: true }); f.controller.setConsultationTarget(select());
  await f.controller.send('このフィールドを変えたときの影響は？');
  assert.equal(f.requests[0].consultationTarget.name, '金額1');
  f.setBase(base(2)); await f.controller.send('一覧と計算式も確認してください');
  assert.equal(f.requests[1].consultationTarget.name, '金額2');
  assert.equal(f.state().consultationTarget.name, '金額2');
  assert.equal(f.requests[1].consultationTarget.revision, '2');
  f.controller.setConsultationTarget(select('field', 'qty')); await f.controller.send('この項目の影響は？');
  assert.equal(f.requests[2].consultationTarget.name, '数量');
  const ctx = C.proposal(f.requests[2], tools);
  assert.equal(ctx.focus.target.type, 'field'); assert.equal(ctx.focus.target.id, 'qty');
  const history = ctx.facts.find(fact => fact.kind === 'consultation-history').value;
  assert.deepEqual(history.map(x => x.target.id), ['amount', 'amount', 'qty']);
  assert.deepEqual(history.map(x => x.target.revision), ['1', '2', '2']);
  assert.ok(!JSON.stringify(ctx).includes('古い表示名'));
  assert.equal(f.count('plan'), 0); assert.equal(f.writes.length, 0);
});

for (const [name, change, code] of [
  ['another app', b => { b.appId = '999'; }, 'CONSULTATION_ENVIRONMENT'],
  ['production environment', b => { b.env = 'production'; }, 'CONSULTATION_ENVIRONMENT'],
  ['deleted field', b => { delete b.data.fields.amount; }, 'CONSULTATION_TARGET_CHANGED'],
  ['ambiguous field', b => { b.data.fields.items.fields.amount = { code: 'amount', label: '金額', type: 'NUMBER' }; }, 'CONSULTATION_TARGET_CHANGED'],
]) test(name + ' cannot send stale selected-field facts to AI', async () => {
  const f = setup(), b = base(); change(b); f.setBase(b); f.controller.setConsultationTarget(select());
  assert.equal(await f.controller.send('変更の影響を確認してください'), false);
  assert.equal(f.requests.length, 0); assert.equal(f.state().error.code, code);
  assert.equal(f.count('plan'), 0); assert.equal(f.writes.length, 0);
});

test('invalid target references do not replace a valid selection; a new conversation clears all targets', async () => {
  const f = setup(); f.controller.setConsultationTarget(select());
  for (const target of [select('field', ''), select('event', eventName, { appId: '' }), select('event', eventName, { environment: 'production' }), select('unexpected')]) {
    assert.equal(f.controller.setConsultationTarget(target), false); assert.deepEqual(f.state().consultationTarget, select());
  }
  await f.controller.send('この項目の変更を提案してください'); f.controller.newTask();
  assert.equal(f.state().consultationTarget, null); assert.equal(f.state().proposalTarget, null); assert.equal(f.state().adoptedTarget, null);
});

test('adoption keeps the proposal field even if a different event was selected later', async () => {
  const f = setup(); f.controller.setConsultationTarget(select()); await f.controller.send('この項目の変更を提案してください');
  f.controller.setConsultationTarget(select('event', eventName)); f.setBase(base(2)); await f.controller.adopt();
  assert.equal(f.plans[0].consultationTarget.type, 'field'); assert.equal(f.plans[0].consultationTarget.id, 'amount');
  const ctx = C.plan(f.plans[0], tools);
  assert.equal(ctx.subject, undefined);
  assert.equal(ctx.facts.find(x => x.kind === 'consultation-target').value.id, 'amount');
  assert.equal(ctx.facts.find(x => x.kind === 'consultation-target').value.name, '金額2');
  assert.equal(f.writes.length, 0);
});

test('asking about impact after preparing an unrelated plan keeps the adopted content and approval', async () => {
  let explain = false;
  const f = setup({ propose: () => explain ? explanation('変更の影響') : proposal() });
  await f.controller.send('一覧を作成してください'); await f.controller.adopt();
  const before = f.state(); explain = true; f.controller.setConsultationTarget(select('event', eventName));
  await f.controller.send('このイベントの変更の影響を説明してください');
  const after = f.state();
  for (const key of ['phase', 'proposal', 'adopted', 'adoptedTarget', 'proposalTarget', 'plan', 'prepared', 'artifacts', 'runs']) assert.deepEqual(after[key], before[key], key);
  assert.equal(after.explanations.length, 1); assert.equal(f.count('plan'), 1); assert.equal(f.writes.length, 0);
});

test('event evidence reuses one fresh scanner pass and distinguishes direct registration from candidates', () => {
  const b = base(), before = clone(b); let count = 0;
  const ctx = context(b, select('event', eventName), { ...tools, analyze: current => { count++; return tools.analyze(current); } });
  const refs = eventFacts(ctx);
  assert.equal(count, 1); assert.equal(refs.length, 2);
  assert.deepEqual(refs.map(f => f.value.file.name), ['first.js', 'second.js']);
  assert.deepEqual(refs.map(f => f.value.direct), [true, false]);
  assert.deepEqual(refs.map(f => f.confidence), ['LIKELY', 'UNCERTAIN']);
  assert.ok(refs.every(f => f.value.event === eventName && f.value.file.target === 'desktop' && f.basis === 'code'));
  for (const f of refs) assert.deepEqual(f.provenance, { environment: 'preview', appId: '310', revision: '1', loadedAt: b.loadedAt });
  assert.equal(coverage(ctx).event.status, 'references-found'); assert.equal(coverage(ctx).event.references, 2);
  assert.ok(coverage(ctx).event.unchecked.some(t => t.includes('非同期')));
  assert.deepEqual(b, before);
  assert.deepEqual(ctx.facts.find(x => x.kind === 'customize').value.desktop.js.map(f => f.file.name), ['first.js', 'second.js']);
  assert.ok(ctx.facts.some(x => x.kind === 'dependency' && x.target?.id?.includes('amount')));
  assert.ok(ctx.facts.filter(x => x.kind === 'js-file').every(x => x.value.source));
});

test('a mobile event resolves only its current mobile source despite identical PC file names', () => {
  const ctx = context(base(), select('event', 'mobile.app.record.edit.submit')), refs = eventFacts(ctx);
  assert.equal(refs.length, 1); assert.equal(refs[0].value.file.target, 'mobile');
  assert.equal(refs[0].value.file.name, 'first.js'); assert.equal(refs[0].value.file.id, 'mobile-first.js');
});

test('changed event references replace stale scan data and never reuse production or cached input', () => {
  const b = base(2), newEvent = 'app.record.create.submit';
  b.scan = { meta: { source: 'production' }, fileEvents: { 'desktop:js:STALE.js': [{ name: eventName, direct: true }] } };
  b.deps = { edges: [{ statement: 'STALE_DEPS' }] };
  b.productionFiles = [file('PRODUCTION_ONLY.js')];
  b.files = [file('current.js', 'desktop', source(newEvent))];
  b.data.customize.desktop.js = [{ type: 'FILE', file: { name: 'current.js', fileKey: 'desktop-current.js' } }];
  const ctx = context(b, select('event', newEvent));
  assert.equal(eventFacts(ctx).length, 1); assert.equal(eventFacts(ctx)[0].value.file.name, 'current.js');
  assert.equal(eventFacts(ctx)[0].provenance.revision, '2');
  assert.ok(!JSON.stringify(ctx).includes('STALE')); assert.ok(!JSON.stringify(ctx).includes('PRODUCTION_ONLY'));
  const missing = context(b, select('event', eventName));
  assert.equal(eventFacts(missing).length, 0); assert.equal(coverage(missing).event.status, 'not-found');
  assert.ok(missing.facts.find(x => x.kind === 'dependency-coverage').statement.includes('依存関係が無い証明ではありません'));
});

test('an event without matching references can still be discussed without asserting absence of impact', async () => {
  const f = setup({ explain: true }); f.controller.setConsultationTarget(select('event', 'app.record.delete.submit'));
  assert.equal(await f.controller.send('削除時の処理に影響がありますか？'), true);
  const ctx = C.proposal(f.requests[0], tools);
  assert.equal(ctx.focus.target.name, 'app.record.delete.submit');
  assert.equal(coverage(ctx).event.status, 'not-found'); assert.equal(f.count('plan'), 0); assert.equal(f.writes.length, 0);
});

test('URL and missing source remain unverified and do not acquire event evidence', () => {
  const b = base(); b.files.push({ name: 'https://example.invalid/external.js', target: 'desktop', type: 'URL', sourceAvailable: false },
    { name: 'missing.js', target: 'mobile', type: 'FILE', sourceAvailable: false });
  const ctx = context(b, select('event', eventName));
  assert.equal(eventFacts(ctx).length, 2); assert.equal(ctx.coverage.javascript, false);
  assert.equal(coverage(ctx).unavailableFiles.length, 2);
  assert.ok(coverage(ctx).unchecked.some(x => x.includes('プラグイン')));
});

for (const mode of ['failure', 'wrong-env', 'wrong-app', 'stale', 'duplicate-file']) test('event evidence rejects ' + mode + ' without replacing unknowns by empty certainty', () => {
  const b = base(); const t = { ...tools, analyze(current) {
    if (mode === 'failure') throw new Error('unavailable');
    tools.analyze(current);
    if (mode === 'wrong-env') current.scan.meta.source = 'production';
    if (mode === 'wrong-app') current.scan.meta.appId = '999';
    if (mode === 'stale') current.scan.meta.scannedAt = 'old';
    if (mode === 'duplicate-file') { current.files.push(clone(current.files[0])); current.scan.files.push(clone(current.scan.files[0])); }
  } };
  const ctx = context(b, select('event', eventName), t);
  if (mode === 'duplicate-file') {
    assert.ok(!eventFacts(ctx).some(f => f.value.file.name === 'first.js'));
    assert.ok(coverage(ctx).event.unchecked.some(x => x.includes('first.js')));
  } else {
    assert.equal(eventFacts(ctx).length, 0); assert.equal(coverage(ctx).event.status, 'unavailable');
  }
});

test('adopted event consultation is present in plan facts, never a javascript subject', async () => {
  const f = setup(); f.controller.setConsultationTarget(select('event', eventName));
  await f.controller.send('このイベントの処理を変更する案にしてください'); await f.controller.adopt();
  const ctx = C.plan(f.plans[0], tools);
  assert.equal(ctx.subject, undefined); assert.equal(ctx.facts.find(x => x.kind === 'consultation-target').value.id, eventName);
  assert.equal(eventFacts(ctx).length, 2);
  assert.equal(ctx.facts.find(x => x.kind === 'consultation-history').value[0].target.type, 'event');
});

test('busy target cannot change and a late cancelled answer cannot replace a subsequent selection', async () => {
  const pending = deferred(), f = setup({ propose: () => pending.promise });
  f.controller.setConsultationTarget(select()); const sending = f.controller.send('変更の影響は？');
  assert.equal(f.controller.setConsultationTarget(select('event', eventName)), false);
  f.controller.cancel(); f.controller.setConsultationTarget(select('event', eventName));
  pending.resolve(explanation()); await sending;
  assert.equal(f.state().consultationTarget.type, 'event'); assert.equal(f.state().explanations.length, 0);
  assert.equal(f.writes.length, 0);
});

test('explicit production file bodies cannot become preview code or event evidence', () => {
  const b = base();
  b.files = [file('foreign.js', 'desktop', source(eventName) + '// FOREIGN_BODY'), file('preview.js')];
  b.files[0].env = 'production';
  b.data.customize.desktop.js = b.files.map(f => ({ type: 'FILE', file: { name: f.name, fileKey: f.fileKey } }));
  const ctx = context(b, select('event', eventName));
  assert.ok(!JSON.stringify(ctx).includes('FOREIGN_BODY'));
  assert.equal(ctx.coverage.javascript, false);
  assert.equal(ctx.facts.find(f => f.kind === 'js-file' && f.value.name === 'foreign.js').value.source, null);
  assert.equal(coverage(ctx).unavailableFiles.find(f => f.name === 'foreign.js').reason, 'environment-mismatch');
  assert.deepEqual(eventFacts(ctx).map(f => f.value.file.name), ['preview.js']);
  assert.ok(!ctx.facts.some(f => f.kind === 'js-reference' && f.source?.name === 'foreign.js'));
});

test('refreshing a proposal target does not rename a different field selected for the next consultation', async () => {
  const p = proposal(); p.proposal.behaviors.push({ id: 'B3', text: '一覧に金額を表示する', origin: 'suggestion' });
  const f = setup({ propose: () => clone(p) });
  f.controller.setConsultationTarget(select()); await f.controller.send('変更を提案してください');
  const ref = { taskId: f.state().taskId, version: f.state().version };
  const next = select('field', 'qty', { name: '数量' });
  f.controller.setConsultationTarget(next);
  f.controller.selectSuggestion('B3', true, ref); f.setBase(base(2));
  await f.controller.updateSuggestions(ref);
  assert.equal(f.requests.at(-1).consultationTarget.name, '金額2');
  assert.deepEqual(f.state().consultationTarget, next);
  assert.equal(f.writes.length, 0);
});
