import httpx
from bs4 import BeautifulSoup

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}


async def crawl_venue(venue_url: str) -> list[dict]:
    """Fetch a papers.cool venue page and return a list of paper dicts."""
    async with httpx.AsyncClient(
        timeout=30, follow_redirects=True, headers=_HEADERS
    ) as client:
        resp = await client.get(venue_url)
        resp.raise_for_status()
        html = resp.text

    soup = BeautifulSoup(html, "html.parser")
    papers: list[dict] = []
    seen: set[str] = set()

    for div in soup.select("div.papers > div"):
        h2 = div.select_one("h2.title")
        if not h2:
            continue

        title_link = h2.select_one("a.title-link")
        if not title_link:
            continue

        paper_id = (title_link.get("id") or "").strip()  # type: ignore
        if not paper_id or paper_id in seen:
            continue
        seen.add(paper_id)

        title = title_link.get_text(strip=True)

        # External (non-papers.cool) link for the paper
        ext_href = next(
            (
                a["href"]
                for a in h2.find_all("a", href=True)
                if "papers.cool" not in a["href"] and not a["href"].startswith("#")  # type: ignore
            ),
            "",
        )

        authors = [
            a.get_text(strip=True) for a in div.select('a[href*="google.com/search"]')
        ]

        summary_el = div.select_one("p.summary")
        abstract = summary_el.get_text(strip=True) if summary_el else ""

        papers.append(
            {
                "id": paper_id,
                "title": title,
                "url": ext_href,
                "authors": authors,
                "abstract": abstract,
            }
        )

    return papers
