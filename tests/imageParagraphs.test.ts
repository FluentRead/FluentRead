import {describe, expect, it} from 'vitest';
import {groupImageParagraphs, type ImageTextRegion,type ImageParagraphContinuations} from '@/src/features/image-translation/paragraphs';
function physical(text: string, top: number, size = 15, left = 30): ImageTextRegion {
    return {text, bbox: {x0: left, y0: top, x1: left + 120, y1: top + size}, fontSize: size};
}

describe('只豁免行距的受控布局能力端口',()=>{
    // These ports test the grouping contract only. Production pixel evidence,
    // adoption, graph identity and filtered guards have separate real consumers.
    function capability(pairs:Array<[ImageTextRegion,ImageTextRegion]>,allow=true):ImageParagraphContinuations{
        const successors=new Map(pairs);
        return {successor:line=>successors.get(line),permits:(previous,next,members,bounds)=>{
            expect(members.at(-1)).toBe(previous);expect(bounds.y0).toBe(members[0].bbox.y0);
            return allow&&successors.get(previous)===next;
        }};
    }
    it('只延长到实际指定后继，跨过另一列的交错y排序且保留逐物理行清字框',()=>{
        const a=physical('LEFT FIRST',0,20),b=physical('LEFT SECOND',50,20),c=physical('RIGHT FIRST',49,20,300),d=physical('RIGHT SECOND',98,20,300);
        expect(groupImageParagraphs([d,b,c,a])).toHaveLength(4);
        const result=groupImageParagraphs([d,b,c,a],capability([[a,b],[c,d]]));
        expect(result.map(line=>line.text)).toEqual(['LEFT FIRST LEFT SECOND','RIGHT FIRST RIGHT SECOND']);
        expect(result[0].sourceBoxes).toEqual([a.bbox,b.bbox]);expect(result[1].sourceBoxes).toEqual([c.bbox,d.bbox]);
    });
    it('缺失、已使用、被过滤或clone后继不扩大原扫描边界',()=>{
        const a=physical('FIRST',0,20),b=physical('SECOND',50,20);
        for(const pairs of [[],[[a,a]],[[a,{...b}]],[[a,physical('FILTERED',48,20)]]] as Array<Array<[ImageTextRegion,ImageTextRegion]>>)
            expect(groupImageParagraphs([a,b],capability(pairs))).toEqual([a,b]);
        const outOfOrder=capability([[a,b]]);expect(groupImageParagraphs([a,physical('AFTER TARGET',60,20)],outOfOrder)).toHaveLength(2);
    });
    it('拒绝的关系保持两段；能力只可豁免gap，不绕过其他布局条件',()=>{
        const a=physical('FIRST',0,20),b=physical('SECOND',50,20);
        expect(groupImageParagraphs([a,b],capability([[a,b]],false))).toEqual([a,b]);
        const invalid=[physical('LARGE',50,30),physical('2. ITEM',50,20),physical('OTHER COLUMN',50,20,300),
            {...b,sourceBoxes:[b.bbox]},{...b,vertical:true as const},physical('OVERLAP',10,20),physical('SAME ROW',0,20,300)];
        for(const next of invalid)expect(groupImageParagraphs([a,next],capability([[a,next]]))).toHaveLength(2);
    });
    it.each([false,true])('允许gap仍受完整段包络内其他物理文字遮挡%s',large=>{
        const a=physical('FIRST',0,20),b=physical('SECOND',50,20),block=physical('CONTROL',30,5,80);
        const far=large?Array.from({length:64},(_,i)=>physical('FAR'+i,1000+i*100,20,500)):[];
        const result=groupImageParagraphs([a,b,block,...far],capability([[a,b]]));
        expect(result).toContain(a);expect(result).toContain(b);expect(result).toHaveLength(3+far.length);
    });
    it('能力不传到竖排投影，完整两列的大间距仍按旧规则',()=>{
        const right:ImageTextRegion={text:'右列',bbox:{x0:100,y0:20,x1:120,y1:140},vertical:true};
        const left:ImageTextRegion={text:'左列',bbox:{x0:50,y0:20,x1:70,y1:140},vertical:true};
        expect(groupImageParagraphs([right,left],capability([[right,left]]))).toHaveLength(2);
    });
    it.each(['cumulative alignment','list boundary'])('无效后继不延长扫描：%s',kind=>{
        const a=physical('FIRST',0,20),b=physical('SECOND',50,20,45);
        const c=physical(kind==='list boundary'?'2. ITEM':'THIRD',100,20,60);
        const far=Array.from({length:15},(_,i)=>physical('FAR'+i,85+i,20,300));
        const port=capability([[a,b],[b,c]]), original=port.successor;
        let bLookups=0;
        port.successor=line=>{if(line===b)bLookups++;return original(line);};
        const result=groupImageParagraphs([a,b,...far,c],port);
        expect(result[0].text).toBe('FIRST SECOND');
        expect(result).toContain(c);
        // Pairwise alignment can pass while the cumulative paragraph cannot.
        // An invalid target must stop before scanning the unrelated labels.
        expect(bLookups).toBe(1);
    });
});

describe('源像素行距的缩放量化边界', () => {
    it('保存的自然漫画物理坐标不再因0.0167源像素拆段，不改原框或虚构逐框OCR文字', () => {
        // 来源：35c03a2三场景native的最终sourceBoxes；这里只复现几何，逐框文字使用显式标签。
        const boxes = [
            {x0: 861.3333333333334, y0: 1265, x1: 935, y1: 1281},
            {x0: 856.6666666666666, y0: 1289.3333333333333, x1: 939.3333333333333, y1: 1303.6666666666665},
            {x0: 849.3333333333334, y0: 1313, x1: 950, y1: 1327.3333333333333},
        ];
        const input = boxes.map((bbox, index) => ({text: `physical ${index}`, bbox, fontSize: bbox.y1 - bbox.y0}));
        const before = structuredClone(input), [paragraph] = groupImageParagraphs(input);
        expect(groupImageParagraphs(input)).toHaveLength(1);
        expect(paragraph.text).toBe('physical 0 physical 1 physical 2');
        expect(paragraph.sourceBoxes).toEqual(boxes);
        expect(paragraph.bbox).toEqual({x0: boxes[2].x0, y0: 1265, x1: 950, y1: boxes[2].y1});
        expect(input).toEqual(before);
    });

    it.each([0, 1 / 3, 1289 + 1 / 3, 10000 + 2 / 3])('分数坐标平移%s不改变完整像素边界，ULP也不能吞掉真实下一像素', offset => {
        for (const [gap, count] of [[9.75, 1], [9.76, 1], [10 - 1e-6, 1], [10, 2], [10 + 1e-6, 2]] as const) {
            const first = physical('FIRST', offset), next = physical('SECOND', offset + 15 + gap);
            expect(groupImageParagraphs([next, first])).toHaveLength(count);
        }
    });

    it('完整整数行距沿用旧阈值，不把round(9.75)误作允许10像素', () => {
        for (const size of [5, 10, 12, 15, 16, 20, 28, 32]) for (let gap = 0; gap <= 30; gap++) {
            expect(groupImageParagraphs([physical('FIRST', 0, size), physical('SECOND', size + gap, size)]))
                .toHaveLength(gap <= size * 0.65 ? 1 : 2);
        }
    });

    it('早停仍使用当前段的行高上界，不能被旁栏较小字号提前截断', () => {
        const first = physical('FIRST', 0, 20), unrelated = physical('SMALL LABEL', 32.5, 16, 300);
        const next = physical('SECOND', 33.5, 20);
        const result = groupImageParagraphs([next, unrelated, first]);
        expect(result.map(region => region.text)).toEqual(['FIRST SECOND', 'SMALL LABEL']);
        expect(result[0].sourceBoxes).toEqual([first.bbox, next.bbox]);
    });

    it('缩放误差不能跨过字号、列表、同行控件、重叠、旁栏或已有段落边界', () => {
        const first = physical('FIRST', 0, 16), top = 26.45;
        const blocked = [
            physical('SECOND', top, 12), physical('2. NEW ITEM', top, 16), physical('• NEW ITEM', top, 16),
            physical('CONTROL', 0, 16, 300), physical('OVERLAP', 12, 16), physical('OTHER COLUMN', top, 16, 300),
            {...physical('PREVIOUSLY GROUPED', top, 16), sourceBoxes: [physical('source', top, 16).bbox]},
            {...physical('VERTICAL', top, 16), vertical: true as const},
        ];
        for (const next of blocked) expect(groupImageParagraphs([first, next])).toHaveLength(2);
        const grouped = {...first, sourceBoxes: [first.bbox]};
        expect(groupImageParagraphs([grouped, physical('SECOND', top, 16)])).toHaveLength(2);
    });

    it.each([false, true])('亚像素续行仍不能跨遮挡%s，索引与扫描给出相同结果', large => {
        const first = physical('FIRST', 0, 16), next = physical('SECOND', 26.45, 16);
        const blocker: ImageTextRegion = {text: 'LABEL', bbox: {x0: 60, y0: 20, x1: 80, y1: 22}, fontSize: 2};
        const far = large ? Array.from({length: 64}, (_, index) => physical(`FAR ${index}`, 1000 + index * 100, 16, 500)) : [];
        const result = groupImageParagraphs([next, blocker, first, ...far]);
        expect(result.find(region => region.text === 'FIRST')).toBe(first);
        expect(result.find(region => region.text === 'SECOND')).toBe(next);
        expect(result).toHaveLength(3 + far.length);
    });

    it.each([0, 1 / 3, 1000 + 2 / 3])('竖列投影%s复用同一完整像素边界且保留原坐标', offset => {
        for (const [gap, count] of [[9.76, 1], [10, 2], [10 + 1e-6, 2]] as const) {
            const right: ImageTextRegion = {text: '右列', bbox: {x0: offset + 100, y0: 20, x1: offset + 115, y1: 120}, vertical: true};
            const left: ImageTextRegion = {text: '左列', bbox: {x0: offset + 85 - gap, y0: 20, x1: offset + 100 - gap, y1: 120}, vertical: true};
            const result = groupImageParagraphs([left, right]);
            expect(result).toHaveLength(count);
            if (count === 1) expect(result[0]).toMatchObject({text: '右列左列', sourceBoxes: [right.bbox, left.bbox], vertical: true});
        }
    });

    it('Atlas大行距与竖列中间横排标记均不因量化合并', () => {
        const left = [physical('FIRST', 298, 28, 138), physical('SECOND', 362, 28, 138)];
        const right = [physical('FIRST', 301, 23, 925), physical('SECOND', 365, 23, 924)];
        expect(groupImageParagraphs([...left, ...right])).toHaveLength(4);
        const columns: ImageTextRegion[] = [
            {text: '右列', bbox: {x0: 100, y0: 20, x1: 115, y1: 120}, vertical: true},
            {text: '左列', bbox: {x0: 75.24, y0: 20, x1: 90.24, y1: 120}, vertical: true},
            {text: 'MARKER', bbox: {x0: 94, y0: 60, x1: 96, y1: 80}},
        ];
        expect(groupImageParagraphs(columns)).toHaveLength(3);
    });
});

