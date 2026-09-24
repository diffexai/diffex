"""Run inside a disposable sandbox with only the completed trial's prefixes."""

import hashlib
import json
from pathlib import Path
import stat
import sys


def prune(roots: list[Path], expected: dict[str, str]) -> int:
    # Check every prefix before deleting anything. Never follow remote links.
    files = []
    directories = []
    for root in roots:
        if root.is_symlink() or not root.is_dir():
            raise ValueError("Missing volume mount")
        for path in root.rglob("*"):
            mode = path.lstat().st_mode
            if stat.S_ISDIR(mode):
                directories.append(path)
                continue
            if not stat.S_ISREG(mode):
                raise ValueError("Volume contains a link or special file")
            relative = path.relative_to(root).as_posix()
            with path.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if expected.get(relative) != digest:
                raise ValueError("Volume file has no matching local copy")
            files.append(path)
    for path in files:
        path.unlink()
    for path in sorted(directories, key=lambda item: len(item.parts), reverse=True):
        path.rmdir()
    if any(any(root.iterdir()) for root in roots):
        raise ValueError("Volume prefix is not empty after cleanup")
    return len(files)


if __name__ == "__main__":
    request = json.loads(Path(sys.argv[1]).read_text())
    count = prune([Path(root) for root in request["roots"]], request["expected"])
    print(json.dumps({"deleted_files": count, "confirmed": True}))
