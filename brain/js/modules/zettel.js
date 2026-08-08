// (1) インポート — なし（純粋な文字列/配列処理のみ）

/**
 * 文字列中の [[ID]] 記法をすべて抽出する。
 *
 * (2) インプット: text — [[ID]]記法を含む可能性のある文字列
 * (3) メイン: 正規表現でIDを抽出し重複を除去
 * (4) アウトプット: ID文字列の配列
 */
export function extractLinkIds(text) {
    if (!text) return [];
    const matches = [...String(text).matchAll(/\[\[(\d+)\]\]/g)];
    return [...new Set(matches.map(m => m[1]))];
}

/**
 * 指定した行IDを [[ID]] 記法で参照している他の行（バックリンク）を集める。
 *
 * (2) インプット: mainData — 全行の配列, targetId — バックリンクを調べたい行のID
 * (3) メイン: 各行の 内容/備考 から extractLinkIds でID群を抽出し、targetIdを含む行（自分自身は除く）を抽出
 * (4) アウトプット: 該当する行の配列
 */
export function findBacklinks(mainData, targetId) {
    const id = String(targetId);
    return mainData.filter(row => {
        if (String(row['ID']) === id) return false;
        const ids = [...extractLinkIds(row['内容']), ...extractLinkIds(row['備考'])];
        return ids.includes(id);
    });
}
