import {describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {createMangaViewWordBoundaryBudget,createMangaViewWordBoundaryConsumer,getMangaViewWordBoundaryProvenance,hasMangaViewWordBoundaryDifference,type MangaViewWordBoundaryProof} from '@/src/features/image-translation/services/mangaViewWordBoundary';
import {collectMangaRegions} from '@/src/features/image-translation/services/mangaBubbles';

function fixture(wholeText='AB CD',localText='ABCD',gaps=[2,9,2]){
    const width=700,height=220,data=new Uint8ClampedArray(width*height*4).fill(255),characters=wholeText.replaceAll(' ','').length;
    const box={x:40,y:30,width:4+characters*4+gaps.reduce((a,b)=>a+b,0),height:18};let x=box.x+2;
    for(let index=0;index<characters;index++){for(let y=33;y<45;y++)for(let xx=x;xx<x+4;xx++){const p=(y*width+xx)*4;data[p]=data[p+1]=data[p+2]=20;}x+=4+(gaps[index]??0);}
    const whole={text:wholeText,confidence:.98,box:{...box}},local={text:localText,confidence:.99,box:{...box}},bubble={bbox:{x0:0,y0:0,x1:width,y1:height},results:[local]};
    const read=vi.fn((roi:{left:number;top:number;width:number;height:number})=>{const output=new Uint8ClampedArray(roi.width*roi.height*4);for(let y=0;y<roi.height;y++)output.set(data.subarray(((roi.top+y)*width+roi.left)*4,((roi.top+y)*width+roi.left+roi.width)*4),y*roi.width*4);return output;});
    const frame={width,height,read},budget=createMangaViewWordBoundaryBudget(frame),prove=()=>budget.prove(whole,local,bubble);
    const set=(x:number,y:number,r:number,g=r,b=r,a=255)=>data.set([r,g,b,a],(y*width+x)*4);
    return{width,height,data,whole,local,bubble,frame,read,budget,prove,set};
}
function consumer(f:ReturnType<typeof fixture>,proofs:MangaViewWordBoundaryProof[]|undefined){return createMangaViewWordBoundaryConsumer([f.whole],[f.bubble],proofs,f.width,f.height);}
/** 仅在原始灰度像素上连接指定列；80/120不变，160才看见该抗锯齿连接。 */
function grayBridge(f:ReturnType<typeof fixture>,from=46,to=48,value=139){for(let x=from;x<to;x++)f.set(x,35,value);}
describe('高阈值仅合并可归属的短词内抗锯齿间隔',()=>{
    it('可携带原PNG的1475px ROI选回已观测IT IS，原局部几何与双视图来历不变',()=>{
        const record=JSON.parse(readFileSync(new URL('./fixtures/manga-natural/station-journey-ink-itis-word-boundary-roi.json',import.meta.url),'utf8'));
        const png=readFileSync(new URL('./fixtures/manga-natural/station-journey-ink.png',import.meta.url));
        expect(createHash('sha256').update(png).digest('hex')).toBe(record.source.sha256);
        const inflated=inflateSync(Buffer.from(record.rgba.data,'base64')),data=new Uint8ClampedArray(inflated);
        expect(data.length).toBe(1475*4);expect(createHash('sha256').update(inflated).digest('hex')).toBe(record.rgba.sha256);
        const whole=structuredClone(record.observed.whole),raw=structuredClone(record.observed.local),b=record.derivedMapping.bubbleBox;
        const local={...raw,box:{x:b.x0+raw.box.x/3,y:b.y0+raw.box.y/3,width:raw.box.width/3,height:raw.box.height/3}},bubble={bbox:b,results:[local]};
        const before=JSON.stringify([whole,raw,local]),pixelsBefore=data.slice(),read=vi.fn((roi:{left:number;top:number;width:number;height:number},max:number)=>{expect(roi).toEqual(record.roi);expect(max).toBe(65536);return data;});
        const budget=createMangaViewWordBoundaryBudget({width:record.source.width,height:record.source.height,read}),proof=budget.prove(whole,local,bubble)!;
        expect(proof).toMatchObject({preferred:'whole',boundaries:[2],pixels:1475,roi:record.roi});expect(read).toHaveBeenCalledOnce();expect(budget.usage).toEqual({attempts:1,pixels:1475});
        const graph=structuredClone({results:[whole],bubbles:[bubble],wordBoundaryProofs:[proof]});
        const regions=collectMangaRegions(graph,'en',record.source.width,record.source.height,'image');
        expect(regions).toHaveLength(1);expect(regions[0]).toMatchObject({text:'IT IS',fontSize:local.box.height,bbox:{x0:local.box.x,y0:local.box.y,x1:local.box.x+local.box.width,y1:local.box.y+local.box.height}});
        expect(getMangaViewWordBoundaryProvenance(regions[0])).toEqual([{whole:proof.wholeSnapshot,local:proof.localSnapshot,textView:'whole',geometryView:'local'}]);
        expect(JSON.stringify([whole,raw,local])).toBe(before);expect(data).toEqual(pixelsBefore);
        expect(record.derivedMapping.nativeCropSHAKnown).toBe(false);expect(record.derivedMapping.nativeCropPixelsCaptured).toBe(false);
        // 原I/T之间两枚139灰度像素只在160连通；真正的9px词隙一直保持空白。
        const at=(x:number,y:number)=>data[((y-record.roi.top)*record.roi.width+x-record.roi.left)*4+1];
        expect([at(906,564),at(906,565)]).toEqual([139,139]);
        for(let x=918;x<927;x++)for(let y=record.roi.top;y<record.roi.top+record.roi.height;y++)expect(at(x,y)).toBeGreaterThan(160);
    });
    it.each([1,2])('只在160合并%dpx词内间隔，80/120仍按全部原字符选已观测边界',gap=>{
        const f=fixture('AB CD','ABCD',[gap,9,2]);grayBridge(f,46,46+gap);const before=f.data.slice();
        const proof=f.prove()!;expect(proof.preferred).toBe('whole');expect(proof.boundaries).toEqual([2]);expect(consumer(f,[proof]).choose(f.local,f.bubble).text).toBe('AB CD');
        expect(Buffer.compare(Buffer.from(f.data.buffer),Buffer.from(before.buffer))).toBe(0);
    });
    it('合并可在词隙任一侧或两侧同时发生，也可选择原local空格',()=>{
        for(const side of['right','both']as const){const f=fixture();grayBridge(f,65,67);if(side==='both')grayBridge(f);expect(f.prove()!.boundaries).toEqual([2]);}
        const local=fixture('ABCD','AB CD');grayBridge(local);expect(local.prove()!.preferred).toBe('local');
        const regions=collectMangaRegions({results:[local.whole],bubbles:[local.bubble],wordBoundaryProofs:[local.prove()!]},'en',local.width,local.height,'image');
        expect(regions[0].text).toBe('AB CD');expect(getMangaViewWordBoundaryProvenance(regions[0])?.[0].textView).toBe('local');
    });
    it.each(['left','right','word-gap']as const)('2px%s边缘变化仍受原字符/词隙映射约束',side=>{
        const f=fixture();grayBridge(f);
        if(side==='left')grayBridge(f,40,42);if(side==='right')grayBridge(f,71,73);if(side==='word-gap')grayBridge(f,52,54);
        expect(f.prove()!.boundaries).toEqual([2]);
    });
    it.each(['cross-word','gap3','new-island','left3','right3','word-gap-drift']as const)('%s不能冒用粗层合并权限',kind=>{
        const f=kind==='gap3'?fixture('AB CD','ABCD',[3,9,2]):fixture();grayBridge(f,46,kind==='gap3'?49:48);
        if(kind==='cross-word')grayBridge(f,52,61);
        if(kind==='new-island'){grayBridge(f,65,67);grayBridge(f,56,57);}
        if(kind==='left3')grayBridge(f,39,42);if(kind==='right3')grayBridge(f,71,74);
        if(kind==='word-gap-drift'){grayBridge(f,52,54);grayBridge(f,59,61);}
        const before=f.data.slice();expect(f.prove()).toBeUndefined();expect(Buffer.compare(Buffer.from(f.data.buffer),Buffer.from(before.buffer))).toBe(0);
    });
    it('160新增孤岛超过原字符数立即拒绝，不能用低两层绕过',()=>{const f=fixture();grayBridge(f,56,57);expect(f.prove()).toBeUndefined();});
    it.each(['low80-merge','low120-merge','low-edge-drift','low-boundary-drift']as const)('%s仍要求低两层完整且一致',kind=>{
        const f=kind==='low-boundary-drift'?fixture('AB CD','ABCD',[2,5,2]):fixture();grayBridge(f);
        if(kind==='low80-merge')grayBridge(f,46,48,80);if(kind==='low120-merge')grayBridge(f,46,48,100);
        if(kind==='low-edge-drift')grayBridge(f,39,42,100);if(kind==='low-boundary-drift')grayBridge(f,52,54,100);
        expect(f.prove()).toBeUndefined();
    });
    it.each(['alpha','color','perimeter','cancel','raw-change','zero-read']as const)('新增粗层路径不能绕过%s合同',kind=>{
        const f=fixture();grayBridge(f);
        if(kind==='alpha')f.set(43,35,20,20,20,254);if(kind==='color')f.set(43,35,20,20,37);if(kind==='perimeter')f.set(38,28,219);
        if(kind==='zero-read'){f.local.text=f.whole.text;expect(f.prove()).toBeUndefined();expect(f.read).not.toHaveBeenCalled();return;}
        const original=f.read.getMockImplementation()!;
        if(kind==='raw-change')f.read.mockImplementationOnce(roi=>{f.whole.confidence=.7;return original(roi);});
        if(kind==='cancel'){const controller=new AbortController();f.read.mockImplementationOnce(roi=>{controller.abort();return original(roi);});expect(()=>createMangaViewWordBoundaryBudget(f.frame,controller.signal).prove(f.whole,f.local,f.bubble)).toThrow(expect.objectContaining({name:'AbortError'}));}
        else expect(f.prove()).toBeUndefined();
    });
    it('不扩大语义承诺：相同RGBA可为字距排版，粗层物理偏好仍只是已有候选',()=>{
        const f=fixture();grayBridge(f);const samePixels=f.data.slice();
        expect(Buffer.compare(Buffer.from(f.data.buffer),Buffer.from(samePixels.buffer))).toBe(0);expect(f.prove()!.preferred).toBe('whole');
        const physicalPreference=consumer(f,[f.prove()!]).choose(f.local,f.bubble).text;
        expect(physicalPreference).toBe('AB CD');expect(physicalPreference).not.toBe('ABCD');
        // 两个语义解释共享这份RGBA与两个观测；像素规则无法证明“ABCD字距排版”不是真值。
    });
});
describe('两个已观测视图的有界词界证明',()=>{
    it('原ROI稳定支持已有whole空格，保留local几何和两份raw来历，不拼第三种文字',()=>{
        const f=fixture();f.local.box.height=16;f.local.box.y=31;
        const before=JSON.stringify([f.whole,f.local]),proof=f.prove()!;expect(proof.preferred).toBe('whole');expect(proof.boundaries).toEqual([2]);
        expect(f.read).toHaveBeenCalledOnce();expect(f.read.mock.calls[0][0]).toEqual(proof.roi);
        const chosen=consumer(f,[proof]).choose(f.local,f.bubble);
        expect(chosen).toEqual({...f.local,text:f.whole.text,confidence:f.whole.confidence});expect(chosen.box).toBe(f.local.box);
        const regions=collectMangaRegions({results:[f.whole],bubbles:[f.bubble],wordBoundaryProofs:[proof]},'en',f.width,f.height,'image');
        expect(regions).toHaveLength(1);expect(regions[0]).toMatchObject({text:'AB CD',fontSize:16,bbox:{x0:40,y0:31,y1:47}});
        expect(getMangaViewWordBoundaryProvenance(regions[0])).toEqual([{whole:proof.wholeSnapshot,local:proof.localSnapshot,textView:'whole',geometryView:'local'}]);
        expect(JSON.stringify(regions)).not.toContain('word-boundary');expect(JSON.stringify([f.whole,f.local])).toBe(before);
    });
    it('局部已有边界同样可胜；POSTCARD正常字距不能因更多spaces而被偏好',()=>{
        const local=fixture('ABCD','AB CD');expect(local.prove()!.preferred).toBe('local');
        expect(consumer(local,[local.prove()!]).choose(local.local,local.bubble).text).toBe('AB CD');
        const localRegions=collectMangaRegions({results:[local.whole],bubbles:[local.bubble],wordBoundaryProofs:[local.prove()!]},'en',local.width,local.height,'image');
        expect(localRegions[0].text).toBe('AB CD');expect(getMangaViewWordBoundaryProvenance(localRegions[0])?.[0].textView).toBe('local');
        const post=fixture('POST CARD','POSTCARD',Array(7).fill(2));expect(post.prove()!.preferred).toBe('local');
        const inverse=fixture('POSTCARD','POST CARD',Array(7).fill(2));expect(inverse.prove()!.preferred).toBe('whole');
    });
    it('一致边界和仅前后空白不同都零read，失败attempt仍计费；owner可先用纯文本筛选',()=>{
        for(const [whole,local]of [['AB CD','AB CD'],[' AB CD ','AB CD'],['ABCD',' ABCD ']]){
            const f=fixture(whole,local);expect(f.prove()).toBeUndefined();expect(f.read).not.toHaveBeenCalled();
            expect(f.budget.usage).toEqual({attempts:1,pixels:0});expect(hasMangaViewWordBoundaryDifference(whole,local)).toBe(false);
        }
        expect(hasMangaViewWordBoundaryDifference('AB CD','ABCD')).toBe(true);
        expect(hasMangaViewWordBoundaryDifference('ABCD','AB CD')).toBe(true);
        expect(hasMangaViewWordBoundaryDifference('AB CD','ABCE')).toBe(false);
    });
    it('整页structuredClone保留共享引用；另页同primitive clone不能冒认当前proof',()=>{
        const f=fixture(),proof=f.prove()!,cloned=structuredClone({results:[f.whole],bubbles:[f.bubble],wordBoundaryProofs:[proof]});
        expect(cloned.wordBoundaryProofs[0].whole).toBe(cloned.results[0]);expect(cloned.wordBoundaryProofs[0].local).toBe(cloned.bubbles[0].results[0]);
        expect(collectMangaRegions(cloned,'en',f.width,f.height,'image')[0].text).toBe('AB CD');
        const other=structuredClone({results:[f.whole],bubbles:[f.bubble]});
        expect(collectMangaRegions({...other,wordBoundaryProofs:[proof]},'en',f.width,f.height,'image')[0].text).toBe('ABCD');
    });
    it.each([
        ['AB CD','ABCE'],['AB 04','AB04'],['A B','AB'],['A  BCD','ABCD'],['AB-CD','ABCD'],['AB\tCD','ABCD'],
        ['A'.repeat(129),'A'.repeat(129)],['A'.repeat(65),'A'.repeat(65)],
    ])('不相同/非支持字符不会制造边界：%s / %s',(a,b)=>{const f=fixture(a,b);expect(f.prove()).toBeUndefined();expect(f.read).not.toHaveBeenCalled();});
    it.each([NaN,Infinity,.64,1.01])('无可靠原置信度%s不读source',confidence=>{const f=fixture();f.whole.confidence=confidence;expect(f.prove()).toBeUndefined();expect(f.read).not.toHaveBeenCalled();});
    it.each([
        {x:-1},{x:NaN},{width:0},{height:-1},{x:699},{y:219},{width:20,height:30},
    ])('非法/非横向原box不发proof：%j',changed=>{const f=fixture();Object.assign(f.whole.box,changed);expect(f.prove()).toBeUndefined();});
    it('低重叠、字号差、源尺寸和ROI超限不发proof',()=>{
        const f=fixture();f.local.box.x+=20;expect(f.prove()).toBeUndefined();
        const g=fixture();g.local.box.height=8;expect(g.prove()).toBeUndefined();
        const h=fixture();h.frame.width=Infinity;expect(h.prove()).toBeUndefined();
        const wide=fixture();wide.whole.box.width=wide.local.box.width=600;expect(wide.prove()).toBeUndefined();
        const tall=fixture();Object.assign(tall.whole.box,{width:400,height:150});Object.assign(tall.local.box,{width:400,height:150});expect(tall.prove()).toBeUndefined();
    });
    it.each(['alpha','multi-ink','perimeter','extra-run','ligature','threshold-edge','threshold-gap'] as const)('%s不确定图像不产proof',kind=>{
        const f=kind==='threshold-gap'?fixture('AB CD','ABCD',[2,5,2]):fixture();
        if(kind==='alpha')f.set(43,35,20,20,20,100);
        if(kind==='multi-ink')f.set(43,35,230,0,0);
        if(kind==='perimeter')f.set(38,28,20);
        if(kind==='extra-run')for(let y=33;y<45;y++)f.set(54,y,20);
        if(kind==='ligature')for(let x=46;x<48;x++)f.set(x,35,20);
        if(kind==='threshold-edge')for(let x=39;x<42;x++)for(let y=33;y<45;y++)f.set(x,y,140);
        if(kind==='threshold-gap')for(let x=52;x<54;x++)for(let y=33;y<45;y++)f.set(x,y,140);
        expect(f.prove()).toBeUndefined();
    });
    it('均匀tracking/同样边界/两个都不匹配时不改原选择',()=>{
        expect(fixture('A B C D','ABCD',[8,8,8]).prove()).toBeUndefined();
        expect(fixture('AB CD','AB CD').prove()).toBeUndefined();expect(fixture('A BCD','ABC D').prove()).toBeUndefined();
        const blank=fixture();blank.data.fill(255);expect(blank.prove()).toBeUndefined();
    });
    it('缺reader/错误字节/读取首因/读取后raw变化都不发布伪证明',()=>{
        const absent=fixture();absent.read.mockReturnValueOnce(undefined as never);expect(absent.prove()).toBeUndefined();
        const length=fixture();length.read.mockReturnValueOnce(new Uint8ClampedArray(4));expect(length.prove()).toBeUndefined();
        const wrong=fixture();wrong.read.mockReturnValueOnce(new Uint8Array(4) as never);expect(wrong.prove()).toBeUndefined();
        const thrown=fixture(),error=new Error('original reader failed');thrown.read.mockImplementationOnce(()=>{throw error;});expect(thrown.prove).toThrow(error);
        const changed=fixture(),read=changed.read.getMockImplementation()!;changed.read.mockImplementationOnce(roi=>{changed.whole.text='AFTER';return read(roi);});expect(changed.prove()).toBeUndefined();
    });
    it('取消保留AbortError，reader后取消不留下proof',()=>{
        const f=fixture(),abort=new AbortController();abort.abort();const first=createMangaViewWordBoundaryBudget(f.frame,abort.signal);
        expect(()=>first.prove(f.whole,f.local,f.bubble)).toThrow(expect.objectContaining({name:'AbortError'}));expect(f.read).not.toHaveBeenCalled();
        const next=new AbortController(),read=f.read.getMockImplementation()!;f.read.mockImplementationOnce(roi=>{next.abort();return read(roi);});
        expect(()=>createMangaViewWordBoundaryBudget(f.frame,next.signal).prove(f.whole,f.local,f.bubble)).toThrow(expect.objectContaining({name:'AbortError'}));
    });
    it('页attempt含失败、总source像素含失败，超过64/2MP不再read',()=>{
        const f=fixture();Object.assign(f.whole.box,{x:20,y:20,width:508,height:124});Object.assign(f.local.box,{x:20,y:20,width:508,height:124});
        f.read.mockReturnValue(undefined as never);for(let i=0;i<65;i++)expect(f.prove()).toBeUndefined();
        expect(f.read).toHaveBeenCalledTimes(30);expect(f.budget.usage).toEqual({attempts:64,pixels:30*65536});
    });
    it.each(['whole-text','local-score','local-box','bubble','local-membership','width','version','ordinal','pixels','roi','preferred','boundaries','missing'] as const)('原图证据%s漂移则沿用local',kind=>{
        const f=fixture(),proof=f.prove()!;
        if(kind==='whole-text')f.whole.text='AFTER';if(kind==='local-score')f.local.confidence=.7;if(kind==='local-box')f.local.box.x+=1;
        if(kind==='bubble')proof.bubble={...f.bubble};if(kind==='local-membership')f.bubble.results=[];if(kind==='width')proof.width++;
        if(kind==='version')proof.version='future' as never;if(kind==='ordinal')proof.ordinal=0;if(kind==='pixels')proof.pixels++;
        if(kind==='roi')proof.roi.left++;if(kind==='preferred')proof.preferred='unknown' as never;if(kind==='boundaries')proof.boundaries=[1];
        const value=kind==='missing'?null as never:proof;
        expect(consumer(f,[value]).choose(f.local,f.bubble)).toBe(f.local);
    });
    it('不存在/超额proof/wrong bubble不消费；重复local的不同证明撤回歧义',()=>{
        const f=fixture(),proof=f.prove()!,other={...f.bubble};
        expect(consumer(f,undefined).choose(f.local,f.bubble)).toBe(f.local);expect(consumer(f,Array(65).fill(proof)).choose(f.local,f.bubble)).toBe(f.local);
        expect(consumer(f,[proof]).choose(f.local,other)).toBe(f.local);
        const duplicate={...proof,ordinal:2},third={...proof,ordinal:3};expect(consumer(f,[proof,duplicate,third]).choose(f.local,f.bubble)).toBe(f.local);
        expect(consumer(f,[proof,{...proof}]).choose(f.local,f.bubble).text).toBe('AB CD');
        expect(getMangaViewWordBoundaryProvenance({})).toBeUndefined();
    });
    it('即便外部wire同时改raw与快照，非支持字符/相同候选/反转decision也不能启用融合',()=>{
        const short=fixture(),proof=short.prove()!;short.whole.text=proof.wholeSnapshot.text='A B';short.local.text=proof.localSnapshot.text='AB';
        expect(consumer(short,[proof]).choose(short.local,short.bubble)).toBe(short.local);
        const equal=fixture(),same=equal.prove()!;equal.local.text=same.localSnapshot.text=equal.whole.text;
        expect(consumer(equal,[same]).choose(equal.local,equal.bubble)).toBe(equal.local);
        const reversed=fixture(),reverse=reversed.prove()!;reverse.preferred='local';expect(consumer(reversed,[reverse]).choose(reversed.local,reversed.bubble)).toBe(reversed.local);
        const changed=fixture(),snapshot=changed.prove()!;snapshot.localSnapshot.box.width--;
        expect(consumer(changed,[snapshot]).choose(changed.local,changed.bubble)).toBe(changed.local);
        const nonString=fixture(),invalid=nonString.prove()!;nonString.whole.text=invalid.wholeSnapshot.text=null as never;
        expect(consumer(nonString,[invalid]).choose(nonString.local,nonString.bubble)).toBe(nonString.local);
        const localNonString=fixture(),bad=localNonString.prove()!;localNonString.local.text=bad.localSnapshot.text=null as never;
        expect(consumer(localNonString,[bad]).choose(localNonString.local,localNonString.bubble)).toBe(localNonString.local);
    });
    it('没有proof默认局部优先，漫画/普通图都保留local几何，未关联区域不记来历',()=>{
        const f=fixture(),proof=f.prove()!;
        expect(collectMangaRegions({results:[f.whole],bubbles:[f.bubble]},'en',f.width,f.height,'image')[0].text).toBe('ABCD');
        const manga=collectMangaRegions({results:[f.whole],bubbles:[f.bubble],wordBoundaryProofs:[proof]},'en',f.width,f.height);
        expect(manga[0].text).toBe('AB CD');expect(getMangaViewWordBoundaryProvenance(manga[0])).toBeDefined();
        const c=consumer(f,[proof]),chosen=c.choose(f.local,f.bubble);c.accept(chosen,f.bubble);
        const other={text:'OTHER',bbox:{x0:100,y0:100,x1:150,y1:120},fontSize:20};c.record([other],[chosen]);expect(getMangaViewWordBoundaryProvenance(other)).toBeUndefined();
    });
    it.each(['image','manga'] as const)('嵌套气泡去重跳过outer融合，%s实际inner原文不能继承未采选proof',profile=>{
        const f=fixture(),proof=f.prove()!,innerLocal={...f.local,confidence:.995,box:{...f.local.box}},inner={bbox:{x0:0,y0:0,x1:100,y1:100},results:[innerLocal]};
        const before=JSON.stringify([f.whole,f.local,innerLocal]),regions=collectMangaRegions({results:[f.whole],bubbles:[inner,f.bubble],wordBoundaryProofs:[proof]},'en',f.width,f.height,profile);
        expect(regions).toHaveLength(1);expect(regions[0].text).toBe('ABCD');expect(getMangaViewWordBoundaryProvenance(regions[0])).toBeUndefined();
        expect(JSON.stringify([f.whole,f.local,innerLocal])).toBe(before);
    });
    it.each(['image','manga'] as const)('同一气泡同框独立输入仍按原规则保留，%s内部来历对歧义框撤回',profile=>{
        const f=fixture(),proof=f.prove()!,other={...f.local,box:{...f.local.box}};f.bubble.results.push(other);
        const regions=collectMangaRegions({results:[f.whole],bubbles:[f.bubble],wordBoundaryProofs:[proof]},'en',f.width,f.height,profile);
        expect(regions.map(region=>region.text).join(' ')).toContain('AB CD');expect(regions.map(region=>region.text).join(' ')).toContain('ABCD');
        expect(regions.every(region=>getMangaViewWordBoundaryProvenance(region)===undefined)).toBe(true);
    });
    it('选择本身无副作用；接受确认绑定实际融合对象和bubble，不按相同文字或框猜采用',()=>{
        const f=fixture(),proof=f.prove()!,c=consumer(f,[proof]),chosen=c.choose(f.local,f.bubble),region={text:'AB CD',bbox:{x0:40,y0:30,x1:73,y1:48},fontSize:18};
        c.record([region],[chosen]);expect(getMangaViewWordBoundaryProvenance(region)).toBeUndefined();
        c.accept(chosen,{...f.bubble});c.record([region],[chosen]);expect(getMangaViewWordBoundaryProvenance(region)).toBeUndefined();
        const exact=consumer(f,[proof]),actual=exact.choose(f.local,f.bubble);exact.accept(actual,f.bubble);
        exact.record([region],[{...actual}]);expect(getMangaViewWordBoundaryProvenance(region)).toBeUndefined();
        exact.record([region],[actual]);expect(getMangaViewWordBoundaryProvenance(region)).toBeDefined();
    });
    it('分组输入重复框或输出重复源框都撤回；实际未融合输入不能继承同框证明',()=>{
        const f=fixture(),proof=f.prove()!,c=consumer(f,[proof]),chosen=c.choose(f.local,f.bubble),region={text:'AB CD',bbox:{x0:40,y0:30,x1:73,y1:48},fontSize:18};c.accept(chosen,f.bubble);
        c.record([region],[chosen,chosen]);expect(getMangaViewWordBoundaryProvenance(region)).toBeUndefined();
        const clone={...region};c.record([region,clone],[chosen]);expect(getMangaViewWordBoundaryProvenance(region)).toBeUndefined();expect(getMangaViewWordBoundaryProvenance(clone)).toBeUndefined();
        const raw={...f.local,box:{...f.local.box,x:140}},rawRegion={text:raw.text,bbox:{x0:140,y0:30,x1:173,y1:48},fontSize:18};c.accept(raw,f.bubble);
        c.record([rawRegion],[raw]);expect(getMangaViewWordBoundaryProvenance(rawRegion)).toBeUndefined();
    });
    it.each(['whole','local','chosen'] as const)('确认之后%s原文/快照漂移也撤回来历，不保留此前record的结果',kind=>{
        const f=fixture(),proof=f.prove()!,c=consumer(f,[proof]),chosen=c.choose(f.local,f.bubble),region={text:'AB CD',bbox:{x0:40,y0:30,x1:73,y1:48},fontSize:18};c.accept(chosen,f.bubble);
        c.record([region],[chosen]);expect(getMangaViewWordBoundaryProvenance(region)).toBeDefined();
        if(kind==='whole')f.whole.text='AFTER';else if(kind==='local')f.local.confidence=.8;else chosen.text='AFTER';
        c.record([region],[chosen]);expect(getMangaViewWordBoundaryProvenance(region)).toBeUndefined();
    });
    it('两个实际采用的proof可合成一段，并按真实sourceBoxes保留各自双视图来历',()=>{
        const f=fixture(),first=f.prove()!,whole={...f.whole,box:{...f.whole.box,y:54}},local={...f.local,box:{...f.local.box,y:54}};f.bubble.results.push(local);
        for(let y=33;y<45;y++)f.data.copyWithin((y+24)*f.width*4,y*f.width*4,(y+1)*f.width*4);
        const second=f.budget.prove(whole,local,f.bubble)!;expect(second).toBeDefined();
        const regions=collectMangaRegions({results:[f.whole,whole],bubbles:[f.bubble],wordBoundaryProofs:[first,second]},'en',f.width,f.height,'manga');
        expect(regions).toHaveLength(1);expect(regions[0].text).toBe('AB CD AB CD');expect(regions[0].sourceBoxes).toHaveLength(2);
        expect(getMangaViewWordBoundaryProvenance(regions[0])).toEqual([first,second].map(proof=>({whole:proof.wholeSnapshot,local:proof.localSnapshot,textView:'whole',geometryView:'local'})));
    });
});
