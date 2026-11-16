#!/usr/bin/env bash
# Napcat-Plus 一键安装（国内镜像加速版）
#
#   直接复制粘贴执行即可，无需设置任何环境变量：
#     curl -fsSL https://raw.githubusercontent.com/ljy2231/Napcat-Plus/main/deploy/install-cn.sh | bash
#
# 可选覆盖（一般不用管）：
#   NAPCAT_PLUS_MIRROR=hub.002230.xyz:44300   镜像源地址
#   NAPCAT_PLUS_PORT=6099                     宿主端口
#   NAPCAT_PLUS_DIR=$HOME/napcat-plus         安装目录
set -euo pipefail

# 国内镜像源：代理上游 registry，镜像摘要与 GHCR 完全一致。
export NAPCAT_PLUS_MIRROR="${NAPCAT_PLUS_MIRROR:-hub.002230.xyz:44300}"

INSTALL_URL="${NAPCAT_PLUS_INSTALL_URL:-https://raw.githubusercontent.com/ljy2231/Napcat-Plus/main/deploy/install.sh}"

echo "使用国内镜像源: ${NAPCAT_PLUS_MIRROR}"

SCRIPT="$(curl -fsSL --retry 3 --connect-timeout 15 "$INSTALL_URL")" || {
  echo "错误: 无法下载安装脚本 $INSTALL_URL" >&2
  echo "可改用直连 GHCR 版本: curl -fsSL https://raw.githubusercontent.com/ljy2231/Napcat-Plus/main/deploy/install.sh | bash" >&2
  exit 1
}

exec bash -c "$SCRIPT"
