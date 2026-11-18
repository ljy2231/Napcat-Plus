import contextlib
import importlib.util
import io
import json
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location('updater', Path(__file__).with_name('updater.py'))
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)
OLD = 'sha256:' + '1' * 64
NEW = 'sha256:' + '2' * 64
IMG = 'registry.example/app@sha256:' + 'a' * 64
BASE = 'registry.example/app@sha256:' + 'b' * 64
CID = 'c' * 64


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name)
        self.oldstate = u.STATE
        u.STATE = self.state
        u.atomic_json(self.state / 'committed.json', {'generation': 1, 'image': BASE})
        self.compose_path = self.state / 'compose.json'
        self.compose_path.write_text(json.dumps({'services': {'web': {'image': BASE}}}))
        self.p = {'generation': 2, 'image': IMG, 'project': 'app', 'service': 'web', 'compose_file': str(self.compose_path)}
        self.calls = []
        self.bad_up = False
        self.roll_back_fails = False
        self.image = OLD
        self.old_id = OLD
        self.health = ['starting', 'healthy']

    def tearDown(self):
        u.STATE = self.oldstate
        self.tmp.cleanup()

    def run_command(self, args, timeout=300):
        self.calls.append(args)
        if args[0] == 'compose':
            if 'config' in args:
                return self.compose_path.read_text()
            if 'ps' in args:
                return CID
            if 'up' in args:
                override = json.loads(Path(args[args.index('-f', args.index('-f') + 1) + 1]).read_text())
                target = override['services']['web']['image']
                if target == IMG and self.bad_up:
                    raise RuntimeError('simulated failure')
                if target == BASE and self.roll_back_fails:
                    raise RuntimeError('simulated rollback failure')
                self.image = NEW if target == IMG else OLD
                return ''
        if args[:2] == ['inspect', '--format']:
            if args[2] == '{{.Image}}':
                return self.old_id
            health = self.health.pop(0) if self.health else 'healthy'
            return json.dumps({'Image': self.image, 'State': {'Running': True, 'Health': {'Status': health}}})
        if args[:2] == ['image', 'inspect']:
            return OLD if args[-1] == BASE else NEW
        return ''

    def perform(self):
        with mock.patch.object(u, 'load_policy', return_value=self.p), mock.patch.object(u, 'run', side_effect=self.run_command), mock.patch.object(u, 'COMPOSE_FILE', self.compose_path), mock.patch.object(u, 'trusted_path'), mock.patch.object(u.time, 'sleep'):
            u.perform()

    def test_pull_precedes_up_and_health_waits(self):
        self.perform()
        commands = [a[0] if a[0] != 'compose' else ('up' if 'up' in a else 'ps') for a in self.calls]
        self.assertLess(commands.index('pull'), commands.index('up'))
        self.assertEqual(json.loads((self.state / 'status.json').read_text())['phase'], 'succeeded')
        self.assertEqual(json.loads((self.state / 'committed.json').read_text())['generation'], 2)
        self.assertFalse((self.state / 'pending.json').exists())
        self.assertEqual(json.loads(self.compose_path.read_text())['services']['web']['image'], IMG)
        self.assertGreaterEqual(sum(a[0] == 'inspect' and a[2] == '{{json .}}' for a in self.calls), 2)

    def test_failure_restores_image_not_data(self):
        self.bad_up = True
        self.perform()
        self.assertEqual(self.image, OLD)
        status = json.loads((self.state / 'status.json').read_text())
        self.assertEqual(status['phase'], 'failed')
        self.assertIn('data not rolled back', status['message'])
        self.assertEqual(json.loads((self.state / 'committed.json').read_text())['generation'], 1)
        self.assertFalse((self.state / 'pending.json').exists())
        self.assertEqual(json.loads(self.compose_path.read_text())['services']['web']['image'], BASE)
        # A normal compose invocation will therefore select the old image.
        rollback = [a for a in self.calls if a[0] == 'compose' and 'up' in a][-1]
        self.assertIn('--pull', rollback)

    def test_failed_rollback_quarantines(self):
        self.bad_up = True
        self.roll_back_fails = True
        self.perform()
        self.assertEqual(json.loads((self.state / 'status.json').read_text())['phase'], 'blocked')
        self.assertTrue((self.state / 'pending.json').exists())
        self.calls.clear()
        self.perform()
        self.assertFalse(self.calls)

    def test_downgrade_rejected(self):
        self.p['generation'] = 0
        self.perform()
        self.assertFalse(self.calls)
        self.assertEqual(json.loads((self.state / 'status.json').read_text())['phase'], 'blocked')

    def test_digest_reuse_rejected(self):
        self.p['generation'] = 1
        self.perform()
        self.assertFalse(self.calls)

    def test_missing_baseline_fails_closed(self):
        (self.state / 'committed.json').unlink()
        self.perform()
        self.assertFalse(self.calls)
        self.assertEqual(json.loads((self.state / 'status.json').read_text())['phase'], 'blocked')

    def test_runtime_drift_rejected_before_pull(self):
        self.old_id = 'sha256:' + '9' * 64
        self.perform()
        self.assertEqual(json.loads((self.state / 'status.json').read_text())['phase'], 'blocked')
        self.assertFalse(any(a[0] == 'pull' for a in self.calls))
        self.assertEqual(json.loads(self.compose_path.read_text())['services']['web']['image'], BASE)

    def test_compose_drift_rejected_before_pull(self):
        self.compose_path.write_text(json.dumps({'services': {'web': {'image': IMG}}}))
        self.perform()
        self.assertFalse(any(a[0] == 'pull' for a in self.calls))
        self.assertEqual(json.loads((self.state / 'status.json').read_text())['phase'], 'blocked')

    def test_committed_state_write_failure_never_rolls_back(self):
        original = u.atomic_json
        def fail_commit(path, value):
            if path.name == 'committed.json':
                raise OSError('simulated commit failure')
            return original(path, value)
        with mock.patch.object(u, 'atomic_json', side_effect=fail_commit):
            self.perform()
        self.assertEqual(json.loads((self.state / 'status.json').read_text())['phase'], 'blocked')
        self.assertTrue((self.state / 'pending.json').exists())
        self.assertEqual(self.image, NEW)
        self.assertEqual(len([a for a in self.calls if a[0] == 'compose' and 'up' in a]), 1)
        self.calls.clear()
        self.perform()
        self.assertFalse(self.calls)

    def test_pending_unlink_failure_after_commit_never_rolls_back(self):
        original = Path.unlink
        def fail_pending(path, *args, **kwargs):
            if path.name == 'pending.json':
                raise OSError('simulated unlink failure')
            return original(path, *args, **kwargs)
        with mock.patch.object(Path, 'unlink', fail_pending):
            self.perform()
        self.assertEqual(json.loads((self.state / 'status.json').read_text())['phase'], 'blocked')
        self.assertTrue((self.state / 'pending.json').exists())
        self.assertEqual(json.loads((self.state / 'committed.json').read_text())['image'], IMG)
        self.assertEqual(json.loads(self.compose_path.read_text())['services']['web']['image'], IMG)
        self.assertEqual(len([a for a in self.calls if a[0] == 'compose' and 'up' in a]), 1)

    def test_interrupted_before_compose_commit_requires_recovery(self):
        def crash(*_args):
            raise RuntimeError('simulated crash before compose commit')
        with mock.patch.object(u, 'commit_compose_image', side_effect=crash):
            self.perform()
        self.assertTrue((self.state / 'pending.json').exists())
        self.assertEqual(json.loads(self.compose_path.read_text())['services']['web']['image'], BASE)
        self.assertEqual(json.loads((self.state / 'committed.json').read_text())['image'], BASE)
        self.calls.clear()
        self.perform()
        self.assertFalse(self.calls)

    def test_rate_limit_recovers_after_retry_at(self):
        u.atomic_json(self.state / 'last-attempt.json', {'time': 1000})
        with mock.patch.object(u.time, 'time', return_value=1020):
            self.perform()
        status = json.loads((self.state / 'status.json').read_text())
        self.assertEqual(status['phase'], 'rate_limited')
        self.assertEqual(status['retryAt'], 1060)
        self.assertEqual(u.public_status(status, 1059)['phase'], 'rate_limited')
        self.assertEqual(u.public_status(status, 1060)['phase'], 'idle')
        with mock.patch.object(u.time, 'time', return_value=1061):
            self.perform()
        self.assertEqual(json.loads((self.state / 'status.json').read_text())['phase'], 'succeeded')

    def test_pending_unlink_is_followed_by_state_fsync(self):
        pending = self.state / 'pending.json'
        u.atomic_json(pending, {'key': 'value'})
        with mock.patch.object(u, 'sync_state_dir') as sync:
            u.clear_pending(pending)
        sync.assert_called_once_with()
        self.assertFalse(pending.exists())

    def test_fsync_failure_reinstates_recovery_marker_and_blocks(self):
        with mock.patch.object(u, 'sync_state_dir', side_effect=OSError('sensitive secret')):
            self.perform()
        self.assertTrue((self.state / 'pending.json').exists())
        self.assertEqual(json.loads((self.state / 'status.json').read_text())['phase'], 'blocked')
        self.calls.clear()
        self.perform()
        self.assertFalse(self.calls)

    def test_journal_redacts_exception_message_and_command(self):
        out = io.StringIO()
        with contextlib.redirect_stderr(out):
            u.journal_error('apply', subprocess.CalledProcessError(1, ['token=supersecret'], output='private'))
            u.journal_error('preflight', ValueError('sensitive path'))
        self.assertIn('stage=apply error=command_failed', out.getvalue())
        self.assertIn('stage=preflight error=validation_error', out.getvalue())
        self.assertNotIn('supersecret', out.getvalue())
        self.assertNotIn('sensitive path', out.getvalue())
        self.assertNotIn('private', out.getvalue())

    def test_command_arguments_are_fixed_and_not_shell(self):
        self.perform()
        pull = next(a for a in self.calls if a[0] == 'pull')
        self.assertEqual(pull, ['pull', IMG])
        up = next(a for a in self.calls if a[0] == 'compose' and 'up' in a)
        self.assertEqual(up[-6:], ['-d', '--no-deps', '--no-build', '--pull', 'never', 'web'])


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / 'data'
        self.data.mkdir()
        for name in u.MOUNTS:
            (self.data / name).mkdir()
        self.policy = self.root / 'policy.json'
        self.compose_path = self.root / 'compose.json'
        self.policy.write_text(json.dumps({'project': 'app', 'service': 'web', 'compose_file': str(self.compose_path), 'image': IMG, 'generation': 2}))
        self.socket_dir = self.root / 'socket-dir'
        self.socket_dir.mkdir()
        self.socket_path = self.socket_dir / 'updater.sock'
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.bind(str(self.socket_path))
        self.socket_path.chmod(0o660)
        self.addCleanup(self.sock.close)
        self.volumes = [f'{self.data / n}:{target}' for n, target in u.MOUNTS.items()]
        self.volumes.append(f'{self.socket_dir}:{u.SOCKET_TARGET}:ro')

    def load(self, volumes, extra=None):
        service = {'image': BASE, 'healthcheck': {'test': ['CMD', 'true']}, 'volumes': volumes}
        service.update(extra or {})
        self.compose_path.write_text(json.dumps({'services': {'web': service}}))
        with mock.patch.object(u, 'POLICY', self.policy), mock.patch.object(u, 'DATA_ROOT', self.data), mock.patch.object(u, 'COMPOSE_FILE', self.compose_path), mock.patch.object(u, 'SOCKET_DIR', self.socket_dir), mock.patch.object(u, 'SOCKET', str(self.socket_path)), mock.patch.object(u, 'trusted_path'), mock.patch.object(u.grp, 'getgrnam', return_value=mock.Mock(gr_gid=self.socket_path.stat().st_gid)):
            return u.load_policy()

    def test_exact_dedicated_mounts_only(self):
        self.assertEqual(self.load(self.volumes)['image'], IMG)
        for replacement in ['/etc:/app/.config/QQ', '/var/run/docker.sock:/app/.config/QQ',
                            f'{self.data / "qq"}:/var/run/docker.sock',
                            f'{self.data / "qq"}:/app/.config/QQ:ro',
                            f'{self.data / "qq"}:/app/napcat/config']:
            with self.subTest(replacement=replacement):
                with self.assertRaises(ValueError):
                    self.load([replacement, *self.volumes[1:]])
        with self.assertRaises(ValueError):
            self.load(self.volumes + ['/etc:/other'])
        with self.assertRaises(ValueError):
            self.load([self.volumes[0], self.volumes[0], self.volumes[2], self.volumes[3]])
        for wrong in [f'{self.socket_dir}:{u.SOCKET_TARGET}', f'{self.socket_dir}:{u.SOCKET_TARGET}:rw',
                      f'{self.socket_path}:{u.SOCKET_TARGET}:ro', f'{self.socket_dir}:/other:ro',
                      f'/var/run/docker.sock:{u.SOCKET_TARGET}:ro']:
            with self.subTest(wrong=wrong), self.assertRaises(ValueError):
                self.load([*self.volumes[:3], wrong])

    def test_container_identity_fields_are_preserved_but_validated(self):
        self.assertEqual(self.load(self.volumes, {'container_name': 'napcat-plus', 'hostname': 'napcat-plus'})['image'], IMG)
        for bad in ({'container_name': '-bad'}, {'hostname': 'a b'}, {'container_name': 1}, {'hostname': ''}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.load(self.volumes, bad)

    def test_socket_must_be_a_restricted_unix_socket(self):
        self.socket_path.chmod(0o666)
        with self.assertRaises(ValueError):
            self.load(self.volumes)
        self.socket_path.chmod(0o660)
        self.sock.close()
        self.socket_path.unlink()
        self.socket_path.write_text('not socket')
        with self.assertRaises(ValueError):
            self.load(self.volumes)

    def test_arbitrary_compose_path_rejected(self):
        self.compose_path.write_text(json.dumps({'services': {'web': {'image': BASE, 'healthcheck': {'test': ['CMD', 'true']}, 'volumes': self.volumes}}}))
        with mock.patch.object(u, 'POLICY', self.policy), mock.patch.object(u, 'COMPOSE_FILE', self.root / 'other.json'), mock.patch.object(u, 'trusted_path'):
            with self.assertRaises(ValueError):
                u.load_policy()

    def test_policy_and_compose_inside_data_are_rejected(self):
        unsafe = self.data / 'config' / 'compose.json'
        unsafe.write_text('{}')
        self.policy.write_text(json.dumps({'project': 'app', 'service': 'web', 'compose_file': str(unsafe), 'image': IMG, 'generation': 2}))
        self.compose_path = unsafe
        with self.assertRaises(ValueError):
            self.load(self.volumes)

    def test_symlink_data_source_rejected(self):
        (self.data / 'qq').rmdir()
        (self.data / 'qq').symlink_to('/etc', target_is_directory=True)
        with self.assertRaises(ValueError):
            self.load(self.volumes)


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.sockpath = str(Path(self.temp.name) / 'server.sock')
        class SmallServer(u.Server):
            max_clients = 2
            request_deadline = 0.3
        self.server = SmallServer(self.sockpath, u.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': 0.02}, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.thread.join, 2)
        self.addCleanup(self.server.shutdown)

    def connect(self):
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(2)
        client.connect(self.sockpath)
        self.addCleanup(client.close)
        return client

    def test_slow_clients_expire_and_concurrency_is_bounded(self):
        # Fill every worker with a partial request; no third worker may be made.
        first, second = self.connect(), self.connect()
        first.sendall(b'GET /status HTTP/1.0\r\n')
        second.sendall(b'GET /status HTTP/1.0\r\n')
        deadline = time.monotonic() + 2
        while self.server._client_slots._value != 0 and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(self.server._client_slots._value, 0)
        third = self.connect()
        try:
            third.sendall(b'GET /status HTTP/1.0\r\n\r\n')
            self.assertEqual(third.recv(4096), b'')
        except (ConnectionResetError, BrokenPipeError):
            pass
        # Trickle bytes before the inactivity timeout: absolute deadline must
        # still free the slot rather than resetting the clock indefinitely.
        time.sleep(0.15)
        try:
            first.sendall(b'X')
        except (ConnectionResetError, BrokenPipeError):
            pass
        deadline = time.monotonic() + 2
        while self.server._client_slots._value != self.server.max_clients and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(self.server._client_slots._value, self.server.max_clients)
        fourth = self.connect()
        fourth.sendall(b'GET /status HTTP/1.0\r\n\r\n')
        self.assertIn(b'200 OK', fourth.recv(4096))

    def test_incomplete_post_never_triggers_update(self):
        with mock.patch.object(u, 'perform') as perform:
            client = self.connect()
            client.sendall(b'POST /update HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n')
            client.shutdown(socket.SHUT_WR)
            self.assertEqual(client.recv(4096), b'')
            self.assertFalse(perform.called)
            slow = self.connect()
            slow.sendall(b'POST /update HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n')
            self.assertEqual(slow.recv(4096), b'')
            self.assertFalse(perform.called)


if __name__ == '__main__':
    unittest.main()
