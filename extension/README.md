# kintone App Toolkit — Chrome 拡張機能版（試作）

ユーザースクリプト版（`kintoneAppToolkit.user.js`）と同じソースから、Chrome / Edge の拡張機能（Manifest V3）を作ります。ユーザースクリプトは変えず、違いはすべてビルドで作ります。

## 作り方

```bash
node extension/build.cjs
```

できるもの（`dist/` はリポジトリの管理外）:

- `dist/extension/` … 展開したまま読み込める形
- `dist/kintone-app-toolkit-<版>-chrome-extension.zip` … ストアへ提出する ZIP
- `dist/extension-build.json` … 版・ファイル数・SHA-256 などの記録

初回は npm レジストリから mermaid と Monaco Editor の配布物（tarball）を取得し、`extension/.vendor-cache/` に置きます（管理外）。取得したものは `vendor.lock.json` の integrity・sha256 と照合し、合わなければ止まります。

`node extension/build.cjs --check` は、書き出さずに本体の変換と検査だけを行います。

## 試しに読み込む

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
| 更新 | `@updateURL`（GitHub） | ストア |
| 求める権限 | — | なし（content script だけ。`host_permissions` も無し） |

ビルドが本体に加える変更は、次の 2 つだけです。

1. **Monaco の置き場所:** `MONACO_BASE` の行を、同梱物の場所へ差し替えます。拡張機能の場所は `src/bootstrap.js` が `<html data-nr-toolkit-ext-base>` で渡します（本体はページの世界で動くため `chrome.runtime` を使えないため）。
2. **非文字の書き換え:** 正規表現・文字列の中の Unicode の非文字（U+FFFF など）を `\uFFFF` の書き方へ置き換えます。Chrome は非文字を含む content script を「UTF-8 でない」として読み込みません。同梱の mermaid にも同じ書き換えをします。

ビルドは次のときに止まります（本体が変わったら build.cjs を見直す合図です）。

- ヘッダー（`@grant` / `@require` / `@match`）が想定と違う。
- `MONACO_BASE` の行が 1 つでない。
- `<script>` を作る箇所が Monaco のローダー以外にある。
- CDN を読み込んでいるかもしれない行がある。

ストアの審査では、外部から読み込んだコードの実行が禁止されています。

## 確かめたこと（2026-11-12、2.3.3）

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

**まだ確かめていないこと:**
- 本物の kintone での動作（kintone の CSP、各タブ、AI への接続）。
- Chrome 本体での動作（Edge で確認）。
- モバイル版。

## ストアに出す前に必要なこと

- **アイコン:** 今のアイコンは Nest Rec のロゴを縮小した仮のものです。差し替えるなら `extension/icons/` を置き換えます。
- **ストアの掲載情報:** 説明・スクリーンショット・プライバシーポリシーが必要です。AI に接続すると、アプリの設定を Nest Rec AI へ送るため、データの扱いの申告が要ります。
- **外部への通信（コードではない）:**
  - パネルの見出しのアイコン画像を `www.google.com/s2/favicons` から読み込んでいます。
  - AI に接続したときは `appinsight-ai-api…workers.dev` と通信します。
  - どちらもコードの読み込みではありませんが、申告の対象です。
- **開発者登録:** Chrome ウェブストアの開発者登録（初回のみ登録料）が必要です。
