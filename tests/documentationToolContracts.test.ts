/**
 * @file tests/documentationToolContracts.test.ts
 * 文件职责：执行完整文档交付脚本，验证本地化品牌契约、产物归属与截图资源释放。
 * 主要内容：隔离文件夹中的真实 MJS CLI；独立子进程执行完整 CJS，替换浏览器、图像和文件端口。
 * 模块边界：不启动浏览器，不写项目文案或产物，不读取用户配置；baseline 使用同一用例。
 */
import {afterEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';

const repo = path.resolve(__dirname, '..');
const sourceRoot = process.env.DOCUMENTATION_TOOL_SOURCE_ROOT || repo;
const roots: string[] = [];
const taglines = JSON.parse(fs.readFileSync(path.join(repo, 'src/core/i18n/messages/brand-taglines.json'), 'utf8')) as Record<string, string>;
const combined = `${taglines['en-US']} ${taglines['zh-CN']}`;
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-doc-contract-'));
    roots.push(root);
    return root;
}
function write(root: string, file: string, data: string) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, data);
}
function recordProbe(probe: Record<string, unknown>) {
    const file = process.env.DOCUMENTATION_TOOL_PROBE_JSONL;
    if (file) fs.appendFileSync(file, JSON.stringify(probe) + '\n');
}
afterEach(() => {for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true});});

// Every probe waits for close, kills a timed-out child, and has bounded captured output.
async function child(args: string[], cwd: string, label: string, budgetMs = 8000) {
    return new Promise<{code: number | null; signal: string | null; out: string; err: string; timedOut: boolean}>((resolve, reject) => {
        const coverageRoot = process.env.DOCUMENTATION_TOOL_CHILD_COVERAGE;
        const proc = spawn(process.execPath, args, {cwd, env: {...process.env,
            ...(coverageRoot ? {NODE_V8_COVERAGE: path.join(coverageRoot, label)} : {})}, stdio: ['ignore', 'pipe', 'pipe']});
        let out = '', err = '', timedOut = false;
        const timeout = setTimeout(() => {timedOut = true; proc.kill('SIGKILL');}, budgetMs);
        proc.stdout.on('data', data => {out = (out + data).slice(-1000000);});
        proc.stderr.on('data', data => {err = (err + data).slice(-1000000);});
        proc.once('error', error => {clearTimeout(timeout); reject(error);});
        proc.once('close', (code, signal) => {clearTimeout(timeout); resolve({code, signal, out, err, timedOut});});
    });
}
async function checker(root: string, script: string) {
    const source = fs.readFileSync(path.join(sourceRoot, 'scripts', script), 'utf8');
    const sourcePath = path.join(root, 'scripts', script);
    write(root, `scripts/${script}`, source);
    const coverageRoot = process.env.DOCUMENTATION_TOOL_CHILD_COVERAGE;
    if (coverageRoot) {
        fs.mkdirSync(coverageRoot, {recursive:true});
        const sha256 = createHash('sha256').update(source).digest('hex');
        fs.writeFileSync(path.join(coverageRoot, sha256 + path.extname(script)), source);
        fs.appendFileSync(path.join(coverageRoot, 'executed-source-manifest.jsonl'), JSON.stringify({sourcePath, originalPath:path.join(sourceRoot,'scripts',script), sha256}) + '\n');
    }
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    write(root, 'fs-count.cjs', `const fs=require('node:fs'),path=require('node:path');const base=path.join(process.cwd(),'docs');const start=process.hrtime.bigint();const counts={};for(const method of ['existsSync','statSync','realpathSync','readFileSync','readdirSync']){const original=fs[method];fs[method]=function(file,...args){if(String(file).startsWith(base))counts[method]=(counts[method]||0)+1;return original.call(this,file,...args);};}process.on('exit',()=>fs.writeFileSync('operations.json',JSON.stringify({counts,durationMs:Number(process.hrtime.bigint()-start)/1e6})));`);
    const result = await child(['--require',path.join(root, 'fs-count.cjs'),path.join(root, 'scripts', script)], root, script);
    recordProbe({family:'checker',script,sourceRoot,sourcePath,sourceSha256:createHash('sha256').update(source).digest('hex'),result});
    expect(result.timedOut).toBe(false);
    expect(result.signal).toBeNull();
    return result;
}
function brandFixture(bilingual = false) {
    const root = fixture();
    write(root, 'src/core/i18n/messages/brand-taglines.json', JSON.stringify(taglines));
    write(root, 'package.json', JSON.stringify({description: combined}));
    write(root, 'marketing/brand.md', Object.values(taglines).join('\n'));
    for (const language of Object.keys(taglines)) write(root, `src/core/i18n/messages/${language}.ts`, `"brand.tagline": brandTaglines['${language}']`);
    for (const [locale, language] of [['en', 'en-US'], ['zh-CN', 'zh-CN']]) {
        const folder = `marketing/chrome-web-store/${locale}`;
        write(root, `${folder}/short-description.txt`, combined + '\n');
        write(root, `${folder}/listing.json`, JSON.stringify({shortDescription: combined}));
        write(root, `${folder}/description.txt`, `${taglines[language]}\n\nFixture`);
        write(root, `marketing/copy/${locale}.md`, taglines[language]);
    }
    write(root, 'README.md', `<div>${bilingual ? combined : taglines['en-US']}\n[简体中文](./misc/README_ZH.md)</div>`);
    write(root, 'misc/README_ZH.md', `<div>${bilingual ? combined : taglines['zh-CN']}\n[English](../README.md)</div>`);
    return root;
}

const workflow = '<ol class="ds"><li class="ds-current"><button type="button" aria-label="First" aria-current="step">1</button></li><li><button type="button" aria-label="Second">2</button></li><li><button type="button" aria-label="Third">3</button></li></ol>';
function page(route: string, body: string) {
    const alternate = (route.startsWith('en/') ? route.slice(3) : 'en/' + route).replace(/index\.html$/, '').replace(/\.html$/, '');
    return `<!doctype html><html><head><link rel="canonical" href="https://read.thinkstu.com/${route}"><link rel="alternate" hreflang="en" href="/${alternate}"></head><body><a class="bv-language" href="/${alternate}">Language</a>${body}</body></html>`;
}
function home(prefix: string) {
    const english = Boolean(prefix), slogan = taglines[english ? 'en-US' : 'zh-CN'];
    return `<div class="bv-site"><header class="bv-home-header"><div class="bv-home-brand"><img src="/brand-icon.webp" width="96" height="96">${english ? 'FluentRead' : '流畅阅读'}</div></header>
        <section class="bv-hero"><h1 class="bv-hero-slogan">${slogan}</h1><div class="bv-hero-intro"><span>${english ? 'FluentRead is an open-source browser extension for bilingual translation.' : '流畅阅读，一款开源的浏览器双语翻译插件'}</span></div><div class="bv-install-actions"><a class="bv-primary" href="https://example.test/install">Install</a></div><a class="bv-docs-link" href="${prefix}/docs/">${english ? 'Documentation' : '使用文档'}</a><div class="bv-hero-orbit">Hello 你好<i class="bv-orbit-page"></i><i class="bv-orbit-document"></i><i class="bv-orbit-grammar"></i></div></section>
        <section class="bv-translation-section"><h2>${english ? 'Bilingual' : '双语翻译'}</h2><div class="bv-feature-row"><div data-demo="brand-reader" data-playing="true">${workflow}<div class="fd-sentence-card"></div><div class="fd-structure-card"></div><div class="fd-word-card"></div></div></div></section>
        ${['document', 'image', 'video', 'selection'].map(kind => `<div class="bv-feature-row"><div data-visual="${kind}" data-playing="true">${workflow}</div></div>`).join('')}
        <div class="bv-video-platforms">YouTube X Google Meet Teams Zoom</div><div class="bv-browser-options"><a>1</a><a>2</a><a>3</a></div>
        <div class="fd-selection"><button aria-label="${english ? 'Preview reading the original' : '演示朗读原文'}"></button><button aria-label="${english ? 'Preview reading the translation' : '演示朗读译文'}"></button></div>
        <div class="bv-promo"><video controls preload="none" poster="/videos/fluentread-promo-${english ? 'en' : 'zh'}-poster.webp"><source src="/videos/fluentread-promo-${english ? 'en' : 'zh'}.mp4"></video><p class="bv-promo-more"><a href="https://www.bilibili.com/video/BV1qhHJ6uEiF/" target="_blank" rel="noopener">Official introduction</a></p></div></div>`;
}
function docsFixture(extra = '') {
    const root = fixture(), dist = 'docs/.vitepress/dist';
    write(root, 'src/core/i18n/messages/brand-taglines.json', JSON.stringify(taglines));
    for (const prefix of ['', 'en/']) {
        write(root, `${dist}/${prefix}index.html`, page(`${prefix}index.html`, home(prefix ? '/en' : '') + extra));
        write(root, `${dist}/${prefix}docs/index.html`, page(`${prefix}docs/index.html`, `<h1>Documentation</h1><div class="VPNavBarTitle"><div class="title">流畅阅读 FluentRead</div></div><div class="fr-docs-start"><a href="/docs/">Start</a></div><div class="fr-docs-links">${'<a href="/docs/">Guide</a>'.repeat(20)}</div>`));
        write(root, `${dist}/${prefix}config/translation-engines.html`, page(`${prefix}config/translation-engines.html`, '<h1>Engines</h1><div class="vp-doc">{{apiKey}}</div>'));
        write(root, `${dist}/${prefix}guide/input-translation.html`, page(`${prefix}guide/input-translation.html`, '<h1>Input</h1><div class="vp-doc">{{origin}} {{to}}</div>'));
        write(root, `docs/${prefix}guide/input-translation.md`, 'Fixture');
        write(root, `docs/${prefix}config/translation-engines.md`, 'Fixture');
    }
    write(root, `${dist}/404.html`, '<meta name="robots" content="noindex">');
    for (const name of ['brand-icon.webp', 'sitemap.xml', 'videos/fluentread-promo-en.mp4', 'videos/fluentread-promo-zh.mp4', 'videos/fluentread-promo-en-poster.webp', 'videos/fluentread-promo-zh-poster.webp']) write(root, `${dist}/${name}`, 'fixture asset');
    return root;
}

function storybookFixture() {
    const root = fixture(), dist = 'docs/.vitepress/dist/storybook';
    const titles = ['Overview/Introduction', 'Foundations/Colors', 'Foundations/Typography', 'Foundations/Surfaces', 'UI/Select', 'UI/FeatureEnableCard', 'UI/DownloadProgress', 'UI/ServiceIcon', 'UI/UiIcon', 'UI/TranslationLoading', 'UI/Controls', 'Examples/Settings'];
    const entries: Record<string, {id: string; title: string; type: string}> = {};
    for (const title of titles) {
        const slug = title.toLowerCase().replace('/', '-');
        for (const type of ['story', 'docs']) {
            const id = `${slug}--${type}`;
            entries[id] = {id, title, type};
        }
    }
    write(root, `${dist}/index.json`, JSON.stringify({entries}));
    write(root, `${dist}/index.html`, '<!doctype html><script src="./assets/app.js"></script>');
    write(root, `${dist}/iframe.html`, '<!doctype html><link rel="stylesheet" href="./assets/app.css">');
    write(root, `${dist}/assets/app.js`, 'console.log("fixture");');
    write(root, `${dist}/assets/app.css`, 'body { color: black; }');
    return root;
}

// External ports only: execute the entire actual CJS file without extracting its helpers.
const captureRunner = String.raw`
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), {EventEmitter} = require('node:events');
const {performance} = require('node:perf_hooks');
const input = JSON.parse(process.argv[1]), source = fs.readFileSync(input.source, 'utf8');
const state = {loaded:true, calls:[], errors:[], reports:[], writes:[], config:[], cdps:0, detached:0, profile:null, removed:[], listening:false};
let server, clip, metrics;
state.actorGone = false; state.guardProbes = []; state.required = [];
const unrelated=path.join(input.fixture,'unrelated-profile');fs.mkdirSync(unrelated);fs.writeFileSync(path.join(unrelated,'sentinel'),'unrelated owner');
const fail = name => {if (input.fail?.includes(name)) throw Error(name + '-failure');};
const virtual = new Map(), bytes = Buffer.from('fixture-pixels');
const fsPort = {...fs,
 readFileSync(file, encoding) {if(String(file).endsWith('manifest.json')) return JSON.stringify({version:'fixture'}); return encoding ? 'fixture-source' : Buffer.from('fixture-source');},
 mkdtempSync() {state.calls.push('profile.create'); fail('profile'); state.profile = fs.mkdtempSync(path.join(input.fixture,'owned-profile-')); return state.profile;},
 mkdirSync() {},
 writeFileSync(file, data) {state.writes.push(String(file)); if(String(file).endsWith('/marketing/site-ui-manifest.json')||String(file).endsWith('/report.json')) {state.calls.push('report.write'); state.attemptedReport=JSON.parse(data); fail('report');} virtual.set(String(file),data); fail('write');},
 statSync() {return {size:bytes.length};},
 rmSync(file, options) {state.calls.push('profile.remove'); state.removed.push(String(file)); if(file!==state.profile) throw Error('unowned-remove'); fs.rmSync(file,options); fail('remove');}
};
const httpPort = {createServer(callback) {
 state.calls.push('server.create'); fail('server.create'); server = new EventEmitter(); server.listening=false; server.respond=callback;
 server.listen = (port, host, ready) => {state.calls.push('server.listen'); if(input.fail?.includes('listen')) {queueMicrotask(()=>server.emit('error', Error('listen-failure'))); return server;} server.listening=true; queueMicrotask(ready); return server;};
 server.address = () => ({port:12345});
 server.closeAllConnections = () => {state.calls.push('server.connections'); fail('connections');};
 server.close = callback => {state.calls.push('server.close'); server.listening=false; callback?.(input.fail?.includes('server.close') ? Error('server.close-failure') : undefined);};
 return server;
}};
function locator(selector) {return {waitFor:async()=>{fail('wait');},click:async()=>{},first(){return this;},last(){return this;},boundingBox:async()=> {
 if(input.fail?.includes('rect')) return null;
 if(input.fail?.includes('target') && selector.endsWith(':visible')) return {x:0,y:900,width:40,height:20};
 if(input.fail?.includes('target.right') && selector.endsWith(':visible')) return {x:1600,y:20,width:40,height:20};
 return {x:0,y:0,width:360,height:700};
}};}
const page = {on(name, fn) {if(input.fail?.includes('pageerror')) fn(Error('pageerror-failure'));}, goto:async()=>{fail('goto');},reload:async()=>{},locator,
 evaluate:async(fn,arg)=>fn(arg), setViewportSize:async()=>{},waitForTimeout:async()=>{},close:async()=>{state.calls.push('page.close');}};
const ctx = {browser:()=>({newBrowserCDPSession:async()=>({send:async()=>({processInfo:[{type:'browser',id:424242}]}),detach:async()=>{}})}),serviceWorkers:()=>{if(input.fixtureCLI)throw Error('body-failure');return input.waitWorker ? [] : [{url:()=> 'chrome-extension://fixture/worker.js'}];},waitForEvent:async()=>({url:()=> 'chrome-extension://fixture/worker.js'}),
 newCDPSession:async()=>{state.cdps++; return {send:async(method, options)=>{fail('cdp'); if(method==='Emulation.setDeviceMetricsOverride') metrics=options; else {clip=options.clip; return {data:bytes.toString('base64')};}},detach:async()=>{state.detached++;fail('detach');}};}};
const helper = {launchFocusSafePersistentContext:async options=> {
 state.calls.push('browser.launch'); state.launch=options; fail('launch'); if(input.noSession)return undefined; state.listening=server.listening;
 if(!input.fixtureCLI){const response={setHeader:(_,value)=>state.article={type:value},end:text=>state.article.text=text};server.respond({},response);}
 state.session = {context:ctx,launchMode:input.fixtureCLI||input.fail?.includes('helper.legacy')?'macos-background-cdp':'fixture',focusPolicy:input.fixtureCLI?'launchservices-no-foreground':'fixture',windowPlacement:input.fixtureCLI?{mode:'background-visible-no-focus',browserFrontmost:false}:'fixture',close:async()=>{state.calls.push('browser.close'); state.actorGone=true; fail('browser.close');state.rawCloseFulfilled=true;}};
 if(input.fixtureCLI&&!input.fail?.includes('helper.legacy')) {state.session.closeBrowserConnection=state.session.close;state.session.useGuardedClose=()=>state.calls.push('guard.route');}
 return state.session;
},newPageWithoutForeground:async()=>page,activateExtensionTabWithoutForeground:async()=>{}};
const sharp = () => {const api={webp:()=>api,ensureAlpha:()=>api,raw:()=>api,toBuffer:async()=>bytes,
 toFile:async file=>{virtual.set(file,bytes);},metadata:async()=>({width:clip.width*metrics.deviceScaleFactor,height:clip.height*metrics.deviceScaleFactor})};return api;};
const provider={requestPayloads:()=>[],close:async()=>{state.calls.push('provider.close');fail('provider.close');if(input.fail?.includes('provider.callback'))return Error('provider.callback-failure');}};
const args=input.fixtureCLI?['--playwright-root',input.fixture,'--focus-safe-helper','fixture-helper','--extension-dir',path.join(input.fixture,'extension'),'--artifacts-dir',path.join(input.fixture,'artifacts')]:['--runtime',input.fixture,'--helper','fixture-helper'];
const processPort = {argv:['fixture-node','fixture-script',...(input.args||args)],exitCode:0};
// Run the unchanged owned-browser-close implementation. CDP/ps/kill are
// explicit controlled ports; their simulated PID absence is never native proof.
const guardModule = {exports:{}};
const guardSource=fs.readFileSync(input.guardSource,'utf8');
state.guardSha256=require('node:crypto').createHash('sha256').update(guardSource).digest('hex');
vm.runInNewContext(guardSource,{module:guardModule,require:name=>{
 if(name==='node:child_process') return {execFile:(_cmd,args,_options,callback)=>{
  if(_cmd!=='/bin/ps'||args[2]!=='424242') throw Error('unexpected-process-query');
  state.guardProbes.push(state.actorGone?'absent':'present');
  if(input.fail?.includes('guard.receipt')) {const error=Error('guard.receipt-failure');error.code='EACCES';callback(error,'','denied');}
  else if(state.actorGone) {const error=Error('absent');error.code=1;callback(error,'','');}
  else callback(null,'424242 Thu Oct 8 12:00:00 2026 S /fixture/browser --user-data-dir='+state.profile+'\n','');
 }};
 if(['node:fs','node:os','node:path'].includes(name)) return require(name);
 throw Error('unexpected-guard-dependency: '+name);
},process:{pid:process.pid,platform:'darwin',env:{},kill:(pid,signal)=>{if(pid!==424242)throw Error('unowned-signal');state.calls.push('guard.signal.'+signal);state.actorGone=true;}},performance,setTimeout,clearTimeout},{filename:input.guardSource,timeout:2000});
const guardPort={guardBrowserClose(session,profile){
 state.calls.push('guard.bind'); fail('guard.bind');
 if(session!==state.session||profile!==state.profile) throw Error('guard-binding-ownership');
 const guarded=guardModule.exports.guardBrowserClose(session,profile);state.guardBound=true;return guarded;
}};
const requirePort = name => {
 state.required.push(name);
 if(name==='../run-full-page-translation-test.cjs')return {startTranslationFixtureServer:async()=>{state.calls.push('provider.create');fail('provider.start');return provider;},installTranslationFixtureOnWorker:()=>{throw Error('unexpected-worker-entry');}};
 if(name===path.join(input.fixture,'playwright'))return {chromium:{fixture:true}};
 if(name==='node:fs') return fsPort; if(name==='node:http') return httpPort;
 if(name==='./testing/owned-browser-close.cjs'||name==='./owned-browser-close.cjs') return guardPort;
 if(name==='node:module') return {createRequire:file=>{state.calls.push('runtime.load');state.runtimePath=file;return name=>name==='playwright'?{chromium:{fixture:true}}:sharp;}};
 if(name==='node:child_process') return {execFileSync:(_,args)=>args[0]==='rev-parse'?'fixture-head\n':''};
 if(name==='fixture-helper' || name==='fixture-node') {state.calls.push('helper.load');state.helperPath=name;return helper;}
 return require(name);
};
const sandbox = {require:requirePort,__dirname:path.dirname(input.source),Buffer,process:processPort,
 console:{log:value=>state.reports.push(JSON.parse(value)),error:(...errors)=>state.errors.push(errors.map(error=>String(error.stack||error)).join(' '))},
 document:{fonts:{ready:Promise.resolve()}},crypto:require('node:crypto').webcrypto,
 chrome:{runtime:{sendMessage:async message=>{fail('message');if(message.type==='configStorageRead') {if(input.fail?.includes('read')) return {success:false,error:'read-failure'};return {success:true,value:input.objectConfig ? {__fluentConfigRevision:3,fixture:true}:JSON.stringify({__fluentConfigRevision:3,fixture:true})};}state.config.push(message);return {success:!input.fail?.includes('persist'),error:'persist-failure'};}}},
 setTimeout,clearTimeout,queueMicrotask};
(async()=>{const start=performance.now();const context=vm.createContext(sandbox);try {await vm.runInContext(source,context,{filename:input.source,timeout:2000});}catch(error){state.rejection=String(error.stack||error);}
 try {state.finalReport=JSON.parse(vm.runInContext('JSON.stringify(report)',context));}catch{}
 delete state.session;
 state.protectedUnchanged=fs.readFileSync(path.join(unrelated,'sentinel'),'utf8')==='unrelated owner';
 state.sourceSha256=require('node:crypto').createHash('sha256').update(source).digest('hex');
 state.durationMs=performance.now()-start;state.exitCode=processPort.exitCode;state.profileExists=state.profile?fs.existsSync(state.profile):false;state.listening=server?.listening||false;
 console.log(JSON.stringify(state));
 // The harness owns this safety net, which is deliberately excluded from observed cleanup.
 if(server?.listening) server.listening=false;
 if(state.profile) fs.rmSync(state.profile,{recursive:true,force:true});
})().catch(error=>{console.error(error);process.exitCode=2;});
`;
async function capture(options: Record<string, unknown> = {}) {
    const root = fixture();
    const result = await child(['-e', captureRunner, JSON.stringify({source: path.join(sourceRoot, String(options.script || 'scripts/capture-docs-ui.cjs')), guardSource: path.join(sourceRoot, 'scripts/testing/owned-browser-close.cjs'), fixture: root, ...options})], root, 'capture-docs-ui.cjs');
    recordProbe({family:'capture',sourceRoot,options,result});
    expect(result.timedOut, result.err).toBe(false);
    expect(result.code, result.err).toBe(0);
    const state = JSON.parse(result.out.trim()) as {loaded: boolean; calls: string[]; errors: string[]; rejection?: string; profileExists: boolean; listening: boolean; exitCode: number; reports: Array<{screenshots: Array<{locale: string; name: string; points: unknown[]; losslessPixels: boolean}>}>; config: Array<{config: Record<string, unknown>; baseRevision: number}>; removed: string[]; profile: string; writes: string[]; cdps: number; detached: number; article: {text: string; type: string}; durationMs: number; runtimePath: string; guardBound?: boolean; guardProbes: string[]; finalReport?: {error?: string; failure?: string; cleanupErrors?: Array<{resource:string;error:string}>; retainedProfile?: string; retainedProfileLaunchAttempted?: boolean}; attemptedReport?: {error?: string; failure?: string}; actorGone: boolean; rawCloseFulfilled?: boolean; protectedUnchanged: boolean; required:string[]; launch?: {profileDir:string;background:boolean;headless:boolean}};
    expect(state.loaded).toBe(true);
    return state;
}

describe('documentation delivery CLI contracts', () => {
    it('checks VitePress pages while leaving Storybook HTML shells to their own verifier', async () => {
        const root = docsFixture();
        write(root, 'docs/.vitepress/dist/storybook/index.html', '<!doctype html><div id="storybook-root"></div>');
        write(root, 'docs/.vitepress/dist/storybook/iframe.html', '<!doctype html><div id="storybook-root"></div>');
        const result = await checker(root, 'verify-docs-build.mjs');
        expect(result.code, result.err).toBe(0);
        expect(JSON.parse(result.out).pages).toBe(9);
    });
    it('validates the Storybook index and relative assets in the combined shipped artifact', async () => {
        const result = await checker(storybookFixture(), 'verify-storybook-build.mjs');
        expect(result.code, result.err).toBe(0);
        expect(JSON.parse(result.out)).toEqual({groups:12,stories:12,docs:12,assets:2});
    });
    it('rejects a directory masquerading as a Storybook entry asset', async () => {
        const root = storybookFixture(), target = path.join(root, 'docs/.vitepress/dist/storybook/assets/app.js');
        fs.rmSync(target); fs.mkdirSync(target);
        const result = await checker(root, 'verify-storybook-build.mjs');
        expect(result.code).toBe(1); expect(result.err).toContain('Missing entry asset');
    });
    it.each(['assets/app.js', 'index.json', 'iframe.html'])('rejects an artifact-external Storybook symlink at %s', async file => {
        const root = storybookFixture(), target = path.join(root, 'docs/.vitepress/dist/storybook', file);
        const outside = path.join(root, 'outside-file');
        fs.writeFileSync(outside, fs.readFileSync(target));
        fs.rmSync(target); fs.symlinkSync(outside, target);
        const result = await checker(root, 'verify-storybook-build.mjs');
        expect(result.code).toBe(1); expect(result.err).toContain('shipped Storybook artifact');
    });
    it('retains an artifact-internal symlink to a regular Storybook entry asset', async () => {
        const root = storybookFixture(), dist = path.join(root, 'docs/.vitepress/dist/storybook');
        write(root, 'docs/.vitepress/dist/storybook/assets/shared.js', 'console.log("shared fixture");');
        fs.rmSync(path.join(dist, 'assets/app.js'));
        fs.symlinkSync('shared.js', path.join(dist, 'assets/app.js'));
        const result = await checker(root, 'verify-storybook-build.mjs');
        expect(result.code, result.err).toBe(0); expect(JSON.parse(result.out).assets).toBe(2);
    });
    it('rejects a Storybook subtree linked outside the shipped documentation artifact', async () => {
        const root = storybookFixture(), dist = path.join(root, 'docs/.vitepress/dist/storybook');
        const outside = path.join(root, 'outside-storybook');
        fs.renameSync(dist, outside); fs.symlinkSync(outside, dist, 'dir');
        const result = await checker(root, 'verify-storybook-build.mjs');
        expect(result.code).toBe(1); expect(result.err).toContain('Storybook must belong to the shipped documentation artifact');
    });
    it('accepts canonical localized README openings without duplicated product copy', async () => {
        const result = await checker(brandFixture(), 'verify-brand-copy.mjs');
        expect(result.code, result.err).toBe(0);
    });
    it.each([['README.md', 'en-US'], ['misc/README_ZH.md', 'zh-CN']])('rejects a missing localized opening in %s even when it appears later', async (file, language) => {
        const root = brandFixture(true);
        const counterpart = language === 'en-US' ? './misc/README_ZH.md' : '../README.md';
        write(root, file, `<div>${taglines[language === 'en-US' ? 'zh-CN' : 'en-US']}\n[Language](${counterpart})</div>${taglines[language]}`);
        const result = await checker(root, 'verify-brand-copy.mjs');
        expect(result.code).toBe(1); expect(result.err).toContain(file);
    });
    it.each(Object.keys(taglines))('preserves the %s interface and copyable guide contracts', async language => {
        const root = brandFixture(true);
        write(root, `src/core/i18n/messages/${language}.ts`, 'missing resource');
        const result = await checker(root, 'verify-brand-copy.mjs');
        expect(result.code).toBe(1); expect(result.err).toContain(`${language}: interface resource`);
    });
    it.each(['package.json', 'marketing/chrome-web-store/en/short-description.txt', 'marketing/chrome-web-store/zh-CN/listing.json', 'marketing/chrome-web-store/en/description.txt', 'marketing/copy/zh-CN.md', 'marketing/brand.md'])('rejects broken combined/store/community contract at %s', async file => {
        const root = brandFixture(true);
        write(root, file, file.endsWith('.json') ? JSON.stringify({description:'bad',shortDescription:'bad'}) : 'bad');
        const result = await checker(root, 'verify-brand-copy.mjs');
        expect(result.code).toBe(1); expect(result.err).toContain('AssertionError');
    });
    it('rejects fewer than seven languages and empty translated taglines', async () => {
        for (const value of [{...taglines, 'ja-JP':''}, Object.fromEntries(Object.entries(taglines).slice(1))]) {
            const root = brandFixture(true);
            write(root, 'src/core/i18n/messages/brand-taglines.json', JSON.stringify(value));
            const result = await checker(root, 'verify-brand-copy.mjs');
            expect(result.code).toBe(1); expect(result.err).toContain('AssertionError');
        }
    });
    it('validates the complete static artifact and encoded Unicode anchors', async () => {
        const root = docsFixture('<h2 id="你好">Anchor</h2><a href="#%E4%BD%A0%E5%A5%BD">Jump</a><img src="/space%20image.png">');
        write(root, 'docs/.vitepress/dist/space image.png', 'image');
        const result = await checker(root, 'verify-docs-build.mjs');
        expect(result.code, result.err).toBe(0);
        expect(JSON.parse(result.out)).toEqual({ok:true,pages:9,links:54,anchors:2,images:4});
    });
    it.each(['/%E0%A4%A', '#%E0%A4%A', '/safe%00.bin'])('rejects malformed encoded target %s with contextual diagnostics', async href => {
        const result = await checker(docsFixture(`<a href="${href}">Invalid</a>`), 'verify-docs-build.mjs');
        expect(result.code).toBe(1); expect(result.err).toContain(href); expect(result.err).toContain('index.html');
    });
    it('rejects encoded path traversal to an existing file outside the shipped artifact', async () => {
        const root = docsFixture('<img src="/%2e%2e%2fowned-outside.bin">');
        write(root, 'docs/.vitepress/owned-outside.bin', 'outside');
        const result = await checker(root, 'verify-docs-build.mjs');
        expect(result.code).toBe(1); expect(result.err).toContain('owned-outside.bin');
    });
    it('rejects a symlink to an existing file outside the shipped artifact', async () => {
        const root = docsFixture('<img src="/outside-link.bin">');
        write(root, 'outside.bin', 'outside');
        fs.symlinkSync(path.join(root, 'outside.bin'), path.join(root, 'docs/.vitepress/dist/outside-link.bin'));
        const result = await checker(root, 'verify-docs-build.mjs');
        expect(result.code).toBe(1); expect(result.err).toContain('outside-link.bin');
    });
    it('rejects a directory masquerading as the extensionless HTML fallback', async () => {
        const root = docsFixture('<a href="/directory">Directory</a>');
        fs.mkdirSync(path.join(root, 'docs/.vitepress/dist/directory.html'));
        const result = await checker(root, 'verify-docs-build.mjs');
        expect(result.code).toBe(1); expect(result.err).toContain('/directory');
    });
    it('rejects a missing relative link in the static artifact', async () => {
        const result = await checker(docsFixture('<a href="missing-relative">Broken</a>'), 'verify-docs-build.mjs');
        expect(result.code).toBe(1); expect(result.err).toContain('Missing link missing-relative');
    });
    it('accepts valid relative links and external protocol-relative images', async () => {
        const result = await checker(docsFixture('<a href="docs/">Relative</a><a href="mailto:fixture@example.test">Mail</a><img src="//cdn.example.test/external.png">'), 'verify-docs-build.mjs');
        expect(result.code, result.err).toBe(0);
        expect(JSON.parse(result.out)).toEqual({ok:true,pages:9,links:54,anchors:0,images:2});
    });
    it('rejects a translated URL on another origin even when its pathname exists locally', async () => {
        const root = docsFixture(), file = path.join(root,'docs/.vitepress/dist/index.html');
        fs.writeFileSync(file, fs.readFileSync(file,'utf8').replace('hreflang="en" href="/en/"', 'hreflang="en" href="https://outside.example.test/en/"'));
        const result = await checker(root, 'verify-docs-build.mjs');
        expect(result.code).toBe(1); expect(result.err).toContain('Missing translated URL');
    });
    it('rejects HTML read through an artifact-external symlink', async () => {
        const root = docsFixture(); write(root, 'outside.html', page('linked.html', '<h1>Outside</h1>'));
        write(root,'docs/.vitepress/dist/en/linked.html',page('en/linked.html','<h1>Translation</h1>'));
        fs.symlinkSync(path.join(root,'outside.html'),path.join(root,'docs/.vitepress/dist/linked.html'));
        const result = await checker(root, 'verify-docs-build.mjs');
        expect(result.code).toBe(1); expect(result.err).toContain('HTML must belong to the shipped artifact');
    });
    it('retains an artifact-internal symlink to a regular asset', async () => {
        const root = docsFixture('<img src="/linked.webp">');
        fs.symlinkSync('brand-icon.webp',path.join(root,'docs/.vitepress/dist/linked.webp'));
        const result = await checker(root, 'verify-docs-build.mjs');
        expect(result.code, result.err).toBe(0); expect(JSON.parse(result.out).images).toBe(4);
    });
    it.each([['<a href="/missing">Broken</a>', 'Missing link'], ['<a href="#missing">Broken</a>', 'Missing anchor'], ['<div class="vp-doc"><img src="/brand-icon.webp"></div>', 'Image needs dimensions']])('keeps existing artifact rejection: %s', async (extra, message) => {
        const result = await checker(docsFixture(extra), 'verify-docs-build.mjs');
        expect(result.code).toBe(1); expect(result.err).toContain(message);
    });
    it('preserves source translation and public-only artifact checks', async () => {
        const missing = docsFixture(); fs.rmSync(path.join(missing, 'docs/en/config/translation-engines.md'));
        const result = await checker(missing, 'verify-docs-build.mjs');
        expect(result.code).toBe(1); expect(result.err).toContain('Missing English equivalent');
        const internal = docsFixture(); write(internal, 'docs/.vitepress/dist/reports/private.txt', 'internal');
        const internalResult = await checker(internal, 'verify-docs-build.mjs');
        expect(internalResult.code).toBe(1); expect(internalResult.err).toContain('Internal reports');
    });
    it.each([[], ['--helper','fixture-helper'], ['--runtime'], ['--runtime','--helper','fixture-helper'], ['--runtime','fixture'], ['--runtime','fixture','--helper']].map(args=>({args})))('validates CLI before loading dependencies or acquiring resources: $args', async ({args}) => {
        const state = await capture({args});
        expect(state.calls).toEqual([]); expect(state.profileExists).toBe(false);
        expect(state.errors.join('\n') + (state.rejection || '')).toMatch(/--runtime|--helper/);
    });
    it('runs both locales through actual capture callbacks using a fresh controlled profile and HTTP port', async () => {
        const state = await capture();
        expect(state.errors).toEqual([]); expect(state.rejection).toBeUndefined(); expect(state.exitCode).toBe(0);
        expect(state.reports).toHaveLength(1); expect(state.reports[0].screenshots).toHaveLength(28);
        expect(state.reports[0].screenshots.every(item=>item.losslessPixels)).toBe(true);
        expect(state.config.map(item=>item.config.uiLanguage)).toEqual(['zh-CN','en-US']);
        expect(state.config.every(item=>item.baseRevision===3 && item.config.fixture===true && item.config.service==='freeTranslation')).toBe(true);
        expect(state.article.text).toContain('Reading example'); expect(state.article.type).toBe('text/html; charset=utf-8');
        expect(state.cdps).toBe(28); expect(state.detached).toBe(28);
        expect(state.guardBound).toBe(true); expect(state.guardProbes).toContain('present'); expect(state.guardProbes.at(-1)).toBe('absent');
        expect(state.calls.indexOf('guard.bind')).toBeLessThan(state.calls.indexOf('browser.close'));
        expect(state.calls.indexOf('browser.close')).toBeLessThan(state.calls.indexOf('profile.remove'));
        expect(state.removed).toEqual([state.profile]); expect(state.profileExists).toBe(false); expect(state.listening).toBe(false);
    });
    it('retains serviceworker waiting and object-valued config compatibility', async () => {
        const state = await capture({waitWorker:true,objectConfig:true});
        expect(state.errors).toEqual([]); expect(state.reports[0].screenshots).toHaveLength(28);
    });
    it.each(['goto','wait','read','persist','write','rect','target','target.right','cdp','pageerror'])('cleans owned resources after %s failure', async failure => {
        const state = await capture({fail:[failure]});
        expect(state.exitCode).toBe(1); expect(state.errors.length).toBeGreaterThan(0);
        expect(state.profileExists).toBe(false); expect(state.listening).toBe(false);
        expect(state.removed).toEqual([state.profile]);
    });
    it('detaches an acquired CDP session when screenshot writing fails and preserves both errors', async () => {
        const state = await capture({fail:['write','detach','browser.close']});
        expect(state.detached).toBe(1); expect(state.exitCode).toBe(1);
        for (const name of ['write','detach','browser.close']) expect(state.errors.join('\n')).toContain(name+'-failure');
        expect(state.rejection).toBeUndefined(); expect(state.profileExists).toBe(true); expect(state.listening).toBe(false);
        expect(state.removed).toEqual([]); expect(state.finalReport?.error).toContain('write-failure');
        expect(state.finalReport?.cleanupErrors).toContainEqual(expect.objectContaining({resource:'browser',error:expect.stringContaining('browser.close-failure')}));
    });
    it('fails the capture when session detach alone fails', async () => {
        const state = await capture({fail:['detach']});
        expect(state.exitCode).toBe(1); expect(state.errors.join('\n')).toContain('detach-failure');
        expect(state.profileExists).toBe(false); expect(state.listening).toBe(false);
    });
    it('continues server cleanup and retains the profile when guarded browser close rejects', async () => {
        const state = await capture({fail:['goto','browser.close']});
        expect(state.errors.join('\n')).toContain('goto-failure'); expect(state.errors.join('\n')).toContain('browser.close-failure');
        expect(state.rejection).toBeUndefined(); expect(state.profileExists).toBe(true); expect(state.listening).toBe(false);
        expect(state.removed).toEqual([]);
        expect(state.calls.slice(-4)).toEqual(['browser.close','server.connections','server.close','report.write']);
        expect(state.finalReport?.error).toContain('goto-failure');
        expect(state.finalReport?.cleanupErrors).toEqual([expect.objectContaining({resource:'browser',error:expect.stringContaining('browser.close-failure')})]);
        expect(state.finalReport?.retainedProfile).toBe(state.profile);
        expect(state.finalReport?.retainedProfileLaunchAttempted).toBe(true);
    });
    it.each([['browser.close'], ['connections'], ['server.close'], ['remove'], ['connections','server.close','remove']].map(fail=>({fail})))('exposes cleanup failures without abandoning later cleanup: $fail', async ({fail}) => {
        const state = await capture({fail});
        expect(state.exitCode).toBe(1); expect(state.rejection).toBeUndefined();
        for (const name of fail) expect(state.errors.join('\n')).toContain(name+'-failure');
        expect(state.profileExists).toBe(fail.includes('browser.close')); expect(state.listening).toBe(false);
        expect(state.removed).toEqual(fail.includes('browser.close') ? [] : [state.profile]);
        expect(state.calls).toContain('server.connections'); expect(state.calls).toContain('server.close'); expect(state.calls.at(-1)).toBe('report.write');
        expect(state.finalReport?.cleanupErrors?.length).toBe(fail.length);
    });
    it.each(['server.create','listen'])('cleans a partially acquired profile after %s fails', async failure => {
        const state = await capture({fail:[failure]});
        expect(state.errors.join('\n')).toContain(failure+'-failure'); expect(state.exitCode).toBe(1);
        expect(state.profileExists).toBe(false); expect(state.listening).toBe(false);
    });
    it('capture launch rejection retains the attempted profile without a close receipt', async () => {
        const state = await capture({fail:['launch']});
        expect(state.exitCode).toBe(1); expect(state.profileExists).toBe(true); expect(state.removed).toEqual([]);
        expect(state.calls).not.toContain('guard.bind'); expect(state.calls).not.toContain('browser.close');
        expect(state.listening).toBe(false); expect(state.calls).toContain('server.connections'); expect(state.calls).toContain('server.close');
        expect(state.finalReport?.error).toContain('launch-failure');
        expect(state.finalReport?.retainedProfile).toBe(state.profile); expect(state.finalReport?.retainedProfileLaunchAttempted).toBe(true);
    });
    it.each(['scripts/capture-docs-ui.cjs','scripts/testing/run-hover-visual-range-test.cjs','scripts/testing/run-sentence-highlight-responsiveness.cjs'])('capture launch without a returned session retains profile in %s', async script => {
        const state=await capture({script,fixtureCLI:script!=='scripts/capture-docs-ui.cjs',noSession:true});
        expect(state.exitCode).toBe(1);expect(state.rejection).toBeUndefined();expect(state.profileExists).toBe(true);expect(state.removed).toEqual([]);
        expect(state.guardBound).not.toBe(true);expect(state.calls).not.toContain('browser.close');
        expect(state.calls).toContain('server.connections');expect(state.calls).toContain('server.close');expect(state.listening).toBe(false);
        if(script!=='scripts/capture-docs-ui.cjs')expect(state.calls).toContain('provider.close');
        expect(state.finalReport?.error||state.finalReport?.failure).toContain('undefined');expect(state.finalReport?.retainedProfileLaunchAttempted).toBe(true);
    });
    it('capture guard rejects raw close fulfillment without a verified PID receipt', async () => {
        const state = await capture({fail:['guard.receipt']});
        expect(state.exitCode).toBe(1); expect(state.guardBound).toBe(true); expect(state.actorGone).toBe(true);
        expect(state.calls).toContain('browser.close'); expect(state.profileExists).toBe(true); expect(state.removed).toEqual([]);
        expect(state.listening).toBe(false); expect(state.calls).toContain('server.connections'); expect(state.calls).toContain('server.close');
        expect(state.finalReport?.cleanupErrors).toContainEqual(expect.objectContaining({resource:'browser',error:expect.stringContaining('guard.receipt-failure')}));
    });
    it.each(['guard.bind','helper.legacy'])('capture guard boundary preserves the attempted profile at %s', async failure => {
        const state = await capture({fail:[failure]});
        expect(state.exitCode).toBe(1); expect(state.profileExists).toBe(true); expect(state.removed).toEqual([]);
        expect(state.calls).not.toContain('browser.close'); expect(state.listening).toBe(false);
        expect(state.calls).toContain('server.connections'); expect(state.calls).toContain('server.close');
        expect(state.finalReport?.retainedProfileLaunchAttempted).toBe(true);
        expect(state.errors.join('\n')).toContain(failure==='guard.bind' ? 'guard.bind-failure' : 'transport-only close');
    });
    it.each([['goto','report'],['goto','browser.close','connections','server.close','report']].map(fail=>({fail})))('capture report IO cannot prevent releases or erase the primary failure: $fail', async ({fail}) => {
        const state = await capture({fail});
        expect(state.exitCode).toBe(1); expect(state.rejection).toBeUndefined(); expect(state.finalReport?.error).toContain('goto-failure');
        expect(state.calls).toContain('server.connections'); expect(state.calls).toContain('server.close'); expect(state.listening).toBe(false);
        expect(state.profileExists).toBe(fail.includes('browser.close'));
        expect(state.removed).toEqual(fail.includes('browser.close') ? [] : [state.profile]);
        expect(state.calls.at(-1)).toBe('report.write'); expect(state.attemptedReport?.error).toContain('goto-failure');
        expect(state.finalReport?.cleanupErrors?.length).toBe(fail.length-1);
        for(const name of fail.slice(1)) expect(state.finalReport?.cleanupErrors?.some(error=>error.error.includes(name+'-failure'))).toBe(true);
    });
    // These CLIs acquire a provider before launch and intentionally fail at
    // the worker port. Reuse the complete-entry capture VM and real guard;
    // this probes finalizers, not hover/highlight product success or native IO.
    describe.each(['scripts/testing/run-hover-visual-range-test.cjs', 'scripts/testing/run-sentence-highlight-responsiveness.cjs'])('public CLI resource boundaries: %s', script => {
        async function run(fail: string[] = [], extraArgs?: string[]) {
            return capture({script,fixtureCLI:true,fail,...(extraArgs ? {args:extraArgs} : {})});
        }
        function released(state: Awaited<ReturnType<typeof capture>>, fail: string[] = []) {
            expect(state.calls.filter(call=>call==='server.connections')).toHaveLength(1);
            expect(state.calls.filter(call=>call==='server.close')).toHaveLength(1);
            expect(state.calls.filter(call=>call==='provider.close')).toHaveLength(fail.includes('provider.start')?0:1);
            expect(state.listening).toBe(false); expect(state.protectedUnchanged).toBe(true);
            expect(state.exitCode).toBe(1); expect(state.rejection).toBeUndefined();
            const primary=fail.includes('launch')?'launch':fail.includes('provider.start')?'provider.start':fail.includes('guard.bind')?'guard.bind':'body';
            expect(state.finalReport?.error||state.finalReport?.failure).toContain(primary+'-failure');
            expect(state.errors.join('\n')).toContain(primary+'-failure');
            if(!fail.includes('provider.start'))expect(state.launch).toMatchObject({profileDir:state.profile,background:true,headless:false});
        }
        it('retains the launch-attempt profile without any session/close receipt', async () => {
            const state=await run(['launch']);
            expect(state.profileExists).toBe(true); expect(state.removed).toEqual([]); released(state,['launch']);
            expect(state.calls).not.toContain('guard.bind'); expect(state.calls).not.toContain('browser.close');
            expect(state.finalReport?.retainedProfile).toBe(state.profile); expect(state.finalReport?.retainedProfileLaunchAttempted).toBe(true);
        });
        it('retains the profile and primary error when guarded close rejects', async () => {
            const state=await run(['browser.close']); released(state); expect(state.profileExists).toBe(true); expect(state.removed).toEqual([]);
            expect(state.finalReport?.cleanupErrors).toEqual([expect.objectContaining({resource:'browser',error:expect.stringContaining('browser.close-failure')})]);
        });
        it('deletes only the owned profile after a fulfilled guarded PID receipt', async () => {
            const state=await run(); released(state); expect(state.profileExists).toBe(false); expect(state.removed).toEqual([state.profile]);
            expect(state.guardBound).toBe(true); expect(state.guardProbes.at(-1)).toBe('absent'); expect(state.rawCloseFulfilled).toBe(true);
            expect(state.calls.indexOf('guard.bind')).toBeLessThan(state.calls.indexOf('browser.close'));
            expect(state.calls.indexOf('browser.close')).toBeLessThan(state.calls.indexOf('profile.remove')); expect(state.calls.at(-1)).toBe('report.write');
            expect(state.finalReport?.cleanupErrors||[]).toEqual([]);
        });
        it.each(['guard.receipt','guard.bind'])('retains the attempted profile at the %s boundary', async failure => {
            const state=await run([failure]); expect(state.profileExists).toBe(true); expect(state.removed).toEqual([]); released(state,[failure]);
            if(failure==='guard.receipt') {expect(state.rawCloseFulfilled).toBe(true);expect(state.finalReport?.cleanupErrors).toEqual([expect.objectContaining({resource:'browser',error:expect.stringContaining('guard.receipt-failure')})]);}
            else expect(state.calls).not.toContain('browser.close');
        });
        it('cleans an unused profile when provider acquisition rejects before launch', async () => {
            const state=await run(['provider.start']); released(state,['provider.start']); expect(state.profileExists).toBe(false);
            expect(state.calls).not.toContain('browser.launch'); expect(state.calls).not.toContain('guard.bind'); expect(state.removed).toEqual([state.profile]);
        });
        it.each([['report','report'],['provider.close','provider'],['provider.callback','provider'],['connections','server connections'],['server.close','server']])('independently releases other resources when %s fails', async (failure, resource) => {
            const state=await run([failure]); released(state); expect(state.profileExists).toBe(false); expect(state.removed).toEqual([state.profile]); expect(state.calls.at(-1)).toBe('report.write');
            expect(state.finalReport?.cleanupErrors).toEqual([expect.objectContaining({resource,error:expect.stringContaining(failure+'-failure')})]);
            expect(state.attemptedReport?.error||state.attemptedReport?.failure).toContain('body-failure');
        });
        it('keeps the primary failure and every simultaneous cleanup error', async () => {
            const state=await run(['browser.close','provider.close','connections','server.close','report']); released(state);
            expect(state.profileExists).toBe(true); expect(state.removed).toEqual([]);
            expect(state.finalReport?.cleanupErrors?.map(error=>error.resource)).toEqual(['browser','provider','server connections','server','report']);
        });
    });
    it('deprecated --verify-actions fails the complete sentence CLI before dependency or resource acquisition', async () => {
        const state=await capture({script:'scripts/testing/run-sentence-highlight-responsiveness.cjs',fixtureCLI:true,args:['--verify-actions']});
        expect(state.rejection).toContain('--verify-actions 已移除'); expect(state.rejection).toContain('scripts/run-selection-trigger-test.cjs');
        expect(state.required).toEqual([]); expect(state.calls).toEqual([]); expect(state.profileExists).toBe(false); expect(state.writes).toEqual([]);
    });
    it('deprecated flag exits a real Node CLI process before missing runtime/browser dependencies', async () => {
        const root=fixture(), script='scripts/testing/run-sentence-highlight-responsiveness.cjs';
        const result=await child([path.join(sourceRoot,script),'--verify-actions'],root,'deprecated-sentence-cli',2000);
        recordProbe({family:'deprecated-real-node-cli-no-browser',sourceRoot,result});
        expect(result.timedOut).toBe(false); expect(result.signal).toBeNull(); expect(result.code).toBe(1); expect(result.out).toBe('');
        expect(result.err).toContain('--verify-actions 已移除'); expect(result.err).toContain('scripts/run-selection-unified-test.cjs');
    });
    it('keeps bounded repeated-link output and operation evidence for actual script execution', async () => {
        const extra = '<a href="/docs/">Repeated</a>'.repeat(120);
        const root = docsFixture(extra);
        const result = await checker(root, 'verify-docs-build.mjs');
        expect(result.code, result.err).toBe(0);
        const report = JSON.parse(result.out);
        expect(report).toEqual({ok:true,pages:9,links:292,anchors:0,images:2});
        if (process.env.DOCUMENTATION_TOOL_PROOF) fs.writeFileSync(process.env.DOCUMENTATION_TOOL_PROOF, JSON.stringify({sourceRoot,input:{repeatedLinksPerHome:120,pages:9},output:report,sha256:createHash('sha256').update(result.out).digest('hex'),operations:JSON.parse(fs.readFileSync(path.join(root,'operations.json'),'utf8'))}, null, 2));
    });
});
