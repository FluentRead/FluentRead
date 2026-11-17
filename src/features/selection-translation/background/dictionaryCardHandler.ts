/**
 * @file src/features/selection-translation/background/dictionaryCardHandler.ts
 * 文件职责：连接划词卡片的主动 Anki 导出与统一后台路由。
 * 主要内容：验证双面纯文本卡片，拒绝超限内容，使用后台权威配置调用本地导出端口。
 * 模块边界：不让入站消息指定服务地址、请求头或 Anki 模型，不查询词典或改写词书。
 */
import type {DictionaryWorkspace} from '@/src/core/config/dictionaryWorkspace';
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';
export function createDictionaryCardHandler<T>(dependencies: {ready: Promise<unknown>; settings(): DictionaryWorkspace['anki']; send(card: {front: string; back: string}, settings: DictionaryWorkspace['anki']): Promise<number>}): BackgroundMessageHandler<T> {
    return {type: 'fluentReadDictionaryAnki', async handle(input) {
        const message = input as {front?: unknown; back?: unknown};
        if (typeof message.front !== 'string' || typeof message.back !== 'string' || !message.front.trim() || !message.back.trim()
            || message.front.length > 65536 || message.back.length > 65536) throw new Error('Invalid dictionary card');
        await dependencies.ready;
        const id = await dependencies.send({front: message.front, back: message.back}, dependencies.settings());
        return {success: true, data: id};
    }};
}
