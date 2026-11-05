import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {parse, type SFCDescriptor} from 'vue/compiler-sfc';
import {popupQuickFeatureOptions} from '@/src/core/config/interfaceAppearance';

const mountPreparedPopupApp = vi.hoisted(() => vi.fn());
vi.mock('@/src/app/popup/mount', () => ({mountPreparedPopupApp}));
// 本文件只验证入口唤醒与路由；DOM 启动反馈由 popupStartupFeedback.test.ts 执行真实实现。
vi.mock('@/src/app/popup/startupFeedback', () => ({createPopupStartupFeedback: () => ({dispose() {}, fail() {}})}));
vi.mock('element-plus/es/components/base/style/css', () => ({}));
vi.mock('element-plus/es/components/tooltip/style/css', () => ({}));
vi.mock('@/src/app/popup/PopupApp.vue', () => ({default: {}}));
vi.mock('@/src/app/popup/PopupOnboarding.vue', () => ({default: {}}));
import {mountPopupApp} from '@/src/app/popup';

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), 'utf8');
}

type TemplateRoot = NonNullable<NonNullable<SFCDescriptor['template']>['ast']>;
type TemplateElement = Extract<TemplateRoot['children'][number], {type: 1}>;

function templateElements(content: string): TemplateElement[] {
    const {descriptor, errors} = parse(content);
    expect(errors).toEqual([]);
    expect(descriptor.template?.ast).toBeDefined();
    const elements: TemplateElement[] = [];
    function visit(children: TemplateRoot['children']) {
        for (const node of children) if (node.type === 1) {elements.push(node); visit(node.children);}
    }
    visit(descriptor.template!.ast!.children);
    return elements;
}

function directive(element: TemplateElement, name: string, argument?: string): string | undefined {
    const prop = element.props.find(prop => prop.type === 7 && prop.name === name
        && (argument === undefined || prop.arg?.type === 4 && prop.arg.content === argument));
    return prop?.type === 7 && prop.exp?.type === 4 ? prop.exp.content : undefined;
}

describe('popup feature visibility', () => {
    it('keeps compact page and section actions with their accessible purpose and guarded page ownership', () => {
        const elements = templateElements(source('src/app/popup/PopupApp.vue'));
        const entry = elements.find(node => node.tag === 'button'
            && node.props.some(prop => prop.type === 6 && prop.name === 'data-testid' && prop.value?.content === 'section-translation'))!;
        expect(entry).toBeDefined();
        const visible = directive(entry, 'if')!;
        expect(visible).toBe('!isThunderbird && !currentPdfSource');
        expect(runInNewContext(visible, {isThunderbird: false, currentPdfSource: undefined})).toBe(true);
        expect(runInNewContext(visible, {isThunderbird: true, currentPdfSource: undefined})).toBe(false);
        expect(runInNewContext(visible, {isThunderbird: false, currentPdfSource: {}})).toBe(false);
        const disabled = directive(entry, 'bind', 'disabled')!;
        expect(disabled).toBe('!config.on || currentSiteExtensionDisabled || translating || pageState.savingRule || (safariFreePool && (freePoolLoading || freePoolBusy))');
        const ready = {config: {on: true}, currentSiteExtensionDisabled: false, translating: false, pageState: {savingRule: false}, safariFreePool: false, freePoolLoading: false, freePoolBusy: false};
        expect(runInNewContext(disabled, ready)).toBe(false);
        for (const blocked of [
            {...ready, config: {on: false}}, {...ready, currentSiteExtensionDisabled: true},
            {...ready, translating: true}, {...ready, pageState: {savingRule: true}},
            {...ready, safariFreePool: true, freePoolLoading: true}, {...ready, safariFreePool: true, freePoolBusy: true},
        ]) expect(runInNewContext(disabled, blocked)).toBe(true);
        expect(directive(entry, 'bind', 'onClick')).toBe('pageButtons.section');
        expect(directive(entry, 'bind', 'aria-label')).toBe('sectionTranslationLabel');
        const main = elements.find(node => node.tag === 'button'
            && node.props.some(prop => prop.type === 6 && prop.name === 'data-testid' && prop.value?.content === 'page-translation'))!;
        expect(directive(main, 'bind', 'title')).toBe('pageTranslationTitle');
        expect(main.children.some(node => node.type === 1 && node.tag === 'kbd')).toBe(false);
        expect(main.children.some(node => node.type === 1 && node.tag === 'span'
            && node.children.some(child => child.type === 5 && child.content.type === 4 && child.content.content === 'pageTranslationButtonLabel'))).toBe(true);
    });
    it('keeps information highlight in settings with no Popup entry, drawer or messaging lifecycle', () => {
        const popup = source('src/app/popup/PopupApp.vue');
        const actions = source('src/app/popup/pageActions.ts');
        expect(popupQuickFeatureOptions.map(feature => feature.id)).not.toContain('highlight');
        expect(popup).not.toMatch(/PopupInformationHighlight|informationHighlight|INFORMATION_HIGHLIGHT|openDrawer\('highlight'\)/u);
        expect(actions).not.toContain('informationHighlight');
        expect(source('src/features/settings/ui/SettingsSections.vue')).toContain('<InformationHighlightSettings');
        expect(source('src/features/settings/ui/InformationHighlightSettings.vue')).toContain('id="information-highlight-settings"');
    });
    it('mounts smart highlighting with the continuous translation form under its own anchor', () => {
        const elements = templateElements(source('src/features/settings/ui/SettingsSections.vue'));
        const panel = (name: string) => elements.find(node => node.tag === 'SettingsPanel'
            && node.props.some(prop => prop.type === 6 && prop.name === 'name' && prop.value?.content === name))!;
        const reading = panel('reading'), highlight = panel('information-highlight');
        expect(reading).toBeDefined();expect(highlight).toBeDefined();
        expect(reading.children.some(node => node.type === 1 && node.tag === 'ReadingAssistanceSettings')).toBe(true);
        expect(reading.children.some(node => node.type === 1 && node.tag === 'InformationHighlightSettings')).toBe(false);
        const component = highlight.children.find(node => node.type === 1 && node.tag === 'InformationHighlightSettings') as TemplateElement;
        expect(component).toBeDefined();
        expect(directive(highlight, 'bind', 'active')).toBe('props.activePanel');
        expect(directive(component, 'if')).toBe("browserCapabilities.browser !== 'userscript' && props.activeSection === 'settings-translation'");
        expect(directive(component, 'bind', 'active')).toBe("viewActive && props.activeSection === 'settings-translation'");
        for (const name of ['reading', 'hover', 'input', 'page', 'context-menu', 'floating-ball', 'paragraph-copy', 'section-translation', 'excluded-languages']) {
            expect(panel(name)).toBeDefined();
            expect(directive(panel(name), 'bind', 'active')).toBe('props.activePanel');
        }
        for (const [name, target, component] of [
            ['context-menu', 'context-menu-settings', 'ContextMenuSettings'],
            ['paragraph-copy', 'paragraph-copy-settings', 'ParagraphCopySettings'],
            ['section-translation', 'section-translation-settings', 'SectionTranslationSettings'],
            ['excluded-languages', 'excluded-language-settings', 'ExcludedLanguageSettings'],
        ]) {
            expect(panel(name).props.some(prop => prop.type === 6 && prop.name === 'id' && prop.value?.content === target)).toBe(true);
            expect(panel(name).children.some(node => node.type === 1 && node.tag === component)).toBe(true);
        }
        const floating = elements.find(node => node.tag === 'section'
            && node.props.some(prop => prop.type === 6 && prop.name === 'id' && prop.value?.content === 'floating-ball-settings'))!;
        expect(floating.children).toContain(panel('floating-ball'));
        const wrapper = templateElements(source('src/features/settings/ui/components/SettingsPanel.vue')).find(node => node.tag === 'div')!;
        const visible = directive(wrapper, 'show')!;
        for (const name of ['reading', 'information-highlight', 'hover', 'input']) {
            expect(runInNewContext(visible, {active: undefined, name})).toBe(true);
        }
        const navigation = templateElements(source('src/features/settings/ui/components/SettingsSectionNavigation.vue'));
        const anchorButton = navigation.find(node => node.tag === 'button')!;
        expect(directive(anchorButton, 'on', 'click')).toBe('scrollToAnchor(anchor)');
        expect(directive(anchorButton, 'bind', 'data-settings-anchor-link')).toBe('anchor.id');
    });
    it('gives the toolbar popup an intrinsic width before the browser sizes its viewport', () => {
        const styles = source('src/app/popup/popup.css');
        const html = source('entrypoints/popup/index.html');
        const criticalStyles = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
        expect(criticalStyles).toContain('html { width: var(--interface-popup-width, 320px);');
        expect(criticalStyles).toContain('min-height: 460px;');
        expect(criticalStyles).toContain('display: flex;');
        expect(html.indexOf('</style>')).toBeLessThan(html.indexOf('src="/popup-startup.js"'));
        expect(styles).toContain('html { width: var(--interface-popup-width, 320px); }');
        // Firefox 以内容固有宽度定 popup 尺寸，body 不能用百分比宽度。
        const bodyWidth = 'body, #app { width: var(--fluentread-localized-popup-width, var(--interface-popup-width, 320px));';
        expect(criticalStyles).toContain(bodyWidth);
        expect(styles).toContain(bodyWidth);
        expect(styles).not.toContain('body, #app { width: 100%; }');
        expect(styles).not.toContain('width: min(var(--interface-popup-width, 360px), 100vw)');
        expect(styles).toContain('.popup-shell { max-height: 560px; overflow-y: auto;');
        expect(styles).toContain(':root[data-fluentread-embedded-popup] .popup-shell { max-height: min(560px, 100dvh); }');
    });

    it('keeps the real Popup under a first-open language mask until confirmation', () => {
        const popup = source('src/app/popup/PopupApp.vue');
        const onboarding = source('src/ui/components/UiLanguageOnboarding.vue');
        const styles = source('src/app/popup/popup.css');
        const i18n = source('src/ui/i18n.ts');
        const legacyDom = source('src/ui/i18n/legacyDom.ts');

        expect(popup).toContain('uiLanguageSetupCompleted');
        expect(popup).toContain('<UiLanguageOnboarding');
        expect(popup).toContain('<div v-show="!showLanguageOnboarding" class="popup-content" :inert="showLanguageOnboarding">');
        expect(popup).toContain('@confirmed="handleLanguageOnboardingConfirmed"');
        expect(popup).toContain('if (!showLanguageOnboarding.value) await hydrateCurrentSite();');
        expect(popup).toContain('void hydrateCurrentSite();');
        expect(onboarding).toContain('data-testid="onboarding-language-step"');
        expect(onboarding).toContain('nativeLanguageNames[option.value]');
        expect(onboarding).toContain(':lang="option.value"');
        expect(onboarding).toContain("messageZh('language.onboardingTitle')");
        expect(onboarding).toContain("messageEn('language.onboardingTitle')");
        expect(onboarding).toContain("messageZh('language.onboardingConfirm')");
        expect(onboarding).toContain("messageEn('language.onboardingConfirm')");
        expect(onboarding).not.toContain('onboarding-welcome');
        expect(onboarding).not.toContain('onboarding-back');
        expect(onboarding).not.toContain('onboarding-success');
        expect(onboarding).not.toContain('setTimeout');
        expect(onboarding).not.toContain('min-height: 460px');
        expect(onboarding).toContain('committed.value = true');
        expect(styles).toContain('.popup-shell.language-onboarding-shell { overflow-x: hidden; }');
        expect(styles).toContain('.popup-shell { max-height: 560px; overflow-y: auto;');
        expect(onboarding).toContain('.language-onboarding {\n  position: relative;');
        expect(i18n).toContain("import {createUiI18nDirective, observeUiDocument} from './i18n/legacyDom';");
        expect(i18n).toContain('const directive = createUiI18nDirective(context);');
        expect(i18n).toContain('observeUiDocument(uiRoot, context)');
        expect(legacyDom).toContain('function isRelevantUiMutation');
        expect(legacyDom).toContain('setTimeout(() => {');
        expect(legacyDom).toContain('state.observer.disconnect();');
    });

    it('places app language after extension status and target language first in translation display', () => {
        const settings = source('src/features/settings/ui/SettingsSections.vue');
        const options = source('src/app/options/OptionsApp.vue');

        const positions = {
            status: settings.indexOf('data-testid="plugin-master-setting"'),
            language: settings.indexOf("t('settings.general.language')"),
            theme: settings.indexOf("t('settings.general.theme')"),
            service: settings.indexOf('data-testid="default-translation-service-card"'),
            target: settings.indexOf("t('settings.general.defaultTargetLanguage')"),
            display: settings.indexOf('label="翻译模式"'),
        };
        for (const position of Object.values(positions)) expect(position).toBeGreaterThanOrEqual(0);
        expect(positions.status).toBeLessThan(positions.language);
        expect(positions.language).toBeLessThan(positions.theme);
        expect(positions.target).toBeGreaterThan(positions.service);
        expect(positions.target).toBeLessThan(positions.display);
        expect(options).not.toContain('<UiLanguageSelector />');
        expect(options).not.toContain('<p>{{ activeItem.detail }}</p>');
    });

    it('uses multilingual labels in every target-language control', () => {
        const popup = source('src/app/popup/PopupLanguageSelect.vue');
        const settings = source('src/features/settings/ui/SettingsSections.vue');
        const center = source('src/features/translation-center/ui/TranslationCenter.vue');
        const documentApp = source('src/app/document-translation/DocumentApp.vue');

        expect(popup).toContain('getMultilingualTargetLanguageLabel(item.value, item.label, language.value)');
        expect(settings).toContain(':label="getMultilingualTargetLanguageLabel(item.value, item.label, language)"');
        expect(center).toContain('getMultilingualTargetLanguageLabel(item.value, item.label, language)');
        expect(documentApp).toContain('getMultilingualTargetLanguageLabel(item.value, item.label, language)');
    });

    it('shares source-language choices across Popup, document, translation center and userscript', () => {
        const popup = source('src/app/popup/PopupLanguageSelect.vue');
        const center = source('src/features/translation-center/ui/TranslationCenter.vue');
        const documentApp = source('src/app/document-translation/DocumentApp.vue');
        const userscript = source('userscript/SettingsPanel.vue');
        for (const entry of [popup, center, documentApp, userscript]) {
            expect(entry).toContain('options.from');
            expect(entry).not.toContain('options.form');
        }
        expect(popup).toContain("item.value === 'auto'");
        expect(popup).toContain('translateLegacy(item.label)');
    });

    it('keeps popup language filtering without the decorative search icon', () => {
        const popup = source('src/app/popup/PopupLanguageSelect.vue');
        const select = source('src/ui/components/UiSelect.vue');
        expect(popup).toContain('filterable');
        expect(popup).toContain(':show-search-icon="false"');
        expect(select).toContain('showSearchIcon !== false');
        expect(select).toContain(':filterable="filterable"');
    });

    it('prioritizes switches and useful diagrams in three quick panels while retaining internal scrolling and navigation', () => {
        const popup = source('src/app/popup/PopupApp.vue');
        const styles = source('src/app/popup/popup.css');
        expect(popup).toContain("'popup-quick-drawer': ['hover', 'selection', 'image'].includes(activeDrawer)");
        expect(styles).toContain('max-height: calc(100% - 8px)');
        expect(styles).toContain('.popup-drawer .el-drawer__body { min-height: 0; padding: 0; overflow-x: hidden; overflow-y: auto;');
        expect(styles).toContain('scrollbar-gutter: stable; scrollbar-width: thin;');
        expect(popup).not.toContain('class="wordbook-shortcut"');
        expect(popup).not.toContain('class="setting-row selection-trigger-setting"');
        expect(popup).toContain('data-testid="hover-enable"');
        expect(popup).toContain('data-testid="selection-enable"');
        expect(popup).toContain('data-testid="area-translation-demo"');
        expect(popup).toContain("t('popup.quickSettings.moreSettings')");
        expect(popup).toContain('class="drawer-settings-link"');
    });

    it('uses the same multilingual display policy for interface-language selectors', () => {
        const selector = source('src/ui/components/UiLanguageSelector.vue');
        const onboarding = source('src/ui/components/UiLanguageOnboarding.vue');

        expect(selector).toContain('getUiLanguageDisplayLabel(option.value, language)');
        expect(selector).toContain('<ElSelect');
        expect(selector).toContain('popper-class="ui-language-select-popper"');
        expect(selector).not.toContain('<select');
        expect(onboarding).toContain('nativeLanguageNames[option.value]');
    });

    it('blocks early interaction until the stored configuration is hydrated', () => {
        const popup = source('src/app/popup/PopupApp.vue');
        const styles = source('src/app/popup/popup.css');
        const startup = source('src/app/popup/mount.ts');

        expect(popup).toContain(':data-config-ready="hydrated ? \'true\' : \'false\'"');
        expect(popup).toContain(':inert="!hydrated"');
        expect(popup).toContain(':aria-busy="!hydrated"');
        expect(popup).toContain('useConfigEditor({');
        expect(popup).toContain("flush: 'post'");
        expect(popup).toContain('ready: configReady');
        expect(popup).toContain('saveDraft: snapshot => persistConfigPatch(snapshot)');
        expect(popup).toContain('!config.value.uiLanguageSetupCompleted');
        expect(styles).toContain('.popup-shell.config-loading { pointer-events: none; }');
        expect(startup.indexOf('await configReady')).toBeLessThan(startup.indexOf('const app = createApp(App)'));
        expect(popup).toContain('const config = ref(normalizeConfig(runtimeConfig))');
        expect(popup).not.toContain('ref(new Config())');
        expect(popup.indexOf('applyInterfaceSkin(config.value.interfaceSkin)')).toBeLessThan(popup.indexOf('hydrated.value = true'));
    });

    it('keeps full-page floating-ball settings out of the popup', () => {
        const popup = source('src/app/popup/PopupApp.vue');

        expect(popup).not.toContain("openDrawer('floating')");
        expect(popup).not.toContain("activeDrawer === 'floating'");
        expect(popup).not.toContain('全文悬浮球');
        expect(popup).not.toContain('启用或关闭全文翻译悬浮球');
        expect(popupQuickFeatureOptions).toHaveLength(5);
        expect(popup).toContain('v-for="feature in visiblePopupQuickFeatures"');
        expect(popup).toContain(':data-popup-quick-feature="feature.id"');
    });

    it('keeps full-page floating-ball and hotkey controls in the options page', () => {
        const elements = templateElements(source('src/features/settings/ui/SettingsSections.vue'));

        const toggles = elements.filter(node => node.tag === 'el-switch'
            && directive(node, 'model') === 'floatingBallEnabled');
        expect(toggles).toHaveLength(1);
        expect(directive(toggles[0], 'bind', 'aria-label')).toBe("t('settings.general.floatingBall')");
        const hotkeys = elements.filter(node => node.tag === 'el-select'
            && directive(node, 'bind', 'model-value') === 'config.floatingBallHotkey');
        expect(hotkeys).toHaveLength(1);
        expect(hotkeys[0].props.some(prop => prop.type === 6 && prop.name === 'aria-label'
            && prop.value?.content === '全文翻译快捷键')).toBe(true);
    });

    it('keeps beta labels out of every user-facing feature surface', () => {
        const userFacingSources = [
            'src/app/popup/PopupApp.vue',
            'src/app/document-translation/DocumentApp.vue',
            'src/features/settings/model/navigation.ts',
            'src/features/settings/ui/SettingsSections.vue',
            'src/core/config/catalog.ts',
            'src/features/video-subtitle/content/runtime.ts',
        ].map(source);
        const localizedCatalogs = [
            'src/core/i18n/messages/zh-CN.ts',
            'src/core/i18n/messages/en-US.ts',
            'src/core/i18n/messages/ja-JP.ts',
            'src/core/i18n/messages/ko-KR.ts',
            'src/core/i18n/messages/fr-FR.ts',
            'src/core/i18n/messages/ru-RU.ts',
            'src/core/i18n/messages/es-ES.ts',
            'src/core/i18n/messages/legacy-overrides.ts',
        ].map(source);
        const vocabulary = source('src/features/vocabulary/ui/VocabularyBook.vue');

        for (const content of userFacingSources) {
            expect(content).not.toMatch(/\bBeta\b|测试版/u);
        }
        for (const content of localizedCatalogs) {
            expect(content).not.toMatch(/\bBeta\b|Bêta|ベータ|베타|Бета/u);
        }
        expect(vocabulary).not.toMatch(/>\s*Beta\s*<|开启 Beta|Beta 已开启|单词本 Beta/u);
    });

    it('keeps page and section translation directly reachable without adding video/area cards', () => {
        const popup = source('src/app/popup/PopupApp.vue');
        expect(popupQuickFeatureOptions.map(feature => feature.id)).toEqual(['hover', 'selection', 'appearance', 'image', 'document']);
        expect(popup).toContain('data-testid="page-translation"');
        expect(popup).toContain(':onClick="pageButtons.toggle"');
        expect(popup).toContain('data-testid="section-translation"');
        expect(popup.indexOf('data-testid="section-translation"')).toBeLessThan(popup.indexOf('<el-drawer'));
        expect(popup).not.toContain('class="eyebrow features-eyebrow"');
        expect(popup).toContain('data-testid="popup-version"');
        expect(popup).toContain("browser.runtime.getManifest().version");
        expect(popup).toContain(":aria-label=\"t('popup.donationTitle')\"");
        expect(source('src/app/popup/popup.css')).not.toContain('.opensource-link span { display: none; }');
        expect(popup).not.toContain("activeDrawer === 'video'");
        expect(popup).not.toContain("activeDrawer === 'area'");
    });

    it('keeps unsupported capability explanations reachable while disabling only their actions', () => {
        const popup = source('src/app/popup/PopupApp.vue');

        expect(popup).toContain('当前浏览器暂不支持圈选翻译');
        expect(popup).toContain('当前浏览器暂不支持图片翻译与 OCR');
        expect(popup).toContain('v-else class="image-method"');
        expect(popup).toContain('v-if="browserCapabilities.imageTranslation" class="image-method"');
        expect(popup).toContain("image: 'settings-image-translation'");
        expect(popup).not.toContain(':disabled="!config.on || !browserCapabilities.imageTranslation"');
        expect(popup).not.toContain(':disabled="!browserCapabilities.areaTranslation"');
    });

    it('keeps video and reading preferences available in full settings after simplifying quick menus', () => {
        const popup = source('src/app/popup/PopupApp.vue');
        const settings = source('src/features/settings/ui/SettingsSections.vue');
        const modelSettings = source('src/features/settings/ui/VideoLocalModelSettings.vue');
        const ttsSettings = source('src/features/settings/ui/LocalTtsSettings.vue');
        const appearance = source('src/features/settings/ui/VideoSubtitleAppearanceSettings.vue');
        const translationStyle = source('src/features/settings/ui/TranslationStyleSettings.vue');

        expect(settings).toContain('id="settings-video"');
        expect(settings).toContain('<VideoSubtitleAppearanceSettings');
        expect(appearance).toContain('v-model="config.videoSubtitleDisplayMode"');
        expect(popup).not.toContain('v-model="config.videoService"');
        expect(popup).not.toContain('v-model="config.videoLocalModel"');
        expect(popup).not.toContain('v-model="config.selectionTtsVoices"');
        expect(settings).toContain('v-model="config.videoService"');
        expect(settings).toContain('v-model="config.videoSourceLanguage"');
        expect(settings).toContain('<LocalTtsSettings :config="config"');
        // 同一个控件保留读值、更新事件、多选与在线行归属；实际写回和旧事件隔离由 localModelSettingsLifecycle 的完整 client SFC 覆盖。
        const speech = templateElements(ttsSettings);
        const voiceControls = speech.filter(node => node.tag === 'el-select'
            && directive(node, 'bind', 'model-value') === 'config.selectionTtsVoices');
        expect(voiceControls).toHaveLength(1);
        expect(directive(voiceControls[0], 'bind', 'onUpdate:modelValue')).toBe('actions.voices');
        expect(directive(voiceControls[0], 'bind', 'disabled')).toBe('!active');
        expect(voiceControls[0].props.some(prop => prop.type === 6 && prop.name === 'multiple')).toBe(true);
        const voiceRow = speech.find(node => node.props.some(prop => prop.type === 6
            && prop.name === 'data-testid' && prop.value?.content === 'speech-online-voices'))!;
        expect(voiceRow).toBeDefined();
        expect(voiceRow.children).toContain(voiceControls[0]);
        expect(directive(voiceRow, 'if')).toBe("ttsMode !== 'local-only'");
        // 译文样式迁到界面风格页的样式卡片；弹窗“译文显示”只保留翻译模式并跳转到那里。
        expect(settings).not.toContain('v-model="config.style"');
        expect(translationStyle).toContain('@click="selectPreset(preset.value)"');
        expect(popup).toContain("appearance: 'settings-interface'");
        expect(settings).toContain('v-model="config.theme"');
        // 模型 radio 保留卡片内的模板绑定；当前模型写回与旧 radio/card/download 回调归属由完整 client SFC 覆盖。
        const models = templateElements(modelSettings);
        const radios = models.filter(node => node.tag === 'input' && node.props.some(prop => prop.type === 6
            && prop.name === 'name' && prop.value?.content === 'video-local-model'));
        expect(radios).toHaveLength(1);
        expect(directive(radios[0], 'model')).toBe('item.selection.value');
        const radioLabel = models.find(node => node.tag === 'label' && node.children.includes(radios[0]))!;
        expect(radioLabel).toBeDefined();
        const card = models.find(node => node.tag === 'article' && node.children.includes(radioLabel))!;
        expect(card).toBeDefined();
        expect(directive(card, 'for')).toBe('item in modelCards');
        expect(appearance).toContain('v-model.number="config.videoSubtitleAppearance.fontScale"');
    });

    it('groups image and area controls while retaining independent text selection', () => {
        const popup = source('src/app/popup/PopupApp.vue');
        const settings = source('src/features/settings/ui/SettingsSections.vue');
        const areaSettings = source('src/features/settings/ui/AreaTranslationSettings.vue');
        const ocrSettings = source('src/features/image-translation/ui/ImageOcrSettings.vue');

        expect(popupQuickFeatureOptions.map(feature => feature.id)).not.toContain('area');
        expect(popup).toContain("image: 'settings-image-translation'");
        expect(popup).toContain('class="image-method"');
        expect(popup).not.toContain('selectionDrawerTab');
        const selectionCard = popup.slice(popup.indexOf("  selection: {"), popup.indexOf("  appearance: {"));
        expect(selectionCard).not.toContain('selectionAreaEnabled');
        const imageSection = settings.slice(settings.indexOf('id="settings-image-translation"'), settings.indexOf('id="settings-video"'));
        expect(imageSection).toContain('selectionAreaTranslationEnabled');
        expect(areaSettings).toContain('props.config.areaTranslationService');
        expect(areaSettings).toContain('props.config.areaTranslationMode');
        expect(areaSettings).toContain(':placeholder="t(\'area.settings.followService\')"');
        expect(areaSettings).toContain('servicesType.isUseAIContext');
        expect(areaSettings).toContain('v-if="props.showOcr !== false"');
        expect(ocrSettings).toContain('`${props.idPrefix}-ocr-pack-title`');
    });

    it('routes hover and selection drawers to their dedicated settings', () => {
        const popup = source('src/app/popup/PopupApp.vue');

        expect(popup).toContain("hover: 'settings-translation'");
        expect(popup).toContain("selection: 'settings-selection'");
        expect(popup).not.toContain("'settings-shortcuts'");
    });

    it('keeps multi-profile editing in options while surfacing an accurate popup summary', () => {
        const popup = source('src/app/popup/PopupApp.vue');
        const styles = source('src/app/popup/popup.css');

        expect(popup).toContain("enabledQuickTranslationProfiles(config.value.quickTranslationProfiles, 'hover')");
        expect(popup).toContain('data-testid="popup-quick-hover-profiles"');
        expect(popup).toContain('{{ quickProfileSummary(profile) }}');
        expect(popup).toContain("t('popup.quickTranslation.defaultHoverShortcut')");
        expect(popup).toContain("t('popup.quickTranslation.defaultOnly', {count: quickHoverProfiles.length})");
        expect(popup).toContain(':onClick="drawerActions.hover"');
        expect(popup).toContain(':aria-checked="defaultHoverEnabled"');
        expect(popup).toContain("t('popup.quickSettings.chooseHoverShortcut')");
        expect(popup).not.toContain("setHoverHotkey('Control')");
        expect(popup).toContain("resolveConfiguredHotkey(config.value.hotkey, config.value.customHotkey)");
        expect(popup).not.toContain('aria-label="启用或关闭鼠标悬停翻译"');
        expect(popup).toContain("t('popup.quickTranslation.extraProfiles')");
        expect(popup).not.toContain('<QuickTranslationProfiles');
        expect(popup).toContain('findEnabledQuickTranslationHotkeyConflict');
        expect(popup).not.toContain('CustomHotkeyInput');
        expect(styles).toContain('.quick-profile-preview-row');
    });

    it('filters Chrome Translator but renders old synchronized selections as unavailable', () => {
        const popup = source('src/app/popup/PopupApp.vue');

        expect(source('src/app/popup/PopupServices.vue')).toContain('isTranslationServiceAvailable(option.value)');
        expect(popup).toContain('selectedServiceUnavailableMessage');
        expect(popup).not.toContain("activeDrawer === 'video'");
        expect(source('src/features/settings/ui/SettingsSections.vue')).toContain('<el-option v-if="selectedTextServiceUnavailableMessage" :label="defaultTextServiceLabel" :value="config.service" disabled />');
        expect(popup).toContain('原有开关偏好已保留');
    });

    it('opens a lazy per-feature provider panel with service and model search', () => {
        const popup = source('src/app/popup/PopupApp.vue');
        const panel = source('src/app/popup/PopupServices.vue');
        expect(popup).toContain("defineAsyncComponent(() => import('./PopupServices.vue'))");
        expect(popup).toContain('withCustomOpenAIServiceOptions(');
        expect(panel).toContain('searchServiceOptions(');
        expect(panel).toContain('searchableModels.value');
        expect(panel).toContain('provider.models');
        expect(panel).toContain('setFeatureService(config, feature, service)');
        expect(popup).toContain(':active="drawerVisible && activeDrawer === \'services\'"');
        expect(panel).toContain('class="popup-service-overview"');
        expect(panel).toContain('class="popup-service-picker"');
        expect(panel).toContain('role="listbox"');
        expect(panel).not.toContain('<UiSelect');
        expect(popup).not.toContain('class="service-tools"');
    });

    it('keeps two compact site switches without a visible domain and frames the service entry', () => {
        const site = source('src/app/popup/PopupSiteRule.vue');
        const preview = source('src/features/settings/ui/components/PopupPreview.vue');
        const styles = source('src/app/popup/popup.css');
        expect(site).not.toContain('class="site-rule-copy"');
        expect(site).not.toContain('<span>当前网站</span>');
        expect(site).toContain(':data-site-domain="props.domain"');
        expect(site).toContain('always-translate-site');
        expect(site).toContain('disable-extension-site');
        expect(preview).not.toContain('fluentread.app');
        expect(preview).toContain('preview-site-rule-button');
        expect(styles).toMatch(/\.provider-summary \{[^}]*border: 1px solid var\(--line\)/);
    });
});

describe('popup worker wakeup', () => {
    afterEach(() => { vi.unstubAllGlobals(); mountPreparedPopupApp.mockClear(); });

    it('overlaps a pending runtime read with mounting without reusing its snapshot', async () => {
        let release!: (value: unknown) => void;
        const sendMessage = vi.fn(() => new Promise(resolve => { release = resolve; }));
        vi.stubGlobal('browser', {runtime: {sendMessage}});
        await mountPopupApp('#app');
        expect(sendMessage).toHaveBeenCalledWith({type: 'popupStartup'});
        expect(mountPreparedPopupApp).toHaveBeenCalledWith('#app');
        release({success: true, uiLanguageSetupCompleted: true});
    });

    it('consumes Chrome callback errors while allowing normal configuration hydration', async () => {
        vi.stubGlobal('browser', undefined);
        const lastError = vi.fn(() => ({message: 'worker unavailable'}));
        const runtime = {sendMessage: vi.fn((_message, callback) => callback()), get lastError() { return lastError(); }};
        vi.stubGlobal('chrome', {runtime});
        await mountPopupApp('#app');
        expect(lastError).toHaveBeenCalledOnce();
        expect(mountPreparedPopupApp).toHaveBeenCalledOnce();
    });

    it.each(['rejected', 'throws', 'missing'])('does not block mounting when pre-wakeup %s', async mode => {
        vi.stubGlobal('chrome', undefined);
        vi.stubGlobal('browser', mode === 'missing' ? undefined : {runtime: {sendMessage: () => {
            if (mode === 'throws') throw new Error('closed');
            return Promise.reject(new Error('closed'));
        }}});
        await mountPopupApp('#app');
        expect(mountPreparedPopupApp).toHaveBeenCalledOnce();
    });
});

describe('popup HTML pre-wakeup', () => {
    afterEach(() => { vi.unstubAllGlobals(); mountPreparedPopupApp.mockClear(); });
    it('starts native messaging before Vue modules and reuses its pending response', async () => {
        const html = source('entrypoints/popup/index.html');
        expect(html.indexOf('src="/popup-startup.js"')).toBeLessThan(html.indexOf('type="module"'));
        let release!: (value: unknown) => void;
        const sendMessage = vi.fn(() => new Promise(resolve => {release = resolve;}));
        const sandbox: {browser: unknown; __fluentReadPopupWarmup?: Promise<unknown>} = {browser: {runtime: {sendMessage}}};
        runInNewContext(source('public/popup-startup.js'), sandbox);
        expect(sendMessage).toHaveBeenCalledWith({type: 'popupStartup'});
        vi.stubGlobal('__fluentReadPopupWarmup', sandbox.__fluentReadPopupWarmup);
        vi.stubGlobal('browser', {runtime: {sendMessage}});
        await mountPopupApp('#app');
        expect(sendMessage).toHaveBeenCalledOnce();
        release({success: true, uiLanguageSetupCompleted: false});
        await expect(sandbox.__fluentReadPopupWarmup).resolves.toEqual({success: true, uiLanguageSetupCompleted: false});
    });

    it('consumes callback errors, Promise rejection, synchronous failure and absent runtime', async () => {
        const lastError = vi.fn(() => ({message: 'not ready'}));
        const sandboxes = [
            {chrome: {runtime: {sendMessage: (_message: unknown, callback: () => void) => callback(), get lastError() {return lastError();}}}},
            {browser: {runtime: {sendMessage: () => Promise.reject(new Error('not ready'))}}},
            {browser: {runtime: {sendMessage: () => {throw new Error('closed');}}}},
            {},
        ];
        for (const sandbox of sandboxes) {
            runInNewContext(source('public/popup-startup.js'), sandbox);
            expect(await (sandbox as {__fluentReadPopupWarmup?: Promise<unknown>}).__fluentReadPopupWarmup).toBeUndefined();
        }
        expect(lastError).toHaveBeenCalledOnce();
    });
});
