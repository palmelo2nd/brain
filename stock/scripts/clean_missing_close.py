"""
株価CSV（stock/prices/{code}.csv）から、終値が空の行を取り除く一回限りの修復用スクリプト。

過去のfetch_prices.py（終値が空の行を除外していなかった旧版）で保存された、
取引時間中の未確定データ等に由来する空行を一括で除去する。
（再発防止自体はfetch_prices.py側の修正で対応済み。このスクリプトは既存データの修復専用）

変更があったファイルだけを上書きし、除去した行数をファイルごとに出力する。
"""
import argparse
import sys
from pathlib import Path

import pandas as pd


def clean_file(path: Path) -> int:
    """1銘柄分のCSVから終値が空の行を除去する。除去した行数を返す（無ければ0で、ファイルは変更しない）。"""
    df = pd.read_csv(path, parse_dates=["date"])
    missing = df["close"].isna()
    removed = int(missing.sum())
    if removed == 0:
        return 0

    cleaned = df[~missing].sort_values("date")
    cleaned.to_csv(path, index=False, date_format="%Y-%m-%d")
    return removed


def main():
    parser = argparse.ArgumentParser(description="株価CSVから終値が空の行を除去する（既存データの修復用）")
    parser.add_argument("--dir", default="../../../brain_data/stock/prices", help="対象のCSVが入ったディレクトリ")
    args = parser.parse_args()

    target_dir = Path(args.dir)
    files = sorted(target_dir.glob("*.csv"))
    if not files:
        print(f"対象のCSVが見つかりませんでした: {target_dir}", file=sys.stderr)
        sys.exit(1)

    total_removed = 0
    fixed_files = 0
    for path in files:
        removed = clean_file(path)
        if removed:
            total_removed += removed
            fixed_files += 1
            print(f"修正しました: {path.name}（{removed}行除去）")

    print(f"完了: {fixed_files}銘柄で合計{total_removed}行を除去しました（対象{len(files)}銘柄）")


if __name__ == "__main__":
    main()
