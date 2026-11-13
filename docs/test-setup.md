# 無料テストの準備

Toolkitの正規作業フォルダーは UserScript/kintoneAppToolkit です。src/、tools/、tests/、extension/を同じリポジトリで管理します。

一部の結合テストは、別リポジトリのAI契約・料金定義を読み込みます。AIリポジトリをコピーしたり、隣にあることを前提にせず、ローカル設定で場所を指定してください。

~~~powershell
git config --local toolkit.aiRepo "<AIリポジトリの絶対パス>"
node tools/test-release-workspace.cjs
node extension/build.cjs --check
node extension/build.cjs
node extension/compare-tests.cjs
~~~

一時的に切り替える場合は環境変数 KT_AI_REPO が優先されます。どちらも未設定の場合だけ旧配置の ../AI を使います。見つからない場合は明示的なエラーになります。これらはローカルの模擬テストで、実AI・kintoneへの接続確認ではありません。

今回の集約では既存AI作業ツリーの場所をGitローカル設定に記録しました。AI側の配置・コード・認証情報は変更していません。クローンし直した環境では、使用するAIリポジトリを設定してください。
