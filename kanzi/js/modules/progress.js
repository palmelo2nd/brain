// (1) インポート — なし（progressData配列の集計・加工のみ）

/**
 * 指定した漢字IDの学習記録行を取得する。
 *
 * (2) インプット: progressData, id
 * (3) メイン: ID列（キー名）で検索。行番号には依存しない
 * (4) アウトプット: 該当行 or null
 */
export function getProgressRow(progressData, id) {
    return progressData.find(r => String(r['ID']) === String(id)) || null;
}

/**
 * 正答率を計算する。
 *
 * (2) インプット: progressRow（null許容）
 * (3) メイン: 正解回数 / 出題回数
 * (4) アウトプット: 0〜1の数値。出題回数0またはnullの場合はnull
 */
export function calcAccuracy(progressRow) {
    if (!progressRow || !progressRow['出題回数']) return null;
    return progressRow['正解回数'] / progressRow['出題回数'];
}

/**
 * 1問回答した結果をprogressDataへ反映した新しい配列を作る（元配列は変更しない）。
 *
 * (2) インプット: progressData, id, isCorrect, nowIso
 * (3) メイン: 既存行があれば出題回数・正解回数・連続正解・最終学習日時を更新、なければ新規行を追加
 * (4) アウトプット: 更新後のprogressData配列（複製）
 */
export function applyAnswer(progressData, id, isCorrect, nowIso = new Date().toISOString()) {
    const existing   = getProgressRow(progressData, id);
    const 出題回数 = (existing?.['出題回数'] || 0) + 1;
    const 正解回数 = (existing?.['正解回数'] || 0) + (isCorrect ? 1 : 0);
    const 連続正解 = isCorrect ? (existing?.['連続正解'] || 0) + 1 : 0;
    const updatedRow = { ID: id, 出題回数, 正解回数, 連続正解, 最終学習日時: nowIso };

    const idx  = progressData.findIndex(r => String(r['ID']) === String(id));
    const next = progressData.slice();
    if (idx === -1) next.push(updatedRow); else next[idx] = updatedRow;
    return next;
}

/**
 * 漢字1件の出題重みを計算する。未学習・正答率が低い漢字ほど大きくなる。
 *
 * (2) インプット: kanjiRow, progressData
 * (3) メイン: 正答率が低いほど重みを増やす。未学習は中間よりやや高めの重み
 * (4) アウトプット: 重み（正の数値）
 */
export function calcWeight(kanjiRow, progressData) {
    const row = getProgressRow(progressData, kanjiRow['ID']);
    const accuracy = calcAccuracy(row);
    if (accuracy === null) return 1.2;
    return Math.max(0.15, 1 - accuracy) + 0.1;
}

/**
 * 出題重みに応じた非復元抽出で漢字を選ぶ（苦手・未学習な漢字ほど出やすい）。
 *
 * (2) インプット: kanjiList, progressData, count
 * (3) メイン: 重み付きルーレット選択をcount回繰り返す
 * (4) アウトプット: 選ばれた漢字行の配列（重複なし、kanjiList.lengthを上限）
 */
export function weightedSample(kanjiList, progressData, count) {
    const pool = kanjiList.map(item => ({ item, weight: calcWeight(item, progressData) }));
    const result = [];

    while (result.length < count && pool.length > 0) {
        const total = pool.reduce((sum, p) => sum + p.weight, 0);
        let r = Math.random() * total;
        let idx = 0;
        for (; idx < pool.length - 1; idx++) {
            r -= pool[idx].weight;
            if (r <= 0) break;
        }
        result.push(pool[idx].item);
        pool.splice(idx, 1);
    }
    return result;
}

/**
 * 苦手な漢字（正答率が低く、一定回数以上出題済み）を抽出する。
 *
 * (2) インプット: kanjiList, progressData, minAttempts, threshold
 * (3) メイン: 各漢字の正答率を計算し、条件を満たすものを正答率の低い順に並べる
 * (4) アウトプット: [{ kanjiRow, accuracy, attempts }] の配列
 */
export function getWeakKanji(kanjiList, progressData, minAttempts = 3, threshold = 0.6) {
    return kanjiList
        .map(kanjiRow => {
            const row = getProgressRow(progressData, kanjiRow['ID']);
            return { kanjiRow, accuracy: calcAccuracy(row), attempts: row?.['出題回数'] || 0 };
        })
        .filter(e => e.attempts >= minAttempts && e.accuracy !== null && e.accuracy < threshold)
        .sort((a, b) => a.accuracy - b.accuracy);
}

/**
 * 対象漢字リスト全体の学習状況サマリーを集計する。
 *
 * (2) インプット: kanjiList, progressData
 * (3) メイン: 学習済み件数・全体正答率を集計
 * (4) アウトプット: { total, attempted, averageAccuracy }
 */
export function summarizeProgress(kanjiList, progressData) {
    let attempted = 0;
    let accuracySum = 0;
    for (const kanjiRow of kanjiList) {
        const row = getProgressRow(progressData, kanjiRow['ID']);
        const accuracy = calcAccuracy(row);
        if (accuracy !== null) {
            attempted += 1;
            accuracySum += accuracy;
        }
    }
    return {
        total: kanjiList.length,
        attempted,
        averageAccuracy: attempted > 0 ? accuracySum / attempted : null
    };
}
