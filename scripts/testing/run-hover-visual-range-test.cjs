#!/usr/bin/env node
'use strict';

// 隔离后台 Edge 中用真实 Control 手势验证悬浮局部窗口、连续触发、原文恢复和重新翻译。
// 使用本地确定性 Microsoft transport；不连接日常 profile，不验证实时服务质量。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {startTranslationFixtureServer, installTranslationFixtureOnWorker} = require('../run-full-page-translation-test.cjs');
const {guardBrowserClose, getGuardedBrowserPid} = require('./owned-browser-close.cjs');
const arg = (name, fallback) => {const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1];};
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-hover-window'));
const baseline = process.argv.includes('--baseline');
const profileCPU = process.argv.includes('--cpu-profile');
const gestureLifecycle = process.argv.includes('--gesture-lifecycle');
const gestureOnly = process.argv.includes('--gesture-only');
if(gestureOnly && !gestureLifecycle)throw new Error('--gesture-only requires --gesture-lifecycle');
const lifecycleBoundary = arg('lifecycle-boundary', 'all');
assert.ok(['all', 'route', 'visibility'].includes(lifecycleBoundary), 'Lifecycle boundary must be all, route or visibility');
const hoverSweep = process.argv.includes('--hover-sweep');
const sweepOnly = process.argv.includes('--sweep-only');
if(sweepOnly && !hoverSweep)throw new Error('--sweep-only requires --hover-sweep');
const nestedViewport = process.argv.includes('--nested-viewport');
const nestedOnly = process.argv.includes('--nested-only');
if(nestedOnly && !nestedViewport)throw new Error('--nested-only requires --nested-viewport');
const notificationFailure = process.argv.includes('--notification-failure');
if(notificationFailure && !nestedViewport)throw new Error('--notification-failure requires --nested-viewport');
const nestedCycles = Number(arg('nested-cycles','5'));
assert.ok(Number.isInteger(nestedCycles) && nestedCycles>0 && nestedCycles<=20,'Nested cycles must be an integer from 1 to 20');
const nestedScale = Number(arg('nested-scale','1'));
assert.ok(Number.isFinite(nestedScale) && nestedScale>=0.25 && nestedScale<=2,'Nested scale must be from 0.25 to 2');
const cpuSessions = new WeakMap();
const metricSessions = new WeakMap();
const {chromium} = require(path.join(arg('playwright-root', path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules')), 'playwright'));
// 连接临时浏览器时保留原生 tab 可见性，不启用 Playwright 默认的 focus/media 覆盖。
const nativeContextChromium = {
  connectOverCDP: (endpoint, options) => chromium.connectOverCDP(endpoint, {...options, noDefaults: true}),
  launchPersistentContext: (...args) => chromium.launchPersistentContext(...args),
};
const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground, queryMacFrontmostApplication} = require(arg('focus-safe-helper', path.join(__dirname, 'focus-safe-browser.cjs')));
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-hover-window-'));
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const cases = [
  {id:'giant-tail', value:'Earlier sentence supplies ordinary readable context. '.repeat(2400) + 'Tailmarker keeps the hovered reading position and nearby context. '.repeat(120), marker:'Tailmarker'},
  {id:'empty-nodes', value:'Readable sentence keeps the nearby reading context. '.repeat(120), offset:2000, emptyNodes:20000},
  {id:'long-token', value:'a'.repeat(2500) + ' Nearby context preserves the hovered word and source. '.repeat(120), offset:500},
];
const html = '<!doctype html><meta charset="utf-8"><title>Hover range fixture</title><style>body{font:16px/1.7 system-ui;margin:40px}#target{max-width:740px;overflow-wrap:anywhere}#probe{position:fixed;right:20px;top:20px;z-index:100000}</style><button id="probe" translate="no">Host click</button><main><div id="target"></div></main><script>window.probeClicks=0;document.querySelector("#probe").onclick=()=>window.probeClicks++;</script>';
const server = http.createServer((_request, response) => {response.writeHead(200, {'content-type':'text/html;charset=utf-8'}); response.end(html);});
const report = {baseline, profileCPU, gestureLifecycle, hoverSweep, nestedViewport, evidence:'Production extension; local deterministic transport, temporary background-visible Edge',
  cdpDefaults:'noDefaults:true; native focus, tab visibility and media',
  buildSha256:sha256(path.join(extensionDir,'content-scripts/content.js')),
  cachePolicy:'Microsoft hover disables persistent cache; active requests and brief remount grace reuse work',
  cases:[], consoleErrors:[]};
fs.mkdirSync(artifactsDir,{recursive:true});

async function startPhase(page, measureMetrics = false) {
  if(measureMetrics) {
    const session=await page.context().newCDPSession(page);
    try {
      await session.send('Performance.enable');
      const before=Object.fromEntries((await session.send('Performance.getMetrics')).metrics.map(metric=>[metric.name,metric.value]));
      metricSessions.set(page,{session,before});
    } catch(error) {await session.detach();throw error;}
  }
  if(profileCPU) {
    const session=await page.context().newCDPSession(page);
    await session.send('Profiler.enable');
    await session.send('Profiler.setSamplingInterval',{interval:1000});
    await session.send('Profiler.start');
    cpuSessions.set(page,session);
  }
  await page.evaluate(() => {
    window.__hoverTasks=[]; window.__hoverTicks=[];
    window.__hoverObserver=new PerformanceObserver(list=>window.__hoverTasks.push(...list.getEntries().map(entry=>entry.duration)));
    window.__hoverObserver.observe({type:'longtask',buffered:false});
    let previous=performance.now();
    window.__hoverTimer=setInterval(()=>{const now=performance.now();window.__hoverTicks.push(now-previous);previous=now;},20);
  });
}

async function finishPhase(page, name) {
  const result=await page.evaluate(name=>{
    window.__hoverObserver.disconnect(); clearInterval(window.__hoverTimer);
    return {name, longTasksMs:window.__hoverTasks, maxHeartbeatGapMs:Math.max(0,...window.__hoverTicks)};
  },name);
  const metrics=metricSessions.get(page);
  if(metrics) {
    try {
      const after=Object.fromEntries((await metrics.session.send('Performance.getMetrics')).metrics.map(metric=>[metric.name,metric.value]));
      result.metrics=Object.fromEntries(['ScriptDuration','TaskDuration','LayoutDuration','RecalcStyleDuration'].map(key=>{
        const delta=(after[key]-metrics.before[key])*1000;
        assert.ok(Number.isFinite(delta) && delta>=0,`${name}: finite monotonic ${key}`);
        return [`${key}Ms`,delta];
      }));
      result.metrics.LayoutCount=after.LayoutCount-metrics.before.LayoutCount;
      result.metrics.RecalcStyleCount=after.RecalcStyleCount-metrics.before.RecalcStyleCount;
    } finally {await metrics.session.detach();metricSessions.delete(page);}
  }
  const session=cpuSessions.get(page);
  if(session) {
    const {profile}=await session.send('Profiler.stop');
    const fixtureId=new URL(page.url()).pathname.slice(1);
    fs.writeFileSync(path.join(artifactsDir,fixtureId+'-'+name+'.cpuprofile'),JSON.stringify(profile));
    await session.detach();cpuSessions.delete(page);
    result.cpuProfileSaved=true;
  }
  return result;
}

async function sourcePoint(page, offset) {
  return page.evaluate(offset=>{
    const owner=document.getElementById('target');
    const walker=document.createTreeWalker(owner,4);
    let node, remaining=offset;
    while ((node=walker.nextNode())) {
      if(node.parentElement.closest('[data-fr-translation-owned="true"]'))continue;
      if(remaining>=node.length){remaining-=node.length;continue;}
      const range=document.createRange();range.setStart(node,remaining);range.setEnd(node,remaining+1);
      let rect=range.getBoundingClientRect();window.scrollBy(0,rect.top-innerHeight*0.45);
      rect=range.getBoundingClientRect();return {x:rect.left+Math.min(3,rect.width/2),y:rect.top+Math.min(8,rect.height/2),top:rect.top};
    }
    throw new Error('Source offset unavailable');
  },offset);
}

async function gesture(page, offset) {
  const point=await sourcePoint(page,offset);
  await page.mouse.move(0,0); await page.mouse.move(point.x,point.y,{steps:4});
  await page.waitForTimeout(50);
  await page.keyboard.down('Control'); await page.keyboard.up('Control');
}

async function originalSource(page) {
  return page.evaluate(()=>{
    const clone=document.getElementById('target').cloneNode(true);
    clone.querySelectorAll('[data-fr-translation-owned="true"]').forEach(node=>node.remove());
    return clone.textContent;
  });
}

let configurationSequence = 0;
async function patchFixtureConfig(setup, patch) {
  const sequence = ++configurationSequence;
  await setup.evaluate(async({patch,sequence})=>{
    const current=await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});
    const saved=await chrome.runtime.sendMessage({type:'persistConfig',mode:'patch',config:patch,
      expected:Object.fromEntries(Object.keys(patch).map(key=>[key,current.value[key]])),
      clientId:'hover-window-fixture',sequence,baseRevision:current.value.__fluentConfigRevision||0});
    if(!saved?.success)throw new Error('Fixture configuration failed');
  },{patch,sequence});
}

/** Compare lifecycle cancellation with real input and browser visibility, retaining native geometry. */
async function runHoverLifecycleCancellation(context, setup, provider, port, result, browserPid) {
  const delayMs = 1200;
  const value = 'This ordinary paragraph keeps its source and the selected shortcut after a real route or visibility boundary.';
  const profiles = [
    {id: 'default', shortcut: 'Control', keys: ['Control'], quickTranslationProfiles: []},
    {id: 'quick', shortcut: 'Control+Shift+Y', keys: ['Control', 'Shift', 'y'], quickTranslationProfiles: [{
      id: 'hover-lifecycle', enabled: true, action: 'hover', hotkey: 'Ctrl+Shift+Y',
      service: 'microsoft', model: '', targetLanguage: 'zh-Hans', displayMode: 'bilingual', fullPageMode: 'inherit',
    }]},
  ];
  result.lifecycleCancellation = [];
  for (const profile of profiles) {
    for (const boundary of lifecycleBoundary === 'all' ? ['route', 'visibility'] : [lifecycleBoundary]) {
      await patchFixtureConfig(setup, {on: true, hotkey: 'Control', mouseHoverTranslationDelay: delayMs,
        quickTranslationProfiles: profile.quickTranslationProfiles});
      const page = await newPageWithoutForeground(context);
      page.on('pageerror', error => report.consoleErrors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/lifecycle-${profile.id}-${boundary}`, {waitUntil: 'domcontentloaded'});
      await page.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
      await page.evaluate(value => {
        document.getElementById('target').textContent = value;
        window.__hoverLifecycleEvents = [];
        const record = event => window.__hoverLifecycleEvents.push({type: event.type, trusted: event.isTrusted,
          visibility: document.visibilityState, href: location.href, at: performance.now()});
        document.addEventListener('visibilitychange', record);
        document.addEventListener('fluentread-route-change', record);
        document.addEventListener('mousemove', record, {capture: true});
        window.addEventListener('keydown', record, {capture: true});
      }, value);
      const entry = {profile: profile.id, shortcut: profile.shortcut, boundary, delayMs, phases: []};
      result.lifecycleCancellation.push(entry);
      let companion;
      if (boundary === 'visibility') {
        entry.nativeTabVisibility = true;
        companion = await newPageWithoutForeground(context);
        await companion.goto(`${setup.url()}?lifecycle=${profile.id}`);
        const companionId = await companion.evaluate(async () => {
          const tab = await chrome.tabs.getCurrent();
          if (typeof tab?.id !== 'number') throw new Error('Lifecycle companion unavailable');
          return tab.id;
        });
        entry.windows = await setup.evaluate(async ({targetUrl, companionId}) => {
          const tabs = await chrome.tabs.query({});
          const target = tabs.find(tab => tab.url === targetUrl || tab.pendingUrl === targetUrl);
          if (typeof target?.id !== 'number') throw new Error('Lifecycle target unavailable');
          const other = await chrome.tabs.get(companionId);
          await chrome.tabs.move(other.id, {windowId: target.windowId, index: -1});
          const moved = await chrome.tabs.get(other.id);
          return {target: target.windowId, targetTabId: target.id, companionTabId: other.id,
            companionBefore: other.windowId, companionAfter: moved.windowId};
        }, {targetUrl: page.url(), companionId});
        assert.equal(entry.windows.companionAfter, entry.windows.target, 'Visibility switch must use two tabs in the same window');
        const frontmost = await queryMacFrontmostApplication();
        assert.ok(frontmost && frontmost.pid !== browserPid, 'Moving the temporary companion must preserve OS foreground focus');
        entry.companionMovePreservedFocus = true;
      }
      await activateExtensionTabWithoutForeground(context, page);
      await page.waitForFunction(() => document.visibilityState === 'visible');
      await page.waitForTimeout(500);
      await page.evaluate(() => {window.__hoverLifecycleEvents = [];});
      const point = await sourcePoint(page, 25);
      await page.mouse.move(point.x, point.y);
      const before = provider.requestCount();
      await startPhase(page);
      for (const key of profile.keys) await page.keyboard.down(key);
      const queued = Date.now();
      try {
        await page.mouse.move(point.x + 1, point.y);
        entry.urlBefore = page.url();
        if (boundary === 'route') {
          await page.evaluate(() => history.pushState({fixture: true}, '', `${location.pathname}-next`));
          await page.waitForFunction(() => window.__hoverLifecycleEvents.some(event => event.type === 'fluentread-route-change'));
          entry.urlAfter = page.url();
          assert.notEqual(entry.urlAfter, entry.urlBefore, 'History boundary must actually change the page route');
        } else {
          await activateExtensionTabWithoutForeground(context, companion);
          await page.waitForFunction(() => document.visibilityState === 'hidden', undefined, {polling: 50, timeout: 5000});
          entry.tabSwitch = await setup.evaluate(async ({targetTabId, companionTabId}) => {
            const target = await chrome.tabs.get(targetTabId), companion = await chrome.tabs.get(companionTabId);
            return {targetActive: target.active, companionActive: companion.active};
          }, entry.windows);
          assert.equal(entry.tabSwitch.targetActive, false);
          assert.equal(entry.tabSwitch.companionActive, true);
        }
        entry.boundaryDispatchMs = Date.now() - queued;
        assert.ok(entry.boundaryDispatchMs < delayMs, `${profile.id}/${boundary}: boundary must precede the pending deadline`);
        await page.waitForTimeout(delayMs + 100);
        entry.requestsAfterBoundary = provider.requestCount() - before;
        entry.events = await page.evaluate(() => window.__hoverLifecycleEvents);
        assert.equal(entry.requestsAfterBoundary, 0, `${profile.id}/${boundary}: cancelled pending work must not call upstream`);
        assert.equal(await page.locator('#target .fluent-read-bilingual-content').count(), 0);
        if (boundary === 'visibility') {
          await activateExtensionTabWithoutForeground(context, page);
          await page.waitForFunction(() => document.visibilityState === 'visible');
        }
        // No fresh keydown occurred: an old held combination must not be revived by another mousemove.
        await page.mouse.move(point.x + 2, point.y);
        await page.waitForTimeout(delayMs + 100);
        assert.equal(provider.requestCount(), before, `${profile.id}/${boundary}: stale held keys must remain cancelled`);
      } finally {
        for (const key of [...profile.keys].reverse()) await page.keyboard.up(key);
      }
      entry.phases.push(await finishPhase(page, `${profile.id}-${boundary}-cancel`));
      entry.requestsAfterBoundary = provider.requestCount() - before;
      entry.events = await page.evaluate(() => window.__hoverLifecycleEvents);
      assert.ok(entry.events.some(event => event.type === 'keydown' && event.trusted), 'Input must use trusted browser keys');
      assert.ok(entry.events.some(event => event.type === 'mousemove' && event.trusted), 'Input must use trusted browser mouse events');
      if (boundary === 'visibility') assert.ok(entry.events.some(event =>
        event.type === 'visibilitychange' && event.trusted && event.visibility === 'hidden'), 'Visibility must come from a real tab switch');
      assert.equal(await originalSource(page), value);
      await patchFixtureConfig(setup, {mouseHoverTranslationDelay: 0});
      await page.waitForTimeout(100);
      entry.counts = [];
      entry.settledGestureGapMs = 300;
      for (const count of [1, 0, 1]) {
        const currentPoint = await sourcePoint(page, 25);
        await page.mouse.move(0, 0); await page.mouse.move(currentPoint.x, currentPoint.y, {steps: 4});
        await page.keyboard.press(profile.shortcut);
        await page.waitForFunction(count => {
          const wrappers = [...document.querySelectorAll('#target .fluent-read-bilingual-content')];
          return wrappers.length === count && wrappers.every(wrapper => /[\u3400-\u9fff]/u.test(wrapper.textContent));
        }, count, {timeout: 15000});
        entry.counts.push(await page.locator('#target .fluent-read-bilingual-content').count());
        assert.equal(await page.locator('#target .fluent-read-bilingual-content .fluent-read-bilingual-content').count(), 0);
        assert.equal(await originalSource(page), value);
        // 已结算 hover 请求保留短暂重挂宽限；明确的新手势在宽限结束后验证再次请求。
        await page.waitForTimeout(entry.settledGestureGapMs);
      }
      assert.deepEqual(entry.counts, [1, 0, 1]);
      entry.freshGestureRequests = provider.requestCount() - before;
      assert.equal(entry.freshGestureRequests, 2, 'Fresh default and quick gestures each translate once after restore');
      await page.screenshot({path: path.join(artifactsDir, `lifecycle-${profile.id}-${boundary}.png`)});
      entry.originalPreserved = true; entry.staleGestureCancelled = true; entry.freshGesturePreserved = true;
      await companion?.close();
      await page.close();
    }
  }
}

/** 跨两个真实候选比较词库开销；新候选重排停留与快照，排除翻译网络和译文布局。 */
async function runHoverSweep(context, setup, provider, port) {
  const delayMs = 300, moves = 120;
  const values = [
    'Alpha ordinary paragraph keeps native geometry while the reader moves to a different translation candidate.',
    'Beta ordinary paragraph starts a fresh dwell and snapshot when the reader moves back from the other candidate.',
  ];
  const value = values.join('');
  const libraries = Array.from({length: 10}, (_, library) => ({
    id: `sweep-${library}`, name: `Sweep fixture ${library}`, enabled: true,
    sourceLanguage: '', targetLanguage: '', domains: [],
    entries: Array.from({length: 500}, (_, entry) => ({
      id: `term-${entry}`, source: `fixture-term-${library}-${entry}`,
      target: `夹具词条-${library}-${entry}`, caseSensitive: false,
    })),
  }));
  report.sweep = {moves, delayMs, repetitions: 3, candidateCount: 2, workload: 'cross-candidate', samples: [],
    method: 'Trusted CDP moves alternate two native paragraph owners; synchronous capture-to-bubble plus full-phase CDP metrics including animation-frame work; no upstream translation',
    snapshotPolicy: 'Entering a different delivered candidate captures a new snapshot; animation-frame coalescing may deliver fewer candidate changes than input events'};
  for (const librarySet of [{id: 'empty', libraries: []}, {id: '5000-terms', libraries}]) {
    await patchFixtureConfig(setup, {on: true, hotkey: 'Control', mouseHoverTranslationDelay: delayMs,
      quickTranslationProfiles: [], glossaryEnabled: true, glossaryLibraries: librarySet.libraries});
    const entries = await setup.evaluate(async () => {
      const current = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      return current.value.glossaryLibraries.reduce((count, library) => count + library.entries.length, 0);
    });
    assert.equal(entries, librarySet.libraries.length * 500, 'Stored glossary must retain every fixture term');
    const page = await newPageWithoutForeground(context);
    page.on('pageerror', error => report.consoleErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/hover-sweep-${librarySet.id}`, {waitUntil: 'domcontentloaded'});
    await page.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
    await page.evaluate(values => {
      document.getElementById('target').replaceChildren(...values.map((value,index)=>{
        const paragraph=document.createElement('p');paragraph.textContent=value;
        paragraph.dataset.hoverSweepOwner=String(index);return paragraph;
      }));
      window.__sweepEvents = [];
      let started;
      window.addEventListener('mousemove', () => {started = performance.now();}, {capture: true});
      window.addEventListener('mousemove', event => window.__sweepEvents.push({
        at: started, durationMs: performance.now() - started, trusted: event.isTrusted, control: event.ctrlKey,
        owner: event.target.closest('[data-hover-sweep-owner]')?.dataset.hoverSweepOwner,
      }));
    }, values);
    await activateExtensionTabWithoutForeground(context, page);
    await page.waitForTimeout(500);
    const points = [await sourcePoint(page,25),await sourcePoint(page,values[0].length+25)];
    assert.notEqual(points[0].y,points[1].y,'Sweep must cross two distinct native paragraph geometries');
    // A warm-up plus three measured repetitions share this exact page and native source geometry.
    for (let repetition = -1; repetition < 3; repetition += 1) {
      await patchFixtureConfig(setup, {on: true});
      await page.waitForTimeout(100);
      await page.mouse.move(points[0].x, points[0].y);
      await page.evaluate(() => {window.__sweepEvents = [];});
      const before = provider.requestCount();
      await startPhase(page,true);
      await page.keyboard.down('Control');
      const started = performance.now();
      try {
        for (let move = 0; move < moves; move += 1) {
          const point=points[move%2];await page.mouse.move(point.x,point.y);
        }
      } finally {
        // An extra trusted key cancels pending work immediately without rewriting a large glossary.
        await page.keyboard.down('Shift'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
      }
      const dispatchMs = performance.now() - started;
      const events = await page.evaluate(() => window.__sweepEvents);
      const phase = await finishPhase(page, `${librarySet.id}-sweep-${repetition < 0 ? 'warmup' : repetition}`);
      await page.waitForTimeout(delayMs + 50);
      assert.equal(events.length, moves, 'Every measured move must reach native document propagation');
      assert.ok(events.every(event => event.trusted && event.control), 'Every measured move must hold the trusted shortcut');
      assert.ok(events.every((event,index)=>event.owner===String(index%2)), 'Every trusted move must alternate the actual native candidate owner');
      assert.equal(provider.requestCount(), before, 'Sweep must exercise pending scheduling without upstream work');
      assert.equal(await page.locator('#target .fluent-read-bilingual-content').count(), 0);
      assert.equal(await originalSource(page), value);
      if (repetition >= 0) report.sweep.samples.push({library: librarySet.id, entries, repetition, dispatchMs,
        maxInterMoveGapMs:Math.max(0,...events.slice(1).map((event,index)=>event.at-events[index].at)),
        eventDurationsMs: events.map(event => event.durationMs), requests: 0, phase});
    }
    await page.close();
  }
  await patchFixtureConfig(setup, {on: true, mouseHoverTranslationDelay: 0, glossaryEnabled: false, glossaryLibraries: []});
}

async function injectNotificationFailure(context, page, setup, worker) {
  const session=await context.newCDPSession(page), worlds=[];
  session.on('Runtime.executionContextCreated',({context})=>worlds.push(context));
  await session.send('Runtime.enable');
  const extensionId=new URL(setup.url()).host;
  let worldId;
  for(const world of worlds.filter(world=>world.auxData?.isDefault===false)) {
    const candidate=await session.send('Runtime.evaluate',{contextId:world.id,returnByValue:true,
      expression:'typeof chrome !== "undefined" && chrome.runtime ? chrome.runtime.id : null'});
    if(candidate.result.value===extensionId){worldId=world.id;break;}
  }
  assert.ok(worldId,'Failure injection must target the extension isolated world');
  const injected=await session.send('Runtime.evaluate',{contextId:worldId,returnByValue:true,expression:`(() => {
    const dispatch=document.dispatchEvent;
    window.__frAuditNotificationFailures=[];
    document.dispatchEvent=function(event) {
      if(event.type==='fluentread-translation-started'||event.type==='fluentread-translation-ended') {
        window.__frAuditNotificationFailures.push(event.type);
        throw new Error('Fixture document notification unavailable');
      }
      return Reflect.apply(dispatch,this,[event]);
    };
    return true;
  })()`});
  assert.equal(injected.result.value,true);
  report.notificationFailure={realm:'extension-isolated-world',phases:[]};
  return {
    async snapshot(name) {
      const state=await setup.evaluate(async url=>{
        const tab=(await chrome.tabs.query({})).find(tab=>tab.url===url);
        if(typeof tab?.id!=='number')throw new Error('Fixture tab unavailable');
        return {content:await chrome.tabs.sendMessage(tab.id,{type:'getFullPageTranslationState'}),
          badge:await chrome.action.getBadgeText({tabId:tab.id})};
      },page.url());
      const failures=await session.send('Runtime.evaluate',{contextId:worldId,returnByValue:true,
        expression:'window.__frAuditNotificationFailures.length'});
      const messages=await worker.evaluate(()=>globalThis.__frAuditStateMessages);
      const snapshot={name,...state,injectedFailures:failures.result.value,messages};
      report.notificationFailure.phases.push(snapshot);
      return snapshot;
    },
    close:()=>session.detach(),
  };
}

async function runNestedViewport(context, setup, provider, port, worker) {
  await patchFixtureConfig(setup,{hotkey:'Control',floatingBallHotkey:'Alt+T',fullPageTranslationMode:'all',
    mouseHoverTranslationDelay:0,useCache:true,quickTranslationProfiles:[]},6);
  const page=await newPageWithoutForeground(context);
  page.on('pageerror',error=>report.consoleErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/nested-viewport`,{waitUntil:'domcontentloaded'});
  await page.locator('#fluent-read-page-styles').waitFor({state:'attached'});
  const value='This paragraph above the reading position gains a bilingual translation while its scroll container keeps the reader steady. '.repeat(8);
  await page.evaluate(({value,nestedScale})=>{
    const target=document.getElementById('target');
    target.innerHTML='<div id="scroller" style="height:650px;overflow-y:auto;overflow-anchor:none;border:3px solid #555">'+
      '<p id="above"></p><div id="reading-gap" translate="no" style="height:500px"></div>'+
      '<p id="reading" translate="no" style="height:100px;margin:0">Stable reading anchor</p>'+
      '<p id="visible">This visible paragraph translates without compensating content below the reading anchor.</p>'+
      '<div translate="no" style="height:700px"></div></div>';
    document.getElementById('above').textContent=value;
    const scroller=document.getElementById('scroller'),reading=document.getElementById('reading');
    if(nestedScale!==1){scroller.style.transform=`scale(${nestedScale})`;scroller.style.transformOrigin='top left';}
    const readingTarget=nestedScale<0.6?scroller.getBoundingClientRect().top+nestedScale*scroller.clientHeight*0.65:420;
    scroller.scrollTop=(reading.getBoundingClientRect().top-readingTarget)/nestedScale;
    window.scrollTo(0,0);
  },{value,nestedScale});
  await activateExtensionTabWithoutForeground(context,page);await page.waitForTimeout(500);
  const notifications=notificationFailure?await injectNotificationFailure(context,page,setup,worker):null;
  const result={cycles:nestedCycles,scale:nestedScale,phases:[]};report.nestedViewportChecks=result;
  const requestStart=provider.requestCount();
  const before=await page.evaluate(()=>({top:document.getElementById('reading').getBoundingClientRect().top,
    scrollTop:document.getElementById('scroller').scrollTop,windowY:scrollY,
    aboveBottom:document.getElementById('above').getBoundingClientRect().bottom,
    viewportTop:document.getElementById('scroller').getBoundingClientRect().top+document.getElementById('scroller').clientTop}));
  result.initialScrollTop=before.scrollTop;
  assert.ok(before.scrollTop>0 && before.aboveBottom<before.viewportTop,'Fixture change must be entirely above the nested viewport');
  const phases=Array.from({length:nestedCycles},(_unused,index)=>
    index===0?['translate','restore']:['retranslate-'+index,'restore-'+index]).flat();
  for(const name of phases) {
    const translate=name==='translate'||name.startsWith('retranslate-');
    const readBefore=await page.evaluate(()=>{
      const scroller=document.getElementById('scroller'),top=scroller.getBoundingClientRect().top+scroller.clientTop;
      return {scrollTop:scroller.scrollTop,readingRelativeTop:document.getElementById('reading').getBoundingClientRect().top-top,
        gapRelativeTop:document.getElementById('reading-gap').getBoundingClientRect().top-top,
        sourceHeight:document.getElementById('above').getBoundingClientRect().height};
    });
    await page.evaluate(top=>{
      window.__readingSamples=[];window.__readingActive=true;window.__readingReference=top;
      const sample=()=>{if(!window.__readingActive)return;
        window.__readingSamples.push({shift:document.getElementById('reading').getBoundingClientRect().top-top,windowY:scrollY});
        window.__readingFrame=requestAnimationFrame(sample);};window.__readingFrame=requestAnimationFrame(sample);
    },before.top);
    await startPhase(page);await page.keyboard.press('Alt+t');
    await page.waitForFunction(translate=>{
      const count=document.querySelectorAll('#target .fluent-read-bilingual-content').length;
      return translate?count===2:count===0;
    },translate,{timeout:15000});
    await page.waitForTimeout(500);
    const reading=await page.evaluate(()=>{
      window.__readingActive=false;cancelAnimationFrame(window.__readingFrame);
      return {maxReadingShiftPx:Math.max(0,...window.__readingSamples.map(s=>Math.abs(s.shift))),
        maxDocumentScrollPx:Math.max(0,...window.__readingSamples.map(s=>Math.abs(s.windowY))),
        samples:window.__readingSamples.length,scrollTop:document.getElementById('scroller').scrollTop,
        readingRelativeTop:document.getElementById('reading').getBoundingClientRect().top-
          document.getElementById('scroller').getBoundingClientRect().top-document.getElementById('scroller').clientTop,
        gapRelativeTop:document.getElementById('reading-gap').getBoundingClientRect().top-
          document.getElementById('scroller').getBoundingClientRect().top-document.getElementById('scroller').clientTop,
        sourceHeight:document.getElementById('above').getBoundingClientRect().height};
    });
    const phase={...(await finishPhase(page,name)),readBefore,...reading};
    result.phases.push(phase);
    await page.screenshot({path:path.join(artifactsDir,'nested-viewport-'+name+'.png')});
    assert.ok(reading.samples>0,'Reading-position sampling ran');
    assert.ok(reading.maxReadingShiftPx<=0.5,`Nested reading anchor moved during ${name}`);
    assert.equal(reading.maxDocumentScrollPx,0,'Nested compensation must not scroll the document');
    assert.equal(await page.locator('#target .fluent-read-bilingual-content .fluent-read-bilingual-content').count(),0);
    const original=await page.evaluate(()=>{
      const node=document.getElementById('above'),walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);
      let source='',text;while((text=walker.nextNode()))if(!text.parentElement.closest('.fluent-read-bilingual-content,[data-fr-translation-owned="true"]'))source+=text.data;
      return source;
    });
    assert.equal(original,value,'Above-viewport source remains exact');
    if(translate)assert.ok(Math.abs(reading.scrollTop-before.scrollTop)>1,'Nested scroll offset actually compensates added translation height');
    else assert.ok(Math.abs(reading.scrollTop-before.scrollTop)<=0.5,'Restore returns the original nested offset');
    if(notifications) {
      const snapshot=await notifications.snapshot(name);
      assert.equal(snapshot.content.isTranslated,translate,'Content session matches the gesture despite document failure');
      assert.equal(snapshot.content.toolbarStatus,translate?'translated':'idle');
      assert.equal(snapshot.badge,translate?'✓':'','Native toolbar matches the content session despite document failure');
      assert.equal(snapshot.injectedFailures,result.phases.length,'Each lifecycle notification actually failed in the extension realm');
    }
    if(name==='translate')result.initialRequests=provider.requestCount()-requestStart;
  }
  result.requests=provider.requestCount()-requestStart;
  assert.equal(result.requests,result.initialRequests,'Full-page retranslation reuses settled results');
  result.originalPreserved=true;result.readingPositionPreserved=true;result.restoreAndRetranslate=true;
  await notifications?.close();
  await page.close();
}

(async()=>{
  let launched,provider;
  let launchAttempted = false, browserGuarded = false, hasPrimaryError = false;
  try {
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});
    });
    provider=await startTranslationFixtureServer([],5);
    launchAttempted = true;
    launched=await launchFocusSafePersistentContext({chromium:nativeContextChromium,profileDir,
      browserPath:arg('browser-path','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      headless:false,background:true,viewport:{width:1280,height:900},
      browserArgs:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`,'--no-first-run','--no-default-browser-check']});
    guardBrowserClose(launched,profileDir);
    browserGuarded = true;
    const {context}=launched;
    report.launchMode=launched.launchMode;report.focusPolicy=launched.focusPolicy;
    report.windowPlacement=Object.fromEntries(['mode','visible','hidden','windowState','displayTarget','browserFrontmost'].map(key=>[key,launched.windowPlacement?.[key]]));
    const worker=context.serviceWorkers().find(worker=>worker.url().startsWith('chrome-extension://')) || await context.waitForEvent('serviceworker');
    if(notificationFailure)await worker.evaluate(()=>{
      globalThis.__frAuditStateMessages=[];
      chrome.runtime.onMessage.addListener((message,sender)=>{
        if(message?.type==='fullPageTranslationState'||message?.type==='siteExtensionDisabledState')globalThis.__frAuditStateMessages.push({
          type:message.type,isTranslated:message.isTranslated,isDisabled:message.isDisabled,
          toolbarStatus:message.toolbarStatus,frameId:sender.frameId,
        });
      });
    });
    await installTranslationFixtureOnWorker(worker,{translationUrl:provider.translationUrl,blockedUrl:provider.blockedUrl});
    const setup=await newPageWithoutForeground(context);
    await setup.goto(`chrome-extension://${new URL(worker.url()).host}/icon/128.png`);
    await patchFixtureConfig(setup,{on:true,hotkey:'Control',customHotkey:'',mouseHoverTranslationDelay:0,
      service:'microsoft',from:'auto',to:'zh-Hans',display:1,translationScope:'content',longParagraphLineBreak:false,
      uiLanguageSetupCompleted:true,uiLanguage:'zh-CN'},1);
    for(const fixture of gestureOnly || nestedOnly || sweepOnly ? [] : cases) {
      const page=await newPageWithoutForeground(context);
      page.on('pageerror',error=>report.consoleErrors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/${fixture.id}`,{waitUntil:'domcontentloaded'});
      await page.locator('#fluent-read-page-styles').waitFor({state:'attached'});
      await page.evaluate(fixture=>{
        const owner=document.getElementById('target');owner.textContent=fixture.value;
        for(let index=0;index<(fixture.emptyNodes||0);index++)owner.append(document.createTextNode(''));
      },fixture);
      await activateExtensionTabWithoutForeground(context,page); await page.waitForTimeout(500);
      const offset=fixture.offset ?? fixture.value.indexOf(fixture.marker)+8;
      const requestsBefore=provider.requestCount();
      const result={id:fixture.id,originalCharacters:fixture.value.length,emptyNodes:fixture.emptyNodes||0,phases:[]};
      report.cases.push(result);
      await sourcePoint(page,offset); await page.waitForTimeout(150);
      await startPhase(page); await gesture(page,offset);
      await page.waitForFunction(()=>document.querySelector('#target .fluent-read-bilingual-content'),undefined,{timeout:15000});
      await page.waitForTimeout(300); await page.locator('#probe').click();
      result.phases.push(await finishPhase(page,'translate'));
      const sourceChunk=await page.evaluate(({offset,marker})=>{
        const chunk=document.querySelector('#target [data-fr-translation-manual="true"]');
        const owner=document.getElementById('target');
        const clone=(chunk||owner).cloneNode(true);
        clone.querySelectorAll('[data-fr-translation-owned="true"]').forEach(node=>node.remove());
        const walker=document.createTreeWalker(owner,4);
        let node,remaining=offset,hitInSourceChunk=false;
        while((node=walker.nextNode())){
          if(node.parentElement.closest('[data-fr-translation-owned="true"]'))continue;
          if(remaining>=node.length){remaining-=node.length;continue;}
          hitInSourceChunk=!chunk||chunk.contains(node);break;
        }
        return {characters:clone.textContent.length,hitInSourceChunk,markerPreserved:!marker||clone.textContent.includes(marker)};
      },{offset,marker:fixture.marker});
      result.sourceChunkCharacters=sourceChunk.characters;
      result.hitInSourceChunk=sourceChunk.hitInSourceChunk;
      result.markerPreserved=sourceChunk.markerPreserved;
      assert.ok(result.hitInSourceChunk && result.markerPreserved,fixture.id+': hovered source preserved');
      if(!baseline)assert.ok(result.sourceChunkCharacters>0 && result.sourceChunkCharacters<=1600,fixture.id+': bounded source');
      assert.equal(await originalSource(page),fixture.value,fixture.id+': original text');
      const translatedRequests=provider.requestCount();
      assert.equal(translatedRequests,requestsBefore+1,fixture.id+': one initial upstream request');
      const point=await sourcePoint(page,offset);
      await startPhase(page); await page.keyboard.down('Control');
      try {for(let index=0;index<12;index++){await page.mouse.move(point.x+(index%2),point.y);await page.waitForTimeout(30);}}
      finally {await page.keyboard.up('Control');}
      await page.waitForTimeout(150); result.phases.push(await finishPhase(page,'continuous-hover'));
      assert.equal(provider.requestCount(),translatedRequests,fixture.id+': no repeated upstream work');
      assert.equal(await page.locator('#target .fluent-read-bilingual-content').count(),1);
      assert.equal(await page.locator('#target .fluent-read-bilingual-content .fluent-read-bilingual-content').count(),0);
      await page.screenshot({path:path.join(artifactsDir,fixture.id+'.png')});
      await startPhase(page); await gesture(page,offset);
      await page.waitForFunction(()=>!document.querySelector('#target .fluent-read-bilingual-content'));
      await page.waitForTimeout(150); result.phases.push(await finishPhase(page,'restore'));
      assert.equal(await originalSource(page),fixture.value,fixture.id+': restored text');
      await startPhase(page); await gesture(page,offset);
      await page.waitForFunction(()=>document.querySelector('#target .fluent-read-bilingual-content'));
      await page.waitForTimeout(150); result.phases.push(await finishPhase(page,'retranslate'));
      assert.equal(provider.requestCount(),translatedRequests+1,fixture.id+': one request after explicit restore');
      assert.deepEqual(provider.requestPayloads()[translatedRequests],provider.requestPayloads()[requestsBefore],
        fixture.id+': same source after restore');
      await gesture(page,offset); await page.waitForFunction(()=>!document.querySelector('#target .fluent-read-bilingual-content'));
      await page.waitForTimeout(150);
      assert.equal(await originalSource(page),fixture.value);
      result.requests=provider.requestCount()-requestsBefore;result.hostClicks=await page.evaluate(()=>window.probeClicks);
      result.originalPreserved=true; result.restoreAndRetranslate=true; result.continuousHoverNoRepeatedRequests=true;
      await page.close();
    }
    if(gestureLifecycle) {
      await patchFixtureConfig(setup,{hotkey:'LongPress',quickTranslationProfiles:[{
        id:'hover-arbitration',enabled:true,action:'hover',hotkey:'Ctrl+Shift+Y',service:'microsoft',model:'',
        targetLanguage:'zh-Hans',displayMode:'bilingual',fullPageMode:'inherit',
      }]},2);
      const page=await newPageWithoutForeground(context);
      page.on('pageerror',error=>report.consoleErrors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/long-press-arbitration`,{waitUntil:'domcontentloaded'});
      await page.locator('#fluent-read-page-styles').waitFor({state:'attached'});
      const value='This paragraph keeps a stable source while an exclusive quick shortcut cancels the pending long press.';
      await page.evaluate(value=>{document.getElementById('target').textContent=value;},value);
      await activateExtensionTabWithoutForeground(context,page);await page.waitForTimeout(500);
      const result={phases:[]};report.gestureChecks=result;
      const before=provider.requestCount();
      const point=await sourcePoint(page,25);
      await page.mouse.move(point.x,point.y);await startPhase(page);
      const started=Date.now();
      await page.mouse.down();
      try {
        await page.keyboard.press('Control+Shift+Y');
        result.arbitrationDispatchMs=Date.now()-started;
        assert.ok(result.arbitrationDispatchMs<450,'Gesture arbitration reached the long-press deadline');
        await page.waitForFunction(()=>document.querySelector('#target .fluent-read-bilingual-content'),undefined,{timeout:15000});
        await page.waitForTimeout(750);
      } finally {await page.mouse.up();}
      result.phases.push(await finishPhase(page,'long-press-arbitration'));
      result.wrappersAfterLongPressDeadline=await page.locator('#target .fluent-read-bilingual-content').count();
      result.arbitrationRequests=provider.requestCount()-before;
      await page.screenshot({path:path.join(artifactsDir,'long-press-arbitration.png')});
      assert.equal(result.wrappersAfterLongPressDeadline,1,'Pending long press must not toggle away the quick translation');
      assert.equal(result.arbitrationRequests,1,'Quick shortcut owns the only request');
      assert.equal(await originalSource(page),value);
      await page.keyboard.press('Control+Shift+Y');
      await page.waitForFunction(()=>!document.querySelector('#target .fluent-read-bilingual-content'));
      await patchFixtureConfig(setup,{hotkey:'Control',mouseHoverTranslationDelay:250,quickTranslationProfiles:[]},3);
      await page.waitForTimeout(100);
      const pendingBefore=provider.requestCount();
      const hoverPoint=await sourcePoint(page,25);
      await page.mouse.move(hoverPoint.x,hoverPoint.y);
      await startPhase(page);await page.keyboard.down('Control');
      const queued=Date.now();
      await page.mouse.move(hoverPoint.x+1,hoverPoint.y);
      await patchFixtureConfig(setup,{on:false},4);
      result.disableDispatchMs=Date.now()-queued;
      assert.ok(result.disableDispatchMs<250,'Disable happened after the hover delay');
      await page.waitForTimeout(400);await page.keyboard.up('Control');
      result.phases.push(await finishPhase(page,'delayed-hover-abort'));
      result.requestsWhileDisabled=provider.requestCount()-pendingBefore;
      assert.equal(result.requestsWhileDisabled,0,'Aborted gesture must not start upstream work');
      assert.equal(await page.locator('#target .fluent-read-bilingual-content').count(),0);
      assert.equal(await originalSource(page),value);
      await patchFixtureConfig(setup,{on:true,mouseHoverTranslationDelay:0},5);
      await page.locator('#fluent-read-page-styles').waitFor({state:'attached'});await page.waitForTimeout(250);
      result.reenabledCounts=[];
      for(const count of [1,0,1]) {
        await gesture(page,25);
        await page.waitForFunction(count=>document.querySelectorAll('#target .fluent-read-bilingual-content').length===count,
          count,{timeout:15000});
        result.reenabledCounts.push(await page.locator('#target .fluent-read-bilingual-content').count());
        assert.equal(await originalSource(page),value);
      }
      assert.deepEqual(result.reenabledCounts,[1,0,1]);
      result.reenabledGestureWorks=true;result.originalPreserved=true;
      await page.close();
      await runHoverLifecycleCancellation(context,setup,provider,server.address().port,result,await getGuardedBrowserPid(launched));
    }
    if(hoverSweep)await runHoverSweep(context,setup,provider,server.address().port);
    if(nestedViewport)await runNestedViewport(context,setup,provider,server.address().port,worker);
    await setup.close();
    assert.deepEqual(report.consoleErrors,[]);report.ok=true;
    assert.equal(report.buildSha256,sha256(path.join(extensionDir,'content-scripts/content.js')),'Build changed during browser evidence');
  } catch(error) {hasPrimaryError=true;report.ok=false;report.failure=error?.stack || String(error);console.error(error);process.exitCode=1;}
  finally {
    const cleanupErrors = [];
    const cleanup = async (resource, release) => {
      try {await release();} catch (error) {
        cleanupErrors.push(error);
        (report.cleanupErrors ||= []).push({resource, error:String(error?.stack || error)});
        report.ok = false; process.exitCode = 1;
        console.error(`Cleanup failed (${resource}):`, error);
      }
    };
    let browserClosed = false;
    await cleanup('browser', async () => {if (browserGuarded) {await launched.close(); browserClosed = true;}});
    await cleanup('provider', async () => {
      const error = await provider?.close();
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    });
    await cleanup('server connections', () => server.closeAllConnections());
    await cleanup('server', async () => {
      await new Promise((resolve, reject) => {
        server.close(error => {if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve();});
      });
    });
    await cleanup('profile', () => {
      if (browserClosed || !launchAttempted) fs.rmSync(profileDir, {recursive:true,force:true});
      else {report.retainedProfile=profileDir;report.retainedProfileLaunchAttempted=launchAttempted;}
    });
    await cleanup('report', () => {
      report.requestPayloads=provider?.requestPayloads().map(payload=>payload.map(value=>({
        characters:value.length,sha256:crypto.createHash('sha256').update(value).digest('hex'),
      })));
      fs.writeFileSync(path.join(artifactsDir,'report.json'),JSON.stringify(report,null,2));
    });
    if (cleanupErrors.length && !hasPrimaryError) throw cleanupErrors[0];
    if (report.ok) console.log(JSON.stringify(report,null,2));
  }
})().catch(error => {console.error(error);process.exitCode=1;});
