// (1) インポート — なし（純粋な判定/計算のみ）

const READING_TAG   = '読書';
const QA_PARA_MARKER = 'QAカード'; // マスタ非登録のコード判定用特殊値（PARA区分特殊値。1日タスクと同じ前例パターン）

/**
 * 行が「本」行（読書タグの最上位行）かどうかを判定する。
 * (2) インプット: row — mainData の1行
 * (3) メイン: データ区分＝ナレッジ・タグ＝読書・親IDなし で判定
 * (4) アウトプット: boolean
 */
export function isBookRow(row) {
    return row['データ区分'] === 'ナレッジ' && row['タグ'] === READING_TAG && !row['親ID'];
}

/**
 * 行がQAカード（一問一答の暗記カード）かどうかを判定する。
 * (2) インプット: row — mainData の1行
 * (3) メイン: データ区分＝ナレッジ・PARA区分＝QAカード で判定
 * (4) アウトプット: boolean
 */
export function isQaCardRow(row) {
    return row['データ区分'] === 'ナレッジ' && row['PARA区分'] === QA_PARA_MARKER;
}

/**
 * 行が章メモ（本または章の子で、QAカードでない）かどうかを判定する。
 * (2) インプット: row — mainData の1行
 * (3) メイン: データ区分＝ナレッジ・親IDあり・QAカードでない で判定
 * (4) アウトプット: boolean
 */
export function isChapterRow(row) {
    return row['データ区分'] === 'ナレッジ' && !!row['親ID'] && !isQaCardRow(row);
}

/**
 * 指定した本IDの直下にある章メモ行を返す（更新日時の新しい順）。
 * (2) インプット: mainData, bookId
 * (3) メイン: 親ID一致 かつ 章メモ判定でフィルタし、更新日時降順ソート
 * (4) アウトプット: Array
 */
export function getChapters(mainData, bookId) {
    return mainData
        .filter(r => String(r['親ID']) === String(bookId) && isChapterRow(r))
        .sort((a, b) => (b['更新日時'] || '').localeCompare(a['更新日時'] || ''));
}

/**
 * 指定した章IDの直下にあるQAカード行を返す（更新日時の新しい順）。
 * (2) インプット: mainData, chapterId
 * (3) メイン: 親ID一致 かつ QAカード判定でフィルタし、更新日時降順ソート
 * (4) アウトプット: Array
 */
export function getQaCards(mainData, chapterId) {
    return mainData
        .filter(r => String(r['親ID']) === String(chapterId) && isQaCardRow(r))
        .sort((a, b) => (b['更新日時'] || '').localeCompare(a['更新日時'] || ''));
}

/**
 * 新規QAカード行に設定するPARA区分の特殊値を返す。
 * (2) インプット: なし
 * (3) メイン: 定数を返すのみ
 * (4) アウトプット: string
 */
export function getQaParaMarker() {
    return QA_PARA_MARKER;
}

/**
 * 配列をシャッフルした新しい配列を返す（Fisher-Yates）。元の配列は変更しない。
 * (2) インプット: arr — シャッフル対象の配列
 * (3) メイン: 末尾から順にランダムな位置と交換
 * (4) アウトプット: シャッフル済みの新しい配列
 */
export function shuffleArray(arr) {
    const result = [...arr];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}
