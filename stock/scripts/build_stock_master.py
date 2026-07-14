"""
JPXが公開する「東証上場銘柄一覧」（data_j.xls形式）を読み込み、今後のスコア計算・属性管理で
扱いやすい形式のCSV（銘柄マスタ）に変換するスクリプト。

入力: data_j_*.xls（ユーザーが外部から取り込む生データ。既定の置き場所は
      ../../../brain_data/stock/input/listed_companies/）
出力: {output}（既定: ../../../brain_data/stock/master.csv。派生データなので入力の置き場所とは分離している）
列: id, code, name, market, segment, asset_type,
    industry33_code, industry33_name, industry17_code, industry17_name,
    scale_code, scale_name, status, source, as_of

将来の拡張について:
- 過去に上場廃止した銘柄を追加する場合は、status="delisted" の行を同じCSVへ追記していく想定
- コードを持たない米国投信等を追加する場合は、source列を "us_fund" 等に分けて管理する想定
- id列は現時点ではcodeをそのまま使っているが、証券コードは稀に別銘柄へ再利用されることがあるため、
  過去銘柄・削除銘柄を本格的に扱い始める際は、code非依存の連番ID等への切替を検討すること
"""
import argparse
import re
import sys
from pathlib import Path

import pandas as pd

SOURCE_COLUMNS = {
    "日付": "as_of_raw",
    "コード": "code",
    "銘柄名": "name",
    "市場・商品区分": "market",
    "33業種コード": "industry33_code",
    "33業種区分": "industry33_name",
    "17業種コード": "industry17_code",
    "17業種区分": "industry17_name",
    "規模コード": "scale_code",
    "規模区分": "scale_name",
}

OUTPUT_COLUMNS = [
    "id", "code", "name", "market", "segment", "asset_type",
    "industry33_code", "industry33_name",
    "industry17_code", "industry17_name",
    "scale_code", "scale_name",
    "status", "source", "as_of",
]

# 市場・商品区分は "プライム（内国株式）" のように「市場区分（資産種別）」の形式のものと、
# "ETF・ETN" のように資産種別のみのものが混在しているため、可能な範囲で分解する
SEGMENT_PATTERN = re.compile(r"^(プライム|スタンダード|グロース)（(.+)）$")


def load_source(path: Path) -> pd.DataFrame:
    df = pd.read_excel(path)
    missing = set(SOURCE_COLUMNS) - set(df.columns)
    if missing:
        raise ValueError(f"想定した列が見つかりません: {missing}（ファイル形式が変わった可能性があります）")
    return df.rename(columns=SOURCE_COLUMNS)


def parse_market(market: str) -> tuple[str, str]:
    """market文字列を (segment, asset_type) に分解する。例: 'プライム（内国株式）' -> ('プライム', '内国株式')"""
    m = SEGMENT_PATTERN.match(market)
    if m:
        return m.group(1), m.group(2)
    return "", market  # ETF・ETN, PRO Market, REIT等, 出資証券 などは市場区分の概念が無いためasset_typeのみ


def build_master(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()

    # "-"（業種・規模が未分類。ETF・REIT等）は空欄扱いにする
    for col in ["industry33_code", "industry33_name", "industry17_code", "industry17_name", "scale_code", "scale_name"]:
        df[col] = df[col].astype(str).replace("-", "")

    df["code"] = df["code"].astype(str)
    df["id"] = df["code"]  # 現時点ではcodeをそのままidに使う（将来コード無し銘柄を追加する際は別採番する）

    segments = df["market"].apply(parse_market)
    df["segment"]    = segments.apply(lambda t: t[0])
    df["asset_type"] = segments.apply(lambda t: t[1])

    df["status"] = "listed"
    df["source"] = "tse_data_j"
    df["as_of"]  = pd.to_datetime(df["as_of_raw"], format="%Y%m%d").dt.strftime("%Y-%m-%d")

    return df[OUTPUT_COLUMNS]


def main():
    parser = argparse.ArgumentParser(description="JPX上場銘柄一覧（data_j.xls）を銘柄マスタCSVに変換する")
    parser.add_argument("--input", required=True, help="変換元のExcelファイル（data_j_*.xls。通常は ../../../brain_data/stock/input/listed_companies/ 配下）")
    parser.add_argument("--output", default="../../../brain_data/stock/master.csv", help="出力先CSVパス")
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"入力ファイルが見つかりません: {input_path}", file=sys.stderr)
        sys.exit(1)

    df = load_source(input_path)
    master = build_master(df)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    master.to_csv(output_path, index=False)
    print(f"保存しました: {output_path}（{len(master)}件）")


if __name__ == "__main__":
    main()
