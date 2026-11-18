#!/usr/bin/env python3
"""Socket-to-updater integration tests with a simulated Docker CLI.

NOT a Docker end-to-end test: production updater hardcodes the host Docker
executable and paths. This test never runs Docker, systemd, network calls, or
uses production directories. Run: python3 -m unittest -v deploy/docker-updater/test_isolated_socket.py
"""
import http.client
import importlib.util
import json
import socket
import os
from types import SimpleNamespace
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location('isolated_updater_under_test', Path(__file__).with_name('updater.py'))
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)
BASE = 'registry.example/app@sha256:' + 'a' * 64
TARGET = 'registry.example/app@sha256:' + 'b' * 64
OLD_ID = 'sha256:' + '1' * 64
NEW_ID = 'sha256:' + '2' * 64
CID = 'c' * 64


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path):
        super().__init__('localhost', timeout=5)
        self.socket_path = socket_path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.socket_path)


class FakeDocker:
    """Records fixed argv and simulates only commands needed by the updater."""
    def __init__(self, compose_file, fail_update=False):
        self.compose_file = compose_file
        self.fail_update = fail_update
        self.image = OLD_ID
        self.calls = []

    def __call__(self, args, timeout=300):
        self.calls.append(tuple(args))
        if args[0] == 'compose':
            if 'config' in args:
                return self.compose_file.read_text()
            if 'ps' in args:
                return CID
            if 'up' in args:
                positions = [i for i, value in enumerate(args) if value == '-f']
                override = json.loads(Path(args[positions[1] + 1]).read_text())
                image = override['services']['web']['image']
                if image == TARGET and self.fail_update:
                    raise subprocess.CalledProcessError(1, 'simulated docker')
                if image not in (BASE, TARGET):
                    raise AssertionError('unexpected image requested')
                self.image = NEW_ID if image == TARGET else OLD_ID
                return ''
        if args[:2] == ['inspect', '--format']:
            if args[2] == '{{.Image}}':
                return self.image
            if args[2] == '{{json .}}':
                return json.dumps({'Image': self.image, 'State': {'Running': True, 'Health': {'Status': 'healthy'}}})
        if args[:2] == ['image', 'inspect']:
            if args[-1] not in (BASE, TARGET):
                raise AssertionError('unexpected image inspected')
            return OLD_ID if args[-1] == BASE else NEW_ID
        if args[0] == 'pull' and args == ['pull', TARGET]:
            return ''
        if args[0] == 'tag' and args[1] == OLD_ID and len(args) == 3:
            return ''
        raise AssertionError(f'unexpected Docker invocation: {args!r}')


class IsolatedSocketTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='napcat-updater-isolated-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.state = self.root / 'state'
        self.state.mkdir()
        self.data = self.root / 'data'
        self.data.mkdir()
        for name in u.MOUNTS:
            (self.data / name).mkdir()
        self.policy = self.root / 'policy.json'
        self.compose = self.root / 'compose.json'
        self.socket_path = str(self.root / 'test.sock')
        self.compose.write_text(json.dumps({'services': {'web': {
            'image': BASE,
            'healthcheck': {'test': ['CMD', 'true']},
            'volumes': [f'{self.data / n}:{dest}' for n, dest in u.MOUNTS.items()] + [f'{self.root}:{u.SOCKET_TARGET}:ro'],
        }}}))
        self.policy.write_text(json.dumps({'project': 'isolated-test', 'service': 'web',
                                           'compose_file': str(self.compose), 'image': TARGET, 'generation': 2}))
        (self.state / 'committed.json').write_text(json.dumps({'generation': 1, 'image': BASE}))
        self.fake = FakeDocker(self.compose)
        self.finished = threading.Event()
        self.patches = [
            mock.patch.object(u, 'STATE', self.state),
            mock.patch.object(u, 'POLICY', self.policy),
            mock.patch.object(u, 'COMPOSE_FILE', self.compose),
            mock.patch.object(u, 'DATA_ROOT', self.data),
            mock.patch.object(u, 'SOCKET_DIR', self.root),
            mock.patch.object(u, 'SOCKET', self.socket_path),
            mock.patch.object(u.grp, 'getgrnam', return_value=SimpleNamespace(gr_gid=os.getgid())),
            # TemporaryDirectory is under /tmp, whose ownership/mode do not meet
            # production policy. This mock is not a permissions test.
            mock.patch.object(u, 'trusted_path', side_effect=self.assert_temp_path),
            mock.patch.object(u, 'run', side_effect=self.fake),
            # Fail closed even if a future code path bypasses the run() mock.
            mock.patch.object(subprocess, 'run', side_effect=AssertionError('real subprocess forbidden')),
        ]
        for patch in self.patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.original_perform = u.perform
        def perform_and_signal():
            try:
                self.original_perform()
            finally:
                self.finished.set()
        self.perform_patch = mock.patch.object(u, 'perform', side_effect=perform_and_signal)
        self.perform_patch.start()
        self.addCleanup(self.perform_patch.stop)
        u.busy = False
        self.server = u.Server(self.socket_path, u.Handler)
        os.chmod(self.socket_path, 0o660)
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        self.addCleanup(self.close_server)

    def assert_temp_path(self, path):
        path = Path(path)
        if not path.is_relative_to(self.root) or path.is_symlink():
            raise AssertionError(f'path outside isolated test root: {path}')

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(timeout=5)
        self.assertFalse(self.server_thread.is_alive())
        # The background worker must finish before mocked functions are restored.
        if u.busy:
            self.assertTrue(self.finished.wait(5), 'worker did not finish')

    def request(self, method, endpoint):
        connection = UnixHTTPConnection(self.socket_path)
        try:
            headers = {'Content-Length': '0'} if method == 'POST' else {}
            connection.request(method, endpoint, headers=headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_socket_update_commits_approved_image(self):
        status, initial = self.request('GET', '/status')
        self.assertEqual((status, initial['phase']), (200, 'idle'))
        status, accepted = self.request('POST', '/update')
        self.assertEqual((status, accepted), (202, {'accepted': True}))
        self.assertTrue(self.finished.wait(5), 'update worker did not finish')
        status, result = self.request('GET', '/status')
        self.assertEqual((status, result['phase']), (200, 'succeeded'))
        self.assertEqual(json.loads(self.compose.read_text())['services']['web']['image'], TARGET)
        self.assertEqual(json.loads((self.state / 'committed.json').read_text()), {'image': TARGET, 'generation': 2})
        self.assertFalse((self.state / 'pending.json').exists())
        self.assertEqual(self.fake.image, NEW_ID)
        self.assertEqual(len([a for a in self.fake.calls if 'up' in a]), 1)

    def test_socket_failure_restores_unchanged_compose(self):
        self.fake.fail_update = True
        status, _ = self.request('POST', '/update')
        self.assertEqual(status, 202)
        self.assertTrue(self.finished.wait(5), 'update worker did not finish')
        _, result = self.request('GET', '/status')
        self.assertEqual(result['phase'], 'failed')
        self.assertEqual(json.loads(self.compose.read_text())['services']['web']['image'], BASE)
        self.assertEqual(json.loads((self.state / 'committed.json').read_text())['image'], BASE)
        self.assertFalse((self.state / 'pending.json').exists())
        self.assertEqual(self.fake.image, OLD_ID)

    def test_unknown_request_does_not_invoke_update(self):
        status, _ = self.request('POST', '/update?image=other')
        self.assertEqual(status, 400)
        self.assertEqual(self.fake.calls, [])
        self.assertFalse(self.finished.is_set())


if __name__ == '__main__':
    unittest.main()
