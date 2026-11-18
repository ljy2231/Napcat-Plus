#!/usr/bin/env python3
"""Offline tests; no containers and no production paths are touched."""
import contextlib
import copy
import importlib.util
import io
import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location('prepare', Path(__file__).with_name('prepare.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

CURRENT = 'ghcr.io/example/napcat-plus@sha256:' + 'a' * 64
DATA = '/opt/napcat-plus'


def resolved():
    return {'name': 'napcat-plus', 'services': {'napcat': {
        'image': 'ghcr.io/example/napcat-plus:v0.5.1', 'container_name': 'napcat-plus',
        'hostname': 'napcat-plus', 'restart': 'unless-stopped',
        'environment': {'WEBUI_TOKEN': 'secret-token', 'OTHER_SECRET': 'also-secret', 'TZ': 'Asia/Shanghai'},
        'ports': [{'mode': 'ingress', 'host_ip': '0.0.0.0', 'published': '6099', 'target': 6099, 'protocol': 'tcp'}],
        'volumes': [{'type': 'bind', 'source': f'{DATA}/{name}', 'target': target,
                     'bind': {'create_host_path': True}} for name, target in p.MOUNTS.items()],
        'healthcheck': {'test': ['CMD-SHELL', 'test -f /ok'], 'interval': '30s', 'retries': 3},
        'networks': {'default': None}, 'stop_grace_period': '30s',
    }}, 'networks': {'default': {'name': 'napcat-plus_default'}}}


def build(value=None, **kwargs):
    options = {'project': 'napcat-plus', 'service_name': 'napcat', 'data_root': DATA,
               'origin': 'https://console.example.test', 'target_image': CURRENT,
               'current_image': CURRENT, 'current_version': '0.5.1', 'generation': 1}
    options.update(kwargs)
    return p.build(resolved() if value is None else value, **options)


class BuildTests(unittest.TestCase):
    def test_resolved_config_preserves_identity_and_initializes(self):
        compose, policy, baseline = build()
        service = compose['services']['napcat']
        self.assertEqual(service['image'], CURRENT)
        self.assertEqual(service['container_name'], 'napcat-plus')
        self.assertEqual(service['hostname'], 'napcat-plus')
        self.assertEqual(service['environment']['OTHER_SECRET'], 'also-secret')
        self.assertEqual(service['environment']['NAPCAT_DOCKER_UPDATER'], '1')
        self.assertEqual(service['ports'], ['0.0.0.0:6099:6099/tcp'])
        self.assertEqual(len(service['volumes']), 4)
        self.assertEqual(policy['image'], CURRENT)
        self.assertEqual(policy['generation'], 1)
        self.assertEqual(baseline, {'generation': 1, 'image': CURRENT, 'version': '0.5.1', 'policy_image': CURRENT})
        preview = json.dumps(p.redact(compose))
        self.assertNotIn('secret-token', preview)
        self.assertNotIn('also-secret', preview)

    def test_rejects_unknown_or_semantic_options(self):
        changes = [
            lambda v: v.update({'volumes': {'hidden': {}}}),
            lambda v: v.update({'name': 'wrong'}),
            lambda v: v['networks'].update({'other': {}}),
            lambda v: v['networks']['default'].update({'external': True}),
            lambda v: v['services']['napcat'].update({'privileged': True}),
            lambda v: v['services']['napcat'].update({'network_mode': 'host'}),
            lambda v: v['services']['napcat'].update({'networks': {'default': {'aliases': ['evil']}}}),
            lambda v: v['services']['napcat']['volumes'][0].update({'read_only': True}),
            lambda v: v['services']['napcat']['volumes'][0]['bind'].update({'propagation': 'shared'}),
            lambda v: v['services']['napcat']['ports'][0].update({'app_protocol': 'http'}),
            lambda v: v['services']['napcat']['healthcheck'].update({'disable': True}),
            lambda v: v['services']['napcat']['environment'].update({'OTHER_SECRET': '$secret'}),
            lambda v: v['services']['napcat']['environment'].update({'OTHER_SECRET': None}),
            lambda v: v['services']['napcat'].update({'image': 'other@sha256:' + 'b'*64}),
        ]
        for change in changes:
            value = resolved()
            change(value)
            with self.subTest(value=value):
                with self.assertRaises(p.PrepareError):
                    build(value)

    def test_digest_version_and_generation_required(self):
        for kwargs in ({'current_image': 'tag'}, {'target_image': 'tag'},
                       {'target_image': 'ghcr.io/example/napcat-plus@sha256:' + 'b'*64},
                       {'current_version': 'v0.5.1'}, {'current_version': '00.5.1'},
                       {'current_version': '0.5.1-rc.1'}, {'generation': 0}):
            with self.subTest(kwargs=kwargs), self.assertRaises(p.PrepareError):
                build(**kwargs)
        value = resolved()
        value['services']['napcat']['image'] = CURRENT
        build(value)

    def test_data_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'data'
            root.mkdir()
            (root / 'qq').symlink_to('/tmp')
            value = resolved()
            for volume, name in zip(value['services']['napcat']['volumes'], p.MOUNTS):
                volume['source'] = str(root / name)
            with self.assertRaises(p.PrepareError):
                build(value, data_root=str(root))

    @unittest.skipUnless(shutil.which('docker'), 'docker compose not installed')
    def test_real_compose_config_default_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = root / 'private.env'
            env.write_text('WEBUI_TOKEN=fake-test-token\nTZ=Etc/UTC\n')
            config = root / 'compose.json'
            service = resolved()['services']['napcat']
            service.pop('networks')
            service['env_file'] = [str(env)]
            service.pop('environment')
            for volume, name in zip(service['volumes'], p.MOUNTS):
                volume['source'] = str(root / name)
            config.write_text(json.dumps({'name': 'napcat-plus', 'services': {'napcat': service}}))
            result = subprocess.run(['docker', 'compose', '-f', str(config), 'config', '--format', 'json'],
                                    capture_output=True, text=True, check=True, env={**os.environ, 'COMPOSE_DISABLE_ENV_FILE': '1'})
            resolved_config = json.loads(result.stdout)
            # Test Compose's normalization without touching the real /opt directory.
            for volume, name in zip(resolved_config['services']['napcat']['volumes'], p.MOUNTS):
                volume['source'] = str(p.Path('/opt/napcat-plus') / name)
            with mock.patch.object(p, 'reject_symlink_components'):
                compose, _, _ = build(resolved_config)
            self.assertEqual(compose['services']['napcat']['environment']['WEBUI_TOKEN'], 'fake-test-token')
            with self.assertRaises(p.PrepareError):
                build(resolved_config, data_root=str(root))


class ApplyTests(unittest.TestCase):
    def test_separate_directories_and_no_overwrite(self):
        compose, policy, baseline = build()
        with tempfile.TemporaryDirectory() as tmp:
            out, state = Path(tmp) / 'etc', Path(tmp) / 'state'
            with mock.patch.object(os, 'geteuid', return_value=0):
                p.apply_files(out, state, compose, policy, baseline)
                for path in (out / 'compose.json', out / 'policy.json', state / 'committed.json'):
                    self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                    json.loads(path.read_text())
                self.assertFalse((out / 'committed.json').exists())
                before = (state / 'committed.json').read_bytes()
                with self.assertRaises(p.PrepareError):
                    p.apply_files(out, state, compose, policy, baseline)
                self.assertEqual((state / 'committed.json').read_bytes(), before)

    def test_existing_state_prevents_writes_and_symlink_ancestors_rejected(self):
        compose, policy, baseline = build()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            out, state = root / 'etc', root / 'state'
            state.mkdir(mode=0o700)
            (state / 'pending.json').write_text('do-not-touch')
            with mock.patch.object(os, 'geteuid', return_value=0):
                with self.assertRaises(p.PrepareError):
                    p.apply_files(out, state, compose, policy, baseline)
                self.assertEqual((state / 'pending.json').read_text(), 'do-not-touch')
                self.assertFalse((out / 'compose.json').exists())
                (root / 'link').symlink_to(out, target_is_directory=True)
                with self.assertRaises((p.PrepareError, OSError)):
                    p.apply_files(root / 'link' / 'sub', root / 'other', compose, policy, baseline)
                self.assertFalse((out / 'sub').exists())

    def test_input_symlink_and_duplicate_keys_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'resolved.json'
            path.write_text('{"services": {}, "services": {}}')
            with self.assertRaises(p.PrepareError):
                p.read_resolved(path)
            link = Path(tmp) / 'link'
            link.symlink_to(path)
            with self.assertRaises(OSError):
                p.read_resolved(link)

    def test_cli_redacts_all_env_and_warns_identity_not_verified(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'resolved.json'
            path.write_text(json.dumps(resolved()))
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = p.main(['--resolved', str(path), '--project', 'napcat-plus', '--service', 'napcat',
                               '--origin', 'https://console.example.test', '--target-image', CURRENT,
                               '--current-image', CURRENT, '--current-version', '0.5.1', '--generation', '1'])
            self.assertEqual(code, 0)
            self.assertNotIn('secret-token', stdout.getvalue())
            self.assertNotIn('also-secret', stdout.getvalue())
            self.assertIn('未验证运行容器身份', stderr.getvalue())
            self.assertEqual(list(Path(tmp).iterdir()), [path])


if __name__ == '__main__':
    unittest.main()
