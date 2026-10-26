"""Security and compatibility checks for the benchmark's filelock override."""

from contextlib import closing
from pathlib import Path
import os
import sqlite3
import struct
import tempfile
import unittest

from filelock import FileLock, ReadWriteLock, SoftFileLock, Timeout
from huggingface_hub.utils import WeakFileLock


class FilelockSecurityTests(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "POSIX shared-directory permissions")
    def test_planted_sqlite_journal_cannot_delete_an_unrelated_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            root.chmod(0o777)
            database = root / "lock.db"
            target = root / "fixture.txt"
            target.write_text("must survive lock acquisition\n")
            with closing(sqlite3.connect(database)) as connection:
                connection.execute("CREATE TABLE fixture (value INTEGER)")
                connection.commit()

            # SQLite treats this tail as a super-journal filename and unlinks it
            # during recovery if it opens the planted journal beside the database.
            name = str(target).encode()
            journal = Path(str(database) + "-journal")
            journal.write_bytes(name + struct.pack(">II", len(name), sum(name))
                                + bytes.fromhex("d9d505f920a163d7"))
            lock = ReadWriteLock(str(database))
            try:
                with lock.read_lock(timeout=1):
                    self.assertEqual(target.read_text(), "must survive lock acquisition\n")
                with lock.write_lock(timeout=1):
                    self.assertEqual(target.read_text(), "must survive lock acquisition\n")
            finally:
                lock.close()

    def test_consumers_keep_exclusion_timeouts_and_release(self):
        with tempfile.TemporaryDirectory() as temporary:
            for lock_type in (FileLock, SoftFileLock):
                with self.subTest(lock_type=lock_type.__name__):
                    path = str(Path(temporary) / f"{lock_type.__name__}.lock")
                    holder = lock_type(path, timeout=1, mode=0o600)
                    contender = lock_type(path, timeout=0)
                    with holder:
                        with self.assertRaises(Timeout):
                            contender.acquire()
                    with contender:
                        self.assertTrue(contender.is_locked)
            with WeakFileLock(Path(temporary) / "huggingface.lock", timeout=1):
                pass


if __name__ == "__main__":
    unittest.main()
