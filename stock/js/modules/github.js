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
