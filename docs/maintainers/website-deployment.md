# 官网部署

官网使用 GitHub Pages 托管在 `https://read.thinkstu.com/`，发布源为仓库的 `docs`，无需上传到维护者自己的服务器。README 只保留项目介绍、安装和主要数据范围。

## 首次切换发布来源

1. 在仓库 **Settings → Pages → Build and deployment → Source** 中选择 **GitHub Actions**，替换原来的 **Deploy from a branch**。
2. 保留 **Custom domain** 为 `read.thinkstu.com`，保持 **Enforce HTTPS** 开启。
3. 合并文档部署工作流后，在 **Actions → Build and deploy documentation** 查看首次发布。如果首次推送发生在切换来源之前，可在该工作流中选择 **Run workflow → main** 重新运行。
4. 等待 `build`、`deploy` 两个任务成功，确认中文首页、英文首页和下列政策地址可直接打开，无需登录。

部署成功后，官网内容由 GitHub Pages 提供；旧服务器上的网站不再是发布入口。域名所有权验证与 Google OAuth 品牌审核仍需在对应平台完成，网站部署不代表审核通过。

## 日常更新

修改 `docs` 并合并到 `main` 后，工作流使用锁文件中的 pnpm 版本安装依赖，执行 `pnpm docs:build`，仅上传 `docs/.vitepress/dist`。构建失败时不会执行发布。相关 Pull Request 只构建，不部署；也可在 Actions 中手动运行 `main` 的工作流。

工作流安装依赖时跳过生命周期脚本，仅准备网站使用的 esbuild，避免运行扩展的 WXT 初始化和本地 AI 二进制下载。`docs/tsconfig.json` 独立于扩展生成的 `.wxt` 配置，官网构建不需要先构建扩展。

本地预览：

```sh
pnpm install --frozen-lockfile
pnpm docs:build
pnpm docs:preview
```

自定义域名使用根路径，VitePress 的 `base` 保持 `/`。不需要把构建文件提交到 `main`，也不需要 `gh-pages` 分支。维护文档不进入公开网站，见 VitePress 的 `srcExclude`。

GitHub Actions 发布使用仓库 Pages 设置中的 **Custom domain**。[GitHub Pages 自定义域名文档](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site#configuring-a-subdomain)

## 官方网站规则发布

官网构建与扩展发布使用同一份正文适配规则源。启用签名更新时，将 P-256 公钥的 DER SPKI 以 Base64 写入仓库公开变量 `WXT_SITE_RULES_PUBLIC_KEY`，并将配对的 PEM 私钥放入 Actions secret `FLUENTREAD_SITE_RULES_PRIVATE_KEY`。官网的签名步骤会核对配对关系，扩展发布只读公钥。私钥仅提供给主线官网构建中的签名步骤。

部署流程按本工作流的运行序号签发 `/site-rules/v1/official.json`。扩展验证签名、最低版本、规则包格式和发布序号后才替换缓存。需要回退某条规则时，将修正提交到主线并生成更高序号的发布。部署签名和扩展读取可先用一对仅用于测试的密钥验收。

## Google OAuth 使用的公开地址

| 用途 | 地址 |
| --- | --- |
| 应用首页 | `https://read.thinkstu.com/` |
| 中文隐私政策 | `https://read.thinkstu.com/guide/privacy` |
| 英文首页 | `https://read.thinkstu.com/en/` |
| 英文隐私政策 | `https://read.thinkstu.com/en/guide/privacy` |

OAuth 应用名称与官网的应用名称均使用 `FluentRead`，中文别名“流畅阅读”作为说明。提交的根首页保持固定，不按浏览器语言或旧语言偏好自动跳转；用户通过语言菜单切换中英文。

政策是公开的独立 HTML 页面；首页首屏、导航和页脚都有入口。内容与代码的数据处理范围保持一致，包括 Google 数据的访问、使用、存储、分享、保护、保留与删除。Google 的要求见[应用隐私政策说明](https://support.google.com/cloud/answer/13806988?hl=zh-Hans)；工作流采用 [VitePress](https://vitepress.dev/guide/deploy#github-pages) 与 [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) 的发布方式。

重新申请审核前，等待 `main` 发布成功，再以未登录的浏览器核对提交的首页和政策地址，确认实际内容已更新。首页应直接显示应用用途、Google 数据仅用于可选配置同步的说明和政策入口；关闭 JavaScript 时也应能阅读。若当前访问无法复现审核中报告的登录页面，保留公开响应和页面截图，向审核团队说明实际访问结果，不把部署成功当作审核通过。首页要求见 [Google 官方说明](https://support.google.com/cloud/answer/13807376?hl=en)。
