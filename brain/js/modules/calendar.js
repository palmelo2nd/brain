// (1) インポート
import { formatJpDatetime, isRecurringParentRow } from './task.js';

// 1日タスク（その日のタイムスケジュールを文法で記述する特殊行）は、通常のタスクと区別するため
// データ区分＝ナレッジ・PARA区分＝DAYPLAN_PARA として登録する（作業ログ的な性質のため）。
export const DAYPLAN_KUBUN = 'ナレッジ';
export const DAYPLAN_PARA  = '1日タスク';

/** row が1日タスク（DAYPLAN）の器行かどうかを判定する。 */
export function isDayPlanRow(row) {
    return row['データ区分'] === DAYPLAN_KUBUN && row['PARA区分'] === DAYPLAN_PARA;
}

// 完了・中断・報告待ち・連絡待ちのステータスなら「残務なし（緑）」扱いとする。
const CALENDAR_DONE_STATUSES = ['完了', '中断', '報告待ち', '連絡待ち'];

// タスク一覧のステータス表示順（この順に並べ、リストに無いステータスは末尾、空欄は最後尾）。
const CALENDAR_TASK_LIST_STATUS_ORDER = ['完了', '報告待ち', '連絡待ち', '中断', '進行中', '未着手'];

// (2) インプット関数定義

/** 日時文字列 "YYYY/MM/DD HH:mm:ss" の日付部分のみを返す */
function jpDateOnly(dt) { return (dt || '').slice(0, 10); }

/**
 * 値がSetに含まれるかを判定する（チェックが外れている＝選択されていない、を素直に反映する）。
 * ただし値が未設定（空文字等）の行は、そもそもチェックボックスの選択肢として存在しえないため、
 * どのフィルタにも引っかからず常に表示する（除外しない）。
 */
export function matchesMultiFilter(selectedSet, value) {
    if (!value) return true;
    return selectedSet.has(value);
}

/** 完了・中断・報告待ち・連絡待ちのいずれかのステータスかどうかを判定する。 */
export function isTaskDoneForCalendar(row) {
    return CALENDAR_DONE_STATUSES.includes(row['ステータス']);
}

/**
 * タスクの●印を出す日を1日だけ決定する。
 * 残務なし（完了・中断・報告待ち・連絡待ち）: 完了日があればその日、無ければ印なし（null）。
 * 残務あり: today を 開始予定〜終了予定 の範囲にクランプした日（未来なら開始予定、期間内なら today、過ぎていたら終了予定）。
 */
export function getCalendarMarkDate(row, todayJP) {
    const start = jpDateOnly(row['開始予定']) || jpDateOnly(row['終了予定']);
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

/** カテゴリ・calendarFiltersで絞り込んだメインデータのうち、データ区分がタスクの行を返す（内部共通処理。1日タスクはデータ区分がナレッジのため自動的に除外される）。 */
function filterCalendarTasks(mainData, category, calendarFilters) {
    return mainData.filter(r => {
        if (category !== 'すべて' && r['カテゴリ'] !== category) return false;
        if (r['データ区分'] !== 'タスク') return false;
        if (isRecurringParentRow(r)) return false; // 繰返しタスクの親は対象外
        if (!matchesMultiFilter(calendarFilters.tag, r['タグ'])) return false;
        if (!matchesMultiFilter(calendarFilters.status, r['ステータス'])) return false;
        return true;
    });
}

/** dateJP に●印が出るタスク（フィルタ適用済み）を返す。●の判定とクリック後の一覧表示で共有するロジック。 */
export function getTasksForDate(mainData, category, calendarFilters, dateJP) {
    const todayJP = jpDateOnly(formatJpDatetime(new Date()));
    return filterCalendarTasks(mainData, category, calendarFilters)
        .filter(r => getCalendarMarkDate(r, todayJP) === dateJP);
}

/** 指定日の1日タスク（isDayPlanRow、開始予定=dateJP の行）を返す。無ければ null。 */
export function getDayPlanTask(mainData, dateJP) {
    return mainData.find(r =>
        isDayPlanRow(r) && jpDateOnly(r['開始予定']) === dateJP
    ) || null;
}

/**
 * 1日タスクの内容欄を「HH:MM-HH:MM [#ID] [ラベル]」形式の行としてパースする。
 * @returns {Array<{startMin:number, endMin:number, refId:?string, label:string}>}
 */
export function parseDayPlanContent(content) {
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

/**
 * 1日タスクの内容テキストのうち、blockIndex番目のブロック（parseDayPlanContent順）の時刻だけを書き換えて返す。
 * タイムラインのドラッグ操作（移動・リサイズ）で使用する。blockIndexが存在しない場合は元のテキストをそのまま返す。
 */
export function updateDayPlanBlockTime(content, blockIndex, newStartMin, newEndMin) {
    const blocks = parseDayPlanContent(content);
    if (!blocks[blockIndex]) return content;
    blocks[blockIndex] = { ...blocks[blockIndex], startMin: newStartMin, endMin: newEndMin };
    return stringifyDayPlanBlocks(blocks);
}

/** 1日タスクのブロック配列を、開始時刻昇順→終了時刻昇順→（#ID参照があれば）ID昇順で並べ替える。 */
export function sortDayPlanBlocks(blocks) {
    return [...blocks].sort((a, b) => {
        if (a.startMin !== b.startMin) return a.startMin - b.startMin;
        if (a.endMin !== b.endMin) return a.endMin - b.endMin;
        const idA = a.refId != null ? Number(a.refId) : NaN;
        const idB = b.refId != null ? Number(b.refId) : NaN;
        if (!isNaN(idA) && !isNaN(idB)) return idA - idB;
        if (!isNaN(idA)) return -1;
        if (!isNaN(idB)) return 1;
        return 0;
    });
}

/** parseDayPlanContent の結果（ブロック配列）を、元の「HH:MM-HH:MM #ID ラベル」形式のテキストに戻す。 */
export function stringifyDayPlanBlocks(blocks) {
    const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return blocks.map(b => {
        const timePart  = `${fmt(b.startMin)}-${fmt(b.endMin)}`;
        const idPart    = b.refId ? ` #${b.refId}` : '';
        const labelPart = b.label ? ` ${b.label}` : '';
        return `${timePart}${idPart}${labelPart}`;
    }).join('\n');
}

/** データ区分がタスクで、指定フィールドが value と一致し、ステータスが完了・中断以外の件数を、カテゴリで絞り込んで返す。 */
export function countActiveTasksByField(mainData, category, field, value) {
    const rows = category === 'すべて' ? mainData : mainData.filter(r => r['カテゴリ'] === category);
    return rows.filter(r =>
        r['データ区分'] === 'タスク' && r[field] === value &&
        r['ステータス'] !== '完了' && r['ステータス'] !== '中断'
    ).length;
}

/** データ区分がタスクで、指定フィールドが value と一致する件数を（ステータスを問わず）、カテゴリで絞り込んで返す。 */
export function countTasksByField(mainData, category, field, value) {
    const rows = category === 'すべて' ? mainData : mainData.filter(r => r['カテゴリ'] === category);
    return rows.filter(r => r['データ区分'] === 'タスク' && r[field] === value).length;
}

/** options を件数（N）の多い順にソートして返す。 */
export function sortByTotalCountDesc(options, mainData, category, field) {
    return [...options].sort((a, b) =>
        countTasksByField(mainData, category, field, b) - countTasksByField(mainData, category, field, a)
    );
}

/** ステータス名の表示順ランクを返す（リストに無いものは末尾扱い、空欄は最後尾）。 */
export function calendarTaskListStatusRank(status) {
    if (!status) return CALENDAR_TASK_LIST_STATUS_ORDER.length + 1;
    const idx = CALENDAR_TASK_LIST_STATUS_ORDER.indexOf(status);
    return idx !== -1 ? idx : CALENDAR_TASK_LIST_STATUS_ORDER.length;
}

/** 日付文字列（YYYY/MM/DD...）を古い順に比較する。空欄は常に最後尾。 */
export function compareDateAscEmptyLast(a, b) {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b);
}

/** value（"YYYY/MM/DD" または "YYYY/MM/DD HH:mm"）が dateJP と同じ日付かどうかを調べ、時刻情報を返す。 */
export function extractTimeOnDate(value, dateJP) {
    if (!value) return null;
    const [datePart, timePart] = value.split(' ');
    if (datePart !== dateJP) return null;
    if (!timePart) return { hasTime: false, minutes: null };
    const [h, m] = timePart.split(':').map(Number);
    if (isNaN(h) || isNaN(m)) return { hasTime: false, minutes: null };
    return { hasTime: true, minutes: h * 60 + m };
}

/**
 * dateJP のタスクを「時間帯が決まっているもの（timed）」「時間帯未定（unscheduled）」
 * 「1日タスクに既に追加済み（referenced）」に分ける。
 * timed の各要素は { row, startMin, endMin }（分単位、0〜1440）。
 * referenced は1日タスクの内容欄で#ID参照されているタスク（元タスク側では時間帯ブロックを表示しないため別枠で返す）。
 * 1日タスクでの記載順（startMin昇順）で並べる。
 */
export function getCalendarSegmentsForDate(mainData, category, calendarFilters, dateJP) {
    const dayPlanTask   = getDayPlanTask(mainData, dateJP);
    const dayPlanBlocks = dayPlanTask ? parseDayPlanContent(dayPlanTask['内容']) : [];
    const referencedIds = new Set(dayPlanBlocks.map(b => b.refId).filter(Boolean));

    const timed = [];
    const unscheduled = [];
    const referencedRows = [];

    getTasksAvailableForDayPlan(mainData, category, calendarFilters, dateJP).forEach(row => {
        if (referencedIds.has(String(row['ID']))) {
            referencedRows.push(row);
            return;
        }

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

    dayPlanBlocks.forEach((b, dayPlanBlockIndex) => {
        const linkedRow = b.refId ? mainData.find(r => String(r['ID']) === b.refId) : null;
        timed.push({
            row: linkedRow || { ID: null, タイトル: b.label || '（ラベルなし）', ステータス: null },
            startMin: b.startMin,
            endMin: b.endMin,
            isDayPlanBlock: true,
            dayPlanBlockIndex
        });
    });

    timed.sort((a, b) => a.startMin - b.startMin);

    const blockStartById = new Map(dayPlanBlocks.filter(b => b.refId).map(b => [b.refId, b.startMin]));
    const referenced = referencedRows.sort((a, b) =>
        (blockStartById.get(String(a['ID'])) ?? 0) - (blockStartById.get(String(b['ID'])) ?? 0)
    );

    return { timed, unscheduled, referenced };
}

/** 時間帯が重なるタスクを横に並べるためのレーン番号を割り振る（timed配列に lane / laneCount を直接付与する）。 */
export function assignCalendarLanes(timed) {
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

/** タスクのステータスに応じたタイムラインブロックの配色クラスを返す（未着手・未選択=灰／進行中=青／連絡待ち・報告待ち・中断=紫／完了=緑）。 */
export function getCalendarStatusClass(status) {
    if (status === '進行中') return 'calendar-time-block--doing';
    if (['連絡待ち', '報告待ち', '中断'].includes(status)) return 'calendar-time-block--waiting';
    if (status === '完了') return 'calendar-time-block--done';
    return 'calendar-time-block--todo'; // 未着手・未選択（空欄）はいずれも灰色
}

/** 現在時刻を30分刻みで切り上げた開始時刻と、その1時間後の終了時刻を "HH:MM" 形式で返す。 */
/**
 * 現在時刻以降で30分刻みに丸めた時刻から、既存の1日タスクブロック（busyBlocks、{startMin,endMin}の配列）と
 * 重ならない1時間の空き枠を探して返す（startStr/endStrは"HH:MM"）。busyBlocksは未指定なら空き枠なしとして扱う。
 */
export function computeDayPlanTimeSlot(busyBlocks = [], now = new Date()) {
    const DURATION = 60;
    const minutesNow = now.getHours() * 60 + now.getMinutes();
    let startMin = Math.ceil(minutesNow / 30) * 30;

    const busy = [...busyBlocks].sort((a, b) => a.startMin - b.startMin);
    while (startMin + DURATION <= 1440) {
        const endMin = startMin + DURATION;
        const blocking = busy.find(b => startMin < b.endMin && endMin > b.startMin);
        if (!blocking) break;
        startMin = Math.ceil(blocking.endMin / 30) * 30;
    }
    const endMin = Math.min(startMin + DURATION, 1440);

    const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return { startStr: fmt(startMin), endStr: fmt(endMin) };
}

/**
 * タスクの開始予定・終了予定が共に dateJP（1日タスクの対象日）の日付かつ時刻まで指定されている場合、
 * その時間帯を "HH:MM" 形式で返す。条件を満たさない場合は null。
 */
export function getTaskScheduledTimeOnDate(row, dateJP) {
    const startInfo = extractTimeOnDate(row['開始予定'], dateJP);
    const endInfo   = extractTimeOnDate(row['終了予定'], dateJP);
    if (!startInfo?.hasTime || !endInfo?.hasTime) return null;

    const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return { startStr: fmt(startInfo.minutes), endStr: fmt(endInfo.minutes) };
}

/** データ区分がタスクで、繰返し親を除いた行を返す（未設定タスク各領域の共通母集団。1日タスクはデータ区分がナレッジのため自動的に除外される）。 */
function unsetTaskPool(mainData) {
    return mainData.filter(r => {
        if (r['データ区分'] !== 'タスク') return false;
        if (isRecurringParentRow(r)) return false;
        return true;
    });
}

/** row のカテゴリが currentCategory に一致するか、row にカテゴリが未入力かを判定する（カテゴリ未入力は常に一致扱い）。 */
function matchesCategoryOrUnset(row, category) {
    return category === 'すべて' || !row['カテゴリ'] || row['カテゴリ'] === category;
}

/**
 * カテゴリ・ステータス・優先度それぞれが未設定のタスクを、領域ごとに分けて返す（重複あり）。
 * プロジェクト（親ID方式）の未設定判定は呼び出し側（新タスク整理）で個別に行う。
 * カテゴリ未設定の領域は currentCategory の絞り込みを受けない（カテゴリが無いので判定不能なため）。
 * それ以外の領域は、行にカテゴリがあれば currentCategory と一致するもののみ、カテゴリが無ければ常に対象にする。
 */
export function getUnsetAttributeGroups(mainData, category) {
    const pool = unsetTaskPool(mainData);
    return {
        categoryUnset: pool.filter(r => !r['カテゴリ']),
        statusUnset:   pool.filter(r => !r['ステータス'] && matchesCategoryOrUnset(r, category)),
        priorityUnset: pool.filter(r => !r['優先度']   && matchesCategoryOrUnset(r, category)),
    };
}

/** ステータスが「中断」のタスクを、終了予定が近い順（空欄は最後）に並べて返す。 */
export function getSuspendedTasks(mainData, category) {
    return unsetTaskPool(mainData)
        .filter(r => r['ステータス'] === '中断' && matchesCategoryOrUnset(r, category))
        .sort((a, b) => compareDateAscEmptyLast(a['終了予定'], b['終了予定']));
}

// タスク整理系リストの整理表示順（この順にグループ化し、リストに無いステータス・空欄は最後尾）。
const TASK_ORGANIZE_STATUS_ORDER = ['未着手', '進行中', '中断', '連絡待ち', '報告待ち', '完了'];

/** ステータス名の整理表示順ランクを返す（未着手→進行中→中断→連絡待ち→報告待ち→完了→その他の順）。 */
export function taskOrganizeStatusRank(status) {
    const idx = TASK_ORGANIZE_STATUS_ORDER.indexOf(status);
    return idx !== -1 ? idx : TASK_ORGANIZE_STATUS_ORDER.length;
}

/**
 * タスク一覧を、ステータス（未着手→進行中→中断→連絡待ち→報告待ち→完了→その他の順）でグループ化し、
 * 各グループ内は終了予定が近い順（空欄は最後）に並べて返す。
 * @returns {Array<{status: string, rows: Array}>}
 */
export function groupUnsetTasksByStatus(rows) {
    const groups = new Map();
    rows.forEach(row => {
        const status = row['ステータス'] || '（未設定）';
        if (!groups.has(status)) groups.set(status, []);
        groups.get(status).push(row);
    });

    const sortedStatuses = [...groups.keys()].sort((a, b) => taskOrganizeStatusRank(a) - taskOrganizeStatusRank(b));

    return sortedStatuses.map(status => ({
        status,
        rows: [...groups.get(status)].sort((a, b) => compareDateAscEmptyLast(a['終了予定'], b['終了予定']))
    }));
}

/** 開始予定・終了予定の少なくとも一方が空欄のタスク（フィルタ適用済み、繰返し親は除外）を返す。 */
export function getIncompleteDateTasks(mainData, category, calendarFilters) {
    return filterCalendarTasks(mainData, category, calendarFilters).filter(r => {
        if (isRecurringParentRow(r)) return false; // 繰返しタスクの親は対象外
        if (r['開始予定'] && r['終了予定']) return false; // 両方入力済みは対象外
        return true;
    });
}

// (3)〜(4) メイン機能・アウトプット
// このモジュールの各関数は純粋計算のみを行い、引数として受け取った値から
// 計算結果を return する（DOM操作・グローバル状態への直接アクセスは行わない）。
