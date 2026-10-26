/**
 * @file tests/mangaColorQualityCorpus.test.ts
 * 文件职责：让八类冻结彩色漫画及其严格验收反例进入常规 functional 回归。
 * 主要内容：通过可移植 Node checker 校验真实文件、源 RGBA 和公共门禁；以独立临时文件证明自洽篡改也被拒绝，并保留真实首轮失败。
 * 模块边界：不调用生产 OCR、模型、浏览器或字体；完美真值回放只验证验收逻辑，不能声称识别或修补通过。
 */
import {describe,expect,it} from 'vitest';
import {readFileSync,writeFileSync,cpSync,mkdtempSync,rmSync,symlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// 完整静态目录引用保留 PNG/gzip-only 变化的 affected 依赖，脚本也各自显式登记。
const fixtureRoot=new URL('./fixtures/manga-color-quality/',import.meta.url);
const checker=new URL('../scripts/testing/check-manga-color-quality-fixtures.cjs',import.meta.url);
const generator=new URL('../scripts/testing/generate-manga-color-quality-fixtures.py',import.meta.url);
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const original=readFileSync(new URL('manifest.json',fixtureRoot));
const manifest=JSON.parse(original.toString());
const {evaluateQualityFixture,evaluateQualityReadingOrder}=require('../scripts/testing/manga-quality-corpus.cjs');
const run=(directory?:string)=>spawnSync(process.execPath,[fileURLToPath(checker),...(directory?['--fixture-dir',directory]:[])],{encoding:'utf8',timeout:30_000,maxBuffer:4*1024*1024});

describe('彩色漫画源冻结和独立验收门禁',()=>{
    it('无需字体或模型，八景完整真值、字形载荷、源RGBA及全部105项错误反例均可复验',()=>{
        const actual=run();expect(actual.error).toBeUndefined();expect(actual.status,actual.stderr).toBe(0);
        const result=JSON.parse(actual.stdout);
        expect(result).toMatchObject({passed:true,manifestSha256:'3ceb90f8fc34d3b261898ae5045d4002873ca471dd7ff8e57e72dee6274b444f',counts:{scenes:8,anchors:34,paragraphs:23,negativeRegions:15,rgbProbes:21,rgbaProbes:8,protectedRgbaPixels:4800,sourceRgbaBytes:44_880_000,payloadFiles:58,perfectTruthReplays:8,singleCharacterRejected:34,duplicatesRejected:34,artInjectionsRejected:15,paragraphMergesRejected:7,paragraphSplitsRejected:7,extraTextRejected:7,wordlessPunctuationRejected:1}});
        expect(result.results.map((row:any)=>row.scene)).toEqual(manifest.fixtures.map((f:any)=>f.name));
        expect(readFileSync(new URL('manifest.json',fixtureRoot))).toEqual(original);
    });

    it('原manifest保留首次冻结历史字段，维护脚本信息独立记录，不凭离线源验证宣称模型通过',()=>{
        expect(sha(original)).toBe('3ceb90f8fc34d3b261898ae5045d4002873ca471dd7ff8e57e72dee6274b444f');
        expect(manifest.generator).toBe('generate-color-scenes.py');
        expect(manifest.generatorSha256).toBe('1ee1ff0a9644eee547c863559296b58580f45053880ec6f01be2e6bdb21a9dc7');
        const provenance=JSON.parse(readFileSync(new URL('provenance.json',fixtureRoot),'utf8'));
        expect(provenance).toMatchObject({sourceBeforeAnyOcr:true,selectionByOcrResult:false,sourceTruthChangedDuringMigration:false,fontsBundled:false,modelWeightsBundled:false,originalManifestSha256:sha(original),maintainedGenerator:{path:'scripts/testing/generate-manga-color-quality-fixtures.py'}});
        expect(provenance.maintainedGenerator.sha256).toBe(sha(readFileSync(generator)));
        const wordless=manifest.fixtures.filter((f:any)=>f.expectedNoText);expect(wordless).toHaveLength(1);
        expect(wordless[0].name).toBe('wordless-stained-glass-cutout-garden');expect(wordless[0].expectedSource).toEqual([]);expect(wordless[0].paragraphGroups).toBeUndefined();
        expect(manifest.fixtures.filter((f:any)=>!f.expectedNoText)).toHaveLength(7);
    });

    const rewrite=(directory:string,mutate:(data:any)=>void)=>{
        const target=path.join(directory,'manifest.json'),data=JSON.parse(readFileSync(target,'utf8'));
        mutate(data);writeFileSync(target,JSON.stringify(data,null,2)+'\n');
    };
    const mutations:Array<[string,(directory:string)=>void]>=[
        ['自洽替换完整原文和锚点',directory=>rewrite(directory,data=>{const f=data.fixtures[0];f.expectedSource[0]='ALTERED TRUTH';f.expectedAnchors[0]='ALTERED TRUTH';f.regions[0].text='ALTERED TRUTH';f.regions[0].anchor='ALTERED TRUTH';f.anchorOccurrences={...f.anchorOccurrences,'ALTERED TRUTH':1};})],
        ['保持每区ID唯一但交换独立气泡的组归属',directory=>rewrite(directory,data=>{const [a,b,c]=data.fixtures[0].paragraphGroups;data.fixtures[0].paragraphGroups=[[a[0],b[0]],[a[1],b[1]],c];})],
        ['移动字形物理框以隐藏误擦范围',directory=>rewrite(directory,data=>{data.fixtures[0].regions[0].bbox.x0++;})],
        ['用完整第二场景替换第一场景造成重复',directory=>rewrite(directory,data=>{data.fixtures[0]=structuredClone(data.fixtures[1]);})],
        ['删除困难场景',directory=>rewrite(directory,data=>{data.fixtures.splice(0,1);})],
        ['改变RGBA保护点的alpha',directory=>rewrite(directory,data=>{data.fixtures.find((f:any)=>f.protectedRgbaProbes.length).protectedRgbaProbes[0].rgba[3]^=1;})],
        ['缩小透明洞矩形',directory=>rewrite(directory,data=>{data.fixtures.find((f:any)=>f.protectedRgbaRegions.length).protectedRgbaRegions[0].bbox.x1--;})],
    ];
    for(const [label,mutate]of mutations)it(`${label}仍被独立完整冻结摘要拒绝`,()=>{
        const temporary=mkdtempSync(path.join(tmpdir(),'fluentread-color-truth-'));
        try{
            cpSync(fileURLToPath(fixtureRoot),temporary,{recursive:true});mutate(temporary);
            const actual=run(temporary);expect(actual.error).toBeUndefined();expect(actual.status).toBe(1);expect(actual.stderr).toContain('Complete pre-first-OCR manifest is immutable');
        }finally{rmSync(temporary,{recursive:true,force:true});}
        expect(readFileSync(new URL('manifest.json',fixtureRoot))).toEqual(original);
    });

    for(const kind of ['PNG','RGBA gzip']as const)it(`实际${kind}被破坏时保留非零失败，不能只靠metadata自述通过`,()=>{
        const temporary=mkdtempSync(path.join(tmpdir(),'fluentread-color-pixels-'));
        try{
            cpSync(fileURLToPath(fixtureRoot),temporary,{recursive:true});const f=manifest.fixtures[0];
            const target=path.join(temporary,kind==='PNG'?f.file:f.pixelTruth.sourceRgbaFile),bytes=readFileSync(target);bytes[bytes.length-1]^=1;writeFileSync(target,bytes);
            const actual=run(temporary);expect(actual.error).toBeUndefined();expect(actual.status).toBe(1);expect(actual.stderr).toContain('source hash');
        }finally{rmSync(temporary,{recursive:true,force:true});}
    });

    it('载荷多一个字节时先拒绝固定读取上限，不进入解压或语义回放',()=>{
        const temporary=mkdtempSync(path.join(tmpdir(),'fluentread-color-size-'));
        try{
            cpSync(fileURLToPath(fixtureRoot),temporary,{recursive:true});
            const target=path.join(temporary,manifest.fixtures[0].pixelTruth.sourceRgbaFile);
            writeFileSync(target,Buffer.concat([readFileSync(target),Buffer.from([0])]));
            const actual=run(temporary);expect(actual.error).toBeUndefined();expect(actual.status).toBe(1);expect(actual.stderr).toContain('pre-read byte length');
        }finally{rmSync(temporary,{recursive:true,force:true});}
    });

    it('中间目录符号链接不能让校验器读取夹具物理目录之外，即使目标内容完全相同',()=>{
        const temporary=mkdtempSync(path.join(tmpdir(),'fluentread-color-boundary-'));
        try{
            cpSync(fileURLToPath(fixtureRoot),temporary,{recursive:true});
            rmSync(path.join(temporary,'truth'),{recursive:true});
            symlinkSync(fileURLToPath(new URL('truth/',fixtureRoot)),path.join(temporary,'truth'),'dir');
            const actual=run(temporary);expect(actual.error).toBeUndefined();expect(actual.status).toBe(1);expect(actual.stderr).toContain('physically stays inside');
        }finally{rmSync(temporary,{recursive:true,force:true});}
    });

    it('实际首轮stock结果保留完整失败，重新评价不使用expectedSource替代真实识别',()=>{
        const baselineBytes=readFileSync(new URL('first-ocr-baseline.json',fixtureRoot));
        expect(sha(baselineBytes)).toBe('9fb02356959b5611f51f76406676f4db2b06bda0bd80a994b02a3a1ef5d3936b');
        const baseline=JSON.parse(baselineBytes.toString());
        expect(baseline.sourceManifestSha256).toBe(sha(original));expect(baseline.sourceBeforeAnyOcr).toBe(true);
        expect(baseline.scope).toContain('actual stock');expect(baseline.scenes.map((scene:any)=>scene.scene)).toEqual(manifest.fixtures.map((f:any)=>f.name));
        for(const f of manifest.fixtures){
            const actual=baseline.scenes.find((row:any)=>row.scene===f.name);
            expect(actual.expectedSource).toEqual(f.expectedSource);
            const quality=evaluateQualityFixture(f,{texts:actual.texts,lines:actual.ocrLines}),order=evaluateQualityReadingOrder(f,actual.texts);
            expect(actual.anchors).toEqual(quality.anchors);
            const semantic=actual.qualityFailures.filter((failure:any)=>failure.type!=='protected-artwork-pixel');
            expect(semantic).toEqual([...quality.qualityFailures,...order.qualityFailures]);
        }
        expect(baseline.qualitySummary).toMatchObject({completedScenes:8,anchors:{total:34,matched:27,failed:7},strictScenes:{passed:1,total:8},negativeRegions:{declared:15,falsePositives:0}});
        expect(baseline.strictPass).toBe(false);
        expect(baseline.pixelAcceptance).toMatchObject({rawTruthPassedScenes:6,nativePreservationPassedScenes:8});
        expect(baseline.pixelAcceptance.passed).toBe(false); // 首轮真实raw/native像素失败不能因源夹具CI通过而变绿。
    });
});
