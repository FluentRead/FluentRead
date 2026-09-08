# 新增开源翻译服务验证记录

基础提交：`76df201`。新增 Apertium 和 LibreTranslate，现有默认服务和四路后备顺序不变。实现依据各项目公开 API 文档独立完成，未借用或修改参考仓库。

## 验证结果

- 新增适配器、文本结构助手及免费配置/编排的专项覆盖率四维均为 100%。
- 类型检查、架构测试（890 项）、测试审计、Chrome、Firefox、userscript/verifier 与文档构建通过。
- 新增协议、后备与 broker 专项 180 项通过。
- 完整测试 5,347 项通过、1 项失败：图片翻译默认开关断言失败已在未修改基础提交复现。未改动其默认值或测试。完整覆盖率运行还出现一次解压大文档测试的 5 秒超时；普通测试及基础提交复测通过。
- 生产 Edge 服务目录专项通过分类、搜索、配置说明、LibreTranslate 实例地址重开保留、可选密钥入口；820/390px 无横向溢出，控制台错误 0。
- launchMode: `macos-background-cdp`；focusPolicy: `launchservices-no-foreground`；windowPlacement.mode: `background-visible-no-focus`；browserFrontmost: `false`。临时 profile，第二显示器，不访问日常浏览器页面。
- 旧完整 UI 技能脚本查找旧 Popup 标题而超时，未计为通过。Firefox 与 userscript 只验证构建，不代表运行时 UI 通过。

## 证据边界

Apertium 官方 GET 和适配器使用的 POST 纯文本协议，均以公开示例 `Hello world.`、`eng|spa` 实测返回 HTTP 200 和 `Hola Mundo.`。不代表所有地区、时间和语言对都可用。

LibreTranslate 使用模拟 HTTP 响应验证 JSON 协议、简繁代码、错误、可选密钥和冻结配置，没有实际用户实例的可用性证明。Lingva 官方与多个公共实例在本环境返回 403/TLS 失败，故未接入。

本次临时浏览器证据目录：`/private/tmp/fluentread-free-service-ui/`，含 `report.json`、Apertium/LibreTranslate 设置截图和窄屏截图。
