/**
 * @file src/features/vocabulary/materialPageClient.ts
 * 文件职责：为设置页提供完整性校验后的材料分页读取。
 * 主要内容：可信后台端口握手、进度、摘要逐行校验、有限缓存、取消和受限错误码。
 * 模块边界：不直接访问材料数据库；只有分帧摘要校验及结束标记均成功才交付结果。
 */
import browser from 'webextension-polyfill';
import {MATERIAL_PAGE_PORT_NAME, MATERIAL_PAGE_MAX_LINE_BYTES, type MaterialPageErrorCode, type MaterialPageRequest} from './materialPageProtocol';
import {parseMaterialSummary} from './materialSummaryValidation';
import {receiveMaterialRead, type MaterialReadPort} from './materialReadTransport';
import type {MaterialSummary} from './materialSummary';
import type {MaterialDetailMetadata, MaterialDetailPage} from './materialDetailPage';
import type {MaterialReference} from './materialProtocol';

export class MaterialPageClientError extends Error {
    constructor(readonly code: MaterialPageErrorCode, message:string) {super(message); this.name = 'MaterialPageClientError';}
}
export interface MaterialPageResult {
    capability?:string; revision:number; total:number; matched:number; offset:number; nextOffset:number|null; items:MaterialSummary[];
}
type Progress = {processed:number;total:number};
type Options = {signal?:AbortSignal; onProgress?:(progress:Progress)=>void; idleTimeoutMs?:number};
type Connect = () => MaterialReadPort;
const MAX_ROWS = 10_000, MAX_PAGE = 30;
const integer = (value:unknown, max = Number.MAX_SAFE_INTEGER):value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
function invalid():never {throw Error('材料分页数据无效，请重试。');}
function object(value:unknown, keys:string[], optional:string[] = []):Record<string,unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    const result = value as Record<string,unknown>;
    if (keys.some(key => !Object.hasOwn(result,key)) || Object.keys(result).some(key => !keys.includes(key) && !optional.includes(key))) return invalid();
    return result;
}
function publicError(code:MaterialPageErrorCode):MaterialPageClientError {
    const messages:Record<MaterialPageErrorCode,string> = {
        'stale-operation':'材料已发生变化，请重新读取。',
        'invalid-input':'材料筛选或分页无效。',
        'busy':'材料读取繁忙，请稍后重试。',
        'limit-exceeded':'材料内容或数量超出当前读取限制。',
        'storage-error':'本地材料暂时不可用，请重试。',
        'not-found':'这份材料已不存在。',
    };
    return new MaterialPageClientError(code,messages[code]);
}
function cancelled():DOMException {return new DOMException('材料读取已取消。','AbortError');}

/** 等待传输摘要和最终确认，再让调用方读取已暂存的结果。 */
async function receiveLines(request:MaterialPageRequest, options:Options, connect:Connect, accept:(line:string)=>void, isTerminal:()=>boolean):Promise<void> {
    if (options.signal?.aborted) throw cancelled();
    if (browser.extension?.inIncognitoContext === true) throw new MaterialPageClientError('storage-error','无痕窗口不读取学习材料。');
    const controller = new AbortController(), abort = () => controller.abort();
    options.signal?.addEventListener('abort',abort,{once:true});
    if (options.signal?.aborted) abort();
    let port:MaterialReadPort|undefined;
    let line = '', lineBytes = 0, decoder = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
    const onChunk = (chunk:Uint8Array) => {
        for (let start=0;start<chunk.length;) {
            if (isTerminal()) return invalid();
            const end=chunk.indexOf(10,start), stop=end<0?chunk.length:end;
            lineBytes+=stop-start;
            if (lineBytes>MATERIAL_PAGE_MAX_LINE_BYTES) throw Error('材料分页数据过大，请重试。');
            line+=decoder.decode(chunk.subarray(start,stop),{stream:true});
            if (end<0) break;
            line+=decoder.decode(); accept(line);
            if (controller.signal.aborted) throw cancelled();
            line=''; lineBytes=0;
            decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}); start=end+1;
        }
    };
    let receiving:Promise<void>|undefined, received = false;
    try {
        if (controller.signal.aborted) throw cancelled();
        port=connect();
        receiving=receiveMaterialRead(port,onChunk,{signal:controller.signal,idleTimeoutMs:options.idleTimeoutMs});
        void receiving.catch(()=>{});
        port.postMessage(request);
        await receiving;
        received = true;
        if (controller.signal.aborted) throw cancelled();
        if (lineBytes !== 0) return invalid();
    } catch (error) {
        if (!received) {
            controller.abort();
            try {port?.disconnect();} catch {/* 端口可能已关闭。 */}
        }
        if (receiving) await receiving.catch(()=>{});
        if (options.signal?.aborted) throw cancelled();
        throw error;
    } finally {options.signal?.removeEventListener('abort',abort);}
}

/** One request owns one dedicated port; no partially received page escapes. */
export async function requestMaterialPage(request:Extract<MaterialPageRequest,{operation:'open'|'page'|'close'}>, options:Options = {}, connect:Connect = () => browser.runtime.connect({name:MATERIAL_PAGE_PORT_NAME}) as unknown as MaterialReadPort):Promise<MaterialPageResult|undefined> {
    let phase:'initial'|'body'|'complete'|'error'|'closed' = 'initial';
    let page:MaterialPageResult|undefined, errorCode:MaterialPageErrorCode|undefined;
    let lastProgress = 0, progressTotal:number|undefined;
    const ids = new Set<string>();
    const accept = (text:string) => {
        let parsed:unknown;
        try {parsed=JSON.parse(text);} catch {return invalid();}
        const value=object(parsed,['type'],['version','operation','capability','revision','total','matched','offset','nextOffset','value','count','code','processed']);
        if (value.type === 'progress' && phase === 'initial' && request.operation === 'open') {
            object(parsed,['type','processed','total']);
            if (!integer(value.processed,MAX_ROWS) || !integer(value.total,MAX_ROWS) || value.processed < lastProgress || value.processed > value.total || (progressTotal !== undefined && progressTotal !== value.total)) return invalid();
            lastProgress=value.processed; progressTotal=value.total; options.onProgress?.({processed:value.processed,total:value.total}); return;
        }
        if (value.type === 'error' && (phase === 'initial' || phase === 'body')) {
            object(parsed,['type','code']);
            if (!['stale-operation','invalid-input','busy','limit-exceeded','storage-error','not-found'].includes(value.code as string)) return invalid();
            errorCode=value.code as MaterialPageErrorCode; page=undefined; ids.clear(); phase='error'; return;
        }
        if (phase === 'initial' && request.operation === 'close' && value.type === 'closed') {
            object(parsed,['type']); phase='closed'; return;
        }
        if (phase === 'initial' && request.operation !== 'close' && value.type === 'header') {
            object(parsed,['type','version','operation','revision','total','matched','offset','nextOffset'],['capability']);
            if (value.version !== 1 || value.operation !== request.operation || !integer(value.revision) || !integer(value.total,MAX_ROWS)
                || !integer(value.matched,MAX_ROWS) || value.matched > value.total || !integer(value.offset,MAX_ROWS) || value.offset > value.matched
                || (value.nextOffset !== null && (!integer(value.nextOffset,MAX_ROWS) || value.nextOffset <= value.offset || value.nextOffset > value.matched))
                || (request.operation === 'open' ? typeof value.capability !== 'string' || !/^[0-9a-f]{64}$/u.test(value.capability) || value.offset !== 0
                    : value.capability !== undefined || value.offset !== request.offset)) return invalid();
            page={...(request.operation === 'open' ? {capability:value.capability as string} : {}),revision:value.revision,total:value.total,matched:value.matched,offset:value.offset,nextOffset:value.nextOffset as number|null,items:[]};
            phase='body'; return;
        }
        if (phase === 'body' && page && value.type === 'summary') {
            object(parsed,['type','value']);
            if (page.items.length >= MAX_PAGE) return invalid();
            const item=parseMaterialSummary(value.value);
            if (ids.has(item.id)) return invalid();
            ids.add(item.id); page.items.push(item); return;
        }
        if (phase === 'body' && page && value.type === 'complete') {
            object(parsed,['type','count']);
            const end=page.offset+page.items.length;
            if (!integer(value.count,MAX_PAGE) || value.count !== page.items.length || end > page.matched
                || (page.nextOffset === null ? end !== page.matched : page.nextOffset !== end)) return invalid();
            phase='complete'; return;
        }
        return invalid();
    };
    await receiveLines(request, options, connect, accept, () => phase === 'complete' || phase === 'error' || phase === 'closed');
    if (errorCode) throw publicError(errorCode);
    const terminal = () => phase;
    if (request.operation === 'close' ? terminal() !== 'closed' : terminal() !== 'complete' || !page) return invalid();
    return page;
}

const pageErrors = ['stale-operation','invalid-input','busy','limit-exceeded','storage-error','not-found'] as const;
const metadataKeys = ['id','kind','title','source','locator','topics','createdAt','updatedAt','lastReadAt','archivedAt'] as const;
const stringWithin = (value:unknown, max:number, empty = false):value is string => typeof value === 'string' && value.length <= max && (empty || value.length > 0);
const timestamp = (value:unknown):value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function errorFromMessage(value:Record<string,unknown>, parsed:unknown):MaterialPageErrorCode {
    object(parsed,['type','code']);
    if (!pageErrors.includes(value.code as MaterialPageErrorCode)) return invalid();
    return value.code as MaterialPageErrorCode;
}
function validateMetadata(value:Record<string,unknown>, id:string):MaterialDetailMetadata {
    const required=metadataKeys.filter(key=>key!=='locator');
    for (const key of required) if (!Object.hasOwn(value,key)) return invalid();
    if (value.id!==id || !['article','document','video'].includes(value.kind as string)
        || !stringWithin(value.title,8192*16+16) || !Array.isArray(value.topics) || value.topics.length>30
        || !value.topics.every(topic=>stringWithin(topic,80,true)) || new Set(value.topics).size!==value.topics.length
        || !timestamp(value.createdAt) || !timestamp(value.updatedAt) || !timestamp(value.lastReadAt)
        || (value.archivedAt!==null && !timestamp(value.archivedAt))) return invalid();
    const source=value.source;
    if (!source || typeof source!=='object' || Array.isArray(source)) return invalid();
    const typed=source as Record<string,unknown>;
    if (typed.kind!==value.kind || (typed.url!==undefined && !stringWithin(typed.url,8192*16+16,true))
        || (typed.title!==undefined && !stringWithin(typed.title,240,true))
        || (typed.fingerprint!==undefined && !stringWithin(typed.fingerprint,256,true))) return invalid();
    if (value.locator!==undefined) {
        if (!value.locator || typeof value.locator!=='object' || Array.isArray(value.locator)) return invalid();
        const locator=value.locator as Record<string,unknown>;
        if (!['text','document','video'].includes(locator.kind as string)
            || (locator.quote!==undefined && !stringWithin(locator.quote,6000,true))
            || (locator.page!==undefined && (!integer(locator.page,1_000_000) || locator.page<1))
            || (locator.startMs!==undefined && !timestamp(locator.startMs))) return invalid();
    }
    return value as unknown as MaterialDetailMetadata;
}
function validateReference(value:unknown):MaterialReference {
    if (!value || typeof value!=='object' || Array.isArray(value)) return invalid();
    const reference=value as Record<string,unknown>;
    if (!['vocabulary','session','memory','note'].includes(reference.kind as string) || !stringWithin(reference.id,256)
        || (reference.excerpt!==undefined && !stringWithin(reference.excerpt,6000,true))
        || (reference.note!==undefined && !stringWithin(reference.note,12000,true))
        || (reference.createdAt!==undefined && !timestamp(reference.createdAt))
        || (reference.updatedAt!==undefined && !timestamp(reference.updatedAt))) return invalid();
    return value as MaterialReference;
}

/** 详情元信息和引用只在完整页面、版本与传输均校验后返回。 */
export async function requestMaterialDetail(request:Extract<MaterialPageRequest,{operation:'detail'}>, revision:number, options:Options = {}, connect:Connect = () => browser.runtime.connect({name:MATERIAL_PAGE_PORT_NAME}) as unknown as MaterialReadPort):Promise<MaterialDetailPage> {
    let phase:'initial'|'body'|'complete'|'error'='initial', failure:MaterialPageErrorCode|undefined;
    let header:{total:number;offset:number;nextOffset:number|null}|undefined;
    const metadata:Record<string,unknown>=Object.create(null), references:MaterialReference[]=[], ids=new Set<string>();
    const accept=(text:string)=>{
        let parsed:unknown;try {parsed=JSON.parse(text);} catch {return invalid();}
        const value=object(parsed,['type'],['version','revision','id','total','offset','nextOffset','key','value','count','code']);
        if (value.type==='error' && (phase==='initial'||phase==='body')) {failure=errorFromMessage(value,parsed);phase='error';references.length=0;return;}
        if (phase==='initial' && value.type==='detail-header') {
            object(parsed,['type','version','revision','id','total','offset','nextOffset']);
            if (value.version!==1 || value.revision!==revision || value.id!==request.id || !integer(value.total,1000)
                || value.offset!==request.offset || !integer(value.offset,1000) || value.offset>value.total
                || (value.nextOffset!==null && (!integer(value.nextOffset,1000)||value.nextOffset<=value.offset||value.nextOffset>value.total))) return invalid();
            header={total:value.total,offset:value.offset,nextOffset:value.nextOffset as number|null};phase='body';return;
        }
        if (phase==='body' && value.type==='metadata') {
            object(parsed,['type','key','value']);
            if (typeof value.key!=='string' || !(metadataKeys as readonly string[]).includes(value.key) || Object.hasOwn(metadata,value.key)) return invalid();
            metadata[value.key]=value.value;return;
        }
        if (phase==='body' && value.type==='reference') {
            object(parsed,['type','value']);
            if (references.length>=24) return invalid();
            const reference=validateReference(value.value), key=JSON.stringify([reference.kind,reference.id]);
            if (ids.has(key)) return invalid();
            ids.add(key);references.push(reference);return;
        }
        if (phase==='body' && header && value.type==='complete') {
            object(parsed,['type','count']);
            const end=header.offset+references.length;
            if (!integer(value.count,24)||value.count!==references.length||end>header.total
                || (header.nextOffset===null?end!==header.total:header.nextOffset!==end)) return invalid();
            validateMetadata(metadata,request.id);phase='complete';return;
        }
        return invalid();
    };
    await receiveLines(request,options,connect,accept,()=>phase==='complete'||phase==='error');
    if (failure) throw publicError(failure);
    const isComplete=():boolean=>phase==='complete';
    if (!isComplete() || !header) return invalid();
    return {revision,id:request.id,metadata:validateMetadata(metadata,request.id),total:header.total,offset:header.offset,nextOffset:header.nextOffset,references};
}

export interface MaterialTopicsPage {revision:number; total:number; matched:number; offset:number; nextOffset:number|null; topics:string[]}
/** 主题可逐页检索，绝不将未加载的主题当作不存在。 */
export async function requestMaterialTopics(request:Extract<MaterialPageRequest,{operation:'topics'}>, revision:number, options:Options = {}, connect:Connect = () => browser.runtime.connect({name:MATERIAL_PAGE_PORT_NAME}) as unknown as MaterialReadPort):Promise<MaterialTopicsPage> {
    let phase:'initial'|'body'|'complete'|'error'='initial', failure:MaterialPageErrorCode|undefined, page:MaterialTopicsPage|undefined;
    const topics=new Set<string>();
    const accept=(text:string)=>{
        let parsed:unknown;try {parsed=JSON.parse(text);} catch {return invalid();}
        const value=object(parsed,['type'],['version','revision','total','matched','offset','nextOffset','value','count','code']);
        if (value.type==='error' && (phase==='initial'||phase==='body')) {failure=errorFromMessage(value,parsed);phase='error';page=undefined;return;}
        if (phase==='initial' && value.type==='topics-header') {
            object(parsed,['type','version','revision','total','matched','offset','nextOffset']);
            if (value.version!==1||value.revision!==revision||!integer(value.total,300_000)||!integer(value.matched,300_000)||value.matched>value.total
                ||!integer(value.offset,300_000)||value.offset!==request.offset||value.offset>value.matched
                ||(value.nextOffset!==null&&(!integer(value.nextOffset,300_000)||value.nextOffset<=value.offset||value.nextOffset>value.matched))) return invalid();
            page={revision,total:value.total,matched:value.matched,offset:value.offset,nextOffset:value.nextOffset as number|null,topics:[]};phase='body';return;
        }
        if (phase==='body' && page && value.type==='topic') {
            object(parsed,['type','value']);
            if (!stringWithin(value.value,80,true)||topics.has(value.value)||page.topics.length>=100) return invalid();
            topics.add(value.value);page.topics.push(value.value);return;
        }
        if (phase==='body' && page && value.type==='complete') {
            object(parsed,['type','count']);
            const end=page.offset+page.topics.length;
            if (!integer(value.count,100)||value.count!==page.topics.length||end>page.matched
                ||(page.nextOffset===null?end!==page.matched:page.nextOffset!==end)) return invalid();
            phase='complete';return;
        }
        return invalid();
    };
    await receiveLines(request,options,connect,accept,()=>phase==='complete'||phase==='error');
    if (failure) throw publicError(failure);
    const isComplete=():boolean=>phase==='complete';
    if (!isComplete()||!page) return invalid();
    return page;
}
