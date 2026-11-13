/* Pure comparison functions extracted unchanged from kintone Config Lens v0.9.2.
 * https://github.com/youtotto/kintone-config-lens
 * Commit: fa9a942024c7947c3766414d5e6a2d254940260d
 * Source SHA-256 (LF): 6727d3363641e416e0c9cc422803448a2cd72d4016607db833a161b2ec26eecb
 * No network, browser controls or collection code is included.
 *
 * MIT License
 *
 * Copyright (c) 2026 Yuto Kawai (Nest Rec)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 */
'use strict';
const KTConfigLensCompare = (() => {
  const NAMES = {
    label: 'フィールド名', type: '種類', code: 'フィールドコード', required: '必須項目',
    unique: '値の重複を禁止', noLabel: 'フィールド名を非表示', defaultValue: '初期値',
    defaultNowValue: '現在日時を初期値にする', options: '選択肢・順序', align: '選択肢の並び',
    minLength: '最小文字数', maxLength: '最大文字数', minValue: '最小値', maxValue: '最大値',
    expression: '計算式', hideExpression: '計算式を非表示', digit: '桁区切り', displayScale: '小数点以下の桁数',
    unit: '単位', unitPosition: '単位の位置', format: '表示形式', protocol: 'リンクの種類',
    thumbnailSize: 'サムネイルサイズ', entities: '選択候補', openGroup: 'グループを開いて表示',
    lookup: 'ルックアップ', referenceTable: '関連レコード一覧', relatedApp: '参照先アプリ',
    relatedKeyField: 'コピー元フィールド', fieldMappings: 'ほかのフィールドのコピー',
    lookupPickerFields: '選択時に表示するフィールド', filterCond: '絞り込み条件', sort: '並び順',
    condition: '表示条件', displayFields: '表示するフィールド', size: '表示件数', app: 'アプリID',
    enabled: '有効', parent: '所属テーブル'
  };
  const TYPES = { SINGLE_LINE_TEXT: '文字列（1行）', MULTI_LINE_TEXT: '文字列（複数行）',
    RICH_TEXT: 'リッチエディター', NUMBER: '数値', CALC: '計算', RADIO_BUTTON: 'ラジオボタン',
    CHECK_BOX: 'チェックボックス', MULTI_SELECT: '複数選択', DROP_DOWN: 'ドロップダウン',
    DATE: '日付', TIME: '時刻', DATETIME: '日時', FILE: '添付ファイル', LINK: 'リンク',
    USER_SELECT: 'ユーザー選択', ORGANIZATION_SELECT: '組織選択', GROUP_SELECT: 'グループ選択',
    SUBTABLE: 'テーブル', GROUP: 'グループ', REFERENCE_TABLE: '関連レコード一覧' };
  const SYSTEM = new Set(['STATUS', 'STATUS_ASSIGNEE', 'CATEGORY']);
  Object.assign(NAMES, {
    name: '名称', description: '説明', theme: 'テーマ', icon: 'アイコン', titleField: 'レコードのタイトル',
    enableThumbnails: 'サムネイル表示', enableBulkDeletion: '一括削除を許可', enableComments: 'コメントを使用',
    enableDuplicateRecord: 'レコード再利用を許可', enableInlineRecordEditing: '一覧での編集を許可',
    numberPrecision: '数値の精度', digits: '全体の桁数', decimalPlaces: '小数部の桁数', roundingMode: '丸め方',
    firstMonthOfFiscalYear: '年度の開始月', selectionMode: '選択方法', fields: '表示フィールド・順序',
    index: '表示順（0始まり）', html: 'カスタマイズHTML', pager: 'ページ送りを表示', device: '表示端末',
    date: '日付フィールド', title: '表示内容', builtinType: '組み込み一覧', enable: '有効', states: 'ステータス',
    assignee: '作業者', actions: 'アクション・順序', from: '実行前ステータス', to: '実行後ステータス',
    executableUser: '実行可能ユーザー', notifications: '通知ルール・順序', entity: '対象', targets: '通知先',
    includeSubs: '下位組織を含む', recordAdded: 'レコード追加時', recordEdited: 'レコード編集時',
    commentAdded: 'コメント追加時', statusChanged: 'ステータス変更時', fileImported: 'ファイル読み込み時',
    notifyToCommenter: 'コメントしたユーザーへの通知', timing: '通知日時', daysLater: '日数の差',
    hoursLater: '時間の差', time: '時刻', timezone: 'タイムゾーン', rights: 'アクセス権・優先順',
    appEditable: 'アプリ管理', recordViewable: 'レコード閲覧', recordAddable: 'レコード追加',
    recordEditable: 'レコード編集', recordDeletable: 'レコード削除', recordImportable: 'ファイル読み込み',
    recordExportable: 'ファイル書き出し', viewable: '閲覧', editable: '編集', deletable: '削除',
    accessibility: '許可する操作', chartType: 'グラフの種類', chartMode: '表示方法', groups: '分類',
    aggregations: '集計方法', sorts: '並び順', periodicReport: '定期レポート', active: '有効', period: '間隔',
    destApp: 'コピー先アプリ', mappings: 'コピーする項目', srcType: 'コピー元の種類', srcField: 'コピー元フィールド',
    destField: 'コピー先フィールド', scope: '適用範囲', desktop: 'PC', mobile: 'モバイル', js: 'JavaScript・順序',
    css: 'CSS・順序', url: 'URL', file: 'ファイル', fileKey: 'ファイル識別情報', contentType: 'ファイル形式', contentHash: '内容（SHA-256）',
    content: 'メモ本文', includeInTemplateAndDuplicates: 'テンプレート・再利用時にメモを含める',
    layout: '配置・部品', width: '幅', height: '高さ', innerHeight: '入力欄の高さ', elementId: '要素ID'
  });
  // Each category declares the public API response shape. Missing data must never mean no changes.
  const CATEGORIES = [
    { id: 'fields', label: 'フォーム項目', path: 'app/form/fields', shape: { properties: 'object' }, mode: 'fields' },
    { id: 'layout', label: 'フォーム配置', path: 'app/form/layout', shape: { layout: 'array' }, note: '保存済みフォームの配置を左右の図で確認します。寸法はPC用です。' },
    { id: 'views', label: '一覧', path: 'app/views', shape: { views: 'object' }, collection: 'views', key: 'id' },
    { id: 'process', label: 'プロセス管理', path: 'app/status', shape: { enable: 'boolean', states: 'object?', actions: 'array?' } },
    { id: 'notifyApp', label: '通知：アプリ', path: 'app/notifications/general', shape: { notifications: 'array', notifyToCommenter: 'boolean' } },
    { id: 'notifyRecord', label: '通知：レコード', path: 'app/notifications/perRecord', shape: { notifications: 'array' } },
    { id: 'notifyReminder', label: '通知：リマインダー', path: 'app/notifications/reminder', shape: { notifications: 'array', timezone: 'string?' } },
    { id: 'aclApp', label: 'アクセス権：アプリ', path: 'app/acl', shape: { rights: 'array' } },
    { id: 'aclRecord', label: 'アクセス権：レコード', path: 'record/acl', shape: { rights: 'array' } },
    { id: 'aclField', label: 'アクセス権：フィールド', path: 'field/acl', shape: { rights: 'array' }, collection: 'rights', key: 'code' },
    { id: 'general', label: '一般設定・高度な設定', path: 'app/settings', shape: { name: 'string', description: 'string' } },
    { id: 'reports', label: 'グラフ・定期レポート', path: 'app/reports', shape: { reports: 'object' }, collection: 'reports', key: 'id' },
    { id: 'actions', label: 'アプリアクション', path: 'app/actions', shape: { actions: 'object' }, collection: 'actions', key: 'id', note: 'コピー先や対応項目が権限により取得できない場合、その部分は比較できません。' },
    { id: 'customize', label: 'JavaScript・CSS', path: 'app/customize', shape: { scope: 'string', desktop: 'object', mobile: 'object' }, note: '登録情報・読み込み順と、アップロードしたファイルの内容を比較します。同じURLの配信内容は比較しません。' },
    { id: 'plugins', label: 'プラグインの追加・有効状態', path: 'app/plugins', shape: { plugins: 'array' }, collection: 'plugins', key: 'id', note: 'プラグイン内部の設定・バージョンは対象外です。' },
    { id: 'notes', label: 'アプリ管理者用メモ', path: 'app/adminNotes', shape: { content: 'string', includeInTemplateAndDuplicates: 'boolean' } }
  ];
  const UNSUPPORTED = '未対応：カテゴリー・プラグイン内部設定（APIラボ）、言語別名称一式、Webhook、APIトークン。';
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const displayName = key => Object.hasOwn(NAMES, key) ? NAMES[key] : key;
  function validateResponse(category, data) {
    if (!object(data) || !/^\d+$/.test(String(data.revision ?? ''))) throw new Error('応答形式が不正です（リビジョンなし）。');
    for (const [key, type] of Object.entries(category.shape)) {
      const value = data[key], base = type.replace('?', '');
      if (value === null && type.endsWith('?')) continue;
      if (!(base === 'array' ? Array.isArray(value) : base === 'object' ? object(value) : typeof value === base)) {
        throw new Error(`応答形式が不正です（${key}）。`);
      }
    }
    return data;
  }
  function settingsOnly(data) {
    return Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'revision'));
  }
  function collectionMap(category, data) {
    const result = new Map();
    for (const value of Object.values(data[category.collection])) {
      const key = value?.[category.key];
      if (!object(value) || key === undefined || key === null || key === '' || result.has(String(key))) {
        throw new Error('項目の識別情報が不足または重複しているため比較できません。');
      }
      result.set(String(key), value);
    }
    return result;
  }
  function settingFiles(category, data) {
    if (category.id === 'general') return [data.icon].filter(v => v?.type === 'FILE');
    if (category.id !== 'customize') return [];
    return ['desktop', 'mobile'].flatMap(device => ['js', 'css'].flatMap(kind => {
      const entries = data[device][kind];
      if (!Array.isArray(entries)) throw new Error('ファイル一覧の応答形式が不正です。');
      return entries.filter(v => v?.type === 'FILE');
    }));
  }
  function fileComparison(category, live, preview, hashes, warnings) {
    // Download keys can differ without a content change. Only normalize the documented file slots.
    const copies = [live, preview].map(data => JSON.parse(JSON.stringify(data)));
    for (const data of copies) for (const entry of settingFiles(category, data)) {
      const f = entry.file;
      if (!object(f) || !['fileKey', 'name', 'contentType', 'size'].every(k => typeof f[k] === 'string') || !/^\d+$/.test(f.size)) {
        throw new Error('ファイル情報が不足しているため比較できません。');
      }
    }
    const normalizePair = (a, b) => {
      const files = [a, b].map(entry => entry?.type === 'FILE' ? entry.file : null);
      const verified = files.every(f => !f || hashes.has(f.fileKey));
      for (const f of files.filter(Boolean)) {
        if (verified) f.contentHash = hashes.get(f.fileKey);
        else warnings.push(`ファイル「${f.name}」の内容を取得・確認できず比較できません。設定を再取得してください。`);
        delete f.fileKey;
      }
    };
    if (category.id === 'general') normalizePair(copies[0].icon, copies[1].icon);
    if (category.id === 'customize') for (const device of ['desktop', 'mobile']) for (const kind of ['js', 'css']) {
      const a = copies[0][device][kind], b = copies[1][device][kind];
      for (let i = 0; i < Math.max(a.length, b.length); i++) normalizePair(a[i], b[i]);
    }
    return copies;
  }
  function compareCategory(category, live, preview, hashes = new Map()) {
    validateResponse(category, live); validateResponse(category, preview);
    const warnings = [];
    if (['general', 'customize'].includes(category.id)) [live, preview] = fileComparison(category, live, preview, hashes, warnings);
    if (category.id === 'actions' && [live, preview].some(data => Object.values(data.actions).some(a => a.destApp == null || a.mappings == null))) {
      warnings.push('一部のコピー先・対応項目が取得できず比較できません。取得できた部分のみ表示しています。');
    }
    let result;
    if (category.mode === 'fields') result = compare(live.properties, preview.properties);
    else if (category.collection) {
      const a = collectionMap(category, live), b = collectionMap(category, preview);
      result = [];
      for (const code of new Set([...a.keys(), ...b.keys()])) {
        const before = a.get(code), after = b.get(code), rows = changes(before, after);
        if (!before || !after || rows.length) result.push({ code, label: (after || before).name || code,
          kind: !before ? 'added' : !after ? 'deleted' : 'changed', before, after, rows });
      }
    } else {
      const a = settingsOnly(live), b = settingsOnly(preview);
      result = [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(code => {
        const rows = changes(a[code], b[code], [code]);
        return rows.length ? [{ code, label: displayName(code), kind: 'changed', before: a[code], after: b[code], rows }] : [];
      });
    }
    return { category, state: warnings.length ? 'partial' : 'ok', warnings: [...new Set(warnings)],
      ...(['fields', 'layout', 'views', 'reports'].includes(category.id) ? { snapshots: [live, preview] } : {}),
      entries: result.map(entry => ({ ...entry, categoryId: category.id })), liveRevision: String(live.revision), previewRevision: String(preview.revision) };
  }
  function formatSetting(value, depth = 0) {
    if (value === null) return 'null（未設定または取得不可）';
    if (!object(value) && !Array.isArray(value)) return format(value);
    if (!Object.keys(value).length) return '（なし）';
    return Object.entries(value).map(([key, child]) => `${'  '.repeat(depth)}${Array.isArray(value) ? Number(key) + 1 : key === 'code' ? 'コード' : key === 'size' ? 'サイズ' : displayName(key)}：${object(child) || Array.isArray(child) ? '\n' + formatSetting(child, depth + 1) : formatSetting(child)}`).join('\n');
  }

  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (object(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    return JSON.stringify(v);
  }

  function flatten(properties) {
    const result = new Map();
    function walk(fields, parent = '') {
      for (const [key, field] of Object.entries(fields)) {
        if (SYSTEM.has(field.type)) continue;
        const { fields: children, ...settings } = field;
        const code = field.code || key;
        result.set(code, { code, parent, settings });
        if (children) walk(children, code);
      }
    }
    walk(properties);
    return result;
  }

  function changes(before, after, path = []) {
    if (stable(before) === stable(after)) return [];
    if (object(before) && object(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort().flatMap(key => changes(before[key], after[key], [...path, key]));
    return [{ path, before, after }];
  }
  function compare(live, preview) {
    const a = flatten(live), b = flatten(preview), result = [];
    for (const code of new Set([...a.keys(), ...b.keys()])) {
      const before = a.get(code), after = b.get(code);
      // Options are one setting: preserve explicit index order in their human-readable representation.
      let rows = [];
      for (const key of new Set([...Object.keys(before?.settings || {}), ...Object.keys(after?.settings || {})])) {
        const oldValue = before?.settings[key], newValue = after?.settings[key];
        if (key === 'options') {
          if (stable(oldValue) !== stable(newValue)) rows.push({ path: [key], before: oldValue, after: newValue });
        } else rows.push(...changes(oldValue, newValue, [key]));
      }
      if (before && after && before.parent !== after.parent) rows.push({ path: ['parent'], before: before.parent, after: after.parent });
      if (!before || !after || rows.length) result.push({ code, before, after, rows,
        kind: !before ? 'added' : !after ? 'deleted' : 'changed',
        label: (after || before).settings.label || code });
    }
    return result.sort((x, y) => x.label.localeCompare(y.label, 'ja') || x.code.localeCompare(y.code));
  }
  function format(value, path = []) {
    if (value === undefined) return '—';
    if (value === null) return '取得不可／未設定';
    if (value === '') return '（空欄）';
    if (typeof value === 'boolean') return value ? 'はい' : 'いいえ';
    if (path[0] === 'options' && object(value)) return Object.values(value)
      .sort((a, b) => Number(a.index) - Number(b.index)).map(v => `${Number(v.index) + 1}. ${v.label}`).join('\n') || '（なし）';
    if (path[0] === 'type') return TYPES[value] || String(value);
    if (Array.isArray(value) && value.every(v => typeof v === 'string')) return value.join('\n') || '（なし）';
    if (object(value) || Array.isArray(value)) return JSON.stringify(value, null, 2);
    return String(value);
  }
  return { compare, changes, flatten, stable, format, formatSetting, CATEGORIES, UNSUPPORTED, compareCategory, validateResponse, settingFiles, fileComparison, displayName };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTConfigLensCompare };
