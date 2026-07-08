// (1) インポート
import { fetchFile, saveFile } from './modules/github.js';
import { parseChat, stringifyChat, filterByRoom, addMessage, formatTimestamp } from './modules/chat.js';

// ── 定数 ────────────────────────────────────────────────────────
const OWNER = 'palmelo2nd';
const REPO  = 'brain_data';
const PATH  = 'chat/todo.md';

const DEFAULT_ROOMS = [
    { id: 'zassan',  name: '雑談' },
    { id: 'renraku', name: '連絡' }
];

const KEY_TOKEN = 'brain_pat_token';
const KEY_USER  = 'chat_username';
const KEY_CACHE = 'chat_cached_data';
const KEY_SHA   = 'chat_cached_sha';

// ── グローバル状態 ───────────────────────────────────────────────
let token        = null;
let currentUser  = null;
let currentData  = { mainData: [], masterData: [] };
let currentSha   = null;
let currentRoom  = DEFAULT_ROOMS[0].id;
let refreshTimer = null;
let pendingRooms = [];

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
    document.getElementById('logout-btn').addEventListener('click', handleLogout);
    document.getElementById('send-btn').addEventListener('click', handleSend);
    document.getElementById('refresh-btn').addEventListener('click', loadMessages);
    document.getElementById('clear-cache-btn').addEventListener('click', handleClearCache);
    document.getElementById('settings-btn').addEventListener('click', openSettings);
    document.getElementById('settings-close-btn').addEventListener('click', closeSettings);
    document.getElementById('add-room-btn').addEventListener('click', handleAddRoom);
    document.getElementById('settings-save-btn').addEventListener('click', handleSaveSettings);

    document.getElementById('message-input').addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });
    document.getElementById('message-input').addEventListener('input', autoResizeTextarea);

    document.getElementById('new-room-name').addEventListener('keydown', e => {
        if (e.key === 'Enter') handleAddRoom();
    });

    // モーダル外クリックで閉じる
    document.getElementById('settings-modal').addEventListener('click', e => {
        if (e.target === e.currentTarget) closeSettings();
    });
}

// ── ログイン ────────────────────────────────────────────────────
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
    loadMessages();
    startAutoRefresh();
}

// ── ルーム ──────────────────────────────────────────────────────
function getRooms() {
    return currentData.masterData.length > 0 ? currentData.masterData : DEFAULT_ROOMS;
}

function renderRoomList() {
    const rooms = getRooms();
    if (!rooms.find(r => r.id === currentRoom)) {
        currentRoom = rooms[0]?.id ?? '';
    }
    const nav = document.getElementById('room-tabs');
    nav.innerHTML = rooms.map(r => `
        <button class="room-tab${r.id === currentRoom ? ' active' : ''}" data-room="${r.id}">
            ${escHtml(r.name)}
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
    renderRoomList();
    renderMessages();
}

// ── メッセージ描画（送信者グループ化） ──────────────────────────
function renderMessages() {
    const list     = document.getElementById('message-list');
    const messages = filterByRoom(currentData.mainData, currentRoom);

    if (messages.length === 0) {
        list.innerHTML = '<p class="no-messages">— メッセージはまだありません —</p>';
        return;
    }

    // 連続した同一送信者をグループ化
    const groups = [];
    for (const msg of messages) {
        const last = groups[groups.length - 1];
        if (last && last.sender === msg.sender) {
            last.items.push(msg);
        } else {
            groups.push({ sender: msg.sender, firstTime: msg.timestamp, items: [msg] });
        }
    }

    list.innerHTML = groups.map(g => {
        const isMine = g.sender === currentUser;
        const lines  = g.items.map(m =>
            `<div class="msg-line"><div class="msg-text">${escHtml(m.content)}</div></div>`
        ).join('');
        return `
            <div class="msg-group ${isMine ? 'msg-group--mine' : 'msg-group--theirs'}">
                <div class="msg-meta">
                    <span class="msg-sender">${escHtml(g.sender)}</span>
                    <span>${formatTimestamp(g.firstTime)}</span>
                </div>
                ${lines}
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
    input.style.height = 'auto';
    input.disabled   = true;
    sendBtn.disabled = true;

    try {
        let latestData = currentData;
        let latestSha  = currentSha;
        try {
            const { content: raw, sha } = await fetchFile(token, OWNER, REPO, PATH);
            latestData = parseChat(raw);
            latestSha  = sha;
        } catch {}

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

// ── 自動更新 ────────────────────────────────────────────────────
function startAutoRefresh() {
    refreshTimer = setInterval(loadMessages, 30000);
}

// ── 設定モーダル ────────────────────────────────────────────────
function openSettings() {
    pendingRooms = getRooms().map(r => ({ ...r }));
    renderSettingsModal();
    document.getElementById('settings-modal').classList.remove('hidden');
    document.getElementById('new-room-name').value = '';
}

function closeSettings() {
    document.getElementById('settings-modal').classList.add('hidden');
}

function renderSettingsModal() {
    const list = document.getElementById('room-settings-list');
    list.innerHTML = pendingRooms.map((r, i) => `
        <div class="room-setting-row">
            <input type="text" value="${escHtml(r.name)}" data-index="${i}" class="room-name-input">
            <button class="btn-delete" data-index="${i}" title="削除">✕</button>
        </div>
    `).join('');

    list.querySelectorAll('.room-name-input').forEach(inp => {
        inp.addEventListener('input', e => {
            pendingRooms[+e.target.dataset.index].name = e.target.value;
        });
    });
    list.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', e => {
            pendingRooms.splice(+e.currentTarget.dataset.index, 1);
            renderSettingsModal();
        });
    });
}

function handleAddRoom() {
    const input = document.getElementById('new-room-name');
    const name  = input.value.trim();
    if (!name) return;
    pendingRooms.push({ id: `room-${Date.now()}`, name });
    input.value = '';
    renderSettingsModal();
}

async function handleSaveSettings() {
    if (pendingRooms.length === 0) {
        alert('ルームは1つ以上必要です');
        return;
    }
    const saveBtn = document.getElementById('settings-save-btn');
    saveBtn.disabled = true;

    try {
        let latestData = currentData;
        let latestSha  = currentSha;
        try {
            const { content: raw, sha } = await fetchFile(token, OWNER, REPO, PATH);
            latestData = parseChat(raw);
            latestSha  = sha;
        } catch {}

        latestData.masterData = pendingRooms;
        const markdown = stringifyChat(latestData);
        const { newSha } = await saveFile(token, OWNER, REPO, PATH, markdown, latestSha);
        currentData = latestData;
        currentSha  = newSha;
        localStorage.setItem(KEY_CACHE, markdown);
        localStorage.setItem(KEY_SHA, newSha);

        closeSettings();
        renderRoomList();
        renderMessages();
    } catch (e) {
        alert(`保存失敗: ${e.message}`);
    } finally {
        saveBtn.disabled = false;
    }
}

// ── ユーティリティ ──────────────────────────────────────────────
function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function autoResizeTextarea() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
}
