import { loadToken, saveToken } from './modules/storage.js';
import { dispatchWorkflow } from './modules/github.js';

const OWNER              = 'palmelo2nd';
const CODE_REPO          = 'brain';   // ワークフローファイルが置かれているコードリポジトリ
const CODE_REPO_BRANCH   = 'main';
const PRICE_WORKFLOW_FILE = 'fetch-stock-prices.yml';

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
    const codeInput   = document.getElementById('price-update-code');
    const periodInput = document.getElementById('price-update-period');

    const token  = getTokenValue();
    const code   = codeInput.value.trim();
    const period = periodInput.value.trim() || '5d';

    if (!token) { alert('PWを入力してください'); return; }
    if (!code)  { alert('証券コードを入力してください'); return; }

    statusEl.textContent = '実行をリクエスト中...';

    try {
        await dispatchWorkflow(token, OWNER, CODE_REPO, PRICE_WORKFLOW_FILE, CODE_REPO_BRANCH, { code, period });
        statusEl.textContent =
            `実行をリクエストしました（コード: ${code} / 期間: ${period}）。` +
            `数十秒〜数分後にデータリポジトリの stock/prices/${code}.csv が更新されます。` +
            `GitHubの Actions タブから進捗を確認できます。`;
    } catch (error) {
        console.error(error);
        statusEl.textContent = `失敗しました: ${error.message}`;
    }
});
