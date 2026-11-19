"""`coach eval qasper` on a tiny hand-made paper; no network."""

from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pytest

from interview_coach import cli, search_eval
from interview_coach.qasper import Question, extract_questions
from interview_coach.search_eval import COLUMNS, evaluate, format_table, random_retriever

PARAGRAPHS = [f"Paragraph number {index}." for index in range(12)]

# Same nesting as one row of the Parquet file: https://huggingface.co/datasets/allenai/qasper
PAPER: dict[str, Any] = {
    "id": "p1",
    "full_text": {"section_name": ["Body"], "paragraphs": [PARAGRAPHS]},
    "qas": {
        "question_id": ["q-text", "q-unanswerable"],
        "question": ["Which number?", "Who funded it?"],
        "answers": [
            {"answer": [{"unanswerable": False, "evidence": [PARAGRAPHS[0], PARAGRAPHS[7]]}]},
            {"answer": [{"unanswerable": True, "evidence": []}]},
        ],
    },
}


def in_reading_order(question: Question, paragraph_ids: Sequence[str]) -> list[str]:
    return list(paragraph_ids)


def test_random_ranking_is_a_repeatable_shuffle_of_the_paper() -> None:
    question = extract_questions(PAPER)[0]
    ids = [f"p1:{index}" for index in range(12)]
    ranked = random_retriever(question, ids)
    assert sorted(ranked) == sorted(ids)
    assert ranked != ids
    assert random_retriever(question, ids) == ranked


def test_evaluate_scores_only_questions_with_text_evidence() -> None:
    # Reading order puts the evidence (paragraphs 0 and 7) at ranks 1 and 8.
    count, scores = evaluate([PAPER], in_reading_order)
    assert count == 1
    assert scores["hit@5"] == 1.0
    assert scores["recall@5"] == pytest.approx(1 / 2)
    assert scores["recall@10"] == 1.0
    assert scores["all-evidence@10"] == 1.0
    assert scores["precision@5"] == pytest.approx(1 / 5)
    assert scores["MRR@10"] == 1.0


def test_evaluate_with_no_scorable_question() -> None:
    paper = PAPER | {"qas": {"question_id": [], "question": [], "answers": []}}
    assert evaluate([paper], random_retriever) == (0, {name: 0.0 for name, _, _ in COLUMNS})


def test_eval_command_prints_the_random_row(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(search_eval, "download_validation", lambda cache_dir: Path("unused"))
    monkeypatch.setattr(search_eval, "read_papers", lambda path: [PAPER])
    assert cli.main(["eval", "qasper", "--retriever", "random"]) == 0
    output = capsys.readouterr().out
    assert output == format_table("random", *evaluate([PAPER], random_retriever)) + "\n"
    assert "QASPER dev split: 1 questions with text evidence" in output
    assert output.splitlines()[2].startswith("random  ")
