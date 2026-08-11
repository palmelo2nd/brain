// (1) インポート — なし（Web標準APIのみ使用）

const TOKEN_KEY = 'stock_token'; // GitHub PAT（brain・brain_data両リポジトリ共通で使用）

// 過去のキー形式からの引き継ぎ用（新しい順）。
// PW欄（データリポジトリ操作用）はContents読み書き権限を持っていたため、最も実運用に近い候補として優先する。
const LEGACY_PW_KEY     = 'stock_pw_token';  // ID/PW2欄だった頃のPW欄（データリポジトリ操作用）
const LEGACY_ID_KEY     = 'stock_id_token';  // ID/PW2欄だった頃のID欄（コードリポジトリ操作用）
const LEGACY_SINGLE_KEY = 'stock_pat_token'; // さらに古い、単一PAT欄だった頃の保存値

// (2) インプット — なし  (3) メイン — localStorage読み取り（新キーが未設定なら旧キーの値を優先順に引き継ぐ）  (4) アウトプット — トークン
export function loadToken() {
    return localStorage.getItem(TOKEN_KEY)
        || localStorage.getItem(LEGACY_PW_KEY)
        || localStorage.getItem(LEGACY_ID_KEY)
        || localStorage.getItem(LEGACY_SINGLE_KEY)
        || '';
}

// (2) インプット: token  (3) メイン — localStorage書き込み  (4) アウトプット — なし
export function saveToken(token) {
    localStorage.setItem(TOKEN_KEY, token);
}
