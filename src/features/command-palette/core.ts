/**
 * @file src/features/command-palette/core.ts
 * 文件职责：实现全局命令面板的纯领域模型、命令目录构造、多语与拼音模糊搜索评分、最近使用排序、分组投影及键盘导航状态转移。
 * 主要内容：支持中英文标题、描述、拼音别名与快捷键标签的多词模糊匹配，按命中精度与最近执行次序稳定排序，并对外暴露零浏览器依赖的命令类型与纯计算函数，供内容脚本组件与单元测试直接消费。
 * 模块边界：本文件属于 command-palette 的纯算法层，不访问 DOM、Shadow DOM、browser API 或持久化存储；动作执行与界面渲染分别由 content/runtime.ts 与 ui/CommandPalette.vue 负责。
 */

export type CommandPaletteCategory = 'recent' | 'translate' | 'workspace' | 'toggle' | 'results';

export type CommandPaletteActionId =
    | 'toggle-full-page'
    | 'switch-display-mode'
    | 'start-section-translation'
    | 'start-area-translation'
    | 'open-sidepanel'
    | 'open-document-translation'
    | 'open-learning-center'
    | 'open-settings'
    | 'toggle-floating-ball'
    | 'toggle-smart-highlight'
    | 'toggle-writing-assistant';

export interface CommandPaletteItem {
    readonly id: CommandPaletteActionId;
    readonly category: Exclude<CommandPaletteCategory, 'recent' | 'results'>;
    readonly title: string;
    readonly description: string;
    readonly keywords: readonly string[];
    readonly shortcut?: string;
    readonly badge?: string;
    readonly available?: boolean;
}

export interface CommandPaletteGroup {
    readonly category: CommandPaletteCategory;
    readonly items: readonly CommandPaletteItem[];
}

export interface CommandPaletteProjection {
    readonly groups: readonly CommandPaletteGroup[];
    readonly flatItems: readonly CommandPaletteItem[];
}

export type CommandPaletteKeyAction =
    | {readonly type: 'move'; readonly nextIndex: number}
    | {readonly type: 'execute'; readonly index: number}
    | {readonly type: 'close'}
    | {readonly type: 'noop'};

export interface CommandCatalogContext {
    readonly translate: (key: string) => string;
    readonly fullPageActive: boolean;
    readonly displayMode: number;
    readonly floatingBallEnabled: boolean;
    readonly smartHighlightEnabled: boolean;
    readonly writingAssistantEnabled: boolean;
    readonly canAreaTranslate: boolean;
    readonly canOpenSidepanel: boolean;
    readonly canOpenDocument: boolean;
    readonly canSmartHighlight: boolean;
    readonly shortcuts?: Partial<{
        readonly fullPage: string;
        readonly section: string;
        readonly area: string;
        readonly smartHighlight: string;
    }>;
}

export const MAX_RECENT_COMMANDS = 4;

/** 归一化搜索片段：忽略大小写、空白和快捷键加号分隔符，便于匹配中英文、拼音和按键标签。 */
function normalizeSearchText(value: string): string {
    return value.trim().toLowerCase().replace(/[\s+_-]+/gu, '');
}

/** 顺序子序列模糊匹配：命中越紧凑分值越高，未全部按序命中返回 0。 */
function fuzzySubsequenceScore(needle: string, haystack: string): number {
    if (!needle || !haystack || needle.length > haystack.length) return 0;
    let cursor = 0;
    let consecutive = 0;
    let maxConsecutive = 0;
    for (let index = 0; index < haystack.length && cursor < needle.length; index += 1) {
        if (haystack[index] === needle[cursor]) {
            cursor += 1;
            consecutive += 1;
            if (consecutive > maxConsecutive) maxConsecutive = consecutive;
        } else {
            consecutive = 0;
        }
    }
    if (cursor < needle.length) return 0;
    return 15 + maxConsecutive * 4 - Math.min(10, Math.floor((haystack.length - needle.length) / 4));
}

function scoreSingleField(token: string, compactToken: string, rawField: string, weight: number): number {
    const field = rawField.trim().toLowerCase();
    if (!field) return 0;
    const compactField = normalizeSearchText(field);
    if (field === token || compactField === compactToken) return weight + 60;
    if (field.startsWith(token) || compactField.startsWith(compactToken)) return weight + 35;
    if (field.includes(token) || compactField.includes(compactToken)) return weight + 15;
    const fuzzy = fuzzySubsequenceScore(compactToken, compactField);
    return fuzzy > 0 ? Math.max(1, fuzzy + Math.floor(weight / 4)) : 0;
}

/**
 * 计算单条命令与查询词的综合匹配分；返回 0 表示不匹配。
 * 多词查询（空格分隔）采用 AND 语义，每个词须至少命中标题、描述、别名关键词或快捷键之一。
 */
export function scoreCommandMatch(item: CommandPaletteItem, query: string): number {
    const tokens = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
    if (tokens.length === 0) return 1;

    let total = 0;
    for (const token of tokens) {
        const compactToken = normalizeSearchText(token);
        let best = Math.max(
            scoreSingleField(token, compactToken, item.title, 40),
            scoreSingleField(token, compactToken, item.description, 16),
            scoreSingleField(token, compactToken, item.id, 12),
            item.shortcut ? scoreSingleField(token, compactToken, item.shortcut, 20) : 0,
        );
        for (const keyword of item.keywords) {
            const keywordScore = scoreSingleField(token, compactToken, keyword, 34);
            if (keywordScore > best) best = keywordScore;
        }
        if (best <= 0) return 0;
        total += best;
    }
    return total;
}

/** 将最新执行的命令置顶并去重，同时保留有界长度。 */
export function recordRecentCommand(
    recentIds: readonly CommandPaletteActionId[],
    executedId: CommandPaletteActionId,
    limit: number = MAX_RECENT_COMMANDS,
): CommandPaletteActionId[] {
    const maxItems = Math.max(1, limit);
    return [executedId, ...recentIds.filter((id) => id !== executedId)].slice(0, maxItems);
}

const CATEGORY_ORDER: readonly Exclude<CommandPaletteCategory, 'recent' | 'results'>[] = [
    'translate',
    'workspace',
    'toggle',
];

/**
 * 根据查询词和最近使用记录投影分组结果和扁平可导航列表。
 * 空查询时将最近使用置于顶部并按功能类别分组；有查询词时按匹配得分降序展示。
 */
export function filterAndGroupCommands(
    commands: readonly CommandPaletteItem[],
    query: string,
    recentIds: readonly CommandPaletteActionId[] = [],
): CommandPaletteProjection {
    const availableCommands = commands.filter((item) => item.available !== false);
    const trimmed = query.trim();
    const recentRank = new Map<CommandPaletteActionId, number>(
        recentIds.map((id, index) => [id, index]),
    );

    if (!trimmed) {
        const groups: CommandPaletteGroup[] = [];
        const recentItems = recentIds
            .map((id) => availableCommands.find((item) => item.id === id))
            .filter((item): item is CommandPaletteItem => Boolean(item));
        const placedInRecent = new Set(recentItems.map((item) => item.id));

        if (recentItems.length > 0) {
            groups.push({category: 'recent', items: recentItems});
        }
        for (const category of CATEGORY_ORDER) {
            const items = availableCommands.filter(
                (item) => item.category === category && !placedInRecent.has(item.id),
            );
            if (items.length > 0) groups.push({category, items});
        }
        return {
            groups,
            flatItems: groups.flatMap((group) => group.items),
        };
    }

    const scored = availableCommands
        .map((item, originalIndex) => ({
            item,
            score: scoreCommandMatch(item, trimmed),
            recent: recentRank.get(item.id) ?? Number.MAX_SAFE_INTEGER,
            originalIndex,
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) =>
            right.score - left.score
            || left.recent - right.recent
            || left.originalIndex - right.originalIndex,
        )
        .map((entry) => entry.item);

    return {
        groups: scored.length > 0 ? [{category: 'results', items: scored}] : [],
        flatItems: scored,
    };
}

/** 键盘导航状态转移：支持上下循环、Home/End、Enter 执行与 Esc 关闭。 */
export function resolvePaletteKeyAction(
    key: string,
    activeIndex: number,
    itemCount: number,
): CommandPaletteKeyAction {
    if (key === 'Escape') return {type: 'close'};
    if (itemCount <= 0) return {type: 'noop'};
    if (key === 'ArrowDown') {
        const nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % itemCount;
        return {type: 'move', nextIndex};
    }
    if (key === 'ArrowUp') {
        const nextIndex = activeIndex < 0 ? itemCount - 1 : (activeIndex - 1 + itemCount) % itemCount;
        return {type: 'move', nextIndex};
    }
    if (key === 'Home') return {type: 'move', nextIndex: 0};
    if (key === 'End') return {type: 'move', nextIndex: itemCount - 1};
    if (key === 'Enter' && activeIndex >= 0 && activeIndex < itemCount) {
        return {type: 'execute', index: activeIndex};
    }
    return {type: 'noop'};
}

/** 根据当前页面状态、快捷键与浏览器能力构建完整的命令目录。 */
export function buildDefaultCommandCatalog(context: CommandCatalogContext): CommandPaletteItem[] {
    const t = context.translate;
    const isBilingual = context.displayMode === 1;
    const onLabel = t('commandPalette.status.on');
    const offLabel = t('commandPalette.status.off');

    return [
        {
            id: 'toggle-full-page',
            category: 'translate',
            title: context.fullPageActive
                ? t('commandPalette.action.restorePage')
                : t('commandPalette.action.translatePage'),
            description: t('commandPalette.action.toggleFullPageDesc'),
            keywords: ['全文翻译', '网页翻译', '恢复原文', 'quanwenfanyi', 'fanyi', 'huifu', 'translate', 'restore', 'page', 'full'],
            shortcut: context.shortcuts?.fullPage,
            badge: context.fullPageActive ? t('commandPalette.status.translated') : undefined,
        },
        {
            id: 'switch-display-mode',
            category: 'translate',
            title: isBilingual
                ? t('commandPalette.action.switchToTranslationOnly')
                : t('commandPalette.action.switchToBilingual'),
            description: t('commandPalette.action.switchDisplayModeDesc'),
            keywords: ['双语模式', '仅译文', '显示模式', 'shuangyu', 'jinyiwen', 'bilingual', 'translation only', 'display', 'mode'],
            badge: isBilingual ? t('commandPalette.status.bilingual') : t('commandPalette.status.translationOnly'),
        },
        {
            id: 'start-section-translation',
            category: 'translate',
            title: t('commandPalette.action.sectionTranslation'),
            description: t('commandPalette.action.sectionTranslationDesc'),
            keywords: ['局部翻译', '区域翻译', '选区翻译', 'jubufanyi', 'quyu', 'section', 'region', 'partial'],
            shortcut: context.shortcuts?.section,
        },
        {
            id: 'start-area-translation',
            category: 'translate',
            title: t('commandPalette.action.areaTranslation'),
            description: t('commandPalette.action.areaTranslationDesc'),
            keywords: ['圈选翻译', '截图翻译', 'ocr', 'quanxuanfanyi', 'jietu', 'area', 'screenshot', 'capture'],
            shortcut: context.shortcuts?.area,
            available: context.canAreaTranslate,
        },
        {
            id: 'open-sidepanel',
            category: 'workspace',
            title: t('commandPalette.action.openSidepanel'),
            description: t('commandPalette.action.openSidepanelDesc'),
            keywords: ['侧边栏翻译', '翻译中心', 'cebianlan', 'sidepanel', 'sidebar', 'panel'],
            available: context.canOpenSidepanel,
        },
        {
            id: 'open-document-translation',
            category: 'workspace',
            title: t('commandPalette.action.openDocument'),
            description: t('commandPalette.action.openDocumentDesc'),
            keywords: ['文档翻译', 'pdf', 'epub', 'docx', 'wendangfanyi', 'document', 'file', 'paper'],
            available: context.canOpenDocument,
        },
        {
            id: 'open-learning-center',
            category: 'workspace',
            title: t('commandPalette.action.openLearningCenter'),
            description: t('commandPalette.action.openLearningCenterDesc'),
            keywords: ['学习中心', '单词本', '生词本', 'xuexizhongxin', 'danciben', 'vocabulary', 'learning', 'wordbook', 'flashcard'],
        },
        {
            id: 'open-settings',
            category: 'workspace',
            title: t('commandPalette.action.openSettings'),
            description: t('commandPalette.action.openSettingsDesc'),
            keywords: ['完整设置', '设置中心', '偏好设置', 'shezhi', 'settings', 'options', 'preferences', 'config'],
        },
        {
            id: 'toggle-floating-ball',
            category: 'toggle',
            title: t('commandPalette.action.toggleFloatingBall'),
            description: t('commandPalette.action.toggleFloatingBallDesc'),
            keywords: ['悬浮球', 'xuanfuqiu', 'floating', 'ball', 'bubble'],
            badge: context.floatingBallEnabled ? onLabel : offLabel,
        },
        {
            id: 'toggle-smart-highlight',
            category: 'toggle',
            title: t('commandPalette.action.toggleSmartHighlight'),
            description: t('commandPalette.action.toggleSmartHighlightDesc'),
            keywords: ['智能高亮', '信息高亮', 'zhinenggaoliang', 'gaoliang', 'smart', 'highlight', 'information'],
            shortcut: context.shortcuts?.smartHighlight,
            badge: context.smartHighlightEnabled ? onLabel : offLabel,
            available: context.canSmartHighlight,
        },
        {
            id: 'toggle-writing-assistant',
            category: 'toggle',
            title: t('commandPalette.action.toggleWritingAssistant'),
            description: t('commandPalette.action.toggleWritingAssistantDesc'),
            keywords: ['写作助手', '润色', 'xiezuozhushou', 'writing', 'assistant', 'compose', 'polish'],
            badge: context.writingAssistantEnabled ? onLabel : offLabel,
        },
    ];
}
