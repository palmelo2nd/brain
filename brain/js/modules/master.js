// (1) インポート
// （このモジュールは外部ライブラリに依存しない）

// (2) インプット関数定義

/**
 * dataModel.js の固定列（mainColumns/masterColumns）と、
 * 実データ（mainData/masterData）の各行に実際に存在するキーとの和集合を返す。
 * Excelで新しい列を追加した場合でも、この関数経由でチェックすれば
 * dataModel.jsを手動修正しなくても新しい変数名を認識できる。
 */
export function getAllKnownColumns(mainData, masterData, mainColumns, masterColumns) {
    const columns = new Set([...mainColumns, ...masterColumns]);
    mainData.forEach(row => Object.keys(row).forEach(k => columns.add(k)));
    masterData.forEach(row => Object.keys(row).forEach(k => columns.add(k)));
    return [...columns];
}

/**
 * mainColumns/masterColumns と masterData を照合して警告リストを返す。
 * - 固定列にあるが masterData 未登録の変数
 * - masterData にあるが固定列に存在しない変数名
 * - (M)変数名/(M)変数分類/(M)変数説明のいずれかが空の行
 * - タグ／プロジェクトの親がカテゴリに未登録
 * - ステータスの親が「タスク」「ナレッジ」以外
 */
export function computeMasterWarnings(mainData, masterData, mainColumns, masterColumns) {
    const warnings = [];
    // メイン・マスタ両方の列名を対象にする（固定列 ＋ 実データに存在する列名の和集合。
    // これにより、Excelで列を追加しただけでも固定列定義を修正せずに認識される）
    const ALL_COLUMNS = getAllKnownColumns(mainData, masterData, mainColumns, masterColumns);
    const registered  = masterData.map(r => r['(M)変数名']).filter(Boolean);

    const unregistered = ALL_COLUMNS.filter(col => !registered.includes(col));
    if (unregistered.length > 0) {
        warnings.push(`マスタ未登録の変数が ${unregistered.length} 件あります（例: ${unregistered[0]}）`);
    }

    const invalid = registered.filter(name => !ALL_COLUMNS.includes(name));
    if (invalid.length > 0) {
        warnings.push(`存在しない変数名が ${invalid.length} 件あります（例: ${invalid[0]}）`);
    }

    const incomplete = masterData.filter(r =>
        !r['(M)変数名'] || !r['(M)変数分類'] || !r['(M)変数説明']
    );
    if (incomplete.length > 0) {
        warnings.push(`未入力の項目がある行が ${incomplete.length} 件あります`);
    }

    // タグ・プロジェクトの親がカテゴリに登録されているか確認
    const registeredCategories = [...new Set(masterData.map(r => r['(M)カテゴリ']).filter(Boolean))];

    const invalidTagParents = [...new Set(masterData.map(r => r['(M)タグ_親']).filter(Boolean))]
        .filter(p => !registeredCategories.includes(p));
    if (invalidTagParents.length > 0) {
        warnings.push(`タグの親「${invalidTagParents[0]}」はカテゴリに未登録です`);
    }

    const invalidProjectParents = [...new Set(masterData.map(r => r['(M)プロジェクト_親']).filter(Boolean))]
        .filter(p => !registeredCategories.includes(p));
    if (invalidProjectParents.length > 0) {
        warnings.push(`プロジェクトの親「${invalidProjectParents[0]}」はカテゴリに未登録です`);
    }

    // ステータスの親が「タスク」か「ナレッジ」か確認
    const invalidStatusParents = [...new Set(masterData.map(r => r['(M)ステータス_親']).filter(Boolean))]
        .filter(p => !['タスク', 'ナレッジ'].includes(p));
    if (invalidStatusParents.length > 0) {
        warnings.push(`ステータスの親「${invalidStatusParents[0]}」は「タスク」か「ナレッジ」である必要があります`);
    }

    return warnings;
}

/** masterColumns の全キーを空文字で初期化したマスタデータの空行を生成する。 */
export function createEmptyMasterRow(masterColumns) {
    return Object.fromEntries(masterColumns.map(c => [c, '']));
}

// (3)〜(4) メイン機能・アウトプット
// このモジュールの各関数は純粋計算のみを行い、引数として受け取った値から
// 計算結果を return する（DOM操作・グローバル状態への直接アクセスは行わない）。
