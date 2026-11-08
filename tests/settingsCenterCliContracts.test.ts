import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Script} from 'node:vm';
import ts from 'typescript';
import {parseHTML} from 'linkedom';
import {parse as parseVueSfc} from 'vue/compiler-sfc';
import {describe, expect, it} from 'vitest';
import {navigationGroups, navigationItems, SETTINGS_TABBED_SECTION_IDS} from '@/src/features/settings/model/navigation';
import {interfaceSkinOptions, DEFAULT_POPUP_QUICK_FEATURE_ORDER, DEFAULT_POPUP_QUICK_FEATURE_VISIBILITY} from '@/src/core/config/interfaceAppearance';

// Load only explicitly selected declarations. The CLI's launch, I/O and main()
// are never evaluated; this suite can run without an extension or a browser.
const filename = resolve(__dirname, '../scripts/testing/run-settings-center-ui-test.cjs');
const source = readFileSync(filename, 'utf8');
const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function bindings(names: string[], globals: Record<string, unknown> = {}): Record<string, any> {
    const declarations = new Map<string, string>();
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && names.includes(node.name.text)) {
            declarations.set(node.name.text, `const ${node.name.text} = ${node.initializer.getText(ast)};`);
        }
        if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) declarations.set(node.name.text, node.getText(ast));
        ts.forEachChild(node, visit);
    };
    visit(ast);
    for (const name of names) if (!declarations.has(name)) throw new Error(`Missing CLI declaration: ${name}`);
    return new Script(`${names.map(name => declarations.get(name)).join('\n')}\n({${names.join(',')}})`).runInNewContext({timeout: 30000, ...globals});
}

describe('settings center CLI production contracts', () => {
    it('keeps six continuous panel names and both ordering contracts aligned with the actual InterfaceSettings template', () => {
        const panelOrder = productionInterfacePanelNames();
        const contract = bindings(['expectedInterfaceGroups']);
        expect(panelOrder).toHaveLength(6);
        expect(new Set(panelOrder).size).toBe(6);
        expect(panelOrder.indexOf('video-learning')).toBe(panelOrder.indexOf('layout') + 1);
        expect(panelOrder.indexOf('font')).toBe(panelOrder.indexOf('video-learning') + 1);
        // The real source moved sentence-learning appearance after layout; the
        // seven group headings retain their exact membership and adjacency.
        expect(contract.expectedInterfaceGroups).toHaveLength(7);
        expect(new Set(contract.expectedInterfaceGroups).size).toBe(7);
        const layout = productionChineseCopy('settings.interface.popupLayout.label');
        const learning = productionChineseCopy('video.learningAppearance.title');
        const font = productionChineseCopy('settings.interface.font.label');
        expect(contract.expectedInterfaceGroups.indexOf(learning)).toBe(contract.expectedInterfaceGroups.indexOf(layout) + 1);
        expect(contract.expectedInterfaceGroups.indexOf(font)).toBe(contract.expectedInterfaceGroups.indexOf(learning) + 1);
        expect(bindings(['expectedInterfacePanelOrder']).expectedInterfacePanelOrder).toEqual(panelOrder);
    });

    it('keeps exact canonical section names, order and grouping aligned with production', () => {
        const contract = bindings(['expectedNavigation', 'expectedNavigationGroups']);
        expect(contract.expectedNavigation).toEqual(navigationItems.map(item => [item.id, item.label]));
        expect(contract.expectedNavigationGroups).toEqual(navigationGroups.map(group => [group.label, group.items.map(item => item.id)]));
    });

    it('covers every current popup entry and declared width without restoring removed entries', () => {
        const contract = bindings(['defaultVisibleQuickFeatures', 'defaultQuickFeatureOrder', 'customQuickFeatureOrder', 'expectedInterfaceSkins']);
        expect(contract.defaultQuickFeatureOrder).toEqual(DEFAULT_POPUP_QUICK_FEATURE_ORDER);
        expect(contract.defaultVisibleQuickFeatures).toEqual(DEFAULT_POPUP_QUICK_FEATURE_ORDER.filter(id => DEFAULT_POPUP_QUICK_FEATURE_VISIBILITY[id]));
        expect([...contract.customQuickFeatureOrder].sort()).toEqual([...DEFAULT_POPUP_QUICK_FEATURE_ORDER].sort());
        expect(contract.expectedInterfaceSkins.map((skin: {value: string; label: string; popupWidth: number}) => [skin.value, skin.label, skin.popupWidth]))
            .toEqual(interfaceSkinOptions.map(skin => [skin.value, skin.label, skin.popupWidth]));
    });

    it('excludes group toggles from section counts while retaining all sixteen sections', () => {
        const {settingsNavigationSelector} = bindings(['settingsNavigationSelector']);
        const {document} = parseHTML('<!doctype html><html><body></body></html>');
        const nav = document.createElement('nav');
        nav.setAttribute('aria-label', '设置分类');
        for (const group of navigationGroups) {
            const toggle = document.createElement('button');
            toggle.className = 'nav-group-toggle';
            nav.append(toggle);
            for (const item of group.items) {
                const section = document.createElement('button');
                section.dataset.section = item.id;
                nav.append(section);
            }
        }
        const fixture = document.createElement('div');
        fixture.append(nav);
        expect(fixture.querySelectorAll('button')).toHaveLength(navigationItems.length + navigationGroups.length);
        expect([...fixture.querySelectorAll<HTMLElement>(settingsNavigationSelector)].map(button => button.dataset.section))
            .toEqual(navigationItems.map(item => item.id));
    });
});

function navigationPage(mobileVisible: boolean, initiallyCollapsed = false, panelKind: 'category' | 'anchor' = 'category') {
    const actions: string[] = [];
    let activeSection = '';
    let collapsed = initiallyCollapsed;
    const {document} = parseHTML('<!doctype html><html><body><nav class="settings-page-tabs"></nav></body></html>');
    const continuousPanels = productionInterfacePanelNames().map(id => {
        const panel = document.createElement('section');
        panel.dataset.settingsAnchor = id;
        document.body.append(panel);
        return panel;
    });
    const page = {
        locator(selector: string): any {
            if (selector === 'select.mobile-settings-navigation') return {
                isVisible: async () => mobileVisible,
                selectOption: async (id: string) => {activeSection = id; actions.push(`mobile:${id}`);},
            };
            if (selector.startsWith('.settings-page-tabs')) return {
                click: async () => {
                    const id = selector.match(/data-settings-category="([^"]+)"/)?.[1];
                    expect(id).toBeDefined();
                    expect(selector).toContain(`button[data-settings-anchor-link="${id}"]`);
                    const button = document.createElement('button');
                    button.setAttribute(`data-settings-${panelKind === 'category' ? 'category' : 'anchor-link'}`, id!);
                    document.querySelector('.settings-page-tabs')!.replaceChildren(button);
                    actions.push(`panel:${id}`);
                },
            };
            const id = selector.match(/data-section="([^"]+)"/)?.[1];
            if (!id) throw new Error(`Unexpected navigation selector: ${selector}`);
            return {
                isVisible: async () => !collapsed,
                locator: (ancestor: string) => {
                    if (!ancestor.includes('nav-group')) throw new Error('Missing group ancestor');
                    return {locator: (toggle: string) => ({click: async () => {
                        expect(toggle).toBe('.nav-group-toggle'); collapsed = false; actions.push('expand-group');
                    }})};
                },
                click: async () => {
                    if (mobileVisible || collapsed) throw new Error('Clicked a hidden sidebar entry');
                    activeSection = id; actions.push(`sidebar:${id}`);
                },
                waitFor: async ({state, timeout}: {state: string; timeout: number}) => {
                    expect(state).toBe('attached'); expect(timeout).toBe(30000);
                    expect(selector).toContain('[aria-current="page"]'); expect(activeSection).toBe(id);
                    actions.push(`active:${id}`);
                },
            };
        },
        waitForFunction: async (predicate: (id: string) => boolean, id: string, options: {timeout: number}) => {
            expect(options).toEqual({timeout: 30000});
            expect(actions.at(-1)).toBe(`panel:${id}`);
            const button = document.querySelector('.settings-page-tabs button')!;
            // Run the actual CLI callback against DOM state, including the wrong
            // aria-current value, so a no-op or permissive wait cannot pass.
            expect(predicate(id)).toBe(false);
            button.setAttribute('aria-current', panelKind === 'category' ? 'location' : 'true');
            expect(predicate(id)).toBe(false);
            button.setAttribute('aria-current', panelKind === 'category' ? 'true' : 'location');
            expect(predicate(id)).toBe(true);
            expect(predicate(`${id}-missing`)).toBe(false);
            actions.push(`panel-active:${id}`);
        },
    };
    return {page, actions, document, continuousPanels};
}

describe('settings center CLI navigation interactions', () => {
    it.each([false, true])('uses the visible desktop/mobile navigation before selecting model usage (mobile=%s)', async mobile => {
        const fixture = navigationPage(mobile);
        const {selectSettingsSection} = bindings(['settingsNavigationSelector', 'selectSettingsSection'], {document: fixture.document});
        await selectSettingsSection(fixture.page, 'settings-translation-stats', 'usage');
        expect(fixture.actions).toEqual([`${mobile ? 'mobile' : 'sidebar'}:settings-translation-stats`, 'active:settings-translation-stats', 'panel:usage', 'panel-active:usage']);
        expect(SETTINGS_TABBED_SECTION_IDS.has('settings-translation-stats')).toBe(true);
    });

    it.each([false, true])('waits for the motion anchor while retaining all continuous interface panels (mobile=%s)', async mobile => {
        const fixture = navigationPage(mobile, false, 'anchor');
        const {selectSettingsSection} = bindings(['settingsNavigationSelector', 'selectSettingsSection'], {document: fixture.document});
        await selectSettingsSection(fixture.page, 'settings-interface', 'motion');
        expect(fixture.actions).toEqual([`${mobile ? 'mobile' : 'sidebar'}:settings-interface`, 'active:settings-interface', 'panel:motion', 'panel-active:motion']);
        expect(SETTINGS_TABBED_SECTION_IDS.has('settings-interface')).toBe(false);
        expect(fixture.continuousPanels.map(panel => panel.dataset.settingsAnchor)).toEqual(bindings(['expectedInterfacePanelOrder']).expectedInterfacePanelOrder);
        expect(fixture.continuousPanels.every(panel => !panel.hidden)).toBe(true);
    });

    it('reopens a collapsed group before clicking its section', async () => {
        const {selectSettingsSection} = bindings(['settingsNavigationSelector', 'selectSettingsSection']);
        const fixture = navigationPage(false, true);
        await selectSettingsSection(fixture.page, 'settings-selection');
        expect(fixture.actions).toEqual(['expand-group', 'sidebar:settings-selection', 'active:settings-selection']);
    });

    it('requires a visible, in-bounds mobile selection matching the active canonical section', () => {
        const rect = {left: 12, right: 378, top: 16, bottom: 54, width: 366, height: 38};
        const mobile = {value: 'settings-interface', getClientRects: () => [rect], getBoundingClientRect: () => rect};
        const sidebar = {dataset: {section: 'settings-interface'}, getBoundingClientRect: () => ({...rect, width: 0, height: 0})};
        const globals = {innerWidth: 390, innerHeight: 844, document: {querySelector: (selector: string) => selector.startsWith('select') ? mobile : sidebar}};
        const {inspectSettingsNavigationVisibility} = bindings(['inspectSettingsNavigationVisibility'], globals);
        expect(inspectSettingsNavigationVisibility()).toBe(true);
        mobile.value = 'settings-general'; expect(inspectSettingsNavigationVisibility()).toBe(false);
        mobile.value = 'settings-interface'; rect.right = 400; expect(inspectSettingsNavigationVisibility()).toBe(false);
    });
});

function productionSource(relative: string): string {
    return readFileSync(resolve(__dirname, '..', relative), 'utf8');
}

function productionInterfacePanelNames(): string[] {
    const filename = 'src/features/settings/ui/InterfaceSettings.vue';
    const parsed = parseVueSfc(productionSource(filename), {filename});
    if (parsed.errors.length || !parsed.descriptor.template) throw new Error('Invalid actual InterfaceSettings template');
    return [...parsed.descriptor.template.content.matchAll(/<SettingsPanel\b[^>]*\bname="([^"]+)"/gu)].map(match => match[1]);
}

function productionChineseCopy(key: string): string {
    const relative = 'src/core/i18n/messages/zh-CN.ts';
    const messages = ts.createSourceFile(relative, productionSource(relative), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let value: string | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isPropertyAssignment(node) && ts.isStringLiteralLike(node.name) && node.name.text === key
            && ts.isStringLiteralLike(node.initializer)) value = node.initializer.text;
        ts.forEachChild(node, visit);
    };
    visit(messages);
    if (value === undefined) throw new Error(`Missing actual Chinese message: ${key}`);
    return value;
}

function cssDeclarations(relative: string, selector: string): Record<string, string> {
    // These production rules use literal selectors; include shared selector lists
    // and later declarations rather than assuming one rule per theme.
    const css = productionSource(relative).replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter(rule => rule[1].split(',').some(candidate => candidate.trim() === selector));
    if (!rules.length) throw new Error(`Missing production CSS rule: ${selector}`);
    return Object.fromEntries(rules.flatMap(rule => rule[2].split(';').flatMap(declaration => {
        const separator = declaration.indexOf(':');
        return separator < 0 ? [] : [[declaration.slice(0, separator).trim(), declaration.slice(separator + 1).trim()]];
    })));
}

describe('settings center CLI remaining current UI contracts', () => {
    it('uses the actual opaque ancestor behind a transparent OCR row without guessing non-solid surfaces', () => {
        const {resolveSolidBackground} = bindings(['parseHexColor', 'parseCssColor', 'resolveSolidBackground']);
        const row = cssDeclarations('src/features/image-translation/ui/image-ocr-settings.css', '.image-ocr-pack-card');
        expect(row.background).toBeUndefined();
        expect(row['background-color']).toBeUndefined();
        for (const color of ['rgb(255, 255, 255)', 'rgb(32, 38, 50)']) {
            expect(resolveSolidBackground([
                {color: 'rgba(0, 0, 0, 0)', image: 'none'},
                {color: 'transparent', image: 'none'},
                {color, image: 'none'},
                {color: 'rgb(0, 0, 0)', image: 'url(ignored-behind-opaque-surface)'},
            ])).toBe(color);
        }
        for (const layers of [
            [], [{color: 'transparent', image: 'none'}],
            [{color: 'rgba(32, 38, 50, 0.5)', image: 'none'}, {color: 'rgb(255, 255, 255)', image: 'none'}],
            [{color: 'rgb(255, 255, 255)', image: 'linear-gradient(#fff, #000)'}],
            [{color: 'transparent', image: 'url(background.png)'}, {color: 'rgb(255, 255, 255)', image: 'none'}],
            [{color: 'invalid', image: 'none'}],
        ]) expect(resolveSolidBackground(layers)).toBeNull();
    });
    it('checks the About QR against available card width and square presentation', () => {
        const {matchesAboutSupportQrBounds} = bindings(['matchesAboutSupportQrBounds']);
        const css = cssDeclarations('src/features/settings/ui/settings-page.css', '.about-support-qr');
        expect(css.width).toBe('100%');
        expect(css.height).toBe('auto');
        expect(css['aspect-ratio']).toBe('1');
        expect(css['object-fit']).toBe('contain');
        for (const availableWidth of [148, 200, 320]) {
            expect(matchesAboutSupportQrBounds({width: availableWidth, height: availableWidth}, availableWidth)).toBe(true);
            expect(matchesAboutSupportQrBounds({width: availableWidth + .4, height: availableWidth - .4}, availableWidth)).toBe(true);
        }

        const about = productionSource('src/app/options/OptionsApp.vue');
        const image = about.match(/<img\b[^>]*class="about-support-qr"[^>]*>/)?.[0];
        const button = about.match(/<button\b[^>]*class="about-support-method about-support-wechat"[^>]*>/)?.[0];
        expect(image).toBeDefined();
        expect(button).toBeDefined();
        const {document} = parseHTML(`<html><body>${button}${image}</button></body></html>`);
        const trigger = document.querySelector('button')!;
        expect(trigger.getAttribute('href')).toBeNull();
        expect(trigger.getAttribute('@click')).toBe("openQrPreview('support')");
        expect(trigger.querySelector('img')?.getAttribute('width')).toBe('1152');
        expect(trigger.querySelector('img')?.getAttribute('height')).toBe('1152');
    });

    it.each([
        null, {width: 0, height: 0}, {width: 258, height: 260}, {width: 260, height: 258},
        {width: 148, height: 148}, {width: 280, height: 280},
        {width: 259, height: 261}, {width: NaN, height: 260}, {width: 260, height: Infinity},
    ])('rejects a missing, undersized, overflowing or distorted About QR (%j)', bounds => {
        const {matchesAboutSupportQrBounds} = bindings(['matchesAboutSupportQrBounds']);
        expect(matchesAboutSupportQrBounds(bounds, 260)).toBe(false);
    });

    it('keeps all five current quick features in the matrix after explicitly adding appearance', () => {
        const {expectedExpandedQuickFeatureCount, defaultQuickFeatureOrder, defaultVisibleQuickFeatures} = bindings([
            'expectedExpandedQuickFeatureCount', 'defaultQuickFeatureOrder', 'defaultVisibleQuickFeatures',
        ]);
        expect(expectedExpandedQuickFeatureCount).toBe(DEFAULT_POPUP_QUICK_FEATURE_ORDER.length);
        expect(expectedExpandedQuickFeatureCount).toBe(defaultQuickFeatureOrder.length);
        expect(defaultVisibleQuickFeatures).not.toContain('appearance');
        expect(defaultQuickFeatureOrder).toContain('appearance');
        const matrix = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'verifyInterfaceDesignMatrix');
        expect(matrix?.getText(ast)).toContain('layoutMetrics.featureCount !== expectedExpandedQuickFeatureCount');
    });

    it('uses the flat palette surface and the declared action background for every light/dark skin', () => {
        const {matchesPalettePopupSurfaces} = bindings(['parseHexColor', 'parseCssColor', 'matchesPalettePopupSurfaces']);
        const palette = cssDeclarations('src/ui/styles/interface-skins/palette.css', ':root[data-interface-skin-kind="palette"][data-interface-skin] .popup-shell');
        const button = cssDeclarations('src/ui/styles/interface-skins/palette.css', ':root[data-interface-skin-kind="palette"][data-interface-skin] .translate-button');
        expect(palette.background).toBe('var(--skin-page)');
        expect(button.background).toBe('var(--skin-action-background, var(--brand))');
        for (const skin of interfaceSkinOptions.filter(skin => skin.kind === 'palette')) {
            for (const theme of ['', '.dark']) {
                const file = `src/ui/styles/interface-skins/${skin.value}.css`;
                const light = cssDeclarations(file, `:root[data-interface-skin="${skin.value}"]`);
                // Dark declarations override the still-matching light rule; some skins
                // intentionally inherit the action fill or share one light/dark rule.
                const tokens = theme ? {...light, ...cssDeclarations(file, `:root${theme}[data-interface-skin="${skin.value}"]`)} : light;
                const declared = tokens['--skin-action-background'];
                expect(declared, `${skin.value}${theme} action background`).toMatch(/^#[\da-f]{3,6}$/i);
                expect(matchesPalettePopupSurfaces({
                    actionContrast: 4.5, declaredActionBackground: declared, translateButtonBackground: declared,
                    translateButtonBackgroundImage: 'none', shellBackgroundImage: 'none',
                })).toBe(true);
            }
        }
        const shuimo = cssDeclarations('src/ui/styles/interface-skins/shuimo.css', ':root[data-interface-skin="shuimo"]');
        expect(shuimo['--skin-action-background']).not.toBe(shuimo['--brand']);
        expect(source).toContain("declaredActionBackground: rootStyle.getPropertyValue('--skin-action-background').trim()");
    });

    it.each([
        {actionContrast: 4.49}, {actionContrast: Infinity}, {actionContrast: NaN}, {translateButtonBackground: '#3d3b4f'},
        {translateButtonBackgroundImage: 'linear-gradient(#fff, #000)'},
        {shellBackgroundImage: 'radial-gradient(#fff, #000)'},
        {declaredActionBackground: ''}, {translateButtonBackground: 'transparent'},
    ])('still rejects insufficient contrast, wrong action color or decorated palette surfaces (%j)', change => {
        const {matchesPalettePopupSurfaces} = bindings(['parseHexColor', 'parseCssColor', 'matchesPalettePopupSurfaces']);
        const metrics = {
            actionContrast: 4.5, declaredActionBackground: '#161823', translateButtonBackground: 'rgb(22, 24, 35)',
            translateButtonBackgroundImage: 'none', shellBackgroundImage: 'none', ...change,
        };
        expect(matchesPalettePopupSurfaces(metrics)).toBe(false);
    });

    it('finds current always-visible model usage sections and their exact accessible names', () => {
        const {modelUsageAverageSelector, modelUsageRequestLogSelector} = bindings(['modelUsageAverageSelector', 'modelUsageRequestLogSelector']);
        const dashboard = productionSource('src/features/model-usage/ui/ModelUsageDashboard.vue');
        const average = dashboard.match(/<section\b[^>]*class="usage-average-card"[^>]*>/)?.[0];
        const requests = dashboard.match(/<section\b[^>]*class="usage-card usage-request-log-card"[^>]*>/)?.[0];
        const title = dashboard.match(/<strong id="usage-request-log-title">[^<]*<\/strong>/)?.[0];
        expect(average).toBeDefined(); expect(requests).toBeDefined(); expect(title).toBeDefined();
        const {document} = parseHTML(`<html><body><div id="settings-model-usage">${average}</section>${requests}${title}</section></div></body></html>`);
        const averageSection = document.querySelector(modelUsageAverageSelector)!;
        const requestSection = document.querySelector(modelUsageRequestLogSelector)!;
        expect(averageSection.getAttribute('aria-label')).toBe('平均每次请求');
        expect(requestSection.getAttribute('aria-labelledby')).toBe('usage-request-log-title');
        expect(requestSection.querySelector('#usage-request-log-title')?.textContent).toBe('模型调用记录');
        expect(averageSection.querySelector('summary')).toBeNull();
        expect(requestSection.querySelector('summary')).toBeNull();
        const legacy = parseHTML('<html><body><div id="settings-model-usage"><details class="usage-average-card"><summary>平均</summary></details><details class="usage-request-log-card" open><summary>请求记录</summary></details></div></body></html>').document;
        expect(legacy.querySelector(modelUsageAverageSelector)).toBeNull();
        expect(legacy.querySelector(modelUsageRequestLogSelector)).toBeNull();
    });

    it('retains the exact production default-service help copy', () => {
        const {expectedDefaultServiceDescription} = bindings(['expectedDefaultServiceDescription']);
        const copy = productionSource('src/core/i18n/messages/zh-CN.ts')
            .match(/'quickTranslation\.defaultServiceDescription':\s*"([^"]+)"/)?.[1];
        expect(copy).toBeDefined();
        expect(expectedDefaultServiceDescription).toBe(copy);
        expect(productionSource('src/features/settings/ui/SettingsSections.vue'))
            .toContain(':description="t(\'quickTranslation.defaultServiceDescription\')"');
    });

    it('keeps the complete custom-service name visible, wrapping and within its card', () => {
        const {matchesWrappedServiceLabel} = bindings(['matchesWrappedServiceLabel']);
        const css = cssDeclarations('src/features/settings/ui/services/ServiceCatalogItem.vue', '.library-name strong');
        expect(css['white-space']).toBe('normal');
        expect(css['overflow-wrap']).toBe('anywhere');
        const metrics = {
            cardLeft: 0, cardRight: 220, labelLeft: 44, labelRight: 180, labelWidth: 136, labelHeight: 40,
            overflow: 'visible', textOverflow: 'clip', whiteSpace: css['white-space'], overflowWrap: css['overflow-wrap'],
        };
        expect(matchesWrappedServiceLabel(metrics)).toBe(true);
        for (const change of [
            {labelLeft: -2}, {labelRight: 222}, {labelRight: null}, {labelWidth: 0}, {labelHeight: 0},
            {overflow: 'hidden'}, {textOverflow: 'ellipsis'}, {whiteSpace: 'nowrap'}, {overflowWrap: 'normal'},
        ]) expect(matchesWrappedServiceLabel({...metrics, ...change})).toBe(false);
    });
});
