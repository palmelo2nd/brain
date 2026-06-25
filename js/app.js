import { loadToken, saveToken, loadCache, saveCache } from './modules/storage.js';
import { fetchFile, saveFile } from './modules/github.js';
import { parseMarkdown, stringifyMarkdown, MAIN_DATA_COLUMNS, MASTER_DATA_COLUMNS } from './modules/dataModel.js';
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
let categoryInitialized = false;         // 初回ロード時にデフォルトカテゴリを設定済みか
let currentMasterValueType = 'kubun';   // マスタ値エディタの選択タイプ
let currentTriageKubun = 'INBOX';       // トリアージ一覧の表示対象データ区分
let triageFilters      = {};            // トリアージフィルタ値

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
    // カテゴリバッジを現在の選択値に同期
    const badge = document.getElementById('inbox-category-badge');
    if (badge) {
        badge.textContent = currentCategory === 'すべて'
            ? 'カテゴリ: 未設定（「すべて」選択中）'
            : `カテゴリ: ${currentCategory}`;
    }
}
function renderInbox() {
    renderDirectEntryForm();
    renderTriageKubunTabs();
    renderTriageFilters();
    renderInboxList();
    updateTriageForm();
    renderRecentItems();
}
function renderTaskList()  { console.log('[render] task', { mainData: currentMainData }); }
function renderKnowledge() { console.log('[render] knowledge'); }
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
        const inputs = [...new Set(currentMasterData.map(r => r['(M)Input']).filter(Boolean))];
        buildSelect('triage-input', inputs);
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
        buildOptions('direct-input',
            [...new Set(currentMasterData.map(r => r['(M)Input']).filter(Boolean))]);
    }
}

/** 直接データ入力フォームの登録ボタン */
document.getElementById('direct-submit-btn').addEventListener('click', () => {
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
    if (kubun === 'ナレッジ') { if (input)    entry['Input']  = input; }

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
document.getElementById('triage-apply-btn').addEventListener('click', () => {
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
            if (input) row['Input'] = input;
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

document.getElementById('apply-master-btn').addEventListener('click', applyMasterEdits);

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
