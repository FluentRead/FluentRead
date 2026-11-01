/** 测试专用文件缓存：用微型公开模型替身验证真实文件、流式下载与进程锁，不下载真实权重。 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const {defaultImageTranslationModelCacheDirectory, readImageTranslationModelManifest, ensureImageTranslationModelFiles} = require('../scripts/testing/image-model-cache.cjs');
const helperFile = path.resolve('scripts/testing/image-model-cache.cjs');
const folders: string[] = [];
const names = ['det.onnx','rec.onnx','dict.txt','lama.onnx'];
const bodies = names.map((_, index) => Buffer.from(`verified-public-model-${index}`));
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex');

async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(),'fluentread-image-model-cache-test-')); folders.push(root);
    const metadataFile = path.join(root,'mangaOcrAssets.ts'), directory = path.join(root,'cache');
    await fs.writeFile(metadataFile, `const ROOT = 'https://models.example.test/pinned/';\nexport const MANGA_OCR_CACHE = 'fluent-read-manga-ocr-v1';\nexport const MANGA_OCR_ASSETS = [\n${['detection','recognition','charactersDictionary'].map((key,index)=>`{key: '${key}', path: '${names[index]}', bytes: ${bodies[index].length}, sha256: '${sha(bodies[index])}'},`).join('\n')}\n] as const;\nexport const MANGA_INPAINT_ASSET = {\nurl: 'https://models.example.test/pinned/${names[3]}',\nbytes: ${bodies[3].length}, sha256: '${sha(bodies[3])}',\n};`);
    const fetchImpl = vi.fn(async (url: string) => new Response(bodies[names.indexOf(path.basename(new URL(url).pathname))]));
    return {root, directory, metadataFile, fetchImpl};
}
async function allFiles(root: string): Promise<string[]> {
    let entries;try {entries=await fs.readdir(root,{withFileTypes:true});}catch(error:any){if(error.code==='ENOENT')return [];throw error;}
    return (await Promise.all(entries.map(async entry=>entry.isDirectory()?allFiles(path.join(root,entry.name)):[path.join(root,entry.name)]))).flat();
}
const childRun = (code: string, options: {cwd?: string} = {}) => new Promise<string>((resolve,reject)=>{
    const child=spawn(process.execPath,['-e',code],{stdio:['ignore','pipe','pipe'],...options});let output='',error='';
    child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>error+=chunk);
    child.on('error',reject);child.on('exit',status=>status===0?resolve(output):reject(new Error(error||`child exit ${status}`)));
});
afterEach(async()=>{await Promise.all(folders.splice(0).map(folder=>fs.rm(folder,{recursive:true,force:true})));});

describe('图片/漫画测试模型共享文件缓存',()=>{
    it('从生产固定清单读取三个 OCR 文件和可选 LaMa，不复制版本或权威哈希',()=>{
        const assets=readImageTranslationModelManifest();
        expect(assets.map((asset:any)=>asset.kind)).toEqual(['ocr','ocr','ocr','inpaint']);
        expect(assets.map((asset:any)=>asset.bytes)).toEqual([9880512,21159378,74948,206291843]);
        expect(assets.every((asset:any)=>/^[a-f0-9]{64}$/.test(asset.sha256)&&asset.url.startsWith('https://'))).toBe(true);
    });

    it('元数据格式漂移明确失败，不静默下载未知资源',async()=>{
        const f=await fixture();await fs.writeFile(f.metadataFile,'export const incompatible = [];');
        await expect(ensureImageTranslationModelFiles(f)).rejects.toThrow('Cannot parse pinned image model metadata');
        expect(f.fetchImpl).not.toHaveBeenCalled();
    });

    it('默认 worktree 共用 git common-dir旁缓存，显式环境覆盖及非Git快照有确定回退',async()=>{
        const f=await fixture();
        expect(defaultImageTranslationModelCacheDirectory({env:{}})).toMatch(/workspace-data\/model-cache$/);
        expect(defaultImageTranslationModelCacheDirectory({cwd:f.root,env:{}})).toBe(path.join(f.root,'.cache','image-translation-models'));
        expect(defaultImageTranslationModelCacheDirectory({cwd:f.root,env:{FLUENTREAD_TEST_MODEL_CACHE_DIR:'fixed-cache'}})).toBe(path.join(f.root,'fixed-cache'));
    });

    it('从任意非仓库cwd调用仍从helper所属worktree定位同一个固定缓存',async()=>{
        const f=await fixture();
        const output=await childRun(`process.stdout.write(require(${JSON.stringify(helperFile)}).defaultImageTranslationModelCacheDirectory({env:{}}));`,{cwd:f.root});
        expect(output).toBe(defaultImageTranslationModelCacheDirectory({env:{}}));
        expect(output).toMatch(/workspace-data\/model-cache$/);
        expect((await allFiles(f.root)).some(file=>file.includes('.cache'))).toBe(false);
    });

    it('首次仅下载所需OCR；第二次逐文件验证命中；同长度哈希损坏只重新下载该文件',async()=>{
        const f=await fixture();const first=await ensureImageTranslationModelFiles(f);
        expect(first.files).toHaveLength(3);expect(first.networkDownloads).toBe(3);expect(f.fetchImpl).toHaveBeenCalledTimes(3);
        expect(first.files.every((file:any)=>file.cache==='downloaded'&&path.isAbsolute(file.path))).toBe(true);
        f.fetchImpl.mockClear();const second=await ensureImageTranslationModelFiles(f);
        expect(second.networkDownloads).toBe(0);expect(second.files.every((file:any)=>file.cache==='hit')).toBe(true);expect(f.fetchImpl).not.toHaveBeenCalled();
        await fs.writeFile(first.files[1].path,Buffer.alloc(bodies[1].length,7));
        const repaired=await ensureImageTranslationModelFiles(f);
        expect(repaired.networkDownloads).toBe(1);expect(f.fetchImpl).toHaveBeenCalledTimes(1);
        expect(await fs.readFile(repaired.files[1].path)).toEqual(bodies[1]);
        expect((await allFiles(f.directory)).some(file=>/\.partial-|\.lock$/.test(file))).toBe(false);
    });

    it('平面缓存根或显式来源目录验证后复制导入，只准备LaMa且保留原文件',async()=>{
        const f=await fixture(), source=path.join(f.root,'source');await fs.mkdir(source);await fs.writeFile(path.join(source,names[3]),bodies[3]);
        const imported=await ensureImageTranslationModelFiles({...f,kinds:['inpaint'],sourceDirectories:[source]});
        expect(imported.files).toHaveLength(1);expect(imported.files[0].cache).toBe('imported');expect(imported.networkDownloads).toBe(0);expect(f.fetchImpl).not.toHaveBeenCalled();
        expect(await fs.readFile(path.join(source,names[3]))).toEqual(bodies[3]);
        const other=await fixture();await fs.mkdir(other.directory);await fs.writeFile(path.join(other.directory,names[0]),bodies[0]);
        const flat=await ensureImageTranslationModelFiles(other);
        expect(flat.files[0].cache).toBe('imported');expect(flat.networkDownloads).toBe(2);
    });

    it('禁用缓存下载时复用验证命中或从来源导入，缺失与损坏明确失败且不覆盖已有文件',async()=>{
        const f=await fixture(), source=path.join(f.root,'source');await fs.mkdir(source);
        await expect(ensureImageTranslationModelFiles({...f,kinds:['inpaint'],allowNetworkDownload:false})).rejects.toThrow('unavailable in offline cache: lama.onnx');
        expect(f.fetchImpl).not.toHaveBeenCalled();
        const sourceFile=path.join(source,names[3]);await fs.writeFile(sourceFile,bodies[3]);
        const imported=await ensureImageTranslationModelFiles({...f,kinds:['inpaint'],sourceDirectories:[source],allowNetworkDownload:false});
        expect(imported.networkDownloads).toBe(0);expect(imported.files[0].cache).toBe('imported');
        const hit=await ensureImageTranslationModelFiles({...f,kinds:['inpaint'],allowNetworkDownload:false});
        expect(hit.files[0].cache).toBe('hit');expect(await fs.readFile(sourceFile)).toEqual(bodies[3]);
        const corrupt=Buffer.alloc(bodies[3].length,7);await fs.writeFile(hit.files[0].path,corrupt);
        await expect(ensureImageTranslationModelFiles({...f,kinds:['inpaint'],sourceDirectories:[source],allowNetworkDownload:false}))
            .rejects.toThrow('Invalid existing image model cache file: lama.onnx');
        expect(await fs.readFile(hit.files[0].path)).toEqual(corrupt);
        expect(await fs.readFile(sourceFile)).toEqual(bodies[3]);expect(f.fetchImpl).not.toHaveBeenCalled();
        expect((await allFiles(f.directory)).some(file=>/\.partial-|\.lock$/.test(file))).toBe(false);
        await expect(ensureImageTranslationModelFiles({...f,allowNetworkDownload:'false'})).rejects.toThrow('must be a boolean');
    });

    it('缓存助手禁下载选项拒绝不使用该缓存的图片和漫画入口模式',async()=>{
        const f=await fixture(), playwright=path.join(f.root,'playwright');await fs.mkdir(playwright);
        await fs.writeFile(path.join(playwright,'index.js'),'module.exports={chromium:{}};');
        const helper=path.join(f.root,'focus-helper.cjs');await fs.writeFile(helper,'module.exports={};');
        const manga=path.resolve('scripts/testing/run-manga-translation-test.cjs');
        const image=path.resolve('scripts/testing/run-image-translation-flow-test.cjs');
        await expect(childRun(`process.argv=[process.execPath,${JSON.stringify(image)},'--model-cache-no-download'];require(${JSON.stringify(image)});`))
            .rejects.toThrow('requires --x-lightbox');
        for(const args of [['--baseline'],['--preload-models-dir',f.root],['--offline-models-dir',f.root],['--blocked-official'],['--blocked-all-model-sources']]){
            const argv=[process.execPath,manga,'--playwright-root',f.root,'--focus-safe-helper',helper,'--model-cache-no-download',...args];
            await expect(childRun(`process.argv=${JSON.stringify(argv)};require(${JSON.stringify(manga)});`))
                .rejects.toThrow('requires the shared model cache');
        }
    });

    it('离线导入期间出现新目标时不会覆盖其他进程的数据',async()=>{
        const f=await fixture(),source=path.join(f.root,'source');await fs.mkdir(source);
        const sourceFile=path.join(source,names[3]);await fs.writeFile(sourceFile,bodies[3]);
        const destination=path.join(f.directory,sha(bodies[3]),names[3]),other=Buffer.from('concurrent data');
        const copy=fs.copyFile.bind(fs),spy=vi.spyOn(fs,'copyFile').mockImplementation(async (...args)=>{
            await copy(...args);await fs.writeFile(destination,other);
        });
        try {
            await expect(ensureImageTranslationModelFiles({...f,kinds:['inpaint'],sourceDirectories:[source],allowNetworkDownload:false}))
                .rejects.toMatchObject({code:'EEXIST'});
        } finally {spy.mockRestore();}
        expect(await fs.readFile(destination)).toEqual(other);expect(await fs.readFile(sourceFile)).toEqual(bodies[3]);
        expect(f.fetchImpl).not.toHaveBeenCalled();expect((await allFiles(f.directory)).some(file=>/\.partial-|\.lock$/.test(file))).toBe(false);
    });

    it('两个入口将实际命令行标志传递给缓存助手，缺失时不触发下载',async()=>{
        const f=await fixture();
        for(const script of ['run-manga-translation-test.cjs','run-image-translation-flow-test.cjs']){
            const file=path.resolve('scripts/testing',script),source=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
            let flag:ts.Expression|undefined, options:ts.Expression|undefined;let calls=0;
            const visit=(node:ts.Node)=>{
                if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='noCacheDownload')flag=node.initializer;
                if(ts.isCallExpression(node)&&node.expression.getText(source).endsWith('ensureImageTranslationModelFiles')){calls++;options=node.arguments[0];}
                ts.forEachChild(node,visit);
            };
            visit(source);expect(calls).toBe(1);expect(flag).toBeDefined();expect(options).toBeDefined();
            for(const enabled of [true,false]){
                const noCacheDownload=runInNewContext(flag!.getText(source),{process:{argv:enabled?['--model-cache-no-download']:[]}});
                const settings=runInNewContext(`(${options!.getText(source)})`,{modelCacheDir:f.directory,kinds:['ocr'],noCacheDownload,
                    require:()=>({defaultImageTranslationModelCacheDirectory:()=>f.directory})});
                expect(settings.allowNetworkDownload).toBe(!enabled);
                if(enabled){
                    await expect(ensureImageTranslationModelFiles({...settings,metadataFile:f.metadataFile,fetchImpl:f.fetchImpl}))
                        .rejects.toThrow('unavailable in offline cache');
                    expect(f.fetchImpl).not.toHaveBeenCalled();
                }
            }
        }
    });

    it('同一进程并发复查锁后缓存，不重复下载任何OCR文件',async()=>{
        const f=await fixture();
        f.fetchImpl.mockImplementation(async(url:string)=>{await new Promise(resolve=>setTimeout(resolve,10));return new Response(bodies[names.indexOf(path.basename(new URL(url).pathname))]);});
        const results=await Promise.all([ensureImageTranslationModelFiles({...f,pollMs:5}),ensureImageTranslationModelFiles({...f,pollMs:5})]);
        expect(f.fetchImpl).toHaveBeenCalledTimes(3);expect(results.reduce((total,result)=>total+result.networkDownloads,0)).toBe(3);
        expect(results[0].files.map((file:any)=>file.path)).toEqual(results[1].files.map((file:any)=>file.path));
    });

    it('两个真实进程与本地HTTP响应共享原子锁，只下载每个文件一次',async()=>{
        const f=await fixture();const requests:string[]=[];
        const server=createServer((request,response)=>{const name=decodeURIComponent(request.url!.slice(1));requests.push(name);setTimeout(()=>{response.writeHead(200);response.end(bodies[names.indexOf(name)]);},25);});
        await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
        try {
            const base=`http://127.0.0.1:${(server.address() as any).port}`;
            const code=`const h=require(${JSON.stringify(helperFile)});h.ensureImageTranslationModelFiles({directory:${JSON.stringify(f.directory)},metadataFile:${JSON.stringify(f.metadataFile)},pollMs:5,fetchImpl:(url,options)=>fetch(${JSON.stringify(base)}+'/'+require('node:path').basename(new URL(url).pathname),options)}).then(r=>process.stdout.write(JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1});`;
            const results=(await Promise.all([childRun(code),childRun(code)])).map(output=>JSON.parse(output));
            expect(requests.sort()).toEqual(names.slice(0,3).sort());expect(results.reduce((total,result)=>total+result.networkDownloads,0)).toBe(3);
        } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
    });

    it('锁持有进程退出后恢复，活跃锁则超时或取消并保留其所有权',async()=>{
        const f=await fixture();await fs.mkdir(f.directory);const lock=path.join(f.directory,sha(bodies[3])+'.lock');
        const oldFolder=path.join(f.directory,sha(bodies[3]));await fs.mkdir(oldFolder);
        const orphanPartial=path.join(oldFolder,names[3]+'.partial-exited-owner');await fs.writeFile(orphanPartial,'incomplete');
        await childRun(`require('node:fs').writeFileSync(${JSON.stringify(lock)},JSON.stringify({pid:process.pid,token:'exited'}));`);
        const recovered=await ensureImageTranslationModelFiles({...f,kinds:['inpaint'],pollMs:5,lockTimeoutMs:200});
        expect(recovered.networkDownloads).toBe(1);expect((await allFiles(f.directory)).some(file=>file.includes('.partial-'))).toBe(false);
        await fs.writeFile(lock,JSON.stringify({pid:process.pid,token:'active'}));
        await expect(ensureImageTranslationModelFiles({...f,kinds:['inpaint'],pollMs:5,lockTimeoutMs:20})).rejects.toThrow('Timed out waiting');
        const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),10);
        try {await expect(ensureImageTranslationModelFiles({...f,kinds:['inpaint'],pollMs:5,signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});}
        finally{clearTimeout(timer);}
        expect(JSON.parse(await fs.readFile(lock,'utf8')).token).toBe('active');
    });

    it.each(['http','short','oversize','sha'])('下载失败 %s 不发布缓存并清除 partial/lock，随后可重试',async failure=>{
        const f=await fixture();
        const body=failure==='short'?bodies[3].subarray(1):failure==='oversize'?Buffer.concat([bodies[3],Buffer.from('x')]):Buffer.alloc(bodies[3].length,1);
        f.fetchImpl.mockResolvedValueOnce(new Response(body,{status:failure==='http'?503:200}));
        await expect(ensureImageTranslationModelFiles({...f,kinds:['inpaint']})).rejects.toThrow(/download failed|mismatch/);
        expect(await allFiles(f.directory)).toEqual([]);
        expect((await ensureImageTranslationModelFiles({...f,kinds:['inpaint']})).networkDownloads).toBe(1);
    });

    it('流式下载取消清理临时字节，已有缓存保留且下次正常重试',async()=>{
        const f=await fixture(),controller=new AbortController(),cancelled=vi.fn();
        f.fetchImpl.mockResolvedValueOnce(new Response(new ReadableStream({start(stream){stream.enqueue(bodies[3].subarray(0,2));},cancel:cancelled})));
        const timer=setTimeout(()=>controller.abort(),20);
        try {await expect(ensureImageTranslationModelFiles({...f,kinds:['inpaint'],signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});}
        finally{clearTimeout(timer);}
        expect(cancelled).toHaveBeenCalledOnce();expect(await allFiles(f.directory)).toEqual([]);
        expect((await ensureImageTranslationModelFiles({...f,kinds:['inpaint']})).networkDownloads).toBe(1);
    });
});
