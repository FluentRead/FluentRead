#!/usr/bin/env node

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {
    createRegressionReport,
    deriveRegressionStatus,
    refreshRegressionEvidence,
    saveRegressionReport,
} from './regression-report.mjs';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BOOLEAN_FLAGS = new Set(['allow-network', 'browser', 'dry-run', 'fail-fast', 'headed', 'help', 'network']);
const VALUE_FLAGS = new Set([
    'artifacts-dir',
    'browser-path',
    'extension-dir',
    'focus-safe-helper',
    'runtime-diagnostics-helper',
    'playwright-root',
    'timeout',
]);

const LOCAL_BROWSER_FIXTURES = [
    {
        id: 'popup-first-run-height',
        label: 'fresh popup onboarding and main-content height regression',
        script: 'scripts/testing/run-popup-first-run-height-test.cjs',
        backgroundArgs: ['--background'],
        supportsHeaded: false,
    },
    {
        id: 'selection-trigger',
        label: 'selection trigger browser regression',
        script: 'scripts/run-selection-trigger-test.cjs',
        backgroundArgs: ['--background'],
        supportsHeaded: true,
    },
    {
        id: 'full-page-translation',
        label: 'full-page translation browser regression',
        script: 'scripts/run-full-page-translation-test.cjs',
        args: ['--verify-floating-ui', '--verify-loading-style-isolation'],
        backgroundArgs: ['--background'],
        supportsHeaded: true,
    },
    {
        id: 'translation-mutation',
        label: 'translation mutation and control ownership browser regression',
        script: 'scripts/testing/run-translation-mutation-test.cjs',
        backgroundArgs: ['--background'],
        supportsHeaded: false,
    },
    {
        id: 'fixed-height-translation',
        label: 'fixed-height bilingual layout browser regression',
        script: 'scripts/testing/run-fixed-height-translation-test.cjs',
        backgroundArgs: ['--background'],
        supportsHeaded: false,
    },
    {
        id: 'github-spacing',
        label: 'GitHub bilingual title spacing and metadata browser regression',
        script: 'scripts/testing/run-github-spacing-test.cjs',
        backgroundArgs: ['--background'],
        supportsHeaded: false,
    },
    {
        id: 'github-nested-list',
        label: 'GitHub nested Markdown list ownership browser regression',
        script: 'scripts/testing/run-github-nested-list-test.cjs',
        backgroundArgs: ['--background'],
        supportsHeaded: false,
    },
    {
        id: 'github-task-list',
        label: 'GitHub hydrated task list and source preservation browser regression',
        script: 'scripts/testing/run-github-task-list-test.cjs',
        backgroundArgs: ['--background'],
        supportsHeaded: false,
    },
    {
        id: 'video-subtitle-fixture',
        label: 'video subtitle fixture browser regression',
        script: 'scripts/run-video-subtitle-fixture-test.cjs',
        backgroundArgs: ['--background'],
        supportsHeaded: false,
    },
    {
        id: 'document-translation',
        label: 'document translation browser regression',
        script: 'scripts/run-document-translation-test.cjs',
        backgroundArgs: ['--background', 'true'],
        supportsHeaded: false,
    },
    {
        id: 'settings-center-ui',
        label: 'settings center UI browser regression',
        script: 'scripts/testing/run-settings-center-ui-test.cjs',
        backgroundArgs: ['--background'],
        supportsHeaded: false,
    },
    {
        id: 'glossary',
        label: 'glossary browser regression',
        script: 'scripts/run-glossary-test.cjs',
        backgroundArgs: ['--background'],
        supportsHeaded: false,
        supportsTimeout: false,
    },
    {
        id: 'privacy-boundary',
        label: 'privacy boundary browser regression',
        script: 'scripts/run-privacy-boundary-test.cjs',
        backgroundArgs: ['--background'],
        supportsHeaded: true,
    },
    {
        id: 'userscript-smoke',
        label: 'userscript browser smoke regression',
        script: 'scripts/run-userscript-smoke-test.cjs',
        artifact: '.output/userscript/fluent-read.user.js',
        backgroundArgs: ['--background'],
        supportsHeaded: true,
    },
];

const NETWORK_MATRIX = {
    id: 'site-translation-matrix',
    label: 'site translation network matrix',
    script: 'scripts/run-site-translation-matrix.cjs',
    backgroundArgs: ['--background'],
    supportsHeaded: true,
};

function printUsage() {
    console.log([
        '用法: node scripts/testing/run-full-regression.mjs [--dry-run] [--browser] [--network --allow-network] [options]',
        '',
        '默认/local 只执行确定性流水线：audit、prepare、compile、完整 Vitest 与 strict coverage 单轮、Chrome/Firefox/userscript build、docs/Storybook typecheck、build 与产物校验。',
        '',
        '显式门禁：',
        '  --browser                 追加本地真实浏览器 fixtures。',
        '  --network --allow-network 追加真实站点网络矩阵；两者必须同时出现。',
        '  --headed                  只在显式传入时允许 headed fixture，plan 中标注 foreground-authorized。',
        '  --dry-run                 输出执行 plan，不启动测试、构建、浏览器或网络。',
        '  --fail-fast               首个失败或证据不完整后停止；默认继续执行独立检查并汇总。',
        '',
        '报告：summary.md、report.json、repair-plan.md、logs/ 和严格测试/覆盖率原始结果。',
        '失败、跳过、中断或证据不完整均返回非零；产物目录须使用新目录，避免覆盖旧证据。',
        '',
        '浏览器/网络参数：',
        '  --extension-dir <path>       默认 FLUENTREAD_EXTENSION_DIR 或 .output/chrome-mv3',
        '  --playwright-root <path>     默认 PLAYWRIGHT_ROOT',
        '  --browser-path <path>        默认 FLUENTREAD_BROWSER_PATH',
        '  --focus-safe-helper <path>   默认 FLUENTREAD_FOCUS_SAFE_HELPER 或仓库 helper',
        '  --runtime-diagnostics-helper <path> 网络矩阵必需，或设置 FLUENTREAD_RUNTIME_DIAGNOSTICS_HELPER',
        '  --artifacts-dir <path>       默认系统临时目录下的 fluentread-full-regression-*',
        '  --timeout <ms>               传给支持 timeout 的浏览器脚本',
    ].join('\n'));
}

function readOption(argv, index) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`无法识别参数：${token}`);
    const name = token.slice(2);
    if (BOOLEAN_FLAGS.has(name)) return {name, value: true, nextIndex: index};
    if (!VALUE_FLAGS.has(name)) throw new Error(`未知参数：${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`参数缺少值：${token}`);
    return {name, value, nextIndex: index + 1};
}

export function parseCli(argv, env = process.env, runtime = {}) {
    const options = {
        allowNetwork: false,
        browser: false,
        dryRun: false,
        failFast: false,
        headed: false,
        help: false,
        network: false,
        extensionDir: env.FLUENTREAD_EXTENSION_DIR || '.output/chrome-mv3',
        playwrightRoot: env.PLAYWRIGHT_ROOT || '',
        browserPath: env.FLUENTREAD_BROWSER_PATH || '',
        focusSafeHelper: env.FLUENTREAD_FOCUS_SAFE_HELPER || path.join(PROJECT_ROOT, 'scripts/testing/focus-safe-browser.cjs'),
        runtimeDiagnosticsHelper: env.FLUENTREAD_RUNTIME_DIAGNOSTICS_HELPER || '',
        artifactsDir: env.FLUENTREAD_REGRESSION_ARTIFACTS_DIR ||
            path.join(os.tmpdir(), `fluentread-full-regression-${process.pid}-${runtime.now ?? Date.now()}`),
        timeout: env.FLUENTREAD_BROWSER_TIMEOUT || '',
    };

    for (let index = 0; index < argv.length; index += 1) {
        // pnpm run <script> -- <args> 会把分隔符原样传给 Node；它不是 runner 自身的选项。
        if (argv[index] === '--') continue;
        const {name, value, nextIndex} = readOption(argv, index);
        index = nextIndex;
        switch (name) {
            case 'allow-network':
                options.allowNetwork = true;
                break;
            case 'browser':
                options.browser = true;
                break;
            case 'dry-run':
                options.dryRun = true;
                break;
            case 'fail-fast':
                options.failFast = true;
                break;
            case 'headed':
                options.headed = true;
                break;
            case 'help':
                options.help = true;
                break;
            case 'network':
                options.network = true;
                break;
            case 'artifacts-dir':
                options.artifactsDir = value;
                break;
            case 'browser-path':
                options.browserPath = value;
                break;
            case 'extension-dir':
                options.extensionDir = value;
                break;
            case 'focus-safe-helper':
                options.focusSafeHelper = value;
                break;
            case 'runtime-diagnostics-helper':
                options.runtimeDiagnosticsHelper = value;
                break;
            case 'playwright-root':
                options.playwrightRoot = value;
                break;
            case 'timeout':
                options.timeout = value;
                break;
            default:
                throw new Error(`未知参数：--${name}`);
        }
    }

    return normalizeOptions(options);
}

function normalizeOptions(options) {
    const normalized = {
        ...options,
        artifactsDir: path.resolve(options.artifactsDir),
        extensionDir: path.resolve(options.extensionDir),
        focusSafeHelper: options.focusSafeHelper ? path.resolve(options.focusSafeHelper) : '',
        runtimeDiagnosticsHelper: options.runtimeDiagnosticsHelper ? path.resolve(options.runtimeDiagnosticsHelper) : '',
        playwrightRoot: options.playwrightRoot ? path.resolve(options.playwrightRoot) : '',
        browserPath: options.browserPath ? path.resolve(options.browserPath) : '',
        timeout: options.timeout ? String(options.timeout) : '',
    };

    if (normalized.help) return normalized;
    if (normalized.allowNetwork && !normalized.network) {
        throw new Error('--allow-network 只能和 --network 同时使用，避免把授权标志误认为已运行网络矩阵');
    }
    if (normalized.network && !normalized.allowNetwork) {
        throw new Error('真实站点矩阵必须同时传入 --network 和 --allow-network');
    }
    if (normalized.headed && !normalized.browser && !normalized.network) {
        throw new Error('--headed 只对显式 --browser 或 --network 运行有效');
    }
    if ((normalized.browser || normalized.network) && !normalized.playwrightRoot) {
        throw new Error('浏览器/网络回归必须传入 --playwright-root 或设置 PLAYWRIGHT_ROOT');
    }
    if ((normalized.browser || normalized.network) && !normalized.browserPath) {
        throw new Error('浏览器/网络回归必须传入 --browser-path 或设置 FLUENTREAD_BROWSER_PATH');
    }
    if ((normalized.browser || normalized.network) && !normalized.focusSafeHelper) {
        throw new Error('后台浏览器/网络回归必须传入 --focus-safe-helper 或设置 FLUENTREAD_FOCUS_SAFE_HELPER');
    }
    if (normalized.network && !normalized.runtimeDiagnosticsHelper) {
        throw new Error('真实站点矩阵必须传入 --runtime-diagnostics-helper 或设置 FLUENTREAD_RUNTIME_DIAGNOSTICS_HELPER');
    }
    return normalized;
}

function step({id, phase, label, command, args, policy = {}, gates = [], dependsOn = []}) {
    return {id, phase, label, command, args, gates, dependsOn, ...policy};
}

function deterministicSteps(options) {
    return [
        step({
            id: 'test-suite-audit',
            phase: 'local',
            label: 'test suite audit',
            command: 'node',
            args: ['scripts/testing/audit-test-suite.mjs'],
        }),
        step({
            id: 'wxt-prepare',
            phase: 'local',
            label: 'wxt prepare',
            command: 'pnpm',
            args: ['exec', 'wxt', 'prepare'],
        }),
        step({
            id: 'compile',
            phase: 'local',
            label: 'compile',
            command: 'pnpm',
            args: ['compile'],
            dependsOn: ['wxt-prepare'],
        }),
        step({
            id: 'strict-coverage',
            phase: 'local',
            label: 'complete Vitest suite with strict coverage',
            command: 'pnpm',
            args: [
                'exec', 'vitest', 'run', '--coverage', '--config', 'tests/config/vitest.coverage.config.ts',
                '--reporter=default', '--reporter=json',
                `--outputFile=${path.join(options.artifactsDir, 'vitest-results.json')}`,
                `--coverage.reportsDirectory=${path.join(options.artifactsDir, 'coverage')}`,
                '--coverage.reportOnFailure',
            ],
            dependsOn: ['wxt-prepare'],
        }),
        step({
            id: 'chrome-build',
            phase: 'local',
            label: 'chrome build',
            command: 'pnpm',
            args: ['build'],
            dependsOn: ['wxt-prepare'],
        }),
        step({
            id: 'firefox-build',
            phase: 'local',
            label: 'firefox build',
            command: 'pnpm',
            args: ['build:firefox'],
            dependsOn: ['wxt-prepare'],
        }),
        step({
            id: 'firefox-zip',
            phase: 'local',
            label: 'firefox release archives',
            command: 'pnpm',
            args: ['zip:firefox'],
            dependsOn: ['wxt-prepare'],
        }),
        step({
            id: 'extension-manifest-verifier',
            phase: 'local',
            label: 'Chrome/Firefox manifest capability verifier',
            command: 'node',
            args: ['scripts/testing/verify-extension-manifests.mjs', '--require-firefox-archives'],
            dependsOn: ['chrome-build', 'firefox-zip'],
        }),
        step({
            id: 'userscript-build',
            phase: 'local',
            label: 'userscript build',
            command: 'pnpm',
            args: ['build:userscript'],
            dependsOn: ['wxt-prepare'],
        }),
        step({
            id: 'userscript-verifier',
            phase: 'local',
            label: 'userscript verifier',
            command: 'node',
            args: ['scripts/verify-userscript-build.mjs'],
            dependsOn: ['userscript-build'],
        }),
        step({
            id: 'docs-typecheck',
            phase: 'local',
            label: 'docs typecheck',
            command: 'pnpm',
            args: ['docs:typecheck'],
            dependsOn: ['wxt-prepare'],
        }),
        step({
            id: 'storybook-typecheck',
            phase: 'local',
            label: 'storybook typecheck',
            command: 'pnpm',
            args: ['storybook:typecheck'],
            dependsOn: ['wxt-prepare'],
        }),
        step({
            id: 'docs-build',
            phase: 'local',
            label: 'docs build',
            command: 'pnpm',
            args: ['docs:build'],
            dependsOn: ['wxt-prepare'],
        }),
        step({
            id: 'storybook-build',
            phase: 'local',
            label: 'storybook build',
            command: 'pnpm',
            args: ['storybook:build'],
            dependsOn: ['wxt-prepare'],
        }),
        step({
            id: 'storybook-verifier',
            phase: 'local',
            label: 'storybook artifact verifier',
            command: 'pnpm',
            args: ['storybook:check'],
            dependsOn: ['storybook-build'],
        }),
        step({
            id: 'docs-verifier',
            phase: 'local',
            label: 'docs shipped artifact verifier',
            command: 'pnpm',
            args: ['docs:check'],
            dependsOn: ['docs-build', 'storybook-build'],
        }),
    ];
}

function browserFixtureArgs(fixture, options) {
    const args = [
        fixture.script,
        '--playwright-root', options.playwrightRoot,
        '--browser-path', options.browserPath,
        '--artifacts-dir', path.join(options.artifactsDir, fixture.id),
    ];
    if (fixture.artifact) {
        args.push('--artifact', path.resolve(PROJECT_ROOT, fixture.artifact));
    } else {
        args.push('--extension-dir', options.extensionDir);
    }
    if (options.timeout && fixture.supportsTimeout !== false) args.push('--timeout', options.timeout);
    if (fixture.args) args.push(...fixture.args);

    if (options.headed && fixture.supportsHeaded) {
        args.push('--headed');
    } else {
        args.push(...fixture.backgroundArgs);
        args.push('--focus-safe-helper', options.focusSafeHelper);
    }
    return args;
}

function browserPolicy(fixture, options) {
    if (options.headed && fixture.supportsHeaded) {
        return {
            launchMode: 'playwright-headed',
            focusPolicy: 'foreground-authorized',
            windowPlacement: {state: 'normal'},
        };
    }
    return {
        launchMode: 'macos-background-cdp',
        focusPolicy: 'launchservices-no-foreground',
        windowPlacement: {state: 'normal', mode: 'background-visible-no-focus'},
    };
}

function browserSteps(options) {
    return LOCAL_BROWSER_FIXTURES.map((fixture) => step({
        id: fixture.id,
        phase: 'browser',
        label: fixture.label,
        command: 'node',
        args: browserFixtureArgs(fixture, options),
        gates: ['--browser'],
        dependsOn: fixture.artifact ? ['userscript-build', 'userscript-verifier'] : ['chrome-build'],
        policy: {
            ...browserPolicy(fixture, options),
            artifactsDir: path.join(options.artifactsDir, fixture.id),
        },
    }));
}

function networkSteps(options) {
    const fixture = NETWORK_MATRIX;
    return [step({
        id: fixture.id,
        phase: 'network',
        label: fixture.label,
        command: 'node',
        args: [
            fixture.script,
            '--extension-dir', options.extensionDir,
            '--playwright-root', options.playwrightRoot,
            '--browser-path', options.browserPath,
            '--artifacts-dir', path.join(options.artifactsDir, fixture.id),
            '--allow-network',
            '--runtime-diagnostics-helper', options.runtimeDiagnosticsHelper,
            ...(options.timeout ? ['--timeout', options.timeout] : []),
            ...(options.headed && fixture.supportsHeaded
                ? ['--headed']
                : [...fixture.backgroundArgs, '--focus-safe-helper', options.focusSafeHelper]),
        ],
        gates: ['--network', '--allow-network'],
        dependsOn: ['chrome-build'],
        policy: {
            ...browserPolicy(fixture, options),
            artifactsDir: path.join(options.artifactsDir, fixture.id),
            networkPolicy: 'explicit-allow-network',
        },
    })];
}

export function buildPlan(options) {
    const steps = deterministicSteps(options);
    if (options.browser) steps.push(...browserSteps(options));
    if (options.network) steps.push(...networkSteps(options));
    return {
        version: 3,
        mode: [
            'local',
            options.browser ? 'browser' : null,
            options.network ? 'network' : null,
            options.headed ? 'headed' : null,
        ].filter(Boolean).join('+'),
        dryRun: options.dryRun,
        failFast: options.failFast,
        artifactsDir: options.artifactsDir,
        policies: {
            local: 'deterministic',
            browser: options.browser ? 'explicit-browser-gate' : 'disabled',
            network: options.network ? 'explicit-network-and-allow-network-gates' : 'disabled',
            headed: options.headed ? 'foreground-authorized' : 'disabled',
        },
        steps,
    };
}

function validatePlan(plan) {
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) throw new Error('回归 plan 必须包含检查步骤');
    if (typeof plan.artifactsDir !== 'string' || !path.isAbsolute(plan.artifactsDir)) {
        throw new Error('回归产物目录必须使用绝对路径');
    }
    const seen = new Set();
    for (const currentStep of plan.steps) {
        if (typeof currentStep.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(currentStep.id) || seen.has(currentStep.id)) {
            throw new Error(`回归步骤 ID 非法或重复：${currentStep.id}`);
        }
        if (typeof currentStep.command !== 'string' || !currentStep.command ||
            !Array.isArray(currentStep.args) || currentStep.args.some((argument) => typeof argument !== 'string')) {
            throw new Error(`回归步骤命令非法：${currentStep.id}`);
        }
        if (!Array.isArray(currentStep.dependsOn ?? []) ||
            (currentStep.dependsOn ?? []).some((dependency) => !seen.has(dependency))) {
            throw new Error(`回归依赖必须是前置步骤：${currentStep.id}`);
        }
        seen.add(currentStep.id);
    }
}

function claimArtifactsDirectory(artifactsDir) {
    fs.mkdirSync(artifactsDir, {recursive: true});
    const lockPath = path.join(artifactsDir, '.regression.lock');
    const descriptor = fs.openSync(lockPath, 'wx');
    try {
        fs.writeFileSync(descriptor, JSON.stringify({pid: process.pid, startedAt: new Date().toISOString()}));
        if (fs.readdirSync(artifactsDir).some((name) => name !== '.regression.lock')) {
            throw new Error('回归产物目录已包含运行证据，请指定新目录以保留原报告');
        }
        fs.mkdirSync(path.join(artifactsDir, 'logs'));
    } catch (error) {
        fs.closeSync(descriptor);
        fs.unlinkSync(lockPath);
        throw error;
    }
    return () => {
        fs.closeSync(descriptor);
        fs.unlinkSync(lockPath);
    };
}

function forwardSignal(child, signal) {
    if (!child?.pid) return;
    try {
        // 只转发当前步骤拥有的进程组。资源包装器会继续转发到其独立子进程组并释放锁。
        process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
    } catch (error) {
        if (error.code !== 'ESRCH') child.kill(signal);
    }
}

async function runStep(currentStep, runtime, interruption) {
    const descriptor = fs.openSync(currentStep.logPath, 'wx');
    const started = Date.now();
    currentStep.startedAt = new Date(started).toISOString();
    currentStep.status = 'running';
    let spawnError;
    try {
        if (!runtime.outputError) runtime.stdout.write(`\n[regression] ${currentStep.label || currentStep.id} -> ${currentStep.command} ${currentStep.args.join(' ')}\n`);
        const child = spawn(currentStep.command, currentStep.args, {
            cwd: runtime.cwd,
            env: runtime.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
            detached: process.platform !== 'win32',
        });
        runtime.child = child;
        const copyOutput = (destination) => (chunk) => {
            try {
                fs.writeSync(descriptor, chunk);
                if (!runtime.outputError) destination.write(chunk);
            } catch (error) {
                spawnError ??= error;
                forwardSignal(child, 'SIGTERM');
            }
        };
        child.stdout.on('data', copyOutput(runtime.stdout));
        child.stderr.on('data', copyOutput(runtime.stderr));
        const result = await new Promise((resolve) => {
            child.once('error', (error) => {spawnError = error;});
            child.once('close', (exitCode, signal) => resolve({exitCode, signal}));
        });
        Object.assign(currentStep, result);
        currentStep.status = interruption.signal ? 'interrupted' :
            (result.exitCode === 0 && !spawnError && !runtime.outputError ? 'passed' : 'failed');
        if (spawnError) currentStep.error = spawnError.message;
        else if (runtime.outputError) currentStep.error = runtime.outputError;
    } catch (error) {
        currentStep.status = interruption.signal ? 'interrupted' : 'failed';
        currentStep.error = error instanceof Error ? error.message : String(error);
    } finally {
        runtime.child = null;
        currentStep.finishedAt = new Date().toISOString();
        currentStep.durationMs = Date.now() - started;
        if (currentStep.error) fs.writeSync(descriptor, `\n[runner error] ${currentStep.error}\n`);
        fs.closeSync(descriptor);
    }
}

export async function executePlan(plan, options = {}) {
    const runtime = {
        cwd: options.cwd ?? PROJECT_ROOT,
        env: options.env ?? process.env,
        stdout: options.stdout ?? process.stdout,
        stderr: options.stderr ?? process.stderr,
        child: null,
    };
    if (plan.dryRun) {
        runtime.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
        return;
    }
    validatePlan(plan);
    const release = claimArtifactsDirectory(plan.artifactsDir);
    const started = Date.now();
    const interruption = {};
    let report;
    try {
        report = createRegressionReport(plan, {cwd: runtime.cwd, env: runtime.env, now: started});
    } catch (error) {
        release();
        throw error;
    }
    const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => {
        interruption.signal ??= signal;
        report.interruption ??= {signal, at: new Date().toISOString()};
        report.status = 'interrupted';
        try {
            saveRegressionReport(report);
        } catch (error) {
            report.executionError = error instanceof Error ? error.message : String(error);
        }
        forwardSignal(runtime.child, signal);
    }]));
    const outputStreams = [...new Set([runtime.stdout, runtime.stderr])];
    const onOutputError = (error) => {
        runtime.outputError ??= error instanceof Error ? error.message : String(error);
        report.executionError ??= `终端输出失败：${runtime.outputError}`;
        forwardSignal(runtime.child, 'SIGTERM');
    };
    const flushOutput = async () => {
        await Promise.all(outputStreams.filter((stream) => typeof stream.on === 'function').map((stream) =>
            new Promise((resolve) => {
                if (stream.destroyed) return resolve();
                try {
                    stream.write('', (error) => {
                        if (error) onOutputError(error);
                        resolve();
                    });
                } catch (error) {
                    onOutputError(error);
                    resolve();
                }
            })));
        // Writable 的写回调可能先于 error 事件；保持监听到该事件被消费。
        await new Promise((resolve) => setImmediate(resolve));
    };
    try {
        for (const [signal, handler] of handlers) process.on(signal, handler);
        for (const stream of outputStreams) stream.on?.('error', onOutputError);
        saveRegressionReport(report);
        let stopped = false;
        const completed = new Map();
        for (const currentStep of report.steps) {
            if (interruption.signal || stopped || runtime.outputError) {
                currentStep.status = 'not-run';
                currentStep.reason = interruption.signal ? `运行收到 ${interruption.signal}` :
                    (runtime.outputError ? '终端输出失败，运行已停止' : '--fail-fast 在前一项失败或证据不完整后停止');
            } else {
                const blockedBy = (currentStep.dependsOn ?? []).filter((id) => completed.get(id)?.status !== 'passed');
                if (blockedBy.length) {
                    currentStep.status = 'blocked';
                    currentStep.blockedBy = blockedBy;
                    currentStep.reason = `前置步骤未通过：${blockedBy.join(', ')}`;
                } else {
                    currentStep.logPath = path.join(plan.artifactsDir, 'logs', `${currentStep.id}.log`);
                    await runStep(currentStep, runtime, interruption);
                    if (currentStep.id === 'strict-coverage') refreshRegressionEvidence(report);
                }
                stopped = Boolean(plan.failFast && (currentStep.status !== 'passed' ||
                    (currentStep.id === 'strict-coverage' && deriveRegressionStatus({...report, steps: [currentStep]}) !== 'passed')));
            }
            completed.set(currentStep.id, currentStep);
            saveRegressionReport(report);
        }
    } catch (error) {
        report.executionError = error instanceof Error ? error.message : String(error);
        for (const currentStep of report.steps) {
            if (currentStep.status === 'pending' || currentStep.status === 'running') {
                currentStep.status = 'not-run';
                currentStep.reason = `运行器错误：${report.executionError}`;
            }
        }
    } finally {
        try {
            await flushOutput();
            report.finishedAt = new Date().toISOString();
            report.durationMs = Date.now() - started;
            refreshRegressionEvidence(report);
            report.status = deriveRegressionStatus(report);
            saveRegressionReport(report);
            if (!runtime.outputError) {
                runtime.stdout.write(`\n[regression] ${report.status}\n总报告：${report.paths.summary}\n修复清单：${report.paths.repairPlan}\n`);
                await flushOutput();
                if (runtime.outputError) saveRegressionReport(report);
            }
        } finally {
            for (const [signal, handler] of handlers) process.off(signal, handler);
            for (const stream of outputStreams) stream.off?.('error', onOutputError);
            release();
        }
    }
    return report;
}

async function main(argv = process.argv.slice(2)) {
    const options = parseCli(argv);
    if (options.help) {
        printUsage();
        return;
    }
    const report = await executePlan(buildPlan(options));
    if (report && report.status !== 'passed') {
        process.exitCode = report.interruption?.signal === 'SIGINT' ? 130 :
            (report.interruption?.signal === 'SIGTERM' ? 143 : 1);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(`[full-regression] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
