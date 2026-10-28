/**
 * @file userscript/defaultMessageData.ts
 * 文件职责：在 standalone 中文虚拟模块恢复默认目录时保存同序键列，供按需英文资源复用。
 * 主要内容：完整校验中文目录后保存不可变键副本；未初始化返回 undefined，旧格式不依赖此状态。
 * 模块边界：不导入核心 i18n 或完整语言目录；标准脚本和旧数据格式无需初始化此状态。
 */
import {unpackKeyColumn, unpackMessageCatalog, type PackedCatalogColumns} from './languageData';

let defaultMessageKeys: readonly string[] | undefined;

/** 全部验证与恢复成功后才发布键列；失败不替换已有效的默认目录顺序。 */
export function restoreDefaultMessageColumns(value: unknown) {
    const messages = unpackMessageCatalog(value);
    defaultMessageKeys = Object.freeze(unpackKeyColumn((value as PackedCatalogColumns)[0]));
    return messages;
}

export function readDefaultMessageKeys(): readonly string[] | undefined {
    return defaultMessageKeys;
}
