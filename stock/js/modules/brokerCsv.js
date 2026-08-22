// (1) インポート
import { parseCsvLine } from './csv.js';

/** セルの前後空白・BOM・全角スペースを正規化する。 */
function cleanCell(value) {
    const s = value == null ? '' : String(value);
    return s.replace(/﻿/g, '').replace(/　/g, ' ').trim();
}

/** 文字列から数字（0-9）だけを連結して返す（カンマ・小数点・単位等は除去）。数字が無ければ空文字。 */
function digitsOnly(value) {
    const matches = cleanCell(value).replace(/,/g, '').match(/\d+/g);
    return matches ? matches.join('') : '';
}

/** 文字列からカンマを除去し、数字と小数点だけを残す（小数を保持したい場合に使用）。 */
function numericKeepDecimal(value) {
    return cleanCell(value).replace(/,/g, '').replace(/[^\d.]/g, '');
}

/** テキストを空行区切りのブロック（各ブロックは行の配列）に分割する。 */
function splitIntoBlocks(text) {
    const lines = (text || '').split(/\r?\n/);
    const blocks = [];
    let current = [];
    lines.forEach(line => {
        if (line.trim() === '') {
            if (current.length > 0) { blocks.push(current); current = []; }
        } else {
            current.push(line);
        }
    });
    if (current.length > 0) blocks.push(current);
    return blocks;
}

/**
 * SBI証券の保有証券一覧CSV（Shift-JISでデコード済みのテキスト）をパースし、保有銘柄の配列を返す。
 *
 * ファイルは「見出し（例: 株式（特定預り）／投資信託（金額/NISA預り（つみたて投資枠）） 等）」
 * →「合計内訳（評価額合計等）」→(空行)→「同じ見出し（合計無し）」→「列ヘッダー」→「データ行」という
 * 空行区切りのブロックが繰り返される構造。「合計」で終わる見出しブロックは内訳のみでデータを含まないため無視し、
 * 実データを持つブロック（列ヘッダーに「銘柄コード」または「ファンド名」を含むもの）だけを処理する。
 * つみたて投資枠（投資信託）は保有口数を株数に変換する（÷10000）。口座区分は「特定」「NISA」のいずれか
 * （新NISAの成長投資枠／つみたて投資枠は区別せず、どちらも「NISA」に統一する）。
 *
 * (2) インプット: text — SBI証券からダウンロードした保有証券一覧CSVの内容（デコード済み文字列）
 * (3) メイン: 空行区切りのブロックに分割し、見出しブロックで口座区分を更新、データブロックで各行を抽出
 * (4) アウトプット: Array<{ code, account, shares, avg_cost }>
 */
export function parseSbiHoldingsCsv(text) {
    const blocks = splitIntoBlocks(text).map(lines => lines.map(parseCsvLine));
    const results = [];
    let currentAccount = '不明';

    const accountFromTitle = (title) => {
        if (title.includes('NISA預り')) return 'NISA';
        if (title.includes('特定預り')) return '特定';
        return '不明';
    };

    blocks.forEach(rows => {
        const first = rows.length > 0 && rows[0].length > 0 ? cleanCell(rows[0][0]) : '';

        // 見出しブロック（株式（...）／投資信託（...））。「合計」で終わるものは内訳のみのため無視する
        if (first.startsWith('株式（') || first.startsWith('投資信託（')) {
            if (!first.endsWith('合計')) currentAccount = accountFromTitle(first);
            return;
        }

        // 株式データブロック（1行目が列ヘッダー、2行目以降がデータ）
        if (first.includes('銘柄コード')) {
            rows.slice(1).forEach(row => {
                const code = row.length > 0 ? cleanCell(row[0]) : '';
                if (!code) return;
                results.push({
                    code,
                    account: currentAccount,
                    shares:   row.length > 2 ? digitsOnly(row[2]) : '',
                    avg_cost: row.length > 4 ? digitsOnly(row[4]) : '',
                });
            });
            return;
        }

        // 投資信託（つみたて投資枠）データブロック
        if (first.includes('ファンド名')) {
            rows.slice(1).forEach(row => {
                const fundName = row.length > 0 ? cleanCell(row[0]) : '';
                if (!fundName) return;
                const kuchi = parseFloat(digitsOnly(row.length > 1 ? row[1] : ''));
                if (!kuchi) return;
                results.push({
                    code: fundName,
                    account: 'NISA',
                    shares: String(kuchi / 10000),
                    avg_cost: row.length > 3 ? numericKeepDecimal(row[3]) : '',
                });
            });
        }
    });

    return results;
}

/** 口座を表す文字列を「特定」「NISA」に正規化する。どちらでもなければ元の文字列（trim済み）をそのまま返す。 */
function normalizeAccount(text) {
    const cleaned = cleanCell(text);
    if (cleaned.includes('NISA')) return 'NISA';
    if (cleaned.includes('特定')) return '特定';
    return cleaned;
}

/**
 * 楽天証券の資産残高CSV「保有商品詳細」（Shift-JISでデコード済みのテキスト）をパースし、保有銘柄の配列を返す。
 *
 * SBI証券とは異なり、口座区分ごとにセクションが分かれておらず、1つの表（列ヘッダーに「銘柄コード・ティッカー」
 * 「口座」を含む）に全保有商品がまとまっている。列ヘッダー行を見つけてから、次の空行または次のセクション見出し
 * （「■」で始まる行）までをデータ行として処理する。投資信託は銘柄コード欄が空のため銘柄名をコード代わりに使い、
 * 保有数量の単位（［単位］列）が「口」の場合は株数に変換する（÷10000。基準価額が10,000口あたりの表記のため）。
 *
 * (2) インプット: text — 楽天証券からダウンロードした資産残高CSV（「すべて」保有商品詳細）の内容（デコード済み文字列）
 * (3) メイン: 「銘柄コード・ティッカー」「口座」を含む列ヘッダー行を探し、以降のデータ行を列位置に従って抽出
 * (4) アウトプット: Array<{ code, account, shares, avg_cost }>
 */
export function parseRakutenHoldingsCsv(text) {
    const lines = (text || '').split(/\r?\n/);
    const rows = lines.map(parseCsvLine);

    const results = [];
    let colIdx = null; // null＝まだ保有商品テーブルの列ヘッダーが見つかっていない（テーブル外）

    const findCol = (header, keyContains) => {
        const idx = header.findIndex(cell => cleanCell(cell).includes(keyContains));
        return idx === -1 ? null : idx;
    };
    // 「銘柄」列は「銘柄コード・ティッカー」列も部分一致してしまうため、完全一致で探す
    const findColExact = (header, key) => {
        const idx = header.findIndex(cell => cleanCell(cell) === key);
        return idx === -1 ? null : idx;
    };

    for (const row of rows) {
        const first = row.length > 0 ? cleanCell(row[0]) : '';
        const isBlank = row.every(cell => cleanCell(cell) === '');

        if (first.startsWith('■') || isBlank) {
            colIdx = null; // 新しいセクション・空行に入ったらテーブルの読み取りを終了する
            continue;
        }

        if (!colIdx) {
            if (findCol(row, '銘柄コード') !== null && findCol(row, '口座') !== null) {
                const header = row;
                const sharesCol = findCol(header, '保有数量');
                colIdx = {
                    code:    findCol(header, '銘柄コード・ティッカー'),
                    name:    findColExact(header, '銘柄'),
                    account: findCol(header, '口座'),
                    shares:  sharesCol,
                    sharesUnit: sharesCol === null ? null : sharesCol + 1, // 「保有数量」の直後の列が単位（株／口）
                    avgCost: findCol(header, '平均取得価額'),
                };
                if (colIdx.code === null || colIdx.account === null || colIdx.shares === null || colIdx.avgCost === null) {
                    colIdx = null; // 想定した列が揃わない場合はヘッダーとして扱わない
                }
            }
            continue;
        }

        // データ行
        const name = colIdx.name !== null && row.length > colIdx.name ? cleanCell(row[colIdx.name]) : '';
        const code = (row.length > colIdx.code ? cleanCell(row[colIdx.code]) : '') || name; // 投資信託はコード欄が空のため銘柄名で代用
        if (!code) continue;

        const shares = row.length > colIdx.shares ? digitsOnly(row[colIdx.shares]) : '';
        if (!shares) continue;

        const unit = colIdx.sharesUnit !== null && row.length > colIdx.sharesUnit ? cleanCell(row[colIdx.sharesUnit]) : '';
        const sharesValue = unit === '口' ? String(parseFloat(shares) / 10000) : shares;

        results.push({
            code,
            account: normalizeAccount(row.length > colIdx.account ? row[colIdx.account] : ''),
            shares: sharesValue,
            avg_cost: row.length > colIdx.avgCost ? numericKeepDecimal(row[colIdx.avgCost]) : '',
        });
    }

    return results;
}

/** 証券コード／ティッカーを正規化する（数字のみなら4桁ゼロ埋め、英字混じりは大文字化のみ）。 */
function normalizeSecurityCode(value) {
    const s = cleanCell(value).toUpperCase();
    return /^\d+$/.test(s) ? s.padStart(4, '0') : s;
}

/** '2025/1/5' 'YYYY-M-D' 等の表記ゆれを 'YYYY-MM-DD' に正規化する。分解できなければ空文字。 */
function normalizeTradeDate(value) {
    const s = cleanCell(value).replace(/\//g, '-');
    const [y, m, d] = s.split('-');
    if (!y || !m || !d) return '';
    return `${y.padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/**
 * 「銘柄名 コード」形式の文字列末尾から証券コード（3〜5桁の英数字）を抽出する。
 * 空白区切りの最終トークンが条件に一致すればそれを優先し、一致しなければ末尾からの正規表現検索にフォールバックする
 * （SBI国内株式CSVの「銘柄名」列が「会社名 + 半角スペース + コード」の連結になっているため）。
 * 見つからなければnull。
 */
function extractTrailingCode(value) {
    const s = cleanCell(value);
    if (!s) return null;
    const tokens = s.split(/\s+/);
    const last = tokens[tokens.length - 1];
    if (/^[0-9A-Za-z]{3,5}$/.test(last)) {
        return { code: last, name: tokens.slice(0, -1).join(' ') };
    }
    const m = s.match(/([0-9A-Za-z]{3,5})\s*$/);
    if (!m) return null;
    return { code: m[1], name: s.slice(0, s.length - m[0].length).trim() };
}

/**
 * 「銘柄名/ティッカー」形式の文字列末尾からティッカー（英数字、桁数制限なし）を抽出する。
 * extractTrailingCodeと違いコード側は3〜5桁に限定しない（外国株のティッカーは長さがまちまちのため）。
 * 見つからなければnull。
 */
function extractTrailingTicker(value) {
    const s = cleanCell(value);
    if (!s) return null;
    const tokens = s.split(/\s+/);
    const last = tokens[tokens.length - 1];
    if (last && /^[0-9A-Za-z]+$/.test(last)) {
        return { code: last.toUpperCase(), name: tokens.slice(0, -1).join(' ') };
    }
    const m = s.match(/([A-Za-z0-9]+)\s*$/);
    if (!m) return null;
    return { code: m[1].toUpperCase(), name: s.slice(0, s.length - m[0].length).trim() };
}

/**
 * SBI証券の実現損益CSV（国内株式・外国株式・投資信託で共通）から、
 * 「先頭2列が『約定日』『口座』」の取引テーブルヘッダー行を探す。見つからなければ-1。
 */
function findSbiTradeHeaderIndex(lines) {
    for (let i = 0; i < lines.length; i++) {
        const cells = parseCsvLine(lines[i]);
        if (cells.length >= 2 && cleanCell(cells[0]) === '約定日' && cleanCell(cells[1]) === '口座') return i;
    }
    return -1;
}

/**
 * SBI証券（国内株式）の実現損益CSV（Shift-JISでデコード済みのテキスト）をパースし、実現損益の配列を返す。
 * 「銘柄名」列は「会社名 + コード」の連結のため、末尾のコードを抽出してcode/nameに分離する。
 * 旧notebook（past/(chk済)_C05_(R3)譲渡益の記録.ipynb）と異なり、同日同銘柄の合算は行わず1取引1行のまま返す
 * （縦持ちの取引ログ形式で保存するため、合算せず情報量を保ったほうが扱いやすいという判断。呼び出し側で
 * 重複防止のマージを行う）。
 *
 * (2) インプット: text — SBI証券からダウンロードした実現損益（国内株式）CSVの内容（デコード済み文字列）
 * (3) メイン: 「約定日」「口座」のヘッダー行を探し、以降の行から約定日・銘柄名（→code/name分離）・実現損益を抽出
 * (4) アウトプット: Array<{ code, name, date, pnl }>
 */
export function parseSbiDomesticRealizedGainsCsv(text) {
    const lines = (text || '').split(/\r?\n/);
    const headerIdx = findSbiTradeHeaderIndex(lines);
    if (headerIdx === -1) return [];

    const header = parseCsvLine(lines[headerIdx]).map(cleanCell);
    const dateCol = header.indexOf('約定日');
    const meigaraCol = header.indexOf('銘柄名');
    const pnlCol = header.indexOf('実現損益(税引前・円)');
    if (dateCol === -1 || meigaraCol === -1 || pnlCol === -1) return [];

    const results = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
        if (lines[i].trim() === '') continue;
        const row = parseCsvLine(lines[i]);
        const date = normalizeTradeDate(row[dateCol]);
        const extracted = extractTrailingCode(row[meigaraCol]);
        const pnl = parseFloat(cleanCell(row[pnlCol]).replace(/,/g, ''));
        if (!date || !extracted || Number.isNaN(pnl)) continue;
        results.push({ code: normalizeSecurityCode(extracted.code), name: extracted.name, date, pnl });
    }
    return results;
}

/**
 * SBI証券（外国株式）の実現損益CSV（Shift-JISでデコード済みのテキスト）をパースし、実現損益の配列を返す。
 * 「銘柄名/ティッカー」列末尾のティッカーを抽出する（国内株式と異なり桁数を限定せず、ゼロ埋めもしない）。
 *
 * (2) インプット: text — SBI証券からダウンロードした実現損益（外国株式）CSVの内容（デコード済み文字列）
 * (3) メイン: 「約定日」「口座」のヘッダー行を探し、以降の行から約定日・ティッカー（→code/name分離）・実現損益を抽出
 * (4) アウトプット: Array<{ code, name, date, pnl }>
 */
export function parseSbiForeignRealizedGainsCsv(text) {
    const lines = (text || '').split(/\r?\n/);
    const headerIdx = findSbiTradeHeaderIndex(lines);
    if (headerIdx === -1) return [];

    const header = parseCsvLine(lines[headerIdx]).map(cleanCell);
    const dateCol = header.indexOf('約定日');
    const meigaraCol = header.indexOf('銘柄名/ティッカー');
    const pnlCol = header.indexOf('実現損益(税引前・円)');
    if (dateCol === -1 || meigaraCol === -1 || pnlCol === -1) return [];

    const results = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
        if (lines[i].trim() === '') continue;
        const row = parseCsvLine(lines[i]);
        const date = normalizeTradeDate(row[dateCol]);
        const extracted = extractTrailingTicker(row[meigaraCol]);
        const pnl = parseFloat(cleanCell(row[pnlCol]).replace(/,/g, ''));
        if (!date || !extracted || Number.isNaN(pnl)) continue;
        results.push({ code: extracted.code, name: extracted.name, date, pnl });
    }
    return results;
}

/**
 * SBI証券（投資信託）の実現損益CSV（Shift-JISでデコード済みのテキスト）をパースし、実現損益の配列を返す。
 * 「ファンド名」をそのままcode・name両方に使う（ファンドには証券コードに相当する短い識別子が無いため）。
 *
 * (2) インプット: text — SBI証券からダウンロードした実現損益（投資信託）CSVの内容（デコード済み文字列）
 * (3) メイン: 「約定日」「口座」のヘッダー行を探し、以降の行から約定日・ファンド名・実現損益を抽出
 * (4) アウトプット: Array<{ code, name, date, pnl }>
 */
export function parseSbiFundRealizedGainsCsv(text) {
    const lines = (text || '').split(/\r?\n/);
    const headerIdx = findSbiTradeHeaderIndex(lines);
    if (headerIdx === -1) return [];

    const header = parseCsvLine(lines[headerIdx]).map(cleanCell);
    const dateCol = header.indexOf('約定日');
    const fundCol = header.indexOf('ファンド名');
    const pnlCol = header.indexOf('実現損益(税引前・円)');
    if (dateCol === -1 || fundCol === -1 || pnlCol === -1) return [];

    const results = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
        if (lines[i].trim() === '') continue;
        const row = parseCsvLine(lines[i]);
        const date = normalizeTradeDate(row[dateCol]);
        const fundName = cleanCell(row[fundCol]);
        const pnl = parseFloat(cleanCell(row[pnlCol]).replace(/,/g, ''));
        if (!date || !fundName || Number.isNaN(pnl)) continue;
        results.push({ code: fundName, name: fundName, date, pnl });
    }
    return results;
}

/**
 * 楽天証券の譲渡益CSV（国内株式想定。Shift-JISでデコード済みのテキスト）をパースし、実現損益の配列を返す。
 * SBIと異なりブロック構造を持たず、1行目が列ヘッダーの単純な表。
 *
 * (2) インプット: text — 楽天証券からダウンロードした譲渡益CSVの内容（デコード済み文字列）
 * (3) メイン: 1行目のヘッダーから列位置を特定し、以降の行から約定日・銘柄コード・実現損益を抽出
 * (4) アウトプット: Array<{ code, name, date, pnl }>（nameは楽天CSVに銘柄名列が無いため常に空文字）
 */
export function parseRakutenRealizedGainsCsv(text) {
    const lines = (text || '').split(/\r?\n/).filter(l => l.trim() !== '');
    if (lines.length === 0) return [];

    const header = parseCsvLine(lines[0]).map(cleanCell);
    const dateCol = header.indexOf('約定日');
    const codeCol = header.indexOf('銘柄コード');
    const pnlCol = header.indexOf('実現損益[円]');
    if (dateCol === -1 || codeCol === -1 || pnlCol === -1) return [];

    const results = [];
    for (let i = 1; i < lines.length; i++) {
        const row = parseCsvLine(lines[i]);
        const date = normalizeTradeDate(row[dateCol]);
        const code = normalizeSecurityCode(row[codeCol]);
        const pnl = parseFloat(cleanCell(row[pnlCol]).replace(/,/g, ''));
        if (!date || !code || Number.isNaN(pnl)) continue;
        results.push({ code, name: '', date, pnl });
    }
    return results;
}
