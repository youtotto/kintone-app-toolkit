// 設定取得の API の回数を数える偽の kintone（tests/panel-minimized-fetch.test.js 用）。
//   kintone.api（REST）・kintone.app.getFormFields / getFormLayout・kintone.system.getPermissions（JS API）・fetch（/k/v1/file.json と同じオリジンの URL）を
//   呼ばれた順に calls へ { kind: 'rest' | 'js' | 'fetch', method, path } で積み、fixture（tests/fixtures/ai-context-app.js の makeData と同じ形）から答える。
//   path は URL のホスト・クエリ・.json を落とした形（/k/v1/preview/app/customize など）。
//   hold(正規表現) は、一致した要求を受け付けたまま返さない門を作る（release() で返す）。取得の途中で最小化する場面を作るのに使う
//   kintone.proxy（AI の Gateway への通信。設定取得ではない）は { kind: 'proxy', method, path } で積む。gateway(method, path, body) → { status, body } を渡すとその応答を返す
'use strict';

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

function makeFakeKintone(data, { admin = true, appId = 310, layout = null, gateway = null } = {}) {
  const calls = [];
  const holds = [];
  const norm = (u) => String(u).replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '').replace(/\.json$/, '');
  const rev = { revision: '5' };
  const LAYOUT = layout || [{ type: 'ROW', fields: [{ type: 'SINGLE_LINE_TEXT', code: 'case_name' }] }];
  const resp = (p, params) => {
    const key = p.replace(/^\/k\/v1\/(preview\/)?/, '');
    switch (key) {
      case 'app/views': return { views: clone(data.views?.views || {}), ...rev };
      case 'app/reports': return { reports: clone(data.reports?.reports || {}), ...rev };
      case 'app/status': return { ...clone(data.status || { enable: false }), ...rev };
      case 'app/notifications/general': return { ...clone(data.generalNotify || { notifications: [] }), ...rev };
      case 'app/notifications/perRecord': return { ...clone(data.perRecordNotify || { notifications: [] }), ...rev };
      case 'app/notifications/reminder': return { ...clone(data.reminderNotify || { notifications: [] }), ...rev };
      case 'app/customize': return { ...clone(data.customize || { scope: 'ALL', desktop: { js: [], css: [] }, mobile: { js: [], css: [] } }), ...rev };
      case 'app/acl': case 'record/acl': case 'field/acl': return { rights: [], ...rev };
      case 'app/actions': return { ...clone(data.actions || { actions: {} }), ...rev };
      case 'plugins': return { plugins: [] };
      case 'app/settings': return { ...clone(data.settings || { name: 'app' }), ...rev };
      case 'app/plugins': return { plugins: [], ...rev };
      case 'app': return { appId: String(params.id), name: `App${params.id}`, code: '' };
      case 'app/form/fields': return { properties: String(params.app) === String(appId) ? clone(data.fields) : {}, ...rev };
      case 'app/form/layout': return { layout: clone(LAYOUT), ...rev };
      case 'apps': return { apps: (params.ids || []).map(id => ({ appId: String(id), name: `App${id}` })) };
      case 'records': return { records: [] };
      case 'app/deploy': return { apps: [{ app: String(appId), status: 'SUCCESS' }] };
      default: throw Object.assign(new Error('unknown ' + p), { code: 'TEST' });
    }
  };
  /** 一致した要求を受け付けたまま返さない門 */
  const hold = (re) => {
    let open;
    const p = new Promise((r) => { open = r; });
    const h = { re, p, released: false, sent: 0, release() { h.released = true; open(); } };
    holds.push(h);
    return h;
  };
  const waitHold = async (path) => {
    const h = holds.find(x => !x.released && x.re.test(path));
    if (h) { h.sent += 1; await h.p; }
  };
  const api = async (url, method, params) => {
    const p = norm(url);
    calls.push({ kind: 'rest', method, path: p });
    await waitHold(p);
    if (method !== 'GET') return {};
    return resp(p, params || {});
  };
  api.url = (p) => (/\.json$/.test(p) ? p : p + '.json');
  const kintone = {
    api,
    app: {
      getId: () => appId,
      getFormFields: async () => { const p = 'kintone.app.getFormFields'; calls.push({ kind: 'js', path: p }); await waitHold(p); return clone(data.fields); },
      getFormLayout: async () => { const p = 'kintone.app.getFormLayout'; calls.push({ kind: 'js', path: p }); await waitHold(p); return clone(LAYOUT); },
    },
    system: { getPermissions: async () => { const p = 'kintone.system.getPermissions'; calls.push({ kind: 'js', path: p }); await waitHold(p); return admin; } },
    getRequestToken: () => 'tok',
    proxy: async (url, method, headers, body) => {
      const p = norm(url);
      calls.push({ kind: 'proxy', method, path: p });
      if (typeof gateway === 'function') { const r = gateway(method, p, body); return [r.body, r.status, {}]; }
      return ['{}', 200, {}];
    },
  };
  const fetch = async (url, opt = {}) => {
    const p = norm(url);
    calls.push({ kind: 'fetch', method: (opt && opt.method) || 'GET', path: p });
    await waitHold(p);
    return { ok: true, status: 200, text: async () => '(function(){ "use strict"; })();', json: async () => ({}) };
  };
  /** 設定取得の API（レコードと書き込みを除く REST の GET・JS API・本文の取得） */
  const isSettings = (c) => (c.kind === 'rest' && c.method === 'GET' && c.path !== '/k/v1/records')
    || c.kind === 'js'
    || (c.kind === 'fetch' && c.method === 'GET' && (c.path === '/k/v1/file' || /^\/[^/]/.test(c.path)));
  const settingsCalls = (from = 0) => calls.slice(from).filter(isSettings);
  const otherCalls = (from = 0) => calls.slice(from).filter(c => !isSettings(c));
  /** path ごとの回数（表示用） */
  const byPath = (list) => { const m = {}; for (const c of list) { const k = `${c.kind === 'js' ? 'JS API' : c.kind === 'fetch' ? 'fetch' : c.method} ${c.path}`; m[k] = (m[k] || 0) + 1; } return m; };
  return { kintone, fetch, calls, hold, settingsCalls, otherCalls, byPath, isSettings };
}

module.exports = { makeFakeKintone };
