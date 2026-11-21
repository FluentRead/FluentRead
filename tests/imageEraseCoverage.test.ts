import {describe,expect,it} from 'vitest';
import {hasUncoveredImageInk} from '@/src/features/image-translation/services/imageEraseCoverage';
import type {ImageTextRegion} from '@/src/features/image-translation/paragraphs';
import type {ImageSourceAppearance} from '@/src/features/image-translation/services/sourceAppearance';

const bg=[10,20,30,255] as const;
const box={x0:10,y0:10,x1:20,y1:20};
function setup(){
    const pixels=new Uint8ClampedArray(40*40*4);for(let i=0;i<pixels.length;i+=4)pixels.set(bg,i);
    const line:ImageTextRegion={text:'SOURCE',bbox:{...box}};
    const appearance:ImageSourceAppearance={background:bg,inkBoxes:[{x0:7,y0:8,x1:23,y1:22}]};
    const map=new Map([[line,appearance]]);
    return {pixels,line,appearance,map,test:()=>hasUncoveredImageInk(pixels,40,40,map)};
}

describe('普通图原墨迹与旧清字框的只读覆盖检查',()=>{
    it('纯色墨迹框伸出但框角为空白时不触发，真正的遗漏像素才触发且不写入',()=>{
        const f=setup();expect(f.test()).toBe(false);
        f.pixels.set([40,20,30,255],(10*40+7)*4);const before=f.pixels.slice();
        expect(f.test()).toBe(true);expect(f.pixels).toEqual(before);
    });
    it('已经包含的框不扫描；多个旧框按并集覆盖而非只对第一行判断',()=>{
        const f=setup();f.appearance.inkBoxes=[{...box}];f.pixels.fill(255);expect(f.test()).toBe(false);
        f.line.sourceBoxes=[{x0:5,y0:10,x1:12,y1:20},{x0:16,y0:10,x1:25,y1:20}];
        f.appearance.inkBoxes=[{x0:7,y0:8,x1:23,y1:22}];expect(f.test()).toBe(false);
    });
    it('缺少可靠背景或墨迹、半透明背景、空集合都不触发',()=>{
        const f=setup();for(const appearance of [{},{background:bg},{background:[10,20,30,224] as const,inkBoxes:[box]}]){
            f.map.set(f.line,appearance);expect(f.test()).toBe(false);
        }
        f.map.clear();expect(f.test()).toBe(false);
    });
    it('越界框裁到源图，无效框与整页像素预算不足均撤回',()=>{
        const f=setup();f.appearance.inkBoxes=[{x0:-5,y0:-6,x1:45,y1:46}];expect(f.test()).toBe(false);
        f.appearance.inkBoxes=[{...box,x0:NaN}];expect(f.test()).toBe(false);
        f.appearance.inkBoxes=Array.from({length:165},()=>({x0:0,y0:0,x1:40,y1:40}));expect(f.test()).toBe(false);
    });
    it('框包含查询与逐像素并集查询分别受共享比较预算限制',()=>{
        const f=setup();f.line.sourceBoxes=Array.from({length:1100},()=>({...box}));
        f.appearance.inkBoxes=Array.from({length:1000},()=>({x0:30,y0:30,x1:30,y1:30}));expect(f.test()).toBe(false);
        f.appearance.inkBoxes=[{x0:0,y0:0,x1:40,y1:40}];expect(f.test()).toBe(false);
    });
});
