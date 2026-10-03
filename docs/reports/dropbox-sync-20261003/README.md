# Dropbox 配置同步交付验证

日期：2026-10-03；集成基线：`87320918af047043770ddc728eeec669e2590dd7`。

代码把 Dropbox 接入 Google Drive / WebDAV 共用的云备份入口、预览与事务，不改变已有供应商的配置记录。未借用参考仓库代码。

## 确定性验证

- `pnpm test:cloud-backup`：14 个文件、62 项测试通过；Google Drive、Dropbox 与 WebDAV 共用事务及新增 Dropbox 模块 statements / branches / functions / lines 均为 100%。WebDAV HTTP 夹具在本机回环地址运行。
- i18n 56 项、源文件说明 751 项、用户脚本资源 9 项、manifest contract 18 项、预览模型 3 项通过。
- `pnpm compile`、Chrome / Firefox 构建、manifest verifier、`pnpm docs:typecheck`、`pnpm docs:build`、`pnpm docs:check`、`pnpm test:audit` 通过。静态文档校验 77 页、4005 链接、749 锚点、99 图片。
- 用户脚本构建和 verifier 通过：1,871,503 bytes，门禁 1,950,000。语言资源固定到首次包含对应哈希文件的 `5f9dc063` 提交。
- 复用同锁文件的本机依赖用于验证，不是 clean install 证据；没有运行全量产品回归。

## 隔离真实界面

- 临时 Edge，第二屏可见且不抢焦点。使用真实扩展配置存储和后台事务，Dropbox OAuth / HTTP 是虚构响应，账号为 example.invalid。
- 配置公开夹具 App key 的构建：22 项检查通过，覆盖保存、恢复凭据、不同存储方式记录隔离、换号取消、脱敏差异、错误、英文和 390px 布局。教程图片来自该界面，截图时结束动画。
- 默认无 App key 的构建：5 项检查通过，没有误导性同步按钮，不访问 Dropbox，提示随中英文切换且不暴露资源 key。
- 报告记录 launch mode、focus policy、window placement。没有使用日常浏览器 profile 或真实账号。

## 已有审计失败

`verificationOwnership` 的 2 项失败在上述 origin/main 的独立源码快照也复现，均非本次新增路径：

- 未登记验证归属的脚本：`scripts/capture-docs-ui.cjs`、`scripts/verify-brand-copy.mjs`、`scripts/verify-docs-build.mjs`。
- 未纳入 strict coverage 的 8 个模块：`src/core/config/shareCard.ts`、`src/core/i18n/messages/siteRules.ts`、`src/features/full-page-translation/content/excerpt.ts`、`src/features/share-card/content/runtime.ts`、`src/features/share-card/core.ts`、`src/features/share-card/export.ts`、`src/features/share-card/render.ts`、`src/features/share-card/themes.ts`。

## 发布边界

没有真实 Dropbox App key：默认包未启用 Dropbox。真实 OAuth、跨设备和生产访问审批没有验证。维护者按公开中英文教程配置 App folder、四项 scope、精确回调和 `WXT_DROPBOX_APP_KEY` 后，仍需真实账号联调和 Dropbox 生产审批。临时授权采用 session storage，不提供用户口令输入；固定公开应用口令的保护边界已在隐私政策说明。
