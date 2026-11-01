/**
 * @file scripts/testing/franc-runtime-build.ts
 * 文件职责：在构建副本中延迟锁定 franc-min 的统计模型索引初始化，避免内容脚本启动时建立未使用书写体系的字典。
 * 主要内容：核对完整上游算法摘要，只将数字字典构造移到对应文字第一次实际检测前；保留模型、原始计分、候选排序、过滤和同步 API。
 * 模块边界：只处理 franc-min 6.2.0 的 index.js，不修改依赖文件、数据模块、CSP、语言判定规则或外部请求；userscript 的数据压缩仍由既有纯数据插件负责。
 */
import {createHash} from 'node:crypto';
import type {Plugin} from 'vite';

const FRANC_SOURCE_SHA256 = 'fea38fa2a7a0ce2dc11a5ec2689b573e33d1ba1448548582ae1badc3bb6712c7';
const INITIALIZATION_START = 'for (script in data) {';
const INITIALIZATION_END = '\n/**\n * Get the most probable language';

/** 固定完整算法后移动原有构造循环，不重写模型或计算规则；升级依赖必须先复核。 */
export function patchFrancRuntimeSource(source: string): string {
    if (createHash('sha256').update(source).digest('hex') !== FRANC_SOURCE_SHA256) {
        throw new Error('Unsupported franc-min source: review deferred model initialization before upgrading');
    }
    const start = source.indexOf(INITIALIZATION_START);
    const end = source.indexOf(INITIALIZATION_END, start);
    const loop = source.slice(start, end).replace('if (own.call(data, script)) {',
        'if (script === requestedScript && own.call(data, script)) {');
    return source.slice(0, start)
        + '/* franc-min 6.2.0 (MIT, Titus Wormer): defer only statistical dictionary initialization. */\n'
        + 'function initializeNumericData(requestedScript) {\n'
        + '  if (own.call(numericData, requestedScript)) return\n'
        + loop + '}\n'
        + source.slice(end)
            .replace('!(script[0] in numericData)', '!(script[0] in data)')
            .replace('  /* Get all distances for a given script, and',
                '  initializeNumericData(script[0])\n\n  /* Get all distances for a given script, and');
}

/** 只转换精确算法模块，虚拟代理、query 导入、纯数据和其他包保持既有处理。 */
export function francRuntimeBuildPlugin(): Plugin {
    return {
        name: 'fluentread-deferred-franc-models',
        enforce: 'pre',
        apply: 'build',
        transform(source, id) {
            if (id.includes('\0') || id.includes('?')) return;
            if (!/(?:^|\/)franc-min\/index\.js$/u.test(id.replace(/\\/g, '/'))) return;
            return {code: patchFrancRuntimeSource(source), map: null};
        },
    };
}
