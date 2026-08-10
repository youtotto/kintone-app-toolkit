# kintone App Toolkit

**kintone開発の標準化・効率化 for Developers**

> 🚀 Latest: Toolkit v2.2.0 released
> 設定を「見る」ツールから、**依存関係と変更影響を「分析する」ツール**へ。

---

## 目次
- [概要](#-概要)
- [依存関係分析でできること](#-依存関係分析でできること)
- [主要タブの機能](#-主要タブの機能)
  - [Health](#health)
  - [Fields](#fields)
  - [Views](#views)
  - [Graphs](#graphs)
  - [Relations](#relations)
  - [Deps](#deps)
  - [Notices](#notices)
  - [Access Control](#access-control)
  - [Templates](#templates)
  - [Customize](#customize)
  - [Plugins](#plugins)
  - [Field Scanner](#field-scanner)
- [導入方法](#-導入方法)
- [使い方](#-使い方)
- [解析範囲と確度](#-解析範囲と確度)
- [安全性](#%EF%B8%8F-安全性)
- [開発者向け情報（API一覧）](#-開発者向け情報)
- [更新履歴](#-更新履歴)
- [ライセンス / 作者](#%EF%B8%8F-ライセンス)

---

## 🧩 概要

Toolkitは、kintone開発を標準化・効率化するための **Tampermonkey（ブラウザ拡張）ベース**のユーザースクリプトです。

**v2.1 系**では、フィールド・設定・JavaScript・他アプリの関係を共通の依存関係データとして整理し、
「このフィールドを変えると何に影響するか」に答えられるようにしました。

- ✅ **Health**: メトリクス診断 + 設定の整合性チェック + プロセスフロー図 + 滞留ヒート
- ✅ **Fields**: 利用箇所・変更影響・計算式の参照ツリー + 形式での絞り込み
- ✅ **Views / Graphs / Notices / Access Control**: 設定の可読化とエクスポート
- ✅ **Relations**: アプリ間依存の一覧化 + **他アプリからの被参照の走査**
- ✅ **Deps**: 依存関係グラフ + 横断検索 + 依存関係レポート出力
- ✅ **Templates / Customize**: GitHub連携 + Monaco + Upload & Deploy
- ✅ **Plugins**: プレビュー / 本番差分管理
- ✅ **Field Scanner**: JS/CSS解析（ファイル起点ビュー / 自動解析）

---

## ✨ 依存関係分析でできること

| 機能 | 答えられるようになる問い |
|---|---|
| **変更影響の表示**（Fields） | このフィールドを変更・削除すると何に影響するか |
| **設定の整合性チェック**（Health） | 存在しないフィールドコード・ステータス名への参照が残っていないか |
| **他アプリからの参照**（Relations） | どのアプリがこのアプリを参照しているか |
| **依存関係グラフ**（Deps） | アプリ内の依存が全体としてどうなっているか |
| **横断検索**（Deps） | このJSファイル / この設定が触っているものは何か |
| **計算式の参照ツリー**（Fields） | この計算式はどこまで遡って依存しているか |

詳細は [リリースノート](./RELEASE_NOTES_v2.2.0.md) を参照してください。

---

## 🔑 主要タブの機能

### Health
- Fields / States / Actions / JS / ACL を集約表示（判定バッジをカードに統合）
- しきい値（YELLOW/RED）編集対応（LocalStorage保存）
- 🆕 **設定の整合性チェック** — 存在しない **フィールドコード / ステータス名** への参照を検出
  - フィールドコード: 表記ゆれ（大文字小文字・全角半角・記号違い）の場合は「近い既存コード」を提示
  - ステータス名: 設定の条件式と JavaScript の両方を検証
- 🆕 計算式の最大段数を表示
- プロセスフロー図をMermaidで描画
- 📊 直近500件のステータス滞留ヒート表示

<img width="956" height="443" alt="image" src="https://github.com/user-attachments/assets/898123f0-8374-4da2-a9ec-71fb15d1654c" />

---

### Fields
- レイアウト順・グループ/サブテーブル所属を正しく反映
- ルックアップは `LOOKUP` として出力、要素ID（LABEL / HR など）表示対応
- 🔍 フィールド検索（名称 / コード部分一致）+ 🆕 **フィールド形式での絞り込み**（件数付き）
- 🆕 **使用箇所** — どの種類の設定で使われているかをバッジ表示
  `[一覧] [通知] [計算式] [JavaScript] [ルックアップ]`
- 🆕 **変更影響** — 操作の種類ごとに確認すべき箇所を表示

<img width="951" height="452" alt="image" src="https://github.com/user-attachments/assets/480b2667-7d8c-4065-910b-e845fe72c0ff" />

```
■ フィールドコードを変更する場合
   ・JavaScript（custom.js）の修正が必要です。アプリ設定と違い、JavaScriptはコード変更に追随しません。
■ フィールド型を変更する場合
■ 選択肢を変更する場合            ← 選択肢を持つフィールドのみ
■ フィールドを削除する場合
   ・直接 7 件／間接 3 件／他アプリ 2 件から参照されています。
```

<img width="937" height="270" alt="image" src="https://github.com/user-attachments/assets/9b244e33-aaaf-4a24-82b0-fb8a8e685063" />

- 🆕 **計算式の参照ツリー** — 多段の計算式の連なりを表示

```
総額
 └─ 報酬額
    ├─ 係数
    └─ 小計
       ├─ 人数
       └─ 単価
```

<img width="395" height="131" alt="image" src="https://github.com/user-attachments/assets/c8d409fd-42cd-418e-94b7-c4b96dd74908" />

- 🆕 利用数列（未使用フィールドの棚卸し）と Deps タブへの導線
- Export: 形式セレクト（**Markdown / CSV / JSON / 依存関係JSON**）+ Copy / DL

---

### Views
- 種類・フィルタ・ソートを可読化（コード→ラベル(code)）
- Export: **Copy MD / DL MD / DL CSV / DL JSON**

<img width="636" height="215" alt="image" src="https://github.com/user-attachments/assets/dc6b898c-0a09-4035-9a3a-320885b1bc6a" />

---

### Graphs
- 種類（BAR/COLUMN/PIE…）、表示モード（NORMAL/STACKED/PERCENTAGE）
- 分類項目 / 集計方法 / 条件式を可読化
- Export: **Copy MD / DL MD / DL CSV / DL JSON**

<img width="635" height="235" alt="image" src="https://github.com/user-attachments/assets/83dae65e-f719-45a3-9f72-11c4f241435d" />

---

### Relations
アプリ間の依存関係を、方向を区別して一覧化します。

**このアプリ → 他アプリ**（設定APIから取得。常時表示）

| 接続種別 | 自アプリ側 | 接続先アプリ | 接続先フィールド | 備考 | 確度 |
|---|---|---|---|---|---|
| ルックアップ | 顧客コード | app 100 顧客管理 🔗 | 顧客コード | 5項目を取得 | 設定／確実 |
| 関連レコード | 過去案件 | app 200 案件管理 🔗 | — | 顧客CDで突合 | 設定／確実 |
| JavaScript | custom.js | app 300 売上管理 🔗 | 不明 | JS内にアプリID記述（120行目） | 推定／要確認 |

<img width="632" height="215" alt="image" src="https://github.com/user-attachments/assets/8fa76887-cbbb-40bb-a1f1-7d965360b879" />

🆕 **他アプリ → このアプリ**（走査が必要）

この向きの依存はアプリ設定APIでは直接取得できないため、同一ドメインのアプリを1件ずつ確認します。

- **実行はボタン操作のみ**（アプリ数に比例してAPI呼び出しが発生するため、自動実行しません）
- 同時実行数を制限し、進捗を表示。結果は24時間キャッシュ
- 閲覧権限のないアプリは「確認できず」として件数を表示

<img width="627" height="194" alt="image" src="https://github.com/user-attachments/assets/8f2a0dc8-3627-4dcd-83da-d4a2841454a7" />

詳細（コピー項目・条件式・マッピング）は「詳細：Lookups / Related Records / Actions」に格納されています。

---

### Deps（New in v2.1）
アプリ内外の依存関係を、グラフと検索で把握します。

**依存関係グラフ**
- 起点フィールドを選ぶと、その周辺の依存を図示
- 種別ごとの色分け・枠囲み、確度による線種の区別（**実線＝確実 / 破線＝推定**）
- 絞り込み: 範囲（直接 / 直接＋間接）・ノード上限・表示対象（計算式 / 一覧・グラフ / 通知 / プロセス管理 / JavaScript / アクセス権 / アプリ間連携）
- 図中の他アプリノードをクリックすると別タブで開く
- 大量ノードで破綻しないよう、初期表示では描画せず上限超過時は警告

<img width="640" height="391" alt="image" src="https://github.com/user-attachments/assets/0a36b0f6-acae-453f-b4f2-508f8756b943" />

**横断検索**
フィールド名・設定名・JSファイル名・アプリ名・関係種別を対象に検索できます（空白区切りでAND）。

```
検索 [ customerControl.js ]  2 件
  [JavaScript] customerControl.js  → 読取   顧客コード 12行目   可能性が高い
  [JavaScript] customerControl.js  → 書込   単価 34行目        可能性が高い
```

**依存関係レポート出力**
Mermaid（表示中の図）/ Markdown / CSV / JSON（いずれもアプリ全体）を出力できます。
Markdownは仕様書として貼り付けやすい形式で、利用箇所・他アプリ連携・変更時の確認事項・
利用箇所が検出されなかったフィールドまで含みます。

---

### Notices
- 一般通知 / レコード通知 / リマインダー通知を一覧表示

<img width="639" height="383" alt="image" src="https://github.com/user-attachments/assets/16729dcd-1426-4a93-9a04-7a52728a10d1" />

---

### Access Control
- アプリ権限 / レコード権限 / フィールド権限を可視化

<img width="638" height="381" alt="image" src="https://github.com/user-attachments/assets/97ebcfd8-47e3-4255-aec9-180c992b68d8" />

---

### Templates
ブラウザだけで完結する kintone カスタマイズ体験。
- **GitHub連携**：`youtotto/kintoneCustomizeJS` から Templates / Snippets / CSS / Documents を取得
- **エディタ**：Monaco + Markdown / 補完 / 自動レイアウト
- **サジェスト**：アプリのフィールドコード・ラベル補完
- **AIプロンプト生成**：Documents の Markdown から要件定義プロンプト生成
- **Upload & Deploy**：プレビュー保存→デプロイのワンボタン

<img width="638" height="380" alt="image" src="https://github.com/user-attachments/assets/a1b8c367-f696-45d0-b349-a00a157cec7c" />

---

### Customize
- **JSEdit互換** + Toolkit UIに統合
- Snippets 連携（GitHub `snippets/` / プレビュー→エディタ挿入）
- **保存＋デプロイ**のワンボタン化（preview更新 / deploy完了検知）
- desktop / mobile、JS / CSS に対応

<img width="638" height="380" alt="image" src="https://github.com/user-attachments/assets/fec0ef11-af0c-4cb2-9723-ac6ddbf5b757" />

---

### Plugins
アプリにインストールされている **プラグイン構成を可視化・管理**します。
**システム管理者専用**の安全設計です。

- 本番（prod）/ プレビュー（preview）のプラグイン一覧表示と差分表示
- preview へのプラグイン追加 → **Deploy ワークフロー**（完了待ち）
- システム管理者のみ利用可能。明示操作時のみ変更系APIを実行

> ※ preview に追加後、deploy を実行することで本番へ反映されます。

<img width="638" height="380" alt="image" src="https://github.com/user-attachments/assets/05b2536a-03d5-441d-ad6a-1cd7a48cfcd8" />

---

### Field Scanner
カスタマイズ JS/CSS の解析エンジンです。結果は依存関係データへ自動的に合流します。

🆕 **ファイル起点ビュー**（既定）— ファイルごとに「いつ動き・何を触り・どのアプリを見るか」を表示

```
custom.js  [desktop] [JS]
  イベント        [app.record.create.show] [app.record.edit.submit]
  参照フィールド   顧客コード  READ×2, WRITE×1   10行目, 12行目, 20行目
  参照アプリ      app 300 売上管理 🔗   120行目
```

- 🆕 **イベント種別**の抽出（変数経由の登録も推定として検出し `?` を付与）
- 🆕 **アクセス種別**の判定 — 読取 / 書込 / 制御 / 表示切替 / 要素取得 / 関数へ渡す / 配列に列挙 / クエリ
- 🆕 **行番号**の付与、JS内の**アプリID参照**の検出
- 🆕 **ステータス名の検証** — 存在しないステータスとの比較を検出
  （`event.nextStatus.value` / 変数追跡 / `switch`・`case` に対応）
- 🆕 **自動解析** — 起動後にバックグラウンドで実行（結果は6時間キャッシュ、オフ切替可）
- フィールド起点ビュー（従来の表）にも切り替え可能
- Export: **Copy MD / DL MD / DL CSV / DL JSON**

<img width="637" height="238" alt="image" src="https://github.com/user-attachments/assets/ce584e0f-6ed9-4889-8475-353ac47827b9" />

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
3. 各タブの **Copy / DL** ボタンでエクスポート可能

**表示**
- ヘッダの `⛶` で **全画面表示**に切り替え（選択は保存されます）
- `–` で最小化

**依存関係を調べるとき**
1. 起動数秒後、JavaScriptの自動解析が完了します（Fieldsタブの表示が「JS解析済み」になります）
2. **Fields** タブでフィールドの「開く」→ 使用箇所・変更影響・参照ツリーを確認
3. **Deps** タブで図と横断検索、**Relations** タブでアプリ間の依存を確認
4. 他アプリからの被参照が必要な場合は、Relations の「走査する」を実行

> **Health** のしきい値は「基準 / Thresholds」から編集（LocalStorage保存）。
> **Templates / Customize** は Monaco エディタで編集 → 保存（場合によりデプロイ）。

---

## 🔍 解析範囲と確度

推定を確定情報として表示しないため、次の区分を併記しています。

| 確度 | 意味 |
|---|---|
| **確実** | 設定値として記録された情報から取得 |
| **可能性が高い** | 条件式・計算式・JavaScript の解析による推定 |
| **要確認** | 用途を特定できない参照 |

**現時点で取得できないもの**（画面上でも明示しています）

| 項目 | 理由 |
|---|---|
| プラグイン設定の内容 | REST API が正式提供されていないため（プラグイン導入時は注意喚起を表示） |
| 外部URLのJavaScriptの本文 | 同一オリジン外のため取得不可 |
| 実行時にしか決まらない値 | 変数で指定されたフィールドコード・アプリIDなど |

---

## 🛡️ 安全性
- 原則 **GET系** APIで情報取得（編集系はユーザー操作時のみ）
- 権限に基づくアクセス（権限外の情報は取得されません。取得できなかった件数は明示します）
- 他アプリの走査は **明示的なボタン操作のみ**（自動実行しません）
- ローカル保存（LocalStorage／SessionStorage）を使用
- 読み取り専用の分析と、設定変更を伴う機能（Templates / Customize / Plugins）を明確に分離

---

## 🧰 開発者向け情報

| API | 用途 |
|---|---|
| `kintone.app.getFormFields` | フィールド定義（必須・初期値・型） |
| `kintone.app.getFormLayout` | レイアウト順・グループ/サブテーブル・要素ID |
| `/k/v1/app/settings` | アプリ名・説明 |
| `/k/v1/app/status` | プロセス状態・アクション |
| `/k/v1/app/customize` | JS/CSS ファイル一覧 |
| `/k/v1/app/views` | 一覧ビュー定義 |
| `/k/v1/app/reports` | グラフ設定 |
| `/k/v1/app/notifications/general` `/perRecord` `/reminder` | 通知定義 |
| `/k/v1/app/acl` `/k/v1/record/acl` `/k/v1/field/acl` | アクセス権 |
| `/k/v1/app/actions` | レコード作成アクション（Relations） |
| `/k/v1/app/plugins` `/k/v1/plugins` | プラグイン構成 |
| `/k/v1/apps.json` | アプリ一覧・アプリ名の解決（被参照の走査） |
| `/k/v1/app/form/fields.json` | 他アプリのフィールド定義（被参照の走査） |
| `/k/v1/records` | ステータス滞留ヒート（直近500件） |
| `/k/v1/file.json` | **一時アップロード / ファイル取得** |
| `/k/v1/preview/app/customize.json` | **プレビュー更新** |
| `/k/v1/preview/app/deploy.json` | **デプロイ** |

**内部構成**

| モジュール | 役割 |
|---|---|
| `KTApi` | kintone REST 共通クライアント（preview / production を明示） |
| `KTDeps` | 依存関係解析（Raw → Normalized → Dependency → Presentation） |
| `KTScan` | JavaScript 自動解析とキャッシュ管理 |
| `KTIncoming` | 他アプリからの被参照の走査 |
| `KTExport` | Markdown / CSV / JSON の生成とダウンロード |

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
| **1.8.0** | **2025-11-10** | **Field Scanner** 追加 |
| 1.8.1 | 2025-11-20 | UI改善（高さ統一・新バージョン表記） / Customize 新規ファイル追加 / Templates GitHub 説明リンク追加 |
| 1.8.3 | 2025-11-29 | 機能: ヘルスタブのUIを改善し、CSVエクスポートにBOMを追加 |
| 1.8.4 | 2026-01-17 | 機能: プロセスフロー図のMermaid codeのコピー機能を追加 |
| 1.9.0 | 2026-01-20 | **Plugins タブ追加**（管理者限定 / preview→deploy / 差分表示） |
| **2.0.0** | 2026-02-25 | **大型アップデート**<br>・Fields検索（名称 / コード）<br>・Fields / Views 詳細設定表示<br>・Noticesタブ追加<br>・Access Controlタブ追加<br>・CSSテンプレート機能追加<br>・Health: 滞留ヒート + Mermaidノード強調連動<br>・Thresholds UI表示修正<br>・テーマ最適化 / リファクタリング |
| **2.1.0** | 2026-08-09 | **依存関係分析へ**<br>・**Deps タブ追加**（依存関係グラフ / 横断検索 / レポート出力）<br>・Fields: 変更影響・利用箇所・計算式の参照ツリー・形式フィルタ<br>・Health: 設定の整合性チェック（存在しないコードへの参照検出）<br>・Relations: 他アプリからの被参照の走査<br>・Field Scanner: ファイル起点ビュー / イベント種別 / アクセス種別 / 自動解析<br>・全画面表示切替<br>・Links タブ削除<br>・不具合修正9件（モバイルJSのアップロード先誤り等） |
| **2.2.0** | 2026-08-09 | **ステータス名の整合性チェックを追加**<br>・設定の条件式に指定された存在しないステータス名を検出<br>・JavaScript の比較・`switch`/`case` を検証（`event.nextStatus.value` / 変数追跡に対応）<br>・Health の整合性チェックと依存関係レポートに統合 |

---

## ⚙️ ライセンス
MIT License
Copyright (c) 2025 [youtotto](https://github.com/youtotto)

---

## ❤️ 作者コメント
kintoneカスタマイズの「体験」をもっと自由に。
テンプレートから始めて、自分の手で触れる開発環境を。
このToolkitが、あなたの最初の1行になりますように。
