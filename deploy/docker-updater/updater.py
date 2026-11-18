#!/usr/bin/env python3
"""Host-only fixed-policy updater. This program must never run in the app container."""
import fcntl
import grp
import http.server
import json
import os
import re
import socket
import socketserver
import subprocess
import stat
import sys
import tempfile
import threading
import time
from pathlib import Path

POLICY = Path('/etc/napcat-docker-updater/policy.json')
COMPOSE_FILE = Path('/etc/napcat-docker-updater/compose.json')
STATE = Path('/var/lib/napcat-docker-updater')
SOCKET_DIR = Path('/run/napcat-docker-updater')
SOCKET = str(SOCKET_DIR / 'updater.sock')
SOCKET_TARGET = '/run/napcat-docker-updater'
# Only these three dedicated bind mounts are permitted. The app container must
# never be able to mount arbitrary host paths or the Docker daemon socket.
DATA_ROOT = Path('/opt/napcat-plus')
MOUNTS = {'qq': '/app/.config/QQ', 'config': '/app/napcat/config', 'plugins': '/app/napcat/plugins'}
DOCKER = '/usr/bin/docker'
IMAGE = re.compile(r'^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$')
NAME = re.compile(r'^[a-z0-9][a-z0-9_-]{0,62}$')
ID = re.compile(r'^sha256:[a-f0-9]{64}$')


def atomic_json(path, value):
    fd, tmp = tempfile.mkstemp(prefix='.state-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def read_json(path):
    with path.open() as inp:
        return json.load(inp)


def sync_state_dir():
    directory = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def clear_pending(pending_file):
    # Both commit and rollback persist the deletion. If fsync fails after
    # unlink, restore the recovery marker where possible and fail closed.
    record = read_json(pending_file)
    pending_file.unlink()
    try:
        sync_state_dir()
    except OSError:
        try:
            atomic_json(pending_file, record)
        except OSError:
            pass  # blocked status is the second persistent quarantine signal
        raise


def journal_error(stage, error):
    # Fixed stage labels and exception categories only; never print exception
    # text, Docker output, paths, image names, tokens, or request data.
    allowed_stages = {'preflight', 'apply', 'rollback', 'commit', 'worker'}
    if stage not in allowed_stages:
        stage = 'worker'
    kind = ('timeout' if isinstance(error, subprocess.TimeoutExpired) else
            'command_failed' if isinstance(error, subprocess.CalledProcessError) else
            'io_error' if isinstance(error, OSError) else
            'validation_error' if isinstance(error, (ValueError, KeyError, TypeError)) else 'unexpected')
    print(f'napcat-docker-updater: stage={stage} error={kind}', file=sys.stderr, flush=True)


def public_status(value, now=None):
    now = time.time() if now is None else now
    if isinstance(value, dict) and value.get('phase') == 'rate_limited':
        retry_at = value.get('retryAt')
        if isinstance(retry_at, (int, float)) and not isinstance(retry_at, bool) and now >= retry_at:
            return {'phase': 'idle', 'message': 'rate limit expired; retry available'}
    return value


def trusted_path(path):
    # All ancestors must be root-owned, not writable by group/other, and not symlinks.
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('unsafe path')
    for part in (path, *path.parents):
        st = part.lstat()
        if stat.S_ISLNK(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            raise ValueError('untrusted path ownership or permissions')


def load_policy():
    trusted_path(POLICY)
    p = read_json(POLICY)
    if set(p) != {'project', 'service', 'compose_file', 'image', 'generation'}:
        raise ValueError('invalid policy keys')
    if not isinstance(p['generation'], int) or isinstance(p['generation'], bool) or p['generation'] < 1:
        raise ValueError('invalid generation')
    if not all(isinstance(p[k], str) and NAME.fullmatch(p[k]) for k in ('project', 'service')):
        raise ValueError('invalid project or service')
    if not isinstance(p['image'], str) or not IMAGE.fullmatch(p['image']) or p['image'].startswith('-'):
        raise ValueError('image must be a repository pinned by sha256 digest')
    if p['compose_file'] != str(COMPOSE_FILE) or not os.path.isfile(COMPOSE_FILE):
        raise ValueError('compose_file must be the fixed updater-managed file')
    trusted_path(COMPOSE_FILE)
    # Strict standalone JSON is also valid Compose. Disallow interpolation and
    # all external includes/builds/env_files; do not trust Compose to parse YAML.
    raw = Path(p['compose_file']).read_text()
    if '$' in raw:
        raise ValueError('compose interpolation is forbidden')
    config = json.loads(raw)
    if set(config) != {'services'} or set(config['services']) != {p['service']}:
        raise ValueError('exactly one standalone service required')
    service = config['services'][p['service']]
    allowed = {'image', 'restart', 'environment', 'ports', 'volumes', 'healthcheck',
               'stop_grace_period', 'container_name', 'hostname'}
    if not isinstance(service, dict) or set(service) - allowed or not isinstance(service.get('image'), str) or not IMAGE.fullmatch(service['image']) or not service.get('healthcheck'):
        raise ValueError('unsupported compose settings or missing healthcheck')
    # Preserve the container identity of an existing deployment instead of silently
    # renaming it (hostname changes can alter the QQ device fingerprint).
    for key in ('container_name', 'hostname'):
        value = service.get(key)
        if value is not None and (not isinstance(value, str) or not NAME.fullmatch(value)):
            raise ValueError('invalid container name or hostname')
    # Three fixed data directories and one fixed read-only socket-directory bind.
    # A read-only bind does NOT prevent connecting to the Unix socket; the app
    # has authority to request updates, but cannot replace the socket directory.
    trusted_path(DATA_ROOT)
    trusted_path(SOCKET_DIR)
    socket_info = Path(SOCKET).lstat()
    try:
        socket_gid = grp.getgrnam('napcat-updater').gr_gid
    except KeyError as exc:
        raise ValueError('updater socket group missing') from exc
    if (not stat.S_ISSOCK(socket_info.st_mode) or socket_info.st_uid != 0 or
            socket_info.st_gid != socket_gid or stat.S_IMODE(socket_info.st_mode) != 0o660):
        raise ValueError('unsafe updater socket ownership or permissions')
    volumes = service.get('volumes')
    if not isinstance(volumes, list) or len(volumes) != len(MOUNTS) + 1:
        raise ValueError('exactly the dedicated data and socket mounts are required')
    expected = {f'{DATA_ROOT / name}:{target}' for name, target in MOUNTS.items()}
    expected.add(f'{SOCKET_DIR}:{SOCKET_TARGET}:ro')
    if not all(isinstance(v, str) for v in volumes) or set(volumes) != expected:
        raise ValueError('invalid data mount mapping')
    for name in MOUNTS:
        source = DATA_ROOT / name
        st = source.lstat()
        if not stat.S_ISDIR(st.st_mode) or source.is_symlink() or source.resolve(strict=True) != source:
            raise ValueError('invalid data mount source')
        protected = (POLICY, Path(p['compose_file']), Path('/usr/local/libexec/napcat-docker-updater'), STATE, Path(SOCKET))
        if any(source == item or source in item.parents or item in source.parents for item in protected):
            raise ValueError('data mount overlaps updater trust boundary')
    return p


def commit_compose_image(p, expected, replacement):
    """Persist only the image field, refusing administrator changes during update."""
    if p['compose_file'] != str(COMPOSE_FILE):
        raise ValueError('compose path is not fixed')
    compose_path = COMPOSE_FILE
    trusted_path(compose_path)
    config = read_json(compose_path)
    service = config['services'][p['service']]
    if service.get('image') != expected:
        raise ValueError('compose file changed during update')
    service['image'] = replacement
    atomic_json(compose_path, config)


def run(args, timeout=300):
    # No shell, no inherited Docker/Compose env, no output from commands exposed to clients.
    result = subprocess.run([DOCKER, *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout, check=True,
                            env={'PATH': '/usr/bin:/bin', 'HOME': '/root', 'DOCKER_CONFIG': '/root/.docker'},
                            text=True)
    return result.stdout.strip()


def compose(p, override, args, timeout=300):
    return run(['compose', '--project-name', p['project'], '--project-directory',
                str(Path(p['compose_file']).parent), '-f', p['compose_file'], '-f', str(override), *args], timeout)


def wait_healthy(container, image):
    deadline = time.monotonic() + 90
    while True:
        info = json.loads(run(['inspect', '--format', '{{json .}}', container], 10))
        state = info['State']
        health = state.get('Health', {}).get('Status')
        if info['Image'] != image or not state['Running'] or health not in ('healthy', 'starting'):
            raise ValueError('container not running or healthy')
        if health == 'healthy':
            return
        if time.monotonic() >= deadline:
            raise ValueError('health check did not become healthy')
        time.sleep(2)


def perform():
    # flock covers process crashes/restarts and other updater instances.
    with (STATE / 'lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        status_file = STATE / 'status.json'
        committed_file = STATE / 'committed.json'
        pending_file = STATE / 'pending.json'
        def status(phase, message, **extra):
            atomic_json(status_file, {'phase': phase, 'message': message, **extra})
        try:
            if pending_file.exists():
                raise ValueError('unresolved previous update; administrator recovery required')
            # A blocked state is an independent recovery signal if a filesystem
            # error also prevented restoring a pending marker. The administrator
            # must resolve it explicitly; rate limits are temporary and separate.
            if status_file.exists() and read_json(status_file).get('phase') == 'blocked':
                return
            # A failed request cannot be spammed to repeatedly pull or restart containers.
            last = STATE / 'last-attempt.json'
            now = time.time()
            if last.exists() and now - read_json(last)['time'] < 60:
                status('rate_limited', 'rate limited; retry later', retryAt=read_json(last)['time'] + 60)
                return
            atomic_json(last, {'time': now})
            p = load_policy()
            # An administrator must establish the initial known-good baseline offline.
            # Missing/corrupt state cannot silently reset the anti-downgrade floor.
            previous = read_json(committed_file)
            if (not isinstance(previous, dict) or set(previous) != {'generation', 'image'} or
                    not isinstance(previous['generation'], int) or isinstance(previous['generation'], bool) or
                    previous['generation'] < 0 or not isinstance(previous['image'], str) or
                    not IMAGE.fullmatch(previous['image'])):
                raise ValueError('invalid committed baseline')
            if previous and (p['generation'] < previous['generation'] or
                             (p['generation'] == previous['generation'] and p['image'] != previous['image'])):
                raise ValueError('policy generation downgrade or digest reuse')
            # The base Compose file is the persistent committed image, never the
            # pending target. Ordinary compose up must restore the known-good image
            # while an update is attempted or after a failure.
            config = json.loads(run(['compose', '--project-name', p['project'], '--project-directory',
                                     str(Path(p['compose_file']).parent), '-f', p['compose_file'],
                                     'config', '--format', 'json'], 30))
            if config['services'][p['service']].get('image') != previous['image']:
                raise ValueError('compose image must equal committed baseline')
            status('pulling', 'checking approved digest', generation=p['generation'])
            # Discover the current exact container image before any mutation.
            # No override is needed for ps: it only changes the service image.
            with tempfile.TemporaryDirectory(prefix='override-', dir=STATE) as tmp:
                override = Path(tmp) / 'image.json'
                override.write_text(json.dumps({'services': {p['service']: {'image': p['image']}}}))
                container = compose(p, override, ['ps', '-q', '--all', p['service']])
                if not re.fullmatch(r'[a-f0-9]{12,64}', container):
                    raise ValueError('exactly one existing service container required')
                old_id = run(['inspect', '--format', '{{.Image}}', container])
                if not ID.fullmatch(old_id):
                    raise ValueError('cannot identify current image')
                # Never adopt an unapproved runtime drift as a rollback baseline.
                approved_id = run(['image', 'inspect', '--format', '{{.Id}}', previous['image']])
                if not ID.fullmatch(approved_id) or old_id != approved_id:
                    raise ValueError('current image differs from committed generation')
                if p['generation'] == previous['generation']:
                    status('idle', 'approved generation already applied', generation=p['generation'])
                    return
                run(['pull', p['image']], 600)
                new_id = run(['image', 'inspect', '--format', '{{.Id}}', p['image']])
                if not ID.fullmatch(new_id):
                    raise ValueError('cannot identify pulled image')
                # Keep the old ID reachable even if the old container is replaced/pruned.
                backup = f"napcat-updater-backup-{p['project']}-{p['service']}:previous"
                run(['tag', old_id, backup])
                atomic_json(pending_file, {'old_image_id': old_id, 'backup_tag': backup,
                                           'target_image': p['image'], 'generation': p['generation']})
                status('applying', 'starting approved image', generation=p['generation'])
                try:
                    compose(p, override, ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', p['service']], 300)
                    current = compose(p, override, ['ps', '-q', '--all', p['service']])
                    if not re.fullmatch(r'[a-f0-9]{12,64}', current):
                        raise ValueError('updated container missing or ambiguous')
                    wait_healthy(current, new_id)
                except subprocess.TimeoutExpired as error:
                    # Killing the CLI does not prove the daemon stopped its operation.
                    journal_error('apply', error)
                    status('blocked', 'Docker command timed out; administrator recovery required', generation=p['generation'])
                    return
                except Exception as error:
                    journal_error('apply', error)
                    status('rolling_back', 'update failed; restoring previous image', generation=p['generation'])
                    try:
                        override.write_text(json.dumps({'services': {p['service']: {'image': previous['image']}}}))
                        compose(p, override, ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', p['service']], 300)
                        restored = compose(p, override, ['ps', '-q', '--all', p['service']])
                        if not re.fullmatch(r'[a-f0-9]{12,64}', restored):
                            raise ValueError('restored container missing')
                        wait_healthy(restored, old_id)
                        clear_pending(pending_file)
                        status('failed', 'previous image restored; persistent data not rolled back', generation=p['generation'])
                    except Exception as error:
                        journal_error('rollback', error)
                        status('blocked', 'rollback failed; administrator recovery required', generation=p['generation'])
                    return

                # Commit is two durable file replacements with a pending journal.
                # Once starting this phase, never rollback automatically: a write can
                # succeed yet raise during directory fsync. Recovery stays manual.
                try:
                    commit_compose_image(p, previous['image'], p['image'])
                    atomic_json(committed_file, {'generation': p['generation'], 'image': p['image']})
                    clear_pending(pending_file)
                except Exception as error:
                    journal_error('commit', error)
                    status('blocked', 'commit or cleanup uncertain; administrator recovery required', generation=p['generation'])
                    return
                status('succeeded', 'image applied; data was not backed up', generation=p['generation'])
        except Exception as error:
            journal_error('preflight', error)
            status('blocked', 'preflight failed or recovery required; inspect host policy and logs')


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = False
    # Bound resources before creating worker threads; excess connections close
    # immediately. A deadline is absolute, not reset by slow trickle bytes.
    max_clients = 8
    request_deadline = 5.0

    def __init__(self, *args, **kwargs):
        self._client_slots = threading.BoundedSemaphore(self.max_clients)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        if not self._client_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._client_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._client_slots.release()

    def finish_request(self, request, client_address):
        request.settimeout(self.request_deadline)
        # SO_RCVTIMEO alone is an inactivity timeout; abort the entire request
        # at a fixed deadline even if an attacker trickles individual bytes.
        def expire():
            try:
                request.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        timer = threading.Timer(self.request_deadline, expire)
        timer.daemon = True
        timer.start()
        try:
            super().finish_request(request, client_address)
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            pass
        finally:
            timer.cancel()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'
    def log_message(self, *_):
        pass
    def parse_request(self):
        # stdlib email parser accepts EOF as an end to the header block. A
        # timed-out/truncated POST must never be treated as a complete request.
        original = self.rfile
        class HeaderReader:
            complete = False
            def readline(self, *args):
                line = original.readline(*args)
                if line in (b'\r\n', b'\n'):
                    self.complete = True
                return line
            def __getattr__(self, name):
                return getattr(original, name)
        reader = HeaderReader()
        self.rfile = reader
        try:
            parsed = super().parse_request()
        finally:
            self.rfile = original
        if not reader.complete:
            self.close_connection = True
            return False
        return parsed
    def answer(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        if self.path != '/status':
            return self.answer(404, {'error': 'not found'})
        try:
            s = read_json(STATE / 'status.json')
        except FileNotFoundError:
            s = {'phase': 'idle', 'message': 'no update requested'}
        self.answer(200, public_status(s))
    def do_POST(self):
        # HTTP/1.1 requires Host; an EOF or deadline in an incomplete header
        # block must not reach the state-changing endpoint.
        if self.request_version != 'HTTP/1.1' or not self.headers.get('Host'):
            return self.answer(400, {'error': 'invalid request'})
        if self.path != '/update' or self.headers.get('Content-Length') != '0' or self.headers.get('Transfer-Encoding'):
            return self.answer(400, {'error': 'invalid request'})
        with busy_lock:
            global busy
            if busy:
                return self.answer(409, {'error': 'busy'})
            busy = True
        def worker():
            global busy
            try:
                perform()
            finally:
                with busy_lock:
                    busy = False
        threading.Thread(target=worker, daemon=True).start()
        self.answer(202, {'accepted': True})


busy_lock = threading.Lock()
busy = False


def main():
    os.umask(0o077)
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Recovery is manual after interruption; never claim an orphaned job is active.
    status_path = STATE / 'status.json'
    if (STATE / 'pending.json').exists() or (status_path.exists() and read_json(status_path).get('phase') in ('pulling', 'applying', 'rolling_back')):
        atomic_json(status_path, {'phase': 'blocked', 'message': 'interrupted; administrator recovery required'})
    # systemd socket activation passes exactly one pre-bound socket; no path unlink race.
    if os.environ.get('LISTEN_PID') != str(os.getpid()) or os.environ.get('LISTEN_FDS') != '1':
        sys.exit('systemd socket activation required')
    server = Server(SOCKET, Handler, bind_and_activate=False)
    server.socket.close()
    server.socket = socket.socket(fileno=3)
    server.server_address = SOCKET
    server.serve_forever()


if __name__ == '__main__':
    main()
