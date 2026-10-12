"""The sources list schema, and the downloader against a local fake source (no network)."""

from pathlib import Path
from typing import Any

import pytest
import yaml
from pydantic import ValidationError

from interview_coach.cli import main
from interview_coach.config import API_KEY_VAR
from interview_coach.study_material import (
    STAMP_FILE,
    Source,
    SourcesList,
    download_source,
    load_sources,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
COMMIT = "0123456789abcdef0123456789abcdef01234567"
FILES = {"README.md": "# Primer\n", "decks/OO Design.apkg": "deck bytes"}


def source_data(**overrides: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "name": "fake-source",
        "repository": "https://example.com/fake",
        "commit": COMMIT,
        "licence": "MIT",
        "local_only": False,
        "download_url": "https://example.com/{commit}/{path}",
        "files": ["README.md"],
    }
    return data | overrides


@pytest.fixture
def remote(tmp_path: Path) -> Path:
    """A fake repository served through file:// URLs, laid out as <commit>/<path>."""
    root = tmp_path / "remote"
    for path, text in FILES.items():
        file = root / COMMIT / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text)
    return root


def fake_source(remote: Path, **overrides: Any) -> Source:
    url = remote.as_uri() + "/{commit}/{path}"
    return Source.model_validate(source_data(download_url=url, files=list(FILES)) | overrides)


# --- The schema ---------------------------------------------------------------


def test_the_committed_sources_list_validates() -> None:
    sources = load_sources(REPO_ROOT / "sources.yaml").sources
    assert {source.name for source in sources} == {
        "system-design-primer-text",
        "system-design-primer-solutions",
        "system-design-primer-anki",
        "tech-interview-handbook",
    }
    assert all(not path.startswith("images/") for s in sources for path in s.files)


@pytest.mark.parametrize(
    "overrides",
    [
        {"commit": "main"},  # a branch moves; only a full SHA pins the text
        {"files": ["../outside.md"]},
        {"files": ["/etc/passwd"]},
        {"files": ["images/figure.png"]},
        {"files": []},
        {"name": "Not A Slug"},
        {"download_url": "https://example.com/README.md"},
        {"download_url": "https://example.com/{commit}/{path}/{oops}"},
        {"unknown_key": True},
    ],
)
def test_the_schema_rejects_a_bad_source(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        Source.model_validate(source_data(**overrides))


def test_the_schema_rejects_duplicate_names() -> None:
    with pytest.raises(ValidationError):
        SourcesList.model_validate({"sources": [source_data(), source_data()]})


# --- The downloader -------------------------------------------------------------


def test_download_writes_every_file_under_the_data_folder(remote: Path, tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    assert download_source(fake_source(remote), data_dir) is True
    for path, text in FILES.items():
        assert (data_dir / "fake-source" / path).read_text() == text
    assert (data_dir / "fake-source" / STAMP_FILE).read_text().strip() == COMMIT


def test_a_second_run_is_skipped_without_fetching(remote: Path, tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    source = fake_source(remote)
    download_source(source, data_dir)
    (remote / COMMIT / "README.md").unlink()  # a fetch would now fail
    assert download_source(source, data_dir) is False


def test_a_failed_run_leaves_no_stamp_and_is_retried(remote: Path, tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    source = fake_source(remote, files=["README.md", "missing.md"])
    with pytest.raises(OSError):
        download_source(source, data_dir)
    assert not (data_dir / "fake-source" / STAMP_FILE).exists()


def test_a_local_only_source_is_written_only_inside_the_data_folder(
    remote: Path, tmp_path: Path
) -> None:
    data_dir = tmp_path / "data"
    download_source(fake_source(remote, local_only=True), data_dir)
    written = {p for p in tmp_path.rglob("*") if p.is_file() and remote not in p.parents}
    assert written and all(data_dir in p.parents for p in written)


def test_a_path_escaping_the_data_folder_is_refused(remote: Path, tmp_path: Path) -> None:
    # model_construct skips validation, to prove the downloader checks on its own.
    url = remote.as_uri() + "/{commit}/{path}"
    unchecked = Source.model_construct(**source_data(download_url=url, files=["../escape.md"]))
    with pytest.raises(ValueError):
        download_source(unchecked, tmp_path / "data")
    assert not (tmp_path / "data" / "escape.md").exists()


# --- `coach setup` ----------------------------------------------------------------


def test_coach_setup_downloads_without_an_api_key(
    remote: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv(API_KEY_VAR, raising=False)
    sources = {"sources": [fake_source(remote).model_dump()]}
    (tmp_path / "sources.yaml").write_text(yaml.safe_dump(sources))

    assert main(["setup"]) == 0
    assert main(["setup"]) == 0
    assert (tmp_path / "data/study-material/fake-source/README.md").is_file()
    assert capsys.readouterr().out.splitlines() == [
        "fake-source: downloaded",
        "fake-source: already up to date",
    ]


def test_coach_setup_without_a_sources_list_prints_a_readable_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.chdir(tmp_path)
    assert main(["setup"]) == 1
    assert "sources.yaml" in capsys.readouterr().err


def test_coach_setup_with_malformed_yaml_prints_a_readable_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "sources.yaml").write_text("sources:\n\t- name: tab-indented\n")
    assert main(["setup"]) == 1
    assert "coach: error:" in capsys.readouterr().err


def test_coach_setup_with_an_unknown_placeholder_prints_a_readable_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.chdir(tmp_path)
    url = "https://example.com/{commit}/{path}/{oops}"
    sources = {"sources": [source_data(download_url=url)]}
    (tmp_path / "sources.yaml").write_text(yaml.safe_dump(sources))
    assert main(["setup"]) == 1
    assert "coach: error:" in capsys.readouterr().err


def test_coach_setup_with_whitespace_in_the_url_prints_a_readable_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.chdir(tmp_path)
    url = "https://example.com/my folder/{commit}/{path}"
    sources = {"sources": [source_data(download_url=url)]}
    (tmp_path / "sources.yaml").write_text(yaml.safe_dump(sources))
    assert main(["setup"]) == 1
    assert "coach: error:" in capsys.readouterr().err
