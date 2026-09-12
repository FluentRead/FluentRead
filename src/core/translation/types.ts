/**
 * @file src/core/translation/types.ts
 *
 * 文件职责：定义翻译候选核心的基础类型契约，使引擎、布局、序列化和站点适配器能够以一致结构协作。
 * 主要内容：包含正文/全部节点识别范围；包含候选 kind、AdapterDecision、AdapterContext、TranslationSiteAdapter、TranslationCandidate 与 TranslationCoreOptions，明确适配器输入、候选来源、原文保留和双语快照省略规则。 可核对的公开符号包括 TranslationCandidateKind、AdapterDecision、AdapterContext、TranslationSiteAdapter、TranslationCandidate、TranslationCoreOptions。
 * 模块边界：本文件属于可独立测试的 core 候选领域；可以读取传入 DOM 以计算结果，但不访问配置存储、不调用 provider、不注册页面监听器，也不负责译文渲染或 feature 生命周期。
 */

export type TranslationCandidateKind = 'content' | 'control';

/** 正文范围保留站点阅读边界；全部节点范围额外覆盖可见界面文字。 */
export type TranslationScope = 'content' | 'all';

/** 站点适配器是否允许没有显式 selector 命中的通用候选。 */
export type TranslationGenericCandidatePolicy = 'allow' | 'targets-only';

export type AdapterDecision =
    | {kind: 'pass'}
    | {kind: 'skip-self'; reason: string}
    | {kind: 'prune-subtree'; reason: string}
    | {
        kind: 'force-target';
        reason: string;
        target?: Element;
        candidateKind?: TranslationCandidateKind;
        atomic?: boolean;
    };

export interface AdapterContext {
    url: URL;
}

export interface TranslationSiteAdapter {
    id: string;
    priority?: number;
    /** `targets-only` 仍允许 force-target，但禁止通用块和内联 run 回退。 */
    genericCandidatePolicy?: TranslationGenericCandidatePolicy;
    /** 规则依赖的属性名；null 表示不能安全穷举，必须观察全部属性。 */
    observedAttributes?: readonly string[] | null;
    matches(url: URL): boolean;
    decide(element: Element, context: AdapterContext): AdapterDecision;
    shouldStayOriginal?(element: Element, context: AdapterContext): boolean;
    /** 命中的宿主元数据不进入双语译文骨架，但仍可留在原文 DOM 中。 */
    shouldOmitFromTranslation?(element: Element, context: AdapterContext): boolean;
    shouldIgnoreMutation?(element: Element, context: AdapterContext): boolean;
}

export interface TranslationCandidate {
    /** 用于观察和渲染的宿主；内联 run 候选只物化 `nodes`。 */
    element: HTMLElement;
    /** 块内同时包含内联文本与块级子节点时使用的连续直接子节点。 */
    nodes?: readonly ChildNode[];
    kind: TranslationCandidateKind;
    reason: string;
    adapterId?: string;
    /** 显式全部节点候选在重校验、请求和重试时继续使用相同发现政策。 */
    scope?: TranslationScope;
    /** 显式选中/悬浮解析允许穿过 body 直接子级的应用级 no-translate 外壳。 */
    allowTopLevelApplicationShell?: boolean;
}

export interface TranslationCoreOptions {
    scope?: TranslationScope;
    /** 正文范围下把侧边栏与导航一并纳入候选发现。 */
    includeSidebarRegions?: boolean;
    url?: URL;
    adapters?: readonly TranslationSiteAdapter[];
}
