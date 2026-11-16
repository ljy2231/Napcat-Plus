# Napcat-Plus

基于 NapCatQQ 最后保留的完整源码，面向自托管 QQ 机器人的增强控制台。重点是**可诊断的登录流程、内置 GSCore 连接管理、清晰的 WebUI 和可重复部署**，不是只更换名称的上游镜像。

> 非腾讯官方产品，也不代表 NapCat 原作者。账号风控、平台协议变化和上游原生依赖仍可能影响可用性。不得用于骚扰、垃圾消息或未经授权的账号操作。

## 快速开始

一行命令，复制粘贴就能跑（Linux amd64，需要已装 Docker）。

**国内服务器（加速站已写进命令，全程不访问 GitHub）：**

```bash
curl -fsSL https://hub.002230.xyz/https://raw.githubusercontent.com/ljy2231/Napcat-Plus/main/deploy/install-cn.sh | bash
```

**海外 / 直连 GHCR：**

```bash
curl -fsSL https://raw.githubusercontent.com/ljy2231/Napcat-Plus/main/deploy/install.sh | bash
```

脚本会自动生成 WebUI Token、建好数据目录、拉镜像、启动容器并等健康检查，最后打印访问地址和 Token。默认装在 `~/napcat-plus`，端口 `6099`。重复执行不会覆盖已有数据或 Token。

换端口 / 换目录 / 换版本：

```bash
NAPCAT_PLUS_PORT=6100 NAPCAT_PLUS_DIR=/opt/napcat-plus \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/ljy2231/Napcat-Plus/main/deploy/install.sh)"
```

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NAPCAT_PLUS_PORT` | `6099` | 宿主端口 |
| `NAPCAT_PLUS_DIR` | `$HOME/napcat-plus` | 安装目录 |
| `NAPCAT_PLUS_BIND` | `0.0.0.0` | 监听地址，反代后面可设 `127.0.0.1` |
| `NAPCAT_PLUS_IMAGE` | GHCR `latest` | 指定版本，如 `:v0.2.0-preview.3` |
| `NAPCAT_PLUS_MIRROR` | 空 | 镜像源前缀；`install-cn.sh` 已内置 `hub.002230.xyz:44300` |

镜像地址（已公开，可匿名拉取）：

| 镜像 | 说明 |
| --- | --- |
| `ghcr.io/ljy2231/napcat-plus:latest` / `:v0.2.0-preview.3` | 应用镜像，约 2.4 GB |
| `hub.002230.xyz:44300/ghcr.io/ljy2231/napcat-plus:latest` | 同一镜像的国内加速路径，摘要一致 |
| `ghcr.io/ljy2231/napcat-plus-base:qq-3.2.34-53644` | 固定 QQ 运行时；上游 `mlikiowa/napcat-docker` 已随删库消失，此镜像为复刻 |

**不用脚本的纯 docker 一行**（适合临时试用，Token 会打印在日志里）：

```bash
docker run -d --name napcat-plus --restart unless-stopped -p 6099:6099 \
  -e WEBUI_TOKEN=$(openssl rand -hex 24) \
  -v "$HOME/napcat-plus/qq:/app/.config/QQ" \
  -v "$HOME/napcat-plus/config:/app/napcat/config" \
  -v "$HOME/napcat-plus/plugins:/app/napcat/plugins" \
  ghcr.io/ljy2231/napcat-plus:latest
docker logs -f napcat-plus   # 查看 WebUI 地址与 Token
```

### 从源码构建（自定义/离线）

```bash
cp deploy/.env.example deploy/.env
# 编辑 deploy/.env，将 WEBUI_TOKEN 改为随机强密码
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

数据挂载路径：

| 目录 | 容器位置 |
| --- | --- |
| `qq/` | `/app/.config/QQ` |
| `config/` | `/app/napcat/config` |
| `plugins/` | `/app/napcat/plugins` |

**不要执行 `docker compose down -v`；账号数据保存在宿主机的绑定目录中。**

### 连接 GSCore

将 GSCore 和 Napcat-Plus 加入同一个 Docker 网络，在控制台填写 `ws://<GSCore服务名>:8765`。如果 GSCore 使用 `network_mode: service:...` 或共享代理容器网络，应填那个网络容器的服务名。`localhost` 指当前 Napcat-Plus 容器，不是宿主机或另一个容器。无需为容器间通信开放公网端口。

仅保存地址不代表连通：QQ 登录后看连接状态与诊断结果。GSCore 服务本身不由示例 Compose 自动安装，避免未经确认引入不固定的镜像或修改已有服务。

## 升级

**GUI 里没有可用的在线升级按钮。** 本镜像固定了定制构建（`NAPCAT_PLUS_PINNED=1`），会拒绝上游在线更新，避免覆盖登录修复、共享配置等改动；页面上的更新入口只会提示通过镜像升级。

### 标准安装目录（用 install.sh 装的）

```bash
cd ~/napcat-plus
docker compose pull
docker compose up -d
```

或者直接再跑一次安装脚本（幂等，不会动数据和 Token）：

```bash
curl -fsSL https://hub.002230.xyz/https://raw.githubusercontent.com/ljy2231/Napcat-Plus/main/deploy/install-cn.sh | bash
```

### 手动 docker run 装的

```bash
docker rm -f napcat-plus   # 数据在宿主机目录里，不会丢
# 然后用「快速开始」里的 docker run 命令重新启动即可
```

### 指定版本

```bash
NAPCAT_PLUS_IMAGE=ghcr.io/ljy2231/napcat-plus:v0.2.0-preview.3 \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/ljy2231/Napcat-Plus/main/deploy/install.sh)"
```

### 升级前

- 备份数据目录（`qq/`、`config/`、`plugins/`）以及 `config/onebot11.json`、`config/napcat.json`
- 不要用 `docker compose down -v`
- 升级只换镜像，账号数据、登录态、插件配置都在宿主机绑定目录里保留
- 升级后浏览器可能仍持有旧资源，按一次 `Ctrl + F5`

## 来源与许可

- 基线：[`ljy2231/NapCatQQ@72912f2`](https://github.com/ljy2231/NapCatQQ/commit/72912f293924f43463b5976b01fc094a8ae11481)，2026-11-10，`docs: ending`；保留此前 Git 历史。
- 原项目：[`NapNeko/NapCatQQ`](https://github.com/NapNeko/NapCatQQ)，Copyright © 2024 Mlikiowa。
- 完整保留 [上游许可证](<LICENSE>) 与第三方版权声明。**这不是 MIT/Apache 项目，公开可见不等于可以任意再发布或商用。** 修改、公开发布及二次分发必须满足原许可证与另行取得的授权；本仓库不向下游授予超出上游的权利。
- 原上游发布流程已归档，不会再向 NapNeko 的文档、镜像、API 平台或其他仓库写入。

## 主要改造

### 登录稳定性

- 初始化 QQ 原生层之前注册登录监听器，缓存早到的连接事件。
- 等待原生配置、历史账号列表和 WebUI 自动登录策略就绪后再启动登录。
- 连接代次与单飞控制避免重复登录；断线使旧事件失效。
- 超时提供具体阶段而非无限转圈；失败不无限重试密码；成功不被迟到错误覆盖。
- 保留二维码、快捷登录、密码及验证流程。

### 原生 GSCore 集成

内置 GSUID Core WebSocket 适配器，不需要把第三方插件伪装为 `napcat-plugin-builtin`。

- 可视化开关、地址、Token、有限指数退避、手动重连、真实连接状态。
- 热更新使用连接代次，旧连接的迟到 `close/error` 不会清空新连接；断线后旧队列任务也失效。
- Token 不在状态/配置读取 API 中回显，省略保留、空字符串清除；本地配置权限为 `0600`。
- 入站：文本/@/表情/引用/图片/语音/视频/文件/合并转发；引用通过只读 `get_msg` 补正文与媒体，私聊文件通过 `get_private_file_url` 补下载地址。
- 出站：兼容 `link://HTTP(S)`、裸 base64、`base64://`、`reply_id`、Markdown 转文本，以及最多 3 层嵌套、20 个有序动作的混合消息；整包先校验再发送。
- 跳过 GSCore 的 `group`/`image_size`/`buttons`/`template_*` 记账标记段。**GSCore 会给每帧群消息末尾追加 `group` 段，早期版本把它当未知类型导致整条丢弃、群内无回复且只在 `lastError` 留下提示。**
- 不提供任意 OneBot 动作执行；拒绝跨账号目标、非文本控制动作和从 GSCore 请求读取本机文件。
- 默认关闭。启用后应**停用旧 GSCore 桥接插件**，避免重复收发。
- 仍未覆盖旧插件全部特性：notice/meta 事件、撤回回执、撤回/禁言控制、群开关与黑名单命令、按钮模板。切换前请用测试账号回归。

### 插件目录（原插件商店）

上游索引 `NapNeko/napcat-plugin-index` 已删库，原商店会串行重试镜像后整页报错。

- 首次立即返回随包目录（内置 GSCore/清理/诊断 + SSQQ 官方项目页），官方索引在后台限时检查。
- 显示来源状态（在线/缓存/随包）、最近检查时间和失败摘要，不再长时间转圈。
- 不再加载第三方头像、站外 README 或 favicon 服务；外部页面需用户主动打开。
- **在线一键安装已暂停**：旧安装器会先删除现有插件再解压未校验的包，且远端 SHA 不是独立信任根。POST 与 SSE 安装接口均在后端拒绝，不能通过 mirror/force 绕过。恢复的是目录浏览与内置入口，不是所有被删插件的一键安装。

### 内置工具

- **聊天与事件**：保留原有 OneBot 实时消息/聊天入口。
- **缓存清理**：日志/临时缓存先预览、再确认删除，60 秒一次性预览；默认不运行定时清理，不动 QQ 数据库。
- **插件调试**：已鉴权的插件状态、开关和手动热重载；不额外开放调试 WebSocket 端口。
- SSQQ / Stapxs QQ Lite **未捆绑**：插件外壳与客户端使用不同许可证，且预构建包还含字体/远程资源。详见 [SSQQ 来源与许可核对](<docs/ssqq-integration.md>)；用户仍可单独安装合规版本。

GSCore 是受信任服务：开启后会转发 QQ 消息并接受指定聊天的回复。仅连接自己管理的实例；公网连接使用 `wss://` 和 Token。其连接协议参考 [GSUID Core 消息模型](https://github.com/Genshin-bots/gsuid_core/blob/master/gsuid_core/models.py)。不声称兼容所有插件扩展（撤回回执、频道、复杂节点等需另行适配）。

### 控制台与部署

- 中文控制台、深浅主题、响应式导航，保留原 OneBot/聊天/文件/插件功能。
- QQ 未登录时仍可查看诊断和管理 GSCore 配置。
- 基于源码构建 WebUI 与 Shell；固定 QQ 运行时镜像摘要。
- GitHub CI：类型检查、测试、构建；独立 GHCR 工作流仅发布本仓库镜像。
- 默认阻止上游在线更新覆盖增强功能，升级使用本项目固定镜像。

## 本地开发

需要 Node.js 24 与 pnpm 9.15.9。

```bash
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck
pnpm --filter napcat-test exec vitest run
pnpm run build:webui
pnpm run build:shell
```

依赖安装默认不执行生命周期脚本；原生 QQ 测试需要相应运行环境，不能由纯单元测试替代。

## 自动构建与发布

- 分支推送/PR：只读权限运行 CI，不使用 `pull_request_target` 执行不可信代码。
- 推送 `v*` 标签：构建并推送 `ghcr.io/ljy2231/napcat-plus`。
- 手动镜像构建默认不发布；选择 `publish` 后才推送。首次 GHCR 包的可见性可在 GitHub Packages 中设置。
- GHCR 只使用该仓库 `GITHUB_TOKEN`，不需要把个人 Token 写入代码或工作流。
- 本地构建可覆盖 `QQ_RUNTIME` 参数，但必须重新验证对应 QQ 版本兼容性。

## 从旧名称升级

项目现名为 **Napcat-Plus**，仓库地址为 [ljy2231/Napcat-Plus](https://github.com/ljy2231/Napcat-Plus)。npm/Docker 标识使用小写 `napcat-plus`。

如果曾使用旧名称的示例 Compose 部署，请在私有 `.env` 中继续设置 `COMPOSE_PROJECT_NAME=qq-bot-console`、`BOT_NETWORK=qq-bot-network`，以复用原持久化卷和网络；不要只更换项目名就启动第二套空数据实例。新安装使用示例中的 `napcat-plus` 默认值。内部 API、配置文件名及 GSCore 连接身份保留兼容，不因更名迁移账号数据。

## 升级与回滚

先停止旧实例并备份三个持久化目录/卷。切换镜像时继续绑定原路径，**不要让新旧实例同时使用同一 QQ 账号数据**。保留旧镜像标签与配置归档，失败时停止新实例再回滚。数据库格式跨版本兼容性需单独验证。

已有第三方 GSCore 插件的配置不会自动导入内置连接，避免未知凭据迁移和重复转发。请确认旧插件已停用后，在新页面显式填写配置。

## 安全与测试边界

- 不要提交 `.env`、QQ 数据库、日志、二维码、用户插件 Token 或容器 inspect。
- 构建上下文与 Git ignore 已排除常见运行数据；发布前仍应审查暂存区。
- 默认在线更新禁用；显式设 `NAPCAT_PLUS_PINNED=0`（兼容旧变量 `QQ_BOT_CONSOLE_PINNED`）会恢复旧更新逻辑，但可能覆盖此分支，不建议使用。
- 网络故障、风控和其他插件故障不在“永久修复”的保证范围内。
- 测试结果、已知限制与变更范围见 [改造说明](<docs/console-changes.md>)。
- GSCore 兼容修复与插件目录改造的来源、验证方法见 [0.2 预览说明](<docs/preview-6100.md>)。
