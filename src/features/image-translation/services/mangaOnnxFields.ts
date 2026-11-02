/**
 * @file src/features/image-translation/services/mangaOnnxFields.ts
 * 文件职责：在已校验的私有漫画模型中按固定原字节配方删除图字段，保留所有其他模型字段和权重。
 * 主要内容：有界扫描 protobuf 标量与定长字段，核对唯一图、必要模型元数据、图字段数量与待删片段的唯一匹配；仅重写图长度并追加小型常量，最终模型只分配一次完整缓冲。
 * 模块边界：不做通用 ONNX 优化、不解释特征张量、不校验模型来源或下载数据；调用方必须先验证完整来源 SHA，再使用对应的私有配方。
 */
export interface MangaOnnxFieldRecipe {
    requiredModelFields: readonly Uint8Array[];
    graphCounts: Readonly<Record<number, number>>;
    remove: readonly {name: string; bytes: Uint8Array}[];
    append: readonly Uint8Array[];
}
interface Field {number: number; wire: number; start: number; keyEnd: number; body: number; end: number}
const MAX_BYTES=32*1024*1024,MAX_FIELDS=2048;
function requireModel(condition: boolean): asserts condition {if(!condition)throw new Error('漫画识别模型形状配方不匹配，请更新配套模型与扩展');}
function smallVarint(bytes:Uint8Array,position:{at:number},end:number):number {
    let value=0,shift=0,byte:number;
    do {
        requireModel(position.at<end);byte=bytes[position.at++];
        requireModel(shift!==28||byte<=15);value+=(byte&127)*2**shift;shift+=7;
    }while(byte>=128);
    return value;
}
function fields(bytes:Uint8Array,start:number,end:number):Field[] {
    const position={at:start},result:Field[]=[];
    while(position.at<end){
        requireModel(result.length<MAX_FIELDS);const from=position.at,key=smallVarint(bytes,position,end),number=key>>>3,wire=key&7,keyEnd=position.at;
        requireModel(number>0);let body=keyEnd;
        if(wire===2){const length=smallVarint(bytes,position,end);body=position.at;position.at+=length;}
        else if(wire===0){
            for(let count=0;;count++){
                requireModel(position.at<end);const byte=bytes[position.at++];requireModel(count!==9||byte<=1);
                if(byte<128)break;
            }
        }else {requireModel(wire===1||wire===5);position.at+=wire===1?8:4;}
        requireModel(position.at<=end);result.push({number,wire,start:from,keyEnd,body,end:position.at});
    }
    return result;
}
function equal(bytes:Uint8Array,field:Field,expected:Uint8Array):boolean {
    if(field.end-field.start!==expected.length)return false;
    for(let index=0;index<expected.length;index++)if(bytes[field.start+index]!==expected[index])return false;
    return true;
}
function lengthVarint(length:number):Uint8Array {
    const encoded:number[]=[];
    do {const byte=length%128;length=Math.floor(length/128);encoded.push(byte+(length?128:0));}while(length);
    return new Uint8Array(encoded);
}

/** 输入来源已由资源层完整 SHA 校验；任何配方偏移或结构变化都明确失败，不回退为告警中的旧图。 */
export function rewriteMangaOnnxFields(buffer:ArrayBuffer,recipe:MangaOnnxFieldRecipe):ArrayBuffer {
    requireModel(buffer.byteLength>0&&buffer.byteLength<=MAX_BYTES);
    const bytes=new Uint8Array(buffer),model=fields(bytes,0,bytes.length),graphs=model.filter(field=>field.number===7);
    requireModel(graphs.length===1&&graphs[0].wire===2);
    for(const required of recipe.requiredModelFields)requireModel(model.filter(field=>equal(bytes,field,required)).length===1);
    const graph=graphs[0],members=fields(bytes,graph.body,graph.end);
    for(const [key,count]of Object.entries(recipe.graphCounts))requireModel(members.filter(field=>field.number===Number(key)).length===count);
    const removed=new Set<number>();
    for(const change of recipe.remove){
        const matches=members.filter(field=>equal(bytes,field,change.bytes));
        requireModel(matches.length===1&&!removed.has(matches[0].start));removed.add(matches[0].start);
    }
    const kept=members.filter(field=>!removed.has(field.start));
    const graphBytes=kept.reduce((sum,field)=>sum+field.end-field.start,0)+recipe.append.reduce((sum,field)=>sum+field.length,0),length=lengthVarint(graphBytes);
    const output=new Uint8Array(graph.keyEnd+length.length+graphBytes+bytes.length-graph.end);
    let offset=0;
    function copy(part:Uint8Array){output.set(part,offset);offset+=part.length;}
    copy(bytes.subarray(0,graph.keyEnd));copy(length);
    for(const field of kept)copy(bytes.subarray(field.start,field.end));
    for(const field of recipe.append)copy(field);
    copy(bytes.subarray(graph.end));return output.buffer;
}
