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
 * Base64文字列（GitHubのcontentフィールド。76文字ごとに改行が入っている）をUTF-8文字列にデコードする。
 * atob単体だとLatin1として解釈されて日本語が文字化けするため、バイト列に変換してからTextDecoderで復元する。
 */
function decodeBase64Utf8(base64) {
    const binary = atob(base64.replace(/\n/g, ''));
    const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Contents API（GET /repos/{owner}/{repo}/contents/{path}）のレスポンスから、ファイルの中身を文字列で取り出す。
 *
 * Accept: application/vnd.github.raw+json を指定すると本来は生のファイル内容がそのまま返るはずだが、
 * 環境によっては（未確定の理由により）raw化されず、Contents APIの通常のJSON応答（content: Base64）が
 * 返ってくることがある。そのため、レスポンスのContent-Typeを見て両方の形式に対応する。
 *
 * なお、通常のJSON応答はファイルが1MBを超える場合にcontentフィールドが空になる（GitHubの仕様）。
 * このケースでは明示的にエラーとする。
 */
async function decodeContentsResponse(response) {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
        return await response.text();
    }

    const data = await response.json();
    if (typeof data.content !== 'string' || data.content === '') {
        throw new Error('ファイル内容の取得に失敗しました（1MBを超えるファイルの可能性があります）');
    }
    return decodeBase64Utf8(data.content);
}

/**
 * GitHub上のファイルを取得し、テキストを返す。
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
            'Accept': 'application/vnd.github.raw+json'
        }
    });

    if (!response.ok) throw new Error(`取得失敗 (${response.status})`);

    return await decodeContentsResponse(response);
}

/**
 * GitHub上のファイルを取得し、テキストを返す。ファイルが存在しない場合はnullを返す（例外を投げない）。
 * 存在するかどうか分からないファイル（例: 承認済み例外リストのように未作成の場合がある）を扱う用途。
 *
 * (2) インプット: token, owner, repo, path
 * (3) メイン: GET /repos/{owner}/{repo}/contents/{path}
 * (4) アウトプット: ファイル内容の文字列。存在しない場合はnull
 */
export async function fetchFileIfExists(token, owner, repo, path) {
    const url = `${API_BASE}/repos/${owner}/${repo}/contents/${path}`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.raw+json'
        }
    });

    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`取得失敗 (${response.status})`);

    return await decodeContentsResponse(response);
}

/**
 * GitHub上にファイルを作成、または既存ファイルを更新する（コミットを1つ作る）。
 *
 * (2) インプット: token, owner, repo, path, branch, content（書き込む文字列）, message（コミットメッセージ）
 * (3) メイン: 既存ファイルのsha取得（無ければ新規作成） → PUT /repos/{owner}/{repo}/contents/{path}
 * (4) アウトプット: なし（失敗時は例外を投げる）
 */
export async function commitFile(token, owner, repo, path, branch, content, message) {
    const url = `${API_BASE}/repos/${owner}/${repo}/contents/${path}`;

    const getResponse = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json'
        }
    });
    let sha;
    if (getResponse.status === 200) {
        sha = (await getResponse.json()).sha;
    } else if (getResponse.status !== 404) {
        throw new Error(`コミット前のファイル確認に失敗しました (${getResponse.status})`);
    }

    const body = { message, branch, content: btoa(unescape(encodeURIComponent(content))) };
    if (sha) body.sha = sha;

    const putResponse = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!putResponse.ok) {
        const detail = await putResponse.text().catch(() => '');
        throw new Error(`コミットに失敗しました (${putResponse.status}) ${detail}`);
    }
}

/**
 * 指定ワークフローの実行（run）一覧のうち、最新の1件を返す（実行が1件も無ければnull）。
 *
 * dispatchWorkflow（POST /dispatches）はrun idをレスポンスで返さない仕様のため、
 * 起動直後にこれで実行を特定し、以降の進捗ポーリングに使うrun idを得る。
 *
 * 起動前後でこの関数を呼び、返ってきたrun.idが変化した（＝一覧の先頭が入れ替わった）ことをもって
 * 「新しい実行が始まった」と判定する（呼び出し側の責務）。created_atなど時刻での絞り込みは行わない。
 * ブラウザ側の時計とGitHubサーバー側の時計がズレているとsince的な時刻フィルタは正しく機能しないため。
 *
 * (2) インプット: token, owner, repo, workflowFile
 * (3) メイン: GET /repos/{owner}/{repo}/actions/workflows/{workflowFile}/runs?event=workflow_dispatch&per_page=1
 * (4) アウトプット: 実行オブジェクト（id, status, conclusion等）。該当なしはnull
 */
export async function getLatestWorkflowRun(token, owner, repo, workflowFile) {
    const url = `${API_BASE}/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?event=workflow_dispatch&per_page=1`;

    const response = await fetch(url, {
        cache: 'no-store', // ポーリングで同一URLへ短時間に何度もアクセスするため、ブラウザキャッシュによる古い応答の再利用を防ぐ
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json'
        }
    });

    if (!response.ok) throw new Error(`実行一覧の取得に失敗しました (${response.status})`);

    const data = await response.json();
    const runs = data.workflow_runs || [];
    return runs.length > 0 ? runs[0] : null;
}

/**
 * ワークフロー実行（run）の現在の状態を返す。
 *
 * (2) インプット: token, owner, repo, runId
 * (3) メイン: GET /repos/{owner}/{repo}/actions/runs/{runId}
 * (4) アウトプット: 実行オブジェクト（status: queued/in_progress/completed、conclusion: success/failure等）
 */
export async function getWorkflowRun(token, owner, repo, runId) {
    const url = `${API_BASE}/repos/${owner}/${repo}/actions/runs/${runId}`;

    const response = await fetch(url, {
        cache: 'no-store', // ポーリングで同一URLへ短時間に何度もアクセスするため、ブラウザキャッシュによる古い応答の再利用を防ぐ
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json'
        }
    });

    if (!response.ok) throw new Error(`実行状況の取得に失敗しました (${response.status})`);

    return await response.json();
}

/**
 * 指定パス配下の最新1件のコミット（sha・メッセージ）を返す（無ければnull）。
 *
 * 一括取得ワークフローは20件処理するごとに「offset=X, count=Y」を含むメッセージでコミットするため、
 * この最新コミットのoffset+countから処理済み件数を推定できる（進捗バー用）。
 *
 * 時刻でのsince絞り込みは行わない（ブラウザ側とGitHubサーバー側の時計がズレていると機能しないため）。
 * 呼び出し側で、起動前に取得したsha（ベースライン）と比較し、変化していれば新しいコミットと判定する。
 *
 * (2) インプット: token, owner, repo, branch, path
 * (3) メイン: GET /repos/{owner}/{repo}/commits?sha={branch}&path={path}&per_page=1
 * (4) アウトプット: { sha, message }。該当なしはnull
 */
export async function getLatestCommit(token, owner, repo, branch, path) {
    const params = new URLSearchParams({ sha: branch, path, per_page: '1' });
    const url = `${API_BASE}/repos/${owner}/${repo}/commits?${params.toString()}`;

    const response = await fetch(url, {
        cache: 'no-store', // ポーリングで同一URLへ短時間に何度もアクセスするため、ブラウザキャッシュによる古い応答の再利用を防ぐ
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json'
        }
    });

    if (!response.ok) throw new Error(`コミット履歴の取得に失敗しました (${response.status})`);

    const data = await response.json();
    return data.length > 0 ? { sha: data[0].sha, message: data[0].commit.message } : null;
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
