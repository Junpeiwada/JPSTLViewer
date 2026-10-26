#!/usr/bin/env python3
"""Markdown 仕様書に「目次」セクションを生成・更新するスクリプト。

- 「## 変更履歴」セクションがあれば、その直後に「## 目次」を挿入する。
- 「## 変更履歴」が無い場合は、「# タイトル」（最初の H1）の直後に挿入する。
- すでに「## 目次」があれば、その内容を作り直す（再生成）。
- 目次に含める見出しは `#`（H1の章）〜 `###`（H3）。ただし文書タイトル（最初に現れる H1）と
  `####` 以下は対象外。インデントは「実際に含まれる最も浅いレベル」を基準にするため、
  章（H1）を持たず H2 始まりの文書はタイトル除外後 H2 がトップ＝従来と同じ出力になる。
- 「## 変更履歴」「## 目次」自身は目次に含めない。
- コードフェンス（``` で囲まれた範囲）内の行は見出しとみなさない。
- アンカーは GitHub(.com) 方式に合わせて生成する（既存バック目次と一致を確認済み）。
  同名見出しが複数あるときは GitHub と同様に 2 個目以降へ `-1`,`-2`… を付ける。

依存: 標準ライブラリのみ（venv 不要）。

使い方:
    python3 Tools/GenDocsToc/gen_toc.py Docs/仕様書/PIDW410-引上処理-フロント.md
    python3 Tools/GenDocsToc/gen_toc.py Docs/仕様書/PIDW4*0-*.md   # 複数可
    python3 Tools/GenDocsToc/gen_toc.py --dry-run <files...>        # 書き込まず差分確認
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# 目次に含める見出しレベル（# 章 〜 ### 小見出し）。
# 文書タイトル（最初に現れる H1）は collect_headings 側で別途除外する。
MIN_LEVEL = 1
MAX_LEVEL = 3

# 目次から除外する見出しテキスト
EXCLUDE_HEADINGS = {"変更履歴", "目次"}

CODE_FENCE = re.compile(r"^\s*(```|~~~)")
HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")


def make_anchor(text: str) -> str:
    """GitHub(.com) 方式の見出しアンカーを生成する。

    手順: 小文字化 → 空白をハイフン化 → 英数字/アンダースコア/ハイフン/日本語(かな・カナ・
    漢字・長音・繰り返し記号)以外を除去 → 中点「・」を除去。
    アンダースコア「_」は GitHub の slugger が保持するので残す（除去すると `registry_local`
    のような識別子を含む見出しのアンカーが本番とずれてリンク切れになる）。
    繰り返し記号「々」(U+3005) など(〆〇)は Unicode 上「字」扱いで GitHub も保持するため残す
    （CJK記号・句読点ブロックにあり漢字範囲(4E00-)から外れるので、明示しないと落ちてずれる）。
    """
    s = text.strip().lower().replace(" ", "-")
    # 残す文字: 0-9 a-z _ - 々〆〇(CJK字扱い記号 3005-3007) ひらがな(3040-309F)
    # カタカナ(30A0-30FF) CJK統合漢字(4E00-9FFF)
    s = re.sub(r"[^0-9a-z_\-々〆〇぀-ゟ゠-ヿ一-鿿]", "", s)
    s = s.replace("・", "")  # 中点「・」を除去（カタカナ範囲に含まれるため最後に落とす）
    return s


def collect_headings(lines: list[str]) -> list[tuple[int, str]]:
    """(レベル, 見出しテキスト) の一覧を返す。コードフェンス内は除外。

    文書タイトル（最初に現れる H1）は目次に含めない。2 個目以降の H1 は「章」とみなして含める
    （テスト仕様書のように `# 1. …` を章に使う文書に対応）。
    """
    out: list[tuple[int, str]] = []
    in_fence = False
    title_skipped = False
    for line in lines:
        if CODE_FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = HEADING.match(line)
        if not m:
            continue
        level = len(m.group(1))
        text = m.group(2).strip()
        if level < MIN_LEVEL or level > MAX_LEVEL:
            continue
        if text in EXCLUDE_HEADINGS:
            continue
        # 文書タイトル（最初の H1）は目次に出さない
        if level == 1 and not title_skipped:
            title_skipped = True
            continue
        out.append((level, text))
    return out


def build_toc(headings: list[tuple[int, str]]) -> list[str]:
    """目次本体（`## 目次` 見出し＋箇条書き）の行リストを返す（末尾に空行は付けない）。

    - インデントは「実際に含まれる最も浅いレベル」を基準にする（章を持たない H2 始まりの
      文書では H2 がトップ＝従来どおり、章を持つ文書では H1 がトップになる）。
    - 同名見出しのアンカーは GitHub 同様に 2 個目以降へ `-1`,`-2`… を付けて衝突を避ける。
    """
    body: list[str] = ["## 目次", ""]
    if not headings:
        return body
    base_level = min(level for level, _ in headings)
    seen: dict[str, int] = {}
    for level, text in headings:
        indent = "  " * (level - base_level)
        base = make_anchor(text)
        n = seen.get(base, 0)
        seen[base] = n + 1
        anchor = base if n == 0 else f"{base}-{n}"
        body.append(f"{indent}- [{text}](#{anchor})")
    return body


def find_heading_index(lines: list[str], heading_text: str) -> int | None:
    """`## {heading_text}` 見出しの行 index を返す。コードフェンス内は無視。"""
    in_fence = False
    for i, line in enumerate(lines):
        if CODE_FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = HEADING.match(line)
        if m and len(m.group(1)) == 2 and m.group(2).strip() == heading_text:
            return i
    return None


def find_title_index(lines: list[str]) -> int | None:
    """`# タイトル`（最初に現れる H1）見出しの行 index を返す。コードフェンス内は無視。"""
    in_fence = False
    for i, line in enumerate(lines):
        if CODE_FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = HEADING.match(line)
        if m and len(m.group(1)) == 1:
            return i
    return None


def find_section_end(lines: list[str], start: int) -> int:
    """`## ...` 見出し（start 行）のセクション終端 index（次の ## 見出しの行）を返す。

    本文を含むセクションの範囲取得用。次の同レベル以上（##）見出しまで。
    """
    in_fence = False
    for i in range(start + 1, len(lines)):
        if CODE_FENCE.match(lines[i]):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = HEADING.match(lines[i])
        if m and len(m.group(1)) <= 2:
            return i
    return len(lines)


# 目次の箇条書き行（- [text](#anchor) 形式。インデント可）
TOC_ITEM = re.compile(r"^\s*-\s+\[.*\]\(#.*\)\s*$")


def find_toc_range(lines: list[str]) -> tuple[int, int] | None:
    """既存「## 目次」ブロックの [開始index, 終了index) を返す。

    終端は「`## 目次` 見出し → 続く目次箇条書き・空行」が途切れた最初の行。
    本文を巻き込まないよう、見出しではなく目次行の連続で判定する
    （目次直後に `---` 区切りが無いファイルでも本文を飲み込まない）。
    見つからなければ None。
    """
    start = find_heading_index(lines, "目次")
    if start is None:
        return None
    i = start + 1
    last_item = start  # 最後に見た目次箇条書き行
    while i < len(lines):
        line = lines[i]
        if line.strip() == "":
            i += 1
            continue
        if TOC_ITEM.match(line):
            last_item = i
            i += 1
            continue
        # 目次箇条書きでも空行でもない行が来たら、そこで目次ブロック終了
        break
    return (start, last_item + 1)


def process_file(path: Path, dry_run: bool) -> bool:
    text = path.read_text(encoding="utf-8")
    lines = text.split("\n")

    headings = collect_headings(lines)
    toc_lines = build_toc(headings)

    # 既存「## 目次」があれば、その目次ブロックだけを置換（本文は巻き込まない）。
    toc_range = find_toc_range(lines)
    if toc_range is not None:
        s, e = toc_range
        # 目次本体の後ろに空行1つを置く（既存の後続が空行ならそれを使い、二重空行を防ぐ）。
        tail = lines[e:]
        sep = [] if (tail and tail[0].strip() == "") else [""]
        new_lines = lines[:s] + toc_lines + sep + tail
        action = "regenerated"
    else:
        hist_start = find_heading_index(lines, "変更履歴")
        if hist_start is not None:
            # 「## 変更履歴」セクションの末尾（次の ## 見出し直前）に、目次→`---` の順で挿入。
            insert_at = find_section_end(lines, hist_start)
            new_lines = lines[:insert_at] + toc_lines + ["", "---", ""] + lines[insert_at:]
        else:
            # 「## 変更履歴」が無い場合は「# タイトル」行の直後に `---`目次`---` の順で挿入。
            title_idx = find_title_index(lines)
            if title_idx is None:
                print(
                    f"  [SKIP] {path.name}: 「## 変更履歴」も「# タイトル」も見つかりません",
                    file=sys.stderr,
                )
                return False
            insert_at = title_idx + 1
            new_lines = (
                lines[:insert_at]
                + ["", "---", ""]
                + toc_lines
                + ["", "---", ""]
                + lines[insert_at:]
            )
        action = "inserted"

    new_text = "\n".join(new_lines)
    if new_text == text:
        print(f"  [NOCHANGE] {path.name}")
        return False

    if dry_run:
        print(f"  [{action} DRY] {path.name}（{len(headings)} 見出し）")
    else:
        path.write_text(new_text, encoding="utf-8")
        print(f"  [{action}] {path.name}（{len(headings)} 見出し）")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="Markdown 仕様書に目次を生成・更新する")
    ap.add_argument("files", nargs="+", help="対象 .md ファイル（複数可）")
    ap.add_argument("--dry-run", action="store_true", help="書き込まず結果のみ表示")
    args = ap.parse_args()

    for f in args.files:
        p = Path(f)
        if not p.exists():
            print(f"  [SKIP] {f}: ファイルが存在しません", file=sys.stderr)
            continue
        process_file(p, args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
