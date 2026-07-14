"""
株価（終値のみ・日足）をyfinanceで取得し、銘柄コードごとのCSVとして保存するスクリプト。

デフォルトでは2013年以降の全期間を取得する。対象銘柄の指定方法は2通り:
  1. --codes にカンマ区切りで直接指定する（例: --codes 7203,9984,6758）
  2. --master に銘柄マスタCSV（master.csv）を指定し、--asset-types で絞り込んだ上で
     --offset/--limit で範囲を切り出す（大量銘柄を小分けに処理する用途）

Yahoo Finance側への負荷・アクセス制限を避けるため、銘柄ごとの取得の間に
--sleep 秒だけ待機する（対象が1銘柄だけの場合は待機は発生しない）。
1銘柄の取得失敗（例外発生含む）は記録するだけで処理を継続し、他銘柄の取得を止めない。

出力形式: {output-dir}/{code}.csv （列: date, close。1銘柄1ファイルで全期間をまとめて持つ）
コード形式が4桁でない銘柄やETF・米国株等は、必要に応じて別スクリプト・別フレームで管理してよい。
"""
import argparse
import sys
import time
from pathlib import Path

import pandas as pd
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


def load_codes_from_master(master_path: Path, asset_types: list[str], offset: int, limit: int | None) -> list[str]:
    """銘柄マスタCSV（master.csv）から、指定したasset_typeに絞って証券コードの一覧を返し、
    offset/limitで範囲を切り出す（大量銘柄を小分けに処理するためのバッチ指定）。
    listed（上場中）のみを対象とする。
    """
    df = pd.read_csv(master_path, dtype=str)
    df = df[df["status"] == "listed"]
    if asset_types:
        df = df[df["asset_type"].isin(asset_types)]
    codes = df["code"].tolist()

    if limit is not None:
        return codes[offset:offset + limit]
    return codes[offset:]


def main():
    parser = argparse.ArgumentParser(description="yfinanceで東証銘柄の日足終値を取得しCSV保存する")
    parser.add_argument("--codes", default=None, help="証券コード（カンマ区切りで複数指定可。例: 7203,9984,6758）。--master指定時は無視される")
    parser.add_argument("--master", default=None, help="銘柄マスタCSV（master.csv）のパス。指定時はこちらから証券コードを読み込む")
    parser.add_argument("--asset-types", default="内国株式,ETF・ETN", help="--master指定時、対象とするasset_type（カンマ区切り）")
    parser.add_argument("--offset", type=int, default=0, help="--master指定時、対象銘柄一覧の何件目から処理するか（0始まり）")
    parser.add_argument("--limit", type=int, default=None, help="--master指定時、対象銘柄一覧を何件処理するか（省略時は末尾まで）")
    parser.add_argument("--start-date", default="2013-01-01", help="取得開始日（YYYY-MM-DD）。--period未指定時に使用")
    parser.add_argument("--period", default=None, help="相対期間指定（yfinance形式。例: 5d, 1mo）。指定時は--start-dateより優先")
    parser.add_argument("--sleep", type=float, default=2.0, help="銘柄ごとの取得間隔（秒）。アクセス制限回避のため")
    parser.add_argument(
        "--output-dir",
        default="../../../brain_data/stock/prices",
        help="出力先ディレクトリ（ローカル動作確認用のデフォルトはデータリポジトリのstock/prices）",
    )
    args = parser.parse_args()

    if args.master:
        asset_types = [a.strip() for a in args.asset_types.split(",") if a.strip()]
        codes = load_codes_from_master(Path(args.master), asset_types, args.offset, args.limit)
    else:
        codes = [c.strip() for c in (args.codes or "").split(",") if c.strip()]

    if not codes:
        print("対象の証券コードが0件でした（--codes/--masterの指定を確認してください）", file=sys.stderr)
        sys.exit(1)

    print(f"対象: {len(codes)}銘柄")

    succeeded = 0
    failed = []
    for i, code in enumerate(codes):
        try:
            df = fetch_close_prices(code, args.start_date, args.period)
            if df.empty:
                print(f"データが取得できませんでした（コード: {code}）", file=sys.stderr)
                failed.append(code)
            else:
                output_path = save_to_csv(df, Path(args.output_dir), code)
                print(f"保存しました: {output_path}（{len(df)}件）")
                succeeded += 1
        except Exception as e:
            # 1銘柄の例外（通信エラー・想定外のティッカー形式等）で全体を止めない
            print(f"エラーが発生しました（コード: {code}）: {e}", file=sys.stderr)
            failed.append(code)

        if i < len(codes) - 1:
            time.sleep(args.sleep)

    print(f"完了: 成功 {succeeded}件 / 失敗 {len(failed)}件")
    if failed:
        print(f"取得失敗: {', '.join(failed)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
