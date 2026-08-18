// (1) インポート — なし（Web標準APIのみ使用）

// past/C02-2_ディフェンシブ判定ラベル付け.ipynb のスコアリングロジックを移植したもの。
// 「改善①〜④」のうち、MDDクリップ（下限クリップ・ローリング窓）とvol許容レンジ緩和（下方偏差モード・外れ値クリップ）に
// 相当する指標定義の調整は、SIMタブ「指標の定義」欄から設定できる（2026-08-18実装。3指標＋固定加重平均という
// 骨格自体は変えていない）。条件付き重み変更・救済ルールは未移植。

const MIN_MONTHS_EQUIVALENT = 24;      // 判定に必要な最低の重複期間（暦月換算。2年未満はブレやすいため除外。旧notebookと同基準）
const MIN_DOWN_MONTHS_EQUIVALENT = 12; // 下落局面相関の算出に必要な最低の下落期間（暦月換算）
const WEEKS_PER_MONTH_APPROX = 4;      // 暦月換算の基準（リターン算出期間の既定値=4週=月次相当と揃えている）

/**
 * 暦月ベースの最低件数（MIN_MONTHS_EQUIVALENT等）を、リターン算出期間（週）に応じた期間数に換算する。
 * 例: 既定のreturnPeriodWeeks=4（月次相当）なら24ヶ月→24期間のまま。returnPeriodWeeks=1（週次）なら
 * 24ヶ月→約96期間（≒96週）というように、期間を短くするほど必要件数が増え、暦年数としての基準は変わらない。
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

/**
 * 日足終値配列（date昇順の数値配列）から最大ドローダウン（負の値。下落が無ければ0）を計算する。
 * リターン算出期間（週）とは無関係に、常に日足の粒度で計算する（月次等に間引かない）。
 *
 * options.floorClip（負の値）を指定すると、各時点のドローダウン値をfloorClipで底打ちしてから使う
 * （floorClipより深い下落は一律floorClipとして扱う。null/未指定なら底打ちしない）。
 * options.rollingを指定すると、windowSize日ぶんのトレーリング窓ごとに最大ドローダウンを計算し、
 * その時系列をagg（'mean'=平均｜'max'=窓の中で最も深い値）で1つの値にまとめる
 * （rolling省略時は系列全体を通した単一の最大ドローダウンを返す。旧実装の挙動と同じ）。
 */
function computeDrawdownMetric(closes, { floorClip = null, rolling = null } = {}) {
    const clipDd = dd => (Number.isFinite(floorClip) && floorClip < 0) ? Math.max(floorClip, dd) : dd;

    if (!rolling) {
        let peak = -Infinity, worst = 0;
        closes.forEach(v => {
            peak = Math.max(peak, v);
            worst = Math.min(worst, clipDd((v / peak) - 1));
        });
        return worst;
    }

    if (closes.length === 0) return NaN;
    const { windowSize, agg } = rolling;
    const windowWorstList = [];
    for (let end = 0; end < closes.length; end++) {
        const start = Math.max(0, end - windowSize + 1);
        let peak = -Infinity, worst = 0;
        for (let i = start; i <= end; i++) {
            peak = Math.max(peak, closes[i]);
            worst = Math.min(worst, clipDd((closes[i] / peak) - 1));
        }
        windowWorstList.push(worst);
    }
    // 'max'＝複数の窓のうち最も深い下落（ドローダウンは負値なので数値としては最小のもの）を採用
    return agg === 'max' ? Math.min(...windowWorstList) : mean(windowWorstList);
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
 *   params — {
 *     years, wDown, wVol, wMdd, downGood, downBad, volGood, volBad, mddGood, mddBad,
 *     downThreshold,          // 下落局面相関・下方偏差モードの閾値（N225の期間リターンがこれ未満を「下落局面」とみなす。既定0）
 *     returnPeriodWeeks,      // 下落局面相関・ボラ比の算出に使う期間リターンの区切り（週。既定4＝月次相当）
 *     volDownsideOnly,        // true なら標準偏差の対象を下落局面のみ（下方偏差）にする
 *     volOutlierClip,         // 期間リターンの絶対値の丸め上限（銘柄・N225の両方に対称適用。nullなら丸めない）
 *     mddFloorClip,           // ドローダウンの底打ち値（負の値。銘柄・N225の両方に対称適用。nullなら底打ちしない）
 *     mddRollingEnabled, mddRollingWindowWeeks, mddRollingAgg, // trueなら日足のローリング窓（週→日換算）でMDDを算出し'mean'|'max'で集約
 *   }
 * (3) メイン: N225の最終データ日の年を「今年」として除外し、暦年（1〜12月）区切りで過去years年分に揃える
 *            （銘柄側もN225と同じ年範囲を使うため、データの鮮度が銘柄ごとに違っても計算期間の終点はズレない）
 *            → returnPeriodWeeks刻みの期間リターン化 → 下落局面相関／ボラ比を算出（MDD比は日足を直接使用。
 *            期間の粒度とは独立） → good/badで0-100点化 → 加重平均（欠損指標は中立50点として扱う）
 * (4) アウトプット: { score, scoreDown, scoreVol, scoreMdd, corrDown, volRatio, mddRatio, periods, downPeriods, insufficientData }
 *                   重複期間が暦月換算24ヶ月分未満の場合は score=null, insufficientData=true
 */
export function calcDefensiveScore(stockPriceRows, n225PriceRows, params) {
    const returnPeriodWeeks = Number.isFinite(params.returnPeriodWeeks) && params.returnPeriodWeeks > 0 ? params.returnPeriodWeeks : 4;
    const downThreshold = Number.isFinite(params.downThreshold) ? params.downThreshold : 0;
    const volDownsideOnly = !!params.volDownsideOnly;
    const volOutlierClip = Number.isFinite(params.volOutlierClip) && params.volOutlierClip > 0 ? params.volOutlierClip : null;
    const mddFloorClip = Number.isFinite(params.mddFloorClip) && params.mddFloorClip < 0 ? params.mddFloorClip : null;
    const mddRollingWindowWeeks = Number.isFinite(params.mddRollingWindowWeeks) && params.mddRollingWindowWeeks > 0 ? params.mddRollingWindowWeeks : 52;
    const mddRolling = params.mddRollingEnabled
        ? { windowSize: Math.max(1, Math.round(mddRollingWindowWeeks * 7)), agg: params.mddRollingAgg === 'max' ? 'max' : 'mean' }
        : null;

    const n225Clean = cleanPriceRows(n225PriceRows);
    if (n225Clean.length === 0) {
        return { score: null, scoreDown: null, scoreVol: null, scoreMdd: null, corrDown: null, volRatio: null, mddRatio: null, periods: 0, downPeriods: 0, insufficientData: true };
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
        return { score: null, scoreDown: null, scoreVol: null, scoreMdd: null, corrDown: null, volRatio: null, mddRatio: null, periods: paired.length, downPeriods: 0, insufficientData: true };
    }

    // 下落局面相関（N225の期間リターンがdownThreshold未満の期間だけの相関） … 低いほど良い
    const down = paired.filter(p => p.n225 < downThreshold);
    const minDownPeriods = minPeriodsFor(MIN_DOWN_MONTHS_EQUIVALENT, returnPeriodWeeks);
    const corrDown = down.length >= minDownPeriods ? correlation(down.map(p => p.stock), down.map(p => p.n225)) : NaN;
    const scoreDown = scoreLowBetter(corrDown, params.downGood, params.downBad);

    // ボラ比（期間リターンの標準偏差の比） … 低いほど良い。下方偏差モードONならdown（下落局面）だけを対象にする
    // （下落局面が無ければ空配列になり、stdDevはNaNを返す＝算出不能として中立50点にフォールバックする）。
    // 外れ値クリップは銘柄・N225の両方の期間リターンに対称に適用する（比率として公平に比較するため）。
    const volSource = volDownsideOnly ? down : paired;
    const volStock = stdDev(volSource.map(p => clipAbs(p.stock, volOutlierClip)));
    const volN225  = stdDev(volSource.map(p => clipAbs(p.n225, volOutlierClip)));
    const volRatio = volN225 > 0 ? volStock / volN225 : NaN;
    const scoreVol = scoreLowBetter(volRatio, params.volGood, params.volBad);

    // MDD比（最大ドローダウンの比） … 低いほど良い。リターン算出期間とは無関係に日足終値を直接使う。
    // 下限クリップ・ローリング窓は銘柄・N225の両方に対称に適用する。
    const mddOptions = { floorClip: mddFloorClip, rolling: mddRolling };
    const mddStock = computeDrawdownMetric(stock.map(r => r.close), mddOptions);
    const mddN225  = computeDrawdownMetric(n225.map(r => r.close), mddOptions);
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
        periods: paired.length, downPeriods: down.length, insufficientData: false
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
