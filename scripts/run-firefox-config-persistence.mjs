#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {randomUUID} from 'node:crypto';
import {connect} from '../node_modules/.pnpm/web-ext-run@0.2.4/node_modules/web-ext-run/lib/firefox/remote.js';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
    const key = process.argv[index];
    if (!key.startsWith('--')) continue;
    args.set(key.slice(2), process.argv[index + 1] || '');
    index += 1;
}

const port = Number(args.get('port') || 50593);
const artifactsDir = path.resolve(args.get('artifacts-dir') || '/private/tmp/fluentread-firefox-persistence-20260816');
fs.mkdirSync(artifactsDir, {recursive: true});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function packetFromError(error) {
    const message = String(error?.message || error);
    const start = message.indexOf('{');
    if (start < 0) return null;
    try {
        return JSON.parse(message.slice(start));
    } catch {
        return null;
    }
}

async function selectedTab(client) {
    const response = await client.request('listTabs');
    return response.tabs.find(tab => tab.selected) || response.tabs[0];
}

async function selectedFrame(client) {
    const tab = await selectedTab(client);
    const target = await client.request({to: tab.actor, type: 'getTarget'});
    return {tab, frame: target.frame};
}

async function evaluate(client, frame, source) {
    let resultPacket;
    const onError = error => {
        const packet = packetFromError(error);
        if (packet?.type === 'evaluationResult') resultPacket = packet;
    };
    client.on('error', onError);
    try {
        const response = await client.request({
            to: frame.consoleActor,
            type: 'evaluateJSAsync',
            text: source,
            frameActor: frame.actor,
        });
        const deadline = Date.now() + 10000;
        while (!resultPacket && Date.now() < deadline) await sleep(25);
        if (!resultPacket) throw new Error(`Firefox RDP evaluation timeout: ${response.resultID}`);
        if (resultPacket.hasException) throw new Error(`Firefox RDP evaluation failed: ${JSON.stringify(resultPacket)}`);
        return resultPacket.result;
    } finally {
        client.off('error', onError);
    }
}

async function evaluateJson(client, frame, source) {
    const value = await evaluate(client, frame, `JSON.stringify(${source})`);
    const serialized = value && typeof value === 'object' && 'value' in value ? value.value : value;
    if (typeof serialized !== 'string') return serialized;
    return JSON.parse(serialized);
}

async function evaluateAsyncJson(client, frame, source) {
    const marker = '__fluentReadRdpAsyncResult';
    await evaluate(client, frame, `(() => {
        globalThis.${marker} = {pending: true};
        Promise.resolve().then(() => (${source})).then(
            value => { globalThis.${marker} = {pending: false, value}; },
            error => { globalThis.${marker} = {pending: false, error: String(error)}; },
        );
        return true;
    })()`);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        const current = await selectedFrame(client);
        const state = await evaluateJson(client, current.frame, `globalThis.${marker}`);
        if (!state?.pending) {
            if (state?.error) throw new Error(`Firefox async evaluation failed: ${state.error}`);
            return state?.value;
        }
        await sleep(50);
    }
    throw new Error('Firefox async evaluation timeout');
}

const CONFIG_PROJECTION_SOURCE = `browser.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}).then(response => {
    if (response?.success !== true) throw new Error(response?.error || 'configStorageRead failed');
    const value = response.value;
    return {on: value?.on, from: value?.from, to: value?.to, service: value?.service, style: value?.style, display: value?.display, theme: value?.theme};
})`;

function readConfigProjection(client, frame) {
    return evaluateAsyncJson(client, frame, CONFIG_PROJECTION_SOURCE);
}

const CREDENTIAL_FIELDS = [
    'token',
    'ak',
    'sk',
    'appid',
    'key',
    'youdaoAppKey',
    'youdaoAppSecret',
    'tencentSecretId',
    'tencentSecretKey',
    'extra',
];

function credentialStorageSnapshotSource(sentinel) {
    return `(async () => {
        const read = async key => {
            const response = await browser.runtime.sendMessage({type: 'configStorageRead', key});
            if (response?.success !== true) throw new Error(response?.error || 'configStorageRead failed: ' + key);
            return response.value ?? null;
        };
        const readOptional = async key => {
            try {
                return {available: true, value: await read(key)};
            } catch (error) {
                return {available: false, value: null, error: String(error)};
            }
        };
        const [config, history, localCredentials, sessionResult] = await Promise.all([
            read('local:config'),
            read('local:configHistory'),
            read('local:credentials'),
            readOptional('session:credentials'),
        ]);
        const sessionCredentials = sessionResult.value;
        const database = await new Promise((resolve, reject) => {
            const request = indexedDB.open('FluentReadConfiguration');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        let rawRecords;
        try {
            rawRecords = await new Promise((resolve, reject) => {
                const request = database.transaction('records', 'readonly').objectStore('records').getAll();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        } finally {
            database.close();
        }
        const credentialFields = ${JSON.stringify(CREDENTIAL_FIELDS)};
        const requiredEncryptedRecordKeys = ['local:config', 'local:configHistory'];
        const historyConfigs = Array.isArray(history?.entries)
            ? history.entries.map(entry => entry?.config).filter(Boolean)
            : [];
        const containsSentinel = value => JSON.stringify(value ?? null).includes(${JSON.stringify(sentinel)});
        return {
            sessionAvailable: sessionResult.available,
            sessionReadError: sessionResult.error || null,
            legacyPolicyFieldPresent: Object.prototype.hasOwnProperty.call(config || {}, 'persistCredentials'),
            localConfigCredentialFields: credentialFields.filter(field => Object.prototype.hasOwnProperty.call(config || {}, field)),
            historyCredentialFields: [...new Set(historyConfigs.flatMap(item => credentialFields.filter(field => Object.prototype.hasOwnProperty.call(item || {}, field))))],
            configHasSentinel: containsSentinel(config),
            historyHasSentinel: containsSentinel(history),
            sessionHasSentinel: containsSentinel(sessionCredentials),
            sessionCredentialsPresent: sessionCredentials !== null,
            localCredentialsPresent: localCredentials !== null,
            localCredentialsHasSentinel: containsSentinel(localCredentials),
            rawIndexedDbHasSentinel: containsSentinel(rawRecords),
            encryptedRecordKeys: rawRecords.map(record => record.key).sort(),
            localCredentialsRecordEncrypted: rawRecords.some(record => record?.key === 'local:credentials'),
            sessionCredentialsRecordPresent: rawRecords.some(record => record?.key === 'session:credentials'),
            requiredEncryptedRecordKeysPresent: requiredEncryptedRecordKeys
                .every(key => rawRecords.some(record => record?.key === key)),
            encryptedEnvelopesValid: rawRecords.length > 0
                && rawRecords.every(record => record?.payload?.format === 'fluentread-config'
                && record?.payload?.version === 1
                && record?.payload?.algorithm === 'AES-GCM'),
        };
    })()`;
}

async function readCredentialStorageSnapshot(client, sentinel) {
    const current = await selectedFrame(client);
    return evaluateAsyncJson(client, current.frame, credentialStorageSnapshotSource(sentinel));
}

function credentialSnapshotMatches(snapshot, expected) {
    return Object.entries(expected).every(([key, value]) => {
        if (Array.isArray(value)) return JSON.stringify(snapshot?.[key]) === JSON.stringify(value);
        return snapshot?.[key] === value;
    });
}

async function waitForCredentialStorage(client, sentinel, expected, label) {
    const deadline = Date.now() + 10000;
    let lastSnapshot;
    let consecutiveMatches = 0;
    while (Date.now() < deadline) {
        lastSnapshot = await readCredentialStorageSnapshot(client, sentinel);
        if (credentialSnapshotMatches(lastSnapshot, expected)) {
            consecutiveMatches += 1;
            if (consecutiveMatches >= 2) return lastSnapshot;
        } else {
            consecutiveMatches = 0;
        }
        await sleep(100);
    }
    throw new Error(`Firefox credential storage did not stabilize for ${label}: ${JSON.stringify({expected, actual: lastSnapshot})}`);
}

function credentialSaveSource({clientId, sequence, sentinel, sentinelKey, removeSentinel = false}) {
    return `(async () => {
        const read = async key => {
            const response = await browser.runtime.sendMessage({type: 'configStorageRead', key});
            if (response?.success !== true) throw new Error(response?.error || 'configStorageRead failed: ' + key);
            return response.value ?? null;
        };
        const readOptional = async key => {
            try {
                return await read(key);
            } catch {
                return null;
            }
        };
        const [current, localCredentials, legacySessionCredentials] = await Promise.all([
            read('local:config'),
            read('local:credentials'),
            readOptional('session:credentials'),
        ]);
        if (!current || typeof current !== 'object') throw new Error('encrypted config is unavailable');
        // local:credentials 是当前唯一权威。旧 session 只在升级迁移尚未完成、
        // 本地持久副本不存在时作为兼容输入，不要求 Firefox 支持 storage.session。
        const activeCredentials = localCredentials || legacySessionCredentials || {};
        const config = {...current};
        delete config.persistCredentials;
        for (const field of ${JSON.stringify(CREDENTIAL_FIELDS)}) {
            if (Object.prototype.hasOwnProperty.call(activeCredentials, field)) {
                config[field] = activeCredentials[field];
            }
        }
        config.token = {...(activeCredentials.token || {})};
        ${removeSentinel
            ? `delete config.token[${JSON.stringify(sentinelKey)}];`
            : `config.token[${JSON.stringify(sentinelKey)}] = ${JSON.stringify(sentinel)};`}
        const response = await browser.runtime.sendMessage({
            type: 'persistConfig',
            config,
            clientId: ${JSON.stringify(clientId)},
            sequence: ${sequence},
        });
        if (response?.success !== true) {
            throw new Error('persistConfig failed: ' + JSON.stringify(response));
        }
        return {response, sequence: ${sequence}};
    })()`;
}

async function sendCredentialSave(client, options) {
    const current = await selectedFrame(client);
    return evaluateAsyncJson(client, current.frame, credentialSaveSource(options));
}

async function navigate(client, url) {
    const current = await selectedFrame(client);
    await client.request({to: current.frame.actor, type: 'navigateTo', url});
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        try {
            const next = await selectedFrame(client);
            if (next.frame.url === url) return next;
        } catch {
            // 导航期间 browsing context 会被替换，继续等待新 frame 即可。
        }
        await sleep(100);
    }
    throw new Error(`Firefox RDP navigation timeout: ${url}`);
}

async function waitForDom(client, predicate, label) {
    const deadline = Date.now() + 15000;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const current = await selectedFrame(client);
            const value = await evaluateJson(client, current.frame, predicate);
            if (value) return {current, value};
        } catch (error) {
            lastError = error;
        }
        await sleep(100);
    }
    throw new Error(`Firefox RDP DOM wait timeout: ${label}; ${lastError?.message || ''}`);
}

async function runCredentialLifecycle(client, result) {
    const sentinel = `fluentread-firefox-credential-${randomUUID()}`;
    const sentinelKey = `__firefox_persistence_${randomUUID().replaceAll('-', '')}`;
    const clientId = `firefox-config-persistence-${randomUUID()}`;
    let sequence = 0;
    let sentinelWriteAttempted = false;
    let lifecycleError;
    const commonCleanState = {
        legacyPolicyFieldPresent: false,
        localConfigCredentialFields: [],
        historyCredentialFields: [],
        configHasSentinel: false,
        historyHasSentinel: false,
        rawIndexedDbHasSentinel: false,
        requiredEncryptedRecordKeysPresent: true,
        encryptedEnvelopesValid: true,
        sessionHasSentinel: false,
        sessionCredentialsPresent: false,
        sessionCredentialsRecordPresent: false,
    };

    result.credentialCases = {
        sessionRequired: false,
        sessionAvailable: false,
        clientId,
        sentinel,
        sentinelKey,
        persistentDefault: null,
        persistentAfterPageReload: null,
        cleanup: null,
    };

    try {
        const initial = await readCredentialStorageSnapshot(client, sentinel);
        result.credentialCases.sessionAvailable = initial?.sessionAvailable === true;

        sequence += 1;
        sentinelWriteAttempted = true;
        const persistentRequest = await sendCredentialSave(client, {
            clientId,
            sequence,
            sentinel,
            sentinelKey,
        });
        await sleep(500);
        const persistentStorage = await waitForCredentialStorage(client, sentinel, {
            ...commonCleanState,
            localCredentialsPresent: true,
            localCredentialsHasSentinel: true,
            localCredentialsRecordEncrypted: true,
        }, 'default persistent credentials');
        result.credentialCases.persistentDefault = {request: persistentRequest, storage: persistentStorage};

        // 销毁当前 options 页面，再经过 popup 回到全新的 options 页面，验证页面
        // 生命周期重启后仍从 local:credentials 水合，而不是依赖 session 能力。
        const optionsUrl = (await selectedFrame(client)).frame.url;
        const popupUrl = new URL('popup.html', optionsUrl).href;
        await navigate(client, popupUrl);
        await waitForDom(client, `document.querySelector('.popup-shell')`, 'credential lifecycle popup mount');
        await navigate(client, optionsUrl);
        await waitForDom(client, `document.querySelector('.settings-app')`, 'credential lifecycle options remount');
        await sleep(500);
        const afterPageReload = await waitForCredentialStorage(client, sentinel, {
            ...commonCleanState,
            localCredentialsPresent: true,
            localCredentialsHasSentinel: true,
            localCredentialsRecordEncrypted: true,
        }, 'persistent credentials after options page reload');
        result.credentialCases.persistentAfterPageReload = {storage: afterPageReload};
    } catch (error) {
        lifecycleError = error;
        throw error;
    } finally {
        if (sentinelWriteAttempted) {
            try {
                sequence += 1;
                const cleanupRequest = await sendCredentialSave(client, {
                    clientId,
                    sequence,
                    sentinel,
                    sentinelKey,
                    removeSentinel: true,
                });
                await sleep(500);
                const cleanupStorage = await waitForCredentialStorage(client, sentinel, {
                    ...commonCleanState,
                    localCredentialsPresent: true,
                    localCredentialsHasSentinel: false,
                    localCredentialsRecordEncrypted: true,
                }, 'credential sentinel cleanup');
                result.credentialCases.cleanup = {request: cleanupRequest, storage: cleanupStorage};
            } catch (error) {
                result.credentialCases.cleanupError = String(error?.stack || error?.message || error);
                if (!lifecycleError) throw error;
            }
        }
        result.credentialCases.lastSequence = sequence;
    }
}

async function main() {
    console.error(`[firefox-test] connecting to ${port}`);
    const firefox = await connect(port);
    const client = firefox.client;
    const result = {
        ok: false,
        browser: 'Firefox',
        port,
        artifactsDir,
        browserBootstrap: {
            firstRunDetected: false,
            firstRunBlocked: false,
            remainingDialogs: [],
        },
        persistenceCases: {
            before: 'zh-Hans',
            after: null,
            quickClose: false,
            crossPageSync: false,
            latestWriteWins: false,
        },
        credentialCases: {
            sessionRequired: false,
            sessionAvailable: false,
        },
        errors: [],
        evidence: [],
    };

    try {
        const initial = await selectedFrame(client);
        console.error(`[firefox-test] initial ${initial.frame.url}`);
        result.browserBootstrap.initialTab = {
            url: initial.frame.url,
            title: initial.frame.title,
        };
        if (initial.frame.url.includes('about:welcome') || initial.frame.url.includes('spotlight')) {
            result.browserBootstrap.firstRunDetected = true;
            result.browserBootstrap.firstRunBlocked = true;
            throw new Error('Firefox runner remained on a first-run page; no UI click was attempted');
        }

        const addons = await client.request('listAddons');
        const addon = addons.addons.find(item => item.temporarilyInstalled && item.id === '{3096bd53-3bda-4556-b076-ebf47442a5c1}');
        if (!addon) throw new Error('Firefox runner did not install the temporary FluentRead add-on');
        const extensionBase = addon.manifestURL.replace(/\/manifest\.json$/, '');
        const popupUrl = `${extensionBase}/popup.html`;
        const optionsUrl = `${extensionBase}/options.html`;
        result.extensionId = addon.id;
        console.error(`[firefox-test] addon ${addon.id}`);

        console.error(`[firefox-test] navigate popup ${popupUrl}`);
        let current = await navigate(client, popupUrl);
        console.error(`[firefox-test] popup navigation complete ${current.frame.url}`);
        const popup = await waitForDom(client, `document.querySelector('.popup-shell')`, 'popup mount');
        result.popup = await evaluateJson(client, popup.current.frame, `({
            title: document.title,
            url: location.href,
            shell: Boolean(document.querySelector('.popup-shell')),
            target: document.querySelectorAll('.language-pair select')[1]?.value || null,
            text: document.body?.innerText?.slice(0, 1200) || ''
        })`);
        result.evidence.push({step: 'popup-loaded', url: popup.current.frame.url, ...result.popup});

        console.error(`[firefox-test] navigate options ${optionsUrl}`);
        current = await navigate(client, optionsUrl);
        console.error(`[firefox-test] options navigation complete ${current.frame.url}`);
        const options = await waitForDom(client, `document.querySelector('.settings-app')`, 'options mount');
        result.options = await evaluateJson(client, options.current.frame, `({
            title: document.title,
            url: location.href,
            app: Boolean(document.querySelector('.settings-app')),
            target: document.querySelector('[aria-label="默认目标语言"]')?.parentElement?.parentElement?.querySelector('.el-select__selected-item:not(.el-select__input-wrapper)')?.textContent?.trim() || null
        })`);
        // 编辑前等待 configReady、水合及首次 storage 回声稳定。
        await sleep(500);

        const selectLanguage = async (label) => {
            const before = await selectedFrame(client);
            await evaluate(client, before.frame, `(() => {
                const input = document.querySelector('[aria-label="默认目标语言"]');
                if (!(input instanceof HTMLElement)) throw new Error('target language combobox not found');
                input.click();
                return true;
            })()`);
            await waitForDom(client, `document.querySelector('[aria-label="默认目标语言"]')?.getAttribute('aria-expanded') === 'true'`, `open target language ${label}`);
            const open = await selectedFrame(client);
            const clicked = await evaluateJson(client, open.frame, `(() => {
                const options = [...document.querySelectorAll('[role="option"]')];
                const option = options.find(item => item.textContent?.trim() === ${JSON.stringify(label)});
                if (!(option instanceof HTMLElement)) return false;
                option.click();
                return true;
            })()`);
            if (!clicked) throw new Error(`target language option not found: ${label}`);
            await waitForDom(client, `document.querySelector('[aria-label="默认目标语言"]')?.parentElement?.parentElement?.querySelector('.el-select__selected-item:not(.el-select__input-wrapper)')?.textContent?.trim() === ${JSON.stringify(label)}`, `selected target language ${label}`);
        };

        await selectLanguage('英语');
        // 让一个离散设置完成历史防抖，再执行下一次离散修改；快速关闭场景
        // 仍在后面单独验证，避免把两个用户明确选择误合并为一条历史。
        await sleep(500);
        await selectLanguage('日语');
        const beforeClose = await selectedFrame(client);
        result.persistenceCases.optionsLabel = await evaluateJson(client, beforeClose.frame, `document.querySelector('[aria-label="默认目标语言"]')?.parentElement?.parentElement?.querySelector('.el-select__selected-item:not(.el-select__input-wrapper)')?.textContent?.trim() || null`);
        const storageDeadline = Date.now() + 5000;
        do {
            result.persistenceCases.storageBeforeClose = await evaluateAsyncJson(client, beforeClose.frame, `browser.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}).then(response => {
                if (response?.success !== true) throw new Error(response?.error || 'configStorageRead failed');
                return {channel: 'configStorageRead', to: response.value?.to, revision: response.value?.__fluentConfigRevision};
            })`);
            if (result.persistenceCases.storageBeforeClose.to === 'ja') break;
            await sleep(100);
        } while (Date.now() < storageDeadline);

        // 不触碰可见浏览器，直接触发真实的短生命周期路径：让同一扩展标签页导航离开，
        // 触发 pagehide/unmount，再在同一 browsing context 中重新打开 popup。
        console.error('[firefox-test] quick close via extension navigation');
        await navigate(client, popupUrl);
        result.persistenceCases.quickClose = true;
        const reopened = await waitForDom(client, `document.querySelector('.popup-shell')`, 'popup reopen');
        result.persistenceCases.after = await evaluateJson(client, reopened.current.frame, `document.querySelectorAll('.language-pair select')[1]?.value || null`);
        result.persistenceCases.storageAfterClose = await evaluateAsyncJson(client, reopened.current.frame, `browser.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}).then(response => {
            if (response?.success !== true) throw new Error(response?.error || 'configStorageRead failed');
            return {channel: 'configStorageRead', to: response.value?.to, revision: response.value?.__fluentConfigRevision};
        })`);
        result.persistenceCases.crossPageSync = result.persistenceCases.after === 'ja';
        result.persistenceCases.latestWriteWins = result.persistenceCases.crossPageSync;
        result.evidence.push({step: 'popup-reopen', url: reopened.current.frame.url, target: result.persistenceCases.after, storage: result.persistenceCases.storageAfterClose});
        if (!result.persistenceCases.crossPageSync) throw new Error(`Firefox config did not persist across close/reopen: ${JSON.stringify(result.persistenceCases)}`);

        console.error('[firefox-test] verify config history');
        await sleep(800);
        await navigate(client, optionsUrl);
        const historyOptions = await waitForDom(client, `document.querySelector('.settings-app')`, 'history options mount');
        await evaluate(client, historyOptions.current.frame, `(() => {
            const button = document.querySelector('nav[aria-label="设置分类"] button[data-section="settings-data"]');
            if (!(button instanceof HTMLButtonElement)) throw new Error('备份与恢复导航不存在');
            button.click();
            return true;
        })()`);
        const historyPanel = await waitForDom(client, `document.querySelector('#settings-data .version-panel')?.offsetParent !== null`, 'config history panel');
        result.historyCases = await evaluateJson(client, historyPanel.current.frame, `(() => {
            const entries = [...document.querySelectorAll('#settings-data .version-panel:first-of-type .version-entry')];
            const current = document.querySelector('#settings-data .version-panel:first-of-type .version-entry.current .version-badge')?.textContent?.trim() || null;
            return {
                count: entries.length,
                versions: entries.map(entry => entry.querySelector('.version-badge')?.textContent?.trim() || null),
                timestamps: entries.map(entry => entry.querySelector('.version-copy small')?.textContent?.trim() || null),
                current,
            };
        })()`);
        if (result.historyCases.count < 3 || result.historyCases.count > 10) throw new Error(`Firefox 配置历史条目数量异常: ${JSON.stringify(result.historyCases)}`);
        if (new Set(result.historyCases.versions).size !== result.historyCases.count || result.historyCases.versions.some(value => !/^v\d+$/.test(value))) {
            throw new Error(`Firefox 配置历史版本号异常: ${JSON.stringify(result.historyCases)}`);
        }
        if (result.historyCases.timestamps.some(value => !value)) throw new Error('Firefox 配置历史缺少时间');

        const persistedHistory = await evaluateAsyncJson(client, (await selectedFrame(client)).frame, `browser.runtime.sendMessage({type: 'configStorageRead', key: 'local:configHistory'}).then(response => {
            if (response?.success !== true) throw new Error(response?.error || 'configStorageRead history failed');
            const history = response.value;
            return {
                cursor: history?.cursor ?? null,
                entries: Array.isArray(history?.entries) ? history.entries.map(entry => ({
                    version: entry.version,
                    savedAt: entry.savedAt,
                    config: {
                        on: entry.config?.on,
                        from: entry.config?.from,
                        to: entry.config?.to,
                        service: entry.config?.service,
                        style: entry.config?.style,
                        display: entry.config?.display,
                        theme: entry.config?.theme,
                    },
                })) : [],
            };
        })`);
        const currentIndex = persistedHistory?.cursor;
        result.historyCases.storageEntries = persistedHistory?.entries || [];
        const restoreIndex = persistedHistory?.entries?.findIndex(entry => entry.config?.to === 'en') ?? -1;
        const restoreEntry = restoreIndex >= 0 ? persistedHistory.entries[restoreIndex] : null;
        if (!restoreEntry || typeof restoreEntry.version !== 'number' || !persistedHistory.entries.some(entry => entry.config?.to === 'ja')) {
            throw new Error(`Firefox 配置历史未记录本次用户配置快照: ${JSON.stringify({entries: persistedHistory?.entries || [], currentIndex})}`);
        }

        const restoreHistoryVersion = async (version, label) => {
            const before = await selectedFrame(client);
            const clicked = await evaluateJson(client, before.frame, `(() => {
                const element = [...document.querySelectorAll('#settings-data .version-panel:first-of-type .version-entry')]
                    .find(item => item.querySelector('.version-badge')?.textContent?.trim() === ${JSON.stringify(`v${version}`)});
                if (!(element instanceof HTMLButtonElement) || element.disabled) return false;
                element.click();
                return true;
            })()`);
            if (!clicked) throw new Error(`Firefox 配置历史按钮不可用: ${label}`);
            await waitForDom(client, `document.querySelector('.config-preview-dialog')?.offsetParent !== null`, `${label} preview`);
            const previewFrame = await selectedFrame(client);
            const restoreClicked = await evaluateJson(client, previewFrame.frame, `(() => {
                const button = [...document.querySelectorAll('.config-preview-dialog button')]
                    .find(item => item.textContent?.trim() === '恢复此版本');
                if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
                button.click();
                return true;
            })()`);
            if (!restoreClicked) throw new Error(`Firefox 配置历史预览恢复按钮不可用: ${label}`);
            await waitForDom(client, `document.querySelector('.el-message-box')?.offsetParent !== null`, `${label} confirmation`);
            const confirmFrame = await selectedFrame(client);
            const confirmed = await evaluateJson(client, confirmFrame.frame, `(() => {
                const button = [...document.querySelectorAll('.el-message-box button')]
                    .find(item => item.textContent?.trim() === '恢复');
                if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
                button.click();
                return true;
            })()`);
            if (!confirmed) throw new Error(`Firefox 配置历史确认按钮不可用: ${label}`);
            await sleep(500);
            const after = await selectedFrame(client);
            return {
                version: await evaluateJson(client, after.frame, `document.querySelector('#settings-data .version-panel:first-of-type .version-entry.current .version-badge')?.textContent?.trim() || null`),
                config: await readConfigProjection(client, after.frame),
            };
        };
        const currentVersion = result.historyCases.current;
        const restored = await restoreHistoryVersion(restoreEntry.version, 'restore English version');
        if (!restored.version || restored.version === currentVersion) throw new Error('Firefox 配置历史恢复没有创建当前版本');
        if (JSON.stringify(restored.config) !== JSON.stringify(restoreEntry.config)) throw new Error(`Firefox 配置恢复未写入目标配置: ${JSON.stringify({expected: restoreEntry.config, actual: restored.config})}`);
        const japaneseEntry = persistedHistory.entries.find(entry => entry.config?.to === 'ja');
        if (!japaneseEntry) throw new Error('Firefox 配置历史缺少日语版本');
        const restoredJapanese = await restoreHistoryVersion(japaneseEntry.version, 'restore Japanese version');
        result.historyCases.restore = {before: currentVersion, english: restored.version, japanese: restoredJapanese.version};
        result.historyCases.storageAfterActions = {
            englishTo: restored.config?.to || null,
            japaneseTo: restoredJapanese.config?.to || null,
        };
        if (restoredJapanese.config?.to !== 'ja' || restoredJapanese.version === restored.version) {
            throw new Error(`Firefox 配置历史双向恢复结果异常: ${JSON.stringify(result.historyCases)}`);
        }
        result.evidence.push({step: 'config-history', url: (await selectedFrame(client)).frame.url, history: result.historyCases});

        console.error('[firefox-test] verify credential storage lifecycle');
        const credentialFrame = await selectedFrame(client);
        if (!credentialFrame.frame.url.startsWith(optionsUrl)) {
            throw new Error(`Firefox credential test must run in options extension origin: ${credentialFrame.frame.url}`);
        }
        await runCredentialLifecycle(client, result);
        result.evidence.push({
            step: 'credential-lifecycle',
            url: (await selectedFrame(client)).frame.url,
            credentials: result.credentialCases,
        });

        result.ok = true;
    } catch (error) {
        result.errors.push(String(error?.stack || error?.message || error));
        throw error;
    } finally {
        fs.writeFileSync(path.join(artifactsDir, 'firefox-config-persistence.json'), `${JSON.stringify(result, null, 2)}\n`);
        firefox.disconnect();
    }

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
