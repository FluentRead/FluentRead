/**
 * @file tests/imageMattePageOwnership.test.ts
 * 使用真实局部证明与真实owned位图消费者复现不同背景争用墨迹的顺序依赖。
 * coarse检测网格是明确的受控模型端口，故意覆盖灰牌；不是native或作者分割真值。
 */
import {describe,expect,it} from 'vitest';
import type {ImageTextRegion} from '@/src/features/image-translation/paragraphs';
import {createImageDetectionEvidenceBudget,bindImageDetectionEvidence,getImageDetectionEvidence} from '@/src/features/image-translation/services/imageDetectionEvidence';
import {observeImageMattePalette,planImageMatteCandidate,planImageMatteRepair,type ImageMatteRepair} from '@/src/features/image-translation/services/imageMatteRepair';
import {keepImageMatteDecoration,observeImageMatteDecoration} from '@/src/features/image-translation/services/imageMatteDecoration';
import {coversClippedImageGlyphs} from '@/src/features/image-translation/services/imageClippedGlyphs';
import {applyImageMattePage,authorizeImageMatteProposal,authorizeImageMatteWithinExistingMasks,getImageMatteProposalDrawings,planImageMattePage,proposeImageMattePage} from '@/src/features/image-translation/services/imageMattePage';

describe('细衬线的半覆盖字形复核',()=>{
    const width=64,height=56,ink=[25,25,25,255],background=[225,225,225,255];
    function fixture(flipped=false,alpha=255){
        const pixels=new Uint8ClampedArray(width*height*4);
        const yAt=(y:number)=>flipped?height-y-1:y;
        for(let i=0;i<pixels.length;i+=4)pixels.set([225,225,225,alpha],i);
        const put=(x:number,y:number,rgba=ink)=>pixels.set([rgba[0],rgba[1],rgba[2],alpha],(yAt(y)*width+x)*4);
        for(const x0 of [13,23,33,43])for(let x=x0;x<x0+3;x++)for(let y=17;y<33;y++)put(x,y);
        for(let x=16;x<19;x++)put(x,24,[95,95,95,255]);
        put(19,24,[175,175,175,255]);
        const box={x0:10,y0:flipped?height-32:21,x1:53,y1:flipped?height-21:32};
        const budget=()=>({remaining:1_048_576});
        const repair=()=>planImageMatteCandidate(pixels,width,height,box,budget(),'recognition')!;
        const inside=(x:number,y:number)=>x>=box.x0&&x<box.x1&&y>=box.y0&&y<box.y1;
        return {pixels,put,box,budget,repair,inside};
    }
    it.each([false,true])('主要裁切边可在任一方向，原文字形和同帧支持共同决定写入（反向 %s）',flipped=>{
        const {pixels,box,budget,repair,inside}=fixture(flipped),before=pixels.slice();
        expect(planImageMatteCandidate(pixels,width,height,box,budget())).toBeUndefined();
        expect(planImageMatteCandidate(pixels,width,height,box,budget(),'decoration')).toBeUndefined();
        expect(planImageMatteRepair(pixels,width,height,box,()=>true,budget())).toBeUndefined();
        const candidate=repair();
        expect(candidate.fringeCore).toBeDefined();
        expect(candidate.inkCore).toBeUndefined();
        expect(candidate.fringeCore!.filter(value=>value===2)).toHaveLength(192);
        expect(candidate.fringeCore!.filter(value=>value===1)).toHaveLength(3);
        expect(candidate.mask.filter(Boolean)).toHaveLength(196);
        const line:ImageTextRegion={text:'开放',bbox:box},get=()=>proposeImageMattePage(pixels,width,height,[line],[],()=>box,undefined,true)!;
        const proposal=get(),support={forBox:()=>inside};
        expect(getImageMatteProposalDrawings(proposal)?.requiresGlyphProof).toBe(true);
        expect(authorizeImageMatteWithinExistingMasks(proposal)).toBeUndefined();
        expect(authorizeImageMatteProposal(proposal,{forBox:()=>()=>true})).toBeUndefined();
        expect(authorizeImageMatteProposal(proposal,support,new Map([[line,'OPENX']]))).toBeUndefined();
        expect(authorizeImageMatteProposal(proposal,{forBox:()=>undefined},new Map([[line,'OPEN']]))).toBeUndefined();
        expect(pixels).toEqual(before);
        const plan=authorizeImageMatteProposal(proposal,support,new Map([[line,'OPEN']]))!;
        applyImageMattePage(pixels,width,height,plan);
        const expected=new Uint8ClampedArray(pixels.length);
        for(let i=0;i<expected.length;i+=4)expected.set(background,i);
        expect(pixels).toEqual(expected);
    });
    it('排除窄框比例不足、双方裁切、无明显裁切、半透明以及超薄边距离的形状',()=>{
        const {pixels,put,repair,box,budget}=fixture();
        for(const change of [{y0:24},{y1:31},{y0:18,y1:33}]){
            expect(planImageMatteCandidate(pixels,width,height,{...box,...change},budget(),'recognition')).toBeUndefined();
        }
        const translucent=fixture(false,224);
        expect(translucent.repair()).toBeUndefined();
        expect(planImageMatteCandidate(pixels,width,height,box,{remaining:196},'recognition')).toBeUndefined();
        for(let x=16;x<22;x++)put(x,30,[154,154,154,255]);
        expect(repair()).toBeUndefined();
    });
    it('灰条、支持空洞或与单侧裁切不同的字形几何不能借反走样提案擦除',()=>{
        const {repair,inside,box}=fixture(),r=repair(),{left,top,width,fringeCore}=r;
        const check=(change:Partial<ImageMatteRepair>={})=>coversClippedImageGlyphs({...r,...change},'OPEN',inside);
        expect(check()).toBe(true);
        expect(check({sourceBox:{...box,y0:18,y1:33}})).toBe(false);
        expect(check({sourceBox:{...box,y1:31}})).toBe(false);
        expect(coversClippedImageGlyphs(r,'OPEN',(x,y)=>inside(x,y)&&(x!==24||y!==26))).toBe(false);
        const gray=fringeCore!.slice();
        for(let y=17;y<33;y++)for(let x=23;x<26;x++)gray[(y-top)*width+x-left]=1;
        expect(check({fringeCore:gray})).toBe(false);
    });
});

describe('单行旧擦除框内的脱离边饰',()=>{
    const width=90,height=60,background=[240,234,225,255],ink=[31,44,78,255],box={x0:14,y0:15,x1:74,y1:39};
    function fixture(side:'left'|'right'='right'){
        const pixels=new Uint8ClampedArray(width*height*4);
        for(let i=0;i<pixels.length;i+=4)pixels.set(background,i);
        const put=(x:number,y:number,value=ink)=>pixels.set(value,(y*width+x)*4);
        for(const column of [25,36,47,58])for(let y=20;y<35;y++)for(let x=column;x<column+5;x++)put(x,y);
        const x0=side==='left'?18:66;
        const art={x0,y0:18,x1:x0+3,y1:24};
        for(let y=art.y0;y<art.y1;y++)for(let x=art.x0;x<art.x1;x++)put(x,y);
        const palette=()=>observeImageMattePalette(pixels,width,height,box,{remaining:40_000})!;
        const observe=(text='OPEN')=>{
            const seen=palette();
            return observeImageMatteDecoration(pixels,width,text,{background:seen.background,inkBoxes:[seen.supportBox]});
        };
        const repair=()=>planImageMatteCandidate(pixels,width,height,box,{remaining:40_000},'decoration')!;
        return {pixels,put,art,observe,repair};
    }
    it.each(['left','right'] as const)('把 %s 端原图案移出待擦蒙版并完整保留 RGBA',side=>{
        const {pixels,art,observe}=fixture(side),hint=observe()!,before=pixels.slice();
        expect(hint.side).toBe(side);
        const line:ImageTextRegion={text:'开放',bbox:box};
        const draw=side==='left'?{...box,x0:hint.gap+1}:{...box,x1:hint.gap};
        const proposal=proposeImageMattePage(pixels,width,height,[line],[],()=>draw,hint)!;
        expect(getImageMatteProposalDrawings(proposal)!.rectangles).toEqual([art]);
        expect(pixels).toEqual(before);
        const plan=authorizeImageMatteWithinExistingMasks(proposal)!;
        expect(plan.uploads).toEqual([{x0:12,y0:13,x1:76,y1:41}]);
        applyImageMattePage(pixels,width,height,plan);
        const expected=before.slice();
        for(const column of [25,36,47,58])for(let y=20;y<35;y++)for(let x=column;x<column+5;x++){
            expected.set(background,(y*width+x)*4);
        }
        expect(pixels).toEqual(expected);
    });
    it('只接纳纯色单行标签，排除真实连接、低位标点和有歧义的双边小图案',()=>{
        const {pixels,observe,put}=fixture();
        expect(observe('Open')).toBeUndefined();
        expect(observe('AB')).toBeUndefined();
        expect(observe('A'.repeat(49))).toBeUndefined();
        expect(observeImageMatteDecoration(pixels,width,'OPEN',undefined)).toBeUndefined();
        expect(observeImageMatteDecoration(pixels,width,'OPEN',{background:[240,234,225,127],inkBoxes:[box]})).toBeUndefined();
        expect(observeImageMatteDecoration(pixels,width,'OPEN',{background:[240,234,225,255]})).toBeUndefined();
        for(let y=18;y<24;y++)for(let x=18;x<21;x++)put(x,y);
        expect(observe()).toBeUndefined();
        for(let y=18;y<24;y++)for(let x=18;x<21;x++)put(x,y,background);
        for(let y=18;y<24;y++)for(let x=66;x<69;x++)put(x,y,background);
        for(let x=66;x<69;x++)put(x,34);
        expect(observe()).toBeUndefined();
        put(63,34);put(64,34);put(65,34);
        expect(observe()).toBeUndefined();
    });
    it('闭环墨迹与空列、字数或原擦除范围不一致时不变更提案',()=>{
        const {observe,repair,pixels}=fixture(),hint=observe()!,before=pixels.slice();
        const margin={x0:0,y0:0,x1:width,y1:height};
        const noCore=repair();delete noCore.inkCore;
        expect(keepImageMatteDecoration(noCore,hint,margin)).toBe(false);
        expect(keepImageMatteDecoration(repair(),{...hint,gap:67},margin)).toBe(false);
        expect(keepImageMatteDecoration(repair(),{...hint,characters:3},margin)).toBe(false);
        expect(keepImageMatteDecoration(repair(),{...hint,characters:5},margin)).toBe(false);
        expect(keepImageMatteDecoration(repair(),hint,{...margin,x1:64})).toBe(false);
        expect(keepImageMatteDecoration(repair(),hint,{...margin,x0:28})).toBe(false);
        const line:ImageTextRegion={text:'开放',bbox:box};
        expect(proposeImageMattePage(pixels,width,height,[line,line],[],()=>box,hint)).toBeUndefined();
        expect(proposeImageMattePage(pixels,width,height,[{...line,vertical:true}],[],()=>box,hint)).toBeUndefined();
        expect(proposeImageMattePage(pixels,width,height,[line],[],()=>box,{...hint,characters:5})).toBeUndefined();
        expect(pixels).toEqual(before);
    });
    it('覆盖率不足的正文边缘仍是墨迹，两处独立边饰拒绝整项授权',()=>{
        const {put,observe,repair}=fixture(),legacy={x0:0,y0:0,x1:width,y1:height};
        put(30,27,[136,139,152,255]);
        const plan=repair(),index=(27-plan.top)*plan.width+30-plan.left;
        expect(plan.mask[index]).toBe(1);
        expect(plan.inkCore?.[index]).toBe(0);
        expect(keepImageMatteDecoration(plan,observe()!,legacy)).toBe(true);
        for(let x=66;x<69;x++)put(x,20,background);
        expect(keepImageMatteDecoration(repair(),observe()!,legacy)).toBe(false);
    });
});

describe('被识别成句点的独立空心边饰',()=>{
    const width=128,height=68,background=[245,245,245,255],ink=[25,25,25,255];
    const box={x0:16,y0:21,x1:104,y1:49},legacy={x0:13,y0:18,x1:107,y1:52};
    const mark={x0:89,y0:31,x1:98,y1:40};

    function fixture(markType:'ring'|'diamond'|'solid'|'open'|'small'|'pin-hole'='ring'){
        const pixels=new Uint8ClampedArray(width*height*4);
        const put=(x:number,y:number,color=ink)=>pixels.set(color,(y*width+x)*4);
        for(let i=0;i<pixels.length;i+=4)pixels.set(background,i);
        for(const start of [23,39,55,75])for(let y=15;y<44;y++)for(let x=start;x<start+6;x++)put(x,y);
        const right=markType==='small'?mark.x0+3:mark.x1;
        for(let y=mark.y0;y<mark.y1;y++)for(let x=mark.x0;x<right;x++){
            if(markType==='diamond'){
                const distance=Math.abs(x-93)+Math.abs(y-35);
                if(distance>=3&&distance<=4)put(x,y);
            }else if(markType==='solid'||markType==='pin-hole'||y<mark.y0+2||y>=mark.y1-2||x<mark.x0+2||x>=right-2)put(x,y);
        }
        if(markType==='open'){put(93,31,background);put(93,32,background);}
        if(markType==='pin-hole')put(93,35,background);
        const observe=(label='OPEN .')=>{
            const palette=observeImageMattePalette(pixels,width,height,box,{remaining:40_000})!;
            return observeImageMatteDecoration(pixels,width,label,{background:palette.background,inkBoxes:[palette.supportBox]});
        };
        const repair=()=>planImageMatteCandidate(pixels,width,height,box,{remaining:40_000},'recognition')!;
        return {pixels,put,observe,repair};
    }

    it.each([['ring',false],['ring',true],['diamond',false]] as const)('保留 %s 边饰和原框外笔画，细边缘 %s 不改变旧框权限',(markType,fine)=>{
        const {pixels,put,observe,repair}=fixture(markType);
        if(fine){
            for(let x=29;x<32;x++)put(x,29,[100,100,100,255]);
            put(32,29,[185,185,185,255]);
        }
        expect(Boolean(repair().fringeCore)).toBe(fine);
        const hint=observe()!;
        expect(hint).toEqual({side:'right',gap:88,characters:4,enclosed:true});
        const line:ImageTextRegion={text:'开放。',bbox:box};
        const before=pixels.slice();
        const requested={x0:box.x0-5,y0:box.y0-7,x1:hint.gap,y1:box.y1+6};
        const proposal=proposeImageMattePage(pixels,width,height,[line],[],()=>requested,hint)!;
        expect(getImageMatteProposalDrawings(proposal)?.requiresGlyphProof).toBeUndefined();
        expect(getImageMatteProposalDrawings(proposal)?.drawings[0].bounds).toEqual({...legacy,x1:hint.gap});
        expect(pixels).toEqual(before);
        const plan=authorizeImageMatteWithinExistingMasks(proposal)!;
        expect(plan.uploads).toEqual([legacy]);
        applyImageMattePage(pixels,width,height,plan);
        const expected=before.slice();
        for(let y=legacy.y0;y<44;y++)for(let x=legacy.x0;x<hint.gap;x++)expected.set(background,(y*width+x)*4);
        expect(pixels).toEqual(expected);
    });

    it.each(['solid','open','small','pin-hole'] as const)('空白无法形成有面积的闭孔时保留 %s 拒绝路径',markType=>{
        const {observe,repair}=fixture(markType);
        expect(observe('OPEN.')).toBeUndefined();
        const draft=repair(),mask=draft.mask.slice();
        expect(keepImageMatteDecoration(draft,observe()!,legacy)).toBe(false);
        expect(draft.mask).toEqual(mask);
    });

    it('边饰靠近正文、横向位置错误或旧清字范围内没有正文时不发布权限',()=>{
        const {pixels,observe,repair,put}=fixture();
        const hint=observe()!;
        expect(keepImageMatteDecoration(repair(),{...hint,side:'left'},legacy)).toBe(false);
        expect(keepImageMatteDecoration(repair(),hint,{...legacy,x0:hint.gap})).toBe(false);
        const line:ImageTextRegion={text:'开放。',bbox:box};
        expect(proposeImageMattePage(pixels,width,height,[line],[],()=>({...box,y0:3,y1:10}),hint)).toBeUndefined();
        put(87,35);
        expect(keepImageMatteDecoration(repair(),observe()!,legacy)).toBe(false);
        const invalid={...box,x1:box.x0};
        expect(proposeImageMattePage(pixels,width,height,[{text:'开放。',bbox:invalid}],[],()=>box,hint)).toBeUndefined();
    });
});

describe('整页RGBA修补的重叠墨迹归属',()=>{
    it('原宽灰牌被薄AA准入提前拒绝，旧像素及正反序整页拒绝继续保留',()=>{
        const width=64,height=48,pixels=new Uint8ClampedArray(width*height*4);
        const fill=(box:{x0:number;y0:number;x1:number;y1:number},rgba:number[])=>{
            for(let y=box.y0;y<box.y1;y++)for(let x=box.x0;x<box.x1;x++)pixels.set(rgba,(y*width+x)*4);
        };
        fill({x0:0,y0:0,x1:width,y1:height},[255,255,255,255]);
        const card={x0:10,y0:20,x1:50,y1:28};fill(card,[128,128,128,255]);
        fill({x0:25,y0:21,x1:26,y1:27},[0,0,0,255]);fill({x0:0,y0:16,x1:6,y1:17},[0,128,255,96]);
        const a:ImageTextRegion={text:'A',bbox:{x0:8,y0:19,x1:52,y1:21},fontSize:2};
        const b:ImageTextRegion={text:'B',bbox:{x0:25,y0:25,x1:29,y1:27},fontSize:2};
        const regions=[a,b],probabilities=new Float32Array(64*64);
        // 手写coarse检测域；不从运行时清字mask或expected背景层派生。
        for(let y=20;y<28;y++)for(let x=10;x<50;x++)probabilities[y*64+x]=.9;
        const owner=createImageDetectionEvidenceBudget();owner.capture(probabilities,64,64,{pageWidth:width,pageHeight:height,x:0,y:0,width,height,resizeRatio:1});
        bindImageDetectionEvidence(regions,'same-frame',width,height,owner.frames());
        const evidence=getImageDetectionEvidence(regions,'same-frame',width,height)!;
        const observations=[{left:0,top:11,width:60,height:18},{left:17,top:17,width:20,height:18}];
        const local=regions.map((line,index)=>planImageMatteRepair(pixels,width,height,line.bbox,evidence.forBox(line.bbox,observations[index])!,{remaining:4_194_304}));
        // 原40px宽灰牌无法作黑字两像素薄边，故不再声称这两个局部都合法。
        expect(local[0]).toBeUndefined();expect(local[1]!.background).toEqual([128,128,128,255]);
        expect(local[1]!.mask[(23-local[1]!.top)*local[1]!.width+25-local[1]!.left]).toBe(1);
        const draw=(line:ImageTextRegion)=>({x0:Math.max(0,line.bbox.x0-2),y0:Math.max(0,line.bbox.y0-2),x1:Math.min(width,line.bbox.x1+2),y1:Math.min(height,line.bbox.y1+2)});
        expect(draw(a).y1).toBe(draw(b).y0);
        const before=new Uint8ClampedArray(pixels);
        for(const order of [[a,b],[b,a]]){
            expect(planImageMattePage(pixels,width,height,order,[],draw,evidence)).toBeUndefined();
            expect(proposeImageMattePage(pixels,width,height,order,[],draw)).toBeUndefined();
        }
        expect(pixels).toEqual(before);
    });
    it('独立薄AA输入的两个局部均合法且共享真实墨像素，非相交draw的正反序整页仍拒绝',()=>{
        const width=64,height=48,pixels=new Uint8ClampedArray(width*height*4);
        const fill=(box:{x0:number;y0:number;x1:number;y1:number},rgba:number[])=>{
            for(let y=box.y0;y<box.y1;y++)for(let x=box.x0;x<box.x1;x++)pixels.set(rgba,(y*width+x)*4);
        };
        fill({x0:0,y0:0,x1:width,y1:height},[255,255,255,255]);
        // 五像素宽的半coverage裙边围绕单像素黑core，所有灰点距core至多2。
        fill({x0:23,y0:20,x1:28,y1:28},[128,128,128,255]);
        fill({x0:25,y0:21,x1:26,y1:27},[0,0,0,255]);
        fill({x0:0,y0:16,x1:6,y1:17},[0,128,255,96]);
        const a:ImageTextRegion={text:'A',bbox:{x0:21,y0:19,x1:30,y1:21},fontSize:2};
        const b:ImageTextRegion={text:'B',bbox:{x0:24,y0:25,x1:26,y1:27},fontSize:2};
        const regions=[a,b],probabilities=new Float32Array(64*64);
        // 明确手写模型端口，不从清字mask或expected背景反造支持。
        for(let y=20;y<28;y++)for(let x=23;x<28;x++)probabilities[y*64+x]=.9;
        const owner=createImageDetectionEvidenceBudget();owner.capture(probabilities,64,64,{pageWidth:width,pageHeight:height,x:0,y:0,width,height,resizeRatio:1});
        bindImageDetectionEvidence(regions,'thin-aa-same-frame',width,height,owner.frames());
        const evidence=getImageDetectionEvidence(regions,'thin-aa-same-frame',width,height)!;
        const observations=[{left:13,top:11,width:25,height:18},{left:16,top:17,width:18,height:18}];
        const local=regions.map((line,index)=>planImageMatteRepair(pixels,width,height,line.bbox,evidence.forBox(line.bbox,observations[index])!,{remaining:4_194_304})!);
        expect(local.map(p=>p.background)).toEqual([[255,255,255,255],[128,128,128,255]]);
        expect(local.map(p=>p.mask.reduce((sum,value)=>sum+value,0))).toEqual([40,6]);
        expect(local.map(p=>p.mask[(23-p.top)*p.width+25-p.left])).toEqual([1,1]);
        let shared=0;
        for(let y=21;y<27;y++)if(local.every(p=>p.mask[(y-p.top)*p.width+25-p.left]===1))shared++;
        expect(shared).toBe(6);
        const draw=(line:ImageTextRegion)=>({x0:line.bbox.x0-2,y0:line.bbox.y0-2,x1:line.bbox.x1+2,y1:line.bbox.y1+2});
        expect(draw(a).y1).toBe(draw(b).y0);
        const before=new Uint8ClampedArray(pixels);
        for(const line of regions)expect(planImageMattePage(pixels,width,height,[line],[],draw,evidence)).toBeDefined();
        for(const order of [[a,b],[b,a]]){
            expect(planImageMattePage(pixels,width,height,order,[],draw,evidence)).toBeUndefined();
            expect(proposeImageMattePage(pixels,width,height,order,[],draw)).toBeUndefined();
        }
        expect(pixels).toEqual(before);
    });
    it('真实局部候选只借读原图，DB漏字失败后同帧独占检测位图可授权完整精确墨迹而保留外部art',()=>{
        const width=64,height=48,pixels=new Uint8ClampedArray(width*height*4),matte=[245,240,220,224],ink=[18,28,34,255];
        for(let i=0;i<pixels.length;i+=4)pixels.set(matte,i);
        for(let y=20;y<27;y++)for(let x=20;x<23;x++)pixels.set(ink,(y*width+x)*4);
        pixels.set(ink,(26*width+27)*4);
        // 独立外部图案从观察域的左上边缘连入，与原框和源墨保持完整静区。
        for(let y=8;y<13;y++)for(let x=8;x<13;x++)pixels.set([55,133,201,96],(y*width+x)*4);
        const line:ImageTextRegion={text:'COMPLETE TRANSLATION',bbox:{x0:16,y0:16,x1:32,y1:32},fontSize:16},regions=[line];
        const before=pixels.slice(),proposal=proposeImageMattePage(pixels,width,height,regions,[],line=>({...line.bbox}))!;
        expect(proposal).toBeDefined();const view=getImageMatteProposalDrawings(proposal)!;
        expect(view.drawings[0].background).toEqual(matte);expect(view.rectangles).toEqual([{x0:8,y0:8,x1:13,y1:13}]);
        const makeEvidence=(lastGlyph:boolean)=>{
            const probabilities=new Float32Array(64*64),owner=createImageDetectionEvidenceBudget();
            // 手写模型端口域；不读取提案mask，也不从候选点反造支持。
            for(let y=20;y<27;y++)for(let x=20;x<23;x++)probabilities[y*64+x]=.9;
            if(lastGlyph)probabilities[26*64+27]=.9;
            owner.capture(probabilities,64,64,{pageWidth:width,pageHeight:height,x:0,y:0,width,height,resizeRatio:1});
            const ownerRegions:object[]=[],image=`literal-frame:${lastGlyph}`;
            bindImageDetectionEvidence(ownerRegions,image,width,height,owner.frames());return getImageDetectionEvidence(ownerRegions,image,width,height)!;
        };
        expect(authorizeImageMatteProposal(proposal,makeEvidence(false))).toBeUndefined();expect(pixels).toEqual(before);
        expect(getImageMatteProposalDrawings(proposal)).toBe(view);
        const plan=authorizeImageMatteProposal(proposal,makeEvidence(true))!;expect(plan).toBeDefined();expect(pixels).toEqual(before);
        expect(plan.uploads).toEqual([{x0:20,y0:20,x1:23,y1:27},{x0:27,y0:26,x1:28,y1:27}]);
        applyImageMattePage(pixels,width,height,plan);
        for(let y=0;y<height;y++)for(let x=0;x<width;x++){
            const offset=(y*width+x)*4,changed=(x>=20&&x<23&&y>=20&&y<27)||(x===27&&y===26);
            expect(Array.from(pixels.subarray(offset,offset+4))).toEqual(changed?matte:Array.from(before.subarray(offset,offset+4)));
        }
    });
});

describe('同帧检测支持的整行字形裁切',()=>{
    function fourCaps(){
        const left=8,top=8,width=52,height=28,mask=new Uint8Array(width*height);
        const columns=[5,15,26,37];
        for(const x0 of columns)for(let y=7;y<19;y++)mask.fill(1,y*width+x0,y*width+x0+6);
        const repair:ImageMatteRepair={left,top,width,height,mask,artMask:new Uint8Array(mask.length),
            background:[245,238,230,255],sourceBox:{x0:14,y0:18,x1:50,y1:29},
            supportBox:{x0:13,y0:15,x1:51,y1:27}};
        return {repair,columns};
    }
    const above=(_x:number,y:number)=>y>18;

    it('四个各自过半被检测支持的连通字形可确认同一上缘裁切和两端窄缺口',()=>{
        const {repair}=fourCaps(),before=repair.mask.slice();
        expect(coversClippedImageGlyphs(repair,'A BCD',(x,y)=>above(x,y)&&x!==13&&x!==50)).toBe(true);
        expect(repair.mask).toEqual(before);
    });
    it('同证据支持反向的共同下缘裁切',()=>{
        const {repair}=fourCaps();repair.sourceBox.y0=13;repair.sourceBox.y1=24;
        expect(coversClippedImageGlyphs(repair,'OPEN',(_x,y)=>y<23)).toBe(true);
    });
    it('横向投影重叠的字形仍须逐个连通并拥有各自的过半支持',()=>{
        const {repair}=fourCaps(),{mask,width}=repair;
        mask.fill(1,7*width+11,7*width+14);
        mask.fill(1,18*width+13,18*width+15);
        expect(coversClippedImageGlyphs(repair,'OPEN',above)).toBe(true);
        mask[7*width+14]=1; // 同投影的合法字距变成真实连接。
        expect(coversClippedImageGlyphs(repair,'OPEN',above)).toBe(false);
    });
    it('两端的额外一像素检测缺口只归给实际被框裁边的字形',()=>{
        const {repair}=fourCaps(),{width,mask}=repair;
        const support=(x:number,y:number)=>above(x,y)&&x!==18&&x!==45;
        expect(coversClippedImageGlyphs(repair,'OPEN',support)).toBe(true);
        for(let y=7;y<19;y++)mask[y*width+5]=0;
        expect(coversClippedImageGlyphs(repair,'OPEN',support)).toBe(false);
        for(let y=7;y<19;y++){mask[y*width+5]=1;mask[y*width+42]=0;}
        expect(coversClippedImageGlyphs(repair,'OPEN',support)).toBe(false);
    });
    function dualCaps(){
        const input=fourCaps().repair,width=72,height=48,ink=[23,28,54,255],pixels=new Uint8ClampedArray(width*height*4);
        const box={...input.sourceBox,y0:17,y1:26};
        for(let i=0;i<pixels.length;i+=4)pixels.set(input.background,i);
        const setColor=(x:number,y:number,color:readonly number[])=>pixels.set(color,(y*width+x)*4);
        for(let i=0;i<input.mask.length;i++){
            if(input.mask[i])setColor(input.left+i%input.width,input.top+Math.floor(i/input.width),ink);
        }
        for(let x=19;x<23;x++)setColor(x,21,[190,186,186,255]);
        setColor(6,21,[14,54,28,255]);
        const repair=planImageMatteCandidate(pixels,width,height,box,{remaining:65_536})!;
        return {pixels,width,height,repair,box};
    }
    const central=(_x:number,y:number)=>y>=18&&y<26;

    it('双侧裁过的抗锯齿相接轮廓按九成墨色分字，整页只移除原墨色',()=>{
        const {pixels,width,height,repair,box}=dualCaps(),before=pixels.slice();
        const bridge=(21-repair.top)*repair.width+20-repair.left;
        expect(repair.mask[bridge]).toBe(1);
        expect(repair.inkCore?.[bridge]).toBe(0);
        expect(coversClippedImageGlyphs(repair,'OPEN',central)).toBe(true);
        const line:ImageTextRegion={text:'开放',bbox:box,fontSize:12};
        const proposal=proposeImageMattePage(pixels,width,height,[line],[],l=>l.bbox)!;
        const plan=authorizeImageMatteProposal(proposal,{forBox:()=>central},new Map([[line,'OPEN']]))!;
        expect(plan).toBeDefined();
        expect(pixels).toEqual(before);
        applyImageMattePage(pixels,width,height,plan);
        expect(pixels.slice((21*width+20)*4,(21*width+21)*4)).toEqual(Uint8ClampedArray.from(repair.background));
        expect(pixels.slice((21*width+6)*4,(21*width+7)*4)).toEqual(before.slice((21*width+6)*4,(21*width+7)*4));
    });
    it('中央的薄墨也须有检测支持，同色粗连接不可算作两个字',()=>{
        const {repair}=dualCaps();
        expect(coversClippedImageGlyphs(repair,'OPEN',(x,y)=>central(x,y)&&(x!==20||y!==21))).toBe(false);
        const row=(21-repair.top)*repair.width;
        repair.inkCore!.fill(1,row+19-repair.left,row+23-repair.left);
        expect(coversClippedImageGlyphs(repair,'OPEN',central)).toBe(false);
    });
    it('双侧裁切须有足够原框、中段及每个字两端的独立证据',()=>{
        const {repair,box}=dualCaps();
        expect(coversClippedImageGlyphs(repair,'OPEN',(x,y)=>central(x,y)&&y!==25)).toBe(false);
        expect(coversClippedImageGlyphs({...repair,sourceBox:{...box,x0:17}},'OPEN',central)).toBe(false);
        expect(coversClippedImageGlyphs({...repair,sourceBox:{...box,y1:25}},'OPEN',()=>true)).toBe(false);
        expect(coversClippedImageGlyphs({...repair,sourceBox:{...box,y0:18}},'OPEN',central)).toBe(false);
        expect(coversClippedImageGlyphs({...repair,sourceBox:{...box,y0:16,y1:25}},'OPEN',()=>true)).toBe(true);
        const core=repair.inkCore!.slice();
        const topRow=(15-repair.top)*repair.width;
        core.fill(0,topRow+23-repair.left,topRow+29-repair.left);
        expect(coversClippedImageGlyphs({...repair,sourceBox:{...box,y0:16,y1:25},inkCore:core},'OPEN',()=>true)).toBe(false);
        core.set(repair.inkCore!);
        const bottomRow=(26-repair.top)*repair.width;
        core.fill(0,bottomRow+23-repair.left,bottomRow+29-repair.left);
        expect(coversClippedImageGlyphs({...repair,inkCore:core},'OPEN',central)).toBe(false);
    });
    it('双侧判断按完整墨迹与强核心两次观察收费',()=>{
        const {repair}=dualCaps(),remaining={remaining:repair.mask.length*2-1};
        expect(coversClippedImageGlyphs(repair,'OPEN',()=>{throw new Error('unexpected support query');},remaining)).toBe(false);
        expect(remaining.remaining).toBe(-1);
    });
    it('短窄行被两端容差耗尽或根本没有横向裁切时不借用空的中央区域',()=>{
        const {repair,box}=dualCaps();
        const tiny={...repair,sourceBox:{...box,x0:25,x1:33},supportBox:{...repair.supportBox,x0:20,x1:37}};
        expect(coversClippedImageGlyphs(tiny,'OPEN',()=>{throw new Error('unexpected support query');})).toBe(false);
        const wider={...repair,sourceBox:{...box,x0:12,x1:52}};
        expect(coversClippedImageGlyphs(wider,'OPEN',central)).toBe(true);
        expect(coversClippedImageGlyphs(wider,'OPEN',(x,y)=>central(x,y)&&(x!==13||y!==20))).toBe(false);
    });
    it.each(['Abcd','AB','A'.repeat(49),'ABCDE','ABC!'])('原文或连通对应不足时没有额外授权 %s',source=>{
        expect(coversClippedImageGlyphs(fourCaps().repair,source,above)).toBe(false);
    });
    it('透明底不参与字形外补',()=>{
        const {repair}=fourCaps();repair.background=[245,238,230,128];
        expect(coversClippedImageGlyphs(repair,'OPEN',above)).toBe(false);
    });
    it.each([
        ['未裁切',{y0:14},{}],['双侧',{y1:25},{}],['超上限',{y0:22},{}],
        ['过矮',{y0:16},{y1:21}],['左侧越界',{x0:17},{}],['右侧越界',{x1:47},{}],
    ] as const)('%s的观察范围不授权',(_name,source,ink)=>{
        const {repair}=fourCaps();Object.assign(repair.sourceBox,source);Object.assign(repair.supportBox,ink);
        expect(coversClippedImageGlyphs(repair,'OPEN',above)).toBe(false);
    });
    it('行内墨迹断失不能由其他像素的检测支持代替',()=>{
        const {repair}=fourCaps();
        expect(coversClippedImageGlyphs(repair,'OPEN',(x,y)=>above(x,y)&&(x!==24||y!==21))).toBe(false);
        expect(coversClippedImageGlyphs(repair,'OPEN',(x,y)=>above(x,y)&&x>17)).toBe(false);
    });
    it('只有一个字形缺边或只有横向细缺口不是一致裁切',()=>{
        const {repair}=fourCaps();
        expect(coversClippedImageGlyphs(repair,'OPEN',(x,y)=>x>=18||above(x,y))).toBe(false);
        expect(coversClippedImageGlyphs(repair,'OPEN',(x)=>x!==13)).toBe(false);
    });
    it('超出源字符数的额外独立墨迹和多字相连的同色装饰都不能授权',()=>{
        const {repair}=fourCaps(),{width,mask}=repair;
        for(let y=7;y<19;y++)mask.fill(1,y*width+45,y*width+47);
        expect(coversClippedImageGlyphs(repair,'OPEN',above)).toBe(false);
        mask.fill(1,7*width+5,7*width+42);
        expect(coversClippedImageGlyphs(repair,'OPEN',above)).toBe(false);
    });
    it.each(['detached','offset-top','offset-bottom'] as const)('保持不符合共同连通轮廓的物体 %s',shape=>{
        const {repair,columns}=fourCaps(),{width,mask}=repair;
        const x=columns[1];
        const rows=shape==='detached'?[10]:shape==='offset-top'?[7,8]:[17,18];
        for(const row of rows)mask.fill(0,row*width+x,row*width+x+6);
        expect(coversClippedImageGlyphs(repair,'OPEN',above)).toBe(false);
    });
    function cardProposal(alpha=255){
        const {repair}=fourCaps(),width=72,height=48,pixels=new Uint8ClampedArray(width*height*4);
        repair.background=[245,238,230,alpha];
        for(let offset=0;offset<pixels.length;offset+=4)pixels.set(repair.background,offset);
        for(let index=0;index<repair.mask.length;index++)if(repair.mask[index]){
            const x=repair.left+index%repair.width,y=repair.top+Math.floor(index/repair.width);
            pixels.set([23,28,54,255],(y*width+x)*4);
        }
        const art=[12,6];
        pixels.set([230,50,100,255],(art[1]*width+art[0])*4);
        const line:ImageTextRegion={text:'已开放',bbox:repair.sourceBox,fontSize:12};
        const proposal=proposeImageMattePage(pixels,width,height,[line],[],l=>l.bbox)!;
        expect(proposal).toBeDefined();
        return {repair,width,height,pixels,proposal,line,art};
    }
    it('只为同次原文授权同帧缺口，并且只写已确认的字形像素',()=>{
        const {repair,width,height,pixels,proposal,line,art}=cardProposal();
        const support={forBox:()=>above};
        expect(authorizeImageMatteProposal(proposal,support)).toBeUndefined();
        expect(authorizeImageMatteProposal(proposal,support,new Map([[{...line},'OPEN']]))).toBeUndefined();
        const plan=authorizeImageMatteProposal(proposal,support,new Map([[line,'OPEN']]))!;
        expect(plan.uploads).toHaveLength(4);
        applyImageMattePage(pixels,width,height,plan);
        const expected=new Uint8ClampedArray(pixels.length);
        for(let offset=0;offset<expected.length;offset+=4)expected.set(repair.background,offset);
        expected.set([230,50,100,255],(art[1]*width+art[0])*4);
        expect(pixels).toEqual(expected);
    });
    it('有限补底仅移除已有擦除范围内的原墨，保留裁切边和其他图案',()=>{
        const {repair,width,height,pixels,proposal}=cardProposal();
        const original=pixels.slice(),plan=authorizeImageMatteWithinExistingMasks(proposal)!;
        expect(plan.uploads).toEqual([{x0:12,y0:16,x1:52,y1:31}]);
        expect(authorizeImageMatteWithinExistingMasks(proposal)).toBeUndefined();
        applyImageMattePage(pixels,width,height,plan);
        const expected=original.slice();
        for(let index=0;index<repair.mask.length;index++)if(repair.mask[index]){
            const y=repair.top+Math.floor(index/repair.width);
            if(y>=16)expected.set(repair.background,(y*width+repair.left+index%repair.width)*4);
        }
        expect(pixels).toEqual(expected);
        expect(()=>applyImageMattePage(pixels,width,height,plan)).toThrow('图片背景修补计划已失效');
    });
    it('有限补底不接纳半透明像素的提案',()=>{
        const {pixels,proposal}=cardProposal(196),before=pixels.slice();
        expect(authorizeImageMatteWithinExistingMasks(proposal)).toBeUndefined();
        expect(pixels).toEqual(before);
    });
    it('预算耗尽时不扫描同帧支持',()=>{
        const {repair}=fourCaps(),remaining={remaining:repair.mask.length-1};
        expect(coversClippedImageGlyphs(repair,'OPEN',()=>{throw new Error('unexpected query');},remaining)).toBe(false);
        expect(remaining.remaining).toBe(-1);
    });
});
