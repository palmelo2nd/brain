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

--codes に "N225" を指定すると日経平均株価（yfinanceティッカー ^N225）を取得できる（INDEX_TICKERS参照）。
ベンチマーク比較用で、他の銘柄コードと同じ形式（date, close）でstock/prices/N225.csvに保存される。
"""
import argparse
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf

# 東証上場銘柄はyfinance（Yahoo Finance）上でこのサフィックスを付けたティッカーになる
TSE_SUFFIX = ".T"

# 個別銘柄コードではなく指数のティッカー特例（--codesに"N225"と指定するとこちらを使う）
INDEX_TICKERS = {"N225": "^N225"}  # 日経平均株価


def code_to_ticker(code: str) -> str:
    """証券コードをyfinanceのティッカーに変換する（指数（N225等）は特例テーブルを優先）。"""
    special = INDEX_TICKERS.get(code.upper())
    return special if special else f"{code}{TSE_SUFFIX}"


def fetch_close_prices(code: str, start_date: str, period: str | None):
    """指定した証券コードの日足終値をDataFrameで返す（列: close、インデックス: 日付）。
    period が指定されていればそちらを優先し、無ければ start_date 以降の全期間を取得する。
    """
    ticker = code_to_ticker(code)
    if period:
        data = yf.Ticker(ticker).history(period=period)
    else:
        data = yf.Ticker(ticker).history(start=start_date)
    if data.empty:
        return data

    closes = data[["Close"]].rename(columns={"Close": "close"})
    closes = closes.dropna(subset=["close"])  # 当日分の取引がまだ確定していない等で終値が空の行は保存しない
    closes["close"] = closes["close"].round(2)  # 株式分割調整の影響で細かい小数が出るため丸める
    closes.index = closes.index.tz_localize(None).normalize()  # タイムゾーン・時刻を落として日付のみにする
    closes.index.name = "date"
    return closes


def load_existing(output_dir: Path, code: str):
    """既存の保存済みCSVを読み込んで返す（無ければNone）。"""
    path = output_dir / f"{code}.csv"
    if not path.exists():
        return None
    df = pd.read_csv(path, parse_dates=["date"])
    return df.set_index("date")


def merge_prices(existing_df, new_df):
    """既存データと新規取得データを日付でマージする（重複日付は新データを優先し、日付昇順で返す）。"""
    if existing_df is None or existing_df.empty:
        return new_df
    if new_df is None or new_df.empty:
        return existing_df
    combined = pd.concat([existing_df, new_df])
    combined = combined[~combined.index.duplicated(keep="last")]
    return combined.sort_index()


def save_to_csv(df, output_dir: Path, code: str) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{code}.csv"
    df.to_csv(output_path, date_format="%Y-%m-%d")
    return output_path


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


def load_codes_from_master(
    master_path: Path, asset_types: list[str], offset: int, limit: int | None, exclude_codes: set[str] | None = None
) -> list[str]:
    """銘柄マスタCSV（master.csv）から、指定したasset_typeに絞って証券コードの一覧を返し、
    offset/limitで範囲を切り出す（大量銘柄を小分けに処理するためのバッチ指定）。
    listed（上場中）のみを対象とする。exclude_codes（上場廃止銘柄など）はoffset/limit切り出し前に除外する。
    """
    df = pd.read_csv(master_path, dtype=str)
    df = df[df["status"] == "listed"]
    if asset_types:
        df = df[df["asset_type"].isin(asset_types)]
    codes = df["code"].tolist()
    if exclude_codes:
        codes = [c for c in codes if c not in exclude_codes]

    if limit is not None:
        return codes[offset:offset + limit]
    return codes[offset:]


def main():
    parser = argparse.ArgumentParser(description="yfinanceで東証銘柄の日足終値を取得しCSV保存する")
    parser.add_argument("--codes", default=None, help="証券コード（カンマ区切りで複数指定可。例: 7203,9984,6758）。--master指定時は無視される")
    parser.add_argument("--master", default=None, help="銘柄マスタCSV（master.csv）のパス。指定時はこちらから証券コードを読み込む")
    parser.add_argument("--asset-types", default="内国株式,ETF・ETN", help="--master指定時、対象とするasset_type（カンマ区切り）")
    parser.add_argument("--exclude-file", default=None, help="除外する証券コード一覧CSV（code列。上場廃止銘柄など。--master指定時のみ有効）")
    parser.add_argument("--offset", type=int, default=0, help="--master指定時、対象銘柄一覧の何件目から処理するか（0始まり）")
    parser.add_argument("--limit", type=int, default=None, help="--master指定時、対象銘柄一覧を何件処理するか（省略時は末尾まで）")
    parser.add_argument("--start-date", default="2013-01-01", help="取得開始日（YYYY-MM-DD）。--period未指定時に使用")
    parser.add_argument("--period", default=None, help="相対期間指定（yfinance形式。例: 5d, 1mo）。指定時は--start-dateより優先")
    parser.add_argument(
        "--mode", choices=["full", "update"], default="full",
        help="full: --period/--start-dateに従って取得（既定）。"
             "update: 既存CSVがあればその最終日付の翌日〜今日のみ取得（--period/--start-dateは無視）。"
             "既存CSVが無い銘柄はどちらのモードでも--start-dateから全期間取得する",
    )
    parser.add_argument("--sleep", type=float, default=2.0, help="銘柄ごとの取得間隔（秒）。アクセス制限回避のため")
    parser.add_argument(
        "--output-dir",
        default="../../../brain_data/stock/prices",
        help="出力先ディレクトリ（ローカル動作確認用のデフォルトはデータリポジトリのstock/prices）",
    )
    args = parser.parse_args()

    if args.master:
        asset_types = [a.strip() for a in args.asset_types.split(",") if a.strip()]
        exclude_codes = load_excluded_codes(args.exclude_file)
        codes = load_codes_from_master(Path(args.master), asset_types, args.offset, args.limit, exclude_codes)
        if args.offset == 0:
            # 日経平均（N225）はmaster.csvに存在しない特殊ティッカーのため、bulk実行の先頭サブバッチ
            # （offset=0）にだけ追加する。以降のサブバッチ（offset>0）では追加しないため重複取得しない
            codes.append("N225")
    else:
        codes = [c.strip() for c in (args.codes or "").split(",") if c.strip()]

    if not codes:
        print("対象の証券コードが0件でした（--codes/--masterの指定を確認してください）", file=sys.stderr)
        sys.exit(1)

    print(f"対象: {len(codes)}銘柄（モード: {args.mode}）")

    output_dir = Path(args.output_dir)
    succeeded = 0
    skipped = 0
    failed = []
    for i, code in enumerate(codes):
        called_api = False
        try:
            existing_df = load_existing(output_dir, code)

            if args.mode == "update" and existing_df is not None and not existing_df.empty:
                last_date = existing_df.index.max()
                fetch_start = last_date + timedelta(days=1)
                if fetch_start.date() > datetime.now().date():
                    print(f"既に最新のためスキップしました（コード: {code}, 最終日付: {last_date.date()}）")
                    skipped += 1
                    continue
                new_df = fetch_close_prices(code, fetch_start.strftime("%Y-%m-%d"), None)
                called_api = True
            else:
                new_df = fetch_close_prices(code, args.start_date, args.period)
                called_api = True

            merged = merge_prices(existing_df, new_df)
            if merged is None or merged.empty:
                print(f"データが取得できませんでした（コード: {code}）", file=sys.stderr)
                failed.append(code)
            else:
                added = len(new_df) if new_df is not None else 0
                output_path = save_to_csv(merged, output_dir, code)
                print(f"保存しました: {output_path}（合計{len(merged)}件 / 差分{added}件）")
                succeeded += 1
        except Exception as e:
            # 1銘柄の例外（通信エラー・想定外のティッカー形式等）で全体を止めない
            print(f"エラーが発生しました（コード: {code}）: {e}", file=sys.stderr)
            failed.append(code)

        if called_api and i < len(codes) - 1:
            time.sleep(args.sleep)

    print(f"完了: 成功 {succeeded}件 / スキップ {skipped}件 / 失敗 {len(failed)}件")
    if failed:
        print(f"取得失敗: {', '.join(failed)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
