# kintone App Toolkit  

**kintone開発の標準化・効率化 for Developers**
---

## 🧩 概要

Toolkitは、kintone開発を標準化・効率化することを目的としたTampermonkey（ブラウザ拡張）ベースのユーザースクリプトです。

- ✅ **Health** タブ：フィールド数・プロセス状態・カスタマイズ構成を分析し、しきい値（YELLOW/RED）で判定  
- ✅ **Fields** タブ：フォーム定義を一覧化し、**Markdown** や **CSV** / **JSON** で出力  
- ✅ **Views** タブ：アプリの一覧ビュー定義を一括表示し、**Markdown** / **CSV** でコピー・ダウンロード
- ✅ **Graph** タブ：グラフの定義を一括表示し、**Markdown** / **CSV** でコピー・ダウンロード
- ✅ **Templates**：GitHub上のJSテンプレートを一覧表示し、構文チェック・補完付きエディタで編集／ダウンロード
- ✅ **Relations**：kintoneアプリの 参照関係（ルックアップ・関連レコード・アクション） を一覧化。**Markdown** / **CSV** でコピー・ダウンロード
- ✅ **Customize**：**JSEdit互換のUIを統合**。GitHubスニペット連携＋安全なプレビュー＆デプロイをサポート |


---

### Health
<img width="595" height="452" alt="image" src="https://github.com/user-attachments/assets/7d13714f-78ef-4451-90b8-087b8ee78e08" />

### Fields
<img width="1370" height="697" alt="image" src="https://github.com/user-attachments/assets/26a28f5b-83ae-4045-bf30-b6c7f0d10770" />

### Views
<img width="916" height="251" alt="image" src="https://github.com/user-attachments/assets/9895fb8f-5d9e-437a-9378-7a78631a9562" />

### Graphs
<img width="1606" height="771" alt="image" src="https://github.com/user-attachments/assets/48490fc3-d3b8-4057-b98a-0e2683988ecf" />

### Relationsタブ（News!）
kintoneアプリの 参照関係（ルックアップ・関連レコード・アクション） を一覧化。
アプリ間のつながりを「見える化」し、構造理解・影響範囲の把握を支援します。
<img width="1620" height="798" alt="スクリーンショット 2025-11-06 181601" src="https://github.com/user-attachments/assets/f9224f18-0f9f-43cd-94ab-b87df12fdabc" />

### Templates（New!）
ブラウザだけで完結する kintone カスタマイズ体験。
<img width="1616" height="968" alt="スクリーンショット 2025-11-06 181610" src="https://github.com/user-attachments/assets/f8ee8d66-12db-4454-8205-6ca47ea9c46b" />


### ✨ Customize タブの特徴（New）

#### 🔹 JSEdit互換 + Toolkit統合
- kintoneのカスタマイズJSを**直接編集・プレビュー保存・デプロイ**可能  
- JSEditを否定せず、Toolkitの構造的アプローチに統合  
- ファイル一覧／プレビュー／エディタ構成を**Templatesタブと統一デザイン**

#### 🔹 Snippets 連携
- GitHub上の `snippets/` ディレクトリを自動取得  
- クリックで先頭20行をプレビュー、ボタン1つでエディタへ挿入  
- 複数Snippetを組み合わせてコードを構築可能  
- Snippetsを使うたびに `$meta` に履歴として追記表示（文脈保持）

#### 🔹 デプロイの統合
- 保存（PUT）とデプロイ（POST）を**ワンボタン化**  
- kintoneの `preview/app/customize.json` と `deploy.json` を自動監視して完了検知

#### 🧩 今後の展開（予定）

- AIによるコードレビュー・改善提案の統合
- Customizeタブから直接GitHubコミット（認証連携）  
- Mobile JS / CSS への拡張対応  
- Snippetsのカテゴリー分類・検索機能の追加  


---

## 🚀 導入方法

### 1. 前提

- Chrome / Edge / Firefox などのブラウザ  
- 拡張機能 **Tampermonkey** がインストールされていること  

### 2. インストール

1. [このスクリプトの RAW ページ](https://raw.githubusercontent.com/youtotto/kintone-app-toolkit/main/kintoneAppToolkit.user.js) を開く  
2. Tampermonkey が自動で認識するので「**インストール**」をクリック  

---

## 🧭 使い方

1. kintone の任意のアプリ一覧を開く  
2. 右下に黒いパネルが表示されます  
3. タブをクリックして機能を切り替えます

### 🔹 Healthタブ

| 項目 | 内容 |
|------|------|
| Fields | フィールド総数・グループ数・サブテーブル構成を表示 |
| States/Actions | プロセス管理の状態・アクション数 |
| Views/Notifs | ビュー・通知の件数 |
| JS/CSS | カスタマイズファイル数 |
| 判定 | YELLOW/RED基準に応じて判定（しきい値は編集可） |

- 「基準」ボタン：注意/警告ラインを編集可能（LocalStorageに保存）  
- 「コピー」ボタン：診断結果をテキストとしてコピー  

---

### 🔹 Fieldsタブ

| 項目 | 内容 |
|------|------|
| フィールド名 | 実際のラベル |
| フィールドコード | API用コード |
| 必須 | ✓表示（min-width固定） |
| 初期値 | defaultValue（型ごとに整形） |
| フィールド形式 | type（ルックアップは `LOOKUP` として出力） |
| グループ | `Group: … / Subtable: …` の実配置パス |

- **Copy MD（備考付き）**：7列の Markdown 表形式をコピー（Notion 貼付け向け）  
- **Download MD**：`.md` ファイルを保存  
- **Copy CSV / Download JSON**：CSV or JSON形式でエクスポート  

- ✅ **レイアウトAPI対応**：実際の配置順・グループ・サブテーブルを正しく表示  
- ✅ **ルックアップ検知**：`SINGLE_LINE_TEXT` + `lookup` フィールドを `LOOKUP` として出力  
- ✅ **GET専用**：アプリ定義の読み取りのみを行い、データ変更は一切行いません  

---

### 🔹 Viewsタブ

| 項目    | 内容                                              |
| ----- | ----------------------------------------------- |
| ビューID | 一覧ビューのID（固定幅・省略表示なし）                            |
| ビュー名  | ビュー名（長い場合は省略表示・titleで全体確認）                      |
| 種類    | `LIST` / `CALENDAR` / `CUSTOM` など               |
| フィルター | `filterCond` を解析し、**フィールドコード→ラベル（コード）**に置換して可読化 |
| ソート   | `sort` を解析し、**フィールドコード→ラベル（コード）**に置換して可読化       |

- **Copy MD**：Markdown 表形式をコピー（Notion 貼付け向け）  
- **Download MD**：`.md` ファイルを保存  
- **Copy CSV / Download CSV**：CSV 形式でエクスポート  

---

### 🔹 Graphsタブ

| 項目    | 内容                                              |
| ----- | ----------------------------------------------- |
| グラフID | グラフのID（固定幅・省略表示なし）                            |
| グラフ名  | グラフ名（長い場合は省略表示・titleで全体確認）                      |
| タイプ    | グラフの種類 `BAR：横棒グラフ` / `COLUNM：縦棒グラフ` / `PIE：円グラフ` など               |
| 表示モード    | グラフの表示モード `NORMAL` / `STACKED：積み上げ` / `PERCENTAGE：100%積み上げ`  など               |
| 分類項目    | グラフで分類する項目のフィールドコード |
| 集計方法 | 集計対象のフィールドコード |
| 条件 | `filterCond` を解析し、**フィールドコード→ラベル**に置換して可読化 |

- **Copy MD**：Markdown 表形式をコピー（Notion 貼付け向け）  
- **Download MD**：`.md` ファイルを保存  
- **Copy CSV / Download CSV**：CSV 形式でエクスポート  

---

### 🔹 Relationsタブ（新機能）

kintoneアプリの 参照関係（ルックアップ・関連レコード・アクション） を一覧化。
アプリ間のつながりを「見える化」し、構造理解・影響範囲の把握を支援します。

| セクション                       | 内容                                             |
| --------------------------- | ---------------------------------------------- |
| **Lookups（ルックアップ）**         | 参照元アプリ、コピー項目、条件式を一覧化。コピー先／コピー元の関係を明示。          |
| **Related Records（関連レコード）** | 参照アプリ、表示フィールド、連携条件を一覧表示。条件式(`filterCond`)も可読化。 |
| **Actions（レコード作成アクション）**    | 実行条件や作成先アプリ、マッピング設定を一覧化。開閉式UI（▸／▾）付きで見やすく整理。   |

---

### 🔹 Templatesタブ（新機能）

- テンプレートは 「CONFIGを書き換えるだけで使える構成」 なので、初心者でも安心。
- kintone開発を“ブラウザ内で完結”できる新しい体験です。


|機能カテゴリ|内容|
|-------------------|--------------------------------------------------------------------------------------------|
|**GitHub連携**|`youtotto/kintoneCustomizeJS`リポジトリから自動取得（`js/`＝テンプレート、`snippets/`＝スニペット、`document/`＝ドキュメント）|
|**Templates**|一般的なカスタマイズテンプレート。クリックでエディタに読み込み、編集／ダウンロード／挿入が可能|
|**Snippets**|コード断片（関数・設定例など）。プレビュー＋挿入専用で、既存コードに追記可能|
|**Documents（New!）**|`.md`／`.txt`などのガイド・ドキュメントを自動取得。MonacoEditor上でMarkdownモード編集に対応|
|**AIプロンプト生成**| `.md`／`.txt`などのガイド・ドキュメントから、AIプロンプト生成 |
|**コードエディタ**|MonacoEditor組込み。構文チェック／Markdown構文ハイライト／自動レイアウト調整対応|
|**サジェスト機能**|kintoneアプリのフィールドコード・ラベルを自動補完（RESTAPI`/k/v1/app/form/fields`使用）|
|**ファイルバッジ表示**|`JS`／`SNIP`／`DOC`の種別を自動判別してアイコン化|
|**編集・DL・挿入**|どのカテゴリも直接編集・ダウンロード可（Document含む）。Snippetsは挿入専用を維持|
|**エンコード対応**|日本語・スペースを含むファイル名でも正常取得（encodeURIComponent対応）|
|**UI改善**|高さをflex同期化し、右パネルはstickyヘッダ＋スクロールリスト構成|
|**キャッシュ機構**|GitHubAPI結果を`sessionStorage`に保持し、再読込時の通信を削減|

#### ▶  **AIプロンプト生成について**：
- Templates > **Documents** でMarkdownテンプレートを開くと **「AIプロンプト」** ボタンが表示されます。
- 現在のアプリ設定定義を元に、**ChatGPTへ貼るだけ**の要件定義プロンプトをダウンロードします。
- ChatGPTなどに添付し、「お願いします！」と一言で利用できます。

#### ▶ **Upload & Deploy**（プレビューに追記してデプロイ）
- 操作：Templatesタブ → ↑ アップロード
- ダイアログでファイル名と**アップ先（デスクトップ／モバイル）**を選択
- エディタの内容を /k/v1/file.json にアップロード
- /k/v1/preview/app/customize.json をマージ更新
- /k/v1/preview/app/deploy.json をPOST → 完了待ち


### Customize タブ機能一覧
|区分|機能名|概要・特徴|
|-----------------|------------------------|-------------------------------------------------------------------|
|🎨**エディタ**|MonacoベースのJSエディタ|構文ハイライト・自動インデント対応。JSEditと同等の直感的な編集体験を提供。|
|🗂️**ファイル一覧**|Customize/Snippetsの切替|kintoneのカスタマイズファイルと、GitHub上のSnippetsを切替表示可能。|
|🧱**Snippets連携**|GitHub連携・クリックプレビュー|GitHubの`snippets/`ディレクトリを取得。クリックで先頭20行をプレビュー表示。|
|➕**挿入機能**|Snippetコードをエディタへ挿入|プレビュー中のSnippetをカーソル位置または末尾へ自動挿入。|
|💾**保存＋デプロイ**|ワンボタン操作|Preview保存（PUT）とDeploy（POST）を統合。ボタン1つでプレビュー反映と本番反映を完了。|
|🔄**リスト更新**|ファイルリストの再取得|Customize/Previewの構成をAPIから再取得し、最新状態を一覧に反映。|
|🚀**デプロイ監視**|成功検知／404回避|`preview/app/deploy.json`をポーリング監視。404エラーを回避し安定動作。|

>Toolkit Customizeタブは、JSEditの利便性 × Toolkitの構造化思想 を融合した進化系エディタです。
Snippetsでアイデアを取り込み、ボタン1つで安全にデプロイ。
編集・可視化・保存・デプロイを同一画面で完結させます。

---

## 🛡️ 安全性

- kintone REST API の **GET系** のみ使用  
- 閲覧権限に基づいて情報を取得（権限外フィールドは出ません）  
- ローカルにのみ保存する設定項目（LocalStorage使用）

---

## 🧰 開発者向け情報

| API                       | 用途                                      |
| ------------------------- | --------------------------------------- |
| `kintone.app.getFormFields`   | フィールド定義（必須・初期値・型など）|
| `kintone.app.getFormLayout`   | レイアウト順序・グループ／サブテーブル所属                   |
| `/k/v1/app/status`        | プロセス状態・アクション数                           |
| `/k/v1/app/customize`     | JS/CSSファイル一覧                            |
| `/k/v1/app/views`         | 一覧ビュー定義の取得（Views タブ）                |
| `/k/v1/app/notifications/general` | 通知定義の取得                                 |
| `/k/v1/app/reports` | グラフ設定の取得                                 |
| `/k/v1/app/actions` | レコード作成アクションの取得（Relationタブで使用） |
| `/k/v1/file.json`                  | **ファイルの一時アップロード** |
| `/k/v1/preview/app/customize.json` | **プレビュー側のカスタマイズ更新** |
| `/k/v1/preview/app/deploy.json`    | **プレビュー→本番へのデプロイ** |


---

## 📄 更新履歴

| Version   | Date           | 内容                                               |
| --------- | -------------- | ------------------------------------------------ |
| 1.0.0     | 2025-10-08     | 初版公開（Health + Fields）                            |
| 1.1.0     | 2025-10-09     | フィールド名とコード不一致行のハイライト追加                           |
| 1.2.0     | 2025-10-11     | Viewsタブ追加（一覧ビュー出力）                               |
| 1.3.0     | 2025-10-11     | Graphsタブ追加（グラフ出力）                                |
| 1.3.1     | 2025-10-14     | Fieldsレイアウト順の不具合を修正                              |
| 1.3.2     | 2025-10-20     | Fieldsユーザー/組織選択の初期値表示を修正                         |
| 1.3.3     | 2025-10-21     | ライトモード配色調整                                       |
| 1.4.0     | 2025-11-03     | **Templatesタブ追加（GitHub連携・Monacoエディタ・サジェスト機能対応）** |
| 1.4.2     | 2025-11-04     | Templatesの種類にスニペット（ユーティリティ関数）とドキュメント（MD形式）を追加|
| 1.4.3     | 2025-11-05     | ドメイン共通の最小化機能を追加 |**
| **1.5.0** | 2025-11-05     | **Relationsタブ追加（ルックアップ・関連レコード・アクション一覧） |
| 1.5.1 | 2025-11-05     | Templates > **Documents** に **AIプロンプト生成** を追加 |
| **1.6.0** | 2025-11-06     | **Templates: Upload & Deploy を追加**（ファイル名指定・デスクトップ/モバイル選択、previewマージ、デプロイ完了待ち|
| 1.6.2     | 2025-11-06     | AIボタンの仕様を変更。ボタン押下でファイルとしてダウンロード |
| **1.7.0** | 2025-11-07     | **Customizeタブ追加（JSEditの利便性 × GitHub連携・Monacoエディタ・サジェスト機能対応）** |
| 1.7.3     | 2025-11-08     | feat: JS API化・Graph描画バグ修正・Customizeでデスクトップ/モバイルのJS/CSS対応 |

---

## ⚙️ ライセンス

MIT License  
Copyright (c) 2025 [youtotto](https://github.com/youtotto)

---

## ❤️ 作者コメント

kintoneカスタマイズの「体験」をもっと自由に。
テンプレートから始めて、自分の手で触れる開発環境を。
このToolkitが、あなたの最初の1行になることを願っています。
