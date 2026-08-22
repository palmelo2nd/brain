// (1) インポート — なし（Web標準APIのみ使用）

// past/(chk済)_C02-2_ディフェンシブ判定ラベル付け.ipynbのスコアリングロジックを移植したものだが、2026-08-22に
// 「下落局面相関」「ボラ比」を別々に重み付けする方式から、両者を統合した下方β（downside beta）1本による
// スコアリングに設計変更した。理由：本アプリの用途は購入金額でのポートフォリオ加重平均によりポートフォリオ
// 全体のディフェンシブ度を算出することだが、加重平均で正しく合成できる（ポートフォリオβ＝Σ w_i・β_i が
// 数学的に厳密に成立する）指標はβだけであり、相関・ボラ比をそれぞれ別スコアとして加重平均する方式や、
// 最大下落比（MDD比。分散効果により個別銘柄のMDDの加重平均はポートフォリオ全体の実際のMDDより悲観的な値になる）
// を加重平均に含める方式は、この用途に対して数学的に整合しない。MDD比自体は完全に廃止した（個別銘柄選定の
// 参考情報としても保持しない）。

const MIN_MONTHS_EQUIVALENT = 24;      // 判定に必要な最低の重複期間（暦月換算。2年未満はブレやすいため除外。旧notebookと同基準）
const MIN_DOWN_MONTHS_EQUIVALENT = 12; // 下方βの算出に必要な最低の下落期間（暦月換算）
const WEEKS_PER_MONTH_APPROX = 4;      // 暦月換算の基準（1ヶ月=4週。returnPeriodWeeksの既定値とは無関係の暦上の近似値）

/**
 * 暦月ベースの最低件数（MIN_MONTHS_EQUIVALENT等）を、リターン算出期間（週）に応じた期間数に換算する。
 * 例: returnPeriodWeeks=4（月次相当）なら24ヶ月→24期間のまま。既定のreturnPeriodWeeks=2（隔週相当）なら
 * 24ヶ月→約48期間というように、期間を短くするほど必要件数が増え、暦年数としての基準は変わらない。
 */
function minPeriodsFor(monthsEquivalent, returnPeriodWeeks) {
    return Math.max(1, Math.round(monthsEquivalent * WEEKS_PER_MONTH_APPROX / returnPeriodWeeks));
}

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

/**
 * 日付昇順のrows（{date, close}）を、anchorDate起点でperiodWeeks週ごとに区切った
 * 「期間インデックス（0, 1, 2, ...）→終値」のMapを返す。
 * 銘柄・N225の両方に同じanchorDateを渡すことで期間の区切り位置を完全に揃える（各系列の最初のデータ日を
 * 起点にすると、データ開始日のズレがそのまま期間インデックスのズレになり、ペアリング時に噛み合わなくなるため）。
 * 同一期間内に複数の取引日があれば、期間内で最後（最新）の終値を採用する（date昇順前提で後勝ち）。
 */
function periodEndCloses(rows, periodWeeks, anchorDate) {
    const anchorMs = new Date(`${anchorDate}T00:00:00Z`).getTime();
    const periodMs = periodWeeks * 7 * 24 * 60 * 60 * 1000;
    const map = new Map();
    rows.forEach(r => {
        const ms = new Date(`${r.date}T00:00:00Z`).getTime();
        const idx = Math.floor((ms - anchorMs) / periodMs);
        map.set(idx, r.close);
    });
    return map;
}

/** 期間インデックス→終値のMapから、期間ごとのリターン（[{period, ret}]、期間インデックス昇順）を返す。 */
function periodicReturns(periodCloseMap) {
    const periods = [...periodCloseMap.keys()].sort((a, b) => a - b);
    const rets = [];
    for (let i = 1; i < periods.length; i++) {
        const prev = periodCloseMap.get(periods[i - 1]);
        const curr = periodCloseMap.get(periods[i]);
        if (prev > 0) rets.push({ period: periods[i], ret: (curr - prev) / prev });
    }
    return rets;
}

/** 値の絶対値がclipを超えていたら丸める（clipがnull/0以下なら丸めない）。ボラ比の外れ値クリップに使う。 */
function clipAbs(value, clip) {
    if (!Number.isFinite(clip) || clip <= 0) return value;
    return Math.max(-clip, Math.min(clip, value));
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

/** 値（低いほど良い指標）を0〜100点に変換する。good以下=100点、bad以上=0点、間は線形補間。算出不能はnull。 */
export function scoreLowBetter(value, good, bad) {
    if (!Number.isFinite(value)) return null;
    if (value <= good) return 100;
    if (value >= bad) return 0;
    return 100 * (bad - value) / (bad - good);
}

/**
 * 銘柄の株価とN225（日経平均）を比較し、下方β（downside beta）に基づくディフェンシブ度スコア
 * （0〜100、高いほど景気非連動＝ディフェンシブ）を算出する。
 *
 * β = 下落局面相関 × 下落局面ボラ比（下落局面のみに絞った相関と標準偏差比を掛け合わせたもの）。
 * ポートフォリオ全体のβは購入金額加重平均で厳密に合成できる（β_portfolio = Σ w_i・β_i）ため、
 * 本アプリの用途（購入金額加重平均でポートフォリオ全体のディフェンシブ度を算出する）に対して
 * 数学的に整合する唯一の指標としてこれを採用している。
 *
 * (2) インプット:
 *   stockPriceRows / n225PriceRows — parseCsvの結果（{date, close}の文字列オブジェクト配列。stock/prices/{code}.csv形式）
 *   params — {
 *     years,                  // N225最終データ日の年を除いた過去years年分（暦年区切り）を対象にする
 *     betaGood, betaBad,      // βのgood/bad閾値（betaGood以下=100点、betaBad以上=0点、線形補間）
 *     downThreshold,          // 下落局面の閾値（N225の期間リターンがこれ未満を「下落局面」とみなす。既定0）
 *     returnPeriodWeeks,      // 期間リターンの区切り（週。4＝月次相当。既定2）
 *     volOutlierClip,         // 期間リターンの絶対値の丸め上限（銘柄・N225の両方に対称適用。nullなら丸めない）
 *   }
 * (3) メイン: N225の最終データ日の年を「今年」として除外し、暦年（1〜12月）区切りで過去years年分に揃える
 *            （銘柄側もN225と同じ年範囲を使うため、データの鮮度が銘柄ごとに違っても計算期間の終点はズレない）
 *            → returnPeriodWeeks刻みの期間リターン化 → N225の期間リターンがdownThreshold未満の期間（下落局面）
 *            だけに絞り、相関と標準偏差比を算出 → β = 相関 × 標準偏差比 → good/badで0-100点化
 * (4) アウトプット: { score, beta, corrDown, volRatio, periods, downPeriods, insufficientData }
 *                   重複期間が暦月換算24ヶ月分未満、または下落局面が12ヶ月分未満の場合は
 *                   score=null, insufficientData=true
 */
export function calcDefensiveScore(stockPriceRows, n225PriceRows, params) {
    const returnPeriodWeeks = Number.isFinite(params.returnPeriodWeeks) && params.returnPeriodWeeks > 0 ? params.returnPeriodWeeks : 2;
    const downThreshold = Number.isFinite(params.downThreshold) ? params.downThreshold : 0;
    const volOutlierClip = Number.isFinite(params.volOutlierClip) && params.volOutlierClip > 0 ? params.volOutlierClip : null;

    const n225Clean = cleanPriceRows(n225PriceRows);
    if (n225Clean.length === 0) {
        return { score: null, beta: null, corrDown: null, volRatio: null, periods: 0, downPeriods: 0, insufficientData: true };
    }
    // N225側の最終データ日の年を「今年」とみなして除外し、銘柄・N225とも同じ暦年範囲（過去years年分）に揃える
    const excludeYear = Number(n225Clean[n225Clean.length - 1].date.slice(0, 4));
    const stock = filterPastCalendarYears(cleanPriceRows(stockPriceRows), excludeYear, params.years);
    const n225  = filterPastCalendarYears(n225Clean, excludeYear, params.years);

    // 銘柄・N225で期間の区切り位置を揃えるため、両方に同じ起点（過去years年分の開始年の1/1）を渡す
    const anchorDate = `${excludeYear - params.years}-01-01`;
    const stockPeriods = periodEndCloses(stock, returnPeriodWeeks, anchorDate);
    const n225Periods  = periodEndCloses(n225, returnPeriodWeeks, anchorDate);

    const stockRets  = periodicReturns(stockPeriods);
    const n225RetMap = new Map(periodicReturns(n225Periods).map(r => [r.period, r.ret]));

    const paired = stockRets
        .filter(r => n225RetMap.has(r.period))
        .map(r => ({ period: r.period, stock: r.ret, n225: n225RetMap.get(r.period) }));

    const minPeriods = minPeriodsFor(MIN_MONTHS_EQUIVALENT, returnPeriodWeeks);
    if (paired.length < minPeriods) {
        return { score: null, beta: null, corrDown: null, volRatio: null, periods: paired.length, downPeriods: 0, insufficientData: true };
    }

    // 下落局面（N225の期間リターンがdownThreshold未満の期間）だけに絞り、相関と標準偏差比を算出する
    const down = paired.filter(p => p.n225 < downThreshold);
    const minDownPeriods = minPeriodsFor(MIN_DOWN_MONTHS_EQUIVALENT, returnPeriodWeeks);
    if (down.length < minDownPeriods) {
        return { score: null, beta: null, corrDown: null, volRatio: null, periods: paired.length, downPeriods: down.length, insufficientData: true };
    }

    const corrDown = correlation(down.map(p => p.stock), down.map(p => p.n225));

    // 外れ値クリップは標準偏差比（ボラ比）側にのみ適用する（相関は既にスケール非依存のため、旧実装と同じ扱いを踏襲）。
    const volStock = stdDev(down.map(p => clipAbs(p.stock, volOutlierClip)));
    const volN225  = stdDev(down.map(p => clipAbs(p.n225, volOutlierClip)));
    const volRatio = volN225 > 0 ? volStock / volN225 : NaN;

    const beta = (Number.isFinite(corrDown) && Number.isFinite(volRatio)) ? corrDown * volRatio : NaN;
    const score = scoreLowBetter(beta, params.betaGood, params.betaBad);

    return {
        score,
        beta: Number.isFinite(beta) ? beta : null,
        corrDown: Number.isFinite(corrDown) ? corrDown : null,
        volRatio: Number.isFinite(volRatio) ? volRatio : null,
        periods: paired.length, downPeriods: down.length, insufficientData: false
    };
}

/**
 * 過去実装（past/(chk済)_C02-2_ディフェンシブ判定ラベル付け.ipynb）で手動指定されていた参考ラベル。
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
 * 数値項目をヒストグラム化する（bin内でカテゴリ別の内訳も集計する。SIMタブの積み上げヒストグラム表示用）。
 *
 * (2) インプット: items — [{ value: number, category: string|null|undefined }]の配列
 *                options — { min, max, binCount }（min/max省略時はitemsのvalueの実際の範囲から自動算出。
 *                          全item同値等でmax<=minになる場合は前後0.5ずつ広げて0除算を避ける）
 * (3) メイン: min〜maxをbinCount等分し、各itemをvalueで対応するbinに割り当て、
 *            bin内をcategory別（null/undefinedは'_none'キー）にも集計する
 * (4) アウトプット: [{ from, to, count, byCategory: { [category]: count } }]（binのfrom昇順。binCount件）
 */
export function buildHistogramBins(items, options = {}) {
    const binCount = options.binCount ?? 20;
    const finiteItems = (items || []).filter(it => Number.isFinite(it.value));

    let min = Number.isFinite(options.min) ? options.min : (finiteItems.length ? Math.min(...finiteItems.map(it => it.value)) : 0);
    let max = Number.isFinite(options.max) ? options.max : (finiteItems.length ? Math.max(...finiteItems.map(it => it.value)) : 1);
    if (max <= min) { min -= 0.5; max += 0.5; }
    const binSize = (max - min) / binCount;

    const bins = Array.from({ length: binCount }, (_, i) => ({
        from: min + i * binSize, to: min + (i + 1) * binSize, count: 0, byCategory: {},
    }));
    finiteItems.forEach(it => {
        const idx = Math.min(binCount - 1, Math.max(0, Math.floor((it.value - min) / binSize)));
        const bin = bins[idx];
        bin.count++;
        const key = it.category || '_none';
        bin.byCategory[key] = (bin.byCategory[key] || 0) + 1;
    });
    return bins;
}
