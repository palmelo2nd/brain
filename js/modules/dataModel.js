// (1) インポート — なし（純粋な文字列/オブジェクト変換のみ）

export const MAIN_DATA_COLUMNS = [
    'ID', 'データ区分', 'タイトル', '内容', '備考', '作成日時', '更新日時',
    'カテゴリ', 'タグ', 'ハブ', 'ステータス', '優先度',
    '開始予定', '終了予定', '完了日', '見積時間', '実績時間', 'タイムスタンプログ', '補正時間',
    '繰返し識別子', '繰返し親ID', '繰返し頻度_月', '繰返し頻度_日', '繰返し頻度_曜日', 
    'Input', 'Output'
];

export const MASTER_DATA_COLUMNS = [
    '(M)変数名', '(M)変数分類', '(M)変数説明', '(M)データ区分', '(M)カテゴリ',
    '(M)タグ_親', '(M)タグ_子', '(M)ハブ_親', '(M)ハブ_子', '(M)ハブ_ステータス',
    '(M)ステータス_親', '(M)ステータス_子', '(M)優先度', '(M)繰返し頻度_月', 
    '(M)繰返し頻度_日', '(M)繰返し頻度_曜日', '(M)Input', '(M)Output'
];

/**
 * MarkdownのFront MatterからmainDataとmasterDataを抽出する。
 *
 * (2) インプット: mdText — Front Matterを含む可能性があるMarkdown文字列
 * (3) メイン: "---\n...\n---" の正規表現でFront Matter部分を取り出し JSON.parse
 * (4) アウトプット: { mainData: Array, masterData: Array }
 */
export function parseMarkdown(mdText) {
    const match = mdText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return { mainData: [], masterData: [] };

    try {
        const parsed = JSON.parse(match[1]);
        return {
            mainData:   Array.isArray(parsed.mainData)   ? parsed.mainData   : [],
            masterData: Array.isArray(parsed.masterData) ? parsed.masterData : []
        };
    } catch {
        return { mainData: [], masterData: [] };
    }
}

/**
 * mainData / masterData オブジェクトをFront Matter形式のMarkdown文字列に変換する。
 *
 * (2) インプット: mainData — メインデータ配列, masterData — マスタデータ配列
 * (3) メイン: JSON.stringify でシリアライズし、--- で囲むFront Matter構造を組み立てる
 * (4) アウトプット: Front Matter付きMarkdown文字列
 */
export function stringifyMarkdown(mainData, masterData) {
    const payload = JSON.stringify({ mainData, masterData }, null, 2);
    return `---\n${payload}\n---\n\n# タスク一覧\n`;
}
