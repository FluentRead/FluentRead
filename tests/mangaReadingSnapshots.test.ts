import {describe, expect, it} from 'vitest';
import {createMangaReadingKeyAllocator, createMangaReadingSnapshots, prepareMangaReadingLines, type MangaReadingLine} from '@/src/features/image-translation/content/mangaReadingSnapshots';

const line = (text = '译文'): MangaReadingLine => ({text, sourceText:'Original', backgroundColor:'transparent', bbox:{x0:1,y0:2,x1:20,y1:30}});

describe('漫画按需阅读的有界临时文字持有', () => {
    it('新身份跨存储实例单调递增；超限新内容不能读到旧身份的文字', () => {
        const a=createMangaReadingSnapshots(), b=createMangaReadingSnapshots({maxBytes:256});
        const first=a.allocateKey()!, second=b.allocateKey()!, third=a.allocateKey()!;
        expect(first).toBeGreaterThan(0);expect(second).toBe(first+1);expect(third).toBe(second+1);
        expect(b.put(second,[line('旧页')])).toBe('stored');expect(b.put(third,[line('新'.repeat(500))])).toBe('overBudget');
        expect(b.get(third)).toBeUndefined();expect(b.get(second)?.[0].text).toBe('旧页');
    });
    it('身份耗尽或输入非法时显式拒绝，不回绕', () => {
        const allocate=createMangaReadingKeyAllocator(Number.MAX_SAFE_INTEGER-1);
        expect(allocate()).toBe(Number.MAX_SAFE_INTEGER);expect(allocate()).toBeUndefined();expect(allocate()).toBeUndefined();
        for(const value of [Number.MAX_SAFE_INTEGER+1, -1, 1.5, NaN, Infinity])
            expect(()=>createMangaReadingKeyAllocator(value)).toThrow();
    });
    it('已有缓存可只验证并复制当前页，不新增驻留；拒绝超限且不截断', () => {
        const existing=[line('第一段'),line('第二段')];
        const result=prepareMangaReadingLines(existing,{maxLines:2,maxBytes:4096});
        expect(result.status).toBe('ready');
        if (result.status !== 'ready') throw new Error('快照未准备');
        expect(result.lines).toEqual(existing);result.lines[0].bbox.x0=99;expect(existing[0].bbox.x0).toBe(1);
        expect(prepareMangaReadingLines(existing,{maxLines:1})).toEqual({status:'overBudget'});
        expect(prepareMangaReadingLines(existing,{maxBytes:1})).toEqual({status:'overBudget'});
        expect(prepareMangaReadingLines(null)).toEqual({status:'invalid'});
    });
    it('写入和读取都复制文本与坐标，调用方修改不能污染缓存', () => {
        const cache=createMangaReadingSnapshots();const input=[line()];
        expect(cache.put(1,input)).toBe('stored');input[0].text='mutated';input[0].bbox.x0=99;
        const first=cache.get(1)!;expect(first[0]).toEqual(line());first[0].bbox.x1=999;first[0].text='changed';first.push(line());
        expect(cache.get(1)).toEqual([line()]);
    });
    it('按条数与字节逐出最久未访问项，读取会更新访问顺序', () => {
        const cache=createMangaReadingSnapshots({maxEntries:2,maxBytes:4096,maxLines:4});
        expect(cache.put(1,[line('one')])).toBe('stored');expect(cache.put(2,[line('two')])).toBe('stored');
        expect(cache.get(1)?.[0].text).toBe('one');expect(cache.put(3,[line('three')])).toBe('stored');
        expect(cache.get(2)).toBeUndefined();expect(cache.get(1)?.[0].text).toBe('one');expect(cache.get(3)?.[0].text).toBe('three');
        expect(cache.stats().entries).toBe(2);
    });
    it('未达到条数上限时仍按字节预算淘汰，保留最近访问的文字', () => {
        const cache=createMangaReadingSnapshots({maxEntries:3,maxBytes:399,maxLines:4});
        expect(cache.put(1,[line('a')])).toBe('stored');expect(cache.put(2,[line('b')])).toBe('stored');
        expect(cache.get(1)).toBeUndefined();expect(cache.get(2)?.[0].text).toBe('b');expect(cache.stats().bytes).toBeLessThanOrEqual(399);
    });
    it('超出总预算或行数时不截断，不覆盖旧值且不改变原有 LRU 顺序', () => {
        const cache=createMangaReadingSnapshots({maxEntries:2,maxBytes:512,maxLines:1});
        expect(cache.put(1,[line('a')])).toBe('stored');expect(cache.put(2,[line('b')])).toBe('stored');const before=cache.stats();
        expect(cache.put(1,[line('x'.repeat(1000))])).toBe('overBudget');expect(cache.put(1,[line('a'),line('b')])).toBe('overBudget');
        expect(cache.stats()).toEqual(before);expect(cache.put(3,[line('c')])).toBe('stored');
        expect(cache.get(1)).toBeUndefined();expect(cache.get(2)?.[0].text).toBe('b');
    });
    it('字节预算按 UTF-16 计入所有文本字段并在替换、删除和清空时释放', () => {
        const cache=createMangaReadingSnapshots({maxEntries:3,maxBytes:4096,maxLines:4});
        expect(cache.put(1,[line('a')])).toBe('stored');const one=cache.stats().bytes;
        expect(cache.put(1,[line('a🦊')])).toBe('stored');expect(cache.stats().bytes).toBe(one+4);
        expect(cache.put(2,[line('b')])).toBe('stored');cache.remove(1);cache.remove(99);
        expect(cache.stats()).toEqual({entries:1,bytes:one});cache.clear();expect(cache.stats()).toEqual({entries:0,bytes:0});
    });
    it('接受非整数 OCR 坐标与竖排但不保存未声明的附加数据', () => {
        const cache=createMangaReadingSnapshots();const data={...line(),bbox:{x0:.5,y0:1,x1:2.25,y1:3},vertical:true as const, extra:'ignored'};
        expect(cache.put(1,[data])).toBe('stored');expect(cache.get(1)).toEqual([{...line(),bbox:data.bbox,vertical:true}]);
        const bare={text:'原文',bbox:{x0:1,y0:2,x1:3,y1:4}};
        expect(cache.put(2,[bare])).toBe('stored');expect(cache.get(2)).toEqual([bare]);
    });
    it.each([
        null, {}, [null], [{...line(),text:3}], [{...line(),sourceText:3}], [{...line(),backgroundColor:3}],
        [{...line(),bbox:null}], [{...line(),bbox:{x0:-1,y0:0,x1:2,y1:2}}], [{...line(),bbox:{x0:0,y0:0,x1:Infinity,y1:2}}],
        [{...line(),bbox:{x0:0,y0:0,x1:0,y1:2}}], [{...line(),vertical:false}],
    ])('拒绝无效结果而不替换旧值：%j', input => {
        const cache=createMangaReadingSnapshots();expect(cache.put(1,[line()])).toBe('stored');const before=cache.stats();
        expect(cache.put(1,input as never)).toBe('invalid');expect(cache.stats()).toEqual(before);expect(cache.get(1)).toEqual([line()]);
    });
    it('拒绝非法 key 和不合法预算，零容量安全关闭', () => {
        const cache=createMangaReadingSnapshots({maxEntries:0,maxBytes:0,maxLines:0});
        expect(cache.put(1,[line()])).toBe('overBudget');expect(cache.get(1)).toBeUndefined();expect(cache.put(-1,[line()])).toBe('invalid');expect(cache.get(-1)).toBeUndefined();
        expect(createMangaReadingSnapshots({maxBytes:0}).put(1,[])).toBe('overBudget');
        for(const key of [0,1.1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) expect(cache.put(key,[line()])).toBe('invalid');
        for(const opts of [{maxEntries:-1},{maxBytes:NaN},{maxLines:1.5},{maxEntries:Infinity},
            {maxEntries:65},{maxBytes:1024*1024+1},{maxLines:513}]) expect(()=>createMangaReadingSnapshots(opts)).toThrow();
    });
    it('读取行数据抛错时拒绝新值，既有内容和预算仍可用', () => {
        const cache=createMangaReadingSnapshots();expect(cache.put(1,[line()])).toBe('stored');const before=cache.stats();
        const invalid={...line(),get sourceText():string {throw new Error('bad OCR data');}};
        expect(cache.put(1,[invalid])).toBe('invalid');expect(cache.stats()).toEqual(before);expect(cache.get(1)).toEqual([line()]);
    });
    it('允许空结果明确区别于未命中；空结果也占预算且可释放', () => {
        const cache=createMangaReadingSnapshots();expect(cache.put(1,[])).toBe('stored');
        expect(cache.get(1)).toEqual([]);expect(cache.get(2)).toBeUndefined();expect(cache.stats().bytes).toBeGreaterThan(0);
        cache.remove(1);expect(cache.stats()).toEqual({entries:0,bytes:0});
    });
});
