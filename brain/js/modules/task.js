// (1) インポート
// （このモジュールは外部ライブラリに依存しない）

// (2) インプット関数定義

/** yyyy/mm/dd hh:mm:ss 形式の日時文字列を Date に変換する */
export function parseJpDatetime(str) {
    if (!str || !str.trim()) return null;
    const m = str.trim().match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/** Date を yyyy/mm/dd hh:mm:ss 形式にフォーマットする */
export function formatJpDatetime(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** タイムスタンプログ文字列を解析して累計ミリ秒を返す（末尾が計測中の場合は現在時刻まで加算） */
export function parseTimestampLog(log) {
    if (!log || !log.trim()) return 0;
    const segments = log.split(',').map(s => s.trim()).filter(Boolean);
    let total = 0;
    const now = Date.now();
    segments.forEach(seg => {
        const dashIdx = seg.indexOf('-', 10);
        if (dashIdx === -1) return;
        const start = parseJpDatetime(seg.slice(0, dashIdx));
        if (!start) return;
        const endStr = seg.slice(dashIdx + 1).trim();
        const end = endStr ? parseJpDatetime(endStr) : null;
        total += (end ? end.getTime() : now) - start.getTime();
    });
    return total;
}

/** ミリ秒を hh:mm:ss にフォーマットする */
export function formatDuration(ms) {
    if (ms < 0) ms = 0;
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** タイムスタンプログの末尾から計測中かどうかを判定する（末尾が「-」なら計測中、「,」または空欄なら停止中） */
export function isLogRunning(log) {
    return (log || '').trim().endsWith('-');
}

/** 指定タスクIDの補正込み累計時間（ms）を、メインデータから算出して返す */
export function computeTotalDuration(mainData, taskId) {
    const row = mainData.find(r => String(r['ID']) === String(taskId));
    if (!row) return 0;
    const base = parseTimestampLog(row['タイムスタンプログ'] || '');
    const adj = parseFloat(row['補正時間'] || '0') * 60000;
    return base + adj;
}

/**
 * 行の実績時間（h）を返す。「実績時間」列に手入力値があればそれを優先し、無ければ
 * タイムスタンプログ＋補正時間（タスク実行タブで入力する分単位の調整値）から算出する
 * （小数第1位まで、例: 2.5）。
 */
export function computeActualHours(row) {
    const manual = parseFloat(row['実績時間'] || '');
    if (!isNaN(manual) && manual > 0) return manual;
    const ms = parseTimestampLog(row['タイムスタンプログ'] || '') + parseFloat(row['補正時間'] || '0') * 60000;
    return ms > 0 ? Math.round(ms / 360000) / 10 : 0;
}

/** (M)プロジェクト_ステータスが '0'（無効）でない行かどうかを判定する。未入力は有効扱いにする。 */
export function isProjectActive(row) {
    return row['(M)プロジェクト_ステータス'] !== '0' && row['(M)プロジェクト_ステータス'] !== 0;
}

/** 選択中カテゴリでフィルタされたメインデータを返す。「すべて」選択時は全件返す（複製配列）。 */
export function filterMainDataByCategory(mainData, category) {
    if (category === 'すべて') return [...mainData];
    return mainData.filter(r => r['カテゴリ'] === category);
}

/**
 * 選択中カテゴリに属するタグ名一覧を返す。
 * 「すべて」選択時は (M)タグ_子 の全値、それ以外は (M)タグ_親 === category の行の (M)タグ_子 を返す。
 */
export function filterTagsByCategory(masterData, category) {
    if (category === 'すべて') {
        return [...new Set(masterData.map(r => r['(M)タグ_子']).filter(Boolean))];
    }
    return masterData
        .filter(r => r['(M)タグ_親'] === category)
        .map(r => r['(M)タグ_子'])
        .filter(Boolean);
}

/**
 * 選択中カテゴリに属する、有効な（(M)プロジェクト_ステータスが0でない）プロジェクト名一覧を返す。
 * 「すべて」選択時は (M)プロジェクト_子 の全値、それ以外は (M)プロジェクト_親 === category の行の (M)プロジェクト_子 を返す。
 */
export function filterProjectsByCategory(masterData, category) {
    if (category === 'すべて') {
        return [...new Set(
            masterData.filter(isProjectActive).map(r => r['(M)プロジェクト_子']).filter(Boolean)
        )];
    }
    return masterData
        .filter(r => r['(M)プロジェクト_親'] === category && isProjectActive(r))
        .map(r => r['(M)プロジェクト_子'])
        .filter(Boolean);
}

/** 指定IDを親IDに持つ行（子）一覧を返す。 */
export function getChildren(mainData, parentId) {
    if (!parentId) return [];
    return mainData.filter(r => String(r['親ID'] || '') === String(parentId));
}

/** 指定IDが、他のいずれかの行から親IDとして参照されているか（＝実質プロジェクトかどうか）を判定する。 */
export function isParentRow(mainData, id) {
    if (!id) return false;
    return mainData.some(r => String(r['親ID'] || '') === String(id));
}

/** 行の親ID（row['親ID']）から親行本体を引く。親IDが空欄、または参照先が存在しない場合は null。 */
export function getParentRow(mainData, row) {
    const parentId = row && row['親ID'];
    if (!parentId) return null;
    return mainData.find(r => String(r['ID']) === String(parentId)) || null;
}

/**
 * newParentId を childId の親として設定した場合に循環参照が発生するかを判定する。
 * newParentId から親を辿っていき、途中で childId に戻り着けば循環とみなす。
 * 自分自身を親にしようとする場合（newParentId === childId）も循環として扱う。
 */
export function wouldCreateCycle(mainData, childId, newParentId) {
    if (!newParentId) return false;
    if (String(newParentId) === String(childId)) return true;

    const idMap = new Map(mainData.map(r => [String(r['ID']), r]));
    let current = idMap.get(String(newParentId));
    const visited = new Set();
    while (current && current['親ID']) {
        const pid = String(current['親ID']);
        if (pid === String(childId)) return true;
        if (visited.has(pid)) return false; // 既存データ側に別の循環がある場合の無限ループ防止
        visited.add(pid);
        current = idMap.get(pid);
    }
    return false;
}

/**
 * 親ID選択UI（datalist）用の候補一覧を返す。excludeId を指定すると、その行自身と
 * その子孫（excludeId を親として辿れる全行）を候補から除外する（自分自身や自分の子孫を親にできないようにする）。
 */
export function getAllParentCandidates(mainData, excludeId) {
    let excludedIds = new Set();
    if (excludeId) {
        excludedIds.add(String(excludeId));
        let frontier = [String(excludeId)];
        while (frontier.length > 0) {
            const next = mainData
                .filter(r => frontier.includes(String(r['親ID'] || '')))
                .map(r => String(r['ID']))
                .filter(id => !excludedIds.has(id));
            next.forEach(id => excludedIds.add(id));
            frontier = next;
        }
    }
    return mainData
        .filter(r => !excludedIds.has(String(r['ID'])))
        .map(r => ({ id: r['ID'], title: r['タイトル'] || '', kubun: r['データ区分'] || '' }));
}

// (3)〜(4) メイン機能・アウトプット
// このモジュールの各関数は純粋計算のみを行い、引数として受け取った値から
// 計算結果を return する（DOM操作・グローバル状態への直接アクセスは行わない）。
