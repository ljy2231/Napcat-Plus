"""Bootstrap tests. No real Docker, systemd, network or production paths."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('bootstrap_tested', Path(__file__).with_name('bootstrap.py'))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
IMAGE = 'ghcr.io/ljy2231/napcat-plus@sha256:' + 'a' * 64
IMAGE_ID = 'sha256:' + 'b' * 64
CID = 'c' * 64


def open_test_directory(path):
    path = Path(path)
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in path.parts[1:]:
            try:
                os.mkdir(component, 0o700, dir_fd=fd)
            except FileExistsError:
                pass
            new = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = new
        return fd
    except BaseException:
        os.close(fd)
        raise


def runtime_fixture():
    env = {'WEBUI_TOKEN': 'private-test-token', 'NAPCAT_PLUS_PINNED': '1', 'TZ': 'Asia/Shanghai'}
    service = {'image': 'ghcr.io/ljy2231/napcat-plus:v0.5.1', 'container_name': 'napcat-plus',
               'hostname': 'napcat-plus', 'environment': env,
               'ports': [{'target': 6099, 'published': '6099', 'protocol': 'tcp', 'host_ip': '0.0.0.0'}]}
    resolved = {'name': 'napcat-plus', 'services': {'napcat': service}}
    image = {'Id': IMAGE_ID, 'RepoDigests': [IMAGE], 'Config': {'Env': ['NAPCAT_PLUS_VERSION=0.5.1']}}
    container = {'Image': IMAGE_ID, 'Name': '/napcat-plus',
                 'State': {'Running': True, 'Health': {'Status': 'healthy'}},
                 'Config': {'Hostname': 'napcat-plus', 'Env': [f'{k}={v}' for k, v in env.items()],
                            'Labels': {'com.docker.compose.project': 'napcat-plus', 'com.docker.compose.service': 'napcat'}},
                 'Mounts': [{'Source': str(b.DATA / n), 'Destination': dest, 'Type': 'bind', 'RW': True} for n, dest in b.u.MOUNTS.items()],
                 'HostConfig': {'PortBindings': {'6099/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '6099'}]}}}
    return resolved, container, image


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='napcat-bootstrap-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name, value in {'DATA': self.root / 'data', 'OLD_COMPOSE': self.root / 'data/compose.yaml',
                            'ETC': self.root / 'etc', 'STATE': self.root / 'state', 'PROGRAM': self.root / 'program',
                            'UNITS': self.root / 'units', 'JOURNAL': self.root / 'journal', 'SOCKET_DIR': self.root / 'socket'}.items():
            patch = mock.patch.object(b, name, value)
            patch.start(); self.addCleanup(patch.stop)
        b.DATA.mkdir(); b.UNITS.mkdir()
        for name in b.u.MOUNTS:
            (b.DATA / name).mkdir()
            (b.DATA / name / 'sentinel').write_text('preserve-me')
        b.OLD_COMPOSE.write_text('original-compose-content')
        (b.DATA / '.env').write_text('WEBUI_TOKEN=private-test-token\n')
        mock.patch.object(subprocess, 'run', side_effect=AssertionError('real commands forbidden')).start()
        mock.patch.object(b.socket, 'create_connection', side_effect=AssertionError('real network forbidden')).start()
        self.addCleanup(mock.patch.stopall)

    def test_runtime_identity_and_drift_checks(self):
        resolved, container, image = runtime_fixture()
        self.assertEqual(b.validate_runtime(resolved, container, image, '0.5.1', IMAGE), IMAGE)
        for change in ('image_id', 'digest', 'environment', 'ports', 'mounts', 'labels', 'health', 'version'):
            r, c, i = copy.deepcopy((resolved, container, image))
            if change == 'image_id': c['Image'] = 'sha256:' + 'f' * 64
            elif change == 'digest': i['RepoDigests'] = []
            elif change == 'environment': c['Config']['Env'] = []
            elif change == 'ports': c['HostConfig']['PortBindings'] = {}
            elif change == 'mounts': c['Mounts'][0]['Source'] = '/var/run/docker.sock'
            elif change == 'labels': c['Config']['Labels']['com.docker.compose.project'] = 'another'
            elif change == 'health': c['State']['Health']['Status'] = 'unhealthy'
            elif change == 'version': i['Config']['Env'] = ['NAPCAT_PLUS_VERSION=0.4.0']
            with self.subTest(change=change), self.assertRaises((b.SetupError, ValueError)):
                b.validate_runtime(r, c, i, '0.5.1', IMAGE)

    def plan(self):
        return {'version': '0.5.1', 'image_id': IMAGE_ID, 'container': CID, 'origin': 'http://localhost:6099',
                'compose': {'services': {'napcat': {'image': IMAGE}}},
                'policy': {'project': 'napcat-plus', 'service': 'napcat', 'compose_file': str(b.ETC / 'compose.json'), 'image': IMAGE, 'generation': 1},
                'baseline': {'image': IMAGE, 'generation': 1, 'version': '0.5.1', 'policy_image': IMAGE},
                'original': {'name': 'napcat-plus', 'services': {'napcat': {'image': IMAGE}}}}

    def apply_with_mocks(self, *, fail_webui=False, uncertain=False):
        plan = self.plan()
        calls = []
        def docker(*args, timeout=60):
            calls.append(args)
            if 'stop' in args and uncertain:
                raise b.CommandUncertain('uncertain')
            if 'ps' in args: return CID
            return ''
        connection = mock.Mock()
        connection.getresponse.return_value.status = 200
        connection.getresponse.return_value.read.return_value = b'{"phase":"blocked"}'
        with mock.patch.object(b, 'preflight', return_value=plan), mock.patch.object(b, 'docker', side_effect=docker), \
             mock.patch.object(b, 'systemctl') as systemctl, mock.patch.object(b, 'command'), \
             mock.patch.object(b.grp, 'getgrnam', return_value=mock.Mock()), \
             mock.patch.object(os, 'geteuid', return_value=0), \
             mock.patch.object(b.p, 'open_directory', side_effect=open_test_directory), \
             mock.patch.object(b, 'UnixConnection', return_value=connection), mock.patch.object(b, 'wait_healthy'), \
             mock.patch.object(b, 'check_socket_from_container', side_effect=b.SetupError('verification failed') if fail_webui else None):
            if fail_webui or uncertain:
                with self.assertRaises(b.SetupError): b.apply(plan)
            else:
                b.apply(plan)
            return calls, systemctl.call_args_list

    def test_success_keeps_one_compose_authority_and_data_backup(self):
        calls, _ = self.apply_with_mocks()
        self.assertEqual(json.loads(b.OLD_COMPOSE.read_text()), {'include': [str(b.ETC / 'compose.json')], 'name': 'napcat-plus'})
        self.assertEqual(json.loads((b.JOURNAL / 'setup.json').read_text())['phase'], 'complete')
        self.assertTrue((b.JOURNAL / 'data.tar.gz').is_file())
        self.assertTrue((b.STATE / 'committed.json').is_file())
        self.assertTrue(any('stop' in args for args in calls))
        self.assertEqual((b.DATA / 'qq/sentinel').read_text(), 'preserve-me')

    def test_failed_connection_rolls_back_without_deleting_data_or_state(self):
        calls, service_calls = self.apply_with_mocks(fail_webui=True)
        self.assertEqual(json.loads((b.JOURNAL / 'setup.json').read_text())['phase'], 'rolled_back')
        self.assertEqual(json.loads(b.OLD_COMPOSE.read_text()), self.plan()['original'])
        self.assertTrue(any('rollback.json' in ' '.join(args) and 'up' in args for args in calls))
        self.assertTrue((b.STATE / 'committed.json').is_file())
        self.assertEqual((b.DATA / 'qq/sentinel').read_text(), 'preserve-me')

    def test_timeout_quarantines_without_competing_rollback(self):
        calls, _ = self.apply_with_mocks(uncertain=True)
        self.assertEqual(json.loads((b.JOURNAL / 'setup.json').read_text())['phase'], 'blocked')
        self.assertFalse(any('up' in args for args in calls))
        self.assertEqual(b.OLD_COMPOSE.read_text(), 'original-compose-content')

    def test_no_apply_without_explicit_trust(self):
        with mock.patch.object(b, 'preflight', return_value=self.plan()), mock.patch.object(b, 'apply') as apply:
            self.assertEqual(b.main(['--origin', 'http://localhost:6099', '--apply']), 1)
            apply.assert_not_called()
            self.assertFalse(b.JOURNAL.exists())


if __name__ == '__main__':
    unittest.main()
