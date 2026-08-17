import { loadToken, saveToken, loadCache, saveCache } from './modules/storage.js';
import { fetchFile, saveFile } from './modules/github.js';
import { parseMarkdown, stringifyMarkdown, MAIN_DATA_COLUMNS, MASTER_DATA_COLUMNS } from './modules/dataModel.js';
import { mergeMainData } from './modules/merge.js';
import { exportToExcel, importFromExcel } from './modules/excel.js';
import {
    generateChildManually, matchesSchedule,
    buildChildChartData, formatRecurringFrequencyLabel,
    parseChildTemplates, stringifyChildTemplates
} from './modules/recurring.js';
import { parseExceptions, stringifyExceptions, computeMonthCalendar, computeMonthStats, getDefaultType } from './modules/workCalendar.js';
import {
    parseJpDatetime, formatJpDatetime, parseTimestampLog, formatDuration, isLogRunning,
    computeTotalDuration as computeTotalDurationM,
    filterMainDataByCategory, filterTagsByCategory, computeActualHours,
    getChildren as getChildrenM, isParentRow as isParentRowM, getParentRow as getParentRowM,
    wouldCreateCycle as wouldCreateCycleM, getAllParentCandidates as getAllParentCandidatesM,
    getRootParentId as getRootParentIdM, isEligibleParentRow as isEligibleParentRowM,
    isRecurringParentRow, isRecurringChildRow
} from './modules/task.js';
import {
    DAYPLAN_KUBUN, DAYPLAN_PARA, isDayPlanRow, isTaskDoneForCalendar, getCalendarMarkDate,
    getTasksForDate as getTasksForDateM, getDayPlanTask as getDayPlanTaskM, parseDayPlanContent,
    countActiveTasksByField as countActiveTasksByFieldM, countTasksByField as countTasksByFieldM,
    sortByTotalCountDesc as sortByTotalCountDescM, calendarTaskListStatusRank, compareDateAscEmptyLast,
    extractTimeOnDate, assignCalendarColumns, DAYPLAN_COLUMN_COUNT, getCalendarStatusClass, getPriorityDotClass,
    computeDayPlanTimeSlot, getTaskScheduledTimeOnDate,
    getUnsetAttributeGroups as getUnsetAttributeGroupsM,
    getSuspendedTasks as getSuspendedTasksM, getTasksByStatus as getTasksByStatusM, taskOrganizeStatusRank,
    sortDayPlanBlocks, stringifyDayPlanBlocks, placeDayPlanBlock
} from './modules/calendar.js';
import {
    getAllKnownColumns as getAllKnownColumnsM, computeMasterWarnings as computeMasterWarningsM,
    createEmptyMasterRow as createEmptyMasterRowM
} from './modules/master.js';
import {
    RECIPE_SECTIONS, isRecipeRow, isPermanentRecipe, parseRecipeContent, buildRecipeContent,
    parseIngredientText, buildIngredientText, scaleIngredientRows, parseStepList, buildStepList
} from './modules/recipe.js';
import {
    isBookRow, isQaCardRow, isChapterRow, getChapters, getQaCards, getQaParaMarker, shuffleArray
} from './modules/reading.js';
import { findBacklinks } from './modules/zettel.js';

const OWNER = 'palmelo2nd';
const REPO  = 'brain_data';
const PATH  = 'brain/data.md';

const CODE_REPO    = 'brain';        // アプリ本体・README.mdが置かれているコードリポジトリ
const README_PATH  = 'brain/README.md';

// ===== グローバル状態 =====
let currentSha        = null;
let currentMainData   = [];
let currentMasterData = [];
let lastSyncedMarkdown = null;   // 直近でGitHub/キャッシュと一致している状態のMarkdown（未保存差分の判定基準）
let currentCategory   = 'すべて';        // カテゴリフィルタの選択値
let categoryInitialized = false;         // 初回ロード時にデフォルトカテゴリを設定済みか
let selectedRunTaskId    = null;       // タスク実行で選択中のタスクID
let runnerParentPath     = [];         // タスク実行の属性編集パネルの親（プロジェクト）階層プルダウンで選択中のID列（ルート→現在選択中の階層の順）
let timerIsRunning       = false;      // タイマー動作中フラグ
let timerInterval        = null;       // setInterval ハンドル
let summaryView          = 'taskorg2';  // Summary ページの表示ビュー（'top' | 'taskorg2' | 'edit2' | 'knowledge'）
let workCalendarYear  = new Date().getFullYear();
let workCalendarMonth = new Date().getMonth();

// ===== 新方式（親ID）タブ用の状態 =====
// タグ／ステータス／プロジェクト（最上位の親ID）は複数選択、その他フィルタ（プロジェクト行・繰返し親タスク・繰返し子タスクの表示）は表示ON/OFFの単純なチェックボックス。
let taskorg2Filters = {
    tag: new Set(), status: new Set(), project: new Set(),
    showProject: false, showRecurringParent: false, showRecurringChild: true,
};
const taskorg2FilterKnownOptions = { tag: new Set(), status: new Set(), project: new Set() };
let taskorg2ProjectDrilldownPath = []; // 新タスク整理・プロジェクトフィルタ下のPJ(n層)ドリルダウンで選択中のID列（ルート→現在選択中の階層の順）
let selectedTaskorg2Id = null;      // 新タスク整理で選択中の行ID
let taskorg2QuickNewMode = false;   // true時: 「新規登録」ボタンから起動した新規登録モード（日付は空欄のまま）
const dayedit2Freq = { month: new Set(), day: new Set(), weekday: new Set() }; // 新タスク整理・編集パネルの頻度チップの選択状態
let dayedit2Templates = []; // 新タスク整理・編集パネルの実行タスクテンプレート編集状態（繰返しテンプレートのみ。Array<{startOffsetDays, endOffsetDays, titleSuffix, content}>）
let taskorg2CalendarYear  = new Date().getFullYear(); // 新タスク整理のカレンダー表示年（旧タスク整理とは独立）
let taskorg2CalendarMonth = new Date().getMonth();    // 新タスク整理のカレンダー表示月（0始まり、旧タスク整理とは独立）
let selectedTaskorg2Date  = jpDateOnly(formatJpDatetime(new Date())); // 新タスク整理でカレンダーの日クリックにより選択中の日付（YYYY/MM/DD）。開いた時点では常に今日を選択する
let taskorg2GanttViewUnit = 'day';  // 新タスク整理のガントチャートの列の単位（'day' | 'week'、旧タスク整理とは独立）
let taskorg2HabitUnit = 'week';     // 「習慣」タブの表示単位（'week' | 'month' | 'daily'）
let taskorg2View = 'calendar';      // 新タスク整理の表示ビュー（'calendar' | 'gantt' | 'weekboard' | 'workcal' | 'project'、旧タスク整理とは独立）
const taskorg2ProjectManualStateIds = new Map(); // 「プロジェクト」ツリービューでユーザーが手動で開閉した行ID→折りたたみ中か（true=折りたたみ）。既定は「完了」の親のみ折りたたみ
let dayedit2ParentPath = [];        // 新タスク整理・編集フォームの親（プロジェクト）階層プルダウンで選択中のID列（ルート→現在選択中の階層の順）
let taskorg2BulkPjPath = [];        // タスク整理「PJ一括編集」の階層プルダウンで選択中のID列（個別編集フォームのdayedit2ParentPathとは独立）
let selectedEdit2Ids = new Set();   // 新編集で選択中の行ID
let selectedRecipeId = null;        // 料理ビューアで選択中のレシピ行ID
let recipeMode = 'input';           // 料理ビューアの表示モード（'input' | 'practice'）
let recipeIngredientRows = [];      // 入力モードで編集中の材料行配列（{ name, qty, unit, note }[]）
let recipePrepRows = [];            // 入力モードで編集中の前処理・手順配列（string[]）
let recipeStepsRows = [];           // 入力モードで編集中の作り方・手順配列（string[]）
let recipePracticeSelectedIds = new Set(); // 実践モードで選択中の永久保存レシピID群
let recipePracticeLayout = 'tabs';  // 実践モードの表示レイアウト（'tabs' | 'grid'）
let recipePracticeActiveId = null;  // 実践モード・タブ切替時に表示中のレシピID
let recipePracticeServings = {};    // 実践モードでのレシピID→表示用目標人数の上書き値
let knowledgeViewer  = null;        // ナレッジタブ「専用ビューア」で開いているビューア（null | 'recipe' | 'reading'）
let selectedKnowledgeId = null;     // ナレッジタブで選択中の行ID（[[ID]]リンク・バックリンク表示の対象）
let selectedBookId    = null;       // 読書ビューアで選択中の本ID
let selectedChapterId = null;       // 読書ビューアで選択中の章メモID
let readingQuizCards      = [];     // 暗記モード中の出題カード配列（シャッフル済み）
let readingQuizIndex      = 0;      // 暗記モード中の現在の出題インデックス
let readingQuizShowAnswer = false;  // 暗記モード中、答えを表示中かどうか
let selectedQaId = null;            // 読書ビューアで選択中のQAカードID
let edit2Filters = {};              // 新編集のフィルタ値
let edit2Kubun   = 'INBOX';         // 新編集の対象データ区分
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

/** 現在入力中のトークンをlocalStorageに保存する（空欄時は何もしない＝誤って既存の保存値を消さない）。 */
function persistCurrentToken() {
    const token = getTokenValue();
    if (token) saveToken(token);
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

const SUMMARY_VIEWS = ['taskorg2', 'top', 'edit2', 'knowledge', 'info'];

/** Summary ページ（INBOX／タスク管理／データ編集／ナレッジの表示切り替え。タスク実行・繰返し・勤務はタスク管理タブ内、メインデータ・マスタデータ一覧はデータ編集タブ内のExpanderに常駐。PW・Load〜Import・カテゴリは常時表示バーで共通）を描画する */
function renderSummary() {
    // 選択中のビューに応じて、セクション本体をこのページへ移動する
    if (summaryView === 'taskorg2')  mountSection('taskorg2-details',  'taskorg2-anchor-summary');
    if (summaryView === 'edit2')     mountSection('edit2-group',       'edit2-anchor-summary');
    // データ（data-group）はデータ編集タブ下部のExpanderに常駐させる（データタブは廃止済み）
    if (summaryView === 'edit2') mountSection('data-group', 'edit2-data-anchor');

    renderCategoryFilter(); // 常時表示バーのカテゴリ選択を最新化
    renderWarnings(computeMasterWarnings());
    renderInboxBadge();
    renderInboxKubunSelect();
    renderTaskRunner();
    if (summaryView === 'taskorg2')  renderCalendar2();
    if (summaryView === 'edit2')     renderEdit2();
    if (summaryView === 'knowledge') { renderKnowledgeList(); renderKnowledgeDetail(); renderKnowledgeViewers(); }
    // データ編集タブ下部に埋め込んだメインデータ・マスタデータ一覧も、データ編集と合わせて再描画する
    if (summaryView === 'edit2') {
        renderDataTable('table-main',   'summary-main',   getFilteredMainData(),   MAIN_DATA_COLUMNS,   'メインデータ',   { editable: true, idColumn: 'ID' });
        renderDataTable('table-master', 'summary-master', currentMasterData, MASTER_DATA_COLUMNS, 'マスタデータ', { editable: true, onEdit: () => { renderWarnings(computeMasterWarnings()); renderProject2AdminTable(); } });
    }
    // 「プロジェクト管理」表は、パフォーマンスのためExpanderが開いている時のみ再描画する
    // （閉じている間の操作では再描画しない。開いた瞬間はtoggleイベント側で描画）
    if (summaryView === 'taskorg2') {
        if (document.getElementById('taskorg2-project-admin-table-toggle')?.open) renderProject2AdminTable();
    }

    SUMMARY_VIEWS.forEach(view => {
        document.getElementById(`summary-tab-${view}`)?.classList.toggle('taskorg-view-btn--active', summaryView === view);
        const panel = document.getElementById(`summary-view-${view}`);
        if (panel) panel.style.display = summaryView === view ? '' : 'none';
    });
}

SUMMARY_VIEWS.forEach(view => {
    document.getElementById(`summary-tab-${view}`)?.addEventListener('click', () => { summaryView = view; renderSummary(); });
});

// ===== Info：コードリポジトリのREADME.md（アプリ概要）を取得しMarkdownとして表示 =====
async function loadInfoReadme() {
    const el = document.getElementById('info-content');
    const token = getTokenValue();
    if (!token) { el.textContent = 'トークンを入力してください。'; return; }

    el.textContent = '読み込み中...';

    try {
        const { content } = await fetchFile(token, OWNER, CODE_REPO, README_PATH);
        el.innerHTML = window.marked.parse(content);
    } catch (error) {
        console.error(error);
        el.textContent = `読み込みに失敗しました: ${error.message}`;
    }
}

// Infoタブを開いたとき、トークンが入力済みなら自動的に読み込む
document.getElementById('summary-tab-info')?.addEventListener('click', () => {
    if (getTokenValue()) loadInfoReadme();
});

document.getElementById('info-reload-btn')?.addEventListener('click', loadInfoReadme);

/** INBOX のカテゴリバッジ（サイドバー／Summary 両方）を更新する */
function renderInboxBadge() {
    const text = currentCategory === 'すべて'
        ? 'カテゴリ: 未設定（「すべて」選択中）'
        : `カテゴリ: ${currentCategory}`;
    document.querySelectorAll('.js-inbox-badge').forEach(badge => { badge.textContent = text; });
}

/** INBOXフォームの「データ区分」セレクトを、選択中の値を維持したままマスタの選択肢で再構築する（未選択時は既定でINBOXにする）。 */
function renderInboxKubunSelect() {
    const options = [...new Set(currentMasterData.map(r => r['(M)データ区分']).filter(Boolean))];
    document.querySelectorAll('.js-inbox-kubun').forEach(sel => {
        const prev = sel.value;
        populateSelectOptions(sel, options, '（選択してください）');
        sel.value = options.includes(prev) ? prev : (options.includes('INBOX') ? 'INBOX' : '');
    });
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

// ===== [削除済み: 旧プロジェクト管理／プロジェクト編集Expander] =====
// 旧プロジェクトタブ（プロジェクト一覧・紐づくタスク一覧／名前変更・削除・統合）は
// 新プロジェクトタブ（親ID方式、renderProject2AdminTable 系）へ置き換え、
// その後「プロジェクト編集」Expander（階層ブラウザ・新規登録・階層移動）自体も削除し、
// 「プロジェクト管理」表（renderProject2AdminTable）のみが残っている。


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

    // 旧形式の繰返し子タスク（繰返し親ID列で繰返しテンプレートを参照）が残っていれば、
    // 親ID方式（親ID=繰返しテンプレートのID）へ自動変換する。繰返し識別子は親（テンプレート）側にのみ残す。
    currentMainData.forEach(r => {
        if (r['繰返し親ID']) {
            r['親ID'] = r['繰返し親ID'];
            r['繰返し識別子'] = '';
        }
        delete r['繰返し親ID'];
    });

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
        persistCurrentToken();
        saveToGithub(token);
    });
});

// ===== 自動保存（1分ごと。変更がある場合のみGitHubへ保存し、変更が無ければ何もしない） =====
const AUTO_SAVE_INTERVAL_MS = 1 * 60 * 1000;
setInterval(() => {
    const token = getTokenValue();
    if (!token || !currentSha) return; // 未読み込み・未認証時は自動保存の対象外
    saveToGithub(token, true);
}, AUTO_SAVE_INTERVAL_MS);

// ===== Excelエクスポート =====
document.querySelectorAll('.js-excel-export-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        persistCurrentToken();
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
        persistCurrentToken();
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
        const form     = btn.closest('.inbox-form');
        const textarea = form.querySelector('.js-inbox-content');
        const content  = textarea.value.trim();
        if (!content) { textarea.focus(); return; }
        const kubun = form.querySelector('.js-inbox-kubun')?.value || 'INBOX';

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

        // 全カラムを空文字で初期化してから必要な値だけ設定（データ区分がタスク／ナレッジでも、タイトル・内容以外は空欄のまま生成する）
        const entry = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
        entry['ID']        = String(maxId + 1);
        entry['データ区分'] = kubun;
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

/** 「ナレッジ」タブ: データ区分=ナレッジの行（1日タスクの器行を除く）を更新日時の新しい順に一覧表示する（一覧表示のみ、行クリックは無反応）。 */
function renderKnowledgeList() {
    const container = document.getElementById('knowledge-list-summary');
    if (!container) return;
    container.innerHTML = '';

    const rows = getFilteredMainData()
        .filter(r => r['データ区分'] === 'ナレッジ' && !isDayPlanRow(r))
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
            const id = String(row['ID']);
            if (id === selectedKnowledgeId) tr.classList.add('selected-row');
            tr.addEventListener('click', () => selectKnowledgeNote(id));
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

/** ナレッジタブ: 詳細パネルに表示する行を切り替え、一覧・詳細を再描画する。 */
function selectKnowledgeNote(id) {
    selectedKnowledgeId = id;
    renderKnowledgeList();
    renderKnowledgeDetail();
}

/**
 * ナレッジタブ「詳細パネル」を描画する。
 * 選択中の行の基本情報・所属プロジェクト（親ID）・本文中の[[ID]]リンク・バックリンクを表示する。
 * リンク先は選択中行がナレッジ以外（タスク等）でも currentMainData から検索して表示する。
 */
function renderKnowledgeDetail() {
    const container = document.getElementById('knowledge-detail-summary');
    if (!container) return;
    container.innerHTML = '';

    const row = currentMainData.find(r => String(r['ID']) === selectedKnowledgeId);
    if (!row) {
        const empty = document.createElement('p');
        empty.className = 'triage-info';
        empty.textContent = 'ノートを選択してください';
        container.appendChild(empty);
        return;
    }

    const form = document.createElement('div');
    form.className = 'triage-form';

    const infoRow = document.createElement('div');
    infoRow.className = 'triage-form-row';
    const infoLabel = document.createElement('label');
    infoLabel.textContent = '基本情報';
    const info = document.createElement('span');
    info.className = 'triage-info';
    info.textContent = [row['タイトル'] || '（無題）', row['ステータス'], row['カテゴリ'], row['タグ'], row['PARA区分']]
        .filter(Boolean).join(' / ');
    infoRow.append(infoLabel, info);
    form.appendChild(infoRow);

    // 所属プロジェクト（親ID）
    const parentId = row['親ID'];
    if (parentId) {
        const parentRow = currentMainData.find(r => String(r['ID']) === String(parentId));
        const projRow = document.createElement('div');
        projRow.className = 'triage-form-row';
        const projLabel = document.createElement('label');
        projLabel.textContent = '所属プロジェクト';
        const projInfo = document.createElement('span');
        projInfo.className = 'triage-info';
        projInfo.textContent = parentRow ? (parentRow['タイトル'] || '（無題）') : `不明な親 #${parentId}`;
        projRow.append(projLabel, projInfo);
        form.appendChild(projRow);
    }

    // 本文（内容＋備考）。[[ID]]をクリック可能なリンクチップに変換する。
    const bodyRow = document.createElement('div');
    bodyRow.className = 'triage-form-row triage-form-row--top';
    const bodyLabel = document.createElement('label');
    bodyLabel.textContent = '本文';
    const bodyText = document.createElement('div');
    bodyText.className = 'zettel-body';
    [row['内容'], row['備考']].filter(Boolean).forEach(text => {
        bodyText.appendChild(renderZettelText(text));
    });
    bodyRow.append(bodyLabel, bodyText);
    form.appendChild(bodyRow);

    // バックリンク（このノートを [[ID]] で参照している他の行）
    const backlinks = findBacklinks(currentMainData, row['ID']);
    const backRow = document.createElement('div');
    backRow.className = 'triage-form-row triage-form-row--top';
    const backLabel = document.createElement('label');
    backLabel.textContent = 'バックリンク';
    const backList = document.createElement('div');
    backList.className = 'zettel-body';
    if (backlinks.length === 0) {
        const none = document.createElement('span');
        none.className = 'triage-info';
        none.textContent = 'なし';
        backList.appendChild(none);
    } else {
        backlinks.forEach(r => backList.appendChild(makeZettelLinkChip(String(r['ID']), r['タイトル'] || '（無題）')));
    }
    backRow.append(backLabel, backList);
    form.appendChild(backRow);

    container.appendChild(form);
}

/** 本文中の [[ID]] をリンクチップに変換したDOM断片を返す（innerHTML不使用、テキストノード＋spanで組み立て）。 */
function renderZettelText(text) {
    const frag = document.createDocumentFragment();
    const regex = /\[\[(\d+)\]\]/g;
    let lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        const linkedId = match[1];
        const linkedRow = currentMainData.find(r => String(r['ID']) === linkedId);
        if (linkedRow) {
            frag.appendChild(makeZettelLinkChip(linkedId, linkedRow['タイトル'] || '（無題）'));
        } else {
            const missing = document.createElement('span');
            missing.className = 'zettel-missing-link';
            missing.textContent = `不明なノート #${linkedId}`;
            frag.appendChild(missing);
        }
        lastIndex = regex.lastIndex;
    }
    if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
    const wrap = document.createElement('div');
    wrap.className = 'zettel-text-block';
    wrap.appendChild(frag);
    return wrap;
}

/** クリックで対象IDのノートへ切り替えるリンクチップ要素を作る。 */
function makeZettelLinkChip(id, label) {
    const chip = document.createElement('span');
    chip.className = 'zettel-link-chip';
    chip.textContent = label;
    chip.addEventListener('click', () => selectKnowledgeNote(id));
    return chip;
}

// ===== 「料理」タブ（タグ＝料理のナレッジ行専用ビューア） =====

/** タグ＝料理のナレッジ行を更新日時の新しい順に返す（トップバーのカテゴリ絞り込みに従う）。 */
function getRecipeRows() {
    return getFilteredMainData()
        .filter(isRecipeRow)
        .sort((a, b) => (b['更新日時'] || '').localeCompare(a['更新日時'] || ''));
}

/** 「料理」タブ: カテゴリ・ステータスの<select>をマスタの選択肢で再構築する。 */
function renderRecipeSelects() {
    const categoryEl = document.getElementById('recipe-category');
    if (categoryEl) {
        const prev = categoryEl.value;
        const categories = [...new Set(currentMasterData.map(r => r['(M)カテゴリ']).filter(Boolean))];
        populateSelectOptions(categoryEl, categories, '（選択してください）');
        categoryEl.value = categories.includes(prev) ? prev : '';
    }
    const statusEl = document.getElementById('recipe-status');
    if (statusEl) {
        const prev = statusEl.value;
        const statuses = [...new Set(
            currentMasterData.filter(r => r['(M)ステータス_親'] === 'ナレッジ')
                .map(r => r['(M)ステータス_子']).filter(Boolean)
        )];
        populateSelectOptions(statusEl, statuses, '（選択してください）');
        statusEl.value = statuses.includes(prev) ? prev : '';
    }
}

/** 「料理」タブ: ステータス値に応じて、一時メモ欄／構造化フォームの表示を切り替える。 */
function updateRecipeConditionalFields(status) {
    const memoRow    = document.getElementById('recipe-memo-row');
    const structured = document.getElementById('recipe-structured-fields');
    const permanent  = status === '永久保存';
    if (memoRow)    memoRow.style.display    = permanent ? 'none' : '';
    if (structured) structured.style.display = permanent ? '' : 'none';
}

document.getElementById('recipe-status')?.addEventListener('change', (e) => {
    updateRecipeConditionalFields(e.target.value);
});

/** 「料理」タブ・入力モード: 材料の行編集テーブルを描画する。 */
function renderRecipeIngredientsTable() {
    const table = document.getElementById('recipe-ingredients-table');
    if (!table) return;

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    ['食材名', '数量', '単位', '備考', ''].forEach(text => {
        const th = document.createElement('th');
        th.textContent = text;
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    if (recipeIngredientRows.length === 0) {
        const emptyRow = document.createElement('tr');
        const emptyTd  = document.createElement('td');
        emptyTd.className = 'empty-cell';
        emptyTd.colSpan = 5;
        emptyTd.textContent = '材料がありません';
        emptyRow.appendChild(emptyTd);
        tbody.appendChild(emptyRow);
    }
    recipeIngredientRows.forEach((ingredient, index) => {
        const row = document.createElement('tr');

        [['name', '食材名'], ['qty', '数量'], ['unit', '単位'], ['note', '備考']].forEach(([field, placeholder]) => {
            const td = document.createElement('td');
            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = placeholder;
            input.value = ingredient[field] || '';
            input.addEventListener('input', () => { ingredient[field] = input.value; });
            td.appendChild(input);
            row.appendChild(td);
        });

        const removeTd = document.createElement('td');
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'triage-btn triage-btn--danger';
        removeBtn.textContent = '削除';
        removeBtn.addEventListener('click', () => {
            recipeIngredientRows.splice(index, 1);
            renderRecipeIngredientsTable();
        });
        removeTd.appendChild(removeBtn);
        row.appendChild(removeTd);

        tbody.appendChild(row);
    });

    table.replaceChildren(thead, tbody);
}

document.getElementById('recipe-ingredient-add-btn')?.addEventListener('click', () => {
    recipeIngredientRows.push({ name: '', qty: '', unit: '', note: '' });
    renderRecipeIngredientsTable();
});

/** 「料理」タブ・入力モード: 前処理／作り方など、1行1手順のテーブルを描画する汎用関数。 */
function renderRecipeStepTable(tableId, steps, rerender) {
    const table = document.getElementById(tableId);
    if (!table) return;

    const tbody = document.createElement('tbody');
    if (steps.length === 0) {
        const emptyRow = document.createElement('tr');
        const emptyTd  = document.createElement('td');
        emptyTd.className = 'empty-cell';
        emptyTd.textContent = '項目がありません';
        emptyRow.appendChild(emptyTd);
        tbody.appendChild(emptyRow);
    }
    steps.forEach((step, index) => {
        const row = document.createElement('tr');

        const td = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = `${index + 1}.`;
        input.value = step;
        input.addEventListener('input', () => { steps[index] = input.value; });
        td.appendChild(input);
        row.appendChild(td);

        const removeTd = document.createElement('td');
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'triage-btn triage-btn--danger';
        removeBtn.textContent = '削除';
        removeBtn.addEventListener('click', () => {
            steps.splice(index, 1);
            rerender();
        });
        removeTd.appendChild(removeBtn);
        row.appendChild(removeTd);

        tbody.appendChild(row);
    });

    table.replaceChildren(tbody);
}

function renderRecipePrepTable()  { renderRecipeStepTable('recipe-prep-table',  recipePrepRows,  renderRecipePrepTable); }
function renderRecipeStepsTable() { renderRecipeStepTable('recipe-steps-table', recipeStepsRows, renderRecipeStepsTable); }

document.getElementById('recipe-prep-add-btn')?.addEventListener('click', () => {
    recipePrepRows.push('');
    renderRecipePrepTable();
});

document.getElementById('recipe-steps-add-btn')?.addEventListener('click', () => {
    recipeStepsRows.push('');
    renderRecipeStepsTable();
});

/** 「料理」タブ: 一覧テーブルを描画する。行クリックで選択・フォームへ読み込む。 */
function renderRecipeList() {
    const table = document.getElementById('recipe-list-table');
    if (!table) return;

    const rows = getRecipeRows();

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    ['料理名', 'ステータス', 'カテゴリ', '更新日時'].forEach(col => {
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
        td.textContent = '該当するレシピがありません';
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        rows.forEach(row => {
            const tr = document.createElement('tr');
            const id = String(row['ID']);
            if (id === selectedRecipeId) tr.classList.add('selected-row');
            tr.addEventListener('click', () => {
                selectedRecipeId = id;
                loadRecipeForm(row);
                renderRecipeList();
            });
            [row['タイトル'] || '（無題）', row['ステータス'] || '', row['カテゴリ'] || '', row['更新日時'] || '']
                .forEach(val => {
                    const td = document.createElement('td');
                    td.textContent = val;
                    tr.appendChild(td);
                });
            tbody.appendChild(tr);
        });
    }
    table.className = 'data-table';
    table.replaceChildren(thead, tbody);
}

/** 「料理」タブ: フォームへ選択行の値を読み込む。 */
function loadRecipeForm(row) {
    document.getElementById('recipe-title').value    = row['タイトル']    || '';
    document.getElementById('recipe-category').value = row['カテゴリ']    || '';
    document.getElementById('recipe-status').value    = row['ステータス'] || '';
    updateRecipeConditionalFields(row['ステータス']);

    if (isPermanentRecipe(row)) {
        const sections = parseRecipeContent(row['内容']);
        document.getElementById('recipe-servings').value     = sections['想定人数'];
        recipeIngredientRows = parseIngredientText(sections['材料']);
        recipePrepRows       = parseStepList(sections['前処理']);
        recipeStepsRows      = parseStepList(sections['作り方']);
        document.getElementById('recipe-improvements').value = sections['改善点'];
        document.getElementById('recipe-memo').value = '';
    } else {
        document.getElementById('recipe-memo').value = row['内容'] || '';
        recipeIngredientRows = [];
        recipePrepRows       = [];
        recipeStepsRows      = [];
        ['recipe-servings', 'recipe-improvements']
            .forEach(id => { document.getElementById(id).value = ''; });
    }
    renderRecipeIngredientsTable();
    renderRecipePrepTable();
    renderRecipeStepsTable();

    updateRecipeSelectionInfo();
}

/** 「料理」タブ: フォームをクリアし、選択状態を解除する。 */
function clearRecipeForm() {
    selectedRecipeId = null;
    ['recipe-title', 'recipe-memo', 'recipe-servings', 'recipe-improvements'].forEach(id => {
        document.getElementById(id).value = '';
    });
    recipeIngredientRows = [];
    recipePrepRows       = [];
    recipeStepsRows      = [];
    renderRecipeIngredientsTable();
    renderRecipePrepTable();
    renderRecipeStepsTable();
    document.getElementById('recipe-category').value = '';
    document.getElementById('recipe-status').value = '';
    updateRecipeConditionalFields('');
    updateRecipeSelectionInfo();
}

/** 「料理」タブ: フォーム値を mainData 行へ組み立てて返す（ID・作成日時・データ区分・タグ・親IDは呼び出し側で付与）。 */
function readRecipeFormContent() {
    const status = document.getElementById('recipe-status').value;
    if (status === '永久保存') {
        return buildRecipeContent({
            '想定人数': document.getElementById('recipe-servings').value,
            '材料':     buildIngredientText(recipeIngredientRows),
            '前処理':   buildStepList(recipePrepRows),
            '作り方':   buildStepList(recipeStepsRows),
            '改善点':   document.getElementById('recipe-improvements').value,
        });
    }
    return document.getElementById('recipe-memo').value.trim();
}

/** 「料理」タブ: 選択件数・状態の表示を更新する。 */
function updateRecipeSelectionInfo() {
    const info = document.getElementById('recipe-selection-info');
    if (!info) return;
    info.textContent = selectedRecipeId ? `選択中: ID ${selectedRecipeId}` : '未選択（新規登録）';
}

document.getElementById('recipe-new-btn')?.addEventListener('click', () => {
    const title  = document.getElementById('recipe-title').value.trim();
    if (!title) { alert('料理名を入力してください'); return; }
    const status = document.getElementById('recipe-status').value;
    if (!status) { alert('ステータスを選択してください'); return; }

    const maxId = currentMainData.reduce((max, row) => {
        const id = parseInt(row['ID'], 10);
        return isNaN(id) ? max : Math.max(max, id);
    }, 0);
    const ts = formatJpDatetime(new Date());

    const entry = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
    entry['ID']        = String(maxId + 1);
    entry['データ区分'] = 'ナレッジ';
    entry['タグ']       = '料理';
    entry['タイトル']   = title;
    entry['カテゴリ']   = document.getElementById('recipe-category').value || (currentCategory === 'すべて' ? '' : currentCategory);
    entry['ステータス'] = status;
    entry['内容']       = readRecipeFormContent();
    entry['作成日時']   = ts;
    entry['更新日時']   = ts;

    currentMainData.push(entry);
    persistLocalCache();

    selectedRecipeId = entry['ID'];
    renderRecipeList();
    updateRecipeSelectionInfo();
});

document.getElementById('recipe-apply-btn')?.addEventListener('click', () => {
    if (!selectedRecipeId) { alert('更新するレシピを選択してください'); return; }
    const row = currentMainData.find(r => String(r['ID']) === selectedRecipeId);
    if (!row) return;

    const title  = document.getElementById('recipe-title').value.trim();
    if (!title) { alert('料理名を入力してください'); return; }
    const status = document.getElementById('recipe-status').value;
    if (!status) { alert('ステータスを選択してください'); return; }

    row['タイトル']   = title;
    row['カテゴリ']   = document.getElementById('recipe-category').value;
    row['ステータス'] = status;
    row['内容']       = readRecipeFormContent();
    row['更新日時']   = formatJpDatetime(new Date());

    persistLocalCache();
    renderRecipeList();
});

document.getElementById('recipe-delete-btn')?.addEventListener('click', () => {
    if (!selectedRecipeId) { alert('削除するレシピを選択してください'); return; }
    if (!confirm('選択したレシピを削除します。よろしいですか？（この操作は取り消せません）')) return;

    currentMainData = currentMainData.filter(r => String(r['ID']) !== selectedRecipeId);
    clearRecipeForm();
    persistLocalCache();
    renderRecipeList();
});

/** 「料理」タブ・実践モード: 永久保存レシピのチェックリストを描画する。 */
function renderRecipePracticeChecklist() {
    const container = document.getElementById('recipe-practice-checklist');
    if (!container) return;

    const rows = getRecipeRows().filter(isPermanentRecipe);
    // 削除済み・対象外になったレシピの選択状態を掃除する
    recipePracticeSelectedIds.forEach(id => {
        if (!rows.some(r => String(r['ID']) === id)) recipePracticeSelectedIds.delete(id);
    });

    if (rows.length === 0) {
        container.replaceChildren();
        const empty = document.createElement('div');
        empty.className = 'triage-info';
        empty.textContent = '永久保存のレシピがありません';
        container.appendChild(empty);
        return;
    }

    const fragment = document.createDocumentFragment();
    rows.forEach(row => {
        const id = String(row['ID']);
        const label = document.createElement('label');
        label.className = 'recipe-practice-checklist-item';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = recipePracticeSelectedIds.has(id);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                recipePracticeSelectedIds.add(id);
                if (!recipePracticeActiveId) recipePracticeActiveId = id;
            } else {
                recipePracticeSelectedIds.delete(id);
                if (recipePracticeActiveId === id) recipePracticeActiveId = null;
            }
            renderRecipePracticeView();
        });
        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(row['タイトル'] || '（無題）'));
        fragment.appendChild(label);
    });
    container.replaceChildren(fragment);
}

/** 「料理」タブ・実践モード: 1レシピ分の詳細カード（人数指定＋換算済み材料・手順）を組み立てる。 */
function buildRecipePracticeCard(row) {
    const id = String(row['ID']);
    const sections = parseRecipeContent(row['内容']);
    const baseServings = sections['想定人数'];
    const targetServings = recipePracticeServings[id] !== undefined ? recipePracticeServings[id] : baseServings;

    const card = document.createElement('div');
    card.className = 'recipe-practice-card';

    const heading = document.createElement('h4');
    heading.textContent = row['タイトル'] || '（無題）';
    card.appendChild(heading);

    const servingsRow = document.createElement('div');
    servingsRow.className = 'triage-form-row';
    const servingsLabel = document.createElement('label');
    servingsLabel.textContent = `人数（基準: ${baseServings || '不明'}）`;
    const servingsInput = document.createElement('input');
    servingsInput.type = 'text';
    servingsInput.value = targetServings || '';
    servingsInput.addEventListener('input', () => {
        recipePracticeServings[id] = servingsInput.value;
        renderRecipePracticeView();
    });
    servingsRow.appendChild(servingsLabel);
    servingsRow.appendChild(servingsInput);
    card.appendChild(servingsRow);

    const ingredientRows = scaleIngredientRows(parseIngredientText(sections['材料']), baseServings, targetServings);
    const table = document.createElement('table');
    table.className = 'data-table';
    const thead = document.createElement('thead');
    const hRow = document.createElement('tr');
    ['食材名', '数量', '単位', '備考'].forEach(text => {
        const th = document.createElement('th');
        th.textContent = text;
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);
    const tbody = document.createElement('tbody');
    ingredientRows.forEach(ingredient => {
        const tr = document.createElement('tr');
        [ingredient.name, ingredient.qty, ingredient.unit, ingredient.note].forEach(val => {
            const td = document.createElement('td');
            td.textContent = val || '';
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    table.append(thead, tbody);
    card.appendChild(table);

    [['前処理', sections['前処理']], ['作り方', sections['作り方']]]
        .forEach(([label, text]) => {
            const steps = parseStepList(text);
            if (steps.length === 0) return;
            const section = document.createElement('div');
            section.className = 'recipe-practice-section';
            const h5 = document.createElement('h5');
            h5.textContent = label;
            const ol = document.createElement('ol');
            steps.forEach(step => {
                const li = document.createElement('li');
                li.textContent = step;
                ol.appendChild(li);
            });
            section.append(h5, ol);
            card.appendChild(section);
        });

    if (sections['改善点']) {
        const section = document.createElement('div');
        section.className = 'recipe-practice-section';
        const h5 = document.createElement('h5');
        h5.textContent = '改善点';
        const pre = document.createElement('pre');
        pre.textContent = sections['改善点'];
        section.append(h5, pre);
        card.appendChild(section);
    }

    return card;
}

/** 「料理」タブ・実践モード: 選択済みレシピを、タブ切替または並列表示のレイアウトで描画する。 */
function renderRecipePracticeView() {
    const container = document.getElementById('recipe-practice-view');
    if (!container) return;

    const rows = getRecipeRows()
        .filter(isPermanentRecipe)
        .filter(row => recipePracticeSelectedIds.has(String(row['ID'])));

    if (rows.length === 0) {
        container.replaceChildren();
        const empty = document.createElement('div');
        empty.className = 'triage-info';
        empty.textContent = '実践するレシピを選択してください';
        container.appendChild(empty);
        return;
    }

    if (recipePracticeLayout === 'grid') {
        const grid = document.createElement('div');
        grid.className = 'recipe-practice-grid';
        rows.forEach(row => grid.appendChild(buildRecipePracticeCard(row)));
        container.replaceChildren(grid);
        return;
    }

    if (!rows.some(row => String(row['ID']) === recipePracticeActiveId)) {
        recipePracticeActiveId = String(rows[0]['ID']);
    }

    const tabBar = document.createElement('div');
    tabBar.className = 'taskorg-view-toggle';
    rows.forEach(row => {
        const id = String(row['ID']);
        const tabBtn = document.createElement('button');
        tabBtn.type = 'button';
        tabBtn.className = 'taskorg-view-btn';
        if (id === recipePracticeActiveId) tabBtn.classList.add('taskorg-view-btn--active');
        tabBtn.textContent = row['タイトル'] || '（無題）';
        tabBtn.addEventListener('click', () => {
            recipePracticeActiveId = id;
            renderRecipePracticeView();
        });
        tabBar.appendChild(tabBtn);
    });

    const activeRow = rows.find(row => String(row['ID']) === recipePracticeActiveId);
    const wrapper = document.createElement('div');
    wrapper.appendChild(tabBar);
    if (activeRow) wrapper.appendChild(buildRecipePracticeCard(activeRow));
    container.replaceChildren(wrapper);
}

['recipe-practice-layout-tabs', 'recipe-practice-layout-grid'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', (e) => {
        if (!e.target.checked) return;
        recipePracticeLayout = e.target.value;
        renderRecipePracticeView();
    });
});

/** 「料理」タブ: 入力／実践モードの切り替えボタン・パネル表示を更新する。 */
function renderRecipeModeToggle() {
    document.querySelectorAll('#recipe-mode-buttons .taskorg-view-btn').forEach(btn => {
        btn.classList.toggle('taskorg-view-btn--active', btn.dataset.recipeMode === recipeMode);
    });
    const inputPanel    = document.getElementById('recipe-mode-panel-input');
    const practicePanel = document.getElementById('recipe-mode-panel-practice');
    if (inputPanel)    inputPanel.style.display    = recipeMode === 'input'    ? '' : 'none';
    if (practicePanel) practicePanel.style.display = recipeMode === 'practice' ? '' : 'none';

    if (recipeMode === 'practice') {
        renderRecipePracticeChecklist();
        renderRecipePracticeView();
    }
}

document.querySelectorAll('#recipe-mode-buttons .taskorg-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        recipeMode = btn.dataset.recipeMode;
        renderRecipeModeToggle();
    });
});

/** 料理ビューア（一覧＋フォーム）を描画する。 */
function renderRecipeView() {
    renderRecipeSelects();
    renderRecipeList();
    updateRecipeSelectionInfo();
    renderRecipeModeToggle();
}

/** 指定タグの (M)タグ_親（カテゴリ）を調べ、現在選択中のカテゴリと一致するかどうかを返す。 */
function isKnowledgeViewerTagCategoryMatched(tag) {
    const tagCategory = currentMasterData.find(r => r['(M)タグ_子'] === tag)?.['(M)タグ_親'] || '';
    return tagCategory !== '' && tagCategory === currentCategory;
}

/**
 * ナレッジタブ「専用ビューア」を描画する。
 * マスタの (M)タグ_子＝各ビューア対象タグ の行から (M)タグ_親（カテゴリ）を調べ、
 * 現在選択中のカテゴリと一致する場合のみ対応するボタンを表示する。
 * ボタン押下時は表示中のビューアを開閉トグルする。
 */
function renderKnowledgeViewers() {
    const recipeVisible  = isKnowledgeViewerTagCategoryMatched('料理');
    const readingVisible = isKnowledgeViewerTagCategoryMatched('読書');

    const recipeBtn = document.getElementById('knowledge-viewer-btn-recipe');
    if (recipeBtn) {
        recipeBtn.style.display = recipeVisible ? '' : 'none';
        recipeBtn.classList.toggle('taskorg-view-btn--active', knowledgeViewer === 'recipe');
        if (!recipeVisible && knowledgeViewer === 'recipe') knowledgeViewer = null;
    }
    const readingBtn = document.getElementById('knowledge-viewer-btn-reading');
    if (readingBtn) {
        readingBtn.style.display = readingVisible ? '' : 'none';
        readingBtn.classList.toggle('taskorg-view-btn--active', knowledgeViewer === 'reading');
        if (!readingVisible && knowledgeViewer === 'reading') knowledgeViewer = null;
    }

    const recipePanel = document.getElementById('knowledge-viewer-panel-recipe');
    if (recipePanel) recipePanel.style.display = knowledgeViewer === 'recipe' ? '' : 'none';
    if (knowledgeViewer === 'recipe') renderRecipeView();

    const readingPanel = document.getElementById('knowledge-viewer-panel-reading');
    if (readingPanel) readingPanel.style.display = knowledgeViewer === 'reading' ? '' : 'none';
    if (knowledgeViewer === 'reading') renderReadingView();
}

document.getElementById('knowledge-viewer-btn-recipe')?.addEventListener('click', () => {
    knowledgeViewer = knowledgeViewer === 'recipe' ? null : 'recipe';
    renderKnowledgeViewers();
});

document.getElementById('knowledge-viewer-btn-reading')?.addEventListener('click', () => {
    knowledgeViewer = knowledgeViewer === 'reading' ? null : 'reading';
    selectedBookId = null;
    selectedChapterId = null;
    selectedQaId = null;
    readingQuizCards = [];
    readingQuizIndex = 0;
    readingQuizShowAnswer = false;
    const quizPanel = document.getElementById('reading-quiz-panel');
    if (quizPanel) quizPanel.style.display = 'none';
    renderKnowledgeViewers();
});

// ===== 読書ビューア（本→章メモ→QAカードの親ID階層） =====

/** タグ＝読書の本行を更新日時の新しい順に返す（トップバーのカテゴリ絞り込みに従う）。 */
function getBookRows() {
    return getFilteredMainData()
        .filter(isBookRow)
        .sort((a, b) => (b['更新日時'] || '').localeCompare(a['更新日時'] || ''));
}

/** ナレッジ用ステータス選択肢（一時メモ／永久保存等）を返す。 */
function getKnowledgeStatusOptions() {
    return [...new Set(
        currentMasterData.filter(r => r['(M)ステータス_親'] === 'ナレッジ')
            .map(r => r['(M)ステータス_子']).filter(Boolean)
    )];
}

/** 読書ビューア: 本フォームのカテゴリ・ステータス<select>を再構築する。 */
function renderReadingBookSelects() {
    const categoryEl = document.getElementById('reading-book-category');
    if (categoryEl) {
        const categories = [...new Set(currentMasterData.map(r => r['(M)カテゴリ']).filter(Boolean))];
        rebuildSelectById('reading-book-category', categories, '（選択してください）');
    }
    rebuildSelectById('reading-book-status', getKnowledgeStatusOptions(), '（選択してください）');
}

/** 読書ビューア: 本一覧テーブルを描画する。行クリックで選択・フォームへ読み込む。 */
function renderReadingBookList() {
    const table = document.getElementById('reading-book-list-table');
    if (!table) return;

    const rows = getBookRows();

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    ['書名', 'ステータス', 'カテゴリ', '更新日時'].forEach(col => {
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
        td.textContent = '該当する本がありません';
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        rows.forEach(row => {
            const tr = document.createElement('tr');
            const id = String(row['ID']);
            if (id === selectedBookId) tr.classList.add('selected-row');
            tr.addEventListener('click', () => {
                selectedBookId = id;
                selectedChapterId = null;
                clearQaForm();
                loadBookForm(row);
                renderReadingView();
            });
            [row['タイトル'] || '（無題）', row['ステータス'] || '', row['カテゴリ'] || '', row['更新日時'] || '']
                .forEach(val => {
                    const td = document.createElement('td');
                    td.textContent = val;
                    tr.appendChild(td);
                });
            tbody.appendChild(tr);
        });
    }
    table.className = 'data-table';
    table.replaceChildren(thead, tbody);
}

/** 読書ビューア: 本フォームへ選択行の値を読み込む。 */
function loadBookForm(row) {
    document.getElementById('reading-book-title').value    = row['タイトル']    || '';
    document.getElementById('reading-book-category').value = row['カテゴリ']    || '';
    document.getElementById('reading-book-status').value   = row['ステータス'] || '';
    document.getElementById('reading-book-memo').value     = row['内容']       || '';
    updateReadingBookSelectionInfo();
}

/** 読書ビューア: 本フォームをクリアし、選択状態を解除する。 */
function clearBookForm() {
    selectedBookId = null;
    selectedChapterId = null;
    ['reading-book-title', 'reading-book-memo'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('reading-book-category').value = '';
    document.getElementById('reading-book-status').value = '';
    updateReadingBookSelectionInfo();
}

function updateReadingBookSelectionInfo() {
    const info = document.getElementById('reading-book-selection-info');
    if (info) info.textContent = selectedBookId ? `選択中: ID ${selectedBookId}` : '未選択（新規登録）';
}

document.getElementById('reading-book-new-btn')?.addEventListener('click', () => {
    const title  = document.getElementById('reading-book-title').value.trim();
    if (!title) { alert('書名を入力してください'); return; }
    const status = document.getElementById('reading-book-status').value;
    if (!status) { alert('ステータスを選択してください'); return; }

    const maxId = currentMainData.reduce((max, row) => {
        const id = parseInt(row['ID'], 10);
        return isNaN(id) ? max : Math.max(max, id);
    }, 0);
    const ts = formatJpDatetime(new Date());

    const entry = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
    entry['ID']        = String(maxId + 1);
    entry['データ区分'] = 'ナレッジ';
    entry['タグ']       = '読書';
    entry['タイトル']   = title;
    entry['カテゴリ']   = document.getElementById('reading-book-category').value || (currentCategory === 'すべて' ? '' : currentCategory);
    entry['ステータス'] = status;
    entry['内容']       = document.getElementById('reading-book-memo').value.trim();
    entry['作成日時']   = ts;
    entry['更新日時']   = ts;

    currentMainData.push(entry);
    persistLocalCache();

    selectedBookId = entry['ID'];
    selectedChapterId = null;
    renderReadingView();
});

document.getElementById('reading-book-apply-btn')?.addEventListener('click', () => {
    if (!selectedBookId) { alert('更新する本を選択してください'); return; }
    const row = currentMainData.find(r => String(r['ID']) === selectedBookId);
    if (!row) return;

    const title  = document.getElementById('reading-book-title').value.trim();
    if (!title) { alert('書名を入力してください'); return; }
    const status = document.getElementById('reading-book-status').value;
    if (!status) { alert('ステータスを選択してください'); return; }

    row['タイトル']   = title;
    row['カテゴリ']   = document.getElementById('reading-book-category').value;
    row['ステータス'] = status;
    row['内容']       = document.getElementById('reading-book-memo').value.trim();
    row['更新日時']   = formatJpDatetime(new Date());

    persistLocalCache();
    renderReadingView();
});

document.getElementById('reading-book-delete-btn')?.addEventListener('click', () => {
    if (!selectedBookId) { alert('削除する本を選択してください'); return; }
    if (!confirm('選択した本を削除します。配下の章メモ・QAカードは親IDが解除され孤立します。よろしいですか？（この操作は取り消せません）')) return;

    currentMainData.forEach(r => { if (String(r['親ID'] || '') === selectedBookId) r['親ID'] = ''; });
    currentMainData = currentMainData.filter(r => String(r['ID']) !== selectedBookId);
    clearBookForm();
    persistLocalCache();
    renderReadingView();
});

/** 読書ビューア: 章メモセクションの表示/非表示、フォームselect、一覧を描画する。 */
function renderReadingChapterSection() {
    const section = document.getElementById('reading-chapter-section');
    if (section) section.style.display = selectedBookId ? '' : 'none';
    if (!selectedBookId) return;

    rebuildSelectById('reading-chapter-status', getKnowledgeStatusOptions(), '（選択してください）');
    rebuildSelectById('reading-chapter-para', [...new Set(currentMasterData.map(r => r['(M)PARA区分']).filter(Boolean))], '（選択してください）');
    renderReadingChapterList();
}

/** 読書ビューア: 選択中の本に属する章メモ一覧テーブルを描画する。 */
function renderReadingChapterList() {
    const table = document.getElementById('reading-chapter-list-table');
    if (!table) return;

    const rows = getChapters(currentMainData, selectedBookId);

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    ['章タイトル', 'ステータス', 'PARA区分', '更新日時'].forEach(col => {
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
        td.textContent = '該当する章メモがありません';
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        rows.forEach(row => {
            const tr = document.createElement('tr');
            const id = String(row['ID']);
            if (id === selectedChapterId) tr.classList.add('selected-row');
            tr.addEventListener('click', () => {
                selectedChapterId = id;
                clearQaForm();
                loadChapterForm(row);
                renderReadingView();
            });
            [row['タイトル'] || '（無題）', row['ステータス'] || '', row['PARA区分'] || '', row['更新日時'] || '']
                .forEach(val => {
                    const td = document.createElement('td');
                    td.textContent = val;
                    tr.appendChild(td);
                });
            tbody.appendChild(tr);
        });
    }
    table.className = 'data-table';
    table.replaceChildren(thead, tbody);
}

/** 読書ビューア: 章メモフォームへ選択行の値を読み込む。 */
function loadChapterForm(row) {
    document.getElementById('reading-chapter-title').value   = row['タイトル']   || '';
    document.getElementById('reading-chapter-status').value  = row['ステータス'] || '';
    document.getElementById('reading-chapter-para').value    = row['PARA区分']   || '';
    document.getElementById('reading-chapter-content').value = row['内容']       || '';
    updateReadingChapterSelectionInfo();
}

/** 読書ビューア: 章メモフォームをクリアし、選択状態を解除する。 */
function clearChapterForm() {
    selectedChapterId = null;
    ['reading-chapter-title', 'reading-chapter-content'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('reading-chapter-status').value = '';
    document.getElementById('reading-chapter-para').value = '';
    updateReadingChapterSelectionInfo();
}

function updateReadingChapterSelectionInfo() {
    const info = document.getElementById('reading-chapter-selection-info');
    if (info) info.textContent = selectedChapterId ? `選択中: ID ${selectedChapterId}` : '未選択（新規登録）';
}

document.getElementById('reading-chapter-new-btn')?.addEventListener('click', () => {
    if (!selectedBookId) { alert('本を選択してください'); return; }
    const title = document.getElementById('reading-chapter-title').value.trim();
    if (!title) { alert('章タイトルを入力してください'); return; }

    const maxId = currentMainData.reduce((max, row) => {
        const id = parseInt(row['ID'], 10);
        return isNaN(id) ? max : Math.max(max, id);
    }, 0);
    const ts = formatJpDatetime(new Date());

    const entry = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
    entry['ID']        = String(maxId + 1);
    entry['データ区分'] = 'ナレッジ';
    entry['親ID']       = selectedBookId;
    entry['タイトル']   = title;
    entry['ステータス'] = document.getElementById('reading-chapter-status').value;
    entry['PARA区分']   = document.getElementById('reading-chapter-para').value;
    entry['内容']       = document.getElementById('reading-chapter-content').value.trim();
    entry['作成日時']   = ts;
    entry['更新日時']   = ts;

    currentMainData.push(entry);
    persistLocalCache();

    selectedChapterId = entry['ID'];
    renderReadingView();
});

document.getElementById('reading-chapter-apply-btn')?.addEventListener('click', () => {
    if (!selectedChapterId) { alert('更新する章メモを選択してください'); return; }
    const row = currentMainData.find(r => String(r['ID']) === selectedChapterId);
    if (!row) return;

    const title = document.getElementById('reading-chapter-title').value.trim();
    if (!title) { alert('章タイトルを入力してください'); return; }

    row['タイトル']   = title;
    row['ステータス'] = document.getElementById('reading-chapter-status').value;
    row['PARA区分']   = document.getElementById('reading-chapter-para').value;
    row['内容']       = document.getElementById('reading-chapter-content').value.trim();
    row['更新日時']   = formatJpDatetime(new Date());

    persistLocalCache();
    renderReadingView();
});

document.getElementById('reading-chapter-delete-btn')?.addEventListener('click', () => {
    if (!selectedChapterId) { alert('削除する章メモを選択してください'); return; }
    if (!confirm('選択した章メモを削除します。配下のQAカードも削除されます。よろしいですか？（この操作は取り消せません）')) return;

    const deleteIds = new Set([selectedChapterId, ...getQaCards(currentMainData, selectedChapterId).map(r => String(r['ID']))]);
    currentMainData = currentMainData.filter(r => !deleteIds.has(String(r['ID'])));
    clearChapterForm();
    persistLocalCache();
    renderReadingView();
});

/** 読書ビューア: QAカードセクションの表示/非表示、一覧を描画する。 */
function renderReadingQaSection() {
    const section = document.getElementById('reading-qa-section');
    if (section) section.style.display = selectedChapterId ? '' : 'none';
    if (!selectedChapterId) return;
    renderReadingQaList();
}

/** 読書ビューア: 選択中の章メモに属するQAカード一覧テーブルを描画する。 */
function renderReadingQaList() {
    const table = document.getElementById('reading-qa-list-table');
    if (!table) return;

    const rows = getQaCards(currentMainData, selectedChapterId);

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    ['問題', '答え', '更新日時'].forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    if (rows.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 3;
        td.className = 'empty-cell';
        td.textContent = '該当するQAカードがありません';
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        rows.forEach(row => {
            const tr = document.createElement('tr');
            const id = String(row['ID']);
            if (id === selectedQaId) tr.classList.add('selected-row');
            tr.addEventListener('click', () => {
                selectedQaId = id;
                loadQaForm(row);
                renderReadingQaList();
            });
            [row['タイトル'] || '', row['内容'] || '', row['更新日時'] || '']
                .forEach(val => {
                    const td = document.createElement('td');
                    td.textContent = val;
                    tr.appendChild(td);
                });
            tbody.appendChild(tr);
        });
    }
    table.className = 'data-table';
    table.replaceChildren(thead, tbody);
}

/** 読書ビューア: QAフォームへ選択行の値を読み込む。 */
function loadQaForm(row) {
    document.getElementById('reading-qa-question').value = row['タイトル'] || '';
    document.getElementById('reading-qa-answer').value   = row['内容']    || '';
    updateReadingQaSelectionInfo();
}

/** 読書ビューア: QAフォームをクリアし、選択状態を解除する。 */
function clearQaForm() {
    selectedQaId = null;
    document.getElementById('reading-qa-question').value = '';
    document.getElementById('reading-qa-answer').value   = '';
    updateReadingQaSelectionInfo();
}

function updateReadingQaSelectionInfo() {
    const info = document.getElementById('reading-qa-selection-info');
    if (info) info.textContent = selectedQaId ? `選択中: ID ${selectedQaId}` : '未選択（新規登録）';
}

document.getElementById('reading-qa-new-btn')?.addEventListener('click', () => {
    if (!selectedChapterId) { alert('章メモを選択してください'); return; }
    const question = document.getElementById('reading-qa-question').value.trim();
    const answer   = document.getElementById('reading-qa-answer').value.trim();
    if (!question || !answer) { alert('問題・答えの両方を入力してください'); return; }

    const maxId = currentMainData.reduce((max, row) => {
        const id = parseInt(row['ID'], 10);
        return isNaN(id) ? max : Math.max(max, id);
    }, 0);
    const ts = formatJpDatetime(new Date());

    const entry = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
    entry['ID']        = String(maxId + 1);
    entry['データ区分'] = 'ナレッジ';
    entry['親ID']       = selectedChapterId;
    entry['PARA区分']   = getQaParaMarker();
    entry['タイトル']   = question;
    entry['内容']       = answer;
    entry['作成日時']   = ts;
    entry['更新日時']   = ts;

    currentMainData.push(entry);
    persistLocalCache();

    selectedQaId = entry['ID'];
    renderReadingQaList();
    updateReadingQaSelectionInfo();
});

document.getElementById('reading-qa-apply-btn')?.addEventListener('click', () => {
    if (!selectedQaId) { alert('更新するQAカードを選択してください'); return; }
    const row = currentMainData.find(r => String(r['ID']) === selectedQaId);
    if (!row) return;

    const question = document.getElementById('reading-qa-question').value.trim();
    const answer   = document.getElementById('reading-qa-answer').value.trim();
    if (!question || !answer) { alert('問題・答えの両方を入力してください'); return; }

    row['タイトル']   = question;
    row['内容']       = answer;
    row['更新日時']   = formatJpDatetime(new Date());

    persistLocalCache();
    renderReadingQaList();
});

document.getElementById('reading-qa-delete-btn')?.addEventListener('click', () => {
    if (!selectedQaId) { alert('削除するQAカードを選択してください'); return; }
    if (!confirm('選択したQAカードを削除します。よろしいですか？（この操作は取り消せません）')) return;

    currentMainData = currentMainData.filter(r => String(r['ID']) !== selectedQaId);
    clearQaForm();
    persistLocalCache();
    renderReadingQaList();
});

// ----- 暗記モード（QAカードのシャッフル出題） -----

/** 暗記モード: 進捗・問題・答えの表示を現在の出題状態に合わせて更新する。 */
function renderReadingQuiz() {
    const total = readingQuizCards.length;
    const progressEl = document.getElementById('reading-quiz-progress');
    const questionEl = document.getElementById('reading-quiz-question');
    const answerEl   = document.getElementById('reading-quiz-answer');
    if (!progressEl || !questionEl || !answerEl) return;

    if (total === 0) {
        progressEl.textContent = '';
        questionEl.textContent = '';
        answerEl.style.display = 'none';
        return;
    }

    const card = readingQuizCards[readingQuizIndex];
    progressEl.textContent = `${readingQuizIndex + 1} / ${total}`;
    questionEl.textContent = `Q. ${card['タイトル'] || ''}`;
    answerEl.textContent   = `A. ${card['内容'] || ''}`;
    answerEl.style.display = readingQuizShowAnswer ? '' : 'none';
}

document.getElementById('reading-quiz-start-btn')?.addEventListener('click', () => {
    const cards = getQaCards(currentMainData, selectedChapterId);
    if (cards.length === 0) { alert('この章にはQAカードがありません'); return; }

    readingQuizCards = shuffleArray(cards);
    readingQuizIndex = 0;
    readingQuizShowAnswer = false;
    document.getElementById('reading-quiz-panel').style.display = '';
    renderReadingQuiz();
});

document.getElementById('reading-quiz-reveal-btn')?.addEventListener('click', () => {
    readingQuizShowAnswer = true;
    renderReadingQuiz();
});

document.getElementById('reading-quiz-next-btn')?.addEventListener('click', () => {
    if (readingQuizCards.length === 0) return;
    readingQuizIndex = (readingQuizIndex + 1) % readingQuizCards.length;
    readingQuizShowAnswer = false;
    renderReadingQuiz();
});

document.getElementById('reading-quiz-end-btn')?.addEventListener('click', () => {
    readingQuizCards = [];
    readingQuizIndex = 0;
    readingQuizShowAnswer = false;
    document.getElementById('reading-quiz-panel').style.display = 'none';
});

/** 読書ビューア（本・章メモ・QAカードの3階層）全体を描画する。 */
function renderReadingView() {
    renderReadingBookSelects();
    renderReadingBookList();
    updateReadingBookSelectionInfo();
    renderReadingChapterSection();
    renderReadingQaSection();
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
        r['データ区分'] === 'タスク'
        && todayReferencedIds.has(String(r['ID']))
        && (currentCategory === 'すべて' || r['カテゴリ'] === currentCategory)
    );
    const todaysDayPlanIds = new Set(todaysDayPlanTasks.map(r => r['ID']));

    const inProgress = getFilteredMainData().filter(r =>
        r['データ区分'] === 'タスク' && r['ステータス'] === '進行中'
        && !isRecurringParentRow(r) // 繰返しタスクの親は対象外
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
 * タスク実行パネル用の親（プロジェクト）階層プルダウン（PJ(1層)〜必要な階層数だけ）を container に描画する。
 * 新タスク整理の編集フォームと同じ親ID方式・同じ挙動（＋新規PJ追加・階層追加）を runnerParentPath に対して行う。
 */
function renderRunnerParentDropdowns(container, excludeId) {
    container.innerHTML = '';

    const eligibleRows = getParentEligibleRows(excludeId);
    const newPjExtraOption = [{ value: NEW_PJ_MARK, label: '＋ 新規PJを追加' }];

    let level = 0;
    let parentId = ''; // 空文字ならこのレベルはルート階層（親ID空欄）の選択肢を出す
    for (;;) {
        const options = level === 0
            ? eligibleRows.filter(r => !r['親ID'] && (isParentRowM(currentMainData, r['ID']) || String(r['ID']) === runnerParentPath[0]))
            : getChildrenM(eligibleRows, parentId);

        const currentValue    = runnerParentPath[level] || '';
        const levelForClosure = level;
        const parentIdForClosure = parentId;
        appendProject2DropdownRow(container, `PJ(${level + 1}層)`, options, currentValue, value => {
            if (value === NEW_PJ_MARK) {
                const newId = createNewProjectViaPrompt(parentIdForClosure);
                if (newId) runnerParentPath = [...runnerParentPath.slice(0, levelForClosure), newId];
                renderRunnerParentDropdowns(container, excludeId);
                return;
            }
            runnerParentPath = value ? buildProject2PathFromId(value) : runnerParentPath.slice(0, levelForClosure);
            renderRunnerParentDropdowns(container, excludeId);
        }, newPjExtraOption);

        if (!currentValue) break; // このレベルで何も選ばれていなければ、これ以上下の階層は出さない
        parentId = currentValue;
        level++;
    }
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

    runnerParentPath = buildProject2PathFromId(row['親ID']);
    const parentDropdowns = document.createElement('div');
    renderRunnerParentDropdowns(parentDropdowns, row['ID']);
    addRow('プロジェクト', parentDropdowns);

    const parentClearBtn = document.createElement('button');
    parentClearBtn.type = 'button';
    parentClearBtn.className = 'calendar-add-btn';
    parentClearBtn.textContent = '親を解除';
    parentClearBtn.addEventListener('click', () => {
        runnerParentPath = [];
        renderRunnerParentDropdowns(parentDropdowns, row['ID']);
    });
    addRow('', parentClearBtn);

    const toolbar = document.createElement('div');
    toolbar.className = 'calendar-edit-toolbar';
    const applyBtn = document.createElement('button');
    applyBtn.textContent = '適用';
    applyBtn.addEventListener('click', () => {
        const parentId = runnerParentPath[runnerParentPath.length - 1] || '';
        if (!checkParentCycleOrAlert(row['ID'], parentId)) return;

        row['タイトル'] = titleInput.value.trim();
        row['内容']     = contentInput.value.trim();
        row['備考']     = bikoInput.value.trim();
        row['優先度']   = prioritySelect.value;
        row['カテゴリ'] = categorySelect.value;
        row['タグ']     = tagSelect.value;
        row['親ID']     = parentId;

        const startTime = start.hourInput.value !== '' && start.minuteInput.value !== ''
            ? `${String(start.hourInput.value).padStart(2, '0')}:${String(start.minuteInput.value).padStart(2, '0')}` : '';
        const endTime = end.hourInput.value !== '' && end.minuteInput.value !== ''
            ? `${String(end.hourInput.value).padStart(2, '0')}:${String(end.minuteInput.value).padStart(2, '0')}` : '';
        row['開始予定'] = start.dateInput.value ? `${start.dateInput.value.replace(/-/g, '/')}${startTime ? ' ' + startTime : ''}` : '';
        row['終了予定'] = end.dateInput.value   ? `${end.dateInput.value.replace(/-/g, '/')}${endTime ? ' ' + endTime : ''}`       : '';
        row['完了日']   = completeDateInput.value.replace(/-/g, '/');
        row['更新日時'] = formatJpDatetime(new Date());

        persistLocalCache();
        renderCalendar2();
        renderTaskRunner();
    });
    toolbar.appendChild(applyBtn);
    section.appendChild(toolbar);

    return section;
}

// ===== カレンダー =====

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

/** rows が属する、実際にプロジェクト（子を持つ最上位の親行）である最上位の親行一覧を返す（繰返しテンプレートは除く）。 */
function getProjectRootRows(rows) {
    const rootIds = new Set();
    rows.forEach(r => {
        const rootId = getRootParentIdM(currentMainData, r['ID']);
        if (isParentRowM(currentMainData, rootId)) rootIds.add(rootId);
    });
    return [...rootIds]
        .map(id => currentMainData.find(r => String(r['ID']) === id))
        .filter(Boolean)
        .filter(r => !isRecurringParentRow(r));
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
    const rootRow = currentMainData.find(r => String(r['ID']) === rootId);
    // 最上位が繰返しテンプレート（プロジェクトに属さない単独の繰返しタスク）の場合は、
    // プロジェクト一覧の選択肢に出てこないため、単独タスクと同様に常に通過させる。
    if (!isParentRowM(currentMainData, rootId) || (rootRow && isRecurringParentRow(rootRow))) return true;
    return filterSet.has(rootId);
}

/**
 * row がプロジェクトのPJ(n層)ドリルダウン絞り込みを満たすか判定する。
 * drilldownPath が空なら常に通過。空でなければ、drilldownPath の末尾（最も深い階層で選択中のID）が
 * row自身、またはrowの親ID系列（ルート→row自身）に含まれる場合のみ通過させる（＝そのPJ配下の子孫タスクのみ表示）。
 */
function matchesProjectDrilldownFilter(row, drilldownPath) {
    if (drilldownPath.length === 0) return true;
    const targetId = drilldownPath[drilldownPath.length - 1];
    return buildProject2PathFromId(row['ID']).includes(targetId);
}

const RECURRING_WEEKBOARD_DAY_LABELS = ['月', '火', '水', '木', '金', '土', '日']; // 週間ボードの列順（月始まり）

/** 「開始予定」欄の時刻部分（HH:mm）を分単位に変換する。時刻未入力ならnull。 */
function extractRecurringStartMinutes(row) {
    // 日付付き（"2026/07/14 09:00"）・時刻のみ（"09:00"）のどちらでも拾えるよう、文字列中のHH:mmを直接探す
    const m = (row['開始予定'] || '').match(/(\d{1,2}):(\d{2})/);
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
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

/** 時・分の2つの<input type="number">から "HH:mm" 文字列を組み立てる（いずれか未入力なら空文字）。 */
function readCalendarTime(hourId, minuteId) {
    const hour   = document.getElementById(hourId).value;
    const minute = document.getElementById(minuteId).value;
    if (hour === '' || minute === '') return '';
    const pad = n => String(n).padStart(2, '0');
    return `${pad(hour)}:${pad(minute)}`;
}

// ---- タスク編集フォーム（各画面の prefix-* 入力欄）共通ヘルパー ----
// 各タスク編集パネルは、id接頭辞（prefix）が異なるだけで日時フィールド・頻度チップ等の構造が同一のため、
// prefixを引数に取る共通関数へ集約する。

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


// ===== ガントチャート（タスクページ） =====


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


/** "YYYY/MM/DD HH:mm" のような日時文字列の日付部分だけを days 日分ずらして返す（時刻部分は保持）。パース不可なら元の文字列のまま返す。 */
function shiftSlashDateTimeString(str, days) {
    const [datePart, timePart] = (str || '').split(' ');
    const d = parseSlashDateOnly(datePart);
    if (!d) return str;
    d.setDate(d.getDate() + days);
    const shifted = formatSlashDateOnly(d);
    return timePart ? `${shifted} ${timePart}` : shifted;
}

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
    if (taskorg2View === 'calendar') renderTaskorg2CalendarGrid();
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

/** 親（プロジェクト）階層プルダウン用に、excludeId自身とその子孫を除いた「親になれる（データ区分がタスク）」行一覧を返す（新タスク整理・タスク実行で共有）。 */
function getParentEligibleRows(excludeId) {
    let excludedIds = new Set();
    if (excludeId) {
        excludedIds.add(String(excludeId));
        let frontier = [String(excludeId)];
        while (frontier.length > 0) {
            const next = currentMainData
                .filter(r => frontier.includes(String(r['親ID'] || '')))
                .map(r => String(r['ID']))
                .filter(id => !excludedIds.has(id));
            next.forEach(id => excludedIds.add(id));
            frontier = next;
        }
    }
    return filterMainDataByCategory(currentMainData, currentCategory)
        .filter(r => !excludedIds.has(String(r['ID'])))
        .filter(isEligibleParentRowM);
}

const NEW_PJ_MARK = '__new_pj__'; // 親プルダウンの「＋ 新規PJを追加」選択肢の特殊値

/**
 * 親（プロジェクト）階層プルダウンで「＋ 新規PJを追加」を選んだ際、その場で新規プロジェクト（タスク）を作成しIDを返す。
 * ステータス=進行中・優先度=中、開始予定・終了予定・完了日は空欄とする。タイトル未入力（キャンセル含む）ならnullを返す。
 * @param {string} parentId - 新規プロジェクトの親ID（空文字ならルート＝最上位プロジェクトとして作成）
 */
function createNewProjectViaPrompt(parentId) {
    const title = (prompt('新しいプロジェクト（PJ）のタイトルを入力してください') || '').trim();
    if (!title) return null;

    const maxId = currentMainData.reduce((max, row) => {
        const id = parseInt(row['ID'], 10);
        return isNaN(id) ? max : Math.max(max, id);
    }, 0);
    const ts = formatJpDatetime(new Date());

    const entry = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
    entry['ID']        = String(maxId + 1);
    entry['データ区分'] = 'タスク';
    entry['タイトル']   = title;
    entry['ステータス'] = '進行中';
    entry['優先度']     = '中';
    entry['カテゴリ']   = currentCategory === 'すべて' ? '' : currentCategory;
    entry['親ID']       = parentId || '';
    entry['作成日時']   = ts;
    entry['更新日時']   = ts;

    currentMainData.push(entry);
    persistLocalCache();

    return entry['ID'];
}

/**
 * 「新タスク整理」編集フォームの親（プロジェクト）階層プルダウン（PJ(1層)〜必要な階層数だけ）を描画する。
 * 階層1は既存の最上位プロジェクトのみ、階層2以降は直前に選択した行の子（データ区分がタスクのもの）を選択肢とする。
 * どの階層にも「＋ 新規PJを追加」を用意し、選ぶとその階層でその場に新規プロジェクトを作成して選択状態にする。
 * 何かが選択されている限り次の階層のプルダウンを（既存の子が無くても）表示し、任意の深さまで追加できるようにする。
 * 選択のたびに dayedit2ParentPath を再構築し、最終選択値を dayedit2-parent-id（hidden）へ反映する。
 */
function renderDayedit2ParentDropdowns() {
    const container = document.getElementById('dayedit2-parent-dropdowns');
    if (!container) return;
    container.innerHTML = '';

    const eligibleRows = getParentEligibleRows(selectedTaskorg2Id);
    const newPjExtraOption = [{ value: NEW_PJ_MARK, label: '＋ 新規PJを追加' }];

    let level = 0;
    let parentId = ''; // 空文字ならこのレベルはルート階層（親ID空欄）の選択肢を出す
    for (;;) {
        let options = level === 0
            ? eligibleRows.filter(r => !r['親ID'] && (isParentRowM(currentMainData, r['ID']) || String(r['ID']) === dayedit2ParentPath[0]))
            : getChildrenM(eligibleRows, parentId);

        const currentValue = dayedit2ParentPath[level] || '';

        // 繰返しテンプレートは通常の親候補（eligibleRows）から除外されているため、実行タスクが
        // テンプレートを親IDに持つ場合はそのままだとこの階層の選択肢に出てこない。新規に他タスクの
        // 親として選べるようにするためではなく、既存の関係を正しく表示するために、現在の選択値が
        // テンプレートの時だけこの階層の選択肢に補って表示する。
        if (currentValue && !options.some(r => String(r['ID']) === currentValue)) {
            const currentRow = currentMainData.find(r => String(r['ID']) === currentValue);
            if (currentRow && String(currentRow['親ID'] || '') === parentId) {
                options = [...options, currentRow];
            }
        }
        const levelForClosure = level;
        const parentIdForClosure = parentId;
        appendProject2DropdownRow(container, `PJ(${level + 1}層)`, decorateProjectDropdownOptions(options), currentValue, value => {
            if (value === NEW_PJ_MARK) {
                const newId = createNewProjectViaPrompt(parentIdForClosure);
                if (newId) dayedit2ParentPath = [...dayedit2ParentPath.slice(0, levelForClosure), newId];
                renderDayedit2ParentDropdowns();
                return;
            }
            dayedit2ParentPath = value ? buildProject2PathFromId(value) : dayedit2ParentPath.slice(0, levelForClosure);
            renderDayedit2ParentDropdowns();
        }, newPjExtraOption);

        if (!currentValue) break; // このレベルで何も選ばれていなければ、これ以上下の階層は出さない
        parentId = currentValue;
        level++;
    }

    const hiddenEl = document.getElementById('dayedit2-parent-id');
    if (hiddenEl) hiddenEl.value = dayedit2ParentPath[dayedit2ParentPath.length - 1] || '';
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

/** タグ／ステータス／プロジェクト（親ID・ドリルダウン）／繰返し親子タスク表示ON/OFFのtaskorg2フィルタ条件をrowが満たすか判定する（1日タスク除外は含まない）。 */
function matchesTaskorg2CommonFilters(r) {
    if (!matchesFilterValue(taskorg2Filters.tag, r['タグ'])) return false;
    if (!matchesFilterValue(taskorg2Filters.status, r['ステータス'])) return false;
    if (!matchesProjectRootFilter(r, taskorg2Filters.project)) return false;
    if (!matchesProjectDrilldownFilter(r, taskorg2ProjectDrilldownPath)) return false;

    if (isRecurringParentRow(r) && !taskorg2Filters.showRecurringParent) return false;
    if (isRecurringChildRow(currentMainData, r) && !taskorg2Filters.showRecurringChild) return false;
    // 繰返しテンプレートは専用のshowRecurringParentで制御するため、showProjectの対象からは除く
    if (!taskorg2Filters.showProject && !isRecurringParentRow(r) && isParentRowM(currentMainData, r['ID'])) return false;
    return true;
}

/** 選択中カテゴリ・タグ／ステータスフィルタ＋その他フィルタ（プロジェクト・繰返し親子タスクの表示ON/OFF）で絞り込んだメインデータ一覧を返す（日付絞り込みは含まない）。カレンダーの日別集計に使う。 */
function getTaskorg2BaseFilteredList() {
    return filterMainDataByCategory(currentMainData, currentCategory).filter(r => {
        if (isDayPlanRow(r)) return false; // 1日タスク（DAYPLAN）の器行は通常の一覧・カレンダーには出さない
        return matchesTaskorg2CommonFilters(r);
    });
}

/**
 * 選択中カテゴリ・タグ／ステータス／プロジェクト（最上位の親ID）フィルタ＋その他フィルタで絞り込んだ、データ区分がタスクの行一覧を返す（日付を問わず全件、旧タスク整理と同一仕様）。
 * 1日タスク（DAYPLAN）除外は行わないが、データ区分がタスクの行のみを対象とするため、データ区分「ナレッジ」のDAYPLAN器行は結果的に含まれない。
 * ソート順: ステータス（完了・報告待ち・連絡待ち・中断・進行中・未着手・空欄の順）→ 完了日 昇順 → 開始予定 昇順 → 終了予定 昇順。
 */
function matchesTaskorg2ListFilters(r) {
    if (!matchesFilterValue(taskorg2Filters.tag, r['タグ'])) return false;
    if (!matchesFilterValue(taskorg2Filters.status, r['ステータス'])) return false;
    if (!matchesProjectRootFilter(r, taskorg2Filters.project)) return false;
    if (!matchesProjectDrilldownFilter(r, taskorg2ProjectDrilldownPath)) return false;

    if (isRecurringParentRow(r) && !taskorg2Filters.showRecurringParent) return false;
    if (isRecurringChildRow(currentMainData, r) && !taskorg2Filters.showRecurringChild) return false;

    if (taskorg2ProjectDrilldownPath.length > 0) {
        // PJ(n層)を選択中は、選択階層を親IDとする直接の子タスクのみ表示する（孫以降は非表示）
        const targetId = taskorg2ProjectDrilldownPath[taskorg2ProjectDrilldownPath.length - 1];
        if (String(r['親ID'] || '') !== targetId) return false;
    }
    // showProjectがOFFならプロジェクト行（さらに子を持つ親行）を除外し、最下層タスクのみ表示（ドリルダウン選択中も同様に適用）
    if (!taskorg2Filters.showProject && !isRecurringParentRow(r) && isParentRowM(currentMainData, r['ID'])) return false;
    return true;
}

/** 選択中カテゴリ・タグ／ステータス／プロジェクト（最上位の親ID）フィルタ＋その他フィルタで絞り込んだ、データ区分がタスクの行一覧を返す（日付を問わず全件、旧タスク整理と同一仕様）。
 * PJ(n層)ドリルダウン選択中は、選択階層の直接の子タスクのみに絞り込む（孫は非表示）。
 */
function getTaskorg2FilteredList() {
    const tasks = filterMainDataByCategory(currentMainData, currentCategory)
        .filter(r => r['データ区分'] === 'タスク' && matchesTaskorg2ListFilters(r));

    tasks.sort((a, b) => {
        const rankDiff = calendarTaskListStatusRank(a['ステータス']) - calendarTaskListStatusRank(b['ステータス']);
        if (rankDiff !== 0) return rankDiff;

        let cmp = compareDateAscEmptyLast(a['完了日'], b['完了日']);
        if (cmp !== 0) return cmp;

        cmp = compareDateAscEmptyLast(a['開始予定'], b['開始予定']);
        if (cmp !== 0) return cmp;

        return compareDateAscEmptyLast(a['終了予定'], b['終了予定']);
    });

    return tasks;
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

    const workExceptions = parseExceptions(getWorkCalendarContent(taskorg2CalendarYear));

    for (let d = 1; d <= daysInMonth; d++) {
        const dateJP = `${taskorg2CalendarYear}/${pad(taskorg2CalendarMonth + 1)}/${pad(d)}`;
        const cell = document.createElement('div');
        cell.className = 'calendar-day';
        if (dateJP === todayJP)              cell.classList.add('calendar-day--today');
        if (dateJP === selectedTaskorg2Date) cell.classList.add('calendar-day--selected');

        const workType = workExceptions.get(dateJP)?.type
            ?? getDefaultType(new Date(taskorg2CalendarYear, taskorg2CalendarMonth, d));
        if (workType !== '出勤日') cell.classList.add(`calendar-day--work-${workType}`);

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
            selectedTaskorg2Id   = null;
            taskorg2QuickNewMode = false;
            renderTaskorg2DateChange();
        });
        grid.appendChild(cell);
    }
}

/** taskorg2CalendarYear／Month に依存する、現在表示中のビューだけを再描画する（カレンダー／ガント／習慣の月表示）。 */
function refreshTaskorg2MonthDependentView() {
    if (taskorg2View === 'calendar') renderTaskorg2CalendarGrid();
    else if (taskorg2View === 'gantt') renderTaskorg2GanttChart();
    else if (taskorg2View === 'weekboard' && taskorg2HabitUnit === 'month') renderTaskorg2HabitMonth();
}
function goToPrevMonthTaskorg2() {
    taskorg2CalendarMonth--;
    if (taskorg2CalendarMonth < 0) { taskorg2CalendarMonth = 11; taskorg2CalendarYear--; }
    refreshTaskorg2MonthDependentView();
}
function goToNextMonthTaskorg2() {
    taskorg2CalendarMonth++;
    if (taskorg2CalendarMonth > 11) { taskorg2CalendarMonth = 0; taskorg2CalendarYear++; }
    refreshTaskorg2MonthDependentView();
}
document.getElementById('calendar2-prev-btn')?.addEventListener('click', goToPrevMonthTaskorg2);
document.getElementById('calendar2-next-btn')?.addEventListener('click', goToNextMonthTaskorg2);
document.getElementById('calendar2-gantt-prev-btn')?.addEventListener('click', goToPrevMonthTaskorg2);
document.getElementById('calendar2-gantt-next-btn')?.addEventListener('click', goToNextMonthTaskorg2);
document.getElementById('calendar2-habit-month-prev-btn')?.addEventListener('click', goToPrevMonthTaskorg2);
document.getElementById('calendar2-habit-month-next-btn')?.addEventListener('click', goToNextMonthTaskorg2);

/** 新タスク整理の「カレンダー」「ガントチャート」「習慣」「勤務歴」「プロジェクト」表示切り替えボタンの状態・表示パネルを反映する。 */
function renderTaskorg2ViewToggle() {
    document.getElementById('taskorg2-tab-calendar')?.classList.toggle('taskorg-view-btn--active', taskorg2View === 'calendar');
    document.getElementById('taskorg2-tab-gantt')?.classList.toggle('taskorg-view-btn--active', taskorg2View === 'gantt');
    document.getElementById('taskorg2-tab-weekboard')?.classList.toggle('taskorg-view-btn--active', taskorg2View === 'weekboard');
    document.getElementById('taskorg2-tab-workcal')?.classList.toggle('taskorg-view-btn--active', taskorg2View === 'workcal');
    document.getElementById('taskorg2-tab-project')?.classList.toggle('taskorg-view-btn--active', taskorg2View === 'project');
    const calEl       = document.getElementById('taskorg2-view-calendar');
    const ganttEl     = document.getElementById('taskorg2-view-gantt');
    const weekboardEl = document.getElementById('taskorg2-view-weekboard');
    const workcalEl   = document.getElementById('taskorg2-view-workcal');
    const projectEl   = document.getElementById('taskorg2-view-project');
    if (calEl)       calEl.style.display       = taskorg2View === 'calendar'  ? '' : 'none';
    if (ganttEl)     ganttEl.style.display     = taskorg2View === 'gantt'     ? '' : 'none';
    if (weekboardEl) weekboardEl.style.display = taskorg2View === 'weekboard' ? '' : 'none';
    if (workcalEl)   workcalEl.style.display   = taskorg2View === 'workcal'   ? '' : 'none';
    if (projectEl)   projectEl.style.display   = taskorg2View === 'project'   ? '' : 'none';
}

document.getElementById('taskorg2-tab-calendar')?.addEventListener('click', () => { taskorg2View = 'calendar'; renderCalendar2(); });
document.getElementById('taskorg2-tab-gantt')?.addEventListener('click', () => { taskorg2View = 'gantt'; renderCalendar2(); });
document.getElementById('taskorg2-tab-weekboard')?.addEventListener('click', () => { taskorg2View = 'weekboard'; renderCalendar2(); });
document.getElementById('taskorg2-tab-workcal')?.addEventListener('click', () => { taskorg2View = 'workcal'; renderCalendar2(); });
document.getElementById('taskorg2-tab-project')?.addEventListener('click', () => { taskorg2View = 'project'; renderCalendar2(); });

// ===== 新タスク整理：ガントチャート（月間カレンダーと年月・選択日を共有。旧タスク整理と同一仕様） =====

/** カテゴリ・taskorg2Filters（タグ／ステータス／その他フィルタ）で絞り込んだタスク一覧を返す。1日タスクは除外し、日付未設定の行も除外する。 */
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
            renderTaskorg2DateChange();
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

            tr.addEventListener('click', () => { selectedTaskorg2Id = String(row['ID']); taskorg2QuickNewMode = false; renderTaskorg2TaskChange(); });
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

// ===== 新タスク整理：プロジェクト（親ID方式の階層を折りたたみ可能なインデント付きツリーで一覧表示） =====

/**
 * 「プロジェクト」ツリービューの対象母集団を返す。カレンダー・ガントチャートと同じ taskorg2Filters
 * （タグ／ステータス／プロジェクト／PJ(n層)ドリルダウン／繰返し親子タスク表示ON/OFF）を適用したうえで、
 * データ区分がタスクの行に絞り込む（1日タスクは常に除外）。
 * ただし「その他フィルタ」の“プロジェクト”表示チェック（showProject）だけは適用しない。
 * プロジェクトタブはツリー構造そのものを見せる画面のため、他画面向けの「親（プロジェクト）行を隠す」
 * トグルがOFF（既定）だと階層の頂点が軒並み消えて何も表示されなくなってしまうため。
 */
function getTaskorg2ProjectTreePool() {
    return filterMainDataByCategory(currentMainData, currentCategory).filter(r => {
        if (isDayPlanRow(r)) return false;
        if (r['データ区分'] !== 'タスク') return false;
        if (!matchesFilterValue(taskorg2Filters.tag, r['タグ'])) return false;
        if (!matchesFilterValue(taskorg2Filters.status, r['ステータス'])) return false;
        if (!matchesProjectRootFilter(r, taskorg2Filters.project)) return false;
        if (!matchesProjectDrilldownFilter(r, taskorg2ProjectDrilldownPath)) return false;
        if (isRecurringParentRow(r) && !taskorg2Filters.showRecurringParent) return false;
        if (isRecurringChildRow(currentMainData, r) && !taskorg2Filters.showRecurringChild) return false;
        return true;
    });
}

// 子タスクの並び順（同じ親の配下での表示順）。この順にグループ化し、リストに無いステータス・空欄は最後尾。
const PROJECT_TREE_CHILD_STATUS_ORDER = ['完了', '報告待ち', '連絡待ち', '中断', '進行中', '未着手'];

/** ステータス名の子タスク表示順ランクを返す（完了→報告待ち→連絡待ち→中断→進行中→未着手→その他（未設定含む）の順）。 */
function projectTreeChildStatusRank(status) {
    const idx = PROJECT_TREE_CHILD_STATUS_ORDER.indexOf(status);
    return idx !== -1 ? idx : PROJECT_TREE_CHILD_STATUS_ORDER.length;
}

/** 子タスク配列（表示順ソート済み）をステータスごとにグループ化し、PROJECT_TREE_CHILD_STATUS_ORDER順で返す。グループ内の順序は元の並びを維持する。 */
function groupProjectTreeChildrenByStatus(rows) {
    const groups = new Map();
    rows.forEach(row => {
        const status = row['ステータス'] || '（未設定）';
        if (!groups.has(status)) groups.set(status, []);
        groups.get(status).push(row);
    });
    return [...groups.keys()]
        .sort((a, b) => projectTreeChildStatusRank(a) - projectTreeChildStatusRank(b))
        .map(status => ({ status, rows: groups.get(status) }));
}

/**
 * 新タスク整理の「プロジェクト」ツリービューを描画する。行クリックで下の編集フォームに読み込み、▶/▼クリックで子の展開・折りたたみを切り替える。
 * 各行の左端にチェックボックスを配置し、選択中IDは selectedTaskorg2ProjectTreeIds（getTaskorg2BulkSelectedIds経由でPJ一括編集の対象）に加える。
 * 親・子どちらの階層行でもチェック可能で、「PJ一括編集」バーのPJ(n層)プルダウンで選んだ親IDを一括適用できる。
 * ルート階層・各親の配下いずれも、完了→報告待ち→連絡待ち→中断→進行中→未着手→（未設定）の順にステータスで
 * グループ化するのを最優先の並び順とし、各グループ内は子孫総数（子・孫以降を含む総数）が多い順に並べる
 * （見出し行は表示せず、並び順のみに使う）。
 */
function renderTaskorg2ProjectTree() {
    const container = document.getElementById('calendar2-project-tree');
    if (!container) return;
    container.innerHTML = '';

    const pool = getTaskorg2ProjectTreePool();
    pruneTaskorg2Selection(selectedTaskorg2ProjectTreeIds, new Set(pool.map(r => String(r['ID']))));

    // 表示対象（フィルタ適用後）の「親ID→子一覧」を1回の走査だけでインデックス化する（画面に出す階層構造用）。
    const poolChildrenIndex = new Map();
    pool.forEach(r => {
        const key = String(r['親ID'] || '');
        if (!poolChildrenIndex.has(key)) poolChildrenIndex.set(key, []);
        poolChildrenIndex.get(key).push(r);
    });

    // 子孫総数（フィルタ非適用・全データ基準。従来のcollectProject2Descendantsと同じ集計対象）も、
    // 「親ID→子一覧」インデックス＋メモ化で1回の走査だけで求める（並び順・件数表示の両方に使い回す）。
    // pool.filter+collectProject2Descendantsを行ごとに呼ぶ従来実装はノード数の2乗規模で重かったための対策。
    const allChildrenIndex = new Map();
    currentMainData.forEach(r => {
        const key = String(r['親ID'] || '');
        if (!allChildrenIndex.has(key)) allChildrenIndex.set(key, []);
        allChildrenIndex.get(key).push(r);
    });
    const descendantCountCache = new Map();
    const countDescendants = (id, visited = new Set()) => {
        const key = String(id);
        if (descendantCountCache.has(key)) return descendantCountCache.get(key);
        if (visited.has(key)) return 0; // 循環データ保護
        visited.add(key);
        const kids = allChildrenIndex.get(key) || [];
        let total = kids.length;
        kids.forEach(child => { total += countDescendants(child['ID'], visited); });
        descendantCountCache.set(key, total);
        return total;
    };

    const childrenOf = parentId => {
        const kids = poolChildrenIndex.get(String(parentId || '')) || [];
        return [...kids].sort((a, b) => countDescendants(b['ID']) - countDescendants(a['ID']));
    };
    const roots = childrenOf('');

    if (roots.length === 0) {
        container.innerHTML = '<p class="empty-cell">該当するタスクがありません</p>';
        return;
    }

    /**
     * rows（同じ親を持つ行の配列。事前に子孫総数の多い順にソート済み）を、完了→報告待ち→連絡待ち→中断→
     * 進行中→未着手→（未設定）の順にステータスでグループ化し、depth階層のインデントで区切り見出し行を描画する。
     * groupKeyPrefix はルート階層なら 'root'、子階層なら親行のIDを渡す（開閉状態のキーを親ごとに独立させるため）。
     */
    const renderStatusGroupedRows = (rows, depth, buildRow) => {
        groupProjectTreeChildrenByStatus(rows).forEach(group => {
            group.rows.forEach(child => buildRow(child, depth));
        });
    };

    const buildRow = (row, depth) => {
        const id = String(row['ID']);
        const kids = childrenOf(id);
        const hasKids = kids.length > 0;
        // 既定では「ステータス=完了」の親（プロジェクト）だけを折りたたんでおく。手動で開閉した行はその状態を優先する。
        const defaultCollapsed = hasKids && row['ステータス'] === '完了';
        const collapsed = taskorg2ProjectManualStateIds.has(id) ? taskorg2ProjectManualStateIds.get(id) : defaultCollapsed;

        const line = document.createElement('div');
        line.className = 'project-tree-row';
        if (id === selectedTaskorg2Id) line.classList.add('selected-row');
        line.style.paddingLeft = `${depth * 20}px`;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'project-tree-checkbox';
        checkbox.checked = selectedTaskorg2ProjectTreeIds.has(id);
        checkbox.addEventListener('click', e => e.stopPropagation());
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                selectedTaskorg2ProjectTreeIds.add(id);
                selectedTaskorg2Id = id;
                taskorg2QuickNewMode = false;
                renderTaskorg2TaskChange();
            } else {
                selectedTaskorg2ProjectTreeIds.delete(id);
            }
        });
        line.appendChild(checkbox);

        const toggle = document.createElement('span');
        toggle.className = 'project-tree-toggle';
        toggle.textContent = hasKids ? (collapsed ? '▶' : '▼') : '';
        if (hasKids) {
            toggle.addEventListener('click', e => {
                e.stopPropagation();
                taskorg2ProjectManualStateIds.set(id, !collapsed);
                renderTaskorg2ProjectTree();
            });
        }
        line.appendChild(toggle);

        const descendantCount = countDescendants(id); // 直属の子だけでなく孫以降も含めた総数（メモ化済み）
        const label = document.createElement('span');
        label.className = `project-tree-label ${getCalendarStatusClass(row['ステータス'])}`;
        appendChipLabel(label, row, (row['タイトル'] || '（無題）') + (descendantCount > 0 ? ` (${descendantCount})` : ''));
        line.appendChild(label);

        line.addEventListener('click', () => {
            selectedTaskorg2Id = id;
            taskorg2QuickNewMode = false;
            renderTaskorg2TaskChange();
        });

        container.appendChild(line);

        if (hasKids && !collapsed) renderStatusGroupedRows(kids, depth + 1, buildRow);
    };

    renderStatusGroupedRows(roots, 0, buildRow);
}

// ===== 新タスク整理：週間ボード（繰返しタスクの週表示。旧繰返しエリアの週間ボードをそのまま移植） =====

/**
 * 「習慣」の1行分（繰返し親タスク）を組み立てる。クリックで選択し、右の編集エリアに読み込む
 * （選択状態は通常のタスク一覧・カレンダーと同じ selectedTaskorg2Id を共有する）。色はステータスに合わせる。
 */
function buildTaskorg2WeekBoardRow(item) {
    const id = String(item['ID']);
    const tr = document.createElement('tr');
    tr.className = 'recurring-weekboard-row';
    if (id === selectedTaskorg2Id) tr.classList.add('recurring-weekboard-row--selected');

    const td = document.createElement('td');
    td.className = getCalendarStatusClass(item['ステータス']);
    td.textContent = item['タイトル'] || '（無題）';
    tr.appendChild(td);

    tr.addEventListener('click', () => {
        selectedTaskorg2RecurringParentId = id;
        selectedTaskorg2Id = id;
        taskorg2QuickNewMode = false;
        renderTaskorg2TaskChange();
    });

    return tr;
}

/**
 * 「習慣」の月～日の固定表を container に描画する。実際の日付には依存しない（曜日名の一致だけで判定するため、
 * 週送り等のナビゲーションは無い）。表示対象は繰返し親タスクのうち「頻度（曜日）」を設定しているものだけ
 * （子タスクは表示しない）。
 */
function buildTaskorg2WeekBoardWeek(container) {
    if (!container) return;
    container.innerHTML = '';

    // 「頻度（曜日）」を設定している繰返し親タスクのみを対象にする（全選択＝実質「毎日」指定のものは毎日タブ側に表示するため除外）
    const parents = getTaskorg2RecurringParentRows().filter(p => p['繰返し頻度_曜日'] && !isTaskorg2HabitDaily(p));
    const todayLabel = RECURRING_WEEKBOARD_DAY_LABELS[(new Date().getDay() + 6) % 7]; // 日曜=0を月曜起点の並びに変換

    RECURRING_WEEKBOARD_DAY_LABELS.forEach(label => {
        const col = document.createElement('div');
        col.className = 'recurring-weekboard-day' + (label === todayLabel ? ' recurring-weekboard-day--today' : '');

        const header = document.createElement('div');
        header.className = 'recurring-weekboard-day-header';
        header.textContent = label;
        col.appendChild(header);

        // その曜日が頻度（曜日）に含まれる親タスクを対象にする。開始予定に時刻が入力されていれば早い順に並べる
        const matchingParents = sortRecurringParentsByStart(
            parents.filter(p => p['繰返し頻度_曜日'].split(',').map(s => s.trim()).includes(label))
        );

        if (matchingParents.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'calendar-empty-text';
            empty.textContent = '-';
            col.appendChild(empty);
        } else {
            const table = document.createElement('table');
            table.className = 'recurring-weekboard-table';
            const tbody = document.createElement('tbody');
            matchingParents.forEach(parent => tbody.appendChild(buildTaskorg2WeekBoardRow(parent)));
            table.appendChild(tbody);
            col.appendChild(table);
        }

        container.appendChild(col);
    });

    renderTaskorg2HabitUnsetSection('calendar2-habit-week-unset');
}

/**
 * 「習慣」の週表示・月表示どちらの下にも表示する「頻度未指定タスク」（頻度（月）／（日）／（曜日）が
 * すべて未設定の繰返し親タスク）を containerId に描画する。
 */
function renderTaskorg2HabitUnsetSection(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '';

    const unset = getTaskorg2RecurringParentRows().filter(p =>
        !p['繰返し頻度_月'] && !p['繰返し頻度_日'] && !p['繰返し頻度_曜日']
    );

    if (unset.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'calendar-empty-text';
        empty.textContent = '該当なし';
        el.appendChild(empty);
        return;
    }

    unset.forEach(p => {
        const wrap = document.createElement('span');
        wrap.className = 'calendar-unscheduled-chip-wrap';
        wrap.appendChild(buildTaskorg2HabitChip(p));
        el.appendChild(wrap);
    });
}

/** "7月"や"07"のような表記の揺れを吸収して数値部分だけを取り出す（頻度（月）／頻度（日）の判定用）。数値が無ければnull。 */
function extractTaskorg2HabitNumber(str) {
    const m = String(str).match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
}

/** row の指定フィールド（頻度（月）または頻度（日））を数値配列にして返す（未設定なら空配列）。 */
function taskorg2HabitFieldNumbers(row, field) {
    return (row[field] || '').split(',').map(s => s.trim()).filter(Boolean)
        .map(extractTaskorg2HabitNumber).filter(n => n !== null);
}

/**
 * row の frequencyField（頻度（曜日）または頻度（日））が、マスタに定義された選択肢を「全部選択」しているかどうかを判定する
 * （選択肢は renderFreqChipsFor と同様、currentMasterData の masterField 列から取り出す）。
 */
function isTaskorg2HabitFieldFullySelected(row, frequencyField, masterField) {
    const options = new Set(currentMasterData.map(r => r[masterField]).filter(Boolean));
    if (options.size === 0) return false;
    const selected = new Set((row[frequencyField] || '').split(',').map(s => s.trim()).filter(Boolean));
    if (selected.size !== options.size) return false;
    for (const opt of options) if (!selected.has(opt)) return false;
    return true;
}

/** 「頻度（曜日）が全部選択されている」または「頻度（日）が全部選択されている」＝実質「毎日」指定かどうかを判定する。 */
function isTaskorg2HabitDaily(row) {
    return isTaskorg2HabitFieldFullySelected(row, '繰返し頻度_曜日', '(M)繰返し頻度_曜日')
        || isTaskorg2HabitFieldFullySelected(row, '繰返し頻度_日', '(M)繰返し頻度_日');
}

/** バッジ（チップ）の左端に付ける優先度ドット（高=赤／中=黄／低=緑）を1件分組み立てる。想定外の値・未設定ならnull。 */
function createPriorityDot(row) {
    const cls = getPriorityDotClass(row['優先度']);
    if (!cls) return null;
    const dot = document.createElement('span');
    dot.className = `calendar-priority-dot ${cls}`;
    dot.setAttribute('aria-hidden', 'true');
    return dot;
}

/** チップのバッジ本体に、優先度ドット（あれば）＋タイトルのテキストノードを組み立てて追加する。 */
function appendChipLabel(chip, row, text) {
    const dot = createPriorityDot(row);
    if (dot) chip.appendChild(dot);
    chip.appendChild(document.createTextNode(text));
}

/** 「習慣」月表示の日付ボタン（小型チップ）を1件分組み立てる。クリックで右の編集エリアと連動する。 */
function buildTaskorg2HabitChip(item) {
    const id = String(item['ID']);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `calendar-unscheduled-chip calendar-unscheduled-chip--solo calendar-unscheduled-chip--mini ${getCalendarStatusClass(item['ステータス'])}`;
    if (id === selectedTaskorg2Id) chip.classList.add('calendar-unscheduled-chip--active-outline');
    chip.title = item['タイトル'] || '（無題）';
    appendChipLabel(chip, item, item['タイトル'] || '（無題）');
    chip.addEventListener('click', () => {
        selectedTaskorg2RecurringParentId = id;
        selectedTaskorg2Id = id;
        taskorg2QuickNewMode = false;
        renderTaskorg2TaskChange();
    });
    return chip;
}

/**
 * 「習慣」の月表示（taskorg2CalendarYear／Month。カレンダー・ガントチャートと共有）を描画する。
 * 対象は繰返し親タスクのうち「頻度（日）」または「頻度（月）」を設定しているものだけ（頻度（曜日）のみのものは週表示側）。
 * ・日＋月の両方設定: 月が一致する月のみ、カレンダーの該当日に表示
 * ・日のみ設定: 月に関わらず毎月その日に表示
 * ・月のみ設定: 日付を特定できないため、月が一致する時だけカレンダー下の「日付指定なしタスク」に表示
 */
function renderTaskorg2HabitMonth() {
    const label = document.getElementById('calendar2-habit-month-label');
    if (label) label.textContent = `${taskorg2CalendarYear}年${taskorg2CalendarMonth + 1}月`;

    const grid = document.getElementById('calendar2-habit-month-grid');
    const unscheduledEl = document.getElementById('calendar2-habit-month-unscheduled');
    if (!grid || !unscheduledEl) return;
    grid.innerHTML = '';

    const parents = getTaskorg2RecurringParentRows().filter(p => (p['繰返し頻度_日'] || p['繰返し頻度_月']) && !isTaskorg2HabitDaily(p));
    const currentMonthNum = taskorg2CalendarMonth + 1;
    const monthMatches = p => {
        const nums = taskorg2HabitFieldNumbers(p, '繰返し頻度_月');
        return nums.length === 0 || nums.includes(currentMonthNum);
    };

    ['日', '月', '火', '水', '木', '金', '土'].forEach(d => {
        const head = document.createElement('div');
        head.className = 'calendar-day-head';
        head.textContent = d;
        grid.appendChild(head);
    });

    const startWeekday = new Date(taskorg2CalendarYear, taskorg2CalendarMonth, 1).getDay();
    const daysInMonth  = new Date(taskorg2CalendarYear, taskorg2CalendarMonth + 1, 0).getDate();
    const todayJP      = jpDateOnly(formatJpDatetime(new Date()));
    const pad          = n => String(n).padStart(2, '0');
    const workExceptions = parseExceptions(getWorkCalendarContent(taskorg2CalendarYear));

    for (let i = 0; i < startWeekday; i++) {
        const cell = document.createElement('div');
        cell.className = 'calendar-day calendar-day--empty';
        grid.appendChild(cell);
    }

    for (let d = 1; d <= daysInMonth; d++) {
        const dateJP = `${taskorg2CalendarYear}/${pad(taskorg2CalendarMonth + 1)}/${pad(d)}`;
        const cell = document.createElement('div');
        cell.className = 'calendar-day' + (dateJP === todayJP ? ' calendar-day--today' : '');
        cell.style.cursor = 'default';

        const workType = workExceptions.get(dateJP)?.type
            ?? getDefaultType(new Date(taskorg2CalendarYear, taskorg2CalendarMonth, d));
        if (workType !== '出勤日') cell.classList.add(`calendar-day--work-${workType}`);

        const num = document.createElement('div');
        num.className = 'calendar-day-num';
        num.textContent = String(d);
        cell.appendChild(num);

        // 「頻度（日）」が設定されていてその日に一致し、かつ「頻度（月）」が未設定（毎月）か今月に一致するものを対象にする
        const dayMatches = parents.filter(p => {
            const dayNums = taskorg2HabitFieldNumbers(p, '繰返し頻度_日');
            return dayNums.includes(d) && monthMatches(p);
        });

        if (dayMatches.length > 0) {
            const tasksEl = document.createElement('div');
            tasksEl.className = 'calendar-day-tasks';
            dayMatches.forEach(p => tasksEl.appendChild(buildTaskorg2HabitChip(p)));
            cell.appendChild(tasksEl);
        }

        grid.appendChild(cell);
    }

    // 「頻度（日）」が未設定で「頻度（月）」のみ設定されているものは、日付を特定できないため
    // 今月に一致する場合のみカレンダー下に「日付指定なしタスク」として表示する
    const unscheduled = parents.filter(p => !p['繰返し頻度_日'] && p['繰返し頻度_月'] && monthMatches(p));
    unscheduledEl.innerHTML = '';
    if (unscheduled.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'calendar-empty-text';
        empty.textContent = '該当なし';
        unscheduledEl.appendChild(empty);
    } else {
        unscheduled.forEach(p => {
            const wrap = document.createElement('span');
            wrap.className = 'calendar-unscheduled-chip-wrap';
            wrap.appendChild(buildTaskorg2HabitChip(p));
            unscheduledEl.appendChild(wrap);
        });
    }

    renderTaskorg2HabitUnsetSection('calendar2-habit-month-unset');
}

/**
 * 「習慣」の毎日表示を描画する。対象は繰返し親タスクのうち、頻度（曜日）または頻度（日）が
 * 全選択されている（＝実質「毎日」指定）もの（週タブ・月タブ側ではその分を除外済み）。
 */
function renderTaskorg2HabitDaily() {
    const el = document.getElementById('calendar2-habit-daily-list');
    if (!el) return;
    el.innerHTML = '';

    const daily = getTaskorg2RecurringParentRows().filter(isTaskorg2HabitDaily);

    if (daily.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'calendar-empty-text';
        empty.textContent = '該当なし';
        el.appendChild(empty);
        return;
    }

    daily.forEach(p => {
        const wrap = document.createElement('span');
        wrap.className = 'calendar-unscheduled-chip-wrap';
        wrap.appendChild(buildTaskorg2HabitChip(p));
        el.appendChild(wrap);
    });
}

/** 「習慣」タブの「週」「月」「毎日」表示切り替えボタンの状態・表示パネルを反映する。 */
function renderTaskorg2HabitUnitToggle() {
    document.getElementById('calendar2-habit-unit-week')?.classList.toggle('gantt-unit-btn--active', taskorg2HabitUnit === 'week');
    document.getElementById('calendar2-habit-unit-month')?.classList.toggle('gantt-unit-btn--active', taskorg2HabitUnit === 'month');
    document.getElementById('calendar2-habit-unit-daily')?.classList.toggle('gantt-unit-btn--active', taskorg2HabitUnit === 'daily');
    const weekEl  = document.getElementById('calendar2-habit-week-panel');
    const monthEl = document.getElementById('calendar2-habit-month');
    const dailyEl = document.getElementById('calendar2-habit-daily');
    if (weekEl)  weekEl.style.display  = taskorg2HabitUnit === 'week'  ? '' : 'none';
    if (monthEl) monthEl.style.display = taskorg2HabitUnit === 'month' ? '' : 'none';
    if (dailyEl) dailyEl.style.display = taskorg2HabitUnit === 'daily' ? '' : 'none';
}

document.getElementById('calendar2-habit-unit-week')?.addEventListener('click', () => {
    taskorg2HabitUnit = 'week';
    renderTaskorg2HabitUnitToggle();
    renderTaskorg2WeekBoard();
});
document.getElementById('calendar2-habit-unit-month')?.addEventListener('click', () => {
    taskorg2HabitUnit = 'month';
    renderTaskorg2HabitUnitToggle();
    renderTaskorg2WeekBoard();
});
document.getElementById('calendar2-habit-unit-daily')?.addEventListener('click', () => {
    taskorg2HabitUnit = 'daily';
    renderTaskorg2HabitUnitToggle();
    renderTaskorg2WeekBoard();
});

/** 「習慣」タブを描画する。表示単位（週／月／毎日）に応じて、該当するビューだけを描画する。 */
function renderTaskorg2WeekBoard() {
    renderTaskorg2HabitUnitToggle();
    if (taskorg2HabitUnit === 'week') buildTaskorg2WeekBoardWeek(document.getElementById('calendar2-habit-week'));
    else if (taskorg2HabitUnit === 'daily') renderTaskorg2HabitDaily();
    else renderTaskorg2HabitMonth();
}

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
            dayPlanBlockIndex,
            column: b.column
        });
    });

    return { timed, unscheduled, referenced };
}

const CALENDAR_HOUR_HEIGHT = 40; // 1時間あたりの高さ(px)

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
    assignCalendarColumns(timed);

    const pxPerMin = CALENDAR_HOUR_HEIGHT / 60;

    for (let m = 0; m < 1440; m += 15) {
        const minuteOfHour = m % 60;
        const variant = minuteOfHour === 0 ? 'hour' : minuteOfHour === 30 ? 'half' : 'quarter';
        const line = document.createElement('div');
        line.className = `calendar-timeline-gridline calendar-timeline-gridline--${variant}`;
        line.style.top = `${m * pxPerMin}px`;
        lanesEl.appendChild(line);
    }

    // 固定4列（列1=決まっている予定／列2〜4=空き時間消化）の区切りを縦の点線で明示する
    for (let i = 1; i < DAYPLAN_COLUMN_COUNT; i++) {
        const divider = document.createElement('div');
        divider.className = 'calendar-timeline-column-divider';
        divider.style.left = `${(100 / DAYPLAN_COLUMN_COUNT) * i}%`;
        lanesEl.appendChild(divider);
    }

    const blockBySeg = new Map();

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
        labelSpan.textContent = seg.row['タイトル'] || '（無題）';
        block.appendChild(labelSpan);

        const handle = document.createElement('div');
        handle.className = 'calendar-time-block-resize-handle';
        block.appendChild(handle);

        blockBySeg.set(seg, block);
        attachTaskorg2TimelineDragHandlers(block, handle, labelSpan, seg, dateJP, pxPerMin, hasLinkedTask);
        lanesEl.appendChild(block);
    });

    const scrollEl = document.getElementById('calendar2-timeline-scroll');
    if (scrollEl) scrollEl.scrollTop = 8 * CALENDAR_HOUR_HEIGHT;

    renderTaskorg2DayPlanSection();
}

const TIMELINE_SNAP_MIN = 15;         // ドラッグ操作のスナップ単位（分）
const TIMELINE_DRAG_THRESHOLD_MIN = 8; // これ未満の移動量はクリック（属性編集を開く）として扱う

/** 分を15分単位に丸める。 */
function snapTimelineMinutes(min) {
    return Math.round(min / TIMELINE_SNAP_MIN) * TIMELINE_SNAP_MIN;
}

/**
 * タイムラインのブロックへ「移動（時刻＋列）」「リサイズ（時刻のみ）」操作を付与する。
 * ドラッグ中は自分自身の位置・高さ・列のみを更新し、他ブロックのレーン再配置は行わない
 * （ドラッグ中に他ブロックまで位置が飛んで見づらくなるのを防ぐため）。レーンの再計算は
 * ドラッグ確定後の再描画時にまとめて行われる。「移動」は縦方向で時刻、横方向で列（1〜4）を変更できる。
 * 「リサイズ」（下端ハンドル）は時刻（終了予定）のみで列は変わらない。
 */
function attachTaskorg2TimelineDragHandlers(block, handle, labelSpan, seg, dateJP, pxPerMin, hasLinkedTask) {
    let dragMode  = null; // 'move' | 'resize'
    let pointerId = null;
    let startClientY = 0;
    let origStart  = seg.startMin;
    let origEnd    = seg.endMin;
    let origColumn = seg.lane + 1;
    let pendingStart  = seg.startMin;
    let pendingEnd    = seg.endMin;
    let pendingColumn = origColumn;

    function applyColumnStyle(column) {
        const laneWidthPct = 100 / DAYPLAN_COLUMN_COUNT;
        block.style.left  = `${(column - 1) * laneWidthPct}%`;
        block.style.width = `calc(${laneWidthPct}% - 4px)`;
    }

    function updatePreview(newStart, newEnd, newColumn) {
        pendingStart  = newStart;
        pendingEnd    = newEnd;
        pendingColumn = newColumn;
        block.style.top    = `${newStart * pxPerMin}px`;
        block.style.height = `${(newEnd - newStart) * pxPerMin}px`;
        applyColumnStyle(newColumn);
        labelSpan.textContent = seg.row['タイトル'] || '（無題）';
    }

    /** clientXが乗っている列（1〜4、コンテナ幅を4等分）を返す。block.parentElement（lanesEl）は、この関数が
     * 呼ばれる時点（ドラッグ操作時）では必ずDOMに接続済みだが、attachTaskorg2TimelineDragHandlers呼び出し時点
     * （まだlanesElへappendChildする前）ではnullのため、ここで都度取得する。 */
    function columnFromClientX(clientX) {
        const rect = block.parentElement.getBoundingClientRect();
        const laneWidthPx = rect.width / DAYPLAN_COLUMN_COUNT;
        const col = Math.floor((clientX - rect.left) / laneWidthPx) + 1;
        return Math.max(1, Math.min(DAYPLAN_COLUMN_COUNT, col));
    }

    function onPointerMove(e) {
        if (!dragMode) return;
        const deltaMin = snapTimelineMinutes((e.clientY - startClientY) / pxPerMin);

        if (dragMode === 'move') {
            const duration = origEnd - origStart;
            const newStart = Math.max(0, Math.min(1440 - duration, origStart + deltaMin));
            updatePreview(newStart, newStart + duration, columnFromClientX(e.clientX));
        } else {
            const newEnd = Math.max(origStart + TIMELINE_SNAP_MIN, Math.min(1440, origEnd + deltaMin));
            updatePreview(origStart, newEnd, origColumn); // リサイズは列を変えない
        }
    }

    function onPointerUp() {
        if (!dragMode) return;
        block.releasePointerCapture(pointerId);
        block.removeEventListener('pointermove', onPointerMove);
        block.removeEventListener('pointerup', onPointerUp);
        block.removeEventListener('pointercancel', onPointerUp);

        const movedMin      = Math.abs(pendingStart - origStart) + Math.abs(pendingEnd - origEnd);
        const columnChanged = dragMode === 'move' && pendingColumn !== origColumn;
        if (movedMin < TIMELINE_DRAG_THRESHOLD_MIN && !columnChanged) {
            updatePreview(origStart, origEnd, origColumn); // 微小な移動は元に戻す
            if (dragMode === 'move' && hasLinkedTask) { selectedTaskorg2Id = String(seg.row['ID']); taskorg2QuickNewMode = false; renderTaskorg2TaskChange(); }
        } else {
            commitTaskorg2TimelineDrag(seg, dateJP, pendingStart, pendingEnd, pendingColumn, columnChanged);
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
        origColumn    = seg.lane + 1;
        pendingStart  = origStart;
        pendingEnd    = origEnd;
        pendingColumn = origColumn;
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
 * タイムラインのドラッグ操作結果を確定保存する。ケースによって実際に変更されるデータが異なるため、
 * 再描画範囲もそれに合わせて最小限に絞る（無関係なビューまで再計算する重い処理を避けるため）。
 * targetColumnはドラッグ／リサイズ後にブロックが位置する列（1〜4）を常に渡す（列を変えていなくても渡す。
 * リサイズは常に元の列のまま）。列2〜4は placeDayPlanBlock 側で重なりを自動的に押し出して解消し、
 * 24:00を超えるようならキャンセル（何も書き換えずタイムラインだけ再描画して元の位置に戻す）。列1は重なりを気にせず
 * そのまま配置する。
 *
 * - 1日タスクのスケジュール行（isDayPlanBlock）: その行（＋押し出された同じ列の他ブロック）の時刻・列だけを書き換える。
 *   他のタスク行には一切影響しないため、タイムラインだけ再描画すれば十分。
 * - 1日タスクに未追加のタスクを列方向にドラッグ（columnChanged）: そのタスク自身の開始予定・終了予定は変えず、
 *   1日タスクへ新しい行として追加する（＝昇格）。「対応中タスク」一覧での参照状態が変わるため未設定タスク一覧も再描画。
 * - 1日タスクに未追加のタスクを縦方向のみドラッグ（時刻だけ変更）: タスク自身の開始予定・終了予定を書き換える。
 *   月間カレンダーのバッジ・ガントのマーカー・タスク一覧の該当行が変わりうるため、選択日に依存するビュー一式
 *   （renderTaskorg2DateChange）の再描画が必要。
 */
function commitTaskorg2TimelineDrag(seg, dateJP, newStartMin, newEndMin, targetColumn, columnChanged) {
    const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

    if (seg.isDayPlanBlock) {
        const dayPlan = getDayPlanTaskM(currentMainData, dateJP);
        if (!dayPlan) return;
        const result = placeDayPlanBlock(dayPlan['内容'], seg.dayPlanBlockIndex, newStartMin, newEndMin, targetColumn);
        if (!result.ok) { renderTaskorg2Timeline(); return; } // 24:00を超えるためキャンセル、元の位置に戻す
        dayPlan['内容']     = result.content;
        dayPlan['更新日時'] = formatJpDatetime(new Date());
        persistLocalCache();
        renderTaskorg2Timeline(); // 1日タスクのテキストとタイムライン上のチップ位置しか変わらないため、他のビューは再描画不要
        return;
    }

    if (columnChanged) {
        let dayPlan = getTaskorg2DayPlanTask();
        if (!dayPlan) {
            createTaskorg2DayPlanTask();
            dayPlan = getTaskorg2DayPlanTask();
            if (!dayPlan) return;
        }
        const newBlock = { refId: String(seg.row['ID']), label: seg.row['タイトル'] || '（無題）' };
        const result = placeDayPlanBlock(dayPlan['内容'], null, newStartMin, newEndMin, targetColumn, newBlock);
        if (!result.ok) { renderTaskorg2Timeline(); return; } // 24:00を超えるためキャンセル、タスクは未追加のまま
        dayPlan['内容']     = result.content;
        dayPlan['更新日時'] = formatJpDatetime(new Date());
        persistLocalCache();
        renderTaskorg2Timeline();
        renderTaskorg2UnsetSection(); // 「対応中タスク」の未設定/参照済み区分が変わるため
        return;
    }

    const row = currentMainData.find(r => String(r['ID']) === String(seg.row['ID']));
    if (!row) return;
    row['開始予定'] = `${dateJP} ${fmt(newStartMin)}`;
    row['終了予定'] = `${dateJP} ${fmt(newEndMin)}`;
    row['更新日時'] = formatJpDatetime(new Date());
    persistLocalCache();
    renderTaskorg2DateChange(); // タスク本体の日程が変わり、カレンダー/ガント/一覧など選択日依存のビューに影響しうる
}

/** 選択中日付の1日タスク行（isDayPlanRow）を返す。無ければnull。 */
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

/** "HH:MM" 文字列を分に変換する。 */
function parseHHMMToMinutes(str) {
    const [h, m] = str.split(':').map(Number);
    return h * 60 + m;
}

/**
 * 選択中日付の1日タスクを新規作成する（データ区分=ナレッジ・PARA区分=1日タスク、開始予定=選択中日付）。
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

    const noFilters = { tag: new Set(), status: new Set() };
    const scheduledBlocks = getTasksForDateM(currentMainData, currentCategory, noFilters, selectedTaskorg2Date)
        .map(row => {
            const timeInfo = getTaskScheduledTimeOnDate(row, selectedTaskorg2Date);
            if (!timeInfo) return null;
            return {
                startMin: parseHHMMToMinutes(timeInfo.startStr),
                endMin:   parseHHMMToMinutes(timeInfo.endStr),
                refId:    String(row['ID']),
                label:    '',
                column:   1
            };
        })
        .filter(Boolean);

    const defaultBlock = { startMin: 9 * 60, endMin: 9 * 60 + 30, refId: null, label: 'メールチェック、予定整理', column: 1 };
    const content = stringifyDayPlanBlocks(sortDayPlanBlocks([defaultBlock, ...scheduledBlocks]));

    const entry = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
    entry['ID']        = String(maxId + 1);
    entry['データ区分'] = DAYPLAN_KUBUN;
    entry['PARA区分']   = DAYPLAN_PARA;
    entry['タイトル']   = `1日タスク ${selectedTaskorg2Date}`;
    entry['開始予定']   = selectedTaskorg2Date;
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
 * 選択中日付の1日タスクに「[列番号] HH:MM-HH:MM #ID タイトル」の1行を追加する（1日タスクが無ければ新規作成）。
 * タイムラインでのドラッグ（列を明示的に変えた場合）と、対応中タスクの「＋」ボタンの両方から使う共通処理。
 */
function appendTaskorg2DayPlanLine(row, startStr, endStr, column) {
    if (!selectedTaskorg2Date) return;
    let dayPlan = getTaskorg2DayPlanTask();
    if (!dayPlan) {
        createTaskorg2DayPlanTask();
        dayPlan = getTaskorg2DayPlanTask();
        if (!dayPlan) return;
    }
    const line = `[${column}] ${startStr}-${endStr} #${row['ID']} ${row['タイトル'] || '（無題）'}`;
    dayPlan['内容']     = dayPlan['内容'] ? `${dayPlan['内容']}\n${line}` : line;
    dayPlan['更新日時'] = formatJpDatetime(new Date());
}

/**
 * タスクを選択中日付の1日タスクに追加する（対応中タスクなどの「＋」ボタン用）。
 * 開始予定・終了予定が既にその日の時刻まで指定済みのタスク（決まっている予定）は列1に固定配置。
 * それ以外（時間未定のタスク）は、9:00起点で列2〜4の作業枠のうち最も早く空く列へ自動的に割り当てる。
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
    const fixedSlot = getTaskScheduledTimeOnDate(row, selectedTaskorg2Date);
    const { startStr, endStr, column } = fixedSlot ? { ...fixedSlot, column: 1 } : computeDayPlanTimeSlot(busyBlocks);
    appendTaskorg2DayPlanLine(row, startStr, endStr, column);
    persistLocalCache();
    renderCalendar2();
}

/** チップ群（{row, label}の配列）を container に描画する。空なら emptyText を表示する。options.showAddButton（既定true）で1日タスクへの追加＋ボタンの有無を切り替える。 */
/**
 * チップ（ボタン）一覧を描画する。selectionSetを渡すと、各チップの左側にチェックボックスを配置し、
 * 複数選択→編集エリアの「適用」「削除」での一括編集対象にできるようにする（getTaskorg2BulkSelectedIds参照）。
 * チェックを入れたタスクは、その場で編集エリアのアクティブ対象にもする。
 */
function renderTaskorg2ChipList(container, chipEntries, emptyText, options = {}) {
    const { showAddButton = true, selectionSet = null } = options;
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
        const rowId = String(row['ID']);

        const line = document.createElement('span');
        line.className = 'calendar-unscheduled-chip-line';

        if (selectionSet) {
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'calendar-unscheduled-chip-checkbox';
            checkbox.checked = selectionSet.has(rowId);
            checkbox.addEventListener('click', (e) => e.stopPropagation());
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    selectionSet.add(rowId);
                    selectedTaskorg2Id = rowId;
                    taskorg2QuickNewMode = false;
                    renderTaskorg2TaskChange();
                } else {
                    selectionSet.delete(rowId);
                }
            });
            line.appendChild(checkbox);
        }

        const wrap = document.createElement('span');
        wrap.className = 'calendar-unscheduled-chip-wrap';

        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `calendar-unscheduled-chip ${showAddButton ? '' : 'calendar-unscheduled-chip--solo'} ${getCalendarStatusClass(row['ステータス'])}`;
        if (rowId === selectedTaskorg2Id) chip.classList.add('calendar-unscheduled-chip--active-outline');
        chip.title = label;
        appendChipLabel(chip, row, label);
        chip.addEventListener('click', () => { selectedTaskorg2Id = rowId; taskorg2QuickNewMode = false; renderTaskorg2TaskChange(); });
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

        line.appendChild(wrap);
        container.appendChild(line);
    });
}

/** 未設定タスクの一覧を、ステータス順でグループ化して描画する（旧タスク整理と同一仕様）。 */
function renderTaskorg2GroupedChips(container, chipEntries, emptyText, options = {}) {
    const { showAddButton = false, selectionSet = null } = options;
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
        listEl.className = 'calendar-unscheduled-list calendar-unscheduled-list--grid2';
        container.appendChild(listEl);

        renderTaskorg2ChipList(listEl, groupEntries, '', { showAddButton, selectionSet });
    });
}

/** 開始予定・終了予定の少なくとも一方が空欄のタスク（taskorg2フィルタ適用済み）を返す。 */
function getTaskorg2IncompleteDateTasks() {
    const hasDate = v => !!parseSlashDateOnly(v); // 空欄はもちろん、"HH:mm"のみ（日付部分が無い）値もfalse扱いにする
    return getTaskorg2BaseFilteredList().filter(r =>
        r['データ区分'] === 'タスク' &&
        !(hasDate(r['開始予定']) && hasDate(r['終了予定'])) // どちらか一方でも日付未入力（時刻のみ含む）なら対象
    );
}

/** カテゴリ／ステータス／優先度／プロジェクト（親ID）それぞれが未設定のタスクを、領域ごとに分けて返す（重複あり）。カテゴリ／ステータス／優先度は旧タスク整理と共通のロジックを再利用し、プロジェクトのみ親ID方式で判定する。 */
function getTaskorg2UnsetAttributeGroups() {
    const generic = getUnsetAttributeGroupsM(currentMainData, currentCategory);
    const pool = getTaskorg2BaseFilteredList().filter(r => r['データ区分'] === 'タスク');
    const matchesCat = r => currentCategory === 'すべて' || !r['カテゴリ'] || r['カテゴリ'] === currentCategory;
    return {
        categoryUnset: generic.categoryUnset,
        statusUnset:   generic.statusUnset,
        priorityUnset: generic.priorityUnset,
        projectUnset:  pool.filter(r => !r['親ID'] && matchesCat(r)),
    };
}

/** ステータスが「中断」で、対応中タスク（開始予定〜終了予定の期間に今日が含まれるもの）に該当しないタスクを返す。 */
function getTaskorg2SuspendedTasks() {
    const todayJP = jpDateOnly(formatJpDatetime(new Date()));
    return getSuspendedTasksM(currentMainData, currentCategory, todayJP);
}

/** ステータスが「連絡待ち」で、対応中タスクに該当しないタスクを返す。 */
function getTaskorg2WaitingContactTasks() {
    const todayJP = jpDateOnly(formatJpDatetime(new Date()));
    return getTasksByStatusM(currentMainData, currentCategory, '連絡待ち', todayJP);
}

/** ステータスが「報告待ち」で、対応中タスクに該当しないタスクを返す。 */
function getTaskorg2WaitingReportTasks() {
    const todayJP = jpDateOnly(formatJpDatetime(new Date()));
    return getTasksByStatusM(currentMainData, currentCategory, '報告待ち', todayJP);
}

/** 未設定タスク一覧（未設定/設定済み・属性未設定〔カテゴリ・ステータス・優先度・プロジェクト・日付〕・中断）を描画する。 */
function renderTaskorg2UnsetSection() {
    const unscheduledEl    = document.getElementById('calendar2-unscheduled-list');
    const dayplanAddedEl   = document.getElementById('calendar2-dayplan-added-list');
    const incompleteEl     = document.getElementById('calendar2-incomplete-date-list');
    const unsetCategoryEl  = document.getElementById('calendar2-unset-category-list');
    const unsetStatusEl    = document.getElementById('calendar2-unset-status-list');
    const unsetPriorityEl  = document.getElementById('calendar2-unset-priority-list');
    const unsetProjectEl   = document.getElementById('calendar2-unset-project-list');
    const suspendedEl      = document.getElementById('calendar2-suspended-list');
    const waitingContactEl = document.getElementById('calendar2-waitingcontact-list');
    const waitingReportEl  = document.getElementById('calendar2-waitingreport-list');
    if (!incompleteEl) return;

    const unsetGroups = getTaskorg2UnsetAttributeGroups();
    const toChips = rows => rows.map(row => ({ row, label: row['タイトル'] || '（無題）' }));
    renderTaskorg2ChipList(unsetCategoryEl, toChips(unsetGroups.categoryUnset), '該当なし', { selectionSet: selectedTaskorg2UnsetIds });
    renderTaskorg2ChipList(unsetStatusEl,   toChips(unsetGroups.statusUnset),   '該当なし', { selectionSet: selectedTaskorg2UnsetIds });
    renderTaskorg2ChipList(unsetPriorityEl, toChips(unsetGroups.priorityUnset), '該当なし', { selectionSet: selectedTaskorg2UnsetIds });
    renderTaskorg2ChipList(unsetProjectEl,  toChips(unsetGroups.projectUnset),  '該当なし', { selectionSet: selectedTaskorg2UnsetIds });
    setExpanderCount('calendar2-unset-category-count', unsetGroups.categoryUnset.length);
    setExpanderCount('calendar2-unset-status-count',   unsetGroups.statusUnset.length);
    setExpanderCount('calendar2-unset-priority-count', unsetGroups.priorityUnset.length);
    setExpanderCount('calendar2-unset-project-count',  unsetGroups.projectUnset.length);

    const incompleteChips = getTaskorg2IncompleteDateTasks().map(row => ({ row, label: row['タイトル'] || '（無題）' }));
    renderTaskorg2ChipList(incompleteEl, incompleteChips, '該当なし', { selectionSet: selectedTaskorg2UnsetIds });
    setExpanderCount('calendar2-incomplete-count', incompleteChips.length);

    setExpanderCount('calendar2-unset-total-count',
        unsetGroups.categoryUnset.length + unsetGroups.statusUnset.length +
        unsetGroups.priorityUnset.length + unsetGroups.projectUnset.length +
        incompleteChips.length);

    // このエリア（属性未設定タスク）に実在しなくなったチェック済みIDは選択から外す
    const unsetValidIds = new Set([
        ...unsetGroups.categoryUnset, ...unsetGroups.statusUnset,
        ...unsetGroups.priorityUnset, ...unsetGroups.projectUnset,
        ...getTaskorg2IncompleteDateTasks(),
    ].map(r => String(r['ID'])));
    pruneTaskorg2Selection(selectedTaskorg2UnsetIds, unsetValidIds);

    const waitingContactChips = toChips(getTaskorg2WaitingContactTasks());
    renderTaskorg2ChipList(waitingContactEl, waitingContactChips, '該当なし', { selectionSet: selectedTaskorg2WaitingIds });
    setExpanderCount('calendar2-waitingcontact-count', waitingContactChips.length);

    const waitingReportChips = toChips(getTaskorg2WaitingReportTasks());
    renderTaskorg2ChipList(waitingReportEl, waitingReportChips, '該当なし', { selectionSet: selectedTaskorg2WaitingIds });
    setExpanderCount('calendar2-waitingreport-count', waitingReportChips.length);

    const suspendedChips = toChips(getTaskorg2SuspendedTasks());
    renderTaskorg2ChipList(suspendedEl, suspendedChips, '該当なし', { selectionSet: selectedTaskorg2WaitingIds });
    setExpanderCount('calendar2-suspended-count', suspendedChips.length);

    setExpanderCount('calendar2-waiting-total-count',
        waitingContactChips.length + waitingReportChips.length + suspendedChips.length);

    // このエリア（対応待ちタスク）に実在しなくなったチェック済みIDは選択から外す
    const waitingValidIds = new Set(
        [...waitingContactChips, ...waitingReportChips, ...suspendedChips].map(c => String(c.row['ID']))
    );
    pruneTaskorg2Selection(selectedTaskorg2WaitingIds, waitingValidIds);

    if (!selectedTaskorg2Date) {
        if (unscheduledEl)  unscheduledEl.innerHTML = '';
        if (dayplanAddedEl) dayplanAddedEl.innerHTML = '';
        setExpanderCountPair('calendar2-todo-dayplan-count', 0, 0);
        selectedTaskorg2InProgressIds.clear();
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
    renderTaskorg2GroupedChips(unscheduledEl, chipEntries, 'この日のタスクはありません', { showAddButton: true, selectionSet: selectedTaskorg2InProgressIds });

    const referencedChips = referenced.map(row => ({ row, label: row['タイトル'] || '（無題）' }));
    renderTaskorg2GroupedChips(dayplanAddedEl, referencedChips, 'まだありません', { selectionSet: selectedTaskorg2InProgressIds });

    setExpanderCountPair('calendar2-todo-dayplan-count', chipEntries.length, referencedChips.length);

    // このエリア（対応中タスク）に実在しなくなったチェック済みIDは選択から外す
    const inProgressValidIds = new Set([...chipEntries, ...referencedChips].map(c => String(c.row['ID'])));
    pruneTaskorg2Selection(selectedTaskorg2InProgressIds, inProgressValidIds);
}

/**
 * 新タスク整理のフィルタを描画する。上部（カレンダーエリア）と下部（タスク一覧の直上）の2箇所に、
 * 同じ状態（taskorg2Filters／taskorg2ProjectDrilldownPath）を参照する複製フィルタとして描画することで、
 * どちらを操作しても同じフィルタとして同期して動作するようにする。
 */
function renderTaskorg2Filters() {
    ['calendar2-filter-area', 'calendar2-filter-area-bottom'].forEach(renderTaskorg2FiltersInto);
}

/**
 * 新タスク整理のフィルタを指定IDの領域に描画する。表示順はタグ→ステータス→その他フィルタ→プロジェクト。
 * 「その他フィルタ」は、カレンダー・タスクリストへの表示有無を切り替えるプロジェクト／繰返し親タスク／繰返し子タスクの
 * チェックボックスを1行で並べる。プロジェクトの複数選択チェックボックスの下には、PJ(1層)から始まる
 * ドリルダウン用プルダウンを配置し、階層を辿って子孫タスクだけに絞り込めるようにする。
 */
function renderTaskorg2FiltersInto(areaId) {
    const area = document.getElementById(areaId);
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
        selectAllBtn.addEventListener('click', () => { options.forEach(v => selectedSet.add(v)); renderCalendar2(); });

        const deselectAllBtn = document.createElement('button');
        deselectAllBtn.type = 'button';
        deselectAllBtn.className = 'calendar-filter-bulk-btn';
        deselectAllBtn.textContent = '全解除';
        deselectAllBtn.addEventListener('click', () => { selectedSet.clear(); renderCalendar2(); });

        const ctrl = createCalendarMultiFilter(options, selectedSet, buildLabel, () => renderCalendar2());
        row.append(lbl, selectAllBtn, deselectAllBtn, ctrl);
        area.appendChild(row);
    }

    const tagOptions = sortByTotalCountDesc(getFilteredTags(), 'タグ');
    seedFilterOptionSet(tagOptions, taskorg2Filters.tag, taskorg2FilterKnownOptions.tag);
    makeRow('タグ', tagOptions, taskorg2Filters.tag, v => `${v} (${countActiveTasksByField('タグ', v)}/${countTasksByField('タグ', v)})`);

    const statusOptions = sortByTotalCountDesc(getFilteredTaskStatuses(), 'ステータス');
    seedFilterOptionSet(statusOptions, taskorg2Filters.status, taskorg2FilterKnownOptions.status);
    makeRow('ステータス', statusOptions, taskorg2Filters.status, v => `${v} (${countActiveTasksByField('ステータス', v)}/${countTasksByField('ステータス', v)})`);

    const otherRow = document.createElement('div');
    otherRow.className = 'triage-filter-row';
    const otherLbl = document.createElement('span');
    otherLbl.className = 'triage-filter-label';
    otherLbl.textContent = 'その他フィルタ';
    otherRow.appendChild(otherLbl);

    [
        { key: 'showProject',         label: 'プロジェクト' },
        { key: 'showRecurringParent', label: '繰返しテンプレート' },
        { key: 'showRecurringChild',  label: '繰返し実行タスク' },
    ].forEach(({ key, label }) => {
        const cbLabel = document.createElement('label');
        cbLabel.className = 'calendar-checkbox-label';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = taskorg2Filters[key];
        cb.addEventListener('change', () => {
            taskorg2Filters[key] = cb.checked;
            renderCalendar2();
        });
        cbLabel.append(cb, document.createTextNode(label));
        otherRow.appendChild(cbLabel);
    });
    area.appendChild(otherRow);

    // プロジェクト＝最上位の親IDのタイトルをボタンとして表示（中間階層の親IDは束ねてカウント、旧タスク整理と同様の選び方）
    const projectRowsSorted = [...getTaskorg2ProjectRootRows()]
        .sort((a, b) => countTaskorg2ProjectTasks(String(b['ID']), false) - countTaskorg2ProjectTasks(String(a['ID']), false));
    const projectIds = projectRowsSorted.map(r => String(r['ID']));
    seedFilterOptionSet(projectIds, taskorg2Filters.project, taskorg2FilterKnownOptions.project);
    makeRow('プロジェクト', projectIds, taskorg2Filters.project, id => {
        const row = projectRowsSorted.find(r => String(r['ID']) === id);
        return `${row ? (row['タイトル'] || `#${id}`) : `#${id}`} (${countTaskorg2ProjectTasks(id, true)}/${countTaskorg2ProjectTasks(id, false)})`;
    });

    const drilldownContainer = document.createElement('div');
    drilldownContainer.className = 'calendar-project-drilldown';
    area.appendChild(drilldownContainer);
    // PJ(1層)の選択肢は、プロジェクトのチェックボックスで選択中のものだけに絞る
    const checkedRootProjectRows = projectRowsSorted.filter(r => taskorg2Filters.project.has(String(r['ID'])));
    // チェックを外した結果、ドリルダウンの選択中PJ(1層)が選択肢から外れた場合は選択状態をクリアする
    if (taskorg2ProjectDrilldownPath[0] && !checkedRootProjectRows.some(r => String(r['ID']) === taskorg2ProjectDrilldownPath[0])) {
        taskorg2ProjectDrilldownPath = [];
    }
    renderTaskorg2ProjectDrilldown(drilldownContainer, checkedRootProjectRows);
}

/**
 * プロジェクトフィルタ下のPJ(n層)ドリルダウンを描画する。PJ(1層)はプロジェクトのチェックボックスで選択中の
 * プロジェクトのみを選択肢とし、選択するとその子タスク一覧がタスクリストに反映されると同時に、
 * その子の中から選ぶPJ(2層)が追加される。未選択のプルダウンに達したら打ち切り、
 * taskorg2ProjectDrilldownPathを選択中ID列（ルート→現在階層）で保持する。
 */
function renderTaskorg2ProjectDrilldown(container, rootProjectRowsSorted) {
    container.innerHTML = '';

    let level = 0;
    let parentId = ''; // 空文字ならこのレベルはルート階層（チェック済みPJ一覧）の選択肢を出す
    for (;;) {
        const options = level === 0
            ? rootProjectRowsSorted
            : sortProject2OptionsByDescendantCountDesc(getChildrenM(currentMainData, parentId));
        const currentValue = taskorg2ProjectDrilldownPath[level] || '';
        const levelForClosure = level;

        appendProject2DropdownRow(container, `PJ(${level + 1}層)`, decorateProjectDropdownOptions(options), currentValue, value => {
            taskorg2ProjectDrilldownPath = value
                ? [...taskorg2ProjectDrilldownPath.slice(0, levelForClosure), value]
                : taskorg2ProjectDrilldownPath.slice(0, levelForClosure);
            renderCalendar2();
        });

        if (!currentValue) break; // このレベルで何も選ばれていなければ、これ以上下の階層は出さない
        parentId = currentValue;
        level++;
    }
}

/** 新タスク整理のタスク一覧テーブルを描画する。行クリックで編集対象を切り替える。 */
/**
 * タスク整理一番下の「タスク一覧」表を描画する。行クリックで編集対象を切り替える。
 * 左端にチェックボックスを配置し、複数選択→編集エリアの「適用」でPJ(n層)などをまとめて変更したり、
 * 「削除」でまとめて削除したりできる（階層整理の「兄弟を選択して一括移動」の代替）。
 */
function renderTaskorg2List() {
    const table = document.getElementById('calendar2-task-list-table');
    if (!table) return;

    const tasks = getTaskorg2FilteredList();
    table.className = 'data-table';
    const cols = ['ID', 'データ区分', 'タイトル', 'ステータス', '親ID', '開始予定', '終了予定', '完了日'];

    // このエリアに実在しなくなったチェック済みIDは選択から外す（フィルタ変更等で一覧から消えたタスク対策）
    pruneTaskorg2Selection(selectedTaskorg2ListIds, new Set(tasks.map(r => String(r['ID']))));

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    const thCheck = document.createElement('th');
    thCheck.style.width = '32px';
    hRow.appendChild(thCheck);
    cols.forEach(col => { const th = document.createElement('th'); th.textContent = col; hRow.appendChild(th); });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    tasks.forEach(row => {
        const rowId = String(row['ID']);
        const tr = document.createElement('tr');
        if (rowId === selectedTaskorg2Id) tr.classList.add('selected-row');

        const tdCheck = document.createElement('td');
        tdCheck.style.textAlign = 'center';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = selectedTaskorg2ListIds.has(rowId);
        checkbox.addEventListener('click', (e) => e.stopPropagation());
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                selectedTaskorg2ListIds.add(rowId);
                // チェックを入れたタスクを編集エリアのアクティブ対象にする
                selectedTaskorg2Id = rowId;
                taskorg2QuickNewMode = false;
                renderTaskorg2TaskChange();
            } else {
                selectedTaskorg2ListIds.delete(rowId);
            }
        });
        tdCheck.appendChild(checkbox);
        tr.appendChild(tdCheck);

        cols.forEach(col => { const td = document.createElement('td'); td.textContent = row[col] ?? ''; tr.appendChild(td); });
        tr.addEventListener('click', () => { selectedTaskorg2Id = rowId; taskorg2QuickNewMode = false; renderTaskorg2TaskChange(); });
        tbody.appendChild(tr);
    });

    table.replaceChildren(thead, tbody);
}

/**
 * タスク整理「PJ一括編集」の PJ(n層) 階層プルダウンを描画する。編集エリアの階層プルダウン
 * （renderDayedit2ParentDropdowns）と同じ操作感（どの階層でも「＋ 新規PJを追加」でその場に新規プロジェクトを
 * 作成できる）だが、選択状態は taskorg2BulkPjPath として個別編集フォームとは独立に持つ。
 * 「PJ一括編集」ボタンはここで選んだ親IDだけをチェックボックス選択中の全タスクへ適用し、
 * タイトル・ステータスなど他の属性には一切触れない。
 */
function renderTaskorg2BulkPjDropdowns() {
    const container = document.getElementById('calendar2-bulk-pj-dropdowns');
    if (!container) return;
    container.innerHTML = '';

    const eligibleRows = getParentEligibleRows(null);
    const newPjExtraOption = [{ value: NEW_PJ_MARK, label: '＋ 新規PJを追加' }];

    let level = 0;
    let parentId = ''; // 空文字ならこのレベルはルート階層（親ID空欄）の選択肢を出す
    for (;;) {
        const options = sortProject2OptionsByDescendantCountDesc(level === 0
            ? eligibleRows.filter(r => !r['親ID'] && (isParentRowM(currentMainData, r['ID']) || String(r['ID']) === taskorg2BulkPjPath[0]))
            : getChildrenM(eligibleRows, parentId));

        const currentValue = taskorg2BulkPjPath[level] || '';
        const levelForClosure = level;
        const parentIdForClosure = parentId;
        appendProject2DropdownRow(container, `PJ(${level + 1}層)`, decorateProjectDropdownOptions(options), currentValue, value => {
            if (value === NEW_PJ_MARK) {
                const newId = createNewProjectViaPrompt(parentIdForClosure);
                if (newId) taskorg2BulkPjPath = [...taskorg2BulkPjPath.slice(0, levelForClosure), newId];
                renderTaskorg2BulkPjDropdowns();
                return;
            }
            taskorg2BulkPjPath = value ? buildProject2PathFromId(value) : taskorg2BulkPjPath.slice(0, levelForClosure);
            renderTaskorg2BulkPjDropdowns();
        }, newPjExtraOption);

        if (!currentValue) break; // このレベルで何も選ばれていなければ、これ以上下の階層は出さない
        parentId = currentValue;
        level++;
    }
}

/**
 * 「PJ一括編集」ボタン: いずれかのチェックボックス一覧（タスク一覧・対応中／対応待ち／属性未設定・繰返し子タスク）で
 * 選択中の全タスクへ、上記PJ(n層)プルダウンで選んだ親IDだけを一括適用する。タイトル・内容・ステータスなど
 * 他の属性には一切触れない（dayedit2-apply-btnの一括適用とは異なり、編集フォームの内容をコピーしない）。
 */
document.getElementById('calendar2-bulk-pj-apply-btn')?.addEventListener('click', () => {
    const bulkIds = getTaskorg2BulkSelectedIds();
    if (bulkIds.size === 0) { alert('先にタスク一覧などでタスクにチェックを入れてください'); return; }

    const parentId = taskorg2BulkPjPath[taskorg2BulkPjPath.length - 1] || '';
    const rows = [...bulkIds].map(id => currentMainData.find(r => String(r['ID']) === id)).filter(Boolean);
    if (rows.some(row => !checkParentCycleOrAlert(row['ID'], parentId))) return;

    const ts = formatJpDatetime(new Date());
    rows.forEach(row => { row['親ID'] = parentId; row['更新日時'] = ts; });
    clearAllTaskorg2BulkSelections(); // 適用後はチェックボックスを解除し、次回の一括操作に前回の選択が持ち越されないようにする
    persistLocalCache();
    renderCalendar2();
    renderTaskRunner();
});

/**
 * タスク整理「繰返しタスク」Expander用: カテゴリ・タグ・ステータス・プロジェクト（親ID・ドリルダウン）の
 * taskorg2フィルタを適用した繰返し親タスク（テンプレート）一覧を返す。旧繰返しエリア専用のフィルタ
 * （recurringFilters）の代わりに、タスク整理共通のフィルタで絞り込めるようにする。
 * ただし「繰返し親タスク／繰返し子タスクの表示ON/OFF」はカレンダー・一覧側の表示制御用のため、
 * この繰返し管理エリア自体には適用しない（OFFでも常に一覧できるようにする）。
 */
function getTaskorg2RecurringParentRows() {
    return getFilteredMainData().filter(r =>
        isRecurringParentRow(r) &&
        matchesFilterValue(taskorg2Filters.tag, r['タグ']) &&
        matchesFilterValue(taskorg2Filters.status, r['ステータス']) &&
        matchesProjectRootFilter(r, taskorg2Filters.project) &&
        matchesProjectDrilldownFilter(r, taskorg2ProjectDrilldownPath)
    );
}

/** タスク整理「繰返しタスク」Expanderの「基準日」入力欄が未設定の場合のみ、当日をデフォルト値としてセットする。 */
function ensureCalendar2RecurringManualDateDefault() {
    const el = document.getElementById('calendar2-recurring-manual-date');
    if (!el || el.value) return;
    const t = new Date();
    const pad = n => String(n).padStart(2, '0');
    el.value = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/** タスク整理「繰返しタスク」Expanderの「基準日」入力欄の値をDateオブジェクトで返す（未入力時は今日）。 */
function getCalendar2RecurringManualDate() {
    const value = document.getElementById('calendar2-recurring-manual-date')?.value || '';
    const [y, m, d] = value.split('-').map(Number);
    return (y && m && d) ? new Date(y, m - 1, d) : new Date();
}

// タスク整理「繰返しタスク」Expanderで、右側（子タスク一覧）の表示対象として選択中の親タスクID
let selectedTaskorg2RecurringParentId = null;
let taskorg2RecurringChart = null;
let taskorg2RecurringChartVisible = false; // 実績グラフは既定非表示。「実績グラフ」ボタンで表示切り替え
// 右側（子タスク一覧）でチェックボックスにより複数選択中の子タスクID集合（適用／削除ボタンの一括操作対象）
const selectedTaskorg2RecurringChildIds = new Set();
// 「対応中タスク（期間内）」「対応待ちタスク（期間外）」「属性未設定タスク」「タスク一覧」でチェックボックスにより
// 複数選択中のタスクID集合（エリアごとに独立。適用／削除ボタンの一括操作対象）
const selectedTaskorg2InProgressIds = new Set();
const selectedTaskorg2WaitingIds    = new Set();
const selectedTaskorg2UnsetIds      = new Set();
const selectedTaskorg2ListIds       = new Set();
// 「プロジェクト」ツリービューでチェックボックスにより複数選択中の行ID集合（親・子いずれの階層でも選択可）
const selectedTaskorg2ProjectTreeIds = new Set();

/** 上記6つの複数選択集合すべての和集合を返す（編集エリアの「適用」「削除」ボタンの一括操作対象の判定に使う）。 */
function getTaskorg2BulkSelectedIds() {
    return new Set([
        ...selectedTaskorg2RecurringChildIds,
        ...selectedTaskorg2InProgressIds,
        ...selectedTaskorg2WaitingIds,
        ...selectedTaskorg2UnsetIds,
        ...selectedTaskorg2ListIds,
        ...selectedTaskorg2ProjectTreeIds,
    ]);
}

/** selectionSet から、validIds に含まれなくなったID（フィルタ変更等で一覧から消えたタスク）を取り除く。 */
function pruneTaskorg2Selection(selectionSet, validIds) {
    [...selectionSet].forEach(id => { if (!validIds.has(id)) selectionSet.delete(id); });
}

/**
 * 「繰返しタスク」Expanderの件数バッジだけを更新する。Expanderが閉じている間も件数は常に見えるようにするため、
 * 中身（親子一覧・チャート）を描画する renderTaskorg2RecurringList とは別に、軽量に呼べるようにしている。
 */
function updateTaskorg2RecurringCount() {
    setExpanderCount('calendar2-recurring-count', getTaskorg2RecurringParentRows().length);
}

/**
 * タスク整理「繰返しタスク」Expanderを描画する。繰返しエリアと同様に左＝親タスク・右＝選択中の親の
 * 子タスクをボタン（チップ）形式で配置する。ボタンのクリックはタスク整理の編集エリアと選択状態を
 * リンクする（通常タスクの一覧・カレンダーと同じ selectedTaskorg2Id を共有する）。
 * 頻度が今日に該当する親タスクは赤枠（calendar-unscheduled-chip--today-match）で強調する。
 */
function renderTaskorg2RecurringList() {
    const parentListEl = document.getElementById('calendar2-recurring-parent-list');
    const childListEl  = document.getElementById('calendar2-recurring-child-list');
    if (!parentListEl || !childListEl) return;

    ensureCalendar2RecurringManualDateDefault();
    renderTaskorg2RecurringChart();
    const today = new Date();
    const pool = getFilteredMainData();
    const childCountOf = parentId => pool.filter(r => r['親ID'] === parentId).length;

    // 表示順: 頻度が今日に該当するもの（赤枠）を先頭に、その中では子タスクが多いものほど上に来るようにする
    const parents = getTaskorg2RecurringParentRows().sort((a, b) => {
        const todayDiff = Number(matchesSchedule(b, today)) - Number(matchesSchedule(a, today));
        if (todayDiff !== 0) return todayDiff;
        return childCountOf(String(b['ID'])) - childCountOf(String(a['ID']));
    });
    setExpanderCount('calendar2-recurring-count', parents.length);

    // 選択中の親タスクがフィルタ等で一覧から外れた場合は選択解除する
    if (selectedTaskorg2RecurringParentId && !parents.some(r => String(r['ID']) === selectedTaskorg2RecurringParentId)) {
        selectedTaskorg2RecurringParentId = null;
    }

    parentListEl.innerHTML = '';
    if (parents.length === 0) {
        const p = document.createElement('p');
        p.className = 'calendar-empty-text';
        p.textContent = '登録済みの繰り返しタスクがありません';
        parentListEl.appendChild(p);
    } else {
        parents.forEach(row => {
            const rowId = String(row['ID']);

            const wrap = document.createElement('span');
            wrap.className = 'calendar-unscheduled-chip-wrap';

            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `calendar-unscheduled-chip ${getCalendarStatusClass(row['ステータス'])}`;
            if (matchesSchedule(row, today)) chip.classList.add('calendar-unscheduled-chip--today-match');
            // 右側（子タスク一覧）の表示対象になっている親タスクを、太い黒枠でひと目でわかるようにする
            if (rowId === selectedTaskorg2RecurringParentId) chip.classList.add('calendar-unscheduled-chip--active-outline');
            chip.title = `${row['タイトル'] || '（無題）'}（${formatRecurringFrequencyLabel(row)}）`;
            appendChipLabel(chip, row, row['タイトル'] || '（無題）');
            chip.addEventListener('click', () => {
                if (selectedTaskorg2RecurringParentId !== rowId) selectedTaskorg2RecurringChildIds.clear(); // 親を切り替えたら子の複数選択はリセットする
                selectedTaskorg2RecurringParentId = rowId;
                selectedTaskorg2Id = rowId;
                taskorg2QuickNewMode = false;
                renderTaskorg2TaskChange();
            });
            wrap.appendChild(chip);

            // 「基準日」入力欄の日付を基準に子タスクを「進行中」で生成する（繰返しエリアの実行タスク生成と同じ挙動）
            const addBtn = document.createElement('button');
            addBtn.type = 'button';
            addBtn.className = 'calendar-unscheduled-chip-add calendar-unscheduled-chip-add--green';
            addBtn.title = '基準日を基準に実行タスクを「進行中」で生成';
            addBtn.textContent = '+';
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const children = generateChildManually(row, currentMainData, getCalendar2RecurringManualDate());
                if (children.length === 0) { alert('指定日分は既に生成済みです'); return; }
                const ts = formatJpDatetime(new Date());
                children.forEach(child => { child['ステータス'] = '進行中'; child['更新日時'] = ts; });
                currentMainData.push(...children);
                persistLocalCache();
                selectedTaskorg2RecurringParentId = rowId;
                renderTaskorg2RecurringList();
                renderTaskRunner();
            });
            wrap.appendChild(addBtn);

            parentListEl.appendChild(wrap);
        });
    }

    childListEl.innerHTML = '';
    if (!selectedTaskorg2RecurringParentId) {
        const p = document.createElement('p');
        p.className = 'calendar-empty-text';
        p.textContent = 'テンプレートを選択してください';
        childListEl.appendChild(p);
        return;
    }

    // 基準日が新しいものが上に来るよう並べる（基準日未設定の行はIDの降順で末尾にまとめる）
    const children = getFilteredMainData()
        .filter(r => r['親ID'] === selectedTaskorg2RecurringParentId)
        .sort((a, b) => {
            const da = a['繰返し基準日'], db = b['繰返し基準日'];
            if (!da && !db) return parseInt(b['ID'], 10) - parseInt(a['ID'], 10);
            if (!da) return 1;
            if (!db) return -1;
            return db.localeCompare(da);
        });

    // 表示対象外になった子タスクのチェックは外しておく（親を切り替えた後の混入防止）
    const childIds = new Set(children.map(r => String(r['ID'])));
    [...selectedTaskorg2RecurringChildIds].forEach(id => { if (!childIds.has(id)) selectedTaskorg2RecurringChildIds.delete(id); });

    if (children.length === 0) {
        const p = document.createElement('p');
        p.className = 'calendar-empty-text';
        p.textContent = '実行タスクがありません';
        childListEl.appendChild(p);
        return;
    }

    children.forEach(row => {
        const rowId = String(row['ID']);

        // チェックボックスは、チップ側のoverflow:hidden（角丸クリップ）で見切れないよう、チップの外側（同じ行内）に配置する
        const line = document.createElement('span');
        line.className = 'calendar-unscheduled-chip-line';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'calendar-unscheduled-chip-checkbox';
        checkbox.checked = selectedTaskorg2RecurringChildIds.has(rowId);
        checkbox.addEventListener('click', (e) => e.stopPropagation());
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                selectedTaskorg2RecurringChildIds.add(rowId);
                // チェックを入れた子タスクを編集エリアのアクティブ対象にする
                selectedTaskorg2Id = rowId;
                taskorg2QuickNewMode = false;
                renderTaskorg2TaskChange();
            } else {
                selectedTaskorg2RecurringChildIds.delete(rowId);
            }
        });
        line.appendChild(checkbox);

        const wrap = document.createElement('span');
        wrap.className = 'calendar-unscheduled-chip-wrap';

        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `calendar-unscheduled-chip calendar-unscheduled-chip--solo ${getCalendarStatusClass(row['ステータス'])}`;
        // 編集エリアのアクティブ対象になっている子タスクを、親タスクと同様に太い黒枠で強調する
        if (rowId === selectedTaskorg2Id) chip.classList.add('calendar-unscheduled-chip--active-outline');
        chip.title = row['タイトル'] || '（無題）';
        appendChipLabel(chip, row, row['タイトル'] || '（無題）');
        chip.addEventListener('click', () => {
            selectedTaskorg2Id = rowId;
            taskorg2QuickNewMode = false;
            renderTaskorg2TaskChange();
        });
        wrap.appendChild(chip);
        line.appendChild(wrap);

        childListEl.appendChild(line);
    });
}

/**
 * タスク整理「繰返しタスク」Expanderの実績グラフを描画する（繰返しエリアの実績グラフと同じロジックを移植）。
 * 選択中の親タスクの子タスクの実績時間推移をChart.jsで表示する。「実績グラフ」ボタンで表示中のときのみ描画する。
 */
function renderTaskorg2RecurringChart() {
    const wrap = document.getElementById('calendar2-recurring-chart-wrap');
    if (!wrap) return;

    if (taskorg2RecurringChart) { taskorg2RecurringChart.destroy(); taskorg2RecurringChart = null; }
    wrap.innerHTML = '';
    wrap.style.display = taskorg2RecurringChartVisible ? '' : 'none';
    if (!taskorg2RecurringChartVisible) return;

    if (!selectedTaskorg2RecurringParentId) {
        const p = document.createElement('p');
        p.className   = 'placeholder-text';
        p.textContent = 'テンプレートを選択するとグラフが表示されます';
        wrap.appendChild(p);
        return;
    }

    const children  = currentMainData.filter(r => r['親ID'] === selectedTaskorg2RecurringParentId);
    const chartData = buildChildChartData(children);
    const dataMinutes = chartData.data.map(h => Math.round(h * 60));

    if (chartData.labels.length > 0 && window.Chart) {
        const canvas = document.createElement('canvas');
        wrap.appendChild(canvas);
        taskorg2RecurringChart = new window.Chart(canvas, {
            type: 'line',
            data: {
                labels: chartData.labels,
                datasets: [{
                    label: '実績時間 (分)',
                    data:  dataMinutes,
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
                    y: { title: { display: true, text: '実績時間 (分)' }, beginAtZero: true },
                },
            },
        });
    } else {
        const p = document.createElement('p');
        p.className   = 'placeholder-text';
        p.textContent = chartData.labels.length === 0
            ? '実行タスクに実績データがありません'
            : 'Chart.js が読み込まれていません';
        wrap.appendChild(p);
    }
}

document.getElementById('calendar2-recurring-chart-toggle-btn')?.addEventListener('click', () => {
    taskorg2RecurringChartVisible = !taskorg2RecurringChartVisible;
    renderTaskorg2RecurringChart();
});

/**
 * 「繰り返しタスクの親として管理する」チェックボックスの状態に応じて、頻度（月/日/曜日）チップと
 * 備考欄／子タスクテンプレート欄の表示・非表示を切り替える（新タスク整理版）。
 */
function updateDayedit2FreqVisibility() {
    const section = document.getElementById('dayedit2-freq-section');
    const checkbox = document.getElementById('dayedit2-recurring-parent');
    const isParent = !!(checkbox && checkbox.checked);
    if (section) section.style.display = isParent ? '' : 'none';

    const bikoSectionEl     = document.getElementById('dayedit2-biko-section');
    const templateSectionEl = document.getElementById('dayedit2-template-section');
    if (bikoSectionEl)     bikoSectionEl.style.display     = isParent ? 'none' : '';
    if (templateSectionEl) templateSectionEl.style.display = isParent ? '' : 'none';
}

/** 新タスク整理・編集パネルの頻度（月/日/曜日）チップを描画する。 */
function renderDayedit2FreqChips() {
    renderFreqChipsFor('dayedit2', dayedit2Freq);
}

/**
 * 新タスク整理・編集パネルの実行タスクテンプレート一覧を、1行1テンプレートの表形式で描画する
 * （dayedit2Templatesを直接編集するDOM行を生成）。列は「開始予定」「終了予定」「タイトル」「内容（省略可）」。
 * 開始予定・終了予定は基準日からのオフセット日数（±の整数）で、テンプレートごとに個別に指定できる。
 */
function renderDayedit2Templates() {
    const list = document.getElementById('dayedit2-template-list');
    if (!list) return;

    const table = document.createElement('table');
    table.className = 'data-table recur-template-table';

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    ['開始予定', '終了予定', 'タイトル', '内容（省略可）', ''].forEach(text => {
        const th = document.createElement('th');
        th.textContent = text;
        hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    if (dayedit2Templates.length === 0) {
        const emptyRow = document.createElement('tr');
        const emptyTd = document.createElement('td');
        emptyTd.className = 'empty-cell';
        emptyTd.colSpan = 5;
        emptyTd.textContent = 'テンプレートがありません';
        emptyRow.appendChild(emptyTd);
        tbody.appendChild(emptyRow);
    }
    dayedit2Templates.forEach((template, index) => {
        const row = document.createElement('tr');

        const startTd = document.createElement('td');
        const startInput = document.createElement('input');
        startInput.type  = 'number';
        startInput.step  = '1';
        startInput.title = '基準日からの相対日数（例: -7で1週間前、0で当日）';
        startInput.value = template.startOffsetDays;
        startInput.addEventListener('input', () => {
            template.startOffsetDays = parseInt(startInput.value, 10) || 0;
        });
        startTd.appendChild(startInput);
        row.appendChild(startTd);

        const endTd = document.createElement('td');
        const endInput = document.createElement('input');
        endInput.type  = 'number';
        endInput.step  = '1';
        endInput.title = '基準日からの相対日数（例: -7で1週間前、0で当日）';
        endInput.value = template.endOffsetDays;
        endInput.addEventListener('input', () => {
            template.endOffsetDays = parseInt(endInput.value, 10) || 0;
        });
        endTd.appendChild(endInput);
        row.appendChild(endTd);

        const suffixTd = document.createElement('td');
        const suffixInput = document.createElement('input');
        suffixInput.type = 'text';
        suffixInput.placeholder = '例: 資料作成';
        suffixInput.value = template.titleSuffix;
        suffixInput.addEventListener('input', () => { template.titleSuffix = suffixInput.value; });
        suffixTd.appendChild(suffixInput);
        row.appendChild(suffixTd);

        const contentTd = document.createElement('td');
        const contentInput = document.createElement('input');
        contentInput.type = 'text';
        contentInput.placeholder = '省略時は親の内容を使用';
        contentInput.value = template.content;
        contentInput.addEventListener('input', () => { template.content = contentInput.value; });
        contentTd.appendChild(contentInput);
        row.appendChild(contentTd);

        const removeTd = document.createElement('td');
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'recur-template-remove-btn';
        removeBtn.textContent = '削除';
        removeBtn.addEventListener('click', () => {
            dayedit2Templates.splice(index, 1);
            renderDayedit2Templates();
        });
        removeTd.appendChild(removeBtn);
        row.appendChild(removeTd);

        tbody.appendChild(row);
    });
    table.appendChild(tbody);

    list.replaceChildren(table);
}

document.getElementById('dayedit2-template-add-btn')?.addEventListener('click', () => {
    dayedit2Templates.push({ startOffsetDays: 0, endOffsetDays: 0, titleSuffix: '', content: '' });
    renderDayedit2Templates();
});

document.getElementById('dayedit2-recurring-parent')?.addEventListener('change', (e) => {
    // チェックを入れた直後、テンプレートが1件も無ければ既定の1件（オフセット0）を用意する
    if (e.target.checked && dayedit2Templates.length === 0) {
        dayedit2Templates = parseChildTemplates('');
        renderDayedit2Templates();
    }
    updateDayedit2FreqVisibility();
});

/** ステータスを「完了」に変更したら、完了日を自動的に本日の日付にする（新タスク整理版）。既に完了日が入力済みなら上書きしない。 */
document.getElementById('dayedit2-status')?.addEventListener('change', (e) => {
    if (e.target.value !== '完了') return;
    const completeEl = document.getElementById('dayedit2-complete-date');
    if (!completeEl || completeEl.value) return;
    const today = new Date();
    const pad = n => String(n).padStart(2, '0');
    completeEl.value = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
});

/** 開始予定の日付を入力したら、終了予定の日付に同じ日付を自動セットする（新タスク整理版）。手動で修正可能。 */
function autoFillTaskorg2EndDate() {
    const startDateEl = document.getElementById('dayedit2-start-date');
    const endDateEl   = document.getElementById('dayedit2-end-date');
    if (!startDateEl.value) return;
    endDateEl.value = startDateEl.value;
}
document.getElementById('dayedit2-start-date')?.addEventListener('change', autoFillTaskorg2EndDate);

/** 開始予定の時間を入力したら、開始予定の分を0に、終了予定の時間を+1・分を0に自動セットする（新タスク整理版。日付は見ない）。手動で修正可能。 */
function autoFillTaskorg2EndTime() {
    const startHourEl   = document.getElementById('dayedit2-start-hour');
    const startMinuteEl = document.getElementById('dayedit2-start-minute');
    const endHourEl     = document.getElementById('dayedit2-end-hour');
    const endMinuteEl   = document.getElementById('dayedit2-end-minute');
    if (startHourEl.value === '') return;

    startMinuteEl.value = 0;
    endHourEl.value     = (Number(startHourEl.value) + 1) % 24;
    endMinuteEl.value   = 0;
}
document.getElementById('dayedit2-start-hour')?.addEventListener('change', autoFillTaskorg2EndTime);

/** 「開始/終了リセット」ボタン（新タスク整理版）: 開始予定・終了予定の日付・時・分をまとめて空欄に戻す。 */
document.getElementById('dayedit2-reset-start-end-btn')?.addEventListener('click', () => {
    ['start-date', 'start-hour', 'start-minute', 'end-date', 'end-hour', 'end-minute'].forEach(f => {
        const el = document.getElementById(`dayedit2-${f}`);
        if (el) el.value = '';
    });
});

/** 「完了日を開始/終了予定に代入」ボタン（新タスク整理版）: 完了日が入力済みで、開始予定・終了予定の空欄になっている方だけに完了日（時間帯なし）を代入する。 */
document.getElementById('dayedit2-fill-date-from-complete-btn')?.addEventListener('click', () => {
    const completeDate = document.getElementById('dayedit2-complete-date').value;
    if (!completeDate) return;

    const startDateEl = document.getElementById('dayedit2-start-date');
    const endDateEl   = document.getElementById('dayedit2-end-date');
    if (!startDateEl.value) startDateEl.value = completeDate;
    if (!endDateEl.value)   endDateEl.value   = completeDate;
});

/**
 * 「繰り返しタスクの親として管理する」チェックボックスがONなら、target を繰り返しタスクの親として
 * 繰返し識別子・繰返し頻度_月/日/曜日 を設定する。OFFなら関連フィールドを空にする（新タスク整理版）。
 */
function applyRecurringFieldsFromForm2(target) {
    const isRecurringParent = document.getElementById('dayedit2-recurring-parent')?.checked;
    if (isRecurringParent) {
        target['繰返し識別子']   = '1';
        target['繰返し頻度_月']  = [...dayedit2Freq.month].join(',');
        target['繰返し頻度_日']  = [...dayedit2Freq.day].join(',');
        target['繰返し頻度_曜日'] = [...dayedit2Freq.weekday].join(',');
        target['備考']           = stringifyChildTemplates(dayedit2Templates); // 親タスクは備考欄を子タスクテンプレートの保存に使う
    } else {
        target['繰返し識別子']   = '';
        target['繰返し頻度_月']  = '';
        target['繰返し頻度_日']  = '';
        target['繰返し頻度_曜日'] = '';
    }
}

/**
 * 新規登録モード（未選択）の際、編集フォームを既定値へリセットする。
 * - 開始予定・終了予定の日付: 選択中のカレンダー日付（「新規登録」ボタン起動時＝taskorg2QuickNewModeは空欄のまま）
 * - タグ: カレンダーで絞り込み中の値が1つだけならそれを初期値にする
 */
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

    dayedit2Freq.month.clear();
    dayedit2Freq.day.clear();
    dayedit2Freq.weekday.clear();
    const recurringCheckbox = document.getElementById('dayedit2-recurring-parent');
    if (recurringCheckbox) recurringCheckbox.checked = false;
    dayedit2Templates = [];
    renderDayedit2Templates();

    dayedit2ParentPath = [];
    ['start-hour', 'start-minute', 'end-hour', 'end-minute', 'complete-date'].forEach(f => {
        const el = document.getElementById(`dayedit2-${f}`);
        if (el) el.value = '';
    });

    // 「新規登録」ボタンから起動した場合は、日付をカレンダー選択日で埋めずに空欄のままにする
    const dateValue = (!taskorg2QuickNewMode && selectedTaskorg2Date) ? selectedTaskorg2Date.replace(/\//g, '-') : '';
    const startDateEl = document.getElementById('dayedit2-start-date');
    if (startDateEl) startDateEl.value = dateValue;
    const endDateEl = document.getElementById('dayedit2-end-date');
    if (endDateEl) endDateEl.value = dateValue;

    // タグが1つだけ選択されている場合のみ、新規タスクの初期値として反映する
    const tagEl = document.getElementById('dayedit2-tag');
    if (tagEl) tagEl.value = taskorg2Filters.tag.size === 1 ? [...taskorg2Filters.tag][0] : '';

    document.getElementById('dayedit2-estimate').value = '';
    document.getElementById('dayedit2-actual').value   = '';

    const timerSection = document.getElementById('dayedit2-timer-section');
    if (timerSection) timerSection.style.display = 'none';
}

/** タスク整理・進行中タスクのタイマー表示（累計時間・実績時間）のみを更新する（他の未適用の入力値は保持するため、フォーム全体は再描画しない）。 */
function updateDayedit2TimerDisplay() {
    const row = currentMainData.find(r => String(r['ID']) === selectedTaskorg2Id);
    if (!row) return;
    const elapsedEl = document.getElementById('dayedit2-timer-elapsed');
    if (elapsedEl) elapsedEl.textContent = formatDuration(computeTotalDuration(row['ID']));
    const actualEl = document.getElementById('dayedit2-actual');
    if (actualEl) actualEl.value = String(computeActualMinutes(row));
    const running = isLogRunning(row['タイムスタンプログ']);
    const startBtn = document.getElementById('dayedit2-timer-start-btn');
    if (startBtn) startBtn.disabled = running;
    const stopBtn = document.getElementById('dayedit2-timer-stop-btn');
    if (stopBtn) stopBtn.disabled = !running;
}

/** 新タスク整理の編集フォーム（選択中行、または新規登録モード）を描画する。 */
function renderTaskorg2Edit() {
    populateTaskEditSelects2('dayedit2');

    const row = currentMainData.find(r => String(r['ID']) === selectedTaskorg2Id);
    if (!row) {
        clearTaskorg2EditForm();
        renderDayedit2ParentDropdowns();
        renderDayedit2FreqChips();
        updateDayedit2FreqVisibility();
        setDayedit2BatchSyncVisibility(false);
        return;
    }

    const isParentRow = isRecurringParentRow(row);

    document.getElementById('dayedit2-id').value       = row['ID'];
    document.getElementById('dayedit2-title').value    = row['タイトル'] || '';
    document.getElementById('dayedit2-content').value  = row['内容'] || '';
    document.getElementById('dayedit2-biko').value     = isParentRow ? '' : (row['備考'] || '');
    document.getElementById('dayedit2-status').value   = row['ステータス'] || '';
    document.getElementById('dayedit2-priority').value = row['優先度'] || '';
    document.getElementById('dayedit2-category').value = row['カテゴリ'] || '';
    document.getElementById('dayedit2-tag').value      = row['タグ'] || '';
    dayedit2ParentPath = buildProject2PathFromId(row['親ID']);
    renderDayedit2ParentDropdowns();
    writeTaskDateTimeFieldsToForm('dayedit2', row);
    writeTaskEstimateActualToForm('dayedit2', row, 'minutes');

    dayedit2Templates = isParentRow ? parseChildTemplates(row['備考']) : [];
    renderDayedit2Templates();

    const recurringCheckbox = document.getElementById('dayedit2-recurring-parent');
    if (recurringCheckbox) recurringCheckbox.checked = isParentRow;
    loadFreqStateFromRow(dayedit2Freq, row);
    renderDayedit2FreqChips();
    updateDayedit2FreqVisibility();

    const timerSection = document.getElementById('dayedit2-timer-section');
    if (timerSection) {
        timerSection.style.display = '';
        const logEl = document.getElementById('dayedit2-timer-log');
        if (logEl) logEl.value = row['タイムスタンプログ'] || '';
        const adjEl = document.getElementById('dayedit2-timer-adjust');
        if (adjEl) adjEl.value = row['補正時間'] || '';
        updateDayedit2TimerDisplay();
    }

    setDayedit2BatchSyncVisibility(!isParentRow && !!row['繰返し基準日']);
}

/** 「新タスク整理」タブ全体（フィルタ・カレンダー・一覧・編集フォーム・子一覧）を再描画する。 */
function renderCalendar2() {
    renderTaskorg2Filters();
    renderTaskorg2ViewToggle();
    // カレンダー／ガントは実際に表示中のビューのみ再描画する（両方は不要）
    if (taskorg2View === 'calendar') renderTaskorg2CalendarGrid();
    renderTaskorg2GanttUnitToggle();
    if (taskorg2View === 'gantt') renderTaskorg2GanttChart();
    if (taskorg2View === 'weekboard') renderTaskorg2WeekBoard();
    if (taskorg2View === 'workcal') renderWorkCalendar();
    if (taskorg2View === 'project') renderTaskorg2ProjectTree();
    renderTaskorg2Timeline();
    renderTaskorg2UnsetSection();
    renderTaskorg2List();
    renderTaskorg2BulkPjDropdowns();
    // 「繰返しタスク」Expanderの中身（親子一覧・チャート）は、パフォーマンスのため開いている時だけ再描画する
    // （閉じている間はスキップ、開いた瞬間はtoggleイベント側で描画）。ただし件数バッジは常に最新化する。
    updateTaskorg2RecurringCount();
    if (document.getElementById('calendar2-recurring-toggle')?.open) renderTaskorg2RecurringList();
    renderTaskorg2Edit();
}

/**
 * カレンダー／ガントの「日付」だけを選び直した時の軽量再描画。フィルタ・タスク一覧は選択日に依存しないため
 * 再描画不要（重いため省略）。ビュー(カレンダー/ガント)・タイムライン・対応中タスク（期間内）のみ更新する。
 */
function renderTaskorg2DateChange() {
    if (taskorg2View === 'calendar') renderTaskorg2CalendarGrid(); else renderTaskorg2GanttChart();
    renderTaskorg2Timeline();
    renderTaskorg2UnsetSection();
    renderTaskorg2List();
    renderTaskorg2Edit();
}

/**
 * タスクを選び直した（一覧行・ガント行・タイムライン・未設定チップのクリック）時の軽量再描画。
 * フィルタ・カレンダー本体・ガント本体は選択タスクに依存しないため再描画不要（重いため省略）。
 * 選択ハイライトを持つタイムライン・一覧・未設定チップと、編集フォームのみ更新する。
 */
function renderTaskorg2TaskChange() {
    // ガントチャート／習慣／プロジェクトツリーは選択タスクの行ハイライトを持つため、表示中の場合のみ更新する
    if (taskorg2View === 'gantt') renderTaskorg2GanttChart();
    if (taskorg2View === 'weekboard') renderTaskorg2WeekBoard();
    if (taskorg2View === 'project') renderTaskorg2ProjectTree();
    renderTaskorg2Timeline();
    renderTaskorg2UnsetSection();
    renderTaskorg2List();
    if (document.getElementById('calendar2-recurring-toggle')?.open) renderTaskorg2RecurringList();
    renderTaskorg2Edit();
}

// 繰返しタスク／プロジェクト管理のExpanderを開いた瞬間だけ、その場で再描画する
// （閉じている間はrenderSummary側で再描画をスキップしているため、開いた直後の内容を最新化する目的）
document.getElementById('calendar2-recurring-toggle')?.addEventListener('toggle', (e) => { if (e.target.open) renderTaskorg2RecurringList(); });
document.getElementById('taskorg2-project-admin-table-toggle')?.addEventListener('toggle', (e) => { if (e.target.open) renderProject2AdminTable(); });

document.getElementById('dayedit2-parent-clear-btn')?.addEventListener('click', () => {
    dayedit2ParentPath = [];
    renderDayedit2ParentDropdowns();
});

/** タイマー開始: タイムスタンプログに計測開始マーク（"日時-"）を追記する。 */
document.getElementById('dayedit2-timer-start-btn')?.addEventListener('click', () => {
    const row = currentMainData.find(r => String(r['ID']) === selectedTaskorg2Id);
    if (!row) return;
    const ts = formatJpDatetime(new Date());
    row['タイムスタンプログ'] = (row['タイムスタンプログ'] || '') + `${ts}-`;
    row['更新日時'] = ts;
    persistLocalCache();
    const logEl = document.getElementById('dayedit2-timer-log');
    if (logEl) logEl.value = row['タイムスタンプログ'];
    updateDayedit2TimerDisplay();
});

/** タイマー停止: タイムスタンプログに計測終了マーク（"日時, "）を追記する。 */
document.getElementById('dayedit2-timer-stop-btn')?.addEventListener('click', () => {
    const row = currentMainData.find(r => String(r['ID']) === selectedTaskorg2Id);
    if (!row) return;
    const ts = formatJpDatetime(new Date());
    row['タイムスタンプログ'] = (row['タイムスタンプログ'] || '') + `${ts}, `;
    row['更新日時'] = ts;
    persistLocalCache();
    const logEl = document.getElementById('dayedit2-timer-log');
    if (logEl) logEl.value = row['タイムスタンプログ'];
    updateDayedit2TimerDisplay();
});

document.getElementById('dayedit2-timer-adjust')?.addEventListener('change', (e) => {
    const row = currentMainData.find(r => String(r['ID']) === selectedTaskorg2Id);
    if (!row) return;
    row['補正時間'] = e.target.value;
    persistLocalCache();
    updateDayedit2TimerDisplay();
});

document.getElementById('dayedit2-timer-log')?.addEventListener('change', (e) => {
    const row = currentMainData.find(r => String(r['ID']) === selectedTaskorg2Id);
    if (!row) return;
    row['タイムスタンプログ'] = e.target.value;
    persistLocalCache();
    updateDayedit2TimerDisplay();
});

document.getElementById('calendar2-quick-new-btn')?.addEventListener('click', () => {
    selectedTaskorg2Id = null;
    taskorg2QuickNewMode = true;
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
    applyRecurringFieldsFromForm2(entry);
    Object.assign(entry, readTaskDateTimeFieldsFromForm('dayedit2'));
    entry['作成日時']   = ts;
    entry['更新日時']   = ts;

    currentMainData.push(entry);
    persistLocalCache();

    selectedTaskorg2Id = entry['ID'];
    renderCalendar2();
    renderTaskRunner();
});

/** dayedit2フォームの入力内容を row へ書き戻す（親IDは呼び出し側で循環参照チェック済みのものを渡すこと）。 */
function writeDayedit2FormFieldsToRow(row, parentId) {
    row['タイトル']   = document.getElementById('dayedit2-title').value.trim();
    row['内容']       = document.getElementById('dayedit2-content').value.trim();
    row['備考']       = document.getElementById('dayedit2-biko').value.trim();
    row['ステータス'] = document.getElementById('dayedit2-status').value;
    row['優先度']     = document.getElementById('dayedit2-priority').value;
    row['見積時間']   = document.getElementById('dayedit2-estimate').value;
    row['カテゴリ']   = document.getElementById('dayedit2-category').value;
    row['タグ']       = document.getElementById('dayedit2-tag').value;
    row['親ID']       = parentId;
    applyRecurringFieldsFromForm2(row);
    Object.assign(row, readTaskDateTimeFieldsFromForm('dayedit2'));
    row['更新日時'] = formatJpDatetime(new Date());
}

/**
 * 「グループに適用」ボタン・ヒントの表示切り替え。同時生成された子タスク（繰返し基準日を持つ）を
 * 編集中のときのみ表示する（旧繰返しエリアと同じ条件）。チェックボックスで複数タスクを選択中の場合は、
 * 対象が曖昧になるためボタンを無効化する（非表示にはしない）。
 */
function setDayedit2BatchSyncVisibility(show) {
    const btnEl  = document.getElementById('dayedit2-batch-sync-btn');
    const hintEl = document.getElementById('dayedit2-batch-sync-hint');
    if (btnEl) {
        btnEl.style.display = show ? '' : 'none';
        btnEl.disabled = getTaskorg2BulkSelectedIds().size > 0;
    }
    if (hintEl) hintEl.style.display = show ? '' : 'none';
}

/**
 * 「グループに適用」ボタン: 選択中の子タスクへの変更を適用したうえで、同じ回（親ID＝繰返しテンプレート＋
 * 繰返し基準日が同じ）の他の子タスクへも連動反映する（旧繰返しエリアの同機能を移植）。開始予定・終了予定
 * どちらも「変更前後の日数差分」で扱い、その差分だけグループ全体（編集中タスク自身も含む）の開始予定・
 * 終了予定を平行移動する（＝各タスクの長さ・相対位置を保ったまま全体が動く）。
 * 開始予定と終了予定を両方変更した場合は、開始予定側の差分を優先して使う。
 * チェックボックスで複数タスクを選択中（一括編集モード）の場合は、対象が曖昧になるため何もしない。
 */
function applyDayedit2BatchSync() {
    if (getTaskorg2BulkSelectedIds().size > 0) return; // 複数選択中は動作させない
    if (!selectedTaskorg2Id) return;
    const row = currentMainData.find(r => String(r['ID']) === selectedTaskorg2Id);
    if (!row || isRecurringParentRow(row) || !row['繰返し基準日']) return;

    const parentId = document.getElementById('dayedit2-parent-id').value || '';
    if (!checkParentCycleOrAlert(row['ID'], parentId)) return;

    const oldStartStr  = row['開始予定'];
    const oldEndStr    = row['終了予定'];
    const oldStartDate = parseSlashDateOnly(oldStartStr);
    const oldEndDate   = parseSlashDateOnly(oldEndStr);
    const { 開始予定: newStart, 終了予定: newEnd } = readTaskDateTimeFieldsFromForm('dayedit2');
    const newStartDate = parseSlashDateOnly(newStart);
    const newEndDate   = parseSlashDateOnly(newEnd);

    const deltaStart = (oldStartDate && newStartDate) ? Math.round((newStartDate - oldStartDate) / 86400000) : 0;
    const deltaEnd    = (oldEndDate   && newEndDate)   ? Math.round((newEndDate   - oldEndDate)   / 86400000) : 0;
    const delta = deltaStart !== 0 ? deltaStart : deltaEnd; // 開始予定の差分を優先

    writeDayedit2FormFieldsToRow(row, parentId); // 選択中タスク自身の変更（日付以外も含む）を通常通り適用

    if (delta !== 0) {
        // 編集中タスク自身も、他タスクと同じ delta シフトで開始予定・終了予定を揃え直す
        // （フォームに入力した値そのものではなく、変更前の値からの平行移動として再計算するため、
        //   触っていない側の日付も含めて他タスクと同じだけ動く）
        if (oldStartStr) row['開始予定'] = shiftSlashDateTimeString(oldStartStr, delta);
        if (oldEndStr)   row['終了予定'] = shiftSlashDateTimeString(oldEndStr, delta);

        const siblings = currentMainData.filter(r =>
            r['親ID'] === row['親ID'] &&
            r['繰返し基準日'] === row['繰返し基準日'] &&
            String(r['ID']) !== selectedTaskorg2Id
        );

        const ts = formatJpDatetime(new Date());
        row['更新日時'] = ts;
        siblings.forEach(sib => {
            if (sib['開始予定']) sib['開始予定'] = shiftSlashDateTimeString(sib['開始予定'], delta);
            if (sib['終了予定']) sib['終了予定'] = shiftSlashDateTimeString(sib['終了予定'], delta);
            sib['更新日時'] = ts;
        });
    }

    persistLocalCache();
    renderCalendar2();
    renderTaskRunner();
}

document.getElementById('dayedit2-batch-sync-btn')?.addEventListener('click', applyDayedit2BatchSync);

/** 6つのチェックボックス複数選択集合（繰返し子・対応中・対応待ち・属性未設定・タスク一覧・プロジェクトツリー）をすべてクリアする。 */
function clearAllTaskorg2BulkSelections() {
    selectedTaskorg2RecurringChildIds.clear();
    selectedTaskorg2InProgressIds.clear();
    selectedTaskorg2WaitingIds.clear();
    selectedTaskorg2UnsetIds.clear();
    selectedTaskorg2ListIds.clear();
    selectedTaskorg2ProjectTreeIds.clear();
}

/**
 * 「適用」ボタン: 通常は選択中行へフォーム内容を書き戻す。親IDは循環参照チェックを通過した場合のみ保存する。
 * いずれかのチェックボックス一覧（繰返し子タスク／対応中／対応待ち／属性未設定／タスク一覧）でタスクを複数選択中の場合は、
 * 選択中の全タスクへ同じフォーム内容をまとめて反映する（一括編集）。
 */
document.getElementById('dayedit2-apply-btn')?.addEventListener('click', () => {
    const parentId = document.getElementById('dayedit2-parent-id').value || '';
    const bulkIds = getTaskorg2BulkSelectedIds();

    if (bulkIds.size > 0) {
        const rows = [...bulkIds]
            .map(id => currentMainData.find(r => String(r['ID']) === id))
            .filter(Boolean);
        if (rows.some(row => !checkParentCycleOrAlert(row['ID'], parentId))) return;
        rows.forEach(row => writeDayedit2FormFieldsToRow(row, parentId));
    } else {
        if (!selectedTaskorg2Id) return;
        const row = currentMainData.find(r => String(r['ID']) === selectedTaskorg2Id);
        if (!row) return;
        if (!checkParentCycleOrAlert(row['ID'], parentId)) return;
        writeDayedit2FormFieldsToRow(row, parentId);
    }

    persistLocalCache();
    renderCalendar2();
    renderTaskRunner();
});

/**
 * 「削除」ボタン: 通常は選択中行を削除する（この行を親IDとして参照していた子行は親ID欄を空欄化する）。
 * いずれかのチェックボックス一覧でタスクを複数選択中の場合は、選択中の全タスクをまとめて削除する。
 */
document.getElementById('dayedit2-delete-btn')?.addEventListener('click', () => {
    const bulkIds = getTaskorg2BulkSelectedIds();
    if (bulkIds.size > 0) {
        const targetIds = [...bulkIds];
        if (!confirm(`選択中の${targetIds.length}件のタスクを削除しますか？`)) return;

        targetIds.forEach(id => {
            currentMainData.forEach(r => { if (String(r['親ID'] || '') === id) r['親ID'] = ''; });
        });
        currentMainData = currentMainData.filter(r => !targetIds.includes(String(r['ID'])));
        if (targetIds.includes(selectedTaskorg2Id)) selectedTaskorg2Id = null;
        clearAllTaskorg2BulkSelections();
        persistLocalCache();
        renderCalendar2();
        renderTaskRunner();
        return;
    }

    if (!selectedTaskorg2Id) return;
    if (!confirm('この行を削除しますか？')) return;

    currentMainData.forEach(r => { if (String(r['親ID'] || '') === selectedTaskorg2Id) r['親ID'] = ''; });
    currentMainData = currentMainData.filter(r => String(r['ID']) !== selectedTaskorg2Id);
    persistLocalCache();

    selectedTaskorg2Id = null;
    renderCalendar2();
    renderTaskRunner();
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
// プロジェクト管理（一覧表示・名前変更・統合・表示/非表示・削除）
// 特別な「プロジェクト」区分は無く、他行から親IDとして参照されている行（タスク／ナレッジ問わず）を
// 一覧表示・編集する。
// ===========================================================================

const PROJECT2_HIDDEN_STATUS = '非表示'; // プロジェクトの「非表示」を表すステータス値（ステータス列を表示制御に共用する）

/** プロジェクト管理表用：他行から親IDとして参照されている「最上位（ルート）」の行を、非表示のものも含めて全件返す（繰返しテンプレートは除く）。 */
function getProject2AllParentRowsForAdmin() {
    let rows = currentMainData.filter(r => !r['親ID'] && isParentRowM(currentMainData, r['ID']) && !isRecurringParentRow(r));
    if (currentCategory !== 'すべて') rows = rows.filter(r => r['カテゴリ'] === currentCategory);
    return rows;
}

/** プロジェクト管理表の「統合先」「削除時の再割り当て先」の選択肢用：階層を問わず全プロジェクト（子を持つ行）を返す（繰返しテンプレートは除く）。 */
function getProject2AllProjectRowsFlat() {
    let rows = currentMainData.filter(r => isParentRowM(currentMainData, r['ID']) && !isRecurringParentRow(r));
    if (currentCategory !== 'すべて') rows = rows.filter(r => r['カテゴリ'] === currentCategory);
    return rows;
}

/** PJ(n層)階層プルダウンの選択肢を、配下の子孫（子・孫…全階層）の総数が多い順にソートする（フィルタ・PJ一括編集の階層プルダウン共通）。 */
function sortProject2OptionsByDescendantCountDesc(rows) {
    return [...rows].sort((a, b) => collectProject2Descendants(b['ID']).length - collectProject2Descendants(a['ID']).length);
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

// プロジェクト管理表で「下階層」ドリルダウン中の子プロジェクトID（rowId(string) -> 選択中の子プロジェクトID）。
// 各行は一度に1つの子だけ展開でき、選択し直すと別の子に切り替わる。
let project2AdminDrilldown = new Map();

/**
 * プロジェクト管理表の1行を tbody に追加する。depthに応じてプロジェクト名を字下げする。
 * 「下階層」列に、このプロジェクト直下のさらに子を持つプロジェクト（サブプロジェクト）を選ぶプルダウンを置き、
 * 選択するとドリルダウンした子プロジェクトの行をこの行の直後に追加する（再帰）。
 */
function appendProject2AdminRow(tbody, row, depth, allProjectsFlat) {
    const id = String(row['ID']);
    const tr = document.createElement('tr');

    // プロジェクト名（階層の深さに応じて字下げ）
    const tdName = document.createElement('td');
    tdName.textContent = row['タイトル'] || '';
    tdName.style.paddingLeft = `${8 + depth * 20}px`;
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
        renderProject2AdminTable();
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
        renderProject2AdminTable();
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
    allProjectsFlat.filter(p => String(p['ID']) !== id).forEach(p => {
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
            allProjectsFlat.filter(p => String(p['ID']) !== id).forEach(p => {
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
                renderProject2AdminTable();
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
                renderProject2AdminTable();
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
            renderProject2AdminTable();
        });
        tdDelete.appendChild(deleteBtn);
    }
    tr.appendChild(tdDelete);

    // 下階層（このプロジェクト直下の、さらに子を持つプロジェクトへドリルダウンする）
    const tdDrill = document.createElement('td');
    const subProjects = decorateProjectDropdownOptions(getChildrenM(currentMainData, id)).filter(r => r.__childCount > 0);
    if (subProjects.length > 0) {
        const drillSelect = document.createElement('select');
        const noneOpt = document.createElement('option');
        noneOpt.value = '';
        noneOpt.textContent = '（下の階層を選択）';
        drillSelect.appendChild(noneOpt);
        subProjects.forEach(p => {
            const opt = document.createElement('option');
            opt.value = String(p['ID']);
            opt.textContent = p['タイトル'];
            drillSelect.appendChild(opt);
        });
        drillSelect.value = project2AdminDrilldown.get(id) || '';
        drillSelect.addEventListener('change', () => {
            if (drillSelect.value) project2AdminDrilldown.set(id, drillSelect.value);
            else project2AdminDrilldown.delete(id);
            renderProject2AdminTable();
        });
        tdDrill.appendChild(drillSelect);
    } else {
        tdDrill.textContent = '-';
    }
    tr.appendChild(tdDrill);

    tbody.appendChild(tr);

    const drilledId = project2AdminDrilldown.get(id);
    if (drilledId) {
        const childRow = currentMainData.find(r => String(r['ID']) === drilledId);
        if (childRow) {
            appendProject2AdminRow(tbody, childRow, depth + 1, allProjectsFlat);
        } else {
            project2AdminDrilldown.delete(id); // 実データに存在しなくなっていたら選択解除
        }
    }
}

/** 「プロジェクト管理」表を描画する。列: プロジェクト名／タスク数／状態／名前変更／統合／削除／下階層。 */
function renderProject2AdminTable() {
    const table = document.getElementById('project2-admin-table');
    if (!table) return;

    const projects = getProject2AllParentRowsForAdmin()
        .sort((a, b) => collectProject2Descendants(String(b['ID'])).length - collectProject2Descendants(String(a['ID'])).length);
    const allProjectsFlat = getProject2AllProjectRowsFlat();
    table.className = 'data-table';
    const cols = ['プロジェクト名', 'タスク数', '状態', '名前変更', '統合', '削除', '下階層'];

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    cols.forEach(c => { const th = document.createElement('th'); th.textContent = c; hRow.appendChild(th); });
    thead.appendChild(hRow);

    const tbody = document.createElement('tbody');
    projects.forEach(row => appendProject2AdminRow(tbody, row, 0, allProjectsFlat));

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
    project2AdminDrilldown.clear(); // 統合で階層が変わるため、プロジェクト管理表のドリルダウン状態はリセットする
    renderProject2AdminTable();
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
    project2AdminDrilldown.clear(); // 削除で階層が変わるため、プロジェクト管理表のドリルダウン状態はリセットする
    renderProject2AdminTable();
}

/**
 * PJ(n層)プルダウンの選択肢を、子タスクを持つもの（＝プロジェクト）を先頭に、その中では子タスク数が
 * 多い順に並べ替える。プロジェクトのタイトルには表示上「PJ:」を接頭辞として付ける（実データは変更しない）。
 */
function decorateProjectDropdownOptions(options) {
    return options
        .map(r => {
            const descendantCount = collectProject2Descendants(r['ID']).length; // 子だけでなく孫以降も含めた総階層数
            return descendantCount > 0
                ? { ...r, 'タイトル': `【PJ】${r['タイトル'] || ''}`, __childCount: descendantCount }
                : { ...r, __childCount: 0 };
        })
        .sort((a, b) => b.__childCount - a.__childCount);
}

const PROJECT2_STANDALONE_MARK = '__standalone__'; // 階層1の「（単独タスク）」選択肢の特殊値

/** 汎用の階層プルダウン1段を container に追加する（ラベル・選択肢・現在値・changeハンドラを指定）。extraOptions（{value, label}の配列）指定時は先頭付近に特殊選択肢を追加する。 */
function appendProject2DropdownRow(container, labelText, options, currentValue, onChange, extraOptions = []) {
    const row = document.createElement('div');
    row.className = 'calendar-edit-row';
    const label = document.createElement('label');
    label.textContent = labelText;
    const select = document.createElement('select');
    const blankOpt = document.createElement('option');
    blankOpt.value = '';
    blankOpt.textContent = '（未選択）';
    select.appendChild(blankOpt);
    extraOptions.forEach(({ value, label: text }) => {
        const extraOpt = document.createElement('option');
        extraOpt.value = value;
        extraOpt.textContent = text;
        select.appendChild(extraOpt);
    });
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
