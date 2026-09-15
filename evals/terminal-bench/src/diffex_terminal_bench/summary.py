"""Local, rebuildable navigation for retained qualification evidence."""

from datetime import datetime, timezone
import fcntl
from html import escape
import json
import os
from pathlib import Path
import sys
import tempfile
from urllib.parse import quote

from diffex_terminal_bench.gate import STAGES


def read_report(path: Path) -> dict:
    if path.is_symlink():
        raise ValueError("Summary reports must not be symlinks")
    report = json.loads(path.read_text())
    if not isinstance(report, dict):
        raise ValueError("Expected an object")
    return report


def cell(value: object) -> str:
    text = escape(str(value)).replace("\n", " ").replace("\r", " ")
    for character in ("\\", "|", "[", "]", "*", "_", "`"):
        text = text.replace(character, "\\" + character)
    return text


def run_row(root: Path) -> str | None:
    dataset_path = root / "dataset.json"
    gates = [root / stage / "gate.json" for stage in STAGES]
    if not dataset_path.exists() and not any(path.exists() for path in gates):
        return None
    model, thinking, dataset = "unknown", "unknown", "unknown"
    sizes = {}
    if dataset_path.exists():
        try:
            prepared = read_report(dataset_path)
            dataset = f"{prepared['dataset']['name']}@{prepared['dataset']['version']}"
            model = prepared.get("model", model)
            thinking = prepared.get("policy", {}).get("thinking", thinking)
            sizes = prepared.get("stages", {})
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            dataset = "unreadable dataset report"
    stages = []
    for stage, path in zip(STAGES, gates):
        if not path.exists():
            stages.append("not started")
            continue
        try:
            if path.parent.is_symlink():
                raise ValueError("Stage must not be a symlink")
            gate = read_report(path)
            identity = gate["identity"]
            model = identity["model"]
            thinking = identity["policy"]["thinking"]
            dataset = f"{identity['dataset']['name']}@{identity['dataset']['version']}"
            trials = gate["trials"]
            full_reward = sum(bool(rewards) and all(value == 1 for value in rewards.values())
                              for trial in trials for rewards in [trial["evidence"]["rewards"]])
            if gate.get("failure") or (gate.get("finished_at") and gate.get("passed") is not True):
                status = "failed"
            elif gate.get("passed") is True:
                status = "passed"
            else:
                status = "unfinished"
            total = sizes.get(stage)
            progress = f"{len(trials)}/{total}" if total is not None else str(len(trials))
            label = f"{status}; {progress} checked; {full_reward} full reward"
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            label = "unreadable report"
        stages.append(f"[{cell(label)}]({quote(f'{root.name}/{stage}/gate.json', safe='/')})")
    return "| " + " | ".join([
        f"[{cell(root.name)}]({quote(root.name, safe='')}/)",
        cell(model), cell(thinking), cell(dataset), *stages,
    ]) + " |"


def write_index(results: Path) -> Path:
    """Read only small reports; never load sessions or contact a provider."""
    results.mkdir(parents=True, exist_ok=True)
    destination = results / "index.md"
    with (results / ".index.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        rows = []
        directories = [root for root in results.iterdir() if root.is_dir() and not root.is_symlink()]
        for root in sorted(directories, key=lambda path: (path.stat().st_mtime, path.name), reverse=True):
            row = run_row(root)
            if row is not None:
                rows.append(row)
        lines = [
            "# Benchmark runs", "",
            f"Updated: {datetime.now(timezone.utc).isoformat()}", "",
            "These are recorded summaries, not a new verification of the retained evidence.",
            "A passed gate checks execution and evidence; full reward counts task solutions among checked trials.",
            "Unfinished means running or interrupted before a final report was written.",
            "Refresh with `python -m diffex_terminal_bench.benchmark --refresh-index --results-dir PATH`.", "",
            "| Run | Model | Thinking | Dataset | " + " | ".join(STAGES) + " |",
            "| " + " | ".join(["---"] * (4 + len(STAGES))) + " |",
            *rows, "",
        ]
        with tempfile.TemporaryDirectory(dir=results, prefix=".index-") as staging:
            temporary = Path(staging) / "index.md"
            temporary.write_text("\n".join(lines))
            os.replace(temporary, destination)
    return destination


def refresh_index(results: Path) -> None:
    # A navigation failure must never hide a trial exception or skip cleanup.
    try:
        write_index(results)
    except OSError as exc:
        print(f"Could not refresh run index ({type(exc).__name__}); use --refresh-index to retry.", file=sys.stderr)
