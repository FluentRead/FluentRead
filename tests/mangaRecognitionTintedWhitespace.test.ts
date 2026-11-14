/** @file tests/mangaRecognitionTintedWhitespace.test.ts 实际浅色底裁图与空格决策回放；重建张量仅保留已观测的argmax和空格概率，不冒充完整模型输出。 */
import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createMangaRecognitionWhitespace,MANGA_RECOGNITION_WHITESPACE_LIMITS as limits} from '@/src/features/image-translation/services/mangaRecognitionWhitespace';
import {observeMangaRecognitionTintedProjection as tinted,observeMangaRecognitionNeutralProjection as neutral,
    observeMangaRecognitionInkProjection as fullBorder} from '@/src/features/image-translation/services/mangaRecognitionInkProjection';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/image-translation/field-note-whitespace.json',import.meta.url),'utf8'));
const C=fixture.trace.classes;
const loadPixels=()=>new Uint8ClampedArray(gunzipSync(readFileSync(new URL('./fixtures/image-translation/field-note-whitespace.rgba.gz',import.meta.url)),{maxOutputLength:fixture.width*48*4}));
function replay(edit?:(pixels:Uint8ClampedArray)=>void){
    const controller=createMangaRecognitionWhitespace(),pixels=loadPixels(),copy=pixels.slice();
    const box={width:fixture.sourceBox.width,height:fixture.sourceBox.height};
    // A blank companion preserves the observed common padded width without inventing another SDK result.
    const paddingBox={width:fixture.trace.paddedWidth,height:48},boxes=[box,paddingBox],dictionary=Array<string>(C).fill('');
    for(const [id,text]of fixture.trace.dictionary)dictionary[id]=text;
    controller.beginPage();controller.beginRun({boxes,batchSize:2,dictionary,supportedPerBox:true,sourceRatioOne:true});
    controller.observeBorrowedRead(0,fixture.width,48,pixels);
    edit?.(pixels);
    const input={};controller.bindInput(input,{readIndices:[0,1],resizedWidths:[fixture.width,fixture.trace.paddedWidth],paddedWidth:fixture.trace.paddedWidth,height:48});
    const T=fixture.trace.steps,data=new Float32Array(2*T*C);
    for(let t=0;t<T;t++){
        const id=fixture.trace.indices[t],space=fixture.trace.spaces[t];
        data[t*C+C-1]=space;
        // Only class ordering is reconstructed. Recovery consumes these argmax decisions and the recorded space values.
        if(id!==C-1)data[t*C+id]=1;
        data[(T+t)*C]=1;
    }
    controller.observeOutput(input,{dims:[2,T,C],data});
    const source={text:fixture.sdkText,box,confidence:fixture.sourceConfidence,extra:{label:'owned-source'}};
    const result=controller.applyToSdkResults([source]);controller.endRun();controller.endPage();
    return{source,result,pixels,copy};
}

function frame(background=[238,234,213],spans=[[10,26],[28,44],[46,62],[90,106],[108,124],[126,142]],width=160){
    const ink=[18,25,29],data=new Uint8ClampedArray(width*48*4);
    const paint=(left:number,right:number,color=ink,top=0,bottom=48)=>{for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)data.set([...color,255],(y*width+x)*4);};
    paint(0,width,background);for(const [a,b]of spans)paint(a,b);
    return{data,width,paint,blend:(alpha:number)=>background.map((value,i)=>Math.round(value+(ink[i]-value)*alpha))};
}
function tensor(T=20,space=.2){
    const data=new Float32Array(T*C);for(let t=0;t<T;t++)data[t*C]=.99;
    [2,4,6,12,14,16].forEach((t,i)=>{data[t*C]=.01;data[t*C+i+1]=.99;});data[9*C+C-1]=space;return{dims:[1,T,C],data};
}
function cycle(controller:ReturnType<typeof createMangaRecognitionWhitespace>,f=frame(),output:{dims:number[];data:unknown}=tensor(),text='ABCDEF'){
    const box={width:f.width,height:48},input={},dictionary=Array<string>(C).fill('');
    for(let i=1;i<=6;i++)dictionary[i]='ABCDEF'[i-1];
    controller.beginRun({boxes:[box],batchSize:1,dictionary,supportedPerBox:true,sourceRatioOne:true});
    controller.observeBorrowedRead(0,f.width,48,f.data);
    controller.bindInput(input,{readIndices:[0],resizedWidths:[f.width],paddedWidth:f.width,height:48});controller.observeOutput(input,output);
    const source={text,box,confidence:.99},original=[source],result=controller.applyToSdkResults(original);controller.endRun();return{source,original,result};
}

describe('有色浅底紧裁字形的空格恢复',()=>{
    it('实际FIELDNOTE裁图和原模型空格决策恢复FIELD NOTE，保持字符、框、置信与输入像素',()=>{
        const source=readFileSync(new URL('../'+fixture.sourcePath,import.meta.url));
        expect(createHash('sha256').update(source).digest('hex')).toBe(fixture.sourcePngSha256);
        const {source:raw,result,pixels,copy}=replay();
        expect(createHash('sha256').update(pixels).digest('hex')).toBe(fixture.rgbaSha256);
        expect(result[0].text).toBe(fixture.expectedText);
        expect(result[0].text.replaceAll(' ','')).toBe(raw.text.replaceAll(' ',''));
        expect(result[0].box).toBe(raw.box);expect(result[0].confidence).toBe(raw.confidence);expect(result[0].extra).toBe(raw.extra);
        expect(raw.text).toBe('FIELDNOTE 12');expect(pixels).toEqual(copy);
    });
    it('实际裁图需要独立浅色底路径：完整外周与灰度判定仍拒绝，同一数据支持11个字形及两个间隙',()=>{
        const pixels=loadPixels(),budget={remaining:512};
        expect(fullBorder(pixels,fixture.width,{remaining:512})).toBeUndefined();
        expect(neutral(pixels,fixture.width,{remaining:512})).toBeUndefined();
        expect(tinted(pixels,fixture.width,budget)).toEqual({characters:11,gaps:[{start:189,end:214,after:5},{start:390,end:416,after:9}]});
        expect(budget.remaining).toBe(479);
        expect(replay(pixels=>pixels.fill(0)).result[0].text).toBe('FIELD NOTE 12');
    });
    it('只有不透明浅色有色底和完整同色左右边缘可用；旧灰度分支保持独立',()=>{
        for(const bg of [[219,215,194],[238,234,222],[240,240,240]]){
            const f=frame(bg);expect(tinted(f.data,f.width,{remaining:512})).toBeUndefined();
        }
        const boundary=frame([220,215,200]);expect(tinted(boundary.data,boundary.width,{remaining:512})?.characters).toBe(6);
        const minimalTint=frame([238,234,221]);expect(tinted(minimalTint.data,minimalTint.width,{remaining:512})?.characters).toBe(6);
        for(const [x,y,color]of [[0,20,[237,234,213,255]],[159,20,[238,233,213,255]],[70,20,[238,234,213,254]],[12,12,[255,0,0,255]],[70,20,[220,210,170,255]]] as const){
            const f=frame();f.data.set(color,(y*f.width+x)*4);expect(tinted(f.data,f.width,{remaining:512})).toBeUndefined();
        }
    });
    it('灰度三层不能丢字、拆字或从均匀字距中制造词隙',()=>{
        const missing=frame();missing.paint(10,26,missing.blend(.6));expect(tinted(missing.data,missing.width,{remaining:512})).toBeUndefined();
        const uniform=frame(undefined,[[10,26],[36,52],[62,78],[88,104],[114,130],[140,156]]);
        expect(tinted(uniform.data,uniform.width,{remaining:512})).toBeUndefined();
        const split=frame();split.paint(17,19,split.blend(.6));const c=createMangaRecognitionWhitespace();c.beginPage();
        const value=cycle(c,split);expect(value.result).toBe(value.original);c.endPage();
    });
    it('仍要求空格峰、原字符序列和精确Box身份；取消后不再读取概率',()=>{
        for(const [space,text]of [[.0009,'ABCDEF'],[.2,'ABXDEF']] as const){
            const c=createMangaRecognitionWhitespace();c.beginPage();const result=cycle(c,undefined,tensor(20,space),text);expect(result.result).toBe(result.original);c.endPage();
        }
        const c=createMangaRecognitionWhitespace(),abort=new AbortController();c.beginPage(abort.signal);abort.abort();
        const result=cycle(c,undefined,{dims:[1,20,C],get data(){throw new Error('aborted crop must not read logits');}});expect(result.result).toBe(result.original);c.endPage();
    });
    it('浅色底像素额度按页累计，耗尽后不读概率且不占原灰度额度',()=>{
        const c=createMangaRecognitionWhitespace();c.beginPage();let reads=0;
        const output=()=>({dims:[1,1,C],get data(){reads++;return new Float32Array(C);}});
        for(let i=0;i<24;i++)cycle(c,undefined,output());
        const allowed=Math.floor(limits.tintedPixels/(160*48*2));expect(reads).toBe(allowed);
        cycle(c,frame([240,240,240]),output());expect(reads).toBe(allowed+1);
        c.beginPage();cycle(c,undefined,output());expect(reads).toBe(allowed+2);c.endPage();
    });
    it('失败组件扫描也扣费，浅色底组件耗尽不影响灰度候选，重开页恢复',()=>{
        const c=createMangaRecognitionWhitespace();c.beginPage();const wide=frame(undefined,Array.from({length:65},(_,i)=>[5+i*8,10+i*8]),540);
        const noRead={dims:[1,20,C],get data():never{throw new Error('rejected projection must not read logits');}};
        for(let i=0;i<4;i++)cycle(c,wide,noRead);
        expect(cycle(c,undefined,noRead).result[0].text).toBe('ABCDEF');
        expect(cycle(c,frame([240,240,240])).result[0].text).toBe('ABC DEF');
        c.beginPage();expect(cycle(c).result[0].text).toBe('ABC DEF');c.endPage();
    });
    it('浅色底CTC时间步耗尽不影响灰度预算，尺寸或余额无效不接收像素',()=>{
        const c=createMangaRecognitionWhitespace();c.beginPage();let reads=0;
        const output=()=>({dims:[1,256,C],get data(){reads++;return new Float32Array(256*C);}});
        for(let i=0;i<3;i++)cycle(c,undefined,output());expect(reads).toBe(2);
        cycle(c,frame([240,240,240]),output());expect(reads).toBe(3);c.endPage();
        const f=frame();for(const remaining of [0,-1,NaN,.5])expect(tinted(f.data,f.width,{remaining})).toBeUndefined();
        for(const width of [0,7,8.5,5462])expect(tinted(f.data,width,{remaining:512})).toBeUndefined();
        expect(tinted(f.data.subarray(4),f.width,{remaining:512})).toBeUndefined();
    });
});
