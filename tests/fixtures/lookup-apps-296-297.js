// App 296「商品マスタ」／App 297「見積」相当のフォーム設定（kintone REST API /k/v1/app/form/fields.json と同じ形）
//
//   見積（297）の ルックアップ「商品」（product_lookup）:
//     参照先アプリ: 商品マスタ（296）
//     Lookupキー:   商品マスタ.product_code
//     ほかのフィールドのコピー: 商品マスタ.old_price    → 見積.quote_price
//                               商品マスタ.product_name → 見積.quote_product_name
//   見積（297）の テーブル内ルックアップ「明細商品」（item_lookup）: 商品マスタ.new_price → 見積.item_price
//   見積（297）の 関連レコード一覧「関連商品」: 見積.quote_category と 商品マスタ.category で突合
//   見積（297）の アプリアクション「商品登録」: 商品マスタ.product_name / memo へ転記
//   顧客管理（298）: 商品マスタを参照しない（走査対象に含まれるが行を生成しないアプリ）
//
// 走査の視点は「商品マスタ（296）から見た、他アプリからの参照」。
'use strict';

const text = (code, label, extra = {}) => ({ type: 'SINGLE_LINE_TEXT', code, label, noLabel: false, required: false, unique: false, ...extra });
const number = (code, label) => ({ type: 'NUMBER', code, label, noLabel: false, required: false, unique: false });

const fields296 = {
  properties: {
    'レコード番号': { type: 'RECORD_NUMBER', code: 'レコード番号', label: 'レコード番号', noLabel: false },
    product_code: text('product_code', '商品コード', { unique: true, required: true }),
    product_name: text('product_name', '商品名'),
    old_price: number('old_price', '旧価格'),
    new_price: number('new_price', '新価格'),
    category: {
      type: 'DROP_DOWN', code: 'category', label: '分類', noLabel: false, required: false,
      options: { '文具': { label: '文具', index: '0' }, '機器': { label: '機器', index: '1' } },
      defaultValue: '',
    },
    memo: { type: 'MULTI_LINE_TEXT', code: 'memo', label: '備考', noLabel: false, required: false },
  },
};

const fields297 = {
  properties: {
    'レコード番号': { type: 'RECORD_NUMBER', code: 'レコード番号', label: 'レコード番号', noLabel: false },
    quote_no: text('quote_no', '見積番号', { unique: true }),
    quote_category: {
      type: 'DROP_DOWN', code: 'quote_category', label: '分類', noLabel: false, required: false,
      options: { '文具': { label: '文具', index: '0' }, '機器': { label: '機器', index: '1' } },
      defaultValue: '',
    },
    product_lookup: text('product_lookup', '商品', {
      lookup: {
        relatedApp: { app: '296', code: '' },
        relatedKeyField: 'product_code',
        fieldMappings: [
          { field: 'quote_price', relatedField: 'old_price' },
          { field: 'quote_product_name', relatedField: 'product_name' },
        ],
        lookupPickerFields: ['product_code', 'product_name', 'old_price'],
        filterCond: '',
        sort: '',
      },
    }),
    quote_price: number('quote_price', '見積単価'),
    quote_product_name: text('quote_product_name', '商品名'),
    customer_lookup: text('customer_lookup', '顧客', {
      lookup: {
        relatedApp: { app: '298', code: '' },
        relatedKeyField: 'customer_code',
        fieldMappings: [{ field: 'customer_name', relatedField: 'name' }],
        lookupPickerFields: ['customer_code', 'name'],
        filterCond: '',
        sort: '',
      },
    }),
    customer_name: text('customer_name', '顧客名'),
    items: {
      type: 'SUBTABLE', code: 'items', label: '明細',
      fields: {
        item_lookup: text('item_lookup', '明細商品', {
          lookup: {
            relatedApp: { app: '296', code: '' },
            relatedKeyField: 'product_code',
            fieldMappings: [{ field: 'item_price', relatedField: 'new_price' }],
            lookupPickerFields: ['product_code', 'new_price'],
            filterCond: '',
            sort: '',
          },
        }),
        item_price: number('item_price', '明細単価'),
      },
    },
    related_products: {
      type: 'REFERENCE_TABLE', code: 'related_products', label: '関連商品', noLabel: false,
      referenceTable: {
        relatedApp: { app: '296', code: '' },
        condition: { field: 'quote_category', relatedField: 'category' },
        displayFields: ['product_code', 'product_name'],
        filterCond: '',
        sort: '',
        size: '5',
      },
    },
  },
};

const fields298 = {
  properties: {
    'レコード番号': { type: 'RECORD_NUMBER', code: 'レコード番号', label: 'レコード番号', noLabel: false },
    customer_code: text('customer_code', '顧客コード', { unique: true }),
    name: text('name', '顧客名'),
  },
};

const actions297 = {
  actions: {
    '商品登録': {
      id: '11', name: '商品登録', index: '0',
      destApp: { app: '296', code: '' },
      mappings: [
        { srcType: 'FIELD', srcField: 'quote_product_name', destField: 'product_name' },
        { srcType: 'RECORD_URL', destField: 'memo' },
      ],
      entities: [],
      filterCond: '',
    },
  },
  revision: '3',
};

module.exports = {
  SELF_APP: '296',
  apps: [
    { appId: '296', code: '', name: '商品マスタ' },
    { appId: '297', code: '', name: '見積' },
    { appId: '298', code: '', name: '顧客管理' },
  ],
  fieldsByApp: { '296': fields296, '297': fields297, '298': fields298 },
  actionsByApp: { '297': actions297, '298': { actions: {}, revision: '1' } },
  fields296, fields297, fields298, actions297,
};
