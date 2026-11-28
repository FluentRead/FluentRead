/**
 * @file src/features/settings/ui/useServiceCatalogActions.ts
 * 文件职责：封装设置页翻译服务目录的可用性切换、移除确认、自定义 OpenAI 与组合翻译增删改查、模型切换及服务能力派生状态。
 * 主要内容：提供原子配置更新辅助、服务目录分组与可用性计算、移除确认上下文及键盘交互、自定义/组合服务 CRUD、模型思考开关和当前编辑服务表单能力集合。
 * 模块边界：仅编排设置页服务目录与表单状态，不执行网络连通性测试、后台持久化传输或设置分区路由跳转。
 */
import {computed, ref, shallowRef, watch, type ComputedRef, type Ref} from 'vue';
import {ElMessage} from 'element-plus';
import {
    cloudRegionOptions,
    customModelString,
    defaultOption,
    getCloudCredentialLabels,
    getDefaultCloudRegion,
    services,
    servicesType,
} from '@/src/core/config/catalog';
import {
    createNextCustomOpenAIProviderId,
    getCustomOpenAIProvider,
    isCustomOpenAIProviderId,
    LEGACY_CUSTOM_OPENAI_PROVIDER_ID,
    normalizeCustomOpenAIModels,
    normalizeCustomOpenAIProviders,
    removeCustomOpenAIProvider,
    type CustomOpenAIProvider,
} from '@/src/core/config/customOpenAI';
import {
    createNextCompositeTranslationProviderId,
    getCompositeTranslationProvider,
    normalizeCompositeTranslationProviders,
    removeCompositeTranslationProvider,
    type CompositeTranslationProvider,
} from '@/src/core/config/compositeTranslation';
import {withModelThinkingPreference} from '@/src/core/config/modelThinking';
import {normalizeConfig, type Config} from '@/src/core/config/model';
import {removeConfiguredModel} from '@/src/core/config/modelEditing';
import {normalizeDisabledTranslationServices} from '@/src/core/config/serviceAvailability';
import {
    getApiKeyRequirementKey,
    getMissingCredentialMessage,
    isApiKeyRequired,
} from '@/src/core/config/validation';
import {chatGPTPlanDevelopmentEnabled} from '@/src/platform/chatgpt-plan/buildMode';
import {useSettingsActionContext} from '../model/useSettingsActionContext';
import {useServiceModelOptions} from './services/modelOptions';

export interface CustomProviderDraft {
    name: string;
    endpoint: string;
    apiKey: string;
    model: string;
}

export interface ServiceOptionItem {
    value: string;
    label: string;
    disabled?: boolean;
}

export interface UseServiceCatalogActionsOptions {
    config: Ref<Config>;
    configurationService: Ref<string | null>;
    selectedConfigurationService: ComputedRef<string>;
    platformAvailableServiceOptions: ComputedRef<ServiceOptionItem[]>;
    availableServiceOptions: ComputedRef<ServiceOptionItem[]>;
    viewActive: Ref<boolean>;
    activeSection: () => string;
    activePanel: () => string | undefined;
    isDisposed: () => boolean;
    customProviderDialogOpen: Ref<boolean>;
    customProviderDialogRequested: Ref<boolean>;
}

export function useServiceCatalogActions(options: UseServiceCatalogActionsOptions) {
    const {
        config,
        configurationService,
        selectedConfigurationService,
        platformAvailableServiceOptions,
        availableServiceOptions,
        viewActive,
        activeSection,
        activePanel,
        isDisposed,
        customProviderDialogOpen,
        customProviderDialogRequested,
    } = options;

    function updateConfigAtomically(update: (draft: Config) => void): void {
        const draft = normalizeConfig(config.value);
        update(draft);
        config.value = normalizeConfig(draft);
    }

    // 显式设为默认沿用通用设置的配置补丁链；目录浏览本身只改变编辑目标。
    const setDefaultConfigurationService = (value: string) => {
        if (!viewActive.value || activeSection() !== 'settings-services'
            || (value === services.chatgptPlan && !chatGPTPlanDevelopmentEnabled)
            || value !== selectedConfigurationService.value
            || !availableServiceOptions.value.some(item => item.value === value && !item.disabled)) return;
        config.value.service = value;
    };

    const manageableServiceOptions = computed(() => platformAvailableServiceOptions.value
        .filter(item => !item.disabled && item.value !== 'machine' && item.value !== 'ai'));

    const removedServiceOptions = computed(() => {
        const disabled = new Set(normalizeDisabledTranslationServices(config.value.disabledTranslationServices));
        return manageableServiceOptions.value.filter(item => disabled.has(item.value));
    });

    function resolveServiceAvailabilityChange(service: string, enabled: boolean) {
        const serviceOptions = manageableServiceOptions.value;
        const item = serviceOptions.find(option => option.value === service);
        const disabled = new Set(normalizeDisabledTranslationServices(config.value.disabledTranslationServices));
        if (!item || disabled.has(service) === !enabled) return;
        if (enabled) disabled.delete(service);
        else disabled.add(service);
        const fallback = serviceOptions.find(option => !disabled.has(option.value));
        if (!fallback) return;
        const replacement = disabled.has(config.value.service) ? fallback : undefined;
        return {item, disabled, replacement};
    }

    const serviceAvailabilityContext = useSettingsActionContext(
        () => viewActive.value && activeSection() === 'settings-services' && (!activePanel() || activePanel() === 'connections'),
        () => [config.value, selectedConfigurationService.value],
    );

    const pendingServiceAvailability = shallowRef<(Pick<NonNullable<ReturnType<typeof resolveServiceAvailabilityChange>>, 'item' | 'replacement'> & {
        current: () => boolean;
    }) | null>(null);

    function requestServiceRemoval(service: string, enabled: boolean): void {
        if (!serviceAvailabilityContext.active.value || pendingServiceAvailability.value || enabled !== false) return;
        const change = resolveServiceAvailabilityChange(service, false);
        if (change) {
            const {item, replacement} = change;
            pendingServiceAvailability.value = {item, replacement, current: serviceAvailabilityContext.capture()};
        }
    }

    const currentServiceAvailabilityChange = computed(() => {
        const request = pendingServiceAvailability.value;
        if (!request?.current()) return;
        const change = resolveServiceAvailabilityChange(request.item.value, false);
        if (change?.item === request.item && change.replacement === request.replacement) return change;
    });

    watch(currentServiceAvailabilityChange, change => {
        if (!change) pendingServiceAvailability.value = null;
    }, {flush: 'sync'});

    function applyServiceAvailabilityChange(change: NonNullable<ReturnType<typeof resolveServiceAvailabilityChange>>): void {
        updateConfigAtomically(draft => {
            draft.disabledTranslationServices = [...change.disabled];
            if (change.replacement) draft.service = change.replacement.value;
        });
    }

    const serviceAvailabilityActions = computed(() => {
        const request = pendingServiceAvailability.value;
        const cancel = () => {
            if (request === pendingServiceAvailability.value) pendingServiceAvailability.value = null;
        };
        const confirm = () => {
            const change = request && request === pendingServiceAvailability.value
                ? currentServiceAvailabilityChange.value
                : undefined;
            cancel();
            if (!change) return;
            applyServiceAvailabilityChange(change);
        };
        return {
            cancel,
            update: (open: boolean) => { if (!open) cancel(); },
            confirm,
            handleEnter: (event: KeyboardEvent) => {
                if (event.repeat || event.isComposing) {
                    event.preventDefault();
                    return;
                }
                // Element Plus 将初始焦点放在弹窗容器。焦点移到按钮后，由按钮处理回车。
                if (event.target === event.currentTarget) {
                    event.preventDefault();
                    confirm();
                }
            },
        };
    });

    function restoreService(service: string): void {
        if (!serviceAvailabilityContext.active.value) return;
        const change = resolveServiceAvailabilityChange(service, true);
        if (change) applyServiceAvailabilityChange(change);
    }

    // 目录中的机器 / AI 标记只用于分组，不再作为不可选择的菜单选项。
    const textServiceGroups = computed(() => {
        const groups: {value: string; label: string; options: ServiceOptionItem[]}[] = [];
        for (const item of availableServiceOptions.value) {
            if (item.value === 'machine' || item.value === 'ai') {
                groups.push({value: item.value, label: item.label, options: []});
            } else {
                groups.at(-1)?.options.push(item);
            }
        }
        return groups.filter(group => group.options.length > 0);
    });

    const {
        builtInModels: builtInConfigurationModels,
        customModelCount: selectedConfigurationCustomModelCount,
        modelOptions: configurationModelOptions,
        selectedCustomProvider,
        selectedModel: selectedConfigurationModel,
        selectedModelThinking: selectedConfigurationModelThinking,
    } = useServiceModelOptions(config, selectedConfigurationService);

    function openCustomProviderDialog(): void {
        if (isDisposed() || !serviceAvailabilityContext.active.value) return;
        customProviderDialogRequested.value = true;
        customProviderDialogOpen.value = true;
    }

    function createCompositeProvider(draft: Omit<CompositeTranslationProvider, 'id'>): void {
        if (isDisposed() || !viewActive.value || activeSection() !== 'settings-services') return;
        const id = createNextCompositeTranslationProviderId(config.value.compositeTranslationProviders);
        updateConfigAtomically((next) => {
            next.compositeTranslationProviders = normalizeCompositeTranslationProviders([
                ...next.compositeTranslationProviders, {...draft, id},
            ], next.customOpenAIProviders);
        });
        configurationService.value = id;
        ElMessage({message: '组合翻译已添加', type: 'success', grouping: true, duration: 1800});
    }

    function deleteSelectedCompositeProvider(service: string): void {
        if (isDisposed() || !viewActive.value || activeSection() !== 'settings-services'
            || service !== selectedConfigurationService.value
            || !getCompositeTranslationProvider(config.value.compositeTranslationProviders, service)) return;
        updateConfigAtomically((next) => {
            next.compositeTranslationProviders = removeCompositeTranslationProvider(next.compositeTranslationProviders, service);
            // 归一化负责清理各功能、快捷方案与常用列表中的失效组合选择。
            if (next.service === service) next.service = defaultOption.service;
        });
        configurationService.value = config.value.service;
        ElMessage({message: '组合翻译已删除', type: 'success', grouping: true, duration: 1800});
    }

    function createCustomProvider(draft: CustomProviderDraft): void {
        if (isDisposed() || !viewActive.value || activeSection() !== 'settings-services') return;
        const id = createNextCustomOpenAIProviderId(config.value.customOpenAIProviders);
        const provider: CustomOpenAIProvider = {
            id,
            name: draft.name,
            endpoint: draft.endpoint,
            models: [draft.model],
        };
        updateConfigAtomically((next) => {
            next.customOpenAIProviders = normalizeCustomOpenAIProviders([
                ...next.customOpenAIProviders,
                provider,
            ]);
            next.model[id] = draft.model;
            next.documentModel[id] = draft.model;
            next.system_role[id] = defaultOption.system_role;
            next.user_role[id] = defaultOption.user_role;
            if (draft.apiKey) next.token[id] = draft.apiKey;
            next.modelThinking = withModelThinkingPreference(next.modelThinking, id, draft.model, false);
        });
        configurationService.value = id;
        ElMessage({message: '自定义服务已添加', type: 'success', grouping: true, duration: 1800});
    }

    function updateSelectedCustomProvider(patch: Partial<Pick<CustomOpenAIProvider, 'name' | 'endpoint'>>): void {
        const service = selectedConfigurationService.value;
        config.value.customOpenAIProviders = config.value.customOpenAIProviders.map((provider) => (
            provider.id === service ? {...provider, ...patch} : provider
        ));
    }

    function deleteSelectedCustomProvider(): void {
        const service = selectedConfigurationService.value;
        if (!getCustomOpenAIProvider(config.value.customOpenAIProviders, service)) return;
        updateConfigAtomically((next) => {
            next.customOpenAIProviders = removeCustomOpenAIProvider(next.customOpenAIProviders, service);
            for (const mapping of [
                next.token,
                next.model,
                next.documentModel,
                next.customModel,
                next.customModels,
                next.modelThinking,
                next.documentCustomModel,
                next.proxy,
                next.system_role,
                next.user_role,
                next.customBody,
                next.customHeaders,
            ]) delete mapping[service];
            // normalizeConfig 会根据删除后的 profile 列表精确保留仍可达的鉴权键。
            // 不能用 `${service}:` 做前缀删除：旧 ID `custom` 也是新 ID
            // `custom:*` 的前缀，会误删其他自定义服务的免 Key 偏好。
            if (next.service === service) next.service = defaultOption.service;
            if (next.documentService === service) next.documentService = '';
            if (next.videoService === service) next.videoService = '';
            next.translationCenterServices = next.translationCenterServices.filter((item) => item !== service);
            if (service === LEGACY_CUSTOM_OPENAI_PROVIDER_ID) next.custom = defaultOption.custom;
        });
        configurationService.value = config.value.service;
        ElMessage({message: '自定义服务已删除', type: 'success', grouping: true, duration: 1800});
    }

    function selectConfigurationModel(model: string): void {
        const service = selectedConfigurationService.value;
        if (selectedCustomProvider.value) {
            config.value.model[service] = model;
            return;
        }
        if (builtInConfigurationModels.value.includes(model)) {
            config.value.model[service] = model;
            return;
        }
        updateConfigAtomically((next) => {
            next.customModel[service] = model;
            next.model[service] = customModelString;
        });
    }

    function updateSelectedConfigurationModelThinking(enabled: boolean): void {
        const service = selectedConfigurationService.value;
        const model = selectedConfigurationModel.value;
        if (!model) return;
        config.value.modelThinking = withModelThinkingPreference(
            config.value.modelThinking,
            service,
            model,
            enabled,
        );
    }

    function addConfigurationModel(model: string): void {
        const service = selectedConfigurationService.value;
        const provider = selectedCustomProvider.value;
        if (provider) {
            updateConfigAtomically((next) => {
                next.customOpenAIProviders = normalizeCustomOpenAIProviders(
                    next.customOpenAIProviders.map((item) => item.id === service
                        ? {...item, models: [...item.models, model]}
                        : item),
                );
                next.model[service] = model;
                next.modelThinking = withModelThinkingPreference(next.modelThinking, service, model, false);
            });
            return;
        }
        updateConfigAtomically((next) => {
            next.customModels[service] = normalizeCustomOpenAIModels([
                ...(next.customModels[service] || []),
                model,
            ]);
            next.customModel[service] = model;
            next.model[service] = customModelString;
            next.modelThinking = withModelThinkingPreference(next.modelThinking, service, model, false);
        });
    }

    function removeConfigurationModel(model: string): void {
        updateConfigAtomically(next => removeConfiguredModel(
            next, selectedConfigurationService.value, model, builtInConfigurationModels.value[0] || '',
        ));
    }

    // 右侧表单只派生当前编辑服务；默认翻译服务仍由 config.service 独立管理。
    const configurationCompute = ref({
        showAI: computed(() => (selectedConfigurationService.value !== services.chatgptPlan || chatGPTPlanDevelopmentEnabled) && (isCustomOpenAIProviderId(selectedConfigurationService.value) || servicesType.isAI(selectedConfigurationService.value))),
        showProxy: computed(() => isCustomOpenAIProviderId(selectedConfigurationService.value) || servicesType.isUseProxy(selectedConfigurationService.value)),
        showModel: computed(() => selectedConfigurationService.value !== services.chatgptPlan && (isCustomOpenAIProviderId(selectedConfigurationService.value) || servicesType.isUseModel(selectedConfigurationService.value))),
        showCustomBody: computed(() => isCustomOpenAIProviderId(selectedConfigurationService.value) || servicesType.isUseCustomBody(selectedConfigurationService.value)),
        showToken: computed(() => isCustomOpenAIProviderId(selectedConfigurationService.value) || servicesType.isUseToken(selectedConfigurationService.value)),
        allowCustomModels: computed(() => selectedConfigurationService.value !== services.localTranslation),
        requireApiKey: computed({
            get: () => isApiKeyRequired(selectedConfigurationService.value, config.value),
            set: (value: boolean) => {
                config.value.requireApiKey[getApiKeyRequirementKey(selectedConfigurationService.value, config.value)] = value;
            },
        }),
        credentialWarning: computed(() => getMissingCredentialMessage(selectedConfigurationService.value, config.value)),
        showYoudao: computed(() => servicesType.isYoudao(selectedConfigurationService.value)),
        showTencent: computed(() => servicesType.isTencent(selectedConfigurationService.value)),
        // 云服务厂商：主密钥沿用 token[service]，第二段密钥与地域分别来自 secret/serviceRegion。
        showCloudVendor: computed(() => servicesType.isCloudVendor(selectedConfigurationService.value)),
        showServiceSecret: computed(() => servicesType.isUseSecret(selectedConfigurationService.value)),
        showServiceRegion: computed(() => servicesType.isUseRegion(selectedConfigurationService.value)),
        cloudCredentialLabels: computed(() => getCloudCredentialLabels(selectedConfigurationService.value)),
        cloudRegionOptions: computed(() => cloudRegionOptions[selectedConfigurationService.value] || []),
        defaultCloudRegion: computed(() => getDefaultCloudRegion(selectedConfigurationService.value)),
        showOllamaEndpoint: computed(() => selectedConfigurationService.value === services.ollama),
        showCustomOpenAI: computed(() => Boolean(getCustomOpenAIProvider(config.value.customOpenAIProviders, selectedConfigurationService.value))),
        showDeepLX: computed(() => selectedConfigurationService.value === 'deeplx'),
        showMiniMaxRegion: computed(() => selectedConfigurationService.value === services.minimax),
        showMiMoRegion: computed(() => selectedConfigurationService.value === services.mimo),
        showNewAPI: computed(() => servicesType.isNewApi(selectedConfigurationService.value)),
        showAzureOpenaiEndpoint: computed(() => servicesType.isAzureOpenai(selectedConfigurationService.value)),
        showDeepseekApiType: computed(() => selectedConfigurationService.value === 'deepseek'),
    });

    return {
        updateConfigAtomically,
        setDefaultConfigurationService,
        manageableServiceOptions,
        removedServiceOptions,
        serviceAvailabilityContext,
        pendingServiceAvailability,
        requestServiceRemoval,
        currentServiceAvailabilityChange,
        serviceAvailabilityActions,
        restoreService,
        textServiceGroups,
        builtInConfigurationModels,
        selectedConfigurationCustomModelCount,
        configurationModelOptions,
        selectedCustomProvider,
        selectedConfigurationModel,
        selectedConfigurationModelThinking,
        openCustomProviderDialog,
        createCompositeProvider,
        deleteSelectedCompositeProvider,
        createCustomProvider,
        updateSelectedCustomProvider,
        deleteSelectedCustomProvider,
        selectConfigurationModel,
        updateSelectedConfigurationModelThinking,
        addConfigurationModel,
        removeConfigurationModel,
        configurationCompute,
    };
}
