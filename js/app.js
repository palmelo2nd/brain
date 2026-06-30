import { loadToken, saveToken, loadCache, saveCache } from './modules/storage.js';
import { fetchFile, saveFile } from './modules/github.js';
import { parseMarkdown, stringifyMarkdown, MAIN_DATA_COLUMNS, MASTER_DATA_COLUMNS } from './modules/dataModel.js';
import { exportToExcel, importFromExcel } from './modules/excel.js';
import { checkAndGenerateChildren, generateChildManually } from './modules/recurring.js';

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
let categoryInitialized = false;         // 初回ロード時にデフォルトカテゴリを設定済みか
let currentMasterValueType = 'kubun';   // マスタ値エディタの選択タイプ
let currentTriageKubun = 'INBOX';       // トリアージ一覧の表示対象データ区分
let triageFilters      = {};            // トリアージフィルタ値
let selectedTaskIds      = new Set();   // タスクページで選択中の行ID
let taskFilters          = {};          // タスクページのフィルタ値
let selectedKnowledgeIds = new Set();  // ナレッジページで選択中の行ID
let knowledgeFilters     = {};         // ナレッジページのフィルタ値
let selectedRunTaskId    = null;       // タスク実行で選択中のタスクID
let timerIsRunning       = false;      // タイマー動作中フラグ
let timerInterval        = null;       // setInterval ハンドル

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

// マスタ値エディタのラジオ切り替え
document.querySelectorAll('input[name="master-value-type"]').forEach(radio => {
    radio.addEventListener('change', () => {
        currentMasterValueType = radio.value;
        renderCurrentMasterValueEditor();
    });
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
    const badge = document.getElementById('inbox-category-badge');
    if (badge) {
        badge.textContent = currentCategory === 'すべて'
            ? 'カテゴリ: 未設定（「すべて」選択中）'
            : `カテゴリ: ${currentCategory}`;
    }
    renderTaskRunner();
}
function renderInbox() {
    renderDirectEntryForm();
    renderTriageKubunTabs();
    renderTriageFilters();
    renderInboxList();
    updateTriageForm();
    renderRecentItems();
}
function renderTaskList() {
    renderTaskRunner();
    renderTaskDirectForm();
    renderTaskFilters();
    renderTaskTable();
    updateTaskEditForm();
    updateTaskSelectionInfo();
    renderRecurringSection();
}
function renderKnowledge() {
    renderKnowledgeDirectForm();
    renderKnowledgeFilters();
    renderKnowledgeTable();
    updateKnowledgeEditForm();
    updateKnowledgeSelectionInfo();
}
function renderMaster() {
    renderWarnings(computeMasterWarnings());
    renderMasterEditTable();
    renderMasterValueEditors();
    renderDataTable('table-main',   'summary-main',   getFilteredMainData(),   MAIN_DATA_COLUMNS,   'メインデータ');
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

/** 日時文字列 "YYYY/MM/DD HH:mm:ss" の日付部分のみを返す */
function jpDateOnly(dt) { return (dt || '').slice(0, 10); }
/** "YYYY-MM-DD" を "YYYY/MM/DD" に変換 */
function isoToJP(d) { return d.replace(/-/g, '/'); }

/** currentTriageKubun に応じたテーブル列定義を返す */
function getTriageCols() {
    if (currentTriageKubun === 'タスク')
        return ['ID', 'タイトル', '優先度', '期限', 'ステータス', '内容', 'タグ', 'ハブ', '更新日時'];
    if (currentTriageKubun === 'ナレッジ')
        return ['ID', 'タイトル', 'Input', 'ステータス', '内容', 'タグ', 'ハブ', '更新日時'];
    return ['ID', 'カテゴリ', 'タイトル', '内容', 'タグ', 'ハブ', '作成日時'];
}

/** データ区分タブ（ラジオ）を描画する */
function renderTriageKubunTabs() {
    const container = document.getElementById('triage-kubun-tabs');
    if (!container) return;

    const kubunValues = [...new Set(currentMasterData.map(r => r['(M)データ区分']).filter(Boolean))];
    if (kubunValues.length > 0 && !kubunValues.includes(currentTriageKubun)) {
        currentTriageKubun = kubunValues[0];
    }

    container.innerHTML = '';
    kubunValues.forEach(val => {
        const count = getFilteredMainData().filter(r => r['データ区分'] === val).length;
        const label = document.createElement('label');
        label.className = 'triage-tab-label' + (val === currentTriageKubun ? ' active' : '');

        const radio = document.createElement('input');
        radio.type    = 'radio';
        radio.name    = 'triage-kubun-tab';
        radio.value   = val;
        radio.checked = (val === currentTriageKubun);
        radio.addEventListener('change', () => {
            currentTriageKubun = val;
            triageFilters = {};
            selectedInboxIds.clear();
            container.querySelectorAll('.triage-tab-label').forEach(l => l.classList.remove('active'));
            label.classList.add('active');
            renderTriageFilters();
            renderInboxList();
            updateTriageForm();
        });

        label.append(radio, document.createTextNode(` ${val}（${count}）`));
        container.appendChild(label);
    });
}

/** currentTriageKubun に応じたフィルタコントロールを描画する */
function renderTriageFilters() {
    const area = document.getElementById('triage-filter-area');
    if (!area) return;
    area.innerHTML = '';

    function makeRow(labelText, el) {
        const row = document.createElement('div');
        row.className = 'triage-filter-row';
        const lbl = document.createElement('label');
        lbl.className = 'triage-filter-label';
        lbl.textContent = labelText;
        row.append(lbl, el);
        area.appendChild(row);
    }

    function makeSelect(options, placeholder, key) {
        const sel = document.createElement('select');
        sel.className = 'triage-filter-select';
        const opt0 = document.createElement('option');
        opt0.value = ''; opt0.textContent = placeholder;
        sel.appendChild(opt0);
        options.forEach(v => {
            const opt = document.createElement('option');
            opt.value = opt.textContent = v;
            if (triageFilters[key] === v) opt.selected = true;
            sel.appendChild(opt);
        });
        sel.addEventListener('change', () => { triageFilters[key] = sel.value; renderInboxList(); });
        return sel;
    }

    function makeDateRange(fromKey, toKey) {
        const wrap    = document.createElement('div');
        wrap.className = 'filter-date-range';
        const fromInp = document.createElement('input');
        fromInp.type = 'date'; fromInp.className = 'filter-date-input';
        fromInp.value = triageFilters[fromKey] || '';
        fromInp.addEventListener('change', () => { triageFilters[fromKey] = fromInp.value; renderInboxList(); });
        const toInp = document.createElement('input');
        toInp.type = 'date'; toInp.className = 'filter-date-input';
        toInp.value = triageFilters[toKey] || '';
        toInp.addEventListener('change', () => { triageFilters[toKey] = toInp.value; renderInboxList(); });
        wrap.append(fromInp, document.createTextNode(' 〜 '), toInp);
        return wrap;
    }

    // 共通フィルタ
    makeRow('タグ',    makeSelect(getFilteredTags(), 'すべて', 'tag'));
    makeRow('ハブ',    makeSelect(getFilteredHubs(), 'すべて', 'hub'));
    makeRow('作成日時', makeDateRange('createdFrom', 'createdTo'));
    makeRow('更新日時', makeDateRange('updatedFrom', 'updatedTo'));

    // タスク専用フィルタ
    if (currentTriageKubun === 'タスク') {
        const priorities = [...new Set(currentMasterData.map(r => r['(M)優先度']).filter(Boolean))];
        makeRow('優先度', makeSelect(priorities, 'すべて', 'priority'));
        makeRow('期限',   makeDateRange('deadlineFrom', 'deadlineTo'));
        const taskStatuses = [...new Set(
            currentMasterData.filter(r => r['(M)ステータス_親'] === 'タスク')
                .map(r => r['(M)ステータス_子']).filter(Boolean)
        )];
        makeRow('ステータス', makeSelect(taskStatuses, 'すべて', 'status'));
    }

    // ナレッジ専用フィルタ
    if (currentTriageKubun === 'ナレッジ') {
        const inputs = [...new Set(currentMasterData.map(r => r['(M)Input']).filter(Boolean))];
        makeRow('Input', makeSelect(inputs, 'すべて', 'input'));
        const knowledgeStatuses = [...new Set(
            currentMasterData.filter(r => r['(M)ステータス_親'] === 'ナレッジ')
                .map(r => r['(M)ステータス_子']).filter(Boolean)
        )];
        makeRow('ステータス', makeSelect(knowledgeStatuses, 'すべて', 'status'));
    }
}

/** トリアージ一覧テーブルを描画する（currentTriageKubun + triageFilters を適用） */
function renderInboxList() {
    const COLS = getTriageCols();

    // データ区分フィルタ
    let rows = getFilteredMainData().filter(r => r['データ区分'] === currentTriageKubun);

    // 共通フィルタ
    if (triageFilters.tag)         rows = rows.filter(r => r['タグ'] === triageFilters.tag);
    if (triageFilters.hub)         rows = rows.filter(r => r['ハブ'] === triageFilters.hub);
    if (triageFilters.createdFrom) rows = rows.filter(r => jpDateOnly(r['作成日時']) >= isoToJP(triageFilters.createdFrom));
    if (triageFilters.createdTo)   rows = rows.filter(r => jpDateOnly(r['作成日時']) <= isoToJP(triageFilters.createdTo));
    if (triageFilters.updatedFrom) rows = rows.filter(r => jpDateOnly(r['更新日時']) >= isoToJP(triageFilters.updatedFrom));
    if (triageFilters.updatedTo)   rows = rows.filter(r => jpDateOnly(r['更新日時']) <= isoToJP(triageFilters.updatedTo));

    // タスク専用フィルタ
    if (currentTriageKubun === 'タスク') {
        if (triageFilters.priority)     rows = rows.filter(r => r['優先度']   === triageFilters.priority);
        if (triageFilters.deadlineFrom) rows = rows.filter(r => (r['期限'] || '') >= isoToJP(triageFilters.deadlineFrom));
        if (triageFilters.deadlineTo)   rows = rows.filter(r => (r['期限'] || '') <= isoToJP(triageFilters.deadlineTo));
        if (triageFilters.status)       rows = rows.filter(r => r['ステータス'] === triageFilters.status);
    }

    // ナレッジ専用フィルタ
    if (currentTriageKubun === 'ナレッジ') {
        if (triageFilters.input)  rows = rows.filter(r => r['Input']    === triageFilters.input);
        if (triageFilters.status) rows = rows.filter(r => r['ステータス'] === triageFilters.status);
    }

    // サマリー更新
    const summaryEl = document.getElementById('summary-inbox-triage');
    if (summaryEl) {
        summaryEl.innerHTML =
            `INBOXトリアージ<span class="expander-count">${rows.length} 件</span>`;
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
    if (rows.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan     = COLS.length + 1;
        td.className   = 'empty-cell';
        td.textContent = 'データがありません';
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        rows.forEach(row => {
            const id = String(row['ID']);
            const tr = document.createElement('tr');
            if (selectedInboxIds.has(id)) tr.classList.add('selected-row');

            const tdCheck = document.createElement('td');
            tdCheck.style.textAlign = 'center';
            const cb = document.createElement('input');
            cb.type    = 'checkbox';
            cb.value   = id;
            cb.checked = selectedInboxIds.has(id);
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
        checkAll.checked = rows.every(r => selectedInboxIds.has(String(r['ID'])));
    }

    table.replaceChildren(thead, tbody);
    updateTriageSelectionInfo();
}

/** 振り分けフォームを再構築する（データ区分ドロップダウン・タグ・ハブ・条件フィールド） */
function updateTriageForm() {
    const kubunEl = document.getElementById('triage-kubun');
    if (kubunEl) {
        const options = [...new Set(currentMasterData.map(r => r['(M)データ区分']).filter(Boolean))];
        kubunEl.innerHTML = '<option value="">（選択してください）</option>';
        options.forEach(v => {
            const o = document.createElement('option');
            o.value = o.textContent = v;
            kubunEl.appendChild(o);
        });
        // デフォルトを現在の表示タブに合わせる
        kubunEl.value = currentTriageKubun;
        kubunEl.addEventListener('change', () => updateTriageConditionalFields(kubunEl.value));
    }

    const tagEl = document.getElementById('triage-tag');
    if (tagEl) {
        tagEl.innerHTML = '<option value="">（未設定）</option>';
        getFilteredTags().forEach(v => {
            const o = document.createElement('option');
            o.value = o.textContent = v;
            tagEl.appendChild(o);
        });
    }

    const hubEl = document.getElementById('triage-hub');
    if (hubEl) {
        hubEl.innerHTML = '<option value="">（未設定）</option>';
        getFilteredHubs().forEach(v => {
            const o = document.createElement('option');
            o.value = o.textContent = v;
            hubEl.appendChild(o);
        });
    }

    updateTriageConditionalFields(currentTriageKubun);
    updateTriageSelectionInfo();
}

/** 振り分け先データ区分に応じて条件付きフィールドの表示・選択肢を更新する */
function updateTriageConditionalFields(kubun) {
    const isTask      = (kubun === 'タスク');
    const isKnowledge = (kubun === 'ナレッジ');

    function show(id, visible) {
        const el = document.getElementById(id);
        if (el) el.style.display = visible ? '' : 'none';
    }
    show('triage-status-row',   isTask || isKnowledge);
    show('triage-priority-row', isTask);
    show('triage-deadline-row', isTask);
    show('triage-estimate-row', isTask);
    show('triage-input-row',    isKnowledge);
    show('triage-output-row',   isKnowledge);

    function buildSelect(id, options) {
        const el = document.getElementById(id);
        if (!el) return;
        const prev = el.value;
        el.innerHTML = '<option value="">（未設定）</option>';
        options.forEach(v => {
            const o = document.createElement('option');
            o.value = o.textContent = v;
            el.appendChild(o);
        });
        el.value = prev;
    }

    if (isTask || isKnowledge) {
        const parent   = isTask ? 'タスク' : 'ナレッジ';
        const statuses = [...new Set(
            currentMasterData.filter(r => r['(M)ステータス_親'] === parent)
                .map(r => r['(M)ステータス_子']).filter(Boolean)
        )];
        buildSelect('triage-status', statuses);
    }
    if (isTask) {
        const priorities = [...new Set(currentMasterData.map(r => r['(M)優先度']).filter(Boolean))];
        buildSelect('triage-priority', priorities);
    }
    if (isKnowledge) {
        buildSelect('triage-input',  [...new Set(currentMasterData.map(r => r['(M)Input']).filter(Boolean))]);
        buildSelect('triage-output', [...new Set(currentMasterData.map(r => r['(M)Output']).filter(Boolean))]);
    }
}

/** 選択件数のバッジテキストを更新する。 */
function updateTriageSelectionInfo() {
    const el = document.getElementById('triage-selection-info');
    if (!el) return;
    el.textContent = selectedInboxIds.size === 0
        ? '行を選択してください'
        : `${selectedInboxIds.size} 件選択中`;
}

/** 1件選択時にフォームへ現在値を自動入力する（複数選択時は内容フィールドを非表示）。 */
function prefillTriageForm() {
    const contentRow = document.getElementById('triage-content-row');
    const contentEl  = document.getElementById('triage-content');

    if (selectedInboxIds.size !== 1) {
        if (contentRow) contentRow.style.display = 'none';
        if (contentEl)  contentEl.value = '';
        document.getElementById('triage-title').value = '';
        document.getElementById('triage-biko').value  = '';
        return;
    }

    const row = currentMainData.find(r => String(r['ID']) === [...selectedInboxIds][0]);
    if (!row) return;

    // 内容を表示・入力
    if (contentRow) contentRow.style.display = '';
    if (contentEl)  contentEl.value = row['内容'] ?? '';

    document.getElementById('triage-title').value = row['タイトル'] ?? '';
    document.getElementById('triage-biko').value  = row['備考']     ?? '';

    const tagEl = document.getElementById('triage-tag');
    if (tagEl && row['タグ']) tagEl.value = row['タグ'];
    const hubEl = document.getElementById('triage-hub');
    if (hubEl && row['ハブ']) hubEl.value = row['ハブ'];

    // データ区分をソース行に合わせて条件フィールドも更新
    const kubunEl = document.getElementById('triage-kubun');
    if (kubunEl) {
        kubunEl.value = row['データ区分'] ?? '';
        updateTriageConditionalFields(kubunEl.value);
    }

    // 条件フィールドに現在値を反映
    const statusEl = document.getElementById('triage-status');
    if (statusEl && row['ステータス']) statusEl.value = row['ステータス'];
    const priorityEl = document.getElementById('triage-priority');
    if (priorityEl && row['優先度']) priorityEl.value = row['優先度'];
    const deadlineEl = document.getElementById('triage-deadline');
    if (deadlineEl && row['期限']) deadlineEl.value = row['期限'];
    const estimateEl = document.getElementById('triage-estimate');
    if (estimateEl && row['見積時間']) estimateEl.value = row['見積時間'];
    const inputEl = document.getElementById('triage-input');
    if (inputEl && row['Input']) inputEl.value = row['Input'];
}

/** 更新日時が新しい順に最大10件を表示する。 */
function renderRecentItems() {
    const COLS    = ['ID', 'データ区分', 'カテゴリ', 'タイトル', '内容', 'タグ', 'ハブ', '更新日時'];
    const recent  = [...getFilteredMainData()]
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

// ===== タスクページ =====

const TASK_DISPLAY_COLS = ['タイトル', 'ステータス', '優先度', '期限', '見積時間', 'カテゴリ', 'タグ', 'ハブ'];

function getFilteredTasks() {
    let rows = getFilteredMainData().filter(r => r['データ区分'] === 'タスク');
    if (taskFilters.status)       rows = rows.filter(r => r['ステータス'] === taskFilters.status);
    if (taskFilters.priority)     rows = rows.filter(r => r['優先度']     === taskFilters.priority);
    if (taskFilters.tag)          rows = rows.filter(r => r['タグ']       === taskFilters.tag);
    if (taskFilters.hub)          rows = rows.filter(r => r['ハブ']       === taskFilters.hub);
    if (taskFilters.deadlineFrom) rows = rows.filter(r => jpDateOnly(r['期限']) >= isoToJP(taskFilters.deadlineFrom));
    if (taskFilters.deadlineTo)   rows = rows.filter(r => jpDateOnly(r['期限']) <= isoToJP(taskFilters.deadlineTo));
    return rows;
}

function renderTaskFilters() {
    const area = document.getElementById('task-filter-area');
    if (!area) return;
    area.innerHTML = '';

    function makeSelect(options, placeholder) {
        const sel = document.createElement('select');
        const all = document.createElement('option');
        all.value = ''; all.textContent = placeholder;
        sel.appendChild(all);
        options.forEach(v => {
            const o = document.createElement('option');
            o.value = o.textContent = v;
            sel.appendChild(o);
        });
        return sel;
    }
    function makeRow(labelText, ctrl, key) {
        const row = document.createElement('div');
        row.className = 'triage-filter-row';
        const lbl = document.createElement('span');
        lbl.className = 'triage-filter-label';
        lbl.textContent = labelText;
        row.append(lbl, ctrl);
        area.appendChild(row);
        ctrl.value = taskFilters[key] || '';
        ctrl.addEventListener('change', () => { taskFilters[key] = ctrl.value; renderTaskTable(); });
    }

    const statuses = [...new Set(
        currentMasterData.filter(r => r['(M)ステータス_親'] === 'タスク')
            .map(r => r['(M)ステータス_子']).filter(Boolean)
    )];
    const priorities = [...new Set(currentMasterData.map(r => r['(M)優先度']).filter(Boolean))];

    makeRow('ステータス', makeSelect(statuses,        'すべて'), 'status');
    makeRow('優先度',     makeSelect(priorities,       'すべて'), 'priority');
    makeRow('タグ',       makeSelect(getFilteredTags(), 'すべて'), 'tag');
    makeRow('ハブ',       makeSelect(getFilteredHubs(), 'すべて'), 'hub');

    // 期限 from/to
    const dateRow  = document.createElement('div');
    dateRow.className = 'triage-filter-row';
    const dateLbl  = document.createElement('span');
    dateLbl.className = 'triage-filter-label';
    dateLbl.textContent = '期限';
    const dateRange = document.createElement('div');
    dateRange.className = 'filter-date-range';
    const fromInp = document.createElement('input'); fromInp.type = 'date'; fromInp.className = 'filter-date-input';
    const sep     = document.createElement('span');  sep.textContent = '〜';
    const toInp   = document.createElement('input'); toInp.type = 'date'; toInp.className = 'filter-date-input';
    fromInp.value = taskFilters.deadlineFrom || '';
    toInp.value   = taskFilters.deadlineTo   || '';
    fromInp.addEventListener('change', () => { taskFilters.deadlineFrom = fromInp.value; renderTaskTable(); });
    toInp.addEventListener('change',   () => { taskFilters.deadlineTo   = toInp.value;   renderTaskTable(); });
    dateRange.append(fromInp, sep, toInp);
    dateRow.append(dateLbl, dateRange);
    area.appendChild(dateRow);
}

function renderTaskTable() {
    const tasks = getFilteredTasks();

    const summaryEl = document.getElementById('summary-task-list');
    if (summaryEl) {
        summaryEl.innerHTML =
            `タスク一覧・編集<span class="expander-count">${tasks.length} 件</span>`;
    }

    const table = document.getElementById('table-task-list');
    if (!table) return;
    table.className = 'data-table';

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    const thCb  = document.createElement('th'); thCb.textContent = '';
    hRow.appendChild(thCb);
    TASK_DISPLAY_COLS.forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    if (tasks.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = TASK_DISPLAY_COLS.length + 1;
        td.className = 'empty-cell';
        td.textContent = 'タスクがありません';
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        tasks.forEach(row => {
            const tr = document.createElement('tr');
            const id = String(row['ID']);
            if (selectedTaskIds.has(id)) tr.classList.add('selected-row');

            const tdCb = document.createElement('td');
            const cb   = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = selectedTaskIds.has(id);
            cb.addEventListener('change', () => {
                if (cb.checked) selectedTaskIds.add(id);
                else            selectedTaskIds.delete(id);
                tr.classList.toggle('selected-row', cb.checked);
                updateTaskSelectionInfo();
                if (selectedTaskIds.size === 1) prefillTaskForm();
                else if (selectedTaskIds.size === 0) clearTaskForm();
            });
            tdCb.appendChild(cb);
            tr.appendChild(tdCb);

            TASK_DISPLAY_COLS.forEach(col => {
                const td  = document.createElement('td');
                let   val = row[col] ?? '';
                if (col === 'タイトル' && val.length > 30) val = val.slice(0, 30) + '…';
                td.textContent = val;
                tr.appendChild(td);
            });

            tbody.appendChild(tr);
        });
    }

    table.replaceChildren(thead, tbody);
    updateTaskSelectionInfo();
}

function updateTaskSelectionInfo() {
    const el = document.getElementById('task-selection-info');
    if (!el) return;
    el.textContent = selectedTaskIds.size === 0
        ? '行を選択してください'
        : `${selectedTaskIds.size} 件選択中`;
}

function updateTaskEditForm() {
    function buildSelect(id, options) {
        const el = document.getElementById(id);
        if (!el) return;
        const prev = el.value;
        el.innerHTML = '<option value="">（未設定）</option>';
        options.forEach(v => {
            const o = document.createElement('option');
            o.value = o.textContent = v;
            el.appendChild(o);
        });
        el.value = prev;
    }
    const statuses = [...new Set(
        currentMasterData.filter(r => r['(M)ステータス_親'] === 'タスク')
            .map(r => r['(M)ステータス_子']).filter(Boolean)
    )];
    buildSelect('task-edit-status',   statuses);
    buildSelect('task-edit-priority', [...new Set(currentMasterData.map(r => r['(M)優先度']).filter(Boolean))]);
    buildSelect('task-edit-category', [...new Set(currentMasterData.map(r => r['(M)カテゴリ']).filter(Boolean))]);
    buildSelect('task-edit-tag',      getFilteredTags());
    buildSelect('task-edit-hub',      getFilteredHubs());
}

function prefillTaskForm() {
    if (selectedTaskIds.size !== 1) return;
    const id  = [...selectedTaskIds][0];
    const row = currentMainData.find(r => String(r['ID']) === id);
    if (!row) return;
    function set(elId, val) {
        const el = document.getElementById(elId);
        if (el) el.value = val ?? '';
    }
    updateTaskEditForm();
    set('task-edit-title',    row['タイトル']);
    set('task-edit-content',  row['内容']);
    set('task-edit-biko',     row['備考']);
    set('task-edit-status',   row['ステータス']);
    set('task-edit-priority', row['優先度']);
    set('task-edit-deadline', (row['期限'] || '').replace(/\//g, '-').slice(0, 10));
    set('task-edit-estimate', row['見積時間']);
    set('task-edit-category', row['カテゴリ']);
    set('task-edit-tag',      row['タグ']);
    set('task-edit-hub',      row['ハブ']);
}

function clearTaskForm() {
    ['task-edit-title','task-edit-content','task-edit-biko','task-edit-status',
     'task-edit-priority','task-edit-deadline','task-edit-estimate',
     'task-edit-category','task-edit-tag','task-edit-hub'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
}

document.getElementById('task-apply-btn')?.addEventListener('click', () => {
    if (selectedTaskIds.size === 0) { alert('編集するタスクを選択してください'); return; }

    const title    = document.getElementById('task-edit-title').value.trim();
    const content  = document.getElementById('task-edit-content').value.trim();
    const biko     = document.getElementById('task-edit-biko').value.trim();
    const status   = document.getElementById('task-edit-status').value;
    const priority = document.getElementById('task-edit-priority').value;
    const deadline = document.getElementById('task-edit-deadline').value;
    const estimate = document.getElementById('task-edit-estimate').value;
    const category = document.getElementById('task-edit-category').value;
    const tag      = document.getElementById('task-edit-tag').value;
    const hub      = document.getElementById('task-edit-hub').value;

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts  = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} `
              + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    selectedTaskIds.forEach(id => {
        const row = currentMainData.find(r => String(r['ID']) === id);
        if (!row) return;
        row['更新日時'] = ts;
        if (title)    row['タイトル']   = title;
        if (content)  row['内容']       = content;
        if (biko)     row['備考']       = biko;
        if (status)   row['ステータス'] = status;
        if (priority) row['優先度']     = priority;
        if (deadline) row['期限']       = deadline.replace(/-/g, '/');
        if (estimate) row['見積時間']   = estimate;
        if (category) row['カテゴリ']   = category;
        if (tag)      row['タグ']       = tag;
        if (hub)      row['ハブ']       = hub;
    });

    selectedTaskIds.clear();
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
    renderTaskList();
});

/** タスク直接入力フォームのドロップダウンを再構築する */
function renderTaskDirectForm() {
    function rebuildSelect(id, options, placeholder) {
        const el = document.getElementById(id);
        if (!el) return;
        const prev = el.value;
        el.innerHTML = `<option value="">${placeholder}</option>`;
        options.forEach(v => {
            const o = document.createElement('option');
            o.value = o.textContent = v;
            el.appendChild(o);
        });
        el.value = prev;
    }
    const statuses = [...new Set(
        currentMasterData.filter(r => r['(M)ステータス_親'] === 'タスク')
            .map(r => r['(M)ステータス_子']).filter(Boolean)
    )];
    rebuildSelect('task-new-status',   statuses, '（未設定）');
    rebuildSelect('task-new-priority', [...new Set(currentMasterData.map(r => r['(M)優先度']).filter(Boolean))], '（未設定）');
    rebuildSelect('task-new-category', [...new Set(currentMasterData.map(r => r['(M)カテゴリ']).filter(Boolean))], '（未設定）');
    rebuildSelect('task-new-tag',      getFilteredTags(), '（未設定）');
    rebuildSelect('task-new-hub',      getFilteredHubs(), '（未設定）');
    const badge = document.getElementById('task-new-badge');
    if (badge && !badge.textContent.startsWith('✓')) {
        badge.textContent = currentCategory === 'すべて' ? 'カテゴリ: 未設定' : `カテゴリ: ${currentCategory}`;
    }
}

document.getElementById('task-new-submit-btn')?.addEventListener('click', () => {
    const title    = document.getElementById('task-new-title').value.trim();
    const content  = document.getElementById('task-new-content').value.trim();
    const biko     = document.getElementById('task-new-biko').value.trim();
    const status   = document.getElementById('task-new-status').value;
    const priority = document.getElementById('task-new-priority').value;
    const deadline = document.getElementById('task-new-deadline').value;
    const estimate = document.getElementById('task-new-estimate').value;
    const category = document.getElementById('task-new-category').value;
    const tag      = document.getElementById('task-new-tag').value;
    const hub      = document.getElementById('task-new-hub').value;

    const maxId = currentMainData.reduce((max, row) => {
        const id = parseInt(row['ID'], 10);
        return isNaN(id) ? max : Math.max(max, id);
    }, 0);
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts  = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} `
              + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const entry = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
    entry['ID']        = String(maxId + 1);
    entry['データ区分'] = 'タスク';
    entry['カテゴリ']   = category || (currentCategory === 'すべて' ? '' : currentCategory);
    entry['タイトル']   = title;
    entry['内容']       = content;
    entry['備考']       = biko;
    entry['ステータス'] = status;
    entry['優先度']     = priority;
    entry['期限']       = deadline ? deadline.replace(/-/g, '/') : '';
    entry['見積時間']   = estimate;
    entry['タグ']       = tag;
    entry['ハブ']       = hub;
    entry['作成日時']   = ts;
    entry['更新日時']   = ts;

    currentMainData.push(entry);
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);

    ['task-new-title','task-new-content','task-new-biko','task-new-status',
     'task-new-priority','task-new-deadline','task-new-estimate',
     'task-new-category','task-new-tag','task-new-hub'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });

    const badge = document.getElementById('task-new-badge');
    if (badge) {
        badge.textContent = `✓ 登録しました（ID: ${entry['ID']}）`;
        setTimeout(() => renderTaskDirectForm(), 2000);
    }
    renderTaskTable();
});

// ===== ナレッジページ =====

const KNOWLEDGE_DISPLAY_COLS = ['タイトル', 'ステータス', 'Input', 'カテゴリ', 'タグ', 'ハブ', '更新日時'];

function getFilteredKnowledge() {
    let rows = getFilteredMainData().filter(r => r['データ区分'] === 'ナレッジ');
    if (knowledgeFilters.status) rows = rows.filter(r => r['ステータス'] === knowledgeFilters.status);
    if (knowledgeFilters.input)  rows = rows.filter(r => r['Input']      === knowledgeFilters.input);
    if (knowledgeFilters.tag)    rows = rows.filter(r => r['タグ']       === knowledgeFilters.tag);
    if (knowledgeFilters.hub)    rows = rows.filter(r => r['ハブ']       === knowledgeFilters.hub);
    return rows;
}

function renderKnowledgeDirectForm() {
    function rebuildSelect(id, options, placeholder) {
        const el = document.getElementById(id);
        if (!el) return;
        const prev = el.value;
        el.innerHTML = `<option value="">${placeholder}</option>`;
        options.forEach(v => {
            const o = document.createElement('option');
            o.value = o.textContent = v;
            el.appendChild(o);
        });
        el.value = prev;
    }
    const statuses = [...new Set(
        currentMasterData.filter(r => r['(M)ステータス_親'] === 'ナレッジ')
            .map(r => r['(M)ステータス_子']).filter(Boolean)
    )];
    rebuildSelect('knowledge-new-status',   statuses, '（未設定）');
    rebuildSelect('knowledge-new-input',    [...new Set(currentMasterData.map(r => r['(M)Input']).filter(Boolean))],  '（未設定）');
    rebuildSelect('knowledge-new-output',   [...new Set(currentMasterData.map(r => r['(M)Output']).filter(Boolean))], '（未設定）');
    rebuildSelect('knowledge-new-category', [...new Set(currentMasterData.map(r => r['(M)カテゴリ']).filter(Boolean))], '（未設定）');
    rebuildSelect('knowledge-new-tag',      getFilteredTags(), '（未設定）');
    rebuildSelect('knowledge-new-hub',      getFilteredHubs(), '（未設定）');
    const badge = document.getElementById('knowledge-new-badge');
    if (badge && !badge.textContent.startsWith('✓')) {
        badge.textContent = currentCategory === 'すべて' ? 'カテゴリ: 未設定' : `カテゴリ: ${currentCategory}`;
    }
}

function renderKnowledgeFilters() {
    const area = document.getElementById('knowledge-filter-area');
    if (!area) return;
    area.innerHTML = '';

    function makeSelect(options, placeholder) {
        const sel = document.createElement('select');
        const all = document.createElement('option');
        all.value = ''; all.textContent = placeholder;
        sel.appendChild(all);
        options.forEach(v => {
            const o = document.createElement('option');
            o.value = o.textContent = v;
            sel.appendChild(o);
        });
        return sel;
    }
    function makeRow(labelText, ctrl, key) {
        const row = document.createElement('div');
        row.className = 'triage-filter-row';
        const lbl = document.createElement('span');
        lbl.className = 'triage-filter-label';
        lbl.textContent = labelText;
        row.append(lbl, ctrl);
        area.appendChild(row);
        ctrl.value = knowledgeFilters[key] || '';
        ctrl.addEventListener('change', () => { knowledgeFilters[key] = ctrl.value; renderKnowledgeTable(); });
    }

    const statuses = [...new Set(
        currentMasterData.filter(r => r['(M)ステータス_親'] === 'ナレッジ')
            .map(r => r['(M)ステータス_子']).filter(Boolean)
    )];
    const inputs = [...new Set(currentMasterData.map(r => r['(M)Input']).filter(Boolean))];

    makeRow('ステータス', makeSelect(statuses,        'すべて'), 'status');
    makeRow('Input',      makeSelect(inputs,           'すべて'), 'input');
    makeRow('タグ',       makeSelect(getFilteredTags(), 'すべて'), 'tag');
    makeRow('ハブ',       makeSelect(getFilteredHubs(), 'すべて'), 'hub');
}

function renderKnowledgeTable() {
    const items = getFilteredKnowledge();

    const summaryEl = document.getElementById('summary-knowledge-list');
    if (summaryEl) {
        summaryEl.innerHTML =
            `ナレッジ一覧・編集<span class="expander-count">${items.length} 件</span>`;
    }

    const table = document.getElementById('table-knowledge-list');
    if (!table) return;
    table.className = 'data-table';

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    const thCb  = document.createElement('th'); thCb.textContent = '';
    hRow.appendChild(thCb);
    KNOWLEDGE_DISPLAY_COLS.forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    if (items.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = KNOWLEDGE_DISPLAY_COLS.length + 1;
        td.className = 'empty-cell';
        td.textContent = 'ナレッジがありません';
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        items.forEach(row => {
            const tr = document.createElement('tr');
            const id = String(row['ID']);
            if (selectedKnowledgeIds.has(id)) tr.classList.add('selected-row');

            const tdCb = document.createElement('td');
            const cb   = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = selectedKnowledgeIds.has(id);
            cb.addEventListener('change', () => {
                if (cb.checked) selectedKnowledgeIds.add(id);
                else            selectedKnowledgeIds.delete(id);
                tr.classList.toggle('selected-row', cb.checked);
                updateKnowledgeSelectionInfo();
                if (selectedKnowledgeIds.size === 1) prefillKnowledgeForm();
                else if (selectedKnowledgeIds.size === 0) clearKnowledgeForm();
            });
            tdCb.appendChild(cb);
            tr.appendChild(tdCb);

            KNOWLEDGE_DISPLAY_COLS.forEach(col => {
                const td  = document.createElement('td');
                let   val = row[col] ?? '';
                if (col === 'タイトル' && val.length > 30) val = val.slice(0, 30) + '…';
                td.textContent = val;
                tr.appendChild(td);
            });

            tbody.appendChild(tr);
        });
    }

    table.replaceChildren(thead, tbody);
    updateKnowledgeSelectionInfo();
}

function updateKnowledgeSelectionInfo() {
    const el = document.getElementById('knowledge-selection-info');
    if (!el) return;
    el.textContent = selectedKnowledgeIds.size === 0
        ? '行を選択してください'
        : `${selectedKnowledgeIds.size} 件選択中`;
}

function updateKnowledgeEditForm() {
    function buildSelect(id, options) {
        const el = document.getElementById(id);
        if (!el) return;
        const prev = el.value;
        el.innerHTML = '<option value="">（未設定）</option>';
        options.forEach(v => {
            const o = document.createElement('option');
            o.value = o.textContent = v;
            el.appendChild(o);
        });
        el.value = prev;
    }
    const statuses = [...new Set(
        currentMasterData.filter(r => r['(M)ステータス_親'] === 'ナレッジ')
            .map(r => r['(M)ステータス_子']).filter(Boolean)
    )];
    buildSelect('knowledge-edit-status',   statuses);
    buildSelect('knowledge-edit-input',    [...new Set(currentMasterData.map(r => r['(M)Input']).filter(Boolean))]);
    buildSelect('knowledge-edit-output',   [...new Set(currentMasterData.map(r => r['(M)Output']).filter(Boolean))]);
    buildSelect('knowledge-edit-category', [...new Set(currentMasterData.map(r => r['(M)カテゴリ']).filter(Boolean))]);
    buildSelect('knowledge-edit-tag',      getFilteredTags());
    buildSelect('knowledge-edit-hub',      getFilteredHubs());
}

function prefillKnowledgeForm() {
    if (selectedKnowledgeIds.size !== 1) return;
    const id  = [...selectedKnowledgeIds][0];
    const row = currentMainData.find(r => String(r['ID']) === id);
    if (!row) return;
    function set(elId, val) {
        const el = document.getElementById(elId);
        if (el) el.value = val ?? '';
    }
    updateKnowledgeEditForm();
    set('knowledge-edit-title',    row['タイトル']);
    set('knowledge-edit-content',  row['内容']);
    set('knowledge-edit-biko',     row['備考']);
    set('knowledge-edit-status',   row['ステータス']);
    set('knowledge-edit-input',    row['Input']);
    set('knowledge-edit-output',   row['Output']);
    set('knowledge-edit-category', row['カテゴリ']);
    set('knowledge-edit-tag',      row['タグ']);
    set('knowledge-edit-hub',      row['ハブ']);
}

function clearKnowledgeForm() {
    ['knowledge-edit-title','knowledge-edit-content','knowledge-edit-biko','knowledge-edit-status',
     'knowledge-edit-input','knowledge-edit-output','knowledge-edit-category','knowledge-edit-tag','knowledge-edit-hub'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
}

document.getElementById('knowledge-apply-btn')?.addEventListener('click', () => {
    if (selectedKnowledgeIds.size === 0) { alert('編集するナレッジを選択してください'); return; }

    const title    = document.getElementById('knowledge-edit-title').value.trim();
    const content  = document.getElementById('knowledge-edit-content').value.trim();
    const biko     = document.getElementById('knowledge-edit-biko').value.trim();
    const status   = document.getElementById('knowledge-edit-status').value;
    const input    = document.getElementById('knowledge-edit-input').value;
    const output   = document.getElementById('knowledge-edit-output').value;
    const category = document.getElementById('knowledge-edit-category').value;
    const tag      = document.getElementById('knowledge-edit-tag').value;
    const hub      = document.getElementById('knowledge-edit-hub').value;

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts  = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} `
              + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    selectedKnowledgeIds.forEach(id => {
        const row = currentMainData.find(r => String(r['ID']) === id);
        if (!row) return;
        row['更新日時'] = ts;
        if (title)    row['タイトル']   = title;
        if (content)  row['内容']       = content;
        if (biko)     row['備考']       = biko;
        if (status)   row['ステータス'] = status;
        if (input)    row['Input']      = input;
        if (output)   row['Output']     = output;
        if (category) row['カテゴリ']   = category;
        if (tag)      row['タグ']       = tag;
        if (hub)      row['ハブ']       = hub;
    });

    selectedKnowledgeIds.clear();
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
    renderKnowledge();
});

document.getElementById('knowledge-new-submit-btn')?.addEventListener('click', () => {
    const title    = document.getElementById('knowledge-new-title').value.trim();
    const content  = document.getElementById('knowledge-new-content').value.trim();
    const biko     = document.getElementById('knowledge-new-biko').value.trim();
    const status   = document.getElementById('knowledge-new-status').value;
    const input    = document.getElementById('knowledge-new-input').value;
    const output   = document.getElementById('knowledge-new-output').value;
    const category = document.getElementById('knowledge-new-category').value;
    const tag      = document.getElementById('knowledge-new-tag').value;
    const hub      = document.getElementById('knowledge-new-hub').value;

    const maxId = currentMainData.reduce((max, row) => {
        const id = parseInt(row['ID'], 10);
        return isNaN(id) ? max : Math.max(max, id);
    }, 0);
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts  = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} `
              + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const entry = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
    entry['ID']        = String(maxId + 1);
    entry['データ区分'] = 'ナレッジ';
    entry['カテゴリ']   = category || (currentCategory === 'すべて' ? '' : currentCategory);
    entry['タイトル']   = title;
    entry['内容']       = content;
    entry['備考']       = biko;
    entry['ステータス'] = status;
    entry['Input']      = input;
    entry['Output']     = output;
    entry['タグ']       = tag;
    entry['ハブ']       = hub;
    entry['作成日時']   = ts;
    entry['更新日時']   = ts;

    currentMainData.push(entry);
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);

    ['knowledge-new-title','knowledge-new-content','knowledge-new-biko','knowledge-new-status',
     'knowledge-new-input','knowledge-new-output','knowledge-new-category','knowledge-new-tag','knowledge-new-hub'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });

    const badge = document.getElementById('knowledge-new-badge');
    if (badge) {
        badge.textContent = `✓ 登録しました（ID: ${entry['ID']}）`;
        setTimeout(() => renderKnowledgeDirectForm(), 2000);
    }
    renderKnowledgeTable();
});

// ===== 直接データ入力フォーム =====

/** 直接データ入力フォームのドロップダウンをマスタデータで再構築する */
function renderDirectEntryForm() {
    function rebuildSelect(id, options, placeholder) {
        const el = document.getElementById(id);
        if (!el) return;
        const prev = el.value;
        el.innerHTML = `<option value="">${placeholder}</option>`;
        options.forEach(v => {
            const o = document.createElement('option');
            o.value = o.textContent = v;
            el.appendChild(o);
        });
        el.value = prev;
    }

    const kubunOptions = [...new Set(currentMasterData.map(r => r['(M)データ区分']).filter(Boolean))];
    rebuildSelect('direct-kubun', kubunOptions, '（選択してください）');

    const kubunEl = document.getElementById('direct-kubun');
    if (kubunEl && !kubunEl.dataset.directListenerAttached) {
        kubunEl.addEventListener('change', () => updateDirectConditionalFields(kubunEl.value));
        kubunEl.dataset.directListenerAttached = 'true';
    }

    rebuildSelect('direct-tag', getFilteredTags(), '（未設定）');
    rebuildSelect('direct-hub', getFilteredHubs(), '（未設定）');

    const badge = document.getElementById('direct-category-badge');
    if (badge) {
        badge.textContent = currentCategory === 'すべて' ? 'カテゴリ: 未設定' : `カテゴリ: ${currentCategory}`;
    }

    updateDirectConditionalFields(kubunEl?.value || '');
}

/** 直接入力フォームの条件付きフィールドをデータ区分に応じて表示/非表示・選択肢再構築する */
function updateDirectConditionalFields(kubun) {
    const isTask      = (kubun === 'タスク');
    const isKnowledge = (kubun === 'ナレッジ');

    function show(id, visible) {
        const el = document.getElementById(id);
        if (el) el.style.display = visible ? '' : 'none';
    }
    function buildOptions(id, options) {
        const el = document.getElementById(id);
        if (!el) return;
        const prev = el.value;
        el.innerHTML = '<option value="">（未設定）</option>';
        options.forEach(v => {
            const o = document.createElement('option');
            o.value = o.textContent = v;
            el.appendChild(o);
        });
        el.value = prev;
    }

    show('direct-status-row',   isTask || isKnowledge);
    show('direct-priority-row', isTask);
    show('direct-deadline-row', isTask);
    show('direct-estimate-row', isTask);
    show('direct-input-row',    isKnowledge);
    show('direct-output-row',   isKnowledge);

    if (isTask || isKnowledge) {
        const parent   = isTask ? 'タスク' : 'ナレッジ';
        const statuses = [...new Set(
            currentMasterData.filter(r => r['(M)ステータス_親'] === parent)
                .map(r => r['(M)ステータス_子']).filter(Boolean)
        )];
        buildOptions('direct-status', statuses);
    }
    if (isTask) {
        buildOptions('direct-priority',
            [...new Set(currentMasterData.map(r => r['(M)優先度']).filter(Boolean))]);
    }
    if (isKnowledge) {
        buildOptions('direct-input',  [...new Set(currentMasterData.map(r => r['(M)Input']).filter(Boolean))]);
        buildOptions('direct-output', [...new Set(currentMasterData.map(r => r['(M)Output']).filter(Boolean))]);
    }
}

/** 直接データ入力フォームの登録ボタン */
document.getElementById('direct-submit-btn')?.addEventListener('click', () => {
    const kubun = document.getElementById('direct-kubun').value;
    if (!kubun) { alert('データ区分を選択してください'); return; }

    const title    = document.getElementById('direct-title').value.trim();
    const content  = document.getElementById('direct-content').value.trim();
    const biko     = document.getElementById('direct-biko').value.trim();
    const tag      = document.getElementById('direct-tag').value;
    const hub      = document.getElementById('direct-hub').value;
    const status   = document.getElementById('direct-status')?.value   || '';
    const priority = document.getElementById('direct-priority')?.value || '';
    const deadline = document.getElementById('direct-deadline')?.value || '';
    const estimate = document.getElementById('direct-estimate')?.value || '';
    const input    = document.getElementById('direct-input')?.value    || '';
    const output   = document.getElementById('direct-output')?.value   || '';

    const maxId = currentMainData.reduce((max, row) => {
        const id = parseInt(row['ID'], 10);
        return isNaN(id) ? max : Math.max(max, id);
    }, 0);

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts  = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} `
              + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const entry = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
    entry['ID']        = String(maxId + 1);
    entry['データ区分'] = kubun;
    entry['カテゴリ']   = currentCategory === 'すべて' ? '' : currentCategory;
    entry['タイトル']   = title;
    entry['内容']       = content;
    entry['備考']       = biko;
    entry['タグ']       = tag;
    entry['ハブ']       = hub;
    entry['作成日時']   = ts;
    entry['更新日時']   = ts;

    if (kubun === 'タスク' || kubun === 'ナレッジ') { if (status)   entry['ステータス'] = status; }
    if (kubun === 'タスク')   { if (priority) entry['優先度'] = priority; }
    if (kubun === 'タスク')   { if (deadline) entry['期限']   = deadline; }
    if (kubun === 'タスク')   { if (estimate) entry['見積時間'] = estimate; }
    if (kubun === 'ナレッジ') { if (input)  entry['Input']  = input; }
    if (kubun === 'ナレッジ') { if (output) entry['Output'] = output; }

    currentMainData.push(entry);
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);

    ['direct-kubun', 'direct-title', 'direct-content', 'direct-biko',
     'direct-tag', 'direct-hub', 'direct-status', 'direct-priority',
     'direct-deadline', 'direct-estimate', 'direct-input'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    updateDirectConditionalFields('');

    renderTriageKubunTabs();
    if (currentTriageKubun === kubun || currentTriageKubun === 'INBOX') renderInboxList();
    renderRecentItems();

    const badge = document.getElementById('direct-category-badge');
    if (badge) {
        const cat = entry['カテゴリ'] || '（未設定）';
        badge.textContent = `✓ 登録しました（${kubun} / カテゴリ: ${cat}）`;
        setTimeout(() => renderDirectEntryForm(), 2000);
    }
});

/** 「振り分け実行」ボタン: 選択行に全フォーム値を適用して更新日時を更新する。 */
document.getElementById('triage-apply-btn')?.addEventListener('click', () => {
    if (selectedInboxIds.size === 0) { alert('振り分ける行を選択してください'); return; }

    const kubun = document.getElementById('triage-kubun').value;
    if (!kubun) { alert('データ区分を選択してください'); return; }

    const title   = document.getElementById('triage-title').value.trim();
    const biko    = document.getElementById('triage-biko').value.trim();
    const tag     = document.getElementById('triage-tag').value;
    const hub     = document.getElementById('triage-hub').value;
    // 内容は1件選択時のみ適用
    const content = selectedInboxIds.size === 1
        ? (document.getElementById('triage-content')?.value ?? null) : null;
    const status   = document.getElementById('triage-status')?.value   || '';
    const priority = document.getElementById('triage-priority')?.value || '';
    const deadline = document.getElementById('triage-deadline')?.value || '';
    const estimate = document.getElementById('triage-estimate')?.value || '';
    const input    = document.getElementById('triage-input')?.value    || '';
    const output   = document.getElementById('triage-output')?.value   || '';

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts  = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} `
              + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    selectedInboxIds.forEach(id => {
        const row = currentMainData.find(r => String(r['ID']) === id);
        if (!row) return;

        row['データ区分'] = kubun;
        row['更新日時']   = ts;
        if (title)                       row['タイトル'] = title;
        if (biko)                        row['備考']     = biko;
        if (tag)                         row['タグ']     = tag;
        if (hub)                         row['ハブ']     = hub;
        if (content !== null && content) row['内容']     = content;

        if (kubun === 'タスク' || kubun === 'ナレッジ') {
            if (status) row['ステータス'] = status;
        }
        if (kubun === 'タスク') {
            if (priority) row['優先度']   = priority;
            if (deadline) row['期限']     = deadline;
            if (estimate) row['見積時間'] = estimate;
        }
        if (kubun === 'ナレッジ') {
            if (input)  row['Input']  = input;
            if (output) row['Output'] = output;
        }
    });

    selectedInboxIds.clear();
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
    renderInbox();
});

// ===== マスタ管理 =====

// 編集対象の3列
const EDIT_COLS = ['(M)変数名', '(M)変数分類', '(M)変数説明'];

// マスタ値フィールド（行が"値専用行"か判定するために使用）
const VALUE_FIELDS = [
    '(M)データ区分', '(M)カテゴリ',
    '(M)タグ_親', '(M)タグ_子',
    '(M)ハブ_親', '(M)ハブ_子',
    '(M)ステータス_親', '(M)ステータス_子',
    '(M)優先度', '(M)Input', '(M)Output',
    '(M)繰返し頻度', '(M)繰返し頻度_詳細'
];

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

    // タグ・ハブの親がカテゴリに登録されているか確認
    const registeredCategories = [...new Set(currentMasterData.map(r => r['(M)カテゴリ']).filter(Boolean))];

    const invalidTagParents = [...new Set(currentMasterData.map(r => r['(M)タグ_親']).filter(Boolean))]
        .filter(p => !registeredCategories.includes(p));
    if (invalidTagParents.length > 0) {
        warnings.push(`タグの親「${invalidTagParents[0]}」はカテゴリに未登録です`);
    }

    const invalidHubParents = [...new Set(currentMasterData.map(r => r['(M)ハブ_親']).filter(Boolean))]
        .filter(p => !registeredCategories.includes(p));
    if (invalidHubParents.length > 0) {
        warnings.push(`ハブの親「${invalidHubParents[0]}」はカテゴリに未登録です`);
    }

    // ステータスの親が「タスク」か「ナレッジ」か確認
    const invalidStatusParents = [...new Set(currentMasterData.map(r => r['(M)ステータス_親']).filter(Boolean))]
        .filter(p => !['タスク', 'ナレッジ'].includes(p));
    if (invalidStatusParents.length > 0) {
        warnings.push(`ステータスの親「${invalidStatusParents[0]}」は「タスク」か「ナレッジ」である必要があります`);
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

document.getElementById('apply-master-btn')?.addEventListener('click', applyMasterEdits);

// ===== マスタ値 CRUD =====

function createEmptyMasterRow() {
    return Object.fromEntries(MASTER_DATA_COLUMNS.map(c => [c, '']));
}

/** (M)変数名が空の行について、指定フィールドの oldVal を newVal に置換する */
function masterUpdateSingle(field, oldVal, newVal) {
    currentMasterData.forEach(r => {
        if (!r['(M)変数名'] && r[field] === oldVal) r[field] = newVal;
    });
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
}

/** (M)変数名が空の行について、指定フィールドが val の行からそのフィールドを削除し、
 *  全 VALUE_FIELDS が空になった行は除去する */
function masterDeleteSingle(field, val) {
    currentMasterData = currentMasterData.filter(r => {
        if (r['(M)変数名']) return true;
        if (r[field] !== val) return true;
        r[field] = '';
        return VALUE_FIELDS.some(f => r[f]);
    });
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
}

/** 新しい単一値行を追加する */
function masterAddSingle(field, val) {
    const row = createEmptyMasterRow();
    row[field] = val;
    currentMasterData.push(row);
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
}

/** ペア (oldP, oldC) を (newP, newC) に更新する */
function masterUpdatePair(pf, cf, oldP, oldC, newP, newC) {
    const row = currentMasterData.find(r => !r['(M)変数名'] && r[pf] === oldP && r[cf] === oldC);
    if (row) { row[pf] = newP; row[cf] = newC; }
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
}

/** ペア行を削除し、全 VALUE_FIELDS が空になった行は除去する */
function masterDeletePair(pf, cf, parent, child) {
    currentMasterData = currentMasterData.filter(r => {
        if (r['(M)変数名']) return true;
        if (r[pf] !== parent || r[cf] !== child) return true;
        r[pf] = ''; r[cf] = '';
        return VALUE_FIELDS.some(f => r[f]);
    });
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
}

/** 新しいペア行を追加する */
function masterAddPair(pf, cf, parent, child) {
    const row = createEmptyMasterRow();
    row[pf] = parent; row[cf] = child;
    currentMasterData.push(row);
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
}

// -- 再描画のトリガー（値エディタ共通） --
function refreshAfterMasterEdit() {
    renderCurrentMasterValueEditor();
    renderWarnings(computeMasterWarnings());
    renderCategoryFilter();
}

/** ラジオボタンを同期し、選択中のエディタを描画する */
function renderMasterValueEditors() {
    document.querySelectorAll('input[name="master-value-type"]').forEach(r => {
        r.checked = (r.value === currentMasterValueType);
    });
    renderCurrentMasterValueEditor();
}

/** 現在選択中のタイプのエディタのみを描画する */
function renderCurrentMasterValueEditor() {
    const registeredCategories = [...new Set(currentMasterData.map(r => r['(M)カテゴリ']).filter(Boolean))];

    const CONFIGS = {
        kubun: () => renderSingleValueEditor({
            sectionId: 'section-master-value-editor',
            label:     'データ区分',
            field:     '(M)データ区分',
        }),
        category: () => renderSingleValueEditor({
            sectionId: 'section-master-value-editor',
            label:     'カテゴリ',
            field:     '(M)カテゴリ',
        }),
        tag: () => renderPairValueEditor({
            sectionId:      'section-master-value-editor',
            label:          'タグ',
            parentField:    '(M)タグ_親',
            childField:     '(M)タグ_子',
            validateParent: p => registeredCategories.includes(p) ? null
                : `「${p}」はカテゴリに登録されていません`,
        }),
        hub: () => renderPairValueEditor({
            sectionId:      'section-master-value-editor',
            label:          'ハブ',
            parentField:    '(M)ハブ_親',
            childField:     '(M)ハブ_子',
            validateParent: p => registeredCategories.includes(p) ? null
                : `「${p}」はカテゴリに登録されていません`,
        }),
        status: () => renderPairValueEditor({
            sectionId:      'section-master-value-editor',
            label:          'ステータス',
            parentField:    '(M)ステータス_親',
            childField:     '(M)ステータス_子',
            validateParent: p => ['タスク', 'ナレッジ'].includes(p) ? null
                : `「${p}」は「タスク」か「ナレッジ」である必要があります`,
        }),
        priority: () => renderSingleValueEditor({
            sectionId: 'section-master-value-editor',
            label:     '優先度',
            field:     '(M)優先度',
        }),
        input: () => renderSingleValueEditor({
            sectionId: 'section-master-value-editor',
            label:     'Input',
            field:     '(M)Input',
        }),
        output: () => renderSingleValueEditor({
            sectionId: 'section-master-value-editor',
            label:     'Output',
            field:     '(M)Output',
        }),
        frequency: () => renderPairValueEditor({
            sectionId:   'section-master-value-editor',
            label:       '繰返し頻度',
            parentField: '(M)繰返し頻度',
            childField:  '(M)繰返し頻度_詳細',
        }),
    };
    CONFIGS[currentMasterValueType]?.();
}

/** 単一値（データ区分・カテゴリ）用エディタを描画する */
function renderSingleValueEditor({ sectionId, label, field }) {
    const values = [...new Set(currentMasterData.map(r => r[field]).filter(Boolean))];

    const section = document.getElementById(sectionId);
    if (!section) return;
    section.innerHTML = '';

    // テーブル
    const table = document.createElement('table');
    table.className = 'data-table edit-table';

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    ['値', '操作'].forEach(text => {
        const th = document.createElement('th');
        th.textContent = text;
        if (text === '操作') th.className = 'col-ctrl';
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    if (values.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 2; td.className = 'empty-cell';
        td.textContent = 'データがありません';
        tr.appendChild(td); tbody.appendChild(tr);
    } else {
        values.forEach(val => {
            const tr = document.createElement('tr');
            let cur = val;

            const tdVal = document.createElement('td');
            const inp   = document.createElement('input');
            inp.type = 'text'; inp.value = val; inp.className = 'edit-input';
            inp.addEventListener('blur', () => {
                const n = inp.value.trim();
                if (!n || n === cur) { inp.value = cur; return; }
                masterUpdateSingle(field, cur, n);
                cur = n;
                refreshAfterMasterEdit();
            });
            inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
            tdVal.appendChild(inp);
            tr.appendChild(tdVal);

            const tdOp  = document.createElement('td');
            tdOp.className = 'col-ctrl';
            const btnDel = document.createElement('button');
            btnDel.textContent = '削除'; btnDel.className = 'row-delete-btn';
            btnDel.addEventListener('click', () => {
                if (!confirm(`「${cur}」を削除しますか？`)) return;
                masterDeleteSingle(field, cur);
                refreshAfterMasterEdit();
            });
            tdOp.appendChild(btnDel);
            tr.appendChild(tdOp);
            tbody.appendChild(tr);
        });
    }
    table.replaceChildren(thead, tbody);
    section.appendChild(table);

    // 追加フォーム
    const addRow = document.createElement('div');
    addRow.className = 'master-value-add-row';
    const addInp = document.createElement('input');
    addInp.type = 'text'; addInp.className = 'edit-input';
    addInp.placeholder = `新しい${label}を入力...`;
    const addBtn = document.createElement('button');
    addBtn.textContent = '追加'; addBtn.className = 'master-add-btn';
    addBtn.addEventListener('click', () => {
        const v = addInp.value.trim();
        if (!v) { addInp.focus(); return; }
        if (values.includes(v)) { alert(`「${v}」はすでに登録されています`); return; }
        masterAddSingle(field, v);
        addInp.value = '';
        refreshAfterMasterEdit();
    });
    addInp.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn.click(); });
    addRow.append(addInp, addBtn);
    section.appendChild(addRow);
}

/** ペア値（タグ・ハブ・ステータス）用エディタを描画する */
function renderPairValueEditor({ sectionId, label, parentField, childField, validateParent }) {
    const seen  = new Set();
    const pairs = [];
    currentMasterData.forEach(r => {
        const p = r[parentField], c = r[childField];
        if (!p) return;
        const key = `${p}${c}`;
        if (seen.has(key)) return;
        seen.add(key);
        pairs.push({ parent: p, child: c });
    });
    pairs.sort((a, b) => a.parent.localeCompare(b.parent) || a.child.localeCompare(b.child));

    const section = document.getElementById(sectionId);
    if (!section) return;
    section.innerHTML = '';

    const table = document.createElement('table');
    table.className = 'data-table edit-table';

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    ['親', '子', '操作'].forEach(text => {
        const th = document.createElement('th');
        th.textContent = text;
        if (text === '操作') th.className = 'col-ctrl';
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    if (pairs.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 3; td.className = 'empty-cell';
        td.textContent = 'データがありません';
        tr.appendChild(td); tbody.appendChild(tr);
    } else {
        pairs.forEach(({ parent, child }) => {
            const tr = document.createElement('tr');
            let curP = parent, curC = child;

            // 親の検証結果に応じて行をハイライト
            const warn = validateParent ? validateParent(curP) : null;
            if (warn) tr.classList.add('invalid-row');

            ['parent', 'child'].forEach(which => {
                const td  = document.createElement('td');
                const inp = document.createElement('input');
                inp.type      = 'text';
                inp.value     = which === 'parent' ? curP : curC;
                inp.className = 'edit-input';
                if (which === 'parent' && warn) inp.title = warn;

                inp.addEventListener('blur', () => {
                    const n = inp.value.trim();
                    if (!n) { inp.value = which === 'parent' ? curP : curC; return; }
                    const newP = which === 'parent' ? n : curP;
                    const newC = which === 'child'  ? n : curC;
                    if (newP === curP && newC === curC) return;
                    masterUpdatePair(parentField, childField, curP, curC, newP, newC);
                    curP = newP; curC = newC;
                    refreshAfterMasterEdit();
                });
                inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
                td.appendChild(inp);
                tr.appendChild(td);
            });

            const tdOp  = document.createElement('td');
            tdOp.className = 'col-ctrl';
            const btnDel = document.createElement('button');
            btnDel.textContent = '削除'; btnDel.className = 'row-delete-btn';
            btnDel.addEventListener('click', () => {
                if (!confirm(`「${curP} / ${curC}」を削除しますか？`)) return;
                masterDeletePair(parentField, childField, curP, curC);
                refreshAfterMasterEdit();
            });
            tdOp.appendChild(btnDel);
            tr.appendChild(tdOp);
            tbody.appendChild(tr);
        });
    }
    table.replaceChildren(thead, tbody);
    section.appendChild(table);

    // 追加フォーム
    const addRow = document.createElement('div');
    addRow.className = 'master-value-add-row';
    const addParentInp = document.createElement('input');
    addParentInp.type = 'text'; addParentInp.className = 'edit-input';
    addParentInp.placeholder = '親';
    const addChildInp = document.createElement('input');
    addChildInp.type = 'text'; addChildInp.className = 'edit-input';
    addChildInp.placeholder = '子';
    const addBtn = document.createElement('button');
    addBtn.textContent = '追加'; addBtn.className = 'master-add-btn';
    addBtn.addEventListener('click', () => {
        const p = addParentInp.value.trim();
        const c = addChildInp.value.trim();
        if (!p) { addParentInp.focus(); return; }
        if (!c) { addChildInp.focus(); return; }
        if (pairs.some(pair => pair.parent === p && pair.child === c)) {
            alert('すでに登録されています'); return;
        }
        if (validateParent) {
            const w = validateParent(p);
            if (w && !confirm(`注意: ${w}\nそれでも追加しますか？`)) return;
        }
        masterAddPair(parentField, childField, p, c);
        addParentInp.value = ''; addChildInp.value = '';
        refreshAfterMasterEdit();
    });
    [addParentInp, addChildInp].forEach(inp => {
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn.click(); });
    });
    addRow.append(addParentInp, addChildInp, addBtn);
    section.appendChild(addRow);
}

// ===== データ読み込みヘルパー =====

/**
 * Markdownテキストを受け取り、グローバル状態を更新して現在ページを再描画する。
 */
function applyContent(content, sha) {
    currentSha = sha;
    const { mainData, masterData } = parseMarkdown(content);
    currentMainData   = mainData;
    currentMasterData = masterData;

    // 繰り返しタスクの自動生成（データ読み込み時）
    const newChildren = checkAndGenerateChildren(currentMainData, new Date());
    if (newChildren.length > 0) {
        currentMainData.push(...newChildren);
        saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
    }

    // 初回ロード時のみ、先頭カテゴリをデフォルト選択にする
    if (!categoryInitialized) {
        const categories = [...new Set(currentMasterData.map(r => r['(M)カテゴリ']).filter(Boolean))];
        if (categories.length > 0) currentCategory = categories[0];
        categoryInitialized = true;
    }

    renderCategoryFilter();   // データ更新時にカテゴリ一覧を再構築
    renderPage(currentPage);
}

// ===== GitHubから読み込み =====
document.getElementById('load-btn')?.addEventListener('click', async () => {
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
document.getElementById('save-btn')?.addEventListener('click', async () => {
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
document.getElementById('excel-export-btn')?.addEventListener('click', () => {
    if (currentMainData.length === 0 && currentMasterData.length === 0) {
        return alert('エクスポートするデータがありません。先にGitHubからデータを読み込んでください。');
    }
    exportToExcel(currentMainData, currentMasterData);
});

// ===== Excelインポート =====
document.getElementById('excel-import')?.addEventListener('change', async (e) => {
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

document.getElementById('inbox-submit-btn')?.addEventListener('click', () => {
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
 * 選択中のカテゴリでフィルタされたメインデータを返す。
 * 「すべて」選択時は全件返す。
 * @returns {Array}
 */
function getFilteredMainData() {
    if (currentCategory === 'すべて') return currentMainData;
    return currentMainData.filter(r => r['カテゴリ'] === currentCategory);
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

// ===== タスク実行機能 =====

/** yyyy/mm/dd hh:mm:ss 形式の日時文字列を Date に変換する */
function parseJpDatetime(str) {
    if (!str || !str.trim()) return null;
    const m = str.trim().match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (!m) return null;
    return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]);
}

/** Date を yyyy/mm/dd hh:mm:ss 形式にフォーマット */
function formatJpDatetime(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** タイムスタンプログ文字列を解析して累計ミリ秒を返す（開始中=現在時刻まで加算） */
function parseTimestampLog(log) {
    if (!log || !log.trim()) return 0;
    const segments = log.split(',').map(s => s.trim()).filter(Boolean);
    let total = 0;
    const now  = Date.now();
    segments.forEach(seg => {
        const dashIdx = seg.indexOf('-', 10);
        if (dashIdx === -1) return;
        const start = parseJpDatetime(seg.slice(0, dashIdx));
        if (!start) return;
        const endStr = seg.slice(dashIdx + 1).trim();
        const end    = endStr ? parseJpDatetime(endStr) : null;
        total += (end ? end.getTime() : now) - start.getTime();
    });
    return total;
}

/** ミリ秒を hh:mm:ss にフォーマット */
function formatDuration(ms) {
    if (ms < 0) ms = 0;
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${String(h).padStart(2,'0')}:${String(m % 60).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
}

/** 選択タスクの補正込み累計時間（ms） */
function computeTotalDuration(taskId) {
    const row = currentMainData.find(r => String(r['ID']) === String(taskId));
    if (!row) return 0;
    const base = parseTimestampLog(row['タイムスタンプログ'] || '');
    const adj  = parseFloat(row['補正時間'] || '0') * 60000;
    return base + adj;
}

/** 両コンテナの経過時間表示を更新 */
function updateRunnerTimerDisplay() {
    if (!selectedRunTaskId) return;
    const text = formatDuration(computeTotalDuration(selectedRunTaskId));
    document.querySelectorAll('.runner-elapsed-display').forEach(el => { el.textContent = text; });
}

/** 両コンテナにタスク実行UIを描画 */
function renderTaskRunner() {
    ['task-runner-dash', 'task-runner-task'].forEach(id => {
        const container = document.getElementById(id);
        if (container) buildTaskRunnerUI(container);
    });
}

/** 単一コンテナにタスク実行UIを構築 */
function buildTaskRunnerUI(container) {
    container.innerHTML = '';

    const inProgress = currentMainData.filter(r =>
        r['データ区分'] === 'タスク' && r['ステータス'] === '進行中'
    );

    // --- 進行中タスク一覧 ---
    const wrap  = document.createElement('div');
    wrap.className = 'table-wrapper';
    const table = document.createElement('table');
    table.className = 'data-table';

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    ['タイトル', '優先度', '期限', '累計時間'].forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    if (inProgress.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 4;
        td.className = 'empty-cell';
        td.textContent = '進行中のタスクがありません';
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        inProgress.forEach(row => {
            const tr  = document.createElement('tr');
            const rid = String(row['ID']);
            if (rid === String(selectedRunTaskId)) tr.classList.add('selected-row');
            tr.style.cursor = 'pointer';
            [row['タイトル'] || '（無題）', row['優先度'] || '', row['期限'] || '',
             formatDuration(computeTotalDuration(rid))
            ].forEach(val => {
                const td = document.createElement('td');
                td.textContent = val;
                tr.appendChild(td);
            });
            tr.addEventListener('click', () => {
                if (String(selectedRunTaskId) !== rid) {
                    if (timerIsRunning) {
                        const now = formatJpDatetime(new Date());
                        const prev = currentMainData.find(r => String(r['ID']) === String(selectedRunTaskId));
                        if (prev) prev['タイムスタンプログ'] = (prev['タイムスタンプログ'] || '') + `${now}, `;
                        timerIsRunning = false;
                        if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
                    }
                    selectedRunTaskId = rid;
                }
                renderTaskRunner();
            });
            tbody.appendChild(tr);
        });
    }
    table.append(thead, tbody);
    wrap.appendChild(table);
    container.appendChild(wrap);

    const selectedRow = selectedRunTaskId
        ? currentMainData.find(r => String(r['ID']) === String(selectedRunTaskId) && r['ステータス'] === '進行中')
        : null;

    if (!selectedRow) {
        const hint = document.createElement('p');
        hint.className = 'placeholder-text';
        hint.style.margin = '8px 0 0';
        hint.textContent = inProgress.length > 0 ? 'タスクをクリックして選択してください' : '';
        container.appendChild(hint);
        return;
    }

    // --- 操作パネル ---
    const panel = document.createElement('div');
    panel.className = 'runner-panel';

    // タスク名
    const titleEl = document.createElement('p');
    titleEl.className = 'runner-task-title';
    titleEl.textContent = `▶ ${selectedRow['タイトル'] || '（無題）'}`;
    panel.appendChild(titleEl);

    // 累計時間行
    const timeRow = document.createElement('div');
    timeRow.className = 'triage-form-row';
    const timeLabel = document.createElement('label');
    timeLabel.textContent = '累計時間';
    const timeInfo = document.createElement('div');
    timeInfo.className = 'runner-time-info';

    const elapsedSpan = document.createElement('span');
    elapsedSpan.className = 'runner-elapsed-display runner-elapsed-big';
    elapsedSpan.textContent = formatDuration(computeTotalDuration(String(selectedRow['ID'])));

    const adjWrap  = document.createElement('span');
    adjWrap.className = 'runner-adj-wrap';
    const adjLabel = document.createElement('span');
    adjLabel.textContent = '補正:';
    const adjInput = document.createElement('input');
    adjInput.type        = 'number';
    adjInput.className   = 'runner-adj-input';
    adjInput.placeholder = '分 (±)';
    adjInput.step        = '1';
    adjInput.value       = selectedRow['補正時間'] || '';
    adjInput.addEventListener('change', () => {
        selectedRow['補正時間'] = adjInput.value;
        saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
        updateRunnerTimerDisplay();
    });
    const adjSuffix = document.createElement('span');
    adjSuffix.textContent = '分';
    adjWrap.append(adjLabel, adjInput, adjSuffix);

    timeInfo.append(elapsedSpan, adjWrap);
    timeRow.append(timeLabel, timeInfo);
    panel.appendChild(timeRow);

    // 開始/停止ボタン行
    const btnRow = document.createElement('div');
    btnRow.className = 'triage-toolbar';

    const statusLabel = document.createElement('span');
    statusLabel.className = 'triage-info runner-status-label';
    statusLabel.textContent = timerIsRunning ? '⏱ 計測中...' : '';

    const startBtn = document.createElement('button');
    startBtn.className   = 'triage-btn runner-start-btn';
    startBtn.textContent = '▶ 開始';
    startBtn.disabled    = timerIsRunning;
    startBtn.addEventListener('click', () => {
        const ts = formatJpDatetime(new Date());
        selectedRow['タイムスタンプログ'] = (selectedRow['タイムスタンプログ'] || '') + `${ts}-`;
        timerIsRunning = true;
        if (timerInterval) clearInterval(timerInterval);
        timerInterval = setInterval(updateRunnerTimerDisplay, 1000);
        saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
        renderTaskRunner();
    });

    const stopBtn = document.createElement('button');
    stopBtn.className   = 'triage-btn runner-stop-btn';
    stopBtn.textContent = '■ 停止';
    stopBtn.disabled    = !timerIsRunning;
    stopBtn.addEventListener('click', () => {
        const ts = formatJpDatetime(new Date());
        selectedRow['タイムスタンプログ'] = (selectedRow['タイムスタンプログ'] || '') + `${ts}, `;
        timerIsRunning = false;
        if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
        saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
        renderTaskRunner();
    });

    btnRow.append(statusLabel, startBtn, stopBtn);
    panel.appendChild(btnRow);

    // タイムスタンプログ
    const logRow   = document.createElement('div');
    logRow.className = 'triage-form-row triage-form-row--top';
    const logLabel = document.createElement('label');
    logLabel.textContent = 'タイムスタンプログ';
    const logArea  = document.createElement('textarea');
    logArea.className = 'triage-textarea';
    logArea.rows      = 3;
    logArea.value     = selectedRow['タイムスタンプログ'] || '';
    logArea.addEventListener('change', () => {
        selectedRow['タイムスタンプログ'] = logArea.value;
        saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
        updateRunnerTimerDisplay();
    });
    logRow.append(logLabel, logArea);
    panel.appendChild(logRow);

    // ステータス遷移
    const taskStatuses = [...new Set(
        currentMasterData
            .filter(r => r['(M)ステータス_親'] === 'タスク')
            .map(r => r['(M)ステータス_子'])
            .filter(Boolean)
    )];
    if (taskStatuses.length > 0) {
        const statusSec = document.createElement('div');
        statusSec.className = 'runner-status-section';

        const secLabel = document.createElement('label');
        secLabel.textContent = 'ステータス遷移';
        statusSec.appendChild(secLabel);

        const radioGroup = document.createElement('div');
        radioGroup.className = 'runner-status-radios';
        const rName = `runner-status-${container.id}`;
        taskStatuses.forEach((st, i) => {
            const lbl   = document.createElement('label');
            lbl.className = 'triage-tab-label';
            const radio = document.createElement('input');
            radio.type  = 'radio';
            radio.name  = rName;
            radio.value = st;
            if (i === 0) radio.checked = true;
            lbl.append(radio, document.createTextNode(' ' + st));
            radioGroup.appendChild(lbl);
        });
        statusSec.appendChild(radioGroup);

        const cmtRow   = document.createElement('div');
        cmtRow.className = 'triage-form-row';
        const cmtLabel = document.createElement('label');
        cmtLabel.textContent = 'ステータスコメント';
        const cmtInput = document.createElement('input');
        cmtInput.type        = 'text';
        cmtInput.placeholder = '（省略可）';
        cmtInput.value       = selectedRow['ステータスコメント'] || '';
        cmtRow.append(cmtLabel, cmtInput);
        statusSec.appendChild(cmtRow);

        const changeTb  = document.createElement('div');
        changeTb.className = 'triage-toolbar';
        const changeBtn = document.createElement('button');
        changeBtn.className   = 'triage-btn';
        changeBtn.textContent = 'ステータスを変更する';
        changeBtn.addEventListener('click', () => {
            const chosen = radioGroup.querySelector(`input[name="${rName}"]:checked`);
            if (!chosen) return;
            const newStatus = chosen.value;
            if (newStatus !== '進行中' && timerIsRunning) {
                const ts = formatJpDatetime(new Date());
                selectedRow['タイムスタンプログ'] = (selectedRow['タイムスタンプログ'] || '') + `${ts}, `;
                timerIsRunning = false;
                if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
            }
            selectedRow['ステータス']        = newStatus;
            selectedRow['ステータスコメント'] = cmtInput.value.trim();
            selectedRow['更新日時']           = formatJpDatetime(new Date());
            if (String(selectedRunTaskId) === String(selectedRow['ID'])) {
                selectedRunTaskId = null;
            }
            saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
            renderTaskRunner();
            renderTaskTable();
        });
        changeTb.appendChild(changeBtn);
        statusSec.appendChild(changeTb);
        panel.appendChild(statusSec);
    }

    container.appendChild(panel);
}

// ===== 繰り返しタスク =====

const recurringChartInstances = new Map();

/** 子タスク配列から Chart.js 用の labels / data を作成する */
function buildChildChartData(children) {
    const sorted = [...children]
        .filter(r => r['完了日'] || r['作成日時'])
        .sort((a, b) => {
            const da = a['完了日'] || a['作成日時'];
            const db = b['完了日'] || b['作成日時'];
            return da.localeCompare(db);
        });

    const labels = sorted.map(r => (r['完了日'] || r['作成日時']).slice(0, 10));
    const data   = sorted.map(r => {
        const manual = parseFloat(r['実績時間'] || '');
        if (!isNaN(manual) && manual > 0) return manual;
        const ms = parseTimestampLog(r['タイムスタンプログ'] || '');
        return ms > 0 ? Math.round(ms / 360000) / 10 : 0;
    });

    return { labels, data };
}

/** タスクページの繰り返しタスクセクションを描画する */
function renderRecurringSection() {
    const container = document.getElementById('recurring-section');
    if (!container) return;

    // 既存チャートインスタンスを破棄してからDOMをリセット
    recurringChartInstances.forEach(chart => chart.destroy());
    recurringChartInstances.clear();
    container.innerHTML = '';

    const parents = currentMainData.filter(r =>
        r['繰返し識別子'] === '1' && !r['繰返し親ID']
    );

    const summaryEl = document.getElementById('summary-recurring');
    if (summaryEl) {
        summaryEl.innerHTML =
            `繰り返しタスク<span class="expander-count">${parents.length} 件</span>`;
    }

    if (parents.length === 0) {
        const p = document.createElement('p');
        p.className    = 'placeholder-text';
        p.style.margin = '8px 0';
        p.textContent  = '繰り返しタスクがありません';
        container.appendChild(p);
        return;
    }

    parents.forEach(parent => {
        const parentId = String(parent['ID']);
        const children = currentMainData.filter(r => r['繰返し親ID'] === parentId);

        const block = document.createElement('div');
        block.className = 'recurring-parent-block';

        // ヘッダー行（タイトル + 手動生成ボタン）
        const header = document.createElement('div');
        header.className = 'recurring-parent-header';

        const titleEl = document.createElement('span');
        titleEl.className   = 'recurring-parent-title';
        titleEl.textContent = `${parent['タイトル'] || '（無題）'} — ${parent['ステータス'] || '未設定'} / 子タスク ${children.length} 件`;

        const manualBtn = document.createElement('button');
        manualBtn.className   = 'triage-btn recurring-manual-btn';
        manualBtn.textContent = '子を手動生成';
        manualBtn.addEventListener('click', () => {
            const child = generateChildManually(parent, currentMainData);
            if (!child) { alert('本日分は既に生成済みです'); return; }
            currentMainData.push(child);
            saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
            renderRecurringSection();
            renderTaskTable();
        });

        header.append(titleEl, manualBtn);
        block.appendChild(header);

        // グラフ
        const chartData = buildChildChartData(children);
        if (chartData.labels.length > 0 && window.Chart) {
            const wrap   = document.createElement('div');
            wrap.className = 'recurring-chart-wrap';
            const canvas = document.createElement('canvas');
            wrap.appendChild(canvas);
            block.appendChild(wrap);

            const chart = new window.Chart(canvas, {
                type: 'line',
                data: {
                    labels: chartData.labels,
                    datasets: [{
                        label: '実績時間 (h)',
                        data:  chartData.data,
                        borderColor: '#4a90d9',
                        backgroundColor: 'rgba(74,144,217,0.1)',
                        tension: 0.3,
                        pointRadius: 4,
                        fill: true,
                    }],
                },
                options: {
                    responsive: true,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { title: { display: true, text: '日付' } },
                        y: { title: { display: true, text: '実績時間 (h)' }, beginAtZero: true },
                    },
                },
            });
            recurringChartInstances.set(parentId, chart);
        } else {
            const noData = document.createElement('p');
            noData.className    = 'placeholder-text';
            noData.style.margin = '6px 0 0';
            noData.textContent  = chartData.labels.length === 0
                ? '子タスクに実績データがありません'
                : 'Chart.js が読み込まれていません';
            block.appendChild(noData);
        }

        container.appendChild(block);
    });
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
