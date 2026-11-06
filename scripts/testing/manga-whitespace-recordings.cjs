'use strict';
/**
 * @file scripts/testing/manga-whitespace-recordings.cjs
 * 文件职责：读取仓库内固定的空格研究行，把完整已观测批次交给真实生产 controller 做零模型回放。
 * 主要内容：先限制 JSON、PNG、行数、尺寸、时间步和 sparse 字典，再校验原读序到局部索引映射；
 * PNG 只支持本语料明确生成的 RGBA8/filter0 格式，以 Node 内置 zlib 无损还原，不引入模型、字体或图像依赖。
 * CTC 只重建 argmax/max/blank/space 充分统计 surrogate，未观察类别归零，不宣称原完整 logits；
 * 每个完整 cohort 使用独立 selected-window 页账本，不能冒称缺少四十二行像素的历史整页账本。
 * 模块边界：只用于确定性离线测试，不导入 SDK 私有模块，不调用生产推理或改变产品阈值。
 */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{inflateSync}=require('node:zlib');
const LIMIT=Object.freeze({rows:32,cohorts:6,pixels:22,width:2048,height:48,T:256,C:18710,frames:4096,pngBytes:65536,jsonBytes:350000,totalBytes:1000000});
const PARTS=['observations.json','truth.json','sdk-output.json','replay-expected.json','sparse-dictionary.json','provenance.json'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const text=value=>typeof value==='string'&&value.length<=4096;
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;}
function decodeMangaWhitespacePng(bytes,width,height=48){
    assert.ok(Buffer.isBuffer(bytes)&&bytes.length<=LIMIT.pngBytes,'Bounded PNG bytes');
    assert.ok(integer(width,8,LIMIT.width)&&height===LIMIT.height,'Bounded PNG dimensions before inflate');
    assert.deepEqual(bytes.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]),'PNG signature');
    let offset=8,payload;const names=[];
    while(offset<bytes.length){
        assert.ok(offset+12<=bytes.length,'Complete PNG chunk header');const length=bytes.readUInt32BE(offset);
        assert.ok(length<=LIMIT.pngBytes&&offset+12+length<=bytes.length,'Bounded complete PNG chunk');
        const name=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,offset+8+length);
        assert.equal(crc32(bytes.subarray(offset+4,offset+8+length)),bytes.readUInt32BE(offset+8+length),'PNG chunk CRC');names.push(name);
        if(name==='IHDR'){
            assert.equal(length,13,'RGBA IHDR length');assert.equal(data.readUInt32BE(0),width,'PNG width');assert.equal(data.readUInt32BE(4),height,'PNG height');
            assert.deepEqual([...data.subarray(8)],[8,6,0,0,0],'Only RGBA8 non-interlaced PNG');
        }else if(name==='IDAT'){assert.equal(payload,undefined,'One bounded IDAT');payload=data;}
        else{assert.equal(name,'IEND','Only fixture PNG chunks');assert.equal(length,0,'Empty IEND');}
        offset+=length+12;
    }
    assert.deepEqual(names,['IHDR','IDAT','IEND'],'Exact fixture PNG chunk order');
    const stride=width*4,filtered=inflateSync(payload,{maxOutputLength:(stride+1)*height});
    assert.equal(filtered.length,(stride+1)*height,'Exact decompressed scanline budget');
    const rgba=new Uint8ClampedArray(stride*height);
    for(let y=0;y<height;y++){assert.equal(filtered[y*(stride+1)],0,'Only filter0 fixture scanlines');rgba.set(filtered.subarray(y*(stride+1)+1,(y+1)*(stride+1)),y*stride);}
    return rgba;
}
function validateMangaWhitespaceRecordingData(data){
    const {manifest:m,observations,truth,sdk,expected,dictionary,provenance}=data;
    assert.ok(m&&m.version===1&&m.kind==='recorded-whitespace-sufficient-statistics','Recording version');
    assert.ok(m.classCount===LIMIT.C&&m.height===48&&m.rowCount===32&&m.cohortCount===6&&m.pixelCount===22,'Fixed bounded recording shape');
    assert.ok(Array.isArray(m.cohorts)&&m.cohorts.length===6&&Array.isArray(m.pixels)&&m.pixels.length===22,'Bounded cohort and PNG inventories');
    assert.equal(m.syntheticCompanions,false,'No synthetic row packaged as original');
    assert.equal(m.historicalFullpageAlphaProved,false,'No historical alpha proof');assert.equal(m.historicalFullpageLedgerReproduced,false,'Selected-window ledger only');
    assert.ok(dictionary?.classCount===LIMIT.C&&dictionary.kind==='sparse-observed-ID-to-character-facts'&&hash(dictionary.dictionaryFileSha256),'Sparse observer dictionary provenance');
    const entries=Object.entries(dictionary.entries??{});assert.ok(entries.length>2&&entries.length<=512,'Bounded sparse dictionary');
    for(const [key,value]of entries){assert.ok(/^(0|[1-9]\d*)$/u.test(key)&&integer(Number(key),0,LIMIT.C-1),'Sparse dictionary ID');assert.ok(typeof value==='string'&&value.length<=2&&(value.length>0||key==='0'||key===String(LIMIT.C-1)),'Observed dictionary character');}
    assert.equal(dictionary.entries[0],'','Blank dictionary fact');assert.equal(dictionary.entries[LIMIT.C-1],'','Last empty SDK dictionary fact');
    const pixels=new Map();
    for(const p of m.pixels){
        assert.ok(integer(p.width,8,LIMIT.width)&&p.height===48&&p.rgbaBytes===p.width*48*4,'Bounded pixel dimensions');
        assert.ok(hash(p.rgbaSha256)&&hash(p.pngSha256)&&p.file===`pixels/${p.rgbaSha256}.png`&&integer(p.pngBytes,1,LIMIT.pngBytes)&&!pixels.has(p.rgbaSha256),'Relative unique PNG inventory');pixels.set(p.rgbaSha256,p);
    }
    const collections={observations,truth,sdk,expected},maps={};
    for(const [name,value]of Object.entries(collections)){
        assert.ok(value?.version===1&&Array.isArray(value.rows)&&value.rows.length===32,`Bounded ${name} rows`);const map=new Map();
        for(const row of value.rows){assert.ok(typeof row.id==='string'&&row.id.length<=128&&!map.has(row.id),`Unique ${name} ID`);map.set(row.id,row);}maps[name]=map;
    }
    assert.deepEqual(observations.tuple,['argmaxIndex','argmaxValue','blankValue','spaceValue'],'Sufficient-statistic tuple');
    const ids=new Set(),cohortIds=new Set();let frames=0;
    for(const c of m.cohorts){
        assert.ok(typeof c.id==='string'&&!cohortIds.has(c.id)&&c.pageWindow===c.id,'Distinct selected-window scope');cohortIds.add(c.id);
        assert.ok(c.originalCohortComplete===true&&c.syntheticCompanions===false&&c.originalBatchSize===6&&['BGR','enhancedRRR'].includes(c.mode),'Original complete recorded cohort');
        assert.ok(Array.isArray(c.outputShape)&&c.outputShape.length===3&&integer(c.outputShape[0],1,6)&&integer(c.outputShape[1],1,LIMIT.T)&&c.outputShape[2]===LIMIT.C,'Bounded NTC before allocation');
        const [N,T]=c.outputShape;assert.ok(c.height===48&&integer(c.paddedWidth,8,LIMIT.width)&&Array.isArray(c.rows)&&c.rows.length===N,'Complete cohort row count');
        const local=new Set(),original=new Set();let lastWidth=0,lastIndex=-1,maxWidth=0;
        for(let n=0;n<N;n++){
            const r=c.rows[n];assert.ok(r.row===n&&typeof r.id==='string'&&!ids.has(r.id)&&integer(r.replayIndex,0,N-1)&&!local.has(r.replayIndex)&&integer(r.originalReadIndex,0,8191)&&!original.has(r.originalReadIndex),'Original row/read to replay identity');
            assert.ok(r.sourceBox&&['x','y','width','height'].every(key=>Number.isFinite(r.sourceBox[key]))&&r.sourceBox.width>0&&r.sourceBox.height>0&&['assembled-crop-cohort-local','original-fullpage-primary'].includes(r.sourceBoxScope),'Original SDK Box dimensions and scope');
            ids.add(r.id);local.add(r.replayIndex);original.add(r.originalReadIndex);
            assert.ok(integer(r.resizedWidth,8,LIMIT.width)&&(r.resizedWidth>lastWidth||(r.resizedWidth===lastWidth&&r.replayIndex>lastIndex)),'Stable width then original read order');lastWidth=r.resizedWidth;lastIndex=r.replayIndex;maxWidth=Math.max(maxWidth,r.resizedWidth);
            const p=pixels.get(r.pixel);assert.ok(p&&p.width===r.resizedWidth,'Pixel identity and resized width');
            const o=maps.observations.get(r.id),s=maps.sdk.get(r.id),t=maps.truth.get(r.id),e=maps.expected.get(r.id);
            assert.ok(o&&s&&t&&e&&Array.isArray(o.steps)&&o.steps.length===T&&integer(o.validSeq,1,T),'Complete original trace and parallel inventories');
            frames+=T;assert.ok(frames<=LIMIT.frames,'Total frame cap before dense allocation');
            for(const step of o.steps){
                assert.ok(Array.isArray(step)&&step.length===4&&integer(step[0],0,LIMIT.C-1),'Bounded argmax ID');
                assert.ok(Object.hasOwn(dictionary.entries,String(step[0])),'Every observed ID has an original dictionary fact');
                const [index,max,blank,space]=step;
                assert.ok(step.slice(1).every(v=>Number.isFinite(v)&&v>=0&&v<=1&&Math.fround(v)===v)&&max>0&&max>=blank&&max>=space,'Exact finite Float32 sufficient statistics');
                assert.ok(index===0?max===blank:max>blank,'Original stable blank tie');assert.ok(index!==LIMIT.C-1||max===space,'Space class maximum');
            }
            assert.ok(text(s.text)&&Number.isFinite(s.confidence)&&s.confidence>=0&&s.confidence<=1&&Array.isArray(s.positions)&&s.positions.length<=4096&&s.positions.every(v=>Number.isFinite(v)&&v>=0&&v<=1),'Original SDK text and positions');
            assert.ok((t.text===null||text(t.text))&&t.scored===(t.text!==null),'Separate source truth and noise');
            assert.ok(text(e.text)&&typeof e.knownAccuracyFailure==='boolean'&&e.knownAccuracyFailure===(t.scored&&e.text!==t.text),'Reference output is not source accuracy truth');
        }
        assert.equal(maxWidth,c.paddedWidth,'Padded width is actual complete cohort maximum');
        const byRead=[...c.rows].sort((a,b)=>a.originalReadIndex-b.originalReadIndex);assert.ok(byRead.every((r,index)=>r.replayIndex===index),'Local renumbering preserves all original read ordering');
    }
    assert.equal(ids.size,32,'All recorded rows used exactly once');for(const map of Object.values(maps))assert.ok([...map.keys()].every(id=>ids.has(id)),'No orphan statistics or truth');
    assert.ok(provenance?.new12?.historicalAlphaProved===false&&provenance.new12.matchedNchwRgbHashes===9,'Reconstructed RGB/alpha boundary');
    return{...data,maps,pixelMetadata:pixels};
}
function loadMangaWhitespaceRecordings(directory,manifestSha256){
    assert.ok(hash(manifestSha256),'A frozen external manifest digest is mandatory');let bytesRead=0;
    function read(file,limit){const name=path.join(directory,file),stat=fs.lstatSync(name);assert.ok(stat.isFile()&&stat.size<=limit,'Bounded regular fixture file');bytesRead+=stat.size;assert.ok(bytesRead<=LIMIT.totalBytes,'Total fixture byte budget');return fs.readFileSync(name);}
    const bytes=read('manifest.json',65536);assert.equal(sha(bytes),manifestSha256,'Frozen manifest SHA');const manifest=JSON.parse(bytes);
    assert.deepEqual(Object.keys(manifest.parts??{}).sort(),[...PARTS].sort(),'Exact JSON part inventory');
    const values={};for(const name of PARTS){const record=manifest.parts[name];assert.ok(record&&integer(record.bytes,1,LIMIT.jsonBytes)&&hash(record.sha256),'Bounded JSON part metadata');const part=read(name,record.bytes);assert.equal(part.length,record.bytes,'Exact JSON bytes');assert.equal(sha(part),record.sha256,'Frozen JSON part SHA');values[name]=JSON.parse(part);}
    const data=validateMangaWhitespaceRecordingData({manifest,observations:values['observations.json'],truth:values['truth.json'],sdk:values['sdk-output.json'],expected:values['replay-expected.json'],dictionary:values['sparse-dictionary.json'],provenance:values['provenance.json']});
    const pixels=new Map();for(const p of manifest.pixels){const png=read(p.file,p.pngBytes);assert.equal(png.length,p.pngBytes,'Exact PNG bytes');assert.equal(sha(png),p.pngSha256,'Frozen PNG SHA');const rgba=decodeMangaWhitespacePng(png,p.width,p.height);assert.equal(sha(rgba),p.rgbaSha256,'Decoded source RGBA SHA');pixels.set(p.rgbaSha256,rgba);}
    return{...data,pixels};
}
function replayMangaWhitespaceRecordings(createController,data){
    const validated=validateMangaWhitespaceRecordingData(data),dictionary=Array(LIMIT.C).fill('');for(const [id,character]of Object.entries(data.dictionary.entries))dictionary[Number(id)]=character;
    const reports=[];
    function cohort(c){
        const controller=createController(),byRead=[...c.rows].sort((a,b)=>a.replayIndex-b.replayIndex),boxes=byRead.map(r=>({...r.sourceBox}));
        controller.beginPage();try{
            controller.beginRun({boxes,batchSize:c.originalBatchSize,dictionary,supportedPerBox:true,sourceRatioOne:true});
            for(const r of byRead){const rgba=data.pixels.get(r.pixel);assert.ok(rgba instanceof Uint8ClampedArray&&rgba.length===r.resizedWidth*48*4&&sha(rgba)===r.pixel,'Frozen borrowed RGBA before observation');controller.observeBorrowedRead(r.replayIndex,r.resizedWidth,48,rgba);assert.equal(sha(rgba),r.pixel,'Borrowed pixels unchanged');}
            // This array deliberately contains only observed sufficient statistics; every other class is zero.
            const [N,T,C]=c.outputShape,values=new Float32Array(N*T*C);
            for(const r of c.rows)for(const [t,step]of validated.maps.observations.get(r.id).steps.entries()){
                const [index,max,blank,space]=step,base=(r.row*T+t)*C;values[base]=blank;values[base+C-1]=space;values[base+index]=max;
            }
            const outputSha=sha(values),input={};controller.bindInput(input,{readIndices:c.rows.map(r=>r.replayIndex),resizedWidths:c.rows.map(r=>r.resizedWidth),paddedWidth:c.paddedWidth,height:48});controller.observeOutput(input,{dims:c.outputShape,data:values});assert.equal(sha(values),outputSha,'Observer does not mutate CTC surrogate');
            const originals=byRead.map(r=>{const original=validated.maps.sdk.get(r.id);return{text:original.text,confidence:original.confidence,positions:original.positions,box:boxes[r.replayIndex]};});
            // Production results may be reordered after confidence/reading-order work; Box identity is authoritative.
            const actual=controller.applyToSdkResults([...originals].reverse());
            for(const result of actual){const index=boxes.indexOf(result.box);assert.ok(index>=0,'Original Box identity retained');const r=byRead[index],original=originals[index],truth=validated.maps.truth.get(r.id);assert.equal(result.confidence,original.confidence,'Confidence preserved');assert.equal(result.positions,original.positions,'SDK positions alias preserved');assert.equal(original.text,validated.maps.sdk.get(r.id).text,'Original result unchanged');reports.push({id:r.id,cohort:c.id,text:result.text,raw:original.text,truth:truth.text,scored:truth.scored,exact:truth.scored?result.text===truth.text:null,boxIdentity:true,changed:result!==original});}
        }finally{try{controller.endRun();}finally{controller.endPage();}}
    }
    for(const c of data.manifest.cohorts)cohort(c); // Dense values/Box/read references leave scope before the next cohort.
    return reports;
}
module.exports={MANGA_WHITESPACE_RECORDING_LIMITS:LIMIT,decodeMangaWhitespacePng,validateMangaWhitespaceRecordingData,loadMangaWhitespaceRecordings,replayMangaWhitespaceRecordings};
