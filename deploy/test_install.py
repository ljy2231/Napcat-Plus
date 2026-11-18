#!/usr/bin/env python3
"""Isolated installer tests: python3 deploy/test_install.py.

The installer gets a private PATH containing only explicitly whitelisted utilities
and test doubles. Every invocation sets NAPCAT_PLUS_DIR under a TemporaryDirectory;
no Docker daemon, network, or /opt installation is used.
"""
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest

SCRIPTS = (Path(__file__).with_name("install.sh"), Path(__file__).with_name("install-cn.sh"))
UTILITIES = ("awk", "grep", "mkdir", "cat", "chmod", "seq", "head", "od", "tr")
MOCK = r'''#!/usr/bin/python3
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["MOCK_LOG"], "a", encoding="utf-8") as log:
    log.write(json.dumps([name, *args]) + "\n")
if name == "docker":
    if args == ["compose", "version"]:
        sys.exit(int(os.environ.get("MOCK_COMPOSE_VERSION_FAIL", "0")))
    if args == ["info"]:
        sys.exit(int(os.environ.get("MOCK_INFO_FAIL", "0")))
if name in ("docker", "docker-compose"):
    if "pull" in args:
        sys.exit(int(os.environ.get("MOCK_PULL_FAIL", "0")))
    if "up" in args:
        sys.exit(int(os.environ.get("MOCK_UP_FAIL", "0")))
if name == "curl":
    sys.exit(int(os.environ.get("MOCK_CURL_FAIL", "0")))
if name == "ss" and os.environ.get("MOCK_PORT_BUSY"):
    print("LISTEN 0 128 0.0.0.0:" + os.environ["MOCK_PORT_BUSY"] + " 0.0.0.0:*")
if name == "hostname":
    print("192.0.2.10")
'''


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="napcat-installer-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for command in UTILITIES:
            executable = shutil.which(command)
            if not executable:
                self.skipTest(f"required test utility unavailable: {command}")
            (self.bin / command).symlink_to(executable)
        mock = self.root / "mock-command"
        mock.write_text(MOCK, encoding="utf-8")
        mock.chmod(0o755)
        for name in ("docker", "curl", "ss", "hostname", "sleep"):
            (self.bin / name).symlink_to(mock)
        self.mock = mock
        self.log = self.root / "commands.jsonl"
        self.install = self.root / "installation with spaces"

    def run_installer(self, script, *, directory=None, options=None, args=()):
        directory = self.install if directory is None else directory
        resolved = (self.root / directory).resolve()
        self.assertTrue(resolved.is_relative_to(self.root), "installation must remain in temporary directory")
        self.log.write_text("", encoding="utf-8")
        env = {"PATH": str(self.bin), "HOME": str(self.root), "LC_ALL": "C",
               "NAPCAT_PLUS_DIR": str(directory), "MOCK_LOG": str(self.log)}
        env.update(options or {})
        # Prevent callers accidentally bypassing the temporary-directory guard.
        self.assertEqual(env["NAPCAT_PLUS_DIR"], str(directory))
        result = subprocess.run(["/bin/bash", str(script), *args], cwd=self.root,
                                env=env, text=True, capture_output=True, timeout=20)
        calls = [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]
        return result, calls, resolved

    def test_absolute_path_custom_settings_and_arguments(self):
        for script in SCRIPTS:
            with self.subTest(script=script.name), tempfile.TemporaryDirectory(dir=self.root) as work:
                directory = Path(work) / "install dir"
                result, calls, path = self.run_installer(script, directory=directory, options={
                    "NAPCAT_PLUS_IMAGE": "registry.example/app:v1",
                    "NAPCAT_PLUS_MIRROR": "mirror.example/",
                    "NAPCAT_PLUS_PORT": "12345", "NAPCAT_PLUS_BIND": "127.0.0.1",
                    "NAPCAT_PLUS_TOKEN": "chosen-token", "TZ": "Etc/UTC",
                    "MOCK_PORT_BUSY": "12345",
                }, args=("--ignored-by-current-script",))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("端口 12345", result.stdout)
                self.assertIn("WebUI Token: chosen-token", result.stdout)
                self.assertEqual((path / ".env").read_text(), "WEBUI_TOKEN=chosen-token\nTZ=Etc/UTC\n")
                self.assertEqual(stat.S_IMODE((path / ".env").stat().st_mode), 0o600)
                compose = (path / "compose.yaml").read_text()
                self.assertIn("image: mirror.example/registry.example/app:v1", compose)
                self.assertIn('"127.0.0.1:12345:6099"', compose)
                for name in ("qq", "config", "plugins"):
                    self.assertTrue((path / name).is_dir())
                self.assertIn(["docker", "compose", "-f", str(path / "compose.yaml"), "pull"], calls)
                self.assertIn(["docker", "compose", "-f", str(path / "compose.yaml"), "up", "-d"], calls)
                self.assertIn(["curl", "-fsS", "http://127.0.0.1:12345/webui/"], calls)

    def test_relative_path_generated_token_and_default_image(self):
        for script in SCRIPTS:
            with self.subTest(script=script.name):
                result, calls, path = self.run_installer(script, directory=Path("relative") / script.stem)
                self.assertEqual(result.returncode, 0, result.stderr)
                env_text = (path / ".env").read_text()
                self.assertRegex(env_text, r"\AWEBUI_TOKEN=[0-9a-f]{48}\nTZ=Asia/Shanghai\n\Z")
                self.assertEqual(stat.S_IMODE((path / ".env").stat().st_mode), 0o600)
                prefix = "hub.002230.xyz:44300/" if script.name == "install-cn.sh" else ""
                self.assertIn(f"image: {prefix}ghcr.io/ljy2231/napcat-plus:v0.5.0", (path / "compose.yaml").read_text())
                self.assertIn(["docker", "compose", "-f", str(path / "compose.yaml"), "pull"], calls)
                self.assertIn(f"数据目录 : {path}/", result.stdout)

    def test_existing_data_and_token_are_preserved_on_reinstall(self):
        for script in SCRIPTS:
            with self.subTest(script=script.name), tempfile.TemporaryDirectory(dir=self.root) as work:
                path = Path(work) / "existing"
                path.mkdir()
                original_env = "WEBUI_TOKEN=old-token\nTZ=Etc/UTC\n"
                (path / ".env").write_text(original_env)
                for name in ("qq", "config", "plugins"):
                    (path / name).mkdir()
                    (path / name / "data").write_text("keep " + name)
                (path / "compose.yaml").write_text("old compose")
                result, _, _ = self.run_installer(script, directory=path, options={"NAPCAT_PLUS_TOKEN": "new-token"})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual((path / ".env").read_text(), original_env)
                self.assertIn("WebUI Token: old-token", result.stdout)
                for name in ("qq", "config", "plugins"):
                    self.assertEqual((path / name / "data").read_text(), "keep " + name)
                self.assertIn("name: napcat-plus", (path / "compose.yaml").read_text())

    def test_compose_v1_fallback(self):
        (self.bin / "docker-compose").symlink_to(self.mock)
        for script in SCRIPTS:
            with self.subTest(script=script.name):
                result, calls, path = self.run_installer(script, directory=Path("fallback") / script.stem,
                                                         options={"MOCK_COMPOSE_VERSION_FAIL": "1"})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(["docker-compose", "-f", str(path / "compose.yaml"), "pull"], calls)
                self.assertIn(["docker-compose", "-f", str(path / "compose.yaml"), "up", "-d"], calls)

    def test_prerequisite_and_port_failures(self):
        cases = [({"MOCK_COMPOSE_VERSION_FAIL": "1"}, "未找到 docker compose"),
                 ({"MOCK_INFO_FAIL": "1"}, "无权访问 Docker"),
                 ({"NAPCAT_PLUS_PORT": "0"}, "端口无效"),
                 ({"NAPCAT_PLUS_PORT": "65536"}, "端口无效"),
                 ({"NAPCAT_PLUS_PORT": "abc"}, "端口无效")]
        for script in SCRIPTS:
            for index, (options, message) in enumerate(cases):
                with self.subTest(script=script.name, options=options):
                    result, calls, path = self.run_installer(script, directory=Path("errors") / script.stem / str(index), options=options)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(message, result.stderr)
                    self.assertFalse(path.exists())
                    self.assertFalse(any("pull" in call or "up" in call for call in calls))
        (self.bin / "docker").unlink()
        for script in SCRIPTS:
            with self.subTest(script=script.name, missing="docker"):
                result, calls, path = self.run_installer(script, directory=Path("no-docker") / script.stem)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("未找到 docker", result.stderr)
                self.assertFalse(path.exists())
                self.assertEqual(calls, [])

    def test_pull_and_start_failures_stop_execution(self):
        for script in SCRIPTS:
            for failing in ("pull", "up"):
                with self.subTest(script=script.name, failing=failing):
                    result, calls, path = self.run_installer(script, directory=Path("fail") / script.stem / failing,
                                                             options={f"MOCK_{failing.upper()}_FAIL": "1"})
                    self.assertNotEqual(result.returncode, 0)
                    self.assertTrue((path / ".env").exists())
                    self.assertTrue(any(failing in call for call in calls))
                    self.assertFalse(any(call[0] == "curl" for call in calls))
                    if failing == "pull":
                        self.assertFalse(any("up" in call for call in calls))

    def test_unready_webui_and_directory_creation_failure(self):
        for script in SCRIPTS:
            with self.subTest(script=script.name, case="unready"):
                result, calls, _ = self.run_installer(script, directory=Path("unready") / script.stem,
                                                      options={"MOCK_CURL_FAIL": "1"})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("WebUI 尚未响应", result.stdout)
                self.assertEqual(sum(call[0] == "curl" for call in calls), 60)
                self.assertEqual(sum(call[0] == "sleep" for call in calls), 60)
            with self.subTest(script=script.name, case="mkdir failure"):
                blocker = self.root / (script.stem + "-file")
                blocker.write_text("not a directory")
                result, calls, _ = self.run_installer(script, directory=blocker / "child")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("无法创建安装目录", result.stderr)
                self.assertFalse(any("pull" in call for call in calls))


if __name__ == "__main__":
    unittest.main(verbosity=2)
