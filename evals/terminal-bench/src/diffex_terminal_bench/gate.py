"""Fail-closed evidence checks for staged benchmark qualification."""

from collections import Counter
import hashlib
import json
import math
import os
from pathlib import Path
import random
import stat
import tempfile

from harbor.models.agent.context import AgentContext
from harbor.models.trial.config import AgentConfig, EnvironmentConfig, TrialConfig
from harbor.utils.trajectory_validator import TrajectoryValidator

from diffex_terminal_bench.config import PINS
from diffex_terminal_bench.diagnostics import TrialExecutionFailure
from diffex_terminal_bench.execution import PROVIDER_ENV, SUBAGENT_TOOLS
from diffex_terminal_bench.outcome import parse_outcome
from diffex_terminal_bench.trajectory import CONTEXT_FIELDS, export_trajectory


STAGES = ("oracle", "trial", "integration", "pilot", "reliability", "full")


def read_json(path: Path) -> dict:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"Expected JSON object: {path.name}")
    return value


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")
    temporary.replace(path)


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def fingerprint(value: dict) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def sample_tasks(all_tasks: list[str], count: int, seed: int) -> list[str]:
    if type(count) is not int or not 1 <= count <= len(all_tasks):
        raise ValueError(f"Sample count must be between 1 and {len(all_tasks)}")
    if type(seed) is not int:
        raise ValueError("Sample seed must be an integer")
    if len(set(all_tasks)) != len(all_tasks):
        raise ValueError("Sample population must contain distinct tasks")
    return random.Random(seed).sample(sorted(all_tasks), count)


def stage_tasks(stage: str, pilot: list[str], all_tasks: list[str], *, sample: dict | None = None) -> list[str]:
    if stage == "sample":
        if not isinstance(sample, dict) or set(sample) != {"count", "seed", "tasks"}:
            raise ValueError("Missing or invalid sample selection")
        selected = sample_tasks(all_tasks, sample["count"], sample["seed"])
        if sample["tasks"] != selected:
            raise ValueError("Sample tasks do not match the recorded seed and dataset")
        return selected
    if len(pilot) != 10 or len(set(pilot)) != 10 or not set(pilot).issubset(all_tasks):
        raise ValueError("The pilot must select ten distinct pinned tasks")
    if stage in ("oracle", "trial"):
        return pilot[:1]
    if stage == "integration":
        return pilot[:3]
    if stage == "pilot":
        return pilot
    if stage == "reliability":
        return pilot * 3
    if stage == "full":
        return all_tasks * 5
    raise ValueError(f"Unknown stage: {stage}")


def inventory(directory: Path) -> dict[str, str]:
    """Hash retained files and portable links without following link targets.

    Cache snapshots may link directly to regular files inside the evidence root.
    Bind the link text separately from file contents so retargeting, replacing a
    link with a file, and editing its target all change the inventory.
    """
    if directory.is_symlink():
        raise ValueError("Evidence root must not be a symlink")
    directory = directory.resolve(strict=True)
    result = {}
    for path in sorted(directory.rglob("*")):
        relative = path.relative_to(directory).as_posix()
        if path.is_symlink():
            link = os.readlink(path)
            target = path.parent
            if Path(link).is_absolute():
                raise ValueError(f"Evidence symlinks must be relative: {relative}")
            # Walk the original components, including '..', before resolving.
            # Normalizing first could hide traversal through an external path
            # or a directory symlink. Chained links are deliberately rejected.
            try:
                for part in Path(link).parts:
                    if not stat.S_ISDIR(target.lstat().st_mode):
                        raise ValueError(f"Evidence symlinks must not traverse other links or files: {relative}")
                    target = target.parent if part == ".." else target / part
                    if not target.is_relative_to(directory):
                        raise ValueError(f"Evidence symlinks must stay inside their root: {relative}")
                if not stat.S_ISREG(target.lstat().st_mode) or not path.is_file():
                    raise ValueError(f"Evidence symlinks must point directly to regular files: {relative}")
            except OSError as exc:
                raise ValueError(f"Evidence symlinks must have existing regular-file targets: {relative}") from exc
            result[relative] = "symlink:" + fingerprint({"target": link})
        elif path.is_file():
            result[relative] = sha256(path)
    return result


def require_previous(root: Path, stage: str, identity: dict, pilot: list[str], tasks: list[str], *, include_current: bool = False) -> None:
    """Recheck every prior artifact, not just a cached 'passed' flag."""
    for previous in STAGES[:STAGES.index(stage) + int(include_current)]:
        verify_stage(root, previous, identity, pilot, tasks)


def verify_stage(root: Path, stage: str, identity: dict, pilot: list[str], tasks: list[str]) -> None:
    directory = root / stage
    report = read_json(directory / "gate.json")
    if report.get("passed") is not True or report.get("identity") != identity:
        raise ValueError(f"{stage}: missing qualification for this exact configuration")
    selected = stage_tasks(stage, pilot, tasks, sample=identity.get("sample"))
    trials = report.get("trials", [])
    if Counter(row["task"] for row in trials) != Counter(selected):
        raise ValueError(f"{stage}: trial coverage does not match the stage")
    if len({row["directory"] for row in trials}) != len(trials):
        raise ValueError(f"{stage}: duplicate trial evidence")
    if stage == "sample":
        if (report.get("stage") != stage or report.get("identity_sha256") != fingerprint(identity)
                or not report.get("finished_at") or report.get("failure") or report.get("failures")):
            raise ValueError("Sample report is unfinished, failed, or inconsistent")
        if [(row["task"], row["directory"]) for row in trials] != [
            (task, f"{index:03d}-{task}") for index, task in enumerate(selected, 1)
        ]:
            raise ValueError("Sample trial order differs from the recorded selection")
    for row in trials:
        trial_dir = directory / row["directory"]
        if trial_dir.resolve().parent != directory.resolve():
            raise ValueError("Trial evidence must be a direct child of its stage")
        if inventory(trial_dir) != row["files"]:
            raise ValueError(f"{stage}: retained evidence changed or is missing")
        validate_trial(trial_dir, row["task"], identity, oracle=stage == "oracle")


def validate_trial(directory: Path, task: str, identity: dict, *, oracle: bool = False) -> dict:
    """A wrong solution is a result; broken execution or missing evidence is not."""
    result = read_json(directory / "result.json")
    if result.get("exception_info") or not result.get("finished_at"):
        raise TrialExecutionFailure(directory, result)
    lock = read_json(directory / "lock.json")
    if lock["task"]["digest"] != identity["task_digests"][task]:
        raise ValueError("Task digest differs from the pinned dataset")
    config = TrialConfig.model_validate_json((directory / "config.json").read_text())
    credentials = config.agent.env
    allowed = PROVIDER_ENV[identity["model"].split("/", 1)[0]]
    if (oracle and credentials) or (not oracle and not credentials) or any(
        key not in allowed or value != f"${{{key}}}" for key, value in credentials.items()
    ):
        raise ValueError("Credentials must use selected-provider environment references")
    agent_config = AgentConfig(name="oracle") if oracle else AgentConfig(
        import_path="diffex_terminal_bench.adapter:DiffexAgent", model_name=identity["model"],
        override_setup_timeout_sec=630, kwargs=identity["policy"], env=credentials)
    label = read_json(directory / "cleanup-request.json")["label"]
    expected_config = TrialConfig(task=config.task, trial_name=config.trial_name, trials_dir=config.trials_dir,
        agent=agent_config, environment=EnvironmentConfig(
            import_path="diffex_terminal_bench.daytona_backend:RecordedDaytonaEnvironment", delete=True,
            kwargs={"labels": {"diffex.gate_trial": label}}))
    if config.model_dump() != expected_config.model_dump():
        raise ValueError("Harbor configuration changed task limits, policy, or isolation")
    for key in ("agent", "environment", "timeout_multiplier", "agent_timeout_multiplier", "verifier_timeout_multiplier",
                "agent_setup_timeout_multiplier", "environment_build_timeout_multiplier", "install_only"):
        if lock.get(key) != config.model_dump(mode="json", exclude_none=True).get(key):
            raise ValueError(f"Harbor lock does not match configuration: {key}")
    cleanup = read_json(directory / "sandbox-cleanup.json")
    if cleanup.get("confirmed") is not True or cleanup.get("unexpected_sandboxes") != []:
        raise ValueError("Sandbox cleanup failed or required recovery")
    if not read_json(directory / "sandbox-created.json").get("sandboxes"):
        raise ValueError("Missing sandbox creation evidence")
    rewards = (result.get("verifier_result") or {}).get("rewards")
    if not isinstance(rewards, dict) or not rewards or any(
        type(value) not in (int, float) or not math.isfinite(value) for value in rewards.values()
    ):
        raise ValueError("Missing or invalid verifier reward")
    verifier = directory / "verifier"
    reward_path = verifier / "reward.json"
    saved_rewards = read_json(reward_path) if reward_path.exists() else {"reward": float((verifier / "reward.txt").read_text())}
    if saved_rewards != rewards:
        raise ValueError("Verifier reward does not reconcile with Harbor")
    # Harbor redirects both verifier streams to test-stdout.txt.
    if not (verifier / "test-stdout.txt").is_file():
        raise ValueError("Missing combined verifier log: test-stdout.txt")
    if oracle:
        if any(value != 1 for value in rewards.values()):
            raise ValueError("Oracle smoke must earn full reward")
        (directory / "agent/oracle.txt").read_bytes()
        return {"rewards": rewards, "usage": "not_applicable", "trajectory": "not_applicable"}

    agent = directory / "agent"
    installation = read_json(agent / "setup/installation.json")
    expected = {"verified": True, "harbor_version": PINS["harbor_version"],
                "background_process_lifetime": "environment",
                "node_version": f"v{PINS['node_version']}", "diffex_version": PINS["diffex_version"],
                "npm_integrity": PINS["diffex_integrity"], "npm_registry": PINS["npm_registry"]}
    if any(installation.get(key) != value for key, value in expected.items()):
        raise ValueError("Installation evidence differs from pins")
    if not 0 <= installation["elapsed_sec"] < PINS["setup_timeout_sec"]:
        raise ValueError("Installation missed its deadline")
    for command in ("version", "help", "list-models"):
        if not (agent / f"setup/{command}.stdout.txt").read_text().strip():
            raise ValueError(f"Missing install check: {command}")
        (agent / f"setup/{command}.stderr.txt").read_bytes()
    runs = sorted(agent.glob("run-*"))
    if len(runs) != 1:
        raise ValueError("Expected one isolated Diffex run")
    run = runs[0]
    outcome = read_json(run / "outcome.json")
    if outcome.get("status") != "completed" or outcome.get("recovery_errors"):
        raise ValueError("Diffex did not complete cleanly")
    native_outcome = parse_outcome(run, launcher_exit_code=outcome.get("launcher_exit_code"))
    if native_outcome["status"] != "completed":
        raise ValueError("Native execution evidence does not establish completion")
    if any(outcome.get(key) != native_outcome.get(key) for key in (
            "agent_execution_stopped", "cleanup_confirmed", "retained_processes")):
        raise ValueError("Outcome differs from process ownership evidence")
    requested, effective = read_json(run / "requested.json"), read_json(run / "effective.json")
    provider, model = identity["model"].split("/", 1)
    policy = identity["policy"]
    tools = policy["tools"].split(",") + (list(SUBAGENT_TOOLS) if policy["subagents"] == "enabled" else [])
    for key, value in {"provider": provider, "model": model, "thinking": policy["thinking"],
                       "subagents": policy["subagents"], "project_resources": policy["project_resources"],
                       "background_process_lifetime": policy["background_process_lifetime"],
                       "pins": PINS, "tools": tools, "evolution": {"enabled": False}, "state_policy": "fresh-per-run"}.items():
        if requested.get(key) != value:
            raise ValueError(f"Requested configuration differs from gate identity: {key}")
    if sha256(run / "instruction.txt") != requested["instruction_sha256"]:
        raise ValueError("Retained instruction changed")
    if sha256(run / "system-prompt.txt") != effective["system_prompt_sha256"]:
        raise ValueError("System prompt hash mismatch")
    if effective["system_prompt_sha256"] != identity["system_prompt_sha256"]:
        raise ValueError("Eval system prompt identity mismatch")
    for name in ("stderr.log", "launcher.stdout.log", "launcher.stderr.log", "sessions/root.jsonl"):
        (run / name).read_bytes()
    validator = TrajectoryValidator()
    if not validator.validate(agent / "trajectory.json"):
        raise ValueError("Invalid ATIF trajectory")
    with tempfile.TemporaryDirectory(prefix="diffex-accounting-") as temp:
        # Export uses a temporary copy because it also writes accounting.json.
        # Retained evidence must never be repaired implicitly by the gate.
        source = Path(temp) / "run"
        source.mkdir()
        for name in ("requested.json", "stdout.jsonl", "system-prompt.txt"):
            (source / name).write_bytes((run / name).read_bytes())
        for path in (run / "sessions").rglob("*.jsonl"):
            target = source / path.relative_to(run)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(path.read_bytes())
        context = AgentContext()
        accounting = export_trajectory(source, Path(temp) / "trajectory.json", context, outcome)
        if accounting["gaps"]:
            raise ValueError(f"Native evidence is incomplete: {', '.join(accounting['gaps'])}")
        if accounting != read_json(run / "accounting.json"):
            raise ValueError("Usage does not reconcile with native sessions")
        if read_json(Path(temp) / "trajectory.json") != read_json(agent / "trajectory.json"):
            raise ValueError("ATIF differs from authoritative native evidence")
        for path in (Path(temp) / "trajectory-media").glob("*"):
            if sha256(path) != sha256(agent / "trajectory-media" / path.name):
                raise ValueError("Trajectory media changed")
        saved_context = result.get("agent_result") or {}
        if (saved_context.get("metadata") or {}).get("diffex_accounting") != accounting:
            raise ValueError("Harbor accounting metadata differs from native evidence")
        if any(saved_context.get(field) != getattr(context, field) for field in CONTEXT_FIELDS):
            raise ValueError("Harbor usage differs from native usage")
        if saved_context.get("model_usage") != context.model_dump(mode="json")["model_usage"]:
            raise ValueError("Per-model usage differs from native usage")
    return {"rewards": rewards, "usage": accounting["totals"], "usage_complete": accounting["complete"],
            "usage_missing_fields": accounting["missing_fields"], "trajectory": "validated",
            "system_prompt_sha256": effective["system_prompt_sha256"], "installation": installation}
