import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {App} from 'vue';
import type {DriveSyncPreview, DriveSyncStatus, CloudBackupDeletePreview} from '@/src/services/config/remoteConfigSync';
import type {SiteAdaptationSettings as Settings} from '@/src/core/site-adaptation/types';

const dom = await vi.hoisted(async () => {
  const {parseHTML} = await import('linkedom');const {window, document} = parseHTML('<html><body></body></html>');
  for (const name of ['window','document','Node','Element','HTMLElement','SVGElement','Event','CustomEvent']) Object.defineProperty(globalThis,name,{configurable:true,writable:true,value:(window as any)[name]});
  return {window,document};
});
const ports = vi.hoisted(() => ({success:vi.fn(), errors:[] as unknown[]}));
import * as Vue from 'vue';
import RemoteConfigSync from '@/src/features/settings/ui/RemoteConfigSync.vue';
import SiteAdaptationSettings from '@/src/features/settings/ui/SiteAdaptationSettings.vue';
import {CloudBackupRequestError} from '@/src/services/config/cloudBackupClient';
import {SITE_ADAPTATION_EXAMPLE} from '@/src/features/settings/model/siteAdaptationEditor';
vi.mock('webextension-polyfill',()=>({default:{runtime:{sendMessage:vi.fn()}}}));
vi.mock('@/src/ui/i18n',()=>({useUiI18n:()=>({t:(key:string)=>key,translateLegacy:(text:string)=>text,language:Vue.ref('zh-CN')})}));
vi.mock('@element-plus/icons-vue',()=>Object.fromEntries(['ArrowDown','ArrowLeft','ArrowRight','ArrowUp','CircleCheck','Delete','Download','Switch','Upload','User','Warning'].map(name=>[name,{render:()=>null}])));
vi.mock('element-plus/es/components/alert/style/css',()=>({}));
vi.mock('element-plus/es/components/input/style/css',()=>({}));
vi.mock('element-plus/es/components/pagination/style/css',()=>({}));
vi.mock('element-plus/es/components/popover/style/css',()=>({}));
vi.mock('element-plus/es/components/switch/style/css',()=>({}));
vi.mock('element-plus',()=>({
  ElMessage:{success:(...args:unknown[])=>ports.success(...args)},
  ElAlert:{props:['title','description'],setup:(props:any)=>()=>Vue.h('div',{role:'alert'},[props.title,props.description])},
  ElIcon:{setup:(_:unknown,{slots}:any)=>()=>Vue.h('i',slots.default?.())},
  ElInput:{props:['modelValue','disabled'],emits:['update:modelValue'],setup:(props:any,{attrs,emit}:any)=>()=>Vue.h('input',{...attrs,value:props.modelValue,disabled:props.disabled,onInput:(event:Event)=>emit('update:modelValue',(event.target as HTMLInputElement).value)})},
  ElSwitch:{props:['modelValue','disabled'],emits:['update:modelValue','change'],setup:(props:any,{attrs,emit}:any)=>()=>Vue.h('button',{...attrs,type:'button',role:'switch',disabled:props.disabled,'aria-checked':String(props.modelValue),onClick:()=>{emit('update:modelValue',!props.modelValue);emit('change',!props.modelValue)}})},
  ElPopover:{props:['visible'],emits:['update:visible'],setup:(props:any,{slots,emit}:any)=>()=>Vue.h('div',{'data-popover-visible':String(props.visible)},[slots.reference?.(),Vue.h('button',{'data-popover-visibility':'',onClick:()=>emit('update:visible',!props.visible)},'Toggle details'),slots.default?.()])},
  ElPagination:{props:['currentPage'],emits:['update:currentPage'],setup:(props:any,{emit}:any)=>()=>Vue.h('button',{'data-next-page':'',onClick:()=>emit('update:currentPage',props.currentPage+1)},'Next page')},
}));
vi.mock('@/src/ui/components/UiSelect.vue',()=>({default:{props:['modelValue'],emits:['update:modelValue'],setup:(props:any,{attrs,slots,emit}:any)=>()=>Vue.h('select',{...attrs,'data-model-value':props.modelValue,onChange:(event:Event)=>emit('update:modelValue',(event.target as HTMLSelectElement).value)},slots.default?.())}}));
const apps=new Set<App>();const storage=new Map<string,string>();
function deferred<T>() {let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject};}
async function settle(){for(let i=0;i<12;i++){await Promise.resolve();await Vue.nextTick();}}
beforeEach(()=>{
  ports.success.mockClear();ports.errors.length=0;storage.clear();dom.document.body.replaceChildren();
  vi.stubGlobal('localStorage',{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)});
  dom.window.confirm=vi.fn(()=>true);
  Object.defineProperty(dom.window.HTMLElement.prototype,'scrollIntoView',{configurable:true,value:vi.fn()});
  vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:controlled-export');vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
});
afterEach(async()=>{for(const app of apps)app.unmount();apps.clear();await settle();expect(ports.errors).toEqual([]);vi.restoreAllMocks();vi.unstubAllGlobals();});
async function mount(component:Vue.Component,props:Record<string,unknown>){
  const host=dom.document.createElement('main');dom.document.body.append(host);let exposed:any;
  const app=Vue.createApp({render:()=>Vue.h(component,{...props,ref:(value:any)=>{exposed=value}})});
  app.component('el-button',{props:['disabled'],setup:(props:any,{attrs,slots}:any)=>()=>Vue.h('button',{...attrs,type:'button',disabled:props.disabled},slots.default?.())});
  // 锁定 Element Plus use-dialog.afterLeave：外部 modelValue 关闭后依次回报 closed、update:modelValue(false)。
  app.component('el-dialog',{props:['modelValue','beforeClose','showClose'],emits:['closed','update:modelValue'],setup:(props:any,{attrs,slots,emit}:any)=>{Vue.watch(()=>props.modelValue,(value,previous)=>{if(previous&&!value){emit('closed');emit('update:modelValue',false)}});const close=()=>{const done=()=>emit('update:modelValue',false);if(props.beforeClose)props.beforeClose(done);else done();};return()=>props.modelValue?Vue.h('section',{...attrs,role:'dialog'},[props.showClose!==false?Vue.h('button',{'data-dialog-close':'',onClick:close},'Close dialog'):null,slots.default?.(),slots.footer?.()]):null}});
  const {ElSwitch}=await import('element-plus');app.component('el-switch',ElSwitch);
  app.component('el-option',{props:['value','label'],setup:(props:any)=>()=>Vue.h('option',{value:props.value},props.label)});
  app.config.warnHandler=()=>{};app.config.errorHandler=error=>ports.errors.push(error);app.mount(host);apps.add(app);await settle();
  return {host,get exposed(){return exposed},stop:()=>{app.unmount();apps.delete(app)}};
}
async function click(host:HTMLElement,selector:string){const element=host.querySelector<HTMLButtonElement>(selector);expect(element,selector).not.toBeNull();expect(element!.disabled).toBe(false);element!.click();await settle();}
async function input(host:HTMLElement,selector:string,value:string){const element=host.querySelector<HTMLInputElement>(selector);expect(element,selector).not.toBeNull();element!.value=value;element!.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await settle();}
function button(host:HTMLElement,text:string){const target=[...host.querySelectorAll('button')].find(node=>node.textContent?.trim()===text);expect(target,text).toBeDefined();return target!;}
async function textClick(host:HTMLElement,text:string){button(host,text).click();await settle();}
const account={id:'synthetic',email:'example@example.test'};
const status:DriveSyncStatus={available:true,reason:'',account,lastSyncedAt:1};
function preview(patch:Partial<DriveSyncPreview>={}):DriveSyncPreview{return {id:'preview-1',account,hasRemote:false,includeSensitive:false,remoteIncludesSensitive:false,hasBaseline:false,changes:[],expiresAt:Date.now()+60_000,...patch};}
function remoteClient(){return {status:vi.fn(async()=>({...status})),prepare:vi.fn(async(_includeSensitive:boolean)=>preview()),commit:vi.fn(async(_id:string,_direction:string,_choices:Record<string,string>)=>({...status})),cancel:vi.fn(async(_id?:string)=>{}),prepareDelete:vi.fn(async():Promise<CloudBackupDeletePreview>=>({id:'delete-1',account,hasRemote:true,canDelete:true,expiresAt:Date.now()+60_000})),commitDelete:vi.fn(async(_id:string)=>({...status,deleted:true}))};}
async function remote(kind:'google-drive'|'webdav'='webdav',client=remoteClient()){return {...await mount(RemoteConfigSync,{client,kind,provider:'Fixture storage'}),client};}

describe('RemoteConfigSync actual client interactions',()=>{
  it('requires a fresh direction after returning from first-sync review and commits only the newly reviewed route',async()=>{
    const client=remoteClient();client.prepare.mockResolvedValue(preview({hasRemote:true,hasBaseline:false,changes:[
      {id:'theme',label:'Theme',local:'开启',remote:'关闭',recommended:null,sensitive:false,conflict:true},
    ]}));
    const view=await remote('webdav',client);await click(view.host,'[data-testid="webdav-sync-now"]');
    const continueButton=()=>view.host.querySelector<HTMLButtonElement>('[data-testid="webdav-continue"]')!;
    expect(continueButton().disabled).toBe(true);expect(view.host.querySelector('[data-testid="webdav-confirm"]')).toBeNull();
    const choose=async(direction:'download'|'upload')=>{const radio=view.host.querySelector<HTMLInputElement>(`[data-testid="webdav-direction-${direction}"]`)!;radio.checked=true;radio.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await settle();};
    await choose('download');expect(continueButton().disabled).toBe(false);await click(view.host,'[data-testid="webdav-continue"]');
    expect(view.host.querySelector('.drive-review-title')?.textContent).toContain('settings.drive.downloadTitle');expect(client.commit).not.toHaveBeenCalled();
    await click(view.host,'[data-testid="webdav-back"]');expect(continueButton().disabled).toBe(true);
    expect([...view.host.querySelectorAll<HTMLInputElement>('.drive-operation input')].every(radio=>!radio.checked)).toBe(true);
    expect(view.host.querySelector('[data-testid="webdav-confirm"]')).toBeNull();expect(client.commit).not.toHaveBeenCalled();
    await choose('upload');await click(view.host,'[data-testid="webdav-continue"]');
    expect(view.host.querySelector('.drive-review-title')?.textContent).toContain('settings.drive.uploadTitle');
    await click(view.host,'[data-testid="webdav-confirm"]');expect(client.commit).toHaveBeenCalledOnce();
    expect(client.commit).toHaveBeenCalledWith('preview-1','upload',{});expect(view.host.querySelector('.drive-dialog')).toBeNull();
  });
  it('never deletes on Enter and clears the accepted phrase and details when a deletion dialog reopens',async()=>{
    const client=remoteClient();client.prepareDelete.mockResolvedValueOnce({id:'delete-first',account,hasRemote:true,canDelete:true,expiresAt:Date.now()+60_000})
      .mockResolvedValueOnce({id:'delete-current',account,hasRemote:true,canDelete:true,expiresAt:Date.now()+60_000});
    const view=await remote('webdav',client);await click(view.host,'[data-testid="webdav-delete-backup"]');
    for(const value of ['wrong phrase','settings.cloud.deletePhrase']){
      await input(view.host,'#webdav-delete-verification',value);
      const enter=new dom.window.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperty(enter,'key',{value:'Enter'});
      view.host.querySelector('#webdav-delete-verification')!.dispatchEvent(enter);await settle();
      expect(enter.defaultPrevented).toBe(true);expect(client.commitDelete).not.toHaveBeenCalled();
      expect(view.host.querySelector<HTMLButtonElement>('[data-testid="cloud-delete-confirm"]')!.disabled).toBe(value==='wrong phrase');
    }
    await click(view.host,'[data-popover-visibility]');expect(view.host.querySelector('[data-popover-visible]')?.getAttribute('data-popover-visible')).toBe('true');
    await click(view.host,'.cloud-delete-dialog [data-dialog-close]');expect(client.cancel).toHaveBeenCalledWith('delete-first');
    await click(view.host,'[data-testid="webdav-delete-backup"]');
    expect(view.host.querySelector<HTMLInputElement>('#webdav-delete-verification')!.value).toBe('');
    expect(view.host.querySelector<HTMLButtonElement>('[data-testid="cloud-delete-confirm"]')!.disabled).toBe(true);
    expect(view.host.querySelector('[data-popover-visible]')?.getAttribute('data-popover-visible')).toBe('false');
    await input(view.host,'#webdav-delete-verification','settings.cloud.deletePhrase');await click(view.host,'[data-testid="cloud-delete-confirm"]');
    expect(client.commitDelete).toHaveBeenCalledOnce();expect(client.commitDelete).toHaveBeenCalledWith('delete-current');expect(client.commit).not.toHaveBeenCalled();
  });
  it('closes each dialog through its UI close contract and clears the delete-details popover with Escape',async()=>{
    const view=await remote();
    await click(view.host,'[data-testid="cloud-include-sensitive"]');
    await click(view.host,'.cloud-consent-dialog [data-dialog-close]');expect(view.host.querySelector('[role="dialog"]')).toBeNull();
    expect(storage.size).toBe(0);
    await click(view.host,'[data-testid="webdav-sync-now"]');
    await click(view.host,'.drive-dialog [data-dialog-close]');expect(view.client.cancel).toHaveBeenCalledWith('preview-1');expect(view.host.querySelector('.drive-dialog')).toBeNull();
    await click(view.host,'[data-testid="webdav-delete-backup"]');await click(view.host,'[data-popover-visibility]');
    expect(view.host.querySelector('[data-popover-visible]')?.getAttribute('data-popover-visible')).toBe('true');
    const escape=new dom.window.Event('keydown',{bubbles:true});Object.defineProperty(escape,'key',{value:'Escape'});
    view.host.querySelector('[data-testid="cloud-delete-details-toggle"]')!.dispatchEvent(escape);await settle();
    expect(view.host.querySelector('[data-popover-visible]')?.getAttribute('data-popover-visible')).toBe('false');
    await click(view.host,'.cloud-delete-dialog [data-dialog-close]');expect(view.client.cancel).toHaveBeenCalledWith('delete-1');
    expect(view.client.commit).not.toHaveBeenCalled();expect(view.client.commitDelete).not.toHaveBeenCalled();expect(view.host.querySelector('[role="dialog"]')).toBeNull();
  });
  it('replaces a bulk remote conflict choice with a bulk local choice before committing the merge',async()=>{
    const client=remoteClient();client.prepare.mockResolvedValue(preview({hasRemote:true,hasBaseline:true,changes:[
      {id:'theme',label:'Theme',local:'开启',remote:'关闭',recommended:null,sensitive:false,conflict:true},
      {id:'language',label:'Language',local:'英语',remote:'中文',recommended:'remote',sensitive:false,conflict:false},
    ]}));
    const view=await remote('webdav',client);await click(view.host,'[data-testid="webdav-sync-now"]');
    await textClick(view.host,'settings.drive.keepAllRemote');await textClick(view.host,'settings.drive.keepAllLocal');
    await click(view.host,'[data-testid="webdav-confirm"]');expect(client.commit).toHaveBeenCalledWith('preview-1','merge',{theme:'local',language:'remote'});
  });
  it('requires explicit sensitive-data consent, persists the choice and observes external storage changes',async()=>{
    const view=await remote();expect(view.host.querySelector('[data-testid="cloud-include-settings"]')?.getAttribute('disabled')).not.toBeNull();
    await click(view.host,'[data-testid="cloud-include-sensitive"]');expect(view.host.querySelector('[data-testid="cloud-consent-confirm"]')?.hasAttribute('disabled')).toBe(true);
    await click(view.host,'[data-testid="cloud-consent-cancel"]');expect(storage.size).toBe(0);
    await click(view.host,'[data-testid="cloud-include-sensitive"]');const checkbox=view.host.querySelector<HTMLInputElement>('[data-testid="cloud-risk-acknowledgement"]')!;checkbox.checked=true;checkbox.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await settle();
    await click(view.host,'[data-testid="cloud-consent-confirm"]');expect(storage.get('fluentread-cloud-backup-include-sensitive')).toBe('true');
    await click(view.host,'[data-testid="webdav-sync-now"]');expect(view.client.prepare).toHaveBeenCalledWith(true);
    await click(view.host,'[data-testid="webdav-confirm"]');expect(view.client.commit).toHaveBeenCalledWith('preview-1','upload',{});expect(ports.success).toHaveBeenCalledWith('settings.cloud.syncComplete');
    const event=new dom.window.Event('storage');Object.assign(event,{storageArea:localStorage,key:'fluentread-cloud-backup-include-sensitive',newValue:'false'});dom.window.dispatchEvent(event);await settle();expect(view.host.querySelector('[data-testid="cloud-include-sensitive"]')?.getAttribute('aria-checked')).toBe('false');
  });
  it('reviews complete merge choices, preserves recommended rows and cancels an old account before preparing another',async()=>{
    const client=remoteClient();client.prepare.mockResolvedValue(preview({hasRemote:true,hasBaseline:true,changes:[{id:'theme',label:'Theme',local:'开启',remote:'关闭',recommended:null,sensitive:false,conflict:true},{id:'language',label:'Language',local:'英语',remote:'中文',recommended:'local',sensitive:false,conflict:false}]}));
    const view=await remote('google-drive',client);await click(view.host,'[data-testid="google-drive-sync-now"]');
    expect(view.host.querySelector('[data-testid="google-drive-confirm"]')?.hasAttribute('disabled')).toBe(true);await textClick(view.host,'settings.drive.keepAllRemote');
    await click(view.host,'.drive-details-toggle');expect(view.host.querySelectorAll('.drive-change')).toHaveLength(1);await click(view.host,'.drive-details-toggle');expect(view.host.querySelectorAll('.drive-change')).toHaveLength(2);
    await click(view.host,'[data-testid="google-drive-confirm"]');expect(client.commit).toHaveBeenCalledWith('preview-1','merge',{theme:'remote',language:'local'});
    await click(view.host,'[data-testid="google-drive-sync-now"]');await click(view.host,'[data-testid="google-drive-back"]');await click(view.host,'[data-testid="google-drive-direction-merge"]');
    await click(view.host,'[data-testid="google-drive-switch-account"]');expect(client.cancel).toHaveBeenCalledWith('preview-1');expect(client.prepare).toHaveBeenCalledTimes(3);
    await textClick(view.host,'settings.drive.cancelSync');expect(view.host.querySelector('[role="dialog"]')).toBeNull();
  });
  it('requires the complete deletion phrase, supports account replacement and leaves local configuration untouched',async()=>{
    const view=await remote('google-drive');await click(view.host,'[data-testid="google-drive-delete-backup"]');await click(view.host,'[data-testid="google-drive-delete-switch-account"]');expect(view.client.cancel).toHaveBeenCalledWith('delete-1');expect(view.client.prepareDelete).toHaveBeenCalledTimes(2);
    await input(view.host,'#google-drive-delete-verification','wrong phrase');expect(view.host.querySelector('[data-testid="cloud-delete-confirm"]')?.hasAttribute('disabled')).toBe(true);
    await input(view.host,'#google-drive-delete-verification','settings.cloud.deletePhrase');await click(view.host,'[data-testid="cloud-delete-confirm"]');expect(view.client.commitDelete).toHaveBeenCalledOnce();expect(view.client.commitDelete).toHaveBeenCalledWith('delete-1');expect(view.client.commit).not.toHaveBeenCalled();expect(view.host.querySelector('[role="dialog"]')).toBeNull();
    await click(view.host,'[data-testid="google-drive-delete-backup"]');await click(view.host,'[data-testid="cloud-delete-cancel"]');expect(view.client.commitDelete).toHaveBeenCalledOnce();
  });
  it.each(['preview','deletion'] as const)('cancels a %s received after unmount without mounting a dialog or reporting success',async kind=>{
    const client=remoteClient(),pending=deferred<any>();if(kind==='preview')client.prepare.mockReturnValueOnce(pending.promise);else client.prepareDelete.mockReturnValueOnce(pending.promise);
    const view=await remote('webdav',client);await click(view.host,kind==='preview'?'[data-testid="webdav-sync-now"]':'[data-testid="webdav-delete-backup"]');view.stop();pending.resolve(kind==='preview'?preview({id:'late-preview'}):{id:'late-deletion',account,hasRemote:true,canDelete:true});await settle();
    expect(client.cancel).toHaveBeenCalledWith(kind==='preview'?'late-preview':'late-deletion');expect(ports.success).not.toHaveBeenCalled();expect(view.host.textContent).toBe('');
  });
  it('surfaces unverified upload and recovers after retry without claiming a successful backup',async()=>{
    const client=remoteClient();client.commit.mockRejectedValueOnce(new CloudBackupRequestError('unverified','settings.cloud.uploadUnverified'));
    const view=await remote('webdav',client);await click(view.host,'[data-testid="webdav-sync-now"]');await click(view.host,'[data-testid="webdav-confirm"]');expect(ports.success).not.toHaveBeenCalled();expect(view.host.textContent).toContain('settings.cloud.uploadUnverified');
    await click(view.host,'[data-testid="webdav-sync-now"]');await click(view.host,'[data-testid="webdav-confirm"]');expect(client.commit).toHaveBeenCalledTimes(2);expect(ports.success).toHaveBeenCalledOnce();
  });
});

async function site(){const state=Vue.reactive({inspectRuleId:'',modelValue:{enabled:true,disabledRuleIds:[],custom:{version:1,rules:[]}} as Settings});const save=vi.fn(async(next:Settings)=>{state.modelValue=structuredClone(Vue.toRaw(next))});const view=await mount(SiteAdaptationSettings,{get modelValue(){return state.modelValue},get inspectRuleId(){return state.inspectRuleId},saveSettings:save});return {...view,state,save};}
describe('SiteAdaptationSettings actual client form and draft',()=>{
  it('creates a rule through the form, validates invalid input and saves only the confirmed source scope',async()=>{
    const view=await site();await textClick(view.host,'新建规则');await input(view.host,'input[aria-label="规则名称"]','Fixture article');await input(view.host,'textarea[aria-label="匹配域名"]','https://invalid/path');view.host.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await settle();expect(view.save).not.toHaveBeenCalled();expect(view.host.querySelector('[role="alert"]')).not.toBeNull();
    await input(view.host,'textarea[aria-label="匹配域名"]','example.test');await textClick(view.host,'添加正文区域');await input(view.host,'textarea[aria-label="正文 CSS 选择器 1"]','article p');view.host.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await settle();
    expect(view.save).toHaveBeenCalledOnce();expect(view.state.modelValue.custom.rules[0]).toMatchObject({name:'Fixture article',match:{hosts:['example.test']},content:[{css:['article p']}]});expect(view.host.querySelector('form')).toBeNull();
    await textClick(view.host,'从草稿移除');expect(view.state.modelValue.custom.rules).toHaveLength(1);await textClick(view.host,'撤销草稿替换');expect(view.host.textContent).toContain('Fixture article');
  });
  it('edits, validates, restores and imports JSON through real input handlers without saving a partial draft',async()=>{
    const view=await site();await textClick(view.host,'插入示例');await textClick(view.host,'插入示例');expect(view.host.textContent).toContain('示例已存在');expect(view.save).not.toHaveBeenCalled();await textClick(view.host,'校验草稿');expect(view.host.textContent).toContain('草稿校验通过');
    await input(view.host,'textarea[aria-label="JSON 编辑草稿"]','{broken');await textClick(view.host,'校验草稿');expect(view.host.querySelector('[role="alert"]')).not.toBeNull();await textClick(view.host,'恢复已保存草稿');
    const picker=view.host.querySelector<HTMLInputElement>('input[type="file"]')!;Object.defineProperty(picker,'files',{configurable:true,value:[{size:200,text:async()=>JSON.stringify(SITE_ADAPTATION_EXAMPLE)}]});picker.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await settle();expect(view.host.textContent).toContain('已导入草稿');
    await textClick(view.host,'保存并应用');expect(view.save).toHaveBeenCalledOnce();expect(view.state.modelValue.custom.rules).toHaveLength(1);
    await input(view.host,'input[type="search"]','no matching fixture');expect(view.host.textContent).toContain('没有匹配的网站规则');
  });
});

it('reviews a readonly restore in pages and keeps upload unavailable',async()=>{
  const client=remoteClient();client.prepare.mockResolvedValue(preview({hasRemote:true,canUpload:false,changes:Array.from({length:21},(_,i)=>({id:`change-${i}`,label:`Setting ${i}`,local:'开启',remote:'关闭',recommended:'remote' as const,sensitive:i===0,conflict:false}))}));
  const view=await remote('webdav',client);await click(view.host,'[data-testid="webdav-sync-now"]');expect(view.host.querySelector('[data-testid="webdav-restore-only"]')).not.toBeNull();expect(view.host.querySelectorAll('.drive-change')).toHaveLength(20);
  await click(view.host,'[data-next-page]');expect(view.host.querySelectorAll('.drive-change')).toHaveLength(1);expect(view.host.textContent).toContain('Setting 20');
  await click(view.host,'.drive-details-toggle');expect(view.host.querySelector('.drive-differences')).toBeNull();await click(view.host,'.drive-details-toggle');expect(view.host.querySelectorAll('.drive-change')).toHaveLength(20);
  await click(view.host,'[data-testid="webdav-confirm"]');expect(client.commit.mock.calls[0][1]).toBe('download');
});
it('chooses upload or individual merge values through the rendered controls, then retries a failed status read',async()=>{
  const client=remoteClient();client.status.mockRejectedValueOnce(new Error('status unavailable'));const view=await remote('google-drive',client);expect(view.host.textContent).toContain('status unavailable');expect(view.host.querySelector('[data-testid="google-drive-sync-now"]')).toBeNull();
  await view.exposed.refreshStatus();await settle();client.prepare.mockResolvedValue(preview({hasRemote:true,changes:[{id:'theme',label:'Theme',local:'开启',remote:'关闭',recommended:null,sensitive:false,conflict:true}]}));
  await click(view.host,'[data-testid="google-drive-sync-now"]');const upload=view.host.querySelector<HTMLInputElement>('[data-testid="google-drive-direction-upload"]')!;upload.checked=true;upload.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await settle();
  await click(view.host,'[data-testid="google-drive-continue"]');await click(view.host,'[data-testid="google-drive-back"]');await click(view.host,'[data-testid="google-drive-direction-merge"]');
  const choice=view.host.querySelector<HTMLInputElement>('.drive-value input[value="local"]')!;choice.checked=true;choice.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await settle();await click(view.host,'[data-testid="google-drive-confirm"]');expect(client.commit).toHaveBeenCalledWith('preview-1','merge',{theme:'local'});
});
it('shows unsupported deletion and completes an absent-backup inspection without requiring a phrase',async()=>{
  const client=remoteClient();client.prepareDelete.mockResolvedValueOnce({id:'readonly-delete',account,hasRemote:true,canDelete:false,expiresAt:1}).mockResolvedValueOnce({id:'absent-delete',account,hasRemote:false,canDelete:true,expiresAt:1});
  const view=await remote('webdav',client);await click(view.host,'[data-testid="webdav-delete-backup"]');expect(view.host.querySelector('[data-testid="cloud-delete-unsupported"]')).not.toBeNull();expect(view.host.querySelector('[data-testid="cloud-delete-confirm"]')?.hasAttribute('disabled')).toBe(true);await click(view.host,'[data-testid="cloud-delete-cancel"]');
  await click(view.host,'[data-testid="webdav-delete-backup"]');expect(view.host.querySelector('[data-testid="cloud-delete-verification"]')).toBeNull();await click(view.host,'[data-testid="cloud-delete-confirm"]');expect(client.commitDelete).toHaveBeenCalledWith('absent-delete');
});
it('preserves local sensitive-data consent when storage fails and lets an explicit off choice recover',async()=>{
  const view=await remote();vi.spyOn(localStorage,'setItem').mockImplementationOnce(()=>{throw new Error('quota')});await click(view.host,'[data-testid="cloud-include-sensitive"]');const checkbox=view.host.querySelector<HTMLInputElement>('[data-testid="cloud-risk-acknowledgement"]')!;checkbox.checked=true;checkbox.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await settle();await click(view.host,'[data-testid="cloud-consent-confirm"]');expect(view.host.textContent).toContain('settings.cloud.sensitiveSaveFailed');expect(storage.size).toBe(0);
  const change=new dom.window.Event('storage');Object.assign(change,{storageArea:localStorage,key:null,newValue:'true'});dom.window.dispatchEvent(change);await settle();await click(view.host,'[data-testid="cloud-include-sensitive"]');expect(storage.get('fluentread-cloud-backup-include-sensitive')).toBe('false');
});
it('keeps failed site-rule saves editable, retries the same draft and toggles only the chosen saved rule',async()=>{
  const view=await site();view.save.mockRejectedValueOnce(new Error('storage failure'));await textClick(view.host,'插入示例');await textClick(view.host,'保存并应用');expect(view.host.textContent).toContain('保存失败');expect(view.state.modelValue.custom.rules).toEqual([]);
  await textClick(view.host,'保存并应用');expect(view.state.modelValue.custom.rules).toHaveLength(1);const id=view.state.modelValue.custom.rules[0].id;
  await click(view.host,`[data-adaptation-rule="${id}"] [role="switch"]`);expect(view.state.modelValue.disabledRuleIds).toEqual([id]);
  await click(view.host,'.rule-toggle-row [role="switch"]');expect(view.state.modelValue.enabled).toBe(false);expect(view.state.modelValue.custom.rules).toHaveLength(1);
});
it('warns about edited site-rule forms, honours cancellation and restores the saved draft after an import race',async()=>{
  const view=await site();await textClick(view.host,'新建规则');await input(view.host,'input[aria-label="规则名称"]','Unsaved draft');const unload=new dom.window.Event('beforeunload',{cancelable:true});dom.window.dispatchEvent(unload);expect(unload.defaultPrevented).toBe(true);
  (dom.window.confirm as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);await textClick(view.host,'取消编辑');expect(view.host.querySelector('form')).not.toBeNull();await textClick(view.host,'取消编辑');expect(view.host.querySelector('form')).toBeNull();
  const pending=deferred<string>(),picker=view.host.querySelector<HTMLInputElement>('input[type="file"]')!;Object.defineProperty(picker,'files',{configurable:true,value:[{size:100,text:()=>pending.promise}]});picker.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await settle();
  await textClick(view.host,'插入示例');pending.resolve(JSON.stringify({version:1,rules:[]}));await settle();expect(view.host.textContent).toContain('读取文件期间草稿已更改');expect(view.save).not.toHaveBeenCalled();
  await textClick(view.host,'清空自定义草稿');await textClick(view.host,'撤销草稿替换');await textClick(view.host,'恢复已保存草稿');expect(view.state.modelValue.custom.rules).toEqual([]);
  const safe=new dom.window.Event('beforeunload',{cancelable:true});dom.window.dispatchEvent(safe);expect(safe.defaultPrevented).toBe(false);
});
it('opens a built-in rule, prepares a custom override, and exports the selected rule without saving it',async()=>{
  const view=await site();await click(view.host,'.catalog-name');expect(view.host.querySelector('[data-rule-detail]')).not.toBeNull();
  await textClick(view.host,'基于此规则自定义');expect(view.host.querySelector('input[aria-label="规则标识"]')?.hasAttribute('disabled')).toBe(true);await textClick(view.host,'取消编辑');expect(view.save).not.toHaveBeenCalled();
  vi.useFakeTimers();try {await textClick(view.host,'导出此规则');expect(URL.createObjectURL).toHaveBeenCalledOnce();const blob=(URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob;expect(JSON.parse(await blob.text()).rules).toHaveLength(1);await vi.advanceTimersByTimeAsync(1000);expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:controlled-export');}finally{vi.useRealTimers()}
  await textClick(view.host,'关闭详情');expect(view.host.querySelector('[data-rule-detail]')).toBeNull();
});

it('releases a private site-rule export URL when the anchor click throws',async()=>{
  vi.useFakeTimers();
  const view=await site();const nativeClick=dom.window.HTMLElement.prototype.click;
  const anchor=vi.spyOn(dom.window.HTMLElement.prototype,'click').mockImplementation(function(this:HTMLElement){
    if(this.tagName==='A')throw new Error('private transport detail');return nativeClick.call(this);
  });
  try {
    await textClick(view.host,'导出已保存规则');
    expect(URL.createObjectURL).toHaveBeenCalledOnce();expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:controlled-export');
    expect(view.host.querySelector('[role="alert"]')?.textContent).toBe('siteAdaptation.exportFailed');
    expect(view.host.textContent).not.toContain('private transport detail');expect(view.save).not.toHaveBeenCalled();
    anchor.mockRestore();await textClick(view.host,'导出已保存规则');
    expect(view.host.querySelector('[role="alert"]')).toBeNull();expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  } finally {anchor.mockRestore();vi.useRealTimers();}
});

it.each(['old-fails','new-fails'] as const)('keeps the newer export status under synchronous reentry: %s',async mode=>{
  vi.useFakeTimers();const view=await site();const nativeClick=dom.window.HTMLElement.prototype.click;let nested=false;
  vi.mocked(URL.createObjectURL).mockReturnValueOnce('blob:old').mockReturnValueOnce('blob:new');
  const anchor=vi.spyOn(dom.window.HTMLElement.prototype,'click').mockImplementation(function(this:HTMLElement){
    if(this.tagName!=='A')return nativeClick.call(this);
    if(nested){if(mode==='new-fails')throw new Error('new');return;}
    nested=true;button(view.host,'导出已保存规则').dispatchEvent(new dom.window.Event('click',{bubbles:true}));
    if(mode==='old-fails')throw new Error('old');
  });
  try {
    await textClick(view.host,'导出已保存规则');expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    expect(view.host.querySelector('[role="alert"]')?.textContent ?? '').toBe(mode==='new-fails'?'siteAdaptation.exportFailed':'');
    await vi.advanceTimersByTimeAsync(1000);expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old');expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:new');
  } finally {anchor.mockRestore();vi.useRealTimers();}
});

it('cleans the export URL without reporting a stale failure after synchronous unmount',async()=>{
  const view=await site(),nativeClick=dom.window.HTMLElement.prototype.click;
  const anchor=vi.spyOn(dom.window.HTMLElement.prototype,'click').mockImplementation(function(this:HTMLElement){
    if(this.tagName==='A'){view.stop();throw new Error('late');}return nativeClick.call(this);
  });
  try {await textClick(view.host,'导出已保存规则');expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:controlled-export');expect(ports.errors).toEqual([]);}
  finally {anchor.mockRestore();}
});

it('does not revive a stale export failure after synchronous KeepAlive deactivation',async()=>{
  vi.useFakeTimers();const shown=Vue.ref(true), settings=Vue.reactive({enabled:true,disabledRuleIds:[],custom:{version:1,rules:[]}} as Settings);
  const Other={render:()=>null};
  const Shell=Vue.defineComponent({setup:()=>()=>Vue.h(Vue.KeepAlive,null,{default:()=>shown.value
    ? Vue.h(SiteAdaptationSettings,{modelValue:settings,saveSettings:async()=>{}}) : Vue.h(Other,{key:'other'})})});
  const view=await mount(Shell,{}),nativeClick=dom.window.HTMLElement.prototype.click;
  const anchor=vi.spyOn(dom.window.HTMLElement.prototype,'click').mockImplementation(function(this:HTMLElement){
    if(this.tagName==='A'){shown.value=false;throw new Error('late');}return nativeClick.call(this);
  });
  try {
    await textClick(view.host,'导出已保存规则');expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:controlled-export');
    shown.value=true;await settle();expect(view.host.querySelector('[role="alert"]')).toBeNull();
    anchor.mockRestore();await textClick(view.host,'导出已保存规则');expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  } finally {anchor.mockRestore();vi.useRealTimers();}
});

it('does not revive a stale export failure after the parent hides the settings section',async()=>{
  vi.useFakeTimers();const active=Vue.ref(true),settings=Vue.reactive({enabled:true,disabledRuleIds:[],custom:{version:1,rules:[]}} as Settings);
  const Shell=Vue.defineComponent({setup:()=>()=>Vue.h(SiteAdaptationSettings,{active:active.value,modelValue:settings,saveSettings:async()=>{}})});
  const view=await mount(Shell,{}),nativeClick=dom.window.HTMLElement.prototype.click;
  const anchor=vi.spyOn(dom.window.HTMLElement.prototype,'click').mockImplementation(function(this:HTMLElement){
    if(this.tagName==='A'){active.value=false;throw new Error('late');}return nativeClick.call(this);
  });
  try {
    await textClick(view.host,'导出已保存规则');expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:controlled-export');
    active.value=true;await settle();expect(view.host.querySelector('[role="alert"]')).toBeNull();
    anchor.mockRestore();await textClick(view.host,'导出已保存规则');expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  } finally {anchor.mockRestore();vi.useRealTimers();}
});

it('round-trips advanced visual rule controls into the saved scope and preserves them when reopened',async()=>{
  const view=await site();await textClick(view.host,'新建规则');
  for(const [label,value] of [['规则名称','Scoped reading'],['匹配域名','example.test'],['匹配路径（可选）','/articles/*'],['规则标识','fixture-scoped-reading'],['排除路径（可选）','/articles/private/*'],['优先级','23'],['保留原文区域（可选）','code\n.math'],['排除扫描区域（可选）','nav\n.advertisement'],['忽略动态变化区域（可选）','.clock']])await input(view.host,`[aria-label="${label}"]`,value);
  const focus=view.host.querySelector<HTMLInputElement>('input[value="focus"]')!;focus.checked=true;focus.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await settle();const augment=view.host.querySelector<HTMLInputElement>('input[value="augment"]')!;augment.checked=true;augment.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await settle();expect(augment.parentElement!.classList.contains('is-active')).toBe(true);expect(focus.parentElement!.classList.contains('is-active')).toBe(false);focus.checked=true;focus.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await settle();
  await textClick(view.host,'添加正文区域');await textClick(view.host,'添加正文区域');await input(view.host,'textarea[aria-label="正文 CSS 选择器 1"]','article p');await click(view.host,'[aria-label="移除正文区域 2"]');
  const row=view.host.querySelector('.content-row')!;const toggles=row.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');toggles[0].checked=false;toggles[0].dispatchEvent(new dom.window.Event('change',{bubbles:true}));toggles[1].checked=true;toggles[1].dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  const resolve=row.querySelector('select')!;Object.defineProperty(resolve,'value',{configurable:true,value:'closest'});resolve.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await input(view.host,'.content-row details input:not([type="checkbox"])','main-prose');
  view.host.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await settle();
  expect(view.save).toHaveBeenCalledOnce();expect(view.state.modelValue.custom.rules[0]).toMatchObject({id:'fixture-scoped-reading',name:'Scoped reading',mode:'focus',priority:23,match:{hosts:['example.test'],paths:['/articles/*'],excludePaths:['/articles/private/*']},content:[{css:['article p'],atomic:false,resolve:'closest',splitOnBr:true,key:'main-prose'}],protect:['code','.math'],exclude:['nav','.advertisement'],watchIgnore:['.clock']});
  await textClick(view.host,'编辑自定义规则');expect(view.host.querySelector<HTMLInputElement>('[aria-label="规则标识"]')!.disabled).toBe(true);expect(view.host.querySelector<HTMLInputElement>('input[value="focus"]')!.checked).toBe(true);expect(view.host.querySelector<HTMLTextAreaElement>('[aria-label="匹配路径（可选）"]')!.value).toBe('/articles/*');
});

it('opens invalid JSON for correction and blocks stale form saves after settings change elsewhere',async()=>{
  const view=await site();await input(view.host,'textarea[aria-label="JSON 编辑草稿"]','{broken');await textClick(view.host,'保存并应用');expect(view.save).not.toHaveBeenCalled();expect(view.host.querySelector<HTMLDetailsElement>('.backup-tools')!.open).toBe(true);expect(view.host.querySelector<HTMLDetailsElement>('.json-editor')!.hasAttribute('open')).toBe(true);
  await textClick(view.host,'新建规则');expect(view.host.querySelector('form')).toBeNull();await textClick(view.host,'恢复已保存草稿');await textClick(view.host,'新建规则');await input(view.host,'[aria-label="匹配域名"]','example.test');
  view.state.modelValue={...view.state.modelValue,custom:structuredClone(SITE_ADAPTATION_EXAMPLE)};await settle();expect(view.host.textContent).toContain('规则已从其他页面更新');expect(view.host.querySelector('button[type="submit"]')!.hasAttribute('disabled')).toBe(true);
  await textClick(view.host,'取消编辑');expect(view.save).not.toHaveBeenCalled();expect(view.state.modelValue.custom.rules[0].id).toBe(SITE_ADAPTATION_EXAMPLE.rules[0].id);
});

it('uses replacement import, rejects oversized or unreadable files and exports the chosen saved or draft pack',async()=>{
  vi.useFakeTimers();try{
    const view=await site();await textClick(view.host,'插入示例');
    const select=view.host.querySelector<HTMLSelectElement>('[aria-label="导入方式"]')!;Object.defineProperty(select,'value',{configurable:true,value:'replace'});select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await settle();
    const picker=view.host.querySelector<HTMLInputElement>('input[type="file"]')!;const choose=async(file:any)=>{Object.defineProperty(picker,'files',{configurable:true,value:[file]});picker.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await settle()};
    await choose({size:2*1024*1024+1,text:vi.fn()});expect(view.host.textContent).toContain('2 MB');
    await choose({size:10,text:async()=>{throw new Error('file read failed')}});expect(view.host.textContent).toContain('无法读取文件');
    const replacement={version:1,rules:[{id:'replacement-rule',name:'Imported replacement',match:{hosts:['imported.example']},content:[{css:['main p']}]}]};await choose({size:100,text:async()=>JSON.stringify(replacement)});expect(view.host.textContent).toContain('已导入草稿');expect(view.host.querySelector<HTMLTextAreaElement>('[aria-label="JSON 编辑草稿"]')!.value).not.toContain(SITE_ADAPTATION_EXAMPLE.rules[0].id);
    await textClick(view.host,'导出草稿');await textClick(view.host,'导出已保存规则');await textClick(view.host,'导出内置规则');expect(URL.createObjectURL).toHaveBeenCalledTimes(3);await vi.advanceTimersByTimeAsync(1000);expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
    await textClick(view.host,'保存并应用');expect(view.state.modelValue.custom.rules.map(rule=>rule.id)).toEqual(['replacement-rule']);
  }finally{vi.useRealTimers()}
});


it('navigates the catalog and incoming rule inspection without discarding a dirty editor or reusing built-in identifiers',async()=>{
  const view=await site();const first=view.host.querySelector<HTMLElement>('[data-adaptation-rule]')!.dataset.adaptationRule!;
  expect(view.host.querySelectorAll('[data-adaptation-rule]')).toHaveLength(30);await click(view.host,'.catalog-more');expect(view.host.querySelectorAll('[data-adaptation-rule]')).toHaveLength(60);
  const filter=[...view.host.querySelectorAll<HTMLButtonElement>('.catalog-filters button')].find(node=>node.textContent!.startsWith('自定义'))!;filter.click();await settle();expect(view.host.querySelectorAll('[data-adaptation-rule]')).toHaveLength(0);
  view.state.inspectRuleId=first;await settle();expect(view.host.querySelector('[data-rule-detail]')).not.toBeNull();expect(view.host.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe(first);
  await textClick(view.host,'新建规则');await input(view.host,'[aria-label="规则标识"]',first);await input(view.host,'[aria-label="匹配域名"]','example.test');view.host.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await settle();expect(view.save).not.toHaveBeenCalled();expect(view.host.textContent).toContain('该标识属于内置规则');
  (dom.window.confirm as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);view.state.inspectRuleId='different-request';await settle();expect(view.host.querySelector('form')).not.toBeNull();
  view.state.inspectRuleId=first;await settle();expect(view.host.querySelector('form')).toBeNull();expect(view.host.querySelector('[data-rule-detail]')).not.toBeNull();expect(view.save).not.toHaveBeenCalled();
  const picker=view.host.querySelector<HTMLInputElement>('input[type="file"]')!;const open=vi.spyOn(picker,'click');await textClick(view.host,'导入 JSON');expect(open).toHaveBeenCalledOnce();
  const editor=view.host.querySelector<HTMLDetailsElement>('.json-editor')!;Object.defineProperty(editor,'open',{configurable:true,get:()=>editor.hasAttribute('open'),set:(value:boolean)=>{if(value)editor.setAttribute('open','');else editor.removeAttribute('open')}});editor.open=true;editor.dispatchEvent(new dom.window.Event('toggle'));await settle();expect(editor.hasAttribute('open')).toBe(true);editor.open=false;editor.dispatchEvent(new dom.window.Event('toggle'));await settle();expect(editor.hasAttribute('open')).toBe(false);
});
