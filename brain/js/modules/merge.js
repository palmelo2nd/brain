// (1) インポート
import { parseJpDatetime } from './task.js';

/**
 * mainData の3-wayマージを行う（ID列を一意キーとして使用）。
 *
 * (2) インプット: baseRows（自分が最後に同期していた基準データ）, localRows（自分の現在データ）,
 *                 remoteRows（他端末が保存した最新データ）
 * (3) メイン: IDごとに base と比較し、片方だけが変更した行はその内容を採用。
 *            両方が変更している真の競合行は「更新日時」が新しい方を採用する。
 * (4) アウトプット: { merged: Array（マージ後のmainData）, conflicts: Array（自動解決した競合行の情報） }
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

        // 両方が変更 → 真の競合。可能なら更新日時が新しい方を採用する
        if (local && remote) {
            if (rowsEqual(local, remote)) { merged.push(local); return; }
            const winner = pickNewer(local, remote);
            merged.push(winner);
            conflicts.push({ id, local, remote, winner });
        } else if (local && !remote) {
            // 片方が削除・片方が編集 → データを失わないよう編集を残す
            merged.push(local);
            conflicts.push({ id, local, remote: null, winner: local });
        } else if (!local && remote) {
            merged.push(remote);
            conflicts.push({ id, local: null, remote, winner: remote });
        }
        // local, remote 両方null（＝両方で削除）は何も積まない
    });

    return { merged, conflicts };
}

function rowsEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return JSON.stringify(a) === JSON.stringify(b);
}

function pickNewer(local, remote) {
    const localTime  = parseJpDatetime(local['更新日時']);
    const remoteTime = parseJpDatetime(remote['更新日時']);
    if (!localTime)  return remote;
    if (!remoteTime) return local;
    return remoteTime.getTime() > localTime.getTime() ? remote : local;
}
