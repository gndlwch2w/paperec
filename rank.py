import hashlib
import os
import os.path as osp
from datetime import datetime

import numpy as np
from huggingface_hub import snapshot_download
from sentence_transformers import SentenceTransformer

PAPEREC_MODEL_HOME = os.getenv(
    "PAPEREC_MODEL_HOME",
    osp.join(osp.dirname(__file__), "models"),
)
PAPEREC_CACHE_HOME = os.getenv(
    "PAPEREC_CACHE_HOME",
    osp.join(osp.dirname(__file__), "cache"),
)


def encode_embedding(
    encoder: SentenceTransformer,
    text: str,
    cache_id: str | None = None,
) -> np.ndarray:
    if cache_id is not None:
        embed_cache = osp.join(PAPEREC_CACHE_HOME, "embed", f"{cache_id}.npy")
        os.makedirs(osp.dirname(embed_cache), exist_ok=True)
        if osp.exists(embed_cache):
            return np.load(embed_cache)

    embed = encoder.encode(text)
    if cache_id is not None:
        np.save(embed_cache, embed)  # type: ignore
    return embed  # type: ignore


def generate_cache_id(model: str, paper: dict) -> str | None:
    for key in ("id",):
        value = paper.get(key)
        if value is not None:
            cache_key = f"{model}:{value}"
            return hashlib.sha1(cache_key.encode("utf-8")).hexdigest()
    return None


# fmt: off
def rerank_paper_by_date(
    candidate: list[dict],
    corpus: list[dict],
    model: str = "avsolatorio/GIST-small-Embedding-v0",
) -> list[str]:
    local_model = osp.join(PAPEREC_MODEL_HOME, model.split("/")[-1])
    if not osp.exists(local_model):
        snapshot_download(
            repo_id=model,
            local_dir=local_model,
            local_dir_use_symlinks=False,
        )
    encoder = SentenceTransformer(local_model)

    def encode_papers(papers: list[dict]) -> np.ndarray:
        if not papers:
            embedding_dimension = encoder.get_sentence_embedding_dimension() or 0
            return np.empty((0, embedding_dimension))
        return np.stack([
            encode_embedding(
                encoder, 
                paper["abstract"], 
                cache_id=generate_cache_id(model, paper),
            ) for paper in papers
        ])  

    # sort corpus by date, from newest to oldest
    corpus = sorted(
        corpus,
        key=lambda x: datetime.strptime(x["date"], "%Y-%m-%dT%H:%M:%SZ"),
        reverse=True,
    )
    time_decay_weight = 1 / (1 + np.log10(np.arange(len(corpus)) + 1))
    time_decay_weight = time_decay_weight / time_decay_weight.sum()

    corpus_feature = encode_papers(corpus)
    candidate_feature = encode_papers(candidate)
    sim = encoder.similarity(candidate_feature, corpus_feature)  # [n_candidate, n_corpus]

    scores = (sim * time_decay_weight).sum(axis=1) * 10  # [n_candidate]
    for s, c in zip(scores, candidate):
        c["score"] = s.item()
    candidate = sorted(candidate, key=lambda x: x["score"], reverse=True)
    return list(map(lambda x: x["id"], candidate))
# fmt: on

rank_papers = rerank_paper_by_date
