/**
 * @file tests/longPageMockTransport.test.ts
 * 文件职责：约束长页浏览器夹具使用绑定源文的确定性译文，避免回显正文触发真实结果校验。
 * 主要内容：在独立 VM 中执行共享编解码器与实际传输替身，验证逐槽归属、行内标记、请求体及远端隔离。
 * 模块边界：只验证测试协议，不证明真实供应商质量或浏览器时延；产品结果校验保持原样。
 */
import {describe,expect,it} from 'vitest';
import {createRequire} from 'node:module';
import {createContext,runInContext} from 'node:vm';
import {isClearlyWrongLanguageResponse} from '@/src/core/translation/resultValidation';

const require=createRequire(import.meta.url);
const {controlledProviderRuntime}=require('../scripts/site-translation/controlled-provider.cjs');
const {installLongPageMockTransport,parseArgs}=require('../scripts/testing/run-long-page-mock-test.cjs');
const endpoint='https://edge.microsoft.com/translate/translatetext';
function runtime() {
    const context=createContext({URL,Request,Response,TextEncoder,TextDecoder,setTimeout});
    runInContext(`(${controlledProviderRuntime.toString()})(true)`,context);
    runInContext(`(${installLongPageMockTransport.toString()})(0)`,context);
    return context;
}
describe('source-bound long-page mock transport',()=>{
    it('retains source ownership and inline slots without passing an English echo as a translation',async()=>{
        const context=runtime();
        const original='LPM-ARTICLE-000-0: Careful readers compare several observations before drawing a conclusion. The surrounding evidence describes a reproducible experiment, its assumptions, and the remaining uncertainty. A ___FLUENTREAD_LINK_0_BEGIN___related explanation___FLUENTREAD_LINK_0_END___ provides additional context and meaningful conclusions for the reader.';
        const legacy=`长页译文 LPM-ARTICLE-000-0。这段中文解释观察结果和实验边界，读者可以继续查看相关材料。${original}`;
        expect(isClearlyWrongLanguageResponse(original,legacy,'zh-Hans')).toBe(true);
        context.body=JSON.stringify([original]);context.endpoint=endpoint;
        const response:Response=await runInContext('fetch(endpoint,{body})',context);
        const rows=await response.json() as {translations:{text:string}[]}[];
        const text=rows[0]!.translations[0]!.text,prefix='长页译文 LPM-ARTICLE-000-0。';
        expect(text.startsWith(prefix)).toBe(true);
        expect(text).not.toContain('Careful readers');
        expect(isClearlyWrongLanguageResponse(original,text,'zh-Hans')).toBe(false);
        // The real renderer removes protocol markers when reconstructing native inline nodes.
        const slots=/___FLUENTREAD_LINK_0_(?:BEGIN|END)___/g;
        context.encoded=text.slice(prefix.length).replace(slots,'');
        expect(runInContext(`(${controlledProviderRuntime.toString()})().decodeText(encoded)`,context)).toBe(original.replace(slots,''));
        expect(text.match(/___FLUENTREAD_LINK_0_BEGIN___/g)).toHaveLength(1);
        expect(text.match(/___FLUENTREAD_LINK_0_END___/g)).toHaveLength(1);
        expect(runInContext('__longMockRequests.length',context)).toBe(1);
        expect(runInContext('__frCompatibilityTransport.active',context)).toBe(0);
    });
    it('supports a native Request body without consuming it ahead of the shared transport',async()=>{
        const context=runtime();
        context.input=new Request(endpoint,{method:'POST',body:JSON.stringify(['A reproducible observation.'])});
        const response:Response=await runInContext('fetch(input)',context);
        const rows=await response.json() as {translations:{text:string}[]}[];
        expect(rows[0]!.translations[0]!.text.startsWith('长页译文 overview。')).toBe(true);
        expect(runInContext('__longMockRequests[0].texts[0]',context)).toBe('A reproducible observation.');
    });
    it('preserves the authored long identifier so the browser still exercises native overflow',async()=>{
        const context=runtime(),literal='UnbrokenIdentifier_'+'W'.repeat(240);
        const source=`LPM-ARTICLE-004-0: Careful readers compare several observations before drawing a conclusion. The surrounding evidence describes a reproducible experiment, its assumptions, and the remaining uncertainty. ${literal}`;
        context.body=JSON.stringify([source]);context.endpoint=endpoint;
        const response:Response=await runInContext('fetch(endpoint,{body})',context);
        const rows=await response.json() as {translations:{text:string}[]}[];
        const output=rows[0]!.translations[0]!.text;
        expect(output.split(literal)).toHaveLength(2);
        expect(output).not.toContain('Careful readers');
        expect(isClearlyWrongLanguageResponse(source,output,'zh-Hans')).toBe(false);
    });
    it('rejects unexpected providers before making any network request',async()=>{
        const context=runtime();
        await expect(runInContext('fetch("https://unexpected.example/",{body:"[]"})',context)).rejects.toThrow('forbids external provider');
        expect(runInContext('__longMockRequests.length',context)).toBe(0);
    });
    it('binds a comparison build to its explicit production source root while retaining argument checks',()=>{
        const args=['--extension-dir','/tmp/build','--production-root','/tmp/frozen-source','--playwright-root','/tmp/packages','--artifacts-dir','/tmp/evidence'];
        expect(parseArgs(args).productionRoot).toBe('/tmp/frozen-source');
        expect(()=>parseArgs([...args,'--skip-freshness','true'])).toThrow('Unknown argument');
    });
});
