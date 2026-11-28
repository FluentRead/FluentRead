import * as runtime from 'vue';
import {Config} from '@/src/core/config/model';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import ParagraphCopySettings from '@/src/features/settings/ui/ParagraphCopySettings.vue';
import SectionTranslationSettings from '@/src/features/settings/ui/SectionTranslationSettings.vue';
import AreaTranslationSettings from '@/src/features/settings/ui/AreaTranslationSettings.vue';

// 执行实际 SFC setup/watch；关闭展示模板，浏览器录制与视觉不属于这个端口测试。
const feedback = vi.hoisted(() => Object.assign(vi.fn(), {warning: vi.fn()}));
vi.mock('element-plus', () => ({ElMessage: feedback}));
vi.mock('@element-plus/icons-vue', () => ({Edit: {render: () => null}}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string) => key, translateLegacy: (text: string) => text})}));
vi.mock('@/src/platform/browser/capabilities', () => ({browserCapabilities: {areaTranslation: true}}));
vi.mock('@/src/features/settings/ui/services/useVisionProbeStatus', () => ({useVisionProbeStatus: () => ({result: runtime.ref({capability: 'unknown'})})}));
vi.mock('@/src/features/image-translation/ui/public', () => ({ImageOcrSettings: {render: () => null}}));
vi.mock('@/src/features/settings/ui/components/SettingsGroup.vue', () => ({default: {render: () => null}}));
vi.mock('@/src/features/settings/ui/components/SettingsItem.vue', () => ({default: {render: () => null}}));
let app: import('vue').App, state: Record<string, any>, props: {config: Record<string, any>; active: boolean};
let visible: import('vue').Ref<boolean>;
type EditorName = 'ParagraphCopySettings' | 'SectionTranslationSettings' | 'AreaTranslationSettings';
async function settle() {await runtime.nextTick(); await runtime.nextTick();}
beforeEach(async () => {
    vi.clearAllMocks();feedback.warning.mockImplementation(feedback);
    props = runtime.reactive({active: true, config: Object.assign(new Config(), {paragraphCopyEnabled: true, paragraphCopyHotkey: 'Shift+D', customParagraphCopyHotkey: '',
        hotkey: 'Control', floatingBallHotkey: 'Alt+T', selectionTranslatorMode: 'disabled', inputBoxTranslationTrigger: 'none',
        selectionAreaEnabled: false, sectionTranslationHotkeyEnabled: false, commandPaletteEnabled: false, quickTranslationProfiles: []})});
    visible = runtime.ref(true);
    await mountEditor('ParagraphCopySettings');
});
async function mountEditor(name: EditorName) {
    app?.unmount();
    const source = name === 'ParagraphCopySettings' ? ParagraphCopySettings
        : name === 'SectionTranslationSettings' ? SectionTranslationSettings : AreaTranslationSettings;
    const component = {...source, render: () => null} as runtime.Component;
    const renderer = runtime.createRenderer<Record<string, never>, Record<string, unknown>>({patchProp: () => {}, insert: () => {},
        remove: () => {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText: () => {},
        setElementText: () => {}, parentNode: () => null, nextSibling: () => null, querySelector: () => null,
        setScopeId: () => {}, cloneNode: () => ({}), insertStaticContent: () => [{}, {}]});
    app = renderer.createApp({setup: () => () => runtime.h(runtime.KeepAlive, null, {default: () => visible.value
        ? runtime.h(component, {...props, ref: (vm: any) => {if (vm) state = vm.$.setupState;}})
        : runtime.h({render: () => null}, {key: 'other'})})});
    app.provide(runtime.ssrContextKey, {modules: new Set<string>()});
    app.config.warnHandler = () => {};
    app.mount({});
    await settle();
}
afterEach(async () => {app?.unmount(); vi.unstubAllGlobals();});

describe('段落复制设置实际组件草稿归属', () => {
    it('KeepAlive 离开后关闭录制，迟到动作不能修改配置，返回后可重新录制', async () => {
        state.handleHotkeyChange('custom');visible.value = false;await settle();
        expect(state.showCustomHotkeyDialog).toBe(false);
        state.handleCustomHotkeyConfirm('Alt+K');state.openCustomHotkeyDialog();state.handleHotkeyChange('Alt+D');
        expect(props.config.paragraphCopyHotkey).toBe('Shift+D');expect(state.showCustomHotkeyDialog).toBe(false);
        visible.value = true;await settle();state.handleHotkeyChange('custom');
        expect(state.showCustomHotkeyDialog).toBe(true);
    });
    it('保留挂载但离开翻译分区时关闭录制，迟到确认不得保存或重开', async () => {
        state.handleHotkeyChange('custom');props.active = false;await settle();
        expect(state.showCustomHotkeyDialog).toBe(false);
        state.handleCustomHotkeyConfirm('Alt+K');state.openCustomHotkeyDialog();state.handleHotkeyChange('Alt+D');
        expect(state.showCustomHotkeyDialog).toBe(false);expect(props.config.paragraphCopyHotkey).toBe('Shift+D');
        props.active = true;await settle();state.handleHotkeyChange('custom');
        expect(state.showCustomHotkeyDialog).toBe(true);
    });
    it('重复选择自定义后取消，仍保留进入录制前的快捷键', () => {
        state.handleHotkeyChange('custom'); state.handleHotkeyChange('custom'); state.handleCustomHotkeyCancel();
        expect(props.config.paragraphCopyHotkey).toBe('Shift+D');
        expect(state.showCustomHotkeyDialog).toBe(false);
    });
    it.each(['cancel', 'confirm'] as const)('录制期间换预设后，迟到 %s 不覆盖当前选择', async (action) => {
        state.handleHotkeyChange('custom'); state.handleHotkeyChange('Alt+D'); await settle();
        if (action === 'cancel') state.handleCustomHotkeyCancel(); else state.handleCustomHotkeyConfirm('Alt+K');
        expect(props.config.paragraphCopyHotkey).toBe('Alt+D');
        expect(props.config.customParagraphCopyHotkey).toBe('');
        expect(state.showCustomHotkeyDialog).toBe(false);
    });
    it('更换整个配置对象后关闭旧录制，旧确认不写入新对象', async () => {
        state.handleHotkeyChange('custom'); props.config = {...props.config, paragraphCopyHotkey: 'Alt+D'}; await settle();
        state.handleCustomHotkeyConfirm('Alt+K');
        expect(props.config.paragraphCopyHotkey).toBe('Alt+D'); expect(props.config.customParagraphCopyHotkey).toBe('');
        expect(state.showCustomHotkeyDialog).toBe(false); expect(feedback).not.toHaveBeenCalled();
    });
    it('确认前即时检查外部修改，即使尚未运行 watch 也不覆盖', () => {
        state.handleHotkeyChange('custom'); props.config.paragraphCopyHotkey = 'Alt+D'; state.handleCustomHotkeyConfirm('Alt+K');
        expect(props.config.paragraphCopyHotkey).toBe('Alt+D'); expect(props.config.customParagraphCopyHotkey).toBe('');
    });
    it('录制关闭开关后不再保存，并取消弹窗', async () => {
        state.handleHotkeyChange('custom'); props.config.paragraphCopyEnabled = false; await settle();
        state.handleCustomHotkeyConfirm('Alt+K');
        expect(props.config.paragraphCopyHotkey).toBe('Shift+D'); expect(state.showCustomHotkeyDialog).toBe(false);
    });
    it('有效确认保存规范组合键，清除录制回到默认复制入口', () => {
        state.handleHotkeyChange('custom'); state.handleCustomHotkeyConfirm('alt+k');
        expect(props.config.paragraphCopyHotkey).toBe('custom'); expect(props.config.customParagraphCopyHotkey).toBe('Alt+K');
        // 与各版本模板的编辑按钮入口一致：旧模板直接打开，当前模板建立草稿归属。
        if (state.openCustomHotkeyDialog) state.openCustomHotkeyDialog(); else state.showCustomHotkeyDialog = true;
        state.handleCustomHotkeyConfirm('none');
        expect(props.config.paragraphCopyHotkey).toBe('Alt+C'); expect(props.config.customParagraphCopyHotkey).toBe('');
    });
    it('清除后的默认复制组合键若被占用，保留录制并提示冲突', () => {
        state.handleHotkeyChange('custom'); props.config.floatingBallHotkey = 'Alt+C';
        expect(state.findHotkeyConflict('none')).toBe('paragraphCopy.settings.hotkeyConflict');
        state.handleCustomHotkeyConfirm('none');
        expect(props.config.paragraphCopyHotkey).toBe('Shift+D'); expect(state.showCustomHotkeyDialog).toBe(true);
    });
    it('快捷翻译方案占用默认组合键时，清除录制也不能绕过冲突校验', () => {
        state.handleHotkeyChange('custom');
        props.config.quickTranslationProfiles = [{id: 'copy-conflict', enabled: true, action: 'full-page', hotkey: 'Alt+C',
            service: '', model: '', targetLanguage: '', displayMode: 'inherit', fullPageMode: 'inherit'}];
        expect(state.findHotkeyConflict('none')).toBe('quickTranslation.conflictProfile');
        state.handleCustomHotkeyConfirm('none');
        expect(props.config.paragraphCopyHotkey).toBe('Shift+D'); expect(state.showCustomHotkeyDialog).toBe(true);
    });
    it('段落复制开关开启前复验快捷键占用，且视频字幕关闭总开关后释放占用', () => {
        props.config.paragraphCopyEnabled = false;
        props.config.paragraphCopyHotkey = 'Alt+C';
        props.config.videoTranslationEnabled = true;
        props.config.videoSubtitleModeHotkeyEnabled = true;
        props.config.videoSubtitleModeHotkey = 'custom';
        props.config.customVideoSubtitleModeHotkey = 'Alt+C';

        state.handleEnabledChange(true);
        expect(props.config.paragraphCopyEnabled).toBe(false);
        expect(feedback.warning).toHaveBeenCalledTimes(1);

        // 视频翻译总开关关闭后释放保留热键，允许开启段落复制
        props.config.videoTranslationEnabled = false;
        state.handleEnabledChange(true);
        expect(props.config.paragraphCopyEnabled).toBe(true);

        state.handleEnabledChange(false);
        expect(props.config.paragraphCopyEnabled).toBe(false);
    });
    it('关闭态存在快捷键冲突时保持快捷键可编辑以解除死锁，并校验智能高亮与旧版划词禁用开关', async () => {
        // 1) 智能高亮开启快捷键时识别冲突，关闭后释放
        props.config.informationHighlight = {...props.config.informationHighlight, hotkeyEnabled: true, hotkey: 'Alt+H'};
        expect(state.findHotkeyConflict('Alt+H')).toBe('paragraphCopy.settings.hotkeyConflict');
        props.config.informationHighlight = {...props.config.informationHighlight, hotkeyEnabled: false, hotkey: 'Alt+H'};
        expect(state.findHotkeyConflict('Alt+H')).toBe('');

        // 2) disableSelectionTranslator === true 时即使 mode 未置 disabled 也释放划词占用
        props.config.selectionTranslatorMode = 'bilingual';
        props.config.selectionTranslatorTrigger = 'custom';
        props.config.customSelectionTranslatorHotkey = 'Alt+Q';
        props.config.disableSelectionTranslator = false;
        expect(state.findHotkeyConflict('Alt+Q')).toBe('paragraphCopy.settings.hotkeyConflict');
        props.config.disableSelectionTranslator = true;
        expect(state.findHotkeyConflict('Alt+Q')).toBe('');

        // 3) 段落复制关闭且当前热键与视频字幕模式快捷键冲突时，允许直接更换组合键解除冲突再重开
        props.config.paragraphCopyEnabled = false;
        props.config.paragraphCopyHotkey = 'Alt+C';
        props.config.customParagraphCopyHotkey = '';
        props.config.videoTranslationEnabled = true;
        props.config.videoSubtitleModeHotkeyEnabled = true;
        props.config.videoSubtitleModeHotkey = 'custom';
        props.config.customVideoSubtitleModeHotkey = 'Alt+C';
        await settle();

        expect(state.currentHotkeyConflict).toBe('paragraphCopy.settings.hotkeyConflict');
        expect(state.showHotkeySelector).toBe(true);
        state.handleEnabledChange(true);
        expect(props.config.paragraphCopyEnabled).toBe(false);

        // 通过自定义录制更换为无冲突快捷键后，冲突消除且开关可以成功开启
        state.handleHotkeyChange('custom');
        expect(state.showCustomHotkeyDialog).toBe(true);
        state.handleCustomHotkeyConfirm('Alt+J');
        await settle();
        expect(props.config.paragraphCopyHotkey).toBe('custom');
        expect(props.config.customParagraphCopyHotkey).toBe('Alt+J');
        expect(state.currentHotkeyConflict).toBe('');

        state.handleEnabledChange(true);
        expect(props.config.paragraphCopyEnabled).toBe(true);
    });
});

// 同一生产草稿协议下的圈选/局部/复制入口，保留真实 SFC setup 与 core 冲突规则。
describe('其他设置入口不能抢占两点选取', () => {
    const editors = [
        {component:'ParagraphCopySettings', mode:'paragraphCopyHotkey', custom:'customParagraphCopyHotkey', enabled:'paragraphCopyEnabled'},
        {component:'SectionTranslationSettings', mode:'sectionTranslationHotkey', custom:'customSectionTranslationHotkey', enabled:'sectionTranslationHotkeyEnabled'},
        {component:'AreaTranslationSettings', mode:'selectionAreaHotkey', custom:'customSelectionAreaHotkey', enabled:'enabled'},
    ] as const;
    it.each(editors)('$component 预设、旧自定义和录制确认均拒绝正在使用的点选键', async editor => {
        Object.assign(props.config,{on:false,selectionTranslatorMode:'bilingual',disableSelectionTranslator:false,selectionClickSelectEnabled:true,selectionClickSelectHotkey:'Alt+Shift+S',
            sectionTranslationHotkeyEnabled:true,selectionAreaEnabled:true,[editor.mode]:'Alt+J',[editor.custom]:''});
        // Area 的开关由父级传入，其他两个入口直接读取 Config。
        Object.assign(props,{enabled:true});await mountEditor(editor.component);
        state.handleHotkeyChange('Alt+Shift+S');expect(props.config[editor.mode]).toBe('Alt+J');expect(feedback).toHaveBeenCalled();
        props.config[editor.custom]='Alt+Shift+S';state.handleHotkeyChange('custom');expect(props.config[editor.mode]).toBe('Alt+J');
        props.config[editor.custom]='';state.openCustomHotkeyDialog();expect(state.findHotkeyConflict('alt+shift+s')).toBeTruthy();
        state.handleCustomHotkeyConfirm('Alt+Shift+S');expect(props.config[editor.custom]).toBe('');expect(state.showCustomHotkeyDialog).toBe(true);
        props.config.selectionClickSelectEnabled=false;state.handleCustomHotkeyConfirm('Alt+Shift+S');expect(props.config[editor.custom]).toBe('Alt+Shift+S');
    });
});

describe('圈选与局部翻译的真实草稿恢复链', () => {
    const editors = [
        {component:'SectionTranslationSettings',mode:'sectionTranslationHotkey',custom:'customSectionTranslationHotkey',fallback:'Alt+R'},
        {component:'AreaTranslationSettings',mode:'selectionAreaHotkey',custom:'customSelectionAreaHotkey',fallback:'Shift+Z'},
    ] as const;
    it.each(editors)('$component 有效确认、取消、清除与迟到事件保持草稿所有权', async editor => {
        Object.assign(props.config,{sectionTranslationHotkeyEnabled:true,selectionAreaEnabled:true,[editor.mode]:'Alt+J',[editor.custom]:''});
        Object.assign(props,{enabled:true,serviceOptions:[]});await mountEditor(editor.component);
        state.handleHotkeyChange('custom');expect(state.showCustomHotkeyDialog).toBe(true);state.handleCustomHotkeyCancel();
        expect(props.config[editor.mode]).toBe('Alt+J');state.handleHotkeyChange('custom');state.handleCustomHotkeyConfirm('Alt+K');
        expect(props.config[editor.mode]).toBe('custom');expect(props.config[editor.custom]).toBe('Alt+K');
        state.openCustomHotkeyDialog();state.handleCustomHotkeyConfirm('none');expect(props.config[editor.mode]).toBe(editor.fallback);
        state.openCustomHotkeyDialog();props.active=false;await settle();state.handleHotkeyChange('Alt+L');state.handleCustomHotkeyConfirm('Alt+L');
        expect(props.config[editor.mode]).toBe(editor.fallback);expect(state.showCustomHotkeyDialog).toBe(false);
        props.active=true;await settle();state.handleHotkeyChange('Alt+M');expect(props.config[editor.mode]).toBe('Alt+M');
    });
    it.each(editors)('$component 实时复查所有旧入口与快捷方案占用，停用旧入口后可释放', async editor => {
        Object.assign(props.config,{sectionTranslationHotkeyEnabled:false,selectionAreaEnabled:false,paragraphCopyEnabled:false});
        Object.assign(props,{enabled:true,serviceOptions:[]});await mountEditor(editor.component);
        expect(state.findHotkeyConflict('F9')).toBe('');
        for(const patch of [
            {hotkey:'custom',customHotkey:'F9'}, {floatingBallHotkey:'custom',customFloatingBallHotkey:'F9'},
            {selectionTranslatorMode:'bilingual',selectionTranslatorTrigger:'custom',customSelectionTranslatorHotkey:'F9'},
            {paragraphCopyEnabled:true,paragraphCopyHotkey:'custom',customParagraphCopyHotkey:'F9'},
            {commandPaletteEnabled:true,commandPaletteHotkey:'custom',customCommandPaletteHotkey:'F9'},
            ...(editor.component==='SectionTranslationSettings'?[{selectionAreaEnabled:true,selectionAreaHotkey:'custom',customSelectionAreaHotkey:'F9'}]
                :[{sectionTranslationHotkeyEnabled:true,sectionTranslationHotkey:'custom',customSectionTranslationHotkey:'F9'}]),
        ]) {const before={...props.config};Object.assign(props.config,patch);expect(state.findHotkeyConflict('F9')).toBeTruthy();Object.assign(props.config,before);}
        props.config.quickTranslationProfiles=[{id:'reserved',action:'hover',enabled:true,hotkey:editor.fallback,service:'',model:'',targetLanguage:'',displayMode:'inherit',fullPageMode:'inherit'}];
        expect(state.findHotkeyConflict('none')).toBe('quickTranslation.conflictProfile');
    });
    it('局部翻译开关在开启时复验点选占用，无冲突才能保持开启', async () => {
        Object.assign(props.config,{selectionTranslatorMode:'bilingual',disableSelectionTranslator:false,selectionClickSelectEnabled:true,
            sectionTranslationHotkeyEnabled:true,sectionTranslationHotkey:'custom',customSectionTranslationHotkey:'Alt+Shift+S'});
        await mountEditor('SectionTranslationSettings');state.handleEnabledChange(false);expect(props.config.sectionTranslationHotkeyEnabled).toBe(true);
        state.handleEnabledChange(true);expect(props.config.sectionTranslationHotkeyEnabled).toBe(false);expect(feedback.warning).toHaveBeenCalled();
        props.config.customSectionTranslationHotkey='Alt+J';props.config.sectionTranslationHotkeyEnabled=true;state.handleEnabledChange(true);
        expect(props.config.sectionTranslationHotkeyEnabled).toBe(true);
    });
    it('圈选提示词只接纳当前可见且属于同一配置和开关的草稿，空值也可保存', async () => {
        Object.assign(props,{enabled:true,serviceOptions:[]});await mountEditor('AreaTranslationSettings');
        const original=props.config.areaVisionPrompt;state.updateVisionPrompt('closed');expect(props.config.areaVisionPrompt).toBe(original);
        props.active=false;await settle();state.openVisionPromptEditor();expect(state.promptEditorOpen).toBe(false);props.active=true;await settle();
        state.openVisionPromptEditor();state.updateVisionPrompt('');expect(props.config.areaVisionPrompt).toBe('');
        state.promptEditorOpen=false;await settle();state.updateVisionPrompt('late');expect(props.config.areaVisionPrompt).toBe('');
        state.openVisionPromptEditor();Object.assign(props,{enabled:false});await settle();state.updateVisionPrompt('disabled');await settle();
        expect(props.config.areaVisionPrompt).toBe('');expect(state.promptEditorOpen).toBe(false);
        Object.assign(props,{enabled:true});await settle();state.openVisionPromptEditor();const old=props.config;props.config={...old,areaVisionPrompt:'replacement'};await settle();
        state.updateVisionPrompt('stale');expect(props.config.areaVisionPrompt).toBe('replacement');expect(old.areaVisionPrompt).toBe('');
        state.openVisionPromptEditor();props.active=false;await settle();state.updateVisionPrompt('hidden');expect(props.config.areaVisionPrompt).toBe('replacement');
    });
});
