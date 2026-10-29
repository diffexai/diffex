#!/usr/bin/env python3
"""Extract a verified candidate, rejecting escaping paths/links and credential files."""
import os
from pathlib import Path, PurePosixPath
import sys
import tarfile


def extract(archive, destination):
    root = Path(destination).resolve()
    root.mkdir(parents=True, exist_ok=False)
    with tarfile.open(archive) as source:
        names = set()
        for member in source.getmembers():
            path = PurePosixPath(member.name)
            if (path.is_absolute() or ".." in path.parts or "\\" in member.name
                    or not path.parts or path.parts[0] != "diffex"
                    or member.name in names
                    or not (member.isfile() or member.isdir() or member.issym() or member.islnk())):
                raise ValueError("unsafe archive entry")
            names.add(member.name)
            if path.name in {"auth.json", ".npmrc", ".netrc", ".env"} or path.name.startswith(".env."):
                raise ValueError("credential configuration in archive")
            if member.issym() or member.islnk():
                target = (root / path.parent / member.linkname if member.issym()
                          else root / member.linkname).resolve()
                if not target.is_relative_to(root / "diffex"):
                    raise ValueError("escaping archive link")
        # Python's data filter additionally rejects symlink-parent traversal and devices.
        source.extractall(root, filter="data")
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = Path(directory, name)
            if not path.resolve().is_relative_to(root):
                raise ValueError("escaping extracted path")


if __name__ == "__main__":
    try:
        extract(*sys.argv[1:])
    except Exception:
        print("Candidate extraction failed safety checks", file=sys.stderr)
        raise SystemExit(1)
