"""Download verified benchmark inputs independently of mutable registries."""

from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import re
import shutil
import tarfile
import tempfile
import tomllib
from urllib.request import urlopen

from harbor.models.task.task import Task
from harbor.publisher.packager import Packager
from pydantic import BaseModel, ConfigDict, Field, field_validator

from diffex_terminal_bench.execution import ExecutionOptions, PROVIDER_ENV
from diffex_terminal_bench.gate import sha256, stage_tasks


class DatasetPin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    version: str
    git_url: str
    git_commit: str = Field(pattern=r"^[0-9a-f]{40}$")
    archive_url: str = Field(pattern=r"^https://")
    archive_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    task_count: int = Field(ge=10)


class BenchmarkConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: str
    pilot_tasks: list[str]
    dataset: DatasetPin
    policy: ExecutionOptions

    @field_validator("model")
    @classmethod
    def exact_model(cls, value: str) -> str:
        provider, separator, model = value.partition("/")
        if not separator or provider not in PROVIDER_ENV or not model or re.search(r"[\s*?:]", model):
            raise ValueError("Select an exact supported provider/model")
        return value


def load_config(path: Path) -> BenchmarkConfig:
    return BenchmarkConfig.model_validate(tomllib.loads(path.read_text()))


@contextmanager
def prepare_dataset(config: BenchmarkConfig, cache: Path):
    """Re-extract the verified archive each time; never trust an edited cache."""
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / f"{config.dataset.archive_sha256}.tar.gz"
    with tempfile.TemporaryDirectory(prefix="diffex-tb-inputs-") as temp:
        # Serialize publication and extraction for this digest, not execution.
        # Separate runs can share the archive but never their extracted tasks.
        with (cache / f"{config.dataset.archive_sha256}.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if not archive.exists():
                with tempfile.TemporaryDirectory(dir=cache, prefix=".download-") as staging:
                    downloaded = Path(staging) / archive.name
                    with downloaded.open("wb") as download, urlopen(config.dataset.archive_url, timeout=60) as response:
                        shutil.copyfileobj(response, download)
                        download.flush()
                        os.fsync(download.fileno())
                    if sha256(downloaded) != config.dataset.archive_sha256:
                        raise ValueError("Dataset download SHA-256 differs from benchmark.toml")
                    # Readers can never observe an incomplete published archive.
                    os.replace(downloaded, archive)
            if sha256(archive) != config.dataset.archive_sha256:
                raise ValueError("Cached dataset archive SHA-256 differs from benchmark.toml")
            with tarfile.open(archive) as tar:
                tar.extractall(temp, filter="data")
        roots = list(Path(temp).iterdir())
        if len(roots) != 1 or not roots[0].is_dir():
            raise ValueError("Expected a single dataset archive root")
        # TB 2.1 keeps benchmark tasks under tasks/. Repository templates and
        # leaderboard tooling outside this directory are not benchmark inputs.
        tasks = {path.name: path for path in sorted((roots[0] / "tasks").iterdir()) if Task.is_valid_dir(path)}
        if len(tasks) != config.dataset.task_count:
            raise ValueError("Dataset task count differs from the pin")
        stage_tasks("pilot", config.pilot_tasks, list(tasks))
        digests = {name: "sha256:" + Packager.compute_content_hash(path)[0] for name, path in tasks.items()}
        yield tasks, digests
