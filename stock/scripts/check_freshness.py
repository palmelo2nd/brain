"""
株価CSV（stock/prices/{code}.csv）の最終日付だけを集計し、データ鮮度の全体像を素早く把握するスクリプト。

validate_prices.py（欠損・重複・日付間隔異常など行単位まで見る重いチェック）とは別に、
「今、各銘柄が何日時点まで取得できているか」を一覧で確認する軽量な用途に特化している。

--report を指定すると、結果をJSON形式で書き出す（アプリのフロントエンドから読み込んで表示する用途）。
"""
import argparse
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

import pandas as pd

# validate_prices.pyのDEFAULT_MAX_GAP_DAYSと揃えている
DEFAULT_STALE_DAYS = 10


def get_last_date(path: Path):
    """CSVのdate列だけを読み込み、最終日付（Timestamp）を返す（データが無ければNone）。"""
    df = pd.read_csv(path, usecols=["date"], parse_dates=["date"])
    if df.empty:
        return None
    return df["date"].max()


def load_excluded_codes(exclude_file: str | None) -> set[str]:
    """除外対象の証券コード一覧CSV（code列。stock/delisted.csv想定）を読み込み、コードのsetを返す。
    パス未指定・ファイル未作成（まだ1件も登録されていない）の場合は空setを返す。
    """
    if not exclude_file:
        return set()
    path = Path(exclude_file)
    if not path.exists():
        return set()
    df = pd.read_csv(path, dtype=str)
    if "code" not in df.columns:
        return set()
    return set(df["code"].dropna().astype(str).str.strip())


def main():
    parser = argparse.ArgumentParser(description="株価CSVの最終日付を集計し、鮮度サマリーを出力する")
    parser.add_argument("--dir", default="../../../brain_data/stock/prices", help="対象のCSVが入ったディレクトリ")
    parser.add_argument("--codes", default=None, help="対象の証券コード（カンマ区切り。省略時はディレクトリ内の全CSV）")
    parser.add_argument("--exclude-file", default=None, help="除外する証券コード一覧CSV（code列。上場廃止銘柄など）")
    parser.add_argument(
        "--stale-days", type=int, default=DEFAULT_STALE_DAYS,
        help="最終日付からこれを超える日数が経っている銘柄を「要更新」とみなす",
    )
    parser.add_argument("--report", default=None, help="結果をJSON形式で書き出すファイルパス（省略時は書き出さない）")
    args = parser.parse_args()

    exclude_codes = load_excluded_codes(args.exclude_file)

    target_dir = Path(args.dir)
    if args.codes:
        files = [target_dir / f"{c.strip()}.csv" for c in args.codes.split(",") if c.strip() and c.strip() not in exclude_codes]
    else:
        files = sorted(f for f in target_dir.glob("*.csv") if f.stem not in exclude_codes)

    if not files:
        print(f"対象のCSVが見つかりませんでした: {target_dir}", file=sys.stderr)
        sys.exit(1)

    last_dates = {}
    for path in files:
        if not path.exists():
            print(f"ファイルが見つかりません: {path}", file=sys.stderr)
            continue
        last_date = get_last_date(path)
        if last_date is not None:
            last_dates[path.stem] = last_date

    if not last_dates:
        print("有効なデータが1件もありませんでした", file=sys.stderr)
        sys.exit(1)

    now = datetime.now()
    latest_date = max(last_dates.values())
    oldest_last_date_code, oldest_last_date = min(last_dates.items(), key=lambda kv: kv[1])
    stale_codes = [code for code, d in last_dates.items() if (now - d).days > args.stale_days]
    distribution = Counter(d.strftime("%Y-%m-%d") for d in last_dates.values())

    # 日付ごとの該当銘柄コード一覧（フロントエンドでの内訳表示用）。コード順に並べておく
    codes_by_date = defaultdict(list)
    for code, d in last_dates.items():
        codes_by_date[d.strftime("%Y-%m-%d")].append(code)
    for codes in codes_by_date.values():
        codes.sort()

    print(
        f"対象: {len(last_dates)}銘柄 / 全体の最新日付: {latest_date.date()} / "
        f"最も遅れている銘柄: {oldest_last_date_code}（{oldest_last_date.date()}） / "
        f"要更新（{args.stale_days}日超過）: {len(stale_codes)}件"
    )

    if args.report:
        report = {
            "checked_at": now.isoformat(timespec="seconds"),
            "total_files": len(last_dates),
            "latest_date": latest_date.strftime("%Y-%m-%d"),
            "oldest_last_date": oldest_last_date.strftime("%Y-%m-%d"),
            "oldest_last_date_code": oldest_last_date_code,
            "stale_days": args.stale_days,
            "stale_count": len(stale_codes),
            "distribution": dict(sorted(distribution.items())),
            "codes_by_date": dict(sorted(codes_by_date.items())),
        }
        report_path = Path(args.report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        print(f"レポートを保存しました: {report_path}")


if __name__ == "__main__":
    main()
