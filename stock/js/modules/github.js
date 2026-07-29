// (1) インポート — なし（Web標準 fetch API のみ使用）

const API_BASE = 'https://api.github.com';

/**
 * GitHub ActionsのワークフローをAPI経由で手動起動する（workflow_dispatch）。
 *
 * (2) インプット: token, owner, repo, workflowFile（ワークフローのファイル名）, ref（ブランチ名）, inputs（ワークフローへ渡す入力値）
 * (3) メイン: POST /repos/{owner}/{repo}/actions/workflows/{workflowFile}/dispatches
 * (4) アウトプット: なし（成功時はレスポンスボディなし。失敗時は例外を投げる）
 */
export async function dispatchWorkflow(token, owner, repo, workflowFile, ref, inputs) {
    const url = `${API_BASE}/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ref, inputs })
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`ワークフロー起動に失敗しました (${response.status}) ${detail}`);
    }
}

/**
 * GitHub上のファイルを取得し、デコード済みテキストを返す。
 *
 * (2) インプット: token, owner, repo, path
 * (3) メイン: GET /repos/{owner}/{repo}/contents/{path}
 * (4) アウトプット: ファイル内容の文字列
 */
export async function fetchFile(token, owner, repo, path) {
    const url = `${API_BASE}/repos/${owner}/${repo}/contents/${path}`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json'
        }
    });

    if (!response.ok) throw new Error(`取得失敗 (${response.status})`);

    const data = await response.json();
    return decodeURIComponent(escape(atob(data.content)));
}

/**
 * リポジトリ内の指定ディレクトリ配下（サブディレクトリ含む）の全ファイルを列挙する。
 * ディレクトリ一覧取得にはContents API（GET /contents/{path}）ではなくGit Trees APIを使う。
 * Contents APIは1ディレクトリ最大1,000件で打ち切られてしまい、stock/prices/のような数千件規模の
 * ディレクトリでは実際より大幅に少ない件数しか返らない（＝取得済みなのに未取得と誤判定される）ため。
 *
 * (2) インプット: token, owner, repo, ref（ブランチ名など）, dirPath（列挙したいディレクトリのパス、末尾スラッシュ無し）
 * (3) メイン: GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1 のtreeから、dirPath配下のblob（ファイル）だけを抽出
 * (4) アウトプット: Array<{ path, name }>（path=リポジトリルートからの相対パス、name=dirPathを除いたファイル名）。ディレクトリが空/存在しない場合は空配列
 */
export async function listFilesRecursive(token, owner, repo, ref, dirPath) {
    const url = `${API_BASE}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json'
        }
    });

    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`一覧取得に失敗しました (${response.status})`);

    const data = await response.json();
    if (data.truncated) {
        console.warn(`リポジトリ全体のファイル数が多すぎて、Git Trees APIの結果が打ち切られました（${dirPath} 配下の件数が正しく取得できていない可能性があります）。`);
    }

    const prefix = `${dirPath}/`;
    return (data.tree || [])
        .filter(entry => entry.type === 'blob' && entry.path.startsWith(prefix))
        .map(entry => ({ path: entry.path, name: entry.path.slice(prefix.length) }));
}
