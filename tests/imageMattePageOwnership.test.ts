/**
 * @file tests/imageMattePageOwnership.test.ts
 * 使用真实局部证明与真实owned位图消费者复现不同背景争用墨迹的顺序依赖。
 * coarse检测网格是明确的受控模型端口，故意覆盖灰牌；不是native或作者分割真值。
 */
import {describe,expect,it} from 'vitest';
import type {ImageTextRegion} from '@/src/features/image-translation/paragraphs';
import {createImageDetectionEvidenceBudget,bindImageDetectionEvidence,getImageDetectionEvidence} from '@/src/features/image-translation/services/imageDetectionEvidence';
import {planImageMatteRepair} from '@/src/features/image-translation/services/imageMatteRepair';
import {planImageMattePage} from '@/src/features/image-translation/services/imageMattePage';

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
        for(const order of [[a,b],[b,a]])expect(planImageMattePage(pixels,width,height,order,[],draw,evidence)).toBeUndefined();
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
        for(const order of [[a,b],[b,a]])expect(planImageMattePage(pixels,width,height,order,[],draw,evidence)).toBeUndefined();
        expect(pixels).toEqual(before);
    });
});
