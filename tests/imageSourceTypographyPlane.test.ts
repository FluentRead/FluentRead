import {describe,expect,it} from 'vitest';
import {createImageTypographyPlane,type ImageTypographyGlyph} from '@/src/features/image-translation/services/sourceTypographyPlane';
import type {ImageSourceTypographyGeometry} from '@/src/features/image-translation/services/sourceTypographyGeometry';
import {layoutImageTranslationText} from '@/src/features/image-translation/services/rendering';
import {layoutMangaTranslationText} from '@/src/features/image-translation/services/mangaTypography';

const box={x0:20,y0:30,x1:220,y1:150};
const geometry=():ImageSourceTypographyGeometry=>({owner:{text:'SOURCE',bbox:box},sourceText:'SOURCE',radians:-Math.PI/18,originX:120,originY:90,bounds:{x0:-80,y0:-20,x1:80,y1:20},width:160,height:40,count:1,heightGain:10});
const metric:ImageTypographyGlyph={left:3,right:57,ascent:14,descent:4};
const layout={lines:['完整文字'],fontSize:20,lineHeight:24,ink:{height:20,baselines:[15]}};

describe('旋转后的完整译文必须放进原世界坐标框',()=>{
    it.each(['left','center','right'] as const)('%s以原墨迹边线定位，并只返回旋转和最小整体平移',align=>{
        const g=geometry(),snapshot=structuredClone({g,layout}),plane=createImageTypographyPlane(box,g,align,()=>metric,()=>1)!;
        const result=plane.plan(layout)!;expect(result.transform).toEqual([Math.cos(g.radians),Math.sin(g.radians),-Math.sin(g.radians),Math.cos(g.radians),120,90]);
        const {x,y}=result.points[0];expect(y).toBe(5);expect(x).toBe(align==='left'?-76:align==='right'?22:-27);
        expect({g,layout}).toEqual(snapshot);expect(plane.constraints.accept!(layout)).toBe(true);
    });
    it.each([-1,1])('偏离原框的源锚点%d只作使完整字形回框的最小平移',side=>{
        const g={...geometry(),originX:side*500,originY:side*500},result=createImageTypographyPlane(box,g,'left',()=>metric,()=>1)!.plan(layout)!;
        const [a,b,c,d,e,f]=result.transform,{x,y}=result.points[0],points=[];
        for(const u of [x-4,x+58])for(const v of [y-15,y+5])points.push({x:a*u+c*v+e,y:b*u+d*v+f});
        const left=Math.min(...points.map(p=>p.x)),right=Math.max(...points.map(p=>p.x)),top=Math.min(...points.map(p=>p.y)),bottom=Math.max(...points.map(p=>p.y));
        expect(left).toBeGreaterThanOrEqual(box.x0+1-1e-9);expect(right).toBeLessThanOrEqual(box.x1-1+1e-9);expect(top).toBeGreaterThanOrEqual(box.y0+1-1e-9);expect(bottom).toBeLessThanOrEqual(box.y1-1+1e-9);
        expect(side<0?left:right).toBeCloseTo(side<0?box.x0+1:box.x1-1);expect(side<0?top:bottom).toBeCloseTo(side<0?box.y0+1:box.y1-1);
    });
    it('字形与描边旋转后过宽或过高时拒绝，不靠clip截断正文',()=>{
        for(const change of [{right:500},{ascent:200}]){
            const plane=createImageTypographyPlane(box,geometry(),'center',()=>({...metric,...change}),()=>1)!;
            expect(plane.plan(layout)).toBeUndefined();expect(plane.constraints.accept!(layout)).toBe(false);
        }
    });
    it('缺失、空白及不完整墨迹指标不会授予旋转，显式空行仍保留',()=>{
        const plane=createImageTypographyPlane(box,geometry(),'left',()=>metric,()=>1)!;
        for(const change of [{ink:undefined},{lines:[]},{ink:{height:20,baselines:[]}},{ink:{height:NaN,baselines:[15]}},{ink:{height:20,baselines:[NaN]}}])expect(plane.plan({...layout,...change} as never)).toBeUndefined();
        for(const change of [{left:NaN},{right:Infinity},{left:0,right:0},{ascent:0,descent:0}])expect(createImageTypographyPlane(box,geometry(),'left',()=>({...metric,...change}),()=>1)!.plan(layout)).toBeUndefined();
        for(const padding of [NaN,-1])expect(createImageTypographyPlane(box,geometry(),'left',()=>metric,()=>padding)!.plan(layout)).toBeUndefined();
        expect(plane.plan({...layout,lines:[''],ink:{height:20,baselines:[15]}})).toBeUndefined();
        expect(plane.plan({...layout,lines:['第一行','','最后一行'],ink:{height:68,baselines:[15,39,63]}})?.points).toHaveLength(3);
    });
    it('非有限或不能容纳外侧像素余量的框保持原布局',()=>{
        for(const change of [{x0:NaN},{x1:22},{y1:32}])expect(createImageTypographyPlane({...box,...change},geometry(),'left',()=>metric,()=>1)).toBeUndefined();
        const g=geometry();
        for(const change of [{radians:Infinity},{bounds:{...g.bounds,x1:-80}},{bounds:{...g.bounds,y1:-20}}])expect(createImageTypographyPlane(box,{...g,...change},'left',()=>metric,()=>1)).toBeUndefined();
    });
    it.each([layoutImageTranslationText,layoutMangaTranslationText])('两类布局在同样行数时保留源行距，同时通过旋转包络缩小字号',fit=>{
        const g={...geometry(),count:2,linePitch:60},plane=createImageTypographyPlane(box,g,'left',(text,size)=>({left:0,right:text.length*size,ascent:size*.8,descent:size*.2}),()=>1)!;
        const result=fit('AAAAA\nBBBBB',plane.width,plane.height,(text,size)=>text.length*size,40,(_text,size)=>({ascent:size*.8+1,descent:size*.2+1}),plane.constraints);
        expect(result.lines).toEqual(['AAAAA','BBBBB']);expect(result.fontSize).toBeLessThan(40);expect(result.lineHeight).toBe(60);expect(plane.plan(result)).toBeDefined();
        expect(result.ink!.baselines[1]-result.ink!.baselines[0]).toBe(60);
        for(const sourceLinePitch of [undefined,NaN,10]){const normal=fit('AA\nBB',200,120,(text,size)=>text.length*size,20,(_text,size)=>({ascent:size*.8,descent:size*.2}),{sourceLineCount:2,sourceLinePitch});expect(normal.lineHeight).toBeGreaterThan(20);expect(normal.lineHeight).toBeLessThan(25);}
        const single=fit('AA',200,120,(text,size)=>text.length*size,20,(_text,size)=>({ascent:size*.8,descent:size*.2}),plane.constraints);expect(single.lineHeight).toBeLessThan(25);
    });
});
