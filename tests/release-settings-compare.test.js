'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { KTReleaseSettingsExport: Export } = require('../src/release-settings-export.js');
const { KTReleaseSettingsCompare: Compare } = require('../src/release-settings-compare.js');

const clone = value => JSON.parse(JSON.stringify(value));
const options = { domain: 'fixture.cybozu.com' };
const field = (code, label = code) => ({ type: 'SINGLE_LINE_TEXT', code, label, required: false });
function raw(revision) {
  const values = {
    fields: { properties: { memo: field('memo', '備考') } },
    layout: { layout: [{ type: 'ROW', fields: [{ type: 'SINGLE_LINE_TEXT', code: 'memo' }] }] },
    views: { views: { all: { id: '1', name: '一覧', type: 'LIST', index: '0', fields: ['memo'], sort: 'memo asc' } } },
    status: { enable: false, states: null, actions: null },
    generalNotify: { notifications: [], notifyToCommenter: false },
    perRecordNotify: { notifications: [] },
    reminderNotify: { notifications: [], timezone: 'Asia/Tokyo' },
    appAcl: { rights: [] }, recordAcl: { rights: [] }, fieldAcl: { rights: [] },
    settings: { name: '比較用', description: '', enableComments: false },
    reports: { reports: {} }, actions: { actions: {} },
    customize: { scope: 'ALL', desktop: { js: [], css: [] }, mobile: { js: [], css: [] } },
    appPlugins: { plugins: [] }, adminNotes: { content: '', includeInTemplateAndDuplicates: false }
  };
  for (const value of Object.values(values)) value.revision = revision;
  return values;
}
function base(appId = '398') {
  return { env: 'preview', appId, status: 'OK', ok: true, loadedAt: '2026-10-28T02:00:00Z',
    revision: { production: '10', preview: '12' },
    data: { appId, env: 'preview' }, productionData: { appId, env: 'production' },
    comparisonInputs: { production: raw('10'), preview: raw('12') },
    files: [], productionFiles: [], errors: [] };
}
function saved(b = base(), env = 'preview', domain = options.domain) {
  return Export.create(b, { environment: env, domain, savedAt: '2026-10-28T02:30:00Z' }).document;
}
const parse = doc => Compare.parse(JSON.stringify(doc));
const compare = (doc, b = base(), args = options) => Compare.compare(parse(doc), b, args);
const category = (result, id) => result.categories.find(row => row.id === id);
const coverage = (doc, id) => doc.coverage.find(row => row.id === id);
function file(key, name = 'main.js', type = 'text/javascript') {
  return { type: 'FILE', file: { name, fileKey: key, size: '10', contentType: type } };
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('現在の運用環境から保存ファイルへ比較し、両側の環境と取得日時を保持する', () => {
  const doc = saved(); doc.source.capturedAt = '2026-10-27T01:00:00Z';
  const result = compare(doc);
  assert.equal(result.source.comparisonType, 'saved-settings');
  assert.equal(result.source.crossApp, false);
  assert.equal(result.status, 'ok');
  assert.equal(result.categories.length, 16);
  assert.equal(result.entries.length, 0);
  assert.equal(result.unavailable.length, 0);
  assert.deepEqual(result.codeChanges, []);
  assert.equal(result.source.beforeLabel, '現在の運用環境');
  assert.equal(result.source.afterLabel, '保存ファイル（動作テスト環境）');
  assert.equal(result.source.before.environment, 'production');
  assert.equal(result.source.before.revision, '10');
  assert.equal(result.source.before.capturedAt, '2026-10-28T02:00:00.000Z');
  assert.equal(result.source.after.environment, 'preview');
  assert.equal(result.source.after.revision, '12');
  assert.equal(result.source.after.capturedAt, doc.source.capturedAt);
  assert.equal(result.source.savedAt, doc.savedAt);
  assert.match(result.limitations[0], /運用環境.*左.*保存ファイル.*右/);
  const productionFile = compare(saved(base(), 'production'));
  assert.equal(productionFile.source.before.environment, 'production');
  assert.equal(productionFile.source.after.environment, 'production');
  assert.equal(productionFile.source.afterLabel, '保存ファイル（運用環境）');
  assert.equal(productionFile.entries.length, 0);
});

test('現在側は運用環境固定で、動作テスト環境の差・取得失敗・版混在を混ぜない', () => {
  const doc = saved(), b = base();
  b.comparisonInputs.production.fields.properties.memo.required = true;
  b.comparisonInputs.preview.fields.properties.preview_only = field('preview_only');
  b.comparisonInputs.preview.views.revision = '999';
  b.errors.push({ env: 'preview', what: 'fields', status: 403 });
  b.data.appId = '999';
  for (const args of [options, { ...options, environment: 'preview' }, { ...options, environment: 'production' }]) {
    const result = compare(doc, b, args), fields = category(result, 'fields');
    assert.equal(result.source.before.environment, 'production');
    assert.equal(fields.status, 'ok');
    assert.equal(fields.entries.length, 1);
    assert.deepEqual(fields.entries[0].rows, [{ path: ['required'], before: true, after: false }]);
    assert.equal(category(result, 'views').status, 'ok');
    assert.equal(category(result, 'views').entries.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /preview_only/);
  }
});

test('運用環境から保存ファイルへのフィールド削除・設定変更・配置変更を既存の粒度で残す', () => {
  const doc = saved(), b = base();
  b.comparisonInputs.production.fields.properties.extra = field('extra', '確認メモ');
  b.comparisonInputs.production.fields.properties.memo.required = true;
  b.comparisonInputs.production.layout.layout.push({ type: 'ROW', fields: [{ type: 'SINGLE_LINE_TEXT', code: 'extra' }] });
  const result = compare(doc, b), fields = category(result, 'fields').entries;
  assert.equal(fields.find(row => row.code === 'extra').kind, 'deleted');
  assert.deepEqual(fields.find(row => row.code === 'memo').rows, [{ path: ['required'], before: true, after: false }]);
  assert.equal(category(result, 'layout').entries.length, 1);
});

test('名前が同じでもフィールドコードの変更は追加・削除で、改名と推定しない', () => {
  const doc = saved(), b = base();
  delete b.comparisonInputs.production.fields.properties.memo;
  b.comparisonInputs.production.fields.properties.new_memo = field('new_memo', '備考');
  const entries = category(compare(doc, b), 'fields').entries;
  assert.equal(entries.length, 2);
  assert.equal(entries.find(row => row.code === 'memo').kind, 'added');
  assert.equal(entries.find(row => row.code === 'new_memo').kind, 'deleted');
});

test('保存側の未取得・coverage欠落・設定欠落・壊れた分類は削除として扱わない', () => {
  for (const change of [
    doc => { coverage(doc, 'views').status = 'unavailable'; },
    doc => { doc.coverage = doc.coverage.filter(row => row.id !== 'views'); },
    doc => { delete doc.settings.views; },
    doc => { doc.settings.views.views = null; }
  ]) {
    const doc = saved(); change(doc);
    const result = compare(doc), row = category(result, 'views');
    assert.equal(row.status, 'unavailable');
    assert.equal(row.entries.length, 0);
    assert.ok(row.warnings.length);
    assert.notEqual(result.status, 'ok');
  }
});

test('現在側の取得失敗と残った取得結果は比較不能になり、空設定とは分かれる', () => {
  const b = base(); b.errors.push({ env: 'production', what: 'views', status: 403 });
  let result = compare(saved(), b);
  assert.equal(category(result, 'views').status, 'unavailable');
  assert.equal(category(result, 'views').entries.length, 0);
  assert.match(category(result, 'views').warnings.join(' '), /現在の運用環境/);
  assert.doesNotMatch(category(result, 'views').warnings.join(' '), /保存ファイル/);
  delete b.comparisonInputs.production.adminNotes;
  result = compare(saved(), b);
  assert.equal(category(result, 'notes').status, 'unavailable');
  assert.equal(category(result, 'notes').entries.length, 0);
});

test('取得済みの空の一覧・空のメモは有効な空設定として比較する', () => {
  const doc = saved(), b = base();
  b.comparisonInputs.production.views.views = {};
  const result = compare(doc, b);
  assert.equal(category(result, 'views').status, 'ok');
  assert.equal(category(result, 'views').entries[0].kind, 'added');
  assert.equal(category(result, 'notes').status, 'ok');
  assert.equal(category(result, 'notes').entries.length, 0);
  assert.equal(category(result, 'reports').status, 'ok');
});

test('現在の運用環境が古い・取得途中・版混在なら比較を確定しない', () => {
  for (const change of [
    b => { b.stale = true; },
    b => { b.status = 'loading'; },
    b => { b.status = 'cancelled'; },
    b => { b.comparisonInputs.production.views.revision = '13'; },
    b => { b.productionData.appId = '999'; }
  ]) {
    const b = base(); change(b);
    assert.throws(() => compare(saved(), b));
  }
});

test('別アプリの一覧・グラフ・アクションは一意の同名項目を比較し、IDだけの違いを除く', () => {
  const original = base(), live = base('399');
  const report = { id: '20', name: '集計', index: '0', chartType: 'BAR', groups: [], aggregations: [], sorts: [] };
  const action = { id: '30', name: 'コピー', index: '0', destApp: { app: '900' }, mappings: [] };
  original.comparisonInputs.preview.reports.reports.集計 = report;
  original.comparisonInputs.preview.actions.actions.コピー = action;
  live.comparisonInputs.production.reports.reports.集計 = { ...report, id: '120' };
  live.comparisonInputs.production.actions.actions.コピー = { ...action, id: '130' };
  live.comparisonInputs.production.views.views.all.id = '101';
  const result = compare(saved(original), live);
  assert.equal(result.source.crossApp, true);
  for (const id of ['views', 'reports', 'actions']) {
    assert.equal(category(result, id).status, 'ok');
    assert.equal(category(result, id).entries.length, 0);
  }
});

test('同一アプリでは一覧等のIDによる同一性を維持する', () => {
  const b = base(); b.comparisonInputs.production.views.views.all.id = '101';
  assert.deepEqual(category(compare(saved(), b), 'views').entries.map(row => row.kind), ['deleted', 'added']);
});

test('同じアプリIDでもドメイン違いは別アプリ、ドメインの大文字小文字は同一', () => {
  assert.equal(compare(saved(), base(), { ...options, domain: 'other.cybozu.com' }).source.crossApp, true);
  assert.equal(compare(saved(), base(), { ...options, domain: 'FIXTURE.CYBOZU.COM' }).source.crossApp, false);
});

test('別アプリの同名対応が重複または名称欠落なら無理に対応させない', () => {
  for (const change of [
    b => { b.comparisonInputs.production.views.views.extra = { ...b.comparisonInputs.production.views.views.all, id: '2' }; },
    b => { delete b.comparisonInputs.production.views.views.all.name; }
  ]) {
    const b = base('399'); change(b);
    const row = category(compare(saved(), b), 'views');
    assert.equal(row.status, 'unavailable');
    assert.equal(row.entries.length, 0);
  }
});

test('別アプリの対応済み項目も、並び順や条件など実際の設定差は残す', () => {
  const b = base('399'); b.comparisonInputs.production.views.views.all.id = '101';
  b.comparisonInputs.production.views.views.all.sort = 'memo desc';
  const row = category(compare(saved(), b), 'views');
  assert.equal(row.entries.length, 1);
  assert.equal(row.entries[0].kind, 'changed');
  assert.deepEqual(row.entries[0].rows, [{ path: ['sort'], before: 'memo desc', after: 'memo asc' }]);
});

test('別アプリでも関連先アプリIDやフィールド名のapp・revisionは取り除かない', () => {
  const original = base(), b = base('399');
  const lookup = { type: 'SINGLE_LINE_TEXT', code: 'link', label: '参照', lookup: { relatedApp: { app: '900' }, relatedKeyField: 'key' } };
  original.comparisonInputs.preview.fields.properties.link = clone(lookup);
  b.comparisonInputs.production.fields.properties.link = clone(lookup);
  b.comparisonInputs.production.fields.properties.link.lookup.relatedApp.app = '901';
  b.comparisonInputs.production.fields.properties.app = field('app');
  b.comparisonInputs.production.fields.properties.revision = field('revision');
  const entries = category(compare(saved(original), b), 'fields').entries;
  assert.ok(entries.find(row => row.code === 'link').rows.some(row => row.path.join('.') === 'lookup.relatedApp.app' && row.before === '901' && row.after === '900'));
  assert.equal(entries.find(row => row.code === 'app').kind, 'deleted');
  assert.equal(entries.find(row => row.code === 'revision').kind, 'deleted');
});

test('権限で見えないアクションのコピー先・対応項目は変更扱いにせず、見えている差は残す', () => {
  for (const unavailableSide of ['saved', 'current']) {
    const original = base(), b = base();
    const known = { id: '1', name: '送る', index: '0', destApp: { app: '900' }, mappings: [{ srcType: 'FIELD', srcField: 'memo', destField: 'memo' }] };
    original.comparisonInputs.preview.actions.actions.send = clone(known);
    b.comparisonInputs.production.actions.actions.send = { ...clone(known), index: '1' };
    const hidden = unavailableSide === 'saved' ? original.comparisonInputs.preview.actions.actions.send : b.comparisonInputs.production.actions.actions.send;
    hidden.destApp = null; hidden.mappings = null;
    const row = category(compare(saved(original), b), 'actions');
    assert.equal(row.status, 'partial');
    assert.equal(row.entries.length, 1);
    assert.deepEqual(row.entries[0].rows, [{ path: ['index'], before: '1', after: '0' }]);
    assert.ok(row.warnings.length);
  }
});

test('保存ファイルにJS・CSS・アイコン本文が無いので登録情報が同じでも本文一致とはしない', () => {
  const original = base(), b = base();
  for (const [data, prefix] of [[original.comparisonInputs.preview, 'saved'], [b.comparisonInputs.production, 'current']]) {
    data.customize.desktop.js = [file(prefix + '-js')];
    data.customize.desktop.css = [file(prefix + '-css', 'style.css', 'text/css')];
    data.settings.icon = file(prefix + '-icon', 'icon.png', 'image/png');
  }
  b.productionFiles = [{ type: 'FILE', target: 'desktop', env: 'production', kind: 'js', fileKey: 'current-js', text: 'CURRENT_BODY', sourceAvailable: true }];
  const result = compare(saved(original), b);
  assert.equal(category(result, 'customize').status, 'partial');
  assert.equal(category(result, 'general').status, 'partial');
  assert.equal(result.entries.length, 0);
  assert.deepEqual(result.codeChanges, []);
  assert.doesNotMatch(JSON.stringify(result), /CURRENT_BODY/);
});

test('URL指定のJSは登録URLだけを比較し、配信内容は比較済みにしない', () => {
  const original = base(), b = base();
  original.comparisonInputs.preview.customize.desktop.js = [{ type: 'URL', url: 'https://example.invalid/old.js' }];
  b.comparisonInputs.production.customize.desktop.js = [{ type: 'URL', url: 'https://example.invalid/new.js' }];
  const row = category(compare(saved(original), b), 'customize');
  assert.equal(row.status, 'partial');
  assert.equal(row.entries.length, 1);
  assert.match(JSON.stringify(row.entries), /old\.js/);
  assert.match(JSON.stringify(row.entries), /new\.js/);
});

test('異なる形式・版・壊れたJSON・容量超過を受け付けない', () => {
  assert.equal(Compare.MAX_BYTES, 10 * 1024 * 1024);
  assert.throws(() => Compare.parse('{'));
  assert.throws(() => Compare.parse('[]'));
  assert.throws(() => Compare.parse(' '.repeat(Compare.MAX_BYTES + 1)));
  for (const change of [
    doc => { doc.format = 'another-format'; },
    doc => { doc.formatVersion = 2; },
    doc => { delete doc.settings; },
    doc => { delete doc.coverage; },
    doc => { delete doc.source; },
    doc => { delete doc.savedAt; }
  ]) {
    const doc = saved(); change(doc); assert.throws(() => parse(doc));
  }
});

test('取得元を特定できないファイルとincluded設定の版混在を拒否する', () => {
  for (const change of [
    doc => { doc.source.domain = 'https://user:secret@example.com/'; },
    doc => { doc.source.appId = ''; },
    doc => { doc.source.environment = 'other'; },
    doc => { doc.source.capturedAt = 'invalid'; },
    doc => { doc.source.revision = null; },
    doc => { doc.savedAt = 'invalid'; },
    doc => { doc.settings.views.revision = '999'; }
  ]) {
    const doc = saved(); change(doc); assert.throws(() => parse(doc));
  }
});

test('coverageの重複・未知の状態・分類とkeyの不一致を拒否する', () => {
  for (const change of [
    doc => { doc.coverage.push(clone(doc.coverage[0])); },
    doc => { doc.coverage[0].status = 'probably'; },
    doc => { coverage(doc, 'views').key = 'fields'; }
  ]) {
    const doc = saved(); change(doc); assert.throws(() => parse(doc));
  }
});

test('比較は保存ファイル・現在設定・手元編集を変更せず、手元コードを混ぜない', () => {
  const doc = saved(), b = base();
  b.localEdits = [{ text: 'UNREGISTERED_PRIVATE_BODY' }];
  const beforeDoc = JSON.stringify(doc), beforeBase = JSON.stringify(b);
  freeze(doc); freeze(b);
  const result = Compare.compare(doc, b, options);
  assert.equal(JSON.stringify(doc), beforeDoc);
  assert.equal(JSON.stringify(b), beforeBase);
  assert.doesNotMatch(JSON.stringify(result), /UNREGISTERED_PRIVATE_BODY/);
  assert.deepEqual(result.codeChanges, []);
});

test('識別できないフィールド定義は上書きで変更なしにせず比較不能にする', () => {
  for (const [label, change] of [
    ['異なるキーの同一コード', properties => { properties.other = field('memo', '備考'); }],
    ['キーとコードの不一致', properties => { properties.memo.code = 'other'; }],
    ['テーブル内外のコード重複', properties => {
      properties.details = { type: 'SUBTABLE', code: 'details', label: '明細', fields: { memo: field('memo', '備考') } };
    }],
    ['種類の欠落', properties => { delete properties.memo.type; }],
    ['空の種類', properties => { properties.memo.type = ''; }]
  ]) {
    const doc = saved(); change(doc.settings.fields.properties);
    const result = compare(doc), row = category(result, 'fields');
    assert.equal(row.status, 'unavailable', label);
    assert.equal(row.entries.length, 0, label);
    assert.ok(row.warnings.length, label);
    assert.notEqual(result.status, 'ok', label);
  }
});


test('権限で取得できないルックアップ・関連レコード一覧は削除や一致にせず既知の差だけを残す', () => {
  for (const key of ['lookup', 'referenceTable']) {
    for (const absentSide of ['saved', 'current']) {
      const doc = saved(), b = base();
      const make = () => ({ type: key === 'lookup' ? 'SINGLE_LINE_TEXT' : 'REFERENCE_TABLE', code: 'ref', label: '関連先',
        [key]: { relatedApp: { app: '900', code: '' } } });
      doc.settings.fields.properties.ref = make(); b.comparisonInputs.production.fields.properties.ref = make();
      const missing = absentSide === 'saved' ? doc.settings.fields.properties.ref : b.comparisonInputs.production.fields.properties.ref;
      missing[key] = null;
      b.comparisonInputs.production.fields.properties.ref.label = '新しい表示名';
      const row = category(Compare.compare(parse(doc), b, options), 'fields');
      assert.equal(row.status, 'partial');
      assert.ok(row.warnings.some(warning => warning.includes('ref')));
      const entry = row.entries.find(entry => entry.code === 'ref');
      assert.ok(entry.rows.some(item => item.path[0] === 'label'));
      assert.ok(entry.rows.every(item => item.path[0] !== key));
    }
  }
  const doc = saved(), b = base();
  const table = { type: 'SUBTABLE', code: 'details', label: '明細', fields: { ref: { type: 'SINGLE_LINE_TEXT', code: 'ref', label: '参照', lookup: null } } };
  doc.settings.fields.properties.details = clone(table); b.comparisonInputs.production.fields.properties.details = clone(table);
  const row = category(Compare.compare(parse(doc), b, options), 'fields');
  assert.equal(row.status, 'partial'); assert.equal(row.entries.length, 0);
});
