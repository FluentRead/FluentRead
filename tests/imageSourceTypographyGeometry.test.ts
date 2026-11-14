import {describe,expect,it} from 'vitest';
import type {ImageTextRegion} from '@/src/features/image-translation/paragraphs';
import {observeImageSourceTypographyGeometry} from '@/src/features/image-translation/services/sourceTypographyGeometry';

import {page,word} from './helpers/imageTypographyFixture';

const observe=(p:ReturnType<typeof page>,regions:readonly ImageTextRegion[])=>observeImageSourceTypographyGeometry(p.pixels,p.width,p.height,regions);
function group(lines:ImageTextRegion[]):ImageTextRegion {
    return{text:lines.map(l=>l.text).join(' '),bbox:{x0:Math.min(...lines.map(l=>l.bbox.x0)),y0:Math.min(...lines.map(l=>l.bbox.y0)),x1:Math.max(...lines.map(l=>l.bbox.x1)),y1:Math.max(...lines.map(l=>l.bbox.y1))},sourceBoxes:lines.map(l=>l.bbox)};
}

describe('只读倾斜字形几何',()=>{
    it.each([-10,-5,4,9])('原生无关的固定字形在%s度时给出完整投影，不修改输入或提供颜色/mask',degrees=>{
        const p=page(),line=word(p,220,80,degrees),before=p.pixels.slice(),source=structuredClone(line),geometry=observe(p,[line]).get(line)!;
        expect(geometry).toBeDefined();expect(geometry.owner).toBe(line);expect(geometry.sourceText).toBe(line.text);expect(geometry.radians*180/Math.PI).toBeCloseTo(degrees,0);
        expect(geometry.width).toBeGreaterThan(110);expect(geometry.height).toBeGreaterThan(19);expect(geometry.height).toBeLessThan(24);expect(geometry.count).toBe(1);
        expect(geometry.heightGain).toBeCloseTo(line.bbox.y1-line.bbox.y0-6-geometry.height,8);
        expect(geometry).not.toHaveProperty('mask');expect(geometry).not.toHaveProperty('foreground');expect(geometry).not.toHaveProperty('background');
        const c=Math.cos(geometry.radians),s=Math.sin(geometry.radians);
        for(let y=0;y<p.height;y++)for(let x=0;x<p.width;x++)if(p.pixels[(y*p.width+x)*4]===20){
            const u=c*(x+.5-geometry.originX)+s*(y+.5-geometry.originY),v=-s*(x+.5-geometry.originX)+c*(y+.5-geometry.originY);
            expect(u).toBeGreaterThanOrEqual(geometry.bounds.x0);expect(u).toBeLessThanOrEqual(geometry.bounds.x1);expect(v).toBeGreaterThanOrEqual(geometry.bounds.y0);expect(v).toBeLessThanOrEqual(geometry.bounds.y1);
        }
        expect(p.pixels).toEqual(before);expect(line).toEqual(source);
    });
    it('深底白字和浅横线背景都可提供几何，横线不能成为前景',()=>{
        const dark=page(640,360,20),light=page(),a=word(dark,220,80,-5,3,245),b=word(light);
        for(let x=0;x<light.width;x++)for(const y of [62,98])light.pixels.set([208,208,208,255],(y*light.width+x)*4);
        expect(observe(dark,[a]).get(a)?.radians).toBeCloseTo(-5*Math.PI/180,2);
        expect(observe(light,[b]).get(b)?.radians).toBeCloseTo(-5*Math.PI/180,2);
    });
    it('物理行保持独立字高，合段只采用一致方向、行高和同列关系',()=>{
        const p=page(),a=word(p,220,80,-5),b=word(p,226,150,-5),line=group([a,b]),snapshot=structuredClone(line);
        const geometry=observe(p,[line]).get(line)!;expect(geometry.count).toBe(2);expect(geometry.height).toBeLessThan(24);expect(geometry.bounds.y1-geometry.bounds.y0).toBeGreaterThan(80);expect(line).toEqual(snapshot);
        expect(geometry.linePitch).toBeGreaterThan(69);expect(geometry.linePitch).toBeLessThan(72);
        expect(observe(p,[{...line,sourceBoxes:[a.bbox,a.bbox]}]).size).toBe(0);
        const other=page(),left=word(other,170,80,-5),right=word(other,480,160,-5);expect(observe(other,[group([left,right])]).size).toBe(0);
        const mixed=page(),small=word(mixed,220,70,-5,2),large=word(mixed,220,180,-5,4);expect(observe(mixed,[group([small,large])]).size).toBe(0);
        const angles=page(),up=word(angles,220,80,-5),down=word(angles,220,180,5);expect(observe(angles,[group([up,down])]).size).toBe(0);
        const unequal=page(),rows=[word(unequal,220,60,-5),word(unequal,220,130,-5),word(unequal,220,270,-5)],paragraph=group(rows);
        expect(observe(unequal,[paragraph]).get(paragraph)).toMatchObject({count:3});expect(observe(unequal,[paragraph]).get(paragraph)).not.toHaveProperty('linePitch');
    });
    it.each([0,.5,18])('直立、不能确认的小角度或超出轻微倾角范围保持未知：%s',degrees=>{
        const p=page(),line=word(p,220,80,degrees);expect(observe(p,[line]).size).toBe(0);
    });
    it('低对比、透明、空白、平滑渐变和穿过观察外缘的暗线不推导文字样式',()=>{
        const p=page(640,360,130),line=word(p,220,80,-5,3,100);expect(observe(p,[line]).size).toBe(0);
        const alpha=page(),a=word(alpha);alpha.pixels[((a.bbox.y0-4)*alpha.width+a.bbox.x0-4)*4+3]=254;expect(observe(alpha,[a]).size).toBe(0);
        expect(observe(page(),[line]).size).toBe(0);
        const gradient=page();for(let y=0;y<gradient.height;y++)for(let x=0;x<gradient.width;x++){const v=Math.round(x/gradient.width*255);gradient.pixels.set([v,v,v,255],(y*gradient.width+x)*4);}expect(observe(gradient,[line]).size).toBe(0);
        const rule=page(),r=word(rule);for(let x=0;x<rule.width;x++)rule.pixels.set([20,20,20,255],(80*rule.width+x)*4);expect(observe(rule,[r]).size).toBe(0);
    });
    it('散点、大块图案和长线加孤立图块都不能冒充一行独立文字',()=>{
        const region={text:'SOURCE',bbox:{x0:50,y0:50,x1:350,y1:130}};
        const paint=(p:ReturnType<typeof page>,x0:number,y0:number,w:number,h:number)=>{for(let y=y0;y<y0+h;y++)for(let x=x0;x<x0+w;x++)p.pixels.set([20,20,20,255],(y*p.width+x)*4);};
        for(const shapes of [
            [[60,65,2,2],[150,80,2,2],[280,95,2,2]],
            [[60,60,280,60]],
            [[100,65,80,30]],
            [[70,65,30,30],[160,80,5,5],[290,80,5,5]],
            [[70,70,230,1],[70,90,25,25],[275,90,25,25]],
        ]){
            const p=page();for(const [x,y,w,h]of shapes)paint(p,x,y,w,h);expect(observe(p,[region]).size).toBe(0);
        }
        const noisy=page(),noiseRegion={text:'SOURCE',bbox:{x0:50,y0:50,x1:450,y1:180}};
        for(let y=60;y<175;y+=4)for(let x=60;x<445;x+=4)paint(noisy,x,y,1,1);
        expect(observe(noisy,[noiseRegion]).size).toBe(0);
    });
    it('长行的真实倾角超出搜索范围时不采用贴住搜索边界的最小值',()=>{
        const p=page(),angle=20,a=word(p,180,75,angle),b=word(p,320,75+140*Math.tan(angle*Math.PI/180),angle),line=group([a,b]);delete line.sourceBoxes;
        expect(observe(p,[line]).size).toBe(0);
    });
    it('同一个原框内的独立字组方向相反时，不强行给整行一个旋转角',()=>{
        const p=page(),a=word(p,180,80,-6),b=word(p,360,80,6),line=group([a,b]);delete line.sourceBoxes;
        expect(observe(p,[line]).size).toBe(0);
    });
    it('元数据越界、竖排、注音、保护区域及不含文字的内容不会得到几何',()=>{
        const p=page(),line=word(p),bad=[undefined,{x0:10,y0:10,x1:10,y1:20},{x0:-1,y0:10,x1:100,y1:30},{x0:10,y0:NaN,x1:100,y1:30},{x0:10,y0:10,x1:641,y1:30},{x0:10,y0:10,x1:100,y1:361}];
        for(const bbox of bad){expect(observe(p,[{...line,bbox:bbox!}]).size).toBe(0);expect(observe(p,[{...line,sourceBoxes:[bbox!]}]).size).toBe(0);}
        for(const change of [{vertical:true as const},{ruby:[{text:'か',bbox:line.bbox}]},{guardOnly:true as const},{numericUncertain:true as const},{text:undefined as never},{text:'AB'},{text:'12345'},{text:'A\nB'},{text:'x'.repeat(257)},{sourceBoxes:[]},{sourceBoxes:Array(129).fill(line.bbox)}])expect(observe(p,[{...line,...change}]).size).toBe(0);
        for(const change of [{x0:line.bbox.x0-1},{y0:line.bbox.y0-1},{x1:line.bbox.x1+1},{y1:line.bbox.y1+1}])expect(observe(p,[{...line,sourceBoxes:[{...line.bbox,...change}]}]).size).toBe(0);
        expect(observe(p,[undefined!])).toEqual(new Map());
    });
    it('小框、过大物理框和贴边框保留原路径，页尺寸和总预算先整体检查',()=>{
        const p=page(),line=word(p);
        for(const bbox of [{x0:10,y0:10,x1:50,y1:30},{x0:10,y0:10,x1:100,y1:18},{x0:10,y0:10,x1:100,y1:90},{x0:0,y0:10,x1:200,y1:50},{x0:10,y0:0,x1:200,y1:50},{x0:440,y0:10,x1:640,y1:50},{x0:10,y0:320,x1:200,y1:360},{x0:10,y0:10,x1:630,y1:130}])expect(observe(p,[{...line,bbox}]).size).toBe(0);
        for(const [w,h] of [[0,1],[8193,1],[1,NaN],[8192,8192],[640.5,360]])expect(observeImageSourceTypographyGeometry(p.pixels,w,h,[line]).size).toBe(0);
        expect(observeImageSourceTypographyGeometry(p.pixels.subarray(0,100),p.width,p.height,[line]).size).toBe(0);
        expect(observe(p,Array(4097).fill(line)).size).toBe(0);
        expect(observe(p,Array(400).fill(line)).size).toBe(0);
    });
    it('整页像素预算的精确边界可完成，增加一个物理观察域便整体撤回',()=>{
        const p=page(600,120),line=word(p,260,60,-5);line.bbox={x0:24,y0:24,x1:528,y1:80};
        // 每个独立观察域为512×64；包含边距，不能仅按原框面积扣费。
        expect(observe(p,Array(64).fill(line)).has(line)).toBe(true);
        expect(observe(p,Array(65).fill(line)).size).toBe(0);
    });
});
