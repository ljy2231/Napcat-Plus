#!/usr/bin/env python3
"""Prepare a standalone updater configuration; never inspect or change containers.

The caller MUST independently resolve --current-image to a local image ID and
compare it with the running container's Image ID before using --apply. A Compose
image tag is not proof of the running container's identity. Version/digest
correspondence and image provenance are also the caller's responsibility.
"""
import argparse
import json
import os
import re
import stat
import sys
from pathlib import Path

DIGEST = re.compile(r'^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$')
NAME = re.compile(r'^[a-z0-9][a-z0-9_-]{0,62}$')
HOSTNAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$')
ENV_NAME = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
VERSION = re.compile(r'^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')
MOUNTS = {'qq': '/app/.config/QQ', 'config': '/app/napcat/config', 'plugins': '/app/napcat/plugins'}
SOCKET_DIR = '/run/napcat-docker-updater'
SOCKET_TARGET = SOCKET_DIR
SERVICE_KEYS = {'image', 'restart', 'environment', 'ports', 'volumes', 'healthcheck',
                'container_name', 'hostname', 'stop_grace_period', 'networks', 'command', 'entrypoint'}


class PrepareError(Exception):
    pass


def parse_origin(value):
    from urllib.parse import urlsplit
    try:
        parts = urlsplit(value)
        if (parts.scheme not in ('http', 'https') or not parts.hostname or parts.username is not None
                or parts.password is not None or parts.path not in ('', '/') or parts.query or parts.fragment
                or parts.port == 0 or '$' in value):
            raise ValueError()
        return f'{parts.scheme}://{parts.netloc}'
    except ValueError:
        raise PrepareError('origin 必须是 http(s)://host[:port]，不含路径、查询或凭据') from None


def port_string(port):
    if not isinstance(port, dict) or set(port) - {'mode', 'host_ip', 'target', 'published', 'protocol'}:
        raise PrepareError('端口格式不受支持')
    protocol, target, published = port.get('protocol', 'tcp'), port.get('target'), port.get('published')
    host_ip = port.get('host_ip', '')
    if (port.get('mode', 'ingress') != 'ingress' or type(target) is not int or not 1 <= target <= 65535
            or not isinstance(published, str) or not published.isascii() or not published.isdigit()
            or not 1 <= int(published) <= 65535 or protocol not in ('tcp', 'udp')
            or not isinstance(host_ip, str)):
        raise PrepareError('端口格式不受支持')
    if host_ip:
        import ipaddress
        try:
            ip = ipaddress.ip_address(host_ip.strip('[]'))
        except ValueError:
            raise PrepareError('端口地址不受支持') from None
        host_ip = f'[{ip}]' if ip.version == 6 else str(ip)
    return f'{host_ip}:{published}:{target}/{protocol}' if host_ip else f'{published}:{target}/{protocol}'


def reject_symlink_components(path):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise PrepareError('路径必须是安全的绝对路径')
    current = Path('/')
    for part in path.parts[1:]:
        current /= part
        try:
            if stat.S_ISLNK(current.lstat().st_mode):
                raise PrepareError('拒绝符号链接路径')
        except FileNotFoundError:
            break


def volume_string(volume, data_root):
    if not isinstance(volume, dict) or set(volume) - {'type', 'source', 'target', 'bind'} or volume.get('type') != 'bind':
        raise PrepareError('只支持普通 bind 挂载')
    source, target = volume.get('source'), volume.get('target')
    if not isinstance(source, str) or not isinstance(target, str):
        raise PrepareError('挂载路径非法')
    options = volume.get('bind', {})
    if not isinstance(options, dict) or set(options) - {'create_host_path'} or ('create_host_path' in options and type(options['create_host_path']) is not bool):
        raise PrepareError('不支持额外的挂载选项')
    expected = {os.path.join(data_root, name): dest for name, dest in MOUNTS.items()}
    if source != os.path.normpath(source) or expected.get(source) != target or ':' in source or '$' in source:
        raise PrepareError('不受支持的挂载')
    reject_symlink_components(source)
    return f'{source}:{target}'


def validate_healthcheck(value):
    if not isinstance(value, dict) or set(value) - {'test', 'interval', 'timeout', 'start_period', 'start_interval', 'retries'}:
        raise PrepareError('healthcheck 不受支持')
    test = value.get('test')
    if (not isinstance(test, list) or len(test) < 2 or test[0] not in ('CMD', 'CMD-SHELL')
            or not all(isinstance(x, str) and x and '$' not in x for x in test)):
        raise PrepareError('healthcheck test 不受支持')
    for key in ('interval', 'timeout', 'start_period', 'start_interval'):
        if key in value and (not isinstance(value[key], str) or not re.fullmatch(r'(?:[0-9]+(?:\.[0-9]+)?(?:ns|us|µs|ms|s|m|h))+', value[key])):
            raise PrepareError('healthcheck 时间格式不受支持')
    if 'retries' in value and (type(value['retries']) is not int or value['retries'] < 0):
        raise PrepareError('healthcheck retries 不受支持')


def build(resolved, project, service_name, data_root, origin, target_image, current_image, generation, current_version):
    origin = parse_origin(origin)
    if not NAME.fullmatch(project) or not NAME.fullmatch(service_name):
        raise PrepareError('项目或服务名非法')
    if data_root != '/opt/napcat-plus':
        raise PrepareError('当前更新器仅支持数据目录 /opt/napcat-plus')
    if not DIGEST.fullmatch(target_image) or not DIGEST.fullmatch(current_image):
        raise PrepareError('镜像必须是 repo@sha256:<64 位十六进制>')
    if not isinstance(current_version, str) or not VERSION.fullmatch(current_version):
        raise PrepareError('current-version 必须是正式版本 major.minor.patch')
    if type(generation) is not int or generation < 1:
        raise PrepareError('generation 必须是正整数')
    if target_image != current_image:
        raise PrepareError('初始化的目标镜像必须与当前镜像相同')
    if not isinstance(resolved, dict) or set(resolved) - {'name', 'networks', 'services'}:
        raise PrepareError('顶层配置不受支持')
    if 'name' in resolved and resolved['name'] != project:
        raise PrepareError('Compose 项目名称不匹配')
    networks = resolved.get('networks', {})
    if not isinstance(networks, dict) or set(networks) - {'default'}:
        raise PrepareError('仅支持默认网络')
    if 'default' in networks:
        default = networks['default']
        if default is not None and (not isinstance(default, dict) or set(default) - {'name', 'ipam'}
                                    or default.get('name', project + '_default') != project + '_default'
                                    or default.get('ipam', {}) != {}):
            raise PrepareError('默认网络配置不受支持')
    services = resolved.get('services')
    if not isinstance(services, dict) or set(services) != {service_name}:
        raise PrepareError('必须恰好一个服务且名称与 --service 一致')
    service = services[service_name]
    if not isinstance(service, dict) or set(service) - SERVICE_KEYS:
        raise PrepareError('服务含不支持的字段')
    if service.get('command') is not None or service.get('entrypoint') is not None:
        raise PrepareError('不支持自定义 command 或 entrypoint')
    image = service.get('image')
    # Tag references are accepted only as configuration; they do not establish identity.
    if (not isinstance(image, str) or not re.fullmatch(r'[a-z0-9][a-z0-9._:/-]*(?:@[a-z0-9]+:[a-f0-9]+)?', image)
            or ('@' in image and image != current_image)):
        raise PrepareError('当前 Compose 镜像格式不受支持或与 --current-image 不一致')
    if 'networks' in service and service['networks'] not in ({'default': None}, {'default': {}}, ['default']):
        raise PrepareError('服务仅支持默认网络')
    environment = service.get('environment', {})
    if not isinstance(environment, dict):
        raise PrepareError('environment 必须是映射')
    clean_env = {}
    for key, value in environment.items():
        if not isinstance(key, str) or not ENV_NAME.fullmatch(key):
            raise PrepareError('环境变量名非法')
        if not isinstance(value, str) or '$' in value:
            raise PrepareError('环境变量值不受支持（含变量插值或非字符串）')
        clean_env[key] = value
    if not clean_env.get('WEBUI_TOKEN'):
        raise PrepareError('缺少非空 WEBUI_TOKEN')
    if clean_env.get('NAPCAT_DOCKER_UPDATER') not in (None, '1') or clean_env.get('NAPCAT_DOCKER_UPDATER_ORIGIN') not in (None, origin):
        raise PrepareError('已有更新器环境变量冲突')
    clean_env['NAPCAT_DOCKER_UPDATER'] = '1'
    clean_env['NAPCAT_DOCKER_UPDATER_ORIGIN'] = origin
    volumes = service.get('volumes')
    if not isinstance(volumes, list) or len(volumes) != len(MOUNTS):
        raise PrepareError('需要且仅需要三个数据挂载（qq/config/plugins）')
    volume_list = [volume_string(volume, data_root) for volume in volumes]
    if len(set(volume_list)) != len(MOUNTS):
        raise PrepareError('挂载重复')
    healthcheck = service.get('healthcheck')
    validate_healthcheck(healthcheck)
    ports = service.get('ports', [])
    if not isinstance(ports, list):
        raise PrepareError('端口格式不受支持')
    out = {'image': current_image, 'restart': service.get('restart', 'unless-stopped'),
           'environment': clean_env, 'ports': [port_string(port) for port in ports],
           'volumes': volume_list + [f'{SOCKET_DIR}:{SOCKET_TARGET}:ro'], 'healthcheck': healthcheck}
    if out['restart'] not in ('no', 'always', 'on-failure', 'unless-stopped'):
        raise PrepareError('restart 策略不受支持')
    for key in ('container_name', 'hostname'):
        if key in service:
            if not isinstance(service[key], str) or not HOSTNAME.fullmatch(service[key]):
                raise PrepareError(f'{key} 非法')
            out[key] = service[key]
    if 'stop_grace_period' in service:
        value = service['stop_grace_period']
        if not isinstance(value, str) or not re.fullmatch(r'(?:[0-9]+(?:\.[0-9]+)?(?:ns|us|µs|ms|s|m|h))+', value):
            raise PrepareError('stop_grace_period 非法')
        out['stop_grace_period'] = value
    compose = {'services': {service_name: out}}
    policy = {'project': project, 'service': service_name,
              'compose_file': '/etc/napcat-docker-updater/compose.json', 'image': target_image, 'generation': generation}
    baseline = {'generation': generation, 'image': current_image, 'version': current_version,
                'policy_image': target_image}
    return compose, policy, baseline


def redact(compose):
    copy = json.loads(json.dumps(compose))
    for service in copy['services'].values():
        service['environment'] = {key: '<redacted>' for key in service['environment']}
        service['healthcheck']['test'] = ['<redacted>']
    return copy


def open_directory(path):
    """Walk from / using dirfds and O_NOFOLLOW; create missing private directories."""
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts or path == Path('/'):
        raise PrepareError('输出目录必须是非根的绝对路径')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            try:
                os.mkdir(part, 0o700, dir_fd=fd)
            except FileExistsError:
                pass
            new = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = new
        st = os.fstat(fd)
        if st.st_uid != 0 or stat.S_IMODE(st.st_mode) & 0o077:
            raise PrepareError('输出目录必须属于 root 且仅 root 可访问')
        return fd
    except BaseException:
        os.close(fd)
        raise


def apply_files(out_dir, state_dir, compose, policy, baseline):
    if os.geteuid() != 0:
        raise PrepareError('--apply 需要 root')
    out_path, state_path = Path(out_dir), Path(state_dir)
    if out_path == state_path or out_path in state_path.parents or state_path in out_path.parents:
        raise PrepareError('配置目录与状态目录必须独立')
    out_fd = open_directory(out_path)
    try:
        state_fd = open_directory(state_path)
        try:
            # Never inspect or delete existing state, even if committed.json is absent.
            if os.listdir(state_fd):
                raise PrepareError('状态目录非空，拒绝初始化')
            if any(name in os.listdir(out_fd) for name in ('compose.json', 'policy.json')):
                raise PrepareError('目标文件已存在，拒绝覆盖')
            for directory, name, value in ((out_fd, 'compose.json', compose), (out_fd, 'policy.json', policy),
                                           (state_fd, 'committed.json', baseline)):
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
                with os.fdopen(fd, 'w', encoding='utf-8') as output:
                    json.dump(value, output, ensure_ascii=False, indent=2)
                    output.write('\n')
                    output.flush()
                    os.fsync(output.fileno())
                os.fsync(directory)
        finally:
            os.close(state_fd)
    finally:
        os.close(out_fd)


def read_resolved(path):
    path = Path(os.path.abspath(path))
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in path.parts[1:-1]:
            new = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = new
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(fd, 'r', encoding='utf-8') as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                raise PrepareError('输入必须是普通文件')
            def unique_pairs(pairs):
                result = {}
                for key, value in pairs:
                    if key in result:
                        raise PrepareError('JSON 含重复字段')
                    result[key] = value
                return result
            return json.load(source, object_pairs_hook=unique_pairs)
    finally:
        os.close(directory)


def main(argv=None):
    parser = argparse.ArgumentParser(description='从 docker compose config --format json 生成更新器受管配置（不验证运行容器身份）')
    parser.add_argument('--resolved', required=True)
    parser.add_argument('--project', required=True)
    parser.add_argument('--service', required=True)
    parser.add_argument('--data-root', default='/opt/napcat-plus')
    parser.add_argument('--origin', required=True)
    parser.add_argument('--target-image', required=True)
    parser.add_argument('--current-image', required=True, help='调用方已核对运行容器 image ID 的当前 digest')
    parser.add_argument('--current-version', required=True, help='调用方已验证对应当前 digest 的正式版本')
    parser.add_argument('--generation', type=int, required=True)
    parser.add_argument('--out-dir', default='/etc/napcat-docker-updater')
    parser.add_argument('--state-dir', default='/var/lib/napcat-docker-updater')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    try:
        resolved = read_resolved(args.resolved)
        compose, policy, baseline = build(resolved, args.project, args.service, args.data_root,
                                          args.origin, args.target_image, args.current_image,
                                          args.generation, args.current_version)
        if args.apply:
            apply_files(args.out_dir, args.state_dir, compose, policy, baseline)
            print('已写入配置与独立状态目录（文件权限 0600）。')
        else:
            print(json.dumps({'compose': redact(compose), 'policy': policy, 'baseline': baseline}, ensure_ascii=False, indent=2))
    except (PrepareError, OSError, json.JSONDecodeError, UnicodeError) as error:
        print(f'错误: {error}', file=sys.stderr)
        return 1
    print('警告：本工具未验证运行容器身份；调用方必须先将运行容器的 image ID 与当前 digest 解析出的 image ID 严格比较，另行验证版本对应关系。', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
