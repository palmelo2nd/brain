// (1) No external imports needed

const WORK_TYPES = ['出勤日', '休日', '有給', '特別休暇'];

// (2) Input: contentText (string) from main data 内容 field, plus year/month for calendar computation
// (3) Parse / compute / serialize

/**
 * Parses exception lines from the 内容 text.
 * Line format: "YYYY/MM/DD 種別 備考（任意）"
 * @param {string} contentText
 * @returns {Map<string, {type: string, note: string}>}
 */
export function parseExceptions(contentText) {
    const map = new Map();
    if (!contentText) return map;
    for (const line of contentText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const m = trimmed.match(/^(\d{4}\/\d{2}\/\d{2})\s+(\S+)(?:\s+(.*))?$/);
        if (!m) continue;
        const [, date, type, note = ''] = m;
        if (WORK_TYPES.includes(type)) {
            map.set(date, { type, note: note.trim() });
        }
    }
    return map;
}

/**
 * Serializes exceptions map back to content text, sorted by date.
 * @param {Map<string, {type: string, note: string}>} exceptionsMap
 * @returns {string}
 */
export function stringifyExceptions(exceptionsMap) {
    return [...exceptionsMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, { type, note }]) => note ? `${date} ${type} ${note}` : `${date} ${type}`)
        .join('\n');
}

/**
 * Returns the default work type for a given Date.
 * Mon–Fri → "出勤日", Sat–Sun → "休日"
 * @param {Date} date
 * @returns {string}
 */
export function getDefaultType(date) {
    const dow = date.getDay();
    return (dow === 0 || dow === 6) ? '休日' : '出勤日';
}

/**
 * Computes full calendar data for the given year/month.
 * Default rule applied first, then exceptions overlay.
 * @param {string} contentText
 * @param {number} year
 * @param {number} month - 0-indexed (0 = January)
 * @returns {Array<{date: string, dayOfWeek: number, type: string, defaultType: string, note: string, isException: boolean}>}
 */
export function computeMonthCalendar(contentText, year, month) {
    const exceptions  = parseExceptions(contentText);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    return Array.from({ length: daysInMonth }, (_, i) => {
        const d       = i + 1;
        const dateObj = new Date(year, month, d);
        const mm      = String(month + 1).padStart(2, '0');
        const dd      = String(d).padStart(2, '0');
        const dateStr = `${year}/${mm}/${dd}`;
        const defaultType = getDefaultType(dateObj);
        const exception   = exceptions.get(dateStr);
        return {
            date:        dateStr,
            dayOfWeek:   dateObj.getDay(),
            type:        exception ? exception.type : defaultType,
            defaultType,
            note:        exception ? exception.note : '',
            isException: !!exception,
        };
    });
}

// (4) Return: computeMonthStats is a utility used after computeMonthCalendar

/**
 * Computes summary counts for a month's calendar data.
 * @param {Array} monthDays - output of computeMonthCalendar
 * @returns {{出勤日: number, 休日: number, 有給: number, 特別休暇: number}}
 */
export function computeMonthStats(monthDays) {
    const stats = { 出勤日: 0, 休日: 0, 有給: 0, 特別休暇: 0 };
    for (const day of monthDays) {
        if (day.type in stats) stats[day.type]++;
    }
    return stats;
}
