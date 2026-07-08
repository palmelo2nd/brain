// (1) インポート — なし

// (2) インプット: contentText — todo.md の生テキスト

// (3)(4) パース・生成・操作ロジック

export function parseChat(contentText) {
    const match = contentText.match(/---\s*([\s\S]*?)\s*---/);
    if (!match) return { mainData: [], masterData: [] };
    try {
        return JSON.parse(match[1]);
    } catch {
        return { mainData: [], masterData: [] };
    }
}

export function stringifyChat(data) {
    return `---\n${JSON.stringify(data, null, 2)}\n---\n`;
}

export function filterByRoom(messages, roomId) {
    return messages.filter(m => m.room === roomId);
}

export function addMessage(messages, roomId, sender, content) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return [...messages, { id, room: roomId, sender, content, timestamp: new Date().toISOString() }];
}

export function formatTimestamp(isoString) {
    const d    = new Date(isoString);
    const now  = new Date();
    const today     = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterday = today - 86400000;
    const msgDay    = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

    if (msgDay === today)     return hhmm;
    if (msgDay === yesterday) return `昨日 ${hhmm}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
}
