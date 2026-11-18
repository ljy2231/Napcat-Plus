#!/usr/bin/env python3
"""Tests for prepare.py (no Docker, no root paths)."""
import contextlib
import importlib.util
import io
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location('prepare', Path(__file__).with_name('prepare.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

CURRENT = 'ghcr.io/example/napcat-plus@sha256:' + 'a' * 64
TARGET = 'ghcr.io/example/napcat-plus@sha256:' + 'b' * 64
DATA = '/opt/napcat-plus'


def resolved(service='napcat', image=CURRENT, with_healthcheck=True, extra_service=False, mounts=None):
    volumes = mounts if mounts is not None else [
        {'type': 'bind', 'source': f'{DATA}/qq', 'target': '/app/.config/QQ', 'bind': {}},
        {'type': 'bind', 'source': f'{DATA}/config', 'target': '/app/napcat/config', 'bind': {}},
        {'type': 'bind', 'source': f'{DATA}/plugins', 'target': '/app/napcat/plugins', 'bind': {}},
    ]
    entry = {
        'image': image,
        'container_name': 'napcat-plus',
        'hostname': 'napcat-plus',
        'restart': 'unless-stopped',
        'environment': {'WEBUI_TOKEN': 'secret-token', 'TZ': 'Asia/Shanghai'},
        'ports': [{'mode': 'ingress', 'host_ip': '0.0.0.0', 'published': '6099', 'target': 6099, 'protocol': 'tcp'}],
        'volumes': volumes,
    }
    if with_healthcheck:
        entry['healthcheck'] = {'test': ['CMD-SHELL', 'test -f /ok'], 'interval': '30s', 'retries': 3}
    services = {service: entry}
    if extra_service:
        services['other'] = {'image': CURRENT}
    return {'name': 'napcat-plus', 'networks': {'default': {}}, 'services': services}


def build(value=None, mounts=None, **kwargs):
    options = {'project': 'napcat-plus', 'service_name': 'napcat', 'data_root': DATA,
               'origin': 'https://console.example.test', 'target_image': TARGET,
               'current_image': CURRENT, 'generation': 2}
    options.update(kwargs)
    if value is None:
        value = resolved(mounts=mounts)
    return p.build(value, **options)


class BuildTests(unittest.TestCase):
    def test_builds_strict_compose_with_socket_and_updater_env(self):
        compose, policy, baseline = build()
        service = compose['services']['napcat']
        self.assertEqual(set(compose), {'services'})
        self.assertEqual(service['image'], CURRENT)
        self.assertEqual(service['volumes'], [
            f'{DATA}/qq:/app/.config/QQ',
            f'{DATA}/config:/app/napcat/config',
            f'{DATA}/plugins:/app/napcat/plugins',
            '/run/napcat-docker-updater:/run/napcat-docker-updater:ro',
        ])
        self.assertEqual(service['environment']['WEBUI_TOKEN'], 'secret-token')
        self.assertEqual(service['environment']['NAPCAT_DOCKER_UPDATER'], '1')
        self.assertEqual(service['environment']['NAPCAT_DOCKER_UPDATER_ORIGIN'], 'https://console.example.test')
        self.assertEqual(service['container_name'], 'napcat-plus')
        self.assertEqual(service['hostname'], 'napcat-plus')
        self.assertEqual(service['ports'], ['0.0.0.0:6099:6099/tcp'])
        self.assertEqual(policy, {
            'project': 'napcat-plus', 'service': 'napcat',
            'compose_file': '/etc/napcat-docker-updater/compose.json',
            'image': TARGET, 'generation': 2,
        })
        self.assertEqual(baseline, {'generation': 1, 'image': CURRENT})

    def test_redirecting_preview_hides_token(self):
        compose, _, _ = build()
        preview = json.dumps(p.redact(compose))
        self.assertNotIn('secret-token', preview)
        self.assertIn('<redacted>', preview)

    def test_rejects_unsafe_or_mismatched_inputs(self):
        other = 'ghcr.io/example/napcat-plus@sha256:' + 'c' * 64
        cases = [
            (lambda: build(target_image=CURRENT), '目标镜像不能等于当前'),
            (lambda: build(target_image='ghcr.io/example/napcat-plus:latest'), 'sha256'),
            (lambda: build(current_image=other), '当前 Compose 镜像'),
            (lambda: build(generation=1), 'generation'),
            (lambda: build(value=resolved(with_healthcheck=False)), 'healthcheck'),
            (lambda: build(value=resolved(extra_service=True)), '恰好一个服务'),
            (lambda: build(value=resolved(service='other')), '恰好一个服务'),
            (lambda: build(mounts=[
                {'type': 'bind', 'source': f'{DATA}/qq', 'target': '/app/.config/QQ', 'bind': {}},
                {'type': 'bind', 'source': f'{DATA}/config', 'target': '/app/napcat/config', 'bind': {}},
                {'type': 'bind', 'source': '/var/run/docker.sock', 'target': '/app/napcat/plugins', 'bind': {}},
            ]), '不受支持的挂载'),
            (lambda: build(mounts=[
                {'type': 'bind', 'source': f'{DATA}/qq', 'target': '/app/.config/QQ', 'bind': {}},
                {'type': 'bind', 'source': f'{DATA}/config', 'target': '/app/napcat/config', 'bind': {}},
                {'type': 'bind', 'source': f'{DATA}/plugins', 'target': '/app/napcat/plugins', 'bind': {}},
                {'type': 'bind', 'source': f'{DATA}/extra', 'target': '/extra', 'bind': {}},
            ]), '三个数据挂载'),
            (lambda: build(origin='https://console.example.test/path'), 'origin'),
            (lambda: build(origin='http://user:pass@host'), 'origin'),
            (lambda: build(data_root='/srv/other'), '不受支持的挂载'),
        ]
        for fn, message in cases:
            with self.subTest(message=message):
                with self.assertRaises(p.PrepareError) as ctx:
                    fn()
                self.assertIn(message, str(ctx.exception))

    def test_rejects_dollar_and_forbidden_fields(self):
        value = resolved()
        value['services']['napcat']['environment']['WEBUI_TOKEN'] = 'a$b'
        with self.assertRaises(p.PrepareError):
            build(value=value)
        value = resolved()
        value['services']['napcat']['networks'] = {'default': None}
        with self.assertRaises(p.PrepareError):
            build(value=value)


class ApplyTests(unittest.TestCase):
    def test_apply_writes_root_only_files_and_refuses_overwrite(self):
        compose, policy, baseline = build()
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'updater'
            with mock.patch.object(os, 'geteuid', return_value=0):
                p.apply_files(out, compose, policy, baseline, force=False)
                self.assertEqual(stat.S_IMODE(out.stat().st_mode), 0o700)
                for name in ('compose.json', 'policy.json', 'committed.json'):
                    path = out / name
                    self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                    json.loads(path.read_text())
                with self.assertRaises(p.PrepareError):
                    p.apply_files(out, compose, policy, baseline, force=False)

    def test_cli_dry_run_redacts_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            resolved_path = Path(tmp) / 'resolved.json'
            resolved_path.write_text(json.dumps(resolved()))
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(io.StringIO()):
                code = p.main(['--resolved', str(resolved_path), '--project', 'napcat-plus', '--service', 'napcat',
                               '--origin', 'https://console.example.test', '--target-image', TARGET,
                               '--current-image', CURRENT, '--generation', '2'])
            self.assertEqual(code, 0)
            output = stdout.getvalue()
            self.assertNotIn('secret-token', output)
            self.assertIn('<redacted>', output)
            self.assertIn(TARGET, output)


if __name__ == '__main__':
    unittest.main()
