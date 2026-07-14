import { loadToken, saveToken } from './modules/storage.js';
import { dispatchWorkflow, fetchFile, listDirectory } from './modules/github.js';
import { parseCsv } from './modules/csv.js';

const OWNER              = 'palmelo2nd';
const CODE_REPO          = 'brain';        // ワークフローファイルが置かれているコードリポジトリ
const DATA_REPO          = 'brain_data';   // 銘柄マスタ・株価データが置かれているデータリポジトリ
const CODE_REPO_BRANCH   = 'main';
const PRICE_WORKFLOW_FILE      = 'fetch-stock-prices.yml';
const PRICE_BULK_WORKFLOW_FILE = 'fetch-stock-prices-bulk.yml';
const VALIDATE_WORKFLOW_FILE   = 'validate-stock-prices.yml';
const MASTER_PATH   = 'stock/master.csv';
const PRICES_DIR    = 'stock/prices';
const VALIDATION_REPORT_PATH = 'stock/validation_report.json';
const BULK_ASSET_TYPES = ['内国株式', 'ETF・ETN']; // fetch_prices.pyの--asset-types既定値と揃えている

// ===== PW（GitHub PAT）入力欄 =====
// 一度入力すればlocalStorageに保存され、次回以降は自動的に入力済みの状態になる（brainのトークン入力と同じ仕組み）。
const pwInput = document.getElementById('pw-input');

/** 保存済みのPW（トークン）を返す。 */
export function getTokenValue() {
    return pwInput ? pwInput.value.trim() : '';
}

window.addEventListener('DOMContentLoaded', () => {
    const saved = loadToken();
    if (saved && pwInput) pwInput.value = saved;
});

pwInput?.addEventListener('input', () => {
    saveToken(pwInput.value.trim());
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

    const token  = getTokenValue();
    const codes  = codesInput.value.trim();
    const period = periodInput.value.trim(); // 空欄なら2013年以降の全期間（ワークフロー側のデフォルト）

    if (!token) { alert('PWを入力してください'); return; }
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
    const offsetInput  = document.getElementById('bulk-update-offset');
    const limitInput   = document.getElementById('bulk-update-limit');

    const token  = getTokenValue();
    const offset = offsetInput.value.trim() || '0';
    const limit  = limitInput.value.trim();

    if (!token) { alert('PWを入力してください'); return; }
    if (!limit) { alert('件数を入力してください'); return; }

    statusEl.textContent = '実行をリクエスト中...';

    try {
        await dispatchWorkflow(token, OWNER, CODE_REPO, PRICE_BULK_WORKFLOW_FILE, CODE_REPO_BRANCH, { offset, limit });
        statusEl.textContent =
            `実行をリクエストしました（開始位置: ${offset} / 件数: ${limit}）。` +
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

    const token = getTokenValue();
    if (!token) { alert('PWを入力してください'); return; }

    progressEl.textContent = '確認中...';

    try {
        const masterText = await fetchFile(token, OWNER, DATA_REPO, MASTER_PATH);
        const targetRows = parseCsv(masterText).filter(r =>
            r.status === 'listed' && BULK_ASSET_TYPES.includes(r.asset_type)
        );

        const files = await listDirectory(token, OWNER, DATA_REPO, PRICES_DIR);
        const existingCodes = new Set(
            files.filter(f => f.type === 'file' && f.name.endsWith('.csv'))
                 .map(f => f.name.replace(/\.csv$/, ''))
        );

        const doneCount = targetRows.filter(r => existingCodes.has(r.code)).length;
        const nextIndex = targetRows.findIndex(r => !existingCodes.has(r.code));

        if (nextIndex === -1) {
            progressEl.textContent = `対象 ${targetRows.length}件のうち ${doneCount}件取得済み。すべて完了しています。`;
        } else {
            if (offsetInput) offsetInput.value = nextIndex;
            progressEl.textContent =
                `対象 ${targetRows.length}件のうち ${doneCount}件取得済み。` +
                `次の開始位置候補: ${nextIndex}（自動入力しました）`;
        }
    } catch (error) {
        console.error(error);
        progressEl.textContent = `確認に失敗しました: ${error.message}`;
    }
});

// ===== データ更新：データ品質チェック（validate_prices.py）のGitHub Actionsワークフローを起動 =====
document.getElementById('validate-run-btn')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('validate-status');
    const token = getTokenValue();
    if (!token) { alert('PWを入力してください'); return; }

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
    const token = getTokenValue();
    if (!token) { alert('PWを入力してください'); return; }

    statusEl.textContent = '確認中...';
    reportEl.innerHTML = '';

    try {
        const reportText = await fetchFile(token, OWNER, DATA_REPO, VALIDATION_REPORT_PATH);
        const report = JSON.parse(reportText);

        statusEl.textContent =
            `チェック日時: ${report.checked_at} / 対象: ${report.total_files}銘柄 / 問題: ${report.issue_count}件`;

        if (report.issue_count > 0) {
            const list = document.createElement('ul');
            report.issues.forEach(issue => {
                const li = document.createElement('li');
                li.textContent = `[${issue.code}] ${issue.detail}`;
                list.appendChild(li);
            });
            reportEl.appendChild(list);
        }
    } catch (error) {
        console.error(error);
        statusEl.textContent = `確認に失敗しました: ${error.message}`;
    }
});
