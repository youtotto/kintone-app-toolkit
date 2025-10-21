# kintone App Toolkit  

**ヘルスチェック＋フィールド一覧＋ビュー一覧＋グラフ一覧 for kintone Developers**
---

## 🧩 概要

このスクリプトは、kintone アプリの構造情報を **ワンクリックで可視化・出力** できる Tampermonkey 用ツールです。

- ✅ **Health** タブ：フィールド数・プロセス状態・カスタマイズ構成を分析し、しきい値（YELLOW/RED）で判定  
- ✅ **Fields** タブ：フォーム定義を一覧化し、**Markdown** や **CSV** / **JSON** で出力  
- ✅ **Views** タブ：アプリの一覧ビュー定義を一括表示し、**Markdown** / **CSV** でコピー・ダウンロード
- ✅ **Graph** タブ：グラフの定義を一括表示し、**Markdown** / **CSV** でコピー・ダウンロード

---

### Health

<img width="595" height="452" alt="image" src="https://github.com/user-attachments/assets/7d13714f-78ef-4451-90b8-087b8ee78e08" />

### Fields

<img width="1370" height="697" alt="image" src="https://github.com/user-attachments/assets/26a28f5b-83ae-4045-bf30-b6c7f0d10770" />

### Views

<img width="916" height="251" alt="image" src="https://github.com/user-attachments/assets/9895fb8f-5d9e-437a-9378-7a78631a9562" />

### Graphs

<img width="1606" height="771" alt="image" src="https://github.com/user-attachments/assets/48490fc3-d3b8-4057-b98a-0e2683988ecf" />

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

## 🛡️ 安全性

- kintone REST API の **GET系** のみ使用  
- 閲覧権限に基づいて情報を取得（権限外フィールドは出ません）  
- ローカルにのみ保存する設定項目（LocalStorage使用）

---

## 🧰 開発者向け情報

| API                       | 用途                                      |
| ------------------------- | --------------------------------------- |
| `/k/v1/app/form/fields`   | フィールド定義（必須・初期値・型など）|
| `/k/v1/app/form/layout`   | レイアウト順序・グループ／サブテーブル所属                   |
| `/k/v1/app/status`        | プロセス状態・アクション数                           |
| `/k/v1/app/customize`     | JS/CSSファイル一覧                            |
| `/k/v1/app/views`         | 一覧ビュー定義の取得（Views タブ）                |
| `/k/v1/app/notifications/general` | 通知定義の取得                                 |
| `/k/v1/app/reports` | グラフ設定の取得                                 |

---

## 📄 更新履歴

| Version   | Date       | 内容                                                                      |
| --------- | ---------- | ----------------------------------------------------------------------- |
| 1.0.0     | 2025-10-08 | 初版公開（Health タブ + Fields タブ）                                               |
| 1.1.0     | 2025-10-09 | フィールド名とコードが不一致の行をハイライト                                                  |
| 1.2.0 | 2025-10-11 | **Views タブ**を追加：一覧ビューの**一覧化**／**Markdown/CSV 出力** |
| 1.3.0 | 2025-10-11 | **Graphs タブ**を追加：グラフの**一覧化**／**Markdown/CSV 出力** |
| 1.3.1 | 2025-10-14 | **Fields** フィールドがレイアウト順に並んでいなかった問題を修正 |
| 1.3.2 | 2025-10-20 | **Fields** ユーザー選択、組織選択の初期値が正しく表示されていなかった問題を修正 |
| 1.3.3 | 2025-10-21 | 端末がライトモードの時の配色を調整 |

---

## ⚙️ ライセンス

MIT License  
Copyright (c) 2025 [youtotto](https://github.com/youtotto)

---

## ❤️ 作者コメント

kintoneの「アプリ構造レビュー」をもっと手軽に。  
このツールがあなたの設計・レビュー・保守の時間を少しでも短縮できたら嬉しいです。
