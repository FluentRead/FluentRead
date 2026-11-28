/**
 * @file tests/useServiceCatalogActions.test.ts
 * 文件职责：验证设置页服务目录与模型编辑组合式逻辑（useServiceCatalogActions）的完整分支行为。
 * 主要内容：覆盖服务可用性变更取消/确认/过期防护、面板激活守卫、复合服务与自定义 OpenAI 服务增删改及默认回退、模型与思考开关编辑、以及 ChatGPT Plan 等派生展示标志。
 * 模块边界：仅通过真实 Vue 响应式 API 与本地内存配置对象测试组合式逻辑，不依赖外部网络或后台持久化通道。
 */
import {computed, ref} from 'vue';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {normalizeConfig} from '@/src/core/config/model';
import {services} from '@/src/core/config/catalog';
import {LEGACY_CUSTOM_OPENAI_PROVIDER_ID} from '@/src/core/config/customOpenAI';

vi.mock('element-plus', () => ({
    ElMessage: vi.fn(),
}));

import {useServiceCatalogActions, type ServiceOptionItem} from '@/src/features/settings/ui/useServiceCatalogActions';

afterEach(() => {
    vi.clearAllMocks();
});

function setupActions(overrides?: {
    viewActive?: boolean;
    section?: string;
    panel?: string | undefined;
    disposed?: boolean;
    options?: ServiceOptionItem[];
    selectedService?: string;
}) {
    const config = ref(normalizeConfig({}));
    const configurationService = ref<string | null>(overrides?.selectedService ?? services.google);
    const selectedConfigurationService = computed(() => configurationService.value || config.value.service);
    const platformAvailableServiceOptions = computed<ServiceOptionItem[]>(() => overrides?.options ?? [
        {value: 'machine', label: '机器翻译'},
        {value: services.google, label: 'Google'},
        {value: services.microsoft, label: 'Microsoft'},
        {value: 'ai', label: 'AI 翻译'},
        {value: services.openai, label: 'OpenAI'},
        {value: services.chatgptPlan, label: 'ChatGPT Plan'},
    ]);
    const availableServiceOptions = computed(() => {
        const disabled = new Set(config.value.disabledTranslationServices);
        return platformAvailableServiceOptions.value.filter(item => !disabled.has(item.value));
    });
    const viewActive = ref(overrides?.viewActive ?? true);
    const section = ref(overrides?.section ?? 'settings-services');
    const panel = ref<string | undefined>(overrides?.panel);
    let disposed = overrides?.disposed ?? false;
    const customProviderDialogOpen = ref(false);
    const customProviderDialogRequested = ref(false);

    const actions = useServiceCatalogActions({
        config,
        configurationService,
        selectedConfigurationService,
        platformAvailableServiceOptions,
        availableServiceOptions,
        viewActive,
        activeSection: () => section.value,
        activePanel: () => panel.value,
        isDisposed: () => disposed,
        customProviderDialogOpen,
        customProviderDialogRequested,
    });

    return {
        config,
        configurationService,
        selectedConfigurationService,
        viewActive,
        setSection: (v: string) => {section.value = v;},
        setPanel: (v: string | undefined) => {panel.value = v;},
        setDisposed: (v: boolean) => {disposed = v;},
        actions,
    };
}

describe('useServiceCatalogActions 边界与完整分支', () => {
    it('处理服务移除/恢复的上下文守卫、无变化短路与对话框动作', () => {
        const ctx = setupActions({panel: 'connections'});
        expect(ctx.actions.serviceAvailabilityContext.active.value).toBe(true);

        // 非 connections 面板时上下文失活，requestServiceRemoval / restoreService 均短路
        ctx.setPanel('models');
        expect(ctx.actions.serviceAvailabilityContext.active.value).toBe(false);
        ctx.actions.requestServiceRemoval(services.google, false);
        expect(ctx.actions.pendingServiceAvailability.value).toBeNull();
        ctx.actions.restoreService(services.google);

        // 恢复面板激活；enabled !== false 短路
        ctx.setPanel('connections');
        ctx.actions.requestServiceRemoval(services.google, true);
        expect(ctx.actions.pendingServiceAvailability.value).toBeNull();

        // 未知服务与已启用服务恢复均短路
        ctx.actions.requestServiceRemoval('non-existent', false);
        expect(ctx.actions.pendingServiceAvailability.value).toBeNull();
        ctx.actions.restoreService('non-existent');
        ctx.actions.restoreService(services.google);

        // 正常发起移除后，重复发起被 pending 守卫拦截
        ctx.actions.requestServiceRemoval(services.google, false);
        expect(ctx.actions.pendingServiceAvailability.value?.item.value).toBe(services.google);
        const firstPending = ctx.actions.pendingServiceAvailability.value;
        ctx.actions.requestServiceRemoval(services.microsoft, false);
        expect(ctx.actions.pendingServiceAvailability.value).toBe(firstPending);

        // update(true) 不取消，update(false) 取消
        const snapshotActions = ctx.actions.serviceAvailabilityActions.value;
        snapshotActions.update(true);
        expect(ctx.actions.pendingServiceAvailability.value).toBe(firstPending);
        snapshotActions.update(false);
        expect(ctx.actions.pendingServiceAvailability.value).toBeNull();

        // 过期句柄的 cancel 与 confirm 均安全空操作
        snapshotActions.cancel();
        snapshotActions.confirm();
        ctx.actions.serviceAvailabilityActions.value.confirm();

        // 正常 confirm 后再 restoreService
        ctx.actions.requestServiceRemoval(services.google, false);
        ctx.actions.serviceAvailabilityActions.value.confirm();
        expect(ctx.config.value.disabledTranslationServices).toContain(services.google);
        // 再次请求移除已禁用的服务短路
        ctx.actions.requestServiceRemoval(services.google, false);
        expect(ctx.actions.pendingServiceAvailability.value).toBeNull();
        ctx.actions.restoreService(services.google);
        expect(ctx.config.value.disabledTranslationServices).not.toContain(services.google);
    });

    it('覆盖自定义服务、组合服务非默认删除、空模型思考开关与 ChatGPT Plan 展示标志', () => {
        const ctx = setupActions();

        // createCustomProvider 支持无 apiKey 分支
        ctx.actions.createCustomProvider({
            name: 'Local OAI',
            endpoint: 'https://example.com/v1/chat/completions',
            apiKey: '',
            model: 'gpt-4o-mini',
        });
        const customId = ctx.configurationService.value!;
        expect(ctx.config.value.token[customId]).toBeUndefined();

        // 选中非自定义服务时 deleteSelectedCustomProvider 直接返回
        ctx.configurationService.value = services.google;
        ctx.actions.deleteSelectedCustomProvider();
        expect(ctx.config.value.customOpenAIProviders.some(p => p.id === customId)).toBe(true);

        // 删除非默认、非文档、非视频且非 legacy ID 的自定义服务（覆盖所有 false 分支）
        ctx.config.value.service = services.google;
        ctx.config.value.documentService = services.microsoft;
        ctx.config.value.videoService = services.openai;
        ctx.configurationService.value = customId;
        ctx.actions.deleteSelectedCustomProvider();
        expect(ctx.config.value.customOpenAIProviders.some(p => p.id === customId)).toBe(false);
        expect(ctx.config.value.service).toBe(services.google);
        expect(ctx.config.value.documentService).toBe(services.microsoft);
        expect(ctx.config.value.videoService).toBe(services.openai);

        // 也验证删除 legacy custom provider 时重置 custom 字段
        ctx.config.value.customOpenAIProviders = [{
            id: LEGACY_CUSTOM_OPENAI_PROVIDER_ID,
            name: 'Legacy',
            endpoint: 'https://legacy.example/v1/chat/completions',
            models: ['m1'],
        }];
        ctx.configurationService.value = LEGACY_CUSTOM_OPENAI_PROVIDER_ID;
        ctx.actions.deleteSelectedCustomProvider();
        expect(ctx.config.value.customOpenAIProviders).toHaveLength(0);

        // 组合服务：创建后保留默认服务为 google，再删除该非默认组合服务
        ctx.actions.createCompositeProvider({
            name: 'Combo',
            members: [services.google, services.microsoft],
            strategy: 'fallback',
        } as never);
        const comboId = ctx.configurationService.value!;
        ctx.config.value.service = services.google;
        ctx.actions.deleteSelectedCompositeProvider(comboId);
        expect(ctx.config.value.service).toBe(services.google);

        // 当前模型为空时 updateSelectedConfigurationModelThinking 直接返回
        ctx.configurationService.value = services.google;
        ctx.actions.updateSelectedConfigurationModelThinking(true);

        // ChatGPT Plan 选项触发 showAI 第二操作数
        ctx.configurationService.value = services.chatgptPlan;
        expect(typeof ctx.actions.configurationCompute.value.showAI).toBe('boolean');
    });
});
