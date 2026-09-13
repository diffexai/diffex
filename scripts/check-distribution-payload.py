"""Inspect distributable archive bytes without extracting untrusted paths.

Archive members, nested archives, JSON source maps, inline mapping directives,
and native resource strings are inspected. This is a disclosure gate, not a
claim that delivered programs cannot be reverse engineered.
"""

import argparse
import hashlib
import io
import json
import re
import tarfile
import zipfile
from pathlib import Path, PurePosixPath


MAX_BYTES = 1024 * 1024 * 1024
MAX_FILES = 100000
MAX_DEPTH = 8
SOURCE_SUFFIXES = {'.ts', '.tsx', '.mts', '.cts', '.c', '.h', '.cc', '.cpp', '.rs', '.py', '.map'}
MAP_DIRECTIVE = re.compile(rb'(?://[#@]|/\*[#@])\s*sourceMappingURL\s*=')
MAP_CONTENT = re.compile(rb'["\']sourcesContent["\']\s*:')
TS_CONTENT = re.compile(rb'(?m)^\s*(?:export\s+)?(?:interface\s+\w+\s*(?:extends[^\n]+)?\{|type\s+\w+\s*=)')


class PayloadError(ValueError):
    pass


def fail(path, reason):
    raise PayloadError(f'{path}: {reason}')


def check_path(name, directory=False):
    path = PurePosixPath(name)
    if not name or name.startswith('/') or '\\' in name or '..' in path.parts or ':' in name or str(path) != name.rstrip('/'):
        fail(name, 'unsafe archive path')
    if any(part in {'.git', '.env', 'src', 'examples', '__MACOSX'} or part.startswith(('._', '.env.')) for part in path.parts):
        fail(name, 'prohibited source or private path')
    if any(part.lower() == 'agents.md' for part in path.parts):
        fail(name, 'prohibited repository instructions')
    declaration = name.endswith(('.d.ts', '.d.mts', '.d.cts'))
    if path.suffix in SOURCE_SUFFIXES and not declaration:
        fail(name, 'prohibited source file')
    if not directory and 'vendor' in path.parts:
        index = path.parts.index('vendor')
        vendor = path.parts[index + 1:]
        export_vendor = '/export-html/vendor/' in '/' + name
        if not export_vendor and (not vendor or vendor[0] not in {'evolution', 'harness-trace'}):
            fail(name, 'unapproved vendored workspace')
        if not export_vendor and (len(vendor) < 2 or 'dist' in vendor[1:]):
            fail(name, 'duplicated or malformed vendored build')
    return declaration


def scan_bytes(data, path, budget, depth=0):
    if depth > MAX_DEPTH:
        fail(path, 'archive nesting limit exceeded')
    budget['bytes'] += len(data)
    budget['files'] += 1
    if budget['bytes'] > MAX_BYTES or budget['files'] > MAX_FILES:
        fail(path, 'inspection resource limit exceeded')
    declaration = check_path(path)
    if MAP_DIRECTIVE.search(data) or MAP_CONTENT.search(data):
        fail(path, 'embedded source map')
    if not declaration and PurePosixPath(path).suffix not in {'.md', '.html'} and TS_CONTENT.search(data):
        fail(path, 'TypeScript implementation content')
    stream = io.BytesIO(data)
    if zipfile.is_zipfile(stream):
        with zipfile.ZipFile(stream) as archive:
            seen = set()
            for item in archive.infolist():
                check_path(item.filename, directory=item.is_dir())
                if item.filename.rstrip('/') in seen:
                    fail(item.filename, 'duplicate archive path')
                seen.add(item.filename.rstrip('/'))
                if item.is_dir():
                    continue
                if item.file_size > MAX_BYTES - budget['bytes']:
                    fail(path, 'archive expansion limit exceeded')
                if (item.external_attr >> 16) & 0o170000 == 0o120000:
                    fail(item.filename, 'archive links are prohibited')
                check_path(item.filename)
                scan_bytes(archive.read(item), path + '/' + item.filename, budget, depth + 1)
        return
    stream.seek(0)
    try:
        archive = tarfile.open(fileobj=stream, mode='r:*')
    except tarfile.ReadError:
        return
    with archive:
        seen = set()
        for item in archive:
            check_path(item.name, directory=item.isdir())
            if item.name.rstrip('/') in seen:
                fail(item.name, 'duplicate archive path')
            seen.add(item.name.rstrip('/'))
            if item.isdir():
                continue
            if not item.isfile():
                fail(item.name, 'archive links and special files are prohibited')
            if item.size > MAX_BYTES - budget['bytes']:
                fail(path, 'archive expansion limit exceeded')
            check_path(item.name)
            scan_bytes(archive.extractfile(item).read(), path + '/' + item.name, budget, depth + 1)


def inspect_archive(file, license_file, expected_name=None, expected_version=None):
    data = Path(file).read_bytes()
    budget = {'files': 0, 'bytes': 0}
    scan_bytes(data, Path(file).name, budget)
    if zipfile.is_zipfile(io.BytesIO(data)):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = {item.filename: archive.read(item) for item in archive.infolist() if not item.is_dir()}
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:*') as archive:
            entries = {item.name: archive.extractfile(item).read() for item in archive if item.isfile()}
    roots = [name[:-len('package.json')] for name in entries if name in {'package.json', 'package/package.json', 'diffex/package.json'}]
    if len(roots) != 1:
        fail(str(file), 'missing or ambiguous distribution root')
    root = roots[0]
    if root and any(not name.startswith(root) for name in entries):
        fail(str(file), 'file outside distribution root')
    for notice in ['LICENSE', 'THIRD-PARTY-NOTICES.txt', 'distribution-components.json', 'distribution-files.json']:
        if not entries.get(root + notice, b'').strip():
            fail(str(file), 'missing required notice: ' + notice)
    if entries[root + 'LICENSE'] != Path(license_file).read_bytes():
        fail(str(file), 'license text differs from reviewed root license')
    metadata = json.loads(entries[root + 'package.json'])
    if metadata.get('license') != 'Apache-2.0':
        fail(str(file), 'package license must be Apache-2.0')
    if metadata.get('private'):
        fail(str(file), 'private workspace cannot be a public package')
    if expected_name and metadata.get('name') != expected_name:
        fail(str(file), 'package name mismatch')
    if expected_version and metadata.get('version') != expected_version:
        fail(str(file), 'package version mismatch')
    inventory = json.loads(entries[root + 'distribution-components.json'])
    if not isinstance(inventory, list) or not inventory:
        fail(str(file), 'missing component inventory')
    file_inventory = json.loads(entries[root + 'distribution-files.json'])
    if file_inventory.get('algorithm') != 'sha256' or not re.fullmatch('[a-f0-9]{40}', file_inventory.get('sourceCommit', '')):
        fail(str(file), 'invalid runtime file inventory identity')
    runtime_files = file_inventory.get('files', [])
    expected_paths = sorted(name[len(root):] for name in entries if name.startswith(root + 'dist/') or (name.startswith(root + 'native/') and name.endswith('.node')))
    if sorted(item['path'] for item in runtime_files) != expected_paths:
        fail(str(file), 'runtime file inventory mismatch')
    for item in runtime_files:
        if hashlib.sha256(entries[root + item['path']]).hexdigest() != item['sha256']:
            fail(str(file), 'runtime file hash mismatch')
    if metadata.get('name') == '@diffexai/diffex':
        for field in ['dependencies', 'optionalDependencies', 'peerDependencies']:
            if any(name.startswith('@diffexai/') for name in metadata.get(field, {})):
                fail(str(file), 'CLI must not fetch separate Diffex packages')
        release_files = ['release/distribution-manifest.json', 'release/install-package.json', 'release/install-package-lock.json']
        for name in release_files:
            if not entries.get(root + name, b'').strip():
                fail(str(file), 'missing required release metadata: ' + name)
        manifest, installer, lock = [json.loads(entries[root + name]) for name in release_files]
        version = metadata['version']
        if manifest.get('version') != version or manifest.get('source', {}).get('commit') != file_inventory['sourceCommit']:
            fail(str(file), 'release manifest identity mismatch')
        policy = manifest.get('disclosurePolicy', {})
        if policy.get('status') != 'approved' or policy.get('publicHosting') != 'npmjs' or policy.get('channels', {}).get('npmjs') != 'enable' or policy.get('channels', {}).get('standalone') != 'defer' or manifest.get('binaryPlatforms') != []:
            fail(str(file), 'release manifest violates approved channels')
        packages = manifest.get('packages', [])
        names = [package['name'] for package in packages]
        if names != ['@diffexai/diffex']:
            fail(str(file), 'release manifest package inventory mismatch')
        for package in packages:
            name = package['name']
            url = f'https://registry.npmjs.org/{name}/-/{name.split("/")[-1]}-{version}.tgz'
            if package.get('version') != version or package.get('tarball') != url:
                fail(str(file), 'release manifest package identity mismatch')
        if not set(release_files + ['distribution-files.json']).issubset(manifest.get('publicAssets', [])):
            fail(str(file), 'release manifest asset inventory mismatch')
        installer_name = '@diffexai/diffex-coding-agent-install'
        if installer.get('name') != installer_name or installer.get('version') != version or installer.get('private') is not True or installer.get('dependencies') != {'@diffexai/diffex': version}:
            fail(str(file), 'installer identity mismatch')
        locked_root = lock.get('packages', {}).get('', {})
        locked_cli = lock.get('packages', {}).get('node_modules/@diffexai/diffex', {})
        if lock.get('lockfileVersion') != 3 or lock.get('name') != installer_name or lock.get('version') != version or locked_root.get('dependencies') != installer['dependencies'] or locked_cli.get('version') != version:
            fail(str(file), 'install lock identity mismatch')
    for component in inventory:
        if component.get('notice'):
            notice = entries.get(root + component['notice'])
            if notice is None or hashlib.sha256(notice).hexdigest() != component.get('noticeSha256'):
                fail(str(file), 'component notice hash mismatch')
    return {'name': metadata['name'], 'version': metadata['version'], **budget,
            'payloadFiles': [{'path': name, 'sha256': hashlib.sha256(content).hexdigest()}
                             for name, content in sorted(entries.items())]}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive')
    parser.add_argument('--license', default='LICENSE')
    parser.add_argument('--name')
    parser.add_argument('--version')
    options = parser.parse_args()
    try:
        print(json.dumps(inspect_archive(options.archive, options.license, options.name, options.version)))
    except (PayloadError, ValueError, TypeError, KeyError, AttributeError, OSError, tarfile.TarError, zipfile.BadZipFile) as error:
        parser.exit(1, str(error) + '\n')
