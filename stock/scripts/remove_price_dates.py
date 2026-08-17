"""
株価CSV（stock/prices/{code}.csv）から、指定した日付の行を一括で取り除く修復用スクリプト。

主な用途：取引時間中にfetch_prices.pyを実行してしまい、その日の分に確定前の途中価格が
保存された場合の削除（fetch_prices.py側は当日分を保存しない仕様に修正済みだが、
修正前に保存された分は残ったままのため、この一回限りの修復で取り除く）。

削除後、翌日以降にfetch_prices.py（updateモード）を実行すれば、その日は「最終日の翌日」
として自然に再取得対象になり、確定値で埋め直される。

変更があったファイルだけを上書きし、除去した行数をファイルごとに出力する。
"""
import argparse
import sys
from pathlib import Path

import pandas as pd


def remove_dates_from_file(path: Path, dates: set[str]) -> int:
    """1銘柄分のCSVから指定日付の行を除去する。除去した行数を返す（無ければ0で、ファイルは変更しない）。"""
    df = pd.read_csv(path, dtype={"date": str})
    matched = df["date"].isin(dates)
    removed = int(matched.sum())
    if removed == 0:
        return 0

    cleaned = df[~matched].sort_values("date")
    cleaned.to_csv(path, index=False)
    return removed


def main():
    parser = argparse.ArgumentParser(description="株価CSVから指定日付の行を除去する（既存データの修復用）")
    parser.add_argument("--dir", default="../../../brain_data/stock/prices", help="対象のCSVが入ったディレクトリ")
    parser.add_argument("--dates", required=True, help="除去する日付（カンマ区切り、YYYY-MM-DD形式。例: 2026-08-17,2026-08-16）")
    parser.add_argument("--codes", default=None, help="対象の証券コード（カンマ区切り。省略時はディレクトリ内の全CSV）")
    args = parser.parse_args()

    dates = {d.strip() for d in args.dates.split(",") if d.strip()}
    if not dates:
        print("--datesが空です（除去する日付を指定してください）", file=sys.stderr)
        sys.exit(1)

    target_dir = Path(args.dir)
    if args.codes:
        files = [target_dir / f"{c.strip()}.csv" for c in args.codes.split(",") if c.strip()]
        files = [p for p in files if p.exists()]
    else:
        files = sorted(target_dir.glob("*.csv"))

    if not files:
        print(f"対象のCSVが見つかりませんでした: {target_dir}", file=sys.stderr)
        sys.exit(1)

    total_removed = 0
    fixed_files = 0
    for path in files:
        removed = remove_dates_from_file(path, dates)
        if removed:
            total_removed += removed
            fixed_files += 1
            print(f"修正しました: {path.name}（{removed}行除去）")

    print(f"完了: {fixed_files}銘柄で合計{total_removed}行を除去しました（対象{len(files)}銘柄 / 指定日付: {', '.join(sorted(dates))}）")


if __name__ == "__main__":
    main()
