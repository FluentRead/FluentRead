/**
 * @file src/core/translation/registry.ts
 *
 * 文件职责：登记并排序 FluentRead 内置站点翻译适配器，为候选核心提供稳定、只读的默认规则集合。
 * 主要内容：从版本化 JSON 目录编译所有内置网站规则，沿用 TranslationSiteAdapter 契约生成 defaultTranslationAdapters。 可核对的公开符号包括 defaultTranslationAdapters。
 * 模块边界：本文件属于可独立测试的 core 候选领域；可以读取传入 DOM 以计算结果，但不访问配置存储、不调用 provider、不注册页面监听器，也不负责译文渲染或 feature 生命周期。
 */

import {builtinSiteRulePack} from '../site-adaptation/catalog';
import {compileSiteRulePack} from '../site-adaptation/compiler';
import type {TranslationSiteAdapter} from './types';

/** JSON 规则是内置适配的唯一来源，不再维护平行的逐站 TypeScript 定义。 */
let cachedDefaultTranslationAdapters: readonly TranslationSiteAdapter[] | undefined;

/** 按需编译内置站点规则并缓存只读结果，避免在页面首帧前同步编译全部规则。 */
export function getDefaultTranslationAdapters(): readonly TranslationSiteAdapter[] {
    return cachedDefaultTranslationAdapters ??= Object.freeze(compileSiteRulePack(builtinSiteRulePack));
}

export const defaultTranslationAdapters: readonly TranslationSiteAdapter[] =
    /*#__PURE__*/ getDefaultTranslationAdapters();
