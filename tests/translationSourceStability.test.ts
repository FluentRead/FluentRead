import {describe, expect, it} from 'vitest';
import {parseHTML} from 'linkedom';
import {isNonTranslatableLiveData} from '@/src/core/translation/liveData';
import {createTranslationSourceHistory, observeTranslationSource} from '@/src/features/full-page-translation/content/sourceStability';
import {TranslationCandidateCore, collectLiveTranslationTextSlots, extractTranslationText} from '@/src/core/translation/public';
import {isProtectedDescendantElement} from '@/src/core/translation/dom';

describe('时间、时长和动态来源过滤', () => {
    it.each([
        ['完整月日与全角展示', ['10月7日', '１０月７日', '２０２６年１０月８日'], true],
        ['时钟在日期前', ['3:19 · 2026年10月8日', '３：１９　·　２０２６年１０月８日', '3:19 PM · 10月7日'], true],
        ['时钟在日期后', ['2026年10月8日 · 3:19', '10月7日 · 3:19 PM'], true],
        ['正文前缀', ['发布于10月7日', '更新于3:19 · 2026年10月8日'], false],
        ['正文后缀', ['10月7日发布新版本', '3:19 · 2026年10月8日更新完成。'], false],
        ['缺失字段', ['10月', '7日', '2026年10月', '3:19 · 2026年10月', '2026年10月8日 · 3:', '· 10月7日'], false],
    ] as const)('独立本地日期边界：%s', (_label, values, expected) => {
        for (const value of values) expect(isNonTranslatableLiveData(value), value).toBe(expected);
    });

    it.each(['12:34', '125:32', '12:34:56.123', '12:34 PM', 'AM 8:05', '１２：３４',
        '2026-10-03T12:34:56.789Z', '2026/10/03 12:34 +08:00', '2026年10月3日',
        '2026年10月3日12时34分56秒', '5 seconds', '2 minutes ago', 'in 5 minutes',
        '1 hour, 2 minutes', '1h 2m 3s', '500 ms', '5 分钟前', '1小时2分3秒',
        '1,234', '١٢٣٤', '１２３４', '$1,234.50', '-12.5%', '99.5‰', '1.2M'])('保持独立展示值 %s', value => {
        expect(isNonTranslatableLiveData(value)).toBe(true);
    });

    it.each(['', 'The task takes 5 minutes', 'Wait 5 seconds before retrying.', 'Chapter 5',
        'The clock reads 12:34.', 'minutes', 'seconds', 'May 5 brings a new release.',
        'This report contains 1,234 records.', '任务将在5分钟后完成。', '1 '.repeat(100) + 'seconds'])('保留正常正文 %s', value => {
        expect(isNonTranslatableLiveData(value)).toBe(false);
    });

    const independentDisplayCases = [
        ['时钟字段与空白', ['0:00', '23:59', '999:59', '12 : 34 : 56', '12:34:56,789', '\t12:34\nPM ', '１２ : ３４ : ５６.７８９ ＰＭ']],
        ['上午下午与时区', ['12:34 a.m.', 'p.m. 8:05', '12:34 UTC', '12:34 GMT+08:00', '12:34 +0800', '12:34:56-0530', '12:34:56.123Z']],
        ['数字日期与组合日期', ['2026-1-2', '2026/1/2', '2026-10-03T12:34:56+0800', '2026年1月2日 8點05分30秒', '2026年10月3日 12:34', '2026年10月3日 12:34 PM', '8:05 PM · 2026/10/03', '2026-10-03 · 8:05 PM']],
        ['时长数值与分隔符', ['0 seconds', '-5 seconds', '+2 min', '0.5 seconds', '1,5 minutes', '2secs', '2 mins', '1h,2m,3s', '\u00a05\u202fminutes\u00a0']],
        ['带点单位缩写', ['2 min.', '2 secs.', '1 hr. 2 min. 3 sec.', '500 msec.', '500 msecs.', 'in 2 hrs.', '2 mins. ago', '2 min. AGO', '1h 2 min. 3 seconds ago']],
        ['繁体与混合中文时长', ['5 分鐘前', '5 分鐘後', '1小時2分3秒', '1 小時 2 分鐘 3 秒', '5 秒鐘', '500 毫秒', '５　分鐘後']],
    ] as const;

    it.each(independentDisplayCases.flatMap(([label, values]) => values.map(value => [label, value] as const)))('独立展示矩阵：%s %s', (_label, value) => {
        expect(isNonTranslatableLiveData(value)).toBe(true);
    });

    it.each(['3 PM', '8 a.m.', 'AM 8', '下午3:05', '上午 8:05', '下午3点05分',
        '上午8時05分30秒', '2026年10月3日 上午8时05分', '２０２６年１０月３日　下午３：０５'])('仅小时或中文时钟展示保持原样 %s', value => {
        expect(isNonTranslatableLiveData(value)).toBe(true);
    });

    it.each(['3 PM is the start time.', 'The meeting begins at 8 a.m.', 'AM radio broadcasts the news.',
        '下午3:05开始会议', '上午 8:05 更新完成', '2026年10月3日 上午8时05分发布报告'])('小时与中文时钟出现在正文仍可译 %s', value => {
        expect(isNonTranslatableLiveData(value)).toBe(false);
    });

    it.each([
        'hours', 'milliseconds', 'mins.', 'Time', 'UTC is a time zone.',
        'The timer says 5 sec.', 'The task takes 1 hr. 2 min.', '5 minutes before dinner',
        '1 hour of work', '3 PM meetings happen weekly.', '2026年10月3日發布新版本',
        '5 秒內重試', '請等待 5 分鐘後重試', 'The units are seconds and minutes.',
        '12:34 PM is the scheduled start.', 'Version 12:34 has new features.',
    ])('时长或时间出现在正文仍可译 %s', value => {
        expect(isNonTranslatableLiveData(value)).toBe(false);
    });

    it.each([
        ['普通时长节点', '<span id="value">5 minutes</span>'],
        ['分隔时长节点', '<span id="value"><b>5</b> minutes</span>'],
        ['多个单位嵌套', '<span id="value"><b>1</b> hour, <i>2</i> minutes</span>'],
        ['分隔时钟节点', '<span id="value"><b>12</b>:<i>34</i> PM</span>'],
        ['全角分隔时钟', '<span id="value">１２：<b>３４</b><i> PM</i></span>'],
        ['繁体时长节点', '<span id="value">5 分鐘前</span>'],
        ['time 标签', '<time id="value"><b>5</b> minutes ago</time>'],
        ['timer 角色', '<span id="value" role="timer"><b>5</b> seconds remaining</span>'],
        ['aria-live 中独立值', '<span id="value" aria-live="polite">5 minutes</span>'],
    ])('嵌套展示矩阵不泄漏数字或单位且保留宿主页：%s', (_label, markup) => {
        const {document} = parseHTML(`<html><body><main><p id="prose">A readable report. ${markup} The next section is ready.</p></main></body></html>`);
        const core = new TranslationCandidateCore({adapters: []});
        const prose = document.querySelector<HTMLElement>('#prose')!;
        const display = document.querySelector<HTMLElement>('#value')!;
        const displayBefore = display.outerHTML;
        expect(core.discover(document.documentElement).map(candidate => candidate.element.id)).toEqual(['prose']);
        expect(core.resolve(prose)?.element).toBe(prose);
        expect(extractTranslationText(prose)).toBe('A readable report. The next section is ready.');
        expect(collectLiveTranslationTextSlots(prose).map(slot => slot.source)).toEqual(['A readable report.', 'The next section is ready.']);
        expect(display.outerHTML).toBe(displayBefore);
    });

    it('aria-live 普通消息和单独单位不按时钟或 timer 屏蔽', () => {
        const {document} = parseHTML('<html><body><main><p id="message" aria-live="polite">A complete article is ready.</p><p id="unit">minutes</p></main></body></html>');
        const core = new TranslationCandidateCore({adapters: []});
        expect(core.discover(document.documentElement).map(candidate => candidate.element.id)).toEqual(['message', 'unit']);
        for (const id of ['message', 'unit']) {
            const element = document.querySelector<HTMLElement>(`#${id}`)!;
            expect(core.resolve(element)?.element).toBe(element);
            expect(extractTranslationText(element)).toBe(element.textContent);
            expect(collectLiveTranslationTextSlots(element).map(slot => slot.source)).toEqual([element.textContent]);
        }
    });

    it.each([
        ['hidden', '<span hidden>5 </span>'],
        ['aria-hidden', '<span aria-hidden="true">5 </span>'],
        ['无障碍辅助文字', '<span class="sr-only">5 </span>'],
        ['translate=no', '<span translate="no">5 </span>'],
        ['notranslate', '<span class="notranslate">5 </span>'],
        ['行内代码', '<code>5 </code>'],
    ])('隐藏或受保护数字不使相邻独立单位被误过滤：%s', (_label, prefix) => {
        const {document} = parseHTML(`<html><body><main><p id="unit">${prefix}minutes</p></main></body></html>`);
        const core = new TranslationCandidateCore({adapters: []});
        const unit = document.querySelector<HTMLElement>('#unit')!;
        expect(core.discover(document.documentElement).map(candidate => candidate.element.id)).toEqual(['unit']);
        expect(core.resolve(unit)?.element).toBe(unit);
        expect(extractTranslationText(unit)).toBe('minutes');
        expect(collectLiveTranslationTextSlots(unit).map(slot => slot.source)).toEqual(['minutes']);
    });

    it.each(['p', 'div', 'li'])('不同块的数字与独立单位不合并为时长：%s', tag => {
        const {document} = parseHTML(`<html><body><main><section id="blocks"><${tag}>5</${tag}><${tag} id="unit">minutes</${tag}></section></main></body></html>`);
        const core = new TranslationCandidateCore({adapters: []});
        const unit = document.querySelector<HTMLElement>('#unit')!;
        expect(core.discover(document.documentElement).map(candidate => candidate.element.id)).toEqual(['unit']);
        expect(core.resolve(unit)?.element).toBe(unit);
        expect(extractTranslationText(document.querySelector('#blocks')!)).toBe('minutes');
        expect(collectLiveTranslationTextSlots(unit).map(slot => slot.source)).toEqual(['minutes']);
    });

    it.each(['hidden', 'aria-hidden="true"', 'class="visually-hidden"'])('隐藏说明前缀不使可见的分隔时长漏出单位：%s', marker => {
        const {document} = parseHTML(`<html><body><main><p id="prose">A readable report. <span id="value"><span ${marker}>Clock </span><b>5</b> minutes</span> The next section is ready.</p></main></body></html>`);
        const prose = document.querySelector<HTMLElement>('#prose')!;
        expect(extractTranslationText(prose)).toBe('A readable report. The next section is ready.');
        expect(collectLiveTranslationTextSlots(prose).map(slot => slot.source)).toEqual(['A readable report.', 'The next section is ready.']);
    });

    it('动态展示变成正常正文后下一轮重新计算保护状态，再变回时长仍保持原样', () => {
        const {document} = parseHTML('<html><body><main><p id="value"><b>5</b> minutes</p></main></body></html>');
        const core = new TranslationCandidateCore({adapters: []});
        const display = document.querySelector<HTMLElement>('#value')!;
        expect(core.discover(document.documentElement)).toEqual([]);
        expect(collectLiveTranslationTextSlots(display)).toEqual([]);
        display.textContent = 'A complete article is ready.';
        expect(core.discover(document.documentElement).map(candidate => candidate.element.id)).toEqual(['value']);
        expect(extractTranslationText(display)).toBe('A complete article is ready.');
        expect(collectLiveTranslationTextSlots(display).map(slot => slot.source)).toEqual(['A complete article is ready.']);
        display.innerHTML = '<b>2</b> min.';
        expect(core.discover(document.documentElement)).toEqual([]);
        expect(extractTranslationText(display)).toBe('');
        expect(collectLiveTranslationTextSlots(display)).toEqual([]);
    });

    it.each([26, 27, 28, 64])('展示扫描接近或超出节点预算仍保留后续正文：%s 个空包装', wrappers => {
        const {document} = parseHTML(`<html><body><main><p id="prose"><b>5</b> minutes ${'<span></span>'.repeat(wrappers)}before dinner.</p></main></body></html>`);
        const core = new TranslationCandidateCore({adapters: []});
        const prose = document.querySelector<HTMLElement>('#prose')!;
        expect(core.resolve(prose)?.element).toBe(prose);
        expect(extractTranslationText(prose)).toBe('minutes before dinner.');
        expect(collectLiveTranslationTextSlots(prose).map(slot => slot.source.trim())).toEqual(['minutes', 'before dinner.']);
    });

    it.each([128, 129, 512])('超过或达到字符预算的正文不按开头时长过滤：%s 字符', length => {
        const prefix = '5 minutes ';
        const text = prefix + 'x'.repeat(length - prefix.length - ' before dinner.'.length) + ' before dinner.';
        const {document} = parseHTML(`<html><body><main><p id="prose">${text}</p></main></body></html>`);
        const core = new TranslationCandidateCore({adapters: []});
        const prose = document.querySelector<HTMLElement>('#prose')!;
        expect(core.resolve(prose)?.element).toBe(prose);
        expect(extractTranslationText(prose)).toBe(text);
        expect(collectLiveTranslationTextSlots(prose).map(slot => slot.source)).toEqual([text]);
    });

    it('悬浮、全文和文本槽共享规则，嵌套时钟不会屏蔽相邻正文', () => {
        const {document} = parseHTML('<html><body><main><p id="time">12:34 PM</p><p id="duration">5 minutes</p><p id="prose">A readable report. <span>1,234</span><time>5 minutes ago</time><span role="timer"><b>5</b> seconds</span></p></main></body></html>');
        const core = new TranslationCandidateCore({adapters: []});
        const prose = document.querySelector<HTMLElement>('#prose')!;
        expect(core.discover(document.documentElement).map(candidate => candidate.element.id)).toEqual(['prose']);
        expect(core.resolve(document.querySelector('#time')!)).toBeNull();
        expect(core.resolve(document.querySelector('#duration')!)).toBeNull();
        expect(core.resolve(prose)?.element).toBe(prose);
        expect(collectLiveTranslationTextSlots(prose).map(slot => slot.source)).toEqual(['A readable report.']);
        expect(extractTranslationText(prose)).toBe('A readable report.');
        prose.querySelector('span')!.textContent = '1,235';
        expect(extractTranslationText(prose)).toBe('A readable report.');
    });

    function fixture() {
        const {document} = parseHTML('<html><body><p>Visitors: 100</p></body></html>');
        return {history: createTranslationSourceHistory(), identity: document.querySelector('p')!};
    }

    it('自有原文槽仅绕过自身 translate=no，其他禁译标记仍有效', () => {
        const {document} = parseHTML('<html><body><span translate="no" data-fr-translation-owned="true">Original slot</span></body></html>');
        const slot = document.querySelector('span')!;
        const options = {sourceTextSlotHosts: new Set([slot])};
        expect(isProtectedDescendantElement(slot, false, options)).toBe(false);
        slot.classList.add('notranslate');
        expect(isProtectedDescendantElement(slot, false, options)).toBe(true);
        slot.classList.remove('notranslate');
        slot.setAttribute('data-notranslate', 'true');
        expect(isProtectedDescendantElement(slot, false, options)).toBe(true);
        slot.removeAttribute('data-notranslate');
        slot.removeAttribute('translate');
        expect(isProtectedDescendantElement(slot, false, options)).toBe(false);
    });

    it('已知数值原文槽参与完整时长判定，自加 notranslate 后仍遵守局部禁译', () => {
        const {document} = parseHTML('<html><body><main><p id="value"><span id="source" translate="no" data-fr-translation-owned="true">5</span> minutes</p></main></body></html>');
        const display = document.querySelector<HTMLElement>('#value')!;
        const source = document.querySelector<HTMLElement>('#source')!;
        const options = {sourceTextSlotHosts: new Set([source])};
        expect(isProtectedDescendantElement(source, false, options)).toBe(false);
        expect(extractTranslationText(display)).toBe('minutes');
        expect(extractTranslationText(display, undefined, undefined, options)).toBe('');
        expect(collectLiveTranslationTextSlots(display, undefined, undefined, options)).toEqual([]);
        source.classList.add('notranslate');
        expect(isProtectedDescendantElement(source, false, options)).toBe(true);
        expect(extractTranslationText(display, undefined, undefined, options)).toBe('minutes');
        expect(collectLiveTranslationTextSlots(display, undefined, undefined, options).map(slot => slot.source)).toEqual(['minutes']);
        expect(source.textContent).toBe('5');
    });

    it('已知原文槽例外不使隐藏数值参与相邻可见单位判定', () => {
        const {document} = parseHTML('<html><body><main><p id="value"><span id="source" hidden translate="no" data-fr-translation-owned="true">5</span> minutes</p></main></body></html>');
        const display = document.querySelector<HTMLElement>('#value')!;
        const source = document.querySelector<HTMLElement>('#source')!;
        const options = {sourceTextSlotHosts: new Set([source])};
        expect(isProtectedDescendantElement(source, false, options)).toBe(true);
        expect(extractTranslationText(display, undefined, undefined, options)).toBe('minutes');
        expect(collectLiveTranslationTextSlots(display, undefined, undefined, options).map(slot => slot.source)).toEqual(['minutes']);
    });

    it.each(['hidden', 'aria-hidden="true"', 'class="visually-hidden"'])('已知数值原文槽与隐藏前缀同时存在时仍过滤完整展示：%s', marker => {
        const {document} = parseHTML(`<html><body><main><p id="prose">A readable report. <span id="value"><span ${marker}>Clock </span><span id="source" translate="no" data-fr-translation-owned="true">5</span> minutes</span> The next section is ready.</p></main></body></html>`);
        const prose = document.querySelector<HTMLElement>('#prose')!;
        const display = document.querySelector<HTMLElement>('#value')!;
        const source = document.querySelector<HTMLElement>('#source')!;
        const options = {sourceTextSlotHosts: new Set([source])};
        const displayBefore = display.outerHTML;
        expect(extractTranslationText(prose, undefined, undefined, options)).toBe('A readable report. The next section is ready.');
        expect(collectLiveTranslationTextSlots(prose, undefined, undefined, options).map(slot => slot.source)).toEqual(['A readable report.', 'The next section is ready.']);
        expect(display.outerHTML).toBe(displayBefore);
    });

    it('持续数字变化收敛为原文，重复观察、长间隔及静止都不会重启翻译', () => {
        const {history, identity} = fixture();
        const observe = (value: string, now: number) => observeTranslationSource(history, identity, value, now);
        expect(observe('Visitors: 100', 0)).toEqual({kind: 'ready'});
        expect(observe('Visitors: 101', 500)).toEqual({kind: 'settling', delay: 1800});
        expect(observe('Visitors: 101', 1000)).toEqual({kind: 'settling', delay: 1300});
        expect(observe('Visitors: 102', 1500)).toEqual({kind: 'numeric'});
        expect(observe('Visitors: 103', 10000)).toEqual({kind: 'numeric'});
        expect(observe('Visitors: 103', 20000)).toEqual({kind: 'numeric'});
        expect(observe('A new article is ready.', 21000)).toEqual({kind: 'settling', delay: 1800});
        expect(observe('A new article is ready.', 22800)).toEqual({kind: 'ready'});
    });

    it('普通动态内容在最后一次真实变化后恢复，重复发现不会延长窗口', () => {
        const {history, identity} = fixture();
        const observe = (value: string, now: number) => observeTranslationSource(history, identity, value, now);
        expect(observe('Loading the first section.', 0)).toEqual({kind: 'ready'});
        expect(observe('Loading the next section.', 200)).toEqual({kind: 'settling', delay: 1800});
        expect(observe('A complete article is ready.', 600)).toEqual({kind: 'settling', delay: 1800});
        expect(observe(' A complete article is ready. ', 2000)).toEqual({kind: 'settling', delay: 400});
        expect(observe('A complete article is ready.', 2400)).toEqual({kind: 'ready'});
    });

    it('每 2.2 秒变化的普通正文从第二次真实变化起始终等候，停止后按节奏恢复', () => {
        const {history, identity} = fixture();
        const observe = (revision: number, now: number) => observeTranslationSource(history, identity, `Article revision ${revision} is complete.`, now);
        expect(observe(0, 0)).toEqual({kind: 'ready'});
        expect(observe(1, 2200)).toEqual({kind: 'settling', delay: 1800});
        for (let revision = 2; revision <= 5; revision += 1) {
            const changedAt = revision * 2200;
            expect(observe(revision, changedAt)).toEqual({kind: 'settling', delay: 3300});
            expect(observe(revision, changedAt + 2199)).toEqual({kind: 'settling', delay: 1101});
        }
        expect(observe(5, 14299)).toEqual({kind: 'settling', delay: 1});
        expect(observe(5, 14300)).toEqual({kind: 'ready'});
    });

    it.each([0, -1, 10001])('不可信或过长变化间隔回到基础安静窗口：%s ms', gap => {
        const {history, identity} = fixture();
        const observe = (revision: number, now: number) => observeTranslationSource(history, identity, `Article revision ${revision} is complete.`, now);
        observe(0, 0);
        observe(1, 1000);
        expect(observe(2, 4000)).toEqual({kind: 'settling', delay: 4500});
        const changedAt = 4000 + gap;
        expect(observe(3, changedAt)).toEqual({kind: 'settling', delay: 1800});
        expect(observe(3, changedAt + 1799)).toEqual({kind: 'settling', delay: 1});
        expect(observe(3, changedAt + 1800)).toEqual({kind: 'ready'});
    });

    it.each([7000, 10000])('慢变化安静窗口上限为十秒：%s ms 间隔', gap => {
        const {history, identity} = fixture();
        const observe = (revision: number, now: number) => observeTranslationSource(history, identity, `Article revision ${revision} is complete.`, now);
        observe(0, 0);
        observe(1, 100);
        const changedAt = 100 + gap;
        expect(observe(2, changedAt)).toEqual({kind: 'settling', delay: 10000});
        expect(observe(2, changedAt + 9999)).toEqual({kind: 'settling', delay: 1});
        expect(observe(2, changedAt + 10000)).toEqual({kind: 'ready'});
    });

    it('短暂更快变化和重复观察不缩短近期较慢节奏', () => {
        const {history, identity} = fixture();
        const observe = (revision: number, now: number) => observeTranslationSource(history, identity, `Article revision ${revision} is complete.`, now);
        observe(0, 0);
        observe(1, 2200);
        expect(observe(2, 4400)).toEqual({kind: 'settling', delay: 3300});
        expect(observe(3, 6500)).toEqual({kind: 'settling', delay: 3300});
        expect(observe(3, 7200)).toEqual({kind: 'settling', delay: 2600});
        expect(observe(4, 7500)).toEqual({kind: 'settling', delay: 3300});
        expect(observe(4, 10800)).toEqual({kind: 'ready'});
    });

    it('近期峰值恰好十秒仍有效，超过十秒后收敛到新的稳定节奏', () => {
        const {history, identity} = fixture();
        const observe = (revision: number, now: number) => observeTranslationSource(history, identity, `Article revision ${revision} is complete.`, now);
        observe(0, 0);
        observe(1, 1000);
        expect(observe(2, 4000)).toEqual({kind: 'settling', delay: 4500});
        for (let revision = 3; revision <= 7; revision += 1) {
            expect(observe(revision, 4000 + (revision - 2) * 2000)).toEqual({kind: 'settling', delay: 4500});
        }
        expect(observe(8, 16000)).toEqual({kind: 'settling', delay: 3000});
        expect(observe(8, 18999)).toEqual({kind: 'settling', delay: 1});
        expect(observe(8, 19000)).toEqual({kind: 'ready'});
    });

    it.each(['The task takes 5 minutes', 'The task takes 5 minutes.', '说明'.repeat(17) + '5', 'text '.repeat(25) + '5'])('包含数字的正常句子不被永久屏蔽 %s', original => {
        const {history, identity} = fixture();
        observeTranslationSource(history, identity, original, 0);
        expect(observeTranslationSource(history, identity, original.replace('5', '6'), 200).kind).toBe('settling');
        expect(observeTranslationSource(history, identity, original.replace('5', '7'), 400).kind).toBe('settling');
        expect(observeTranslationSource(history, identity, original.replace('5', '7'), 2200).kind).toBe('ready');
    });

    it('缓慢修改、不同标签和其他候选分别计数', () => {
        const {history, identity} = fixture();
        observeTranslationSource(history, identity, 'Visitors: 1', 0);
        expect(observeTranslationSource(history, identity, 'Visitors: 2', 5000).kind).toBe('settling');
        expect(observeTranslationSource(history, identity, 'Visitors: 3', 10000).kind).toBe('settling');
        expect(observeTranslationSource(history, identity, 'Orders: 4', 10200).kind).toBe('settling');
        expect(observeTranslationSource(history, identity.cloneNode(), 'Visitors: 3', 10300).kind).toBe('ready');
        expect(observeTranslationSource(history, identity, '100', 11000).kind).toBe('settling');
    });
});
