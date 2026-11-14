/**
 * @file src/core/config/mutations.ts
 * 文件职责：定义配置字段补丁、凭据目的地保护与比较交换的纯领域策略。
 * 主要内容：规范旧 token 输入、筛选规范字段、保留后台拥有的计数与迁移字段，按服务合并凭据并拒绝过期字段基线。
 * 模块边界：所有当前配置均由调用方显式提供，不读取全局 store、浏览器、存储或页面；权威提交和客户端队列共用同一规则。
 */
import {normalizeConfig, type Config} from './model';
import {dropCredentialsForChangedDestinations} from './credentialBinding';
import {CONFIG_CREDENTIAL_FIELDS, extractConfigCredentials, mergeConfigCredentials, sanitizeConfigCredentials, type ConfigCredentialField, type ConfigCredentials} from './credentials';
const CONFIG_PATCH_PROTECTED_FIELDS = new Set<string>(['count', 'videoServiceDefaultMigrated', 'aiPlatformDefaultRemovalMigrated']);
const CONFIG_CREDENTIAL_FIELD_SET = new Set<string>(CONFIG_CREDENTIAL_FIELDS);

export function isConfigObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function configPatchValuesEqual(left: unknown, right: unknown): boolean {
    const pending: Array<[unknown, unknown]> = [[left, right]];
    const compared = new WeakMap<object, WeakSet<object>>();
    while (pending.length > 0) {
        const [a, b] = pending.pop()!;
        if (Object.is(a, b)) continue;
        if ((!Array.isArray(a) && !isConfigObject(a)) || (!Array.isArray(b) && !isConfigObject(b))) return false;
        if (Array.isArray(a) !== Array.isArray(b)) return false;
        let pairs = compared.get(a);
        if (pairs?.has(b)) continue;
        if (!pairs) {pairs = new WeakSet(); compared.set(a, pairs);}
        pairs.add(b);
        if (Array.isArray(a)) {
            if (a.length !== (b as unknown[]).length) return false;
            for (let index = 0; index < a.length; index += 1) pending.push([a[index], (b as unknown[])[index]]);
        } else {
            const keys = Object.keys(a);
            if (keys.length !== Object.keys(b).length) return false;
            for (const key of keys) {
                if (!Object.hasOwn(b, key)) return false;
                pending.push([a[key], (b as Record<string, unknown>)[key]]);
            }
        }
    }
    return true;
}

export function createConfigPatch(
    value: unknown,
    currentConfig: Config,
    allowCredentialUpdates: boolean,
    knownFields: ReadonlySet<string>,
    omitUnchanged = true,
): Record<string, unknown> {
    if (!isConfigObject(value)) return {};
    const requestedFields = Object.fromEntries(
        Object.entries(value).filter(([key]) => (
            knownFields.has(key)
            && !CONFIG_PATCH_PROTECTED_FIELDS.has(key)
            && (allowCredentialUpdates || !CONFIG_CREDENTIAL_FIELD_SET.has(key))
        )),
    );
    if (Object.keys(requestedFields).length === 0) return {};

    const normalized = normalizeConfig({
        ...currentConfig,
        ...requestedFields,
        count: currentConfig.count,
        videoServiceDefaultMigrated: currentConfig.videoServiceDefaultMigrated,
        aiPlatformDefaultRemovalMigrated: currentConfig.aiPlatformDefaultRemovalMigrated,
    });
    return Object.fromEntries(
        Object.keys(requestedFields)
            .filter((key) => !omitUnchanged || !configPatchValuesEqual(
                normalized[key as keyof Config],
                currentConfig[key as keyof Config],
            ))
            .map((key) => [key, normalized[key as keyof Config]]),
    );
}

export function createConfigPatchExpectedValues(
    patch: Record<string, unknown>,
    currentConfig: Config,
): Record<string, unknown> {
    return Object.fromEntries(
        Object.keys(patch).map((key) => [key, currentConfig[key as keyof Config]]),
    );
}

export function synchronizeLegacyTokenPatch(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const source = value as Record<string, unknown>;
    if (!Object.hasOwn(source, 'token') || !source.token || typeof source.token !== 'object' || Array.isArray(source.token)) return value;
    const apiKeys = Object.hasOwn(source, 'apiKeys') && source.apiKeys && typeof source.apiKeys === 'object' && !Array.isArray(source.apiKeys)
        ? {...source.apiKeys as Record<string, unknown>}
        : {};
    let changed = false;
    // 原始旧 token 全清空也必须在字段 patch 合并前清空 canonical 列表；
    // core 的新字段优先契约不能替保存 API 猜测旧镜像的编辑意图。
    if (Object.keys(source.token as Record<string, unknown>).length === 0) {
        return {...source, apiKeys: {}};
    }
    for (const [service, token] of Object.entries(source.token as Record<string, unknown>)) {
        if (typeof token !== 'string') continue;
        const existing = apiKeys[service];
        if (Array.isArray(existing) && existing.length > 1) continue;
        apiKeys[service] = token ? [token] : [];
        changed = true;
    }
    return changed ? {...source, apiKeys} : value;
}

export function bindConfigPatchCredentialsToDestinations(
    patch: Record<string, unknown>,
    currentValue: Config,
    allowCredentialUpdates: boolean,
): Record<string, unknown> {
    if (!allowCredentialUpdates) return patch;
    const nextConfig = normalizeConfig({...currentValue, ...patch});
    // 普通 UI 会提交完整 draft，只有真实变化的凭据项才拥有重绑意图。
    const explicitlyBoundTokens = new Set([
        ...Object.keys(currentValue.token), ...Object.keys(nextConfig.token),
    ].filter(service => !configPatchValuesEqual(currentValue.token[service], nextConfig.token[service])));
    const explicitlyBoundApiKeys = new Set([
        ...Object.keys(currentValue.apiKeys), ...Object.keys(nextConfig.apiKeys),
    ].filter(service => !configPatchValuesEqual(currentValue.apiKeys[service], nextConfig.apiKeys[service])));
    const explicitlyBoundCredentialFields = new Set<ConfigCredentialField>(
        CONFIG_CREDENTIAL_FIELDS.filter((field) => (
            field !== 'token'
            && field !== 'apiKeys'
            && Object.prototype.hasOwnProperty.call(patch, field)
            && !configPatchValuesEqual(currentValue[field], nextConfig[field])
        )),
    );
    const credentials = dropCredentialsForChangedDestinations(
        extractConfigCredentials(nextConfig),
        currentValue,
        nextConfig,
        explicitlyBoundTokens,
        explicitlyBoundCredentialFields,
        new Set(Object.keys(nextConfig.customHeaders).filter((service) => !configPatchValuesEqual(
            currentValue.customHeaders[service], nextConfig.customHeaders[service],
        ))),
        explicitlyBoundApiKeys,
    );
    if (Object.keys(nextConfig.secret).length > 0) {
        const explicitlyBoundSecrets = new Set(Object.keys(nextConfig.secret).filter(service => (
            Object.hasOwn(patch, 'secret') && !configPatchValuesEqual(currentValue.secret[service], nextConfig.secret[service])
        )));
        credentials.secret = dropCredentialsForChangedDestinations(
            {...extractConfigCredentials({}), secret: nextConfig.secret},
            currentValue,
            nextConfig,
            explicitlyBoundSecrets,
        ).secret;
    }
    let boundPatch = patch;
    for (const field of CONFIG_CREDENTIAL_FIELDS) {
        if (configPatchValuesEqual(credentials[field], nextConfig[field])) continue;
        if (boundPatch === patch) boundPatch = {...patch};
        boundPatch[field] = credentials[field];
    }
    return boundPatch;
}

export function mergeCredentialFields(
    baseCredentials: ConfigCredentials,
    requestedCredentials: ConfigCredentials,
    fields: ReadonlySet<ConfigCredentialField>,
    tokenServices: ReadonlySet<string> = new Set(),
    apiKeyServices: ReadonlySet<string> = new Set(),
    secretServices: ReadonlySet<string> = new Set(),
): ConfigCredentials {
    const candidate = mergeConfigCredentials({}, baseCredentials);
    for (const field of fields) candidate[field] = requestedCredentials[field];
    if (tokenServices.size > 0) {
        const token = {...baseCredentials.token};
        for (const service of tokenServices) {
            if (Object.prototype.hasOwnProperty.call(requestedCredentials.token, service)) {
                token[service] = requestedCredentials.token[service];
            } else {
                delete token[service];
            }
        }
        candidate.token = token;
    }
    if (apiKeyServices.size > 0) {
        const apiKeys: Record<string, string[]> = Object.fromEntries(Object.entries(baseCredentials.apiKeys)
            .map(([service, keys]) => [service, [...keys]]));
        for (const service of apiKeyServices) {
            if (Object.prototype.hasOwnProperty.call(requestedCredentials.apiKeys, service)) {
                apiKeys[service] = [...requestedCredentials.apiKeys[service]!];
            } else {
                delete apiKeys[service];
            }
        }
        candidate.apiKeys = apiKeys;
    }
    if (secretServices.size > 0) {
        const secret = {...baseCredentials.secret};
        for (const service of secretServices) {
            if (Object.hasOwn(requestedCredentials.secret, service)) secret[service] = requestedCredentials.secret[service];
            else delete secret[service];
        }
        candidate.secret = secret;
    }
    return extractConfigCredentials(candidate);
}

export function prepareConfigSaveSnapshot(
    value: unknown,
    currentValue: unknown,
    allowCredentialUpdates = false,
): Config {
    const currentConfig = normalizeConfig(currentValue);
    const incomingConfig = normalizeConfig(synchronizeLegacyTokenPatch(value));
    if (allowCredentialUpdates) {
        return normalizeConfig({
            ...incomingConfig,
            count: currentConfig.count,
            videoServiceDefaultMigrated: currentConfig.videoServiceDefaultMigrated,
            aiPlatformDefaultRemovalMigrated: currentConfig.aiPlatformDefaultRemovalMigrated,
        });
    }

    return normalizeConfig(mergeConfigCredentials({
        ...sanitizeConfigCredentials(incomingConfig),
        count: currentConfig.count,
        videoServiceDefaultMigrated: currentConfig.videoServiceDefaultMigrated,
        aiPlatformDefaultRemovalMigrated: currentConfig.aiPlatformDefaultRemovalMigrated,
    }, extractConfigCredentials(currentConfig)));
}

export function prepareConfigPatchFromSnapshot(
    value: unknown,
    expectedValue: unknown,
    currentConfig: Config,
    allowCredentialUpdates: boolean,
    knownFields: ReadonlySet<string>,
): Config {
    // 后台必须对 wire patch 中每个合法字段执行 CAS；即使别的页面已经写成
    // 相同目标值，也不能先按“当前无变化”删掉该字段并绕过 expected 校验。
    const explicitPatch = createConfigPatch(value, currentConfig, allowCredentialUpdates, knownFields, false);
    const expected = isConfigObject(expectedValue) ? expectedValue : {};
    const conflicts = Object.keys(explicitPatch).filter((key) => (
        !Object.prototype.hasOwnProperty.call(expected, key)
        || !configPatchValuesEqual(currentConfig[key as keyof Config], expected[key])
    ));
    if (conflicts.length > 0) {
        throw new Error(`配置字段已更新，请同步后重试：${conflicts.join(', ')}`);
    }
    const synchronizedInput = synchronizeLegacyTokenPatch(value);
    // 无旧 token 派生变更时兼容函数原样返回输入，候选字段与已校验 CAS 的 explicitPatch 完全相同。
    const synchronizedPatch = synchronizedInput === value
        ? explicitPatch
        : createConfigPatch(synchronizedInput, currentConfig, allowCredentialUpdates, knownFields, false);
    for (const field of ['apiKeys'] as const) {
        if (Object.prototype.hasOwnProperty.call(synchronizedPatch, field)
            && !Object.prototype.hasOwnProperty.call(explicitPatch, field)) {
            explicitPatch[field] = synchronizedPatch[field];
        }
    }
    // 凭据清除是路由 patch 在后台权威基线上派生的副作用，不要求旧客户端
    // 额外伪造 expected 字段；显式凭据 patch 仍按上面的常规 CAS 校验。
    const patch = bindConfigPatchCredentialsToDestinations(
        explicitPatch,
        currentConfig,
        allowCredentialUpdates,
    );
    return normalizeConfig({
        ...currentConfig,
        ...patch,
        count: currentConfig.count,
        videoServiceDefaultMigrated: currentConfig.videoServiceDefaultMigrated,
        aiPlatformDefaultRemovalMigrated: currentConfig.aiPlatformDefaultRemovalMigrated,
    });
}
