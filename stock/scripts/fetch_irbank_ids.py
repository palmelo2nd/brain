"""
IRBANK（irbank.net）から個別銘柄の企業ID（EID）・URL・社名を取得し、stock/irbank.csv を更新するスクリプト。

対象は銘柄マスタ（master.csv）の status=listed かつ asset_type=内国株式 の銘柄のみ（ETF・REIT・PRO Market等は
IRBANKの個別企業ページを持たないため対象外）。既に status=ok で取得済みの銘柄は再取得しない
（差分更新・中断再開に対応。全列保持ではなく、このスクリプトが担当する列だけを持つ専用ファイルのため
master.csv側の再生成では消えない）。

EID解決は直URL（https://irbank.net/{code}）→検索（https://irbank.net/search?q={code}）の2段構え。
Yahoo Finance側と同様、IRBANK側への負荷に配慮し、銘柄ごとの取得の間に --sleep 秒だけ待機する。
1銘柄の取得失敗（例外発生含む）は記録するだけで処理を継続し、他銘柄の取得を止めない。

出力形式: {output}（既定: ../../../brain_data/stock/irbank.csv）
列: code, eid, url, name, status, updated_at
status の意味: ok=取得済み / not_found=株だがEID未取得（次回再挑戦対象）
"""
import argparse
import random
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import requests
from bs4 import BeautifulSoup

BASE_BY_CODE = "https://irbank.net/{code}"
SEARCH_URL = "https://irbank.net/search?q={code}"
RESULTS_URL = "https://irbank.net/{eid}/results"

# 自己申告のボットUA（例: "compatible; xxx-fetcher/1.0"）だとIRBANK側にブロックされ、
# 全銘柄が一律で取得失敗になる事例が確認されたため、実ブラウザ（Chrome）を偽装したUAを使う。
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
ACCEPT_HEADER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
JST = timezone(timedelta(hours=9))

IRBANK_COLUMNS = ["code", "eid", "url", "name", "status", "updated_at"]


def make_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT, "Accept": ACCEPT_HEADER})
    return session


def fetch_html(url: str, session: requests.Session, timeout: float = 20.0) -> str:
    response = session.get(url, timeout=timeout)
    response.raise_for_status()
    response.encoding = response.apparent_encoding or "utf-8"
    return response.text


def polite_sleep(base: float) -> None:
    """次のリクエストまでジッター付きで待機する（IRBANK側への負荷配慮）。"""
    time.sleep(max(0.0, base + random.uniform(-0.5 * base, 0.5 * base)))


def extract_name_from_html(html: str) -> str | None:
    """企業ページのh1タグから、先頭の証券コード表記を除いた社名を取り出す。"""
    soup = BeautifulSoup(html, "html.parser")
    h1 = soup.find("h1")
    if not h1:
        return None
    text = h1.get_text(strip=True)
    text = re.sub(r"^[0-9A-Za-z]+\s*", "", text)
    return text or None


def resolve_eid(code: str, session: requests.Session, sleep_sec: float) -> tuple[str | None, str]:
    """証券コードから企業ID（EID）を解決する。直URL→検索の順で試す。
    見つかれば (EID, "")、見つからなければ (None, 診断用の失敗理由) を返す。
    """
    reasons: list[str] = []

    try:
        html = fetch_html(BASE_BY_CODE.format(code=code), session)
        soup = BeautifulSoup(html, "html.parser")
        a = soup.select_one('a[href^="/E"][href*="/results"]') or soup.select_one('a[href^="/E"]')
        if a and a.get("href"):
            m = re.search(r"/(E\d+)", a["href"])
            if m:
                return m.group(1), ""
        reasons.append(f"直URL: EIDリンクが見つからない（取得HTML長={len(html)}文字、先頭100文字: {html[:100]!r}）")
    except requests.HTTPError as e:
        status = e.response.status_code if e.response is not None else "?"
        reasons.append(f"直URL: HTTPエラー status={status}")
    except Exception as e:
        reasons.append(f"直URL: {type(e).__name__}: {e}")

    try:
        polite_sleep(sleep_sec)
        html = fetch_html(SEARCH_URL.format(code=code), session)
        soup = BeautifulSoup(html, "html.parser")
        for a in soup.select('a[href^="/E"]'):
            m = re.search(r"^/?(E\d+)", a.get("href", ""))
            if m:
                return m.group(1), ""
        reasons.append(f"検索: EIDリンクが見つからない（取得HTML長={len(html)}文字）")
    except requests.HTTPError as e:
        status = e.response.status_code if e.response is not None else "?"
        reasons.append(f"検索: HTTPエラー status={status}")
    except Exception as e:
        reasons.append(f"検索: {type(e).__name__}: {e}")

    return None, " / ".join(reasons)


def load_existing(irbank_csv: Path) -> dict[str, dict]:
    """既存のirbank.csvをcode→行辞書のマップとして読み込む（無ければ空）。"""
    if not irbank_csv.exists():
        return {}
    df = pd.read_csv(irbank_csv, dtype=str).fillna("")
    return {str(row["code"]): row.to_dict() for _, row in df.iterrows()}


def save_irbank_csv(rows: dict[str, dict], irbank_csv: Path) -> None:
    irbank_csv.parent.mkdir(parents=True, exist_ok=True)
    df = pd.DataFrame(list(rows.values()), columns=IRBANK_COLUMNS)
    df = df.sort_values("code")
    df.to_csv(irbank_csv, index=False)


def load_target_codes_from_master(master_csv: Path, offset: int, limit: int | None) -> list[str]:
    """銘柄マスタから対象（status=listed かつ asset_type=内国株式）の証券コード一覧を返し、offset/limitで切り出す。"""
    df = pd.read_csv(master_csv, dtype=str).fillna("")
    df = df[(df["status"] == "listed") & (df["asset_type"] == "内国株式")]
    codes = df["code"].tolist()
    if limit is not None:
        return codes[offset:offset + limit]
    return codes[offset:]


def main():
    parser = argparse.ArgumentParser(description="IRBANKから企業ID(EID)・URL・社名を取得しstock/irbank.csvを更新する")
    parser.add_argument("--codes", default=None, help="証券コード（カンマ区切りで複数指定可）。指定時は--masterを無視する")
    parser.add_argument("--master", default=None, help="銘柄マスタCSV（master.csv）のパス。指定時はこちらから対象コードを読み込む")
    parser.add_argument("--offset", type=int, default=0, help="--master指定時、対象一覧の何件目から処理するか（0始まり）")
    parser.add_argument("--limit", type=int, default=None, help="--master指定時、対象一覧を何件処理するか（省略時は末尾まで）")
    parser.add_argument("--sleep", type=float, default=1.2, help="銘柄ごとの取得間隔（秒）。IRBANK側への負荷配慮のため")
    parser.add_argument(
        "--output-dir", default="../../../brain_data/stock",
        help="出力先ディレクトリ（ローカル動作確認用のデフォルトはデータリポジトリのstock）",
    )
    args = parser.parse_args()

    if args.codes:
        target_codes = [c.strip() for c in args.codes.split(",") if c.strip()]
    elif args.master:
        target_codes = load_target_codes_from_master(Path(args.master), args.offset, args.limit)
    else:
        print("対象の指定が必要です（--codes または --master）", file=sys.stderr)
        sys.exit(1)

    if not target_codes:
        print("対象の証券コードが0件でした", file=sys.stderr)
        sys.exit(1)

    output_path = Path(args.output_dir) / "irbank.csv"
    existing = load_existing(output_path)
    session = make_session()

    print(f"対象: {len(target_codes)}銘柄")

    succeeded = 0
    skipped = 0
    failed = []

    for i, code in enumerate(target_codes):
        row = existing.get(code)
        if row and row.get("status") == "ok" and row.get("eid"):
            skipped += 1
            continue

        called_api = False
        try:
            eid, reason = resolve_eid(code, session, args.sleep)
            called_api = True
            now = datetime.now(JST).strftime("%Y-%m-%d %H:%M:%S")

            if not eid:
                existing[code] = {"code": code, "eid": "", "url": "", "name": "", "status": "not_found", "updated_at": now}
                print(f"[not_found] コード: {code}（{reason}）")
                failed.append(code)
            else:
                url = RESULTS_URL.format(eid=eid)
                polite_sleep(args.sleep)
                name = ""
                try:
                    name = extract_name_from_html(fetch_html(url, session)) or ""
                except Exception:
                    pass

                existing[code] = {"code": code, "eid": eid, "url": url, "name": name, "status": "ok", "updated_at": now}
                succeeded += 1
                print(f"[ok] コード: {code} / EID: {eid} / 社名: {name}")
        except Exception as e:
            # 1銘柄の例外（通信エラー・想定外のページ構造等）で全体を止めない
            now = datetime.now(JST).strftime("%Y-%m-%d %H:%M:%S")
            existing[code] = {"code": code, "eid": "", "url": "", "name": "", "status": "not_found", "updated_at": now}
            print(f"エラーが発生しました（コード: {code}）: {e}", file=sys.stderr)
            failed.append(code)

        if called_api and i < len(target_codes) - 1:
            polite_sleep(args.sleep)

    save_irbank_csv(existing, output_path)

    print(f"完了: 成功 {succeeded}件 / スキップ(取得済み) {skipped}件 / 未取得・失敗 {len(failed)}件")
    if failed:
        print(f"未取得・失敗コード: {', '.join(failed)}", file=sys.stderr)


if __name__ == "__main__":
    main()
