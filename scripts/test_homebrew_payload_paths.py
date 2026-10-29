"""Focused filesystem-boundary regressions for the Homebrew Python tools."""
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parent


def load_script(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), SCRIPTS / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


payload = load_script('check-homebrew-payload')
candidate = load_script('homebrew-extract')


class HomebrewPayloadPaths(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='homebrew paths ')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()

    def archive(self, members):
        archive = self.root / 'candidate.tar.gz'
        with tarfile.open(archive, 'w:gz') as stream:
            for name, kind, value in members:
                member = tarfile.TarInfo(name)
                member.mode = 0o755 if kind == 'dir' else 0o644
                data = None
                if kind == 'dir':
                    member.type = tarfile.DIRTYPE
                elif kind in {'link', 'hard'}:
                    member.type = tarfile.SYMTYPE if kind == 'link' else tarfile.LNKTYPE
                    member.linkname = value
                else:
                    member.size = len(value)
                    data = io.BytesIO(value)
                stream.addfile(member, data)
        return archive

    def cli(self, name, *args):
        return subprocess.run([sys.executable, str(SCRIPTS / (name + '.py')), *map(str, args)],
                              capture_output=True, text=True, timeout=30)

    def test_trusted_workspace_home_and_temp_paths_remain_supported(self):
        for module in [payload, candidate]:
            with self.subTest(module=module.__name__), \
                    patch.object(module.os, 'getcwd', return_value='/opt/diffex-workspace'), \
                    patch.object(module.pwd, 'getpwuid', return_value=SimpleNamespace(pw_dir='/opt/diffex-home')), \
                    patch.object(module.tempfile, 'gettempdir', return_value='/opt/diffex-temp'):
                for root in ['/opt/diffex-workspace', '/opt/diffex-home', '/opt/diffex-temp', '/tmp']:
                    path = Path(root, 'release with spaces', 'candidate.tar.gz')
                    self.assertEqual(module.local_path(path), Path(os.path.realpath(path)))
                for path in ['/etc/passwd', '/opt/diffex-home-other/candidate',
                             '/opt/diffex-workspace-other/candidate', '/', '/tmp/../etc/passwd']:
                    with self.subTest(path=path), self.assertRaises(ValueError):
                        module.local_path(path)

    def test_relative_paths_are_resolved_inside_the_workspace(self):
        for module in [payload, candidate]:
            with self.subTest(module=module.__name__), patch.object(module.os, 'getcwd', return_value=str(self.root)):
                self.assertEqual(module.local_path('release/candidate.tgz'), self.root / 'release/candidate.tgz')
                with self.assertRaises(ValueError):
                    module.local_path('../candidate.tgz')

    def test_cli_paths_reject_parent_and_final_symlinks_even_inside_trusted_roots(self):
        actual = self.root / 'actual'
        actual.mkdir()
        (actual / 'candidate.tgz').write_bytes(b'fixture')
        alias = self.root / 'alias'
        alias.symlink_to(actual, target_is_directory=True)
        linked_file = self.root / 'linked.tgz'
        linked_file.symlink_to(actual / 'candidate.tgz')
        dangling = self.root / 'dangling'
        dangling.symlink_to(actual / 'missing')
        for module in [payload, candidate]:
            for path in [alias / 'candidate.tgz', alias / 'new-output', linked_file, dangling]:
                with self.subTest(module=module.__name__, path=path), self.assertRaises(ValueError):
                    module.local_path(path)

    def test_cli_rejects_untrusted_inputs_outputs_and_license(self):
        archive = self.archive([('diffex/file', 'file', b'fixture')])
        outside = '/etc/diffex-path-regression-must-not-exist'
        for script, args in [
            ('check-homebrew-payload', ['validate', '/etc/passwd']),
            ('check-homebrew-payload', ['extract', archive, outside]),
            ('check-homebrew-payload', ['prepare', self.root, outside]),
            ('check-homebrew-payload', ['prepare', self.root, self.root / 'out.tgz', '--license', '/etc/passwd']),
            ('homebrew-extract', ['/etc/passwd', self.root / 'unused']),
            ('homebrew-extract', [archive, outside]),
        ]:
            with self.subTest(script=script, args=args):
                result = self.cli(script, *args)
                self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertFalse((self.root / 'unused').exists())
        self.assertFalse((self.root / 'distribution-files.json').exists())
        self.assertFalse((self.root / 'out.tgz').exists())

    def test_archive_root_is_one_safe_component_not_a_filesystem_scope(self):
        for root in ['diffex', 'package', 'node-v22.23.4-darwin-arm64']:
            archive = self.archive([(root + '/file', 'file', b'fixture')])
            with self.subTest(root=root):
                self.assertEqual(len(payload.read_archive(archive, root)), 1)
        archive = self.archive([('diffex/file', 'file', b'fixture')])
        for root in ['', '.', '..', '/', '/tmp', 'diffex/child', 'diffex/', 'diffex/../tmp']:
            with self.subTest(root=root), self.assertRaises(ValueError):
                payload.read_archive(archive, root)

    def test_member_destination_has_its_own_absolute_containment_check(self):
        for name in ['../escape', '/etc/passwd', str(self.root) + '-other/file']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                payload.contained_path(self.root, name)
        (self.root / 'alias').symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            payload.contained_path(self.root, 'alias/file')
        self.assertEqual(payload.contained_path(self.root, 'nested/file'), self.root / 'nested/file')

    def test_both_extractors_preserve_safe_internal_symlink_chains(self):
        archive = self.archive([
            ('diffex/app/pkg/bin/cli', 'file', b'fixture'),
            ('diffex/app/.bin/cli', 'link', '../pkg/bin/cli'),
            ('diffex/app/.bin/alias', 'link', 'cli'),
        ])
        for script, args in [
            ('check-homebrew-payload', ['extract', archive, self.root / 'payload output']),
            ('homebrew-extract', [archive, self.root / 'candidate output']),
        ]:
            with self.subTest(script=script):
                result = self.cli(script, *args)
                self.assertEqual(result.returncode, 0, result.stderr)
                destination = Path(args[-1])
                self.assertTrue((destination / 'diffex/app/.bin/cli').is_symlink())
                self.assertEqual((destination / 'diffex/app/.bin/alias').read_bytes(), b'fixture')

    def test_candidate_extractor_preserves_contained_hardlinks(self):
        archive = self.archive([
            ('diffex/file', 'file', b'fixture'),
            ('diffex/hard', 'hard', 'diffex/file'),
        ])
        destination = self.root / 'hardlink output'
        candidate.extract(archive, destination)
        self.assertEqual((destination / 'diffex/hard').read_bytes(), b'fixture')
        self.assertEqual((destination / 'diffex/hard').stat().st_ino,
                         (destination / 'diffex/file').stat().st_ino)

    def test_extractors_reject_escaping_entries_before_creating_destination(self):
        for members in [
            [('diffex/../../escape', 'file', b'fixture')],
            [('/absolute', 'file', b'fixture')],
            [('diffex/link', 'link', '../../escape')],
            [('diffex/link', 'link', '/etc/passwd')],
            [('diffex/file', 'file', b'first'), ('diffex/file', 'file', b'second')],
        ]:
            archive = self.archive(members)
            for module, args in [(payload, (archive, self.root / 'output', 'diffex')),
                                 (candidate, (archive, self.root / 'output'))]:
                with self.subTest(module=module.__name__, members=members), self.assertRaises(ValueError):
                    module.extract(*args)
                self.assertFalse((self.root / 'output').exists())
        self.assertFalse((self.root / 'escape').exists())

    def test_candidate_data_filter_rechecks_paths_after_directory_links(self):
        archive = self.archive([
            ('diffex', 'dir', None),
            ('diffex/alias', 'link', '.'),
            # Lexically inside diffex before alias exists; actually points to
            # the extraction root once alias has been created.
            ('diffex/alias/out', 'link', '..'),
            ('diffex/alias/out/escape', 'file', b'fixture'),
        ])
        with self.assertRaises((ValueError, tarfile.TarError)):
            candidate.extract(archive, self.root / 'output')
        self.assertFalse((self.root / 'output/escape').exists())
        self.assertFalse((self.root / 'escape').exists())

    def test_candidate_credentials_are_rejected_before_any_extraction(self):
        for name in ['auth.json', '.npmrc', '.netrc', '.env', '.env.production']:
            archive = self.archive([('diffex/app/' + name, 'file', b'credential-fixture')])
            with self.subTest(name=name), self.assertRaises(ValueError):
                candidate.extract(archive, self.root / 'output')
            self.assertFalse((self.root / 'output').exists())

    def test_prepare_and_tree_inventory_preserve_internal_links(self):
        tree = self.root / 'tree'
        tree.mkdir()
        (tree / 'file').write_bytes(b'fixture')
        (tree / 'link').symlink_to('file')
        entries = payload.tree_entries(tree)
        self.assertEqual(entries['diffex/link'], ('link', 'file', 0o777))
        archive = self.root / 'prepared.tar.gz'
        # This test isolates path handling; Node archive tests cover the full gate.
        with patch.object(payload, 'inspect_entries', return_value={'fixture': True}):
            self.assertEqual(payload.prepare(tree, archive, SCRIPTS.parent / 'LICENSE'), {'fixture': True})
        inspected = payload.read_archive(archive, 'diffex')
        self.assertEqual(inspected['diffex/file'][1], b'fixture')
        self.assertEqual(json.loads(inspected['diffex/distribution-files.json'][1]), payload.inventory(inspected))

    def test_prepare_refuses_linked_inventory_without_modifying_its_target(self):
        tree = self.root / 'tree'
        tree.mkdir()
        original = tree / 'original.json'
        original.write_bytes(b'original')
        (tree / 'distribution-files.json').symlink_to('original.json')
        with self.assertRaises(ValueError):
            payload.prepare(tree, self.root / 'output.tar.gz', SCRIPTS.parent / 'LICENSE')
        self.assertEqual(original.read_bytes(), b'original')
        self.assertFalse((self.root / 'output.tar.gz').exists())


if __name__ == '__main__':
    unittest.main()
