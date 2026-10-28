import {beforeAll,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,cpSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMangaRecognitionWhitespace,MANGA_RECOGNITION_WHITESPACE_LIMITS as LIMIT} from '@/src/features/image-translation/services/mangaRecognitionWhitespace';

const {loadMangaWhitespaceRecordings,validateMangaWhitespaceRecordingData,decodeMangaWhitespacePng,replayMangaWhitespaceRecordings}=require('../scripts/testing/manga-whitespace-recordings.cjs');
const ROOT=join(__dirname,'fixtures/manga-whitespace-recordings');
const MANIFEST_SHA='c438ddc18b13d67fcd0661ebad215f67a20599763612266651b55e0200e5c870';
const data=loadMangaWhitespaceRecordings(ROOT,MANIFEST_SHA);
let actual:Array<{id:string;text:string;raw:string;truth:string|null;scored:boolean;exact:boolean|null;boxIdentity:boolean;changed:boolean}>;
const copy=()=>structuredClone({manifest:data.manifest,observations:data.observations,truth:data.truth,sdk:data.sdk,expected:data.expected,dictionary:data.dictionary,provenance:data.provenance});

function temporaryFixture(work:(directory:string)=>void){
    const directory=mkdtempSync(join(tmpdir(),'fluentread-whitespace-recordings-'));
    try{cpSync(ROOT,directory,{recursive:true});work(directory);}finally{rmSync(directory,{recursive:true,force:true});}
}

describe('固定32行真实统计的零模型controller回放',()=>{
    beforeAll(()=>{actual=replayMangaWhitespaceRecordings(createMangaRecognitionWhitespace,data);});
    it('原6完整cohort保留N/T/C、原调用顺序、宽序和读索引映射，没有companion伪造原行',()=>{
        expect(data.manifest.cohorts.map((c:{id:string})=>c.id)).toEqual(['crop-774-enhancedRRR','crop-774-BGR','crop-802-BGR','crop-802-enhancedRRR','fullpage-1231-BGR','fullpage-1142-BGR']);
        expect(data.manifest.cohorts.map((c:{outputShape:number[]})=>c.outputShape)).toEqual([[5,97,18710],[5,97,18710],[5,100,18710],[5,100,18710],[6,154,18710],[6,143,18710]]);
        for(const cohort of data.manifest.cohorts){
            expect(cohort.syntheticCompanions).toBe(false);expect(cohort.originalCohortComplete).toBe(true);
            const byRead=[...cohort.rows].sort((a,b)=>a.originalReadIndex-b.originalReadIndex);
            expect(byRead.map(row=>row.replayIndex)).toEqual(byRead.map((_,index)=>index));
            expect([...cohort.rows].sort((a,b)=>a.resizedWidth-b.resizedWidth||a.replayIndex-b.replayIndex)).toEqual(cohort.rows);
        }
        expect(data.manifest.cohorts[0].rows.map((r:{originalReadIndex:number})=>r.originalReadIndex)).toEqual([26,24,25,22,23]);
        expect(data.manifest.cohorts[4].rows.map((r:{originalReadIndex:number})=>r.originalReadIndex)).toEqual([12,21,4,0,34,1]);
    });
    it('32行逐字等于独立冻结的当前controller输出；返回顺序反转仍按Box身份关联，借用RGBA/统计不改',()=>{
        expect(actual).toHaveLength(32);
        const expected=new Map(data.expected.rows.map((r:{id:string;text:string})=>[r.id,r.text]));
        expect(actual.every(r=>r.text===expected.get(r.id)&&r.boxIdentity)).toBe(true);
        expect(actual.filter(r=>r.changed).map(r=>r.id).sort()).toEqual(['crop-26-BGR','crop-31-BGR']);
    });
    it('两条实际CABIN04恢复成独立真值CABIN 04，旧20全部精确；原18正确行逐字不变',()=>{
        const old=actual.filter(r=>r.id.startsWith('crop-'));
        expect(old.filter(r=>r.raw===r.truth)).toHaveLength(18);expect(old.every(r=>r.exact)).toBe(true);
        expect(old.filter(r=>r.raw===r.truth).every(r=>r.text===r.raw)).toBe(true);
        for(const id of ['crop-26-BGR','crop-31-BGR'])expect(actual.find(r=>r.id===id)).toMatchObject({raw:'CABIN04',text:'CABIN 04',truth:'CABIN 04',exact:true});
    });
    it('新12行保留全部原文：POSTCARD/日文/另一缺词是明确known accuracy failure，噪声3行不评分',()=>{
        const full=actual.filter(r=>r.id.startsWith('page-'));expect(full).toHaveLength(12);expect(full.every(r=>r.text===r.raw)).toBe(true);
        expect(full.filter(r=>!r.scored)).toHaveLength(3);expect(full.filter(r=>r.exact===true)).toHaveLength(6);
        expect(actual.find(r=>r.id==='page-1-batch-6-row-4')).toMatchObject({text:'POSTCARD FROMTHE FERRY',truth:'POSTCARD FROM THE FERRY',exact:false});
        expect(actual.find(r=>r.id==='page-2-batch-9-row-1')).toMatchObject({text:'雨あがり の市場へ',truth:'雨あがりの市場へ',exact:false});
        expect(actual.filter(r=>r.scored&&r.exact===false).map(r=>r.id).sort()).toEqual(data.expected.rows.filter((r:{knownAccuracyFailure:boolean})=>r.knownAccuracyFailure).map((r:{id:string})=>r.id).sort());
        expect(data.expected).toMatchObject({scored:29,exact:26,knownFailures:3,accuracyPassed:false});
    });
    it('只打包50个观察字典事实和22张去重PNG，不载入完整字典/SDK/模型；来源与参考结果分层',()=>{
        expect(Object.keys(data.dictionary.entries)).toHaveLength(50);expect(data.pixels.size).toBe(22);expect(data.dictionary.entries[0]).toBe('');expect(data.dictionary.entries[18709]).toBe('');
        expect(data.dictionary.dictionaryFileSha256).toBe('41557512862dfe31970cf22407742b629725461dd84c0d8771bde9c87c2202c8');
        expect(data.provenance.new12).toMatchObject({matchedNchwRgbHashes:9,historicalAlphaProved:false,newReconstructionAlphaAll255:true});
        expect(data.manifest.historicalFullpageLedgerReproduced).toBe(false);expect(data.manifest.historicalFullpageAlphaProved).toBe(false);
    });
    it('每个selected-window共享页账本的最坏pixels/runs/fullT仍在原上限；不冒称缺42行的历史账本',()=>{
        for(const c of data.manifest.cohorts){
            expect(c.rows.reduce((n:number,r:{resizedWidth:number})=>n+r.resizedWidth*48,0)).toBeLessThanOrEqual(LIMIT.pixels);
            expect(c.rows.reduce((n:number,r:{resizedWidth:number})=>n+Math.ceil(r.resizedWidth/2),0)).toBeLessThanOrEqual(LIMIT.runs);
            expect(c.outputShape[0]*c.outputShape[1]).toBeLessThanOrEqual(LIMIT.steps);expect(c.rows.length).toBeLessThanOrEqual(LIMIT.crops);
        }
    });
});

describe('录制协议损坏在CTC大数组分配前拒绝',()=>{
    it.each(['rows','NTC','width','missing-row','read-index','stable-order','padding','orphan','pixel','dict','class','probability','truth','alpha-claim'] as const)('拒绝损坏或语义伪造：%s',kind=>{
        const bad=copy(),c=bad.manifest.cohorts[0],row=c.rows[0];
        if(kind==='rows')bad.manifest.rowCount=3200000;
        if(kind==='NTC')c.outputShape[1]=Number.MAX_SAFE_INTEGER;
        if(kind==='width')row.resizedWidth=Number.MAX_SAFE_INTEGER;
        if(kind==='missing-row')c.rows.pop();
        if(kind==='read-index')c.rows[1].originalReadIndex=row.originalReadIndex;
        if(kind==='stable-order')c.rows[1].replayIndex=row.replayIndex;
        if(kind==='padding')c.paddedWidth++;
        if(kind==='orphan')bad.sdk.rows[0].id='unrecorded';
        if(kind==='pixel')row.pixel='0'.repeat(64);
        if(kind==='dict')delete bad.dictionary.entries[bad.observations.rows[0].steps[2][0]];
        if(kind==='class')bad.observations.rows[0].steps[2][0]=18710;
        if(kind==='probability')bad.observations.rows[0].steps[2][1]=Infinity;
        if(kind==='truth')bad.expected.rows.find((r:{knownAccuracyFailure:boolean})=>r.knownAccuracyFailure).knownAccuracyFailure=false;
        if(kind==='alpha-claim')bad.provenance.new12.historicalAlphaProved=true;
        const create=vi.fn();expect(()=>replayMangaWhitespaceRecordings(create,{...bad,pixels:data.pixels})).toThrow();expect(create).not.toHaveBeenCalled();
    });
    it('超大NTC先拒绝，不读取rows getter或分配dense logits',()=>{
        const bad=copy(),c=bad.manifest.cohorts[0];c.outputShape=[6,1e12,18710];Object.defineProperty(c,'rows',{get(){throw new Error('rows must not be read');}});
        expect(()=>validateMangaWhitespaceRecordingData(bad)).toThrow('Bounded NTC');
    });
    it('sparse dictionary缺字或字符改写不能靠未知全字典伪装；源文件SHA仍受库存保护',()=>{
        const bad=copy();bad.dictionary.entries[18710]='A';expect(()=>validateMangaWhitespaceRecordingData(bad)).toThrow('Sparse dictionary ID');
        temporaryFixture(directory=>{
            const p=join(directory,'sparse-dictionary.json'),bytes=readFileSync(p);bytes[bytes.length-2]^=1;writeFileSync(p,bytes);
            expect(()=>loadMangaWhitespaceRecordings(directory,MANIFEST_SHA)).toThrow('Frozen JSON part SHA');
        });
    });
    it('mandatory manifest SHA禁止缺失或漂移；PNG字节损坏不被自身更新的metadata自证',()=>{
        expect(()=>loadMangaWhitespaceRecordings(ROOT)).toThrow('manifest digest');
        temporaryFixture(directory=>{
            const p=join(directory,'manifest.json'),bytes=readFileSync(p);writeFileSync(p,Buffer.concat([bytes,Buffer.from(' ')]));expect(()=>loadMangaWhitespaceRecordings(directory,MANIFEST_SHA)).toThrow('Frozen manifest SHA');
        });
        temporaryFixture(directory=>{
            const p=join(directory,data.manifest.pixels[0].file),bytes=readFileSync(p);bytes[50]^=1;writeFileSync(p,bytes);expect(()=>loadMangaWhitespaceRecordings(directory,MANIFEST_SHA)).toThrow('Frozen PNG SHA');
        });
    });
    it('PNG尺寸在inflate前有界，CRC/截断/非filter0或不同尺寸不静默解码',()=>{
        const p=data.manifest.pixels[0],png=readFileSync(join(ROOT,p.file));
        expect(()=>decodeMangaWhitespacePng(png,1e12)).toThrow('dimensions');
        expect(()=>decodeMangaWhitespacePng(png,p.width+1)).toThrow('PNG width');
        expect(()=>decodeMangaWhitespacePng(png.subarray(0,png.length-1),p.width)).toThrow('Complete');
        const corrupt=Buffer.from(png);corrupt[50]^=1;expect(()=>decodeMangaWhitespacePng(corrupt,p.width)).toThrow('CRC');
        expect(()=>decodeMangaWhitespacePng(Buffer.alloc(65537),p.width)).toThrow('Bounded PNG');
        // 独立构造的有效CRC PNG，首行filter1；窄语料解码器应明确拒绝而非误解成filter0。
        const filterOne=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAwCAYAAAAsJjtLAAAAFUlEQVR4nGNkGAWjYBSMglEwCggDAAxgAAIayQc3AAAAAElFTkSuQmCC','base64');
        expect(()=>decodeMangaWhitespacePng(filterOne,8)).toThrow('Only filter0');
    });
});
