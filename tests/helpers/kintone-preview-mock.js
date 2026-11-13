// kintone の動作テスト環境（preview）を模す API モック（KTPlanExecutor のテスト用）。
//   fields / layout / views / アプリの条件通知 / レコードの条件通知 / リマインダー を Map 風に持ち、revision を進める。
//   kintone の挙動に合わせる: 全体置換 API は送った内容で置き換える（既存を含めないと消える）、revision 不一致は GAIA_CO02、
//   権限なしは CB_NO02。ctl で失敗やバグ（既存を 1 件落とす mutant 等）を注入できる。
'use strict';
const clone = (v) => JSON.parse(JSON.stringify(v));

/** kintone の GET /app/status と同じ形に正規化（PRIMARY は executableUser 無し、CREATOR は code null、index は文字列、includeSubs は真偽値） */
function normalizeStatus({ enable, states, actions }) {
  const ns = states ? Object.fromEntries(Object.entries(states).map(([k, v]) => [v.name ?? k, { name: v.name ?? k, index: String(v.index), assignee: { type: v.assignee?.type || 'ONE', entities: (v.assignee?.entities || []).map(e => ({ entity: { type: e.entity.type, code: e.entity.type === 'CREATOR' ? null : e.entity.code }, includeSubs: !!e.includeSubs })) } }])) : states;
  const na = actions ? actions.map(a => ({ name: a.name, from: a.from, to: a.to, filterCond: a.filterCond || '', type: a.type || 'PRIMARY', ...(a.type === 'SECONDARY' ? { executableUser: { entities: (a.executableUser?.entities || []).map(e => ({ entity: { type: e.entity.type, code: e.entity.code }, includeSubs: !!e.includeSubs })) } } : {}) })) : actions;
  return { enable: !!enable, states: ns, actions: na };
}

function makeKintoneMock(data, { permission = true, autoPlace = true, jsSources = [] } = {}) {
  const rowsFrom = (fields) => Object.values(fields).filter(f => !['SUBTABLE', 'GROUP'].includes(f.type)).map(f => ({ type: 'ROW', fields: [{ type: f.type, code: f.code, size: { width: '200' } }] }));
  const st = {
    fields: clone(data.fields), layout: rowsFrom(data.fields), views: clone(data.views?.views || {}),
    general: clone(data.generalNotify?.notifications || []), notifyToCommenter: data.generalNotify?.notifyToCommenter ?? false,
    perRecord: clone(data.perRecordNotify?.notifications || []), reminders: clone(data.reminderNotify?.notifications || []), timezone: data.reminderNotify && Object.prototype.hasOwnProperty.call(data.reminderNotify, 'timezone') && data.reminderNotify.timezone === null ? null : (data.reminderNotify?.timezone || 'Asia/Tokyo'),   // Phase 20: リマインダーを一度も設定していないアプリは null（実機）
    revision: Number(data.views?.revision || 1), prodRevision: Number(data.views?.revision || 1), prodViews: clone(data.views?.views || {}),
    // プロセス管理（Phase 12）: GET /preview/app/status と同じ形（enable / states / actions）。states / actions は PUT で全体置換
    status: data.status ? normalizeStatus({ enable: !!data.status.enable, states: clone(data.status.states || {}), actions: clone(data.status.actions || []) }) : { enable: false, states: null, actions: null },
    // 参照元アプリ（Phase 13）: data.relatedApps と同じ形（appId → { name, code, revision, fields }）。運用環境の GET だけ（書き込み API は無い）
    relatedApps: clone(data.relatedApps || {}),
    // アプリアクション（Phase 14）: GET /preview/app/actions と同じ形（アクション名 → { name, id, index, destApp, mappings, entities, filterCond }）。PUT は全体置換
    actions: clone(data.actions?.actions || {}), actionSeq: 9000,
    // JavaScript / CSS カスタマイズ（Phase 17）: GET / PUT /preview/app/customize と upload / download。
    //   kintone と同じく、取得 API の fileKey（dl:n）は PUT で再指定するとファイルが残り、アップロード API の fileKey（up:n）は PUT で実体化されて別のキー（dl:n）になる
    customize: null, files: new Map(), pending: new Map(), fileSeq: 1,
  };
  {
    const cz = data.customize || { scope: 'ALL', desktop: { js: [], css: [] }, mobile: { js: [], css: [] } };
    const src = (name, target) => (jsSources.find(f => f.name === name && (f.target || 'desktop') === target)?.text ?? '');
    const conv = (list, target, kind) => (list || []).map(e => {
      if (e.type === 'URL') return { type: 'URL', url: e.url };
      const key = e.file?.fileKey || ('dl:' + (st.fileSeq++));
      const content = kind === 'js' ? src(e.file?.name, target) : '';
      st.files.set(key, { name: e.file?.name, size: String(e.file?.size ?? Buffer.byteLength(content, 'utf8')), content, contentType: e.file?.contentType || (kind === 'js' ? 'text/javascript' : 'text/css') });
      return { type: 'FILE', fileKey: key };
    });
    st.customize = { scope: cz.scope || 'ALL', desktop: { js: conv(cz.desktop?.js, 'desktop', 'js'), css: conv(cz.desktop?.css, 'desktop', 'css') }, mobile: { js: conv(cz.mobile?.js, 'mobile', 'js'), css: conv(cz.mobile?.css, 'mobile', 'css') } };
  }
  const calls = [];
  const err = (code, message) => Object.assign(new Error(message), { code, message });
  // mutateList(what, list): 全体置換 API が受け取った一覧を保存直前に書き換える（検証の mutant。what = 'general' | 'perRecord' | 'reminders' | 'views'）
  // sideEffectOnStatusPut: プロセス管理の PUT 後に kintone が自動で一覧 / 通知を足す挙動を模す（Phase 12 §17）
  // relatedUnavailable: 参照元アプリ ID → その参照元の GET は CB_NO02、参照するルックアップの lookup は null（kintone の挙動）/ mutateLookup(lookup): PUT 直前にルックアップ設定を書き換える mutant
  // destUnavailable: コピー先アプリ ID → そのアプリへのアクションの GET は destApp / mappings が null（kintone の挙動）。dropOneExistingOnPut: 'actions' で既存 1 件が抜ける mutant
  // failUpload: 'CSRF' | 'PERMISSION' | 'TOO_LARGE' | 'INVALID' | 'GENERIC'（ファイルのアップロードを失敗させる）/ mutateCustomize(next): PUT 直前にカスタマイズ設定を書き換える mutant / corruptUploaded: 実体化した本文を壊す mutant
  const ctl = { failAddField: null, mangleLabel: false, failPut: null, dropOneExistingOnPut: null, mangleReminderTime: false, onWrite: null, mutateList: null, failDelete: null, sideEffectOnStatusPut: null, relatedUnavailable: null, mutateLookup: null, destUnavailable: null, failUpload: null, mutateCustomize: null, corruptUploaded: false };
  const mutate = (what, list) => (ctl.mutateList ? ctl.mutateList(what, list) : list);
  const guard = () => { if (!permission) throw err('CB_NO02', '権限がありません。'); };
  const checkRev = (revision) => { if (revision != null && revision !== '' && String(revision) !== String(st.revision)) throw err('GAIA_CO02', '指定したリビジョンが最新ではありません。'); };
  const write = (what) => { calls.push(what); if (ctl.onWrite) ctl.onWrite(what); if (ctl.failPut === what.split(' ')[1]) throw err('GAIA_XX', `モックの失敗（${what}）`); };
  const api = {
    // ---- JavaScript / CSS カスタマイズ（Phase 17）----
    async getPreviewCustomize() {
      calls.push('GET customize'); guard();
      const out = (list) => list.map(e => (e.type === 'URL' ? { type: 'URL', url: e.url } : { type: 'FILE', file: { fileKey: e.fileKey, name: st.files.get(e.fileKey)?.name, size: st.files.get(e.fileKey)?.size, contentType: st.files.get(e.fileKey)?.contentType } }));
      const c = st.customize;
      return { scope: c.scope, desktop: { js: out(c.desktop.js), css: out(c.desktop.css) }, mobile: { js: out(c.mobile.js), css: out(c.mobile.css) }, revision: String(st.revision) };
    },
    async uploadFile(name, content, mime = 'text/javascript') {
      calls.push('POST file');
      if (ctl.failUpload === 'CSRF') throw err('GAIA_RE01', 'CSRF token が不正です（__REQUEST_TOKEN__）');
      if (ctl.failUpload === 'PERMISSION' || !permission) throw Object.assign(err('CB_NO02', '権限がありません。'), { status: 403 });
      if (ctl.failUpload === 'TOO_LARGE') throw Object.assign(err('GAIA_FI02', 'ファイルのサイズが上限を超えています'), { status: 413 });
      if (ctl.failUpload === 'INVALID') throw Object.assign(err('GAIA_IL02', 'ファイルが不正です'), { status: 400 });
      if (ctl.failUpload === 'GENERIC') throw err('GAIA_XX', 'モックの失敗（POST file）');
      const key = 'up:' + (st.fileSeq++);
      st.pending.set(key, { name, content: String(content), mime });
      return key;
    },
    async downloadFile(fileKey) {
      calls.push('GET file');
      const f = st.files.get(fileKey);
      if (!f) throw Object.assign(err('GAIA_IL23', 'ファイルが見つかりません（アップロード直後のキーはダウンロードできません）'), { status: 404 });
      return f.content;
    },
    async putPreviewCustomize(app, body, revision) {
      write('PUT customize'); guard(); checkRev(revision);
      if (body.scope != null && !['ALL', 'ADMIN', 'NONE'].includes(body.scope)) throw err('GAIA_IL02', 'scope が不正です');
      const next = { scope: body.scope ?? st.customize.scope, desktop: { js: [], css: [] }, mobile: { js: [], css: [] } };
      for (const t of ['desktop', 'mobile']) for (const k of ['js', 'css']) {
        const list = body[t]?.[k];
        if (list == null) { next[t][k] = clone(st.customize[t][k]); continue; }
        if (list.length > 30) throw err('GAIA_IL04', 'ファイルは30個までです（' + t + '.' + k + '）');
        next[t][k] = list.map(e => {
          if (e.type === 'URL') { if (!String(e.url).startsWith('https://')) throw err('GAIA_IL02', 'url は https が必要です'); return { type: 'URL', url: e.url }; }
          if (e.type !== 'FILE' || !e.file?.fileKey) throw err('GAIA_IL02', 'type / file.fileKey が不正です');
          const key = e.file.fileKey;
          if (st.files.has(key)) return { type: 'FILE', fileKey: key };                       // 取得 API の fileKey を再指定 → ファイルは残る
          const up = st.pending.get(key);
          if (!up) throw err('GAIA_IL04', '指定した fileKey「' + key + '」は不正です');
          const dl = 'dl:' + (st.fileSeq++);
          const content = ctl.corruptUploaded ? up.content + '\n// corrupted' : up.content;   // corruptUploaded: 実体化した本文を壊す mutant（本文の指紋検証が検出する）
          st.files.set(dl, { name: up.name, size: String(Buffer.byteLength(content, 'utf8')), content, contentType: up.mime });
          st.pending.delete(key);
          return { type: 'FILE', fileKey: dl };
        });
      }
      if (ctl.dropOneExistingOnPut === 'customize') next.desktop.js = next.desktop.js.slice(1);   // バグの注入: 既存 1 件が抜ける
      const final = ctl.mutateCustomize ? ctl.mutateCustomize(next) : next;
      // kintone の実挙動（Phase 17 実機）: 設定から外れた FILE の fileKey は以後の PUT で「指定したファイルが見つかりません」になる（ダウンロードもできない）
      const stillUsed = new Set(['desktop', 'mobile'].flatMap(t => ['js', 'css'].flatMap(k => final[t][k].filter(e => e.type === 'FILE').map(e => e.fileKey))));
      for (const t of ['desktop', 'mobile']) for (const k of ['js', 'css']) for (const e of st.customize[t][k]) if (e.type === 'FILE' && !stillUsed.has(e.fileKey)) st.files.delete(e.fileKey);
      st.customize = final; st.revision += 1;
      return { revision: String(st.revision) };
    },
    async getPreviewFields() { calls.push('GET fields'); guard(); const props = clone(st.fields); if (ctl.relatedUnavailable) for (const f of Object.values(props)) if (f.lookup && String(f.lookup.relatedApp?.app) === String(ctl.relatedUnavailable)) f.lookup = null; return { properties: props, revision: String(st.revision) }; },
    // 参照元アプリ（運用環境・read-only）
    async getApp(id) { calls.push('GET app'); const r = st.relatedApps[String(id)]; if (!r || String(ctl.relatedUnavailable) === String(id)) throw err('CB_NO02', '権限がありません。'); return { appId: String(id), name: r.name, code: r.code || '' }; },
    async getAppFields(id) { calls.push('GET app fields'); const r = st.relatedApps[String(id)]; if (!r || String(ctl.relatedUnavailable) === String(id)) throw err('CB_NO02', '権限がありません。'); return { properties: clone(r.fields), revision: String(r.revision ?? 1) }; },
    async getPreviewLayout() { calls.push('GET layout'); guard(); return { layout: clone(st.layout), revision: String(st.revision) }; },
    async getPreviewViews() { calls.push('GET views'); guard(); return { views: clone(st.views), revision: String(st.revision) }; },
    async getProductionViews() { calls.push('GET prod views'); return { views: clone(st.prodViews), revision: String(st.prodRevision) }; },
    async getPreviewGeneralNotifications() { calls.push('GET general'); guard(); return { notifications: clone(st.general), notifyToCommenter: st.notifyToCommenter, revision: String(st.revision) }; },
    async getPreviewPerRecordNotifications() { calls.push('GET perRecord'); guard(); return { notifications: clone(st.perRecord), revision: String(st.revision) }; },
    async getPreviewReminders() { calls.push('GET reminders'); guard(); return { notifications: clone(st.reminders), timezone: st.timezone, revision: String(st.revision) }; },
    async addPreviewFields(app, properties, revision) {
      write('POST fields'); guard(); checkRev(revision);
      if (ctl.failAddField && Object.keys(properties).includes(ctl.failAddField)) throw err('GAIA_IL04', `フィールド「${ctl.failAddField}」の追加に失敗しました（モック）`);
      for (const [code, p] of Object.entries(properties)) {
        if (st.fields[code]) throw err('GAIA_FC01', `フィールドコード「${code}」は既に使われています。`);
        if (!p.type || !p.label) throw err('GAIA_IL02', 'type / label は必須です');
        st.fields[code] = { ...clone(p), label: ctl.mangleLabel ? p.label + '!' : p.label };
        if (autoPlace) st.layout.push({ type: 'ROW', fields: [{ type: p.type, code, size: { width: '200' } }] });
      }
      st.revision += 1;
      return { revision: String(st.revision) };
    },
    async updatePreviewFields(app, properties, revision) {
      write('PUT fields'); guard(); checkRev(revision);
      for (const [code, p] of Object.entries(properties)) {
        const cur = st.fields[code];
        if (!cur) throw err('GAIA_IL04', `フィールド「${code}」が存在しません`);
        if (!p.type) throw err('GAIA_IL02', 'type は必須です');
        if (p.type !== cur.type) throw err('GAIA_IL04', 'フィールドの種類は変更できません（モック）');
        if (['STATUS', 'STATUS_ASSIGNEE', 'CATEGORY'].includes(cur.type)) throw err('GAIA_IL04', 'このフィールドは変更できません');
        const next = { ...cur };
        for (const [k, v] of Object.entries(p)) {
          if (k === 'type' || k === 'code') continue;
          if (k === 'lookup') {
            // kintone: lookup の下位パラメーターは個別に更新（省略 = 変更なし）。relatedApp / relatedKeyField は PUT で変更できない（モックの厳格化: 送ったら拒否）
            if (!cur.lookup) throw err('GAIA_IL04', `「${code}」はルックアップフィールドではありません（モック）`);
            if (!v || typeof v !== 'object') throw err('GAIA_IL02', 'lookup はオブジェクトです');
            if ('relatedApp' in v || 'relatedKeyField' in v) throw err('GAIA_IL04', 'relatedApp / relatedKeyField は変更できません（モックの厳格化）');
            const rel = st.relatedApps[String(cur.lookup.relatedApp?.app)];
            const relFields = rel ? Object.assign({}, rel.fields, ...Object.values(rel.fields).filter(f => f.type === 'SUBTABLE').map(f => f.fields || {})) : null;
            for (const m of v.fieldMappings || []) { if (!st.fields[m.field]) throw err('GAIA_IL04', `コピー先「${m.field}」が存在しません`); if (relFields && !relFields[m.relatedField]) throw err('GAIA_IL04', `取得元「${m.relatedField}」が参照元アプリに存在しません`); }
            for (const c of v.lookupPickerFields || []) if (relFields && !relFields[c]) throw err('GAIA_IL04', `選択時に表示するフィールド「${c}」が参照元アプリに存在しません`);
            if ((v.fieldMappings || []).some((m, i) => (v.fieldMappings || []).findIndex(x => x.field === m.field) !== i)) throw err('GAIA_IL04', '同じコピー先が複数あります');
            let merged = { ...cur.lookup, ...clone(v) };
            if (ctl.mutateLookup) merged = ctl.mutateLookup(merged);
            next.lookup = merged;
            continue;
          }
          if (k === 'options') { next.options = Object.fromEntries(Object.entries(v).map(([key, value]) => [value.label ?? key, { ...clone(value), label: value.label ?? key }])); continue; }
          next[k] = v;
        }
        if (p.code && p.code !== code) { delete st.fields[code]; next.code = p.code; st.fields[p.code] = next; } else st.fields[code] = next;
      }
      st.revision += 1;
      return { revision: String(st.revision) };
    },
    async getPreviewStatus() { calls.push('GET status'); guard(); return { ...clone(st.status), revision: String(st.revision) }; },
    async putPreviewStatus(app, body, revision) {
      write('PUT status'); guard(); checkRev(revision);
      const cur = st.status;
      const enable = body.enable != null ? (body.enable === true || body.enable === 'true') : cur.enable;
      let states = body.states != null ? clone(body.states) : cur.states, actions = body.actions != null ? clone(body.actions) : cur.actions;
      if (enable && (!states || !Object.keys(states).length)) throw err('GAIA_IL02', 'ステータスが必要です（モック: enable だけの PUT は通らない）');
      if (states) {
        const list = Object.entries(states);
        for (const [key, v] of list) { if (!v || v.name == null) throw err('GAIA_IL02', `states.${key}.name は必須です`); if (v.index == null) throw err('GAIA_IL02', `states.${key}.index は必須です`); if (v.assignee && !['ONE', 'ALL', 'ANY'].includes(v.assignee.type)) throw err('GAIA_IL02', 'assignee.type は ONE / ALL / ANY'); for (const e of v.assignee?.entities || []) { if (!['USER', 'GROUP', 'ORGANIZATION', 'FIELD_ENTITY', 'CREATOR', 'CUSTOM_FIELD'].includes(e.entity?.type)) throw err('GAIA_IL02', 'entity.type が不正です'); if (e.entity.type === 'FIELD_ENTITY' && !st.fields[e.entity.code]) throw err('GAIA_IL04', `作業者フィールド「${e.entity.code}」が存在しません`); } }
        const first = list.map(([k, v]) => ({ k, i: Number(v.index) })).sort((a, b) => a.i - b.i)[0];
        const curFirst = cur.states ? Object.entries(cur.states).map(([k, v]) => ({ k, i: Number(v.index) })).sort((a, b) => a.i - b.i)[0] : null;
        if (curFirst && first && !cur.states[first.k]) throw err('GAIA_IL04', '先頭のステータスは新規に追加できません');
        if (curFirst && first && first.k !== curFirst.k && states[curFirst.k]) throw err('GAIA_IL04', '先頭のステータスの順序は変更できません（モック）');
        states = normalizeStatus({ enable, states, actions: null }).states;
      }
      if (actions) {
        for (const a of actions) {
          if (!a.name || !a.from || !a.to) throw err('GAIA_IL02', 'actions[].name / from / to は必須です');
          if (!states[a.from] || !states[a.to]) throw err('GAIA_IL04', `アクション「${a.name}」の遷移元 / 遷移先が存在しません`);
          if (/LOGINUSER|PRIMARY_ORGANIZATION/.test(a.filterCond || '')) throw err('GAIA_IL08', 'クエリの指定が不正です。');
          if (a.type === 'SECONDARY' && !a.executableUser) throw err('GAIA_IL02', 'SECONDARY には executableUser が必要です');
          for (const e of a.executableUser?.entities || []) { if (!['USER', 'GROUP', 'ORGANIZATION', 'FIELD_ENTITY'].includes(e.entity?.type)) throw err('GAIA_IL02', 'executableUser の entity.type が不正です'); if (e.entity.type === 'FIELD_ENTITY' && !st.fields[e.entity.code]) throw err('GAIA_IL04', `実行可能ユーザーのフィールド「${e.entity.code}」が存在しません`); }
        }
        if (actions.some((a, i) => actions.findIndex(x => x.name === a.name && x.from === a.from) !== i)) throw err('GAIA_IL04', '同じ遷移元に同じ名前のアクションがあります');
        actions = normalizeStatus({ enable, states: null, actions }).actions;
      }
      const next = mutate('status', { enable, states, actions });
      st.status = next; st.revision += 1;
      if (ctl.sideEffectOnStatusPut) ctl.sideEffectOnStatusPut(st);
      return { revision: String(st.revision) };
    },
    // アプリアクション（Phase 14）
    async getPreviewActions() {
      calls.push('GET actions'); guard();
      const out = {};
      for (const [k, a] of Object.entries(st.actions)) { const c = clone(a); if (ctl.destUnavailable && String(c.destApp?.app) === String(ctl.destUnavailable)) { c.destApp = null; c.mappings = null; } out[k] = c; }
      return { actions: out, revision: String(st.revision) };
    },
    async putPreviewActions(app, body, revision) {
      write('PUT actions'); guard(); checkRev(revision);
      const incoming = body?.actions;
      if (!incoming || typeof incoming !== 'object') throw err('GAIA_IL02', 'actions は必須です');
      const next = {};
      let idx = 0;
      for (const [key, a] of Object.entries(incoming)) {
        const cur = st.actions[key];
        if (!cur && !a.name) throw err('GAIA_IL02', `actions.${key}.name はアクションを追加するときに必須です`);
        if (a.name && a.name !== key && Object.keys(incoming).includes(a.name)) throw err('GAIA_IL04', '更新後のアクション名がほかのアクション名と重複します');
        if (a.name != null && String(a.name).length > 32) throw err('GAIA_IL02', 'アクション名は 32 文字以内です');
        if (a.name && a.index == null) throw err('GAIA_IL02', 'name を指定する場合 index は必須です');
        if (!cur && !a.destApp) throw err('GAIA_IL02', 'アクションを追加するときは destApp が必須です');
        if (!cur && !a.mappings) throw err('GAIA_IL02', 'アクションを追加するときは mappings が必須です');
        if (!cur && !a.entities) throw err('GAIA_IL02', 'アクションを追加するときは entities が必須です');
        if ('id' in a) throw err('GAIA_IL01', 'id は指定できません（モックの厳格化）');
        const destId = a.destApp ? (a.destApp.code ? (Object.entries(st.relatedApps).find(([, r]) => r.code === a.destApp.code) || [null])[0] : String(a.destApp.app)) : String(cur.destApp?.app);
        if (a.destApp && !destId) throw err('GAIA_IL04', `コピー先アプリ（code ${a.destApp.code}）が存在しません`);
        const rel = st.relatedApps[String(destId)];
        const relFields = rel ? Object.assign({}, rel.fields, ...Object.values(rel.fields).filter(f => f.type === 'SUBTABLE').map(f => f.fields || {})) : null;
        const mappings = a.mappings != null ? a.mappings : cur.mappings;
        for (const m of mappings || []) {
          if (!['FIELD', 'RECORD_URL'].includes(m.srcType)) throw err('GAIA_IL02', 'mappings[].srcType は FIELD / RECORD_URL');
          if (m.srcType === 'FIELD' && !st.fields[m.srcField]) throw err('GAIA_IL04', `転記元「${m.srcField}」が存在しません`);
          if (!m.destField) throw err('GAIA_IL02', 'mappings[].destField は必須です');
          if (relFields && !relFields[m.destField]) throw err('GAIA_IL04', `転記先「${m.destField}」がコピー先アプリに存在しません`);
        }
        const entities = a.entities != null ? a.entities : cur.entities;
        for (const e of entities || []) if (!['USER', 'GROUP', 'ORGANIZATION'].includes(e.type)) throw err('GAIA_IL02', 'entities[].type は USER / GROUP / ORGANIZATION');
        if (/LOGIN_USER|IS_NULL/.test(a.filterCond || '')) throw err('GAIA_IL08', 'クエリの指定が不正です。');
        const name = a.name ?? cur.name;
        next[name] = { name, id: cur ? cur.id : String(st.actionSeq++), index: String(a.index ?? cur.index ?? idx), destApp: a.destApp ? { app: String(destId), code: rel?.code || '' } : clone(cur.destApp), mappings: clone(mappings || []).map(m => (m.srcType === 'RECORD_URL' ? { srcType: 'RECORD_URL', destField: m.destField } : { srcType: 'FIELD', srcField: m.srcField, destField: m.destField })), entities: clone(entities || []).map(e => ({ type: e.type, code: e.code })), filterCond: a.filterCond != null ? a.filterCond : (cur ? cur.filterCond : '') };
        idx++;
      }
      let list = next;
      if (ctl.dropOneExistingOnPut === 'actions') { const [first] = Object.keys(list); delete list[first]; }   // バグの注入: 既存 1 件が抜ける
      list = mutate('actions', list);
      st.actions = list; st.revision += 1;
      return { actions: Object.fromEntries(Object.entries(list).map(([k, v]) => [k, { id: v.id }])), revision: String(st.revision) };
    },
    async deletePreviewFields(app, fields, revision) {
      write('DELETE fields'); guard(); checkRev(revision);
      if (ctl.failDelete) throw err('GAIA_XX', 'モックの失敗（DELETE fields）');
      for (const code of fields || []) {
        const cur = st.fields[code];
        if (!cur) throw err('GAIA_IL04', `フィールド「${code}」が存在しません`);
        if (['STATUS', 'STATUS_ASSIGNEE', 'CATEGORY'].includes(cur.type)) throw err('GAIA_IL04', 'このフィールドは削除できません');
        delete st.fields[code];
        st.layout = st.layout.map(r => ({ ...r, fields: (r.fields || []).filter(x => x.code !== code) })).filter(r => (r.fields || []).length || r.type !== 'ROW');
      }
      st.revision += 1;
      return { revision: String(st.revision) };
    },
    async putPreviewLayout(app, layout, revision) {
      write('PUT layout'); guard(); checkRev(revision);
      const codes = new Set(); const walk = (rows) => { for (const r of rows) { for (const f of r.fields || []) if (f.code) { if (!st.fields[f.code] && !['LABEL', 'SPACER', 'HR'].includes(f.type)) throw err('GAIA_IL03', `レイアウトのフィールド「${f.code}」が存在しません`); codes.add(f.code); } if (r.layout) walk(r.layout); } };
      walk(layout);
      for (const code of Object.keys(st.fields)) if (!codes.has(code) && !['SUBTABLE', 'GROUP'].includes(st.fields[code].type) && !st.fields[code].parent) throw err('GAIA_IL04', `フィールド「${code}」がレイアウトに含まれていません`);
      st.layout = clone(layout); st.revision += 1;
      return { revision: String(st.revision) };
    },
    async putPreviewViews(app, views, revision) {
      write('PUT views'); guard(); checkRev(revision);
      for (const [name, v] of Object.entries(views)) {
        if (v.type === 'LIST') for (const f of v.fields || []) if (!st.fields[f]) throw err('GAIA_IL04', `一覧「${name}」のフィールド「${f}」が存在しません`);
        if ('id' in v) throw err('GAIA_IL01', 'id は指定できません（モックの厳格化）');
      }
      let seq = 900; const next = {};
      for (const [name, v] of Object.entries(mutate('views', clone(views)))) next[name] = { id: st.views[name]?.id || String(seq++), ...clone(v) };
      st.views = next; st.revision += 1;
      return { views: Object.fromEntries(Object.entries(next).map(([n, v]) => [n, { id: v.id }])), revision: String(st.revision) };
    },
    async putPreviewGeneralNotifications(app, body, revision) {
      write('PUT general'); guard(); checkRev(revision);
      let list = clone(body.notifications || []);
      for (const n of list) { if (!n.entity?.type || !['USER', 'GROUP', 'ORGANIZATION', 'FIELD_ENTITY'].includes(n.entity.type)) throw err('GAIA_IL02', 'entity.type が不正です'); if (n.entity.type === 'FIELD_ENTITY' && !st.fields[n.entity.code]) throw err('GAIA_IL04', `通知先フィールド「${n.entity.code}」が存在しません`); }
      if (ctl.dropOneExistingOnPut === 'general') list = list.slice(1);   // バグの注入: 既存 1 件が抜ける
      list = mutate('general', list);
      st.general = list.map(n => ({ entity: n.entity, includeSubs: !!n.includeSubs, recordAdded: !!n.recordAdded, recordEdited: !!n.recordEdited, commentAdded: !!n.commentAdded, statusChanged: !!n.statusChanged, fileImported: !!n.fileImported }));
      if (body.notifyToCommenter != null) st.notifyToCommenter = !!body.notifyToCommenter;
      st.revision += 1;
      return { revision: String(st.revision) };
    },
    async putPreviewPerRecordNotifications(app, body, revision) {
      write('PUT perRecord'); guard(); checkRev(revision);
      let list = clone(body.notifications || []);
      for (const n of list) {
        if (!n.filterCond) throw err('GAIA_IL02', 'filterCond は必須です');
        if (/LOGIN_USER|IS_NULL|PREVIOUS_VALUE/.test(n.filterCond)) throw err('GAIA_IL08', 'クエリの指定が不正です。');
        for (const t of n.targets || []) if (t.entity?.type === 'FIELD_ENTITY' && !st.fields[t.entity.code]) throw err('GAIA_IL04', `通知先フィールド「${t.entity.code}」が存在しません`);
      }
      if (ctl.dropOneExistingOnPut === 'perRecord') list = list.slice(1);
      list = mutate('perRecord', list);
      st.perRecord = list.map(n => ({ filterCond: n.filterCond, title: n.title || '', targets: (n.targets || []).map(t => ({ entity: t.entity, includeSubs: !!t.includeSubs })) }));
      st.revision += 1;
      return { revision: String(st.revision) };
    },
    async putPreviewReminders(app, body, revision) {
      write('PUT reminders'); guard(); checkRev(revision);
      let list = clone(body.notifications || []);
      for (const n of list) {
        const f = st.fields[n.timing?.code];
        if (!f || !['DATE', 'DATETIME', 'CREATED_TIME', 'UPDATED_TIME'].includes(f.type)) throw err('GAIA_IL04', `基準フィールド「${n.timing?.code}」が不正です`);
        if (n.timing.time == null && n.timing.hoursLater == null) throw err('GAIA_IL02', 'timing.time または hoursLater が必要です');
        if (/LOGINUSER|PRIMARY_ORGANIZATION/.test(n.filterCond || '')) throw err('GAIA_IL08', 'クエリの指定が不正です。');
      }
      if (ctl.dropOneExistingOnPut === 'reminders') list = list.slice(1);
      list = mutate('reminders', list);
      st.reminders = list.map((n, i) => ({ timing: { code: n.timing.code, daysLater: String(n.timing.daysLater), ...(n.timing.time != null ? { time: (ctl.mangleReminderTime && i === list.length - 1) ? '23:50' : n.timing.time } : { hoursLater: String(n.timing.hoursLater) }) }, filterCond: n.filterCond || '', title: n.title || '', targets: (n.targets || []).map(t => ({ entity: t.entity, includeSubs: !!t.includeSubs })) }));   // mangleReminderTime: 追加した 1 件だけ時刻を壊す（検証の mutant）
      if (body.timezone) st.timezone = body.timezone;
      else if (st.timezone == null) st.timezone = 'Asia/Tokyo';   // Phase 20（実機）: 未設定（null）のアプリは最初の保存で既定の timezone が入る（API で null には戻せない）
      st.revision += 1;
      return { revision: String(st.revision) };
    },
  };
  /**
   * 2026-10-23: 反映・登録の部品（KTPlanExecutor.prepare・KTJsExecutor.prepare）に渡す今の設定（画面の作業の基準 KTDevBase.currentOf と同じ形）。
   *   GET と同じ中身・同じ権限・同じ ctl の挙動で作り、呼び出しの記録（calls）には残さない（画面では作業の基準の取得が担う。部品のテストは `current: await mock.current()` で渡す）。
   *   権限が無ければ GET と同じく CB_NO02 を投げる（画面では作業の基準の取得が止まる場面）
   */
  async function current() {
    const n = calls.length;
    try {
      const [fields, layout, views, prodViews, generalNotify, perRecordNotify, reminderNotify, status, actions, customize] = await Promise.all([api.getPreviewFields(), api.getPreviewLayout(), api.getPreviewViews(), api.getProductionViews(), api.getPreviewGeneralNotifications(), api.getPreviewPerRecordNotifications(), api.getPreviewReminders(), api.getPreviewStatus(), api.getPreviewActions(), api.getPreviewCustomize()]);
      const files = [];
      for (const target of ['desktop', 'mobile']) for (const e of customize[target].js) {
        if (e.type !== 'FILE') continue;
        let text = null; try { text = await api.downloadFile(e.file.fileKey); } catch (e2) { text = null; }
        files.push({ target, name: e.file.name, fileKey: e.file.fileKey, text, sourceAvailable: typeof text === 'string' });
      }
      return { takenAt: null, fields, layout, views, prodViews, generalNotify, perRecordNotify, reminderNotify, status, actions, customize, files };
    } finally { calls.length = n; }
  }
  return { api, st, calls, ctl, current };
}

module.exports = { makeKintoneMock };
