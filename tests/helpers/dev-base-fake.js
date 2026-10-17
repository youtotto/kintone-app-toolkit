// Phase 21: KTDevBase.load 用の fake。kintone の REST GET（/k/v1/preview/... = 動作テスト環境、/k/v1/... = 運用環境）と
// ファイルのダウンロード（fileKey → 本文）を、2 つの DATA（prefetchAppData と同じ形）から返す。
//   fail: { 'preview:app/status': Error, ... } で個別の GET を失敗させる。calls / downloads に呼び出しを記録する
'use strict';
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/** REST の GET のパス（/k/v1/ の後ろ）→ prefetchAppData と同じ形のデータからの応答 */
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

function makeEnvGetter({ preview, production, files = {}, revisions = { preview: '12', production: '10' }, fail = {} } = {}) {
  const calls = [], downloads = [];
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

/**
 * 簡素化（2026-10-17）: 画面（mountAiWorkspace）は作業の基準の読み込み（loadDevBase）が必須（本体の入口と同じ。読み込みが無ければ基準を取得できなかったのと同じ）。
 *   画面のテストに渡す読み込みを作る。動作テスト環境 = 偽の kintone（mockRef() の api の GET。反映・登録の後の今の状態）。偽の kintone が無ければ運用環境と同じデータ。
 *   運用環境 = production のデータ（関数なら呼ぶたびに読む）。本文は偽の kintone の downloadFile（無ければ見つからない）
 * @param {object} T loadToolkit() の戻り値（KTDevBase を使う）
 * @param {{ appId: string, production: object|Function, mockRef?: Function|null, now?: Function }} o
 */
function devBaseLoaderOf(T, { appId, production, mockRef = null, now = () => new Date('2026-10-09T00:00:00Z').getTime() } = {}) {
  return async () => {
    const prod = (typeof production === 'function' ? production() : production) || {};
    const mock = typeof mockRef === 'function' ? mockRef() : null;
    const api = mock && mock.api ? mock.api : null;
    const PREV = api ? {
      'app/form/fields': () => api.getPreviewFields(appId), 'app/form/layout': () => api.getPreviewLayout(appId), 'app/views': () => api.getPreviewViews(appId),
      'app/status': () => api.getPreviewStatus(appId), 'app/notifications/general': () => api.getPreviewGeneralNotifications(appId),
      'app/notifications/perRecord': () => api.getPreviewPerRecordNotifications(appId), 'app/notifications/reminder': () => api.getPreviewReminders(appId),
      'app/actions': () => api.getPreviewActions(appId), 'app/customize': () => api.getPreviewCustomize(appId),
    } : null;
    const getImpl = async (path) => {
      const mm = /^\/k\/v1\/(preview\/)?(.+)$/.exec(path);
      if (!mm) throw Object.assign(new Error(`bad path ${path}`), { code: 'TEST' });
      const key = mm[2];
      if (mm[1] && PREV && PREV[key]) return PREV[key]();
      const fn = MAP[key];
      if (!fn) throw Object.assign(new Error(`unknown path ${path}`), { code: 'TEST' });
      return { ...fn(prod), revision: '1' };
    };
    const download = async (fileKey) => {
      if (api && typeof api.downloadFile === 'function') return api.downloadFile(fileKey);
      throw Object.assign(new Error('ファイルが見つかりません ' + fileKey), { code: 'GAIA_IL23', status: 404 });
    };
    return T.KTDevBase.load({ appId, getImpl, download, now });
  };
}

/**
 * 画面の組み立ての引数（mountAiWorkspace の d）に、作業の基準の読み込みを足す（すでに loadDevBase があればそのまま）。
 *   動作テスト環境は d.executor.api（偽の kintone）の今の状態、運用環境は d.getInputs() のデータ。appId は d.executor.appId（無ければ '1'）
 * @param {object} T loadToolkit() の戻り値、または { KTDevBase }
 */
function withDevBase(T, d) {
  if (d && typeof d.loadDevBase === 'function') return d;
  const api = d && d.executor && d.executor.api ? d.executor.api : null;
  const appId = String((d && d.executor && d.executor.appId) ?? '1');
  return { ...d, loadDevBase: devBaseLoaderOf(T, { appId, production: () => ((d && typeof d.getInputs === 'function' ? d.getInputs() : null) || {}).data || {}, mockRef: api ? () => ({ api }) : null }) };
}

/** customize の 1 件（FILE） */
const fileEntry = (fileKey, name, text) => ({ type: 'FILE', file: { fileKey, name, size: String(Buffer.byteLength(text, 'utf8')), contentType: 'text/javascript' } });

module.exports = { makeEnvGetter, devBaseLoaderOf, withDevBase, fileEntry };
