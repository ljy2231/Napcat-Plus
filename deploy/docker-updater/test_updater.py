import contextlib
import importlib.util
import io
import json
import os
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
IMG = 'ghcr.io/ljy2231/napcat-plus@sha256:' + 'a' * 64
BASE = 'registry.example/app@sha256:' + 'b' * 64
CID = 'c' * 64


def setUpModule():
    # Ensure these tests cannot contact a real network or start host Docker even
    # if a future test forgets to mock the updater's command/discovery functions.
    global network_guard, process_guard
    network_guard = mock.patch.object(socket, 'create_connection', side_effect=AssertionError('network disabled'))
    process_guard = mock.patch.object(subprocess, 'run', side_effect=AssertionError('subprocess disabled'))
    network_guard.start()
    process_guard.start()


def tearDownModule():
    process_guard.stop()
    network_guard.stop()


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name)
        self.oldstate = u.STATE
        u.STATE = self.state
        u.atomic_json(self.state / 'committed.json', {'generation': 1, 'image': BASE, 'policy_image': BASE, 'version': '1.0.0'})
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
                if target in (BASE, 'napcat-updater-backup-app-web:previous') and self.roll_back_fails:
                    raise RuntimeError('simulated rollback failure')
                self.image = NEW if target == IMG else OLD
                return ''
        if args[:2] == ['inspect', '--format']:
            if args[2] == '{{.Image}}':
                return self.old_id
            health = self.health.pop(0) if self.health else 'healthy'
            return json.dumps({'Image': self.image, 'State': {'Running': True, 'Health': {'Status': health}}})
        if args[:2] == ['image', 'inspect']:
            if args[3] == '{{json .RepoDigests}}':
                return json.dumps([IMG])
            if args[3] == '{{json .Config.Env}}':
                return json.dumps(['NAPCAT_PLUS_VERSION=1.0.1'])
            return OLD if args[-1] == BASE else NEW
        return ''

    def perform(self):
        with mock.patch.object(u, 'load_policy', return_value=self.p), mock.patch.object(u, 'latest_version', return_value='1.0.1'), mock.patch.object(u, '_official_digest', return_value=IMG), mock.patch.object(u, 'run', side_effect=self.run_command), mock.patch.object(u, 'COMPOSE_FILE', self.compose_path), mock.patch.object(u, 'trusted_path'), mock.patch.object(u.time, 'sleep'):
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

    def test_legacy_baseline_requires_administrator_migration(self):
        legacy = {'generation': 1, 'image': BASE}
        u.atomic_json(self.state / 'committed.json', legacy)
        self.perform()
        status = json.loads((self.state / 'status.json').read_text())
        self.assertEqual(status['phase'], 'blocked')
        self.assertIn('administrator migration', status['message'])
        self.assertEqual(json.loads((self.state / 'committed.json').read_text()), legacy)
        self.assertFalse(self.calls)

    def test_discovery_failures_are_retryable_and_leave_baseline(self):
        for name in ('latest_version', 'resolve_digest'):
            with self.subTest(name=name):
                with mock.patch.object(u, 'load_policy', return_value=self.p), mock.patch.object(u, 'latest_version', return_value='1.0.1'), mock.patch.object(u, 'run', side_effect=self.run_command), mock.patch.object(u, name, side_effect=OSError('network error')):
                    u.perform()
                self.assertEqual(json.loads((self.state / 'status.json').read_text())['phase'], 'failed')
                self.assertFalse((self.state / 'pending.json').exists())
                self.assertEqual(json.loads((self.state / 'committed.json').read_text())['version'], '1.0.0')
                (self.state / 'last-attempt.json').unlink()

    def test_changed_preview_version_does_not_pull(self):
        with mock.patch.object(u, 'load_policy', return_value=self.p), mock.patch.object(u, 'latest_version', return_value='1.0.2'), mock.patch.object(u, 'run') as run:
            u.perform('mirror', '1.0.1', 'sha256:' + 'a' * 64)
        run.assert_not_called()
        self.assertEqual(json.loads((self.state / 'status.json').read_text())['phase'], 'failed')

    def test_no_downgrade_or_equal_version(self):
        for candidate in ('0.99.999', '1.0.0'):
            with self.subTest(candidate=candidate):
                with mock.patch.object(u, 'load_policy', return_value=self.p), mock.patch.object(u, 'latest_version', return_value=candidate), mock.patch.object(u, '_official_digest', return_value='ghcr.io/ljy2231/napcat-plus@sha256:' + 'b' * 64), mock.patch.object(u, 'run') as run:
                    u.perform()
                run.assert_not_called()
                expected_phase = 'blocked' if candidate == '0.99.999' else 'idle'
                self.assertEqual(json.loads((self.state / 'status.json').read_text())['phase'], expected_phase)
                (self.state / 'last-attempt.json').unlink()
                (self.state / 'status.json').unlink(missing_ok=True)

    def test_same_generation_allows_incremental_updates(self):
        self.p['generation'] = 1
        self.p['image'] = BASE
        self.perform()
        committed = json.loads((self.state / 'committed.json').read_text())
        self.assertEqual(committed, {'generation': 1, 'image': IMG, 'policy_image': BASE, 'version': '1.0.1'})
        self.assertEqual(json.loads((self.state / 'status.json').read_text())['phase'], 'succeeded')

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


class DiscoveryTests(unittest.TestCase):
    def response(self, payload, status=200, length=None):
        response = mock.Mock()
        response.status = status
        response.getheader.return_value = length
        stream = io.BytesIO(payload)
        response.read1.side_effect = stream.read
        return response

    def fetch(self, response):
        conn = mock.Mock()
        conn.getresponse.return_value = response
        with mock.patch.object(u.http.client, 'HTTPSConnection', return_value=conn) as factory:
            result = u.latest_version()
        self.assertEqual(factory.call_args.args, (u.RELEASE_HOST,))
        self.assertEqual(conn.request.call_args.args[:2], ('GET', u.RELEASE_PATH))
        conn.close.assert_called_once()
        return result

    def test_fixed_api_stable_release_and_redirect_rejection(self):
        payload = json.dumps({'draft': False, 'prerelease': False, 'tag_name': 'v1.2.3'}).encode()
        self.assertEqual(self.fetch(self.response(payload)), '1.2.3')
        with self.assertRaises(ValueError):
            self.fetch(self.response(payload, status=302))
        with self.assertRaises(ValueError):
            self.fetch(self.response(payload, length='1048577'))
        with self.assertRaises(ValueError):
            self.fetch(self.response(b'x' * 1048577))
        for tag in ('v1.2.3-rc.1', 'v01.2.3', '1.2.3', 'v1.2.3+build', 'v1.2', 'v1.2.3\n'):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                self.fetch(self.response(json.dumps({'draft': False, 'prerelease': False, 'tag_name': tag}).encode()))
        for flag in ('draft', 'prerelease'):
            value = {'draft': False, 'prerelease': False, 'tag_name': 'v1.2.3'}
            value[flag] = True
            with self.assertRaises(ValueError):
                self.fetch(self.response(json.dumps(value).encode()))

    def test_preview_digest_must_match_before_pull(self):
        with mock.patch.object(u, '_official_digest', return_value=IMG), mock.patch.object(u, 'run') as run, self.assertRaises(ValueError):
            u.resolve_digest('1.2.3', 'mirror', 'sha256:' + 'f' * 64)
        run.assert_not_called()

    def test_image_version_must_match_once(self):
        for env in ([], ['NAPCAT_PLUS_VERSION=1.2.4'], ['NAPCAT_PLUS_VERSION=1.2.3', 'NAPCAT_PLUS_VERSION=1.2.3'], None):
            with self.subTest(env=env), mock.patch.object(u, '_official_digest', return_value=IMG), mock.patch.object(u, 'run', side_effect=['', json.dumps([IMG]), NEW, json.dumps(env)]), self.assertRaises(ValueError):
                u.resolve_digest('1.2.3', 'ghcr')

    def test_fixed_source_and_digest_resolution(self):
        digest = 'sha256:' + 'a' * 64
        official = u.OFFICIAL + '@' + digest
        mirror = u.SOURCES['mirror'] + '@' + digest
        calls = []
        def run(args, timeout=300):
            calls.append(args)
            if args[:2] == ['image', 'inspect']:
                if args[3] == '{{json .RepoDigests}}':
                    return json.dumps([mirror])
                if args[3] == '{{json .Config.Env}}':
                    return json.dumps(['NAPCAT_PLUS_VERSION=1.2.3'])
                return NEW
            return ''
        with mock.patch.object(u, 'run', side_effect=run), mock.patch.object(u, '_official_digest', return_value=official):
            self.assertEqual(u.resolve_digest('1.2.3', 'mirror'), (official, mirror, NEW))
        self.assertEqual([c for c in calls if c[0] == 'pull'], [['pull', mirror]])
        with mock.patch.object(u, 'run') as run_mock, self.assertRaises(ValueError):
            u.resolve_digest('1.2.3', 'https://evil.example/image')
        run_mock.assert_not_called()

    def test_wrong_mirror_digests_rejected(self):
        valid = IMG
        other = u.OFFICIAL + '@sha256:' + 'f' * 64
        for value in (None, [], [other], [valid, 123]):
            with self.subTest(value=value), mock.patch.object(u, '_official_digest', return_value=valid), mock.patch.object(u, 'run', side_effect=['', json.dumps(value)]), self.assertRaises(ValueError):
                u.resolve_digest('1.2.3', 'mirror')

    def test_registry_manifest_and_token_fail_closed(self):
        import hashlib
        manifest = json.dumps({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json'}).encode()
        digest = 'sha256:' + hashlib.sha256(manifest).hexdigest()
        headers = [('Content-Type', 'application/vnd.oci.image.index.v1+json'), ('Docker-Content-Digest', digest)]
        responses = [(200, [], b'{"token":"abc123"}'), (200, headers, manifest)]
        with mock.patch.object(u, 'registry_request', side_effect=responses) as registry:
            self.assertEqual(u._official_digest('1.2.3'), u.OFFICIAL + '@' + digest)
            self.assertEqual(registry.call_args_list[0].args[0], '/token?service=ghcr.io&scope=repository:ljy2231/napcat-plus:pull')
            self.assertEqual(registry.call_args_list[1].args[0], '/v2/ljy2231/napcat-plus/manifests/v1.2.3')
        for response in ((302, headers, manifest), (200, headers, manifest + b'x'), (200, [('Content-Type', 'text/html')], manifest), (200, headers + [('Docker-Content-Digest', digest)], manifest)):
            with self.subTest(response=response), mock.patch.object(u, 'registry_request', side_effect=[responses[0], response]), self.assertRaises((ValueError, json.JSONDecodeError)):
                u._official_digest('1.2.3')
        with mock.patch.object(u, 'registry_request', return_value=(200, [], b'{"token":"bad\\r\\ntoken"}')), self.assertRaises(ValueError):
            u._official_digest('1.2.3')

    def test_semver_numeric_order(self):
        self.assertGreater(u.version_parts('1.10.0'), u.version_parts('1.9.999'))
        for bad in ('01.2.3', '1.2.3-rc', '1.2.3+foo', 'v1.2.3', '1.2', '1.2.3\n', None):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                u.version_parts(bad)


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

    def load(self, volumes, extra=None, socket_uid=0):
        service = {'image': BASE, 'healthcheck': {'test': ['CMD', 'true']}, 'volumes': volumes}
        service.update(extra or {})
        self.compose_path.write_text(json.dumps({'services': {'web': service}}))
        original_lstat = Path.lstat

        def socket_lstat(path, *args, **kwargs):
            result = original_lstat(path, *args, **kwargs)
            if path == self.socket_path and socket_uid is not None:
                fields = list(result)
                fields[4] = socket_uid  # st_uid; retain the real type, mode and gid
                return os.stat_result(fields)
            return result

        with mock.patch.object(u, 'POLICY', self.policy), mock.patch.object(u, 'DATA_ROOT', self.data), mock.patch.object(u, 'COMPOSE_FILE', self.compose_path), mock.patch.object(u, 'SOCKET_DIR', self.socket_dir), mock.patch.object(u, 'SOCKET', str(self.socket_path)), mock.patch.object(u, 'trusted_path'), mock.patch.object(u.grp, 'getgrnam', return_value=mock.Mock(gr_gid=self.socket_path.stat().st_gid)), mock.patch.object(Path, 'lstat', socket_lstat):
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

    def test_socket_non_root_owner_rejected(self):
        # Exercise the real policy check with every other socket attribute valid.
        with self.assertRaisesRegex(ValueError, 'unsafe updater socket ownership or permissions'):
            self.load(self.volumes, socket_uid=12345)

    @unittest.skipIf(os.geteuid() == 0, 'requires a real non-root socket owner')
    def test_real_non_root_socket_owner_rejected(self):
        self.assertNotEqual(self.socket_path.lstat().st_uid, 0)
        with self.assertRaisesRegex(ValueError, 'unsafe updater socket ownership or permissions'):
            self.load(self.volumes, socket_uid=None)

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
        state_patch = mock.patch.object(u, 'STATE', Path(self.temp.name))
        state_patch.start()
        self.addCleanup(state_patch.stop)
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

    def test_preview_endpoint_rate_limit(self):
        u.preview_time = float('-inf')
        def get():
            client = self.connect()
            client.sendall(b'GET /preview HTTP/1.0\r\n\r\n')
            result = b''
            while True:
                chunk = client.recv(4096)
                if not chunk:
                    return result
                result += chunk
        with mock.patch.object(u, 'latest_version', return_value='1.2.3'), mock.patch.object(u, '_official_digest', return_value=IMG):
            response = get()
            self.assertIn(b'200 OK', response)
            body = json.loads(response.split(b'\r\n\r\n', 1)[1])
            self.assertEqual(body, {'version': '1.2.3', 'digest': IMG.split('@')[1]})
            self.assertIn(b'429', get())

    def test_source_allowlist_and_legacy_request(self):
        def request(body, extra=b''):
            client = self.connect()
            client.sendall(b'POST /update HTTP/1.1\r\nHost: localhost\r\nContent-Length: ' + str(len(body)).encode() + b'\r\n' + extra + b'\r\n' + body)
            response = b''
            while True:
                data = client.recv(4096)
                if not data:
                    break
                response += data
            return response
        with mock.patch.object(u, 'perform') as perform:
            expected_digest = 'sha256:' + 'a' * 64
            for source in ('ghcr', 'mirror'):
                body = json.dumps({'source': source, 'expectedVersion': '1.2.3', 'expectedDigest': expected_digest}).encode()
                self.assertIn(b'202 Accepted', request(body))
                deadline = time.monotonic() + 1
                while u.busy and time.monotonic() < deadline:
                    time.sleep(0.001)
                perform.assert_called_with(source, '1.2.3', expected_digest)
            self.assertIn(b'202 Accepted', request(b''))
            deadline = time.monotonic() + 1
            while u.busy and time.monotonic() < deadline:
                time.sleep(0.001)
            perform.assert_called_with('ghcr', None, None)
            perform.reset_mock()
            for body in (b'{"source":"http://evil"}', b'{"source":"ghcr","env":{}}', b'{"source":"ghcr","source":"mirror"}', b'[]', b'x' * 257):
                with self.subTest(body=body):
                    self.assertIn(b'400 Bad Request', request(body))
            self.assertIn(b'400 Bad Request', request(b'', b'Content-Length: 0\r\n'))
            perform.assert_not_called()

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
