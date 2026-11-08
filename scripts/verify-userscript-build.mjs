/**
 * @file scripts/verify-userscript-build.mjs
 * 文件职责：校验 userscript 产物的元信息、资源协议、体积与兼容性运行边界。
 * 主要内容：静态断言及隔离 VM 兼容层检查；体积预算按已测量的共享功能增量调整。
 * 模块边界：只读取构建产物和本地包版本，不安装脚本、不访问外部页面或修改运行配置。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const vueVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/vue/package.json'), 'utf8')).version;
const elementPlusVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/element-plus/package.json'), 'utf8')).version;
const vueRequire = `// @require      https://cdn.jsdelivr.net/npm/vue@${vueVersion}/dist/vue.global.prod.js`;
const vueBridgeRequire = '// @require      https://cdn.jsdelivr.net/gh/FluentRead/FluentRead@184a3d74f61b9d2a8d47080787f7e0180b98414d/userscript/vueElementPlusBridge.v1.js';
const elementPlusRequire = `// @require      https://cdn.jsdelivr.net/npm/element-plus@${elementPlusVersion}/dist/index.full.min.js`;
const artifactPath = path.join(root, '.output/userscript/fluent-read.user.js');
const source = fs.readFileSync(artifactPath, 'utf8');
const artifactBytes = Buffer.byteLength(source);
// 合入 PDF 与字幕更新并修正语言资源固定提交后，本轮 UI 产物实测 1,963,242 字节；
// 相对 main 的 1,960,000 字节预算增加 4 KB，继续校验协议、体积和运行边界。
// 智能高亮的共享偏好（快捷键、开关、配色与浓度的归一化）使脚本增至 1,964,630 字节；功能本身不进入脚本。
// 为保持与扩展的配置导入导出兼容，预算再放宽 1 KB。
// 时间展示过滤与动态来源交接增加 2,939 字节：同依赖下基线 e754aa680 为 1,964,913，修复后为 1,967,852。
// 预算仅增加 3 KB，保留体积守门；独立基线与构建记录见 docs/reports/time-changing-source-20261010/。
// 失败摘要、受限局部重试及对应文案增加 7,324 字节（0.3722%）：
// 同依赖独立基线 ce36085f7 为 1,967,852，候选为 1,975,176；预算增加 8 KB。
// 实测与重现步骤见 docs/reports/reading-reliability-experience-20261010/。
// Google 合批、共享请求节奏与 429 退避增加 2,536 字节（0.1284%）：
// 同依赖独立基线 f3f6016e8 为 1,975,252，候选为 1,977,788；预算增加 3 KB。
// 实测与重现步骤见 docs/reports/google-batching-backoff-20261010/。
// 原生数组完整校验、同预算逐段恢复、实体拒收与 AI 会话隔离另增加 6 KB 预算；
// 同依赖独立基线 36952b0fe 与增量证据见 docs/reports/native-batch-translation-20261010/。
// 原生合批独立开关及冻结策略增加 2,560 字节（0.1291%）：
// 同依赖基线 e4932521f 为 1,982,807，候选为 1,985,367；预算最小增加 1 KB。
// 增量与语言固定提交验证见 docs/reports/native-batch-setting-20261011/。
// 悬浮手势按帧合并、停留调度与取消域完整清理的原始验证增加 4,576 字节（0.2305%）：
// 同依赖独立基线 fe7005dd9 为 1,985,367，候选为 1,989,943；该阶段预算最小增加 5 KB。
// 体积与生产包真实事件回归见 docs/reports/hover-reliability-20261011/。
// 20 个译文样式预设（规则、注册表与中文名称）增加 8,193 字节（0.4127%）：
// 同依赖独立基线 fe7005dd9 为 1,985,255，候选为 1,993,448；预算增加 8 KB。
// 实测与截图见 docs/reports/translation-style-presets-20261010/。
// 合并前整合 b14baf4b 的全文优化与样式预设：同依赖 main 为 1,987,953，集成后为 1,992,441。
// 增加 4,488 字节（0.2258%），保持 main 的 1,994,000 预算；证据见悬浮报告 pr-integration/。
// 区域分片、精确取消与动态选择协作在独立基线 fe7005dd9 上增加 5,222 字节（0.2630%）。
// 合入最新主线后复验体积，沿用主线预算；保留全部协议与执行边界校验。
// 原始对照与集成证据见 docs/reports/section-translation-quality-20261011/。
// 随后整合区域翻译 0a69bfc3：同依赖 main 为 1,993,179，悬浮集成产物为 1,997,758。
// 增加 4,579 字节（0.2297%），原预算余量 821 字节，按实测最小增加 4 KB；见悬浮报告 pr-integration-931/。
// 右键来源保护及通知交互的原始对照增加 3,443 字节（0.1734%）；原生菜单专属逻辑和文案按目标剔除。
// 整合区域与悬浮优化后：同依赖 main 为 1,997,714，候选为 2,001,158，预算最小增加 4 KB。
// 保留全部协议/兼容性检查；证据见 docs/reports/context-menu-experience-20261011/。
// 输入框请求取消、有限等待及富文本标准事件写回的初始验证增加 8,638 字节（0.4351%）：
// 同依赖独立基线 fe7005dd9 为 1,985,367，初始候选为 1,994,005；该阶段预算增加 9 KB。
// 原始验证及最新主线集成证据见 docs/reports/input-translation-quality-20261011/。
// PR 合并前整合 982f09df：同依赖独立 main 为 1,997,714，输入集成产物为 2,006,364。
// 增加 8,650 字节（0.4330%），按实测最小增加 9 KB 预算，余量 636 字节；见报告 pr-integration/。
// 最终整合右键与通知更新 bbae4100：同依赖 main 为 2,001,158，输入候选为 2,009,853。
// 增加 8,695 字节（0.4345%），利用主线余量后预算最小增加 8 KB，余 147 字节；见报告 pr-integration-933/。
// 安全词库摘要/同步坐标解析复用与手势、会话复验在 dc335c698 集成后增加 3,132 字节：
// 同依赖独立 main 为 2,009,853，候选为 2,012,985（0.1558%）；
// 沿用主线单一悬浮调度器；利用原余量后预算最小增加 3 KB，见 hover-translation-polish-20261011/verification.json。
// 多文字名称证据、外语否决、准确 DOM 语言副本和线性字面量保护的排版回显兜底；
// 合并前整合 e047f8bd0：同依赖独立基线为 2,013,029，最终候选为 2,024,302，增加 11,273 字节（0.5600%）。
// 相对主线 2,013,000 预算按实测最小增加 12 KB，余量 698 字节；基线本次重建超原预算 29 字节亦如实记录。
// 比较与散列见 docs/reports/target-language-quality-20261011/userscript-size.json。
// 不引入额外检测模型。
// 网站连续导航的自动意图、请求取消域和增量发现重置增加 1,399 字节（0.0691%）：
// 同依赖独立基线 25f5dca79 为 2,024,307，候选为 2,025,706；利用原余量后最小增加 1 KB。
// 保留全部协议和执行边界校验，原始与最终散列见 docs/reports/site-rules-navigation-20261011/userscript-size.json。
// 网站规则索引与生命周期通知合并的初轮产物增加 477 字节（0.0235%）：
// 同依赖上一轮正确产物 c254eb935 为 2,025,894，初轮性能候选 d74fb7cfc 为 2,026,371。
// 利用原余量后预算最小增加 1 KB；含稀疏名单失效修正的最终体积与散列见网站规则报告 performance.md。
// 最后整合 c8a06bb5f：同依赖独立 main 为 2,024,873，网站规则全部修复与优化为 2,026,916。
// 相对主线增加 2,043 字节（0.1009%）；沿用本任务的 2,027,000 预算，余 84 字节。

// 阅读依据的有限来源、真实 DOM 锚点、紧凑 UI 与可读导出增加 14,305 字节（0.7065%）：
// 同依赖干净 c8a06bb5f 为 2,024,873，最终候选为 2,039,178，原预算只余 127 字节。
// 按既有 1 KB 步长最小增加 15 KB，保留全部协议与运行断言；见 reading-evidence-20261011 报告。
// 合并 69d41e5e 最新主线后，同依赖基线 2,026,916、最终候选 2,041,173，增加 14,257 字节（0.7034%）。
// 相对主线按实测最小增加 15 KB，预算 2,042,000、余 827 字节；全部校验保持。
// 顶栏更多操作与有界菜单在上述候选上增加 1,893 字节，最终 2,043,066 字节。
// 利用原余量后按实测最小再增加 2 KB，预算 2,044,000、余 934 字节；原断言保留。
// 单篇篇章参考、完整来源证明及重挂语义复用在同依赖主线 69d41e5e1 上增加 16,503 字节（0.8142%）：
// 独立主线产物为 2,026,916，候选为 2,043,419；利用原余量后预算最小增加 17 KB，余 581 字节。
// 不增加抽取模型或远程依赖；完整对照、散列与运行边界见 discourse-context-20261011/verification.json。
// 合入 99afdbf69 后的完整候选为 2,059,784 字节，按 1 KB 步长最小预算为 2,060,000，余 216 字节。
// 同依赖独立主线为 2,043,588 字节，增加 16,196 字节（0.7925%）；主线预算只余 412 字节，最小增加 16 KB。
// 最新主线独立基线与精确增量见 reading-evidence-20261011/userscript-size.json；所有校验保留。
// 长页自有双语块的保守渲染隔离与外观/重挂清理增加 3,038 字节（0.1500%）：
// 同依赖独立基线 7cabb3678 为 2,024,762，候选 962a5d98b 为 2,027,800；
// 利用原余量后预算最小增加 3 KB，剩 200 字节。保留全部协议与执行边界检查；
// 比较与散列见 docs/reports/long-page-rendering-20261011/userscript-size.json。
// 整合主线 69d41e5e1 后，长页隔离、五条正文规则及局部扫描拥有者修复共增加 6,016 字节（0.2968%）：
// 同依赖独立 main 为 2,026,872，候选为 2,032,888；相对 main 预算按实测最小增加 6 KB。
// 保留全部协议和执行边界校验，余量 112 字节；记录见 common-site-expansion-20261011/userscript-size.json。
// 再整合滚动调度 717a34034：独立 main 为 2,026,877，最终候选为 2,032,969（增 6,092，0.3006%）；
// 沿用同一最小预算，余 31 字节；本轮最终集成散列同样记录在上述报告。
// 再整合篇章参考主线 99afdbf69：同依赖独立 main 为 2,043,424，网站/长页候选为 2,049,560。
// 增加 6,136 字节（0.3003%），利用主线余量后预算按实测最小增加 6 KB，余 440 字节；
// 保留全部协议与执行边界校验，原始及最终对照见 common-site-expansion-20261011/userscript-size.json。
// 合入 43f66b01d 并将原文依据缩为信息图标后，同依赖独立 main 为 2,049,516 字节，候选为 2,065,676。
// 增加 16,160 字节（0.7885%）；主线 2,050,000 预算余 484 字节，按实测最小增加 16 KB，余 324 字节。
// 完整对照见 reading-evidence-20261011/userscript-size.json，所有协议与执行边界断言保留。
// 引文提示整合 11860f3f2：同依赖独立 main 为 2,047,876 字节，候选为 2,064,141；沿用预算，余 1,859。
// 豆包实验线路：同依赖独立主线 1e414ea8c 为 2,064,354 字节，完整匿名协议候选为 2,072,803。
// 增加 8,449 字节（0.4093%）；利用原余量后按既有 1 KB 步长最小增加 7 KB，余 197 字节。
// 全部协议与执行边界断言保留；对照与散列见 doubao-web-free-957-20261011/userscript-size.json。
// 整合 f9cf3fcb2 后，同依赖独立主线为 2,065,321，最终候选为 2,073,858（增 8,537，0.4133%）。
// 按同一 1 KB 步长最小再增 1 KB，余 142 字节；保持全部执行断言，完整前后对照见同一报告。
// 真实请求租约、免费备用链与实际模型限额修复：同依赖独立 ec6d1136e 为 2,064,692 字节，
// 候选为 2,066,187，增加 1,495 字节（0.0724%）；超原预算 187 字节，按既有步长最小增加 1 KB。
// 余量 813 字节，全部协议与运行断言保留；散列和重现方式见 docs/reports/ollama-concurrency-20261011/userscript-size.json。
// 合入文档翻译主线 f9cf3fcb2 后：同依赖 main 为 2,065,321 字节，最终候选为 2,067,193。
// 增加 1,872 字节（0.0906%）；相对 main 的 2,066,000 预算最小增加 2 KB，余 807 字节。
// 补齐其他免费线路的错误/取消正文结算后为 2,067,868 字节：相对同一 main 增加 2,547（0.1233%）。
// 继续使用相同最小预算，余 132 字节；报告保留正文补修前与最终候选的独立散列。
// 初始与最终集成基线均记录于同一报告；所有协议、资源和执行断言保留。
// 再整合豆包主线 a86180163：同依赖 main 为 2,073,858，含全部请求/正文/SSE 结算修复的候选为 2,076,455。
// 增加 2,597 字节（0.1252%）；相对 main 预算按既有步长最小增加 3 KB，余 545 字节。
// 最终基线、候选散列与之前集成数据保存在同一并发报告，全部原有断言保留。
// 局部左键划选、逐块高亮和多区域共享派发增加 6,055 字节（0.2919%）：
// 同依赖独立主线 573890c33 为 2,074,383，候选为 2,080,438；
// 利用原余量后按既有 1 KB 步长最小增加 4 KB，余 562 字节，保留所有资源与执行校验。
// 五种已发布远程词典保持原摘要；新划选文案随注册补齐。对照见 section-sweep-selection-20261014/userscript-size.json。
// PR #971 的 flex/grid 原文槽判定：同依赖独立主线 525108e86 为 2,080,966 字节，
// 集成产物为 2,081,039，增加 73 字节（0.0035%）；预算增加 100 字节，余 61 字节。
// DeepLX 直连、UTF-16 分块、匿名 transport 与固定语言资源兼容文案增加 13,325 字节（0.6403%）：
// 同依赖独立主线 e806feff0 为 2,081,039，最终候选为 2,094,364；主线预算余 61 字节，
// 在主线 2,081,100 预算上按既有 1 KB 步长最小增加 14 KB，余 736 字节，全部原校验保留。
// 构建日志、前后产物与散列见工作区 research/deeplx-direct-968-20261014/userscript-size/。
// 阅读语言预检：同依赖独立 main 0fef0669 为 2,092,304 字节，候选为 2,099,247，增加 6,943（0.332%）。
// 原预算余 2,796，按既有 1 KB 步长最小增加 5 KB；保留协议、资源和 VM 运行断言，余量 853 字节。
// 即时显示模式切换：同依赖独立 main 391499398 为 2,099,247，候选为 2,101,020，增加 1,773（0.0845%）。
// 利用原余量 853 后按既有 1 KB 步长最小增加 1 KB，余 80；全部协议、资源及 VM 校验保留。
// 构建环境与产物散列见 docs/reports/popup-display-mode-20261018/userscript-size.json。
// man7 手册的可恢复正文分段：同依赖独立 main 5a362c671 为 2,101,032 字节，
// 候选为 2,106,163，增加 5,131（0.2442%）；按既有 1 KB 步长最小增加 6 KB，余 937。
// 保留全部协议、资源和 VM 校验；构建对照与散列见 docs/reports/man7-pre-translation-20261021/userscript-size.json。
// 保存局部翻译区域与完整本地化：合入主线后，同依赖独立基线 0a7728d61 为 2,104,733，
// 候选为 2,124,262 字节，增加 19,529（0.9279%），未新增依赖；范围校验、唯一定位和队列复用共享实现。
// 利用主线预算 2,107,100 的余量后，按既有 1 KB 步长最小增加 18 KB，余 838；全部协议、资源及 VM 校验保留。
// 构建对照与散列见 docs/reports/section-rules-1044-20261022/userscript-size.json。
// 阅读生命周期修复：同依赖独立主线 0ad3d431 为 2,124,326 字节，候选为 2,126,170，
// 净增 1,844（0.0868%）；无新增依赖，涵盖语言边界、等待取消和动态扫描。
// 利用原余量后按既有 1 KB 步长最小增加 2 KB，余 930 字节；全部协议、资源及 VM 断言保留。
// 构建对照与散列见 docs/reports/reading-consistency-20261023/userscript-size.json。
// 发布审计整合已进一步缩小产物，继续使用审计开始时的原上限，不沿用上游增加的 2 KB 余量。
const MAX_USERSCRIPT_BYTES = 2_125_100;
const preludeStartMarker = '/* FluentRead userscript compatibility prelude:start */';
const preludeEndMarker = '/* FluentRead userscript compatibility prelude:end */';
const preludeStart = source.indexOf(preludeStartMarker);
const preludeEnd = source.indexOf(preludeEndMarker, preludeStart) + preludeEndMarker.length;
const bootstrapStart = source.indexOf('globalThis.__FLUENTREAD_ICON_DATA__=');
const guardStartMarker = '/* FluentRead userscript execution guard:start */';
const guardEndMarker = '/* FluentRead userscript execution guard:end */';
const guardStart = source.indexOf(guardStartMarker);
const guardCondition = source.indexOf('if (!globalThis.__fluentReadUserscriptBootstrapped) {', guardStart);
const guardEnd = source.indexOf(guardEndMarker, guardCondition);

const assertions = [
  [source.startsWith('// ==UserScript==\n'), 'metadata header must be the first bytes'],
  [source.includes(`// @version      ${packageJson.userscriptVersion}`), 'metadata must use userscriptVersion'],
  [source.includes(`流畅阅读 V${packageJson.version} · Userscript V${packageJson.userscriptVersion}`), 'settings must distinguish the localized product and userscript versions'],
  [source.includes('// @grant        GM_xmlhttpRequest'), 'GM_xmlhttpRequest grant is required'],
  [source.includes('// @grant        GM.getValue') && source.includes('// @grant        GM.setValue'), 'Safari GM storage grants are required'],
  [source.includes('// @grant        GM.xmlHttpRequest'), 'Safari GM request grant is required'],
  [source.includes('// @inject-into  content'), 'Safari GM APIs require content-world injection'],
  [source.includes('// @connect      *'), 'provider requests require @connect'],
  [source.includes(vueRequire), 'pinned Vue @require is missing'],
  [source.includes(vueBridgeRequire), 'pinned Vue / Element Plus UMD bridge @require is missing'],
  [!source.includes('FluentRead/FluentRead@main/userscript/'), 'userscript resources must use an immutable commit'],
  [source.includes(elementPlusRequire), 'pinned Element Plus @require is missing'],
  [source.indexOf(vueRequire) < source.indexOf(vueBridgeRequire)
    && source.indexOf(vueBridgeRequire) < source.indexOf(elementPlusRequire), 'Vue bridge must load between Vue and Element Plus'],
  [source.includes('// @require      https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako_inflate.min.js'), 'pako fallback @require is missing'],
  [source.includes('globalThis.__fluentReadUserscriptCssCompressed='), 'userscript CSS must be compressed'],
  [source.includes('__FLUENTREAD_BROWSER_CAPABILITY_BUILD__:userscript:mv2__'), 'userscript browser capability marker is missing'],
  [artifactBytes <= MAX_USERSCRIPT_BYTES,
    `artifact is ${artifactBytes.toLocaleString()} bytes; ${Math.max(0, artifactBytes - MAX_USERSCRIPT_BYTES).toLocaleString()} bytes over the ${MAX_USERSCRIPT_BYTES.toLocaleString()}-byte size budget`],
  [!/(^|[^\w])import\s*\(/u.test(source), 'the artifact must not contain runtime dynamic imports'],
  [!/\bglobalThis\s*(?:\.\s*(?:browser|chrome)\b|\[\s*['"](?:browser|chrome)['"]\s*\])/u.test(source), 'privileged browser shims must stay lexical'],
  [source.split('// ==UserScript==').length === 2, 'metadata header must occur exactly once'],
  [preludeStart >= 0 && preludeEnd > preludeStart, 'compatibility prelude markers are missing'],
  [guardStart >= 0 && guardCondition > guardStart && preludeStart > guardCondition && guardEnd > bootstrapStart, 'complete runtime must be inside the duplicate-injection guard'],
  [source.split(guardStartMarker).length === 2 && source.split(guardEndMarker).length === 2, 'execution guard markers must occur exactly once'],
  [bootstrapStart > preludeEnd, 'compatibility prelude must run before the artifact bootstrap and IIFE'],
  [source.length > 10_000, 'artifact is unexpectedly small'],
  [!source.includes('fluent-read-area-translator-container'), 'area translator must be excluded from userscript'],
  [!source.includes('fluent-read-image-translation-root'), 'image translator must be excluded from userscript'],
  [!source.includes('fluent-read-video-subtitle-style'), 'video subtitle runtime must be excluded from userscript'],
  [!source.includes('onnx-community/Qwen3-0.6B-ONNX') && !source.includes('onnx-community/Qwen2.5-0.5B'), 'highlight model artifacts must be excluded from userscript while retaining preference compatibility'],
  [!source.includes('90ad34e62bb47572a06e0235696076976d59e9fcf5ab173d9a44689ba01b7d52') && !source.includes('8a04114ba59cc42b47d804d35d1d5c61d746ae4634f41f796768c6e302d39b9e'), 'highlight artifact manifests must be removed when only model preferences are used'],
  [!source.includes('fluent-read-writing-assistant'), 'writing assistant runtime must be excluded from userscript'],
  [!source.includes('fluent-read-vocabulary-reencounter'), 'vocabulary reencounter runtime must be excluded from userscript'],
  [!source.includes('fluent-read-sentence-actions'), 'sentence actions runtime must be excluded from userscript'],
  [!source.includes('fluent:prefill'), 'page-driven New API config bridge must be excluded from userscript'],
  [!source.includes('CHROME_TRANSLATE_OFFSCREEN'), 'Chrome offscreen translator must be excluded from userscript'],
  [!source.includes('FLUENT_READ_OFFSCREEN_READY'), 'extension Offscreen client must be excluded from userscript'],
  [!source.includes('fluent-read-background-dom-runtime'), 'Firefox background DOM host must be excluded from userscript'],
  [!source.includes('LOCAL_TRANSLATION_TRANSLATE'), 'local translation Offscreen transport must be excluded from userscript'],
];

const failure = assertions.find(([passed]) => !passed);
if (failure) throw new Error(`Userscript verification failed: ${failure[1]}`);

const context = vm.createContext({});
vm.runInContext(`
  globalThis.browser = {sentinel: 'page-browser'};
  globalThis.chrome = {sentinel: 'page-chrome'};
  delete Object.fromEntries;
  delete Promise.allSettled;
  delete Array.prototype.flatMap;
`, context);
vm.runInContext(source.slice(preludeStart, preludeEnd), context);

const runtimeAssertions = [
  [vm.runInContext(`JSON.stringify(Object.fromEntries([['first', 1], ['second', 2]]))`, context) === '{"first":1,"second":2}', 'Object.fromEntries polyfill failed'],
  [vm.runInContext(`JSON.stringify([1, , 3].flatMap(function (value, index) { return [value, index]; }))`, context) === '[1,0,3,2]', 'Array.prototype.flatMap polyfill failed'],
  [vm.runInContext(`Object.getOwnPropertyDescriptor(Object, 'fromEntries').enumerable === false`, context), 'Object.fromEntries polyfill must be non-enumerable'],
  [vm.runInContext(`Object.getOwnPropertyDescriptor(Promise, 'allSettled').enumerable === false`, context), 'Promise.allSettled polyfill must be non-enumerable'],
  [vm.runInContext(`Object.getOwnPropertyDescriptor(Array.prototype, 'flatMap').enumerable === false`, context), 'Array.prototype.flatMap polyfill must be non-enumerable'],
  [vm.runInContext(`globalThis.browser.sentinel === 'page-browser' && globalThis.chrome.sentinel === 'page-chrome'`, context), 'compatibility prelude must not replace page globals'],
];
const settled = await vm.runInContext(`
  Promise.allSettled([Promise.resolve('ok'), Promise.reject('failed')]).then(function (values) {
    return JSON.stringify(values);
  })
`, context);
runtimeAssertions.push([
  settled === '[{"status":"fulfilled","value":"ok"},{"status":"rejected","reason":"failed"}]',
  'Promise.allSettled polyfill failed',
]);

const runtimeFailure = runtimeAssertions.find(([passed]) => !passed);
if (runtimeFailure) throw new Error(`Userscript compatibility verification failed: ${runtimeFailure[1]}`);

console.log(`Verified ${path.relative(root, artifactPath)} (${artifactBytes.toLocaleString()} bytes)`);
