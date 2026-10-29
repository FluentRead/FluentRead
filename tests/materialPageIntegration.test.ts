/**
 * @file tests/materialPageIntegration.test.ts
 * 文件职责：验证材料分页客户端、后台桥与事务仓库组合后的读取合同。
 * 主要内容：真实仓库的分页、主题、精确文档位置、引用和并发版本失效通过模拟异步 Port 往返。
 * 模块边界：使用 fake-indexeddb 和模拟 Port；不声称真实浏览器、磁盘配额或扩展升级行为。
 */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {afterEach, describe, expect, it, vi} from 'vitest';
vi.mock('webextension-polyfill', () => ({default:{runtime:{connect:vi.fn()},extension:{inIncognitoContext:false}}}));
import {isTrustedSettingsSender} from '@/src/app/background/handlers/trustedSettingsSender';
import {createMaterialPageBridge, type MaterialPagePort} from '@/src/features/vocabulary/materialPageBridge';
import {requestMaterialDetail, requestMaterialPage, requestMaterialTopics} from '@/src/features/vocabulary/materialPageClient';
import {MATERIAL_PAGE_PORT_NAME} from '@/src/features/vocabulary/materialPageProtocol';
import {MaterialDatabase, MaterialRepository} from '@/src/features/vocabulary/materialRepository';
import type {MaterialReadPort} from '@/src/features/vocabulary/materialReadTransport';

type Listener = (...args:any[])=>void;
class Events<T extends Listener> {
    listeners=new Set<T>();
    addListener(fn:T) {this.listeners.add(fn);}
    removeListener(fn:T) {this.listeners.delete(fn);}
    fire(...args:Parameters<T>) {for(const fn of [...this.listeners]) fn(...args);}
}
class Port implements MaterialPagePort {
    name=MATERIAL_PAGE_PORT_NAME;
    sender={id:'test',url:'chrome-extension://test/options.html?tab=materials'};
    onMessage=new Events<(message:unknown)=>void>();
    onDisconnect=new Events<()=>void>();
    peer!:Port;closed=false;
    postMessage(message:unknown) {if(this.closed)throw Error('closed');queueMicrotask(()=>{if(!this.peer.closed)this.peer.onMessage.fire(message);});}
    disconnect() {if(this.closed)return;this.closed=true;this.peer.closed=true;this.onDisconnect.fire();this.peer.onDisconnect.fire();}
}
function ports() {const server=new Port(), client=new Port();server.peer=client;client.peer=server;return {server,client};}
let serial=0;
const databases:MaterialDatabase[]=[];
function database(name=`material-page-integration-${++serial}`) {const db=new MaterialDatabase(name);databases.push(db);return db;}
afterEach(async()=>{const all=databases.splice(0),names=new Set(all.map(db=>db.name));for(const db of all)db.close();for(const name of names)await Dexie.delete(name);});

describe('material page transport and repository integration',()=>{
    it.each(['page','topics','detail'] as const)('rejects %s delivery after state loss and revision reuse on another connection',async operation=>{
        const db=database(),peer=database(db.name),repository=new MaterialRepository(db),other=new MaterialRepository(peer);
        const item=await repository.capture({source:{kind:'article',url:'https://example.test/state-loss'},capturedAt:10},10);
        const bridge=createMaterialPageBridge({repository,ready:Promise.resolve(),isPrivateContext:()=>false,isTrustedSender:()=>true});
        const connect=():MaterialReadPort=>{const {server,client}=ports();bridge.connect(server);return client;};
        try {
            const page=await requestMaterialPage({v:1,type:'start',operation:'open',options:{}},{},connect);
            expect(page).toBeDefined();const {capability,revision}=page!;
            await peer.meta.delete('state');await other.update(item.id,{title:'changed'},20);
            expect(await other.revision()).toBe(revision);
            const request=operation==='page'
                ? requestMaterialPage({v:1,type:'start',operation:'page',capability:capability!,offset:0},{},connect)
                : operation==='topics'
                    ? requestMaterialTopics({v:1,type:'start',operation:'topics',capability:capability!,offset:0},revision,{},connect)
                    : requestMaterialDetail({v:1,type:'start',operation:'detail',capability:capability!,id:item.id,offset:0},revision,{},connect);
            await expect(request).rejects.toMatchObject({code:'stale-operation'});
        } finally {await bridge.dispose();}
    });
    it('accepts a real capture whose fallback hostname exceeds the explicit title limit',async()=>{
        const db=database(),repository=new MaterialRepository(db),host=`${'a'.repeat(300)}.example`;
        const item=await repository.capture({source:{kind:'article',url:`https://${host}/`},capturedAt:10},10);
        const bridge=createMaterialPageBridge({repository,ready:Promise.resolve(),isPrivateContext:()=>false,
            isTrustedSender:sender=>isTrustedSettingsSender(sender,'test','chrome-extension://test/options.html')});
        const connect=():MaterialReadPort=>{const {server,client}=ports();bridge.connect(server);return client;};
        try {
            const page=await requestMaterialPage({v:1,type:'start',operation:'open',options:{}},{},connect);
            expect(item.title).toBe(host); expect(page?.items[0].title).toBe(host);
        } finally {bridge.dispose();}
    });
    it('returns ordered summaries, all topics and full paged references through the verified wire; changes invalidate the session',async()=>{
        const db=database(), peer=database(db.name), repository=new MaterialRepository(db), other=new MaterialRepository(peer);
        const fingerprint='a'.repeat(32), source={kind:'document' as const,fingerprint,title:'Local document'};
        const documentReference={version:1 as const,materialId:fingerprint,locator:{version:1 as const,source:'原文',scope:'pdf:7',position:'[1,2]',before:'前文',after:'后文'},locatorOccurrences:2};
        let record=await repository.capture({source,locator:{kind:'document',page:7,quote:'原文',documentReference},
            reference:{kind:'note',id:'n-0',note:'笔记-0'},capturedAt:100},100);
        for(let index=1;index<30;index++) record=await repository.capture({source,
            reference:{kind:'note',id:`n-${index}`,note:`${index}：${'文'.repeat(3000)}`},capturedAt:100+index},100+index);
        await repository.update(record.id,{topics:['主题','Alpha']},200);
        const otherRecord=await repository.capture({source:{kind:'article',url:'https://example.test/page',title:'Other'},
            reference:{kind:'note',id:'other',note:'不同内容'},capturedAt:300},300);
        await repository.update(otherRecord.id,{topics:['beta','主题']},301);
        // Reproduce a historical empty topic before opening the snapshot; normal new writes normalize it away.
        await db.materials.update(otherRecord.id,{topics:['beta','主题','']});
        const bridge=createMaterialPageBridge({repository,ready:Promise.resolve(),isPrivateContext:()=>false,
            isTrustedSender:sender=>isTrustedSettingsSender(sender,'test','chrome-extension://test/options.html')});
        const connect=():MaterialReadPort=>{const {server,client}=ports();bridge.connect(server);return client;};
        try {
            const open=await requestMaterialPage({v:1,type:'start',operation:'open',options:{}},{},connect);
            expect(open).toBeDefined(); const {capability,revision,items}=open!;
            expect(capability).toMatch(/^[0-9a-f]{64}$/u);expect(items.map(item=>item.id)).toEqual([otherRecord.id,record.id]);
            const token=capability!;
            const topics=await requestMaterialTopics({v:1,type:'start',operation:'topics',capability:token,offset:0},revision,{},connect);
            expect(topics.topics).toEqual(['beta','主题','','Alpha'].sort((a,b)=>a.localeCompare(b)));
            const queryTopics=await requestMaterialTopics({v:1,type:'start',operation:'topics',capability:token,offset:0,search:'ALP'},revision,{},connect);
            expect(queryTopics).toMatchObject({total:4,matched:1,topics:['Alpha']});
            const first=await requestMaterialDetail({v:1,type:'start',operation:'detail',capability:token,id:record.id,offset:0},revision,{},connect);
            expect(first.metadata.locator?.documentReference).toEqual(documentReference);
            expect(first.metadata.source).toEqual(record.source);expect(first.references).toHaveLength(24);expect(first.nextOffset).toBe(24);
            const last=await requestMaterialDetail({v:1,type:'start',operation:'detail',capability:token,id:record.id,offset:first.nextOffset!},revision,{},connect);
            expect([...first.references,...last.references]).toEqual((await repository.get(record.id))?.references);
            await other.update(record.id,{title:'Changed by another connection'},400);
            await expect(requestMaterialPage({v:1,type:'start',operation:'page',capability:token,offset:0},{},connect))
                .rejects.toMatchObject({code:'stale-operation'});
            await expect(requestMaterialTopics({v:1,type:'start',operation:'topics',capability:token,offset:0},revision,{},connect))
                .rejects.toMatchObject({code:'stale-operation'});
        } finally {bridge.dispose();}
    });
});
