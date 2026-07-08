// (1) インポート
import { fetchFile, saveFile } from './modules/github.js';
import { parseChat, stringifyChat, filterByRoom, addMessage, formatTimestamp } from './modules/chat.js';

// ── 定数 ──────────────────────────────────────────────────────
const OWNER = 'palmelo2nd';
const REPO  = 'brain_data';
const PATH  = 'chat/todo.md';

const ROOMS = [
    { id: 'zassan',  name: '雑談' },
    { id: 'renraku', name: '連絡' }
];

const KEY_TOKEN = 'brain_pat_token';  // brainアプリと共有
const KEY_USER  = 'chat_username';
const KEY_CACHE = 'chat_cached_data';
const KEY_SHA   = 'chat_cached_sha';

// ── グローバル状態 ──────────────────────────────────────────────
let token        = null;
let currentUser  = null;
let currentData  = { mainData: [], masterData: [] };
let currentSha   = null;
let currentRoom  = ROOMS[0].id;
let refreshTimer = null;

// ── 初期化 ──────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
    token       = localStorage.getItem(KEY_TOKEN);
    currentUser = localStorage.getItem(KEY_USER);

    bindEvents();

    if (token && currentUser) {
        startApp();
    } else {
        if (token) document.getElementById('login-pat').value = token;
    }
});

function bindEvents() {
    document.getElementById('login-btn').addEventListener('click', handleLogin);
    document.getElementById('send-btn').addEventListener('click', handleSend);
    document.getElementById('refresh-btn').addEventListener('click', loadMessages);
    document.getElementById('logout-btn').addEventListener('click', handleLogout);
    document.getElementById('clear-cache-btn').addEventListener('click', handleClearCache);
    document.getElementById('message-input').addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });
}

// ── ログイン ──────────────────────────────────────────────────────
async function handleLogin() {
    const pat  = document.getElementById('login-pat').value.trim();
    const name = document.getElementById('login-name').value.trim();
    const err  = document.getElementById('login-error');
    err.classList.add('hidden');

    if (!pat || !name) {
        err.textContent = 'PATと名前を入力してください';
        err.classList.remove('hidden');
        return;
    }

    try {
        await fetchFile(pat, OWNER, REPO, PATH);
    } catch {
        err.textContent = 'PATが無効か、リポジトリにアクセスできません';
        err.classList.remove('hidden');
        return;
    }

    localStorage.setItem(KEY_TOKEN, pat);
    localStorage.setItem(KEY_USER, name);
    token       = pat;
    currentUser = name;

    document.getElementById('login-modal').classList.add('hidden');
    startApp();
}

function handleLogout() {
    localStorage.removeItem(KEY_USER);
    clearInterval(refreshTimer);
    location.reload();
}

function handleClearCache() {
    localStorage.removeItem(KEY_CACHE);
    localStorage.removeItem(KEY_SHA);
    currentData = { mainData: [], masterData: [] };
    currentSha  = null;
    loadMessages();
}

// ── アプリ起動 ──────────────────────────────────────────────────
function startApp() {
    document.getElementById('login-modal').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.getElementById('current-user').textContent = currentUser;
    renderRoomList();
    loadMessages();
    startAutoRefresh();
}

// ── ルーム ──────────────────────────────────────────────────────
function renderRoomList() {
    const nav = document.getElementById('room-list');
    nav.innerHTML = ROOMS.map(r => `
        <button class="room-tab${r.id === currentRoom ? ' active' : ''}" data-room="${r.id}">
            ${r.name}
        </button>
    `).join('');
    nav.querySelectorAll('.room-tab').forEach(btn => {
        btn.addEventListener('click', () => switchRoom(btn.dataset.room));
    });
}

function switchRoom(roomId) {
    currentRoom = roomId;
    renderRoomList();
    renderMessages();
}

// ── メッセージ取得 ──────────────────────────────────────────────
async function loadMessages() {
    try {
        const { content, sha } = await fetchFile(token, OWNER, REPO, PATH);
        currentData = parseChat(content);
        currentSha  = sha;
        localStorage.setItem(KEY_CACHE, content);
        localStorage.setItem(KEY_SHA, sha);
    } catch {
        const cached = localStorage.getItem(KEY_CACHE);
        if (cached) currentData = parseChat(cached);
        currentSha = localStorage.getItem(KEY_SHA);
    }
    renderMessages();
}

// ── メッセージ描画 ──────────────────────────────────────────────
function renderMessages() {
    const list     = document.getElementById('message-list');
    const messages = filterByRoom(currentData.mainData, currentRoom);

    if (messages.length === 0) {
        list.innerHTML = '<p class="no-messages">— まだメッセージはありません —</p>';
        return;
    }

    list.innerHTML = messages.map(m => {
        const isMine = m.sender === currentUser;
        return `
            <div class="message ${isMine ? 'message--mine' : 'message--theirs'}">
                <div class="message-header">
                    <span class="message-sender">${escHtml(m.sender)}</span>
                    <span class="message-divider"></span>
                </div>
                <div class="message-bubble">${escHtml(m.content)}</div>
                <div class="message-time">${formatTimestamp(m.timestamp)}</div>
            </div>
        `;
    }).join('');

    list.scrollTop = list.scrollHeight;
}

// ── メッセージ送信 ──────────────────────────────────────────────
async function handleSend() {
    const input   = document.getElementById('message-input');
    const content = input.value.trim();
    if (!content) return;

    const sendBtn = document.getElementById('send-btn');
    input.value      = '';
    input.disabled   = true;
    sendBtn.disabled = true;

    try {
        // 最新SHAを取得してからマージ（並行書き込み競合防止）
        let latestData = currentData;
        let latestSha  = currentSha;
        try {
            const { content: raw, sha } = await fetchFile(token, OWNER, REPO, PATH);
            latestData = parseChat(raw);
            latestSha  = sha;
        } catch { /* オフライン時はキャッシュのSHAで続行 */ }

        latestData.mainData = addMessage(latestData.mainData, currentRoom, currentUser, content);

        const markdown = stringifyChat(latestData);
        const { newSha } = await saveFile(token, OWNER, REPO, PATH, markdown, latestSha);
        currentData = latestData;
        currentSha  = newSha;
        localStorage.setItem(KEY_CACHE, markdown);
        localStorage.setItem(KEY_SHA, newSha);

        renderMessages();
    } catch (e) {
        alert(`送信失敗: ${e.message}`);
        input.value = content;
    } finally {
        input.disabled   = false;
        sendBtn.disabled = false;
        input.focus();
    }
}

// ── 自動更新 ──────────────────────────────────────────────────────
function startAutoRefresh() {
    refreshTimer = setInterval(loadMessages, 30000);
}

// ── ユーティリティ ──────────────────────────────────────────────
function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
