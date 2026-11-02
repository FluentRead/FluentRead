import {describe,expect,it} from 'vitest';
import {rewriteMangaOnnxFields,type MangaOnnxFieldRecipe} from '@/src/features/image-translation/services/mangaOnnxFields';
import {concat,field,scalar,model} from './helpers/mangaOnnxFixture';
const removed=field(1,new Uint8Array([2,3])),kept=field(5,new Uint8Array([7,8,9])),added=field(5,new Uint8Array([4,5]));
const recipe=(changes:Partial<MangaOnnxFieldRecipe>={}):MangaOnnxFieldRecipe=>({requiredModelFields:[scalar(1,6)],graphCounts:{1:1,5:1},remove:[{name:'shape',bytes:removed}],append:[added],...changes});
describe('已验证模型的有界 protobuf 原片段改写',()=>{
    it('只删除指定完整字段、追加常量，保留未知字段与前后元数据的原字节',()=>{
        const graph=concat(removed,kept,scalar(20,1000),new Uint8Array([0xa9,1,1,2,3,4,5,6,7,8]),new Uint8Array([0xb5,1,9,8,7,6]));
        const suffix=scalar(19,21),source=model(graph,suffix),before=source.slice();
        const actual=rewriteMangaOnnxFields(source.buffer,recipe());
        expect(new Uint8Array(actual)).toEqual(model(concat(kept,graph.subarray(removed.length+kept.length),added),suffix));
        expect(source).toEqual(before);expect(actual).not.toBe(source.buffer);
    });
    it('图长度跨 varint 边界仍保留实际完整 body；无追加或无删除也有效',()=>{
        const long=field(5,new Uint8Array(160).fill(3));
        const source=model(concat(removed,long)),plan=recipe({remove:[{name:'long',bytes:long}],append:[],graphCounts:{1:1,5:1}});
        expect(new Uint8Array(rewriteMangaOnnxFields(source.buffer,plan))).toEqual(model(removed));
        const noChange=recipe({remove:[],append:[],graphCounts:{1:1,5:1}});
        expect(new Uint8Array(rewriteMangaOnnxFields(source.buffer,noChange))).toEqual(source);
    });
    it('未知 uint64 标量原字节可保留，不用JS number解释负数/高位',()=>{
        const uint64=concat(new Uint8Array([0x98,1]),new Uint8Array(9).fill(255),new Uint8Array([1]));
        const actual=rewriteMangaOnnxFields(model(concat(removed,kept,uint64)).buffer,recipe());
        expect(new Uint8Array(actual)).toEqual(model(concat(kept,uint64,added)));
    });
    it.each([
        new Uint8Array([]),new Uint8Array(32*1024*1024+1),new Uint8Array([0]),new Uint8Array([0x80]),
        new Uint8Array([0xff,0xff,0xff,0xff,0x10]),new Uint8Array([0x3a]),new Uint8Array([0x3a,0x80]),
        new Uint8Array([0x3a,0xff,0xff,0xff,0xff,0x0f]),new Uint8Array([0x0b]),new Uint8Array([0x0c]),
        new Uint8Array([0x09,1]),new Uint8Array([0x0d,1]),new Uint8Array([0x08]),
        concat(new Uint8Array([0x08]),new Uint8Array(10).fill(255)),
    ])('损坏/超限wire显式失败且不产生部分模型 %#',bytes=>{
        expect(()=>rewriteMangaOnnxFields(bytes.buffer,recipe())).toThrow('漫画识别模型');
    });
    it.each([
        scalar(1,6),concat(scalar(1,6),field(7,removed),field(7,kept)),concat(scalar(1,6),scalar(7,1)),
        concat(scalar(1,6),scalar(1,6),field(7,concat(removed,kept))),model(kept),model(concat(removed,removed,kept)),
        model(concat(field(1,new Uint8Array([2,4])),kept)),
    ])('图/元数据/精确待删字段缺失或重复时拒绝 %#',bytes=>{
        expect(()=>rewriteMangaOnnxFields(bytes.buffer,recipe())).toThrow('配方不匹配');
    });
    it('同字段不能重复删除，命中长度相同但不同字节不能冒充固定字段',()=>{
        const bytes=model(concat(removed,kept));
        expect(()=>rewriteMangaOnnxFields(bytes.buffer,recipe({remove:[{name:'one',bytes:removed},{name:'two',bytes:removed}]}))).toThrow('配方');
        expect(()=>rewriteMangaOnnxFields(bytes.buffer,recipe({remove:[{name:'wrong',bytes:field(1,new Uint8Array([2,4]))}]}))).toThrow('配方');
    });
    it('顶层和图字段都有固定数量上限，不能按声明长度分配无界片段',()=>{
        expect(()=>rewriteMangaOnnxFields(concat(...Array(2049).fill(scalar(1,1))).buffer,recipe())).toThrow('配方');
        expect(()=>rewriteMangaOnnxFields(model(concat(...Array(2049).fill(scalar(1,1)))).buffer,recipe())).toThrow('配方');
    });
});
