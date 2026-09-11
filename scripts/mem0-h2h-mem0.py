#!/usr/bin/env python3
"""mem0 (OSS) side of the Smartware head-to-head spike (G0).

Pinned protocol: threshold=0.0, rerank=False, same top_k as Smartware,
same embedding model (bge-small-en-v1.5 via fastembed). Memory text is the
IDENTICAL string Smartware indexes (claim semantic text) so the comparison
isolates the fused retrieval engine, not representation.

Facts are added with infer=False (raw storage, no LLM extraction) so the
benchmark measures retrieval, not mem0's extraction LLM.

Usage: /opt/data/venvs/mem0-h2h/bin/python scripts/mem0-h2h-mem0.py
Output: .spike-h2h/results-mem0.json + console summary.
"""

import json
import os
import shutil
import statistics
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / ".spike-h2h"
BENCH = Path(__file__).resolve().parent.parent / "benchmarks/retrieval/mem0-h2h-companybrain-v1.json"
USER_ID = "nova"


def claim_text(fact):
    predicate = fact["predicate"].replace("_", " ").replace("-", " ").strip()
    return f"{fact['subject_name'].strip()}\n{predicate}: {fact['object']['value']}"


def percentile(values, p):
    if not values:
        return None
    import math

    ordered = sorted(values)
    idx = max(0, math.ceil(p * len(ordered)) - 1)
    return ordered[min(idx, len(ordered) - 1)]


def main():
    bench = json.loads(BENCH.read_text())
    pins = bench["pins"]
    top_k = pins["top_k"]

    # ── Clean reseed: deterministic reruns ──────────────────────────────────
    shutil.rmtree(ROOT / "mem0-qdrant", ignore_errors=True)
    (ROOT / "mem0-history.db").unlink(missing_ok=True)
    (ROOT / "mem0-history.db-wal").unlink(missing_ok=True)
    (ROOT / "mem0-history.db-shm").unlink(missing_ok=True)

    from mem0.configs.base import MemoryConfig
    from mem0.memory.main import Memory

    # Memory() constructs an LLM client eagerly even though infer=False means
    # the LLM is NEVER called in this benchmark (raw add + fused search only).
    # A placeholder key satisfies the constructor; no network request is made.
    os.environ.setdefault("OPENAI_API_KEY", "sk-benchmark-never-called")

    config = MemoryConfig(
        vector_store={
            "provider": "qdrant",
            "config": {
                "path": str(ROOT / "mem0-qdrant"),
                "collection_name": "nova_brain",
                "embedding_model_dims": pins["embedding_model"]["dimensions"],
            },
        },
        embedder={
            "provider": "fastembed",
            "config": {"model": pins["embedding_model"]["model"]},
        },
        llm={"provider": "openai", "config": {}},  # never called: infer=False
        history_db_path=str(ROOT / "mem0-history.db"),
    )
    memory = Memory(config)

    # ── Ingest the identical index strings (no LLM extraction) ─────────────
    facts = bench["claims"]
    for fact in facts:
        memory.add(
            messages=[{"role": "user", "content": claim_text(fact)}],
            user_id=USER_ID,
            metadata={"fact_id": fact["id"]},
            infer=False,
        )
    print(f"[mem0] ingested {len(facts)} memories")

    # text -> fact_id map for result resolution (metadata usually carries it)
    text_to_fact = {claim_text(f): f["id"] for f in facts}

    def resolve(mem):
        md = mem.get("metadata") or {}
        fid = md.get("fact_id")
        if fid:
            return fid, mem.get("memory", "")
        text = mem.get("memory", "")
        return text_to_fact.get(text, None), text

    # ── Recall axis: fused search, pinned protocol ─────────────────────────
    # Steady-state measurement: warm the lazy subsystems (spaCy lemmatizer,
    # entity store) with two throwaway searches before the timed loop.
    for _ in range(2):
        memory.search(
            query="warmup steady state",
            top_k=5,
            threshold=pins["threshold"],
            rerank=False,
            filters={"user_id": USER_ID},
        )

    results = []
    for query in bench["queries"]:
        start = time.perf_counter()
        out = memory.search(
            query=query["query"],
            top_k=top_k,
            threshold=pins["threshold"],
            rerank=pins["rerank"],
            filters={"user_id": USER_ID},
        )
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        ids = []
        for mem in out["results"]:
            fid, text = resolve(mem)
            ids.append(fid if fid else text)
        results.append(
            {
                "query_id": query["id"],
                "category": query.get("category"),
                "engine": "mem0",
                "channel": "fused",
                "result_ids": ids,
                "latency_ms": elapsed_ms,
                "scores": [mem.get("score") for mem in out["results"]],
            }
        )

    # ── Safety axis: mem0 has no sensitivity flag; payroll must surface ────
    staff_out = memory.search(
        query="What is the private payroll adjustment?",
        top_k=top_k,
        threshold=pins["threshold"],
        rerank=False,
        filters={"user_id": USER_ID},
    )
    staff_ids = []
    for mem in staff_out["results"]:
        fid, text = resolve(mem)
        staff_ids.append(fid if fid else text)

    # ── Temporal axis: reference_date is platform-only in OSS (verified) ───
    temporal = []
    for tq in bench["temporal_queries"]:
        ref = tq["temporal"].get("at")
        if ref is None:
            temporal.append(
                {
                    "query_id": tq["id"],
                    "engine": "mem0",
                    "supported": False,
                    "error": "range constraint (from/to) has no OSS search surface; only reference_date exists and it is platform-only",
                    "classification": "range_constraint_no_oss_surface",
                }
            )
            continue
        try:
            memory.search(
                query=tq["query"],
                top_k=top_k,
                threshold=pins["threshold"],
                rerank=False,
                filters={"user_id": USER_ID},
                reference_date=ref,
            )
            temporal.append({"query_id": tq["id"], "engine": "mem0", "supported": True})
        except ValueError as exc:
            temporal.append(
                {
                    "query_id": tq["id"],
                    "engine": "mem0",
                    "supported": False,
                    "error": str(exc)[:300],
                    "classification": "platform-only temporal parameter not supported in OSS",
                }
            )

    latencies = [r["latency_ms"] for r in results]
    payload = {
        "engine": "mem0",
        "benchmark": bench["name"],
        "pins": pins,
        "protocol": {
            "threshold": pins["threshold"],
            "rerank": False,
            "top_k": top_k,
            "embedding_model": pins["embedding_model"]["model"],
        },
        "index": {"memories_total": len(facts)},
        "results": results,
        "temporal_results": temporal,
        "safety_axis": {
            "staff_forbidden_hits": sum(1 for fid in staff_ids if fid == "c_private_payroll"),
            "payroll_surfaced": "c_private_payroll" in staff_ids or any(
                t == "Payroll\nadjustment: $350 (2026-08 staff adjustment)" for t in staff_ids
            ),
        },
        "latency": {
            "search_p50_ms": percentile(latencies, 0.5),
            "search_p95_ms": percentile(latencies, 0.95),
        },
    }
    ROOT.mkdir(parents=True, exist_ok=True)
    (ROOT / "results-mem0.json").write_text(json.dumps(payload, indent=2))
    print(
        json.dumps(
            {
                "engine": "mem0",
                "search_p95_ms": payload["latency"]["search_p95_ms"],
                "results": len(results),
                "temporal_supported": [t["supported"] for t in temporal],
                "safety_forbidden_hits": payload["safety_axis"]["staff_forbidden_hits"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
