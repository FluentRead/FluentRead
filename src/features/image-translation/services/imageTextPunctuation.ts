/**
 * @file src/features/image-translation/services/imageTextPunctuation.ts
 * 文件职责：在普通图片的既有词界和字素边界上绑定开闭标点，避免自动换行留下孤立标点或日文行首禁排字符。
 * 主要内容：按固定Unicode17子集提取词首闭标点、词尾开标点，保留内部小数/网址/撇号和完整邻接单词；装饰标记与Prepend始终随原字素移动，无法证明可拆的旧环境词组保持整体。开标点连后文、闭标点连前文，空白按调用方的单空格语义保留。
 * 模块边界：只处理一个显式段落的已验证token；不测量、不改字、不做完整UAX14或字典分词。长词分割后也须再次调用，不能在字体适配时破坏约束。
 */
import {imageLinePunctuationKind as kind} from '../linePunctuationData';
import {isSpaceGraphemeExtension,isSpaceGraphemePrepend} from '../graphemeSpaceData';
type Token=string|null;
const decoration=(point:number)=>isSpaceGraphemeExtension(point)||isSpaceGraphemePrepend(point);
function tokenKind(token:string):0|1|2 {
    let value:0|1|2=0;
    for(const character of token){
        const point=character.codePointAt(0)!;if(decoration(point))continue;
        const next=kind(point);if(!next||value&&value!==next)return 0;value=next;
    }
    return value;
}
function lastPoint(token:string):number {
    const last=token.charCodeAt(token.length-1),before=token.charCodeAt(token.length-2);
    return last>=0xdc00&&last<=0xdfff&&before>=0xd800&&before<=0xdbff?token.codePointAt(token.length-2)!:last;
}

/** split仅能返回完整字素；无可靠分割器的复杂词组返回undefined。输入null统一输出单空格，便于长词回退保留全部字符。 */
export function bindImageTextPunctuation(tokens:readonly Token[],split:(text:string)=>readonly string[]|undefined):string[] {
    const result:string[]=[];let opening='';
    const append=(token:Token)=>{
        if(token===null){if(opening)opening+=' ';else result.push(' ');return;}
        const type=tokenKind(token);
        if(type===1){opening+=token;return;}
        if(type===2&&!opening){
            let previous=result.length-1;while(previous>=0&&result[previous]===' ')previous--;
            if(previous>=0){result[previous]+=previous<result.length-1?' '+token:token;result.length=previous+1;return;}
        }
        result.push(opening+token);opening='';
    };
    for(let index=0;index<tokens.length;index++){
        const token=tokens[index];
        if(token===null||tokenKind(token)){append(token);continue;}
        const first=token.codePointAt(0)!,last=lastPoint(token);
        const prefix=index>0&&tokens[index-1]!==null&&(kind(first)===2||decoration(first));
        const suffix=index+1<tokens.length&&(kind(last)===1||decoration(last));
        const parts=prefix||suffix?split(token):undefined;
        if(!parts){append(token);continue;}
        let left=0,right=parts.length;
        if(prefix)while(left<right-1&&tokenKind(parts[left])===2)append(parts[left++]);
        if(suffix)while(right>left+1&&tokenKind(parts[right-1])===1)right--;
        append(parts.slice(left,right).join(''));
        for(let position=right;position<parts.length;position++)append(parts[position]);
    }
    if(opening)result.push(opening);
    return result;
}
