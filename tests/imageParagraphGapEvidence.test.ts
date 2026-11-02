import {describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {produceImageParagraphGapProofs,createImageParagraphGapConsumer,bindImageParagraphGapEvidence,getImageParagraphGapEvidence,createImageParagraphWorkQueue,type ImageParagraphGapProof} from '@/src/features/image-translation/services/imageParagraphGapEvidence';
import {flattenOcrAlpha} from '@/src/features/image-translation/services/ocrPixels';
import {observeImageMatteGeometry,planImageMatteCandidate} from '@/src/features/image-translation/services/imageMatteRepair';
import type {ImageTextRegion} from '@/src/features/image-translation/paragraphs';
import type {MangaOcrPage} from '@/src/features/image-translation/services/mangaBubbles';
type Box=ImageTextRegion['bbox'];
const bounds=(members:ImageTextRegion[])=>members.reduce((a,{bbox:b})=>({x0:Math.min(a.x0,b.x0),y0:Math.min(a.y0,b.y0),x1:Math.max(a.x1,b.x1),y1:Math.max(a.y1,b.y1)}),{x0:Infinity,y0:Infinity,x1:-Infinity,y1:-Infinity});
function basic(){
    const width=200,height=200,pixels=new Uint8ClampedArray(width*height*4);for(let i=0;i<pixels.length;i+=4)pixels.set([24,44,68,255],i);
    const page:MangaOcrPage={results:[{text:'FIRST LINE',confidence:.99,box:{x:40,y:40,width:90,height:14}},{text:'SECOND LINE',confidence:.99,box:{x:40,y:74,width:90,height:14}}]};
    const set=(x:number,y:number,color=[230,240,250,255])=>pixels.set(color,(y*width+x)*4);
    for(const row of page.results)for(let y=row.box.y+3;y<row.box.y+11;y++)for(let x=row.box.x+3;x<row.box.x+6;x++)set(x,y);
    return{width,height,pixels,page,set};
}
type Fixture=ReturnType<typeof basic>;
const rawRegions=(page:MangaOcrPage)=>page.results.map(item=>({text:item.text.trim().replace(/\s+/gu,' '),fontSize:item.box.height,bbox:{x0:item.box.x,y0:item.box.y,x1:item.box.x+item.box.width,y1:item.box.y+item.box.height}}));
function adopt(f:Fixture,proofs=produceImageParagraphGapProofs(f.page,f.width,f.height,f.pixels),extra:ImageTextRegion[]=[]){
    f.page.imageParagraphGapProofs=proofs;const consumer=createImageParagraphGapConsumer(f.page,f.width,f.height),regions:ImageTextRegion[]=rawRegions(f.page);
    regions.forEach((line,index)=>consumer.record(f.page.results[index],line));regions.push(...extra);consumer.seal(regions);bindImageParagraphGapEvidence(regions,'source',f.width,f.height);
    return{regions,consumer,proofs,support:getImageParagraphGapEvidence(regions,'source',f.width,f.height)};
}
describe('已保存原像素的五组对白与独立控制标签',()=>{
    const records: Array<{scene:string;source:{width:number;height:number;nativeCanvasBytes:boolean};rgba:{data:string;sha256:string};observedPhysicalLines:Array<{text:string;bbox:Box}>;expectedPairs:Array<[string,string]>;rejectedPairs:Array<[string,string]>}>=JSON.parse(readFileSync(new URL('./fixtures/image-paragraph-gap-source.json',import.meta.url),'utf8')).records;
    it.each(records)('$scene在flatten后只为真实几何目标提供续行，Cabin开关仍拒绝',(record)=>{
        const {width,height}=record.source,data=inflateSync(Buffer.from(record.rgba.data,'base64')),pixels=new Uint8ClampedArray(data),before=pixels.slice();
        expect(createHash('sha256').update(data).digest('hex')).toBe(record.rgba.sha256);expect(pixels.length).toBe(width*height*4);expect(record.source.nativeCanvasBytes).toBe(false);
        // 保存的是被接受物理框，不冒充未采集的SDK confidence和result index。
        const page:MangaOcrPage={results:record.observedPhysicalLines.map((line:{text:string;bbox:Box})=>({text:line.text,confidence:.99,box:{x:line.bbox.x0,y:line.bbox.y0,width:line.bbox.x1-line.bbox.x0,height:line.bbox.y1-line.bbox.y0}}))};
        flattenOcrAlpha(pixels);const proof=produceImageParagraphGapProofs(page,width,height,pixels),flatBefore=pixels.slice();
        expect(proof.map(p=>[p.previous.text,p.next.text])).toEqual(record.expectedPairs);
        expect(proof.every(p=>p.pixels<=1_048_576)).toBe(true);expect(proof.reduce((sum,p)=>sum+p.pixels,0)).toBeLessThanOrEqual(1_048_576);
        const graph=structuredClone({...page,imageParagraphGapProofs:proof}),regions=rawRegions(graph),consumer=createImageParagraphGapConsumer(graph,width,height);
        regions.forEach((line,index)=>consumer.record(graph.results[index],line));consumer.seal(regions);bindImageParagraphGapEvidence(regions,'same-source',width,height);
        const support=getImageParagraphGapEvidence(regions,'same-source',width,height)!;expect(support).toBeDefined();
        for(const pair of record.expectedPairs){const first=regions.find(line=>line.text===pair[0])!,next=regions.find(line=>line.text===pair[1])!;expect(support.successor(first)).toBe(next);expect(support.permits(first,next,[first],bounds([first,next]))).toBe(true);}
        for(const pair of record.rejectedPairs){const first=regions.find(line=>line.text===pair[0])!;expect(support.successor(first)).toBeUndefined();}
        if(record.scene.startsWith('transparent-lantern'))for(const line of regions){expect(observeImageMatteGeometry(pixels,width,height,line.bbox)).toBeDefined();expect(planImageMatteCandidate(pixels,width,height,line.bbox,{remaining:1_048_576})).toBeUndefined();}
        expect(Buffer.compare(Buffer.from(pixels.buffer,pixels.byteOffset,pixels.byteLength),Buffer.from(flatBefore.buffer,flatBefore.byteOffset,flatBefore.byteLength))).toBe(0);expect(Buffer.compare(Buffer.from(before.buffer,before.byteOffset,before.byteLength),Buffer.from(pixels.buffer,pixels.byteOffset,pixels.byteLength))).not.toBe(0);
    });
});
describe('原对象采用、私有绑定与完整段落阻挡',()=>{
    it('同一page graph clone保留endpoint引用；分离clone或未采用raw行没有权限',()=>{
        const f=basic(),proofs=produceImageParagraphGapProofs(f.page,f.width,f.height,f.pixels);expect(proofs).toHaveLength(1);
        const graph=structuredClone({...f.page,imageParagraphGapProofs:proofs});expect(graph.imageParagraphGapProofs[0].previous).toBe(graph.results[0]);
        const accepted=adopt({...f,page:graph},graph.imageParagraphGapProofs);expect(accepted.support?.successor(accepted.regions[0])).toBe(accepted.regions[1]);
        expect(adopt({...f,page:structuredClone(f.page)},proofs).support).toBeUndefined();
        const other=basic(),consumer=createImageParagraphGapConsumer({...other.page,imageParagraphGapProofs:produceImageParagraphGapProofs(other.page,200,200,other.pixels)},200,200),regions=rawRegions(other.page);
        consumer.record({...other.page.results[0]},regions[0]);consumer.record(other.page.results[1],regions[1]);consumer.seal(regions);bindImageParagraphGapEvidence(regions,'source',200,200);expect(getImageParagraphGapEvidence(regions,'source',200,200)).toBeUndefined();
    });
    it('数组、原图、尺寸、重复采用、实际输出替换与后续快照变化均撤回权限',()=>{
        const f=basic(),a=adopt(f);expect(a.support).toBeDefined();
        for(const [regions,image,width,height] of [[a.regions.slice(),'source',200,200],[a.regions,'other',200,200],[a.regions,'source',201,200],[a.regions,'source',200,201]] as const)expect(getImageParagraphGapEvidence(regions,image,width,height)).toBeUndefined();
        bindImageParagraphGapEvidence(a.regions,'',200,200);expect(getImageParagraphGapEvidence(a.regions,'source',200,200)).toBeUndefined();
        bindImageParagraphGapEvidence(a.regions,'source',201,200);expect(getImageParagraphGapEvidence(a.regions,'source',201,200)).toBeUndefined();
        bindImageParagraphGapEvidence(a.regions,'source',200,201);expect(getImageParagraphGapEvidence(a.regions,'source',200,201)).toBeUndefined();
        bindImageParagraphGapEvidence([], 'source',200,200);
        a.consumer.record(f.page.results[0],a.regions[0]);a.consumer.seal(a.regions);bindImageParagraphGapEvidence(a.regions,'source',200,200);expect(getImageParagraphGapEvidence(a.regions,'source',200,200)).toBeUndefined();
        const b=adopt(basic());b.regions[1].text+='changed';expect(b.support?.successor(b.regions[0])).toBeUndefined();
        const c=adopt(basic());c.regions[0].bbox.x0++;expect(c.support?.successor(c.regions[0])).toBeUndefined();expect(c.support?.successor({...c.regions[0]})).toBeUndefined();
    });
    it('数值guard过滤前即保留，阻挡整个members包络而非仅最后pair',()=>{
        const f=basic(),guard:ImageTextRegion={text:'',bbox:{x0:25,y0:60,x1:30,y1:66},guardOnly:true},prefix:ImageTextRegion={text:'PREFIX',fontSize:14,bbox:{x0:20,y0:5,x1:110,y1:19}};
        const a=adopt(f,undefined,[prefix,guard]),[first,next]=a.regions,s=a.support!;expect(s).toBeDefined();expect(s.permits(first,next,[first],bounds([first,next]))).toBe(true);
        expect(s.permits(first,next,[prefix,first],bounds([prefix,first,next]))).toBe(false);
        guard.bbox.x0=50;expect(s.permits(first,next,[first],bounds([first,next]))).toBe(false);
        const g:ImageTextRegion={text:'',bbox:{x0:50,y0:60,x1:60,y1:66},guardOnly:true},b=adopt(basic(),undefined,[g]);expect(b.support?.permits(b.regions[0],b.regions[1],[b.regions[0]],bounds(b.regions.slice(0,2)))).toBe(false);
    });
    it('能力拒绝错误endpoint、伪bounds、非当前members、重复成员和已合段/竖排端点',()=>{
        const a=adopt(basic()),[first,next]=a.regions,s=a.support!;
        expect(s.permits(next,first,[next],bounds([first,next]))).toBe(false);expect(s.permits(first,next,[],bounds([first,next]))).toBe(false);expect(s.permits(first,next,[next,first],bounds([first,next]))).toBe(false);expect(s.permits(first,next,[first,first],bounds([first,next]))).toBe(false);
        expect(s.permits(first,next,[{...first},first],bounds([first,next]))).toBe(false);expect(s.permits(first,next,[first],{...bounds([first,next]),x0:1})).toBe(false);
        for(const change of [{vertical:true as const},{sourceBoxes:[first.bbox]},{guardOnly:true as const},{fontSize:15},{numericUncertain:true as const}]){const b=adopt(basic());Object.assign(b.regions[0],change);expect(b.support?.successor(b.regions[0])).toBeUndefined();}
    });
    it('唯一邻行歧义及原raw/实际输出文字或物理框不符时不绑定',()=>{
        const f=basic(),proofs=produceImageParagraphGapProofs(f.page,200,200,f.pixels);
        f.page.results[0].text='CHANGED';expect(adopt(f,proofs).support).toBeUndefined();
        for(const change of [{vertical:true as const},{sourceBoxes:[{x0:1,y0:1,x1:2,y1:2}]},{text:'WRONG'},{fontSize:15},{bbox:{x0:41,y0:40,x1:130,y1:54}}]){
            const g=basic(),p=produceImageParagraphGapProofs(g.page,200,200,g.pixels),c=createImageParagraphGapConsumer({...g.page,imageParagraphGapProofs:p},200,200),regions=rawRegions(g.page);Object.assign(regions[0],change);regions.forEach((r,i)=>c.record(g.page.results[i],r));c.seal(regions);bindImageParagraphGapEvidence(regions,'source',200,200);expect(getImageParagraphGapEvidence(regions,'source',200,200)).toBeUndefined();
        }
        const g=basic(),ambiguous:ImageTextRegion={text:'OTHER ROW',fontSize:14,bbox:{x0:42,y0:72,x1:132,y1:86}};expect(adopt(g,undefined,[ambiguous]).support).toBeUndefined();
    });
});
describe('几何、预算与取消的保守失败',()=>{
    it('未完成owner标记不能把通页matte割成封闭归属，顺序和多次失败不改变拒绝',()=>{
        for(const channels of [1,2]){
            const width=120,height=120,pixels=new Uint8ClampedArray(width*height*4),set=(x:number,y:number,color=[24,44,68,255])=>pixels.set(color,(y*width+x)*4);
            for(let y=0;y<height;y++)for(let x=0;x<width;x++)set(x,y,[0,0,0,255]);
            for(let y=0;y<30;y++)for(const left of [50,80].slice(0,channels))for(let x=left;x<left+11;x++)set(x,y);
            for(let y=30;y<110;y++)for(let x=20;x<100;x++)set(x,y);
            const rows=[50,80].slice(0,channels).flatMap(left=>[11,25].map(top=>({text:'PRIOR LINE',confidence:.99,box:{x:left+2,y:top,width:4,height:4}})));
            const later=[50,64].map(top=>({text:'LATER LINE',confidence:.99,box:{x:40,y:top,width:20,height:4}}));rows.push(...later);
            for(const row of rows)for(let y=row.box.y+1;y<row.box.y+3;y++)set(row.box.x+1,y,[230,240,250,255]);
            const before=pixels.slice();expect(produceImageParagraphGapProofs({results:later},width,height,pixels)).toEqual([]);
            for(const order of [rows,[...rows].reverse(),[...later,...rows.slice(0,-2)], [...rows.slice(0,-2),...rows.slice(0,-2),...later]])expect(produceImageParagraphGapProofs({results:order},width,height,pixels)).toEqual([]);
            expect(Buffer.compare(Buffer.from(pixels.buffer,pixels.byteOffset,pixels.byteLength),Buffer.from(before.buffer,before.byteOffset,before.byteLength))).toBe(0);
        }
    });
    it('未完成同色owner只撤回不明组件，独立封闭组件仍可证明',()=>{
        const width=200,height=140,pixels=new Uint8ClampedArray(width*height*4),set=(x:number,y:number,color=[24,44,68,255])=>pixels.set(color,(y*width+x)*4);
        for(let y=0;y<height;y++)for(let x=0;x<width;x++)set(x,y,[0,0,0,255]);for(let y=0;y<30;y++)for(let x=50;x<61;x++)set(x,y);for(let y=30;y<110;y++)for(let x=20;x<100;x++)set(x,y);for(let y=40;y<110;y++)for(let x=125;x<185;x++)set(x,y);
        const rows=[{text:'PRIOR ONE',confidence:.99,box:{x:52,y:11,width:4,height:4}},{text:'PRIOR TWO',confidence:.99,box:{x:52,y:25,width:4,height:4}},{text:'LATER ONE',confidence:.99,box:{x:40,y:50,width:20,height:4}},{text:'LATER TWO',confidence:.99,box:{x:40,y:64,width:20,height:4}},{text:'SEPARATE ONE',confidence:.99,box:{x:140,y:50,width:20,height:4}},{text:'SEPARATE TWO',confidence:.99,box:{x:140,y:64,width:20,height:4}}];
        for(const row of rows)for(let y=row.box.y+1;y<row.box.y+3;y++)set(row.box.x+1,y,[230,240,250,255]);
        const proofs=produceImageParagraphGapProofs({results:rows},width,height,pixels);expect(proofs.map(p=>[p.previous.text,p.next.text])).toEqual([['SEPARATE ONE','SEPARATE TWO']]);
    });
    it('同一producer多组件外部连通共用一个有界FIFO缓冲，不按条纹分配',()=>{
        const f=basic();for(let y=0;y<200;y++)for(let x=0;x<200;x++)if(x<20||x>=180||y<20||y>=120)f.set(x,y,[0,0,0,255]);
        f.page.results.push({text:'OTHER COLUMN',confidence:.99,box:{x:170,y:150,width:14,height:14}});
        for(let y=30;y<100;y+=4)for(let yy=y;yy<y+2;yy++)for(let x=145;x<180;x++)f.set(x,yy,[0,0,0,255]);
        const Native=globalThis.Uint32Array;let allocations=0;
        vi.stubGlobal('Uint32Array',class extends Native {constructor(length:number){super(length);if(length===65_536)allocations++;}});
        try{expect(produceImageParagraphGapProofs(f.page,200,200,f.pixels)).toHaveLength(1);expect(allocations).toBe(1);}finally{vi.unstubAllGlobals();}
    });
    it('有界FIFO按条目收费，回绕保持序且溢出不覆盖原待处理项',()=>{
        for(const capacity of [0,-1,1.1,NaN,65537])expect(()=>createImageParagraphWorkQueue(capacity)).toThrow('容量无效');
        const queue=createImageParagraphWorkQueue(2);expect(queue.size).toBe(0);expect(queue.shift()).toBeUndefined();queue.push(7);queue.push(9);expect(queue.size).toBe(2);expect(()=>queue.push(11)).toThrow('队列已满');expect(queue.shift()).toBe(7);queue.push(11);expect([queue.shift(),queue.shift(),queue.shift()]).toEqual([9,11,undefined]);
        queue.push(13);queue.push(15);queue.clear();expect(queue.size).toBe(0);expect(queue.shift()).toBeUndefined();queue.push(17);expect(queue.shift()).toBe(17);expect(createImageParagraphWorkQueue().size).toBe(0);
    });
    it('外部组件64Ki访问上限与非矩形owner的1Mi预算耗尽都只保留原段',()=>{
        const build=(width:number,height:number,ellipse=false)=>{
            const pixels=new Uint8ClampedArray(width*height*4);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const inside=ellipse?((x-width/2)/(width/2-70))**2+((y-height/2)/(height/2-70))**2<=1:x>=20&&x<width-20&&y>=20&&y<height-20;pixels.set(inside?[24,44,68,255]:[0,0,0,255],(y*width+x)*4);}
            const x=ellipse?300:40,y=ellipse?400:300,page:MangaOcrPage={results:[{text:'FIRST LINE',confidence:.99,box:{x,y,width:90,height:14}},{text:'SECOND LINE',confidence:.99,box:{x,y:y+34,width:90,height:14}}]};
            for(const row of page.results)for(let yy=row.box.y+3;yy<row.box.y+11;yy++)for(let xx=row.box.x+3;xx<row.box.x+6;xx++)pixels.set([230,240,250,255],(yy*width+xx)*4);
            if(!ellipse)for(let yy=100;yy<900;yy++)for(let xx=200;xx<800;xx++)pixels.set([0,0,0,255],(yy*width+xx)*4);
            return{page,pixels,width,height};
        };
        for(const f of [build(1000,1000),build(1400,1200,true)])expect(produceImageParagraphGapProofs(f.page,f.width,f.height,f.pixels)).toEqual([]);
        const f=build(1000,1000),error=new Error('owner cancelled');let checks=0;expect(()=>produceImageParagraphGapProofs(f.page,f.width,f.height,f.pixels,()=>{if(++checks>1000)throw error;})).toThrow(error);
    });
    it('不透明无宽gap候选零源像素访问，4096密集标签在共享比较预算结束',()=>{
        const f=basic();f.page.results[1].box.y=56;let reads=0;
        const pixels=new Proxy(f.pixels,{get(target,key){if(typeof key==='string'&&/^\d+$/u.test(key))reads++;return Reflect.get(target,key,target);}});
        expect(produceImageParagraphGapProofs(f.page,200,200,pixels)).toEqual([]);expect(reads).toBe(0);
        const check=vi.fn(),item=f.page.results[0];expect(produceImageParagraphGapProofs({results:Array(4096).fill(item)},200,200,pixels,check)).toEqual([]);expect(check).toHaveBeenCalledTimes(32_770);expect(reads).toBe(0);
    });
    it('失败候选也消耗128次尝试及1Mi预留，未读取和失败不返还',()=>{
        const f=basic(),empty=f.pixels.slice();for(let i=0;i<empty.length;i+=4)empty.set([24,44,68,255],i);
        const check=vi.fn(),page={results:[f.page.results[0],...Array(130).fill(f.page.results[1])]};expect(produceImageParagraphGapProofs(page,200,200,empty,check)).toEqual([]);expect(check).toHaveBeenCalledTimes(130);
        const width=1000,height=300,pixels=new Uint8ClampedArray(width*height*4).fill(255),first={text:'FIRST',confidence:.99,box:{x:100,y:50,width:600,height:20}},next={...first,text:'SECOND',box:{...first.box,y:100}},charged=vi.fn();
        expect(produceImageParagraphGapProofs({results:[first,...Array(130).fill(next)]},width,height,pixels,charged)).toEqual([]);expect(charged).toHaveBeenCalledTimes(25);
        const tooWide={...first,box:{x:0,y:40,width:1000,height:100}},wideNext={...next,box:{...tooWide.box,y:290}},wideCheck=vi.fn();expect(produceImageParagraphGapProofs({results:[tooWide,...Array(130).fill(wideNext)]},width,500,new Uint8ClampedArray(width*500*4),wideCheck)).toEqual([]);expect(wideCheck).toHaveBeenCalledTimes(130);
    });
    it('同页topology分类tile只读取一次，重用footprint仍按pair保守重复计费',()=>{
        const f=basic();for(let y=0;y<200;y++)for(let x=0;x<200;x++)if(x<20||x>=180||y<20||y>=120)f.set(x,y,[0,0,0,255]);
        const run=(duplicate:boolean)=>{let reads=0;const pixels=new Proxy(f.pixels,{get(target,key){if(typeof key==='string'&&/^\d+$/u.test(key))reads++;return Reflect.get(target,key,target);}}),page={results:duplicate?[...f.page.results,f.page.results[1]]:f.page.results},proofs=produceImageParagraphGapProofs(page,200,200,pixels);return{reads,proofs};};
        const once=run(false),twice=run(true);expect(once.proofs).toHaveLength(1);expect(twice.proofs).toHaveLength(2);
        const proof=once.proofs[0],endpoint=proof.previousGeometry.width*proof.previousGeometry.height+proof.nextGeometry.width*proof.nextGeometry.height,topology=proof.topology!.tiles.reduce((sum,g)=>sum+g.width*g.height,0),windows=proof.pixels-endpoint-topology;
        // 第二个pair仅重复走廊/side原读取；H8几何cache和全页分类cache没有新RGBA访问。
        expect(twice.reads-once.reads).toBe(windows*4);expect(twice.proofs[1].pixels).toBe(proof.pixels);expect(twice.proofs[1].topology).toEqual(proof.topology);
    });
    it('数组移除guard、顺序改变或追加新对象都立即撤回已绑定能力',()=>{
        for(const edit of [(r:ImageTextRegion[])=>r.pop(),(r:ImageTextRegion[])=>r.reverse(),(r:ImageTextRegion[])=>r.push({...r[0]})]){const f=adopt(basic(),undefined,[{text:'',guardOnly:true,bbox:{x0:180,y0:180,x1:190,y1:190}}]),[first,next]=f.regions;edit(f.regions);expect(f.support?.successor(first)).toBeUndefined();expect(f.support?.permits(first,next,[first],bounds([first,next]))).toBe(false);}
    });
    it('sourceBoxes保护对象同长坐标修改、消费者比较耗尽都没有续行权限',()=>{
        const extra:ImageTextRegion={text:'123',bbox:{x0:180,y0:180,x1:190,y1:190},sourceBoxes:[{x0:180,y0:180,x1:190,y1:190}]},a=adopt(basic(),undefined,[extra]),[first,next]=a.regions;
        expect(a.support?.permits(first,next,[first],bounds([first,next]))).toBe(true);extra.sourceBoxes![0].x0++;expect(a.support?.permits(first,next,[first],bounds([first,next]))).toBe(false);
        const f=basic(),proof=produceImageParagraphGapProofs(f.page,200,200,f.pixels)[0],proofs=Array.from({length:9},(_,index)=>({...proof,ordinal:index+1})),far=Array.from({length:4094},()=>({text:'FAR',fontSize:1,bbox:{x0:180,y0:180,x1:181,y1:181}}));expect(adopt(f,proofs,far).support).toBeUndefined();
    });
    it('旁栏窗口超过64Ki、物理guard穿走廊与观察中raw改变均保守失败',()=>{
        const f=basic();f.page.results.push({text:'RETAIN',confidence:.99,box:{x:80,y:63,width:5,height:3}});expect(produceImageParagraphGapProofs(f.page,200,200,f.pixels)).toEqual([]);
        const g=basic(),wide=new Uint8ClampedArray(8192*200*4);for(let i=0;i<wide.length;i+=4)wide.set([24,44,68,255],i);for(let y=0;y<200;y++)wide.set(g.pixels.subarray(y*200*4,(y+1)*200*4),y*8192*4);expect(produceImageParagraphGapProofs(g.page,8192,200,wide)).toEqual([]);
        const changed=basic();let calls=0;expect(produceImageParagraphGapProofs(changed.page,200,200,changed.pixels,()=>{if(++calls===4)changed.page.results[0].text='CHANGED DURING OBSERVATION';})).toEqual([]);
    });
    it('合法候选预留共同预算后，剩余走廊不足立即停止而不扩大预算',()=>{
        const f=basic(),page={results:[f.page.results[0],...Array(130).fill(f.page.results[1])]},proofs=produceImageParagraphGapProofs(page,200,200,f.pixels);
        expect(proofs.length).toBeGreaterThan(0);expect(proofs.length).toBeLessThan(128);expect(proofs.reduce((n,p)=>n+p.pixels,0)).toBeLessThanOrEqual(1_048_576);
    });
    it('256个颜色/owner标签无法塞入1byte时不回绕，也不复读源tile',()=>{
        const width=512,height=448,pixels=new Uint8ClampedArray(width*height*4),page:MangaOcrPage={results:[]};for(let i=0;i<pixels.length;i+=4)pixels.set([5,10,15,255],i);
        for(let n=0;n<128;n++){const ox=(n%16)*32,oy=Math.floor(n/16)*56,bg=[40+(n%16)*8,50+Math.floor(n/16)*8,100,255];
            for(let y=oy+3;y<oy+39;y++)for(let x=ox+3;x<ox+29;x++)pixels.set(bg,(y*width+x)*4);
            for(const top of [oy+10,oy+24]){page.results.push({text:'LINE',confidence:.99,box:{x:ox+10,y:top,width:8,height:4}});for(let y=top+1;y<top+3;y++)for(let x=ox+11;x<ox+13;x++)pixels.set([230,240,250,255],(y*width+x)*4);}
        }
        const proofs=produceImageParagraphGapProofs(page,width,height,pixels);expect(proofs.length).toBeGreaterThan(100);expect(proofs.length).toBeLessThan(128);expect(proofs.every(p=>p.topology)).toBe(true);expect(proofs.reduce((n,p)=>n+p.pixels,0)).toBeLessThanOrEqual(1_048_576);
    });
    it('未闭合owner的cache不能授权，完整owner缓存仍须逐pair预留footprint',()=>{
        const open=basic();for(let y=0;y<200;y++)open.set(10,y);open.page.results.push(open.page.results[1]);expect(produceImageParagraphGapProofs(open.page,200,200,open.pixels)).toEqual([]);
        const f=basic();for(let y=0;y<200;y++)for(let x=0;x<200;x++)if(x<20||x>=180||y<20||y>=120)f.set(x,y,[0,0,0,255]);
        const page={results:[f.page.results[0],...Array(125).fill(f.page.results[1])]},proofs=produceImageParagraphGapProofs(page,200,200,f.pixels);expect(proofs.length).toBeGreaterThan(0);expect(proofs.length).toBeLessThan(128);expect(proofs.reduce((n,p)=>n+p.pixels,0)).toBeLessThanOrEqual(1_048_576);
    });
    it('消费者逐proof重复收费，伪造超1Mi tile receipt不被可调数字蒙混',()=>{
        const f=basic(),p=produceImageParagraphGapProofs(f.page,200,200,f.pixels)[0];f.page.results.push({text:'OTHER',confidence:.99,box:{x:180,y:150,width:14,height:14}});
        const tiles=Array.from({length:1025},(_,index)=>({left:(index%64)*32,top:Math.floor(index/64)*32,width:32,height:32}));
        expect(adopt({...f,width:2048,height:1024},[{...p,width:2048,height:1024,topology:{owner:{x0:20,y0:20,x1:180,y1:120},tiles}}]).support).toBeUndefined();
    });
    it('矩形第二seed的路径有内部隔断时仍不授权，不能用同色跳过连通',()=>{
        const f=basic();for(let y=0;y<200;y++)for(let x=0;x<200;x++)if(x<20||x>=180||y<20||y>=120)f.set(x,y,[0,0,0,255]);f.set(25,73,[0,0,0,255]);expect(produceImageParagraphGapProofs(f.page,200,200,f.pixels)).toEqual([]);
    });
    it('借用像素在H8/corridor之后漂移，seed或两个owner不一致均不授权',()=>{
        const base=()=>{const f=basic();for(let y=0;y<200;y++)for(let x=0;x<200;x++)if(x<20||x>=180||y<20||y>=120)f.set(x,y,[0,0,0,255]);return f;};
        const seed=base();let seedReads=0;const seedIndex=(39*200+39)*4,unstable=new Proxy(seed.pixels,{get(target,key){if(key===String(seedIndex)&&++seedReads>=3)return 0;return Reflect.get(target,key,target);}});expect(produceImageParagraphGapProofs(seed.page,200,200,unstable)).toEqual([]);
        for(const curved of [false,true]){const f=base();for(let y=65;y<70;y++)for(let x=20;x<180;x++)f.set(x,y,[0,0,0,255]);if(curved)f.set(20,20,[0,0,0,255]);let checks=0;
            const pixels=new Proxy(f.pixels,{get(target,key){if(typeof key==='string'&&/^\d+$/u.test(key)){const i=Number(key),p=Math.floor(i/4),x=p%200,y=Math.floor(p/200);if(checks>2&&checks<30&&x>=40&&x<130&&y>=65&&y<70)return [24,44,68,255][i%4];}return Reflect.get(target,key,target);}});
            expect(produceImageParagraphGapProofs(f.page,200,200,pixels,()=>{checks++;})).toEqual([]);
        }
    });
    it('候选枚举后raw几何改到前一owner marker也不能替代原snapshot',()=>{
        const f=basic();for(let y=0;y<200;y++)for(let x=0;x<200;x++)if(x<20||x>=180||y<20||y>=140)f.set(x,y,[0,0,0,255]);
        f.page.results.push({text:'THIRD LINE',confidence:.99,box:{x:40,y:108,width:90,height:14}});let checks=0;
        expect(produceImageParagraphGapProofs(f.page,200,200,f.pixels,()=>{if(++checks===4)f.page.results[1].box.y=40;})).toEqual([]);
    });
    it.each(['single','adjacent','opposite','three','same-exterior-color'] as const)('clipped-%s附件不能借观察域边数获得权限',kind=>{
        const f=basic(),color=kind==='same-exterior-color'?[0,0,0,255]:[230,240,250,255];
        const box=kind==='single'?{x0:198,x1:200,y0:45,y1:55}:kind==='adjacent'||kind==='same-exterior-color'?{x0:180,x1:200,y0:28,y1:46}:kind==='opposite'?{x0:160,x1:180,y0:28,y1:100}:{x0:180,x1:200,y0:28,y1:100};
        for(let y=box.y0;y<box.y1;y++)for(let x=box.x0;x<box.x1;x++)f.set(x,y,color);
        expect(produceImageParagraphGapProofs(f.page,200,200,f.pixels)).toEqual([]);
    });
    it.each(['single','adjacent','opposite','three','same-exterior-color'] as const)('closed-owner内clipped-%s附件仍不属于外部组件',kind=>{
        const f=basic();for(let y=0;y<200;y++)for(let x=0;x<200;x++)if(x<20||x>=180||y<20||y>=140)f.set(x,y,[0,0,0,255]);
        // 真实几何旁栏把观察域截到x150；附件完整形状仍藏在同matte owner内部。
        f.page.results.push({text:'OTHER COLUMN',confidence:.99,box:{x:170,y:150,width:14,height:14}});
        const box=kind==='single'?{x0:148,x1:160,y0:45,y1:55}:kind==='adjacent'||kind==='same-exterior-color'?{x0:140,x1:160,y0:28,y1:46}:kind==='opposite'?{x0:140,x1:148,y0:28,y1:100}:{x0:140,x1:160,y0:28,y1:100};
        for(let y=box.y0;y<box.y1;y++)for(let x=box.x0;x<box.x1;x++)f.set(x,y,kind==='same-exterior-color'?[0,0,0,255]:[230,240,250,255]);
        expect(produceImageParagraphGapProofs(f.page,200,200,f.pixels)).toEqual([]);
    });
    it.each(['island','edge-island','corridor','different-matte','inner-panel','ink-leaks','all-background'] as const)('%s不能获得续行许可',kind=>{
        const f=basic();if(kind==='island')f.set(160,45);if(kind==='edge-island')for(let x=198;x<200;x++)f.set(x,45);if(kind==='corridor')f.set(80,65);if(kind==='different-matte')for(let y=65;y<200;y++)for(let x=0;x<200;x++)f.set(x,y,[25,45,69,255]);
        if(kind==='inner-panel')for(let x=40;x<130;x++)f.set(x,65);if(kind==='ink-leaks')for(let x=30;x<45;x++)f.set(x,45);if(kind==='all-background')for(let i=0;i<f.pixels.length;i+=4)f.pixels.set([24,44,68,255],i);
        expect(produceImageParagraphGapProofs(f.page,200,200,f.pixels)).toEqual([]);
    });
    it('未证明封闭owner的贯穿边线仍拒绝，较紧不同owner及明显旁栏不合并',()=>{
        const f=basic();for(let y=0;y<200;y++)f.set(10,y);expect(produceImageParagraphGapProofs(f.page,200,200,f.pixels)).toEqual([]);
        f.page.bubbles=[{bbox:{x0:30,y0:30,x1:140,y1:60},results:[]},{bbox:{x0:30,y0:70,x1:140,y1:95},results:[]}];expect(produceImageParagraphGapProofs(f.page,200,200,f.pixels)).toEqual([]);
        const g=basic();g.page.results[1].box.x=135;expect(produceImageParagraphGapProofs(g.page,200,200,g.pixels)).toEqual([]);
    });
    it('只有完整封闭同owner及实际外部连通才允许截断曲边，receipt能逐tile重算',()=>{
        const f=basic(),original=f.pixels.slice();for(let y=0;y<200;y++)for(let x=0;x<200;x++)if(x<20||x>=180||y<20||y>=120)f.set(x,y,[0,0,0,255]);
        const proof=produceImageParagraphGapProofs(f.page,200,200,f.pixels);expect(proof).toHaveLength(1);expect(proof[0].topology?.owner).toEqual({x0:20,y0:20,x1:180,y1:120});
        const tiles=proof[0].topology!.tiles;expect(new Set(tiles.map(g=>`${g.left},${g.top}`)).size).toBe(tiles.length);expect(tiles.every(g=>g.width<=32&&g.height<=32)).toBe(true);
        const a=adopt(f,proof);expect(a.support?.permits(a.regions[0],a.regions[1],[a.regions[0]],bounds(a.regions))).toBe(true);expect(Buffer.compare(Buffer.from(f.pixels.buffer,f.pixels.byteOffset,f.pixels.byteLength),Buffer.from(original.buffer,original.byteOffset,original.byteLength))).not.toBe(0);
        for(const edit of [(p:ImageParagraphGapProof)=>p.topology!.tiles.push({...p.topology!.tiles[0]}),(p:ImageParagraphGapProof)=>p.topology!.tiles[0].left++,(p:ImageParagraphGapProof)=>p.topology!.owner.x0=0]){const copy=structuredClone({...f.page,imageParagraphGapProofs:proof}),p=copy.imageParagraphGapProofs[0];edit(p);expect(adopt({...f,page:copy},[p]).support).toBeUndefined();}
    });
    it.each([NaN,0,8193])('非法页尺寸%s不观察像素',dimension=>{const f=basic();expect(produceImageParagraphGapProofs(f.page,dimension,200,f.pixels)).toEqual([]);});
    it('非法页graph、数组、RGBA和raw项均没有权限',()=>{
        const f=basic();expect(produceImageParagraphGapProofs({results:null} as never,200,200,f.pixels)).toEqual([]);expect(produceImageParagraphGapProofs({results:[],bubbles:null} as never,200,200,f.pixels)).toEqual([]);
        expect(produceImageParagraphGapProofs({results:[],bubbles:[{results:null}]} as never,200,200,f.pixels)).toEqual([]);expect(produceImageParagraphGapProofs({results:Array(4097).fill(f.page.results[0])},200,200,f.pixels)).toEqual([]);
        expect(produceImageParagraphGapProofs(f.page,200,200,new Uint8ClampedArray())).toEqual([]);expect(produceImageParagraphGapProofs(f.page,200,200,[] as never)).toEqual([]);
        for(const item of [{...f.page.results[0],box:null},{...f.page.results[0],text:'123'},{...f.page.results[0],confidence:.2},{...f.page.results[0],box:{x:20,y:20,width:0,height:12}}])expect(produceImageParagraphGapProofs({results:[item,f.page.results[1]]} as never,200,200,f.pixels)).toEqual([]);
    });
    it('取消发生在观察前和行扫描中均向owner抛回；原数组不改',()=>{
        const f=basic(),before=f.pixels.slice(),error=new Error('cancelled');expect(()=>produceImageParagraphGapProofs(f.page,200,200,f.pixels,()=>{throw error;})).toThrow(error);
        const check=vi.fn(()=>{if(check.mock.calls.length>3)throw error;});expect(()=>produceImageParagraphGapProofs(f.page,200,200,f.pixels,check)).toThrow(error);expect(f.pixels).toEqual(before);
    });
    it('无证明或空/过多proof和尺寸不符时不绑定',()=>{
        const f=basic();expect(adopt(f,[]).support).toBeUndefined();const p=produceImageParagraphGapProofs(f.page,200,200,f.pixels)[0];expect(adopt(f,Array(129).fill(p)).support).toBeUndefined();
        const c=createImageParagraphGapConsumer({...f.page,imageParagraphGapProofs:[p]},0,200),r=rawRegions(f.page);c.seal(r);bindImageParagraphGapEvidence(r,'source',0,200);expect(getImageParagraphGapEvidence(r,'source',0,200)).toBeUndefined();
    });
    it('证明版本、预算、序号、端点快照与局部几何均严格校验',()=>{
        const edits:Array<(p:ImageParagraphGapProof)=>void>=[p=>p.version='wrong' as never,p=>p.width++,p=>p.height++,p=>p.ordinal=0,p=>p.ordinal=129,p=>p.ordinal=NaN,p=>p.pixels++,p=>p.previousSnapshot.text+='x',p=>p.nextSnapshot.confidence=.9,p=>p.previousGeometry.width++,p=>p.nextGeometry.background=[0,0,0,255],p=>p.previousGeometry.background=[24,44,68,254],p=>p.previousGeometry.supportBox.x0=-1];
        for(const edit of edits){const f=basic(),p=produceImageParagraphGapProofs(f.page,200,200,f.pixels)[0];edit(p);expect(adopt(f,[p]).support).toBeUndefined();}
    });
});
