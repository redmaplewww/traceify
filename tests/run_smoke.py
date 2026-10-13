from __future__ import annotations

import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "tests" / "source-manifest.json"


class TextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.active: list[str] = []
        self.buffer: list[str] = []
        self.headings: list[str] = []
        self.paragraphs: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6", "p"}:
            self.active.append(tag)
            self.buffer = []

    def handle_endtag(self, tag: str) -> None:
        if self.active and self.active[-1] == tag:
            value = " ".join("".join(self.buffer).split())
            if value:
                (self.headings if tag.startswith("h") else self.paragraphs).append(value)
            self.active.pop()
            self.buffer = []

    def handle_data(self, data: str) -> None:
        if self.active:
            self.buffer.append(data)


def fetch(url: str) -> str:
    request = Request(url, headers={"User-Agent": "Traceify-smoke-test/1.0"})
    with urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8", errors="replace")


def meta_description(html: str) -> str:
    match = re.search(
        r'<meta[^>]+(?:property|name)=["\'](?:og:description|description)["\'][^>]+content=["\']([^"\']+)',
        html,
        flags=re.I,
    )
    return match.group(1).strip() if match else ""


def main() -> int:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8-sig"))
    results = []
    for case in manifest["cases"]:
        html = fetch(case["source"])
        parser = TextParser()
        parser.feed(html)
        description = meta_description(html)
        if case["id"] == "tweet":
            units = 1 if description else 0
            paragraph_count = 1 if description else 0
            status = "PASS" if units == 1 else "FAIL"
        else:
            units = len(parser.paragraphs)
            paragraph_count = len(parser.paragraphs)
            status = "PASS" if units > 0 else "FAIL"
        results.append({
            "id": case["id"],
            "title": case["title"],
            "source": case["source"],
            "html_bytes": len(html.encode("utf-8")),
            "heading_count": len(parser.headings),
            "paragraph_count": paragraph_count,
            "content_units": units,
            "excerpt": (description or (parser.paragraphs[0] if parser.paragraphs else ""))[:180],
            "status": status,
        })
    print(json.dumps({"suite": manifest["suite"], "results": results}, ensure_ascii=False, indent=2))
    return 0 if all(item["status"] == "PASS" for item in results) else 1


if __name__ == "__main__":
    sys.exit(main())
