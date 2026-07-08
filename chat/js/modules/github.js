// (1) インポート — なし（Web標準 fetch API のみ使用）

const API_BASE = 'https://api.github.com';

/**
 * (2) インプット: token, owner, repo, path
 * (3) メイン: GET /repos/{owner}/{repo}/contents/{path}
 * (4) アウトプット: { content: string, sha: string }
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
    const data    = await response.json();
    const content = decodeURIComponent(escape(atob(data.content)));
    return { content, sha: data.sha };
}

/**
 * (2) インプット: token, owner, repo, path, markdownContent, sha
 * (3) メイン: PUT /repos/{owner}/{repo}/contents/{path}
 * (4) アウトプット: { newSha: string }
 */
export async function saveFile(token, owner, repo, path, markdownContent, sha) {
    const url            = `${API_BASE}/repos/${owner}/${repo}/contents/${path}`;
    const encodedContent = btoa(unescape(encodeURIComponent(markdownContent)));
    const response = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            message: 'docs: チャットメッセージを更新',
            content: encodedContent,
            sha
        })
    });
    if (!response.ok) throw new Error(`保存失敗 (${response.status})`);
    const result = await response.json();
    return { newSha: result.content.sha };
}
