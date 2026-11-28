/**
 * @file src/core/config/catalog/options.ts
 *
 * 文件职责：聚合设置界面与弹窗共用的下拉选项目录，包括翻译服务分组、语言列表、快捷键、译文样式、主题与触发方式。
 * 主要内容：导出 options 对象，将 ./services、./regions、language/catalog 与 translationAppearance 组合成完整展示选项表，保持既有的服务展示顺序、分类标签和搜索词。
 * 模块边界：仅面向需要选项列表的设置 UI 与配置校验，隔离对 language/catalog 与 translationAppearance 的依赖，避免仅引用 services 标识的模块被连带拉入样式与语言表。
 */

import {translationLanguageOptions} from '@/src/core/language/catalog';
import {buildTranslationStyleOptions} from '../translationAppearance';
import {minimaxBillingPlans, minimaxRegions, mimoBillingPlans, mimoRegions} from './regions';
import {services} from './services';

// 各翻译入口共用语言目录；具体语言对由所选翻译服务决定是否可用。
export const options = {
    minimaxBillingPlan: minimaxBillingPlans,
    minimaxRegion: minimaxRegions,
    mimoBillingPlan: mimoBillingPlans,
    mimoRegion: mimoRegions,
    on: [
        {value: true, label: "开启"},
        {value: false, label: "已关闭"},
    ],
    // 是否即时翻译
    autoTranslate: [
        {value: true, label: "开启"},
        {value: false, label: "已关闭"},
    ],
    // 是否使用缓存
    useCache: [
        {value: true, label: "开启"},
        {value: false, label: "已关闭"},
    ],
    from: [{value: "auto", label: "自动检测"}, ...translationLanguageOptions],
    // DeepSeek API 格式（仅 DeepSeek 服务显示）
    deepseekApiType: [
        {value: "auto", label: "自动（Chat Completion）"},
        {value: "responses", label: "Responses API"},
        {value: "chat", label: "Chat Completion"},
    ],
    deepseekThinkingMode: [
        {value: "disabled", label: "关闭（推荐）"},
        {value: "enabled", label: "开启"},
    ],
    to: translationLanguageOptions,
    keys: [
        {value: "none", label: "禁用快捷键"},

        {value: "Computer", label: "键盘选项", disabled: true},
        {value: "Control", label: "Ctrl"},
        {value: "Alt", label: "Alt"},
        {value: "Shift", label: "Shift"},
        {value: "Escape", label: "ESC"},
        {value: "`", label: "波浪号键"},

        {value: "mouse", label: "鼠标选项", disabled: true},
        {value: "DoubleClick", label: "鼠标双击"},
        {value: "LongPress", label: "鼠标长按"},
        {value: "MiddleClick", label: "鼠标滚轮单击"},

        {value: "touchscreen", label: "触屏设备选项", disabled: true},
        {value: "TwoFinger", label: "双指翻译"},
        {value: "ThreeFinger", label: "三指翻译"},
        {value: "FourFinger", label: "四指翻译"},
        {value: "DoubleClickScree", label: "双击翻译"},
        {value: "TripleClickScree", label: "三击翻译"},

        {value: "custom", label: "自定义快捷键"},
    ],
    // 划词翻译互斥触发方式。仅右键菜单与快捷键均不显示划词图标或小点。
    selectionTranslatorTriggers: [
        {value: "icon", label: "显示图标"},
        {value: "dot", label: "显示小点"},
        {value: "contextMenu", label: "仅右键菜单"},
        {value: "custom", label: "自定义"},
        {value: "Control", label: "Ctrl"},
        {value: "Alt", label: "Alt / Option"},
        {value: "Shift", label: "Shift"},
        {value: 'hover', label: '悬停图标'},
        {value: "direct", label: "直接弹出"},
    ],
    services: [
        // 机器翻译
        {value: "machine", label: "机器翻译", disabled: true},
        {
            value: services.freeTranslation,
            label: "免费翻译服务",
            description: "后台自动均衡可用服务；根据响应表现调整分配，失败后自动切换。",
        },
        {value: services.bilibili, label: "B站翻译", description: "官方免费文本 API，Index-Translate-35B-A3B，无需密钥"},
        {value: services.myMemory, label: "MyMemory", description: "官方免费 API，匿名每天 5,000 字符；可选邮箱提升额度。"},
        {value: services.microsoft, label: "微软翻译"},
        {value: services.google, label: "谷歌翻译"},
        {value: services.deepL, label: "DeepL"},
        {value: services.deeplx, label: "DeepLX", description: "非官方公共接口，无需密钥"},
        {value: services.xiaoniu, label: "小牛翻译"},
        {value: services.youdao, label: "有道翻译"},
        {value: services.chromeTranslator, label: "浏览器内置翻译", searchTerms: ["Chrome", "Edge", "Firefox", "Translator API", "离线翻译"]},
        {value: services.localTranslation, label: "本地模型翻译", description: "下载后离线翻译，可选轻量语言包与混元翻译模型。"},
        // 云服务厂商：各家云控制台签发密钥，免费额度用完后按量计费
        {value: "cloud", label: "云服务厂商", disabled: true},
        {value: services.tencent, label: "腾讯云翻译", description: "机器翻译 TMT，每月 500 万字符免费额度。"},
        {value: services.googleCloudTranslation, label: "谷歌云翻译", description: "Cloud Translation v2，每月 50 万字符免费额度。", searchTerms: ["google cloud translation", "gcp"]},
        {value: services.azureTranslator, label: "Azure 翻译", description: "Azure AI Translator F0，每月 200 万字符免费额度。", searchTerms: ["microsoft azure translator"]},
        {value: services.aliyunTranslation, label: "阿里云机器翻译", description: "通用版翻译，每月 100 万字符免费额度。", searchTerms: ["aliyun alibaba cloud mt"]},
        {value: services.baiduTranslation, label: "百度翻译", description: "翻译开放平台，标准版每月 5 万字符免费额度。", searchTerms: ["baidu fanyi"]},
        {value: services.volcTranslation, label: "火山引擎翻译", description: "机器翻译 TranslateText，每月 200 万字符免费额度。", searchTerms: ["volcengine volc bytedance"]},
        // 大模型翻译
        {value: "ai", label: "AI翻译", disabled: true},
        // 大模型服务商：中国常用厂商优先，其次为常用海外厂商。
        {value: services.deepseek, label: "DeepSeek", catalogKind: "provider"},
        {value: services.tongyi, label: "千问/Qwen", catalogKind: "provider"},
        {value: services.doubao, label: "字节豆包", catalogKind: "provider"},
        {value: services.moonshot, label: "月之暗面/Kimi", catalogKind: "provider"},
        {value: services.zhipu, label: "智谱/GLM", catalogKind: "provider"},
        {value: services.huanYuan, label: "腾讯混元模型", catalogKind: "provider"},
        {value: services.huanYuanTranslation, label: "腾讯混元翻译", catalogKind: "provider"},
        {value: services.yiyan, label: "文心一言", catalogKind: "provider"},
        {value: services.minimax, label: "MiniMax", catalogKind: "provider"},
        {value: services.mimo, label: "小米 MiMo", catalogKind: "provider"},
        {value: services.jieyue, label: "阶跃星辰", catalogKind: "provider"},
        {value: services.openai, label: "OpenAI", catalogKind: "provider"},
        {value: services.chatgptPlan, label: "ChatGPT 套餐", description: "通过本机助手登录 ChatGPT，使用账户获准的套餐模型与额度。", catalogKind: "provider", searchTerms: ["oauth sign in chatgpt plus pro 套餐 登录"]},
        {value: services.gemini, label: "Gemini", catalogKind: "provider"},
        {value: services.claude, label: "Claude", catalogKind: "provider"},
        {value: services.grok, label: "Grok (X.AI)", catalogKind: "provider"},
        // 聚合平台、托管平台与 OpenAI 兼容接口。
        {value: services.siliconCloud, label: "硅基流动", catalogKind: "platform"},
        {value: services.newapi, label: "New API", catalogKind: "platform"},
        {value: services.infini, label: "无问芯穹", catalogKind: "platform"},
        {value: services.openrouter, label: "OpenRouter", catalogKind: "platform"},
        {value: services.groq, label: "Groq", catalogKind: "platform"},
        {value: services.azureOpenai, label: "Azure", catalogKind: "platform"},
        {value: services.mistral, label: "Mistral AI", catalogKind: "platform"},
        {value: services.cohere, label: "Cohere", catalogKind: "platform"},
        {value: services.cerebras, label: "Cerebras", catalogKind: "platform"},
        {value: services.togetherai, label: "Together AI", catalogKind: "platform"},
        {value: services.fireworks, label: "Fireworks AI", catalogKind: "platform"},
        {value: services.deepinfra, label: "DeepInfra", catalogKind: "platform"},
        {value: services.perplexity, label: "Perplexity", catalogKind: "platform"},
        {value: services.runcrate, label: "Runcrate", catalogKind: "platform"},
        {value: services.cloudgpu, label: "CloudGPU", catalogKind: "platform"},
        {value: services.cheaperinference, label: "Cheaper Inference", catalogKind: "platform"},
        {value: services.cheapaimodel, label: "cheapaimodel", catalogKind: "platform"},
        {value: services.rapidmlx, label: "Rapid-MLX", description: "连接本机 Rapid-MLX（Apple Silicon），无需密钥，模型与数据都留在本地。", catalogKind: "platform", searchTerms: ["rapid mlx rapid-mlx local localhost 本地 Mac"]},
        {value: services.ollama, label: "Ollama", description: "连接本机 Ollama，无需密钥，模型与数据都留在本地。", catalogKind: "platform", searchTerms: ["local localhost 本地"]},
        {value: services.custom, label: "自定义接口", catalogKind: "platform"},
    ],
    display: [
        {value: 0, label: "仅译文模式"},
        {value: 1, label: "双语对照模式"},
    ],
    // 双语翻译样式：带分组标题的旧版选项，由译文外观注册表统一派生。
    styles: buildTranslationStyleOptions(),
    // 悬浮球快捷键选项
    floatingBallHotkeys: [
        {value: "none", label: "禁用快捷键"},
        {value: "Alt+T", label: "Alt+T / Option+T"},
        {value: "Alt+A", label: "Alt+A / Option+A"},
        {value: "Alt+S", label: "Alt+S / Option+S"},
        {value: "Alt+D", label: "Alt+D / Option+D"},
        {value: "Alt+Q", label: "Alt+Q / Option+Q"},
        {value: "Ctrl+Shift+T", label: "Ctrl+Shift+T / Control+Shift+T"},
        {value: "Ctrl+Shift+A", label: "Ctrl+Shift+A / Control+Shift+A"},
        {value: "F9", label: "F9"},
        {value: "F10", label: "F10"},
        {value: "F11", label: "F11"},
        {value: "F12", label: "F12"},
        {value: "custom", label: "自定义快捷键"},
    ],
    theme: [
        {value: "auto", label: "跟随操作系统"},
        {value: "light", label: "亮色主题"},
        {value: "dark", label: "暗色主题"},
    ],
    // 输入框翻译目标语言选项
    inputBoxTranslationTarget: translationLanguageOptions,
    // 输入框翻译触发方式选项
    inputBoxTranslationTrigger: [
        {value: "disabled", label: "已关闭"},
        {value: "triple_space", label: "连按三下空格"},
        {value: "triple_equal", label: "连按三下等号(=)"},
        {value: "triple_dash", label: "连按三下短横线(-)"},
        {value: "custom", label: "自定义快捷键"},
    ],
};
