import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import ts from 'typescript';

// 编译真实 Popup action，注入浏览器边界，验证恢复与配置更新不会走错误的副作用路径。
function loadAction(name: string, ports: Record<string, unknown>) {
    const source = readFileSync(resolve(__dirname, '../src/app/popup/PopupApp.vue'), 'utf8');
    const script = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
    const ast = ts.createSourceFile('popup.ts', script, ts.ScriptTarget.Latest, true);
    const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
    const code = ts.transpileModule(declaration.getText(ast), {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
    return new Function(...Object.keys(ports), `${code}\nreturn ${name};`)(...Object.values(ports));
}

describe('Popup actions across configuration and page state', () => {
    it('恢复已翻译页面不依赖当前服务凭据，只有新翻译才校验凭据', async () => {
        const pageTranslated = {value: true};
        const translating = {value: false};
        const showNotice = vi.fn();
        const browser = {tabs: {
            query: vi.fn(async () => [{id: 3}]),
            sendMessage: vi.fn(async () => ({status: 'success', isTranslated: false})),
        }};
        const action = loadAction('togglePageTranslation', {browser, pageTranslated, translating, showNotice,
            isBrowserTabId: (id: unknown) => typeof id === 'number', credentialWarning: {value: '缺少 API Key'}});
        await action();
        expect(browser.tabs.sendMessage).toHaveBeenCalledWith(3, {type: 'contextMenuTranslate', action: 'restore'});
        expect(pageTranslated.value).toBe(false);
        expect(translating.value).toBe(false);
        await action();
        expect(browser.tabs.sendMessage).toHaveBeenCalledOnce();
        expect(showNotice).toHaveBeenLastCalledWith('缺少 API Key', 'error');
    });

    it('快速切换总开关只修改 on，不广播会重写内容配置的旧功能开关', () => {
        const config = {value: {on: true, disableFloatingBall: true, selectionTranslatorMode: 'bilingual', selectionAreaEnabled: true}};
        const broadcast = vi.fn();
        const action = loadAction('setPluginEnabled', {config, broadcast, browserCapabilities: {areaTranslation: true, imageTranslation: true}});
        action(false); action(true);
        expect(config.value).toEqual({on: true, disableFloatingBall: true, selectionTranslatorMode: 'bilingual', selectionAreaEnabled: true});
        expect(broadcast).not.toHaveBeenCalled();
    });
    it('站点禁用快速撤回不发送可能晚到的页面覆盖命令', () => {
        const config = {value: {disabledExtensionDomains: [] as string[]}};
        const browser = {tabs: {sendMessage: vi.fn(async () => undefined)}};
        const action = loadAction('setCurrentSiteExtensionDisabled', {config, browser,
            currentSiteDomain: {value: 'example.com'}, currentTabId: {value: 3},
            pageTranslated: {value: false}, translating: {value: false}, showNotice: vi.fn()});
        action(true); action(false);
        expect(config.value.disabledExtensionDomains).toEqual([]);
        expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
    });

});
