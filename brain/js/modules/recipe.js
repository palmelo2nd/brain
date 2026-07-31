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
