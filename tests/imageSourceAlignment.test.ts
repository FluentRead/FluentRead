/** @file tests/imageSourceAlignment.test.ts 原图共同边线的独立几何回归；不把几何关系当作语义合段、擦除或额外绘字权限。 */
import {describe,it,expect} from 'vitest';
import {detectImageSingleLineAlignment,inferImageSourceAlignments} from '@/src/features/image-translation/services/sourceAlignment';
import type {ImageTextRegion} from '@/src/features/image-translation/paragraphs';
const row=(x0=100,y0=40,x1=500,y1=60):ImageTextRegion=>({text:'SOURCE',bbox:{x0,y0,x1,y1}});
const pair=()=>[row(),row(100,95,400,115)];
const infer=(regions:ImageTextRegion[],eligible=new Set(regions),width=1200,height=1600)=>inferImageSourceAlignments(regions,eligible,width,height);
describe('相邻原图长横排的明确共同边线',()=>{
    it('保留左右共同边线，输入顺序不决定结果且不修改源框',()=>{
        const left=pair(),before=structuredClone(left);left[0].sourceBoxes=[{...left[0].bbox}];before[0].sourceBoxes=[{...before[0].bbox}];
        expect([...infer(left).values()]).toEqual(['left','left']);expect([...infer([...left].reverse()).values()]).toEqual(['left','left']);expect(left).toEqual(before);
        const right=[row(),row(200,95,500,115)];expect([...infer(right).values()]).toEqual(['right','right']);
        expect(infer(left,new Set([left[0]]))).toEqual(new Map());expect(infer([left[0]])).toEqual(new Map());
    });
    it('相近宽度、居中、轻微偏差及不足以区分左右的边线不猜测',()=>{
        for(const b of [row(100,95,500,115),row(150,95,450,115),row(104,95,400,115),row(200,95,496,115),
            row(100,95,480,115),row(120,95,500,115),row(102,95,470,115),row(130,95,498,115)])expect(infer([row(),b]).size).toBe(0);
        expect([...infer([row(),row(103,95,400,115)]).values()]).toEqual(['left','left']);
    });
    it('不跨重叠、大间距、悬殊行高、窄竖块和不相交栏位',()=>{
        for(const b of [row(100,50,400,70),row(100,111,400,131),row(100,95,400,156),row(100,95,140,115),row(400,95,800,115)])
            expect(infer([row(),b]).size).toBe(0);
    });
    it('正文注音、竖排、数值保护和旁置/合并物理框不作为独立行证据',()=>{
        const extras=[{vertical:true},{guardOnly:true},{numericUncertain:true},{ruby:[{text:'か',bbox:row().bbox}]},
            {sourceBoxes:[]},{sourceBoxes:[row().bbox,row().bbox]},{sourceBoxes:[row(101).bbox]},{sourceBoxes:[undefined]},{sourceBoxes:{length:1,0:row().bbox}}];
        for(const extra of extras){const rows=pair();Object.assign(rows[0],extra);expect(infer(rows).size).toBe(0);}
    });
    it('任何夹在两行间的识别区域都会撤回提示，接触或在包络之外的区域不误阻挡',()=>{
        const rows=pair(),eligible=new Set(rows);
        expect(infer([...rows,row(200,75,250,85)],eligible).size).toBe(0);
        for(const outside of [row(500,70,600,90),row(0,70,100,90),row(200,115,300,135),row(200,10,300,40)])
            expect([...infer([...rows,outside],eligible).values()]).toEqual(['left','left']);
    });
    it('同一行冲突的边线不能投票覆盖，连续一致边线保持一致',()=>{
        const consistent=[...pair(),row(100,150,300,170)];expect([...infer(consistent).values()]).toEqual(['left','left','left']);
        const conflicting=[...pair(),row(150,150,400,170)],hints=infer(conflicting);
        expect(hints.get(conflicting[0])).toBe('left');expect(hints.has(conflicting[1])).toBe(false);expect(hints.get(conflicting[2])).toBe('right');
    });
    it('尺寸、区域及数量无效时整体保持原排版',()=>{
        for(const dimensions of [[0,900],[-1,900],[NaN,900],[1200.5,900],[8193,900],[5000,4000]])expect(infer(pair(),undefined,...dimensions as [number,number]).size).toBe(0);
        for(const bbox of [undefined,{x0:NaN,y0:0,x1:500,y1:60},row(-1).bbox,row(100,-1).bbox,row(100,40,1201).bbox,row(100,40,500,1601).bbox,row(100,40,100,60).bbox,row(100,40,500,40).bbox]){
            const rows=pair();rows[0].bbox=bbox as never;expect(infer(rows).size).toBe(0);
        }
        expect(infer([undefined] as never).size).toBe(0);expect(infer(Array.from({length:4097},()=>row())).size).toBe(0);
    });
    it('候选与障碍比较都共享预算，耗尽后撤回已得到的提示',()=>{
        const rows=[...pair(),...Array.from({length:258},()=>row(700,1400,1100,1420))];expect(infer(rows).size).toBe(0);
        const heads=Array.from({length:9},(_,i)=>[row(100,40+i*150,500,60+i*150),row(100,95+i*150,400,115+i*150)]).flat();
        const all=[...heads,...Array.from({length:4000},()=>row(700,1400,1100,1420))];expect(infer(all,new Set(heads)).size).toBe(0);
    });
});

describe('单行有界控件居中对齐检测',()=>{
    const makePill=(w=200,h=100,x0=40,y0=30,x1=160,y1=60)=>{
        const pixels=new Uint8ClampedArray(w*h*4);
        for(let i=0;i<pixels.length;i+=4)pixels.set([255,255,255,255],i);
        for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)pixels.set([0,174,66,255],(y*w+x)*4);
        return pixels;
    };
    it('对称胶囊返回 center，左对齐、无上下边框、透明像素、越界或非法参数均返回 undefined',()=>{
        const bbox={x0:85,y0:38,x1:115,y1:52};
        const pill=makePill();
        expect(detectImageSingleLineAlignment(pill,200,100,bbox)).toBe('center');

        // 非法尺寸、缓冲或过小/过高文本框
        expect(detectImageSingleLineAlignment(pill,0,100,bbox)).toBeUndefined();
        expect(detectImageSingleLineAlignment(new Uint8ClampedArray(4),200,100,bbox)).toBeUndefined();
        expect(detectImageSingleLineAlignment(pill,200,100,{x0:85,y0:38,x1:87,y1:52})).toBeUndefined();
        expect(detectImageSingleLineAlignment(pill,200,100,{x0:85,y0:10,x1:115,y1:95})).toBeUndefined();

        // 水平扫描遇到透明像素
        const hAlpha=makePill();
        hAlpha[(45*200+70)*4+3]=128;
        expect(detectImageSingleLineAlignment(hAlpha,200,100,bbox)).toBeUndefined();

        // 左对齐输入框（左右边距均在搜索半径内但不对称）
        expect(detectImageSingleLineAlignment(pill,200,100,{x0:50,y0:38,x1:110,y1:52})).toBeUndefined();

        // 纵向扫描撞到图边（无上边框）
        const topOpen=makePill(200,100,40,0,160,60);
        expect(detectImageSingleLineAlignment(topOpen,200,100,{x0:85,y0:10,x1:115,y1:24})).toBeUndefined();

        // 纵向扫描遇到透明像素
        const vAlpha=makePill();
        vAlpha[(34*200+100)*4+3]=100;
        expect(detectImageSingleLineAlignment(vAlpha,200,100,bbox)).toBeUndefined();

        // 纵向超出搜索半径无上下边框（例如同排间隔文字而非按钮）
        const tallNoBorder=makePill(200,140,40,0,160,140);
        expect(detectImageSingleLineAlignment(tallNoBorder,200,140,{x0:85,y0:60,x1:115,y1:74})).toBeUndefined();

        // 仅有上边框无下边框
        const bottomOpen=makePill(200,140,40,30,160,140);
        expect(detectImageSingleLineAlignment(bottomOpen,200,140,{x0:85,y0:38,x1:115,y1:52})).toBeUndefined();
    });
});
