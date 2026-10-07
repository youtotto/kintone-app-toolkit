// 段階 A（R15）: 利用者が実機で見た編集制限コードと同型の素材。実機のコードは保存されていないので、要件から同型に起こした。
//   PC: 承認待ち 2 種類（課長承認待ち・部長承認待ち）で金額と明細のセルを編集不可、一覧の編集（index.edit.show）でも同じ、
//   保存を止める入力チェックは既存の dealValidate.js（submit の error）、承認済みのロックは既存の dealLock.js。新しい処理は dealLock.js に統合する。
//   フィールドの定義・既存の 2 ファイルは p21-bfc-replay.js（App 353 の写し）から
'use strict';
const R = require('./p21-bfc-replay.js');

/** プロセス管理: 作成中 → 課長承認待ち / 部長承認待ち → 承認済み（両方の承認待ちが実在する状態） */
const STATUS = {
  enable: true,
  states: {
    '作成中': { name: '作成中', index: '0', assignee: { type: 'ONE', entities: [] } },
    '課長承認待ち': { name: '課長承認待ち', index: '1', assignee: { type: 'ONE', entities: [] } },
    '部長承認待ち': { name: '部長承認待ち', index: '2', assignee: { type: 'ONE', entities: [] } },
    '承認済み': { name: '承認済み', index: '3', assignee: { type: 'ONE', entities: [] } },
  },
  actions: [
    { name: '課長へ申請', from: '作成中', to: '課長承認待ち', filterCond: 'amount < "1000000"' },
    { name: '部長へ申請', from: '作成中', to: '部長承認待ち', filterCond: 'amount >= "1000000"' },
    { name: '課長が承認する', from: '課長承認待ち', to: '承認済み', filterCond: '' },
    { name: '部長が承認する', from: '部長承認待ち', to: '承認済み', filterCond: '' },
    { name: '差し戻す', from: '承認済み', to: '作成中', filterCond: '' },
  ],
};

/** dealLock.js に足す handler（承認待ち 2 種類のロック。通常の編集画面と一覧の編集。明細のセルも） */
const EDIT_LOCK_CONTENT = [
  "  // 課長承認待ち・部長承認待ちでは金額と明細のセルを編集不可にする（通常の編集画面と一覧の編集）",
  "  kintone.events.on(['app.record.edit.show', 'app.record.index.edit.show'], function (event) {",
  "    const record = event.record;",
  "    const st = record['ステータス'] ? record['ステータス'].value : '';",
  "    if (st !== '課長承認待ち' && st !== '部長承認待ち') {",
  "      return event;",
  "    }",
  "    record['amount'].disabled = true;",
  "    if (record['items']) {",
  "      record['items'].value.forEach(function (row) {",
  "        row.value['item_name'].disabled = true;",
  "        row.value['qty'].disabled = true;",
  "        row.value['unit_price'].disabled = true;",
  "      });",
  "    }",
  "    return event;",
  "  });",
  "",
].join('\n');

const COND = 'ステータス in ("課長承認待ち", "部長承認待ち")';
/** 実装仕様（Customization Plan）: 既存の dealLock.js に統合。保存時の入力チェック（dealValidate.js）はそのまま */
const CUSTOMIZATION = {
  customizationId: 'C1',
  requirement: 'PC で、ステータスが課長承認待ちまたは部長承認待ちのとき、通常の編集画面と一覧の編集で金額と明細のセルを編集不可にする。保存時の入力チェック（dealValidate.js）と承認済みの既存の制御（dealLock.js）はそのまま残す',
  whyStandardInsufficient: 'ステータスで切り替えるフィールドのアクセス権は無い',
  strategy: 'EXTEND_EXISTING_JS', implementation: 'JAVASCRIPT', platform: ['desktop'],
  events: ['app.record.edit.show', 'app.record.index.edit.show'],
  fields: [
    { code: 'ステータス', access: 'READ' },
    { code: 'amount', access: 'CONTROL', condition: COND },
    { code: 'items', access: 'CONTROL', condition: COND },
    { code: 'item_name', access: 'CONTROL', condition: COND },
    { code: 'qty', access: 'CONTROL', condition: COND },
    { code: 'unit_price', access: 'CONTROL', condition: COND },
  ],
  apis: [], existingFiles: [{ name: 'dealLock.js', target: 'desktop', reason: '承認済みのロックと同じファイルに統合する' }], risks: [], questions: [], dependsOn: [], evidenceIds: [],
};

/** 生成結果（Gateway の generated と同じ形。baseHash はテストで KTScan.hashText(R.DEAL_LOCK) を入れる） */
const generatedOf = (baseHash) => ({
  strategy: 'EXTEND_EXISTING_JS', targetFile: 'dealLock.js',
  summary: '課長承認待ち・部長承認待ちでは、通常の編集画面と一覧の編集で金額と明細のセルを編集不可にします。承認済みの既存のロックと保存時の入力チェックは変えません。',
  code: EDIT_LOCK_CONTENT,
  patch: { baseHash, operations: [{ type: 'INSERT_BEFORE', anchor: '})();', content: EDIT_LOCK_CONTENT }] },
  events: ['app.record.edit.show', 'app.record.index.edit.show'],
  fields: CUSTOMIZATION.fields.map(f => ({ code: f.code, access: f.access })), apis: [], assumptions: [], warnings: [],
  coverage: [
    { requirement: '課長承認待ち・部長承認待ちで金額と明細のセルを編集不可にする', status: 'MET', note: '' },
    { requirement: '一覧の編集でも同じ', status: 'MET', note: 'app.record.index.edit.show でも同じ判定' },
    { requirement: '明細の行の追加・削除も止める', status: 'PARTIAL', note: 'セルの編集だけ。行の追加・削除は JavaScript では止められない' },
    { requirement: '保存時の入力チェックは残す', status: 'MET', note: '既存の dealValidate.js を変えない' },
  ],
});

module.exports = { STATUS, EDIT_LOCK_CONTENT, COND, CUSTOMIZATION, generatedOf, FIELDS: R.FIELDS, DEAL_LOCK: R.DEAL_LOCK, DEAL_VALIDATE: R.DEAL_VALIDATE };
