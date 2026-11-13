/** @file tests/mangaFixtureTransport.test.ts 在完全模拟的 fetch 中执行真实漫画测试器注入函数，验证受控翻译不会触达真实供应商。 */
import {describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

const source=readFileSync(new URL('../scripts/testing/run-manga-translation-test.cjs',import.meta.url),'utf8');
const ast=ts.createSourceFile('run-manga-translation-test.cjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const setups:ts.ArrowFunction[]=[];
function visit(node:ts.Node):void {
    if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='evaluate'
        &&node.expression.expression.getText(ast)==='worker'&&node.arguments[0]&&ts.isArrowFunction(node.arguments[0])){
        const setup=node.arguments[0],assigned=new Set<string>();
        function collect(child:ts.Node):void {
            if(ts.isBinaryExpression(child)&&child.operatorToken.kind===ts.SyntaxKind.EqualsToken
                &&ts.isPropertyAccessExpression(child.left)&&ts.isIdentifier(child.left.expression)&&child.left.expression.text==='globalThis')
                assigned.add(child.left.name.text);
            ts.forEachChild(child,collect);
        }
        collect(setup.body);
        if(assigned.has('__mangaTest')&&assigned.has('fetch'))setups.push(setup);
    }
    ts.forEachChild(node,visit);
}
visit(ast);
function install(live=false,translationMap:Record<string,string>|null={SAMPLE:'演示译文'}) {
    expect(setups).toHaveLength(1);
    const original=vi.fn(async()=>new Response('owned fake response',{status:200}));
    const context:Record<string,any>={fetch:original,URL,URLSearchParams,Response,
        setTimeout:(callback:()=>void)=>{callback();return 0;},chrome:{runtime:{onMessage:{addListener:vi.fn()}}}};
    runInNewContext(`(${setups[0].getText(ast)})(${JSON.stringify({live,trace:false,traceLayout:false,layoutTraceLimit:32,translationMap})})`,context);
    return {context,original};
}

describe('漫画测试器的受控翻译网络边界',()=>{
    it.each(['/translate/auth','/translate/translatetext','/translate/unrecognized'])('受控模式阻止微软翻译路径 %s，原 fetch 不会被调用',async pathname=>{
        const {context,original}=install();
        await expect(context.fetch('https://edge.microsoft.com'+pathname,{method:'POST',body:JSON.stringify([{Text:'SAMPLE'}])}))
            .rejects.toThrow('Unexpected Microsoft fixture transport');
        expect(original).not.toHaveBeenCalled();
    });
    it('Google 固定文本本地完成，缺失词条和未知路径失败且不回到原 fetch',async()=>{
        const {context,original}=install(),endpoint='https://translate-pa.googleapis.com/v1/translateHtml';
        const response=await context.fetch(endpoint,{method:'POST',body:JSON.stringify([[['SAMPLE']]])});
        expect(await response.json()).toEqual([['<pre>演示译文</pre>']]);
        await expect(context.fetch(endpoint,{method:'POST',body:JSON.stringify([[['MISSING']]])})).rejects.toThrow('Missing controlled image translation');
        await expect(context.fetch('https://translate.googleapis.com/unrecognized')).rejects.toThrow('Unexpected Google fixture transport');
        expect(original).not.toHaveBeenCalled();
    });
    it('翻译拦截不替代模型读取；显式真实模式仍记录原传输结果，所有原传输在本测试均为模拟函数',async()=>{
        const controlled=install();
        await controlled.context.fetch('https://models.example.test/model.onnx');
        expect(controlled.original).toHaveBeenCalledExactlyOnceWith('https://models.example.test/model.onnx',undefined);
        const live=install(true),body=JSON.stringify([{Text:'SAMPLE'}]);
        const response=await live.context.fetch('https://edge.microsoft.com/translate/translatetext',{method:'POST',body});
        expect(response.status).toBe(200);expect(live.original).toHaveBeenCalledOnce();
        expect(live.context.__mangaTest.transportRequests).toMatchObject([{endpoint:'microsoft-translatetext',items:1,status:200}]);
    });
});
