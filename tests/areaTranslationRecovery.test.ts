import * as Vue from 'vue';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {mountAreaTranslator} from './helpers/areaTranslatorHarness';
import AreaTranslator from '@/src/features/area-translation/ui/AreaTranslator.vue';
let close: (() => void) | undefined;
afterEach(() => {close?.(); vi.unstubAllGlobals(); vi.useRealTimers();});
function deferred() {let resolve!: () => void; const promise = new Promise<void>(yes => {resolve = yes;}); return {promise, resolve};}
function mountRecovery() {
  const fixture = mountAreaTranslator(AreaTranslator); close = fixture.unmount;
  const captured = 'data:image/png,original-selection';
  const result = {image: 'data:image/png,crop', sourceText: 'Source', translatedText: '译文', service: 'microsoft', serviceName: '微软翻译', model: '', mode: 'standard', lines: [], warnings: []};
  fixture.capture.mockResolvedValue(captured);
  fixture.translate.mockRejectedValueOnce(new Error('图片文字识别需要先下载中文、English语言包，请前往设置下载')).mockResolvedValue(result);
  const rect = {left: 10, top: 20, width: 120, height: 90};
  fixture.state.activeRect = rect; fixture.state.phase = 'loading';
  return {...fixture, captured, result, rect};
}

describe('圈选缺少语言包的一键恢复', () => {
  it('缺包后只下载一次，使用原截图和原语言继续，无需重新圈选', async () => {
    const f = mountRecovery();
    await f.state.requestTranslation(f.rect);
    expect(f.state.needsLanguages).toBe(true); expect(f.state.phase).toBe('error');
    f.config.from = 'ja';
    f.state.downloadLanguagesAndRetry(); f.state.downloadLanguagesAndRetry();
    await vi.waitFor(() => expect(f.state.phase).toBe('translated'));
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.prepare).toHaveBeenCalledWith('auto', expect.any(AbortSignal), expect.any(Function));
    // 准备语言包期间，卡片显示后台回报的真实下载百分比。
    f.prepare.mock.calls[0][2](75);
    expect(f.state.languagePercent).toBe(75);
    expect(f.capture).toHaveBeenCalledOnce();
    expect(f.translate.mock.calls[1][0]).toBe(f.captured);
    expect(f.translate.mock.calls[1][2]).toBe('auto');
    expect(f.state.result.translatedText).toBe('译文');
  });
  it('下载失败保留恢复按钮，取消下载后迟到结果不触发翻译', async () => {
    const f = mountRecovery(); await f.state.requestTranslation(f.rect);
    f.prepare.mockRejectedValueOnce(new Error('network unavailable'));
    f.state.downloadLanguagesAndRetry();
    await vi.waitFor(() => expect(f.state.phase).toBe('error'));
    expect(f.state.needsLanguages).toBe(true);
    const pending = deferred(); f.prepare.mockReturnValueOnce(pending.promise);
    f.state.downloadLanguagesAndRetry();
    expect(f.state.preparingLanguages).toBe(true);
    f.state.clearResult(); pending.resolve(); await Vue.nextTick();
    expect(f.prepare.mock.calls.at(-1)![1].aborted).toBe(true);
    expect(f.translate).toHaveBeenCalledOnce(); expect(f.state.phase).toBe('idle');
  });
});


describe('圈选失败的主恢复动作', () => {
  it.each([
    ['没有识别到圈选区域文字','empty','重新圈选'],
    ['视觉圈选识别未返回有效文字','empty','重新圈选'],
    ['401 Unauthorized','settings','圈选设置'],
    ['invalid model','settings','圈选设置'],
    ['network unavailable','retry','重试'],
  ])('根据 %s 展示单一主动作并收起详细原因', async (message,kind,label) => {
    const f=mountRecovery();f.translate.mockReset().mockRejectedValueOnce(new Error(message)).mockResolvedValue(f.result);
    await f.state.requestTranslation(f.rect);await Vue.nextTick();
    const primary=f.host.querySelectorAll('.fr-area-primary');expect(primary).toHaveLength(1);
    expect(primary[0].getAttribute('data-recovery')).toBe(kind);expect(primary[0].textContent).toBe(label);
    expect(f.host.querySelector('[role=alert]')?.textContent).not.toContain(message);
    expect(f.host.querySelector('.fr-area-error-details')?.hasAttribute('open')).toBe(false);
    expect(f.host.querySelector('.fr-area-more')?.hasAttribute('open')).toBe(false);
    await f.click(label);
    if(kind==='empty')expect(f.state.phase).toBe('selecting');
    else if(kind==='settings')expect(f.sendMessage).toHaveBeenCalledWith({type:'openOptionsPage',section:'settings-area-translation'});
    else {await vi.waitFor(()=>expect(f.state.phase).toBe('translated'));expect(f.capture).toHaveBeenCalledOnce();}
  });
  it('截图重试成功后依据新出现的服务错误更新主动作', async () => {
    const f=mountRecovery();f.capture.mockRejectedValueOnce(new Error('capture unavailable'));
    f.translate.mockReset().mockRejectedValueOnce(new Error('401 Unauthorized'));
    await f.state.requestTranslation(f.rect);await Vue.nextTick();
    expect(f.host.querySelector('.fr-area-primary')?.getAttribute('data-recovery')).toBe('capture');
    await f.click('重试');
    await vi.waitFor(()=>expect(f.host.querySelector('.fr-area-primary')?.getAttribute('data-recovery')).toBe('settings'));
    expect(f.capture).toHaveBeenCalledTimes(2);expect(f.prepare).not.toHaveBeenCalled();
  });
  it('截图失败时提供重试，并在缺包时优先下载而不并排展示另一个主按钮', async () => {
    const f=mountRecovery();f.capture.mockRejectedValueOnce(new Error('capture unavailable'));
    await f.state.requestTranslation(f.rect);await Vue.nextTick();
    expect(f.host.querySelector('.fr-area-primary')?.getAttribute('data-recovery')).toBe('capture');
    await f.click('重试');await vi.waitFor(()=>expect(f.state.phase).toBe('error'));
    expect(f.host.querySelector('.fr-area-primary')?.getAttribute('data-recovery')).toBe('languages');
    await f.click('下载语言包并重试');await vi.waitFor(()=>expect(f.state.phase).toBe('translated'));
    expect(f.prepare).toHaveBeenCalledOnce();expect(f.capture).toHaveBeenCalledTimes(2);
  });
});

describe('圈选结果拖动', () => {
  it('标题栏拖动受视口边界约束，重试保留位置，关闭释放指针并重置位置', () => {
    const f = mountRecovery();
    const handle = document.createElement('header');
    const capture = vi.fn(); const release = vi.fn();
    Object.assign(handle, {setPointerCapture: capture, hasPointerCapture: () => true, releasePointerCapture: release});
    f.state.panelElement = {getBoundingClientRect: () => ({left: 40, top: 60, width: 460})};
    const event = (extra = {}) => ({isTrusted: true, button: 0, pointerId: 7, clientX: 50, clientY: 70, target: handle, currentTarget: handle, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra});
    f.state.beginPanelDrag(event({target: document.createElement('button')}));
    f.state.beginPanelDrag(event({isTrusted: false}));
    expect(capture).not.toHaveBeenCalled();
    f.state.beginPanelDrag(event());
    expect(capture).toHaveBeenCalledWith(7);
    f.state.handlePointermove(event({pointerId: 8, clientX: 200}));
    expect(f.state.panelPosition).toBeNull();
    f.state.handlePointermove(event({clientX: 200, clientY: 220}));
    expect(f.state.panelPosition).toEqual({x: 190, y: 210});
    f.state.handlePointermove(event({clientX: 2000, clientY: 2000}));
    expect(f.state.panelPosition).toEqual({x: 528, y: 560});
    f.state.handlePointerup(event());
    expect(release).toHaveBeenCalledWith(7);
    f.state.phase = 'translated';
    expect(f.state.panelStyle(f.rect)).toMatchObject({left: '528px', top: '560px'});
    f.state.beginPanelDrag(event());
    f.state.clearResult();
    expect(release).toHaveBeenCalledTimes(2);
    expect(f.state.panelPosition).toBeNull();
    f.state.handlePointermove(event({clientX: 200}));
    expect(f.state.panelPosition).toBeNull();
  });
  it('取消或窗口失焦只停止拖动，不删除正在阅读的结果', () => {
    const f = mountRecovery();
    const handle = document.createElement('header');
    Object.assign(handle, {setPointerCapture() {}, hasPointerCapture: () => false});
    f.state.panelElement = {getBoundingClientRect: () => ({left: 40, top: 60, width: 460})};
    const e = {isTrusted: true, button: 0, pointerId: 2, clientX: 10, clientY: 10, target: handle, currentTarget: handle, preventDefault() {}, stopPropagation() {}};
    f.state.beginPanelDrag(e); f.state.handlePointercancel(e);
    expect(f.state.phase).toBe('loading');
    f.state.beginPanelDrag(e); f.state.handleWindowBlur();
    f.state.handlePointermove({...e, clientX: 100});
    expect(f.state.panelPosition).toBeNull(); expect(f.state.phase).toBe('loading');
  });
});

describe('圈选真实控件与异步所有权', () => {
  function mountControls() {const fixture = mountAreaTranslator(AreaTranslator); close = fixture.unmount; return fixture;}
  const pointer = {isTrusted: true, button: 0, pointerId: 11, clientX: 20, clientY: 30};
  async function select(f: ReturnType<typeof mountControls>) {
    expect(f.beginSelection()).toBe(true); await Vue.nextTick();
    expect(f.host.querySelector('.fr-area-hint')?.textContent).toContain('拖拽选择区域');
    f.dispatch(document, 'pointerdown', pointer);
    f.dispatch(document, 'pointermove', {...pointer, clientX: 140, clientY: 130}); await Vue.nextTick();
    expect(f.host.querySelector('.fr-area-selection')?.getAttribute('style')).toContain('width:120px');
    f.dispatch(document, 'pointerup', {...pointer, clientX: 140, clientY: 130});
  }
  it('按真实指针选区、展示译文与原图、复制、复用裁剪图重译，并重新圈选与关闭', async () => {
    const f = mountControls(); await select(f);
    await vi.waitFor(() => expect(f.host.querySelector('.fr-area-translation')?.textContent).toBe('译文'));
    const pagePointer = vi.fn(); document.addEventListener('pointerdown', pagePointer);
    f.dispatch(f.host.querySelector('.fr-area-translator-root')!, 'pointerdown', {...pointer, isTrusted: false});
    expect(pagePointer).not.toHaveBeenCalled(); document.removeEventListener('pointerdown', pagePointer);
    expect(f.capture).toHaveBeenCalledOnce();
    expect(f.translate.mock.calls[0]).toEqual(['data:image/png,capture', {left: 20, top: 30, width: 120, height: 100, viewportWidth: 1000, viewportHeight: 800}, 'auto', 'Area fixture', expect.objectContaining({timeoutMs: 180000})]);
    expect(f.host.querySelector('img')?.getAttribute('src')).toBe('data:image/png,crop');
    await f.click('复制译文'); expect(f.copy).toHaveBeenLastCalledWith('译文'); expect(f.host.textContent).toContain('已复制');
    await f.click('复制原文'); expect(f.copy).toHaveBeenLastCalledWith('Source');
    await f.click('重新翻译'); await vi.waitFor(() => expect(f.state.phase).toBe('translated'));
    expect(f.capture).toHaveBeenCalledOnce();
    expect(f.translate.mock.calls[1][0]).toBe('data:image/png,crop');
    expect(f.translate.mock.calls[1][1]).toEqual({left: 0, top: 0, width: 120, height: 100, viewportWidth: 120, viewportHeight: 100});
    await f.click('圈选设置'); expect(f.sendMessage).toHaveBeenCalledWith({type: 'openOptionsPage', section: 'settings-area-translation'});
    await f.click('重新圈选'); expect(f.state.phase).toBe('selecting'); expect(f.host.querySelector('[role="dialog"]')).toBeNull();
    f.dispatch(document, 'keydown', {isTrusted: true, key: 'Escape'}); await Vue.nextTick(); expect(f.state.phase).toBe('idle');
    await select(f); await vi.waitFor(() => expect(f.state.phase).toBe('translated')); await f.click('关闭圈选翻译结果');
    expect(f.host.querySelector('[role="dialog"]')).toBeNull(); expect(f.state.result).toBeNull();
  });
  it('下载按钮显示真实进度、使用原语言和截图恢复，错误按钮支持重新圈选', async () => {
    const f = mountControls(); f.translate.mockRejectedValueOnce(new Error('请先下载语言包'));
    await select(f); await vi.waitFor(() => expect(f.host.querySelector('[role="alert"]')).toBeTruthy());
    const download = deferred(); f.prepare.mockReturnValueOnce(download.promise);
    await f.click('下载语言包并重试'); expect(f.host.textContent).toContain('下载中');
    expect(f.host.querySelector('.fr-area-download')).toBeTruthy(); f.prepare.mock.calls[0][2](65); await Vue.nextTick(); expect(f.host.textContent).toContain('65%');
    f.config.from = 'ja'; download.resolve(); await vi.waitFor(() => expect(f.state.phase).toBe('translated'));
    expect(f.prepare).toHaveBeenCalledWith('auto', expect.any(AbortSignal), expect.any(Function));
    expect(f.translate.mock.calls[1][2]).toBe('auto'); expect(f.capture).toHaveBeenCalledOnce();
    f.translate.mockRejectedValueOnce('OCR unavailable'); await f.click('重新翻译'); await vi.waitFor(() => expect(f.state.phase).toBe('error'));
    expect(f.host.textContent).toContain('OCR unavailable'); await f.click('重新圈选'); expect(f.state.phase).toBe('selecting');
  });
  it('截图隐藏遮罩后，识别与翻译进度可见，取消会终止请求并忽略迟到进度和结果', async () => {
    const f = mountControls(); let finish!: (value: any) => void;
    f.translate.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    await select(f); await vi.waitFor(() => expect(f.translate).toHaveBeenCalledOnce());
    expect(f.host.querySelector('.fr-area-selection')).toBeNull(); expect(f.host.textContent).toContain('正在识别选区文字');
    const options = f.translate.mock.calls[0][4]; options.onProgress('translating'); await Vue.nextTick(); expect(f.host.textContent).toContain('正在翻译选区文字');
    await f.click('取消'); expect(options.signal.aborted).toBe(true);
    options.onProgress('recognizing'); finish({image: 'late', sourceText: 'late', translatedText: '迟到'}); await Vue.nextTick(); await Vue.nextTick();
    expect(f.state.phase).toBe('idle'); expect(f.state.result).toBeNull(); expect(f.host.textContent).not.toContain('迟到');
  });
  it.each(['unknown', 'unsupported', undefined] as const)('显示视觉识别与校对信息、模型身份和回退说明 %s', async fallback => {
    const f = mountControls(); f.translate.mockResolvedValueOnce({image: 'image', sourceText: 'S0urce', correctedText: 'Source', translatedText: 'Source', service: 'custom:fixture', serviceName: 'My custom service', model: 'vision-model', mode: 'ai', recognitionMethod: 'vision', recognitionFallback: fallback});
    await select(f); await vi.waitFor(() => expect(f.state.phase).toBe('translated')); await Vue.nextTick();
    expect(f.host.querySelector('.fr-area-translation')).toBeNull(); expect(f.host.querySelector('details')?.hasAttribute('open')).toBe(true);
    expect(f.host.textContent).toContain('AI 校对文'); expect(f.host.textContent).toContain('My custom service'); expect(f.host.textContent).toContain('vision-model');
    expect(f.host.querySelectorAll('[role="note"]')).toHaveLength(fallback ? 2 : 1);
    await f.click('复制原文'); expect(f.copy).toHaveBeenCalledWith('S0urce');
  });
  it('AI 文字增强保留 OCR 限制说明、相同校对文本不重复展示', async () => {
    const f = mountControls(); f.translate.mockResolvedValueOnce({image: 'image', sourceText: 'Source', correctedText: 'Source', translatedText: '译文', service: 'microsoft', serviceName: '微软翻译', model: '', mode: 'ai'});
    await select(f); await vi.waitFor(() => expect(f.state.phase).toBe('translated')); await Vue.nextTick();
    expect(f.host.textContent).toContain('AI 仅处理识别文字'); expect(f.host.textContent).not.toContain('AI 校对文');
  });
  it('复制与设置失败反馈可恢复且会自动清理，关闭后迟到反馈不能恢复卡片', async () => {
    const f = mountControls(); await select(f); await vi.waitFor(() => expect(f.state.phase).toBe('translated'));
    f.copy.mockRejectedValueOnce(new Error('denied')); await f.click('复制译文'); expect(f.host.textContent).toContain('复制失败');
    f.sendMessage.mockResolvedValueOnce({success: false}); await f.click('圈选设置'); expect(f.host.textContent).toContain('无法打开设置');
    vi.useFakeTimers(); await f.click('复制原文'); expect(f.host.textContent).toContain('已复制'); await vi.advanceTimersByTimeAsync(2500); expect(f.host.querySelector('.fr-area-feedback')).toBeNull(); vi.useRealTimers();
    const copying = deferred(), settings = deferred(); f.copy.mockReturnValueOnce(copying.promise); f.sendMessage.mockReturnValueOnce(settings.promise.then(() => {throw new Error('late');}));
    await f.click('复制译文'); await f.click('圈选设置'); await f.click('关闭圈选翻译结果'); copying.resolve(); settings.resolve(); await Vue.nextTick(); await Vue.nextTick();
    expect(f.state.feedback).toBe(''); expect(f.state.phase).toBe('idle');
  });
  it('切到后台取消未完成截图，页面恢复后允许重选，配置关闭会清理结果和监听', async () => {
    const f = mountControls(); let finish!: (value: string) => void;
    f.capture.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    await select(f); await vi.waitFor(() => expect(f.capture).toHaveBeenCalledOnce());
    Object.defineProperty(document, 'visibilityState', {value: 'hidden', configurable: true}); f.dispatch(document, 'visibilitychange');
    finish('data:image/png,late'); await Vue.nextTick(); await Vue.nextTick(); expect(f.translate).not.toHaveBeenCalled(); expect(f.state.phase).toBe('idle');
    Object.defineProperty(document, 'visibilityState', {value: 'visible', configurable: true}); f.dispatch(document, 'visibilitychange');
    await select(f); await vi.waitFor(() => expect(f.state.phase).toBe('translated'));
    f.config.theme = 'auto'; f.media.matches = true; f.config.animations = false; f.subscription(); await Vue.nextTick(); expect(f.host.querySelector('.fr-area-dark')).toBeTruthy();
    f.config.selectionAreaEnabled = false; f.subscription(); expect(f.state.phase).toBe('idle'); expect(f.beginSelection()).toBe(false);
    close?.(); close = undefined; expect(f.stopConfig).toHaveBeenCalledOnce(); expect(f.media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    f.dispatch(document, 'pointerdown', pointer); expect(f.state.phase).toBe('idle');
  });
  it('合成事件、次要指针和小于阈值的选区不发请求，取消与失焦释放选区', async () => {
    const f = mountControls(); f.beginSelection();
    for (const type of ['keydown', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel']) f.dispatch(document, type, {...pointer, isTrusted: false, key: 'Escape'});
    expect(f.state.phase).toBe('selecting'); expect(f.state.selectionRect).toBeNull();
    f.dispatch(document, 'pointerup', pointer); f.dispatch(document, 'pointerdown', {...pointer, button: 2}); expect(f.state.selectionRect).toBeNull();
    f.dispatch(document, 'pointerdown', pointer); f.dispatch(document, 'pointerdown', {...pointer, pointerId: 12});
    f.dispatch(document, 'pointerup', {...pointer, pointerId: 12}); f.dispatch(document, 'pointercancel', {...pointer, pointerId: 12}); expect(f.state.phase).toBe('selecting');
    f.dispatch(document, 'pointerup', {...pointer, clientX: 21, clientY: 31}); expect(f.state.phase).toBe('idle'); expect(f.capture).not.toHaveBeenCalled();
    f.beginSelection(); f.config.on = false; f.dispatch(document, 'pointerdown', pointer); expect(f.state.selectionRect).toBeNull(); f.config.on = true;
    f.dispatch(document, 'pointerdown', pointer); f.dispatch(document, 'pointercancel', pointer); expect(f.state.phase).toBe('idle');
    f.beginSelection(); f.dispatch(window, 'blur'); expect(f.state.phase).toBe('idle');
    f.state.retryTranslation(); f.state.downloadLanguagesAndRetry(); expect(f.capture).not.toHaveBeenCalled();
  });
  it('选区刚提交便关闭时取消绘制等待，快速重试取消上一代，迟到错误不取代新结果', async () => {
    const f = mountControls(); f.beginSelection(); f.dispatch(document, 'pointerdown', pointer);
    f.dispatch(document, 'pointerup', {...pointer, clientX: 140, clientY: 130}); f.state.clearResult();
    await Vue.nextTick(); await Vue.nextTick(); expect(f.capture).not.toHaveBeenCalled();
    await select(f); await vi.waitFor(() => expect(f.state.phase).toBe('translated')); await Vue.nextTick();
    let reject!: (reason: Error) => void; f.translate.mockImplementationOnce(() => new Promise((_, fail) => {reject = fail;}));
    const retry = [...f.host.querySelectorAll('button')].find(button => button.textContent === '重新翻译')!;
    f.dispatch(retry, 'click'); const firstSignal = f.translate.mock.calls[1][4].signal;
    f.dispatch(retry, 'click'); expect(firstSignal.aborted).toBe(true); reject(new Error('obsolete failure'));
    await vi.waitFor(() => expect(f.state.phase).toBe('translated')); expect(f.state.errorMessage).toBe('');
    f.sendMessage.mockResolvedValueOnce(undefined); await f.click('圈选设置'); expect(f.state.feedback).toBe('');
    const pending = deferred(); f.copy.mockReturnValueOnce(pending.promise.then(() => {throw new Error('late copy');}));
    await f.click('复制原文'); await f.click('关闭圈选翻译结果'); pending.resolve(); await Vue.nextTick(); await Vue.nextTick(); expect(f.state.feedback).toBe('');
  });
  it('拖动标题真实绑定持有指针，面板脱离后保持边界，内部滚动不重置坐标', async () => {
    const f = mountControls(); await select(f); await vi.waitFor(() => expect(f.state.phase).toBe('translated')); await Vue.nextTick();
    const header = f.host.querySelector('header')!; const release = vi.fn();
    Object.assign(header, {setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: release});
    Object.assign(f.host.querySelector('section')!, {getBoundingClientRect: () => ({left: 40, top: 60, width: 460})});
    f.dispatch(header, 'pointerdown', pointer); f.state.panelElement = null;
    f.dispatch(document, 'pointermove', {...pointer, clientX: 80, clientY: 90}); expect(f.state.panelPosition).toEqual({x: 100, y: 120});
    f.state.handleViewportChange({target: header}); expect(f.state.panelPosition).toEqual({x: 100, y: 120});
    f.dispatch(header, 'lostpointercapture'); expect(release).toHaveBeenCalledWith(11);
    f.config.animations = false; f.subscription(); let finish!: (value: any) => void; f.translate.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    await f.click('重新翻译'); expect(f.host.querySelector('.fr-area-static')).toBeTruthy(); await f.click('取消'); finish({image: 'late'});
  });

});
