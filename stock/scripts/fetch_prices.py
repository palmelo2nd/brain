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

--master指定時、--extra-targets-file（stock/extra_targets.csv想定）で指定した銘柄も、master.csv
由来の対象に合流させて継続的に差分更新できる（N225のような指数や、master.csvにまだ反映されていない
新規上場銘柄など、「master.csvには無いが継続更新したい」対象を人が登録する）。

当日（JST基準）分は、取引時間中の途中価格を確定値として保存してしまわないよう、常に除外する
（前営業日以前の確定済みデータのみ保存し、当日分は翌日以降の実行で自然に取得し直す）。
"""
import argparse
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

JST = timezone(timedelta(hours=9))

# 東証上場銘柄はyfinance（Yahoo Finance）上でこのサフィックスを付けたティッカーになる
TSE_SUFFIX = ".T"

# 個別銘柄コードではなく指数のティッカー特例（--codesに"N225"と指定するとこちらを使う）。
# --extra-targets-fileのyf_ticker列で同じコードに上書き指定があれば、そちらを優先する
# （このハードコードはextra_targets.csv未登録でもN225が動くようにするための既定値）
INDEX_TICKERS = {"N225": "^N225"}  # 日経平均株価


def code_to_ticker(code: str, ticker_overrides: dict[str, str] | None = None) -> str:
    """証券コードをyfinanceのティッカーに変換する。
    ticker_overrides（--extra-targets-fileのyf_ticker列由来）→ INDEX_TICKERS（既定の特例）→
    通常銘柄（{code}.T）の優先順で解決する。
    """
    key = code.upper()
    if ticker_overrides and ticker_overrides.get(key):
        return ticker_overrides[key]
    special = INDEX_TICKERS.get(key)
    return special if special else f"{code}{TSE_SUFFIX}"


def fetch_close_prices(code: str, start_date: str, period: str | None, ticker_overrides: dict[str, str] | None = None):
    """指定した証券コードの日足終値をDataFrameで返す（列: close、インデックス: 日付）。
    period が指定されていればそちらを優先し、無ければ start_date 以降の全期間を取得する。
    """
    ticker = code_to_ticker(code, ticker_overrides)
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

    # 取引時間中に実行すると、当日分は確定した終値ではなく実行時点の途中価格が返ってくる。
    # これを保存すると、次回以降のupdateモード（最終日の翌日から取得）では当日が再取得対象に
    # ならず、途中価格のまま永久に残ってしまう。そのため当日（JST基準）の行は常に除外し、
    # 確定済みの前営業日以前のみ保存する（翌日以降の実行で自然に取得し直される）。
    today_jst = datetime.now(JST).date()
    closes = closes[closes.index.date < today_jst]

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


def load_extra_targets(extra_targets_file: str | None) -> tuple[list[str], dict[str, str]]:
    """追加対象銘柄一覧CSV（code, yf_ticker, note, updated_at列。stock/extra_targets.csv想定）を読み込み、
    (コードのリスト, コード→yfinanceティッカー上書きの辞書（yf_ticker空欄のものは含めない）) を返す。
    パス未指定・ファイル未作成（まだ1件も登録されていない）の場合は空のリスト・辞書を返す。
    """
    if not extra_targets_file:
        return [], {}
    path = Path(extra_targets_file)
    if not path.exists():
        return [], {}
    df = pd.read_csv(path, dtype=str)
    if "code" not in df.columns:
        return [], {}
    codes = df["code"].dropna().astype(str).str.strip().tolist()
    overrides = {}
    if "yf_ticker" in df.columns:
        for _, row in df.iterrows():
            code = str(row["code"]).strip()
            ticker = row.get("yf_ticker")
            if code and isinstance(ticker, str) and ticker.strip():
                overrides[code.upper()] = ticker.strip()
    return codes, overrides


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
    parser.add_argument(
        "--extra-targets-file", default=None,
        help="master.csvには無いが継続更新したい追加対象CSV（code, yf_ticker列。N225や未反映の新規上場銘柄など）。"
             "--master指定時はoffset=0のサブバッチにのみ合流させる（重複取得防止）。ティッカー上書きは--codes指定時にも適用する",
    )
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

    extra_target_codes, ticker_overrides = load_extra_targets(args.extra_targets_file)

    if args.master:
        asset_types = [a.strip() for a in args.asset_types.split(",") if a.strip()]
        exclude_codes = load_excluded_codes(args.exclude_file)
        codes = load_codes_from_master(Path(args.master), asset_types, args.offset, args.limit, exclude_codes)
        if args.offset == 0 and extra_target_codes:
            # extra_targets.csv（N225や未反映の新規上場銘柄など）はmaster.csvに存在しないため、
            # bulk実行の先頭サブバッチ（offset=0）にだけ合流させる。以降のサブバッチ（offset>0）では
            # 合流させないため重複取得しない。master.csv側に既に反映済み（重複登録）のコードは
            # 除外して二重取得を防ぐ（dict.fromkeysで順序を保ったまま重複除去）
            codes = list(dict.fromkeys(codes + extra_target_codes))
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
                new_df = fetch_close_prices(code, fetch_start.strftime("%Y-%m-%d"), None, ticker_overrides)
                called_api = True
            else:
                new_df = fetch_close_prices(code, args.start_date, args.period, ticker_overrides)
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
