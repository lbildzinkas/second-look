"""The CLI: the happy path with an injected fake model, and the missing key."""

from pathlib import Path

import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage

from interview_coach.cli import main
from interview_coach.config import API_KEY_VAR


@pytest.fixture
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)  # no .env file to pick up
    monkeypatch.setenv(API_KEY_VAR, "test-key")  # fake key, never a real one


def test_ask_prints_the_answer_and_exits_zero(
    isolated: None, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = GenericFakeChatModel(messages=iter([AIMessage(content="An answer.")]))
    exit_code = main(["ask", "Any question?"], model_factory=lambda settings: fake)
    assert exit_code == 0
    assert capsys.readouterr().out.strip() == "An answer."


def test_missing_key_prints_a_readable_error_and_exits_non_zero(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv(API_KEY_VAR, raising=False)
    exit_code = main(["ask", "Any question?"])
    captured = capsys.readouterr()
    assert exit_code == 1
    assert API_KEY_VAR in captured.err
    assert ".env.example" in captured.err
    assert not captured.out
