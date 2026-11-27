/**
 * @file src/ui/i18n/localizeServiceOptions.ts
 *
 * 文件职责：提供与 Vue 和配置存储完全解耦的服务目录本地化纯函数，供设置页服务选择器与自定义档案复用。
 * 主要内容：定义 LocalizableServiceOption、ServiceProfileSummary 契约与 localizeServiceOptions 函数；单次查询沿用 find 提前停止，批量查询按需增量建立 profile 索引并保留重复 ID 首项，同时在搜索词中保留原始标签、本地化标签、端点与模型列表。
 * 模块边界：本模块属于 UI i18n 纯工具层，不依赖 Vue、配置 store、浏览器 API 或语言资源加载器；调用方自行传入当前语言对应的 translateLegacy 函数。
 */

export interface LocalizableServiceOption {
    value: string;
    label: string;
    description?: string;
    searchTerms?: string[];
}

export interface ServiceProfileSummary {
    id: string;
    name?: string;
    endpoint?: string;
    models?: string[];
    services?: string[];
}

/** 在 UI 边界复用本次标签译文；profile 按需索引且保留重复 ID 首项，原始名称仍用于搜索。 */
export function localizeServiceOptions<T extends LocalizableServiceOption>(
    options: readonly T[],
    profiles: readonly ServiceProfileSummary[],
    translateLegacy: (value: string) => string,
): Array<T & {searchTerms: string[]}> {
    // 单项查询沿用 find 的提前停止；批量查询只扫描未见过的前缀，不预扫整个目录。
    const profileIndex = options.length > 1 && profiles.length > 1
        ? new Map<string, ServiceProfileSummary>() : undefined;
    let profileCursor = 0;
    return options.map((option) => {
        let profile = profileIndex ? profileIndex.get(option.value) : profiles.find((item) => item.id === option.value);
        while (profileIndex && !profile && profileCursor < profiles.length) {
            const next = profiles[profileCursor++], id = next.id;
            if (!profileIndex.has(id)) profileIndex.set(id, next);
            if (id === option.value) profile = profileIndex.get(id);
        }
        const label = profile?.name || translateLegacy(option.label);
        return {
            ...option,
            label,
            description: profile?.services ? undefined : option.description ? translateLegacy(option.description) : option.description,
            searchTerms: [...(option.searchTerms || []), option.label, label, ...(profile ? [...(profile.endpoint ? [profile.endpoint] : []), ...(profile.models || [])] : [])],
        };
    });
}
