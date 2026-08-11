// (1) インポート — なし（Web標準APIのみ使用）

/**
 * 保有銘柄一覧（holdings.csvのパース結果）を「所有者 → 口座区分 → 証券会社」の階層で集計し、
 * 各階層の小計（総投資金額＝株数×取得単価の合計）を返す。総投資金額は取得原価ベースであり、
 * 現在の評価額（時価）ではない点に注意。
 *
 * (2) インプット: rows — Array<{ owner, account, broker, shares, avg_cost, ... }>（holdings.csvの行データ。他の列は無視する）
 * (3) メイン: owner→account→brokerの順にMapへ積み上げてshares×avg_costを合算し、各階層の小計を持つ入れ子構造に変換する
 * (4) アウトプット: Array<{ owner, total, accounts: Array<{ account, total, brokers: Array<{ broker, total }> }> }>
 *                    （各階層とも総投資金額の降順でソート済み）
 */
export function summarizeHoldingsHierarchy(rows) {
    const ownerMap = new Map(); // owner -> Map(account -> Map(broker -> total))

    (rows || []).forEach(row => {
        const owner   = row.owner   || '（所有者未設定）';
        const account = row.account || '（口座区分未設定）';
        const broker  = row.broker  || '（証券会社未設定）';
        const amount  = (parseFloat(row.shares) || 0) * (parseFloat(row.avg_cost) || 0);

        if (!ownerMap.has(owner)) ownerMap.set(owner, new Map());
        const accountMap = ownerMap.get(owner);
        if (!accountMap.has(account)) accountMap.set(account, new Map());
        const brokerMap = accountMap.get(account);
        brokerMap.set(broker, (brokerMap.get(broker) || 0) + amount);
    });

    return [...ownerMap.entries()]
        .map(([owner, accountMap]) => {
            const accounts = [...accountMap.entries()]
                .map(([account, brokerMap]) => {
                    const brokers = [...brokerMap.entries()]
                        .map(([broker, total]) => ({ broker, total }))
                        .sort((a, b) => b.total - a.total);
                    const accountTotal = brokers.reduce((sum, b) => sum + b.total, 0);
                    return { account, total: accountTotal, brokers };
                })
                .sort((a, b) => b.total - a.total);
            const ownerTotal = accounts.reduce((sum, a) => sum + a.total, 0);
            return { owner, total: ownerTotal, accounts };
        })
        .sort((a, b) => b.total - a.total);
}
