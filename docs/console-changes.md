# 改造范围与验证

## 基线

完整保留 `72912f293924f43463b5976b01fc094a8ae11481` 的来源与历史。新功能位于独立开发分支，不以运行容器的压缩 bundle 为开发源码。

## 原插件功能对照

| 原插件 | 本项目处理 | 边界 |
| --- | --- | --- |
| GSCore 适配 | 独立实现的内置适配器和管理页 | 默认关闭；不得同时启用旧桥接；支持常见消息类型，非所有扩展动作 |
| SSQQ / Stapxs QQ Lite | 保留原项目已有聊天/事件界面，并提供入口 | 尚不把用户现装的 AGPL 客户端二进制冒充 MIT 捆绑；查看 [SSQQ 许可核对说明](<ssqq-integration.md>) |
| Cleaner | 内置日志/临时缓存预览与确认清理 | 不读取或删除 QQ 账号数据库、登录信息、二维码、媒体历史；无默认定时清理 |
| Debug | 内置已鉴权的插件列表、开关和手动热重载 | 不开放原插件的额外 WebSocket 调试端口，不提供任意代码执行 |
| 上游 Builtin 示例 | 源码保留 | 不默认部署公开暴露配置的演示路由，也不将 GSCore 冒充该 ID |

原插件可继续由用户安装，但本项目不自动复制宿主机插件配置或凭据。功能替代不代表与原插件 UI/全部特性一一相同。

## 登录改造

拆分为登录连接门控、就绪屏障及实际登录流程。真实 listener 在 session、engine、initConfig 之前注册。原生准备、历史账号和 WebUI 策略均完成后才启动；早到连接缓存、失效连接丢弃、重复通知不重复账号请求。

超时只报告阶段，不盲目重复登录；自动策略返回 attempted/success/needsVerification，二维码兜底仅一次；成功优先于迟到的失败；二维码刷新单飞。

## GSCore

- 每次 socket 都有独立 generation；旧事件/排队微任务不能影响新的 socket。
- 关闭、重连、改地址/Token 会取消旧计时器与待处理消息代次。
- 最多 100 条待处理消息、16MiB 单消息上限、4MiB 发送背压。
- 指数退避上限5分钟，重试次数必须1–100；心跳检测半开连接。
- Token 只保存在私有配置，响应和日志使用脱敏状态；URL 不允许内嵌凭据、query和fragment。
- 入站只转发QQ消息，不转发自己的消息；出站只有允许的发送动作，调用现有动作schema检查。
- 媒体只能HTTP(S)/base64；服务须可信，管理员配置的GSCore能够发消息，不能当成无权限访客服务。

## 清理安全策略

仅针对 NapCat 的 logs/cache 两个固定根目录，按1–3650天保留策略预览。最多扫描10000个条目、每次最多1000文件。预览有效60秒且只能用一次；执行前再次核对realpath、inode/device、mtime、大小和单链接普通文件，跳过变更/软链接、数据库、二维码及登录信息。需要明确确认，未预览不能删除。

不保证对拥有同等本机写权限的恶意进程实现内核级TOCTOU隔离；这不是通用任意目录清理器。

## 自动构建

仅本仓库读权限CI；Docker发布需tag或手动选择publish。归档原上游跨仓库发布流程，固定pnpm和lockfile，默认不执行依赖安装脚本。Docker从源码构建再叠加固定QQ运行时，预解包目录与首次解包ZIP同步；无账号数据进入镜像。

## 验证方法

```bash
pnpm run typecheck
pnpm --filter napcat-test exec vitest run
pnpm --filter napcat-webui-frontend run test:console
pnpm run build:webui
pnpm run build:shell
```

单元测试包括原上游测试、源码真实登录调用链、native事件同步/异步顺序、自动策略、GSCore配置/消息映射/重连与真实本地WebSocket往返、文件清理范围与变更跳过、前端状态/Token处理。

浏览器和真实QQ运行时测试必须使用隔离账号目录、独立端口；不得与生产容器共享已登录账号目录。公开截图不得包含账号、Token或有效登录二维码。

## 已知限制

- 运行镜像当前仅 Linux amd64。Windows/macOS源码保留，但此次未对真实客户端做端到端验证。
- QQ 原生组件由固定上游运行时提供；来源可追踪但不是本项目可独立重编译的腾讯组件。
- 登录修复不绕过QQ验证、风控或平台限制，不保证未来协议兼容。
- 未代用户发送QQ业务消息，不以WebSocket连接成功替代全部机器人指令验收。

## 实例级配置与静态资源（0.2.0-preview.3）

**配置不再绑定 QQ 账号。** OneBot 网络配置与分析系统配置对同一实例内所有账号共用：

- 规范文件为 `onebot11.json` / `napcat.json`；旧的 `onebot11_<QQ>.json`、`napcat_<QQ>.json` 仅在首次迁移时被读取复制，原文件保留。
- 未登录 QQ 也可读取和保存，保存后返回 `{scope:'global', application:'applied'|'pending'|'failed'}`。在线时 OneBot 设置立即应用，系统设置需重启才生效。
- 已存在全局文件时不会被账号文件覆盖；多份账号文件且无账号上下文时拒绝猜测，仅使用默认值且不写入。
- 旧 per-account 接口保留为别名，避免旧前端分裂数据。
- OneBot schema 统一为一份，修复 WebUI 保存时丢失 `verifyCertificate` 的问题。

**旧构建资源加载失败：** 之前 `/webui/` 与 `index.html` 被缓存一天，且不存在的 `.js` 会回退成 HTML 200。现在 HTML 为 `no-store`、带 hash 资源为 immutable、缺失资源返回 404 `text/plain`，Service Worker 不再把「脚本请求返回 HTML」当作可缓存资源，并以构建指纹命名缓存。前端遇到 chunk 加载失败时显示明确的刷新提示，绝不自动刷新或清除管理凭据。

**升级注意事项：** 若实例已有账号独立配置且全局文件是模板，需在升级前明确选择把当前账号配置提升为全局（本次生产升级已备份 `onebot11.json`/`napcat.json` 与账号文件后执行）。
