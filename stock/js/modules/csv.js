// (1) インポート — なし（Web標準APIのみ使用）

/** CSVの1行を、ダブルクォート・カンマのエスケープを考慮しつつ値の配列にパースする。 */
function parseCsvLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (line[i + 1] === '"') { current += '"'; i++; }
                else { inQuotes = false; }
            } else {
                current += ch;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            values.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    values.push(current);
    return values;
}

/**
 * CSV文字列をパースし、1行目をヘッダーとしたオブジェクトの配列を返す。
 *
 * (2) インプット: text — CSV文字列（1行目はヘッダー行）
 * (3) メイン: 行ごとにparseCsvLineで分解し、ヘッダー名をキーにしたオブジェクトへ変換
 * (4) アウトプット: Array<Object>（空行は無視する）
 */
export function parseCsv(text) {
    const lines = (text || '').split(/\r?\n/).filter(l => l.length > 0);
    if (lines.length === 0) return [];

    const headers = parseCsvLine(lines[0]);
    return lines.slice(1).map(line => {
        const values = parseCsvLine(line);
        return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']));
    });
}
