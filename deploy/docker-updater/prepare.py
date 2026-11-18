#!/usr/bin/env python3
"""Generate updater-managed Compose/policy/baseline from a resolved Compose config.

Input is the JSON produced by `docker compose config --format json`, which already
resolves env_file values and relative bind sources. The output is the strict JSON
Compose file used by the host updater, plus policy.json and committed.json.

Dry-run is the default and redacts secrets. `--apply` writes root-only files into
the updater directory; it never starts or stops containers by itself.
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

DIGEST = re.compile(r'^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$')
NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$')
MOUNTS = {'qq': '/app/.config/QQ', 'config': '/app/napcat/config', 'plugins': '/app/napcat/plugins'}
SOCKET_DIR = '/run/napcat-docker-updater'
SOCKET_TARGET = '/run/napcat-docker-updater'
FORBIDDEN_SERVICE_KEYS = {'build', 'networks', 'network_mode', 'deploy', 'profiles', 'extends', 'env_file', 'include'}
ALLOWED_BIND_OPTIONS = {'create_host_path'}


class PrepareError(Exception):
    pass


def parse_origin(value):
    from urllib.parse import urlsplit
    parts = urlsplit(value)
    if (parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password
            or parts.path not in ('', '/') or parts.query or parts.fragment):
        raise PrepareError('origin 必须是 http(s)://host[:port]，不含路径、查询或凭据')
    return f'{parts.scheme}://{parts.netloc}'


def port_string(port):
    if isinstance(port, str):
        if '$' in port or len(port) > 64 or not re.fullmatch(r'[0-9a-fA-F.:\[\]/a-z-]+', port):
            raise PrepareError('端口格式不受支持')
        return port
    if not isinstance(port, dict):
        raise PrepareError('端口格式不受支持')
    protocol = port.get('protocol', 'tcp')
    target = port.get('target')
    published = port.get('published')
    host_ip = port.get('host_ip') or ''
    if (not isinstance(target, int) or isinstance(target, bool) or not isinstance(published, str)
            or protocol not in ('tcp', 'udp') or not published.isdigit()):
        raise PrepareError('端口格式不受支持')
    if host_ip and not re.fullmatch(r'[0-9a-fA-F.:\[\]]+', host_ip):
        raise PrepareError('端口地址不受支持')
    return f'{host_ip}:{published}:{target}/{protocol}' if host_ip else f'{published}:{target}/{protocol}'


def volume_string(volume, data_root):
    if not isinstance(volume, dict) or volume.get('type') != 'bind':
        raise PrepareError('只支持 bind 挂载')
    source = volume.get('source')
    target = volume.get('target')
    if not isinstance(source, str) or not os.path.isabs(source) or not isinstance(target, str) or not os.path.isabs(target):
        raise PrepareError('挂载路径必须是绝对路径')
    options = volume.get('bind') or {}
    if not isinstance(options, dict) or set(options) - ALLOWED_BIND_OPTIONS:
        raise PrepareError('不支持额外的挂载选项')
    expected = {os.path.join(data_root, name): dest for name, dest in MOUNTS.items()}
    normalized = os.path.normpath(source)
    if expected.get(normalized) != target:
        raise PrepareError(f'不受支持的挂载: {source} -> {target}')
    return f'{normalized}:{target}'


def build(resolved, project, service_name, data_root, origin, target_image, current_image, generation):
    origin = parse_origin(origin)
    if not NAME.fullmatch(project) or not NAME.fullmatch(service_name):
        raise PrepareError('项目或服务名非法')
    data_root = os.path.normpath(data_root)
    if not os.path.isabs(data_root) or data_root == '/' or '..' in Path(data_root).parts:
        raise PrepareError('数据根目录非法')
    if not DIGEST.fullmatch(target_image) or not DIGEST.fullmatch(current_image):
        raise PrepareError('镜像必须是 repo@sha256:<64 位十六进制>')
    if target_image == current_image:
        raise PrepareError('目标镜像不能等于当前镜像')
    if not isinstance(generation, int) or isinstance(generation, bool) or generation < 2:
        raise PrepareError('generation 必须是不小于 2 的整数')
    services = resolved.get('services')
    if not isinstance(services, dict) or set(services) != {service_name}:
        raise PrepareError('必须恰好一个服务且名称与 --service 一致')
    service = services[service_name]
    if not isinstance(service, dict) or service.get('image') != current_image:
        raise PrepareError('当前 Compose 镜像与 --current-image 不一致')
    forbidden = FORBIDDEN_SERVICE_KEYS & set(service)
    if forbidden:
        raise PrepareError('不支持的字段: ' + ', '.join(sorted(forbidden)))
    environment = service.get('environment') or {}
    if not isinstance(environment, dict):
        raise PrepareError('environment 必须是映射')
    clean_env = {}
    for key, value in environment.items():
        if not isinstance(key, str) or not NAME.fullmatch(key):
            raise PrepareError('环境变量名非法')
        if not isinstance(value, str) or '$' in value:
            raise PrepareError(f'环境变量 {key} 的值不受支持（含变量插值或非字符串）')
        clean_env[key] = value
    if not clean_env.get('WEBUI_TOKEN'):
        raise PrepareError('缺少非空 WEBUI_TOKEN')
    if clean_env.get('NAPCAT_DOCKER_UPDATER') not in (None, '1'):
        raise PrepareError('已有的 NAPCAT_DOCKER_UPDATER 值冲突')
    if clean_env.get('NAPCAT_DOCKER_UPDATER_ORIGIN') not in (None, origin):
        raise PrepareError('已有的 NAPCAT_DOCKER_UPDATER_ORIGIN 值冲突')
    clean_env['NAPCAT_DOCKER_UPDATER'] = '1'
    clean_env['NAPCAT_DOCKER_UPDATER_ORIGIN'] = origin
    volumes = service.get('volumes')
    if not isinstance(volumes, list) or len(volumes) != len(MOUNTS):
        raise PrepareError('需要且仅需要三个数据挂载（qq/config/plugins）')
    volume_list = [volume_string(volume, data_root) for volume in volumes]
    if len(set(volume_list)) != len(volume_list):
        raise PrepareError('挂载重复')
    healthcheck = service.get('healthcheck')
    if not isinstance(healthcheck, dict) or not healthcheck:
        raise PrepareError('缺少 healthcheck')
    out = {
        'image': current_image,
        'restart': service.get('restart', 'unless-stopped'),
        'environment': clean_env,
        'ports': [port_string(port) for port in (service.get('ports') or [])],
        'volumes': volume_list + [f'{SOCKET_DIR}:{SOCKET_TARGET}:ro'],
        'healthcheck': healthcheck,
    }
    if not isinstance(out['restart'], str) or out['restart'] not in ('no', 'always', 'on-failure', 'unless-stopped'):
        raise PrepareError('restart 策略不受支持')
    for key in ('container_name', 'hostname'):
        if key in service:
            if not isinstance(service[key], str) or not NAME.fullmatch(service[key]):
                raise PrepareError(f'{key} 非法')
            out[key] = service[key]
    if 'stop_grace_period' in service:
        if not isinstance(service['stop_grace_period'], str) or '$' in service['stop_grace_period']:
            raise PrepareError('stop_grace_period 非法')
        out['stop_grace_period'] = service['stop_grace_period']
    compose = {'services': {service_name: out}}
    policy = {
        'project': project,
        'service': service_name,
        'compose_file': '/etc/napcat-docker-updater/compose.json',
        'image': target_image,
        'generation': generation,
    }
    baseline = {'generation': generation - 1, 'image': current_image}
    return compose, policy, baseline


def redact(compose):
    copy = json.loads(json.dumps(compose))
    for service in copy['services'].values():
        environment = service.get('environment', {})
        if 'WEBUI_TOKEN' in environment:
            environment['WEBUI_TOKEN'] = '<redacted>'
    return copy


def write_json(path, value):
    if path.is_symlink():
        raise PrepareError(f'拒绝写入符号链接: {path}')
    data = json.dumps(value, ensure_ascii=False, indent=2) + '\n'
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w') as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
    except Exception:
        path.unlink(missing_ok=True)
        raise


def apply_files(out_dir, compose, policy, baseline, force):
    out_dir = Path(out_dir)
    if out_dir.is_symlink():
        raise PrepareError('输出目录不能是符号链接')
    if not out_dir.is_absolute():
        raise PrepareError('输出目录必须是绝对路径')
    if os.geteuid() != 0:
        raise PrepareError('--apply 需要 root')
    out_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(out_dir, 0o700)
    targets = {'compose.json': compose, 'policy.json': policy, 'committed.json': baseline}
    if not force:
        existing = [name for name in targets if (out_dir / name).exists()]
        if existing:
            raise PrepareError('目标文件已存在，确认覆盖请加 --force: ' + ', '.join(existing))
    for name, value in targets.items():
        path = out_dir / name
        if path.exists():
            path.unlink()
        write_json(path, value)


def main(argv=None):
    parser = argparse.ArgumentParser(description='从 `docker compose config --format json` 生成更新器受管配置')
    parser.add_argument('--resolved', required=True, help='docker compose config --format json 的输出文件')
    parser.add_argument('--project', required=True)
    parser.add_argument('--service', required=True)
    parser.add_argument('--data-root', default='/opt/napcat-plus')
    parser.add_argument('--origin', required=True, help='浏览器访问 WebUI 的精确 origin')
    parser.add_argument('--target-image', required=True, help='已审核的新版本 repo@sha256:...')
    parser.add_argument('--current-image', required=True, help='当前运行版本 repo@sha256:...')
    parser.add_argument('--generation', type=int, required=True)
    parser.add_argument('--out-dir', default='/etc/napcat-docker-updater')
    parser.add_argument('--apply', action='store_true', help='写入文件；默认只打印脱敏预览')
    parser.add_argument('--force', action='store_true', help='覆盖已存在的输出文件')
    args = parser.parse_args(argv)
    try:
        origin = parse_origin(args.origin)
        resolved = json.loads(Path(args.resolved).read_text())
        compose, policy, baseline = build(resolved, args.project, args.service, args.data_root,
                                          origin, args.target_image, args.current_image, args.generation)
    except (PrepareError, OSError, json.JSONDecodeError) as error:
        print(f'错误: {error}', file=sys.stderr)
        return 1
    if args.apply:
        try:
            apply_files(args.out_dir, compose, policy, baseline, args.force)
        except (PrepareError, OSError) as error:
            print(f'错误: {error}', file=sys.stderr)
            return 1
        print(f'已写入 {args.out_dir}/compose.json、policy.json、committed.json（权限 0600）。')
        print('下一步需要管理员按 README 安装 systemd 单元、创建 napcat-updater 组，并重建一次容器以挂载 socket 目录。')
        return 0
    preview = {'compose': redact(compose), 'policy': policy, 'baseline': baseline}
    print(json.dumps(preview, ensure_ascii=False, indent=2))
    print('\n预览已脱敏；使用 --apply 写入 root-only 文件。', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
