'use strict';
/**
 * @file scripts/testing/run-google-drive-sync-ui-test.cjs
 * 文件职责：在临时 Edge 的后台可见窗口验证生产构建的加密同步页面与后台端口。
 * 主要内容：验证浏览器支持提示，再用虚构身份和 Drive HTTP 夹具覆盖同步、条件删除、账号切换与窄屏。
 * 模块边界：不连接真实 Google 账号，不读取日常 profile；报告只保存断言与虚构测试截图。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
function arg(name, fallback) {const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1];}
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-drive-sync-ui'));
const playwrightRoot = arg('playwright-root');
const helperPath = arg('focus-safe-helper');
if (!playwrightRoot || !helperPath) throw new Error('必须显式指定 Playwright 和 focus-safe helper');
const {chromium} = require(path.join(playwrightRoot, 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require(helperPath);
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
fs.mkdirSync(artifactsDir, {recursive: true});

async function main() {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-drive-sync-profile-'));
    const report = {ok: false, evidence: 'production extension, isolated Edge, synthetic Chrome identity and Drive responses', extensionDir, launchMode: null, focusPolicy: null, windowPlacement: null, cases: [], consoleErrors: [], screenshots: []};
    let launched;
    function check(condition, label) {if (!condition) throw new Error(label); report.cases.push(label);}
    try {
        launched = await launchFocusSafePersistentContext({chromium, profileDir, browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', headless: false, background: true, displayTarget: 'secondary', browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check'], viewport: {width: 1440, height: 1000}, timeout: 30_000});
        report.launchMode = launched.launchMode; report.focusPolicy = launched.focusPolicy; report.windowPlacement = launched.windowPlacement;
        const {context} = launched;
        const worker = context.serviceWorkers().find(worker => worker.url().startsWith('chrome-extension://')) || await context.waitForEvent('serviceworker', {timeout: 30_000, predicate: worker => worker.url().startsWith('chrome-extension://')});
        const extensionId = new URL(worker.url()).host;
        check(extensionId === 'djnlaiohfaaifbibleebjggkghlmcpcj', 'public key keeps official extension ID');
        check(manifest.permissions.includes('identity') && JSON.stringify(manifest.oauth2.scopes) === JSON.stringify(['https://www.googleapis.com/auth/drive.appdata']), 'Chrome manifest requests only the single Drive application-data scope');
        const page = await newPageWithoutForeground(context, 30_000);
        page.on('pageerror', error => report.consoleErrors.push(error.message));
        page.on('console', message => {if (message.type() === 'error') report.consoleErrors.push(message.text());});
        const settingsUrl = `chrome-extension://${extensionId}/options.html#settings-data`;
        await page.goto(settingsUrl, {waitUntil: 'domcontentloaded'});
        await page.locator('button[data-section="settings-data"]').click();
        const card = page.locator('[data-testid="google-drive-sync"]');
        await card.waitFor({state: 'visible'});
        await card.getByText('Google Drive 同步目前支持 Chrome 扩展', {exact: false}).waitFor();
        check(await page.locator('[data-testid="google-drive-sync-now"]').count() === 0, 'Edge explicitly shows unsupported native OAuth');

        // 夹具只修改本次临时 profile 的 worker，不授权或访问任何真实账号。
        await worker.evaluate(() => {
            Object.defineProperty(navigator, 'userAgent', {get: () => 'Chrome/142.0.0.0 fixture'});
            globalThis.__driveFixture = {content: null, version: 0, authorizations: 0, clears: 0, requests: 0, uploads: 0, removes: 0, networkFailure: false, etagMode: 'v3', accountId: 'fixture-account', email: 'tester@fixture.invalid'};
            chrome.identity.getAuthToken = async ({interactive, scopes}) => {
                if (JSON.stringify(scopes) !== JSON.stringify(['https://www.googleapis.com/auth/drive.appdata'])) throw new Error('fixture rejected extra OAuth scopes');
                if (interactive) globalThis.__driveFixture.authorizations++;
                return {token: 'fixture-identity-token', grantedScopes: globalThis.__driveFixture.scopes ?? scopes};
            };
            chrome.identity.removeCachedAuthToken = async () => undefined;
            chrome.identity.clearAllCachedAuthTokens = async () => {globalThis.__driveFixture.clears++;};
            const original = globalThis.fetch.bind(globalThis);
            globalThis.fetch = async (input, init = {}) => {
                const url = new URL(String(input));
                const state = globalThis.__driveFixture;
                const metadata = () => ({id: 'fixture-file', version: String(state.version), modifiedTime: '2026-10-02T00:00:00Z'});
                const json = (value,etag) => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json',...(etag ? {etag} : {})}});
                if (url.hostname !== 'www.googleapis.com') return original(input, init);
                state.requests++;
                if (state.networkFailure) return new Response('fixture upstream failure', {status: 503});
                if (url.pathname === '/drive/v3/about' && url.searchParams.get('fields') === 'user(permissionId,emailAddress)') return json({user: {permissionId: state.accountId, ...(state.omitEmail ? {} : {emailAddress: state.email})}});
                if (init.method === 'DELETE' && /^\/drive\/v[23]\/files\/fixture-file$/u.test(url.pathname)) {
                    state.removes++;state.lastDeleteApi=url.pathname;state.lastDeleteMatch=init.headers['If-Match'];
                    if (!state.content) return new Response(null,{status:404});
                    if (state.failDelete || init.headers['If-Match'] !== `"v${state.version}"`) return new Response(null,{status:412});
                    state.content=null;return new Response(null,{status:204});
                }
                if (url.pathname.startsWith('/upload/drive/v3/files')) {
                    const body = String(init.body);
                    const marker = 'Content-Type: application/json\r\n\r\n';
                    const start = body.indexOf(marker) + marker.length;
                    const content = body.slice(start, body.indexOf('\r\n--', start));
                    const envelope = JSON.parse(content);
                    if (envelope.format !== 'fluentread-drive-encrypted' || !envelope.ciphertext) throw new Error('fixture rejected plaintext upload');
                    state.content = content; state.version++; state.uploads++;
                    return json(metadata(),`"v${state.version}"`);
                }
                if (url.pathname === '/drive/v3/files') return json({files: state.content ? [metadata()] : []});
                if (url.searchParams.get('alt') === 'media') return new Response(state.content);
                if (url.pathname === '/drive/v3/files/fixture-file') return json(metadata(),state.etagMode==='v3'?`"v${state.version}"`:undefined);
                if (url.pathname === '/drive/v2/files/fixture-file') return json({...metadata(),modifiedDate:'2026-10-02T00:00:00Z',...(state.etagMode==='v2'?{etag:`"v${state.version}"`}:{})});
                throw new Error('unexpected fixture Google endpoint');
            };
        });
        await page.reload({waitUntil: 'domcontentloaded'});
        await page.locator('[data-testid="google-drive-sync-now"]').waitFor();
        check(await worker.evaluate(() => globalThis.__driveFixture.authorizations === 0), 'opening settings never requests interactive authorization');
        check(await card.getByRole('button', {name: '立即与Google Drive同步', exact: true}).isVisible(), 'idle card has the immediate Google Drive sync action');
        check(!(await card.innerText()).includes('尚未连接') && await card.getByRole('button', {name: '断开连接', exact: true}).count() === 0, 'card has no persistent connection state or disconnect action');
        check(!(await card.innerText()).includes('固定应用口令') && !(await card.innerText()).includes('隐藏应用数据区'), 'card omits the two removed technical paragraphs');
        const disconnected = path.join(artifactsDir, 'sync-disconnected-desktop.png');
        await page.screenshot({path: disconnected}); report.screenshots.push(disconnected);
        if (process.argv.includes('--delete-only')) {
            const deletion=page.locator('.cloud-delete-dialog');const sync=page.locator('.drive-dialog');
            async function openDelete() {await page.locator('[data-testid="google-drive-delete-backup"]').click();await deletion.waitFor();}
            async function cancelDelete() {await page.locator('[data-testid="cloud-delete-cancel"]').click();await deletion.waitFor({state:'hidden'});}
            async function confirmDelete() {await page.locator('[data-testid="cloud-delete-confirm"]').click();await deletion.waitFor({state:'hidden'});}
            async function shot(name) {
                await page.waitForFunction(()=>!document.querySelector('.el-message'),null,{timeout:6000});
                await page.evaluate(async()=>{await new Promise(requestAnimationFrame);await Promise.all(document.getAnimations().filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>undefined)));});
                const target=path.join(artifactsDir,name+'.png');await page.screenshot({path:target});report.screenshots.push(target);
                const compact=page.locator('.cloud-compact-dialog:visible');
                if (await compact.count()) {const detail=path.join(artifactsDir,name+'-dialog.png');await compact.first().screenshot({path:detail});report.screenshots.push(detail);}
            }
            await openDelete();check((await deletion.innerText()).includes('没有云端备份'),'Google empty backup can finish without deleting');await confirmDelete();
            check(await worker.evaluate(()=>globalThis.__driveFixture.removes===0),'empty Google deletion makes no DELETE request');
            await page.locator('[data-testid="google-drive-sync-now"]').click();await sync.waitFor();await page.locator('[data-testid="google-drive-confirm"]').click();await sync.waitFor({state:'hidden'});
            await openDelete();check((await deletion.innerText()).includes('tester@fixture.invalid'),'Google deletion names the actual authorized account');await shot('cloud-delete-drive-desktop');await cancelDelete();
            check(await worker.evaluate(()=>Boolean(globalThis.__driveFixture.content)&&globalThis.__driveFixture.removes===0),'Google cancel keeps cloud data');
            await openDelete();await worker.evaluate(()=>{globalThis.__driveFixture.email='other@fixture.invalid';globalThis.__driveFixture.accountId='fixture-other';});
            await page.locator('[data-testid="google-drive-delete-switch-account"]').click();await deletion.getByText('other@fixture.invalid',{exact:true}).waitFor();
            check(await worker.evaluate(()=>globalThis.__driveFixture.removes===0),'changing deletion account only opens a fresh preview');await cancelDelete();
            await worker.evaluate(()=>{globalThis.__driveFixture.email='tester@fixture.invalid';globalThis.__driveFixture.accountId='fixture-account';});
            await openDelete();await worker.evaluate(()=>{globalThis.__driveFixture.version++;});await confirmDelete();await card.getByText('云端备份已变化',{exact:false}).waitFor();
            check(await worker.evaluate(()=>Boolean(globalThis.__driveFixture.content)&&globalThis.__driveFixture.removes===0),'Google version drift does not delete the new backup');
            await worker.evaluate(()=>{globalThis.__driveFixture.etagMode='none';});await openDelete();check(await page.locator('[data-testid="cloud-delete-unsupported"]').isVisible()&&!(await page.locator('[data-testid="cloud-delete-confirm"]').isEnabled()),'Google missing strong version shows management guidance');await cancelDelete();
            await worker.evaluate(()=>{globalThis.__driveFixture.etagMode='v2';globalThis.__driveFixture.content='unreadable backup';globalThis.__driveFixture.version++;});
            await openDelete();check(await page.locator('[data-testid="cloud-delete-confirm"]').isEnabled(),'Google unreadable backup is deletable using matching v2 ETag');
            await page.setViewportSize({width:390,height:900});check(await deletion.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Google deletion dialog fits narrow screens');await shot('cloud-delete-drive-mobile');
            const before=await page.evaluate(async()=>({config:(await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'})).value,credentials:(await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:credentials'})).value}));await confirmDelete();
            const after=await page.evaluate(async()=>({config:(await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'})).value,credentials:(await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:credentials'})).value}));
            check(JSON.stringify(before)===JSON.stringify(after),'Google deletion keeps real local configuration and credentials');
            check(await worker.evaluate(()=>!globalThis.__driveFixture.content&&globalThis.__driveFixture.lastDeleteApi==='/drive/v2/files/fixture-file'&&globalThis.__driveFixture.lastDeleteMatch===`"v${globalThis.__driveFixture.version}"`),'Google deletes through the same v2 API with If-Match');
            check(!(await card.innerText()).includes('上次同步'),'Google successful deletion clears account and sync record');
            await openDelete();await confirmDelete();check(await worker.evaluate(()=>globalThis.__driveFixture.removes===1),'Google repeated absent deletion is harmless');
            check(report.consoleErrors.length===0,'Google deletion has no console errors');report.ok=true;return;
        }
        const initialClears = await worker.evaluate(() => globalThis.__driveFixture.clears);
        await worker.evaluate(() => {globalThis.__driveFixture.scopes = ['email'];});
        await page.locator('[data-testid="google-drive-sync-now"]').click();
        await card.getByText('允许访问配置数据', {exact: false}).waitFor();
        check(await worker.evaluate(() => globalThis.__driveFixture.uploads === 0 && globalThis.__driveFixture.requests === 0), 'missing Drive permission blocks all Google data requests and writes');
        check(await worker.evaluate(initial => globalThis.__driveFixture.clears === initial + 1, initialClears), 'partial authorization failure clears the identity cache');
        await worker.evaluate(() => {delete globalThis.__driveFixture.scopes;});
        await page.locator('[data-testid="google-drive-sync-now"]').click();
        await page.locator('.el-dialog').waitFor();
        check(await worker.evaluate(() => globalThis.__driveFixture.authorizations === 2), 'retry opens preview with one new authorization');
        check(await card.getByRole('button', {name: '立即与Google Drive同步', exact: true}).count() === 1, 'active transaction keeps the same immediate sync action');
        check(await card.locator('input[type="password"]').count() === 0, 'connected account never asks for a passphrase');
        check(await worker.evaluate(() => globalThis.__driveFixture.uploads === 0), 'preview has no cloud write');
        check(await page.locator('.el-dialog input[type="password"]').count() === 0, 'first upload needs no passphrase confirmation');
        check(await page.locator('[data-testid="google-drive-confirm"]').isEnabled(), 'first upload is ready after explicit preview');
        await page.locator('[data-testid="google-drive-confirm"]').click();
        await page.getByText('Google Drive 配置同步完成', {exact: true}).waitFor();
        await page.locator('.el-dialog').waitFor({state: 'hidden'});
        check(await worker.evaluate(() => {const state = globalThis.__driveFixture; return state.uploads === 1 && !state.content.includes('FluentReadEncryption') && !state.content.includes('fixture-identity-token');}), 'upload contains encryption envelope only');
        check(await worker.evaluate(initial => globalThis.__driveFixture.clears === initial + 2, initialClears), 'successful sync automatically clears authorization');
        check(await card.getByRole('button', {name: '断开连接', exact: true}).count() === 0 && !(await card.innerText()).includes('tester@fixture.invalid'), 'completed card shows sync history without a connected account');

        await worker.evaluate(() => {globalThis.__driveFixture.omitEmail = true;});
        await page.locator('[data-testid="google-drive-sync-now"]').click();
        await page.locator('.el-dialog').waitFor();
        check(await page.locator('.drive-preview-account').innerText() === '本次同步使用您在 Google 中选择的账号。', 'Drive-only authorization still supports preview when Google omits email');
        await page.locator('.el-dialog').getByRole('button', {name: '取消', exact: true}).click();
        await page.locator('.el-dialog').waitFor({state: 'hidden'});
        await worker.evaluate(() => {delete globalThis.__driveFixture.omitEmail;});

        // 使用现有可信配置保存端口修改虚构凭据与语言，验证真实配置存储恢复。
        async function savePatch(patch, sequence) {
            const response = await page.evaluate(async ({patch, sequence}) => {
                const current = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
                const credentials = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:credentials'});
                const complete = {...current.value, ...credentials.value};
                return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'replace', config: {...complete, ...patch}, clientId: 'fixture-drive-ui', sequence});
            }, {patch, sequence});
            check(response.success === true, `real background config persistence ${sequence}${response.success ? '' : `: ${response.error}`}`);
        }
        await savePatch({to: 'fr', token: {openai: 'fixture-private-api-key'}, apiKeys: {openai: ['fixture-private-api-key']}, customBody: {openai: '{"auth":"fixture-private-body"}'}, proxy: {openai: 'https://fixture.invalid/?key=fixture-private-url'}}, 1);
        await page.locator('[data-testid="google-drive-sync-now"]').click();
        await page.locator('.drive-change').first().waitFor();
        check(await worker.evaluate(() => globalThis.__driveFixture.authorizations === 4), 'each new sync transaction gets one authorization');
        const dialog = page.locator('.el-dialog');
        check(!(await dialog.innerText()).includes('fixture-private'), 'preview masks private keys, bodies and URLs');
        await dialog.getByText('本机 → 云端', {exact: true}).click();
        await dialog.locator('.el-radio-button.is-active').filter({hasText: '本机 → 云端'}).waitFor();
        await page.waitForTimeout(350);
        check(await dialog.getByRole('radio', {name: '本机 → 云端', exact: true}).isChecked(), 'upload direction has checked radio state');
        const previewShot = path.join(artifactsDir, 'encrypted-sync-preview.png');
        await page.screenshot({path: previewShot}); report.screenshots.push(previewShot);
        await page.locator('[data-testid="google-drive-confirm"]').click();
        await page.getByRole('button', {name: '确认替换', exact: true}).click();
        await page.locator('.el-dialog').waitFor({state: 'hidden'});
        check(await worker.evaluate(() => !globalThis.__driveFixture.content.includes('fixture-private')), 'complete credentials remain opaque in cloud fixture');
        check(await worker.evaluate(async () => {
            const envelope = JSON.parse(globalThis.__driveFixture.content);
            const decode = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
            const material = await crypto.subtle.importKey('raw', new TextEncoder().encode('FluentReadEncryption'), 'PBKDF2', false, ['deriveKey']);
            const key = await crypto.subtle.deriveKey({name: 'PBKDF2', hash: 'SHA-256', iterations: envelope.iterations, salt: decode(envelope.salt)}, material, {name: 'AES-GCM', length: 256}, false, ['decrypt']);
            const plaintext = await crypto.subtle.decrypt({name: 'AES-GCM', iv: decode(envelope.iv), additionalData: new TextEncoder().encode('fluentread-drive-encrypted:1:PBKDF2:SHA-256:600000:AES-256-GCM'), tagLength: 128}, key, decode(envelope.ciphertext));
            const text = new TextDecoder().decode(plaintext);
            return ['fixture-private-api-key', 'fixture-private-body', 'fixture-private-url'].every(value => text.includes(value));
        }), 'supplied application passphrase decrypts the complete uploaded fixture');
        await savePatch({to: 'de', token: {}, apiKeys: {}, customBody: {}, proxy: {}}, 2);
        await worker.evaluate(() => {
            const state = globalThis.__driveFixture;
            state.originalContent = state.content;
            const envelope = JSON.parse(state.content);
            envelope.ciphertext = (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1);
            state.content = JSON.stringify(envelope);
        });
        await page.locator('[data-testid="google-drive-sync-now"]').click();
        await card.getByText('同步文件无法解密', {exact: false}).waitFor();
        check((await page.evaluate(() => chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}))).value.to === 'de', 'corrupted cloud file leaves local configuration unchanged');
        check(await worker.evaluate(initial => globalThis.__driveFixture.clears === initial + 5, initialClears), 'failed preview automatically clears authorization');
        await worker.evaluate(() => {globalThis.__driveFixture.content = globalThis.__driveFixture.originalContent;});
        await page.locator('[data-testid="google-drive-sync-now"]').click();
        await dialog.getByText('云端 → 本机', {exact: true}).click();
        check(await dialog.getByRole('radio', {name: '云端 → 本机', exact: true}).isChecked(), 'download direction has checked radio state');
        await page.locator('[data-testid="google-drive-confirm"]').click();
        await page.getByRole('button', {name: '确认替换', exact: true}).click();
        await page.locator('.el-dialog').waitFor({state: 'hidden'});
        const restored = await page.evaluate(() => chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:credentials'}));
        check(JSON.stringify(restored.value).includes('fixture-private-api-key'), 'download restores full credentials through real storage');
        check((await page.evaluate(() => chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}))).value.to === 'fr', 'download restores cloud language');
        const hiddenState = await page.evaluate(() => chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:googleDriveEncryptedSyncState'}));
        check(hiddenState.success === false, 'private sync state is excluded from public storage proxy');
        const beforeCancel = await worker.evaluate(() => ({clears: globalThis.__driveFixture.clears, uploads: globalThis.__driveFixture.uploads}));
        await page.locator('[data-testid="google-drive-sync-now"]').click();
        await dialog.waitFor({state: 'visible'});
        await dialog.getByRole('button', {name: '取消', exact: true}).click();
        await dialog.waitFor({state: 'hidden'});
        check(await worker.evaluate(before => globalThis.__driveFixture.clears === before.clears + 1 && globalThis.__driveFixture.uploads === before.uploads, beforeCancel), 'cancel ends authorization without a cloud write');
        const closingPage = await newPageWithoutForeground(context, 30_000);
        await closingPage.goto(settingsUrl, {waitUntil: 'domcontentloaded'});
        await closingPage.locator('button[data-section="settings-data"]').click();
        await closingPage.locator('[data-testid="google-drive-sync-now"]').click();
        await closingPage.locator('.el-dialog').waitFor({state: 'visible'});
        const beforeClose = await worker.evaluate(() => globalThis.__driveFixture.clears);
        const closingTabId = await closingPage.evaluate(async () => (await chrome.tabs.getCurrent()).id);
        await worker.evaluate(tabId => chrome.tabs.remove(tabId), closingTabId);
        for (let retry = 0; retry < 30 && await worker.evaluate(() => globalThis.__driveFixture.clears) === beforeClose; retry++) await page.waitForTimeout(100);
        check(await worker.evaluate(before => globalThis.__driveFixture.clears === before + 1, beforeClose), 'closing the options tab ends the pending authorization');
        const beforeReopen = await worker.evaluate(() => ({requests: globalThis.__driveFixture.requests, authorizations: globalThis.__driveFixture.authorizations}));
        await page.reload({waitUntil: 'domcontentloaded'});
        await page.locator('[data-testid="google-drive-sync-now"]').waitFor();
        check(await worker.evaluate(before => globalThis.__driveFixture.requests === before.requests && globalThis.__driveFixture.authorizations === before.authorizations, beforeReopen), 'reopening settings does not reconnect or contact Google');
        check(await card.locator('input[type="password"]').count() === 0, 'reopening settings still requires no passphrase');
        const screenshot = path.join(artifactsDir, 'encrypted-sync-desktop.png');
        await page.screenshot({path: screenshot}); report.screenshots.push(screenshot);
        await page.locator('button[data-section="settings-general"]').click();
        await page.locator('button[data-section="settings-data"]').click();
        await page.locator('[data-testid="google-drive-sync-now"]').waitFor();
        check(await card.locator('input[type="password"]').count() === 0, 'returning to backup panel requires no passphrase');
        await page.setViewportSize({width: 390, height: 900});
        await activateExtensionTabWithoutForeground(context, page);
        check(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), '390px settings has no horizontal overflow');
        const mobile = path.join(artifactsDir, 'encrypted-sync-mobile.png');
        await page.screenshot({path: mobile}); report.screenshots.push(mobile);
        await savePatch({uiLanguage: 'en-US', uiLanguageSetupCompleted: true}, 3);
        await page.reload({waitUntil: 'domcontentloaded'});
        await card.getByRole('heading', {name: 'Google Drive configuration sync', exact: true}).waitFor();
        check(await card.getByRole('button', {name: 'Sync with Google Drive now', exact: true}).isVisible(), 'English sync controls are translated');
        check(!(await card.innerText()).match(/[\u3400-\u9fff]/u), 'English sync card contains no Chinese source copy');
        check(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), '390px English settings has no horizontal overflow');
        const english = path.join(artifactsDir, 'encrypted-sync-english-mobile.png');
        await page.screenshot({path: english}); report.screenshots.push(english);
        check(report.consoleErrors.length === 0, 'no settings console errors');
        report.ok = true;
    } finally {
        if (launched) await launched.close();
        fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
        fs.rmSync(profileDir, {recursive: true, force: true});
    }
    console.log(JSON.stringify(report, null, 2));
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
