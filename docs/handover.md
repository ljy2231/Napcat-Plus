# Napcat-Plus 交接文档

> **历史交接快照**：以下记录截至 2026-11-16 18:00（Asia/Shanghai），版本、镜像和部署状态可能已变化；当前安装和版本以仓库 README 与实际部署为准。

## 1. 这是什么

基于 NapCatQQ 最后保留的完整源码（`ljy2231/NapCatQQ@72912f2`）二次开发的 QQ 机器人控制台。核心目标：登录可靠、GSCore 原生桥接、OneBot/系统配置实例级共享、WebUI 可维护、可重复部署。

- 仓库：https://github.com/ljy2231/Napcat-Plus （公开，main 为 `a3a616e7`）
- 当前版本：`0.2.0-preview.3`
- 许可：沿用上游 NapCat 限制性许可（见仓库 LICENSE），非 MIT，公开发布/再分发需遵守原许可与另行授权

## 2. 代码

本地开发目录：`/root/deepseek/qq-bot-console`，当前在分支 `fix/global-config-offline`（内容已推 main，工作区干净）。

技术栈：pnpm 9.15.9 workspace，Node 24，TypeScript + Vite + React/HeroUI。

关键包：

| 路径 | 作用 |
|---|---|
| `packages/napcat-shell/` | 入口与登录流程（`base.ts`、`login.ts`、`login-bootstrap.ts`、`login-start-gate.ts`） |
| `packages/napcat-core/helper/config-base.ts` | 配置加载基类（支持 shared 模式） |
| `packages/napcat-common/src/gscore/` | 内置 GSCore 协议/连接/运行时（`protocol.ts`、`enrichment.ts`、`connection.ts`、`config.ts`、`runtime.ts`） |
| `packages/napcat-onebot/network/gscore.ts` | GSCore 适配器 |
| `packages/napcat-webui-backend/src/api/` | `OB11Config.ts`、`NapCatConfig.ts`、`PluginStore.ts` |
| `packages/napcat-webui-backend/src/helper/` | `SharedConfig.ts`、`WebUiStatic.ts`、`PluginCatalog.ts`、`ConsoleCleaner.ts` |
| `packages/napcat-webui-frontend/src/utils/` | `shared-config.ts`、`resource-recovery.ts`、`console.ts` |

测试：`pnpm run typecheck`、`pnpm --filter napcat-test exec vitest run`（当前 980 通过/2 跳过）、`pnpm --filter napcat-webui-frontend run test:console`（16 项）。

## 3. 镜像

- 应用：`ghcr.io/ljy2231/napcat-plus:latest` = `:v0.2.0-preview.3` = `sha256:1ccc440309c08…`（约 2.4 GB，amd64）
- 运行时：`ghcr.io/ljy2231/napcat-plus-base:qq-3.2.34-53644`（`sha256:6c1b1a27…`）。**上游 `mlikiowa/napcat-docker` 已随删库消失**，此为本机缓存复刻，源码构建依赖它。
- 两个包均为 **Public**。
- 国内加速：`hub.002230.xyz:44300/ghcr.io/ljy2231/napcat-plus:latest`，摘要与 GHCR 一致。
- 残留测试 tag `perm-test` 未清理，可删。

构建：`docker build --file deploy/Dockerfile --build-arg CONSOLE_VERSION=<ver> -t napcat-plus:<ver> .`（内含 typecheck + 全量测试）。

## 4. 运行中的部署

### 6099 生产（在用）

- 目录：`/opt/napcat-plus-native/`，配置 `compose.yaml`，私有环境 `runtime.env`(0600)
- compose project `napcat-plus-native-local`，容器 `napcat-ljy2231`，镜像 `napcat-plus:0.2.0-preview.3`（本地 tag，未改用 GHCR tag）
- 端口 3001 / 6099，网络 `gs-net`（固定 IP 172.19.0.4）
- 挂载：`/opt/napcat/qq`→`/app/.config/QQ`、`/opt/napcat/config`、`/opt/napcat/plugins`
- 状态：healthy，QQ 已登录，**内置 GSCore 已连接**（`console-gscore.json`），旧 GScore 插件（ID `napcat-plugin-builtin`）**已禁用**，SSQQ 启用
- 说明文档：`/opt/napcat-plus-native/README.md`

### 6100 预览

- 目录：`/opt/napcat-plus-preview/`，容器 `napcat-plus-preview-6100`，同镜像
- 独立数据 `/opt/napcat-plus-preview/{qq,config,plugins}`，QQ 未登录，GSCore 关闭
- 用于验证改动、不碰生产账号

### 已删除的容器

`napcat-bot2` 与三个 `napcat-ljy2231-pre-*` 回滚容器已按用户要求删除；删除前配置备份在 `/opt/napcat-backups/container-cleanup-20261116T050823Z/removed-containers.json`。

## 5. 备份

`/opt/napcat-backups/`（权限 0700，含凭据，勿上传）：

| 目录 | 内容 |
|---|---|
| `loginfix-20261116T010656Z` | 最初登录修复版：数据归档、镜像 tar、源码 |
| `plus-upgrade-20261116T024834Z` | 升 0.1.0 时数据归档 + 镜像 |
| `native-gscore-20261116T033948Z` | 切内置 GSCore 时数据归档 |
| `shared-config-20261116T092349Z` | 共享配置迁移前：`onebot11.json`/`napcat.json` 与账号文件 |
| `container-cleanup-20261116T050823Z` | 被删容器的 inspect 配置 |

## 6. 本次会话做了什么

1. **登录时序修复**：原生监听器提前注册、连接事件 latch、单飞、超时只报告；解决“卡在等待二维码”。
2. **内置 GSCore**：原生 WebSocket 桥接，含配置页、脱敏、退避、心跳、连接代次、消息大小限制。
3. **GSCore 群标记段修复**：GSCore 每帧追加 `{"type":"group"}`，早期实现当未知类型整条丢弃 → 群内无回复且只留 `lastError`。现跳过 `group`/`image_size`/`buttons`/`template_*`，仅含标记的帧报“无内容”，未知文本降级为文本。
4. **入站/出站兼容**：`reply_id`+`get_msg` 补正文、私聊文件 `get_private_file_url`、`link://`、裸 base64、markdown→text、有限嵌套/混合消息。
5. **配置实例级共享**：OneBot/系统配置改为 `onebot11.json`/`napcat.json`，未登录可读写，返回 `{scope:'global', application:'applied'|'pending'|'failed'}`；旧 per-account 接口降级别名；迁移保留原文件。
6. **OneBot schema 去重**：WebUI 曾用一份缺 `verifyCertificate` 的副本，保存会丢字段，现统一。
7. **静态资源**：HTML `no-store`、hash 资源 immutable、缺失资源 404（此前会返回 HTML 200 导致 `Failed to fetch dynamically imported module`）、SW 拒绝 HTML-for-script、缓存名带构建指纹、前端提供“刷新并重试”恢复页。
8. **插件商店**：上游索引 404，改为快速返回随包目录 + 后台校验；**在线安装暂停**（旧安装器先删后解压未校验包）。
9. **部署**：prebuilt 镜像 + `deploy/install.sh`（GHCR）+ `deploy/install-cn.sh`（国内，单文件自包含，镜像与脚本都走 `hub.002230.xyz:44300`）。

## 7. 已知限制 / 未完成

- 内置 GSCore **不等价**旧插件：无 notice/meta 事件、撤回回执（`recall_message_id`）、撤销/禁言控制、群开关与黑名单命令、按钮/模板。
- 插件商店只恢复“浏览目录 + 内置入口”，**不能在线安装**；恢复需先做包校验 + 原子替换 + 受控解压。
- SSQQ 未内置（客户端 AGPL、字体授权不明）；用户自行安装插件仍可进 `页面/扩展`。
- 仅验证 Linux amd64；Windows/macOS 与 arm64 未测。
- GUI 在线升级按钮**故意禁用**（`NAPCAT_PLUS_PINNED=1`），升级走镜像。
- 旧 per-account 配置若与全局文件并存时**全局优先**，不会自动覆盖（升级前需人工决定把哪份提升为全局）。
- GHCR 残留 `perm-test` tag。
- GitHub Actions 的 `docker.yml` 已改为使用 GHCR base，但**尚未重新跑通验证**（此前失败因上游 base 被删）。

## 8. 常用命令

```bash
# 6099 状态 / 重启
docker ps --filter name=napcat-ljy2231
docker restart napcat-ljy2231

# 6099 重建（不拉不确定 latest）
docker compose -f /opt/napcat-plus-native/compose.yaml up -d --pull never

# 升级 6099 到 GHCR 最新
sed -i 's#image: .*#image: ghcr.io/ljy2231/napcat-plus:latest#' /opt/napcat-plus-native/compose.yaml
docker compose -f /opt/napcat-plus-native/compose.yaml pull
docker compose -f /opt/napcat-plus-native/compose.yaml up -d

# 6100 预览
docker compose -f /opt/napcat-plus-preview/compose.yaml up -d

# 构建
docker build --file deploy/Dockerfile --build-arg CONSOLE_VERSION=0.2.0-preview.3 -t napcat-plus:test .
```

凭据位置（勿外传）：`/opt/napcat-plus-native/runtime.env`、`/opt/napcat-plus-preview/runtime.env`、`/opt/napcat/config/webui.json`、`/opt/napcat/config/console-gscore.json`。

GHCR 推送令牌曾临时存放在 `/tmp/ghcr-token`（可能已失效，需重新走 `gh auth refresh -s write:packages` 或 device flow）。

## 9. 踩坑记录（重要）

- **GSCore 的 `group` 标记段**：任何“整条拒绝未知类型”的实现都会导致群消息全部丢失，排查时先看 `/api/Console/status` 的 `gscore.lastError`。
- **配置按账号分裂**：`ConfigBase` 原用 `name_<uin>.json`，换号即换配置；现已改 shared。
- **静态资源回退**：SPA catch-all 若匹配到 `.js` 会把 HTML 当脚本返回，表现为 `Failed to fetch dynamically imported module`。
- **登录事件竞态**：原生 `onLoginConnected` 可能在监听器注册前触发，错过就永远不出二维码。
- **上游删库**：`mlikiowa/napcat-docker` 与插件索引都已消失，构建/商店都需要兜底。
