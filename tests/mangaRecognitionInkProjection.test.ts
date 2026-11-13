/** @file tests/mangaRecognitionInkProjection.test.ts 抗锯齿空格续证的真实裁图/CTC回放、反例及独立资源余额；不把统计重建当作完整模型输出。 */
import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {observeMangaRecognitionInkProjection as project} from '@/src/features/image-translation/services/mangaRecognitionInkProjection';
import {createMangaRecognitionWhitespace,MANGA_RECOGNITION_WHITESPACE_LIMITS as limits} from '@/src/features/image-translation/services/mangaRecognitionWhitespace';
const BG=[240,180,100],INK=[40,30,80],C=18710;
function frame(spans=[[10,26],[28,44],[46,62],[90,106],[108,124],[126,142]],width=160,background=BG,ink=INK){
    const data=new Uint8ClampedArray(width*48*4);
    const paint=(x0:number,x1:number,color=ink,y0=10,y1=38)=>{for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)data.set([...color,255],(y*width+x)*4);};
    paint(0,width,background,0,48);for(const [a,b]of spans)paint(a,b);
    const blend=(alpha:number)=>background.map((v,i)=>Math.round(v+(ink[i]-v)*alpha));
    for(let i=0;i+1<spans.length;i++)if(spans[i+1][0]-spans[i][1]<=2)paint(spans[i][1],spans[i+1][0],blend(.005),8,9);
    return{data,width,paint,blend,spans};
}
const inspect=(f:ReturnType<typeof frame>,remaining=512)=>{const budget={remaining},value=project(f.data,f.width,budget);return{value,remaining:budget.remaining};};
const dictionary=()=>Array.from({length:C},(_,i)=>i>=1&&i<=6?'ABCDEF'[i-1]:'');
function tensor(T=20,times=[2,4,6,12,14,16],peak=9,space=.2){
    const data=new Float32Array(T*C);for(let t=0;t<T;t++)data[t*C]=.99;
    times.forEach((t,i)=>{data[t*C]=.01;data[t*C+i+1]=.99;});data[peak*C]=.8;data[peak*C+C-1]=space;return{dims:[1,T,C],data};
}
function cycle(controller:ReturnType<typeof createMangaRecognitionWhitespace>,f=frame(),output=tensor(),text='ABCDEF',dict=dictionary()){
    const box={width:f.width,height:48},input={};controller.beginRun({boxes:[box],batchSize:1,dictionary:dict,supportedPerBox:true,sourceRatioOne:true});
    controller.observeBorrowedRead(0,f.width,48,f.data);controller.bindInput(input,{readIndices:[0],resizedWidths:[f.width],paddedWidth:f.width,height:48});controller.observeOutput(input,output);
    const source={text,box,confidence:.99},result=controller.applyToSdkResults([source]);controller.endRun();return{source,result:result[0]};
}
describe('同一墨色的稳定字形与共同空列',()=>{
    it('抗锯齿残色不修改像素；两层稳定字形给出原词隙和字形序号',()=>{
        const f=frame(),before=f.data.slice(),result=inspect(f);expect(result).toEqual({value:{characters:6,gaps:[{start:62,end:90,after:3}]},remaining:494});expect(f.data).toEqual(before);
        f.paint(26,28,f.blend(.08));expect(inspect(f).value).toEqual(result.value);
    });
    it('未知外周、内部透明或混色不提供旁证',()=>{
        for(const [x,y,color]of [[0,0,[1,2,3,255]],[159,10,[1,2,3,255]],[10,0,[1,2,3,255]],[10,47,[1,2,3,255]],[10,10,[240,180,100,254]],[12,12,[255,0,0,255]]] as const){
            const f=frame();f.data.set(color,(y*f.width+x)*4);expect(inspect(f).value).toBeUndefined();
        }
    });
    it('弱孤立组件、三字形连合及宽连接不能被阈值删掉',()=>{
        const faint=frame();faint.paint(74,76,faint.blend(.08));expect(inspect(faint).value).toBeUndefined();
        const three=frame();three.paint(26,28,three.blend(.08));three.paint(44,46,three.blend(.08));expect(inspect(three).value).toBeUndefined();
        const wide=frame([[10,26],[31,47],[49,65],[95,111],[113,129],[131,147]]);wide.paint(26,31,wide.blend(.08));expect(inspect(wide).value).toBeUndefined();
    });
    it('两层不能丢字、拆字或把缺失与拆分抵消成相同数量',()=>{
        const missing=frame();missing.paint(10,26,missing.blend(.2));expect(inspect(missing).value).toBeUndefined();
        for(const [weak,split]of [[0,1],[5,0]]){
            const f=frame();f.paint(...f.spans[weak] as [number,number],f.blend(.2));const [start]=f.spans[split];f.paint(start+7,start+9,f.blend(.2));expect(inspect(f).value).toBeUndefined();
        }
    });
    it('没有显著词隙、字形数量不足或过多时不猜词',()=>{
        expect(inspect(frame([[10,26],[28,44],[46,62],[64,80]])).value).toBeUndefined();
        expect(inspect(frame([[10,26],[28,44],[90,106]])).value).toBeUndefined();
        expect(inspect(frame(Array.from({length:65},(_,i)=>[5+i*8,10+i*8]),540)).value).toBeUndefined();
    });
    it('实测墨色需要重复、集中和足够对比，不接收纹理调色板',()=>{
        const sparse=frame([]);sparse.paint(10,17,INK,10,11);expect(inspect(sparse).value).toBeUndefined();
        const low=frame(undefined,160,[180,180,180],[150,150,150]);expect(inspect(low).value).toBeUndefined();
        const diffuse=frame([]);for(let i=0;i<20;i++)diffuse.paint(10+i*6,16+i*6,diffuse.blend(.2+i*.04));expect(inspect(diffuse).value).toBeUndefined();
        const texture=frame([],120);let value=1;for(let y=1;y<47;y++)for(let x=1;x<119;x++){texture.data.set([value&255,value>>8&255,10,255],(y*120+x)*4);value++;}
        expect(inspect(texture).value).toBeUndefined();
    });
    it('尺寸、字节与共享组件余额无效时回退，耗尽不退款',()=>{
        const f=frame();for(const width of [0,7,8.5,NaN,5462])expect(project(f.data,width,{remaining:512})).toBeUndefined();
        expect(project(new Uint8Array(f.data) as never,f.width,{remaining:512})).toBeUndefined();expect(project(f.data.subarray(4),f.width,{remaining:512})).toBeUndefined();
        for(const remaining of [-1,NaN,.5,0,5,6,12]){const budget={remaining};expect(project(f.data,f.width,budget)).toBeUndefined();if(remaining>0&&Number.isInteger(remaining))expect(budget.remaining).toBe(0);}
    });
});
describe('只补模型与物理字序共同支持的空格',()=>{
    it('恢复空格并保持现有空格、Box身份和原置信',()=>{
        for(const text of ['ABCDEF','AB CDEF','ABC DEF']){const c=createMangaRecognitionWhitespace();c.beginPage();const {source,result}=cycle(c,undefined,undefined,text);expect(result.text).toBe(text==='AB CDEF'?'AB C DEF':'ABC DEF');expect(result.box).toBe(source.box);expect(result.confidence).toBe(source.confidence);c.endPage();}
    });
    it('字符数量、字符类型、空格峰或字形序号不符都保持原文',()=>{
        for(const mode of ['count','script','peak','position','weak']){
            const c=createMangaRecognitionWhitespace();c.beginPage();const dict=dictionary();let text='ABCDEF',value=tensor();
            if(mode==='count'){value=tensor(20,[2,4,6,12,14]);text='ABCDE';}
            if(mode==='script'){dict[1]='Ж';text='ЖBCDEF';}
            if(mode==='peak')value=tensor(20,[2,4,6,12,14,16],7);
            if(mode==='position')value=tensor(20,[2,12,13,14,15,16],9);
            if(mode==='weak')value=tensor(20,[2,4,6,12,14,16],9,.0009);
            expect(cycle(c,undefined,value,text,dict).result.text).toBe(text);c.endPage();
        }
    });
    it('新增像素和组件额度按页扣费，重开run不复位，重开页才恢复',()=>{
        for(const f of [frame(),frame(Array.from({length:55},(_,i)=>{const x=5+i*6+(i>=25?20:0);return[x,x+4];}),380)]){
            const c=createMangaRecognitionWhitespace();c.beginPage();let reads=0;
            for(let i=0;i<24;i++){const value={dims:[1,1,C],get data(){reads++;return new Float32Array(C);}};cycle(c,f,value);}
            expect(reads).toBe(f.width===160?Math.floor(limits.inkPixels/(160*48*2)):3);
            c.beginPage();cycle(c,f,{dims:[1,1,C],get data(){reads++;return new Float32Array(C);}});expect(reads).toBe((f.width===160?Math.floor(limits.inkPixels/(160*48*2)):3)+1);c.endPage();
        }
    });
    it('新增时间步耗尽不占用原恢复路径的额度',()=>{
        const c=createMangaRecognitionWhitespace();c.beginPage();let reads=0;
        const output=()=>({dims:[1,256,C],get data(){reads++;return new Float32Array(256*C);}});
        for(let i=0;i<3;i++)cycle(c,frame(),output());expect(reads).toBe(2);
        const original=frame([[10,26],[28,44],[90,106]]);original.paint(26,28,BG,8,9);cycle(c,original,output(),'ABC');expect(reads).toBe(3);c.endPage();
    });
    it('两个原生完整cohort都恢复ROUTE C4，同批其他SDK结果保持原值',()=>{
        const file=readFileSync(new URL('./fixtures/manga-whitespace-ink-sign.json',import.meta.url));expect(file.length).toBeLessThan(500000);
        expect(createHash('sha256').update(file).digest('hex')).toBe('320803d294522a86c1fc964dc33cb388d3b0d1b7f6082f659d91a3e53338dffb');
        const fixture=JSON.parse(file.toString()),manifest=readFileSync(new URL('./fixtures/manga-color-quality/manifest.json',import.meta.url));
        expect(fixture.originalManifestSha256).toBe(createHash('sha256').update(manifest).digest('hex'));
        const scene=JSON.parse(manifest.toString()).fixtures.find((s:any)=>s.name===fixture.sourceScene);expect(scene.regions.find((r:any)=>r.id==='route').text).toBe('ROUTE C4');
        expect(fixture.sourcePngSha256).toBe(scene.sha256);
        const c=createMangaRecognitionWhitespace();c.beginPage();
        for(const cohort of fixture.cohorts){
            expect(cohort.reads).toHaveLength(cohort.batch.dims[0]);expect([...cohort.batch.readIndices].sort((a:number,b:number)=>a-b)).toEqual(cohort.originalReadIndices);
            expect(cohort.batch.observations.map((r:any)=>r.readIndex)).toEqual(cohort.batch.readIndices);
            expect(cohort.expected.every((r:any)=>scene.regions.some((source:any)=>source.text===r.text))).toBe(true);
            const boxes=cohort.reads.map((r:any)=>r.box),dict=Array(C).fill('');for(const [id,text]of cohort.batch.dictionary)dict[id]=text;
            c.beginRun({boxes,batchSize:cohort.batch.dims[0],dictionary:dict,supportedPerBox:true,sourceRatioOne:true});
            cohort.reads.forEach((r:any,i:number)=>{const raw=gunzipSync(Buffer.from(r.rgbaGzipBase64,'base64'),{maxOutputLength:r.width*48*4});expect(createHash('sha256').update(raw).digest('hex')).toBe(r.rgbaSha256);c.observeBorrowedRead(i,r.width,48,new Uint8ClampedArray(raw));});
            const input={},batch=cohort.batch,data=new Float32Array(batch.dims.reduce((a:number,b:number)=>a*b,1));
            batch.observations.forEach((row:any,n:number)=>row.statistics.forEach(([id,max,blank,space]:number[],t:number)=>{const p=(n*batch.dims[1]+t)*C;data[p]=blank;data[p+C-1]=space;data[p+id]=max;}));
            c.bindInput(input,{readIndices:batch.readIndices.map((i:number)=>cohort.originalReadIndices.indexOf(i)),resizedWidths:batch.resizedWidths,paddedWidth:batch.paddedWidth,height:48});c.observeOutput(input,{dims:batch.dims,data});
            const raw:Array<{text:string;box:{x:number;y:number;width:number;height:number};confidence:number;positions?:readonly number[]}>=
                cohort.rawSdk.map((r:any)=>({...r,box:boxes[cohort.originalReadIndices.indexOf(r.originalReadIndex)]}));
            const result=c.applyToSdkResults(raw);
            expect(result.map(r=>r.text)).toEqual(cohort.expected.map((r:any)=>r.text));expect(result.filter(r=>r.text==='ROUTE C4')).toHaveLength(1);
            expect(result.every((r,i)=>r.box===raw[i].box&&r.confidence===raw[i].confidence&&r.positions===raw[i].positions)).toBe(true);c.endRun();
        }
        c.endPage();expect(fixture.cohorts).toHaveLength(2);
    });
});
