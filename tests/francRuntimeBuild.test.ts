/**
 * @file tests/francRuntimeBuild.test.ts
 * 文件职责：验证构建期统计语言模型的按文字延迟初始化保持 franc-min 原有同步行为。
 * 主要内容：核对依赖摘要和模块边界，执行真实模型及算法，对照多文字、空短文本、候选过滤、排序及 userscript 数据还原。
 * 模块边界：VM 只承载锁定构建副本与测试计数端口，不改变生产 API；初始化与 Node 堆数据不代表真实浏览器启动性能。
 */
import {describe,expect,it} from 'vitest';
import {readFileSync,realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pathToFileURL} from 'node:url';
import {createContext,runInContext} from 'node:vm';
import {data} from 'franc-min/data.js';
import {expressions} from 'franc-min/expressions.js';
import {franc,francAll} from 'franc-min';
import {patchFrancRuntimeSource,francRuntimeBuildPlugin} from '../scripts/testing/franc-runtime-build';
import corpus from './fixtures/language-identification-corpus.json';
import {createUserscriptFrancDataCompressionPlugin} from '../userscript/francDataPlugin';
import {inflateWithPako} from '../userscript/pakoBundled';
import {decodeUserscriptData} from '../userscript/dataEncoding';

const require=createRequire(import.meta.url),sourcePath=require.resolve('franc-min');
const source=readFileSync(sourcePath,'utf8');
const {asTuples}=await import(pathToFileURL(createRequire(sourcePath).resolve('trigram-utils')).href);
interface Runtime {
    franc:typeof franc;
    francAll:typeof francAll;
    initialized:()=>string[];
    models:()=>Record<string,Record<string,Record<string,number>>>;
}
function load(code=patchFrancRuntimeSource(source),models:typeof data=data):Runtime {
    const context=createContext({asTuples,expressions,data:models},{codeGeneration:{strings:false,wasm:false}});
    const executable=code.replace(/^import[^\n]+\n/gmu,'').replace(/export function /gu,'function ');
    runInContext(executable+'\nglobalThis.result={franc,francAll,initialized:()=>Object.keys(numericData),models:()=>numericData};',context);
    return context.result as Runtime;
}
const examples={
    Latin:'This is a normal English sentence with enough words to identify the language correctly.',
    Cyrillic:'Это достаточно длинное предложение на русском языке для проверки статистической модели.',
    Arabic:'هذه جملة طويلة مكتوبة باللغة العربية للتحقق من أن نموذج اللغة يعمل بشكل صحيح.',
    Devanagari:'यह हिंदी भाषा में लिखा गया एक पर्याप्त लंबा वाक्य है जिससे भाषा की पहचान की जा सकती है।',
};

describe('deferred franc runtime construction',()=>{
    it('pins the full upstream source and transforms only the exact algorithm module',()=>{
        const plugin=francRuntimeBuildPlugin();
        const transform=plugin.transform as (code:string,id:string)=>{code:string;map:null}|undefined;
        expect(plugin.apply).toBe('build');
        for(const id of ['\0virtual',sourcePath+'?raw',sourcePath.replace('index.js','data.js'),'/another/index.js'])
            expect(transform(source,id)).toBeUndefined();
        expect(transform(source,sourcePath)).toEqual({code:patchFrancRuntimeSource(source),map:null});
        expect(transform(source,sourcePath.replace(/\//gu,'\\'))?.code).toBe(patchFrancRuntimeSource(source));
        expect(()=>patchFrancRuntimeSource(source+'\n')).toThrow(/Unsupported franc-min source/);
        expect(()=>patchFrancRuntimeSource(patchFrancRuntimeSource(source))).toThrow(/Unsupported franc-min source/);
        expect(readFileSync(sourcePath,'utf8')).toBe(source);
    });
    it('constructs no numeric dictionaries on import, empty, short or unique-script input',()=>{
        const runtime=load();
        expect(runtime.initialized()).toEqual([]);
        for(const value of ['',undefined,'short','日本語の文章を使って言語の認識を確認します。']){
            expect(runtime.francAll(value)).toEqual(francAll(value));
            expect(runtime.franc(value)).toEqual(franc(value));
        }
        expect(runtime.initialized()).toEqual([]);
    });
    it('initializes only the requested script once and retains every original numeric model',()=>{
        const reads:Record<string,number>={};
        const observed=new Proxy(data,{get(target,key,receiver){
            if(typeof key==='string')reads[key]=(reads[key]??0)+1;
            return Reflect.get(target,key,receiver);
        }});
        const runtime=load(undefined,observed),original=load(source);
        for(const [script,text] of Object.entries(examples)){
            const before={...reads};
            expect(runtime.francAll(text,{minLength:0})).toEqual(francAll(text,{minLength:0}));
            expect(runtime.initialized()).toContain(script);
            expect(reads[script]).toBe((before[script]??0)+1);
            expect(runtime.francAll(text,{minLength:0})).toEqual(francAll(text,{minLength:0}));
            expect(reads[script]).toBe((before[script]??0)+1);
            expect(runtime.models()[script]).toEqual(original.models()[script]);
        }
        expect(Object.values(runtime.models()).reduce((total,models)=>total+Object.keys(models).length,0)).toBe(66);
    });
    it('keeps the unchanged model data compatible with standard, standalone and Greasy Fork output',async()=>{
        const dataPath=realpathSync(require.resolve('franc-min/data.js')),raw=readFileSync(dataPath,'utf8');
        for(const [enabled,compact,standalone] of [[true,false,false],[true,true,true],[false,false,false]]){
            const plugin=createUserscriptFrancDataCompressionPlugin(process.cwd(),enabled,compact,standalone);
            const transform=plugin.transform as (code:string,id:string)=>{code:string}|null|Promise<{code:string}>;
            const output=await transform(raw,dataPath);
            const code=(output?.code??raw).replace(/^import[^\n]+\n/gmu,'').replace('export const data =','const data =');
            const context=createContext({inflateWithPako,decodeUserscriptData,atob,Uint8Array,JSON},{codeGeneration:{strings:false,wasm:false}});
            const restored=runInContext(code+'\ndata;',context) as typeof data;
            expect(restored).toEqual(data);
            const runtime=load(undefined,restored);
            for(const text of [...Object.values(examples),...corpus.cases.map(row=>row.text)])
                expect(runtime.francAll(text,{minLength:0})).toEqual(francAll(text,{minLength:0}));
            expect(Object.values(runtime.models()).reduce((total,models)=>total+Object.keys(models).length,0)).toBe(66);
        }
    });
    it('preserves full candidate order and scores across the independent language corpus and filters',()=>{
        const runtime=load();
        const texts=[...Object.values(examples),...corpus.cases.map(row=>row.text),'12345','This العربية русский हिंदी mixed text'];
        const filters=[{}, {minLength:0}, {minLength:500}, {only:['eng','spa']}, {ignore:['eng','rus']},
            {only:['not-a-language']}, {only:[]},{ignore:[]}];
        for(const text of texts)for(const options of filters){
            expect(runtime.francAll(text,options),JSON.stringify({text,options})).toEqual(francAll(text,options));
            expect(runtime.franc(text,options)).toBe(franc(text,options));
        }
        const options={whitelist:['eng','rus'],blacklist:['eng'],minLength:0};
        expect(runtime.francAll(examples.Latin,options)).toEqual(francAll(examples.Latin,options));
    });
});

describe('Greasy Fork vendor source freshness',()=>{
    function execute(options:{stale?:boolean;missing?:boolean;prepare?:boolean;file?:string}={}) {
        const calls:{command:string;args:string[];env?:Record<string,string>}[]=[],writes:string[]=[];
        const plugin=options.file??'scripts/testing/franc-runtime-build.ts',commit='a'.repeat(40);
        const bytes=(file:string)=>Buffer.from(file.includes('vendor')?'fixed-vendor':'fixed-data');
        const spawnSync=(command:string,args:string[],settings:{env?:Record<string,string>})=>{
            calls.push({command,args,env:settings.env});
            if(command==='git'&&args[0]==='log')return {status:0,stdout:commit,stderr:''};
            if(command==='git'&&args[0]==='cat-file'&&args[2].endsWith(':'+plugin)&&options.missing)
                return {status:1,stdout:'',stderr:'plugin absent at resource commit'};
            if(command==='git'&&args[0]==='diff'&&args.includes(plugin)&&options.stale)
                return {status:1,stdout:'changed plugin',stderr:''};
            if(command==='git'&&args[0]==='show')return {status:0,stdout:bytes(args[1]),stderr:''};
            return {status:0,stdout:'',stderr:''};
        };
        const context=createContext({Buffer,path,fileURLToPath,spawnSync,console:{log:()=>{}},
            fs:{mkdirSync:()=>{},copyFileSync:()=>{},readFileSync:bytes,writeFileSync:(file:string)=>writes.push(file)},
            process:{argv:['node','/fixture/scripts/build-userscript-greasyfork.mjs',...(options.prepare?['--prepare-resources']:[])],env:{}}});
        const code=readFileSync('scripts/build-userscript-greasyfork.mjs','utf8').replace(/^import[^\n]+\n/gmu,'')
            .replace('import.meta.url',JSON.stringify('file:///fixture/scripts/build-userscript-greasyfork.mjs'));
        let error:unknown;try {runInContext(code,context);}catch(failure){error=failure;}
        return {calls,writes,error};
    }
    it.each(['stale','missing'].flatMap(reason=>['scripts/testing/franc-runtime-build.ts','public/third-party-notices/franc-min-MIT.txt'].map(file=>({reason,file}))))('refuses a $reason $file before building or reusing pinned vendor resources',({reason,file})=>{
        const result=execute({[reason]:true,file});
        expect(result.error).toBeDefined();
        expect(String(result.error)).toContain(reason==='stale'?'failed (1)':'plugin absent at resource commit');
        expect(result.calls.some(call=>call.command==='pnpm')).toBe(false);
    });
    it('retains the immutable resource source and verification flow when all vendor inputs match',()=>{
        const result=execute();
        expect(result.error).toBeUndefined();
        expect(result.calls.find(call=>call.command==='git'&&call.args[0]==='diff')?.args)
            .toEqual(expect.arrayContaining(['scripts/testing/franc-runtime-build.ts','public/third-party-notices/franc-min-MIT.txt']));
        const build=result.calls.find(call=>call.command==='pnpm');
        expect(build?.env?.FLUENTREAD_USERSCRIPT_VENDOR_URL).toContain('@'+'a'.repeat(40)+'/userscript/resources/');
        expect(result.calls.at(-1)?.args).toEqual(['scripts/verify-userscript-greasyfork-build.mjs']);
        expect(result.writes).toHaveLength(0);
    });
    it('prepares both resources without requiring source commits or invoking network tools',()=>{
        const result=execute({prepare:true});
        expect(result.error).toBeUndefined();
        expect(result.calls.map(call=>call.command)).toEqual(['pnpm','pnpm']);
        expect(result.calls[0].args).toContain('userscript/vendor.vite.config.ts');
        expect(result.calls[1].env?.FLUENTREAD_USERSCRIPT_VENDOR_URL).toBe('http://127.0.0.1:57511/fluentread-vendor.v1.js');
        expect(result.writes).toHaveLength(2);
    });
});
