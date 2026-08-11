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
