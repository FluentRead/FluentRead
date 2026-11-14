/** @file tests/imageTextPunctuation.test.ts 普通图片行缘约束、Unicode17全码点数据与原生缺失Segmenter回退的文本完整性。 */
import {describe,it,expect,vi,afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {bindImageTextPunctuation as bind} from '@/src/features/image-translation/services/imageTextPunctuation';
import {imageLinePunctuationKind as kind} from '@/src/features/image-translation/linePunctuationData';
import {layoutImageTranslationText as layout} from '@/src/features/image-translation/services/rendering';
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
const split=(text:string)=>Array.from(segmenter.segment(text),x=>x.segment);
const measure=(text:string,size:number)=>split(text).length*size;
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
describe('原词界上的标点归属',()=>{
    it('句末符号连前字，开括号连后字，连续标点不成孤行',()=>{
        expect(bind(['保','持','水','面','。'],split)).toEqual(['保','持','水','面。']);
        expect(bind(['中','「','文','字','」','。'],split)).toEqual(['中','「文','字」。']);
        expect(bind(['A',null,'(',null,'B',')',null,'。'],split)).toEqual(['A',' ','( B) 。']);
        expect(bind(['(',')','X'],split)).toEqual(['()','X']);
        expect(bind(['()','X'],split)).toEqual(['()','X']);
    });
    it('词缘拆分保留相邻英文单词及原有内部小数、网址和撇号',()=>{
        expect(bind(['中','）HELLO','（','文'],split)).toEqual(['中）','HELLO','（文']);
        expect(bind(['HELLO（','文'],split)).toEqual(['HELLO','（文']);
        expect(bind(['中','）NEXT（','文'],split)).toEqual(['中）','NEXT','（文']);
        for(const text of ['12.34','https://example.test/a','l’année','hello(world)'])expect(bind([text],split)).toEqual([text]);
        expect(bind(['Look',null,'’tis',null,'cold'],split)).toEqual(['Look',' ','’tis',' ','cold']);
    });
    it('日文小假名与长音、半角句读和阿拉伯句末符号保持归属',()=>{
        expect(bind(['き','ゃ','く','。'],split)).toEqual(['きゃ','く。']);expect(bind(['ｶ','ｰ','｡'],split)).toEqual(['ｶｰ｡']);
        expect(bind(['كلمة','؟'],split)).toEqual(['كلمة؟']);expect(bind(['Hello','！','！'],split)).toEqual(['Hello！！']);
    });
    it('装饰符与Prepend不被当成新的字素断点，复杂未知词组不猜拆分',()=>{
        expect(bind(['字','）\u0301NEXT'],split)).toEqual(['字）\u0301','NEXT']);
        expect(bind(['字','\u0600）NEXT'],split)).toEqual(['字\u0600）','NEXT']);
        expect(bind(['HELLO（\u{E0100}','文'],split)).toEqual(['HELLO','（\u{E0100}文']);
        expect(bind(['字','）\u0301NEXT'],()=>undefined)).toEqual(['字','）\u0301NEXT']);
        expect(bind(['\u0301','x'],split)).toEqual(['\u0301','x']);
        expect(bind(['x','😀'],split)).toEqual(['x','😀']);
        expect(bind(['x','\udc00'],split)).toEqual(['x','\udc00']);
    });
    it('显式段首闭符号和段末开符号按作者保留，未知直引号不假定方向',()=>{
        expect(bind(['。','字','（'],split)).toEqual(['。','字','（']);expect(bind([null,'。'],split)).toEqual([' ','。']);
        expect(bind(['"','word','"'],split)).toEqual(['"','word','"']);expect(bind(['(',null],split)).toEqual(['( ']);
    });
});
describe('字体搜索中继续遵守行缘约束',()=>{
    it('原生问题的比例模型保留字号与全文，将句号带到前字之后',()=>{
        const text='保持根部露出水面。',result=layout(text,8,3,measure,1);
        expect(result.lines).toEqual(['保持根部露出水','面。']);expect(result.fontSize).toBe(1);expect(result.lines.join('')).toBe(text);
    });
    it.each(['甲乙。','甲「乙丙」。','甲（乙丙）','甲きゃく。','甲𠀀\u{E0100}。','甲👨‍👩‍👧‍👦！','甲\u0600）。'])('窄框完整保留 %s 的字素与行缘约束',text=>{
        const result=layout(text,2,20,measure,1);expect(result.lines.join('')).toBe(text);expect(result.lines.every(x=>measure(x,result.fontSize)<=2)).toBe(true);
        for(const line of result.lines.slice(1))expect(kind(line.codePointAt(0)!)).not.toBe(2);
        for(const line of result.lines.slice(0,-1))expect(/[（「]$/u.test(line)).toBe(false);
        expect(result.lines.flatMap(split)).toEqual(split(text));
    });
    it('闭符号跨普通空格不因长词拆分再次孤立，超窄框缩小完整单位',()=>{
        const result=layout('WORD :',3,20,measure,1);expect(result.lines.join('')).toBe('WORD :');expect(result.lines.every(x=>!/^\s*:/u.test(x))).toBe(true);
        const small=layout('字。',1,4,measure,1);expect(small.lines).toEqual(['字。']);expect(small.fontSize).toBeLessThanOrEqual(.5);
    });
    it('强制换行、空行和原段首符号不跨段绑定',()=>{
        expect(layout('甲\n。\n\n（\n乙',20,20,measure,1).lines).toEqual(['甲','。','','（','乙']);
        expect(layout('中）HELLO（文',5,10,measure,1).lines).toEqual(['中）','HELLO','（文']);
    });
    it('旧环境处理简单标点，复杂词组保持原有整体缩小回退',async()=>{
        vi.stubGlobal('Intl',{Segmenter:undefined});const {layoutImageTranslationText:legacy}=await import('@/src/features/image-translation/services/rendering');
        expect(legacy('保持水面。',4,4,measure,1).lines).toEqual(['保持水','面。']);
        expect(legacy('中）HELLO（文',5,10,measure,1).lines).toEqual(['中）','HELLO','（文']);
        for(const text of ['中）\u0301HELLO','👨‍👩‍👧‍👦。','\u0600（文']){const result=legacy(text,1,30,measure,1);expect(result.lines).toEqual([text]);expect(measure(text,result.fontSize)).toBeLessThanOrEqual(1);}
    });
});
it('生成表覆盖固定Unicode17的全部所选属性码点，原文件和离线生成均可复核',()=>{
    const file=new URL('./fixtures/unicode-17.0.0/LineBreak.txt',import.meta.url),bytes=readFileSync(file);expect(createHash('sha256').update(bytes).digest('hex')).toBe('e6a18fa91f8f6a6f8e534b1d3f128c21ada45bfe152eb6b1bcc5e15fd8ac92e6');
    const expected=new Uint8Array(0x110000),closing=['CL','CP','EX','IS','SY','IN','NS','CJ'];let opens=0,closes=0;
    for(const line of bytes.toString().split('\n')){
        const match=/^([A-F0-9]+)(?:\.\.([A-F0-9]+))?\s*;\s*(\w+)\s*#\s*(\w+)/u.exec(line);if(!match)continue;
        const [,a,b,property,category]=match;let value=0;if(property==='OP'||property==='QU'&&category==='Pi')value=1;else if(closing.includes(property)||property==='QU'&&category==='Pf')value=2;
        expected.fill(value,parseInt(a,16),parseInt(b||a,16)+1);
    }
    const mismatches:number[]=[];for(let point=0;point<expected.length;point++){if(kind(point)!==expected[point])mismatches.push(point);if(expected[point]===1)opens++;if(expected[point]===2)closes++;}
    expect(mismatches).toEqual([]);expect(opens).toBeGreaterThan(95);expect(closes).toBeGreaterThan(254);
    expect(execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/generate-image-line-punctuation-data.mjs',import.meta.url)),'--check'],{encoding:'utf8'})).toContain('matches pinned input');
});
