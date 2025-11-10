# kintone App Toolkit

**kintone開発の標準化・効率化 for Developers**

---

## 目次
- [概要](#-概要)
- [主要タブの機能](#-主要タブの機能)
  - [Health](#health)
  - [Fields](#fields)
  - [Views](#views)
  - [Graphs](#graphs)
  - [Relations](#relationsタブ)
  - [Templates](#templates新機能)
  - [Customize](#-customize-タブの特徴)
  - [Field Scanner](#field-scannernew)
  - [Links](#links)
- [導入方法](#-導入方法)
- [使い方](#-使い方)
- [安全性](#-安全性)
- [開発者向け情報（API一覧）](#-開発者向け情報)
- [更新履歴](#-更新履歴)
- [ライセンス / 作者](#-ライセンス)

---

## 🧩 概要

Toolkitは、kintone開発を標準化・効率化するための **Tampermonkey（ブラウザ拡張）ベース**のユーザースクリプトです。  
**v1.8.0** で「Field Scanner」を追加し、コードとアプリ定義の**構造可視化 → 一括エクスポート → 安全なデプロイ**までを一気通貫で支援します。

- ✅ **Health**: メトリクス診断（YELLOW/RED しきい値）
- ✅ **Fields**: フォーム定義を Markdown / CSV / JSON 出力
- ✅ **Views**: 一覧ビュー定義を Markdown / CSV 出力
- ✅ **Graphs**: グラフ定義を Markdown / CSV 出力
- ✅ **Relations**: ルックアップ / 関連レコード / アクションの参照関係を一覧化
- ✅ **Templates**: GitHub テンプレート / スニペット / ドキュメント + Monaco エディタ
- ✅ **Customize**: JSEdit互換の編集体験を統合（プレビュー保存＆デプロイ対応）
- ✅ **Field Scanner**: JS/CSS 内の **フィールド使用箇所** を自動解析（MD/CSV/JSON）
- ✅ **Links**: 公式・コミュニティ・ライブラリのリンク集（favicon取得の安定化済み）

---

## 🔑 主要タブの機能

### Health
- Fields / States / Actions / Views / JS・CSS / Notifs を集約表示
- しきい値（YELLOW/RED）編集に対応（LocalStorage保存）
<img width="595" height="452" alt="image" src="https://github.com/user-attachments/assets/7d13714f-78ef-4451-90b8-087b8ee78e08" />

---

### Fields
- レイアウト順・グループ/サブテーブル所属を正しく反映
- ルックアップは `LOOKUP` として出力
- Export: **Copy MD / Download MD / Copy CSV / Download JSON**
<img width="1370" height="697" alt="image" src="https://github.com/user-attachments/assets/26a28f5b-83ae-4045-bf30-b6c7f0d10770" />

---

### Views
- 種類・フィルタ・ソートを可読化（コード→ラベル(code)）
- Export: **Copy MD / Download MD / Copy CSV / Download CSV**
<img width="916" height="251" alt="image" src="https://github.com/user-attachments/assets/9895fb8f-5d9e-437a-9378-7a78631a9562" />

---

### Graphs
- 種類（BAR/COLUMN/PIE…）、表示モード（NORMAL/STACKED/PERCENTAGE）
- 分類項目 / 集計方法 / 条件式を可読化
- Export: **Copy MD / Download MD / Copy CSV / Download CSV**
<img width="1606" height="771" alt="image" src="https://github.com/user-attachments/assets/48490fc3-d3b8-4057-b98a-0e2683988ecf" />


---

### Relationsタブ
kintoneアプリの参照関係（ルックアップ・関連レコード・アクション）を一覧化。  
構造理解と影響範囲の把握を支援します。
| セクション | 内容 |
|---|---|
| **Lookups** | 参照元アプリ、コピー項目、条件式を一覧化（コピー先/元を明示） |
| **Related Records** | 参照アプリ、表示フィールド、連携条件を一覧化（`filterCond` 可読化） |
| **Actions** | 実行条件・作成先アプリ・マッピングを一覧化（開閉式UI） |
<img width="1620" height="798" alt="スクリーンショット 2025-11-06 181601" src="https://github.com/user-attachments/assets/f9224f18-0f9f-43cd-94ab-b87df12fdabc" />

---

### Templates（新機能）
ブラウザだけで完結する kintone カスタマイズ体験。  
- **GitHub連携**：`youtotto/kintoneCustomizeJS` から Templates / Snippets / Documents を取得
- **エディタ**：Monaco + Markdown / 補完 / 自動レイアウト
- **サジェスト**：アプリのフィールドコード・ラベル補完
- **AIプロンプト生成**：Documents の Markdown から要件定義プロンプト生成
- **Upload & Deploy**：プレビュー保存→デプロイのワンボタン
<img width="1616" height="968" alt="スクリーンショット 2025-11-06 181610" src="https://github.com/user-attachments/assets/f8ee8d66-12db-4454-8205-6ca47ea9c46b" />

---

### ✨ Customize タブの特徴
- **JSEdit互換** + Toolkit UIに統合
- Snippets 連携（GitHub `snippets/` / プレビュー→エディタ挿入）
- **保存＋デプロイ**のワンボタン化（preview更新 / deploy完了検知）
<img width="1623" height="973" alt="スクリーンショット 2025-11-07 165409" src="https://github.com/user-attachments/assets/8eeef58a-22ef-4fee-b7cb-7e5c3f05319f" />


---

### Field Scanner（New!）
カスタマイズ JS/CSS 内で **フィールドコードがどこで使われているか** を可視化します。

**操作**
1. `Target`（desktop / mobile）と `Kinds`（JS / CSS）を選択  
2. **Scan** をクリック  
3. 結果表から **MD Copy / MD DL / CSV DL / JSON DL** で出力  
<img width="2296" height="1304" alt="スクリーンショット 2025-11-10 122931" src="https://github.com/user-attachments/assets/40a47207-98bf-461e-8d02-9dc068a5fb24" />


---

### Links
- 公式 / コミュニティ / ライブラリへのリンク集
<img width="1620" height="1032" alt="スクリーンショット 2025-11-08 164709" src="https://github.com/user-attachments/assets/2ecbeb43-c314-47b7-91cd-c747f7b88c3b" />


---

## 🚀 導入方法

### 1) 前提
- Chrome / Edge / Firefox
- 拡張機能 **Tampermonkey**

### 2) インストール
1. [このスクリプトの RAW ページ](https://raw.githubusercontent.com/youtotto/kintone-app-toolkit/main/kintoneAppToolkit.user.js) を開く  
2. Tampermonkey が自動認識 → **インストール**

---

## 🧭 使い方

1. kintone の任意のアプリ一覧を開く  
2. 右下のパネルからタブを切り替えて利用  
3. 各タブの **Copy / Download** ボタンでエクスポート可能

> **Health** のしきい値は「基準」から編集（LocalStorage保存）。  
> **Templates / Customize** は Monaco エディタで編集 → 保存（場合によりデプロイ）。

---

## 🛡️ 安全性
- 原則 **GET系** APIで情報取得（編集系はユーザー操作時のみ）
- 権限に基づくアクセス（権限外の情報は取得されません）
- ローカル保存（LocalStorage／SessionStorage）を使用

---

## 🧰 開発者向け情報
| API | 用途 |
|---|---|
| `kintone.app.getFormFields` | フィールド定義（必須・初期値・型） |
| `kintone.app.getFormLayout` | レイアウト順・グループ/サブテーブル |
| `/k/v1/app/status` | プロセス状態・アクション |
| `/k/v1/app/customize` | JS/CSS ファイル一覧 |
| `/k/v1/app/views` | 一覧ビュー定義 |
| `/k/v1/app/reports` | グラフ設定 |
| `/k/v1/app/notifications/general` | 通知定義 |
| `/k/v1/app/actions` | レコード作成アクション（Relations） |
| `/k/v1/file.json` | **一時アップロード** |
| `/k/v1/preview/app/customize.json` | **プレビュー更新** |
| `/k/v1/preview/app/deploy.json` | **デプロイ** |

---

## 📄 更新履歴

| Version | Date | 内容 |
|---|---|---|
| 1.0.0 | 2025-10-08 | 初版公開（Health + Fields） |
| 1.1.0 | 2025-10-09 | フィールド名とコード不一致行のハイライト |
| 1.2.0 | 2025-10-11 | Viewsタブ追加（一覧ビュー出力） |
| 1.3.0 | 2025-10-11 | Graphsタブ追加（グラフ出力） |
| 1.3.1 | 2025-10-14 | Fieldsレイアウト順の不具合修正 |
| 1.3.2 | 2025-10-20 | Fieldsユーザー/組織選択の初期値表示修正 |
| 1.3.3 | 2025-10-21 | ライトモード配色調整 |
| 1.4.0 | 2025-11-03 | **Templates** 追加（GitHub連携・Monaco・サジェスト） |
| 1.4.2 | 2025-11-04 | Templates に **Snippets / Documents** を追加 |
| 1.4.3 | 2025-11-05 | ドメイン共通の最小化機能を追加 |
| 1.5.0 | 2025-11-05 | **Relations** 追加（Lookup/Related/Actions） |
| 1.5.1 | 2025-11-05 | Documents に **AIプロンプト生成** |
| 1.6.0 | 2025-11-06 | **Upload & Deploy** 追加（preview→deploy） |
| 1.6.2 | 2025-11-06 | AIボタンを「ファイルDL」に変更 |
| 1.7.0 | 2025-11-07 | **Customize** 追加（JSEdit互換×GitHub×Monaco） |
| 1.7.3 | 2025-11-08 | JS API化・Graph描画修正・CustomizeにモバイルJS/CSS対応 |
| 1.7.5 | 2025-11-08 | Linksタブ追加（公式/コミュニティ/Library） |
| **1.8.0** | **2025-11-10** | **Field Scanner** 追加  |

---

## ⚙️ ライセンス
MIT License  
Copyright (c) 2025 [youtotto](https://github.com/youtotto)

---

## ❤️ 作者コメント
kintoneカスタマイズの「体験」をもっと自由に。  
テンプレートから始めて、自分の手で触れる開発環境を。  
このToolkitが、あなたの最初の1行になりますように。
