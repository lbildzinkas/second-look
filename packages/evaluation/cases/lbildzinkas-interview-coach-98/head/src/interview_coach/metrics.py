"""Search metrics, written by hand: how well a ranked list of ids finds the relevant ones.

Every metric takes the ranked ids (best first), the set of relevant ids and a cut-off k,
and scores one question. With no relevant ids every metric returns 0.0, so callers leave
such questions out of an average. The ranx docs give the same definitions in one place,
and tests/test_metrics.py checks these functions against ranx:
https://amenra.github.io/ranx/metrics/
"""

import math
from collections.abc import Collection, Sequence


def hit_at_k(ranked: Sequence[str], relevant: Collection[str], k: int) -> float:
    """1.0 if any relevant id is in the top k ("Hit Rate" in the ranx docs above)."""
    return 1.0 if _found(ranked, relevant, k) else 0.0


def recall_at_k(ranked: Sequence[str], relevant: Collection[str], k: int) -> float:
    """The share of the relevant ids found in the top k.

    Manning, Raghavan and Schütze, Introduction to Information Retrieval, section 8.3:
    https://nlp.stanford.edu/IR-book/html/htmledition/evaluation-of-unranked-retrieval-sets-1.html
    """
    if not relevant:
        return 0.0
    return _found(ranked, relevant, k) / len(relevant)


def all_evidence_at_k(ranked: Sequence[str], relevant: Collection[str], k: int) -> float:
    """1.0 only if every relevant id is in the top k: the strict form of recall@k.

    A QASPER answer can need several paragraphs together (Dasigi et al., 2021:
    https://arxiv.org/abs/2105.03011), so finding one of them is not enough to answer.
    """
    if not relevant:
        return 0.0
    return 1.0 if _found(ranked, relevant, k) == len(relevant) else 0.0


def precision_at_k(ranked: Sequence[str], relevant: Collection[str], k: int) -> float:
    """The share of the top k that is relevant, always divided by k (same IR book section)."""
    return _found(ranked, relevant, k) / k


def mrr_at_k(ranked: Sequence[str], relevant: Collection[str], k: int) -> float:
    """1 / the rank of the first relevant id, or 0.0 if none is in the top k.

    Averaged over questions this is the mean reciprocal rank, from the TREC-8 question
    answering track (Voorhees, 1999): https://trec.nist.gov/pubs/trec8/papers/qa_report.pdf
    """
    rank = next((rank for rank, id_ in enumerate(ranked[:k], start=1) if id_ in relevant), None)
    return 0.0 if rank is None else 1 / rank


def ndcg_at_k(ranked: Sequence[str], relevant: Collection[str], k: int) -> float:
    """DCG of the top k divided by the best DCG possible, with binary relevance.

    DCG = sum of rel_i / log2(i + 1) over ranks i = 1..k (Järvelin and Kekäläinen, 2002:
    https://doi.org/10.1145/582415.582418). With rel_i of 0 or 1, the graded gain
    2^rel - 1 gives the same numbers. The ideal list puts every relevant id first.
    """
    if not relevant:
        return 0.0
    dcg = sum(1 / math.log2(rank + 1) for rank, id_ in enumerate(ranked[:k], 1) if id_ in relevant)
    ideal = sum(1 / math.log2(rank + 1) for rank in range(1, min(len(relevant), k) + 1))
    return dcg / ideal


def _found(ranked: Sequence[str], relevant: Collection[str], k: int) -> int:
    """How many of the top k ids are relevant."""
    return sum(1 for id_ in ranked[:k] if id_ in relevant)
