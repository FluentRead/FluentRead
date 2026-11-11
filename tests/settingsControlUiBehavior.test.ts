import './helpers/vueDomFixture';
/**
 * @file tests/settingsControlUiBehavior.test.ts
 * 文件职责：执行设置小组件真实 Vue 客户端模板与输入、切换和生命周期。
 * 主要内容：段落边界归一化、划词/阅读开关、词典来源及脚本版本地词库禁用、语言筛选、提示词插入与迟到焦点所有权。
 * 模块边界：布局、子控件和语言端口可控；被测 SFC、Vue 状态与核心归一化函数保持真实。
 */
import {parseHTML} from 'linkedom';
import {createRenderer, h, defineComponent, nextTick, shallowReactive, markRaw, reactive, ref, watch, type App, type Component} from 'vue';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import WebDavBackup from '@/src/features/settings/ui/WebDavBackup.vue';
import ParagraphHandlingSettings from '@/src/features/settings/ui/ParagraphHandlingSettings.vue';
import ToolbarClickSetting from '@/src/features/settings/ui/components/ToolbarClickSetting.vue';
import SelectionSettings from '@/src/features/settings/ui/SelectionSettings.vue';
import ReadingAssistanceSettings from '@/src/features/settings/ui/ReadingAssistanceSettings.vue';
import ExcludedLanguageSettings from '@/src/features/settings/ui/ExcludedLanguageSettings.vue';
import HarnessPromptSettings from '@/src/features/settings/ui/HarnessPromptSettings.vue';
import {Config} from '@/src/core/config/model';
import {normalizeEagerTranslationCharacters, normalizeMinTranslationTextLength} from '@/src/core/config/pageTranslation';
import {options, getMultilingualTargetLanguageLabel} from '@/src/core/config/catalog';
import {SENTENCE_HIGHLIGHT_STYLES} from '@/src/core/config/sentenceHighlight';
import {getDefaultHarnessPrompt} from '@/src/core/harness/prompts';
import {HARNESS_PROMPT_MAX_LENGTH, HARNESS_PROMPT_VARIABLES} from '@/src/core/config/harness';
const webdav=vi.hoisted(()=>({settings:vi.fn(),clear:vi.fn(),save:vi.fn(),test:vi.fn(),confirm:vi.fn(),success:vi.fn(),warning:vi.fn(),status:vi.fn(),prepare:vi.fn(),prepareDelete:vi.fn(),cancel:vi.fn()}));
const selectionBrowser=vi.hoisted(()=>({browser:'chrome'}));
vi.mock('@/src/services/config/webDavBackupClient',()=>({webDavBackupClient:webdav}));
vi.mock('webextension-polyfill',()=>({default:{runtime:{sendMessage:vi.fn()}}}));
vi.mock('element-plus/es/components/alert/style/css',()=>({}));
vi.mock('element-plus',()=>({ElAlert:{props:['title','type'],setup:(props:any)=>()=>h('p',{role:'alert','data-alert-type':props.type},props.title)},ElMessage:{success:webdav.success,warning:webdav.warning},ElMessageBox:{confirm:webdav.confirm},
  ElOption:{props:['value','label','disabled'],setup:(props:any)=>()=>h('span',{'data-dictionary-option':props.value,'data-disabled':String(Boolean(props.disabled))},props.label)}}));
vi.mock('@/src/platform/browser/capabilities',()=>({browserCapabilities:selectionBrowser}));
// 保留选择器公开的值与更新事件端口；此套件执行实际设置模板，菜单与 CSS 由生产浏览器专项验证。
vi.mock('@/src/ui/components/UiSelect.vue',()=>({default:{inheritAttrs:false,props:['modelValue','filterable'],emits:['update:modelValue'],setup:(props:any,{attrs,slots,emit}:any)=>()=>h('div',attrs,[
  h('input',{value:props.modelValue,onInput:(event:Event)=>emit('update:modelValue',(event.target as HTMLInputElement).value)}),slots.default?.()])}}));
// RemoteConfigSync's public client contract is driven through child UI events; its separate lifecycle suite keeps the full transaction implementation real.
vi.mock('@/src/features/settings/ui/RemoteConfigSync.vue',()=>({default:{props:['client'],emits:['busy'],setup:(props:any,{slots,expose,emit}:any)=>{
  const status=ref<any>(null),result=ref('');
  async function request(action:'status'|'prepare'|'prepareDelete') {emit('busy',true);try {const value=await props.client[action]();if(action==='status')status.value=value;result.value=JSON.stringify(value);}catch(error){result.value=error instanceof Error?error.message:String(error);}finally{emit('busy',false);}}
  expose({refreshStatus:()=>request('status')});
  return()=>h('section',[slots.connection?.(),slots.actions?.({available:true,sync:()=>request('prepare')}),slots.record?.({status:status.value,statusText:'Synced fixture'}),
    ...(['status','prepare','prepareDelete'] as const).map(action=>h('button',{'data-webdav-port':action,onClick:()=>request(action)},action)),h('output',{'data-webdav-port-result':''},result.value)]);
}}}));
const locale=vi.hoisted(()=>({value:null as any}));
vi.mock('@/src/ui/i18n', async()=>{const {ref}=await import('vue');locale.value=ref('zh-CN');return{useUiI18n:()=>({language:locale.value,t:(key:string)=>key,translateLegacy:(value:string)=>value})};});
vi.mock('@/src/features/settings/ui/components/SettingsGroup.vue',()=>({default:{setup:(_:unknown,{slots}:any)=>()=>h('section',slots.default?.())}}));
vi.mock('@/src/features/settings/ui/components/SettingsItem.vue',()=>({default:{setup:(_:unknown,{slots}:any)=>()=>h('div',[slots.copy?.(),slots.default?.()])}}));
vi.mock('@/src/features/settings/ui/components/SettingsPreviewLayout.vue',()=>({default:{setup:(_:unknown,{slots}:any)=>()=>h('div',[slots.default?.(),slots.preview?.()])}}));
vi.mock('@/src/features/settings/ui/HarnessSettings.vue',()=>({default:{emits:['navigate'],setup:(_:unknown,{emit}:any)=>()=>h('button',{'data-learning-navigation':'',onClick:()=>emit('navigate','settings-vocabulary')},'Navigate')}}));
vi.mock('@/src/features/reading-assistant/ui/answer/public',()=>({ReadingAnswer:{props:['text'],setup:(props:any)=>()=>h('output',props.text)}}));
vi.mock('@/src/features/settings/ui/components/TranslationStylePreview.vue',()=>({default:{props:['pageTheme'],emits:['update:pageTheme'],setup:(props:any,{emit}:any)=>()=>h('button',{'data-preview-theme':props.pageTheme,onClick:()=>emit('update:pageTheme',props.pageTheme==='light'?'dark':'light')},'Preview')}}));
vi.mock('@/src/features/settings/ui/components/SettingsNumberInput.vue',()=>({default:{props:['modelValue'],emits:['update:modelValue','change'],setup:(props:any,{emit,attrs}:any)=>()=>h('input',{...attrs,value:props.modelValue,onChange:(event:Event)=>{const raw=(event.target as HTMLInputElement).value;const value=raw===''?undefined:Number(raw);emit('update:modelValue',value);emit('change',value);}})}}));
vi.mock('@/src/features/settings/ui/components/SegmentedControl.vue',()=>({default:{props:['modelValue','options','disabled'],emits:['update:modelValue'],setup:(props:any,{emit}:any)=>()=>h('div',props.options.map((option:any)=>h('button',{'data-prompt-kind':option.value,disabled:props.disabled,onClick:()=>emit('update:modelValue',option.value)},option.label)))}}));
const SwitchPort=defineComponent({inheritAttrs:false,props:['modelValue'],emits:['update:modelValue'],setup:(props,{attrs,emit})=>()=>h('button',{...attrs,role:'switch','aria-checked':props.modelValue,onClick:()=>emit('update:modelValue',!props.modelValue)},'Switch')});
let doc: Document, win: any;
const apps = new Set<App>();
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
async function flush() {for(let i=0;i<16;i++) await nextTick();}
beforeEach(() => {
  selectionBrowser.browser='chrome';
  const parsed=parseHTML('<html><body><main></main></body></html>'); doc=parsed.document as unknown as Document; win=parsed.window;
  for(const key of ['Node','Element','HTMLElement','HTMLButtonElement','SVGElement','Event','MutationObserver']) vi.stubGlobal(key,win[key]);
  vi.stubGlobal('window',win); vi.stubGlobal('document',doc);
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frames.set(++frameId,callback);return frameId;});
  vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id));
  vi.stubGlobal('innerWidth',1000); vi.stubGlobal('innerHeight',800); vi.stubGlobal('visualViewport',undefined);
  frames.clear(); frameId=0;locale.value.value='zh-CN';for(const fn of Object.values(webdav))fn.mockReset();webdav.settings.mockResolvedValue({url:'https://cloud.example.test/dav',username:'fixture',hasPassword:true,allowInsecure:false,revision:'revision-a'});webdav.clear.mockResolvedValue(undefined);webdav.status.mockResolvedValue({available:true,account:{id:'webdav:revision-a'},lastSyncedAt:100});webdav.prepare.mockResolvedValue({id:'preview-a',account:{id:'webdav:revision-a'}});webdav.prepareDelete.mockResolvedValue({id:'delete-a',account:{id:'webdav:revision-a'}});webdav.cancel.mockResolvedValue(undefined);
});
afterEach(async()=>{apps.forEach(app=>app.unmount()); apps.clear(); await flush(); frames.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();vi.unstubAllEnvs();});
function mount(component:Component, initial:Record<string,any>, wrapperClass='') {
  const props=shallowReactive(initial); const host=doc.createElement('div'); host.className=wrapperClass; doc.body.append(host);
  const renderer=createRenderer<Node,Element>({
    createElement:(tag,ns)=>markRaw(ns==='svg'?doc.createElementNS('http://www.w3.org/2000/svg',tag):doc.createElement(tag)),
    createText:text=>doc.createTextNode(text),createComment:text=>doc.createComment(text),
    insert:(node,parent,anchor)=>parent.insertBefore(node,anchor||null),remove:node=>node.parentNode?.removeChild(node),
    setText:(node,text)=>{node.nodeValue=text;},setElementText:(node,text)=>{node.textContent=text;},
    parentNode:node=>node.parentNode as Element|null,nextSibling:node=>node.nextSibling,setScopeId:(node,id)=>node.setAttribute(id,''),
    patchProp(node,key,old,value){
      if(/^on[A-Z]/u.test(key)){const type=key.slice(2).toLowerCase(); if(old)node.removeEventListener(type,old);if(value)node.addEventListener(type,value);}
      else if(key==='value') (node as HTMLInputElement).value=value??'';
      else if(key==='style') {const style=(node as HTMLElement).style;if(typeof value==='string')style.cssText=value;else {for(const k of Object.keys(old||{})) if(!(k in (value||{})))style.removeProperty(k);Object.assign(style,value||{});}}
      else if(value==null||value===false&&key==='disabled')node.removeAttribute(key);
      else node.setAttribute(key,String(value));
    },
    insertStaticContent(html,parent,anchor){const box=doc.createElement('div');box.innerHTML=html;const first=box.firstChild!,last=box.lastChild!;while(box.firstChild)parent.insertBefore(box.firstChild,anchor||null);return[first,last];},
  });
  const app=renderer.createApp({setup:()=>()=>h(component,props)});app.component('ElSwitch', SwitchPort);app.component('ElIcon',{setup:(_:unknown,{slots}:any)=>()=>h('i',slots.default?.())});app.component('ElButton',{inheritAttrs:false,setup:(_:unknown,{attrs,slots}:any)=>()=>h('button',attrs,slots.default?.())});app.component('ElDialog',{props:['modelValue'],emits:['update:modelValue','closed'],setup:(props:any,{slots,emit}:any)=>{watch(()=>props.modelValue,value=>{if(!value)emit('closed')});return()=>props.modelValue?h('div',{'data-dialog':''},[slots.default?.(),slots.footer?.(),h('button',{'data-dialog-dismiss':'',onClick:()=>emit('update:modelValue',false)},'Dismiss')]):null;}});app.component('ElInput',{props:['modelValue'],emits:['update:modelValue'],setup:(props:any,{emit,attrs}:any)=>()=>h('input',{...attrs,value:props.modelValue,onInput:(event:Event)=>emit('update:modelValue',(event.target as HTMLInputElement).value)})});apps.add(app);app.mount(host);
  return {host,props,unmount(){app.unmount();apps.delete(app);}};
}
function button(host:Element,text:string){const found=[...host.querySelectorAll('button')].find(node=>node.textContent===text);expect(found).toBeTruthy();return found!;}
async function click(node:Element){expect(node.hasAttribute('disabled')).toBe(false);node.dispatchEvent(new win.Event('click',{bubbles:true,cancelable:true}));await flush();}
async function input(node:Element,value:string){(node as HTMLInputElement).value=value;node.dispatchEvent(new win.Event('input',{bubbles:true}));await flush();}

it('changes toolbar click behavior through the settings control and follows external drafts', async () => {
  const config = reactive(new Config());const ui = mount(ToolbarClickSetting, {config});
  expect(config.toolbarClickAction).toBe('popup');
  await click(button(ui.host, 'toolbar.click.translate'));expect(config.toolbarClickAction).toBe('translate');
  await click(button(ui.host, 'toolbar.click.popup'));expect(config.toolbarClickAction).toBe('popup');
  const replacement = reactive(new Config());ui.props.config = replacement;await flush();
  await click(button(ui.host, 'toolbar.click.translate'));expect(replacement.toolbarClickAction).toBe('translate');expect(config.toolbarClickAction).toBe('popup');
  ui.unmount();
});


it('normalizes paragraph thresholds and changes paragraph layout through real template events',async()=>{
  const config=reactive(new Config());const ui=mount(ParagraphHandlingSettings,{config});
  const fields=[...ui.host.querySelectorAll('input')];
  for(const raw of ['-1','999999999','', '42'])for(const [index,field] of fields.entries()){
    field.value=raw;field.dispatchEvent(new win.Event('change',{bubbles:true}));await flush();
    expect(index===0?config.minTranslationTextLength:config.eagerTranslationCharacters).toBe((index===0?normalizeMinTranslationTextLength:normalizeEagerTranslationCharacters)(raw===''?undefined:Number(raw)));
  }
  const before=config.longParagraphLineBreakEnabled;await click(ui.host.querySelector('[role="switch"]')!);expect(config.longParagraphLineBreakEnabled).toBe(!before);
  const options=ui.host.querySelectorAll('[data-page-translation-order] button');
  await click(options[1]);expect(config.translationBeforeOriginal).toBe(true);
  await click(options[0]);expect(config.translationBeforeOriginal).toBe(false);
  config.display=0;await flush();expect([...options].every(node=>node.hasAttribute('disabled'))).toBe(true);
  expect(config.translationBeforeOriginal).toBe(false);
  await click(button(ui.host,'settings.translationStyle.switchToBilingual'));expect(config.display).toBe(1);
  expect([...options].every(node=>!node.hasAttribute('disabled'))).toBe(true);
});
it.each(['bilingual','translation-only','disabled'] as const)('preserves the previous enabled selection mode from %s',async mode=>{
  const config=reactive(new Config());config.selectionTranslatorMode=mode;const navigate=vi.fn();const ui=mount(SelectionSettings,{config,onNavigate:navigate});await click(ui.host.querySelector('[data-learning-navigation]')!);expect(navigate).toHaveBeenCalledWith('settings-vocabulary');
  const toggle=ui.host.querySelector('[role="switch"]')!;await click(toggle);
  if(mode==='disabled'){expect(config.selectionTranslatorMode).toBe('bilingual');expect(config.disableSelectionTranslator).toBe(false);}
  else{expect(config.selectionTranslatorMode).toBe('disabled');expect(config.disableSelectionTranslator).toBe(true);await click(toggle);expect(config.selectionTranslatorMode).toBe(mode);}
  await click(button(ui.host,'句子'));expect(ui.host.querySelector('output')).toBeTruthy();await click(button(ui.host,'单词'));expect(ui.host.querySelector('output')).toBeNull();
});
it.each(['chrome','userscript'] as const)('updates dictionary source through the actual settings template in %s',async browser=>{
  selectionBrowser.browser=browser;
  const config=reactive(new Config());const ui=mount(SelectionSettings,{config});
  const field=ui.host.querySelector<HTMLInputElement>('[data-testid="selection-dictionary-source"] input')!;
  expect(field.value).toBe('auto');
  expect(ui.host.querySelectorAll('[data-dictionary-option]')).toHaveLength(7);
  expect(ui.host.querySelector('[data-dictionary-option="ecdict-local"]')?.getAttribute('data-disabled')).toBe(String(browser==='userscript'));
  expect(ui.host.querySelector('[data-dictionary-option="free-dictionary"]')?.getAttribute('data-disabled')).toBe('false');
  await input(field,'free-dictionary');expect(config.selectionDictionarySource).toBe('free-dictionary');
  config.selectionDictionarySource='wiktionary-rest';await flush();expect(field.value).toBe('wiktionary-rest');
  await input(field,'auto');expect(config.selectionDictionarySource).toBe('auto');
});
it.each(['unmount','replace','kind'] as const)('does not focus a prompt insertion after %s invalidates its field',async cause=>{
  const preferences=reactive(new Config().harness);preferences.systemPrompt='Example';const ui=mount(HarnessPromptSettings,{preferences});
  const field=ui.host.querySelector('textarea') as HTMLTextAreaElement;field.selectionStart=0;field.selectionEnd=0;
  const focus=vi.spyOn(field,'focus');field.setSelectionRange=vi.fn();
  ui.host.querySelector('.harness-prompt-variables button')!.dispatchEvent(new win.Event('click',{bubbles:true}));
  if(cause==='unmount')ui.unmount();else if(cause==='replace')ui.props.preferences=reactive(new Config().harness);else ui.host.querySelector('[data-prompt-kind="meaning"]')!.dispatchEvent(new win.Event('click',{bubbles:true}));
  await flush();expect(focus).not.toHaveBeenCalled();expect(field.setSelectionRange).not.toHaveBeenCalled();
});

it('inserts a prompt variable at the selection, preserves blank edits, switches kinds and restores localized defaults',async()=>{
  const preferences=reactive(new Config().harness);preferences.systemPrompt='Hello world';const ui=mount(HarnessPromptSettings,{preferences});
  const field=ui.host.querySelector('textarea') as HTMLTextAreaElement;field.selectionStart=6;field.selectionEnd=11;field.setSelectionRange=vi.fn();const focus=vi.spyOn(field,'focus');
  const token=HARNESS_PROMPT_VARIABLES[0]!.token;await click(ui.host.querySelector('.harness-prompt-variables button')!);
  expect(preferences.systemPrompt).toBe('Hello '+token);expect(focus).toHaveBeenCalledOnce();expect(field.setSelectionRange).toHaveBeenCalledWith(6+token.length,6+token.length);
  await input(field,'');expect(preferences.systemPrompt).toBe('');expect(field.getAttribute('placeholder')).toBe(getDefaultHarnessPrompt('system','zh-CN'));
  await click(button(ui.host,'恢复默认'));expect(preferences.systemPrompt).toBe(getDefaultHarnessPrompt('system','zh-CN'));
  await click(ui.host.querySelector('[data-prompt-kind="meaning"]')!);await input(field,'Custom meaning');expect(preferences.actionPrompts.meaning).toBe('Custom meaning');
  locale.value.value='en';await flush();await click(button(ui.host,'恢复默认'));expect(preferences.actionPrompts.meaning).toBe(getDefaultHarnessPrompt('meaning','en'));
  preferences.actionPrompts.meaning='x'.repeat(HARNESS_PROMPT_MAX_LENGTH);await flush();field.selectionStart=0;field.selectionEnd=0;focus.mockClear();
  await click(ui.host.querySelector('.harness-prompt-variables button')!);expect(preferences.actionPrompts.meaning).toHaveLength(HARNESS_PROMPT_MAX_LENGTH);expect(focus).not.toHaveBeenCalled();
});
it('leaves a newer edit and its caret untouched when it arrives before inserted-prompt rendering',async()=>{
  const preferences=reactive(new Config().harness);preferences.systemPrompt='Before';const ui=mount(HarnessPromptSettings,{preferences});
  const field=ui.host.querySelector('textarea') as HTMLTextAreaElement;field.selectionStart=0;field.selectionEnd=0;field.setSelectionRange=vi.fn();const focus=vi.spyOn(field,'focus');
  ui.host.querySelector('.harness-prompt-variables button')!.dispatchEvent(new win.Event('click',{bubbles:true}));
  preferences.systemPrompt='Newer edit';await flush();expect(field.value).toBe('Newer edit');expect(focus).not.toHaveBeenCalled();
});
it('shows active reading styles, handles missing profiles, enables bilingual view and emits style navigation',async()=>{
  const config=reactive(new Config());config.display=2;config.bilingualSentenceHighlightEnabled=false;const configure=vi.fn();const ui=mount(ReadingAssistanceSettings,{config,onConfigureStyle:configure});
  const current=()=>ui.host.querySelector('[data-testid="current-sentence-highlight-style"]')!.textContent;
  expect(current()).toBe('common.none');await click(button(ui.host,'settings.translationStyle.switchToBilingual'));expect(config.display).toBe(1);expect(ui.host.querySelector('.reading-assistance-note')).toBeNull();
  await click(ui.host.querySelector('[data-preview-theme]')!);expect(ui.host.querySelector('[data-preview-theme]')!.getAttribute('data-preview-theme')).toBe('dark');
  await click(ui.host.querySelector('[data-testid="personal-corrections-enabled"]')!);expect(config.personalCorrectionsEnabled).toBe(true);
  await click(ui.host.querySelector('[data-testid="open-sentence-highlight-styles"]')!);expect(configure).toHaveBeenCalledOnce();
  config.bilingualSentenceHighlightEnabled=true;config.activeSentenceHighlightProfileId='example';config.bilingualSentenceHighlightProfiles=[{id:'example',name:'My style'} as any];await flush();expect(current()).toBe('My style');
  config.activeSentenceHighlightProfileId='gone';config.bilingualSentenceHighlightStyle=SENTENCE_HIGHLIGHT_STYLES[0]!.value;await flush();expect(current()).toBe(SENTENCE_HIGHLIGHT_STYLES[0]!.labelKey);
  config.bilingualSentenceHighlightStyle='missing' as any;await flush();expect(current()).toBe('sentenceHighlight.title');
});
it('preserves selected uncommon languages when collapsed, normalizes toggles, clears and relabels after locale changes',async()=>{
  const selected=options.to[options.to.length-1]!.value;let ui:ReturnType<typeof mount>;
  ui=mount(ExcludedLanguageSettings,{modelValue:[selected],'onUpdate:modelValue':(value:string[])=>{ui.props.modelValue=value;}});
  expect(ui.host.querySelectorAll('[data-language]')).toHaveLength(9);expect(ui.host.querySelector(`[data-language="${selected}"]`)).toBeTruthy();
  const first=options.to[0]!;await click(ui.host.querySelector(`[data-language="${first.value}"]`)!);expect(ui.props.modelValue).toContain(first.value);
  await click(ui.host.querySelector(`[data-language="${selected}"]`)!);expect(ui.props.modelValue).not.toContain(selected);expect(ui.host.querySelectorAll('[data-language]')).toHaveLength(8);
  await click(button(ui.host,'settings.excludedLanguages.more'));expect(ui.host.querySelectorAll('[data-language]')).toHaveLength(options.to.length);
  locale.value.value='en';await flush();expect(ui.host.querySelector(`[data-language="${first.value}"] span`)!.textContent).toBe(getMultilingualTargetLanguageLabel(first.value,first.label,'en').split(' / ')[0]);
  await click(button(ui.host,'settings.excludedLanguages.less'));await click(button(ui.host,'settings.excludedLanguages.clear'));expect(ui.props.modelValue).toEqual([]);expect(ui.host.querySelectorAll('.excluded-language-actions button')).toHaveLength(1);
});

it('ignores a late insertion click from a detached prompt toolbar',async()=>{
  const preferences=reactive(new Config().harness);const ui=mount(HarnessPromptSettings,{preferences});const target=ui.host.querySelector('.harness-prompt-variables button')!;const before=preferences.systemPrompt;ui.unmount();target.dispatchEvent(new win.Event('click',{bubbles:true}));await flush();expect(preferences.systemPrompt).toBe(before);
});

function deferred<T=void>(){let resolve!:(value:T)=>void;let reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
it.each(['unmount','close','reopen'] as const)('does not clear a WebDAV connection after its confirmation loses ownership by %s',async cause=>{
  const confirmation=deferred();webdav.confirm.mockReturnValue(confirmation.promise);const ui=mount(WebDavBackup,{});await click(ui.host.querySelector('[data-testid="webdav-setup"]')!);await click(ui.host.querySelector('[data-testid="webdav-clear"]')!);
  expect(webdav.confirm).toHaveBeenCalledOnce();if(cause==='unmount')ui.unmount();else{await click(button(ui.host,'settings.drive.cancelSync'));if(cause==='reopen')await click(ui.host.querySelector('[data-testid="webdav-setup"]')!);}
  confirmation.resolve();await flush();expect(webdav.clear).not.toHaveBeenCalled();expect(webdav.success).not.toHaveBeenCalled();
});
it('clears only the connection revision shown in the current WebDAV confirmation',async()=>{
  webdav.confirm.mockResolvedValue(undefined);const ui=mount(WebDavBackup,{});await click(ui.host.querySelector('[data-testid="webdav-setup"]')!);await click(ui.host.querySelector('[data-testid="webdav-clear"]')!);expect(webdav.clear).toHaveBeenCalledOnce();expect(webdav.clear).toHaveBeenCalledWith('revision-a');expect(ui.host.querySelector('[data-dialog]')).toBeNull();expect(webdav.success).toHaveBeenCalledWith('settings.webdav.cleared');
});

it('omits extension-only personal corrections in the userscript reading settings',async()=>{
  vi.resetModules();vi.stubEnv('BROWSER','userscript');const UserscriptReading=(await import('@/src/features/settings/ui/ReadingAssistanceSettings.vue')).default;
  const ui=mount(UserscriptReading,{config:reactive(new Config())});expect(ui.host.querySelector('[data-testid="personal-corrections-enabled"]')).toBeNull();
});

it.each(['cancel','error','disposed-result'] as const)('handles WebDAV clear %s without late success feedback',async scenario=>{
  const request=deferred();webdav.confirm.mockImplementation(()=>scenario==='cancel'?Promise.reject('cancel'):Promise.resolve());webdav.clear.mockReturnValue(request.promise);
  const ui=mount(WebDavBackup,{});await click(ui.host.querySelector('[data-testid="webdav-setup"]')!);await click(ui.host.querySelector('[data-testid="webdav-clear"]')!);
  if(scenario==='cancel'){expect(webdav.clear).not.toHaveBeenCalled();return;}
  expect(webdav.clear).toHaveBeenCalledWith('revision-a');if(scenario==='disposed-result'){ui.unmount();request.resolve();}else request.reject(new Error('clear failed'));
  await flush();expect(webdav.success).not.toHaveBeenCalled();if(scenario==='error'){expect(ui.host.textContent).toContain('clear failed');expect(ui.host.querySelector('[data-dialog]')).toBeTruthy();}
});
it('keeps the saved WebDAV password implicit, validates edits, tests them and saves the submitted draft',async()=>{
  const ui=mount(WebDavBackup,{});await click(ui.host.querySelector('[data-testid="webdav-setup"]')!);
  const password=ui.host.querySelector('#webdav-password') as HTMLInputElement;expect(password.value).toBe('');expect(password.getAttribute('placeholder')).toBe('settings.webdav.passwordSaved');
  await input(ui.host.querySelector('#webdav-username')!,'new-user');expect(ui.host.querySelector('[data-testid="webdav-save"]')!.hasAttribute('disabled')).toBe(true);
  await input(password,'fixture-password');webdav.test.mockResolvedValue(undefined);await click(ui.host.querySelector('[data-testid="webdav-test"]')!);expect(webdav.test).toHaveBeenCalledWith({url:'https://cloud.example.test/dav',username:'new-user',password:'fixture-password',allowInsecure:false,revision:'revision-a'});expect(ui.host.textContent).toContain('settings.webdav.testSuccess');
  await input(ui.host.querySelector('#webdav-url')!,'https://other.example.test/dav');expect(ui.host.textContent).not.toContain('settings.webdav.testSuccess');
  webdav.save.mockResolvedValue({url:'https://other.example.test/dav',username:'new-user',hasPassword:true,allowInsecure:false,revision:'revision-b'});await click(ui.host.querySelector('[data-testid="webdav-save"]')!);expect(webdav.save).toHaveBeenCalledWith({url:'https://other.example.test/dav',username:'new-user',password:'fixture-password',allowInsecure:false,revision:'revision-a'});expect(webdav.success).toHaveBeenCalledWith('settings.webdav.saveSuccess');expect(ui.host.querySelector('[data-dialog]')).toBeNull();
});
it('does not open a late WebDAV settings read or publish a failed request after unmount',async()=>{
  const read=deferred<unknown>();webdav.settings.mockReturnValue(read.promise);const ui=mount(WebDavBackup,{});await click(ui.host.querySelector('[data-testid="webdav-setup"]')!);ui.unmount();read.reject(new Error('late failure'));await flush();expect(ui.host.childNodes).toHaveLength(0);expect(webdav.success).not.toHaveBeenCalled();
});


it('refreshes the WebDAV connection before showing account-bound sync status and forwards sync busy state',async()=>{
  const busy=vi.fn(),ui=mount(WebDavBackup,{onBusy:busy});await click(ui.host.querySelector('[data-webdav-port="status"]')!);
  expect(webdav.status).toHaveBeenCalledOnce();expect(webdav.settings).toHaveBeenCalledOnce();expect(ui.host.querySelector('[data-testid="webdav-server"]')?.textContent).toBe('https://cloud.example.test/dav');expect(ui.host.textContent).toContain('Synced fixture');expect(busy.mock.calls).toEqual([[true],[false]]);
  webdav.status.mockResolvedValue({available:true,account:{id:'webdav:old-account'},lastSyncedAt:100});await click(ui.host.querySelector('[data-webdav-port="status"]')!);expect(ui.host.textContent).not.toContain('Synced fixture');
  await click(ui.host.querySelector('[data-testid="webdav-sync-now"]')!);expect(webdav.prepare).toHaveBeenCalledWith(false);expect(ui.host.querySelector('[data-webdav-port-result]')?.textContent).toContain('preview-a');
});
it.each(['prepare','prepareDelete'] as const)('cancels a WebDAV %s preview if its post-read connection changed or cannot be read',async action=>{
  const ui=mount(WebDavBackup,{});await click(ui.host.querySelector(`[data-webdav-port="${action}"]`)!);expect(webdav.cancel).not.toHaveBeenCalled();expect(webdav[action]).toHaveBeenCalledOnce();
  const saved={url:'https://new.example.test/dav',username:'new',hasPassword:true,allowInsecure:false,revision:'revision-b'};
  webdav.settings.mockResolvedValueOnce(saved).mockResolvedValueOnce(saved);await click(ui.host.querySelector(`[data-webdav-port="${action}"]`)!);expect(webdav.cancel).toHaveBeenLastCalledWith(action==='prepare'?'preview-a':'delete-a');expect(ui.host.querySelector('[data-webdav-port-result]')?.textContent).toContain('同步连接已变化');
  webdav.settings.mockResolvedValueOnce(saved).mockRejectedValueOnce(Error('read failed'));webdav.cancel.mockRejectedValueOnce(Error('cancel failed'));await click(ui.host.querySelector(`[data-webdav-port="${action}"]`)!);expect(ui.host.querySelector('[data-webdav-port-result]')?.textContent).toBe('read failed');
  webdav.settings.mockResolvedValueOnce(saved).mockResolvedValueOnce(null);await click(ui.host.querySelector(`[data-webdav-port="${action}"]`)!);expect(webdav.cancel).toHaveBeenCalledTimes(3);expect(ui.host.querySelector('[data-testid="webdav-account"]')).toBeNull();
});
it('requires explicit insecure-HTTP consent and clears password on the actual dialog close event',async()=>{
  webdav.settings.mockResolvedValue(null);const ui=mount(WebDavBackup,{});await click(ui.host.querySelector('[data-testid="webdav-setup"]')!);
  await input(ui.host.querySelector('#webdav-url')!,'http://cloud.example.test/dav');await input(ui.host.querySelector('#webdav-username')!,'fixture');await input(ui.host.querySelector('#webdav-password')!,'fixture-password');
  const save=ui.host.querySelector('[data-testid="webdav-save"]')!;expect(save.hasAttribute('disabled')).toBe(true);expect(ui.host.textContent).toContain('settings.webdav.httpWarning');
  const consent=ui.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;consent.checked=true;consent.dispatchEvent(new win.Event('change',{bubbles:true}));await flush();expect(save.hasAttribute('disabled')).toBe(false);
  const password=ui.host.querySelector('#webdav-password')!;await click(ui.host.querySelector('[data-dialog-dismiss]')!);expect(ui.host.querySelector('[data-dialog]')).toBeNull();await click(ui.host.querySelector('[data-testid="webdav-setup"]')!);expect((ui.host.querySelector('#webdav-password') as HTMLInputElement).value).toBe('');expect(password.isConnected).toBe(false);
});

it('划词真实开关在停用后重读点选冲突，保留原显示方式并允许显式解除',async()=>{
  const config=reactive(Object.assign(new Config(),{selectionTranslatorMode:'translation-only',disableSelectionTranslator:false,selectionClickSelectEnabled:true}));
  const ui=mount(SelectionSettings,{config});const toggle=ui.host.querySelector('[role="switch"]')!;await click(toggle);
  config.quickTranslationProfiles=[{id:'occupied',action:'section',enabled:true,hotkey:'Alt+Shift+S',service:'',model:'',targetLanguage:'',displayMode:'inherit',fullPageMode:'inherit'}];
  await click(toggle);expect(config.selectionTranslatorMode).toBe('disabled');expect(config.disableSelectionTranslator).toBe(true);expect(webdav.warning).toHaveBeenCalled();
  config.quickTranslationProfiles[0].enabled=false;await click(toggle);expect(config.selectionTranslatorMode).toBe('translation-only');
  await click(toggle);config.quickTranslationProfiles[0].enabled=true;config.selectionClickSelectEnabled=false;await click(toggle);
  expect(config.selectionTranslatorMode).toBe('translation-only');expect(config.disableSelectionTranslator).toBe(false);
});
