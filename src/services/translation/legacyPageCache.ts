/**
 * @file src/services/translation/legacyPageCache.ts
 *
 * 文件职责：安全清理宿主页面存储中旧版 FluentRead 翻译缓存键，而不影响网站自己的 localStorage 数据。
 * 主要内容：定义 LegacyPageStorage 端口与旧 flcache_ 前缀、时间戳键，clearLegacyPageTranslationCache 先精确枚举所属键再逐项删除。 可核对的公开符号包括 LegacyPageStorage、clearLegacyPageTranslationCache。
 * 模块边界：本文件位于翻译 application service 层，负责用例编排和端口契约；不挂载页面 UI，且不应把某家供应商的网络细节扩散到 feature，具体 HTTP 协议由 providers/platform 实现。
 */

const LEGACY_TRANSLATION_CACHE_PREFIX = 'flcache_';
const LEGACY_CACHE_TIMESTAMP_KEY = 'flLastSessionTimestamp';

export interface LegacyPageStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

/**
 * 删除早期版本写入页面 origin 的 FluentRead 翻译缓存。
 * 只处理产品前缀与时间戳标记，绝不清空或遍历删除宿主站点的其他数据。
 */
export function clearLegacyPageTranslationCache(
  pageStorage?: LegacyPageStorage,
): number {
  try {
    pageStorage ??= window.localStorage;
    const keysToDelete: string[] = [];
    for (let index = 0; index < pageStorage.length; index += 1) {
      const key = pageStorage.key(index);
      if (key?.startsWith(LEGACY_TRANSLATION_CACHE_PREFIX)) keysToDelete.push(key);
    }

    for (const key of keysToDelete) pageStorage.removeItem(key);
    if (keysToDelete.length > 0 || pageStorage.getItem(LEGACY_CACHE_TIMESTAMP_KEY) !== null) {
      pageStorage.removeItem(LEGACY_CACHE_TIMESTAMP_KEY);
    }
    return keysToDelete.length;
  } catch {
    // 沙箱或 opaque origin 可能禁用 Storage；迁移失败不能阻止内容脚本启动。
    return 0;
  }
}
