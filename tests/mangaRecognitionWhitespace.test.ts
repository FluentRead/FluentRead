import {describe,it,expect} from 'vitest';
import {createMangaRecognitionWhitespace as create,MANGA_RECOGNITION_WHITESPACE_LIMITS as LIMIT,type MangaWhitespaceReceipt,type MangaWhitespaceRun} from '@/src/features/image-translation/services/mangaRecognitionWhitespace';

const C=LIMIT.classes;
const dictionary=Array<string>(C).fill('日');dictionary[0]=dictionary[C-1]='';
for(let index=33;index<127;index++)dictionary[index]=String.fromCharCode(index);
const box=()=>({width:120,height:48});
function image(width=120){
    const data=new Uint8ClampedArray(width*48*4);for(let i=0;i<data.length;i+=4)data.set([24,44,68,255],i);
    for(const [left,right]of[[10,17],[22,29],[34,41],[46,53],[74,81],[86,93]])for(let x=left;x<Math.min(right,width-1);x++)for(let y=12;y<36;y++)data.set([230,190,80,255],(y*width+x)*4);
    return data;
}
function output(T=40,rows=1,edit?:(data:Float32Array,T:number,row:number)=>void){
    const data=new Float32Array(T*C*rows),scale=(t:number)=>Math.floor(t*T/40);
    for(let row=0;row<rows;row++){
        for(let t=0;t<T;t++)data[(row*T+t)*C]=.9;
        for(const [i,char]of Array.from('AB12CD').entries()){
            const t=scale([3,8,13,18,31,36][i]),base=(row*T+t)*C;data[base]=.01;data[base+char.charCodeAt(0)]=.99;
        }
        data[(row*T+scale(21))*C+C-1]=.4;
        edit?.(data,T,row);
    }
    return{dims:[rows,T,C],data};
}
function start(options:Partial<MangaWhitespaceRun>={},signal?:AbortSignal){
    const controller=create(),boxes=options.boxes??[box()];controller.beginPage(signal);
    controller.beginRun({boxes,batchSize:boxes.length,dictionary,supportedPerBox:true,sourceRatioOne:true,...options});return{controller,boxes};
}
function finish(controller:ReturnType<typeof create>,boxes:readonly object[],value:{dims:readonly number[];data:unknown}=output(),texts=boxes.map(()=>'AB12CD')){
    const input={},widths=boxes.map(()=>120);
    controller.bindInput(input,{readIndices:boxes.map((_,i)=>i),resizedWidths:widths,paddedWidth:120,height:48});controller.observeOutput(input,value);
    const original=boxes.map((box,index)=>({text:texts[index],box,confidence:.8,extra:{index}}));
    return{original,result:controller.applyToSdkResults(original)};
}
function borrowed(controller:ReturnType<typeof create>,index=0,data=image(),width=120){controller.observeBorrowedRead(index,width,48,data);}
const noRead=()=>({dims:[1,40,C],get data():unknown{throw new Error('must not read logits');}});
function assertNoRecovery(options:Partial<MangaWhitespaceRun>={}){const {controller,boxes}=start(options);borrowed(controller);const r=finish(controller,boxes);expect(r.result).toBe(r.original);}

describe('物理空隙与原模型blank-run共同恢复空格',()=>{
    it('只clone改变行，保留框/置信/其他属性和原输入，借用像素不写回',()=>{
        const {controller,boxes}=start(),pixels=image(),copy=pixels.slice();borrowed(controller,0,pixels);
        const {original,result}=finish(controller,boxes);expect(result[0].text).toBe('AB12 CD');expect(result[0]).not.toBe(original[0]);
        expect(result[0].box).toBe(boxes[0]);expect(result[0].confidence).toBe(.8);expect(result[0].extra).toBe(original[0].extra);expect(original[0].text).toBe('AB12CD');expect(pixels).toEqual(copy);
    });
    it('读回后不再借用原RGBA，后续修改借用数组不改变已经冻结的空间依据',()=>{
        const {controller,boxes}=start(),pixels=image();borrowed(controller,0,pixels);pixels.fill(0);
        expect(finish(controller,boxes).result[0].text).toBe('AB12 CD');
    });
    it.each(['AB12 CD',' AB12  CD ','AB12\tCD','AB12XD'])('保持原空格、空白及非空字符不一致原文：%s',text=>{
        const {controller,boxes}=start();borrowed(controller);const r=finish(controller,boxes,output(),[text]);expect(r.result).toBe(r.original);
    });
    it('纯CJK/标点邻接不按拉丁字距补空格，未知字典项不猜字符',()=>{
        for(const char of ['日','!',undefined,'','LONG']){
            const dict=[...dictionary];dict[50]=char as string;const {controller,boxes}=start({dictionary:dict});borrowed(controller);
            const text=char==='日'?'AB1日CD':char==='!'?'AB1!CD':'AB12CD';const r=finish(controller,boxes,output(),[text]);expect(r.result).toBe(r.original);
        }
    });
    it('输出row映回原Box身份，置信过滤/reading-order重排不串行，同坐标不同对象仍区分',()=>{
        const boxes=[box(),box()],{controller}=start({boxes});borrowed(controller,0);borrowed(controller,1);
        const input={};controller.bindInput(input,{readIndices:[0,1],resizedWidths:[120,120],paddedWidth:120,height:48});
        controller.observeOutput(input,output(40,2,(data,T,row)=>{if(row===1)for(let t=0;t<T;t++)data[(row*T+t)*C+C-1]=0;}));
        const a={text:'AB12CD',box:boxes[1]},b={text:'AB12CD',box:boxes[0]},result=controller.applyToSdkResults([a,b]);
        expect(result[0]).toBe(a);expect(result[1].text).toBe('AB12 CD');expect(result[1].box).toBe(boxes[0]);
        expect(controller.applyToSdkResults([b])[0].text).toBe('AB12 CD');
    });
    it('完整结果Box集合先验，后续未知或重复身份不能泄漏前行的更改',()=>{
        const {controller,boxes}=start();borrowed(controller);finish(controller,boxes);
        for(const tail of [{text:'A',box:{}},{text:'A',box:boxes[0]}]){
            const original=[{text:'AB12CD',box:boxes[0]},tail];expect(controller.applyToSdkResults(original)).toBe(original);
        }
    });
    it('validSeq之外的字符不参与候选，空间坐标保留原paddedWidth/fullT',()=>{
        const boxes=[box(),{width:240,height:48}],{controller}=start({boxes});borrowed(controller);
        const input={};controller.bindInput(input,{readIndices:[0,1],resizedWidths:[120,240],paddedWidth:240,height:48});
        const out=output(80,2);controller.observeOutput(input,out);const original=[{text:'AB12',box:boxes[0]}];
        expect(controller.applyToSdkResults(original)).toBe(original);
    });
});

describe('物理提前准入和CTC反例',()=>{
    it.each(['alpha','edge','uniform','tracking','few-runs'] as const)('无物理显著空隙时零logits访问：%s',mode=>{
        const {controller,boxes}=start(),pixels=image();
        if(mode==='alpha')pixels[(20*120+30)*4+3]=254;
        if(mode==='edge')pixels[120*4+2]=99;
        if(mode==='uniform')for(let i=0;i<pixels.length;i+=4)pixels.set([24,44,68,255],i);
        if(mode==='tracking'||mode==='few-runs'){
            for(let i=0;i<pixels.length;i+=4)pixels.set([24,44,68,255],i);
            for(const x of mode==='tracking'?[10,20,30,40,50]:[10,30])pixels[(20*120+x)*4]=255;
        }
        borrowed(controller,0,pixels);const r=finish(controller,boxes,noRead());expect(r.result).toBe(r.original);
    });
    it('alpha0与96内部孔都拒绝物理恢复，不能把透明RGB当字间空白',()=>{
        for(const alpha of [0,96]){const {controller,boxes}=start(),pixels=image();pixels[(20*120+30)*4+3]=alpha;borrowed(controller,0,pixels);const r=finish(controller,boxes,noRead());expect(r.result).toBe(r.original);}
    });
    it.each(['below-threshold','gap-start','gap-end','outside-gap','no-blank','space-frame','multiple-runs'] as const)('相位/阈值/不明确CTC保守原路：%s',mode=>{
        const {controller,boxes}=start();borrowed(controller);
        const out=output(120,1,(data,T)=>{
            for(let t=0;t<T;t++)data[t*C+C-1]=0;
            let peak=mode==='gap-start'?52:mode==='gap-end'?74:mode==='outside-gap'?55:63;
            if(mode==='outside-gap')peak=80;
            data[peak*C+C-1]=mode==='below-threshold'?.0009:.4;
            if(mode==='no-blank')for(let t=55;t<93;t++){data[t*C]=.01;data[t*C+50]=.99;}
            if(mode==='space-frame'||mode==='multiple-runs'){const base=(mode==='space-frame'?55:62)*C;data[base]=.01;data[base+C-1]=.99;}
        });
        const r=finish(controller,boxes,out);expect(r.result).toBe(r.original);
    });
    it('稳定取第一个最大space峰，重复字帧可位于blank前；同一空隙多关联不插',()=>{
        const {controller,boxes}=start();borrowed(controller);
        const out=output(120,1,data=>{for(let t=0;t<120;t++)data[t*C+C-1]=0;data[54*C+50]=0;data[54*C]=.9;data[45*C]=.01;data[45*C+50]=.99;data[52*C+C-1]=.4;data[63*C+C-1]=.4;});
        const r=finish(controller,boxes,out);expect(r.result).toBe(r.original);
        // 两个不同ASCII边界都指向同一宽gap，拒绝全部而非任挑其一。
        const other=start();borrowed(other.controller);const duplicate=output(120,1,data=>{
            for(let t=0;t<120;t++){data[t*C]=.9;data[t*C+C-1]=0;for(const char of 'AB12CD')data[t*C+char.charCodeAt(0)]=0;}
            for(const [t,char]of[[10,'A'],[20,'B'],[30,'1'],[50,'2'],[60,'C'],[90,'D']] as const){data[t*C]=.01;data[t*C+char.charCodeAt(0)]=.99;}
            data[55*C+C-1]=.4;data[65*C+C-1]=.4;
        });expect(finish(other.controller,other.boxes,duplicate).result[0].text).toBe('AB12CD');
    });
    it('原模型重复类帧与直接space类不会被当新字符或抹掉已有空格',()=>{
        const {controller,boxes}=start();borrowed(controller);
        const out=output(40,1,data=>{data[19*C]=.01;data[19*C+50]=.99;data[25*C]=.01;data[25*C+C-1]=.99;});
        const r=finish(controller,boxes,out,['AB12 CD']);expect(r.result).toBe(r.original);
    });
    it.each([NaN,Infinity])('非有限blank/space/max回退且不修改Tensor：%s',invalid=>{
        for(const offset of [0,C-1,3*C+65]){const {controller,boxes}=start();borrowed(controller);const out=output();out.data[offset]=invalid;const copy=out.data.slice();const r=finish(controller,boxes,out);expect(r.result).toBe(r.original);expect(Buffer.from(out.data.buffer).equals(Buffer.from(copy.buffer))).toBe(true);}
    });
});

describe('控制器和SDK有效前缀并域，原恢复域/完整T坐标与累计预算保持',()=>{
    const paddedBoxes=()=>[box(),{width:240,height:48}];
    function paddedOutput(){
        const data=new Float32Array(2*80*C);data.set(output().data);
        return{dims:[2,80,C],data};
    }
    function runPadded(controller:ReturnType<typeof create>,boxes:readonly object[],out:{dims:readonly number[];data:unknown}){
        borrowed(controller);const input={};
        controller.bindInput(input,{readIndices:[0,1],resizedWidths:[120,240],paddedWidth:240,height:48});
        controller.observeOutput(input,out);const original=[{text:'AB12CD',box:boxes[0]}];
        return{original,result:controller.applyToSdkResults(original)};
    }
    it.each([
        {label:'blank NaN',channel:0,invalid:NaN},{label:'blank Infinity',channel:0,invalid:Infinity},
        {label:'space NaN',channel:C-1,invalid:NaN},{label:'space Infinity',channel:C-1,invalid:Infinity},
        {label:'max Infinity',channel:65,invalid:Infinity},
    ])('padding $label 不回退，相同坏值进入有效prefix仍保持原文且Tensor不变',({channel,invalid})=>{
        for(const t of [60,21]){
            const boxes=paddedBoxes(),{controller}=start({boxes}),out=paddedOutput();out.data[t*C+channel]=invalid;
            const before=Buffer.from(new Uint8Array(out.data.buffer)),r=runPadded(controller,boxes,out);
            if(t===60)expect(r.result[0].text).toBe('AB12 CD');else expect(r.result).toBe(r.original);
            expect(Buffer.from(out.data.buffer).equals(before)).toBe(true);
        }
    });
    it('任意finite padding尾部不影响结果，比例坐标仍为fullT而非validSeq',()=>{
        const boxes=paddedBoxes(),a=start({boxes}),b=start({boxes}),base=paddedOutput(),tail=paddedOutput();
        for(let t=40;t<80;t++){tail.data[t*C]=.1;tail.data[t*C+C-1]=.5;tail.data[t*C+90]=.9;}
        const clean=runPadded(a.controller,boxes,base),changed=runPadded(b.controller,boxes,tail);
        // t21 的点为(21.5)*240/80=64.5，在原gap内；若误用valid40分母会落到129而拒绝。
        expect(clean.result[0].text).toBe('AB12 CD');expect(changed.result[0].text).toBe(clean.result[0].text);
    });
    it('padding不发生任何数值读取；prefix真实读取异常仍原对象上抛',()=>{
        const boxes=paddedBoxes(),native=new Error('prefix read first');
        for(const throwPrefix of [false,true]){
            const {controller}=start({boxes}),out=paddedOutput();let largest=-1;
            const data=new Proxy(out.data,{get(target,key){
                if(typeof key==='string'&&/^\d+$/.test(key)){const index=Number(key);largest=Math.max(largest,index);if(index>=40*C||throwPrefix)throw native;}
                return Reflect.get(target,key,target);
            }});
            if(throwPrefix){try{runPadded(controller,boxes,{dims:out.dims,data});throw Error('must throw');}catch(actual){expect(actual).toBe(native);}}
            else{expect(runPadded(controller,boxes,{dims:out.dims,data}).result[0].text).toBe('AB12 CD');expect(largest).toBe(40*C-1);}
        }
    });
    it('25*56/200与25*(56/200)边界不同：SDK额外t7仍校验，但不进入原恢复域',()=>{
        const T=25,width=56,paddedWidth=200;
        expect(Math.ceil(T*width/paddedWidth)).toBe(7);expect(Math.ceil(T*(width/paddedWidth))).toBe(8);
        for(const [at,invalid]of [[7,false],[7,true],[8,true]] as const){
            const boxes=[{width,height:48},{width:paddedWidth,height:48}],{controller}=start({boxes}),pixels=new Uint8ClampedArray(width*48*4);
            for(let p=0;p<pixels.length;p+=4)pixels.set([24,44,68,255],p);
            for(const [left,right]of [[3,5],[8,10],[13,15],[18,20],[34,36],[39,41]])for(let x=left;x<right;x++)for(let y=12;y<36;y++)pixels[(y*width+x)*4]=230;
            controller.observeBorrowedRead(0,width,48,pixels);
            const input={};controller.bindInput(input,{readIndices:[0,1],resizedWidths:[width,paddedWidth],paddedWidth,height:48});
            const data=new Float32Array(2*T*C);for(let t=0;t<T;t++)data[t*C]=.9;
            for(const [t,char]of [[0,'A'],[2,'B'],[4,'C'],[6,'D']] as const){data[t*C]=.01;data[t*C+char.charCodeAt(0)]=.99;}
            data[3*C+C-1]=.4;data[at*C]=invalid?Infinity:.01;data[at*C+90]=.99;
            controller.observeOutput(input,{dims:[2,T,C],data});const original=[{text:'ABCD',box:boxes[0]}],result=controller.applyToSdkResults(original);
            if(at===7&&invalid)expect(result).toBe(original);else expect(result[0].text).toBe('AB CD');
        }
    });
    it('短prefix仍按fullT80跨run扣账，2000后第26行完全不读取output',()=>{
        const controller=create(),out=paddedOutput();controller.beginPage();
        for(let n=0;n<26;n++){
            const boxes=paddedBoxes();controller.beginRun({boxes,batchSize:2,dictionary,supportedPerBox:true,sourceRatioOne:true});
            const value=n<25?out:{dims:[2,80,C],get data():unknown{throw new Error('fullT budget must prevent read');}};
            expect(runPadded(controller,boxes,value).result[0].text).toBe(n<25?'AB12 CD':'AB12CD');controller.endRun();
        }
    });
});

describe('字典/身份/形状与生命周期的完整回退',()=>{
    it.each([
        {supportedPerBox:false},{sourceRatioOne:false},{batchSize:0},{batchSize:1.5},{batchSize:8193},
        {boxes:[]},{boxes:[{width:NaN,height:48}]},{boxes:[{width:120,height:Infinity}]},{boxes:[{width:0,height:48}]},
        {boxes:Array(8193).fill(box())},{dictionary:[]},{dictionary:Array(C).fill('')},
    ])('不支持的run不读取logits或更改原文 %#',options=>assertNoRecovery(options));
    it('空白首末标记错误及重复同一Box对象禁用；无效尺寸框按SDK原序排除',()=>{
        for(const where of [0,C-1]){const dict=[...dictionary];dict[where]='X';assertNoRecovery({dictionary:dict});}
        const b=box();assertNoRecovery({boxes:[b,b]});
        const valid=box(),{controller}=start({boxes:[{width:0,height:48},valid,{width:1,height:-1}]});borrowed(controller);
        expect(finish(controller,[valid]).result[0].text).toBe('AB12 CD');
    });
    it.each([
        {index:-1},{index:1},{index:.5},{width:7},{width:NaN},{height:47},{width:5462},
        {data:new Uint8Array(120*48*4)},{data:new Uint8ClampedArray(3)},
    ])('未知read形状/原索引不关联 %#',patch=>{
        const {controller,boxes}=start();controller.observeBorrowedRead(patch.index??0,patch.width??120,patch.height??48,(patch.data??image()) as Uint8ClampedArray);
        const r=finish(controller,boxes);expect(r.result).toBe(r.original);
    });
    it('重复/逆序read禁用整个可选run，不留此前候选',()=>{
        const {controller,boxes}=start();borrowed(controller);borrowed(controller);expect(finish(controller,boxes).result[0].text).toBe('AB12CD');
    });
    it.each([
        {readIndices:[]},{readIndices:[1]},{readIndices:[.5]},{resizedWidths:[]},{resizedWidths:[7]},
        {resizedWidths:[121]},{paddedWidth:121},{paddedWidth:NaN},{height:47},
    ])('不完整receipt整run原文 %#',patch=>{
        const {controller,boxes}=start();borrowed(controller);const input={};controller.bindInput(input,{readIndices:[0],resizedWidths:[120],paddedWidth:120,height:48,...patch} as MangaWhitespaceReceipt);controller.observeOutput(input,output());
        const original=[{text:'AB12CD',box:boxes[0]}];expect(controller.applyToSdkResults(original)).toBe(original);
    });
    it('原stable排序/重复receipt/重叠native和未知input均不猜关联',()=>{
        for(const mode of ['order','repeat','pending','input','null'] as const){
            const {controller,boxes}=start({boxes:[box(),box()],batchSize:1});borrowed(controller,0);borrowed(controller,1);const input={};
            controller.bindInput((mode==='null'?null:input) as object,{readIndices:[mode==='order'?1:0],resizedWidths:[120],paddedWidth:120,height:48});
            if(mode==='pending')controller.bindInput({}, {readIndices:[1],resizedWidths:[120],paddedWidth:120,height:48});
            controller.observeOutput(mode==='input'?{}:input,output());
            controller.bindInput(input,{readIndices:[mode==='repeat'?0:mode==='order'?0:1],resizedWidths:[120],paddedWidth:120,height:48});controller.observeOutput(input,output());
            const original=boxes.map(box=>({text:'AB12CD',box}));expect(controller.applyToSdkResults(original)).toBe(original);
        }
    });
    it.each([[1,40],[1,40,C+1],[2,40,C],[1,0,C],[1,NaN,C],[1,Number.MAX_SAFE_INTEGER,C]])('未知output shape完整原文：%j',(...dims)=>{
        const {controller,boxes}=start();borrowed(controller);const input={};controller.bindInput(input,{readIndices:[0],resizedWidths:[120],paddedWidth:120,height:48});controller.observeOutput(input,{dims,data:new Float32Array()});const original=[{text:'AB12CD',box:boxes[0]}];expect(controller.applyToSdkResults(original)).toBe(original);
    });
    it.each([null,new Float64Array(),new Float32Array(3)])('未知output dtype/length不尝试修复：%s',data=>{
        const {controller,boxes}=start();borrowed(controller);const input={};controller.bindInput(input,{readIndices:[0],resizedWidths:[120],paddedWidth:120,height:48});controller.observeOutput(input,{dims:[1,40,C],data});const original=[{text:'AB12CD',box:boxes[0]}];expect(controller.applyToSdkResults(original)).toBe(original);
    });
    it('无beginPage、endRun/endPage、pending或漏batch均回原数组',()=>{
        const controller=create(),b=box(),original=[{text:'AB12CD',box:b}];controller.beginRun({boxes:[b],batchSize:1,dictionary,supportedPerBox:true,sourceRatioOne:true});borrowed(controller);controller.bindInput({}, {readIndices:[0],resizedWidths:[120],paddedWidth:120,height:48});controller.observeOutput({},output());expect(controller.applyToSdkResults(original)).toBe(original);
        controller.beginPage();controller.beginRun({boxes:[b],batchSize:1,dictionary,supportedPerBox:true,sourceRatioOne:true});borrowed(controller);expect(controller.applyToSdkResults(original)).toBe(original);
        controller.bindInput({}, {readIndices:[0],resizedWidths:[120],paddedWidth:120,height:48});expect(controller.applyToSdkResults(original)).toBe(original);controller.endRun();expect(controller.applyToSdkResults(original)).toBe(original);controller.endPage();borrowed(controller);expect(controller.applyToSdkResults(original)).toBe(original);
    });
    it('取消/换页清原metadata，不创建竞争AbortError；真实getter异常同对象上抛',()=>{
        const abort=new AbortController(),{controller,boxes}=start({},abort.signal);borrowed(controller);abort.abort(new Error('original abort'));const r=finish(controller,boxes,noRead());expect(r.result).toBe(r.original);
        controller.beginPage();controller.beginRun({boxes,batchSize:1,dictionary,supportedPerBox:true,sourceRatioOne:true});borrowed(controller);const input={};controller.bindInput(input,{readIndices:[0],resizedWidths:[120],paddedWidth:120,height:48});
        const native=new Error('output native first');try{controller.observeOutput(input,{dims:[1,40,C],get data(){throw native;}});throw Error('must throw');}catch(actual){expect(actual).toBe(native);}controller.endRun();controller.endPage();
        const fresh=start();const bad={get width():number{throw native;},height:48};expect(()=>fresh.controller.beginRun({boxes:[bad],batchSize:1,dictionary,supportedPerBox:true,sourceRatioOne:true})).toThrow(native);
    });
});

describe('共享页累计工作量不因run结束退款',()=>{
    function next(controller:ReturnType<typeof create>,width=120){const boxes=[{width,height:48}];controller.beginRun({boxes,batchSize:1,dictionary,supportedPerBox:true,sourceRatioOne:true});return boxes;}
    it('128个project尝试封顶，失败外周也计数；下一页才重新准入',()=>{
        const controller=create();controller.beginPage();const bad=image(8);
        for(let i=0;i<128;i++){next(controller,8);borrowed(controller,0,bad,8);controller.endRun();}
        const boxes=next(controller);borrowed(controller);expect(finish(controller,boxes,noRead()).result[0].text).toBe('AB12CD');controller.endPage();controller.beginPage();const fresh=next(controller);borrowed(controller);expect(finish(controller,fresh).result[0].text).toBe('AB12 CD');
    });
    it('同源2MP防御计数不提供第二额度，不保存RGBA引用',()=>{
        const controller=create();controller.beginPage();
        for(const width of [...Array(8).fill(5000),1600]){next(controller,width);borrowed(controller,0,new Uint8ClampedArray(width*48*4),width);controller.endRun();}
        const boxes=next(controller);borrowed(controller);expect(finish(controller,boxes,noRead()).result[0].text).toBe('AB12CD');
    });
    it('4096support run封顶，后续行不再扫描logits',()=>{
        const controller=create();controller.beginPage();const width=5000,data=new Uint8ClampedArray(width*48*4);for(let i=3;i<data.length;i+=4)data[i]=255;for(let x=1;x<width-1;x+=2)data[(20*width+x)*4]=255;
        for(let i=0;i<2;i++){next(controller,width);borrowed(controller,0,data,width);controller.endRun();}
        const boxes=next(controller);borrowed(controller);expect(finish(controller,boxes,noRead()).result[0].text).toBe('AB12CD');
    });
    it('4096的最后一个support run允许准入，仅后续新run回原路',()=>{
        const controller=create();controller.beginPage();const width=4092,data=new Uint8ClampedArray(width*48*4);for(let i=3;i<data.length;i+=4)data[i]=255;for(let x=1;x<width-1;x+=2)data[(20*width+x)*4]=255;
        // 每张2045个独立support runs；4090之后正常6-run行正好达到4096。
        for(let i=0;i<2;i++){next(controller,width);borrowed(controller,0,data,width);controller.endRun();}
        const exact=next(controller);borrowed(controller);expect(finish(controller,exact).result[0].text).toBe('AB12 CD');controller.endRun();
        const later=next(controller);borrowed(controller);expect(finish(controller,later,noRead()).result[0].text).toBe('AB12CD');
    });
    it('完整Tsteps上限跨run共享，2000以内可用、随后整行不读output',()=>{
        const controller=create();controller.beginPage();const out=output(1000);
        for(let i=0;i<2;i++){const boxes=next(controller);borrowed(controller);expect(finish(controller,boxes,out).result[0].text).toBe('AB12 CD');controller.endRun();}
        const boxes=next(controller);borrowed(controller);expect(finish(controller,boxes,noRead()).result[0].text).toBe('AB12CD');
    });
    it('同批后续候选也不得越过共享T上限，未获准行不扫描',()=>{
        const boxes=[box(),box(),box()],{controller}=start({boxes});borrowed(controller,0);borrowed(controller,1);borrowed(controller,2);const r=finish(controller,boxes,output(800,3));expect(r.result.map(x=>x.text)).toEqual(['AB12 CD','AB12 CD','AB12CD']);
    });
    it('constants冻结且完全无Canvas、模型或会话端口',()=>{expect(Object.isFrozen(LIMIT)).toBe(true);expect(Object.keys(create()).sort()).toEqual(['applyToSdkResults','beginPage','beginRun','bindInput','endPage','endRun','observeBorrowedRead','observeOutput']);});
});
