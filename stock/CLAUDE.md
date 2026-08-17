# 開発方針：Stock 投資管理アプリ

**Why:** 再起動後も方針がぶれないよう、全ルールをここに集約する。新機能追加・バグ修正のたびに必ずこのファイルを参照すること。
**How to apply:** 新機能追加・バグ修正・リファクタリング時は必ずこのルールに照らし合わせる。

「何ができるか」（ページ単位の機能一覧）は [`README.md`](./README.md) を参照。README.mdはまとまった機能を実装・変更したら都度更新する（[4. ドキュメント保守方針](#4-ドキュメント保守方針)）。

---

## 1. ファイル構成・命名規則

| ファイル | 役割 |
|---|---|
| `index.html` | エントリポイント。DOM構造のみ。JSロジックは書かない |
| `css/style.css` | UIデザイン・レイアウト定義 |
| `js/app.js` | 管制塔。イベント監視・DOM操作・各ページの制御に専念 |
| `js/modules/*.js` | 機能ロジック。1機能1ファイル |
| `scripts/*.py` | GitHub Actions上で実行するデータ取得・加工・検証スクリプト |
| `notebooks/*.ipynb` | ローカル（Jupyter）専用で実行するデータ取得・分析。GitHub Actions側でブロックされる／対話的な試行錯誤が要る機能はこちら |
| `.github/workflows/*.yml` | （`app/brain/code/.github/workflows/`。リポジトリ直下）ワークフロー定義 |

### 現在の modules 構成

`storage.js`（トークンのLocalStorageキャッシュ）／`github.js`（GitHub API通信）／`csv.js`（CSVパース・書き出し）／`brokerCsv.js`（証券会社ネイティブCSVのパース）／`holdingsSummary.js`（保有銘柄の階層集計）。

### modules の関数構成（必須4段落）

1. インポート（外部モジュール。Web標準APIのみの場合は「なし」と明記）
2. インプット（引数でデータ・トークンを受け取る）
3. メイン機能（計算・データ加工・API通信）
4. アウトプット（`return` で返す）

**禁止事項（modules内）:**
- `document.getElementById` 等のDOM操作は絶対禁止
- OWNER名・REPO名・パス等の環境依存定数をハードコードしない（引数として受け取る。定数自体は`js/app.js`側で管理する）

### scripts/*.py の規約

- 1スクリプト1責務（例: 株価取得／銘柄マスタ生成／鮮度チェック／品質チェック／既存データの修復）。
- `argparse`で実行時引数を受け取る。出力先パス等の環境依存値もデフォルト値込みで引数化し、ハードコードしない。
- ファイル冒頭のdocstringに、スクリプトの概要・入力・出力・将来の拡張について記載する（既存スクリプトのスタイルに合わせる）。
- アプリのフロントエンドから状態を表示する用途がある場合は`--report`引数でJSON出力できるようにする（例: `freshness_report.json`、`validation_report.json`）。

### notebooks/*.ipynb の規約

- **使いどころ**：GitHub Actionsから実行できない（サイト側がクラウドIPをブロックする等）機能や、`past/`の旧Jupyter実装を新データ構成に合わせて作り直す機能。それ以外（GitHub Actionsで動く定型処理）は`scripts/*.py`に置く。
- 1機能1notebook。命名は`past/`の旧ファイル名を踏襲する（例：`past/C01_...`を作り直す場合は`notebooks/C01_...`）。
- 出力データの保存先は必ずデータリポジトリ（`../../../data/stock/`、ローカルパス`app/brain/data/stock/`）。[データファイルの分離方針](#データファイルの分離方針作り直せるデータと積み上げるデータを混ぜない)に従い、`master.csv`とは別ファイルに保存する。
- 実行後の`app/brain/data`側の変更（コミット・push）はユーザーが手動で行う（本アプリはユーザー自身がgit同期を管理する運用のため、notebook側からの自動push処理は実装しない）。
- 中断・再実行に対応する（対話実行中にKernelを止める可能性があるため）：既に取得済み（`status=ok`等）の行はスキップし、一定件数ごとに逐次保存する。

### .github/workflows/*.yml の規約

- `workflow_dispatch`で手動起動し、実行時パラメータは`inputs`で受け取る（コード側からは`dispatchWorkflow`でPOSTする）。
- 同じファイル（群）へ書き込む系のワークフローは、対象ファイルごとのconcurrencyグループ（例: `stock/prices/`書き込み系＝`stock-prices-write`、`stock/irbank.csv`書き込み系＝`stock-irbank-write`）を共有し、同時書き込みによるgit rebase競合を防ぐ（`cancel-in-progress: false`で先行実行を止めずキュー待ちさせる）。新しく書き込み先ファイルを増やす場合は、既存グループに混ぜず新しいグループ名を割り当てる（無関係な書き込み同士が互いを待つ無駄を避けるため）。
- 大量データを扱うワークフローは一定件数（既存実装は20件）のサブバッチ単位で都度コミット・pushし、途中で失敗しても成功分は失われないようにする。
- コードリポジトリ（`palmelo2nd/brain`）・データリポジトリ（`palmelo2nd/brain_data`）の両方をcheckoutし、変更はデータリポジトリ側にのみコミット・pushする。

---

## 2. データ操作・通信ルール（最優先）

### リポジトリ構成

| 種別 | リポジトリ | ブランチ | ローカルパス |
|---|---|---|---|
| コードリポジトリ | `palmelo2nd/brain` | `main` | `app/brain/code/stock` |
| データリポジトリ | `palmelo2nd/brain_data` | `main` | `app/brain/data/stock` |

### トークン（常時表示バー）

- コードリポジトリ（`brain`）・データリポジトリ（`brain_data`）の両方に対して、**Actions・Contentsをread/writeできる単一のPAT**を使う。ワークフロー起動（`dispatchWorkflow`＝Actions権限）、ファイル読み書き（`fetchFile`／`commitFile`等＝Contents権限）のすべてに共通で使う。
- PW欄右の「保存」ボタンを押した時点でLocalStorageに保存（キー：`stock_token`）。入力するたびに自動保存する方式ではない（2026-08-17変更：ローカルに一度保存すれば十分なため、不要な書き込みをなくした）。旧・ID/PW2欄時代の値（`stock_id_token`／`stock_pw_token`）、さらに旧い単一PAT欄時代の値（`stock_pat_token`）が残っている場合は引き継ぐ。
- **経緯（2026-08-11）**：以前はリポジトリごとにID（`brain`用）／PW（`brain_data`用）の2欄に分け、最小権限の原則を意図していた。しかし[保有銘柄の保存機能](./README.md#31-保有銘柄)（`commitFile`でブラウザから直接データリポジトリへ書き込む初めての機能）を追加した際、PW側PATのContents書き込み権限が不足していることが判明し（`fetchFile`等の読み取りは動いていたため気づかれていなかった）、調査の過程で両リポジトリ・両権限をまとめた単一トークン運用に切り替える方針になった。最小権限の原則より運用の単純さを優先した判断であり、意図的な設計変更である（元に戻す場合は`getTokenValue`を`getCodeTokenValue`/`getDataTokenValue`に再分割し、呼び出し箇所ごとに正しいリポジトリの権限を持つトークンを渡すよう戻すこと）。

### オフライン対応方針（データの重さで扱いを分ける）

brainアプリと異なり、stockは銘柄数×期間で合計データ量が大きくなりうる（個別銘柄の株価CSVが数千ファイル規模）ため、「全データを常にLocalStorageにキャッシュする」方式は採らない。**軽量データ**と**重量データ**を区別して扱うこと。

- **軽量データ**（銘柄マスタ `master.csv`、`freshness_report.json`、`validation_report.json` など、数百KB程度までのファイル）：オフライン完全対応にする。読込時：GitHub API → 成功時はLocalStorageにキャッシュ。失敗時はキャッシュから復元。
- **重量データ**（個別銘柄の株価CSV `stock/prices/{code}.csv`、株価の一括取得・更新など重い処理）：全量をLocalStorageにキャッシュする対象から**除外**する。必要な範囲だけをその都度GitHub API／GitHub Actions経由で取得する（現状の実装通り）。
- 上記のいずれにも該当しない、**APIを毎回叩く必要がない操作**（フォーム入力・フィルタ・表示切り替えなど、既に取得済みのデータやUI状態だけで完結する操作）は、通信なしでスマートフォン上だけで完結できるようにする。

> **今後の対応事項（未実装）**：現状は常時表示バーのトークンのみLocalStorageにキャッシュされており、軽量データ（`master.csv`／`freshness_report.json`／`validation_report.json`）のオフラインキャッシュ・フォールバックはまだ実装されていない。今後、[4. データ更新](./README.md#4-データ更新)まわりを改修する際に、上記の軽量データ側から順にこの方針への対応を進める。

### データパース・整合性

- CSV／JSONのパースはキー名（プロパティ名・列名）ベースで行う。行番号・インデックス依存のアクセスは禁止。

### データファイルの分離方針（「作り直せるデータ」と「積み上げるデータ」を混ぜない）

- **Why（2026-08-11判断）:** `master.csv`はJPX公式データ（`data_j_*.xls`）から`build_stock_master.py`が毎回まるごと再生成する、決定論的に作り直せる派生データ。一方、IRBANKスクレイピングで取得するID/URL（`stock/irbank.csv`）や、将来の人手ラベル（`stock/labels.csv`想定）は、再取得・再入力のコストが高い「積み上げ型」のデータ。両者を同じファイルに同居させると、`master.csv`の再生成ロジックが「全列保持マージ」のような複雑な処理を持たざるを得なくなる（旧Jupyter実装が複雑化した直接の原因）。
- **How to apply:** `master.csv`に列を追加する形で新しいデータを持たせようとしていないか、実装前に必ず確認する。「作り直せるデータ」か「積み上げるデータ」かで判断し、後者は必ず別ファイル（`code`列で結合）にする。書き込み元（GitHub Actions＝スクリプト側／ブラウザ＝UI側）が異なるデータは、可能な限り別ファイルに分ける（同時書き込みの競合を避けるため。[.github/workflows/*.ymlの規約](#githubworkflowsymlの規約)のconcurrencyグループ分けとも対応させる）。

### 上場廃止銘柄は自動判定せず、人が確認して手動登録する（`stock/delisted.csv`）

- **Why（2026-08-17判断）:** yfinanceでの株価取得失敗だけを根拠に上場廃止と自動判定すると、一時的な取得エラーを誤って上場廃止と判定するリスクがある（旧`past/`実装で問題視されていた点）。この誤検知リスクを避けるため、自動判定は行わず、鮮度チェックの「更新最終日」で取得が止まっている銘柄をユーザー自身が確認し、`stock/delisted.csv`（`code, note, updated_at`）へ手動登録する方式にした。登録は「作り直せるデータ」ではなく「積み上げるデータ」なので、[データファイルの分離方針](#データファイルの分離方針作り直せるデータと積み上げるデータを混ぜない)に従い`master.csv`とは別ファイルにしている。
- **How to apply:** `scripts/fetch_prices.py`（`--master`モード）・`scripts/check_freshness.py`はどちらも`--exclude-file`引数でこのファイルを受け取り、対象コードの絞り込み（`fetch_prices.py`）・スキャン対象ファイルの除外（`check_freshness.py`）に使う。ファイルが存在しない（1件も登録されていない）場合は空集合として扱い、エラーにはしない。ブラウザ側（`js/app.js`の`delisted-register-btn`）は`commitFile`で直接この一覧を書き換える（labels.csv等と異なり、仮登録の中間状態を持たない単純な追加・削除）。将来的に`master.csv`の再生成でコードが消えたことを根拠にした自動判定を追加する場合も、この手動登録と共存させる方針（[README.md 添付6](./README.md#添付6-保留事項今後の検討課題)参照）。

### 株価取得は当日（JST）分を常に保存しない（取引時間中の途中価格を確定値として残さない）

- **Why（2026-08-17判断）:** `fetch_prices.py`は取引時間中に実行されると、yfinanceから返る当日分の`Close`が「実行時点の途中価格」であるにもかかわらず、これをそのまま確定値として保存してしまっていた。`mode=update`は「既存CSVの最終日付の翌日〜今日」だけを取得する差分方式のため、一度当日分（途中価格）が保存されると最終日付が当日になり、以降の実行では当日が二度と再取得対象に含まれず、誤った値が残り続けるという不具合があった。
- **How to apply:** `fetch_close_prices`内で、取得結果から当日（`datetime.now(JST).date()`基準）の行を常に除外してから返す。結果として保存されるのは常に前営業日以前の確定値のみで、当日分は翌日以降の実行で「最終日の翌日」として自然に再取得される（1日分の遅延と引き換えに、常に確定値のみを保存する）。修正前に保存されてしまった途中価格の行は自動では直らないため、`scripts/remove_price_dates.py`（`remove-price-dates.yml`、GitHub Actionsタブから手動実行）で該当日付の行を削除してから、翌日以降の`fetch_prices.py`実行で埋め直す。

### IRBANK企業ID取得（`notebooks/C01_IRBANK企業ID取得.ipynb`）はローカル（Jupyter）実行専用

- **Why（2026-08-11判断）:** GitHub Actionsのランナーから`irbank.net`へアクセスすると、robots.txtで`Allow: /`とされている直URL（`https://irbank.net/{code}`）ですら一律403 Forbiddenが返ることを診断ログ付きで確認した（User-Agent変更では回避できず、同じページがローカルからの通常アクセスでは問題なく取得できたことから、IRBANK側がGitHub ActionsのデータセンターIPレンジをブロックしていると判断）。プロキシ・IP偽装等でこのブロックを回避する実装は行わない方針（サイト側のアクセス制御を尊重する）。当初は`scripts/fetch_irbank_ids.py`というCLIスクリプトとして実装したが、この機能はGitHub Actionsで動かせず`scripts/*.py`の役割（GitHub Actions上で実行するスクリプト）に合致しないため、[notebooks/*.ipynb](#notebooksipynbの規約)に一本化し、CLIスクリプトは削除した。
- **How to apply:** `notebooks/C01_IRBANK企業ID取得.ipynb`をJupyterで開いてセルを順に実行すると、既定値だけでローカルの`../../../data/stock/master.csv`を読み、`../../../data/stock/irbank.csv`を更新する（未取得銘柄のみ対象、取得済みはスキップ）。実行後は`app/brain/data`側の変更を自分でコミット・pushする（ユーザーがgit同期を自分で行う運用と一致）。アプリ側（`index.html`の「現在の状態」パネル）は`stock/irbank.csv`を読むだけなので、ローカル実行後にpushすれば自動的に反映される。

---

## 3. 実装の心得

- グローバル状態（現在のフィルタ状態、ポーリングの世代カウンタ等）は`js/app.js`側で保持する。
- **ワークフロー起動・進捗ポーリングの定石**：起動直前に「それまでの最新」のrun／commitをベースラインとして記録しておき、以降はそのid／shaから変化したかどうかで「新しい実行・新しいコミット」を判定する。作成時刻での比較は行わない（ブラウザ側の時計とGitHubサーバー側の時計がズレていても正しく動くようにするため）。既存実装（`trackBulkUpdateProgress`・`waitForWorkflowRun`等）を参考にする。
- DOM内のテキストをデータソースとして直接扱うことは禁止。CSV／JSON等のデータ構造を常に正とする。
- 外部ライブラリ（`marked.js`等）は`index.html`でCDN経由ロードし、JS側では`window.marked`等グローバルオブジェクト経由で使う。modules内での個別インポートは禁止。
- 仕様の不明点は勝手に進めず、必ずユーザーに確認する。

---

## 4. ドキュメント保守方針

- まとまった機能を実装・変更したら、都度[`README.md`](./README.md)の該当章に反映する。
- **Why:** READMEはページ単位で章立てされた「何ができるか」を示す利用者・開発者向け資料であり、実装と乖離すると資料としての価値が下がる。
- **How to apply:** 新機能追加・既存機能の仕様変更・タブ構成の変更など、ひとまとまり完了したタイミングで該当章を更新する。些細な内部リファクタや未完成の途中変更では都度更新しなくてよい。章構成そのものが大きく変わった場合は、README同士の使い回しやコード未確認での推測記述はせず、実装（`index.html`／`js/app.js`／`js/modules/*.js`／`scripts/*.py`）を実際に確認してから書く。
