// (1) インポート — なし（純粋な文字列/オブジェクト変換のみ）

// 永久保存レシピの構造化セクション（内容欄に "## 見出し" 形式で保存する）
export const RECIPE_SECTIONS = ['想定人数', '材料', '前処理', '作り方', '改善点'];

const RECIPE_TAG = '料理';
const RECIPE_STATUS_PERMANENT = '永久保存';
const RECIPE_STATUS_TEMP      = '一時メモ';

/**
 * 行がレシピ（タグ＝料理のナレッジ行）かどうかを判定する。
 * (2) インプット: row — mainData の1行
 * (3) メイン: データ区分＝ナレッジ かつ タグ＝料理 で判定
 * (4) アウトプット: boolean
 */
export function isRecipeRow(row) {
    return row['データ区分'] === 'ナレッジ' && row['タグ'] === RECIPE_TAG;
}

/**
 * レシピ行が構造化フォーム対象（永久保存）かどうかを判定する。
 * (2) インプット: row — mainData の1行
 * (3) メイン: ステータス＝永久保存 で判定
 * (4) アウトプット: boolean
 */
export function isPermanentRecipe(row) {
    return row['ステータス'] === RECIPE_STATUS_PERMANENT;
}

/**
 * "## 見出し\n本文" 形式の内容テキストを、セクション名→本文のオブジェクトへ分解する。
 * (2) インプット: content — 内容欄の文字列
 * (3) メイン: "## " で始まる行を見出しとして分割し、既知セクションのみ抽出
 * (4) アウトプット: { [セクション名]: string }
 */
export function parseRecipeContent(content) {
    const result = Object.fromEntries(RECIPE_SECTIONS.map(s => [s, '']));
    if (!content) return result;

    const lines = content.split(/\r?\n/);
    let current = null;
    const buffers = {};

    lines.forEach(line => {
        const m = line.match(/^##\s+(.+?)\s*$/);
        if (m && RECIPE_SECTIONS.includes(m[1])) {
            current = m[1];
            buffers[current] = [];
        } else if (current) {
            buffers[current].push(line);
        }
    });

    RECIPE_SECTIONS.forEach(s => {
        if (buffers[s]) result[s] = buffers[s].join('\n').trim();
    });
    return result;
}

/**
 * セクション名→本文のオブジェクトを、"## 見出し\n本文" 形式の内容テキストへ組み立てる。
 * (2) インプット: sections — { [セクション名]: string }
 * (3) メイン: RECIPE_SECTIONS の順に "## 見出し" とその本文を連結
 * (4) アウトプット: 内容欄に保存する文字列
 */
export function buildRecipeContent(sections) {
    return RECIPE_SECTIONS
        .map(s => `## ${s}\n${(sections[s] || '').trim()}`)
        .join('\n\n');
}

const INGREDIENT_FIELDS = ['name', 'qty', 'unit', 'note'];

/**
 * 材料セクションの文字列（1行1食材、"食材名|数量|単位|備考" 区切り）を行オブジェクト配列へ分解する。
 * (2) インプット: text — 材料セクションの文字列
 * (3) メイン: 改行で分割し、"|" 区切りで4フィールドへ分解。空行は除外
 * (4) アウトプット: { name, qty, unit, note }[]
 */
export function parseIngredientText(text) {
    if (!text) return [];
    return text.split(/\r?\n/)
        .map(line => line.split('|').map(s => s.trim()))
        .filter(cols => cols.some(c => c))
        .map(cols => Object.fromEntries(INGREDIENT_FIELDS.map((f, i) => [f, cols[i] || ''])));
}

/**
 * 材料の行オブジェクト配列を、材料セクションに保存する文字列へ組み立てる。
 * (2) インプット: rows — { name, qty, unit, note }[]
 * (3) メイン: 空行（4項目とも空）を除外し、各行を "|" 区切りで連結
 * (4) アウトプット: 材料セクションに保存する文字列
 */
export function buildIngredientText(rows) {
    return (rows || [])
        .filter(r => INGREDIENT_FIELDS.some(f => (r[f] || '').trim()))
        .map(r => INGREDIENT_FIELDS.map(f => r[f] || '').join('|'))
        .join('\n');
}

/**
 * 人数を表す文字列（例: "2人分"）から先頭の数値を取り出す。
 * (2) インプット: servingsText — 想定人数欄の文字列
 * (3) メイン: 数値部分を正規表現で抽出
 * (4) アウトプット: number | null（数値が見つからない場合）
 */
export function extractServingsNumber(servingsText) {
    const m = String(servingsText || '').match(/[\d.]+/);
    return m ? parseFloat(m[0]) : null;
}

/**
 * 前処理／作り方セクションの文字列（1行1手順）を手順配列へ分解する。
 * (2) インプット: text — セクションの文字列
 * (3) メイン: 改行で分割し、前後空白を除去。空行は除外
 * (4) アウトプット: string[]
 */
export function parseStepList(text) {
    if (!text) return [];
    return text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

/**
 * 手順配列を、セクションに保存する文字列（1行1手順）へ組み立てる。
 * (2) インプット: steps — string[]
 * (3) メイン: 空行を除外し、改行で連結
 * (4) アウトプット: セクションに保存する文字列
 */
export function buildStepList(steps) {
    return (steps || []).map(s => s.trim()).filter(Boolean).join('\n');
}

/**
 * 材料の行オブジェクト配列を、基準人数→目標人数の比率で数量換算する。
 * (2) インプット: rows — { name, qty, unit, note }[], baseServings/targetServings — 人数欄の文字列
 * (3) メイン: 基準・目標のいずれかが数値化できない場合は無換算。数量が数値の行のみ換算（小数点2桁まで）
 * (4) アウトプット: 換算後の行オブジェクト配列（新規配列）
 */
export function scaleIngredientRows(rows, baseServings, targetServings) {
    const base   = extractServingsNumber(baseServings);
    const target = extractServingsNumber(targetServings);
    if (!base || !target || base <= 0) return rows;
    const ratio = target / base;
    return rows.map(r => {
        const qtyNum = parseFloat(r.qty);
        if (isNaN(qtyNum)) return r;
        return { ...r, qty: String(Math.round(qtyNum * ratio * 100) / 100) };
    });
}
