// (1) インポート
import { parseJpDatetime } from './task.js';

/**
 * mainData の3-wayマージを行う（ID列を一意キーとして使用）。
 *
 * (2) インプット: baseRows（自分が最後に同期していた基準データ）, localRows（自分の現在データ）,
 *                 remoteRows（他端末が保存した最新データ）
 * (3) メイン: IDごとに base と比較し、片方だけが変更した行はその内容を採用する。
 *            両方が変更している真の競合行は自動では解決せず、conflictsに積んで呼び出し側に委ねる
 *            （呼び出し側でユーザーに内容を見せて選ばせ、その結果をmergedへ追加する想定）。
 * (4) アウトプット: { merged: Array（競合以外がマージ済みのmainData）, conflicts: Array（真の競合行。
 *                    { id, base, local, remote } の形。local/remoteがnullなら片方が削除している） }
 */
export function mergeMainData(baseRows, localRows, remoteRows) {
    const baseMap   = new Map(baseRows.map(r => [r['ID'], r]));
    const localMap  = new Map(localRows.map(r => [r['ID'], r]));
    const remoteMap = new Map(remoteRows.map(r => [r['ID'], r]));

    const orderedIds = [...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()];
    const seenIds    = new Set();
    const merged     = [];
    const conflicts  = [];

    orderedIds.forEach(id => {
        if (seenIds.has(id)) return;
        seenIds.add(id);

        const base   = baseMap.get(id)   || null;
        const local  = localMap.get(id)  || null;
        const remote = remoteMap.get(id) || null;

        const localChanged  = !rowsEqual(base, local);
        const remoteChanged = !rowsEqual(base, remote);

        if (!localChanged && !remoteChanged) {
            if (local) merged.push(local);
            return;
        }
        if (localChanged && !remoteChanged) {
            if (local) merged.push(local); // ローカルの編集／新規追加を採用（削除の場合はここで何も積まない）
            return;
        }
        if (!localChanged && remoteChanged) {
            if (remote) merged.push(remote);
            return;
        }

        // 両方が変更 → 真の競合。両方が同じ内容に落ち着いていれば自動採用、それ以外は呼び出し側で解決させる
        if (local && remote && rowsEqual(local, remote)) {
            merged.push(local);
            return;
        }
        if (!local && !remote) return; // 両方で削除 → 何も積まない
        conflicts.push({ id, base, local, remote });
    });

    return { merged, conflicts };
}

function rowsEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return JSON.stringify(a) === JSON.stringify(b);
}

/** 更新日時が新しい方を返す（ユーザー操作を介さないフォールバック解決専用。通常は呼び出し側でユーザーに選ばせる）。 */
export function pickNewer(local, remote) {
    const localTime  = parseJpDatetime(local['更新日時']);
    const remoteTime = parseJpDatetime(remote['更新日時']);
    if (!localTime)  return remote;
    if (!remoteTime) return local;
    return remoteTime.getTime() > localTime.getTime() ? remote : local;
}

/**
 * 親ID競合で「両方残す」を選んだ際、複製元(oldId)はローカル側の内容のまま残り、複製先(newId)に
 * リモート側の内容が複製される。このとき「リモート側でoldIdを親にしていたが、ローカル側では
 * oldId以外（未存在も含む）を親にしていた子」は、リモートの文脈に属する子とみなし、
 * 親IDをnewIdへ付け替える（ローカル側でoldIdを親にしていた子はoldIdのまま変更しない）。
 *
 * (2) インプット: mergedRows — マージ後の全行, reassignments — [{ oldId, newId }],
 *                 remoteRows/localRows — マージ前のリモート／ローカル元データ
 * (3) メイン: リモート側でoldIdを親にしていた子のうち、ローカル側の親IDが一致しないものを抽出し、
 *            マージ後の該当行の親IDをnewIdへ書き換える
 * (4) アウトプット: 付け替え後の行配列（新しい配列。対象行のみ複製、他は元の参照を維持）
 */
export function reassignDuplicatedParentChildren(mergedRows, reassignments, remoteRows, localRows) {
    if (reassignments.length === 0) return mergedRows;

    const oldToNew = new Map(reassignments.map(r => [r.oldId, r.newId]));
    const localParentById = new Map(localRows.map(r => [r['ID'], r['親ID']]));

    const remoteChildIdsToReassign = new Set(
        remoteRows
            .filter(r => oldToNew.has(r['親ID']) && localParentById.get(r['ID']) !== r['親ID'])
            .map(r => r['ID'])
    );
    if (remoteChildIdsToReassign.size === 0) return mergedRows;

    return mergedRows.map(row => {
        if (!remoteChildIdsToReassign.has(row['ID'])) return row;
        if (!oldToNew.has(row['親ID'])) return row; // マージ後に別の親IDへ既に変わっている等の想定外はそのまま
        return { ...row, '親ID': oldToNew.get(row['親ID']) };
    });
}
