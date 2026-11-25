# kintone App Toolkit — Chrome・Edge 拡張機能版

ユーザースクリプト版（`kintoneAppToolkit.user.js`）と同じソースから、Chrome / Edge の拡張機能（Manifest V3）を作ります。ユーザースクリプトは変えず、違いはすべてビルドで作ります。

**公開版：2.3.15**（2026年11月25日）。[変更内容と検証範囲](../docs/RELEASE-NOTES-2.3.15.md)

GitHubで[拡張機能ZIP](https://github.com/youtotto/kintone-app-toolkit/releases/download/v2.3.15/kintone-app-toolkit-2.3.15-chrome-extension.zip)を配布しています。Chromeウェブストアでの公開は別途審査対象で、このZIP配布はストア公開済みを意味しません。

## ZIPから導入する

**拡張機能版を使う場合は、Tampermonkey版を同時に有効にしないでください。** 導入済みなら、Tampermonkeyの一覧で「kintone App Toolkit」スクリプトだけをOFFにします。他のスクリプトやTampermonkey全体を無効にする必要はありません。

1. 拡張機能ZIPをダウンロードし、使い続ける場所へ展開します。
2. Chromeは `chrome://extensions`、Edgeは `edge://extensions` を開きます。
3. 「デベロッパー モード」をオンにします。
4. 「パッケージ化されていない拡張機能を読み込む」で、展開したフォルダー（`manifest.json` がある場所）を選びます。
5. kintoneアプリの一覧画面を再読み込みし、「Ver 2.3.15」とToolkitのパネルが1つだけであることを確認します。

Tampermonkey版と同時に有効にするとToolkitが2つ動きます。どちらか一方だけを有効にしてください。

導入後は、[無料機能の試し方・AI接続・最初の相談](../docs/getting-started.md#2-アプリの一覧画面で無料機能を試す)へ進んでください。

## ZIP版を更新する

1. 必要な会話・編集中コードを保存してから、新しい版のZIPを取得します。
2. 現在読み込んでいるフォルダーの中身を新版で置き換え、拡張機能管理画面でToolkitの再読み込みを押します。別フォルダーからもう1つ追加する操作は不要です。
3. 拡張機能版が有効で、Tampermonkeyの「kintone App Toolkit」スクリプトがOFFのままであることを確認します。Tampermonkey版を更新した場合も、この有効状態を確認してください。
4. kintoneアプリを再読み込みし、**「Ver 2.3.15」とToolkitのパネルが1つだけであること**を確認します。開いている他のkintoneタブも再読み込みしてください。

ZIPから手動導入した版は、GitHubの公開だけでは自動更新されません。Tampermonkey版へ切り替える場合は、この拡張機能をOFFにしてからToolkitスクリプトを有効にします。

## 作り方

```bash
node extension/build.cjs
```

できるもの（`dist/` はリポジトリの管理外）:

- `dist/extension/` … 展開したまま読み込める形
- `dist/kintone-app-toolkit-<版>-chrome-extension.zip` … GitHubで配布するZIP。ストア提出にも使用する形式
- `dist/extension-build.json` … 版・ファイル数・SHA-256 などの記録

初回は npm レジストリから mermaid と Monaco Editor の配布物（tarball）を取得し、`extension/.vendor-cache/` に置きます（管理外）。取得したものは `vendor.lock.json` の integrity・sha256 と照合し、合わなければ止まります。

`node extension/build.cjs --check` は、書き出さずに本体の変換と検査だけを行います。

## 手元でビルドしたものを読み込む

1. Chrome（または Edge）で `chrome://extensions`（Edge は `edge://extensions`）を開く。
2. 「デベロッパー モード」をオンにする。
3. 「パッケージ化されていない拡張機能を読み込む」で `dist/extension` フォルダーを選ぶ。
4. kintone のアプリの一覧画面を開く。

Tampermonkey 版と同時に有効にすると、Toolkit が 2 つ動きます。試すときは、どちらか一方を止めてください。

## ユーザースクリプト版との違い

| 項目 | ユーザースクリプト版 | 拡張機能版 |
| --- | --- | --- |
| 動く場所 | `@grant none`（ページの中） | content script の `world: "MAIN"`（ページの中。同じく `kintone` を直接使う） |
| 動く画面 | `@match` / `@exclude` | 同じパターンを `matches` / `exclude_matches` に使う |
| mermaid | `@require` で jsdelivr から（`mermaid@10`） | 10.9.8 を同梱 |
| Monaco Editor | cdnjs から 0.36.1 | 0.36.1 を同梱（`web_accessible_resources`） |
| 更新 | `@updateURL`（GitHub） | ZIP手動導入版は新版を取得して更新。ストア配布は別途審査対象 |
| アクセス範囲 | ヘッダーの対象サイト | kintoneの対象ページでcontent scriptが動作。`permissions` / `host_permissions`の追加指定はありませんが、対象サイトの内容へアクセスします |

ビルドが本体に加える変更は、次の 2 つだけです。

1. **Monaco の置き場所:** `MONACO_BASE` の行を、同梱物の場所へ差し替えます。拡張機能の場所は `src/bootstrap.js` が `<html data-nr-toolkit-ext-base>` で渡します（本体はページの世界で動くため `chrome.runtime` を使えないため）。
2. **非文字の書き換え:** 正規表現・文字列の中の Unicode の非文字（U+FFFF など）を `\uFFFF` の書き方へ置き換えます。Chrome は非文字を含む content script を「UTF-8 でない」として読み込みません。同梱の mermaid にも同じ書き換えをします。

ビルドは次のときに止まります（本体が変わったら build.cjs を見直す合図です）。

- ヘッダー（`@grant` / `@require` / `@match`）が想定と違う。
- `MONACO_BASE` の行が 1 つでない。
- `<script>` を作る箇所が Monaco のローダー以外にある。
- CDN を読み込んでいるかもしれない行がある。

ストアの審査では、外部から読み込んだコードの実行が禁止されています。

## 検証範囲

同じテストをユーザースクリプトと拡張機能の本体に対して実行し、結果の一致と両方の失敗数を確認します。多くのテストは部品を直接読むため、この比較だけで拡張機能の実機動作すべてを確認したことにはなりません。[無料テストの準備](../docs/test-setup.md)・[版の更新と照合](../docs/versioning.md)

今回の変更と検証範囲は[2.3.15のリリースノート](../docs/RELEASE-NOTES-2.3.15.md#検証範囲)をご覧ください。実AI・決済・モバイル動作など変更のない経路は、過去の検証と今回の確認を区別して記載しています。

<details>
<summary>試作時点の検証記録（2026-11-12、2.3.3）</summary>

以下は当時の記録です。現在の公開版のテスト結果とは区別してください。

- **既存のテスト:** `node extension/compare-tests.cjs` で、全 128 ファイルをユーザースクリプトと拡張機能版の本体の両方で実行しました。
  - ファイルごとの合否・件数・失敗した項目は、すべて同じでした（どちらも 1,916 件合格）。
  - 両方で同じ 3 件が失敗しました（`release-complex-failures` 2 件・`release-smalltalk` 1 件）。拡張機能版とは関係なく、作業中の本体側で起きている失敗です。
  - 多くのテストは `src/` の部品を直接読むので、本体の差し替え（`KT_SRC`）が効くのは、本体を読み込むテストだけです。
- **ブラウザでの確認:** Edge 157 を画面なしで起動し、拡張機能を読み込みました。kintone 風の模擬ページ（`https://test.cybozu.com/…` を手元のサーバーへ向けたもの）で、次を確かめました。

| 確かめたこと | 結果 |
| --- | --- |
| 一覧画面（`/k/1/`、`/k/1/?view=5`）で Toolkit のパネルが表示される | 表示された |
| mermaid で図を描ける | 描けた |
| Monaco Editor を同梱物（`chrome-extension://…/vendor/monaco/vs/loader.min.js`）から読み込み、エディターを作れる | 作れた |
| 管理画面（`/k/admin/…`）とレコード詳細（`/k/1/show`）では動かない | 動かなかった |
| ページのエラー | 出なかった |

**当時の未確認範囲:**
- 本物の kintone での動作（kintone の CSP、各タブ、AI への接続）。
- Chrome 本体での動作（Edge で確認）。
- モバイル版。

</details>

## AI接続とデータの取扱い

無料の設定確認にAI契約は不要です。AIへ接続すると、相談に必要なアプリ設定・取得したJavaScript本文・入力文などをNest Rec AIへ送ります。パネルの見出しには外部のアイコン画像を使用します。[料金・接続案内とデータの取扱い](https://www.nestrec.com/toolkit)をご確認ください。
