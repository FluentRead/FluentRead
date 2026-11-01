/**
 * @file src/features/vocabulary/materialRepository.ts
 * 文件职责：持久化独立于可同步配置的本地材料与学习位置，提供原子写入和可撤销归档。
 * 主要内容：Dexie 唯一来源索引、按引用及来源兼容键去重的旧收藏惰性投影、清空世代与迟到位置保护；批量写入在同一事务内复用容量计数，词书隐私地址仅作兼容比较，不改写材料规范身份。
 * 模块边界：不访问网页与浏览器消息；旧收藏只读不改写，材料正文、URL 与笔记不会进入配置同步。
 */
import Dexie, {type Table} from 'dexie';
import type {VocabularyEntry} from './learningModel';
import type {MaterialOperationGuard, MaterialBackup, MaterialImportResult, MaterialCaptureInput, MaterialListOptions, MaterialPatch, MaterialRecord, MaterialReference} from './materialProtocol';
import {MaterialError, canonicalMaterialUrl, materialText, normalizeMaterialLocator, normalizeMaterialReference, normalizeMaterialSource, normalizeMaterialTopics} from './materialModel';
interface MaterialMeta {key: string; generation: number; migrated: boolean; clearedAt: number}
export class MaterialDatabase extends Dexie {
    materials!: Table<MaterialRecord, string>;
    meta!: Table<MaterialMeta, string>;
    constructor(name = 'FluentReadMaterials') {
        super(name);
        this.version(1).stores({materials: 'id,&identityKey,*aliases,updatedAt', meta: 'key'});
    }
}
const initialMeta = (): MaterialMeta => ({key: 'state', generation: 0, migrated: false, clearedAt: 0});
/** 仅用于比对旧词书隐私地址，不回写材料身份；视频必须使用其完整规范身份。 */
function privateArticleSource(url: string): string | undefined {
    const canonical = canonicalMaterialUrl(url);
    if (!canonical) return;
    const source = new URL(canonical); source.search = ''; source.hash = '';
    return source.href;
}
export class MaterialRepository {
    constructor(readonly db = new MaterialDatabase(), private readonly legacyEntries?: () => Promise<VocabularyEntry[]>) {}
    private async findIdentity(key: string): Promise<MaterialRecord | undefined> {
        return await this.db.materials.where('identityKey').equals(key).first() ?? await this.db.materials.where('aliases').equals(key).first();
    }
    async generation(): Promise<number> {return (await this.db.meta.get('state'))?.generation ?? 0;}
    async get(id: string): Promise<MaterialRecord | null> {return await this.db.materials.get(this.id(id)) ?? null;}
    private id(id: unknown): string {
        if (typeof id !== 'string' || !id || id.length > 256) throw new MaterialError('invalid-input', '材料标识无效');
        return id;
    }
    private async migrate(): Promise<void> {
        if (!this.legacyEntries || (await this.db.meta.get('state'))?.migrated) return;
        const startGeneration = await this.generation();
        const entries = await this.legacyEntries();
        await this.db.transaction('rw', this.db.materials, this.db.meta, async () => {
            const meta = await this.db.meta.get('state') ?? initialMeta();
            if (meta.migrated || meta.generation !== startGeneration) return;
            // 首次打开材料前可能已经显式收藏。一次索引现有引用的来源，避免把这次
            // 新收藏当旧词书再次导入；同词条的其他明确来源仍正常迁移。
            const linkedSources = new Map<string, Set<string>>();
            let cursorFailed = false, cursorError: unknown;
            const readMaterial = this.db.materials.hook.reading.fire;
            await this.db.materials.toCollection().raw().until(() => cursorFailed).each(rawMaterial => {
                try {
                    const material = readMaterial(rawMaterial) as MaterialRecord;
                    const sources = [material.identityKey, ...(material.aliases ?? [])];
                    if (material.kind === 'document' && material.source.url) {
                        const url = canonicalMaterialUrl(material.source.url);
                        if (url) sources.push(`article:${url}`);
                    }
                    for (const key of [...sources]) if (key.startsWith('article:')) {
                        const url = privateArticleSource(key.slice('article:'.length));
                        if (url) sources.push(`legacy-article:${url}`);
                    }
                    for (const reference of material.references) if (reference.kind === 'vocabulary') {
                        const keys = linkedSources.get(reference.id) ?? new Set<string>();
                        for (const key of sources) keys.add(key);
                        linkedSources.set(reference.id, keys);
                    }
                } catch (error) {cursorFailed = true; cursorError = error;}
            });
            // Dexie 的游标回调会吞掉同步异常；在捕获范围内运行原读取钩子，
            // 停止游标后在事务内重新抛出，保持原有失败回滚语义。
            if (cursorFailed) throw cursorError;
            // 读写事务隔离其他写入；仅首次新增读取容量，后续成功新增在本事务内递增。
            let materialCount: number | undefined;
            for (const entry of entries) for (const context of entry.contexts) {
                if (!context.sourceUrl) continue;
                try {
                    const normalized = normalizeMaterialSource({kind: context.video ? 'video' : 'article', url: context.sourceUrl, title: context.pageTitle});
                    const linked = linkedSources.get(entry.id);
                    const privateUrl = normalized.source.kind === 'article' ? privateArticleSource(normalized.source.url!) : undefined;
                    if (linked?.has(normalized.identityKey) || (privateUrl === normalized.source.url && linked?.has(`legacy-article:${privateUrl}`))) continue;
                    const previous = await this.findIdentity(normalized.identityKey);
                    // 已归档和显式采集的材料仍可关联旧词条，但不覆盖其阅读位置与标题。
                    const reference = normalizeMaterialReference({kind: 'vocabulary', id: entry.id, excerpt: context.text, createdAt: context.capturedAt}, Date.now());
                    const record: MaterialRecord = previous ?? {
                        id: crypto.randomUUID(), identityKey: normalized.identityKey, kind: normalized.source.kind,
                        source: normalized.source, title: normalized.source.title || new URL(normalized.source.url!).hostname,
                        topics: [], references: [], createdAt: context.capturedAt, updatedAt: context.capturedAt,
                        lastReadAt: context.capturedAt, archivedAt: null,
                        locator: context.video ? {kind: 'video', startMs: context.video.startMs, endMs: context.video.endMs, quote: context.text} : {kind: 'text', quote: context.text},
                    };
                    if (!record.references.some(ref => ref.kind === reference.kind && ref.id === reference.id) && record.references.length < 1000) record.references.push(reference);
                    if (!previous) {
                        materialCount ??= await this.db.materials.count();
                        if (materialCount >= 10000) continue;
                    }
                    await this.db.materials.put(record);
                    if (!previous) materialCount!++;
                } catch (error) {
                    if (!(error instanceof MaterialError)) throw error;
                }
            }
            await this.db.meta.put({...meta, migrated: true});
        });
    }
    async list(options: MaterialListOptions = {}): Promise<MaterialRecord[]> {
        if (!options || typeof options !== 'object' || Array.isArray(options)) throw new MaterialError('invalid-input', '材料筛选无效');
        await this.migrate();
        const query = materialText(options.search, 240).toLocaleLowerCase();
        const topic = materialText(options.topic, 80);
        return (await this.db.materials.toArray()).filter(record => Boolean(record.archivedAt !== null) === (options.archived === true)
            && (!topic || record.topics.includes(topic))
            && (!query || `${record.title} ${record.source.url ?? ''} ${record.topics.join(' ')} ${record.references.map(ref => `${ref.excerpt ?? ''} ${ref.note ?? ''}`).join(' ')}`.toLocaleLowerCase().includes(query)))
            .sort((a, b) => b.lastReadAt - a.lastReadAt || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    }
    async capture(input: MaterialCaptureInput, now = Date.now()): Promise<MaterialRecord> {
        if (!input || typeof input !== 'object') throw new MaterialError('invalid-input', '材料采集内容无效');
        if (input.referenceMode !== undefined && (input.referenceMode !== 'update-existing' || input.reference === undefined)) throw new MaterialError('invalid-input', '材料引用更新模式无效');
        const normalized = normalizeMaterialSource(input.source);
        const locator = normalizeMaterialLocator(input.locator, normalized.source);
        const reference = input.reference === undefined ? undefined : normalizeMaterialReference(input.reference, now);
        const capturedAt = input.capturedAt === undefined ? now : input.capturedAt;
        if (!Number.isFinite(capturedAt) || capturedAt < 0 || capturedAt > now + 60_000) throw new MaterialError('invalid-input', '材料采集时间无效');
        if (input.generation !== undefined && (!Number.isSafeInteger(input.generation) || input.generation < 0)) throw new MaterialError('invalid-input', '材料操作世代无效');
        return this.db.transaction('rw', this.db.materials, this.db.meta, async () => {
            const meta = await this.db.meta.get('state') ?? initialMeta();
            if ((input.generation !== undefined && input.generation !== meta.generation) || capturedAt <= meta.clearedAt) throw new MaterialError('stale-operation', '学习材料已清空，请重新采集');
            const previous = await this.findIdentity(normalized.identityKey);
            if (!previous && input.positionOnly) throw new MaterialError('not-found', '尚未收藏这份材料');
            if (!previous && await this.db.materials.count() >= 10000) throw new MaterialError('limit-exceeded', '材料数量已达上限');
            const record: MaterialRecord = previous ?? {
                id: crypto.randomUUID(), identityKey: normalized.identityKey, kind: normalized.source.kind,
                source: normalized.source, title: normalized.source.title || (normalized.source.url ? new URL(normalized.source.url).hostname : '本地文档'),
                topics: [], references: [], createdAt: now, updatedAt: now, lastReadAt: capturedAt, archivedAt: null,
            };
            if (input.positionOnly && (record.archivedAt !== null || capturedAt < record.lastReadAt)) return record;
            if (reference) {
                const index = record.references.findIndex(ref => ref.kind === reference.kind && ref.id === reference.id);
                if (input.referenceMode === 'update-existing' && index < 0) throw new MaterialError('stale-operation', '这条笔记已在其他位置删除，请另存为新笔记');
                if (reference.kind === 'note') {
                    const existing = record.references[index];
                    if (existing && capturedAt < (existing.updatedAt ?? existing.createdAt ?? 0)) throw new MaterialError('stale-operation', '这条笔记已有更新的编辑，请刷新后再修改');
                    reference.updatedAt = capturedAt;
                }
                if (index < 0) {
                    if (record.references.length >= 1000) throw new MaterialError('limit-exceeded', '这份材料的学习记录已达上限');
                    record.references.push(reference);
                } else record.references[index] = {...reference, createdAt: record.references[index].createdAt};
            }
            const preserveExactDocumentPosition = input.positionOnly && record.locator?.documentReference && !locator?.documentReference;
            if (locator && capturedAt >= record.lastReadAt && !preserveExactDocumentPosition) record.locator = locator;
            record.lastReadAt = Math.max(record.lastReadAt, capturedAt);
            record.updatedAt = now;
            // 显式收藏可以恢复来源；归档状态由专门的恢复操作控制，自动采集不复活用户删除。
            if (normalized.source.url && normalized.identityKey === record.identityKey) record.source.url = normalized.source.url;
            await this.db.materials.put(record);
            return record;
        });
    }
    async update(id: string, patch: MaterialPatch, now = Date.now()): Promise<MaterialRecord> {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new MaterialError('invalid-input', '材料更新无效');
        return this.mutate(id, async record => {
            if (patch.title !== undefined) {
                const title = materialText(patch.title, 240); if (!title) throw new MaterialError('invalid-input', '材料标题不能为空'); record.title = title;
            }
            if (patch.topics !== undefined) record.topics = normalizeMaterialTopics(patch.topics);
            if (patch.source !== undefined) {
                const normalized = normalizeMaterialSource(patch.source);
                if (normalized.source.kind !== record.kind || (record.kind === 'document' && normalized.source.fingerprint !== record.source.fingerprint)) throw new MaterialError('invalid-input', '材料类型不可更换；本地文档需要选择指纹相同的原文件');
                const conflict = await this.findIdentity(normalized.identityKey);
                if (conflict && conflict.id !== record.id) throw new MaterialError('invalid-input', '这个来源已属于另一份材料，请先查看现有材料');
                if (normalized.identityKey !== record.identityKey) {
                    if ((record.aliases?.length ?? 0) >= 100) throw new MaterialError('limit-exceeded', '来源恢复次数已达上限');
                    record.aliases = [...new Set([...(record.aliases ?? []), record.identityKey])].filter(key => key !== normalized.identityKey);
                    record.identityKey = normalized.identityKey;
                }
                record.source = normalized.source;
            }
            if (patch.locator !== undefined) {record.locator = normalizeMaterialLocator(patch.locator, record.source); record.lastReadAt = now;}
        }, now);
    }
    async removeReference(id: string, kind: MaterialReference['kind'], referenceId: string): Promise<MaterialRecord> {
        this.id(referenceId);
        if (!['vocabulary', 'session', 'memory', 'note'].includes(kind)) throw new MaterialError('invalid-input', '学习引用类型无效');
        return this.mutate(id, record => {record.references = record.references.filter(ref => ref.kind !== kind || ref.id !== referenceId);});
    }
    async archive(id: string): Promise<MaterialRecord> {return this.mutate(id, record => {record.archivedAt = Date.now();});}
    async restore(id: string): Promise<MaterialRecord> {return this.mutate(id, record => {record.archivedAt = null;});}
    private async mutate(id: string, apply: (record: MaterialRecord) => void | Promise<void>, now = Date.now()): Promise<MaterialRecord> {
        this.id(id);
        return this.db.transaction('rw', this.db.materials, async () => {
            const record = await this.db.materials.get(id); if (!record) throw new MaterialError('not-found', '这份材料已不存在');
            await apply(record); record.updatedAt = now; await this.db.materials.put(record); return record;
        });
    }
    /** 仅显式用户操作生成完整私密备份；不接入配置同步或旧词书导出。 */
    async exportData(now = Date.now()): Promise<MaterialBackup> {
        await this.migrate();
        return {format: 'fluentread-learning-materials', version: 1, exportedAt: now, materials: await this.db.materials.toArray()};
    }
    async importData(input: unknown, now = Date.now(), guard?: MaterialOperationGuard): Promise<MaterialImportResult> {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MaterialError('invalid-input', '材料备份无效');
        const value = input as Partial<MaterialBackup>;
        if (value.format !== 'fluentread-learning-materials' || value.version !== 1 || !Array.isArray(value.materials) || value.materials.length > 10000) throw new MaterialError('invalid-input', '不支持的材料备份格式或超过材料上限');
        if (guard !== undefined && (!guard || !Number.isSafeInteger(guard.generation) || guard.generation < 0 || !Number.isFinite(guard.capturedAt) || guard.capturedAt < 0 || guard.capturedAt > now + 60_000)) throw new MaterialError('invalid-input', '材料导入操作无效');
        const generation = guard?.generation ?? await this.generation();
        const result: MaterialImportResult = {inserted: 0, updated: 0, skipped: 0};
        return this.db.transaction('rw', this.db.materials, this.db.meta, async () => {
            const meta = await this.db.meta.get('state') ?? initialMeta();
            if (meta.generation !== generation || (guard !== undefined && guard.capturedAt <= meta.clearedAt)) throw new MaterialError('stale-operation', '导入期间材料已清空，请重新选择备份');
            // 容量只在这个原子导入内缓存，不能跨事务复用，亦不为已有记录更新计数。
            let materialCount: number | undefined;
            for (const item of value.materials!) {
                let record: MaterialRecord & {aliases: string[]};
                try {record = normalizeImportedMaterial(item, now);} catch (error) {
                    if (!(error instanceof MaterialError)) throw error;
                    result.skipped++; continue;
                }
                const previous = await this.findIdentity(record.identityKey);
                let conflict = false;
                for (const alias of record.aliases) {
                    const owner = await this.findIdentity(alias);
                    if (owner && owner.id !== previous?.id) {conflict = true; break;}
                }
                if (conflict || (previous && previous.updatedAt >= record.updatedAt)) {result.skipped++; continue;}
                if (previous) {
                    // 选择更新的整份快照，避免旧备份复活用户刚删掉的笔记或归档状态。
                    record.id = previous.id;
                    record.aliases = [...new Set([...(previous.aliases ?? []), previous.identityKey, ...record.aliases])].filter(key => key !== record.identityKey).slice(-100);
                    record.createdAt = Math.min(previous.createdAt, record.createdAt);
                    result.updated++;
                } else {
                    materialCount ??= await this.db.materials.count();
                    if (materialCount >= 10000) {result.skipped++; continue;}
                    if (await this.db.materials.get(record.id)) record.id = crypto.randomUUID();
                    result.inserted++;
                }
                await this.db.materials.put(record);
                if (!previous) materialCount!++;
            }
            return result;
        });
    }
    async clear(now = Date.now()): Promise<void> {
        await this.db.transaction('rw', this.db.materials, this.db.meta, async () => {
            const meta = await this.db.meta.get('state') ?? initialMeta();
            await this.db.materials.clear();
            await this.db.meta.put({key: 'state', generation: meta.generation + 1, migrated: true, clearedAt: now});
        });
    }
}

/** 导入重建派生身份，并逐字段白名单恢复，拒绝备份伪造跨材料别名。 */
function normalizeImportedMaterial(value: MaterialRecord, now: number): MaterialRecord & {aliases: string[]} {
    if (!value || typeof value !== 'object' || !Array.isArray(value.references) || value.references.length > 1000) throw new MaterialError('invalid-input', '材料记录无效');
    const normalized = normalizeMaterialSource(value.source);
    const timestamp = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, now) : now;
    const aliases: string[] = [];
    // 仅保留与已验证来源主机名一致的自动标题，避免无关长字符串绕过标题限制。
    const longTitle = typeof value.title === 'string' && value.title.length > 240;
    let matchesSourceHost = longTitle && normalized.source.url !== undefined && new URL(normalized.source.url).hostname === value.title;
    if (value.aliases !== undefined) {
        if (!Array.isArray(value.aliases) || value.aliases.length > 100) throw new MaterialError('invalid-input', '材料来源历史无效');
        for (const alias of value.aliases) {
            if (typeof alias !== 'string' || !alias.startsWith(`${normalized.source.kind}:`)) throw new MaterialError('invalid-input', '材料来源历史无效');
            const body = alias.slice(normalized.source.kind.length + 1);
            let source = {kind: normalized.source.kind, url: body};
            if (normalized.source.kind === 'video' && /^youtube:[\w-]{11}$/u.test(body)) source = {kind: 'video', url: `https://www.youtube.com/watch?v=${body.slice(8)}`};
            else if (normalized.source.kind === 'video' && /^x:\d+(?:\/video\/[1-9]\d*)?$/u.test(body)) source = {kind: 'video', url: `https://x.com/i/status/${body.slice(2)}`};
            const safe = normalizeMaterialSource(source);
            if (safe.identityKey !== alias) throw new MaterialError('invalid-input', '材料来源历史身份不匹配');
            aliases.push(alias);
            if (longTitle && safe.source.url !== undefined && new URL(safe.source.url).hostname === value.title) matchesSourceHost = true;
        }
    }
    const title = matchesSourceHost ? value.title : materialText(value.title, 240);
    if (!title) throw new MaterialError('invalid-input', '材料标题无效');
    const references = value.references.map(ref => normalizeMaterialReference(ref, now));
    if (new Set(references.map(ref => `${ref.kind}:${ref.id}`)).size !== references.length) throw new MaterialError('invalid-input', '学习引用重复');
    return {id: materialText(value.id, 256) || crypto.randomUUID(), identityKey: normalized.identityKey, aliases: [...new Set(aliases)], kind: normalized.source.kind, source: normalized.source,
        title, topics: normalizeMaterialTopics(value.topics), references, locator: normalizeMaterialLocator(value.locator, normalized.source),
        createdAt: timestamp(value.createdAt), updatedAt: timestamp(value.updatedAt), lastReadAt: timestamp(value.lastReadAt), archivedAt: value.archivedAt === null ? null : timestamp(value.archivedAt)};
}
