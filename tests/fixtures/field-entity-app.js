// App 310「案件管理」相当のアプリ設定（kintone REST API のレスポンスと同じ形）
//
//   通知先・作業者・アクセス権の対象は、kintone API では entity: { type, code } で返る。
//   「フォームのフィールドを追加」でフィールドを指定した場合の type は 'FIELD_ENTITY'
//   （code = フィールドコード。作成者／更新者／ユーザー選択／組織選択／グループ選択が対象）。
//
//   entity.type の取りうる値（cybozu developer network の各APIのレスポンス仕様）:
//     アプリの条件通知   notifications[].entity                      USER / GROUP / ORGANIZATION / FIELD_ENTITY
//     レコードの条件通知 notifications[].targets[].entity            USER / GROUP / ORGANIZATION / FIELD_ENTITY
//     リマインダー       notifications[].targets[].entity            USER / GROUP / ORGANIZATION / FIELD_ENTITY
//     プロセス管理       states.<名前>.assignee.entities[].entity    USER / GROUP / ORGANIZATION / FIELD_ENTITY / CREATOR / CUSTOM_FIELD
//                        actions[].executableUser.entities[].entity  USER / GROUP / ORGANIZATION / FIELD_ENTITY（type: SECONDARY のみ）
//     レコードのアクセス権 rights[].entities[].entity                USER / GROUP / ORGANIZATION / FIELD_ENTITY
//     フィールドのアクセス権 rights[].entities[].entity              USER / GROUP / ORGANIZATION / FIELD_ENTITY
//     アプリのアクセス権 rights[].entity                             USER / GROUP / ORGANIZATION / CREATOR（フィールド指定なし）
//   CREATOR（アプリ作成者。code は null）と CUSTOM_FIELD（cybozu.com共通管理のカスタマイズ項目）は
//   アプリのフィールドではない。
//
//   なお、アプリアクションの mappings[].srcType: 'FIELD' は entity.type とは別の語彙（コピー元がフィールドであることを示す）。
//
// このアプリでフィールド指定（FIELD_ENTITY）になっている箇所:
//   アプリの条件通知                 通知先: 作成者, owner（担当者）
//   レコードの条件通知「高額案件の登録」 通知先: approver（承認者）, owner_org（担当部署）
//   リマインダー「期限前日のリマインド」 通知先: owner（担当者）, owner_group（担当グループ）
//   プロセス管理 ステータス「承認待ち」   作業者: approver（承認者）
//   プロセス管理 アクション「取り下げる」 実行可能ユーザー: owner（担当者）
//   レコードのアクセス権 #1            対象: 更新者, owner（担当者）
//   フィールドのアクセス権 #1（amount） 対象: approver（承認者）
'use strict';

const sys = (type, code, extra = {}) => ({ type, code, label: code, noLabel: false, ...extra });
const field = (type, code, label, extra = {}) => ({ type, code, label, noLabel: false, required: false, ...extra });

// GET /k/v1/app/form/fields.json（kintone.app.getFormFields() は properties と同じ値を返す）
const fields = {
  properties: {
    'レコード番号': sys('RECORD_NUMBER', 'レコード番号'),
    '作成者': sys('CREATOR', '作成者'),
    '作成日時': sys('CREATED_TIME', '作成日時'),
    '更新者': sys('MODIFIER', '更新者'),
    '更新日時': sys('UPDATED_TIME', '更新日時'),
    'ステータス': { type: 'STATUS', code: 'ステータス', label: 'ステータス', enabled: true },
    '作業者': { type: 'STATUS_ASSIGNEE', code: '作業者', label: '作業者', enabled: true },
    'カテゴリー': { type: 'CATEGORY', code: 'カテゴリー', label: 'カテゴリー', enabled: false },
    case_name: field('SINGLE_LINE_TEXT', 'case_name', '案件名', { required: true, unique: false }),
    amount: field('NUMBER', 'amount', '金額'),
    due_date: field('DATE', 'due_date', '期限'),
    owner: field('USER_SELECT', 'owner', '担当者', { entities: [], defaultValue: [] }),
    approver: field('USER_SELECT', 'approver', '承認者', { entities: [], defaultValue: [] }),
    owner_org: field('ORGANIZATION_SELECT', 'owner_org', '担当部署', { entities: [], defaultValue: [] }),
    owner_group: field('GROUP_SELECT', 'owner_group', '担当グループ', { entities: [], defaultValue: [] }),
    secret_memo: field('MULTI_LINE_TEXT', 'secret_memo', '機密メモ'),
  },
  revision: '12',
};

// GET /k/v1/app/notifications/general.json
const generalNotify = {
  notifications: [
    {
      entity: { type: 'USER', code: 'user1' }, includeSubs: false,
      recordAdded: true, recordEdited: true, commentAdded: false, statusChanged: false, fileImported: true,
    },
    {
      entity: { type: 'FIELD_ENTITY', code: '作成者' }, includeSubs: false,
      recordAdded: false, recordEdited: true, commentAdded: true, statusChanged: true, fileImported: false,
    },
    {
      entity: { type: 'FIELD_ENTITY', code: 'owner' }, includeSubs: false,
      recordAdded: true, recordEdited: true, commentAdded: true, statusChanged: true, fileImported: false,
    },
    {
      entity: { type: 'GROUP', code: 'sales_group' }, includeSubs: false,
      recordAdded: true, recordEdited: false, commentAdded: false, statusChanged: false, fileImported: false,
    },
    {
      entity: { type: 'ORGANIZATION', code: 'sales_dept' }, includeSubs: true,
      recordAdded: true, recordEdited: false, commentAdded: false, statusChanged: false, fileImported: false,
    },
  ],
  notifyToCommenter: true,
  revision: '12',
};

// GET /k/v1/app/notifications/perRecord.json
const perRecordNotify = {
  notifications: [
    {
      filterCond: 'amount >= "1000000"',
      title: '高額案件の登録',
      targets: [
        { entity: { type: 'USER', code: 'user1' }, includeSubs: false },
        { entity: { type: 'FIELD_ENTITY', code: 'approver' }, includeSubs: false },
        { entity: { type: 'FIELD_ENTITY', code: 'owner_org' }, includeSubs: true },
      ],
    },
    {
      // タイトル未設定・通知先にフィールド指定なし（条件式だけがフィールドを参照する）
      filterCond: 'owner in (LOGINUSER())',
      title: '',
      targets: [
        { entity: { type: 'GROUP', code: 'sales_group' }, includeSubs: false },
        { entity: { type: 'ORGANIZATION', code: 'sales_dept' }, includeSubs: true },
      ],
    },
  ],
  revision: '12',
};

// GET /k/v1/app/notifications/reminder.json
const reminderNotify = {
  notifications: [
    {
      timing: { code: 'due_date', daysLater: '-1', time: '09:00' },
      filterCond: 'amount > "0"',
      title: '期限前日のリマインド',
      targets: [
        { entity: { type: 'FIELD_ENTITY', code: 'owner' }, includeSubs: false },
        { entity: { type: 'FIELD_ENTITY', code: 'owner_group' }, includeSubs: false },
        { entity: { type: 'USER', code: 'user1' }, includeSubs: false },
      ],
    },
  ],
  timezone: 'Asia/Tokyo',
  revision: '12',
};

// GET /k/v1/app/status.json
const status = {
  enable: true,
  states: {
    '未処理': { name: '未処理', index: '0', assignee: { type: 'ONE', entities: [] } },
    '承認待ち': {
      name: '承認待ち', index: '1',
      assignee: {
        type: 'ALL',
        entities: [
          { entity: { type: 'USER', code: 'user1' }, includeSubs: false },
          { entity: { type: 'FIELD_ENTITY', code: 'approver' }, includeSubs: false },
          { entity: { type: 'CUSTOM_FIELD', code: 'supervisor' }, includeSubs: false },
          { entity: { type: 'CREATOR', code: null }, includeSubs: false },
          { entity: { type: 'GROUP', code: 'sales_group' }, includeSubs: false },
          { entity: { type: 'ORGANIZATION', code: 'sales_dept' }, includeSubs: true },
        ],
      },
    },
    '完了': { name: '完了', index: '2', assignee: { type: 'ONE', entities: [] } },
  },
  actions: [
    { name: '申請する', from: '未処理', to: '承認待ち', filterCond: 'amount > "0"', type: 'PRIMARY', executableUser: { entities: [] } },
    { name: '承認する', from: '承認待ち', to: '完了', filterCond: '', type: 'PRIMARY' },
    {
      // 「作業者以外でも実行できるアクション」
      name: '取り下げる', from: '承認待ち', to: '未処理', filterCond: '', type: 'SECONDARY',
      executableUser: {
        entities: [
          { entity: { type: 'FIELD_ENTITY', code: 'owner' }, includeSubs: false },
          { entity: { type: 'USER', code: 'user2' }, includeSubs: false },
        ],
      },
    },
  ],
  revision: '12',
};

// GET /k/v1/app/acl.json（フィールド指定は無い。CREATOR の code は null）
const appAcl = {
  rights: [
    {
      entity: { type: 'CREATOR', code: null }, includeSubs: false,
      appEditable: true, recordViewable: true, recordAddable: true, recordEditable: true,
      recordDeletable: true, recordImportable: true, recordExportable: true,
    },
    {
      entity: { type: 'GROUP', code: 'everyone' }, includeSubs: false,
      appEditable: false, recordViewable: true, recordAddable: true, recordEditable: true,
      recordDeletable: false, recordImportable: false, recordExportable: false,
    },
  ],
  revision: '12',
};

// GET /k/v1/record/acl.json
const recordAcl = {
  rights: [
    {
      filterCond: 'amount >= "1000000"',
      entities: [
        { entity: { type: 'ORGANIZATION', code: 'sales_dept' }, viewable: false, editable: false, deletable: false, includeSubs: true },
        { entity: { type: 'FIELD_ENTITY', code: '更新者' }, viewable: true, editable: true, deletable: true, includeSubs: false },
        { entity: { type: 'FIELD_ENTITY', code: 'owner' }, viewable: true, editable: true, deletable: false, includeSubs: false },
      ],
    },
    {
      filterCond: '',
      entities: [
        { entity: { type: 'GROUP', code: 'everyone' }, viewable: true, editable: false, deletable: false, includeSubs: false },
      ],
    },
  ],
  revision: '12',
};

// GET /k/v1/field/acl.json
const fieldAcl = {
  rights: [
    {
      code: 'amount',
      entities: [
        { accessibility: 'WRITE', entity: { type: 'FIELD_ENTITY', code: 'approver' }, includeSubs: false },
        { accessibility: 'READ', entity: { type: 'GROUP', code: 'sales_group' }, includeSubs: false },
        { accessibility: 'NONE', entity: { type: 'ORGANIZATION', code: 'sales_dept' }, includeSubs: true },
      ],
    },
    {
      code: 'secret_memo',
      entities: [
        { accessibility: 'WRITE', entity: { type: 'USER', code: 'user1' }, includeSubs: false },
        { accessibility: 'NONE', entity: { type: 'GROUP', code: 'everyone' }, includeSubs: false },
      ],
    },
  ],
  revision: '12',
};

// GET /k/v1/app/actions.json（entities は entity で包まれず type / code を直接持つ。フィールド指定は無い）
const actions = {
  actions: {
    '見積を作成': {
      name: '見積を作成', id: '5520', index: '0',
      destApp: { app: '311', code: '' },
      mappings: [
        { srcType: 'FIELD', srcField: 'case_name', destField: 'quote_title' },
        { srcType: 'RECORD_URL', destField: 'source_url' },
      ],
      entities: [
        { type: 'USER', code: 'user1' },
        { type: 'GROUP', code: 'sales_group' },
      ],
      filterCond: '',
    },
  },
  revision: '12',
};

/** prefetchAppData の戻り値（DATA）と同じ形に組み立てる。呼び出しごとに独立したコピーを返す */
const makeData = () => JSON.parse(JSON.stringify({
  appId: 310,
  fields: fields.properties,
  settings: { name: '案件管理' },
  status, generalNotify, perRecordNotify, reminderNotify,
  appAcl, recordAcl, fieldAcl, actions,
}));

module.exports = {
  APP_ID: 310,
  fields, generalNotify, perRecordNotify, reminderNotify, status, appAcl, recordAcl, fieldAcl, actions,
  makeData,
};
