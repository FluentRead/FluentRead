import {describe, expect, it} from 'vitest';
import {formatMaterialTopics, parseMaterialTopics} from '@/src/features/vocabulary/materialTopicsInput';

describe('material topic input',()=>{
    it('round trips commas, quotes, whitespace and legacy empty topics',()=>{
        const topics=['设计','A, B','甲，乙','a"b','  legacy  ',''];
        expect(parseMaterialTopics(formatMaterialTopics(topics))).toEqual(topics);
    });
    it('accepts ordinary Chinese and English delimiters and ignores accidental empty separators',()=>{
        expect(parseMaterialTopics('设计, 语言， , 工程')).toEqual(['设计','语言','工程']);
        expect(parseMaterialTopics('  ')).toEqual([]);
    });
    it('rejects incomplete quoting rather than silently splitting a saved topic',()=>{
        expect(()=>parseMaterialTopics('"unfinished')).toThrow('引号未闭合');
        expect(()=>parseMaterialTopics('"one" next')).toThrow('逗号分隔');
    });
});
