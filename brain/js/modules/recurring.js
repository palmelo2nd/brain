// (1) インポート
import { MAIN_DATA_COLUMNS } from './dataModel.js';
import { parseTimestampLog } from './task.js';

// 曜日名（JS の getDay() と対応: 0=日）
const WEEKDAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

// (2) インプット関数定義

/** 親タスクの頻度設定が date に一致するか判定する（AND ロジック・空=全て対象） */
export function matchesSchedule(parent, date) {
    const months   = (parent['繰返し頻度_月']  || '').split(',').map(s => s.trim()).filter(Boolean);
    const days     = (parent['繰返し頻度_日']   || '').split(',').map(s => s.trim()).filter(Boolean);
    const weekdays = (parent['繰返し頻度_曜日'] || '').split(',').map(s => s.trim()).filter(Boolean);

    const monthOK   = months.length   === 0 || months.includes(String(date.getMonth() + 1));
    const dayOK     = days.length     === 0 || days.includes(String(date.getDate()));
    const weekdayOK = weekdays.length === 0 || weekdays.includes(WEEKDAY_NAMES[date.getDay()]);

    return monthOK && dayOK && weekdayOK;
}

/** date を YYYYMMDD 形式の文字列で返す */
export function formatYYYYMMDD(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/** date を "YYYY/MM/DD" 形式の文字列で返す（開始予定・重複判定キーに使用） */
export function formatSlashDate(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

/** 親タスクの頻度設定（月/日/曜日）を一覧表示用の文字列にまとめる。すべて空欄なら「毎日」。 */
export function formatRecurringFrequencyLabel(parent) {
    const parts = [];
    if (parent['繰返し頻度_月'])  parts.push(`月:${parent['繰返し頻度_月']}`);
    if (parent['繰返し頻度_日'])  parts.push(`日:${parent['繰返し頻度_日']}`);
    if (parent['繰返し頻度_曜日']) parts.push(`曜日:${parent['繰返し頻度_曜日']}`);
    return parts.length > 0 ? parts.join(' / ') : '毎日';
}

/** 子タスク配列から Chart.js 用の labels / data（実績時間, h）を作成する */
export function buildChildChartData(children) {
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

/** 週間ビュー用: date を含む週の月曜日（今日を含む週）を返す。 */
export function getMondayOf(date) {
    const mondayOffset = (date.getDay() + 6) % 7; // 日曜=0を6扱いにして月曜起点に変換
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() - mondayOffset);
}

function makeTsStr(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} `
         + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function maxIdIn(mainData) {
    return mainData.reduce((max, r) => {
        const id = parseInt(r['ID'], 10);
        return isNaN(id) ? max : Math.max(max, id);
    }, 0);
}

/** 親ID＋対象日（開始予定）で、既に同じ子タスクが生成済みかどうかを判定する。親タイトルの変更に影響されないキー。 */
function childAlreadyGenerated(mainData, parentId, slashDate) {
    return mainData.some(r => r['繰返し親ID'] === String(parentId) && r['開始予定'] === slashDate);
}

function buildChild(parent, dateStr, slashDate, id, ts) {
    const child = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
    child['ID']           = String(id);
    child['データ区分']   = 'タスク';
    child['タイトル']     = `${parent['タイトル']}_${dateStr}`;
    child['内容']         = parent['内容']      || '';
    child['カテゴリ']     = parent['カテゴリ']  || '';
    child['タグ']         = parent['タグ']      || '';
    child['プロジェクト']         = parent['プロジェクト']      || '';
    child['優先度']       = parent['優先度']    || '';
    child['見積時間']     = parent['見積時間']  || '';
    child['開始予定']     = slashDate;
    child['終了予定']     = slashDate;
    child['繰返し識別子'] = '1';
    child['繰返し親ID']   = String(parent['ID']);
    child['作成日時']     = ts;
    child['更新日時']     = ts;
    return child;
}

// (3) メイン機能

/**
 * アプリ起動・データ読み込み時に繰り返し子タスクを自動生成する。
 * 「繰返し識別子=1」かつステータス「進行中」の親のみ対象（進行中以外は非アクティブ扱いで生成しない）。
 * today から daysAhead 日後まで（既定7日＝1週間先）を毎回スキャンし、頻度条件を満たす日の分をまとめて生成する。
 * 呼び出すたびに先の日付までの分が補充されるため、日々開くだけで生成対象の範囲が先へ延びていく。
 * 親ID＋対象日（開始予定）が既存であれば重複生成しない（親タイトル変更の影響を受けない）。
 *
 * (4) アウトプット: 生成された子タスクの配列（0件の場合は空配列）
 */
export function checkAndGenerateChildren(mainData, today, daysAhead = 7) {
    const parents = mainData.filter(r =>
        r['繰返し識別子'] === '1' && !r['繰返し親ID'] && r['ステータス'] === '進行中'
    );

    let currentMaxId = maxIdIn(mainData);
    const generated  = [];

    for (let offset = 0; offset <= daysAhead; offset++) {
        const targetDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
        const ts        = makeTsStr(targetDate);
        const dateStr   = formatYYYYMMDD(targetDate);
        const slashDate = formatSlashDate(targetDate);

        parents.forEach(parent => {
            if (!matchesSchedule(parent, targetDate)) return;
            if (childAlreadyGenerated(mainData, parent['ID'], slashDate)) return;

            currentMaxId++;
            generated.push(buildChild(parent, dateStr, slashDate, currentMaxId, ts));
        });
    }

    return generated;
}

/**
 * 親タスクから子タスクを任意タイミングで生成する（手動生成）。
 * 頻度条件はチェックしない。当日分（親ID＋開始予定）が既に存在する場合は null を返す。
 *
 * (4) アウトプット: 生成した子タスクオブジェクト、または null（重複時）
 */
export function generateChildManually(parent, mainData) {
    const today     = new Date();
    const ts        = makeTsStr(today);
    const dateStr   = formatYYYYMMDD(today);
    const slashDate = formatSlashDate(today);

    if (childAlreadyGenerated(mainData, parent['ID'], slashDate)) return null;

    return buildChild(parent, dateStr, slashDate, maxIdIn(mainData) + 1, ts);
}
