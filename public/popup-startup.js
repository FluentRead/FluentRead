/**
 * @file public/popup-startup.js
 * 文件职责：在 Popup HTML 解析阶段同步恢复非敏感外观画布提示并唤醒后台，使后台初始化与界面模块加载并行。
 * 主要内容：工具栏在首帧绘制前恢复上次皮肤、宽度与明暗背景色以消除白屏/加载页闪烁，并请求引导提示（兼容 Firefox Promise 与 Chromium callback API）；任意 iframe 均跳过，等待模块入口授权。
 * 模块边界：无框架依赖、不读写敏感配置或业务快照、不挂载界面；外观提示经严格格式校验且最终由 mount.ts 按权威配置覆盖，未经授权的嵌入页不唤醒配置入口。
 */
(() => {
    const globals = globalThis;
    if (globals.parent && globals.parent !== globals) return;
    try {
        const root = globals.document?.documentElement;
        const raw = root && globals.localStorage?.getItem('fluentread:popup-startup-appearance');
        if (raw) {
            const hint = JSON.parse(raw);
            const skin = typeof hint?.skin === 'string' && /^[a-z0-9-]+$/u.test(hint.skin) ? hint.skin : '';
            const skinKind = hint?.skinKind === 'craft' || hint?.skinKind === 'default' ? hint.skinKind : '';
            const width = typeof hint?.width === 'number' && Number.isInteger(hint.width) && hint.width >= 260 && hint.width <= 520 ? hint.width : 0;
            const theme = hint?.theme === 'dark' || hint?.theme === 'light' || hint?.theme === 'auto' ? hint.theme : 'auto';
            const dark = hint?.darkOnly === true || theme === 'dark'
                || (theme === 'auto' && Boolean(globals.matchMedia?.('(prefers-color-scheme: dark)')?.matches));
            const bg = dark ? hint?.bgDark : hint?.bgLight;
            if (skin && skinKind && width) {
                root.dataset.interfaceSkin = skin;
                root.dataset.interfaceSkinKind = skinKind;
                root.style.setProperty('--interface-popup-width', `${width}px`);
                if (typeof bg === 'string' && /^#[0-9a-fA-F]{3,8}$/u.test(bg)) {
                    root.style.setProperty('--popup-startup-bg', bg);
                }
                root.classList.toggle('dark', dark);
                root.dataset.fluentreadStartupTheme = '1';
            }
        }
    } catch {
        // 无缓存或存储受限时保留默认启动背景，不能阻断预唤醒或模块加载。
    }
    const message = {type: 'popupStartup'};
    try {
        if (globals.browser?.runtime) {
            globals.__fluentReadPopupWarmup = Promise.resolve(globals.browser.runtime.sendMessage(message))
                .catch(() => undefined);
        } else if (globals.chrome?.runtime) {
            const runtime = globals.chrome.runtime;
            globals.__fluentReadPopupWarmup = new Promise(resolve => {
                runtime.sendMessage(message, response => resolve(runtime.lastError ? undefined : response));
            }).catch(() => undefined);
        }
    } catch {
        // 正常配置读取负责失败回退，预唤醒不能阻断 HTML 或模块加载。
    }
})();
