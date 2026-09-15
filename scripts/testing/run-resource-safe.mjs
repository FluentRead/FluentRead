#!/usr/bin/env node

import {mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const DEFAULT_CPU_TARGET_PERCENT = 60;
export const DEFAULT_MAX_WORKERS = 2;
export const DEFAULT_LOCK_WAIT_MS = 30 * 60 * 1000;
const DEFAULT_RETRY_MS = 1000;
const STALE_LOCK_MS = 10 * 60 * 1000;
const LOCK_ROOT = process.env.FLUENTREAD_RESOURCE_LOCK_DIR || path.join(os.tmpdir(), 'fluentread-test-resource');
const LOCK_DIR = path.join(LOCK_ROOT, 'lock');
const OWNER_FILE = path.join(LOCK_DIR, 'owner.json');
let ownedToken;

// macOS does not provide a reliable portable percentage cap here; reserve capacity cooperatively.

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedPercent(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 10 && parsed <= 90 ? parsed : fallback;
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function usage() {
    console.log([
        '用法: node scripts/testing/run-resource-safe.mjs [options] -- <command> [args...]',
        '',
        `默认 CPU target: ${DEFAULT_CPU_TARGET_PERCENT}%`,
        `默认 Vitest maxWorkers: ${DEFAULT_MAX_WORKERS}`,
        '',
        '选项:',
        '  --cpu-target <10-90>  设置资源预算目标（通过全局锁和 worker 限制实现）',
        '  --max-workers <n>     传给子进程的 FLUENTREAD_TEST_MAX_WORKERS',
        '  --wait-ms <n>         等待全局测试锁的最长时间',
        '  --help                显示帮助',
    ].join('\n'));
}

export function parseArgs(argv) {
    const separator = argv.indexOf('--');
    const optionArgs = separator === -1 ? argv : argv.slice(0, separator);
    const commandArgs = separator === -1 ? [] : argv.slice(separator + 1);
    // pnpm test -- <file> 的首个转发分隔符只对 Vitest CLI 多余；其他命令和
    // 参数内部的 -- 有自己的语义，不能统一删除。
    const forwardedSeparator = commandArgs.indexOf('--', 1);
    if (/^(?:vitest|vitest\.cmd)$/u.test(path.basename(commandArgs[0] ?? '')) && forwardedSeparator >= 0) {
        commandArgs.splice(forwardedSeparator, 1);
    }
    let cpuTargetPercent = boundedPercent(process.env.FLUENTREAD_TEST_CPU_TARGET, DEFAULT_CPU_TARGET_PERCENT);
    let maxWorkers = positiveInteger(process.env.FLUENTREAD_TEST_MAX_WORKERS, DEFAULT_MAX_WORKERS);
    let waitMs = positiveInteger(process.env.FLUENTREAD_TEST_LOCK_WAIT_MS, DEFAULT_LOCK_WAIT_MS);

    for (let index = 0; index < optionArgs.length; index += 1) {
        const option = optionArgs[index];
        if (option === '--help') return {help: true};
        if (!option.startsWith('--')) throw new Error(`无法识别参数: ${option}`);
        const value = optionArgs[index + 1];
        if (value === undefined || value.startsWith('--')) throw new Error(`参数缺少值: ${option}`);
        if (option === '--cpu-target') cpuTargetPercent = boundedPercent(value, NaN);
        else if (option === '--max-workers') maxWorkers = positiveInteger(value, NaN);
        else if (option === '--wait-ms') waitMs = positiveInteger(value, NaN);
        else throw new Error(`无法识别参数: ${option}`);
        if (!Number.isFinite(cpuTargetPercent) && option === '--cpu-target') throw new Error('--cpu-target 必须是 10-90 的数字');
        if (!Number.isInteger(maxWorkers) || maxWorkers < 1) throw new Error('--max-workers 必须是正整数');
        if (!Number.isInteger(waitMs) || waitMs < 1) throw new Error('--wait-ms 必须是正整数');
        index += 1;
    }

    if (commandArgs.length === 0) throw new Error('必须在 -- 后提供要运行的命令');
    return {command: commandArgs[0], args: commandArgs.slice(1), cpuTargetPercent, maxWorkers, waitMs};
}

export function createResourceOptions(command, args = []) {
    return {
        command,
        args,
        cpuTargetPercent: boundedPercent(process.env.FLUENTREAD_TEST_CPU_TARGET, DEFAULT_CPU_TARGET_PERCENT),
        maxWorkers: positiveInteger(process.env.FLUENTREAD_TEST_MAX_WORKERS, DEFAULT_MAX_WORKERS),
        waitMs: positiveInteger(process.env.FLUENTREAD_TEST_LOCK_WAIT_MS, DEFAULT_LOCK_WAIT_MS),
    };
}

async function readOwner() {
    try {
        return JSON.parse(await readFile(OWNER_FILE, 'utf8'));
    } catch {
        return null;
    }
}

function processIsRunning(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

async function removeStaleLock() {
    // 先固定锁目录这一代的 inode，再读取 owner；二者都来自同一代时才可能判定为陈旧。
    let lockStat;
    try {
        lockStat = await stat(LOCK_DIR);
    } catch (error) {
        if (error?.code === 'ENOENT') return true;
        throw error;
    }
    const owner = await readOwner();
    if (owner?.pid && processIsRunning(owner.pid)) return false;
    if (!owner && Date.now() - lockStat.mtimeMs < STALE_LOCK_MS) return false;
    // 多个等待者不能同时删除旧锁：在锁目录内部竞争一次清理权，随后重读
    // owner 和 inode，避免晚到的清理者误删另一个进程刚建立的新锁。
    const reaping = path.join(LOCK_DIR, 'reaping');
    try {
        await mkdir(reaping);
    } catch (error) {
        if (error?.code === 'ENOENT') return true;
        if (error?.code === 'EEXIST') return false;
        throw error;
    }
    let reaped = false;
    try {
        const currentStat = await stat(LOCK_DIR);
        const currentOwner = await readOwner();
        // owner 与首次读取不同，说明中途换代或新锁仍在写 owner，不能按陈旧锁回收。
        if (currentStat.ino !== lockStat.ino || currentStat.dev !== lockStat.dev ||
            JSON.stringify(currentOwner) !== JSON.stringify(owner) ||
            processIsRunning(currentOwner?.pid)) return false;
        // 原子改名让整代锁一次性消失；原地递归删除时 reaping 已删而目录仍在，
        // 其他等待者可再建 reaping，使 rmdir 以 ENOTEMPTY 失败并让等待进程崩溃。
        const tombstone = path.join(LOCK_ROOT, `reaped-${randomUUID()}`);
        await rename(LOCK_DIR, tombstone);
        reaped = true;
        await rm(tombstone, {recursive: true, force: true}).catch(() => undefined);
        return true;
    } finally {
        if (!reaped) {
            const currentStat = await stat(LOCK_DIR).catch(() => undefined);
            if (currentStat?.ino === lockStat.ino && currentStat.dev === lockStat.dev) {
                await rm(reaping, {recursive: true, force: true});
            }
        }
    }
}

export async function acquireLock(options) {
    await mkdir(LOCK_ROOT, {recursive: true});
    const deadline = Date.now() + options.waitMs;
    let announcedWait = false;
    while (true) {
        try {
            await mkdir(LOCK_DIR);
            ownedToken = randomUUID();
            await writeFile(OWNER_FILE, JSON.stringify({
                pid: process.pid,
                token: ownedToken,
                cwd: process.cwd(),
                command: [options.command, ...options.args].join(' '),
                cpuTargetPercent: options.cpuTargetPercent,
                maxWorkers: options.maxWorkers,
                startedAt: new Date().toISOString(),
            }, null, 2));
            return;
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            if (await removeStaleLock()) continue;
            if (!announcedWait) {
                const owner = await readOwner();
                console.error(`[resource-safe] 等待全局测试锁${owner?.command ? `（当前: ${owner.command}）` : ''}`);
                announcedWait = true;
            }
            if (Date.now() >= deadline) throw new Error(`等待全局测试锁超过 ${options.waitMs}ms`);
            await delay(DEFAULT_RETRY_MS);
        }
    }
}

export async function releaseLock() {
    const owner = await readOwner();
    if (ownedToken && owner?.pid === process.pid && owner.token === ownedToken) {
        await rm(LOCK_DIR, {recursive: true, force: true});
        ownedToken = undefined;
    }
}

export async function hasInheritedLock() {
    if (process.env.FLUENTREAD_RESOURCE_LOCK_HELD !== '1') return false;
    const owner = await readOwner();
    return Boolean(owner?.token && owner.token === process.env.FLUENTREAD_RESOURCE_LOCK_TOKEN &&
        processIsRunning(owner.pid));
}

function signalProcessGroup(child, signal) {
    if (!child?.pid) return;
    try {
        process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
    } catch {
        try {
            process.kill(child.pid, signal);
        } catch {
            // The child may have exited between the two signal attempts.
        }
    }
}

async function runChild(options) {
    const env = {
        ...process.env,
        FLUENTREAD_RESOURCE_LOCK_HELD: '1',
        FLUENTREAD_RESOURCE_LOCK_TOKEN: ownedToken || process.env.FLUENTREAD_RESOURCE_LOCK_TOKEN,
        FLUENTREAD_TEST_CPU_TARGET: String(options.cpuTargetPercent),
        FLUENTREAD_TEST_MAX_WORKERS: String(options.maxWorkers),
    };
    console.log(`[resource-safe] CPU target ${options.cpuTargetPercent}%, maxWorkers ${options.maxWorkers}, command: ${options.command} ${options.args.join(' ')}`);
    return new Promise((resolve, reject) => {
        const child = spawn(options.command, options.args, {
            cwd: PROJECT_ROOT,
            env,
            stdio: 'inherit',
            shell: false,
            detached: process.platform !== 'win32',
        });
        const signalHandlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal =>
            [signal, () => signalProcessGroup(child, signal)]));
        for (const [signal, handler] of signalHandlers) process.on(signal, handler);
        child.once('error', (error) => {
            for (const [signal, handler] of signalHandlers) process.off(signal, handler);
            reject(error);
        });
        child.once('close', (code, signal) => {
            for (const [handledSignal, handler] of signalHandlers) process.off(handledSignal, handler);
            resolve({code, signal});
        });
    });
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        usage();
        return 0;
    }
    if (await hasInheritedLock()) {
        const result = await runChild(options);
        return result.code ?? 128 + (os.constants.signals[result.signal] || 1);
    }
    await acquireLock(options);
    try {
        const result = await runChild(options);
        return result.code ?? 128 + (os.constants.signals[result.signal] || 1);
    } finally {
        await releaseLock();
    }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    main().then((code) => {
        process.exitCode = code;
    }).catch(async (error) => {
        await releaseLock().catch(() => {});
        console.error(`[resource-safe] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
