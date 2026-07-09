// (1) インポート
import { isHubActive } from './task.js';
import { DAYPLAN_HUB } from './calendar.js';

// (2) インプット関数定義

/** マスタに登録済みの全ハブ名（重複除去、有効/無効を問わない）を返す。1日タスク用の予約ハブは対象外。 */
export function getAllHubNamesForAdmin(masterData) {
    return [...new Set(
        masterData.map(r => r['(M)ハブ_子']).filter(Boolean)
    )].filter(name => name !== DAYPLAN_HUB);
}

/** 指定ハブ名がメインデータ（タスク／ナレッジ等）で使用されている件数を返す。 */
export function countHubUsage(mainData, name) {
    return mainData.filter(r => r['ハブ'] === name).length;
}

/**
 * マスタ行の (M)ハブ_親／(M)ハブ_子／(M)ハブ_ステータス のみを空欄化する。
 * マスタ行は複数の属性（変数登録・タグ・ハブ・ステータス等）を同じ行に持つ場合があるため、
 * ハブに関する列以外は保持する。全列が空になった行だけ最後に取り除く。
 * @returns {Array} 更新後の masterData（新しい配列）
 */
export function clearHubFieldsInMaster(masterData, hubName) {
    masterData.forEach(r => {
        if (r['(M)ハブ_子'] === hubName) {
            r['(M)ハブ_親']       = '';
            r['(M)ハブ_子']       = '';
            r['(M)ハブ_ステータス'] = '';
        }
    });
    return masterData.filter(r => Object.values(r).some(v => v !== '' && v != null));
}

/**
 * sourceName のハブを targetName に統合する。メインデータの参照を付け替え、source側のマスタ行のハブ関連列だけを消す。
 * @returns {{mainData: Array, masterData: Array}}
 */
export function mergeHubInto(mainData, masterData, sourceName, targetName) {
    mainData.forEach(r => { if (r['ハブ'] === sourceName) r['ハブ'] = targetName; });
    const newMasterData = clearHubFieldsInMaster(masterData, sourceName);
    return { mainData, masterData: newMasterData };
}

/**
 * ハブ名を旧名から新名へ変更する。メインデータの参照とマスタの(M)ハブ_子を書き換える。
 * newName が既存の別ハブ名と一致する場合は実質的に統合（mergeHubInto）と同じ結果になる。
 * @returns {{mainData: Array, masterData: Array}}
 */
export function renameHubMaster(mainData, masterData, oldName, newName) {
    if (getAllHubNamesForAdmin(masterData).includes(newName) && newName !== oldName) {
        return mergeHubInto(mainData, masterData, oldName, newName);
    }
    mainData.forEach(r => { if (r['ハブ'] === oldName) r['ハブ'] = newName; });
    masterData.forEach(r => { if (r['(M)ハブ_子'] === oldName) r['(M)ハブ_子'] = newName; });
    return { mainData, masterData };
}

/**
 * ハブを削除する。reassignTo を指定すればそのハブへ再割り当てしてから削除、未指定なら参照を空欄にして削除する。
 * @returns {{mainData: Array, masterData: Array}}
 */
export function deleteHub(mainData, masterData, name, reassignTo) {
    if (reassignTo) {
        return mergeHubInto(mainData, masterData, name, reassignTo);
    }
    mainData.forEach(r => { if (r['ハブ'] === name) r['ハブ'] = ''; });
    const newMasterData = clearHubFieldsInMaster(masterData, name);
    return { mainData, masterData: newMasterData };
}

/**
 * 指定ハブ名の (M)ハブ_ステータス を切り替える（同名の全マスタ行に反映）。
 * @returns {Array} 更新後の masterData
 */
export function toggleHubStatus(masterData, name) {
    const nowActive = masterData.some(r => r['(M)ハブ_子'] === name && isHubActive(r));
    masterData.forEach(r => {
        if (r['(M)ハブ_子'] === name) r['(M)ハブ_ステータス'] = nowActive ? '0' : '';
    });
    return masterData;
}

// (3)〜(4) メイン機能・アウトプット
// このモジュールの各関数は mainData／masterData を引数として受け取り、
// 更新結果を return する（DOM操作・saveCache 呼び出しは app.js 側で行う）。
