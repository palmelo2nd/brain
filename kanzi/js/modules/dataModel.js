// (1) インポート — なし（純粋な文字列/オブジェクト変換のみ）

// kanjiData（data/kanjiMaster.json、コードリポジトリに同梱される固定の参照データ）の列定義。
// 漢字の読み・意味・熟語はユーザーごとに変わらないため、GitHubデータリポジトリ（進捗のみ）には含めない。
export const KANJI_COLUMNS = ['ID', '漢字', '学年', '画数', '音読み', '訓読み', '意味', '熟語'];

// progressData: 漢字ごとの学習記録（IDをキーに1漢字1行。未学習の漢字は行が存在しない）
export const PROGRESS_COLUMNS = ['ID', '出題回数', '正解回数', '連続正解', '最終学習日時'];

/**
 * MarkdownのFront MatterからprogressData（学習進捗）を抽出する。
 *
 * (2) インプット: mdText — Front Matterを含む可能性があるMarkdown文字列
 * (3) メイン: "---\n...\n---" の正規表現でFront Matter部分を取り出し JSON.parse
 * (4) アウトプット: { progressData: Array }
 */
export function parseMarkdown(mdText) {
    const match = mdText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return { progressData: [] };

    try {
        const parsed = JSON.parse(match[1]);
        return {
            progressData: Array.isArray(parsed.progressData) ? parsed.progressData : []
        };
    } catch {
        return { progressData: [] };
    }
}

/**
 * progressData を Front Matter形式のMarkdown文字列に変換する。
 *
 * (2) インプット: progressData — 学習記録配列
 * (3) メイン: JSON.stringify でシリアライズし、--- で囲むFront Matter構造を組み立てる
 * (4) アウトプット: Front Matter付きMarkdown文字列
 */
export function stringifyMarkdown(progressData) {
    const payload = JSON.stringify({ progressData }, null, 2);
    return `---\n${payload}\n---\n\n# 漢字学習 進捗データ\n`;
}
