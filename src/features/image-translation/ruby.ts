/**
 * @file src/features/image-translation/ruby.ts
 * 文件职责：在图片文字合段前，将明确附属于汉字正文的日文读音归入其物理源行。
 * 主要内容：仅接受上方横排或右侧竖排、明显较小、范围对齐且唯一归属的短假名；检查中间文字遮挡并限制整页比较预算。公开同一归属判定供气泡分组使用；保留注音原文、原字高和逐框擦除范围，正文语义不重复加入读音，合段可使用包含注音的占用范围但仍沿用正文字号。
 * 模块边界：纯几何和文字分类，不猜测读音、不修改输入、不调用 OCR 或翻译；歧义、已合段、数字保护及超预算输入保持原状。
 */
import type {OcrLine} from '@/src/shared/image/types';
import {numericProtection} from './services/mangaNumeric';

interface RubyRegion extends OcrLine {guardOnly?:true}
const kana=/^[\p{Script=Hiragana}\p{Script=Katakana}ー]{1,8}$/u;
const sameBox=(a:OcrLine['bbox'],b:OcrLine['bbox'])=>a.x0===b.x0&&a.y0===b.y0&&a.x1===b.x1&&a.y1===b.y1;
const intersects=(a:OcrLine['bbox'],b:OcrLine['bbox'])=>a.x0<b.x1&&a.x1>b.x0&&a.y0<b.y1&&a.y1>b.y0;

function physical(line:RubyRegion):boolean {
    const b=line.bbox;
    return !line.guardOnly&&!line.ruby?.length&&[b.x0,b.y0,b.x1,b.y1].every(Number.isFinite)
        &&b.x1>b.x0&&b.y1>b.y0&&(!line.sourceBoxes||(line.sourceBoxes.length===1&&sameBox(line.sourceBoxes[0],b)));
}

/** 桥接范围仅覆盖注音所在的局部，不把整条正文旁边的其他标签误作遮挡。 */
function bridge(main:RubyRegion,ruby:RubyRegion):OcrLine['bbox']|undefined {
    const a=main.bbox,b=ruby.bbox,vertical=main.vertical;
    const size=vertical?a.x1-a.x0:a.y1-a.y0,small=vertical?b.x1-b.x0:b.y1-b.y0;
    if(small<size*.18||small>size*.62)return;
    const gap=vertical?b.x0-a.x1:a.y0-b.y1;
    if(gap<-size*.1||gap>size*.5)return;
    const start=vertical?b.y0:b.x0,end=vertical?b.y1:b.x1;
    const mainStart=vertical?a.y0:a.x0,mainEnd=vertical?a.y1:a.x1;
    if(start<mainStart-size*.25||end>mainEnd+size*.25||end-start<small*.7)return;
    return vertical?{x0:Math.min(a.x1,b.x0),y0:start,x1:b.x1,y1:end}
        :{x0:start,y0:b.y0,x1:end,y1:Math.max(a.y0,b.y1)};
}

/** 返回原始注音和正文的唯一关联，调用方不能把它当成跨气泡或扩大擦除范围的授权。 */
export function findImageRubyOwners<T extends RubyRegion>(input:T[]):Map<T,T> {
    const mains=input.filter(line=>physical(line)&&/\p{Script=Han}/u.test(line.text)&&!numericProtection(line.text));
    const annotations=input.filter(line=>physical(line)&&kana.test(line.text.normalize('NFKC').replace(/\s+/gu,'')));
    const owners=new Map<T,T>();
    if(annotations.length*(mains.length+input.length)>1_000_000)return owners;
    for(const ruby of annotations){
        let owner:T|undefined,area:OcrLine['bbox']|undefined,ambiguous=false;
        for(const main of mains){
            const candidate=bridge(main,ruby);if(!candidate)continue;
            if(owner){ambiguous=true;break;}
            owner=main;area=candidate;
        }
        if(!owner||ambiguous||input.some(other=>other!==owner&&other!==ruby&&intersects(other.bbox,area!)))continue;
        owners.set(ruby,owner);
    }
    return owners;
}

/** physical 标记只允许本次附着后的单个正文继续合段，不能放开任意已有 sourceBoxes。 */
export function attachImageRuby<T extends RubyRegion>(input:T[]):{lines:T[];physical:Set<T>} {
    const attached=new Map<T,T[]>(),removed=new Set<T>(),single=new Set<T>();
    for(const [ruby,owner] of findImageRubyOwners(input)){
        const values=attached.get(owner)??[];values.push(ruby);attached.set(owner,values);removed.add(ruby);
    }
    if(!removed.size)return {lines:input,physical:single};
    const lines=input.flatMap(line=>{
        if(removed.has(line))return [];
        const values=attached.get(line);if(!values)return [line];
        const b=line.bbox,boxes=[b,...values.map(value=>value.bbox)];
        const result={...line,fontSize:line.fontSize??(line.vertical?b.x1-b.x0:b.y1-b.y0),
            bbox:boxes.reduce((a,b)=>({x0:Math.min(a.x0,b.x0),y0:Math.min(a.y0,b.y0),x1:Math.max(a.x1,b.x1),y1:Math.max(a.y1,b.y1)})),
            sourceBoxes:boxes.map(box=>({...box})),ruby:values.map(value=>({text:value.text,bbox:{...value.bbox},
                fontSize:Number.isFinite(value.fontSize)&&value.fontSize!>0?value.fontSize!:line.vertical?value.bbox.x1-value.bbox.x0:value.bbox.y1-value.bbox.y0}))};
        single.add(result);return [result];
    });
    return {lines,physical:single};
}
