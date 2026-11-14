/** @file tests/mangaDetectionRefinement.test.ts 弱连接大框中的完整水平核心、真实概率/源像素记录及有界失败回退。 */
import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {collectMangaDetectionRefinementCores as collect,createMangaDetectionRefinementBudget as budget,MANGA_DETECTION_REFINEMENT_LIMITS as limits,hasCompleteMangaDetectionCropInk as complete,type MangaDetectionRect as Rect} from '@/src/features/image-translation/services/mangaDetectionRefinement';

function sample(width=128,height=128,region:Rect={x0:16,y0:16,x1:112,y1:112},parent:Rect={x0:8,y0:8,x1:120,y1:120}){
    const data=new Float32Array(width*height);
    for(let y=region.y0;y<region.y1;y++)for(let x=region.x0;x<region.x1;x++)data[y*width+x]=.1;
    const paint=(r:Rect,value=.9)=>{for(let y=r.y0;y<r.y1;y++)for(let x=r.x0;x<r.x1;x++)data[y*width+x]=value;};
    const run=(b=budget())=>collect(data,width,height,region,parent,b);
    return {data,width,height,region,parent,paint,run};
}
describe('原框内紧凑核心候选',()=>{
    it('只生成有独立完整核心且显著提高字高的裁图，不改原概率或原框',()=>{
        const s=sample(),core={x0:32,y0:48,x1:96,y1:60};s.paint(core);const before=s.data.slice(),b=budget();
        expect(s.run(b)).toEqual([{core,crop:{x0:28,y0:44,x1:100,y1:64},area:768}]);expect(s.data).toEqual(before);expect(s.region).toEqual({x0:16,y0:16,x1:112,y1:112});expect(b).toEqual({pixels:9216,components:1});
    });
    it('八邻域保留斜向连续的同一条文字，不把角接触拆成两条',()=>{
        const s=sample();s.paint({x0:32,y0:48,x1:64,y1:54});s.paint({x0:64,y0:54,x1:96,y1:60});
        expect(s.run()).toEqual([{core:{x0:32,y0:48,x1:96,y1:60},crop:{x0:28,y0:44,x1:100,y1:64},area:384}]);
    });
    it.each([
        {x0:40,y0:40,x1:41,y1:41},
        {x0:32,y0:48,x1:96,y1:55},
        {x0:40,y0:40,x1:48,y1:72},
        {x0:16,y0:40,x1:88,y1:64},
        {x0:40,y0:40,x1:112,y1:64},
        {x0:32,y0:16,x1:104,y1:40},
        {x0:32,y0:88,x1:104,y1:112},
    ])('孤点、细线、竖形和接触原区域边缘的核心不成为补充框：%j',core=>{
        const s=sample();s.paint(core);expect(s.run()).toEqual([]);
    });
    it('留白不能越过原SDK父框的任意一边',()=>{
        const region={x0:0,y0:0,x1:96,y1:96};
        for(const core of [{x0:2,y0:35,x1:74,y1:59},{x0:22,y0:35,x1:94,y1:59},{x0:12,y0:2,x1:84,y1:26},{x0:12,y0:70,x1:84,y1:94}]){
            const s=sample(96,96,region,region);s.paint(core);expect(s.run()).toEqual([]);
        }
    });
    it('正常厚字与没有明显收紧的外围不触发重识别候选',()=>{
        const r={x0:0,y0:0,x1:192,y1:96},s=sample(192,96,r,r);s.paint({x0:33,y0:27,x1:159,y1:69});expect(s.run()).toEqual([]);
        const outline=sample(192,96,r,r);for(const b of [{x0:13,y0:30,x1:179,y1:31},{x0:13,y0:65,x1:179,y1:66},{x0:13,y0:30,x1:14,y1:66},{x0:178,y0:30,x1:179,y1:66}])outline.paint(b);expect(outline.run()).toEqual([]);
    });
});
describe('完整概率与页级工作量',()=>{
    it('没有核心或核心过密时不创建候选',()=>{
        const s=sample();expect(s.run()).toBeUndefined();s.paint(s.region);expect(s.run()).toBeUndefined();
    });
    it('未知概率与缺失buffer不能被当作弱背景，已付观察额度不退',()=>{
        for(const value of [NaN,Infinity,-Infinity,-.1,1.1]){
            const s=sample(),b=budget();s.paint({x0:32,y0:48,x1:96,y1:60});s.data[60*s.width+80]=value;expect(s.run(b)).toBeUndefined();expect(b.pixels).toBe(9216);
        }
        const s=sample(),b=budget();expect(collect(s.data.subarray(1),s.width,s.height,s.region,s.parent,b)).toBeUndefined();expect(b.pixels).toBe(9216);
    });
    it('细框、区域面积与页像素/组件上限先拦截，组件中途耗尽不返回部分候选',()=>{
        for(const region of [{x0:16,y0:16,x1:63,y1:112},{x0:16,y0:16,x1:112,y1:63}]){const s=sample(128,128,region),b=budget();expect(s.run(b)).toBeUndefined();expect(b.pixels).toBe(0);}
        expect(collect(new Float32Array(1),1536,1536,{x0:0,y0:0,x1:1025,y1:1024},{x0:0,y0:0,x1:1536,y1:1536},budget())).toBeUndefined();
        const s=sample();s.paint({x0:32,y0:36,x1:96,y1:44});s.paint({x0:32,y0:68,x1:96,y1:76});
        for(const b of [{pixels:limits.pixels,components:0},{pixels:0,components:limits.components}])expect(s.run(b)).toBeUndefined();
        const b={pixels:0,components:limits.components-1};expect(s.run(b)).toBeUndefined();expect(b.components).toBe(limits.components+1);expect(s.run(b)).toBeUndefined();expect(s.run(budget())).toHaveLength(2);
    });
});

describe('原像素裁图完整性',()=>{
    const W=160,H=100,bounds={x0:20,y0:20,x1:120,y1:60};
    function pixels(gradient=false){
        const data=new Uint8ClampedArray(W*H*4);
        for(let y=0;y<H;y++)for(let x=0;x<W;x++)data.set(gradient?[30+x*.3,40+y*.2,70,255]:[245,240,221,255],(y*W+x)*4);
        return data;
    }
    function ink(data:Uint8ClampedArray){for(let y=30;y<50;y++)for(let x=35;x<95;x++)data.set([x%2?1:8,y%2?20:13,40,255],(y*W+x)*4);}
    it('完整静区包含多色/重采样墨迹，保持全部原像素',()=>{
        for(const gradient of [false,true]){const data=pixels(gradient);ink(data);const before=data.slice();expect(complete(data,W,H,bounds)).toBe(true);expect(data).toEqual(before);}
    });
    it('裁边笔画、框外分离笔画、边界噪声与任何透明像素均拒绝',()=>{
        for(const [x,y]of [[20,35],[50,20],[119,35],[50,59],[123,40],[70,63],[12,40]]){const data=pixels();ink(data);data.set([1,20,40,255],(y*W+x)*4);expect(complete(data,W,H,bounds)).toBe(false);}
        for(const [x,y]of [[50,40],[12,12]]){const data=pixels();ink(data);data[(y*W+x)*4+3]=254;expect(complete(data,W,H,bounds)).toBe(false);}
        const gradient=pixels(true);ink(gradient);gradient[(40*W+12)*4]+=3;expect(complete(gradient,W,H,bounds)).toBe(false);
    });
    it('空白和零星噪点不能启动识别，观察范围外图案不影响局部结论',()=>{
        const data=pixels();expect(complete(data,W,H,bounds)).toBe(false);
        for(let x=35;x<42;x++)data.set([1,20,40,255],(40*W+x)*4);expect(complete(data,W,H,bounds)).toBe(false);
        data.set([1,20,40,255],(40*W+42)*4);expect(complete(data,W,H,bounds)).toBe(true);
        data.set([255,0,0,255],(90*W+150)*4);expect(complete(data,W,H,bounds)).toBe(true);
    });
    it('无效输入和缺失完整外周保持未知，不读取猜测的图外像素',()=>{
        const data=pixels();ink(data);expect(complete(data,0,H,bounds)).toBe(false);expect(complete(data.subarray(1),W,H,bounds)).toBe(false);expect(complete(data,W,H,{...bounds,x0:20.5})).toBe(false);
        for(const r of [{...bounds,x0:0},{...bounds,y0:0},{...bounds,x1:W},{...bounds,y1:H}])expect(complete(data,W,H,r)).toBe(false);
    });
});
it('真实标题与页脚核心可缩回文字，强响应背景形状不冒充长行，源裁图须保留全部墨迹',()=>{
    const bytes=readFileSync(new URL('./fixtures/manga-detection-refinement-recording.json',import.meta.url));expect(bytes.length).toBeLessThan(2_000_000);expect(createHash('sha256').update(bytes).digest('hex')).toBe('17b575e54c2874afbe43cee480c665789ee103eb73f242138bf869d1379a1a35');
    const f=JSON.parse(bytes.toString()),manifest=readFileSync(new URL(`./fixtures/${f.sourceManifest}/manifest.json`,import.meta.url));expect(createHash('sha256').update(manifest).digest('hex')).toBe(f.sourceManifestSha256);
    const source=JSON.parse(manifest.toString()).fixtures.find((r:any)=>r.name===f.scene);expect(source.sha256).toBe(f.sourceImageSha256);expect(createHash('sha256').update(readFileSync(new URL(`./fixtures/${f.sourceManifest}/${source.file}`,import.meta.url))).digest('hex')).toBe(f.sourceImageSha256);
    for(const s of f.samples){
        const raw=gunzipSync(Buffer.from(s.float32GzipBase64,'base64'),{maxOutputLength:s.roi.width*s.roi.height*4});expect(createHash('sha256').update(raw).digest('hex')).toBe(s.valuesSha256);
        const data=new Float32Array(s.frameWidth*s.frameHeight);let i=0;for(let y=s.roi.top;y<s.roi.top+s.roi.height;y++)for(let x=s.roi.left;x<s.roi.left+s.roi.width;x++)data[y*s.frameWidth+x]=raw.readFloatLE(i++*4);
        const found=collect(data,s.frameWidth,s.frameHeight,s.originalRegion,s.parent,budget())!;expect(found.map(r=>r.core)).toEqual(s.expectedCores);
        if(s.sourcePixels){const rgb=s.sourcePixels,rawPixels=gunzipSync(Buffer.from(rgb.rgbaGzipBase64,'base64'),{maxOutputLength:rgb.width*rgb.height*4});expect(createHash('sha256').update(rawPixels).digest('hex')).toBe(rgb.sha256);const pixels=new Uint8ClampedArray(rawPixels.buffer,rawPixels.byteOffset,rawPixels.byteLength);
            for(const ratio of [.1,.25]){const b=rgb.candidateCrops.find((c:any)=>c.paddingRatio===ratio).box,bounds={x0:b.x-rgb.left,y0:b.y-rgb.top,x1:b.x+b.width-rgb.left,y1:b.y+b.height-rgb.top};expect(complete(pixels,rgb.width,rgb.height,bounds),s.label+' '+ratio).toBe(ratio===.25&&s.label==='title');}
            const crop=found[0].crop;expect(complete(pixels,rgb.width,rgb.height,{x0:crop.x0-rgb.left,y0:crop.y0-rgb.top,x1:crop.x1-rgb.left,y1:crop.y1-rgb.top})).toBe(true);
        }
    }
});
