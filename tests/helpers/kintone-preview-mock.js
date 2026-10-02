// kintone の動作テスト環境（preview）を模す API モック（KTPlanExecutor のテスト用）。
//   fields / layout / views / アプリの条件通知 / レコードの条件通知 / リマインダー を Map 風に持ち、revision を進める。
//   kintone の挙動に合わせる: 全体置換 API は送った内容で置き換える（既存を含めないと消える）、revision 不一致は GAIA_CO02、
//   権限なしは CB_NO02。ctl で失敗やバグ（既存を 1 件落とす mutant 等）を注入できる。
'use strict';
const clone = (v) => JSON.parse(JSON.stringify(v));

function makeKintoneMock(data, { permission = true, autoPlace = true } = {}) {
  const rowsFrom = (fields) => Object.values(fields).filter(f => !['SUBTABLE', 'GROUP'].includes(f.type)).map(f => ({ type: 'ROW', fields: [{ type: f.type, code: f.code, size: { width: '200' } }] }));
  const st = {
    fields: clone(data.fields), layout: rowsFrom(data.fields), views: clone(data.views?.views || {}),
    general: clone(data.generalNotify?.notifications || []), notifyToCommenter: data.generalNotify?.notifyToCommenter ?? false,
    perRecord: clone(data.perRecordNotify?.notifications || []), reminders: clone(data.reminderNotify?.notifications || []), timezone: data.reminderNotify?.timezone || 'Asia/Tokyo',
    revision: Number(data.views?.revision || 1), prodRevision: Number(data.views?.revision || 1), prodViews: clone(data.views?.views || {}),
  };
  const calls = [];
  const err = (code, message) => Object.assign(new Error(message), { code, message });
  // mutateList(what, list): 全体置換 API が受け取った一覧を保存直前に書き換える（検証の mutant。what = 'general' | 'perRecord' | 'reminders' | 'views'）
  const ctl = { failAddField: null, mangleLabel: false, failPut: null, dropOneExistingOnPut: null, mangleReminderTime: false, onWrite: null, mutateList: null, failDelete: null };
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
