import hashlib
import importlib.util
import io
import os
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path

spec = importlib.util.spec_from_file_location("self_hosted_runtime", Path(__file__).resolve().parents[1] / "relay" / "self-hosted-runtime.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class RuntimeTests(unittest.TestCase):
    def test_untrusted_path_is_not_executed_as_root(self):
        unsafe = SimpleNamespace(st_uid=1000, st_mode=0o100755)
        with patch.object(runtime.shutil, 'which', return_value='/usr/local/bin/node'), \
             patch.object(runtime.os.path, 'realpath', return_value='/usr/local/bin/node'), \
             patch.object(runtime.os, 'lstat', return_value=unsafe), \
             patch.object(runtime.platform, 'machine', return_value='unsupported'), \
             patch.object(runtime.subprocess, 'check_output') as execute:
            with self.assertRaisesRegex(ValueError, 'NODE_ARCH_UNSUPPORTED'):
                runtime.ensure_node()
            execute.assert_not_called()

    def test_service_runtime_path_must_be_visible_and_accepted_by_installer(self):
        self.assertTrue(runtime.service_runtime_path('/usr/local/bin/node'))
        self.assertFalse(runtime.service_runtime_path('/root/.nvm/node'))
        self.assertFalse(runtime.service_runtime_path('/home/user/node'))
        self.assertFalse(runtime.service_runtime_path('/usr/local/node-v22/bin/node'))

    def archive(self, data=b"test-runtime", symlink=False):
        out = io.BytesIO()
        with tarfile.open(fileobj=out, mode="w:xz") as archive:
            member = tarfile.TarInfo("node-v22.23.4-linux-x64/bin/node")
            if symlink:
                member.type = tarfile.SYMTYPE
                member.linkname = "/etc/passwd"
                archive.addfile(member)
            else:
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        return out.getvalue()

    def test_verified_runtime_can_be_reused_without_overwriting(self):
        data = self.archive()
        with tempfile.TemporaryDirectory() as parent:
            target = Path(parent) / "node"
            runtime.install_verified_archive(data, hashlib.sha256(data).hexdigest(), "x64", target)
            runtime.install_verified_archive(data, hashlib.sha256(data).hexdigest(), "x64", target)
            self.assertEqual(target.read_bytes(), b"test-runtime")
            target.write_bytes(b"other")
            with self.assertRaises(ValueError):
                runtime.install_verified_archive(data, hashlib.sha256(data).hexdigest(), "x64", target)
            self.assertEqual(target.read_bytes(), b"other")

    def test_bad_checksum_and_symlink_are_rejected(self):
        with tempfile.TemporaryDirectory() as parent:
            target = Path(parent) / "node"
            data = self.archive()
            with self.assertRaises(ValueError):
                runtime.install_verified_archive(data, "0" * 64, "x64", target)
            data = self.archive(symlink=True)
            with self.assertRaises(ValueError):
                runtime.install_verified_archive(data, hashlib.sha256(data).hexdigest(), "x64", target)
            self.assertFalse(target.exists())

    @unittest.skipUnless(os.name == 'posix', 'POSIX file ownership and permissions')
    def test_reused_node_must_not_be_writable_by_other_users(self):
        data = self.archive()
        with tempfile.TemporaryDirectory() as parent:
            target = Path(parent) / 'node'
            runtime.install_verified_archive(data, hashlib.sha256(data).hexdigest(), 'x64', target)
            target.chmod(0o777)
            with self.assertRaises(ValueError):
                runtime.install_verified_archive(data, hashlib.sha256(data).hexdigest(), 'x64', target)


if __name__ == "__main__":
    unittest.main()
