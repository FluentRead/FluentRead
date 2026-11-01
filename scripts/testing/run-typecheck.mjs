#!/usr/bin/env node
/**
 * @file scripts/testing/run-typecheck.mjs
 * 文件职责：以完整增量检查和有界默认堆预算运行项目的 Vue/TypeScript 编译器。
 * 主要内容：保留显式 NODE_OPTIONS 的堆设置；可见总内存至少 16 GiB 时，为编译子进程默认设置 6 GiB 旧生代上限；复用全局资源锁、取消信号与原始退出码。
 * 模块边界：不修改 shell 或其他构建任务的环境、不排除源码或改变诊断；可见内存快照不是可用内存或进程树硬上限，CI 的独立内存门禁继续执行。
 */
import {createRequire} from 'node:module';
import {totalmem} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {releaseLock, runResourceSafe} from './run-resource-safe.mjs';

const require = createRequire(import.meta.url);
const GIB = 1024 ** 3;

export function selectTypecheckNodeOptions(options, totalMemory, constrainedMemory = 0) {
    if (/(?:^|\s|["'])--max[-_]old[-_]space[-_]size(?:[-_]percentage)?(?:=|\s|["'])/u.test(options ?? '')) return options;
    if (!Number.isFinite(totalMemory) || totalMemory < 16 * GIB
        || !Number.isFinite(constrainedMemory) || constrainedMemory < 0
        || constrainedMemory > 0 && constrainedMemory < 16 * GIB) return options;
    return `${options ? `${options} ` : ''}--max-old-space-size=6144`;
}

async function main() {
    const options = selectTypecheckNodeOptions(process.env.NODE_OPTIONS, totalmem(), process.constrainedMemory?.() ?? 0);
    if (options !== process.env.NODE_OPTIONS) {
        // 只改变当前轻量入口的环境；V8 在启动时读取选项，因此预算作用于后续编译子进程。
        process.env.NODE_OPTIONS = options;
        console.log('[compile] 默认编译旧生代上限 6144 MiB；显式 NODE_OPTIONS 保持优先，未修改 shell 环境');
    }
    process.exitCode = await runResourceSafe(['--', process.execPath, require.resolve('vue-tsc/bin/vue-tsc.js'),
        '--noEmit', '--incremental', '--tsBuildInfoFile', '.wxt/cache/extension.tsbuildinfo', ...process.argv.slice(2)]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(async error => {
        await releaseLock().catch(() => undefined);
        console.error(`[compile] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
