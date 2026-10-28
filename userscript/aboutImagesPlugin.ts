/**
 * @file userscript/aboutImagesPlugin.ts
 * 文件职责：仅为完整独立脚本无损压缩关于页的两张离线 JPEG。
 * 主要内容：精确替换普通图像访问模块，以 ASCII91 保存 gzip 数据，首次显式取用时通过既有 pako 字符串端口恢复完整原 data URL。
 * 模块边界：不改变图像字节或 public 资源，不顶层解压，不新增全局状态、异步加载或网络回退。
 */
import {createHash} from 'node:crypto';
import {readFileSync, realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {gzipUserscriptBuildData} from './buildGzip';
import {encodeUserscriptDataCompact} from './buildDataEncoding';
import {normalizePath, type Plugin} from 'vite';

/** 普通、Greasy Fork 与扩展出口沿用原模块；只处理没有 query 或虚拟前缀的精确物理路径。 */
export function createUserscriptAboutImagesCompressionPlugin(root: string, enabled = false): Plugin {
    const sourcePath = enabled
        ? normalizePath(realpathSync(resolve(root, 'src/app/options/aboutImages.ts')))
        : '';
    const compressImage = (relativePath: string) => {
        const image = readFileSync(resolve(root, relativePath));
        const dataUrl = `data:image/jpeg;base64,${image.toString('base64')}`;
        return {
            compressed: encodeUserscriptDataCompact(gzipUserscriptBuildData(Buffer.from(dataUrl, 'utf8'), 9)),
            sha256: createHash('sha256').update(image).digest('hex'),
        };
    };
    return {
        name: 'compress-standalone-about-images',
        enforce: 'pre',
        load(id) {
            // 不去掉 query、虚拟前缀或其它路由修饰，避免 raw/proxy 进入替换。
            if (!enabled || normalizePath(id) !== sourcePath) return null;
            const support = compressImage('public/misc/approve.jpg');
            const contact = compressImage('src/app/options/assets/wechat-contact.jpg');
            return [
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
        },
    };
}
