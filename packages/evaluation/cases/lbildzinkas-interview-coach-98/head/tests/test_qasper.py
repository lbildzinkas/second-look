"""QASPER evidence mapping on a tiny hand-made paper; no network."""

from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from interview_coach import cli
from interview_coach.qasper import (
    ANSWERABLE,
    FIGURE_ONLY,
    NO_EVIDENCE,
    UNANSWERABLE,
    UNMAPPABLE,
    Question,
    extract_questions,
    format_stats,
    read_papers,
    split_paragraphs,
)

INTRO = "Transformers use attention. Attention weighs every token."
SETUP = "We train on the toy corpus for three epochs."
RESULTS = "The model reaches 90% accuracy on the toy test set."


def answer(*evidence: str, unanswerable: bool = False) -> dict[str, Any]:
    """One annotator's answer, shaped like a row of the dataset's `answers` field."""
    return {"unanswerable": unanswerable, "evidence": list(evidence)}


# Same nesting as one row of the Parquet file: https://huggingface.co/datasets/allenai/qasper
PAPER: dict[str, Any] = {
    "id": "0000.00001",
    "full_text": {
        "section_name": ["Introduction", "Experiments ::: Setup", None],
        "paragraphs": [[INTRO], [SETUP, RESULTS], []],
    },
    "qas": {
        "question_id": ["q-substring", "q-heading", "q-figure", "q-unanswerable", "q-unmapped"],
        "question": ["What is used?", "How long?", "Which table?", "Who funded it?", "What loss?"],
        "answers": [
            # Two annotators: a fragment of the intro and a whole paragraph (union kept).
            {"answer": [answer("Attention weighs every token."), answer(RESULTS)]},
            # A bare heading maps to no paragraph, so heading-only evidence is unmappable.
            {"answer": [answer("Setup")]},
            {"answer": [answer("FLOAT SELECTED: Table 1: Accuracy per epoch.")]},
            # Every annotator marks it unanswerable.
            {"answer": [answer(unanswerable=True), answer(unanswerable=True)]},
            {"answer": [answer("$$L = L_1 + L_2$$ (Eq. 1)")]},
        ],
    },
}


@pytest.fixture
def questions() -> dict[str, Question]:
    return {question.question_id: question for question in extract_questions(PAPER)}


def test_paragraphs_are_numbered_across_sections() -> None:
    paragraphs = split_paragraphs(PAPER)
    assert [paragraph.id for paragraph in paragraphs] == [
        "0000.00001:0",
        "0000.00001:1",
        "0000.00001:2",
    ]
    assert paragraphs[2].text == RESULTS
    assert paragraphs[2].section == "Experiments ::: Setup"


def test_substring_evidence_maps_to_its_paragraph_with_union_over_annotators(
    questions: dict[str, Question],
) -> None:
    question = questions["q-substring"]
    assert question.paper_id == "0000.00001"
    assert question.is_answerable
    assert question.evidence_paragraph_ids == {"0000.00001:0", "0000.00001:2"}
    assert question.category == ANSWERABLE


def test_heading_only_evidence_is_unmappable(questions: dict[str, Question]) -> None:
    question = questions["q-heading"]
    assert question.evidence_paragraph_ids == frozenset()
    assert question.unmapped_evidence == ("Setup",)
    assert question.category == UNMAPPABLE


def test_figure_only_evidence_maps_to_no_paragraph(questions: dict[str, Question]) -> None:
    question = questions["q-figure"]
    assert question.evidence_paragraph_ids == frozenset()
    assert question.category == FIGURE_ONLY


def test_unanswerable_question(questions: dict[str, Question]) -> None:
    question = questions["q-unanswerable"]
    assert not question.is_answerable
    assert question.category == UNANSWERABLE


def test_evidence_found_in_no_paragraph_is_unmappable(questions: dict[str, Question]) -> None:
    question = questions["q-unmapped"]
    assert question.unmapped_evidence == ("$$L = L_1 + L_2$$ (Eq. 1)",)
    assert question.category == UNMAPPABLE


def test_answer_with_no_evidence_has_its_own_category() -> None:
    paper = PAPER | {
        "qas": {"question_id": ["q"], "question": ["?"], "answers": [{"answer": [answer()]}]}
    }
    assert extract_questions(paper)[0].category == NO_EVIDENCE


def test_read_papers_returns_rows_as_written(tmp_path: Path) -> None:
    path = tmp_path / "0000.parquet"
    pq.write_table(pa.Table.from_pylist([PAPER]), path)
    assert extract_questions(read_papers(path)[0]) == extract_questions(PAPER)


def test_stats_command_prints_every_category(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(cli, "load_validation_questions", lambda: extract_questions(PAPER))
    assert cli.main(["qasper", "stats"]) == 0
    output = capsys.readouterr().out
    assert output == format_stats(extract_questions(PAPER)) + "\n"
    assert "QASPER dev split: 5 questions" in output
    assert f"  {ANSWERABLE}: 1" in output
    assert f"  {FIGURE_ONLY}: 1" in output
    assert f"  {UNANSWERABLE}: 1" in output
    assert f"  {UNMAPPABLE}: 2" in output
