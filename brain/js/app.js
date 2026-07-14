import { loadToken, saveToken, loadCache, saveCache } from './modules/storage.js';
import { fetchFile, saveFile } from './modules/github.js';
import { parseMarkdown, stringifyMarkdown, MAIN_DATA_COLUMNS, MASTER_DATA_COLUMNS } from './modules/dataModel.js';
import { mergeMainData } from './modules/merge.js';
import { exportToExcel, importFromExcel } from './modules/excel.js';
import {
    generateChildManually, matchesSchedule, checkAndGenerateChildren,
    formatRecurringFrequencyLabel, buildChildChartData, getMondayOf, formatSlashDate as formatSlashDateForRecurring
} from './modules/recurring.js';
import { parseExceptions, stringifyExceptions, computeMonthCalendar, computeMonthStats, getDefaultType } from './modules/workCalendar.js';
import {
    parseJpDatetime, formatJpDatetime, parseTimestampLog, formatDuration, isLogRunning,
    computeTotalDuration as computeTotalDurationM, isProjectActive as isProjectActiveM,
    filterMainDataByCategory, filterTagsByCategory, filterProjectsByCategory, computeActualHours
} from './modules/task.js';
import {
    DAYPLAN_PROJECT, matchesMultiFilter, isTaskDoneForCalendar, getCalendarMarkDate,
    getTasksForDate as getTasksForDateM, getDayPlanTask as getDayPlanTaskM, parseDayPlanContent,
    countActiveTasksByField as countActiveTasksByFieldM, countTasksByField as countTasksByFieldM,
    sortByTotalCountDesc as sortByTotalCountDescM, calendarTaskListStatusRank, compareDateAscEmptyLast,
    getCalendarFilteredTaskList as getCalendarFilteredTaskListM, extractTimeOnDate,
    getCalendarSegmentsForDate as getCalendarSegmentsForDateM, assignCalendarLanes, getCalendarStatusClass,
    computeDayPlanTimeSlot, getTaskScheduledTimeOnDate,
    getIncompleteDateTasks as getIncompleteDateTasksM, getUnsetAttributeGroups as getUnsetAttributeGroupsM,
    getSuspendedTasks as getSuspendedTasksM, taskOrganizeStatusRank,
    sortDayPlanBlocks, stringifyDayPlanBlocks, updateDayPlanBlockTime
} from './modules/calendar.js';
import {
    getAllProjectNamesForAdmin as getAllProjectNamesForAdminM, countProjectUsage as countProjectUsageM,
    renameProjectMaster as renameProjectMasterM, mergeProjectInto as mergeProjectIntoM,
    deleteProject as deleteProjectM, toggleProjectStatus as toggleProjectStatusM
} from './modules/project.js';
import {
    getAllKnownColumns as getAllKnownColumnsM, computeMasterWarnings as computeMasterWarningsM,
    createEmptyMasterRow as createEmptyMasterRowM
} from './modules/master.js';

const OWNER = 'palmelo2nd';
const REPO  = 'brain_data';
const PATH  = 'brain/data.md';

// ===== グローバル状態 =====
let currentSha        = null;
let currentMainData   = [];
let currentMasterData = [];
let lastSyncedMarkdown = null;   // 直近でGitHub/キャッシュと一致している状態のMarkdown（未保存差分の判定基準）
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
let selectedCalendarDate = jpDateOnly(formatJpDatetime(todayForCalendar)); // カレンダーで選択中の日付（"YYYY/MM/DD"）。初期値は今日
let selectedCalendarTaskId = null;     // 日別予定表で選択中のタスクID（属性編集パネル用）
let calendarFilters = { tag: new Set(), project: new Set(), status: new Set() }; // カレンダーのタグ／プロジェクト／ステータスフィルタ値（複数選択）
let calendarQuickNewMode = false;      // true時: タスク一覧の「（新規作成）」行から起動した新規登録モード（日付は空欄のまま）
let taskOrgView = 'calendar';          // 「タスク整理」の表示ビュー（'calendar' | 'gantt'）。年月・タグ/プロジェクト/ステータスフィルタ・選択中タスクは両ビューで共有する
let ganttViewUnit = 'day';             // ガントチャートの列の単位（'day' | 'week'）
let summaryView          = 'taskorg';   // Summary ページの表示ビュー（'top' | 'runner' | 'taskorg' | 'recurring' | 'edit' | 'data' | 'project' | 'work'）
let workCalendarYear  = new Date().getFullYear();
let workCalendarMonth = new Date().getMonth();

// ===== 初期化 =====
window.addEventListener('DOMContentLoaded', () => {
    const saved = loadToken();
    if (saved) {
        setTokenInputs(saved);
        loadFromGitproject(saved, true);
    }
    renderSummary();
});

// ===== サイドバー／TOPページ共通コントロール（PW・Load・Save・Export・Import） =====

/** すべてのトークン入力欄（サイドバー・TOPページ）を同じ値に揃える */
function setTokenInputs(value) {
    document.querySelectorAll('.js-token-input').forEach(el => { el.value = value; });
}

/** いずれかのトークン入力欄から値を取得する（全欄が同期されているため先頭の値を使う） */
function getTokenValue() {
    return document.querySelector('.js-token-input')?.value.trim() || '';
}

/** すべてのトークン入力欄を相互に同期する */
document.querySelectorAll('.js-token-input').forEach(input => {
    input.addEventListener('input', () => setTokenInputs(input.value));
});

/** すべてのネットワークステータス表示（サイドバー・TOPページ）を更新する */
function setNetworkStatus(html) {
    document.querySelectorAll('.js-network-status').forEach(el => { el.innerHTML = html; });
}

/**
 * 現在のMarkdownが直近の同期済み内容と一致しているかどうかで「最新」「未保存の変更あり」バッジを切り替える。
 * オフライン表示中（読込失敗でキャッシュ表示中）はここでは上書きしない。
 */
function updateSyncBadge(markdown) {
    if (lastSyncedMarkdown === null) return; // 未読み込み状態では何もしない
    if (markdown === lastSyncedMarkdown) {
        setNetworkStatus('<span class="status-badge online-badge">オンライン（最新）</span>');
    } else {
        setNetworkStatus('<span class="status-badge unsaved-badge">オンライン（更新あり）</span>');
    }
}

/** データ変更のたびに呼ぶ：ローカルキャッシュへ保存し、未保存差分バッジを更新する */
function persistLocalCache() {
    const markdown = stringifyMarkdown(currentMainData, currentMasterData);
    saveCache(markdown, currentSha);
    updateSyncBadge(markdown);
}

/** id要素が指定アンカーの子でなければ移動する（Summary内の各タブでセクション本体を使い回すため） */
function mountSection(elId, anchorId) {
    const el     = document.getElementById(elId);
    const anchor = document.getElementById(anchorId);
    if (el && anchor && el.parentElement !== anchor) anchor.appendChild(el);
}

// --- ページレンダラー ---

const SUMMARY_VIEWS = ['taskorg', 'runner', 'top', 'recurring', 'edit', 'project', 'data', 'work'];

/** Summary ページ（INBOX／タスク整理／タスク実行／習慣／編集／プロジェクト／データの表示切り替え。PW・Load〜Import・カテゴリは常時表示バーで共通）を描画する */
function renderSummary() {
    // 選択中のビューに応じて、セクション本体をこのページへ移動する
    if (summaryView === 'taskorg')   mountSection('taskorg-details',   'taskorg-anchor-summary');
    if (summaryView === 'recurring') mountSection('recurring-details', 'recurring-anchor-summary');
    if (summaryView === 'edit')      mountSection('edit-details',      'edit-anchor-summary');
    if (summaryView === 'data')      mountSection('data-group',        'data-anchor-summary');
    if (summaryView === 'project')       mountSection('project-group',         'project-anchor-summary');

    renderCategoryFilter(); // 常時表示バーのカテゴリ選択を最新化
    renderWarnings(computeMasterWarnings());
    renderInboxBadge();
    renderTaskRunner();
    if (summaryView === 'taskorg')   renderCalendar();
    if (summaryView === 'recurring') renderRecurringSection();
    if (summaryView === 'edit')      renderEdit();
    if (summaryView === 'data') {
        renderDataTable('table-main',   'summary-main',   getFilteredMainData(),   MAIN_DATA_COLUMNS,   'メインデータ',   { editable: true, idColumn: 'ID' });
        renderDataTable('table-master', 'summary-master', currentMasterData, MASTER_DATA_COLUMNS, 'マスタデータ', { editable: true, onEdit: () => { renderWarnings(computeMasterWarnings()); renderProjectAdmin(); } });
    }
    if (summaryView === 'project')  renderProjectAdmin();
    if (summaryView === 'work') renderWorkCalendar();

    SUMMARY_VIEWS.forEach(view => {
        document.getElementById(`summary-tab-${view}`)?.classList.toggle('taskorg-view-btn--active', summaryView === view);
        const panel = document.getElementById(`summary-view-${view}`);
        if (panel) panel.style.display = summaryView === view ? '' : 'none';
    });
}

SUMMARY_VIEWS.forEach(view => {
    document.getElementById(`summary-tab-${view}`)?.addEventListener('click', () => { summaryView = view; renderSummary(); });
});

/** INBOX のカテゴリバッジ（サイドバー／Summary 両方）を更新する */
function renderInboxBadge() {
    const text = currentCategory === 'すべて'
        ? 'カテゴリ: 未設定（「すべて」選択中）'
        : `カテゴリ: ${currentCategory}`;
    document.querySelectorAll('.js-inbox-badge').forEach(badge => { badge.textContent = text; });
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
                        persistLocalCache();
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
    if (kubun === 'タスク')   return ['タイトル', 'ステータス', '優先度', '開始予定', '終了予定', '見積時間', 'カテゴリ', 'タグ', 'プロジェクト'];
    if (kubun === 'ナレッジ') return ['タイトル', 'ステータス', 'Input', 'カテゴリ', 'タグ', 'プロジェクト', '更新日時'];
    return ['カテゴリ', 'タイトル', '内容', 'タグ', 'プロジェクト', '作成日時', '更新日時'];
}

/** editKubun + editFilters を適用したメインデータの絞り込み結果を返す */
function getFilteredEditItems() {
    let rows = getFilteredMainData().filter(r => r['データ区分'] === editKubun);

    // 共通フィルタ
    if (editFilters.tag)         rows = rows.filter(r => r['タグ'] === editFilters.tag);
    if (editFilters.project)         rows = rows.filter(r => r['プロジェクト'] === editFilters.project);
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
    makeRow('プロジェクト',    makeSelect(getFilteredProjects(), 'すべて', 'project'));
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

/** フォームを再構築する（移動先データ区分ドロップダウン・タグ・プロジェクト・カテゴリ・条件フィールド） */
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
    rebuildSelectById('edit-project',      getFilteredProjects());
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
    const projectEl = document.getElementById('edit-project');
    if (projectEl) projectEl.value = row['プロジェクト'] ?? '';
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
     'edit-category', 'edit-tag', 'edit-project'].forEach(id => {
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
    const project      = document.getElementById('edit-project').value;
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
    entry['プロジェクト']       = project;
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
    persistLocalCache();

    selectedEditIds.clear();
    clearEditForm();
    renderEditKubunTabs();
    renderEditTable();

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
    const project      = document.getElementById('edit-project').value;
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
        if (project)                         row['プロジェクト']     = project;
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
    persistLocalCache();
    renderEdit();
});

/** 「削除」ボタン: 選択行をメインデータから完全に削除する。 */
document.getElementById('edit-delete-btn')?.addEventListener('click', () => {
    if (selectedEditIds.size === 0) { alert('削除する行を選択してください'); return; }
    if (!confirm(`選択した ${selectedEditIds.size} 件を削除します。よろしいですか？（この操作は取り消せません）`)) return;

    currentMainData = currentMainData.filter(r => !selectedEditIds.has(String(r['ID'])));

    selectedEditIds.clear();
    persistLocalCache();
    renderEdit();
});

// ===== マスタ管理 =====

/** MAIN_DATA_COLUMNS/MASTER_DATA_COLUMNSと実データ列の和集合を返す（新規列の自動認識用）。 */
function getAllKnownColumns() {
    return getAllKnownColumnsM(currentMainData, currentMasterData, MAIN_DATA_COLUMNS, MASTER_DATA_COLUMNS);
}

/** MAIN_DATA_COLUMNS と currentMasterData を照合して警告リストを返す。 */
function computeMasterWarnings() {
    return computeMasterWarningsM(currentMainData, currentMasterData, MAIN_DATA_COLUMNS, MASTER_DATA_COLUMNS);
}

/** Summary ページに警告バナーを描画する。 */
function renderWarnings(warnings) {
    document.querySelectorAll('#summary-dashboard-warning').forEach(dashEl => {
        dashEl.innerHTML = warnings.length > 0
            ? `<p class="warning-text">⚠ ${warnings.join('　/　')}</p>`
            : '';
    });
}

/** マスタデータの空行を生成する。 */
function createEmptyMasterRow() {
    return createEmptyMasterRowM(MASTER_DATA_COLUMNS);
}

/** 空のマスタデータ行を1件追加し、マスタデータ一覧テーブルを再描画する。 */
function addMasterRow() {
    currentMasterData.push(createEmptyMasterRow());
    persistLocalCache();
    renderDataTable('table-master', 'summary-master', currentMasterData, MASTER_DATA_COLUMNS, 'マスタデータ', { editable: true, onEdit: () => renderWarnings(computeMasterWarnings()) });
    renderWarnings(computeMasterWarnings());
}

document.getElementById('add-master-data-row-btn')?.addEventListener('click', addMasterRow);

// ===== プロジェクト管理（名前変更・削除・統合） =====

let projectAdminDeletePending = null; // 削除確認中のプロジェクト名（使用中の場合、再割り当てUIを表示するため）

/** マスタに登録済みの全プロジェクト名（重複除去、有効/無効を問わない）を返す。1日タスク用の予約プロジェクトは対象外。 */
function getAllProjectNamesForAdmin() {
    return getAllProjectNamesForAdminM(currentMasterData);
}

/** 指定プロジェクト名がメインデータ（タスク／ナレッジ等）で使用されている件数を返す。 */
function countProjectUsage(name) {
    return countProjectUsageM(currentMainData, name);
}

/**
 * プロジェクト名を旧名から新名へ変更する。メインデータの参照とマスタの(M)プロジェクト_子を書き換える。
 * newName が既存の別プロジェクト名と一致する場合は実質的に統合（mergeProjectInto）と同じ結果になる。
 */
function renameProjectMaster(oldName, newName) {
    const result = renameProjectMasterM(currentMainData, currentMasterData, oldName, newName);
    currentMainData   = result.mainData;
    currentMasterData = result.masterData;
    persistLocalCache();
}

/** sourceName のプロジェクトを targetName に統合する。メインデータの参照を付け替え、source側のマスタ行のプロジェクト関連列だけを消す。 */
function mergeProjectInto(sourceName, targetName) {
    const result = mergeProjectIntoM(currentMainData, currentMasterData, sourceName, targetName);
    currentMainData   = result.mainData;
    currentMasterData = result.masterData;
    persistLocalCache();
}

/** プロジェクトを削除する。reassignTo を指定すればそのプロジェクトへ再割り当てしてから削除、未指定なら参照を空欄にして削除する。 */
function deleteProject(name, reassignTo) {
    const result = deleteProjectM(currentMainData, currentMasterData, name, reassignTo);
    currentMainData   = result.mainData;
    currentMasterData = result.masterData;
    persistLocalCache();
}

/** 指定プロジェクト名の (M)プロジェクト_ステータス を切り替える（同名の全マスタ行に反映）。 */
function toggleProjectStatus(name) {
    currentMasterData = toggleProjectStatusM(currentMasterData, name);
    persistLocalCache();
}

/** プロジェクト管理テーブルを描画する。名前変更・統合・削除の操作列を持つ。 */
function renderProjectAdmin() {
    const table = document.getElementById('project-admin-table');
    if (!table) return;

    const projectNames = getAllProjectNamesForAdmin();
    table.className = 'data-table';

    if (projectNames.length === 0) {
        const tbody = document.createElement('tbody');
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.className = 'empty-cell';
        td.textContent = '登録済みのプロジェクトがありません';
        tr.appendChild(td);
        tbody.appendChild(tr);
        table.replaceChildren(tbody);
        return;
    }

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    ['プロジェクト名', '使用件数', '状態', '名前変更', '統合', '削除'].forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    projectNames.forEach(name => {
        const count = countProjectUsage(name);
        const otherNames = projectNames.filter(n => n !== name);

        const tr = document.createElement('tr');

        const nameTd = document.createElement('td');
        nameTd.textContent = name;
        tr.appendChild(nameTd);

        const countTd = document.createElement('td');
        countTd.textContent = String(count);
        tr.appendChild(countTd);

        // 状態（表示/非表示の切り替え）
        const statusTd = document.createElement('td');
        const active = currentMasterData.some(r => r['(M)プロジェクト_子'] === name && isProjectActive(r));
        const statusBtn = document.createElement('button');
        statusBtn.textContent = active ? '表示中' : '非表示中';
        statusBtn.className = active ? 'project-admin-status-btn project-admin-status-btn--on' : 'project-admin-status-btn project-admin-status-btn--off';
        statusBtn.addEventListener('click', () => {
            toggleProjectStatus(name);
            renderProjectAdmin();
            renderCalendar();
        });
        statusTd.appendChild(statusBtn);
        tr.appendChild(statusTd);

        // 名前変更
        const renameTd = document.createElement('td');
        const renameInput = document.createElement('input');
        renameInput.type = 'text';
        renameInput.placeholder = '新しい名前';
        renameInput.className = 'project-admin-input';
        const renameBtn = document.createElement('button');
        renameBtn.textContent = '変更';
        renameBtn.addEventListener('click', () => {
            const newName = renameInput.value.trim();
            if (!newName || newName === name) return;
            renameProjectMaster(name, newName);
            projectAdminDeletePending = null;
            renderProjectAdmin();
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
            mergeBtn.textContent = 'このプロジェクトへ統合';
            mergeBtn.addEventListener('click', () => {
                if (!confirm(`「${name}」を「${mergeSelect.value}」に統合します。「${name}」を使用中の全タスク／ナレッジが「${mergeSelect.value}」に書き換わります。よろしいですか？`)) return;
                mergeProjectInto(name, mergeSelect.value);
                projectAdminDeletePending = null;
                renderProjectAdmin();
                renderCalendar();
            });
            mergeTd.append(mergeSelect, mergeBtn);
        } else {
            mergeTd.textContent = '（統合先なし）';
        }
        tr.appendChild(mergeTd);

        // 削除
        const deleteTd = document.createElement('td');
        if (projectAdminDeletePending === name) {
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
                    deleteProject(name, reassignSelect.value);
                    projectAdminDeletePending = null;
                    renderProjectAdmin();
                    renderCalendar();
                });
                deleteTd.append(reassignSelect, reassignBtn);
            }

            const unassignBtn = document.createElement('button');
            unassignBtn.className = 'calendar-danger-btn';
            unassignBtn.textContent = '割り当てずに削除';
            unassignBtn.addEventListener('click', () => {
                if (!confirm(`「${name}」を削除し、割り当てられていた${count}件のプロジェクトを空欄にします。よろしいですか？`)) return;
                deleteProject(name, null);
                projectAdminDeletePending = null;
                renderProjectAdmin();
                renderCalendar();
            });
            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = 'キャンセル';
            cancelBtn.addEventListener('click', () => {
                projectAdminDeletePending = null;
                renderProjectAdmin();
            });
            deleteTd.append(unassignBtn, cancelBtn);
        } else {
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'calendar-danger-btn';
            deleteBtn.textContent = '削除';
            deleteBtn.addEventListener('click', () => {
                if (count === 0) {
                    if (!confirm(`「${name}」を削除します。よろしいですか？`)) return;
                    deleteProject(name, null);
                    renderProjectAdmin();
                    renderCalendar();
                } else {
                    projectAdminDeletePending = name;
                    renderProjectAdmin();
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
    persistLocalCache();

    renderDataTable('table-main', 'summary-main', getFilteredMainData(), MAIN_DATA_COLUMNS, 'メインデータ', { editable: true, idColumn: 'ID' });
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

    // 廃止済みの旧項目（ステータスコメント）が残っていれば除去する
    currentMainData.forEach(r => { delete r['ステータスコメント']; });

    // 繰り返しタスクの自動生成（データ読み込み時）
    const newChildren = checkAndGenerateChildren(currentMainData, new Date());
    if (newChildren.length > 0) {
        currentMainData.push(...newChildren);
        persistLocalCache();
    }

    // 初回ロード時のみ、先頭カテゴリをデフォルト選択にする
    if (!categoryInitialized) {
        const categories = [...new Set(currentMasterData.map(r => r['(M)カテゴリ']).filter(Boolean))];
        if (categories.length > 0) currentCategory = categories[0];
        categoryInitialized = true;
    }

    renderCategoryFilter();   // データ更新時にカテゴリ一覧を再構築
    renderSummary();
}

// ===== GitHubから読み込み =====

/**
 * GitHubからデータを読み込み、失敗時はローカルキャッシュへフォールバックする。
 * (2) インプット: token (string), silent (boolean) - trueの場合トークン未入力時にアラートを出さない
 */
async function loadFromGitproject(token, silent = false) {
    const contentBox = document.getElementById('content-box');

    if (!token) { if (!silent) alert('トークンを入力してください'); return; }
    saveToken(token);
    contentBox.textContent = '読み込み中...';

    try {
        const { content, sha } = await fetchFile(token, OWNER, REPO, PATH);
        applyContent(content, sha);
        lastSyncedMarkdown = content; // GitHub上の内容を「同期済み」の基準にする
        persistLocalCache();          // 繰り返しタスク自動生成分も含めた現在の状態をキャッシュ＆バッジ反映
        contentBox.innerHTML = window.marked.parse(content);
    } catch (error) {
        console.error(error);
        const cached = loadCache();
        if (cached) {
            applyContent(cached.content, cached.sha);
            lastSyncedMarkdown = cached.content; // 端末内キャッシュを「同期済み」の基準にする
            setNetworkStatus('<span class="status-badge offline-badge">オフライン（未同期）</span>');
            contentBox.innerHTML = window.marked.parse(cached.content);
            if (!silent) alert('通信できませんでした。スマホ内に一時保存されている前回のデータを表示します。');
        } else {
            contentBox.textContent = `エラー: ${error.message}（端末内にキャッシュもありません）`;
        }
    }
}

document.querySelectorAll('.js-load-btn').forEach(btn => {
    btn.addEventListener('click', () => loadFromGitproject(getTokenValue()));
});

// ===== GitHubへ保存 =====

/**
 * masterDataの競合を解決する。片方しか変更していなければその内容を採用し、
 * 両方が異なる内容に変更している場合のみユーザーに選ばせる（マージはしない）。
 */
function resolveMasterData(baseMasterData, localMasterData, remoteMasterData) {
    const baseJson   = JSON.stringify(baseMasterData);
    const localJson  = JSON.stringify(localMasterData);
    const remoteJson = JSON.stringify(remoteMasterData);

    if (localJson === remoteJson) return localMasterData;
    if (localJson === baseJson)   return remoteMasterData; // ローカルは未変更 → 相手を採用
    if (remoteJson === baseJson)  return localMasterData;  // 相手は未変更 → ローカルを採用

    const useLocal = confirm(
        'マスタデータ（カテゴリ・タグ等の設定）が他端末でも更新されており、競合しています。\n' +
        'OK：自分のマスタ変更を優先して保存します\nキャンセル：他端末のマスタ内容を優先して保存します'
    );
    return useLocal ? localMasterData : remoteMasterData;
}

/**
 * 保存時に409（他端末との更新競合）が発生した場合の処理。
 * 相手の最新版を取得し、mainDataはID単位で3-wayマージ、masterDataは競合時のみユーザーに選ばせて、
 * 相手の最新SHAに対して保存し直す。
 */
async function handleSaveConflict(token, silent) {
    const contentBox = document.getElementById('content-box');

    try {
        const { content: remoteContent, sha: remoteSha } = await fetchFile(token, OWNER, REPO, PATH);
        const { mainData: remoteMain, masterData: remoteMaster } = parseMarkdown(remoteContent);
        const { mainData: baseMain,   masterData: baseMaster }   = parseMarkdown(lastSyncedMarkdown);

        const { merged, conflicts } = mergeMainData(baseMain, currentMainData, remoteMain);
        currentMainData   = merged;
        currentMasterData = resolveMasterData(baseMaster, currentMasterData, remoteMaster);

        const mergedMarkdown = stringifyMarkdown(currentMainData, currentMasterData);
        const { newSha } = await saveFile(token, OWNER, REPO, PATH, mergedMarkdown, remoteSha);

        currentSha = newSha;
        lastSyncedMarkdown = mergedMarkdown;
        saveCache(mergedMarkdown, newSha);
        updateSyncBadge(mergedMarkdown);

        if (!silent) {
            contentBox.innerHTML = window.marked.parse(mergedMarkdown);
            alert(conflicts.length > 0
                ? `他端末の更新と自動マージして保存しました（${conflicts.length}件は更新日時の新しい方を優先しました）。`
                : '他端末の更新を取り込んでマージし、保存しました。');
        }
    } catch (error) {
        console.error(error);
        setNetworkStatus('<span class="status-badge offline-badge">オフライン（未同期）</span>');
        if (!silent) {
            alert('他端末の更新との自動マージに失敗しました。変更は端末内に保存されています。時間をおいて再度「GitHubへ保存する」を押してください。');
        }
    }
}

/**
 * 現在のデータをGitHubへ保存する。直近の同期済み内容と変わっていなければ何もしない。
 * 他端末との更新競合（409）が起きた場合は自動マージを試みる。
 * (2) インプット: token (string), silent (boolean) - trueの場合、進捗表示・完了アラートを出さない（自動保存用）
 */
async function saveToGithub(token, silent = false) {
    const contentBox = document.getElementById('content-box');

    const newMarkdown = stringifyMarkdown(currentMainData, currentMasterData);

    if (newMarkdown === lastSyncedMarkdown) {
        if (!silent) {
            contentBox.textContent = '変更がないため保存をスキップしました。';
            setTimeout(() => { contentBox.innerHTML = window.marked.parse(newMarkdown); }, 1500);
        }
        return;
    }

    saveCache(newMarkdown, currentSha);
    if (!silent) contentBox.textContent = 'GitHubへ保存中...';

    try {
        const { newSha } = await saveFile(token, OWNER, REPO, PATH, newMarkdown, currentSha);
        currentSha = newSha;
        lastSyncedMarkdown = newMarkdown;
        saveCache(newMarkdown, newSha);
        updateSyncBadge(newMarkdown); // 保存直後は lastSyncedMarkdown と一致するため「オンライン（最新）」になる
        if (!silent) {
            contentBox.innerHTML = window.marked.parse(newMarkdown);
            alert('GitHubへの保存が成功しました！');
        }
    } catch (error) {
        console.error(error);

        if (error.status === 409) {
            await handleSaveConflict(token, silent);
            return;
        }

        setNetworkStatus('<span class="status-badge offline-badge">オフライン（未同期）</span>');
        if (!silent) {
            contentBox.innerHTML = window.marked.parse(newMarkdown);
            alert('現在通信ができません。変更はスマホ内に一時保存されました。電波の良い場所に移動してから、再度「GitHubへ保存する」を押して同期してください。');
        }
    }
}

document.querySelectorAll('.js-save-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const token = getTokenValue();
        if (!token)      return alert('トークンを入力してください');
        if (!currentSha) return alert('先にデータを読み込んでください（またはオフラインキャッシュを読み込んでください）');
        saveToGithub(token);
    });
});

// ===== 自動保存（5分ごと。変更がある場合のみGitHubへ保存し、変更が無ければ何もしない） =====
const AUTO_SAVE_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
    const token = getTokenValue();
    if (!token || !currentSha) return; // 未読み込み・未認証時は自動保存の対象外
    saveToGithub(token, true);
}, AUTO_SAVE_INTERVAL_MS);

// ===== Excelエクスポート =====
document.querySelectorAll('.js-excel-export-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (currentMainData.length === 0 && currentMasterData.length === 0) {
            return alert('エクスポートするデータがありません。先にGitHubからデータを読み込んでください。');
        }
        exportToExcel(currentMainData, currentMasterData);
    });
});

// ===== Excelインポート =====
document.querySelectorAll('.js-excel-import').forEach(input => {
    input.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const token      = getTokenValue();
        const contentBox = document.getElementById('content-box');

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
                lastSyncedMarkdown = newMarkdown;
                saveCache(newMarkdown, newSha);
                updateSyncBadge(newMarkdown); // 保存直後は lastSyncedMarkdown と一致するため「オンライン（最新）」になる
                contentBox.innerHTML = window.marked.parse(newMarkdown);
                alert('Excelのインポートとデータ保存が完了しました！');
            } catch (error) {
                console.error(error);
                setNetworkStatus('<span class="status-badge offline-badge">オフライン（未同期）</span>');
                contentBox.innerHTML = window.marked.parse(newMarkdown);
                alert('インポートデータを端末内に保存しました。「GitHubへ保存する」で同期してください。');
            }
        } else {
            setNetworkStatus('<span class="status-badge offline-badge">オフライン（未同期）</span>');
            contentBox.innerHTML = window.marked.parse(newMarkdown);
            alert('インポートデータを端末内に保存しました。GitHubへ同期するには、トークンを入力して読み込んでから再度インポートしてください。');
        }
    });
});

// ===== キャッシュ更新（スマホ等で古いコードが残る場合の強制リフレッシュ） =====

document.querySelectorAll('.js-cache-reset-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
        if (!confirm('キャッシュを更新して最新版を読み込み直します。よろしいですか？（入力中の内容は失われます）')) return;
        try {
            if ('caches' in window) {
                const keys = await caches.keys();
                await Promise.all(keys.map(k => caches.delete(k)));
            }
            if ('serviceWorker' in navigator) {
                const regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map(r => r.unregister()));
            }
        } catch (error) {
            console.error(error);
        }
        // ページURLにキャッシュバスター用のクエリを付けて再読み込みし、HTML自体のキャッシュを回避する
        location.href = location.pathname + '?nocache=' + Date.now();
    });
});

// ===== INBOX 登録 =====

document.querySelectorAll('.js-inbox-submit').forEach(btn => {
    btn.addEventListener('click', () => {
        const textarea = btn.closest('.inbox-form').querySelector('.js-inbox-content');
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
        entry['タイトル']   = content.slice(0, 15);
        entry['内容']       = content;
        entry['作成日時']   = ts;
        entry['更新日時']   = ts;
        entry['カテゴリ']   = currentCategory === 'すべて' ? '' : currentCategory;

        currentMainData.push(entry);

        // LocalStorage に自動保存（GitHub push 前の安全網）
        persistLocalCache();

        document.querySelectorAll('.js-inbox-content').forEach(ta => { ta.value = ''; });
        textarea.focus();
        renderSummary(); // カテゴリバッジ等を再描画
    });
});

// ===== カテゴリフィルタ =====

/**
 * masterData の (M)カテゴリ 列から一意のカテゴリ一覧を取得し、
 * サイドバーにラジオボタンとして描画する。
 * データ未読み込み時は「すべて」のみ表示する。
 */
function renderCategoryFilter() {
    const containers = document.querySelectorAll('.js-category-list');
    if (containers.length === 0) return;

    // (M)カテゴリ列から重複なしで一覧を生成
    const categories = [...new Set(
        currentMasterData.map(r => r['(M)カテゴリ']).filter(Boolean)
    )];

    containers.forEach(container => {
        container.innerHTML = '';

        ['すべて', ...categories].forEach(cat => {
            const label = document.createElement('label');
            label.className = 'category-radio-label' + (cat === currentCategory ? ' active' : '');

            const input  = document.createElement('input');
            input.type   = 'radio';
            input.name   = `category-filter-${container.id}`;
            input.value  = cat;
            input.checked = (cat === currentCategory);

            input.addEventListener('change', () => {
                currentCategory = cat;
                renderCategoryFilter(); // 全コンテナの選択状態を再同期
                renderSummary();
            });

            label.append(input, document.createTextNode(cat));
            container.appendChild(label);
        });
    });
}

/**
 * 選択中のカテゴリでフィルタされたメインデータを返す。
 * 「すべて」選択時は全件返す。
 * @returns {Array}
 */
function getFilteredMainData() {
    return filterMainDataByCategory(currentMainData, currentCategory);
}

/**
 * 選択中のカテゴリに属するタグ名一覧を返す。
 * 「すべて」選択時は (M)タグ_子 の全値を返す。
 * それ以外は (M)タグ_親 === currentCategory の行の (M)タグ_子 を返す。
 * @returns {string[]}
 */
export function getFilteredTags() {
    return filterTagsByCategory(currentMasterData, currentCategory);
}

/** (M)プロジェクト_ステータスが '0'（無効）でない行かどうかを判定する。未入力は有効扱いにする。 */
function isProjectActive(row) {
    return isProjectActiveM(row);
}

/**
 * 選択中のカテゴリに属する、有効な（(M)プロジェクト_ステータスが0でない）プロジェクト名一覧を返す。
 * 「すべて」選択時は (M)プロジェクト_子 の全値を返す。
 * それ以外は (M)プロジェクト_親 === currentCategory の行の (M)プロジェクト_子 を返す。
 * @returns {string[]}
 */
export function getFilteredProjects() {
    return filterProjectsByCategory(currentMasterData, currentCategory);
}

// ===== タスク実行機能 =====

/** 選択タスクの補正込み累計時間（ms） */
function computeTotalDuration(taskId) {
    return computeTotalDurationM(currentMainData, taskId);
}

/** 両コンテナの経過時間表示を更新 */
function updateRunnerTimerDisplay() {
    if (!selectedRunTaskId) return;
    const text = formatDuration(computeTotalDuration(selectedRunTaskId));
    document.querySelectorAll('.runner-elapsed-display').forEach(el => { el.textContent = text; });
}

/** タスク実行UIを描画 */
function renderTaskRunner() {
    document.querySelectorAll('.task-runner-container').forEach(container => buildTaskRunnerUI(container));
}

/** 単一コンテナにタスク実行UIを構築 */
function buildTaskRunnerUI(container) {
    container.innerHTML = '';

    const inProgress = getFilteredMainData().filter(r =>
        r['データ区分'] === 'タスク' && r['ステータス'] === '進行中'
        && !(r['繰返し識別子'] === '1' && !r['繰返し親ID']) // 繰返しタスクの親は対象外
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

    // タイムスタンプログの内容から計測中かどうかを判定し直す（ページ再表示・タスク切替時も正しい状態に復元するため）
    timerIsRunning = selectedRow ? isLogRunning(selectedRow['タイムスタンプログ']) : false;
    if (timerIsRunning) {
        if (!timerInterval) timerInterval = setInterval(updateRunnerTimerDisplay, 1000);
    } else if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }

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
        persistLocalCache();
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
        persistLocalCache();
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
        persistLocalCache();
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
        persistLocalCache();
        updateRunnerTimerDisplay();
    });
    logRow.append(logLabel, logArea);
    panel.appendChild(logRow);

    panel.appendChild(buildRunnerAttributeEditor(selectedRow));

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
            selectedRow['ステータス'] = newStatus;
            selectedRow['更新日時']   = formatJpDatetime(new Date());
            if (String(selectedRunTaskId) === String(selectedRow['ID'])) {
                selectedRunTaskId = null;
            }
            persistLocalCache();
            renderTaskRunner();
            renderEditTable();
        });
        changeTb.appendChild(changeBtn);
        statusSec.appendChild(changeTb);
        panel.appendChild(statusSec);
    }

    container.appendChild(panel);
}

/**
 * タスク実行パネル用の属性編集フォームを構築する（タスク整理「新規追加・編集」と同様の項目）。
 * ステータス・繰り返しはタスク実行の他の機能と重複するため対象外。
 */
function buildRunnerAttributeEditor(row) {
    const section = document.createElement('div');
    section.className = 'runner-attr-section';

    const label = document.createElement('p');
    label.className = 'calendar-section-label';
    label.textContent = '属性編集';
    section.appendChild(label);

    const addRow = (labelText, ...fields) => {
        const rowEl = document.createElement('div');
        rowEl.className = 'calendar-edit-row';
        const lbl = document.createElement('label');
        lbl.textContent = labelText;
        rowEl.append(lbl, ...fields);
        section.appendChild(rowEl);
        return rowEl;
    };

    const titleInput = document.createElement('input');
    titleInput.type  = 'text';
    titleInput.value = row['タイトル'] || '';
    addRow('タイトル', titleInput);

    const contentInput = document.createElement('textarea');
    contentInput.className = 'calendar-edit-textarea';
    contentInput.rows      = 4;
    contentInput.value     = row['内容'] || '';
    addRow('内容', contentInput).classList.add('calendar-edit-row--top');

    const bikoInput = document.createElement('input');
    bikoInput.type  = 'text';
    bikoInput.value = row['備考'] || '';
    addRow('備考', bikoInput);

    const prioritySelect = document.createElement('select');
    populateSelectOptions(prioritySelect, [...new Set(currentMasterData.map(r => r['(M)優先度']).filter(Boolean))], '（未設定）');
    prioritySelect.value = row['優先度'] || '';
    addRow('優先度', prioritySelect);

    const makeTimeInputs = (dateValue, timeValue) => {
        const [hourValue, minuteValue] = (timeValue || '').split(':');
        const dateInput = document.createElement('input');
        dateInput.type  = 'date';
        dateInput.value = dateValue ? dateValue.replace(/\//g, '-') : '';
        const hourInput = document.createElement('input');
        hourInput.type = 'number'; hourInput.min = 0; hourInput.max = 23;
        hourInput.placeholder = '時'; hourInput.className = 'calendar-time-num';
        hourInput.value = hourValue || '';
        const minuteInput = document.createElement('input');
        minuteInput.type = 'number'; minuteInput.min = 0; minuteInput.max = 59; minuteInput.step = 15;
        minuteInput.placeholder = '分'; minuteInput.className = 'calendar-time-num';
        minuteInput.value = minuteValue || '';
        const colon = document.createElement('span');
        colon.textContent = ':';
        return { dateInput, hourInput, minuteInput, colon };
    };

    const [startDateVal, startTimeVal] = (row['開始予定'] || '').split(' ');
    const start = makeTimeInputs(startDateVal, startTimeVal);
    addRow('開始予定', start.dateInput, start.hourInput, start.colon, start.minuteInput);

    const [endDateVal, endTimeVal] = (row['終了予定'] || '').split(' ');
    const end = makeTimeInputs(endDateVal, endTimeVal);
    addRow('終了予定', end.dateInput, end.hourInput, end.colon, end.minuteInput);

    const completeDateInput = document.createElement('input');
    completeDateInput.type  = 'date';
    completeDateInput.value = (row['完了日'] || '').replace(/\//g, '-');
    const fillDateBtn = document.createElement('button');
    fillDateBtn.type = 'button';
    fillDateBtn.className = 'calendar-add-btn';
    fillDateBtn.textContent = '完了日を開始/終了予定に代入';
    fillDateBtn.addEventListener('click', () => {
        if (!completeDateInput.value) return;
        if (!start.dateInput.value) start.dateInput.value = completeDateInput.value;
        if (!end.dateInput.value)   end.dateInput.value   = completeDateInput.value;
    });
    addRow('完了日', completeDateInput, fillDateBtn);

    const categorySelect = document.createElement('select');
    populateSelectOptions(categorySelect, [...new Set(currentMasterData.map(r => r['(M)カテゴリ']).filter(Boolean))], '（未設定）');
    categorySelect.value = row['カテゴリ'] || '';
    addRow('カテゴリ', categorySelect);

    const tagSelect = document.createElement('select');
    populateSelectOptions(tagSelect, getFilteredTags(), '（未設定）');
    tagSelect.value = row['タグ'] || '';
    addRow('タグ', tagSelect);

    const projectSelect = document.createElement('select');
    populateSelectOptions(projectSelect, getFilteredProjects(), '（未設定）');
    projectSelect.value = row['プロジェクト'] || '';
    addRow('プロジェクト', projectSelect);

    const toolbar = document.createElement('div');
    toolbar.className = 'calendar-edit-toolbar';
    const applyBtn = document.createElement('button');
    applyBtn.textContent = '適用';
    applyBtn.addEventListener('click', () => {
        row['タイトル'] = titleInput.value.trim();
        row['内容']     = contentInput.value.trim();
        row['備考']     = bikoInput.value.trim();
        row['優先度']   = prioritySelect.value;
        row['カテゴリ'] = categorySelect.value;
        row['タグ']     = tagSelect.value;
        row['プロジェクト']     = projectSelect.value;

        const startTime = start.hourInput.value !== '' && start.minuteInput.value !== ''
            ? `${String(start.hourInput.value).padStart(2, '0')}:${String(start.minuteInput.value).padStart(2, '0')}` : '';
        const endTime = end.hourInput.value !== '' && end.minuteInput.value !== ''
            ? `${String(end.hourInput.value).padStart(2, '0')}:${String(end.minuteInput.value).padStart(2, '0')}` : '';
        row['開始予定'] = start.dateInput.value ? `${start.dateInput.value.replace(/-/g, '/')}${startTime ? ' ' + startTime : ''}` : '';
        row['終了予定'] = end.dateInput.value   ? `${end.dateInput.value.replace(/-/g, '/')}${endTime ? ' ' + endTime : ''}`       : '';
        row['完了日']   = completeDateInput.value.replace(/-/g, '/');
        row['更新日時'] = formatJpDatetime(new Date());

        persistLocalCache();
        renderCalendar();
        renderRecurringSection();
        renderTaskRunner();
    });
    toolbar.appendChild(applyBtn);
    section.appendChild(toolbar);

    return section;
}

// ===== カレンダー =====

/** dateJP に●印が出るタスク（フィルタ適用済み）を返す。●の判定とクリック後の一覧表示で共有するロジック。 */
function getTasksForDate(dateJP) {
    return getTasksForDateM(currentMainData, currentCategory, calendarFilters, dateJP);
}

/** 指定日の1日タスク（プロジェクト=DAYPLAN_PROJECT、開始予定=dateJP のタスク行）を返す。無ければ null。 */
function getDayPlanTask(dateJP) {
    return getDayPlanTaskM(currentMainData, dateJP);
}

/** データ区分がタスクで、指定フィールドが value と一致し、ステータスが完了・中断以外の件数を、カテゴリで絞り込んで返す。 */
function countActiveTasksByField(field, value) {
    return countActiveTasksByFieldM(currentMainData, currentCategory, field, value);
}

/** データ区分がタスクで、指定フィールドが value と一致する件数を（ステータスを問わず）、カテゴリで絞り込んで返す。 */
function countTasksByField(field, value) {
    return countTasksByFieldM(currentMainData, currentCategory, field, value);
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
    return sortByTotalCountDescM(options, currentMainData, currentCategory, field);
}

/**
 * タグ／プロジェクト／ステータスの絞り込みチップ（いずれも複数選択可、件数(n/N)併記・N降順）を area に描画する。
 * カレンダー・ガントチャートなど複数箇所から共通利用する。
 * @param {HTMLElement} area     - チップ群を描画する要素
 * @param {{tag:Set, project:Set, status:Set}} filters - 選択状態を持つフィルタ値（複数選択）
 * @param {Function} onChange    - 選択変更時に呼ぶ再描画コールバック
 */
function renderTagProjectStatusFilters(area, filters, onChange) {
    if (!area) return;
    area.innerHTML = '';

    function makeRow(labelText, options, selectedSet, ctrl) {
        const row = document.createElement('div');
        row.className = 'triage-filter-row';
        const lbl = document.createElement('span');
        lbl.className = 'triage-filter-label';
        lbl.textContent = labelText;

        const selectAllBtn = document.createElement('button');
        selectAllBtn.type = 'button';
        selectAllBtn.className = 'calendar-filter-bulk-btn';
        selectAllBtn.textContent = '全選択';
        selectAllBtn.addEventListener('click', () => {
            options.forEach(v => selectedSet.add(v));
            onChange();
        });

        const deselectAllBtn = document.createElement('button');
        deselectAllBtn.type = 'button';
        deselectAllBtn.className = 'calendar-filter-bulk-btn';
        deselectAllBtn.textContent = '全解除';
        deselectAllBtn.addEventListener('click', () => {
            selectedSet.clear();
            onChange();
        });

        row.append(lbl, selectAllBtn, deselectAllBtn, ctrl);
        area.appendChild(row);
    }

    const tagOptions = sortByTotalCountDesc(getFilteredTags(), 'タグ');
    makeRow('タグ', tagOptions, filters.tag, createCalendarMultiFilter(
        tagOptions, filters.tag,
        v => `${v} (${countActiveTasksByField('タグ', v)}/${countTasksByField('タグ', v)})`,
        onChange
    ));

    const projectOptions = sortByTotalCountDesc(getFilteredProjects(), 'プロジェクト');
    makeRow('プロジェクト', projectOptions, filters.project, createCalendarMultiFilter(
        projectOptions, filters.project,
        v => `${v} (${countActiveTasksByField('プロジェクト', v)}/${countTasksByField('プロジェクト', v)})`,
        onChange
    ));

    const taskStatuses = [...new Set(
        currentMasterData.filter(r => r['(M)ステータス_親'] === 'タスク')
            .map(r => r['(M)ステータス_子']).filter(Boolean)
    )];
    const statusOptions = sortByTotalCountDesc(taskStatuses, 'ステータス');
    makeRow('ステータス', statusOptions, filters.status, createCalendarMultiFilter(
        statusOptions, filters.status,
        v => `${v} (${countActiveTasksByField('ステータス', v)}/${countTasksByField('ステータス', v)})`,
        onChange
    ));
}

/** カレンダー上部のタグ／プロジェクト／ステータスフィルタ（いずれも複数選択可）を描画する。 */
function renderCalendarFilters() {
    renderTagProjectStatusFilters(document.getElementById('calendar-filter-area'), calendarFilters, () => renderCalendar());
}

/**
 * タグ／プロジェクト／ステータスでフィルタ中のタスク一覧（日付を問わず全件）を返す。
 * ソート順: ステータス（完了・報告待ち・連絡待ち・中断・進行中・未着手・空欄の順）→ 完了日 昇順 → 開始予定 昇順 → 終了予定 昇順。
 */
function getCalendarFilteredTaskList() {
    return getCalendarFilteredTaskListM(currentMainData, currentCategory, calendarFilters);
}

/** タグ／プロジェクトでフィルタ中のタスク一覧テーブルを、指定した table 要素（カレンダー／ガントチャート共通）に描画する。 */
function renderCalendarTaskList(tableId = 'calendar-task-list-table') {
    const table = document.getElementById(tableId);
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

    const calListEl   = document.getElementById('taskorg-tasklist-calendar');
    const ganttListEl = document.getElementById('taskorg-tasklist-gantt');
    if (calListEl)   calListEl.style.display   = taskOrgView === 'calendar' ? '' : 'none';
    if (ganttListEl) ganttListEl.style.display = taskOrgView === 'gantt'    ? '' : 'none';
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
        renderCalendarTaskList('calendar-task-list-table');
        renderCalendarGrid();
    } else {
        renderCalendarTaskList('gantt-task-list-table');
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

    const workExceptions = parseExceptions(getWorkCalendarContent(calendarYear));

    for (let d = 1; d <= daysInMonth; d++) {
        const dateJP = `${calendarYear}/${pad(calendarMonth + 1)}/${pad(d)}`;
        const cell = document.createElement('div');
        cell.className = 'calendar-day';
        if (dateJP === todayJP)              cell.classList.add('calendar-day--today');
        if (dateJP === selectedCalendarDate) cell.classList.add('calendar-day--selected');

        const workType = workExceptions.get(dateJP)?.type
            ?? getDefaultType(new Date(calendarYear, calendarMonth, d));
        if (workType !== '出勤日') cell.classList.add(`calendar-day--work-${workType}`);

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

/**
 * dateJP のタスクを「時間帯が決まっているもの（timed）」と「時間帯未定（unscheduled）」に分ける。
 * timed の各要素は { row, startMin, endMin }（分単位、0〜1440）。
 */
function getCalendarSegmentsForDate(dateJP) {
    return getCalendarSegmentsForDateM(currentMainData, currentCategory, calendarFilters, dateJP);
}

const CALENDAR_HOUR_HEIGHT = 40; // 1時間あたりの高さ(px)

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

    // 横軸グリッド線（00分=太、30分=中、15分・45分=細）
    for (let m = 0; m < 1440; m += 15) {
        const minuteOfHour = m % 60;
        const variant = minuteOfHour === 0 ? 'hour' : minuteOfHour === 30 ? 'half' : 'quarter';
        const line = document.createElement('div');
        line.className = `calendar-timeline-gridline calendar-timeline-gridline--${variant}`;
        line.style.top = `${m * pxPerMin}px`;
        lanesEl.appendChild(line);
    }

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

        const labelSpan = document.createElement('span');
        labelSpan.textContent = `${fmt(seg.startMin)}–${fmt(seg.endMin)} ${seg.row['タイトル'] || '（無題）'}`;
        block.appendChild(labelSpan);

        const handle = document.createElement('div');
        handle.className = 'calendar-time-block-resize-handle';
        block.appendChild(handle);

        attachTimelineDragHandlers(block, handle, labelSpan, seg, dateJP, pxPerMin, hasLinkedTask);
        lanesEl.appendChild(block);
    });

    // デフォルトで 8:00〜18:00 が見える位置までスクロールする
    const scrollEl = document.getElementById('calendar-timeline-scroll');
    if (scrollEl) scrollEl.scrollTop = 8 * CALENDAR_HOUR_HEIGHT;
}

const TIMELINE_SNAP_MIN = 15;         // ドラッグ操作のスナップ単位（分）
const TIMELINE_DRAG_THRESHOLD_MIN = 8; // これ未満の移動量はクリック（属性編集を開く）として扱う

/** 分を15分単位に丸める。 */
function snapTimelineMinutes(min) {
    return Math.round(min / TIMELINE_SNAP_MIN) * TIMELINE_SNAP_MIN;
}

/**
 * タイムラインのブロックへ「移動（ブロック全体をドラッグ）」「リサイズ（下端ハンドルをドラッグ）」操作を付与する。
 * Pointer Events を使うためマウス・タッチいずれにも対応する。移動量が小さい場合はクリックとして扱い、
 * リンク先タスクがあれば属性編集パネルを開く（従来のクリック挙動を維持）。
 */
function attachTimelineDragHandlers(block, handle, labelSpan, seg, dateJP, pxPerMin, hasLinkedTask) {
    const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    let dragMode  = null; // 'move' | 'resize'
    let pointerId = null;
    let startClientY = 0;
    let origStart = seg.startMin;
    let origEnd   = seg.endMin;
    let pendingStart = seg.startMin;
    let pendingEnd   = seg.endMin;

    function updatePreview(newStart, newEnd) {
        pendingStart = newStart;
        pendingEnd   = newEnd;
        block.style.top    = `${newStart * pxPerMin}px`;
        block.style.height = `${(newEnd - newStart) * pxPerMin}px`;
        labelSpan.textContent = `${fmt(newStart)}–${fmt(newEnd)} ${seg.row['タイトル'] || '（無題）'}`;
    }

    function onPointerMove(e) {
        if (!dragMode) return;
        const deltaMin = snapTimelineMinutes((e.clientY - startClientY) / pxPerMin);

        if (dragMode === 'move') {
            const duration = origEnd - origStart;
            const newStart = Math.max(0, Math.min(1440 - duration, origStart + deltaMin));
            updatePreview(newStart, newStart + duration);
        } else {
            const newEnd = Math.max(origStart + TIMELINE_SNAP_MIN, Math.min(1440, origEnd + deltaMin));
            updatePreview(origStart, newEnd);
        }
    }

    function onPointerUp() {
        if (!dragMode) return;
        block.releasePointerCapture(pointerId);
        block.removeEventListener('pointermove', onPointerMove);
        block.removeEventListener('pointerup', onPointerUp);
        block.removeEventListener('pointercancel', onPointerUp);

        const movedMin = Math.abs(pendingStart - origStart) + Math.abs(pendingEnd - origEnd);
        if (movedMin < TIMELINE_DRAG_THRESHOLD_MIN) {
            updatePreview(origStart, origEnd); // 微小な移動は元に戻す
            if (dragMode === 'move' && hasLinkedTask) openCalendarTaskEdit(String(seg.row['ID']));
        } else {
            commitTimelineDrag(seg, dateJP, pendingStart, pendingEnd);
        }
        dragMode = null;
    }

    function startDrag(mode, e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        dragMode      = mode;
        pointerId     = e.pointerId;
        startClientY  = e.clientY;
        origStart     = seg.startMin;
        origEnd       = seg.endMin;
        pendingStart  = origStart;
        pendingEnd    = origEnd;
        block.setPointerCapture(pointerId);
        block.addEventListener('pointermove', onPointerMove);
        block.addEventListener('pointerup', onPointerUp);
        block.addEventListener('pointercancel', onPointerUp);
        e.preventDefault();
        e.stopPropagation();
    }

    block.addEventListener('pointerdown', (e) => startDrag('move', e));
    handle.addEventListener('pointerdown', (e) => startDrag('resize', e));
}

/**
 * タイムラインのドラッグ操作結果を確定保存する。
 * 1日タスクのスケジュール行（isDayPlanBlock）はその行の時刻を、通常のタスクは開始予定・終了予定（dateJP当日分）を書き換える。
 */
function commitTimelineDrag(seg, dateJP, newStartMin, newEndMin) {
    const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

    if (seg.isDayPlanBlock) {
        const dayPlan = getDayPlanTask(dateJP);
        if (!dayPlan) return;
        dayPlan['内容']     = updateDayPlanBlockTime(dayPlan['内容'], seg.dayPlanBlockIndex, newStartMin, newEndMin);
        dayPlan['更新日時'] = formatJpDatetime(new Date());
    } else {
        const row = currentMainData.find(r => String(r['ID']) === String(seg.row['ID']));
        if (!row) return;
        row['開始予定'] = `${dateJP} ${fmt(newStartMin)}`;
        row['終了予定'] = `${dateJP} ${fmt(newEndMin)}`;
        row['更新日時'] = formatJpDatetime(new Date());
    }

    persistLocalCache();
    renderCalendarDetail();
    renderTaskRunner();
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

/** "HH:MM" 文字列を分に変換する。 */
function parseHHMMToMinutes(str) {
    const [h, m] = str.split(':').map(Number);
    return h * 60 + m;
}

/**
 * 選択中日付の1日タスクを新規作成する（プロジェクト=DAYPLAN_PROJECT、開始予定=選択中日付）。
 * 内容には既定の「09:00-09:30 メールチェック、予定整理」に加え、その日既に開始予定・終了予定が
 * 時刻まで指定されている既存タスクを取り込む（カテゴリの絞り込みは適用、タグ／プロジェクト／ステータスの絞り込みは適用しない）。
 */
function createDayPlanTask() {
    if (!selectedCalendarDate) return;

    const maxId = currentMainData.reduce((max, row) => {
        const id = parseInt(row['ID'], 10);
        return isNaN(id) ? max : Math.max(max, id);
    }, 0);
    const ts = formatJpDatetime(new Date());

    const noFilters = { tag: new Set(), project: new Set(), status: new Set() };
    const scheduledBlocks = getTasksForDateM(currentMainData, currentCategory, noFilters, selectedCalendarDate)
        .map(row => {
            const timeInfo = getTaskScheduledTimeOnDate(row, selectedCalendarDate);
            if (!timeInfo) return null;
            return {
                startMin: parseHHMMToMinutes(timeInfo.startStr),
                endMin:   parseHHMMToMinutes(timeInfo.endStr),
                refId:    String(row['ID']),
                label:    ''
            };
        })
        .filter(Boolean);

    const defaultBlock = { startMin: 9 * 60, endMin: 9 * 60 + 30, refId: null, label: 'メールチェック、予定整理' };
    const content = stringifyDayPlanBlocks(sortDayPlanBlocks([defaultBlock, ...scheduledBlocks]));

    const entry = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
    entry['ID']        = String(maxId + 1);
    entry['データ区分'] = 'タスク';
    entry['タイトル']   = `1日タスク ${selectedCalendarDate}`;
    entry['プロジェクト']       = DAYPLAN_PROJECT;
    entry['開始予定']   = selectedCalendarDate;
    entry['ステータス'] = '未着手';
    entry['内容']       = content;
    entry['作成日時']   = ts;
    entry['更新日時']   = ts;

    currentMainData.push(entry);
    persistLocalCache();
    renderCalendarDetail();
    renderCalendarGrid();
}

/** 編集エリアの内容をその日の1日タスクに保存する。 */
function saveDayPlanContent() {
    if (!selectedCalendarDate) return;
    const dayPlan = getDayPlanTask(selectedCalendarDate);
    if (!dayPlan) return;
    const contentEl  = document.getElementById('dayplan-content');
    const rawContent = contentEl ? contentEl.value : '';
    const sortedBlocks = sortDayPlanBlocks(parseDayPlanContent(rawContent));
    dayPlan['内容']     = stringifyDayPlanBlocks(sortedBlocks);
    dayPlan['更新日時'] = formatJpDatetime(new Date());
    if (contentEl) contentEl.value = dayPlan['内容'];
    persistLocalCache();
    renderCalendarDetail();
}

/** 選択中日付の1日タスクを削除する。 */
function deleteDayPlanTask() {
    if (!selectedCalendarDate) return;
    const dayPlan = getDayPlanTask(selectedCalendarDate);
    if (!dayPlan) return;
    currentMainData = currentMainData.filter(r => r !== dayPlan);
    persistLocalCache();
    renderCalendarDetail();
    renderCalendarGrid();
}

document.getElementById('dayplan-create-btn')?.addEventListener('click', createDayPlanTask);
document.getElementById('dayplan-save-btn')?.addEventListener('click', saveDayPlanContent);
document.getElementById('dayplan-delete-btn')?.addEventListener('click', deleteDayPlanTask);

/**
 * タスクを選択中日付の1日タスクに「HH:MM-HH:MM #ID タイトル」の1行として追加する。1日タスクが無ければ新規作成する。
 * 開始予定・終了予定が今日の日付かつ時刻まで指定されていれば、その時間帯をそのまま使う。
 * 未指定時は、現在時刻以降で30分刻みに丸めた時刻から、その日の既存の予定と重ならない1時間の空き枠を自動で探して挿入する。
 */
function addTaskToDayPlan(row) {
    if (!selectedCalendarDate) return;
    let dayPlan = getDayPlanTask(selectedCalendarDate);
    if (!dayPlan) {
        createDayPlanTask();
        dayPlan = getDayPlanTask(selectedCalendarDate);
        if (!dayPlan) return;
    }
    const busyBlocks = parseDayPlanContent(dayPlan['内容']);
    const { startStr, endStr } = getTaskScheduledTimeOnDate(row, selectedCalendarDate) || computeDayPlanTimeSlot(busyBlocks);
    const line = `${startStr}-${endStr} #${row['ID']} ${row['タイトル'] || '（無題）'}`;
    dayPlan['内容']     = dayPlan['内容'] ? `${dayPlan['内容']}\n${line}` : line;
    dayPlan['更新日時'] = formatJpDatetime(new Date());
    persistLocalCache();
    renderCalendarDetail();
}

/** チップ群（{row, label}の配列）を container に描画する。空なら emptyText を表示する。options.showAddButton（既定true）で1日タスクへの追加＋ボタンの有無を切り替える。 */
function renderCalendarChipList(container, chipEntries, emptyText, options = {}) {
    const { showAddButton = true } = options;
    if (!container) return;
    container.innerHTML = '';
    if (chipEntries.length === 0) {
        const p = document.createElement('p');
        p.className = 'calendar-empty-text';
        p.textContent = emptyText;
        container.appendChild(p);
        return;
    }
    chipEntries.forEach(({ row, label }) => {
        const wrap = document.createElement('span');
        wrap.className = 'calendar-unscheduled-chip-wrap';

        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `calendar-unscheduled-chip ${getCalendarStatusClass(row['ステータス'])}`;
        if (String(row['ID']) === selectedCalendarTaskId) chip.classList.add('calendar-unscheduled-chip--selected');
        chip.textContent = label;
        chip.addEventListener('click', () => openCalendarTaskEdit(String(row['ID'])));
        wrap.appendChild(chip);

        if (showAddButton) {
            const addBtn = document.createElement('button');
            addBtn.type = 'button';
            addBtn.className = 'calendar-unscheduled-chip-add';
            addBtn.title = '1日タスクに追加';
            addBtn.textContent = '+';
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                addTaskToDayPlan(row);
            });
            wrap.appendChild(addBtn);
        }

        container.appendChild(wrap);
    });
}

/**
 * 未設定タスクの一覧を、ステータス（未着手→進行中→中断→連絡待ち→報告待ち→完了→その他の順）でグループ化して描画する。
 * 各グループの見出しは青色太字（calendar-section-label--accent）、グループ内は終了予定が近い順。
 */
function renderGroupedTaskChips(container, chipEntries, emptyText, options = {}) {
    const { showAddButton = false } = options;
    if (!container) return;
    container.innerHTML = '';
    if (chipEntries.length === 0) {
        const p = document.createElement('p');
        p.className = 'calendar-empty-text';
        p.textContent = emptyText;
        container.appendChild(p);
        return;
    }

    const groups = new Map();
    chipEntries.forEach(entry => {
        const status = entry.row['ステータス'] || '（未設定）';
        if (!groups.has(status)) groups.set(status, []);
        groups.get(status).push(entry);
    });
    const sortedStatuses = [...groups.keys()].sort((a, b) => taskOrganizeStatusRank(a) - taskOrganizeStatusRank(b));

    sortedStatuses.forEach(status => {
        const groupEntries = groups.get(status)
            .sort((a, b) => compareDateAscEmptyLast(a.row['終了予定'], b.row['終了予定']));

        const header = document.createElement('p');
        header.className = 'calendar-section-label calendar-section-label--accent calendar-section-label--nested';
        header.textContent = `${status}（${groupEntries.length}）`;
        container.appendChild(header);

        const listEl = document.createElement('div');
        listEl.className = 'calendar-unscheduled-list';
        container.appendChild(listEl);

        renderCalendarChipList(listEl, groupEntries, '', { showAddButton });
    });
}

/** 開始予定・終了予定の少なくとも一方が空欄のタスク（フィルタ適用済み）を返す。 */
function getIncompleteDateTasks() {
    return getIncompleteDateTasksM(currentMainData, currentCategory, calendarFilters);
}

/** カテゴリ／ステータス／優先度／プロジェクトそれぞれが未設定のタスクを、領域ごとに分けて返す（重複あり）。 */
function getUnsetAttributeGroups() {
    return getUnsetAttributeGroupsM(currentMainData, currentCategory);
}

/** ステータスが「中断」のタスクを返す（終了予定が近い順）。 */
function getSuspendedTasks() {
    return getSuspendedTasksM(currentMainData, currentCategory);
}

/** 選択中の日付の詳細ビュー（時間帯未定タスク・1日の予定表・属性編集パネル）を描画する。 */
/** id要素（expander-count用span）に "N 件" 形式で件数を表示する。 */
function setExpanderCount(id, count) {
    const el = document.getElementById(id);
    if (el) el.textContent = `${count} 件`;
}

/** id要素（expander-count用span）に "N件 / N件" 形式で2つの件数を表示する。 */
function setExpanderCountPair(id, countA, countB) {
    const el = document.getElementById(id);
    if (el) el.textContent = `${countA} 件 / ${countB} 件`;
}

function renderCalendarDetail() {
    const titleEl        = document.getElementById('calendar-detail-title');
    const unscheduledEl  = document.getElementById('calendar-unscheduled-list');
    const dayplanAddedEl = document.getElementById('calendar-dayplan-added-list');
    const incompleteEl      = document.getElementById('calendar-incomplete-date-list');
    const unsetCategoryEl   = document.getElementById('calendar-unset-category-list');
    const unsetStatusEl     = document.getElementById('calendar-unset-status-list');
    const unsetPriorityEl   = document.getElementById('calendar-unset-priority-list');
    const unsetProjectEl        = document.getElementById('calendar-unset-project-list');
    const suspendedEl       = document.getElementById('calendar-suspended-list');
    if (!titleEl) return;

    const incompleteChips = getIncompleteDateTasks().map(row => ({ row, label: row['タイトル'] || '（無題）' }));
    renderCalendarChipList(incompleteEl, incompleteChips, '該当するタスクはありません');
    setExpanderCount('calendar-incomplete-count', incompleteChips.length);

    const unsetGroups = getUnsetAttributeGroups();
    const toChips = rows => rows.map(row => ({ row, label: row['タイトル'] || '（無題）' }));
    renderCalendarChipList(unsetCategoryEl, toChips(unsetGroups.categoryUnset), '該当するタスクはありません', { showAddButton: false });
    renderCalendarChipList(unsetStatusEl,   toChips(unsetGroups.statusUnset),   '該当するタスクはありません', { showAddButton: false });
    renderCalendarChipList(unsetPriorityEl, toChips(unsetGroups.priorityUnset), '該当するタスクはありません', { showAddButton: false });
    renderCalendarChipList(unsetProjectEl,      toChips(unsetGroups.projectUnset),      '該当するタスクはありません', { showAddButton: false });
    setExpanderCount('calendar-unset-category-count', unsetGroups.categoryUnset.length);
    setExpanderCount('calendar-unset-status-count',   unsetGroups.statusUnset.length);
    setExpanderCount('calendar-unset-priority-count', unsetGroups.priorityUnset.length);
    setExpanderCount('calendar-unset-project-count',      unsetGroups.projectUnset.length);
    setExpanderCount('calendar-unset-total-count',
        unsetGroups.categoryUnset.length + unsetGroups.statusUnset.length +
        unsetGroups.priorityUnset.length + unsetGroups.projectUnset.length);

    const suspendedChips = toChips(getSuspendedTasks());
    renderCalendarChipList(suspendedEl, suspendedChips, '該当するタスクはありません', { showAddButton: false });
    setExpanderCount('calendar-suspended-count', suspendedChips.length);

    if (!selectedCalendarDate) {
        titleEl.textContent = 'カレンダーで日付を選択してください';
        if (unscheduledEl)  unscheduledEl.innerHTML = '';
        if (dayplanAddedEl) dayplanAddedEl.innerHTML = '';
        setExpanderCountPair('calendar-todo-dayplan-count', 0, 0);
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

    const { timed, unscheduled, referenced } = getCalendarSegmentsForDate(selectedCalendarDate);
    const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const chipEntries = [
        ...unscheduled.map(row => ({ row, label: row['タイトル'] || '（無題）' })),
        ...timed.filter(seg => seg.row['ID'] != null && !seg.isDayPlanBlock)
                .map(seg => ({ row: seg.row, label: `${fmt(seg.startMin)}–${fmt(seg.endMin)} ${seg.row['タイトル'] || '（無題）'}` })),
    ];
    chipEntries.sort((a, b) => compareDateAscEmptyLast(a.row['終了予定'], b.row['終了予定']));
    renderGroupedTaskChips(unscheduledEl, chipEntries, 'この日のタスクはありません', { showAddButton: true });

    const referencedChips = referenced.map(row => ({ row, label: row['タイトル'] || '（無題）' }));
    renderGroupedTaskChips(dayplanAddedEl, referencedChips, 'まだありません');

    setExpanderCountPair('calendar-todo-dayplan-count', chipEntries.length, referencedChips.length);

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
const dayeditFreq = { month: new Set(), day: new Set(), weekday: new Set() }; // 属性編集パネルの頻度チップの選択状態

/** 「繰り返しタスクの親として管理する」チェックボックスの状態に応じて頻度（月/日/曜日）チップの表示・非表示を切り替える。 */
function updateDayeditFreqVisibility() {
    const section = document.getElementById('dayedit-freq-section');
    const checkbox = document.getElementById('dayedit-recurring-parent');
    if (section) section.style.display = (checkbox && checkbox.checked) ? '' : 'none';
}

/** 属性編集パネルの頻度（月/日/曜日）チップを描画する。 */
function renderDayeditFreqChips() {
    renderFreqChipsFor('dayedit', dayeditFreq);
}

document.getElementById('dayedit-recurring-parent')?.addEventListener('change', updateDayeditFreqVisibility);

/** ステータスを「完了」に変更したら、完了日を自動的に本日の日付にする。 */
document.getElementById('dayedit-status')?.addEventListener('change', (e) => {
    if (e.target.value !== '完了') return;
    const completeEl = document.getElementById('dayedit-complete-date');
    if (!completeEl) return;
    const today = new Date();
    const pad = n => String(n).padStart(2, '0');
    completeEl.value = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
});

function renderCalendarTaskEdit() {
    const panel = document.getElementById('calendar-task-edit');
    if (!panel) return;

    populateTaskEditSelects('dayedit');

    const row = selectedCalendarTaskId
        ? currentMainData.find(r => String(r['ID']) === selectedCalendarTaskId)
        : null;

    if (!row) {
        selectedCalendarTaskId = null;
        clearCalendarTaskEditForm();
        renderDayeditFreqChips();
        updateDayeditFreqVisibility();
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
    document.getElementById('dayedit-project').value      = row['プロジェクト']       ?? '';

    writeTaskDateTimeFieldsToForm('dayedit', row);
    writeTaskEstimateActualToForm('dayedit', row);

    const recurringCheckbox = document.getElementById('dayedit-recurring-parent');
    if (recurringCheckbox) recurringCheckbox.checked = row['繰返し識別子'] === '1' && !row['繰返し親ID'];

    loadFreqStateFromRow(dayeditFreq, row);
    renderDayeditFreqChips();
    updateDayeditFreqVisibility();
}

/**
 * 編集フォームをクリアし、新規登録モードの初期値を設定する。
 * - 開始予定・終了予定の日付: 選択中のカレンダー日付
 * - タグ／プロジェクト: カレンダーで絞り込み中の値があればそれ
 * - ステータス: 未着手／優先度: 中（マスタに存在する場合のみ反映）
 * - カテゴリ: サイドバーで選択中のカテゴリ（「すべて」以外）
 */
function clearCalendarTaskEditForm() {
    ['dayedit-id', 'dayedit-title', 'dayedit-content', 'dayedit-biko', 'dayedit-status', 'dayedit-priority',
     'dayedit-estimate', 'dayedit-actual',
     'dayedit-start-hour', 'dayedit-start-minute', 'dayedit-end-hour', 'dayedit-end-minute',
     'dayedit-complete-date', 'dayedit-category', 'dayedit-tag', 'dayedit-project'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    dayeditFreq.month.clear();
    dayeditFreq.day.clear();
    dayeditFreq.weekday.clear();
    const recurringCheckbox = document.getElementById('dayedit-recurring-parent');
    if (recurringCheckbox) recurringCheckbox.checked = false;

    // 一覧末尾の「（新規作成）」から起動した場合は、日付をカレンダー選択日で埋めずに空欄のままにする
    const dateValue = (!calendarQuickNewMode && selectedCalendarDate) ? selectedCalendarDate.replace(/\//g, '-') : '';
    const startDateEl = document.getElementById('dayedit-start-date');
    if (startDateEl) startDateEl.value = dateValue;
    const endDateEl = document.getElementById('dayedit-end-date');
    if (endDateEl) endDateEl.value = dateValue;

    // タグ／プロジェクトが1つだけ選択されている場合のみ、新規タスクの初期値として反映する
    const tagEl = document.getElementById('dayedit-tag');
    if (tagEl && calendarFilters.tag.size === 1) tagEl.value = [...calendarFilters.tag][0];
    const projectEl = document.getElementById('dayedit-project');
    if (projectEl && calendarFilters.project.size === 1) projectEl.value = [...calendarFilters.project][0];

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

// ---- タスク編集フォーム（dayedit-* / recuredit-*）共通ヘルパー ----
// カレンダーの属性編集パネルと繰り返しタスクの編集パネルは、id接頭辞（prefix）が異なるだけで
// ステータス/優先度/カテゴリ/タグ/プロジェクトの選択肢・日時フィールド・頻度チップの構造が同一のため、
// prefixを引数に取る共通関数へ集約する。

/** prefix-status／priority／category／tag／project の select 選択肢を再構築する。 */
function populateTaskEditSelects(prefix) {
    const statuses = [...new Set(
        currentMasterData.filter(r => r['(M)ステータス_親'] === 'タスク')
            .map(r => r['(M)ステータス_子']).filter(Boolean)
    )];
    rebuildSelectById(`${prefix}-status`,   statuses);
    rebuildSelectById(`${prefix}-priority`, [...new Set(currentMasterData.map(r => r['(M)優先度']).filter(Boolean))]);
    rebuildSelectById(`${prefix}-category`, [...new Set(currentMasterData.map(r => r['(M)カテゴリ']).filter(Boolean))]);
    rebuildSelectById(`${prefix}-tag`,      getFilteredTags());
    rebuildSelectById(`${prefix}-project`,      getFilteredProjects());
}

/** row の開始予定・終了予定・完了日を、prefix-start-date/hour/minute 等のフォーム欄に分解して反映する。 */
function writeTaskDateTimeFieldsToForm(prefix, row) {
    const [startDate, startTime] = (row['開始予定'] || '').split(' ');
    const [endDate,   endTime]   = (row['終了予定'] || '').split(' ');
    const [startHour, startMinute] = (startTime || '').split(':');
    const [endHour,   endMinute]   = (endTime   || '').split(':');
    document.getElementById(`${prefix}-start-date`).value   = startDate ? startDate.replace(/\//g, '-') : '';
    document.getElementById(`${prefix}-start-hour`).value   = startHour   || '';
    document.getElementById(`${prefix}-start-minute`).value = startMinute || '';
    document.getElementById(`${prefix}-end-date`).value     = endDate ? endDate.replace(/\//g, '-') : '';
    document.getElementById(`${prefix}-end-hour`).value     = endHour     || '';
    document.getElementById(`${prefix}-end-minute`).value   = endMinute   || '';
    document.getElementById(`${prefix}-complete-date`).value = (row['完了日'] || '').replace(/\//g, '-');
}

/** prefix-start-date/hour/minute 等のフォーム欄から開始予定・終了予定・完了日を読み取り、保存用文字列にまとめて返す。 */
function readTaskDateTimeFieldsFromForm(prefix) {
    const startDate = document.getElementById(`${prefix}-start-date`).value;
    const startTime = readCalendarTime(`${prefix}-start-hour`, `${prefix}-start-minute`);
    const endDate    = document.getElementById(`${prefix}-end-date`).value;
    const endTime    = readCalendarTime(`${prefix}-end-hour`, `${prefix}-end-minute`);
    return {
        開始予定: startDate ? `${startDate.replace(/-/g, '/')}${startTime ? ' ' + startTime : ''}` : '',
        終了予定: endDate   ? `${endDate.replace(/-/g, '/')}${endTime ? ' ' + endTime : ''}`       : '',
        完了日:   document.getElementById(`${prefix}-complete-date`).value.replace(/-/g, '/'),
    };
}

/** row の見積時間・実績時間（実績は編集不可）をフォームへ反映する。 */
function writeTaskEstimateActualToForm(prefix, row) {
    const estimateEl = document.getElementById(`${prefix}-estimate`);
    if (estimateEl) estimateEl.value = row['見積時間'] ?? '';
    const actualEl = document.getElementById(`${prefix}-actual`);
    if (actualEl) actualEl.value = String(computeActualHours(row));
}

/** prefix-freq-month/day/weekday の頻度チップを freqState に基づいて描画する（選択変更時は自身を再描画）。各項目に全て選択／全て解除ボタンを併設する。 */
function renderFreqChipsFor(prefix, freqState) {
    const monthOptions   = [...new Set(currentMasterData.map(r => r['(M)繰返し頻度_月']).filter(Boolean))];
    const dayOptions     = [...new Set(currentMasterData.map(r => r['(M)繰返し頻度_日']).filter(Boolean))];
    const weekdayOptions = [...new Set(currentMasterData.map(r => r['(M)繰返し頻度_曜日']).filter(Boolean))];

    const rerender = () => renderFreqChipsFor(prefix, freqState);

    function buildFreqControl(containerId, options, selectedSet) {
        const el = document.getElementById(containerId);
        if (!el) return;

        const selectAllBtn = document.createElement('button');
        selectAllBtn.type = 'button';
        selectAllBtn.className = 'calendar-filter-bulk-btn';
        selectAllBtn.textContent = '全て選択';
        selectAllBtn.addEventListener('click', () => { options.forEach(v => selectedSet.add(v)); rerender(); });

        const deselectAllBtn = document.createElement('button');
        deselectAllBtn.type = 'button';
        deselectAllBtn.className = 'calendar-filter-bulk-btn';
        deselectAllBtn.textContent = '全て解除';
        deselectAllBtn.addEventListener('click', () => { selectedSet.clear(); rerender(); });

        const chips = createCalendarMultiFilter(options, selectedSet, v => v, rerender);
        el.replaceChildren(selectAllBtn, deselectAllBtn, chips);
    }

    buildFreqControl(`${prefix}-freq-month`,   monthOptions,   freqState.month);
    buildFreqControl(`${prefix}-freq-day`,     dayOptions,     freqState.day);
    buildFreqControl(`${prefix}-freq-weekday`, weekdayOptions, freqState.weekday);
}

/** row の繰返し頻度_月／日／曜日 を freqState（{month,day,weekday}のSet集合）へ読み込む。 */
function loadFreqStateFromRow(freqState, row) {
    freqState.month.clear();   (row['繰返し頻度_月']   || '').split(',').map(s => s.trim()).filter(Boolean).forEach(v => freqState.month.add(v));
    freqState.day.clear();     (row['繰返し頻度_日']   || '').split(',').map(s => s.trim()).filter(Boolean).forEach(v => freqState.day.add(v));
    freqState.weekday.clear(); (row['繰返し頻度_曜日'] || '').split(',').map(s => s.trim()).filter(Boolean).forEach(v => freqState.weekday.add(v));
}

/** 「完了日を開始/終了予定に代入」ボタン: 完了日が入力済みで、開始予定・終了予定の空欄になっている方だけに完了日（時間帯なし）を代入する。 */
document.getElementById('dayedit-fill-date-from-complete-btn')?.addEventListener('click', () => {
    const completeDate = document.getElementById('dayedit-complete-date').value;
    if (!completeDate) return;

    const startDateEl = document.getElementById('dayedit-start-date');
    const endDateEl   = document.getElementById('dayedit-end-date');
    if (!startDateEl.value) startDateEl.value = completeDate;
    if (!endDateEl.value)   endDateEl.value   = completeDate;
});

/**
 * 「繰り返しタスクの親として管理する」チェックボックスがONなら、target を繰り返しタスクの親として
 * 繰返し識別子・繰返し頻度_月/日/曜日 を設定する。OFFなら関連フィールドを空にする。
 * 自動生成の有効/無効はここでは扱わず、ステータスが「進行中」かどうかで別途判定する。
 */
function applyRecurringFieldsFromForm(target) {
    const isRecurringParent = document.getElementById('dayedit-recurring-parent')?.checked;
    if (isRecurringParent) {
        target['繰返し識別子']   = '1';
        target['繰返し親ID']     = target['繰返し親ID'] || '';
        target['繰返し頻度_月']  = [...dayeditFreq.month].join(',');
        target['繰返し頻度_日']  = [...dayeditFreq.day].join(',');
        target['繰返し頻度_曜日'] = [...dayeditFreq.weekday].join(',');
    } else {
        target['繰返し識別子']   = '';
        target['繰返し頻度_月']  = '';
        target['繰返し頻度_日']  = '';
        target['繰返し頻度_曜日'] = '';
    }
}

/** 「適用」ボタン: 属性編集パネルの内容を選択中タスクへ書き戻す。 */
document.getElementById('dayedit-apply-btn')?.addEventListener('click', () => {
    if (!selectedCalendarTaskId) return;
    const row = currentMainData.find(r => String(r['ID']) === selectedCalendarTaskId);
    if (!row) return;

    const status = document.getElementById('dayedit-status').value;

    row['タイトル']   = document.getElementById('dayedit-title').value.trim();
    row['内容']       = document.getElementById('dayedit-content').value.trim();
    row['備考']       = document.getElementById('dayedit-biko').value.trim();
    row['ステータス'] = status;
    row['優先度']     = document.getElementById('dayedit-priority').value;
    row['見積時間']   = document.getElementById('dayedit-estimate').value;
    row['カテゴリ']   = document.getElementById('dayedit-category').value;
    row['タグ']       = document.getElementById('dayedit-tag').value;
    row['プロジェクト']       = document.getElementById('dayedit-project').value;
    applyRecurringFieldsFromForm(row);
    Object.assign(row, readTaskDateTimeFieldsFromForm('dayedit'));
    row['更新日時'] = formatJpDatetime(new Date());

    persistLocalCache();
    renderCalendar();
    renderTaskRunner();
    renderRecurringSection();
});

/** 「削除」ボタン: 選択中タスクをメインデータから完全に削除する。 */
document.getElementById('dayedit-delete-btn')?.addEventListener('click', () => {
    if (!selectedCalendarTaskId) return;
    if (!confirm('このタスクを削除します。よろしいですか？（この操作は取り消せません）')) return;

    currentMainData = currentMainData.filter(r => String(r['ID']) !== selectedCalendarTaskId);
    selectedCalendarTaskId = null;

    persistLocalCache();
    renderCalendar();
    renderTaskRunner();
    renderRecurringSection();
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
    entry['見積時間']   = document.getElementById('dayedit-estimate').value;
    entry['カテゴリ']   = document.getElementById('dayedit-category').value || (currentCategory === 'すべて' ? '' : currentCategory);
    entry['タグ']       = document.getElementById('dayedit-tag').value;
    entry['プロジェクト']       = document.getElementById('dayedit-project').value;
    applyRecurringFieldsFromForm(entry);
    Object.assign(entry, readTaskDateTimeFieldsFromForm('dayedit'));
    entry['作成日時']   = ts;
    entry['更新日時']   = ts;

    currentMainData.push(entry);
    persistLocalCache();

    selectedCalendarTaskId = null;
    renderCalendar();
    renderTaskRunner();
});

function goToPrevMonth() {
    calendarMonth--;
    if (calendarMonth < 0) { calendarMonth = 11; calendarYear--; }
    if (taskOrgView === 'calendar') renderCalendarGrid(); else renderGanttChart();
}

function goToNextMonth() {
    calendarMonth++;
    if (calendarMonth > 11) { calendarMonth = 0; calendarYear++; }
    if (taskOrgView === 'calendar') renderCalendarGrid(); else renderGanttChart();
}

document.getElementById('calendar-prev-btn')?.addEventListener('click', goToPrevMonth);
document.getElementById('calendar-next-btn')?.addEventListener('click', goToNextMonth);
document.getElementById('gantt-prev-btn')?.addEventListener('click', goToPrevMonth);
document.getElementById('gantt-next-btn')?.addEventListener('click', goToNextMonth);

// ===== ガントチャート（タスクページ） =====

/** カテゴリ・calendarFilters（タグ／プロジェクト／ステータス）で絞り込んだタスク一覧を返す。1日タスクは除外し、日付未設定の行も除外する。 */
function getGanttTasks() {
    return getFilteredMainData().filter(r => {
        if (r['データ区分'] !== 'タスク') return false;
        if (r['プロジェクト'] === DAYPLAN_PROJECT) return false;
        if (!r['開始予定'] && !r['終了予定']) return false;
        if (!matchesMultiFilter(calendarFilters.tag, r['タグ'])) return false;
        if (!matchesMultiFilter(calendarFilters.project, r['プロジェクト'])) return false;
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
    const label = document.getElementById('gantt-month-label');
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
    const ganttWorkExceptions = parseExceptions(getWorkCalendarContent(calendarYear));

    columns.forEach(col => {
        const th = document.createElement('th');
        th.className = ganttViewUnit === 'week' ? 'gantt-day-col gantt-week-col' : 'gantt-day-col';
        if (col.isToday)    th.classList.add('gantt-day-col--today');
        if (col.isSelected) th.classList.add('gantt-day-col--selected');

        if (ganttViewUnit === 'day') {
            const [y, m, d] = col.dates[0].split('/').map(Number);
            const wType = ganttWorkExceptions.get(col.dates[0])?.type
                ?? getDefaultType(new Date(y, m - 1, d));
            if (wType !== '出勤日') th.classList.add(`gantt-day-col--work-${wType}`);
        }

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

let recurringEditChart = null;
let selectedRecurringParentId = null; // 親タスク一覧・子タスク一覧の表示対象として選択中の親タスクID
let selectedRecurringEditId   = null; // 編集パネルに読み込み中のタスクID（親または子。nullなら新規登録モード）
const recurEditFreq = { month: new Set(), day: new Set(), weekday: new Set() }; // 親タスク編集パネルの頻度チップの選択状態
let recurringListView = 'all'; // 親タスク一覧の表示切り替え（'all' | 'today'）
let selectedWeeklyDate = null; // 週間ビューで選択中の日付（"YYYY/MM/DD"）

document.querySelectorAll('#recurring-tab-all, #recurring-tab-today').forEach(btn => {
    btn.addEventListener('click', () => {
        recurringListView = btn.dataset.view;
        document.querySelectorAll('#recurring-tab-all, #recurring-tab-today').forEach(b =>
            b.classList.toggle('taskorg-view-btn--active', b === btn)
        );
        renderRecurringParentTable();
    });
});

/** 親タスク一覧テーブル（プロジェクト・親タスク名・子タスク数・ステータス・頻度）を描画する。行クリックで編集パネルに読み込む。 */
function renderRecurringParentTable() {
    const container = document.getElementById('recurring-section');
    if (!container) return;
    container.innerHTML = '';

    const today = new Date();
    const parents = getFilteredMainData().filter(r =>
        r['繰返し識別子'] === '1' && !r['繰返し親ID']
        && (recurringListView !== 'today' || matchesSchedule(r, today))
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

    const table = document.createElement('table');
    table.className = 'data-table recurring-parent-table';
    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    ['プロジェクト', '親タスク名', '子タスク数', 'ステータス', '頻度'].forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    parents.forEach(parent => {
        const parentId = String(parent['ID']);
        const childCount = currentMainData.filter(r => r['繰返し親ID'] === parentId).length;

        const tr = document.createElement('tr');
        tr.className = 'recurring-parent-row';
        if (parentId === selectedRecurringParentId) tr.classList.add('selected-row');
        const cells = [
            parent['プロジェクト'] || '',
            parent['タイトル'] || '（無題）',
            String(childCount),
            parent['ステータス'] || '未設定',
            formatRecurringFrequencyLabel(parent),
        ];
        cells.forEach(text => {
            const td = document.createElement('td');
            td.textContent = text;
            tr.appendChild(td);
        });
        tr.addEventListener('click', () => {
            selectedRecurringParentId = parentId;
            selectedRecurringEditId   = parentId;
            renderRecurringSection();
        });
        tbody.appendChild(tr);
    });
    table.append(thead, tbody);
    const wrap = document.createElement('div');
    wrap.className = 'table-wrapper table-wrapper--limited';
    wrap.appendChild(table);
    container.appendChild(wrap);
}

const RECURRING_WEEKDAY_LABELS = ['月', '火', '水', '木', '金', '土', '日']; // 週間ビューの列順（月始まり）

let recurringWeeklyKnownIds = new Set();    // これまでに存在を確認した習慣ID（新規追加時にチェック済みで初期表示するため）
let recurringWeeklySelected = new Set();    // 週間ビューに表示する習慣ID（チェックボックスで選択中のもの）

/** 週間ビューに表示する習慣を選ぶチェックボックス一覧を描画する。新しく増えた習慣は初期状態でチェック済みにする。 */
function renderRecurringWeeklyChecklist(parents) {
    const container = document.getElementById('recurring-weekly-checklist');
    if (!container) return;
    container.innerHTML = '';

    parents.forEach(parent => {
        const parentId = String(parent['ID']);
        if (!recurringWeeklyKnownIds.has(parentId)) {
            recurringWeeklyKnownIds.add(parentId);
            recurringWeeklySelected.add(parentId); // 新規習慣はデフォルトで表示対象にする
        }

        const label = document.createElement('label');
        label.className = 'recurring-weekly-check-label';
        const checkbox = document.createElement('input');
        checkbox.type    = 'checkbox';
        checkbox.checked = recurringWeeklySelected.has(parentId);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) recurringWeeklySelected.add(parentId);
            else recurringWeeklySelected.delete(parentId);
            renderRecurringWeeklyTables(parents);
        });
        label.append(checkbox, document.createTextNode(' ' + (parent['タイトル'] || '（無題）')));
        container.appendChild(label);
    });
}

/** 1つの週（月〜日）のテーブルを構築して tableEl に描画する。 */
function buildRecurringWeeklyTable(tableEl, weekStart, parents) {
    if (!tableEl) return;
    tableEl.innerHTML = '';

    const todayStr = formatSlashDateForRecurring(new Date());

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    ['習慣', ...RECURRING_WEEKDAY_LABELS].forEach((text, idx) => {
        const th = document.createElement('th');
        th.textContent = text;
        if (idx > 0) {
            const date = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + (idx - 1));
            if (formatSlashDateForRecurring(date) === todayStr) th.classList.add('recurring-weekly-col--today');
        }
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    parents.forEach(parent => {
        const parentId = String(parent['ID']);
        if (!recurringWeeklySelected.has(parentId)) return;

        const tr = document.createElement('tr');
        const titleTd = document.createElement('td');
        titleTd.textContent = parent['タイトル'] || '（無題）';
        titleTd.className = 'recurring-weekly-title';
        tr.appendChild(titleTd);

        RECURRING_WEEKDAY_LABELS.forEach((_, dayIdx) => {
            const date      = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + dayIdx);
            const slashDate = formatSlashDateForRecurring(date);
            const td = document.createElement('td');
            td.className = 'recurring-weekly-cell';
            if (slashDate === todayStr) td.classList.add('recurring-weekly-col--today');

            if (!matchesSchedule(parent, date)) {
                td.textContent = '-';
                td.classList.add('recurring-weekly-cell--none');
            } else {
                const child = currentMainData.find(r => r['繰返し親ID'] === parentId && r['開始予定'] === slashDate);
                const dot = document.createElement('span');
                dot.className = 'recurring-weekly-dot';
                if (!child) {
                    dot.classList.add('recurring-weekly-dot--pending');
                } else if (isTaskDoneForCalendar(child)) {
                    dot.classList.add('recurring-weekly-dot--done');
                } else {
                    dot.classList.add('recurring-weekly-dot--notdone');
                }
                dot.textContent = '●';
                td.appendChild(dot);
                td.style.cursor = 'pointer';
                if (slashDate === selectedWeeklyDate) td.classList.add('selected-row');
                td.addEventListener('click', () => {
                    selectedWeeklyDate = slashDate;
                    renderRecurringWeeklyView();
                });
            }
            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    });

    tableEl.append(thead, tbody);
}

/** 今週・来週それぞれの週間ビューテーブルを描画する。 */
function renderRecurringWeeklyTables(parents) {
    const thisMonday = getMondayOf(new Date());
    const nextMonday = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() + 7);

    buildRecurringWeeklyTable(document.getElementById('recurring-weekly-table-current'), thisMonday, parents);
    buildRecurringWeeklyTable(document.getElementById('recurring-weekly-table-next'),    nextMonday, parents);
    renderRecurringWeeklyDetail();
}

/**
 * 週間ビュー（今週・来週の習慣を可視化）を描画する。
 * チェックボックスで選択中の習慣だけを対象に、今週・来週それぞれのテーブルへ月〜日で表示する。
 * セルの●は子タスクベースで判定し、完了系ステータス（完了・中断・報告待ち・連絡待ち）なら緑、
 * 未完了なら赤、未生成なら灰で表示する。●をクリックすると、その日に該当する全習慣の子タスク一覧を下部に表示する。
 */
function renderRecurringWeeklyView() {
    const parents = getFilteredMainData().filter(r => r['繰返し識別子'] === '1' && !r['繰返し親ID']);
    renderRecurringWeeklyChecklist(parents);
    renderRecurringWeeklyTables(parents);
}

/** 週間ビューで選択中の日付に該当する習慣の子タスク一覧を表示する。全件が完了系ステータスなら緑、それ以外は赤の見出しにする。 */
function renderRecurringWeeklyDetail() {
    const container = document.getElementById('recurring-weekly-detail');
    if (!container) return;
    container.innerHTML = '';

    if (!selectedWeeklyDate) {
        const hint = document.createElement('p');
        hint.className = 'placeholder-text';
        hint.textContent = '●をクリックすると、その日の習慣タスク一覧を表示します';
        container.appendChild(hint);
        return;
    }

    const children = currentMainData.filter(r =>
        r['繰返し親ID'] && r['開始予定'] === selectedWeeklyDate
    );

    const heading = document.createElement('p');
    heading.className = 'calendar-section-label';
    if (children.length === 0) {
        heading.textContent = `${selectedWeeklyDate} の習慣タスクはありません`;
        container.appendChild(heading);
        return;
    }

    const allDone = children.every(isTaskDoneForCalendar);
    heading.textContent = `${selectedWeeklyDate}（${allDone ? 'すべて完了' : '未完了あり'}）`;
    heading.style.color = allDone ? '#28a745' : '#dc3545';
    container.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'calendar-unscheduled-list';
    children.forEach(child => {
        const chip = document.createElement('span');
        chip.className = `calendar-unscheduled-chip ${getCalendarStatusClass(child['ステータス'])}`;
        chip.textContent = `${child['タイトル'] || '（無題）'}（${child['ステータス'] || '未設定'}）`;
        list.appendChild(chip);
    });
    container.appendChild(list);
}

/** 選択中の親タスクに属する子タスク一覧を描画する（未選択なら非表示）。行クリックで編集パネルにその子タスクを読み込む。 */
function renderRecurringChildTable() {
    const section = document.getElementById('recurring-child-section');
    const table   = document.getElementById('recurring-child-table');
    if (!section || !table) return;

    if (!selectedRecurringParentId) {
        section.style.display = 'none';
        table.innerHTML = '';
        return;
    }
    section.style.display = '';

    const children = getFilteredMainData().filter(r => r['繰返し親ID'] === selectedRecurringParentId);

    table.className = 'data-table';
    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    ['ID', 'タイトル', 'ステータス', '開始予定', '終了予定', '完了日'].forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    if (children.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.className = 'empty-cell';
        td.colSpan = 6;
        td.textContent = '子タスクがありません';
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        children.forEach(row => {
            const tr = document.createElement('tr');
            tr.className = 'recurring-parent-row';
            if (String(row['ID']) === selectedRecurringEditId) tr.classList.add('selected-row');
            ['ID', 'タイトル', 'ステータス', '開始予定', '終了予定', '完了日'].forEach(col => {
                const td = document.createElement('td');
                td.textContent = row[col] ?? '';
                tr.appendChild(td);
            });
            tr.addEventListener('click', () => {
                selectedRecurringEditId = String(row['ID']);
                renderRecurringSection();
            });
            tbody.appendChild(tr);
        });
    }
    table.replaceChildren(thead, tbody);
}

/** 選択中の親タスクの実績グラフを描画する（未選択・子タスク無しなら案内文を表示）。 */
function renderRecurringEditChart() {
    const wrap = document.getElementById('recurring-edit-chart-wrap');
    if (!wrap) return;

    if (recurringEditChart) { recurringEditChart.destroy(); recurringEditChart = null; }
    wrap.innerHTML = '';

    if (!selectedRecurringParentId) {
        const p = document.createElement('p');
        p.className    = 'placeholder-text';
        p.textContent  = '親タスクを選択するとグラフが表示されます';
        wrap.appendChild(p);
        return;
    }

    const children  = currentMainData.filter(r => r['繰返し親ID'] === selectedRecurringParentId);
    const chartData = buildChildChartData(children);

    if (chartData.labels.length > 0 && window.Chart) {
        const canvas = document.createElement('canvas');
        wrap.appendChild(canvas);
        recurringEditChart = new window.Chart(canvas, {
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
    } else {
        const p = document.createElement('p');
        p.className   = 'placeholder-text';
        p.textContent = chartData.labels.length === 0
            ? '子タスクに実績データがありません'
            : 'Chart.js が読み込まれていません';
        wrap.appendChild(p);
    }
}

/** 親タスク編集パネルの頻度（月/日/曜日）チップを描画する。 */
function renderRecurEditFreqChips() {
    renderFreqChipsFor('recuredit', recurEditFreq);
}

/** 親タスク編集パネルをクリアし、新規登録モードの初期値を設定する。 */
function clearRecurEditForm() {
    ['recuredit-id', 'recuredit-title', 'recuredit-content', 'recuredit-biko', 'recuredit-status', 'recuredit-priority',
     'recuredit-estimate', 'recuredit-actual',
     'recuredit-start-date', 'recuredit-start-hour', 'recuredit-start-minute',
     'recuredit-end-date', 'recuredit-end-hour', 'recuredit-end-minute',
     'recuredit-complete-date', 'recuredit-category', 'recuredit-tag', 'recuredit-project'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    recurEditFreq.month.clear();
    recurEditFreq.day.clear();
    recurEditFreq.weekday.clear();

    const statusEl = document.getElementById('recuredit-status');
    if (statusEl) statusEl.value = '進行中';
    const priorityEl = document.getElementById('recuredit-priority');
    if (priorityEl) priorityEl.value = '中';
    const categoryEl = document.getElementById('recuredit-category');
    if (categoryEl && currentCategory !== 'すべて') categoryEl.value = currentCategory;
}

/** 親タスク編集パネルを描画する。選択中の親タスクがあれば編集モード、無ければ新規登録モード。 */
function renderRecurringEditPanel() {
    const panel = document.getElementById('recurring-task-edit');
    if (!panel) return;

    populateTaskEditSelects('recuredit');

    const row = selectedRecurringEditId
        ? currentMainData.find(r => String(r['ID']) === selectedRecurringEditId)
        : null;

    if (!row) {
        selectedRecurringEditId = null;
        clearRecurEditForm();
        renderRecurEditFreqChips();
        renderRecurringEditChart();
        const freqSectionEl = document.getElementById('recuredit-freq-section');
        if (freqSectionEl) freqSectionEl.style.display = '';
        return;
    }

    const freqSectionEl = document.getElementById('recuredit-freq-section');
    if (freqSectionEl) freqSectionEl.style.display = row['繰返し親ID'] ? 'none' : '';

    document.getElementById('recuredit-id').value       = row['ID']         ?? '';
    document.getElementById('recuredit-title').value    = row['タイトル']   ?? '';
    document.getElementById('recuredit-content').value  = row['内容']       ?? '';
    document.getElementById('recuredit-biko').value     = row['備考']       ?? '';
    document.getElementById('recuredit-status').value   = row['ステータス'] ?? '';
    document.getElementById('recuredit-priority').value = row['優先度']     ?? '';
    document.getElementById('recuredit-category').value = row['カテゴリ']   ?? '';
    document.getElementById('recuredit-tag').value      = row['タグ']       ?? '';
    document.getElementById('recuredit-project').value      = row['プロジェクト']       ?? '';

    writeTaskDateTimeFieldsToForm('recuredit', row);
    writeTaskEstimateActualToForm('recuredit', row);

    loadFreqStateFromRow(recurEditFreq, row);
    renderRecurEditFreqChips();
    renderRecurringEditChart();
}

/** タスクページの繰り返しタスクセクションを描画する（親タスク一覧＋子タスク一覧＋選択中タスクの編集パネル・グラフ）。 */
function renderRecurringSection() {
    renderRecurringParentTable();
    renderRecurringWeeklyView();
    renderRecurringChildTable();
    renderRecurringEditPanel();
}

document.getElementById('recurring-add-new-btn')?.addEventListener('click', () => {
    selectedRecurringParentId = null;
    selectedRecurringEditId   = null;
    renderRecurringSection();
});

/** 「子を手動生成」ボタン: 選択中の親タスクから今すぐ子タスクを1件生成する。 */
document.getElementById('recurring-edit-manual-btn')?.addEventListener('click', () => {
    if (!selectedRecurringParentId) { alert('親タスクを選択してください'); return; }
    const parent = currentMainData.find(r => String(r['ID']) === selectedRecurringParentId);
    if (!parent) return;

    const child = generateChildManually(parent, currentMainData);
    if (!child) { alert('本日分は既に生成済みです'); return; }
    currentMainData.push(child);
    persistLocalCache();
    renderRecurringSection();
    renderEditTable();
});

/** 編集パネルの内容を選択中のタスク（親または子）へ書き戻す。 */
function applyRecurEditForm() {
    if (!selectedRecurringEditId) return;
    const row = currentMainData.find(r => String(r['ID']) === selectedRecurringEditId);
    if (!row) return;

    const isParentRow = !row['繰返し親ID'];

    row['タイトル']   = document.getElementById('recuredit-title').value.trim();
    row['内容']       = document.getElementById('recuredit-content').value.trim();
    row['備考']       = document.getElementById('recuredit-biko').value.trim();
    row['ステータス'] = document.getElementById('recuredit-status').value;
    row['優先度']     = document.getElementById('recuredit-priority').value;
    row['見積時間']   = document.getElementById('recuredit-estimate').value;
    row['カテゴリ']   = document.getElementById('recuredit-category').value;
    row['タグ']       = document.getElementById('recuredit-tag').value;
    row['プロジェクト']       = document.getElementById('recuredit-project').value;
    if (isParentRow) {
        row['繰返し識別子']   = '1';
        row['繰返し頻度_月']  = [...recurEditFreq.month].join(',');
        row['繰返し頻度_日']  = [...recurEditFreq.day].join(',');
        row['繰返し頻度_曜日'] = [...recurEditFreq.weekday].join(',');
    }

    Object.assign(row, readTaskDateTimeFieldsFromForm('recuredit'));
    row['更新日時'] = formatJpDatetime(new Date());

    persistLocalCache();
    renderRecurringSection();
    renderCalendar();
    renderTaskRunner();
    renderEditTable();
}

/** 「適用」ボタン: 編集パネルの内容を選択中のタスク（親または子）へ書き戻す。 */
document.getElementById('recuredit-apply-btn')?.addEventListener('click', applyRecurEditForm);

/** 「完了にする」ボタン: 開始予定・終了予定・完了日を本日にし、ステータスを完了にして保存する。 */
document.getElementById('recuredit-complete-btn')?.addEventListener('click', () => {
    if (!selectedRecurringEditId) return;
    const today = new Date();
    const pad = n => String(n).padStart(2, '0');
    const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

    document.getElementById('recuredit-start-date').value    = todayStr;
    document.getElementById('recuredit-end-date').value      = todayStr;
    document.getElementById('recuredit-complete-date').value = todayStr;
    document.getElementById('recuredit-status').value        = '完了';

    applyRecurEditForm();
});

/** 「削除」ボタン: 選択中のタスク（親または子）をメインデータから削除する。 */
document.getElementById('recuredit-delete-btn')?.addEventListener('click', () => {
    if (!selectedRecurringEditId) return;
    const isParent = selectedRecurringEditId === selectedRecurringParentId;
    const message = isParent
        ? 'この親タスクを削除します。よろしいですか？（この操作は取り消せません。子タスクは残ります）'
        : 'この子タスクを削除します。よろしいですか？（この操作は取り消せません）';
    if (!confirm(message)) return;

    currentMainData = currentMainData.filter(r => String(r['ID']) !== selectedRecurringEditId);
    if (isParent) selectedRecurringParentId = null;
    selectedRecurringEditId = null;

    persistLocalCache();
    renderRecurringSection();
    renderCalendar();
    renderTaskRunner();
    renderEditTable();
});

/** 「新規登録」ボタン: 編集パネルの現在値で新規の親タスクを追加する。 */
document.getElementById('recuredit-new-btn')?.addEventListener('click', () => {
    const title = document.getElementById('recuredit-title').value.trim();
    if (!title) { alert('タイトルを入力してください'); return; }

    const maxId = currentMainData.reduce((max, row) => {
        const id = parseInt(row['ID'], 10);
        return isNaN(id) ? max : Math.max(max, id);
    }, 0);
    const ts = formatJpDatetime(new Date());

    const entry = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
    entry['ID']        = String(maxId + 1);
    entry['データ区分'] = 'タスク';
    entry['タイトル']   = title;
    entry['内容']       = document.getElementById('recuredit-content').value.trim();
    entry['備考']       = document.getElementById('recuredit-biko').value.trim();
    entry['ステータス'] = document.getElementById('recuredit-status').value;
    entry['優先度']     = document.getElementById('recuredit-priority').value;
    entry['見積時間']   = document.getElementById('recuredit-estimate').value;
    entry['カテゴリ']   = document.getElementById('recuredit-category').value || (currentCategory === 'すべて' ? '' : currentCategory);
    entry['タグ']       = document.getElementById('recuredit-tag').value;
    entry['プロジェクト']       = document.getElementById('recuredit-project').value;
    entry['繰返し識別子']   = '1';
    entry['繰返し親ID']     = '';
    entry['繰返し頻度_月']  = [...recurEditFreq.month].join(',');
    entry['繰返し頻度_日']  = [...recurEditFreq.day].join(',');
    entry['繰返し頻度_曜日'] = [...recurEditFreq.weekday].join(',');
    Object.assign(entry, readTaskDateTimeFieldsFromForm('recuredit'));
    entry['作成日時']   = ts;
    entry['更新日時']   = ts;

    currentMainData.push(entry);
    persistLocalCache();

    selectedRecurringParentId = String(entry['ID']);
    selectedRecurringEditId   = String(entry['ID']);
    renderRecurringSection();
    renderCalendar();
    renderTaskRunner();
    renderEditTable();
});

// ===== 勤務カレンダー =====

const WORK_KUBUN = '勤務カレンダー';
const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

/** 指定年の勤務カレンダーエントリをメインデータから返す。存在しなければ undefined。 */
function findWorkCalendarEntry(year) {
    return currentMainData.find(r =>
        r['データ区分'] === WORK_KUBUN && r['タイトル'] === `${year}休日`
    );
}

/** 指定年の内容テキストを返す（エントリ未作成時は空文字）。 */
function getWorkCalendarContent(year) {
    return findWorkCalendarEntry(year)?.['内容'] ?? '';
}

/** 指定年のエントリの内容テキストを更新し LocalStorage へキャッシュする。エントリが無ければ新規作成する。 */
function saveWorkCalendarContent(year, contentText) {
    const ts    = formatJpDatetime(new Date());
    let   entry = findWorkCalendarEntry(year);
    if (!entry) {
        const maxId = currentMainData.reduce((max, row) => {
            const id = parseInt(row['ID'], 10);
            return isNaN(id) ? max : Math.max(max, id);
        }, 0);
        entry = Object.fromEntries(MAIN_DATA_COLUMNS.map(c => [c, '']));
        entry['ID']        = String(maxId + 1);
        entry['データ区分'] = WORK_KUBUN;
        entry['タイトル']   = `${year}休日`;
        entry['作成日時']   = ts;
        currentMainData.push(entry);
    }
    entry['内容']     = contentText;
    entry['更新日時'] = ts;
    persistLocalCache();
}

/** 勤務カレンダービュー全体を描画する。 */
function renderWorkCalendar() {
    const content = getWorkCalendarContent(workCalendarYear);
    const days    = computeMonthCalendar(content, workCalendarYear, workCalendarMonth);
    const stats   = computeMonthStats(days);

    const yearLabel  = document.getElementById('work-cal-year-label');
    const monthLabel = document.getElementById('work-cal-month-label');
    if (yearLabel)  yearLabel.textContent  = `${workCalendarYear}年`;
    if (monthLabel) monthLabel.textContent = `${workCalendarMonth + 1}月`;

    // カレンダーグリッド（視覚参照用）
    const grid = document.getElementById('work-cal-grid');
    if (grid) {
        grid.innerHTML = '';
        DOW_LABELS.forEach(d => {
            const el = document.createElement('div');
            el.className   = 'work-cal-dow-header';
            el.textContent = d;
            grid.appendChild(el);
        });
        const firstDow = new Date(workCalendarYear, workCalendarMonth, 1).getDay();
        for (let i = 0; i < firstDow; i++) grid.appendChild(document.createElement('div'));
        days.forEach(day => {
            const cell = document.createElement('div');
            cell.className = `work-cal-day work-cal-day--${day.type}`;
            if (day.isException) cell.classList.add('work-cal-day--exception');
            const numEl = document.createElement('span');
            numEl.className   = 'work-cal-day-num';
            numEl.textContent = String(parseInt(day.date.slice(-2), 10));
            cell.appendChild(numEl);
            if (day.note) {
                const noteEl = document.createElement('span');
                noteEl.className   = 'work-cal-day-note';
                noteEl.textContent = day.note;
                cell.appendChild(noteEl);
            }
            grid.appendChild(cell);
        });
    }

    // 月次サマリー
    const statsEl = document.getElementById('work-cal-stats');
    if (statsEl) {
        statsEl.innerHTML = Object.entries(stats)
            .map(([k, v]) =>
                `<span class="work-cal-stat">` +
                `<span class="work-cal-stat-swatch work-cal--${k}"></span>` +
                `${k}: <strong>${v}</strong>日</span>`
            ).join('');
    }

    // 月一括編集フォーム
    renderWorkMonthForm(days);
}

/** 月一括編集テーブルを描画する（1行=1日、種別select＋備考input）。 */
function renderWorkMonthForm(days) {
    const table = document.getElementById('work-cal-month-table');
    if (!table) return;
    table.className = 'data-table work-cal-month-table';

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    ['日付', '種別', '備考'].forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    days.forEach(day => {
        const tr = document.createElement('tr');
        if (day.type !== '出勤日') tr.className = `work-row--${day.type}`;

        // 日付（読み取り専用）
        const dateTd = document.createElement('td');
        dateTd.textContent = `${day.date}（${DOW_LABELS[day.dayOfWeek]}）`;
        dateTd.className   = 'work-cal-date-cell';
        tr.appendChild(dateTd);

        // 種別（select）
        const typeTd = document.createElement('td');
        const sel    = document.createElement('select');
        sel.className    = 'work-cal-type-select';
        sel.dataset.date = day.date;
        const defOpt = document.createElement('option');
        defOpt.value       = '';
        defOpt.textContent = `（デフォルト: ${day.defaultType}）`;
        sel.appendChild(defOpt);
        ['出勤日', '休日', '有給', '特別休暇'].forEach(t => {
            const opt = document.createElement('option');
            opt.value = opt.textContent = t;
            sel.appendChild(opt);
        });
        sel.value = day.isException ? day.type : '';
        typeTd.appendChild(sel);
        tr.appendChild(typeTd);

        // 備考（text input）
        const noteTd = document.createElement('td');
        const inp    = document.createElement('input');
        inp.type        = 'text';
        inp.className   = 'work-cal-note-input';
        inp.dataset.date = day.date;
        inp.value       = day.note;
        inp.placeholder = '（省略可）';
        noteTd.appendChild(inp);
        tr.appendChild(noteTd);

        tbody.appendChild(tr);
    });

    table.replaceChildren(thead, tbody);
}

// ---- 年月ナビゲーション ----

document.getElementById('work-cal-prev-year')?.addEventListener('click', () => {
    workCalendarYear--;
    renderWorkCalendar();
});
document.getElementById('work-cal-next-year')?.addEventListener('click', () => {
    workCalendarYear++;
    renderWorkCalendar();
});
document.getElementById('work-cal-prev-month')?.addEventListener('click', () => {
    workCalendarMonth--;
    if (workCalendarMonth < 0) { workCalendarMonth = 11; workCalendarYear--; }
    renderWorkCalendar();
});
document.getElementById('work-cal-next-month')?.addEventListener('click', () => {
    workCalendarMonth++;
    if (workCalendarMonth > 11) { workCalendarMonth = 0; workCalendarYear++; }
    renderWorkCalendar();
});

// ---- 月一括適用 ----

document.getElementById('work-cal-month-apply-btn')?.addEventListener('click', () => {
    // 全年分の例外を読み込み、今月分だけ差し替える
    const allExceptions = parseExceptions(getWorkCalendarContent(workCalendarYear));
    const mm = String(workCalendarMonth + 1).padStart(2, '0');
    const monthPrefix = `${workCalendarYear}/${mm}/`;
    for (const key of [...allExceptions.keys()]) {
        if (key.startsWith(monthPrefix)) allExceptions.delete(key);
    }

    document.querySelectorAll('#work-cal-month-table tbody tr').forEach(tr => {
        const sel = tr.querySelector('.work-cal-type-select');
        const inp = tr.querySelector('.work-cal-note-input');
        if (!sel) return;
        const date = sel.dataset.date;
        const type = sel.value;
        const note = inp?.value.trim() ?? '';
        if (type) allExceptions.set(date, { type, note });
    });

    saveWorkCalendarContent(workCalendarYear, stringifyExceptions(allExceptions));
    renderWorkCalendar();
    if (taskOrgView === 'calendar') renderCalendarGrid();
});

