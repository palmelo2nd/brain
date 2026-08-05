// (1) インポート — なし（Web標準APIのみ使用）

const ID_TOKEN_KEY     = 'stock_id_token';  // ID欄：コードリポジトリ（brain）操作用PAT（ワークフロー起動）
const PW_TOKEN_KEY     = 'stock_pw_token';  // PW欄：データリポジトリ（brain_data）操作用PAT（ファイル読み書き）
const LEGACY_TOKEN_KEY = 'stock_pat_token'; // 旧・PAT欄が1つだった頃の保存値（ID欄への引き継ぎ用）

// (2) インプット — なし  (3) メイン — localStorage読み取り（新キーが未設定なら旧・単一PAT欄の値を引き継ぐ）  (4) アウトプット — ID欄のトークン
export function loadIdToken() {
    return localStorage.getItem(ID_TOKEN_KEY) || localStorage.getItem(LEGACY_TOKEN_KEY) || '';
}

// (2) インプット: token  (3) メイン — localStorage書き込み  (4) アウトプット — なし
export function saveIdToken(token) {
    localStorage.setItem(ID_TOKEN_KEY, token);
}

// (2) インプット — なし  (3) メイン — localStorage読み取り  (4) アウトプット — PW欄のトークン
export function loadPwToken() {
    return localStorage.getItem(PW_TOKEN_KEY) || '';
}

// (2) インプット: token  (3) メイン — localStorage書き込み  (4) アウトプット — なし
export function savePwToken(token) {
    localStorage.setItem(PW_TOKEN_KEY, token);
}
