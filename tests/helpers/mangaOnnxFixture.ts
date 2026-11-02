import {MANGA_RECOGNITION_SHAPE_RECIPE as recipe} from '@/src/features/image-translation/services/mangaRecognitionShapes';
export const concat=(...parts:Uint8Array[])=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;};
export const vi32=(value:number)=>{const bytes:number[]=[];do{const b=value%128;value=Math.floor(value/128);bytes.push(b+(value?128:0));}while(value);return new Uint8Array(bytes);};
export const field=(number:number,body:Uint8Array)=>concat(vi32(number*8+2),vi32(body.length),body);
export const scalar=(number:number,value:number)=>concat(vi32(number*8),vi32(value));
export const string=(number:number,value:string)=>field(number,new TextEncoder().encode(value));
export const model=(graph:Uint8Array,...extra:Uint8Array[])=>concat(...recipe.requiredModelFields,field(7,graph),...extra);
/** 真实 protobuf wire toy；复制配方元数据，不包含权重或神经网络，不声称是可运行的 ONNX 图。 */
export function recognitionWireToy():ArrayBuffer {
    const originalBytes=21159378;
    const nodes=Array.from({length:468},(_,i)=>field(1,concat(string(1,'toy.x'),string(2,'toy.y'+i),string(3,'toy.node'+i),string(4,'Identity'))));
    const initializers=Array.from({length:230},(_,i)=>field(5,concat(scalar(1,1),scalar(2,7),string(8,'toy.weight'+i),field(9,new Uint8Array(8)))));
    const metadata=concat(...recipe.remove.map(entry=>entry.bytes),...nodes,...initializers);
    // 使用保留的 graph doc_string 字段填满源容量，检验大字节片段不被重新编码或改写。
    let padding=originalBytes-metadata.length-20;
    for(let i=0;i<3;i++){
        const graphBytes=metadata.length+1+vi32(padding).length+padding;
        padding+=originalBytes-recipe.requiredModelFields.reduce((n,f)=>n+f.length,0)-1-vi32(graphBytes).length-graphBytes;
    }
    const bytes=model(concat(metadata,field(10,new Uint8Array(padding).fill(0x61))));
    if(bytes.length!==originalBytes)throw Error('wire toy size');
    return bytes.buffer;
}
