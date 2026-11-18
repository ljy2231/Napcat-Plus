# Docker 宿主更新器原型

> **状态：安全敏感的可选组件，默认关闭；尚未完成生产安装流程与完整安全审计，不要直接用于生产。** 更新事务已在独立第二个 Docker 守护进程上做过真实升级、回滚、限频和拉取失败验证（见“已验证的范围”），但 systemd 沙箱、用户命名空间/SELinux、断电恢复和真实业务链路仍未验证。本文是设计与配置前提说明，不是生产安装指南；示例均为占位信息，不包含有效凭据、真实域名或有效镜像摘要。

## 作用与信任边界

网页发起的是**整个 Docker 服务镜像的替换**，不是替换静态页面。更新器作为宿主机上的独立 root 进程运行，通过 systemd 激活的 Unix socket 接收固定动作；WebUI 容器不需要挂载宿主 Docker socket。它使用宿主管理员预先批准的固定 `repository@sha256:...` 和递增的 `generation`，网页不能指定镜像、命令、Compose 路径或参数。**版本检查结果不会自动批准镜像；管理员仍须在宿主机审核并更新策略。**

凭据认证、Unix socket 权限和固定动作只是分层保护：能访问该 socket 的容器进程仍可发起已批准更新，容器或 WebUI 被攻陷时仍有拒绝服务风险。镜像摘要只约束内容一致性，**不证明发布者可信、镜像安全或许可合规**。绝不要把 `/var/run/docker.sock` 或其他宿主敏感目录挂给应用容器。

## 固定路径与文件

当前实现的路径不是请求参数，也不随 `NAPCAT_PLUS_DIR` 改变：

| 用途 | 宿主路径 |
| --- | --- |
| 更新策略 | `/etc/napcat-docker-updater/policy.json` |
| 唯一受管 Compose 文件 | `/etc/napcat-docker-updater/compose.json` |
| 更新状态、锁、事务记录 | `/var/lib/napcat-docker-updater/` |
| Unix socket | `/run/napcat-docker-updater/updater.sock` |
| 服务程序 | `/usr/local/libexec/napcat-docker-updater/updater.py` |
| 允许的数据根目录 | `/opt/napcat-plus` |

策略文件、Compose 文件及其祖先路径须由 root 拥有、不是符号链接且不可由 group/other 写入；程序也应由 root 安全安装并防止非特权用户或应用容器修改。当前检查并不替代对 ACL、挂载、父路径替换、Docker/rootless/user namespace、SELinux 和其他系统配置的完整安全审计。

策略必须恰有 `project`、`service`、`compose_file`、`image`、`generation` 五个字段。`project` 和 `service` 只接受小写字母、数字、`_`、`-`，`generation` 为正整数；`compose_file` 必须是上述固定路径；`image` 必须是带 `@sha256:` 的小写完整引用。示意（全零摘要只是占位，不能使用）：

```json
{
  "project": "napcat-plus",
  "service": "napcat",
  "compose_file": "/etc/napcat-docker-updater/compose.json",
  "image": "ghcr.io/example/napcat-plus@sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "generation": 2
}
```

## 严格 Compose JSON 示例

更新器只读取固定的**单服务 JSON 格式 Compose 文件**：顶层只能有 `services`；服务只允许 `image`、`restart`、`environment`、`ports`、`volumes`、`healthcheck`、`stop_grace_period`。禁止 `$` 插值，也不能使用 `include`、`extends`、`build`、`env_file` 或其他服务字段。下面仅展示形状，不是可直接用于任何部署的配置：

```json
{
  "services": {
    "napcat": {
      "image": "ghcr.io/example/napcat-plus@sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "restart": "unless-stopped",
      "environment": {
        "WEBUI_TOKEN": "REPLACE_WITH_PRIVATE_RANDOM_TOKEN",
        "NAPCAT_PLUS_PINNED": "1",
        "NAPCAT_DOCKER_UPDATER": "1",
        "NAPCAT_DOCKER_UPDATER_ORIGIN": "https://example.invalid"
      },
      "ports": ["127.0.0.1:6099:6099"],
      "volumes": [
        "/opt/napcat-plus/qq:/app/.config/QQ",
        "/opt/napcat-plus/config:/app/napcat/config",
        "/opt/napcat-plus/plugins:/app/napcat/plugins",
        "/run/napcat-docker-updater:/run/napcat-docker-updater:ro"
      ],
      "healthcheck": {
        "test": ["CMD-SHELL", "curl -fsS http://127.0.0.1:6099/webui/ || exit 1"],
        "interval": "30s",
        "timeout": "5s",
        "start_period": "45s",
        "retries": 3
      },
      "stop_grace_period": "30s"
    }
  }
}
```

`environment` 中的 Token 只是占位符；实际文件会含明文管理凭据，必须由可信 root 管理且限制读取（例如 root-only），**不要提交、上传或放入应用可写目录**。`NAPCAT_DOCKER_UPDATER_ORIGIN` 必须精确等于浏览器访问管理页面的 origin（含协议、主机和非默认端口，不含路径或末尾斜杠）；反向代理/TLS 的实际 origin 必须由管理员核对。将 socket 目录以 `:ro` 绑定只能阻止容器替换目录，**不能阻止连接 socket**。

代码要求恰好四个短格式绑定：三个固定的数据目录和上述 socket 目录只读绑定；不支持任意额外挂载。数据目录必须真实存在、不是符号链接，且解析后的路径就是固定路径。socket 必须真实存在，类型为 Unix socket，属主 root、属组 `napcat-updater`、权限 `0660`。应用容器进程还必须有连接该 socket 的权限；是否满足取决于容器实际 UID/GID、用户命名空间映射和系统策略，不能仅凭容器内显示的 root 推断。`trusted_path` 也要求 `/opt/napcat-plus`、socket 目录及其祖先满足 root 所有、无 group/other 写权限的检查。

## baseline 与预批准

首次启用前，管理员必须**离线建立已知良好基线**，不能让网页替管理员初始化：

1. 审核当前 Compose 文件、宿主 Docker、服务配置和镜像来源，确认目标服务仅一个容器且运行中的镜像与固定摘要一致，并先独立备份持久数据。
2. `/var/lib/napcat-docker-updater/committed.json` 需由可信管理员建立为包含且仅包含 `generation` 和 `image` 的 JSON。例如 `{"generation": 1, "image": "ghcr.io/example/napcat-plus@sha256:1111111111111111111111111111111111111111111111111111111111111111"}`。`image` 必须与 Compose 的现行镜像引用以及实际运行容器镜像身份一致；摘要占位符必须替换成独立审核后的真实值。状态目录应仅 root 可写，并保留其他用户无法修改的基线。
3. 初始 `policy.json` 中 `generation` 和 `image` 可与该 baseline 一致；同代数同镜像表示已应用，不会重建。缺失或损坏的 baseline、代数倒退、同代数改变镜像、运行镜像漂移、未完成事务都会阻止更新。
4. 审核**新版本**的真实镜像来源、平台和摘要后，管理员在宿主机更新 `policy.json` 的 `image` 与更大的 `generation`。**此时不要提前把 Compose 的 `image` 改为目标镜像**：它须仍等于已提交 baseline。网页点击仅请求应用这份事先批准的策略，不会根据版本 API 自动选取镜像。

策略涉及 root Docker 操作；管理员应采用可信原子写入、保留备份并限制访问。`generation` 是管理约定，不是对版本真实性或镜像签名的验证。更新前必须确认该版本的数据格式、容器配置和回退兼容性。

## 生成受管配置（prepare.py）

`prepare.py` 从现有部署的展开配置生成受管 `compose.json`、`policy.json` 和 `committed.json`，避免手写 JSON 时丢失容器名、主机名或环境变量。它默认只打印脱敏预览，`--apply` 才写入 root-only 文件。

```bash
# 先导出展开后的配置（env_file 与相对路径会被解析）
docker compose -f /opt/napcat-plus/compose.yaml config --format json > /root/napcat-resolved.json

python3 prepare.py --resolved /root/napcat-resolved.json \
  --project napcat-plus --service napcat \
  --origin https://console.example.com \
  --current-image ghcr.io/ljy2231/napcat-plus@sha256:<当前摘要> \
  --target-image ghcr.io/ljy2231/napcat-plus@sha256:<审核后的新摘要> \
  --generation 2 --apply
```

要点：

- 两个镜像参数必须是你**独立审核过的完整摘要**；脚本不验证签名、发布者或版本兼容性。
- 只接受恰好三个数据挂载（qq/config/plugins）和单服务；`networks`、`build`、`env_file`、额外挂载会被拒绝。
- 环境变量会内联写入 root-only 的 `compose.json`，包含 `WEBUI_TOKEN`；不要提交或公开该文件。预览输出会把 Token 替换为 `<redacted>`。
- 含 `$` 的环境变量值会被拒绝，因为 Compose 会再次插值。
- 脚本不会安装 systemd、不会创建组、不会重启容器；完成后仍需按上文手动安装 socket/服务并重建一次容器以挂载 socket 目录。

## systemd 与 WebUI 路由

提供的 unit 文件仅为原型：

- `napcat-docker-updater.socket` 监听固定 socket，`SocketUser=root`、`SocketGroup=napcat-updater`、`SocketMode=0660`，由 `sockets.target` 激活；需要管理员事先创建和管理专用系统组。
- `napcat-docker-updater.service` 以 root 启动 `/usr/bin/python3 /usr/local/libexec/napcat-docker-updater/updater.py`，使用 socket activation、`UMask=0077`、`ProtectSystem=strict` 等约束；允许对固定策略与状态目录写入。它不是无特权服务，也不自动备份数据。
- 管理员若未来进行隔离实验，需以 root 将**经审查**的程序和两个 unit 放到各自指定位置、建立受限策略/Compose/baseline/数据目录、配置组与 socket，并由 systemd 加载 socket unit。本文不提供执行系统安装或修改的命令；这些步骤尚未端到端验证。

应用端路由在统一 WebUI 鉴权后提供 `GET /api/Console/docker-update/status` 和 `POST /api/Console/docker-update/update`。两者额外要求 `Authorization: Bearer ...` 且拒绝 query 参数；POST 还要求空 JSON 对象、`NAPCAT_DOCKER_UPDATER=1`、配置的精确 Origin，并检查存在时的 `Sec-Fetch-Site`。未启用时状态返回 `enabled: false`，不会触发宿主更新。宿主 socket 接口只接受固定 `/status` GET 和无请求体的 `/update` POST；`202 accepted` **不代表升级成功**，应重连后查看持久状态。

## 更新、回滚和恢复边界

更新器使用进程内互斥与 `flock`，拒绝重入，并对请求限频。它检查策略、baseline、Compose 和当前镜像身份，先拉取预批准 digest，记录旧镜像备份标签和 `pending.json`，再仅对指定服务执行 `compose up`；健康检查在 90 秒内需返回 `healthy`。成功后分别持久更新 Compose 的 image 字段与 `committed.json`，再清理 pending。

限频期间状态为 `rate_limited` 并带 `retryAt`（Unix 秒）；到期后 `GET /status` 会返回 `idle`，网页无需管理员介入即可重试。只有需要人工处理的状态才使用 `blocked`。异常诊断只向 root journal 写入固定阶段和异常类别，不输出异常文本、Docker 输出、路径、镜像名、Token 或请求数据。

预检失败不会主动重建；应用阶段失败时尝试使用旧镜像回滚，并等待旧容器健康。Docker 命令超时、回滚失败、提交结果不确定或发现 pending 时进入 `blocked`，需要管理员检查，不能假设操作没有发生。进程中断后启动会把残留进行中状态标为 `blocked`。恢复应由管理员停止进一步请求，检查实际容器镜像与健康、Compose、`committed.json`、`pending.json`、备份标签和日志，再在有独立备份的情况下人工决定恢复；**不要盲目删除 pending、改写代数或反复重试**。状态文件的写入和进程崩溃的所有窗口尚未完整验证。

**镜像回滚不回滚 QQ、数据库、配置或插件等持久数据**，也不保证跨版本数据格式兼容；升级前必须单独备份并验证恢复。更新可能导致服务中断，且用户浏览器与 WebUI 的连接可能暂时断开。

## 与现有安装不兼容

默认 `deploy/install.sh` / `install-cn.sh` 生成的 Compose 使用独立 `.env`、不同文件位置，也没有 socket 挂载和更新器变量；源码示例 Compose 同样不是此严格 JSON。它们**不会自动安装或启用此更新器**。用户现有 `6099` 生产实例使用自己的 Compose、网络、端口和 `/opt/napcat/...` 挂载，不符合此原型固定的数据根目录和 Compose 约束，**不能直接套用本配置或重建该实例**。

## 已验证的范围

2026-11-18 使用**独立第二个 dockerd**（临时 data-root、临时 socket、无网桥、不影响宿主守护进程）加 mount namespace 和本地 registry，跑过真实 Docker 的以下场景，全部通过：

- 基线容器健康运行时，页面触发升级：拉取预批准 digest → 替换容器 → 健康 → 持久更新 Compose 与 `committed.json` → 清理 pending，最终运行新镜像。
- 升级成功后再次执行普通 `docker compose up -d`：仍选择新摘要，不会回退。
- 目标镜像健康检查失败：自动回滚旧镜像并通过健康检查，Compose 与 committed 保持旧摘要，pending 清理，状态 `failed`。
- 拉取失败：状态 `blocked`，运行容器、Compose 和 committed 均未改变。
- 限频：返回 `rate_limited` + `retryAt`；到期后 `GET /status` 自动返回 `idle`，无需人工介入。

**仍未验证**：systemd 单元沙箱、systemd socket 激活（测试用启动器模拟 fd 3）、用户命名空间/SELinux、反向代理后的 Origin、断电与进程强杀下的持久化窗口、QQ 登录与 GSCore 业务链路。启用前仍需独立安全审计和部署/恢复演练。不要根据本说明在生产机器上启用该服务。
