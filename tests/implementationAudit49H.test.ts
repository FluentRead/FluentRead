import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {readFileSync, statSync, writeFileSync} from 'node:fs';
import {isAbsolute, resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {createHash} from 'node:crypto';
import Module from 'node:module';

// The DOM/media/visibility ports are controlled; Vue runtime-dom and every SFC/template stay real.
const dom = await vi.hoisted(async () => {
  const {parseHTML} = await import('linkedom');
  const {window, document} = parseHTML('<html><body></body></html>');
  Object.defineProperty(window.Node.prototype, Symbol.toStringTag, {configurable: true, get() {return this.constructor.name;}});
  for (const key of ['document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'Event', 'CustomEvent']) {
    Object.defineProperty(globalThis, key, {configurable: true, writable: true, value: (window as any)[key]});
  }
  // linkedom does not implement the native details open/focus and video resource ports.
  class Details extends window.HTMLElement {}
  Object.defineProperty(Details, Symbol.hasInstance, {value: (node: any) => node?.tagName === 'DETAILS'});
  Object.defineProperty(globalThis, 'HTMLDetailsElement', {configurable: true, value: Details});
  Object.defineProperty(window.HTMLElement.prototype, 'open', {configurable: true, get() {return this.hasAttribute('open');}, set(value) {this.toggleAttribute('open', value);}});
  let active: any = null, hidden = false, reduced = false;
  Object.defineProperty(document, 'activeElement', {configurable: true, get: () => active});
  Object.defineProperty(document, 'hidden', {configurable: true, get: () => hidden});
  window.HTMLElement.prototype.focus = function () {active = this;};
  const scrolls: any[] = [];
  window.HTMLElement.prototype.scrollIntoView = function (options: any) {scrolls.push({target: this, options});};
  const windowEvents = document.createElement('div');
  const media = new Set<() => void>();
  const preference = {get matches() {return reduced;}, addEventListener: (_: string, fn: () => void) => media.add(fn), removeEventListener: (_: string, fn: () => void) => media.delete(fn)};
  const windowPort = {matchMedia: () => preference, addEventListener: windowEvents.addEventListener.bind(windowEvents), removeEventListener: windowEvents.removeEventListener.bind(windowEvents), dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents)};
  Object.defineProperty(globalThis, 'window', {configurable: true, writable: true, value: windowPort});
  const location = {hash: ''};
  Object.defineProperty(globalThis, 'location', {configurable: true, value: location});
  const observers: any[] = [];
  class Observer {
    target: any; disconnected = false;
    constructor(public callback: (entries: any[]) => void, public options: any) {observers.push(this);}
    observe(target: any) {this.target = target;}
    disconnect() {this.disconnected = true;}
    deliver(visible = true, ratio = 1) {this.callback([{target: this.target, isIntersecting: visible, intersectionRatio: ratio}]);}
  }
  Object.defineProperty(globalThis, 'IntersectionObserver', {configurable: true, writable: true, value: Observer});
  // Only viewport measurement and observer delivery are controlled; the screenshot crop stays real.
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {configurable: true, get: () => 1024});
  const resizeObservers: any[] = [];
  class ResizeObserverPort {
    target: any; disconnected = false; targets = new Set<any>(); observeCalls = 0;
    constructor(public callback: (entries: any[]) => void) {resizeObservers.push(this);}
    observe(target: any) {this.target = target; this.targets.add(target); this.observeCalls++;}
    disconnect() {this.disconnected = true; this.targets.clear();}
    deliver(width: number) {this.callback([...this.targets].map(target => ({target, contentRect: {width}})));}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {configurable: true, writable: true, value: ResizeObserverPort});
  const loads: any[] = [], pauses: any[] = [];
  Object.assign(window.HTMLElement.prototype, {HAVE_FUTURE_DATA: 3, NETWORK_LOADING: 2, readyState: 0, networkState: 0,
    load() {loads.push(this);}, pause() {pauses.push(this);}});
  return {document: document as unknown as Document, observers, resizeObservers, media, loads, pauses, scrolls, location, window: windowPort,
    visible(value: boolean) {hidden = !value; document.dispatchEvent(new window.Event('visibilitychange'));},
    motion(value: boolean) {reduced = value; for (const fn of [...media]) fn();},
    reset() {document.body.innerHTML = ''; observers.length = resizeObservers.length = loads.length = pauses.length = scrolls.length = 0; location.hash = ''; hidden = reduced = false; active = null;}};
});
const site = vi.hoisted(() => ({lang: null as any, page: null as any, route: null as any}));
vi.mock('vitepress', async () => {
  const {ref, reactive} = await import('vue');
  site.lang = ref('zh-CN'); site.page = ref({relativePath: 'guide/getting-started.md', isNotFound: false}); site.route = reactive({path: '/guide/getting-started'});
  return {withBase: (path: string) => '/fixture' + path, defineConfig: (config: any) => config,
    useData: () => ({lang: site.lang, page: site.page}), useRoute: () => site.route};
});
vi.mock('vitepress/theme', async () => {
  const {defineComponent, h} = await import('vue');
  return {default: {Layout: defineComponent({setup: (_, {slots}) => () => h('section', [slots['nav-bar-content-after']?.(), slots.default?.()])})}};
});
import {createApp, h, nextTick, type App, type Component} from 'vue';
import BrandReader from '@/docs/.vitepress/theme/BrandReader.vue';
import BrowserGuide from '@/docs/.vitepress/theme/BrowserGuide.vue';
import BrowserInstall from '@/docs/.vitepress/theme/BrowserInstall.vue';
import GrammarDemo from '@/docs/.vitepress/theme/GrammarDemo.vue';
import FeatureDemo from '@/docs/.vitepress/theme/FeatureDemo.vue';
import GuideVisual from '@/docs/.vitepress/theme/GuideVisual.vue';
import SettingsGuide from '@/docs/.vitepress/theme/SettingsGuide.vue';
import GuideLayout from '@/docs/.vitepress/theme/GuideLayout.vue';
import HeroOrbit from '@/docs/.vitepress/theme/HeroOrbit.vue';
import PromoVideo from '@/docs/.vitepress/theme/PromoVideo.vue';
import ProductHome from '@/docs/.vitepress/theme/ProductHome.vue';
import ProductHomeEn from '@/docs/.vitepress/theme/ProductHomeEn.vue';
import DocsHome from '@/docs/.vitepress/theme/DocsHome.vue';
import SupportOptions from '@/docs/.vitepress/theme/SupportOptions.vue';
import TranslationDemo from '@/docs/.vitepress/theme/TranslationDemo.vue';
import theme from '@/docs/.vitepress/theme';
import config from '@/docs/.vitepress/config';

const apps = new Set<App>();
const evidenceDirectory = process.env.AUDIT_H_EVIDENCE_DIR;
if (evidenceDirectory && (!isAbsolute(evidenceDirectory) || !statSync(evidenceDirectory).isDirectory())) {
  throw new Error('AUDIT_H_EVIDENCE_DIR must be an existing absolute directory');
}
function writeEvidence(suffix: string, value: unknown) {
  if (!evidenceDirectory) return;
  const run = process.env.AUDIT_H_RUN || 'implementationAudit49H';
  if (!/^[a-zA-Z0-9_-]+$/.test(run)) throw new Error('AUDIT_H_RUN must be a plain file name');
  writeFileSync(resolve(evidenceDirectory, run + suffix), JSON.stringify(value, null, 2));
}
async function settle() {await nextTick(); await nextTick();}
async function mount(component: Component, props: Record<string, unknown> = {}) {
  const root = document.createElement('div'); document.body.append(root);
  const app = createApp({render: () => h(component, props)});
  app.component('Content', {render: () => h('div', 'Controlled page content')});
  apps.add(app); app.mount(root); await settle();
  return {root, app, unmount() {app.unmount(); apps.delete(app);}};
}
function button(root: Element, selector: string, index = 0): HTMLElement {
  const found = root.querySelectorAll(selector)[index]; expect(found, selector).toBeTruthy(); return found as HTMLElement;
}
async function click(root: Element, selector: string, index = 0) {button(root, selector, index).click(); await settle();}
beforeEach(() => {dom.reset(); vi.useFakeTimers(); site.lang.value = 'zh-CN'; site.page.value = {relativePath: 'guide/getting-started.md', isNotFound: false};});
afterEach(() => {for (const app of apps) app.unmount(); apps.clear(); expect(dom.media.size).toBe(0); expect(dom.resizeObservers.every(observer => observer.disconnected)).toBe(true); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('public docs client lifecycle', () => {
  it('plays only while visible; pause, stage selection, replay and reduced-motion preserve article text', async () => {
    const {root} = await mount(BrandReader);
    const observer = dom.observers.at(-1);
    expect(vi.getTimerCount()).toBe(0);
    observer.deliver(true, .1); await settle(); expect(vi.getTimerCount()).toBe(0);
    observer.deliver(); await settle();
    expect(root.querySelector('[data-step]')?.getAttribute('data-running')).toBe('true');
    await vi.advanceTimersByTimeAsync(700); await settle();
    expect(root.querySelector('[data-step]')?.getAttribute('data-step')).toBe('2');
    expect(root.querySelector('.bv-line > p')?.textContent).toBe('Reading opens a window to the world.');
    dom.visible(false); await settle(); expect(vi.getTimerCount()).toBe(0);
    dom.visible(true); await settle();
    await click(root, '.bv-playback button'); expect(vi.getTimerCount()).toBe(0);
    await click(root, '.ds button', 2); expect(root.querySelector('[data-step]')?.getAttribute('data-step')).toBe('3');
    await click(root, '.bv-playback button', 1); expect(root.querySelector('[data-step]')?.getAttribute('data-step')).toBe('0');
    dom.motion(true); await settle();
    expect(root.querySelector('[data-step]')?.getAttribute('data-step')).toBe('3');
    expect(vi.getTimerCount()).toBe(0); expect(root.querySelectorAll('.bv-playback button')).toHaveLength(1);
    await click(root, '.bv-playback button'); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not resurrect timers from a queued observer delivery after unmount', async () => {
    const view = await mount(BrandReader);
    const observer = dom.observers.at(-1); observer.deliver(); await settle();
    view.unmount(); expect(observer.disconnected).toBe(true); expect(vi.getTimerCount()).toBe(0);
    observer.deliver(); await settle(); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not reschedule a queued timeout callback after unmount', async () => {
    const view = await mount(BrandReader);
    const timer = vi.spyOn(globalThis, 'setTimeout');
    dom.observers.at(-1).deliver(); await settle();
    const queued = timer.mock.calls[0][0] as () => void;
    view.unmount(); expect(vi.getTimerCount()).toBe(0);
    queued(); await settle(); expect(vi.getTimerCount()).toBe(0);
  });

  it('late media preference delivery cannot reactivate an unmounted demo', async () => {
    const view = await mount(BrandReader); dom.observers.at(-1).deliver(); await settle();
    const queued = [...dom.media]; view.unmount();
    for (const callback of queued) callback(); await settle(); expect(vi.getTimerCount()).toBe(0);
  });

  it('bounded remount probe preserves mounted outputs while suppressing orphan work', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const snapshots: string[] = []; const started = performance.now();
    for (let round = 0; round < 12; round++) {
      const view = await mount(BrandReader); const observer = dom.observers.at(-1);
      observer.deliver(); await settle(); await vi.advanceTimersByTimeAsync(350); await settle();
      snapshots.push(view.root.innerHTML); view.unmount(); observer.deliver(); await settle();
    }
    const result = {input: {rounds: 12, advanceMs: 350, lateDeliveries: 12}, sourceLoaded: true,
      outputSHA256: createHash('sha256').update(JSON.stringify(snapshots)).digest('hex'), snapshotCount: snapshots.length,
      timeoutCreations: timer.mock.calls.length, pendingTimers: vi.getTimerCount(), elapsedMs: performance.now() - started};
    writeEvidence('.bounded.json', result);
    expect(vi.getTimerCount()).toBe(0); expect(timer).toHaveBeenCalledTimes(24);
  });

  it('grammar arrow keys wrap and focus the chosen real sentence fragment', async () => {
    const {root} = await mount(GrammarDemo, {en: true});
    const first = button(root, '[data-grammar-index]');
    const left = new Event('keydown', {bubbles: true, cancelable: true}); Object.defineProperty(left, 'key', {value: 'ArrowLeft'});
    first.dispatchEvent(left); await settle(); expect(left.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button(root, '[data-grammar-index]', 3));
    expect(root.querySelector('[data-step]')?.getAttribute('data-step')).toBe('3');
    const right = new Event('keydown', {bubbles: true, cancelable: true}); Object.defineProperty(right, 'key', {value: 'ArrowRight'});
    button(root, '[data-grammar-index]', 3).dispatchEvent(right); await settle();
    expect(document.activeElement).toBe(first); expect(root.querySelector('[data-step]')?.getAttribute('data-step')).toBe('0');
    await click(root, '[data-grammar-index]', 1); expect(root.querySelector('[data-step]')?.getAttribute('data-playing')).toBe('false');
  });

  it('installation details handle outside clicks, Escape focus and listener removal', async () => {
    const view = await mount(BrowserInstall, {en: true, showDocs: true});
    const details = view.root.querySelector('details') as HTMLDetailsElement; details.open = true;
    await click(view.root, 'summary'); expect(details.open).toBe(true);
    const escape = new Event('keydown', {bubbles: true}); Object.defineProperty(escape, 'key', {value: 'Escape'});
    details.dispatchEvent(escape); expect(details.open).toBe(false); expect(document.activeElement).toBe(details.querySelector('summary'));
    details.open = true; document.body.click(); expect(details.open).toBe(false);
    details.open = true; view.unmount(); document.body.click(); expect(details.open).toBe(true);
    expect(view.root.innerHTML).toBe('');
  });

  it.each(['webpage', 'image'])('%s translation action runs to the result and stops', async (kind) => {
    const {root} = await mount(FeatureDemo, {kind, en: true}); dom.observers.at(-1).deliver(); await settle();
    await click(root, '.ds button', 1);
    expect(root.querySelector('[data-step]')?.getAttribute('data-step')).toBe('1');
    await vi.advanceTimersByTimeAsync(2500); await settle();
    expect(root.querySelector('[data-step]')?.getAttribute('data-playing')).toBe('false');
    expect(root.querySelector('[data-step]')?.getAttribute('data-step')).toBe(kind === 'webpage' ? '3' : '2');
  });

  it('reduced-motion translation action shows the result immediately without timers', async () => {
    dom.motion(true); const {root} = await mount(FeatureDemo, {kind: 'image'});
    await click(root, '.ds button', 1);
    expect(root.querySelector('[data-step]')?.getAttribute('data-step')).toBe('2');
    expect(root.querySelector('[data-step]')?.getAttribute('data-playing')).toBe('false'); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['install', 'pin', 'first-translation', 'hover', 'selection', 'chrome-local'])('browser %s demo advances and replays the actual template', async (kind) => {
    const {root} = await mount(BrowserGuide, {kind, en: true}); dom.observers.at(-1).deliver(); await settle();
    await click(root, '.ds button', 1);
    expect(root.querySelector('[data-step]')?.getAttribute('data-step')).toBe(kind === 'first-translation' ? '4' : ['hover', 'selection'].includes(kind) ? '2' : '1');
    await click(root, '.bg-controls button', 1); expect(root.querySelector('[data-step]')?.getAttribute('data-step')).toBe('0');
    await vi.advanceTimersByTimeAsync(3999); await settle(); expect(root.querySelector('[data-step]')?.getAttribute('data-step')).toBe('0');
    await vi.advanceTimersByTimeAsync(1); await settle(); expect(root.querySelector('[data-step]')?.getAttribute('data-step')).toBe('1');
  });

  it.each(['settings', 'provider', 'appearance', 'compare', 'backup', 'glossary', 'rules', 'stats', 'learning', 'webdav'])('settings %s capture follows selected hotspot and language', async (kind) => {
    const {root} = await mount(SettingsGuide, {kind, en: true});
    const before = root.querySelector('.sg-zoom circle')!.outerHTML;
    const source = root.querySelector('.sg-zoom image')!.getAttribute('href');
    expect(source).toContain('/fixture/screenshots/ui/en-US/');
    await click(root, '.ds button', 2);
    expect(root.querySelector('[data-step]')?.getAttribute('data-step')).toBe('2');
    expect(root.querySelector('.sg-zoom image')!.getAttribute('href')).toBe(source);
    expect(root.querySelector('.sg-zoom circle')!.outerHTML).not.toBe(before);
    expect(root.querySelector('.sg-description')?.getAttribute('data-callout-step')).toBe('3');
    const selectedCrop = root.querySelector('.sg-zoom')!.getAttribute('viewBox');
    await click(root, '.sg-view');
    expect(root.querySelector('.sg-view')?.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('.sg-frame img')!.getAttribute('src')).toBe(source);
    expect(root.querySelector('.sg-frame')!.getAttribute('href')).toBe(source);
    expect(root.querySelector('.sg-full-ring')).toBeTruthy();
    await click(root, '.sg-view');
    expect(root.querySelector('.sg-view')?.getAttribute('aria-pressed')).toBe('false');
    expect(root.querySelector('.sg-zoom')!.getAttribute('viewBox')).toBe(selectedCrop);
  });

  it('settings crop responds to the measured viewport and disconnects its resize observer', async () => {
    const view = await mount(SettingsGuide, {kind: 'settings'});
    const observer = dom.resizeObservers.at(-1);
    expect(observer.target).toBe(view.root.querySelector('.sg'));
    const crop = () => view.root.querySelector('.sg-zoom')!.getAttribute('viewBox')!.split(' ').map(Number);
    expect(crop()[2]).toBe(1080);
    observer.deliver(390); await settle();
    const [x, y, width, height] = crop();
    expect(width).toBe(640);
    expect(height).toBeCloseTo(640 * .46);
    const ring = view.root.querySelector('.sg-zoom circle')!;
    expect(Number(ring.getAttribute('cx'))).toBeGreaterThanOrEqual(x);
    expect(Number(ring.getAttribute('cx'))).toBeLessThanOrEqual(x + width);
    expect(Number(ring.getAttribute('cy'))).toBeGreaterThanOrEqual(y);
    expect(Number(ring.getAttribute('cy'))).toBeLessThanOrEqual(y + height);
    observer.deliver(1024); await settle(); expect(crop()[2]).toBe(1080);
    view.unmount(); expect(observer.disconnected).toBe(true);
    expect(observer.targets.size).toBe(0);
    const observations = observer.observeCalls;
    observer.callback([{target: observer.target, contentRect: {width: 390}}]); await settle();
    expect(observer.observeCalls).toBe(observations); expect(observer.targets.size).toBe(0);
    expect(view.root.innerHTML).toBe(''); expect(vi.getTimerCount()).toBe(0);
  });

  it('highlight guide renders the real example, changes style and releases playback on unmount', async () => {
    const view = await mount(GuideVisual, {kind: 'highlight', en: true});
    const original = view.root.querySelector('.hg article')!.textContent;
    await click(view.root, '.hg .ds button', 2);
    expect(view.root.querySelector('.hg')?.getAttribute('data-step')).toBe('2');
    expect(view.root.querySelector('.hg article')?.classList.contains('highlighted')).toBe(true);
    await click(view.root, '.hg-style button', 1);
    expect(view.root.querySelector('.hg article')?.classList.contains('underline')).toBe(true);
    expect(view.root.querySelectorAll('.hg-style button')[1].getAttribute('aria-pressed')).toBe('true');
    expect(view.root.querySelector('.hg article')!.textContent).toBe(original);
    view.unmount(); expect(vi.getTimerCount()).toBe(0);
  });

  it('guide layout opens nested anchors, handles malformed hashes and cancels stale reveal on unmount', async () => {
    const nested = document.createElement('div'); nested.innerHTML = '<details><details><h2 id="章节">Target</h2></details></details>'; document.body.append(nested);
    dom.location.hash = '#%E7%AB%A0%E8%8A%82'; const view = await mount(GuideLayout);
    expect([...nested.querySelectorAll('details')].every(node => node.hasAttribute('open'))).toBe(true);
    expect(dom.scrolls.at(-1).target.id).toBe('章节');
    expect(view.root.querySelector('a')?.getAttribute('href')).toBe('/fixture/en/guide/getting-started');
    dom.location.hash = '#%broken'; dom.window.dispatchEvent(new Event('hashchange')); await settle(); expect(dom.scrolls).toHaveLength(1);
    dom.location.hash = '#%E7%AB%A0%E8%8A%82'; dom.window.dispatchEvent(new Event('hashchange')); view.unmount(); await settle(); expect(dom.scrolls).toHaveLength(1);
  });

  it('hero pauses on document visibility and disconnects its observer', async () => {
    const view = await mount(HeroOrbit); const observer = dom.observers.at(-1); observer.deliver(); await settle();
    expect(view.root.firstElementChild?.getAttribute('data-active')).toBe('true');
    dom.visible(false); await settle(); expect(view.root.firstElementChild?.getAttribute('data-active')).toBe('false');
    view.unmount(); expect(observer.disconnected).toBe(true);
  });

  it('video timeout switches Chinese fallback and releases the original resource', async () => {
    const {root} = await mount(PromoVideo); const video = root.querySelector('video')!;
    expect(dom.loads).toHaveLength(0); dom.observers.at(-1).deliver(); await settle(); expect(dom.loads).toEqual([video]);
    await vi.advanceTimersByTimeAsync(8000); await settle();
    expect(root.querySelector('iframe')?.getAttribute('src')).toContain('muted=1');
    expect(video.querySelector('source')?.hasAttribute('src')).toBe(false); expect(dom.pauses).toEqual([video]); expect(vi.getTimerCount()).toBe(0);
  });

  it('playable video cancels fallback and late media/observer callbacks cannot remount it', async () => {
    const view = await mount(PromoVideo); const video = view.root.querySelector('video')!; const observer = dom.observers.at(-1);
    observer.deliver(); (video as any).readyState = 3; video.dispatchEvent(new Event('canplay')); await settle();
    expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(9000); expect(view.root.querySelector('iframe')).toBeNull();
    view.unmount(); observer.deliver(); video.dispatchEvent(new Event('error')); await settle();
    expect(view.root.innerHTML).toBe(''); expect(vi.getTimerCount()).toBe(0); expect(video.querySelector('source')?.hasAttribute('src')).toBe(false);
  });

  it('English video errors retain the original download path and release on unmount', async () => {
    const view = await mount(PromoVideo, {en: true}); const video = view.root.querySelector('video')!;
    video.dispatchEvent(new Event('error')); await settle(); expect(view.root.querySelector('iframe')).toBeNull();
    expect(video.querySelector('source')?.getAttribute('src')).toContain('promo-en.mp4');
    view.unmount(); expect(dom.pauses).toEqual([video]); expect(vi.getTimerCount()).toBe(0);
  });

  it('Chinese video without IntersectionObserver starts one bounded fallback wait and releases it', async () => {
    vi.stubGlobal('IntersectionObserver', undefined); const view = await mount(PromoVideo);
    const video = view.root.querySelector('video')!; expect(dom.loads).toEqual([video]); expect(vi.getTimerCount()).toBe(1);
    view.unmount(); expect(vi.getTimerCount()).toBe(0); expect(dom.pauses).toEqual([video]);
  });

  it('real home wrappers and registered docs components render their public navigation', async () => {
    expect(theme.Layout).toBe(GuideLayout); const registered = new Map<string, Component>();
    theme.enhanceApp({app: {component: (name: string, value: Component) => registered.set(name, value)}} as any);
    expect([...registered.keys()]).toEqual(['ProductHome', 'ProductHomeEn', 'DocsHome', 'TranslationDemo', 'GrammarDemo', 'GuideVisual', 'BrandReader', 'BrowserInstall']);
    for (const [component, english] of [[ProductHome, false], [ProductHomeEn, true], [DocsHome, true], [SupportOptions, false], [TranslationDemo, true]] as const) {
      site.lang.value = english ? 'en-US' : 'zh-CN';
      const view = await mount(component, {en: english});
      if (component === TranslationDemo) expect(view.root.querySelector('.bv-paper h3')?.textContent).toBe('阅读的乐趣。');
      else if (component === SupportOptions) expect(view.root.querySelector('.support-visit')?.getAttribute('href')).toBe('https://ko-fi.com/thinkstu');
      else if (component === DocsHome) expect(view.root.querySelector('a[href="/fixture/en/guide/webpage-translation"]')?.textContent).toContain('Bilingual');
      else expect(view.root.querySelector(`a[href="/fixture${english ? '/en' : ''}/guide/privacy"]`)?.textContent).toBe(english ? 'Data & privacy →' : '数据与隐私 →');
      if (component === ProductHomeEn) expect(view.root.textContent).toContain('FluentRead');
      view.unmount(); expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('guide delegates and generic transfer/selection/document examples mount and unmount repeatedly', async () => {
    for (const kind of ['install', 'webpage', 'document', 'provider', 'privacy', 'input', 'share', 'email', 'userscript']) {
      const view = await mount(GuideVisual, {kind, en: true});
      for (const observer of dom.observers.filter(item => !item.disconnected)) observer.deliver(); await settle();
      expect(view.root.querySelector('[data-step]')?.getAttribute('data-step')).toBe('0');
      await click(view.root, '.ds button', 2);
      expect(view.root.querySelector('[data-step]')?.getAttribute('data-step')).toBe(kind === 'document' ? '4' : kind === 'provider' ? '2' : '3');
      expect(view.root.querySelector('[data-step]')?.getAttribute('data-playing')).toBe('false');
      if (kind === 'document') expect(view.root.querySelector('.dd')?.getAttribute('data-document-complete')).toBe('true');
      if (kind === 'input') expect(view.root.querySelector('.gv-output')?.textContent).toBe('Thank you for your reply. Let’s continue tomorrow.');
      if (kind === 'email') expect(view.root.querySelector('.gv-output')?.textContent).toBe('Thanks for your help. Let’s talk tomorrow.');
      if (kind === 'share') expect(view.root.querySelector('.gv-share-card p')?.textContent).toBe('Every language opens a new door.');
      if (kind === 'userscript') expect(view.root.querySelector('.gv-toggle')?.classList.contains('enabled')).toBe(true);
      if (kind === 'provider') expect(view.root.querySelector('.sg-description')?.getAttribute('data-callout-step')).toBe('3');
      if (kind === 'webpage') expect(view.root.querySelector('.bv-line-translation')?.getAttribute('aria-hidden')).toBe('false');
      view.unmount(); expect(vi.getTimerCount()).toBe(0);
    }
    const view = await mount(FeatureDemo, {kind: 'selection', en: true});
    await click(view.root, '.ds button', 2); dom.observers.at(-1).deliver();
    await vi.advanceTimersByTimeAsync(1300); await settle(); expect(view.root.querySelector('[data-step]')?.getAttribute('data-step')).toBe('3');
  });

  it('public head transformation preserves canonical language counterparts and noindexes 404', () => {
    const transform = config.transformHead as any;
    for (const [path, canonical] of [['guide/index.md', 'docs/'], ['en/writing-assistant.md', 'en/guide/writing-assistant'], ['guide/privacy-policy.md', 'guide/privacy'], ['index.md', '']]) {
      const head = transform({pageData: {relativePath: path}});
      expect(head[0][1].href).toBe('https://read.thinkstu.com/' + canonical);
      expect(head[2][1].href).toBe('https://read.thinkstu.com/' + (canonical.startsWith('en/') ? canonical.slice(3) : 'en/' + canonical));
    }
    expect(transform({pageData: {relativePath: '404.md'}})).toEqual([['meta', {name: 'robots', content: 'noindex'}]]);
  });
});

describe('public no-framework popup warmup', () => {
  const baselineRoot = process.env.AUDIT_H_VARIANT === 'baseline' ? process.env.AUDIT_H_BASELINE_ROOT : undefined;
  if (process.env.AUDIT_H_VARIANT === 'baseline' && (!baselineRoot || !isAbsolute(baselineRoot) || !statSync(baselineRoot).isDirectory())) {
    throw new Error('Explicit baseline mode requires AUDIT_H_BASELINE_ROOT to be an existing absolute directory');
  }
  const source = readFileSync(resolve(baselineRoot || process.cwd(), 'public/popup-startup.js'), 'utf8');
  it('executes the actual startup module against a controlled browser runtime', async () => {
    const response = {success: true, uiLanguageSetupCompleted: true};
    const sendMessage = vi.fn((_: unknown) => Promise.resolve(response));
    vi.stubGlobal('browser', {runtime: {sendMessage}}); vi.stubGlobal('chrome', undefined); vi.stubGlobal('__fluentReadPopupWarmup', undefined);
    await import(resolve(process.cwd(), 'public/popup-startup.js'));
    expect(sendMessage).toHaveBeenCalledWith({type: 'popupStartup'});
    expect(await (globalThis as any).__fluentReadPopupWarmup).toBe(response);
  });
  it('publishes the real browser response promise without throwing on rejected or sync failed ports', async () => {
    const response = {success: true, uiLanguageSetupCompleted: false}; const sendMessage = vi.fn((_: unknown) => Promise.resolve(response)); const sandbox: any = {browser: {runtime: {sendMessage}}};
    runInNewContext(source, sandbox); expect(sendMessage.mock.calls[0][0]).toEqual({type: 'popupStartup'}); expect(await sandbox.__fluentReadPopupWarmup).toBe(response);
    for (const send of [() => Promise.reject(new Error('controlled rejection')), () => {throw new Error('controlled sync failure');}]) {
      const failing: any = {browser: {runtime: {sendMessage: send}}}; expect(() => runInNewContext(source, failing)).not.toThrow(); expect(await failing.__fluentReadPopupWarmup).toBeUndefined();
    }
  });
  it('consumes Chrome lastError, handles absent runtime, and tolerates a late callback', async () => {
    let callback: ((value: any) => void) | undefined; let errorReads = 0;
    const runtime = {sendMessage: vi.fn((_: any, cb: any) => callback = cb), get lastError() {errorReads++; return {message: 'controlled closed port'};}};
    const sandbox: any = {chrome: {runtime}}; runInNewContext(source, sandbox);
    callback!({success: true}); expect(await sandbox.__fluentReadPopupWarmup).toBeUndefined(); expect(errorReads).toBe(1);
    callback!({success: false}); expect(await sandbox.__fluentReadPopupWarmup).toBeUndefined();
    expect(() => runInNewContext(source, {})).not.toThrow();
  });
});

// This contract checks real Vite-compiled CSS through the public installer and parses its symbols.
// Native cascade/animation behavior is separately verified by Main in background-visible Edge.
const pageConfigPort = vi.hoisted(() => ({
  config: {translationAppearance: {lineColor: '#ef4776'} as unknown},
  listeners: new Set<(next: {translationAppearance: unknown}) => void>(),
}));
vi.mock('@/src/services/config/store', () => ({
  config: pageConfigPort.config,
  subscribeConfig: (listener: (next: {translationAppearance: unknown}) => void) => {
    pageConfigPort.listeners.add(listener);
    return () => pageConfigPort.listeners.delete(listener);
  },
}));

describe('public host style installation contract', () => {
  it('owns feedback animation symbols without colliding with host names and releases only its styles', async () => {
    const taskRequire = Module.createRequire(process.cwd() + '/package.json');
    const {parse} = Module.createRequire(taskRequire.resolve('vite/package.json'))('postcss');
    const {installPageStyles} = await import('@/src/app/content/pageStyles');
    const originals = ['inputBoxTranslating', 'inputBoxSuccess', 'inputBoxError'];
    const names = ['fluent-read-input-box-translating', 'fluent-read-input-box-success', 'fluent-read-input-box-error'];
    const host = document.createElement('style');
    host.textContent = originals.map(name => `@keyframes ${name} { from {opacity: .2} to {opacity: .8} }`).join('\n');
    document.head.append(host);
    document.body.innerHTML = '<p>Host animation and input feedback</p><input class="fluent-input-translating"><input class="fluent-input-success"><input class="fluent-input-error">';
    const hostCss = host.textContent, hostMarkup = document.body.innerHTML;
    const invalidations: Array<() => void> = [];
    const remove = installPageStyles({onInvalidated: (callback: () => void) => invalidations.push(callback)} as never);
    try {
      const installed = document.getElementById('fluent-read-page-styles')!;
      expect(installed.parentNode).toBe(document.head);
      expect(pageConfigPort.listeners.size).toBe(1);
      const css = parse(installed.textContent);
      const keyframes = new Map<string, any>();
      css.walkAtRules('keyframes', (rule: any) => keyframes.set(rule.params, rule));
      // Record parsed frame selectors/declarations for the baseline/current output comparison.
      const frames = (rule: any) => rule.nodes.map((frame: any) => ({selector: frame.selector,
        declarations: frame.nodes.map((declaration: any) => ({prop: declaration.prop, value: declaration.value, important: declaration.important === true}))}));
      const animations = new Map<string, string>();
      css.walkRules((rule: any) => rule.walkDecls('animation', (declaration: any) => animations.set(rule.selector, declaration.value)));
      writeEvidence('.parsed-css.json', {
        publicEntryLoaded: true, cssLoadedByRealViteInlineImports: true,
        boundary: 'Parsed CSS symbol/frame and public install lifecycle contract; no native cascade emulation',
        installedCSSSHA256: createHash('sha256').update(installed.textContent!).digest('hex'),
        keyframes: [...keyframes.keys()],
        feedback: ['translating', 'success', 'error'].map(phase => {
          const actualName = animations.get(`.fluent-input-${phase}`)!.split(' ')[0];
          return {phase, animation: animations.get(`.fluent-input-${phase}`), keyframe: actualName,
            frames: frames(keyframes.get(actualName))};
        }),
        hostStyleUnchanged: host.textContent === hostCss, originalMarkupUnchanged: document.body.innerHTML === hostMarkup,
      });
      expect([...keyframes.keys()].filter(name => originals.includes(name))).toEqual([]);
      for (const [index, phase] of ['translating', 'success', 'error'].entries()) {
        expect(keyframes.has(names[index])).toBe(true);
        expect(frames(keyframes.get(names[index])).map((frame: any) => frame.selector)).toEqual(
          phase === 'error' ? ['0%', '25%', '75%', '100%'] : ['0%', '50%', '100%']);
        expect(animations.get(`.fluent-input-${phase}`)).toBe(names[index] + [' 3s infinite ease-in-out', ' 1.5s ease-out', ' 0.5s ease-out'][index]);
      }
      const removeDuplicate = installPageStyles({onInvalidated: () => {throw new Error('duplicate must not own lifecycle');}} as never);
      removeDuplicate();
      expect(document.querySelectorAll('#fluent-read-page-styles')).toHaveLength(1);
      expect(pageConfigPort.listeners.size).toBe(1);
      expect(invalidations).toHaveLength(1);
      for (const listener of pageConfigPort.listeners) listener({translationAppearance: {textColor: '#1d4ed8'}});
      expect(document.getElementById('fluent-read-translation-appearance')?.textContent).toContain('color: #1d4ed8 !important;');
      expect(host.textContent).toBe(hostCss);
      expect(document.body.innerHTML).toBe(hostMarkup);
    } finally {
      invalidations[0]();
      remove();
      expect(document.getElementById('fluent-read-page-styles')).toBeNull();
      expect(document.getElementById('fluent-read-translation-appearance')).toBeNull();
      expect(pageConfigPort.listeners.size).toBe(0);
      expect(host.isConnected).toBe(true);
      expect(host.textContent).toBe(hostCss);
      expect(document.body.innerHTML).toBe(hostMarkup);
      host.remove();
    }
  });
});
