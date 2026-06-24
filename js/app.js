import { loadToken, saveToken, loadCache, saveCache } from './modules/storage.js';
import { fetchFile, saveFile } from './modules/github.js';

const OWNER = 'palmelo2nd';
const REPO  = 'brain_data';
const PATH  = 'todo.md';

// GitHubファイルの現在バージョンを識別するSHA（保存時の競合防止に必要）
let currentSha = null;

// --- 初期化: 保存済みトークンをフォームへ復元 ---
window.addEventListener('DOMContentLoaded', () => {
    const saved = loadToken();
    if (saved) document.getElementById('token-input').value = saved;
});

// --- 読み込み ---
document.getElementById('load-btn').addEventListener('click', async () => {
    const token      = document.getElementById('token-input').value.trim();
    const contentBox = document.getElementById('content-box');
    const statusEl   = document.getElementById('network-status');

    if (!token) return alert('トークンを入力してください');
    saveToken(token);
    contentBox.textContent = '読み込み中...';

    try {
        const { content, sha } = await fetchFile(token, OWNER, REPO, PATH);
        currentSha = sha;
        saveCache(content, sha);
        statusEl.innerHTML   = '<span class="status-badge online-badge">オンライン（最新）</span>';
        contentBox.innerHTML = window.marked.parse(content);
    } catch (error) {
        console.error(error);
        const cached = loadCache();
        if (cached) {
            currentSha           = cached.sha;
            statusEl.innerHTML   = '<span class="status-badge offline-badge">オフライン（端末内データ）</span>';
            contentBox.innerHTML = window.marked.parse(cached.content);
            alert('通信できませんでした。スマホ内に一時保存されている前回のデータを表示します。');
        } else {
            contentBox.textContent = `エラー: ${error.message}（端末内にキャッシュもありません）`;
        }
    }
});

// --- 保存 ---
document.getElementById('save-btn').addEventListener('click', async () => {
    const token      = document.getElementById('token-input').value.trim();
    const contentBox = document.getElementById('content-box');
    const statusEl   = document.getElementById('network-status');

    if (!token)      return alert('トークンを入力してください');
    if (!currentSha) return alert('先にデータを読み込んでください（またはオフラインキャッシュを読み込んでください）');

    // DOM操作前にチェックボックス状態を読み取ってMarkdownを組み立てる
    const newMarkdown = buildMarkdownFromDOM(contentBox);
    saveCache(newMarkdown, currentSha);
    contentBox.textContent = 'GitHubへ保存中...';

    try {
        const { newSha } = await saveFile(token, OWNER, REPO, PATH, newMarkdown, currentSha);
        currentSha = newSha;
        saveCache(newMarkdown, newSha);
        statusEl.innerHTML   = '<span class="status-badge online-badge">オンライン（同期完了）</span>';
        contentBox.innerHTML = window.marked.parse(newMarkdown);
        alert('GitHubへの保存が成功しました！');
    } catch (error) {
        console.error(error);
        statusEl.innerHTML   = '<span class="status-badge offline-badge">未同期の変更あり</span>';
        contentBox.innerHTML = window.marked.parse(newMarkdown);
        alert('現在通信ができません。変更はスマホ内に一時保存されました。電波の良い場所に移動してから、再度「GitHubへ保存する」を押して同期してください。');
    }
});

// 画面上のチェックボックス状態からMarkdown文字列を再構築する（DOM読み取り専用）
function buildMarkdownFromDOM(contentBox) {
    let markdown = '# タスク一覧\n\n';
    contentBox.querySelectorAll('li').forEach(li => {
        const checkbox = li.querySelector('input[type="checkbox"]');
        const text     = li.textContent.trim();
        markdown += checkbox && checkbox.checked ? `- [x] ${text}\n` : `- [ ] ${text}\n`;
    });
    return markdown;
}
