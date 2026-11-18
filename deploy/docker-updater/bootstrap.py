#!/usr/bin/env python3
"""Opt-in migration of the official rootful Linux one-command installation.

Default: read-only preflight. --apply --accept-official-releases explicitly
trusts this project's published stable GitHub/GHCR releases and recreates only
that verified installation once. No arbitrary Docker host, paths or commands.
"""
import argparse
import grp
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import tarfile
import time

HERE = Path(__file__).resolve().parent

def module(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

p = module('prepare')
u = module('updater')
DATA = Path('/opt/napcat-plus')
OLD_COMPOSE = DATA / 'compose.yaml'
ETC = Path('/etc/napcat-docker-updater')
STATE = Path('/var/lib/napcat-docker-updater')
PROGRAM = Path('/usr/local/libexec/napcat-docker-updater')
UNITS = Path('/etc/systemd/system')
JOURNAL = Path('/var/lib/napcat-updater-setup')
SOCKET_DIR = Path('/run/napcat-docker-updater')
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'DOCKER_CONFIG': '/root/.docker'}
SOURCE_RE = re.compile(r'^(ghcr\.io/ljy2231/napcat-plus|hub\.002230\.xyz:44300/ghcr\.io/ljy2231/napcat-plus):v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$')


class SetupError(Exception):
    pass


class CommandUncertain(SetupError):
    pass


def command(args, timeout=60):
    try:
        result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, check=True, timeout=timeout, env=ENV)
        return result.stdout.strip()
    except subprocess.TimeoutExpired:
        raise CommandUncertain('command timed out; inspect the setup journal before retrying') from None
    except subprocess.CalledProcessError:
        # Compose/Docker output can contain environment variables and credentials.
        raise SetupError('host command failed; no command output was exposed') from None


def docker(*args, timeout=60):
    return command(['/usr/bin/docker', *args], timeout)


def systemctl(*args):
    return command(['/usr/bin/systemctl', *args])


def inspect_image(image):
    values = json.loads(docker('image', 'inspect', image))
    if not isinstance(values, list) or len(values) != 1:
        raise SetupError('ambiguous image')
    return values[0]


def current_version(image):
    values = image.get('Config', {}).get('Env') or []
    versions = [v.split('=', 1)[1] for v in values if isinstance(v, str) and v.startswith('NAPCAT_PLUS_VERSION=')]
    if len(versions) != 1:
        raise SetupError('image lacks a unique product version')
    u.version_parts(versions[0])
    return versions[0]


def managed_args(compose_file):
    return ['compose', '--project-name', 'napcat-plus', '--project-directory', str(DATA), '-f', str(compose_file)]


def check_host():
    if os.geteuid() != 0 or not Path('/run/systemd/system').is_dir():
        raise SetupError('root and an active systemd host are required')
    if not Path('/usr/bin/docker').is_file() or not Path('/usr/bin/systemctl').is_file():
        raise SetupError('Docker CLI and systemd are required at their standard paths')
    docker('compose', 'version')
    info = json.loads(docker('info', '--format', '{{json .}}'))
    options = ' '.join(str(x) for x in info.get('SecurityOptions', []))
    if any(x in options for x in ('rootless', 'userns', 'selinux')) or info.get('OSType') != 'linux' or info.get('Architecture') not in ('x86_64', 'amd64'):
        raise SetupError('only rootful Linux amd64 without userns/SELinux is currently supported')
    if Path('/var/run/docker.sock').resolve() != Path('/run/docker.sock') or not stat.S_ISSOCK(Path('/run/docker.sock').stat().st_mode):
        raise SetupError('the standard local Docker socket is required')
    for directory in (DATA, UNITS, PROGRAM.parent, JOURNAL.parent, ETC.parent, STATE.parent):
        existing = directory
        while not existing.exists():
            if existing.is_symlink():
                raise SetupError('unsafe symlink in installation path')
            existing = existing.parent
        u.trusted_path(existing)
    for path in (OLD_COMPOSE, DATA / '.env'):
        u.trusted_path(path)
        if not path.is_file():
            raise SetupError('the official one-command installation was not found')
    for path in (ETC, STATE, PROGRAM, SOCKET_DIR, JOURNAL,
                 UNITS / 'napcat-docker-updater.service', UNITS / 'napcat-docker-updater.socket'):
        if path.exists() or path.is_symlink():
            raise SetupError('an updater or previous setup journal already exists; do not overwrite or reset it')
    for name in ('updater.py', 'prepare.py', 'napcat-docker-updater.service', 'napcat-docker-updater.socket'):
        source = HERE / name
        if source.is_symlink() or not source.is_file():
            raise SetupError('the complete trusted updater bundle is required')
        u.trusted_path(source)


def validate_runtime(resolved, container, image, version, official):
    if resolved.get('name') != 'napcat-plus' or set(resolved.get('services', {})) != {'napcat'}:
        raise SetupError('only the official single-service installation is supported')
    svc = resolved['services']['napcat']
    match = SOURCE_RE.fullmatch(svc.get('image', ''))
    if not match or match.group(2) != version:
        raise SetupError('Compose must reference the matching official stable version tag')
    fixed = match.group(1) + '@' + official.split('@', 1)[1]
    if container.get('Image') != image.get('Id') or not u.ID.fullmatch(image.get('Id', '')):
        raise SetupError('the running container differs from the inspected image')
    if fixed not in (image.get('RepoDigests') or []):
        raise SetupError('running image does not match the independently resolved official digest')
    if current_version(image) != version:
        raise SetupError('image version does not match the official tag')
    labels = container.get('Config', {}).get('Labels') or {}
    if labels.get('com.docker.compose.project') != 'napcat-plus' or labels.get('com.docker.compose.service') != 'napcat':
        raise SetupError('the existing container is not owned by this official Compose project')
    state = container.get('State', {})
    if not state.get('Running') or state.get('Health', {}).get('Status') != 'healthy':
        raise SetupError('the existing container must be healthy before migration')
    if svc.get('container_name') != 'napcat-plus' or svc.get('hostname') != 'napcat-plus':
        raise SetupError('custom container identity is not supported by automatic setup')
    if container.get('Config', {}).get('Hostname') != 'napcat-plus' or container.get('Name') != '/napcat-plus':
        raise SetupError('running container identity differs from Compose')
    mounts = container.get('Mounts') or []
    expected = {(str(DATA / n), dest) for n, dest in u.MOUNTS.items()}
    if len(mounts) != 3 or {(x.get('Source'), x.get('Destination')) for x in mounts} != expected or any(x.get('Type') != 'bind' or not x.get('RW') for x in mounts):
        raise SetupError('running container mounts differ from the official data layout')
    for name in u.MOUNTS:
        source = DATA / name
        if source.is_symlink() or not source.is_dir() or source.resolve() != source:
            raise SetupError('data directories must be real directories in the fixed install path')
    # Ensure every running setting agrees with the future configuration. In
    # particular, a changed .env must not silently rotate credentials on migration.
    runtime_env = dict(v.split('=', 1) for v in container.get('Config', {}).get('Env', []) if '=' in v)
    for key, value in svc.get('environment', {}).items():
        if runtime_env.get(key) != value:
            raise SetupError('running environment differs from Compose; resolve drift first')
    expected_ports = set()
    for entry in svc.get('ports') or []:
        if not isinstance(entry, dict):
            raise SetupError('unexpected normalized ports')
        expected_ports.add((f"{entry['target']}/{entry.get('protocol', 'tcp')}", entry.get('host_ip') or '', str(entry.get('published', ''))))
    actual_ports = set()
    for target, bindings in (container.get('HostConfig', {}).get('PortBindings') or {}).items():
        for entry in bindings or []:
            actual_ports.add((target, entry.get('HostIp') or '', str(entry.get('HostPort', ''))))
    if actual_ports != expected_ports:
        raise SetupError('running port mappings differ from Compose')
    return fixed


def preflight(origin):
    check_host()
    origin = p.parse_origin(origin)
    resolved = json.loads(docker(*managed_args(OLD_COMPOSE), 'config', '--format', 'json'))
    cid = docker(*managed_args(OLD_COMPOSE), 'ps', '-q', '--all', 'napcat')
    if not re.fullmatch(r'[a-f0-9]{12,64}', cid):
        raise SetupError('exactly one existing container is required')
    containers = json.loads(docker('inspect', cid))
    if not isinstance(containers, list) or len(containers) != 1:
        raise SetupError('ambiguous container')
    container = containers[0]
    svc = resolved.get('services', {}).get('napcat') or {}
    match = SOURCE_RE.fullmatch(svc.get('image', ''))
    if not match:
        raise SetupError('custom image references are not supported')
    version = match.group(2)
    image = inspect_image(svc['image'])
    official = u.bounded_discovery(lambda: u._official_digest(version))
    fixed = validate_runtime(resolved, container, image, version, official)
    compose, policy, baseline = p.build(resolved, 'napcat-plus', 'napcat', str(DATA), origin,
                                        fixed, fixed, 1, version)
    # Rootful container root can connect to the restricted root-owned socket;
    # rootless/userns modes are refused and permissions are never opened to all.
    original = json.loads(json.dumps(resolved))
    original['services']['napcat']['image'] = fixed
    return {'container': cid, 'image_id': image['Id'], 'version': version, 'compose': compose, 'original': original,
            'policy': policy, 'baseline': baseline, 'origin': origin,
            'compose_hash': hashlib.sha256(OLD_COMPOSE.read_bytes()).hexdigest(),
            'env_hash': hashlib.sha256((DATA / '.env').read_bytes()).hexdigest()}


def write_exclusive(path, data, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as target:
        target.write(data)
        target.flush()
        os.fsync(target.fileno())
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def record(phase, **extra):
    u.atomic_json(JOURNAL / 'setup.json', {'phase': phase, **extra})


def wait_healthy(cid, image_id):
    deadline = time.monotonic() + 120
    while True:
        state = json.loads(docker('inspect', '--format', '{{json .}}', cid))
        running = state.get('State', {})
        if state.get('Image') != image_id or not running.get('Running'):
            raise SetupError('migrated container is not running the verified image')
        health = running.get('Health', {}).get('Status')
        if health == 'healthy':
            return
        if health not in ('starting',) or time.monotonic() >= deadline:
            raise SetupError('container health did not recover')
        time.sleep(2)


class UnixConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(5)
        self.sock.connect(str(SOCKET_DIR / 'updater.sock'))


def check_socket_from_container(cid, origin):
    # Test the actual authenticated WebUI -> socket path without exposing the token
    # in a command argument. The verification program is sent through stdin.
    script = r'''import hashlib,http.client,json,urllib.request
with open('/app/napcat/config/webui.json') as f: token=json.load(f)['token']
body=json.dumps({'hash':hashlib.sha256((token+'.napcat').encode()).hexdigest()}).encode()
req=urllib.request.Request('http://127.0.0.1:6099/api/auth/login',data=body,headers={'Content-Type':'application/json'})
with urllib.request.urlopen(req,timeout=10) as r: auth=json.load(r)
credential=(auth.get('data') or {}).get('Credential')
if not credential: raise RuntimeError('authentication requires manual verification, e.g. 2FA')
req=urllib.request.Request('http://127.0.0.1:6099/api/Console/docker-update/status',headers={'Authorization':'Bearer '+credential})
with urllib.request.urlopen(req,timeout=10) as r: result=json.load(r)
if result.get('code')!=0 or result.get('data',{}).get('enabled') is not True: raise RuntimeError('host updater unavailable')
'''
    try:
        subprocess.run(['/usr/bin/docker', 'exec', '-i', cid, 'python3', '-'], input=script,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True,
                       timeout=30, env=ENV)
    except (subprocess.SubprocessError, OSError):
        raise SetupError('authenticated WebUI-to-host verification failed; inspect the local setup journal') from None


def apply(plan):
    # Re-run read-only preflight immediately before the first side effect.
    fresh = preflight(plan['origin'])
    if fresh != plan:
        raise SetupError('installation changed during preview; review again')
    os.umask(0o077)
    JOURNAL.mkdir(mode=0o700)
    record('preparing', version=plan['version'], image_id=plan['image_id'])
    write_exclusive(JOURNAL / 'original-compose.yaml', OLD_COMPOSE.read_bytes())
    write_exclusive(JOURNAL / 'resolved-original.json', json.dumps(plan['original']).encode())
    backup_tag = 'napcat-updater-setup:previous'
    docker('tag', plan['image_id'], backup_tag)
    try:
        grp.getgrnam('napcat-updater')
    except KeyError:
        command(['/usr/sbin/groupadd', '--system', 'napcat-updater'])
    PROGRAM.mkdir(mode=0o755, parents=True)
    for name in ('updater.py', 'prepare.py'):
        write_exclusive(PROGRAM / name, (HERE / name).read_bytes(), 0o644)
    for name in ('napcat-docker-updater.socket', 'napcat-docker-updater.service'):
        write_exclusive(UNITS / name, (HERE / name).read_bytes(), 0o644)
    p.apply_files(ETC, STATE, plan['compose'], plan['policy'], plan['baseline'])
    # Do not allow a newly recreated WebUI to start another upgrade before the
    # installation journal and authoritative Compose redirect are committed.
    u.atomic_json(STATE / 'status.json', {'phase': 'blocked', 'message': 'host setup in progress'})
    record('configured', version=plan['version'], image_id=plan['image_id'])
    systemctl('daemon-reload')
    systemctl('enable', '--now', 'napcat-docker-updater.socket')
    connection = UnixConnection('localhost', timeout=5)
    try:
        connection.request('GET', '/status')
        response = connection.getresponse()
        if response.status != 200 or json.loads(response.read()).get('phase') != 'blocked':
            raise SetupError('host socket activation failed')
    finally:
        connection.close()
    # Persist the data snapshot only after stopping the application. No deletion
    # or restoration of user data is ever attempted automatically.
    try:
        record('stopping', version=plan['version'], image_id=plan['image_id'])
        docker(*managed_args(OLD_COMPOSE), 'stop', 'napcat')
        with tarfile.open(JOURNAL / 'data.tar.gz', 'w:gz', dereference=False) as archive:
            for name in u.MOUNTS:
                archive.add(DATA / name, arcname=name, recursive=True)
        fd = os.open(JOURNAL / 'data.tar.gz', os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        record('backed_up', version=plan['version'], image_id=plan['image_id'])
        docker(*managed_args(ETC / 'compose.json'), 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'napcat', timeout=300)
        cid = docker(*managed_args(ETC / 'compose.json'), 'ps', '-q', '--all', 'napcat')
        if not re.fullmatch(r'[a-f0-9]{12,64}', cid):
            raise SetupError('migrated container missing')
        wait_healthy(cid, plan['image_id'])
        check_socket_from_container(cid, plan['origin'])
        # Keep the ordinary installer Compose path authoritative. It becomes a
        # private include of the managed file, so ordinary compose up cannot
        # silently restore the old version tag after a successful web update.
        u.atomic_json(OLD_COMPOSE, {'include': [str(ETC / 'compose.json')], 'name': 'napcat-plus'})
        record('complete', version=plan['version'], image_id=plan['image_id'])
        u.atomic_json(STATE / 'status.json', {'phase': 'idle', 'message': 'host setup complete'})
    except CommandUncertain:
        record('blocked', reason='docker outcome uncertain; manual recovery required')
        raise
    except Exception:
        try:
            override = JOURNAL / 'rollback.json'
            write_exclusive(override, json.dumps({'services': {'napcat': {'image': backup_tag}}}).encode())
            docker(*managed_args(JOURNAL / 'resolved-original.json'), '-f', str(override),
                   'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'napcat', timeout=300)
            cid = docker(*managed_args(JOURNAL / 'resolved-original.json'), 'ps', '-q', '--all', 'napcat')
            wait_healthy(cid, plan['image_id'])
            u.atomic_json(OLD_COMPOSE, json.loads((JOURNAL / 'resolved-original.json').read_text()))
            systemctl('disable', '--now', 'napcat-docker-updater.socket')
            systemctl('stop', 'napcat-docker-updater.service')
            record('rolled_back', reason='original image restored; data backup retained')
        except Exception:
            record('blocked', reason='rollback failed; manual recovery required')
        raise


def first_upgrade(source):
    """Optional first upgrade for 0.5.1, whose UI cannot choose a mirror."""
    version = u.latest_version()
    official = u.bounded_discovery(lambda: u._official_digest(version))
    expected_digest = official.split('@', 1)[1]
    print('First upgrade target:', version, expected_digest, 'source:', source)
    connection = UnixConnection('localhost', timeout=5)
    try:
        body = json.dumps({'source': source, 'expectedVersion': version, 'expectedDigest': expected_digest})
        connection.request('POST', '/update', body=body, headers={'Content-Type': 'application/json'})
        response = connection.getresponse()
        if response.status != 202 or json.loads(response.read()).get('accepted') is not True:
            raise SetupError('first update was not accepted')
    finally:
        connection.close()
    print('First update accepted; check the webpage after reconnection. Accepted is not completed.')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', required=True, help='exact browser origin, e.g. http://192.168.1.10:6099')
    parser.add_argument('--apply', action='store_true', help='perform the verified migration and one container recreation')
    parser.add_argument('--accept-official-releases', action='store_true', help='trust the fixed GitHub project and GHCR stable releases')
    parser.add_argument('--upgrade', action='store_true', help='after setup, request the first update using the chosen source')
    parser.add_argument('--source', choices=('ghcr', 'mirror'), default='ghcr')
    args = parser.parse_args(argv)
    try:
        if args.upgrade and not args.apply:
            raise SetupError('--upgrade requires --apply')
        plan = preflight(args.origin)
        print('Verified official installation:', plan['version'])
        print('Source and running image identity match. Three data mounts and credentials will be preserved.')
        print('Origin:', plan['origin'])
        if args.apply:
            if not args.accept_official_releases:
                raise SetupError('--apply requires --accept-official-releases')
            apply(plan)
            print('Web updating enabled. Data/config backup: /var/lib/napcat-updater-setup')
            if args.upgrade:
                first_upgrade(args.source)
        else:
            print('Read-only preview. To enable, repeat with --apply --accept-official-releases.')
        return 0
    except (SetupError, p.PrepareError, ValueError, OSError, KeyError) as error:
        # Errors from parsers/commands can contain credentials, so expose category
        # plus only our fixed diagnostic messages.
        print('Setup failed: ' + (str(error) if isinstance(error, SetupError) else type(error).__name__), file=sys.stderr)
        if JOURNAL.exists():
            print('Do not remove the setup journal or reset updater state; inspect /var/lib/napcat-updater-setup.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
