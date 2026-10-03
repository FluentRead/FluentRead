'use strict';
/**
 * @file scripts/testing/run-dropbox-sync-ui-test.cjs
 * 文件职责：在独立临时 Edge 中验证 Dropbox 同步界面及真实扩展后台存储。
 * 主要内容：虚构授权和 Dropbox HTTP 响应覆盖保存、恢复、换号、取消、失败与窄屏；
 * 确认两个平台的卡片独立，待确认内容与令牌不会通过界面泄露。
 * 模块边界：使用显式 focus-safe helper，不读取日常账号、不访问真实 Dropbox、不代表生产授权成功。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
function arg(name, fallback) {const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1];}
const extensionDir = path.resolve(arg('extension-dir', '.output/dropbox-fixture-chrome-mv3'));
const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-dropbox-ui'));
const playwrightRoot = arg('playwright-root');
const helperPath = arg('focus-safe-helper');
if (!playwrightRoot || !helperPath) throw new Error('必须显式指定 Playwright 和 focus-safe helper');
const {chromium} = require(path.join(playwrightRoot, 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(helperPath);
fs.mkdirSync(artifactsDir, {recursive: true});
async function main() {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-dropbox-profile-'));
    const report = {ok: false, evidence: 'production extension with synthetic public App key, isolated Edge; synthetic Dropbox OAuth and HTTP responses', cases: [], screenshots: [], consoleErrors: []};
    let launched;
    function check(value, label) {if (!value) throw new Error(label); report.cases.push(label);}
    try {
        launched = await launchFocusSafePersistentContext({chromium, profileDir, browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', headless: false, background: true, displayTarget: 'secondary', browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check'], viewport: {width: 1440, height: 1000}, timeout: 30000});
        report.launchMode = launched.launchMode; report.focusPolicy = launched.focusPolicy; report.windowPlacement = launched.windowPlacement;
        const {context} = launched;
        const worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://')) || await context.waitForEvent('serviceworker', {timeout: 30000, predicate: w => w.url().startsWith('chrome-extension://')});
        const extensionId = new URL(worker.url()).host;
        await worker.evaluate(() => {
            globalThis.__dropboxFixture = {content: null, version: 0, account: 'fixture-a', requests: 0, uploads: 0, authorizationUrls: [], failure: false};
            chrome.identity.launchWebAuthFlow = ({url}, callback) => {
                const state = globalThis.__dropboxFixture;
                const auth = new URL(url); state.authorizationUrls.push(url);
                if (auth.searchParams.get('force_reauthentication') === 'true') state.account = 'fixture-b';
                const result = `${auth.searchParams.get('redirect_uri')}?code=fixture-code&state=${auth.searchParams.get('state')}`;
                if (callback) callback(result); else return Promise.resolve(result);
            };
            const original = globalThis.fetch.bind(globalThis);
            globalThis.fetch = async (input, init = {}) => {
                const url = new URL(String(input)); const state = globalThis.__dropboxFixture;
                if (!['api.dropboxapi.com', 'content.dropboxapi.com'].includes(url.hostname)) return original(input, init);
                state.requests++;
                if (state.failure) return new Response('fixture-private-network-error', {status: 503});
                const metadata = () => ({id: 'id:fixture', rev: `rev-${state.version}`, size: new TextEncoder().encode(state.content || '').byteLength, server_modified: '2026-10-03T00:00:00Z'});
                if (url.pathname === '/oauth2/token') return Response.json({access_token: 'fixture-dropbox-token', token_type: 'bearer', expires_in: 14400, scope: 'account_info.read files.metadata.read files.content.read files.content.write'});
                if (url.pathname === '/2/users/get_current_account') return Response.json({account_id: state.account, email: `${state.account}@example.invalid`});
                if (url.pathname === '/2/files/download') return state.content && state.account === 'fixture-a' ? new Response(state.content, {headers: {'Dropbox-API-Result': JSON.stringify(metadata())}}) : new Response(JSON.stringify({error: {'.tag': 'path', path: {'.tag': 'not_found'}}}), {status: 409});
                if (url.pathname === '/2/files/upload') {
                    const envelope = JSON.parse(String(init.body)); if (envelope.format !== 'fluentread-drive-encrypted' || !envelope.ciphertext) throw new Error('fixture rejected plaintext');
                    const args = JSON.parse(init.headers['Dropbox-API-Arg']); if ((args.mode['.tag'] === 'add' && state.content) || (args.mode['.tag'] === 'update' && args.mode.update !== `rev-${state.version}`)) return new Response('fixture-conflict', {status: 409});
                    state.content = String(init.body); state.version++; state.uploads++; return Response.json(metadata());
                }
                throw new Error('unexpected fixture Dropbox endpoint');
            };
        });
        const page = await newPageWithoutForeground(context, 30000);
        page.on('pageerror', error => report.consoleErrors.push(error.message));
        await page.goto(`chrome-extension://${extensionId}/options.html#settings-data`, {waitUntil: 'domcontentloaded'});
        await page.locator('button[data-section="settings-data"]').click();
        const card = page.locator('[data-testid="dropbox-sync"]'); const now = page.locator('[data-testid="dropbox-sync-now"]');
        await now.waitFor(); check(await worker.evaluate(() => globalThis.__dropboxFixture.requests === 0), 'opening settings never authorizes or accesses Dropbox');
        check(await page.locator('[data-testid="google-drive-sync"]').count() === 1 && await card.count() === 1, 'independent Google and Dropbox cards coexist');
        check(await page.locator('#dropbox-title').innerText() === 'Dropbox 配置同步', 'Dropbox provider heading is localized');
        check(!(await card.innerText()).includes('Google'), 'Dropbox description contains no Google provider text');
        const dialog = page.locator('.drive-dialog:visible');
        await now.click(); await page.locator('[data-testid="dropbox-confirm"]').waitFor();
        check((await dialog.innerText()).includes('fixture-a@example.invalid'), 'preview shows the selected Dropbox account');
        check(await worker.evaluate(() => globalThis.__dropboxFixture.uploads === 0), 'preview never writes the cloud');
        check(await dialog.getByRole('button', {name: '取消', exact: true}).count() === 1, 'cancel label is concise');
        await page.locator('[data-testid="dropbox-confirm"]').click(); await dialog.waitFor({state: 'hidden'});
        await page.locator('.el-message').waitFor({state: 'hidden'});
        check(await worker.evaluate(async () => !(await chrome.storage.session.get('fluentreadDropboxSyncSession')).fluentreadDropboxSyncSession), 'successful sync removes temporary token');
        await page.locator('[data-testid="dropbox-last-account"]').getByText('fixture-a@example.invalid', {exact: false}).waitFor();
        check(!(await page.locator('[data-testid="google-drive-sync"]').innerText()).includes('fixture-a'), 'Dropbox history never becomes Google history');
        async function savePatch(patch, sequence) {
            const result = await page.evaluate(async ({patch, sequence}) => {
                const config = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
                const credentials = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:credentials'});
                return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'replace', config: {...config.value, ...credentials.value, ...patch}, clientId: 'fixture-dropbox-ui', sequence});
            }, {patch, sequence}); check(result.success, 'real config storage accepts fixture patch');
        }
        await savePatch({to: 'fr', token: {openai: 'fixture-private-key'}, apiKeys: {openai: ['fixture-private-key']}, customBody: {openai: '{"auth":"fixture-private-body"}'}}, 1);
        await now.click(); await page.locator('[data-testid="dropbox-confirm"]').waitFor();
        if (!(await page.locator('[data-testid="dropbox-direction-download"]').isVisible())) await dialog.getByRole('button', {name: '上一步', exact: true}).click();
        await page.locator('[data-testid="dropbox-direction-download"]').waitFor();
        check(!(await dialog.innerText()).includes('fixture-private'), 'private values remain masked');
        check(await dialog.getByRole('button', {name: '继续', exact: true}).isDisabled(), 'existing backup requires explicit direction selection');
        await page.screenshot({path: path.join(artifactsDir, 'choose-desktop.png')}); report.screenshots.push('choose-desktop.png');
        await page.locator('[data-testid="dropbox-direction-download"]').check(); await dialog.getByRole('button', {name: '继续', exact: true}).click();
        check((await dialog.innerText()).includes('Dropbox'), 'review explains Dropbox restore impact');
        await dialog.getByRole('button', {name: /查看.*差异/}).click();
        check(!(await dialog.innerText()).includes('fixture-private'), 'expanded differences stay masked');
        await page.screenshot({path: path.join(artifactsDir, 'review-desktop.png')}); report.screenshots.push('review-desktop.png');
        await page.setViewportSize({width: 390, height: 844});
        check(await page.evaluate(() => document.documentElement.scrollWidth <= 390), '390px layout does not overflow');
        await page.screenshot({path: path.join(artifactsDir, 'review-mobile.png')}); report.screenshots.push('review-mobile.png');
        await page.locator('[data-testid="dropbox-confirm"]').click(); await dialog.waitFor({state: 'hidden'});
        const restored = await page.evaluate(() => chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:credentials'}));
        check(!JSON.stringify(restored.value).includes('fixture-private-key'), 'restore replaces service credentials');
        await page.setViewportSize({width: 1440, height: 1000});
        await now.click(); await page.locator('[data-testid="dropbox-switch-account"]').waitFor(); await page.locator('[data-testid="dropbox-switch-account"]').click();
        await dialog.getByText('本次同步账号：fixture-b@example.invalid').waitFor();
        await dialog.getByRole('button', {name: '取消', exact: true}).click(); await dialog.waitFor({state: 'hidden'});
        check((await card.innerText()).includes('fixture-a@example.invalid'), 'canceling new account preserves last successful account');
        check(await worker.evaluate(async () => !(await chrome.storage.session.get('fluentreadDropboxSyncSession')).fluentreadDropboxSyncSession), 'cancel clears temporary session');
        await worker.evaluate(() => {globalThis.__dropboxFixture.failure = true;}); await now.click(); await card.locator('.el-alert').waitFor();
        check(!(await card.innerText()).includes('fixture-private-network-error'), 'upstream failures are sanitized');
        await worker.evaluate(() => {globalThis.__dropboxFixture.failure = false;});
        await savePatch({uiLanguage: 'en-US'}, 2); await now.getByText('Sync with Dropbox now', {exact: true}).waitFor();
        check(!(await card.innerText()).includes('配置同步'), 'English card does not retain the Chinese heading');
        await page.screenshot({path: path.join(artifactsDir, 'card-english.png')}); report.screenshots.push('card-english.png');
        check(report.consoleErrors.length === 0, 'no uncaught page errors'); report.ok = true;
    } catch (error) {report.error = error.message; throw error;}
    finally {fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2)); if (launched) await launched.close(); fs.rmSync(profileDir, {recursive: true, force: true});}
    console.log(JSON.stringify(report));
}
main().catch(error => {console.error(error); process.exitCode = 1;});
