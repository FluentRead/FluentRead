/**
 * @file tests/mangaColorQualityCorpus.test.ts
 * 文件职责：让八类冻结彩色漫画、六类透明漫画及其严格验收反例进入常规 functional 回归。
 * 主要内容：通过可移植 Node checker 校验彩色源、用窄格式 PNG 解码器验收透明源 RGBA，并回放两类漫画中的有界段落像素证明。
 * 模块边界：调用生产段落分组和像素旁证，不调用OCR、模型、图像修补、浏览器或字体；真值回放只验证给定原文与像素的分组行为，不声称OCR或整页通过。
 */
import {describe,expect,it} from 'vitest';
import {readFileSync,writeFileSync,cpSync,mkdtempSync,rmSync,symlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync,inflateSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {collectMangaRegions} from '@/src/features/image-translation/services/mangaBubbles';
import {produceImageParagraphGapProofs} from '@/src/features/image-translation/services/imageParagraphGapEvidence';

// 完整静态目录引用保留 PNG/gzip-only 变化的 affected 依赖，脚本也各自显式登记。
const fixtureRoot=new URL('./fixtures/manga-color-quality/',import.meta.url);
const checker=new URL('../scripts/testing/check-manga-color-quality-fixtures.cjs',import.meta.url);
const generator=new URL('../scripts/testing/generate-manga-color-quality-fixtures.py',import.meta.url);
const alphaRoot=new URL('./fixtures/manga-alpha/',import.meta.url);
const recordedRoot=new URL('./fixtures/manga-paragraph-recordings/',import.meta.url);
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const characterKey=(text:string)=>Array.from(text.normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}]/gu,'')).sort().join('');
const markHighContrastPixel=(pixels:Uint8ClampedArray,offset:number)=>{
    const average=(pixels[offset]!+pixels[offset+1]!+pixels[offset+2]!)/3,value=average<128?255:0;
    pixels.set([value,value,value,255],offset);
};
const original=readFileSync(new URL('manifest.json',fixtureRoot));
const manifest=JSON.parse(original.toString());
const {evaluateQualityFixture,evaluateQualityReadingOrder}=require('../scripts/testing/manga-quality-corpus.cjs');
const run=(directory?:string)=>spawnSync(process.execPath,[fileURLToPath(checker),...(directory?['--fixture-dir',directory]:[])],{encoding:'utf8',timeout:30_000,maxBuffer:4*1024*1024});

/** Decode only the frozen 8-bit RGBA, non-interlaced PNG profile; the pinned decoded-pixel digest is the oracle. */
function decodeFrozenRgbaPng(bytes:Buffer,width:number,height:number):Uint8ClampedArray {
    if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Invalid PNG signature');
    let offset=8,header=false,ended=false;const compressed:Buffer[]=[];
    while(offset<bytes.length){
        if(offset+12>bytes.length)throw new Error('Truncated PNG chunk');
        const length=bytes.readUInt32BE(offset),kind=bytes.toString('ascii',offset+4,offset+8),start=offset+8,end=start+length;
        if(end+4>bytes.length)throw new Error('Truncated PNG payload');
        if(kind==='IHDR'){
            if(header||length!==13||bytes.readUInt32BE(start)!==width||bytes.readUInt32BE(start+4)!==height
                ||bytes[start+8]!==8||bytes[start+9]!==6||bytes[start+10]!==0||bytes[start+11]!==0||bytes[start+12]!==0)
                throw new Error('Unexpected frozen RGBA PNG header');
            header=true;
        }else if(kind==='IDAT')compressed.push(bytes.subarray(start,end));
        else if(kind==='IEND'){ended=true;offset=end+4;break;}
        offset=end+4;
    }
    if(!header||!ended||offset!==bytes.length)throw new Error('Invalid PNG framing');
    const stride=width*4,filtered=inflateSync(Buffer.concat(compressed),{maxOutputLength:(stride+1)*height});
    if(filtered.length!==(stride+1)*height)throw new Error('Unexpected frozen RGBA PNG pixel length');
    const output=Buffer.allocUnsafe(stride*height),paeth=(a:number,b:number,c:number)=>{
        const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;
    };
    let source=0;
    for(let y=0;y<height;y++){
        const filter=filtered[source++]!;
        for(let x=0;x<stride;x++){
            const raw=filtered[source++]!,left=x>=4?output[y*stride+x-4]!:0,up=y?output[(y-1)*stride+x]!:0,upperLeft=y&&x>=4?output[(y-1)*stride+x-4]!:0;
            const predictor=filter===0?0:filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):filter===4?paeth(left,up,upperLeft):undefined;
            if(predictor===undefined)throw new Error('Unexpected frozen PNG row filter');
            output[y*stride+x]=(raw+predictor)&255;
        }
    }
    return new Uint8ClampedArray(output);
}

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

    it('八种不同画面按独立气泡真值合段，保留全部字符并拒绝错误段落顺序',()=>{
        for(const fixture of manifest.fixtures){
            const regions=fixture.regions??[];
            const items=regions.map((region:any)=>{
                const {x0,y0,x1,y1}=region.bbox;
                return {text:region.text,confidence:.99,box:{x:x0,y:y0,width:x1-x0,height:y1-y0}};
            });
            const layouts=(fixture.paragraphGroups??[]).map((ids:string[])=>{
                const members=ids.map((id:string)=>{
                    const index=regions.findIndex((candidate:any)=>candidate.id===id);
                    expect(index,`${fixture.name}: ${id}`).toBeGreaterThanOrEqual(0);
                    return index;
                });
                const selected=members.map(index=>regions[index]);
                return {members,bbox:{x0:Math.min(...selected.map((region:any)=>region.bbox.x0)),
                    y0:Math.min(...selected.map((region:any)=>region.bbox.y0)),
                    x1:Math.max(...selected.map((region:any)=>region.bbox.x1)),
                    y1:Math.max(...selected.map((region:any)=>region.bbox.y1))}};
            });
            const grouped=collectMangaRegions({results:items,layoutBubbles:layouts},fixture.sourceLanguage,fixture.width,fixture.height,'manga');
            expect(characterKey(grouped.map((region:any)=>region.text).join('')),fixture.name).toBe(characterKey(items.map((item:any)=>item.text).join('')));
            expect(evaluateQualityReadingOrder(fixture,grouped.map((region:any)=>region.text)).qualityFailures,fixture.name).toEqual([]);
        }
    });

    it('八景用冻结原像素证明额外整页续行，无像素证据时保持严格分组',()=>{
        const expected:Record<string,{proofs:number;before:number;after:number}>={
            'harbor-same-red-channel-dialogue':{proofs:2,before:2,after:0},
            'prism-platform-gradient-signs':{proofs:1,before:1,after:0},
            'rain-garden-vertical-ruby-sidebar':{proofs:1,before:1,after:0},
            'chess-picnic-neighbor-inverse-bubbles':{proofs:2,before:2,after:0},
            'lantern-market-oblique-bilingual-captions':{proofs:1,before:1,after:0},
            'watercolor-ferry-translucent-notification':{proofs:1,before:1,after:0},
            'orbital-greenhouse-cutout-dialogue':{proofs:0,before:0,after:0},
            'wordless-stained-glass-cutout-garden':{proofs:0,before:0,after:0},
        };
        for(const fixture of manifest.fixtures){
            const pixels=gunzipSync(readFileSync(new URL(fixture.pixelTruth.sourceRgbaFile,fixtureRoot)),{maxOutputLength:fixture.width*fixture.height*4});
            expect(pixels).toHaveLength(fixture.width*fixture.height*4);
            const results=(fixture.regions??[]).map((region:any)=>{
                const {x0,y0,x1,y1}=region.bbox;
                return {text:region.text,confidence:.99,box:{x:x0,y:y0,width:x1-x0,height:y1-y0}};
            });
            const page={results},proofs=produceImageParagraphGapProofs(page,fixture.width,fixture.height,new Uint8ClampedArray(pixels));
            if(fixture.name==='prism-platform-gradient-signs'){
                expect(proofs.map(proof=>proof.mode)).toEqual(['column-profile']);
                const altered=new Uint8ClampedArray(pixels);altered[(180*fixture.width+500)*4]^=1;
                expect(produceImageParagraphGapProofs(page,fixture.width,fixture.height,altered),'a single changed gap pixel revokes the gradient proof').toEqual([]);
            }
            if(fixture.name==='watercolor-ferry-translucent-notification'){
                expect(proofs.map(proof=>proof.mode)).toEqual(['smooth-field']);
                const altered=new Uint8ClampedArray(pixels),offset=(250*fixture.width+500)*4;markHighContrastPixel(altered,offset);
                expect(produceImageParagraphGapProofs(page,fixture.width,fixture.height,altered),'a high-contrast mark in a smooth translucent gap revokes its proof').toEqual([]);
            }
            const baseline=collectMangaRegions(page,fixture.sourceLanguage,fixture.width,fixture.height,'manga');
            const actual=collectMangaRegions({...page,imageParagraphGapProofs:proofs},fixture.sourceLanguage,fixture.width,fixture.height,'manga',fixture.name);
            const before=evaluateQualityReadingOrder(fixture,baseline.map(line=>line.text)).qualityFailures;
            const after=evaluateQualityReadingOrder(fixture,actual.map(line=>line.text)).qualityFailures;
            expect(proofs.length,fixture.name).toBe(expected[fixture.name].proofs);
            expect(before.length,`${fixture.name} baseline`).toBe(expected[fixture.name].before);
            expect(after.length,`${fixture.name} with pixel proof`).toBe(expected[fixture.name].after);
            expect(after.length,`${fixture.name} has no new paragraph failures`).toBeLessThanOrEqual(before.length);
            expect(characterKey(actual.map((line:any)=>line.text).join('')),fixture.name).toBe(characterKey(results.map((line:any)=>line.text).join('')));
        }
    });

    it('六类冻结透明场景只按同帧像素证明续接，不跨段误合并且像素变化会撤销证明',()=>{
        const bytes=readFileSync(new URL('manifest.json',alphaRoot)),alpha=JSON.parse(bytes.toString());
        expect(sha(bytes)).toBe('d5067fdf9438ff253c2124aaf665094f67ac5361847c56ccabfe806cded10060');
        expect(alpha.fixtures.map((fixture:any)=>fixture.name)).toEqual([
            'transparent-lantern-bridge-balloons','translucent-riverside-notice','perforated-alpha-dock-note',
            'same-tone-cabin-controls','inverse-neighbor-tidal-balloons','bound-atlas-rule-and-inset-card',
        ]);
        const expected:Record<string,{proofs:number;before:number;after:number}>= {
            'transparent-lantern-bridge-balloons':{proofs:0,before:2,after:2},
            'translucent-riverside-notice':{proofs:0,before:1,after:1},
            'perforated-alpha-dock-note':{proofs:0,before:1,after:1},
            'same-tone-cabin-controls':{proofs:1,before:1,after:0},
            'inverse-neighbor-tidal-balloons':{proofs:2,before:2,after:0},
            'bound-atlas-rule-and-inset-card':{proofs:0,before:2,after:2},
        };
        for(const fixture of alpha.fixtures){
            const png=readFileSync(new URL(fixture.file,alphaRoot));expect(png.length,fixture.name).toBe(fixture.bytes);expect(sha(png),fixture.name).toBe(fixture.sha256);
            const pixels=decodeFrozenRgbaPng(png,fixture.width,fixture.height),pixelBytes=Buffer.from(pixels.buffer,pixels.byteOffset,pixels.byteLength);
            expect(sha(pixelBytes),fixture.name).toBe(fixture.decodedRgbaSha256);
            const results=fixture.regions.map((region:any)=>({text:region.text,confidence:.99,
                box:{x:region.bbox.x0,y:region.bbox.y0,width:region.bbox.x1-region.bbox.x0,height:region.bbox.y1-region.bbox.y0}}));
            const page={results},proofs=produceImageParagraphGapProofs(page,fixture.width,fixture.height,pixels);
            const baseline=collectMangaRegions(page,fixture.sourceLanguage,fixture.width,fixture.height,'manga');
            const actual=collectMangaRegions({...page,imageParagraphGapProofs:proofs},fixture.sourceLanguage,fixture.width,fixture.height,'manga',fixture.name);
            const before=evaluateQualityReadingOrder(fixture,baseline.map((line:any)=>line.text)).qualityFailures;
            const after=evaluateQualityReadingOrder(fixture,actual.map((line:any)=>line.text)).qualityFailures;
            expect(proofs.length,`${fixture.name} proof count`).toBe(expected[fixture.name].proofs);
            expect(before.length,`${fixture.name} baseline`).toBe(expected[fixture.name].before);
            expect(after.length,`${fixture.name} with pixel proof`).toBe(expected[fixture.name].after);
            expect(after.length,`${fixture.name} adds no paragraph failures`).toBeLessThanOrEqual(before.length);
            expect(characterKey(actual.map((line:any)=>line.text).join('')),fixture.name).toBe(characterKey(results.map((item:any)=>item.text).join('')));
            for(const proof of proofs){
                const a=proof.previous.box,b=proof.next.box,x0=Math.max(a.x,b.x),x1=Math.min(a.x+a.width,b.x+b.width),y=Math.ceil(a.y+a.height)+Math.floor((b.y-(a.y+a.height))/2);
                expect(x1).toBeGreaterThan(x0);expect(y).toBeGreaterThanOrEqual(0);expect(y).toBeLessThan(fixture.height);
                const altered=new Uint8ClampedArray(pixels),offset=(y*fixture.width+Math.floor((x0+x1)/2))*4;markHighContrastPixel(altered,offset);
                expect(produceImageParagraphGapProofs(page,fixture.width,fixture.height,altered).some(candidate=>candidate.previous.text===proof.previous.text&&candidate.next.text===proof.next.text),
                    `${fixture.name}: a marked gap pixel revokes ${proof.previous.text} → ${proof.next.text}`).toBe(false);
            }
        }
    });

    it('14个已录制真实OCR场景按原图像素证明续行，恢复6项段落失败且不新增错误',()=>{
        const recordBytes=readFileSync(new URL('recorded-v14.json',recordedRoot)),record=JSON.parse(recordBytes.toString());
        expect(sha(recordBytes)).toBe('937d02b27f85a1b4bd68bda5c664810e3d8c2a31cbcf1b10cd9a83e765f8ef16');
        expect(record).toMatchObject({version:1,provenance:{sceneCount:14,sourceStatus:'failed'}});expect(record.scenes).toHaveLength(14);
        const alphaBytes=readFileSync(new URL('manifest.json',alphaRoot)),alpha=JSON.parse(alphaBytes.toString());
        const fixtureByName=new Map([...manifest.fixtures,...alpha.fixtures].map((fixture:any)=>[fixture.name,fixture]));
        const alphaNames=new Set(alpha.fixtures.map((fixture:any)=>fixture.name));
        const resolvedPairs=[
            ['harbor-same-red-channel-dialogue','IWILL WAIT BY THE PIER.','KEEP THE LANTERN LIT.'],
            ['prism-platform-gradient-signs','FOLLOW THE EASTERN TRACK','THE NEXT TRAIN IS ALMOST HERE'],
            ['chess-picnic-neighbor-inverse-bubbles','THE BOARD IS READY.','I SAVED YOU A SEAT.'],
            ['lantern-market-oblique-bilingual-captions','THE LANTERNS ARE STILL WARM.','LET US WALK HOME TOGETHER.'],
            ['same-tone-cabin-controls','KEEP THE CABIN CLOSED','THE CREW RETURNS AT DAWN'],
            ['inverse-neighbor-tidal-balloons','WE CAN CROSS NOW','THE TIDE IS FALLING'],
        ];
        let baselineFailures=0,replayFailures=0,recordedFailures=0;const observedPairs:string[][]=[];
        for(const scene of record.scenes){
            const fixture=fixtureByName.get(scene.name) as any;expect(fixture,scene.name).toBeDefined();
            const root=alphaNames.has(scene.name)?alphaRoot:fixtureRoot,png=readFileSync(new URL(fixture.file,root));
            expect(sha(png),scene.name).toBe(scene.sourcePngSha256);
            const pixels=decodeFrozenRgbaPng(png,fixture.width,fixture.height),pixelBytes=Buffer.from(pixels.buffer,pixels.byteOffset,pixels.byteLength);
            expect(sha(pixelBytes),scene.name).toBe(scene.decodedRgbaSha256);
            expect([scene.width,scene.height,scene.sourceLanguage]).toEqual([fixture.width,fixture.height,fixture.sourceLanguage]);
            const recorded=evaluateQualityReadingOrder(fixture,scene.recordedTexts).qualityFailures.filter((failure:any)=>failure.type==='paragraph-order').map(({type,anchors,paragraphIndex}:any)=>({type,anchors,paragraphIndex}));
            expect(recorded,`${scene.name} frozen recorded result`).toEqual(scene.recordedParagraphFailures);
            recordedFailures+=recorded.length;
            const results=scene.lines.filter((line:any)=>typeof line.text==='string'&&line.text.trim()).map((line:any)=>({
                text:line.text,confidence:1,box:{x:line.bbox.x0,y:line.bbox.y0,width:line.bbox.x1-line.bbox.x0,height:line.bbox.y1-line.bbox.y0},
            }));
            const page={results},proofs=produceImageParagraphGapProofs(page,fixture.width,fixture.height,pixels);
            const before=collectMangaRegions(page,fixture.sourceLanguage,fixture.width,fixture.height,'manga');
            const after=collectMangaRegions({...page,imageParagraphGapProofs:proofs},fixture.sourceLanguage,fixture.width,fixture.height,'manga',scene.name);
            const beforeFailures=evaluateQualityReadingOrder(fixture,before.map((line:any)=>line.text)).qualityFailures.filter((failure:any)=>failure.type==='paragraph-order');
            const afterFailures=evaluateQualityReadingOrder(fixture,after.map((line:any)=>line.text)).qualityFailures.filter((failure:any)=>failure.type==='paragraph-order');
            baselineFailures+=beforeFailures.length;replayFailures+=afterFailures.length;
            expect(afterFailures.length,`${scene.name} adds no paragraph failure`).toBeLessThanOrEqual(beforeFailures.length);
            expect(characterKey(after.map((line:any)=>line.text).join('')),scene.name).toBe(characterKey(results.map((line:any)=>line.text).join('')));
            for(const proof of proofs)for(const text of [proof.previous.text,proof.next.text]){
                const source=scene.lines.find((line:any)=>line.text===text);expect(source,`${scene.name}: recorded line ${text}`).toBeDefined();
                expect(source.sourceBoxes,`${scene.name}: proof endpoint is one original source box`).toEqual([source.bbox]);
            }
            observedPairs.push(...proofs.map((proof:any)=>[scene.name,proof.previous.text,proof.next.text]));
            for(const proof of proofs){
                const a=proof.previous.box,b=proof.next.box,x0=Math.max(a.x,b.x),x1=Math.min(a.x+a.width,b.x+b.width),y=Math.ceil(a.y+a.height)+Math.floor((b.y-(a.y+a.height))/2);
                const altered=new Uint8ClampedArray(pixels),offset=(y*fixture.width+Math.floor((x0+x1)/2))*4;markHighContrastPixel(altered,offset);
                expect(produceImageParagraphGapProofs(page,fixture.width,fixture.height,altered).some((candidate:any)=>candidate.previous.text===proof.previous.text&&candidate.next.text===proof.next.text),
                    `${scene.name}: a modified gap pixel revokes ${proof.previous.text} → ${proof.next.text}`).toBe(false);
            }
        }
        expect(recordedFailures).toBe(20);expect(baselineFailures).toBe(19);expect(replayFailures).toBe(13);
        expect(baselineFailures-replayFailures).toBe(6);
        expect(observedPairs).toEqual(resolvedPairs);
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
