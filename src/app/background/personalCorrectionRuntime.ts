/**
 * @file src/app/background/personalCorrectionRuntime.ts
 * 文件职责：将个人校订接入唯一后台消息路由和现有加密存储。
 * 主要内容：验证扩展发送者与材料身份、阻止隐私窗口保存，显式开启后才复用或保存，处理 CRUD/项目动作，并通过共享网页接收者端口发送无正文失效广播。
 * 模块边界：只装配独立服务和消息端口，不重写翻译调度、不读取 DOM、不污染公共 provider 缓存。
 */
import browser from 'webextension-polyfill';
import {configStorage} from '@/src/platform/storage/configStorageRuntime';
import {config} from '@/src/services/config/store';
import {PersonalCorrectionRepository} from '@/src/platform/storage/personalCorrectionRepository';
import {PersonalCorrectionService} from '@/src/services/personal-corrections/service';
import {PERSONAL_CORRECTIONS_CHANGED, PERSONAL_CORRECTIONS_MESSAGE, type PersonalCorrectionMessage} from '@/src/services/personal-corrections/protocol';
import {createMaterialId, correctionMaterialId, PersonalCorrectionError, validateCorrectionInput, validateCorrectionQuery} from '@/src/core/personal-corrections/public';
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';
import type {TabBroadcastRuntime} from './tabBroadcast';
export interface PersonalCorrectionContext {sender?: {id?: string; url?: string; tab?: {id?: number; incognito?: boolean}}}
export interface PersonalCorrectionRuntimeDependencies {
    service: PersonalCorrectionService;
    extensionId: string;
    isExtensionUrl(url: string): boolean;
    privateContext(): boolean;
    enabled(): boolean;
    changed(): Promise<void>;
}
export function createPersonalCorrectionHandler<TContext extends PersonalCorrectionContext>(dependencies: PersonalCorrectionRuntimeDependencies): BackgroundMessageHandler<TContext, PersonalCorrectionMessage> {
    return {
        type: PERSONAL_CORRECTIONS_MESSAGE,
        async handle(message, context) {
            try {
                if (message.type !== PERSONAL_CORRECTIONS_MESSAGE) throw new PersonalCorrectionError('个人校订消息无效');
                const sender = context.sender;
                if (!sender || sender.id !== dependencies.extensionId || typeof sender.url !== 'string' || sender.tab?.incognito || dependencies.privateContext()) throw new PersonalCorrectionError('当前上下文无法访问个人校订');
                const extensionPage = dependencies.isExtensionUrl(sender.url);
                if (!extensionPage && (!Number.isInteger(sender.tab?.id) || (sender.tab!.id as number) < 0)) throw new PersonalCorrectionError('个人校订发送者无效');
                const materialId = extensionPage ? null : createMaterialId(sender.url);
                const assertMaterial = (value: unknown) => {
                    const id = correctionMaterialId(value);
                    if (materialId && materialId !== id) throw new PersonalCorrectionError('校订材料与当前页面不一致');
                    return id;
                };
                let data: unknown;
                let changed = false;
                switch (message.action) {
                    case 'lookup': {
                        const query = validateCorrectionQuery(message.query); assertMaterial(query.materialId);
                        data = {suggestions: [], conflicts: []};
                        if (dependencies.enabled()) {
                            const match = await dependencies.service.lookup(query);
                            if (dependencies.enabled()) data = match;
                        }
                        break;
                    }
                    case 'list': data = await dependencies.service.list(); break;
                    case 'save': {
                        const input = validateCorrectionInput(message.input);
                        const assertEnabled = () => {if (!dependencies.enabled()) throw new PersonalCorrectionError('个人校订已关闭，请先在设置中开启');};
                        assertEnabled();
                        if (input.scope.kind === 'material') assertMaterial(input.scope.id);
                        else if (materialId) {
                            const {memberships} = await dependencies.service.list();
                            assertEnabled();
                            if (!memberships.some(entry => entry.materialId === materialId && entry.projectId === input.scope.id)) throw new PersonalCorrectionError('请先明确选择当前材料的校订项目');
                        }
                        data = await dependencies.service.save(input); changed = true; break;
                    }
                    case 'remove': data = await dependencies.service.remove(message.id as string, message.expectedRevision as number); changed = true; break;
                    case 'undo': data = await dependencies.service.undo(message.token as string); changed = true; break;
                    case 'createProject': data = await dependencies.service.createProject(message.label as string); changed = true; break;
                    case 'selectProject': data = await dependencies.service.selectProject(assertMaterial(message.materialId), message.projectId as string | null); changed = true; break;
                    default: throw new PersonalCorrectionError('个人校订操作无效');
                }
                if (changed) void dependencies.changed().catch(() => undefined);
                return {success: true, data};
            } catch (error) {
                return {success: false, error: error instanceof PersonalCorrectionError ? error.message : '个人校订操作未完成，请稍后重试'};
            }
        },
    };
}
export function createPersonalCorrectionRuntimeHandlers<TContext extends PersonalCorrectionContext>(
    tabBroadcast: Pick<TabBroadcastRuntime, 'broadcastTabMessage'>,
): Array<BackgroundMessageHandler<TContext>> {
    const service = new PersonalCorrectionService(new PersonalCorrectionRepository(configStorage));
    return [createPersonalCorrectionHandler<TContext>({service, extensionId: browser.runtime.id,
        isExtensionUrl: url => url.startsWith(browser.runtime.getURL('/')),
        privateContext: () => Boolean(browser.extension.inIncognitoContext),
        enabled: () => config.on && config.personalCorrectionsEnabled === true,
        changed: async () => {
            const message = {type: PERSONAL_CORRECTIONS_CHANGED};
            await tabBroadcast.broadcastTabMessage(message);
            await browser.runtime.sendMessage(message).catch(() => undefined);
        },
    })];
}
