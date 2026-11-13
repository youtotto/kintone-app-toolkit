# 版の更新と照合

`kintoneAppToolkit.user.js` は手書きの共通本体と、`src/release-*.js` から埋め込む領域を持ちます。`BEGIN RELEASE WORKSPACE` から `END RELEASE WORKSPACE` までは直接編集せず、元の `src/` を直してビルドします。

1. 手書きヘッダーの `@version` と `SCRIPT_VERSION` を同じリリース版へ更新します。
2. `docs/RELEASE-NOTES-<版>.md` を用意し、先頭を `# kintone App Toolkit <版>` にします。
3. `node tools/build-release-workspace.cjs` を実行します。実機照合用の `KT_BUILD` はヘッダーの版から自動更新されます。手で別の版を指定しません。
4. `node tools/build-release-workspace.cjs --check` と `node tools/test-release-workspace.cjs` を実行します。`tests/release-version.test.js` が版の一致、不一致の拒否、自動更新、再ビルドの再現性を確認します。
5. 拡張機能版は `node extension/build.cjs --check`、`node extension/build.cjs`、`node extension/compare-tests.cjs` の順で確認します。比較結果が全件同じでも両方失敗している場合があるため、両方の失敗数が0であることも確認します。

実機更新後は表示の版と `#kt-toolkit` の `data-kt-build` を照合します。無料テストの成功と実機確認は別に記録します。ビルド・テスト自体は公開操作を行いません。
