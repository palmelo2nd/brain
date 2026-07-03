// (1) インポート
import { MAIN_DATA_COLUMNS } from './dataModel.js';

// 曜日名（JS の getDay() と対応: 0=日曜）
const WEEKDAY_NAMES = ['日曜', '月曜', '火曜', '水曜', '木曜', '金曜', '土曜'];

// (2) インプット関数定義

/** date を YYYYMMDD 形式の文字列で返す */
export function formatYYYYMMDD(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/** date を "YYYY/MM/DD" 形式の文字列で返す（開始予定・重複判定キーに使用） */
function formatSlashDate(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

/** 親タスクの頻度設定が date に一致するか判定する（AND ロジック・空=全て対象） */
function matchesSchedule(parent, date) {
    const months   = (parent['繰返し頻度_月']  || '').split(',').map(s => s.trim()).filter(Boolean);
    const days     = (parent['繰返し頻度_日']   || '').split(',').map(s => s.trim()).filter(Boolean);
    const weekdays = (parent['繰返し頻度_曜日'] || '').split(',').map(s => s.trim()).filter(Boolean);

    const monthOK   = months.length   === 0 || months.includes(String(date.getMonth() + 1));
    const dayOK     = days.length     === 0 || days.includes(String(date.getDate()));
    const weekdayOK = weekdays.length === 0 || weekdays.includes(WEEKDAY_NAMES[date.getDay()]);

    return monthOK && dayOK && weekdayOK;
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
    child['カテゴリ']     = parent['カテゴリ']  || '';
    child['タグ']         = parent['タグ']      || '';
    child['ハブ']         = parent['ハブ']      || '';
    child['優先度']       = parent['優先度']    || '';
    child['見積時間']     = parent['見積時間']  || '';
    child['開始予定']     = slashDate;
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
 * 頻度条件を満たさない日はスキップ。
 * 親ID＋対象日（開始予定）が既存であれば重複生成しない（親タイトル変更の影響を受けない）。
 *
 * (4) アウトプット: 生成された子タスクの配列（0件の場合は空配列）
 */
export function checkAndGenerateChildren(mainData, today) {
    const ts        = makeTsStr(today);
    const dateStr   = formatYYYYMMDD(today);
    const slashDate = formatSlashDate(today);

    const parents = mainData.filter(r =>
        r['繰返し識別子'] === '1' && !r['繰返し親ID'] && r['ステータス'] === '進行中'
    );

    let currentMaxId = maxIdIn(mainData);
    const generated  = [];

    parents.forEach(parent => {
        if (!matchesSchedule(parent, today)) return;
        if (childAlreadyGenerated(mainData, parent['ID'], slashDate)) return;

        currentMaxId++;
        generated.push(buildChild(parent, dateStr, slashDate, currentMaxId, ts));
    });

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
