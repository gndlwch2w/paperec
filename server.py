import asyncio
import json
from typing import Any

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from rank import rank_papers

app = FastAPI(title="Paperec")
app.add_middleware(
    CORSMiddleware,
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
    candidate: dict[str, PaperMeta] = Field(
        default_factory=dict,
        description="paper id to paper metadata, to be ranked",
    )
    corpus: dict[str, PaperMeta] = Field(
        default_factory=dict,
        description="paper id to paper metadata, to be used as corpus for ranking",
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
            candidate_meta = {
                str(k): (v.model_dump() if hasattr(v, "model_dump") else v)
                for k, v in body.candidate.items()
            }
            corpus_meta = {
                str(k): (v.model_dump() if hasattr(v, "model_dump") else v)
                for k, v in body.corpus.items()
            }

            def norm_paper(paper_id: str, paper: dict[str, Any]) -> dict[str, Any]:
                merged = {"id": paper_id, **paper}
                if not merged.get("abstract"):
                    merged["abstract"] = ""
                if not merged.get("date"):
                    merged["date"] = "1970-01-01T00:00:00Z"
                return merged

            candidate_ids_in_order: list[str] = []
            candidate: list[dict[str, Any]] = []
            for paper_id, meta in candidate_meta.items():
                if not isinstance(meta, dict):
                    continue
                candidate_ids_in_order.append(paper_id)
                candidate.append(norm_paper(paper_id, meta))

            if not candidate:
                yield await error_sse("No candidate papers found in request")
                return

            rated_corpus_ids: list[str] = [
                paper_id
                for paper_id, meta in corpus_meta.items()
                if isinstance(meta, dict)
                and isinstance(meta.get("rating"), int)
                and meta["rating"] > 0
            ]

            corpus: list[dict[str, Any]] = []
            for paper_id in rated_corpus_ids:
                meta = corpus_meta.get(paper_id)
                if isinstance(meta, dict):
                    corpus.append(norm_paper(paper_id, meta))

            if not corpus:
                yield await error_sse("No rated corpus papers found in request")
                return

            yield await progress_sse(
                "ranking",
                f"Ranking {len(candidate)} candidates using {len(corpus)} rated corpus papers",
            )

            loop = asyncio.get_running_loop()
            ranked_ids: list[str] = await loop.run_in_executor(
                None,
                lambda: rank_papers(candidate, corpus),
            )

            candidate_id_set = set(candidate_ids_in_order)
            normalized_ranked: list[str] = []
            ranked_seen: set[str] = set()
            for paper_id in ranked_ids:
                normalized = str(paper_id)
                if normalized in candidate_id_set and normalized not in ranked_seen:
                    ranked_seen.add(normalized)
                    normalized_ranked.append(normalized)

            # Ensure output covers all candidates, even if ranker omits some IDs.
            for paper_id in candidate_ids_in_order:
                if paper_id not in ranked_seen:
                    normalized_ranked.append(paper_id)

            yield await progress_sse(
                "ranked",
                f"Ranked {len(normalized_ranked)} candidate papers",
                ranked_ids=normalized_ranked,
            )
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
