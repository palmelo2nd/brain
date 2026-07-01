// (1) インポート — dataModel.js から列定義を参照、XLSX は window.XLSX (CDN) を使用
import { MAIN_DATA_COLUMNS, MASTER_DATA_COLUMNS } from './dataModel.js';

/**
 * mainData / masterData を2シート構成の Excelファイルとしてダウンロードさせる。
 *
 * (2) インプット: mainData — メインデータ配列, masterData — マスタデータ配列
 * (3) メイン: SheetJS でワークブックを生成し、各シートにデータを書き込む
 *             データが空でも列ヘッダー行は必ず出力する
 * (4) アウトプット: なし（writeFile がブラウザのダウンロードを直接発火）
 */
export function exportToExcel(mainData, masterData) {
    const wb = window.XLSX.utils.book_new();

    // 固定列に加え、実データにのみ存在する列（Excelで追加された列）も末尾に含める
    const mainHeader   = [...new Set([...MAIN_DATA_COLUMNS,   ...mainData.flatMap(r => Object.keys(r))])];
    const masterHeader = [...new Set([...MASTER_DATA_COLUMNS, ...masterData.flatMap(r => Object.keys(r))])];

    const wsMain = mainData.length > 0
        ? window.XLSX.utils.json_to_sheet(mainData,   { header: mainHeader })
        : window.XLSX.utils.aoa_to_sheet([mainHeader]);

    const wsMaster = masterData.length > 0
        ? window.XLSX.utils.json_to_sheet(masterData, { header: masterHeader })
        : window.XLSX.utils.aoa_to_sheet([masterHeader]);

    window.XLSX.utils.book_append_sheet(wb, wsMain,   'メインデータ');
    window.XLSX.utils.book_append_sheet(wb, wsMaster, 'マスタデータ');

    window.XLSX.writeFile(wb, 'brain_tasks.xlsx');
}

/**
 * 選択された .xlsx ファイルを読み込み、{ mainData, masterData } に変換して返す。
 *
 * (2) インプット: file — File オブジェクト（input[type=file] の files[0]）
 * (3) メイン: FileReader で ArrayBuffer に読み込み、SheetJS でパース
 *             シート名 "メインデータ" / "マスタデータ" からそれぞれ JSON 配列を生成
 * (4) アウトプット: Promise<{ mainData: Array, masterData: Array }>
 */
export function importFromExcel(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = (e) => {
            const data     = new Uint8Array(e.target.result);
            const wb       = window.XLSX.read(data, { type: 'array' });

            const mainSheet   = wb.Sheets['メインデータ'];
            const masterSheet = wb.Sheets['マスタデータ'];

            const mainData   = mainSheet   ? window.XLSX.utils.sheet_to_json(mainSheet)   : [];
            const masterData = masterSheet ? window.XLSX.utils.sheet_to_json(masterSheet) : [];

            resolve({ mainData, masterData });
        };

        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
}
