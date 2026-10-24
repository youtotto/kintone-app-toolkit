# AI作業面の実装

今回のリリース対象は、AIへの相談から変更内容の確認、動作テスト環境への反映と復元まで。Toolkit全体の調査機能を作り直す変更ではない。

## 編集と生成

次の5ファイルが新しいAI作業面のソースである。

| ファイル | 責任 |
| --- | --- |
| src/release-workspace.js | 明示的な採用、状態遷移、成果物と承認の照合、実行記録 |
| src/release-context.js | 取得した事実、利用者の依頼と回答、採用内容の引き継ぎ |
| src/release-execution.js | 設定・JavaScriptの実行部品の接続、部分失敗と復元 |
| src/release-view.js | 相談・変更内容・結果を主役にする画面 |
| src/release-runtime.js | 既存の接続、利用制限、取得、無料資料機能との接続 |

`node tools/build-release-workspace.cjs` で本体の生成区間へ埋め込む。生成区間を直接編集しない。`--check` はソースと埋め込みの一致だけを確認する。認証、設定取得、設定・JavaScriptの書き込み部品などの既存コードは本体に残る。

Toolkitは自然文から効果・担当・API可否を再推定しない。AIサービスの検証結果を、対象ID・本文の指紋・明示された登録先と照合する。書き込み前の最新設定、権限、対象ファイル、承認後の変化、読み戻し、復元対象の確認は実行部品の責任である。

原価やトークンは通常表示に出さない。内部の利用制限と終了不明の記録は保持する。仮案の採用と、kintoneへの反映承認は別操作である。

## 無料の確認

```powershell
node tools/build-release-workspace.cjs
node tools/test-release-workspace.cjs
```

全ファイルの終了コードで集計し、結果を無視対象の `tests/.build/release-check/` に保存する。`--unit` を付けると実ブラウザーの2ファイルを除く。

ブラウザー試験はPlaywrightとEdgeを使用する。ブラウザーは専用の一時プロファイルで起動し、外向きの要求を遮断する。AIの応答とkintoneは固定応答で、実サービスへの接続はしない。Playwrightのパスは試験ファイルの環境変数で指定できる。

AIリポジトリの `sandbox` では `npm run test:release` が、新しい入力と本物のGateway、ローカルの模擬テスト環境をつなぐ。AI応答だけを固定する。`KT_TOOLKIT_DIR` でこのToolkitの作業ディレクトリを指定する（省略時はAIと同じ親のToolkit）。

旧テストの整理は `tests/release-test-migration.json` に記録した。旧画面・旧意味判定を試すものは置き換え、非AI機能と実行時の安全性は維持する。件数の減少を検証の強化とは扱わない。

## リリース前に残ること

この実装は専用worktreeでの確認まで。配布済みToolkitや配備済みGatewayは変えていない。新版クライアントは `releaseWorkspace` と `artifactOutcome` の対応印がない接続先で該当機能を使わない。

実際のAIが新しい受け渡しに従うこと、配備済みサービスとの接続、kintoneの実際の画面での表示・反映・復元は未確認。モックのブラウザー試験を実機確認と呼ばない。会話と実行記録はページ内だけで、再読み込み後の復元機能は追加していない。
