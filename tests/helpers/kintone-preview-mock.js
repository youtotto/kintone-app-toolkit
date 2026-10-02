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

function makeKintoneMock(data, { permission = true, autoPlace = true } = {}) {
  const rowsFrom = (fields) => Object.values(fields).filter(f => !['SUBTABLE', 'GROUP'].includes(f.type)).map(f => ({ type: 'ROW', fields: [{ type: f.type, code: f.code, size: { width: '200' } }] }));
  const st = {
    fields: clone(data.fields), layout: rowsFrom(data.fields), views: clone(data.views?.views || {}),
    general: clone(data.generalNotify?.notifications || []), notifyToCommenter: data.generalNotify?.notifyToCommenter ?? false,
    perRecord: clone(data.perRecordNotify?.notifications || []), reminders: clone(data.reminderNotify?.notifications || []), timezone: data.reminderNotify?.timezone || 'Asia/Tokyo',
    revision: Number(data.views?.revision || 1), prodRevision: Number(data.views?.revision || 1), prodViews: clone(data.views?.views || {}),
    // プロセス管理（Phase 12）: GET /preview/app/status と同じ形（enable / states / actions）。states / actions は PUT で全体置換
    status: data.status ? normalizeStatus({ enable: !!data.status.enable, states: clone(data.status.states || {}), actions: clone(data.status.actions || []) }) : { enable: false, states: null, actions: null },
  };
  const calls = [];
  const err = (code, message) => Object.assign(new Error(message), { code, message });
  // mutateList(what, list): 全体置換 API が受け取った一覧を保存直前に書き換える（検証の mutant。what = 'general' | 'perRecord' | 'reminders' | 'views'）
  // sideEffectOnStatusPut: プロセス管理の PUT 後に kintone が自動で一覧 / 通知を足す挙動を模す（Phase 12 §17）
  const ctl = { failAddField: null, mangleLabel: false, failPut: null, dropOneExistingOnPut: null, mangleReminderTime: false, onWrite: null, mutateList: null, failDelete: null, sideEffectOnStatusPut: null };
  const mutate = (what, list) => (ctl.mutateList ? ctl.mutateList(what, list) : list);
  const guard = () => { if (!permission) throw err('CB_NO02', '権限がありません。'); };
  const checkRev = (revision) => { if (revision != null && revision !== '' && String(revision) !== String(st.revision)) throw err('GAIA_CO02', '指定したリビジョンが最新ではありません。'); };
  const write = (what) => { calls.push(what); if (ctl.onWrite) ctl.onWrite(what); if (ctl.failPut === what.split(' ')[1]) throw err('GAIA_XX', `モックの失敗（${what}）`); };
  const api = {
    async getPreviewFields() { calls.push('GET fields'); guard(); return { properties: clone(st.fields), revision: String(st.revision) }; },
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
        for (const [k, v] of Object.entries(p)) if (k !== 'type' && k !== 'code') next[k] = v;
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
      st.revision += 1;
      return { revision: String(st.revision) };
    },
  };
  return { api, st, calls, ctl };
}

module.exports = { makeKintoneMock };
