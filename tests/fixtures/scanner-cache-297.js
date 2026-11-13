// Field Scanner のキャッシュ payload（localStorage `ktScanCache.v1.<appId>`）の実形式 fixture
//
// 2026-10-01 に検証環境（app 297「見積」）のキャッシュから構造を写し取ったもの。
//   - files[] は本文（text）を持たない（キャッシュ保存時に落とす）。外部 URL の JS は note 付きで残る
//   - results[].matches = { file, target, kind, line, access, confidence, snippet }
//     access は READ / WRITE / CONTROL / OTHER（ほか ELEMENT / SHOW_HIDE / FIELDS_PARAM / QUERY / ARGUMENT / LIST）
//     confidence は HIGH / MEDIUM / LOW。snippet は 80 文字前後（原文の抜粋。改行は ⏎）
//   - results[].files = ['desktop: <name>']、samples[].file = 'desktop: <name>'
//   - fileEvents = { 'desktop:js:<name>': [{ name, direct }] }
//   - appRefs = { appId, raw, line, kind, confidence, file, target }
//   - externalRefs = { appId, code, access, file, target, lines, count, via }
//   - unknownRefs = { code, confidence, count, patterns, nearMatch, files:[{ name:'desktop:<name>', lines }] }
//   - meta = { appId, include:{desktop,mobile}, kinds:['js'], scannedAt }
// snippet の本文は検証用に書き直している（secret らしき値を 1 箇所含める）。
'use strict';

const FILE = 'article-quote-demo.js';
const m = (line, access, confidence, snippet) => ({ file: FILE, target: 'desktop', kind: 'js', line, access, confidence, snippet });

const results = [
  {
    code: 'quote_price', label: '見積価格', type: 'NUMBER', used: true, count: 7,
    files: [`desktop: ${FILE}`],
    accessCounts: { CONTROL: 2, OTHER: 2, READ: 2, WRITE: 1 },
    accessSummary: 'CONTROL×2, OTHER×2, READ×2, WRITE×1',
    samples: [
      { file: `desktop: ${FILE}`, line: 6, access: 'CONTROL', confidence: 'MEDIUM', snippet: "kintone.app.record.setFieldShown('quote_price', false);⏎    const rec = ev" },
      { file: `desktop: ${FILE}`, line: 14, access: 'OTHER', confidence: 'LOW', snippet: "events.on(['app.record.create.change.quote_price', 'app.record.edit.change.quote_price']" },
    ],
    matches: [
      m(6, 'CONTROL', 'MEDIUM', "kintone.app.record.setFieldShown('quote_price', false);⏎    const rec = ev"),
      m(14, 'OTHER', 'LOW', "events.on(['app.record.create.change.quote_price', 'app.record.edit.change.quote_price']"),
      m(14, 'OTHER', 'LOW', "e.change.quote_price', 'app.record.edit.change.quote_price'], (event) => {⏎"),
      m(15, 'READ', 'MEDIUM', "    const price = Number(event.record['quote_price'].value || 0);⏎    if (price > "),
      m(16, 'CONTROL', 'MEDIUM', "if (price > 1000000) event.record['quote_price'].error = '上限を超えています';⏎"),
      m(21, 'WRITE', 'MEDIUM', "    event.record['quote_price'].value = Math.round(event.record['quote_price'].value * 1.1);"),
      m(21, 'READ', 'MEDIUM', "].value = Math.round(event.record['quote_price'].value * 1.1);⏎    return event;"),
    ],
  },
  {
    code: 'product_lookup', label: '商品', type: 'SINGLE_LINE_TEXT', used: true, count: 1,
    files: [`desktop: ${FILE}`], accessCounts: { READ: 1 }, accessSummary: 'READ×1',
    samples: [{ file: `desktop: ${FILE}`, line: 26, access: 'READ', confidence: 'MEDIUM', snippet: "const code = event.record['product_lookup'].value; // apiToken: 'abcdEFGH12345678'" }],
    matches: [m(26, 'READ', 'MEDIUM', "const code = event.record['product_lookup'].value; // apiToken: 'abcdEFGH12345678'")],
  },
  {
    code: 'ステータス', label: 'ステータス', type: 'STATUS', used: true, count: 1,
    files: [`desktop: ${FILE}`], accessCounts: { READ: 1 }, accessSummary: 'READ×1',
    samples: [{ file: `desktop: ${FILE}`, line: 27, access: 'READ', confidence: 'HIGH', snippet: "if (event.record['ステータス'].value === '承認済み') {⏎      return event;" }],
    matches: [m(27, 'READ', 'HIGH', "if (event.record['ステータス'].value === '承認済み') {⏎      return event;")],
  },
  { code: 'カテゴリー', label: 'カテゴリー', type: 'CATEGORY', used: false, count: 0, files: [], accessCounts: {}, accessSummary: '', samples: [], matches: [] },
  { code: 'レコード番号', label: 'レコード番号', type: 'RECORD_NUMBER', used: false, count: 0, files: [], accessCounts: {}, accessSummary: '', samples: [], matches: [] },
];

const payload = {
  results,
  files: [
    { name: FILE, target: 'desktop', kind: 'js' },
    { name: 'KintoneRestAPIClient.min.js', target: 'desktop', kind: 'js', note: 'external URL (skipped)' },
  ],
  fields: [
    { code: 'カテゴリー', label: 'カテゴリー', type: 'CATEGORY' }, { code: 'レコード番号', label: 'レコード番号', type: 'RECORD_NUMBER' },
    { code: '作業者', label: '作業者', type: 'STATUS_ASSIGNEE' }, { code: 'product_lookup', label: '商品', type: 'SINGLE_LINE_TEXT' },
    { code: '更新者', label: '更新者', type: 'MODIFIER' }, { code: '作成者', label: '作成者', type: 'CREATOR' },
    { code: 'ステータス', label: 'ステータス', type: 'STATUS' }, { code: '更新日時', label: '更新日時', type: 'UPDATED_TIME' },
    { code: '作成日時', label: '作成日時', type: 'CREATED_TIME' }, { code: 'quote_price', label: '見積価格', type: 'NUMBER' },
  ],
  appRefs: [{ appId: '296', raw: "app: 296, query: 'product_code = \"' + code", line: 35, kind: 'LITERAL', confidence: 'MEDIUM', file: FILE, target: 'desktop' }],
  fileEvents: {
    [`desktop:js:${FILE}`]: [
      { name: 'app.record.create.change.quote_price', direct: true }, { name: 'app.record.create.show', direct: true },
      { name: 'app.record.create.submit', direct: true }, { name: 'app.record.detail.show', direct: true },
      { name: 'app.record.edit.change.quote_price', direct: true }, { name: 'app.record.edit.show', direct: true },
      { name: 'app.record.edit.submit', direct: true },
    ],
  },
  unknownRefs: [{ code: 'legacy_discount', confidence: 'HIGH', count: 2, patterns: ["record['…']"], nearMatch: null, files: [{ name: `desktop:${FILE}`, lines: [9, 10] }] }],
  unknownStatuses: [],
  externalRefs: [
    { appId: '296', code: 'old_price', access: 'READ', file: FILE, target: 'desktop', lines: [35], count: 1, via: 'kintone.api' },
    { appId: '296', code: 'product_code', access: 'READ', file: FILE, target: 'desktop', lines: [35], count: 1, via: 'kintone.api' },
  ],
  meta: { appId: 297, include: { desktop: true, mobile: true }, kinds: ['js'], scannedAt: '2026-09-27T14:46:31.218Z' },
};

/** キャッシュ全体（KTScan.loadCache の戻り値と同じ形） */
const cache = { signature: 'v13|desktop:js:FILE:20260927…|both|js', scannedAt: '2026-09-27T14:46:31.218Z', payload };

/** app 297 の DATA（fields は payload.fields と整合。lookup は 296 を参照） */
function makeData() {
  const f = (type, code, label, extra = {}) => ({ type, code, label, noLabel: false, ...extra });
  return {
    appId: 297,
    settings: { name: '見積' },
    fields: {
      'カテゴリー': f('CATEGORY', 'カテゴリー', 'カテゴリー'), 'レコード番号': f('RECORD_NUMBER', 'レコード番号', 'レコード番号'),
      '作業者': f('STATUS_ASSIGNEE', '作業者', '作業者'), '更新者': f('MODIFIER', '更新者', '更新者'), '作成者': f('CREATOR', '作成者', '作成者'),
      'ステータス': f('STATUS', 'ステータス', 'ステータス'), '更新日時': f('UPDATED_TIME', '更新日時', '更新日時'), '作成日時': f('CREATED_TIME', '作成日時', '作成日時'),
      product_lookup: f('SINGLE_LINE_TEXT', 'product_lookup', '商品', {
        lookup: { relatedApp: { app: '296' }, relatedKeyField: 'product_code', fieldMappings: [{ field: 'quote_price', relatedField: 'price' }] },
      }),
      quote_price: f('NUMBER', 'quote_price', '見積価格'),
    },
    layout: [],
    customize: {
      scope: 'ALL',
      desktop: { js: [{ type: 'URL', url: 'https://unpkg.com/@kintone/rest-api-client@latest/umd/KintoneRestAPIClient.min.js' }, { type: 'FILE', file: { name: FILE, fileKey: 'k297' } }], css: [] },
      mobile: { js: [], css: [] },
    },
    status: { enable: true, states: { '未処理': { name: '未処理', index: '0', assignee: { type: 'ONE', entities: [] } }, '承認済み': { name: '承認済み', index: '1', assignee: { type: 'ONE', entities: [] } } }, actions: [] },
  };
}

module.exports = { FILE, payload, cache, makeData };
