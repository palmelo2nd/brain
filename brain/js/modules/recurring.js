// (1) インポート
import { MAIN_DATA_COLUMNS } from './dataModel.js';
import { computeActualHours } from './task.js';

// 曜日名（JS の getDay() と対応: 0=日）
const WEEKDAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

// (2) インプット関数定義

/** "7月"や"07"のような文字列から数値部分を取り出す（マスタ表記の接尾辞・ゼロ埋めの揺れを吸収するため）。数値が無ければnull。 */
function extractNumber(str) {
    const m = String(str).match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
}

/** 親タスクの頻度設定が date に一致するか判定する（AND ロジック・空=全て対象） */
export function matchesSchedule(parent, date) {
    const months   = (parent['繰返し頻度_月']  || '').split(',').map(s => s.trim()).filter(Boolean);
    const days     = (parent['繰返し頻度_日']   || '').split(',').map(s => s.trim()).filter(Boolean);
    const weekdays = (parent['繰返し頻度_曜日'] || '').split(',').map(s => s.trim()).filter(Boolean);

    const monthOK   = months.length   === 0 || months.some(v => extractNumber(v) === date.getMonth() + 1);
    const dayOK     = days.length     === 0 || days.some(v => extractNumber(v) === date.getDate());
    const weekdayOK = weekdays.length === 0 || weekdays.includes(WEEKDAY_NAMES[date.getDay()]);

    return monthOK && dayOK && weekdayOK;
}

/** date を YYMMDD 形式の文字列で返す（子タスクタイトルの日付表記に使用） */
export function formatYYYYMMDD(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${pad(date.getFullYear() % 100)}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
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
    const data   = sorted.map(r => computeActualHours(r));

    return { labels, data };
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

/** 親ID＋繰返し基準日＋タイトルで、既に同じ子タスクが生成済みかどうかを判定する（当日分・生成中の分の両方を対象）。 */
function childAlreadyGenerated(mainData, generated, parentId, matchedDateSlash, title) {
    const match = r => r['親ID'] === String(parentId) && r['繰返し基準日'] === matchedDateSlash && r['タイトル'] === title;
    return mainData.some(match) || generated.some(match);
}

const DEFAULT_TEMPLATES = [{ startOffsetDays: 0, endOffsetDays: 0, titleSuffix: '', content: '' }];

/**
 * 親タスクの備考欄から実行タスクテンプレート配列を読み取る。
 * 空・パース不可の場合は「オフセット0の1件のみ」（従来動作）を返す。
 * 旧形式（offsetDaysのみ・開始予定と終了予定が同じ扱い）のデータが残っていた場合は、
 * startOffsetDays・endOffsetDaysの両方にoffsetDaysの値を引き継いで読み込む。
 *
 * (2) インプット: remarksText — 親タスクの備考欄の文字列
 * (4) アウトプット: Array<{ startOffsetDays: number, endOffsetDays: number, titleSuffix: string, content: string }>
 */
export function parseChildTemplates(remarksText) {
    if (!remarksText || !remarksText.trim()) return DEFAULT_TEMPLATES;

    try {
        const parsed = JSON.parse(remarksText);
        if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_TEMPLATES;
        return parsed.map(t => {
            const legacyOffset = Number.isFinite(t.offsetDays) ? t.offsetDays : 0;
            return {
                startOffsetDays: Number.isFinite(t.startOffsetDays) ? t.startOffsetDays : legacyOffset,
                endOffsetDays:   Number.isFinite(t.endOffsetDays)   ? t.endOffsetDays   : legacyOffset,
                titleSuffix: typeof t.titleSuffix === 'string' ? t.titleSuffix : '',
                content:     typeof t.content === 'string' ? t.content : ''
            };
        });
    } catch {
        return DEFAULT_TEMPLATES;
    }
}

/**
 * 子タスクテンプレート配列を、親タスクの備考欄に保存する形式（JSON文字列）にする。
 *
 * (2) インプット: templates — Array<{ offsetDays, titleSuffix, content }>
 * (4) アウトプット: JSON文字列（空配列の場合は空文字）
 */
export function stringifyChildTemplates(templates) {
    if (!Array.isArray(templates) || templates.length === 0) return '';
    return JSON.stringify(templates);
}

function buildChildTitle(parent, dateStr, template) {
    return template.titleSuffix
        ? `${parent['タイトル']}_${dateStr}_${template.titleSuffix}`
        : `${parent['タイトル']}_${dateStr}`;
}

/**
 * 実行タスクを1件組み立てる。開始予定・終了予定は、いずれもこのテンプレート自身の
 * startOffsetDays／endOffsetDaysを基準日に加えた日付を個別に使う。
 */
function buildChild(parent, template, matchedDate, startDate, targetDate, id, ts) {
    const dateStr = formatYYYYMMDD(matchedDate);

    const child = Object.fromEntries(MAIN_DATA_COLUMNS.map(col => [col, '']));
    child['ID']           = String(id);
    child['データ区分']   = 'タスク';
    child['タイトル']     = buildChildTitle(parent, dateStr, template);
    child['内容']         = template.content || parent['内容'] || '';
    child['カテゴリ']     = parent['カテゴリ']  || '';
    child['タグ']         = parent['タグ']      || '';
    child['親ID']         = String(parent['ID']); // 繰返しテンプレート自身を親IDとして指す（プロジェクトはテンプレートからさらに上を辿って判定する）
    child['優先度']       = parent['優先度']    || '';
    child['見積時間']     = parent['見積時間']  || '';
    child['開始予定']     = formatSlashDate(startDate);
    child['終了予定']     = formatSlashDate(targetDate);
    child['繰返し基準日'] = formatSlashDate(matchedDate); // 同時生成した一群（バッチ）を識別するキー
    child['作成日時']     = ts;
    child['更新日時']     = ts;
    return child;
}

// (3) メイン機能

/**
 * 親タスクから実行タスクを任意タイミングで生成する（手動生成）。指定した日（省略時は今日）を基準日として、
 * 親の備考欄で定義された実行タスクテンプレート（複数可）をすべて生成する。頻度条件はチェックしない。
 * 開始予定・終了予定は、テンプレートごとに個別のオフセット日数（startOffsetDays／endOffsetDays）を
 * 基準日に加えた日付をそれぞれ使う。
 * 生成対象が1件も無かった場合（全テンプレートが基準日分生成済み）は空配列を返す。
 *
 * (2) インプット: parent, mainData, baseDate — 基準日（省略時は今日）
 * (4) アウトプット: 生成した実行タスクオブジェクトの配列（0件の場合は空配列）
 */
export function generateChildManually(parent, mainData, baseDate = new Date()) {
    const matchedDate  = baseDate;
    const matchedSlash = formatSlashDate(matchedDate);
    let currentMaxId    = maxIdIn(mainData);
    const generated      = [];

    const templates = parseChildTemplates(parent['備考']);

    templates.forEach(template => {
        const startDate = new Date(
            matchedDate.getFullYear(), matchedDate.getMonth(), matchedDate.getDate() + template.startOffsetDays
        );
        const targetDate = new Date(
            matchedDate.getFullYear(), matchedDate.getMonth(), matchedDate.getDate() + template.endOffsetDays
        );
        const dateStr = formatYYYYMMDD(matchedDate);
        const title   = buildChildTitle(parent, dateStr, template);

        if (childAlreadyGenerated(mainData, generated, parent['ID'], matchedSlash, title)) return;

        currentMaxId++;
        generated.push(buildChild(parent, template, matchedDate, startDate, targetDate, currentMaxId, makeTsStr(targetDate)));
    });

    return generated;
}
