# 開発方針：タスク・ナレッジ管理アプリ（Webフロントエンド版）

**Why:** 再起動時にも一貫した設計・実装を維持するための厳格ルール集。
**How to apply:** 新機能追加・バグ修正・リファクタリング時は必ずこのルールを参照すること。

---

## 1. ファイル構成・命名規則

| ファイル | 役割 |
|---|---|
| `index.html` | エントリポイント。DOM構造のみ。直接JSロジックは書かない |
| `css/style.css` | UIデザイン・レイアウト定義 |
| `js/app.js` | メイン制御（管制塔）。イベント監視・DOM操作に専念 |
| `js/modules/*.js` | 機能ロジック。1機能1ファイル |

### 現在の modules 構成
`github.js`（リモート通信）／`storage.js`（LocalStorageキャッシュ）／`dataModel.js`（列定義・Markdownパース／文字列化）／`task.js`（タスクロジック・フィルタ）／`calendar.js`（カレンダー表示ロジック）／`project.js`（プロジェクト管理：名前変更・統合・削除。旧`hub.js`）／`master.js`（マスタ整合性チェック）／`recurring.js`（繰り返しタスク）／`excel.js`（Excelエクスポート・インポート）／`workCalendar.js`／`merge.js`（mainDataの3-wayマージ。ID列をキーに base/local/remote を比較し自動解決。保存フロー内 `app.js` の `mergeMainData` 呼び出しから使用）

### modules の関数構成（必須4段落）
1. インポート（外部モジュール・ライブラリ）
2. インプット（引数でデータ・トークンを受け取る）
3. メイン機能（計算・データ加工・API通信）
4. アウトプット（`return` で結果を返す）

**禁止:** modules内でのDOM操作（`document.getElementById` 等）、OWNERやREPO名などの定数のハードコード（必ずインプットとして受け取る）。

---

## 2. データ操作・通信ルール（最優先）

### データファイル
- リモートのデータ本体は GitHub リポジトリ `palmelo2nd/brain_data` 内 `brain/data.md`（旧 `todo.md`）。Front Matter（`---` で囲んだJSON）に `mainData` / `masterData` を保持する。
- アプリ本体のコードは別リポジトリ（`code/brain` 配下、GitHub Pages 想定。リモート: `palmelo2nd/brain`）で管理する。**データとコードは別リポジトリ**であり、変更時はそれぞれ個別にコミット・pushする必要がある点に注意。
- ローカルパス: コード = `app/code/brain`、データ = `app/data/brain`（`data.md`）。

### オフライン完全対応
- データ読み書きは `github.js`（リモート）と `storage.js`（LocalStorageキャッシュ）を必ず経由する。
- **読み込み:** GitHub API → 成功時はテキスト＋SHA をLocalStorageキャッシュ。失敗時はキャッシュから復元。
- **書き込み:** 保存ボタン押下 → 即座にLocalStorage更新 → GitHubへPUT送信。圏外失敗時もデータはローカルに保持＋ユーザー通知。
- **注意:** LocalStorageキャッシュが残っていると、GitHub側を更新してもアプリ表示が古いままになることがある。データ不整合の調査時はまず「キャッシュ更新／Load」操作を確認する。

### データパース・整合性
- Markdownデータ属性の操作はオブジェクトのキー名ベースで行う。行番号・インデックス依存のアクセスは禁止。
- 列名（変数名）を変更する場合、以下の3箇所すべてを揃える必要がある（1箇所でも漏れると `master.js` の整合性チェックで警告が出る）:
  1. `dataModel.js` の `MAIN_DATA_COLUMNS` / `MASTER_DATA_COLUMNS`
  2. `data.md` 内の実データの **キー名**（各行のプロパティ名）
  3. `data.md` の `masterData` 内、`(M)変数名` 列の**値**として登録されている変数名一覧（キー名とは別に、値として変数名文字列が保持されている）

---

## 3. 実装の心得

- グローバル状態（現在のSHA、パース済みタスク配列等）は `js/app.js` または専用状態管理オブジェクトで保持する。
- DOM内テキストをデータソースとして直接扱うことは禁止。データ構造を常に正とする。
- 外部ライブラリ（marked.js、SheetJS/XLSX等）は `index.html` でCDN経由ロード、JS側では `window.marked` / `window.XLSX` 等グローバルオブジェクト経由で使用。modules内での個別インポート禁止。
- データは「マスタ系（`masterData`：カテゴリ・タグ・プロジェクト・ステータス等の親子関係定義）」と「メイン系（`mainData`：日々のタスク・ナレッジ・INBOX等）」に分離して管理する（`dataModel.js` の `MAIN_DATA_COLUMNS` / `MASTER_DATA_COLUMNS` として実装済み）。
- 仕様の不明点は勝手に進めずユーザーに確認する。

---

## 4. カテゴリフィルタ・状態管理のルール

- フィルタ状態の取得・適用は `task.js` / `calendar.js` に集約する（タグ・プロジェクト・ステータスの複数選択フィルタとして実装済み）。
- 絞り込み表示時は元データ（マスター配列）を破壊せず、フィルタ済み複製配列（シャローコピー）を描画用に渡す。

```js
// js/app.js の新機能追加パターン（例）
import { filterTasks } from './modules/task.js';
const filtered = filterTasks(allTasks, selectedCategory);
updateView(filtered); // 画面描画
```

---

## 用語変更履歴

- 2026-07-13: 上位概念を表す変数名を「ハブ」→「プロジェクト」に変更。対象: `dataModel.js`の列名、`hub.js`→`project.js`（ファイル名・関数名）、`data.md`内のキー名および`(M)変数名`の値、UI表示ラベル全般。データファイル名も`todo.md`→`data.md`に変更。
