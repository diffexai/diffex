"""Bounded, extraction-free Homebrew inspection and deterministic archive creation.

Diffex-owned bytes retain the existing strict disclosure gate. Third-party Node,
npm and installed production packages may retain their upstream source/notices;
that exception never permits credentials, repository state or escaping links.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
import re
import stat
import tarfile
from pathlib import Path, PurePosixPath

import importlib.util
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('distribution_payload', Path(__file__).with_name('check-distribution-payload.py'))
strict = importlib.util.module_from_spec(spec)
spec.loader.exec_module(strict)
MAX_BYTES = 512 * 1024 * 1024
MAX_FILES = 100000
CLI = 'app/node_modules/@diffexai/diffex/'
PRIVATE = {'.git', '.hg', '.svn', '.github', '.diffex', '.pi', '.ssh', '.aws', '.gnupg', '.cache', '__pycache__',
           '.vscode', '.idea', '.npm', '.pnpm-store', '.yarn', '.turbo', '.artifacts', 'workspaces', 'workspace',
           'auth.json', 'credentials.json', 'credentials', 'id_rsa', 'id_dsa', 'id_ed25519', '.npmrc', '.netrc', '.env', '.ds_store', 'npm-debug.log'}


def fail(name, reason):
    raise ValueError(f'{name}: {reason}')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def safe_name(name):
    p = PurePosixPath(name)
    if not name or name.startswith('/') or '\\' in name or ':' in name or str(p) != name.rstrip('/') or any(x in {'.', '..'} for x in p.parts) or any(ord(c) < 32 or ord(c) == 127 for c in name):
        fail(name, 'unsafe archive path')
    return name.rstrip('/')


def link_target(name, target):
    if not target or target.startswith('/') or '\\' in target or ':' in target or any(ord(c) < 32 for c in target):
        fail(name, 'unsafe link target')
    parts = list(PurePosixPath(name).parent.parts)
    for part in target.split('/'):
        if part == '..':
            if len(parts) <= 1:
                fail(name, 'escaping link target')
            parts.pop()
        elif part not in {'', '.'}:
            parts.append(part)
    return '/'.join(parts)


def read_archive(file, root):
    if Path(file).stat().st_size > MAX_BYTES:
        fail(file, 'archive exceeds 512 MiB')
    entries = {}
    folded = set()
    total = 0
    # Bound decompression before tarfile sees PAX/GNU headers: those can otherwise
    # allocate arbitrarily large metadata before yielding the first member.
    with gzip.open(file, 'rb') as zipped:
        expanded = zipped.read(MAX_BYTES + 1)
    if len(expanded) > MAX_BYTES:
        fail(file, 'archive expansion exceeds 512 MiB')
    with tarfile.open(fileobj=io.BytesIO(expanded), mode='r:') as archive:
        for item in archive:
            name = safe_name(item.name)
            if name != root and not name.startswith(root + '/'):
                fail(name, 'member outside archive root')
            if name.casefold() in folded:
                fail(name, 'duplicate or case-colliding archive path')
            folded.add(name.casefold())
            if not (item.isfile() or item.isdir() or item.issym()):
                fail(name, 'hard links and special files are prohibited')
            if item.mode & 0o7000:
                fail(name, 'special permission bits are prohibited')
            if item.size < 0:
                fail(name, 'negative member size')
            total += item.size
            if total > MAX_BYTES or len(entries) >= MAX_FILES:
                fail(file, 'archive expansion/resource limit exceeded')
            if item.issym():
                link_target(name, item.linkname)
                value = ('link', item.linkname, 0o777)
            elif item.isdir():
                value = ('dir', None, 0o755)
            else:
                value = ('file', archive.extractfile(item).read(), 0o755 if item.mode & 0o111 else 0o644)
            entries[name] = value
        if any(expanded[archive.offset:]):
            fail(file, 'nonzero trailing archive data')
    validate_links(entries)
    return entries


def validate_links(entries):
    for name in entries:
        parts = PurePosixPath(name).parts
        for i in range(1, len(parts)):
            ancestor = '/'.join(parts[:i])
            if ancestor in entries and entries[ancestor][0] != 'dir':
                fail(name, 'member below a link or non-directory')
    for name, (kind, value, _) in entries.items():
        if kind != 'link':
            continue
        current = link_target(name, value)
        seen = {name}
        # Resolve links in every component, not only the terminal path.
        for _ in range(128):
            parts = current.split('/')
            changed = False
            for i in range(1, len(parts) + 1):
                prefix = '/'.join(parts[:i])
                entry = entries.get(prefix)
                if entry and entry[0] == 'link':
                    if prefix in seen:
                        fail(name, 'cyclic link')
                    seen.add(prefix)
                    current = '/'.join([link_target(prefix, entry[1]), *parts[i:]])
                    changed = True
                    break
            if not changed:
                if current not in entries and not any(p.startswith(current + '/') for p in entries):
                    fail(name, 'dangling link')
                break
        else:
            fail(name, 'link resolution limit exceeded')


def private_path(name):
    for part in PurePosixPath(name).parts:
        lower = part.lower()
        if lower in PRIVATE or lower.startswith(('.env.', '._', '.npmrc.', '.netrc.')) or lower.endswith(('.pem', '.key', '.p12', '.pfx')):
            fail(name, 'prohibited credential/config/cache/workspace/development record')
    if re.search(r'(^|/)(?:AGENTS|DIFFEX|CLAUDE)\.md$', name, re.I) and name != 'diffex/' + CLI + 'dist/AGENTS.md':
        fail(name, 'prohibited repository instructions')
    if '/docs/release/' in name or '/private-debug/' in name:
        fail(name, 'prohibited development record')


def inventory(entries):
    files = []
    for name, (kind, value, mode) in sorted(entries.items()):
        if kind == 'dir' or name == 'diffex/distribution-files.json':
            continue
        item = {'path': name[len('diffex/'):], 'type': kind, 'mode': mode}
        if kind == 'link':
            item['target'] = value
        else:
            item.update(size=len(value), sha256=sha(value))
        files.append(item)
    return {'schemaVersion': 1, 'algorithm': 'sha256', 'files': files}


def get_json(entries, path):
    entry = entries.get('diffex/' + path)
    if not entry or entry[0] != 'file':
        fail(path, 'missing JSON metadata')
    return json.loads(entry[1])


def required(entries, path):
    entry = entries.get('diffex/' + path)
    if not entry or entry[0] != 'file' or not entry[1].strip():
        fail(path, 'missing required file')
    return entry[1]


def validate_installed(entries, metadata):
    lock = get_json(entries, 'app/package-lock.json')
    package = get_json(entries, 'app/package.json')
    packages = lock.get('packages', {})
    if lock.get('lockfileVersion') != 3 or package.get('dependencies') != {'@diffexai/diffex': metadata['version']}:
        fail('app', 'install lock/root identity mismatch')
    original = get_json(entries, CLI + 'release/install-package-lock.json')
    expected = json.loads(json.dumps(original))
    expected['packages']['node_modules/@diffexai/diffex']['integrity'] = metadata.get('application', {}).get('integrity')
    if lock != expected or package != get_json(entries, CLI + 'release/install-package.json'):
        fail('app', 'installed lock differs from retained generated install lock')
    platform, arch = metadata['platform'].split('-')

    def supported(entry):
        for key, value in [('os', platform), ('cpu', arch), ('libc', 'glibc')]:
            values = entry.get(key, [])
            if isinstance(values, str):
                values = [values]
            positive = [v for v in values if not v.startswith('!')]
            if '!' + value in values or (positive and value not in positive and 'any' not in positive):
                return False
        return True

    actual = {}
    for name, (kind, value, _) in entries.items():
        local = name.removeprefix('diffex/app/')
        if kind != 'file' or not local.startswith('node_modules/') or not local.endswith('/package.json'):
            continue
        package_path = local[:-len('/package.json')]
        # Only npm installation locations, not source fixtures or bundled dist/node_modules.
        if not re.fullmatch(r'node_modules/(?:@[^/]+/)?[^/]+(?:/node_modules/(?:@[^/]+/)?[^/]+)*', package_path):
            continue
        if package_path not in packages:
            fail(name, 'installed package absent from reviewed lock')
        info = json.loads(value)
        expected = packages[package_path]
        pkg_name = package_path.rsplit('node_modules/', 1)[1]
        if info.get('name') != pkg_name or info.get('version') != expected.get('version') or not supported(expected):
            fail(name, 'installed package identity differs from reviewed lock/target')
        actual[package_path] = info
    for path, entry in packages.items():
        if not path:
            continue
        safe_name(path)
        if not path.startswith('node_modules/') or entry.get('link') or entry.get('dev') or entry.get('devOptional') or entry.get('extraneous'):
            fail(path, 'invalid reviewed production lock entry')
        if supported(entry) and path not in actual:
            fail(path, 'missing production dependency (including supported optional dependencies)')
        if path != 'node_modules/@diffexai/diffex' and (not entry.get('integrity', '').startswith('sha512-') or not entry.get('resolved', '').startswith('https://registry.npmjs.org/')):
            fail(path, 'unreviewed external package identity')
    for name, (kind, _, _) in entries.items():
        prefix = 'diffex/app/'
        if not name.startswith(prefix) or kind == 'dir':
            continue
        local = name[len(prefix):]
        if local in {'package.json', 'package-lock.json'}:
            continue
        if local.startswith('node_modules/.bin/') and kind == 'link':
            continue
        owner = re.match(r'^(node_modules/(?:@[^/]+/)?[^/]+(?:/node_modules/(?:@[^/]+/)?[^/]+)*)(?:/|$)', local)
        if not owner or owner[1] not in actual:
            fail(name, 'unattributed application file outside locked production packages')
    return [{'path': p, 'name': v['name'], 'version': v['version'], 'integrity': packages[p].get('integrity')} for p, v in sorted(actual.items())]


def inspect_entries(entries, license_file):
    for name in entries:
        private_path(name)
        local = name.removeprefix('diffex/')
        if local != 'diffex' and not (local.startswith(('bin/', 'runtime/', 'app/')) or local in {
                'bin', 'runtime', 'app', 'distribution.json', 'distribution-files.json', 'distribution-components.json', 'LICENSE', 'THIRD-PARTY-NOTICES.txt'}):
            fail(name, 'unapproved top-level payload')
    metadata = get_json(entries, 'distribution.json')
    if metadata.get('schemaVersion') != 1 or metadata.get('product') != '@diffexai/diffex' or metadata.get('platform') not in {'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'} or not re.fullmatch(r'\d+\.\d+\.\d+', metadata.get('version', '')) or not re.fullmatch('[a-f0-9]{40}', metadata.get('sourceCommit', '')):
        fail('distribution.json', 'invalid distribution identity')
    if get_json(entries, 'distribution-files.json') != inventory(entries):
        fail('distribution-files.json', 'payload inventory mismatch')
    if required(entries, 'LICENSE') != Path(license_file).read_bytes():
        fail('LICENSE', 'license text differs from reviewed root license')
    for path in ['bin/diffex', 'runtime/bin/node', 'runtime/LICENSE', 'runtime/lib/node_modules/npm/bin/npm-cli.js',
                 'THIRD-PARTY-NOTICES.txt', CLI + 'dist/cli.js']:
        required(entries, path)
    for name, (kind, _, _) in entries.items():
        local = name.removeprefix('diffex/')
        if kind == 'dir':
            continue
        if local.startswith('bin/') and local != 'bin/diffex':
            fail(name, 'unapproved executable')
        if local.startswith('runtime/') and local not in {'runtime/bin/node', 'runtime/LICENSE', 'runtime/release-key.asc', 'runtime/SHASUMS256.txt', 'runtime/SHASUMS256.txt.sig'} and not local.startswith('runtime/lib/node_modules/npm/'):
            fail(name, 'unapproved private runtime payload')
    runtime = metadata.get('runtime', {})
    if not re.fullmatch(r'22\.\d+\.\d+', runtime.get('nodeVersion', '')) or runtime.get('filename') != f"node-v{runtime['nodeVersion']}-{metadata['platform']}.tar.gz" or runtime.get('url') != f"https://nodejs.org/dist/v{runtime['nodeVersion']}/{runtime['filename']}":
        fail('runtime', 'unapproved runtime identity/URL')
    if metadata.get('archiveUrl') != f"https://github.com/diffexai/diffex/releases/download/v{metadata['version']}/diffex-{metadata['version']}-{metadata['platform']}.tar.gz":
        fail('distribution.json', 'unapproved archive URL')
    for path, field in [('runtime/SHASUMS256.txt', 'checksumsSha256'), ('runtime/SHASUMS256.txt.sig', 'signatureSha256'), ('runtime/release-key.asc', 'releaseKeySha256'), ('runtime/bin/node', 'nodeSha256')]:
        if sha(required(entries, path)) != runtime.get(field):
            fail(path, 'official runtime verification proof mismatch')
    for path in ['bin/diffex', 'runtime/bin/node']:
        if entries['diffex/' + path][2] != 0o755:
            fail(path, 'required executable permission missing')
    npm = get_json(entries, 'runtime/lib/node_modules/npm/package.json')
    if npm.get('name') != 'npm' or npm.get('version') != metadata.get('runtime', {}).get('npmVersion'):
        fail('runtime', 'private npm identity mismatch')
    components = get_json(entries, 'distribution-components.json')
    if not isinstance(components, list) or not components:
        fail('distribution-components.json', 'missing third-party component inventory')
    for component in components:
        notice = component.get('notice')
        if notice and (safe_name(notice) != notice or sha(required(entries, notice)) != component.get('noticeSha256')):
            fail(str(notice), 'component notice mismatch')
        for legal in component.get('legalFiles', []):
            if safe_name(legal['path']) != legal['path'] or sha(required(entries, legal['path'])) != legal['sha256']:
                fail(legal['path'], 'upstream legal file mismatch')
    installed = validate_installed(entries, metadata)
    if metadata.get('packages') != installed:
        fail('distribution.json', 'installed package identity inventory mismatch')
    # Reconstruct only the Diffex-owned package for the existing strict gate.
    # npm-installed nested dependencies are independently checked against the lock.
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as archive:
        for name, (kind, value, _) in entries.items():
            prefix = 'diffex/' + CLI
            if not name.startswith(prefix):
                continue
            local = name[len(prefix):]
            if local.startswith('node_modules/') or not local or kind == 'dir':
                continue
            if kind != 'file':
                fail(name, 'links in Diffex-owned payload are prohibited')
            item = tarfile.TarInfo('package/' + local)
            item.size = len(value)
            archive.addfile(item, io.BytesIO(value))
    # Existing checker expects an on-disk file and verifies legal/docs/runtime hashes.
    import tempfile
    with tempfile.TemporaryDirectory(prefix='diffex-homebrew-owned-') as temporary:
        candidate = Path(temporary, 'package.tgz')
        candidate.write_bytes(stream.getvalue())
        inspected = strict.inspect_archive(candidate, license_file, '@diffexai/diffex', metadata['version'])
    if get_json(entries, CLI + 'distribution-files.json').get('sourceCommit') != metadata['sourceCommit']:
        fail('distribution.json', 'Diffex source commit differs from archive identity')
    if metadata.get('payloadIdentity') != sha(json.dumps(inspected['payloadFiles'], separators=(',', ':'), sort_keys=True).encode()):
        fail('distribution.json', 'Diffex payload identity mismatch')
    return {'version': metadata['version'], 'sourceCommit': metadata['sourceCommit'], 'platform': metadata['platform'],
            'nodeVersion': metadata['runtime']['nodeVersion'], 'npmVersion': metadata['runtime']['npmVersion'],
            'inventorySha256': sha(required(entries, 'distribution-files.json'))}


def tree_entries(root):
    root = Path(root)
    entries = {'diffex': ('dir', None, 0o755)}
    total = 0
    for directory, dirs, files in os.walk(root, followlinks=False):
        for filename in sorted(dirs + files):
            path = Path(directory, filename)
            name = 'diffex/' + path.relative_to(root).as_posix()
            safe_name(name)
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode):
                entries[name] = ('link', os.readlink(path), 0o777)
            elif stat.S_ISDIR(mode):
                entries[name] = ('dir', None, 0o755)
            elif stat.S_ISREG(mode):
                total += path.stat().st_size
                if total > MAX_BYTES:
                    fail(name, 'payload exceeds 512 MiB')
                entries[name] = ('file', path.read_bytes(), 0o755 if mode & 0o111 else 0o644)
            else:
                fail(name, 'special file prohibited')
            if len(entries) > MAX_FILES:
                fail(name, 'file count limit exceeded')
    validate_links(entries)
    return entries


def prepare(root, output, license_file):
    entries = tree_entries(root)
    data = (json.dumps(inventory(entries), sort_keys=True, separators=(',', ':')) + '\n').encode()
    Path(root, 'distribution-files.json').write_bytes(data)
    entries['diffex/distribution-files.json'] = ('file', data, 0o644)
    inspected = inspect_entries(entries, license_file)
    with open(output, 'xb') as file:
        with gzip.GzipFile(filename='', mode='wb', fileobj=file, mtime=0, compresslevel=9) as zipped:
            with tarfile.open(fileobj=zipped, mode='w', format=tarfile.GNU_FORMAT) as archive:
                for name, (kind, value, mode) in sorted(entries.items()):
                    item = tarfile.TarInfo(name)
                    item.mode = mode
                    item.mtime = 0
                    if kind == 'dir':
                        item.type = tarfile.DIRTYPE
                    elif kind == 'link':
                        item.type = tarfile.SYMTYPE
                        item.linkname = value
                    else:
                        item.size = len(value)
                    archive.addfile(item, io.BytesIO(value) if kind == 'file' else None)
    if Path(output).stat().st_size > MAX_BYTES:
        fail(output, 'archive exceeds 512 MiB')
    return inspected


def extract(file, output, root):
    entries = read_archive(file, root)
    target = Path(output)
    if target.exists():
        fail(output, 'safe extraction requires a new directory')
    target.mkdir(parents=True)
    # Full validation completed before the first extraction write. Links last.
    for kind_wanted in ['dir', 'file', 'link']:
        for name, (kind, value, mode) in sorted(entries.items()):
            if kind != kind_wanted:
                continue
            path = target.joinpath(*PurePosixPath(name).parts)
            path.parent.mkdir(parents=True, exist_ok=True)
            if kind == 'dir':
                path.mkdir(exist_ok=True)
            elif kind == 'file':
                path.write_bytes(value)
                path.chmod(mode)
            else:
                path.symlink_to(value)
    return {'files': len(entries)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['inspect', 'prepare', 'extract', 'validate'])
    parser.add_argument('input')
    parser.add_argument('output', nargs='?')
    parser.add_argument('--root', default='diffex')
    parser.add_argument('--license', default=str(Path(__file__).resolve().parent.parent / 'LICENSE'))
    args = parser.parse_args()
    try:
        if args.command == 'validate':
            result = {'files': len(read_archive(args.input, args.root))}
        elif args.command == 'extract':
            result = extract(args.input, args.output, args.root)
        elif args.command == 'prepare':
            result = prepare(args.input, args.output, args.license)
        else:
            result = inspect_entries(read_archive(args.input, 'diffex'), args.license)
        print(json.dumps(result, sort_keys=True))
    except (ValueError, OSError, EOFError, KeyError, TypeError, AttributeError, tarfile.TarError) as error:
        parser.exit(1, str(error) + '\n')
