# Napcat-Plus WebUI

基于 NapCat / NextNapCatWebUI 的独立增强界面，非上游官方发行版。保留原有 QQ、OneBot、插件、文件、日志、终端与调试能力；不复制或声称提供尚未核准发布的第三方聊天客户端。

## 改版内容

- 中文优先、蓝灰控制台设计，深浅双主题、系统主题初始化、手机导航抽屉、键盘焦点与减少动画支持。
- 新导航与总览仪表盘：QQ 登录阶段、GSCore 状态、服务端进程运行时长、Napcat-Plus 版本、真实诊断项目。
- 管理登录页：Token、手动 Passkey、两步验证；单个表单提交，避免全局 Enter 重复触发；不自动弹出 Passkey。
- QQ 登录状态页：扫码/快捷/密码/验证码/新设备验证保留，错误与恢复阶段内联展示；没有 QR URL 时不会绘制假二维码；轮询请求不重叠。
- GSCore 管理：真实状态、开关、WebSocket 地址、有限重试、鉴权 Token 保留/替换/清除；不回显已存 Token，清除/中断连接确认。
- 内置工具：原有消息/聊天入口，NapCat 日志/缓存的「预览→确认→执行」清理；默认收起的插件诊断和确认重载。不自动清理、不动 QQ 数据库，不开放新调试服务。
- QQ 未登录时仍可管理诊断、配置和连接，不再强制离开控制台。
- 关于页区分 Napcat-Plus 版本与上游 Core 版本，保留来源和版权说明。

## API 与数据

所有新增请求都经过现有 `serverRequest` Axios 实例；它负责 `/api` 前缀、Bearer 凭据与错误处理。调用路径不重复 `/api`。

- `GET /Console/status`
- `GET/POST /Console/gscore`
- `POST /Console/gscore/reconnect`
- `POST /Console/cleaner/preview`、`POST /Console/cleaner/execute`
- `POST /Console/plugins/reload`
- 原有 `GET /Plugin/List`、`POST /Plugin/SetStatus`

没有模拟在线状态、随机统计或伪造图表。失败刷新时不把旧状态显示为当前在线。清理预览过期或条件改变后不可执行。GSCore Token 输入为空时省略字段，明确勾选清除才发送空字符串。

## 验证

```bash
pnpm --filter napcat-webui-frontend typecheck
pnpm --filter napcat-webui-frontend test:console
pnpm --filter napcat-webui-frontend build:full
```

纯 helper 测试利用现有 TypeScript 和 Node 原生测试运行器，不引入额外 UI 或测试依赖。

### 浏览器验收建议

必须使用隔离的真实后端测试，不能把测试 Token、QQ 数据或截图凭据提交到仓库。

1. 桌面 1440×1000：管理登录、总览、QQ 等待扫码、GSCore disabled、内置工具页；分别检查浅色与深色。
2. 手机 390×844：无横向溢出、导航开关/ESC/焦点循环、登录输入、GSCore保存、清理表格横向滚动。
3. QQ 未登录：首页显示真实阶段而不是在线；日志/GSCore/工具仍可访问。
4. GSCore：未配置 Token 不显示占位凭据；空输入保持；清除有确认；错误地址和重试边界被拒绝。
5. 断开测试后端：出现 API 错误/重试，禁止把缓存状态当在线。
6. 清理：预览前不能删除，空预览不能执行，条件修改使旧预览失效，删除有不可撤销提示。
7. 插件诊断：默认收起；打开只读取列表；enable/disable/reload 均需确认。
8. OneBot、聊天、文件、插件、日志、主题、终端旧入口回归。不会代用户发送消息。

## 来源与许可

前端原始组件许可见 [LICENSE](<LICENSE>)。整个项目及 NapCat 内核另受仓库根许可和授权范围约束；前端 MIT 文件不能推导出整个项目可不受限分发或商用。

感谢 NapCat、NextNapCatWebUI、React、HeroUI 等原项目与贡献者。
