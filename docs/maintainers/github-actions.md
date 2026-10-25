# GitHub Actions 维护

更新日期：2026 年 10 月 25 日。本文说明仓库中工作流的职责与运行方式；实际是否通过，以对应提交的 GitHub Actions 结果为准。

## 已交给云端的工作

| 工作流 | 触发与职责 | 保留结果 |
| --- | --- | --- |
| `Extension quality` | 面向 `main` 的 PR、主线提交、手动运行；先确定影响范围，再并行执行测试与构建 | 影响计划、覆盖率摘要与 job summary；安装包须手动开启 |
| `Build and deploy documentation` | 相关文档、共享组件或网站工具变化时构建文档与 Storybook，检查类型、链接和资产；主线通过后部署 GitHub Pages | 站点部署结果；PR 只验证构建 |

扩展质量工作流由规划、测试、两条构建任务及最终汇总门禁组成。测试继续复用仓库的影响分析和严格覆盖率配置，完整架构组与受影响行为测试在同一轮中去重执行；原生 Node 夹具和 Zotero 测试保留独立检查。两条构建任务分别处理：

- 扩展：TypeScript/Vue、Chrome、Firefox、生成清单、Safari 网页产物校验，以及复用 Firefox 产物生成 Thunderbird 安装包。
- 配套出口：标准与 standalone userscript 及其校验、Zotero 构建与校验、Obsidian 构建。

运行环境固定为 Ubuntu 24.04、Node.js 22 和 `packageManager` 指定的 pnpm 9；`pnpm/action-setup@v5` 自身使用 Node.js 24，不改变构建使用的 Node.js 版本。系统迁移应单独验证后修改 runner 标签。

每个 runner 内的命令串行，测试使用单 worker；不同 runner 同时工作，减少单任务排队时间。普通 PR/push 的纯文档变化仍经过测试任务，无需重建扩展；手动运行始终执行两条构建任务，即使影响计划没有扩展变化。最终 `extension-quality` 检查所有应执行任务，不能以构建任务被意外跳过代替通过。

PR 更新会取消旧提交的检查和文档预览。主线扩展检查按 SHA 分组保留每批提交的检查，避免新的主线提交使上一批影响范围失去验证。主线文档部署不取消正在执行的任务；GitHub 仍可能用较新的提交替换同一组中尚未开始的部署。

## 免费条件与存储控制

按当前 [GitHub Actions 计费说明](https://docs.github.com/en/billing/concepts/product-billing/github-actions)，公开仓库使用标准 GitHub 托管 runner 的计算时间免费；larger runner 始终计费。这里使用标准 `ubuntu-24.04`，不申请 larger runner，也不接入付费计算服务。规则可能变化，不能承诺永久免费。

构建产物与 GitHub Packages 共用账号套餐的存储额度，超额可能收费；日志和 job summary 不占 artifact 额度。日常只上传小型 JSON，手动请求的 Chrome/Firefox 包仅保留一天，减少持续占用。短期保留能降低后续占用，不能撤销已经累计的计费用量。账号实际额度和账单须在 GitHub 的 Billing 页面核对；工作流不会修改账号预算。

pnpm 依赖缓存使用仓库独立的默认 10 GB 空间，维持该上限；达到上限后由 GitHub 淘汰旧缓存，不为提高命中率扩大付费容量。缓存不放用户配置或凭据。相关规则见 [依赖缓存限制](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#usage-limits-and-eviction-policy)。

维护者希望把新增费用限制为零时，可在 Billing 中核对 Actions 与 Actions Cache Storage 的预算，将付费预算设为 0，并启用适用的超预算停止使用设置；同时保留缓存默认上限。预算是账号设置，必须核实已应用，不能根据 YAML 推断当前已经生效。额度不足可能使 artifact 上传或其他付费使用被阻止，失败应保留在检查结果中。

## 手动检查与下载复测包

1. 打开仓库的 Actions，选择 `Extension quality`，点击 `Run workflow`，选择要验证的分支。
2. `base` 是本次影响分析的 Git 基线，默认 `HEAD^`。要验证一段改动，应填入该段改动之前的提交 SHA 或可解析的 Git ref。入口按基线至检出提交规划范围，手动运行不会自动变成全项目回归。
3. 两条构建任务都会执行。平时保持 `upload_packages=false`；需要在本机加载该提交的 Chrome/Firefox 产物复测时，显式开启 `upload_packages`。
4. 检查最后的 `extension-quality` 结果及各 job 的日志和 summary；安装包开启后，在运行页的 Artifacts 中下载，一天内完成保存与复测。下载内容是对应浏览器的未签名扩展目录，附构建提交 SHA 与 `SHA256SUMS`，解压后按开发者加载流程复测；不能视为正式商店发行版。

默认分支中存在带 `workflow_dispatch` 的工作流后，GitHub 才提供手动运行入口。尚未合入的工作流改动、本地命令通过或 YAML 校验通过，都不能写成已经在 GitHub 远端运行成功。

## 验证边界与后续选择

当前扩展质量检查运行影响范围内的确定性验证。它不会启动浏览器、请求在线翻译服务、下载私有论文语料或运行正式发版全量回归。变更影响共享测试环境时，规划器可能扩大测试范围，必须以保存的 plan 为准。

Chrome/Firefox 构建不等于浏览器实机通过；Safari 只验证网页产物，不包含 Apple 工具链、签名、iOS 或 App Store 分发；Thunderbird、Obsidian 和 Zotero 的构建也不代表对应应用内完整验收。需要真实浏览器的专项继续按 [测试与回归](../testing.md) 使用隔离 profile 和运行时诊断。

后续有明确需求时，可以增加手动的完整确定性回归，或先适配少量不依赖在线供应商的浏览器 smoke。现有可见后台窗口脚本包含 macOS 焦点保护，迁往 Linux 需独立适配和验收。避免同时保留全组测试、全量覆盖率和相同专项的重复执行，也不为消耗免费计算额度增加无用途的每日构建。商店发布自动化另按正式发版流程处理。
