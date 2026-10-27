'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const oracle = require('./fixtures/config-lens-fa9a942.cjs');
const sources = ['src/vendor/config-lens-compare.js', 'src/release-environment-diff.js'].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
const api = vm.runInNewContext(sources + '\n({lens:KTConfigLensCompare, diff:KTReleaseEnvironmentDiff})');
const { lens, diff } = api;
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const plain = clone;
const field = (code, label = code) => ({ code, label, type: 'SINGLE_LINE_TEXT', required: false });
function raw(revision = '10') {
  const values = { fields: { properties: { memo: field('memo') } }, layout: { layout: [{ type: 'ROW', fields: [{ type: 'SINGLE_LINE_TEXT', code: 'memo' }] }] },
    views: { views: { 一覧: { id: '1', name: '一覧', type: 'LIST', fields: ['memo'], sort: 'memo asc' } } },
    status: { enable: false, states: null, actions: null }, generalNotify: { notifications: [], notifyToCommenter: false },
    perRecordNotify: { notifications: [] }, reminderNotify: { notifications: [], timezone: 'Asia/Tokyo' },
    appAcl: { rights: [] }, recordAcl: { rights: [] }, fieldAcl: { rights: [] }, settings: { name: '比較用', description: '' },
    reports: { reports: {} }, actions: { actions: {} }, customize: { scope: 'ALL', desktop: { js: [], css: [] }, mobile: { js: [], css: [] } },
    appPlugins: { plugins: [] }, adminNotes: { content: '', includeInTemplateAndDuplicates: false } };
  for (const value of Object.values(values)) value.revision = revision;
  return values;
}
function base() {
  return { appId: '398', env: 'preview', ok: true, status: 'ready', loadedAt: '2026-10-28T01:00:00Z',
    revision: { production: '10', preview: '12' }, data: { appId: '398' }, productionData: { appId: '398' },
    comparisonInputs: { production: raw('10'), preview: raw('12') }, files: [], productionFiles: [], errors: [] };
}
function file(key, name = 'main.js', size = '4') { return { type: 'FILE', file: { fileKey: key, name, size, contentType: 'text/javascript' } }; }
function withFiles(oldText, newText) {
  const b = base();
  b.comparisonInputs.production.customize.desktop.js = [file('old')];
  b.comparisonInputs.preview.customize.desktop.js = [file('new')];
  b.productionFiles = [{ env: 'production', target: 'desktop', kind: 'js', type: 'FILE', fileKey: 'old', text: oldText, sourceAvailable: true, hash: 'same-opaque-hash', bytes: 4 }];
  b.files = [{ env: 'preview', target: 'desktop', kind: 'js', type: 'FILE', fileKey: 'new', text: newText, sourceAvailable: true, hash: 'same-opaque-hash', bytes: 4 }];
  return b;
}
const category = (result, id) => result.categories.find(item => item.id === id);
function freeze(value) { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; }

test('Config Lens oracle is the unchanged pinned fa9a942 source; core exported functions are exact extractions', () => {
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/config-lens-fa9a942.cjs'));
  assert.equal(crypto.createHash('sha256').update(bytes.toString('utf8').replace(/\r\n/g,'\n')).digest('hex'), '6727d3363641e416e0c9cc422803448a2cd72d4016607db833a161b2ec26eecb');
  for (const name of ['compareCategory', 'compare', 'changes', 'flatten', 'stable', 'format', 'formatSetting', 'validateResponse']) {
    assert.equal(lens[name].toString().replace(/\r\n/g,'\n'), oracle[name].toString().replace(/\r\n/g,'\n'), name);
  }
  assert.deepEqual(plain(lens.CATEGORIES), oracle.CATEGORIES);
});
test('all 16 categories agree with the original comparison for identical and changed settings', () => {
  for (const item of lens.CATEGORIES) {
    const old = raw()[diff.SOURCE_KEYS[item.id]], current = clone(old); current.revision = '12';
    assert.deepEqual(plain(lens.compareCategory(item, old, current)), plain(oracle.compareCategory(item, old, current)), item.id + ' equal');
    if (item.id === 'fields') current.properties.memo.required = true;
    else if (item.collection) {
      const entry = { [item.key]: 'new', name: '追加' };
      current[item.collection] = Array.isArray(current[item.collection]) ? [entry] : { new: entry };
    } else current[Object.keys(item.shape)[0]] = typeof current[Object.keys(item.shape)[0]] === 'boolean' ? true : 'changed';
    if (item.id === 'layout') current.layout = [];
    if (item.id === 'customize') current.scope = 'ADMIN';
    if (item.id.startsWith('notify')) current.notifications = [{ title: '通知' }];
    if (item.id.startsWith('acl')) current.rights = [{ code: 'memo', entity: { type: 'USER', code: 'user' }, viewable: true }];
    assert.deepEqual(plain(lens.compareCategory(item, old, current)), plain(oracle.compareCategory(item, old, current)), item.id + ' changed');
  }
});
test('fields keep parent changes, option ordering, additions and deletions with exact values', () => {
  const b = base(), before = b.comparisonInputs.production.fields.properties, after = b.comparisonInputs.preview.fields.properties;
  before.obsolete = field('obsolete'); after.extra = field('extra'); after.memo.required = true;
  before.table = { code: 'table', label: '明細', type: 'SUBTABLE', fields: { child: field('child') } };
  after.table = { code: 'table', label: '明細', type: 'SUBTABLE', fields: {} }; after.child = field('child');
  const result = diff.compare(b), fields = category(result, 'fields').entries;
  assert.equal(result.status, 'ok');
  assert.equal(fields.find(row => row.code === 'extra').kind, 'added');
  assert.equal(fields.find(row => row.code === 'obsolete').kind, 'deleted');
  assert.deepEqual(plain(fields.find(row => row.code === 'memo').rows), [{ path: ['required'], before: false, after: true }]);
  assert.deepEqual(plain(fields.find(row => row.code === 'child').rows), [{ path: ['parent'], before: 'table', after: '' }]);
});
test('collection identity uses IDs; same name with a different ID is not silently matched', () => {
  const b = base(); b.comparisonInputs.preview.views.views.一覧.id = '2';
  assert.deepEqual(plain(category(diff.compare(b), 'views').entries.map(row => row.kind)), ['deleted', 'added']);
});
test('arrays retain order and a field called revision is not suppressed', () => {
  const b = base(); b.comparisonInputs.preview.views.views.一覧.fields = ['other', 'memo'];
  b.comparisonInputs.preview.fields.properties.revision = field('revision');
  const result = diff.compare(b);
  assert.equal(category(result, 'views').entries.length, 1);
  assert.equal(category(result, 'fields').entries[0].code, 'revision');
});
test('same text under different download keys is unchanged, while same-size different text is changed', () => {
  assert.equal(category(diff.compare(withFiles('one!', 'one!')), 'customize').entries.length, 0);
  const b = withFiles('one!', 'two!'), result = diff.compare(b), files = category(result, 'customize');
  assert.equal(files.status, 'ok'); assert.equal(files.entries.length, 1);
  const output = JSON.stringify(files);
  assert.doesNotMatch(output, /same-opaque-hash|SHA-256|contentHash|fileKey|one!|two!/);
  assert.match(output, /contentComparison/);
  assert.equal(files.entries[0].before.js[0].file.contentComparison, '取得した本文 1');
  assert.equal(files.entries[0].after.js[0].file.contentComparison, '取得した本文 2');
});
test('file comparison agrees with Lens for exact text equality tokens and ordering changes', () => {
  const b = withFiles('one!', 'two!');
  const a = clone(b.comparisonInputs.production.customize), z = clone(b.comparisonInputs.preview.customize);
  const tokens = new Map([['old', 'body-1'], ['new', 'body-2']]);
  const cat = lens.CATEGORIES.find(row => row.id === 'customize');
  assert.deepEqual(plain(lens.compareCategory(cat, a, z, tokens)), plain(oracle.compareCategory(cat, a, z, tokens)));
});
test('missing, inaccessible, URL and wrong-environment file contents are explicitly partial', () => {
  for (const mutation of [b => { b.files = []; }, b => { b.files[0].sourceAvailable = false; }, b => { b.files[0].env = 'production'; }]) {
    const b = withFiles('one!', 'one!'); mutation(b);
    const result = diff.compare(b); assert.equal(category(result, 'customize').status, 'partial'); assert.equal(result.status, 'partial');
  }
  const b = base(); for (const env of ['production', 'preview']) b.comparisonInputs[env].customize.desktop.js = [{ type: 'URL', url: 'https://example.invalid/main.js' }];
  const result = diff.compare(b); assert.equal(category(result, 'customize').status, 'partial');
  assert.equal(category(result, 'customize').entries.length, 0); assert.match(category(result, 'customize').warnings[0], /URL/);
});
test('CSS and icons are not asserted equal from matching filenames and sizes', () => {
  const b = base();
  for (const env of ['production', 'preview']) {
    b.comparisonInputs[env].customize.desktop.css = [file(env + '-css', 'style.css')];
    b.comparisonInputs[env].settings.icon = file(env + '-icon', 'icon.png');
  }
  const result = diff.compare(b);
  assert.equal(category(result, 'customize').status, 'partial'); assert.equal(category(result, 'general').status, 'partial');
});
test('the same file key in different environments never aliases different text', () => {
  const b = withFiles('one!', 'two!');
  b.comparisonInputs.preview.customize.desktop.js[0].file.fileKey = 'old'; b.files[0].fileKey = 'old';
  assert.equal(category(diff.compare(b), 'customize').entries.length, 1);
});
test('contradictory observations of one file are not accepted as verified content', () => {
  const b = withFiles('one!', 'two!'); b.files.push({ ...b.files[0], text: 'three' });
  assert.equal(category(diff.compare(b), 'customize').status, 'partial');
});
test('missing endpoint and malformed response never mean no changes', () => {
  const b = base(); delete b.comparisonInputs.production.views;
  b.comparisonInputs.preview.appAcl = { revision: '12' };
  const result = diff.compare(b);
  assert.equal(category(result, 'views').status, 'unavailable'); assert.equal(category(result, 'aclApp').status, 'unavailable');
  assert.equal(result.status, 'partial'); assert.equal(result.entries.length, 0);
  assert.equal(diff.toLegacySummary(result).complete, false);
  assert.ok(diff.toLegacySummary(result).reason);
});
test('an explicit endpoint error invalidates a leftover response', () => {
  const b = base(); b.errors = [{ env: 'production', what: 'views', status: 403 }];
  assert.equal(category(diff.compare(b), 'views').status, 'unavailable');
});
test('unavailable action details remain partial, not absent or unchanged', () => {
  const b = base();
  for (const env of ['production', 'preview']) b.comparisonInputs[env].actions.actions.send = { id: '1', name: '送る', destApp: null, mappings: null };
  assert.equal(category(diff.compare(b), 'actions').status, 'partial');
});
test('mixed revisions, interrupted acquisition and wrong app suppress the entire comparison', () => {
  for (const change of [b => { b.comparisonInputs.preview.views.revision = '13'; }, b => { b.comparisonInputs.production.layout.revision = '9'; },
    b => { b.status = 'loading'; }, b => { b.status = 'cancelled'; }, b => { b.stale = true; }, b => { b.data.appId = '999'; }, b => { b.env = 'production'; }]) {
    const b = base(); b.comparisonInputs.preview.fields.properties.new = field('new'); change(b);
    const result = diff.compare(b); assert.equal(result.status, 'stale'); assert.equal(result.entries.length, 0); assert.equal(diff.toLegacySummary(result).available, false);
  }
});
test('old bases without raw responses cannot fabricate an empty comparison', () => {
  const b = base(); delete b.comparisonInputs;
  const result = diff.compare(b); assert.equal(result.status, 'unavailable'); assert.equal(diff.toLegacySummary(result).available, false);
});
test('comparison carries source and never incorporates local unregistered edits or mutates the base', () => {
  const b = withFiles('one!', 'one!'); b.localEdits = [{ fileKey: 'new', text: 'not registered' }];
  const before = JSON.stringify(b); freeze(b);
  const result = diff.compare(b); assert.equal(result.entries.length, 0); assert.equal(JSON.stringify(b), before);
  assert.equal(result.source.appId, '398'); assert.equal(result.source.productionRevision, '10'); assert.equal(result.source.previewRevision, '12');
  assert.equal(result.source.loadedAt, b.loadedAt); assert.doesNotMatch(JSON.stringify(result), /not registered/);
});
test('legacy summary derives only from structured comparison and keeps unknown coverage separate', () => {
  const b = base(); b.comparisonInputs.preview.fields.properties.extra = field('extra'); delete b.comparisonInputs.production.adminNotes;
  const summary = diff.toLegacySummary(diff.compare(b));
  assert.equal(summary.counts.total, 1); assert.equal(summary.counts.byKind.field, 1);
  assert.equal(summary.items[0].change, 'PREVIEW_ONLY'); assert.equal(summary.complete, false); assert.equal(summary.coverage.length, 1);
});

test('AI explanation can receive both registered JS bodies without download keys or local drafts', () => {
  const b = withFiles('one!', 'two!'); b.localEdits = [{ text: 'draft' }];
  const result = diff.compare(b); assert.equal(result.codeChanges.length, 1);
  assert.deepEqual(plain(result.codeChanges[0]), { target: 'desktop', position: 1, kind: 'changed', comparison: 'decoded-text-exact',
    before: { environment: 'production', name: 'main.js', type: 'FILE', contentStatus: 'available', text: 'one!' },
    after: { environment: 'preview', name: 'main.js', type: 'FILE', contentStatus: 'available', text: 'two!' } });
  assert.doesNotMatch(JSON.stringify(result.codeChanges), /fileKey|draft/);
  assert.equal(diff.compare(withFiles('one!', 'one!')).codeChanges.length, 0);
});
test('missing JS bodies are identified as unknown, and stale comparison exposes no bodies', () => {
  const b = withFiles('one!', 'two!'); b.files = [];
  const unknown = diff.compare(b).codeChanges[0];
  assert.equal(unknown.kind, 'unknown'); assert.equal(unknown.after.text, null); assert.equal(unknown.before.text, 'one!');
  b.status = 'loading'; assert.equal(diff.compare(b).codeChanges.length, 0);
});
test('CommonJS consumers load the same comparison core', () => {
  const standalone = require('../src/release-environment-diff.js').KTReleaseEnvironmentDiff;
  assert.deepEqual(plain(standalone.compare(base())), plain(diff.compare(base())));
});
