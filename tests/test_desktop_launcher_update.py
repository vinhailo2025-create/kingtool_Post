import os
import shutil
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path

sys.modules.setdefault("webview", types.SimpleNamespace())

from desktop_launcher import launch_update_installer


@unittest.skipUnless(os.name == "nt", "Windows updater test")
class DesktopLauncherUpdateTest(unittest.TestCase):
    def test_helper_launches_from_path_with_spaces_and_removes_itself(self):
        with tempfile.TemporaryDirectory(prefix="Super Post Update Test ") as temp_dir:
            root = Path(temp_dir)
            installer = root / "Super-Post-King-Setup-9.9.9.exe"
            shutil.copy2(Path(os.environ["WINDIR"]) / "System32" / "where.exe", installer)

            launch_update_installer(installer, root)

            helper = root / "run-super-post-update.cmd"
            deadline = time.time() + 10
            while helper.exists() and time.time() < deadline:
                time.sleep(0.2)

            self.assertFalse(helper.exists(), "Update helper did not run or remove itself")


if __name__ == "__main__":
    unittest.main()
