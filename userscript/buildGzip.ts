/**
 * @file userscript/buildGzip.ts
 * 文件职责：在 userscript 构建期统一编码静态资源，避免宿主 Node/zlib 编码器版本影响内嵌 gzip 字节。
 * 主要内容：复用锁定的 pako 2.1.0 和 level 9，比较多个 memLevel；独立版增加有限策略比较，较大数据可在构建期通过隔离 worker 使用 Zopfli，输出仍是标准 gzip。
 * 构建成本：每份静态数据增加两次有限压缩，独立版部分数据再比较五次，较大数据还需三次 Zopfli 迭代；运行时仍读取同一标准格式，不增加解码路径。
 * 模块边界：仅供构建配置与插件使用，不改变输入数据、运行时解压端口或产物大小上限；Zopfli 仅为构建依赖。
 */
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {Worker} from 'node:worker_threads';
import {gunzipSync} from 'node:zlib';

const gzip = createRequire(import.meta.url)('pako').gzip as
    (data: Uint8Array, options: {level: 8 | 9; memLevel: 5 | 7 | 8 | 9; strategy?: 1}) => Uint8Array;

export function gzipUserscriptBuildData(data: Uint8Array, filteredLevel?: 8 | 9, standalone = false): Buffer {
    let best = gzip(data, {level: 9, memLevel: 8});
    for (const memLevel of [7, 9] as const) {
        const candidate = gzip(data, {level: 9, memLevel});
        if (candidate.byteLength < best.byteLength) best = candidate;
    }
    if (filteredLevel !== undefined) {
        const filtered = gzip(data, {level:filteredLevel, memLevel:9, strategy:1});
        if (filtered.byteLength < best.byteLength) best = filtered;
    }
    if (standalone) {
        for (const memLevel of [8, 7, 9, 5] as const) {
            const candidate = gzip(data, {level: 9, memLevel, strategy: 1});
            if (candidate.byteLength < best.byteLength) best = candidate;
        }
        const lowMemory = gzip(data, {level: 9, memLevel: 5});
        if (lowMemory.byteLength < best.byteLength) best = lowMemory;
    }
    return Buffer.from(best);
}

/** 仅构建期的较大 standalone 数据使用 Zopfli；结果仍是可由现有 pako 解压的标准 gzip。 */
export async function gzipLargeStandaloneUserscriptData(data: Uint8Array, root: string): Promise<Buffer> {
    const baseline = gzipUserscriptBuildData(data);
    if (data.byteLength < 65_536) return baseline;
    // Zopfli 的 Emscripten 绑定会安装进程级异常监听；只在独立 worker 中载入，
    // 退出时清理整个上下文，避免影响 Vite、测试框架或其它构建插件的错误处理。
    const compact = await new Promise<Buffer>((resolveResult, reject) => {
        const worker = new Worker(resolve(root, 'userscript/zopfliBuildWorker.cjs'), {workerData: data});
        let settled = false;
        const timer = setTimeout(() => fail(new Error('构建压缩器超时')), 60_000);
        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            void worker.terminate().then(() => reject(error), () => reject(error));
        };
        worker.once('message', (value: unknown) => {
            if (!(value instanceof Uint8Array)) {
                fail(new Error('构建压缩器返回了无效数据'));
                return;
            }
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const result = Buffer.from(value);
            void worker.terminate().then(() => resolveResult(result), reject);
        });
        worker.once('error', fail);
        worker.once('exit', code => fail(new Error(`构建压缩器提前退出: ${code}`)));
    });
    if (compact.byteLength >= baseline.byteLength) return baseline;
    if (!gunzipSync(compact).equals(Buffer.from(data))) throw new Error('构建压缩器校验失败');
    return compact;
}
