/**
 * @file src/services/config/mutationClient.ts
 * 文件职责：独立拥有短生命周期配置客户端的提交队列、乐观字段、ACK 协调与关闭交接。
 * 主要内容：每个实例管理 sequence/generation、待确认凭据和字段补丁，保留 CAS、失败回读及旧回声隔离；存储事件由权威端交给客户端判定本地所有权。
 * 模块边界：不导入全局 store 或浏览器，不直接写入存储；权威快照、凭据与落盘由显式只读视图和提交命令端口提供，历史由独立端口执行。
 */
import {normalizeConfig, type Config} from '@/src/core/config/model';
import { getConfigImportCredentialBindings } from '@/src/core/config/transfer';
import {CONFIG_CREDENTIAL_FIELDS, extractConfigCredentials, mergeConfigCredentials, type ConfigCredentials, type ConfigCredentialField} from '@/src/core/config/credentials';
import {configPatchValuesEqual, createConfigPatch, createConfigPatchExpectedValues, synchronizeLegacyTokenPatch, bindConfigPatchCredentialsToDestinations, mergeCredentialFields, prepareConfigPatchFromSnapshot} from '@/src/core/config/mutations';
import type {ConfigStoragePort} from '@/src/platform/storage/configStorage';
import type {ConfigHistoryAction, ConfigHistoryState} from './history';
import {parseStoredConfig, serializeConfig, getStoredConfigRevision} from './schema';
import {CONFIG_COUNT_INCREMENT_MESSAGE, parseConfigCountIncrement, parseConfigCountOperationId} from './count';
import {CONFIG_STORAGE_KEY, CONFIG_PERSIST_MESSAGE, CONFIG_PERSIST_BATCH_MESSAGE, CONFIG_HISTORY_MESSAGE, type ConfigPersistenceMode, type ConfigMessageResponse, type ConfigMessageSender, type ConfigPatchBatchMessage, type ConfigMutationRequest, type StoredConfigChangeOptions, type SaveConfigOptions, type RequestConfigSaveOptions, type ConfigCountMessageSender, type ConfigHistoryMessageSender, type ConfigHistoryMessageResponse} from './protocol';

export interface ConfigClientAuthorityPort {
    readonly knownFields: ReadonlySet<string>;
    readonly config: Config;
    readonly initialized: boolean;
    readonly ready: Promise<void>;
    readonly trusted: boolean;
    readonly writesBlocked: boolean;
    readonly revision: number;
    readonly credentials: ConfigCredentials | null;
    readonly committedConfig: Config | null;
    readonly committedRevision: number;
    readonly credentialRevision: number;
    readonly storage: Pick<ConfigStoragePort, 'getItem'>;
    advanceRevision(revision: number): void;
    acceptCredentials(credentials: ConfigCredentials): void;
    publish(config: Config): void;
    rememberCommitted(config: unknown, revision?: number): Config;
    rememberStored(value: unknown, credentials?: ConfigCredentials | null): Config | null;
    receiveStored(value: unknown, options?: StoredConfigChangeOptions): void;
    save(config: Config, options: SaveConfigOptions): Promise<void>;
    incrementCount(delta: number, operationId?: string): Promise<number>;
}
export interface ConfigMutationClientPorts {
    authority: ConfigClientAuthorityPort;
    applyHistoryAction(action: ConfigHistoryAction, version?: number): Promise<ConfigHistoryState>;
}

interface PendingRemoteConfigMutation {
    sender: ConfigMessageSender;
    mode: ConfigPersistenceMode;
    patch?: ConfigPatchBatchMessage['patches'][number];
}

export function createConfigMutationClient(ports: ConfigMutationClientPorts) {
    const authority = ports.authority;
    let latestRequestedSerialized = '';

    let latestRequestedMode: ConfigPersistenceMode | null = null;

    let latestRequestedSequence = 0;

    const pendingCredentialEdits = new Map<number, {
        credentials: ConfigCredentials;
        fields: ReadonlySet<ConfigCredentialField>;
        tokenServices: ReadonlySet<string>;
        apiKeyServices: ReadonlySet<string>;
    }>();

    let requestSequence = 0;

    let requestGeneration = 0;

    let requestQueue: Promise<void> = Promise.resolve();

    let lastEnqueuedRemoteRequestSequence = 0;

    let lastCommittedRemoteRequestSequence = 0;

    let lastCommittedRemoteRequestRevision = 0;

    let lastCommittedRemoteRequestGeneration = -1;

    let lastCommittedRemoteRequestMode: ConfigPersistenceMode | null = null;

    let activeRequestSerialized = '';

    let hasDeferredStoredConfigChange = false;

    let deferredStoredConfigChange: unknown;

    const requestClientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const pendingRemoteConfigMutations = new Map<number, PendingRemoteConfigMutation>();

    function takeDeferredStoredConfigChange(): {hasValue: boolean; value: unknown} {
        const result = {hasValue: hasDeferredStoredConfigChange, value: deferredStoredConfigChange};
        hasDeferredStoredConfigChange = false;
        deferredStoredConfigChange = undefined;
        return result;
    }

    async function requestConfigCountIncrement(
        delta: number,
        sendMessage?: ConfigCountMessageSender,
        operationId?: string,
    ): Promise<number> {
        const normalizedDelta = parseConfigCountIncrement(delta);
        if (normalizedDelta === null) throw new TypeError('无效的翻译计数增量');
        const normalizedOperationId = parseConfigCountOperationId(operationId);
        if (normalizedOperationId === null) throw new TypeError('无效的翻译计数操作标识');
        if (!sendMessage) return authority.incrementCount(normalizedDelta, normalizedOperationId);

        const response = await sendMessage({
            type: CONFIG_COUNT_INCREMENT_MESSAGE,
            delta: normalizedDelta,
            operationId: normalizedOperationId,
        });
        if (response?.success === false) throw new Error(response.error || '翻译计数保存失败');
        if (typeof response?.count !== 'number') throw new Error('翻译计数保存没有返回结果');
        return response.count;
    }

    function overlayPendingCredentialEdits(credentials: ConfigCredentials): ConfigCredentials {
        let result = credentials;
        if (!latestRequestedSequence) return result;
        // 非零 latestRequestedSequence 只递增；当前 pending 项都不晚于该序号。
        for (const edit of pendingCredentialEdits.values()) {
            result = mergeCredentialFields(result, edit.credentials, edit.fields, edit.tokenServices, edit.apiKeyServices);
        }
        return result;
    }

    async function handoffPendingConfigPatches(
        originalSender: ConfigMessageSender,
        batchSender: (message: ConfigPatchBatchMessage) => Promise<ConfigMessageResponse>,
    ): Promise<void> {
        const entries = [...pendingRemoteConfigMutations.entries()];
        const matching = entries.filter(([, request]) => request.sender === originalSender);
        const pending = matching.map(([, request]) => request);
        if (pending.length === 0) return;
        if (!authority.initialized || authority.writesBlocked) {
            throw new Error('配置安全水合未完成，暂不交接待保存设置');
        }
        if (entries.some(([sequence, request]) => (
            sequence < matching[matching.length - 1][0] && request.sender !== originalSender
        ))) {
            throw new Error('待保存队列包含其他发送方的前驱，不能跳过前驱交接');
        }
        if (pending.some(request => request.mode !== 'patch')) {
            throw new Error('待保存队列包含整份替换，不能作为字段补丁交接');
        }
        if (pending.length > 256) throw new Error('待交接配置补丁超过 256 条');
        // sender 必须在首次 await 前调用，不能再依赖即将销毁页面的 requestQueue。
        const response = await batchSender({
            type: CONFIG_PERSIST_BATCH_MESSAGE,
            clientId: requestClientId,
            patches: pending.map(request => JSON.parse(JSON.stringify(request.patch!))),
        });
        if (response?.success !== true) throw new Error(response?.error || '后台接管配置补丁失败');
        if (!Number.isSafeInteger(response.revision) || Number(response.revision) < 0) {
            throw new Error('后台接管配置补丁没有返回有效 revision');
        }
    }

    async function reconcileFailedConfigRequest(): Promise<void> {
        let deferred = takeDeferredStoredConfigChange();
        let storedValue: unknown;
        try {
            storedValue = deferred.hasValue
                ? deferred.value
                : await authority.storage.getItem<unknown>(CONFIG_STORAGE_KEY);
            // storage.getItem 期间可能又收到更新，以最后一个 watch 快照为准。
            deferred = takeDeferredStoredConfigChange();
        } catch (error) {
            // pending read 失败前到达的更高 revision 已经是权威结果。先解除 active
            // 所有权再消费，避免 handleStoredConfigChange 把同一快照重新 deferred。
            activeRequestSerialized = '';
            deferred = takeDeferredStoredConfigChange();
            if (deferred.hasValue) {
                storedValue = deferred.value;
                console.warn('[FluentRead] 配置保存失败后的回读失败，采用并发到达的权威快照', error);
            } else {
                // 所有调用均已等待 configReady，成功水合或安全 fallback 都已安装提交影子。
                const committedFallback = authority.committedConfig!;
                // 前驱失败时，队尾请求可能仍拥有乐观 UI；只有队列已经没有后续所有者时
                // 才回滚。请求前草稿不能反向升级成“已提交”影子。
                if (latestRequestedSequence === 0
                    && serializeConfig(authority.config) !== serializeConfig(committedFallback)) {
                    authority.publish(committedFallback);
                }
                console.warn('[FluentRead] 配置保存失败后的权威快照回读失败', error);
                return;
            }
        } finally {
            activeRequestSerialized = '';
        }

        const latestValue = deferred.hasValue ? deferred.value : storedValue;
        if (parseStoredConfig(latestValue)) {
            // 即使后续 patch 仍保持乐观 UI 所有权，这次回读也是失败前驱的权威
            // 提交基线；单独保存它，供队尾成功但回读失败时按字段重建。
            authority.rememberStored(latestValue);
            authority.receiveStored(latestValue);
        } else {
            const committedFallback = authority.committedConfig!;
            if (latestRequestedSequence === 0
                && serializeConfig(authority.config) !== serializeConfig(committedFallback)) {
                authority.publish(committedFallback);
            }
        }
    }

    async function requestConfigMutation(
        mutation: ConfigMutationRequest,
        sendMessage?: ConfigMessageSender,
    ): Promise<void> {
        const {mode, messageExpected, credentialIntent = 'changed-fields', importedCredentialBindings} = mutation;
        let normalized = mutation.normalized;
        let messageConfig = mutation.messageConfig;
        let serialized = serializeConfig(normalized);
        const enqueuedBaseRevision = authority.revision;
        const requestedCredentials = extractConfigCredentials(normalized);
        const baselineCredentials = extractConfigCredentials(authority.config);
        const replaceCredentialFields = new Set<ConfigCredentialField>(
            mode === 'replace' && authority.trusted
                ? CONFIG_CREDENTIAL_FIELDS.filter(field => (
                    credentialIntent === 'exact'
                    || importedCredentialBindings?.fields.includes(field)
                    || (field !== 'token'
                        && (!importedCredentialBindings || (field !== 'apiKeys' && field !== 'secret'))
                        && !configPatchValuesEqual(requestedCredentials[field], baselineCredentials[field]))
                ))
                : [],
        );
        const patchCredentialFields = new Set<ConfigCredentialField>(
            mode === 'patch' && authority.trusted
                ? CONFIG_CREDENTIAL_FIELDS.filter(field => (
                    field !== 'token'
                    && field !== 'apiKeys'
                    && Object.prototype.hasOwnProperty.call(messageConfig, field)
                ))
                : [],
        );
        const patchCredentialApiKeyServices = new Set<string>(
            mode === 'patch'
                && authority.trusted
                && Object.prototype.hasOwnProperty.call(messageConfig, 'apiKeys')
                ? [...new Set([
                    ...Object.keys(baselineCredentials.apiKeys),
                    ...Object.keys(requestedCredentials.apiKeys),
                ])].filter((service) => !configPatchValuesEqual(
                    baselineCredentials.apiKeys[service], requestedCredentials.apiKeys[service],
                ))
                : [],
        );
        const patchCredentialTokenServices = new Set<string>(
            mode === 'patch'
                && authority.trusted
                && Object.prototype.hasOwnProperty.call(messageConfig, 'token')
                ? [...new Set([
                    ...Object.keys(baselineCredentials.token),
                    ...Object.keys(requestedCredentials.token),
                ])].filter((service) => !configPatchValuesEqual(
                    baselineCredentials.token[service],
                    requestedCredentials.token[service],
                ))
                : [],
        );
        const replaceCredentialTokenServices = new Set<string>(
            mode === 'replace'
                && authority.trusted
                && credentialIntent !== 'exact'
                ? [...new Set([
                    ...Object.keys(baselineCredentials.token),
                    ...Object.keys(requestedCredentials.token),
                ])].filter((service) => importedCredentialBindings?.tokenServices.includes(service) || !configPatchValuesEqual(
                    baselineCredentials.token[service],
                    requestedCredentials.token[service],
                ))
                : [],
        );
        const replaceCredentialApiKeyServices = new Set<string>(
            mode === 'replace'
                && authority.trusted
                && credentialIntent !== 'exact'
                ? [...new Set([
                    ...Object.keys(baselineCredentials.apiKeys),
                    ...Object.keys(requestedCredentials.apiKeys),
                ])].filter((service) => importedCredentialBindings?.apiKeyServices.includes(service) || !configPatchValuesEqual(
                    baselineCredentials.apiKeys[service], requestedCredentials.apiKeys[service],
                ))
                : [],
        );
        const ownedCredentialTokenServices = mode === 'patch'
            ? patchCredentialTokenServices
            : replaceCredentialTokenServices;
        const ownedCredentialApiKeyServices = mode === 'patch'
            ? patchCredentialApiKeyServices
            : replaceCredentialApiKeyServices;
        const ownedCredentialSecretServices = new Set(importedCredentialBindings ? [
            ...importedCredentialBindings.secretServices,
            ...new Set([...Object.keys(baselineCredentials.secret), ...Object.keys(requestedCredentials.secret)]),
        ].filter(service => importedCredentialBindings.secretServices.includes(service)
            || !configPatchValuesEqual(baselineCredentials.secret[service], requestedCredentials.secret[service])) : []);
        const predecessorRemoteSequence = sendMessage ? lastEnqueuedRemoteRequestSequence : 0;
        const sequence = ++requestSequence;
        // 必须在第一个 await 前登记最新请求；否则即使 configReady 已 resolved，微任务
        // 让出期间到达的旧 storage 回声也会被误当外部更新并回滚本地编辑。内容可以相同，
        // 所有权必须用 sequence 区分，不能让前一个相同快照的 finally 清掉后一个请求。
        latestRequestedSerialized = serialized;
        latestRequestedMode = mode;
        latestRequestedSequence = sequence;
        if (sendMessage) lastEnqueuedRemoteRequestSequence = sequence;
        if (sendMessage && mode === 'patch' && authority.trusted) {
            pendingCredentialEdits.set(sequence, {
                credentials: requestedCredentials,
                fields: patchCredentialFields,
                tokenServices: ownedCredentialTokenServices,
                apiKeyServices: ownedCredentialApiKeyServices,
            });
        }
        if (mode === 'patch' && serializeConfig(authority.config) !== serialized) authority.publish(normalized);

        if (!sendMessage) {
            try {
                await authority.ready;
                if (authority.writesBlocked) {
                    throw new Error('配置安全水合未完成，暂不保存；请重新加载扩展后重试');
                }
                await authority.save(normalized, {recordHistory: true, immediateHistory: true});
            } catch (error) {
                if (mode === 'patch' && latestRequestedSequence === sequence) {
                    requestGeneration += 1;
                    latestRequestedSerialized = '';
                    latestRequestedMode = null;
                    latestRequestedSequence = 0;
                    await reconcileFailedConfigRequest();
                }
                throw error;
            } finally {
                if (latestRequestedSequence === sequence) {
                    latestRequestedSerialized = '';
                    latestRequestedMode = null;
                    latestRequestedSequence = 0;
                }
            }
            return;
        }

        pendingRemoteConfigMutations.set(sequence, {
            sender: sendMessage,
            mode,
            ...(mode === 'patch' ? {patch: {
                sequence,
                config: JSON.parse(JSON.stringify(messageConfig)),
                expected: JSON.parse(JSON.stringify(messageExpected)),
            }} : {}),
        });
        const generation = requestGeneration;
        // requestQueue 只保存下方双分支归一化后的完成值；上次失败不能阻塞后续请求。
        const request = requestQueue.then(async () => {
                await authority.ready;
                // 远程扩展页在凭据水合失败后只有公开配置，绝不能把空 token/ak/sk 当成
                // 用户修改发给后台并清除仍安全保存的 API Key。完整重载成功前统一拒绝保存。
                if (authority.writesBlocked) {
                    throw new Error('配置安全水合未完成，暂不保存；请重新加载扩展后重试');
                }
                // 外部恢复/导入导致 revision 冲突后，不能继续发送已经排队的旧整份快照。
                if (mode === 'replace' && generation !== requestGeneration) {
                    throw new Error('配置已更新，请根据最新配置重新修改');
                }

                // replace 必须绑定入队时看到的基线，不能在排队后借用外部页面推进的
                // persistedConfigRevision。唯一允许继承的是同一 client 队列中已经确认
                // 成功的 replace 直接前驱，这样连续整份快照仍可按 revision 1 -> 2 -> 3
                // 提交，而 patch 吸收的外部字段不会成为旧 replace 的授权基线。
                const hasCommittedPredecessor = predecessorRemoteSequence > 0
                    && lastCommittedRemoteRequestSequence === predecessorRemoteSequence
                    && lastCommittedRemoteRequestGeneration === generation;
                const canInheritPredecessorRevision = hasCommittedPredecessor
                    // patch 的提交 revision 可能已经吸收外部字段；旧整份 replace
                    // 不能借用该 revision，否则会把这些外部字段回写成自己的旧快照。
                    && lastCommittedRemoteRequestMode === 'replace';
                let committedRequestCredentials = requestedCredentials;
                if (authority.trusted
                    && authority.credentials) {
                    committedRequestCredentials = mergeCredentialFields(
                        authority.credentials,
                        requestedCredentials,
                        mode === 'replace' ? replaceCredentialFields : patchCredentialFields,
                        ownedCredentialTokenServices,
                        ownedCredentialApiKeyServices,
                        ownedCredentialSecretServices,
                    );
                    normalized = normalizeConfig(mergeConfigCredentials(
                        normalized,
                        committedRequestCredentials,
                    ));
                    if (mode === 'replace') {
                        messageConfig = normalized;
                    }
                    serialized = serializeConfig(normalized);
                    if (latestRequestedSequence === sequence) {
                        latestRequestedSerialized = serialized;
                    }
                }
                activeRequestSerialized = serialized;
                const credentialWatchSequenceAtSend = authority.credentialRevision;
                const baseRevision = canInheritPredecessorRevision
                    ? Math.max(enqueuedBaseRevision, lastCommittedRemoteRequestRevision)
                    : enqueuedBaseRevision;
                const restoreCommittedPredecessorCredentials = (): void => {
                    pendingCredentialEdits.delete(sequence);
                    if (!authority.trusted
                        || latestRequestedSequence !== sequence
                        || !authority.credentials) return;
                    const restored = normalizeConfig(mergeConfigCredentials(
                        authority.config,
                        authority.credentials,
                    ));
                    if (serializeConfig(authority.config) !== serializeConfig(restored)) authority.publish(restored);
                };
                const preserveNewerCredentialWatch = (): void => {
                    if (!authority.trusted
                        || authority.credentialRevision === credentialWatchSequenceAtSend
                        || !authority.credentials) return;
                    // 凭据 watch 可能在请求等待响应时到达。它是更新的基线，
                    // 但当前请求显式拥有的字段仍应覆盖该基线；exact 则拥有全部字段。
                    committedRequestCredentials = mergeCredentialFields(
                        authority.credentials,
                        committedRequestCredentials,
                        mode === 'replace' ? replaceCredentialFields : patchCredentialFields,
                        ownedCredentialTokenServices,
                        ownedCredentialApiKeyServices,
                        ownedCredentialSecretServices,
                    );
                    normalized = normalizeConfig(mergeConfigCredentials(
                        normalized,
                        committedRequestCredentials,
                    ));
                    if (mode === 'replace') messageConfig = normalized;
                    serialized = serializeConfig(normalized);
                    if (latestRequestedSequence === sequence) latestRequestedSerialized = serialized;
                };
                const buildCommittedMutationResult = (baseValue?: Config | null): Config => {
                    if (mode === 'replace') return normalizeConfig(normalized);
                    let committedBase = normalizeConfig(
                        baseValue || authority.committedConfig!,
                    );
                    if (authority.trusted) {
                        committedBase = normalizeConfig(mergeConfigCredentials(
                            committedBase,
                            authority.credentials!,
                        ));
                    }
                    const patched = prepareConfigPatchFromSnapshot(
                        messageConfig,
                        createConfigPatchExpectedValues(
                            messageConfig as unknown as Record<string, unknown>,
                            committedBase,
                        ),
                        committedBase,
                        authority.trusted,
                        authority.knownFields,
                    );
                    return normalizeConfig(mergeConfigCredentials(
                        patched,
                        committedRequestCredentials,
                    ));
                };
                let response: ConfigMessageResponse;
                try {
                    response = await sendMessage({
                        type: CONFIG_PERSIST_MESSAGE,
                        ...(mode === 'patch' ? {mode} : {}),
                        // replace 发送完整 Config；patch 只发送已过滤的已知字段。runtime
                        // wire schema 在后台按 mode 区分，这里的断言保持旧 sender 回调兼容。
                        config: messageConfig as Config,
                        ...(mode === 'patch' ? {expected: messageExpected as unknown as Config} : {}),
                        clientId: requestClientId,
                        sequence,
                        baseRevision,
                    });
                } catch (error) {
                    activeRequestSerialized = '';
                    restoreCommittedPredecessorCredentials();
                    if (mode === 'patch' && latestRequestedSequence === sequence) {
                        requestGeneration += 1;
                        latestRequestedSerialized = '';
                        latestRequestedMode = null;
                        latestRequestedSequence = 0;
                        await reconcileFailedConfigRequest();
                    } else {
                        const deferred = takeDeferredStoredConfigChange();
                        if (deferred.hasValue) authority.receiveStored(deferred.value);
                    }
                    throw error;
                }

                if (response?.success === false) {
                    restoreCommittedPredecessorCredentials();
                    requestGeneration += 1;
                    if (latestRequestedSequence === sequence) {
                        latestRequestedSerialized = '';
                        latestRequestedMode = null;
                        latestRequestedSequence = 0;
                    }
                    await reconcileFailedConfigRequest();
                    throw new Error(response.error || '后台保存配置失败');
                }
                if (typeof response?.revision !== 'number'
                    || !Number.isSafeInteger(response.revision)
                    || response.revision < 0) {
                    activeRequestSerialized = '';
                    restoreCommittedPredecessorCredentials();
                    if (mode === 'patch' && latestRequestedSequence === sequence) {
                        requestGeneration += 1;
                        latestRequestedSerialized = '';
                        latestRequestedMode = null;
                        latestRequestedSequence = 0;
                        await reconcileFailedConfigRequest();
                    } else {
                        const deferred = takeDeferredStoredConfigChange();
                        if (deferred.hasValue) authority.receiveStored(deferred.value);
                    }
                    throw new Error('后台保存配置没有返回有效 revision');
                }

                let deferred = takeDeferredStoredConfigChange();
                let storedValue: unknown;
                if (deferred.hasValue) {
                    storedValue = deferred.value;
                } else {
                    try {
                        storedValue = await authority.storage.getItem<unknown>(CONFIG_STORAGE_KEY);
                    } catch {
                        activeRequestSerialized = '';
                        deferred = takeDeferredStoredConfigChange();
                        if (deferred.hasValue) {
                            // getItem 拒绝不代表没有结果；等待期间到达的更高 revision
                            // 必须进入下面统一的 revision 比较，不能遗留到下一次请求。
                            storedValue = deferred.value;
                        } else {
                            // 保存已经成功；读取暂时失败时至少同步本次用户快照与 revision，
                            // 后续 storage.watch 仍会补齐后台保留的 canonical 字段。patch 只能
                            // 叠加到最近确认的提交影子，不能采用包含失败前驱乐观字段的 normalized。
                            preserveNewerCredentialWatch();
                            authority.advanceRevision(response.revision);
                            if (mode === 'replace' && generation !== requestGeneration) {
                                throw new Error('配置已由其他页面更新，请根据最新配置重新修改');
                            }
                            const committedResult = authority.rememberCommitted(
                                buildCommittedMutationResult(),
                                response.revision,
                            );
                            if (latestRequestedSequence === sequence
                                && serializeConfig(authority.config) !== serializeConfig(committedResult)) {
                                authority.publish(committedResult);
                            }
                            lastCommittedRemoteRequestSequence = sequence;
                            lastCommittedRemoteRequestRevision = response.revision;
                            lastCommittedRemoteRequestGeneration = generation;
                            lastCommittedRemoteRequestMode = mode;
                            if (authority.trusted) {
                                authority.acceptCredentials(committedRequestCredentials);
                            }
                            return;
                        }
                    }
                    deferred = takeDeferredStoredConfigChange();
                    if (deferred.hasValue) storedValue = deferred.value;
                }
                activeRequestSerialized = '';
                preserveNewerCredentialWatch();

                const storedRevision = getStoredConfigRevision(storedValue);
                if (storedRevision > response.revision) {
                    authority.receiveStored(storedValue);
                    throw new Error('配置已由其他页面更新，请根据最新配置重新修改');
                }
                if (storedRevision === response.revision) {
                    authority.rememberStored(
                        storedValue,
                        authority.trusted ? committedRequestCredentials : null,
                    );
                    authority.receiveStored(storedValue, {
                        confirmedRequestRevision: response.revision,
                        confirmedRequestSerialized: serialized,
                        confirmedRequestSequence: sequence,
                        ...(authority.trusted
                            ? {confirmedRequestCredentials: committedRequestCredentials}
                            : {}),
                    });
                } else {
                    authority.advanceRevision(response.revision);
                    const storedBase = parseStoredConfig(storedValue);
                    const storedBaseConfig = storedBase
                        ? normalizeConfig(mergeConfigCredentials(
                            storedBase,
                            authority.trusted
                                ? committedRequestCredentials
                                : extractConfigCredentials(authority.config),
                        ))
                        : null;
                    // 回读可能仍停在前一个甚至更早的 revision。选择较新的已确认
                    // 基线，再叠加本次已成功 patch，避免 stale read 丢掉前驱提交字段。
                    const committedBase = storedBaseConfig
                        && (!authority.committedConfig
                            || storedRevision >= authority.committedRevision)
                        ? storedBaseConfig
                        : authority.committedConfig;
                    const committedResult = authority.rememberCommitted(
                        buildCommittedMutationResult(committedBase),
                        response.revision,
                    );
                    if (latestRequestedSequence === sequence) {
                        if (serializeConfig(authority.config) !== serializeConfig(committedResult)) {
                            authority.publish(committedResult);
                        }
                    }
                }
                if (mode === 'replace' && generation !== requestGeneration) {
                    throw new Error('配置已由其他页面更新，请根据最新配置重新修改');
                }
                lastCommittedRemoteRequestSequence = sequence;
                lastCommittedRemoteRequestRevision = response.revision;
                lastCommittedRemoteRequestGeneration = generation;
                lastCommittedRemoteRequestMode = mode;
                if (authority.trusted) {
                    authority.acceptCredentials(committedRequestCredentials);
                }
            });
        requestQueue = request.then(() => undefined, () => undefined);

        try {
            await request;
        } catch (error) {
            pendingCredentialEdits.delete(sequence);
            if (mode === 'patch'
                && latestRequestedSequence === sequence
                && serializeConfig(authority.config) === serialized) {
                requestGeneration += 1;
                latestRequestedSerialized = '';
                latestRequestedMode = null;
                latestRequestedSequence = 0;
                await reconcileFailedConfigRequest();
            }
            throw error;
        } finally {
            pendingCredentialEdits.delete(sequence);
            pendingRemoteConfigMutations.delete(sequence);
            if (latestRequestedSequence === sequence) {
                latestRequestedSerialized = '';
                latestRequestedMode = null;
                latestRequestedSequence = 0;
            }
        }
    }

    async function requestConfigSave(
        value: unknown = authority.config,
        sendMessage?: ConfigMessageSender,
        options: RequestConfigSaveOptions = {},
    ): Promise<void> {
        const importedCredentialBindings = getConfigImportCredentialBindings(value);
        let normalized = normalizeConfig(synchronizeLegacyTokenPatch(value));
        if (authority.initialized && authority.trusted && options.credentialIntent !== 'exact' && !importedCredentialBindings) {
            // 连接测试等普通完整 draft 与自动 patch 使用同一目的地保护；同值
            // 凭据仅在真实导入的原始 JSON 明确携带意图，或 exact 备份恢复时重绑。
            normalized = normalizeConfig(bindConfigPatchCredentialsToDestinations(
                normalized as unknown as Record<string, unknown>, normalizeConfig(authority.config), true,
            ));
        }
        return requestConfigMutation({
            mode: 'replace',
            normalized,
            messageConfig: normalized,
            credentialIntent: options.credentialIntent,
            importedCredentialBindings,
        }, sendMessage);
    }

    async function requestConfigPatch(value: unknown, sendMessage?: ConfigMessageSender): Promise<void> {
        if (!authority.initialized) await authority.ready;
        const previousConfig = normalizeConfig(authority.config);
        const patch = bindConfigPatchCredentialsToDestinations(
            createConfigPatch(synchronizeLegacyTokenPatch(value), previousConfig, authority.trusted, authority.knownFields),
            previousConfig,
            authority.trusted,
        );
        if (Object.keys(patch).length === 0) return;
        const expected = createConfigPatchExpectedValues(patch, previousConfig);
        const normalized = prepareConfigPatchFromSnapshot(
            patch,
            expected,
            previousConfig,
            authority.trusted,
            authority.knownFields,
        );
        return requestConfigMutation({
            mode: 'patch',
            normalized,
            messageConfig: patch,
            messageExpected: expected,
        }, sendMessage);
    }

    async function requestConfigHistoryAction(
        action: ConfigHistoryAction,
        version?: number,
        sendMessage?: ConfigHistoryMessageSender,
    ): Promise<ConfigHistoryState> {
        if (!sendMessage) return ports.applyHistoryAction(action, version);

        let response: ConfigHistoryMessageResponse;
        try {
            response = await sendMessage({type: CONFIG_HISTORY_MESSAGE, action, version});
        } catch (error) {
            // 只有明确“没有后台接收端”时才允许本地兜底。后台已经返回的保存失败
            // 不能再执行一次，否则可能绕过共享 mutation 队列或造成重复恢复。
            if (!(error instanceof Error) || !error.message.includes('Receiving end')) throw error;
            return ports.applyHistoryAction(action, version);
        }
        if (response?.success === false) throw new Error(response.error || '配置历史操作失败');
        if (!response?.history) throw new Error('配置历史操作没有返回结果');
        return response.history;
    }
    function deferStoredChange(value: unknown, revisionAdvanced: boolean, confirmed: boolean): boolean {
        if (!revisionAdvanced || !activeRequestSerialized || confirmed) return false;
        hasDeferredStoredConfigChange = true;
        deferredStoredConfigChange = value;
        return true;
    }
    function acceptStoredChange(input: {revisionAdvanced: boolean; localEcho: boolean; confirmed: boolean; serialized: string; sequence?: number}): boolean {
        if (input.revisionAdvanced && !input.localEcho) {
            requestGeneration += 1;
            if (latestRequestedSerialized && latestRequestedMode === 'replace') {
                latestRequestedSerialized = ''; latestRequestedMode = null; latestRequestedSequence = 0;
            }
        }
        if (input.confirmed && latestRequestedSequence > 0 && latestRequestedSequence !== input.sequence) return false;
        if (!input.confirmed && input.localEcho && latestRequestedSerialized && input.serialized !== latestRequestedSerialized) return false;
        if (!input.revisionAdvanced && latestRequestedSerialized && input.serialized !== latestRequestedSerialized) return false;
        return true;
    }
    return {
        requestConfigSave, requestConfigPatch, requestConfigCountIncrement, requestConfigHistoryAction, handoffPendingConfigPatches,
        overlayPendingCredentialEdits, deferStoredChange, acceptStoredChange,
        get queue(): Promise<void> {return requestQueue;},
    };
}
export type ConfigMutationClient = ReturnType<typeof createConfigMutationClient>;
