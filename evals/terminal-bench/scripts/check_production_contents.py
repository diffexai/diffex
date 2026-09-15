"""Pack public npm workspaces without lifecycle scripts and inspect their bytes."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import tempfile


def inspect_packages(root: Path) -> list[dict[str, object]]:
    root_manifest = json.loads((root / "package.json").read_text())
    if root_manifest.get("private") is not True:
        raise RuntimeError("The repository root must remain npm-private")
    manifests = sorted({
        manifest
        for pattern in root_manifest["workspaces"]
        for directory in root.glob(pattern)
        if (manifest := directory / "package.json").is_file()
    })
    forbidden = {
        "evals", "terminal-bench", "diffex_terminal_bench", ".venv",
        "__pycache__", "uv.lock", "jobs", "results", "harbor",
    }
    reports = []
    with tempfile.TemporaryDirectory(prefix="diffex-production-packs-") as temp:
        for manifest_path in manifests:
            manifest = json.loads(manifest_path.read_text())
            if manifest.get("private") is True:
                continue
            if "evals" in manifest_path.relative_to(root).parts:
                raise RuntimeError(f"Benchmark became a public workspace: {manifest_path}")
            packed = json.loads(subprocess.check_output(
                ["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", temp,
                 "--cache", str(Path(temp) / "npm-cache")],
                cwd=manifest_path.parent, text=True,
            ))[0]
            archive = Path(temp) / packed["filename"]
            with tarfile.open(archive) as tar:
                members = tar.getmembers()
                for member in members:
                    parts = PurePosixPath(member.name).parts
                    if forbidden.intersection(parts):
                        raise RuntimeError(f"Benchmark content in {manifest['name']}: {member.name}")
                if manifest["name"] == "@diffexai/diffex":
                    if "package/dist/cli.js" not in {member.name for member in members}:
                        raise RuntimeError("CLI dist/cli.js is absent; inspect a prepared checkout")
            reports.append({
                "name": manifest["name"],
                "version": manifest["version"],
                "files": len(members),
                "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                "benchmark_content_found": False,
            })
    if not reports:
        raise RuntimeError("No public production packages were inspected")
    return reports


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("results/production-contents.json"))
    args = parser.parse_args()
    repo_root = Path(__file__).resolve().parents[3]
    result = inspect_packages(repo_root)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(f"Inspected {len(result)} production tarballs; no benchmark content: {args.output}")
