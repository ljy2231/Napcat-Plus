# 验证记录（2026-11-16）

## 自动检查

- 全工作区 TypeScript 类型检查通过。
- Vitest：58 个测试文件，888 项通过、2 项跳过（上游有条件原生测试）。
- 前端控制台 helpers：9 项通过。
- 新增 GSCore、Cleaner、Console 路由相关代码 ESLint 通过。
- `git diff --check` 与 Docker Compose 示例校验通过。
- Docker 多阶段构建实际执行依赖安装、全量类型检查、测试、WebUI/Shell构建及运行时组装，成功生成 Linux amd64 镜像。
- 发布内容模式检查未发现个人 GitHub Token、私钥正文、现网 QQ 账号或 WebUI Token；原SSL配置页的私钥占位符不是实际私钥。

## 真实隔离运行时

使用新镜像创建临时 QQ 容器：独立账号目录、无生产卷、仅绑定宿主机loopback测试端口。确认：

- WebUI 登录与退出凭据流程可用。
- QQ 后端真实生成二维码，状态为 `waiting_qrcode`；没有扫码或发送 QQ 消息。
- `/Console/status` 返回真实未登录状态、GSCore默认关闭。
- Cleaner execute 无鉴权或缺少明确确认被拒绝；新目录预览为空。
- 未改动已有在线 `napcat-ljy2231` 或 GSCore 服务。

## 浏览器自动验收

> 以下为更名前的历史验收截图，界面中可能显示旧名称；当前项目已更名为 Napcat-Plus。

Chromium 141 / Playwright 1.56.1，1440×1000 与390×844：

- 管理登录→仪表盘→GSCore→内置工具→手机仪表盘流程通过。
- 深浅主题可切换；手机页面无横向溢出。
- 页面 `pageerror` 为0。修复了原入口匿名请求 `/auth/check` 的未捕获 Unauthorized 异常。
- 以下截图来自真实隔离服务，不模拟在线账号，不含Token、账号或有效二维码。
- 截图已生成；自动验收不等同于对每个像素或所有业务入口的人工视觉验收。

![仪表盘浅色](<screenshots/dashboard-light.png>)

![仪表盘深色](<screenshots/dashboard-dark.png>)

![GSCore连接管理](<screenshots/gscore.png>)

![内置工具](<screenshots/tools.png>)

[管理登录](<screenshots/login.png>) · [手机布局](<screenshots/dashboard-mobile.png>)

## 未覆盖的部分

- 未代用户发送真实群聊/私聊或执行业务机器人命令。
- GSCore消息链路通过真实本地WebSocket双向协议集成测试，但没有连接生产GSCore做端到端消息发送。
- 插件重载需要用户有已安装插件和QQ在线；接口做状态校验，未对每个第三方插件做兼容性承诺。
- Windows/macOS及Linux ARM64真实运行时不在此次验收范围。
