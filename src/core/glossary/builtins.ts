/**
 * @file src/core/glossary/builtins.ts
 * 文件职责：提供随扩展离线分发的领域术语起步词库，并安全地添加为用户可编辑副本。
 * 主要内容：独立整理 AI、开发、财报、学术与产品名词对；目录记录版本与语言，添加时检查重复来源和容量，保留已有词库顺序及用户修改。
 * 模块边界：纯静态数据和副本创建，不读取配置、不下载远程词表、不自动启用总开关；不复制第三方词库的数据。
 */
import {createGlossaryLibrary, GLOSSARY_LIMITS, type GlossaryLibrary} from './model';

export interface BuiltinGlossary {
    readonly id: string;
    readonly version: number;
    readonly nameKey: string;
    readonly descriptionKey: string;
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly caseSensitive: boolean;
    readonly terms: readonly (readonly [string, string])[];
}

/** 词对由 FluentRead 独立整理，随项目许可证分发；只作可调整的首选译法，不宣称是专业标准词典。 */
export const BUILTIN_GLOSSARIES: readonly BuiltinGlossary[] = [
    {
        id: 'ai-en-zh-hans', version: 1, nameKey: 'glossary.builtin.ai', descriptionKey: 'glossary.builtin.aiDescription',
        sourceLanguage: 'en', targetLanguage: 'zh-hans', caseSensitive: false,
        terms: [
            ['artificial intelligence', '人工智能'], ['machine learning', '机器学习'],
            ['deep learning', '深度学习'], ['large language model', '大语言模型'],
            ['large language models', '大语言模型'], ['small language model', '小语言模型'],
            ['foundation model', '基础模型'], ['generative AI', '生成式人工智能'],
            ['neural network', '神经网络'], ['convolutional neural network', '卷积神经网络'],
            ['recurrent neural network', '循环神经网络'], ['attention mechanism', '注意力机制'],
            ['self-attention', '自注意力'], ['multi-head attention', '多头注意力'],
            ['context window', '上下文窗口'], ['context length', '上下文长度'],
            ['prompt engineering', '提示词工程'], ['system prompt', '系统提示词'],
            ['chain of thought', '思维链'], ['chain-of-thought', '思维链'],
            ['retrieval-augmented generation', '检索增强生成'], ['vector database', '向量数据库'],
            ['vector embedding', '向量嵌入'], ['semantic search', '语义搜索'],
            ['fine-tuning', '微调'], ['supervised fine-tuning', '监督微调'],
            ['instruction tuning', '指令微调'], ['pre-training', '预训练'],
            ['reinforcement learning', '强化学习'], ['reinforcement learning from human feedback', '基于人类反馈的强化学习'],
            ['direct preference optimization', '直接偏好优化'], ['reward model', '奖励模型'],
            ['knowledge distillation', '知识蒸馏'], ['model quantization', '模型量化'],
            ['mixture of experts', '混合专家'], ['mixture-of-experts', '混合专家'],
            ['training data', '训练数据'], ['training set', '训练集'],
            ['validation set', '验证集'], ['test set', '测试集'],
            ['loss function', '损失函数'], ['learning rate', '学习率'],
            ['gradient descent', '梯度下降'], ['batch size', '批量大小'],
            ['overfitting', '过拟合'], ['underfitting', '欠拟合'],
            ['zero-shot learning', '零样本学习'], ['few-shot learning', '少样本学习'],
            ['in-context learning', '上下文学习'], ['transfer learning', '迁移学习'],
            ['AI agent', 'AI 智能体'], ['agentic workflow', '智能体工作流'],
            ['multi-agent system', '多智能体系统'], ['tool calling', '工具调用'],
            ['function calling', '函数调用'], ['multimodal model', '多模态模型'],
            ['diffusion model', '扩散模型'], ['model hallucination', '模型幻觉'],
            ['inference latency', '推理延迟'], ['speculative decoding', '推测解码'],
        ],
    },
    {
        id: 'software-en-zh-hans', version: 1, nameKey: 'glossary.builtin.software', descriptionKey: 'glossary.builtin.softwareDescription',
        sourceLanguage: 'en', targetLanguage: 'zh-hans', caseSensitive: false,
        terms: [
            ['source code', '源代码'], ['code review', '代码审查'], ['pull request', '拉取请求'],
            ['merge request', '合并请求'], ['version control', '版本控制'], ['commit message', '提交说明'],
            ['merge conflict', '合并冲突'], ['working tree', '工作树'], ['feature branch', '功能分支'],
            ['continuous integration', '持续集成'], ['continuous delivery', '持续交付'], ['continuous deployment', '持续部署'],
            ['unit test', '单元测试'], ['integration test', '集成测试'], ['regression test', '回归测试'],
            ['end-to-end test', '端到端测试'], ['test coverage', '测试覆盖率'], ['test fixture', '测试夹具'],
            ['dependency injection', '依赖注入'], ['dependency graph', '依赖图'], ['package manager', '包管理器'],
            ['semantic versioning', '语义化版本控制'], ['breaking change', '破坏性变更'], ['backward compatibility', '向后兼容性'],
            ['type inference', '类型推断'], ['type safety', '类型安全'], ['type checking', '类型检查'],
            ['static analysis', '静态分析'], ['runtime error', '运行时错误'], ['stack trace', '堆栈跟踪'],
            ['event loop', '事件循环'], ['race condition', '竞态条件'], ['deadlock', '死锁'],
            ['memory leak', '内存泄漏'], ['garbage collection', '垃圾回收'], ['reference counting', '引用计数'],
            ['asynchronous programming', '异步编程'], ['thread pool', '线程池'], ['message queue', '消息队列'],
            ['load balancing', '负载均衡'], ['rate limiting', '速率限制'], ['circuit breaker', '熔断器'],
            ['exponential backoff', '指数退避'], ['connection pool', '连接池'], ['cache invalidation', '缓存失效'],
            ['cache hit', '缓存命中'], ['cache miss', '缓存未命中'], ['eventual consistency', '最终一致性'],
            ['optimistic locking', '乐观锁'], ['database transaction', '数据库事务'], ['primary key', '主键'],
            ['foreign key', '外键'], ['query optimizer', '查询优化器'], ['index scan', '索引扫描'],
            ['virtual DOM', '虚拟 DOM'], ['shadow DOM', '影子 DOM'], ['server-side rendering', '服务端渲染'],
            ['client-side rendering', '客户端渲染'], ['tree shaking', '树摇优化'], ['hot module replacement', '模块热替换'],
        ],
    },
    {
        id: 'finance-en-zh-hans', version: 1, nameKey: 'glossary.builtin.finance', descriptionKey: 'glossary.builtin.financeDescription',
        sourceLanguage: 'en', targetLanguage: 'zh-hans', caseSensitive: false,
        terms: [
            ['financial statements', '财务报表'], ['annual report', '年度报告'], ['interim report', '中期报告'],
            ['balance sheet', '资产负债表'], ['income statement', '利润表'], ['cash flow statement', '现金流量表'],
            ['gross profit', '毛利'], ['gross margin', '毛利率'], ['operating profit', '营业利润'],
            ['operating margin', '营业利润率'], ['net profit', '净利润'], ['net income', '净利润'],
            ['net margin', '净利率'], ['earnings per share', '每股收益'], ['diluted earnings per share', '稀释每股收益'],
            ['operating cash flow', '经营现金流'], ['free cash flow', '自由现金流'], ['capital expenditure', '资本支出'],
            ['working capital', '营运资本'], ['accounts receivable', '应收账款'], ['accounts payable', '应付账款'],
            ['deferred revenue', '递延收入'], ['retained earnings', '留存收益'], ["shareholders' equity", '股东权益'],
            ['current assets', '流动资产'], ['current liabilities', '流动负债'], ['intangible assets', '无形资产'],
            ['impairment loss', '减值损失'], ['stock-based compensation', '股份支付'], ['share-based payment', '股份支付'],
            ['market capitalization', '市值'], ['enterprise value', '企业价值'], ['price-to-earnings ratio', '市盈率'],
            ['price-to-book ratio', '市净率'], ['dividend yield', '股息率'], ['dividend payout ratio', '股息支付率'],
            ['return on equity', '净资产收益率'], ['return on assets', '总资产收益率'], ['return on invested capital', '投入资本回报率'],
            ['discounted cash flow', '折现现金流'], ['weighted average cost of capital', '加权平均资本成本'], ['net present value', '净现值'],
            ['initial public offering', '首次公开募股'], ['secondary market', '二级市场'], ['share buyback', '股份回购'],
            ['lock-up period', '禁售期'], ['shares outstanding', '已发行在外股份'], ['free float', '自由流通股'],
            ['year-over-year', '同比'], ['quarter-over-quarter', '环比'],
        ],
    },
    {
        id: 'research-en-zh-hans', version: 1, nameKey: 'glossary.builtin.research', descriptionKey: 'glossary.builtin.researchDescription',
        sourceLanguage: 'en', targetLanguage: 'zh-hans', caseSensitive: false,
        terms: [
            ['peer review', '同行评审'], ['literature review', '文献综述'], ['systematic review', '系统综述'],
            ['meta-analysis', '荟萃分析'], ['research question', '研究问题'], ['research hypothesis', '研究假设'],
            ['null hypothesis', '原假设'], ['alternative hypothesis', '备择假设'], ['statistical significance', '统计显著性'],
            ['confidence interval', '置信区间'], ['credible interval', '可信区间'], ['effect size', '效应量'],
            ['sample size', '样本量'], ['statistical power', '统计功效'], ['standard deviation', '标准差'],
            ['standard error', '标准误'], ['independent variable', '自变量'], ['dependent variable', '因变量'],
            ['confounding variable', '混杂变量'], ['control group', '对照组'], ['experimental group', '实验组'],
            ['randomized controlled trial', '随机对照试验'], ['double-blind', '双盲'], ['cross-sectional study', '横断面研究'],
            ['longitudinal study', '纵向研究'], ['cohort study', '队列研究'], ['case-control study', '病例对照研究'],
            ['selection bias', '选择偏倚'], ['publication bias', '发表偏倚'], ['sensitivity analysis', '敏感性分析'],
            ['robustness check', '稳健性检验'], ['ablation study', '消融研究'], ['baseline model', '基线模型'],
            ['cross-validation', '交叉验证'], ['multiple comparisons', '多重比较'], ['false positive', '假阳性'],
            ['false negative', '假阴性'], ['causal inference', '因果推断'], ['data availability', '数据可用性'],
            ['conflict of interest', '利益冲突'],
        ],
    },
    {
        id: 'product-names', version: 1, nameKey: 'glossary.builtin.products', descriptionKey: 'glossary.builtin.productsDescription',
        sourceLanguage: '', targetLanguage: '', caseSensitive: true,
        terms: [
            ['FluentRead', ''], ['GitHub', ''], ['GitLab', ''], ['TypeScript', ''], ['JavaScript', ''],
            ['Node.js', ''], ['Vue.js', ''], ['React.js', ''], ['Next.js', ''], ['Nuxt', ''],
            ['Vite', ''], ['Vitest', ''], ['Playwright', ''], ['Tailwind CSS', ''], ['WebAssembly', ''],
            ['PostgreSQL', ''], ['MySQL', ''], ['SQLite', ''], ['MongoDB', ''], ['Redis', ''],
            ['Docker', ''], ['Kubernetes', ''], ['OpenAI', ''], ['ChatGPT', ''], ['Hugging Face', ''],
            ['PyTorch', ''], ['TensorFlow', ''], ['scikit-learn', ''], ['NumPy', ''], ['Jupyter', ''],
        ],
    },
];

export type AddBuiltinGlossaryResult =
    | {status: 'added'; library: GlossaryLibrary; libraries: GlossaryLibrary[]}
    | {status: 'existing'; library: GlossaryLibrary}
    | {status: 'unknown' | 'capacity'};

/** 同一来源只添加一次；重命名、停用和修改词条均不会丢失来源，也不会被“再次添加”重置。 */
export function addBuiltinGlossary(
    id: string, libraries: readonly GlossaryLibrary[], name: string,
): AddBuiltinGlossaryResult {
    const preset = BUILTIN_GLOSSARIES.find(item => item.id === id);
    if (!preset) return {status: 'unknown'};
    const existing = libraries.find(item => item.preset?.id === id);
    if (existing) return {status: 'existing', library: existing};
    if (libraries.length >= GLOSSARY_LIMITS.libraries
        || libraries.reduce((total, library) => total + library.entries.length, 0) + preset.terms.length > GLOSSARY_LIMITS.totalEntries) return {status: 'capacity'};
    const library: GlossaryLibrary = {
        ...createGlossaryLibrary(libraries), name,
        sourceLanguage: preset.sourceLanguage, targetLanguage: preset.targetLanguage,
        preset: {id: preset.id, version: preset.version},
        entries: preset.terms.map(([source, target], index) => ({
            id: `term-${index + 1}`, source, target, caseSensitive: preset.caseSensitive,
        })),
    };
    return {status: 'added', library, libraries: [...libraries, library]};
}
