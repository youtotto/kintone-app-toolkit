// KTContext（AI Context Builder）のテスト用 fixture
//
// App 310「案件管理」（tests/fixtures/field-entity-app.js）を土台に、AI Context の検証に必要な設定を足す:
//   - 顧客コード（customer_code）: ルックアップのコピー先・一覧の表示/条件/ソート・関連レコードの条件・計算式・JS から利用
//   - 計算フィールド total（amount と tax を参照）／tax（amount を参照）→ 計算式チェーン
//   - 同じラベル「担当」を持つ 2 フィールド（曖昧な対象解決の検証用）
//   - JavaScript（PC/モバイルの同名 common.js ＋ autoLookup.js）。秘密情報らしき文字列を含む
//   - 他アプリからの参照（KTIncoming の rows と同じ形）
'use strict';
const FX = require('./field-entity-app.js');

const field = (type, code, label, extra = {}) => ({ type, code, label, noLabel: false, required: false, ...extra });

const SELF_APP = 310;
const CUSTOMER_APP = 500;
const QUOTE_APP = 600;

function makeData() {
  const data = FX.makeData();
  // ---- フィールド追加 ----
  data.fields.customer_code = field('SINGLE_LINE_TEXT', 'customer_code', '顧客コード', { unique: true });
  data.fields.customer_lookup = field('SINGLE_LINE_TEXT', 'customer_lookup', '顧客マスタ参照', {
    lookup: {
      relatedApp: { app: String(CUSTOMER_APP), code: '' },
      relatedKeyField: 'code',
      fieldMappings: [
        { field: 'customer_code', relatedField: 'code' },
        { field: 'case_name', relatedField: 'name' },
      ],
      lookupPickerFields: ['code', 'name'],
      filterCond: '', sort: '',
    },
  });
  data.fields.quotes = field('REFERENCE_TABLE', 'quotes', '見積一覧', {
    referenceTable: {
      relatedApp: { app: String(QUOTE_APP), code: '' },
      condition: { field: 'customer_code', relatedField: 'customer_code' },
      filterCond: '', displayFields: ['quote_no', 'amount'], sort: '', size: '5',
    },
  });
  data.fields.tax = field('CALC', 'tax', '税額', { expression: 'amount * 0.1' });
  data.fields.total = field('CALC', 'total', '合計', { expression: 'amount + tax' });
  data.fields.pic_sales = field('USER_SELECT', 'pic_sales', '担当', { entities: [], defaultValue: [] });
  data.fields.pic_support = field('USER_SELECT', 'pic_support', '担当', { entities: [], defaultValue: [] });

  // ---- 一覧 ----
  data.views = {
    views: {
      '顧客別一覧': {
        id: '101', name: '顧客別一覧', type: 'LIST', index: '0',
        fields: ['customer_code', 'case_name', 'amount', 'owner'],
        filterCond: 'customer_code != "" and amount > "0"', sort: 'customer_code asc',
      },
      '承認待ち': {
        id: '102', name: '承認待ち', type: 'LIST', index: '1',
        fields: ['case_name', 'approver'], filterCond: 'ステータス in ("承認待ち")', sort: 'due_date asc',
      },
    },
    revision: '12',
  };
  // ---- JavaScript / CSS カスタマイズ（PC・モバイルに同名 common.js）----
  const fileItem = (name, fileKey, contentType = 'text/javascript') => ({ type: 'FILE', file: { contentType, fileKey, name, size: '1024' } });
  data.customize = {
    scope: 'ALL',
    desktop: {
      js: [
        { type: 'URL', url: 'https://js.cybozu.com/luxon/3.4.4/luxon.min.js' },
        fileItem('common.js', '20261001000000AAAA'),
        fileItem('autoLookup.js', '20261001000000BBBB'),
      ],
      css: [fileItem('style.css', '20261001000000CCCC', 'text/css')],
    },
    mobile: { js: [fileItem('common.js', '20261001000000DDDD')], css: [] },
    revision: '5',
  };
  data.appPlugins = { plugins: [{ id: 'plg1', name: 'Dummy Plugin', enabled: true }], revision: '1' };
  data.layout = [];
  return data;
}

// ---- JavaScript 本文（Field Scanner に渡す files と同じ形）----
const DESKTOP_COMMON = [
  "(function () {",
  "  'use strict';",
  "  const API_KEY = 'sk_live_0123456789abcdef0123';",
  "  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], (event) => {",
  "    const code = event.record['customer_code'].value;",
  "    event.record['case_name'].value = 'Case ' + code;",
  "    kintone.app.record.setFieldShown('secret_memo', false);",
  "    return event;",
  "  });",
  "  fetch('https://api.example.com/notify', { headers: { Authorization: 'Bearer abcdefgh12345678ZZZZ' } });",
  "  const params = { app: 600, query: 'customer_code = \"A001\"', fields: ['quote_no'] };",
  "  kintone.api(kintone.api.url('/k/v1/records.json', true), 'GET', params);",
  "})();",
].join('\n');
const MOBILE_COMMON = [
  "(function () {",
  "  'use strict';",
  "  kintone.events.on('mobile.app.record.detail.show', (event) => {",
  "    const code = event.record['customer_code'].value;",
  "    const old = event.record['legacy_customer_cd'].value;",
  "    return event;",
  "  });",
  "})();",
].join('\n');
const AUTO_LOOKUP = [
  "(function () {",
  "  'use strict';",
  "  kintone.events.on('app.record.create.change.customer_code', (event) => {",
  "    event.record['customer_lookup'].value = event.record['customer_code'].value;",
  "    event.record['customer_lookup'].lookup = true;",
  "    return event;",
  "  });",
  "})();",
].join('\n');

const files = [
  { name: 'common.js', target: 'desktop', kind: 'js', text: DESKTOP_COMMON },
  { name: 'autoLookup.js', target: 'desktop', kind: 'js', text: AUTO_LOOKUP },
  { name: 'common.js', target: 'mobile', kind: 'js', text: MOBILE_COMMON },
];

// ---- 他アプリからの参照（KTIncoming.run の戻り値と同じ形）----
const incoming = {
  rows: [
    {
      appId: String(QUOTE_APP), appName: '見積', kind: 'ルックアップ',
      sourceField: 'case_lookup', sourceLabel: '案件参照', targetField: 'customer_code',
      copyFields: [{ from: 'case_name', to: 'case_name_copy' }], note: '1項目を取得',
    },
    {
      appId: String(QUOTE_APP), appName: '見積', kind: '関連レコード',
      sourceField: 'cases', sourceLabel: '案件一覧', targetField: 'customer_code', note: 'customer_code で突合',
    },
  ],
  errors: [],
  stats: { scannedApps: 12, referencingApps: 1, failedApps: 0, includeActions: true, truncated: false },
  scannedAt: '2026-10-01T00:00:00.000Z',
};

// 外部 URL の JS（Scanner は本文を取得せず files[] に note 付きで残す。実データと同じ形）
const skippedUrlFiles = [{ name: 'luxon.min.js', target: 'desktop' }];

module.exports = { SELF_APP, CUSTOMER_APP, QUOTE_APP, makeData, files, incoming, skippedUrlFiles, DESKTOP_COMMON, MOBILE_COMMON, AUTO_LOOKUP };
