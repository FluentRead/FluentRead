import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

/** 仅打包固定版本的官方页面端及样式；官方侧栏在其 HTTPS 来源隔离运行。 */
export function hypothesisAssets(root: string) {
    const directory = resolve(root, 'node_modules/hypothesis');
    const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
    if (manifest.version !== '1.1771.0') throw new Error('Unexpected Hypothesis client version');
    const script = readFileSync(resolve(directory, 'build/scripts/annotator.bundle.js'), 'utf8');
    const boot = readFileSync(resolve(directory, 'build/boot-template.js'), 'utf8')
        .replace('"__ASSET_ROOT__"', 'new URL("../",document.currentScript.src).href')
        .replace('__SIDEBAR_APP_URL__', 'https://hypothes.is/app.html')
        .replace('__NOTEBOOK_APP_URL__', 'https://hypothes.is/notebook')
        .replace('__PROFILE_APP_URL__', 'https://hypothes.is/user-profile.html');
    return [
        // 迟到的 executeScript 不得在已经关闭或导航后的文档启动客户端。
        {relativeDest: 'hypothesis/build/scripts/annotator.bundle.js', contents: `if(document.querySelector('link[rel="sidebar"][data-fluentread-hypothesis="on"],script.js-hypothesis-config[data-remove-on-unload]')){\n${script}\n}`},
        {relativeDest: 'hypothesis/build/boot.js', contents: boot},
        ...['annotator.css', 'highlights.css', 'pdfjs-overrides.css'].map(file => ({absoluteSrc: resolve(directory, 'build/styles', file), relativeDest: `hypothesis/build/styles/${file}`})),
        {absoluteSrc: resolve(directory, 'LICENSE'), relativeDest: 'third-party-notices/hypothesis-BSD-2-Clause-and-Annotator-MIT.txt'},
    ];
}
