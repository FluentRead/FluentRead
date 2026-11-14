/** @file tests/mangaDetectionCore.test.ts 原检测核心与Box身份的拒绝边界、取消/额度和真实弱纹理及小字/数字/注音概率片段。 */
import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createMangaDetectionCore,MANGA_DETECTION_CORE_LIMITS as limits} from '@/src/features/image-translation/services/mangaDetectionCore';
type Core=ReturnType<typeof createMangaDetectionCore>;
const rect={x0:10,y0:10,x1:20,y1:20};
const box=()=>({x:10,y:10,width:10,height:10});
function frame(core:Core,w=64,h=48){
    const ticket=core.beginFrame(w,h,1536),ratio=Math.min(1,1536/Math.max(w,h)),width=Math.ceil(Math.round(w*ratio)/32)*32,height=Math.ceil(Math.round(h*ratio)/32)*32;
    const data=new Float32Array(width*height).fill(.1),input={dims:[1,3,height,width]},output={dims:[1,1,height,width],data};
    return {ticket,width,height,data,input,output};
}
function record(core:Core,f=frame(core),b=box(),raw=rect,mapped=raw){
    core.observe(f.ticket,f.input,f.output);core.observeRegion(f.ticket,f.width,f.height,raw,mapped);core.bindBoxes(f.ticket,[b]);core.endFrame(f.ticket);return b;
}
describe('检测核心只约束已绑定的同次原Box',()=>{
    it('弱响应不改数据、框或文字；任意有效核心均保留，包括同名短标签',()=>{
        for(const value of [.1,.299,.3,.99]){
            const c=createMangaDetectionCore();c.beginPage();const f=frame(c),b=box();f.data[19*f.width+19]=value;const original=f.data.slice();
            record(c,f,b);expect(c.rejects(b)).toBe(value<.3);expect(f.data).toEqual(original);expect(b).toEqual(box());expect(c.rejects({...b})).toBe(false);c.endPage();
        }
    });
    it('只检查原组件矩形；框外的亮点不能把弱组件变成可靠文字',()=>{
        const c=createMangaDetectionCore();c.beginPage();const f=frame(c);f.data[9*f.width+9]=1;const b=record(c,f);expect(c.rejects(b)).toBe(true);expect(c.usage.pixels).toBe(100);
    });
    it('Box坐标变更、克隆、非法对象和过期页不能沿用旧结论',()=>{
        const c=createMangaDetectionCore();c.beginPage();const b=record(c);b.width++;expect(c.rejects(b)).toBe(false);b.width--;expect(c.rejects(b)).toBe(true);
        expect(c.rejects(null as never)).toBe(false);expect(c.rejects('box' as never)).toBe(false);c.endPage();expect(c.rejects(b)).toBe(false);c.beginPage();expect(c.rejects(b)).toBe(false);
    });
    it('原帧的右下填充仅按SDK既有裁边关联，不扩展原Box',()=>{
        const c=createMangaDetectionCore();c.beginPage();const f=frame(c),raw={x0:10,y0:38,x1:20,y1:54},b={x:10,y:38,width:10,height:10};record(c,f,b,raw);expect(c.rejects(b)).toBe(true);
    });
    it('重复组件映射、重复返回框与未知返回框均不能获得唯一身份',()=>{
        for(const mode of ['regions','boxes','same-object','unknown']){
            const c=createMangaDetectionCore();c.beginPage();const f=frame(c),b=box();c.observe(f.ticket,f.input,f.output);c.observeRegion(f.ticket,f.width,f.height,rect,rect);
            if(mode==='regions')c.observeRegion(f.ticket,f.width,f.height,rect,rect);
            const other=mode==='unknown'?{...b,x:25}:mode==='same-object'?b:{...b};c.bindBoxes(f.ticket,mode==='regions'?[b]:mode==='unknown'?[other]:[b,other]);
            expect(c.rejects(mode==='unknown'?other:b)).toBe(false);expect(c.rejects(other)).toBe(false);
        }
    });
    it('原Box被后续无旁证或强响应检测复用时清除旧弱结论',()=>{
        const c=createMangaDetectionCore();c.beginPage();const b=record(c);expect(c.rejects(b)).toBe(true);let f=frame(c);c.bindBoxes(f.ticket,[b]);c.endFrame(f.ticket);expect(c.rejects(b)).toBe(false);
        record(c,frame(c),b);expect(c.rejects(b)).toBe(true);f=frame(c);f.data.fill(.9);record(c,f,b);expect(c.rejects(b)).toBe(false);
    });
    it('跨帧迟到的输出与处理器不能覆写当前帧，迟到收尾也不结束新帧',()=>{
        const c=createMangaDetectionCore();c.beginPage();const old=frame(c);c.endFrame(old.ticket);const f=frame(c);c.observe(old.ticket,old.input,old.output);c.observeRegion(old.ticket,old.width,old.height,rect,rect);c.endFrame(old.ticket);expect(c.ticket).toBe(f.ticket);
        const b=record(c,f);expect(c.rejects(b)).toBe(true);c.bindBoxes(old.ticket,[b]);expect(c.rejects(b)).toBe(false);
    });
    it('同帧重复推理或交错检测撤回不明确旁证',()=>{
        for(const mode of ['duplicate','overlap']){
            const c=createMangaDetectionCore();c.beginPage();const f=frame(c);c.observe(f.ticket,f.input,f.output);
            if(mode==='duplicate')c.observe(f.ticket,f.input,f.output);else expect(c.beginFrame(64,48,1536)).toBeUndefined();
            c.observeRegion(f.ticket,f.width,f.height,rect,rect);const b=box();c.bindBoxes(f.ticket,[b]);expect(c.rejects(b)).toBe(false);c.endPage();
        }
    });
    it('取消与非活动状态不读取tensor，也不保留旧排除记录',()=>{
        const c=createMangaDetectionCore();expect(c.beginFrame(64,48,1536)).toBeUndefined();c.observe(undefined,undefined,undefined);c.observeRegion(undefined,64,64,rect,rect);c.endFrame(undefined);
        const controller=new AbortController();c.beginPage(controller.signal);const f=frame(c),b=record(c,f);controller.abort();expect(c.rejects(b)).toBe(false);expect(c.beginFrame(64,48,1536)).toBeUndefined();c.bindBoxes(undefined,[b]);c.endPage();
    });
});
describe('未知检测形状和有界资源回退',()=>{
    it('未知源尺寸、缩放配置与会变成零宽高的极端比例不附会模型坐标',()=>{
        const c=createMangaDetectionCore();c.beginPage();
        for(const [w,h,limit]of [[undefined,48,1536],[64,undefined,1536],[0,48,1536],[-1,48,1536],[1.5,48,1536],[NaN,48,1536],[8193,48,1536],[8192,2049,1536],[64,48,undefined],[64,48,960],[1,8192,1536],[8192,1,1536]])expect(c.beginFrame(w,h,limit)).toBeUndefined();
        const f=frame(c,2048,1024);expect([f.width,f.height]).toEqual([1536,768]);const b=record(c,f);expect(c.rejects(b)).toBe(true);
    });
    it('输入/输出维度、类型或长度不明时不拒绝候选',()=>{
        for(const mode of ['no-input','no-output','rank','batch','channels','height','width','output-channels','output-size','bytes','length']){
            const c=createMangaDetectionCore();c.beginPage();const f=frame(c);let input:any=f.input,output:any=f.output;
            if(mode==='no-input')input=undefined;if(mode==='no-output')output=undefined;if(mode==='rank')input.dims=[1,3,64];if(mode==='batch')input.dims[0]=2;if(mode==='channels')input.dims[1]=1;if(mode==='height')input.dims[2]=63;if(mode==='width')input.dims[3]=63;if(mode==='output-channels')output.dims[1]=3;if(mode==='output-size')output.dims[3]=32;if(mode==='bytes')output.data=new Uint8Array(4096);if(mode==='length')output.data=new Float32Array(4095);
            c.observe(f.ticket,input,output);c.observeRegion(f.ticket,f.width,f.height,rect,rect);const b=box();c.bindBoxes(f.ticket,[b]);expect(c.rejects(b)).toBe(false);
        }
    });
    it('非法概率保留候选，不把NaN或越界值当背景',()=>{
        for(const value of [NaN,Infinity,-Infinity,-.1,1.1]){const c=createMangaDetectionCore();c.beginPage();const f=frame(c);f.data[19*f.width+19]=value;expect(c.rejects(record(c,f))).toBe(false);}
    });
    it('画布形状变化或借用buffer被转移时撤回整帧候选',()=>{
        for(const mode of ['width','height','buffer']){
            const c=createMangaDetectionCore();c.beginPage();const f=frame(c);c.observe(f.ticket,f.input,f.output);c.observeRegion(f.ticket,f.width,f.height,rect,rect);
            if(mode==='buffer')structuredClone(f.data.buffer,{transfer:[f.data.buffer]});
            c.observeRegion(f.ticket,f.width+(mode==='width'?1:0),f.height+(mode==='height'?1:0),rect,rect);const b=box();c.bindBoxes(f.ticket,[b]);expect(c.rejects(b)).toBe(false);
        }
    });
    it('非法原区域或映回区域不能借裁边获得有效身份',()=>{
        const invalid=[{...rect,x0:-1},{...rect,y0:-1},{...rect,x1:10},{...rect,y1:10},{...rect,x1:Infinity},{...rect,y1:NaN},{...rect,x0:10.5}];
        for(const raw of [...invalid,{...rect,x1:65},{...rect,y1:65}]){const c=createMangaDetectionCore();c.beginPage();const f=frame(c);expect(c.rejects(record(c,f,box(),raw,rect))).toBe(false);}
        for(const mapped of [...invalid,{x0:70,y0:10,x1:80,y1:20}]){const c=createMangaDetectionCore();c.beginPage();const f=frame(c);expect(c.rejects(record(c,f,box(),rect,mapped))).toBe(false);}
    });
    it('未知返回集合与非法返回Box保留原行为',()=>{
        for(const boxes of [undefined,{},Array(limits.boxes+1).fill(box())]){const c=createMangaDetectionCore();c.beginPage();const f=frame(c),b=box();c.observe(f.ticket,f.input,f.output);c.observeRegion(f.ticket,f.width,f.height,rect,rect);c.bindBoxes(f.ticket,boxes as never);expect(c.rejects(b)).toBe(false);}
        const c=createMangaDetectionCore();c.beginPage();const f=frame(c),b=box();c.observe(f.ticket,f.input,f.output);c.observeRegion(f.ticket,f.width,f.height,rect,rect);c.bindBoxes(f.ticket,[null,'box',{...b,width:NaN},b] as never);expect(c.rejects(b)).toBe(true);
    });
    it('逐页预付完整区域面积，超额和过大区域保留；换页才恢复',()=>{
        const c=createMangaDetectionCore();c.beginPage();const raw={x0:0,y0:0,x1:256,y1:256},b={x:0,y:0,width:256,height:256};
        for(let i=0;i<=limits.pixels/65536;i++){record(c,frame(c,256,256),b,raw);expect(c.rejects(b)).toBe(i<limits.pixels/65536);}
        expect(c.usage.pixels).toBe(limits.pixels);c.beginPage();record(c,frame(c,256,256),b,raw);expect(c.rejects(b)).toBe(true);
        c.beginPage();record(c,frame(c,256,257),{...b,height:257},{...raw,y1:257});expect(c.usage.pixels).toBe(0);
    });
    it('组件次数耗尽撤回本帧，重复区域也计数',()=>{
        const c=createMangaDetectionCore();c.beginPage();const f=frame(c),b=box();c.observe(f.ticket,f.input,f.output);c.observeRegion(f.ticket,f.width,f.height,rect,rect);
        for(let i=0;i<limits.regions;i++)c.observeRegion(f.ticket,f.width,f.height,{...rect,x0:30,x1:40},{...rect,x0:30,x1:40});
        c.bindBoxes(f.ticket,[b]);expect(c.rejects(b)).toBe(false);expect(c.usage.regions).toBe(limits.regions+1);
    });
});
it('真实概率片段仅排除高光SA，保留字母数字、细灰字、小标签与日文注音',()=>{
    const bytes=readFileSync(new URL('./fixtures/manga-detection-core-recording.json',import.meta.url));expect(bytes.length).toBeLessThan(250000);expect(createHash('sha256').update(bytes).digest('hex')).toBe('a77172e99be685aeae52f235574568eca09de0861609da0b524f487b131796df');
    const fixture=JSON.parse(bytes.toString());expect(fixture.samples).toHaveLength(13);
    for(const sample of fixture.samples){
        const manifest=readFileSync(new URL(`./fixtures/${sample.manifest}/manifest.json`,import.meta.url));expect(createHash('sha256').update(manifest).digest('hex')).toBe(sample.manifestSha256);expect(JSON.parse(manifest.toString()).fixtures.find((x:any)=>x.name===sample.scene).sha256).toBe(sample.imageSha256);
        const c=createMangaDetectionCore();c.beginPage();const f=frame(c,sample.sourceWidth,sample.sourceHeight);expect([f.width,f.height]).toEqual([sample.frameWidth,sample.frameHeight]);f.data.fill(0);
        const data=gunzipSync(Buffer.from(sample.float32GzipBase64,'base64'),{maxOutputLength:sample.roi.width*sample.roi.height*4});expect(createHash('sha256').update(data).digest('hex')).toBe(sample.valuesSha256);
        let index=0;for(let y=sample.roi.top;y<sample.roi.top+sample.roi.height;y++)for(let x=sample.roi.left;x<sample.roi.left+sample.roi.width;x++){f.data[y*f.width+x]=data.readFloatLE(index*4);index++;}
        const original=structuredClone(sample.raw);const b=record(c,f,sample.raw.box,sample.originalRegion,sample.mappedRegion);expect(c.rejects(b)).toBe(sample.expectedExcluded);expect(sample.raw).toEqual(original);c.endPage();
    }
});

describe('补充核心绑定到当前页原像素视图',()=>{
    const source={pageWidth:512,pageHeight:256,x:20,y:30,width:384,height:128};
    function refinementFrame(c:Core,scope:any=source,columns=1,w=384,h=128){
        const ticket=c.beginFrame(w,h,1536,scope),ratio=Math.min(1,1536/Math.max(w,h)),width=Math.ceil(Math.round(w*ratio)/32)*32,height=Math.ceil(Math.round(h*ratio)/32)*32;
        const data=new Float32Array(width*height);const boxes:Array<{x:number;y:number;width:number;height:number}>=[];
        c.observe(ticket,{dims:[1,3,height,width]},{dims:[1,1,height,width],data});
        for(let column=0;column<columns;column++){
            const offset=column*128,raw={x0:16+offset,y0:16,x1:112+offset,y1:112},mapped={x0:8+offset,y0:8,x1:120+offset,y1:120};
            for(let y=raw.y0;y<raw.y1;y++)for(let x=raw.x0;x<raw.x1;x++)data[y*width+x]=.1;
            for(let y=48;y<60;y++)for(let x=32+offset;x<96+offset;x++)data[y*width+x]=.9;
            c.observeRegion(ticket,width,height,raw,mapped);boxes.push({x:mapped.x0,y:mapped.y0,width:112,height:112});
        }
        return {ticket,width,height,data,boxes};
    }
    it('保留父框和原概率，只有唯一原Box能把紧凑核心映回同一页',()=>{
        const c=createMangaDetectionCore();c.beginPage();const f=refinementFrame(c),before=f.data.slice();c.bindBoxes(f.ticket,f.boxes);c.endFrame(f.ticket);
        expect(c.takeRefinements()).toEqual([{core:{x0:52,y0:78,x1:116,y1:90},crop:{x0:48,y0:74,x1:120,y1:94},area:768,parent:{x0:28,y0:38,x1:140,y1:150},pageWidth:512,pageHeight:256}]);
        expect(c.takeRefinements()).toEqual([]);expect(f.data).toEqual(before);expect(c.rejects(f.boxes[0])).toBe(false);expect(c.refinementUsage).toEqual({pixels:9216,components:1,overflow:false});
    });
    it('原像素视图中的完全弱组件仍按原规则排除，不产生补充识别',()=>{
        const c=createMangaDetectionCore();c.beginPage();const ticket=c.beginFrame(384,128,1536,source),data=new Float32Array(384*128);
        for(let y=16;y<112;y++)for(let x=16;x<112;x++)data[y*384+x]=.1;
        c.observe(ticket,{dims:[1,3,128,384]},{dims:[1,1,128,384],data});c.observeRegion(ticket,384,128,{x0:16,y0:16,x1:112,y1:112},{x0:8,y0:8,x1:120,y1:120});
        const box={x:8,y:8,width:112,height:112};c.bindBoxes(ticket,[box]);c.endFrame(ticket);expect(c.takeRefinements()).toEqual([]);expect(c.rejects(box)).toBe(true);
    });
    it('未知/放大视图和无法对应整页的坐标不生成补充候选',()=>{
        for(const scope of [undefined,{...source,width:128},{...source,height:64},{...source,pageWidth:0},{...source,pageHeight:0},{...source,pageWidth:8193},{...source,pageHeight:8193},{...source,pageWidth:8192,pageHeight:2049},{...source,x:NaN},{...source,x:-1},{...source,y:-1},{...source,x:200},{...source,y:200}]){
            const c=createMangaDetectionCore();c.beginPage();const f=refinementFrame(c,scope===undefined?null:scope);c.bindBoxes(f.ticket,f.boxes);c.endFrame(f.ticket);expect(c.takeRefinements()).toEqual([]);expect(c.refinementUsage.pixels).toBe(0);
        }
        for(const [w,h]of [[1537,128],[128,1537]]){const c=createMangaDetectionCore();c.beginPage();const f=refinementFrame(c,{pageWidth:2000,pageHeight:2000,x:0,y:0,width:w,height:h},1,w,h);c.bindBoxes(f.ticket,f.boxes);c.endFrame(f.ticket);expect(c.takeRefinements()).toEqual([]);}
    });
    it('重复区域、重复Box、Box坐标漂移和非法绑定撤回不明确候选',()=>{
        for(const mode of ['region','boxes','mutation','unknown']){
            const c=createMangaDetectionCore();c.beginPage();const f=refinementFrame(c);
            if(mode==='region')c.observeRegion(f.ticket,f.width,f.height,{x0:16,y0:16,x1:112,y1:112},{x0:8,y0:8,x1:120,y1:120});
            c.bindBoxes(f.ticket,mode==='boxes'?[f.boxes[0],{...f.boxes[0]}]:f.boxes);
            if(mode==='mutation')f.boxes[0].width++;
            if(mode==='unknown')c.bindBoxes(undefined,[]);
            c.endFrame(f.ticket);expect(c.takeRefinements()).toEqual([]);
        }
    });
    it('取消、重复推理、交错帧和换页不泄漏候选',()=>{
        for(const mode of ['abort','duplicate','overlap','end','restart']){
            const controller=new AbortController(),c=createMangaDetectionCore();c.beginPage(controller.signal);const f=refinementFrame(c);
            if(mode==='duplicate')c.observe(f.ticket,{dims:[1,3,f.height,f.width]},{dims:[1,1,f.height,f.width],data:f.data});
            c.bindBoxes(f.ticket,f.boxes);
            if(mode==='abort')controller.abort();if(mode==='overlap')c.beginFrame(384,128,1536,source);if(mode==='end')c.endPage();if(mode==='restart')c.beginPage();
            c.endFrame(f.ticket);expect(c.takeRefinements()).toEqual([]);
        }
    });
    it('原Box跨帧复用时撤回旧视图候选，其他Box保留各自来源',()=>{
        for(const mode of ['unknown-source','new-source','duplicate']){
            const c=createMangaDetectionCore();c.beginPage();
            const old=refinementFrame(c,source,2);c.bindBoxes(old.ticket,old.boxes);c.endFrame(old.ticket);
            const next=refinementFrame(c,mode==='unknown-source'?null:{...source,x:60});
            c.bindBoxes(next.ticket,mode==='duplicate'?[old.boxes[0],{...old.boxes[0]}]:[old.boxes[0]]);c.endFrame(next.ticket);
            const candidates=c.takeRefinements();
            expect(candidates.map(candidate=>candidate.core.x0)).toEqual(mode==='new-source'?[180,92]:[180]);
            expect(candidates.map(candidate=>candidate.parent.x0)).toEqual(mode==='new-source'?[156,68]:[156]);
        }
    });
    it('页内记录超额撤回全部补充候选，换页才恢复额度',()=>{
        const c=createMangaDetectionCore();c.beginPage();
        for(let i=0;i<127;i++){const f=refinementFrame(c);c.bindBoxes(f.ticket,f.boxes);c.endFrame(f.ticket);}
        const f=refinementFrame(c,source,3);c.bindBoxes(f.ticket,f.boxes);c.endFrame(f.ticket);expect(c.refinementUsage.overflow).toBe(true);expect(c.takeRefinements()).toEqual([]);
        const used=c.refinementUsage.pixels;const skipped=refinementFrame(c);c.bindBoxes(skipped.ticket,skipped.boxes);c.endFrame(skipped.ticket);expect(c.refinementUsage.pixels).toBe(used);
        c.beginPage();const fresh=refinementFrame(c);c.bindBoxes(fresh.ticket,fresh.boxes);c.endFrame(fresh.ticket);expect(c.takeRefinements()).toHaveLength(1);expect(c.refinementUsage.overflow).toBe(false);
    });
});
