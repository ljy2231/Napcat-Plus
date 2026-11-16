# SSQQ（Stapxs QQ Lite）集成与许可核对

核对日期：2026-11-16。

## 本次结论：不随 Napcat-Plus 内置分发

**Napcat-Plus 本次没有打包 SSQQ 的插件入口、预构建 Web 文件或第三方资源，也没有添加自动下载/复制 SSQQ 的构建步骤。**

当前使用保留的 OneBot「消息与聊天/调试」能力作为替代，前端路由为 `/debug/ws`。它不是 SSQQ，也不声称具备 SSQQ 全部客户端功能。

如确实需要 SSQQ，可选择官方独立 Web 客户端，或由用户从官方来源单独取得并手动安装插件。安装与连接需用户明确操作；不自动向外部站点传递 QQ 账号、消息、WebUI 凭据或 OneBot Token。

此决定不是说 AGPL 软件禁止分发。问题在于：**插件封装的 MIT 不覆盖主 Web 客户端；主客户端、资源和依赖存在分别适用的许可要求；与本项目受限制许可代码组合分发的边界及对应源码交付尚未完成确认。** 用户对 NapCat 的授权不能自动视作对 SSQQ 或其第三方资源的授权。

## 已确认的官方来源与版本

| 项目 | 核对结果 |
| --- | --- |
| 真正主项目 | [Stapxs/Stapxs-QQ-Lite-2.0](https://github.com/Stapxs/Stapxs-QQ-Lite-2.0) |
| 官方发布 | [v3.5.2](https://github.com/Stapxs/Stapxs-QQ-Lite-2.0/releases/tag/v3.5.2) |
| 版本标签对应提交 | [`0afd7f1ff1dee7933a1e344cce4700e05cd096d6`](https://github.com/Stapxs/Stapxs-QQ-Lite-2.0/tree/0afd7f1ff1dee7933a1e344cce4700e05cd096d6) |
| 插件身份 | `napcat-plugin-ssqq`，显示名称 `Stapxs QQ Lite` |
| 插件封装版本 | `3.5.2-3`；主客户端版本为 `3.5.2` |
| 官方发布包 | [napcat-plugin-ssqq.zip](https://github.com/Stapxs/Stapxs-QQ-Lite-2.0/releases/download/v3.5.2/napcat-plugin-ssqq.zip) |
| 发布包字节数 | `6118730` |
| 发布包 SHA-256 | `82b9ef50f7e4ddb92a07149d763f7ce98502d24ac73ce8039499b24b25df1c04` |
| 展开后文件数/总字节数 | `107` / `11337798`（约 10.81 MiB） |

官方 GitHub Release API 的 `digest` 与实际下载文件的 SHA-256 一致。对现有安装的纯插件文件进行了逐文件对照：107 个文件全部与该官方发布包相同。比较时纠正了 ZIP 中未设置 UTF-8 标志的中文文件名编码；未改动文件内容。这个对照可以证明来源一致性，**不能代替许可证合规或完整安全审计**。

两个核心文件的 SHA-256：

```text
e70ecbbb71276f95060ed67bafd39e3638620b1095b8f27a64b7d27999ddf935  package.json
b14b0d99e114df68d659292deb7572666f174bd87a4ec04119e942e62a15d431  index.mjs
```

旧项目 [Stapxs/Stapxs-QQ-Lite](https://github.com/Stapxs/Stapxs-QQ-Lite) 是已停止维护的 1.0 项目。**不能拿 1.0 的 Apache-2.0 许可证替代当前 3.5.2 主客户端的许可。**

## 许可证边界

### 1. NapCat 插件封装：MIT

[官方插件封装说明](https://github.com/Stapxs/Stapxs-QQ-Lite-2.0/blob/0afd7f1ff1dee7933a1e344cce4700e05cd096d6/ssqq.napcat-plugin/README.md)明确说明，它用于将**主应用 Web UI**打包为 NapCat 插件静态资源包。

- [插件封装 LICENSE](https://github.com/Stapxs/Stapxs-QQ-Lite-2.0/blob/0afd7f1ff1dee7933a1e344cce4700e05cd096d6/ssqq.napcat-plugin/LICENSE)：MIT。
- 其中版权声明原文为 `Copyright (C) 2026 Stapxs Steve.`。
- [插件封装 package.json](https://github.com/Stapxs/Stapxs-QQ-Lite-2.0/blob/0afd7f1ff1dee7933a1e344cce4700e05cd096d6/ssqq.napcat-plugin/package.json) 中的 `license: MIT` 与该封装目录一致。

入口仅注册静态路由与页面。MIT 声明不能扩展为对所有 `webui/dist` 中客户端和第三方资源的重新许可。

### 2. 主 Web 客户端：AGPL-3.0

- [同一提交的主项目 LICENSE](https://github.com/Stapxs/Stapxs-QQ-Lite-2.0/blob/0afd7f1ff1dee7933a1e344cce4700e05cd096d6/LICENSE)：GNU Affero General Public License v3。
- [同一提交的主项目 package.json](https://github.com/Stapxs/Stapxs-QQ-Lite-2.0/blob/0afd7f1ff1dee7933a1e344cce4700e05cd096d6/package.json) 声明 `AGPL-3.0-only`。
- LICENSE 尾部项目示例声明中包含 `or (at your option) any later version`。元数据与示例存在表述差异，当前应以至少满足 v3 的要求处理，不擅自扩大授权。
- 该许可证涉及保留许可/版权声明、对象代码的 Corresponding Source 交付，以及适用时远程交互用户取得修改版对应源码的机会。

本次已定位固定提交和官方构建包，但没有在本项目内提供该客户端的完整对应源码、子模块、依赖许可集合与构建交付链，也未认定将其嵌入受限制许可内核构成的法律边界。

### 3. 其他资源和依赖不能被忽略

[上游 `.gitmodules`](https://github.com/Stapxs/Stapxs-QQ-Lite-2.0/blob/0afd7f1ff1dee7933a1e344cce4700e05cd096d6/.gitmodules) 包含：

- Border-Card-UI：固定子模块提交 `afc93141ba2fc67a25f60045d89ac707b773fe99`；安装包内附 `bcui/LICENSE` 为 Apache-2.0。
- QFace：固定子模块提交 `8fac1fa62c16e91e3221b439ad3f9f2f5c4b1f1d`；不能因主项目许可而假定所有表情资源使用相同许可。

发布包还含 `方正喵呜体-CJKIKBn3.ttf`。本次未找到随该预构建包提供的独立字体授权文本，**未确认其可由本项目再次分发的授权范围**。

打包的依赖包括 Vue、Axios、Font Awesome、ECharts、Workbox、AI SDK 等；需按精确构建版本保留各自声明。原安装树唯一独立 `LICENSE` 文件为 `bcui/LICENSE`，因此仅复制原树再补一个 MIT 文本不足以完成公开再分发审查。

## 有限安全检查与运行行为

此次仅检查插件代码和静态文件，没有读取运行时配置目录、账号数据库、Token，也没有操作在线容器。

- 插件入口没有读取宿主配置、执行 shell 命令或自行启动服务器。
- 在 JS 资源中按常见 GitHub/OpenAI 凭据前缀、私钥头和若干私网地址模式检查，未发现匹配项。
- 官方发布包逐文件一致性核对降低了“把本机用户改写内容带入公开仓库”的风险；不代表不存在所有形式的硬编码密钥或供应链风险。
- 部分 `localhost` URL 是上游跨平台客户端代理功能的代码路径，不是本次用户的服务地址；没有据此自动改写。
- 主资源存在动态加载 `https://lib.stapxs.cn/modules/pinyin.min.js` 的代码；另有高德地图、QQ 头像、GitHub 发布检查、上游 API/公告等外部访问代码。
- 主项目官方 README 提醒构建时有默认高德地图 API Key，建议自行部署者申请自己的 Key。没有把公开构建中的默认 Key 当成本机用户凭据，也没有在文档中复制 Key 值。
- 发布包包含 Service Worker/PWA 注册、更新提示、外部公告和上游统计相关组件。是否禁用、替换或本地化需独立评估；本次未擅自改写预构建代码。
- 发布包另有 3 个 `.DS_Store`，如果未来合规重新打包应排除 OS 元数据，并重新生成哈希清单。

这些行为意味着将 SSQQ 当作“完全离线、无远程代码加载”的内置客户端介绍是不准确的。

## 可选使用方式与入口

### 默认替代

使用 Napcat-Plus 保留的 `/debug/ws` 消息与聊天/调试页面。该页面不依赖 SSQQ 资源。

### 独立部署

用户可从[官方 v3.5.2 发布页](https://github.com/Stapxs/Stapxs-QQ-Lite-2.0/releases/tag/v3.5.2)取得独立 Web 包，按[官方部署说明](https://github.com/Stapxs/Stapxs-QQ-Lite-2.0/blob/0afd7f1ff1dee7933a1e344cce4700e05cd096d6/README.md)独立部署并自行配置 OneBot 连接。

建议给独立客户端使用单独、最小权限的连接凭据；不要将 Napcat-Plus 的 WebUI 凭据拼入外部链接。

### 用户手动安装官方插件

若用户选择在自己的部署中单独安装官方插件，应保留 `napcat-plugin-ssqq` 身份。该版本入口固定为：

```text
/plugin/napcat-plugin-ssqq/page/dashboard
```

静态资源前缀：

```text
/plugin/napcat-plugin-ssqq/files/static/
```

这两个地址仅在用户已经自行安装、启用该插件后才存在；**本项目未内置 SSQQ，不能提供默认必定可用的 SSQQ 入口承诺**。不要在查询参数中添加 Token 来绕过正常登录。

## 未来若要内置分发

需要先完成以下工作，而不是单纯复制现有二进制文件：

1. 确认插件封装、主 Web 客户端、字体/图标/表情和全部运行依赖的精确来源与许可。
2. 明确与主项目的分离/组合边界及各自许可要求；必要时取得相应权利人的额外授权。
3. 交付完整、可获得的 Corresponding Source 与适用构建脚本/子模块，清晰标注修改内容，保留所有必要声明。
4. 审查和处理外部脚本、统计、地图 Key、更新/公告等行为，不能把运行用户配置写入构建产物。
5. 对最终分发文件重新生成哈希清单与版本来源记录，再接入构建复制脚本。

在完成上述工作之前，保持独立可选安装与现有聊天功能替代，不退回旧版本绕开审查，也不宣称 SSQQ 已被内置。
