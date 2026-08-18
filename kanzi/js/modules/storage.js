// (1) インポート — なし（Web標準APIのみ使用）

const TOKEN_KEY = 'kanzi_pat_token';
const DATA_KEY  = 'kanzi_cached_data';
const SHA_KEY   = 'kanzi_cached_sha';

// (2) インプット — なし  (3) メイン — localStorage読み取り  (4) アウトプット — 保存済みトークン or null
export function loadToken() {
    return localStorage.getItem(TOKEN_KEY);
}

// (2) インプット: token  (3) メイン — localStorage書き込み  (4) アウトプット — なし
export function saveToken(token) {
    localStorage.setItem(TOKEN_KEY, token);
}

// (2) インプット — なし  (3) メイン — localStorage読み取り  (4) アウトプット — { content, sha } or null
export function loadCache() {
    const content = localStorage.getItem(DATA_KEY);
    const sha     = localStorage.getItem(SHA_KEY);
    if (!content) return null;
    return { content, sha };
}

// (2) インプット: content, sha  (3) メイン — localStorage書き込み  (4) アウトプット — なし
export function saveCache(content, sha) {
    localStorage.setItem(DATA_KEY, content);
    localStorage.setItem(SHA_KEY,  sha);
}
