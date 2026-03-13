import asyncio
import json
from typing import Any

import httpx
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from rank import rank_papers
from venue import crawl_venue

app = FastAPI(title="Paperec")

app.add_middleware(
    CORSMiddleware,
    # papers.cool is HTTPS; modern Chrome allows fetch() to localhost from HTTPS.
    # If you hit mixed-content errors, either run behind a TLS reverse proxy or
    # install a local CA cert and serve with --ssl-*.
    allow_origins=["https://papers.cool", "http://localhost", "http://127.0.0.1"],
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


class PaperMeta(BaseModel):
    title: str = ""
    url: str = ""
    authors: list[str] = []
    abstract: str = ""
    date: str = ""
    rating: int | None = None


class RankRequest(BaseModel):
    venue_url: str = Field(
        ...,
        description="Full URL of the papers.cool venue page",
    )
    meta: dict[str, PaperMeta] = Field(
        default_factory=dict,
        description="paper id to paper metadata",
    )


@app.post("/rank")
async def rank_endpoint(body: RankRequest):
    async def sse(event: str, data: Any) -> str:
        return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

    async def progress_sse(step: str, msg: str, **kwargs) -> str:
        return await sse("progress", {"step": step, "msg": msg, **kwargs})

    async def error_sse(msg: str, **kwargs) -> str:
        return await sse("error", {"msg": msg, **kwargs})

    async def stream():
        try:
            yield await progress_sse("crawling", "Crawling venue page")
            papers = await crawl_venue(body.venue_url)
            if not papers:
                yield await error_sse(f"No papers found at {body.venue_url}")
                return

            yield await progress_sse("crawled", f"Crawled {len(papers)} papers")

            def norm_paper(
                paper_id: str,
                paper: dict[str, Any],
            ) -> dict[str, Any]:
                merged = {"id": paper_id, **paper}
                if not merged.get("abstract"):
                    merged["abstract"] = ""
                if not merged.get("date"):
                    merged["date"] = "1970-01-01T00:00:00Z"
                return merged

            candidate: list[dict[str, Any]] = [
                norm_paper(str(paper["id"]), paper)
                for paper in papers
                if isinstance(paper, dict) and paper.get("id")
            ]
            crawled_map: dict[str, dict[str, Any]] = {
                str(paper["id"]): paper for paper in candidate
            }

            yield await progress_sse("ranking", "Ranking papers")
            rated_meta = {
                k: (v.model_dump() if hasattr(v, "model_dump") else v)
                for k, v in body.meta.items()
            }
            rated_ids: set[str] = {
                paper_id
                for paper_id, meta in rated_meta.items()
                if isinstance(meta, dict)
                and isinstance(meta.get("rating"), int)
                and meta["rating"] > 0
            }

            corpus: list[dict[str, Any]] = []
            for paper_id in rated_ids:
                merged: dict[str, Any] = {}
                crawled_paper = crawled_map.get(paper_id)
                if crawled_paper is not None:
                    merged.update(crawled_paper)
                meta = rated_meta.get(paper_id)
                if isinstance(meta, dict):
                    merged.update(meta)
                if merged:
                    corpus.append(norm_paper(paper_id, merged))

            if not corpus:
                yield await error_sse("No rated papers found in request")
                return

            loop = asyncio.get_running_loop()
            ranked_ids: list[str] = await loop.run_in_executor(
                None,
                lambda: rank_papers(candidate, corpus),
            )
            yield await progress_sse(
                "ranked",
                f"Ranked {len(ranked_ids)} papers",
                ranked_ids=ranked_ids,
            )
        except httpx.HTTPStatusError as exc:
            code = exc.response.status_code
            yield await error_sse(f"HTTP {code}: {body.venue_url}")
        except Exception as exc:
            yield await error_sse(f"Unexpected error: {str(exc)}")

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=8765,
        reload=True,
        ssl_keyfile="key.pem",
        ssl_certfile="cert.pem",
    )
