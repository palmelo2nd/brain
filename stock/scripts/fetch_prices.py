"""
株価（終値のみ・日足）をyfinanceで取得し、銘柄コードごとのCSVとして保存するスクリプト。

デフォルトでは2013年以降の全期間を取得する。複数銘柄をまとめて処理する場合は
--codes にカンマ区切りで指定する（例: --codes 7203,9984,6758）。
Yahoo Finance側への負荷・アクセス制限を避けるため、銘柄ごとの取得の間に
--sleep 秒だけ待機する（1銘柄だけの場合は待機は発生しない）。

出力形式: {output-dir}/{code}.csv （列: date, close。1銘柄1ファイルで全期間をまとめて持つ）
コード形式が4桁でない銘柄やETF・米国株等は、必要に応じて別スクリプト・別フレームで管理してよい。
"""
import argparse
import sys
import time
from pathlib import Path

import yfinance as yf

# 東証上場銘柄はyfinance（Yahoo Finance）上でこのサフィックスを付けたティッカーになる
TSE_SUFFIX = ".T"


def fetch_close_prices(code: str, start_date: str, period: str | None):
    """指定した証券コードの日足終値をDataFrameで返す（列: close、インデックス: 日付）。
    period が指定されていればそちらを優先し、無ければ start_date 以降の全期間を取得する。
    """
    ticker = f"{code}{TSE_SUFFIX}"
    if period:
        data = yf.Ticker(ticker).history(period=period)
    else:
        data = yf.Ticker(ticker).history(start=start_date)
    if data.empty:
        return data

    closes = data[["Close"]].rename(columns={"Close": "close"})
    closes["close"] = closes["close"].round(2)  # 株式分割調整の影響で細かい小数が出るため丸める
    closes.index = closes.index.tz_localize(None).normalize()  # タイムゾーン・時刻を落として日付のみにする
    closes.index.name = "date"
    return closes


def save_to_csv(df, output_dir: Path, code: str) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{code}.csv"
    df.to_csv(output_path, date_format="%Y-%m-%d")
    return output_path


def main():
    parser = argparse.ArgumentParser(description="yfinanceで東証銘柄の日足終値を取得しCSV保存する")
    parser.add_argument("--codes", default="7203", help="証券コード（カンマ区切りで複数指定可。例: 7203,9984,6758）")
    parser.add_argument("--start-date", default="2013-01-01", help="取得開始日（YYYY-MM-DD）。--period未指定時に使用")
    parser.add_argument("--period", default=None, help="相対期間指定（yfinance形式。例: 5d, 1mo）。指定時は--start-dateより優先")
    parser.add_argument("--sleep", type=float, default=2.0, help="銘柄ごとの取得間隔（秒）。アクセス制限回避のため")
    parser.add_argument(
        "--output-dir",
        default="../../../brain_data/stock/prices",
        help="出力先ディレクトリ（ローカル動作確認用のデフォルトはデータリポジトリのstock/prices）",
    )
    args = parser.parse_args()

    codes = [c.strip() for c in args.codes.split(",") if c.strip()]
    if not codes:
        print("証券コードが指定されていません", file=sys.stderr)
        sys.exit(1)

    failed = []
    for i, code in enumerate(codes):
        df = fetch_close_prices(code, args.start_date, args.period)
        if df.empty:
            print(f"データが取得できませんでした（コード: {code}）", file=sys.stderr)
            failed.append(code)
        else:
            output_path = save_to_csv(df, Path(args.output_dir), code)
            print(f"保存しました: {output_path}（{len(df)}件）")

        if i < len(codes) - 1:
            time.sleep(args.sleep)

    if failed:
        print(f"取得失敗: {', '.join(failed)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
