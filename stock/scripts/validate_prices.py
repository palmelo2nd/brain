"""
株価CSV（stock/prices/{code}.csv）のデータ品質チェックを行うスクリプト。
yfinance側のアクセス制限・通信エラー等により、一部の期間が欠損したまま
保存されていないかを検出する。

チェック項目:
1. 終値が空の行が無いか（行はあるが値が欠けているケース）
2. 重複した日付が無いか
3. 日付が昇順に並んでいるか
4. N225（日経平均。実際の取引日カレンダーの代わりに使う）と突き合わせて、
   取引があった日なのにこの銘柄のデータが無い日が無いか（行そのものが欠けているケース）

「最終更新日が古すぎないか」のチェックは行わない（[4.1]「更新最終日」側の日付問題と
観点が重複するため、2026-08-17にこちらから除外した）。

旧実装は「連続する行の間隔が◯日を超えたら異常」という日数閾値の推測で欠損を検出していたが、
ゴールデンウィーク等の正当な連休も一律に引っかかっていた。N225自体も同じ理由で休場するため、
「N225にはデータがあるのに、この銘柄には無い日」だけを抽出すれば、正当な休場は自動的に除外できる。

--exclude-file で指定した証券コード（stock/delisted.csv想定）は検証対象から除外する。

--report を指定すると、結果をJSON形式でも書き出す（アプリのフロントエンドから読み込んで表示する用途）。
"""
import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import pandas as pd


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


def load_reference_dates(n225_path: Path) -> set:
    """N225.csvの日付集合を、実際の取引日カレンダーの代わりとして返す。
    ファイルが無ければ（未取得の場合）空setを返し、呼び出し側でチェックをスキップできるようにする。
    """
    if not n225_path.exists():
        return set()
    df = pd.read_csv(n225_path, usecols=["date"], parse_dates=["date"])
    return set(df["date"].dt.date)


def validate_file(path: Path, reference_dates: set) -> list[dict]:
    """1銘柄分のCSVを検証し、問題点の辞書（code, type, detail）のリストを返す（問題が無ければ空リスト）。"""
    code = path.stem
    df = pd.read_csv(path, parse_dates=["date"])

    if df.empty:
        return [{"code": code, "type": "empty", "detail": "ファイルが空です"}]

    issues = []

    missing = df[df["close"].isna()]
    if not missing.empty:
        missing_close_dates = sorted(d.strftime("%Y-%m-%d") for d in missing["date"].dt.date)
        issues.append({
            "code": code, "type": "missing_close",
            "detail": f"終値が空の行が{len(missing)}件あります（例: {missing['date'].iloc[0].date()}）",
            "dates": missing_close_dates,
        })

    dup = df[df["date"].duplicated()]
    if not dup.empty:
        dup_dates = sorted(d.strftime("%Y-%m-%d") for d in dup["date"].dt.date)
        issues.append({
            "code": code, "type": "duplicate_date",
            "detail": f"重複した日付が{len(dup)}件あります（例: {dup['date'].iloc[0].date()}）",
            "dates": dup_dates,
        })

    if not df["date"].is_monotonic_increasing:
        issues.append({"code": code, "type": "unsorted", "detail": "日付が昇順に並んでいません"})

    # N225と突き合わせ、この銘柄が保有するデータ期間（最初〜最後の日付）の範囲内で、
    # N225には取引日として存在するのにこの銘柄には行自体が無い日を欠損として検出する
    if reference_dates:
        code_dates = set(df["date"].dt.date)
        if code_dates:
            first, last = min(code_dates), max(code_dates)
            expected = {d for d in reference_dates if first <= d <= last}
            missing_dates = sorted(expected - code_dates)
            if missing_dates:
                issues.append({
                    "code": code, "type": "missing_date",
                    "detail": f"N225の取引日のうち{len(missing_dates)}日分のデータがありません（例: {missing_dates[0]}）",
                    "dates": [d.strftime("%Y-%m-%d") for d in missing_dates],
                })

    return issues


def main():
    parser = argparse.ArgumentParser(description="株価CSVのデータ品質チェック（欠損検出）")
    parser.add_argument("--dir", default="../../../brain_data/stock/prices", help="検証対象のCSVが入ったディレクトリ")
    parser.add_argument("--codes", default=None, help="検証対象の証券コード（カンマ区切り。省略時はディレクトリ内の全CSVを検証）")
    parser.add_argument("--exclude-file", default=None, help="除外する証券コード一覧CSV（code列。上場廃止銘柄など）")
    parser.add_argument(
        "--n225-path", default=None,
        help="取引日カレンダーとして使うN225.csvのパス（省略時は--dir配下のN225.csv）",
    )
    parser.add_argument("--report", default=None, help="検証結果をJSON形式で書き出すファイルパス（省略時は書き出さない）")
    args = parser.parse_args()

    exclude_codes = load_excluded_codes(args.exclude_file)

    target_dir = Path(args.dir)
    if args.codes:
        files = [target_dir / f"{c.strip()}.csv" for c in args.codes.split(",") if c.strip() and c.strip() not in exclude_codes]
    else:
        files = sorted(f for f in target_dir.glob("*.csv") if f.stem not in exclude_codes)

    if not files:
        print(f"検証対象のCSVが見つかりませんでした: {target_dir}", file=sys.stderr)
        sys.exit(1)

    n225_path = Path(args.n225_path) if args.n225_path else target_dir / "N225.csv"
    reference_dates = load_reference_dates(n225_path)
    if not reference_dates:
        print(f"[WARN] N225の取引日カレンダーが読み込めませんでした（{n225_path}）。missing_dateチェックはスキップします", file=sys.stderr)

    all_issues = []
    for path in files:
        if not path.exists():
            all_issues.append({"code": path.stem, "type": "file_not_found", "detail": f"ファイルが見つかりません: {path}"})
            continue
        all_issues.extend(validate_file(path, reference_dates))

    if args.report:
        report = {
            "checked_at": datetime.now().isoformat(timespec="seconds"),
            "total_files": len(files),
            "issue_count": len(all_issues),
            "issues": all_issues,
        }
        report_path = Path(args.report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        print(f"レポートを保存しました: {report_path}")

    if all_issues:
        print(f"問題が {len(all_issues)} 件見つかりました（{len(files)}銘柄中）:")
        for issue in all_issues:
            print(f"  - [{issue['code']}] {issue['detail']}")
        sys.exit(1)

    print(f"問題なし（{len(files)}銘柄をチェックしました）")


if __name__ == "__main__":
    main()
