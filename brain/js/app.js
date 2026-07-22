import { loadToken, saveToken, loadCache, saveCache } from './modules/storage.js';
import { fetchFile, saveFile } from './modules/github.js';
import { parseMarkdown, stringifyMarkdown, MAIN_DATA_COLUMNS, MASTER_DATA_COLUMNS } from './modules/dataModel.js';
import { mergeMainData } from './modules/merge.js';
import { exportToExcel, importFromExcel } from './modules/excel.js';
import {
    generateChildManually, matchesSchedule,
    buildChildChartData,
    parseChildTemplates, stringifyChildTemplates
} from './modules/recurring.js';
import { parseExceptions, stringifyExceptions, computeMonthCalendar, computeMonthStats, getDefaultType } from './modules/workCalendar.js';
import {
    parseJpDatetime, formatJpDatetime, parseTimestampLog, formatDuration, isLogRunning,
    computeTotalDuration as computeTotalDurationM,
    filterMainDataByCategory, filterTagsByCategory, filterProjectsByCategory, computeActualHours,
    getChildren as getChildrenM, isParentRow as isParentRowM, getParentRow as getParentRowM,
    wouldCreateCycle as wouldCreateCycleM, getAllParentCandidates as getAllParentCandidatesM,
    getRootParentId as getRootParentIdM, isEligibleParentRow as isEligibleParentRowM
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
let selectedRunTaskId    = null;       // タスク実行で選択中のタスクID
let timerIsRunning       = false;      // タイマー動作中フラグ
let timerInterval        = null;       // setInterval ハンドル
const todayForCalendar   = new Date();
let calendarYear         = todayForCalendar.getFullYear(); // カレンダーの表示年
let calendarMonth        = todayForCalendar.getMonth();    // カレンダーの表示月（0-11）
let selectedCalendarDate = jpDateOnly(formatJpDatetime(todayForCalendar)); // カレンダーで選択中の日付（"YYYY/MM/DD"）。初期値は今日
let selectedCalendarTaskId = null;     // 日別予定表で選択中のタスクID（属性編集パネル用）
let calendarFilters = { tag: new Set(), project: new Set(), status: new Set() }; // カレンダーのタグ／プロジェクト／ステータスフィルタ値（複数選択）
// 一度でも選択肢として現れたことがある値（タグ／プロジェクト／ステータス）。
// 初出の選択肢はデフォルトでチェック済みにするために使い、ユーザーが手動で外した選択は再チェックしない。
const calendarFilterKnownOptions = { tag: new Set(), project: new Set(), status: new Set() };
// 旧繰返しページの絞り込みは新タスク整理と同じ独立方式（プロジェクトは親ID方式）に切り替えたため、
// 旧タスク整理のcalendarFiltersとは別に独立管理する。
let recurringFilters = { tag: new Set(), status: new Set(), project: new Set() };
const recurringFilterKnownOptions = { tag: new Set(), status: new Set(), project: new Set() };
let calendarQuickNewMode = false;      // true時: 「新規登録」ボタンから起動した新規登録モード（日付は空欄のまま）
let taskOrgView = 'calendar';          // 「タスク整理」の表示ビュー（'calendar' | 'gantt'）。年月・タグ/プロジェクト/ステータスフィルタ・選択中タスクは両ビューで共有する
let ganttViewUnit = 'day';             // ガントチャートの列の単位（'day' | 'week'）
let summaryView          = 'taskorg';   // Summary ページの表示ビュー（'top' | 'runner' | 'taskorg' | 'recurring' | 'edit2' | 'data' | 'project' | 'work'）
let workCalendarYear  = new Date().getFullYear();
let workCalendarMonth = new Date().getMonth();

// ===== 新方式（親ID）タブ用の状態 =====
let taskorg2Filters = { tag: new Set(), status: new Set(), project: new Set() }; // 新タスク整理の絞り込み（プロジェクトは最上位の親IDで代表）
const taskorg2FilterKnownOptions = { tag: new Set(), status: new Set(), project: new Set() };
let selectedTaskorg2Id = null;      // 新タスク整理で選択中の行ID
let taskorg2CalendarYear  = new Date().getFullYear(); // 新タスク整理のカレンダー表示年（旧タスク整理とは独立）
let taskorg2CalendarMonth = new Date().getMonth();    // 新タスク整理のカレンダー表示月（0始まり、旧タスク整理とは独立）
let selectedTaskorg2Date  = jpDateOnly(formatJpDatetime(new Date())); // 新タスク整理でカレンダーの日クリックにより選択中の日付（YYYY/MM/DD）。開いた時点では常に今日を選択する
let taskorg2GanttViewUnit = 'day';  // 新タスク整理のガントチャートの列の単位（'day' | 'week'、旧タスク整理とは独立）
let taskorg2View = 'calendar';      // 新タスク整理の表示ビュー（'calendar' | 'gantt'、旧タスク整理とは独立）
let selectedEdit2Ids = new Set();   // 新編集で選択中の行ID
let edit2Filters = {};              // 新編集のフィルタ値
let edit2Kubun   = 'INBOX';         // 新編集の対象データ区分
let project2EditPath = [];           // 「プロジェクト編集」の階層プルダウンで選択中のID列（ルート→現在選択中の行の順）
let project2Level0Mode = '';         // 階層1で何も選択されていない時の表示モード（'' = 通常, 'standalone' = 単独タスク一覧を階層2に表示）
let project2SiblingSelectedIds = new Set(); // 「プロジェクト編集」の兄弟移動欄でチェック選択中の行ID
let project2SiblingSelectionForId = null;   // 上記チェック状態がどの選択行に対するものかを覚えておき、選択行が変わったら自動でクリアする
let project2AdminDeletePending = null;      // プロジェクト管理表で「削除」を押して再割り当て/未割り当ての選択待ちになっている行ID

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

const SUMMARY_VIEWS = ['taskorg', 'taskorg2', 'recurring', 'runner', 'top', 'edit2', 'knowledge', 'project2', 'data', 'work'];

/** Summary ページ（INBOX／タスク整理／繰返し／タスク実行／編集／プロジェクト／データの表示切り替え。PW・Load〜Import・カテゴリは常時表示バーで共通）を描画する */
function renderSummary() {
    // 選択中のビューに応じて、セクション本体をこのページへ移動する
    if (summaryView === 'taskorg')   mountSection('taskorg-details',   'taskorg-anchor-summary');
    if (summaryView === 'taskorg2')  mountSection('taskorg2-details',  'taskorg2-anchor-summary');
    if (summaryView === 'recurring') mountSection('recurring-details', 'recurring-anchor-summary');
    if (summaryView === 'edit2')     mountSection('edit2-details',     'edit2-anchor-summary');
    if (summaryView === 'data')      mountSection('data-group',        'data-anchor-summary');
    if (summaryView === 'project2')      mountSection('project2-group',        'project2-anchor-summary');

    renderCategoryFilter(); // 常時表示バーのカテゴリ選択を最新化
    renderWarnings(computeMasterWarnings());
    renderInboxBadge();
    renderTaskRunner();
    if (summaryView === 'taskorg')   renderCalendar();
    if (summaryView === 'taskorg2')  renderCalendar2();
    if (summaryView === 'recurring') renderRecurringSection();
    if (summaryView === 'edit2')     renderEdit2();
    if (summaryView === 'knowledge') renderKnowledgeList();
    if (summaryView === 'data') {
        renderDataTable('table-main',   'summary-main',   getFilteredMainData(),   MAIN_DATA_COLUMNS,   'メインデータ',   { editable: true, idColumn: 'ID' });
        renderDataTable('table-master', 'summary-master', currentMasterData, MASTER_DATA_COLUMNS, 'マスタデータ', { editable: true, onEdit: () => { renderWarnings(computeMasterWarnings()); renderProjectAdmin2(); } });
    }
    if (summaryView === 'project2') renderProjectAdmin2();
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
/** "YYYY/MM/DD" 形式の日付文字列を Date に変換する（末尾の時刻部分は無視）。パース不可ならnull。 */
function parseSlashDateOnly(str) {
    const m = (str || '').match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}
/** Date を "YYYY/MM/DD" 形式にフォーマットする */
function formatSlashDateOnly(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
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

// ===== [削除済み: 旧プロジェクト管理] =====
// 旧プロジェクトタブ（プロジェクト一覧・紐づくタスク一覧／名前変更・削除・統合）は
// 新プロジェクトタブ（親ID方式、renderProjectAdmin2 系）へ置き換え、削除した。


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

    // 初回ロード時のみ、先頭カテゴリをデフォルト選択にする
    if (!categoryInitialized) {
        const categories = [...new Set(currentMasterData.map(r => r['(M)カテゴリ']).filter(Boolean))];
        if (categories.length > 0) currentCategory = categories[0];
        categoryInitialized = true;
    }

    // フィルタUIがまだ描画されていない状態でも絞り込み結果が正しくなるよう、先に初出の選択肢をチェック済みにしておく
    seedCalendarFilterDefaults();

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
            alert('他端末の更新との自動マージに失敗しました。変更は端末内に保存されています。時間をおいて再度「保存」を押してください。');
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
    if (!silent) contentBox.textContent = '保存中...';

    try {
        const { newSha } = await saveFile(token, OWNER, REPO, PATH, newMarkdown, currentSha);
        currentSha = newSha;
        lastSyncedMarkdown = newMarkdown;
        saveCache(newMarkdown, newSha);
        updateSyncBadge(newMarkdown); // 保存直後は lastSyncedMarkdown と一致するため「オンライン（最新）」になる
        if (!silent) {
            contentBox.innerHTML = window.marked.parse(newMarkdown);
            alert('保存が成功しました！');
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
            alert('現在通信ができません。変更はスマホ内に一時保存されました。電波の良い場所に移動してから、再度「保存」を押して同期してください。');
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

/** 「ナレッジ」タブ: データ区分=ナレッジの行を更新日時の新しい順に一覧表示する（一覧表示のみ、行クリックは無反応）。 */
function renderKnowledgeList() {
    const container = document.getElementById('knowledge-list-summary');
    if (!container) return;
    container.innerHTML = '';

    const rows = getFilteredMainData()
        .filter(r => r['データ区分'] === 'ナレッジ')
        .sort((a, b) => (b['更新日時'] || '').localeCompare(a['更新日時'] || ''));

    const wrap  = document.createElement('div');
    wrap.className = 'table-wrapper';
    const table = document.createElement('table');
    table.className = 'data-table';

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    ['タイトル', 'ステータス', 'カテゴリ', 'タグ', '更新日時'].forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    if (rows.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5;
        td.className = 'empty-cell';
        td.textContent = '該当するナレッジがありません';
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        rows.forEach(row => {
            const tr = document.createElement('tr');
            [row['タイトル'] || '（無題）', row['ステータス'] || '', row['カテゴリ'] || '', row['タグ'] || '', row['更新日時'] || '']
                .forEach(val => {
                    const td = document.createElement('td');
                    td.textContent = val;
                    tr.appendChild(td);
                });
            tbody.appendChild(tr);
        });
    }
    table.append(thead, tbody);
    wrap.appendChild(table);
    container.appendChild(wrap);
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

/** 進行中タスクのうち、タイムスタンプログが計測中(末尾が"-")の行を返す */
function findRunningTaskRow(inProgress) {
    return inProgress.find(r => isLogRunning(r['タイムスタンプログ'])) || null;
}

/** タスク一覧テーブルの見出し(h4)を作って親要素へ追加する */
function appendRunnerListHeading(parent, text) {
    const h = document.createElement('h4');
    h.className = 'runner-list-heading';
    h.textContent = text;
    parent.appendChild(h);
}

/**
 * 進行中タスク用の一覧テーブル（タイトル/見積時間/累計時間/▷開始・■停止・完了）を構築して親要素へ追加する。
 * rid === selectedRunTaskId の行は選択状態、runningRow の行の累計時間セルはライブ更新対象にする。
 */
function appendRunnerProgressTable(parent, rows, runningRow) {
    const wrap  = document.createElement('div');
    wrap.className = 'table-wrapper';
    const table = document.createElement('table');
    table.className = 'data-table';

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    ['タイトル', '見積時間（分）', '累計時間', '操作'].forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    if (rows.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 4;
        td.className = 'empty-cell';
        td.textContent = '該当タスクがありません';
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        rows.forEach(row => {
            const rid = String(row['ID']);
            const tr  = document.createElement('tr');
            if (rid === String(selectedRunTaskId)) tr.classList.add('selected-row');

            const titleTd = document.createElement('td');
            titleTd.textContent = row['タイトル'] || '（無題）';
            titleTd.style.cursor = 'pointer';
            titleTd.addEventListener('click', () => {
                selectedRunTaskId = rid;
                renderTaskRunner();
            });
            tr.appendChild(titleTd);

            const estimateTd = document.createElement('td');
            estimateTd.textContent = row['見積時間'] || '';
            tr.appendChild(estimateTd);

            const timeTd = document.createElement('td');
            timeTd.textContent = formatDuration(computeTotalDuration(rid));
            if (runningRow && rid === String(runningRow['ID'])) {
                timeTd.className = 'runner-elapsed-display';
                timeTd.dataset.taskId = rid;
            }
            tr.appendChild(timeTd);

            const actionTd = document.createElement('td');
            actionTd.className = 'recurring-list-action';
            const running = isLogRunning(row['タイムスタンプログ']);

            const startBtn = document.createElement('button');
            startBtn.type = 'button';
            startBtn.className = 'recurring-table-btn';
            startBtn.title = 'タイマー開始';
            startBtn.textContent = '▷';
            startBtn.disabled = running;
            startBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (runningRow && String(runningRow['ID']) !== rid) {
                    const now = formatJpDatetime(new Date());
                    runningRow['タイムスタンプログ'] = (runningRow['タイムスタンプログ'] || '') + `${now}, `;
                }
                const ts = formatJpDatetime(new Date());
                row['タイムスタンプログ'] = (row['タイムスタンプログ'] || '') + `${ts}-`;
                persistLocalCache();
                renderTaskRunner();
            });
            actionTd.appendChild(startBtn);

            const stopBtn = document.createElement('button');
            stopBtn.type = 'button';
            stopBtn.className = 'recurring-table-btn';
            stopBtn.title = 'タイマー停止';
            stopBtn.textContent = '■';
            stopBtn.disabled = !running;
            stopBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const ts = formatJpDatetime(new Date());
                row['タイムスタンプログ'] = (row['タイムスタンプログ'] || '') + `${ts}, `;
                persistLocalCache();
                renderTaskRunner();
            });
            actionTd.appendChild(stopBtn);

            const doneBtn = document.createElement('button');
            doneBtn.type = 'button';
            doneBtn.className = 'recurring-table-btn recurring-table-btn--done';
            doneBtn.title = '完了にする';
            doneBtn.textContent = '完了';
            doneBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (isLogRunning(row['タイムスタンプログ'])) {
                    const ts = formatJpDatetime(new Date());
                    row['タイムスタンプログ'] = (row['タイムスタンプログ'] || '') + `${ts}, `;
                }
                const now = formatJpDatetime(new Date());
                row['ステータス'] = '完了';
                row['完了日']     = row['完了日'] || jpDateOnly(now);
                row['更新日時']   = now;
                if (String(selectedRunTaskId) === rid) selectedRunTaskId = null;
                persistLocalCache();
                renderTaskRunner();
            });
            actionTd.appendChild(doneBtn);

            tr.appendChild(actionTd);
            tbody.appendChild(tr);
        });
    }
    table.append(thead, tbody);
    wrap.appendChild(table);
    parent.appendChild(wrap);
}

/**
 * 進行中以外の「今日の1日タスク」一覧テーブル（タイトル/ステータス/見積時間/進行中にするボタン）を
 * 構築して親要素へ追加する。
 */
function appendRunnerOtherTodayTable(parent, rows) {
    const wrap  = document.createElement('div');
    wrap.className = 'table-wrapper';
    const table = document.createElement('table');
    table.className = 'data-table';

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    ['タイトル', 'ステータス', '見積時間（分）', '操作'].forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    if (rows.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 4;
        td.className = 'empty-cell';
        td.textContent = '該当タスクがありません';
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        rows.forEach(row => {
            const rid = String(row['ID']);
            const tr  = document.createElement('tr');
            if (rid === String(selectedRunTaskId)) tr.classList.add('selected-row');

            const titleTd = document.createElement('td');
            titleTd.textContent = row['タイトル'] || '（無題）';
            titleTd.style.cursor = 'pointer';
            titleTd.addEventListener('click', () => {
                selectedRunTaskId = rid;
                renderTaskRunner();
            });
            tr.appendChild(titleTd);

            [row['ステータス'] || '', row['見積時間'] || ''].forEach(val => {
                const td = document.createElement('td');
                td.textContent = val;
                tr.appendChild(td);
            });

            const actionTd = document.createElement('td');
            actionTd.className = 'recurring-list-action';
            const startBtn = document.createElement('button');
            startBtn.type = 'button';
            startBtn.className = 'recurring-table-btn';
            startBtn.title = '進行中にする';
            startBtn.textContent = '進行中にする';
            startBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                row['ステータス'] = '進行中';
                row['更新日時']   = formatJpDatetime(new Date());
                persistLocalCache();
                renderTaskRunner();
            });
            actionTd.appendChild(startBtn);
            tr.appendChild(actionTd);

            tbody.appendChild(tr);
        });
    }
    table.append(thead, tbody);
    wrap.appendChild(table);
    parent.appendChild(wrap);
}

/** 単一コンテナにタスク実行UIを構築（左＝3表の一覧+操作ボタン、右＝選択タスクの編集エリア） */
function buildTaskRunnerUI(container) {
    container.innerHTML = '';

    const todayJP = jpDateOnly(formatJpDatetime(new Date()));
    // 「今日のタスク」＝タスク整理の「設定済みタスク」と同じ集合（今日の1日タスクの内容欄に#IDで明示的に組み込まれたタスク）。
    // matchesMultiFilter は空Setを「絞り込みなし」ではなく「空欄の値だけ通す」と解釈するため、
    // タグ／プロジェクト／ステータスの絞り込みを経由せず、1日タスクの内容欄を直接パースして対象を求める。
    const todayDayPlan = getDayPlanTaskM(currentMainData, todayJP);
    const todayDayPlanBlocks = todayDayPlan ? parseDayPlanContent(todayDayPlan['内容']) : [];
    const todayReferencedIds = new Set(todayDayPlanBlocks.map(b => b.refId).filter(Boolean));
    const todaysDayPlanTasks = currentMainData.filter(r =>
        r['データ区分'] === 'タスク' && r['プロジェクト'] !== DAYPLAN_PROJECT
        && todayReferencedIds.has(String(r['ID']))
        && (currentCategory === 'すべて' || r['カテゴリ'] === currentCategory)
    );
    const todaysDayPlanIds = new Set(todaysDayPlanTasks.map(r => r['ID']));

    const inProgress = getFilteredMainData().filter(r =>
        r['データ区分'] === 'タスク' && r['ステータス'] === '進行中'
        && !(r['繰返し識別子'] === '1' && !r['繰返し親ID']) // 繰返しタスクの親は対象外
    );
    // 1階層でも2階層でも誰かの親（プロジェクト）になっているタスクは、通常の進行中一覧とは分けて「（親タスク）」表に表示する。
    const inProgressParents    = inProgress.filter(r => isParentRowM(currentMainData, r['ID']));
    const inProgressNonParents = inProgress.filter(r => !isParentRowM(currentMainData, r['ID']));
    const inProgressToday    = inProgressNonParents.filter(r => todaysDayPlanIds.has(r['ID']));
    const inProgressNotToday = inProgressNonParents.filter(r => !todaysDayPlanIds.has(r['ID']));
    const todaysOther        = todaysDayPlanTasks.filter(r => r['ステータス'] !== '進行中');

    const runningRow = findRunningTaskRow(inProgress);
    timerIsRunning = !!runningRow;
    if (timerIsRunning) {
        if (!timerInterval) timerInterval = setInterval(updateRunnerTimerDisplay, 1000);
    } else if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }

    const section = document.createElement('div');
    section.className = 'calendar-day-section';

    // ===== 左カラム: 3表のタスク一覧 + 操作ボタン =====
    const listCol = document.createElement('div');
    listCol.className = 'calendar-timeline-col';

    appendRunnerListHeading(listCol, '進行中（今日）');
    appendRunnerProgressTable(listCol, inProgressToday, runningRow);

    appendRunnerListHeading(listCol, '進行中（今日以外）');
    appendRunnerProgressTable(listCol, inProgressNotToday, runningRow);

    appendRunnerListHeading(listCol, 'その他（今日）');
    appendRunnerOtherTodayTable(listCol, todaysOther);

    appendRunnerListHeading(listCol, '（親タスク）');
    appendRunnerProgressTable(listCol, inProgressParents, runningRow);

    section.appendChild(listCol);

    // ===== 右カラム: 選択タスクの編集エリア（未選択時は先頭タスクを自動選択） =====
    const editCol = document.createElement('div');
    editCol.className = 'calendar-edit-col';

    let selectedRow = selectedRunTaskId
        ? currentMainData.find(r => String(r['ID']) === String(selectedRunTaskId))
        : null;
    if (!selectedRow) {
        selectedRow = inProgressToday[0] || inProgressNotToday[0] || todaysOther[0] || inProgressParents[0] || null;
        if (selectedRow) selectedRunTaskId = String(selectedRow['ID']);
    }

    if (!selectedRow) {
        const hint = document.createElement('p');
        hint.className = 'placeholder-text';
        hint.style.margin = '8px 0 0';
        hint.textContent = '対象タスクがありません';
        editCol.appendChild(hint);
        section.appendChild(editCol);
        container.appendChild(section);
        return;
    }

    const selectedRid = String(selectedRow['ID']);
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
    elapsedSpan.dataset.taskId = selectedRid;
    elapsedSpan.textContent = formatDuration(computeTotalDuration(selectedRid));

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

    if (runningRow && String(runningRow['ID']) === selectedRid) {
        const statusLabel = document.createElement('p');
        statusLabel.className = 'triage-info runner-status-label';
        statusLabel.textContent = '⏱ 計測中...';
        panel.appendChild(statusLabel);
    }

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

    // ステータス遷移（開始/停止/完了は左カラムのボタンで操作するため、それ以外への変更用）
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
            lbl.append(radio, document.createTextNode(' ' + st));
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
            if (newStatus !== '進行中' && isLogRunning(selectedRow['タイムスタンプログ'])) {
                const ts = formatJpDatetime(new Date());
                selectedRow['タイムスタンプログ'] = (selectedRow['タイムスタンプログ'] || '') + `${ts}, `;
            }
            selectedRow['ステータス'] = newStatus;
            selectedRow['更新日時']   = formatJpDatetime(new Date());
            if (String(selectedRunTaskId) === String(selectedRow['ID'])) {
                selectedRunTaskId = null;
            }
            persistLocalCache();
            renderTaskRunner();
        });
        changeTb.appendChild(changeBtn);
        statusSec.appendChild(changeTb);
        panel.appendChild(statusSec);
    }

    editCol.appendChild(panel);
    section.appendChild(editCol);
    container.appendChild(section);
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

/** タスクのステータスマスタ値一覧を返す（(M)ステータス_親が「タスク」の行の(M)ステータス_子）。 */
function getFilteredTaskStatuses() {
    return [...new Set(
        currentMasterData.filter(r => r['(M)ステータス_親'] === 'タスク')
            .map(r => r['(M)ステータス_子']).filter(Boolean)
    )];
}

/** 初めて現れた選択肢をデフォルトでチェック済みにする（既知の選択肢はユーザーの選択状態を尊重して触らない）。 */
function seedFilterOptionSet(options, selectedSet, knownSet) {
    options.forEach(v => {
        if (knownSet.has(v)) return;
        knownSet.add(v);
        selectedSet.add(v);
    });
}

// ===== 親ID方式プロジェクト絞り込みの共通ヘルパー（新タスク整理・旧繰返しで共有） =====

/** set・value の単純一致判定（valueが空なら常に一致扱い）。タグ／ステータスの絞り込みに使う。 */
function matchesFilterValue(set, value) {
    return !value || set.has(value);
}

/** rows が属する、実際にプロジェクト（子を持つ最上位の親行）である最上位の親行一覧を返す。 */
function getProjectRootRows(rows) {
    const rootIds = new Set();
    rows.forEach(r => {
        const rootId = getRootParentIdM(currentMainData, r['ID']);
        if (isParentRowM(currentMainData, rootId)) rootIds.add(rootId);
    });
    return [...rootIds].map(id => currentMainData.find(r => String(r['ID']) === id)).filter(Boolean);
}

/** rows のうち、最上位の親IDが rootId と一致する件数を返す（activeOnly指定時は完了・中断を除く）。 */
function countRowsByProjectRoot(rows, rootId, activeOnly = false) {
    return rows.filter(r => {
        if (getRootParentIdM(currentMainData, r['ID']) !== rootId) return false;
        if (activeOnly && (r['ステータス'] === '完了' || r['ステータス'] === '中断')) return false;
        return true;
    }).length;
}

/** row がプロジェクト（親ID方式）の絞り込みを満たすか判定する。プロジェクトに属さない単独行は常に素通しする。 */
function matchesProjectRootFilter(row, filterSet) {
    const rootId = getRootParentIdM(currentMainData, row['ID']);
    if (!isParentRowM(currentMainData, rootId)) return true;
    return filterSet.has(rootId);
}

/**
 * タグ／プロジェクト（親ID方式）／ステータスの絞り込みチップ（いずれも複数選択可、件数併記・N降順）を area に描画する。
 * 新タスク整理・旧繰返しの両方から共通利用する。
 * @param {HTMLElement} area
 * @param {{tag:Set, status:Set, project:Set}} filters      - 選択状態を持つフィルタ値（複数選択）
 * @param {{tag:Set, status:Set, project:Set}} knownOptions - 初出の選択肢を記録するSet（デフォルト全選択の判定用）
 * @param {Array} projectRootRows                - プロジェクト選択肢として使う最上位の親行一覧（呼び出し側の母集団で算出済みのもの）
 * @param {(rootId:string, activeOnly?:boolean) => number} countProjectRows - プロジェクトごとの件数を返す関数
 * @param {Function} onChange - 選択変更時に呼ぶ再描画コールバック
 */
function renderParentProjectFilters(area, filters, knownOptions, projectRootRows, countProjectRows, onChange) {
    if (!area) return;
    area.innerHTML = '';

    function makeRow(labelText, options, selectedSet, buildLabel) {
        const row = document.createElement('div');
        row.className = 'triage-filter-row';
        const lbl = document.createElement('span');
        lbl.className = 'triage-filter-label';
        lbl.textContent = labelText;

        const selectAllBtn = document.createElement('button');
        selectAllBtn.type = 'button';
        selectAllBtn.className = 'calendar-filter-bulk-btn';
        selectAllBtn.textContent = '全選択';
        selectAllBtn.addEventListener('click', () => { options.forEach(v => selectedSet.add(v)); onChange(); });

        const deselectAllBtn = document.createElement('button');
        deselectAllBtn.type = 'button';
        deselectAllBtn.className = 'calendar-filter-bulk-btn';
        deselectAllBtn.textContent = '全解除';
        deselectAllBtn.addEventListener('click', () => { selectedSet.clear(); onChange(); });

        const ctrl = createCalendarMultiFilter(options, selectedSet, buildLabel || (v => v), onChange);
        row.append(lbl, selectAllBtn, deselectAllBtn, ctrl);
        area.appendChild(row);
    }

    const tagOptions = sortByTotalCountDesc(getFilteredTags(), 'タグ');
    seedFilterOptionSet(tagOptions, filters.tag, knownOptions.tag);
    makeRow('タグ', tagOptions, filters.tag, v => `${v} (${countActiveTasksByField('タグ', v)}/${countTasksByField('タグ', v)})`);

    // プロジェクト＝最上位の親IDのタイトルをボタンとして表示（中間階層の親IDは束ねてカウントする）
    const projectRowsSorted = [...projectRootRows]
        .sort((a, b) => countProjectRows(String(b['ID']), false) - countProjectRows(String(a['ID']), false));
    const projectIds = projectRowsSorted.map(r => String(r['ID']));
    seedFilterOptionSet(projectIds, filters.project, knownOptions.project);
    makeRow('プロジェクト', projectIds, filters.project, id => {
        const row = projectRowsSorted.find(r => String(r['ID']) === id);
        return `${row ? (row['タイトル'] || `#${id}`) : `#${id}`} (${countProjectRows(id, true)}/${countProjectRows(id, false)})`;
    });

    const statusOptions = sortByTotalCountDesc(getFilteredTaskStatuses(), 'ステータス');
    seedFilterOptionSet(statusOptions, filters.status, knownOptions.status);
    makeRow('ステータス', statusOptions, filters.status, v => `${v} (${countActiveTasksByField('ステータス', v)}/${countTasksByField('ステータス', v)})`);
}

/**
 * タグ／プロジェクト／ステータスの初出の選択肢を、フィルタのデフォルト選択（チェック済み）として登録する。
 * データ読込直後に呼ぶことで、フィルタUIが一度も描画されていない状態でも絞り込み結果が正しくなる
 * （renderTaskRunner等、フィルタUIより先に絞り込み結果を参照する描画処理があるため）。
 */
function seedCalendarFilterDefaults() {
    seedFilterOptionSet(getFilteredTags(),         calendarFilters.tag,     calendarFilterKnownOptions.tag);
    seedFilterOptionSet(getFilteredProjects(),      calendarFilters.project, calendarFilterKnownOptions.project);
    seedFilterOptionSet(getFilteredTaskStatuses(),  calendarFilters.status,  calendarFilterKnownOptions.status);
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
    seedFilterOptionSet(tagOptions, filters.tag, calendarFilterKnownOptions.tag);
    makeRow('タグ', tagOptions, filters.tag, createCalendarMultiFilter(
        tagOptions, filters.tag,
        v => `${v} (${countActiveTasksByField('タグ', v)}/${countTasksByField('タグ', v)})`,
        onChange
    ));

    const projectOptions = sortByTotalCountDesc(getFilteredProjects(), 'プロジェクト');
    seedFilterOptionSet(projectOptions, filters.project, calendarFilterKnownOptions.project);
    makeRow('プロジェクト', projectOptions, filters.project, createCalendarMultiFilter(
        projectOptions, filters.project,
        v => `${v} (${countActiveTasksByField('プロジェクト', v)}/${countTasksByField('プロジェクト', v)})`,
        onChange
    ));

    const statusOptions = sortByTotalCountDesc(getFilteredTaskStatuses(), 'ステータス');
    seedFilterOptionSet(statusOptions, filters.status, calendarFilterKnownOptions.status);
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

/** 旧繰返しページ上部のタグ／プロジェクト（親ID方式）／ステータスフィルタを描画する（新タスク整理と同一仕様）。 */
function renderRecurringFilters() {
    renderParentProjectFilters(
        document.getElementById('recurring-filter-area'),
        recurringFilters, recurringFilterKnownOptions,
        getRecurringProjectRootRows(), countRecurringProjectParents,
        () => renderRecurringSection()
    );
}

const RECURRING_WEEKBOARD_DAY_LABELS = ['月', '火', '水', '木', '金', '土', '日']; // 週間ボードの列順（月始まり）

/** 「開始予定」欄の時刻部分（HH:mm）を分単位に変換する。時刻未入力ならnull。 */
function extractRecurringStartMinutes(row) {
    // 日付付き（"2026/07/14 09:00"）・時刻のみ（"09:00"）のどちらでも拾えるよう、文字列中のHH:mmを直接探す
    const m = (row['開始予定'] || '').match(/(\d{1,2}):(\d{2})/);
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

/**
 * 週間ボードの1行分（親タスクまたは生成済み子タスク）を組み立てる。クリックで選択し、下の編集エリアに読み込む。
 * ステータス別の配色で実行状況が分かるようにする（親タスクは常に灰色）。
 */
function buildRecurringWeekBoardRow(item, isParent) {
    const id = String(item['ID']);
    const tr = document.createElement('tr');
    tr.className = 'recurring-weekboard-row';

    const selectedId = isParent ? selectedRecurringParentId : selectedRecurringEditId;
    if (id === selectedId) tr.classList.add('recurring-weekboard-row--selected');

    const td = document.createElement('td');
    td.className = isParent ? 'calendar-time-block--todo' : getCalendarStatusClass(item['ステータス']);
    td.textContent = item['タイトル'] || '（無題）';
    tr.appendChild(td);

    tr.addEventListener('click', () => {
        selectedRecurringParentId = isParent ? id : item['繰返し親ID'];
        selectedRecurringEditId   = id;
        renderRecurringSection();
    });

    return tr;
}

/** 週間ボードの1週間分（7列）を container に描画する。weekStart はその週の月曜日。各日は1タスク1行の表形式。 */
function buildRecurringWeekBoardWeek(container, weekStart) {
    if (!container) return;
    container.innerHTML = '';

    const parents = getFilteredRecurringParents();
    const todayJP = jpDateOnly(formatJpDatetime(new Date()));
    const pad = n => String(n).padStart(2, '0');

    RECURRING_WEEKBOARD_DAY_LABELS.forEach((label, idx) => {
        const date   = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + idx);
        const dateJP = `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;

        const col = document.createElement('div');
        col.className = 'recurring-weekboard-day' + (dateJP === todayJP ? ' recurring-weekboard-day--today' : '');

        const header = document.createElement('div');
        header.className = 'recurring-weekboard-day-header';
        header.textContent = `${label} ${date.getMonth() + 1}/${date.getDate()}`;
        col.appendChild(header);

        // 開始予定に時刻が入力されている親タスクは早い順に並べる（時刻未入力は後ろ）
        const matchingParents = sortRecurringParentsByStart(parents.filter(p => matchesSchedule(p, date)));

        if (matchingParents.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'calendar-empty-text';
            empty.textContent = '-';
            col.appendChild(empty);
        } else {
            const table = document.createElement('table');
            table.className = 'recurring-weekboard-table';
            const tbody = document.createElement('tbody');

            matchingParents.forEach(parent => {
                const parentId = String(parent['ID']);
                // この日（基準日）を起点に既に生成済みの子タスクがあれば、親の代わりにそれらを表示する
                const generatedChildren = currentMainData.filter(r =>
                    r['繰返し親ID'] === parentId && r['繰返し基準日'] === dateJP
                );

                if (generatedChildren.length > 0) {
                    generatedChildren.forEach(child => tbody.appendChild(buildRecurringWeekBoardRow(child, false)));
                } else {
                    tbody.appendChild(buildRecurringWeekBoardRow(parent, true));
                }
            });

            table.appendChild(tbody);
            col.appendChild(table);
        }

        container.appendChild(col);
    });
}

let recurringWeekBoardOffset = 0; // 表示中の週（今週からの相対週数。‹›で前後の週へ移動、「今週」ボタンで0に戻す）

/**
 * 週間ボードを描画する。recurringWeekBoardOffset 週分ずらした週を表示する（0=今週、-1=先週、+1=来週…）。
 * ‹›ボタンで前後の週（過去の履歴を含む）を自由に閲覧できる。
 */
function renderRecurringWeekBoard() {
    const today = new Date();
    const mondayOffset = (today.getDay() + 6) % 7; // 日曜=0を6扱いにして月曜起点に変換
    const thisMonday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - mondayOffset);
    const targetMonday = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() + recurringWeekBoardOffset * 7);
    const targetSunday = new Date(targetMonday.getFullYear(), targetMonday.getMonth(), targetMonday.getDate() + 6);

    const label = document.getElementById('recurring-weekboard-week-label');
    if (label) {
        const fmt = d => `${d.getMonth() + 1}/${d.getDate()}`;
        label.textContent = recurringWeekBoardOffset === 0
            ? `今週（${fmt(targetMonday)}〜${fmt(targetSunday)}）`
            : `${fmt(targetMonday)}〜${fmt(targetSunday)}`;
    }

    buildRecurringWeekBoardWeek(document.getElementById('recurring-weekboard-current'), targetMonday);
}

document.getElementById('recurring-weekboard-prev-btn')?.addEventListener('click', () => {
    recurringWeekBoardOffset--;
    renderRecurringWeekBoard();
});
document.getElementById('recurring-weekboard-next-btn')?.addEventListener('click', () => {
    recurringWeekBoardOffset++;
    renderRecurringWeekBoard();
});
document.getElementById('recurring-weekboard-today-btn')?.addEventListener('click', () => {
    recurringWeekBoardOffset = 0;
    renderRecurringWeekBoard();
});

// ===== タスク一覧（実行／編集を切替） =====
// 実行: 当日の頻度に一致する親タスク・生成済み子タスクを開始予定の昇順でボタン表示し、＋での子タスク生成やタイマー・ステータス遷移を行う。
// 編集: フィルタ適用済みの全親タスクを開始予定の昇順でボタン表示するのみ（＋・タイマーは無し）。選択すると下に子タスク一覧が表示され、
//       親タスクの新規追加・編集パネルで編集できる。

let recurringExecView = 'exec'; // タスク一覧の表示切り替え（'exec' | 'edit'）

document.querySelectorAll('#recurring-exec-tab-today, #recurring-exec-tab-all').forEach(btn => {
    btn.addEventListener('click', () => {
        recurringExecView = btn.dataset.view;
        document.querySelectorAll('#recurring-exec-tab-today, #recurring-exec-tab-all').forEach(b =>
            b.classList.toggle('taskorg-view-btn--active', b === btn)
        );
        renderRecurringExecArea();
    });
});

/** タスク一覧テーブルに「該当なし」の1行を追加する。 */
function appendRecurringListEmptyRow(tbody, text) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.className = 'empty-cell';
    td.textContent = text;
    tr.appendChild(td);
    tbody.appendChild(tr);
}

/**
 * タスク一覧・子タスク一覧共通のタイトルセルを組み立てる（ステータス配色・選択中ハイライト・クリックで選択）。
 * onSelect は行クリック時に呼ぶコールバック。
 */
function buildRecurringListTitleCell(item, statusClass, isSelected, onSelect) {
    const td = document.createElement('td');
    td.className = `recurring-list-title ${statusClass}`;
    td.textContent = item['タイトル'] || '（無題）';
    td.addEventListener('click', onSelect);

    const tr = document.createElement('tr');
    if (isSelected) tr.classList.add('recurring-list-row--selected');
    tr.appendChild(td);
    return tr;
}

/**
 * タスク一覧（親タスク）の行を組み立てる。withAddButton が true（実行タブ）の場合は2列目に＋ボタンを配置し、
 * 押すと今日を基準日として子タスクを「進行中」で生成する。false（編集タブ）の場合はタイトルのみの1列。
 */
function buildRecurringParentRow(parent, withAddButton) {
    const parentId = String(parent['ID']);
    const tr = buildRecurringListTitleCell(parent, 'calendar-time-block--todo', parentId === selectedRecurringParentId, () => {
        selectedRecurringParentId = parentId;
        selectedRecurringEditId   = parentId;
        renderRecurringSection();
    });

    if (withAddButton) {
        const actionTd = document.createElement('td');
        actionTd.className = 'recurring-list-action';
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'recurring-table-btn recurring-table-btn--add';
        addBtn.title = '今日を基準に子タスクを「進行中」で生成';
        addBtn.textContent = '+';
        addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const children = generateChildManually(parent, currentMainData, new Date());
            if (children.length === 0) { alert('今日の分は既に生成済みです'); return; }
            const ts = formatJpDatetime(new Date());
            children.forEach(child => { child['ステータス'] = '進行中'; child['更新日時'] = ts; });
            currentMainData.push(...children);
            persistLocalCache();
            renderRecurringSection();
            renderTaskRunner();
        });
        actionTd.appendChild(addBtn);
        tr.appendChild(actionTd);
    }

    return tr;
}

/**
 * タスク一覧（実行タブ）の生成済み子タスクの行を組み立てる。2列目に▷/□（タイマー開始・停止）と「完了」ボタンを配置する。
 * 完了後は▷/□を非表示にし、「完了」ボタンを緑色にする。ステータス配色（灰→青→緑）はタイトルセルの背景で表現する。
 */
function buildRecurringChildExecRow(child) {
    const childId = String(child['ID']);
    const isDone  = child['ステータス'] === '完了';
    const running = isLogRunning(child['タイムスタンプログ']);

    const tr = buildRecurringListTitleCell(child, getCalendarStatusClass(child['ステータス']), childId === selectedRecurringEditId, () => {
        selectedRecurringParentId = child['繰返し親ID'];
        selectedRecurringEditId   = childId;
        renderRecurringSection();
    });

    const actionTd = document.createElement('td');
    actionTd.className = 'recurring-list-action';

    if (!isDone) {
        const startBtn = document.createElement('button');
        startBtn.type = 'button';
        startBtn.className = 'recurring-table-btn';
        startBtn.title = 'タイマー開始';
        startBtn.textContent = '▷';
        startBtn.disabled = running;
        startBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const ts = formatJpDatetime(new Date());
            child['タイムスタンプログ'] = (child['タイムスタンプログ'] || '') + `${ts}-`;
            persistLocalCache();
            renderRecurringSection();
            renderTaskRunner();
        });
        actionTd.appendChild(startBtn);

        const stopBtn = document.createElement('button');
        stopBtn.type = 'button';
        stopBtn.className = 'recurring-table-btn';
        stopBtn.title = 'タイマー停止';
        stopBtn.textContent = '□';
        stopBtn.disabled = !running;
        stopBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const ts = formatJpDatetime(new Date());
            child['タイムスタンプログ'] = (child['タイムスタンプログ'] || '') + `${ts}, `;
            persistLocalCache();
            renderRecurringSection();
            renderTaskRunner();
        });
        actionTd.appendChild(stopBtn);
    }

    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'recurring-table-btn' + (isDone ? ' recurring-table-btn--done' : '');
    doneBtn.title = '完了にする';
    doneBtn.textContent = '完了';
    doneBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isLogRunning(child['タイムスタンプログ'])) {
            const ts = formatJpDatetime(new Date());
            child['タイムスタンプログ'] = (child['タイムスタンプログ'] || '') + `${ts}, `;
        }
        const now = formatJpDatetime(new Date());
        child['ステータス'] = '完了';
        child['完了日']     = child['完了日'] || jpDateOnly(now);
        child['更新日時']   = now;
        persistLocalCache();
        renderRecurringSection();
        renderTaskRunner();
        renderCalendar();
    });
    actionTd.appendChild(doneBtn);

    tr.appendChild(actionTd);
    return tr;
}

/** 親タスク配列を開始予定の昇順（時刻未入力は後ろ）に並べ替えた配列を返す。 */
function sortRecurringParentsByStart(parents) {
    return [...parents].sort((a, b) => {
        const ta = extractRecurringStartMinutes(a);
        const tb = extractRecurringStartMinutes(b);
        if (ta === null && tb === null) return 0;
        if (ta === null) return 1;
        if (tb === null) return -1;
        return ta - tb;
    });
}

/**
 * タスク一覧を描画する（タイトルのみの表）。
 * 実行タブ: 2列表示。今日の頻度に一致する親タスクを開始予定の昇順で表示し、未生成なら＋ボタンで子タスクを生成、
 * 既に今日分が生成済みならその子タスクをタイマー・完了操作つきで表示する。
 * 編集タブ: 1列表示。フィルタ適用済みの全親タスクを開始予定の昇順で表示するのみ（＋・タイマーは無し）。
 */
function renderRecurringExecArea() {
    const table = document.getElementById('recurring-exec-area');
    if (!table) return;

    const isExec = recurringExecView !== 'edit';
    table.className = 'recurring-list-table' + (isExec ? ' recurring-list-table--2col' : '');

    const tbody = document.createElement('tbody');

    if (!isExec) {
        const parents = sortRecurringParentsByStart(getFilteredRecurringParents());
        if (parents.length === 0) {
            appendRecurringListEmptyRow(tbody, '登録済みの繰り返しタスクがありません');
        } else {
            parents.forEach(parent => tbody.appendChild(buildRecurringParentRow(parent, false)));
        }
        table.replaceChildren(tbody);
        return;
    }

    const today   = new Date();
    const todayJP = jpDateOnly(formatJpDatetime(today));

    const parents = sortRecurringParentsByStart(
        getFilteredRecurringParents().filter(p => matchesSchedule(p, today))
    );

    if (parents.length === 0) {
        appendRecurringListEmptyRow(tbody, '該当する繰り返しタスクがありません');
        table.replaceChildren(tbody);
        return;
    }

    parents.forEach(parent => {
        const parentId = String(parent['ID']);
        const generatedChildren = currentMainData.filter(r =>
            r['繰返し親ID'] === parentId && r['繰返し基準日'] === todayJP
        );

        if (generatedChildren.length > 0) {
            generatedChildren.forEach(child => tbody.appendChild(buildRecurringChildExecRow(child)));
        } else {
            tbody.appendChild(buildRecurringParentRow(parent, true));
        }
    });

    table.replaceChildren(tbody);
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

/** 「新規登録」ボタンをクリックした際、日付を空欄にした新規登録モードで編集パネルを開く。 */
function startCalendarQuickNewTask() {
    selectedCalendarTaskId = null;
    calendarQuickNewMode   = true;
    renderCalendarDetail();
}
document.getElementById('calendar-quick-new-btn')?.addEventListener('click', startCalendarQuickNewTask);

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
    writeTaskEstimateActualToForm('dayedit', row, 'minutes');

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

/** "YYYY/MM/DD[ HH:mm]" または日付なしの "HH:mm" のみの文字列を { date, time } に分解する。 */
function splitDateAndTime(str) {
    const value = str || '';
    const withDate = value.match(/^(\d{4}\/\d{1,2}\/\d{1,2})(?:\s+(\d{1,2}:\d{2}))?$/);
    if (withDate) return { date: withDate[1], time: withDate[2] || '' };
    const timeOnly = value.match(/^(\d{1,2}:\d{2})$/);
    if (timeOnly) return { date: '', time: timeOnly[1] };
    return { date: '', time: '' };
}

/** row の開始予定・終了予定・完了日を、prefix-start-date/hour/minute 等のフォーム欄に分解して反映する。 */
function writeTaskDateTimeFieldsToForm(prefix, row) {
    const start = splitDateAndTime(row['開始予定']);
    const end   = splitDateAndTime(row['終了予定']);
    const [startHour, startMinute] = (start.time || '').split(':');
    const [endHour,   endMinute]   = (end.time   || '').split(':');
    document.getElementById(`${prefix}-start-date`).value   = start.date ? start.date.replace(/\//g, '-') : '';
    document.getElementById(`${prefix}-start-hour`).value   = startHour   || '';
    document.getElementById(`${prefix}-start-minute`).value = startMinute || '';
    document.getElementById(`${prefix}-end-date`).value     = end.date ? end.date.replace(/\//g, '-') : '';
    document.getElementById(`${prefix}-end-hour`).value     = endHour     || '';
    document.getElementById(`${prefix}-end-minute`).value   = endMinute   || '';
    document.getElementById(`${prefix}-complete-date`).value = (row['完了日'] || '').replace(/\//g, '-');
}

/** 日付・時刻を組み合わせて保存用文字列にする。日付が無くても時刻だけは失わずに残す（繰返し親タスクなど日付を持たない行向け）。 */
function combineDateAndTime(dateVal, timeVal) {
    const datePart = dateVal ? dateVal.replace(/-/g, '/') : '';
    if (datePart && timeVal) return `${datePart} ${timeVal}`;
    return datePart || timeVal;
}

/** prefix-start-date/hour/minute 等のフォーム欄から開始予定・終了予定・完了日を読み取り、保存用文字列にまとめて返す。 */
function readTaskDateTimeFieldsFromForm(prefix) {
    const startDate = document.getElementById(`${prefix}-start-date`).value;
    const startTime = readCalendarTime(`${prefix}-start-hour`, `${prefix}-start-minute`);
    const endDate    = document.getElementById(`${prefix}-end-date`).value;
    const endTime    = readCalendarTime(`${prefix}-end-hour`, `${prefix}-end-minute`);
    return {
        開始予定: combineDateAndTime(startDate, startTime),
        終了予定: combineDateAndTime(endDate, endTime),
        完了日:   document.getElementById(`${prefix}-complete-date`).value.replace(/-/g, '/'),
    };
}

/**
 * 実績時間を分単位で返す。「実績時間」列に手入力値（h）があればそれを分に換算し、
 * 無ければタイムスタンプログ＋補正時間（タスク実行タブで入力する分単位の調整値）から直接分単位で算出する
 * （computeActualHoursの0.1h＝6分刻みの丸めを経由すると短時間の実績が0分に潰れてしまうため、分表示専用に独立して計算する）。
 */
function computeActualMinutes(row) {
    const manual = parseFloat(row['実績時間'] || '');
    if (!isNaN(manual) && manual > 0) return Math.round(manual * 60);
    const ms = parseTimestampLog(row['タイムスタンプログ'] || '') + parseFloat(row['補正時間'] || '0') * 60000;
    return ms > 0 ? Math.round(ms / 60000) : 0;
}

/**
 * row の見積時間・実績時間（実績は編集不可）をフォームへ反映する。
 * unit が 'minutes' の場合、実績時間は分単位で表示する（タスク整理・繰り返し編集用）。省略時は時間単位（プロジェクト編集用）。
 */
function writeTaskEstimateActualToForm(prefix, row, unit = 'hours') {
    const estimateEl = document.getElementById(`${prefix}-estimate`);
    if (estimateEl) estimateEl.value = row['見積時間'] ?? '';
    const actualEl = document.getElementById(`${prefix}-actual`);
    if (actualEl) actualEl.value = String(unit === 'minutes' ? computeActualMinutes(row) : computeActualHours(row));
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
let recurringChartVisible = false; // 実績グラフは既定非表示。「グラフ」ボタンで表示切り替え
let selectedRecurringParentId = null; // 親タスク一覧・子タスク一覧の表示対象として選択中の親タスクID
let selectedRecurringEditId   = null; // 編集パネルに読み込み中のタスクID（親または子。nullなら新規登録モード）
const recurEditFreq = { month: new Set(), day: new Set(), weekday: new Set() }; // 親タスク編集パネルの頻度チップの選択状態
let recurEditTemplates = []; // 親タスク編集パネルの子タスクテンプレート編集状態（Array<{offsetDays, titleSuffix, content}>）

/** 繰返しページの母集団（カテゴリ絞り込み後の繰返し親タスク）を返す。 */
function getRecurringParentPool() {
    return getFilteredMainData().filter(r => r['繰返し識別子'] === '1' && !r['繰返し親ID']);
}

// プロジェクト絞り込みの選択肢・件数は、母集団を「繰返し親タスクのみ」に絞らず新タスク整理と全く同じ
// （カテゴリ内の全タスク行）を対象にする。母集団を独自に絞ると、同じプロジェクトでも新タスク整理と
// 選択肢・件数が食い違ってしまうため、新タスク整理側の関数をそのまま流用する。
function getRecurringProjectRootRows() {
    return getTaskorg2ProjectRootRows();
}
function countRecurringProjectParents(rootId, activeOnly) {
    return countTaskorg2ProjectTasks(rootId, activeOnly);
}

/** カテゴリ・タグ／プロジェクト（親ID方式）／ステータスのフィルタを適用した「親タスク」一覧を返す（繰返しページの母集団）。 */
function getFilteredRecurringParents() {
    return getRecurringParentPool().filter(r =>
        matchesFilterValue(recurringFilters.tag, r['タグ']) &&
        matchesProjectRootFilter(r, recurringFilters.project) &&
        matchesFilterValue(recurringFilters.status, r['ステータス'])
    );
}

/** 選択中の親タスクに属する子タスク一覧を描画する（左右2列の分割は常時表示、未選択時は案内文を表示）。行クリックで編集パネルにその子タスクを読み込む。 */
function renderRecurringChildTable() {
    const table = document.getElementById('recurring-child-table');
    if (!table) return;

    if (!selectedRecurringParentId) {
        table.className = 'recurring-list-table';
        const tbody = document.createElement('tbody');
        appendRecurringListEmptyRow(tbody, '親タスクを選択してください');
        table.replaceChildren(tbody);
        return;
    }

    // 新しいものが上に来るよう、IDの降順（生成順の逆）で並べる
    const children = getFilteredMainData()
        .filter(r => r['繰返し親ID'] === selectedRecurringParentId)
        .sort((a, b) => parseInt(b['ID'], 10) - parseInt(a['ID'], 10));

    table.className = 'recurring-list-table';
    const tbody = document.createElement('tbody');

    if (children.length === 0) {
        appendRecurringListEmptyRow(tbody, '子タスクがありません');
    } else {
        children.forEach(row => {
            const rowId = String(row['ID']);
            tbody.appendChild(buildRecurringListTitleCell(row, getCalendarStatusClass(row['ステータス']), rowId === selectedRecurringEditId, () => {
                selectedRecurringEditId = rowId;
                renderRecurringSection();
            }));
        });
    }
    table.replaceChildren(tbody);
}

/** 選択中の親タスクの実績グラフを描画する（未選択・子タスク無しなら案内文を表示）。「グラフ」ボタンで表示中のときのみ描画する。 */
function renderRecurringEditChart() {
    const wrap = document.getElementById('recurring-edit-chart-wrap');
    if (!wrap) return;

    if (recurringEditChart) { recurringEditChart.destroy(); recurringEditChart = null; }
    wrap.innerHTML = '';
    wrap.style.display = recurringChartVisible ? '' : 'none';
    if (!recurringChartVisible) return;

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

document.getElementById('recurring-chart-toggle-btn')?.addEventListener('click', () => {
    recurringChartVisible = !recurringChartVisible;
    renderRecurringEditChart();
});

/** 親タスク編集パネルの頻度（月/日/曜日）チップを描画する。 */
function renderRecurEditFreqChips() {
    renderFreqChipsFor('recuredit', recurEditFreq);
}

/** 親タスク編集パネルの子タスクテンプレート一覧を描画する（recurEditTemplatesを直接編集するDOM行を生成）。 */
function renderRecurEditTemplates() {
    const list = document.getElementById('recuredit-template-list');
    if (!list) return;

    const rows = recurEditTemplates.map((template, index) => {
        const row = document.createElement('div');
        row.className = 'recur-template-row';

        const offsetInput = document.createElement('input');
        offsetInput.type  = 'number';
        offsetInput.step  = '1';
        offsetInput.title = 'オフセット日数（基準日からの相対日数）';
        offsetInput.className = 'recur-template-offset';
        offsetInput.value = template.offsetDays;
        offsetInput.addEventListener('input', () => {
            template.offsetDays = parseInt(offsetInput.value, 10) || 0;
        });

        const suffixInput = document.createElement('input');
        suffixInput.type = 'text';
        suffixInput.className = 'recur-template-suffix';
        suffixInput.placeholder = 'タイトル（例: 資料作成）';
        suffixInput.value = template.titleSuffix;
        suffixInput.addEventListener('input', () => { template.titleSuffix = suffixInput.value; });

        const contentInput = document.createElement('input');
        contentInput.type = 'text';
        contentInput.className = 'recur-template-content';
        contentInput.placeholder = '内容（省略時は親の内容を使用）';
        contentInput.value = template.content;
        contentInput.addEventListener('input', () => { template.content = contentInput.value; });

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'recur-template-remove-btn';
        removeBtn.textContent = '削除';
        removeBtn.addEventListener('click', () => {
            recurEditTemplates.splice(index, 1);
            renderRecurEditTemplates();
        });

        row.append(offsetInput, suffixInput, contentInput, removeBtn);
        return row;
    });

    list.replaceChildren(...rows);
}

document.getElementById('recuredit-template-add-btn')?.addEventListener('click', () => {
    recurEditTemplates.push({ offsetDays: 0, titleSuffix: '', content: '' });
    renderRecurEditTemplates();
});

/** 親タスク編集パネルをクリアし、新規登録モードの初期値を設定する。 */
function clearRecurEditForm() {
    ['recuredit-id', 'recuredit-title', 'recuredit-content', 'recuredit-biko', 'recuredit-status', 'recuredit-priority',
     'recuredit-estimate', 'recuredit-actual',
     'recuredit-start-date', 'recuredit-start-hour', 'recuredit-start-minute',
     'recuredit-end-date', 'recuredit-end-hour', 'recuredit-end-minute',
     'recuredit-complete-date', 'recuredit-category', 'recuredit-tag'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    document.getElementById('recuredit-parent-search').value = '';
    document.getElementById('recuredit-parent-id').value = '';
    recurEditFreq.month.clear();
    recurEditFreq.day.clear();
    recurEditFreq.weekday.clear();
    recurEditTemplates = [];
    renderRecurEditTemplates();

    const statusEl = document.getElementById('recuredit-status');
    if (statusEl) statusEl.value = '進行中';
    const priorityEl = document.getElementById('recuredit-priority');
    if (priorityEl) priorityEl.value = '中';
    const categoryEl = document.getElementById('recuredit-category');
    if (categoryEl && currentCategory !== 'すべて') categoryEl.value = currentCategory;
}

/** 親タスク編集パネルの「備考」欄と「子タスクテンプレート」欄の表示切り替え（親のみテンプレート編集を表示）。 */
function setRecurEditSectionVisibility(isParent) {
    const bikoSectionEl     = document.getElementById('recuredit-biko-section');
    const templateSectionEl = document.getElementById('recuredit-template-section');
    if (bikoSectionEl)     bikoSectionEl.style.display     = isParent ? 'none' : '';
    if (templateSectionEl) templateSectionEl.style.display = isParent ? '' : 'none';
}

/** 「グループに適用」ボタン・ヒントの表示切り替え。同時生成された子タスク（繰返し基準日を持つ）を編集中のときのみ表示する。 */
function setRecurBatchSyncVisibility(show) {
    const btnEl  = document.getElementById('recuredit-batch-sync-btn');
    const hintEl = document.getElementById('recuredit-batch-sync-hint');
    if (btnEl)  btnEl.style.display  = show ? '' : 'none';
    if (hintEl) hintEl.style.display = show ? '' : 'none';
}

/** 親タスク編集パネルを描画する。選択中の親タスクがあれば編集モード、無ければ新規登録モード。 */
function renderRecurringEditPanel() {
    const panel = document.getElementById('recurring-task-edit');
    if (!panel) return;

    populateTaskEditSelects('recuredit');
    renderParentDatalist('recuredit', selectedRecurringEditId);

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
        setRecurEditSectionVisibility(true); // 新規登録は常に親タスク扱い
        setRecurBatchSyncVisibility(false);
        return;
    }

    const isParentRow = !row['繰返し親ID'];

    const freqSectionEl = document.getElementById('recuredit-freq-section');
    if (freqSectionEl) freqSectionEl.style.display = isParentRow ? '' : 'none';
    setRecurEditSectionVisibility(isParentRow);
    setRecurBatchSyncVisibility(!isParentRow && !!row['繰返し基準日']);

    recurEditTemplates = isParentRow ? parseChildTemplates(row['備考']) : [];
    renderRecurEditTemplates();

    document.getElementById('recuredit-id').value       = row['ID']         ?? '';
    document.getElementById('recuredit-title').value    = row['タイトル']   ?? '';
    document.getElementById('recuredit-content').value  = row['内容']       ?? '';
    document.getElementById('recuredit-biko').value     = isParentRow ? '' : (row['備考'] ?? '');
    document.getElementById('recuredit-status').value   = row['ステータス'] ?? '';
    document.getElementById('recuredit-priority').value = row['優先度']     ?? '';
    document.getElementById('recuredit-category').value = row['カテゴリ']   ?? '';
    document.getElementById('recuredit-tag').value      = row['タグ']       ?? '';
    setParentFieldDisplay('recuredit', row);

    writeTaskDateTimeFieldsToForm('recuredit', row);
    writeTaskEstimateActualToForm('recuredit', row, 'minutes');

    loadFreqStateFromRow(recurEditFreq, row);
    renderRecurEditFreqChips();
    renderRecurringEditChart();
}

/** 「実行タスク生成」の基準日入力欄が未設定の場合のみ、当日をデフォルト値としてセットする。 */
function ensureRecurringManualDateDefault() {
    const el = document.getElementById('recurring-manual-date');
    if (!el || el.value) return;
    const t = new Date();
    const pad = n => String(n).padStart(2, '0');
    el.value = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/** タスクページの繰り返しタスクセクションを描画する（親タスク一覧＋子タスク一覧＋選択中タスクの編集パネル・グラフ）。 */
function renderRecurringSection() {
    renderRecurringFilters();
    renderRecurringWeekBoard();
    renderRecurringExecArea();
    renderRecurringChildTable();
    renderRecurringEditPanel();
    ensureRecurringManualDateDefault();
}

wireParentSearchInput('recuredit');

document.getElementById('recurring-add-new-btn')?.addEventListener('click', () => {
    selectedRecurringParentId = null;
    selectedRecurringEditId   = null;
    renderRecurringSection();
});

/** 「実行タスク生成」ボタン: 選択中の親タスクから今すぐ子タスク（テンプレート分すべて）を生成する。 */
document.getElementById('recurring-edit-manual-btn')?.addEventListener('click', () => {
    if (!selectedRecurringParentId) { alert('親タスクを選択してください'); return; }
    const parent = currentMainData.find(r => String(r['ID']) === selectedRecurringParentId);
    if (!parent) return;

    const [y, m, d] = (document.getElementById('recurring-manual-date')?.value || '').split('-').map(Number);
    const baseDate = (y && m && d) ? new Date(y, m - 1, d) : new Date();

    const children = generateChildManually(parent, currentMainData, baseDate);
    if (children.length === 0) { alert('指定日分は既に生成済みです'); return; }
    currentMainData.push(...children);
    persistLocalCache();
    renderRecurringSection();
});

/** 編集パネルの内容を選択中のタスク（親または子）へ書き戻す。 */
function applyRecurEditForm() {
    if (!selectedRecurringEditId) return;
    const row = currentMainData.find(r => String(r['ID']) === selectedRecurringEditId);
    if (!row) return;

    const parentId = document.getElementById('recuredit-parent-id').value || '';
    if (!checkParentCycleOrAlert(row['ID'], parentId)) return;

    const isParentRow = !row['繰返し親ID'];

    row['タイトル']   = document.getElementById('recuredit-title').value.trim();
    row['内容']       = document.getElementById('recuredit-content').value.trim();
    row['備考']       = isParentRow
        ? stringifyChildTemplates(recurEditTemplates)
        : document.getElementById('recuredit-biko').value.trim();
    row['ステータス'] = document.getElementById('recuredit-status').value;
    row['優先度']     = document.getElementById('recuredit-priority').value;
    row['見積時間']   = document.getElementById('recuredit-estimate').value;
    row['カテゴリ']   = document.getElementById('recuredit-category').value;
    row['タグ']       = document.getElementById('recuredit-tag').value;
    row['親ID']       = parentId;
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
}

/** 「適用」ボタン: 編集パネルの内容を選択中のタスク（親または子）へ書き戻す。 */
document.getElementById('recuredit-apply-btn')?.addEventListener('click', applyRecurEditForm);

/** "YYYY/MM/DD HH:mm" のような日時文字列の日付部分だけを days 日分ずらして返す（時刻部分は保持）。パース不可なら元の文字列のまま返す。 */
function shiftSlashDateTimeString(str, days) {
    const [datePart, timePart] = (str || '').split(' ');
    const d = parseSlashDateOnly(datePart);
    if (!d) return str;
    d.setDate(d.getDate() + days);
    const shifted = formatSlashDateOnly(d);
    return timePart ? `${shifted} ${timePart}` : shifted;
}

/**
 * 「グループに適用」ボタン: 選択中の子タスクへの変更を適用したうえで、同じ回（繰返し親ID＋繰返し基準日が同じ）の
 * 他の子タスクへも連動反映する。開始予定・終了予定どちらも「変更前後の日数差分」で扱い、
 * その差分だけグループ全体（編集中タスク自身も含む）の開始予定・終了予定を平行移動する
 * （＝各タスクの長さ・相対位置を保ったまま全体が動く）。
 * 開始予定と終了予定を両方変更した場合は、開始予定側の差分を優先して使う。
 */
function applyRecurBatchSync() {
    if (!selectedRecurringEditId) return;
    const row = currentMainData.find(r => String(r['ID']) === selectedRecurringEditId);
    if (!row || !row['繰返し親ID'] || !row['繰返し基準日']) return;

    const oldStartStr  = row['開始予定'];
    const oldEndStr    = row['終了予定'];
    const oldStartDate = parseSlashDateOnly(oldStartStr);
    const oldEndDate   = parseSlashDateOnly(oldEndStr);
    const { 開始予定: newStart, 終了予定: newEnd } = readTaskDateTimeFieldsFromForm('recuredit');
    const newStartDate = parseSlashDateOnly(newStart);
    const newEndDate   = parseSlashDateOnly(newEnd);

    const deltaStart = (oldStartDate && newStartDate) ? Math.round((newStartDate - oldStartDate) / 86400000) : 0;
    const deltaEnd    = (oldEndDate   && newEndDate)   ? Math.round((newEndDate   - oldEndDate)   / 86400000) : 0;
    const delta = deltaStart !== 0 ? deltaStart : deltaEnd; // 開始予定の差分を優先

    applyRecurEditForm(); // 選択中タスク自身の変更（日付以外も含む）を通常通り適用

    if (delta === 0) return;

    // 編集中タスク自身も、他タスクと同じ delta シフトで開始予定・終了予定を揃え直す
    // （フォームに入力した値そのものではなく、変更前の値からの平行移動として再計算するため、
    //   触っていない側の日付も含めて他タスクと同じだけ動く）
    if (oldStartStr) row['開始予定'] = shiftSlashDateTimeString(oldStartStr, delta);
    if (oldEndStr)   row['終了予定'] = shiftSlashDateTimeString(oldEndStr, delta);

    const siblings = currentMainData.filter(r =>
        r['繰返し親ID'] === row['繰返し親ID'] &&
        r['繰返し基準日'] === row['繰返し基準日'] &&
        String(r['ID']) !== selectedRecurringEditId
    );

    const ts = formatJpDatetime(new Date());
    row['更新日時'] = ts;
    siblings.forEach(sib => {
        if (sib['開始予定']) sib['開始予定'] = shiftSlashDateTimeString(sib['開始予定'], delta);
        if (sib['終了予定']) sib['終了予定'] = shiftSlashDateTimeString(sib['終了予定'], delta);
        sib['更新日時'] = ts;
    });

    persistLocalCache();
    renderRecurringSection();
    renderCalendar();
    renderTaskRunner();
}

document.getElementById('recuredit-batch-sync-btn')?.addEventListener('click', applyRecurBatchSync);

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
});

/** 「新規登録」ボタン: 編集パネルの現在値で新規の親タスクを追加する。 */
document.getElementById('recuredit-new-btn')?.addEventListener('click', () => {
    const title = document.getElementById('recuredit-title').value.trim();
    if (!title) { alert('タイトルを入力してください'); return; }

    const parentId = document.getElementById('recuredit-parent-id').value || '';
    if (!checkParentCycleOrAlert(null, parentId)) return;

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
    entry['備考']       = stringifyChildTemplates(recurEditTemplates); // 新規登録は常に親タスク扱い
    entry['ステータス'] = document.getElementById('recuredit-status').value;
    entry['優先度']     = document.getElementById('recuredit-priority').value;
    entry['見積時間']   = document.getElementById('recuredit-estimate').value;
    entry['カテゴリ']   = document.getElementById('recuredit-category').value || (currentCategory === 'すべて' ? '' : currentCategory);
    entry['タグ']       = document.getElementById('recuredit-tag').value;
    entry['親ID']       = parentId;
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

// ===========================================================================
// 新タスク整理（親ID方式・簡易版）
// カレンダー／ガントチャート／日別タイムラインは対象外。一覧＋編集フォームのみ。
// プロジェクトという特別な区分は無く、他行から親IDとして参照されている行が
// 実質的にプロジェクト（親）として扱われる。
// ===========================================================================

/** prefix-status／priority／category／tag の select 選択肢を再構築する（新方式にはプロジェクトselectが無いため対象外）。 */
function populateTaskEditSelects2(prefix) {
    const statuses = [...new Set(
        currentMasterData.filter(r => r['(M)ステータス_親'] === 'タスク')
            .map(r => r['(M)ステータス_子']).filter(Boolean)
    )];
    rebuildSelectById(`${prefix}-status`,   statuses);
    rebuildSelectById(`${prefix}-priority`, [...new Set(currentMasterData.map(r => r['(M)優先度']).filter(Boolean))]);
    rebuildSelectById(`${prefix}-category`, [...new Set(currentMasterData.map(r => r['(M)カテゴリ']).filter(Boolean))]);
    rebuildSelectById(`${prefix}-tag`,      getFilteredTags());
}

/**
 * prefix-parent-list（datalist）を、excludeId自身とその子孫を除いた候補で再構築する。
 * existingParentsOnly（既定true）の場合、既に他行から親IDとして参照されている行（＝既存プロジェクト）のみに絞る。
 */
function renderParentDatalist(prefix, excludeId, existingParentsOnly = true) {
    const dl = document.getElementById(`${prefix}-parent-list`);
    if (!dl) return;
    dl.innerHTML = '';
    getAllParentCandidatesM(currentMainData, excludeId, existingParentsOnly).forEach(c => {
        const opt = document.createElement('option');
        opt.value = `#${c.id} ${c.title}`;
        dl.appendChild(opt);
    });
}

/** row['親ID'] を prefix-parent-search（表示）／prefix-parent-id（hidden、保存用）へ反映する。 */
function setParentFieldDisplay(prefix, row) {
    const searchEl = document.getElementById(`${prefix}-parent-search`);
    const hiddenEl = document.getElementById(`${prefix}-parent-id`);
    if (!searchEl || !hiddenEl) return;
    const parent = getParentRowM(currentMainData, row);
    searchEl.value = parent ? `#${parent['ID']} ${parent['タイトル'] || ''}` : '';
    hiddenEl.value = parent ? parent['ID'] : '';
}

/** prefix-parent-search／prefix-parent-id／prefix-parent-clear-btn の入力連動を1度だけ配線する。 */
function wireParentSearchInput(prefix) {
    const searchEl = document.getElementById(`${prefix}-parent-search`);
    const hiddenEl = document.getElementById(`${prefix}-parent-id`);
    const clearBtn = document.getElementById(`${prefix}-parent-clear-btn`);
    searchEl?.addEventListener('input', () => {
        const m = searchEl.value.match(/^#(\d+)/);
        hiddenEl.value = m ? m[1] : '';
    });
    clearBtn?.addEventListener('click', () => {
        searchEl.value = '';
        hiddenEl.value = '';
    });
}

/** 指定行の親IDに newParentId を設定しようとした際に循環参照になる場合、確認アラートを出して false を返す。 */
function checkParentCycleOrAlert(childId, newParentId) {
    if (!newParentId) return true;
    const parentRow = currentMainData.find(r => String(r['ID']) === String(newParentId));
    if (!isEligibleParentRowM(parentRow)) {
        alert('親（プロジェクト）に設定できるのはタスクのみです。ナレッジは親にできません。');
        return false;
    }
    if (wouldCreateCycleM(currentMainData, childId, newParentId)) {
        alert('この親を設定すると循環参照になるため、保存できません。');
        return false;
    }
    return true;
}

/** 選択中カテゴリのメインデータのうち、実際にプロジェクト（子を持つ最上位の親行）に属するものを対象に、最上位の親行一覧を返す。 */
function getTaskorg2ProjectRootRows() {
    return getProjectRootRows(filterMainDataByCategory(currentMainData, currentCategory));
}

/** rootId を最上位の親に持つデータ区分「タスク」の件数（activeOnly指定時は完了・中断を除く）を、選択中カテゴリで絞り込んで返す。 */
function countTaskorg2ProjectTasks(rootId, activeOnly) {
    const pool = filterMainDataByCategory(currentMainData, currentCategory).filter(r => r['データ区分'] === 'タスク');
    return countRowsByProjectRoot(pool, rootId, activeOnly);
}

/** 選択中カテゴリ・タグ／ステータス／プロジェクト（最上位の親ID）フィルタのみで絞り込んだメインデータ一覧を返す（日付絞り込みは含まない）。カレンダーの日別集計に使う。 */
function getTaskorg2BaseFilteredList() {
    return filterMainDataByCategory(currentMainData, currentCategory).filter(r =>
        r['プロジェクト'] !== DAYPLAN_PROJECT && // 1日タスク（DAYPLAN）の器行は通常の一覧・カレンダーには出さない（旧タスク整理と同一仕様）
        matchesFilterValue(taskorg2Filters.tag, r['タグ']) &&
        matchesFilterValue(taskorg2Filters.status, r['ステータス']) &&
        matchesProjectRootFilter(r, taskorg2Filters.project)
    );
}

/** 選択中カテゴリ・タグ／ステータス／プロジェクト（最上位の親ID）フィルタに加え、カレンダーで選択中の日付があればそれで絞り込んだメインデータ一覧を返す。 */
function getTaskorg2FilteredList() {
    const base = getTaskorg2BaseFilteredList();
    if (!selectedTaskorg2Date) return base;
    const todayJP = jpDateOnly(formatJpDatetime(new Date()));
    return base.filter(r => getCalendarMarkDate(r, todayJP) === selectedTaskorg2Date);
}

/** dateJP にカレンダーの●印が出る（＝その日にマークされる）taskorg2の行一覧を、タグ／プロジェクト／ステータスフィルタ適用済みで返す。 */
function getTaskorg2TasksForDate(dateJP) {
    const todayJP = jpDateOnly(formatJpDatetime(new Date()));
    return getTaskorg2BaseFilteredList().filter(r => getCalendarMarkDate(r, todayJP) === dateJP);
}

/** 現在の taskorg2CalendarYear／taskorg2CalendarMonth に基づいて新タスク整理の月間カレンダーを描画する。日クリックでその日の一覧絞り込みを切り替える。 */
function renderTaskorg2CalendarGrid() {
    const label = document.getElementById('calendar2-month-label');
    if (label) label.textContent = `${taskorg2CalendarYear}年${taskorg2CalendarMonth + 1}月`;

    const grid = document.getElementById('calendar2-grid');
    if (!grid) return;
    grid.innerHTML = '';

    ['日', '月', '火', '水', '木', '金', '土'].forEach(d => {
        const head = document.createElement('div');
        head.className = 'calendar-day-head';
        head.textContent = d;
        grid.appendChild(head);
    });

    const todayJP        = jpDateOnly(formatJpDatetime(new Date()));
    const startWeekday   = new Date(taskorg2CalendarYear, taskorg2CalendarMonth, 1).getDay();
    const daysInMonth    = new Date(taskorg2CalendarYear, taskorg2CalendarMonth + 1, 0).getDate();
    const pad            = n => String(n).padStart(2, '0');

    for (let i = 0; i < startWeekday; i++) {
        const cell = document.createElement('div');
        cell.className = 'calendar-day calendar-day--empty';
        grid.appendChild(cell);
    }

    for (let d = 1; d <= daysInMonth; d++) {
        const dateJP = `${taskorg2CalendarYear}/${pad(taskorg2CalendarMonth + 1)}/${pad(d)}`;
        const cell = document.createElement('div');
        cell.className = 'calendar-day';
        if (dateJP === todayJP)              cell.classList.add('calendar-day--today');
        if (dateJP === selectedTaskorg2Date) cell.classList.add('calendar-day--selected');

        const num = document.createElement('div');
        num.className = 'calendar-day-num';
        num.textContent = String(d);
        cell.appendChild(num);

        const dayTasks = getTaskorg2TasksForDate(dateJP);
        if (dayTasks.length > 0) {
            const hasRemaining = dayTasks.some(r => !isTaskDoneForCalendar(r));
            const badge = document.createElement('span');
            badge.className = `calendar-day-badge ${hasRemaining ? 'calendar-day-badge--red' : 'calendar-day-badge--green'}`;
            badge.textContent = '●';
            badge.title = `${dayTasks.length} 件の予定`;
            cell.appendChild(badge);
        }

        cell.addEventListener('click', () => {
            selectedTaskorg2Date = dateJP;
            renderCalendar2();
        });
        grid.appendChild(cell);
    }
}

function goToPrevMonthTaskorg2() {
    taskorg2CalendarMonth--;
    if (taskorg2CalendarMonth < 0) { taskorg2CalendarMonth = 11; taskorg2CalendarYear--; }
    if (taskorg2View === 'calendar') renderTaskorg2CalendarGrid(); else renderTaskorg2GanttChart();
}
function goToNextMonthTaskorg2() {
    taskorg2CalendarMonth++;
    if (taskorg2CalendarMonth > 11) { taskorg2CalendarMonth = 0; taskorg2CalendarYear++; }
    if (taskorg2View === 'calendar') renderTaskorg2CalendarGrid(); else renderTaskorg2GanttChart();
}
document.getElementById('calendar2-prev-btn')?.addEventListener('click', goToPrevMonthTaskorg2);
document.getElementById('calendar2-next-btn')?.addEventListener('click', goToNextMonthTaskorg2);
document.getElementById('calendar2-gantt-prev-btn')?.addEventListener('click', goToPrevMonthTaskorg2);
document.getElementById('calendar2-gantt-next-btn')?.addEventListener('click', goToNextMonthTaskorg2);

/** 新タスク整理の「カレンダー」「ガントチャート」表示切り替えボタンの状態・表示パネルを反映する。 */
function renderTaskorg2ViewToggle() {
    document.getElementById('taskorg2-tab-calendar')?.classList.toggle('taskorg-view-btn--active', taskorg2View === 'calendar');
    document.getElementById('taskorg2-tab-gantt')?.classList.toggle('taskorg-view-btn--active', taskorg2View === 'gantt');
    const calEl   = document.getElementById('taskorg2-view-calendar');
    const ganttEl = document.getElementById('taskorg2-view-gantt');
    if (calEl)   calEl.style.display   = taskorg2View === 'calendar' ? '' : 'none';
    if (ganttEl) ganttEl.style.display = taskorg2View === 'gantt'    ? '' : 'none';
}

document.getElementById('taskorg2-tab-calendar')?.addEventListener('click', () => { taskorg2View = 'calendar'; renderCalendar2(); });
document.getElementById('taskorg2-tab-gantt')?.addEventListener('click', () => { taskorg2View = 'gantt'; renderCalendar2(); });

// ===== 新タスク整理：ガントチャート（月間カレンダーと年月・選択日を共有。旧タスク整理と同一仕様） =====

/** カテゴリ・taskorg2Filters（タグ／プロジェクト／ステータス）で絞り込んだタスク一覧を返す。1日タスクは除外し、日付未設定の行も除外する。 */
function getTaskorg2GanttTasks() {
    return getTaskorg2BaseFilteredList().filter(r => r['データ区分'] === 'タスク' && (r['開始予定'] || r['終了予定']));
}

/** ガントチャート（新タスク整理）を描画する。表示範囲は taskorg2CalendarYear/taskorg2CalendarMonth を基準とする。 */
function renderTaskorg2GanttChart() {
    const label = document.getElementById('calendar2-gantt-month-label');
    if (label) label.textContent = `${taskorg2CalendarYear}年${taskorg2CalendarMonth + 1}月`;

    const table = document.getElementById('calendar2-gantt-table');
    if (!table) return;

    const todayJP = jpDateOnly(formatJpDatetime(new Date()));
    const tasks = getTaskorg2GanttTasks();

    let columns;
    if (taskorg2GanttViewUnit === 'week') {
        columns = getGanttWeekColumns(taskorg2CalendarYear, taskorg2CalendarMonth).map(days => ({
            dates: days,
            label: `${Number(days[0].split('/')[1])}/${Number(days[0].split('/')[2])}`,
            isToday: days.includes(todayJP),
            isSelected: days.includes(selectedTaskorg2Date),
        }));
    } else {
        const daysInMonth = new Date(taskorg2CalendarYear, taskorg2CalendarMonth + 1, 0).getDate();
        const pad = n => String(n).padStart(2, '0');
        columns = Array.from({ length: daysInMonth }, (_, i) => {
            const d = `${taskorg2CalendarYear}/${pad(taskorg2CalendarMonth + 1)}/${pad(i + 1)}`;
            return { dates: [d], label: String(i + 1), isToday: d === todayJP, isSelected: d === selectedTaskorg2Date };
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
    const ganttWorkExceptions = parseExceptions(getWorkCalendarContent(taskorg2CalendarYear));

    columns.forEach(col => {
        const th = document.createElement('th');
        th.className = taskorg2GanttViewUnit === 'week' ? 'gantt-day-col gantt-week-col' : 'gantt-day-col';
        if (col.isToday)    th.classList.add('gantt-day-col--today');
        if (col.isSelected) th.classList.add('gantt-day-col--selected');

        if (taskorg2GanttViewUnit === 'day') {
            const [y, m, d] = col.dates[0].split('/').map(Number);
            const wType = ganttWorkExceptions.get(col.dates[0])?.type
                ?? getDefaultType(new Date(y, m - 1, d));
            if (wType !== '出勤日') th.classList.add(`gantt-day-col--work-${wType}`);
        }

        th.textContent = col.label;
        th.addEventListener('click', () => {
            selectedTaskorg2Date = col.dates[0];
            renderCalendar2();
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
            if (String(row['ID']) === selectedTaskorg2Id) tr.classList.add('selected-row');

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
                const marker = taskorg2GanttViewUnit === 'week' ? getGanttWeekMarker(row, col.dates) : getGanttMarker(row, col.dates[0]);
                if (marker) {
                    td.textContent = marker;
                    td.classList.add('gantt-marker', statusClass);
                }
                tr.appendChild(td);
            });

            tr.addEventListener('click', () => { selectedTaskorg2Id = String(row['ID']); renderCalendar2(); });
            tbody.appendChild(tr);
        });
    }

    table.replaceChildren(thead, tbody);
}

/** 新タスク整理のガントチャートの日／週切り替えボタンの表示状態を反映する。 */
function renderTaskorg2GanttUnitToggle() {
    document.getElementById('calendar2-gantt-unit-day')?.classList.toggle('gantt-unit-btn--active', taskorg2GanttViewUnit === 'day');
    document.getElementById('calendar2-gantt-unit-week')?.classList.toggle('gantt-unit-btn--active', taskorg2GanttViewUnit === 'week');
}

document.getElementById('calendar2-gantt-unit-day')?.addEventListener('click', () => {
    taskorg2GanttViewUnit = 'day';
    renderTaskorg2GanttUnitToggle();
    renderTaskorg2GanttChart();
});
document.getElementById('calendar2-gantt-unit-week')?.addEventListener('click', () => {
    taskorg2GanttViewUnit = 'week';
    renderTaskorg2GanttUnitToggle();
    renderTaskorg2GanttChart();
});

// ===== 新タスク整理：日別タイムライン＋1日タスク（DAYPLAN、旧タスク整理と同じデータ・同じ仕様） =====

/**
 * dateJP のtaskorg2行を「時間帯が決まっているもの（timed）」と「時間帯未定（unscheduled、今回は未表示）」に分ける。
 * 1日タスク（DAYPLAN）のブロックで参照済みの行は通常枠から除外し、DAYPLANブロック自身（リンク先タスクの有無を問わず）を timed に追加する（旧タスク整理と同一仕様）。
 * timed の各要素は { row, startMin, endMin, isDayPlanBlock?, dayPlanBlockIndex? }（分単位、0〜1440）。
 */
function getTaskorg2SegmentsForDate(dateJP) {
    const dayPlanTask   = getDayPlanTaskM(currentMainData, dateJP);
    const dayPlanBlocks = dayPlanTask ? parseDayPlanContent(dayPlanTask['内容']) : [];
    const referencedIds = new Set(dayPlanBlocks.map(b => b.refId).filter(Boolean));

    const timed = [];
    const unscheduled = [];
    const referenced = [];

    getTaskorg2TasksForDate(dateJP).forEach(row => {
        if (referencedIds.has(String(row['ID']))) { referenced.push(row); return; } // 1日タスクのブロックとして別途表示するため通常枠には出さない

        const startInfo = extractTimeOnDate(row['開始予定'], dateJP);
        const endInfo   = extractTimeOnDate(row['終了予定'], dateJP);
        const hasStartTime = !!(startInfo && startInfo.hasTime);
        const hasEndTime   = !!(endInfo && endInfo.hasTime);

        if (!hasStartTime && !hasEndTime) { unscheduled.push(row); return; }

        let startMin = hasStartTime ? startInfo.minutes : endInfo.minutes - 30;
        let endMin   = hasEndTime   ? endInfo.minutes   : startInfo.minutes + 30;
        if (endMin <= startMin) endMin = startMin + 30;
        startMin = Math.max(0, Math.min(1439, startMin));
        endMin   = Math.max(startMin + 15, Math.min(1440, endMin));

        timed.push({ row, startMin, endMin });
    });

    dayPlanBlocks.forEach((b, dayPlanBlockIndex) => {
        const linkedRow = b.refId ? currentMainData.find(r => String(r['ID']) === b.refId) : null;
        timed.push({
            row: linkedRow || { ID: null, タイトル: b.label || '（ラベルなし）', ステータス: null },
            startMin: b.startMin,
            endMin: b.endMin,
            isDayPlanBlock: true,
            dayPlanBlockIndex
        });
    });

    return { timed, unscheduled, referenced };
}

/** 1日の時間軸（0:00〜24:00の目盛り）と選択中日付のタスクの時間帯ブロックを描画する。選択中日付が無ければセクション自体を隠す。 */
function renderTaskorg2Timeline() {
    const titleEl = document.getElementById('calendar2-detail-title');
    if (titleEl) titleEl.textContent = selectedTaskorg2Date || '';
    if (!selectedTaskorg2Date) return;

    const hoursEl = document.getElementById('calendar2-timeline-hours');
    const lanesEl = document.getElementById('calendar2-timeline-lanes');
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
    const dateJP = selectedTaskorg2Date;
    const { timed } = getTaskorg2SegmentsForDate(dateJP);
    assignCalendarLanes(timed);

    const pxPerMin = CALENDAR_HOUR_HEIGHT / 60;
    const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

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
        if (hasLinkedTask && String(seg.row['ID']) === selectedTaskorg2Id) block.classList.add('calendar-time-block--selected');
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

        attachTaskorg2TimelineDragHandlers(block, handle, labelSpan, seg, dateJP, pxPerMin, hasLinkedTask);
        lanesEl.appendChild(block);
    });

    const scrollEl = document.getElementById('calendar2-timeline-scroll');
    if (scrollEl) scrollEl.scrollTop = 8 * CALENDAR_HOUR_HEIGHT;

    renderTaskorg2DayPlanSection();
}

/** タイムラインのブロックへ「移動」「リサイズ」操作を付与する（旧タスク整理と同じドラッグ挙動）。 */
function attachTaskorg2TimelineDragHandlers(block, handle, labelSpan, seg, dateJP, pxPerMin, hasLinkedTask) {
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
            if (dragMode === 'move' && hasLinkedTask) { selectedTaskorg2Id = String(seg.row['ID']); renderCalendar2(); }
        } else {
            commitTaskorg2TimelineDrag(seg, dateJP, pendingStart, pendingEnd);
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
 * タイムラインのドラッグ操作結果を確定保存する（旧タスク整理と同一仕様）。
 * 1日タスクのスケジュール行（isDayPlanBlock）はその行の時刻を、通常のタスクは開始予定・終了予定（dateJP当日分）を書き換える。
 */
function commitTaskorg2TimelineDrag(seg, dateJP, newStartMin, newEndMin) {
    const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

    if (seg.isDayPlanBlock) {
        const dayPlan = getDayPlanTaskM(currentMainData, dateJP);
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
    renderCalendar2();
    renderTaskRunner();
}

/** 選択中日付の1日タスク行（プロジェクト=DAYPLAN_PROJECT）を返す。無ければnull。旧タスク整理と同じ行を共有する。 */
function getTaskorg2DayPlanTask() {
    return selectedTaskorg2Date ? getDayPlanTaskM(currentMainData, selectedTaskorg2Date) : null;
}

/** 1日タスクの作成ボタン／編集エリアを、選択中の日付の状態に合わせて描画する（旧タスク整理と同一仕様）。 */
function renderTaskorg2DayPlanSection() {
    const createBtn = document.getElementById('calendar2-dayplan-create-btn');
    const editor    = document.getElementById('calendar2-dayplan-editor');
    const contentEl = document.getElementById('calendar2-dayplan-content');
    if (!createBtn || !editor || !contentEl) return;

    if (!selectedTaskorg2Date) {
        createBtn.style.display = 'none';
        editor.style.display = 'none';
        return;
    }

    const dayPlan = getTaskorg2DayPlanTask();
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

/**
 * 選択中日付の1日タスクを新規作成する（旧タスク整理と同一仕様：プロジェクト=DAYPLAN_PROJECT、開始予定=選択中日付）。
 * 内容には既定の「09:00-09:30 メールチェック、予定整理」に加え、その日既に開始予定・終了予定が
 * 時刻まで指定されている既存タスクを取り込む（カテゴリの絞り込みは適用、タグ／プロジェクト／ステータスの絞り込みは適用しない）。
 */
function createTaskorg2DayPlanTask() {
    if (!selectedTaskorg2Date) return;

    const maxId = currentMainData.reduce((max, row) => {
        const id = parseInt(row['ID'], 10);
        return isNaN(id) ? max : Math.max(max, id);
    }, 0);
    const ts = formatJpDatetime(new Date());

    const noFilters = { tag: new Set(), project: new Set(), status: new Set() };
    const scheduledBlocks = getTasksForDateM(currentMainData, currentCategory, noFilters, selectedTaskorg2Date)
        .map(row => {
            const timeInfo = getTaskScheduledTimeOnDate(row, selectedTaskorg2Date);
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
    entry['タイトル']   = `1日タスク ${selectedTaskorg2Date}`;
    entry['プロジェクト'] = DAYPLAN_PROJECT;
    entry['開始予定']   = selectedTaskorg2Date;
    entry['ステータス'] = '未着手';
    entry['内容']       = content;
    entry['作成日時']   = ts;
    entry['更新日時']   = ts;

    currentMainData.push(entry);
    persistLocalCache();
    renderCalendar2();
}

/** 編集エリアの内容をその日の1日タスクに保存する。 */
function saveTaskorg2DayPlanContent() {
    if (!selectedTaskorg2Date) return;
    const dayPlan = getTaskorg2DayPlanTask();
    if (!dayPlan) return;
    const contentEl  = document.getElementById('calendar2-dayplan-content');
    const rawContent = contentEl ? contentEl.value : '';
    const sortedBlocks = sortDayPlanBlocks(parseDayPlanContent(rawContent));
    dayPlan['内容']     = stringifyDayPlanBlocks(sortedBlocks);
    dayPlan['更新日時'] = formatJpDatetime(new Date());
    if (contentEl) contentEl.value = dayPlan['内容'];
    persistLocalCache();
    renderTaskorg2Timeline();
}

/** 選択中日付の1日タスクを削除する。 */
function deleteTaskorg2DayPlanTask() {
    if (!selectedTaskorg2Date) return;
    const dayPlan = getTaskorg2DayPlanTask();
    if (!dayPlan) return;
    currentMainData = currentMainData.filter(r => r !== dayPlan);
    persistLocalCache();
    renderCalendar2();
}

document.getElementById('calendar2-dayplan-create-btn')?.addEventListener('click', createTaskorg2DayPlanTask);
document.getElementById('calendar2-dayplan-save-btn')?.addEventListener('click', saveTaskorg2DayPlanContent);
document.getElementById('calendar2-dayplan-delete-btn')?.addEventListener('click', deleteTaskorg2DayPlanTask);

// ===== 新タスク整理：未設定タスク一覧（未設定/設定済み・日付未確定・属性未設定・中断。旧タスク整理と同一仕様） =====

/**
 * タスクを選択中日付の1日タスクに「HH:MM-HH:MM #ID タイトル」の1行として追加する（旧タスク整理と同一仕様）。1日タスクが無ければ新規作成する。
 */
function addTaskorg2ToDayPlan(row) {
    if (!selectedTaskorg2Date) return;
    let dayPlan = getTaskorg2DayPlanTask();
    if (!dayPlan) {
        createTaskorg2DayPlanTask();
        dayPlan = getTaskorg2DayPlanTask();
        if (!dayPlan) return;
    }
    const busyBlocks = parseDayPlanContent(dayPlan['内容']);
    const { startStr, endStr } = getTaskScheduledTimeOnDate(row, selectedTaskorg2Date) || computeDayPlanTimeSlot(busyBlocks);
    const line = `${startStr}-${endStr} #${row['ID']} ${row['タイトル'] || '（無題）'}`;
    dayPlan['内容']     = dayPlan['内容'] ? `${dayPlan['内容']}\n${line}` : line;
    dayPlan['更新日時'] = formatJpDatetime(new Date());
    persistLocalCache();
    renderCalendar2();
}

/** チップ群（{row, label}の配列）を container に描画する。空なら emptyText を表示する。options.showAddButton（既定true）で1日タスクへの追加＋ボタンの有無を切り替える。 */
function renderTaskorg2ChipList(container, chipEntries, emptyText, options = {}) {
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
        if (String(row['ID']) === selectedTaskorg2Id) chip.classList.add('calendar-unscheduled-chip--selected');
        chip.textContent = label;
        chip.addEventListener('click', () => { selectedTaskorg2Id = String(row['ID']); renderCalendar2(); });
        wrap.appendChild(chip);

        if (showAddButton) {
            const addBtn = document.createElement('button');
            addBtn.type = 'button';
            addBtn.className = 'calendar-unscheduled-chip-add';
            addBtn.title = '1日タスクに追加';
            addBtn.textContent = '+';
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                addTaskorg2ToDayPlan(row);
            });
            wrap.appendChild(addBtn);
        }

        container.appendChild(wrap);
    });
}

/** 未設定タスクの一覧を、ステータス順でグループ化して描画する（旧タスク整理と同一仕様）。 */
function renderTaskorg2GroupedChips(container, chipEntries, emptyText, options = {}) {
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

        renderTaskorg2ChipList(listEl, groupEntries, '', { showAddButton });
    });
}

/** 開始予定・終了予定の少なくとも一方が空欄のタスク（taskorg2フィルタ適用済み）を返す。 */
function getTaskorg2IncompleteDateTasks() {
    return getTaskorg2BaseFilteredList().filter(r =>
        r['データ区分'] === 'タスク' &&
        !(r['繰返し識別子'] === '1' && !r['繰返し親ID']) && // 繰返しタスクの親は対象外
        !(r['開始予定'] && r['終了予定']) // 両方入力済みは対象外
    );
}

/** カテゴリ／ステータス／優先度／プロジェクト（親ID）それぞれが未設定のタスクを、領域ごとに分けて返す（重複あり）。カテゴリ／ステータス／優先度は旧タスク整理と共通のロジックを再利用し、プロジェクトのみ親ID方式で判定する。 */
function getTaskorg2UnsetAttributeGroups() {
    const generic = getUnsetAttributeGroupsM(currentMainData, currentCategory);
    const pool = getTaskorg2BaseFilteredList().filter(r =>
        r['データ区分'] === 'タスク' && !(r['繰返し識別子'] === '1' && !r['繰返し親ID'])
    );
    const matchesCat = r => currentCategory === 'すべて' || !r['カテゴリ'] || r['カテゴリ'] === currentCategory;
    return {
        categoryUnset: generic.categoryUnset,
        statusUnset:   generic.statusUnset,
        priorityUnset: generic.priorityUnset,
        projectUnset:  pool.filter(r => !r['親ID'] && matchesCat(r)),
    };
}

/** ステータスが「中断」のタスクを返す（旧タスク整理と完全に同じロジックをそのまま再利用）。 */
function getTaskorg2SuspendedTasks() {
    return getSuspendedTasksM(currentMainData, currentCategory);
}

/** 未設定タスク一覧（未設定/設定済み・日付未確定・属性未設定・中断）を描画する。 */
function renderTaskorg2UnsetSection() {
    const unscheduledEl    = document.getElementById('calendar2-unscheduled-list');
    const dayplanAddedEl   = document.getElementById('calendar2-dayplan-added-list');
    const incompleteEl     = document.getElementById('calendar2-incomplete-date-list');
    const unsetCategoryEl  = document.getElementById('calendar2-unset-category-list');
    const unsetStatusEl    = document.getElementById('calendar2-unset-status-list');
    const unsetPriorityEl  = document.getElementById('calendar2-unset-priority-list');
    const unsetProjectEl   = document.getElementById('calendar2-unset-project-list');
    const suspendedEl      = document.getElementById('calendar2-suspended-list');
    if (!incompleteEl) return;

    const incompleteChips = getTaskorg2IncompleteDateTasks().map(row => ({ row, label: row['タイトル'] || '（無題）' }));
    renderTaskorg2ChipList(incompleteEl, incompleteChips, '該当するタスクはありません');
    setExpanderCount('calendar2-incomplete-count', incompleteChips.length);

    const unsetGroups = getTaskorg2UnsetAttributeGroups();
    const toChips = rows => rows.map(row => ({ row, label: row['タイトル'] || '（無題）' }));
    renderTaskorg2ChipList(unsetCategoryEl, toChips(unsetGroups.categoryUnset), '該当するタスクはありません', { showAddButton: false });
    renderTaskorg2ChipList(unsetStatusEl,   toChips(unsetGroups.statusUnset),   '該当するタスクはありません', { showAddButton: false });
    renderTaskorg2ChipList(unsetPriorityEl, toChips(unsetGroups.priorityUnset), '該当するタスクはありません', { showAddButton: false });
    renderTaskorg2ChipList(unsetProjectEl,  toChips(unsetGroups.projectUnset),  '該当するタスクはありません', { showAddButton: false });
    setExpanderCount('calendar2-unset-category-count', unsetGroups.categoryUnset.length);
    setExpanderCount('calendar2-unset-status-count',   unsetGroups.statusUnset.length);
    setExpanderCount('calendar2-unset-priority-count', unsetGroups.priorityUnset.length);
    setExpanderCount('calendar2-unset-project-count',  unsetGroups.projectUnset.length);
    setExpanderCount('calendar2-unset-total-count',
        unsetGroups.categoryUnset.length + unsetGroups.statusUnset.length +
        unsetGroups.priorityUnset.length + unsetGroups.projectUnset.length);

    const suspendedChips = toChips(getTaskorg2SuspendedTasks());
    renderTaskorg2ChipList(suspendedEl, suspendedChips, '該当するタスクはありません', { showAddButton: false });
    setExpanderCount('calendar2-suspended-count', suspendedChips.length);

    if (!selectedTaskorg2Date) {
        if (unscheduledEl)  unscheduledEl.innerHTML = '';
        if (dayplanAddedEl) dayplanAddedEl.innerHTML = '';
        setExpanderCountPair('calendar2-todo-dayplan-count', 0, 0);
        return;
    }

    const { timed, unscheduled, referenced } = getTaskorg2SegmentsForDate(selectedTaskorg2Date);
    const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const chipEntries = [
        ...unscheduled.map(row => ({ row, label: row['タイトル'] || '（無題）' })),
        ...timed.filter(seg => seg.row['ID'] != null && !seg.isDayPlanBlock)
                .map(seg => ({ row: seg.row, label: `${fmt(seg.startMin)}–${fmt(seg.endMin)} ${seg.row['タイトル'] || '（無題）'}` })),
    ];
    chipEntries.sort((a, b) => compareDateAscEmptyLast(a.row['終了予定'], b.row['終了予定']));
    renderTaskorg2GroupedChips(unscheduledEl, chipEntries, 'この日のタスクはありません', { showAddButton: true });

    const referencedChips = referenced.map(row => ({ row, label: row['タイトル'] || '（無題）' }));
    renderTaskorg2GroupedChips(dayplanAddedEl, referencedChips, 'まだありません');

    setExpanderCountPair('calendar2-todo-dayplan-count', chipEntries.length, referencedChips.length);
}

/** 新タスク整理のタグ／ステータス／プロジェクト絞り込みチップを描画する。 */
function renderTaskorg2Filters() {
    renderParentProjectFilters(
        document.getElementById('calendar2-filter-area'),
        taskorg2Filters, taskorg2FilterKnownOptions,
        getTaskorg2ProjectRootRows(), countTaskorg2ProjectTasks,
        () => renderCalendar2()
    );
}

/** 新タスク整理のタスク一覧テーブルを描画する。行クリックで編集対象を切り替える。 */
function renderTaskorg2List() {
    const table = document.getElementById('calendar2-task-list-table');
    if (!table) return;

    const tasks = getTaskorg2FilteredList();
    table.className = 'data-table';
    const cols = ['ID', 'データ区分', 'タイトル', 'ステータス', '親ID'];

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    cols.forEach(col => { const th = document.createElement('th'); th.textContent = col; hRow.appendChild(th); });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    tasks.forEach(row => {
        const tr = document.createElement('tr');
        if (String(row['ID']) === selectedTaskorg2Id) tr.classList.add('selected-row');
        cols.forEach(col => { const td = document.createElement('td'); td.textContent = row[col] ?? ''; tr.appendChild(td); });
        tr.addEventListener('click', () => { selectedTaskorg2Id = String(row['ID']); renderCalendar2(); });
        tbody.appendChild(tr);
    });

    table.replaceChildren(thead, tbody);
}

/** 選択中行の配下（子）タスク／ナレッジ一覧（読み取り専用）を描画する。行クリックで編集対象をその子に切り替える。 */
function renderTaskorg2Children(parentId) {
    const table   = document.getElementById('dayedit2-children-list');
    const countEl = document.getElementById('dayedit2-children-count');
    if (!table) return;

    const children = parentId ? getChildrenM(currentMainData, parentId) : [];
    if (countEl) countEl.textContent = children.length ? ` (${children.length})` : '';

    const cols = ['ID', 'データ区分', 'タイトル', 'ステータス'];
    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    cols.forEach(col => { const th = document.createElement('th'); th.textContent = col; hRow.appendChild(th); });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    children.forEach(row => {
        const tr = document.createElement('tr');
        cols.forEach(col => { const td = document.createElement('td'); td.textContent = row[col] ?? ''; tr.appendChild(td); });
        tr.addEventListener('click', () => { selectedTaskorg2Id = String(row['ID']); renderCalendar2(); });
        tbody.appendChild(tr);
    });
    table.replaceChildren(thead, tbody);
}

/** 新規登録モード（未選択）の際、編集フォームを既定値へリセットする。 */
function clearTaskorg2EditForm() {
    ['dayedit2-id', 'dayedit2-title', 'dayedit2-content', 'dayedit2-biko'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const statusEl = document.getElementById('dayedit2-status');
    if (statusEl) statusEl.value = '未着手';
    const priorityEl = document.getElementById('dayedit2-priority');
    if (priorityEl) priorityEl.value = '中';
    const categoryEl = document.getElementById('dayedit2-category');
    if (categoryEl && currentCategory !== 'すべて') categoryEl.value = currentCategory;
    const tagEl = document.getElementById('dayedit2-tag');
    if (tagEl) tagEl.value = '';
    document.getElementById('dayedit2-parent-search').value = '';
    document.getElementById('dayedit2-parent-id').value = '';
    ['start-date', 'start-hour', 'start-minute', 'end-date', 'end-hour', 'end-minute', 'complete-date'].forEach(f => {
        const el = document.getElementById(`dayedit2-${f}`);
        if (el) el.value = '';
    });
    document.getElementById('dayedit2-estimate').value = '';
    document.getElementById('dayedit2-actual').value   = '';
}

/** 新タスク整理の編集フォーム（選択中行、または新規登録モード）を描画する。 */
function renderTaskorg2Edit() {
    populateTaskEditSelects2('dayedit2');
    renderParentDatalist('dayedit2', selectedTaskorg2Id);

    const row = currentMainData.find(r => String(r['ID']) === selectedTaskorg2Id);
    if (!row) {
        clearTaskorg2EditForm();
        renderTaskorg2Children(null);
        return;
    }

    document.getElementById('dayedit2-id').value       = row['ID'];
    document.getElementById('dayedit2-title').value    = row['タイトル'] || '';
    document.getElementById('dayedit2-content').value  = row['内容'] || '';
    document.getElementById('dayedit2-biko').value     = row['備考'] || '';
    document.getElementById('dayedit2-status').value   = row['ステータス'] || '';
    document.getElementById('dayedit2-priority').value = row['優先度'] || '';
    document.getElementById('dayedit2-category').value = row['カテゴリ'] || '';
    document.getElementById('dayedit2-tag').value      = row['タグ'] || '';
    setParentFieldDisplay('dayedit2', row);
    writeTaskDateTimeFieldsToForm('dayedit2', row);
    writeTaskEstimateActualToForm('dayedit2', row, 'minutes');

    renderTaskorg2Children(row['ID']);
}

/** 「新タスク整理」タブ全体（フィルタ・カレンダー・一覧・編集フォーム・子一覧）を再描画する。 */
function renderCalendar2() {
    renderTaskorg2Filters();
    renderTaskorg2ViewToggle();
    renderTaskorg2CalendarGrid();
    renderTaskorg2GanttUnitToggle();
    renderTaskorg2GanttChart();
    renderTaskorg2Timeline();
    renderTaskorg2UnsetSection();
    renderTaskorg2List();
    renderTaskorg2Edit();
}

wireParentSearchInput('dayedit2');

document.getElementById('calendar2-quick-new-btn')?.addEventListener('click', () => {
    selectedTaskorg2Id = null;
    renderCalendar2();
});

/** 「新規」ボタン: フォームの現在値で新規行を追加する。データ区分は常に「タスク」。 */
document.getElementById('dayedit2-new-btn')?.addEventListener('click', () => {
    const title = document.getElementById('dayedit2-title').value.trim();
    if (!title) { alert('タイトルを入力してください'); return; }

    const parentId = document.getElementById('dayedit2-parent-id').value || '';

    const maxId = currentMainData.reduce((max, row) => {
        const id = parseInt(row['ID'], 10);
        return isNaN(id) ? max : Math.max(max, id);
    }, 0);
    const ts = formatJpDatetime(new Date());

    const entry = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
    entry['ID']        = String(maxId + 1);
    entry['データ区分'] = 'タスク';
    entry['タイトル']   = title;
    entry['内容']       = document.getElementById('dayedit2-content').value.trim();
    entry['備考']       = document.getElementById('dayedit2-biko').value.trim();
    entry['ステータス'] = document.getElementById('dayedit2-status').value;
    entry['優先度']     = document.getElementById('dayedit2-priority').value;
    entry['見積時間']   = document.getElementById('dayedit2-estimate').value;
    entry['カテゴリ']   = document.getElementById('dayedit2-category').value || (currentCategory === 'すべて' ? '' : currentCategory);
    entry['タグ']       = document.getElementById('dayedit2-tag').value;
    entry['親ID']       = parentId;
    Object.assign(entry, readTaskDateTimeFieldsFromForm('dayedit2'));
    entry['作成日時']   = ts;
    entry['更新日時']   = ts;

    currentMainData.push(entry);
    persistLocalCache();

    selectedTaskorg2Id = entry['ID'];
    renderCalendar2();
});

/** 「適用」ボタン: 選択中行へフォーム内容を書き戻す。親IDは循環参照チェックを通過した場合のみ保存する。 */
document.getElementById('dayedit2-apply-btn')?.addEventListener('click', () => {
    if (!selectedTaskorg2Id) return;
    const row = currentMainData.find(r => String(r['ID']) === selectedTaskorg2Id);
    if (!row) return;

    const parentId = document.getElementById('dayedit2-parent-id').value || '';
    if (!checkParentCycleOrAlert(row['ID'], parentId)) return;

    row['タイトル']   = document.getElementById('dayedit2-title').value.trim();
    row['内容']       = document.getElementById('dayedit2-content').value.trim();
    row['備考']       = document.getElementById('dayedit2-biko').value.trim();
    row['ステータス'] = document.getElementById('dayedit2-status').value;
    row['優先度']     = document.getElementById('dayedit2-priority').value;
    row['見積時間']   = document.getElementById('dayedit2-estimate').value;
    row['カテゴリ']   = document.getElementById('dayedit2-category').value;
    row['タグ']       = document.getElementById('dayedit2-tag').value;
    row['親ID']       = parentId;
    Object.assign(row, readTaskDateTimeFieldsFromForm('dayedit2'));
    row['更新日時'] = formatJpDatetime(new Date());

    persistLocalCache();
    renderCalendar2();
});

/** 「削除」ボタン: 選択中行を削除する。この行を親IDとして参照していた子行は親ID欄を空欄化する。 */
document.getElementById('dayedit2-delete-btn')?.addEventListener('click', () => {
    if (!selectedTaskorg2Id) return;
    if (!confirm('この行を削除しますか？')) return;

    currentMainData.forEach(r => { if (String(r['親ID'] || '') === selectedTaskorg2Id) r['親ID'] = ''; });
    currentMainData = currentMainData.filter(r => String(r['ID']) !== selectedTaskorg2Id);
    persistLocalCache();

    selectedTaskorg2Id = null;
    renderCalendar2();
});

// ===========================================================================
// 新編集（親ID方式）
// 旧「編集」タブと同じ INBOX／タスク／ナレッジ 統合編集・新規登録の操作感を踏襲し、
// 「プロジェクト」欄のみ親ID検索入力に置き換える。
// ===========================================================================

/** 行が属する最上位の親（プロジェクト）のタイトルを返す。プロジェクトに属さない行は空文字。 */
function getEdit2ProjectLabel(row) {
    const rootId = getRootParentIdM(currentMainData, row['ID']);
    if (!isParentRowM(currentMainData, rootId)) return '';
    const rootRow = currentMainData.find(r => String(r['ID']) === rootId);
    return rootRow ? (rootRow['タイトル'] || `#${rootId}`) : '';
}

/** edit2Kubun に応じたテーブル列定義を返す（プロジェクト列の代わりに親ID列を表示。表示自体は最上位プロジェクト名）。 */
function getEdit2Cols(kubun) {
    if (kubun === 'タスク')   return ['タイトル', 'ステータス', '優先度', '開始予定', '終了予定', '見積時間', 'カテゴリ', 'タグ', '親ID'];
    if (kubun === 'ナレッジ') return ['タイトル', 'ステータス', 'Input', 'PARA区分', 'カテゴリ', 'タグ', '親ID', '更新日時'];
    return ['カテゴリ', 'タイトル', '内容', 'タグ', '親ID', '作成日時', '更新日時'];
}

/** edit2Kubun + edit2Filters を適用したメインデータの絞り込み結果を返す。 */
function getFilteredEdit2Items() {
    let rows = getFilteredMainData().filter(r => r['データ区分'] === edit2Kubun);

    if (edit2Filters.tag)         rows = rows.filter(r => r['タグ'] === edit2Filters.tag);
    if (edit2Filters.project)     rows = rows.filter(r => getRootParentIdM(currentMainData, r['ID']) === edit2Filters.project);
    if (edit2Filters.createdFrom) rows = rows.filter(r => jpDateOnly(r['作成日時']) >= isoToJP(edit2Filters.createdFrom));
    if (edit2Filters.createdTo)   rows = rows.filter(r => jpDateOnly(r['作成日時']) <= isoToJP(edit2Filters.createdTo));
    if (edit2Filters.updatedFrom) rows = rows.filter(r => jpDateOnly(r['更新日時']) >= isoToJP(edit2Filters.updatedFrom));
    if (edit2Filters.updatedTo)   rows = rows.filter(r => jpDateOnly(r['更新日時']) <= isoToJP(edit2Filters.updatedTo));

    if (edit2Kubun === 'タスク') {
        if (edit2Filters.priority)  rows = rows.filter(r => r['優先度'] === edit2Filters.priority);
        if (edit2Filters.startFrom) rows = rows.filter(r => (r['開始予定'] || '') >= isoToJP(edit2Filters.startFrom));
        if (edit2Filters.startTo)   rows = rows.filter(r => (r['開始予定'] || '') <= isoToJP(edit2Filters.startTo));
        if (edit2Filters.endFrom)   rows = rows.filter(r => (r['終了予定'] || '') >= isoToJP(edit2Filters.endFrom));
        if (edit2Filters.endTo)     rows = rows.filter(r => (r['終了予定'] || '') <= isoToJP(edit2Filters.endTo));
        if (edit2Filters.status)    rows = rows.filter(r => r['ステータス'] === edit2Filters.status);
    }
    if (edit2Kubun === 'ナレッジ') {
        if (edit2Filters.input)  rows = rows.filter(r => r['Input']      === edit2Filters.input);
        if (edit2Filters.para)   rows = rows.filter(r => r['PARA区分']   === edit2Filters.para);
        if (edit2Filters.status) rows = rows.filter(r => r['ステータス'] === edit2Filters.status);
    }

    return rows;
}

/** 「新編集」セクション全体を再描画する。 */
function renderEdit2() {
    renderEdit2KubunTabs();
    renderEdit2Filters();
    renderEdit2Table();
    updateEdit2Form();
}

/** データ区分タブ（ラジオ、一覧の絞り込み用）を描画する。 */
function renderEdit2KubunTabs() {
    const container = document.getElementById('edit2-kubun-tabs');
    if (!container) return;

    const kubunValues = [...new Set(currentMasterData.map(r => r['(M)データ区分']).filter(Boolean))];
    if (kubunValues.length > 0 && !kubunValues.includes(edit2Kubun)) {
        edit2Kubun = kubunValues[0];
    }

    container.innerHTML = '';
    kubunValues.forEach(val => {
        const count = getFilteredMainData().filter(r => r['データ区分'] === val).length;
        const label = document.createElement('label');
        label.className = 'triage-tab-label' + (val === edit2Kubun ? ' active' : '');

        const radio = document.createElement('input');
        radio.type    = 'radio';
        radio.name    = 'edit2-kubun-tab';
        radio.value   = val;
        radio.checked = (val === edit2Kubun);
        radio.addEventListener('change', () => {
            edit2Kubun = val;
            edit2Filters = {};
            selectedEdit2Ids.clear();
            renderEdit2Filters();
            renderEdit2Table();
            updateEdit2Form();
            clearEdit2Form();
        });

        label.append(radio, document.createTextNode(` ${val}（${count}）`));
        container.appendChild(label);
    });
}

/** edit2Kubun に応じたフィルタコントロールを描画する。 */
function renderEdit2Filters() {
    const area = document.getElementById('edit2-filter-area');
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
        return createFilterSelect(options, placeholder, edit2Filters[key], v => {
            edit2Filters[key] = v;
            renderEdit2Table();
        });
    }
    /** プロジェクト（親ID方式）用の<select>を生成する。値はID、表示はタイトルなので通常のcreateFilterSelectは使えない。 */
    function makeProjectSelect() {
        const sel = document.createElement('select');
        sel.innerHTML = '<option value="">すべて</option>';
        getProjectRootRows(getFilteredMainData()).forEach(r => {
            const o = document.createElement('option');
            o.value = String(r['ID']);
            o.textContent = r['タイトル'] || `#${r['ID']}`;
            sel.appendChild(o);
        });
        if (edit2Filters.project) sel.value = edit2Filters.project;
        sel.addEventListener('change', () => { edit2Filters.project = sel.value; renderEdit2Table(); });
        return sel;
    }
    function makeDateRange(fromKey, toKey) {
        const wrap = document.createElement('div');
        wrap.className = 'filter-date-range';
        const fromInp = document.createElement('input');
        fromInp.type = 'date'; fromInp.className = 'filter-date-input';
        fromInp.value = edit2Filters[fromKey] || '';
        fromInp.addEventListener('change', () => { edit2Filters[fromKey] = fromInp.value; renderEdit2Table(); });
        const toInp = document.createElement('input');
        toInp.type = 'date'; toInp.className = 'filter-date-input';
        toInp.value = edit2Filters[toKey] || '';
        toInp.addEventListener('change', () => { edit2Filters[toKey] = toInp.value; renderEdit2Table(); });
        wrap.append(fromInp, document.createTextNode(' 〜 '), toInp);
        return wrap;
    }

    makeRow('タグ',    makeSelect(getFilteredTags(), 'すべて', 'tag'));
    makeRow('プロジェクト', makeProjectSelect());
    makeRow('作成日時', makeDateRange('createdFrom', 'createdTo'));
    makeRow('更新日時', makeDateRange('updatedFrom', 'updatedTo'));

    if (edit2Kubun === 'タスク') {
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
    if (edit2Kubun === 'ナレッジ') {
        const inputs = [...new Set(currentMasterData.map(r => r['(M)Input']).filter(Boolean))];
        makeRow('Input', makeSelect(inputs, 'すべて', 'input'));
        const paraOptions = [...new Set(currentMasterData.map(r => r['(M)PARA区分']).filter(Boolean))];
        makeRow('PARA区分', makeSelect(paraOptions, 'すべて', 'para'));
        const knowledgeStatuses = [...new Set(
            currentMasterData.filter(r => r['(M)ステータス_親'] === 'ナレッジ')
                .map(r => r['(M)ステータス_子']).filter(Boolean)
        )];
        makeRow('ステータス', makeSelect(knowledgeStatuses, 'すべて', 'status'));
    }
}

/** 一覧テーブルを描画する（edit2Kubun + edit2Filters を適用）。 */
function renderEdit2Table() {
    const cols = getEdit2Cols(edit2Kubun);
    const rows = getFilteredEdit2Items();

    const summaryEl = document.getElementById('summary-edit2');
    if (summaryEl) {
        summaryEl.innerHTML = `編集<span class="expander-count">${rows.length} 件</span>`;
    }

    const table = document.getElementById('table-edit2-list');
    if (!table) return;
    table.className = 'data-table';

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
                selectedEdit2Ids.add(cb.value);
                tr.classList.add('selected-row');
            } else {
                selectedEdit2Ids.delete(cb.value);
                tr.classList.remove('selected-row');
            }
        });
        updateEdit2SelectionInfo();
        prefillEdit2Form();
    });
    thCheck.appendChild(checkAll);
    hRow.appendChild(thCheck);
    cols.forEach(col => {
        const th = document.createElement('th');
        th.textContent = col === '親ID' ? 'プロジェクト' : col;
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

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
            if (selectedEdit2Ids.has(id)) tr.classList.add('selected-row');

            const tdCheck = document.createElement('td');
            tdCheck.style.textAlign = 'center';
            const cb = document.createElement('input');
            cb.type    = 'checkbox';
            cb.value   = id;
            cb.checked = selectedEdit2Ids.has(id);
            cb.addEventListener('change', () => {
                if (cb.checked) { selectedEdit2Ids.add(id);    tr.classList.add('selected-row'); }
                else            { selectedEdit2Ids.delete(id); tr.classList.remove('selected-row'); }
                updateEdit2SelectionInfo();
                prefillEdit2Form();
            });
            tdCheck.appendChild(cb);
            tr.appendChild(tdCheck);

            cols.forEach(col => {
                const td  = document.createElement('td');
                let   val = col === '親ID' ? getEdit2ProjectLabel(row) : (row[col] ?? '');
                if ((col === '内容' || col === 'タイトル') && val.length > 40) val = val.slice(0, 40) + '…';
                td.textContent = val;
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        checkAll.checked = rows.every(r => selectedEdit2Ids.has(String(r['ID'])));
    }

    table.replaceChildren(thead, tbody);
    updateEdit2SelectionInfo();
}

/** 選択件数のバッジテキストを更新する。 */
function updateEdit2SelectionInfo() {
    const el = document.getElementById('edit2-selection-info');
    if (!el) return;
    el.textContent = selectedEdit2Ids.size === 0
        ? '行を選択してください'
        : `${selectedEdit2Ids.size} 件選択中`;
}

/** フォームを再構築する（移動先データ区分ドロップダウン・タグ・カテゴリ・条件フィールド）。 */
function updateEdit2Form() {
    const kubunOptions = [...new Set(currentMasterData.map(r => r['(M)データ区分']).filter(Boolean))];
    rebuildSelectById('edit2-kubun', kubunOptions, '（選択してください）');
    const kubunEl = document.getElementById('edit2-kubun');
    if (kubunEl) {
        kubunEl.value = edit2Kubun;
        if (!kubunEl.dataset.editListenerAttached) {
            kubunEl.addEventListener('change', () => updateEdit2ConditionalFields(kubunEl.value));
            kubunEl.dataset.editListenerAttached = 'true';
        }
    }

    rebuildSelectById('edit2-tag',      getFilteredTags());
    rebuildSelectById('edit2-category', [...new Set(currentMasterData.map(r => r['(M)カテゴリ']).filter(Boolean))]);
    renderParentDatalist('edit2', selectedEdit2Ids.size === 1 ? [...selectedEdit2Ids][0] : null);

    updateEdit2ConditionalFields(kubunEl?.value || edit2Kubun);
    updateEdit2SelectionInfo();
}

/** 移動先データ区分に応じて条件付きフィールドの表示・選択肢を更新する。 */
function updateEdit2ConditionalFields(kubun) {
    const isTask      = (kubun === 'タスク');
    const isKnowledge = (kubun === 'ナレッジ');

    function show(id, visible) {
        const el = document.getElementById(id);
        if (el) el.style.display = visible ? '' : 'none';
    }
    show('edit2-status-row',   isTask || isKnowledge);
    show('edit2-priority-row', isTask);
    show('edit2-start-row',    isTask);
    show('edit2-end-row',      isTask);
    show('edit2-estimate-row', isTask);
    show('edit2-input-row',    isKnowledge);
    show('edit2-output-row',   isKnowledge);
    show('edit2-para-row',     isKnowledge);

    if (isTask || isKnowledge) {
        const parent   = isTask ? 'タスク' : 'ナレッジ';
        const statuses = [...new Set(
            currentMasterData.filter(r => r['(M)ステータス_親'] === parent)
                .map(r => r['(M)ステータス_子']).filter(Boolean)
        )];
        rebuildSelectById('edit2-status', statuses);
    }
    if (isTask) {
        rebuildSelectById('edit2-priority', [...new Set(currentMasterData.map(r => r['(M)優先度']).filter(Boolean))]);
    }
    if (isKnowledge) {
        rebuildSelectById('edit2-input',  [...new Set(currentMasterData.map(r => r['(M)Input']).filter(Boolean))]);
        rebuildSelectById('edit2-output', [...new Set(currentMasterData.map(r => r['(M)Output']).filter(Boolean))]);
        rebuildSelectById('edit2-para',   [...new Set(currentMasterData.map(r => r['(M)PARA区分']).filter(Boolean))]);
    }
}

/** 1件選択時にフォームへ現在値を自動入力する（複数選択時はタイトル・内容・備考をクリア）。 */
function prefillEdit2Form() {
    const contentEl = document.getElementById('edit2-content');

    if (selectedEdit2Ids.size !== 1) {
        if (contentEl) contentEl.value = '';
        document.getElementById('edit2-title').value = '';
        document.getElementById('edit2-biko').value  = '';
        return;
    }

    const row = currentMainData.find(r => String(r['ID']) === [...selectedEdit2Ids][0]);
    if (!row) return;

    if (contentEl) contentEl.value = row['内容'] ?? '';

    document.getElementById('edit2-title').value = row['タイトル'] ?? '';
    document.getElementById('edit2-biko').value  = row['備考']     ?? '';

    const tagEl = document.getElementById('edit2-tag');
    if (tagEl) tagEl.value = row['タグ'] ?? '';
    const categoryEl = document.getElementById('edit2-category');
    if (categoryEl) categoryEl.value = row['カテゴリ'] ?? '';
    setParentFieldDisplay('edit2', row);

    const kubunEl = document.getElementById('edit2-kubun');
    if (kubunEl) {
        kubunEl.value = row['データ区分'] ?? '';
        updateEdit2ConditionalFields(kubunEl.value);
    }

    const statusEl = document.getElementById('edit2-status');
    if (statusEl) statusEl.value = row['ステータス'] ?? '';
    const priorityEl = document.getElementById('edit2-priority');
    if (priorityEl) priorityEl.value = row['優先度'] ?? '';
    const startEl = document.getElementById('edit2-start');
    if (startEl) startEl.value = (row['開始予定'] || '').replace(/\//g, '-').slice(0, 10);
    const endEl = document.getElementById('edit2-end');
    if (endEl) endEl.value = (row['終了予定'] || '').replace(/\//g, '-').slice(0, 10);
    const estimateEl = document.getElementById('edit2-estimate');
    if (estimateEl) estimateEl.value = row['見積時間'] ?? '';
    const inputEl = document.getElementById('edit2-input');
    if (inputEl) inputEl.value = row['Input'] ?? '';
    const outputEl = document.getElementById('edit2-output');
    if (outputEl) outputEl.value = row['Output'] ?? '';
    const paraEl = document.getElementById('edit2-para');
    if (paraEl) paraEl.value = row['PARA区分'] ?? '';
}

/** フォームをクリアし、移動先データ区分を現在の表示タブに戻す。 */
function clearEdit2Form() {
    ['edit2-title', 'edit2-content', 'edit2-biko', 'edit2-status', 'edit2-priority',
     'edit2-start', 'edit2-end', 'edit2-estimate', 'edit2-input', 'edit2-output', 'edit2-para',
     'edit2-category', 'edit2-tag'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    document.getElementById('edit2-parent-search').value = '';
    document.getElementById('edit2-parent-id').value = '';
    const kubunEl = document.getElementById('edit2-kubun');
    if (kubunEl) {
        kubunEl.value = edit2Kubun;
        updateEdit2ConditionalFields(edit2Kubun);
    }
}

wireParentSearchInput('edit2');

/** 「新規」ボタン: 選択状態に関わらず、フォームの現在値（移動先データ区分）で新規データを追加する。 */
document.getElementById('edit2-new-btn')?.addEventListener('click', () => {
    const kubun = document.getElementById('edit2-kubun').value;
    if (!kubun) { alert('データ区分を選択してください'); return; }

    const parentId = document.getElementById('edit2-parent-id').value || '';
    if (!checkParentCycleOrAlert(null, parentId)) return;

    const title    = document.getElementById('edit2-title').value.trim();
    const content  = document.getElementById('edit2-content').value.trim();
    const biko     = document.getElementById('edit2-biko').value.trim();
    const category = document.getElementById('edit2-category').value;
    const tag      = document.getElementById('edit2-tag').value;
    const status   = document.getElementById('edit2-status')?.value   || '';
    const priority = document.getElementById('edit2-priority')?.value || '';
    const start    = document.getElementById('edit2-start')?.value    || '';
    const end      = document.getElementById('edit2-end')?.value      || '';
    const estimate = document.getElementById('edit2-estimate')?.value || '';
    const input    = document.getElementById('edit2-input')?.value    || '';
    const output   = document.getElementById('edit2-output')?.value   || '';
    const para     = document.getElementById('edit2-para')?.value     || '';

    const maxId = currentMainData.reduce((max, row) => {
        const id = parseInt(row['ID'], 10);
        return isNaN(id) ? max : Math.max(max, id);
    }, 0);
    const ts = formatJpDatetime(new Date());

    const entry = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
    entry['ID']        = String(maxId + 1);
    entry['データ区分'] = kubun;
    entry['カテゴリ']   = category || (currentCategory === 'すべて' ? '' : currentCategory);
    entry['タイトル']   = title;
    entry['内容']       = content;
    entry['備考']       = biko;
    entry['タグ']       = tag;
    entry['親ID']       = parentId;
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
        if (para)   entry['PARA区分'] = para;
    }

    currentMainData.push(entry);
    persistLocalCache();

    selectedEdit2Ids.clear();
    clearEdit2Form();
    renderEdit2KubunTabs();
    renderEdit2Table();

    const info = document.getElementById('edit2-selection-info');
    if (info) {
        info.textContent = `✓ 登録しました（${kubun} / ID: ${entry['ID']}）`;
        setTimeout(updateEdit2SelectionInfo, 2000);
    }
});

/** 「更新」ボタン: 選択行に全フォーム値を適用して更新日時を更新する（データ区分の移動も可能）。親IDは循環参照チェックを通過した場合のみ保存する。 */
document.getElementById('edit2-apply-btn')?.addEventListener('click', () => {
    if (selectedEdit2Ids.size === 0) { alert('変更する行を選択してください'); return; }

    const kubun = document.getElementById('edit2-kubun').value;
    if (!kubun) { alert('データ区分を選択してください'); return; }

    const parentId = document.getElementById('edit2-parent-id').value || '';
    if (selectedEdit2Ids.size === 1) {
        if (!checkParentCycleOrAlert([...selectedEdit2Ids][0], parentId)) return;
    }

    const title    = document.getElementById('edit2-title').value.trim();
    const biko     = document.getElementById('edit2-biko').value.trim();
    const category = document.getElementById('edit2-category').value;
    const tag      = document.getElementById('edit2-tag').value;
    const content = selectedEdit2Ids.size === 1
        ? (document.getElementById('edit2-content')?.value ?? null) : null;
    const status   = document.getElementById('edit2-status')?.value   || '';
    const priority = document.getElementById('edit2-priority')?.value || '';
    const start    = document.getElementById('edit2-start')?.value    || '';
    const end      = document.getElementById('edit2-end')?.value      || '';
    const estimate = document.getElementById('edit2-estimate')?.value || '';
    const input    = document.getElementById('edit2-input')?.value    || '';
    const output   = document.getElementById('edit2-output')?.value   || '';
    const para     = document.getElementById('edit2-para')?.value     || '';
    const ts = formatJpDatetime(new Date());

    selectedEdit2Ids.forEach(id => {
        const row = currentMainData.find(r => String(r['ID']) === id);
        if (!row) return;

        row['データ区分'] = kubun;
        row['更新日時']   = ts;
        if (title)                       row['タイトル'] = title;
        if (biko)                        row['備考']     = biko;
        if (category)                    row['カテゴリ'] = category;
        if (tag)                         row['タグ']     = tag;
        if (selectedEdit2Ids.size === 1) row['親ID']     = parentId;
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
            if (para)   row['PARA区分'] = para;
        }
    });

    selectedEdit2Ids.clear();
    persistLocalCache();
    renderEdit2();
});

/** 「削除」ボタン: 選択行をメインデータから完全に削除する。参照していた子行の親IDは空欄化する。 */
document.getElementById('edit2-delete-btn')?.addEventListener('click', () => {
    if (selectedEdit2Ids.size === 0) { alert('削除する行を選択してください'); return; }
    if (!confirm(`選択した ${selectedEdit2Ids.size} 件を削除します。よろしいですか？（この操作は取り消せません）`)) return;

    currentMainData.forEach(r => { if (selectedEdit2Ids.has(String(r['親ID'] || ''))) r['親ID'] = ''; });
    currentMainData = currentMainData.filter(r => !selectedEdit2Ids.has(String(r['ID'])));

    selectedEdit2Ids.clear();
    persistLocalCache();
    renderEdit2();
});

// ===========================================================================
// 新プロジェクト（親子ブラウザ形式）
// 特別な「プロジェクト」区分は無く、他行から親IDとして参照されている行（タスク／ナレッジ問わず）を
// 一覧表示し、選択すると配下の子タスク／ナレッジを表示・編集できる。
// ===========================================================================

const PROJECT2_HIDDEN_STATUS = '非表示'; // プロジェクトの「非表示」を表すステータス値（ステータス列を表示制御に共用する）

/** 他行から親IDとして参照されている「最上位（ルート）」の行を、非表示のものを除きカテゴリで絞り込んで返す（自身に親IDを持たない行に限る）。 */
function getProject2ParentRows() {
    let rows = currentMainData.filter(r =>
        !r['親ID'] && isParentRowM(currentMainData, r['ID']) && r['ステータス'] !== PROJECT2_HIDDEN_STATUS
    );
    if (currentCategory !== 'すべて') rows = rows.filter(r => r['カテゴリ'] === currentCategory);
    return rows;
}

/** プロジェクト管理表用：他行から親IDとして参照されている「最上位（ルート）」の行を、非表示のものも含めて全件返す。 */
function getProject2AllParentRowsForAdmin() {
    let rows = currentMainData.filter(r => !r['親ID'] && isParentRowM(currentMainData, r['ID']));
    if (currentCategory !== 'すべて') rows = rows.filter(r => r['カテゴリ'] === currentCategory);
    return rows;
}

/**
 * まだどのプロジェクトにも属していない単独タスク（親ID空欄・自身も親でない・データ区分がタスク）を返す。
 * 「プロジェクト編集」の階層1で「（単独タスク）」を選んだ際の階層2候補として使う。
 */
function getProject2StandaloneTaskRows() {
    let rows = currentMainData.filter(r => !r['親ID'] && r['データ区分'] === 'タスク' && !isParentRowM(currentMainData, r['ID']));
    if (currentCategory !== 'すべて') rows = rows.filter(r => r['カテゴリ'] === currentCategory);
    return rows;
}

/** 子行配列のステータス内訳を "ステータス:件数" の並びで返す。 */
function summarizeChildStatuses(children) {
    const counts = {};
    children.forEach(c => {
        const s = c['ステータス'] || '（未設定）';
        counts[s] = (counts[s] || 0) + 1;
    });
    return Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ');
}

/** rootId 配下の全階層の子孫を { row, depth } の配列（深さ優先、親の直後にその子が続く順）で返す。「新規プロジェクトの追加」の付け替え候補一覧に使用する。 */
function collectProject2Descendants(rootId, depth = 1, out = [], visited = new Set()) {
    if (visited.has(String(rootId))) return out; // 循環データ保護
    visited.add(String(rootId));
    getChildrenM(currentMainData, rootId).forEach(child => {
        out.push({ row: child, depth });
        collectProject2Descendants(child['ID'], depth + 1, out, visited);
    });
    return out;
}

/** id からその行自身までの親ID系列を、ルート→id自身の順で返す（循環データ保護つき）。プルダウン選択・行選択のたびに現在の実データを基準に再構築する。 */
function buildProject2PathFromId(id) {
    if (!id) return [];
    const idMap = new Map(currentMainData.map(r => [String(r['ID']), r]));
    const chain = [];
    const visited = new Set();
    let currentId = String(id);
    let current = idMap.get(currentId);
    while (current && !visited.has(currentId)) {
        chain.unshift(currentId);
        visited.add(currentId);
        const pid = current['親ID'] ? String(current['親ID']) : null;
        if (!pid || !idMap.has(pid)) break;
        currentId = pid;
        current = idMap.get(pid);
    }
    return chain;
}

// ---- プロジェクト管理表（表示/非表示・名前変更・統合・削除） ----

/** 指定プロジェクトが表示中かどうかを判定する（ステータスが「非表示」でなければ表示中）。 */
function isProject2Visible(row) {
    return row['ステータス'] !== PROJECT2_HIDDEN_STATUS;
}

/** 「プロジェクト管理」表を描画する。列: プロジェクト名／タスク数／状態／名前変更／統合／削除。 */
function renderProject2AdminTable() {
    const table = document.getElementById('project2-admin-table');
    if (!table) return;

    const projects = getProject2AllParentRowsForAdmin()
        .sort((a, b) => collectProject2Descendants(String(b['ID'])).length - collectProject2Descendants(String(a['ID'])).length);
    table.className = 'data-table';
    const cols = ['プロジェクト名', 'タスク数', '状態', '名前変更', '統合', '削除'];

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    cols.forEach(c => { const th = document.createElement('th'); th.textContent = c; hRow.appendChild(th); });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    projects.forEach(row => {
        const id = String(row['ID']);
        const tr = document.createElement('tr');

        // プロジェクト名
        const tdName = document.createElement('td');
        tdName.textContent = row['タイトル'] || '';
        tr.appendChild(tdName);

        // タスク数（全階層合計）
        const tdCount = document.createElement('td');
        tdCount.textContent = String(collectProject2Descendants(id).length);
        tr.appendChild(tdCount);

        // 状態（表示/非表示切り替え）
        const tdStatus = document.createElement('td');
        const visible = isProject2Visible(row);
        const statusBtn = document.createElement('button');
        statusBtn.type = 'button';
        statusBtn.className = 'calendar-add-btn';
        statusBtn.textContent = visible ? '表示中' : '非表示中';
        statusBtn.addEventListener('click', () => {
            row['ステータス']  = visible ? PROJECT2_HIDDEN_STATUS : '';
            row['更新日時']    = formatJpDatetime(new Date());
            persistLocalCache();
            renderProjectAdmin2();
        });
        tdStatus.appendChild(statusBtn);
        tr.appendChild(tdStatus);

        // 名前変更
        const tdRename = document.createElement('td');
        const renameInput = document.createElement('input');
        renameInput.type  = 'text';
        renameInput.value = row['タイトル'] || '';
        renameInput.style.width = '10em';
        const renameBtn = document.createElement('button');
        renameBtn.type = 'button';
        renameBtn.className = 'calendar-add-btn';
        renameBtn.textContent = '変更';
        renameBtn.addEventListener('click', () => {
            const newName = renameInput.value.trim();
            if (!newName) { alert('プロジェクト名を入力してください'); return; }
            row['タイトル']   = newName;
            row['更新日時']   = formatJpDatetime(new Date());
            persistLocalCache();
            renderProjectAdmin2();
        });
        tdRename.append(renameInput, renameBtn);
        tr.appendChild(tdRename);

        // 統合（このプロジェクトを他のプロジェクトへ統合し、自身は統合先の子に降格する）
        const tdMerge = document.createElement('td');
        const mergeSelect = document.createElement('select');
        const blankOpt = document.createElement('option');
        blankOpt.value = '';
        blankOpt.textContent = '（統合先を選択）';
        mergeSelect.appendChild(blankOpt);
        projects.filter(p => String(p['ID']) !== id).forEach(p => {
            const opt = document.createElement('option');
            opt.value = String(p['ID']);
            opt.textContent = p['タイトル'] || '';
            mergeSelect.appendChild(opt);
        });
        const mergeBtn = document.createElement('button');
        mergeBtn.type = 'button';
        mergeBtn.className = 'calendar-add-btn';
        mergeBtn.textContent = '統合';
        mergeBtn.addEventListener('click', () => {
            const targetId = mergeSelect.value;
            if (!targetId) { alert('統合先のプロジェクトを選択してください'); return; }
            if (!confirm(`「${row['タイトル']}」を「${mergeSelect.options[mergeSelect.selectedIndex].textContent}」へ統合します。よろしいですか？`)) return;
            mergeProject2Into(id, targetId);
        });
        tdMerge.append(mergeSelect, mergeBtn);
        tr.appendChild(tdMerge);

        // 削除
        const tdDelete = document.createElement('td');
        if (project2AdminDeletePending === id) {
            const childCount = getChildrenM(currentMainData, id).length;
            if (childCount > 0) {
                const reassignSelect = document.createElement('select');
                const unassignOpt = document.createElement('option');
                unassignOpt.value = '';
                unassignOpt.textContent = '（未割り当てにする）';
                reassignSelect.appendChild(unassignOpt);
                projects.filter(p => String(p['ID']) !== id).forEach(p => {
                    const opt = document.createElement('option');
                    opt.value = String(p['ID']);
                    opt.textContent = p['タイトル'] || '';
                    reassignSelect.appendChild(opt);
                });
                const execBtn = document.createElement('button');
                execBtn.type = 'button';
                execBtn.className = 'calendar-danger-btn';
                execBtn.textContent = '削除実行';
                execBtn.addEventListener('click', () => {
                    deleteProject2(id, reassignSelect.value || null);
                });
                const cancelBtn = document.createElement('button');
                cancelBtn.type = 'button';
                cancelBtn.className = 'calendar-add-btn';
                cancelBtn.textContent = 'キャンセル';
                cancelBtn.addEventListener('click', () => {
                    project2AdminDeletePending = null;
                    renderProjectAdmin2();
                });
                tdDelete.append(reassignSelect, execBtn, cancelBtn);
            } else {
                const execBtn = document.createElement('button');
                execBtn.type = 'button';
                execBtn.className = 'calendar-danger-btn';
                execBtn.textContent = '削除実行';
                execBtn.addEventListener('click', () => deleteProject2(id, null));
                const cancelBtn = document.createElement('button');
                cancelBtn.type = 'button';
                cancelBtn.className = 'calendar-add-btn';
                cancelBtn.textContent = 'キャンセル';
                cancelBtn.addEventListener('click', () => {
                    project2AdminDeletePending = null;
                    renderProjectAdmin2();
                });
                tdDelete.append(execBtn, cancelBtn);
            }
        } else {
            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'calendar-danger-btn';
            deleteBtn.textContent = '削除';
            deleteBtn.addEventListener('click', () => {
                project2AdminDeletePending = id;
                renderProjectAdmin2();
            });
            tdDelete.appendChild(deleteBtn);
        }
        tr.appendChild(tdDelete);

        tbody.appendChild(tr);
    });

    table.replaceChildren(thead, tbody);
}

/** sourceId のプロジェクトを targetId へ統合する。sourceの直接の子は全てtargetの子へ付け替え、source自身もtargetの子（通常タスク）に降格する。 */
function mergeProject2Into(sourceId, targetId) {
    if (wouldCreateCycleM(currentMainData, sourceId, targetId)) {
        alert('この統合は循環参照になるため実行できません。');
        return;
    }
    const ts = formatJpDatetime(new Date());
    getChildrenM(currentMainData, sourceId).forEach(child => {
        child['親ID']   = targetId;
        child['更新日時'] = ts;
    });
    const sourceRow = currentMainData.find(r => String(r['ID']) === sourceId);
    if (sourceRow) {
        sourceRow['親ID']   = targetId;
        sourceRow['更新日時'] = ts;
    }
    persistLocalCache();
    project2EditPath = [];
    renderProjectAdmin2();
}

/** projectId のプロジェクトを削除する。reassignToId指定時は直接の子をそちらへ付け替え、未指定時は子の親IDを空欄化（単独タスク化）してから削除する。 */
function deleteProject2(projectId, reassignToId) {
    const ts = formatJpDatetime(new Date());
    getChildrenM(currentMainData, projectId).forEach(child => {
        child['親ID']   = reassignToId || '';
        child['更新日時'] = ts;
    });
    currentMainData = currentMainData.filter(r => String(r['ID']) !== projectId);
    persistLocalCache();

    project2AdminDeletePending = null;
    project2EditPath = [];
    renderProjectAdmin2();
}

const PROJECT2_STANDALONE_MARK = '__standalone__'; // 階層1の「（単独タスク）」選択肢の特殊値

/** 汎用の階層プルダウン1段を container に追加する（ラベル・選択肢・現在値・changeハンドラを指定）。 */
function appendProject2DropdownRow(container, labelText, options, currentValue, onChange, extraOptionLabel) {
    const row = document.createElement('div');
    row.className = 'calendar-edit-row';
    const label = document.createElement('label');
    label.textContent = labelText;
    const select = document.createElement('select');
    const blankOpt = document.createElement('option');
    blankOpt.value = '';
    blankOpt.textContent = '（未選択）';
    select.appendChild(blankOpt);
    if (extraOptionLabel) {
        const extraOpt = document.createElement('option');
        extraOpt.value = PROJECT2_STANDALONE_MARK;
        extraOpt.textContent = extraOptionLabel;
        select.appendChild(extraOpt);
    }
    options.forEach(r => {
        const opt = document.createElement('option');
        opt.value = String(r['ID']);
        opt.textContent = r['タイトル'] || '';
        select.appendChild(opt);
    });
    select.value = currentValue || '';
    select.addEventListener('change', () => onChange(select.value));
    row.append(label, select);
    container.appendChild(row);
}

/** 「プロジェクト編集」左側の階層プルダウン（必要な階層数だけ）を描画する。選択変更のたびにpathを再構築して再描画する。 */
function renderProject2EditDropdowns() {
    const container = document.getElementById('project2-edit-dropdowns');
    if (!container) return;
    container.innerHTML = '';

    const projectRows = getProject2ParentRows();
    const projectIds  = new Set(projectRows.map(r => String(r['ID'])));
    const rootId = project2EditPath[0] || null;
    const rootIsStandalone = !!rootId && !projectIds.has(rootId);

    // 階層1: 既存プロジェクト一覧 ＋「（単独タスク）」
    appendProject2DropdownRow(
        container, '階層1', projectRows,
        rootIsStandalone ? PROJECT2_STANDALONE_MARK : (rootId || ''),
        value => {
            if (value === PROJECT2_STANDALONE_MARK) {
                project2EditPath = [];
                project2Level0Mode = 'standalone';
            } else {
                project2EditPath = value ? buildProject2PathFromId(value) : [];
                project2Level0Mode = '';
            }
            renderProjectAdmin2();
        },
        '（単独タスク）'
    );

    if (rootIsStandalone || (!rootId && project2Level0Mode === 'standalone')) {
        // 階層2: 単独タスク一覧
        appendProject2DropdownRow(
            container, '階層2', getProject2StandaloneTaskRows(), rootId || '',
            value => {
                project2EditPath = value ? buildProject2PathFromId(value) : [];
                project2Level0Mode = 'standalone';
                renderProjectAdmin2();
            }
        );
        return; // 単独タスクは子を持たないため、これ以上下の階層は無い
    }

    if (!rootId) return; // 何も選択されていなければここで終了

    // 階層2以降: 選択中の行の子を辿っていく
    let level = 1;
    let options = getChildrenM(currentMainData, rootId);
    while (options.length > 0) {
        const currentValue = project2EditPath[level] || '';
        appendProject2DropdownRow(container, `階層${level + 1}`, options, currentValue, value => {
            project2EditPath = value ? buildProject2PathFromId(value) : project2EditPath.slice(0, level);
            renderProjectAdmin2();
        });
        if (!project2EditPath[level]) break;
        options = getChildrenM(currentMainData, project2EditPath[level]);
        level++;
    }
}

/** 「下階層の一覧」を描画する。何も選択されていなければ最上位プロジェクト一覧（単独タスクモード時は単独タスク一覧）、選択中なら現在選択中の行の直接の子一覧を表示する。行クリックでその行を選択する。 */
function renderProject2EditChildList() {
    const table = document.getElementById('project2-browser-child-table');
    if (!table) return;

    const selectedId = project2EditPath[project2EditPath.length - 1] || null;
    let rows;
    if (selectedId) {
        rows = getChildrenM(currentMainData, selectedId);
    } else if (project2Level0Mode === 'standalone') {
        rows = getProject2StandaloneTaskRows();
    } else {
        rows = getProject2ParentRows();
    }
    table.className = 'data-table';
    const cols = ['タイトル', 'データ区分', 'ステータス'];

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    cols.forEach(c => { const th = document.createElement('th'); th.textContent = c; hRow.appendChild(th); });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    if (rows.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan     = cols.length;
        td.className   = 'empty-cell';
        td.textContent = '該当するものがありません';
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        rows.forEach(row => {
            const tr = document.createElement('tr');
            if (String(row['ID']) === selectedId) tr.classList.add('selected-row');
            cols.forEach(col => { const td = document.createElement('td'); td.textContent = row[col] ?? ''; tr.appendChild(td); });
            tr.addEventListener('click', () => {
                project2EditPath = buildProject2PathFromId(row['ID']);
                renderProjectAdmin2();
            });
            tbody.appendChild(tr);
        });
    }

    table.replaceChildren(thead, tbody);
}

/** projtask2-kubun の選択値に応じて projtask2-status の選択肢を切り替える。 */
function populateProject2StatusSelect() {
    const kubun = document.getElementById('projtask2-kubun')?.value || 'タスク';
    const statuses = [...new Set(
        currentMasterData.filter(r => r['(M)ステータス_親'] === kubun)
            .map(r => r['(M)ステータス_子']).filter(Boolean)
    )];
    rebuildSelectById('projtask2-status', statuses);
}

/** 新規登録モード（何も選択されていない）の際、編集フォームを既定値へリセットする。親IDは空欄（最上位）にする。 */
function clearProject2TaskEditForm() {
    ['projtask2-id', 'projtask2-title', 'projtask2-content', 'projtask2-biko'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    document.getElementById('projtask2-kubun').value = 'タスク';
    populateProject2StatusSelect();
    document.getElementById('projtask2-status').value   = '未着手';
    document.getElementById('projtask2-priority').value = '中';
    const categoryEl = document.getElementById('projtask2-category');
    if (categoryEl && currentCategory !== 'すべて') categoryEl.value = currentCategory;
    document.getElementById('projtask2-tag').value = '';
    ['start-date', 'start-hour', 'start-minute', 'end-date', 'end-hour', 'end-minute', 'complete-date'].forEach(f => {
        const el = document.getElementById(`projtask2-${f}`);
        if (el) el.value = '';
    });
    document.getElementById('projtask2-estimate').value = '';
    document.getElementById('projtask2-actual').value   = '';
    document.getElementById('projtask2-parent-search').value = '';
    document.getElementById('projtask2-parent-id').value     = '';
}

/** 現在選択中の行（左のプルダウン／一覧で選んだ行）の編集フォームを描画する。何も選択されていなければ新規登録モード。 */
function renderProject2TaskEdit() {
    const selectedId = project2EditPath[project2EditPath.length - 1] || null;

    rebuildSelectById('projtask2-kubun', ['タスク', 'ナレッジ']);
    const kubunEl = document.getElementById('projtask2-kubun');
    if (kubunEl && !kubunEl.dataset.listenerAttached) {
        kubunEl.addEventListener('change', populateProject2StatusSelect);
        kubunEl.dataset.listenerAttached = 'true';
    }
    rebuildSelectById('projtask2-priority', [...new Set(currentMasterData.map(r => r['(M)優先度']).filter(Boolean))]);
    rebuildSelectById('projtask2-category', [...new Set(currentMasterData.map(r => r['(M)カテゴリ']).filter(Boolean))]);
    rebuildSelectById('projtask2-tag',      getFilteredTags());
    renderParentDatalist('projtask2', selectedId);
    populateProject2StatusSelect();

    const row = currentMainData.find(r => String(r['ID']) === selectedId);
    if (!row) {
        clearProject2TaskEditForm();
        return;
    }

    document.getElementById('projtask2-id').value    = row['ID'];
    document.getElementById('projtask2-kubun').value = row['データ区分'] || 'タスク';
    populateProject2StatusSelect();
    document.getElementById('projtask2-title').value    = row['タイトル'] || '';
    document.getElementById('projtask2-content').value  = row['内容'] || '';
    document.getElementById('projtask2-biko').value     = row['備考'] || '';
    document.getElementById('projtask2-status').value   = row['ステータス'] || '';
    document.getElementById('projtask2-priority').value = row['優先度'] || '';
    document.getElementById('projtask2-category').value = row['カテゴリ'] || '';
    document.getElementById('projtask2-tag').value      = row['タグ'] || '';
    setParentFieldDisplay('projtask2', row);
    writeTaskDateTimeFieldsToForm('projtask2', row);
    writeTaskEstimateActualToForm('projtask2', row);
}

/** 「新プロジェクト」タブ全体（管理表・階層プルダウン・子一覧・編集フォーム）を再描画する。 */
function renderProjectAdmin2() {
    renderProject2AdminTable();
    renderProject2EditDropdowns();
    renderProject2EditChildList();
    renderProject2SiblingMoveSection();
    renderProject2TaskEdit();
}

/**
 * 選択中の行と同じ親を持つ他の行（兄弟）を、選択中の行自身を除いて返す。
 * 選択中の行が最上位プロジェクトなら他の最上位プロジェクトを、単独タスクなら他の単独タスクを兄弟として扱う。
 */
function getProject2SiblingRows() {
    const selectedId = project2EditPath[project2EditPath.length - 1] || null;
    if (!selectedId) return [];
    const row = currentMainData.find(r => String(r['ID']) === selectedId);
    if (!row) return [];
    const parentId = row['親ID'] || '';
    let siblings;
    if (parentId) {
        siblings = getChildrenM(currentMainData, parentId);
    } else {
        siblings = isParentRowM(currentMainData, selectedId) ? getProject2ParentRows() : getProject2StandaloneTaskRows();
    }
    return siblings.filter(r => String(r['ID']) !== selectedId);
}

/** チェックボックス付きの兄弟行一覧テーブルを描画する。何も選択されていなければ空欄で「行を選択してください」を表示する。 */
function renderProject2SiblingMoveSection() {
    const table = document.getElementById('project2-sibling-table');
    if (!table) return;

    const selectedId = project2EditPath[project2EditPath.length - 1] || null;
    if (selectedId !== project2SiblingSelectionForId) {
        project2SiblingSelectedIds.clear();
        project2SiblingSelectionForId = selectedId;
    }
    const rows = getProject2SiblingRows();
    table.className = 'data-table';
    const cols = ['タイトル', 'データ区分', 'ステータス'];

    const thead   = document.createElement('thead');
    const hRow    = document.createElement('tr');
    const thCheck = document.createElement('th');
    thCheck.style.width = '36px';
    const checkAll = document.createElement('input');
    checkAll.type  = 'checkbox';
    checkAll.title = '表示中を全選択';
    checkAll.checked = rows.length > 0 && rows.every(r => project2SiblingSelectedIds.has(String(r['ID'])));
    checkAll.addEventListener('change', e => {
        rows.forEach(r => {
            const id = String(r['ID']);
            if (e.target.checked) project2SiblingSelectedIds.add(id); else project2SiblingSelectedIds.delete(id);
        });
        renderProject2SiblingMoveSection();
    });
    thCheck.appendChild(checkAll);
    hRow.appendChild(thCheck);
    cols.forEach(col => { const th = document.createElement('th'); th.textContent = col; hRow.appendChild(th); });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    if (!selectedId) {
        // 何も選択されていない場合は空欄のまま（案内文言は表示しない）
    } else if (rows.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan     = cols.length + 1;
        td.className   = 'empty-cell';
        td.textContent = '兄弟にあたる行がありません';
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        rows.forEach(row => {
            const id = String(row['ID']);
            const tr = document.createElement('tr');
            if (project2SiblingSelectedIds.has(id)) tr.classList.add('selected-row');

            const tdCheck = document.createElement('td');
            tdCheck.style.textAlign = 'center';
            const cb = document.createElement('input');
            cb.type    = 'checkbox';
            cb.checked = project2SiblingSelectedIds.has(id);
            cb.addEventListener('change', () => {
                if (cb.checked) { project2SiblingSelectedIds.add(id);    tr.classList.add('selected-row'); }
                else            { project2SiblingSelectedIds.delete(id); tr.classList.remove('selected-row'); }
            });
            tdCheck.appendChild(cb);
            tr.appendChild(tdCheck);

            cols.forEach(col => { const td = document.createElement('td'); td.textContent = row[col] ?? ''; tr.appendChild(td); });
            tbody.appendChild(tr);
        });
    }

    table.replaceChildren(thead, tbody);
}

/** 「選択した兄弟をこの下へ移動」ボタン: チェック済みの全行の親IDへ、現在選択中の行のIDをまとめて設定する。 */
document.getElementById('project2-sibling-move-btn')?.addEventListener('click', () => {
    const selectedId = project2EditPath[project2EditPath.length - 1] || null;
    if (!selectedId) { alert('先に移動先となる行を選択してください'); return; }
    if (project2SiblingSelectedIds.size === 0) { alert('移動する行を選択してください'); return; }

    for (const id of project2SiblingSelectedIds) {
        if (!checkParentCycleOrAlert(id, selectedId)) return;
    }

    const ts = formatJpDatetime(new Date());
    project2SiblingSelectedIds.forEach(id => {
        const row = currentMainData.find(r => String(r['ID']) === id);
        if (row) { row['親ID'] = selectedId; row['更新日時'] = ts; }
    });
    persistLocalCache();

    const count = project2SiblingSelectedIds.size;
    project2SiblingSelectedIds.clear();
    renderProjectAdmin2();
    alert(`${count} 件を選択中の行の子として移動しました。`);
});

wireParentSearchInput('projtask2');

/** 「新規（選択中の行の子として追加）」ボタン: フォームの現在値で、左側で現在選択中の行の子として新規行を追加する。 */
document.getElementById('projtask2-new-btn')?.addEventListener('click', () => {
    const title = document.getElementById('projtask2-title').value.trim();
    if (!title) { alert('タイトルを入力してください'); return; }

    const kubun    = document.getElementById('projtask2-kubun').value || 'タスク';
    const parentId = project2EditPath[project2EditPath.length - 1] || ''; // 左側で現在選択中の行の子として追加する
    if (!checkParentCycleOrAlert(null, parentId)) return;

    const maxId = currentMainData.reduce((max, row) => {
        const id = parseInt(row['ID'], 10);
        return isNaN(id) ? max : Math.max(max, id);
    }, 0);
    const ts = formatJpDatetime(new Date());

    const entry = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
    entry['ID']        = String(maxId + 1);
    entry['データ区分'] = kubun;
    entry['タイトル']   = title;
    entry['内容']       = document.getElementById('projtask2-content').value.trim();
    entry['備考']       = document.getElementById('projtask2-biko').value.trim();
    entry['ステータス'] = document.getElementById('projtask2-status').value;
    entry['優先度']     = document.getElementById('projtask2-priority').value;
    entry['見積時間']   = document.getElementById('projtask2-estimate').value;
    entry['カテゴリ']   = document.getElementById('projtask2-category').value;
    entry['タグ']       = document.getElementById('projtask2-tag').value;
    entry['親ID']       = parentId;
    Object.assign(entry, readTaskDateTimeFieldsFromForm('projtask2'));
    entry['作成日時']   = ts;
    entry['更新日時']   = ts;

    currentMainData.push(entry);
    persistLocalCache();

    project2EditPath = buildProject2PathFromId(entry['ID']); // 作成した子へドリルダウンし、続けて編集できるようにする
    renderProjectAdmin2();
});

/** 「適用」ボタン: 現在選択中の行へフォーム内容を書き戻す。親IDは循環参照チェックを通過した場合のみ保存する。 */
document.getElementById('projtask2-apply-btn')?.addEventListener('click', () => {
    const selectedId = project2EditPath[project2EditPath.length - 1] || null;
    if (!selectedId) return;
    const row = currentMainData.find(r => String(r['ID']) === selectedId);
    if (!row) return;

    const parentId = document.getElementById('projtask2-parent-id').value || '';
    if (!checkParentCycleOrAlert(row['ID'], parentId)) return;

    row['データ区分'] = document.getElementById('projtask2-kubun').value || row['データ区分'];
    row['タイトル']   = document.getElementById('projtask2-title').value.trim();
    row['内容']       = document.getElementById('projtask2-content').value.trim();
    row['備考']       = document.getElementById('projtask2-biko').value.trim();
    row['ステータス'] = document.getElementById('projtask2-status').value;
    row['優先度']     = document.getElementById('projtask2-priority').value;
    row['見積時間']   = document.getElementById('projtask2-estimate').value;
    row['カテゴリ']   = document.getElementById('projtask2-category').value;
    row['タグ']       = document.getElementById('projtask2-tag').value;
    row['親ID']       = parentId;
    Object.assign(row, readTaskDateTimeFieldsFromForm('projtask2'));
    row['更新日時'] = formatJpDatetime(new Date());

    persistLocalCache();
    project2EditPath = buildProject2PathFromId(row['ID']); // 親IDを変更した場合に備え、実データを基準にpathを再構築する
    renderProjectAdmin2();
});

/** 「削除」ボタン: 現在選択中の行を削除する。この行を親IDとして参照していた行は親ID欄を空欄化する。削除後は1階層上へ戻る。 */
document.getElementById('projtask2-delete-btn')?.addEventListener('click', () => {
    const selectedId = project2EditPath[project2EditPath.length - 1] || null;
    if (!selectedId) return;
    if (!confirm('この行を削除しますか？')) return;

    currentMainData.forEach(r => { if (String(r['親ID'] || '') === selectedId) r['親ID'] = ''; });
    currentMainData = currentMainData.filter(r => String(r['ID']) !== selectedId);
    persistLocalCache();

    project2EditPath = project2EditPath.slice(0, -1);
    renderProjectAdmin2();
});

/**
 * 「上階層を挿入」ボタン: 選択中の行の現在の親を引き継いだ新しい行を作成し、
 * 選択中の行の親をその新しい行へ付け替える（階層を1段挿入する）。
 * 例: 「1」の子「2」を選択中に実行すると、「1」の子として新規行「2'」ができ、「2」は「2'」の子（実質「3」階層）になる。
 */
document.getElementById('projtask2-insert-parent-btn')?.addEventListener('click', () => {
    const selectedId = project2EditPath[project2EditPath.length - 1] || null;
    if (!selectedId) { alert('挿入対象の行を選択してください'); return; }

    const name = (prompt('新しい階層のタイトルを入力してください') || '').trim();
    if (!name) return;

    const selectedRow = currentMainData.find(r => String(r['ID']) === selectedId);
    if (!selectedRow) return;
    const originalParentId = selectedRow['親ID'] || '';

    const maxId = currentMainData.reduce((max, row) => {
        const id = parseInt(row['ID'], 10);
        return isNaN(id) ? max : Math.max(max, id);
    }, 0);
    const ts = formatJpDatetime(new Date());

    const newRow = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
    newRow['ID']        = String(maxId + 1);
    newRow['データ区分'] = 'タスク';
    newRow['タイトル']   = name;
    newRow['カテゴリ']   = selectedRow['カテゴリ'] || '';
    newRow['ステータス'] = '未着手';
    newRow['優先度']     = '中';
    newRow['親ID']       = originalParentId;
    newRow['作成日時']   = ts;
    newRow['更新日時']   = ts;

    currentMainData.push(newRow);
    selectedRow['親ID']     = newRow['ID'];
    selectedRow['更新日時'] = ts;
    persistLocalCache();

    project2EditPath = buildProject2PathFromId(selectedRow['ID']);
    renderProjectAdmin2();
});

/**
 * 「新規プロジェクト登録」ボタン: 現在フォームに入力されている内容で新規プロジェクト（親ID空欄のタスク）を作成する。
 * 空のプロジェクトは階層1の一覧に出てこない（子が無いと「プロジェクト」として認識されないため）ので、
 * 同時に子タスクを1件自動生成して紐づけ、作成直後から一覧に表示・編集できるようにする。
 */
document.getElementById('projtask2-new-project-btn')?.addEventListener('click', () => {
    const title = document.getElementById('projtask2-title').value.trim();
    if (!title) { alert('タイトルを入力してください'); return; }

    const maxId = currentMainData.reduce((max, row) => {
        const id = parseInt(row['ID'], 10);
        return isNaN(id) ? max : Math.max(max, id);
    }, 0);
    const ts = formatJpDatetime(new Date());

    const category = document.getElementById('projtask2-category').value;

    const project = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
    project['ID']        = String(maxId + 1);
    project['データ区分'] = 'タスク'; // プロジェクト（親）になれるのはタスクのみ
    project['タイトル']   = title;
    project['内容']       = document.getElementById('projtask2-content').value.trim();
    project['備考']       = document.getElementById('projtask2-biko').value.trim();
    project['ステータス'] = document.getElementById('projtask2-status').value;
    project['優先度']     = document.getElementById('projtask2-priority').value;
    project['見積時間']   = document.getElementById('projtask2-estimate').value;
    project['カテゴリ']   = category;
    project['タグ']       = document.getElementById('projtask2-tag').value;
    project['親ID']       = ''; // 新規プロジェクトは常に最上位（ルート）
    Object.assign(project, readTaskDateTimeFieldsFromForm('projtask2'));
    project['作成日時']   = ts;
    project['更新日時']   = ts;

    const child = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
    child['ID']        = String(maxId + 2);
    child['データ区分'] = 'タスク';
    child['タイトル']   = '新規タスク';
    child['ステータス'] = '未着手';
    child['優先度']     = '中';
    child['カテゴリ']   = category;
    child['親ID']       = project['ID'];
    child['作成日時']   = ts;
    child['更新日時']   = ts;

    currentMainData.push(project, child);
    persistLocalCache();

    project2EditPath = buildProject2PathFromId(project['ID']);
    renderProjectAdmin2();
});

