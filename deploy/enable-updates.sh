#!/usr/bin/env bash
# One-time host setup for existing official Linux installations (0.5.1 or newer).
# Preview: sudo bash enable-updates.sh --origin http://192.168.1.10:6099
# Apply: add --apply --accept-official-releases after reviewing the preview.
set -euo pipefail
VERSION=0.5.3
ROOT_URL="https://raw.githubusercontent.com/ljy2231/Napcat-Plus/v${VERSION}/deploy/docker-updater"
usage() { printf '%s\n' 'Usage: enable-updates.sh --origin http(s)://host:port [--apply --accept-official-releases] [--upgrade --source ghcr|mirror]'; }
ORIGIN=''
APPLY=0
TRUST=0
UPGRADE=0
SOURCE=ghcr
while (($#)); do
  case "$1" in
    --origin) (($# >= 2)) || { usage; exit 1; }; ORIGIN="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --upgrade) UPGRADE=1; shift ;;
    --source) (($# >= 2)) || { usage; exit 1; }; SOURCE="$2"; shift 2 ;;
    --accept-official-releases) TRUST=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 1 ;;
  esac
done
[[ -n "$ORIGIN" ]] || { usage; exit 1; }
[[ "$SOURCE" == ghcr || "$SOURCE" == mirror ]] || { usage; exit 1; }
((UPGRADE == 0 || APPLY == 1)) || { usage; exit 1; }
((EUID == 0)) || { printf '%s\n' '请在本地 Docker 宿主机使用 sudo/root 运行。' >&2; exit 1; }
((APPLY == 0 || TRUST == 1)) || { printf '%s\n' '--apply 还需要 --accept-official-releases。' >&2; exit 1; }
command -v python3 >/dev/null
command -v curl >/dev/null
umask 077
BUNDLE="$(mktemp -d /root/napcat-updater-0.5.3.XXXXXXXX)"
trap 'case "$BUNDLE" in /root/napcat-updater-0.5.3.*) rm -rf -- "$BUNDLE" ;; esac' EXIT
[[ "$BUNDLE" == /root/napcat-updater-0.5.3.* && -d "$BUNDLE" && ! -L "$BUNDLE" ]] || exit 1
# Fixed file names and version. Never download or execute a URL supplied by WebUI.
for name in bootstrap.py prepare.py updater.py napcat-docker-updater.service napcat-docker-updater.socket; do
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --connect-timeout 15 --max-time 120 --retry 2 \
    "${ROOT_URL}/${name}" --output "${BUNDLE}/${name}"
done
ARGS=(--origin "$ORIGIN" --source "$SOURCE")
if ((UPGRADE)); then ARGS+=(--upgrade); fi
if ((APPLY)); then ARGS+=(--apply --accept-official-releases); fi
printf '使用固定版本 %s 的宿主组件。下载目录：%s\n' "$VERSION" "$BUNDLE"
python3 "$BUNDLE/bootstrap.py" "${ARGS[@]}"
