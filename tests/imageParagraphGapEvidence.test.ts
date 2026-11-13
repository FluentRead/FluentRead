import {describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {inflateSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {produceImageParagraphGapProofs,createImageParagraphGapConsumer,bindImageParagraphGapEvidence,getImageParagraphGapEvidence,consumeImageParagraphGapEvidence,createImageParagraphWorkQueue,type ImageParagraphGapProof} from '@/src/features/image-translation/services/imageParagraphGapEvidence';
import {flattenOcrAlpha} from '@/src/features/image-translation/services/ocrPixels';
import {imageMatteObservationBox,observeImageMatteGeometry,planImageMatteCandidate} from '@/src/features/image-translation/services/imageMatteRepair';
import {groupImageParagraphs,type ImageTextRegion} from '@/src/features/image-translation/paragraphs';
import type {MangaOcrPage} from '@/src/features/image-translation/services/mangaBubbles';
import {collectMangaRegions} from '@/src/features/image-translation/services/mangaBubbles';
import * as sourceInk from '@/src/features/image-translation/services/sourceInk';
import {mergeMangaParagraphContinuations,type MangaRegion} from '@/src/features/image-translation/services/mangaRegions';
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
function smoothFieldFixture(){
    const f=basic();
    for(let y=56;y<72;y++)for(let x=40;x<130;x++){
        const value=24+Math.round((x-40)*20/89);f.pixels.set([value,value+20,value+20,255],(y*f.width+x)*4);
    }
    return f;
}
function alphaLongFixture(){
    const f=basic();f.page.largeAlphaHoles=true;f.page.results[1]!.box.y=90;
    for(let y=77;y<85;y++)for(let x=43;x<46;x++)f.set(x,y,[24,44,68,255]);
    for(let y=93;y<101;y++)for(let x=43;x<46;x++)f.set(x,y,[230,240,250,255]);
    return f;
}
function styleGradient(firstHeight=25,secondColor=[18,26,45,255],third=false){
    const width=320,height=240,pixels=new Uint8ClampedArray(width*height*4);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)pixels.set([90+x*.3,110+x*.1,135,255],(y*width+x)*4);
    const results=[{text:'FIRST HEADING',confidence:.99,box:{x:40,y:40,width:170,height:firstHeight}},
        {text:'SECOND HEADING',confidence:.99,box:{x:40,y:100,width:170,height:20}},
        ...(third?[{text:'THIRD HEADING',confidence:.99,box:{x:40,y:160,width:170,height:25}}]:[])];
    for(const [i,item] of results.entries())for(let y=item.box.y+3;y<item.box.y+item.box.height-3;y++)for(let x=item.box.x+4;x<item.box.x+item.box.width-4;x++)pixels.set(i===1?secondColor:[245,245,250,255],(y*width+x)*4);
    return {width,height,pixels,page:{results} as MangaOcrPage};
}
describe('渐变上的标题样式边界',()=>{
    it('冻结招牌的大小与字色差异保留两块完整标题，不借同背景强行合段',()=>{
        const raw=gunzipSync(readFileSync(new URL('./fixtures/manga-color-quality/truth/prism-platform-gradient-signs.source-rgba.bin.gz',import.meta.url)));
        const pixels=new Uint8ClampedArray(raw.buffer,raw.byteOffset,raw.byteLength),before=createHash('sha256').update(pixels).digest('hex');
        const page:MangaOcrPage={results:[{text:'FOLLOW THE EASTERN TRACK',confidence:.98,box:{x:181,y:130,width:822,height:37}},
            {text:'THE NEXT TRAIN IS ALMOST HERE',confidence:.98,box:{x:179,y:205,width:715,height:28}}]};
        page.imageParagraphGapProofs=produceImageParagraphGapProofs(page,1600,900,pixels);expect(page.imageParagraphGapProofs).toEqual([]);
        const grouped=collectMangaRegions(page,'en',1600,900,'manga','same-source');
        expect(grouped.map(r=>r.text)).toEqual(page.results.map(r=>r.text));expect(grouped.map(r=>r.fontSize)).toEqual([37,28]);
        expect(grouped.map(r=>r.sourceBoxes)).toEqual(grouped.map(r=>[r.bbox]));expect(createHash('sha256').update(pixels).digest('hex')).toBe(before);
    });
    it('字号差异与明确字色差异同时成立才撤回渐变续行',()=>{
        const different=styleGradient();expect(produceImageParagraphGapProofs(different.page,different.width,different.height,different.pixels)).toEqual([]);
        for(const f of [styleGradient(24),styleGradient(25,[245,245,250,255]),styleGradient(25,[230,230,235,255]),styleGradient(25,[130,140,155,255])])
            expect(produceImageParagraphGapProofs(f.page,f.width,f.height,f.pixels).map(p=>p.mode)).toEqual(['column-profile']);
        const uncertain=styleGradient();uncertain.pixels.set([255,0,0,255],(45*uncertain.width+50)*4);
        expect(produceImageParagraphGapProofs(uncertain.page,uncertain.width,uncertain.height,uncertain.pixels).map(p=>p.mode)).toEqual(['column-profile']);
        const corridor=styleGradient(25,[245,245,250,255]);corridor.pixels[(80*corridor.width+100)*4]^=1;
        expect(produceImageParagraphGapProofs(corridor.page,corridor.width,corridor.height,corridor.pixels)).toEqual([]);
    });
    it('同页共享行只观察一次，源色不明确的缓存也不重复扫描',()=>{
        for(const color of [[245,245,250,255],[130,140,155,255]]){
            const f=styleGradient(25,color,true),original=sourceInk.observeImageSourceInk,spy=vi.spyOn(sourceInk,'observeImageSourceInk').mockImplementation(original);
            try{expect(produceImageParagraphGapProofs(f.page,f.width,f.height,f.pixels)).toHaveLength(2);expect(spy).toHaveBeenCalledTimes(3);}finally{spy.mockRestore();}
        }
    });
    it('额外源色面积在整页共享收费，耗尽后保留原有候选规则',()=>{
        const width=1000,height=2000,pixels=new Uint8ClampedArray(width*height*4),page:MangaOcrPage={results:[]};
        for(let y=0;y<height;y++)for(let x=0;x<width;x++)pixels.set([90+x%410*.3,125+x%410*.1,150,255],(y*width+x)*4);
        for(let n=0;n<13;n++)for(const x of [40,450])for(const [dy,h] of [[0,25],[60,20]]){
            const y=40+n*140+dy;page.results.push({text:'STYLE CONTROL',confidence:.99,box:{x,y,width:170,height:h}});
            for(let yy=y+3;yy<y+h-3;yy++)for(let xx=x+4;xx<x+166;xx++)pixels.set([245,245,250,255],(yy*width+xx)*4);
        }
        const original=sourceInk.observeImageSourceInk;let paid=0;
        const spy=vi.spyOn(sourceInk,'observeImageSourceInk').mockImplementation((...args)=>{const roi=imageMatteObservationBox(args[1],args[2],args[3])!;paid+=roi.width*roi.height*2;return original(...args);});
        try{expect(produceImageParagraphGapProofs(page,width,height,pixels).length).toBeGreaterThan(10);expect(paid).toBeGreaterThan(240000);expect(paid).toBeLessThanOrEqual(262144);}finally{spy.mockRestore();}
    });
    it('源色观察后的快照漂移不发布旧关系，取消仍传播首因',()=>{
        const f=styleGradient(25,[245,245,250,255]),original=sourceInk.observeImageSourceInk;
        const spy=vi.spyOn(sourceInk,'observeImageSourceInk').mockImplementation((...args)=>{f.page.results[0].text='CHANGED';return original(...args);});
        try{expect(produceImageParagraphGapProofs(f.page,f.width,f.height,f.pixels)).toEqual([]);}finally{spy.mockRestore();}
        const g=styleGradient(),abort=new DOMException('cancelled','AbortError');let aborted=false;
        const cancel=vi.spyOn(sourceInk,'observeImageSourceInk').mockImplementation((...args)=>{aborted=true;return original(...args);});
        try{expect(()=>produceImageParagraphGapProofs(g.page,g.width,g.height,g.pixels,()=>{if(aborted)throw abort;})).toThrow(abort);}finally{cancel.mockRestore();}
    });
});
describe('低对比平滑间隙证明的生产消费',()=>{
    it('精准微渐变可以逐列复核，陡变和半透明高对比带不能冒充平滑背景',()=>{
        const column=basic();
        for(let y=56;y<72;y++)for(let x=40;x<130;x++){const value=24+Math.round((x-40)*30/89);column.pixels.set([value,value+20,value+40,255],(y*column.width+x)*4);}
        expect(produceImageParagraphGapProofs(column.page,column.width,column.height,column.pixels).map(proof=>proof.mode)).toEqual(['column-profile']);

        const jagged=basic();
        for(let y=56;y<72;y++)for(let x=40;x<130;x++){const value=24+Math.floor((x-40)/2)*3;jagged.pixels.set([value,value+20,value+40,255],(y*jagged.width+x)*4);}
        expect(produceImageParagraphGapProofs(jagged.page,jagged.width,jagged.height,jagged.pixels)).toEqual([]);

        const translucent=basic();
        for(let y=56;y<72;y++)for(let x=40;x<130;x++){const value=24+Math.round((x-40)*30/89);translucent.pixels.set([value,value+20,value+40,180],(y*translucent.width+x)*4);}
        expect(produceImageParagraphGapProofs(translucent.page,translucent.width,translucent.height,translucent.pixels)).toEqual([]);
    });
    it('同帧平滑渐变通过profile窗口与无topology预算验证后才绑定',()=>{
        const f=smoothFieldFixture();
        const proofs=produceImageParagraphGapProofs(f.page,f.width,f.height,f.pixels);
        expect(proofs.map(proof=>proof.mode)).toEqual(['smooth-field']);expect(proofs[0].topology).toBeUndefined();
        const accepted=adopt(f,proofs);
        expect(accepted.support?.successor(accepted.regions[0])).toBe(accepted.regions[1]);
        expect(accepted.support?.permits(accepted.regions[0],accepted.regions[1],[accepted.regions[0]],bounds(accepted.regions))).toBe(true);
    });
    it('profile proof的窗口过窄或夹带topology时拒绝消费',()=>{
        const f=smoothFieldFixture(),base=produceImageParagraphGapProofs(f.page,f.width,f.height,f.pixels)[0],previous=f.page.results[0],next=f.page.results[1];
        previous.box.height=4;next.box.y=47;next.box.height=4;
        const geometry=(item:typeof previous)=>{const source={x0:item.box.x,y0:item.box.y,x1:item.box.x+item.box.width,y1:item.box.y+item.box.height};return {...imageMatteObservationBox(f.width,f.height,source)!,background:[24,44,68,255] as [number,number,number,number],supportBox:source};};
        const tight={...base,previousSnapshot:{...base.previousSnapshot,box:{...previous.box}},nextSnapshot:{...base.nextSnapshot,box:{...next.box}},
            previousGeometry:geometry(previous),nextGeometry:geometry(next)};
        expect(adopt(f,[tight]).support).toBeUndefined();
        const g=smoothFieldFixture(),proof=produceImageParagraphGapProofs(g.page,g.width,g.height,g.pixels)[0];
        const withTopology={...proof,topology:{owner:{x0:40,y0:40,x1:130,y1:88},tiles:[]}};
        expect(adopt(g,[withTopology]).support).toBeUndefined();
    });
    it('profile proof不得携带flat-owner采样字段',()=>{
        const f=smoothFieldFixture(),proof=produceImageParagraphGapProofs(f.page,f.width,f.height,f.pixels)[0]!;
        expect(adopt(f,[{...proof,flatOwner:{x:85,anchorY:38,targetY:72,runStart:40,runEnd:130}}]).support).toBeUndefined();
    });
    it.each([59,60])('RGBA alpha低于128时在profile首行或后续行拒绝：y=%s',y=>{
        const f=smoothFieldFixture(),proofs=produceImageParagraphGapProofs(f.page,f.width,f.height,f.pixels);
        f.pixels[(y*f.width+40)*4+3]=0;
        expect(produceImageParagraphGapProofs(f.page,f.width,f.height,f.pixels)).toEqual([]);
        expect(proofs.map(proof=>proof.mode)).toEqual(['smooth-field']);
    });
    it('超出64KiB的profile窗口在预扫描阶段拒绝',()=>{
        const width=3100,height=80,pixels=new Uint8ClampedArray(width*height*4);for(let i=0;i<pixels.length;i+=4)pixels.set([24,44,68,255],i);
        const page:MangaOcrPage={results:[{text:'FIRST WIDE LINE',confidence:.99,box:{x:30,y:5,width:3000,height:14}},{text:'SECOND WIDE LINE',confidence:.99,box:{x:30,y:54,width:3000,height:14}}]};
        expect(produceImageParagraphGapProofs(page,width,height,pixels)).toEqual([]);
    });
    it('同一行距超过有界profile窗口时直接保留原段',()=>{
        const width=2400,height=100,pixels=new Uint8ClampedArray(width*height*4);for(let i=0;i<pixels.length;i+=4)pixels.set([24,44,68,255],i);
        const page:MangaOcrPage={results:[{text:'FIRST WIDE LINE',confidence:.99,box:{x:10,y:10,width:2160,height:14}},{text:'SECOND WIDE LINE',confidence:.99,box:{x:21,y:59,width:2160,height:14}}]};
        expect(imageMatteObservationBox(width,height,{x0:10,y0:10,x1:2170,y1:24})?.width).toBe(2176);
        expect(produceImageParagraphGapProofs(page,width,height,pixels)).toEqual([]);
    });
    it.each([{count:100,width:126},{count:101,width:125}])('累计页预算拒绝完整profile行而不分配超额工作：%j',({count,width:boxWidth})=>{
        const width=3100,height=3250,pixels=new Uint8ClampedArray(width*height*4);for(let i=0;i<pixels.length;i+=4)pixels.set([24,44,68,255],i);
        const results:MangaOcrPage['results']=[];
        for(let index=0;index<count;index++){
            const x=10+(index%4)*150,y=10+Math.floor(index/4)*100;
            results.push({text:'DUMMY LINE',confidence:.99,box:{x,y,width:boxWidth,height:14}},{text:'DUMMY LINE',confidence:.99,box:{x,y:y+24,width:boxWidth,height:14}});
        }
        results.push({text:'TARGET LINE',confidence:.99,box:{x:50,y:3200,width:3000,height:14}},{text:'TARGET LINE',confidence:.99,box:{x:50,y:3224,width:3000,height:14}});
        const page:MangaOcrPage={results};expect(observeImageMatteGeometry(pixels,width,height,{x0:10,y0:10,x1:10+boxWidth,y1:24})).toBeUndefined();expect(observeImageMatteGeometry(pixels,width,height,{x0:50,y0:3200,x1:3050,y1:3214})).toBeUndefined();
        expect(produceImageParagraphGapProofs(page,width,height,pixels)).toEqual([]);
    });
    it('累计页预算在下一个profile首行前耗尽后停止枚举',()=>{
        const width=3500,height=1300,pixels=new Uint8ClampedArray(width*height*4);for(let i=0;i<pixels.length;i+=4)pixels.set([24,44,68,255],i);
        const results:MangaOcrPage['results']=[];
        for(let index=0;index<8;index++){const boxWidth=index===0?2123:2122;
            results.push({text:'DUMMY LINE',confidence:.99,box:{x:10,y:10+index*100,width:boxWidth,height:14}},{text:'DUMMY LINE',confidence:.99,box:{x:10,y:34+index*100,width:boxWidth,height:14}});
        }
        results.push({text:'TARGET LINE',confidence:.99,box:{x:50,y:1000,width:72,height:14}},{text:'TARGET LINE',confidence:.99,box:{x:50,y:1024,width:72,height:14}});
        expect(produceImageParagraphGapProofs({results},width,height,pixels)).toEqual([]);
    });
    it('平滑间隙内有实际识别框时不生成跨框证明',()=>{
        const width=3600,height=200,pixels=new Uint8ClampedArray(width*height*4);for(let i=0;i<pixels.length;i+=4)pixels.set([24,44,68,255],i);
        const page:MangaOcrPage={results:[{text:'FIRST LINE',confidence:.99,box:{x:1750,y:40,width:90,height:14}},{text:'SECOND LINE',confidence:.99,box:{x:1750,y:74,width:90,height:14}},{text:'PHYSICAL NOISE',confidence:.99,box:{x:1780,y:60,width:5,height:4}}]};
        for(const item of page.results.slice(0,2))for(let y=item.box.y+3;y<item.box.y+11;y++)for(let x=item.box.x+3;x<item.box.x+6;x++)pixels.set([230,240,250,255],(y*width+x)*4);
        for(let y=56;y<72;y++)for(let x=1750;x<1840;x++){const value=24+Math.round((x-1750)*20/89);pixels.set([value,value+20,value+20,255],(y*width+x)*4);}
        expect(produceImageParagraphGapProofs(page,width,height,pixels)).toEqual([]);
    });
    it('候选窗口预算耗尽当前平滑profile后继续保留原段',()=>{
        const width=3500,height=1300,pixels=new Uint8ClampedArray(width*height*4);for(let i=0;i<pixels.length;i+=4)pixels.set([24,44,68,255],i);
        const results:MangaOcrPage['results']=[];
        const boxes:Array<{x:number;y:number;width:number;height:number}>=Array.from({length:8},(_,index)=>[
            {x:10,y:10+index*100,width:index===0?2123:2122,height:14},{x:10,y:34+index*100,width:index===0?2123:2122,height:14},
        ]).flat();
        for(const box of boxes)results.push({text:'DUMMY LINE',confidence:.99,box});
        const first={x:1700,y:1000,width:41,height:14},next={x:1700,y:1024,width:41,height:14};
        results.push({text:'TARGET LINE',confidence:.99,box:first},{text:'TARGET LINE',confidence:.99,box:next},
            {text:'LEFT GUARD',confidence:.99,box:{x:1640,y:1000,width:41,height:14}},{text:'RIGHT GUARD',confidence:.99,box:{x:1760,y:1000,width:41,height:14}});
        for(const box of [first,next])for(let y=box.y+3;y<box.y+box.height-3;y++)for(let x=box.x+1;x<box.x+box.width-1;x++)pixels.set([230,240,250,255],(y*width+x)*4);
        for(let y=1016;y<1022;y++)for(let x=1700;x<1741;x++){const value=24+Math.round((x-1700)*20/40);pixels.set([value,value+20,value+20,255],(y*width+x)*4);}
        expect(observeImageMatteGeometry(pixels,width,height,{x0:first.x,y0:first.y,x1:first.x+first.width,y1:first.y+first.height})).toBeDefined();
        expect(observeImageMatteGeometry(pixels,width,height,{x0:next.x,y0:next.y,x1:next.x+next.width,y1:next.y+next.height})).toBeDefined();
        expect(produceImageParagraphGapProofs({results},width,height,pixels)).toEqual([]);
    });
});
describe('段落间隙预算与画外墨迹回退',()=>{
    it('不足两行空白像素的紧邻行不能产生颜色走廊证明',()=>{
        const f=basic();f.page.results[0].box.height=2;f.page.results[1].box.height=2;f.page.results[1].box.y=44;
        expect(produceImageParagraphGapProofs(f.page,f.width,f.height,f.pixels)).toEqual([]);
    });
    it('自然图原始像素复现白底和深蓝气泡的小字断段，整段消费保留逐行擦除框',()=>{
        const base=new URL('./fixtures/image-translation/paragraph-gaps/',import.meta.url);
        const manifest=JSON.parse(readFileSync(new URL('manifest.json',base),'utf8'));
        expect(createHash('sha256').update(readFileSync(new URL(manifest.source,base))).digest('hex')).toBe(manifest.sourceSha256);
        for(const fixture of manifest.fixtures){
            const bytes=gunzipSync(readFileSync(new URL(fixture.file,base)));
            expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixture.rgbaSha256);
            const page:MangaOcrPage={results:fixture.rows};
            const f={...basic(),width:fixture.width,height:fixture.height,pixels:new Uint8ClampedArray(bytes),page};
            const {regions,support,proofs}=adopt(f);
            expect(proofs.some(proof=>proof.mode==='tight-field')).toBe(true);
            const grouped=groupImageParagraphs(regions,support);
            expect(grouped).toHaveLength(1);
            expect(grouped[0].text).toBe(fixture.rows.map((row:{text:string})=>row.text).join(' '));
            expect(grouped[0].sourceBoxes).toEqual(regions.map(region=>region.bbox));
            const manga=mergeMangaParagraphContinuations(regions as MangaRegion[],support);
            expect(manga.flatMap(region=>region.sourceBoxes??[region.bbox])).toEqual(regions.map(region=>region.bbox));
            const tight=proofs.find(proof=>proof.mode==='tight-field')!;
            tight.previous.text+='.';tight.previousSnapshot.text+='.';
            expect(adopt(f,[tight]).support).toBeUndefined();
        }
    });
    it('共同气泡内的中等行距可续接未完句，但句末不借此跨段',()=>{
        const f=basic();f.page.results[1].box.y=68;
        f.page.bubbles=[{bbox:{x0:30,y0:30,x1:150,y1:110},results:[]}];
        for(let y=43;y<51;y++)for(let x=20;x<30;x++)f.set(x,y);
        expect(produceImageParagraphGapProofs(f.page,f.width,f.height,f.pixels).map(proof=>proof.mode)).toEqual(['flat-owner']);
        f.page.results[0].text+='.';
        expect(produceImageParagraphGapProofs(f.page,f.width,f.height,f.pixels)).toEqual([]);
    });
    it('同一气泡的小字短行按实际相邻关系连续合段，前后行不冒充竞争者',()=>{
        const f=basic();
        f.page.results=[
            {text:'FOLLOW',confidence:.99,box:{x:40,y:40,width:90,height:14}},
            {text:'THE BLUE',confidence:.99,box:{x:40,y:64,width:90,height:14}},
            {text:'LANTERNS.',confidence:.99,box:{x:40,y:88,width:90,height:14}},
        ];
        f.page.bubbles=[{bbox:{x0:30,y0:30,x1:150,y1:120},results:[]}];
        for(let i=0;i<f.pixels.length;i+=4)f.pixels.set([24,44,68,255],i);
        for(const row of f.page.results)for(let y=row.box.y+3;y<row.box.y+11;y++)for(let x=43;x<46;x++)f.set(x,y);
        // 原字体旁的图案使matte单框证明不可用，必须复核实际行间空白与共同气泡。
        for(let y=43;y<51;y++)for(let x=20;x<30;x++)f.set(x,y);
        const {regions,support}=adopt(f);
        expect(support).toBeDefined();
        const grouped=groupImageParagraphs(regions,support);
        expect(grouped).toHaveLength(1);
        expect(grouped[0].text).toBe('FOLLOW THE BLUE LANTERNS.');
        expect(grouped[0].sourceBoxes).toHaveLength(3);
        f.set(80,59);
        const obstructed=adopt(f);
        expect(groupImageParagraphs(obstructed.regions,obstructed.support)).toHaveLength(2);
    });
    it('平色对话在同一气泡内依照段距续接，而画面边缘锚点和短平色采样不授权',()=>{
        const sameBubble=basic();sameBubble.page.results[1]!.box.y=80;
        sameBubble.page.bubbles=[{bbox:{x0:30,y0:30,x1:150,y1:110},results:[]}];
        for(let y=43;y<51;y++)for(let x=20;x<30;x++)sameBubble.set(x,y,[230,240,250,255]);
        expect(produceImageParagraphGapProofs(sameBubble.page,sameBubble.width,sameBubble.height,sameBubble.pixels).map(proof=>proof.mode)).toEqual(['flat-owner']);

        const edge=basic();edge.page.results[0]!.text='FIRST LINE.';edge.page.results[1]!.text='SECOND LINE.';
        edge.page.results[0]!.box.y=0;edge.page.results[1]!.box.y=34;
        for(let y=43;y<51;y++)for(let x=20;x<30;x++)edge.set(x,y,[230,240,250,255]);
        expect(produceImageParagraphGapProofs(edge.page,edge.width,edge.height,edge.pixels)).toEqual([]);

        const shortRun=basic();
        shortRun.page.results[0]!.box.y=40;shortRun.page.results[1]!.box.y=80;
        shortRun.page.bubbles=[{bbox:{x0:30,y0:30,x1:150,y1:110},results:[]}];
        const anchorY=shortRun.page.results[0]!.box.y-2,targetY=shortRun.page.results[1]!.box.y-2;
        for(let y=43;y<51;y++)for(let x=20;x<30;x++)shortRun.set(x,y,[230,240,250,255]);
        for(let x=40;x<130;x++)shortRun.set(x,anchorY,[80,90,100,255]);
        for(let x=60;x<65;x++)shortRun.set(x,anchorY,[24,44,68,255]);
        for(let x=40;x<130;x++)shortRun.set(x,targetY,[24,44,68,255]);
        expect(produceImageParagraphGapProofs(shortRun.page,shortRun.width,shortRun.height,shortRun.pixels)).toEqual([]);
    });
    it('OCR框贴近页面左缘时拓扑锚点和目标seed均越界后保守撤回',()=>{
        const anchor=basic();anchor.page.results[0]!.box.x=0;anchor.page.results[1]!.box.x=0;
        const first=anchor.page.results[0]!,second=anchor.page.results[1]!;
        expect(observeImageMatteGeometry(anchor.pixels,anchor.width,anchor.height,{x0:0,y0:first.box.y,x1:first.box.width,y1:first.box.y+first.box.height})).toBeUndefined();
        expect(observeImageMatteGeometry(anchor.pixels,anchor.width,anchor.height,{x0:0,y0:second.box.y,x1:second.box.width,y1:second.box.y+second.box.height})).toBeUndefined();
        expect(produceImageParagraphGapProofs(anchor.page,anchor.width,anchor.height,anchor.pixels)).toEqual([]);
    });
    it('原图边侧有孤立插画时拒绝原窗口并回退到经像素核验的同句平坦gap',()=>{
        const f=basic();f.page.results[0]!.text='FIRST LINE.';f.page.results[1]!.text='SECOND LINE.';
        for(let y=43;y<51;y++)for(let x=20;x<30;x++)f.set(x,y,[230,240,250,255]);
        const first=f.page.results[0]!,second=f.page.results[1]!;
        expect(observeImageMatteGeometry(f.pixels,f.width,f.height,{x0:first.box.x,y0:first.box.y,x1:first.box.x+first.box.width,y1:first.box.y+first.box.height})).toBeDefined();
        expect(observeImageMatteGeometry(f.pixels,f.width,f.height,{x0:second.box.x,y0:second.box.y,x1:second.box.x+second.box.width,y1:second.box.y+second.box.height})).toBeDefined();
        const proofs=produceImageParagraphGapProofs(f.page,f.width,f.height,f.pixels);
        expect(proofs.map(proof=>proof.mode)).toEqual(['flat-owner']);
        const accepted=adopt(f,proofs);expect(accepted.support?.successor(accepted.regions[0]!)).toBe(accepted.regions[1]);
    });
    it('flat-owner的采样中点被改写时消费者拒绝伪造续行',()=>{
        const f=basic();f.page.results[0]!.text='FIRST LINE.';f.page.results[1]!.text='SECOND LINE.';
        for(let y=43;y<51;y++)for(let x=20;x<30;x++)f.set(x,y,[230,240,250,255]);
        const proof=produceImageParagraphGapProofs(f.page,f.width,f.height,f.pixels)[0]!;
        expect(proof.mode).toBe('flat-owner');
        expect(adopt(f,[{...proof,flatOwner:{...proof.flatOwner!,x:proof.flatOwner!.x+1}}]).support).toBeUndefined();
    });
    it('flat-owner采样通过后原像素漂移会撤回预检候选',()=>{
        const f=basic();f.page.results[0]!.text='FIRST LINE.';f.page.results[1]!.text='SECOND LINE.';
        for(let y=43;y<51;y++)for(let x=20;x<30;x++)f.set(x,y,[230,240,250,255]);
        const baseline=produceImageParagraphGapProofs(f.page,f.width,f.height,f.pixels);
        expect(baseline.map(proof=>proof.mode)).toEqual(['flat-owner']);
        const sample=baseline[0]!.flatOwner!,offset=(sample.anchorY*f.width+sample.x)*4;
        let revoked=false;
        for(let switchAfter=0;switchAfter<16;switchAfter++){
            let reads=0;
            const pixels=new Proxy(f.pixels,{get(target,key){if(key===String(offset)){reads++;if(reads>switchAfter)return 0;}return Reflect.get(target,key,target);}});
            const proofs=produceImageParagraphGapProofs(f.page,f.width,f.height,pixels);
            if(!proofs.length)revoked=true;
        }
        expect(revoked).toBe(true);
    });
    it('页面像素预算耗尽时撤回最后一个平滑gap候选并保留此前证明',()=>{
        const width=450,height=5200,pixels=new Uint8ClampedArray(width*height*4);
        for(let y=0;y<height;y++)for(let x=0;x<width;x++){
            const value=24+Math.round((Math.max(100,Math.min(350,x))-100)*20/250);pixels.set([value,value+20,value+20,255],(y*width+x)*4);
        }
        const results:MangaOcrPage['results']=[];
        for(let index=0;index<27;index++){
            const y=10+index*200;
            results.push({text:`FIRST DIALOGUE LINE ${index}.`,confidence:.99,box:{x:100,y,width:250,height:30}},
                {text:`SECOND DIALOGUE LINE ${index}.`,confidence:.99,box:{x:100,y:y+105,width:250,height:30}});
        }
        const proofs=produceImageParagraphGapProofs({results},width,height,pixels);
        expect(proofs).toHaveLength(26);expect(proofs.every(proof=>proof.mode==='smooth-field')).toBe(true);
    });
    it('预算边缘先收费端点，再拒绝profile、平滑行和flat-owner采样',()=>{
        const build=(targetWidth:number,flat=false)=>{
            const width=850,height=5200,pixels=new Uint8ClampedArray(width*height*4),results:MangaOcrPage['results']=[],
                bubbles:NonNullable<MangaOcrPage['bubbles']>=[];
            for(let y=0;y<height;y++)for(let x=0;x<width;x++){const value=24+Math.round((Math.max(100,Math.min(350,x))-100)*20/250);pixels.set([value,value+20,value+20,255],(y*width+x)*4);}
            const addPair=(label:string,x:number,y:number,w:number,gap:number)=>{
                const first={text:`FIRST DIALOGUE LINE ${label}.`,confidence:.99,box:{x,y,width:w,height:30}},
                    second={text:`SECOND DIALOGUE LINE ${label}.`,confidence:.99,box:{x,y:y+30+gap,width:w,height:30}};
                results.push(first,second);bubbles.push({bbox:{x0:x-10,y0:y-10,x1:x+w+10,y1:y+70+gap},results:[]});
            };
            for(let index=0;index<25;index++)addPair(String(index),100,10+index*200,250,75);
            addPair('TARGET',100,5010,targetWidth,75);
            if(flat){
                for(let y=5045;y<5110;y++)for(let x=100;x<100+targetWidth;x++)pixels.set([24,44,68,255],(y*width+x)*4);
                for(const y of [5008,5113])for(let x=100;x<100+targetWidth;x++)pixels.set([24,44,68,255],(y*width+x)*4);
            }
            return{width,height,pixels,results,bubbles};
        };
        for(const [targetWidth,flat] of [[315,false],[250,false],[185,true]] as const){
            const f=build(targetWidth,flat),proofs=produceImageParagraphGapProofs({results:f.results,bubbles:f.bubbles},f.width,f.height,f.pixels);
            expect(proofs).toHaveLength(25);expect(proofs.some(proof=>proof.previous.text.includes('TARGET'))).toBe(false);
        }
    });
    it('普通布局窗口先收费，清理失败后的profile预算不足时停止fallback',()=>{
        const width=450,height=5600,pixels=new Uint8ClampedArray(width*height*4),results:MangaOcrPage['results']=[],
            bubbles:NonNullable<MangaOcrPage['bubbles']>=[];
        for(let y=0;y<height;y++)for(let x=0;x<width;x++){const value=24+Math.round((Math.max(100,Math.min(350,x))-100)*20/250);pixels.set([value,value+20,value+20,255],(y*width+x)*4);}
        const addPair=(label:string,x:number,y:number,w:number,gap:number,ink=false)=>{
            const first={text:`FIRST DIALOGUE LINE ${label}.`,confidence:.99,box:{x,y,width:w,height:30}},
                second={text:`SECOND DIALOGUE LINE ${label}.`,confidence:.99,box:{x,y:y+30+gap,width:w,height:30}};
            results.push(first,second);bubbles.push({bbox:{x0:x-10,y0:y-10,x1:x+w+10,y1:y+70+gap},results:[]});
            if(ink)for(const row of [first,second])for(let yy=row.box.y+5;yy<row.box.y+25;yy++)for(let xx=x+2;xx<x+w-2;xx++)
                pixels.set([230,240,250,255],(yy*width+xx)*4);
        };
        for(let index=0;index<25;index++)addPair(String(index),100,10+index*200,250,75);
        addPair('SMALL',100,5000,60,75);
        addPair('TARGET',100,5210,60,75,true);
        for(const row of results.filter(item=>item.text.includes('TARGET')))
            for(let y=row.box.y-8;y<row.box.y+row.box.height+8;y++)for(let x=92;x<168;x++)pixels.set([34,54,54,255],(y*width+x)*4);
        for(const row of results.filter(item=>item.text.includes('TARGET')))
            for(let y=row.box.y+8;y<row.box.y+20;y++)if(y!==row.box.y+14)
                for(let x=103;x<158;x+=8)for(let xx=x;xx<x+3;xx++)if(Math.abs(xx-(row.box.x+row.box.width/2))>2)pixels.set([230,240,250,255],(y*width+xx)*4);
        results.push(
            {text:'LEFT GUARD',confidence:.99,box:{x:40,y:5210,width:20,height:30}},
            {text:'RIGHT GUARD',confidence:.99,box:{x:191,y:5210,width:20,height:30}},
        );
        for(let y=5245;y<5310;y++)for(let x=100;x<160;x++){const value=24+Math.round((x-100)*20/59);pixels.set([value,value+20,value+20,255],(y*width+x)*4);}
        const target=results.find(item=>item.text==='FIRST DIALOGUE LINE TARGET.')!;
        expect(observeImageMatteGeometry(pixels,width,height,{x0:target.box.x,y0:target.box.y,x1:target.box.x+target.box.width,y1:target.box.y+target.box.height})).toBeDefined();
        const proofs=produceImageParagraphGapProofs({results,bubbles},width,height,pixels);
        expect(proofs.some(proof=>proof.previous.text.includes('TARGET'))).toBe(false);
    });
});
describe('大面积透明页的长间距续行',()=>{
    it('只为强对齐且像素完全平坦的未标点长间距绑定续行',()=>{
        const f=alphaLongFixture(),proofs=produceImageParagraphGapProofs(f.page,f.width,f.height,f.pixels);
        expect(proofs).toHaveLength(1);expect(proofs[0]).toMatchObject({mode:'flat-owner',alphaLongContinuation:true});
        const accepted=adopt(f,proofs);
        expect(accepted.support?.successor(accepted.regions[0])).toBe(accepted.regions[1]);
        expect(accepted.support?.permits(accepted.regions[0],accepted.regions[1],[accepted.regions[0]],bounds(accepted.regions))).toBe(true);
    });
    it('未标记透明页、错列行或有墨迹间隙仍拒绝长间距续行',()=>{
        const f=alphaLongFixture();f.page.largeAlphaHoles=undefined;expect(produceImageParagraphGapProofs(f.page,f.width,f.height,f.pixels)).toEqual([]);
        const shifted=alphaLongFixture();shifted.page.results[1]!.box.x+=20;expect(produceImageParagraphGapProofs(shifted.page,shifted.width,shifted.height,shifted.pixels)).toEqual([]);
        const marked=alphaLongFixture();marked.set(80,70,[235,235,235,255]);expect(produceImageParagraphGapProofs(marked.page,marked.width,marked.height,marked.pixels)).toEqual([]);
    });
});
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
    it('漫画消费旁证只接受同图尺寸，并立即解除缓存绑定',()=>{
        const f=basic(),value=adopt(f);
        expect(consumeImageParagraphGapEvidence(value.regions,'other',f.width,f.height)).toBeUndefined();
        expect(getImageParagraphGapEvidence(value.regions,'source',f.width,f.height)).toBeDefined();
        expect(consumeImageParagraphGapEvidence(value.regions,'source',f.width,f.height)).toBeDefined();
        expect(getImageParagraphGapEvidence(value.regions,'source',f.width,f.height)).toBeUndefined();
        expect(consumeImageParagraphGapEvidence(value.regions,'source',f.width,f.height)).toBeUndefined();
    });
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
        const check=vi.fn(),page={results:[f.page.results[0],...Array(130).fill(f.page.results[1])]};expect(produceImageParagraphGapProofs(page,200,200,empty,check)).toEqual([]);expect(check.mock.calls.length).toBeGreaterThanOrEqual(130);
        const width=1000,height=300,pixels=new Uint8ClampedArray(width*height*4).fill(255),first={text:'FIRST',confidence:.99,box:{x:100,y:50,width:600,height:20}},next={...first,text:'SECOND',box:{...first.box,y:100}},charged=vi.fn();
        expect(produceImageParagraphGapProofs({results:[first,...Array(130).fill(next)]},width,height,pixels,charged)).toEqual([]);expect(charged.mock.calls.length).toBeGreaterThanOrEqual(25);
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
