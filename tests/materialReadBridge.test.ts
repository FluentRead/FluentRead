import {describe, expect, it, vi} from 'vitest';
import {createMaterialReadBridge, type MaterialReadBridgePort} from '@/src/features/vocabulary/materialReadBridge';
import {MATERIAL_READ_PORT_NAME, receiveMaterialRead, type MaterialReadPort} from '@/src/features/vocabulary/materialReadTransport';
import {isTrustedSettingsSender} from '@/src/app/background/handlers/trustedSettingsSender';
import type {MaterialRecord} from '@/src/features/vocabulary/materialProtocol';
import {MaterialError} from '@/src/features/vocabulary/materialModel';
import {decodeMaterialSummaries} from '@/src/features/vocabulary/materialReadDecoder';

type Fn = (...args: any[]) => void;
class EventSet<T extends Fn> {
    listeners = new Set<T>();
    addListener(fn:T) {this.listeners.add(fn);}
    removeListener(fn:T) {this.listeners.delete(fn);}
    fire(...args:Parameters<T>) {for (const fn of [...this.listeners]) fn(...args);}
}
class Port {
    name = MATERIAL_READ_PORT_NAME;
    sender: MaterialReadBridgePort['sender'] = {id:'abc',url:'chrome-extension://abc/options.html?x=1#tab'};
    onMessage = new EventSet<(message:unknown)=>void>();
    onDisconnect = new EventSet<()=>void>();
    peer!: Port;
    closed = false;
    sent:unknown[] = [];
    postMessage(message:unknown) {if (this.closed) throw Error('closed'); this.sent.push(message); this.peer.onMessage.fire(message);}
    disconnect() {if (this.closed) return; this.closed = true; this.peer.closed = true; this.onDisconnect.fire(); this.peer.onDisconnect.fire();}
}
function pair() {const a = new Port(), b = new Port(); a.peer = b; b.peer = a; return [a, b] as const;}
const start = (options:unknown = {}) => ({v:1,type:'start',operation:'summaries',options});
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function record(): MaterialRecord {return {id:'m',identityKey:'secret-identity',kind:'article',title:'private title',
    source:{kind:'article'},topics:['topic'],references:[],createdAt:1,updatedAt:2,lastReadAt:3,archivedAt:null};}
function setup(overrides: Partial<Parameters<typeof createMaterialReadBridge>[0]> = {}) {
    const repo = {openSnapshot:vi.fn(async () => ({revision:1,ids:['m']})),
        readSnapshotRecord:vi.fn(async () => record()), checkSnapshot:vi.fn(async () => {})};
    return {repo, bridge:createMaterialReadBridge({repository:repo,ready:Promise.resolve(),
        isTrustedSender:sender => isTrustedSettingsSender(sender, 'abc', 'chrome-extension://abc/options.html'),
        isPrivateContext:() => false, ...overrides})};
}

describe('material read bridge', () => {
    it('ignores unrelated ports, rejects untrusted or private senders, and never reads their data', async () => {
        const {repo,bridge} = setup();
        const wrong = pair()[0]; wrong.name = 'different'; expect(bridge.connect(wrong)).toBe(false); expect(wrong.closed).toBe(false);
        for (const sender of [undefined, {id:'evil',url:'chrome-extension://abc/options.html'},
            {id:'abc',url:'https://example.test/options.html'}, {id:'abc',url:'chrome-extension://abc/popup.html'},
            {id:'abc',url:'chrome-extension://abc/options.html',incognito:true},
            {id:'abc',url:'chrome-extension://abc/options.html',tab:{incognito:true}}]) {
            const [server] = pair(); server.sender = sender; expect(bridge.connect(server)).toBe(true); expect(server.closed).toBe(true);
        }
        const privateBridge = setup({isPrivateContext:() => true}).bridge, [privatePort] = pair();
        privateBridge.connect(privatePort); expect(privatePort.closed).toBe(true);
        expect(repo.openSnapshot).not.toHaveBeenCalled(); bridge.dispose(); privateBridge.dispose();
    });
    it('sends nothing before receiver start or before ready, then performs the actual framed transfer', async () => {
        let release!: () => void; const ready = new Promise<void>(resolve => {release = resolve;});
        const {repo,bridge} = setup({ready}), [server,client] = pair(); bridge.connect(server);
        await tick(); expect(server.sent).toEqual([]); expect(repo.openSnapshot).not.toHaveBeenCalled();
        const chunks:Uint8Array[] = [];
        const reading = receiveMaterialRead(client as MaterialReadPort, chunk => {chunks.push(chunk);});
        client.postMessage(start()); await tick(); expect(server.sent).toEqual([]); expect(repo.openSnapshot).not.toHaveBeenCalled();
        release(); await reading;
        const messages = new TextDecoder().decode(Uint8Array.from(chunks.flatMap(chunk => [...chunk]))).trim().split('\n').map(line => JSON.parse(line));
        expect(messages.map(item => item.type)).toEqual(['header','topic','summary','complete']);
        expect(messages.at(-1)).toEqual({type:'complete',count:1,total:1,topicCount:1});
        expect(repo.openSnapshot).toHaveBeenCalledOnce(); bridge.dispose();
    });
    it('rejects malformed, extra, and oversized starts without leaking the request or reading', async () => {
        for (const request of [null, [], start(null), start([]), start({search:'x'.repeat(128*1024+1)}), start({search:12}),
            start({topic:'x'.repeat(81)}), start({topic:42}), start({extra:'secret'}),
            {...start(), extra:'private'}, {...start(),v:2}, {...start(),type:'wrong'}, {...start(),operation:'wrong'}, start({archived:'yes'})]) {
            const {repo,bridge} = setup(), [server,client] = pair(); bridge.connect(server); client.postMessage(request);
            await tick(); expect(server.closed).toBe(true); expect(server.sent).toEqual([]); expect(repo.openSnapshot).not.toHaveBeenCalled(); bridge.dispose();
        }
    });
    it('validates limits and refuses access if trusted-context checks fail', () => {
        for (const extra of [{maxPorts:0},{maxPorts:33},{maxPorts:1.5},{idleTimeoutMs:0},{idleTimeoutMs:Infinity},{idleTimeoutMs:2_147_483_648}])
            expect(()=>setup(extra)).toThrow('limits');
        for (const extra of [{isPrivateContext:()=>{throw Error('context unavailable');}}, {isTrustedSender:()=>{throw Error('sender unavailable');}}]) {
            const {repo,bridge}=setup(extra), [server]=pair();
            expect(bridge.connect(server)).toBe(true); expect(server.closed).toBe(true); expect(repo.openSnapshot).not.toHaveBeenCalled(); bridge.dispose();
        }
    });
    it('rechecks privacy after readiness and fails closed without opening storage', async () => {
        let release!:()=>void, privateContext = false;
        const ready = new Promise<void>(resolve=>{release=resolve;});
        const {repo,bridge} = setup({ready,isPrivateContext:()=>privateContext}), [server,client]=pair();
        bridge.connect(server); client.postMessage(start());
        privateContext=true; release(); await tick();
        expect(server.closed).toBe(true); expect(repo.openSnapshot).not.toHaveBeenCalled(); expect(server.sent).toEqual([]);
        bridge.dispose();
    });
    it('does not register a port twice or leave listeners after synchronous disconnect', () => {
        const {bridge} = setup({maxPorts:1});
        const [server] = pair();
        bridge.connect(server); bridge.connect(server);
        expect(server.onMessage.listeners.size).toBe(1);
        expect(server.onDisconnect.listeners.size).toBe(1);
        bridge.dispose();
        expect(server.onMessage.listeners.size).toBe(0);
        expect(server.onDisconnect.listeners.size).toBe(0);
        const next = setup(), [racing] = pair();
        const attach = racing.onDisconnect.addListener.bind(racing.onDisconnect);
        racing.onDisconnect.addListener = fn => {attach(fn); racing.disconnect();};
        next.bridge.connect(racing);
        expect(racing.onMessage.listeners.size).toBe(0);
        expect(racing.onDisconnect.listeners.size).toBe(0);
        next.bridge.dispose();
    });
    it('closes the connection if event registration fails after context invalidation', () => {
        for (const event of ['onMessage','onDisconnect'] as const) {
            const {repo,bridge}=setup(), [server]=pair();
            server[event].addListener=()=>{throw Error('extension context invalidated');};
            expect(bridge.connect(server)).toBe(true); expect(server.closed).toBe(true);
            expect(server.onMessage.listeners.size).toBe(0); expect(server.onDisconnect.listeners.size).toBe(0);
            expect(repo.openSnapshot).not.toHaveBeenCalled(); bridge.dispose();
        }
    });
    it('continues disconnect cleanup if removing one listener throws', () => {
        for (const event of ['onMessage','onDisconnect'] as const) {
            const {bridge}=setup(), [server]=pair(); bridge.connect(server);
            server[event].removeListener=()=>{throw Error('extension context invalidated');};
            expect(()=>bridge.dispose()).not.toThrow(); expect(server.closed).toBe(true);
            const other=event==='onMessage'?'onDisconnect':'onMessage';
            expect(server[other].listeners.size).toBe(0);
        }
    });
    it('tolerates a disconnected browser context during rejection and disposal', () => {
        const first=setup(), [untrusted]=pair();
        untrusted.sender={id:'wrong',url:'chrome-extension://abc/options.html'};
        untrusted.disconnect=()=>{throw Error('extension context invalidated');};
        expect(()=>first.bridge.connect(untrusted)).not.toThrow(); expect(first.repo.openSnapshot).not.toHaveBeenCalled(); first.bridge.dispose();
        const second=setup(), [active]=pair(); second.bridge.connect(active);
        active.disconnect=()=>{throw Error('extension context invalidated');};
        expect(()=>second.bridge.dispose()).not.toThrow(); expect(active.onMessage.listeners.size).toBe(0);
        expect(active.onDisconnect.listeners.size).toBe(0); expect(second.repo.openSnapshot).not.toHaveBeenCalled();
    });
    it('closes duplicated handshakes, cancels pending ready, and times out silent ports', async () => {
        const ready = new Promise<void>(() => {}), {repo,bridge} = setup({ready,idleTimeoutMs:20,maxPorts:1});
        const [server,client] = pair(); bridge.connect(server); client.postMessage(start()); client.postMessage(start());
        await tick(); expect(server.closed).toBe(true); expect(repo.openSnapshot).not.toHaveBeenCalled();
        const [silent] = pair(); bridge.connect(silent); await new Promise(resolve => setTimeout(resolve, 40)); expect(silent.closed).toBe(true);
        bridge.dispose();
    });
    it('removes a cancelled readiness waiter and does not reopen it when readiness resolves', async () => {
        let release!:()=>void;
        const ready = new Promise<void>(resolve=>{release=resolve;});
        const {repo,bridge}=setup({ready,maxPorts:1}), [server,client]=pair();
        bridge.connect(server); client.postMessage(start()); client.disconnect();
        await tick(); release(); await tick();
        expect(repo.openSnapshot).not.toHaveBeenCalled();
        const [next]=pair(); bridge.connect(next); expect(next.closed).toBe(false);
        bridge.dispose(); bridge.dispose();
        const [after]=pair(); bridge.connect(after); expect(after.closed).toBe(true);
    });
    it('allows another authorized read to finish while one connection waits on storage', async () => {
        let finish!:(snapshot:{revision:number;ids:string[]})=>void, began!:()=>void;
        const pending = new Promise<{revision:number;ids:string[]}>(resolve=>{finish=resolve;}), started = new Promise<void>(resolve=>{began=resolve;});
        let calls=0;
        const repo={openSnapshot:vi.fn(()=>++calls===1?(began(),pending):Promise.resolve({revision:1,ids:[]})),
            readSnapshotRecord:vi.fn(async()=>null),checkSnapshot:vi.fn(async()=>{})};
        const {bridge}=setup({repository:repo,maxPorts:2}), [first,client1]=pair(), [second,client2]=pair();
        bridge.connect(first); bridge.connect(second);
        const firstRead=receiveMaterialRead(client1 as MaterialReadPort,()=>{}).then(()=>undefined,error=>error);
        const secondChunks:Uint8Array[]=[];
        const secondRead=receiveMaterialRead(client2 as MaterialReadPort,chunk=>{secondChunks.push(chunk);});
        client1.postMessage(start()); await started; client2.postMessage(start()); await secondRead;
        expect(repo.openSnapshot).toHaveBeenCalledTimes(2);
        expect(new TextDecoder().decode(Uint8Array.from(secondChunks.flatMap(chunk=>[...chunk])))).toContain('"type":"complete"');
        client1.disconnect(); expect(await firstRead).toBeInstanceOf(Error); finish({revision:1,ids:[]}); await tick(); bridge.dispose();
    });
    it('keeps its capacity lease until an uncooperative underlying read really finishes', async () => {
        let complete!: (snapshot:{revision:number;ids:string[]}) => void;
        let began!: () => void; const started = new Promise<void>(resolve => {began = resolve;});
        const pending = new Promise<{revision:number;ids:string[]}>(resolve => {complete = resolve;});
        const repo = {openSnapshot:vi.fn(() => {began(); return pending;}), readSnapshotRecord:vi.fn(async () => null), checkSnapshot:vi.fn(async () => {})};
        const {bridge} = setup({repository:repo,maxPorts:1});
        const [server,client] = pair(); bridge.connect(server);
        const read = receiveMaterialRead(client as MaterialReadPort, () => {}); client.postMessage(start());
        await started; client.disconnect(); await expect(read).rejects.toThrow();
        const [blocked] = pair(); bridge.connect(blocked); expect(blocked.closed).toBe(true);
        complete({revision:1,ids:[]}); await tick(); await tick();
        const [allowed] = pair(); bridge.connect(allowed); expect(allowed.closed).toBe(false);
        bridge.dispose();
    });
    it.each(['ack','disconnect'] as const)('releases the lease after a prefetched read fails while %s is delayed', async outcome => {
        let rejectRead!:(error:Error)=>void, markAck!:()=>void, releaseAck:(()=>void)|undefined;
        const pending = new Promise<MaterialRecord|null>((_resolve,reject) => {rejectRead = reject;});
        const ackReady = new Promise<void>(resolve => {markAck = resolve;});
        const repo = {openSnapshot:async () => ({revision:1,ids:['m']}), readSnapshotRecord:() => pending, checkSnapshot:async () => {}};
        const {bridge} = setup({repository:repo,maxPorts:1}), [server,client] = pair(); bridge.connect(server);
        const original = client.postMessage.bind(client);
        client.postMessage = message => {
            if ((message as {type?:string}).type === 'ack' && !releaseAck) {releaseAck = () => original(message); markAck();}
            else original(message);
        };
        const chunks:Uint8Array[] = [];
        const read = receiveMaterialRead(client as MaterialReadPort, chunk => {chunks.push(chunk);});
        const outcomePromise = read.then(() => undefined, error => error);
        client.postMessage(start()); await ackReady;
        expect(new TextDecoder().decode(chunks[0])).toContain('"type":"header"');
        if (outcome === 'disconnect') {
            client.disconnect(); expect(await outcomePromise).toBeInstanceOf(Error);
            const [blocked] = pair(); bridge.connect(blocked); expect(blocked.closed).toBe(true);
        }
        rejectRead(Error('private prefetch failure')); await tick();
        if (outcome === 'ack') {
            const [blocked] = pair(); bridge.connect(blocked); expect(blocked.closed).toBe(true);
            releaseAck!(); expect(await outcomePromise).toBeUndefined();
            const body = new TextDecoder().decode(Uint8Array.from(chunks.flatMap(chunk => [...chunk])));
            expect(body).toContain('"type":"error","code":"storage-error"');
            expect(body).not.toContain('private prefetch failure');
            expect(body).not.toContain('"type":"complete"');
        }
        await tick(); await tick();
        const [allowed] = pair(); bridge.connect(allowed); expect(allowed.closed).toBe(false);
        bridge.dispose();
    });
    it('disconnects on readiness failure and disposal without exposing private error text', async () => {
        const {bridge} = setup({ready:Promise.reject(Error('private data'))});
        const [server,client] = pair(); bridge.connect(server); client.postMessage(start()); await tick();
        expect(server.closed).toBe(true); expect(server.sent).toEqual([]);
        const next = setup(), [waiting] = pair(); next.bridge.connect(waiting); next.bridge.dispose();
        expect(waiting.closed).toBe(true); bridge.dispose();
    });
    it('rejects a handshake when the readiness gate had already failed', async () => {
        const {repo,bridge}=setup({ready:Promise.reject(Error('private data'))});
        await tick(); const [server,client]=pair(); bridge.connect(server); client.postMessage(start()); await tick();
        expect(server.closed).toBe(true); expect(server.sent).toEqual([]); expect(repo.openSnapshot).not.toHaveBeenCalled(); bridge.dispose();
    });
    it('does not forward repository errors or accept partial data as complete', async () => {
        const repo = {openSnapshot:async () => ({revision:1,ids:['m']}),
            readSnapshotRecord:async () => {throw Error('private text from storage');}, checkSnapshot:async () => {}};
        const {bridge} = setup({repository:repo}), [server,client] = pair(); bridge.connect(server);
        const chunks:Uint8Array[] = [];
        const read = receiveMaterialRead(client as MaterialReadPort, chunk => {chunks.push(chunk);});
        client.postMessage(start());
        await read;
        expect(JSON.stringify(server.sent)).not.toContain('private text from storage');
        const received = new TextDecoder().decode(Uint8Array.from(chunks.flatMap(chunk => [...chunk])));
        expect(received).not.toContain('private text from storage'); expect(received).not.toContain('"type":"complete"');
        expect(received).toContain('"type":"error","code":"storage-error"');
        bridge.dispose();
    });
    it('delivers safe stale and storage categories through verified frames without partial results', async () => {
        for (const code of ['stale-operation','storage-error'] as const) {
            const repo = {openSnapshot:async()=>({revision:1,ids:['m']}),
                readSnapshotRecord:async()=>{throw new MaterialError(code,'private data');},checkSnapshot:async()=>{}};
            const {bridge} = setup({repository:repo}), [server,client] = pair(); bridge.connect(server);
            const result = decodeMaterialSummaries((onChunk,signal)=>receiveMaterialRead(client as MaterialReadPort,onChunk,{signal}));
            client.postMessage(start());
            await expect(result).rejects.toMatchObject({code,message:'材料读取失败'});
            expect(JSON.stringify(server.sent)).not.toContain('private data');
            bridge.dispose();
        }
    });
});
