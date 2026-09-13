"""Inspect project payloads in every saved Docker image layer, including deleted files."""
import argparse
import importlib.util
import json
import tarfile
import sys
from pathlib import Path, PurePosixPath

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('payload', Path(__file__).with_name('check-distribution-payload.py'))
payload = importlib.util.module_from_spec(spec)
spec.loader.exec_module(payload)


def inspect_image(filename):
    documents = set()
    workspaces = set()
    notices = set()
    files = 0
    identity = None
    with tarfile.open(filename) as image:
        manifest = json.load(image.extractfile('manifest.json'))
        if len(manifest) != 1:
            raise ValueError('Expected exactly one runtime image')
        config = json.load(image.extractfile(manifest[0]['Config']))
        if config['architecture'] != 'amd64' or config['os'] != 'linux':
            raise ValueError('Expected Linux amd64 runtime')
        for layer in manifest[0]['Layers']:
            with tarfile.open(fileobj=image.extractfile(layer), mode='r|') as archive:
                for entry in archive:
                    name = entry.name.removeprefix('./')
                    if not name.startswith('opt/diffex/') or not entry.isfile():
                        continue
                    if PurePosixPath(name).name.startswith('.wh.'):
                        continue
                    local = name.removeprefix('opt/diffex/')
                    if local.startswith('node_modules/'):
                        continue  # Third-party redistribution notices remain with dependencies.
                    if local == 'runtime-distribution.json':
                        identity = json.load(archive.extractfile(entry))
                        continue
                    if not local.startswith('packages/'):
                        if local not in {'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.txt'}:
                            raise ValueError(f'Unexpected project root file: {local}')
                        continue
                    parts = PurePosixPath(local).parts
                    offset = 3 if parts[1] == 'session-backends' else 2
                    workspace = '/'.join(parts[:offset])
                    relative = '/'.join(parts[offset:])
                    if relative.startswith('node_modules/'):
                        continue
                    workspaces.add(workspace)
                    if relative not in {'package.json', 'LICENSE', 'THIRD-PARTY-NOTICES.txt', 'distribution-components.json', 'distribution-files.json'} and not relative.startswith(('dist/', 'native/', 'docs/')):
                        raise ValueError(f'Unexpected runtime workspace file: {local}')
                    content = archive.extractfile(entry).read()
                    payload.scan_bytes(content, 'package/' + relative, {'bytes': 0, 'files': 0})
                    if relative.startswith('docs/'):
                        documents.add(relative)
                    if relative in {'LICENSE', 'THIRD-PARTY-NOTICES.txt'} and content.strip():
                        notices.add((workspace, relative))
                    files += 1
    if not identity or not workspaces or documents != payload.DOCUMENTATION:
        raise ValueError('Missing runtime identity, workspaces, or approved user documentation')
    for workspace in workspaces:
        for notice in ['LICENSE', 'THIRD-PARTY-NOTICES.txt']:
            if (workspace, notice) not in notices:
                raise ValueError(f'Missing runtime notice: {workspace}/{notice}')
    labels = config['config'].get('Labels', {})
    if labels.get('org.opencontainers.image.revision') != identity['sourceCommit']:
        raise ValueError('Runtime source identity mismatch')
    return {'status': 'passed', 'projectFiles': files, 'workspaces': len(workspaces), 'documentation': sorted(documents), 'sourceCommit': identity['sourceCommit'], 'architecture': config['architecture']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image')
    print(json.dumps(inspect_image(parser.parse_args().image)))
