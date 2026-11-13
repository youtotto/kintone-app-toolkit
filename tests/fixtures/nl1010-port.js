// 2026-10-10 の実機（自然な会話の確認・App 353 相当）の保存済みの素材から写した固定データ（有料の AI は使わない）。
//   元: realrun-1010/nl-material/active-plan-full.json（作業用の記録。リポジトリの外）。計画の customizations（C1〜C3）・移植元の既存 JavaScript の本文・
//   C3（既存の入力チェックのモバイルへの移植）の生成されたコードと、そのときの必須の効果・模擬テストの代表条件・修復の記録（いつでも保存を止める期待で正しいコードが不合格になり、
//   修復を 1 回呼んで同じ候補が返った）。作業者のメールアドレス等の個人の情報は含めない（計画の手順 P1〜P5 は写していない）
'use strict';
/** 計画の customizations（C1: PC の編集不可を dealLock.js に統合 / C2: モバイルの編集不可 / C3: PC の dealValidate.js をモバイルへ移植。block-save の condition は空） */
const CUSTOMIZATIONS = [
  {
    "customizationId": "C1",
    "requirement": "PCで承認済みの金額と明細のセルを編集不可にし、それ以外ではこの制御を解除する。差戻し後は再編集可能とする。明細の行の追加・削除は禁止できない。既存の入力チェックは変更せず保持する。",
    "whyStandardInsufficient": "フィールドのアクセス権はステータスで切り替えられず、レコードの編集権限を禁止すると金額と明細以外も編集できなくなります。既存ファイルが金額の編集制御を扱うため、別ファイルを重ねず統合します。",
    "strategy": "EXTEND_EXISTING_JS",
    "platform": [
      "desktop"
    ],
    "implementation": "JAVASCRIPT",
    "events": [
      "app.record.create.show",
      "app.record.edit.show",
      "app.record.index.edit.show",
      "app.record.create.change.items",
      "app.record.edit.change.items"
    ],
    "fields": [
      {
        "code": "ステータス",
        "access": "READ",
        "effects": []
      },
      {
        "code": "amount",
        "access": "CONTROL",
        "condition": "ステータス in (\"承認済み\")",
        "effects": [
          {
            "effect": "lock",
            "condition": ""
          }
        ]
      },
      {
        "code": "items",
        "access": "READ",
        "effects": []
      },
      {
        "code": "item_name",
        "access": "CONTROL",
        "condition": "ステータス in (\"承認済み\")",
        "effects": [
          {
            "effect": "lock",
            "condition": ""
          }
        ]
      },
      {
        "code": "qty",
        "access": "CONTROL",
        "condition": "ステータス in (\"承認済み\")",
        "effects": [
          {
            "effect": "lock",
            "condition": ""
          }
        ]
      },
      {
        "code": "unit_price",
        "access": "CONTROL",
        "condition": "ステータス in (\"承認済み\")",
        "effects": [
          {
            "effect": "lock",
            "condition": ""
          }
        ]
      }
    ],
    "apis": [
      "kintone.events.on"
    ],
    "existingFiles": [
      {
        "name": "dealLock.js",
        "target": "desktop",
        "reason": "同じ金額の編集可否を制御しているため"
      }
    ],
    "risks": [
      "明細のセルを編集不可にしても、行の追加・削除ボタンは残ります。行の増減を理由に保存を止める処理は追加しません。",
      "JavaScriptによる編集制御・入力チェックは画面操作にだけ有効で、APIやCSV読み込みには適用されません。",
      "既存の入力チェックのエラー処理と編集不可設定が干渉しないよう、正常・異常入力の双方で検証します。"
    ],
    "questions": [],
    "dependsOn": [],
    "evidenceIds": [
      "E43",
      "E44",
      "E16",
      "E17",
      "E20",
      "E24"
    ]
  },
  {
    "customizationId": "C2",
    "requirement": "モバイルでもPCと同じ条件で金額と明細のセルを編集不可にし、差戻し先の作成中では再編集可能とする。",
    "whyStandardInsufficient": "PC用の編集制御はモバイルでは動作せず、同じ部分的な編集制御を行うモバイル用ファイルもありません。",
    "strategy": "NEW_JS_FILE",
    "platform": [
      "mobile"
    ],
    "implementation": "JAVASCRIPT",
    "events": [
      "mobile.app.record.create.show",
      "mobile.app.record.edit.show",
      "mobile.app.record.create.change.items",
      "mobile.app.record.edit.change.items"
    ],
    "fields": [
      {
        "code": "ステータス",
        "access": "READ",
        "effects": []
      },
      {
        "code": "amount",
        "access": "CONTROL",
        "condition": "ステータス in (\"承認済み\")",
        "effects": [
          {
            "effect": "lock",
            "condition": ""
          }
        ]
      },
      {
        "code": "items",
        "access": "READ",
        "effects": []
      },
      {
        "code": "item_name",
        "access": "CONTROL",
        "condition": "ステータス in (\"承認済み\")",
        "effects": [
          {
            "effect": "lock",
            "condition": ""
          }
        ]
      },
      {
        "code": "qty",
        "access": "CONTROL",
        "condition": "ステータス in (\"承認済み\")",
        "effects": [
          {
            "effect": "lock",
            "condition": ""
          }
        ]
      },
      {
        "code": "unit_price",
        "access": "CONTROL",
        "condition": "ステータス in (\"承認済み\")",
        "effects": [
          {
            "effect": "lock",
            "condition": ""
          }
        ]
      }
    ],
    "apis": [
      "kintone.events.on"
    ],
    "existingFiles": [],
    "risks": [],
    "questions": [],
    "dependsOn": [
      "C1"
    ],
    "evidenceIds": [
      "E5",
      "E43",
      "E16",
      "E17",
      "E20",
      "E24"
    ]
  },
  {
    "customizationId": "C3",
    "requirement": "PCの既存入力チェックの本文を基に、判定条件・エラーメッセージ・保存拒否の挙動を変更せずモバイルへ移植する。PCの入力チェックはそのまま保持し、新しいチェック条件は追加しない。",
    "whyStandardInsufficient": "既存の独自入力チェックを同じ動作で維持する必要があり、PC用の保存イベントはモバイルでは発火しません。",
    "strategy": "NEW_JS_FILE",
    "platform": [
      "mobile"
    ],
    "implementation": "JAVASCRIPT",
    "events": [
      "mobile.app.record.create.submit",
      "mobile.app.record.edit.submit"
    ],
    "fields": [
      {
        "code": "amount",
        "access": "CONTROL",
        "effects": [
          {
            "effect": "block-save",
            "condition": ""
          }
        ]
      }
    ],
    "apis": [
      "kintone.events.on"
    ],
    "existingFiles": [
      {
        "name": "dealValidate.js",
        "target": "desktop",
        "reason": "既存の判定とエラー処理の移植元"
      }
    ],
    "risks": [
      "解析結果には入力チェックの具体的な判定式が載っていないため、生成時に取得済み本文と照合して既存条件だけを移植します。保存拒否は既存チェックで不正となる場合だけです。"
    ],
    "questions": [],
    "dependsOn": [
      "C2"
    ],
    "evidenceIds": [
      "E44",
      "E72",
      "E73"
    ]
  }
];
/** 移植元: PC の既存の入力チェック（dealValidate.js） */
const DEAL_VALIDATE_JS = "(function () {\n  'use strict';\n  // 保存時の入力チェック: 金額は必須・0 円以上\n  kintone.events.on(['app.record.create.submit', 'app.record.edit.submit'], function (event) {\n    var amount = event.record['amount'].value;\n    if (amount === '' || amount === null || amount === undefined) {\n      event.record['amount'].error = '金額を入力してください';\n    } else if (Number(amount) < 0) {\n      event.record['amount'].error = '金額は0円以上で入力してください';\n    }\n    return event;\n  });\n})();\n";
/** C1 の統合先: PC の既存の編集制御（dealLock.js） */
const DEAL_LOCK_JS = "(function () {\n  'use strict';\n  // 承認済みの案件は金額を変更できないようにする（既存の運用ルール）\n  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {\n    var record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認済み') {\n      record['amount'].disabled = true;\n    }\n    return event;\n  });\n})();\n";
/** C3 の生成されたコード（移植元と同じ判定・エラーの文。正しいコード） */
const C3_CODE = "(function () {\n  'use strict';\n  // PC版と同じ保存時の入力チェック\n  kintone.events.on(['mobile.app.record.create.submit', 'mobile.app.record.edit.submit'], function (event) {\n    const amount = event.record['amount'].value;\n    if (amount === '' || amount === null || amount === undefined) {\n      event.record['amount'].error = '金額を入力してください';\n    } else if (Number(amount) < 0) {\n      event.record['amount'].error = '金額は0円以上で入力してください';\n    }\n    return event;\n  });\n})();\n";
/** そのときの C3 の必須の効果（condition が空 = いつでも保存を止める、と扱われた）・代表条件・修復の記録 */
const C3_REQUIRED_EFFECTS_THEN = [
  {
    "requirementId": "C3",
    "requirementIds": [
      "C3"
    ],
    "field": "amount",
    "effect": "block-save",
    "events": [
      "mobile.app.record.create.submit",
      "mobile.app.record.edit.submit"
    ],
    "condition": ""
  }
];
const C3_CASES_THEN = [
  {
    "id": "K1",
    "event": "mobile.app.record.edit.submit",
    "expect": "block-save",
    "verdict": "fail",
    "side": "match",
    "kind": "match"
  },
  {
    "id": "K2",
    "event": "mobile.app.record.create.submit",
    "expect": "block-save",
    "verdict": "fail",
    "side": "match",
    "kind": "match"
  },
  {
    "id": "K3",
    "event": "mobile.app.record.edit.submit",
    "expect": "block-save",
    "verdict": "pass",
    "side": "match",
    "kind": "match-empty"
  }
];
const C3_REPAIRS_THEN = {
  "count": 1,
  "reasons": [
    "1 回目の修復: いつでも（条件なし）でモバイルの編集画面で保存する: 保存が止まるはずが、保存が止まりませんでした；いつでも（条件なし）でモバイルの作成画面で保存する: 保存が止まるはずが、保存が止まりませんでした",
    "修復の応答は前の候補と同じ内容でした",
    "同じ候補に同じ失敗が続いたので、同じ修復を繰り返しませんでした"
  ],
  "stoppedBy": "same-failure"
};
//   アプリのフィールドの定義は tests/fixtures/p21-bfc-replay.js の FIELDS（同じ App 353。K.DATA_C.fields）を使う
module.exports = { CUSTOMIZATIONS, DEAL_VALIDATE_JS, DEAL_LOCK_JS, C3_CODE, C3_REQUIRED_EFFECTS_THEN, C3_CASES_THEN, C3_REPAIRS_THEN };
