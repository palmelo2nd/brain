// (1) インポート — なし（Web標準APIのみ使用）

// past/C02-2_ディフェンシブ判定ラベル付け.ipynb のスコアリングロジックを移植したもの。
// 「改善①〜④」（MDDクリップ・vol許容レンジ緩和・条件付き重み変更・救済ルール）は未移植。
// まずは3指標＋固定加重平均のみのシンプルな計算で様子を見る方針（SIMタブでの調整はgood/bad閾値と重みのみ）。

const MIN_MONTHS = 24;      // 判定に必要な最低の重複月数（2年未満はブレやすいため除外。旧notebookと同基準）
const MIN_DOWN_MONTHS = 12; // 下落局面相関の算出に必要な最低の下落月数

/** date/close文字列オブジェクトの配列を、日付昇順・数値化・不正行除外した状態にする。 */
function cleanPriceRows(rows) {
    return (rows || [])
        .map(r => ({ date: String(r.date || '').trim(), close: Number(r.close) }))
        .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.close))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * 暦年（1〜12月）区切りで、今年（excludeYear）を除いた過去years年分（[excludeYear-years, excludeYear-1]）に絞り込む。
 * 銘柄・N225の両方に同じexcludeYearを渡すことで、計算期間の終点を揃える。
 */
function filterPastCalendarYears(rows, excludeYear, years) {
    const fromYear = excludeYear - years;
    const toYear = excludeYear - 1;
    return rows.filter(r => {
        const y = Number(r.date.slice(0, 4));
        return y >= fromYear && y <= toYear;
    });
}

/** 月末終値のMap（key="YYYY-MM"）を返す。日付昇順前提で、同月内は後勝ち＝自動的に月末値が残る。 */
function monthEndCloses(rows) {
    const map = new Map();
    rows.forEach(r => map.set(r.date.slice(0, 7), r.close));
    return map;
}

/** 月末終値Mapから月次リターン（[{month, ret}]、月昇順）を返す。 */
function monthlyReturns(monthCloseMap) {
    const months = [...monthCloseMap.keys()].sort();
    const rets = [];
    for (let i = 1; i < months.length; i++) {
        const prev = monthCloseMap.get(months[i - 1]);
        const curr = monthCloseMap.get(months[i]);
        if (prev > 0) rets.push({ month: months[i], ret: (curr - prev) / prev });
    }
    return rets;
}

function mean(values) { return values.reduce((s, v) => s + v, 0) / values.length; }

function stdDev(values) {
    if (values.length === 0) return NaN;
    const m = mean(values);
    return Math.sqrt(mean(values.map(v => (v - m) ** 2)));
}

function correlation(xs, ys) {
    if (xs.length < 2) return NaN;
    const mx = mean(xs), my = mean(ys);
    const cov = mean(xs.map((x, i) => (x - mx) * (ys[i] - my)));
    const sx = stdDev(xs), sy = stdDev(ys);
    if (sx === 0 || sy === 0) return NaN;
    return cov / (sx * sy);
}

/** 月末終値Mapから最大ドローダウン（負の値。下落が無ければ0）を計算する。 */
function maxDrawdown(monthCloseMap) {
    const months = [...monthCloseMap.keys()].sort();
    if (months.length === 0) return NaN;
    let peak = -Infinity, worst = 0;
    months.forEach(m => {
        const v = monthCloseMap.get(m);
        peak = Math.max(peak, v);
        worst = Math.min(worst, (v / peak) - 1);
    });
    return worst;
}

/** 値（低いほど良い指標）を0〜100点に変換する。good以下=100点、bad以上=0点、間は線形補間。算出不能はnull。 */
export function scoreLowBetter(value, good, bad) {
    if (!Number.isFinite(value)) return null;
    if (value <= good) return 100;
    if (value >= bad) return 0;
    return 100 * (bad - value) / (bad - good);
}

/**
 * 銘柄の株価とN225（日経平均）を比較し、ディフェンシブ度スコア（0〜100、高いほど景気非連動＝ディフェンシブ）を算出する。
 *
 * (2) インプット:
 *   stockPriceRows / n225PriceRows — parseCsvの結果（{date, close}の文字列オブジェクト配列。stock/prices/{code}.csv形式）
 *   params — { years, wDown, wVol, wMdd, downGood, downBad, volGood, volBad, mddGood, mddBad }
 * (3) メイン: N225の最終データ日の年を「今年」として除外し、暦年（1〜12月）区切りで過去years年分に揃える
 *            （銘柄側もN225と同じ年範囲を使うため、データの鮮度が銘柄ごとに違っても計算期間の終点はズレない）
 *            → 月次リターン化 → 下落局面相関／ボラ比／MDD比の3指標を算出 → good/badで0-100点化 → 加重平均
 *            （欠損指標は中立50点として扱う。調整ロジック・救済ルールの類は無し）
 * (4) アウトプット: { score, scoreDown, scoreVol, scoreMdd, corrDown, volRatio, mddRatio, months, downMonths, insufficientData }
 *                   重複データが24ヶ月未満の場合は score=null, insufficientData=true
 */
export function calcDefensiveScore(stockPriceRows, n225PriceRows, params) {
    const n225Clean = cleanPriceRows(n225PriceRows);
    if (n225Clean.length === 0) {
        return { score: null, scoreDown: null, scoreVol: null, scoreMdd: null, corrDown: null, volRatio: null, mddRatio: null, months: 0, downMonths: 0, insufficientData: true };
    }
    // N225側の最終データ日の年を「今年」とみなして除外し、銘柄・N225とも同じ暦年範囲（過去years年分）に揃える
    const excludeYear = Number(n225Clean[n225Clean.length - 1].date.slice(0, 4));
    const stock = filterPastCalendarYears(cleanPriceRows(stockPriceRows), excludeYear, params.years);
    const n225  = filterPastCalendarYears(n225Clean, excludeYear, params.years);

    const stockMonths = monthEndCloses(stock);
    const n225Months  = monthEndCloses(n225);

    const stockRets  = monthlyReturns(stockMonths);
    const n225RetMap = new Map(monthlyReturns(n225Months).map(r => [r.month, r.ret]));

    const paired = stockRets
        .filter(r => n225RetMap.has(r.month))
        .map(r => ({ month: r.month, stock: r.ret, n225: n225RetMap.get(r.month) }));

    if (paired.length < MIN_MONTHS) {
        return { score: null, scoreDown: null, scoreVol: null, scoreMdd: null, corrDown: null, volRatio: null, mddRatio: null, months: paired.length, downMonths: 0, insufficientData: true };
    }

    // 下落局面相関（N225がマイナスの月だけの相関） … 低いほど良い
    const down = paired.filter(p => p.n225 < 0);
    const corrDown = down.length >= MIN_DOWN_MONTHS ? correlation(down.map(p => p.stock), down.map(p => p.n225)) : NaN;
    const scoreDown = scoreLowBetter(corrDown, params.downGood, params.downBad);

    // ボラ比（月次リターンの標準偏差の比） … 低いほど良い
    const volStock = stdDev(paired.map(p => p.stock));
    const volN225  = stdDev(paired.map(p => p.n225));
    const volRatio = volN225 > 0 ? volStock / volN225 : NaN;
    const scoreVol = scoreLowBetter(volRatio, params.volGood, params.volBad);

    // MDD比（最大ドローダウンの比） … 低いほど良い
    const mddStock = maxDrawdown(stockMonths);
    const mddN225  = maxDrawdown(n225Months);
    const mddRatio = Math.abs(mddN225) > 1e-12 ? Math.abs(mddStock) / Math.abs(mddN225) : NaN;
    const scoreMdd = scoreLowBetter(mddRatio, params.mddGood, params.mddBad);

    const sd = scoreDown ?? 50, sv = scoreVol ?? 50, sm = scoreMdd ?? 50;
    const wSum = params.wDown + params.wVol + params.wMdd;
    const score = wSum > 0 ? (params.wDown * sd + params.wVol * sv + params.wMdd * sm) / wSum : null;

    return {
        score, scoreDown: sd, scoreVol: sv, scoreMdd: sm,
        corrDown: Number.isFinite(corrDown) ? corrDown : null,
        volRatio: Number.isFinite(volRatio) ? volRatio : null,
        mddRatio: Number.isFinite(mddRatio) ? mddRatio : null,
        months: paired.length, downMonths: down.length, insufficientData: false
    };
}

/**
 * 過去実装（past/C02-2_ディフェンシブ判定ラベル付け.ipynb）で手動指定されていた参考ラベル。
 * L_defラベル自体は廃止（スコアによる連続評価に一本化）したため、01_IDmap.csv相当のどこにも保存・反映されないが、
 * SIMタブで新スコアとの比較表示にのみ使う参考データとしてここに残す。
 */
export const REFERENCE_LABELS = new Map([
    ...['1723', '1951', '1976', '2003', '2169', '2185', '2269', '2317',
        '2374', '2391', '2659', '3333', '3771', '3834', '4540', '4719',
        '4743', '6458', '6745', '7292', '7438', '7483', '7723',
        '7749', '7817', '7921', '7994', '9057', '9069', '9303', '9364',
        '9368', '9381', '9687', '9769', '9795'].map(code => [code, 'defensive']),
    ...['1414', '1928', '1980', '3076', '3231', '3817', '4008', '4041',
        '4042', '4097', '4220', '4345', '4401', '4641', '4748', '4752',
        '4832', '4972', '5011', '5186', '5388', '5464', '6322', '6345', '6381',
        '6432', '6454', '6652', '6785', '6957', '7820', '7931', '7989',
        '8130', '9233', '9304', '9882', '9960', '9986'].map(code => [code, 'offensive']),
]);

/**
 * スコア配列を指定bin幅でヒストグラム化する。
 *
 * (2) インプット: scores — 数値配列（0〜100）, binSize — bin幅（既定5）
 * (3) メイン: 0〜100をbinSize刻みで区切り、各binに入る件数を数える
 * (4) アウトプット: [{ from, to, count }]（binStart昇順）
 */
export function buildHistogramBins(scores, binSize = 5) {
    const binCount = Math.ceil(100 / binSize);
    const bins = Array.from({ length: binCount }, (_, i) => ({ from: i * binSize, to: Math.min(100, (i + 1) * binSize), count: 0 }));
    (scores || []).forEach(s => {
        if (!Number.isFinite(s)) return;
        const idx = Math.min(binCount - 1, Math.max(0, Math.floor(s / binSize)));
        bins[idx].count++;
    });
    return bins;
}
