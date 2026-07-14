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
 * GitHub上のディレクトリの内容一覧を取得する。
 *
 * (2) インプット: token, owner, repo, path（ディレクトリのパス）
 * (3) メイン: GET /repos/{owner}/{repo}/contents/{path}
 * (4) アウトプット: Array<{ name, path, type, ... }>（ディレクトリが空/存在しない場合は空配列）
 */
export async function listDirectory(token, owner, repo, path) {
    const url = `${API_BASE}/repos/${owner}/${repo}/contents/${path}`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json'
        }
    });

    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`一覧取得に失敗しました (${response.status})`);

    return response.json();
}
