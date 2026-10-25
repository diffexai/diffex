"""Preserve DeepSWE image runtime settings, capacity checks, and verifier evidence."""

import asyncio
from asyncio import sleep as registry_sleep
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shlex
import tempfile

import httpx
from harbor.environments.e2b import E2BEnvironment


async def registry_get(client: httpx.AsyncClient, url: str, **kwargs) -> httpx.Response:
    """Pace anonymous ECR reads and retry only transient, read-only failures."""
    delay = 1.1
    for attempt in range(6):
        await registry_sleep(delay)
        try:
            response = await client.get(url, **kwargs)
        except httpx.TransportError:
            if attempt == 5:
                raise
            delay = 2 ** (attempt + 1)
            continue
        if response.status_code not in {429, 500, 502, 503, 504} or attempt == 5:
            response.raise_for_status()
            return response
        delay = 2 ** (attempt + 1)
        retry_after = response.headers.get("Retry-After")
        if retry_after:
            try:
                wait = float(retry_after)
            except ValueError:
                try:
                    wait = (parsedate_to_datetime(retry_after) - datetime.now(timezone.utc)).total_seconds()
                except (TypeError, ValueError, OverflowError):
                    wait = 0
            if math.isfinite(wait):
                delay = max(delay, wait)
        # Do not retry earlier than Retry-After or wait indefinitely on a
        # registry outage. Preparation fails without starting any eval trials.
        if delay > 60:
            response.raise_for_status()
    raise AssertionError("Unreachable registry retry state")


async def image_runtime(client: httpx.AsyncClient, image: str) -> dict:
    """Read public ECR image configuration without downloading filesystem layers."""
    match = re.fullmatch(r"public\.ecr\.aws/([a-z0-9_./-]+)(?::([\w.-]+)|@(sha256:[a-f0-9]{64}))", image)
    if match is None:
        raise ValueError(f"Expected a versioned public ECR task image: {image}")
    repository, tag, digest = match.groups()
    response = await registry_get(client, "https://public.ecr.aws/token/", params={
        "service": "public.ecr.aws", "scope": f"repository:{repository}:pull",
    })
    response.raise_for_status()
    headers = {"Authorization": f"Bearer {response.json()['token']}", "Accept": ", ".join((
        "application/vnd.oci.image.index.v1+json", "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    ))}
    base = f"https://public.ecr.aws/v2/{repository}"
    reference = digest or tag
    for _ in range(2):
        response = await registry_get(client, f"{base}/manifests/{reference}", headers=headers)
        response.raise_for_status()
        actual_digest = "sha256:" + hashlib.sha256(response.content).hexdigest()
        if reference.startswith("sha256:") and reference != actual_digest:
            raise ValueError("Image manifest digest mismatch")
        manifest = response.json()
        if "manifests" not in manifest:
            break
        candidates = [entry for entry in manifest["manifests"]
                      if entry.get("platform", {}).get("os") == "linux"
                      and entry.get("platform", {}).get("architecture") == "amd64"]
        if len(candidates) != 1:
            raise ValueError("DeepSWE requires exactly one linux/amd64 image manifest")
        reference = candidates[0]["digest"]
    else:
        raise ValueError("Nested image indexes are not supported")
    config_digest = manifest["config"]["digest"]
    response = await registry_get(client, f"{base}/blobs/{config_digest}", headers=headers)
    response.raise_for_status()
    if config_digest != "sha256:" + hashlib.sha256(response.content).hexdigest():
        raise ValueError("Image configuration digest mismatch")
    config = response.json()
    if (config["os"], config["architecture"]) != ("linux", "amd64"):
        raise ValueError("DeepSWE requires linux/amd64 image configuration")
    runtime = config["config"]
    return {"image": image, "manifest_digest": actual_digest, "config_digest": config_digest,
            "env": dict(value.split("=", 1) for value in runtime.get("Env") or []),
            "workdir": runtime.get("WorkingDir") or "/"}


def read_runtime_catalog(data: bytes) -> dict:
    catalog = json.loads(data)
    images = catalog["images"]
    digest = hashlib.sha256(json.dumps(images, sort_keys=True).encode()).hexdigest()
    if catalog.get("schema_version") != 1 or catalog.get("images_sha256") != digest:
        raise ValueError("Image runtime catalog integrity check failed")
    for image, runtime in images.items():
        if runtime.get("image") != image or not isinstance(runtime.get("env"), dict) or not isinstance(runtime.get("workdir"), str):
            raise ValueError("Invalid image runtime catalog entry")
    return images


async def prepare_image_runtimes(images: list[str], path: Path) -> str:
    """Resolve metadata serially once, checkpointing successful reads for reuse."""
    path.parent.mkdir(parents=True, exist_ok=True)
    # Separate preparers for the same job must share both cached results and
    # pacing. Never hold a blocking flock on the asyncio event-loop thread.
    with path.with_suffix(".lock").open("a") as lock:
        async with asyncio.timeout(1200):
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    await asyncio.sleep(0.1)
            try:
                records = read_runtime_catalog(path.read_bytes()) if path.exists() else {}
                async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
                    for index, image in enumerate(sorted(set(images)), 1):
                        if image in records:
                            continue
                        print(f"Preparing image runtime {index}/{len(set(images))}: {image}", flush=True)
                        records[image] = await image_runtime(client, image)
                        catalog = {"schema_version": 1, "images": records, "images_sha256":
                                   hashlib.sha256(json.dumps(records, sort_keys=True).encode()).hexdigest()}
                        with tempfile.NamedTemporaryFile(dir=path.parent, mode="w", delete=False) as stream:
                            temporary = Path(stream.name)
                            try:
                                stream.write(json.dumps(catalog, indent=2, sort_keys=True) + "\n")
                                stream.close()
                                temporary.replace(path)
                            finally:
                                temporary.unlink(missing_ok=True)
                return hashlib.sha256(path.read_bytes()).hexdigest()
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)


class ResourceCheckedE2B(E2BEnvironment):
    def __init__(self, *args, runtime_catalog: str | None = None,
                 runtime_catalog_sha256: str | None = None, **kwargs):
        self._runtime_catalog = runtime_catalog
        self._runtime_catalog_sha256 = runtime_catalog_sha256
        super().__init__(*args, **kwargs)

    def _load_runtime(self) -> dict:
        path = self._runtime_catalog
        expected = self._runtime_catalog_sha256
        if not path or not expected:
            raise RuntimeError("Prepare the DeepSWE runtime catalog before starting trials")
        data = Path(path).read_bytes()
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError("Prepared image runtime catalog changed")
        return read_runtime_catalog(data)[self._runtime_image()]

    async def _dispatch_command(
        self, command: str, *, cwd: str | None, env: dict[str, str] | None,
        timeout_sec: int | None, user: str,
    ):
        # E2B executes /bin/bash -l -c: login profiles can replace the PATH
        # supplied through envs. Restore the fully merged PATH inside that shell
        # so startup probes, agent tools, and verifier commands use task binaries.
        # Keep credentials in the env parameter, never in shell command text.
        if env is not None and "PATH" in env:
            command = f"export PATH={shlex.quote(env['PATH'])}; {command}"
        return await super()._dispatch_command(
            command, cwd=cwd, env=env, timeout_sec=timeout_sec, user=user,
        )

    def _runtime_image(self) -> str:
        if self.task_env_config.docker_image:
            return self.task_env_config.docker_image
        # The pinned dataset's verifier Dockerfiles add only files and chmod to
        # the task image. Reject future runtime overrides rather than ignore them.
        lines = self._environment_definition_path.read_text().splitlines()
        instructions = [shlex.split(line, comments=True) for line in lines if line.strip()]
        instructions = [parts for parts in instructions if parts]
        bases = [parts for parts in instructions if parts[0].upper() == "FROM"]
        if len(bases) != 1 or len(bases[0]) != 2 or any(
            parts[0].upper() not in {"FROM", "COPY", "RUN"} for parts in instructions
        ):
            raise ValueError("Unsupported DeepSWE verifier Dockerfile runtime configuration")
        return bases[0][1]

    async def start(self, force_build: bool) -> None:
        runtime = self._load_runtime()
        # Explicit task/trial settings still take precedence over image defaults.
        self._persistent_env = {**runtime["env"], **self._startup_env()}
        self._workdir = runtime["workdir"]
        await super().start(force_build)
        if self._sandbox is None:
            raise RuntimeError("E2B sandbox was not created.")
        probe = await self.exec("env -0", timeout_sec=30)
        actual = dict(value.split("=", 1) for value in (probe.stdout or "").split("\0") if "=" in value)
        expected = self._merge_env(None) or {}
        mismatches = sorted(key for key, value in expected.items() if actual.get(key) != value)
        runtime_record = {key: value for key, value in runtime.items() if key != "env"}
        runtime_record.update(env_names=sorted(runtime["env"]), mismatches=mismatches,
                              verified=probe.return_code == 0 and not mismatches)
        directory = self.trial_paths.trial_dir / "artifacts" / "e2b-runtime"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / f"{self._sandbox.sandbox_id}.json").write_text(json.dumps(runtime_record, indent=2) + "\n")
        if not runtime_record["verified"]:
            raise RuntimeError(f"E2B did not preserve image environment variables: {mismatches}")
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(
                f"https://api.e2b.dev/sandboxes/{self._sandbox.sandbox_id}",
                headers={"X-API-Key": os.environ["E2B_API_KEY"]},
            )
            response.raise_for_status()
            data = response.json()
        resources = {
            "sandbox_id": self._sandbox.sandbox_id,
            "session_id": self.session_id,
            "cpu_count": data["cpuCount"],
            "memory_mb": data["memoryMB"],
            "disk_size_mb": data["diskSizeMB"],
            "expected_cpu_count": self.task_env_config.cpus,
            "expected_memory_mb": self.task_env_config.memory_mb,
            "minimum_disk_mb": self.task_env_config.storage_mb,
        }
        resources["verified"] = (
            resources["cpu_count"] == resources["expected_cpu_count"]
            and resources["memory_mb"] == resources["expected_memory_mb"]
            and resources["disk_size_mb"] >= resources["minimum_disk_mb"]
        )
        directory = self.trial_paths.trial_dir / "artifacts" / "e2b-resources"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / f"{self._sandbox.sandbox_id}.json").write_text(
            json.dumps(resources, indent=2) + "\n"
        )
        if not resources["verified"]:
            raise RuntimeError(f"E2B capacity differs from the task requirements: {resources}")

    async def stop(self, delete: bool) -> None:
        # Recover verifier logs before teardown, including when verify() fails.
        # Retain a separate recovery snapshot on timeout/transport failure too,
        # without turning an incomplete reward file into a completed grade.
        try:
            if self._sandbox is not None and not self.task_env_config.docker_image:
                directory = self.trial_paths.trial_dir / "artifacts" / "verifier-recovery" / self._sandbox.sandbox_id
                directory.mkdir(parents=True, exist_ok=True)
                record = {"complete": False}
                try:
                    async with asyncio.timeout(60):
                        await self.download_dir("/logs/verifier", directory / "logs")
                    record["complete"] = True
                except Exception as exc:
                    record["error"] = type(exc).__name__
                    self.logger.warning("Verifier recovery download failed: %s", type(exc).__name__)
                finally:
                    (directory / "recovery.json").write_text(json.dumps(record, indent=2) + "\n")
        finally:
            await super().stop(delete)
