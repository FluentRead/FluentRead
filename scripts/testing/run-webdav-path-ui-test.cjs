'use strict';
/**
 * @file scripts/testing/run-webdav-path-ui-test.cjs
 * 文件职责：在生产扩展和受限本机 NAS 夹具间验证自定义 WebDAV 备份路径。
 * 主要内容：留空直存、多级中文目录、只读测试、真实保存和恢复、目录隔离、条件删除、后台重启、七语窄屏和运行时诊断。
 * 模块边界：仅使用临时 profile 与虚构凭据；复用不抢焦点启动和外部诊断采集器，不访问真实 NAS 或日常浏览器。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createServer} = require('node:http');
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require('./focus-safe-browser.cjs');
const {guardBrowserClose} = require('./owned-browser-close.cjs');
function arg(name) {const index = process.argv.indexOf(`--${name}`); return index < 0 ? undefined : process.argv[index + 1];}
const extensionDir = path.resolve(arg('extension-dir') || '.output/chrome-mv3');
const artifactsDir = path.resolve(arg('artifacts-dir') || '/private/tmp/fluentread-webdav-path-ui');
const playwrightRoot = arg('playwright-root');
const diagnosticsPath = arg('runtime-diagnostics');
if (!playwrightRoot || !diagnosticsPath) throw new Error('必须指定 --playwright-root 和 --runtime-diagnostics');
const {chromium} = require(path.join(playwrightRoot, 'playwright'));
const {createRuntimeDiagnostics, finalizeRun, redact} = require(path.resolve(diagnosticsPath));

async function main() {
    fs.mkdirSync(artifactsDir, {recursive: true});
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-webdav-path-'));
    const diagnostics = createRuntimeDiagnostics();
    const base = '/shared%20folder/';
    const folders = new Set([base]);
    const files = new Map();
    const calls = [];
    const result = {ok: false, suite: 'webdav-custom-path', buildKind: 'production', extensionDir, liveSynologyVerified: false, cases: [], screenshots: [], httpCalls: calls};
    let launched, server, page, primaryError;
    let launchAttempted = false, browserClosed = false;
    const check = (condition, label) => {if (!condition) throw new Error(label); result.cases.push(label);};
    const writes = () => calls.filter(call => ['PUT', 'MKCOL', 'DELETE'].includes(call.method)).length;
    try {
        server = createServer(async (req, res) => {
            const target = req.url;
            calls.push({method: req.method, path: target, match: req.headers['if-match'], none: req.headers['if-none-match']});
            if (req.headers.authorization !== 'Basic ' + Buffer.from('fixture-user:fixture-app-password').toString('base64')) {res.writeHead(401).end(); return;}
            if (!target.startsWith(base)) {res.writeHead(403).end(); return;}
            const file = files.get(target);
            if (req.method === 'PROPFIND') {
                if (!folders.has(target) && !file) {res.writeHead(404).end(); return;}
                const href = folders.has(target) ? decodeURIComponent(target).replace(/\/$/u, '') : target;
                const prop = folders.has(target) ? '<resourcetype><collection/></resourcetype>' : `<getetag>&quot;v${file.version}&quot;</getetag>`;
                res.writeHead(207, {'Content-Type': 'application/xml'}).end(`<multistatus xmlns="DAV:"><response><href>${href}</href><propstat><prop>${prop}</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`); return;
            }
            if (req.method === 'MKCOL') {
                if (target === base) {res.writeHead(403).end(); return;}
                if (!folders.has(target.replace(/[^/]+\/$/u, ''))) {res.writeHead(409).end(); return;}
                const status = folders.has(target) ? 405 : 201;
                folders.add(target); res.writeHead(status).end(); return;
            }
            if (!target.endsWith('/fluentread-config.encrypted.json')) {res.writeHead(404).end(); return;}
            if (req.method === 'GET') {
                if (!file) {res.writeHead(folders.has(target.slice(0, target.lastIndexOf('/') + 1)) ? 404 : 409).end(); return;}
                if (req.headers['if-match'] && req.headers['if-match'] !== `"v${file.version}"`) {res.writeHead(412).end(); return;}
                res.writeHead(200, {ETag: `"v${file.version}"`}).end(file.content); return;
            }
            if (req.method === 'PUT') {
                if (!folders.has(target.slice(0, target.lastIndexOf('/') + 1))) {res.writeHead(409).end(); return;}
                if (req.headers['if-none-match'] === '*' && file || req.headers['if-match'] && req.headers['if-match'] !== `"v${file?.version}"`) {res.writeHead(412).end(); return;}
                const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
                files.set(target, {content: Buffer.concat(chunks).toString(), version: (file?.version || 0) + 1});
                res.writeHead(201).end(); return;
            }
            if (req.method === 'DELETE') {
                if (!file) {res.writeHead(404).end(); return;}
                if (req.headers['if-match'] !== `"v${file.version}"`) {res.writeHead(412).end(); return;}
                files.delete(target); res.writeHead(204).end(); return;
            }
            res.writeHead(405).end();
        });
        await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
        const origin = `http://127.0.0.1:${server.address().port}`;
        const url = origin + base;
        const directFile = base + 'fluentread-config.encrypted.json';
        const nestedPath = encodeURIComponent('备份') + '/My%20backups/';
        const nestedFile = base + nestedPath + 'fluentread-config.encrypted.json';
        launchAttempted = true;
        launched = await launchFocusSafePersistentContext({chromium, profileDir, browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', headless: false, background: true, displayTarget: 'secondary', browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check'], viewport: {width: 1440, height: 1000}, timeout: 30000});
        guardBrowserClose(launched, profileDir);
        Object.assign(result, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
        const {context} = launched;
        await diagnostics.start(context);
        let worker = context.serviceWorkers().find(item => item.url().startsWith('chrome-extension://')) || await context.waitForEvent('serviceworker', {timeout: 30000});
        const id = new URL(worker.url()).host;
        diagnostics.setExtensionId(id);
        const settingsUrl = `chrome-extension://${id}/options.html#settings-data`;
        async function navigate() {
            const navigation = page.locator('button[data-section="settings-data"]');
            if (await navigation.isVisible()) await navigation.click();
            await page.locator('[data-testid="cloud-config-backup"]').waitFor();
            await page.locator('[data-testid="cloud-method-webdav"]').check();
        }
        async function openPage(label) {
            page = await newPageWithoutForeground(context, 30000);
            await diagnostics.attachPage(page, label);
            await page.goto(settingsUrl, {waitUntil: 'domcontentloaded'});
        }
        let sequence = 0;
        async function patch(values) {
            const response = await page.evaluate(async ({values, sequence}) => {
                const saved = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
                return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'replace', config: {...saved.value, ...values}, clientId: 'fixture-webdav-path-ui', sequence});
            }, {values, sequence: ++sequence});
            check(response.success === true, `configuration patch ${sequence} acknowledged`);
        }
        async function reload() {await page.reload({waitUntil: 'domcontentloaded'}); await navigate();}
        async function shot(name, locator = page.locator('.webdav-settings-dialog')) {
            const filename = path.join(artifactsDir, name + '.png');
            await locator.screenshot({path: filename, animations: 'disabled'}); result.screenshots.push(filename);
        }
        const setup = () => page.locator('.webdav-settings-dialog');
        const syncDialog = () => page.locator('.drive-dialog');
        async function editPath(value) {
            await page.locator('[data-testid="webdav-setup"]').click(); await setup().waitFor();
            await page.locator('#webdav-backup-path').fill(value);
            check(await page.locator('#webdav-password').inputValue() === '', 'editing backup path never reveals the saved password');
            await page.locator('[data-testid="webdav-save"]').click(); await setup().waitFor({state: 'hidden'});
        }
        async function deleteBackup(target) {
            diagnostics.setPhase('delete:' + target);
            await page.locator('[data-testid="webdav-delete-backup"]').click();
            await page.locator('.cloud-delete-dialog').waitFor();
            check(await page.locator('[data-testid="webdav-delete-server"]').innerText() === origin + target.slice(0, target.lastIndexOf('/') + 1), 'delete confirmation identifies the actual configured directory');
            await page.locator('#webdav-delete-verification').fill('确定删除');
            await page.locator('[data-testid="cloud-delete-confirm"]').click();
            await page.locator('.cloud-delete-dialog').waitFor({state: 'hidden'});
            check(!files.has(target), 'conditional delete removes only the selected backup');
        }
        await openPage('webdav-path-settings');
        await patch({uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, to: 'fr'}); await reload();
        diagnostics.setPhase('direct-directory-setup');
        await page.locator('[data-testid="webdav-setup"]').click(); await setup().waitFor();
        check(await page.locator('#webdav-backup-path').inputValue() === 'FluentRead/', 'new connections preserve the legacy default subdirectory');
        await page.locator('#webdav-url').fill(origin + '/shared folder');
        await page.locator('#webdav-backup-path').fill('');
        await page.locator('#webdav-username').fill('fixture-user');
        await page.locator('#webdav-password').fill('wrong-fixture');
        check(!await page.locator('[data-testid="webdav-test"]').isEnabled(), 'HTTP requires explicit consent');
        await setup().locator('input[type="checkbox"]').check();
        await page.locator('[data-testid="webdav-test"]').click();
        await setup().getByText('账号或应用密码不正确', {exact: false}).waitFor();
        check(writes() === 0, 'failed credentials do not write cloud files');
        await page.locator('#webdav-password').fill('fixture-app-password');
        await page.locator('[data-testid="webdav-test"]').click();
        await setup().getByText('连接测试通过', {exact: false}).waitFor();
        check(writes() === 0, 'valid directory without trailing slash in DAV href passes a read-only test');
        await shot('direct-directory-desktop');
        await page.locator('[data-testid="webdav-save"]').click(); await setup().waitFor({state: 'hidden'});
        check(writes() === 0, 'saving a connection creates no folders or backup');
        check(await page.locator('[data-testid="webdav-server"]').innerText() === url, 'blank backup path displays the entered shared directory');
        diagnostics.setPhase('background-restart-and-persistence');
        const restarted = context.waitForEvent('serviceworker', {timeout: 20000});
        await worker.evaluate(() => chrome.runtime.reload()); worker = await restarted;
        await openPage('webdav-path-after-restart'); await navigate();
        await page.locator('[data-testid="webdav-setup"]').click(); await setup().waitFor();
        check(await page.locator('#webdav-backup-path').inputValue() === '' && await page.locator('#webdav-password').inputValue() === '', 'blank path persists through background restart without returning a password');
        await shot('direct-directory-reopened');
        await setup().getByRole('button', {name: '取消', exact: true}).click(); await setup().waitFor({state: 'hidden'});
        diagnostics.setPhase('direct-directory-save');
        await page.locator('[data-testid="webdav-sync-now"]').click(); await syncDialog().waitFor();
        check(writes() === 0, 'first preview is read-only');
        await page.locator('[data-testid="webdav-confirm"]').click(); await syncDialog().waitFor({state: 'hidden'});
        check(files.has(directFile) && calls.every(call => call.method !== 'MKCOL'), 'direct save creates the encrypted backup without any MKCOL');
        check(!files.get(directFile).content.includes('fixture-app-password'), 'backup excludes WebDAV connection credentials');
        await patch({to: 'ja'}); await reload();
        diagnostics.setPhase('direct-directory-restore');
        await page.locator('[data-testid="webdav-sync-now"]').click(); await syncDialog().waitFor();
        if (await page.locator('[data-testid="webdav-back"]').count()) await page.locator('[data-testid="webdav-back"]').click();
        await page.locator('[data-testid="webdav-direction-download"]').check();
        await page.locator('[data-testid="webdav-continue"]').click();
        await page.locator('[data-testid="webdav-confirm"]').click(); await syncDialog().waitFor({state: 'hidden'});
        const restored = await page.evaluate(() => chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}));
        check(restored.value.to === 'fr', 'restore reads and applies the backup from the selected shared directory');
        diagnostics.setPhase('nested-directory-save');
        const beforeEdit = writes(); await editPath('备份/My backups');
        check(writes() === beforeEdit, 'editing a nested backup path is read-only');
        await page.locator('[data-testid="webdav-sync-now"]').click(); await syncDialog().waitFor();
        check(await page.locator('[data-testid="webdav-direction-download"]').count() === 0, 'switching directory does not reuse the old directory backup');
        check(writes() === beforeEdit, 'nested-directory preview creates no directories');
        await page.locator('[data-testid="webdav-confirm"]').click(); await syncDialog().waitFor({state: 'hidden'});
        check(files.has(directFile) && files.has(nestedFile), 'nested save keeps the original backup in place');
        check(JSON.stringify(calls.filter(call => call.method === 'MKCOL').map(call => call.path)) === JSON.stringify([base + encodeURIComponent('备份') + '/', base + nestedPath]), 'nested folders are created from the existing shared folder in order');
        for (const language of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'es-ES', 'ru-RU']) {
            diagnostics.setPhase('narrow-layout:' + language);
            await patch({uiLanguage: language}); await reload();
            await page.setViewportSize({width: 390, height: 1000});
            await page.locator('[data-testid="webdav-setup"]').click(); await setup().waitFor();
            check(await page.locator('#webdav-backup-path').inputValue() === '备份/My backups/', `nested path persists with readable names in ${language}`);
            const metrics = await setup().evaluate(element => ({left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, width: innerWidth, overflow: element.scrollWidth > element.clientWidth, labels: [...element.querySelectorAll('label')].map(label => label.textContent)}));
            check(metrics.left >= 0 && metrics.right <= metrics.width && !metrics.overflow && metrics.labels.every(label => label && !label.includes('settings.webdav.')), `390px ${language} layout resolves labels without horizontal overflow`);
            await shot('nested-directory-' + language + '-390');
        }
        await patch({uiLanguage: 'zh-CN'}); await reload(); await page.setViewportSize({width: 1440, height: 1000});
        await deleteBackup(nestedFile);
        check(files.has(directFile), 'deleting the nested backup preserves the original directory backup');
        await editPath(''); await deleteBackup(directFile);
        check(folders.size === 3 && files.size === 0, 'deletion keeps the shared folder and created subdirectories');
        check(calls.every(call => call.path.startsWith(base)) && !calls.some(call => call.method === 'MKCOL' && call.path === base), 'all requests stay within the selected shared folder and never create its root');
        await diagnostics.flush(); diagnostics.assertClean();
        result.ok = true;
    } catch (error) {
        primaryError = error; result.error = redact(error.stack || error.message || error);
        if (page && !page.isClosed()) {
            try {const file = path.join(artifactsDir, 'failure.png'); await page.screenshot({path: file}); result.screenshots.push(file);}
            catch (captureError) {result.failureScreenshotError = redact(captureError.message);}
        }
    } finally {
        await finalizeRun({diagnostics, result, artifactsDir, primaryError, cleanup: [
            {stage: 'owned-browser-close', action: async () => {if (launched) {await launched.close(); browserClosed = true;}}},
            {stage: 'fixture-close', action: async () => {if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));}},
            {stage: 'profile-cleanup', action: async () => {if (browserClosed) fs.rmSync(profileDir, {recursive: true, force: true}); else if (!launchAttempted) fs.rmdirSync(profileDir);}},
        ]});
        console.log(JSON.stringify({ok: result.ok, cases: result.cases.length, errors: result.runtimeDiagnostics?.counts.errors, warnings: result.runtimeDiagnostics?.counts.warnings, report: path.join(artifactsDir, 'result.json')}));
    }
    if (primaryError) throw primaryError;
}
main().catch(error => {console.error(error.stack || error); process.exitCode = 1;});
