#!/usr/bin/env node
/**
 * @file scripts/testing/run-zotero-native-smoke.mjs
 * 文件职责：在完全独立的 Zotero profile 与资料库中验证构建后的原生 XPI。
 * 主要内容：后台启动真实 Zotero、导入合成 PDF、验证工作台与幂等回存，可用本机受控模型贯通 PDF 翻译。
 * 模块边界：不读取或修改日常 Zotero 配置，不登录账号，不使用真实翻译密钥；证据写入显式指定的新目录。
 */
import {mkdir, writeFile, readFile, cp, access} from 'node:fs/promises';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {createConnection} from 'node:net';
import JSZip from 'jszip';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import focusSafe from './focus-safe-browser.cjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const evidence = process.argv[2];
if (!evidence || !resolve(evidence).includes('/workspace-data/evidence/')) throw new Error('请显式指定 workspace-data/evidence/ 下的新证据目录');
const directory = resolve(evidence);
const platformOnly = process.argv.includes('--platform-only');
const application = process.env.FLUENTREAD_ZOTERO_APP || '/Applications/Zotero.app';
const exec = promisify(execFile);
const {queryMacFrontmostApplication, startFocusEventMonitor} = focusSafe;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const profile = join(directory, 'profile'); const data = join(directory, 'data');
const report = join(directory, 'native-result.json');
await mkdir(directory, {recursive: false, mode: 0o700});
await mkdir(join(profile, 'extensions'), {recursive: true, mode: 0o700});
await mkdir(join(profile, 'fluentread'), {recursive: true, mode: 0o700});
await mkdir(data, {mode: 0o700});
const {stdout: screenJSON} = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit');
const screens = $.NSScreen.screens;
const rect = frame => ({x:Number(frame.origin.x),y:Number(frame.origin.y),width:Number(frame.size.width),height:Number(frame.size.height)});
const layout = [];
for (let index=0;index<Number(screens.count);index++) {const screen=screens.objectAtIndex(index);layout.push({index,frame:rect(screen.frame),visible:rect(screen.visibleFrame)});}
JSON.stringify(layout);`], {timeout: 5000});
const screens = JSON.parse(screenJSON.trim());
if (!screens.length) throw new Error('Cannot read a visible macOS display; no native instance will be launched');
const secondary = screens.find(screen => screen.index !== 0);
if (!secondary) throw new Error('A second display is required; no native instance will be launched');
const display = {left:secondary.visible.x,top:screens[0].frame.y + screens[0].frame.height - secondary.visible.y - secondary.visible.height,
    width:secondary.visible.width,height:secondary.visible.height,screenIndex:secondary.index};
if (display.width < 1120 || display.height < 800) throw new Error('The selected display cannot contain a normal 1120×800 test window');
await writeFile(join(directory, 'screen-layout.json'), JSON.stringify({screens,display}, null, 2));
const requests = [];
const debuggerPort = 52000 + Math.floor(Math.random() * 10000);
const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const value = JSON.parse(body || '{}');
    requests.push({method: request.method, url: request.url, model: value.model});
    const input = value.messages?.at(-1)?.content || '';
    const slots = [...input.matchAll(/(___FLUENTREAD_([a-zA-Z0-9_-]+)_(\d+)_BEGIN___)[\s\S]*?___FLUENTREAD_\2_\3_END___/g)];
    const content = slots.length ? slots.map(slot => `${slot[1]}研究译文：Translated research paragraph ${slot[3]}.\n___FLUENTREAD_${slot[2]}_${slot[3]}_END___`).join('\n')
        : '研究译文：Translated research paragraph for native validation.';
    response.writeHead(200, {'content-type': 'application/json', 'access-control-allow-origin': '*'});
    response.end(JSON.stringify({id: 'controlled-native', object: 'chat.completion', created: 1, model: value.model,
        choices: [{index: 0, message: {role: 'assistant', content}, finish_reason: 'stop'}]}));
});
if (!platformOnly) await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
const endpoint = `http://127.0.0.1:${platformOnly ? 1 : server.address().port}/v1/chat/completions`;
await writeFile(join(profile, 'fluentread/settings.json'), JSON.stringify({sourceLanguage: 'en', targetLanguage: 'zh-Hans', service: 'compatible',
    endpoint, model: 'controlled-native', glossary: '', output: 'bilingual', autoOpen: false}));
await writeFile(join(profile, 'fluentread/credentials.json'), JSON.stringify({apiKey: '', service: 'compatible', endpoint}));
const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
for (let index = 0; index < 2; index++) {
    const page = pdf.addPage([600, 800]);
    page.drawText(`Native research study ${index + 1}`, {x: 45, y: 730, size: 18, font});
    page.drawText('This paragraph describes the research method and its reproducible result.', {x: 45, y: 675, size: 11, font});
}
const fixture = join(directory, 'source.pdf'); await writeFile(fixture, await pdf.save());
const prefs = {
    'extensions.autoDisableScopes': 0, 'extensions.enabledScopes': 15, 'extensions.startupScanScopes': 15,
    'xpinstall.signatures.required': false, 'devtools.debugger.remote-enabled': true,
    'devtools.debugger.prompt-connection': false, 'devtools.debugger.force-local': true, 'devtools.debugger.remote-port': debuggerPort, 'extensions.zotero.useDataDir': true, 'extensions.zotero.dataDir': data,
    'extensions.zotero.firstRun2': false, 'extensions.zotero.sync.autoSync': false,
    'extensions.zotero.httpServer.enabled': false, 'app.update.auto': false, 'app.update.enabled': false,
    'extensions.update.enabled': false, 'extensions.logging.enabled': true, 'browser.shell.checkDefaultBrowser': false,
};
await writeFile(join(profile, 'user.js'), Object.entries(prefs).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n'));
await cp(join(root, 'integrations/zotero/dist/fluentread-zotero.xpi'), join(directory, 'tested-fluentread-zotero.xpi'));


async function probe(config) {
    const results = {application: Zotero.version, platformOnly: config.platformOnly, steps: [], errors: [], warnings: [], logs: [],
        diagnosticsCoverage:'nsIConsoleService and console-api-log-event observers installed by the probe before the native add-on; retained through workspace mount, disable, re-enable and disposal',
        windowPlacement:{mode:'background-visible-no-focus',display:config.display,windows:[]}};
    let phase = 'native installation';
    const assert = (condition, message) => {if (!condition) throw new Error(message); results.steps.push(message);};
    const waitFor = async (predicate, name, timeout = 60000) => {
        const end = Date.now() + timeout;
        while (Date.now() < end) {const value = await predicate(); if (value) return value; await Zotero.Promise.delay(100);}
        throw new Error('Timed out: ' + name);
    };
    const observer = {observe(message) {
        const value = message.errorMessage || message.message || '';
        if (!/fluentread|workspace\.js|native\.js/i.test((message.sourceName || '') + value)) return;
        let scriptError;
        try {
            scriptError = message.QueryInterface(Components.interfaces.nsIScriptError);
        } catch { /* Add-on lifecycle DEBUG messages implement nsIConsoleMessage only. */ }
        if (!scriptError?.errorMessage) {results.logs.push(String(value).slice(0, 500)); return;}
        const warning = Boolean(scriptError.flags & Components.interfaces.nsIScriptError.warningFlag);
        (warning ? results.warnings : results.errors).push({message:String(value).slice(0, 500),sourceName:scriptError.sourceName || '',
            lineNumber:scriptError.lineNumber,columnNumber:scriptError.columnNumber,flags:scriptError.flags,category:scriptError.category,
            phase,timeStamp:scriptError.timeStamp});
    }};
    const consoleObserver = {observe(subject) {
        const entry = subject.wrappedJSObject;
        if (!entry || !['warn','error','exception','assert'].includes(entry.level)) return;
        const value = (entry.arguments || []).map(argument => {
            try {return String(argument);} catch {return '[unprintable console argument]';}
        }).join(' ');
        if (!/fluentread|workspace\.js|native\.js/i.test((entry.filename || '') + value)) return;
        (entry.level === 'warn' ? results.warnings : results.errors).push({message:value.slice(0,500),sourceName:entry.filename || '',
            lineNumber:entry.lineNumber,columnNumber:entry.columnNumber,category:'console-api',level:entry.level,phase,timeStamp:entry.timeStamp});
    }};
    Services.console.registerListener(observer);
    Services.obs.addObserver(consoleObserver, 'console-api-log-event');
    const placeWindow = async (window, name, width=1120, height=800) => {
        const area = config.display;
        const left = Math.round(area.left + (area.width-width)/2);
        const top = Math.round(area.top + (area.height-height)/2);
        window.resizeTo(width,height); window.moveTo(left,top);
        await waitFor(() => Math.abs(window.screenX-left)<=2 && Math.abs(window.screenY-top)<=2, name+' visible display placement', 3000);
        const bounds = {left:window.screenX,top:window.screenY,width:window.outerWidth,height:window.outerHeight};
        if (window.windowState !== window.STATE_NORMAL || bounds.left<area.left-2 || bounds.top<area.top-2
            || bounds.left+bounds.width>area.left+area.width+2 || bounds.top+bounds.height>area.top+area.height+2) {
            throw new Error('Native test window is not fully contained in the visible display: '+JSON.stringify({name,bounds,area}));
        }
        results.windowPlacement.windows.push({name,bounds,visible:true,windowState:'normal'});
    };
    try {
        await IOUtils.writeJSON(config.environment, {DOMParser:typeof DOMParser, Response:typeof Response, Request:typeof Request, Headers:typeof Headers, AbortController:typeof AbortController, DOMException:typeof DOMException, fetch:typeof fetch});
        await Zotero.uiReadyPromise;
        assert(Services.dirsvc.get('ProfD', Components.interfaces.nsIFile).path === config.profile && Zotero.DataDirectory.dir === config.data, 'Probe is restricted to the task-owned profile and data directory');
        const win = Zotero.getMainWindow();
        await placeWindow(win, 'main', 1100, 800);
        const menu = await waitFor(() => win.document.getElementById('fluentread-zotero-workspace'), 'installed native menu');
        assert(menu, 'Native add-on loads through Zotero AddonManager');
        const parent = new Zotero.Item('journalArticle'); parent.libraryID = Zotero.Libraries.userLibraryID;
        parent.setField('title', 'FluentRead isolated native validation'); await parent.saveTx();
        const attachment = await Zotero.Attachments.importFromFile({file: config.fixture, parentItemID: parent.id, title: 'Native fixture', contentType: 'application/pdf'});
        await win.ZoteroPane.selectItems([attachment.id]);
        menu.dispatchEvent(new win.Event('command', {bubbles: true}));
        const workspace = await waitFor(() => {
            const windows = Services.wm.getEnumerator(null);
            while (windows.hasMoreElements()) {const candidate = windows.getNext(); if (candidate.location?.href === 'chrome://fluentread/content/workspace.html') return candidate;}
            return null;
        }, 'workspace window');
        await placeWindow(workspace, 'workspace');
        await waitFor(() => workspace.FluentReadWorkspace, 'Vue workspace initialized');
        assert(workspace.document.querySelector('main.app'), 'Vue workspace renders in real Gecko HTML');
        assert(workspace.document.contentType === 'text/html' && workspace.document.querySelector('button') instanceof workspace.HTMLButtonElement, 'Workspace uses native HTML controls and click behavior');
        const host = workspace.arguments[0].host;
        const controller = new workspace.AbortController();
        const source = await host.readAttachment(attachment.id, controller.signal);
        assert(source.fingerprint.length === 64, 'Native sandbox can read and SHA-256 fingerprint the PDF');
        assert((await host.selectedAttachments()).some(item => item.id === attachment.id), 'Selection resolves while the workspace is open');
        const loadedSettings = await host.loadSettings();
        phase = 'PDF translation and writeback';
        let completed;
        if (config.platformOnly) {
            const {apiKey, autoOpen, ...settings} = loadedSettings;
            completed = {id: 'fr-native-platform-12345678', attachmentID: attachment.id, libraryID: attachment.libraryID,
                attachmentKey: attachment.key, fingerprint: source.fingerprint, title: source.title, state: 'completed', phase: 'done',
                createdAt: Date.now(), updatedAt: Date.now(), settings, translations: ['Native translated note'], total: 1, completed: 1};
            completed.outputAttachmentID = await host.saveOutput(source, completed, source.bytes, controller.signal);
            await host.saveTasks([completed]);
        } else {
            const button = [...workspace.document.querySelectorAll('button')].find(button => button.textContent === '翻译所选文献');
            button.click();
            completed = await waitFor(async () => {
                const tasks = await host.loadTasks(); const task = tasks.find(task => ['completed', 'failed'].includes(task.state));
                if (task?.state === 'failed') throw new Error('Native translation failed: ' + task.error);
                return task;
            }, 'PDF parse / controlled translation / export / writeback', 150000);
            assert(completed.translations.some(text => text.includes('Translated research paragraph')), 'Controlled model translates actual parsed PDF segments');
        }
        const output = Zotero.Items.get(completed.outputAttachmentID);
        assert(output && output.parentID === parent.id && output.libraryID === attachment.libraryID, 'Translated PDF is saved under the original literature item');
        const outputBytes = await IOUtils.read(await output.getFilePathAsync());
        assert(new TextDecoder().decode(outputBytes.subarray(0, 5)) === '%PDF-', 'Saved translation is a real PDF');
        await IOUtils.write(config.result, outputBytes); results.outputAttachmentID = output.id; results.outputPDF = config.result;
        assert(await host.saveOutput(source, completed, outputBytes, controller.signal) === output.id, 'Retry reuses the committed PDF instead of duplicating it');
        const noteHTML = `<p>Original paragraph</p><p>Translated research paragraph</p><a href="${source.sourceURI}?page=2">Source page 2</a><img src=x onerror="bad()"><script>bad()</script>`;
        const noteID = await host.saveNote(source, completed, noteHTML, controller.signal);
        const note = Zotero.Items.get(noteID);
        assert(note.parentID === parent.id && note.getNote().includes('?page=2') && !/onerror|<script/.test(note.getNote()), 'Bilingual note preserves safe source-page backlinks');
        const current = await host.readAttachment(attachment.id, controller.signal);
        assert(current.fingerprint === source.fingerprint, 'Original PDF is unchanged');
        assert((await host.selectedAttachments()).filter(item => item.id !== attachment.id).length === 0, 'Generated PDFs do not recursively enter parent translation');
        await IOUtils.writeUTF8(config.dom, workspace.document.documentElement.outerHTML);
        if (config.liveMicrosoft) {
            try {
                [...workspace.document.querySelectorAll('button')].find(button => button.textContent === '翻译设置').click();
                const choose = async (label, optionLabel) => {
                    const control = await waitFor(() => {
                        const title = [...workspace.document.querySelectorAll('label[for]')].find(element => element.textContent === label);
                        return title && workspace.document.getElementById(title.getAttribute('for'));
                    }, label);
                    control.click();
                    const option = await waitFor(() => {
                        const menu = workspace.document.getElementById(control.getAttribute('aria-controls'));
                        return [...(menu?.querySelectorAll('[role="option"]') ?? [])].find(element => element.textContent === optionLabel);
                    }, optionLabel);
                    option.click();
                };
                await choose('翻译服务', '微软翻译 · 无需密钥');
                await choose('译文', '简体中文');
                workspace.FluentReadWorkspace.receive({selection:{attachmentID:attachment.id,text:'A reproducible experiment should describe its methods clearly.',page:1}});
                const translate = await waitFor(() => [...workspace.document.querySelectorAll('button')].find(button => button.textContent === '翻译选中文字'), 'live selection action');
                translate.click();
                const liveResult = await waitFor(() => {
                    const output = workspace.document.querySelector('.selection-result');
                    if (output?.textContent) return output.textContent;
                    const failure = workspace.document.querySelector('[role="alert"]');
                    if (failure?.textContent) throw new Error(failure.textContent);
                    return null;
                }, 'Microsoft public test-sentence translation', 60000);
                results.liveMicrosoft = {passed:/[\u3400-\u9fff]/.test(liveResult),text:liveResult,scope:'One fixed public test sentence; no user document'};
            } catch (error) {results.liveMicrosoft = {passed:false,error:String(error),scope:'External service availability is reported separately from controlled native validation'};}
        }
        await workspace.FluentReadWorkspace.dispose(); workspace.close();
        phase = 'disable and re-enable';
        const {AddonManager} = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
        const addon = await AddonManager.getAddonByID('fluentread@fluentread.app');
        await addon.disable();
        assert(!win.document.getElementById('fluentread-zotero-workspace'), 'Disabling the add-on removes native entries');
        await addon.enable();
        const reopenedMenu = await waitFor(() => win.document.getElementById('fluentread-zotero-workspace'), 're-enabled menu');
        reopenedMenu.dispatchEvent(new win.Event('command', {bubbles: true}));
        const reopened = await waitFor(() => {
            const windows = Services.wm.getEnumerator(null);
            while (windows.hasMoreElements()) {const candidate = windows.getNext(); if (candidate.location?.href === 'chrome://fluentread/content/workspace.html' && !candidate.closed && candidate.FluentReadWorkspace) return candidate;}
            return null;
        }, 're-enabled workspace');
        await placeWindow(reopened, 're-enabled workspace');
        assert((await reopened.arguments[0].host.loadTasks()).some(task => task.id === completed.id && task.outputAttachmentID === output.id), 'Task history survives disable and re-enable');
        await reopened.FluentReadWorkspace.dispose(); reopened.close();
        results.passed = true;
    } catch (error) {results.passed = false; results.failure = String(error); results.stack = error.stack;}
    finally {
        Services.console.unregisterListener(observer);
        Services.obs.removeObserver(consoleObserver, 'console-api-log-event');
        if (results.errors.length || results.warnings.length) {
            results.passed = false;
            results.failure ||= `Native runtime diagnostics: ${results.errors.length} errors, ${results.warnings.length} warnings`;
        }
        await IOUtils.writeJSON(config.report, results, {tmpPath: config.report + '.tmp', flush: true});
        Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);
    }
}
const configuration = {fixture, report, profile, data, display, dom: join(directory, 'native-dom.html'), environment: join(directory, 'sandbox-environment.json'), result:join(directory,'result.pdf'), platformOnly, liveMicrosoft:process.argv.includes('--live-microsoft')};
const runner = new JSZip();
runner.file('manifest.json', JSON.stringify({manifest_version: 2, name: 'FluentRead isolated native validation', version: '1.0',
    applications: {zotero: {id: 'fluentread-native-probe@test.invalid', update_url: 'https://example.invalid/fluentread-native-probe-updates.json', strict_min_version: '7.0', strict_max_version: '10.0.*'}}}));
runner.file('bootstrap.js', `async function startup() {void (${probe.toString()})(${JSON.stringify(configuration)});}\nfunction shutdown() {}\nfunction install() {}\nfunction uninstall() {}\n`);
const probeDir = join(directory, 'probe'); await mkdir(probeDir);
for (const name of ['manifest.json', 'bootstrap.js']) await writeFile(join(probeDir, name), await runner.file(name).async('nodebuffer'));
const probeArchive = join(directory, 'native-probe.xpi');
await writeFile(probeArchive, await runner.generateAsync({type: 'nodebuffer'}));
let result, ownedPID, focusViolation;
const frontmostBefore = await queryMacFrontmostApplication();
if (!frontmostBefore) throw new Error('Cannot read the foreground application; refusing a native background launch');
const focusMonitor = startFocusEventMonitor({onEvent:event => {
    if (event.pid === ownedPID) focusViolation = new Error('The isolated Zotero instance took foreground focus');
}});
try {
    await focusMonitor.ready;
    await exec('/usr/bin/open', ['-g', '-n', '-a', application, '--stdout', join(directory, 'stdout.log'), '--stderr', join(directory, 'stderr.log'), '--args', '-no-remote', '-profile', profile, '-datadir', data, '-ZoteroDebugText', '-debugger'], {timeout: 15000});
    await installThroughDebugger(debuggerPort, [probeArchive, join(directory, 'tested-fluentread-zotero.xpi')], join(directory, 'install-error.json'));
    const end = Date.now() + 210000;
    while (Date.now() < end) {
        if (focusMonitor.error) throw focusMonitor.error;
        if (focusViolation) throw focusViolation;
        try {const failure = JSON.parse(await readFile(join(directory, 'install-error.json'), 'utf8')); throw new Error('Native XPI install failed: ' + JSON.stringify(failure));}
        catch (error) {if (error.code !== 'ENOENT') throw error;}
        try {await access(report); result = JSON.parse(await readFile(report, 'utf8')); break;} catch {await delay(300);}
    }
    if (!result) throw new Error('Zotero native validation timed out; the isolated profile is preserved for diagnosis');
} finally {server.close(); await focusMonitor.stop();
    const frontmostAfter = await queryMacFrontmostApplication();
    await writeFile(join(directory, 'focus-events.json'), JSON.stringify({frontmostBefore,frontmostAfter,ownedPID,events:focusMonitor.events,
        error:String(focusMonitor.error || focusViolation || ''),browserFrontmost:frontmostAfter?.pid===ownedPID}, null, 2));
    await writeFile(join(directory, 'controlled-requests.json'), JSON.stringify(requests, null, 2));
    if (!result) {try {const {stdout} = await exec('/bin/ps', ['-axo', 'pid=,command=']);
        for (const line of stdout.split('\n')) {const match = line.match(/^\s*(\d+)\s+(.+)$/);
            if (match && match[2].startsWith(`${application}/Contents/MacOS/zotero `) && match[2].includes(`-profile ${profile} -datadir ${data} `)) process.kill(Number(match[1]), 'SIGTERM');}} catch { /* 只清理明确匹配本次 profile 的进程；权限不足时保留用于诊断。 */ }}
}
const launch = {launchMode: 'open -g -n, dedicated native Zotero instance', focusPolicy: 'background launch; no activate/bringToFront',
    windowPlacement:result.windowPlacement, profile, data, controlledRequests: requests.length};
await writeFile(join(directory, 'launch.json'), JSON.stringify(launch, null, 2));
console.log(JSON.stringify({...launch, result, evidence: directory}, null, 2));
if (!result.passed) process.exitCode = 1;

async function installThroughDebugger(port, archives, errorPath) {
    let socket;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        try {socket = await new Promise((resolve, reject) => {const connection = createConnection({host: '127.0.0.1', port}); connection.once('connect', () => resolve(connection)); connection.once('error', reject);}); break;}
        catch {await delay(250);}
    }
    if (!socket) throw new Error('Isolated Zotero debugger did not start');
    let buffer = Buffer.alloc(0); const messages = []; const pending = [];
    socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
            const colon = buffer.indexOf(58); if (colon < 0) break;
            const length = Number(buffer.subarray(0, colon).toString()); if (buffer.length < colon + 1 + length) break;
            const message = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length)); buffer = buffer.subarray(colon + 1 + length);
            const waiter = pending.find(waiter => waiter.match(message));
            if (waiter) {pending.splice(pending.indexOf(waiter), 1); waiter.resolve(message);} else messages.push(message);
        }
    });
    const wait = match => new Promise((resolve, reject) => {
        const cached = messages.findIndex(match); if (cached >= 0) {resolve(messages.splice(cached, 1)[0]); return;}
        const timeout = setTimeout(() => reject(new Error('Debugger protocol timed out')), 15000);
        pending.push({match, resolve: value => {clearTimeout(timeout); resolve(value);}});
    });
    const send = async packet => {
        const response = wait(message => message.from === packet.to && !['tabListChanged', 'processListChanged', 'consoleAPICall', 'pageError', 'evaluationResult'].includes(message.type));
        const payload = JSON.stringify(packet); socket.write(`${Buffer.byteLength(payload)}:${payload}`); return response;
    };
    try {
        await wait(message => message.from === 'root' && message.applicationType);
        const process = await send({to: 'root', type: 'getProcess', id: 0});
        await writeFile(join(directory, 'debugger-process.json'), JSON.stringify(process, null, 2));
        let target = process.processDescriptor || process.form || process.actor || process.process;
        if (!target?.consoleActor) {
            const form = await send({to: typeof target === 'string' ? target : target.actor, type: 'getTarget'});
            target = form.process || form.frame || form.target || form;
        }
        await writeFile(join(directory, 'debugger-target.json'), JSON.stringify({process, target}, null, 2));
        if (!target.consoleActor) throw new Error('Debugger process target has no console actor');
        const {stdout: processCommand} = await exec('/bin/ps', ['-p', String(target.processID), '-o', 'command=']);
        if (!processCommand.trim().startsWith(`${application}/Contents/MacOS/zotero `) || !processCommand.includes(`-profile ${profile} -datadir ${data} `)) throw new Error('Debugger target does not belong to this isolated profile');
        ownedPID = target.processID;
        if (focusMonitor.events.some(event => event.pid === ownedPID) || (await queryMacFrontmostApplication())?.pid===ownedPID) {
            throw new Error('The isolated Zotero instance took foreground focus during launch');
        }
        const text = `(async () => {const {Zotero} = ChromeUtils.importESModule('chrome://zotero/content/zotero.mjs'); if (Services.dirsvc.get('ProfD', Components.interfaces.nsIFile).path !== ${JSON.stringify(profile)}) throw new Error('Refusing another profile'); await Zotero.uiReadyPromise; if (Zotero.DataDirectory.dir !== ${JSON.stringify(data)}) throw new Error('Refusing another data directory'); const {AddonManager} = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs'); for (const path of ${JSON.stringify(archives)}) {await AddonManager.installTemporaryAddon(Zotero.File.pathToFile(path));}})().catch(error => IOUtils.writeJSON(${JSON.stringify(errorPath)}, {error:String(error),stack:error.stack,details:error.additionalErrors}));`;
        await send({to: target.consoleActor, type: 'evaluateJSAsync', text});
    } finally {socket.end();}
}
