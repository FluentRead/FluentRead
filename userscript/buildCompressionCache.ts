/**
 * @file userscript/buildCompressionCache.ts
 * 文件职责：缓存独立用户脚本构建期的确定性 gzip 结果，避免重复执行静态资源压缩。
 * 主要内容：按原始字节、构建实现、压缩 worker 和锁文件寻址；复用同进程在途任务，读取时核对摘要和有界解压后的完整输入，损坏缓存重新生成，写入使用同目录临时文件原子替换。
 * 模块边界：缓存仅位于当前工作树的 .wxt，不进入产物；不改变压缩参数、运行时解码、数据内容或体积门槛，构建错误继续向调用者传播。
 */
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {gunzipSync} from 'node:zlib';

const pending = new Map<string, Promise<Buffer>>();
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function optionalSource(file: string): Buffer {
    try {return readFileSync(file);}
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
        throw error;
    }
}

function cachePath(input: Buffer, root: string): string {
    const hash = createHash('sha256').update('fluentread-build-gzip-v1');
    // worker 必须存在；测试根可以只提供自有 worker，生产根另有实现和锁文件。
    hash.update(digest(readFileSync(resolve(root, 'userscript/zopfliBuildWorker.cjs'))));
    for (const name of ['userscript/buildGzip.ts', 'userscript/buildCompressionCache.ts', 'pnpm-lock.yaml']) {
        hash.update(digest(optionalSource(resolve(root, name))));
    }
    hash.update(input);
    return resolve(root, '.wxt/cache/userscript-gzip', `${hash.digest('hex')}.gz`);
}

function restore(file: string, input: Buffer): Buffer | undefined {
    let cached: Buffer;
    try {
        if (statSync(file).size > input.byteLength + 4_096) throw new Error('缓存长度无效');
        cached = readFileSync(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        // 文件权限与其它 I/O 错误不是缓存未命中，保留原始错误。
        if (!(error instanceof Error) || error.message !== '缓存长度无效') throw error;
        console.warn('[userscript-build-cache] 压缩缓存损坏，重新生成');
        return undefined;
    }
    try {
        const compressed = cached.subarray(65);
        if (cached[64] !== 10 || cached.subarray(0, 64).toString('ascii') !== digest(compressed)
            || !gunzipSync(compressed, {maxOutputLength: Math.max(1, input.byteLength)}).equals(input)) {
            throw new Error('缓存内容不匹配');
        }
        return Buffer.from(compressed);
    } catch {
        console.warn('[userscript-build-cache] 压缩缓存损坏，重新生成');
        return undefined;
    }
}

/** FLUENTREAD_BUILD_CACHE=0 用于冷构建对照；两条路径返回相同压缩器的结果。 */
export async function cacheUserscriptBuildGzip(
    data: Uint8Array, root: string, compress: (input: Buffer) => Promise<Buffer>,
): Promise<Buffer> {
    const input = Buffer.from(data);
    if (process.env.FLUENTREAD_BUILD_CACHE === '0') return compress(input);
    const file = cachePath(input, root);
    const previous = pending.get(file);
    if (previous) return Buffer.from(await previous);
    const task = (async () => {
        const cached = restore(file, input);
        if (cached) return cached;
        const compressed = await compress(input);
        if (!gunzipSync(compressed, {maxOutputLength: Math.max(1, input.byteLength)}).equals(input)) {
            throw new Error('构建压缩缓存输入校验失败');
        }
        mkdirSync(dirname(file), {recursive: true});
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
            writeFileSync(temporary, Buffer.concat([Buffer.from(`${digest(compressed)}\n`), compressed]), {flag: 'wx'});
            renameSync(temporary, file);
        } finally {rmSync(temporary, {force: true});}
        return compressed;
    })();
    pending.set(file, task);
    try {return Buffer.from(await task);}
    finally {if (pending.get(file) === task) pending.delete(file);}
}
