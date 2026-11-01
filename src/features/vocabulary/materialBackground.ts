/**
 * @file src/features/vocabulary/materialBackground.ts
 * 文件职责：在后台信任边界处理本地材料消息，并限制网页只能解析自身来源。
 * 主要内容：扩展页管理权限、设置页轻量写入回执、无痕拒绝、采集开关、类型错误映射和不含私密正文的变更通知。
 * 模块边界：通过仓库依赖操作本地 IndexedDB；不抓取来源，不向日志或同步配置写入正文与地址。
 */
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';
import {MATERIAL_MESSAGE, type MaterialReference, type MaterialRequest, type MaterialResponse} from './materialProtocol';
import {MaterialError, normalizeMaterialSource} from './materialModel';
import {sanitizeVocabularyVideoUrl} from './source';
import type {MaterialSource} from './materialProtocol';
import type {MaterialRepository} from './materialRepository';
export interface MaterialBackgroundContext {sender?: {id?: string; url?: string; frameId?: number; incognito?: boolean; tab?: {id?: number; url?: string; incognito?: boolean}}}
export interface MaterialBackgroundDependencies {
    repository: MaterialRepository; ready: Promise<unknown>; isPrivateContext(): boolean;
    isExtensionUrl(url: string): boolean;
    /** 仅准确的扩展设置页面可获取轻量写入回执；缺省时拒绝。 */
    isTrustedWorkspace?(sender: MaterialBackgroundContext['sender']): boolean;
    canCapture(kind?: MaterialReference['kind'], sourceUrl?: string): boolean;
    changed(): void;
}
const WORKSPACE_WRITE_ACTIONS = new Set<MaterialRequest['action']>(['workspaceCapture', 'workspaceUpdate', 'workspaceRemoveReference', 'workspaceArchive', 'workspaceRestore']);
/** X 时间线允许选中当前帖文的视频；其他网站不能借此读取 X 的个人材料。 */
function isXVideoSender(source: MaterialSource, senderUrl: string): boolean {
    if (source.kind !== 'video' || !sanitizeVocabularyVideoUrl(source.url, 'x')) return false;
    try {
        const sender = new URL(senderUrl);
        return ['http:', 'https:'].includes(sender.protocol) && !sender.username && !sender.password && !sender.port
            && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(sender.hostname);
    } catch {return false;}
}
export function createMaterialBackgroundHandler(deps: MaterialBackgroundDependencies): BackgroundMessageHandler<MaterialBackgroundContext, MaterialRequest, MaterialResponse> {
    const changed = () => {try {deps.changed();} catch {/* 变更通知不能回滚已提交的数据。 */}};
    return {type: MATERIAL_MESSAGE, async handle(message, context) {
        try {
            await deps.ready;
            const sender = context.sender;
            if (deps.isPrivateContext() || sender?.incognito === true || sender?.tab?.incognito === true) throw new MaterialError('privacy-disabled', '无痕窗口不读取或保存学习材料');
            const senderUrl = sender?.url ?? sender?.tab?.url ?? '';
            const extensionUi = deps.isExtensionUrl(senderUrl);
            const workspaceWrite = WORKSPACE_WRITE_ACTIONS.has(message.action);
            if (workspaceWrite && (!extensionUi || deps.isTrustedWorkspace?.(sender) !== true)) throw new MaterialError('privacy-disabled', '请从学习工作区管理材料');
            if (!extensionUi && !['capture', 'generation', 'resolve'].includes(message.action)) throw new MaterialError('privacy-disabled', '请从学习工作区管理材料');
            let data: unknown;
            switch (message.action) {
                case 'generation': data = await deps.repository.generation(); break;
                case 'list': data = await deps.repository.list(message.options); break;
                case 'get': data = await deps.repository.get(message.id); break;
                case 'resolve': {
                    const record = await deps.repository.get(message.id);
                    if (!record || record.archivedAt !== null) {data = null; break;}
                    if (!extensionUi && !isXVideoSender(record.source, senderUrl) && ![record.identityKey, ...(record.aliases ?? [])].includes(normalizeMaterialSource({...record.source, url: senderUrl, fingerprint: undefined}).identityKey)) throw new MaterialError('privacy-disabled', '这个位置属于另一份材料，请从学习工作区打开');
                    data = record; break;
                }
                case 'capture': case 'workspaceCapture': {
                    if (!deps.canCapture(message.input?.reference?.kind, extensionUi ? undefined : senderUrl)) throw new MaterialError('privacy-disabled', '请先开启对应的学习收藏或阅读功能');
                    if (!extensionUi) {
                        const source = normalizeMaterialSource(message.input?.source);
                        if (!isXVideoSender(source.source, senderUrl) && normalizeMaterialSource({...source.source, url: senderUrl, fingerprint: undefined}).identityKey !== source.identityKey) throw new MaterialError('privacy-disabled', '网页只能采集当前来源的学习材料');
                    }
                    const record = await deps.repository.capture(message.input);
                    data = message.action === 'workspaceCapture' ? {id: record.id} : record; changed(); break;
                }
                case 'update': data = await deps.repository.update(message.id, message.patch); changed(); break;
                case 'workspaceUpdate': {const record = await deps.repository.update(message.id, message.patch); data = {id: record.id}; changed(); break;}
                case 'removeReference': data = await deps.repository.removeReference(message.id, message.kind, message.referenceId); changed(); break;
                case 'workspaceRemoveReference': {const record = await deps.repository.removeReference(message.id, message.kind, message.referenceId); data = {id: record.id}; changed(); break;}
                case 'archive': data = await deps.repository.archive(message.id); changed(); break;
                case 'workspaceArchive': {const record = await deps.repository.archive(message.id); data = {id: record.id}; changed(); break;}
                case 'restore': data = await deps.repository.restore(message.id); changed(); break;
                case 'workspaceRestore': {const record = await deps.repository.restore(message.id); data = {id: record.id}; changed(); break;}
                case 'exportData': data = await deps.repository.exportData(); break;
                case 'importData': data = await deps.repository.importData(message.data, Date.now(), message.guard); changed(); break;
                case 'clear': await deps.repository.clear(); data = true; changed(); break;
                default: throw new MaterialError('invalid-input', '不支持的材料操作');
            }
            return {success: true, data};
        } catch (error) {
            return {success: false, error: {code: error instanceof MaterialError ? error.code : 'storage-error', message: error instanceof MaterialError ? error.message : '本地学习材料暂时不可用，请重试'}};
        }
    }};
}
