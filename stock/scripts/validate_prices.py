"""
株価CSV（stock/prices/{code}.csv）のデータ品質チェックを行うスクリプト。
yfinance側のアクセス制限・通信エラー等により、一部の期間が欠損したまま
保存されていないかを検出する。

チェック項目:
1. 日付の間隔異常（連続する行の間が通常の連休を超えて開いていないか＝欠損の疑い）
2. 終値が空の行が無いか
3. 重複した日付が無いか
4. 日付が昇順に並んでいるか
5. 最新データが古すぎないか（更新が止まっていないか）
"""
import argparse
import sys
from datetime import datetime
from pathlib import Path

import pandas as pd

# 年末年始・ゴールデンウィーク等の通常の連休を考慮し、これを超える間隔（暦日）を異常とみなす
DEFAULT_MAX_GAP_DAYS = 10


def validate_file(path: Path, max_gap_days: int = DEFAULT_MAX_GAP_DAYS) -> list[str]:
    """1銘柄分のCSVを検証し、問題点の説明文リストを返す（問題が無ければ空リスト）。"""
    code = path.stem
    df = pd.read_csv(path, parse_dates=["date"])

    if df.empty:
        return [f"[{code}] ファイルが空です"]

    issues = []

    missing = df[df["close"].isna()]
    if not missing.empty:
        issues.append(f"[{code}] 終値が空の行が{len(missing)}件あります（例: {missing['date'].iloc[0].date()}）")

    dup = df[df["date"].duplicated()]
    if not dup.empty:
        issues.append(f"[{code}] 重複した日付が{len(dup)}件あります（例: {dup['date'].iloc[0].date()}）")

    if not df["date"].is_monotonic_increasing:
        issues.append(f"[{code}] 日付が昇順に並んでいません")

    sorted_df = df.sort_values("date").reset_index(drop=True)
    gap_days = sorted_df["date"].diff().dt.days
    for i in gap_days[gap_days > max_gap_days].index:
        prev_date = sorted_df["date"].iloc[i - 1].date()
        curr_date = sorted_df["date"].iloc[i].date()
        issues.append(f"[{code}] {prev_date} → {curr_date} の間隔が{int(gap_days.iloc[i])}日あります（欠損の可能性）")

    last_date = sorted_df["date"].iloc[-1]
    days_since_last = (datetime.now() - last_date).days
    if days_since_last > max_gap_days:
        issues.append(f"[{code}] 最新データが{last_date.date()}のままで、{days_since_last}日間更新されていません")

    return issues


def main():
    parser = argparse.ArgumentParser(description="株価CSVのデータ品質チェック（欠損検出）")
    parser.add_argument("--dir", default="../../../brain_data/stock/prices", help="検証対象のCSVが入ったディレクトリ")
    parser.add_argument("--codes", default=None, help="検証対象の証券コード（カンマ区切り。省略時はディレクトリ内の全CSVを検証）")
    parser.add_argument("--max-gap-days", type=int, default=DEFAULT_MAX_GAP_DAYS, help="これを超える日数の間隔を異常とみなす")
    args = parser.parse_args()

    target_dir = Path(args.dir)
    if args.codes:
        files = [target_dir / f"{c.strip()}.csv" for c in args.codes.split(",") if c.strip()]
    else:
        files = sorted(target_dir.glob("*.csv"))

    if not files:
        print(f"検証対象のCSVが見つかりませんでした: {target_dir}", file=sys.stderr)
        sys.exit(1)

    all_issues = []
    for path in files:
        if not path.exists():
            all_issues.append(f"[{path.stem}] ファイルが見つかりません: {path}")
            continue
        all_issues.extend(validate_file(path, args.max_gap_days))

    if all_issues:
        print(f"問題が {len(all_issues)} 件見つかりました（{len(files)}銘柄中）:")
        for issue in all_issues:
            print(f"  - {issue}")
        sys.exit(1)

    print(f"問題なし（{len(files)}銘柄をチェックしました）")


if __name__ == "__main__":
    main()
