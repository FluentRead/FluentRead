/** @file tests/mangaRecognitionConnectedBands.test.ts
 * 核对同一裁图中的二维字形顺序、三层对应及彩底完整词隙。实际模型回放见相邻紧裁用例。
 */
import {describe,expect,it} from 'vitest';
import {observeMangaRecognitionConnectedBands as bands} from '@/src/features/image-translation/services/mangaRecognitionConnectedBands';
import {observeMangaRecognitionConnectedColorProjection as project} from '@/src/features/image-translation/services/mangaRecognitionInkProjection';

const width=240,height=48,levels=[16,32,64] as const;
const letters=[[10,24],[29,43],[69,83],[88,102]] as const;
function strengthFrame(items:ReadonlyArray<readonly [number,number]>=letters) {
    const strength=new Uint8Array(width*height);
    const paint=(x0:number,x1:number,color=220,y0=4,y1=44)=>{
        for(let y=y0;y<y1;y++)strength.fill(color,y*width+x0,y*width+x1);
    };
    for(const [x0,x1]of items)paint(x0,x1);
    return {strength,paint};
}

describe('颜色强度的逐层字形对应',()=>{
    it('独立字形和原强度数据保持，复用同次组件预算',()=>{
        const f=strengthFrame(),before=f.strength.slice(),budget={remaining:12};
        const result=bands(f.strength,width,levels,budget)!;
        expect(result.middle.map(glyph=>[glyph.start,glyph.end])).toEqual(letters);
        expect(result.weak).toEqual(result.strong);
        expect(f.strength).toEqual(before);
        expect(budget.remaining).toBe(0);
        expect(bands(f.strength,width,levels,{remaining:11})).toBeUndefined();
    });
    it('独立笔画包围框可以重叠两列，重叠更大或混入另一行则撤回',()=>{
        const f=strengthFrame([[69,83],[88,102]]);
        f.paint(10,15);f.paint(15,26,220,4,8);
        f.paint(27,32);f.paint(24,27,220,39,44);
        const result=bands(f.strength,width,levels,{remaining:12})!;
        expect(result.middle.map(glyph=>[glyph.start,glyph.end])).toEqual([[10,26],[24,32],[69,83],[88,102]]);
        f.paint(22,24,220,39,44);
        expect(bands(f.strength,width,levels,{remaining:12})).toBeUndefined();
        const twoRows=strengthFrame();
        twoRows.paint(120,135,220,25,32);
        expect(bands(twoRows.strength,width,levels,{remaining:512})).toBeUndefined();
    });
    it('尺寸、层间缺字、过多组件或同数换位都不能发布对应关系',()=>{
        const f=strengthFrame();
        expect(bands(f.strength,width-1,levels,{remaining:512})).toBeUndefined();
        expect(bands(new Uint8Array(1_400*48),1_400,levels,{remaining:512})).toBeUndefined();
        expect(bands(strengthFrame([[10,24]]).strength,width,levels,{remaining:512})).toBeUndefined();
        for(const value of [22,42]){
            f.paint(10,24,value);
            expect(bands(f.strength,width,levels,{remaining:512})).toBeUndefined();
        }
        const replacement=strengthFrame([[72,86],[90,104],[120,135]]);
        replacement.paint(10,18);replacement.paint(26,34);
        replacement.paint(18,26,22,4,5);
        replacement.paint(42,50,22);
        expect(bands(replacement.strength,width,levels,{remaining:512})).toBeUndefined();
        const wide=new Uint8Array(320*48);
        for(let i=0;i<65;i++)for(let y=4;y<44;y++)wide.fill(220,y*320+4*i,y*320+4*i+3);
        expect(bands(wide,320,levels,{remaining:512})).toBeUndefined();
    });
});

type Rgb=readonly [number,number,number];
function colorFrame(items:ReadonlyArray<readonly [number,number]>=letters,background:Rgb=[40,110,150],ink:Rgb=[255,110,80],weakSkirt=0){
    const rgba=new Uint8ClampedArray(width*height*4);
    for(let offset=0;offset<rgba.length;offset+=4)rgba.set([...background,255],offset);
    const light=background.map((value,index)=>Math.round(value+(ink[index]-value)*0.16));
    for(const [x0,x1]of items)for(let y=4;y<44;y++)for(let x=x0;x<x1;x++){
        rgba.set(x<x0+weakSkirt||x>=x1-weakSkirt?[...light,255]:[...ink,255],(y*width+x)*4);
    }
    return rgba;
}

describe('中对比彩底词隙的颜色及宽度证据',()=>{
    it('只选择同时有相反通道差、稳定字形和共同完整底色的间隙',()=>{
        expect(project(colorFrame(),width,{remaining:512})).toEqual({characters:4,gaps:[{start:43,end:69,after:2}]});
        const invalidPalettes:ReadonlyArray<readonly [Rgb,Rgb]>=[
            [[255,255,255],[255,0,255]], [[40,110,150],[100,120,80]], [[40,110,150],[41,80,10]], [[40,110,150],[200,160,150]],
        ];
        for(const [bg,ink]of invalidPalettes)expect(project(colorFrame(letters,bg,ink),width,{remaining:512})).toBeUndefined();
        expect(project(new Uint8ClampedArray(4),1_400,{remaining:512})).toBeUndefined();
    });
    it('同层间隙、跨层显著性和最小宽度缺一时不产生词界',()=>{
        const equal=[[10,24],[28,42],[46,60],[64,78]] as const;
        const narrow=[[10,24],[25,39],[45,59],[60,74]] as const;
        const inconsistent=[[10,24],[28,42],[51,65],[69,83]] as const;
        for(const frame of [colorFrame(equal),colorFrame(narrow),colorFrame(inconsistent,undefined,undefined,2)])
            expect(project(frame,width,{remaining:512})).toBeUndefined();
        expect(project(colorFrame([[10,24]]),width,{remaining:512})).toBeUndefined();
    });
});
