# OneDrive 同步验证记录

日期：2026-10-03。实现与教程见[OneDrive 接入指南](../../onedrive-sync-guide.md)。

## 已验证

- OneDrive、Google Drive、WebDAV 相关 67 个协议及事务测试通过；指定模块的语句、分支、函数、行覆盖率均为 100%。见 [cloud-coverage.txt](./cloud-coverage.txt) 和 [coverage-summary.json](./coverage-summary.json)。本机 HTTP 集成测试经沙箱授权运行临时服务，没有连接真实云盘。
- 84 个 i18n、扩展清单和 userscript 构建契约测试通过。另一个包含源文件头、设置页架构和仓库边界的检查组通过 800 项，失败 4 项，见下文。
- 类型检查、Chrome MV3、Firefox MV2、VitePress 文档和 userscript 生产构建通过。新文档网站静态校验通过（75 页、3819 个链接、714 个锚点、90 张图片）。扩展清单校验通过；userscript 验证见 [userscript-verifier.txt](./userscript-verifier.txt)。没有进行完整仓库回归。
- 隔离 Edge 中加载 Chrome 生产扩展，23 项断言通过，见 [browser-report.json](./browser-report.json)。使用虚构 Client ID、账号及 OAuth/Graph 响应：真实后台执行配置加密、存储、应用、历史记录与消息校验；验证保存、完整凭据恢复、换账号、取消、失败、多云记录隔离、重开不请求云盘、英文深色 390px 排版及页面无错误。
- 两张 Mermaid 图在隔离浏览器成功渲染，所有教学截图加载成功；390px 文档无横向溢出。官方门户截图、生成式箭头标注和实际扩展夹具截图在教程中明确区分。

架构检查记录来自集成 WebDAV 的提交 `9c61f14e93a258657e37375cc7e67891b7305945`。后来集成官网重构 `87320918` 仅带来文档与网站工具变化，没有修改扩展运行时；已重新构建并校验网站。最后授权错误分类变更经云备份覆盖率、类型检查、双浏览器构建及隔离界面重新验证。

## 已有架构检查失败

[architecture.txt](./architecture.txt) 中以下 4 项和原始基线 `554711ceec23b590a9bcf4fe07946c98bf6f64ff` 的结果一致，见独立干净工作树的 [baseline-architecture.txt](./baseline-architecture.txt)：

1. 文档入口额外依赖 `services/translation/errors`，违反文档入口 import 约束。
2. `src/app/content/runtime.ts` 为 282 行，超过既有 277 行上限。
3. `scripts/verify-brand-copy.mjs` 尚未登记验证归属。
4. 已有 share-card、siteRules、excerpt 等 8 个模块未纳入严格覆盖率边界。

本次新增 OneDrive 模块均已纳入严格边界，没有新增这些失败项。未修改无关实现或放宽检查。

## 仍需真实账号验收

尚未创建真实 FluentRead 微软应用，因此当前不能宣称真实 Microsoft OAuth、个人/组织 OneDrive、跨设备恢复或商店发行包已经通过验收。

按教程创建应用，提供公开 Application（client）ID，登记每个发行身份的 SPA 回调，并配置发行构建变量后，应完成教程第 9 节的真实验收。构建时未提供有效 ID 会显示未配置提示；浏览器夹具中的全 1 UUID 不能作为发行配置。

上传前、创建会话后都有版本检查，但不承诺跨设备原子事务；不要同时在两台设备确认覆盖。固定应用加密口令随源码公开，不是用户独享的秘密。
