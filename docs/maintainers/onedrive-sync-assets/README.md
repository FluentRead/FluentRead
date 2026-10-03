# OneDrive 教程图片来源

采集及标注日期：2026-10-03。图片用于字段位置教学，不是 FluentRead 当前微软账号的操作记录。

| 文件 | 官方来源 |
| --- | --- |
| register-app-official.png / register-app-annotated.png | [Microsoft Graph 注册应用教程](https://learn.microsoft.com/en-us/graph/auth-register-app-v2)，[原图](https://learn.microsoft.com/en-us/graph/images/quickstart-register-app/portal-02-app-reg-01.png) |
| overview-official.png / overview-annotated.png | 同一教程，[原图](https://learn.microsoft.com/en-us/graph/images/quickstart-register-app/portal-03-app-reg-02.png) |
| platform-official.png / platform-annotated.png | 同一教程，[原图](https://learn.microsoft.com/en-us/graph/images/quickstart-register-app/portal-04-app-reg-03-platform-config.png) |
| delegated-official.png | [Microsoft Teams 的 Graph 权限设置说明](https://learn.microsoft.com/en-us/microsoftteams/platform/tabs/how-to/authentication/tab-sso-graph-api)，[原图](https://learn.microsoft.com/en-us/microsoftteams/platform/assets/images/authentication/teams-sso-tabs/delegated-permission.png) |

原图保留微软示例内容。annotated 文件通过 imagegen 加中文注释、编号、红框及箭头，逐张检查字段指向：注册第 3 种账号类型、Application (client) ID、Authentication、API permissions、SPA。标注图是教学示意，完整原图用于核对文字和示例值。不要从示例图复制 UUID、租户、应用名或默认选择。

使用的标注要求：保留原始 UI 结构与字段；不伪造已填写、已选择或已通过授权的状态；新增白色边缘区域放置中文提示；红框与箭头指出真实操作位置。注册图提醒先留空回调，平台图选择 SPA，概览图明确 Client ID 与 Tenant ID 的区别。
