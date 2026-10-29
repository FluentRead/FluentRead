import {describe,expect,it,vi} from 'vitest';
import {createMaterialPageBridge,type MaterialPagePort} from '@/src/features/vocabulary/materialPageBridge';
import {MATERIAL_PAGE_MAX_LINE_BYTES,MATERIAL_PAGE_PORT_NAME,type MaterialPageMessage} from '@/src/features/vocabulary/materialPageProtocol';
import {receiveMaterialRead,type MaterialReadPort} from '@/src/features/vocabulary/materialReadTransport';
import {MaterialError} from '@/src/features/vocabulary/materialModel';
import type {MaterialRecord} from '@/src/features/vocabulary/materialProtocol';

type Fn=(...args:any[])=>void;
class EventSet<T extends Fn>{listeners=new Set<T>();addListener(fn:T){this.listeners.add(fn);}removeListener(fn:T){this.listeners.delete(fn);}fire(...args:Parameters<T>){for(const fn of [...this.listeners])fn(...args);}}
class Port {
    name=MATERIAL_PAGE_PORT_NAME;
    sender:MaterialPagePort['sender']={id:'extension',url:'chrome-extension://extension/options.html'};
    onMessage=new EventSet<(message:unknown)=>void>();onDisconnect=new EventSet<()=>void>();
    peer!:Port;closed=false;sent:unknown[]=[];
    postMessage(value:unknown){if(this.closed)throw Error('closed');this.sent.push(value);this.peer.onMessage.fire(value);}
    disconnect(){if(this.closed)return;this.closed=true;this.peer.closed=true;this.onDisconnect.fire();this.peer.onDisconnect.fire();}
}
const pair=()=>{const a=new Port(),b=new Port();a.peer=b;b.peer=a;return [a,b] as const;};
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
const item=(id:string):MaterialRecord=>({id,identityKey:`article:https://example.test/${id}`,kind:'article',title:id,source:{kind:'article',url:`https://example.test/${id}`},topics:[],references:[],createdAt:1,updatedAt:1,lastReadAt:1,archivedAt:null});
function fixture(count=2){
    let revision=1;
    const items=Array.from({length:count},(_,index)=>item(String(index).padStart(2,'0')));
    const repo={openSnapshot:vi.fn(async()=>({revision,ids:items.map(value=>value.id)})),
        readSnapshotRecord:vi.fn(async(expected:number,id:string)=>{if(expected!==revision)throw new MaterialError('stale-operation','private');return items.find(value=>value.id===id)??null;}),
        checkSnapshot:vi.fn(async(expected:number)=>{if(expected!==revision)throw new MaterialError('stale-operation','private');})};
    const bridge=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),isPrivateContext:()=>false,
        isTrustedSender:sender=>sender?.id==='extension'&&sender.url==='chrome-extension://extension/options.html'});
    return {bridge,repo,items,mutate(){revision++;}};
}
const start=(options:object={})=>({v:1,type:'start',operation:'open',options});
const page=(capability:string,offset:number)=>({v:1,type:'start',operation:'page',capability,offset});
const detail=(capability:string,id:string,offset:number)=>({v:1,type:'start',operation:'detail',capability,id,offset});
const topics=(capability:string,offset:number,search?:string)=>({v:1,type:'start',operation:'topics',capability,offset,...(search===undefined?{}:{search})});
const close=(capability:string)=>({v:1,type:'start',operation:'close',capability});
async function transfer(bridge:ReturnType<typeof createMaterialPageBridge>,request:unknown):Promise<MaterialPageMessage[]>{
    const [server,client]=pair();bridge.connect(server);const chunks:Uint8Array[]=[];
    const reading=receiveMaterialRead(client as MaterialReadPort,bytes=>{chunks.push(bytes);});client.postMessage(request);await reading;
    const data=new TextDecoder().decode(Uint8Array.from(chunks.flatMap(chunk=>[...chunk])));
    return data.trim().split('\n').map(line=>JSON.parse(line));
}
const header=(messages:MaterialPageMessage[])=>messages.find(value=>value.type==='header') as Extract<MaterialPageMessage,{type:'header'}>;
const complete=(messages:MaterialPageMessage[])=>messages.find(value=>value.type==='complete') as Extract<MaterialPageMessage,{type:'complete'}>;

describe('trusted material page bridge',()=>{
    it('opens a bounded session, reads additional pages and closes idempotently',async()=>{
        const {bridge}=fixture(31);
        const first=await transfer(bridge,start());const h=header(first);
        expect(h).toMatchObject({version:1,operation:'open',revision:1,total:31,matched:31,offset:0,nextOffset:30});
        expect(h.capability).toMatch(/^[0-9a-f]{64}$/u);expect(complete(first).count).toBe(30);
        await tick();
        const second=await transfer(bridge,page(h.capability!,30));
        expect(header(second)).toMatchObject({operation:'page',offset:30,nextOffset:null});expect(complete(second).count).toBe(1);
        await tick();expect(await transfer(bridge,close(h.capability!))).toEqual([{type:'closed'}]);
        expect(await transfer(bridge,close(h.capability!))).toEqual([{type:'closed'}]);
        expect(await transfer(bridge,page(h.capability!,0))).toEqual([{type:'error',code:'stale-operation'}]);bridge.dispose();
    });
    it('rejects unrelated, untrusted and incognito ports before opening the repository',()=>{
        const {bridge,repo}=fixture();const [other]=pair();other.name='unrelated';expect(bridge.connect(other)).toBe(false);expect(other.closed).toBe(false);
        for(const sender of [undefined,{id:'other',url:'chrome-extension://extension/options.html'},
            {id:'extension',url:'chrome-extension://extension/options.html',incognito:true},
            {id:'extension',url:'chrome-extension://extension/options.html',tab:{incognito:true}}]){
            const [server]=pair();server.sender=sender;expect(bridge.connect(server)).toBe(true);expect(server.closed).toBe(true);
        }
        expect(repo.openSnapshot).not.toHaveBeenCalled();bridge.dispose();
    });
    it('releases a port disconnected before its first request',()=>{
        const {bridge,repo}=fixture(),[server,client]=pair();bridge.connect(server);client.disconnect();
        expect(server.closed).toBe(true);expect(server.onMessage.listeners.size).toBe(0);expect(server.onDisconnect.listeners.size).toBe(0);
        expect(repo.openSnapshot).not.toHaveBeenCalled();bridge.dispose();
    });
    it.each(['before-registration','after-registration'] as const)('removes listeners if a disconnect arrives %s',async phase=>{
        const {bridge,repo}=fixture(),[server]=pair();
        const add=server.onDisconnect.addListener.bind(server.onDisconnect);
        server.onDisconnect.addListener=listener=>{
            if(phase==='before-registration'){listener();add(listener);}
            else {add(listener);server.disconnect();}
        };
        expect(bridge.connect(server)).toBe(true);
        expect(server.closed).toBe(true);
        expect(server.onDisconnect.listeners.size).toBe(0);
        expect(server.onMessage.listeners.size).toBe(0);
        expect(repo.openSnapshot).not.toHaveBeenCalled();
        await bridge.dispose();
    });
    it('fails closed if disposal reenters either trust check before acceptance',()=>{
        const {repo}=fixture();
        for(const phase of ['privacy','sender'] as const){
            let bridge:ReturnType<typeof createMaterialPageBridge>;
            bridge=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),
                isPrivateContext:()=>{if(phase==='privacy')bridge.dispose();return false;},
                isTrustedSender:()=>{if(phase==='sender')bridge.dispose();return true;}});
            const [server]=pair();bridge.connect(server);expect(server.closed).toBe(true);bridge.dispose();
        }
        expect(repo.openSnapshot).not.toHaveBeenCalled();
    });
    it('disconnects if disposal reenters the post-readiness privacy check',async()=>{
        const {repo}=fixture();let calls=0,bridge:ReturnType<typeof createMaterialPageBridge>;
        bridge=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),isTrustedSender:()=>true,
            isPrivateContext:()=>{if(++calls===2)bridge.dispose();return false;}});
        const [server,client]=pair();bridge.connect(server);client.postMessage(start());await tick();
        expect(server.closed).toBe(true);expect(repo.openSnapshot).not.toHaveBeenCalled();bridge.dispose();
    });
    it('rejects invalid requests and duplicate starts without opening storage',async()=>{
        for(const request of [null,[],{...start(),v:2},{...start(),type:'other'},start(null as never),start([]),start({unknown:'private'}),
            start({archived:'yes'}),start({topic:123}),start({topic:'x'.repeat(81)}),start({search:123}),start({search:'x'.repeat(128*1024+1)}),
            page('bad',0),page('a'.repeat(64),-1),detail('a'.repeat(64),'',0),detail('a'.repeat(64),'x'.repeat(257),0),
            topics('a'.repeat(64),-1),topics('a'.repeat(64),0,'x'.repeat(128*1024+1)),{...start(),extra:1}]){
            const {bridge,repo}=fixture();const [server,client]=pair();bridge.connect(server);client.postMessage(request);
            expect(server.closed).toBe(true);expect(repo.openSnapshot).not.toHaveBeenCalled();bridge.dispose();
        }
        const {bridge,repo}=fixture();const [server,client]=pair();bridge.connect(server);client.postMessage(start());client.postMessage(start());await tick();
        expect(server.closed).toBe(true);expect(repo.openSnapshot).not.toHaveBeenCalled();bridge.dispose();
    });
    it('enforces bridge limits and rejects failed sender or privacy checks',()=>{
        const {repo}=fixture();
        for(const limits of [{maxSessions:0},{maxSessions:33},{maxPorts:0},{maxPorts:33},{idleTimeoutMs:0},{idleTimeoutMs:Infinity},{sessionTimeoutMs:0},{sessionTimeoutMs:2_147_483_648}])
            expect(()=>createMaterialPageBridge({repository:repo,ready:Promise.resolve(),isPrivateContext:()=>false,isTrustedSender:()=>true,...limits})).toThrow('limits');
        for(const checks of [{isPrivateContext:()=>{throw Error('unavailable');},isTrustedSender:()=>true},
            {isPrivateContext:()=>false,isTrustedSender:()=>{throw Error('unavailable');}}]){
            const bridge=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),...checks}),[server]=pair();bridge.connect(server);
            expect(server.closed).toBe(true);expect(repo.openSnapshot).not.toHaveBeenCalled();bridge.dispose();
        }
    });
    it('cancels readiness and releases its port when the extension becomes unavailable',async()=>{
        const {repo}=fixture(),bridge=createMaterialPageBridge({repository:repo,ready:Promise.reject(Error('private')),isPrivateContext:()=>false,isTrustedSender:()=>true});
        await tick();const [server,client]=pair();bridge.connect(server);client.postMessage(start());await tick();
        expect(server.closed).toBe(true);expect(repo.openSnapshot).not.toHaveBeenCalled();expect(server.sent).toEqual([]);bridge.dispose();
    });
    it.each(['ready','failed'] as const)('settles a request already waiting when readiness becomes %s',async outcome=>{
        const {repo}=fixture();let resolve!:()=>void,reject!:(error:Error)=>void;
        const ready=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
        const bridge=createMaterialPageBridge({repository:repo,ready,isPrivateContext:()=>false,isTrustedSender:()=>true});
        const [server,client]=pair();bridge.connect(server);const chunks:Uint8Array[]=[];
        const reading=receiveMaterialRead(client as MaterialReadPort,bytes=>{chunks.push(bytes);}).catch(error=>error);
        client.postMessage(start());await tick();expect(repo.openSnapshot).not.toHaveBeenCalled();
        if(outcome==='ready')resolve();else reject(Error('settings unavailable'));
        const result=await reading;
        if(outcome==='ready'){
            expect(result).toBeUndefined();expect(repo.openSnapshot).toHaveBeenCalledOnce();
            expect(new TextDecoder().decode(Uint8Array.from(chunks.flatMap(bytes=>[...bytes])))).toContain('"type":"complete"');
        } else {expect(result).toBeInstanceOf(Error);expect(repo.openSnapshot).not.toHaveBeenCalled();}
        await bridge.dispose();
    });
    it('bounds the busy response port, recovers after disconnect and does not double-register',async()=>{
        const {repo}=fixture();const bridge=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),isPrivateContext:()=>false,isTrustedSender:()=>true,maxPorts:1});
        const [first,client]=pair();bridge.connect(first);bridge.connect(first);expect(first.onMessage.listeners.size).toBe(1);
        const [second,secondClient]=pair();bridge.connect(second);expect(second.closed).toBe(false);
        const [overflow]=pair();bridge.connect(overflow);expect(overflow.closed).toBe(true);
        const chunks:Uint8Array[]=[];const read=receiveMaterialRead(secondClient as MaterialReadPort,chunk=>{chunks.push(chunk);});
        secondClient.postMessage(start());await read;
        expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(chunks.flatMap(chunk=>[...chunk]))))).toEqual({type:'error',code:'busy'});
        await tick();
        client.disconnect();const [third]=pair();bridge.connect(third);expect(third.closed).toBe(false);
        bridge.dispose();expect(third.closed).toBe(true);expect(repo.openSnapshot).not.toHaveBeenCalled();
    });
    it('releases listeners when browser context invalidation interrupts registration or cleanup',()=>{
        const {repo}=fixture();
        for(const field of ['onMessage','onDisconnect'] as const){
            const bridge=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),isPrivateContext:()=>false,isTrustedSender:()=>true});
            const [server]=pair();server[field].addListener=()=>{throw Error('extension context invalidated');};
            bridge.connect(server);expect(server.closed).toBe(true);expect(server.onMessage.listeners.size).toBe(0);
            expect(server.onDisconnect.listeners.size).toBe(0);bridge.dispose();
        }
        const bridge=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),isPrivateContext:()=>false,isTrustedSender:()=>true});
        const [server]=pair();bridge.connect(server);server.onMessage.removeListener=()=>{throw Error('extension context invalidated');};
        expect(()=>bridge.dispose()).not.toThrow();expect(server.closed).toBe(true);expect(server.onDisconnect.listeners.size).toBe(0);
    });
    it('continues cleanup when invalidated ports reject disconnect or listener removal',async()=>{
        const {repo}=fixture();
        const invalid=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),isPrivateContext:()=>false,isTrustedSender:()=>false});
        const [untrusted]=pair();untrusted.disconnect=()=>{throw Error('extension context invalidated');};
        expect(invalid.connect(untrusted)).toBe(true);expect(untrusted.onMessage.listeners.size).toBe(0);await invalid.dispose();
        const bridge=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),isPrivateContext:()=>false,isTrustedSender:()=>true,maxPorts:1});
        const [first]=pair(),[busy]=pair(),[overflow]=pair();bridge.connect(first);bridge.connect(busy);
        overflow.disconnect=()=>{throw Error('extension context invalidated');};expect(bridge.connect(overflow)).toBe(true);
        const remove=first.onDisconnect.removeListener.bind(first.onDisconnect);
        first.onDisconnect.removeListener=listener=>{remove(listener);throw Error('extension context invalidated');};
        first.disconnect=()=>{throw Error('extension context invalidated');};
        await bridge.dispose();expect(first.onMessage.listeners.size).toBe(0);expect(first.onDisconnect.listeners.size).toBe(0);
        expect(repo.openSnapshot).not.toHaveBeenCalled();
    });
    it('reports stale data without exposing partial results or private errors',async()=>{
        const {bridge,mutate}=fixture();const first=await transfer(bridge,start());const token=header(first).capability!;await tick();mutate();
        const failure=await transfer(bridge,page(token,0));expect(failure).toEqual([{type:'error',code:'stale-operation'}]);
        expect(JSON.stringify(failure)).not.toContain('private');bridge.dispose();
    });
    it('releases a stale session so the user can immediately rebuild the snapshot',async()=>{
        const {repo,mutate}=fixture();const bridge=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),isPrivateContext:()=>false,isTrustedSender:()=>true,maxSessions:1});
        const first=await transfer(bridge,start()),token=header(first).capability!;await tick();mutate();
        expect(await transfer(bridge,page(token,0))).toEqual([{type:'error',code:'stale-operation'}]);await tick();
        const retry=await transfer(bridge,start());expect(header(retry).revision).toBe(2);expect(complete(retry).count).toBe(2);bridge.dispose();
    });
    it('maps unknown storage failures to a public code and releases the failed open session',async()=>{
        const {repo}=fixture();repo.openSnapshot.mockRejectedValueOnce(Error('private content'));
        const bridge=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),isPrivateContext:()=>false,isTrustedSender:()=>true,maxSessions:1});
        expect(await transfer(bridge,start())).toEqual([{type:'error',code:'storage-error'}]);await tick();
        expect(complete(await transfer(bridge,start())).count).toBe(2);bridge.dispose();
    });
    it('streams detail metadata fieldwise and all references without changing their order',async()=>{
        const {bridge,items}=fixture(1);
        items[0].locator={kind:'text',quote:'source quote'};items[0].aliases=['article:https://old.test/'];
        items[0].references=Array.from({length:25},(_,i)=>({kind:'note',id:String(i),note:`note-${i}`,createdAt:i}));
        const first=await transfer(bridge,start()),token=header(first).capability!;await tick();
        const part=await transfer(bridge,detail(token,'00',0));
        expect(part.find(value=>value.type==='detail-header')).toMatchObject({revision:1,id:'00',total:25,offset:0,nextOffset:24});
        const metadata=Object.fromEntries(part.flatMap(value=>value.type==='metadata'?[[value.key,value.value]]:[]));
        expect(metadata).toMatchObject({id:'00',title:'00',locator:{kind:'text',quote:'source quote'}});
        expect(metadata).not.toHaveProperty('aliases');expect(metadata).not.toHaveProperty('identityKey');
        expect(part.filter(value=>value.type==='reference').map(value=>value.type==='reference'&&value.value.id)).toEqual(items[0].references.slice(0,24).map(value=>value.id));
        expect(complete(part).count).toBe(24);await tick();
        const last=await transfer(bridge,detail(token,'00',24));expect(last.find(value=>value.type==='detail-header')).toMatchObject({offset:24,nextOffset:null});
        expect(last.filter(value=>value.type==='reference')).toMatchObject([{value:{id:'24',note:'note-24'}}]);bridge.dispose();
    });
    it('keeps large detail metadata fields within the line budget and rejects an oversized corrupt summary',async()=>{
        const {bridge,items}=fixture(1),text='\ud800'.repeat(12000),id='a'.repeat(32);
        items[0].kind='document';items[0].source={kind:'document',url:`https://example.test/${'a'.repeat(131000)}`,fingerprint:id};
        items[0].title='h'.repeat(131000);items[0].locator={kind:'document',quote:'q'.repeat(6000),documentReference:{version:1,materialId:id,locator:{version:1,source:text,before:text,after:text}}};
        items[0].references=[{kind:'note',id:'n',note:text}];
        const first=await transfer(bridge,start()),token=header(first).capability!;await tick();
        const result=await transfer(bridge,detail(token,'00',0));
        expect(result.filter(value=>value.type==='metadata').map(value=>new TextEncoder().encode(`${JSON.stringify(value)}\n`).length).every(size=>size<=MATERIAL_PAGE_MAX_LINE_BYTES)).toBe(true);
        expect(result.filter(value=>value.type==='reference')).toMatchObject([{value:{note:text}}]);bridge.dispose();
        const oversized=fixture(1);oversized.items[0].title='x'.repeat(MATERIAL_PAGE_MAX_LINE_BYTES);
        const failure=await transfer(oversized.bridge,start());expect(failure.at(-1)).toEqual({type:'error',code:'limit-exceeded'});
        expect(failure.some(value=>value.type==='complete')).toBe(false);oversized.bridge.dispose();
    });
    it('reports a missing detail and never returns stale references',async()=>{
        const {bridge,mutate}=fixture();const first=await transfer(bridge,start()),token=header(first).capability!;await tick();
        expect(await transfer(bridge,detail(token,'missing',0))).toEqual([{type:'error',code:'not-found'}]);await tick();
        mutate();expect(await transfer(bridge,detail(token,'00',0))).toEqual([{type:'error',code:'stale-operation'}]);bridge.dispose();
    });
    it('rejects detail if another writer changes the revision during framed transfer',async()=>{
        const {bridge,items,mutate}=fixture(1);items[0].references=Array.from({length:24},(_,i)=>({kind:'note',id:String(i),note:'x'.repeat(12000)}));
        const first=await transfer(bridge,start()),token=header(first).capability!;await tick();
        const [server,client]=pair();bridge.connect(server);const chunks:Uint8Array[]=[];let changed=false;
        const read=receiveMaterialRead(client as MaterialReadPort,bytes=>{chunks.push(bytes);if(!changed){changed=true;mutate();}});
        client.postMessage(detail(token,'00',0));await read;
        const data=new TextDecoder().decode(Uint8Array.from(chunks.flatMap(chunk=>[...chunk])));
        const messages=data.trim().split('\n').map(line=>JSON.parse(line));
        expect(messages.some(value=>value.type==='reference')).toBe(true);
        expect(messages.at(-1)).toEqual({type:'error',code:'stale-operation'});
        expect(messages.some(value=>value.type==='complete')).toBe(false);
        expect(server.sent.every(value=>JSON.stringify(value).length<=40*1024)).toBe(true);bridge.dispose();
    });
    it.each(['page','detail','topics'] as const)('does not complete a %s transfer after its session is closed',async operation=>{
        const {bridge,items}=fixture(operation==='topics'?4:1);
        items[0].title='x'.repeat(80_000);
        items[0].references=Array.from({length:24},(_,i)=>({kind:'note',id:String(i),note:'n'.repeat(12_000)}));
        if(operation==='topics')for(let index=0;index<items.length;index++)
            items[index].topics=Array.from({length:25},(_,n)=>`${'汉'.repeat(78)}${String(index*25+n).padStart(2,'0')}`);
        const token=header(await transfer(bridge,start())).capability!;await tick();
        const [server,client]=pair();bridge.connect(server);const chunks:Uint8Array[]=[];
        let closing:Promise<MaterialPageMessage[]>|undefined;
        const read=receiveMaterialRead(client as MaterialReadPort,async bytes=>{
            chunks.push(bytes);
            if(!closing){closing=transfer(bridge,close(token));await tick();}
        });
        client.postMessage(operation==='page'?page(token,0):operation==='detail'?detail(token,'00',0):topics(token,0));
        await read;expect(await closing).toEqual([{type:'closed'}]);
        const output=new TextDecoder().decode(Uint8Array.from(chunks.flatMap(chunk=>[...chunk])));
        const messages:MaterialPageMessage[]=output.trim().split('\n').map(line=>JSON.parse(line));
        expect(messages.at(-1)).toEqual({type:'error',code:'stale-operation'});
        expect(messages.some(value=>value.type==='complete')).toBe(false);
        expect(await transfer(bridge,page(token,0))).toEqual([{type:'error',code:'stale-operation'}]);
        await bridge.dispose();
    });
    it.each(['page','detail'] as const)('stops serializing remaining %s entries when the session closes mid-frame',async operation=>{
        const {bridge,items}=fixture(2);
        if(operation==='page')items[0].title='x'.repeat(80_000);
        else items[0].references=Array.from({length:24},(_,i)=>({kind:'note',id:String(i),note:'n'.repeat(12_000)}));
        const token=header(await transfer(bridge,start())).capability!;await tick();
        const [server,client]=pair();bridge.connect(server);const chunks:Uint8Array[]=[];
        let closing:Promise<MaterialPageMessage[]>|undefined;
        const reading=receiveMaterialRead(client as MaterialReadPort,async chunk=>{
            chunks.push(chunk);
            if(!closing){closing=transfer(bridge,close(token));await tick();}
        });
        client.postMessage(operation==='page'?page(token,0):detail(token,'00',0));
        await reading;expect(await closing).toEqual([{type:'closed'}]);
        const output=new TextDecoder().decode(Uint8Array.from(chunks.flatMap(chunk=>[...chunk])));
        const messages:MaterialPageMessage[]=output.trim().split('\n').map(line=>JSON.parse(line));
        expect(messages.at(-1)).toEqual({type:'error',code:'stale-operation'});
        expect(messages.some(message=>message.type==='complete')).toBe(false);
        await bridge.dispose();
    });
    it.each(['page','detail','topics'] as const)('waits for the final %s revision check after session closure',async operation=>{
        const {bridge,repo,items}=fixture(1);items[0].topics=['alpha'];
        const token=header(await transfer(bridge,start())).capability!;await tick();
        let release!:()=>void,started!:()=>void;
        const held=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
        const original=repo.checkSnapshot.getMockImplementation()!;let calls=0;
        repo.checkSnapshot.mockImplementation(async revision=>{
            if(++calls===(operation==='detail'?2:3)){started();await held;}
            return original(revision);
        });
        const reading=transfer(bridge,operation==='page'?page(token,0):operation==='detail'?detail(token,'00',0):topics(token,0));
        await entered;const closing=transfer(bridge,close(token));await tick();release();
        const [messages,closed]=await Promise.all([reading,closing]);
        expect(closed).toEqual([{type:'closed'}]);expect(messages.at(-1)).toEqual({type:'error',code:'stale-operation'});
        expect(messages.some(message=>message.type==='complete')).toBe(false);
        await bridge.dispose();
    });
    it('does not replace an existing session if random capability generation collides',async()=>{
        const {repo}=fixture(1),bridge=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),isPrivateContext:()=>false,isTrustedSender:()=>true,maxSessions:2});
        const random=vi.spyOn(crypto,'getRandomValues').mockImplementation(value=>{(value as Uint8Array).fill(0);return value;});
        try {
            const token=header(await transfer(bridge,start())).capability!;await tick();
            expect(await transfer(bridge,start())).toEqual([{type:'error',code:'storage-error'}]);await tick();
            expect(complete(await transfer(bridge,page(token,0))).count).toBe(1);
        } finally {random.mockRestore();await bridge.dispose();}
    });
    it('pages every active topic independently of the material search and supports topic search',async()=>{
        const {bridge,items}=fixture(3);items[0].topics=['beta','alpha',''];items[1].topics=['alpha','gamma'];items[2].topics=['hidden'];items[2].archivedAt=1;
        const first=await transfer(bridge,start({search:'no matching material'})),token=header(first).capability!;
        expect(header(first)).toMatchObject({total:2,matched:0});await tick();
        const all=await transfer(bridge,topics(token,0));
        expect(all.find(value=>value.type==='topics-header')).toMatchObject({revision:1,total:4,matched:4,offset:0,nextOffset:null});
        expect(all.filter(value=>value.type==='topic').map(value=>value.type==='topic'&&value.value)).toEqual(['','alpha','beta','gamma']);
        expect(complete(all).count).toBe(4);await tick();
        const found=await transfer(bridge,topics(token,0,'AM'));
        expect(found.find(value=>value.type==='topics-header')).toMatchObject({total:4,matched:1,nextOffset:null});
        expect(found.filter(value=>value.type==='topic')).toEqual([{type:'topic',value:'gamma'}]);bridge.dispose();
    });
    it('keeps the session lease while a closed detail has an unfinished database read',async()=>{
        const {repo}=fixture(1);const bridge=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),isPrivateContext:()=>false,isTrustedSender:()=>true,maxSessions:1});
        const first=await transfer(bridge,start()),token=header(first).capability!;await tick();
        let finish!:(value:MaterialRecord|null)=>void,began!:()=>void;
        const held=new Promise<MaterialRecord|null>(resolve=>{finish=resolve;}),started=new Promise<void>(resolve=>{began=resolve;});
        let seenSignal:AbortSignal|undefined;
        repo.readSnapshotRecord.mockImplementationOnce(async(_revision,_id,signal?:AbortSignal)=>{seenSignal=signal;began();return held;});
        const [server,client]=pair();bridge.connect(server);const chunks:Uint8Array[]=[];
        const reading=receiveMaterialRead(client as MaterialReadPort,bytes=>{chunks.push(bytes);});
        client.postMessage(detail(token,'00',0));await started;
        const closing=transfer(bridge,close(token));await tick();expect(seenSignal?.aborted).toBe(true);
        expect(await transfer(bridge,start())).toEqual([{type:'error',code:'busy'}]);
        finish(item('00'));await reading;expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(chunks.flatMap(chunk=>[...chunk]))))).toEqual({type:'error',code:'stale-operation'});
        expect(await closing).toEqual([{type:'closed'}]);
        await tick();expect(complete(await transfer(bridge,start())).count).toBe(1);bridge.dispose();
    });
    it('does not deliver a detail if the request disconnects just after its snapshot check',async()=>{
        const {bridge,repo}=fixture(1),token=header(await transfer(bridge,start())).capability!;await tick();
        let release!:()=>void,started!:()=>void;
        const held=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
        repo.checkSnapshot.mockImplementationOnce(()=>{started();return held;});
        const [server,client]=pair();bridge.connect(server);const chunks:Uint8Array[]=[];
        const reading=receiveMaterialRead(client as MaterialReadPort,chunk=>{chunks.push(chunk);}).catch(error=>error);
        client.postMessage(detail(token,'00',0));await entered;
        held.then(()=>client.disconnect());release();expect(await reading).toBeInstanceOf(Error);
        await tick();await tick();expect(chunks).toEqual([]);
        expect(complete(await transfer(bridge,start())).count).toBe(1);await bridge.dispose();
    });
    it('distinguishes a busy session from a permanent repository limit',async()=>{
        const {bridge,repo}=fixture(1),token=header(await transfer(bridge,start())).capability!;await tick();
        let finish!:(value:MaterialRecord|null)=>void,began!:()=>void;
        const held=new Promise<MaterialRecord|null>(resolve=>{finish=resolve;}),started=new Promise<void>(resolve=>{began=resolve;});
        repo.readSnapshotRecord.mockImplementationOnce(async()=>{began();return held;});
        const reading=transfer(bridge,detail(token,'00',0));await started;
        expect(await transfer(bridge,topics(token,0))).toEqual([{type:'error',code:'busy'}]);
        finish(item('00'));expect(complete(await reading).count).toBe(0);await tick();
        repo.readSnapshotRecord.mockRejectedValueOnce(new MaterialError('limit-exceeded','private detail'));
        expect(await transfer(bridge,detail(token,'00',0))).toEqual([{type:'error',code:'limit-exceeded'}]);
        await bridge.dispose();
    });
    it('releases an open session when a stale error occurs after a page was prepared',async()=>{
        const {repo}=fixture();let calls=0;
        repo.checkSnapshot.mockImplementation(async()=>{if(++calls===4)throw new MaterialError('stale-operation','private');});
        const bridge=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),isPrivateContext:()=>false,isTrustedSender:()=>true,maxSessions:1});
        const first=await transfer(bridge,start());expect(first.at(-1)).toEqual({type:'error',code:'stale-operation'});expect(first.some(value=>value.type==='complete')).toBe(false);
        await tick();const retry=await transfer(bridge,start());expect(complete(retry).count).toBe(2);bridge.dispose();
    });
    it('replaces the least recently used idle session while preserving bounded capacity',async()=>{
        const {repo}=fixture();const bridge=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),isPrivateContext:()=>false,isTrustedSender:()=>true,maxSessions:1});
        const first=await transfer(bridge,start());await tick();const second=await transfer(bridge,start());expect(complete(second).count).toBe(2);
        expect(await transfer(bridge,page(header(first).capability!,0))).toEqual([{type:'error',code:'stale-operation'}]);
        await transfer(bridge,close(header(second).capability!));await tick();expect(complete(await transfer(bridge,start())).count).toBe(2);bridge.dispose();
    });
    it('releases an evicted session if its replacement disconnects while eviction settles',async()=>{
        const {repo}=fixture(1);let replacement:Port|undefined,evicted=0;
        repo.openSnapshot.mockImplementationOnce(async(signal?:AbortSignal)=>{
            signal?.addEventListener('abort',()=>{evicted++;replacement?.disconnect();},{once:true});
            return {revision:1,ids:['00']};
        });
        const bridge=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),isPrivateContext:()=>false,isTrustedSender:()=>true,maxSessions:1});
        expect(complete(await transfer(bridge,start())).count).toBe(1);await tick();
        const [server,client]=pair();replacement=client;bridge.connect(server);
        const receiving=receiveMaterialRead(client as MaterialReadPort,()=>{}).catch(error=>error);
        client.postMessage(start());expect(await receiving).toBeInstanceOf(Error);
        await tick();await tick();expect(evicted).toBe(1);expect(repo.openSnapshot).toHaveBeenCalledTimes(1);
        replacement=undefined;expect(complete(await transfer(bridge,start())).count).toBe(1);await bridge.dispose();
    });
    it('evicts the least recently used idle tab and preserves the recently used one',async()=>{
        const {repo}=fixture();const bridge=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),isPrivateContext:()=>false,isTrustedSender:()=>true,maxSessions:2});
        const first=header(await transfer(bridge,start())).capability!;await tick();
        const second=header(await transfer(bridge,start())).capability!;await tick();
        expect(complete(await transfer(bridge,page(first,0))).count).toBe(2);await tick();
        const third=header(await transfer(bridge,start())).capability!;await tick();
        expect(await transfer(bridge,page(second,0))).toEqual([{type:'error',code:'stale-operation'}]);
        expect(complete(await transfer(bridge,page(first,0))).count).toBe(2);await tick();
        expect(complete(await transfer(bridge,page(third,0))).count).toBe(2);bridge.dispose();
    });
    it('never evicts a disconnected tab until its actual late detail read has settled',async()=>{
        const {repo}=fixture(1);const bridge=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),isPrivateContext:()=>false,isTrustedSender:()=>true,maxSessions:1});
        const token=header(await transfer(bridge,start())).capability!;await tick();
        let finish!:(value:MaterialRecord|null)=>void,began!:()=>void;
        const held=new Promise<MaterialRecord|null>(resolve=>{finish=resolve;}),started=new Promise<void>(resolve=>{began=resolve;});
        repo.readSnapshotRecord.mockImplementationOnce(async()=>{began();return held;});
        const [server,client]=pair();bridge.connect(server);const read=receiveMaterialRead(client as MaterialReadPort,()=>{}).catch(error=>error);
        client.postMessage(detail(token,'00',0));await started;
        expect(await transfer(bridge,start())).toEqual([{type:'error',code:'busy'}]);
        client.disconnect();expect(await read).toBeInstanceOf(Error);
        expect(await transfer(bridge,start())).toEqual([{type:'error',code:'busy'}]);
        finish(item('00'));await tick();await tick();
        expect(complete(await transfer(bridge,start())).count).toBe(1);
        expect(await transfer(bridge,page(token,0))).toEqual([{type:'error',code:'stale-operation'}]);bridge.dispose();
    });
    it('closes an unacknowledged open rather than retaining its capability',async()=>{
        const {repo}=fixture();const bridge=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),isPrivateContext:()=>false,isTrustedSender:()=>true,maxSessions:1});
        const [server,client]=pair();bridge.connect(server);let received!:()=>void;const frame=new Promise<void>(resolve=>{received=resolve;});
        client.onMessage.addListener(()=>received());client.postMessage(start());await frame;client.disconnect();await tick();await tick();
        expect(complete(await transfer(bridge,start())).count).toBe(2);bridge.dispose();
    });
    it('reports actual scan progress and retains capacity until a cancelled underlying read settles',async()=>{
        const {repo}=fixture();let finish!:(value:MaterialRecord|null)=>void,began!:()=>void,progress!:()=>void;
        const held=new Promise<MaterialRecord|null>(resolve=>{finish=resolve;}),started=new Promise<void>(resolve=>{began=resolve;});
        const observed=new Promise<void>(resolve=>{progress=resolve;});
        const original=repo.readSnapshotRecord.getMockImplementation()!;let calls=0;
        repo.readSnapshotRecord.mockImplementation(async(revision,id)=>{if(++calls===2){began();return held;}return original(revision,id);});
        const bridge=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),isPrivateContext:()=>false,isTrustedSender:()=>true,maxSessions:1});
        const [server,client]=pair();bridge.connect(server);const chunks:Uint8Array[]=[];
        const read=receiveMaterialRead(client as MaterialReadPort,bytes=>{chunks.push(bytes);progress();}).catch(error=>error);
        client.postMessage(start());await started;await observed;
        const bytes=Uint8Array.from(chunks.flatMap(chunk=>[...chunk]));
        expect(new TextDecoder().decode(bytes)).toContain('"type":"progress","processed":1,"total":2');
        client.disconnect();expect(await read).toBeInstanceOf(Error);
        expect(await transfer(bridge,start())).toEqual([{type:'error',code:'busy'}]);
        finish(item('01'));await tick();await tick();
        expect(complete(await transfer(bridge,start())).count).toBe(2);bridge.dispose();
    });
    it('waits for an uncooperative database read before resolving bridge disposal',async()=>{
        const {repo}=fixture();let finish!:(snapshot:{revision:number;ids:string[]})=>void,began!:()=>void;
        const held=new Promise<{revision:number;ids:string[]}>(resolve=>{finish=resolve;}),started=new Promise<void>(resolve=>{began=resolve;});
        repo.openSnapshot.mockImplementationOnce(async()=>{began();return held;});
        const bridge=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),isPrivateContext:()=>false,isTrustedSender:()=>true});
        const [server,client]=pair();bridge.connect(server);const read=receiveMaterialRead(client as MaterialReadPort,()=>{}).catch(error=>error);
        client.postMessage(start());await started;let drained=false;
        const disposal=bridge.dispose().then(()=>{drained=true;});const repeated=bridge.dispose();
        expect(await read).toBeInstanceOf(Error);await tick();expect(drained).toBe(false);
        const [blocked]=pair();bridge.connect(blocked);expect(blocked.closed).toBe(true);
        finish({revision:1,ids:[]});await Promise.all([disposal,repeated]);expect(drained).toBe(true);
    });
    it('shares a single disposal promise if port disconnection synchronously reenters disposal',async()=>{
        const {bridge}=fixture(),[server]=pair();bridge.connect(server);const disconnect=server.disconnect.bind(server);
        let nested:Promise<void>|undefined;server.disconnect=()=>{nested=bridge.dispose();disconnect();};
        const disposal=bridge.dispose();expect(nested).toBe(disposal);await disposal;expect(server.closed).toBe(true);
    });
    it('flushes the latest actual progress after a rapid update even if the next record stalls',async()=>{
        const {repo}=fixture(3);let finishSecond!:(value:MaterialRecord|null)=>void,finishThird!:(value:MaterialRecord|null)=>void;
        const second=new Promise<MaterialRecord|null>(resolve=>{finishSecond=resolve;}),third=new Promise<MaterialRecord|null>(resolve=>{finishThird=resolve;});
        const original=repo.readSnapshotRecord.getMockImplementation()!;let calls=0;
        repo.readSnapshotRecord.mockImplementation(async(revision,id)=>{calls++;if(calls===2)return second;if(calls===3)return third;return original(revision,id);});
        const bridge=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),isPrivateContext:()=>false,isTrustedSender:()=>true});
        const [server,client]=pair();bridge.connect(server);let first!:()=>void,next!:()=>void;
        const firstProgress=new Promise<void>(resolve=>{first=resolve;}),secondProgress=new Promise<void>(resolve=>{next=resolve;});
        const chunks:Uint8Array[]=[];
        const read=receiveMaterialRead(client as MaterialReadPort,bytes=>{
            chunks.push(bytes);const text=new TextDecoder().decode(bytes);
            if(text.includes('"processed":1'))first();if(text.includes('"processed":2'))next();
        });
        client.postMessage(start());await firstProgress;finishSecond(item('01'));
        let timeout:ReturnType<typeof setTimeout>|undefined;
        try{await Promise.race([secondProgress,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(Error('missing progress')),1500);})]);}
        finally{if(timeout!==undefined)clearTimeout(timeout);}
        finishThird(item('02'));await read;
        const output=new TextDecoder().decode(Uint8Array.from(chunks.flatMap(chunk=>[...chunk])));
        expect(output).toContain('"type":"complete"');bridge.dispose();
    });
    it('cancels a coalesced progress update without releasing the unfinished scan',async()=>{
        const {repo}=fixture(3);let finishSecond!:(value:MaterialRecord|null)=>void,finishThird!:(value:MaterialRecord|null)=>void,beginThird!:()=>void;
        const second=new Promise<MaterialRecord|null>(resolve=>{finishSecond=resolve;}),third=new Promise<MaterialRecord|null>(resolve=>{finishThird=resolve;});
        const thirdStarted=new Promise<void>(resolve=>{beginThird=resolve;});
        const original=repo.readSnapshotRecord.getMockImplementation()!;let calls=0;
        repo.readSnapshotRecord.mockImplementation(async(revision,id)=>{
            calls++;if(calls===2)return second;if(calls===3){beginThird();return third;}return original(revision,id);
        });
        const bridge=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),isPrivateContext:()=>false,isTrustedSender:()=>true,maxSessions:1});
        const [server,client]=pair();bridge.connect(server);let first!:()=>void;
        const firstProgress=new Promise<void>(resolve=>{first=resolve;}),chunks:Uint8Array[]=[];
        const reading=receiveMaterialRead(client as MaterialReadPort,bytes=>{chunks.push(bytes);first();}).catch(error=>error);
        client.postMessage(start());await firstProgress;finishSecond(item('01'));await thirdStarted;
        client.disconnect();expect(await reading).toBeInstanceOf(Error);
        expect(await transfer(bridge,start())).toEqual([{type:'error',code:'busy'}]);
        finishThird(item('02'));await tick();await tick();
        const output=new TextDecoder().decode(Uint8Array.from(chunks.flatMap(chunk=>[...chunk])));
        expect(output).toContain('"processed":1');expect(output).not.toContain('"processed":2');
        expect(complete(await transfer(bridge,start())).count).toBe(3);await bridge.dispose();
    });
    it('does not keep an idle connection alive with fabricated progress while readiness is pending',async()=>{
        const {repo}=fixture();const bridge=createMaterialPageBridge({repository:repo,ready:new Promise(()=>{}),isPrivateContext:()=>false,isTrustedSender:()=>true,idleTimeoutMs:15});
        const [server,client]=pair();bridge.connect(server);const read=receiveMaterialRead(client as MaterialReadPort,()=>{}).catch(error=>error);
        client.postMessage(start());expect(await read).toBeInstanceOf(Error);expect(repo.openSnapshot).not.toHaveBeenCalled();
        expect(server.sent).toEqual([]);bridge.dispose();
    });
    it('expires idle sessions and permits new work',async()=>{
        const {repo}=fixture();const bridge=createMaterialPageBridge({repository:repo,ready:Promise.resolve(),isPrivateContext:()=>false,isTrustedSender:()=>true,maxSessions:1,sessionTimeoutMs:10});
        const first=await transfer(bridge,start());await new Promise(resolve=>setTimeout(resolve,30));
        expect(await transfer(bridge,page(header(first).capability!,0))).toEqual([{type:'error',code:'stale-operation'}]);
        expect(complete(await transfer(bridge,start())).count).toBe(2);bridge.dispose();
    });
});
