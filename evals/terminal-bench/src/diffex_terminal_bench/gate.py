"""Fail-closed evidence checks for staged benchmark qualification."""

from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import tempfile

from harbor.models.agent.context import AgentContext
from harbor.models.trial.config import AgentConfig, EnvironmentConfig, TrialConfig
from harbor.utils.trajectory_validator import TrajectoryValidator

from diffex_terminal_bench.config import PINS
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


def stage_tasks(stage: str, pilot: list[str], all_tasks: list[str]) -> list[str]:
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
    result = {}
    for path in sorted(directory.rglob("*")):
        if path.is_symlink():
            raise ValueError("Evidence must not contain symlinks")
        if path.is_file():
            result[path.relative_to(directory).as_posix()] = sha256(path)
    return result


def require_previous(root: Path, stage: str, identity: dict, pilot: list[str], tasks: list[str]) -> None:
    """Recheck every prior artifact, not just a cached 'passed' flag."""
    for previous in STAGES[:STAGES.index(stage)]:
        directory = root / previous
        report = read_json(directory / "gate.json")
        if report.get("passed") is not True or report.get("identity") != identity:
            raise ValueError(f"{previous}: missing qualification for this exact configuration")
        trials = report.get("trials", [])
        if Counter(row["task"] for row in trials) != Counter(stage_tasks(previous, pilot, tasks)):
            raise ValueError(f"{previous}: trial coverage does not match the stage")
        if len({row["directory"] for row in trials}) != len(trials):
            raise ValueError(f"{previous}: duplicate trial evidence")
        for row in trials:
            trial_dir = directory / row["directory"]
            if trial_dir.resolve().parent != directory.resolve():
                raise ValueError("Trial evidence must be a direct child of its stage")
            if inventory(trial_dir) != row["files"]:
                raise ValueError(f"{previous}: retained evidence changed or is missing")
            validate_trial(trial_dir, row["task"], identity, oracle=previous == "oracle")


def validate_trial(directory: Path, task: str, identity: dict, *, oracle: bool = False) -> dict:
    """A wrong solution is a result; broken execution or missing evidence is not."""
    result = read_json(directory / "result.json")
    if result.get("exception_info") or not result.get("finished_at"):
        raise ValueError("Harbor trial did not finish without an exception")
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
        if lock.get(key) != config.model_dump(mode="json")[key]:
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
    for name in ("test-stdout.txt", "test-stderr.txt"):
        if not (verifier / name).is_file():
            raise ValueError(f"Missing verifier log: {name}")
    if oracle:
        if any(value != 1 for value in rewards.values()):
            raise ValueError("Oracle smoke must earn full reward")
        (directory / "agent/oracle.txt").read_bytes()
        return {"rewards": rewards, "usage": "not_applicable", "trajectory": "not_applicable"}

    agent = directory / "agent"
    installation = read_json(agent / "setup/installation.json")
    expected = {"verified": True, "harbor_version": PINS["harbor_version"],
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
    if parse_outcome(run, launcher_exit_code=outcome.get("launcher_exit_code"))["status"] != "completed":
        raise ValueError("Native execution evidence does not establish completion")
    requested, effective = read_json(run / "requested.json"), read_json(run / "effective.json")
    provider, model = identity["model"].split("/", 1)
    policy = identity["policy"]
    tools = policy["tools"].split(",") + (list(SUBAGENT_TOOLS) if policy["subagents"] == "enabled" else [])
    for key, value in {"provider": provider, "model": model, "thinking": policy["thinking"],
                       "subagents": policy["subagents"], "project_resources": policy["project_resources"],
                       "pins": PINS, "tools": tools, "evolution": {"enabled": False}, "state_policy": "fresh-per-run"}.items():
        if requested.get(key) != value:
            raise ValueError(f"Requested configuration differs from gate identity: {key}")
    if sha256(run / "instruction.txt") != requested["instruction_sha256"]:
        raise ValueError("Retained instruction changed")
    if sha256(run / "system-prompt.txt") != effective["system_prompt_sha256"]:
        raise ValueError("System prompt hash mismatch")
    if effective["release_agents_sha256"] != identity["release_agents_sha256"]:
        raise ValueError("Release harness identity mismatch")
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
        if not accounting["complete"] or accounting != read_json(run / "accounting.json"):
            raise ValueError("Usage is incomplete or does not reconcile with native sessions")
        if read_json(Path(temp) / "trajectory.json") != read_json(agent / "trajectory.json"):
            raise ValueError("ATIF differs from authoritative native evidence")
        for path in (Path(temp) / "trajectory-media").glob("*"):
            if sha256(path) != sha256(agent / "trajectory-media" / path.name):
                raise ValueError("Trajectory media changed")
        saved_context = result.get("agent_result") or {}
        if any(saved_context.get(field) != getattr(context, field) for field in CONTEXT_FIELDS):
            raise ValueError("Harbor usage differs from native usage")
        if saved_context.get("model_usage") != context.model_dump(mode="json")["model_usage"]:
            raise ValueError("Per-model usage differs from native usage")
    return {"rewards": rewards, "usage": accounting["totals"], "trajectory": "validated",
            "system_prompt_sha256": effective["system_prompt_sha256"], "installation": installation}
