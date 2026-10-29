#!/usr/bin/env python3
"""Extract a verified candidate, rejecting escaping paths/links and credential files."""
import os
import pwd
import stat
import tempfile
from pathlib import Path, PurePosixPath
import sys
import tarfile


def local_path(value):
    """Confine CLI paths to the workspace, account home, or temporary storage."""
    value = Path(value)
    if '..' in value.parts:
        raise ValueError('path traversal is not permitted')
    temporary = [tempfile.gettempdir(), '/tmp']
    if sys.platform == 'darwin':
        native = os.confstr(65537)  # _CS_DARWIN_USER_TEMP_DIR, independent of TMPDIR.
        if not native:
            raise ValueError('missing OS user temporary directory')
        metadata = os.stat(os.path.realpath(native))
        if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid() or
                stat.S_IMODE(metadata.st_mode) & 0o077):
            raise ValueError('OS user temporary directory is not owner-private')
        temporary.append(native)
    roots = {os.path.abspath(root) for root in
             (os.getcwd(), pwd.getpwuid(os.getuid()).pw_dir, *temporary)}
    roots.discard(os.path.sep)
    roots.update(os.path.realpath(root) for root in tuple(roots))
    absolute = os.path.abspath(value)
    if not absolute.startswith(tuple(root + os.path.sep for root in roots)):
        raise ValueError('path outside local artifact roots')
    scope = max((root for root in roots if absolute.startswith(root + os.path.sep)), key=len)
    canonical_scope = os.path.realpath(scope)
    canonical = os.path.realpath(absolute)
    if not canonical.startswith(canonical_scope + os.path.sep):
        raise ValueError('path outside local artifact root')
    if canonical != os.path.join(canonical_scope, os.path.relpath(absolute, scope)):
        raise ValueError('local artifact path traverses a symlink')
    return Path(canonical)


def contained_member(member, destination):
    """Apply Python's data filter and explicitly validate each resolved write."""
    member = tarfile.data_filter(member, destination)
    target = os.path.realpath(os.path.join(destination, member.name))
    if not target.startswith(str(destination) + os.path.sep):
        raise ValueError('escaping archive entry')
    payload_root = os.path.join(destination, 'diffex')
    if target != payload_root and not target.startswith(payload_root + os.path.sep):
        raise ValueError('archive entry outside payload')
    if member.issym() or member.islnk():
        linked = os.path.realpath(os.path.join(os.path.dirname(target), member.linkname)
                                  if member.issym() else os.path.join(destination, member.linkname))
        if linked != payload_root and not linked.startswith(payload_root + os.path.sep):
            raise ValueError('escaping archive link')
    return member


def extract(archive, destination):
    archive = local_path(archive)
    root = local_path(destination)
    with tarfile.open(archive) as source:
        names = set()
        for member in source.getmembers():
            path = PurePosixPath(member.name)
            absolute = os.path.abspath(os.path.join(root, member.name))
            if not absolute.startswith(str(root) + os.path.sep):
                raise ValueError('escaping archive entry')
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
        # Full validation precedes creation; the filter also checks actual writes
        # after earlier members may have introduced directory links.
        root.mkdir(parents=True, exist_ok=False)
        source.extractall(root, filter=contained_member)
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            canonical = os.path.realpath(os.path.join(directory, name))
            if not canonical.startswith(str(root) + os.path.sep):
                raise ValueError("escaping extracted path")


if __name__ == "__main__":
    try:
        extract(*sys.argv[1:])
    except Exception:
        print("Candidate extraction failed safety checks", file=sys.stderr)
        raise SystemExit(1)
