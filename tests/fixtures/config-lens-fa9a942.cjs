// ==UserScript==
// @name         kintone Config Lens
// @namespace    urn:nestrec:kintone-form-diff
// @version      0.9.2
// @author       Nest Rec / youtotto
// @license      MIT
// @homepageURL  https://github.com/youtotto/kintone-config-lens
// @supportURL   https://github.com/youtotto/kintone-config-lens/issues
// @downloadURL  https://github.com/youtotto/kintone-config-lens/releases/download/v0.9.2/kintoneConfigLens.user.js
// @description  アプリ設定16カテゴリの差分、フィールド設定の概要、フィールド数、管理画面のクイックタブを表示します。
// @match        https://*.cybozu.com/k/admin/app/*
// @match        https://*.cybozu.com/k/guest/*/admin/app/*
// @match        https://*.kintone.com/k/admin/app/*
// @match        https://*.kintone.com/k/guest/*/admin/app/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==
(function () {
  'use strict';

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
  const KINDS = { changed: '変更', added: '追加', deleted: '削除予定' };
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
  function collectionOverview(categoryId, value) {
    const text = v => v === undefined || v === null ? '取得不可' : String(v) || '指定なし';
    const rows = [];
    if (categoryId === 'views') {
      rows.push(['形式', ({ LIST: '表', CALENDAR: 'カレンダー', CUSTOM: 'カスタマイズ' })[value.type] || text(value.type)]);
      if (value.type === 'LIST') rows.push(['表示フィールド（順序）', Array.isArray(value.fields) ? value.fields.join(' → ') || '指定なし' : '取得不可']);
      if (value.type === 'CALENDAR') rows.push(['日付フィールド', text(value.date)], ['タイトル', text(value.title)]);
      if (value.type === 'CUSTOM') rows.push(['カスタマイズHTML', value.html ? '設定あり' : '設定なし']);
      rows.push(['絞り込み', text(value.filterCond)], ['並び順', text(value.sort)]);
    } else {
      const chart = { BAR: '横棒', COLUMN: '縦棒', PIE: '円', LINE: '折れ線', SPLINE: '曲線', AREA: '面', SPLINE_AREA: '曲線面', TABLE: '表', PIVOT_TABLE: 'クロス集計表' };
      const per = { YEAR: '年', QUARTER: '四半期', MONTH: '月', WEEK: '週', DAY: '日', HOUR: '時', MINUTE: '分' };
      const aggregation = { COUNT: 'レコード数', SUM: '合計', AVERAGE: '平均', MAX: '最大', MIN: '最小' };
      rows.push(['種類', (chart[value.chartType] || text(value.chartType)) + (value.chartMode ? ' ／ ' + ({ NORMAL: '通常', STACKED: '積み上げ', PERCENTAGE: '100%積み上げ' }[value.chartMode] || value.chartMode) : '')],
        ['分類（大 → 中 → 小）', Array.isArray(value.groups) ? value.groups.map(g => text(g.code) + (g.per ? `（${per[g.per] || g.per}）` : '')).join(' → ') || '指定なし' : '取得不可'],
        ['集計方法', Array.isArray(value.aggregations) ? value.aggregations.map(a => (aggregation[a.type] || text(a.type)) + (a.code ? `：${a.code}` : '')).join('\n') || '指定なし' : '取得不可'],
        ['絞り込み', text(value.filterCond)],
        ['並び順', Array.isArray(value.sorts) ? value.sorts.map(s => ({ TOTAL: '集計値', GROUP1: '大項目', GROUP2: '中項目', GROUP3: '小項目' }[s.by] || text(s.by)) + ' ' + ({ ASC: '昇順', DESC: '降順' }[s.order] || text(s.order))).join('\n') || '指定なし' : '取得不可'],
        ['定期レポート', value.periodicReport?.active === true ? '有効' : value.periodicReport?.active === false ? '無効' : '取得不可']);
    }
    return { code: String(value.id), settings: { label: value.name }, identifier: `${categoryId === 'views' ? '一覧' : 'グラフ'}ID：${value.id}`, sections: [{ kind: 'よく見る設定', rows }] };
  }
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (object(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    return JSON.stringify(v);
  }
  // Codes/element IDs are identities; anonymous parts are compared only at the same slot.
  function layoutIndex(layout) {
    const nodes = [], counts = new Map();
    function walk(items, path = []) {
      (items || []).forEach((node, index) => {
        const position = [...path, index];
        if (node.type !== 'ROW') {
          const identity = node.code ? 'code:' + node.code : node.elementId ? 'element:' + node.elementId : '';
          nodes.push({ node, position, identity });
          if (identity) counts.set(identity, (counts.get(identity) || 0) + 1);
        }
        if (node.fields) walk(node.fields, [...position, 'fields']);
        if (node.layout) walk(node.layout, [...position, 'layout']);
      });
    }
    walk(layout);
    return new Map(nodes.map(item => [item.identity && counts.get(item.identity) === 1 ? item.identity : 'slot:' + item.position.join('/'), item]));
  }
  function layoutMarks(before, after, beforeFields = {}, afterFields = {}) {
    const sides = [layoutIndex(before), layoutIndex(after)], marks = [new Map(), new Map()];
    const properties = [flatten(beforeFields), flatten(afterFields)];
    for (const key of new Set([...sides[0].keys(), ...sides[1].keys()])) {
      const a = sides[0].get(key), b = sides[1].get(key), reasons = [];
      if (a && b) {
        if (stable(a.position) !== stable(b.position)) reasons.push('配置位置');
        const own = ({ fields, layout, ...rest }) => rest;
        if (stable(own(a.node)) !== stable(own(b.node))) reasons.push('寸法・部品');
        if (a.node.code && stable(properties[0].get(a.node.code)) !== stable(properties[1].get(b.node.code))) reasons.push('項目設定');
      }
      [a, b].forEach((item, side) => {
        if (item) marks[side].set(item.position.join('/'), { key, kind: !a ? 'added' : !b ? 'deleted' : reasons.length ? 'changed' : '',
          text: !a ? '追加' : !b ? '削除予定' : reasons.join('・'), anonymous: key.startsWith('slot:') });
      });
    }
    return marks;
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
  function fieldCounts(properties) {
    const excluded = new Set(['RECORD_NUMBER', 'CREATOR', 'CREATED_TIME', 'MODIFIER', 'UPDATED_TIME', 'GROUP', 'SUBTABLE']);
    const items = [...flatten(properties).values()];
    const fields = items.filter(item => !excluded.has(item.settings.type));
    return { fields: fields.length, tableFields: fields.filter(item => item.parent).length,
      tables: items.filter(item => item.settings.type === 'SUBTABLE').length,
      groups: items.filter(item => item.settings.type === 'GROUP').length };
  }
  function fieldOverviews(properties) {
    const fields = flatten(properties), result = new Map();
    const value = v => v === undefined || v === null ? '取得不可' : String(v) || '指定なし';
    const ensure = item => {
      if (!result.has(item.code)) result.set(item.code, { ...item, sections: [], groups: [] });
      return result.get(item.code);
    };
    let number = 0;
    for (const item of [...fields.values()].sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0)) {
      const f = item.settings, lookup = Object.hasOwn(f, 'lookup');
      if (lookup || f.type === 'REFERENCE_TABLE') {
        const config = lookup ? f.lookup : f.referenceTable, kind = lookup ? 'ルックアップ' : '関連レコード一覧';
        const overview = ensure(item), rows = [];
        if (lookup) overview.groups.push({ id: ++number, code: item.code, role: 'ルックアップ' });
        if (!object(config)) rows.push(['設定', '取得不可（参照先の権限などを確認してください）']);
        else {
          rows.push(['参照先アプリ', `ID：${value(config.relatedApp?.app)}${config.relatedApp?.code ? ' ／ コード：' + config.relatedApp.code : ''}`]);
          if (lookup) {
            rows.push(['キー（参照先 → このアプリ）', `${value(config.relatedKeyField)} → ${item.code}`],
              ['ほかのフィールドのコピー（参照先 → このアプリ）', Array.isArray(config.fieldMappings)
                ? config.fieldMappings.map(m => `${value(m?.relatedField)} → ${value(m?.field)}`).join('\n') || '指定なし'
                : config.fieldMappings === '' ? '指定なし' : '取得不可']);
            for (const mapping of Array.isArray(config.fieldMappings) ? config.fieldMappings : []) {
              const dest = fields.get(mapping?.field);
              if (!dest) continue;
              const target = ensure(dest);
              if (!target.groups.some(g => g.code === item.code)) target.groups.push({ id: number, code: item.code, role: 'コピー先' });
              target.sections.push({ kind: `L${number} のコピー先`, rows: [
                ['ルックアップ', `${f.label || item.code}（${item.code}）`],
                ['コピー元', `アプリID：${value(config.relatedApp?.app)} ／ ${value(mapping.relatedField)}`]
              ] });
            }
          } else rows.push(['紐付け条件', `このアプリ：${value(config.condition?.field)} ＝ 参照先：${value(config.condition?.relatedField)}`]);
          rows.push([lookup ? 'フィルター（初期設定）' : 'フィルター', value(config.filterCond)]);
        }
        overview.sections.unshift({ kind, rows });
      }
      if (Object.hasOwn(f, 'expression') && (f.expression || f.type === 'CALC')) {
        ensure(item).sections.push({ kind: '計算式', rows: [['式', value(f.expression)]] });
      }
      if (['DROP_DOWN', 'RADIO_BUTTON', 'CHECK_BOX', 'MULTI_SELECT'].includes(f.type)) {
        const options = object(f.options) ? Object.values(f.options).sort((a, b) => Number(a.index) - Number(b.index)) : null;
        ensure(item).sections.push({ kind: '選択肢', rows: [['表示順', options ? options.map(option => value(option.label)).join('\n') || '指定なし' : '取得不可']] });
      }
    }
    // Ordinary fields still need code chips, without duplicating their native settings UI.
    for (const item of fields.values()) ensure(item);
    return result;
  }
  function layoutParts(layout) {
    return [...layoutIndex(layout).values()].filter(({ node }) => ['LABEL', 'SPACER', 'HR'].includes(node.type) && node.elementId)
      .map(({ node, position }) => ({ node, position, code: node.elementId, element: true, groups: [],
        settings: { label: ({ LABEL: 'ラベル', SPACER: 'スペース', HR: '罫線' })[node.type] },
        sections: [] }));
  }
  function layoutElementContainers(layout, canvas) {
    const matched = new Map();
    if (!canvas) return matched;
    const rowSelector = '[data-testid^="row-"]', fieldSelector = '[data-testid^="field-"]';
    const prefixes = { LABEL: 'label-', SPACER: 'spacer-', HR: 'hr-' };
    const text = html => { const t = canvas.ownerDocument.createElement('template'); t.innerHTML = html || ''; return t.content.textContent.replace(/\s+/g, ' ').trim(); };
    const signature = node => node.type + (node.type === 'LABEL' ? ':' + text(node.label) : '');
    function visit(nodes, scope) {
      const parentRow = scope.closest(rowSelector);
      const rows = [...scope.querySelectorAll(rowSelector)].filter(r => r.parentElement.closest(rowSelector) === parentRow);
      if (rows.length !== nodes.length) return;
      const pairs = [], groups = [];
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i], row = rows[i], expected = node.type === 'ROW' ? node.fields : [node];
        const fields = [...row.querySelectorAll(fieldSelector)].filter(f => f.closest(rowSelector) === row && !row.contains(f.parentElement.closest(fieldSelector)));
        if (!Array.isArray(expected) || fields.length !== expected.length) return;
        for (let j = 0; j < expected.length; j++) {
          const item = expected[j], field = fields[j], id = field.getAttribute('data-testid').slice(6);
          if (prefixes[item.type]) {
            const presenter = [...field.querySelectorAll('[data-testid]')].find(n => n.getAttribute('data-testid') === prefixes[item.type] + id);
            if (!presenter || (item.type === 'LABEL' && presenter.textContent.replace(/\s+/g, ' ').trim() !== text(item.label))) return;
            pairs.push({ item, field, signature: signature(item) });
          } else {
            if (!item.code || item.code !== id) return;
            if (item.type === 'GROUP') groups.push({ item, field });
          }
        }
      }
      // Identical anonymous parts cannot be distinguished after a swap; never guess their IDs.
      for (const pair of pairs) if (pair.item.elementId && pairs.filter(p => p.signature === pair.signature).length === 1) matched.set(pair.item.elementId, pair.field);
      for (const { item, field } of groups) visit(item.layout || [], field);
    }
    visit(layout, canvas);
    return matched;
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
  function context(href) {
    const url = new URL(href);
    const route = url.pathname.match(/^\/k\/(?:guest\/(\d+)\/)?admin\/app\/flow\/?$/);
    const app = url.searchParams.get('app');
    if (!route || !/^[1-9]\d*$/.test(app || '')) return null;
    return { app, prefix: route[1] ? `/k/guest/${route[1]}` : '/k' };
  }
  // Match observed native menu destinations, not translated labels or CSS class hashes.
  // General settings are split by known API keys; an unknown key never marks another page.
  function menuTarget(href, baseHref) {
    const ctx = context(baseHref);
    if (!ctx) return null;
    let url;
    try { url = new URL(href, baseHref); } catch { return null; }
    if (url.origin !== new URL(baseHref).origin) return null;
    const base = `${ctx.prefix}/admin/app/`;
    if (url.pathname === `${base}${ctx.app}/plugin/` && ['', '#', '#/'].includes(url.hash) &&
        (!url.searchParams.has('app') || (url.searchParams.getAll('app').length === 1 && url.searchParams.get('app') === ctx.app))) return { category: 'plugins' };
    if (!url.pathname.startsWith(base) || url.searchParams.getAll('app').length !== 1 || url.searchParams.get('app') !== ctx.app) return null;
    const page = url.pathname.slice(base.length).replace(/\/$/, '');
    if (page === 'notification') {
      const category = { app: 'notifyApp', record: 'notifyRecord', reminder: 'notifyReminder' }[url.searchParams.get('trigger')];
      return typeof category === 'string' && url.searchParams.getAll('trigger').length === 1 ? { category } : null;
    }
    const category = { status: 'process', 'acl/app': 'aclApp', 'acl/record': 'aclRecord', 'acl/field': 'aclField', customize: 'customize', action: 'actions' }[page];
    if (typeof category === 'string') return { category };
    const keys = {
      general: ['description', 'icon'], theme: ['theme'], title: ['titleField'],
      info: ['enableThumbnails', 'enableBulkDeletion', 'enableComments', 'enableDuplicateRecord', 'enableInlineRecordEditing', 'numberPrecision', 'firstMonthOfFiscalYear']
    }[page];
    return Array.isArray(keys) ? { category: 'general', keys } : null;
  }
  const CARRY_TTL = 30 * 60 * 1000;
  const CARRY_IDS = new Set(CATEGORIES.map(c => c.id));
  const carryKey = ctx => `nrfd:diff:v2:${ctx.prefix}:${ctx.app}`;
  const saveMarkerKey = ctx => `nrfd:save:v1:${ctx.prefix}:${ctx.app}`;
  function hasSaveMarker(storage, ctx, now = Date.now()) {
    try {
      const raw = storage.getItem(saveMarkerKey(ctx));
      if (raw === null) return false;
      const time = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isFinite(time) || time > now || now - time >= CARRY_TTL) {
        storage.removeItem(saveMarkerKey(ctx)); return false;
      }
      return true;
    } catch { return false; }
  }
  function clearCarry(storage, ctx) {
    try { storage.removeItem(carryKey(ctx)); return true; } catch { return false; }
  }
  function saveCarry(storage, ctx, results, now = Date.now(), ui = {}) {
    try {
      // Keep snapshots needed for form and collection overviews, including unchanged entries.
      const data = { version: 3, app: ctx.app, prefix: ctx.prefix, time: now, ui, results: results.filter(r => CARRY_IDS.has(r.category.id)).map(r => ({
        id: r.category.id, state: r.state, error: r.error, warnings: r.warnings,
        liveRevision: r.liveRevision, previewRevision: r.previewRevision,
        entries: r.entries.map(e => ({ code: e.code, label: e.label, kind: e.kind, rows: e.rows })),
        ...(['fields', 'layout', 'views', 'reports'].includes(r.category.id) && r.state !== 'error' ? { snapshots: r.snapshots } : {})
      })) };
      const value = JSON.stringify(data);
      if (value.length > 1500000) throw new Error('Comparison too large');
      storage.setItem(carryKey(ctx), value);
      storage.removeItem(`nrfd:diff:v1:${ctx.prefix}:${ctx.app}`); return true;
    } catch { clearCarry(storage, ctx); return false; }
  }
  function readCarry(storage, ctx, now = Date.now()) {
    try {
      const raw = storage.getItem(carryKey(ctx));
      if (!raw) return null;
      if (raw.length > 1500000) throw new Error('Invalid size');
      const data = JSON.parse(raw);
      if (data.version !== 3 || (data.stale !== undefined && typeof data.stale !== 'boolean') || data.app !== ctx.app || data.prefix !== ctx.prefix ||
          !Number.isFinite(data.time) || data.time > now || now - data.time >= CARRY_TTL ||
          !Array.isArray(data.results) || data.results.length !== CARRY_IDS.size ||
          new Set(data.results.map(r => r.id)).size !== CARRY_IDS.size) throw new Error('Invalid cache');
      for (const r of data.results) {
        if (!CARRY_IDS.has(r.id) || !['ok', 'partial', 'error'].includes(r.state) ||
            !Array.isArray(r.entries) || !Array.isArray(r.warnings) || r.warnings.some(w => typeof w !== 'string') ||
            (r.state === 'error' ? typeof r.error !== 'string' || r.entries.length !== 0 : !/^\d+$/.test(r.liveRevision) || !/^\d+$/.test(r.previewRevision))) throw new Error('Invalid result');
        for (const e of r.entries) if (typeof e.code !== 'string' || typeof e.label !== 'string' ||
            !['added', 'deleted', 'changed'].includes(e.kind) || !Array.isArray(e.rows) ||
            e.rows.some(row => !object(row) || !Array.isArray(row.path) || row.path.some(p => typeof p !== 'string' && typeof p !== 'number'))) throw new Error('Invalid entry');
        if ((['fields', 'layout'].includes(r.id) || ['views', 'reports'].includes(r.id) && r.snapshots !== undefined) && r.state !== 'error') {
          if (!Array.isArray(r.snapshots) || r.snapshots.length !== 2) throw new Error('Invalid snapshots');
          const category = CATEGORIES.find(c => c.id === r.id);
          for (const snapshot of r.snapshots) validateResponse(category, snapshot);
          if (String(r.snapshots[0].revision) !== r.liveRevision || String(r.snapshots[1].revision) !== r.previewRevision) throw new Error('Invalid revision');
        }
      }
      return data;
    } catch { clearCarry(storage, ctx); return null; }
  }
  function pageDiffContext(href) {
    const url = new URL(href);
    const route = url.pathname.match(/^(\/k(?:\/guest\/[1-9]\d*)?)\/admin\/app\/(?:([1-9]\d*)\/plugin\/|[^?#]+)$/);
    if (!route) return null;
    const app = route[2] || url.searchParams.get('app');
    if (!/^[1-9]\d*$/.test(app || '')) return null;
    const base = `${url.origin}${route[1]}/admin/app/flow?app=${app}`;
    const target = menuTarget(href, base);
    return target ? { app, prefix: route[1], target } : null;
  }
  const STALE_NOTICE = '比較未更新：保存操作後の状態はまだ確認していません。設定を読み込み直してください。';
  function markCarryStale(storage, ctx) {
    try {
      // Save attempts must survive navigation even before the first comparison, or after expiry.
      storage.setItem(saveMarkerKey(ctx), String(Date.now()));
      const cache = readCarry(storage, ctx);
      if (!cache) return true;
      cache.stale = true;
      storage.setItem(carryKey(ctx), JSON.stringify(cache)); return true;
    } catch {
      // If a stale marker cannot be stored, do not restore the result as fresh on return.
      clearCarry(storage, ctx); return false;
    }
  }
  function mountSaveTracking() {
    if (!context(location.href) && !pageDiffContext(location.href)) return;
    if (document.getElementById('nrfd-save-tracker')) return;
    const marker = document.createElement('meta'); marker.id = 'nrfd-save-tracker'; document.head.append(marker);
    document.addEventListener('click', event => {
      const button = event.target.closest?.('[data-testid="shared-admin-pageActionBar-SaveButton"],[data-testid="formSaveButton"]');
      if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
      const ctx = context(location.href) || pageDiffContext(location.href);
      if (!ctx) return;
      try { markCarryStale(window.sessionStorage, ctx); } catch { /* Current-page warning still works. */ }
      document.dispatchEvent(new Event('nrfd-save-attempt'));
    }, true);
  }
  function placeAdminWidgets(widget) {
    const host = document.querySelector('main, [role="main"]');
    if (!host) return;
    // Keep kintone's breadcrumb in its native position, outside our added UI.
    let anchor = host.querySelector('[data-testid="shared-Breadcrumb"]');
    if (anchor) {
      while (anchor.parentElement !== host) anchor = anchor.parentElement;
    } else {
      const heading = host.querySelector('h1, h2');
      anchor = heading?.closest('header') || heading;
    }
    // Wait for the native page shell instead of pushing a late breadcrumb down.
    if (!anchor) { widget.remove(); return; }
    for (const id of ['nrfd-admin-nav', 'nrfd-page-diff']) {
      const node = widget.id === id ? widget : document.getElementById(id);
      if (!node) continue;
      if (anchor.nextElementSibling !== node) anchor.after(node);
      anchor = node;
    }
  }
  function mountPageDiff() {
    if (!pageDiffContext(location.href) || document.getElementById('nrfd-page-style')) return;
    const make = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
    const root = make('section', undefined, 'nrfd-page-diff'); root.id = 'nrfd-page-diff'; root.setAttribute('aria-label', 'この設定の取得済み差分');
    const style = make('style'); style.id = 'nrfd-page-style';
    style.textContent = `
      .nrfd-page-diff{font:13px/1.6 sans-serif;color:#203149;background:#fff;border:1px solid #cbd7e5;border-radius:7px;padding:10px 14px;margin:12px 16px}
      .nrfd-page-diff p{margin:5px 0;color:#607187;font-size:12px}.nrfd-page-diff summary{cursor:pointer;font-weight:600}.nrfd-page-diff summary:focus-visible{outline:3px solid #286acb;outline-offset:2px}
      .nrfd-page-diff .nrfd-stale-warning{padding:8px 10px;background:#fff3d2;color:#805200;border:1px solid #e5c877;border-radius:5px;font-weight:600}
      .nrfd-page-state{display:inline-block;padding:1px 7px;margin-right:8px;border:1px solid #e5c877;border-radius:10px;background:#fff3d2;color:#805200}
      .nrfd-page-body{max-height:50vh;overflow:auto;margin-top:10px}.nrfd-page-body h4{font-size:13px;margin:14px 0 6px}.nrfd-page-body table{border-collapse:collapse;table-layout:fixed;width:100%;font-size:12px}
      .nrfd-page-body th,.nrfd-page-body td{border:1px solid #dce4ee;text-align:left;vertical-align:top;padding:8px;white-space:pre-wrap;overflow-wrap:anywhere}.nrfd-page-body thead th{background:#f2f6fb}.nrfd-page-body td:last-child{background:#f1f9f5}
    `;
    document.head.append(style);
    let signature = '', timer, expiry, stopped = false, localStale = false;
    function draw() {
      if (stopped) return;
      observer.disconnect(); clearTimeout(expiry);
      const ctx = pageDiffContext(location.href);
      if (!ctx) { root.remove(); signature = ''; }
      else {
        let cache = null, saved = false;
        try { cache = readCarry(window.sessionStorage, ctx); saved = hasSaveMarker(window.sessionStorage, ctx); } catch { /* Storage may be disabled. */ }
        if (cache && !cache.stale && !saved) localStale = false;
        const result = cache?.results.find(r => r.id === ctx.target.category);
        const next = JSON.stringify([ctx, cache, localStale, saved]);
        if (next !== signature) {
          signature = next; root.replaceChildren();
          if (cache?.stale || localStale || saved) { const warning = make('p', STALE_NOTICE, 'nrfd-stale-warning'); warning.setAttribute('role', 'status'); root.append(warning); }
          if (!result) root.append(make('strong', '差分：未取得・期限切れ'), make('p', 'アプリの設定に戻り「設定を読み込む」で全カテゴリを取得してください。'));
          else {
            const entries = result.entries.filter(e => !ctx.target.keys || ctx.target.keys.includes(e.code));
            const state = result.state === 'error' ? '取得失敗' : entries.length ? '変更あり' : result.state === 'partial' ? '一部比較不可' : '変更なし';
            const meta = make('p', `${new Date(cache.time).toLocaleString('ja-JP')} 取得時点${result.state !== 'error' ? ` ／ 運用中 r${result.liveRevision} → 保存済みプレビュー r${result.previewRevision}` : ''}。未保存の編集・取得後の変更は含みません。`);
            if (entries.length) {
              const details = make('details'), summary = make('summary');
              summary.append(make('span', state, 'nrfd-page-state'), document.createTextNode('差分を見る'));
              const body = make('div', undefined, 'nrfd-page-body');
              for (const entry of entries) {
                body.append(make('h4', `${entry.label} — ${KINDS[entry.kind]}`));
                const table = make('table'), head = make('thead'), tr = make('tr');
                for (const text of ['設定項目', '運用中', '保存済みプレビュー']) { const th = make('th', text); th.scope = 'col'; tr.append(th); }
                head.append(tr); table.append(head); const rows = make('tbody');
                for (const row of entry.rows) {
                  const line = make('tr'), th = make('th', row.path.map(displayName).join(' / ') || '設定全体'); th.scope = 'row';
                  line.append(th, make('td', formatSetting(row.before)), make('td', formatSetting(row.after))); rows.append(line);
                }
                table.append(rows); body.append(table);
              }
              details.append(summary, body); root.append(details);
            } else root.append(make('strong', `差分：${state}`));
            root.append(meta);
            if (result.state === 'error') root.append(make('p', result.error));
            if (result.warnings.length) root.append(make('p', result.warnings.join('\n')));
            root.append(make('p', '保存後はアプリの設定に戻って再取得してください。差分はこのタブ内で30分間保持します。'));
          }
        }
        placeAdminWidgets(root);
        if (cache) expiry = setTimeout(draw, Math.max(1, cache.time + CARRY_TTL - Date.now()));
      }
      observer.observe(document.body, { childList: true, subtree: true });
    }
    const observer = new MutationObserver(records => {
      const own = node => (node.nodeType === 1 ? node : node.parentElement)?.closest('#nrfd-page-diff,#nrfd-page-style,#nrfd-admin-nav');
      if (root.isConnected && records.every(r => own(r.target) || (r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].length && [...r.addedNodes, ...r.removedNodes].every(own)))) return;
      clearTimeout(timer); timer = setTimeout(draw, 120);
    });
    for (const event of ['hashchange', 'popstate', 'focus']) window.addEventListener(event, draw);
    document.addEventListener('nrfd-save-attempt', () => { localStale = true; draw(); });
    window.addEventListener('pagehide', () => { stopped = true; observer.disconnect(); clearTimeout(timer); clearTimeout(expiry); });
    window.addEventListener('pageshow', () => { stopped = false; draw(); });
    draw();
  }
  /* QuickTabs navigation: adapted from youtotto/kintone-admin-quick-tabs v1.0.1.
   * MIT License
   * 
   * Copyright (c) 2025 Yuto Kawai
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
   */
  const ADMIN_GROUPS = [
    { id: 'acl', label: 'アクセス権', pages: [['acl/app', 'アプリ権限'], ['acl/record', 'レコード権限'], ['acl/field', 'フィールド権限']] },
    { id: 'notify', label: '通知', pages: [['notification:app', 'アプリの条件通知'], ['notification:record', 'レコードの条件通知'], ['notification:reminder', 'リマインダー']] },
    { id: 'customize', label: 'カスタマイズ', pages: [['plugin', 'プラグイン'], ['customize', 'JS / CSS'], ['apitoken', 'APIトークン'], ['webhook', 'Webhook']] }
  ];
  function adminContext(href) {
    const url = new URL(href);
    const path = url.pathname.match(/^(\/k(?:\/guest\/[1-9]\d*)?)\/admin\/app\/(.+?)\/?$/);
    if (!path) return null;
    const plugin = path[2].match(/^([1-9]\d*)\/plugin$/);
    const queryApp = url.searchParams.get('app');
    const app = plugin ? plugin[1] : queryApp;
    if (!/^[1-9]\d*$/.test(app || '') || (plugin && queryApp && queryApp !== app)) return null;
    let page = plugin ? 'plugin' : path[2];
    if (page === 'plugin' && !plugin) return null;
    // Plugin configuration subroutes belong to the plugin, not to the app settings navigation.
    if (plugin && !['', '#', '#/'].includes(url.hash)) return null;
    if (page === 'notification') {
      const trigger = url.searchParams.get('trigger');
      if (!['app', 'record', 'reminder'].includes(trigger)) return null;
      page += ':' + trigger;
    }
    const group = ADMIN_GROUPS.find(g => g.pages.some(([id]) => id === page))?.id;
    if (page !== 'flow' && !group) return null;
    return { app, prefix: path[1], page, group: group || null };
  }
  function adminUrl(ctx, page) {
    const base = `${ctx.prefix}/admin/app/`, app = encodeURIComponent(ctx.app);
    if (page === 'plugin') return `${base}${app}/plugin/#/`;
    if (page.startsWith('notification:')) return `${base}notification?app=${app}&trigger=${page.split(':')[1]}`;
    return `${base}${page}?app=${app}`;
  }
  function mountAdminNavigation() {
    if (!adminContext(location.href) || document.getElementById('nrfd-admin-style')) return;
    const nav = document.createElement('nav'); nav.id = 'nrfd-admin-nav'; nav.className = 'nrfd-admin-nav';
    nav.setAttribute('aria-label', '設定画面への移動');
    const style = document.createElement('style'); style.id = 'nrfd-admin-style';
    style.textContent = `
      .nrfd-admin-nav{font:13px/1.5 sans-serif;color:#23436a;box-sizing:border-box;background:#fff;border:1px solid #cbd7e5;border-radius:7px;padding:10px 12px;margin:12px 16px}
      .nrfd-admin-nav[hidden]{display:none}.nrfd-admin-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
      .nrfd-admin-nav a{display:inline-flex;align-items:center;padding:5px 10px;border:1px solid #c5d2e2;border-radius:5px;background:#fff;color:#245c86;text-decoration:none;white-space:nowrap}
      .nrfd-admin-nav a:hover{background:#edf6ff}.nrfd-admin-nav a:focus-visible{outline:3px solid #286acb;outline-offset:2px}
      .nrfd-admin-nav a[aria-current=page]{background:#2368b1;border-color:#2368b1;color:#fff}
      .nrfd-admin-extra{display:flex;gap:6px;margin-left:auto;flex-wrap:wrap}.nrfd-admin-nav small{color:#63738a;margin-left:6px}
    `;
    document.head.append(style);
    let current = null, signature = '', timer = null, stopped = false;
    const legacy = () => document.querySelector('.tm-admin-toolbar-row[id^="tm-admin-toolbar-row--"]');
    const link = (text, href) => { const a = document.createElement('a'); a.textContent = text; a.href = href; return a; };
    function draw(ctx) {
      nav.replaceChildren();
      const group = ADMIN_GROUPS.find(g => g.id === ctx.group);
      if (!group) return;
      const pages = document.createElement('div'); pages.className = 'nrfd-admin-row nrfd-admin-pages';
      group.pages.forEach(([id, text], index) => {
        const a = link(text, adminUrl(ctx, id)); a.dataset.shortcut = String(index + 1);
        a.title = `Alt＋${index + 1}`; a.setAttribute('aria-keyshortcuts', `Alt+${index + 1}`);
        if (ctx.page === id) a.setAttribute('aria-current', 'page'); pages.append(a);
      });
      const hint = document.createElement('small'); hint.textContent = `Alt＋1〜${group.pages.length}`; pages.append(hint);
      if (ctx.group !== 'customize') {
        const extras = document.createElement('span'); extras.className = 'nrfd-admin-extra';
        for (const [text, url] of [['組織 / ユーザー', '/admin/directory/#active=ignore&offset=0&org=all'], ['グループ', '/admin/group/']]) {
          const a = link(text, url); a.target = '_blank'; a.rel = 'noopener noreferrer'; extras.append(a);
        }
        pages.append(extras);
      }
      nav.append(pages);
    }
    function mount() {
      observer.disconnect();
      if (stopped) return;
      current = adminContext(location.href);
      if (!current?.group) { nav.remove(); signature = ''; }
      else {
        const next = JSON.stringify(current);
        if (next !== signature) { draw(current); signature = next; }
        placeAdminWidgets(nav);
        // Leave the standalone script in control when it is still enabled, including its hotkeys.
        nav.hidden = !!legacy();
      }
      observer.observe(document.body, { childList: true, subtree: true });
    }
    const observer = new MutationObserver(records => {
      const own = node => (node.nodeType === 1 ? node : node.parentElement)?.closest('#nrfd-admin-nav,#nrfd-admin-style,#nrfd-page-diff,#nrfd-page-style,.nrfd-dialog,.nrfd-field-info,.nrfd-chip,.nrfd-menu-chip,.nrfd-tab-chip,.nrfd-row-tools,.nrfd-hover,.nrfd-floating-tools');
      if (records.every(r => own(r.target) || (r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].length && [...r.addedNodes, ...r.removedNodes].every(own)))) return;
      clearTimeout(timer); timer = setTimeout(mount, 80);
    });
    window.addEventListener('keydown', event => {
      if (stopped || event.defaultPrevented || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat || event.isComposing || !/^[1-4]$/.test(event.key)) return;
      if (!current?.group || nav.hidden || !nav.isConnected || legacy()) return;
      if (event.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]') || document.querySelector('dialog[open],[role="dialog"][aria-modal="true"]')) return;
      const a = nav.querySelector(`[data-shortcut="${event.key}"]`);
      if (a) { event.preventDefault(); a.click(); }
    });
    window.addEventListener('hashchange', mount);
    window.addEventListener('popstate', mount);
    window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); observer.disconnect(); });
    window.addEventListener('pageshow', event => { if (event.persisted) { stopped = false; mount(); } });
    mount();
  }
  async function getSettings(ctx, category, preview, signal, fetcher = fetch) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 20000);
    try {
      const url = `${ctx.prefix}/v1/${preview ? 'preview/' : ''}${category.path}.json?app=${encodeURIComponent(ctx.app)}`;
      const response = await fetcher(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store',
        headers: { 'X-Requested-With': 'XMLHttpRequest' }, signal: controller.signal });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`設定を取得できません（${data?.code || response.status}）。管理権限・通信状態・公開状況を確認してください。`);
      return validateResponse(category, data);
    } catch (error) {
      throw new Error(`${preview ? 'プレビュー' : '運用中'}：${error.name === 'AbortError' ? '通信が中断またはタイムアウトしました。' : error.message}`);
    } finally {
      clearTimeout(timeout); signal?.removeEventListener('abort', abort);
    }
  }
  async function collectSettings(ctx, signal, fetcher = fetch, progress = () => {}) {
    const categories = CATEGORIES;
    const results = new Array(categories.length);
    // Cache hashes only during this explicit collection; never persist or execute downloaded bytes.
    const downloads = new Map(), hashes = new Map();
    async function fingerprint(file) {
      if (!file || typeof file.fileKey !== 'string' || !/^\d+$/.test(file.size)) return;
      const key = file.fileKey;
      if (!downloads.has(key)) downloads.set(key, (async () => {
        const controller = new AbortController(), abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        const timeout = setTimeout(abort, 20000);
        try {
          const response = await fetcher(`${ctx.prefix}/v1/file.json?fileKey=${encodeURIComponent(key)}`, {
            method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
            headers: { 'X-Requested-With': 'XMLHttpRequest' }, signal: controller.signal
          });
          if (!response.ok) throw new Error('File download failed');
          const bytes = await response.arrayBuffer();
          if (bytes.byteLength !== Number(file.size)) throw new Error('Incomplete file');
          const digest = await crypto.subtle.digest('SHA-256', bytes);
          hashes.set(key, [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join(''));
        } catch { /* Missing hashes are reported as partial comparison, never unchanged. */ }
        finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
      })());
      await downloads.get(key);
    }
    let next = 0, completed = 0;
    async function pair(category) {
      const values = await Promise.allSettled([false, true].map(preview => getSettings(ctx, category, preview, signal, fetcher)));
      const errors = values.filter(v => v.status === 'rejected');
      if (errors.length) throw new Error(errors.map(v => v.reason.message).join('\n'));
      return values.map(v => v.value);
    }
    async function worker() {
      while (next < categories.length && !signal?.aborted) {
        const index = next++, category = categories[index];
        try {
          const values = await pair(category);
          // Sequential downloads per worker retain the global six-request upper bound.
          for (const data of values) for (const entry of settingFiles(category, data)) {
            if (signal?.aborted) throw new Error('比較を中断しました。');
            await fingerprint(entry.file);
          }
          results[index] = compareCategory(category, ...values, hashes);
        }
        catch (error) { results[index] = { category, state: 'error', entries: [], warnings: [], error: error.message }; }
        progress(++completed);
      }
    }
    // At most six requests in flight; each category can fail without hiding the others.
    await Promise.all([worker(), worker(), worker()]);
    if (signal?.aborted) throw new Error('比較を中断しました。');
    const successful = results.filter(r => r.state !== 'error');
    if (successful.length) {
      let reason = '';
      try {
        const final = await pair(successful[0].category);
        if (successful.some(r => r.liveRevision !== String(final[0].revision) || r.previewRevision !== String(final[1].revision))) {
          reason = '取得中に設定が変更されたため、結果を表示できません。「設定を再取得」してください。';
        }
      } catch { reason = '取得後のリビジョン確認に失敗しました。「設定を再取得」してください。'; }
      if (reason) for (const r of successful) Object.assign(r, { state: 'error', entries: [], error: reason });
    }
    return results;
  }
  // CommonJS export keeps the exact shipped comparison code testable without a build step.
  if (typeof module === 'object' && module.exports) {
    module.exports = { compare, changes, flatten, stable, format, context, CATEGORIES, compareCategory, validateResponse, formatSetting, collectSettings, layoutIndex, layoutMarks, fieldOverviews, fieldCounts, layoutParts, layoutElementContainers, adminContext, adminUrl, ADMIN_GROUPS, menuTarget, pageDiffContext, carryKey, saveCarry, readCarry, clearCarry, CARRY_TTL, markCarryStale, saveMarkerKey, hasSaveMarker };
    return;
  }
  mountAdminNavigation();
  mountSaveTracking();
  mountPageDiff();
  const ctx = context(location.href);
  if (!ctx || document.getElementById('nrfd-root')) return;

  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const root = el('section', undefined, 'nrfd');
  root.id = 'nrfd-root'; root.dataset.version = '0.9.2'; root.setAttribute('aria-label', 'kintone Config Lens');
  const style = el('style');
  style.textContent = `
    .nrfd,.nrfd-dialog{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#203149;text-align:left}
    .nrfd{background:#fff;border:1px solid #cbd7e5;border-left:4px solid #326dd3;border-radius:8px;padding:12px 16px;margin:12px 16px;box-sizing:border-box}
    .nrfd-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.nrfd-title{font-size:15px;margin-right:8px}
    .nrfd-fetch-controls{display:inline-flex;gap:8px;align-items:center;flex:none;white-space:nowrap}.nrfd-api-count{font-size:12px;color:#526479}
    .nrfd button,.nrfd-dialog button,.nrfd-chip{font:inherit;cursor:pointer;border:1px solid #c5d2e2;border-radius:6px;padding:5px 12px;background:#fff;color:#23436a}
    .nrfd button:disabled{opacity:.5;cursor:default}.nrfd button:hover,.nrfd-dialog button:hover{background:#f0f5fc}
    .nrfd button.nrfd-start-button{background:#2368b1;color:#fff;border-color:#2368b1;font-weight:600;box-shadow:0 0 0 3px #2368b11a}.nrfd button.nrfd-start-button:hover{background:#1b5695}
    .nrfd[data-awaiting-load=true] .nrfd-status{padding:8px 10px;background:#edf6ff;border-radius:5px;color:#185a8d}
    .nrfd button:focus-visible,.nrfd-dialog button:focus-visible,.nrfd-chip:focus-visible{outline:3px solid #286acb;outline-offset:2px}
    .nrfd-note{font-size:12px;color:#526479;margin:7px 0 0}.nrfd-status{margin:6px 0 0;white-space:pre-wrap}.nrfd-status[data-error=true]{color:#aa2634}
    .nrfd .nrfd-stale-warning{padding:8px 10px;margin:8px 0;background:#fff3d2;color:#805200;border:1px solid #e5c877;border-radius:5px;font-weight:600}.nrfd-stale-warning[hidden]{display:none}
    .nrfd-chip{display:inline-block;font:600 11px/1.5 sans-serif;padding:2px 7px;margin:2px 4px;border-radius:12px;vertical-align:middle;position:relative;z-index:2;white-space:nowrap}
    .nrfd-menu-chip{display:inline-block;flex:none;font:600 11px/1.5 sans-serif;padding:1px 6px;margin-left:8px;border:1px solid #e5c877;border-radius:10px;vertical-align:middle;white-space:nowrap;color:#805200;background:#fff3d2}
    .nrfd-menu-chip[data-state=error],.nrfd-menu-chip[data-state=partial]{color:#705762;background:#f5eef1;border-color:#cdb6c1}
    .nrfd-tab-chip,.nrfd-row-badge{display:inline-block;font:11px/1.3 sans-serif;padding:1px 6px;margin-left:8px;border:1px solid #cbd7e5;border-radius:9px;white-space:nowrap;vertical-align:middle;color:#526479;background:#f5f6f8}
    .nrfd-row-tools{display:inline-flex;align-items:center;margin-left:8px;vertical-align:middle;gap:5px}.nrfd-row-tools .nrfd-row-badge{margin-left:0}.nrfd-row-tools button{font:11px/1.3 sans-serif;padding:1px 6px;cursor:pointer}.nrfd-option[hidden]{display:none}
    /* kintone's fieldOverlay uses z-index:49; chips must receive pointer input above it. */
    .nrfd-anchor{position:relative}.nrfd-field-info>.nrfd-chip{position:relative;flex:none;order:-1;margin:0}
    .nrfd-help{font-size:12px;color:#526479}.nrfd-help summary{cursor:pointer;width:fit-content}.nrfd-option{display:inline-flex;gap:7px;align-items:center;flex-wrap:wrap;padding:6px 9px;border:1px solid #cbd7e5;border-radius:6px;cursor:pointer;background:#f5f6f8}.nrfd-option[data-enabled=true]{background:#edf6ff;border-color:#8db7e5}.nrfd-option input{accent-color:#2368b1;width:16px;height:16px;margin:0}.nrfd-option small{color:#526479;font-size:11px}.nrfd-option-state{font-size:11px;color:#526479}.nrfd-option[data-enabled=true] .nrfd-option-state{font-weight:600;color:#185a8d}
    .nrfd.nrfd-floating-tools{position:fixed;right:16px;bottom:16px;z-index:9990;margin:0;padding:8px 10px;max-width:calc(100vw - 32px);box-shadow:0 4px 18px #182b4630}.nrfd-floating-tools[hidden]{display:none}
    .nrfd-field-info{display:inline-flex;flex-wrap:wrap;align-items:center;gap:4px;max-width:calc(100% - 12px);min-width:0}
    /* Reserve a footer outside the native draggable content, including below a whole table.
       Inline-size containment keeps long codes from widening fields or table columns. */
    /* Table fields may inherit 100% cell height. Leave room for the footer instead of overflowing it.
       flow-root contains the footer's bottom margin; rules disappear with the last info chip. */
    .nrfd-anchor:has(>.nrfd-field-info){display:flow-root;height:auto}
    .nrfd-anchor:has(>.nrfd-field-info)>[data-testid="fieldMovable"]{height:auto}
    .nrfd-anchor>.nrfd-field-info{display:flex;position:relative;justify-content:flex-end;box-sizing:border-box;margin:0 8px 4px;contain:inline-size;z-index:51}
    .nrfd-info-button{font:11px/1.5 sans-serif;color:var(--nrfd-ink,#245c86);background:var(--nrfd-fill,#eaf5fc);border:1px solid currentColor;border-radius:5px;padding:3px 7px;cursor:pointer;max-width:min(180px,100%);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .nrfd-info-button.nrfd-combined{display:inline-flex;align-items:stretch;padding:0;min-width:0;max-width:100%}
    .nrfd-info-segment{display:block;padding:3px 6px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--nrfd-ink,#245c86);background:var(--nrfd-fill,#eaf5fc);flex:0 1 auto}
    .nrfd-info-segment+.nrfd-info-segment{border-left:1px solid #abc6dc}
    .nrfd-info-segment.nrfd-code-segment{flex:1 1 auto;min-width:0}.nrfd-info-segment.nrfd-fx-segment{flex:0 0 auto}
    .nrfd-info-button:focus-visible{outline:3px solid #286acb;outline-offset:2px}
    .nrfd-hover{position:fixed;z-index:10000;width:420px;max-width:calc(100vw - 24px);max-height:min(440px,65vh);overflow:auto;box-sizing:border-box;padding:14px 16px;background:#fff;border:1px solid #aacde4;border-radius:8px;box-shadow:0 8px 28px #182b4640;font:13px/1.6 sans-serif;color:#203149;overflow-wrap:anywhere}
    .nrfd-summary-rows{margin:8px 0 16px}.nrfd-summary-rows dt{font-weight:600;color:#526479;margin-top:6px}.nrfd-summary-rows dd{margin:2px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}.nrfd-overview-title{font-size:14px;margin:12px 0 4px}
    .nrfd-changed{color:#805200!important;background:#fff3d2!important;border-color:#e5c877!important}
    .nrfd-added{color:#116342!important;background:#e2f6ed!important;border-color:#8fceb3!important}
    .nrfd-deleted{color:#9b3344!important;background:#fcebee!important;border-color:#e2b0b8!important}
    .nrfd-dialog{border:1px solid #cad5e3;border-radius:12px;box-shadow:0 18px 65px #182b4655;padding:0;width:min(820px,calc(100vw - 40px));max-height:82vh;background:white}
    .nrfd-dialog::backdrop{background:#162a4655}.nrfd-dialog-head{padding:18px 22px;border-bottom:1px solid #dbe3ed;display:flex;align-items:start;gap:12px}
    .nrfd-dialog h2{font-size:18px;margin:0;flex:1}.nrfd-dialog-body{padding:16px 22px;overflow:auto;max-height:65vh}
    .nrfd-meta{font-size:12px;color:#607187;margin:0 0 14px;overflow-wrap:anywhere}.nrfd-table{width:100%;border-collapse:collapse;table-layout:fixed}
    .nrfd-table th,.nrfd-table td{text-align:left;vertical-align:top;padding:10px;border:1px solid #dce4ee;white-space:pre-wrap;overflow-wrap:anywhere}
    .nrfd-table th{background:#f2f6fb;font-weight:600}.nrfd-table td:last-child{background:#f1f9f5}
    .nrfd-list{display:grid;gap:8px}.nrfd-list button{text-align:left;display:flex;align-items:center;gap:10px;overflow-wrap:anywhere}
    .nrfd-list-code{color:#607187;font-size:12px}.nrfd-empty{color:#607187;padding:20px 0}
    .nrfd select{font:inherit;max-width:100%;padding:5px;border:1px solid #c5d2e2;border-radius:6px;background:#fff;color:#23436a}
    .nrfd-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px}
    .nrfd-summary button{text-align:left;padding:12px;white-space:pre-wrap}.nrfd-summary .nrfd-failed{border-color:#c36a78;color:#9b3344}
    .nrfd-layout-dialog{width:calc(100vw - 48px);max-width:1600px;max-height:94vh}.nrfd-layout-dialog .nrfd-dialog-body{max-height:77vh}
    .nrfd-layout-tools{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px}.nrfd-layout-tools select{font:inherit;padding:4px}
    .nrfd-layout-pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;min-width:560px}
    .nrfd-layout-side{min-width:0;border:1px solid #ccd8e5;border-radius:8px;overflow:hidden}.nrfd-layout-side h3{margin:0;padding:10px 14px;background:#edf3fa;font-size:15px}
    .nrfd-layout-scroll{overflow:auto;max-height:56vh;background:#f6f8fb;padding:14px}.nrfd-layout-canvas{width:max-content;min-width:100%;box-sizing:border-box}
    .nrfd-layout-row{display:flex;align-items:flex-start;gap:8px;margin-bottom:12px;width:max-content;min-height:20px}
    .nrfd-layout-node{position:relative;box-sizing:border-box;padding:10px;border:1px solid #ccd7e4;border-radius:5px;background:#fff;flex:none;overflow-wrap:anywhere}
    .nrfd-layout-node h4{font-size:14px;margin:0 0 6px;line-height:1.4}.nrfd-layout-code{font-size:10px;color:#63738a;display:block;margin:4px 0}
    .nrfd-layout-input{border:1px solid #bccada;border-radius:3px;background:#fafbfd;color:#63738a;padding:7px;box-sizing:border-box;min-height:34px;font-size:12px;white-space:pre-wrap;overflow:hidden}
    .nrfd-layout-badge{display:block;font-size:11px;font-weight:600;margin-bottom:6px}.nrfd-layout-container{width:max-content;min-width:240px;margin-bottom:12px;background:#f0f4fa}
    .nrfd-layout-container>.nrfd-layout-row{margin-bottom:0}.nrfd-layout-label{white-space:pre-wrap}.nrfd-layout-space{border:1px dashed #a5b4c7;color:#78889c;height:100%;min-height:32px;text-align:center}
    .nrfd-layout-node.nrfd-layout-selected{outline:3px solid #326dd3;outline-offset:2px}.nrfd-layout-codebutton{font-size:11px!important;padding:2px 6px!important}
  `;
  document.head.append(style);
  const header = el('div', undefined, 'nrfd-head');
  header.append(el('strong', 'Config Lens', 'nrfd-title'));
  const counts = new Map();
  let entries = [], loaded = false, busy = false, stopped = false, requestId = 0;
  let results = [], selected = 'all';
  let statusText = 'はじめに「設定を読み込む」を押してください。差分確認・設定チップ・フィールド数を利用できます。', isError = false, lastCheck = '', dialog = null, trigger = null;
  let attempted = false, showDiff = true, showInfo = true, showCodes = false, comparisonStale = false;
  let aborter = null, timer = null, saveNotice = false;
  const chips = new Set();
  const anchors = new Set();
  const overviewBindings = [];
  const collectionBindings = [];
  let hover = null, hoverOwner = null, hoverTimer = null, restoringFocus = false;
  const relationColors = [['#185a8d','#e8f3fc'], ['#7740a1','#f4ebfc'], ['#24683e','#eaf6ed'], ['#924a14','#fff0e2'], ['#9b315e','#fdebf2'], ['#26696d','#e6f5f5']];
  const button = (text, fn, className) => {
    const b = el('button', text, className); b.type = 'button'; b.addEventListener('click', fn); return b;
  };
  const categorySelect = el('select'); categorySelect.setAttribute('aria-label', '比較カテゴリ');
  for (const category of [{ id: 'all', label: '全カテゴリ' }, ...CATEGORIES]) { const option = el('option', category.label); option.value = category.id; categorySelect.append(option); }
  categorySelect.addEventListener('change', () => { selected = categorySelect.value; closeDialog(); selectResult(); render(); });
  header.append(categorySelect);
  for (const kind of Object.keys(KINDS)) {
    const b = button(`${KINDS[kind]} —`, () => openList(kind), `nrfd-${kind}`);
    counts.set(kind, b); header.append(b);
  }
  const all = button('差分一覧', () => openList());
  const refresh = button('設定を再取得', () => load());
  const fetchControls = el('span', undefined, 'nrfd-fetch-controls');
  const apiCount = el('span', `API：通常${CATEGORIES.length * 2 + 2}回`, 'nrfd-api-count');
  apiCount.title = `毎回、全${CATEGORIES.length}カテゴリの運用中・プレビュー設定と、整合性確認2回を取得します。`;
  fetchControls.append(refresh, apiCount);
  header.append(all);
  header.insertBefore(fetchControls, categorySelect);
  const floatingTools = el('div', undefined, 'nrfd nrfd-head nrfd-floating-tools');
  floatingTools.setAttribute('role', 'group'); floatingTools.setAttribute('aria-label', '表示切替'); floatingTools.hidden = true;
  function displayCheckbox(name, description, checked, change, target = floatingTools) {
    const label = el('label', undefined, 'nrfd-option'), input = el('input'), state = el('span', '', 'nrfd-option-state');
    input.type = 'checkbox'; input.checked = checked; input.setAttribute('aria-label', name);
    input.addEventListener('change', () => { change(input.checked); closeDialog(); render(); });
    label.append(input, el('span', name), state);
    if (description) label.append(el('small', description));
    target.append(label); return { input, state, label };
  }
  const floatingDiffToggle = displayCheckbox('差分チップ', '', showDiff, checked => { showDiff = checked; }, floatingTools);
  const floatingInfoToggle = displayCheckbox('設定チップ', '', showInfo, checked => { showInfo = checked; }, floatingTools);
  const floatingCodeToggle = displayCheckbox('フィールドコード', '', showCodes, checked => { showCodes = checked; }, floatingTools);
  const status = el('p', '', 'nrfd-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const staleWarning = el('p', STALE_NOTICE, 'nrfd-stale-warning'); staleWarning.hidden = true; staleWarning.setAttribute('role', 'status');
  const help = el('details', undefined, 'nrfd-help');
  help.append(el('summary', '比較について'));
  help.append(el('p', '運用中 ↔ 保存済みプレビュー。未保存の編集は含みません。各設定を保存してこの画面に戻り「設定を再取得」してください。', 'nrfd-note'));
  root.append(header, status);
  status.after(staleWarning);
  help.append(el('p', '全体の件数は差分があるカテゴリ数、カテゴリ選択後の件数は差分項目数です。通知・権限のルール配列は順序を含めて1項目と数えます。コード変更は削除＋追加です。', 'nrfd-note'));
  const fieldCountNote = el('p', 'フィールド数：未取得', 'nrfd-note nrfd-field-count');
  fieldCountNote.title = '保存済みプレビューを集計。システム項目・ラベル・罫線・スペースは除外。テーブル内フィールドは総数に含み、テーブル・グループ自体は別集計です。';
  root.append(fieldCountNote, help);
  const categoryNote = el('p', '', 'nrfd-note'); help.append(categoryNote);
  const overviewNote = el('p', '', 'nrfd-note'); help.append(overviewNote);
  const menuNote = el('p', '設定メニューの「変更あり」は取得時点の保存済み設定の差分です。チップがない項目には未取得・未対応も含まれます。', 'nrfd-note');
  help.append(menuNote);
  const carryNote = el('p', '', 'nrfd-note'); carryNote.hidden = true; root.append(carryNote);
  function restoreCarry() {
    try {
      comparisonStale = hasSaveMarker(window.sessionStorage, ctx);
      const cache = readCarry(window.sessionStorage, ctx);
      if (!cache) return false;
      // Old caches may lack collection snapshots; their tab comparisons remain usable.
      const restored = cache.results.map(r => {
        const category = CATEGORIES.find(c => c.id === r.id);
        if (r.snapshots && ['fields', 'layout', 'views', 'reports'].includes(r.id) && r.state !== 'error') return compareCategory(category, ...r.snapshots);
        return { ...r, category, entries: r.entries.map(e => ({ ...e, categoryId: r.id })) };
      });
      results = restored; attempted = true; busy = false; comparisonStale = comparisonStale || !!cache.stale;
      lastCheck = new Date(cache.time).toLocaleTimeString('ja-JP');
      const ui = cache.ui;
      if (ui && (ui.selected === 'all' || CARRY_IDS.has(ui.selected))) selected = ui.selected;
      if (typeof ui?.showDiff === 'boolean') showDiff = ui.showDiff;
      if (typeof ui?.showInfo === 'boolean') showInfo = ui.showInfo;
      if (typeof ui?.showCodes === 'boolean') showCodes = ui.showCodes;
      categorySelect.value = selected; selectResult();
      return true;
    } catch { return false; }
  }

  function attachMenuChips() {
    document.querySelectorAll('.nrfd-menu-chip').forEach(chip => chip.remove());
    const active = document.querySelector('[role="tab"][id="settings"][aria-selected="true"]');
    menuNote.hidden = !active;
    if (!active || busy || !results.length || !showDiff) return;
    const panel = document.querySelector('[role="tabpanel"][aria-labelledby~="settings"]');
    if (!panel) return;
    for (const link of panel.querySelectorAll('a[href]')) {
      const target = menuTarget(link.getAttribute('href'), location.href);
      if (!target) continue;
      const result = results.find(r => r.category.id === target.category);
      if (!result) continue;
      const changed = result.state !== 'error' && result.entries.some(e => !target.keys || target.keys.includes(e.code));
      const label = result.state === 'error' ? '取得失敗' : changed ? '変更あり' : result.state === 'partial' ? '一部比較不可' : '';
      if (!label) continue;
      const chip = el('span', label, 'nrfd-menu-chip');
      chip.dataset.state = result.state;
      chip.title = (comparisonStale ? STALE_NOTICE + ' ' : '') + `${lastCheck} 取得時点。運用中と保存済みプレビューの比較。未保存の編集は含みません。` +
        (result.state === 'error' ? ` ${result.error}` : result.state === 'partial' ? ' 一部比較不可。取得できた範囲の差分です。' : '') +
        ' 詳細は上部の比較カテゴリを選んで「差分一覧」で確認できます。';
      // A passive label inside the native link preserves navigation and its keyboard behavior.
      link.append(chip);
    }
  }

  function bindSummary(owner, item, revision, row = null) {
    let pending = null;
    const reveal = () => showHover(owner, item, revision);
    const enter = () => { clearTimeout(pending); pending = setTimeout(reveal, 250); };
    const leave = () => { clearTimeout(pending); deferCloseHover(); };
    const cancel = () => { clearTimeout(pending); closeHover(); };
    const target = row || owner;
    target.addEventListener('pointerenter', enter); target.addEventListener('pointerleave', leave);
    target.addEventListener('pointerdown', cancel);
    owner.addEventListener('focus', reveal); owner.addEventListener('blur', leave);
    collectionBindings.push(() => {
      clearTimeout(pending); target.removeEventListener('pointerenter', enter); target.removeEventListener('pointerleave', leave);
      target.removeEventListener('pointerdown', cancel); owner.removeEventListener('focus', reveal); owner.removeEventListener('blur', leave);
    });
  }
  function attachCollectionChips() {
    for (const dispose of collectionBindings.splice(0)) dispose();
    document.querySelectorAll('.nrfd-tab-chip,.nrfd-row-tools').forEach(n => n.remove());
    if (busy || !results.length) return;
    const tabCategories = { form: ['fields', 'layout'], view: ['views'], report: ['reports'], settings: CATEGORIES.map(c => c.id).filter(id => !['fields', 'layout', 'views', 'reports'].includes(id)) };
    if (showDiff) for (const [id, ids] of Object.entries(tabCategories)) {
      const tab = document.querySelector(`[role="tab"][id="${id}"]`);
      if (!tab) continue;
      const matches = results.filter(r => ids.includes(r.category.id));
      if (!matches.length) continue;
      const failed = matches.some(r => r.state === 'error'), partial = matches.some(r => r.state === 'partial');
      const count = matches.reduce((sum, r) => sum + r.entries.length, 0);
      const label = comparisonStale ? '比較未更新' : failed ? '取得失敗' : count ? '変更あり' : partial ? '一部比較不可' : '変更なし';
      const chip = el('span', label, 'nrfd-tab-chip' + (count || comparisonStale ? ' nrfd-changed' : ''));
      // Passive content preserves the native tab's click/keyboard navigation.
      chip.title = `${lastCheck} 取得時点（未保存の編集は対象外）。${comparisonStale ? STALE_NOTICE : 'ホバーで比較結果を確認できます。'}`;
      tab.append(chip);
      const item = { settings: { label: ({ form: 'フォーム', view: '一覧', report: 'グラフ', settings: '設定' })[id] }, identifier: '取得時点の比較結果', sections: matches.map(r => ({ kind: r.category.label, rows: [
        ['結果', r.state === 'error' ? `取得失敗：${r.error}` : r.entries.length ? Object.entries(KINDS).map(([key, text]) => `${text} ${r.entries.filter(e => e.kind === key).length}`).join(' ／ ') : r.state === 'partial' ? '一部比較不可' : '変更なし'],
        ...(r.entries.length ? [['対象', r.entries.slice(0, 8).map(e => `${KINDS[e.kind]}：${e.label}`).join('\n') + (r.entries.length > 8 ? `\nほか ${r.entries.length - 8} 件（差分一覧で確認）` : '')]] : [])
      ] })) };
      bindSummary(tab, item, matches[0].previewRevision);
    }
    if (comparisonStale || (!showInfo && !showDiff)) return;
    for (const [id, categoryId, tableId] of [['view', 'views', 'viewTable'], ['report', 'reports', 'reportTable']]) {
      if (!document.querySelector(`[role="tab"][id="${id}"][aria-selected="true"]`)) continue;
      const result = results.find(r => r.category.id === categoryId);
      if (!result || result.state === 'error' || !result.snapshots) continue;
      const panel = document.querySelector(`[role="tabpanel"][aria-labelledby~="${id}"]`);
      const rows = [...(panel?.querySelectorAll(`[data-testid="${tableId}"] tbody > tr`) || [])];
      const configs = Object.values(result.snapshots[1][categoryId]);
      // Native rows expose names but no stable IDs. Require an exact, unique name on both sides.
      // Never match by row order: unsaved sorting/renaming must not attach another item's settings.
      const rowNames = rows.map(row => row.children.length === 3 ? row.children[1].textContent : null);
      for (let index = 0; index < rows.length; index++) {
        const name = rowNames[index];
        if (!name || rowNames.filter(n => n === name).length !== 1) continue;
        const found = configs.filter(c => c.name === name);
        if (found.length !== 1) continue;
        const config = found[0], row = rows[index], cell = row.children[1];
        const tools = el('span', '', 'nrfd-row-tools');
        const item = collectionOverview(categoryId, config);
        if (showInfo) {
          const info = button('概要', event => { event.stopPropagation(); appendOverview(modal(`${name} — 設定概要`), item, result.previewRevision); }, 'nrfd-info-button');
          info.setAttribute('aria-label', `${name}の設定概要`); info.setAttribute('aria-haspopup', 'dialog');
          tools.append(info); bindSummary(info, item, result.previewRevision, row);
        }
        if (showDiff) {
          const entry = result.entries.find(e => e.code === String(config.id));
          if (entry) {
            const badge = button(KINDS[entry.kind], event => { event.stopPropagation(); openDetail(entry); }, `nrfd-row-badge nrfd-${entry.kind}`);
            badge.setAttribute('aria-label', `${name}の${KINDS[entry.kind]}内容を表示`); tools.append(badge);
          } else tools.append(el('span', '変更なし', 'nrfd-row-badge'));
        }
        for (const eventName of ['pointerdown', 'mousedown', 'keydown', 'keyup', 'dblclick']) tools.addEventListener(eventName, event => event.stopPropagation());
        cell.append(tools);
      }
    }
  }
  function activeForm() {
    const formTab = document.querySelector('[role="tab"][id="form"]');
    return !!document.querySelector('[data-testid="formSaveButton"]') && (!formTab || formTab.getAttribute('aria-selected') === 'true');
  }
  function updateDisplayTools() {
    // Always available while editing the form, including when both chip types are off.
    // Removing chips can shorten the page and clamp scrolling; geometry must not hide the controls.
    const form = activeForm();
    const collection = !!document.querySelector('[role="tab"][id="view"][aria-selected="true"],[role="tab"][id="report"][aria-selected="true"]');
    const settings = !!document.querySelector('[role="tab"][id="settings"][aria-selected="true"]');
    floatingInfoToggle.label.hidden = !form && !collection;
    floatingInfoToggle.label.title = form ? '選択肢・計算式・参照先' : '一覧・グラフの概要';
    floatingCodeToggle.label.title = '要素IDを含む';
    overviewNote.textContent = form ? '読み込み後、チップのホバー・クリックで保存済み設定を確認できます。同じL番号・色はルックアップとコピー先の対応です。すべて非表示にすると、チップ用の余白もなくなり標準のフォーム配置に戻ります。' : '一覧・グラフの行にホバーすると、保存済み設定の概要を表示します。概要・差分は名前横のチップからも確認できます。タブのホバーで比較結果を確認できます。表示をすべてオフにすると補助表示を取り除きます。';
    floatingCodeToggle.label.hidden = !form;
    fieldCountNote.hidden = !form;
    const show = !stopped && root.isConnected && (form || collection || settings);
    if (floatingTools.hidden === show) floatingTools.hidden = !show;
  }
  function mount() {
    const save = document.querySelector('[data-testid="formSaveButton"]');
    const tabs = document.querySelector('[role="tablist"]');
    if (!root.isConnected) {
      if (tabs) tabs.after(root);
      else if (save) (save.closest('[data-testid="appForm"]') || save.parentElement).before(root);
    }
    root.hidden = false;
    if (!floatingTools.isConnected) document.body.append(floatingTools);
  }
  function selectResult() {
    if (selected === 'all') {
      entries = []; loaded = results.length > 0; isError = results.some(r => r.state === 'error');
      if (!busy && attempted) {
        const changed = results.filter(r => r.state !== 'error' && r.entries.length).length;
        const failed = results.filter(r => r.state === 'error').length;
        const partial = results.filter(r => r.state === 'partial').length;
        const first = results.find(r => r.state !== 'error');
        statusText = `${lastCheck} 確認 ｜ 差分あり ${changed}カテゴリ ／ 全${results.length}カテゴリ${failed ? ' ／ 取得失敗 ' + failed + 'カテゴリ' : ''}${partial ? ' ／ 一部比較不可 ' + partial + 'カテゴリ' : ''}${first ? '（運用中 r' + first.liveRevision + ' ／ プレビュー r' + first.previewRevision + '）' : ''}`;
      }
      categoryNote.textContent = ''; return;
    }
    const r = results.find(item => item.category.id === selected);
    entries = r?.entries || []; loaded = !!r && r.state !== 'error';
    isError = r?.state === 'error';
    if (busy || !attempted) return;
    const failed = results.filter(item => item.state === 'error').length;
    statusText = r ? `${lastCheck} 確認 ｜ ${r.category.label}：${r.state === 'error' ? '取得失敗 — ' + r.error :
      `${entries.length ? entries.length + ' 項目に差分' : r.state === 'partial' ? '取得できた範囲では差分なし（一部比較不可）' : '変更なし'}（運用中 r${r.liveRevision} ／ プレビュー r${r.previewRevision}）`}` : '';
    if (failed) statusText += ` ｜ ${failed} カテゴリが取得失敗。全カテゴリで確認してください。`;
    if (r?.warnings.length) statusText += '\n' + r.warnings.join('\n');
    categoryNote.textContent = r?.category.note || '';
  }
  function drawStatus() {
    for (const [kind, b] of counts) {
      b.textContent = `${KINDS[kind]} ${loaded ? entries.filter(e => e.kind === kind).length : '—'}`;
      b.disabled = !loaded || busy; b.hidden = selected === 'all' || selected === 'layout';
    }
    all.disabled = busy || (['all', 'layout'].includes(selected) ? !results.length : !loaded); refresh.disabled = busy; categorySelect.disabled = busy;
    all.textContent = selected === 'layout' ? 'フォーム配置を見る' : '差分一覧';
    refresh.textContent = busy ? '読み込み中…' : attempted ? '設定を再取得' : '設定を読み込む';
    refresh.classList.toggle('nrfd-start-button', !attempted || comparisonStale);
    staleWarning.hidden = !comparisonStale;
    refresh.setAttribute('aria-busy', String(busy));
    root.dataset.awaitingLoad = String(!attempted);
    status.textContent = statusText + (saveNotice ? ' フォーム保存が完了してから設定を再取得してください。' : '');
    status.dataset.error = String(isError);
    for (const [toggle, enabled] of [[floatingDiffToggle, showDiff], [floatingInfoToggle, showInfo], [floatingCodeToggle, showCodes]]) {
      toggle.input.checked = enabled; toggle.state.textContent = enabled ? '表示中' : '非表示';
      toggle.label.dataset.enabled = String(enabled);
    }
    const fieldResult = results.find(r => r.category.id === 'fields');
    if (busy) fieldCountNote.textContent = 'フィールド数：取得中…';
    else if (fieldResult && fieldResult.state !== 'error') {
      const c = fieldCounts(fieldResult.snapshots[1].properties);
      fieldCountNote.textContent = `フィールド ${c.fields}（テーブル内 ${c.tableFields}）｜ テーブル ${c.tables} ｜ グループ ${c.groups}`;
    } else fieldCountNote.textContent = fieldResult || attempted ? 'フィールド数：取得不可' : 'フィールド数：未取得';
  }
  function clearChips() {
    closeHover();
    for (const dispose of overviewBindings.splice(0)) dispose();
    for (const chip of chips) chip.remove(); chips.clear();
    for (const anchor of anchors) anchor.classList.remove('nrfd-anchor'); anchors.clear();
  }
  function attachChips() {
    // Use exact field-code attributes observed in the current kintone form editor, never label text matching.
    clearChips();
    const fieldResult = results.find(r => r.category.id === 'fields');
    if (!fieldResult || fieldResult.state === 'error' || busy || !activeForm()) return;
    const containers = new Map();
    for (const node of document.querySelectorAll('[data-testid^="field-"]')) containers.set(node.getAttribute('data-testid').slice(6), node);
    const overviewItems = (showInfo || showCodes) ? [...fieldOverviews(fieldResult.snapshots[1].properties).values()] : [];
    const layoutResult = results.find(r => r.category.id === 'layout');
    const parts = layoutResult && layoutResult.state !== 'error' ? layoutParts(layoutResult.snapshots[1].layout) : [];
    const layoutContainers = layoutResult && layoutResult.state !== 'error' && !comparisonStale ? layoutElementContainers(layoutResult.snapshots[1].layout, document.querySelector('[data-testid="formCanvas"]')) : new Map();
    const partIds = new Map();
    for (const part of parts) partIds.set(part.code, (partIds.get(part.code) || 0) + 1);
    if (showCodes) overviewItems.push(...parts.filter(part => partIds.get(part.code) === 1));
    let missingParts = showCodes ? parts.filter(part => partIds.get(part.code) !== 1).length : 0;
    for (const item of overviewItems) {
      let container = containers.get(item.code);
      if (item.element) {
        // Prefer explicit identity; otherwise use validated saved-layout structure for anonymous editor IDs.
        const prefix = { LABEL: 'label-', SPACER: 'spacer-', HR: 'hr-' }[item.node.type];
        if (!container || ![...container.querySelectorAll('[data-testid]')].some(n => n.getAttribute('data-testid') === prefix + item.code)) container = null;
        if (!container) container = layoutContainers.get(item.code);
        if (!container) missingParts++;
      }
      if (!container) continue;
      const group = el('span', undefined, 'nrfd-field-info');
      const labels = showInfo ? [...item.groups] : [];
      if (showInfo && item.sections.some(s => s.kind === '計算式')) labels.push({ role: 'fx', accessible: '計算式' });
      if (showInfo && item.sections.some(s => s.kind === '関連レコード一覧')) labels.push({ role: '参照', accessible: '参照概要' });
      if (showInfo && item.sections.some(s => s.kind === '選択肢')) labels.push({ role: '選択肢' });
      if (item.element) labels.push({ role: item.code, accessible: `要素ID: ${item.code}`, codeSegment: true });
      else if (showCodes) labels.push({ role: item.code, accessible: `フィールドコード: ${item.code}`, codeSegment: true });
      if (!labels.length) continue;
      const hasOverview = item.sections.length > 0;
      const info = hasOverview ? button('', event => {
        event.preventDefault(); event.stopPropagation();
        appendOverview(modal(`${item.settings.label || item.code} — 設定概要`), item, fieldResult.previewRevision);
      }, 'nrfd-info-button nrfd-combined') : el('span', '', 'nrfd-info-button nrfd-combined');
      const descriptions = [];
      for (const label of labels) {
        const text = label.id ? `L${label.id} ${label.role}` : label.role;
        descriptions.push(label.accessible || text);
        const segment = el('span', text, 'nrfd-info-segment' + (label.codeSegment ? ' nrfd-code-segment' : label.role === 'fx' ? ' nrfd-fx-segment' : ''));
        if (label.id) {
          const colors = relationColors[(label.id - 1) % relationColors.length];
          segment.style.setProperty('--nrfd-ink', colors[0]); segment.style.setProperty('--nrfd-fill', colors[1]);
          segment.title = `L${label.id}：${label.code}（${label.role}）`;
        }
        info.append(segment);
      }
      const identifier = `${item.element ? '要素ID' : 'フィールドコード'}：${item.code}`;
      info.setAttribute('aria-label', hasOverview ? `${item.settings.label || item.code}（${item.code}）の設定概要：${descriptions.join(' ／ ')}` : identifier);
      if (hasOverview) {
        info.setAttribute('aria-haspopup', 'dialog');
        info.addEventListener('pointerenter', () => showHover(info, item, fieldResult.previewRevision));
        info.addEventListener('pointerleave', deferCloseHover);
        info.addEventListener('focus', () => showHover(info, item, fieldResult.previewRevision));
        info.addEventListener('blur', deferCloseHover);
      } else { info.title = identifier; info.style.cursor = 'default'; }
      for (const eventName of ['pointerdown', 'mousedown', 'keydown', 'keyup', 'dblclick']) info.addEventListener(eventName, event => event.stopPropagation());
      group.append(info);
      overviewBindings.push(() => group.remove());
      container.classList.add('nrfd-anchor'); anchors.add(container); container.append(group);
    }
    if (missingParts) status.textContent += ` 直接表示できない要素ID ${missingParts} 件は「フォーム配置」の要素IDチップで確認できます。`;
    if (!showDiff) return;
    let attached = 0;
    for (const entry of fieldResult.entries) {
      if (entry.kind === 'deleted') continue;
      const container = containers.get(entry.code);
      const label = document.getElementById('field-label-' + entry.code);
      if (!container && !label) continue;
      const chip = button(entry.kind === 'changed' ? `変更 ${entry.rows.length}` : '追加', event => {
        event.preventDefault(); event.stopPropagation(); openDetail(entry);
      }, `nrfd-chip nrfd-${entry.kind}`);
      chip.setAttribute('aria-label', `${entry.label}（${entry.code}）の${KINDS[entry.kind]}内容を表示`);
      chip.title = '保存済みプレビューと運用中の差分';
      for (const eventName of ['pointerdown', 'mousedown', 'keydown', 'keyup', 'dblclick']) chip.addEventListener(eventName, event => event.stopPropagation());
      // Place outside the draggable field button, so opening a diff cannot start field dragging/editing.
      if (container) {
        container.classList.add('nrfd-anchor'); anchors.add(container);
        let footer = container.querySelector(':scope > .nrfd-field-info');
        if (!footer) { footer = el('span', undefined, 'nrfd-field-info'); container.append(footer); const ownFooter = footer; overviewBindings.push(() => ownFooter.remove()); }
        footer.append(chip);
      }
      else label.after(chip);
      chips.add(chip); attached++;
    }
    const missing = fieldResult.entries.filter(e => e.kind !== 'deleted').length - attached;
    if (missing && selected === 'fields') status.textContent += ` 画面上にチップを配置できない ${missing} 件も、差分一覧で確認できます。`;
  }
  function render() {
    observer.disconnect();
    mount(); drawStatus(); attachChips(); attachMenuChips(); attachCollectionChips(); updateDisplayTools();
    if (!stopped) observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected', 'aria-labelledby', 'href', 'id', 'data-testid'] });
  }
  function closeDialog() {
    closeHover();
    if (!dialog) return;
    const d = dialog; dialog = null;
    if (d.open && typeof d.close === 'function') d.close();
    d.remove();
    if (trigger?.isConnected) { restoringFocus = true; trigger.focus(); restoringFocus = false; }
  }
  function appendOverview(body, item, revision) {
    body.append(el('p', item.identifier || `${item.element ? '要素ID' : 'フィールドコード'}：${item.code}${item.parent ? ' ／ テーブル：' + item.parent : ''}`, 'nrfd-meta'));
    if (comparisonStale) body.append(el('p', STALE_NOTICE, 'nrfd-note'));
    for (const section of item.sections) {
      body.append(el('h3', section.kind, 'nrfd-overview-title'));
      const rows = el('dl', undefined, 'nrfd-summary-rows');
      for (const [label, text] of section.rows) rows.append(el('dt', label), el('dd', text));
      body.append(rows);
    }
    body.append(el('p', `${lastCheck} 取得・${item.phase || '保存済みプレビュー'} r${revision}（未保存の編集は対象外）`, 'nrfd-note'));
  }
  function closeHover() {
    clearTimeout(hoverTimer); hover?.remove(); hover = null;
    hoverOwner?.removeAttribute('aria-describedby'); hoverOwner = null;
  }
  function deferCloseHover() { clearTimeout(hoverTimer); hoverTimer = setTimeout(closeHover, 180); }
  function showHover(owner, item, revision) {
    if ((dialog && !dialog.contains(owner)) || busy || restoringFocus) return;
    closeHover(); hoverOwner = owner;
    hover = el('aside', undefined, 'nrfd-hover'); hover.id = 'nrfd-field-tooltip'; hover.setAttribute('role', 'tooltip');
    hover.append(el('strong', `${item.settings.label || item.code} — 設定概要`));
    appendOverview(hover, item, revision);
    hover.addEventListener('pointerenter', () => clearTimeout(hoverTimer));
    hover.addEventListener('pointerleave', deferCloseHover);
    (dialog || document.body).append(hover); owner.setAttribute('aria-describedby', hover.id);
    positionHover();
  }
  function positionHover() {
    if (!hover || !hoverOwner?.isConnected) return;
    const box = hoverOwner.getBoundingClientRect();
    const above = box.top - 18, below = window.innerHeight - box.bottom - 18, useBelow = below >= above;
    hover.style.maxHeight = Math.max(40, Math.min(440, useBelow ? below : above)) + 'px';
    const size = hover.getBoundingClientRect();
    hover.style.left = Math.max(12, Math.min(box.left, window.innerWidth - size.width - 12)) + 'px';
    hover.style.top = Math.max(12, useBelow ? box.bottom + 6 : box.top - size.height - 6) + 'px';
  }
  function modal(title) {
    closeHover();
    if (!dialog) trigger = document.activeElement;
    else { dialog.remove(); dialog = null; }
    const d = el('dialog', undefined, 'nrfd-dialog'); dialog = d;
    d.setAttribute('aria-labelledby', 'nrfd-dialog-title');
    const head = el('div', undefined, 'nrfd-dialog-head');
    const heading = el('h2', title); heading.id = 'nrfd-dialog-title';
    const close = button('閉じる', closeDialog); head.append(heading, close);
    const body = el('div', undefined, 'nrfd-dialog-body'); d.append(head, body);
    d.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
    d.addEventListener('click', event => { if (event.target === d) { const r = d.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeDialog(); } });
    document.body.append(d); d.showModal(); close.focus(); return body;
  }
  function openList(kind) {
    if (selected === 'all') { openOverview(); return; }
    if (selected === 'layout') { openLayout(); return; }
    const list = entries.filter(e => !kind || e.kind === kind);
    const category = CATEGORIES.find(c => c.id === selected);
    const body = modal(`${category.label} — ${kind ? KINDS[kind] : '差分一覧'}`);
    body.append(el('p', `${lastCheck} 時点の保存済み設定。未保存内容は含みません。`, 'nrfd-meta'));
    const result = results.find(r => r.category.id === selected);
    if (result?.state === 'error') { body.append(el('p', result.error)); return; }
    if (result?.warnings.length) body.append(el('p', result.warnings.join('\n')));
    if (!list.length) { body.append(el('p', '対象の差分はありません。', 'nrfd-empty')); return; }
    const grid = el('div', undefined, 'nrfd-list');
    for (const entry of list) {
      const b = button('', () => openDetail(entry));
      b.append(el('span', KINDS[entry.kind], `nrfd-chip nrfd-${entry.kind}`), el('span', entry.label), el('span', entry.code, 'nrfd-list-code'));
      grid.append(b);
    }
    body.append(grid);
  }
  function openOverview() {
    const body = modal('アプリ設定 — 全カテゴリ');
    body.append(el('p', `${lastCheck} 時点。各カテゴリを選ぶと差分一覧を表示します。`, 'nrfd-meta'));
    const grid = el('div', undefined, 'nrfd-summary');
    for (const result of results) {
      const label = result.state === 'error' ? '取得失敗' : result.state === 'partial' ? `一部比較不可・差分 ${result.entries.length} 項目` : result.entries.length ? `差分 ${result.entries.length} 項目` : '変更なし';
      grid.append(button(`${result.category.label}\n${label}`, () => {
        selected = result.category.id; categorySelect.value = selected; selectResult(); render(); openList();
      }, result.state !== 'ok' ? 'nrfd-failed' : ''));
    }
    body.append(grid, el('p', UNSUPPORTED, 'nrfd-note'));
  }
  function openDetail(entry) {
    selected = entry.categoryId || 'fields'; categorySelect.value = selected; selectResult(); drawStatus();
    const body = modal(`${entry.label} — ${KINDS[entry.kind]}`);
    const parent = selected === 'fields' ? (entry.after || entry.before).parent : '';
    body.append(el('p', `${selected === 'fields' ? 'フィールドコード' : '項目'}：${entry.code}${parent ? ' ／ テーブル：' + parent : ''} ／ ${lastCheck} 時点`, 'nrfd-meta'));
    if (entry.kind === 'added') body.append(el('p', '保存済みプレビューに追加されています。'));
    if (entry.kind === 'deleted') body.append(el('p', '運用中には存在し、保存済みプレビューでは削除されています。'));
    const table = el('table', undefined, 'nrfd-table'), thead = el('thead'), tr = el('tr');
    for (const text of ['設定項目', '運用中', '保存済みプレビュー']) { const th = el('th', text); th.scope = 'col'; tr.append(th); }
    thead.append(tr); table.append(thead);
    const tbody = el('tbody');
    for (const row of entry.rows) {
      const renderValue = value => selected === 'fields' ? format(value, row.path) : formatSetting(value);
      const r = el('tr'); r.append(el('th', row.path.map(displayName).join(' / ') || '設定全体'), el('td', renderValue(row.before)), el('td', renderValue(row.after)));
      r.firstChild.scope = 'row'; tbody.append(r);
    }
    table.append(tbody); body.append(table, el('p', '「—」は該当設定なし。「取得不可／未設定」はAPIからnullが返った項目です。', 'nrfd-note'));
    body.append(button('一覧へ戻る', () => openList()), button('全カテゴリへ', openOverview));
  }
  function openLayout() {
    const body = modal('フォーム配置');
    dialog.classList.add('nrfd-layout-dialog');
    const layout = results.find(r => r.category.id === 'layout'), fields = results.find(r => r.category.id === 'fields');
    if (!layout || layout.state === 'error' || !fields || fields.state === 'error') {
      body.append(el('p', 'フォーム配置には配置とフォーム項目の両方の取得が必要です。設定を再取得してください。'));
      body.append(el('p', [layout?.error, fields?.error].filter(Boolean).join('\n'))); return;
    }
    body.append(el('p', `${lastCheck} 時点。PC用の配置を簡易再現しています。未保存の編集・レコード値・JS/CSS・プラグインの見た目は含みません。`, 'nrfd-meta'));
    body.append(el('p', '黄：配置位置・寸法・設定の変更 ／ 緑：追加 ／ 赤：削除予定。同じコードの「対応位置」を押すと左右で強調します。IDのない部品は同じ行・列で比較します。ラベルは文字だけ、グループは展開して表示します。', 'nrfd-note'));
    const tools = el('div', undefined, 'nrfd-layout-tools'), zoom = el('select'); zoom.setAttribute('aria-label', 'レイアウト表示倍率');
    for (const value of [50, 75, 100]) { const option = el('option', value + '%'); option.value = String(value); zoom.append(option); }
    zoom.value = '75'; const zoomLabel = el('label', '表示倍率 '); zoomLabel.append(zoom); tools.append(zoomLabel);
    body.append(tools);
    const pair = el('div', undefined, 'nrfd-layout-pair'); body.append(pair);
    const layouts = layout.snapshots.map(s => s.layout), maps = fields.snapshots.map(s => flatten(s.properties));
    const marks = layoutMarks(...layouts, ...fields.snapshots.map(s => s.properties)), rendered = new Map(), canvases = [];
    const dimension = (value, fallback) => /^\d+(\.\d+)?$/.test(String(value)) ? Math.max(20, Math.min(3000, Number(value))) : fallback;
    function paint(nodes, host, side, path = []) {
      nodes.forEach((node, index) => {
        const position = [...path, index], properties = maps[side].get(node.code)?.settings || {};
        if (node.type === 'ROW') { const row = el('div', undefined, 'nrfd-layout-row'); host.append(row); paint(node.fields || [], row, side, [...position, 'fields']); return; }
        const container = ['GROUP', 'SUBTABLE'].includes(node.type), mark = marks[side].get(position.join('/'));
        const box = el('div', undefined, 'nrfd-layout-node' + (container ? ' nrfd-layout-container' : '') + (mark?.kind ? ' nrfd-' + mark.kind : ''));
        box.dataset.code = node.code || ''; box.dataset.position = position.join('/'); host.append(box);
        if (mark?.kind) box.append(el('span', mark.text, 'nrfd-layout-badge'));
        if (!container) box.style.width = dimension(node.size?.width, 200) + 'px';
        if (node.size?.height) box.style.minHeight = dimension(node.size.height, 60) + 'px';
        if (node.code) {
          if (!properties.noLabel || container) box.append(el('h4', (properties.label || node.code) + (properties.required ? ' *' : '')));
          box.append(el('span', node.code + ' · ' + (TYPES[node.type] || node.type), 'nrfd-layout-code'));
          if (mark && !mark.anonymous) {
            if (!rendered.has(mark.key)) rendered.set(mark.key, []); rendered.get(mark.key).push(box);
            box.append(button('対応位置', () => {
              for (const boxes of rendered.values()) for (const item of boxes) item.classList.remove('nrfd-layout-selected');
              for (const item of rendered.get(mark.key)) { item.classList.add('nrfd-layout-selected'); item.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }
            }, 'nrfd-layout-codebutton'));
          }
        }
        if (container) {
          if (node.type === 'GROUP') paint(node.layout || [], box, side, [...position, 'layout']);
          else { const row = el('div', undefined, 'nrfd-layout-row'); box.append(row); paint(node.fields || [], row, side, [...position, 'fields']); }
        } else if (node.type === 'LABEL') {
          // Parse in an inert template, then use only text; never attach source markup or URLs.
          const template = document.createElement('template'); template.innerHTML = String(node.label || '').replace(/<br\s*\/?\s*>/gi, '\n');
          box.append(el('div', template.content.textContent, 'nrfd-layout-label'));
        } else if (node.type === 'HR') box.append(el('hr'));
        else if (node.type === 'SPACER') box.append(el('div', 'スペース', 'nrfd-layout-space'));
        else {
          const options = Object.values(properties.options || {}).sort((a, b) => Number(a.index) - Number(b.index));
          const sample = options.length ? options.map(o => o.label).join(node.type === 'CHECK_BOX' || node.type === 'RADIO_BUTTON' ? ' / ' : ' · ') : node.type === 'DATE' ? '年 / 月 / 日' : node.type === 'FILE' ? '添付ファイル' : ' ';
          const input = el('div', sample, 'nrfd-layout-input');
          if (node.size?.innerHeight) input.style.minHeight = dimension(node.size.innerHeight, 60) + 'px';
          box.append(input);
        }
        if (node.elementId && ['LABEL', 'SPACER', 'HR'].includes(node.type)) {
          const item = layoutParts([{ type: 'ROW', fields: [node] }])[0];
          item.phase = side ? '保存済みプレビュー' : '運用中';
          const info = button(node.elementId, event => { event.stopPropagation(); }, 'nrfd-info-button');
          info.setAttribute('aria-label', `${item.settings.label}の要素ID：${item.code}`);
          const reveal = () => showHover(info, item, side ? layout.previewRevision : layout.liveRevision);
          info.addEventListener('pointerenter', reveal); info.addEventListener('pointerleave', deferCloseHover);
          info.addEventListener('focus', reveal); info.addEventListener('blur', deferCloseHover);
          box.append(info);
        }
        if (node.size) box.append(el('span', `幅 ${node.size.width || '—'}${node.size.height ? ' / 高さ ' + node.size.height : ''}${node.size.innerHeight ? ' / 入力高 ' + node.size.innerHeight : ''} px`, 'nrfd-layout-code'));
      });
    }
    layouts.forEach((nodes, side) => {
      const section = el('section', undefined, 'nrfd-layout-side'), title = `${side ? '保存済みプレビュー' : '運用中'} · r${side ? layout.previewRevision : layout.liveRevision}`;
      section.setAttribute('aria-label', title); section.append(el('h3', title));
      const scroll = el('div', undefined, 'nrfd-layout-scroll'); scroll.tabIndex = 0; scroll.setAttribute('aria-label', title + 'の配置');
      const canvas = el('div', undefined, 'nrfd-layout-canvas'); canvas.style.zoom = '.75'; canvases.push(canvas);
      scroll.append(canvas); section.append(scroll); pair.append(section);
      if (!nodes.length) canvas.append(el('p', '配置された項目はありません。')); else paint(nodes, canvas, side);
    });
    zoom.addEventListener('change', () => { for (const canvas of canvases) canvas.style.zoom = String(Number(zoom.value) / 100); });
  }
  async function load() {
    attempted = true;
    const id = ++requestId;
    aborter?.abort(); aborter = new AbortController();
    const controller = aborter;
    try { clearCarry(window.sessionStorage, ctx); window.sessionStorage.removeItem(saveMarkerKey(ctx)); } catch { /* Continue without cross-page persistence. */ }
    carryNote.hidden = true;
    busy = true; loaded = false; entries = []; results = []; saveNotice = false; comparisonStale = false; categoryNote.textContent = '';
    statusText = '保存済み設定を読み込んでいます…'; isError = false; closeDialog(); render();
    try {
      const collected = await collectSettings(ctx, controller.signal, fetch, completed => {
        if (stopped || id !== requestId) return;
        statusText = `保存済み設定を読み込んでいます… ${completed} / ${CATEGORIES.length} カテゴリ`; drawStatus();
      });
      if (stopped || id !== requestId) return;
      results = collected;
      let carried = false;
      try { carried = saveCarry(window.sessionStorage, ctx, results, Date.now(), { selected, showDiff, showInfo, showCodes }); } catch { /* The current page still works. */ }
      if (carried && comparisonStale) { try { markCarryStale(window.sessionStorage, ctx); } catch { /* Preserve the visible warning. */ } }
      carryNote.hidden = carried;
      carryNote.textContent = carried ? '' : '差分の一時保持ができません。この画面では確認できますが、個別設定画面への引き継ぎは利用できません。';
      lastCheck = new Date().toLocaleTimeString('ja-JP');
      busy = false; selectResult();
    } catch (error) {
      controller.abort();
      if (stopped || id !== requestId) return;
      statusText = error.name === 'AbortError' ? '通信がタイムアウトしました。「設定を再取得」で再試行してください。' : error.message;
      isError = true; loaded = false;
    } finally {
      if (!stopped && id === requestId) { busy = false; render(); }
    }
  }
  const observer = new MutationObserver(records => {
    // Ignore our dialog/status content; React updates are reconciled once per burst.
    const own = node => (node.nodeType === 1 ? node : node.parentElement)?.closest('.nrfd,.nrfd-dialog,.nrfd-chip,.nrfd-menu-chip,.nrfd-tab-chip,.nrfd-row-tools,.nrfd-field-info,.nrfd-hover');
    if (records.every(r => own(r.target) || (r.type === 'childList' &&
      [...r.addedNodes, ...r.removedNodes].length > 0 && [...r.addedNodes, ...r.removedNodes].every(own)))) return;
    clearTimeout(timer); timer = setTimeout(render, 120);
  });
  document.addEventListener('click', event => {
    if (event.target.closest?.('[data-testid="formSaveButton"]')) { saveNotice = true; drawStatus(); }
  }, true);
  document.addEventListener('nrfd-save-attempt', () => { comparisonStale = true; render(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeHover(); }, true);
  window.addEventListener('resize', positionHover);
  document.addEventListener('scroll', event => { if (!hover?.contains(event.target)) positionHover(); }, true);
  window.addEventListener('hashchange', () => { closeDialog(); render(); });
  window.addEventListener('pagehide', () => {
    try {
      const cache = readCarry(window.sessionStorage, ctx);
      if (cache && results.length && !busy) {
        cache.ui = { selected, showDiff, showInfo, showCodes };
        window.sessionStorage.setItem(carryKey(ctx), JSON.stringify(cache));
      }
    } catch { /* Keep the comparison usable when storage is unavailable. */ }
    stopped = true; requestId++; aborter?.abort(); observer.disconnect(); clearTimeout(timer); closeHover(); closeDialog(); floatingTools.hidden = true;
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) {
      stopped = false; busy = false;
      if (!restoreCarry()) { results = []; entries = []; loaded = false; isError = false; }
      if (!results.length) { attempted = false; statusText = 'はじめに「設定を読み込む」を押してください。差分確認・設定チップ・フィールド数を利用できます。'; }
      render();
    }
  });
  restoreCarry(); render();
})();
