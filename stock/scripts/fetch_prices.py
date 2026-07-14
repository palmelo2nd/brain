"""
株価（終値のみ・日足）をyfinanceで取得し、銘柄コードごとのCSVとして保存する最小構成スクリプト。

将来的には東証全銘柄・2013年以降を対象にする想定だが、まずは1銘柄・数日分だけを
取得して、取得〜保存までの一連の流れが動くことを確認するためのもの。

出力形式: {output-dir}/{code}.csv （列: date, close）
銘柄を追加するときはこのファイルを1銘柄ずつ複数回呼び出す想定（コード形式が
4桁でない銘柄やETF・米国株等は、必要に応じて別スクリプト・別フレームで管理してよい）。
"""
import argparse
import sys
from pathlib import Path

import yfinance as yf

# 東証上場銘柄はyfinance（Yahoo Finance）上でこのサフィックスを付けたティッカーになる
TSE_SUFFIX = ".T"


def fetch_close_prices(code: str, period: str):
    """指定した証券コードの日足終値をDataFrameで返す（列: close、インデックス: 日付）。"""
    ticker = f"{code}{TSE_SUFFIX}"
    data = yf.Ticker(ticker).history(period=period)
    if data.empty:
        return data

    closes = data[["Close"]].rename(columns={"Close": "close"})
    closes.index = closes.index.tz_localize(None).normalize()  # タイムゾーン・時刻を落として日付のみにする
    closes.index.name = "date"
    return closes


def save_to_csv(df, output_dir: Path, code: str) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{code}.csv"
    df.to_csv(output_path, date_format="%Y-%m-%d")
    return output_path


def main():
    parser = argparse.ArgumentParser(description="yfinanceで東証銘柄の日足終値を取得しCSV保存する（最小構成）")
    parser.add_argument("--code", default="7203", help="証券コード（例: 7203）")
    parser.add_argument("--period", default="5d", help="取得期間（yfinance形式。例: 5d, 1mo, max）")
    parser.add_argument(
        "--output-dir",
        default="../../../brain_data/stock/prices",
        help="出力先ディレクトリ（ローカル動作確認用のデフォルトはデータリポジトリのstock/prices）",
    )
    args = parser.parse_args()

    df = fetch_close_prices(args.code, args.period)
    if df.empty:
        print(f"データが取得できませんでした（コード: {args.code}）", file=sys.stderr)
        sys.exit(1)

    output_path = save_to_csv(df, Path(args.output_dir), args.code)
    print(f"保存しました: {output_path}（{len(df)}件）")


if __name__ == "__main__":
    main()
