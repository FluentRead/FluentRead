import {describe, expect, it, vi} from 'vitest';
import {createMangaOcrColorAdapter, withMangaOcrColorRead, MANGA_OCR_COLOR_CROP_PIXELS, MANGA_OCR_COLOR_PAGE_PIXELS,
    type MangaOcrColorImage} from '@/src/features/image-translation/services/mangaOcrColor';

const WHITE = [255, 255, 255, 255], BLACK = [0, 0, 0, 255];
function image(width = 8, height = 48, background = WHITE) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < data.length; index += 4) data.set(background, index);
    return {data, width, height, identity: 'owned-image'};
}
function setPixel(input: ReturnType<typeof image>, x: number, y: number, color: number[]) {
    input.data.set(color, (y * input.width + x) * 4);
}
function luma(red: number, green: number, blue: number) {return Math.floor((299 * red + 587 * green + 114 * blue + 500) / 1000);}

// 独立标量公式保留冻结 V3 的输出契约；不使用识别原文、fixture 名或模型输出选通道。
function expectedRed(red: number, green: number, blue: number, endpoint: number, anchor: number) {
    const y = luma(red, green, blue);
    const mapped = endpoint === 255 ? Math.round(y * 255 / anchor) : Math.round((y - anchor) * 255 / (255 - anchor));
    const bounded = Math.max(0, Math.min(255, mapped));
    return endpoint === 255 ? Math.min(red, bounded) : Math.max(red, bounded);
}

describe('有界识别副本颜色对比', () => {
    it.each([
        [WHITE, [255, 0, 0, 255]], [WHITE, [255, 0, 255, 255]],
        [BLACK, [0, 255, 255, 255]], [[255, 200, 200, 255], [255, 0, 0, 255]],
        [[0, 50, 50, 255], [0, 255, 255, 255]],
    ])('仅从%j端点增强已有裁图的彩字，不写原缓冲或其他通道', (background, foreground) => {
        const source = image(8, 48, background);setPixel(source, 3, 20, foreground);
        const before = source.data.slice(), owned = {...source, data: source.data.slice()}, adapter = createMangaOcrColorAdapter();
        adapter.beginPage();const replace = vi.fn((value: typeof owned) => ({processor: value}));
        expect(adapter.transform(8, 48, () => owned, replace)).toEqual({processor: owned});
        expect(replace).toHaveBeenCalledOnce();expect(replace).toHaveBeenCalledWith(owned);expect(source.data).toEqual(before);
        const anchor = luma(background[0], background[1], background[2]);
        for (let index = 0; index < before.length; index += 4) {
            expect(owned.data[index]).toBe(expectedRed(before[index], before[index + 1], before[index + 2], background[0], anchor));
            expect(Array.from(owned.data.slice(index + 1, index + 4))).toEqual(Array.from(before.slice(index + 1, index + 4)));
            expect(Math.abs(owned.data[index] - background[0])).toBeGreaterThanOrEqual(Math.abs(before[index] - background[0]));
        }
    });

    it.each([WHITE, BLACK, [255, 180, 230, 255], [0, 110, 200, 255]])('背景%j中所有256级灰色原值不变，不生成替代处理器', (...background) => {
        const owned = image(258, 48, background);
        for (let gray = 0; gray < 256; gray += 1) setPixel(owned, gray + 1, 24, [gray, gray, gray, 255]);
        const before = owned.data.slice(), adapter = createMangaOcrColorAdapter(), replace = vi.fn();adapter.beginPage();
        expect(adapter.transform(258, 48, () => owned, replace)).toBeUndefined();
        expect(owned.data).toEqual(before);expect(replace).not.toHaveBeenCalled();
    });

    it.each([WHITE, BLACK])('边缘 G/B 不同但 R 都为端点%j时完整取亮度极值，边缘彩色也能变化', (...background) => {
        const owned = image(8, 48, background), endpoint = background[0];
        setPixel(owned, 3, 0, endpoint === 255 ? [255, 0, 0, 255] : [0, 255, 255, 255]);
        setPixel(owned, 0, 20, endpoint === 255 ? [255, 0, 255, 255] : [0, 200, 255, 255]);
        const before = owned.data.slice(), adapter = createMangaOcrColorAdapter();adapter.beginPage();
        expect(adapter.transform(8, 48, () => owned, value => value)).toBe(owned);
        expect(owned.data[3 * 4]).not.toBe(before[3 * 4]);
    });

    it('单像素宽的完整边缘同样有界，不重复要求不存在的另一侧', () => {
        const owned = image(1);setPixel(owned, 0, 24, [255, 0, 255, 255]);
        const adapter = createMangaOcrColorAdapter();adapter.beginPage();
        expect(adapter.transform(1, 48, () => owned, value => value)).toBe(owned);
    });

    it.each([[3, 0], [3, 47], [0, 20], [7, 20]])('完整外边任一 R 不同就使用原处理器：%s/%s', (x, y) => {
        const owned = image();setPixel(owned, 3, 20, [255, 0, 255, 255]);setPixel(owned, x, y, [254, 255, 255, 255]);
        const before = owned.data.slice(), adapter = createMangaOcrColorAdapter(), replace = vi.fn();adapter.beginPage();
        expect(adapter.transform(8, 48, () => owned, replace)).toBeUndefined();
        expect(owned.data).toEqual(before);expect(replace).not.toHaveBeenCalled();
    });

    it.each([[3, 0], [3, 47], [0, 20], [7, 20], [4, 30]])('边或内部含半透明像素均回退，不修改已经读出的副本：%s/%s', (x, y) => {
        const owned = image();setPixel(owned, 3, 20, [255, 0, 255, 255]);setPixel(owned, x, y, [255, 0, 255, 128]);
        const before = owned.data.slice(), adapter = createMangaOcrColorAdapter(), replace = vi.fn();adapter.beginPage();
        expect(adapter.transform(8, 48, () => owned, replace)).toBeUndefined();
        expect(owned.data).toEqual(before);expect(replace).not.toHaveBeenCalled();
    });

    it.each([[128, 20, 90, 255], [0, 0, 0, 0]])('非端点底色或隐藏透明 RGB 保持原流程：%j', (...background) => {
        const owned = image(8, 48, background), before = owned.data.slice(), adapter = createMangaOcrColorAdapter(), replace = vi.fn();adapter.beginPage();
        expect(adapter.transform(8, 48, () => owned, replace)).toBeUndefined();expect(owned.data).toEqual(before);
    });

    it.each([
        [[255, 0, 0, 255], [0, 130, 0, 255]], [[0, 130, 0, 255], [255, 0, 0, 255]],
        [[255, 0, 0, 255], [255, 255, 0, 255]],
    ])('已有 R 对比或更亮的同 R 彩色允许不改善：%j/%j', (background, foreground) => {
        const owned = image(8, 48, background);setPixel(owned, 3, 20, foreground);
        const before = owned.data.slice(), adapter = createMangaOcrColorAdapter(), replace = vi.fn();adapter.beginPage();
        expect(adapter.transform(8, 48, () => owned, replace)).toBeUndefined();expect(owned.data).toEqual(before);
        expect(replace).not.toHaveBeenCalled();
    });

    it.each([[NaN, 48], [Infinity, 48], [0, 48], [-1, 48], [1.5, 48], [Number.MAX_SAFE_INTEGER + 1, 48],
        [8, 47], [8, 49], [8, NaN], [5462, 48]])('无效尺寸或单裁图超额不产生读回/画布：%s×%s', (width, height) => {
        const adapter = createMangaOcrColorAdapter(), read = vi.fn(() => image()), replace = vi.fn();adapter.beginPage();
        expect(adapter.transform(width, height, read, replace)).toBeUndefined();expect(read).not.toHaveBeenCalled();expect(replace).not.toHaveBeenCalled();
    });

    it('接受上限内的实际整数裁图；页面预算跨多个调用共享且只在新页重置', () => {
        expect(MANGA_OCR_COLOR_CROP_PIXELS).toBe(262_144);expect(MANGA_OCR_COLOR_PAGE_PIXELS).toBe(2_000_000);
        const adapter = createMangaOcrColorAdapter(), read = vi.fn(() => image(256)), replace = vi.fn();adapter.beginPage();
        for (let call = 0; call < 164; call += 1) expect(adapter.transform(256, 48, read, replace)).toBeUndefined();
        expect(read).toHaveBeenCalledTimes(162);expect(replace).not.toHaveBeenCalled();
        adapter.endPage();adapter.transform(256, 48, read, replace);expect(read).toHaveBeenCalledTimes(162);
        adapter.beginPage();adapter.transform(256, 48, read, replace);expect(read).toHaveBeenCalledTimes(163);
        const nearCap = vi.fn(() => image(5461));adapter.transform(5461, 48, nearCap, replace);expect(nearCap).toHaveBeenCalledOnce();
    });

    it('未命中及读回异常都消耗已请求的预算，异常不泄露为模型错误', () => {
        const adapter = createMangaOcrColorAdapter(), read = vi.fn(() => {throw Error('optional read');}), replace = vi.fn();adapter.beginPage();
        for (let call = 0; call < 9; call += 1) expect(adapter.transform(5000, 48, read, replace)).toBeUndefined();
        expect(read).toHaveBeenCalledTimes(8);expect(replace).not.toHaveBeenCalled();
        adapter.beginPage();const failedWrite = vi.fn(() => {throw Error('optional canvas write');}), owned = image();setPixel(owned, 3, 20, [255, 0, 0, 255]);
        expect(adapter.transform(8, 48, () => owned, failedWrite)).toBeUndefined();expect(failedWrite).toHaveBeenCalledOnce();
    });

    it.each([undefined, null, {data: new Uint8Array(8 * 48 * 4)}, {data: new Uint8ClampedArray(4)}])('无效读回数据保留原流程：%j', value => {
        const adapter = createMangaOcrColorAdapter(), replace = vi.fn();adapter.beginPage();
        expect(adapter.transform(8, 48, () => value as MangaOcrColorImage, replace)).toBeUndefined();expect(replace).not.toHaveBeenCalled();
    });

    it('缺少页生命周期或预先取消时不读数据；新页不会继承旧 signal 或另一实例预算', () => {
        const adapter = createMangaOcrColorAdapter(), read = vi.fn(() => image()), replace = vi.fn();
        adapter.transform(8, 48, read, replace);expect(read).not.toHaveBeenCalled();
        const abort = new AbortController();abort.abort();adapter.beginPage(abort.signal);
        adapter.transform(8, 48, read, replace);expect(read).not.toHaveBeenCalled();
        adapter.beginPage();adapter.transform(8, 48, read, replace);expect(read).toHaveBeenCalledOnce();
        const other = createMangaOcrColorAdapter();other.beginPage();other.transform(8, 48, read, replace);expect(read).toHaveBeenCalledTimes(2);
    });

    it.each(['abort', 'end', 'begin'])('读回期间页状态%s改变时丢弃该次副本且不写图', kind => {
        const adapter = createMangaOcrColorAdapter(), abort = new AbortController(), owned = image(), before = owned.data.slice(), replace = vi.fn();adapter.beginPage(abort.signal);
        const read = () => {if (kind === 'abort') abort.abort();else if (kind === 'end') adapter.endPage();else adapter.beginPage();return owned;};
        expect(adapter.transform(8, 48, read, replace)).toBeUndefined();expect(replace).not.toHaveBeenCalled();expect(owned.data).toEqual(before);
    });

    it('替代画布创建前再次核对取消，已归一化的临时副本不写回原图', () => {
        let checks = 0;const signal = {get aborted() {checks += 1;return checks === 3;}} as AbortSignal;
        const adapter = createMangaOcrColorAdapter(), owned = image(), replace = vi.fn();setPixel(owned, 3, 20, [255, 0, 0, 255]);adapter.beginPage(signal);
        expect(adapter.transform(8, 48, () => owned, replace)).toBeUndefined();expect(replace).not.toHaveBeenCalled();expect(checks).toBe(3);
    });

    it('全部可达亮度锚点对256级灰色的标量输出均原样，允许跳过乘除', () => {
        let checked = 0;
        for (const endpoint of [0, 255]) for (let anchor = endpoint === 255 ? 76 : 0; anchor <= (endpoint === 255 ? 255 : 179); anchor += 1) {
            for (let gray = 0; gray < 256; gray += 1) {
                if (expectedRed(gray, gray, gray, endpoint, anchor) !== gray) throw Error('Grayscale invariant failed');
                checked += 1;
            }
        }
        expect(checked).toBe(92_160);
    });
});

describe('指定识别上下文的一次既有读回', () => {
    function ownedColor() {const owned = image();setPixel(owned, 3, 20, [255, 0, 0, 255]);return owned;}

    it('首因通知只观察错误，通知自身抛异常也不能掩盖原生读回错误',()=>{
        const failure=new Error('native read identity'),notification=new Error('notification');
        const context={getImageData:()=>{throw failure;}},native=context.getImageData,adapter=createMangaOcrColorAdapter();adapter.beginPage();
        const notify=vi.fn(()=>{throw notification;});withMangaOcrColorRead(context,8,48,adapter,undefined,notify);
        try{context.getImageData();throw Error('expected native error');}catch(error){expect(error).toBe(failure);}
        expect(context.getImageData).toBe(native);expect(notify).toHaveBeenCalledWith(failure);
    });

    it('继承方法先恢复再原生读一次，不留 own 属性；缓存的 wrapper 再次调用也不再适配', () => {
        const source = ownedColor(), before = source.data.slice(), native = vi.fn(function(this: object, ..._args: unknown[]) {
            expect(Object.hasOwn(context, 'getImageData')).toBe(false);
            return {...source, data: source.data.slice()};
        });
        const context: {getImageData(...args: unknown[]): ReturnType<typeof image>} = Object.create({getImageData: native});
        const adapter = createMangaOcrColorAdapter(), transform = vi.spyOn(adapter, 'transform');adapter.beginPage();
        const cleanup = withMangaOcrColorRead(context, 8, 48, adapter), wrapper = context.getImageData;
        expect(Object.hasOwn(context, 'getImageData')).toBe(true);
        const result = context.getImageData(0, 0, 8, 48);
        expect(result.data[(20 * 8 + 3) * 4]).toBeLessThan(255);expect(source.data).toEqual(before);
        expect(native).toHaveBeenCalledOnce();expect(native.mock.contexts[0]).toBe(context);expect(native).toHaveBeenCalledWith(0, 0, 8, 48);
        expect(context.getImageData).toBe(native);expect(Object.hasOwn(context, 'getImageData')).toBe(false);
        wrapper.call(context, 0, 0, 8, 48);expect(native).toHaveBeenCalledTimes(2);expect(transform).toHaveBeenCalledOnce();
        cleanup?.();cleanup?.();expect(Object.hasOwn(context, 'getImageData')).toBe(false);
    });

    it('已有 nonconfigurable writable 方法保留完整描述符，读前恢复原函数', () => {
        const native = vi.fn((..._args: unknown[]) => image()), context = {getImageData: native};
        Object.defineProperty(context, 'getImageData', {value: native, configurable: false, writable: true, enumerable: true});
        const descriptor = Object.getOwnPropertyDescriptor(context, 'getImageData'), adapter = createMangaOcrColorAdapter();adapter.beginPage();
        const cleanup = withMangaOcrColorRead(context, 8, 48, adapter);context.getImageData(0, 0, 8, 48);
        expect(Object.getOwnPropertyDescriptor(context, 'getImageData')).toEqual(descriptor);cleanup?.();
    });

    it('可配置的 getter/setter 描述符在从未读回的 finally 清理时原样恢复', () => {
        const native = vi.fn((..._args: unknown[]) => image()), get = () => native, set = vi.fn(), context = {} as {getImageData(...args: number[]): ReturnType<typeof image>};
        Object.defineProperty(context, 'getImageData', {get, set, enumerable: false, configurable: true});
        const descriptor = Object.getOwnPropertyDescriptor(context, 'getImageData'), adapter = createMangaOcrColorAdapter();
        const cleanup = withMangaOcrColorRead(context, 8, 48, adapter);cleanup?.();cleanup?.();
        expect(Object.getOwnPropertyDescriptor(context, 'getImageData')).toEqual(descriptor);expect(native).not.toHaveBeenCalled();expect(set).not.toHaveBeenCalled();
    });

    it.each(['frozen-own', 'nonextensible-inherited'])('不可装饰的%s上下文原路读取，清理无副作用', kind => {
        const native = vi.fn((..._args: unknown[]) => image());
        const context: {getImageData(...args: unknown[]): ReturnType<typeof image>} = kind === 'frozen-own'
            ? Object.freeze({getImageData: native}) : Object.preventExtensions(Object.create({getImageData: native}));
        const descriptor = Object.getOwnPropertyDescriptor(context, 'getImageData'), adapter = createMangaOcrColorAdapter(), transform = vi.spyOn(adapter, 'transform');adapter.beginPage();
        const restored = vi.fn(), cleanup = withMangaOcrColorRead(context, 8, 48, adapter, restored);context.getImageData(0, 0, 8, 48);
        expect(cleanup).toBeUndefined();expect(restored).not.toHaveBeenCalled();
        expect(Object.getOwnPropertyDescriptor(context, 'getImageData')).toEqual(descriptor);expect(native).toHaveBeenCalledOnce();expect(transform).not.toHaveBeenCalled();
    });

    it.each([
        [1, 0, 8, 48], [0, 1, 8, 48], [0, 0, 7, 48], [0, 0, 8, 47], [0, 0, 8],
        [0, 0, 8, 48, {colorSpace: 'display-p3'}], [0, 0, 8, 48, undefined], [0, 0, 8, 48, undefined, 'extra'],
    ])('部分区域或附加参数%j精确透传给 native，不加工数据', (...args) => {
        const owned = ownedColor(), before = owned.data.slice(), native = vi.fn((..._args: unknown[]) => owned), context = {getImageData: native};
        const adapter = createMangaOcrColorAdapter(), transform = vi.spyOn(adapter, 'transform');adapter.beginPage();
        const cleanup = withMangaOcrColorRead(context, 8, 48, adapter);
        expect(context.getImageData(...args)).toBe(owned);expect(native).toHaveBeenCalledOnce();expect(native).toHaveBeenCalledWith(...args);
        expect(transform).not.toHaveBeenCalled();expect(owned.data).toEqual(before);cleanup?.();
    });

    it('非48高度即使整幅匹配也不适配；未开始页的完整读回保留原返回对象', () => {
        const owned = ownedColor(), before = owned.data.slice(), native = vi.fn((..._args: number[]) => owned), context = {getImageData: native};
        const adapter = createMangaOcrColorAdapter(), transform = vi.spyOn(adapter, 'transform');
        withMangaOcrColorRead(context, 8, 47, adapter);expect(context.getImageData(0, 0, 8, 47)).toBe(owned);expect(transform).not.toHaveBeenCalled();
        withMangaOcrColorRead(context, 8, 48, adapter);expect(context.getImageData(0, 0, 8, 48)).toBe(owned);expect(transform).toHaveBeenCalledOnce();expect(owned.data).toEqual(before);
    });

    it('调用者 this 原样传给 native；其他接收者不能借用该上下文的适配预算', () => {
        const native = vi.fn(function(this: object, ..._args: number[]) {return ownedColor();}), context = {getImageData: native}, other = {getImageData: native};
        const adapter = createMangaOcrColorAdapter(), transform = vi.spyOn(adapter, 'transform');adapter.beginPage();
        withMangaOcrColorRead(context, 8, 48, adapter);context.getImageData.call(other, 0, 0, 8, 48);
        expect(native.mock.contexts[0]).toBe(other);expect(transform).not.toHaveBeenCalled();expect(context.getImageData).toBe(native);
    });

    it('native 读回异常保持同一错误并先恢复上下文，不落入可选颜色 catch', () => {
        const error = new Error('native canvas read'), native = vi.fn((..._args: number[]): ReturnType<typeof image> => {throw error;}), context = {getImageData: native};
        const descriptor = Object.getOwnPropertyDescriptor(context, 'getImageData'), adapter = createMangaOcrColorAdapter(), transform = vi.spyOn(adapter, 'transform');adapter.beginPage();
        const cleanup = withMangaOcrColorRead(context, 8, 48, adapter);
        try {context.getImageData(0, 0, 8, 48);throw Error('Native error was swallowed');} catch (received) {expect(received).toBe(error);}
        expect(Object.getOwnPropertyDescriptor(context, 'getImageData')).toEqual(descriptor);expect(native).toHaveBeenCalledOnce();expect(transform).not.toHaveBeenCalled();cleanup?.();
    });

    it.each(['full', 'partial-options', 'foreign-this', 'native-error'])('首次恢复在%s原生读取之前释放持有者引用，只通知一次', kind => {
        const owned = ownedColor(), error = new Error('native exact'), pending = new Set<() => void>();
        const native = vi.fn(function(this: unknown, ..._args: unknown[]) {
            expect(pending.size).toBe(0);expect(context.getImageData).toBe(native);expect(restored).toHaveBeenCalledOnce();
            if (kind === 'native-error') throw error;
            return owned;
        }), context = {getImageData: native}, other = {name: 'foreign receiver'};
        const adapter = createMangaOcrColorAdapter(), transform = vi.spyOn(adapter, 'transform');adapter.beginPage();
        const restored = vi.fn((restore: () => void) => {expect(context.getImageData).toBe(native);pending.delete(restore);});
        const cleanup = withMangaOcrColorRead(context, 8, 48, adapter, restored);
        expect(cleanup).toBeTypeOf('function');pending.add(cleanup!);
        const wrapper = context.getImageData, receiver = kind === 'foreign-this' ? other : context;
        const args = kind === 'partial-options' ? [0, 0, 7, 48, {colorSpace: 'display-p3'}] : [0, 0, 8, 48];
        if (kind === 'native-error') expect(() => wrapper.apply(receiver, args)).toThrow(error);
        else expect(wrapper.apply(receiver, args)).toBe(owned);
        expect(restored).toHaveBeenCalledWith(cleanup);expect(native.mock.contexts[0]).toBe(receiver);expect(native).toHaveBeenCalledWith(...args);
        expect(transform).toHaveBeenCalledTimes(kind === 'full' ? 1 : 0);cleanup?.();cleanup?.();expect(restored).toHaveBeenCalledOnce();expect(pending.size).toBe(0);
    });

    it('从未读取的钩子在显式清理时通知持有者，重复清理不再次通知', () => {
        const native = vi.fn((..._args: unknown[]) => image()), context = {getImageData: native}, pending = new Set<() => void>();
        const descriptor = Object.getOwnPropertyDescriptor(context, 'getImageData'), adapter = createMangaOcrColorAdapter();
        const restored = vi.fn((restore: () => void) => {expect(Object.getOwnPropertyDescriptor(context, 'getImageData')).toEqual(descriptor);pending.delete(restore);});
        const cleanup = withMangaOcrColorRead(context, 8, 48, adapter, restored);pending.add(cleanup!);
        expect(pending.size).toBe(1);cleanup?.();cleanup?.();expect(pending.size).toBe(0);expect(restored).toHaveBeenCalledOnce();expect(native).not.toHaveBeenCalled();
    });

    it.each([false, true])('释放通知抛错不替换原生读回返回值或首因：nativeThrow=%s', nativeThrow => {
        const owned = ownedColor(), error = new Error('native original'), native = vi.fn((..._args: unknown[]) => {if (nativeThrow) throw error;return owned;});
        const context = {getImageData: native}, adapter = createMangaOcrColorAdapter(), restored = vi.fn(() => {throw new Error('notification failure');});
        const cleanup = withMangaOcrColorRead(context, 8, 48, adapter, restored);
        if (nativeThrow) {
            let received: unknown;try {context.getImageData(0, 0, 8, 48);} catch (failure) {received = failure;}
            expect(received).toBe(error);
        }
        else expect(context.getImageData(0, 0, 8, 48)).toBe(owned);
        expect(context.getImageData).toBe(native);cleanup?.();expect(restored).toHaveBeenCalledOnce();expect(native).toHaveBeenCalledOnce();
    });
});
