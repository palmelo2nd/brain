import { loadToken, saveToken, loadCache, saveCache } from './modules/storage.js';
import { fetchFile, saveFile } from './modules/github.js';
import { parseMarkdown, stringifyMarkdown, MAIN_DATA_COLUMNS, MASTER_DATA_COLUMNS } from './modules/task.js';
import { exportToExcel, importFromExcel } from './modules/excel.js';

const OWNER = 'palmelo2nd';
const REPO  = 'brain_data';
const PATH  = 'todo.md';

// ===== グローバル状態 =====
let currentSha        = null;
let currentMainData   = [];
let currentMasterData = [];
let currentPage       = 'dashboard';
let currentCategory   = 'すべて';        // カテゴリフィルタの選択値
let selectedInboxIds  = new Set();       // INBOXトリアージで選択中の行ID

// ===== 初期化 =====
window.addEventListener('DOMContentLoaded', () => {
    const saved = loadToken();
    if (saved) document.getElementById('token-input').value = saved;
    switchPage('dashboard');
});

// ===== ページ切り替え =====

/**
 * 指定ページを表示し、ナビボタンのアクティブ状態を更新してレンダラーを呼ぶ。
 */
function switchPage(pageId) {
    document.querySelectorAll('.page').forEach(el    => el.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));

    document.getElementById(`page-${pageId}`).classList.add('active');
    document.querySelector(`.nav-btn[data-page="${pageId}"]`).classList.add('active');

    currentPage = pageId;
    renderPage(pageId);
}

// ナビボタン全件にクリックリスナーを登録
document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchPage(btn.dataset.page));
});

// ===== ページレンダラー =====

/** 現在ページに対応するレンダラーをディスパッチする。 */
function renderPage(pageId) {
    const renderers = {
        dashboard: renderDashboard,
        inbox:     renderInbox,
        task:      renderTaskList,
        knowledge: renderKnowledge,
        master:    renderMaster,
    };
    renderers[pageId]?.();
}

// --- ページレンダラー ---
function renderDashboard() {
    renderWarnings(computeMasterWarnings());
    // カテゴリバッジを現在の選択値に同期
    const badge = document.getElementById('inbox-category-badge');
    if (badge) {
        badge.textContent = currentCategory === 'すべて'
            ? 'カテゴリ: 未設定（「すべて」選択中）'
            : `カテゴリ: ${currentCategory}`;
    }
}
function renderInbox() {
    renderInboxList();
    updateTriageForm();
    renderRecentItems();
}
function renderTaskList()  { console.log('[render] task', { mainData: currentMainData }); }
function renderKnowledge() { console.log('[render] knowledge'); }
function renderMaster() {
    renderWarnings(computeMasterWarnings());
    renderMasterEditTable();
    renderDataTable('table-main',   'summary-main',   currentMainData,   MAIN_DATA_COLUMNS,   'メインデータ');
    renderDataTable('table-master', 'summary-master', currentMasterData, MASTER_DATA_COLUMNS, 'マスタデータ');
}

/**
 * 指定テーブルをデータ配列で描画し、サマリーに件数バッジを更新する。
 * @param {string} tableId    - 描画先 <table> の id
 * @param {string} summaryId  - 件数を表示する <summary> の id
 * @param {Array}  data       - 行データの配列
 * @param {Array}  columns    - 表示列名の配列（MAIN_DATA_COLUMNS / MASTER_DATA_COLUMNS）
 * @param {string} label      - サマリー表示名
 */
function renderDataTable(tableId, summaryId, data, columns, label) {
    // ---- サマリーの件数バッジを更新 ----
    const summaryEl = document.getElementById(summaryId);
    if (summaryEl) {
        summaryEl.innerHTML =
            `${label} 一覧<span class="expander-count">${data.length} 件</span>`;
    }

    const table = document.getElementById(tableId);
    if (!table) return;

    table.className = 'data-table';

    // ---- ヘッダー行 ----
    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    columns.forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    // ---- データ行 ----
    const tbody = document.createElement('tbody');
    if (data.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan   = columns.length;
        td.className = 'empty-cell';
        td.textContent = 'データがありません。GitHubから読み込んでください。';
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        data.forEach(row => {
            const tr = document.createElement('tr');
            columns.forEach(col => {
                const td = document.createElement('td');
                td.textContent = row[col] ?? '';
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
    }

    table.replaceChildren(thead, tbody);
}

// ===== 情報整理ページ =====

/** INBOXトリアージのテーブル（データ区分===INBOXの行）を描画する。 */
function renderInboxList() {
    const COLS      = ['ID', 'カテゴリ', 'タイトル', '内容', '作成日時'];
    const inboxRows = currentMainData.filter(r => r['データ区分'] === 'INBOX');

    const summaryEl = document.getElementById('summary-inbox-triage');
    if (summaryEl) {
        summaryEl.innerHTML =
            `INBOXトリアージ<span class="expander-count">${inboxRows.length} 件</span>`;
    }

    const table = document.getElementById('table-inbox-list');
    if (!table) return;
    table.className = 'data-table';

    // ヘッダー（全選択チェックボックス付き）
    const thead   = document.createElement('thead');
    const hRow    = document.createElement('tr');
    const thCheck = document.createElement('th');
    thCheck.style.width = '36px';
    const checkAll = document.createElement('input');
    checkAll.type  = 'checkbox';
    checkAll.title = '全選択';
    checkAll.addEventListener('change', e => {
        table.querySelectorAll('tbody input[type="checkbox"]').forEach(cb => {
            cb.checked = e.target.checked;
            const tr   = cb.closest('tr');
            if (e.target.checked) {
                selectedInboxIds.add(cb.value);
                tr.classList.add('selected-row');
            } else {
                selectedInboxIds.delete(cb.value);
                tr.classList.remove('selected-row');
            }
        });
        updateTriageSelectionInfo();
        prefillTriageForm();
    });
    thCheck.appendChild(checkAll);
    hRow.appendChild(thCheck);
    COLS.forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    // ボディ
    const tbody = document.createElement('tbody');
    if (inboxRows.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan     = COLS.length + 1;
        td.className   = 'empty-cell';
        td.textContent = 'INBOXにデータはありません';
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        inboxRows.forEach(row => {
            const id  = String(row['ID']);
            const tr  = document.createElement('tr');
            if (selectedInboxIds.has(id)) tr.classList.add('selected-row');

            const tdCheck = document.createElement('td');
            tdCheck.style.textAlign = 'center';
            const cb    = document.createElement('input');
            cb.type     = 'checkbox';
            cb.value    = id;
            cb.checked  = selectedInboxIds.has(id);
            cb.addEventListener('change', () => {
                if (cb.checked) { selectedInboxIds.add(id);    tr.classList.add('selected-row'); }
                else            { selectedInboxIds.delete(id); tr.classList.remove('selected-row'); }
                updateTriageSelectionInfo();
                prefillTriageForm();
            });
            tdCheck.appendChild(cb);
            tr.appendChild(tdCheck);

            COLS.forEach(col => {
                const td  = document.createElement('td');
                let   val = row[col] ?? '';
                if (col === '内容' && val.length > 50) val = val.slice(0, 50) + '…';
                td.textContent = val;
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });

        // 全選択チェックボックスの状態を同期
        checkAll.checked = inboxRows.every(r => selectedInboxIds.has(String(r['ID'])));
    }

    table.replaceChildren(thead, tbody);
    updateTriageSelectionInfo();
}

/** 振り分けフォームのドロップダウンをマスタデータで再構築する。 */
function updateTriageForm() {
    // データ区分 --- masterData の (M)データ区分 列
    const kubunEl = document.getElementById('triage-kubun');
    if (kubunEl) {
        const options = [...new Set(
            currentMasterData.map(r => r['(M)データ区分']).filter(Boolean)
        )];
        kubunEl.innerHTML = '<option value="">（選択してください）</option>';
        options.forEach(v => {
            const o = document.createElement('option');
            o.value = o.textContent = v;
            kubunEl.appendChild(o);
        });
    }

    // タグ --- カテゴリフィルタを適用
    const tagEl = document.getElementById('triage-tag');
    if (tagEl) {
        tagEl.innerHTML = '<option value="">（未設定）</option>';
        getFilteredTags().forEach(v => {
            const o = document.createElement('option');
            o.value = o.textContent = v;
            tagEl.appendChild(o);
        });
    }

    // ハブ --- カテゴリフィルタを適用
    const hubEl = document.getElementById('triage-hub');
    if (hubEl) {
        hubEl.innerHTML = '<option value="">（未設定）</option>';
        getFilteredHubs().forEach(v => {
            const o = document.createElement('option');
            o.value = o.textContent = v;
            hubEl.appendChild(o);
        });
    }

    updateTriageSelectionInfo();
}

/** 選択件数のバッジテキストを更新する。 */
function updateTriageSelectionInfo() {
    const el = document.getElementById('triage-selection-info');
    if (!el) return;
    el.textContent = selectedInboxIds.size === 0
        ? '行を選択してください'
        : `${selectedInboxIds.size} 件選択中`;
}

/** 1件だけ選択されている場合にフォームへ現在値を自動入力する。 */
function prefillTriageForm() {
    if (selectedInboxIds.size !== 1) {
        document.getElementById('triage-title').value = '';
        document.getElementById('triage-biko').value  = '';
        return;
    }
    const row = currentMainData.find(r => String(r['ID']) === [...selectedInboxIds][0]);
    if (!row) return;
    document.getElementById('triage-title').value = row['タイトル'] ?? '';
    document.getElementById('triage-biko').value  = row['備考']     ?? '';
}

/** 更新日時が新しい順に最大10件を表示する。 */
function renderRecentItems() {
    const COLS    = ['ID', 'データ区分', 'カテゴリ', 'タイトル', '内容', 'タグ', 'ハブ', '更新日時'];
    const recent  = [...currentMainData]
        .filter(r => r['更新日時'])
        .sort((a, b) => (b['更新日時'] ?? '').localeCompare(a['更新日時'] ?? ''))
        .slice(0, 10);

    const summaryEl = document.getElementById('summary-recent');
    if (summaryEl) {
        summaryEl.innerHTML =
            `直近の更新データ<span class="expander-count">最新 ${recent.length} 件</span>`;
    }

    const table = document.getElementById('table-recent');
    if (!table) return;
    table.className = 'data-table';

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    COLS.forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    if (recent.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan     = COLS.length;
        td.className   = 'empty-cell';
        td.textContent = 'データがありません';
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        recent.forEach(row => {
            const tr = document.createElement('tr');
            COLS.forEach(col => {
                const td  = document.createElement('td');
                let   val = row[col] ?? '';
                if (col === '内容' && val.length > 40) val = val.slice(0, 40) + '…';
                td.textContent = val;
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
    }

    table.replaceChildren(thead, tbody);
}

/** 「振り分け実行」ボタン: 選択行にフォームの値を適用し更新日時を押す。 */
document.getElementById('triage-apply-btn').addEventListener('click', () => {
    if (selectedInboxIds.size === 0) { alert('振り分ける行を選択してください'); return; }

    const kubun = document.getElementById('triage-kubun').value;
    if (!kubun) { alert('データ区分を選択してください'); return; }

    const title = document.getElementById('triage-title').value.trim();
    const biko  = document.getElementById('triage-biko').value.trim();
    const tag   = document.getElementById('triage-tag').value;
    const hub   = document.getElementById('triage-hub').value;

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts  = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} `
              + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    selectedInboxIds.forEach(id => {
        const row = currentMainData.find(r => String(r['ID']) === id);
        if (!row) return;
        row['データ区分'] = kubun;
        row['更新日時']   = ts;
        if (title) row['タイトル'] = title;
        if (biko)  row['備考']     = biko;
        if (tag)   row['タグ']     = tag;
        if (hub)   row['ハブ']     = hub;
    });

    selectedInboxIds.clear();
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
    renderInbox();
});

// ===== マスタ管理 =====

// 編集対象の3列
const EDIT_COLS = ['(M)変数名', '(M)変数分類', '(M)変数説明'];

/**
 * MAIN_DATA_COLUMNS と currentMasterData を照合して警告リストを返す。
 * - MAIN_DATA_COLUMNSにあるがmasterData未登録の変数
 * - masterDataにあるがMAIN_DATA_COLUMNSに存在しない変数名
 * - (M)変数名/(M)変数分類/(M)変数説明のいずれかが空の行
 */
function computeMasterWarnings() {
    const warnings = [];
    // メイン・マスタ両方の列名を対象にする
    const ALL_COLUMNS = [...MAIN_DATA_COLUMNS, ...MASTER_DATA_COLUMNS];
    const registered  = currentMasterData.map(r => r['(M)変数名']).filter(Boolean);

    const unregistered = ALL_COLUMNS.filter(col => !registered.includes(col));
    if (unregistered.length > 0) {
        warnings.push(`マスタ未登録の変数が ${unregistered.length} 件あります（例: ${unregistered[0]}）`);
    }

    const invalid = registered.filter(name => !ALL_COLUMNS.includes(name));
    if (invalid.length > 0) {
        warnings.push(`存在しない変数名が ${invalid.length} 件あります（例: ${invalid[0]}）`);
    }

    const incomplete = currentMasterData.filter(r =>
        !r['(M)変数名'] || !r['(M)変数分類'] || !r['(M)変数説明']
    );
    if (incomplete.length > 0) {
        warnings.push(`未入力の項目がある行が ${incomplete.length} 件あります`);
    }

    return warnings;
}

/** マスタ管理ページとダッシュボードの両方に警告バナーを描画する。 */
function renderWarnings(warnings) {
    const masterEl = document.getElementById('master-warning');
    if (masterEl) {
        masterEl.innerHTML = warnings.length > 0
            ? `<p class="warning-text">⚠ ${warnings.join('　/　')}</p>`
            : '<p class="warning-ok">✓ マスタデータに問題はありません</p>';
    }

    const dashEl = document.getElementById('dashboard-warning');
    if (dashEl) {
        dashEl.innerHTML = warnings.length > 0
            ? `<p class="warning-text">⚠ ${warnings.join('　/　')}</p>`
            : '';
    }
}

/** 変数定義の編集テーブル（EDIT_COLS 3列 + 操作列）を描画する。 */
function renderMasterEditTable() {
    const summaryEl = document.getElementById('summary-edit');
    if (summaryEl) {
        summaryEl.innerHTML =
            `変数定義の編集<span class="expander-count">${currentMasterData.length} 件</span>`;
    }

    const table = document.getElementById('table-edit-master');
    if (!table) return;
    table.className = 'data-table edit-table';

    // ヘッダー
    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    const thCtrl = document.createElement('th');
    thCtrl.textContent = '操作';
    thCtrl.className   = 'col-ctrl';
    hRow.appendChild(thCtrl);
    EDIT_COLS.forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    // ボディ
    const tbody = document.createElement('tbody');
    if (currentMasterData.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan     = EDIT_COLS.length + 1;
        td.className   = 'empty-cell';
        td.textContent = 'データがありません。GitHubから読み込んでください。';
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        currentMasterData.forEach((row, idx) => {
            tbody.appendChild(buildEditRow(row, idx, currentMasterData.length));
        });
    }

    table.replaceChildren(thead, tbody);
}

/** 編集テーブルの1行（↑↓ボタン + input 3つ）を生成して返す。 */
function buildEditRow(row, idx, total) {
    const tr = document.createElement('tr');
    tr.dataset.idx = idx;

    // 操作列
    const tdCtrl  = document.createElement('td');
    tdCtrl.className = 'col-ctrl';

    const btnUp   = document.createElement('button');
    btnUp.textContent = '↑';
    btnUp.className   = 'row-move-btn';
    btnUp.disabled    = (idx === 0);
    btnUp.addEventListener('click', () => moveMasterRow(idx, -1));

    const btnDown = document.createElement('button');
    btnDown.textContent = '↓';
    btnDown.className   = 'row-move-btn';
    btnDown.disabled    = (idx === total - 1);
    btnDown.addEventListener('click', () => moveMasterRow(idx, +1));

    tdCtrl.append(btnUp, btnDown);
    tr.appendChild(tdCtrl);

    // 編集列
    EDIT_COLS.forEach(col => {
        const td    = document.createElement('td');
        const input = document.createElement('input');
        input.type        = 'text';
        input.value       = row[col] ?? '';
        input.className   = 'edit-input';
        input.dataset.col = col;
        td.appendChild(input);
        tr.appendChild(td);
    });

    return tr;
}

/** ↑↓ボタン押下: 現在のinput値を状態に保存してから行を入れ替え、再描画する。 */
function moveMasterRow(idx, dir) {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= currentMasterData.length) return;

    applyMasterEditsToState();
    [currentMasterData[idx], currentMasterData[newIdx]] =
        [currentMasterData[newIdx], currentMasterData[idx]];
    renderMasterEditTable();
}

/** 編集テーブルのinput値を currentMasterData に書き戻す（DOM → state）。 */
function applyMasterEditsToState() {
    document.querySelectorAll('#table-edit-master tbody tr[data-idx]').forEach(tr => {
        const idx = parseInt(tr.dataset.idx, 10);
        if (isNaN(idx) || !currentMasterData[idx]) return;
        EDIT_COLS.forEach(col => {
            const input = tr.querySelector(`input[data-col="${col}"]`);
            if (input) currentMasterData[idx][col] = input.value;
        });
    });
}

/** 「変更を適用する」ボタン: stateを更新 → 警告・ビューテーブル・編集テーブルを再描画。 */
function applyMasterEdits() {
    applyMasterEditsToState();
    renderWarnings(computeMasterWarnings());
    renderDataTable('table-master', 'summary-master', currentMasterData, MASTER_DATA_COLUMNS, 'マスタデータ');
    renderMasterEditTable();
}

document.getElementById('apply-master-btn').addEventListener('click', applyMasterEdits);

// ===== データ読み込みヘルパー =====

/**
 * Markdownテキストを受け取り、グローバル状態を更新して現在ページを再描画する。
 */
function applyContent(content, sha) {
    currentSha = sha;
    const { mainData, masterData } = parseMarkdown(content);
    currentMainData   = mainData;
    currentMasterData = masterData;
    renderCategoryFilter();   // データ更新時にカテゴリ一覧を再構築
    renderPage(currentPage);
}

// ===== GitHubから読み込み =====
document.getElementById('load-btn').addEventListener('click', async () => {
    const token      = document.getElementById('token-input').value.trim();
    const contentBox = document.getElementById('content-box');
    const statusEl   = document.getElementById('network-status');

    if (!token) return alert('トークンを入力してください');
    saveToken(token);
    contentBox.textContent = '読み込み中...';

    try {
        const { content, sha } = await fetchFile(token, OWNER, REPO, PATH);
        applyContent(content, sha);
        saveCache(content, sha);
        statusEl.innerHTML   = '<span class="status-badge online-badge">オンライン（最新）</span>';
        contentBox.innerHTML = window.marked.parse(content);
    } catch (error) {
        console.error(error);
        const cached = loadCache();
        if (cached) {
            applyContent(cached.content, cached.sha);
            statusEl.innerHTML   = '<span class="status-badge offline-badge">オフライン（端末内データ）</span>';
            contentBox.innerHTML = window.marked.parse(cached.content);
            alert('通信できませんでした。スマホ内に一時保存されている前回のデータを表示します。');
        } else {
            contentBox.textContent = `エラー: ${error.message}（端末内にキャッシュもありません）`;
        }
    }
});

// ===== GitHubへ保存 =====
document.getElementById('save-btn').addEventListener('click', async () => {
    const token      = document.getElementById('token-input').value.trim();
    const contentBox = document.getElementById('content-box');
    const statusEl   = document.getElementById('network-status');

    if (!token)      return alert('トークンを入力してください');
    if (!currentSha) return alert('先にデータを読み込んでください（またはオフラインキャッシュを読み込んでください）');

    // 構造化データあり → Front Matter Markdown / なし → チェックボックスDOM読み取り（後方互換）
    const newMarkdown = currentMainData.length > 0
        ? stringifyMarkdown(currentMainData, currentMasterData)
        : buildMarkdownFromDOM(contentBox);

    saveCache(newMarkdown, currentSha);
    contentBox.textContent = 'GitHubへ保存中...';

    try {
        const { newSha } = await saveFile(token, OWNER, REPO, PATH, newMarkdown, currentSha);
        currentSha = newSha;
        saveCache(newMarkdown, newSha);
        statusEl.innerHTML   = '<span class="status-badge online-badge">オンライン（同期完了）</span>';
        contentBox.innerHTML = window.marked.parse(newMarkdown);
        alert('GitHubへの保存が成功しました！');
    } catch (error) {
        console.error(error);
        statusEl.innerHTML   = '<span class="status-badge offline-badge">未同期の変更あり</span>';
        contentBox.innerHTML = window.marked.parse(newMarkdown);
        alert('現在通信ができません。変更はスマホ内に一時保存されました。電波の良い場所に移動してから、再度「GitHubへ保存する」を押して同期してください。');
    }
});

// ===== Excelエクスポート =====
document.getElementById('excel-export-btn').addEventListener('click', () => {
    if (currentMainData.length === 0 && currentMasterData.length === 0) {
        return alert('エクスポートするデータがありません。先にGitHubからデータを読み込んでください。');
    }
    exportToExcel(currentMainData, currentMasterData);
});

// ===== Excelインポート =====
document.getElementById('excel-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const token      = document.getElementById('token-input').value.trim();
    const contentBox = document.getElementById('content-box');
    const statusEl   = document.getElementById('network-status');

    const { mainData, masterData } = await importFromExcel(file);
    currentMainData   = mainData;
    currentMasterData = masterData;

    const newMarkdown = stringifyMarkdown(mainData, masterData);
    saveCache(newMarkdown, currentSha);
    e.target.value = ''; // 同一ファイルの再インポートを可能にするためリセット

    if (token && currentSha) {
        contentBox.textContent = 'GitHubへ保存中...';
        try {
            const { newSha } = await saveFile(token, OWNER, REPO, PATH, newMarkdown, currentSha);
            currentSha = newSha;
            saveCache(newMarkdown, newSha);
            statusEl.innerHTML   = '<span class="status-badge online-badge">オンライン（同期完了）</span>';
            contentBox.innerHTML = window.marked.parse(newMarkdown);
            alert('Excelのインポートとデータ保存が完了しました！');
        } catch (error) {
            console.error(error);
            statusEl.innerHTML   = '<span class="status-badge offline-badge">未同期の変更あり</span>';
            contentBox.innerHTML = window.marked.parse(newMarkdown);
            alert('インポートデータを端末内に保存しました。「GitHubへ保存する」で同期してください。');
        }
    } else {
        statusEl.innerHTML   = '<span class="status-badge offline-badge">端末内に保存済み（未同期）</span>';
        contentBox.innerHTML = window.marked.parse(newMarkdown);
        alert('インポートデータを端末内に保存しました。GitHubへ同期するには、トークンを入力して読み込んでから再度インポートしてください。');
    }
});

// ===== INBOX 登録 =====

document.getElementById('inbox-submit-btn').addEventListener('click', () => {
    const textarea = document.getElementById('inbox-content');
    const content  = textarea.value.trim();
    if (!content) { textarea.focus(); return; }

    // IDの自動採番: 既存の最大ID + 1（IDが未設定の場合は1から開始）
    const maxId = currentMainData.reduce((max, row) => {
        const id = parseInt(row['ID'], 10);
        return isNaN(id) ? max : Math.max(max, id);
    }, 0);

    // タイムスタンプ: YYYY/MM/DD HH:mm:ss
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts  = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} `
              + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    // 全カラムを空文字で初期化してから必要な値だけ設定
    const entry = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
    entry['ID']        = String(maxId + 1);
    entry['データ区分'] = 'INBOX';
    entry['内容']       = content;
    entry['作成日時']   = ts;
    entry['更新日時']   = ts;
    entry['カテゴリ']   = currentCategory === 'すべて' ? '' : currentCategory;

    currentMainData.push(entry);

    // LocalStorage に自動保存（GitHub push 前の安全網）
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);

    textarea.value = '';
    textarea.focus();
    renderDashboard(); // カテゴリバッジ等を再描画
});

// ===== カテゴリフィルタ =====

/**
 * masterData の (M)カテゴリ 列から一意のカテゴリ一覧を取得し、
 * サイドバーにラジオボタンとして描画する。
 * データ未読み込み時は「すべて」のみ表示する。
 */
function renderCategoryFilter() {
    const container = document.getElementById('category-list');
    if (!container) return;

    // (M)カテゴリ列から重複なしで一覧を生成
    const categories = [...new Set(
        currentMasterData.map(r => r['(M)カテゴリ']).filter(Boolean)
    )];

    container.innerHTML = '';

    ['すべて', ...categories].forEach(cat => {
        const label = document.createElement('label');
        label.className = 'category-radio-label' + (cat === currentCategory ? ' active' : '');

        const input  = document.createElement('input');
        input.type   = 'radio';
        input.name   = 'category-filter';
        input.value  = cat;
        input.checked = (cat === currentCategory);

        input.addEventListener('change', () => {
            currentCategory = cat;
            container.querySelectorAll('.category-radio-label')
                     .forEach(l => l.classList.remove('active'));
            label.classList.add('active');
            renderPage(currentPage);
        });

        label.append(input, document.createTextNode(cat));
        container.appendChild(label);
    });
}

/**
 * 選択中のカテゴリに属するタグ名一覧を返す。
 * 「すべて」選択時は (M)タグ_子 の全値を返す。
 * それ以外は (M)タグ_親 === currentCategory の行の (M)タグ_子 を返す。
 * @returns {string[]}
 */
export function getFilteredTags() {
    if (currentCategory === 'すべて') {
        return [...new Set(currentMasterData.map(r => r['(M)タグ_子']).filter(Boolean))];
    }
    return currentMasterData
        .filter(r => r['(M)タグ_親'] === currentCategory)
        .map(r => r['(M)タグ_子'])
        .filter(Boolean);
}

/**
 * 選択中のカテゴリに属するハブ名一覧を返す。
 * 「すべて」選択時は (M)ハブ_子 の全値を返す。
 * それ以外は (M)ハブ_親 === currentCategory の行の (M)ハブ_子 を返す。
 * @returns {string[]}
 */
export function getFilteredHubs() {
    if (currentCategory === 'すべて') {
        return [...new Set(currentMasterData.map(r => r['(M)ハブ_子']).filter(Boolean))];
    }
    return currentMasterData
        .filter(r => r['(M)ハブ_親'] === currentCategory)
        .map(r => r['(M)ハブ_子'])
        .filter(Boolean);
}

// ===== 旧フォーマット用ヘルパー =====
// Front Matterなしのシンプルなtodo.mdに対し、チェックボックスDOM状態からMarkdownを再構築する
function buildMarkdownFromDOM(contentBox) {
    let markdown = '# タスク一覧\n\n';
    contentBox.querySelectorAll('li').forEach(li => {
        const checkbox = li.querySelector('input[type="checkbox"]');
        const text     = li.textContent.trim();
        markdown += checkbox && checkbox.checked ? `- [x] ${text}\n` : `- [ ] ${text}\n`;
    });
    return markdown;
}
