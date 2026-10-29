/**
 * @file tests/materialSummaryValidation.test.ts
 * 文件职责：验证分页协议中的材料摘要字段边界。
 * 主要内容：覆盖有效原值、长主机标题、空历史主题以及无效字段与重复主题。
 * 模块边界：只测试纯数据校验；端口完整性和分页版本另由集成测试验证。
 */
import {describe, expect, it} from 'vitest';
import {parseMaterialSummary} from '@/src/features/vocabulary/materialSummaryValidation';

const summary = () => ({id:'id',kind:'article',title:'Title',sourceUrl:'https://example.test/',topics:['主题'],
    lastReadAt:10,updatedAt:20,archivedAt:null,preview:'😀 原文',referenceCount:2});

describe('material summary validation',()=>{
    it('retains valid Unicode, historical empty topics, long host titles and exact optional fields',()=>{
        const value={...summary(),title:'a'.repeat(300),topics:['','主题'],archivedAt:42};
        expect(parseMaterialSummary(value)).toEqual(value);
        const {sourceUrl: _sourceUrl,...withoutSource}=value;
        expect(parseMaterialSummary(withoutSource)).toEqual(withoutSource);
        expect(parseMaterialSummary({...value,sourceUrl:'',preview:'',referenceCount:0})).toMatchObject({sourceUrl:'',preview:'',referenceCount:0});
    });
    it('accepts valid maximum sizes without truncating the values',()=>{
        const value={...summary(),id:'i'.repeat(256),title:'a'.repeat(8192*16+16),sourceUrl:'u'.repeat(8192*16+16),
            topics:Array.from({length:30},(_,i)=>`${i}`.padEnd(80,'x')),preview:'x'.repeat(12000),referenceCount:1000};
        expect(parseMaterialSummary(value)).toEqual(value);
    });
    it('rejects invalid object shapes, fields and duplicate topics',()=>{
        const base=summary();
        const missing=Object.fromEntries(Object.entries(base).filter(([key])=>key!=='id'));
        const values:unknown[]=[null,[],0,'text',missing,{...base,extra:'private'},
            {...base,id:''},{...base,id:'x'.repeat(257)},{...base,kind:'other'},
            {...base,title:''},{...base,title:'x'.repeat(8192*16+17)},
            {...base,sourceUrl:123},{...base,sourceUrl:'x'.repeat(8192*16+17)},
            {...base,topics:'bad'},{...base,topics:Array.from({length:31},(_,i)=>String(i))},
            {...base,topics:['x','x']},{...base,topics:[123]},{...base,topics:['x'.repeat(81)]},
            {...base,lastReadAt:-1},{...base,updatedAt:NaN},{...base,archivedAt:-1},{...base,archivedAt:'bad'},
            {...base,preview:'x'.repeat(12001)},{...base,preview:null},
            {...base,referenceCount:-1},{...base,referenceCount:1001},{...base,referenceCount:1.5}];
        for (const value of values) expect(()=>parseMaterialSummary(value)).toThrow('Invalid material summary');
    });
});
