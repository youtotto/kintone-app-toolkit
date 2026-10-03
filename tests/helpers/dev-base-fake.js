// Phase 21: KTDevBase.load 用の fake。kintone の REST GET（/k/v1/preview/... = 動作テスト環境、/k/v1/... = 運用環境）と
// ファイルのダウンロード（fileKey → 本文）を、2 つの DATA（prefetchAppData と同じ形）から返す。
//   fail: { 'preview:app/status': Error, ... } で個別の GET を失敗させる。calls / downloads に呼び出しを記録する
'use strict';
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

function makeEnvGetter({ preview, production, files = {}, revisions = { preview: '12', production: '10' }, fail = {} } = {}) {
  const calls = [], downloads = [];
  const MAP = {
    'app/form/fields': (d) => ({ properties: clone(d.fields || {}) }),
    'app/form/layout': (d) => ({ layout: clone(d.layout || []) }),
    'app/views': (d) => ({ views: clone(d.views?.views || {}) }),
    'app/status': (d) => clone(d.status || { enable: false, states: null, actions: null }),
    'app/notifications/general': (d) => clone(d.generalNotify || { notifications: [], notifyToCommenter: false }),
    'app/notifications/perRecord': (d) => clone(d.perRecordNotify || { notifications: [] }),
    'app/notifications/reminder': (d) => clone(d.reminderNotify || { notifications: [], timezone: 'Asia/Tokyo' }),
    'app/actions': (d) => clone(d.actions || { actions: {} }),
    'app/customize': (d) => clone(d.customize || { scope: 'ALL', desktop: { js: [], css: [] }, mobile: { js: [], css: [] } }),
    'app/settings': (d) => clone(d.settings || { name: 'app' }),
    'app/acl': (d) => clone(d.appAcl || { rights: [] }),
    'record/acl': (d) => clone(d.recordAcl || { rights: [] }),
    'field/acl': (d) => clone(d.fieldAcl || { rights: [] }),
    'app/reports': (d) => clone(d.reports || { reports: {} }),
    'app/plugins': (d) => clone(d.appPlugins || { plugins: [] }),
  };
  const getImpl = async (path, params) => {
    calls.push(path);
    const m = /^\/k\/v1\/(preview\/)?(.+)$/.exec(path);
    if (!m) throw Object.assign(new Error('bad path ' + path), { code: 'TEST' });
    const env = m[1] ? 'preview' : 'production';
    const key = m[2];
    const f = fail[`${env}:${key}`];
    if (f) throw f;
    const d = env === 'preview' ? preview : production;
    const fn = MAP[key];
    if (!fn) throw Object.assign(new Error('unknown path ' + path), { code: 'TEST' });
    return { ...fn(d), revision: String(revisions[env]) };
  };
  const download = async (fileKey) => {
    downloads.push(fileKey);
    if (fail[`file:${fileKey}`]) throw fail[`file:${fileKey}`];
    if (!Object.prototype.hasOwnProperty.call(files, fileKey)) throw Object.assign(new Error('ファイルが見つかりません ' + fileKey), { code: 'GAIA_IL23', status: 404 });
    return files[fileKey];
  };
  return { getImpl, download, calls, downloads };
}

/** customize の 1 件（FILE） */
const fileEntry = (fileKey, name, text) => ({ type: 'FILE', file: { fileKey, name, size: String(Buffer.byteLength(text, 'utf8')), contentType: 'text/javascript' } });

module.exports = { makeEnvGetter, fileEntry };
