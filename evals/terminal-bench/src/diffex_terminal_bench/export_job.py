"""Export retained qualification trials as a Harbor job without executing them."""

import argparse
from collections import Counter
from datetime import datetime
from importlib.metadata import version
import os
from pathlib import Path
import shutil
import tempfile
from uuid import NAMESPACE_URL, uuid5

from harbor.models.job.config import JobConfig, RetryConfig
from harbor.models.job.lock import HarborLockInfo, JobLock, TrialLock
from harbor.models.job.result import JobResult, JobStats
from harbor.models.trial.config import TrialConfig
from harbor.models.trial.result import TrialResult

from diffex_terminal_bench.config import PINS
from diffex_terminal_bench.gate import fingerprint, inventory, read_json, stage_tasks, write_json


def export_job(source: Path, output: Path, *, allow_partial: bool = False) -> Path:
    """Copy immutable trial evidence and synthesize only job-level metadata."""
    if version("harbor") != PINS["harbor_version"]:
        raise ValueError("Run uv sync --locked before exporting")
    if source.is_symlink() or output.is_symlink():
        raise ValueError("Export paths must not be symlinks")
    source, output = source.resolve(), output.resolve()
    if output == source or output.is_relative_to(source) or source.is_relative_to(output):
        raise ValueError("Export destination must be separate from the source stage")
    if output.exists():
        raise FileExistsError(f"Export destination already exists: {output}")
    before = inventory(source)
    gate = read_json(source / "gate.json")
    identity = gate["identity"]
    if gate["identity_sha256"] != fingerprint(identity):
        raise ValueError("Gate identity fingerprint does not match")
    if identity["harbor_version"] != version("harbor"):
        raise ValueError("Export requires the Harbor version recorded by the stage")
    if not gate.get("finished_at"):
        raise ValueError("Stage has not stopped; wait for its final gate.json before exporting")
    selected = stage_tasks(gate["stage"], identity["pilot_tasks"], list(identity["task_digests"]))
    planned = {f"{index:03d}-{task}": task for index, task in enumerate(selected, 1)}
    checked = {row["directory"]: row for row in gate["trials"]}
    if len(checked) != len(gate["trials"]) or not checked.keys() <= planned.keys():
        raise ValueError("Gate contains duplicate or unexpected trials")
    directories = sorted(path for path in source.iterdir() if path.is_dir())
    if not directories or any(path.name not in planned for path in directories):
        raise ValueError("Stage has no trials or contains unexpected trial directories")
    results = []
    locks = []
    common = None
    for directory in directories:
        if directory.name in checked:
            row = checked[directory.name]
            if row["task"] != planned[directory.name] or inventory(directory) != row["files"]:
                raise ValueError(f"{directory.name}: retained checked evidence changed")
        # Never silently omit a started trial, including failed or cancelled work.
        result = TrialResult.model_validate_json((directory / "result.json").read_text())
        config = TrialConfig.model_validate_json((directory / "config.json").read_text())
        lock = TrialLock.model_validate_json((directory / "lock.json").read_text())
        if not result.finished_at:
            raise ValueError(f"{directory.name}: trial has no terminal result")
        if (result.trial_name != directory.name or config.trial_name != directory.name
                or result.task_name.rsplit("/", 1)[-1] != planned[directory.name]
                or result.config.model_dump() != config.model_dump()
                or lock.task.digest != identity["task_digests"][planned[directory.name]]):
            raise ValueError(f"{directory.name}: trial identity or configuration differs from retained evidence")
        values = config.model_dump(exclude={"task", "trial_name", "trials_dir", "job_id", "source_trial"})
        # This unique sandbox ownership label belongs to the trial, not the job.
        labels = values["environment"]["kwargs"].get("labels", {})
        labels.pop("diffex.gate_trial", None)
        if not labels:
            values["environment"]["kwargs"].pop("labels", None)
        if common is not None and common != values:
            raise ValueError("Stage mixes execution configurations")
        common = values
        results.append(result)
        locks.append(lock)
    if len({result.id for result in results}) != len(results):
        raise ValueError("Stage contains duplicate trial IDs")
    if not checked.keys() <= {path.name for path in directories}:
        raise ValueError("A checked trial directory is missing")
    complete = len(results) == len(selected)
    if gate.get("passed") is True and (not complete or len(checked) != len(selected)
                                      or any(result.exception_info for result in results)):
        raise ValueError("Passing gate has incomplete coverage or errored trials")
    if (not complete or gate.get("passed") is not True) and not allow_partial:
        raise ValueError("Stage failed or is incomplete; use --allow-partial to export all retained terminal results")

    job_id = uuid5(NAMESPACE_URL, "diffex-terminal-bench-export:" + fingerprint(before))
    counts = Counter(selected)
    # Original task paths can be expired temporary extractions. Preserve them
    # as provenance; this export is for viewing/upload, not Harbor job resume.
    sample = results[0].config.task
    tasks = {planned[result.trial_name]: result.config.task for result in results}
    job_values = {key: value for key, value in common.items() if key in JobConfig.model_fields}
    job_config = JobConfig(
        **job_values, agents=[results[0].config.agent], job_name=output.name, jobs_dir=output.parent,
        n_concurrent_trials=identity["concurrency"], retry=RetryConfig(max_retries=identity["harbor_retries"]),
        n_attempts=next(iter(counts.values())),
        tasks=[tasks.get(task) or sample.model_copy(update={"path": sample.path.parent / task}) for task in counts],
    )
    stats = JobStats.from_trial_results(results, n_total_trials=len(selected))
    job_result = JobResult(id=job_id, started_at=datetime.fromisoformat(gate["started_at"]),
                           finished_at=datetime.fromisoformat(gate["finished_at"]),
                           n_total_trials=len(selected), stats=stats)
    job_lock = JobLock(created_at=job_result.started_at, harbor=HarborLockInfo(version=identity["harbor_version"]),
                       n_concurrent_trials=job_config.n_concurrent_trials, retry=job_config.retry, trials=locks)
    manifest = {"schema_version": 1, "job_id": str(job_id), "source_stage": str(source),
                "stage": gate["stage"], "recorded_gate_passed": gate.get("passed") is True,
                "qualification_revalidated": False, "planned_trials": len(selected), "exported_trials": len(results),
                "missing_trials": sorted(planned.keys() - {path.name for path in directories}),
                "source_files": before}
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".diffex-export-", dir=output.parent) as temporary:
        staging = Path(temporary) / output.name
        staging.mkdir()
        for directory in directories:
            destination = staging / directory.name
            shutil.copytree(directory, destination, symlinks=True)
            if inventory(destination) != inventory(directory):
                raise ValueError("Trial evidence changed while copying")
            # Harbor's archive allowlist omits custom trial-root files. Retain
            # them under artifacts so cleanup evidence survives Hub downloads.
            provenance = destination / "artifacts/diffex-qualification"
            provenance.mkdir(parents=True, exist_ok=False)
            for name in ("cleanup-request.json", "sandbox-created.json", "sandbox-cleanup.json", "sandbox-recovery.json"):
                path = directory / name
                if path.is_file():
                    shutil.copy2(path, provenance / path.name)
        provenance = staging / directories[0].name / "artifacts/diffex-qualification"
        shutil.copy2(source / "gate.json", provenance / "gate.json")
        write_json(provenance / "export.json", manifest)
        for name, model in (("config.json", job_config), ("result.json", job_result), ("lock.json", job_lock)):
            write_json(staging / name, model.model_dump(mode="json"))
        write_json(staging / "export.json", manifest)
        (staging / "analysis.md").write_text(
            "# Diffex qualification export\n\n"
            f"Stage: {gate['stage']}.\n"
            f"Recorded gate passed: {manifest['recorded_gate_passed']}.\n"
            f"Retained terminal trials: {len(results)} of {len(selected)} planned.\n"
            f"Errored trials: {stats.n_errored_trials}.\n\n"
            "This is a snapshot of retained evidence, not a new qualification or evaluation.\n"
            "Failures, rewards, trial IDs, sessions, and trajectories are preserved.\n"
            "Missing trials were not run and must not be interpreted as successful.\n"
            "Job usage totals are observed sums; failed trials can have unknown usage.\n"
            "Use this directory for upload and viewing, not `harbor job resume`.\n"
            f"The source gate and file hashes are in `{directories[0].name}/artifacts/diffex-qualification/`.\n"
        )
        if inventory(source) != before:
            raise ValueError("Source stage changed during export; wait for all writers to stop")
        if output.exists():
            raise FileExistsError(f"Export destination already exists: {output}")
        staging.rename(output)
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", type=Path, help="Retained stage directory containing gate.json")
    parser.add_argument("--output", type=Path, required=True, help="New Harbor job directory; never overwrites")
    parser.add_argument("--allow-partial", action="store_true", help="Include every terminal trial from a stopped failed/incomplete stage")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        destination = export_job(args.stage, args.output, allow_partial=args.allow_partial)
    except (OSError, ValueError, KeyError) as exc:
        parser.exit(1, f"Export failed: {exc}\n")
    report = read_json(destination / "export.json")
    print(f"Exported {report['exported_trials']}/{report['planned_trials']} trials: {destination}")
    print("No evaluations or uploads were performed. Use harbor upload on the exported directory.")


if __name__ == "__main__":
    main()
