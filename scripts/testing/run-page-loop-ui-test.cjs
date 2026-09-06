'use strict';

/** 使用真实 MutationObserver/rAF/showModal 对比宿主拒绝浮层时的恢复预算。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {execFileSync} = require('node:child_process');
const ts = require('typescript');
const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const artifacts = path.resolve(argument('artifacts-dir', '/private/tmp/fluentread-page-loop-ui'));
const sourcePath = 'src/features/selection-translation/content/modalDialogHost.ts';
const sources = {fixed: fs.readFileSync(sourcePath, 'utf8')};
const baseline = argument('baseline-ref');
if (baseline) sources.baseline = execFileSync('git', ['show', `${baseline}:${sourcePath}`], {encoding: 'utf8'});
const modules = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name,
  ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022}}).outputText]));
const {chromium} = require(path.join(argument('playwright-root'), 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(path.resolve(argument('focus-safe-helper')));

async function main() {
  fs.mkdirSync(artifacts, {recursive: true});
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-loop-'));
  const report = {ok: false, scope: 'native browser fixture using the actual production modal controller', cases: {}, errors: []};
  const server = http.createServer((request, response) => {
    const mode = request.url.includes('baseline') ? 'baseline' : 'fixed';
    if (request.url.endsWith('.js')) {
      response.writeHead(200, {'Content-Type': 'text/javascript'});
      response.end(modules[mode]);
      return;
    }
    response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    response.end(`<!doctype html><html><body><h1>Host ownership fixture</h1><div id="origin"><div id="host">Extension overlay</div></div>
      <dialog><p>Selected text remains controlled by the host page.</p></dialog><script type="module">
      import {createModalDialogHostController} from '/${mode}.js';
      const dialog = document.querySelector('dialog');
      const host = document.querySelector('#host');
      dialog.showModal();
      const range = document.createRange(); range.selectNodeContents(dialog.querySelector('p'));
      const controller = createModalDialogHostController(host);
      controller.placeForRange(range);
      window.removals = 0;
      const reject = () => {
        for (const slot of dialog.querySelectorAll('[data-fluent-read-modal-dialog-host-slot]')) {
          window.removals++; slot.remove();
        }
      };
      const observer = new MutationObserver(reject); observer.observe(dialog, {childList: true});
      reject();
      window.fixture = {controller, range, observer, host};
      </script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let launched;
  try {
    launched = await launchFocusSafePersistentContext({chromium, profileDir,
      browserPath: argument('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      background: true, headless: false, viewport: {width: 1100, height: 800}, timeout: 30000});
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    for (const mode of Object.keys(modules)) {
      const page = await newPageWithoutForeground(launched.context, 30000);
      page.on('pageerror', error => report.errors.push(error.message));
      try {
        await page.goto(`http://127.0.0.1:${server.address().port}/${mode}`);
        await page.waitForFunction(() => Boolean(window.fixture));
        await page.waitForTimeout(400);
        const first = await page.evaluate(() => window.removals);
        await page.waitForTimeout(400);
        const second = await page.evaluate(() => window.removals);
        const state = await page.evaluate(() => ({
          originalParent: window.fixture.host.parentElement?.id || '(detached slot)',
          hostText: document.querySelector('dialog p').textContent,
          retried: window.fixture.controller.placeForRange(window.fixture.range),
        }));
        report.cases[mode] = {first, second, ...state};
        if (mode === 'fixed' && (first !== 3 || second !== first || state.originalParent !== 'origin' || state.retried)) {
          throw new Error(`恢复预算没有终止 DOM 争夺：${JSON.stringify(report.cases[mode])}`);
        }
        if (mode === 'baseline' && second <= first) throw new Error('基线没有复现持续重插');
        if (mode === 'fixed') {
          const reopened = await page.evaluate(async () => {
            window.fixture.observer.disconnect();
            const dialog = document.querySelector('dialog');
            await new Promise(resolve => {
              dialog.addEventListener('close', resolve, {once: true});
              dialog.close();
            });
            dialog.showModal();
            return window.fixture.controller.placeForRange(window.fixture.range);
          });
          report.cases[mode].reopened = reopened;
          if (!reopened) throw new Error('同一对话框关闭后重新打开未能恢复浮层');
        }
        await page.screenshot({path: path.join(artifacts, `${mode}.png`)});
        await page.evaluate(() => {window.fixture.observer.disconnect(); window.fixture.controller.dispose();});
      } finally {await page.close();}
    }
    if (report.errors.length) throw new Error('浏览器出现未处理异常');
    report.ok = true;
  } catch (error) {
    report.failure = String(error.stack || error);
    throw error;
  } finally {
    fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    await launched?.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profileDir, {recursive: true, force: true});
  }
  process.stdout.write(JSON.stringify(report, null, 2));
}
main().catch(error => {console.error(error); process.exitCode = 1;});
