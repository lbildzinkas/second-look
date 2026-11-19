"""The sources list and `coach setup`, which downloads the study material.

Study material is downloaded, not committed (docs/adr/0002): every file lands
under the git-ignored data folder, pinned to a commit so each download is the
same text. The sources list is YAML, read with PyYAML's `safe_load`
(https://pyyaml.org/wiki/PyYAMLDocumentation) and checked against the
Pydantic models below (https://docs.pydantic.dev/latest/concepts/models/).
"""

import os
import string
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Annotated

import yaml
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

SOURCES_FILE = Path("sources.yaml")
DATA_DIR = Path("data/study-material")
# Written last, so a source counts as downloaded only once every file is in.
STAMP_FILE = ".commit"
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"}
DOWNLOAD_TIMEOUT_SECONDS = 30


def _relative_text_path(path: str) -> str:
    """Reject paths that could escape the data folder, and images."""
    parts = PurePosixPath(path)
    if parts.is_absolute() or ".." in parts.parts or not parts.parts:
        raise ValueError(f"{path!r} must be a relative path inside the repository")
    if parts.suffix.lower() in IMAGE_SUFFIXES:
        raise ValueError(f"{path!r} is an image; the sources list holds text only")
    return path


def _url_template(url: str) -> str:
    # The exact placeholder set, so url_for's str.format can never fail.
    fields = {field for _, field, _, _ in string.Formatter().parse(url) if field is not None}
    if fields != {"commit", "path"}:
        raise ValueError("download_url must contain only the {commit} and {path} placeholders")
    # Characters http.client refuses in a URL, raising InvalidURL deep in urlopen.
    if any(char <= " " or char == "\x7f" for char in url):
        raise ValueError("download_url must not contain whitespace or control characters")
    return url


class Source(BaseModel):
    """One piece of study material; see the field notes in sources.yaml."""

    # Unknown keys are typos, not data: https://docs.pydantic.dev/latest/api/config/#pydantic.config.ConfigDict.extra
    model_config = ConfigDict(extra="forbid", frozen=True)

    # A slug, so the name is always a single safe folder name.
    name: str = Field(pattern=r"^[a-z0-9][a-z0-9-]*$")
    repository: str
    # A full Git commit SHA (40 hex digits): https://git-scm.com/book/en/v2/Git-Internals-Git-Objects
    commit: str = Field(pattern=r"^[0-9a-f]{40}$")
    licence: str = Field(min_length=1)
    local_only: bool
    download_url: Annotated[str, AfterValidator(_url_template)]
    files: list[Annotated[str, AfterValidator(_relative_text_path)]] = Field(min_length=1)

    def url_for(self, path: str) -> str:
        # Percent-encode spaces and the like: https://docs.python.org/3/library/urllib.parse.html#urllib.parse.quote
        return self.download_url.format(commit=self.commit, path=urllib.parse.quote(path))


class SourcesList(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    sources: list[Source] = Field(min_length=1)

    # Cross-field check: https://docs.pydantic.dev/latest/concepts/validators/#model-validators
    @model_validator(mode="after")
    def _unique_names(self) -> "SourcesList":
        names = [source.name for source in self.sources]
        if len(names) != len(set(names)):
            raise ValueError("source names must be unique, they are folder names")
        return self


def load_sources(path: Path = SOURCES_FILE) -> SourcesList:
    """Read and validate the sources list; raises ValueError if it is not."""
    try:
        document = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as error:
        raise ValueError(f"{path} is not valid YAML: {error}") from error
    return SourcesList.model_validate(document)


def download_source(source: Source, data_dir: Path = DATA_DIR) -> bool:
    """Download one source into `data_dir/<name>/`; False if already there.

    Safe to run twice: a source whose stamp matches its pinned commit is skipped,
    and each file is written to a temporary name and then renamed into place
    (https://docs.python.org/3/library/os.html#os.replace), so an interrupted
    run never leaves a half-written file behind.
    """
    root = data_dir.resolve()
    target = root / source.name
    stamp = target / STAMP_FILE
    if stamp.is_file() and stamp.read_text(encoding="utf-8").strip() == source.commit:
        return False

    for path in source.files:
        destination = (target / path).resolve()
        # Defence in depth on top of the schema: never write outside the source's folder.
        if not destination.is_relative_to(target):
            raise ValueError(f"{path!r} would be written outside {target}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        partial = destination.with_name(destination.name + ".part")
        # urlopen also reads file:// URLs, which is how the tests fake a source:
        # https://docs.python.org/3/library/urllib.request.html#urllib.request.urlopen
        with urllib.request.urlopen(source.url_for(path), timeout=DOWNLOAD_TIMEOUT_SECONDS) as r:
            partial.write_bytes(r.read())
        os.replace(partial, destination)

    stamp.write_text(source.commit + "\n", encoding="utf-8")
    return True


def run_setup(sources_file: Path = SOURCES_FILE, data_dir: Path = DATA_DIR) -> None:
    """Download every source in the list, printing one line per source."""
    for source in load_sources(sources_file).sources:
        downloaded = download_source(source, data_dir)
        scope = " (local only)" if source.local_only else ""
        status = "downloaded" if downloaded else "already up to date"
        print(f"{source.name}{scope}: {status}")
