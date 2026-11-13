/** Generate the pinned Unicode 17 line-edge subset offline; no runtime/network dependency. */
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
const input=new URL('../tests/fixtures/unicode-17.0.0/LineBreak.txt',import.meta.url),output=new URL('../src/features/image-translation/linePunctuationData.ts',import.meta.url);
const sha256='e6a18fa91f8f6a6f8e534b1d3f128c21ada45bfe152eb6b1bcc5e15fd8ac92e6',raw=readFileSync(input);
if(createHash('sha256').update(raw).digest('hex')!==sha256)throw Error('Unexpected Unicode 17 line-break input');
const closing=new Set(['CL','CP','EX','IS','SY','IN','NS','CJ']),ranges=[];
for(const line of raw.toString().split('\n')){
 const match=/^([0-9A-F]+)(?:\.\.([0-9A-F]+))?\s*;\s*(\w+)\s*#\s*(\w+)/.exec(line);if(!match)continue;
 const [,first,last,property,category]=match,kind=property==='OP'||property==='QU'&&category==='Pi'?1:closing.has(property)||property==='QU'&&category==='Pf'?2:0;
 if(kind)ranges.push([parseInt(first,16),parseInt(last||first,16),kind]);
}
ranges.sort((a,b)=>a[0]-b[0]);const merged=[];
for(const [first,last,kind]of ranges){const previous=merged.at(-1);if(previous&&previous[2]===kind&&previous[1]+1===first)previous[1]=last;else merged.push([first,last,kind]);}
const rows=merged.map(([a,b,k])=>`0x${a.toString(16)}, 0x${b.toString(16)}, ${k}`),lines=[];for(let i=0;i<rows.length;i+=3)lines.push('    '+rows.slice(i,i+3).join(', ')+',');
const generated=`/**
 * @file src/features/image-translation/linePunctuationData.ts
 * 文件职责：提供普通图片排版使用的固定Unicode17开闭标点及行首禁排属性。
 * 主要内容：OP和类别Pi的QU归为开标点；CL/CP/EX/IS/SY/IN/NS/CJ和类别Pf的QU归为后附字符。CJ按默认严格日文行首规则处理；含义不明的直引号不附会方向。
 * 模块边界：仅返回实际码点的行缘类别，不实现完整UAX14、不推断词语或改动原文，实际分行仍须守住字素与显式换行。
 * 数据来源：https://www.unicode.org/Public/17.0.0/ucd/LineBreak.txt
 * SHA-256：${sha256}
 * Copyright © 2025 Unicode, Inc.；Unicode License V3见public/third-party-notices/unicode-17.0.0.txt。
 * 由scripts/generate-image-line-punctuation-data.mjs离线生成，请勿手动编辑区间。
 */
// ${merged.length} merged ranges, triples: start/end/kind (1 opening, 2 following).
const RANGES:readonly number[]=[
${lines.join('\n')}
];
/** 仅查询调用方从正文取得的真实Unicode码点。 */
export function imageLinePunctuationKind(point:number):0|1|2 {
    let left=0,right=RANGES.length/3-1;
    while(left<=right){
        const middle=(left+right)>>>1,index=middle*3;
        if(point<RANGES[index])right=middle-1;
        else if(point>RANGES[index+1])left=middle+1;
        else return RANGES[index+2] as 1|2;
    }
    return 0;
}
`;
if(process.argv.includes('--check')){if(readFileSync(output,'utf8')!==generated)throw Error('Image punctuation data is out of date');console.log('Unicode 17 image punctuation data matches pinned input.');}
else{writeFileSync(output,generated);console.log(`Generated ${merged.length} punctuation ranges.`);}
