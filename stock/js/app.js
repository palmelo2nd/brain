import { loadIdToken, saveIdToken, loadPwToken, savePwToken } from './modules/storage.js';
import { dispatchWorkflow, fetchFile, fetchFileIfExists, commitFile, listFilesRecursive } from './modules/github.js';
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

// ===== データ更新：データ鮮度チェック（check_freshness.py）のGitHub Actionsワークフローを起動 =====
document.getElementById('freshness-run-btn')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('freshness-status');
    const token = getCodeTokenValue();
    if (!token) { alert('IDを入力してください'); return; }

    statusEl.textContent = '実行をリクエスト中...';

    try {
        await dispatchWorkflow(token, OWNER, CODE_REPO, FRESHNESS_WORKFLOW_FILE, CODE_REPO_BRANCH, {});
        statusEl.textContent =
            `鮮度チェックの実行をリクエストしました。数分後にデータリポジトリの ${FRESHNESS_REPORT_PATH} が更新されます。` +
            `完了後「結果を確認」で表示できます。`;
    } catch (error) {
        console.error(error);
        statusEl.textContent = `失敗しました: ${error.message}`;
    }
});

// ===== データ更新：データ鮮度チェックの結果（freshness_report.json）を取得して表示 =====
document.getElementById('freshness-check-btn')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('freshness-status');
    const token = getDataTokenValue();
    if (!token) { alert('PWを入力してください'); return; }

    statusEl.textContent = '確認中...';

    try {
        const reportText = await fetchFile(token, OWNER, DATA_REPO, FRESHNESS_REPORT_PATH);
        const report = JSON.parse(reportText);

        statusEl.textContent =
            `チェック日時: ${report.checked_at} / 対象: ${report.total_files}銘柄 / ` +
            `全体の最新日付: ${report.latest_date} / ` +
            `最も遅れている銘柄: ${report.oldest_last_date_code}（${report.oldest_last_date}） / ` +
            `要更新（${report.stale_days}日超過）: ${report.stale_count}件`;
    } catch (error) {
        console.error(error);
        statusEl.textContent = `確認に失敗しました: ${error.message}`;
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
