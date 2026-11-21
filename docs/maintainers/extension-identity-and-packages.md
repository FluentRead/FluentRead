# FluentRead 扩展身份和安装包说明

## 背景

你这次做的是：把新版流畅阅读安装进浏览器，希望它更新旧版本，并继续使用原来的配置和 Google 同步。

这件事涉及两套识别规则。**浏览器要识别“这是哪一个已安装的扩展”，Google 要识别“这是哪一个登记过的应用”。** 本次问题出在两边使用的身份没有对齐：新安装的扩展换了编号，Google 客户端却仍然对应旧编号。

这里说的“保留 `key`”，是让离线安装继续使用原来的扩展编号。这个 `key` 是公开公钥，可以随安装包发布；它与翻译服务的 API Key、Google 登录密码和访问令牌有不同用途。

本文以 2026 年 10 月 14 日的修复为例，说明扩展身份、Google 授权配置和统一 Chrome ZIP 的关系。

## 浏览器如何识别同一个扩展

扩展有名称、版本号和扩展 ID，三者负责不同的事情。

| 信息 | 例子 | 用途 |
| --- | --- | --- |
| 名称 | 流畅阅读 | 让人识别产品，可以与另一份安装相同 |
| 版本号 | `0.0.37` | 区分代码版本，更新时可以改变 |
| 扩展 ID | `djnlaiohfaaifbibleebjggkghlmcpcj` | 浏览器中的安装身份，是判断是否为同一个扩展的重要依据 |

所以，两份扩展即使都显示“流畅阅读”，甚至版本号相同，只要 ID 不同，浏览器仍会把它们当成两份安装。

你看到的两个编号是：

```text
旧安装：djnlaiohfaaifbibleebjggkghlmcpcj
新安装：aakdnohjinpalkgcdkjpbbfbkieohfce
```

这两个编号不同，解释了为什么出现两个版本，也解释了为什么新版本没有自动沿用旧版本的数据。扩展存储按安装身份隔离，修改安装包不会自动把两份数据合并。[Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)

## manifest 和 key 是什么

### manifest 是扩展的安装清单

每个安装包中都有一个 `manifest.json`。它告诉浏览器扩展叫什么、版本是多少、需要哪些权限、后台脚本在哪里，以及本例中的 Google 应用配置。

`manifest` 是“清单”的英文。`key` 则是清单中的一个字段名，并不是要求用户输入的密码。

下面只是字段示意，公钥位置使用了说明文字，不能直接拿这段 JSON 安装扩展：

```json
{
  "manifest_version": 3,
  "name": "流畅阅读",
  "version": "0.0.37",
  "key": "这里应是完整的扩展公开公钥",
  "oauth2": {
    "client_id": "这里应是对应的 Google OAuth 客户端 ID",
    "scopes": ["https://www.googleapis.com/auth/drive.appdata"]
  }
}
```

真实的 FluentRead Chrome 构建已经自动填入完整公钥和客户端 ID，普通用户不需要手动填写这些字段。

### key 中保存的是扩展公钥

Chrome 提供 `manifest.key`，用来让开发或离线加载的扩展保持固定 ID。官方做法是取得已有商店条目的公钥，将它放进清单，再核对本地 ID 与商店条目的 ID 一致。[Chrome 公钥说明](https://developer.chrome.com/docs/extensions/reference/manifest/key)

本例中的关系是：

```text
原有 FluentRead 的公开公钥
          ↓ 浏览器计算
djnlaiohfaaifbibleebjggkghlmcpcj
```

在使用公钥确定身份的安装中，同一公钥对应同一 ID；换一把公钥则会得到另一个 ID。不能随便生成一把新公钥，再期待它对应旧编号。[Chromium ID 计算实现](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/crx_file/id_util.cc)

对于没有公钥的普通开发加载，Chromium 通常改用加载目录的路径计算 ID。换目录就可能换 ID，因此不能把它简单理解为“浏览器随机取了个编号”，也不是 ZIP 文件名决定了编号。[Chromium 扩展身份实现](https://github.com/chromium/chromium/blob/main/extensions/common/extension.cc)

### 公钥和私钥的区别

公钥可以公开。私钥用于签署自行打包的 CRX，需要保密。CRX 是带签名的扩展安装格式；ZIP 是文件压缩包，两者的用途不同。[Chrome CRX 打包说明](https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux)

保留 `manifest.key` 只是保留公开的身份材料，不会把签名私钥放进扩展，也不等于获得商店发布权限。公开公钥本身不能证明任意来源的 ZIP 都由官方发布；安装包仍应从可信来源取得。

## Google 同步如何识别扩展

### 扩展 ID 和 Google 客户端 ID 是两个编号

维护者在 Google Cloud 中为 FluentRead 创建一个 **Chrome 扩展类型的 OAuth 客户端**。OAuth 是让用户同意应用访问指定数据的授权机制。

创建这个客户端时，需要把扩展 ID 填进 Google 控制台的 **Item ID**。Google 随后生成另一个编号，叫 **OAuth Client ID**，代码将它写进 `oauth2.client_id`。[Chrome OAuth 配置教程](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth)

FluentRead 当前代码使用的默认配对是：

```text
Chrome 扩展 ID
djnlaiohfaaifbibleebjggkghlmcpcj

Google OAuth Client ID
474699705334-7fua4hnkq1nmfu92cof0kdnmqsk5kth8.apps.googleusercontent.com
```

第一个编号让浏览器识别扩展；第二个编号让 Google 识别应用的授权配置。两者不是同一个字符串，但需要正确对应。改变本地公钥或安装目录，不会自动替你修改 Google 控制台的登记。

### 身份匹配之后还需要用户授权

Client ID 是公开的应用编号，不是读取云盘的通行凭据。每位用户还需要登录自己的 Google 账号并同意授权，Chrome 才能为应用取得访问令牌，也叫 **access token**。扩展通过令牌访问被允许的数据。[Chrome Identity API](https://developer.chrome.com/docs/extensions/reference/api/identity)

FluentRead 申请的是 `drive.appdata`，用于自己的隐藏应用数据区，配置备份保存在这里。这与读取用户全部云盘文件的权限不同。[Google Drive 应用数据区](https://developers.google.com/workspace/drive/api/guides/appdata)

这条流程可以按下面的顺序理解：

```text
扩展公钥确定本地扩展 ID
          ↓
实际 ID 与默认 Google 客户端的登记对应
          ↓
用户登录 Google 并同意所请求的权限
          ↓
取得访问令牌
          ↓
在授权范围内读取或保存配置备份
```

公钥负责保持本地身份，Client ID 指向 Google 应用配置，用户授权和令牌负责数据访问。因此，“ID 对齐了”不等于“已经登录 Google”，也不等于“云端同步已经成功”。

## 这次为何出现两个版本

此前的打包流程对 Chrome ZIP 做了一步处理：删除 `manifest.key`，保留 `oauth2.client_id`。这份 ZIP 又被用于离线安装。

问题就出在这里：离线包失去了固定旧 ID 的公钥，但它里面的 Google 客户端仍是原来的客户端。

| 环节 | 实际发生的事 |
| --- | --- |
| 本地构建目录 | 有原公钥，能保持 `djnla…` 这个旧 ID |
| 当时生成的 Chrome ZIP | 打包后删除了公钥，失去固定旧 ID 的条件 |
| 你安装 ZIP 后 | 出现了 `aakd…` 这个新 ID，浏览器将它作为另一份扩展 |
| 新扩展检查 Google 同步配置 | 实际 ID 是新编号，默认客户端对应的是旧编号，于是显示不匹配提示 |

当前实现会在请求 Google 授权之前做这个检查。这条提示是在扩展本地发现身份不匹配后显示的，不能据此推断你输错了 Google 密码、云盘损坏，或配置已经丢失。

所以本次修复要恢复离线包的固定身份，而不是关掉身份检查，也不是让每个普通用户去创建新的 Google 客户端。

## 一个 Chrome ZIP 如何用于两种场景

当前打包流程只生成一个 Chrome ZIP，离线加载和 Chrome 商店既有条目的上传准备使用同一个文件。

| 修复后的产物 | 使用场景 | 是否保留 `manifest.key` |
| --- | --- | --- |
| `.output/chrome-mv3` 目录 | 开发加载、本地验证 | 保留 |
| `fluent-read-0.0.37-chrome.zip` | 解压后离线安装；向 Chrome 商店既有条目准备上传更新 | 保留，让本地安装沿用旧 ID |

**离线包需要自己带上固定身份的材料。** 它没有经过商店分发的签名流程，浏览器开发加载时需要通过清单中的公钥保持原 ID。

**商店发布则通过既有条目和商店打包流程维护身份。** 维护者应在原条目中提交更新并提高版本号，而不是新建一个同名条目。商店更新流程与用户手动加载 ZIP 是两条路线。[Chrome 商店更新说明](https://developer.chrome.com/docs/webstore/update)

这里也需要纠正一个容易造成误解的说法：**保留公钥不是商店上传禁令，不能把“所有 ZIP 都必须删除 key”当成通用规则。** Chrome 的公钥指南明确支持在本地加载清单中保留公钥；当前商店准备指南也没有要求删除这个字段。本项目统一 Chrome ZIP，让两个场景使用同一份保留公钥的产物。[Chrome 商店上传准备](https://developer.chrome.com/docs/webstore/prepare)

`pnpm zip` 保留原 `manifest.key`、固定扩展 ID 和 Google OAuth 配置，只生成 `-chrome.zip`，不再生成 `-chrome-store.zip`。普通用户用它离线安装；维护者用同一文件准备向原 Chrome 商店条目提交更新。

如果输出目录中还留有同版本的旧 `-chrome-store.zip`，本次打包会自动清理，避免继续拿错包。其他版本或其他目录中的历史包、已经发布的旧文件和浏览器里重复安装的数据不会自动修复；历史包需要重新打包或下载正确的修复包，扩展数据仍按下文步骤备份与迁移。

Edge 商店使用 `pnpm zip:edge` 生成的独立无 `key` 包，不使用这份 Chrome ZIP 替代。Firefox 的安装包与审核源码包仍按原流程生成。

## 各种 key 和凭据的区别

| 名词 | 用途 | 是否可以公开 |
| --- | --- | --- |
| 扩展 ID | 浏览器中的安装身份 | 可以 |
| `manifest.key` 中的扩展公钥 | 固定开发或离线安装的 ID | 可以 |
| 扩展签名私钥 | 签署自行发布的 CRX | 不可以 |
| OAuth Client ID | Google 登记的应用编号 | 可以 |
| OAuth Client Secret | 某些 OAuth 客户端类型使用的秘密凭据 | 不可以；本例 Chrome 原生扩展路线不需要将它放进扩展 |
| Google access token | 用户授权后访问 Google 数据的令牌 | 不可以 |
| 翻译服务 API Key | 连接用户配置的翻译服务 | 不可以；与固定扩展 ID 无关 |

配置备份的加密也属于另一条机制。`manifest.key` 不负责加密备份内容，也不是用户的备份解密口令；相关流程见 [Google Drive 配置同步教程](./google-drive-sync-guide.md)。

## 更新时如何保留数据

如果旧版本也是离线安装，先导出需要保留的数据，再将修复包解压覆盖到原安装目录，回到扩展管理页点击“重新加载”。保留原目录的备份，并核对 ID 仍为 `djnlaiohfaaifbibleebjggkghlmcpcj`。

这一步还要看旧安装的 ID。如果旧离线版本本来就使用另一个编号，切换到固定的官方 ID 后，数据不会自动跟过来；应先备份，再在正确 ID 的版本中导入。覆盖同一目录本身不能代替这项数据迁移。

如果旧版本来自商店，优先通过原商店条目更新。保持同一 ID 是正确更新的重要条件，但不能单凭公钥就保证任何手动包都能替换商店安装；安装来源、浏览器设置与管理策略还会影响加载行为。

如果已经出现两份扩展，先停用新出现的 `aakd…` 那份，从旧版本导出备份；如果新版本里也有需要保留的数据，应分别备份。确认正确版本的数据和功能正常后，再决定是否移除多余安装。卸载会清除 `storage.local`，因此不要先卸载唯一保存完整数据的版本。

拖入新 ZIP 可能触发重新解压或另一份安装，不能仅凭名称、版本号相同就认为它一定覆盖。离线更新的具体步骤见 [离线下载与安装](../guide/offline-install.md)。

## 当前修复和验证范围

使用包含统一打包修改的代码运行 `pnpm zip`，会生成一份保留原公钥和 OAuth 配置的 Chrome ZIP，并清理输出目录中同版本的旧 Chrome 商店 ZIP。其他历史 ZIP 的内容不会自动改变，已经重复安装的数据也不会自动合并。

此前扩展身份修复的真实 Chrome 155 隔离验证确认：从两份不同解压目录先后加载保留公钥的修复包时，仍只有一份旧 ID 的扩展，安装路径确实切换，保存的 190 项配置和测试存储标记保留，重新加载后也一致。Google 只读状态检查返回“可用”，没有 ID 不匹配提示。

这些是此前身份修复的验证结果，不能扩写为本轮统一打包修改的新浏览器实测。那次检查没有登录真实 Google 账号或上传云端配置，也没有确认原生 ZIP 拖拽及商店版覆盖；本轮也未验证 Chrome 商店服务端接收或发布。已有结果证明了所测包的本地身份与更新数据保留，不能替代你当前浏览器中的最终恢复结果。

## 维护者核对位置

| 文件 | 可以核对的内容 |
| --- | --- |
| `src/platform/google-drive/constants.ts` | 默认扩展 ID、公开公钥、Google 客户端 ID 和授权范围 |
| `wxt.config.ts` | Chrome 清单保留公钥、统一 Chrome ZIP 生成和同版本旧商店包清理 |
| `src/platform/google-drive/auth.ts` | 默认客户端的扩展 ID 检查与后续授权流程 |
| `scripts/testing/verify-extension-manifests.mjs` | 统一 Chrome 包的身份、清单与文件内容检查，以及同版本旧商店包残留检查 |

`docs/development/.env.example` 中的 `WXT_EXTENSION_KEY` 和 `WXT_GOOGLE_CLIENT_ID` 也是公开应用标识。默认已配置官方身份；只有维护者需要独立开发身份时才覆盖，并同时核对新扩展 ID 与新 Google 客户端的登记。不要把签名私钥、访问令牌、翻译 API Key 或 Google 密码填入这两个变量。
