import {describe,expect,it} from 'vitest';
import {findMangaBubbles,findMangaBubbleLayout,assignMangaLayoutBubbles,collectMangaRegions} from '@/src/features/image-translation/services/mangaBubbles';
const image=(w:number,h:number)=>new Uint8ClampedArray(w*h*4);
function rect(p:Uint8ClampedArray,w:number,x:number,y:number,width:number,height:number,color=[255,255,255,255]){for(let yy=y;yy<y+height;yy++)for(let xx=x;xx<x+width;xx++)p.set(color,(yy*w+xx)*4);}
const text=(value:string,x:number,y:number,width=40,height=12)=>({text:value,confidence:.99,box:{x,y,width,height}});
const box=(x:number,y:number,w=80,h=80)=>({x0:x,y0:y,x1:x+w,y1:y+h});
// 独立的逐像素四邻域 BFS 作为扫描行实现的拓扑 oracle，保留面积、排序和阈值语义。
function referenceBubbles(pixels:Uint8ClampedArray,width:number,height:number){
    const white=Array.from({length:width*height},(_,index)=>{
        const p=index*4;return pixels[p]>235&&pixels[p+1]>235&&pixels[p+2]>235&&pixels[p+3]>=128;
    }),found:Array<{bbox:ReturnType<typeof box>;area:number}>=[];
    for(let start=0;start<white.length;start++){
        if(!white[start])continue;
        const queue=[start];white[start]=false;let left=width,right=0,top=height,bottom=0;
        for(let head=0;head<queue.length;head++){
            const index=queue[head],x=index%width,y=Math.floor(index/width);
            left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
            for(const neighbor of [x>0?index-1:-1,x+1<width?index+1:-1,y>0?index-width:-1,y+1<height?index+width:-1]){
                if(neighbor>=0&&white[neighbor]){white[neighbor]=false;queue.push(neighbor);}
            }
        }
        const w=right-left+1,h=bottom-top+1,area=queue.length;
        if(left===0||top===0||right===width-1||bottom===height-1||w<30||h<30||area<1000||area/(w*h)<.45||area>width*height*.15)continue;
        found.push({bbox:box(left,top,w,h),area});
    }
    return found.sort((a,b)=>b.area-a.area).slice(0,24).map(entry=>entry.bbox);
}
describe('漫画局部气泡识别边界',()=>{
    it('大型曲边气泡只提供归属，原有小裁图和二十四候选预算不变',()=>{
        const width=500,height=500,p=image(width,height);
        for(let y=40;y<370;y++)for(let x=50;x<300;x++)if(((x-175)/125)**2+((y-205)/165)**2<1)p.set([255,255,255,255],(y*width+x)*4);
        rect(p,width,360,390,40,40);
        const layout=findMangaBubbleLayout(p,width,height);
        expect(layout.recognition).toEqual([box(360,390,40,40)]);
        expect(layout.ownership).toHaveLength(1);
        expect(layout.ownership[0]).toMatchObject({y0:124,y1:287});
        expect(layout.ownership[0].x0).toBeGreaterThan(51);expect(layout.ownership[0].x1).toBeLessThan(300);
        expect(findMangaBubbles(p,width,height)).toEqual(layout.recognition);
        expect(findMangaBubbleLayout(image(1,1),0,1)).toEqual({recognition:[],ownership:[]});
        expect(findMangaBubbleLayout(image(1,1),8193,1)).toEqual({recognition:[],ownership:[]});
    });
    it('大型矩形、多洞面板、过大椭圆和单侧平边组件均不能提供宽列归属',()=>{
        const width=500,height=500;
        for(const shape of ['rectangle','holes','too-large','flat-top','flat-bottom','curved-holes','empty-intersection']){
            const p=image(width,height);
            if(shape==='rectangle'||shape==='holes'){
                rect(p,width,50,50,300,300);
                if(shape==='holes')rect(p,width,90,90,180,160,[0,0,0,255]);
            }else if(shape==='empty-intersection'){
                for(let row=0;row<300;row++){
                    const span=Math.max(1,row<150?row*2:(299-row)*2);
                    rect(p,width,row<150?50:350-span,100+row,span,1);
                }
            }else{
                const radius=shape==='too-large'?210:145;
                for(let y=20;y<480;y++)for(let x=20;x<480;x++)if(((x-250)/radius)**2+((y-250)/radius)**2<1)p.set([255,255,255,255],(y*width+x)*4);
                if(shape==='flat-top')rect(p,width,106,105,289,80);
                if(shape==='flat-bottom')rect(p,width,106,315,289,81);
                if(shape==='curved-holes')rect(p,width,220,190,60,100,[0,0,0,255]);
            }
            expect(findMangaBubbleLayout(p,width,height).ownership,shape).toEqual([]);
        }
    });
    it('仅漫画使用大型气泡归属，宽竖列保留右到左顺序及原框，不吞较小气泡或外部旁白',()=>{
        const right=text('右側の本文',430,90,40,300),left=text('左側の本文',270,90,40,300);
        const small=text('別の声',110,120,30,150),caption=text('外の説明',540,90,100,20);
        const page={results:[left,right,small,caption],bubbles:[{bbox:box(90,100,90,210),results:[]}],layoutBubbles:[{bbox:box(50,40,450,400),members:[0,0,1,2,-1,.5]}]};
        const result=collectMangaRegions(page,'ja',700,700);
        expect(result.map(line=>line.text)).toEqual(['外の説明','右側の本文左側の本文','別の声']);
        expect(result[1].sourceBoxes).toEqual([{x0:430,y0:90,x1:470,y1:390},{x0:270,y0:90,x1:310,y1:390}]);
        expect(collectMangaRegions(page,'ja',700,700,'image').map(line=>line.text)).toEqual(['左側の本文','右側の本文','外の説明','別の声']);
        expect(collectMangaRegions({results:[left,right]},'ja',700,700)).toHaveLength(2);
    });
    it('曲边角落和气泡内黑色旁白卡片均不成为大气泡成员，原结果索引与独立文字保留',()=>{
        for(const card of [false,true]){
            const width=500,height=500,p=image(width,height);
            for(let y=40;y<370;y++)for(let x=50;x<300;x++)if(((x-175)/125)**2+((y-205)/165)**2<1)p.set([255,255,255,255],(y*width+x)*4);
            if(card)rect(p,width,195,160,30,80,[0,0,0,255]);
            const caption=card?text('外の注釈',200,170,20,60):text('外の注釈',52,42,20,60);
            const body=text('本文の列',130,150,20,80),items=[caption,body],snapshot=structuredClone(items);
            const layout=findMangaBubbleLayout(p,width,height),assigned=assignMangaLayoutBubbles(p,width,height,layout.ownership,items);
            expect(layout.ownership).toHaveLength(1);expect(assigned.map(owner=>owner.members)).toEqual([[1]]);
            expect(collectMangaRegions({results:items,layoutBubbles:assigned},'ja',width,height)).toHaveLength(2);
            expect(items).toEqual(snapshot);
        }
    });
    it('成员浅底取样需十二点中至少九点，非法框或不足像素不能靠夹边通过',()=>{
        const width=100,height=100,bbox=box(1,1,90,90),item=text('本文',20,20,40,40),p=image(width,height).fill(255);
        const samples=[[20,20],[33,20],[46,20],[59,20],[20,33],[59,33],[20,46],[59,46],[20,59],[33,59],[46,59],[59,59]];
        for(const [index,[x,y]] of samples.slice(0,3).entries()){
            const color=[255,255,255,255];color[index]=235;rect(p,width,x,y,1,1,color);
        }
        expect(assignMangaLayoutBubbles(p,width,height,[bbox],[item])[0].members).toEqual([0]);
        rect(p,width,59,20,1,1,[255,255,255,127]);expect(assignMangaLayoutBubbles(p,width,height,[bbox],[item])).toEqual([]);
        const invalid=[text('x',NaN,20),text('x',-1,20),text('x',20,-1),text('x',20,20,0),text('x',20,20,20,0),text('x',90,20),text('x',20,95)];
        expect(assignMangaLayoutBubbles(p,width,height,[bbox],invalid)).toEqual([]);
        expect(assignMangaLayoutBubbles(p,width,height,[],[item])).toEqual([]);
        expect(assignMangaLayoutBubbles(p,width,height,[box(70,70,20,20)],[item])).toEqual([]);
        for(const [w,h] of [[0,1],[8193,1],[4097,4097],[100,100]])expect(assignMangaLayoutBubbles(image(1,1),w,h,[bbox],[item])).toEqual([]);
    });
    it('小于局部识别最小边的独立黑边白卡也不归属外层对白，不发送排除元数据',()=>{
        const width=500,height=500,p=image(width,height);
        for(let y=40;y<370;y++)for(let x=50;x<300;x++)if(((x-175)/125)**2+((y-205)/165)**2<1)p.set([255,255,255,255],(y*width+x)*4);
        rect(p,width,195,160,28,80,[0,0,0,255]);rect(p,width,197,162,24,76);
        const items=[text('外の注釈',199,170,20,60),text('本文の列',130,150,20,80)];
        const originalItems=structuredClone(items),originalPixels=p.slice(),layout=findMangaBubbleLayout(p,width,height);
        expect(layout.recognition).toEqual([]);expect(layout.ownership).toHaveLength(1);
        expect(layout.ownership[0].exclusions).toEqual([box(197,162,24,76)]);
        const assigned=assignMangaLayoutBubbles(p,width,height,layout.ownership,items);
        expect(assigned).toEqual([{bbox:box(67,124,217,163),members:[1]}]);
        expect(Object.keys(assigned[0].bbox)).toEqual(['x0','y0','x1','y1']);
        const result=collectMangaRegions({results:items,layoutBubbles:assigned},'ja',width,height);
        expect(result.map(region=>region.text)).toEqual(['本文の列','外の注釈']);
        expect(result.flatMap(region=>region.sourceBoxes)).toEqual([box(130,150,20,80),box(199,170,20,60)]);
        expect(items).toEqual(originalItems);expect(p.every((value,index)=>value===originalPixels[index])).toBe(true);
    });
    it('白卡跨内接框上沿或下沿时仍按原组件外接范围排除，不误并框内中心的旁白',()=>{
        for(const [cardTop,captionTop,bodyTop] of [[110,124,150],[220,230,220]]){
            const width=500,height=500,p=image(width,height);
            for(let y=40;y<370;y++)for(let x=50;x<300;x++)if(((x-175)/125)**2+((y-205)/165)**2<1)p.set([255,255,255,255],(y*width+x)*4);
            rect(p,width,195,cardTop,28,80,[0,0,0,255]);rect(p,width,197,cardTop+2,24,76);
            const items=[text('外の注釈',199,captionTop,20,60),text('本文の列',130,bodyTop,20,80)];
            const layout=findMangaBubbleLayout(p,width,height),owner=layout.ownership[0];
            expect(owner.exclusions).toEqual([box(197,cardTop+2,24,76)]);
            expect(cardTop<owner.y0||cardTop+80>owner.y1).toBe(true);
            const assigned=assignMangaLayoutBubbles(p,width,height,layout.ownership,items);
            expect(assigned.map(entry=>entry.members)).toEqual([[1]]);
            expect(collectMangaRegions({results:items,layoutBubbles:assigned},'ja',width,height)).toHaveLength(2);
        }
    });
    it('排除岛只剥离完整落入的物理框，字形孔洞只覆盖中心或部分边界不能剥离整行',()=>{
        const p=image(100,100).fill(255),owner={...box(1,1,98,98),exclusions:[box(30,30,40,40)]};
        const items=[text('卡片内部',30,30,40,40),text('跨左边界',29,30,40,40),text('跨上边界',30,29,40,40),
            text('跨右边界',31,30,40,40),text('跨下边界',30,31,40,40),text('整行含孔洞',20,20,60,60)];
        expect(assignMangaLayoutBubbles(p,100,100,[owner],items)).toEqual([{bbox:box(1,1,98,98),members:[1,2,3,4,5]}]);
        expect(assignMangaLayoutBubbles(p,100,100,[{...owner,exclusions:[]}],items)[0].members).toEqual([0,1,2,3,4,5]);
    });
    it('小字形孔洞须至少五像素边且二十五像素面积才记录为排除岛',()=>{
        const width=500,height=500,p=image(width,height);
        for(let y=40;y<370;y++)for(let x=50;x<300;x++)if(((x-175)/125)**2+((y-205)/165)**2<1)p.set([255,255,255,255],(y*width+x)*4);
        for(const [x,w,h] of [[120,4,7],[140,7,4],[160,5,5],[180,5,5]]){
            rect(p,width,x-1,159,w+2,h+2,[0,0,0,255]);rect(p,width,x,160,w,h);
        }
        rect(p,width,160,160,1,1,[0,0,0,255]);
        expect(findMangaBubbleLayout(p,width,height).ownership[0].exclusions).toEqual([box(180,160,5,5)]);
    });
    it('每大气泡最多一百二十八个排除岛，触顶仅撤回该新增归属且原识别候选不变',()=>{
        for(const count of [128,129]){
            const width=1000,height=500,p=image(width,height);
            for(const center of [245,755])for(let y=40;y<460;y++)for(let x=center-210;x<center+210;x++)if(((x-center)/210)**2+((y-250)/210)**2<1)p.set([255,255,255,255],(y*width+x)*4);
            for(let index=0;index<count;index++){
                const x=150+(index%16)*9,y=160+Math.floor(index/16)*9;
                rect(p,width,x,y,7,7,[0,0,0,255]);rect(p,width,x+1,y+1,5,5);
            }
            rect(p,width,750,220,7,7,[0,0,0,255]);rect(p,width,751,221,5,5);
            rect(p,width,200,480,5,5);rect(p,width,480,20,35,35);
            const layout=findMangaBubbleLayout(p,width,height);
            expect(layout.recognition).toEqual([box(480,20,35,35)]);
            expect(layout.recognition).toEqual(referenceBubbles(p,width,height));
            expect(layout.ownership).toHaveLength(count===128?2:1);
            expect(layout.ownership.at(-1)?.exclusions).toEqual([box(751,221,5,5)]);
            const items=[text('右側の本文',280,300,20,80),text('左側の本文',200,300,20,80)];
            const assigned=assignMangaLayoutBubbles(p,width,height,layout.ownership,items);
            expect(collectMangaRegions({results:items,layoutBubbles:assigned},'ja',width,height)).toHaveLength(count===128?1:2);
            if(count===128)expect(layout.ownership[0].exclusions).toHaveLength(128);
        }
    });
    it('独立浅色岛复用唯一原像素分类扫描，不重新读取 RGBA 或复制原图',()=>{
        const width=500,height=500,p=image(width,height),reads=new Uint8Array(p.length);
        for(let y=40;y<370;y++)for(let x=50;x<300;x++)if(((x-175)/125)**2+((y-205)/165)**2<1)p.set([255,255,255,255],(y*width+x)*4);
        rect(p,width,195,160,28,80,[0,0,0,255]);rect(p,width,197,162,24,76);
        // Proxy 仅记录数值下标读取；typed array length 仍以真实接收者读取。
        const observed=new Proxy(p,{get(target,key){if(typeof key==='string'&&/^\d+$/u.test(key))reads[Number(key)]++;return Reflect.get(target,key,target);}});
        const layout=findMangaBubbleLayout(observed,width,height);
        expect(layout.ownership[0].exclusions).toEqual([box(197,162,24,76)]);
        expect(reads.some(count=>count>1)).toBe(false);
        expect(reads.some(count=>count===1)).toBe(true);
    });
    it('扫描行保持孔洞、桥接、对角分离及随机像素的四邻域面积和排序',()=>{
        let state=0x1068;const next=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
        for(let sample=0;sample<40;sample++){
            const width=240,height=220,p=image(width,height);
            for(let index=0;index<6;index++){
                const x=10+index%3*75,y=10+Math.floor(index/3)*100;
                rect(p,width,x,y,40+next()%20,40+next()%20);
                for(let noise=0;noise<35;noise++)rect(p,width,x+next()%50,y+next()%50,1,1,[0,0,0,255]);
            }
            // 细桥和孔洞会改变连通性与面积，不能用包围框替代四邻域。
            rect(p,width,45,30,50,1);rect(p,width,20,20,8,14,[0,0,0,255]);
            if(sample%2)rect(p,width,0,0,width,3);
            expect(findMangaBubbles(p,width,height)).toEqual(referenceBubbles(p,width,height));
        }
        const p=image(260,220);
        for(let y=1;y<219;y++)for(let x=1;x<259;x++)if(y%2||x%2)p.set([255,255,255,255],(y*260+x)*4);
        expect(findMangaBubbles(p,260,220)).toEqual(referenceBubbles(p,260,220));
        const diagonal=image(200,200);rect(diagonal,200,10,10,40,40);rect(diagonal,200,50,50,40,40);
        expect(findMangaBubbles(diagonal,200,200)).toEqual(referenceBubbles(diagonal,200,200));
    });
    it('普通截图 Paddle 保留源行供严格段落分组，局部放大结果替换重复检测', () => {
        const page = {results: [text('wrong small', 25, 30), text('Title', 160, 180, 90, 16), text('Body line', 160, 200, 200, 12)],
            bubbles: [{bbox: box(10, 10), results: [text('First', 20, 20), text('second', 20, 34)]}]};
        const lines = collectMangaRegions(page, 'en', 400, 400, 'image');
        expect(lines.map(line => line.text)).toEqual(['First', 'second', 'Title', 'Body line']);
        expect(lines.every(line => line.sourceBoxes === undefined)).toBe(true);
        expect(collectMangaRegions({results: []}, 'en', 400, 400, 'image')).toEqual([]);
    });
    it('拒绝无效尺寸和像素预算，定位封闭浅色气泡而非页面背景',()=>{
        for(const [w,h] of [[0,100],[1.5,100],[100,NaN],[4097,4097],[200,200]])expect(findMangaBubbles(image(1,1),w,h)).toEqual([]);
        for(const [w,h] of [[1,1],[1,31],[31,1]])expect(findMangaBubbles(image(w,h).fill(255),w,h)).toEqual([]);
        const p=image(300,300);rect(p,300,30,40,40,40);rect(p,300,170,150,60,40);rect(p,300,0,0,20,300);
        expect(findMangaBubbles(p,300,300)).toEqual([box(170,150,60,40),box(30,40,40,40)]);
    });
    it('排除四条页面边界、过小、过大、透明和稀疏区域',()=>{
        const p=image(800,800);rect(p,800,0,100,40,40);rect(p,800,100,0,40,40);rect(p,800,760,100,40,40);rect(p,800,100,760,40,40);
        rect(p,800,200,200,29,60);rect(p,800,240,200,60,29);rect(p,800,310,200,30,30);rect(p,800,360,200,350,350);
        rect(p,800,200,400,100,8);rect(p,800,200,400,8,100);rect(p,800,30,600,40,40,[255,255,255,127]);
        rect(p,800,100,600,40,40,[235,255,255,255]);rect(p,800,160,600,40,40,[255,235,255,255]);rect(p,800,220,600,40,40,[255,255,235,255]);
        expect(findMangaBubbles(p,800,800)).toEqual([]);
    });
    it('像素相邻且只使用四邻域，候选最多二十四个',()=>{
        const p=image(900,900);for(let y=0;y<6;y++)for(let x=0;x<6;x++)rect(p,900,10+x*140,10+y*140,35,35);
        expect(findMangaBubbles(p,900,900)).toHaveLength(24);
        const edge=image(100,100);rect(edge,100,0,0,1,100);rect(edge,100,0,0,100,1);rect(edge,100,99,0,1,100);rect(edge,100,0,99,100,1);
        expect(findMangaBubbles(edge,100,100)).toEqual([]);
    });
    it('局部识别替换整页重复结果，不跨气泡拼句',()=>{
        const page={results:[text('small incorrect',25,32),text('Outside caption',160,180)],bubbles:[{bbox:box(10,10),results:[text('Hello',20,20),text('world',20,36)]}]};
        expect(collectMangaRegions(page,'en',400,400).map(r=>r.text)).toEqual(['Hello world','Outside caption']);
        expect(collectMangaRegions({results:page.results},'en',400,400)).toHaveLength(2);
    });
    it('嵌套浅色面板的同一行只翻译一次，保留不同位置相同对白与局部漏行',()=>{
        // 真实 repeated-dialogue-distinct-panels 1000×1500 的源框回放。
        const together=text('WE WILL GO TOGETHER',209.880859375,1168.0378486055777,525.55078125,34.201195219123505);
        const inner=text('WE WILL GO TOGETHER',208.275390625,1170.189723320158,527.474609375,31.857707509881422);
        const first=text('WAIT FOR ME',326.43880208333337,168.3723849372385,311.04427083333337,37.05439330543933);
        const second={...first,box:{...first.box,y:first.box.y+480}};
        const page={results:[together,first,second],bubbles:[
            {bbox:box(30,1006,941,465),results:[together]}, {bbox:box(55,1055,891,291),results:[inner]},
            {bbox:box(105,85,791,246),results:[first]}, {bbox:box(105,565,791,246),results:[second]}]};
        for(const profile of ['manga','image'] as const){
            const result=collectMangaRegions(page,'en',1000,1500,profile);
            expect(result.map(line=>line.text)).toEqual(['WAIT FOR ME','WAIT FOR ME','WE WILL GO TOGETHER']);
            expect(result[2].bbox.y0).toBe(inner.box.y);
        }
        const firstLine=text('First complete line',70,80,150,12),lastLine=text('Last fallback line',70,97,150,12);
        const nested={results:[firstLine,lastLine],bubbles:[{bbox:box(10,10,300,300),results:[firstLine]},
            {bbox:box(50,60,200,100),results:[firstLine]}]};
        expect(collectMangaRegions(nested,'en',400,400).map(line=>line.text)).toEqual(['First complete line Last fallback line']);
        // 同一候选的可靠行不互相去重，较小碎片也不能替换整条原文。
        const distinct={results:[],bubbles:[{bbox:box(10,10,200,120),results:[firstLine,lastLine]},
            {bbox:box(50,60,180,80),results:[text('short',70,80,25,12)]}]};
        expect(collectMangaRegions(distinct,'en',400,400,'image').map(line=>line.text)).toEqual(['First complete line','short','Last fallback line']);
    });
    it('外层局部补回内层漏行时归入最紧气泡，同一对白完整合段且邻近对白独立',()=>{
        const first=text('First complete line',70,80,150,12),last=text('Last recovered line',70,97,150,12);
        const neighbor=text('Another speaker',270,80,130,12);
        const page={results:[first,last,neighbor],bubbles:[
            {bbox:box(10,10,420,220),results:[first,last,neighbor]},
            {bbox:box(50,60,200,100),results:[first]},
            {bbox:box(260,60,150,100),results:[neighbor]},
        ]};
        const result=collectMangaRegions(page,'en',500,400);
        expect(result.map(line=>line.text)).toEqual(['Another speaker','First complete line Last recovered line']);
        expect(result[1].sourceBoxes).toEqual([{x0:70,y0:80,x1:220,y1:92},{x0:70,y0:97,x1:220,y1:109}]);
        expect(collectMangaRegions(page,'en',500,400,'image').map(line=>line.text)).toEqual(['First complete line','Another speaker','Last recovered line']);
    });
    it('独立气泡中略宽行距的英文保持整句，原始修补框不扩张，整页仍不跨框合并',()=>{
        const lines=[text('I ALREADY HAD',40,40,92,8),text('THE BIRD OPEN',40,55,92,7),text("IT, IT'S FINE.",51,69,70,8)];
        const page={results:[],bubbles:[{bbox:box(20,20,130,90),results:lines},{bbox:box(180,20,130,90),results:[text('Next speaker.',200,55,90,8)]}]};
        const regions=collectMangaRegions(page,'en',400,400);
        expect(regions.map(region=>region.text)).toEqual(["I ALREADY HAD THE BIRD OPEN IT, IT'S FINE.",'Next speaker.']);
        expect(regions[0]).toMatchObject({fontSize:8,bbox:{x0:40,y0:40,x1:132,y1:77},sourceBoxes:[{x0:40,y0:40,x1:132,y1:48},{x0:40,y0:55,x1:132,y1:62},{x0:51,y0:69,x1:121,y1:77}]});
        expect(collectMangaRegions({results:lines},'en',400,400)).toHaveLength(3);
        expect(collectMangaRegions({results:[],bubbles:[{bbox:box(20,20,130,200),results:[text('First',40,40,60,8),text('Distant',40,80,60,8)]}]},'en',400,400)).toHaveLength(2);
    });
    it('气泡内加宽行距仍不跨两个紧邻且同宽的独立气泡连接台词', () => {
        const first=text('First speaker',40,40,110,20),second=text('Next speaker',40,85,110,20);
        const page={results:[],bubbles:[{bbox:box(20,20,150,50),results:[first]},{bbox:box(20,75,150,50),results:[second]}]};
        expect(collectMangaRegions(page,'en',400,400).map(region=>region.text)).toEqual(['First speaker','Next speaker']);
    });
    it('其他对白和空气泡不会删除可靠的单行旁白或气泡内全页回退',()=>{
        const page={results:[text('Noise',150,200),text('short',150,240),text('row',150,254),text('Reliable caption',200,290),text('second line',200,306),text('Below',25,90),text('Left',0,30),text('Right',90,30)],
            bubbles:[{bbox:box(10,10),results:[text('Hello',20,20)]},{bbox:box(200,10),results:[text('Again',210,20)]},{bbox:box(10,110),results:[]}]};
        const regions=collectMangaRegions(page,'en',400,400);
        expect(regions.map(r=>r.text)).toEqual(['Again','Hello Left','Right','Below','Noise','short row','Reliable caption second line']);
        expect(collectMangaRegions({results:[],bubbles:[{bbox:box(10,10),results:[]}]},'en',400,400)).toEqual([]);
    });
    it('局部 OCR 为空或低置信度时保留全页原文，局部漏行与可靠局部行合成同一句', () => {
        const first = text('Small original', 30, 25, 60, 12), last = text('last line', 30, 42, 60, 12);
        const bbox = box(10, 10, 120, 90);
        for (const profile of ['manga', 'image'] as const) {
            expect(collectMangaRegions({results: [first, last], bubbles: [{bbox, results: []}]}, 'en', 400, 400, profile).map(r=>r.text))
                .toEqual(profile === 'manga' ? ['Small original last line'] : ['Small original', 'last line']);
            expect(collectMangaRegions({results: [first], bubbles: [{bbox, results: [{...first, text:'unreliable', confidence:.4}]}]}, 'en', 400, 400, profile).map(r=>r.text))
                .toEqual(['Small original']);
        }
        const result = collectMangaRegions({results: [first, last], bubbles: [{bbox, results: [{...first, text:'Correct first'}]}]}, 'en', 400, 400);
        expect(result.map(r=>r.text)).toEqual(['Correct first last line']);
        expect(result[0].sourceBoxes).toEqual([{x0:30,y0:25,x1:90,y1:37},{x0:30,y0:42,x1:90,y1:54}]);
    });
    it('很小的局部碎片不能删除全页整行，也不会按合并后中心丢掉气泡外行', () => {
        const page = {results:[text('Complete source sentence', 20, 20, 160, 12)], bubbles:[{bbox:box(10,10,200,100),results:[text('word',20,20,30,12)]}]};
        const imageLines = collectMangaRegions(page,'en',400,400,'image');
        expect(imageLines.map(r=>r.text)).toContain('Complete source sentence');
        const separated = collectMangaRegions({results:[text('Inside',20,20),text('Outside',20,37)],bubbles:[{bbox:box(10,10,70,22),results:[]}]},'en',400,400);
        expect(separated.map(r=>r.text)).toEqual(['Inside','Outside']);
    });
    it('气泡中的高置信度大单字无论来自局部还是全页回退均保留，外部仍过滤', () => {
        const single=text('え',40,40,70,70), bbox=box(20,20,120,120);
        for (const profile of ['manga','image'] as const) {
            expect(collectMangaRegions({results:[],bubbles:[{bbox,results:[single]}]},'ja',400,400,profile).map(r=>r.text)).toEqual(['え']);
            expect(collectMangaRegions({results:[single],bubbles:[{bbox,results:[]}]},'ja',400,400,profile).map(r=>r.text)).toEqual(['え']);
            expect(collectMangaRegions({results:[single]},'ja',400,400,profile)).toEqual([]);
        }
    });
});


describe('冲突识别不得删掉数字保护证据',()=>{
    const number={text:'12:34',confidence:.99,box:{x:80,y:80,width:100,height:20}};
    const text={text:'HELLO',confidence:.99,box:{x:80,y:80,width:100,height:20}};
    const box={x0:40,y0:40,x1:250,y1:180};
    it('局部正文与整页数字重叠时漫画与图片均保留两种证据',()=>{
        const page={results:[number],bubbles:[{bbox:box,results:[text]}]};
        expect(collectMangaRegions(page,'en',400,400,'manga').map(row=>row.text)).toEqual(expect.arrayContaining(['12:34','HELLO']));
        expect(collectMangaRegions(page,'en',400,400,'image').map(row=>row.text)).toEqual(expect.arrayContaining(['12:34','HELLO']));
    });
    it.each([false,true])('跨气泡局部正文与数字冲突时按任意顺序保留：%s',numericFirst=>{
        const other={x0:30,y0:30,x1:260,y1:200};
        const choices=numericFirst?[number,text]:[text,number];
        const page={results:[],bubbles:[{bbox:box,results:[choices[0]]},{bbox:other,results:[choices[1]]}]};
        expect(collectMangaRegions(page,'en',400,400,'manga').map(row=>row.text)).toEqual(expect.arrayContaining(['12:34','HELLO']));
    });
});

describe('重复的数值物理保护',()=>{
    it.each(['manga','image'] as const)('%s 完整覆盖时不添加重复框，部分覆盖和不同位置仍保留',profile=>{
        const number={text:'90%',confidence:.99,box:{x:80,y:80,width:100,height:20}};
        const identical={...number,confidence:.8};
        const partial={...identical,box:{x:75,y:80,width:110,height:20}};
        const far={...identical,box:{x:240,y:80,width:100,height:20}};
        const group=(numericEvidence:typeof number[])=>collectMangaRegions({results:[number],numericEvidence},'en',400,400,profile);
        expect(group([identical]).filter(region=>region.guardOnly)).toEqual([]);
        expect(group([partial]).filter(region=>region.guardOnly).map(region=>region.bbox)).toEqual([{x0:75,y0:80,x1:185,y1:100}]);
        expect(group([far]).filter(region=>region.guardOnly).map(region=>region.bbox)).toEqual([{x0:240,y0:80,x1:340,y1:100}]);
    });
});

describe('疑似数字物理框边界',()=>{
    const number={text:'90%',confidence:.8,box:{x:10,y:10,width:20,height:10}};
    it.each([{x:NaN},{width:0},{height:-1}])('非法疑似数值框明确报错 %j',change=>{
        expect(()=>collectMangaRegions({results:[{...number,box:{...number.box,...change}}]},'en',100,100,'image'))
            .toThrow('保护位置无效');
    });
    it('图外框无像素需保护，相同物理框只保留一次',()=>{
        const outside={...number,box:{x:200,y:200,width:10,height:10}};
        const regions=collectMangaRegions({results:[outside,number,number]},'en',100,100,'image');
        expect(regions.filter(region=>region.guardOnly).map(region=>region.bbox)).toEqual([{x0:10,y0:10,x1:30,y1:20}]);
    });
    it('非相同但完整覆盖的可信数字框可以保护原物理框',()=>{
        const readable={...number,confidence:.99,box:{x:9,y:9,width:22,height:12}};
        expect(collectMangaRegions({results:[readable],numericEvidence:[number]},'en',100,100,'manga').filter(region=>region.guardOnly)).toEqual([]);
    });
    it('过多不同疑似框时明确报错而不输出部分结果',()=>{
        const many=Array.from({length:4097},(_,i)=>({...number,box:{x:i,y:10,width:.5,height:1}}));
        expect(()=>collectMangaRegions({results:[],numericEvidence:many},'en',5000,100,'image')).toThrow('保护区域过于复杂');
    });
    it('候选框过多而不能完整证明包含关系时继续保留未证明框',()=>{
        const readable=Array.from({length:1001},(_,i)=>({...number,confidence:.99,box:{x:i*2,y:10,width:1,height:1}}));
        const uncertain=Array.from({length:1001},(_,i)=>({...number,box:{x:i*2,y:40,width:1,height:1}}));
        const result=collectMangaRegions({results:readable,numericEvidence:uncertain},'en',5000,100,'image');
        expect(result.filter(region=>region.guardOnly)).toHaveLength(1001);
        expect(result.filter(region=>!region.guardOnly).every(region=>region.numericUncertain)).toBe(true);
    });
});


it('同文不同框数字候选的全部物理覆盖都必须保留',()=>{
    const broad={text:'12:34',confidence:.99,box:{x:80,y:80,width:100,height:20}};
    const narrow={...broad,box:{...broad.box,width:51}};
    const page={results:[broad],bubbles:[{bbox:{x0:40,y0:40,x1:250,y1:180},results:[narrow]}]};
    const result=collectMangaRegions(page,'en',400,400,'manga');
    expect(result.filter(row=>row.text==='12:34')).toHaveLength(1);
    expect(result[0].bbox).toEqual({x0:80,y0:80,x1:180,y1:100});
});


it('数字去重比较预算耗尽时仍保留后续物理框',()=>{
    const results=Array.from({length:1500},(_,index)=>({text:String(1000+index),confidence:.99,box:{x:(index%40)*20,y:Math.floor(index/40)*20,width:8,height:8}}));
    const regions=collectMangaRegions({results},'en',1000,1000,'manga');
    expect(regions).toHaveLength(results.length);expect(regions.some(region=>region.text==='2499')).toBe(true);
    expect(regions.every(region=>region.numericUncertain)).toBe(true);
});

describe('数字结果的歧义提示',()=>{
    it.each(['manga','image'] as const)('在 %s 标记两个方向的重叠不同数值，合并同值且不误标近邻',profile=>{
        const bubble=box(40,40,240,150);
        for(const [first,second] of [['08:45','12:34'],['12:34','08:45']]){
            const lines=collectMangaRegions({results:[text(first,80,80,100,20)],bubbles:[{bbox:bubble,results:[text(second,82,80,100,20)]}]},'en',400,400,profile);
            expect(lines.map(line=>line.text).sort()).toEqual([first,second].sort());
            expect(lines.every(line=>line.numericUncertain===true)).toBe(true);
        }
        const same=collectMangaRegions({results:[text('08:45',80,80,100,20)],bubbles:[{bbox:bubble,results:[text('08:45',82,80,100,20)]}]},'en',400,400,profile);
        expect(same).toHaveLength(1);expect(same[0].numericUncertain).toBeUndefined();
        for(const [first,second] of [['USD   100','USD 100'],['USD 100','USD   100']]){
            const sameSpaced=collectMangaRegions({results:[text(first,80,80,100,20)],bubbles:[{bbox:bubble,results:[text(second,82,80,100,20)]}]},'en',400,400,profile);
            expect(sameSpaced).toHaveLength(1);expect(sameSpaced[0].numericUncertain).toBeUndefined();
            expect([first,second]).toContain(sameSpaced[0].text);
        }
        const separate=collectMangaRegions({results:[text('08:45',80,80,100,20)],bubbles:[{bbox:bubble,results:[text('12:34',80,105,100,20)]}]},'en',400,400,profile);
        expect(separate).toHaveLength(2);expect(separate.every(line=>!line.numericUncertain)).toBe(true);
    });
    it('多个数值证据共框时对合并的同值和不同值均提示核对',()=>{
        const a=text('08:45',80,80,100,20),b=text('12:34',80,80,100,20);
        const lines=collectMangaRegions({results:[a,b,a],numericEvidence:[a]},'en',400,400,'image');
        expect(lines.map(item=>item.text)).toEqual(['08:45','12:34']);
        expect(lines.every(item=>item.numericUncertain)).toBe(true);
    });
    it.each(['manga','image'] as const)('在 %s 区分数值证据的可信度与文本',profile=>{
        const number=text('08:45',80,80,100,20);
        const run=(evidence:typeof number[])=>collectMangaRegions({results:[number],numericEvidence:evidence},'en',400,400,profile);
        expect(run([number])[0].numericUncertain).toBeUndefined();
        const spaced=text('USD   100',80,80,100,20);
        expect(collectMangaRegions({results:[spaced],numericEvidence:[spaced]},'en',400,400,profile)[0].numericUncertain).toBeUndefined();
        expect(run([{...number,text:'12:34'}])[0].numericUncertain).toBe(true);
        expect(run([{...number,confidence:.3}])[0].numericUncertain).toBe(true);
        expect(run([number,{...number,text:'12:34'}])[0].numericUncertain).toBe(true);
    });
    it.each(['manga','image'] as const)('在 %s 对低置信重叠数字保留原图并标记可信数字需核对',profile=>{
        const lines=collectMangaRegions({results:[text('08:45',80,80,100,20)],bubbles:[{bbox:box(40,40,240,150),results:[{...text('12:34',80,80,100,20),confidence:.3}]}]},'en',400,400,profile);
        expect(lines).toHaveLength(1);expect(lines[0]).toMatchObject({text:'08:45',numericUncertain:true});
    });
    it.each(['manga','image'] as const)('在 %s 对覆盖或精确匹配的证据继续检查其他相交数值',profile=>{
        // 第三个框恰好贴在精确证据右边，不能因边界接触而误报。
        const before=text('40%',1,10,5,20),left=text('90%',10,10,100,20),right=text('80%',90,10,100,20),far=text('60%',110,10,20,20);
        for(const [guard,retained] of [
            [{...text('70%',95,12,10,12),confidence:.3},0],
            [{...text('70%',10,10,100,20),confidence:.3},0],
            [{...text('70%',95,5,10,30),confidence:.3},1],
        ] as const){
            for(const results of [[before,left,right,far],[far,right,left,before]]){
                const lines=collectMangaRegions({results,numericEvidence:[guard]},'en',400,100,profile);
                expect(lines.filter(line=>line.guardOnly)).toHaveLength(retained);
                expect(lines.find(line=>line.text==='90%')?.numericUncertain).toBe(true);
                expect(lines.find(line=>line.text==='80%')?.numericUncertain).toBe(true);
                expect(lines.find(line=>line.text==='60%')?.numericUncertain).toBeUndefined();
                expect(lines.find(line=>line.text==='40%')?.numericUncertain).toBeUndefined();
            }
        }
    });
    it.each(['manga','image'] as const)('在 %s 模式只忽略百分号前空白',profile=>{
        for(const [first,second,uncertain] of [
            ['90%','90 %',false],['90％','90   ％',false],['90%','80 %',true],
            ['$1000','$1 000',true],
        ] as const){
            const lines=collectMangaRegions({results:[text(first,10,10,100,20),text(second,15,10,100,20)]},'en',300,100,profile);
            expect(lines.every(line=>line.numericUncertain === (uncertain?true:undefined))).toBe(true);
            expect(lines).toHaveLength(uncertain?2:1);
        }
    });
    it('精确框仍有超过比较预算的候选时全部提示核对并保留未完成检查的保护框',()=>{
        // x 相同但 y 分离，精确匹配不能跳过同列其他数值；最后一个 guard 超过一百万次比较。
        const results=Array.from({length:1001},(_,index)=>text('90%',10,10+index*2,1,1));
        const numericEvidence=results.map(item=>({...item,confidence:.3}));
        const lines=collectMangaRegions({results,numericEvidence},'en',100,2500,'image');
        expect(lines.filter(line=>!line.guardOnly)).toHaveLength(1001);
        expect(lines.filter(line=>!line.guardOnly).every(line=>line.numericUncertain)).toBe(true);
        expect(lines.some(line=>line.guardOnly)).toBe(true);
    });
});
