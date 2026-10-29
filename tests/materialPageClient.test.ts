import {afterEach, describe, expect, it, vi} from 'vitest';
import browser from 'webextension-polyfill';
const privateContext = vi.hoisted(() => ({inIncognitoContext:false}));
vi.mock('webextension-polyfill', () => ({default:{runtime:{connect:vi.fn()},extension:privateContext}}));
import {requestMaterialDetail, requestMaterialPage, requestMaterialTopics} from '@/src/features/vocabulary/materialPageClient';
import {sendMaterialRead, type MaterialReadPort} from '@/src/features/vocabulary/materialReadTransport';
import type {MaterialPageRequest} from '@/src/features/vocabulary/materialPageProtocol';

type Listener = (...args:any[])=>void;
class Events<T extends Listener> {
    listeners=new Set<T>();
    addListener(fn:T) {this.listeners.add(fn);}
    removeListener(fn:T) {this.listeners.delete(fn);}
    fire(...args:Parameters<T>) {for(const fn of [...this.listeners]) fn(...args);}
}
class Port implements MaterialReadPort {
    onMessage=new Events<(message:unknown)=>void>(); onDisconnect=new Events<()=>void>();
    peer!:Port; closed=false;
    postMessage(message:unknown) {if(this.closed)throw Error('closed'); queueMicrotask(()=>{if(!this.peer.closed)this.peer.onMessage.fire(message);});}
    disconnect() {if(this.closed)return;this.closed=true;this.peer.closed=true;this.onDisconnect.fire();this.peer.onDisconnect.fire();}
}
function pair() {const a=new Port(), b=new Port();a.peer=b;b.peer=a;return [a,b] as const;}
const token='a'.repeat(64), encoder=new TextEncoder();
const open:MaterialPageRequest={v:1,type:'start',operation:'open',options:{}};
const page:MaterialPageRequest={v:1,type:'start',operation:'page',capability:token,offset:0};
const summary={id:'id',kind:'article',title:'材料',sourceUrl:'https://example.test/',topics:['主题'],lastReadAt:3,updatedAt:2,archivedAt:null,preview:'原文',referenceCount:1};
function header(operation:'open'|'page'='open', patch:Record<string,unknown>={}) {
    return {type:'header',version:1,operation,...(operation==='open'?{capability:token}:{}),revision:2,total:1,matched:1,offset:0,nextOffset:null,...patch};
}
function serve(values:unknown[], chunks=17) {
    const [client,server]=pair(); let serverResult:Promise<void>|undefined;
    const start=()=>{server.onMessage.removeListener(start);serverResult=sendMaterialRead(server,(async function*(){
        const bytes=encoder.encode(values.map(value=>JSON.stringify(value)).join('\n')+'\n');
        for(let offset=0;offset<bytes.length;offset+=chunks)yield bytes.slice(offset,offset+chunks);
    })());void serverResult.catch(()=>{});};
    server.onMessage.addListener(start);
    return {client, server, get serverResult(){return serverResult;}};
}
function serveBytes(bytes:Uint8Array) {
    const [client,server]=pair(); let serverResult:Promise<void>|undefined;
    const start=()=>{server.onMessage.removeListener(start);serverResult=sendMaterialRead(server,(async function*(){if(bytes.length)yield bytes;})());void serverResult.catch(()=>{});};
    server.onMessage.addListener(start);
    return {client,server,get serverResult(){return serverResult;}};
}
const detailRequest:Extract<MaterialPageRequest,{operation:'detail'}>={v:1,type:'start',operation:'detail',capability:token,id:'id',offset:0};
const topicsRequest:Extract<MaterialPageRequest,{operation:'topics'}>={v:1,type:'start',operation:'topics',capability:token,offset:0};
const metadata={id:'id',kind:'article',title:'title',source:{kind:'article',url:'https://example.test/'},topics:['topic'],createdAt:1,updatedAt:2,lastReadAt:3,archivedAt:null};
const detailHeader={type:'detail-header',version:1,revision:2,id:'id',total:0,offset:0,nextOffset:null};
const topicHeader={type:'topics-header',version:1,revision:2,total:1,matched:1,offset:0,nextOffset:null};
const metadataRows=(record:Record<string,unknown>)=>Object.entries(record).map(([key,value])=>({type:'metadata',key,value}));
afterEach(()=>{privateContext.inIncognitoContext=false;});
describe('material page client',()=>{
    it('verifies the complete framed response before returning a page and reports real progress',async()=>{
        const fixture=serve([{type:'progress',processed:1,total:2},{type:'progress',processed:2,total:2},header(),{type:'summary',value:summary},{type:'complete',count:1}],3);
        const progress=vi.fn();
        const result=await requestMaterialPage(open,{onProgress:progress},()=>fixture.client);
        expect(result).toEqual({capability:token,revision:2,total:1,matched:1,offset:0,nextOffset:null,items:[summary]});
        expect(progress.mock.calls).toEqual([[{processed:1,total:2}],[{processed:2,total:2}]]);
        await fixture.serverResult;
    });
    it('stops processing the current frame when a progress handler cancels the request',async()=>{
        const fixture=serve([{type:'progress',processed:1,total:2},{type:'progress',processed:2,total:2},header(),{type:'summary',value:summary},{type:'complete',count:1}],4096);
        const controller=new AbortController();
        const progress=vi.fn(()=>controller.abort());
        await expect(requestMaterialPage(open,{signal:controller.signal,onProgress:progress},()=>fixture.client)).rejects.toMatchObject({name:'AbortError'});
        expect(progress).toHaveBeenCalledTimes(1);
        expect(fixture.client.closed).toBe(true);
        expect(fixture.server.closed).toBe(true);
        await fixture.serverResult?.catch(()=>{});
    });
    it('closes the transport if the progress handler throws',async()=>{
        const fixture=serve([{type:'progress',processed:1,total:2},header(),{type:'summary',value:summary},{type:'complete',count:1}],4096);
        const error=new Error('progress handler failed');
        await expect(requestMaterialPage(open,{onProgress:()=>{throw error;}},()=>fixture.client)).rejects.toBe(error);
        expect(fixture.client.closed).toBe(true);
        expect(fixture.server.closed).toBe(true);
        await fixture.serverResult?.catch(()=>{});
    });
    it('discards partial summaries and preserves a public stale error only after transport completion',async()=>{
        const fixture=serve([header(),{type:'summary',value:summary},{type:'error',code:'stale-operation'}]);
        await expect(requestMaterialPage(open,{},()=>fixture.client)).rejects.toMatchObject({name:'MaterialPageClientError',code:'stale-operation'});
        await fixture.serverResult;
    });
    it('distinguishes transient busy from permanent content limits',async()=>{
        for(const [code,text] of [['busy','繁忙'],['limit-exceeded','超出']] as const) {
            const fixture=serve([{type:'error',code}]);
            await expect(requestMaterialPage(open,{},()=>fixture.client)).rejects.toMatchObject({code,message:expect.stringContaining(text)});
            await fixture.serverResult;
        }
    });
    it('handles page and close acknowledgements',async()=>{
        const first=serve([header('page'),{type:'summary',value:summary},{type:'complete',count:1}]);
        expect((await requestMaterialPage(page,{},()=>first.client))?.capability).toBeUndefined();
        await first.serverResult;
        const second=serve([{type:'closed'}]);
        await expect(requestMaterialPage({v:1,type:'start',operation:'close',capability:token},{},()=>second.client)).resolves.toBeUndefined();
        await second.serverResult;
    });
    it('delivers a revision-checked detail page and retains its complete source and locator',async()=>{
        const detail:Extract<MaterialPageRequest,{operation:'detail'}>={v:1,type:'start',operation:'detail',capability:token,id:'id',offset:0};
        const metadata={id:'id',kind:'document',title:'材料',source:{kind:'document',fingerprint:'a'.repeat(32)},locator:{kind:'document',page:3,quote:'原文'},topics:['主题'],createdAt:1,updatedAt:2,lastReadAt:3,archivedAt:null};
        const reference={kind:'note',id:'n',note:'个人笔记',createdAt:1};
        const fixture=serve([{type:'detail-header',version:1,revision:2,id:'id',total:1,offset:0,nextOffset:null},
            ...Object.entries(metadata).map(([key,value])=>({type:'metadata',key,value})),{type:'reference',value:reference},{type:'complete',count:1}],5);
        expect(await requestMaterialDetail(detail,2,{},()=>fixture.client)).toEqual({revision:2,id:'id',metadata,total:1,offset:0,nextOffset:null,references:[reference]});
        await fixture.serverResult;
    });
    it('rejects stale or incomplete detail and delivers explicit not-found errors',async()=>{
        const detail:Extract<MaterialPageRequest,{operation:'detail'}>={v:1,type:'start',operation:'detail',capability:token,id:'id',offset:0};
        const stale=serve([{type:'detail-header',version:1,revision:3,id:'id',total:0,offset:0,nextOffset:null},{type:'complete',count:0}]);
        await expect(requestMaterialDetail(detail,2,{},()=>stale.client)).rejects.toThrow();await stale.serverResult?.catch(()=>{});
        const missing=serve([{type:'error',code:'not-found'}]);
        await expect(requestMaterialDetail(detail,2,{},()=>missing.client)).rejects.toMatchObject({code:'not-found'});await missing.serverResult;
        const partial=serve([{type:'detail-header',version:1,revision:2,id:'id',total:0,offset:0,nextOffset:null},{type:'complete',count:0}]);
        await expect(requestMaterialDetail(detail,2,{},()=>partial.client)).rejects.toThrow();await partial.serverResult?.catch(()=>{});
    });
    it('receives a bounded topic page without treating later pages as missing',async()=>{
        const request:Extract<MaterialPageRequest,{operation:'topics'}>={v:1,type:'start',operation:'topics',capability:token,offset:0};
        const fixture=serve([{type:'topics-header',version:1,revision:2,total:3,matched:3,offset:0,nextOffset:2},
            {type:'topic',value:'一'},{type:'topic',value:'二'},{type:'complete',count:2}]);
        expect(await requestMaterialTopics(request,2,{},()=>fixture.client)).toEqual({revision:2,total:3,matched:3,offset:0,nextOffset:2,topics:['一','二']});
        await fixture.serverResult;
    });
    it('retains an empty historical topic in summary and topic results',async()=>{
        const first=serve([header(),{type:'summary',value:{...summary,topics:['']}},{type:'complete',count:1}]);
        expect((await requestMaterialPage(open,{},()=>first.client))?.items[0].topics).toEqual(['']);await first.serverResult;
        const request:Extract<MaterialPageRequest,{operation:'topics'}>={v:1,type:'start',operation:'topics',capability:token,offset:0};
        const second=serve([{type:'topics-header',version:1,revision:2,total:1,matched:1,offset:0,nextOffset:null},{type:'topic',value:''},{type:'complete',count:1}]);
        expect((await requestMaterialTopics(request,2,{},()=>second.client)).topics).toEqual(['']);await second.serverResult;
    });
    it.each([
        [header(),{type:'summary',value:summary},{type:'complete',count:0}],
        [header(),{type:'summary',value:summary},{type:'summary',value:summary},{type:'complete',count:2}],
        [header('page'),{type:'summary',value:summary},{type:'complete',count:1}],
        [header(),{type:'summary',value:summary}],
        [{type:'progress',processed:2,total:1},header(),{type:'complete',count:0}],
        [header(),{type:'error',code:'secret private text'}],
        [header(),{type:'summary',value:summary},{type:'complete',count:1},{type:'closed'}],
    ])('rejects inconsistent, partial or malformed response %#',async(...values)=>{
        const fixture=serve(values);
        await expect(requestMaterialPage(open,{},()=>fixture.client)).rejects.toThrow();
        await fixture.serverResult?.catch(()=>{});
    });
    it('aborts a hanging request and rejects private contexts before opening a port',async()=>{
        const [client,server]=pair(), controller=new AbortController();
        const pending=requestMaterialPage(open,{signal:controller.signal},()=>client);
        controller.abort(); await expect(pending).rejects.toMatchObject({name:'AbortError'});
        expect(server.closed).toBe(true);
        privateContext.inIncognitoContext=true;const connect=vi.fn(()=>client);
        await expect(requestMaterialPage(open,{},connect)).rejects.toMatchObject({name:'MaterialPageClientError'});
        expect(connect).not.toHaveBeenCalled();
    });
    it('does not connect if the caller already cancelled',async()=>{
        const controller=new AbortController(), connect=vi.fn();controller.abort();
        await expect(requestMaterialPage(open,{signal:controller.signal},connect)).rejects.toMatchObject({name:'AbortError'});
        expect(connect).not.toHaveBeenCalled();
    });
    it('honors cancellation during the final transport acknowledgement',async()=>{
        const fixture=serve([header(),{type:'summary',value:summary},{type:'complete',count:1}]);
        const controller=new AbortController(),post=fixture.client.postMessage.bind(fixture.client);
        fixture.client.postMessage=message=>{
            post(message);
            if((message as {type?:unknown})?.type==='done') queueMicrotask(()=>controller.abort());
        };
        await expect(requestMaterialPage(open,{signal:controller.signal},()=>fixture.client)).rejects.toMatchObject({name:'AbortError'});
        await fixture.serverResult;
    });
    it.each([
        ['invalid JSON','{bad}\n'],
        ['non-object JSON','null\n'],
        ['an array instead of a protocol message','[]\n'],
        ['a message with an unknown property',JSON.stringify({...header(),unexpected:true})+'\n'],
        ['a partial final line',JSON.stringify(header())],
        ['a line over the byte limit','x'.repeat(512*1024+1)+'\n'],
    ])('rejects %s without delivering a page',async(_label,text)=>{
        const fixture=serveBytes(encoder.encode(text));
        await expect(requestMaterialPage(open,{},()=>fixture.client)).rejects.toThrow();
        await fixture.serverResult?.catch(()=>{});
    });
    it('does not leak partial results when a transport disconnects while requesting',async()=>{
        const [client,server]=pair();
        server.onMessage.addListener(()=>server.disconnect());
        await expect(requestMaterialPage(open,{},()=>client)).rejects.toThrow();
    });
    it('preserves a request failure when disconnect itself also fails',async()=>{
        const [client]=pair();
        client.postMessage=()=>{throw Error('post failed');};
        client.disconnect=()=>{throw Error('disconnect failed');};
        await expect(requestMaterialPage(open,{},()=>client)).rejects.toThrow('post failed');
    });
    it('accepts a summary page whose next offset follows the received items',async()=>{
        const fixture=serve([{...header(),total:2,matched:2,nextOffset:1},{type:'summary',value:summary},{type:'complete',count:1}]);
        expect((await requestMaterialPage(open,{},()=>fixture.client))?.nextOffset).toBe(1);
        await fixture.serverResult;
    });
    it.each([
        [{...header(),total:2,matched:2,nextOffset:2},{type:'summary',value:summary},{type:'complete',count:1}],
        [{...header(),total:1,matched:1,nextOffset:2}],
        [header(),{type:'unexpected'}],
        [{...header(),total:31,matched:31,nextOffset:30},...Array.from({length:31},(_,index)=>({type:'summary',value:{...summary,id:`id-${index}`}}))],
    ])('rejects impossible summary pagination boundaries %#',async(...values)=>{
        const fixture=serve(values);
        await expect(requestMaterialPage(open,{},()=>fixture.client)).rejects.toThrow();
        await fixture.serverResult?.catch(()=>{});
    });
    it('uses the browser port by default for page, detail and topic requests',async()=>{
        const fixtures=[
            serve([header(),{type:'summary',value:summary},{type:'complete',count:1}]),
            serve([detailHeader,...metadataRows(metadata),{type:'complete',count:0}]),
            serve([topicHeader,{type:'topic',value:'topic'},{type:'complete',count:1}]),
        ];
        const connect=vi.mocked(browser.runtime.connect);connect.mockReset();
        for(const fixture of fixtures)connect.mockReturnValueOnce(fixture.client as never);
        try {
            expect((await requestMaterialPage(open))?.items).toEqual([summary]);
            expect((await requestMaterialDetail(detailRequest,2)).metadata).toEqual(metadata);
            expect((await requestMaterialTopics(topicsRequest,2)).topics).toEqual(['topic']);
            expect(connect).toHaveBeenCalledTimes(3);
            expect(connect.mock.calls.every(([options])=>options?.name==='fluentread-material-page-v1')).toBe(true);
        } finally {connect.mockReset();await Promise.all(fixtures.map(fixture=>fixture.serverResult?.catch(()=>{})));}
    });
    it.each([
        [{type:'unexpected'}],
        [detailHeader,{type:'metadata',key:'id',value:'id'},{type:'metadata',key:'id',value:'id'}],
        [detailHeader,{type:'metadata',key:'unknown',value:'secret'}],
        [{...detailHeader,nextOffset:1}],
        [{...detailHeader,total:1},{type:'complete',count:0}],
        [{...detailHeader,total:1},{type:'reference',value:{kind:'note',id:'n'}},{type:'reference',value:{kind:'note',id:'n'}}],
        [{...detailHeader,total:1},{type:'reference',value:{kind:'note',id:'',note:'text'}}],
        [detailHeader,...metadataRows({...metadata,archivedAt:-1}),{type:'complete',count:0}],
        [detailHeader,...metadataRows({...metadata,source:{kind:'video'}}),{type:'complete',count:0}],
        [detailHeader,...metadataRows({...metadata,source:[]}),{type:'complete',count:0}],
        [detailHeader,...metadataRows({...metadata,locator:[]}),{type:'complete',count:0}],
        [detailHeader,...metadataRows({...metadata,locator:{kind:'video',startMs:-1}}),{type:'complete',count:0}],
        [detailHeader,...metadataRows({...metadata,locator:{kind:'document',page:0}}),{type:'complete',count:0}],
        [{...detailHeader,total:1},{type:'reference',value:[]}],
        [{...detailHeader,total:1},{type:'reference',value:{kind:'note',id:'n',excerpt:'x'.repeat(6001)}}],
        [{...detailHeader,total:25},...Array.from({length:25},(_,index)=>({type:'reference',value:{kind:'note',id:`n-${index}`}}))],
    ])('rejects inconsistent or malformed detail response %#',async(...values)=>{
        const fixture=serve(values);
        await expect(requestMaterialDetail(detailRequest,2,{},()=>fixture.client)).rejects.toThrow();
        await fixture.serverResult?.catch(()=>{});
    });
    it('preserves a public detail error after a partial body rather than exposing metadata or references',async()=>{
        const fixture=serve([{...detailHeader,total:1},{type:'reference',value:{kind:'note',id:'n'}},{type:'error',code:'stale-operation'}]);
        await expect(requestMaterialDetail(detailRequest,2,{},()=>fixture.client)).rejects.toMatchObject({code:'stale-operation'});
        await fixture.serverResult;
    });
    it.each([
        [{type:'unexpected'}],
        [{...topicHeader,revision:3}],
        [{...topicHeader,nextOffset:2}],
        [topicHeader,{type:'topic',value:'topic'},{type:'topic',value:'topic'}],
        [topicHeader,{type:'topic',value:'x'.repeat(81)}],
        [topicHeader,{type:'topic',value:'topic'},{type:'complete',count:0}],
        [topicHeader,{type:'complete',count:0}],
        [{type:'error',code:'private backend details'}],
    ])('rejects inconsistent or malformed topic response %#',async(...values)=>{
        const fixture=serve(values);
        await expect(requestMaterialTopics(topicsRequest,2,{},()=>fixture.client)).rejects.toThrow();
        await fixture.serverResult?.catch(()=>{});
    });
    it('returns a public topic error after partial data without disclosing backend details',async()=>{
        const fixture=serve([topicHeader,{type:'topic',value:'topic'},{type:'error',code:'storage-error'}]);
        await expect(requestMaterialTopics(topicsRequest,2,{},()=>fixture.client)).rejects.toMatchObject({code:'storage-error'});
        await fixture.serverResult;
    });
    it.each(['detail','topics'] as const)('rejects a malformed or empty %s stream',async(operation)=>{
        for(const bytes of [encoder.encode('{bad}\n'),new Uint8Array()]) {
            const fixture=serveBytes(bytes);
            const response=operation==='detail'?requestMaterialDetail(detailRequest,2,{},()=>fixture.client):requestMaterialTopics(topicsRequest,2,{},()=>fixture.client);
            await expect(response).rejects.toThrow();
            await fixture.serverResult?.catch(()=>{});
        }
    });
});
