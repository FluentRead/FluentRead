/** @file tests/mangaRecognitionDarkWhitespace.test.ts 深色底真实SDK裁图与原空格决策的回归；只重建argmax和空格分数，不冒充完整模型输出。 */
import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createMangaRecognitionWhitespace,MANGA_RECOGNITION_WHITESPACE_LIMITS as limits} from '@/src/features/image-translation/services/mangaRecognitionWhitespace';
import {observeMangaRecognitionDarkProjection as project} from '@/src/features/image-translation/services/mangaRecognitionInkProjection';
const base=new URL('./fixtures/image-translation/',import.meta.url);
const fixture=JSON.parse(readFileSync(new URL('dark-whitespace.json',base),'utf8'));
const digest=(data:Uint8Array|Uint8ClampedArray)=>createHash('sha256').update(new Uint8Array(data.buffer,data.byteOffset,data.byteLength)).digest('hex');
function pixelsAt(index:number){
    const record=fixture.records[index],compressed=readFileSync(new URL(record.rgbaFile,base));
    expect(digest(compressed)).toBe(record.gzipSha256);
    const pixels=new Uint8ClampedArray(gunzipSync(compressed,{maxOutputLength:record.crop.width*48*4}));
    expect(digest(pixels)).toBe(record.rgbaSha256);return pixels;
}
function replay(index:number,options:{beforeRead?:(pixels:Uint8ClampedArray)=>void;afterRead?:(pixels:Uint8ClampedArray)=>void;spaceScale?:number}={}){
    const record=fixture.records[index],pixels=pixelsAt(index),copy=pixels.slice(),controller=createMangaRecognitionWhitespace();
    const box={...record.rawOcr.box},padding={width:record.trace.paddedWidth,height:48},C=record.trace.classes,T=record.trace.steps;
    const dictionary=Array<string>(C).fill('');record.trace.indices.forEach((id:number,t:number)=>{if(id!==C-1)dictionary[id]=record.trace.characters[t]??'';});
    controller.beginPage();controller.beginRun({boxes:[box,padding],batchSize:2,dictionary,supportedPerBox:true,sourceRatioOne:true});
    options.beforeRead?.(pixels);controller.observeBorrowedRead(0,record.crop.width,48,pixels);options.afterRead?.(pixels);
    const input={};controller.bindInput(input,{readIndices:[0,1],resizedWidths:[record.crop.width,record.trace.paddedWidth],paddedWidth:record.trace.paddedWidth,height:48});
    const data=new Float32Array(2*T*C);
    for(let t=0;t<T;t++){
        const id=record.trace.indices[t];data[t*C+C-1]=record.trace.spaces[t]*(options.spaceScale??1);
        if(id!==C-1)data[t*C+id]=1;
        data[(T+t)*C]=1;
    }
    controller.observeOutput(input,{dims:[2,T,C],data});
    const source={text:record.sdkText,box,confidence:record.rawOcr.confidence,extra:{label:'same-source'}},original=[source];
    const result=controller.applyToSdkResults(original);controller.endRun();controller.endPage();return{source,original,result,pixels,copy};
}
describe('深色底紧裁文字的实际空格回归',()=>{
    it('实际黑底青字恢复CHECK THE，保持原字符、已有空格、物理框、置信和源像素',()=>{
        expect(digest(readFileSync(new URL('../'+fixture.source,import.meta.url)))).toBe(fixture.sourceSha256);
        expect(digest(readFileSync(new URL('../'+fixture.sourceManifest,import.meta.url)))).toBe(fixture.sourceManifestSha256);
        for(let i=0;i<fixture.records.length;i++){
            const {source,result,pixels,copy}=replay(i);
            expect(result[0].text).toBe(fixture.records[i].expectedText);
            expect(result[0].text.replaceAll(' ','')).toBe(source.text.replaceAll(' ',''));
            expect(result[0].box).toBe(source.box);expect(result[0].confidence).toBe(source.confidence);expect(result[0].extra).toBe(source.extra);
            expect(source.text).toBe(fixture.records[i].sdkText);expect(pixels).toEqual(copy);
            if(i===1)expect(result[0]).toBe(source);
        }
    });
    it('实测14个字形和完整背景空列独立于原图引用，第二行保持原对象',()=>{
        const data=pixelsAt(0),copy=data.slice(),budget={remaining:512};
        expect(project(data,818,budget)).toEqual({characters:14,gaps:[{start:275,end:297,after:5},{start:455,end:481,after:8}]});
        expect(budget.remaining).toBe(470);expect(data).toEqual(copy);
        expect(replay(0,{afterRead:pixels=>pixels.fill(0)}).result[0].text).toBe('CHECK THE OXYGEN');
    });
    it('真实间隙仍须有模型空格支持，透明、杂色、渐变和连接笔画不能借原CTC制造空格',()=>{
        for(const scale of [0,.002])expect(replay(0,{spaceScale:scale}).result[0].text).toBe('CHECKTHE OXYGEN');
        for(const mutate of [
            (p:Uint8ClampedArray)=>{p[3]=254;},
            (p:Uint8ClampedArray)=>{p.set([255,0,0,255],(20*818+280)*4);},
            (p:Uint8ClampedArray)=>{for(let x=274;x<298;x++)p.set([0,8,8,255],(20*818+x)*4);},
            (p:Uint8ClampedArray)=>{for(let x=273;x<=298;x++)p.set([0,255,255,255],(20*818+x)*4);},
        ])expect(replay(0,{beforeRead:mutate}).result[0].text).toBe('CHECKTHE OXYGEN');
    });
});

const C=18710,spans=[[0,26],[28,44],[46,62],[90,106],[108,124],[126,160]];
function frame(background=[0,0,0],ink=[0,255,255],items=spans,width=160){
    const data=new Uint8ClampedArray(width*48*4);
    const paint=(left:number,right:number,color=ink,top=0,bottom=48)=>{for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)data.set([...color,255],(y*width+x)*4);};
    paint(0,width,background);for(const [a,b]of items)paint(a,b);return{data,width,paint,background,ink};
}
const light=()=>frame([240,240,240],[20,20,20],[[10,26],[28,44],[46,62],[90,106],[108,124],[126,142]]);
function tensor(T=20,space=.2){
    const data=new Float32Array(T*C);for(let t=0;t<T;t++)data[t*C]=.99;
    [2,4,6,12,14,16].forEach((t,i)=>{data[t*C]=.01;data[t*C+i+1]=.99;});data[9*C+C-1]=space;return{dims:[1,T,C],data};
}
function cycle(controller:ReturnType<typeof createMangaRecognitionWhitespace>,f=frame(),output:{dims:number[];data:unknown}=tensor(),text='ABCDEF',replaceBox=false){
    const box={width:f.width,height:48},input={},dictionary=Array<string>(C).fill('');for(let i=1;i<=6;i++)dictionary[i]='ABCDEF'[i-1];
    controller.beginRun({boxes:[box],batchSize:1,dictionary,supportedPerBox:true,sourceRatioOne:true});controller.observeBorrowedRead(0,f.width,48,f.data);
    controller.bindInput(input,{readIndices:[0],resizedWidths:[f.width],paddedWidth:f.width,height:48});controller.observeOutput(input,output);
    const source={text,box:replaceBox?{...box}:box,confidence:.99},original=[source],result=controller.applyToSdkResults(original);controller.endRun();return{source,original,result};
}
describe('深色底旁证的颜色、字形和完整空列',()=>{
    it('黑底白字、青字、绿字及暗蓝底亮字采用同一来源条件',()=>{
        for(const [bg,ink]of [[[0,0,0],[240,240,240]],[[0,0,0],[0,255,255]],[[0,0,0],[0,147,0]],[[12,20,32],[235,220,180]],[[64,64,64],[255,255,255]]]){
            const f=frame(bg,ink),copy=f.data.slice();expect(project(f.data,f.width,{remaining:512})).toEqual({characters:6,gaps:[{start:62,end:90,after:3}]});expect(f.data).toEqual(copy);
            const c=createMangaRecognitionWhitespace();c.beginPage();const value=cycle(c,f);expect(value.result[0].text).toBe('ABC DEF');expect(value.result[0].box).toBe(value.source.box);c.endPage();
        }
    });
    it('未知暗底、主色并列、稀少底色、弱墨色或超过4096色都不猜测',()=>{
        for(const f of [frame([65,65,65]),frame([120,120,120]),frame(undefined,[80,80,80]),frame(undefined,undefined,[[0,150]])])expect(project(f.data,f.width,{remaining:512})).toBeUndefined();
        const ambiguous=frame(undefined,undefined,[],120);ambiguous.paint(0,60,[1,1,1]);expect(project(ambiguous.data,120,{remaining:512})).toBeUndefined();
        const sparse=frame(undefined,undefined,[]);sparse.paint(10,17,undefined,10,11);expect(project(sparse.data,160,{remaining:512})).toBeUndefined();
        const diffuse=frame(undefined,undefined,[]);for(let i=0;i<20;i++)diffuse.paint(10+i*6,16+i*6,[0,40+i*10,40+i*10]);expect(project(diffuse.data,160,{remaining:512})).toBeUndefined();
        const palette=frame(undefined,undefined,[],100);for(let i=0;i<4097;i++)palette.data.set([i&255,i>>8&255,20,255],i*4);expect(project(palette.data,100,{remaining:512})).toBeUndefined();
    });
    it('弱抗锯齿最多占词隙两侧各两列，中间弱色和同色轴背景起伏仍会撤回',()=>{
        const allowed=frame();allowed.paint(62,64,[0,8,8],20,21);allowed.paint(88,90,[0,8,8],20,21);
        expect(project(allowed.data,160,{remaining:512})).toEqual({characters:6,gaps:[{start:64,end:88,after:3}]});
        for(const [left,right]of [[62,65],[87,90],[75,76],[62,90]]){
            const f=frame();f.paint(left,right,[0,8,8],20,21);expect(project(f.data,160,{remaining:512})).toBeUndefined();
        }
        const narrow=frame(undefined,undefined,[[0,8],[9,17],[18,26],[29,37],[38,46],[47,56]],56);
        narrow.paint(0,56,[0,0,0],0,12);narrow.paint(0,56,[0,0,0],36,48);narrow.paint(26,27,[0,8,8],20,21);narrow.paint(28,29,[0,8,8],20,21);
        expect(project(narrow.data,56,{remaining:512})).toBeUndefined();
    });
    it('半透明、混色、连接字形和均匀字距不变成完整词隙',()=>{
        for(const color of [[0,0,0,254],[255,0,0,255]]){const f=frame();f.data.set(color,(20*160+75)*4);expect(project(f.data,160,{remaining:512})).toBeUndefined();}
        for(const ink of [[0,20,20],[0,255,255]]){const f=frame();f.paint(62,90,ink,20,21);expect(project(f.data,160,{remaining:512})).toBeUndefined();}
        const uniform=frame(undefined,undefined,[[0,16],[24,40],[48,64],[72,88],[96,112],[120,136]]);expect(project(uniform.data,160,{remaining:512})).toBeUndefined();
    });
    it('输入尺寸、类型、字节和组件额度均有上限，失败也消耗已扫组件',()=>{
        const f=frame();for(const width of [0,7,8.5,NaN,5462])expect(project(f.data,width,{remaining:512})).toBeUndefined();
        expect(project(new Uint8Array(f.data)as never,160,{remaining:512})).toBeUndefined();expect(project(f.data.subarray(4),160,{remaining:512})).toBeUndefined();
        for(const remaining of [-1,NaN,.5,0,5,6,12]){const budget={remaining};expect(project(f.data,160,budget)).toBeUndefined();if(remaining>0&&Number.isInteger(remaining))expect(budget.remaining).toBe(0);}
    });
});
describe('深色底路径的独立页预算和所有权',()=>{
    it('只插入模型支持的空格，保留已有空格；错误字符和替换Box保持原数组',()=>{
        for(const text of ['ABCDEF','AB CDEF','ABC DEF']){const c=createMangaRecognitionWhitespace();c.beginPage();expect(cycle(c,undefined,undefined,text).result[0].text).toBe(text==='AB CDEF'?'AB C DEF':'ABC DEF');c.endPage();}
        for(const mode of ['weak','text','box']){const c=createMangaRecognitionWhitespace();c.beginPage();const r=cycle(c,undefined,tensor(20,mode==='weak'?.0009:.2),mode==='text'?'ABXDEF':'ABCDEF',mode==='box');expect(r.result).toBe(r.original);c.endPage();}
        const c=createMangaRecognitionWhitespace(),abort=new AbortController();c.beginPage(abort.signal);abort.abort();
        const r=cycle(c,undefined,{dims:[1,20,C],get data():never{throw new Error('aborted observation must not read logits');}});expect(r.result).toBe(r.original);c.endPage();
    });
    it('像素额度按页累计且失败不退款，重开run不复位，旧浅底路径独立',()=>{
        for(const failed of [false,true]){
            const c=createMangaRecognitionWhitespace();c.beginPage();let reads=0;const f=frame();if(failed)f.data.set([255,0,0,255],(20*160+75)*4);
            const output=()=>({dims:[1,1,C],get data(){reads++;return new Float32Array(C);}});
            for(let i=0;i<24;i++)cycle(c,f,output());expect(reads).toBe(failed?0:Math.floor(limits.darkPixels/(160*48*2)));
            expect(cycle(c).result[0].text).toBe('ABCDEF');expect(cycle(c,light()).result[0].text).toBe('ABC DEF');
            c.beginPage();expect(cycle(c).result[0].text).toBe('ABC DEF');c.endPage();
        }
    });
    it('失败的组件扫描和时间步也有独立上限，耗尽不占旧路径额度',()=>{
        const c=createMangaRecognitionWhitespace();c.beginPage();const wide=frame(undefined,undefined,Array.from({length:65},(_,i)=>[i*8,i*8+4]),540);
        const noRead={dims:[1,20,C],get data():never{throw new Error('unsupported glyph count must not read logits');}};
        for(let i=0;i<4;i++)cycle(c,wide,noRead);expect(cycle(c,undefined,noRead).result[0].text).toBe('ABCDEF');expect(cycle(c,light()).result[0].text).toBe('ABC DEF');
        c.beginPage();let reads=0;const output=()=>({dims:[1,256,C],get data(){reads++;return new Float32Array(256*C);}});
        for(let i=0;i<3;i++)cycle(c,undefined,output());expect(reads).toBe(2);cycle(c,light(),output());expect(reads).toBe(3);c.endPage();
    });
});
