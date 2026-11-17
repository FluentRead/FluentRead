import 'fake-indexeddb/auto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createRequire} from 'node:module';
import {DictionaryRepository} from '@/src/platform/storage/dictionaryRepository';
import {setRuntimeFetch} from '@/src/platform/http/runtime';
import {defaultDictionaryWorkspace, EMPTY_DICTIONARY_FIELDS, type DictionaryRecipe} from '@/src/core/config/dictionaryWorkspace';
import {lookupDictionaryRecipe, readDictionaryJson} from '@/src/features/selection-translation/dictionary/service';
import {sendDictionaryCardToAnki} from '@/src/features/selection-translation/dictionary/anki';
import {createDictionaryCardHandler} from '@/src/features/selection-translation/background/dictionaryCardHandler';
import {runDictionaryScript} from '@/src/features/selection-translation/dictionary/script';
const require = createRequire(import.meta.url);
vi.mock('@jitl/quickjs-wasmfile-release-sync/wasm?url', async () => {
    const {createRequire} = await import('node:module');
    return {default: createRequire(import.meta.url).resolve('@jitl/quickjs-wasmfile-release-sync/wasm')};
});
void require;
let sequence = 0;
const recipe = (extra: Partial<DictionaryRecipe> = {}): DictionaryRecipe => ({id: `runtime-${++sequence}`, name: 'Runtime', kind: 'json', url: 'https://api.example.com/{{word}}', fields: {...EMPTY_DICTIONARY_FIELDS,definition:'definition'}, headers: {}, script: '', localId: '', ...extra});
afterEach(() => {setRuntimeFetch();vi.useRealTimers();});
describe('dictionary runtime boundaries', () => {
    it('indexes on-device words, preserves multiple senses and atomically removes data', async () => {
        const db = new DictionaryRepository(`fixture-${crypto.randomUUID()}`);
        const dictionary = {name:'Local',format:'DSL',css:'b{color:navy}',resources:[{path:'a.png',bytes:new Uint8Array([1])}],entries:[{key:'curious',word:'curious',html:'<b>eager</b>',definition:'eager',phonetic:''},{key:'curious',word:'Curious',html:'interested',definition:'interested',phonetic:'test'}]};
        try {
            await db.install('a',dictionary);expect((await db.lookup('a','curious')).entries).toHaveLength(2);
            expect((await db.lookup('a','absent')).entries).toEqual([]);
            await expect(db.lookup('missing','word')).rejects.toThrow('not installed');
            await db.install('a',{...dictionary,entries:[dictionary.entries[0]]});expect(await db.entries.count()).toBe(1);expect(await db.resources.count()).toBe(1);
            await db.remove('a');expect(await db.entries.count()).toBe(0);expect(await db.resources.count()).toBe(0);expect(await db.dictionaries.count()).toBe(0);
        } finally {await db.delete();}
    });
    it('coalesces concurrent requests, isolates source settings and returns independent cached cards', async () => {
        let resolve!: (response: Response) => void;
        const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(yes => {resolve=yes;}));setRuntimeFetch(fetch);
        const source=recipe();const first=lookupDictionaryRecipe('Curious',source),second=lookupDictionaryRecipe('curious',source);
        resolve(Response.json({definition:'eager'}));const [a,b]=await Promise.all([first,second]);
        expect(fetch).toHaveBeenCalledTimes(1);expect(a?.dictionaryEntry?.definition).toBe('eager');expect(b).toEqual(a);expect(b).not.toBe(a);
        a!.meanings[0].definitions[0].definition='mutated';expect((await lookupDictionaryRecipe('curious',source))?.meanings[0].definitions[0].definition).toBe('eager');
        setRuntimeFetch(async()=>Response.json({definition:'different'}));expect((await lookupDictionaryRecipe('curious',{...source,url:'https://second.test/{{word}}'}))?.dictionaryEntry?.definition).toBe('different');
        expect(fetch.mock.calls[0]?.[1]).toMatchObject({credentials:'omit',redirect:'error'});
    });
    it('does not request iframe sources, unsupported words or missing entries', async () => {
        const fetch=vi.fn(async()=>Response.json({}));setRuntimeFetch(fetch);
        const card=await lookupDictionaryRecipe('你好',recipe({kind:'iframe'}));expect(card?.dictionaryEntry?.webUrl).toContain('%E4%BD%A0');expect(fetch).not.toHaveBeenCalled();
        expect(await lookupDictionaryRecipe('<unsafe>',recipe())).toBeNull();expect(await lookupDictionaryRecipe('absent',recipe())).toBeNull();
    });
    it.each(['https://audio.test/a.mp3','http://evil.test/a.mp3','not a URL'])('accepts only safe external pronunciation media %s',async audio=>{
        setRuntimeFetch(async()=>Response.json({definition:'meaning',audio}));
        const card=await lookupDictionaryRecipe('word',recipe({fields:{...EMPTY_DICTIONARY_FIELDS,definition:'definition',audio:'audio'}}));
        expect(card?.phonetics[0]?.audio).toBe(audio.startsWith('https:')?audio:undefined);
    });
    it('does not cache transport failures and retries with new results',async()=>{
        const source=recipe();setRuntimeFetch(async()=>{throw new Error('offline');});await expect(lookupDictionaryRecipe('word',source)).rejects.toThrow('offline');
        setRuntimeFetch(async()=>Response.json({definition:'recovered'}));expect((await lookupDictionaryRecipe('word',source))?.dictionaryEntry?.definition).toBe('recovered');
    });
    it('rejects failed, empty, malformed and oversized response bodies and cancels readers',async()=>{
        await expect(readDictionaryJson(new Response('bad',{status:500}))).rejects.toThrow();
        await expect(readDictionaryJson(new Response(null))).rejects.toThrow('empty');
        await expect(readDictionaryJson(new Response('{}',{headers:{'content-length':'200'}}),100)).rejects.toThrow();
        await expect(readDictionaryJson(new Response('not JSON'))).rejects.toThrow();
        let canceled=false;
        const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(101));},cancel(){canceled=true;}});
        await expect(readDictionaryJson(new Response(stream),100)).rejects.toThrow('too large');expect(canceled).toBe(true);
        await expect(readDictionaryJson(new Response(new ReadableStream({start(controller){controller.error(new Error('broken stream'));}})))).rejects.toThrow('broken stream');
    });
    it('loads local HTML and only referenced on-device media, then observes removal',async()=>{
        const db=new DictionaryRepository();const id=`local-${crypto.randomUUID()}`;
        try {
            await db.install(id,{name:'Local',format:'MDict',css:'b{color:navy}',entries:[{key:'word',word:'word',html:'<b>meaning</b><img src="a.png"><img src="missing.png">',definition:'meaning',phonetic:'test'}],resources:[{path:'a.png',bytes:new Uint8Array([1,2])}]});
            const source=recipe({kind:'local',localId:id});const card=await lookupDictionaryRecipe('Word',source);
            expect(card?.dictionaryEntry?.html).toContain('data:image/png;base64,AQI=');expect(card?.sources[0].url).toBe('');
            expect(await lookupDictionaryRecipe('absent',source)).toBeNull();await db.remove(id);await expect(lookupDictionaryRecipe('word',source)).rejects.toThrow('not installed');
        } finally {await db.remove(id);db.close();}
    });
    it('handles local aliases, companion CSS and media budgets without network fallback',async()=>{
        const db=new DictionaryRepository(),id=`local-${crypto.randomUUID()}`;
        const base={name:'Local',format:'MDict',css:'',resources:[] as {path:string;bytes:Uint8Array}[],entries:[] as any[]};
        const item=(key:string,html:string,word=key)=>({key,word,html,definition:html,phonetic:''});
        const big=new Uint8Array(750000),oversize=new Uint8Array(1024*1024+1);
        try{
            await db.install(id,{...base,entries:[item('alias','@@@LINK=word'),item('word','<img src="../unsafe.png"><img src="noext"><link href="a.css"><img src="a.png"><img src="b.png"><img src="c.png"><img src="large.png">','invalid!'),item('cycle','@@@LINK=cycle'),item('invalid','@@@LINK=<invalid>'),...Array.from({length:11},(_,index)=>item('chain'+index,'@@@LINK=chain'+(index+1)))],resources:[{path:'a.css',bytes:new TextEncoder().encode('b{color:navy}')},{path:'noext',bytes:new Uint8Array([1])},{path:'a.png',bytes:big},{path:'b.png',bytes:big},{path:'c.png',bytes:big},{path:'large.png',bytes:oversize}]});
            const source=recipe({kind:'local',localId:id});const result=await lookupDictionaryRecipe('alias',source);expect(result?.dictionaryEntry?.css).toContain('navy');expect(result?.word).toBe('invalid!');
            expect(result?.dictionaryEntry?.html).toContain('src="c.png"');expect(result?.dictionaryEntry?.html).toContain('src="large.png"');
            for(const word of ['cycle','invalid','chain0'])await expect(lookupDictionaryRecipe(word,source)).rejects.toThrow('alias');
        }finally{await db.remove(id);db.close();}
    });
    it('keeps rich mapped fields and bounds/refreshes its cache',async()=>{
        const fetch=vi.fn(async()=>Response.json({definition:'meaning',example:'example',etymology:'origin',phonetic:'IPA'}));setRuntimeFetch(fetch);
        const source=recipe({fields:{...EMPTY_DICTIONARY_FIELDS,definition:'definition',example:'example',etymology:'etymology',phonetic:'phonetic'}});
        const card=await lookupDictionaryRecipe('word',source);expect(card?.origin).toBe('origin');expect(card?.meanings[0].definitions[0].example).toBe('example');
        for(let index=0;index<35;index++)await lookupDictionaryRecipe('word'+index,source);
        expect(fetch).toHaveBeenCalledTimes(36);
        const later=Date.now()+10*60*1000;vi.spyOn(Date,'now').mockReturnValueOnce(later);
        await lookupDictionaryRecipe('word34',source);expect(fetch).toHaveBeenCalledTimes(37);vi.restoreAllMocks();
    });
    it('runs user transformations in the bundled VM without browser or network globals',async()=>{
        expect(await runDictionaryScript('return {definition:word + ": " + data.meaning, globals:[typeof fetch,typeof browser,typeof document]};','word',{meaning:'test'})).toEqual({definition:'word: test',globals:['undefined','undefined','undefined']});
        await expect(runDictionaryScript('while(true) {}','word',{})).rejects.toThrow('limits');
        await expect(runDictionaryScript('throw new Error("secret")','word',{})).rejects.toThrow('limits');
        await expect(runDictionaryScript('return "x".repeat(100000)','word',{})).rejects.toThrow('too large');
        await expect(runDictionaryScript('x'.repeat(16385),'word',{})).rejects.toThrow('too large');
        setRuntimeFetch(async()=>Response.json({meaning:'mapped'}));const source=recipe({kind:'script',script:'return {definition:data.meaning.toUpperCase()};'});
        expect((await lookupDictionaryRecipe('word',source))?.dictionaryEntry?.definition).toBe('MAPPED');
    });
    it('validates Anki messages, escapes template text and rejects unconfirmed saves',async()=>{
        const calls: RequestInit[]=[];setRuntimeFetch(async(_input,init)=>{calls.push(init!);return Response.json({error:null,result:123});});
        const settings=defaultDictionaryWorkspace().anki;
        expect(await sendDictionaryCardToAnki({front:'<b>word</b>',back:'line\nsecond'},settings)).toBe(123);
        expect(JSON.parse(String(calls[0].body)).params.note).toMatchObject({options:{allowDuplicate:false},fields:{Front:'&lt;b&gt;word&lt;/b&gt;',Back:'line<br>second'}});
        await expect(sendDictionaryCardToAnki({front:'a',back:'b'},{...settings,url:'https://remote.test'})).rejects.toThrow();
        await expect(sendDictionaryCardToAnki({front:'',back:'b'},settings)).rejects.toThrow();
        for (const response of [{error:'duplicate',result:null},null,{result:null}]) {setRuntimeFetch(async()=>Response.json(response));await expect(sendDictionaryCardToAnki({front:'a',back:'b'},settings)).rejects.toThrow();}
        const send=vi.fn(async()=>42);const handler=createDictionaryCardHandler({ready:Promise.resolve(),settings:()=>settings,send});
        expect(await handler.handle({type:handler.type,front:'a',back:'b'} as any,{})).toEqual({success:true,data:42});
        for (const message of [{},{front:1,back:'a'},{front:'a',back:''},{front:'x'.repeat(65537),back:'b'}]) await expect(handler.handle({type:handler.type,...message} as any,{})).rejects.toThrow();
    });
});
