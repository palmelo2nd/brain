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
let categoryInitialized = false;         // 初回ロード時にデフォルトカテゴリを設定済みか
let selectedEditIds = new Set();       // 編集セクションで選択中の行ID
let editFilters      = {};             // 編集セクションのフィルタ値
let editKubun         = 'INBOX';       // 編集セクションの対象データ区分（一覧の絞り込みタブ）
let selectedRunTaskId    = null;       // タスク実行で選択中のタスクID
let timerIsRunning       = false;      // タイマー動作中フラグ
let timerInterval        = null;       // setInterval ハンドル
const todayForCalendar   = new Date();
let calendarYear         = todayForCalendar.getFullYear(); // カレンダーの表示年
let calendarMonth        = todayForCalendar.getMonth();    // カレンダーの表示月（0-11）
let selectedCalendarDate = null;       // カレンダーで選択中の日付（"YYYY/MM/DD"）
let selectedCalendarTaskId = null;     // 日別予定表で選択中のタスクID（属性編集パネル用）
let calendarFilters = { tag: new Set(), hub: new Set(), status: new Set() }; // カレンダーのタグ／ハブ／ステータスフィルタ値（複数選択）
let calendarQuickNewMode = false;      // true時: タスク一覧の「（新規作成）」行から起動した新規登録モード（日付は空欄のまま）
let taskOrgView = 'calendar';          // 「タスク整理」の表示ビュー（'calendar' | 'gantt'）。年月・タグ/ハブ/ステータスフィルタ・選択中タスクは両ビューで共有する
let ganttViewUnit = 'day';             // ガントチャートの列の単位（'day' | 'week'）

// ===== 初期化 =====
window.addEventListener('DOMContentLoaded', () => {
    const saved = loadToken();
    if (saved) {
        document.getElementById('token-input').value = saved;
        loadFromGithub(saved, true);
    }
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
    renderRecurringSection();
    renderCalendar();
}
function renderInbox() {
    renderEdit();
    renderRecentItems();
    renderDataTable('table-main',   'summary-main',   getFilteredMainData(),   MAIN_DATA_COLUMNS,   'メインデータ',   { editable: true, idColumn: 'ID' });
    renderDataTable('table-master', 'summary-master', currentMasterData, MASTER_DATA_COLUMNS, 'マスタデータ', { editable: true, onEdit: () => { renderWarnings(computeMasterWarnings()); renderHubAdmin(); } });
    renderWarnings(computeMasterWarnings());
    renderHubAdmin();
}

/**
 * 指定テーブルをデータ配列で描画し、サマリーに件数バッジを更新する。
 * options.editable が true の場合、各セルを直接編集可能にし、
 * 編集完了（blur）時に row オブジェクトへ書き込んでキャッシュ保存する。
 * @param {string} tableId    - 描画先 <table> の id
 * @param {string} summaryId  - 件数を表示する <summary> の id
 * @param {Array}  data       - 行データの配列
 * @param {Array}  columns    - 表示列名の配列（MAIN_DATA_COLUMNS / MASTER_DATA_COLUMNS）
 * @param {string} label      - サマリー表示名
 * @param {{editable?: boolean, idColumn?: string, onEdit?: Function}} [options]
 */
function renderDataTable(tableId, summaryId, data, columns, label, options = {}) {
    const { editable = false, idColumn = null, onEdit = null } = options;

    // ---- サマリーの件数バッジを更新 ----
    const summaryEl = document.getElementById(summaryId);
    if (summaryEl) {
        summaryEl.innerHTML =
            `${label} 一覧<span class="expander-count">${data.length} 件</span>`;
    }

    const table = document.getElementById(tableId);
    if (!table) return;

    table.className = 'data-table' + (editable ? ' data-table--editable' : '');

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

                // ID列は参照キーとして使われるため編集不可にする
                if (editable && col !== idColumn) {
                    td.contentEditable = 'true';
                    td.classList.add('editable-cell');
                    td.addEventListener('keydown', e => {
                        if (e.key === 'Enter') { e.preventDefault(); td.blur(); }
                    });
                    td.addEventListener('blur', () => {
                        const newVal = td.textContent.trim();
                        if ((row[col] ?? '') === newVal) return;
                        row[col] = newVal;
                        saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
                        if (onEdit) onEdit();
                    });
                }

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

// ===== <select> 共通ヘルパー =====

/** <select> のoption一覧を再構築する（先頭に空選択肢 + optionsを追加）。 */
function populateSelectOptions(el, options, placeholder) {
    if (!el) return;
    el.innerHTML = `<option value="">${placeholder}</option>`;
    options.forEach(v => {
        const o = document.createElement('option');
        o.value = o.textContent = v;
        el.appendChild(o);
    });
}

/** id指定の既存<select>のoptionを再構築し、現在選択されていた値を維持する。 */
function rebuildSelectById(id, options, placeholder = '（未設定）') {
    const el = document.getElementById(id);
    if (!el) return;
    const prev = el.value;
    populateSelectOptions(el, options, placeholder);
    el.value = prev;
}

/** フィルタ用に新規<select>を生成し、現在値・changeハンドラを設定して返す。 */
function createFilterSelect(options, placeholder, currentValue, onChange) {
    const sel = document.createElement('select');
    populateSelectOptions(sel, options, placeholder);
    if (currentValue) sel.value = currentValue;
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
}

// ===== 編集（INBOX／タスク／ナレッジ／アイデア／アーカイブ 統合） =====
//
// editKubun + editFilters = 上部タブ（一覧の絞り込み用フィルタ）
// フォーム内の edit-kubun（移動先データ区分）= 新規登録・データ区分変更の対象
// 移動先データ区分を切り替えると、そのデータ区分で必要な属性欄だけが表示される。

/** editKubun に応じたテーブル列定義を返す（タスク／ナレッジは専用列、それ以外は共通列） */
function getEditCols(kubun) {
    if (kubun === 'タスク')   return ['タイトル', 'ステータス', '優先度', '開始予定', '終了予定', '見積時間', 'カテゴリ', 'タグ', 'ハブ'];
    if (kubun === 'ナレッジ') return ['タイトル', 'ステータス', 'Input', 'カテゴリ', 'タグ', 'ハブ', '更新日時'];
    return ['カテゴリ', 'タイトル', '内容', 'タグ', 'ハブ', '作成日時', '更新日時'];
}

/** editKubun + editFilters を適用したメインデータの絞り込み結果を返す */
function getFilteredEditItems() {
    let rows = getFilteredMainData().filter(r => r['データ区分'] === editKubun);

    // 共通フィルタ
    if (editFilters.tag)         rows = rows.filter(r => r['タグ'] === editFilters.tag);
    if (editFilters.hub)         rows = rows.filter(r => r['ハブ'] === editFilters.hub);
    if (editFilters.createdFrom) rows = rows.filter(r => jpDateOnly(r['作成日時']) >= isoToJP(editFilters.createdFrom));
    if (editFilters.createdTo)   rows = rows.filter(r => jpDateOnly(r['作成日時']) <= isoToJP(editFilters.createdTo));
    if (editFilters.updatedFrom) rows = rows.filter(r => jpDateOnly(r['更新日時']) >= isoToJP(editFilters.updatedFrom));
    if (editFilters.updatedTo)   rows = rows.filter(r => jpDateOnly(r['更新日時']) <= isoToJP(editFilters.updatedTo));

    // タスク専用フィルタ
    if (editKubun === 'タスク') {
        if (editFilters.priority)   rows = rows.filter(r => r['優先度'] === editFilters.priority);
        if (editFilters.startFrom)  rows = rows.filter(r => (r['開始予定'] || '') >= isoToJP(editFilters.startFrom));
        if (editFilters.startTo)    rows = rows.filter(r => (r['開始予定'] || '') <= isoToJP(editFilters.startTo));
        if (editFilters.endFrom)    rows = rows.filter(r => (r['終了予定'] || '') >= isoToJP(editFilters.endFrom));
        if (editFilters.endTo)      rows = rows.filter(r => (r['終了予定'] || '') <= isoToJP(editFilters.endTo));
        if (editFilters.status)     rows = rows.filter(r => r['ステータス'] === editFilters.status);
    }

    // ナレッジ専用フィルタ
    if (editKubun === 'ナレッジ') {
        if (editFilters.input)  rows = rows.filter(r => r['Input']      === editFilters.input);
        if (editFilters.status) rows = rows.filter(r => r['ステータス'] === editFilters.status);
    }

    return rows;
}

/** 「編集」セクション全体（対象タブ・フィルタ・一覧・フォーム）を再描画する */
function renderEdit() {
    renderEditKubunTabs();
    renderEditFilters();
    renderEditTable();
    updateEditForm();
}

/** データ区分タブ（ラジオ、一覧の絞り込み用）を描画する */
function renderEditKubunTabs() {
    const container = document.getElementById('edit-kubun-tabs');
    if (!container) return;

    const kubunValues = [...new Set(currentMasterData.map(r => r['(M)データ区分']).filter(Boolean))];
    if (kubunValues.length > 0 && !kubunValues.includes(editKubun)) {
        editKubun = kubunValues[0];
    }

    container.innerHTML = '';
    kubunValues.forEach(val => {
        const count = getFilteredMainData().filter(r => r['データ区分'] === val).length;
        const label = document.createElement('label');
        label.className = 'triage-tab-label' + (val === editKubun ? ' active' : '');

        const radio = document.createElement('input');
        radio.type    = 'radio';
        radio.name    = 'edit-kubun-tab';
        radio.value   = val;
        radio.checked = (val === editKubun);
        radio.addEventListener('change', () => {
            editKubun = val;
            editFilters = {};
            selectedEditIds.clear();
            renderEditFilters();
            renderEditTable();
            updateEditForm();
            clearEditForm();
        });

        label.append(radio, document.createTextNode(` ${val}（${count}）`));
        container.appendChild(label);
    });
}

/** editKubun に応じたフィルタコントロールを描画する */
function renderEditFilters() {
    const area = document.getElementById('edit-filter-area');
    if (!area) return;
    area.innerHTML = '';

    function makeRow(labelText, el) {
        const row = document.createElement('div');
        row.className = 'triage-filter-row';
        const lbl = document.createElement('span');
        lbl.className = 'triage-filter-label';
        lbl.textContent = labelText;
        row.append(lbl, el);
        area.appendChild(row);
    }
    function makeSelect(options, placeholder, key) {
        return createFilterSelect(options, placeholder, editFilters[key], v => {
            editFilters[key] = v;
            renderEditTable();
        });
    }
    function makeDateRange(fromKey, toKey) {
        const wrap = document.createElement('div');
        wrap.className = 'filter-date-range';
        const fromInp = document.createElement('input');
        fromInp.type = 'date'; fromInp.className = 'filter-date-input';
        fromInp.value = editFilters[fromKey] || '';
        fromInp.addEventListener('change', () => { editFilters[fromKey] = fromInp.value; renderEditTable(); });
        const toInp = document.createElement('input');
        toInp.type = 'date'; toInp.className = 'filter-date-input';
        toInp.value = editFilters[toKey] || '';
        toInp.addEventListener('change', () => { editFilters[toKey] = toInp.value; renderEditTable(); });
        wrap.append(fromInp, document.createTextNode(' 〜 '), toInp);
        return wrap;
    }

    // 共通フィルタ
    makeRow('タグ',    makeSelect(getFilteredTags(), 'すべて', 'tag'));
    makeRow('ハブ',    makeSelect(getFilteredHubs(), 'すべて', 'hub'));
    makeRow('作成日時', makeDateRange('createdFrom', 'createdTo'));
    makeRow('更新日時', makeDateRange('updatedFrom', 'updatedTo'));

    // タスク専用フィルタ
    if (editKubun === 'タスク') {
        const priorities = [...new Set(currentMasterData.map(r => r['(M)優先度']).filter(Boolean))];
        makeRow('優先度',   makeSelect(priorities, 'すべて', 'priority'));
        makeRow('開始予定', makeDateRange('startFrom', 'startTo'));
        makeRow('終了予定', makeDateRange('endFrom', 'endTo'));
        const taskStatuses = [...new Set(
            currentMasterData.filter(r => r['(M)ステータス_親'] === 'タスク')
                .map(r => r['(M)ステータス_子']).filter(Boolean)
        )];
        makeRow('ステータス', makeSelect(taskStatuses, 'すべて', 'status'));
    }

    // ナレッジ専用フィルタ
    if (editKubun === 'ナレッジ') {
        const inputs = [...new Set(currentMasterData.map(r => r['(M)Input']).filter(Boolean))];
        makeRow('Input', makeSelect(inputs, 'すべて', 'input'));
        const knowledgeStatuses = [...new Set(
            currentMasterData.filter(r => r['(M)ステータス_親'] === 'ナレッジ')
                .map(r => r['(M)ステータス_子']).filter(Boolean)
        )];
        makeRow('ステータス', makeSelect(knowledgeStatuses, 'すべて', 'status'));
    }
}

/** 一覧テーブルを描画する（editKubun + editFilters を適用） */
function renderEditTable() {
    const cols = getEditCols(editKubun);
    const rows = getFilteredEditItems();

    const summaryEl = document.getElementById('summary-edit');
    if (summaryEl) {
        summaryEl.innerHTML = `編集<span class="expander-count">${rows.length} 件</span>`;
    }

    const table = document.getElementById('table-edit-list');
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
                selectedEditIds.add(cb.value);
                tr.classList.add('selected-row');
            } else {
                selectedEditIds.delete(cb.value);
                tr.classList.remove('selected-row');
            }
        });
        updateEditSelectionInfo();
        prefillEditForm();
    });
    thCheck.appendChild(checkAll);
    hRow.appendChild(thCheck);
    cols.forEach(col => {
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
        td.colSpan     = cols.length + 1;
        td.className   = 'empty-cell';
        td.textContent = 'データがありません';
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        rows.forEach(row => {
            const id = String(row['ID']);
            const tr = document.createElement('tr');
            if (selectedEditIds.has(id)) tr.classList.add('selected-row');

            const tdCheck = document.createElement('td');
            tdCheck.style.textAlign = 'center';
            const cb = document.createElement('input');
            cb.type    = 'checkbox';
            cb.value   = id;
            cb.checked = selectedEditIds.has(id);
            cb.addEventListener('change', () => {
                if (cb.checked) { selectedEditIds.add(id);    tr.classList.add('selected-row'); }
                else            { selectedEditIds.delete(id); tr.classList.remove('selected-row'); }
                updateEditSelectionInfo();
                prefillEditForm();
            });
            tdCheck.appendChild(cb);
            tr.appendChild(tdCheck);

            cols.forEach(col => {
                const td  = document.createElement('td');
                let   val = row[col] ?? '';
                if ((col === '内容' || col === 'タイトル') && val.length > 40) val = val.slice(0, 40) + '…';
                td.textContent = val;
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        checkAll.checked = rows.every(r => selectedEditIds.has(String(r['ID'])));
    }

    table.replaceChildren(thead, tbody);
    updateEditSelectionInfo();
}

/** 選択件数のバッジテキストを更新する。 */
function updateEditSelectionInfo() {
    const el = document.getElementById('edit-selection-info');
    if (!el) return;
    el.textContent = selectedEditIds.size === 0
        ? '行を選択してください'
        : `${selectedEditIds.size} 件選択中`;
}

/** フォームを再構築する（移動先データ区分ドロップダウン・タグ・ハブ・カテゴリ・条件フィールド） */
function updateEditForm() {
    const kubunOptions = [...new Set(currentMasterData.map(r => r['(M)データ区分']).filter(Boolean))];
    rebuildSelectById('edit-kubun', kubunOptions, '（選択してください）');
    const kubunEl = document.getElementById('edit-kubun');
    if (kubunEl) {
        // デフォルトを現在の表示タブに合わせる
        kubunEl.value = editKubun;
        if (!kubunEl.dataset.editListenerAttached) {
            kubunEl.addEventListener('change', () => updateEditConditionalFields(kubunEl.value));
            kubunEl.dataset.editListenerAttached = 'true';
        }
    }

    rebuildSelectById('edit-tag',      getFilteredTags());
    rebuildSelectById('edit-hub',      getFilteredHubs());
    rebuildSelectById('edit-category', [...new Set(currentMasterData.map(r => r['(M)カテゴリ']).filter(Boolean))]);

    updateEditConditionalFields(kubunEl?.value || editKubun);
    updateEditSelectionInfo();
}

/** 移動先データ区分に応じて条件付きフィールドの表示・選択肢を更新する */
function updateEditConditionalFields(kubun) {
    const isTask      = (kubun === 'タスク');
    const isKnowledge = (kubun === 'ナレッジ');

    function show(id, visible) {
        const el = document.getElementById(id);
        if (el) el.style.display = visible ? '' : 'none';
    }
    show('edit-status-row',   isTask || isKnowledge);
    show('edit-priority-row', isTask);
    show('edit-start-row',    isTask);
    show('edit-end-row',      isTask);
    show('edit-estimate-row', isTask);
    show('edit-input-row',    isKnowledge);
    show('edit-output-row',   isKnowledge);

    if (isTask || isKnowledge) {
        const parent   = isTask ? 'タスク' : 'ナレッジ';
        const statuses = [...new Set(
            currentMasterData.filter(r => r['(M)ステータス_親'] === parent)
                .map(r => r['(M)ステータス_子']).filter(Boolean)
        )];
        rebuildSelectById('edit-status', statuses);
    }
    if (isTask) {
        rebuildSelectById('edit-priority', [...new Set(currentMasterData.map(r => r['(M)優先度']).filter(Boolean))]);
    }
    if (isKnowledge) {
        rebuildSelectById('edit-input',  [...new Set(currentMasterData.map(r => r['(M)Input']).filter(Boolean))]);
        rebuildSelectById('edit-output', [...new Set(currentMasterData.map(r => r['(M)Output']).filter(Boolean))]);
    }
}

/** 1件選択時にフォームへ現在値を自動入力する（複数選択時はタイトル・内容・備考をクリア）。 */
function prefillEditForm() {
    const contentEl = document.getElementById('edit-content');

    if (selectedEditIds.size !== 1) {
        if (contentEl) contentEl.value = '';
        document.getElementById('edit-title').value = '';
        document.getElementById('edit-biko').value  = '';
        return;
    }

    const row = currentMainData.find(r => String(r['ID']) === [...selectedEditIds][0]);
    if (!row) return;

    if (contentEl) contentEl.value = row['内容'] ?? '';

    document.getElementById('edit-title').value = row['タイトル'] ?? '';
    document.getElementById('edit-biko').value  = row['備考']     ?? '';

    const tagEl = document.getElementById('edit-tag');
    if (tagEl) tagEl.value = row['タグ'] ?? '';
    const hubEl = document.getElementById('edit-hub');
    if (hubEl) hubEl.value = row['ハブ'] ?? '';
    const categoryEl = document.getElementById('edit-category');
    if (categoryEl) categoryEl.value = row['カテゴリ'] ?? '';

    // 移動先データ区分をソース行に合わせて条件フィールドも更新
    const kubunEl = document.getElementById('edit-kubun');
    if (kubunEl) {
        kubunEl.value = row['データ区分'] ?? '';
        updateEditConditionalFields(kubunEl.value);
    }

    const statusEl = document.getElementById('edit-status');
    if (statusEl) statusEl.value = row['ステータス'] ?? '';
    const priorityEl = document.getElementById('edit-priority');
    if (priorityEl) priorityEl.value = row['優先度'] ?? '';
    const startEl = document.getElementById('edit-start');
    if (startEl) startEl.value = (row['開始予定'] || '').replace(/\//g, '-').slice(0, 10);
    const endEl = document.getElementById('edit-end');
    if (endEl) endEl.value = (row['終了予定'] || '').replace(/\//g, '-').slice(0, 10);
    const estimateEl = document.getElementById('edit-estimate');
    if (estimateEl) estimateEl.value = row['見積時間'] ?? '';
    const inputEl = document.getElementById('edit-input');
    if (inputEl) inputEl.value = row['Input'] ?? '';
    const outputEl = document.getElementById('edit-output');
    if (outputEl) outputEl.value = row['Output'] ?? '';
}

/** フォームをクリアし、移動先データ区分を現在の表示タブに戻す。 */
function clearEditForm() {
    ['edit-title', 'edit-content', 'edit-biko', 'edit-status', 'edit-priority',
     'edit-start', 'edit-end', 'edit-estimate', 'edit-input', 'edit-output',
     'edit-category', 'edit-tag', 'edit-hub'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const kubunEl = document.getElementById('edit-kubun');
    if (kubunEl) {
        kubunEl.value = editKubun;
        updateEditConditionalFields(editKubun);
    }
}

/** 「新規登録」ボタン: 選択状態に関わらず、フォームの現在値（移動先データ区分）で新規データを追加する。 */
document.getElementById('edit-new-btn')?.addEventListener('click', () => {
    const kubun = document.getElementById('edit-kubun').value;
    if (!kubun) { alert('データ区分を選択してください'); return; }

    const title    = document.getElementById('edit-title').value.trim();
    const content  = document.getElementById('edit-content').value.trim();
    const biko     = document.getElementById('edit-biko').value.trim();
    const category = document.getElementById('edit-category').value;
    const tag      = document.getElementById('edit-tag').value;
    const hub      = document.getElementById('edit-hub').value;
    const status   = document.getElementById('edit-status')?.value   || '';
    const priority = document.getElementById('edit-priority')?.value || '';
    const start    = document.getElementById('edit-start')?.value    || '';
    const end      = document.getElementById('edit-end')?.value      || '';
    const estimate = document.getElementById('edit-estimate')?.value || '';
    const input    = document.getElementById('edit-input')?.value    || '';
    const output   = document.getElementById('edit-output')?.value   || '';

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
    entry['カテゴリ']   = category || (currentCategory === 'すべて' ? '' : currentCategory);
    entry['タイトル']   = title;
    entry['内容']       = content;
    entry['備考']       = biko;
    entry['タグ']       = tag;
    entry['ハブ']       = hub;
    entry['作成日時']   = ts;
    entry['更新日時']   = ts;

    if (kubun === 'タスク' || kubun === 'ナレッジ') { if (status) entry['ステータス'] = status; }
    if (kubun === 'タスク') {
        if (priority) entry['優先度']   = priority;
        if (start)    entry['開始予定'] = start.replace(/-/g, '/');
        if (end)      entry['終了予定'] = end.replace(/-/g, '/');
        if (estimate) entry['見積時間'] = estimate;
    }
    if (kubun === 'ナレッジ') {
        if (input)  entry['Input']  = input;
        if (output) entry['Output'] = output;
    }

    currentMainData.push(entry);
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);

    selectedEditIds.clear();
    clearEditForm();
    renderEditKubunTabs();
    renderEditTable();
    renderRecentItems();

    const info = document.getElementById('edit-selection-info');
    if (info) {
        info.textContent = `✓ 登録しました（${kubun} / ID: ${entry['ID']}）`;
        setTimeout(updateEditSelectionInfo, 2000);
    }
});

/** 「変更」ボタン: 選択行に全フォーム値を適用して更新日時を更新する（データ区分の移動も可能）。 */
document.getElementById('edit-apply-btn')?.addEventListener('click', () => {
    if (selectedEditIds.size === 0) { alert('変更する行を選択してください'); return; }

    const kubun = document.getElementById('edit-kubun').value;
    if (!kubun) { alert('データ区分を選択してください'); return; }

    const title    = document.getElementById('edit-title').value.trim();
    const biko     = document.getElementById('edit-biko').value.trim();
    const category = document.getElementById('edit-category').value;
    const tag      = document.getElementById('edit-tag').value;
    const hub      = document.getElementById('edit-hub').value;
    // 内容は1件選択時のみ適用
    const content = selectedEditIds.size === 1
        ? (document.getElementById('edit-content')?.value ?? null) : null;
    const status   = document.getElementById('edit-status')?.value   || '';
    const priority = document.getElementById('edit-priority')?.value || '';
    const start    = document.getElementById('edit-start')?.value    || '';
    const end      = document.getElementById('edit-end')?.value      || '';
    const estimate = document.getElementById('edit-estimate')?.value || '';
    const input    = document.getElementById('edit-input')?.value    || '';
    const output   = document.getElementById('edit-output')?.value   || '';

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts  = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} `
              + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    selectedEditIds.forEach(id => {
        const row = currentMainData.find(r => String(r['ID']) === id);
        if (!row) return;

        row['データ区分'] = kubun;
        row['更新日時']   = ts;
        if (title)                       row['タイトル'] = title;
        if (biko)                        row['備考']     = biko;
        if (category)                    row['カテゴリ'] = category;
        if (tag)                         row['タグ']     = tag;
        if (hub)                         row['ハブ']     = hub;
        if (content !== null && content) row['内容']     = content;

        if (kubun === 'タスク' || kubun === 'ナレッジ') {
            if (status) row['ステータス'] = status;
        }
        if (kubun === 'タスク') {
            if (priority) row['優先度']   = priority;
            if (start)    row['開始予定'] = start.replace(/-/g, '/');
            if (end)      row['終了予定'] = end.replace(/-/g, '/');
            if (estimate) row['見積時間'] = estimate;
        }
        if (kubun === 'ナレッジ') {
            if (input)  row['Input']  = input;
            if (output) row['Output'] = output;
        }
    });

    selectedEditIds.clear();
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
    renderEdit();
    renderRecentItems();
});

/** 「削除」ボタン: 選択行をメインデータから完全に削除する。 */
document.getElementById('edit-delete-btn')?.addEventListener('click', () => {
    if (selectedEditIds.size === 0) { alert('削除する行を選択してください'); return; }
    if (!confirm(`選択した ${selectedEditIds.size} 件を削除します。よろしいですか？（この操作は取り消せません）`)) return;

    currentMainData = currentMainData.filter(r => !selectedEditIds.has(String(r['ID'])));

    selectedEditIds.clear();
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
    renderEdit();
    renderRecentItems();
});

// ===== マスタ管理 =====

/**
 * dataModel.js の固定列（MAIN_DATA_COLUMNS/MASTER_DATA_COLUMNS）と、
 * 実データ（currentMainData/currentMasterData）の各行に実際に存在するキーとの和集合を返す。
 * Excelで新しい列を追加した場合でも、この関数経由でチェックすれば
 * dataModel.jsを手動修正しなくても新しい変数名を認識できる。
 */
function getAllKnownColumns() {
    const columns = new Set([...MAIN_DATA_COLUMNS, ...MASTER_DATA_COLUMNS]);
    currentMainData.forEach(row => Object.keys(row).forEach(k => columns.add(k)));
    currentMasterData.forEach(row => Object.keys(row).forEach(k => columns.add(k)));
    return [...columns];
}

/**
 * MAIN_DATA_COLUMNS と currentMasterData を照合して警告リストを返す。
 * - MAIN_DATA_COLUMNSにあるがmasterData未登録の変数
 * - masterDataにあるがMAIN_DATA_COLUMNSに存在しない変数名
 * - (M)変数名/(M)変数分類/(M)変数説明のいずれかが空の行
 */
function computeMasterWarnings() {
    const warnings = [];
    // メイン・マスタ両方の列名を対象にする（dataModel.jsの固定列 ＋ 実データに存在する列名の和集合。
    // これにより、Excelで列を追加しただけでもdataModel.jsを修正せずに認識される）
    const ALL_COLUMNS = getAllKnownColumns();
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

/** 情報整理ページとダッシュボードの両方に警告バナーを描画する。 */
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

/** マスタデータの空行を生成する。 */
function createEmptyMasterRow() {
    return Object.fromEntries(MASTER_DATA_COLUMNS.map(c => [c, '']));
}

/** 空のマスタデータ行を1件追加し、マスタデータ一覧テーブルを再描画する。 */
function addMasterRow() {
    currentMasterData.push(createEmptyMasterRow());
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
    renderDataTable('table-master', 'summary-master', currentMasterData, MASTER_DATA_COLUMNS, 'マスタデータ', { editable: true, onEdit: () => renderWarnings(computeMasterWarnings()) });
    renderWarnings(computeMasterWarnings());
}

document.getElementById('add-master-data-row-btn')?.addEventListener('click', addMasterRow);

// ===== ハブ管理（名前変更・削除・統合） =====

let hubAdminDeletePending = null; // 削除確認中のハブ名（使用中の場合、再割り当てUIを表示するため）

/** マスタに登録済みの全ハブ名（重複除去、有効/無効を問わない）を返す。1日タスク用の予約ハブは対象外。 */
function getAllHubNamesForAdmin() {
    return [...new Set(
        currentMasterData.map(r => r['(M)ハブ_子']).filter(Boolean)
    )].filter(name => name !== DAYPLAN_HUB);
}

/** 指定ハブ名がメインデータ（タスク／ナレッジ等）で使用されている件数を返す。 */
function countHubUsage(name) {
    return currentMainData.filter(r => r['ハブ'] === name).length;
}

/**
 * ハブ名を旧名から新名へ変更する。メインデータの参照とマスタの(M)ハブ_子を書き換える。
 * newName が既存の別ハブ名と一致する場合は実質的に統合（mergeHubInto）と同じ結果になる。
 */
function renameHubMaster(oldName, newName) {
    if (getAllHubNamesForAdmin().includes(newName) && newName !== oldName) {
        mergeHubInto(oldName, newName);
        return;
    }
    currentMainData.forEach(r => { if (r['ハブ'] === oldName) r['ハブ'] = newName; });
    currentMasterData.forEach(r => { if (r['(M)ハブ_子'] === oldName) r['(M)ハブ_子'] = newName; });
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
}

/**
 * マスタ行の (M)ハブ_親／(M)ハブ_子／(M)ハブ_ステータス のみを空欄化する。
 * マスタ行は複数の属性（変数登録・タグ・ハブ・ステータス等）を同じ行に持つ場合があるため、
 * ハブに関する列以外は保持する。全列が空になった行だけ最後に取り除く。
 */
function clearHubFieldsInMaster(hubName) {
    currentMasterData.forEach(r => {
        if (r['(M)ハブ_子'] === hubName) {
            r['(M)ハブ_親']       = '';
            r['(M)ハブ_子']       = '';
            r['(M)ハブ_ステータス'] = '';
        }
    });
    currentMasterData = currentMasterData.filter(r => Object.values(r).some(v => v !== '' && v != null));
}

/** sourceName のハブを targetName に統合する。メインデータの参照を付け替え、source側のマスタ行のハブ関連列だけを消す。 */
function mergeHubInto(sourceName, targetName) {
    currentMainData.forEach(r => { if (r['ハブ'] === sourceName) r['ハブ'] = targetName; });
    clearHubFieldsInMaster(sourceName);
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
}

/** ハブを削除する。reassignTo を指定すればそのハブへ再割り当てしてから削除、未指定なら参照を空欄にして削除する。 */
function deleteHub(name, reassignTo) {
    if (reassignTo) {
        mergeHubInto(name, reassignTo);
        return;
    }
    currentMainData.forEach(r => { if (r['ハブ'] === name) r['ハブ'] = ''; });
    clearHubFieldsInMaster(name);
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
}

/** 指定ハブ名の (M)ハブ_ステータス を切り替える（同名の全マスタ行に反映）。 */
function toggleHubStatus(name) {
    const nowActive = currentMasterData.some(r => r['(M)ハブ_子'] === name && isHubActive(r));
    currentMasterData.forEach(r => {
        if (r['(M)ハブ_子'] === name) r['(M)ハブ_ステータス'] = nowActive ? '0' : '';
    });
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
}

/** ハブ管理テーブルを描画する。名前変更・統合・削除の操作列を持つ。 */
function renderHubAdmin() {
    const table = document.getElementById('hub-admin-table');
    if (!table) return;

    const hubNames = getAllHubNamesForAdmin();
    table.className = 'data-table';

    if (hubNames.length === 0) {
        const tbody = document.createElement('tbody');
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.className = 'empty-cell';
        td.textContent = '登録済みのハブがありません';
        tr.appendChild(td);
        tbody.appendChild(tr);
        table.replaceChildren(tbody);
        return;
    }

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    ['ハブ名', '使用件数', '状態', '名前変更', '統合', '削除'].forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    hubNames.forEach(name => {
        const count = countHubUsage(name);
        const otherNames = hubNames.filter(n => n !== name);

        const tr = document.createElement('tr');

        const nameTd = document.createElement('td');
        nameTd.textContent = name;
        tr.appendChild(nameTd);

        const countTd = document.createElement('td');
        countTd.textContent = String(count);
        tr.appendChild(countTd);

        // 状態（表示/非表示の切り替え）
        const statusTd = document.createElement('td');
        const active = currentMasterData.some(r => r['(M)ハブ_子'] === name && isHubActive(r));
        const statusBtn = document.createElement('button');
        statusBtn.textContent = active ? '表示中' : '非表示中';
        statusBtn.className = active ? 'hub-admin-status-btn hub-admin-status-btn--on' : 'hub-admin-status-btn hub-admin-status-btn--off';
        statusBtn.addEventListener('click', () => {
            toggleHubStatus(name);
            renderHubAdmin();
            renderCalendar();
        });
        statusTd.appendChild(statusBtn);
        tr.appendChild(statusTd);

        // 名前変更
        const renameTd = document.createElement('td');
        const renameInput = document.createElement('input');
        renameInput.type = 'text';
        renameInput.placeholder = '新しい名前';
        renameInput.className = 'hub-admin-input';
        const renameBtn = document.createElement('button');
        renameBtn.textContent = '変更';
        renameBtn.addEventListener('click', () => {
            const newName = renameInput.value.trim();
            if (!newName || newName === name) return;
            renameHubMaster(name, newName);
            hubAdminDeletePending = null;
            renderHubAdmin();
            renderCalendar();
        });
        renameTd.append(renameInput, renameBtn);
        tr.appendChild(renameTd);

        // 統合
        const mergeTd = document.createElement('td');
        if (otherNames.length > 0) {
            const mergeSelect = document.createElement('select');
            otherNames.forEach(n => {
                const opt = document.createElement('option');
                opt.value = n;
                opt.textContent = n;
                mergeSelect.appendChild(opt);
            });
            const mergeBtn = document.createElement('button');
            mergeBtn.textContent = 'このハブへ統合';
            mergeBtn.addEventListener('click', () => {
                if (!confirm(`「${name}」を「${mergeSelect.value}」に統合します。「${name}」を使用中の全タスク／ナレッジが「${mergeSelect.value}」に書き換わります。よろしいですか？`)) return;
                mergeHubInto(name, mergeSelect.value);
                hubAdminDeletePending = null;
                renderHubAdmin();
                renderCalendar();
            });
            mergeTd.append(mergeSelect, mergeBtn);
        } else {
            mergeTd.textContent = '（統合先なし）';
        }
        tr.appendChild(mergeTd);

        // 削除
        const deleteTd = document.createElement('td');
        if (hubAdminDeletePending === name) {
            const p = document.createElement('p');
            p.className = 'warning-text';
            p.textContent = `「${name}」は${count}件のタスク／ナレッジに割り当てられています。`;
            deleteTd.appendChild(p);

            if (otherNames.length > 0) {
                const reassignSelect = document.createElement('select');
                otherNames.forEach(n => {
                    const opt = document.createElement('option');
                    opt.value = n;
                    opt.textContent = n;
                    reassignSelect.appendChild(opt);
                });
                const reassignBtn = document.createElement('button');
                reassignBtn.textContent = '再割り当てして削除';
                reassignBtn.addEventListener('click', () => {
                    deleteHub(name, reassignSelect.value);
                    hubAdminDeletePending = null;
                    renderHubAdmin();
                    renderCalendar();
                });
                deleteTd.append(reassignSelect, reassignBtn);
            }

            const unassignBtn = document.createElement('button');
            unassignBtn.className = 'calendar-danger-btn';
            unassignBtn.textContent = '割り当てずに削除';
            unassignBtn.addEventListener('click', () => {
                if (!confirm(`「${name}」を削除し、割り当てられていた${count}件のハブを空欄にします。よろしいですか？`)) return;
                deleteHub(name, null);
                hubAdminDeletePending = null;
                renderHubAdmin();
                renderCalendar();
            });
            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = 'キャンセル';
            cancelBtn.addEventListener('click', () => {
                hubAdminDeletePending = null;
                renderHubAdmin();
            });
            deleteTd.append(unassignBtn, cancelBtn);
        } else {
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'calendar-danger-btn';
            deleteBtn.textContent = '削除';
            deleteBtn.addEventListener('click', () => {
                if (count === 0) {
                    if (!confirm(`「${name}」を削除します。よろしいですか？`)) return;
                    deleteHub(name, null);
                    renderHubAdmin();
                    renderCalendar();
                } else {
                    hubAdminDeletePending = name;
                    renderHubAdmin();
                }
            });
            deleteTd.appendChild(deleteBtn);
        }
        tr.appendChild(deleteTd);

        tbody.appendChild(tr);
    });

    table.replaceChildren(thead, tbody);
}

/** 空のメインデータ行を1件追加し、メインデータ一覧テーブルを再描画する。 */
document.getElementById('add-main-row-btn')?.addEventListener('click', () => {
    const maxId = currentMainData.reduce((max, row) => {
        const id = parseInt(row['ID'], 10);
        return isNaN(id) ? max : Math.max(max, id);
    }, 0);

    const entry = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
    entry['ID']      = String(maxId + 1);
    entry['カテゴリ'] = currentCategory === 'すべて' ? '' : currentCategory;

    currentMainData.push(entry);
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);

    renderDataTable('table-main', 'summary-main', getFilteredMainData(), MAIN_DATA_COLUMNS, 'メインデータ', { editable: true, idColumn: 'ID' });
    renderRecentItems();
});

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

/**
 * GitHubからデータを読み込み、失敗時はローカルキャッシュへフォールバックする。
 * (2) インプット: token (string), silent (boolean) - trueの場合トークン未入力時にアラートを出さない
 */
async function loadFromGithub(token, silent = false) {
    const contentBox = document.getElementById('content-box');
    const statusEl    = document.getElementById('network-status');

    if (!token) { if (!silent) alert('トークンを入力してください'); return; }
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
            if (!silent) alert('通信できませんでした。スマホ内に一時保存されている前回のデータを表示します。');
        } else {
            contentBox.textContent = `エラー: ${error.message}（端末内にキャッシュもありません）`;
        }
    }
}

document.getElementById('load-btn')?.addEventListener('click', () => {
    loadFromGithub(document.getElementById('token-input').value.trim());
});

// ===== GitHubへ保存 =====
document.getElementById('save-btn')?.addEventListener('click', async () => {
    const token      = document.getElementById('token-input').value.trim();
    const contentBox = document.getElementById('content-box');
    const statusEl   = document.getElementById('network-status');

    if (!token)      return alert('トークンを入力してください');
    if (!currentSha) return alert('先にデータを読み込んでください（またはオフラインキャッシュを読み込んでください）');

    const newMarkdown = stringifyMarkdown(currentMainData, currentMasterData);

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

/** (M)ハブ_ステータスが '0'（無効）でない行かどうかを判定する。未入力は有効扱いにする。 */
function isHubActive(row) {
    return row['(M)ハブ_ステータス'] !== '0' && row['(M)ハブ_ステータス'] !== 0;
}

/**
 * 選択中のカテゴリに属する、有効な（(M)ハブ_ステータスが0でない）ハブ名一覧を返す。
 * 「すべて」選択時は (M)ハブ_子 の全値を返す。
 * それ以外は (M)ハブ_親 === currentCategory の行の (M)ハブ_子 を返す。
 * @returns {string[]}
 */
export function getFilteredHubs() {
    if (currentCategory === 'すべて') {
        return [...new Set(
            currentMasterData.filter(isHubActive).map(r => r['(M)ハブ_子']).filter(Boolean)
        )];
    }
    return currentMasterData
        .filter(r => r['(M)ハブ_親'] === currentCategory && isHubActive(r))
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

/** タスク実行UIを描画 */
function renderTaskRunner() {
    const container = document.getElementById('task-runner-dash');
    if (container) buildTaskRunnerUI(container);
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
            renderEditTable();
        });
        changeTb.appendChild(changeBtn);
        statusSec.appendChild(changeTb);
        panel.appendChild(statusSec);
    }

    container.appendChild(panel);
}

// ===== カレンダー =====

/** 選択肢（Set）が空なら常にtrue、そうでなければ値がSetに含まれるかを判定する。 */
function matchesMultiFilter(selectedSet, value) {
    return selectedSet.size === 0 || selectedSet.has(value);
}

/** 1日タスク（その日のタイムスケジュールを文法で記述する特殊タスク）を表す予約ハブ名。 */
const DAYPLAN_HUB = '1日タスク';

/** データ区分がタスクで、開始予定または終了予定が dateJP（"YYYY/MM/DD"）と一致する行を、カテゴリ・calendarFilters で絞り込んで返す。1日タスク自体は含まない。 */
/** 完了・中断・報告待ち・連絡待ちのステータスなら「残務なし（緑）」扱いとする。 */
const CALENDAR_DONE_STATUSES = ['完了', '中断', '報告待ち', '連絡待ち'];
function isTaskDoneForCalendar(row) {
    return CALENDAR_DONE_STATUSES.includes(row['ステータス']);
}

/**
 * タスクの●印を出す日を1日だけ決定する。
 * 残務なし（完了・中断・報告待ち・連絡待ち）: 完了日があればその日、無ければ印なし（null）。
 * 残務あり: today を 開始予定〜終了予定 の範囲にクランプした日（未来なら開始予定、期間内なら today、過ぎていたら終了予定）。
 */
function getCalendarMarkDate(row, todayJP) {
    const start = jpDateOnly(row['開始予定']);
    const end   = jpDateOnly(row['終了予定']) || start;

    if (isTaskDoneForCalendar(row)) {
        const done = jpDateOnly(row['完了日']);
        return done || null;
    }

    if (!start) return null;
    if (todayJP < start) return start;
    if (todayJP > end)   return end;
    return todayJP;
}

/** dateJP に●印が出るタスク（フィルタ適用済み）を返す。●の判定とクリック後の一覧表示で共有するロジック。 */
function getTasksForDate(dateJP) {
    const todayJP = jpDateOnly(formatJpDatetime(new Date()));
    return getFilteredMainData().filter(r => {
        if (r['データ区分'] !== 'タスク') return false;
        if (r['ハブ'] === DAYPLAN_HUB) return false;
        if (getCalendarMarkDate(r, todayJP) !== dateJP) return false;
        if (!matchesMultiFilter(calendarFilters.tag, r['タグ'])) return false;
        if (!matchesMultiFilter(calendarFilters.hub, r['ハブ'])) return false;
        if (!matchesMultiFilter(calendarFilters.status, r['ステータス'])) return false;
        return true;
    });
}

/** 指定日の1日タスク（ハブ=DAYPLAN_HUB、開始予定=dateJP のタスク行）を返す。無ければ null。 */
function getDayPlanTask(dateJP) {
    return currentMainData.find(r =>
        r['データ区分'] === 'タスク' && r['ハブ'] === DAYPLAN_HUB && jpDateOnly(r['開始予定']) === dateJP
    ) || null;
}

/**
 * 1日タスクの内容欄を「HH:MM-HH:MM [#ID] [ラベル]」形式の行としてパースする。
 * @returns {Array<{startMin:number, endMin:number, refId:?string, label:string}>}
 */
function parseDayPlanContent(content) {
    if (!content) return [];
    const lineRe = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\s*(?:#(\S+))?\s*(.*)$/;
    return content.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
        const m = line.match(lineRe);
        if (!m) return null;
        const startMin = Number(m[1]) * 60 + Number(m[2]);
        let endMin = Number(m[3]) * 60 + Number(m[4]);
        if (endMin <= startMin) endMin = startMin + 15;
        return {
            startMin: Math.max(0, Math.min(1439, startMin)),
            endMin:   Math.max(startMin + 15, Math.min(1440, endMin)),
            refId:    m[5] || null,
            label:    (m[6] || '').trim()
        };
    }).filter(Boolean);
}

/** データ区分がタスクで、指定フィールドが value と一致し、ステータスが完了・中断以外の件数を、カテゴリで絞り込んで返す。 */
function countActiveTasksByField(field, value) {
    return getFilteredMainData().filter(r =>
        r['データ区分'] === 'タスク' && r[field] === value &&
        r['ステータス'] !== '完了' && r['ステータス'] !== '中断'
    ).length;
}

/** データ区分がタスクで、指定フィールドが value と一致する件数を（ステータスを問わず）、カテゴリで絞り込んで返す。 */
function countTasksByField(field, value) {
    return getFilteredMainData().filter(r => r['データ区分'] === 'タスク' && r[field] === value).length;
}

/** 選択肢を複数選択可能なチップ（チェックボックス）群として描画し、選択中はハイライトする。 */
function createCalendarMultiFilter(options, selectedSet, buildLabel, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'calendar-multi-filter';
    options.forEach(v => {
        const label = document.createElement('label');
        label.className = 'calendar-multi-filter-chip' + (selectedSet.has(v) ? ' calendar-multi-filter-chip--active' : '');

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selectedSet.has(v);
        cb.addEventListener('change', () => {
            if (cb.checked) selectedSet.add(v); else selectedSet.delete(v);
            onChange();
        });

        label.append(cb, document.createTextNode(buildLabel(v)));
        wrap.appendChild(label);
    });
    return wrap;
}

/** options を件数（N）の多い順にソートして返す。 */
function sortByTotalCountDesc(options, field) {
    return [...options].sort((a, b) => countTasksByField(field, b) - countTasksByField(field, a));
}

/**
 * タグ／ハブ／ステータスの絞り込みチップ（いずれも複数選択可、件数(n/N)併記・N降順）を area に描画する。
 * カレンダー・ガントチャートなど複数箇所から共通利用する。
 * @param {HTMLElement} area     - チップ群を描画する要素
 * @param {{tag:Set, hub:Set, status:Set}} filters - 選択状態を持つフィルタ値（複数選択）
 * @param {Function} onChange    - 選択変更時に呼ぶ再描画コールバック
 */
function renderTagHubStatusFilters(area, filters, onChange) {
    if (!area) return;
    area.innerHTML = '';

    function makeRow(labelText, ctrl) {
        const row = document.createElement('div');
        row.className = 'triage-filter-row';
        const lbl = document.createElement('span');
        lbl.className = 'triage-filter-label';
        lbl.textContent = labelText;
        row.append(lbl, ctrl);
        area.appendChild(row);
    }

    makeRow('タグ', createCalendarMultiFilter(
        sortByTotalCountDesc(getFilteredTags(), 'タグ'), filters.tag,
        v => `${v} (${countActiveTasksByField('タグ', v)}/${countTasksByField('タグ', v)})`,
        onChange
    ));
    makeRow('ハブ', createCalendarMultiFilter(
        sortByTotalCountDesc(getFilteredHubs(), 'ハブ'), filters.hub,
        v => `${v} (${countActiveTasksByField('ハブ', v)}/${countTasksByField('ハブ', v)})`,
        onChange
    ));

    const taskStatuses = [...new Set(
        currentMasterData.filter(r => r['(M)ステータス_親'] === 'タスク')
            .map(r => r['(M)ステータス_子']).filter(Boolean)
    )];
    makeRow('ステータス', createCalendarMultiFilter(
        sortByTotalCountDesc(taskStatuses, 'ステータス'), filters.status,
        v => `${v} (${countActiveTasksByField('ステータス', v)}/${countTasksByField('ステータス', v)})`,
        onChange
    ));
}

/** カレンダー上部のタグ／ハブ／ステータスフィルタ（いずれも複数選択可）を描画する。 */
function renderCalendarFilters() {
    renderTagHubStatusFilters(document.getElementById('calendar-filter-area'), calendarFilters, () => renderCalendar());
}

/** タグ／ハブ／ステータスでフィルタ中のタスク一覧（日付を問わず全件）を、開始予定・終了予定の早い順に返す。 */
function getCalendarFilteredTaskList() {
    if (calendarFilters.tag.size === 0 && calendarFilters.hub.size === 0 && calendarFilters.status.size === 0) return [];

    const tasks = getFilteredMainData().filter(r => {
        if (r['データ区分'] !== 'タスク') return false;
        if (r['ハブ'] === DAYPLAN_HUB) return false;
        if (!matchesMultiFilter(calendarFilters.tag, r['タグ'])) return false;
        if (!matchesMultiFilter(calendarFilters.hub, r['ハブ'])) return false;
        if (!matchesMultiFilter(calendarFilters.status, r['ステータス'])) return false;
        return true;
    });

    tasks.sort((a, b) => {
        const aKey = a['開始予定'] || a['終了予定'] || '';
        const bKey = b['開始予定'] || b['終了予定'] || '';
        if (!aKey && !bKey) return 0;
        if (!aKey) return 1;
        if (!bKey) return -1;
        return aKey.localeCompare(bKey);
    });

    return tasks;
}

/** タグ／ハブでフィルタ中のタスク一覧テーブルを描画する（未フィルタ時は非表示）。 */
function renderCalendarTaskList() {
    const table = document.getElementById('calendar-task-list-table');
    if (!table) return;

    const tasks = getCalendarFilteredTaskList();
    const wrapper = table.closest('.table-wrapper');
    if (wrapper) wrapper.style.display = '';

    table.className = 'data-table';
    const cols = ['ID', 'タイトル', 'ステータス', '開始予定', '終了予定', '完了日'];

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    cols.forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    tasks.forEach(row => {
        const tr = document.createElement('tr');
        if (String(row['ID']) === selectedCalendarTaskId) tr.classList.add('selected-row');
        cols.forEach(col => {
            const td = document.createElement('td');
            td.textContent = row[col] ?? '';
            tr.appendChild(td);
        });
        tr.addEventListener('click', () => selectCalendarTaskFromList(row));
        tbody.appendChild(tr);
    });

    // 末尾に新規作成用の行を追加（日付遷移なしで空欄のタスク登録モードを開く）
    const newTr = document.createElement('tr');
    newTr.className = 'calendar-task-list-new-row';
    if (calendarQuickNewMode) newTr.classList.add('selected-row');
    cols.forEach(col => {
        const td = document.createElement('td');
        td.textContent = col === 'タイトル' ? '（新規作成）' : '';
        newTr.appendChild(td);
    });
    newTr.addEventListener('click', startCalendarQuickNewTask);
    tbody.appendChild(newTr);

    table.replaceChildren(thead, tbody);
}

/** タスク一覧から選択した行を、対応する日付・月へカレンダーを連動させつつ編集対象にする。 */
function selectCalendarTaskFromList(row) {
    const dateValue = row['開始予定'] || row['終了予定'];
    if (dateValue) {
        const datePart = dateValue.split(' ')[0];
        const [y, m, d] = datePart.split('/').map(Number);
        if (y && m && d) {
            calendarYear  = y;
            calendarMonth = m - 1;
            selectedCalendarDate = datePart;
        }
    }
    selectedCalendarTaskId = String(row['ID']);
    calendarQuickNewMode   = false;
    renderCalendar();
}

/** タスク一覧末尾の「（新規作成）」行をクリックした際、日付を空欄にした新規登録モードで編集パネルを開く。 */
function startCalendarQuickNewTask() {
    selectedCalendarTaskId = null;
    calendarQuickNewMode   = true;
    renderCalendarDetail();
}

/** 「タスク整理」のビュー切り替えボタン（カレンダー／ガントチャート）の表示状態を反映する。 */
function renderTaskOrgViewToggle() {
    document.getElementById('taskorg-tab-calendar')?.classList.toggle('taskorg-view-btn--active', taskOrgView === 'calendar');
    document.getElementById('taskorg-tab-gantt')?.classList.toggle('taskorg-view-btn--active', taskOrgView === 'gantt');
    const calEl   = document.getElementById('taskorg-view-calendar');
    const ganttEl = document.getElementById('taskorg-view-gantt');
    if (calEl)   calEl.style.display   = taskOrgView === 'calendar' ? '' : 'none';
    if (ganttEl) ganttEl.style.display = taskOrgView === 'gantt'    ? '' : 'none';
}

document.getElementById('taskorg-tab-calendar')?.addEventListener('click', () => { taskOrgView = 'calendar'; renderCalendar(); });
document.getElementById('taskorg-tab-gantt')?.addEventListener('click', () => { taskOrgView = 'gantt'; renderCalendar(); });

/** ガントチャートの日／週切り替えボタンの表示状態を反映する。 */
function renderGanttUnitToggle() {
    document.getElementById('gantt-unit-day')?.classList.toggle('gantt-unit-btn--active', ganttViewUnit === 'day');
    document.getElementById('gantt-unit-week')?.classList.toggle('gantt-unit-btn--active', ganttViewUnit === 'week');
}

document.getElementById('gantt-unit-day')?.addEventListener('click', () => { ganttViewUnit = 'day'; renderGanttUnitToggle(); renderGanttChart(); });
document.getElementById('gantt-unit-week')?.addEventListener('click', () => { ganttViewUnit = 'week'; renderGanttUnitToggle(); renderGanttChart(); });

/** 「タスク整理」セクション全体（ビュー切替・フィルタ・カレンダー/ガントチャート・詳細ビュー）を再描画する。 */
function renderCalendar() {
    renderTaskOrgViewToggle();
    renderCalendarFilters();
    if (taskOrgView === 'calendar') {
        renderCalendarTaskList();
        renderCalendarGrid();
    } else {
        renderGanttUnitToggle();
        renderGanttChart();
    }
    renderCalendarDetail();
}

/** 現在の calendarYear / calendarMonth に基づいて月カレンダーを描画する。 */
function renderCalendarGrid() {
    const label = document.getElementById('calendar-month-label');
    if (label) label.textContent = `${calendarYear}年${calendarMonth + 1}月`;

    const grid = document.getElementById('calendar-grid');
    if (!grid) return;
    grid.innerHTML = '';

    ['日', '月', '火', '水', '木', '金', '土'].forEach(d => {
        const head = document.createElement('div');
        head.className = 'calendar-day-head';
        head.textContent = d;
        grid.appendChild(head);
    });

    const todayJP        = jpDateOnly(formatJpDatetime(new Date()));
    const startWeekday   = new Date(calendarYear, calendarMonth, 1).getDay();
    const daysInMonth    = new Date(calendarYear, calendarMonth + 1, 0).getDate();
    const pad            = n => String(n).padStart(2, '0');

    for (let i = 0; i < startWeekday; i++) {
        const cell = document.createElement('div');
        cell.className = 'calendar-day calendar-day--empty';
        grid.appendChild(cell);
    }

    for (let d = 1; d <= daysInMonth; d++) {
        const dateJP = `${calendarYear}/${pad(calendarMonth + 1)}/${pad(d)}`;
        const cell = document.createElement('div');
        cell.className = 'calendar-day';
        if (dateJP === todayJP)             cell.classList.add('calendar-day--today');
        if (dateJP === selectedCalendarDate) cell.classList.add('calendar-day--selected');

        const num = document.createElement('div');
        num.className = 'calendar-day-num';
        num.textContent = String(d);
        cell.appendChild(num);

        const dayTasks = getTasksForDate(dateJP);
        if (dayTasks.length > 0) {
            const hasRemaining = dayTasks.some(r => !isTaskDoneForCalendar(r));
            const badge = document.createElement('span');
            badge.className = `calendar-day-badge ${hasRemaining ? 'calendar-day-badge--red' : 'calendar-day-badge--green'}`;
            badge.textContent = '●';
            badge.title = `${dayTasks.length} 件の予定`;
            cell.appendChild(badge);
        }

        cell.addEventListener('click', () => {
            selectedCalendarDate   = dateJP;
            selectedCalendarTaskId = null;
            calendarQuickNewMode   = false;
            renderCalendar();
        });
        grid.appendChild(cell);
    }
}

/** value（"YYYY/MM/DD" または "YYYY/MM/DD HH:mm"）が dateJP と同じ日付かどうかを調べ、時刻情報を返す。 */
function extractTimeOnDate(value, dateJP) {
    if (!value) return null;
    const [datePart, timePart] = value.split(' ');
    if (datePart !== dateJP) return null;
    if (!timePart) return { hasTime: false, minutes: null };
    const [h, m] = timePart.split(':').map(Number);
    if (isNaN(h) || isNaN(m)) return { hasTime: false, minutes: null };
    return { hasTime: true, minutes: h * 60 + m };
}

/**
 * dateJP のタスクを「時間帯が決まっているもの（timed）」と「時間帯未定（unscheduled）」に分ける。
 * timed の各要素は { row, startMin, endMin }（分単位、0〜1440）。
 * 1日タスクの内容欄で#ID参照されているタスクは、元タスク側の時間帯表示を省き1日タスク側のブロックのみ表示する。
 */
function getCalendarSegmentsForDate(dateJP) {
    const dayPlanTask   = getDayPlanTask(dateJP);
    const dayPlanBlocks = dayPlanTask ? parseDayPlanContent(dayPlanTask['内容']) : [];
    const referencedIds = new Set(dayPlanBlocks.map(b => b.refId).filter(Boolean));

    const timed = [];
    const unscheduled = [];

    getTasksForDate(dateJP).forEach(row => {
        if (referencedIds.has(String(row['ID']))) return;

        const startInfo = extractTimeOnDate(row['開始予定'], dateJP);
        const endInfo   = extractTimeOnDate(row['終了予定'], dateJP);
        const hasStartTime = !!(startInfo && startInfo.hasTime);
        const hasEndTime   = !!(endInfo && endInfo.hasTime);

        if (!hasStartTime && !hasEndTime) {
            unscheduled.push(row);
            return;
        }

        let startMin = hasStartTime ? startInfo.minutes : endInfo.minutes - 30;
        let endMin   = hasEndTime   ? endInfo.minutes   : startInfo.minutes + 30;
        if (endMin <= startMin) endMin = startMin + 30;
        startMin = Math.max(0, Math.min(1439, startMin));
        endMin   = Math.max(startMin + 15, Math.min(1440, endMin));

        timed.push({ row, startMin, endMin });
    });

    dayPlanBlocks.forEach(b => {
        const linkedRow = b.refId ? currentMainData.find(r => String(r['ID']) === b.refId) : null;
        timed.push({
            row: linkedRow || { ID: null, タイトル: b.label || '（ラベルなし）', ステータス: null },
            startMin: b.startMin,
            endMin: b.endMin,
            isDayPlanBlock: true
        });
    });

    timed.sort((a, b) => a.startMin - b.startMin);
    return { timed, unscheduled };
}

/** 時間帯が重なるタスクを横に並べるためのレーン番号を割り振る。 */
function assignCalendarLanes(timed) {
    const laneEnds = [];
    timed.forEach(seg => {
        let lane = laneEnds.findIndex(endMin => endMin <= seg.startMin);
        if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
        laneEnds[lane] = seg.endMin;
        seg.lane = lane;
    });
    const laneCount = laneEnds.length || 1;
    timed.forEach(seg => { seg.laneCount = laneCount; });
}

const CALENDAR_HOUR_HEIGHT = 40; // 1時間あたりの高さ(px)

/** タスクのステータスに応じたタイムラインブロックの配色クラスを返す（未着手=灰／進行中=青／連絡待ち・報告待ち・中断=紫／その他=緑）。 */
function getCalendarStatusClass(status) {
    if (status === '未着手') return 'calendar-time-block--todo';
    if (status === '進行中') return 'calendar-time-block--doing';
    if (['連絡待ち', '報告待ち', '中断'].includes(status)) return 'calendar-time-block--waiting';
    return 'calendar-time-block--done';
}

/** 1日の時間軸（0:00〜24:00の目盛り）とタスクの時間帯ブロックを描画する。 */
function renderCalendarTimeline(dateJP) {
    const hoursEl = document.getElementById('calendar-timeline-hours');
    const lanesEl = document.getElementById('calendar-timeline-lanes');
    if (!hoursEl || !lanesEl) return;

    const totalHeight = CALENDAR_HOUR_HEIGHT * 24;
    hoursEl.style.height = `${totalHeight}px`;
    lanesEl.style.height = `${totalHeight}px`;

    hoursEl.innerHTML = '';
    for (let h = 0; h < 24; h++) {
        const row = document.createElement('div');
        row.className = 'calendar-hour-row';
        row.style.height = `${CALENDAR_HOUR_HEIGHT}px`;
        row.textContent = `${String(h).padStart(2, '0')}:00`;
        hoursEl.appendChild(row);
    }

    lanesEl.innerHTML = '';
    const { timed } = getCalendarSegmentsForDate(dateJP);
    assignCalendarLanes(timed);

    const pxPerMin = CALENDAR_HOUR_HEIGHT / 60;
    const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

    timed.forEach(seg => {
        const laneWidthPct = 100 / seg.laneCount;
        const block = document.createElement('div');
        const hasLinkedTask = seg.row['ID'] != null;
        block.className = `calendar-time-block ${hasLinkedTask ? getCalendarStatusClass(seg.row['ステータス']) : 'calendar-time-block--dayplan'}`;
        if (hasLinkedTask && String(seg.row['ID']) === selectedCalendarTaskId) block.classList.add('calendar-time-block--selected');
        block.style.top    = `${seg.startMin * pxPerMin}px`;
        block.style.height = `${(seg.endMin - seg.startMin) * pxPerMin}px`;
        block.style.left   = `${seg.lane * laneWidthPct}%`;
        block.style.width  = `calc(${laneWidthPct}% - 4px)`;
        block.textContent  = `${fmt(seg.startMin)}–${fmt(seg.endMin)} ${seg.row['タイトル'] || '（無題）'}`;
        if (hasLinkedTask) block.addEventListener('click', () => openCalendarTaskEdit(String(seg.row['ID'])));
        lanesEl.appendChild(block);
    });

    // デフォルトで 8:00〜18:00 が見える位置までスクロールする
    const scrollEl = document.getElementById('calendar-timeline-scroll');
    if (scrollEl) scrollEl.scrollTop = 8 * CALENDAR_HOUR_HEIGHT;
}

/** 1日タスクの作成ボタン／編集エリアを、選択中の日付の状態に合わせて描画する。 */
function renderDayPlanSection() {
    const createBtn = document.getElementById('dayplan-create-btn');
    const editor     = document.getElementById('dayplan-editor');
    const contentEl  = document.getElementById('dayplan-content');
    if (!createBtn || !editor || !contentEl) return;

    if (!selectedCalendarDate) {
        createBtn.style.display = 'none';
        editor.style.display = 'none';
        return;
    }

    const dayPlan = getDayPlanTask(selectedCalendarDate);
    if (dayPlan) {
        createBtn.style.display = 'none';
        editor.style.display = '';
        if (document.activeElement !== contentEl) contentEl.value = dayPlan['内容'] || '';
    } else {
        createBtn.style.display = '';
        editor.style.display = 'none';
        contentEl.value = '';
    }
}

/** 選択中日付の1日タスクを新規作成する（ハブ=DAYPLAN_HUB、開始予定=選択中日付、内容は空欄）。 */
function createDayPlanTask() {
    if (!selectedCalendarDate) return;

    const maxId = currentMainData.reduce((max, row) => {
        const id = parseInt(row['ID'], 10);
        return isNaN(id) ? max : Math.max(max, id);
    }, 0);
    const ts = formatJpDatetime(new Date());

    const entry = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
    entry['ID']        = String(maxId + 1);
    entry['データ区分'] = 'タスク';
    entry['タイトル']   = `1日タスク ${selectedCalendarDate}`;
    entry['ハブ']       = DAYPLAN_HUB;
    entry['開始予定']   = selectedCalendarDate;
    entry['ステータス'] = '未着手';
    entry['作成日時']   = ts;
    entry['更新日時']   = ts;

    currentMainData.push(entry);
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
    renderCalendarDetail();
    renderCalendarGrid();
}

/** 編集エリアの内容をその日の1日タスクに保存する。 */
function saveDayPlanContent() {
    if (!selectedCalendarDate) return;
    const dayPlan = getDayPlanTask(selectedCalendarDate);
    if (!dayPlan) return;
    const contentEl = document.getElementById('dayplan-content');
    dayPlan['内容']     = contentEl ? contentEl.value : '';
    dayPlan['更新日時'] = formatJpDatetime(new Date());
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
    renderCalendarTimeline(selectedCalendarDate);
}

/** 選択中日付の1日タスクを削除する。 */
function deleteDayPlanTask() {
    if (!selectedCalendarDate) return;
    const dayPlan = getDayPlanTask(selectedCalendarDate);
    if (!dayPlan) return;
    currentMainData = currentMainData.filter(r => r !== dayPlan);
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
    renderCalendarDetail();
    renderCalendarGrid();
}

document.getElementById('dayplan-create-btn')?.addEventListener('click', createDayPlanTask);
document.getElementById('dayplan-save-btn')?.addEventListener('click', saveDayPlanContent);
document.getElementById('dayplan-delete-btn')?.addEventListener('click', deleteDayPlanTask);

/** 選択中の日付の詳細ビュー（時間帯未定タスク・1日の予定表・属性編集パネル）を描画する。 */
function renderCalendarDetail() {
    const titleEl       = document.getElementById('calendar-detail-title');
    const unscheduledEl = document.getElementById('calendar-unscheduled-list');
    if (!titleEl) return;

    if (!selectedCalendarDate) {
        titleEl.textContent = 'カレンダーで日付を選択してください';
        if (unscheduledEl) unscheduledEl.innerHTML = '';
        const hoursEl = document.getElementById('calendar-timeline-hours');
        const lanesEl = document.getElementById('calendar-timeline-lanes');
        if (hoursEl) hoursEl.innerHTML = '';
        if (lanesEl) lanesEl.innerHTML = '';
        renderDayPlanSection();
        renderCalendarTaskEdit();
        return;
    }

    titleEl.textContent = selectedCalendarDate;
    renderDayPlanSection();

    const { unscheduled } = getCalendarSegmentsForDate(selectedCalendarDate);
    if (unscheduledEl) {
        unscheduledEl.innerHTML = '';
        if (unscheduled.length === 0) {
            const p = document.createElement('p');
            p.className = 'calendar-empty-text';
            p.textContent = '時間帯未定のタスクはありません';
            unscheduledEl.appendChild(p);
        } else {
            unscheduled.forEach(row => {
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = `calendar-unscheduled-chip ${getCalendarStatusClass(row['ステータス'])}`;
                if (String(row['ID']) === selectedCalendarTaskId) chip.classList.add('calendar-unscheduled-chip--selected');
                chip.textContent = row['タイトル'] || '（無題）';
                chip.addEventListener('click', () => openCalendarTaskEdit(String(row['ID'])));
                unscheduledEl.appendChild(chip);
            });
        }
    }

    renderCalendarTimeline(selectedCalendarDate);
    renderCalendarTaskEdit();
}

/** 指定タスクを属性編集パネルの対象にする。 */
function openCalendarTaskEdit(taskId) {
    selectedCalendarTaskId = taskId;
    calendarQuickNewMode = false;
    renderCalendarDetail();
}

/**
 * 属性編集パネルを描画する。選択中タスクがあれば編集モード（値を反映）、
 * 無ければ新規登録モード（フォームをクリアし、開始予定を選択中の日付で初期化）にする。
 */
function renderCalendarTaskEdit() {
    const panel = document.getElementById('calendar-task-edit');
    if (!panel) return;

    const statuses = [...new Set(
        currentMasterData.filter(r => r['(M)ステータス_親'] === 'タスク')
            .map(r => r['(M)ステータス_子']).filter(Boolean)
    )];
    rebuildSelectById('dayedit-status',   statuses);
    rebuildSelectById('dayedit-priority', [...new Set(currentMasterData.map(r => r['(M)優先度']).filter(Boolean))]);
    rebuildSelectById('dayedit-category', [...new Set(currentMasterData.map(r => r['(M)カテゴリ']).filter(Boolean))]);
    rebuildSelectById('dayedit-tag',      getFilteredTags());
    rebuildSelectById('dayedit-hub',      getFilteredHubs());

    const row = selectedCalendarTaskId
        ? currentMainData.find(r => String(r['ID']) === selectedCalendarTaskId)
        : null;

    if (!row) {
        selectedCalendarTaskId = null;
        clearCalendarTaskEditForm();
        return;
    }

    document.getElementById('dayedit-id').value        = row['ID']         ?? '';
    document.getElementById('dayedit-title').value    = row['タイトル']   ?? '';
    document.getElementById('dayedit-content').value  = row['内容']       ?? '';
    document.getElementById('dayedit-biko').value     = row['備考']       ?? '';
    document.getElementById('dayedit-status').value   = row['ステータス'] ?? '';
    document.getElementById('dayedit-priority').value = row['優先度']     ?? '';
    document.getElementById('dayedit-category').value = row['カテゴリ']   ?? '';
    document.getElementById('dayedit-tag').value      = row['タグ']       ?? '';
    document.getElementById('dayedit-hub').value      = row['ハブ']       ?? '';

    const [startDate, startTime] = (row['開始予定'] || '').split(' ');
    const [endDate,   endTime]   = (row['終了予定'] || '').split(' ');
    const [startHour, startMinute] = (startTime || '').split(':');
    const [endHour,   endMinute]   = (endTime   || '').split(':');
    document.getElementById('dayedit-start-date').value   = startDate ? startDate.replace(/\//g, '-') : '';
    document.getElementById('dayedit-start-hour').value   = startHour   || '';
    document.getElementById('dayedit-start-minute').value = startMinute || '';
    document.getElementById('dayedit-end-date').value     = endDate ? endDate.replace(/\//g, '-') : '';
    document.getElementById('dayedit-end-hour').value     = endHour     || '';
    document.getElementById('dayedit-end-minute').value   = endMinute   || '';
    document.getElementById('dayedit-complete-date').value = (row['完了日'] || '').replace(/\//g, '-');
}

/**
 * 編集フォームをクリアし、新規登録モードの初期値を設定する。
 * - 開始予定・終了予定の日付: 選択中のカレンダー日付
 * - タグ／ハブ: カレンダーで絞り込み中の値があればそれ
 * - ステータス: 未着手／優先度: 中（マスタに存在する場合のみ反映）
 * - カテゴリ: サイドバーで選択中のカテゴリ（「すべて」以外）
 */
function clearCalendarTaskEditForm() {
    ['dayedit-id', 'dayedit-title', 'dayedit-content', 'dayedit-biko', 'dayedit-status', 'dayedit-priority',
     'dayedit-start-hour', 'dayedit-start-minute', 'dayedit-end-hour', 'dayedit-end-minute',
     'dayedit-complete-date', 'dayedit-category', 'dayedit-tag', 'dayedit-hub'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });

    // 一覧末尾の「（新規作成）」から起動した場合は、日付をカレンダー選択日で埋めずに空欄のままにする
    const dateValue = (!calendarQuickNewMode && selectedCalendarDate) ? selectedCalendarDate.replace(/\//g, '-') : '';
    const startDateEl = document.getElementById('dayedit-start-date');
    if (startDateEl) startDateEl.value = dateValue;
    const endDateEl = document.getElementById('dayedit-end-date');
    if (endDateEl) endDateEl.value = dateValue;

    // タグ／ハブが1つだけ選択されている場合のみ、新規タスクの初期値として反映する
    const tagEl = document.getElementById('dayedit-tag');
    if (tagEl && calendarFilters.tag.size === 1) tagEl.value = [...calendarFilters.tag][0];
    const hubEl = document.getElementById('dayedit-hub');
    if (hubEl && calendarFilters.hub.size === 1) hubEl.value = [...calendarFilters.hub][0];

    const statusEl = document.getElementById('dayedit-status');
    if (statusEl) statusEl.value = '未着手';
    const priorityEl = document.getElementById('dayedit-priority');
    if (priorityEl) priorityEl.value = '中';

    const categoryEl = document.getElementById('dayedit-category');
    if (categoryEl && currentCategory !== 'すべて') categoryEl.value = currentCategory;
}

/** 時・分の2つの<input type="number">から "HH:mm" 文字列を組み立てる（いずれか未入力なら空文字）。 */
function readCalendarTime(hourId, minuteId) {
    const hour   = document.getElementById(hourId).value;
    const minute = document.getElementById(minuteId).value;
    if (hour === '' || minute === '') return '';
    const pad = n => String(n).padStart(2, '0');
    return `${pad(hour)}:${pad(minute)}`;
}

/** 「適用」ボタン: 属性編集パネルの内容を選択中タスクへ書き戻す。 */
document.getElementById('dayedit-apply-btn')?.addEventListener('click', () => {
    if (!selectedCalendarTaskId) return;
    const row = currentMainData.find(r => String(r['ID']) === selectedCalendarTaskId);
    if (!row) return;

    row['タイトル']   = document.getElementById('dayedit-title').value.trim();
    row['内容']       = document.getElementById('dayedit-content').value.trim();
    row['備考']       = document.getElementById('dayedit-biko').value.trim();
    row['ステータス'] = document.getElementById('dayedit-status').value;
    row['優先度']     = document.getElementById('dayedit-priority').value;
    row['カテゴリ']   = document.getElementById('dayedit-category').value;
    row['タグ']       = document.getElementById('dayedit-tag').value;
    row['ハブ']       = document.getElementById('dayedit-hub').value;

    const startDate = document.getElementById('dayedit-start-date').value;
    const startTime = readCalendarTime('dayedit-start-hour', 'dayedit-start-minute');
    const endDate    = document.getElementById('dayedit-end-date').value;
    const endTime    = readCalendarTime('dayedit-end-hour', 'dayedit-end-minute');

    row['開始予定'] = startDate ? `${startDate.replace(/-/g, '/')}${startTime ? ' ' + startTime : ''}` : '';
    row['終了予定'] = endDate   ? `${endDate.replace(/-/g, '/')}${endTime ? ' ' + endTime : ''}`       : '';
    row['完了日']   = document.getElementById('dayedit-complete-date').value.replace(/-/g, '/');
    row['更新日時'] = formatJpDatetime(new Date());

    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
    renderCalendar();
    renderTaskRunner();
});

/** 「削除」ボタン: 選択中タスクをメインデータから完全に削除する。 */
document.getElementById('dayedit-delete-btn')?.addEventListener('click', () => {
    if (!selectedCalendarTaskId) return;
    if (!confirm('このタスクを削除します。よろしいですか？（この操作は取り消せません）')) return;

    currentMainData = currentMainData.filter(r => String(r['ID']) !== selectedCalendarTaskId);
    selectedCalendarTaskId = null;

    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);
    renderCalendar();
    renderTaskRunner();
});

/** 開始予定の時刻を入力したら、終了予定に1時間後を自動セットする（日付をまたぐ場合は終了予定日も繰り上げる）。手動で修正可能。 */
function autoFillCalendarEndTime() {
    const startDateEl   = document.getElementById('dayedit-start-date');
    const startHourEl   = document.getElementById('dayedit-start-hour');
    const startMinuteEl = document.getElementById('dayedit-start-minute');
    const endDateEl     = document.getElementById('dayedit-end-date');
    const endHourEl      = document.getElementById('dayedit-end-hour');
    const endMinuteEl    = document.getElementById('dayedit-end-minute');
    if (!startDateEl.value || startHourEl.value === '' || startMinuteEl.value === '') return;

    const [y, m, d] = startDateEl.value.split('-').map(Number);
    const startDt = new Date(y, m - 1, d, Number(startHourEl.value), Number(startMinuteEl.value));
    const endDt   = new Date(startDt.getTime() + 60 * 60 * 1000);

    const pad = n => String(n).padStart(2, '0');
    endDateEl.value   = `${endDt.getFullYear()}-${pad(endDt.getMonth() + 1)}-${pad(endDt.getDate())}`;
    endHourEl.value   = endDt.getHours();
    endMinuteEl.value = endDt.getMinutes();
}
document.getElementById('dayedit-start-hour')?.addEventListener('change', autoFillCalendarEndTime);
document.getElementById('dayedit-start-minute')?.addEventListener('change', autoFillCalendarEndTime);

/** 「新規登録」ボタン: フォームの現在値で新規タスクを追加する（選択中タスクの有無は無関係）。 */
document.getElementById('dayedit-new-btn')?.addEventListener('click', () => {
    const title = document.getElementById('dayedit-title').value.trim();

    const startDate = document.getElementById('dayedit-start-date').value;
    const startTime = readCalendarTime('dayedit-start-hour', 'dayedit-start-minute');
    const endDate    = document.getElementById('dayedit-end-date').value;
    const endTime    = readCalendarTime('dayedit-end-hour', 'dayedit-end-minute');

    const maxId = currentMainData.reduce((max, row) => {
        const id = parseInt(row['ID'], 10);
        return isNaN(id) ? max : Math.max(max, id);
    }, 0);
    const ts = formatJpDatetime(new Date());

    const entry = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
    entry['ID']        = String(maxId + 1);
    entry['データ区分'] = 'タスク';
    entry['タイトル']   = title;
    entry['内容']       = document.getElementById('dayedit-content').value.trim();
    entry['備考']       = document.getElementById('dayedit-biko').value.trim();
    entry['ステータス'] = document.getElementById('dayedit-status').value;
    entry['優先度']     = document.getElementById('dayedit-priority').value;
    entry['カテゴリ']   = document.getElementById('dayedit-category').value || (currentCategory === 'すべて' ? '' : currentCategory);
    entry['タグ']       = document.getElementById('dayedit-tag').value;
    entry['ハブ']       = document.getElementById('dayedit-hub').value;
    entry['開始予定']   = startDate ? `${startDate.replace(/-/g, '/')}${startTime ? ' ' + startTime : ''}` : '';
    entry['終了予定']   = endDate   ? `${endDate.replace(/-/g, '/')}${endTime ? ' ' + endTime : ''}`       : '';
    entry['完了日']     = document.getElementById('dayedit-complete-date').value.replace(/-/g, '/');
    entry['作成日時']   = ts;
    entry['更新日時']   = ts;

    currentMainData.push(entry);
    saveCache(stringifyMarkdown(currentMainData, currentMasterData), currentSha);

    selectedCalendarTaskId = null;
    renderCalendar();
    renderTaskRunner();
});

document.getElementById('calendar-prev-btn')?.addEventListener('click', () => {
    calendarMonth--;
    if (calendarMonth < 0) { calendarMonth = 11; calendarYear--; }
    if (taskOrgView === 'calendar') renderCalendarGrid(); else renderGanttChart();
});

document.getElementById('calendar-next-btn')?.addEventListener('click', () => {
    calendarMonth++;
    if (calendarMonth > 11) { calendarMonth = 0; calendarYear++; }
    if (taskOrgView === 'calendar') renderCalendarGrid(); else renderGanttChart();
});

// ===== ガントチャート（タスクページ） =====

/** カテゴリ・calendarFilters（タグ／ハブ／ステータス）で絞り込んだタスク一覧を返す。1日タスクは除外し、日付未設定の行も除外する。 */
function getGanttTasks() {
    return getFilteredMainData().filter(r => {
        if (r['データ区分'] !== 'タスク') return false;
        if (r['ハブ'] === DAYPLAN_HUB) return false;
        if (!r['開始予定'] && !r['終了予定']) return false;
        if (!matchesMultiFilter(calendarFilters.tag, r['タグ'])) return false;
        if (!matchesMultiFilter(calendarFilters.hub, r['ハブ'])) return false;
        if (!matchesMultiFilter(calendarFilters.status, r['ステータス'])) return false;
        return true;
    });
}

/**
 * dateJP が [startJP, endJP] の範囲内かどうかの表示マーカーを返す。
 * 開始日=▷／終了日=◁／その間=ー／どちらか一方のみ設定時はその日だけに印。
 * 完了日と重なる日は▼で上書きする。
 */
function getGanttMarker(row, dateJP) {
    const s = jpDateOnly(row['開始予定']);
    const e = jpDateOnly(row['終了予定']);
    const c = jpDateOnly(row['完了日']);

    let marker = '';
    if (s && e) {
        if (dateJP >= s && dateJP <= e) {
            marker = dateJP === s ? '▷' : (dateJP === e ? '◁' : 'ー');
        }
    } else if (s && dateJP === s) {
        marker = '▷';
    } else if (e && dateJP === e) {
        marker = '◁';
    }

    if (c && dateJP === c) marker = '▼';
    return marker;
}

/**
 * 週表示用に、centerYear/centerMonth を基準に「前2か月・当月・後3か月」＝合計6か月分の範囲を
 * 日曜始まりの週（7日ずつ）に区切って返す。各要素は7つの dateJP（日曜〜土曜）の配列。
 */
function getGanttWeekColumns(centerYear, centerMonth) {
    const pad  = n => String(n).padStart(2, '0');
    const toJP = dt => `${dt.getFullYear()}/${pad(dt.getMonth() + 1)}/${pad(dt.getDate())}`;

    const rangeStart = new Date(centerYear, centerMonth - 2, 1);
    const rangeEnd   = new Date(centerYear, centerMonth + 4, 0);
    rangeStart.setDate(rangeStart.getDate() - rangeStart.getDay());
    rangeEnd.setDate(rangeEnd.getDate() + (6 - rangeEnd.getDay()));

    const weeks = [];
    const cursor = new Date(rangeStart);
    while (cursor <= rangeEnd) {
        const days = [];
        for (let i = 0; i < 7; i++) {
            days.push(toJP(cursor));
            cursor.setDate(cursor.getDate() + 1);
        }
        weeks.push(days);
    }
    return weeks;
}

/** 週（7日分の dateJP 配列）内の marker をまとめて1つに集約する（開始・終了が同週なら「▷◁」）。 */
function getGanttWeekMarker(row, days) {
    const markers = days.map(d => getGanttMarker(row, d)).filter(Boolean);
    if (markers.includes('▼')) return '▼';
    const hasStart = markers.includes('▷');
    const hasEnd   = markers.includes('◁');
    if (hasStart && hasEnd) return '▷◁';
    if (hasStart) return '▷';
    if (hasEnd)   return '◁';
    if (markers.includes('ー')) return 'ー';
    return '';
}

/** ガントチャート（「タスク整理」のガントチャートビュー）を描画する。表示範囲は calendarYear/calendarMonth を基準とする。 */
function renderGanttChart() {
    const label = document.getElementById('calendar-month-label');
    if (label) label.textContent = `${calendarYear}年${calendarMonth + 1}月`;

    const table = document.getElementById('gantt-table');
    if (!table) return;

    const todayJP = jpDateOnly(formatJpDatetime(new Date()));
    const tasks = getGanttTasks();

    let columns;
    if (ganttViewUnit === 'week') {
        columns = getGanttWeekColumns(calendarYear, calendarMonth).map(days => ({
            dates: days,
            label: `${Number(days[0].split('/')[1])}/${Number(days[0].split('/')[2])}`,
            isToday: days.includes(todayJP),
            isSelected: days.includes(selectedCalendarDate),
        }));
    } else {
        const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
        const pad = n => String(n).padStart(2, '0');
        columns = Array.from({ length: daysInMonth }, (_, i) => {
            const d = `${calendarYear}/${pad(calendarMonth + 1)}/${pad(i + 1)}`;
            return { dates: [d], label: String(i + 1), isToday: d === todayJP, isSelected: d === selectedCalendarDate };
        });
    }

    table.className = 'gantt-table';
    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    ['ID', 'タイトル'].forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        th.className = 'gantt-fixed-col';
        hRow.appendChild(th);
    });
    columns.forEach(col => {
        const th = document.createElement('th');
        th.className = ganttViewUnit === 'week' ? 'gantt-day-col gantt-week-col' : 'gantt-day-col';
        if (col.isToday)    th.classList.add('gantt-day-col--today');
        if (col.isSelected) th.classList.add('gantt-day-col--selected');
        th.textContent = col.label;
        th.addEventListener('click', () => {
            selectedCalendarDate   = col.dates[0];
            selectedCalendarTaskId = null;
            calendarQuickNewMode   = false;
            renderCalendar();
        });
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    if (tasks.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.className = 'empty-cell';
        td.colSpan = columns.length + 2;
        td.textContent = '該当するタスクがありません';
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        tasks.forEach(row => {
            const tr = document.createElement('tr');
            tr.className = 'gantt-task-row';
            if (String(row['ID']) === selectedCalendarTaskId) tr.classList.add('selected-row');

            const idTd = document.createElement('td');
            idTd.className = 'gantt-fixed-col';
            idTd.textContent = row['ID'] ?? '';
            tr.appendChild(idTd);

            const statusClass = getCalendarStatusClass(row['ステータス']);

            const titleTd = document.createElement('td');
            titleTd.className = `gantt-fixed-col gantt-title-col gantt-title-text ${statusClass}`;
            titleTd.textContent = row['タイトル'] || '（無題）';
            tr.appendChild(titleTd);

            columns.forEach(col => {
                const td = document.createElement('td');
                td.className = 'gantt-day-col';
                const marker = ganttViewUnit === 'week' ? getGanttWeekMarker(row, col.dates) : getGanttMarker(row, col.dates[0]);
                if (marker) {
                    td.textContent = marker;
                    td.classList.add('gantt-marker', statusClass);
                }
                tr.appendChild(td);
            });

            tr.addEventListener('click', () => openCalendarTaskEdit(String(row['ID'])));
            tbody.appendChild(tr);
        });
    }

    table.replaceChildren(thead, tbody);
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
            renderEditTable();
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

