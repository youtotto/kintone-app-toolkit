// Q2（金額の境界）の局所修正（2026-10-14）の期待値の素材。保存済みの計画（AI版 sandbox/test/fixtures/scenarios/nl1010.js の PLAN。2026-10-10 の実機の証拠）は
//   そのまま残し、この写しだけを直した。直した点:
//   - P2（既存の「申請する」を課長承認側に限定）の spec.filterCond を amount <= "999999" → amount <= "1000000" and amount != "1000000"
//     （アプリの設定の数値の条件は > < が使えず <= != と and は使える。100 万円未満をこの形で表すと、整数でも小数でも部長側 amount >= "1000000" と重なり・漏れが無い）。
//     confidence を CONFIRMED・reason を新しい形の説明・validation.status を 'ok' に
//   - questions から Q2（整数か小数か）を外し、Q1（明細の行の追加・削除の扱い。合意済みの制約の聞き直し）は priority 'later' に
//   - assessment.uncertainties から Q2 の出どころ（小数のときの条件式）の 1 文を外し、summary の件数を合わせた
//   C1〜C3・P1・P3〜P5・impact・provisionals・unknowns は保存済みのまま。移植元の本文・C3 の生成されたコードは tests/fixtures/nl1010-port.js を使う
'use strict';
/** 直した計画（P2 の条件が <= と != の and） */
const PLAN_FIXED = {
  "goal": "100万円以上は部長承認、100万円未満は課長承認にしたい。承認済みでは金額と明細を変更できなくし、差戻し後は再編集できるようにして。今ある入力チェックは残して、PCとモバイルの両方で使いたい\n採用した方針: 金額が100万円以上なら部長承認、100万円未満なら課長承認に分岐する。／既存の「承認待ち」を課長承認に使い、部長承認用のステータスを1つだけ追加する。承認者は今の「承認待ち」の作業者の指定を両方に使用する。／「承認済み」では金額と明細を変更できなくする。／差戻し後は金額と明細を再編集できるようにする。／既存の入力チェックを維持し、承認・編集制御・入力チェックをPCとモバイルの両方に対応させる。",
  "assessment": {
    "summary": "既存の承認経路とフィールドを再利用でき、新規フィールドは不要です。ステータスに応じた部分的な編集制御とモバイルの入力チェックにはカスタマイズが必要で、明細の行操作の禁止は別途扱いを決める必要があります。",
    "usableExistingFields": [
      {
        "fieldCode": "amount",
        "note": "",
        "evidenceIds": []
      },
      {
        "fieldCode": "ステータス",
        "note": "",
        "evidenceIds": []
      },
      {
        "fieldCode": "items",
        "note": "セル制御だけでは行の追加・削除を禁止できません。",
        "evidenceIds": []
      },
      {
        "fieldCode": "item_name",
        "note": "",
        "evidenceIds": []
      },
      {
        "fieldCode": "qty",
        "note": "",
        "evidenceIds": []
      },
      {
        "fieldCode": "unit_price",
        "note": "",
        "evidenceIds": []
      },
      {
        "fieldCode": "subtotal",
        "note": "計算フィールドのため直接編集の対象外です。",
        "evidenceIds": []
      }
    ],
    "usableExistingSettings": [
      {
        "kind": "PROCESS_STATUS",
        "name": "承認待ち",
        "note": "",
        "evidenceIds": []
      },
      {
        "kind": "PROCESS_STATUS",
        "name": "作成中",
        "note": "",
        "evidenceIds": []
      },
      {
        "kind": "PROCESS_STATUS",
        "name": "承認済み",
        "note": "",
        "evidenceIds": []
      },
      {
        "kind": "PROCESS_ACTION",
        "name": "申請する",
        "note": "",
        "evidenceIds": []
      },
      {
        "kind": "PROCESS_ACTION",
        "name": "承認する",
        "note": "",
        "evidenceIds": []
      },
      {
        "kind": "PROCESS_ACTION",
        "name": "差し戻す",
        "note": "",
        "evidenceIds": []
      },
      {
        "kind": "JS",
        "name": "dealLock.js",
        "note": "",
        "evidenceIds": []
      },
      {
        "kind": "JS",
        "name": "dealValidate.js",
        "note": "既存のチェック条件と保存時の挙動を保持します。",
        "evidenceIds": []
      }
    ],
    "missingCapabilities": [
      "フィールドのアクセス権では、ステータスに応じて金額と明細だけの編集可否を切り替えられません。",
      "JavaScriptの編集不可設定では明細の行の追加・削除を禁止できません。"
    ],
    "uncertainties": []
  },
  "relevantFields": [],
  "proposedFields": [],
  "steps": [
    {
      "id": "P1",
      "actionType": "ADD_PROCESS_STATUS",
      "targetKind": "PROCESS_STATUS",
      "targetRef": "部長承認待ち",
      "targetExists": false,
      "title": "部長承認待ちを追加",
      "proposal": {
        "summary": "",
        "details": []
      },
      "spec": {
        "name": "部長承認待ち",
        "assignees": [
          "USER:user.approver"
        ],
        "assigneeType": "ONE"
      },
      "dependsOn": [],
      "reason": "既存の「承認待ち」は残し、回答どおり同じ作業者指定と選択方式を引き継ぎます。",
      "evidenceIds": [],
      "confidence": "CONFIRMED",
      "alternativeId": null,
      "solution": "STANDARD",
      "validation": {
        "status": "ok",
        "issues": []
      },
      "execution": {
        "mode": "PREVIEW_SUPPORTED",
        "supported": true,
        "reason": "Toolkit の Preview Executor が動作テスト環境へ反映できます（プロセス管理が有効なアプリへのステータス追加（作業者付き））。運用環境へは反映しません。実行可否の正本は Toolkit の Review / Executor"
      }
    },
    {
      "id": "P2",
      "actionType": "UPDATE_PROCESS",
      "targetKind": "PROCESS_ACTION",
      "targetRef": "申請する",
      "targetExists": true,
      "title": "既存の申請を課長承認側に限定",
      "proposal": {
        "summary": "",
        "details": []
      },
      "spec": {
        "filterCond": "amount <= \"1000000\" and amount != \"1000000\"",
        "changeKind": "ACTION_CONDITION"
      },
      "dependsOn": [],
      "reason": "既存の名称と遷移先を保持します。100万円未満を <= と != で表すので、小数でも部長側と漏れ・重なりなく分岐できます。",
      "evidenceIds": [],
      "confidence": "CONFIRMED",
      "alternativeId": null,
      "solution": "STANDARD",
      "validation": {
        "status": "ok",
        "issues": []
      },
      "execution": {
        "mode": "PREVIEW_SUPPORTED",
        "supported": true,
        "reason": "Toolkit の Preview Executor が動作テスト環境へ反映できます（既存アクションの条件・遷移先、既存ステータスの作業者、実行可能ユーザーの変更（削除・改名・有効化・無効化は計画のみ））。運用環境へは反映しません。実行可否の正本は Toolkit の Review / Executor"
      }
    },
    {
      "id": "P3",
      "actionType": "ADD_PROCESS_ACTION",
      "targetKind": "PROCESS_ACTION",
      "targetRef": "部長へ申請",
      "targetExists": false,
      "title": "部長承認への申請経路を追加",
      "proposal": {
        "summary": "",
        "details": []
      },
      "spec": {
        "name": "部長へ申請",
        "from": "作成中",
        "to": "部長承認待ち",
        "filterCond": "amount >= \"1000000\""
      },
      "dependsOn": [
        "P1",
        "P2"
      ],
      "reason": "既存の申請経路を置き換えず、採用した金額分岐のもう一方を追加します。",
      "evidenceIds": [],
      "confidence": "CONFIRMED",
      "alternativeId": null,
      "solution": "STANDARD",
      "validation": {
        "status": "ok",
        "issues": []
      },
      "execution": {
        "mode": "PREVIEW_SUPPORTED",
        "supported": true,
        "reason": "Toolkit の Preview Executor が動作テスト環境へ反映できます（プロセス管理が有効なアプリへのアクション追加（遷移元 / 遷移先 / 条件 / 実行可能ユーザー））。運用環境へは反映しません。実行可否の正本は Toolkit の Review / Executor"
      }
    },
    {
      "id": "P4",
      "actionType": "ADD_PROCESS_ACTION",
      "targetKind": "PROCESS_ACTION",
      "targetRef": "部長承認する",
      "targetExists": false,
      "title": "部長承認から承認済みへの経路を追加",
      "proposal": {
        "summary": "",
        "details": []
      },
      "spec": {
        "name": "部長承認する",
        "from": "部長承認待ち",
        "to": "承認済み"
      },
      "dependsOn": [
        "P1"
      ],
      "reason": "部長承認側にも出口を設けます。既存の課長承認経路は変更せず、作業者による承認とします。",
      "evidenceIds": [],
      "confidence": "CONFIRMED",
      "alternativeId": null,
      "solution": "STANDARD",
      "validation": {
        "status": "ok",
        "issues": []
      },
      "execution": {
        "mode": "PREVIEW_SUPPORTED",
        "supported": true,
        "reason": "Toolkit の Preview Executor が動作テスト環境へ反映できます（プロセス管理が有効なアプリへのアクション追加（遷移元 / 遷移先 / 条件 / 実行可能ユーザー））。運用環境へは反映しません。実行可否の正本は Toolkit の Review / Executor"
      }
    },
    {
      "id": "P5",
      "actionType": "ADD_PROCESS_ACTION",
      "targetKind": "PROCESS_ACTION",
      "targetRef": "部長から差し戻す",
      "targetExists": false,
      "title": "部長承認から作成中への差戻しを追加",
      "proposal": {
        "summary": "",
        "details": []
      },
      "spec": {
        "name": "部長から差し戻す",
        "from": "部長承認待ち",
        "to": "作成中"
      },
      "dependsOn": [
        "P1"
      ],
      "reason": "課長側の既存の差戻しと同じ戻り先を使い、部長側でも再編集・再申請できるようにします。",
      "evidenceIds": [],
      "confidence": "CONFIRMED",
      "alternativeId": null,
      "solution": "STANDARD",
      "validation": {
        "status": "ok",
        "issues": []
      },
      "execution": {
        "mode": "PREVIEW_SUPPORTED",
        "supported": true,
        "reason": "Toolkit の Preview Executor が動作テスト環境へ反映できます（プロセス管理が有効なアプリへのアクション追加（遷移元 / 遷移先 / 条件 / 実行可能ユーザー））。運用環境へは反映しません。実行可否の正本は Toolkit の Review / Executor"
      }
    },
    {
      "id": "C1",
      "actionType": "CUSTOMIZATION_REQUIRED",
      "targetKind": "JS",
      "targetRef": "dealLock.js",
      "targetExists": true,
      "title": "PCの編集制御を既存ファイルへ統合",
      "proposal": {
        "summary": "",
        "details": []
      },
      "spec": {
        "customizationId": "C1"
      },
      "dependsOn": [],
      "reason": "",
      "evidenceIds": [],
      "confidence": "CONFIRMED",
      "alternativeId": null,
      "solution": "CUSTOMIZATION",
      "validation": {
        "status": "ok",
        "issues": []
      },
      "execution": {
        "mode": "PLAN_ONLY",
        "supported": false,
        "reason": "Planner MVP では自動変更未実装（計画の提示のみ）"
      }
    },
    {
      "id": "C2",
      "actionType": "CUSTOMIZATION_REQUIRED",
      "targetKind": "JS",
      "targetRef": null,
      "targetExists": null,
      "title": "モバイル用の編集制御を追加",
      "proposal": {
        "summary": "",
        "details": []
      },
      "spec": {
        "customizationId": "C2"
      },
      "dependsOn": [
        "C1"
      ],
      "reason": "",
      "evidenceIds": [],
      "confidence": "CONFIRMED",
      "alternativeId": null,
      "solution": "CUSTOMIZATION",
      "validation": {
        "status": "ok",
        "issues": []
      },
      "execution": {
        "mode": "PLAN_ONLY",
        "supported": false,
        "reason": "Planner MVP では自動変更未実装（計画の提示のみ）"
      }
    },
    {
      "id": "C3",
      "actionType": "CUSTOMIZATION_REQUIRED",
      "targetKind": "JS",
      "targetRef": null,
      "targetExists": null,
      "title": "既存の入力チェックをモバイルへ移植",
      "proposal": {
        "summary": "",
        "details": []
      },
      "spec": {
        "customizationId": "C3"
      },
      "dependsOn": [
        "C2"
      ],
      "reason": "",
      "evidenceIds": [],
      "confidence": "INFERRED",
      "alternativeId": null,
      "solution": "CUSTOMIZATION",
      "validation": {
        "status": "ok",
        "issues": []
      },
      "execution": {
        "mode": "PLAN_ONLY",
        "supported": false,
        "reason": "Planner MVP では自動変更未実装（計画の提示のみ）"
      }
    }
  ],
  "alternatives": [],
  "impact": [
    {
      "targetKind": "PROCESS_ACTION",
      "targetRef": "申請する",
      "description": "既存の申請先は保持されますが、金額によって実行できる申請ボタンが変わります。既存の承認・差戻しは変更しません。",
      "evidenceIds": [],
      "confidence": "CONFIRMED",
      "validation": {
        "status": "ok"
      }
    },
    {
      "targetKind": "NOTIFICATION",
      "targetRef": "general#3",
      "description": "既存の作業者へのステータス変更通知を継続利用できます。部長承認側にも作業者を指定するため、重複する通知は追加しません。",
      "evidenceIds": [],
      "confidence": "CONFIRMED",
      "validation": {
        "status": "ok"
      }
    },
    {
      "targetKind": "VIEW",
      "targetRef": "（作業者が自分）",
      "description": "既存の作業者による絞り込みを維持し、部長承認待ちも現在の作業者の一覧に表示されます。",
      "evidenceIds": [],
      "confidence": "CONFIRMED",
      "validation": {
        "status": "ok"
      }
    },
    {
      "targetKind": "JS",
      "targetRef": "dealLock.js",
      "description": "金額の既存制御に明細セルと一覧編集対応を統合",
      "evidenceIds": [],
      "confidence": "CONFIRMED",
      "validation": {
        "status": "ok"
      }
    },
    {
      "targetKind": "JS",
      "targetRef": "dealValidate.js",
      "description": "PCの既存チェックを保持しモバイル移植元に使用",
      "evidenceIds": [],
      "confidence": "CONFIRMED",
      "validation": {
        "status": "ok"
      }
    },
    {
      "targetKind": "FIELD",
      "targetRef": "subtotal",
      "description": "小計の計算式は変更しません。数量と単価を再編集できる状態では、従来どおり計算されます。",
      "evidenceIds": [],
      "confidence": "CONFIRMED",
      "validation": {
        "status": "ok"
      }
    }
  ],
  "questions": [
    {
      "id": "Q1",
      "question": "承認済みの明細について、セルを編集不可にしても行の追加・削除は残ります。この行操作はどのように扱いますか？",
      "reason": "明細全体の変更禁止はセルの編集制御だけでは満たせません。保存時に行の増減を禁止する処理は依頼にないため追加していません。",
      "relatedEvidenceIds": [],
      "topic": "scope",
      "decisionRef": "",
      "impact": "運用ルールで扱うか、承認済みレコード全体の編集権限を制限するかで実装範囲が変わります。",
      "options": [
        "セルの編集禁止とし、行の追加・削除は運用で禁止する",
        "承認済みレコード全体の編集権限を制限する案を検討する",
        "行の増減を保存時に検出して保存を止める要件を追加する"
      ],
      "recommendation": "",
      "priority": "later"
    }
  ],
  "provisionals": [
    {
      "id": "A1",
      "topic": "承認後の経路",
      "choice": "承認済みからの新しい差戻し経路は入れていない",
      "reason": "既存の承認待ちからの差戻しと、部長承認待ちからの差戻しを対象にしています。",
      "changeHint": "承認済みからも差し戻したい場合は、その操作を行う役割を伝えてください。"
    },
    {
      "id": "A2",
      "topic": "申請後の金額変更",
      "choice": "承認待ち同士の移動や承認時の追加金額チェックは入れていない",
      "reason": "採用された申請時の金額分岐だけを実装します。",
      "changeHint": "申請後の金額変更にも承認経路を連動させたい場合は伝えてください。"
    }
  ],
  "unknowns": [
    "既存の入力チェックの具体的な判定条件は解析結果に含まれていません。移植時に本文から再利用し、独自の条件を推測で追加しません。"
  ],
  "planConfidence": "NEEDS_CONFIRMATION",
  "solution": "HYBRID",
  "customizations": [
    {
      "customizationId": "C1",
      "requirement": "PCで承認済みの金額と明細のセルを編集不可にし、それ以外ではこの制御を解除する。差戻し後は再編集可能とする。明細の行の追加・削除は禁止できない。既存の入力チェックは変更せず保持する。",
      "whyStandardInsufficient": "フィールドのアクセス権はステータスで切り替えられず、レコードの編集権限を禁止すると金額と明細以外も編集できなくなります。既存ファイルが金額の編集制御を扱うため、別ファイルを重ねず統合します。",
      "strategy": "EXTEND_EXISTING_JS",
      "implementation": "JAVASCRIPT",
      "platform": [
        "desktop"
      ],
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
          "proposed": false,
          "effects": []
        },
        {
          "code": "amount",
          "access": "CONTROL",
          "proposed": false,
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
          "proposed": false,
          "effects": []
        },
        {
          "code": "item_name",
          "access": "CONTROL",
          "proposed": false,
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
          "proposed": false,
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
          "proposed": false,
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
      "evidenceIds": [],
      "confidence": "CONFIRMED",
      "validation": {
        "status": "ok",
        "issues": []
      }
    },
    {
      "customizationId": "C2",
      "requirement": "モバイルでもPCと同じ条件で金額と明細のセルを編集不可にし、差戻し先の作成中では再編集可能とする。",
      "whyStandardInsufficient": "PC用の編集制御はモバイルでは動作せず、同じ部分的な編集制御を行うモバイル用ファイルもありません。",
      "strategy": "NEW_JS_FILE",
      "implementation": "JAVASCRIPT",
      "platform": [
        "mobile"
      ],
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
          "proposed": false,
          "effects": []
        },
        {
          "code": "amount",
          "access": "CONTROL",
          "proposed": false,
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
          "proposed": false,
          "effects": []
        },
        {
          "code": "item_name",
          "access": "CONTROL",
          "proposed": false,
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
          "proposed": false,
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
          "proposed": false,
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
      "evidenceIds": [],
      "confidence": "CONFIRMED",
      "validation": {
        "status": "ok",
        "issues": []
      }
    },
    {
      "customizationId": "C3",
      "requirement": "PCの既存入力チェックの本文を基に、判定条件・エラーメッセージ・保存拒否の挙動を変更せずモバイルへ移植する。PCの入力チェックはそのまま保持し、新しいチェック条件は追加しない。",
      "whyStandardInsufficient": "既存の独自入力チェックを同じ動作で維持する必要があり、PC用の保存イベントはモバイルでは発火しません。",
      "strategy": "NEW_JS_FILE",
      "implementation": "JAVASCRIPT",
      "platform": [
        "mobile"
      ],
      "events": [
        "mobile.app.record.create.submit",
        "mobile.app.record.edit.submit"
      ],
      "fields": [
        {
          "code": "amount",
          "access": "CONTROL",
          "proposed": false,
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
      "evidenceIds": [],
      "confidence": "INFERRED",
      "validation": {
        "status": "ok",
        "issues": []
      }
    }
  ],
  "summary": {
    "steps": 8,
    "invalidSteps": 0,
    "needsConfirmation": 0,
    "proposedFields": 0,
    "questions": 1,
    "customizations": 3
  }
};
/** App 353 相当のプロセス管理（反映前。申請する は無条件・承認待ちの作業者は user.approver） */
const STATUS_353 = {
  "enable": true,
  "states": {
    "作成中": {
      "name": "作成中",
      "index": "0",
      "assignee": {
        "type": "ONE",
        "entities": []
      }
    },
    "承認待ち": {
      "name": "承認待ち",
      "index": "1",
      "assignee": {
        "type": "ONE",
        "entities": [
          {
            "entity": {
              "type": "USER",
              "code": "user.approver"
            },
            "includeSubs": false
          }
        ]
      }
    },
    "承認済み": {
      "name": "承認済み",
      "index": "2",
      "assignee": {
        "type": "ONE",
        "entities": []
      }
    }
  },
  "actions": [
    {
      "name": "申請する",
      "from": "作成中",
      "to": "承認待ち",
      "filterCond": "",
      "type": "PRIMARY"
    },
    {
      "name": "承認する",
      "from": "承認待ち",
      "to": "承認済み",
      "filterCond": "",
      "type": "PRIMARY"
    },
    {
      "name": "差し戻す",
      "from": "承認待ち",
      "to": "作成中",
      "filterCond": "",
      "type": "PRIMARY"
    }
  ]
};
module.exports = { PLAN_FIXED, STATUS_353 };
