'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { KTReleaseSettingsExport: Export } = require('../src/release-settings-export.js');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { makeEnvGetter } = require('./helpers/dev-base-fake.js');
const clone = value => JSON.parse(JSON.stringify(value));
const options = environment => ({ environment, domain: 'example.cybozu.com', savedAt: '2026-10-28T02:30:00Z', appId: '398' });
function raw(revision, label) {
  const values = {
    fields: { properties: { memo: { code: 'memo', label, type: 'SINGLE_LINE_TEXT', required: false } } },
    layout: { layout: [{ type: 'ROW', fields: [{ type: 'SINGLE_LINE_TEXT', code: 'memo' }] }] },
    views: { views: { all: { id: '1', name: label, type: 'LIST', fields: ['memo'], sort: 'memo asc' } } },
    status: { enable: false, states: null, actions: null },
    generalNotify: { notifications: [], notifyToCommenter: false }, perRecordNotify: { notifications: [] },
    reminderNotify: { notifications: [], timezone: 'Asia/Tokyo' },
    appAcl: { rights: [] }, recordAcl: { rights: [] }, fieldAcl: { rights: [] },
    settings: { name: label, description: '', enableComments: false, numberPrecision: { digits: '16', decimalPlaces: '4', roundingMode: 'HALF_EVEN' } },
    reports: { reports: {} }, actions: { actions: {} },
    customize: { scope: 'ALL', desktop: { js: [{ type: 'FILE', file: { name: 'main.js', fileKey: label + '-key', size: '10', contentType: 'text/javascript' } }], css: [] }, mobile: { js: [], css: [] } },
    appPlugins: { plugins: [] }, adminNotes: { content: '', includeInTemplateAndDuplicates: false }
  };
  for (const value of Object.values(values)) value.revision = revision;
  return values;
}
function base() {
  return { env: 'preview', appId: '398', status: 'OK', loadedAt: '2026-10-28T02:00:00Z', revision: { production: '10', preview: '12' },
    data: { appId: '398' }, productionData: { appId: '398' },
    comparisonInputs: { production: raw('10', '運用の備考'), preview: raw('12', 'テストの備考') }, errors: [],
    files: [{ env: 'preview', kind: 'js', text: 'REGISTERED_BODY', sourceAvailable: true }],
    productionFiles: [{ env: 'production', kind: 'js', text: 'PRODUCTION_BODY', sourceAvailable: true }],
    localEdits: [{ text: 'LOCAL_DRAFT' }], apiToken: 'AUTH_TOKEN', connection: { token: 'CONNECTION_TOKEN' } };
}
function deepFreeze(value) { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(deepFreeze); } return value; }

test('指定した環境だけを保存し、取得元・取得日時・設定版を残す', () => {
  for (const env of ['production', 'preview']) {
    const b = base(), result = Export.create(b, options(env)), doc = JSON.parse(result.text);
    assert.equal(doc.source.environment, env); assert.equal(doc.source.domain, 'example.cybozu.com');
    assert.equal(doc.source.appId, '398'); assert.equal(doc.source.revision, env === 'preview' ? '12' : '10');
    assert.equal(doc.source.capturedAt, '2026-10-28T02:00:00.000Z'); assert.equal(doc.savedAt, '2026-10-28T02:30:00.000Z');
    assert.deepEqual(doc.settings.fields, b.comparisonInputs[env].fields);
    assert.equal(result.complete, true); assert.equal(doc.coverage.length, 16);
    assert.match(result.filename, new RegExp('398-' + env + '-r' + doc.source.revision));
    assert.equal(result.text.includes(env === 'preview' ? '運用の備考' : 'テストの備考'), false);
  }
});
test('登録情報・順序と省略可能な一般設定を残し、本文・手元編集・認証を保存しない', () => {
  const b = base(); b.comparisonInputs.preview.fields.authorization = 'TRANSPORT_SECRET';
  b.comparisonInputs.preview.settings.headers = { Authorization: 'HEADER_SECRET' };
  b.comparisonInputs.preview.apiTokens = { tokens: ['UNSUPPORTED_SECRET'] };
  b.comparisonInputs.preview.fields.properties.apiToken = { type: 'SINGLE_LINE_TEXT', code: 'apiToken', label: '通常のフィールド' };
  const result = Export.create(b, options('preview'));
  assert.deepEqual(result.document.settings.customize.desktop, b.comparisonInputs.preview.customize.desktop);
  assert.deepEqual(result.document.settings.settings.numberPrecision, b.comparisonInputs.preview.settings.numberPrecision);
  assert.equal(result.document.settings.settings.enableComments, false);
  assert.equal(result.document.settings.fields.properties.apiToken.label, '通常のフィールド', 'フィールドコードを秘密情報と誤解しない');
  assert.doesNotMatch(result.text, /REGISTERED_BODY|PRODUCTION_BODY|LOCAL_DRAFT|AUTH_TOKEN|CONNECTION_TOKEN|TRANSPORT_SECRET|HEADER_SECRET|UNSUPPORTED_SECRET/);
  assert.match(result.document.description, /完全なバックアップではなく/);
  assert.ok(result.document.notIncluded.some(text => text.includes('ファイル本体')));
});
test('取得不能と空の設定を分け、失敗した応答の残骸は保存しない', () => {
  const b = base(); delete b.comparisonInputs.preview.adminNotes;
  b.errors = [{ env: 'preview', what: 'views', message: 'PRIVATE_SERVER_ERROR' }];
  const result = Export.create(b, options('preview'));
  assert.equal(result.complete, false); assert.equal(result.document.settings.adminNotes, undefined);
  assert.equal(result.document.settings.views, undefined); assert.deepEqual(result.document.settings.reports.reports, {});
  assert.deepEqual(result.unavailable.map(row => row.id), ['views', 'notes']);
  assert.doesNotMatch(result.text, /PRIVATE_SERVER_ERROR/);
});
test('反対環境が取得不能・版混在でも選んだ環境の保存を妨げない', () => {
  const b = base(); b.comparisonInputs.production.views.revision = '999';
  b.productionData = { appId: 'other-app' }; b.errors = [{ env: 'production', what: 'fields' }];
  assert.equal(Export.create(b, options('preview')).document.source.revision, '12');
  const other = base(); other.ok = false; other.status = 'FETCH_FAILED'; other.data = null;
  delete other.comparisonInputs.preview.fields; other.errors = [{ env: 'preview', what: 'fields', core: true }];
  assert.equal(Export.create(other, options('production')).document.source.revision, '10');
});
test('選択環境の設定版が混在した場合はファイルを作らない', () => {
  const b = base(); b.comparisonInputs.preview.views.revision = '13';
  assert.throws(() => Export.create(b, options('preview')), { code: 'SETTINGS_EXPORT_STALE' });
  const c = base(); c.revision.preview = '14';
  assert.throws(() => Export.create(c, options('preview')), { code: 'SETTINGS_EXPORT_STALE' });
});
test('中断・未完了・別アプリ・別環境の情報を保存しない', () => {
  for (const mutate of [b => b.stale = true, b => b.paused = true, b => b.status = 'loading', b => b.status = 'CANCELLED']) {
    const b = base(); mutate(b); assert.throws(() => Export.create(b, options('preview')), { code: 'SETTINGS_EXPORT_STALE' });
  }
  for (const mutate of [b => b.env = 'production', b => b.data.appId = '399', b => b.data.env = 'production']) {
    const b = base(); mutate(b); assert.throws(() => Export.create(b, options('preview')), { code: 'SETTINGS_EXPORT_SOURCE' });
  }
  assert.throws(() => Export.create(base(), { ...options('preview'), appId: '400' }), { code: 'SETTINGS_EXPORT_SOURCE' });
});
test('読み取れた一部の設定だけでも、その範囲を明記して保存できる', () => {
  const b = base(); b.revision.preview = null; delete b.comparisonInputs.preview.fields;
  const result = Export.create(b, options('preview'));
  assert.equal(result.document.source.revision, '12'); assert.equal(result.complete, false);
  assert.equal(result.unavailable[0].id, 'fields');
});
test('権限で一部が見えないアプリアクションを完全取得としない', () => {
  const b = base(); b.comparisonInputs.preview.actions.actions.send = { id: '2', name: '送る', destApp: null, mappings: null };
  const result = Export.create(b, options('preview'));
  assert.equal(result.document.settings.actions.actions.send.destApp, null);
  assert.equal(result.document.coverage.find(row => row.id === 'actions').status, 'partial');
  assert.equal(result.complete, false);
});
test('不正な応答は未取得にし、対象が何もなければ保存しない', () => {
  const b = base(); b.comparisonInputs.preview.customize.desktop.js = null;
  let result = Export.create(b, options('preview'));
  assert.equal(result.document.settings.customize, undefined);
  assert.equal(result.document.coverage.find(row => row.id === 'customize').status, 'unavailable');
  b.comparisonInputs.preview = {};
  assert.throws(() => Export.create(b, options('preview')), { code: 'SETTINGS_EXPORT_UNAVAILABLE' });
});
test('元の基準と選択肢を変更せず、同じ入力から同じファイルを作る', () => {
  const b = deepFreeze(base()), args = deepFreeze(options('preview')), before = JSON.stringify(b);
  const first = Export.create(b, args), second = Export.create(b, args);
  assert.equal(first.text, second.text); assert.equal(JSON.stringify(b), before);
});
test('出どころを確認できない保存要求には理由付きで失敗する', () => {
  assert.throws(() => Export.create(base(), options('other')), { code: 'SETTINGS_EXPORT_ENVIRONMENT' });
  assert.throws(() => Export.create(base(), { ...options('preview'), domain: 'https://user:secret@example.cybozu.com/' }), { code: 'SETTINGS_EXPORT_SOURCE' });
  assert.throws(() => Export.create({ ...base(), loadedAt: 'invalid' }, options('preview')), { code: 'SETTINGS_EXPORT_SOURCE' });
  assert.throws(() => Export.create(base(), { ...options('preview'), savedAt: 'invalid' }), { code: 'SETTINGS_EXPORT_SOURCE' });
});
test('製品の取得結果から運用と動作テストの設定を分けて保存できる', async () => {
  const T = loadToolkit(), production = { fields: { memo: { code: 'memo', label: '運用', type: 'MULTI_LINE_TEXT' } }, settings: { name: '保存用', description: '' } }, preview = clone(production);
  preview.fields.memo.label = 'テスト';
  const b = await T.KTDevBase.loadForRelease({ appId: '398', ...makeEnvGetter({ production, preview }) });
  const p = Export.create(b, options('production')), t = Export.create(b, options('preview'));
  assert.equal(p.document.settings.fields.properties.memo.label, '運用');
  assert.equal(t.document.settings.fields.properties.memo.label, 'テスト');
  assert.ok(p.unavailable.some(row => row.id === 'notes'));
});
