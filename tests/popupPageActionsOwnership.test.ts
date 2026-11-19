/**
 * @file tests/popupPageActionsOwnership.test.ts
 * 文件职责：验证 Popup 页面状态与异步操作归属，防止旧读取、旧页面或旧任务覆盖新状态。
 * 主要内容：以真实页面控制器和受控浏览器端口覆盖翻译/恢复、导航、重复局部请求、失活、配置失效与站点规则。
 * 模块边界：不挂载 Popup 或连接供应商；组件实际生命周期另由组件和生产浏览器验证。
 */
import {afterEach, describe, expect, it, vi} from 'vitest'
import {Config} from '@/src/core/config/model'
import {createPopupPageActions, type PopupActiveTab, type PopupPageState} from '@/src/app/popup/pageActions'

function deferred<T=unknown>() {let resolve!: (value:T)=>void,reject!: (error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
async function settle() {for(let i=0;i<10;i++)await Promise.resolve()}
function setup(pdfEnabled = true) {
  const cfg=new Config();cfg.on=true;cfg.autoTranslate=false;cfg.alwaysTranslateDomains=[];cfg.disabledExtensionDomains=[]
  const state:PopupPageState={tabId:7,url:'https://example.com/a',domain:'example.com',translated:false,busy:false,savingRule:false}
  let active=true,warning='',thunderbird=false
  const getTab=vi.fn(async():Promise<PopupActiveTab|undefined>=>({id:7,url:'https://example.com/a'})),send=vi.fn(async(_id:number,_message:{type:string;action?:string}):Promise<unknown>=>({status:'success',isTranslated:true})),notice=vi.fn(),close=vi.fn()
  const openPdf=vi.fn(async(_sourceUrl:string):Promise<unknown>=>undefined),persistRule=vi.fn(async():Promise<void>=>undefined),failure=vi.fn(),status=vi.fn()
  const actions=createPopupPageActions({state,config:()=>cfg,active:()=>active,warning:()=>warning,getTab,send,persistRule,openPdf:pdfEnabled?openPdf:undefined,notice,close,translate:key=>key,onFailure:failure,onStatus:status,get thunderbird(){return thunderbird}})
  return {cfg,state,getTab,send,openPdf,persistRule,notice,close,actions,failure,status,setActive:(value:boolean)=>{active=value},setWarning:(value:string)=>{warning=value},setThunderbird:()=>{thunderbird=true}}
}
afterEach(()=>vi.restoreAllMocks())
describe('Popup 来源关闭诊断与读取归属',()=>{
  it.each([undefined,{id:-1}])('当前来源不存在 %j 时立即解释，不发送或转移操作',async tab=>{
    const f=setup();f.getTab.mockResolvedValueOnce(tab);await f.actions.hydrate()
    expect(f.failure).toHaveBeenCalledWith(expect.objectContaining({code:'source-closed',actions:['dismiss']}))
    expect(f.state).toMatchObject({tabId:null,url:'',translated:false});expect(f.send).not.toHaveBeenCalled()
  })
  it.each([['No tab with id: 7.','source-closed'],['No active tab','source-closed'],['temporary tabs lookup failure','unknown'],['Could not establish connection. Receiving end does not exist.','page-unavailable']])('当前读取失败 %s 保持准确分类 %s',async(message,code)=>{
    vi.spyOn(console,'warn').mockImplementation(()=>{});const f=setup();f.getTab.mockRejectedValueOnce(Error(message));await f.actions.hydrate()
    expect(f.failure).toHaveBeenCalledWith(expect.objectContaining({code}));expect(f.send).not.toHaveBeenCalled()
  })
  it.each(['absent','closed','other-error'] as const)('旧读取 %s 晚于新查询时不覆盖新页面',async outcome=>{
    vi.spyOn(console,'warn').mockImplementation(()=>{});const f=setup(),old=deferred<PopupActiveTab|undefined>();f.getTab.mockReturnValueOnce(old.promise);const pending=f.actions.hydrate()
    f.getTab.mockResolvedValueOnce({id:8,url:'https://new.example/'});await f.actions.hydrate()
    if(outcome==='absent')old.resolve(undefined);else old.reject(Error(outcome==='closed'?'No tab with id: 7.':'temporary lookup failure'))
    await pending;expect(f.failure).not.toHaveBeenCalled();expect(f.state.tabId).toBe(8);expect(f.state.translated).toBe(true)
  })
  it.each(['absent','closed','valid'] as const)('旧来源读取 %s 不覆盖其间确认的新命令',async outcome=>{
    const f=setup(),old=deferred<PopupActiveTab|undefined>();f.getTab.mockReturnValueOnce(old.promise);const pending=f.actions.hydrate();await f.actions.toggle()
    if(outcome==='closed')old.reject(Error('No tab with id: 7.'));else old.resolve(outcome==='absent'?undefined:{id:8,url:'https://obsolete.example/'})
    await pending;expect(f.failure).not.toHaveBeenCalled();expect(f.state.tabId).toBe(7);expect(f.state.translated).toBe(true);expect(f.send).toHaveBeenCalledOnce()
  })
  it.each(['absent','closed'] as const)('Popup 退出后晚到的 %s 不产生恢复提示',async outcome=>{
    const f=setup(),old=deferred<PopupActiveTab|undefined>();f.getTab.mockReturnValueOnce(old.promise);const pending=f.actions.hydrate();f.setActive(false)
    if(outcome==='absent')old.resolve(undefined);else old.reject(Error('No tab with id: 7.'));await pending;expect(f.failure).not.toHaveBeenCalled()
  })
  it.each([undefined,'No tab with id: 7.','No active tab','temporary tabs lookup failure'] as const)('翻译时来源读取失败 %s 不把空URL误诊成内部页',async message=>{
    const f=setup();f.state.tabId=null;f.state.url='';if(message)f.getTab.mockRejectedValueOnce(Error(message));else f.getTab.mockResolvedValueOnce(undefined)
    await f.actions.toggle();expect(f.failure).toHaveBeenCalledWith(expect.objectContaining({code:message==='temporary tabs lookup failure'?'unknown':'source-closed'}))
    expect(f.send).not.toHaveBeenCalled();expect(f.state.busy).toBe(false)
  })
  it('空URL内容接收端缺失仍是可刷新页面组件故障，已知内部页才是限制页面',async()=>{
    for(const [url,message,code] of [['','Could not establish connection. Receiving end does not exist.','page-unavailable'],['chrome://extensions','access denied','unsupported-page'],['chrome://extensions','No tab with id: 7.','source-closed']]){
      const f=setup();f.state.url=url;f.getTab.mockResolvedValueOnce({id:7,url});f.send.mockRejectedValueOnce(Error(message));await f.actions.toggle()
      expect(f.failure).toHaveBeenCalledWith(expect.objectContaining({code}));expect(f.state.busy).toBe(false)
    }
  })
  it('来源读取失败时不借用旧内部页URL归因，也不发送给另一个标签页',async()=>{
    const f=setup();f.state.url='chrome://extensions';f.getTab.mockRejectedValueOnce(Error('temporary lookup failure'));await f.actions.toggle()
    expect(f.failure).toHaveBeenCalledWith(expect.objectContaining({code:'unknown'}));expect(f.send).not.toHaveBeenCalled()
  })
})
describe('Popup 页面状态与操作所有权',()=>{
  it.each(['setDisabled','setAlways'] as const)('does not show a stale %s failure after the popup closes during a tab read',async action=>{
    const f=setup(),tab=deferred<PopupActiveTab>();f.getTab.mockReturnValueOnce(tab.promise);
    const saving=f.actions[action](true);f.setActive(false);tab.reject(new Error('closed popup tab read'));await saving;
    expect(f.notice).not.toHaveBeenCalled();expect(f.persistRule).not.toHaveBeenCalled();expect(f.state.savingRule).toBe(false);
  })
  it('启动状态晚到不能覆盖刚完成的翻译；失败的旧状态也不能回退新结果',async()=>{
    for(const rejected of [false,true]){const {state,actions,send}=setup(),old=deferred();send.mockImplementationOnce(()=>old.promise);const hydrate=actions.hydrate();await settle();await actions.toggle();expect(state.translated).toBe(true);if(rejected)old.reject(Error('old receiver'));else old.resolve({isTranslated:false});await hydrate;expect(state.translated).toBe(true);expect(state.busy).toBe(false)}
  })
  it('较晚查询不能覆盖新查询，失效的查询不安装站点身份或启动消息',async()=>{
    const {state,getTab,actions,send}=setup(),old=deferred<PopupActiveTab>();getTab.mockReturnValueOnce(old.promise);const first=actions.hydrate();getTab.mockResolvedValueOnce({id:0,pendingUrl:'https://sub.example.net/b'});send.mockResolvedValueOnce({isTranslated:true});await actions.hydrate();old.resolve({id:8,url:'https://old.example.org/a'});await first;expect(state).toMatchObject({tabId:0,domain:'example.net',translated:true});expect(send).toHaveBeenCalledTimes(1)
  })
  it.each([undefined,{id:-1},{id:1.5},{id:Infinity}])('无效启动标签页 %j 不发送状态请求',async tab=>{
    const {getTab,actions,send,state}=setup();getTab.mockResolvedValueOnce(tab);await actions.hydrate();expect(send).not.toHaveBeenCalled();expect(state).toMatchObject({tabId:null,domain:'',translated:false})
  })
  it('状态只接受真正布尔值，空 URL 或未安装内容脚本仍保留合法 tab ID',async()=>{
    const {getTab,actions,send,state}=setup();getTab.mockResolvedValueOnce({id:0});send.mockResolvedValueOnce({isTranslated:1});await actions.hydrate();expect(state).toMatchObject({tabId:0,url:'',domain:'',translated:false});getTab.mockResolvedValueOnce({id:0});send.mockRejectedValueOnce(Error('no receiver'));await actions.hydrate();expect(state.tabId).toBe(0);send.mockResolvedValueOnce(undefined);await actions.hydrate();expect(state.translated).toBe(false)
  })
  it('当前查询失败记录诊断；旧查询失败或失活查询不产生诊断',async()=>{
    const {actions,getTab,setActive,send}=setup(),warn=vi.spyOn(console,'warn').mockImplementation(()=>{});getTab.mockRejectedValueOnce(Error('query failed'));await actions.hydrate();expect(warn).toHaveBeenCalledOnce();const old=deferred<PopupActiveTab>();getTab.mockReturnValueOnce(old.promise);const pending=actions.hydrate();actions.invalidate();old.reject(Error('old failure'));await pending;expect(warn).toHaveBeenCalledOnce();setActive(false);await actions.hydrate();expect(send).not.toHaveBeenCalled();expect(getTab).toHaveBeenCalledTimes(2)
  })
  it('失效的状态回复不写入界面',async()=>{
    const {actions,send,state,setActive}=setup(),old=deferred();send.mockReturnValueOnce(old.promise);const pending=actions.hydrate();await settle();setActive(false);old.resolve({isTranslated:true});await pending;expect(state.translated).toBe(false)
  })
  it('翻译、恢复、再翻译使用对应消息，明确回复与缺省回复保持原协议',async()=>{
    const {actions,send,state}=setup();send.mockImplementation(async(_id,message)=>({status:'success',isTranslated:message.action==='fullPage'}));await actions.toggle();await actions.toggle();await actions.toggle();expect(send.mock.calls.map(call=>call[1].action)).toEqual(['fullPage','restore','fullPage']);send.mockResolvedValueOnce({status:'success'});await actions.toggle();expect(state.translated).toBe(false);send.mockResolvedValueOnce({status:'success'});await actions.toggle();expect(state.translated).toBe(true)
  })
  it.each(['inactive','busy','off','disabled'])('%s 时全文和局部操作不查询、不发送、不关闭',async reason=>{
    const {actions,cfg,state,getTab,send,close,setActive}=setup();if(reason==='inactive')setActive(false);if(reason==='busy')state.busy=true;if(reason==='off')cfg.on=false;if(reason==='disabled')cfg.disabledExtensionDomains=['example.com'];await actions.toggle();await actions.section();expect(getTab).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled()
  })
  it('凭据提醒阻止新翻译和局部；恢复原文不受新凭据缺失影响',async()=>{
    const {actions,notice,setWarning,send,state}=setup();setWarning('missing key');await actions.toggle();await actions.section();expect(notice).toHaveBeenCalledTimes(2);expect(send).not.toHaveBeenCalled();state.translated=true;await actions.toggle();expect(send).toHaveBeenLastCalledWith(7,{type:'contextMenuTranslate',action:'restore'})
  })
  it('等待标签页时立即独占操作，连续局部触发只发一次命令、只关闭一次',async()=>{
    const {actions,getTab,state,send,close}=setup(),pending=deferred<PopupActiveTab>();getTab.mockReturnValueOnce(pending.promise);const first=actions.section();expect(state.busy).toBe(true);await actions.section();await actions.toggle();expect(getTab).toHaveBeenCalledTimes(1);pending.resolve({id:7,url:state.url});await first;expect(send).toHaveBeenCalledTimes(1);expect(close).toHaveBeenCalledOnce();expect(state.busy).toBe(false)
  })
  it('关闭或配置失效后晚查询不再发送翻译；旧完成不能释放新操作',async()=>{
    const {actions,getTab,send,state,close}=setup(),query=deferred<PopupActiveTab>();getTab.mockReturnValueOnce(query.promise);const cancelled=actions.section();actions.invalidate();query.resolve({id:7,url:state.url});await cancelled;expect(send).not.toHaveBeenCalled();const first=deferred(),second=deferred();send.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);const old=actions.toggle();await settle();actions.invalidate();const fresh=actions.section();await settle();first.resolve({status:'success',isTranslated:true});await old;expect(state.busy).toBe(true);expect(state.translated).toBe(false);second.resolve({status:'success'});await fresh;expect(close).toHaveBeenCalledOnce();expect(state.busy).toBe(false)
  })
  it('页面切换先读取新真值，不把旧恢复操作交给另一个标签页或同 ID 新 URL',async()=>{
    for(const tab of [{id:8,url:'https://example.net/b'},{id:7,pendingUrl:'https://example.org/new'}]){const {actions,state,getTab,send}=setup();state.translated=true;getTab.mockResolvedValue(tab);send.mockResolvedValue({isTranslated:false});await actions.toggle();expect(send.mock.calls.map(call=>call[1].type)).toEqual(['getFullPageTranslationState']);expect(state.tabId).toBe(tab.id);expect(state.translated).toBe(false);expect(state.busy).toBe(false)}
  })
  it('还未读取首屏标签页时可绑定实际页面，tab 0 合法',async()=>{
    const {actions,state,getTab,send}=setup();state.tabId=null;getTab.mockResolvedValueOnce({id:0,url:'https://example.com/a'});await actions.toggle();expect(send).toHaveBeenCalledWith(0,{type:'contextMenuTranslate',action:'fullPage'});expect(state.tabId).toBe(0)
  })
  it('无 URL 的同标签页仍可恢复；规则同步回调使页面失活时不启动翻译',async()=>{
    const {actions,state,getTab,send,cfg,setActive}=setup();state.url='';getTab.mockResolvedValueOnce({id:7});await actions.toggle();expect(send).toHaveBeenCalledOnce();send.mockClear();state.domain='example.com';state.url='https://example.com/a';const leave=vi.fn(()=>setActive(false));Object.defineProperty(cfg,'alwaysTranslateDomains',{get:()=>[],set:leave});await actions.setAlways(true);expect(leave).toHaveBeenCalledOnce();expect(send).not.toHaveBeenCalled()
  })
  it.each(['invalid-tab','query-error','message-error','empty','failed'])('%s 拒绝成功状态并释放执行锁；局部失败保持窗口',async failure=>{
    const {actions,getTab,send,state,close,notice,setThunderbird}=setup();setThunderbird();const configure=()=>{if(failure==='invalid-tab')getTab.mockResolvedValueOnce(undefined);if(failure==='query-error')getTab.mockRejectedValueOnce(Error('query'));if(failure==='message-error')send.mockRejectedValueOnce(Error('receiver'));if(failure==='empty')send.mockResolvedValueOnce(undefined);if(failure==='failed')send.mockResolvedValueOnce({status:'disabled'})};configure();await actions.toggle();expect(state.translated).toBe(false);expect(state.busy).toBe(false);expect(notice).toHaveBeenLastCalledWith('请先打开一封邮件，然后重试翻译','error');configure();await actions.section();expect(close).not.toHaveBeenCalled();expect(notice).toHaveBeenLastCalledWith('popup.sectionTranslationUnavailable','error')
  })
  it('已经发送的旧成功或失败回复在失活后不关闭、不提示、不写状态',async()=>{
    for(const rejected of [false,true]){const {actions,send,setActive,notice,close,state}=setup(),old=deferred();send.mockReturnValueOnce(old.promise);const pending=actions.section();await settle();setActive(false);actions.invalidate();if(rejected)old.reject(Error('old'));else old.resolve({status:'success'});await pending;expect(close).not.toHaveBeenCalled();expect(notice).not.toHaveBeenCalled();expect(state.busy).toBe(false)}
  })
})
describe('Popup 原生在线 PDF 阅读入口',()=>{
  function bindPdf(value = 'https://arxiv.org/pdf/1706.03762') {
    const fixture=setup();fixture.state.url=value;fixture.state.domain='arxiv.org';fixture.getTab.mockResolvedValue({id:7,url:value});return fixture
  }
  it('读取 PDF 标签页只绑定身份，不发送无法注入查看器的状态请求',async()=>{
    const {actions,state,send,openPdf}=bindPdf();state.translated=true;await actions.hydrate();expect(state).toMatchObject({tabId:7,url:'https://arxiv.org/pdf/1706.03762',domain:'arxiv.org',translated:false});expect(send).not.toHaveBeenCalled();expect(openPdf).not.toHaveBeenCalled()
  })
  it('全文和局部入口打开同一 PDF 原文阅读器；缺翻译凭据不妨碍打开阅读',async()=>{
    const {actions,state,send,openPdf,notice,close,setWarning}=bindPdf();setWarning('missing key');await actions.toggle();await actions.section();expect(openPdf.mock.calls).toEqual([[state.url],[state.url]]);expect(send).not.toHaveBeenCalled();expect(notice).not.toHaveBeenCalled();expect(close).toHaveBeenCalledTimes(2);expect(state.translated).toBe(false);expect(state.busy).toBe(false)
  })
  it('首屏身份尚未读回也先验证实际 PDF 标签页，再绕过凭据提醒',async()=>{
    const {actions,state,getTab,send,openPdf,setWarning}=setup();state.tabId=null;state.url='';setWarning('missing key');getTab.mockResolvedValue({id:0,url:'https://example.com/book.pdf?download=1'});await actions.toggle();expect(openPdf).toHaveBeenCalledWith('https://example.com/book.pdf?download=1');expect(send).not.toHaveBeenCalled();expect(state.tabId).toBe(0)
  })
  it('失活或配置失效后晚标签页查询不再打开阅读器',async()=>{
    const {actions,getTab,openPdf,close}=bindPdf(),query=deferred<PopupActiveTab>();getTab.mockReturnValueOnce(query.promise);const pending=actions.toggle();actions.invalidate();query.resolve({id:7,url:'https://arxiv.org/pdf/1706.03762'});await pending;expect(openPdf).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled()
  })
  it('导航到另一份 PDF 先刷新身份，旧操作不打开新文档',async()=>{
    const {actions,state,getTab,openPdf,send}=bindPdf();getTab.mockResolvedValue({id:7,pendingUrl:'https://example.net/new.pdf'});await actions.toggle();expect(openPdf).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();expect(state.url).toBe('https://example.net/new.pdf');expect(state.busy).toBe(false);await actions.toggle();expect(openPdf).toHaveBeenCalledWith('https://example.net/new.pdf')
  })
  it('迟到的 PDF 创建不能关闭已失效的 Popup 或释放新操作',async()=>{
    const {actions,state,openPdf,close}=bindPdf(),first=deferred(),second=deferred();openPdf.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);const old=actions.toggle();await settle();actions.invalidate();const fresh=actions.section();await settle();first.resolve({});await old;expect(close).not.toHaveBeenCalled();expect(state.busy).toBe(true);second.resolve({});await fresh;expect(close).toHaveBeenCalledOnce();expect(state.busy).toBe(false);expect(state.translated).toBe(false)
  })
  it('创建失败释放操作锁并可重试，原 PDF 不会被标记为已翻译',async()=>{
    const {actions,state,openPdf,notice,close}=bindPdf();openPdf.mockRejectedValueOnce(Error('create failed'));await actions.toggle();expect(notice).toHaveBeenLastCalledWith('当前页面暂不支持翻译，请刷新后重试','error');expect(state).toMatchObject({busy:false,translated:false});expect(close).not.toHaveBeenCalled();await actions.toggle();expect(close).toHaveBeenCalledOnce();expect(openPdf).toHaveBeenCalledTimes(2)
  })
  it('没有 PDF 阅读端口的适配器继续使用原翻译协议',async()=>{
    const {actions,state,getTab,send,openPdf}=setup(false);state.url='https://example.com/book.pdf';getTab.mockResolvedValue({id:7,url:state.url});await actions.hydrate();await actions.toggle();expect(send.mock.calls.map(call=>call[1].type)).toEqual(['getFullPageTranslationState','contextMenuTranslate']);expect(openPdf).not.toHaveBeenCalled()
  })
})
describe('Popup 站点规则与即时翻译',()=>{
  it.each(['always','disabled'] as const)('%s 写前复验当前标签页，未收到导航事件也不能误改旧网站',async kind=>{
    for(const tab of [{id:8,url:'https://example.net/b'},{id:7,pendingUrl:'https://example.net/new'}]) {
      const {actions,cfg,getTab,state,persistRule,send}=setup();getTab.mockResolvedValue(tab)
      await (kind==='always'?actions.setAlways(true):actions.setDisabled(true))
      expect(cfg.alwaysTranslateDomains).toEqual([]);expect(cfg.disabledExtensionDomains).toEqual([]);expect(persistRule).not.toHaveBeenCalled()
      expect(send.mock.calls.map(call=>call[1].type)).toEqual(['getFullPageTranslationState']);expect(state.domain).toBe('example.net');expect(state.savingRule).toBe(false)
    }
  })
  it.each(['always','disabled'] as const)('%s 查询失败或失活不保存规则，当前查询失败有真实反馈',async kind=>{
    const {actions,getTab,persistRule,notice,cfg,setActive}=setup(),run=()=>kind==='always'?actions.setAlways(true):actions.setDisabled(true)
    getTab.mockRejectedValueOnce(Error('query'));await run();expect(notice).toHaveBeenLastCalledWith('无法读取当前网站，请重试','error');expect(persistRule).not.toHaveBeenCalled()
    notice.mockClear();const query=deferred<PopupActiveTab>();getTab.mockReturnValueOnce(query.promise);const pending=run();setActive(false);query.resolve({id:7,url:'https://example.com/a'});await pending
    expect(notice).not.toHaveBeenCalled();expect(persistRule).not.toHaveBeenCalled();expect(cfg.alwaysTranslateDomains).toEqual([]);expect(cfg.disabledExtensionDomains).toEqual([])
  })
  it('规则保存期间独占按钮并等待后台确认；确认前不启动即时翻译或声称成功',async()=>{
    const {actions,persistRule,state,send,notice,getTab,close}=setup(),commit=deferred<void>();persistRule.mockReturnValueOnce(commit.promise)
    const pending=actions.setAlways(true);await settle();expect(state.savingRule).toBe(true);expect(persistRule).toHaveBeenCalledWith({alwaysTranslateDomains:['example.com']});expect(send).not.toHaveBeenCalled();expect(notice).not.toHaveBeenCalled()
    await actions.setAlways(false);await actions.setDisabled(true);await actions.toggle();await actions.section();expect(getTab).toHaveBeenCalledOnce();expect(send).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();commit.resolve();await pending
    expect(state.savingRule).toBe(false);expect(send).toHaveBeenCalledOnce();expect(notice).toHaveBeenLastCalledWith('已开启 example.com 的始终翻译')
  })
  it('验证实际页面期间配置失效不能继续修改规则',async()=>{
    const {actions,getTab,state,persistRule,cfg}=setup(),query=deferred<PopupActiveTab>();getTab.mockReturnValueOnce(query.promise);const pending=actions.setAlways(true);actions.invalidate();query.resolve({id:7,url:'https://example.com/a'});await pending
    expect(persistRule).not.toHaveBeenCalled();expect(cfg.alwaysTranslateDomains).toEqual([]);expect(state.savingRule).toBe(false)
  })
  it.each(['always','disabled'] as const)('%s 保存失败释放规则锁，不发送翻译或显示成功；离开后旧失败不提示',async kind=>{
    const {actions,persistRule,state,notice,send,setActive}=setup(),run=()=>kind==='always'?actions.setAlways(true):actions.setDisabled(true)
    persistRule.mockRejectedValueOnce(Error('storage unavailable'));await run();expect(state.savingRule).toBe(false);expect(send).not.toHaveBeenCalled();expect(notice).toHaveBeenLastCalledWith('未能保存 example.com 的网站设置，请重试','error')
    notice.mockClear();const commit=deferred<void>();persistRule.mockReturnValueOnce(commit.promise);const pending=run();await settle();setActive(false);commit.reject(Error('old failure'));await pending;expect(notice).not.toHaveBeenCalled();expect(state.savingRule).toBe(false)
  })
  it('导航后旧规则确认不提示、不翻译，也不能释放新网站的保存锁',async()=>{
    const {actions,persistRule,state,getTab,send,notice}=setup(),first=deferred<void>(),second=deferred<void>();persistRule.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const old=actions.setAlways(true);await settle();getTab.mockResolvedValue({id:7,url:'https://example.net/b'});await actions.hydrate();send.mockClear();const fresh=actions.setDisabled(true);await settle()
    first.resolve();await old;expect(state.savingRule).toBe(true);expect(send).not.toHaveBeenCalled();expect(notice).not.toHaveBeenCalled();second.resolve();await fresh
    expect(state.savingRule).toBe(false);expect(notice).toHaveBeenLastCalledWith('已在 example.net 禁用扩展')
  })
  it('失活再激活释放保存锁，旧确认不能占用新会话或显示旧成功',async()=>{
    const {actions,persistRule,state,notice,setActive}=setup(),first=deferred<void>(),second=deferred<void>();persistRule.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const old=actions.setAlways(true);await settle();setActive(false);actions.invalidate();expect(state.savingRule).toBe(false);setActive(true);const fresh=actions.setDisabled(true);await settle()
    first.resolve();await old;expect(state.savingRule).toBe(true);expect(notice).not.toHaveBeenCalled();second.resolve();await fresh;expect(state.savingRule).toBe(false);expect(notice).toHaveBeenLastCalledWith('已在 example.com 禁用扩展')
  })
  it('等待保存期间规则被外部撤销不显示旧成功；禁用优先且保留始终翻译偏好',async()=>{
    const {actions,persistRule,state,notice,send,cfg}=setup(),commit=deferred<void>();persistRule.mockReturnValueOnce(commit.promise);const pending=actions.setAlways(true);await settle();cfg.alwaysTranslateDomains=[];commit.resolve();await pending
    expect(notice).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();expect(state.savingRule).toBe(false)
    cfg.alwaysTranslateDomains=['example.com'];await actions.setDisabled(true);expect(cfg.alwaysTranslateDomains).toEqual(['example.com']);expect(state.translated).toBe(false);expect(persistRule).toHaveBeenLastCalledWith({disabledExtensionDomains:['example.com']})
  })
  it('规则启停只修改本站，保留其它网站；旧保存回复不借用外部替换的页面身份',async()=>{
    const {actions,cfg}=setup();cfg.alwaysTranslateDomains=['example.net'];cfg.disabledExtensionDomains=['example.org'];await actions.setAlways(true);await actions.setAlways(false);await actions.setDisabled(true);await actions.setDisabled(false)
    expect(cfg.alwaysTranslateDomains).toEqual(['example.net']);expect(cfg.disabledExtensionDomains).toEqual(['example.org'])
    for(const identity of [{tabId:8},{url:'https://example.com/b'},{domain:'example.net'}]) {
      const fixture=setup(),commit=deferred<void>();fixture.persistRule.mockReturnValueOnce(commit.promise);const pending=fixture.actions.setDisabled(true);await settle();Object.assign(fixture.state,identity);commit.resolve();await pending
      expect(fixture.notice).not.toHaveBeenCalled();expect(fixture.state.savingRule).toBe(false)
    }
  })
  it('保存期间禁用本站后不执行即时翻译；规则重复启用不会重发已完成的全文翻译',async()=>{
    const {actions,persistRule,state,notice,send,cfg}=setup(),commit=deferred<void>();persistRule.mockReturnValueOnce(commit.promise);const pending=actions.setAlways(true);await settle();cfg.disabledExtensionDomains=['example.com'];commit.resolve();await pending
    expect(notice).toHaveBeenLastCalledWith('已保存 example.com，恢复扩展后生效');expect(send).not.toHaveBeenCalled();cfg.disabledExtensionDomains=[];state.translated=true;await actions.setAlways(true);expect(send).not.toHaveBeenCalled();expect(notice).toHaveBeenLastCalledWith('已开启 example.com 的始终翻译')
  })
  it('启用、重复启用、停用规则不产生重复域名；停用不执行恢复',async()=>{
    const {actions,cfg,send,state,notice}=setup();await actions.setAlways(true);await actions.setAlways(true);expect(cfg.alwaysTranslateDomains).toEqual(['example.com']);expect(state.translated).toBe(true);send.mockClear();await actions.setAlways(false);expect(cfg.alwaysTranslateDomains).toEqual([]);expect(send).not.toHaveBeenCalled();expect(notice).toHaveBeenLastCalledWith('已关闭 example.com 的始终翻译，当前网页保持不变')
  })
  it('旧协议缺省/明确 false 状态与当前发送失败分别展示保存结果',async()=>{
    const {actions,send,state,notice}=setup();send.mockResolvedValueOnce({status:'success'});await actions.setAlways(true);expect(state.translated).toBe(true);state.translated=false;send.mockResolvedValueOnce({status:'success',isTranslated:false});await actions.setAlways(true);expect(state.translated).toBe(false);send.mockRejectedValueOnce(Error('no receiver'));await actions.setAlways(true);expect(notice).toHaveBeenLastCalledWith('已保存 example.com，当前网页请刷新后重试','error')
  })
  it.each(['inactive','busy','no-domain','no-tab','invalid'])('%s 时站点规则操作不修改配置或启动翻译',async reason=>{
    const {actions,cfg,state,send,setActive}=setup();if(reason==='inactive')setActive(false);if(reason==='busy')state.busy=true;if(reason==='no-domain')state.domain='';if(reason==='no-tab')state.tabId=null;await actions.setAlways(reason==='invalid'?'true' as never:true);if(reason!=='busy')await actions.setDisabled(reason==='invalid'?'true' as never:true);expect(cfg.alwaysTranslateDomains).toEqual([]);expect(cfg.disabledExtensionDomains).toEqual([]);expect(send).not.toHaveBeenCalled()
  })
  it('全局自动翻译和站点禁用不接受启用规则；插件关闭或缺凭据时保存而不执行',async()=>{
    const {actions,cfg,send,notice,setWarning}=setup();cfg.autoTranslate=true;await actions.setAlways(true);expect(notice).toHaveBeenLastCalledWith('所有网站自动翻译已开启，请在完整设置中关闭全局开关');cfg.autoTranslate=false;cfg.disabledExtensionDomains=['example.com'];await actions.setAlways(true);expect(notice).toHaveBeenLastCalledWith('当前已在 example.com 禁用扩展，请先恢复扩展');cfg.disabledExtensionDomains=[];cfg.on=false;await actions.setAlways(true);expect(notice).toHaveBeenLastCalledWith('已保存 example.com，启动插件后生效');cfg.on=true;setWarning('key');await actions.setAlways(true);expect(notice).toHaveBeenLastCalledWith('已保存 example.com；key','error');expect(send).not.toHaveBeenCalled()
  })
  it('站点禁用后旧任务不能重新标记成功，启停只修改本站且不发覆盖命令',async()=>{
    const {actions,cfg,state,send}=setup(),pending=deferred();send.mockReturnValueOnce(pending.promise);const old=actions.toggle();await settle();await actions.setDisabled(true);await actions.setDisabled(true);expect(cfg.disabledExtensionDomains).toEqual(['example.com']);expect(state.busy).toBe(false);expect(state.translated).toBe(false);pending.resolve({status:'success',isTranslated:true});await old;expect(state.translated).toBe(false);await actions.setDisabled(false);expect(cfg.disabledExtensionDomains).toEqual([]);expect(send).toHaveBeenCalledTimes(1)
  })
  it('外部移除规则后旧即时翻译回复不声称规则已经开启',async()=>{
    const {actions,cfg,state,send,notice}=setup(),pending=deferred();send.mockReturnValueOnce(pending.promise);const old=actions.setAlways(true);await settle();cfg.alwaysTranslateDomains=[];pending.resolve({status:'success',isTranslated:true});await old;expect(state.translated).toBe(false);expect(notice).not.toHaveBeenCalled()
  })
})

it('restores an already translated page before retry and drops a PDF-open completion after the popup loses ownership',async()=>{
  const f=setup();f.state.translated=true;f.send.mockResolvedValueOnce({status:'success',isTranslated:false}).mockResolvedValueOnce({status:'success',isTranslated:true});await f.actions.retry();expect(f.send.mock.calls.map(call=>call[1].action)).toEqual(['restore','fullPage']);
  const pending=deferred();f.openPdf.mockReturnValueOnce(pending.promise);f.state.url='https://paper.example/a.pdf';f.getTab.mockResolvedValueOnce({id:7,url:f.state.url});const opening=f.actions.toggle();await settle();expect(f.openPdf).toHaveBeenCalledWith(f.state.url);f.actions.invalidate();pending.resolve(undefined);await opening;expect(f.close).not.toHaveBeenCalled();
})

it('retries an untranslated page directly without an unnecessary restore',async()=>{
  const f=setup();await f.actions.retry();expect(f.send).toHaveBeenCalledWith(7,{type:'contextMenuTranslate',action:'fullPage'});expect(f.send).toHaveBeenCalledOnce();
})
