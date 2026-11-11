/**
 * @file src/core/site-adaptation/types.ts
 * 文件职责：定义 FluentRead 网站适配 JSON 的版本、内容边界与配置契约。
 * 主要内容：声明规则包、共享模板、内容目标、精确禁译覆盖、持久设置与校验结果类型。
 * 模块边界：只描述数据，不执行网页脚本、修改页面样式或读取配置存储。
 */

export interface SiteContentRule {
    css: string[];
    resolve?: 'self' | 'closest';
    atomic?: boolean;
    /** 按直接子级 br 拆分正文，保留每行的链接、强调与代码。 */
    splitOnBr?: boolean;
    key?: string;
}

export interface SiteRecipe {
    mode?: 'augment' | 'focus';
    content?: SiteContentRule[];
    protect?: string[];
    exclude?: string[];
    watchIgnore?: string[];
    /** 仅覆盖匹配元素自身的禁译标记，不解除后代或其他类型的保护。 */
    forceTranslate?: string[];
    /** 省略受控元数据；同时排除候选和请求，译文副本也不保留。 */
    omit?: string[];
    /** 仅当所选节点是以 b/i 字面量开头、其余文字仅在平衡括号内的标签时保护。 */
    literalLabels?: string[];
    /** 仅当所选字面标记的文本符合命令式标识符形态时保留原文。 */
    literalTokens?: string[];
}

export interface SiteRule extends SiteRecipe {
    id: string;
    name: string;
    match: {hosts: string[]; paths?: string[]; excludePaths?: string[]};
    profile?: string;
    priority?: number;
    /** 显式让名称等站点保护也适用于用户选择的全部节点范围。默认仅正文范围。 */
    allScopes?: boolean;
}

export interface SiteRulePack {
    version: 1;
    profiles?: Record<string, SiteRecipe>;
    rules: SiteRule[];
}

export interface SiteAdaptationSettings {
    enabled: boolean;
    disabledRuleIds: string[];
    custom: SiteRulePack;
}

export interface SiteRuleIssue {
    path: string;
    message: string;
}

export type SiteRulePackParseResult =
    | {ok: true; pack: SiteRulePack}
    | {ok: false; issues: SiteRuleIssue[]};
