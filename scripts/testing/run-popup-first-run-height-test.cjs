#!/usr/bin/env node
/**
 * @file scripts/testing/run-popup-first-run-height-test.cjs
 * Verify compact single-screen language selection, true pending-save controls,
 * short-viewport height independence, main-load error/reopen and persisted choice.
 * Runs only an owned production snapshot in a new focus-safe temporary profile.
 */
'use strict';

const assert = require('node:assert/strict');
const {guardBrowserClose} = require('./owned-browser-close.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const crypto = require('node:crypto');

const args = {focusSafeHelper: path.join(__dirname, 'focus-safe-browser.cjs'), timeout: 30000};
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index];
  if (flag === '--background') continue;
  if (flag === '--fail-main-once') { args.failMainOnce = true; continue; }
  assert.ok(flag.startsWith('--') && process.argv[index + 1], `Invalid argument ${flag}`);
  args[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = process.argv[++index];
}
for (const name of ['extensionDir', 'playwrightRoot', 'browserPath', 'focusSafeHelper', 'artifactsDir']) {
  assert.ok(args[name], `Missing ${name}`);
  args[name] = path.resolve(args[name]);
}
args.timeout = Number(args.timeout);
assert.ok(fs.existsSync(path.join(args.extensionDir, 'manifest.json')), 'Production extension missing');
fs.mkdirSync(args.artifactsDir, {recursive: true});

const {chromium} = createRequire(path.join(args.playwrightRoot, 'popup-height.cjs'))('playwright');
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(args.focusSafeHelper);
const report = {scope: 'single-screen-popup-height-and-onboarding-layout', profileMode: 'new-temporary-profile', cases: [], errors: [], injectedModuleErrors: []};
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-popup-height-'));
const stagedExtension = path.join(profileDir, 'unpacked-production');
function hash(data) {return crypto.createHash('sha256').update(data).digest('hex');}
function tree(root) {const entries=[];function walk(dir,prefix='') {for(const name of fs.readdirSync(dir).sort()) {const file=path.join(dir,name),relative=prefix+name;if(fs.statSync(file).isDirectory())walk(file,relative+'/');else entries.push([relative,hash(fs.readFileSync(file))]);}}walk(root);return {sha256:hash(JSON.stringify(entries)),files:entries.length};}
async function poll(label, read, accepts = Boolean) {const until=Date.now()+args.timeout;let last;do {last=await read();if(accepts(last))return last;await new Promise(resolve=>setTimeout(resolve,40));} while(Date.now()<until);throw new Error('Bounded poll timed out: '+label+'; last='+JSON.stringify(last));}

async function inspect(page, label, selector, screenshot) {
  await page.locator(selector).waitFor({state: 'visible', timeout: args.timeout});
  await page.waitForTimeout(350);
  const geometry = await page.evaluate(selector => {
    const shell = document.querySelector('.popup-shell');
    const card = document.querySelector(selector);
    const shellRect = shell.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return {
      viewport: {width: innerWidth, height: innerHeight},
      shell: {width: shellRect.width, height: shellRect.height, bottom: shellRect.bottom},
      card: {top: cardRect.top, bottom: cardRect.bottom},
      scrollHeight: shell.scrollHeight,
      clientHeight: shell.clientHeight,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      mainHidden: !document.querySelector('.popup-content') || getComputedStyle(document.querySelector('.popup-content')).display === 'none',
    };
  }, selector);
  report.cases.push({label, geometry});
  assert.equal(geometry.viewport.height, 130, `${label}: constrained viewport changed`);
  const compactError = label === 'main-error';
  assert.ok(geometry.shell.height >= (compactError ? 40 : 300) && geometry.shell.height <= (label === 'main' ? 560 : compactError ? 180 : 430), `${label}: unexpected content height ${geometry.shell.height}px`);
  assert.notEqual(Math.round(geometry.shell.height), 130, `${label}: popup height locked to short viewport`);
  assert.ok(geometry.card.bottom <= geometry.shell.bottom + 1, `${label}: card clipped by popup shell`);
  assert.ok(geometry.scrollHeight <= geometry.clientHeight + 1, `${label}: initial content requires internal scrolling`);
  assert.equal(geometry.horizontalOverflow, false, `${label}: horizontal overflow`);
  assert.equal(geometry.mainHidden, label !== 'main', `${label}: wrong content visibility`);
  await page.setViewportSize({width: 400, height: 560});
  await page.evaluate(() => scrollTo(0, 0));
  await page.locator('.popup-shell').screenshot({path: path.join(args.artifactsDir, screenshot)});
  await page.setViewportSize({width: 400, height: 130});
}

async function inspectLanguages(page, width, dark) {
  await page.setViewportSize({width, height: 560});
  await page.evaluate(({width, dark}) => {
    document.documentElement.style.setProperty('--interface-popup-width', `${width}px`);
    document.documentElement.classList.toggle('dark', dark);
    scrollTo(0, 0);
  }, {width, dark});
  // Capture the settled theme: text changes immediately, while card backgrounds
  // still animate. Use the existing phase budget and read-only color sampling.
  await page.waitForFunction(() => {
    const root = getComputedStyle(document.documentElement);
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext('2d', {willReadFrequently: true});
    if (!context) return false;
    const pixel = color => {
      if (!color || !CSS.supports('color', color)) return null;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].join(',');
    };
    try {
      const cards = [...document.querySelectorAll('.onboarding-language-option')];
      const panel = document.querySelector('.language-onboarding');
      if (!cards.length || !panel || pixel(getComputedStyle(panel).backgroundColor) !== pixel(root.getPropertyValue('--surface').trim())) return false;
      return cards.every(card => {
        const actual = pixel(getComputedStyle(card).backgroundColor);
        const expected = pixel(root.getPropertyValue(card.classList.contains('selected') ? '--brand-soft' : '--surface-soft').trim());
        return actual !== null && actual === expected && !card.getAnimations().some(animation =>
          typeof animation.transitionProperty === 'string' && /background/u.test(animation.transitionProperty)
          && ['running', 'pending'].includes(animation.playState));
      });
    } finally {canvas.width = 0; canvas.height = 0;}
  }, undefined, {timeout: args.timeout});
  const geometry = await page.evaluate(() => {
    const grid = document.querySelector('.onboarding-language-options').getBoundingClientRect();
    const shell = document.querySelector('.popup-shell');
    const options = [...document.querySelectorAll('.onboarding-language-option')].map(option => {
      const rect = option.getBoundingClientRect();
      const label = option.firstElementChild;
      const labelRect = label.getBoundingClientRect();
      return {
        language: option.dataset.language,
        text: label.textContent.trim(), lang: option.getAttribute('lang'), tabindex: option.tabIndex,
        background: getComputedStyle(option).backgroundColor,
        color: getComputedStyle(option).color,
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        clipped: labelRect.left < rect.left || labelRect.right > rect.right || labelRect.top < rect.top || labelRect.bottom > rect.bottom,
      };
    });
    const confirm = document.querySelector('.onboarding-form .onboarding-confirm').getBoundingClientRect();
    return {
      grid: {left: grid.left, right: grid.right}, options,
      shellHeight: shell.getBoundingClientRect().height,
      internalOverflow: shell.scrollHeight > shell.clientHeight + 1,
      confirmVisible: confirm.top >= 0 && confirm.bottom <= innerHeight,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });
  report.cases.push({label: `languages-${width}-${dark ? 'dark' : 'light'}`, geometry});
  {
    assert.equal(geometry.options.length, 7);
    assert.equal(geometry.options.some(option => option.clipped), false, `${width}px: language text clipped`);
    assert.deepEqual(geometry.options.map(option => option.text), ['简体中文', 'English', '日本語', '한국어', 'Français', 'Русский', 'Español']);
    assert.ok(geometry.options.every(option => option.lang === option.language && option.left >= geometry.grid.left - 1 && option.right <= geometry.grid.right + 1), `${width}px: language outside group`);
    assert.equal(geometry.options.filter(option => option.tabindex === 0).length, 1, `${width}px: radio group must have one Tab entry`);
    assert.equal(geometry.internalOverflow, false, `${width}px: internal overflow`);
    assert.equal(geometry.confirmVisible, true, `${width}px: confirm clipped`);
    assert.equal(geometry.horizontalOverflow, false, `${width}px: horizontal overflow`);
  }
  await page.locator('.popup-shell').screenshot({path: path.join(args.artifactsDir, `languages-${width}-${dark ? 'dark' : 'light'}.png`)});
}

async function main() {
  let session, primaryError;
  try {
    fs.cpSync(args.extensionDir, stagedExtension, {recursive:true});report.productionPackage=tree(stagedExtension);assert.deepEqual(report.productionPackage,tree(args.extensionDir));
    const chunkDir=path.join(stagedExtension,'chunks');
    const onboardingFiles=fs.readdirSync(chunkDir).filter(name=>name.endsWith('.js')&&fs.readFileSync(path.join(chunkDir,name),'utf8').includes('onboarding-load-error'));
    assert.equal(onboardingFiles.length,1);
    const mainImports=[...fs.readFileSync(path.join(chunkDir,onboardingFiles[0]),'utf8').matchAll(/import\(["']([^"']+\.js)["']\)/g)].map(match=>path.resolve(chunkDir,match[1])).filter(file=>fs.existsSync(file)&&fs.readFileSync(file,'utf8').includes('data-popup-module-order'));
    assert.equal(mainImports.length,1);const mainChunk=path.basename(mainImports[0]);report.actualMainChunk={onboarding:onboardingFiles[0],main:mainChunk,sha256:hash(fs.readFileSync(mainImports[0]))};
    session = await launchFocusSafePersistentContext({
      chromium,
      profileDir,
      browserPath: args.browserPath,
      background: true,
      headless: false,
      displayTarget: 'secondary',
      viewport: {width: 1280, height: 900},
      timeout: args.timeout,
      browserArgs: [
        `--disable-extensions-except=${stagedExtension}`,
        `--load-extension=${stagedExtension}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    guardBrowserClose(session, profileDir);
    Object.assign(report, {
      launchMode: session.launchMode,
      focusPolicy: session.focusPolicy,
      windowPlacement: session.windowPlacement,
    });
    assert.equal(session.launchMode, 'macos-background-cdp');
    assert.equal(session.focusPolicy, 'launchservices-no-foreground');
    const {context} = session;
    let abortedMainModules = 0;
    if (args.failMainOnce) await context.route('**/chunks/'+mainChunk, route => {
      if (abortedMainModules === 0) { abortedMainModules++; return route.abort('failed'); }
      return route.continue();
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: args.timeout});
    const popupUrl = `chrome-extension://${new URL(worker.url()).host}/popup.html`;
    const popup = await newPageWithoutForeground(context, args.timeout);
    popup.on('pageerror', error => report.errors.push(`pageerror: ${error.message}`));
    popup.on('console', message => {
      if (message.type() === 'error') {
        if (args.failMainOnce && message.location().url.endsWith('/chunks/'+mainChunk)) report.injectedModuleErrors.push(message.text());
        else report.errors.push(`console: ${message.text()}`);
      }
    });
    await popup.addInitScript(() => {
      // This short-viewport probe simulates toolbar sizing inside an extension tab.
      chrome.tabs.getCurrent = callback => {
        if (typeof callback === 'function') {
          queueMicrotask(() => callback(undefined));
          return;
        }
        return Promise.resolve(undefined);
      };
      const state = {frames: [], configDelays: 0, englishDelays: 0, stopped: false, saveReceipts: []};
      globalThis.__onboardingStartup = state;
      const send = chrome.runtime.sendMessage.bind(chrome.runtime), heldSaves=[];
      let holdSaves=true;
      window.__releaseHeightSave = () => {holdSaves=false;for(const deliver of heldSaves.splice(0))deliver();};
      chrome.runtime.sendMessage = (...args) => {
        const message = typeof args[0] === 'string' ? args[1] : args[0];
        const delayedRead=message?.type==='configStorageRead' && message.key==='local:config';
        const delayedSave=message?.type==='persistConfig' && message.mode==='patch' && Object.hasOwn(message.config||{},'uiLanguageSetupCompleted');
        if (!delayedRead && !delayedSave) return send(...args);
        if (delayedRead) state.configDelays++;
        const event=delayedSave?{nativeSuccess:false,delivered:false}:undefined;if(event)state.saveReceipts.push(event);
        const callback=typeof args.at(-1)==='function'?args.at(-1):undefined;
        const afterReceipt=(reply,deliver)=>{
          const release=()=>{if(event)event.delivered=true;deliver(reply);};
          if(event) {event.nativeSuccess=reply?.success===true;if(holdSaves){heldSaves.push(release);return;}}
          if(delayedRead)setTimeout(release,1200);else release();
        };
        if(callback){const forwarded=args.slice(0,-1);forwarded.push(reply=>{if(chrome.runtime.lastError)return callback(reply);afterReceipt(reply,callback);});return send(...forwarded);}
        return Promise.resolve(send(...args)).then(reply=>new Promise(resolve=>afterReceipt(reply,resolve)));
      };
      const originalFetch = fetch.bind(globalThis);
      globalThis.fetch = (...args) => {
        if (!String(args[0]).endsWith('/i18n/en-US.json')) return originalFetch(...args);
        state.englishDelays++;
        return new Promise(resolve => setTimeout(() => resolve(originalFetch(...args)), 800));
      };
      let previous;
      function sample() {
        const app = document.querySelector('#app');
        const card = document.querySelector('.language-onboarding-card');
        const language = document.querySelector('[data-testid="onboarding-language-step"]');
        const phase = document.querySelector('.popup-startup') ? 'startup' : language ? 'language' : 'other';
        if (app && phase !== 'other') {
          const rect = app.getBoundingClientRect();
          const frame = {
            phase, width: rect.width, height: rect.height,
            cardTransform: card ? getComputedStyle(card).transform : null,
            englishReady: language ? Boolean(language.querySelector('#language-onboarding-title small')?.textContent.trim()) : null,
            textOnlyBrand: document.body.innerText.trim() === 'FluentRead',
          };
          const key = JSON.stringify(frame);
          if (key !== previous) state.frames.push({...frame, time: performance.now()});
          previous = key;
        }
        if (!state.stopped) requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
    await popup.setViewportSize({width: 320, height: 560});
    await popup.goto(popupUrl, {waitUntil: 'domcontentloaded', timeout: args.timeout});
    await popup.locator('.popup-startup').waitFor({state: 'visible', timeout: args.timeout});
    await popup.screenshot({path: path.join(args.artifactsDir, 'startup.png')});
    await popup.locator('.popup-shell[data-config-ready="true"]').waitFor({state: 'visible', timeout: args.timeout});
    await poll('single-screen bilingual title',()=>popup.evaluate(()=>Boolean(document.querySelector('#language-onboarding-title small')?.textContent.trim())));
    await popup.waitForTimeout(450);
    report.startup = await popup.evaluate(() => {
      globalThis.__onboardingStartup.stopped = true;
      return globalThis.__onboardingStartup;
    });
    {
      assert.ok(report.startup.configDelays > 0, 'Slow configuration hook did not run');
      assert.equal(report.startup.englishDelays, 0, 'Single-screen selection unnecessarily loaded the complete English bundle');
      const frames = report.startup.frames;
      assert.ok(frames.some(frame => frame.phase === 'startup') && frames.some(frame => frame.phase === 'language'));
      assert.ok(frames.every(frame => frame.phase === 'startup' ? frame.height >= 400 && frame.height <= 560 : frame.height >= 300 && frame.height <= 430), `Unexpected startup/compact height: ${JSON.stringify(frames)}`);
      assert.equal(frames.some(frame => frame.textOnlyBrand), false, 'Text-only brand flash');
      const languageFrames = frames.filter(frame => frame.phase === 'language');
      assert.ok(languageFrames.every(frame => frame.englishReady), 'English title missing from initial selection frame');
      assert.ok(languageFrames.every(frame => frame.cardTransform === 'none'), 'Language card scaled on entry');
      assert.ok(Math.max(...languageFrames.map(frame=>frame.height))-Math.min(...languageFrames.map(frame=>frame.height))<=1,'Single-screen height unstable while idle');
    }
    await popup.setViewportSize({width: 400, height: 130});
    assert.equal(await popup.locator('[data-testid="onboarding-language-next"], .onboarding-back, .onboarding-success').count(),0,'Removed steps must not return');
    await inspect(popup, 'language', '.language-onboarding-card', 'language.png');
    for (const width of [280, 320, 360, 400]) await inspectLanguages(popup, width, false);
    await inspectLanguages(popup, 320, true);
    await popup.evaluate(() => document.documentElement.classList.remove('dark'));
    for (const language of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES']) {
      await popup.locator(`[data-language="${language}"]`).click();
      assert.equal(await popup.locator('[role="radio"][aria-checked="true"]').count(), 1);
      assert.equal(await popup.locator(`[data-language="${language}"]`).getAttribute('aria-checked'), 'true');
    }
    await popup.locator('[data-language="es-ES"][aria-checked="true"]').waitFor();
    const confirmLanguage = args.confirmLanguage || 'zh-CN';
    await popup.locator(`[data-language="${confirmLanguage}"]`).click();
    await popup.setViewportSize({width: 400, height: 130});
    await popup.locator('.onboarding-form .onboarding-confirm').click();
    await poll('real native language save receipt held',()=>popup.evaluate(()=>globalThis.__onboardingStartup.saveReceipts.some(event=>event.nativeSuccess&&!event.delivered)));
    assert.ok(await popup.locator('.onboarding-language-option, .onboarding-confirm').evaluateAll(nodes=>nodes.every(node=>node.disabled)),'Save pending controls must be disabled');
    await inspect(popup,'save-pending','.language-onboarding-card','save-pending.png');
    await popup.evaluate(()=>window.__releaseHeightSave());
    if (args.failMainOnce) {
      await popup.locator('.onboarding-load-error').waitFor();
      assert.equal(abortedMainModules, 1);
      await inspect(popup,'main-error','.onboarding-load-error','main-error.png');
      const saved=await popup.evaluate(async()=>((await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'})).value));
      assert.equal(saved.uiLanguage,confirmLanguage);assert.equal(saved.uiLanguageSetupCompleted,true);
      const navigation=popup.waitForNavigation({waitUntil:'domcontentloaded'}).then(()=>({ok:true}),error=>({error:String(error)}));
      await popup.locator('.onboarding-load-error button').click();const reopened=await navigation;assert.equal(reopened.ok,true,reopened.error);
      await popup.locator('.popup-content:visible').waitFor();
      report.moduleFailureRetried = true;
    }
    await popup.locator('[data-testid="ui-language-onboarding"]').waitFor({state: 'detached', timeout: args.timeout});
    await inspect(popup, 'main', '.popup-content', 'main.png');
    await popup.close();
    const reopened = await newPageWithoutForeground(context, args.timeout);
    await reopened.setViewportSize({width: 400, height: 560});
    await reopened.goto(popupUrl, {waitUntil: 'domcontentloaded', timeout: args.timeout});
    await reopened.locator('.popup-shell[data-config-ready="true"]').waitFor();
    assert.equal(await reopened.locator('[data-testid="ui-language-onboarding"]').count(), 0, 'Confirmation not persisted after reopening');
    await reopened.waitForFunction(language => document.documentElement.lang === language, confirmLanguage);
    await reopened.locator('.popup-shell').screenshot({path:path.join(args.artifactsDir,'reopened.png')});
    report.confirmedLanguage = confirmLanguage;
    report.confirmationPersisted = true;
    assert.deepEqual(report.errors, [], `Popup console errors: ${report.errors.join('; ')}`);
    report.passed = true;
  } catch (error) {
    primaryError = error;
    report.passed = false;
    report.errors.push(error.stack || String(error));
    if(session)for(const [index,page]of session.context.pages().entries())try {await page.screenshot({path:path.join(args.artifactsDir,`failure-${index}.png`)});}catch {}
    throw error;
  } finally {
    const cleanupErrors = [];
    const cleanup = async (resource, release) => {
      try {await release();} catch (error) {
        cleanupErrors.push(error);
        (report.cleanupErrors ||= []).push({resource, error: String(error.stack || error)});
        report.passed = false;
        if (resource === 'profile') report.retainedProfile = profileDir;
      }
    };
    let browserClosed = false;
    await cleanup('browser', async () => {
      if (session) {await session.close(); browserClosed = true;}
      report.cleanupConfirmed=browserClosed;
    });
    await cleanup('profile', () => {
      if (browserClosed) fs.rmSync(profileDir, {recursive: true, force: true});
      else report.retainedProfile = profileDir;
      report.profileRemoved=!fs.existsSync(profileDir);
    });
    await cleanup('report', () => {fs.writeFileSync(path.join(args.artifactsDir, 'report.json'), JSON.stringify(report, null, 2));});
    if (report.retainedProfile) process.stderr.write(`Unconfirmed browser/profile cleanup; retained profile: ${profileDir}\n`);
    for (const error of cleanupErrors) process.stderr.write(`Cleanup failed: ${error.stack || error}\n`);
    if (cleanupErrors.length && !primaryError) throw cleanupErrors[0];
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
