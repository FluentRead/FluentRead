/**
 * @file userscript/serviceBrandIconsPlugin.ts
 * 文件职责：仅为完整独立脚本无损压缩本地服务品牌路径数据。
 * 主要内容：校验完整输入，以既有 ASCII85 保存完整 gzip 字节，在首次请求已有品牌时通过既有 pako 字符串端口恢复并缓存全表。
 * 模块边界：不改变图标、provider或许可，不顶层解压，不新增全局、异步或网络回退。
 */
import {createHash} from 'node:crypto';
import {readFileSync, realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {gzipUserscriptBuildData} from './buildGzip';
import {encodeUserscriptDataCompact} from './buildDataEncoding';
import {normalizePath, type Plugin} from 'vite';

const allowedAttributes = new Set(['d', 'clip-rule', 'fill-rule', 'opacity', 'fill-opacity']);
const pathPattern = /^[MmLlHhVvCcSsQqTtAaZzEe0-9.,+\-\s]+$/u;
function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 使用已有 ServiceIcon 静态数据契约，不选择服务或裁剪任何品牌。 */
function validateBrandPaths(value: unknown): asserts value is Record<string, Array<Record<string, string>>> {
    if (!isRecord(value) || Object.keys(value).length === 0) throw new Error('Invalid service brand paths table');
    for (const [service, paths] of Object.entries(value)) {
        if (!service || !Array.isArray(paths) || paths.length === 0) throw new Error('Invalid service brand paths entry');
        for (const attributes of paths) {
            if (!isRecord(attributes) || !Object.hasOwn(attributes, 'd') || typeof attributes.d !== 'string' || !pathPattern.test(attributes.d)) {
                throw new Error('Invalid service brand path');
            }
            for (const [name, attribute] of Object.entries(attributes)) {
                if (!allowedAttributes.has(name) || typeof attribute !== 'string') throw new Error('Invalid service brand path attribute');
            }
        }
    }
}

/** 普通、Greasy Fork 与扩展出口不替换；只接受无 query/虚拟前缀的精确物理模块。 */
export function createUserscriptServiceBrandIconsCompressionPlugin(root: string, enabled = false, standalone = false): Plugin {
    const sourcePath = enabled
        ? normalizePath(realpathSync(resolve(root, 'src/ui/assets/serviceBrandIcons.ts')))
        : '';
    return {
        name: 'compress-standalone-service-brand-icons',
        enforce: 'pre',
        load(id) {
            if (!enabled || normalizePath(id) !== sourcePath) return null;
            const dataPath = resolve(root, 'src/ui/assets/serviceBrandPaths.json');
            this.addWatchFile(dataPath);
            const source = readFileSync(dataPath);
            const paths: unknown = JSON.parse(source.toString('utf8'));
            validateBrandPaths(paths);
            const serialized = JSON.stringify(paths);
            const compressed = encodeUserscriptDataCompact(gzipUserscriptBuildData(Buffer.from(serialized, 'utf8'), 8, standalone));
            const sourceSha256 = createHash('sha256').update(source).digest('hex');
            return [
                `/* Non-code Lobe Icons paths; original JSON sha256 ${sourceSha256}; existing MIT notice retained. */`,
                "import {inflateWithPako} from '@/userscript/pakoRuntime';",
                "import {decodeUserscriptData} from '@/userscript/dataEncoding';",
                'const knownBrands = Object.create(null);',
                `for (const service of ${JSON.stringify(Object.keys(paths))}) knownBrands[service] = true;`,
                'let brandPaths;',
                'export function getServiceBrandIcon(service) {',
                '    if (brandPaths !== undefined) return Object.hasOwn(brandPaths, service) ? brandPaths[service] : undefined;',
                '    if (!Object.hasOwn(knownBrands, service)) return undefined;',
                `    const restored = JSON.parse(inflateWithPako(decodeUserscriptData(${JSON.stringify(compressed)})));`,
                "    if (restored === null || typeof restored !== 'object' || Array.isArray(restored) || !Object.hasOwn(restored, service) || !Array.isArray(restored[service]) || restored[service].length === 0) throw new Error('Invalid restored service brand paths');",
                '    brandPaths = restored;',
                '    return restored[service];',
                '}',
            ].join('\n');
        },
    };
}
