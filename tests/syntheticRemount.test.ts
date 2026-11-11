import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';

const translationCore = vi.hoisted(() => ({
    resolve: vi.fn(),
    shouldStayOriginal: vi.fn(() => false),
}));

vi.mock('@/src/core/translation/public', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/src/core/translation/public')>();
    return {
        ...actual,
        getCurrentTranslationCore: () => ({
            adapters: [],
            textOptions: (options?: import('@/src/core/translation/public').TranslationTextProtectionOptions) => options,
            resolve: translationCore.resolve,
            shouldStayOriginal: translationCore.shouldStayOriginal,
        }),
    };
});

import type {TranslationCandidate} from '@/src/core/translation/public';
import {transferEquivalentSyntheticBilingualSegments} from
    '@/src/features/full-page-translation/content/syntheticRemount';
import {
    beginTranslation,
    getTranslationState,
    markTranslationComplete,
    resetAllBilingualArtifactHostWriteBudgets,
    restoreAllTranslations,
    setBilingualContent,
} from '@/src/features/full-page-translation/content/state';

function childListRecord(
    target: Node,
    addedNodes: readonly Node[],
    removedNodes: readonly Node[],
): MutationRecord {
    return {
        type: 'childList',
        target,
        addedNodes: addedNodes as unknown as NodeList,
        removedNodes: removedNodes as unknown as NodeList,
    } as MutationRecord;
}

function candidate(
    host: HTMLElement,
    nodes: readonly ChildNode[],
    allowTopLevelApplicationShell = false,
): TranslationCandidate {
    return {
        element: host,
        nodes,
        kind: 'content',
        reason: 'generic-inline-run',
        ...(allowTopLevelApplicationShell ? {allowTopLevelApplicationShell: true} : {}),
    };
}

function resolveCandidates(candidates: readonly TranslationCandidate[]): void {
    translationCore.resolve.mockImplementation((start: Node | null | undefined) =>
        candidates.find((item) => item.nodes?.includes(start as ChildNode)) ?? null);
}

function createCommittedSyntheticScenario(allowTopLevelApplicationShell = false) {
    const {document} = parseHTML(
        '<html><body><div id="host">Inline <strong>source.</strong><p>Independent block.</p></div></body></html>',
    );
    const host = document.querySelector<HTMLElement>('#host')!;
    const firstText = host.firstChild as Text;
    const strong = host.querySelector<HTMLElement>('strong')!;
    const owner = document.createElement('span');
    host.insertBefore(owner, firstText);
    owner.append(firstText, strong);
    owner.setAttribute('data-fr-translation-segment', 'true');
    const sourceTextNodes = [firstText, strong.firstChild as Text];
    const attempt = beginTranslation(
        owner,
        'bilingual',
        'content',
        true,
        'Inline source.',
        sourceTextNodes,
        allowTopLevelApplicationShell,
        'test-profile',
    )!;
    expect(markTranslationComplete(owner, attempt.state, attempt.generation)).toBe(true);
    const wrapper = document.createElement('span');
    wrapper.className = 'fluent-read-bilingual-content';
    wrapper.setAttribute('data-fr-translation-owned', 'true');
    wrapper.setAttribute('translate', 'no');
    wrapper.textContent = '行内译文。';
    owner.appendChild(wrapper);
    setBilingualContent(owner, wrapper);
    return {document, host, owner, state: attempt.state, wrapper};
}

function replaceWithEquivalentSource(scenario: ReturnType<typeof createCommittedSyntheticScenario>) {
    const removed = Array.from(scenario.host.childNodes);
    const firstText = scenario.document.createTextNode('Inline ');
    const strong = scenario.document.createElement('strong');
    strong.textContent = 'source.';
    const block = scenario.document.createElement('p');
    block.textContent = 'Independent block.';
    scenario.host.replaceChildren(firstText, strong, block);
    const nextCandidate = candidate(
        scenario.host,
        [firstText, strong],
        scenario.state.allowTopLevelApplicationShell === true,
    );
    resolveCandidates([nextCandidate]);
    return {
        firstText,
        strong,
        block,
        candidate: nextCandidate,
        record: childListRecord(scenario.host, [firstText, strong, block], removed),
    };
}

beforeEach(() => {
    translationCore.resolve.mockReset();
    translationCore.shouldStayOriginal.mockClear();
    resetAllBilingualArtifactHostWriteBudgets();
});

afterEach(() => {
    restoreAllTranslations();
});

describe('synthetic 双语片段 source-only 重挂', () => {
    it('行内来源换代保留已提交的译文前置顺序，恢复后仍保留新来源节点', () => {
        const scenario = createCommittedSyntheticScenario();
        scenario.owner.prepend(scenario.wrapper);
        setBilingualContent(scenario.owner, scenario.wrapper);
        const {record, firstText, strong, block} = replaceWithEquivalentSource(scenario);
        const result = transferEquivalentSyntheticBilingualSegments([record], () => true);
        expect(result.transfers).toHaveLength(1);
        expect(Array.from(scenario.owner.childNodes)).toEqual([scenario.wrapper, firstText, strong]);
        expect(scenario.state.bilingualBeforeSource).toBe(true);
        restoreAllTranslations();
        expect(Array.from(scenario.host.childNodes)).toEqual([firstText, strong, block]);
        expect(scenario.host.textContent).toBe('Inline source.Independent block.');
    });

    it('只允许完整段落的自动外壳授权不能迁移为没有对应授权的行内片段', () => {
        const scenario = createCommittedSyntheticScenario();
        scenario.state.applicationShellPolicyId = 'mastodon';
        const {record} = replaceWithEquivalentSource(scenario);
        const result = transferEquivalentSyntheticBilingualSegments([record], () => true);
        expect(result.transfers).toEqual([]);
        expect(scenario.wrapper.isConnected).toBe(false);
        expect(translationCore.resolve).not.toHaveBeenCalled();
    });
    it('祖先组件整体 source-only 换代时按宿主相对路径原子迁移旧译文', () => {
        const scenario = createCommittedSyntheticScenario();
        const component = scenario.document.createElement('article');
        scenario.host.replaceWith(component);
        component.appendChild(scenario.host);
        const replacementComponent = scenario.document.createElement('article');
        const replacementHost = scenario.host.cloneNode(false) as HTMLElement;
        const firstText = scenario.document.createTextNode('Inline ');
        const strong = scenario.document.createElement('strong');
        strong.textContent = 'source.';
        const block = scenario.document.createElement('p');
        block.textContent = 'Independent block.';
        replacementHost.append(firstText, strong, block);
        replacementComponent.appendChild(replacementHost);
        component.replaceWith(replacementComponent);
        resolveCandidates([candidate(replacementHost, [firstText, strong])]);

        const result = transferEquivalentSyntheticBilingualSegments(
            [childListRecord(scenario.document.body, [replacementComponent], [component])],
            () => true,
        );

        expect(result).toEqual({
            transfers: [{
                owner: scenario.owner,
                previousHost: scenario.host,
                replacementHost,
            }],
            capitulations: [],
        });
        expect(replacementHost.firstChild).toBe(scenario.owner);
        expect(Array.from(scenario.owner.childNodes)).toEqual([firstText, strong, scenario.wrapper]);
        expect(getTranslationState(scenario.owner)).toBe(scenario.state);
        expect(replacementHost.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);
    });

    it('直接替换 candidate host 时空相对路径映射到新 host', () => {
        const scenario = createCommittedSyntheticScenario();
        const replacementHost = scenario.host.cloneNode(false) as HTMLElement;
        const firstText = scenario.document.createTextNode('Inline ');
        const strong = scenario.document.createElement('strong');
        strong.textContent = 'source.';
        const block = scenario.document.createElement('p');
        block.textContent = 'Independent block.';
        replacementHost.append(firstText, strong, block);
        scenario.host.replaceWith(replacementHost);
        resolveCandidates([candidate(replacementHost, [firstText, strong])]);

        const result = transferEquivalentSyntheticBilingualSegments(
            [childListRecord(scenario.document.body, [replacementHost], [scenario.host])],
            () => true,
        );

        expect(result.transfers).toEqual([{
            owner: scenario.owner,
            previousHost: scenario.host,
            replacementHost,
        }]);
        expect(replacementHost.firstChild).toBe(scenario.owner);
        expect(getTranslationState(scenario.owner)).toBe(scenario.state);
    });

    it('祖先 fallback 忽略缺失路径、Text、错误标签与无候选节点，只接管唯一精确映射', () => {
        const scenario = createCommittedSyntheticScenario();
        const component = scenario.document.createElement('article');
        const nesting = scenario.document.createElement('section');
        scenario.host.replaceWith(component);
        component.appendChild(nesting);
        nesting.appendChild(scenario.host);

        const rootWith = (child: Node) => {
            const root = scenario.document.createElement('article');
            const section = scenario.document.createElement('section');
            section.appendChild(child);
            root.appendChild(section);
            return root;
        };
        const shallow = scenario.document.createElement('article');
        const textAtPath = rootWith(scenario.document.createTextNode('not an element'));
        const wrongTag = rootWith(scenario.document.createElement('aside'));
        const noCandidateHost = scenario.document.createElement('div');
        noCandidateHost.textContent = 'Inline source.';
        const noCandidate = rootWith(noCandidateHost);
        const replacementHost = scenario.document.createElement('div');
        const firstText = scenario.document.createTextNode('Inline ');
        const strong = scenario.document.createElement('strong');
        strong.textContent = 'source.';
        replacementHost.append(firstText, strong);
        const valid = rootWith(replacementHost);
        component.replaceWith(shallow, textAtPath, wrongTag, noCandidate, valid);
        resolveCandidates([candidate(replacementHost, [firstText, strong])]);
        const added = [shallow, textAtPath, wrongTag, noCandidate, valid];

        const result = transferEquivalentSyntheticBilingualSegments(
            [childListRecord(scenario.document.body, added, [component])],
            () => true,
        );

        expect(result.transfers).toEqual([{
            owner: scenario.owner,
            previousHost: scenario.host,
            replacementHost,
        }]);
        expect(replacementHost.firstChild).toBe(scenario.owner);
        expect(getTranslationState(scenario.owner)).toBe(scenario.state);
    });

    it('祖先 fallback 同时命中两个等价 host 时因映射歧义拒绝', () => {
        const scenario = createCommittedSyntheticScenario();
        const component = scenario.document.createElement('article');
        scenario.host.replaceWith(component);
        component.appendChild(scenario.host);
        const replacements = [0, 1].map(() => {
            const root = scenario.document.createElement('article');
            const host = scenario.document.createElement('div');
            const firstText = scenario.document.createTextNode('Inline ');
            const strong = scenario.document.createElement('strong');
            strong.textContent = 'source.';
            host.append(firstText, strong);
            root.appendChild(host);
            return {root, host, firstText, strong};
        });
        component.replaceWith(...replacements.map(({root}) => root));
        resolveCandidates(replacements.map(({host, firstText, strong}) =>
            candidate(host, [firstText, strong])));

        const result = transferEquivalentSyntheticBilingualSegments(
            [childListRecord(
                scenario.document.body,
                replacements.map(({root}) => root),
                [component],
            )],
            () => true,
        );

        expect(result).toEqual({transfers: [], capitulations: []});
        expect(getTranslationState(scenario.owner)).toBe(scenario.state);
        expect(replacements.every(({host}) =>
            !host.querySelector('.fluent-read-bilingual-content'))).toBe(true);
    });

    it('移除记录只指向已索引 wrapper 时，宿主不在 removedRoot 内则路径失败并保守拒绝', () => {
        const scenario = createCommittedSyntheticScenario();
        scenario.owner.remove();

        const result = transferEquivalentSyntheticBilingualSegments(
            [childListRecord(scenario.document.body, [], [scenario.wrapper])],
            () => true,
        );

        expect(result).toEqual({transfers: [], capitulations: []});
        expect(getTranslationState(scenario.owner)).toBe(scenario.state);
        expect(translationCore.resolve).not.toHaveBeenCalled();
    });

    it('ShadowRoot 边界内的 ancestor 换代仍按路径原子交接', () => {
        const scenario = createCommittedSyntheticScenario();
        const shell = scenario.document.createElement('div');
        scenario.document.body.appendChild(shell);
        const shadow = shell.attachShadow({mode: 'open'});
        // LinkeDOM 中连接到 document 的 ShadowRoot.isConnected 仍返回 false；
        // 真实浏览器按宿主连接性返回 true。
        Object.defineProperty(shadow, 'isConnected', {configurable: true, value: true});
        const component = scenario.document.createElement('article');
        scenario.host.replaceWith(component);
        component.appendChild(scenario.host);
        shadow.appendChild(component);

        const replacementComponent = scenario.document.createElement('article');
        const replacementHost = scenario.document.createElement('div');
        const firstText = scenario.document.createTextNode('Inline ');
        const strong = scenario.document.createElement('strong');
        strong.textContent = 'source.';
        replacementHost.append(firstText, strong);
        replacementComponent.appendChild(replacementHost);
        component.replaceWith(replacementComponent);
        // LinkeDOM 不完整传播 ShadowRoot 后代的连接位，补齐真实浏览器语义。
        Object.defineProperty(replacementComponent, 'isConnected', {configurable: true, value: true});
        Object.defineProperty(replacementHost, 'isConnected', {configurable: true, value: true});
        resolveCandidates([candidate(replacementHost, [firstText, strong])]);

        const result = transferEquivalentSyntheticBilingualSegments(
            [childListRecord(shadow, [replacementComponent], [component])],
            () => true,
        );

        expect(translationCore.resolve).toHaveBeenCalled();
        expect(result.transfers).toEqual([{
            owner: scenario.owner,
            previousHost: scenario.host,
            replacementHost,
        }]);
        expect(replacementHost.firstChild).toBe(scenario.owner);
        expect(getTranslationState(scenario.owner)).toBe(scenario.state);
        expect(scenario.wrapper.isConnected).toBe(true);
    });

    it('body 直属 translate=no 应用外壳内保留 allowTopLevel 候选，不误清理译文', () => {
        const scenario = createCommittedSyntheticScenario(true);
        const applicationShell = scenario.document.createElement('main');
        applicationShell.setAttribute('translate', 'no');
        scenario.host.replaceWith(applicationShell);
        applicationShell.appendChild(scenario.host);
        const replacement = replaceWithEquivalentSource(scenario);

        const result = transferEquivalentSyntheticBilingualSegments(
            [replacement.record],
            () => true,
        );

        expect(result.transfers).toHaveLength(1);
        expect(scenario.host.firstChild).toBe(scenario.owner);
        expect(getTranslationState(scenario.owner)).toBe(scenario.state);
        expect(scenario.wrapper.isConnected).toBe(true);
        expect(scenario.state.allowTopLevelApplicationShell).toBe(true);
    });

    it('allowTopLevel=true 时原子迁移当前来源节点并保留唯一可信译文', () => {
        const scenario = createCommittedSyntheticScenario(true);
        const replacement = replaceWithEquivalentSource(scenario);
        const reconcileLayout = vi.fn(() => true);

        const result = transferEquivalentSyntheticBilingualSegments(
            [replacement.record],
            reconcileLayout,
        );

        expect(result.capitulations).toEqual([]);
        expect(result.transfers).toEqual([{
            owner: scenario.owner,
            previousHost: scenario.host,
            replacementHost: scenario.host,
        }]);
        expect(scenario.host.firstChild).toBe(scenario.owner);
        expect(Array.from(scenario.owner.childNodes)).toEqual([
            replacement.firstText,
            replacement.strong,
            scenario.wrapper,
        ]);
        expect(scenario.owner.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);
        expect(getTranslationState(scenario.owner)).toBe(scenario.state);
        expect(scenario.state.syntheticSourceNodes).toEqual([
            replacement.firstText,
            replacement.strong,
        ]);
        expect(reconcileLayout).toHaveBeenCalledOnce();
    });

    it('宿主子节点超过扫描上限时不解析、不写 DOM', () => {
        const scenario = createCommittedSyntheticScenario();
        const removed = Array.from(scenario.host.childNodes);
        const replacements = Array.from({length: 513}, (_, index) =>
            scenario.document.createTextNode(index === 0 ? 'Inline source.' : ''));
        scenario.host.replaceChildren(...replacements);

        const result = transferEquivalentSyntheticBilingualSegments(
            [childListRecord(scenario.host, replacements, removed)],
            vi.fn(() => true),
        );

        expect(result).toEqual({transfers: [], capitulations: []});
        expect(translationCore.resolve).not.toHaveBeenCalled();
        expect(scenario.host.querySelector('[data-fr-translation-segment="true"]')).toBeNull();
        expect(getTranslationState(scenario.owner)).toBe(scenario.state);
    });

    it('已脱离 document 的 candidate host 直接拒绝且不扫描移除子树', () => {
        const scenario = createCommittedSyntheticScenario();
        const replacement = replaceWithEquivalentSource(scenario);
        scenario.host.remove();

        const result = transferEquivalentSyntheticBilingualSegments(
            [replacement.record],
            vi.fn(() => true),
        );

        expect(result).toEqual({transfers: [], capitulations: []});
        expect(translationCore.resolve).not.toHaveBeenCalled();
        expect(getTranslationState(scenario.owner)).toBe(scenario.state);
    });

    it('同一代 source-only 自反馈第四次熔断并返回稳定边界墓碑', () => {
        const scenario = createCommittedSyntheticScenario();
        const transferCounts: number[] = [];
        let finalResult: ReturnType<typeof transferEquivalentSyntheticBilingualSegments> | undefined;

        for (let index = 0; index < 4; index += 1) {
            const replacement = replaceWithEquivalentSource(scenario);
            finalResult = transferEquivalentSyntheticBilingualSegments(
                [replacement.record],
                () => true,
            );
            transferCounts.push(finalResult.transfers.length);
        }

        expect(transferCounts).toEqual([1, 1, 1, 0]);
        expect(finalResult!.capitulations).toEqual([{
            owner: scenario.owner,
            state: scenario.state,
            host: scenario.host,
            boundary: scenario.document.body,
        }]);
        expect(getTranslationState(scenario.owner)).toBeUndefined();
        expect(scenario.state.controller.signal.aborted).toBe(true);
        expect(scenario.host.querySelector('[data-fr-translation-segment="true"]')).toBeNull();
        expect(scenario.host.querySelector('.fluent-read-bilingual-content')).toBeNull();
        expect(scenario.host.textContent).toContain('Inline source.');
    });

    it('原子迁移后布局复验失败时安全解包原文并丢弃旧状态', () => {
        const scenario = createCommittedSyntheticScenario();
        const replacement = replaceWithEquivalentSource(scenario);
        const reconcileLayout = vi.fn(() => false);

        const result = transferEquivalentSyntheticBilingualSegments(
            [replacement.record],
            reconcileLayout,
        );

        expect(result).toEqual({transfers: [], capitulations: []});
        expect(reconcileLayout).toHaveBeenCalledOnce();
        expect(getTranslationState(scenario.owner)).toBeUndefined();
        expect(scenario.owner.isConnected).toBe(false);
        expect(scenario.wrapper.isConnected).toBe(false);
        expect(Array.from(scenario.host.childNodes).slice(0, 2)).toEqual([
            replacement.firstText,
            replacement.strong,
        ]);
        expect(scenario.host.querySelector('.fluent-read-bilingual-content')).toBeNull();
    });

    it('同文同构的两个 inline-run 候选存在歧义时保守拒绝', () => {
        const scenario = createCommittedSyntheticScenario();
        const removed = Array.from(scenario.host.childNodes);
        const firstText = scenario.document.createTextNode('Inline ');
        const firstStrong = scenario.document.createElement('strong');
        firstStrong.textContent = 'source.';
        const secondText = scenario.document.createTextNode('Inline ');
        const secondStrong = scenario.document.createElement('strong');
        secondStrong.textContent = 'source.';
        scenario.host.replaceChildren(firstText, firstStrong, secondText, secondStrong);
        resolveCandidates([
            candidate(scenario.host, [firstText, firstStrong]),
            candidate(scenario.host, [secondText, secondStrong]),
        ]);

        const result = transferEquivalentSyntheticBilingualSegments(
            [childListRecord(
                scenario.host,
                [firstText, firstStrong, secondText, secondStrong],
                removed,
            )],
            vi.fn(() => true),
        );

        expect(result).toEqual({transfers: [], capitulations: []});
        expect(getTranslationState(scenario.owner)).toBe(scenario.state);
        expect(scenario.host.querySelector('.fluent-read-bilingual-content')).toBeNull();
    });

    it.each([
        ['wrong element', (scenario: ReturnType<typeof createCommittedSyntheticScenario>, nodes: readonly ChildNode[]) => ({
            ...candidate(scenario.document.createElement('aside'), nodes),
        })],
        ['wrong kind', (scenario: ReturnType<typeof createCommittedSyntheticScenario>, nodes: readonly ChildNode[]) => ({
            ...candidate(scenario.host, nodes),
            kind: 'control' as const,
        })],
        ['wrong application-shell mode', (
            scenario: ReturnType<typeof createCommittedSyntheticScenario>,
            nodes: readonly ChildNode[],
        ) => candidate(scenario.host, nodes, true)],
        ['detached candidate node', (scenario: ReturnType<typeof createCommittedSyntheticScenario>) =>
            candidate(scenario.host, [scenario.document.createTextNode('Inline source.')])],
        ['empty node list', (scenario: ReturnType<typeof createCommittedSyntheticScenario>) =>
            candidate(scenario.host, [])],
    ])('非等价候选 %s 不会接管旧译文', (_label, makeCandidate) => {
        const scenario = createCommittedSyntheticScenario();
        const replacement = replaceWithEquivalentSource(scenario);
        const rejectedCandidate = makeCandidate(
            scenario,
            [replacement.firstText, replacement.strong],
        ) as TranslationCandidate;
        translationCore.resolve.mockImplementation(() => rejectedCandidate);

        const result = transferEquivalentSyntheticBilingualSegments(
            [replacement.record],
            vi.fn(() => true),
        );

        expect(result).toEqual({transfers: [], capitulations: []});
        expect(getTranslationState(scenario.owner)).toBe(scenario.state);
    });

    it('属性记录、Text target 与仅移除 wrapper 的记录均不进入交接', () => {
        const scenario = createCommittedSyntheticScenario();
        scenario.wrapper.remove();
        const records = [
            {type: 'attributes', target: scenario.host} as unknown as MutationRecord,
            childListRecord(scenario.host.firstChild!, [], []),
            childListRecord(scenario.owner, [], [scenario.wrapper]),
        ];

        expect(transferEquivalentSyntheticBilingualSegments(records, () => true)).toEqual({
            transfers: [],
            capitulations: [],
        });
        expect(translationCore.resolve).not.toHaveBeenCalled();
        expect(getTranslationState(scenario.owner)).toBe(scenario.state);
    });
});
