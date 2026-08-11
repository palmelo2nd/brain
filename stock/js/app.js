import { loadIdToken, saveIdToken, loadPwToken, savePwToken } from './modules/storage.js';
import {
    dispatchWorkflow, fetchFile, fetchFileIfExists, listFilesRecursive, commitFile,
    getLatestWorkflowRun, getWorkflowRun, getLatestCommit
} from './modules/github.js';
import { parseCsv, stringifyCsv } from './modules/csv.js';

const OWNER              = 'palmelo2nd';
const CODE_REPO          = 'brain';        // ワークフローファイルが置かれているコードリポジトリ
const DATA_REPO          = 'brain_data';   // 銘柄マスタ・株価データが置かれているデータリポジトリ
const CODE_REPO_BRANCH   = 'main';
const DATA_REPO_BRANCH   = 'main';
const PRICE_WORKFLOW_FILE      = 'fetch-stock-prices.yml';
const PRICE_BULK_WORKFLOW_FILE = 'fetch-stock-prices-bulk.yml';
const PRICE_ISSUES_WORKFLOW_FILE = 'fetch-stock-prices-by-codes.yml'; // データ品質チェックで検出された銘柄コードの一括再取得
const VALIDATE_WORKFLOW_FILE   = 'validate-stock-prices.yml';
const FRESHNESS_WORKFLOW_FILE  = 'check-price-freshness.yml';
const MASTER_PATH   = 'stock/master.csv';
const PRICES_DIR    = 'stock/prices';
const VALIDATION_REPORT_PATH = 'stock/validation_report.json';
const FRESHNESS_REPORT_PATH  = 'stock/freshness_report.json';
const README_PATH   = 'stock/README.md'; // コードリポジトリ側（アプリ概要ドキュメント）
const HOLDINGS_PATH = 'stock/holdings.csv';
const HOLDINGS_HEADERS = ['id', 'owner', 'broker', 'account', 'code', 'shares', 'avg_cost'];
const BULK_ASSET_TYPES = ['内国株式', 'ETF・ETN']; // fetch_prices.pyの--asset-types既定値と揃えている

// ===== ID/PW（GitHub PAT）入力欄 =====
// ID: コードリポジトリ（brain）操作用PAT（ワークフロー起動＝dispatchWorkflowに使用）
// PW: データリポジトリ（brain_data）操作用PAT（ファイルの読み書き＝fetchFile/commitFile等に使用）
// 2つに分かれているのは、この2リポジトリで必要な権限が異なる（ID側はActions、PW側はContents）ため。
// それぞれ一度入力すればlocalStorageに保存され、次回以降は自動的に入力済みの状態になる。
const idInput = document.getElementById('id-input');
const pwInput = document.getElementById('pw-input');

/** コードリポジトリ操作用トークン（ID欄）を返す。 */
export function getCodeTokenValue() {
    return idInput ? idInput.value.trim() : '';
}

/** データリポジトリ操作用トークン（PW欄）を返す。 */
export function getDataTokenValue() {
    return pwInput ? pwInput.value.trim() : '';
}

window.addEventListener('DOMContentLoaded', () => {
    const savedId = loadIdToken();
    if (savedId && idInput) idInput.value = savedId;

    const savedPw = loadPwToken();
    if (savedPw && pwInput) pwInput.value = savedPw;
});

idInput?.addEventListener('input', () => {
    saveIdToken(idInput.value.trim());
});

pwInput?.addEventListener('input', () => {
    savePwToken(pwInput.value.trim());
});

// ===== ページ切り替え（タブ） =====
// 現時点ではレイアウトの土台のみ。各ページの実装は今後 modules/ 配下に追加していく。

const STOCK_VIEWS = ['dashboard', 'holdings', 'dataupdate', 'attributes', 'score', 'suggest', 'info'];

function renderStockView(view) {
    STOCK_VIEWS.forEach(v => {
        document.getElementById(`tab-${v}`)?.classList.toggle('view-btn--active', v === view);
        const panel = document.getElementById(`view-${v}`);
        if (panel) panel.style.display = v === view ? '' : 'none';
    });
}

STOCK_VIEWS.forEach(v => {
    document.getElementById(`tab-${v}`)?.addEventListener('click', () => renderStockView(v));
});

// データ更新タブを開いたとき、PWが入力済みなら状態パネルを自動更新する
document.getElementById('tab-dataupdate')?.addEventListener('click', () => {
    if (getDataTokenValue()) loadFreshnessStatus();
});

// 保有・履歴タブを開いたとき、PWが入力済みなら保有銘柄一覧を自動読み込みする
document.getElementById('tab-holdings')?.addEventListener('click', () => {
    if (getDataTokenValue()) loadHoldings();
});

// ===== Info：コードリポジトリのREADME.md（アプリ概要）を取得しMarkdownとして表示 =====
async function loadInfoReadme() {
    const el = document.getElementById('info-content');
    const token = getCodeTokenValue();
    if (!token) { el.textContent = 'IDを入力してください。'; return; }

    el.textContent = '読み込み中...';

    try {
        const text = await fetchFile(token, OWNER, CODE_REPO, README_PATH);
        el.innerHTML = window.marked.parse(text);
    } catch (error) {
        console.error(error);
        el.textContent = `読み込みに失敗しました: ${error.message}`;
    }
}

// Infoタブを開いたとき、IDが入力済みなら自動的に読み込む
document.getElementById('tab-info')?.addEventListener('click', () => {
    if (getCodeTokenValue()) loadInfoReadme();
});

document.getElementById('info-reload-btn')?.addEventListener('click', loadInfoReadme);

// ===== データ更新：株価取得（yfinance）のGitHub Actionsワークフローを起動 =====
document.getElementById('price-update-run-btn')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('price-update-status');
    const codesInput  = document.getElementById('price-update-code');
    const periodInput = document.getElementById('price-update-period');

    const token  = getCodeTokenValue();
    const codes  = codesInput.value.trim();
    const period = periodInput.value.trim(); // 空欄なら2013年以降の全期間（ワークフロー側のデフォルト）

    if (!token) { alert('IDを入力してください'); return; }
    if (!codes) { alert('証券コードを入力してください'); return; }

    statusEl.textContent = '実行をリクエスト中...';

    try {
        await dispatchWorkflow(token, OWNER, CODE_REPO, PRICE_WORKFLOW_FILE, CODE_REPO_BRANCH, { codes, period });
        statusEl.textContent =
            `実行をリクエストしました（コード: ${codes} / 期間: ${period || '2013年以降の全期間'}）。` +
            `数十秒〜数分後にデータリポジトリの stock/prices/ 配下が更新されます。` +
            `GitHubの Actions タブから進捗を確認できます。`;
    } catch (error) {
        console.error(error);
        statusEl.textContent = `失敗しました: ${error.message}`;
    }
});

// ===== データ更新：株価の更新（日常運用向け・対象銘柄すべてを差分更新） =====
// 一括取得ワークフロー（fetch-stock-prices-bulk.yml）をoffset=0・mode=updateで起動する。
// limitは毎回master.csvから対象件数（listed×BULK_ASSET_TYPES）を数えて渡す（手動でのoffset/limit指定を不要にするため）。
// 起動後は実行状況とコミット進捗をポーリングし、進捗バー・バナーに反映する（ブラウザを閉じるとポーリングは止まるが、
// ワークフロー自体はGitHub側で継続するので、再度開いて「チェック」を押せば結果は確認できる）。

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let bulkUpdateTrackingGen = 0; // ボタン多重クリック時、古いポーリングを打ち切るための世代カウンタ

function setBulkUpdateBanner(state, text) {
    const el = document.getElementById('price-update-all-status');
    el.textContent = text;
    el.classList.remove('update-banner--running', 'update-banner--success', 'update-banner--failure');
    if (state) el.classList.add(`update-banner--${state}`);
}

function setBulkUpdateProgress(processed, target) {
    const wrap = document.getElementById('price-update-all-progress');
    const bar = document.getElementById('price-update-all-bar');
    const percentEl = document.getElementById('price-update-all-percent');
    const pct = target > 0 ? Math.min(100, Math.round((processed / target) * 100)) : 0;

    wrap.style.display = '';
    bar.value = pct;
    percentEl.textContent = `${pct}%（${Math.min(processed, target)}/${target}）`;
}

// コミットメッセージ「...offset=123, count=20）」からoffset・countを取り出し、処理済み件数（offset+count）を返す
function parseProcessedFromCommitMessage(message) {
    const m = message && message.match(/offset=(\d+),\s*count=(\d+)/);
    return m ? Number(m[1]) + Number(m[2]) : null;
}

// baselineRun/baselineCommit: 起動直前（dispatchWorkflowを呼ぶ前）に取得しておいた「それまでの最新」の状態。
// created_at等の時刻比較ではなく、この基準からid/shaが変化したかどうかで新しい実行・コミットを判定する
// （ブラウザ側の時計がGitHubサーバー側とズレていても正しく動く）。
async function trackBulkUpdateProgress(myGen, baselineRun, baselineCommit, targetCount, btn) {
    const codeToken = getCodeTokenValue();
    const dataToken = getDataTokenValue();
    const baselineRunId = baselineRun ? baselineRun.id : null;
    const baselineCommitSha = baselineCommit ? baselineCommit.sha : null;

    // (a) 一覧の先頭がbaselineから変わる（＝新しい実行が始まった）まで探す（最大30秒）
    let run = null;
    let lastError = null;
    let lastSeenRunId = null;
    for (let i = 0; i < 10; i++) {
        if (myGen !== bulkUpdateTrackingGen) return; // 別の実行が始まっていたら中断
        try {
            const latest = await getLatestWorkflowRun(codeToken, OWNER, CODE_REPO, PRICE_BULK_WORKFLOW_FILE);
            lastSeenRunId = latest ? latest.id : null;
            lastError = null;
            if (latest && latest.id !== baselineRunId) run = latest;
        } catch (error) {
            console.error(error);
            lastError = error;
        }
        if (run) break;
        await sleep(3000);
    }

    if (!run) {
        // 原因調査用に、最後に何が起きていたか（APIエラー／一覧の先頭が変わらなかった等）をバナーに出す
        const detail = lastError
            ? `直近のエラー: ${lastError.message}`
            : `直近の一覧の先頭run id: ${lastSeenRunId ?? 'なし'}（起動前と同じ: ${lastSeenRunId === baselineRunId}）`;
        setBulkUpdateBanner('failure',
            `実行の自動追跡に失敗しました（一覧に新しい実行が見つかりませんでした）。リクエスト自体は送信済みです。` +
            `GitHubのActionsタブから状況を確認してください。[${detail}]`);
        btn.disabled = false;
        return;
    }

    // (b) 完了するまで、実行状況とコミット進捗を定期的に確認する
    while (myGen === bulkUpdateTrackingGen) {
        try {
            const latestRun = await getWorkflowRun(codeToken, OWNER, CODE_REPO, run.id);

            const commit = await getLatestCommit(dataToken, OWNER, DATA_REPO, DATA_REPO_BRANCH, PRICES_DIR);
            if (commit && commit.sha !== baselineCommitSha) {
                const processed = parseProcessedFromCommitMessage(commit.message);
                if (processed !== null) setBulkUpdateProgress(processed, targetCount);
            }

            if (latestRun.status === 'completed') {
                const ok = latestRun.conclusion === 'success';
                setBulkUpdateProgress(targetCount, targetCount);
                setBulkUpdateBanner(ok ? 'success' : 'failure',
                    ok
                        ? `完了しました（対象 ${targetCount}銘柄・差分更新）。状態パネルを更新します...`
                        : `完了しましたが、一部失敗した可能性があります（結果: ${latestRun.conclusion}）。詳細はGitHubのActionsタブで確認してください。`
                );
                btn.disabled = false;
                loadFreshnessStatus();
                return;
            }

            setBulkUpdateBanner('running',
                latestRun.status === 'queued' ? 'キューに登録されました。開始を待っています...' : '実行中...'
            );
        } catch (error) {
            console.error(error);
        }
        await sleep(15000);
    }
}

document.getElementById('price-update-all-btn')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const codeToken = getCodeTokenValue();
    const dataToken = getDataTokenValue();
    if (!codeToken) { alert('IDを入力してください'); return; }
    if (!dataToken) { alert('PWを入力してください（対象銘柄数の確認・進捗表示に使用します）'); return; }

    // 実行中の多重クリックによる二重起動を防ぐ（GitHub Actions側のconcurrency設定が本丸の対策だが、
    // UI側でも防げるに越したことはない。トラッキングが終わるまで再度押せないようにする）
    btn.disabled = true;

    document.getElementById('price-update-all-progress').style.display = 'none';
    setBulkUpdateBanner('running', '対象銘柄数を確認中...');

    try {
        const masterText = await fetchFile(dataToken, OWNER, DATA_REPO, MASTER_PATH);
        const allRows = parseCsv(masterText);
        const targetCount = allRows.filter(r =>
            r.status === 'listed' && BULK_ASSET_TYPES.includes(r.asset_type)
        ).length;

        if (targetCount === 0) {
            // master.csvは取得できたが対象銘柄が0件 ＝ 内容が想定と異なる可能性が高い（権限エラーなら例外で分かる）。
            // 開発者ツールを開かなくても原因調査できるよう、実際に取得できた内容をバナーに直接表示する。ワークフローは起動しない。
            const headSnippet = masterText.slice(0, 200).replace(/\s+/g, ' ').trim();
            setBulkUpdateBanner('failure',
                `対象銘柄が0件でした。ワークフローは起動していません。` +
                `[取得文字数: ${masterText.length} / 解析できた行数: ${allRows.length}件 / ` +
                `1行目の解析結果: ${JSON.stringify(allRows[0] ?? null)}] ` +
                `[内容の先頭200文字: "${headSnippet}${masterText.length > 200 ? '...' : ''}"]`);
            btn.disabled = false;
            return;
        }

        setBulkUpdateBanner('running', '実行状況を確認中...');

        // ワークフロー特定・進捗追跡のため、起動直前の「それまでの最新」状態をベースラインとして記録しておく
        // （時刻での比較ではなく、この基準からid/shaが変化したかどうかで新しい実行・コミットを判定する）
        const [baselineRun, baselineCommit] = await Promise.all([
            getLatestWorkflowRun(codeToken, OWNER, CODE_REPO, PRICE_BULK_WORKFLOW_FILE).catch(() => null),
            getLatestCommit(dataToken, OWNER, DATA_REPO, DATA_REPO_BRANCH, PRICES_DIR).catch(() => null),
        ]);

        // 前回の実行がまだ動いている状態でもう一度起動すると、同じディレクトリへ同時にコミット・pushしようとして
        // 競合し、片方が失敗することがある（実際に発生した事例あり）。事前に警告し、続行するか確認する。
        if (baselineRun && (baselineRun.status === 'in_progress' || baselineRun.status === 'queued')) {
            const proceed = confirm(
                '前回の「最新株価取得」がまだ実行中の可能性があります。\n' +
                '同時に実行すると、データリポジトリへのコミットが競合し、片方が失敗する場合があります。\n' +
                'それでも実行しますか？'
            );
            if (!proceed) {
                setBulkUpdateBanner(null, '実行をキャンセルしました。前回の実行が完了してから再度お試しください。');
                btn.disabled = false;
                return;
            }
        }

        setBulkUpdateBanner('running', '実行をリクエスト中...');

        await dispatchWorkflow(codeToken, OWNER, CODE_REPO, PRICE_BULK_WORKFLOW_FILE, CODE_REPO_BRANCH, {
            offset: '0', limit: String(targetCount), mode: 'update'
        });

        setBulkUpdateProgress(0, targetCount);
        setBulkUpdateBanner('running', `実行をリクエストしました（対象 ${targetCount}銘柄・差分更新）。実行状況を確認しています...`);

        bulkUpdateTrackingGen += 1;
        trackBulkUpdateProgress(bulkUpdateTrackingGen, baselineRun, baselineCommit, targetCount, btn);
    } catch (error) {
        console.error(error);
        setBulkUpdateBanner('failure', `失敗しました: ${error.message}`);
        btn.disabled = false;
    }
});

// ===== データ更新：銘柄マスタ（master.csv）から範囲指定して一括取得するワークフローを起動 =====
document.getElementById('bulk-update-run-btn')?.addEventListener('click', async () => {
    const statusEl     = document.getElementById('bulk-update-status');
    const modeInput    = document.getElementById('bulk-update-mode');
    const offsetInput  = document.getElementById('bulk-update-offset');
    const limitInput   = document.getElementById('bulk-update-limit');

    const token  = getCodeTokenValue();
    const mode   = modeInput.value;
    const offset = offsetInput.value.trim() || '0';
    const limit  = limitInput.value.trim();

    if (!token) { alert('IDを入力してください'); return; }
    if (!limit) { alert('件数を入力してください'); return; }

    const modeLabel = mode === 'update' ? '差分更新' : '初回取得';
    statusEl.textContent = '実行をリクエスト中...';

    try {
        await dispatchWorkflow(token, OWNER, CODE_REPO, PRICE_BULK_WORKFLOW_FILE, CODE_REPO_BRANCH, { offset, limit, mode });
        statusEl.textContent =
            `実行をリクエストしました（モード: ${modeLabel} / 開始位置: ${offset} / 件数: ${limit}）。` +
            `20件処理するごとにデータリポジトリへ自動コミットされます。` +
            `GitHubの Actions タブから進捗を確認できます。`;
    } catch (error) {
        console.error(error);
        statusEl.textContent = `失敗しました: ${error.message}`;
    }
});

// ===== データ更新：一括取得の進捗確認（銘柄マスタ×既存の保存済みCSVを突き合わせ、次の開始位置を提案） =====
document.getElementById('bulk-update-check-btn')?.addEventListener('click', async () => {
    const progressEl  = document.getElementById('bulk-update-progress');
    const offsetInput = document.getElementById('bulk-update-offset');

    const token = getDataTokenValue();
    if (!token) { alert('PWを入力してください'); return; }

    progressEl.textContent = '確認中...';

    try {
        const masterText = await fetchFile(token, OWNER, DATA_REPO, MASTER_PATH);
        const targetRows = parseCsv(masterText).filter(r =>
            r.status === 'listed' && BULK_ASSET_TYPES.includes(r.asset_type)
        );

        // Contents API（ディレクトリ一覧）は1,000件で打ち切られるため、Git Trees APIで漏れなく列挙する
        // （stock/prices/は数千件規模になるため必須。旧実装のContents API版だと大部分が「未取得」に誤判定されていた）
        const files = await listFilesRecursive(token, OWNER, DATA_REPO, DATA_REPO_BRANCH, PRICES_DIR);
        const existingCodes = new Set(
            files.filter(f => f.name.endsWith('.csv'))
                 .map(f => f.name.replace(/\.csv$/, ''))
        );

        const doneCount   = targetRows.filter(r => existingCodes.has(r.code)).length;
        const remaining   = targetRows.length - doneCount;
        const nextIndex   = targetRows.findIndex(r => !existingCodes.has(r.code));

        if (nextIndex === -1) {
            progressEl.textContent = `対象 ${targetRows.length}件のうち ${doneCount}件取得済み。すべて完了しています。`;
        } else {
            if (offsetInput) offsetInput.value = nextIndex;
            progressEl.textContent =
                `対象 ${targetRows.length}件のうち ${doneCount}件取得済み（残り ${remaining}件）。` +
                `次の開始位置候補: ${nextIndex}（未取得の中で最も番号が小さい位置。自動入力しました。` +
                `途中を何度か再取得している場合、この位置より後にも未取得が飛び飛びで残っている可能性があります）`;
        }
    } catch (error) {
        console.error(error);
        progressEl.textContent = `確認に失敗しました: ${error.message}`;
    }
});

// ===== データ更新：現在の状態パネル（freshness_report.json・validation_report.jsonを読み込んで常時表示用に整形） =====
async function loadFreshnessStatus() {
    const summaryEl = document.getElementById('status-summary');
    const token = getDataTokenValue();
    if (!token) { summaryEl.textContent = 'PWを入力し「チェック」を押してください。'; return; }

    summaryEl.textContent = '状態を確認中...';

    try {
        // 品質チェックの結果は未実行だとファイル自体が存在しないため、fetchFileIfExistsでnull許容にする
        const [reportText, validationText] = await Promise.all([
            fetchFile(token, OWNER, DATA_REPO, FRESHNESS_REPORT_PATH),
            fetchFileIfExists(token, OWNER, DATA_REPO, VALIDATION_REPORT_PATH),
        ]);
        const report = JSON.parse(reportText);
        const validation = validationText ? JSON.parse(validationText) : null;

        summaryEl.innerHTML = '';

        // ----- 更新最終日 -----
        const freshnessSection = document.createElement('details');
        freshnessSection.className = 'status-section';

        const freshnessTitle = document.createElement('summary');
        freshnessTitle.className = 'update-form-title';
        freshnessTitle.textContent = '更新最終日';
        freshnessSection.appendChild(freshnessTitle);

        const lines = document.createElement('div');
        lines.className = 'status-lines';
        [
            `チェック日時: ${report.checked_at}`,
            `対象: ${report.total_files}銘柄 / 全体の最新日付: ${report.latest_date}`,
            `要更新（${report.stale_days}日超過）: ${report.stale_count}件 / 最も遅れている銘柄: ${report.oldest_last_date_code}（${report.oldest_last_date}）`,
        ].forEach(text => {
            const p = document.createElement('p');
            p.textContent = text;
            lines.appendChild(p);
        });
        freshnessSection.appendChild(lines);

        // 銘柄ごとの最終日付の分布（新しい日付が上に来るように降順）。
        // 大半が最新日付に揃っていれば正常、古い日付に銘柄が散っていれば取りこぼしがあると分かる。
        // codes_by_date（日付ごとの該当銘柄コード一覧）があれば、行ごとに折りたたみで内訳を出す
        // （古いcheck_freshness.pyで作られたレポートにはこのフィールドが無いので、その場合は件数のみ表示する）。
        if (report.distribution) {
            const entries = Object.entries(report.distribution).sort((a, b) => b[0].localeCompare(a[0]));
            const list = document.createElement('ul');
            list.className = 'status-distribution';
            entries.forEach(([date, count]) => {
                const codes = report.codes_by_date ? report.codes_by_date[date] : null;
                list.appendChild(buildExpandableListItem(`${date}: ${count}銘柄`, codes));
            });
            freshnessSection.appendChild(list);
        }

        summaryEl.appendChild(freshnessSection);

        // ----- データ品質 -----
        const qualitySection = document.createElement('details');
        qualitySection.className = 'status-section';

        const qualityTitle = document.createElement('summary');
        qualityTitle.className = 'update-form-title';
        qualityTitle.textContent = 'データ品質';
        qualitySection.appendChild(qualityTitle);

        const qualityLines = document.createElement('div');
        qualityLines.className = 'status-lines';
        const qualityP = document.createElement('p');
        if (!validation) {
            qualityP.textContent = '品質チェック: 未実行です';
        } else if (validation.issue_count > 0) {
            qualityP.textContent = `品質チェック（${validation.checked_at}時点）: 問題 ${validation.issue_count}件`;
            qualityP.classList.add('status-line--warning');
        } else {
            qualityP.textContent = `品質チェック（${validation.checked_at}時点）: 問題なし`;
        }
        qualityLines.appendChild(qualityP);
        qualitySection.appendChild(qualityLines);

        if (validation && validation.issue_count > 0) {
            renderValidationIssues(qualitySection, validation);
        }

        summaryEl.appendChild(qualitySection);
    } catch (error) {
        console.error(error);
        summaryEl.textContent = `状態の取得に失敗しました: ${error.message}`;
    }
}

// 件数テキスト（summaryText）を表示するリスト項目（<li>）を作る。
// codesが1件以上あればExpander（<details>）にして、開くと該当銘柄コードの一覧が見える形にする。
// codesが無ければ（古い形式のレポート等）文字列だけの<li>にする。
// 「更新最終日」の日付ごとの内訳・「データ品質」の問題ごとの内訳の両方で共通して使い、見た目を揃えている。
function buildExpandableListItem(summaryText, codes) {
    const li = document.createElement('li');
    if (codes && codes.length > 0) {
        const details = document.createElement('details');
        details.className = 'status-date-detail';
        const summary = document.createElement('summary');
        summary.textContent = summaryText;
        details.appendChild(summary);
        const codeList = document.createElement('div');
        codeList.className = 'status-code-list';
        codeList.textContent = codes.join(', ');
        details.appendChild(codeList);
        li.appendChild(details);
    } else {
        li.textContent = summaryText;
    }
    return li;
}

// 指定ワークフローの実行が完了するまで待つ（バックグラウンドで並行して待てるようPromiseを返す）。
// baselineRunId: 起動前に記録しておいた「それまでの最新」run id（無ければnull）。
// 一覧の先頭がこれと変わる（＝新しい実行が始まった）まで探し、見つかったらそのrunが完了するまでポーリングする。
// 時刻ではなくid比較で新しい実行を判定する（ブラウザ側の時計とGitHubサーバー側の時計がズレていても正しく動く）。
// 戻り値: 完了したrunオブジェクト（status==='completed'）。実行が見つからなかった場合はnull。
async function waitForWorkflowRun(codeToken, workflowFile, baselineRunId) {
    let run = null;
    for (let i = 0; i < 10; i++) {
        try {
            const latest = await getLatestWorkflowRun(codeToken, OWNER, CODE_REPO, workflowFile);
            if (latest && latest.id !== baselineRunId) { run = latest; break; }
        } catch (error) {
            console.error(error);
        }
        await sleep(3000);
    }
    if (!run) return null;

    while (true) {
        try {
            const latestRun = await getWorkflowRun(codeToken, OWNER, CODE_REPO, run.id);
            if (latestRun.status === 'completed') return latestRun;
        } catch (error) {
            console.error(error);
        }
        await sleep(15000);
    }
}

// 鮮度チェック・品質チェックを両方実行し、完了を待って状態パネルへ反映する。
// 「チェック」ボタンと、品質チェックの「検出銘柄をまとめて再取得」ボタン（再取得後に直せたか確認するため）の
// 両方から呼ばれる共通処理。
async function runFullCheck() {
    const summaryEl = document.getElementById('status-summary');
    const codeToken = getCodeTokenValue();
    const dataToken = getDataTokenValue();
    if (!codeToken) { alert('IDを入力してください'); return; }
    if (!dataToken) { alert('PWを入力してください（結果の確認に使用します）'); return; }

    summaryEl.textContent = 'チェックを実行中...（鮮度チェック・品質チェックを開始しています）';

    try {
        // 起動前に「それまでの最新」の実行を記録しておく（新しい実行が始まったことの判定に使う）
        const [freshnessBaseline, validationBaseline] = await Promise.all([
            getLatestWorkflowRun(codeToken, OWNER, CODE_REPO, FRESHNESS_WORKFLOW_FILE).catch(() => null),
            getLatestWorkflowRun(codeToken, OWNER, CODE_REPO, VALIDATE_WORKFLOW_FILE).catch(() => null),
        ]);

        // 鮮度チェックと品質チェックは別ファイル（freshness_report.json / validation_report.json）に
        // コミットするため競合せず、同時に起動できる
        await Promise.all([
            dispatchWorkflow(codeToken, OWNER, CODE_REPO, FRESHNESS_WORKFLOW_FILE, CODE_REPO_BRANCH, {}),
            dispatchWorkflow(codeToken, OWNER, CODE_REPO, VALIDATE_WORKFLOW_FILE, CODE_REPO_BRANCH, {}),
        ]);

        summaryEl.textContent = 'チェックを実行中...（完了を待っています。数分かかります）';

        const [freshnessRun, validationRun] = await Promise.all([
            waitForWorkflowRun(codeToken, FRESHNESS_WORKFLOW_FILE, freshnessBaseline ? freshnessBaseline.id : null),
            waitForWorkflowRun(codeToken, VALIDATE_WORKFLOW_FILE, validationBaseline ? validationBaseline.id : null),
        ]);

        const problems = [];
        if (!freshnessRun) problems.push('鮮度チェックの実行が見つかりませんでした');
        else if (freshnessRun.conclusion !== 'success') problems.push(`鮮度チェックが失敗しました（結果: ${freshnessRun.conclusion}）`);
        if (!validationRun) problems.push('品質チェックの実行が見つかりませんでした');
        else if (validationRun.conclusion !== 'success') problems.push(`品質チェックが失敗しました（結果: ${validationRun.conclusion}）`);

        await loadFreshnessStatus();

        if (problems.length > 0) {
            const warn = document.createElement('p');
            warn.className = 'status-line--warning';
            warn.textContent = problems.join(' / ') + '（GitHubのActionsタブで詳細を確認してください）';
            summaryEl.prepend(warn);
        }
    } catch (error) {
        console.error(error);
        summaryEl.textContent = `失敗しました: ${error.message}`;
    }
}

// ===== データ更新：チェック（鮮度チェック・品質チェックを両方実行し、完了を待って状態パネルへ反映） =====
document.getElementById('status-check-btn')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
        await runFullCheck();
    } finally {
        btn.disabled = false;
    }
});

// データ品質チェックの問題内訳（再取得ボタン付き）をcontainerに描画する。
// 状態パネルの「チェック」実行後、問題が1件以上あるときにloadFreshnessStatusから呼ばれる。
function renderValidationIssues(container, validation) {
    // 検出された銘柄コード（重複除去）をまとめて再取得するボタン。2013年以降の全期間を取得し直すことで、
    // 差分更新（末尾への追記のみ）では直せない途中の欠損・終値空欄・重複日付なども穴埋めする。
    const issueCodes = Array.from(new Set(validation.issues.map(issue => issue.code)));
    const refetchBar = document.createElement('div');
    refetchBar.className = 'validate-refetch-bar';
    const refetchBtn = document.createElement('button');
    refetchBtn.type = 'button';
    refetchBtn.className = 'run-btn';
    refetchBtn.textContent = `検出銘柄${issueCodes.length}件をまとめて再取得`;
    refetchBtn.addEventListener('click', () => refetchIssueCodes(issueCodes, refetchBtn));
    refetchBar.appendChild(refetchBtn);
    container.appendChild(refetchBar);

    // 同一内容（type+detail）の問題は銘柄をまたいで多発しやすい（例: 特定期間の連休による欠損）ため、
    // 件数付きのサマリーとしてまとめ、該当銘柄コードはExpanderの中に入れる（「更新最終日」と同じ見た目にする）
    const groups = new Map();
    validation.issues.forEach(issue => {
        const key = `${issue.type}::${issue.detail}`;
        if (!groups.has(key)) groups.set(key, { type: issue.type, detail: issue.detail, count: 0, codes: [] });
        const group = groups.get(key);
        group.count += 1;
        group.codes.push(issue.code);
    });
    const sortedGroups = Array.from(groups.values()).sort((a, b) => b.count - a.count);

    const list = document.createElement('ul');
    list.className = 'status-distribution';
    sortedGroups.forEach(group => {
        list.appendChild(buildExpandableListItem(`${group.count}件：${group.detail}`, group.codes));
    });
    container.appendChild(list);
}

// データ品質チェックで検出された銘柄コードをまとめて再取得するワークフロー（fetch-stock-prices-by-codes.yml）を起動する。
// mode=fullで2013年以降の全期間を取得し直すため、差分更新では直せない途中の欠損等も穴埋めできる。
// 20件ごとに自動コミットされるワークフロー側の仕組みにより、対象が多くても途中失敗で全て失うことはない。
// 完了後は「チェック」と同じくrunFullCheck()を実行し、再取得で直ったかどうかを自動で確認・反映する。
async function refetchIssueCodes(codes, buttonEl) {
    if (codes.length === 0) return;

    const ok = confirm(`${codes.length}件の銘柄を2013年以降の全期間で再取得します。よろしいですか？`);
    if (!ok) return;

    const codeToken = getCodeTokenValue();
    const dataToken = getDataTokenValue();
    if (!codeToken) { alert('IDを入力してください'); return; }
    if (!dataToken) { alert('PWを入力してください（完了後のチェック結果の確認に使用します）'); return; }

    buttonEl.disabled = true;
    buttonEl.textContent = '実行をリクエスト中...';

    try {
        const baseline = await getLatestWorkflowRun(codeToken, OWNER, CODE_REPO, PRICE_ISSUES_WORKFLOW_FILE).catch(() => null);

        await dispatchWorkflow(codeToken, OWNER, CODE_REPO, PRICE_ISSUES_WORKFLOW_FILE, CODE_REPO_BRANCH, {
            codes: codes.join(','),
            mode: 'full'
        });

        buttonEl.textContent = `再取得の完了を待っています...（${codes.length}件・数分かかります）`;
        const run = await waitForWorkflowRun(codeToken, PRICE_ISSUES_WORKFLOW_FILE, baseline ? baseline.id : null);

        if (!run) {
            alert('再取得の実行が見つかりませんでした。リクエスト自体は送信済みです。GitHubのActionsタブから状況を確認してください。');
        } else if (run.conclusion !== 'success') {
            alert(`再取得が完了しましたが、一部失敗した可能性があります（結果: ${run.conclusion}）。詳細はGitHubのActionsタブで確認してください。`);
        }

        buttonEl.textContent = 'チェックを実行中...（完了を待っています。数分かかります）';
        await runFullCheck(); // 完了後、状態パネル全体が再描画されるためbuttonElへの参照はここで役目を終える
    } catch (error) {
        console.error(error);
        buttonEl.disabled = false;
        buttonEl.textContent = `検出銘柄${codes.length}件をまとめて再取得`;
        alert(`再取得の実行に失敗しました: ${error.message}`);
    }
}

// ===== 保有・履歴：保有銘柄（stock/holdings.csv）の手入力登録 =====
// 行単位で編集可能なテーブル（brainアプリの編集タブと同じ操作感: 一覧クリック→フォーム→新規/適用/削除）。
// 「適用」「削除」の時点ではholdingsRows（メモリ上）だけが変わり、GitHubへは反映されない。
// 「保存」を押した時点で初めてstock/holdings.csv（データリポジトリ）へコミットする。

let holdingsRows = [];          // 保有銘柄一覧（メモリ上の編集対象）
let holdingsLoaded = false;     // 一度でも読み込み（新規ファイルの場合は0件読み込み）が済んだか
let selectedHoldingId = null;   // 一覧で選択中の行ID（フォームの編集対象）
let masterNameMapPromise = null; // 証券コード→銘柄名のMap（Promise）。セッション中は初回取得分を使い回す

/** master.csv を取得し、証券コード→銘柄名のMapを返す（保有銘柄一覧・入力フォームでの銘柄名表示に使用）。 */
function getMasterNameMap(token) {
    if (!masterNameMapPromise) {
        masterNameMapPromise = fetchFile(token, OWNER, DATA_REPO, MASTER_PATH)
            .then(text => new Map(parseCsv(text).map(r => [r.code, r.name])))
            .catch(error => { masterNameMapPromise = null; throw error; });
    }
    return masterNameMapPromise;
}

/** holdingsRows内の最大id（数値部分）+1を返す（新規行のid採番用）。 */
function nextHoldingId(rows) {
    const maxId = rows.reduce((max, r) => {
        const n = parseInt(r.id, 10);
        return Number.isNaN(n) ? max : Math.max(max, n);
    }, 0);
    return maxId + 1;
}

/** 保有銘柄一覧テーブルを描画する。銘柄名はmaster.csvから解決できた場合のみ表示する（未解決でもコード自体は表示する）。 */
async function renderHoldingsTable() {
    const table = document.getElementById('holdings-table');
    if (!table) return;

    const token = getDataTokenValue();
    let nameMap = new Map();
    if (token) {
        try { nameMap = await getMasterNameMap(token); } catch (error) { console.error(error); }
    }

    const cols = ['所有者', '証券会社', '口座区分', 'コード', '銘柄名', '株数', '取得単価'];
    const thead = document.createElement('thead');
    const hRow = document.createElement('tr');
    cols.forEach(col => { const th = document.createElement('th'); th.textContent = col; hRow.appendChild(th); });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    if (holdingsRows.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = cols.length;
        td.className = 'empty-cell';
        td.textContent = '保有銘柄が登録されていません';
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        holdingsRows.forEach(row => {
            const tr = document.createElement('tr');
            if (String(row.id) === String(selectedHoldingId)) tr.classList.add('selected-row');
            [row.owner, row.broker, row.account, row.code, nameMap.get(row.code) || '', row.shares, row.avg_cost]
                .forEach(value => {
                    const td = document.createElement('td');
                    td.textContent = value ?? '';
                    tr.appendChild(td);
                });
            tr.addEventListener('click', () => loadHoldingIntoForm(row.id));
            tbody.appendChild(tr);
        });
    }
    table.replaceChildren(thead, tbody);
}

/** 所有者／証券会社／口座区分の入力補助（datalist）を、現在のholdingsRowsに実在する値から再構築する。 */
function renderHoldingsDatalists() {
    const fillDatalist = (elId, values) => {
        const el = document.getElementById(elId);
        if (!el) return;
        el.innerHTML = '';
        [...new Set(values.filter(Boolean))].sort().forEach(value => {
            const option = document.createElement('option');
            option.value = value;
            el.appendChild(option);
        });
    };
    fillDatalist('holdings-owner-list',   holdingsRows.map(r => r.owner));
    fillDatalist('holdings-broker-list',  holdingsRows.map(r => r.broker));
    fillDatalist('holdings-account-list', holdingsRows.map(r => r.account));
}

/** 入力フォームを新規登録モードにリセットする。 */
function clearHoldingsForm() {
    selectedHoldingId = null;
    document.getElementById('holdings-edit-id').value = '';
    document.getElementById('holdings-owner').value = '';
    document.getElementById('holdings-broker').value = '';
    document.getElementById('holdings-account').value = '';
    document.getElementById('holdings-code').value = '';
    document.getElementById('holdings-code-name').textContent = '';
    document.getElementById('holdings-shares').value = '';
    document.getElementById('holdings-avg-cost').value = '';
    document.getElementById('holdings-form-title').textContent = '新規登録';
    renderHoldingsTable();
}

/** 指定idの保有銘柄を入力フォームへ読み込む（一覧クリック時）。 */
function loadHoldingIntoForm(id) {
    const row = holdingsRows.find(r => String(r.id) === String(id));
    if (!row) return;

    selectedHoldingId = row.id;
    document.getElementById('holdings-edit-id').value = row.id;
    document.getElementById('holdings-owner').value   = row.owner   || '';
    document.getElementById('holdings-broker').value  = row.broker  || '';
    document.getElementById('holdings-account').value = row.account || '';
    document.getElementById('holdings-code').value    = row.code    || '';
    document.getElementById('holdings-shares').value  = row.shares  || '';
    document.getElementById('holdings-avg-cost').value = row.avg_cost || '';
    document.getElementById('holdings-form-title').textContent = `編集（ID: ${row.id}）`;
    document.getElementById('holdings-code').dispatchEvent(new Event('input')); // 銘柄名プレビューを更新
    renderHoldingsTable();
}

/** stock/holdings.csv を読み込む（未作成の場合は0件として扱う）。 */
async function loadHoldings() {
    const listStatusEl = document.getElementById('holdings-list-status');
    const token = getDataTokenValue();
    if (!token) { listStatusEl.textContent = 'PWを入力してください。'; return; }

    listStatusEl.textContent = '読み込み中...';

    try {
        const text = await fetchFileIfExists(token, OWNER, DATA_REPO, HOLDINGS_PATH);
        holdingsRows = text ? parseCsv(text) : [];
        holdingsLoaded = true;
        clearHoldingsForm();
        renderHoldingsDatalists();
        listStatusEl.textContent = text
            ? `${holdingsRows.length}件を読み込みました。`
            : 'まだ保有銘柄が登録されていません（「保存」を押すとstock/holdings.csvが新規作成されます）。';
    } catch (error) {
        console.error(error);
        listStatusEl.textContent = `読み込みに失敗しました: ${error.message}`;
    }
}

document.getElementById('holdings-reload-btn')?.addEventListener('click', loadHoldings);

// 証券コード入力のたびに、master.csvから引ける銘柄名をプレビュー表示する
document.getElementById('holdings-code')?.addEventListener('input', async () => {
    const codeInput = document.getElementById('holdings-code');
    const nameEl = document.getElementById('holdings-code-name');
    const code = codeInput.value.trim();
    const token = getDataTokenValue();
    if (!code || !token) { nameEl.textContent = ''; return; }

    try {
        const nameMap = await getMasterNameMap(token);
        if (codeInput.value.trim() !== code) return; // 取得中に入力内容が変わっていたら破棄
        nameEl.textContent = nameMap.has(code) ? nameMap.get(code) : '（銘柄マスタに見つかりません）';
    } catch (error) {
        console.error(error);
        nameEl.textContent = '';
    }
});

document.getElementById('holdings-new-btn')?.addEventListener('click', clearHoldingsForm);

document.getElementById('holdings-apply-btn')?.addEventListener('click', () => {
    const code   = document.getElementById('holdings-code').value.trim();
    const shares = document.getElementById('holdings-shares').value.trim();
    if (!code)   { alert('証券コードを入力してください'); return; }
    if (!shares) { alert('株数を入力してください'); return; }

    const editId = document.getElementById('holdings-edit-id').value;
    const record = {
        id:      editId || String(nextHoldingId(holdingsRows)),
        owner:   document.getElementById('holdings-owner').value.trim(),
        broker:  document.getElementById('holdings-broker').value.trim(),
        account: document.getElementById('holdings-account').value.trim(),
        code,
        shares,
        avg_cost: document.getElementById('holdings-avg-cost').value.trim(),
    };

    if (editId) {
        const idx = holdingsRows.findIndex(r => String(r.id) === String(editId));
        if (idx !== -1) holdingsRows[idx] = record;
    } else {
        holdingsRows.push(record);
    }

    clearHoldingsForm();
    renderHoldingsDatalists();
    document.getElementById('holdings-list-status').textContent =
        `${holdingsRows.length}件（未保存の変更があります。「保存」を押すとGitHubへ反映されます）。`;
});

document.getElementById('holdings-delete-btn')?.addEventListener('click', () => {
    const editId = document.getElementById('holdings-edit-id').value;
    if (!editId) { alert('削除する行を一覧から選択してください'); return; }
    if (!confirm('選択中の保有銘柄を削除します。よろしいですか？（この時点ではGitHubへは反映されません。反映するには「保存」を押してください）')) return;

    holdingsRows = holdingsRows.filter(r => String(r.id) !== String(editId));
    clearHoldingsForm();
    renderHoldingsDatalists();
    document.getElementById('holdings-list-status').textContent =
        `${holdingsRows.length}件（未保存の変更があります。「保存」を押すとGitHubへ反映されます）。`;
});

document.getElementById('holdings-save-btn')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('holdings-save-status');
    const token = getDataTokenValue();
    if (!token) { alert('PWを入力してください'); return; }
    if (!holdingsLoaded) { alert('先に一覧の「読込」を押してから保存してください（既存データを取りこぼして上書きするのを防ぐため）'); return; }

    statusEl.textContent = '保存中...';

    try {
        const content = stringifyCsv(holdingsRows, HOLDINGS_HEADERS);
        await commitFile(token, OWNER, DATA_REPO, HOLDINGS_PATH, DATA_REPO_BRANCH, content, 'chore: 保有銘柄を更新');
        statusEl.textContent = `保存しました（${holdingsRows.length}件）。`;
        document.getElementById('holdings-list-status').textContent = `${holdingsRows.length}件を読み込みました。`;
    } catch (error) {
        console.error(error);
        statusEl.textContent = `保存に失敗しました: ${error.message}`;
    }
});
