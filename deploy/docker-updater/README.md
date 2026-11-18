# 0.5.3 Docker 网页在线更新

支持 Linux amd64、rootful Docker、Docker Compose v2 和 systemd 的官方一键安装。首次需在 Docker 宿主机启用组件；以后可在“关于与版本”的 Docker 更新面板中选择 GHCR 直连或国内镜像站，再确认更新。仅更新整个应用镜像，服务会短暂重启。

0.5.1/0.5.2 仅包含网页入口，没有安装宿主更新服务。因此仅拉取新镜像无法给旧容器补上宿主权限，需要下面的一次性配置。网页容器始终不挂载宿主 Docker socket。

## 本地 0.5.1 首次启用

适用于默认 `/opt/napcat-plus`、容器名和 hostname 均为 `napcat-plus`、项目名 `napcat-plus`、服务名 `napcat` 的官方 `install.sh` / `install-cn.sh` 安装。请在自己的本地 Docker 宿主机执行，替换成浏览器实际访问的 origin：

```bash
curl -fSLo /root/enable-napcat-updates.sh \
  https://raw.githubusercontent.com/ljy2231/Napcat-Plus/v0.5.3/deploy/enable-updates.sh

# 只读预检：不会停止、重建容器或写入配置
sudo bash /root/enable-napcat-updates.sh --origin http://192.168.1.10:6099

# 预检通过后启用，并使用镜像站发起第一次更新
sudo bash /root/enable-napcat-updates.sh \
  --origin http://192.168.1.10:6099 \
  --apply --accept-official-releases --upgrade --source mirror
```

`--origin` 必须与浏览器地址的协议、主机、端口完全一致，不包含 `/webui/` 路径。例如 HTTPS 反向代理使用 `https://qq.example.com`。`--source ghcr` 表示直连，`mirror` 表示固定国内镜像站 `hub.002230.xyz:44300`。`--upgrade` 可省略，此时只启用更新器，不立即升级。

启用脚本及版本元数据需要直接访问 GitHub/GHCR。**镜像站只加速镜像层下载，不能绕过官方元数据不可达的问题。** 不接受网页或命令行提供任意镜像站 URL。

旧 0.5.1 网页只能发送旧版空请求，默认 GHCR；若第一次就要选择国内镜像站，使用上面的 `--upgrade --source mirror`。升级到 0.5.3 后可以直接在网页选择来源，并核对目标版本和完整摘要。

脚本默认只做预检，执行迁移必须同时给出 `--apply --accept-official-releases`。它会：

1. 核对官方安装布局、Docker/root 权限、健康状态、运行中的镜像 ID、版本标签与官方摘要，拒绝自定义网络、额外挂载、rootless/userns/SELinux 等当前未支持配置。
2. 将原 Compose、已展开的原配置及账号/配置/插件数据备份到 root-only 的 `/var/lib/napcat-updater-setup`。数据备份在停止应用后进行，保证应用写入已停止。
3. 安装 systemd socket/service，将 Token 内联保存在 root-only 的受管配置中，创建包含版本的基线。不会输出 Token。
4. 用原镜像摘要重建一次容器，增加受限 socket 目录挂载，保留端口、hostname、Token、TZ 和三个数据目录。验证真实 WebUI 鉴权到宿主 socket 的链路。
5. 将原来的 `/opt/napcat-plus/compose.yaml` 改为指向受管 Compose 的 include。以后普通 Compose up 使用更新后的持久摘要，不会默默退回旧标签。

首次启用失败且 Docker 操作结果确定时，尝试恢复原镜像和原配置；不会自动删除或覆盖持久数据。超时、进程被强杀或提交结果不确定时保留日志并阻止直接重跑。已有更新器目录、状态或启用记录时安全拒绝覆盖，不会重置防降级基线。

如果开启 WebUI 2FA，首次自动认证验证可能被拒绝，脚本将恢复原镜像并保留日志，需要管理员核对后完成配置；不要通过删除状态目录或关闭鉴权绕过失败。

## 网页使用

在“关于与版本”打开 Docker 更新面板：

- 选择 GHCR 直连或国内镜像站。
- 点击“更新 Docker”，宿主查询最新正式 Release 和官方镜像摘要。
- 确认弹窗中的版本、完整 SHA-256 摘要和来源。
- 确认后宿主重新独立解析并比较版本与摘要；若发布内容已变化，拒绝本次请求，重新预检即可。
- 更新期间浏览器可能断连。稍后重新连接并刷新状态；“已受理”不代表“已完成”。

最新版本无需重建。发现版本或拉取失败会保留当前容器并给出可重试状态；请求有 60 秒限频，到期后可再次刷新。运行镜像漂移、事务未完成、回滚失败或提交结果不确定会进入 `blocked`，需要管理员核对。

## 信任与权限

`--accept-official-releases` 授权自动信任 `ljy2231/Napcat-Plus` 的正式 GitHub Release 和 `ghcr.io/ljy2231/napcat-plus`，以后无需逐版在宿主批准摘要。正式版本严格为 `vX.Y.Z`，拒绝预发布、草稿、版本回退。

宿主从固定 HTTPS API 查询版本，再从固定 GHCR token/manifest API 获取清单，对清单原始字节计算 SHA-256 并核对 registry 摘要。只有所选固定仓库的相同摘要才能拉取；镜像还必须声明与 Release 相同的 `NAPCAT_PLUS_VERSION`。不把版本检查结果、网页提交的版本/摘要或镜像站 tag 当作授权来源。

此方案信任 GitHub/GHCR 账户、TLS 信任库和发布流程，**不提供独立发布签名证明**。官方账户或发布流程被攻陷仍可能发布恶意镜像。容器内能访问更新器 socket 的进程可以触发受约束的官方升级；`:ro` 挂载只防止替换目录，不阻止连接 socket。

## 固定布局与协议

| 用途 | 固定位置 |
| --- | --- |
| 原安装入口 | `/opt/napcat-plus/compose.yaml` |
| 受管 Compose / 策略 | `/etc/napcat-docker-updater/compose.json`、`policy.json` |
| 基线 / 状态 / 事务 | `/var/lib/napcat-docker-updater/` |
| socket | `/run/napcat-docker-updater/updater.sock` |
| 程序 | `/usr/local/libexec/napcat-docker-updater/` |
| 启用备份与日志 | `/var/lib/napcat-updater-setup/` |

策略保留 `project`、`service`、`compose_file`、`image`、`generation` 五个字段。`image` 是初始化绑定摘要，`generation` 不允许回退或同代替换绑定。它不是逐版更新目标。基线包含 `generation`、实际已部署 `image`、`version` 和 `policy_image`；仅有两个字段的旧原型基线拒绝自动转换，需要离线核验版本和镜像。

`prepare.py` 仅负责严格配置生成，**不验证运行容器身份**，应由 bootstrap 完成核对后调用。它将 Compose/策略写入 `/etc`，将基线写入独立 `/var/lib`；拒绝覆盖现有配置或任何非空状态目录，默认脱敏预览。仅支持固定数据根目录，默认网络会严格归一化，自定义网络和其他容器权限字段拒绝。

WebUI API 使用现有 Bearer 鉴权、拒绝 query 凭据；POST 还要求精确 Origin：

- `GET /api/Console/docker-update/status`
- `GET /api/Console/docker-update/preview` → `{version, digest}`
- `POST /api/Console/docker-update/update` → `{source, expectedVersion, expectedDigest}`

宿主 socket 对应 `/status`、`/preview` 和 `/update`。预检字段只是期望值，宿主重新核验；路径、命令、URL 和镜像仓库不能由请求指定。旧 0.5.1 空 POST 仅为首次引导兼容，默认官方 GHCR，不具备新界面的版本/摘要确认。

## 回滚与恢复

更新前核对当前 Compose/基线及运行镜像身份，先拉取固定摘要，保留旧镜像本地备份 tag 和 `pending.json`，再只重建指定服务。健康检查通过后持久更新 Compose 和基线，清理 pending；普通 `compose up` 继续使用新摘要。

失败时从本地备份 tag 回滚，不依赖旧仓库当时在线。**镜像回滚不会回滚 QQ、数据库、配置或插件的数据**。首次启用备份不等于每次更新自动备份，后续升级前应备份并确认数据兼容性。

人工恢复时先停止进一步更新请求，查看容器镜像/健康、Compose、`committed.json`、`pending.json`、备份 tag 和 root journal。不要盲目删除 pending、重置 generation 或覆盖状态重跑。程序异常日志只输出固定阶段和错误类别，避免 Token 或 Docker 输出泄露。

## 验证范围

测试覆盖版本/来源白名单、严格请求、预检目标变化、假冒摘要和版本拒绝、正常提交、失败回滚、限频、慢客户端、状态写入失败及非 root 权限差异。配置生成测试调用真实 `docker compose config`，但不连接 Docker daemon。

真实隔离测试使用第二个 Docker 守护进程和真实 systemd socket 激活及服务沙箱，外部发布元数据与 registry 重定向到独立测试服务；验证升级、普通 Compose 不回退、不健康镜像回滚、QQ/config/plugins 三个数据挂载内测试文件保留。

尚未宣称覆盖所有发行版、rootless/userns/SELinux、任意反向代理、断电的全部持久化窗口或真实 QQ 账号数据格式迁移。自动启用只支持上述固定布局；自定义生产实例（包括服务器 6099）不适用，不能直接套用或重建。
