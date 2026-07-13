// (1) インポート
import { isProjectActive } from './task.js';
import { DAYPLAN_PROJECT } from './calendar.js';

// (2) インプット関数定義

/** マスタに登録済みの全プロジェクト名（重複除去、有効/無効を問わない）を返す。1日タスク用の予約プロジェクトは対象外。 */
export function getAllProjectNamesForAdmin(masterData) {
    return [...new Set(
        masterData.map(r => r['(M)プロジェクト_子']).filter(Boolean)
    )].filter(name => name !== DAYPLAN_PROJECT);
}

/** 指定プロジェクト名がメインデータ（タスク／ナレッジ等）で使用されている件数を返す。 */
export function countProjectUsage(mainData, name) {
    return mainData.filter(r => r['プロジェクト'] === name).length;
}

/**
 * マスタ行の (M)プロジェクト_親／(M)プロジェクト_子／(M)プロジェクト_ステータス のみを空欄化する。
 * マスタ行は複数の属性（変数登録・タグ・プロジェクト・ステータス等）を同じ行に持つ場合があるため、
 * プロジェクトに関する列以外は保持する。全列が空になった行だけ最後に取り除く。
 * @returns {Array} 更新後の masterData（新しい配列）
 */
export function clearProjectFieldsInMaster(masterData, projectName) {
    masterData.forEach(r => {
        if (r['(M)プロジェクト_子'] === projectName) {
            r['(M)プロジェクト_親']       = '';
            r['(M)プロジェクト_子']       = '';
            r['(M)プロジェクト_ステータス'] = '';
        }
    });
    return masterData.filter(r => Object.values(r).some(v => v !== '' && v != null));
}

/**
 * sourceName のプロジェクトを targetName に統合する。メインデータの参照を付け替え、source側のマスタ行のプロジェクト関連列だけを消す。
 * @returns {{mainData: Array, masterData: Array}}
 */
export function mergeProjectInto(mainData, masterData, sourceName, targetName) {
    mainData.forEach(r => { if (r['プロジェクト'] === sourceName) r['プロジェクト'] = targetName; });
    const newMasterData = clearProjectFieldsInMaster(masterData, sourceName);
    return { mainData, masterData: newMasterData };
}

/**
 * プロジェクト名を旧名から新名へ変更する。メインデータの参照とマスタの(M)プロジェクト_子を書き換える。
 * newName が既存の別プロジェクト名と一致する場合は実質的に統合（mergeProjectInto）と同じ結果になる。
 * @returns {{mainData: Array, masterData: Array}}
 */
export function renameProjectMaster(mainData, masterData, oldName, newName) {
    if (getAllProjectNamesForAdmin(masterData).includes(newName) && newName !== oldName) {
        return mergeProjectInto(mainData, masterData, oldName, newName);
    }
    mainData.forEach(r => { if (r['プロジェクト'] === oldName) r['プロジェクト'] = newName; });
    masterData.forEach(r => { if (r['(M)プロジェクト_子'] === oldName) r['(M)プロジェクト_子'] = newName; });
    return { mainData, masterData };
}

/**
 * プロジェクトを削除する。reassignTo を指定すればそのプロジェクトへ再割り当てしてから削除、未指定なら参照を空欄にして削除する。
 * @returns {{mainData: Array, masterData: Array}}
 */
export function deleteProject(mainData, masterData, name, reassignTo) {
    if (reassignTo) {
        return mergeProjectInto(mainData, masterData, name, reassignTo);
    }
    mainData.forEach(r => { if (r['プロジェクト'] === name) r['プロジェクト'] = ''; });
    const newMasterData = clearProjectFieldsInMaster(masterData, name);
    return { mainData, masterData: newMasterData };
}

/**
 * 指定プロジェクト名の (M)プロジェクト_ステータス を切り替える（同名の全マスタ行に反映）。
 * @returns {Array} 更新後の masterData
 */
export function toggleProjectStatus(masterData, name) {
    const nowActive = masterData.some(r => r['(M)プロジェクト_子'] === name && isProjectActive(r));
    masterData.forEach(r => {
        if (r['(M)プロジェクト_子'] === name) r['(M)プロジェクト_ステータス'] = nowActive ? '0' : '';
    });
    return masterData;
}

// (3)〜(4) メイン機能・アウトプット
// このモジュールの各関数は mainData／masterData を引数として受け取り、
// 更新結果を return する（DOM操作・saveCache 呼び出しは app.js 側で行う）。
