import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {isAnchorNearViewport, TranslationSourceStabilityGate} from '@/src/features/full-page-translation/content/sourceStabilityGate';
import {getTranslationCandidateKey, type TranslationCandidate} from '@/src/core/translation/public';

function createSession() {
    return {translationMode:'all', scheduled:new Map<Node, TranslationCandidate>(), candidateAnchors:new Map<Node, HTMLElement>(),
        unchangedCandidates:new WeakMap<Node, unknown>(), lifecycleRetries:new WeakMap<Node, unknown>()};
}

function fixture() {
    const {document} = parseHTML('<html><body><p>Visitors: 1</p></body></html>');
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', {innerWidth:1280, innerHeight:900, setTimeout:globalThis.setTimeout, clearTimeout:globalThis.clearTimeout});
    const element = document.querySelector<HTMLElement>('p')!;
    const candidate: TranslationCandidate = {element, kind:'content', reason:'source-stability'};
    const session = createSession();
    const ports = {isCurrent:vi.fn<(_session: typeof session) => boolean>(() => true),
        resolve:vi.fn<(fresh: TranslationCandidate) => TranslationCandidate | null>(fresh => fresh),
        discover:vi.fn((_session: typeof session, fresh:TranslationCandidate) => {_session.scheduled.set(getTranslationCandidateKey(fresh), {...fresh, scope:'all'});}),
        source:vi.fn<(_candidate: TranslationCandidate) => string>(() => 'The latest source.'), queue:vi.fn(), drain:vi.fn()};
    const gate = new TranslationSourceStabilityGate(ports);
    gate.blocks(candidate, 'Visitors: 1', session);
    return {document, element, candidate, session, ports, gate};
}

describe('动态来源安静窗口调度', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});

    it('只在最后一次变化后调度最新候选，清理旧 unchanged / retry 墓碑', async () => {
        const {candidate, session, ports, gate} = fixture();
        session.unchangedCandidates.set(candidate.element, 'old');
        session.lifecycleRetries.set(candidate.element, 'old');
        expect(gate.blocks(candidate,'Preparing the next section.',session)).toBe(true);
        await vi.advanceTimersByTimeAsync(500);
        expect(gate.blocks(candidate,'The latest source.',session)).toBe(true);
        await vi.advanceTimersByTimeAsync(1700);
        expect(ports.queue).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(100);
        expect(session.unchangedCandidates.has(candidate.element)).toBe(false);
        expect(session.lifecycleRetries.has(candidate.element)).toBe(false);
        expect(ports.queue).toHaveBeenCalledWith(session,candidate.element,session.scheduled.get(candidate.element),'The latest source.');
        expect(ports.drain).toHaveBeenCalledOnce();
        expect(gate.blocks(candidate,'The latest source.',session)).toBe(false);
    });

    it('高频正文更新只保留一个安静窗口，稳定后仅派发最新来源一次', async () => {
        const {candidate, session, ports, gate} = fixture();
        let source = '';
        for (let index = 0; index < 500; index += 1) {
            source = `The article is being updated with section ${index}.`;
            expect(gate.blocks(candidate, source, session)).toBe(true);
            expect(vi.getTimerCount()).toBe(1);
            await vi.advanceTimersByTimeAsync(16);
        }
        expect(ports.queue).not.toHaveBeenCalled();
        ports.source.mockReturnValue(source);
        await vi.advanceTimersByTimeAsync(1800);
        expect(ports.queue).toHaveBeenCalledOnce();
        expect(ports.queue.mock.calls[0][3]).toBe(source);
        expect(ports.drain).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        gate.dispose(session);
    });

    it.each([16, 250, 1000, 1500])('非数字状态每 %s ms 轮换时保持原文，安静窗口边界只唤醒一次', async cadence => {
        const {element, candidate, session, ports, gate} = fixture();
        const states = ['Preparing the request.', 'Waiting for the server.', 'Receiving the response.', 'Checking the response.'];
        ports.source.mockImplementation(fresh => fresh.element.textContent ?? '');
        for (let index = 0; index < 12; index += 1) {
            element.textContent = states[index % states.length]!;
            expect(gate.blocks(candidate, element.textContent!, session)).toBe(true);
            expect(vi.getTimerCount()).toBe(1);
            if (index < 11) await vi.advanceTimersByTimeAsync(cadence);
            expect(ports.queue).not.toHaveBeenCalled();
        }
        const latestSource = element.textContent;
        const quiet = cadence === 1500 ? 2250 : 1800;
        await vi.advanceTimersByTimeAsync(quiet - 1);
        expect(ports.queue).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(ports.queue).toHaveBeenCalledOnce();
        expect(ports.queue).toHaveBeenCalledWith(session, element, session.scheduled.get(element), latestSource);
        expect(ports.drain).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(gate.blocks(candidate, latestSource!, session)).toBe(false);
        expect(ports.queue).toHaveBeenCalledOnce();
    });

    it('一个候选持续更新不会推迟相邻候选的安静窗口或混用来源', async () => {
        const {document, element, candidate, session, ports, gate} = fixture();
        const neighbor = document.createElement('p');
        neighbor.textContent = 'The neighboring paragraph is ready.';
        document.body.append(neighbor);
        const neighboringCandidate: TranslationCandidate = {element: neighbor, kind: 'content', reason: 'neighbor-stability'};
        ports.source.mockImplementation(fresh => fresh.element.textContent ?? '');
        expect(gate.blocks(neighboringCandidate, 'The neighboring paragraph is loading.', session)).toBe(false);
        element.textContent = 'Waiting for the server.';
        expect(gate.blocks(candidate, element.textContent!, session)).toBe(true);
        expect(gate.blocks(neighboringCandidate, neighbor.textContent!, session)).toBe(true);
        await vi.advanceTimersByTimeAsync(1000);
        element.textContent = 'Receiving the response.';
        expect(gate.blocks(candidate, element.textContent!, session)).toBe(true);
        expect(vi.getTimerCount()).toBe(2);
        await vi.advanceTimersByTimeAsync(800);
        expect(ports.queue).toHaveBeenCalledOnce();
        expect(ports.queue).toHaveBeenLastCalledWith(session, neighbor, session.scheduled.get(neighbor), neighbor.textContent);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(999);
        expect(ports.queue).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
        expect(ports.queue).toHaveBeenCalledTimes(2);
        expect(ports.queue).toHaveBeenLastCalledWith(session, element, session.scheduled.get(element), element.textContent);
        expect(ports.drain).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('取消一个会话只清理其 timer，其他会话仍处理自己的最新候选', async () => {
        const {document, element, candidate, session, ports, gate} = fixture();
        const otherElement = document.createElement('p');
        otherElement.textContent = 'The other session has completed its source.';
        document.body.append(otherElement);
        const otherCandidate: TranslationCandidate = {element: otherElement, kind: 'content', reason: 'other-session-stability'};
        const otherSession = createSession();
        ports.source.mockImplementation(fresh => fresh.element.textContent ?? '');
        expect(gate.blocks(otherCandidate, 'The other session is waiting.', otherSession)).toBe(false);
        expect(gate.blocks(candidate, 'The cancelled session is waiting.', session)).toBe(true);
        expect(gate.blocks(otherCandidate, otherElement.textContent!, otherSession)).toBe(true);
        expect(vi.getTimerCount()).toBe(2);
        await vi.advanceTimersByTimeAsync(900);
        gate.dispose(session);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(900);
        expect(ports.queue).toHaveBeenCalledOnce();
        expect(ports.queue).toHaveBeenCalledWith(otherSession, otherElement, otherSession.scheduled.get(otherElement), otherElement.textContent);
        expect(ports.drain).toHaveBeenCalledWith(otherSession);
        expect(session.scheduled.has(element)).toBe(false);
        gate.dispose(otherSession);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('恢复时取消等待，关闭期间宿主继续变化不会派发，重新启动后处理最新来源', async () => {
        const {element, candidate, session, ports, gate} = fixture();
        ports.source.mockImplementation(fresh => fresh.element.textContent ?? '');
        element.textContent = 'Waiting for the server.';
        expect(gate.blocks(candidate, element.textContent!, session)).toBe(true);
        await vi.advanceTimersByTimeAsync(500);
        element.textContent = 'Receiving the response.';
        expect(gate.blocks(candidate, element.textContent!, session)).toBe(true);
        await vi.advanceTimersByTimeAsync(100);
        gate.dispose(session);
        ports.isCurrent.mockReturnValue(false);
        expect(vi.getTimerCount()).toBe(0);
        // 恢复后 runtime 已断开观察器，宿主可继续更新，但不会再调用门禁。
        for (const source of ['Checking the response.', 'Preparing the result.', 'The final article is ready.']) {
            element.textContent = source;
            await vi.advanceTimersByTimeAsync(1000);
        }
        expect(ports.queue).not.toHaveBeenCalled();
        expect(ports.drain).not.toHaveBeenCalled();
        const restarted = createSession();
        ports.isCurrent.mockImplementation(current => current === restarted);
        expect(gate.blocks(candidate, element.textContent!, restarted)).toBe(true);
        // 来源历史仍在；距离最后观察的真实变化 3100 ms，自适应窗口为 4650 ms。
        await vi.advanceTimersByTimeAsync(4649);
        expect(ports.queue).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(ports.queue).toHaveBeenCalledOnce();
        expect(ports.queue).toHaveBeenCalledWith(restarted, element, restarted.scheduled.get(element), 'The final article is ready.');
        expect(ports.drain).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['Orders: 3', 'The final report is ready.'])('数字标签换成 %s 后解除持续禁译并等待安静窗口', async replacement => {
        const {element, candidate, session, ports, gate} = fixture();
        ports.source.mockImplementation(fresh => fresh.element.textContent ?? '');
        expect(gate.blocks(candidate, 'Visitors: 2', session)).toBe(true);
        await vi.advanceTimersByTimeAsync(500);
        expect(gate.blocks(candidate, 'Visitors: 3', session)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(10000);
        expect(gate.blocks(candidate, 'Visitors: 3', session)).toBe(true);
        expect(ports.queue).not.toHaveBeenCalled();
        element.textContent = replacement;
        expect(gate.blocks(candidate, replacement, session)).toBe(true);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(1799);
        expect(ports.queue).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(ports.queue).toHaveBeenCalledOnce();
        expect(ports.queue).toHaveBeenCalledWith(session, element, session.scheduled.get(element), replacement);
        expect(gate.blocks(candidate, replacement, session)).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('每 2200 ms 更新的正文识别节奏后保持原文，停止后 3300 ms 只唤醒最新来源', async () => {
        const {element, candidate, session, ports, gate} = fixture();
        ports.source.mockImplementation(fresh => fresh.element.textContent ?? '');
        for (let index = 0; index < 6; index += 1) {
            element.textContent = `The server is processing phase ${index}.`;
            expect(gate.blocks(candidate, element.textContent!, session)).toBe(true);
            if (index === 0) {
                // 第一次真实变化还没有更新间隔可供估计，保留既有安静窗口。
                await vi.advanceTimersByTimeAsync(2200);
                expect(ports.queue).toHaveBeenCalledOnce();
                ports.queue.mockClear();
                ports.drain.mockClear();
            } else if (index < 5) {
                await vi.advanceTimersByTimeAsync(2200);
                expect(ports.queue).not.toHaveBeenCalled();
            }
        }
        await vi.advanceTimersByTimeAsync(3299);
        expect(ports.queue).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(ports.queue).toHaveBeenCalledOnce();
        expect(ports.queue).toHaveBeenCalledWith(session, element, session.scheduled.get(element), element.textContent);
        expect(ports.drain).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['status', 'numeric'] as const)('整个 %s 候选反复替换时交接同槽历史并取消旧 timer', async kind => {
        const {document, element, candidate, session, ports, gate} = fixture();
        ports.source.mockImplementation(fresh => fresh.element.textContent ?? '');
        let current = candidate;
        for (let index = 0; index < 8; index += 1) {
            const replacement = document.createElement('p');
            replacement.textContent = kind === 'numeric' ? `Visitors: ${index + 2}`
                : ['Waiting for the server.', 'Receiving the response.'][index % 2]!;
            current.element.replaceWith(replacement);
            current = {...candidate, element: replacement};
            expect(gate.blocks(current, replacement.textContent!, session)).toBe(true);
            expect(vi.getTimerCount()).toBe(kind === 'numeric' && index > 0 ? 0 : 1);
            await vi.advanceTimersByTimeAsync(250);
            expect(ports.queue).not.toHaveBeenCalled();
        }
        expect(element.isConnected).toBe(false);
        if (kind === 'numeric') {
            const replacement = document.createElement('p');
            replacement.textContent = 'The final article is ready.';
            current.element.replaceWith(replacement);
            current = {...candidate, element: replacement};
            expect(gate.blocks(current, replacement.textContent!, session)).toBe(true);
        }
        await vi.advanceTimersByTimeAsync(1800);
        expect(ports.queue).toHaveBeenCalledOnce();
        expect(ports.queue).toHaveBeenCalledWith(session, current.element, session.scheduled.get(current.element), current.element.textContent);
        expect(ports.drain).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('合成段首 Text 被替换时复用活 owner 的来源历史，最新 Text 只派发一次', async () => {
        const {document, element, candidate, session, ports, gate} = fixture();
        let current = {...candidate, nodes: [element.firstChild!]};
        expect(gate.blocks(current, 'Visitors: 1', session)).toBe(false);
        ports.source.mockImplementation(fresh => fresh.element.textContent ?? '');
        for (const source of ['Preparing the request.', 'Waiting for the server.', 'Receiving the response.']) {
            const replacement = document.createTextNode(source);
            current.nodes[0]!.replaceWith(replacement);
            current = {...candidate, nodes: [replacement]};
            expect(gate.blocks(current, source, session)).toBe(true);
            expect(vi.getTimerCount()).toBe(1);
            await vi.advanceTimersByTimeAsync(250);
        }
        await vi.advanceTimersByTimeAsync(1800);
        const key = current.nodes[0]!;
        expect(ports.queue).toHaveBeenCalledOnce();
        expect(ports.queue).toHaveBeenCalledWith(session, key, session.scheduled.get(key), 'Receiving the response.');
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['key', 'owner'] as const)('旧 %s 仍连接时拒绝把历史交给另一候选', async connected => {
        const {document, element, candidate, session, gate} = fixture();
        if (connected === 'key') {
            expect(gate.blocks(candidate, 'Visitors: 2', session)).toBe(true);
            const destination = document.createElement('section');
            document.body.append(destination);
            destination.append(element);
            const replacement = document.createElement('p');
            document.body.prepend(replacement);
            expect(gate.blocks({...candidate, element: replacement}, 'Visitors: 3', session)).toBe(false);
        } else {
            const span = document.createElement('span');
            span.textContent = 'Visitors: 1';
            element.replaceChildren(span);
            const oldText = span.firstChild!;
            const previous = {...candidate, nodes: [oldText]};
            expect(gate.blocks(previous, 'Visitors: 1', session)).toBe(false);
            expect(gate.blocks(previous, 'Visitors: 2', session)).toBe(true);
            const newOwner = document.createElement('p');
            document.body.append(newOwner);
            newOwner.append(span);
            const replacement = document.createTextNode('Visitors: 3');
            span.replaceChildren(replacement);
            expect(gate.blocks({...candidate, element: newOwner, nodes: [replacement]}, 'Visitors: 3', session)).toBe(false);
        }
        gate.dispose(session);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['tag', 'id', 'role', 'scope', 'reason'] as const)('替换候选的 %s 语义改变时从独立历史开始', change => {
        const {document, element, candidate, session, gate} = fixture();
        gate.blocks(candidate, 'Visitors: 2', session);
        const replacement = document.createElement(change === 'tag' ? 'section' : 'p');
        if (change === 'id') replacement.id = 'another-owner';
        if (change === 'role') replacement.setAttribute('role', 'status');
        element.replaceWith(replacement);
        const fresh = {...candidate, element: replacement};
        if (change === 'scope') fresh.scope = 'all';
        if (change === 'reason') fresh.reason = 'another-semantic-candidate';
        expect(gate.blocks(fresh, 'Visitors: 3', session)).toBe(false);
        gate.dispose(session);
    });

    it.each([10000, 10001])('断连历史交接在 %s ms 的十秒有效期边界内有界', async elapsed => {
        const {document, element, candidate, session, gate} = fixture();
        gate.blocks(candidate, 'Visitors: 2', session);
        gate.blocks(candidate, 'Visitors: 3', session);
        await vi.advanceTimersByTimeAsync(elapsed);
        const replacement = document.createElement('p');
        element.replaceWith(replacement);
        expect(gate.blocks({...candidate, element: replacement}, 'Visitors: 4', session)).toBe(elapsed === 10000);
        gate.dispose(session);
    });

    it.each([63, 64])('直属槽索引 %s 的替换只在前 64 个节点内扫描', async index => {
        const {document, candidate, session, gate} = fixture();
        document.body.replaceChildren();
        for (let sibling = 0; sibling < index; sibling += 1) document.body.append(document.createElement('span'));
        const owner = document.createElement('p');
        document.body.append(owner);
        expect(gate.blocks({...candidate, element: owner}, 'Waiting for the server.', session)).toBe(false);
        await vi.advanceTimersByTimeAsync(250);
        const replacement = document.createElement('p');
        owner.replaceWith(replacement);
        expect(gate.blocks({...candidate, element: replacement}, 'Receiving the response.', session)).toBe(index < 64);
        gate.dispose(session);
    });

    it('删除旧计数使已有未观察邻段移位时，不把 numeric 历史交给邻段', async () => {
        const {document, element, candidate, session, gate} = fixture();
        const neighbor = document.createElement('p');
        neighbor.textContent = 'Visitors: 99';
        document.body.append(neighbor);
        await vi.advanceTimersByTimeAsync(250);
        gate.blocks(candidate, 'Visitors: 2', session);
        await vi.advanceTimersByTimeAsync(250);
        gate.blocks(candidate, 'Visitors: 3', session);
        element.remove();
        await vi.advanceTimersByTimeAsync(250);
        expect(gate.blocks({...candidate, element: neighbor}, 'Visitors: 99', session)).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(20000);
        expect(gate.blocks({...candidate, element: neighbor}, 'Visitors: 99', session)).toBe(false);
    });

    it('每个活父级最多保留 64 个语义槽，旧槽淘汰后不会串用历史', () => {
        const {document, element, candidate, session, gate} = fixture();
        let previous = element;
        for (let index = 0; index < 70; index += 1) {
            const replacement = document.createElement('p');
            previous.replaceWith(replacement);
            expect(gate.blocks({...candidate, element: replacement, reason: `unique-reason-${index}`}, 'Visitors: 2', session)).toBe(false);
            previous = replacement;
        }
        const slots = Reflect.get(gate, 'replacementSlots') as WeakMap<Node, Map<string, unknown>>;
        expect(slots.get(document.body)?.size).toBe(64);
        const replacement = document.createElement('p');
        previous.replaceWith(replacement);
        expect(gate.blocks({...candidate, element: replacement}, 'Visitors: 3', session)).toBe(false);
    });

    it.each([8192, 8193])('来源长度 %s 的交接只保留最多 8192 字符，超大正文中断旧槽历史', async length => {
        const {document, element, candidate, session, gate} = fixture();
        expect(gate.blocks(candidate, 'A'.repeat(length), session)).toBe(true);
        await vi.advanceTimersByTimeAsync(250);
        const replacement = document.createElement('p');
        element.replaceWith(replacement);
        expect(gate.blocks({...candidate, element: replacement}, 'B'.repeat(length), session)).toBe(length <= 8192);
        if (length > 8192) {
            const final = document.createElement('p');
            replacement.replaceWith(final);
            expect(gate.blocks({...candidate, element: final}, 'A short final source.', session)).toBe(false);
        }
        gate.dispose(session);
    });

    it('候选移位后改成超大正文不扩大旧槽快照，也移除同父的旧位置记录', () => {
        const {document, candidate, session, gate} = fixture();
        const cache = Reflect.get(gate, 'replacementSlots') as WeakMap<Node, Map<string, {history: {source: string}}>>;
        const oldSlots = cache.get(document.body)!;
        const snapshot = [...oldSlots.values()][0]!.history;
        const prefix = document.createTextNode('A newly inserted prefix.');
        document.body.prepend(prefix);
        expect(gate.blocks(candidate, 'X'.repeat(100000), session)).toBe(true);
        expect(snapshot.source).toBe('Visitors: 1');
        expect(oldSlots.size).toBe(0);
        const detached = document.createElement('p');
        expect(gate.blocks({...candidate, element: detached}, 'Y'.repeat(100000), session)).toBe(false);
        // 另一候选的有界记录不会因删除同父的大来源而被清理。
        const neighbor = document.createElement('p');
        document.body.append(neighbor);
        expect(gate.blocks({...candidate, element: neighbor}, 'A neighboring source.', session)).toBe(false);
        expect(gate.blocks(candidate, 'Z'.repeat(100000), session)).toBe(true);
        expect([...oldSlots.values()].map(record => record.history.source)).toEqual(['A neighboring source.']);
        gate.dispose(session);
    });

    it('旧节点已被回收时纯历史仍能交接，reset 清理所有结构槽', () => {
        // 模拟 WeakRef 已释放目标，避免依赖非确定性的 GC 时机。
        vi.stubGlobal('WeakRef', class {deref() {return undefined;}});
        const {document, element, candidate, session, gate} = fixture();
        const replacement = document.createElement('p');
        element.replaceWith(replacement);
        const fresh = {...candidate, element: replacement};
        expect(gate.blocks(fresh, 'Visitors: 2', session)).toBe(true);
        expect(vi.getTimerCount()).toBe(1);
        gate.reset();
        expect(vi.getTimerCount()).toBe(0);
        const another = document.createElement('p');
        replacement.replaceWith(another);
        expect(gate.blocks({...candidate, element: another}, 'Visitors: 3', session)).toBe(false);
    });

    it('候选或父级已断连时不建立可交接的结构槽', () => {
        const {document, candidate, session, gate} = fixture();
        const detached = document.createElement('section');
        const owner = document.createElement('p');
        expect(gate.blocks({...candidate, element: owner}, 'A parentless source.', session)).toBe(false);
        detached.append(owner);
        expect(gate.blocks({...candidate, element: owner}, 'A detached source.', session)).toBe(true);
        expect(gate.blocks({...candidate, element: owner}, 'A'.repeat(8193), session)).toBe(true);
        const fragment = document.createDocumentFragment();
        fragment.append(document.createTextNode('A fragment source.'));
        expect(gate.blocks({...candidate, nodes: [fragment.firstChild!]}, 'A fragment source.', session)).toBe(false);
        document.body.append(fragment);
        expect(gate.blocks({...candidate, element: owner, nodes: [document.body.lastChild!]}, 'A fragment source.', session)).toBe(false);
        gate.dispose(session);
    });

    it('连续数字变化取消安静定时器，悬浮暂停时不创建后台请求', async () => {
        const {candidate, session, ports, gate} = fixture();
        expect(gate.blocks(candidate,'Visitors: 2',session)).toBe(true);
        await vi.advanceTimersByTimeAsync(100);
        expect(gate.blocks(candidate,'Visitors: 3',session)).toBe(true);
        await vi.runAllTimersAsync();
        expect(ports.queue).not.toHaveBeenCalled();
        const hoverGate = new TranslationSourceStabilityGate(ports);
        expect(hoverGate.blocks(candidate,'Initial hover source.')).toBe(false);
        expect(hoverGate.blocks(candidate,'Changed hover source.')).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        gate.dispose(session);
        gate.dispose(session);
    });

    it.each(['inactive','detached','unresolved','unscheduled','offscreen'] as const)('安静窗口后拒绝 %s 候选', async failure => {
        const {element, candidate, session, ports, gate} = fixture();
        gate.blocks(candidate,'Changed source.',session);
        if (failure === 'inactive') ports.isCurrent.mockReturnValue(false);
        if (failure === 'detached') element.remove();
        if (failure === 'unresolved') ports.resolve.mockReturnValue(null);
        if (failure === 'unscheduled') ports.discover.mockImplementation(() => undefined);
        if (failure === 'offscreen') session.translationMode='viewport';
        await vi.runAllTimersAsync();
        expect(ports.queue).not.toHaveBeenCalled();
    });

    it('视口模式只唤醒仍可见的候选，恢复和路由切换取消旧回调', async () => {
        const {element, candidate, session, ports, gate} = fixture();
        Object.defineProperty(element,'getBoundingClientRect',{value:() => ({width:400,height:40,right:400,left:0,bottom:40,top:0})});
        session.translationMode='viewport';
        gate.blocks(candidate,'Changed source.',session);
        await vi.runAllTimersAsync();
        expect(ports.queue).toHaveBeenCalledOnce();
        gate.blocks(candidate,'Another source.',session);
        gate.dispose(session);
        await vi.runAllTimersAsync();
        expect(ports.queue).toHaveBeenCalledOnce();
        gate.blocks(candidate,'A pending source.',session);
        gate.reset();
        await vi.runAllTimersAsync();
        expect(ports.queue).toHaveBeenCalledOnce();
        expect(gate.blocks(candidate,'A new route source.',session)).toBe(false);
    });

    it.each(['resolve', 'discover', 'source', 'queue'] as const)('外部 %s 端口重入路由 reset 后不继续旧调度', async port => {
        const {candidate, session, ports, gate} = fixture();
        gate.blocks(candidate, 'Changed source.', session);
        const original = ports[port].getMockImplementation() ?? (() => undefined);
        ports[port].mockImplementation(((...args: never[]) => {
            const result = (original as (...values: never[]) => unknown)(...args);
            gate.reset();
            return result;
        }) as never);
        await vi.runAllTimersAsync();
        if (port !== 'queue') expect(ports.queue).not.toHaveBeenCalled();
        expect(ports.drain).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['ready', 'numeric', 'ready-reentry'] as const)('取消后 %s 不保留 session 强引用或运行旧 timer', async reason => {
        const {candidate, session, ports, gate} = fixture();
        const pending = Reflect.get(gate, 'timers') as Map<typeof session, unknown>;
        gate.blocks(candidate, reason === 'numeric' ? 'Visitors: 2' : 'Changed source.', session);
        expect(pending.size).toBe(1);
        if (reason === 'numeric') gate.blocks(candidate, 'Visitors: 3', session);
        else if (reason === 'ready') {
            vi.setSystemTime(Date.now() + 1800); // 时钟已过 quiet window，timer 尚未执行。
            expect(gate.blocks(candidate, 'Changed source.', session)).toBe(false);
        } else {
            ports.source.mockImplementationOnce(() => {
                expect(gate.blocks(candidate, 'Changed source.', session)).toBe(false);
                return 'Changed source.';
            });
            await vi.advanceTimersByTimeAsync(1800);
        }
        await vi.runAllTimersAsync();
        expect(pending.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(ports.queue).not.toHaveBeenCalled();
        expect(ports.drain).not.toHaveBeenCalled();
    });

    it('source 端口发现新一代来源时保留新 timer，旧回调不抢先派发', async () => {
        const {candidate, session, ports, gate} = fixture();
        gate.blocks(candidate, 'Changed source.', session);
        ports.source.mockImplementationOnce(() => {
            gate.blocks(candidate, 'A newer generation.', session);
            return 'A newer generation.';
        });
        await vi.advanceTimersByTimeAsync(1800);
        expect(ports.queue).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(1);
        ports.source.mockReturnValue('A newer generation.');
        await vi.advanceTimersByTimeAsync(2700);
        expect(ports.queue).toHaveBeenCalledOnce();
        expect(ports.queue.mock.calls[0][3]).toBe('A newer generation.');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('可见锚点布局读取重入 dispose 后不复活已取消回调', async () => {
        const {element, candidate, session, ports, gate} = fixture();
        session.translationMode = 'viewport';
        Object.defineProperty(element, 'getBoundingClientRect', {value: () => {
            gate.dispose(session);
            return {width:400, height:40, right:400, left:0, bottom:40, top:0};
        }});
        gate.blocks(candidate, 'Changed source.', session);
        await vi.runAllTimersAsync();
        expect(ports.queue).not.toHaveBeenCalled();
        expect(ports.drain).not.toHaveBeenCalled();
    });

    it('重新发现保留共享 key 的优先候选时按实际 scheduled owner 判断视口', async () => {
        const {document, element, candidate, session, ports, gate} = fixture();
        session.translationMode = 'viewport';
        const owner = document.createElement('section');
        document.body.append(owner);
        Object.defineProperty(element, 'getBoundingClientRect', {value: () => ({width:400,height:40,right:400,left:0,bottom:40,top:0})});
        Object.defineProperty(owner, 'getBoundingClientRect', {value: () => ({width:400,height:40,right:400,left:0,bottom:20040,top:20000})});
        const preferred = {...candidate, element: owner, nodes: [element]};
        ports.discover.mockImplementation(() => {session.scheduled.set(element, preferred);});
        gate.blocks(candidate, 'Changed source.', session);
        await vi.runAllTimersAsync();
        expect(ports.queue).not.toHaveBeenCalled();
    });

    it('display:contents owner 的安静重试复用重新发现绑定的可见后代锚点', async () => {
        const {document, element, candidate, session, ports, gate} = fixture();
        session.translationMode = 'viewport';
        const anchor = document.createElement('span');
        element.append(anchor);
        Object.defineProperty(element, 'getBoundingClientRect', {value: () => ({width:0,height:0,right:0,left:0,bottom:0,top:0})});
        Object.defineProperty(anchor, 'getBoundingClientRect', {value: () => ({width:400,height:40,right:400,left:0,bottom:40,top:0})});
        ports.discover.mockImplementation(() => {
            session.scheduled.set(element, candidate);
            session.candidateAnchors.set(element, anchor);
        });
        gate.blocks(candidate, 'Changed source.', session);
        await vi.runAllTimersAsync();
        expect(ports.queue).toHaveBeenCalledOnce();
        expect(ports.drain).toHaveBeenCalledOnce();
    });

    it.each([
        {width:0}, {height:0}, {rectWidth:0}, {rectHeight:0}, {right:0}, {left:1280}, {bottom:-10000}, {top:10000},
    ])('可见锚点拒绝无效或离屏几何 %j', overrides => {
        const {element} = fixture();
        Object.assign(window,{innerWidth:overrides.width ?? 1280,innerHeight:overrides.height ?? 900});
        Object.defineProperty(element,'getBoundingClientRect',{value:() => ({width:overrides.rectWidth ?? 400,height:overrides.rectHeight ?? 40,
            right:overrides.right ?? 400,left:overrides.left ?? 0,bottom:overrides.bottom ?? 40,top:overrides.top ?? 0})});
        expect(isAnchorNearViewport(element)).toBe(false);
    });

    it('可见锚点读取布局异常时保守等待 IO', () => {
        const {element} = fixture();
        Object.defineProperty(element,'getBoundingClientRect',{value:() => {throw new Error('Detached layout');}});
        expect(isAnchorNearViewport(element)).toBe(false);
    });
});
