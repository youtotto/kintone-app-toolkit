# kintone App Toolkit  
**ヘルスチェック＋フィールド一覧（Markdown出力対応） for kintone Developers**
---

## 🧩 概要
このスクリプトは、kintone アプリの構造情報を **ワンクリックで可視化・出力** できる Tampermonkey 用ツールです。

- ✅ **Health** タブ：フィールド数・プロセス状態・カスタマイズ構成を分析し、しきい値（YELLOW/RED）で判定  
- ✅ **Fields** タブ：フォーム定義を一覧化し、**Markdown（備考列つき）** や **CSV** / **JSON** で出力  
- ✅ **レイアウトAPI対応**：実際の配置順・グループ・サブテーブルを正しく表示  
- ✅ **ルックアップ検知**：`SINGLE_LINE_TEXT` + `lookup` フィールドを `LOOKUP` として出力  
- ✅ **GET専用**：アプリ定義の読み取りのみを行い、データ変更は一切行いません  
---
### Health
<img width="595" height="452" alt="image" src="https://github.com/user-attachments/assets/7d13714f-78ef-4451-90b8-087b8ee78e08" />

### Fields
<img width="1370" height="697" alt="image" src="https://github.com/user-attachments/assets/26a28f5b-83ae-4045-bf30-b6c7f0d10770" />

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

1. kintone の任意のアプリ（一覧・詳細・編集）を開く  
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

---

## 🛡️ 安全性
- kintone REST API の **GET系** のみ使用  
- 閲覧権限に基づいて情報を取得（権限外フィールドは出ません）  
- ローカルにのみ保存する設定項目（LocalStorage使用）

---

## 🧰 開発者向け情報
| API | 用途 |
|------|------|
| `/k/v1/app/form/fields` | フィールド定義（必須・初期値・型など） |
| `/k/v1/app/form/layout` | レイアウト順序・グループ／サブテ所属 |
| `/k/v1/app/status` | プロセス状態・アクション数 |
| `/k/v1/app/customize` | JS/CSSファイル一覧 |
| `/k/v1/app/views` / `/k/v1/app/notifications` | 一覧ビュー・通知定義取得 |

---

## 📄 更新履歴
| Version | Date | 内容 |
|----------|------|------|
| 1.0.0 | 2025-10-08 | 初版公開（Health + Fields統合版） |
| 1.1.0 | 2025-10-09 | フィールド名とコードが不一致の行をハイライトする機能を追加 |

---

## ⚙️ ライセンス
MIT License  
Copyright (c) 2025 [youtotto](https://github.com/youtotto)

---

## ❤️ 作者コメント
kintoneの「アプリ構造レビュー」をもっと手軽に。  
このツールがあなたの設計・レビュー・保守の時間を少しでも短縮できたら嬉しいです。
