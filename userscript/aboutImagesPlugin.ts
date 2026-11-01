/**
 * @file userscript/aboutImagesPlugin.ts
 * 文件职责：仅为完整独立脚本无损压缩关于页的两张离线 JPEG。
 * 主要内容：精确替换普通图像访问模块，以 ASCII91 保存 gzip 数据，首次显式取用时通过既有 pako 字符串端口恢复完整原 data URL。
 * 模块边界：不改变图像字节或 public 资源，不顶层解压，不新增全局状态、异步加载或网络回退。
 */
import {createHash} from 'node:crypto';
import {readFileSync, realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {gzipLargeStandaloneUserscriptData, gzipUserscriptBuildData} from './buildGzip';
import {encodeUserscriptDataCompact} from './buildDataEncoding';
import {normalizePath, type Plugin} from 'vite';

/** 普通、Greasy Fork 与扩展出口沿用原模块；只处理没有 query 或虚拟前缀的精确物理路径。 */
export function createUserscriptAboutImagesCompressionPlugin(root: string, enabled = false, standalone = false): Plugin {
    const sourcePath = enabled
        ? normalizePath(realpathSync(resolve(root, 'src/app/options/aboutImages.ts')))
        : '';
    const imageInput = (relativePath: string) => {
        const image = readFileSync(resolve(root, relativePath));
        const dataUrl = `data:image/jpeg;base64,${image.toString('base64')}`;
        const data = Buffer.from(dataUrl, 'utf8');
        return {
            data,
            baseline: gzipUserscriptBuildData(data, 9, standalone),
            sha256: createHash('sha256').update(image).digest('hex'),
        };
    };
    const encodeImage = (input: ReturnType<typeof imageInput>, bytes: Uint8Array = input.baseline) => ({
        compressed: encodeUserscriptDataCompact(bytes), sha256: input.sha256,
    });
    const compressStandaloneImage = async (input: ReturnType<typeof imageInput>) => {
        const candidate = await gzipLargeStandaloneUserscriptData(input.data, root);
        return encodeImage(input, candidate.byteLength < input.baseline.byteLength ? candidate : input.baseline);
    };
    const emit = (support: ReturnType<typeof encodeImage>, contact: ReturnType<typeof encodeImage>) => [
        `/* Non-code offline JPEG data; approve sha256 ${support.sha256}; contact sha256 ${contact.sha256}. */`,
        "import {inflateWithPako} from '@/userscript/pakoRuntime';",
        "import {decodeUserscriptData} from '@/userscript/dataEncoding';",
        'let supportUrl;',
        'let contactUrl;',
        'export function getSupportImageUrl(_normalUrl) {',
        '    if (supportUrl !== undefined) return supportUrl;',
        `    const restored = inflateWithPako(decodeUserscriptData(${JSON.stringify(support.compressed)}));`,
        '    supportUrl = restored;',
        '    return restored;',
        '}',
        'export function getContactImageUrl() {',
        '    if (contactUrl !== undefined) return contactUrl;',
        `    const restored = inflateWithPako(decodeUserscriptData(${JSON.stringify(contact.compressed)}));`,
        '    contactUrl = restored;',
        '    return restored;',
        '}',
    ].join('\n');
    return {
        name: 'compress-standalone-about-images',
        enforce: 'pre',
        load(id) {
            // 不去掉 query、虚拟前缀或其它路由修饰，避免 raw/proxy 进入替换。
            if (!enabled || normalizePath(id) !== sourcePath) return null;
            const support = imageInput('public/misc/approve.jpg');
            const contact = imageInput('src/app/options/assets/wechat-contact.jpg');
            if (!standalone) return emit(encodeImage(support), encodeImage(contact));
            // 依次压缩，避免同一插件同时创建多个隔离 worker；运行时 getter 仍同步惰性还原。
            return (async () => emit(await compressStandaloneImage(support), await compressStandaloneImage(contact)))();
        },
    };
}
