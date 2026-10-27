#!/usr/bin/env python3
"""Fail-closed publication guard; credentials enter only through mode-whitelisted env."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile


REPORT = "publication-safety.json"
AUTH_NAMES = {"auth.json", "auth.jsonl", "credentials", "credentials.json", ".credentials",
              ".npmrc", ".netrc", "_netrc", ".git-credentials", ".env", ".ssh", ".aws"}


def sanitize(root: Path, output: Path, mode: str) -> bool:
    """Publish only a fully scanned copy. Return False on any credential match.

    No original content digests, exception details or unsanitized names are emitted.
    Auth entries and symlinks are excluded without opening them. The source is not
    modified, so recovery can still use its original state before publication.
    """
    names = ["DAYTONA_API_KEY"] + (["OPENAI_API_KEY"] if mode == "live" else [])
    secrets = sorted({os.environ[name].encode() for name in names if os.environ.get(name)}, key=len, reverse=True)
    # Missing secrets make a complete publication scan impossible, not successful.
    if len([name for name in names if os.environ.get(name)]) != len(names):
        raise ValueError("missing scan credential")
    if root.is_symlink() or not root.is_dir():
        raise ValueError("invalid evidence root")
    root = root.resolve()
    output = output.absolute()
    if output.is_relative_to(root) or root.is_relative_to(output.resolve()) or output.exists() or output.is_symlink():
        raise ValueError("invalid publication destination")
    if output.resolve() != output:
        raise ValueError("publication destination traverses a symlink")
    output.parent.mkdir(parents=True, exist_ok=True)
    replacement = b"[REDACTED]"
    if any(secret in replacement for secret in secrets):
        replacement = b""
    matches = 0
    excluded = []
    files = []

    def redact(data: bytes) -> bytes:
        nonlocal matches
        for secret in secrets:
            matches += data.count(secret)
            data = data.replace(secret, replacement)
        return data

    def visit(source: Path, target: Path, relative: Path) -> None:
        for entry in sorted(source.iterdir()):
            safe_name = os.fsdecode(redact(os.fsencode(entry.name)))
            if not safe_name or safe_name in {".", ".."}:
                raise ValueError("invalid sanitized name")
            safe_relative = relative / safe_name
            metadata = entry.lstat()
            lower = entry.name.lower()
            reason = None
            if stat.S_ISLNK(metadata.st_mode):
                reason = "symlink"
            elif lower in AUTH_NAMES or lower.startswith(".env.") or (lower.startswith("auth.") and lower.endswith(".json")):
                reason = "auth"
            elif not stat.S_ISDIR(metadata.st_mode) and not stat.S_ISREG(metadata.st_mode):
                reason = "special"
            if reason:
                excluded.append({"path": safe_relative.as_posix(), "reason": reason})
                continue
            destination = target / safe_name
            if destination.exists() or (relative == Path() and safe_name == REPORT):
                raise ValueError("publication name collision")
            if stat.S_ISDIR(metadata.st_mode):
                destination.mkdir()
                visit(entry, destination, safe_relative)
                continue
            # O_NOFOLLOW rejects a symlink swapped in between lstat and open.
            descriptor = os.open(entry, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, "rb") as stream:
                opened = os.fstat(stream.fileno())
                if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
                    raise ValueError("evidence changed during scan")
                data = redact(stream.read())
            destination.write_bytes(data)
            files.append({"path": safe_relative.as_posix(), "size": len(data),
                          "sha256": hashlib.sha256(data).hexdigest()})

    temporary = Path(tempfile.mkdtemp(prefix=".publication-", dir=output.parent))
    try:
        visit(root, temporary, Path())
        report = {"schemaVersion": 1, "safe_to_upload": True, "mode": mode,
                  "credential_names": names, "credential_matches": matches,
                  "outcome": "credential-found" if matches else "clean",
                  "files_scanned": len(files), "files": files,
                  "excluded_count": len(excluded), "excluded": excluded}
        (temporary / REPORT).write_text(json.dumps(report, indent=2) + "\n")
        # Verify report, path metadata and final bytes too; never expose an unsafe copy.
        for path in temporary.rglob("*"):
            if any(secret in os.fsencode(path.relative_to(temporary)) for secret in secrets):
                raise ValueError("unsafe publication path")
            if path.is_file() and any(secret in path.read_bytes() for secret in secrets):
                raise ValueError("unsafe publication bytes")
        temporary.rename(output)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return matches == 0


def set_output(safe: bool) -> None:
    destination = os.environ.get("GITHUB_OUTPUT")
    if destination:
        with open(destination, "a", encoding="utf-8") as stream:
            stream.write(f"safe_to_upload={'true' if safe else 'false'}\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--mode", choices=["deterministic", "live"], required=True)
    args = parser.parse_args()
    try:
        set_output(False)
        clean = sanitize(args.root, args.output, args.mode)
        set_output(True)
    except Exception:
        # Exceptions can embed raw filenames/content, so do not print their details.
        print("Evidence publication guard failed; upload is blocked.")
        return 1
    if not clean:
        print("Evidence publication guard found credentials; sanitized evidence only, job failed.")
        return 1
    print("Evidence publication guard passed; sanitized evidence is safe to upload.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
