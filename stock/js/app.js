import { loadIdToken, saveIdToken, loadPwToken, savePwToken } from './modules/storage.js';
import {
    dispatchWorkflow, fetchFile, fetchFileIfExists, commitFile, listFilesRecursive,
    getLatestWorkflowRun, getWorkflowRun, getLatestCommit
} from './modules/github.js';
import { parseCsv } from './modules/csv.js';

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
const VALIDATION_EXCEPTIONS_PATH = 'stock/validation_exceptions.json'; // 承認済み例外（次回のvalidate_prices.py実行時にスキップされる問題）
const FRESHNESS_REPORT_PATH  = 'stock/freshness_report.json';
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

const STOCK_VIEWS = ['dashboard', 'holdings', 'dataupdate', 'attributes', 'score', 'suggest'];

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
// ワークフロー自体はGitHub側で継続するので、再度開いて「状態を更新」を押せば結果は確認できる）。

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
                '前回の「最新株価に更新」がまだ実行中の可能性があります。\n' +
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
    if (!token) { summaryEl.textContent = 'PWを入力し「状態を更新」を押してください。'; return; }

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

        // 品質チェック（欠損・重複等）の問題件数。詳細は詳細設定の「データ品質チェック」で確認・対処する。
        const qualityP = document.createElement('p');
        if (!validation) {
            qualityP.textContent = '品質チェック: 未実行です（詳細設定から実行できます）';
        } else if (validation.issue_count > 0) {
            qualityP.textContent =
                `品質チェック（${validation.checked_at}時点）: 問題 ${validation.issue_count}件` +
                `（詳細設定の「データ品質チェック」で確認できます）`;
            qualityP.classList.add('status-line--warning');
        } else {
            qualityP.textContent = `品質チェック（${validation.checked_at}時点）: 問題なし`;
        }
        lines.appendChild(qualityP);

        summaryEl.appendChild(lines);

        // 銘柄ごとの最終日付の分布（新しい日付が上に来るように降順）。
        // 大半が最新日付に揃っていれば正常、古い日付に銘柄が散っていれば取りこぼしがあると分かる。
        if (report.distribution) {
            const entries = Object.entries(report.distribution).sort((a, b) => b[0].localeCompare(a[0]));
            const list = document.createElement('ul');
            list.className = 'status-distribution';
            entries.forEach(([date, count]) => {
                const li = document.createElement('li');
                li.textContent = `${date}: ${count}銘柄`;
                list.appendChild(li);
            });
            summaryEl.appendChild(list);
        }
    } catch (error) {
        console.error(error);
        summaryEl.textContent = `状態の取得に失敗しました: ${error.message}`;
    }
}

document.getElementById('status-refresh-btn')?.addEventListener('click', () => loadFreshnessStatus());

// ===== データ更新：データ鮮度チェック（check_freshness.py）のGitHub Actionsワークフローを再実行 =====
document.getElementById('status-recheck-btn')?.addEventListener('click', async () => {
    const summaryEl = document.getElementById('status-summary');
    const token = getCodeTokenValue();
    if (!token) { alert('IDを入力してください'); return; }

    summaryEl.textContent = '鮮度チェックの実行をリクエスト中...';

    try {
        await dispatchWorkflow(token, OWNER, CODE_REPO, FRESHNESS_WORKFLOW_FILE, CODE_REPO_BRANCH, {});
        summaryEl.textContent = `鮮度チェックの実行をリクエストしました。数分後に「状態を更新」を押すと最新の結果を確認できます。`;
    } catch (error) {
        console.error(error);
        summaryEl.textContent = `失敗しました: ${error.message}`;
    }
});

// ===== データ更新：データ品質チェック（validate_prices.py）のGitHub Actionsワークフローを起動 =====
document.getElementById('validate-run-btn')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('validate-status');
    const token = getCodeTokenValue();
    if (!token) { alert('IDを入力してください'); return; }

    statusEl.textContent = '実行をリクエスト中...';

    try {
        await dispatchWorkflow(token, OWNER, CODE_REPO, VALIDATE_WORKFLOW_FILE, CODE_REPO_BRANCH, {});
        statusEl.textContent =
            `チェックの実行をリクエストしました。数分後にデータリポジトリの ${VALIDATION_REPORT_PATH} が更新されます。` +
            `完了後「結果を確認」で表示できます。`;
    } catch (error) {
        console.error(error);
        statusEl.textContent = `失敗しました: ${error.message}`;
    }
});

// ===== データ更新：データ品質チェックの結果（validation_report.json）を取得して表示 =====
document.getElementById('validate-check-btn')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('validate-status');
    const reportEl = document.getElementById('validate-report');
    const token = getDataTokenValue();
    if (!token) { alert('PWを入力してください'); return; }

    statusEl.textContent = '確認中...';
    reportEl.innerHTML = '';

    try {
        const reportText = await fetchFile(token, OWNER, DATA_REPO, VALIDATION_REPORT_PATH);
        const report = JSON.parse(reportText);

        statusEl.textContent =
            `チェック日時: ${report.checked_at} / 対象: ${report.total_files}銘柄 / 問題: ${report.issue_count}件`;

        if (report.issue_count > 0) {
            // 検出された銘柄コード（重複除去）をまとめて再取得するボタン。2013年以降の全期間を取得し直すことで、
            // 差分更新（末尾への追記のみ）では直せない途中の欠損・終値空欄・重複日付なども穴埋めする。
            const issueCodes = Array.from(new Set(report.issues.map(issue => issue.code)));
            const refetchBar = document.createElement('div');
            refetchBar.className = 'validate-refetch-bar';
            const refetchBtn = document.createElement('button');
            refetchBtn.type = 'button';
            refetchBtn.className = 'run-btn';
            refetchBtn.textContent = `検出銘柄${issueCodes.length}件をまとめて再取得`;
            refetchBtn.addEventListener('click', () => refetchIssueCodes(issueCodes, refetchBtn));
            refetchBar.appendChild(refetchBtn);
            reportEl.appendChild(refetchBar);

            // 同一内容（type+detail）の問題は銘柄をまたいで多発しやすい（例: 特定期間の連休による欠損）ため、
            // 件数付きのサマリーとしてまとめて表示する（個々の銘柄コードの列挙はしない）
            const groups = new Map();
            report.issues.forEach(issue => {
                const key = `${issue.type}::${issue.detail}`;
                if (!groups.has(key)) groups.set(key, { type: issue.type, detail: issue.detail, count: 0 });
                groups.get(key).count += 1;
            });
            const sortedGroups = Array.from(groups.values()).sort((a, b) => b.count - a.count);

            const list = document.createElement('ul');
            sortedGroups.forEach(group => {
                const li = document.createElement('li');
                li.className = 'validate-issue';

                const label = document.createElement('span');
                label.textContent = `${group.count}件：${group.detail}`;
                li.appendChild(label);

                // このtype+detailと完全一致する問題を「承認済み例外」として登録する（既知の連休による欠損など）。
                // 登録後は次回のvalidate_prices.py実行（GitHub Actions）からこの内容の問題が検知対象から除外される。
                const approveBtn = document.createElement('button');
                approveBtn.type = 'button';
                approveBtn.className = 'run-btn run-btn--secondary approve-btn';
                approveBtn.textContent = '承認（次回からスキップ）';
                approveBtn.addEventListener('click', () => approveIssue(token, group.type, group.detail, approveBtn));
                li.appendChild(approveBtn);

                list.appendChild(li);
            });
            reportEl.appendChild(list);
        }
    } catch (error) {
        console.error(error);
        statusEl.textContent = `確認に失敗しました: ${error.message}`;
    }
});

// データ品質チェックで検出された銘柄コードをまとめて再取得するワークフロー（fetch-stock-prices-by-codes.yml）を起動する。
// mode=fullで2013年以降の全期間を取得し直すため、差分更新では直せない途中の欠損等も穴埋めできる。
// 20件ごとに自動コミットされるワークフロー側の仕組みにより、対象が多くても途中失敗で全て失うことはない。
async function refetchIssueCodes(codes, buttonEl) {
    if (codes.length === 0) return;

    const ok = confirm(
        `${codes.length}件の銘柄を2013年以降の全期間で再取得します。\n` +
        `既知で問題ない項目（連休による欠損など）は先に「承認」しておくと対象から除外できます。\n` +
        `よろしいですか？`
    );
    if (!ok) return;

    const token = getCodeTokenValue();
    if (!token) { alert('IDを入力してください'); return; }

    buttonEl.disabled = true;
    buttonEl.textContent = '実行をリクエスト中...';

    try {
        await dispatchWorkflow(token, OWNER, CODE_REPO, PRICE_ISSUES_WORKFLOW_FILE, CODE_REPO_BRANCH, {
            codes: codes.join(','),
            mode: 'full'
        });
        buttonEl.textContent =
            `実行をリクエストしました（${codes.length}件）。20件処理するごとにデータリポジトリへ自動コミットされます。` +
            `GitHubの Actions タブから進捗を確認できます。`;
    } catch (error) {
        console.error(error);
        buttonEl.disabled = false;
        buttonEl.textContent = `検出銘柄${codes.length}件をまとめて再取得`;
        alert(`再取得の実行に失敗しました: ${error.message}`);
    }
}

// データ品質チェックの問題を「承認済み例外」（stock/validation_exceptions.json）として登録する。
// type+detailが完全一致する問題のみをスキップする（例: 特定の連休による欠損は毎回検知されてしまうため、
// 一度承認すれば以降のvalidate_prices.py実行では無視される。件数や日付が変われば別内容として再度検知される）。
async function approveIssue(token, type, detail, buttonEl) {
    buttonEl.disabled = true;
    buttonEl.textContent = '承認中...';

    try {
        const existingText = await fetchFileIfExists(token, OWNER, DATA_REPO, VALIDATION_EXCEPTIONS_PATH);
        const exceptions = existingText ? JSON.parse(existingText) : [];

        if (!exceptions.some(e => e.type === type && e.detail === detail)) {
            exceptions.push({ type, detail, approved_at: new Date().toISOString() });
            await commitFile(
                token, OWNER, DATA_REPO, VALIDATION_EXCEPTIONS_PATH, DATA_REPO_BRANCH,
                JSON.stringify(exceptions, null, 2) + '\n',
                `chore: データ品質チェックの例外を承認 (${type})`
            );
        }
        buttonEl.textContent = '承認済み';
    } catch (error) {
        console.error(error);
        buttonEl.disabled = false;
        buttonEl.textContent = '承認';
        alert(`承認に失敗しました: ${error.message}`);
    }
}
