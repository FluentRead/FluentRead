/**
 * @file src/services/config/authority.ts
 * 文件职责：独立持有一个配置权威实例的公开快照、凭据水合、存储观察和唯一落盘状态。
 * 主要内容：保护 revision、计数日志与凭据迁移，保留原子多键提交和失败重试；客户端拥有在途字段与 ACK，历史拥有自己的快照队列，权威端只通过类型化端口协作；订阅者异常与水合、落盘和后续通知隔离。
 * 模块边界：导入和构造均不启动 I/O；start 明确注册观察并水合，具体浏览器存储与可信上下文由默认组装根注入。
 */
import type {ConfigStoragePort} from '@/src/platform/storage/configStorage';
import type {ConfigMutationClient, ConfigClientAuthorityPort} from './mutationClient';
import type {ConfigHistoryRuntime} from './historyRuntime';
import {CONFIG_HISTORY_STORAGE_KEY} from './historyRuntime';
import { synchronizeLegacyTokenPatch, prepareConfigPatchFromSnapshot, prepareConfigSaveSnapshot } from '@/src/core/config/mutations';
import { CONFIG_STORAGE_KEY, type SaveConfigOptions, type StoredConfigChangeOptions } from './protocol';
import { Config, normalizeConfig } from '@/src/core/config/model';
import { prepareConfigForExport as prepareCompleteConfigSnapshot } from '@/src/core/config/transfer';
import { LOCAL_CREDENTIALS_STORAGE_KEY, SESSION_CREDENTIALS_STORAGE_KEY, credentialsEqual, extractConfigCredentials, hasCredentialData, hasCredentialFields, mergeConfigCredentials, parseStoredCredentials, sanitizeConfigCredentials, sanitizeConfigHistoryCredentials, type ConfigCredentials } from '@/src/core/config/credentials';
import { toPublicConfig, toRestorableConfig } from './history';
import {
    CONFIG_REVISION_FIELD,
    getStoredConfigRevision,
    isConfigRecord,
    parseStoredConfig,
    serializeConfig,
} from './schema';
import { parseConfigCountIncrement, parseConfigCountOperationId } from './count';

export interface ConfigAuthorityDependencies {
    storage: ConfigStoragePort;
    trustedContext: boolean;
    client(): ConfigMutationClient;
    history(): ConfigHistoryRuntime;
}

export function createConfigAuthority(dependencies: ConfigAuthorityDependencies) {
    const storage = dependencies.storage;
    let started = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const configReady = new Promise<void>((resolve, reject) => {resolveReady = resolve; rejectReady = reject;});
    type ConfigListener = (nextConfig: Config) => void;

    const listeners = new Set<ConfigListener>();

    let storageRevision = 0;

    let initializationStoredConfig: Record<string, unknown> | null = null;

    let initialized = false;

    let lastPersistedSerialized = '';

    let writeRevision = 0;

    let writeQueue: Promise<void> = Promise.resolve();

    let persistedConfigRevision = 0;

    let lastKnownCommittedCredentials: ConfigCredentials | null = null;

    let lastKnownCommittedConfig: Config | null = null;

    let lastKnownCommittedConfigRevision = 0;

    let credentialWatchSequence = 0;

    const completedCountOperations = new Map<string, {delta: number; count: number}>();

    const activeCountOperations = new Map<string, {delta: number; promise: Promise<number>}>();

    const CONFIG_COUNT_OPERATION_CACHE_LIMIT = 1_024;

    const CONFIG_COUNT_OPERATIONS_FIELD = '__fluentCountOperations' as const;

    const config = new Config();
    // 在观察和水合之前冻结规范字段；复用唯一公开实例，避免额外默认对象或 watch 扩权。
    const knownFields = new Set(Object.keys(config));

    interface PersistedCountOperation {
        id: string;
        delta: number;
        count: number;
    }

    function parsePersistedCountOperations(value: unknown): PersistedCountOperation[] | null {
        const record = parseStoredConfig(value);
        const rawOperations = record?.[CONFIG_COUNT_OPERATIONS_FIELD];
        if (!Array.isArray(rawOperations)) return null;

        const operations: PersistedCountOperation[] = [];
        for (const value of rawOperations.slice(-CONFIG_COUNT_OPERATION_CACHE_LIMIT)) {
            if (!value || typeof value !== 'object') continue;
            const candidate = value as Partial<PersistedCountOperation>;
            const id = parseConfigCountOperationId(candidate.id);
            const delta = parseConfigCountIncrement(candidate.delta);
            if (!id || delta === null || !Number.isSafeInteger(candidate.count) || Number(candidate.count) < delta) continue;
            operations.push({id, delta, count: Number(candidate.count)});
        }
        return operations;
    }

    function replaceCompletedCountOperations(operations: PersistedCountOperation[], maximumCount: number): void {
        completedCountOperations.clear();
        for (const operation of operations) {
            if (operation.count <= maximumCount) {
                completedCountOperations.set(operation.id, {delta: operation.delta, count: operation.count});
            }
        }
    }

    function getPersistedCountOperations(nextOperation?: PersistedCountOperation): PersistedCountOperation[] {
        const operations = [...completedCountOperations].map(([id, value]) => ({id, ...value}));
        if (nextOperation) {
            // 唯一调用方已在水合前后检查完成日志；进入此处的新操作 ID 尚未提交。
            operations.push(nextOperation);
        }
        return operations.slice(-CONFIG_COUNT_OPERATION_CACHE_LIMIT);
    }

    function createStoredConfigRecord(
        nextConfig: Config,
        revision: number,
        countOperations = getPersistedCountOperations(),
    ): Record<string, unknown> {
        return {
            ...toPublicConfig(nextConfig),
            [CONFIG_REVISION_FIELD]: revision,
            ...(trustedCredentialStorageContext && countOperations.length > 0
                ? {[CONFIG_COUNT_OPERATIONS_FIELD]: countOperations}
                : {}),
        };
    }

    function notifyListener(listener: ConfigListener, snapshot: Config): void {
        try {listener(snapshot);}
        catch {console.warn('[FluentRead] 配置订阅通知失败');}
    }

    function notifyListeners(nextConfig: Config): void {
        if (listeners.size === 0) return;
        const snapshot = normalizeConfig(nextConfig);
        // UI/副作用订阅失败不能被 initializeConfig 误判为迁移失败，也不能阻止落盘。
        listeners.forEach((listener) => notifyListener(listener, snapshot));
    }

    function applyConfig(nextConfig: Config): void {
        Object.assign(config, nextConfig);
        notifyListeners(config);
    }

    function rememberCommittedConfig(
        value: unknown,
        revision = persistedConfigRevision,
    ): Config {
        const normalized = normalizeConfig(value);
        // revision 来自已校验的存储/响应；本地递增在写入前另行检查溢出。
        if (!lastKnownCommittedConfig || revision >= lastKnownCommittedConfigRevision) {
            lastKnownCommittedConfig = normalized;
            lastKnownCommittedConfigRevision = revision;
        }
        return lastKnownCommittedConfig;
    }

    function committedConfigFromStoredValue(
        value: unknown,
        credentials: ConfigCredentials | null = lastKnownCommittedCredentials,
    ): Config | null {
        const parsed = parseStoredConfig(value);
        if (!parsed) return null;
        return rememberCommittedConfig(mergeConfigCredentials(
            parsed,
            credentials || extractConfigCredentials(config),
        ), getStoredConfigRevision(parsed));
    }

    const trustedCredentialStorageContext = dependencies.trustedContext;

    const configStorageWriteOwner = storage.writeOwner !== false;

    let credentialWatchRegistered = false;

    let configStorageWritesBlocked = false;

    function assertConfigStorageWritesAllowed(): void {
        if (!configStorageWriteOwner) {
            throw new Error('当前上下文必须通过后台配置协议保存');
        }
        if (configStorageWritesBlocked) {
            throw new Error('配置安全迁移未完成，暂不写入存储；请重新加载扩展后重试');
        }
    }

    async function writeAndVerifyCredentials(
        credentials: ConfigCredentials,
    ): Promise<void> {
        await storage.setItem<ConfigCredentials>(LOCAL_CREDENTIALS_STORAGE_KEY, credentials);
        await verifyStoredCredentials(credentials);
    }

    async function verifyStoredCredentials(
        credentials: ConfigCredentials,
    ): Promise<void> {
        const verified = parseStoredCredentials(await storage.getItem<unknown>(LOCAL_CREDENTIALS_STORAGE_KEY));
        if (!verified || !credentialsEqual(credentials, verified)) {
            throw new Error(`${LOCAL_CREDENTIALS_STORAGE_KEY} 凭据写入校验失败`);
        }
    }

    async function sanitizeStoredHistory(storedHistory: unknown): Promise<void> {
        // initializeConfig 仅在非空读取快照确需脱敏时调用；复用该快照，避免重复 I/O。
        const sanitized = sanitizeConfigHistoryCredentials(storedHistory);
        if (sanitized === null) {
            await storage.removeItem(CONFIG_HISTORY_STORAGE_KEY);
            return;
        }
        await storage.setItem(CONFIG_HISTORY_STORAGE_KEY, sanitized);
    }

    function queueStorageWrite(nextConfig: Config, serialized: string, revision: number): Promise<void> {
        writeQueue = writeQueue
            .catch(() => undefined)
            .then(async () => {
                // 只写最后一次快照，避免连续输入或多个页面初始化时排队回写旧配置。
                if (revision !== writeRevision || lastPersistedSerialized !== serialized) return;
                assertConfigStorageWritesAllowed();
                try {
                    // revision 代表已经成功提交到 local:config 的版本，不能在写入前发布。
                    // 若 storage 暂时失败，下一次保存仍应从原版本继续，而不是永久冲突。
                    const storedRevision = persistedConfigRevision + 1;
                    if (!Number.isSafeInteger(storedRevision)) throw new RangeError('配置 revision 超过安全整数范围');
                    if (!trustedCredentialStorageContext) {
                        // 扩展 content script 只能持久化公开配置，不能访问专用凭据记录。
                        // 兜底写入前，toPublicConfig 会移除凭据。
                        await storage.setItem(CONFIG_STORAGE_KEY, createStoredConfigRecord(nextConfig, storedRevision));
                        persistedConfigRevision = Math.max(persistedConfigRevision, storedRevision);
                        return;
                    }

                    const credentials = extractConfigCredentials(nextConfig);

                    if (storage.setItems) {
                        await storage.setItems(new Map<string, unknown>([
                            [LOCAL_CREDENTIALS_STORAGE_KEY, credentials],
                            [CONFIG_STORAGE_KEY, createStoredConfigRecord(nextConfig, storedRevision)],
                        ]), [SESSION_CREDENTIALS_STORAGE_KEY]);
                        await verifyStoredCredentials(credentials);
                        persistedConfigRevision = Math.max(persistedConfigRevision, storedRevision);
                        return;
                    }

                    await writeAndVerifyCredentials(credentials);
                    await storage.setItem(CONFIG_STORAGE_KEY, createStoredConfigRecord(nextConfig, storedRevision));
                    persistedConfigRevision = Math.max(persistedConfigRevision, storedRevision);
                    // session:credentials 仅是上一版的兼容来源。持久记录和公开配置
                    // 均成功后再删除，任何中断都至少保留一份可恢复凭据。
                    await storage.removeItem(SESSION_CREDENTIALS_STORAGE_KEY);
                } catch (error) {
                    if (lastPersistedSerialized === serialized) lastPersistedSerialized = '';
                    throw error;
                }
            });
        return writeQueue;
    }

    async function persistNormalizedConfig(nextConfig: Config, serialized = serializeConfig(nextConfig)): Promise<void> {
        // 去重基线在入队时设置；同值请求仍须等同一写入确认，不能先报告成功。
        if (serialized === lastPersistedSerialized) return writeQueue;

        lastPersistedSerialized = serialized;
        const revision = ++writeRevision;
        await queueStorageWrite(nextConfig, serialized, revision);
    }

    function handleStoredConfigChange(value: unknown, options: StoredConfigChangeOptions = {}): void {
        storageRevision += 1;
        const parsed = parseStoredConfig(value);
        if (!parsed) return;

        const storedRevision = getStoredConfigRevision(parsed);
        if (storedRevision && storedRevision < persistedConfigRevision) return;
        if (!initialized) initializationStoredConfig = sanitizeConfigCredentials(parsed);
        const revisionAdvanced = storedRevision > persistedConfigRevision;
        const isConfirmedRequestEcho = options.confirmedRequestRevision === storedRevision
            && Boolean(options.confirmedRequestSerialized)
            && typeof options.confirmedRequestSequence === 'number';
        // 可信扩展页的整份替换明确拥有本次凭据快照。后台公开配置回读不含凭据，
        // 因此成功响应必须用该快照完成同一 revision 的本地重建，不能依赖可能迟到
        // 或丢失的 local:credentials 广播，否则立即导出/pagehide 会回灌旧 Key。
        const credentials = isConfirmedRequestEcho && options.confirmedRequestCredentials
            ? options.confirmedRequestCredentials
            : extractConfigCredentials(config);
        const normalized = normalizeConfig(mergeConfigCredentials(parsed, credentials));
        const serialized = serializeConfig(normalized);

        // runtime 消息的 storage 回声可能早于响应，并且后台会保留 count、凭据等
        // canonical 字段，因此不能靠整份 serialized 猜测归属。先暂存，收到响应
        // revision 后再判断它是本次提交还是更新的外部恢复。
        if (dependencies.client().deferStoredChange(value, revisionAdvanced, isConfirmedRequestEcho)) return;

        // 普通 watch 的更高 revision 不能只因内容等于 lastPersistedSerialized 就认作
        // 本地回声：凭据事件可能先把 last 更新成另一个页面的新状态。
        const isLocalEcho = isConfirmedRequestEcho
            || (!revisionAdvanced && serialized === lastPersistedSerialized);
        if (storedRevision) persistedConfigRevision = storedRevision;

        // 一个更高 revision 且无法归属于本页面保存请求的快照，必然来自恢复、导入
        // 或其他页面。replace 请求逐个捕获该 generation，因此即使队尾后来换成
        // patch，队列中更早的旧整份快照也会失效；patch 自身则交给字段级 CAS。
        if (!dependencies.client().acceptStoredChange({revisionAdvanced, localEcho: isLocalEcho, confirmed: isConfirmedRequestEcho, serialized, sequence: options.confirmedRequestSequence})) return;
        const persistedCountOperations = parsePersistedCountOperations(value);
        if (persistedCountOperations) {
            replaceCompletedCountOperations(persistedCountOperations, normalized.count);
        }
        rememberCommittedConfig(normalized, storedRevision);
        const runtimeAlreadyMatches = serialized === serializeConfig(config);
        if (serialized === lastPersistedSerialized && runtimeAlreadyMatches) return;

        // 外部上下文已经产生了新快照，使尚未写入的旧快照失效。
        writeRevision += 1;
        lastPersistedSerialized = serialized;
        // patch 在请求发出前已经乐观更新并通知订阅者。确认回声只更新持久化
        // revision/去重基线，不能再次 apply 同值导致 UI 重绘或监听器重复执行。
        if (runtimeAlreadyMatches) return;
        applyConfig(normalized);
    }

    function registerCredentialWatch(): void {
        if (!trustedCredentialStorageContext || credentialWatchRegistered) return;
        try {
            storage.watch(LOCAL_CREDENTIALS_STORAGE_KEY, (value) => {
                const nextCredentials = parseStoredCredentials(value) || extractConfigCredentials({});
                lastKnownCommittedCredentials = nextCredentials;
                if (lastKnownCommittedConfig) {
                    lastKnownCommittedConfig = normalizeConfig(mergeConfigCredentials(
                        lastKnownCommittedConfig,
                        nextCredentials,
                    ));
                }
                credentialWatchSequence += 1;
                // popup 初次回读期间也必须接收变更，但未完成公开配置水合时不能
                // 发布只含新凭据与默认公开字段的半套状态；初始化会按序号重读。
                if (!initialized) return;
                const normalized = normalizeConfig(mergeConfigCredentials(config, dependencies.client().overlayPendingCredentialEdits(nextCredentials)));
                const serialized = serializeConfig(normalized);
                if (serialized === serializeConfig(config)) return;
                lastPersistedSerialized = serialized;
                applyConfig(normalized);
            });
            credentialWatchRegistered = true;
        } catch (error) {
            console.warn('[FluentRead] 持久凭据监听不可用', error);
        }
    }

    function settleConcurrentConfigInitialization(
        safePublicConfig: Config | null,
        credentials?: ConfigCredentials,
        failed = false,
    ): void {
        const latestStored = initializationStoredConfig
            && getStoredConfigRevision(initializationStoredConfig) >= persistedConfigRevision
            ? initializationStoredConfig : null;
        const latestPublic = latestStored
            ? normalizeConfig(latestStored)
            : safePublicConfig ?? normalizeConfig(sanitizeConfigCredentials(config));
        const latestCredentials = trustedCredentialStorageContext
            ? lastKnownCommittedCredentials ?? credentials
            : undefined;
        const latest = latestCredentials
            ? normalizeConfig(mergeConfigCredentials(latestPublic, latestCredentials))
            : latestPublic;
        if (latestStored) {
            persistedConfigRevision = getStoredConfigRevision(latestStored);
            const operations = parsePersistedCountOperations(latestStored);
            if (operations) replaceCompletedCountOperations(operations, latest.count);
        }
        // 连续变更时结束首屏等待。后台没有稳定迁移快照，或凭据 I/O 失败时，
        // 只保留运行时状态，禁止旧读取继续清理或回写新存储；远程页的有效 watch 仍可使用。
        configStorageWritesBlocked = failed || configStorageWriteOwner
            || (trustedCredentialStorageContext && !latestCredentials);
        initialized = true;
        if (latestCredentials) lastKnownCommittedCredentials = latestCredentials;
        lastPersistedSerialized = serializeConfig(latest);
        rememberCommittedConfig(latest);
        applyConfig(latest);
        registerCredentialWatch();
    }

    async function initializeConfig(attempt = 0): Promise<void> {
        let safePublicConfig: Config | null = null;
        let storedValueRevision = storageRevision;
        let storedCredentialsRevision = credentialWatchSequence;
        try {
            // 在首次回读之前订阅凭据，否则在途旧响应与较早到达的变更之间
            // 存在丢失新 Key 的窗口；水合完成前只记录基线，不发布半套配置。
            registerCredentialWatch();
            let storedValue: unknown = null;

            // 读取过程中若收到 storage.onChanged，重新读取一次，避免旧读结果覆盖新配置。
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const revisionAtRead = storageRevision;
                storedValue = await storage.getItem<unknown>(CONFIG_STORAGE_KEY);
                storedValueRevision = revisionAtRead;
                if (revisionAtRead === storageRevision) break;
            }
            // 重读本身也可能返回旧值；有效 watch 的更高 revision 不能被它回退。
            if (initializationStoredConfig
                && getStoredConfigRevision(initializationStoredConfig) >= getStoredConfigRevision(storedValue)) {
                storedValue = initializationStoredConfig;
            }

            const parsed = parseStoredConfig(storedValue);
            persistedConfigRevision = getStoredConfigRevision(storedValue);
            const publicConfig = parsed
                ? normalizeConfig(sanitizeConfigCredentials(parsed))
                : new Config();
            safePublicConfig = publicConfig;

            // 计数操作日志与公开配置同属 local:config，必须在任何凭据 I/O 前恢复。
            // 即使 session 读取、迁移或检查点失败，同一 operationId 的重试仍能保持幂等。
            const persistedCountOperations = parsePersistedCountOperations(storedValue);
            if (persistedCountOperations) {
                replaceCompletedCountOperations(persistedCountOperations, publicConfig.count);
            }

            if (!trustedCredentialStorageContext) {
                if (storedValueRevision !== storageRevision) {
                    if (attempt === 0) return initializeConfig(1);
                    settleConcurrentConfigInitialization(safePublicConfig);
                    return;
                }
                // content script 的 location 属于网页 origin，且默认无权访问 storage.session。
                // 只加载公开配置，不在此上下文迁移、回写或监听凭据。
                initialized = true;
                lastPersistedSerialized = serializeConfig(publicConfig);
                rememberCommittedConfig(publicConfig);
                applyConfig(publicConfig);
                return;
            }

            const legacyCredentials = parsed && hasCredentialFields(parsed)
                ? extractConfigCredentials(parsed)
                : null;
            storedCredentialsRevision = credentialWatchSequence;
            const localCredentialsValue = await storage.getItem<unknown>(LOCAL_CREDENTIALS_STORAGE_KEY);
            const localCredentials = parseStoredCredentials(localCredentialsValue);
            // 历史清理是后台迁移职责，远程 UI 不为首屏读取整个历史。
            const rawHistory = configStorageWriteOwner
                ? await storage.getItem<unknown>(CONFIG_HISTORY_STORAGE_KEY) : null;
            const sanitizedRawHistory = sanitizeConfigHistoryCredentials(rawHistory);
            const historyNeedsSanitizing = rawHistory !== null
                && rawHistory !== undefined
                && serializeConfig(rawHistory) !== serializeConfig(sanitizedRawHistory);

            let sessionCredentials: ConfigCredentials | null = null;
            let sessionReadError: unknown;
            try {
                // 后台完成迁移后，远程页面只需唯一持久凭据；旧策略仍在时保留安全兜底。
                if (configStorageWriteOwner || (parsed && Object.prototype.hasOwnProperty.call(parsed, 'persistCredentials'))) {
                    sessionCredentials = parseStoredCredentials(
                        await storage.getItem<unknown>(SESSION_CREDENTIALS_STORAGE_KEY),
                    );
                }
            } catch (error) {
                sessionReadError = error;
            }

            // config 读完后还要等待 local/history/session 凭据。若这段水合窗口内其他
            // 页面提交了更高 revision，当前 parsed 与凭据不再属于同一个原子快照；
            // 整轮重读，禁止旧配置在新 watch 已应用后回滚 UI 并覆盖新设置。
            const legacyCredentialPolicyPresent = Boolean(parsed
                && Object.prototype.hasOwnProperty.call(parsed, 'persistCredentials'));
            // 上一版可能在非原子 userscript 写入中留下“session 新、local 旧”的
            // 双副本；旧策略字段仍在时让 session 胜出。完成升级并删除该字段后，
            // local:credentials 才是唯一权威，残留 session 不得回滚新凭据。
            const activeCredentials = legacyCredentialPolicyPresent && sessionCredentials
                ? sessionCredentials
                : localCredentials
                || sessionCredentials
                || legacyCredentials
                || extractConfigCredentials({});
            if (storedValueRevision !== storageRevision
                || storedCredentialsRevision !== credentialWatchSequence) {
                if (attempt === 0) return initializeConfig(1);
                settleConcurrentConfigInitialization(safePublicConfig, activeCredentials, Boolean(sessionReadError));
                return;
            }
            const normalized = parsed
                ? normalizeConfig(mergeConfigCredentials(parsed, activeCredentials))
                : normalizeConfig(mergeConfigCredentials(new Config(), activeCredentials));
            const serialized = serializeConfig(normalized);

            initialized = true;
            lastKnownCommittedCredentials = activeCredentials;
            rememberCommittedConfig(normalized);
            applyConfig(normalized);

            // popup/options/document 可以从后台读取完整凭据，但不是 IndexedDB 写入所有者。
            // 后台已经完成旧存储迁移与检查点；远程页面只水合并监听，不能再次 setItem。
            if (!configStorageWriteOwner) {
                if (sessionReadError && legacyCredentialPolicyPresent) configStorageWritesBlocked = true;
                lastPersistedSerialized = serialized;
                registerCredentialWatch();
                return;
            }

            const hasLegacyCredentialSource = sessionCredentials !== null || legacyCredentials !== null;
            const credentialsNeedPersistence = localCredentials === null
                ? hasCredentialData(activeCredentials) || hasLegacyCredentialSource
                : !credentialsEqual(localCredentials, activeCredentials);

            // 旧 session 读取暂时失败且还没有持久副本时，不能用空值覆盖未知凭据。
            if (sessionReadError && legacyCredentialPolicyPresent) {
                configStorageWritesBlocked = true;
                lastPersistedSerialized = serialized;
                console.warn('[FluentRead] 旧会话凭据暂不可读，保留原记录并暂停配置写入', sessionReadError);
                registerCredentialWatch();
                return;
            }
            // IndexedDB 已有且内容一致时直接使用，不在每次启动重复加密写回；只有
            // local 缺失或旧 session/公开配置携带了更新凭据时才建立新持久副本。
            if (credentialsNeedPersistence) {
                await writeAndVerifyCredentials(activeCredentials);
            }

            // 先建立并验证持久凭据，再清理旧历史与旧会话；最后才移除公开配置中的
            // 旧策略字段。这样任一步中断时，下次启动仍能从字段存在判断 session
            // 是否应该优先，避免非原子旧写入中的新 Key 被较旧 local 副本覆盖。
            if (historyNeedsSanitizing) await sanitizeStoredHistory(rawHistory);
            if (sessionCredentials !== null) await storage.removeItem(SESSION_CREDENTIALS_STORAGE_KEY);

            const nextStoredConfig = createStoredConfigRecord(normalized, persistedConfigRevision);
            const storedNeedsMigration = !isConfigRecord(storedValue)
                || typeof storedValue === 'string'
                || serializeConfig(storedValue) !== serializeConfig(nextStoredConfig);
            if (storedNeedsMigration) {
                const migratedRevision = persistedConfigRevision + 1;
                if (!Number.isSafeInteger(migratedRevision)) throw new RangeError('配置迁移 revision 超过安全整数范围');
                await storage.setItem(CONFIG_STORAGE_KEY, createStoredConfigRecord(normalized, migratedRevision));
                persistedConfigRevision = Math.max(persistedConfigRevision, migratedRevision);
            }
            rememberCommittedConfig(normalized);
            lastPersistedSerialized = serialized;
            registerCredentialWatch();
        } catch (error) {
            // 凭据 I/O 可能在更高 revision 的 watch 到达后失败。此时旧轮次的
            // safePublicConfig 已经过期；先用最新主记录整轮重试。若同一 I/O 继续失败，
            // 下一轮 fallback 也会基于最新公开配置，不能出现旧内容搭配新 revision。
            if (storedValueRevision !== storageRevision
                || storedCredentialsRevision !== credentialWatchSequence) {
                if (attempt === 0) return initializeConfig(1);
                settleConcurrentConfigInitialization(safePublicConfig, undefined, true);
                return;
            }
            // 在任何读取或迁移边界不确定时禁止后续覆盖 local:config；重新加载后会重新尝试水合。
            configStorageWritesBlocked = true;
            if (initialized) {
                lastPersistedSerialized = serializeConfig(config);
                console.error('[FluentRead] 配置安全迁移未完成，保留当前运行时与旧存储以便重试', error);
                return;
            }
            // local:config 已成功读取时至少保留其公开字段；凭据相关 I/O 的失败不能把计数等
            // 用户状态回滚到默认值。若连公开配置也无法读取，才使用安全默认配置。
            console.error('[FluentRead] 配置读取或安全迁移失败，保留已读取的公开配置', error);
            const fallback = safePublicConfig ?? new Config();
            initialized = true;
            lastPersistedSerialized = safePublicConfig ? serializeConfig(fallback) : '';
            rememberCommittedConfig(fallback);
            applyConfig(fallback);
            // 读取失败时不做清理或迁移，避免把暂时不可用误判为“没有凭据”。
        }
    }

    async function prepareHydratedConfigForExport(): Promise<Record<string, unknown>> {
        await waitForConfigPersistenceQueue();
        if (!trustedCredentialStorageContext) {
            throw new Error('当前页面无权导出包含 API 凭据的完整备份');
        }
        if (!initialized || configStorageWritesBlocked) {
            throw new Error('配置或凭据安全水合未完成，无法导出完整备份；请重新加载扩展后重试');
        }
        return prepareCompleteConfigSnapshot(config);
    }

    function subscribeConfig(listener: ConfigListener): () => void {
        listeners.add(listener);
        if (initialized) notifyListener(listener, normalizeConfig(config));
        return () => listeners.delete(listener);
    }

    function getConfigRevision(): number {
        return persistedConfigRevision;
    }

    async function incrementConfigCount(delta: number, operationId?: string): Promise<number> {
        const normalizedDelta = parseConfigCountIncrement(delta);
        if (normalizedDelta === null) throw new TypeError('无效的翻译计数增量');
        const normalizedOperationId = operationId === undefined ? undefined : parseConfigCountOperationId(operationId);
        if (operationId !== undefined && normalizedOperationId === null) throw new TypeError('无效的翻译计数操作标识');

        if (normalizedOperationId) {
            const completed = completedCountOperations.get(normalizedOperationId);
            if (completed) {
                if (completed.delta !== normalizedDelta) throw new Error('翻译计数操作标识与增量不一致');
                return completed.count;
            }
            const active = activeCountOperations.get(normalizedOperationId);
            if (active) {
                if (active.delta !== normalizedDelta) throw new Error('翻译计数操作标识与增量不一致');
                return active.promise;
            }
        }

        const operationPromise = writeQueue.catch(() => undefined).then(async () => {
            await configReady;
            // 请求可能早于首次 local:config 读取完成；初始化水合后必须再次检查，
            // 否则后台重启期间的同一 operationId 仍会被重复累加。
            if (normalizedOperationId) {
                const completed = completedCountOperations.get(normalizedOperationId);
                if (completed) {
                    if (completed.delta !== normalizedDelta) throw new Error('翻译计数操作标识与增量不一致');
                    return {count: completed.count, persistedOperations: getPersistedCountOperations()};
                }
            }
            assertConfigStorageWritesAllowed();
            if (!Number.isSafeInteger(config.count) || config.count < 0) {
                throw new TypeError('当前翻译计数不是非负安全整数');
            }
            const nextCount = config.count + normalizedDelta;
            if (!Number.isSafeInteger(nextCount)) throw new RangeError('翻译计数超过安全整数范围');
            const beforeSerialized = serializeConfig(config);
            const nextConfig = normalizeConfig({...config, count: nextCount});
            const nextOperation = normalizedOperationId
                ? {id: normalizedOperationId, delta: normalizedDelta, count: nextConfig.count}
                : undefined;
            const persistedOperations = getPersistedCountOperations(nextOperation);
            // count 与 operationId 同属一个 storage 记录；串行接入 writeQueue，
            // 避免与并发 saveConfig 竞态导致凭据写入被跳过或计数被旧快照覆盖。
            await storage.setItem(
                CONFIG_STORAGE_KEY,
                createStoredConfigRecord(nextConfig, persistedConfigRevision, persistedOperations),
            );
            if (lastPersistedSerialized === beforeSerialized) {
                lastPersistedSerialized = serializeConfig(nextConfig);
            }
            rememberCommittedConfig(nextConfig);
            // 后台存储会同步回放本次写入并已应用同一快照；仅在未收到回声时应用，避免订阅者重复通知。
            if (serializeConfig(config) !== lastPersistedSerialized) applyConfig(nextConfig);
            return {count: nextConfig.count, persistedOperations};
        });
        writeQueue = operationPromise.then(() => undefined, () => undefined);
        if (!normalizedOperationId) return operationPromise.then((result) => result.count);

        const promise = operationPromise.then((result) => {
            replaceCompletedCountOperations(result.persistedOperations, result.count);
            return result.count;
        });

        activeCountOperations.set(normalizedOperationId, {delta: normalizedDelta, promise});
        try {
            return await promise;
        } finally {
            activeCountOperations.delete(normalizedOperationId);
        }
    }

    function prepareConfigSaveRequest(value: unknown, currentValue: unknown = config, allowCredentialUpdates = false): Config {
        return prepareConfigSaveSnapshot(value, currentValue, allowCredentialUpdates);
    }

    function prepareConfigPatchRequest(
        value: unknown,
        expectedValue: unknown,
        currentValue: unknown = config,
        allowCredentialUpdates = false,
    ): Config {
        return prepareConfigPatchFromSnapshot(value, expectedValue, normalizeConfig(currentValue), allowCredentialUpdates, knownFields);
    }

    async function saveConfig(value: unknown = config, options: SaveConfigOptions = {}): Promise<void> {
        await configReady;
        // 首次保存前捕获原配置基线，不能让按需历史把修改后的配置当成初始版本。
        if (options.recordHistory) await dependencies.history().ready;

        // 普通设置、导入与恢复都无权回滚统计；计数只能经专用增量协议修改。
        const normalized = normalizeConfig({...normalizeConfig(synchronizeLegacyTokenPatch(value)), count: config.count});
        const serialized = serializeConfig(normalized);
        if (serializeConfig(config) !== serialized) applyConfig(normalized);
        await persistNormalizedConfig(normalized, serialized);
        rememberCommittedConfig(normalized);
        if (trustedCredentialStorageContext) {
            lastKnownCommittedCredentials = extractConfigCredentials(normalized);
        }
        if (options.recordHistory) {
            if (options.immediateHistory) {
                await dependencies.history().flush();
                await dependencies.history().flushSnapshot(toRestorableConfig(normalized));
            } else {
                dependencies.history().schedule(normalized);
            }
        }
    }

    async function waitForConfigPersistenceQueue(): Promise<void> {
        await configReady;
        let pendingRequestQueue = dependencies.client().queue;
        let pendingWriteQueue = writeQueue;
        while (true) {
            await Promise.all([pendingRequestQueue, pendingWriteQueue]);
            if (pendingRequestQueue === dependencies.client().queue && pendingWriteQueue === writeQueue) return;
            pendingRequestQueue = dependencies.client().queue;
            pendingWriteQueue = writeQueue;
        }
    }
    function start(): Promise<void> {
        if (started) return configReady;
        started = true;
        try {
            // 观察先于首次读取，避免启动窗口丢失别的上下文提交。
            storage.watch(CONFIG_STORAGE_KEY, value => handleStoredConfigChange(value));
            void initializeConfig().finally(() => {initializationStoredConfig = null;}).then(resolveReady, rejectReady);
        } catch (error) {rejectReady(error);}
        return configReady;
    }
    async function restore(normalized: Config): Promise<void> {
        await persistNormalizedConfig(normalized);
        rememberCommittedConfig(normalized);
        if (trustedCredentialStorageContext) lastKnownCommittedCredentials = extractConfigCredentials(normalized);
        if (serializeConfig(config) !== serializeConfig(normalized)) applyConfig(normalized);
    }
    const clientPort: ConfigClientAuthorityPort = {
        knownFields,
        get config() {return config;}, get initialized() {return initialized;}, get ready() {return configReady;},
        get trusted() {return trustedCredentialStorageContext;}, get writesBlocked() {return configStorageWritesBlocked;},
        get revision() {return persistedConfigRevision;}, get credentials() {return lastKnownCommittedCredentials;},
        get committedConfig() {return lastKnownCommittedConfig;}, get committedRevision() {return lastKnownCommittedConfigRevision;},
        get credentialRevision() {return credentialWatchSequence;}, storage,
        advanceRevision(revision) {persistedConfigRevision = Math.max(persistedConfigRevision, revision);},
        acceptCredentials(credentials) {lastKnownCommittedCredentials = credentials;},
        publish: applyConfig, rememberCommitted: rememberCommittedConfig, rememberStored: committedConfigFromStoredValue,
        receiveStored: handleStoredConfigChange, save: saveConfig, incrementCount: incrementConfigCount,
    };
    return {config, configReady, start, clientPort, restore, subscribeConfig, getConfigRevision, prepareHydratedConfigForExport, prepareConfigSaveRequest, prepareConfigPatchRequest, saveConfig, incrementConfigCount, waitForConfigPersistenceQueue};
}
export type ConfigAuthority = ReturnType<typeof createConfigAuthority>;
