"""`coach eval qasper`: rank each paper's paragraphs per question and average the metrics.

Search runs within one paper at a time, as in the QASPER paper's evidence-selection
task (https://arxiv.org/abs/2105.03011): a question's candidates are the paragraphs of
the paper it was asked about. Only questions with text evidence mapped to paragraphs are
scored, because every metric needs at least one relevant paragraph.
"""

import random
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from interview_coach.metrics import (
    all_evidence_at_k,
    hit_at_k,
    mrr_at_k,
    ndcg_at_k,
    precision_at_k,
    recall_at_k,
)
from interview_coach.qasper import (
    ANSWERABLE,
    CACHE_DIR,
    Question,
    download_validation,
    extract_questions,
    read_papers,
    split_paragraphs,
)

# A retriever ranks a paper's paragraph ids (best first) for one question.
Retriever = Callable[[Question, Sequence[str]], list[str]]
Metric = Callable[[Sequence[str], frozenset[str], int], float]

# The columns of the printed row, in order: (name, metric, k).
COLUMNS: tuple[tuple[str, Metric, int], ...] = (
    ("hit@5", hit_at_k, 5),
    ("recall@5", recall_at_k, 5),
    ("recall@10", recall_at_k, 10),
    ("all-evidence@10", all_evidence_at_k, 10),
    ("precision@5", precision_at_k, 5),
    ("MRR@10", mrr_at_k, 10),
    ("nDCG@10", ndcg_at_k, 10),
)
SEED = 0


def random_retriever(question: Question, paragraph_ids: Sequence[str]) -> list[str]:
    """The floor every real retriever must beat: the paper's paragraphs in random order.

    Seeded per question, so each ranking is repeatable and does not depend on which
    questions ran before it. A str seed is hashed with SHA-512, the same on every run:
    https://docs.python.org/3/library/random.html#random.seed
    """
    rng = random.Random(f"{SEED}:{question.question_id}")
    return rng.sample(list(paragraph_ids), len(paragraph_ids))


RETRIEVERS: dict[str, Retriever] = {"random": random_retriever}


def evaluate(papers: list[dict[str, Any]], retriever: Retriever) -> tuple[int, dict[str, float]]:
    """The number of questions scored and each column's mean over them."""
    rows: list[list[float]] = []
    for paper in papers:
        paragraph_ids = [paragraph.id for paragraph in split_paragraphs(paper)]
        for question in extract_questions(paper):
            if question.category != ANSWERABLE:
                continue
            ranked = retriever(question, paragraph_ids)
            relevant = question.evidence_paragraph_ids
            rows.append([metric(ranked, relevant, k) for _, metric, k in COLUMNS])
    if not rows:
        return 0, {name: 0.0 for name, _, _ in COLUMNS}
    means = [sum(column) / len(rows) for column in zip(*rows, strict=True)]
    return len(rows), {name: mean for (name, _, _), mean in zip(COLUMNS, means, strict=True)}


def format_table(retriever_name: str, count: int, scores: dict[str, float]) -> str:
    names = [name for name, _, _ in COLUMNS]
    header = "retriever  " + "  ".join(names)
    cells = [f"{scores[name]:.3f}".ljust(len(name)) for name in names]
    row = retriever_name.ljust(len("retriever")) + "  " + "  ".join(cells)
    return f"QASPER dev split: {count} questions with text evidence\n{header}\n{row.rstrip()}"


def run_qasper_eval(retriever_name: str, cache_dir: Path = CACHE_DIR) -> str:
    papers = read_papers(download_validation(cache_dir))
    count, scores = evaluate(papers, RETRIEVERS[retriever_name])
    return format_table(retriever_name, count, scores)
