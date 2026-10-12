"""The hand-written search metrics: hand-computed examples, edge cases and a ranx check."""

import math

import pytest
from ranx import Qrels, Run, evaluate

from interview_coach.metrics import (
    all_evidence_at_k,
    hit_at_k,
    mrr_at_k,
    ndcg_at_k,
    precision_at_k,
    recall_at_k,
)

RANKED = ["a", "b", "c", "d", "e"]
# "x" is relevant but never retrieved, so recall can never reach 1.
RELEVANT = frozenset({"b", "d", "x"})
ALL_METRICS = [hit_at_k, recall_at_k, all_evidence_at_k, precision_at_k, mrr_at_k, ndcg_at_k]


def test_hit() -> None:
    assert hit_at_k(RANKED, RELEVANT, 1) == 0.0
    assert hit_at_k(RANKED, RELEVANT, 2) == 1.0


def test_recall() -> None:
    assert recall_at_k(RANKED, RELEVANT, 2) == pytest.approx(1 / 3)
    assert recall_at_k(RANKED, RELEVANT, 5) == pytest.approx(2 / 3)


def test_all_evidence() -> None:
    assert all_evidence_at_k(RANKED, RELEVANT, 5) == 0.0  # "x" is missing
    assert all_evidence_at_k(RANKED, {"b", "d"}, 3) == 0.0
    assert all_evidence_at_k(RANKED, {"b", "d"}, 4) == 1.0


def test_precision() -> None:
    assert precision_at_k(RANKED, RELEVANT, 2) == pytest.approx(1 / 2)
    assert precision_at_k(RANKED, RELEVANT, 5) == pytest.approx(2 / 5)
    # Fewer results than k still divides by k.
    assert precision_at_k(["b"], RELEVANT, 5) == pytest.approx(1 / 5)


def test_mrr() -> None:
    assert mrr_at_k(RANKED, RELEVANT, 1) == 0.0
    assert mrr_at_k(RANKED, RELEVANT, 5) == pytest.approx(1 / 2)


def test_ndcg() -> None:
    # Relevant at ranks 2 and 4; the ideal list has the three relevant ids at ranks 1-3.
    dcg = 1 / math.log2(3) + 1 / math.log2(5)
    ideal = 1 / math.log2(2) + 1 / math.log2(3) + 1 / math.log2(4)
    assert ndcg_at_k(RANKED, RELEVANT, 5) == pytest.approx(dcg / ideal)
    assert ndcg_at_k(["b", "d"], {"b", "d"}, 5) == pytest.approx(1.0)


@pytest.mark.parametrize("metric", ALL_METRICS)
def test_no_relevant_ids_scores_zero(metric) -> None:
    assert metric(RANKED, frozenset(), 5) == 0.0


@pytest.mark.parametrize("metric", ALL_METRICS)
def test_relevant_ids_outside_k_score_zero(metric) -> None:
    assert metric(RANKED, {"e"}, 4) == 0.0


def test_metrics_match_ranx_on_a_small_run() -> None:
    """ranx computes the same metrics independently: https://amenra.github.io/ranx/"""
    rankings = {
        "q1": ["a", "b", "c", "d", "e", "f"],
        "q2": ["f", "e", "d", "c", "b", "a"],
        "q3": ["c", "a", "f", "b", "e", "d"],
    }
    relevant = {"q1": {"b", "d"}, "q2": {"a"}, "q3": {"c", "e", "f"}}
    # ranx ranks by score, so the first id gets the highest score.
    run = Run({q: {id_: len(ids) - i for i, id_ in enumerate(ids)} for q, ids in rankings.items()})
    qrels = Qrels({q: dict.fromkeys(ids, 1) for q, ids in relevant.items()})
    ours = {
        "hit_rate": hit_at_k,
        "recall": recall_at_k,
        "precision": precision_at_k,
        "mrr": mrr_at_k,
        "ndcg": ndcg_at_k,
    }
    for k in (1, 3, 5):
        expected = evaluate(qrels, run, [f"{name}@{k}" for name in ours])
        assert isinstance(expected, dict)
        for name, metric in ours.items():
            mean = sum(metric(rankings[q], relevant[q], k) for q in rankings) / len(rankings)
            assert mean == pytest.approx(expected[f"{name}@{k}"]), f"{name}@{k}"
