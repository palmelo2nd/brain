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

// 完了のステータスなら「残務なし（緑）」扱いとする。未着手・進行中・中断・連絡待ち・報告待ちは残務ありとして期間内の1日を表示する。
const CALENDAR_DONE_STATUSES = ['完了'];

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

/** ステータスが「完了」かどうかを判定する。 */
export function isTaskDoneForCalendar(row) {
    return CALENDAR_DONE_STATUSES.includes(row['ステータス']);
}

/**
 * タスクの●印を出す日を1日だけ決定する。
 * 残務なし（完了）: 完了日があればその日、無ければ印なし（null）。
 * 残務あり（未着手・進行中・中断・連絡待ち・報告待ち）: today を 開始予定〜終了予定 の範囲にクランプした日（未来なら開始予定、期間内なら today、過ぎていたら終了予定）。
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
 * 1日タスクの内容欄を「[列番号] HH:MM-HH:MM [#ID] [ラベル]」形式の行としてパースする。
 * 先頭の「[列番号] 」は任意（無ければ column は null＝列未指定として、表示側で自動配置にフォールバックする）。
 * @returns {Array<{startMin:number, endMin:number, refId:?string, label:string, column:?number}>}
 */
export function parseDayPlanContent(content) {
    if (!content) return [];
    const lineRe = /^(?:\[(\d+)\]\s*)?(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\s*(?:#(\S+))?\s*(.*)$/;
    return content.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
        const m = line.match(lineRe);
        if (!m) return null;
        const startMin = Number(m[2]) * 60 + Number(m[3]);
        let endMin = Number(m[4]) * 60 + Number(m[5]);
        if (endMin <= startMin) endMin = startMin + 15;
        return {
            startMin: Math.max(0, Math.min(1439, startMin)),
            endMin:   Math.max(startMin + 15, Math.min(1440, endMin)),
            refId:    m[6] || null,
            label:    (m[7] || '').trim(),
            column:   m[1] ? Number(m[1]) : null
        };
    }).filter(Boolean);
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

/** parseDayPlanContent の結果（ブロック配列）を、元の「[列番号] HH:MM-HH:MM #ID ラベル」形式のテキストに戻す。 */
export function stringifyDayPlanBlocks(blocks) {
    const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return blocks.map(b => {
        const colPart   = b.column ? `[${b.column}] ` : '';
        const timePart  = `${fmt(b.startMin)}-${fmt(b.endMin)}`;
        const idPart    = b.refId ? ` #${b.refId}` : '';
        const labelPart = b.label ? ` ${b.label}` : '';
        return `${colPart}${timePart}${idPart}${labelPart}`;
    }).join('\n');
}

const DAYPLAN_COLLISION_MANAGED_COLUMNS = [2, 3, 4]; // 列1（決まっている予定）は重なり解消の対象外。ユーザーが手動で管理する

/**
 * 列内で、移動／リサイズ／新規追加後のブロック（moving）を、既存ブロック（others）と時間が重ならないよう
 * 時系列順に押し出して解決する。moving自身は衝突した既存ブロックの直後まで動き、その結果さらに後続の
 * 既存ブロックと重なればそれも後ろへ押し出す…という形で連鎖的に処理する。
 * どれかのブロックの終了時刻が24:00（1440分）を超える場合は overflow:true を返す（呼び出し側は何も書き換えずキャンセルする）。
 * @param {Array<{id:*, startMin:number, endMin:number}>} others - movingを除く、その列の既存ブロック
 * @param {{startMin:number, endMin:number}} moving - 配置したい位置（長さ＝endMin-startMinは維持される）
 * @returns {{ overflow:boolean, moving:?{startMin:number,endMin:number}, pushed:Array<{id:*,startMin:number,endMin:number}> }}
 */
function resolveDayPlanColumnCollision(others, moving) {
    const items = [
        ...others.map(b => ({ ...b, isMoving: false })),
        { startMin: moving.startMin, endMin: moving.endMin, isMoving: true }
    ].sort((a, b) => a.startMin - b.startMin || (a.isMoving ? 1 : -1)); // 同時刻なら既存ブロックを優先し、movingを後ろに回す

    let cursor = 0;
    let resolvedMoving = null;
    let overflow = false;
    const pushed = [];

    items.forEach(item => {
        const duration = item.endMin - item.startMin;
        const start = Math.max(item.startMin, cursor);
        const end   = start + duration;
        if (end > 1440) overflow = true;
        cursor = end;
        if (item.isMoving) {
            resolvedMoving = { startMin: start, endMin: end };
        } else if (start !== item.startMin) {
            pushed.push({ id: item.id, startMin: start, endMin: end });
        }
    });

    return { overflow, moving: resolvedMoving, pushed };
}

/**
 * 1日タスクの内容テキストに、1件分のブロック配置（既存ブロックの移動・リサイズ、または新規追加）を反映して返す。
 * blockIndexがnull/undefinedなら、newBlockTemplateを土台に新しいブロックを追加してから配置する（＋ドラッグでの
 * 未追加タスクの昇格に使う）。targetColumnが列2〜4（重なり解消の対象）の場合、同じ列内の他ブロックとの重なりを
 * resolveDayPlanColumnCollisionで自動的に解消する。列1（決まっている予定）は重なりを気にせずそのまま配置する。
 * 解消の結果どれかが24:00を超える場合は、テキストを一切変更せず {ok:false} を返す（呼び出し側はキャンセル扱いにする）。
 * @returns {{ ok:boolean, content?:string }}
 */
export function placeDayPlanBlock(content, blockIndex, newStartMin, newEndMin, targetColumn, newBlockTemplate) {
    const blocks = parseDayPlanContent(content);
    let index = blockIndex;
    if (index == null) {
        index = blocks.length;
        blocks.push({ refId: null, label: '', ...newBlockTemplate, startMin: newStartMin, endMin: newEndMin, column: targetColumn });
    }

    if (DAYPLAN_COLLISION_MANAGED_COLUMNS.includes(targetColumn)) {
        const others = blocks
            .map((b, i) => ({ id: i, startMin: b.startMin, endMin: b.endMin }))
            .filter((o, i) => i !== index && blocks[i].column === targetColumn);
        const result = resolveDayPlanColumnCollision(others, { startMin: newStartMin, endMin: newEndMin });
        if (result.overflow) return { ok: false };
        blocks[index] = { ...blocks[index], startMin: result.moving.startMin, endMin: result.moving.endMin, column: targetColumn };
        result.pushed.forEach(p => { blocks[p.id] = { ...blocks[p.id], startMin: p.startMin, endMin: p.endMin }; });
    } else {
        blocks[index] = { ...blocks[index], startMin: newStartMin, endMin: newEndMin, column: targetColumn };
    }

    return { ok: true, content: stringifyDayPlanBlocks(blocks) };
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

export const DAYPLAN_COLUMN_COUNT = 4; // 列1=決まっている予定の定位置、列2〜4=空き時間消化の作業枠

/**
 * タイムラインの列（レーン）番号を割り振る（timed配列に lane / laneCount を直接付与する）。
 * 常に最低4列のグリッドとして扱う（1件しかない日でも1/4幅の列1に収める)。
 * seg.column（1日タスクの `[N]` で明示された列、1〜4）があるブロックは、他と時間が重なっていても
 * 常にその列へそのまま配置する（表示列とデータの`[N]`が食い違わないようにするため、衝突による自動移動はしない）。
 * column未指定のブロック（`[N]`の無い旧データ・1日タスクに未追加のタスク）だけ、最初に空いた列へ詰める
 * 従来通りのグリーディ法でフォールバック配置する。4列に収まらないほど重なる場合は、データを隠さないよう列を追加して溢れさせる。
 */
export function assignCalendarColumns(timed) {
    const laneEnds = new Array(DAYPLAN_COLUMN_COUNT).fill(0);

    // 1. 列が明示されているブロックは、重なりを一切気にせずそのまま該当列に配置する
    timed.filter(seg => seg.column).forEach(seg => {
        const lane = seg.column - 1;
        seg.lane = lane;
        laneEnds[lane] = Math.max(laneEnds[lane], seg.endMin); // 未指定ブロックの空き列探索用に、埋まっている目安として記録
    });

    // 2. 列未指定のブロックだけ、空いている列へ古い開始時刻順に詰めていく
    timed.filter(seg => !seg.column).sort((a, b) => a.startMin - b.startMin).forEach(seg => {
        let lane = laneEnds.findIndex(endMin => endMin <= seg.startMin);
        if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
        laneEnds[lane] = seg.endMin;
        seg.lane = lane;
    });

    const laneCount = Math.max(DAYPLAN_COLUMN_COUNT, laneEnds.length);
    timed.forEach(seg => { seg.laneCount = laneCount; });
}

/** タスクのステータスに応じたタイムラインブロックの配色クラスを返す（未着手・未選択=灰／進行中=青／連絡待ち・報告待ち・中断=紫／完了=緑）。 */
export function getCalendarStatusClass(status) {
    if (status === '進行中') return 'calendar-time-block--doing';
    if (['連絡待ち', '報告待ち', '中断'].includes(status)) return 'calendar-time-block--waiting';
    if (status === '完了') return 'calendar-time-block--done';
    return 'calendar-time-block--todo'; // 未着手・未選択（空欄）はいずれも灰色
}

/** タスクの優先度に応じたバッジ用ドットの配色クラスを返す（高=赤／中=黄／低=緑）。想定外の値・未設定はドット非表示。 */
export function getPriorityDotClass(priority) {
    if (priority === '高') return 'calendar-priority-dot--high';
    if (priority === '中') return 'calendar-priority-dot--mid';
    if (priority === '低') return 'calendar-priority-dot--low';
    return '';
}

const DAYPLAN_WORK_START_MIN = 9 * 60; // 時間未定タスクの自動追加の起点＝9:00
const DAYPLAN_WORK_COLUMN    = 4;      // ＋ボタンで時間未定タスクを自動追加する定位置（列2・3はドラッグでの手動配置用に空けておく）

/**
 * 時間未指定タスクを1日タスクに追加する際の「次に空いている枠」を、9:00起点・30分刻みで列4から探して返す。
 * existingBlocksのうち列4のブロックとだけ重ならない60分の枠を、9:00から30分刻みで前進させながら探す
 * （見つかった枠は、ドラッグ時のような重なり解消の押し出しは行わず、そのまま空いている場所に置くだけ）。
 * @returns {{startStr:string, endStr:string, column:number}}
 */
export function computeDayPlanTimeSlot(existingBlocks = []) {
    const DURATION = 60;
    const busy = existingBlocks.filter(b => b.column === DAYPLAN_WORK_COLUMN).sort((a, b) => a.startMin - b.startMin);

    let startMin = DAYPLAN_WORK_START_MIN;
    while (startMin + DURATION <= 1440) {
        const endMin = startMin + DURATION;
        const blocking = busy.find(b => startMin < b.endMin && endMin > b.startMin);
        if (!blocking) break;
        startMin = Math.ceil(blocking.endMin / 30) * 30;
    }
    const endMin = Math.min(startMin + DURATION, 1440);

    const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return { startStr: fmt(startMin), endStr: fmt(endMin), column: DAYPLAN_WORK_COLUMN };
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

/** 開始予定・終了予定がともに入力されており、かつ todayJP がその期間内（＝対応中タスクとして表示される）かどうかを判定する。 */
function isActiveTodayPeriod(row, todayJP) {
    const start = jpDateOnly(row['開始予定']);
    const end   = jpDateOnly(row['終了予定']);
    if (!start || !end) return false;
    return start <= todayJP && todayJP <= end;
}

/** ステータスが「中断」のタスクを、終了予定が近い順（空欄は最後）に並べて返す。 */
export function getSuspendedTasks(mainData, category, todayJP) {
    return getTasksByStatus(mainData, category, '中断', todayJP);
}

/**
 * 指定ステータスのタスクを、終了予定が近い順（空欄は最後）に並べて返す（対応待ちタスク用）。
 * 開始予定・終了予定の少なくとも一方が未入力のタスクは対象外（属性未設定タスク側に表示するため）。
 * 開始予定〜終了予定の期間に todayJP が含まれるタスク（＝対応中タスクに表示される）も対象外。
 */
export function getTasksByStatus(mainData, category, status, todayJP) {
    return unsetTaskPool(mainData)
        .filter(r => r['ステータス'] === status && matchesCategoryOrUnset(r, category))
        .filter(r => r['開始予定'] && r['終了予定'])
        .filter(r => !isActiveTodayPeriod(r, todayJP))
        .sort((a, b) => compareDateAscEmptyLast(a['終了予定'], b['終了予定']));
}

// タスク整理系リストの整理表示順（この順にグループ化し、リストに無いステータス・空欄は最後尾）。
const TASK_ORGANIZE_STATUS_ORDER = ['未着手', '進行中', '連絡待ち', '報告待ち', '中断', '完了'];

/** ステータス名の整理表示順ランクを返す（未着手→進行中→連絡待ち→報告待ち→中断→完了→その他の順）。 */
export function taskOrganizeStatusRank(status) {
    const idx = TASK_ORGANIZE_STATUS_ORDER.indexOf(status);
    return idx !== -1 ? idx : TASK_ORGANIZE_STATUS_ORDER.length;
}

// (3)〜(4) メイン機能・アウトプット
// このモジュールの各関数は純粋計算のみを行い、引数として受け取った値から
// 計算結果を return する（DOM操作・グローバル状態への直接アクセスは行わない）。
