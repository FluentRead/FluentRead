/**
 * @file scripts/i18n/extensionLanguageBundles.ts
 * 文件职责：在扩展构建期生成界面语言包产物，保持英文完整本地内置，其余五语按固定远程基线输出紧凑增量包。
 * 主要内容：核对本地五份固定基线的字节长度与 SHA-256 摘要，计算与当前扩展词典的最小增量，避免在扩展包内重复打包 2.87 MB 已发布基线 JSON。
 * 模块边界：仅供 WXT 构建与单测调用，不进入浏览器运行时代码；不修改 userscript 固定语言文件或核心词典定义。
 */

import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createUiLanguageBundleFiles} from '../../src/core/i18n/bundles';
import {
    createDeltaUiLanguageBundle,
    isRemoteDeltaUiLanguage,
    REMOTE_LANGUAGE_BASE_ASSETS,
} from '../../src/core/i18n/remoteLanguagePacks';
import type {UiLanguageBundle} from '../../src/core/i18n/types';

/** 生成扩展产物中的 i18n/*.json：en-US 保持完整本地文件，其余五语输出带固定基线摘要的 delta-v1 增量文件。 */
export function createExtensionUiLanguageBundleFiles(root: string): Array<{relativeDest: string; contents: string}> {
    return createUiLanguageBundleFiles().map(({relativeDest, contents}) => {
        const language = relativeDest.slice('i18n/'.length, -'.json'.length);
        if (!isRemoteDeltaUiLanguage(language)) {
            return {relativeDest, contents};
        }
        const asset = REMOTE_LANGUAGE_BASE_ASSETS[language];
        const baselineRaw = readFileSync(resolve(root, asset.path));
        const actualSha256 = createHash('sha256').update(baselineRaw).digest('hex');
        if (baselineRaw.byteLength !== asset.bytes || actualSha256 !== asset.sha256) {
            throw new Error(`Pinned language base mismatch for ${language}: expected ${asset.bytes}/${asset.sha256}, got ${baselineRaw.byteLength}/${actualSha256}`);
        }
        const baseline = JSON.parse(baselineRaw.toString('utf8')) as UiLanguageBundle;
        const full = JSON.parse(contents) as UiLanguageBundle;
        const delta = createDeltaUiLanguageBundle(language, full, baseline);
        return {
            relativeDest,
            contents: JSON.stringify(delta),
        };
    });
}
