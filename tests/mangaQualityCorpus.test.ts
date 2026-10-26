/** 漫画场景质量门禁：实际识别值与独立 source truth 对照，漏字、重复和艺术误报不能互相抵消。 */
import {describe,expect,it} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const {normalizeOcrAnchor,countAnchorOccurrences,validateQualityFixtureExpectations,evaluateQualityFixture,evaluateQualityReadingOrder}=require('../scripts/testing/manga-quality-corpus.cjs');
const box=(x0:number,y0:number,x1:number,y1:number)=>({x0,y0,x1,y1});
const text=(sourceText:string,bbox=box(10,10,90,30),sourceBoxes?:ReturnType<typeof box>[])=>({text:'受控译文',sourceText,bbox,...(sourceBoxes?{sourceBoxes}:{})});
const fixture=(overrides:any={})=>({name:'actual-quality',width:400,height:300,expectedSource:['WAIT FOR ME','WAIT FOR ME','GO NOW'],expectedAnchors:['WAIT FOR ME','GO NOW'],anchorOccurrences:{'WAIT FOR ME':2,'GO NOW':1},regions:[{id:'line-1',bbox:box(10,10,90,30)}],forbiddenRegions:[{id:'robot',bbox:box(200,100,300,250)}],...overrides});
const naturalRoot=new URL('./fixtures/manga-natural/',import.meta.url);
const naturalManifest=JSON.parse(readFileSync(new URL('manifest.json',naturalRoot),'utf8'));
const runnerAst=ts.createSourceFile('runner.cjs',readFileSync(new URL('../scripts/testing/run-manga-translation-test.cjs',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
describe('普通图片质量矩阵使用独立的真实入口',()=>{
    it('拒绝把真实站点、其他阅读模式、无字页或其他OCR引擎混入普通Paddle质量统计',()=>{
        const admission=runnerAst.statements.find(node=>ts.isIfStatement(node)&&node.expression.getText(runnerAst)==='ordinaryImageQuality')!.getText(runnerAst);
        const base:any={assert:require('node:assert/strict'),ordinaryImageQuality:true,qualityManifest:{},qualityFixtures:[{sourceLanguage:'en'},{sourceLanguage:'ja'},{sourceLanguage:'auto'}],prefetchPages:0,offlineModels:null,preloadModels:null,blockedOfficial:false,blockedAll:false};
        const modes=['liveSite','liveTranslation','readerSmoke','surfaceReaderTest','segmentReaderTest','baseline','errorRecoveryTest','readAheadTest','scrollStabilityTest','scrollIntentTest','cacheNavigationTest','tieredCacheTest','pageFeedbackTest'];
        for(const mode of modes)base[mode]=false;
        expect(()=>runInNewContext(admission,base)).not.toThrow();
        for(const mode of modes)expect(()=>runInNewContext(admission,{...base,[mode]:true})).toThrow();
        for(const overrides of [{qualityManifest:null},{prefetchPages:1},{offlineModels:'/fixed-models'},{preloadModels:'/fixed-models'},{blockedOfficial:true},{blockedAll:true},{qualityFixtures:[{sourceLanguage:'en',expectedNoText:true}]},{qualityFixtures:[{sourceLanguage:'ru'}]},{qualityFixtures:[{sourceLanguage:'ko'}]}])
            expect(()=>runInNewContext(admission,{...base,...overrides})).toThrow();
        expect(()=>runInNewContext(admission,{...base,ordinaryImageQuality:false,liveSite:true,qualityManifest:null})).not.toThrow();
    });
    it('真实普通按钮须命中且位于视口内才允许点击，不能借用漫画入口',async()=>{
        const toggle=runnerAst.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='toggle')!.getText(runnerAst);
        for(const point of [{x:120,y:80,viewport:{width:800,height:600},hit:true},{x:120,y:80,viewport:{width:800,height:600},hit:false},{x:120,y:601,viewport:{width:800,height:600},hit:true}]){
            const clicks:number[][]=[];let reads=0;
            const sandbox:any={assert:require('node:assert/strict'),ordinaryImageQuality:true,activateVisible:async()=>undefined,
                page:{locator:()=>({first:()=>({boundingBox:async()=>({x:0,y:0,width:600,height:900})})}),mouse:{move:async()=>undefined,click:async(...args:number[])=>{clicks.push(args);}}},
                imageUi:async()=>++reads===1?true:point,wait:async(predicate:()=>Promise<unknown>)=>{expect(await predicate()).toBe(true);},ball:()=>{throw new Error('Must use ordinary image controls');}};
            const run=runInNewContext(`(${toggle})`,sandbox);
            if(point.hit&&point.y<point.viewport.height){await run();expect(clicks).toEqual([[120,80]]);}
            else{await expect(run()).rejects.toThrow('visible and hit-testable');expect(clicks).toEqual([]);}
        }
    });
});
const generalParagraphFixture=()=>{
    const regions=[
        {id:'main-right',text:'列の続き',anchor:'列の続き',bbox:box(125,20,145,140),vertical:true},
        {id:'main-left',text:'本文の後半',anchor:'本文の後半',bbox:box(85,20,105,140),vertical:true},
        {id:'card',text:'注釈カード',anchor:'注釈カード',bbox:box(165,40,185,120),vertical:true},
        {id:'horizontal',text:'INDEX 2048',anchor:'INDEX 2048',bbox:box(15,170,165,195)}];
    const source=regions.map(region=>region.text);
    return fixture({regions,expectedSource:source,expectedAnchors:source,anchorOccurrences:Object.fromEntries(source.map(value=>[value,1])),paragraphGroups:[['main-right','main-left'],['card'],['horizontal']]});
};

describe('通用独立段落门禁',()=>{
    it('单张竖排卡片与横排标签各占独立段落，原文与输入元数据保持不变',()=>{
        const f=generalParagraphFixture(),before=JSON.stringify(f);
        expect(()=>validateQualityFixtureExpectations(f)).not.toThrow();
        const result=evaluateQualityReadingOrder(f,['INDEX 2048','列の続き 本文の後半','注釈カード']);
        expect(result.qualityFailures).toEqual([]);
        expect(result.paragraphGroups.map((group:any)=>group.paragraphIndex)).toEqual([1,2,0]);
        expect(result).not.toHaveProperty('verticalParagraphGroups');
        expect(JSON.stringify(f)).toBe(before);
    });
    it('锚点和字符库存齐全仍不能把独立卡片并入正文，也不能把同组主列拆散或颠倒',()=>{
        const f=generalParagraphFixture();
        const merged=['列の続き 本文の後半 注釈カード','INDEX 2048'];
        expect(evaluateQualityFixture(f,{texts:merged,lines:merged.map(value=>text(value))}).qualityFailures).toEqual([]);
        expect(evaluateQualityReadingOrder(f,merged).qualityFailures).toContainEqual(expect.objectContaining({type:'paragraph-order'}));
        for(const values of [['列の続き','本文の後半','注釈カード','INDEX 2048'],['本文の後半 列の続き','注釈カード','INDEX 2048']])
            expect(evaluateQualityReadingOrder(f,values).qualityFailures).toContainEqual(expect.objectContaining({type:'paragraph-order'}));
    });
    it('不同位置的相同单行对白须增广匹配到两个实际段落，一段重复两次不能替代',()=>{
        const regions=[0,1].map(index=>({id:`card-${index}`,text:'READ THIS',anchor:'READ THIS',bbox:box(10+100*index,10,90+100*index,30)}));
        const f=fixture({regions,expectedSource:['READ THIS','READ THIS'],expectedAnchors:['READ THIS'],anchorOccurrences:{'READ THIS':2},paragraphGroups:[['card-0'],['card-1']]});
        expect(()=>validateQualityFixtureExpectations(f)).not.toThrow();
        const result=evaluateQualityReadingOrder(f,['READ THIS','READ THIS']);
        expect(result.qualityFailures).toEqual([]);
        expect(new Set(result.paragraphGroups.map((group:any)=>group.paragraphIndex)).size).toBe(2);
        expect(evaluateQualityReadingOrder(f,['READ THIS READ THIS']).qualityFailures).toContainEqual(expect.objectContaining({type:'paragraph-order'}));
        expect(evaluateQualityReadingOrder(f,['READ THIS']).qualityFailures).toContainEqual(expect.objectContaining({type:'paragraph-separation'}));
    });
    it('拒绝假值、空组、单组、超过上限、重复或跨组复用ID，不放宽旧竖排格式',()=>{
        const f=generalParagraphFixture();
        for(const paragraphGroups of [false,0,'',null,{},[],[['card']],[['card'],[]],[null,['card']],[['card','card'],['horizontal']],[['card'],['card']],Array(25).fill(['card']),[['card'],['missing']],[[null],['card']],[[0],['card']],[[''],['card']]])
            expect(()=>validateQualityFixtureExpectations({...f,paragraphGroups})).toThrow();
        expect(()=>validateQualityFixtureExpectations({...f,readingOrder:['main-right','main-left']})).toThrow('one explicit paragraph declaration');
        expect(()=>validateQualityFixtureExpectations({...f,paragraphGroups:undefined,readingOrderGroups:[['card'],['main-right','main-left']]})).toThrow('distinct text region IDs');
    });
    it('通用组必须引用图内唯一实际源区、已声明的锚点及该区真实文字，不能发明或借用锚点',()=>{
        const f=generalParagraphFixture();
        for(const overrides of [
            {regions:undefined},{regions:[...f.regions,{...f.regions[2]}]},
            {regions:f.regions.map((region:any)=>region.id==='card'?{...region,bbox:box(-1,0,10,30)}:region)},
            {regions:f.regions.map((region:any)=>region.id==='card'?{...region,bbox:box(10,NaN,30,50)}:region)},
            ...[undefined,'','…',12,'列の続き'].map(anchor=>({regions:f.regions.map((region:any)=>region.id==='card'?{...region,anchor}:region)})),
            {regions:f.regions.map((region:any)=>region.id==='card'?{...region,text:undefined}:region)},
            {expectedSource:f.expectedSource.filter((value:string)=>value!=='注釈カード'),anchorOccurrences:undefined},
            {expectedAnchors:f.expectedAnchors.filter((value:string)=>value!=='注釈カード'),anchorOccurrences:undefined}
        ])expect(()=>validateQualityFixtureExpectations({...f,...overrides})).toThrow();
        // 即使另一区域是真实文字，也不能把卡片ID绑到不属于该卡片的锚点。
        const borrowed={...f,regions:f.regions.map((region:any)=>region.id==='card'?{...region,anchor:'INDEX 2048'}:region)};
        expect(()=>validateQualityFixtureExpectations(borrowed)).toThrow('complete declared source');
    });
    it('完整原文与库存都正确时也拒绝借用别段子串的虚构卡片区域，避免增广匹配掩盖误合段',()=>{
        const source=['MAIN BODY','ALSO MAIN BODY','CARD NOTE'];
        const regions=source.map((value,index)=>({id:`region-${index}`,text:value,anchor:value,bbox:box(10,10+40*index,180,40+40*index)}));
        const f=fixture({regions,expectedSource:source,expectedAnchors:source,anchorOccurrences:{'MAIN BODY':2,'ALSO MAIN BODY':1,'CARD NOTE':1},paragraphGroups:[['region-0'],['region-2']]});
        const merged=['MAIN BODY CARD NOTE','ALSO MAIN BODY'];
        expect(()=>validateQualityFixtureExpectations(f)).not.toThrow();
        expect(evaluateQualityFixture(f,{texts:merged,lines:merged.map(value=>text(value))}).qualityFailures).toEqual([]);
        expect(evaluateQualityReadingOrder(f,merged).qualityFailures).toContainEqual(expect.objectContaining({type:'paragraph-order'}));
        const forged={...f,regions:regions.map((region,index)=>index===2?{...region,text:'CARD NOTE MAIN BODY',anchor:'MAIN BODY'}:region)};
        expect(()=>validateQualityFixtureExpectations(forged)).toThrow('complete declared source');
        expect(()=>validateQualityFixtureExpectations({...forged,regions:forged.regions.map((region:any,index:number)=>index===2?{...region,anchor:region.text}:region),expectedAnchors:[...source,'CARD NOTE MAIN BODY'],anchorOccurrences:undefined})).toThrow('complete declared source');
    });
});

describe('真实漫画runner多轮layout采集的有界容量',()=>{
    it('逐景资源轨迹具有独立文件名，多景同轮及同名图片不覆盖前次采样',()=>{
        let label:ts.Expression|undefined;
        const visit=(node:ts.Node)=>{
            if(ts.isCallExpression(node)&&node.expression.getText(runnerAst).endsWith('.measureBrowser'))label=node.arguments[1];
            ts.forEachChild(node,visit);
        };
        visit(runnerAst);expect(label).toBeDefined();
        const labels=new Set<string>();
        for(let scene=0;scene<32;scene++)for(let round=0;round<5;round++){
            const name=runInNewContext(label!.getText(runnerAst),{report:{pipeline:{length:labels.size}},round,caseName:'same-input-name'});
            expect(name).toMatch(/^manga-case-\d+-round-\d+$/);
            expect(labels.has(name)).toBe(false);labels.add(name);
        }
        expect(labels.size).toBe(160);
    });
    it('32景五轮保留全部160次响应及预留，承诺以外的记录仍有硬上限',async()=>{
        const source=readFileSync(new URL('../scripts/testing/run-manga-translation-test.cjs',import.meta.url),'utf8');
        const ast=ts.createSourceFile('runner.cjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
        let initializer='',observer='';
        const visit=(node:ts.Node)=>{
            if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='layoutTraceLimit')initializer=node.initializer!.getText(ast);
            if(ts.isCallExpression(node)&&node.expression.getText(ast)==='worker.evaluate'&&node.arguments[0]?.getText(ast).startsWith('({live,trace,traceLayout,layoutTraceLimit})=>'))observer=node.arguments[0].getText(ast);
            ts.forEachChild(node,visit);
        };
        visit(ast);expect(initializer).not.toBe('');expect(observer).not.toBe('');
        const limit=runInNewContext(initializer,{qualityFixtures:Array(32),pipelineRounds:5});
        expect(limit).toBeGreaterThanOrEqual(160);expect(limit).toBeLessThanOrEqual(168);
        const baselineResponse={lines:[{text:'受控译文',sourceText:'actual source',bbox:box(10,10,90,30)}]};
        let response:any=baselineResponse;
        const chrome={runtime:{sendMessage:(_message:unknown,callback?:Function)=>{if(callback)callback(response);return Promise.resolve(response);},onMessage:{addListener:()=>undefined}}};
        const sandbox:any={chrome,fetch:()=>{throw new Error('Layout trace replay must not fetch');}};
        const observe=runInNewContext(`(${observer})`,sandbox);
        observe({live:false,trace:false,traceLayout:true,layoutTraceLimit:limit});
        for(let index=0;index<limit+3;index++){
            response=index===0?{success:true,lines:[],image:'data:image/png;base64,actual-source'}:index===1?{success:true,lines:[{text:'08:45',sourceText:'08:45',bbox:box(10,10,90,30)}],mangaPatches:{patches:[]}}:baselineResponse;
            if(index===2)response={success:true,lines:[],image:'data:image/png;base64,different-source'};
            if(index===3)response={success:false,lines:[],image:'data:image/png;base64,actual-source'};
            if(index===4)response={success:true,lines:[],mangaPatches:{patches:[]}};
            const message={type:'FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN',requestId:String(index),manga:index!==4,image:'data:image/png;base64,actual-source'};
            if(index%2)chrome.runtime.sendMessage(message,(value:unknown)=>expect(value).toBe(response));
            else expect(await chrome.runtime.sendMessage(message)).toBe(response);
        }
        const results=sandbox.__mangaTest.layoutResults;
        expect(results).toHaveLength(limit);expect(results[159].requestId).toBe('159');
        expect(results[159].lines[0].sourceText).toBe('actual source');
        expect(results.slice(0,6).map((result:any)=>result.noBitmap)).toEqual([true,true,false,false,false,false]);
        for(const result of results.slice(0,2))expect(evaluateQualityFixture(fixture(),{texts:result.lines.map((line:any)=>line.sourceText),lines:result.lines}).anchors.every((anchor:any)=>!anchor.found)).toBe(true);
        await chrome.runtime.sendMessage({type:'UNRELATED',requestId:'host'});
        expect(results).toHaveLength(limit);
    });
});

describe('漫画 source truth、重复锚点与负场景质量门禁',()=>{
    it('Unicode全角及空白规范化不改变真实重复次数，并保留重叠子串计数',()=>{
        expect(normalizeOcrAnchor(' Ｎｏｔｅ ０７、図書館！')).toBe('NOTE07図書館');
        expect(countAnchorOccurrences('AAAA','AA')).toBe(3);
        expect(countAnchorOccurrences('AAAA','')).toBe(0);
    });
    it('同一句真实对白出现两次时必须识别两次，不把第二句当瓦片重复删除',()=>{
        const f=fixture();expect(()=>validateQualityFixtureExpectations(f)).not.toThrow();
        const result=evaluateQualityFixture(f,{texts:['Wait for me.','WAIT FOR ME','GO NOW'],lines:[text('Wait for me.'),text('WAIT FOR ME'),text('GO NOW')]});
        expect(result.anchors[0]).toMatchObject({expectedOccurrences:2,occurrences:2,found:true});expect(result.qualityFailures).toEqual([]);
    });
    it('多一份、少一份与认错字符各自保持严格失败，不通过修改期望次数消除问题',()=>{
        const f=fixture();
        expect(evaluateQualityFixture(f,{texts:['WAIT FOR ME WAIT FOR ME WAIT FOR ME GO NOW'],lines:[text('duplicate')]}).qualityFailures[0]).toMatchObject({type:'duplicate-anchor',expectedOccurrences:2,occurrences:3});
        expect(evaluateQualityFixture(f,{texts:['WAIT FOR ME GO NOW'],lines:[text('missing')]}).qualityFailures[0]).toMatchObject({type:'ocr-anchor',expectedOccurrences:2,occurrences:1});
        expect(evaluateQualityFixture(f,{texts:['WAIT FOR ME WAIT FOR ME G0 NOW'],lines:[text('G0 NOW')]}).qualityFailures[0]).toMatchObject({type:'ocr-anchor',anchor:'GO NOW',occurrences:0});
    });
    it('manifest声明的次数必须来自源文字，规范化后重复锚点与空锚点均拒绝',()=>{
        expect(()=>validateQualityFixtureExpectations(fixture({anchorOccurrences:{'WAIT FOR ME':1,'GO NOW':1}}))).toThrow('Occurrence metadata agrees');
        expect(()=>validateQualityFixtureExpectations(fixture({expectedAnchors:['GO NOW','ＧＯ ＮＯＷ']}))).toThrow('distinct after normalization');
        expect(()=>validateQualityFixtureExpectations(fixture({expectedAnchors:['!']}))).toThrow('normalized OCR anchors');
        expect(()=>validateQualityFixtureExpectations(fixture({expectedSource:['']}))).toThrow('exact source text');
    });
    it('艺术误识别有独立门禁，全部正锚点通过也不能掩盖新增詩書段落',()=>{
        const f=fixture();const result=evaluateQualityFixture(f,{texts:['WAIT FOR ME WAIT FOR ME GO NOW','詩書'],lines:[text('WAIT FOR ME'),text('詩書',box(210,120,290,150))]});
        expect(result.anchors.every((anchor:any)=>anchor.found)).toBe(true);
        expect(result.negativeDetections).toEqual([{regionId:'robot',lineIndex:1,sourceText:'詩書',sourceBoxes:[box(210,120,290,150)]}]);
        expect(result.qualityFailures).toEqual([expect.objectContaining({type:'artwork-ocr-false-positive',sourceText:'詩書'}),expect.objectContaining({type:'unexpected-ocr-characters',excess:[{character:'詩',expected:0,actual:1,excess:1},{character:'書',expected:0,actual:1,excess:1}]})]);
    });
    it('全部锚点正确但合法文字框内多出READ时仍拒绝，实际sourceText优先于送翻译的文字子集',()=>{
        const f=fixture(),recognized='WAIT FOR ME WAIT FOR ME GO NOW';
        const result=evaluateQualityFixture(f,{texts:[recognized],lines:[text(recognized),text('READ',box(10,40,90,60))]});
        expect(result.anchors.every((anchor:any)=>anchor.found)).toBe(true);expect(result.negativeDetections).toEqual([]);
        expect(result.sourceCharacterInventory.actual.R).toBe(3);expect(result.sourceCharacterInventory.expected.R).toBe(2);
        expect(result.qualityFailures).toEqual([expect.objectContaining({type:'unexpected-ocr-characters'})]);
        // 删除一整句没有产生多余字符，但必须继续被原有次数锚点拦截。
        const missing=evaluateQualityFixture(f,{texts:['WAIT FOR ME GO NOW'],lines:[text('WAIT FOR ME GO NOW')]});
        expect(missing.sourceCharacterInventory.excess).toEqual([]);expect(missing.qualityFailures).toContainEqual(expect.objectContaining({type:'ocr-anchor',expectedOccurrences:2,occurrences:1}));
    });
    it('负区域只检查实际原始行框，不用覆盖行间画面的段落大框制造误报',()=>{
        const f=fixture();const paragraph=text('WAIT FOR ME WAIT FOR ME GO NOW',box(10,10,350,280),[box(10,10,90,30),box(10,260,350,280)]);
        expect(evaluateQualityFixture(f,{texts:['WAIT FOR ME WAIT FOR ME GO NOW'],lines:[paragraph]}).qualityFailures).toEqual([]);
        const boundary=text('edge',box(180,100,200,150));
        expect(evaluateQualityFixture(f,{texts:['WAIT FOR ME WAIT FOR ME GO NOW'],lines:[boundary]}).negativeDetections).toEqual([]);
    });
    it('完全无字页必须没有文字请求及返回行，标点形噪声也不能被规范化过滤掩盖',()=>{
        const f=fixture({expectedNoText:true,expectedSource:[],expectedAnchors:[],anchorOccurrences:{},regions:[]});
        expect(()=>validateQualityFixtureExpectations(f)).not.toThrow();
        expect(evaluateQualityFixture(f,{texts:[],lines:[]}).qualityFailures).toEqual([]);
        expect(evaluateQualityFixture(f,{texts:['!!!'],lines:[]}).qualityFailures).toEqual([expect.objectContaining({type:'wordless-page-text'})]);
        expect(evaluateQualityFixture(f,{texts:[],lines:[text('詩書',box(20,40,70,80))]}).qualityFailures).toContainEqual(expect.objectContaining({type:'wordless-page-text'}));
        expect(()=>validateQualityFixtureExpectations({...f,expectedSource:['invented']})).toThrow('cannot invent');
    });
    it('负区域不得含ground truth文字或越界，不允许通过错误标注排除实际对白',()=>{
        expect(()=>validateQualityFixtureExpectations(fixture({forbiddenRegions:[{id:'not-art',bbox:box(0,0,100,100)}]}))).toThrow('contains no declared source text');
        expect(()=>validateQualityFixtureExpectations(fixture({forbiddenRegions:[{id:'outside',bbox:box(200,100,500,250)}]}))).toThrow('inside the source image');
        expect(()=>validateQualityFixtureExpectations(fixture({forbiddenRegions:[{id:'same',bbox:box(200,100,300,150)},{id:'same',bbox:box(200,160,300,250)}]}))).toThrow('identifiers are unique');
    });
    it('没有实际layout观测时明确失败，不能以空数组冒充未发生误报',()=>{
        expect(()=>evaluateQualityFixture(fixture(),{texts:['GO NOW']})).toThrow('layout was captured');
        expect(()=>evaluateQualityFixture(fixture(),{texts:[],lines:[text('bad',box(-1,0,20,20))]})).toThrow('valid image coordinates');
    });
    it('竖排主列顺序显式引用主文字，较小注音可独立记录而不强行混入段落断言',()=>{
        const f=fixture({expectedSource:['WAIT FOR ME','GO NOW','ふりがな'],expectedAnchors:['WAIT FOR ME','GO NOW','ふりがな'],anchorOccurrences:{'WAIT FOR ME':1,'GO NOW':1,'ふりがな':1},regions:[{id:'main-right',text:'WAIT FOR ME',anchor:'WAIT FOR ME',bbox:box(150,20,180,90),vertical:true},{id:'main-left',text:'GO NOW',anchor:'GO NOW',bbox:box(100,20,130,90),vertical:true},{id:'furigana',text:'ふりがな',anchor:'ふりがな',bbox:box(185,20,195,50),vertical:true}],readingOrder:['main-right','main-left']});
        expect(()=>validateQualityFixtureExpectations(f)).not.toThrow();
        expect(()=>validateQualityFixtureExpectations({...f,readingOrder:['main-right','missing']})).toThrow('actual vertical source regions');
        expect(()=>validateQualityFixtureExpectations({...f,readingOrder:['main-right','main-right']})).toThrow('distinct text region IDs');
    });
    it('旧读序声明不能用false、0、空串或null关闭门禁，引用缺少有效锚点或有歧义的ID须提前拒绝',()=>{
        const regions=[{id:'right',text:'GO NOW',anchor:'GO NOW',bbox:box(100,20,130,90),vertical:true},{id:'left',text:'WAIT FOR ME',anchor:'WAIT FOR ME',bbox:box(50,20,80,90),vertical:true}];
        const f=fixture({regions,expectedSource:['GO NOW','WAIT FOR ME'],expectedAnchors:['GO NOW','WAIT FOR ME'],anchorOccurrences:{'GO NOW':1,'WAIT FOR ME':1},readingOrder:['right','left']});
        expect(()=>validateQualityFixtureExpectations(f)).not.toThrow();
        for(const readingOrder of [false,0,'',null])expect(()=>validateQualityFixtureExpectations({...f,readingOrder})).toThrow();
        for(const anchor of [undefined,'','…'])expect(()=>validateQualityFixtureExpectations({...f,regions:regions.map((region,index)=>index===0?{...region,anchor}:region)})).toThrow();
        expect(()=>validateQualityFixtureExpectations({...f,regions:[...regions,{...regions[0],anchor:'AMBIGUOUS'}]})).toThrow();
    });
    it('两位说话人的竖排气泡分别声明读序，拒绝无效、重复或跨组复用文字ID',()=>{
        const regions=['RIGHT FIRST','RIGHT SECOND','LEFT FIRST','LEFT SECOND'].map((value,index)=>({id:`main-${index}`,text:value,anchor:value,bbox:box(20+index*30,20,40+index*30,90),vertical:true}));
        const source=regions.map(region=>region.text),groups=[['main-0','main-1'],['main-2','main-3']];
        const f=fixture({regions,expectedSource:source,expectedAnchors:source,anchorOccurrences:Object.fromEntries(source.map(value=>[value,1])),readingOrderGroups:groups});
        expect(()=>validateQualityFixtureExpectations(f)).not.toThrow();
        for(const readingOrderGroups of [[['main-0','main-1']],[['main-0','main-0'],['main-2','main-3']],[['main-0','main-1'],['main-1','main-3']],[['main-0','missing'],['main-2','main-3']]]) {
            expect(()=>validateQualityFixtureExpectations({...f,readingOrderGroups})).toThrow();
        }
        expect(()=>validateQualityFixtureExpectations({...f,readingOrder:['main-0','main-1']})).toThrow();
        expect(()=>validateQualityFixtureExpectations({...f,regions:regions.map((region,index)=>index===3?{...region,vertical:false}:region)})).toThrow();
        for(const anchor of [undefined,'','…'])expect(()=>validateQualityFixtureExpectations({...f,regions:regions.map((region,index)=>index===2?{...region,anchor}:region)})).toThrow();
        expect(()=>validateQualityFixtureExpectations({...f,regions:[...regions,{...regions[2],anchor:'AMBIGUOUS'}]})).toThrow();
    });
    it('每个气泡内都必须先右后左且不同气泡各占实际段落，不能用合并段落掩盖错序',()=>{
        const source=['RIGHT FIRST','RIGHT SECOND','LEFT FIRST','LEFT SECOND'];
        const regions=source.map((value,index)=>({id:`main-${index}`,text:value,anchor:value,bbox:box(20+index*30,20,40+index*30,90),vertical:true}));
        const f=fixture({regions,expectedSource:source,expectedAnchors:source,anchorOccurrences:Object.fromEntries(source.map(value=>[value,1])),readingOrderGroups:[['main-0','main-1'],['main-2','main-3']]});
        const actual=['RIGHT FIRST RIGHT SECOND','LEFT FIRST LEFT SECOND'];
        expect(evaluateQualityReadingOrder(f,actual).qualityFailures).toEqual([]);
        expect(evaluateQualityReadingOrder(f,[actual[1],actual[0]]).qualityFailures).toEqual([]);
        for(const reversed of [['RIGHT SECOND RIGHT FIRST',actual[1]],[actual[0],'LEFT SECOND LEFT FIRST']]) {
            expect(evaluateQualityReadingOrder(f,reversed).qualityFailures).toContainEqual(expect.objectContaining({type:'vertical-paragraph-order'}));
        }
        expect(evaluateQualityReadingOrder(f,[actual.join(' ') ]).qualityFailures).toContainEqual(expect.objectContaining({type:'vertical-paragraph-separation'}));
        // 两个气泡说同一句话仍是两个真实段落，不能都绑定到first-match。
        const repeated=source.map((_value,index)=>index%2?'WAIT HERE':'COME ALONG');
        const duplicateDialogue={...f,regions:regions.map((region,index)=>({...region,text:repeated[index],anchor:repeated[index]})),expectedSource:repeated,expectedAnchors:['COME ALONG','WAIT HERE'],anchorOccurrences:{'COME ALONG':2,'WAIT HERE':2}};
        expect(()=>validateQualityFixtureExpectations(duplicateDialogue)).not.toThrow();
        expect(evaluateQualityReadingOrder(duplicateDialogue,['COME ALONG WAIT HERE','COME ALONG WAIT HERE']).qualityFailures).toEqual([]);
        expect(evaluateQualityReadingOrder(duplicateDialogue,['COME ALONG WAIT HERE']).qualityFailures).toContainEqual(expect.objectContaining({type:'vertical-paragraph-separation'}));
    });
    it('日英混排与全角价格保留精确文字，数字0误认成拉丁O必须失败',()=>{
        const f=fixture({expectedSource:['桃の紅茶 380円','PEACH TEA'],expectedAnchors:['桃の紅茶 380円','PEACH TEA'],anchorOccurrences:{'桃の紅茶 380円':1,'PEACH TEA':1}});
        const actual=['桃の紅茶 ３８０円','PEACH TEA'];
        expect(()=>validateQualityFixtureExpectations(f)).not.toThrow();
        expect(evaluateQualityFixture(f,{texts:actual,lines:actual.map(value=>text(value))}).qualityFailures).toEqual([]);
        const confused=['桃の紅茶 38O円','PEACH TEA'];
        const result=evaluateQualityFixture(f,{texts:confused,lines:confused.map(value=>text(value))});
        expect(result.qualityFailures).toContainEqual(expect.objectContaining({type:'ocr-anchor',anchor:'桃の紅茶 380円',occurrences:0}));
        expect(result.sourceCharacterInventory.excess).toEqual([{character:'O',expected:0,actual:1,excess:1}]);
    });
    it('极小字中的独立数字即使未送翻译仍参与验收，字高不能成为忽略门禁的理由',()=>{
        const f=fixture({expectedSource:['KEEP YOUR TICKET','2048'],expectedAnchors:['KEEP YOUR TICKET'],anchorOccurrences:{'KEEP YOUR TICKET':1}});
        const original=[text('KEEP YOUR TICKET'),text('2048',box(10,60,34,66))];
        expect(evaluateQualityFixture(f,{texts:['KEEP YOUR TICKET'],lines:original}).qualityFailures).toEqual([]);
        const result=evaluateQualityFixture(f,{texts:['KEEP YOUR TICKET'],lines:[...original,text('2048',box(110,60,134,66))]});
        expect(result.anchors.every((anchor:any)=>anchor.found)).toBe(true);
        expect(result.sourceCharacterInventory.excess).toHaveLength(4);
        expect(result.sourceCharacterInventory.excess.every((entry:any)=>entry.expected===1&&entry.actual===2&&entry.excess===1)).toBe(true);
        expect(result.qualityFailures).toEqual([expect.objectContaining({type:'unexpected-ocr-characters'})]);
    });
    it('所有对白正确仍拒绝尾部或头像负区内的标点噪声，不因字符库存规范化为空而漏报',()=>{
        const f=fixture();const recognized='WAIT FOR ME WAIT FOR ME GO NOW';
        const result=evaluateQualityFixture(f,{texts:[recognized],lines:[text(recognized),text('…',box(230,120,234,126))]});
        expect(result.anchors.every((anchor:any)=>anchor.found)).toBe(true);
        expect(result.sourceCharacterInventory.excess).toEqual([]);
        expect(result.qualityFailures).toEqual([expect.objectContaining({type:'artwork-ocr-false-positive',sourceText:'…',regionId:'robot'})]);
    });
    it('真OT与07、OO、IT和混合序列号独立保留，不能以数字纠错覆盖合法字母',()=>{
        const labels=['NOTE OT','NOTE 07','CODE OO','CHECK IT','O0 I1 1I Z2 2Z S5 5S T7 7T B8 8B'];
        const source=[...labels,...labels],f=fixture({expectedSource:source,expectedAnchors:labels,anchorOccurrences:Object.fromEntries(labels.map(label=>[label,2]))});
        expect(()=>validateQualityFixtureExpectations(f)).not.toThrow();
        expect(evaluateQualityFixture(f,{texts:source,lines:source.map(value=>text(value))}).qualityFailures).toEqual([]);
        const replaced=source.map(value=>value.replace(/\bOT\b/gu,'07'));
        const result=evaluateQualityFixture(f,{texts:replaced,lines:replaced.map(value=>text(value))});
        expect(result.qualityFailures).toContainEqual(expect.objectContaining({type:'ocr-anchor',anchor:'NOTE OT',occurrences:0,expectedOccurrences:2}));
        expect(result.qualityFailures).toContainEqual(expect.objectContaining({type:'duplicate-anchor',anchor:'NOTE 07',occurrences:4,expectedOccurrences:2}));
        expect(result.qualityFailures).toContainEqual(expect.objectContaining({type:'unexpected-ocr-characters'}));
    });
    it('易混字符互换即使字符库存完全相同也失败，不能把库存等同序列号正确率',()=>{
        const exact='O0 I1 1I Z2 2Z S5 5S T7 7T B8 8B';
        const f=fixture({expectedSource:[exact],expectedAnchors:[exact],anchorOccurrences:{[exact]:1}});
        const shuffled='0O 1I I1 2Z Z2 5S S5 7T T7 8B B8';
        const result=evaluateQualityFixture(f,{texts:[shuffled],lines:[text(shuffled)]});
        expect(result.sourceCharacterInventory.excess).toEqual([]);
        expect(result.qualityFailures).toEqual([expect.objectContaining({type:'ocr-anchor',anchor:exact,occurrences:0})]);
    });
    it('斜告示首字、连接边框的第二行及框外旁白均是必需真值，其他正确行不能补偿缺字',()=>{
        const source=['WE ARE STILL HERE','I WILL KEEP THE NOTE','A QUIET STOP','THE SECOND LINE MUST STAY','A small note outside the frame.'];
        const f=fixture({expectedSource:source,expectedAnchors:source,anchorOccurrences:Object.fromEntries(source.map(value=>[value,1]))});
        for(const [index,replacement] of [[0,'E ARE STILL HERE'],[1,'WILL KEEP THE NOTE'],[2,'QUIET STOP'],[3,''],[4,'']] as const) {
            const actual=source.map((value,line)=>line===index?replacement:value).filter(Boolean);
            const result=evaluateQualityFixture(f,{texts:actual,lines:actual.map(value=>text(value))});
            expect(result.sourceCharacterInventory.excess).toEqual([]);
            expect(result.qualityFailures).toContainEqual(expect.objectContaining({type:'ocr-anchor',anchor:source[index],occurrences:0}));
        }
    });
});

describe('固定原创自然漫画的来源、PNG和独立source truth',()=>{
    it('四张PNG的长度、SHA与IHDR尺寸均匹配；十八条真值、无字区域和保护点坐标自洽',()=>{
        expect(naturalManifest.fixtures.map((f:any)=>f.name)).toEqual(['natural-station-journey-ink','natural-rain-market-color','natural-orbital-greenhouse-repair','natural-woodland-leaf-boat']);
        expect(naturalManifest.fixtures.reduce((count:number,f:any)=>count+f.expectedSource.length,0)).toBe(18);
        const provenance=JSON.parse(readFileSync(new URL('provenance.json',naturalRoot),'utf8'));
        expect(provenance).toMatchObject({mode:'built-in image_gen',regenerable:false});
        expect(provenance.inkPrompt).toContain('A QUIET MORNING');expect(provenance.colorPrompt).toContain('THE LAST BUS IS LATE.');
        expect(provenance.orbitalGreenhousePrompt).toContain('THE PUMP IS STILL WARM.');expect(provenance.woodlandLeafBoatPrompt).toContain('A LEAF CAN BE A BOAT.');
        for(const f of naturalManifest.fixtures) {
            const png=readFileSync(new URL(f.file,naturalRoot));
            expect(png.subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
            expect(png.readUInt32BE(8)).toBe(13);expect(png.toString('ascii',12,16)).toBe('IHDR');
            expect(png.readUInt32BE(16)).toBe(f.width);expect(png.readUInt32BE(20)).toBe(f.height);
            expect(png.length).toBe(f.bytes);expect(createHash('sha256').update(png).digest('hex')).toBe(f.sha256);
            expect(f.provenance).toMatchObject({original:true,exactTextVisuallyChecked:true,creationDate:'2026-10-25'});
            expect(f.expectedSource).toEqual(f.regions.map((r:any)=>r.text));expect(f.expectedAnchors).toEqual(f.expectedSource);
            expect(()=>validateQualityFixtureExpectations(f)).not.toThrow();
            expect(new Set(f.regions.map((r:any)=>r.id)).size).toBe(f.regions.length);
            for(const r of f.regions) {
                expect(r.bbox.x0).toBeGreaterThanOrEqual(0);expect(r.bbox.y0).toBeGreaterThanOrEqual(0);
                expect(r.bbox.x1).toBeGreaterThan(r.bbox.x0);expect(r.bbox.y1).toBeGreaterThan(r.bbox.y0);
                expect(r.bbox.x1).toBeLessThanOrEqual(f.width);expect(r.bbox.y1).toBeLessThanOrEqual(f.height);
            }
            expect(f.protectedProbes.length).toBe(3);
            for(const probe of f.protectedProbes) {
                expect(Number.isInteger(probe.x)&&probe.x>=0&&probe.x<f.width).toBe(true);
                expect(Number.isInteger(probe.y)&&probe.y>=0&&probe.y<f.height).toBe(true);
                expect(probe.rgb).toHaveLength(3);expect(probe.rgb.every((v:number)=>Number.isInteger(v)&&v>=0&&v<=255)).toBe(true);
                expect(f.regions.some((r:any)=>probe.x>=r.bbox.x0&&probe.x<r.bbox.x1&&probe.y>=r.bbox.y0&&probe.y<r.bbox.y1)).toBe(false);
            }
        }
        // 单测不引入PNG解码依赖；原图像素与RGB的核对由固定SHA对应的Pillow证据承担。
    });
    for(const f of naturalManifest.fixtures)it(`${f.name}：完美真值通过，单字误认或正确锚点旁的艺术误识别均失败`,()=>{
        const lines=f.regions.map((r:any)=>text(r.text,r.bbox));
        expect(evaluateQualityFixture(f,{texts:f.expectedSource,lines}).qualityFailures).toEqual([]);
        const wrong=[...f.expectedSource];wrong[0]='Z'+wrong[0].slice(1);
        const confused=evaluateQualityFixture(f,{texts:wrong,lines:lines.map((line:any,index:number)=>index===0?{...line,sourceText:wrong[0]}:line)});
        expect(confused.qualityFailures).toContainEqual(expect.objectContaining({type:'ocr-anchor',anchor:f.expectedAnchors[0]}));
        expect(confused.qualityFailures).toContainEqual(expect.objectContaining({type:'unexpected-ocr-characters'}));
        const art=evaluateQualityFixture(f,{texts:f.expectedSource,lines:[...lines,text('X',f.forbiddenRegions[0].bbox)]});
        expect(art.anchors.every((anchor:any)=>anchor.found)).toBe(true);
        expect(art.qualityFailures).toContainEqual(expect.objectContaining({type:'artwork-ocr-false-positive',sourceText:'X'}));
        expect(art.qualityFailures).toContainEqual(expect.objectContaining({type:'unexpected-ocr-characters'}));
    });
});

describe('固定漫画结构场景进入常规质量回归',()=>{
    it('无需模型校验五景全部冻结文字、像素散列与段落反例，运行不改写输入',()=>{
        const manifest=new URL('./fixtures/manga-structures/manifest.json',import.meta.url),before=readFileSync(manifest);
        const result=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/testing/check-manga-structure-fixtures.cjs',import.meta.url))],{encoding:'utf8',stdio:'pipe'}));
        expect(result).toMatchObject({scenes:5,fullSourceAnchors:29,negativeCases:51,allAssertionsPassed:true});
        expect(result.results.map((row:any)=>row.scene)).toEqual(['narrow-inset-card-dialogue','midband-crossing-detached-cards','bound-spread-gutter-caption','multisize-margin-callouts','photographed-perspective-note']);
        expect(readFileSync(manifest)).toEqual(before);
    });
});

describe('固定彩色文字场景进入常规质量回归',()=>{
    it('无需模型校验八类颜色/透明度输入，保留漏尾字、误报与合段失败门槛',()=>{
        const manifest=new URL('./fixtures/manga-chromatic/manifest.json',import.meta.url),before=readFileSync(manifest);
        const result=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/testing/check-manga-chromatic-fixtures.cjs',import.meta.url))],{encoding:'utf8',stdio:'pipe'}));
        expect(result).toMatchObject({passed:true,counts:{scenes:8,anchors:23,perfectTruthReplays:8,singleCharacterMisreadRejected:23,artInjectionsRejected:8,extraTextOutsideArtRejected:7,independentGroupsConflationRejected:7,coloredTailTruncationRejected:1,wordlessFalseTextRejected:1}});
        expect(readFileSync(manifest)).toEqual(before);
        const baselineBytes=readFileSync(new URL('./fixtures/manga-chromatic/first-ocr-baseline.json',import.meta.url));
        expect(createHash('sha256').update(baselineBytes).digest('hex')).toBe('f9ad54079eda32540b460e142f992f0df0bc1d5bf5ec80c7423f0e9c647a8fc0');
        const baseline=JSON.parse(baselineBytes.toString()),fixtures=JSON.parse(before.toString()).fixtures;
        expect(baseline.qualitySummary.anchors).toEqual({total:23,matched:14,failed:9});expect(baseline.passingScenes).toHaveLength(3);
        expect(baseline.scenes.map((scene:any)=>scene.scene)).toEqual(fixtures.map((f:any)=>f.name));
        for(const f of fixtures){
            const scene=baseline.scenes.find((scene:any)=>scene.scene===f.name);
            const quality=evaluateQualityFixture(f,{texts:scene.texts,lines:scene.ocrLines}),order=evaluateQualityReadingOrder(f,scene.texts);
            expect(scene.expectedSource).toEqual(f.expectedSource);expect(quality.anchors).toEqual(scene.anchors);
            expect([...quality.qualityFailures,...order.qualityFailures]).toEqual(scene.qualityFailures);
        }
    });
});

describe('固定透明度与段落结构场景进入常规质量回归',()=>{
    // 首次真实baseline仅26/29 anchors、0/6 strict且破坏保护像素；以下冻结真值回放不是OCR通过证明。
    const root=new URL('./fixtures/manga-alpha/',import.meta.url);
    const manifestBytes=readFileSync(new URL('manifest.json',root));
    const manifest=JSON.parse(manifestBytes.toString());
    // 只构造已声明真值的transport，测试验收门禁；不模拟生产OCR或分组算法。
    const sourceTransport=(f:any,overrides:Record<string,string>={})=>{
        const byId=new Map<string,any>(f.regions.map((region:any)=>[region.id,region]));
        const texts=f.paragraphGroups.map((group:string[])=>group.map(id=>overrides[id]??byId.get(id).text).join(' '));
        const lines=f.paragraphGroups.map((group:string[],index:number)=>{
            const boxes=group.map(id=>byId.get(id).bbox);
            return text(texts[index],box(Math.min(...boxes.map(b=>b.x0)),Math.min(...boxes.map(b=>b.y0)),Math.max(...boxes.map(b=>b.x1)),Math.max(...boxes.map(b=>b.y1))),boxes);
        });
        return {texts,lines};
    };
    it('完整manifest与设计先于OCR冻结，六张RGBA PNG的尺寸和散列不能自洽替换真值',()=>{
        expect(createHash('sha256').update(manifestBytes).digest('hex')).toBe('d5067fdf9438ff253c2124aaf665094f67ac5361847c56ccabfe806cded10060');
        const designBytes=readFileSync(new URL('design.json',root)),design=JSON.parse(designBytes.toString());
        expect(createHash('sha256').update(designBytes).digest('hex')).toBe('0a576bb798af2ae15632ac9a3e1576fe9dfc84c35e34756e4f01efd48afd5de7');
        expect(manifest.designSha256).toBe('0a576bb798af2ae15632ac9a3e1576fe9dfc84c35e34756e4f01efd48afd5de7');
        expect(manifest.fixtures.map((f:any)=>f.name)).toEqual(['transparent-lantern-bridge-balloons','translucent-riverside-notice','perforated-alpha-dock-note','same-tone-cabin-controls','inverse-neighbor-tidal-balloons','bound-atlas-rule-and-inset-card']);
        expect(manifest.fixtures.reduce((sum:number,f:any)=>sum+f.regions.length,0)).toBe(29);
        expect(manifest.fixtures.reduce((sum:number,f:any)=>sum+f.paragraphGroups.length,0)).toBe(20);
        const provenance=JSON.parse(readFileSync(new URL('provenance.json',root),'utf8'));
        expect(provenance).toMatchObject({designFreezeUtc:'2026-10-25 13:42:24 UTC',sourceTruthDesignedBeforeAnyOcr:true,selectionByOcrResult:false,pixelRefinementByOcrResult:false,sourceTextOrGroupsChangedAfterDesignFreeze:false,fontFilesBundled:false,modelWeightsBundled:false,generatedByAiImageTool:false,firstPixelFreezeManifestSha256:'d5067fdf9438ff253c2124aaf665094f67ac5361847c56ccabfe806cded10060'});
        for(const f of manifest.fixtures){
            const png=readFileSync(new URL(f.file,root));
            expect(png.subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
            expect(png.readUInt32BE(8)).toBe(13);expect(png.toString('ascii',12,16)).toBe('IHDR');
            expect(png.readUInt32BE(16)).toBe(f.width);expect(png.readUInt32BE(20)).toBe(f.height);
            expect([...png.subarray(24,29)]).toEqual([8,6,0,0,0]); // 固定8位、非交错RGBA，不能悄悄扁平化alpha。
            expect(png.length).toBe(f.bytes);expect(createHash('sha256').update(png).digest('hex')).toBe(f.sha256);
            expect(f.imageMode).toBe('RGBA');expect(f.decodedRgbaSha256).toMatch(/^[a-f0-9]{64}$/u);
            expect(f.provenance).toMatchObject({originalArtworkAndText:true,sourceDesignedBeforeAnyOcr:true,selectionByOcrResult:false,existing51Unmodified:true,designSha256:manifest.designSha256});
            expect(f.expectedSource).toEqual(f.regions.map((r:any)=>r.text));expect(f.expectedAnchors).toEqual(f.expectedSource);
            expect(f.regions.map((r:any)=>r.text)).toEqual(design.scenes.find((s:any)=>s.name===f.name).regions.map((r:any)=>r.text));
            expect(()=>validateQualityFixtureExpectations(f)).not.toThrow();
            expect(f.paragraphGroups.flat().sort()).toEqual(f.regions.map((r:any)=>r.id).sort());
            expect(new Set(f.paragraphGroups.flat()).size).toBe(f.regions.length);
            expect(f.forbiddenRegions.length).toBeGreaterThan(0);
            expect(()=>validateQualityFixtureExpectations({...f,forbiddenRegions:[{id:'text-is-not-art',bbox:f.regions[0].bbox}]})).toThrow('negative region contains no declared source text');
        }
        expect(readFileSync(new URL('manifest.json',root))).toEqual(manifestBytes);
    });
    it('RGBA源probe和孔洞是额外源证据：不把opaque通知或离线元数据当作浏览器alpha修补通过',()=>{
        let alphaProbes=0,opaqueProbes=0;
        for(const f of manifest.fixtures){
            const coverage=f.alphaCoverage;
            expect(Object.values(coverage).every(value=>Number.isSafeInteger(value)&&Number(value)>=0)).toBe(true);
            expect(coverage.transparentPixels+coverage.partialPixels+coverage.opaquePixels).toBe(f.width*f.height);
            expect(coverage.transparentPixels).toBeGreaterThan(0);
            expect(f.protectedProbes).toHaveLength(3);opaqueProbes+=f.protectedProbes.length;alphaProbes+=f.protectedAlphaProbes.length;
            for(const probe of [...f.protectedProbes,...f.protectedAlphaProbes]){
                expect(Number.isInteger(probe.x)&&probe.x>=0&&probe.x<f.width).toBe(true);
                expect(Number.isInteger(probe.y)&&probe.y>=0&&probe.y<f.height).toBe(true);
                const values=probe.rgba??probe.rgb;
                expect(values).toHaveLength(probe.rgba?4:3);expect(values.every((v:number)=>Number.isInteger(v)&&v>=0&&v<=255)).toBe(true);
                if(probe.rgb)expect(f.regions.some((r:any)=>probe.x>=r.bbox.x0&&probe.x<r.bbox.x1&&probe.y>=r.bbox.y0&&probe.y<r.bbox.y1)).toBe(false);
            }
        }
        expect(opaqueProbes).toBe(18);expect(alphaProbes).toBe(25);
        expect(manifest.fixtures.filter((f:any)=>f.alphaCoverage.partialPixels>0)).toHaveLength(4);
        const balloons=manifest.fixtures.find((f:any)=>f.name==='transparent-lantern-bridge-balloons');
        expect(balloons.alphaCoverage.partialPixels).toBeGreaterThan(0);
        expect(balloons.protectedAlphaProbes.map((p:any)=>p.rgba[3])).toEqual([0,0,0,0]); // 已冻结probe未覆盖208/224泡内，不能据此宣称半透明修补通过。
        const notice=manifest.fixtures.find((f:any)=>f.name==='translucent-riverside-notice');
        expect(notice.alphaCoverage.partialPixels).toBe(0); // alpha156白层已与opaque市场底合成，不能称其内部仍有部分alpha。
        expect(notice.protectedAlphaProbes.find((p:any)=>p.x===150&&p.y===200).rgba[3]).toBe(255);
        const dock=manifest.fixtures.find((f:any)=>f.name==='perforated-alpha-dock-note');
        expect(dock.sourceAlphaHoles.map((hole:any)=>hole.alpha)).toEqual([0,96]);
        for(const hole of dock.sourceAlphaHoles){
            const region=dock.regions.find((r:any)=>r.id===hole.regionId),b=hole.bbox;
            expect(hole.sourceGlyphMaskCoverage).toBe(0);expect(b.x1-b.x0).toBe(6);expect(b.y1-b.y0).toBe(18);
            expect(b.x0>=region.bbox.x0&&b.y0>=region.bbox.y0&&b.x1<=region.bbox.x1&&b.y1<=region.bbox.y1).toBe(true);
            expect(hole.probe.x>=b.x0&&hole.probe.x<b.x1&&hole.probe.y>=b.y0&&hole.probe.y<b.y1).toBe(true);
            const probe=dock.protectedAlphaProbes.find((p:any)=>p.regionId===hole.regionId);
            expect(probe).toMatchObject(hole.probe);expect(probe.rgba[3]).toBe(hole.alpha);
        }
        // 不引入PNG解码/字体/Pillow依赖。固定PNG SHA绑定独立Pillow源像素证据；这里不声称runner已读取额外RGBA字段。
    });
    for(const f of manifest.fixtures)it(`${f.name}：完整truth回放及严格的错字、独立段落、负区和多字门禁`,()=>{
        const perfect=sourceTransport(f),before=JSON.stringify(f);
        expect(evaluateQualityFixture(f,perfect).qualityFailures).toEqual([]);
        expect(evaluateQualityReadingOrder(f,perfect.texts).qualityFailures).toEqual([]);
        for(const region of f.regions){
            const wrong=sourceTransport(f,{[region.id]:'X'+Array.from(region.text).slice(1).join('')});
            expect(evaluateQualityFixture(f,wrong).qualityFailures).toContainEqual(expect.objectContaining({type:'ocr-anchor',anchor:region.anchor}));
        }
        const merged=perfect.texts.join(' '),allBoxes=f.regions.map((r:any)=>r.bbox);
        expect(evaluateQualityFixture(f,{texts:[merged],lines:[text(merged,allBoxes[0],allBoxes)]}).qualityFailures).toEqual([]);
        expect(evaluateQualityReadingOrder(f,[merged]).qualityFailures).toContainEqual(expect.objectContaining({type:'paragraph-order'}));
        const reversed=[...perfect.texts],index=f.paragraphGroups.findIndex((group:string[])=>group.length>1);
        reversed[index]=[...f.paragraphGroups[index]].reverse().map(id=>f.regions.find((r:any)=>r.id===id).text).join(' ');
        expect(evaluateQualityReadingOrder(f,reversed).qualityFailures).toContainEqual(expect.objectContaining({type:'paragraph-order'}));
        if(f.name==='same-tone-cabin-controls'){
            const statusMerged=[perfect.texts[0],`${perfect.texts[1]} ${perfect.texts[2]}`,perfect.texts[3]];
            const order=evaluateQualityReadingOrder(f,statusMerged);
            expect(order.paragraphGroups[0].found).toBe(true);expect(order.paragraphGroups[3].found).toBe(true);
            expect(order.qualityFailures).toHaveLength(2);expect(order.qualityFailures.every((failure:any)=>failure.type==='paragraph-order')).toBe(true);
        }
        const art=evaluateQualityFixture(f,{texts:perfect.texts,lines:[...perfect.lines,text('…',f.forbiddenRegions[0].bbox)]});
        expect(art.anchors.every((anchor:any)=>anchor.found)).toBe(true);expect(art.sourceCharacterInventory.excess).toEqual([]);
        expect(art.qualityFailures).toEqual([expect.objectContaining({type:'artwork-ocr-false-positive',sourceText:'…'})]);
        const extra=evaluateQualityFixture(f,{texts:perfect.texts,lines:perfect.lines.map((line:any,index:number)=>index===0?{...line,sourceText:line.sourceText+'Q'}:line)});
        expect(extra.anchors.every((anchor:any)=>anchor.found)).toBe(true);expect(extra.negativeDetections).toEqual([]);
        expect(extra.qualityFailures).toContainEqual(expect.objectContaining({type:'unexpected-ocr-characters'}));
        const first=f.regions[0],duplicate=evaluateQualityFixture(f,{texts:[...perfect.texts,first.text],lines:[...perfect.lines,text(first.text,first.bbox)]});
        expect(duplicate.qualityFailures).toContainEqual(expect.objectContaining({type:'duplicate-anchor',anchor:first.anchor}));
        expect(JSON.stringify(f)).toBe(before);
    });
});
