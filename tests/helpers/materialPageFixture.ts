import type {MaterialRecord} from '@/src/features/vocabulary/materialProtocol';
import {matchesNormalizedMaterialSearch, normalizeMaterialSearch, summarizeMaterial} from '@/src/features/vocabulary/materialSummary';

export class FixturePageError extends Error {
  constructor(readonly code: string, message: string) {super(message);}
}
async function wait<T>(promise: Promise<T>, options?: {signal?: AbortSignal; idleTimeoutMs?: number}): Promise<T> {
  if (options?.signal?.aborted) throw new DOMException('材料读取已取消。', 'AbortError');
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('材料读取超时，请重试。')), options?.idleTimeoutMs ?? 30_000);
    const abort = () => finish(new DOMException('材料读取已取消。', 'AbortError'));
    function finish(error?: Error, value?: T) {clearTimeout(timer); options?.signal?.removeEventListener('abort', abort); if (error) reject(error); else resolve(value as T);}
    options?.signal?.addEventListener('abort', abort, {once: true});
    promise.then(value => finish(undefined, value), error => finish(error));
  });
}
/** 模拟分页接口，保留每次打开时的材料快照供生命周期测试控制。 */
export function materialPageFixture(api: {materialList: (...args: any[]) => Promise<MaterialRecord[]>}) {
  let serial = 0;
  const sessions = new Map<string, {all: MaterialRecord[]; matched: MaterialRecord[]}>();
  const slice = <T,>(items: T[], offset: number, size: number) => ({items: items.slice(offset, offset + size), nextOffset: offset + size < items.length ? offset + size : null});
  return {
    async page(request: any, options?: {signal?: AbortSignal; idleTimeoutMs?: number}) {
      if (request.operation === 'close') {sessions.delete(request.capability); return;}
      let session;
      let capability;
      if (request.operation === 'open') {
        const all = await wait(api.materialList({archived: request.options.archived}), options);
        const search = normalizeMaterialSearch(request.options.search || '');
        const matched = all.filter(item => (!request.options.topic || item.topics.includes(request.options.topic)) && matchesNormalizedMaterialSearch(item, search));
        capability = String(++serial).padStart(64, '0'); session = {all, matched}; sessions.set(capability, session);
      } else session = sessions.get(request.capability);
      if (!session) throw Error('Session closed');
      const offset = request.offset || 0, result = slice(session.matched, offset, 30);
      return {capability, revision: 1, total: session.all.length, matched: session.matched.length, offset, nextOffset: result.nextOffset, items: result.items.map(summarizeMaterial)};
    },
    async detail(request: any) {
      const item = sessions.get(request.capability)?.all.find(value => value.id === request.id);
      if (!item) throw new FixturePageError('not-found', '这份材料已不存在。');
      const {identityKey: _identityKey, aliases: _aliases, references, ...metadata} = item;
      const result = slice(references, request.offset, 24);
      return {revision: 1, metadata, total: references.length, offset: request.offset, nextOffset: result.nextOffset, references: result.items};
    },
    async topics(request: any) {
      const all = sessions.get(request.capability)?.all || [];
      const topics = [...new Set(all.flatMap(item => item.topics))].sort((a,b) => a.localeCompare(b));
      const matched = topics.filter(topic => topic.toLocaleLowerCase().includes((request.search || '').trim().toLocaleLowerCase()));
      const result = slice(matched, request.offset, 100);
      return {revision: 1, total: topics.length, matched: matched.length, offset: request.offset, nextOffset: result.nextOffset, topics: result.items};
    },
  };
}
