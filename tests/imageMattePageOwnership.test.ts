/**
 * @file tests/imageMattePageOwnership.test.ts
 * 使用真实局部证明与真实owned位图消费者复现不同背景争用墨迹的顺序依赖。
 * coarse检测网格是明确的受控模型端口，故意覆盖灰牌；不是native或作者分割真值。
 */
import {describe,expect,it} from 'vitest';
import type {ImageTextRegion} from '@/src/features/image-translation/paragraphs';
import {createImageDetectionEvidenceBudget,bindImageDetectionEvidence,getImageDetectionEvidence} from '@/src/features/image-translation/services/imageDetectionEvidence';
import {planImageMatteRepair,type ImageMatteRepair} from '@/src/features/image-translation/services/imageMatteRepair';
import {coversClippedImageGlyphs} from '@/src/features/image-translation/services/imageClippedGlyphs';
import {applyImageMattePage,authorizeImageMatteProposal,authorizeImageMatteWithinExistingMasks,getImageMatteProposalDrawings,planImageMattePage,proposeImageMattePage} from '@/src/features/image-translation/services/imageMattePage';

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
