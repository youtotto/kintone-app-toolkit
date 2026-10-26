'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { makeEnvGetter, fileEntry } = require('./helpers/dev-base-fake.js');
const T = loadToolkit(), C = T.KTReleaseContext;
const clone = x => JSON.parse(JSON.stringify(x));
const field = (code, type = 'NUMBER', extra = {}) => ({ code, label: code, type, ...extra });
const src = code => "kintone.events.on('app.record.edit.show',function(event){event.record['" + code + "'].disabled=true;return event;});";
function data(code = 'amount', target = 'desktop') {
  const text = src(code), js = fileEntry('current-' + code, 'shared.js', text);
  return {
    appId: '310', fields: { amount: field('amount'), memo: field('memo', 'SINGLE_LINE_TEXT'), total: field('total', 'CALC', { expression: code + '*2' }) },
    layout: [], settings: { name: '依存関係確認用' }, views: { views: { 一覧: { id: '1', name: '一覧', type: 'LIST', fields: [code], filterCond: '', sort: '' } } },
    status: { enable: false, states: {}, actions: [] }, generalNotify: { notifications: [] }, perRecordNotify: { notifications: [] }, reminderNotify: { notifications: [] },
    appAcl: { rights: [] }, recordAcl: { rights: [] }, fieldAcl: { rights: [] }, actions: { actions: {} }, reports: { reports: {} }, appPlugins: { plugins: [] },
    customize: { scope: 'ALL', desktop: { js: target === 'desktop' ? [js] : [], css: [] }, mobile: { js: target === 'mobile' ? [js] : [], css: [] } }
  };
}
async function baseOf(options = {}) {
  const preview = options.preview || data(), production = options.production || data('memo');
  const io = makeEnvGetter({ preview, production, files: { 'current-amount': src('amount'), 'current-memo': src('memo'), ...(options.files || {}) }, revisions: options.revisions || { preview: '12', production: '10' }, fail: options.fail || {} });
  const base = await T.KTDevBase.loadForRelease({ appId: '310', getImpl: io.getImpl, download: io.download, now: () => Date.parse(options.at || '2026-10-26T01:00:00Z') });
  return { base, io };
}
const tools = extra => ({ analyze: T.KTDevBase.analyze, factFromEdge: T.KTContext.factFromEdge, ...extra });
const proposal = (base, extra) => C.proposal({ text: 'このアプリを説明し、変更の影響を整理してください。', base }, tools(extra));
const plan = (base, extra) => C.plan({ goal: '金額の変更', proposal: { behaviors: [], assumptions: [], decisions: [], cannot: [] }, base, version: 1 }, tools(extra));
const deps = ctx => ctx.facts.filter(f => ['dependency', 'js-reference'].includes(f.kind));
const coverage = ctx => {
  const f = ctx.facts.find(f => f.kind === 'dependency-coverage');
  assert.ok(f, 'dependency coverage must be an explicit fact');
  return f.value;
};
const targetOf = f => String(f.target?.id || '');
const textOf = value => JSON.stringify(value);

test('proposal and adopted plan reuse existing preview Deps with confidence and provenance', async () => {
  const { base } = await baseOf();
  for (const make of [proposal, plan]) {
    let count = 0;
    const ctx = make(base, { analyze: b => { count++; return T.KTDevBase.analyze(b); } });
    assert.equal(count, 1); assert.equal(ctx.coverage.dependencies, true);
    const all = deps(ctx); assert.ok(all.length >= 3);
    assert.ok(all.some(f => f.relationType === 'DISPLAYS' && f.confidence === 'CERTAIN' && targetOf(f).includes('amount')));
    assert.ok(all.some(f => f.relationType === 'REFERENCES' && f.confidence === 'LIKELY' && targetOf(f).includes('amount')));
    const js = all.find(f => f.source?.type === 'CUSTOMIZE' && targetOf(f).includes('amount'));
    assert.ok(js); assert.equal(js.jsTarget, 'desktop'); assert.notEqual(js.confidence, 'CERTAIN');
    assert.ok(js.lines.length); assert.ok(js.events.includes('app.record.edit.show'));
    for (const f of all) {
      assert.equal(f.provenance.environment, 'preview'); assert.equal(f.provenance.appId, '310');
      assert.equal(f.provenance.revision, '12'); assert.equal(f.provenance.loadedAt, base.loadedAt);
      assert.ok(f.basis); assert.ok(f.source && f.target && f.setting);
    }
    assert.equal(coverage(ctx).revision, '12');
  }
});

test('old global analysis, production body and incoming cache never enter AI dependencies', async () => {
  const { base } = await baseOf();
  base.deps = { nodes: [], edges: [{ sourceName: 'STALE_DEPS_SENTINEL' }], meta: { appNames: { 999: 'STALE_APP_NAME' } } };
  base.scan = { files: [{ text: 'STALE_SCAN_SENTINEL' }] };
  base.incoming = { refs: [{ appId: '999', field: 'STALE_INCOMING_SENTINEL' }] };
  base.data.plugins = [{ name: 'STALE_PLUGIN_SENTINEL' }];
  base.productionData.fields.production_only = field('PRODUCTION_ONLY_SENTINEL');
  const before = textOf(base), ctx = proposal(base, { analyze: b => {
    assert.equal(b.incoming, null); assert.equal(b.deps == null, true); assert.equal(b.scan == null, true);
    assert.equal(b.data.plugins, null); assert.deepEqual(clone(b.data.relatedApps), {});
    assert.equal(b.productionData, undefined); assert.equal(b.productionFiles, undefined);
    return T.KTDevBase.analyze(b);
  } });
  assert.equal(textOf(base), before, 'sending must not mutate the loaded base or old analysis');
  assert.ok(!/STALE_|PRODUCTION_ONLY_SENTINEL/.test(textOf(ctx)));
  assert.equal(ctx.coverage.incoming, false); assert.equal(ctx.coverage.plugins, false);
  assert.ok(!deps(ctx).some(f => f.relationType === 'REFERENCED_BY'));
  assert.ok(deps(ctx).filter(f => f.source?.type === 'CUSTOMIZE').every(f => targetOf(f).includes('amount')));
});

test('each send uses newly read body and does not reuse same-name JavaScript analysis', async () => {
  const a = await baseOf(), b = await baseOf({ preview: data('memo', 'mobile'), at: '2026-10-26T01:05:00Z', revisions: { preview: '13', production: '10' } });
  const first = proposal(a.base), second = proposal(b.base), adopted = plan(b.base);
  assert.ok(deps(first).some(f => f.jsTarget === 'desktop' && targetOf(f).includes('amount')));
  for (const ctx of [second, adopted]) {
    const js = deps(ctx).filter(f => f.source?.type === 'CUSTOMIZE');
    assert.ok(js.length); assert.ok(js.every(f => f.jsTarget === 'mobile' && targetOf(f).includes('memo')));
    assert.ok(js.every(f => f.provenance.revision === '13' && f.provenance.loadedAt === b.base.loadedAt));
  }
});

test('changed graph and field access relations are fresh even when base fingerprint stays equal', async () => {
  const a = await baseOf(), changed = data();
  changed.reports = { reports: { 集計: { id: '2', name: '集計', groups: [{ code: 'memo' }], aggregations: [{ code: 'amount' }] } } };
  changed.fieldAcl = { rights: [{ code: 'memo', entities: [] }] };
  const b = await baseOf({ preview: changed });
  assert.equal(T.KTDevBase.fingerprint(a.base), T.KTDevBase.fingerprint(b.base));
  const first = proposal(a.base), second = proposal(b.base);
  assert.ok(!deps(first).some(f => f.source?.type === 'REPORT'));
  assert.ok(deps(second).some(f => f.source?.type === 'REPORT' && targetOf(f).includes('memo')));
  assert.ok(deps(second).some(f => f.relationType === 'ACL_TARGET' && targetOf(f).includes('memo')));
});

test('missing optional settings and unavailable URL/file bodies remain unknown, not empty or analyzed', async () => {
  const preview = data();
  preview.customize.mobile.js = [{ type: 'URL', url: 'https://example.invalid/external.js' }, fileEntry('missing', 'missing.js', 'unavailable')];
  preview.customize.desktop.css = [fileEntry('style', 'style.css', 'body{}')];
  const { base } = await baseOf({ preview, fail: { 'preview:app/reports': Object.assign(new Error('denied'), { status: 403 }) } });
  const ctx = proposal(base), cv = coverage(ctx);
  assert.equal(ctx.coverage.dependencies, true); assert.equal(ctx.coverage.javascript, false);
  assert.ok(textOf(cv.missingSettings).includes('reports'));
  assert.ok(textOf(cv.unavailableFiles).includes('external.js')); assert.ok(textOf(cv.unavailableFiles).includes('missing.js'));
  assert.ok(Array.isArray(cv.unchecked) && cv.unchecked.length);
  assert.ok(!deps(ctx).some(f => ['external.js', 'missing.js', 'style.css'].includes(f.source?.name)));
  assert.equal(ctx.coverage.incoming, false); assert.equal(ctx.coverage.plugins, false); assert.equal(ctx.coverage.recordData, false);
});

for (const failure of ['throw', 'captured']) test('analysis ' + failure + ' does not fall back to old dependencies', async () => {
  const { base } = await baseOf(); base.deps = { nodes: [], edges: [{ sourceName: 'OLD_EDGE' }] };
  const ctx = proposal(base, { analyze: b => {
    if (failure === 'throw') throw new Error('analysis failed');
    b.analysisError = { code: 'TEST', message: 'analysis failed' }; return b;
  } });
  assert.equal(ctx.coverage.dependencies, false); assert.equal(coverage(ctx).status, 'unavailable');
  assert.equal(deps(ctx).length, 0); assert.ok(!textOf(ctx).includes('OLD_EDGE'));
  assert.ok(textOf(coverage(ctx).unchecked).includes('依存関係の解析結果を取得できませんでした'));
});

test('missing analyzer is reported as unchecked rather than a successful empty result', async () => {
  const { base } = await baseOf(), ctx = C.proposal({ text: '概要', base });
  assert.equal(ctx.coverage.dependencies, false); assert.equal(coverage(ctx).status, 'unavailable'); assert.equal(deps(ctx).length, 0);
});

test('non-preview analysis input is never used as preview evidence', async () => {
  const { base } = await baseOf(); base.env = 'production'; let calls = 0;
  const ctx = proposal(base, { analyze: () => { calls++; throw new Error('must not analyze'); } });
  assert.equal(calls, 0); assert.equal(ctx.coverage.dependencies, false); assert.equal(coverage(ctx).status, 'unavailable'); assert.equal(deps(ctx).length, 0);
});

test('empty analysis still records unchecked boundaries and does not assert complete absence of dependencies', async () => {
  const { base } = await baseOf({ preview: { fields: {}, customize: { desktop: { js: [] }, mobile: { js: [] } } } });
  const ctx = proposal(base), cv = coverage(ctx);
  assert.equal(ctx.coverage.dependencies, true); assert.equal(deps(ctx).length, 0);
  assert.ok(Array.isArray(cv.unchecked) && cv.unchecked.length);
  assert.equal(ctx.coverage.incoming, false);
});

test('dependency input does not silently drop excess facts or oversized results', async () => {
  const { base } = await baseOf();
  const analyzed = () => ({ nodes: [], edges: Array.from({ length: 501 }, (_, i) => ({ sourceType: 'VIEW', sourceId: '' + i, sourceName: '一覧' + i, relationType: 'DISPLAYS', targetType: 'FIELD', targetId: 'amount', targetName: 'amount', context: {}, confidence: 'CERTAIN' })), meta: {} });
  assert.throws(() => proposal(base, { analyze: b => { b.deps = analyzed(); b.scan = { meta: { source: 'preview', scannedAt: b.loadedAt } }; return b; } }), e => e.code === 'CONTEXT_TOO_LARGE');
  const huge = clone(base); huge.data.fields.memo.label = 'a'.repeat(400 * 1024);
  assert.throws(() => proposal(huge), e => e.code === 'CONTEXT_TOO_LARGE');
});

test('release base loading and execution preparation still perform no semantic dependency analysis', async () => {
  const originalDeps = T.KTDeps.buildDependencyData, originalScan = T.KTScan.buildPayload;
  let analyses = 0, scans = 0;
  T.KTDeps.buildDependencyData = (...args) => { analyses++; return originalDeps(...args); };
  T.KTScan.buildPayload = (...args) => { scans++; return originalScan(...args); };
  try {
    const { base, io } = await baseOf();
    assert.equal(analyses, 0); assert.equal(scans, 0);
    assert.equal(T.KTDevBase.currentOf(base).env, 'preview');
    assert.ok(io.calls.length && io.calls.every(p => p.startsWith('/k/v1/')));
    const beforeReads = io.calls.length;
    proposal(base);
    assert.equal(analyses, 1); assert.equal(scans, 1);
    assert.equal(io.calls.length, beforeReads, 'reusing Deps does not fetch settings or other apps again');
  } finally { T.KTDeps.buildDependencyData = originalDeps; T.KTScan.buildPayload = originalScan; }
});



test('related app definitions retain their own production provenance and are not preview dependency inputs', async () => {
  const { base } = await baseOf();
  base.relatedLoadedAt = '2026-10-26T00:59:00Z';
  base.data.relatedApps = { 999: { name: '参照先', fields: { external: field('external') } } };
  const ctx = proposal(base, { analyze: b => {
    assert.deepEqual(clone(b.data.relatedApps), {});
    return T.KTDevBase.analyze(b);
  } });
  const fact = ctx.facts.find(f => f.kind === 'relatedApps');
  assert.ok(fact); assert.equal(fact.provenance.environment, 'production'); assert.equal(fact.provenance.loadedAt, base.relatedLoadedAt);
  assert.ok(fact.statement.includes('同じ時点・同じ環境の情報ではありません'));
  assert.ok(!deps(ctx).some(f => targetOf(f).includes('external')));
});

test('a failed related-app read is not presented as a verified definition', async () => {
  const { base } = await baseOf(); base.data.relatedApps = { 999: { error: { message: 'denied' } } };
  const ctx = proposal(base), fact = ctx.facts.find(f => f.kind === 'relatedApps');
  assert.equal(fact.confidence, 'NOT_ANALYZED');
  assert.equal(fact.provenance.environment, 'production');
});


test('unresolved JavaScript fields and statuses preserve existing evidence without judging execution', async () => {
  const preview = data();
  preview.fields['ステータス'] = field('ステータス', 'STATUS');
  preview.status = { enable: true, states: { 作成中: { name: '作成中', index: '0' } }, actions: [] };
  const source = [
    "kintone.events.on('app.record.edit.show',function(event){",
    "  const record = event.record;",
    "  record['removed_field'].disabled = true;",
    "  if (record['ステータス'].value === '旧ステータス') record.memo.value = '';",
    "  return event;",
    "});"
  ].join('\n');
  preview.customize.desktop.js = [fileEntry('unknown-desktop', 'refs.js', source)];
  preview.customize.mobile.js = [fileEntry('unknown-mobile', 'refs.js', source.replace('app.record.edit.show', 'mobile.app.record.edit.show'))];
  const { base } = await baseOf({ preview, files: { 'unknown-desktop': source, 'unknown-mobile': source.replace('app.record.edit.show', 'mobile.app.record.edit.show') } });
  const expected = clone(base); expected.incoming = null; T.KTDevBase.analyze(expected);
  assert.ok(expected.deps.meta.unknownJsRefs.some(x => x.code === 'removed_field'));
  assert.ok(expected.deps.meta.unknownJsStatuses.some(x => x.value === '旧ステータス'));
  for (const make of [proposal, plan]) {
    const ctx = make(base), fact = ctx.facts.find(f => f.kind === 'js-unresolved-reference');
    assert.ok(fact); assert.equal(fact.basis, 'code'); assert.equal(fact.confidence, 'UNCERTAIN');
    assert.deepEqual(clone(fact.value.fields), clone(expected.deps.meta.unknownJsRefs));
    assert.deepEqual(clone(fact.value.statuses), clone(expected.deps.meta.unknownJsStatuses));
    assert.equal(fact.provenance.environment, 'preview'); assert.equal(fact.provenance.revision, '12');
    assert.equal(fact.provenance.appId, '310'); assert.equal(fact.provenance.loadedAt, base.loadedAt);
    const missing = fact.value.fields.find(x => x.code === 'removed_field'), status = fact.value.statuses.find(x => x.value === '旧ステータス');
    assert.equal(missing.confidence, 'HIGH', 'the original scanner certainty is retained separately from the uncertain impact');
    for (const target of ['desktop', 'mobile']) {
      assert.deepEqual(clone(missing.files.find(f => f.name === target + ':refs.js').lines), [3]);
      assert.deepEqual(clone(status.files.find(f => f.name === target + ':refs.js').lines), [4]);
    }
    for (const key of ['blocking', 'blocked', 'passed', 'verdict', 'canApply', 'requiresChange']) assert.equal(Object.hasOwn(fact, key) || Object.hasOwn(fact.value, key), false);
    assert.ok(fact.statement.includes('実際の動作や変更の必要性は未確認'));
    assert.equal(ctx.coverage.dependencies, true);
  }
  const clean = await baseOf();
  assert.ok(!proposal(clean.base).facts.some(f => f.kind === 'js-unresolved-reference'), 'no empty unresolved-reference fact is added');
});

