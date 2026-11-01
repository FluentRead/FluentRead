/**
 * @file src/features/vocabulary/materialSummaryValidation.ts
 * 文件职责：校验跨扩展消息传递的材料列表摘要。
 * 主要内容：核对显示字段、主题、时间与引用数量的类型和预算，不修改或截断已保存内容。
 * 模块边界：不读取数据库或安装消息监听，不判断摘要所属的会话与版本；完整性由分页客户端负责。
 */
import type {MaterialSummary} from './materialSummary';

const MAX_URL_LENGTH = 8192 * 16 + 16;
function invalid(): never {throw Error('Invalid material summary');}
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    const record = value as Record<string, unknown>, keys = Object.keys(record);
    if (required.some(key => !Object.hasOwn(record, key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) return invalid();
    return record;
}
function boundedString(value: unknown, max: number, empty = false): value is string {
    return typeof value === 'string' && value.length <= max && (empty || value.length > 0);
}
function count(value: unknown, max: number): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
function time(value: unknown): value is number {return typeof value === 'number' && Number.isFinite(value) && value >= 0;}
export function parseMaterialSummary(value: unknown): MaterialSummary {
    const item = object(value, ['id','kind','title','topics','lastReadAt','updatedAt','archivedAt','preview','referenceCount'], ['sourceUrl']);
    if (!boundedString(item.id,256) || !['article','document','video'].includes(item.kind as string)
        // 未指定标题的采集可使用超出 240 字的规范 URL 主机名。
        || !boundedString(item.title,MAX_URL_LENGTH) || (item.sourceUrl !== undefined && !boundedString(item.sourceUrl,MAX_URL_LENGTH,true))
        || !Array.isArray(item.topics) || item.topics.length > 30
        || !time(item.lastReadAt) || !time(item.updatedAt) || (item.archivedAt !== null && !time(item.archivedAt))
        || !boundedString(item.preview,12000,true) || !count(item.referenceCount,1000)) return invalid();
    const topicSet = new Set<string>();
    for (const topic of item.topics) {
        if (!boundedString(topic,80,true) || topicSet.has(topic)) return invalid();
        topicSet.add(topic);
    }
    return item as unknown as MaterialSummary;
}
