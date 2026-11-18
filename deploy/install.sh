#!/usr/bin/env bash
# Napcat-Plus one-command installer.
#
#   curl -fsSL https://raw.githubusercontent.com/ljy2231/Napcat-Plus/main/deploy/install.sh | bash
#
# Environment overrides:
#   NAPCAT_PLUS_IMAGE  image reference (default ghcr.io/ljy2231/napcat-plus:v0.5.2)
#   NAPCAT_PLUS_MIRROR registry/mirror prefix, e.g. hub.002230.xyz:44300 (China加速)
#   NAPCAT_PLUS_DIR    install directory (default /opt/napcat-plus)
#   NAPCAT_PLUS_PORT   host port for the WebUI (default 6099)
#   NAPCAT_PLUS_BIND   host bind address (default 0.0.0.0; use 127.0.0.1 behind a proxy)
#   NAPCAT_PLUS_TOKEN  existing WebUI token to reuse instead of generating one
set -euo pipefail

IMAGE="${NAPCAT_PLUS_IMAGE:-ghcr.io/ljy2231/napcat-plus:v0.5.2}"
# A mirror is a registry host that proxies the original registry path, so the
# image reference is simply prefixed. Works with e.g. hub.002230.xyz:44300.
if [[ -n "${NAPCAT_PLUS_MIRROR:-}" ]]; then
  IMAGE="${NAPCAT_PLUS_MIRROR%/}/${IMAGE}"
fi
DIR="${NAPCAT_PLUS_DIR:-/opt/napcat-plus}"
PORT="${NAPCAT_PLUS_PORT:-6099}"
BIND="${NAPCAT_PLUS_BIND:-0.0.0.0}"

say() { printf '%s\n' "$*"; }
fail() { printf '错误: %s\n' "$*" >&2; exit 1; }

# Only accept literal values that Compose will not interpolate or reinterpret.
valid_token() { local LC_ALL=C; [[ "$1" =~ ^[a-zA-Z0-9_./:@+=-]+$ ]]; }
valid_tz() { local LC_ALL=C; [[ "$1" =~ ^[a-zA-Z0-9_./:+-]+$ ]]; }

read_existing_env() {
  local LC_ALL=C line value key seen_token=0 seen_tz=0
  local assignment_re='^[[:space:]]*(export[[:space:]]+)?(WEBUI_TOKEN|TZ)[[:space:]]*=(.*)$'
  local bare_re='^([a-zA-Z0-9_./:@+=-]+)([[:space:]]+(#.*)?)?$'
  local single_re="^'([a-zA-Z0-9_./:@+=-]+)'[[:space:]]*(#.*)?$"
  local double_re='^"([a-zA-Z0-9_./:@+=-]+)"[[:space:]]*(#.*)?$'
  WEBUI_TOKEN=''
  ENV_TZ=''
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ $assignment_re ]] || continue
    key="${BASH_REMATCH[2]}"
    value="${BASH_REMATCH[3]}"
    value="${value#"${value%%[![:space:]]*}"}"
    if [[ "$value" =~ $bare_re || "$value" =~ $single_re || "$value" =~ $double_re ]]; then
      value="${BASH_REMATCH[1]}"
    else
      fail "$ENV_FILE 中 $key 不是支持的安全字面值；请检查配置。"
    fi
    case "$key" in
      WEBUI_TOKEN)
        (( seen_token == 0 )) || fail "$ENV_FILE 中 WEBUI_TOKEN 重复。"
        valid_token "$value" || fail "$ENV_FILE 中 WEBUI_TOKEN 无效。"
        WEBUI_TOKEN="$value"; seen_token=1 ;;
      TZ)
        (( seen_tz == 0 )) || fail "$ENV_FILE 中 TZ 重复。"
        valid_tz "$value" || fail "$ENV_FILE 中 TZ 无效。"
        ENV_TZ="$value"; seen_tz=1 ;;
    esac
  done < "$ENV_FILE"
  (( seen_token == 1 )) || fail "$ENV_FILE 中缺少 WEBUI_TOKEN。"
}

say "=== Napcat-Plus 一键安装 ==="

# --- prerequisites -----------------------------------------------------------
command -v docker >/dev/null 2>&1 || fail "未找到 docker。请先安装 Docker: https://docs.docker.com/engine/install/"
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  fail "未找到 docker compose 插件，请安装 compose v2。"
fi
docker info >/dev/null 2>&1 || fail "当前用户无权访问 Docker，请用 root 或把用户加入 docker 组。"

if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  fail "端口无效: $PORT"
fi
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${PORT}$"; then
  say "警告: 宿主机端口 ${PORT} 似乎已被占用，启动可能失败。可用 NAPCAT_PLUS_PORT 指定其他端口。"
fi

# --- layout ------------------------------------------------------------------
umask 077
mkdir -p "$DIR" || fail "无法创建安装目录 $DIR；请用 root 运行或先授予目录写权限。"
DIR="$(cd "$DIR" && pwd -P)"
mkdir -p "$DIR/qq" "$DIR/config" "$DIR/plugins"
cd "$DIR"

ENV_FILE="$DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  say "检测到已有配置，沿用 $ENV_FILE（不会覆盖 Token 或数据）。"
  read_existing_env
else
  if [[ -n "${NAPCAT_PLUS_TOKEN:-}" ]]; then
    WEBUI_TOKEN="$NAPCAT_PLUS_TOKEN"
  else
    WEBUI_TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  ENV_TZ="${TZ:-Asia/Shanghai}"
  valid_token "$WEBUI_TOKEN" || fail "NAPCAT_PLUS_TOKEN 无效：仅支持字母、数字及 _ . / : @ + = -。"
  valid_tz "$ENV_TZ" || fail "TZ 无效：仅支持字母、数字及 _ . / : + -。"
  umask 077
  cat > "$ENV_FILE" <<EOF
WEBUI_TOKEN=${WEBUI_TOKEN}
TZ=${ENV_TZ}
EOF
  chmod 600 "$ENV_FILE"
  say "已生成 WebUI 管理 Token 并写入 $ENV_FILE（权限 600）。"
fi

cat > "$DIR/compose.yaml" <<EOF
name: napcat-plus
services:
  napcat:
    image: ${IMAGE}
    container_name: napcat-plus
    hostname: napcat-plus
    restart: unless-stopped
    env_file:
      - .env
    environment:
      NAPCAT_PLUS_PINNED: "1"
    ports:
      - "${BIND}:${PORT}:6099"
    volumes:
      - ./qq:/app/.config/QQ
      - ./config:/app/napcat/config
      - ./plugins:/app/napcat/plugins
    stop_grace_period: 30s
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:6099/webui/ >/dev/null || exit 1"]
      interval: 30s
      timeout: 5s
      start_period: 45s
      retries: 3
EOF

# --- run ---------------------------------------------------------------------
say "拉取镜像 ${IMAGE} ..."
"${DC[@]}" -f "$DIR/compose.yaml" pull

say "启动容器 ..."
"${DC[@]}" -f "$DIR/compose.yaml" up -d

say "等待 WebUI 就绪 ..."
READY=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/webui/" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[[ -n "$IP" ]] || IP="<服务器IP>"

if (( READY == 1 )); then
  say ""
  say "✅ Napcat-Plus 已启动"
else
  say ""
  say "⚠️  WebUI 尚未响应，查看日志: ${DC[*]} -f $DIR/compose.yaml logs -f"
fi
say "   访问地址 : http://${IP}:${PORT}/webui/"
say "   WebUI Token: ${WEBUI_TOKEN}   （也保存在 ${ENV_FILE}）"
say "   数据目录 : ${DIR}/{qq,config,plugins}"
say ""
say "首次进入后：QQ 登录页扫码登录 → 如需 GSCore，在「GSCore 连接」页填写 ws://<服务名>:8765 并启用。"
say "安全提示：管理端默认监听 ${BIND}:${PORT}。公网使用请配强 Token、限制来源 IP 或放在 HTTPS 反向代理后。"
say ""
say "常用命令："
say "  停止    : ${DC[*]} -f $DIR/compose.yaml stop"
say "  启动    : ${DC[*]} -f $DIR/compose.yaml start"
say "  更新    : ${DC[*]} -f $DIR/compose.yaml pull && ${DC[*]} -f $DIR/compose.yaml up -d"
say "  日志    : ${DC[*]} -f $DIR/compose.yaml logs -f"
say ""
say "注意：不要执行 down -v；数据在 ${DIR} 的绑定目录中，删除容器不会清除账号数据。"
