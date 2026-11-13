/** @file tests/imageTextBalance.test.ts 普通图片短末行平衡的阅读效果、原词字素完整性、实际字形边界与工作量限制。 */
import {describe,it,expect,vi,afterEach} from 'vitest';
import {layoutImageTranslationText as layout} from '@/src/features/image-translation/services/rendering';

const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
const units=(text:string)=>Array.from(segmenter.segment(text),part=>part.segment);
const measure=(text:string,size:number)=>units(text).length*size;
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
describe('普通图片短末行平衡',()=>{
    it('温室对白保留字号和两行，让尾部文字更均匀',()=>{
        const text='保持根部露出水面。',result=layout(text,8,3,measure,1);
        expect(result.lines).toEqual(['保持根部','露出水面。']);expect(result.fontSize).toBe(1);expect(result.lineHeight).toBe(1.18);
        expect(result.lines.join('')).toBe(text);expect(result.lines.every(line=>measure(line,1)<=8)).toBe(true);
    });
    it('沿用词界和标点归属，不为了行宽均匀拆开本来能放下的单词',()=>{
        expect(layout('中）HELLO（文',5,10,measure,1).lines).toEqual(['中）','HELLO','（文']);
        expect(layout('LONG A',4,3,measure,1).lines).toEqual(['LONG','A']);
        expect(layout('AAA BB C',6,3,measure,1).lines).toEqual(['AAA','BB C']);
        expect(layout('ABCDEFGH',7,3,measure,1).lines).toEqual(['ABCDEFG','H']);
    });
    it('保留组合字符、变体选择符和表情的原字素',()=>{
        const text='甲𠀀\u{E0100}乙e\u0301👨‍👩‍👧‍👦丙丁戊。';
        const result=layout(text,7,4,measure,1);
        expect(result.lines.flatMap(units)).toEqual(units(text));expect(result.fontSize).toBe(1);
        expect(result.lines.slice(1).every(line=>!/^。/u.test(line))).toBe(true);
    });
    it('作者换行、单行与已经均匀的文字保持原布局',()=>{
        expect(layout('保持根部\n露出水面。',8,4,measure,1).lines).toEqual(['保持根部','露出水面。']);
        expect(layout('甲乙丙',8,4,measure,1).lines).toEqual(['甲乙丙']);
        expect(layout('甲乙丙丁戊己',3,4,measure,1).lines).toEqual(['甲乙丙','丁戊己']);
    });
    it('词组超过可用宽度或旧环境没有词分割器时保持原排版',async()=>{
        expect(layout('甲乙丙丁',3,5,measure,1).lines).toEqual(['甲乙丙','丁']);
        vi.stubGlobal('Intl',{Segmenter:undefined});
        const {layoutImageTranslationText:legacy}=await import('@/src/features/image-translation/services/rendering');
        expect(legacy('保持根部露出水面。',8,3,measure,1).lines).toEqual(['保持根部露出水','面。']);
    });
    it('超过四行、1024个UTF16单元或128个词界的正文不触发平衡',()=>{
        expect(layout('甲'.repeat(11),2,20,measure,1).lines.map(line=>line.length)).toEqual([2,2,2,2,2,1]);
        expect(layout('a'.repeat(1025),1000,10,measure,1).lines.map(line=>line.length)).toEqual([1000,25]);
        expect(layout('甲'.repeat(129),120,10,measure,1).lines.map(line=>line.length)).toEqual([120,9]);
    });
    it.each(['tall','missing'] as const)('候选字形指标 %s 时保留已经完整适配的排版',kind=>{
        const result=layout('甲乙丙丁戊己庚辛壬',8,3,measure,1,text=>{
            const changed=text.length>1&&text.length<8;
            return changed?(kind==='tall'?{ascent:4,descent:4}:{ascent:NaN,descent:NaN}):{ascent:.6,descent:.4};
        });
        expect(result.lines).toEqual(['甲乙丙丁戊己庚辛','壬']);expect(result.ink?.height).toBeCloseTo(2.18);
    });
    it('零宽与缺失的测宽数据不驱动额外重排',()=>{
        const zeroTail=(text:string,size:number)=>text==='乙'?0:measure(text,size);
        expect(layout('甲甲甲甲乙',4,4,zeroTail,1).lines).toEqual(['甲甲甲甲','乙']);
        const invalid=layout('甲乙丙',1,4,()=>NaN,1);
        expect(invalid.lines.join('')).toBe('甲乙丙');
    });
    it('有限短段落重用测宽，不把平衡放进字号搜索的每一轮',()=>{
        const counted=vi.fn(measure),result=layout('流畅阅读：看懂每一页漫画',5,3.6,counted,1);
        expect(result.lines.join('')).toBe('流畅阅读：看懂每一页漫画');expect(result.lines.length).toBe(3);
        expect(counted.mock.calls.length).toBeLessThan(130);
    });
});
