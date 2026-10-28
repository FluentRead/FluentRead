/**
 * @file scripts/testing/check-manga-color-quality-fixtures.cjs
 * 文件职责：无需字体或模型，核验八类原创彩色漫画的不可变输入与质量验收反例。
 * 主要内容：固定完整 manifest/design 摘要，逐文件校验像素来源；有界读取原 RGBA 验证保护点和孔洞，调用公共验收 helper 拒绝错字、误合段与误报。
 * 模块边界：只读测试夹具，不模拟生产 OCR、不启动浏览器、不下载资源；源像素完整性不能替代实际输出验收。
 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto'),{gunzipSync}=require('node:zlib');
const {values}=require('node:util').parseArgs({options:{'repository-root':{type:'string'},'fixture-dir':{type:'string'}},strict:true,allowPositionals:false});
const repo=path.resolve(values['repository-root']??path.join(__dirname,'../..'));
const root=path.resolve(values['fixture-dir']??path.join(repo,'tests/fixtures/manga-color-quality'));
const {validateQualityFixtureExpectations,evaluateQualityFixture,evaluateQualityReadingOrder}=require(path.join(repo,'scripts/testing/manga-quality-corpus.cjs'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
function fixedMetadata(name,bytes){const target=path.join(root,name),stat=fs.lstatSync(target);assert.ok(stat.isFile(),'Frozen metadata is a regular file');assert.equal(stat.size,bytes,name==='manifest.json'?'Complete pre-first-OCR manifest is immutable: fixed pre-read byte length':'Frozen metadata has a fixed pre-read byte limit');return fs.readFileSync(target);}
const manifestBytes=fixedMetadata('manifest.json',91170);
// 摘要来自首轮 OCR 前的独立源冻结，不从待测文件重新推导“正确真值”。原 generator 字段也保留历史字节。
assert.equal(sha(manifestBytes),'3ceb90f8fc34d3b261898ae5045d4002873ca471dd7ff8e57e72dee6274b444f','Complete pre-first-OCR manifest is immutable');
const manifest=JSON.parse(manifestBytes),designBytes=fixedMetadata('design.json',24284),design=JSON.parse(designBytes);
assert.equal(sha(Buffer.from(JSON.stringify(canonical(manifest.fixtures)))),'ccb3880e50f3f25656d7bd51925254e0489c4c03243bcb5d1e58f3cb4156a16c');
assert.equal(sha(designBytes),'b24b2d1ee63ea1ad03e1770126410cea2f82b271c35fd14d0a4f15295cc68acf','Pre-first-OCR design is immutable');
assert.equal(manifest.designSha256,sha(designBytes));assert.equal(manifest.fixtures.length,8);
assert.equal(new Set(manifest.fixtures.map(f=>f.name)).size,8);assert.deepEqual(manifest.fixtures.map(f=>f.name),design.scenes.map(s=>s.name));

const physicalRoot=fs.realpathSync(root);
function file(relative){
    const resolved=path.resolve(root,relative);assert.ok(resolved.startsWith(root+path.sep),'Source artifact stays inside the fixture directory');
    const stat=fs.lstatSync(resolved);assert.ok(stat.isFile(),'Source artifact is a regular file');
    assert.ok(fs.realpathSync(resolved).startsWith(physicalRoot+path.sep),'Source artifact physically stays inside the fixture directory');
    const spec=manifest.artifactInventory[relative];assert.ok(spec,'Source artifact has a frozen inventory entry');assert.equal(stat.size,spec.bytes,relative+' pre-read byte length');
    return fs.readFileSync(resolved);
}
function pngHeader(bytes,width,height){
    assert.deepEqual(bytes.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));assert.equal(bytes.readUInt32BE(8),13);assert.equal(bytes.toString('ascii',12,16),'IHDR');
    assert.equal(bytes.readUInt32BE(16),width);assert.equal(bytes.readUInt32BE(20),height);assert.deepEqual([...bytes.subarray(24,29)],[8,6,0,0,0],'Frozen sources and glyphs retain 8-bit RGBA');
}
function validBox(b,f){assert.ok([b.x0,b.y0,b.x1,b.y1].every(Number.isSafeInteger));assert.ok(b.x0>=0&&b.y0>=0&&b.x1>b.x0&&b.y1>b.y0&&b.x1<=f.width&&b.y1<=f.height);}
const intersects=(a,b)=>Math.min(a.x1,b.x1)>Math.max(a.x0,b.x0)&&Math.min(a.y1,b.y1)>Math.max(a.y0,b.y0);
const pixel=(raw,width,x,y)=>[...raw.subarray((y*width+x)*4,(y*width+x+1)*4)];
const counts={scenes:0,anchors:0,paragraphs:0,negativeRegions:0,rgbProbes:0,rgbaProbes:0,protectedRgbaPixels:0,sourceRgbaBytes:0,payloadFiles:0,perfectTruthReplays:0,singleCharacterRejected:0,duplicatesRejected:0,artInjectionsRejected:0,paragraphMergesRejected:0,paragraphSplitsRejected:0,extraTextRejected:0,wordlessPunctuationRejected:0};
for(const [relative,spec]of Object.entries(manifest.artifactInventory)){
    const bytes=file(relative);assert.equal(bytes.length,spec.bytes,relative+' byte length');assert.equal(sha(bytes),spec.sha256,relative+' source hash');counts.payloadFiles++;
}
assert.equal(counts.payloadFiles,58);
const results=[];
function transport(f,overrides={}){
    const byId=new Map(f.regions.map(r=>[r.id,r]));
    return {texts:(f.paragraphGroups??[]).map(ids=>ids.map(id=>overrides[id]??byId.get(id).text).join(' ')),lines:f.regions.map(r=>({text:overrides[r.id]??r.text,sourceText:overrides[r.id]??r.text,bbox:r.bbox,sourceBoxes:[r.bbox]}))};
}
const failure=(f,actual,type)=>assert.ok(evaluateQualityFixture(f,actual).qualityFailures.some(x=>x.type===type),f.name+' must reject '+type);
for(const f of manifest.fixtures){
    validateQualityFixtureExpectations(f);const planned=design.scenes.find(s=>s.name===f.name);
    assert.deepEqual(f.expectedSource,f.regions.map(r=>r.text));assert.deepEqual(f.expectedAnchors,f.expectedSource);assert.deepEqual(f.expectedSource,planned.regions.map(r=>r.text));
    assert.deepEqual(f.regions.map(r=>r.id),planned.regions.map(r=>r.id));assert.equal(f.provenance.selectionByOcrResult,false);assert.equal(f.provenance.sourceDesignedBeforeAnyOcr,true);
    const input=file(f.file);assert.equal(sha(input),f.sha256);assert.equal(input.length,f.bytes);pngHeader(input,f.width,f.height);assert.equal(f.imageMode,'RGBA');
    for(const r of f.regions){const g=r.glyphTruth;validBox(r.bbox,f);pngHeader(file(g.file),g.width,g.height);assert.equal(sha(file(g.file)),g.sha256);}
    pngHeader(file(f.pixelTruth.backgroundFile),f.width,f.height);
    const rawBytes=f.width*f.height*4;assert.equal(rawBytes,f.pixelTruth.sourceRgbaBytes);assert.ok(Number.isSafeInteger(rawBytes)&&rawBytes>0&&rawBytes<=6_600_000);
    // 完整 manifest 先固定，单景解压有硬上限；不为整个语料保留所有未压缩像素。
    const raw=gunzipSync(file(f.pixelTruth.sourceRgbaFile),{maxOutputLength:rawBytes});assert.equal(raw.length,rawBytes);assert.equal(sha(raw),f.pixelTruth.sourceRgbaSha256);counts.sourceRgbaBytes+=raw.length;
    for(const probe of [...f.protectedProbes,...f.protectedRgbaProbes]){
        assert.ok(Number.isSafeInteger(probe.x)&&Number.isSafeInteger(probe.y)&&probe.x>=0&&probe.y>=0&&probe.x<f.width&&probe.y<f.height);
        if(probe.rgb)assert.ok(!f.regions.some(r=>probe.x>=r.bbox.x0&&probe.x<r.bbox.x1&&probe.y>=r.bbox.y0&&probe.y<r.bbox.y1),'Opaque artwork point is outside source glyph boxes');
        const rgba=pixel(raw,f.width,probe.x,probe.y);assert.deepEqual(rgba,probe.rgba??[...probe.rgb,255]);if(probe.rgba)counts.rgbaProbes++;else counts.rgbProbes++;
    }
    for(const region of f.protectedRgbaRegions){
        validBox(region.bbox,f);assert.ok(!f.regions.some(r=>intersects(region.bbox,r.bbox)),'Protected rectangle is outside source glyph boxes');
        const b=region.bbox,digest=createHash('sha256');let pixels=0;
        for(let y=b.y0;y<b.y1;y++){const bytes=raw.subarray((y*f.width+b.x0)*4,(y*f.width+b.x1)*4);assert.ok(bytes.every(value=>value===0),'Every transparent-hole RGBA channel remains frozen');digest.update(bytes);pixels+=bytes.length/4;}
        assert.equal(pixels,region.pixels);assert.equal(digest.digest('hex'),region.rgbaSha256);counts.protectedRgbaPixels+=pixels;
    }
    const exact=transport(f);assert.deepEqual(evaluateQualityFixture(f,exact).qualityFailures,[]);assert.deepEqual(evaluateQualityReadingOrder(f,exact.texts).qualityFailures,[]);counts.perfectTruthReplays++;
    for(const r of f.regions){
        const wrong=r.text.replace(/[\p{L}\p{N}]/u,c=>c==='Ω'?'Ψ':'Ω');assert.notEqual(wrong,r.text);failure(f,transport(f,{[r.id]:wrong}),'ocr-anchor');counts.singleCharacterRejected++;
        const line=exact.lines.find(l=>l.sourceText===r.text);failure(f,{texts:[...exact.texts,r.text],lines:[...exact.lines,line]},'duplicate-anchor');counts.duplicatesRejected++;
    }
    for(const n of f.forbiddenRegions){
        const b={x0:n.bbox.x0+1,y0:n.bbox.y0+1,x1:Math.min(n.bbox.x1,n.bbox.x0+5),y1:Math.min(n.bbox.y1,n.bbox.y0+5)};
        const sourceText='UNDECLARED ART NOTE',actual={texts:[...exact.texts,sourceText],lines:[...exact.lines,{sourceText,bbox:b,sourceBoxes:[b]}]};
        const evaluated=evaluateQualityFixture(f,actual);assert.ok(evaluated.anchors.every(anchor=>anchor.found));assert.ok(evaluated.qualityFailures.some(x=>x.type==='artwork-ocr-false-positive'));counts.artInjectionsRejected++;
    }
    if(f.expectedNoText){
        assert.equal(f.paragraphGroups,undefined);assert.deepEqual(f.regions,[]);assert.deepEqual(f.expectedSource,[]);
        const sourceText='?!...',b=f.forbiddenRegions[0].bbox;failure(f,{texts:[sourceText],lines:[{sourceText,bbox:b,sourceBoxes:[b]}]},'wordless-page-text');counts.wordlessPunctuationRejected++;
    }else{
        assert.ok(evaluateQualityReadingOrder(f,[exact.texts.join(' ')]).qualityFailures.some(x=>x.type==='paragraph-order'));counts.paragraphMergesRejected++;
        assert.ok(evaluateQualityReadingOrder(f,f.regions.map(r=>r.text)).qualityFailures.some(x=>x.type==='paragraph-order'));counts.paragraphSplitsRejected++;
        const sourceText='UNDECLARED EXTRA',b=f.regions[0].bbox,actual={texts:[...exact.texts,sourceText],lines:[...exact.lines,{sourceText,bbox:b,sourceBoxes:[b]}]};
        const evaluated=evaluateQualityFixture(f,actual);assert.ok(evaluated.anchors.every(anchor=>anchor.found));assert.deepEqual(evaluated.negativeDetections,[]);assert.ok(evaluated.qualityFailures.some(x=>x.type==='unexpected-ocr-characters'));counts.extraTextRejected++;
        assert.deepEqual([...f.paragraphGroups.flat()].sort(),f.regions.map(r=>r.id).sort());
    }
    counts.scenes++;counts.anchors+=f.expectedAnchors.length;counts.paragraphs+=(f.paragraphGroups??[]).length;counts.negativeRegions+=f.forbiddenRegions.length;
    results.push({scene:f.name,anchors:f.expectedAnchors.length,paragraphs:(f.paragraphGroups??[]).length,sourceSha256:f.sha256,sourceRgbaSha256:f.pixelTruth.sourceRgbaSha256});
}
assert.equal(counts.anchors,34);assert.equal(counts.paragraphs,23);assert.equal(counts.negativeRegions,15);assert.equal(counts.rgbProbes,21);assert.equal(counts.rgbaProbes,8);assert.equal(counts.protectedRgbaPixels,4800);assert.equal(counts.sourceRgbaBytes,44_880_000);
assert.equal(counts.singleCharacterRejected,34);assert.equal(counts.duplicatesRejected,34);assert.equal(counts.artInjectionsRejected,15);assert.equal(counts.paragraphMergesRejected,7);assert.equal(counts.paragraphSplitsRejected,7);assert.equal(counts.extraTextRejected,7);assert.equal(counts.wordlessPunctuationRejected,1);
console.log(JSON.stringify({passed:true,manifestSha256:sha(manifestBytes),designSha256:sha(designBytes),counts,results,scope:'Frozen source bytes/RGBA declarations and public acceptance-gate counterexamples only. No actual OCR, browser output, alpha repair, online translation or performance acceptance.'},null,2));
